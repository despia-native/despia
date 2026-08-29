//
//  server-workers.workers.test.ts — W1's parity gate under REAL workerd (v0-live-plan §2):
//  the fixture worker is bundled with esbuild (the same neutral-platform shape the supabase
//  target proves every PR) and booted in miniflare, which runs the actual workerd binary —
//  not a simulation. What runs here and what it pairs with:
//    · the host WIRE CONTRACT on the shared fixture table   (host.test.ts runs it on node)
//    · the mount-strip + body semantics                     (the deno edge section's twin)
//    · the boot-failure 503 message                         (bootloader-workers.test.ts unit-proves it)
//    · the site face over the platform's assets binding
//    · the <api> CORPUS, executed inside the isolate        (api-conformance.test.ts runs it on node;
//                                                            Kotlin + Swift run the same file)
//  The scheduled dispatcher is node-tested (bootloader-workers.test.ts): miniflare exposes no
//  scheduled trigger to drive from here, and its logic is platform-free dispatch into the host.
//

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

import { caseRequest, checkCase, type McpTransportCorpus } from "../mcp-transport-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "..", "..", "..", "..");
// INSIDE the package's gitignored dist/, not the OS tmpdir: workerd resolves the script
// relative to its starting directory and refuses any path that needs `..` to escape it.
const scratch = join(here, "..", "..", "dist", "test-workers");
mkdirSync(scratch, { recursive: true });

let wire: Miniflare;
let refusing: Miniflare;
let site: Miniflare;
let mcp: Miniflare;
const mcpCorpus = JSON.parse(
  readFileSync(join(workspace, "..", "Conformance", "ai", "mcp", "server-transport.json"), "utf-8"),
) as McpTransportCorpus;
const disposers: Miniflare[] = [];

before(async () => {
  const bundle = join(scratch, "fixture-worker.js");
  await build({
    entryPoints: [join(here, "fixture-worker.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["import"],
    mainFields: ["module", "main"],
    outfile: bundle,
    logLevel: "silent",
  });
  const assetsDir = join(scratch, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "app.css"), "body{color:#123}");
  writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>fixture</title>");

  wire = new Miniflare({ modules: true, scriptPath: bundle });
  refusing = new Miniflare({ modules: true, scriptPath: bundle, bindings: { DSX_TEST_DEMANDING: "1" } });
  mcp = new Miniflare({
    modules: true,
    scriptPath: bundle,
    bindings: { DSX_TEST_MCP: JSON.stringify({ tools: mcpCorpus.tools, actions: mcpCorpus.actions, cases: [] }) },
  });
  site = new Miniflare({
    modules: true,
    scriptPath: bundle,
    bindings: { DSX_TEST_SITE: "1" },
    // worker-first — the shape the deploy emitter writes (wrangler `run_worker_first`): the
    // worker owns every request (API routes + dynamic pages) and reaches static files through
    // the binding, which is exactly the chain site-workers.ts implements. This is miniflare's
    // raw spelling of that wrangler flag.
    assets: {
      directory: assetsDir,
      binding: "ASSETS",
      routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true },
    },
  });
  disposers.push(wire, refusing, site, mcp);
});

after(async () => {
  for (const mf of disposers) await mf.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

type Body = { reason?: string; message?: string } & Record<string, unknown>;

test("workerd: GET happy path — 200, the handler's value IS the body, JSON content-type", async () => {
  const res = await wire.dispatchFetch("https://w.test/health");
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("application/json"));
  assert.deepEqual(await res.json(), { up: true });
});

test("workerd: :param segments extract into args (decoded)", async () => {
  const res = await wire.dispatchFetch("https://w.test/orders/A%2F42");
  assert.deepEqual(await res.json(), { got: { id: "A/42" } });
});

test("workerd: merge precedence — body over query, path params over both", async () => {
  const res = await wire.dispatchFetch("https://w.test/merge/frompath?a=fromquery&b=fromquery&c=fromquery", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ b: "frombody", c: "frombody" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { a: "fromquery", b: "frombody", c: "frompath" });
});

test("workerd: unknown route → 404 unknown_route; wrong method → 405 + allow", async () => {
  const missing = await wire.dispatchFetch("https://w.test/nope");
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as Body).reason, "unknown_route");
  const wrongMethod = await wire.dispatchFetch("https://w.test/orders");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
});

test("workerd: handler throw → 500 handler_failed, exception text never on the wire", async () => {
  const res = await wire.dispatchFetch("https://w.test/boom");
  assert.equal(res.status, 500);
  const body = (await res.json()) as Body;
  assert.equal(body.reason, "handler_failed");
  assert.ok(!JSON.stringify(body).includes("kaboom"));
});

test("workerd: strips /functions/v1/dsx and /dsx mounts; body survives the strip", async () => {
  for (const path of ["/functions/v1/dsx/health", "/dsx/health", "/health"]) {
    assert.equal((await wire.dispatchFetch(`https://w.test${path}`)).status, 200, path);
  }
  const post = await wire.dispatchFetch("https://w.test/dsx/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "s1" }),
  });
  assert.deepEqual(await post.json(), { created: { sku: "s1" } });
});

test("workerd: a boot failure answers 503 boot_failed naming the setting — no isolate crash", async () => {
  const res = await refusing.dispatchFetch("https://w.test/health");
  assert.equal(res.status, 503);
  const body = (await res.json()) as Body;
  assert.equal(body.reason, "boot_failed");
  assert.ok((body.message ?? "").includes("Database address"));
});

test("workerd: the site face serves the assets binding and falls through to the API host", async () => {
  const css = await site.dispatchFetch("https://w.test/app.css");
  assert.equal(css.status, 200);
  assert.equal(await css.text(), "body{color:#123}");
  const api = await site.dispatchFetch("https://w.test/health");
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { up: true });
});

test("workerd: the MCP server-transport corpus passes through the full bootloader", async () => {
  // Cases carrying a resolved identity run only where the runner can inject one (the node
  // leg drives the face directly); everything else runs through the real bootloader here.
  const runnable = mcpCorpus.cases.filter((c) => c.identity === undefined || c.identity === null);
  assert.ok(runnable.length >= mcpCorpus.cases.length - 1, "the corpus grew identity cases — widen the workerd leg");
  const failed: string[] = [];
  for (const c of runnable) {
    const req = caseRequest(c, "https://w.test");
    const res = await mcp.dispatchFetch(req.url, {
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
    });
    const failures = await checkCase(c, res as unknown as Response);
    if (failures.length > 0) failed.push(`${c.name}: ${failures.join("; ")}`);
  }
  assert.deepEqual(failed, [], `${failed.length} MCP transport case(s) failed under workerd`);
});

test("workerd: the <api> corpus passes inside the isolate — every case, zero failures", async () => {
  const corpus = JSON.parse(
    readFileSync(join(workspace, "..", "Conformance", "api", "api-blocks.json"), "utf-8"),
  ) as { cases: { name: string }[] };
  assert.ok(corpus.cases.length > 0, "api corpus is empty");
  const res = await wire.dispatchFetch("https://w.test/__api-corpus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpus.cases),
  });
  assert.equal(res.status, 200);
  const results = (await res.json()) as { name: string; failures: string[] }[];
  assert.equal(results.length, corpus.cases.length);
  const failed = results.filter((r) => r.failures.length > 0);
  assert.deepEqual(
    failed.map((r) => `${r.name}: ${r.failures.join("; ")}`),
    [],
    `${failed.length} corpus case(s) failed under workerd`,
  );
});
