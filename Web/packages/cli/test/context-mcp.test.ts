//
//  context-mcp.test.ts — the AI context plane (master plan P16): the context bundle as
//  MCP resources on /edit/mcp, and the OpenRouter local-PKCE custody rules. The fixture
//  agent round trip is the program's own gate: an agent READS the bundle for a screen,
//  derives an edit from what it saw, and lands it through the audited edit door - the
//  file then matches the instruction.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { startEditServer as bootEditServer } from "../src/edit.ts";
import { STATE_PATH } from "../src/dev.ts";

//  THE ADMISSION CREDENTIAL (edit.ts). Every request under /edit carries this run's secret, so
//  these tests drive the door a browser drives: `startEditServer` is wrapped to remember what
//  the run minted, and `fetch` is shadowed to present it. A test that means to prove the
//  REFUSAL calls `bareFetch` on purpose — there is exactly one place that should, and it says
//  so where it does it.
const bareFetch = globalThis.fetch;
let admission = "";
async function startEditServer(...args: Parameters<typeof bootEditServer>): ReturnType<typeof bootEditServer> {
  const server = await bootEditServer(...args);
  admission = server.admission;
  return server;
}
function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (admission !== "" && !headers.has("x-despia-edit")) headers.set("x-despia-edit", admission);
  return bareFetch(input as string, { ...init, headers });
}


const APP = `<stack>
  <head>
    <variable as="greeting" sample="&quot;Hello from the sample plane&quot;">return ''</variable>
  </head>
  <text value="Body copy"/>
  <button label="Go"/>
</stack>
`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-context-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

async function rpc(base: string, method: string, params?: object): Promise<{ result?: { [k: string]: unknown }; error?: { code: number } }> {
  const res = await fetch(`${base}/edit/mcp`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) }),
  });
  return (await res.json()) as { result?: { [k: string]: unknown }; error?: { code: number } };
}

test("P16: the context bundle rides /edit/mcp, and an agent edits the screen it saw", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // the door declares the resource face
    const init = await rpc(base, "initialize", { clientInfo: { name: "fixture-agent", version: "1" } });
    assert.ok((init.result!["capabilities"] as { resources?: object }).resources !== undefined,
      "initialize declares the resources capability");

    // the bundle is listed per document, beside the live-state resource
    const listed = await rpc(base, "resources/list");
    const uris = (listed.result!["resources"] as Array<{ uri: string }>).map((r) => r.uri);
    assert.ok(uris.includes("despia://state"));
    assert.ok(uris.includes("despia://context/Components/App.dsx"));

    // an unknown uri is a typed refusal, not a hang or a 500
    const missing = await rpc(base, "resources/read", { uri: "despia://context/Components/Nope.dsx" });
    assert.equal(missing.error?.code, -32002);

    // the running page posts its state through the state door...
    const snapshot = { screen: "fix.App", vars: [{ name: "greeting", value: "live value" }] };
    await fetch(`${base}${STATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });

    // ...and the bundle carries all four planes: source, that state, the SSR, the samples
    const read = await rpc(base, "resources/read", { uri: "despia://context/Components/App.dsx" });
    const content = (read.result!["contents"] as Array<{ text: string }>)[0]!;
    const bundle = JSON.parse(content.text) as {
      source: string; state: typeof snapshot; ssr: string | null;
      samples: Array<{ kind: string; name: string; sample: string }>;
    };
    assert.ok(bundle.source.includes('<button label="Go"/>'), "the source plane");
    assert.deepEqual(bundle.state, snapshot, "the live-state plane, verbatim");
    assert.ok(bundle.ssr !== null && bundle.ssr.includes("Body copy"),
      "the SSR plane renders the screen server-side");
    assert.deepEqual(bundle.samples, [{ kind: "variable", name: "greeting", sample: '"Hello from the sample plane"' }],
      "the sample plane (P3) rides along");

    // THE ROUND TRIP: the agent saw the Go button in the bundle; its edit lands as a
    // splice through the same audited door the inspector uses, and the FILE follows.
    const edit = await fetch(`${base}/edit/api/edit/${encodeURIComponent("Components/App.dsx")}`, {
      method: "POST",
      body: JSON.stringify({ kind: "setAttribute", path: "1", name: "label", value: "Seen by the agent" }),
    });
    assert.equal(edit.status, 200);
    assert.ok(readFileSync(join(fx.root, "Components/App.dsx"), "utf8").includes('label="Seen by the agent"'),
      "the edit the agent derived from the bundle landed in the author's own file");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("P16: OpenRouter local PKCE - session-scoped custody, the key never leaves the process", async () => {
  // the mock exchange endpoint stands in for openrouter.ai; only the base URL is swapped
  const KEY = "sk-or-v1-test-0000";
  let exchanged: { code?: string; code_verifier?: string; code_challenge_method?: string } = {};
  const mock = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      exchanged = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: KEY }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = (mock.address() as { port: number }).port;
  process.env["DSX_OPENROUTER_BASE"] = `http://127.0.0.1:${mockPort}`;

  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // a callback with no flow in progress is a typed refusal
    assert.equal((await fetch(`${base}/edit/ai/callback?code=stray`)).status, 400);

    // connect: the auth url carries the S256 challenge and the loopback callback
    const connect = await (await fetch(`${base}/edit/api/ai/connect`, { method: "POST" })).json() as { url: string };
    const authUrl = new URL(connect.url);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok((authUrl.searchParams.get("code_challenge") ?? "").length >= 40, "a real challenge rode along");
    assert.ok((authUrl.searchParams.get("callback_url") ?? "").includes("/edit/ai/callback"));

    // the callback exchanges code + verifier and lands connected
    const callback = await fetch(`${base}/edit/ai/callback?code=fixture-code`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(exchanged.code, "fixture-code");
    assert.equal(exchanged.code_challenge_method, "S256");
    assert.ok((exchanged.code_verifier ?? "").length >= 40, "the stored verifier was sent, not the challenge");

    const status = await (await fetch(`${base}/edit/api/ai/status`)).json() as { connected: boolean };
    assert.equal(status.connected, true);

    // CUSTODY: no endpoint ever echoes the key
    for (const path of ["/edit/api/ai/status", "/edit/api/agents"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      assert.ok(!text.includes(KEY), `${path} must never carry the key`);
    }

    // disconnect drops it; a second callback cannot revive it without a fresh flow
    await fetch(`${base}/edit/api/ai/disconnect`, { method: "POST" });
    const after = await (await fetch(`${base}/edit/api/ai/status`)).json() as { connected: boolean };
    assert.equal(after.connected, false);
    assert.equal((await fetch(`${base}/edit/ai/callback?code=replay`)).status, 400,
      "the verifier is single-use - a replayed callback finds no flow");
  } finally {
    delete process.env["DSX_OPENROUTER_BASE"];
    await server.close();
    fx.cleanup();
    await new Promise<void>((r) => mock.close(() => r()));
  }
});
