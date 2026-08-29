//
//  ai-chat.test.ts — the in-Studio agent turn (master plan P16 / agent-experience G2+):
//  a turn is a LIFECYCLE - POST starts it, GET polls the live run - and the surface's
//  three guarantees hold: every write is a reviewable card (diff + counts), every turn
//  is a checkpoint one revert restores, and a secret never meets the model (write-only
//  .env custody, transcript carries the name alone).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { lineDiff, markupDiff, startEditServer as bootEditServer, visualMode } from "../src/edit.ts";
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
  <text value="Welcome"/>
  <button label="Save"/>
</stack>
`;

const EDITED = `<stack>
  <text value="Welcome"/>
  <button label="Send"/>
</stack>
`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-ai-chat-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

const KEY = "sk-or-v1-chat-fixture";

/** A scripted OpenRouter: the auth-key exchange, then one completion per script row.
 *  Rows are either tool calls or a final text; every completion request is captured. */
function scriptedModel(script: Array<{ tools?: Array<{ name: string; args: object }>; text?: string }>) {
  const seen: Array<{ auth: string; body: { model: string; messages: Array<{ role: string; content?: string }> } }> = [];
  let turn = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      if (req.url === "/api/v1/auth/keys") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ key: KEY }));
        return;
      }
      if (req.url === "/api/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "maker/flagship", name: "Flagship" }] }));
        return;
      }
      seen.push({ auth: req.headers.authorization ?? "", body: JSON.parse(body) });
      const row = script[Math.min(turn, script.length - 1)]!;
      turn += 1;
      const message = row.tools !== undefined
        ? {
            content: null,
            tool_calls: row.tools.map((t, i) => ({
              id: `call_${turn}_${i}`,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          }
        : { content: row.text ?? "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  return {
    seen,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function connect(base: string): Promise<void> {
  await fetch(`${base}/edit/api/ai/connect`, { method: "POST" });
  const callback = await fetch(`${base}/edit/ai/callback?code=fixture`, { redirect: "manual" });
  assert.equal(callback.status, 302, "the PKCE round trip seeds the session key");
}

type TurnView = {
  turn: string;
  status: string;
  reply: string;
  error: string;
  activity: Array<{ tool: string; detail: string; ok: boolean; document?: string; added?: number; removed?: number; diff?: string; lines?: Array<{ m: string; toks: Array<{ k: string; t: string }> }>; visual?: string }>;
  secretRequest: { name: string; reason: string } | null;
  edits: number;
  reverted: boolean;
};

async function startTurn(base: string, body: object): Promise<TurnView> {
  const res = await fetch(`${base}/edit/api/ai/chat`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  return (await res.json()) as TurnView;
}

/** Poll the lifecycle until it leaves `running` (the Studio's own loop, sped up). */
async function settle(base: string, id: string): Promise<TurnView> {
  for (let i = 0; i < 100; i++) {
    const view = (await (await fetch(`${base}/edit/api/ai/chat?turn=${id}`)).json()) as TurnView;
    if (view.status !== "running") return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the turn never settled");
}

test("the diff behind the cards: counts and a compact changed-hunk body", () => {
  const diff = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
  assert.equal(diff.added, 2, "one changed line + one appended line");
  assert.equal(diff.removed, 1);
  assert.ok(diff.text.includes("- b") && diff.text.includes("+ B") && diff.text.includes("+ d"));
  assert.deepEqual(lineDiff("same\n", "same\n"), { added: 0, removed: 0, text: "" });
});

test("the visual markup diff: grouped regions on the nid plane, edits vs adds vs removals", () => {
  const before = "<stack>\n  <text value=\"Hi\"/>\n  <button label=\"Save\"/>\n</stack>\n";
  // the button EDITED (amber, one nid), two texts ADDED consecutively (ONE +3 region -
  // the second carries a child), nothing removed
  const after = "<stack>\n  <text value=\"Hi\"/>\n  <button label=\"Send\"/>\n  <text value=\"A\"/>\n  <stack><text value=\"B\"/></stack>\n</stack>\n";
  const ann = markupDiff(before, after);
  assert.deepEqual(ann.before, [], "nothing was removed");
  assert.deepEqual(ann.after, [
    { kind: "chg", nids: [2], label: "\u00b1" },
    { kind: "add", nids: [3, 4], label: "+3" },
  ], "one amber edit + ONE grouped region for the consecutive additions");
  assert.equal(visualMode(before, after), "after");

  // a removal annotates the BEFORE render, ghosted in place
  const gone = markupDiff(after, before);
  assert.deepEqual(gone.before, [{ kind: "del", nids: [3, 4], label: "\u22123" }]);
  assert.deepEqual(gone.after, [{ kind: "chg", nids: [2], label: "\u00b1" }]);
  assert.equal(visualMode(after, before), "both");

  // a created file is one region: the whole tree
  assert.deepEqual(markupDiff("", before).after, [{ kind: "add", nids: [0], label: "+3" }]);
});

test("a turn is a lifecycle: live activity, diff cards, and one revert restores the files", async () => {
  const model = scriptedModel([
    { tools: [{ name: "save_document", args: { document: "Components/App.dsx", source: EDITED } }] },
    { tools: [{ name: "set_theme_tokens", args: { tokens: { "--dsx-accent": { light: "#e11d48", dark: "#fb7185" } } } }] },
    { text: "Renamed the button and tinted the accent." },
  ]);
  process.env["DSX_OPENROUTER_BASE"] = `http://127.0.0.1:${await model.listen()}`;
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // no key, no turn - custody is the precondition, typed
    const cold = await fetch(`${base}/edit/api/ai/chat`, {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(cold.status, 409);
    await connect(base);
    await fetch(`${base}${STATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screen: "fix.App", vars: [{ name: "who", value: "tester" }] }),
    });

    const started = await startTurn(base, {
      document: "Components/App.dsx",
      messages: [{ role: "user", content: "Rename the Save button to Send and make the accent rose." }],
    });
    assert.equal(started.status, "running", "POST answers immediately - the run is polled, not awaited");
    const done = await settle(base, started.turn);
    assert.equal(done.status, "done");
    assert.equal(done.reply, "Renamed the button and tinted the accent.");

    // EVERY WRITE IS A CARD: the save carries the document, the counts, and the diff body
    const save = done.activity.find((a) => a.tool === "save_document")!;
    assert.equal(save.detail, "Edited Components/App.dsx");
    assert.deepEqual([save.document, save.added, save.removed], ["Components/App.dsx", 1, 1]);
    assert.ok(save.diff!.includes('-   <button label="Save"/>') && save.diff!.includes('+   <button label="Send"/>'),
      "the diff body shows the exact lines that changed (marker, then the line as written)");
    // reviewer-grade: the diff also rides as TOKENIZED lines (syntax + add/del markers)
    const lines = save.lines!;
    const delRow = lines.find((l) => l.m === "-")!;
    assert.ok(delRow.toks.some((t) => t.k === "tag" && t.t === "button"), "the deletion is syntax-tokenized dsx");
    assert.ok(delRow.toks.some((t) => t.k === "str" && t.t === '"Save"'), "attribute strings keep their kind");

    // THE VISUAL BEFORE/AFTER: the checkpoint renders server-side, nothing written
    const wasHtml = await (await fetch(`${base}/edit/api/ai/render?turn=${started.turn}&file=${encodeURIComponent("Components/App.dsx")}&which=before`)).text();
    const nowHtml = await (await fetch(`${base}/edit/api/ai/render?turn=${started.turn}&file=${encodeURIComponent("Components/App.dsx")}&which=after`)).text();
    assert.ok(wasHtml.includes(">Save<") && !wasHtml.includes(">Send<"), "before renders the pre-turn component");
    assert.ok(nowHtml.includes(">Send<") && !nowHtml.includes(">Save<"), "after renders the file of record");
    assert.ok(wasHtml.includes("--dsx-") && wasHtml.includes("data-dsx-root"), "the render carries the real token plane");
    assert.equal(save.visual, "after", "a label edit is one amber region on the after render");
    assert.ok(nowHtml.includes('"kind":"chg"') && nowHtml.includes("dsx-ann"), "the after page carries the drawn annotation");
    assert.ok(nowHtml.includes('data-dsx-n='), "the render stamps the nid plane the annotations address");
    assert.equal((await fetch(`${base}/edit/api/ai/render?turn=${started.turn}&file=theme.css&which=before`)).status, 404,
      "only components render visually");

    const theme = done.activity.find((a) => a.tool === "set_theme_tokens")!;
    assert.equal(theme.detail, "Updated the theme");
    assert.equal(theme.document, "theme.css");
    assert.ok(theme.added! > 0 && theme.diff!.includes("--dsx-accent"));

    // the files followed, through the audited doors
    assert.equal(readFileSync(join(fx.root, "Components/App.dsx"), "utf8"), EDITED);
    assert.ok(readFileSync(join(fx.root, "theme.css"), "utf8").includes("--dsx-accent: #e11d48"));

    // the model saw the screen, on the user's key; the key never rides a poll
    assert.equal(model.seen[0]!.auth, `Bearer ${KEY}`);
    assert.ok(model.seen[0]!.body.messages[0]!.content!.includes('<button label="Save"/>'));
    assert.ok(!JSON.stringify(done).includes(KEY));

    // EVERY TURN IS A CHECKPOINT: one revert restores both files (theme.css is removed again)
    assert.equal(done.edits, 2);
    const revert = await (await fetch(`${base}/edit/api/ai/revert`, {
      method: "POST", body: JSON.stringify({ turn: started.turn }),
    })).json() as { reverted: boolean; files: number };
    assert.deepEqual(revert, { reverted: true, files: 2 });
    assert.equal(readFileSync(join(fx.root, "Components/App.dsx"), "utf8"), APP);
    assert.ok(!existsSync(join(fx.root, "theme.css")), "the file the turn created is gone again");
    const after = (await (await fetch(`${base}/edit/api/ai/chat?turn=${started.turn}`)).json()) as TurnView;
    assert.equal(after.reverted, true);
  } finally {
    delete process.env["DSX_OPENROUTER_BASE"];
    await server.close();
    fx.cleanup();
    await model.close();
  }
});

test("request_secret parks the turn; the secure write resumes it and the value never meets the model", async () => {
  const model = scriptedModel([
    { tools: [{ name: "request_secret", args: { name: "STRIPE_SECRET_KEY", reason: "To create checkout sessions." } }] },
    { text: "Stripe is wired up." },
  ]);
  process.env["DSX_OPENROUTER_BASE"] = `http://127.0.0.1:${await model.listen()}`;
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const VALUE = "sk_live_super_secret_0042";
  try {
    await connect(base);
    const started = await startTurn(base, { messages: [{ role: "user", content: "Connect Stripe." }] });
    const parked = await settle(base, started.turn);
    assert.equal(parked.status, "needs_secret");
    assert.deepEqual(parked.secretRequest, { name: "STRIPE_SECRET_KEY", reason: "To create checkout sessions." });

    // the secure input lands the value WRITE-ONLY and the run resumes on its own
    const stored = await (await fetch(`${base}/edit/api/ai/secret`, {
      method: "POST",
      body: JSON.stringify({ turn: started.turn, name: "STRIPE_SECRET_KEY", value: VALUE }),
    })).json() as { stored: string };
    assert.equal(stored.stored, "STRIPE_SECRET_KEY");
    const done = await settle(base, started.turn);
    assert.equal(done.status, "done");
    assert.equal(done.reply, "Stripe is wired up.");

    // the store: .env carries it, .gitignore guards it, the process resolves it by name
    assert.ok(readFileSync(join(fx.root, ".env"), "utf8").includes(`STRIPE_SECRET_KEY=${VALUE}`));
    assert.ok(readFileSync(join(fx.root, ".gitignore"), "utf8").split("\n").includes(".env"));
    assert.equal(process.env["STRIPE_SECRET_KEY"], VALUE);

    // CUSTODY: the value reached neither the model nor any lifecycle answer
    for (const call of model.seen) assert.ok(!JSON.stringify(call.body).includes(VALUE), "the transcript carries the name alone");
    assert.ok(!JSON.stringify(done).includes(VALUE));
    // the resumed transcript told the model the NAME is set
    const resumed = model.seen[model.seen.length - 1]!.body.messages;
    assert.ok(resumed.some((m) => m.role === "tool" && (m.content ?? "").includes("STRIPE_SECRET_KEY is now set")));

    // a malformed name is refused at the door
    assert.equal((await fetch(`${base}/edit/api/ai/secret`, {
      method: "POST", body: JSON.stringify({ name: "bad-name", value: "x" }),
    })).status, 400);
  } finally {
    delete process.env["DSX_OPENROUTER_BASE"];
    delete process.env["STRIPE_SECRET_KEY"];
    await server.close();
    fx.cleanup();
    await model.close();
  }
});

test("a refused tool call is an honest card, and the write boundary holds", async () => {
  const model = scriptedModel([
    { tools: [{ name: "save_document", args: { document: "../Evil.dsx", source: "<stack/>" } }] },
    { text: "That path is outside the project." },
  ]);
  process.env["DSX_OPENROUTER_BASE"] = `http://127.0.0.1:${await model.listen()}`;
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await connect(base);
    const started = await startTurn(base, { messages: [{ role: "user", content: "Write outside the project." }] });
    const done = await settle(base, started.turn);
    assert.equal(done.status, "done");
    assert.deepEqual(
      done.activity.map((a) => [a.tool, a.detail, a.ok]),
      [["save_document", "Could not save ../Evil.dsx", false]],
    );
    assert.equal(done.edits, 0, "a refused write checkpoints nothing");
    assert.equal(readFileSync(join(fx.root, "Components/App.dsx"), "utf8"), APP);
    assert.ok(!existsSync(join(fx.root, "..", "Evil.dsx")), "the write boundary held");
  } finally {
    delete process.env["DSX_OPENROUTER_BASE"];
    await server.close();
    fx.cleanup();
    await model.close();
  }
});

// The capability chips are GENERATED from the package catalog (agent-experience G3) - a
// bare OSS checkout has no catalog and gets an honest empty list, so these two skip
// LOUDLY off the monorepo rather than fail.
const CATALOG = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "ClosedSource", "PackageCatalog.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
})();

test("G3: the composer menu is the catalog - rows carry the scheme and the config facts",
  { skip: CATALOG === null ? "no ClosedSource catalog beside this checkout" : false }, async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { capabilities } = (await (await fetch(`${base}/edit/api/ai/capabilities`)).json()) as {
      capabilities: Array<{ scheme: string; name: string; config: Array<{ key: string; name: string }> }>;
    };
    assert.ok(capabilities.length > 100, "every catalog package is a chip - no hand list");
    const push = capabilities.find((c) => c.scheme === "onesignal")!;
    assert.equal(push.name, "OneSignal");
    assert.ok(push.config.some((c) => c.key === "app_id"), "the config declaration rides the chip");
    const sorted = capabilities.map((c) => c.name);
    assert.deepEqual(sorted, [...sorted].sort(), "rows land sorted by name");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("G3: an attached chip rides the turn as catalog facts in the system prompt",
  { skip: CATALOG === null ? "no ClosedSource catalog beside this checkout" : false }, async () => {
  const model = scriptedModel([{ text: "Push is wired." }]);
  process.env["DSX_OPENROUTER_BASE"] = `http://127.0.0.1:${await model.listen()}`;
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await connect(base);
    const started = await startTurn(base, {
      capabilities: ["onesignal", "not-a-real-scheme"],
      messages: [{ role: "user", content: "Add push." }],
    });
    await settle(base, started.turn);
    const system = model.seen[0]!.body.messages[0]!.content!;
    assert.ok(system.includes("dsx.module.onesignal"), "the chip resolves to the module's real scheme");
    assert.ok(system.includes("app_id"), "the config declaration reached the model");
    assert.ok(!system.includes("not-a-real-scheme"), "an unknown scheme is dropped, not invented");
  } finally {
    delete process.env["DSX_OPENROUTER_BASE"];
    await server.close();
    fx.cleanup();
    await model.close();
  }
});

test("G1: the model picker's list is proxied, Auto first", async () => {
  const model = scriptedModel([{ text: "unused" }]);
  process.env["DSX_OPENROUTER_BASE"] = `http://127.0.0.1:${await model.listen()}`;
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { models } = (await (await fetch(`${base}/edit/api/ai/models`)).json()) as {
      models: Array<{ id: string; name: string }>;
    };
    assert.deepEqual(models[0], { id: "openrouter/auto", name: "Auto" }, "the recommended default leads");
    assert.deepEqual(models[1], { id: "maker/flagship", name: "Flagship" }, "the account's models follow");
  } finally {
    delete process.env["DSX_OPENROUTER_BASE"];
    await server.close();
    fx.cleanup();
    await model.close();
  }
});
