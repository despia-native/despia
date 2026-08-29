//
//  host.test.ts - the T1 server module host (full-stack.md) on INLINE fixtures: the wire
//  shape, :param extraction, query/body/path merge precedence, the typed failure
//  vocabulary, longest-literal-prefix table ordering, the deno edge prefix strip, the
//  generated-artifacts loader contract, and one real node:http round-trip — all against
//  temp fixtures, never the repo's generated/ folder itself.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHost, type Host, type HostContext } from "../src/host.ts";
import { createEdgeHandler } from "../src/bootloader-deno.ts";
import { loadGenerated } from "../src/generated-loader.ts";
import { serve } from "../src/bootloader-node.ts";
import { wireConfig as config, wireRoutes as routes } from "./wire-fixtures.ts";

// The server adds NO envelope: a SUCCESS is 200 carrying the handler's value verbatim, a FAILURE is
// its real status carrying { reason, message }. There is no `ok` field, so the status line is the
// only success/failure signal — which is why every FAILURE test below pins `res.status` itself.
// (A few success-path tests assert the whole body with deepEqual instead; that still catches a
// 200-on-failure regression, since the failure body would not match.)
type Failure = { reason: string; message: string };
// What call() hands back, parsed. `Record<string, unknown>` is a reader's convenience for the object
// bodies these fixtures return — a success body may equally be a bare string or null.
type Body = Partial<Failure> & Record<string, unknown>;

// The fixture table lives in wire-fixtures.ts so the workerd leg runs the SAME rows — the
// suites below are unchanged consumers of it.

async function call(host: Host, req: Request, ctx?: Partial<HostContext>): Promise<{ res: Response; body: Body }> {
  const res = await host.handle(req, ctx);
  return { res, body: (await res.json()) as Body };
}

test("host: GET happy path — 200, the handler's value IS the body, JSON content-type", async () => {
  const host = createHost(config);
  const { res, body } = await call(host, new Request("http://fixture.test/health"));
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("application/json"));
  assert.deepEqual(body, { up: true });
});

test("host: :param segments extract into args (decoded)", async () => {
  const host = createHost(config);
  const { body } = await call(host, new Request("http://fixture.test/orders/A%2F42"));
  assert.deepEqual(body, { got: { id: "A/42" } });
});

test("host: merge precedence — body over query, path params over both", async () => {
  const host = createHost(config);
  const { res, body } = await call(
    host,
    new Request("http://fixture.test/merge/frompath?a=fromquery&b=fromquery&c=fromquery", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ b: "frombody", c: "frombody" }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { a: "fromquery", b: "frombody", c: "frompath" });
});

test("host: unknown route → 404 unknown_route", async () => {
  const host = createHost(config);
  const { res, body } = await call(host, new Request("http://fixture.test/nope"));
  assert.equal(res.status, 404); // the status IS the failure signal now — there is no `ok` field
  assert.equal(body.reason, "unknown_route");
  assert.ok(body.message!.includes("/nope"));
});

test("host: path matches another method → 405 method_not_allowed + allow header", async () => {
  const host = createHost(config);
  const { res, body } = await call(host, new Request("http://fixture.test/orders", { method: "GET" }));
  assert.equal(res.status, 405);
  assert.equal(body.reason, "method_not_allowed");
  assert.equal(res.headers.get("allow"), "POST"); // the lowercase "post" row normalized
});

test("host: a method-mismatched literal falls through to the :param twin, not 405", async () => {
  const host = createHost({
    routes: [
      { key: "lit", chain: "t", action: "lit", method: "POST", path: "/a/summary" },
      { key: "par", chain: "t", action: "par", method: "GET", path: "/a/:id" },
    ],
    handlers: { t: { lit: () => "lit", par: (args) => args } },
  });
  const { res, body } = await call(host, new Request("http://fixture.test/a/summary"));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { id: "summary" }); // GET is served by /a/:id
});

test("host: malformed JSON body → 400 bad_request", async () => {
  const host = createHost(config);
  const { res, body } = await call(
    host,
    new Request("http://fixture.test/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" }),
  );
  assert.equal(res.status, 400);
  assert.equal(body.reason, "bad_request");
});

test("host: non-object JSON body → 400 bad_request (args need an object to merge)", async () => {
  const host = createHost(config);
  const { res, body } = await call(
    host,
    new Request("http://fixture.test/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" }),
  );
  assert.equal(res.status, 400);
  assert.equal(body.reason, "bad_request");
});

test("host: empty body under a JSON content-type is absent, never malformed", async () => {
  const host = createHost(config);
  const { res, body } = await call(
    host,
    new Request("http://fixture.test/orders?sku=q1", { method: "POST", headers: { "content-type": "application/json" } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { created: { sku: "q1" } });
});

test("host: handler throw → 500 handler_failed, message NEVER echoed to the client", async () => {
  // This test used to assert the Error message ("kaboom") on the wire — i.e. it pinned the leak.
  // A handler exception carries stack frames, SQL text and sometimes secrets, so the caller now
  // gets a fixed reason + a correlation id, and the detail goes to the server-side sink only.
  const seen: { correlationId: string; route: string; error: unknown }[] = [];
  const host = createHost({ ...config, onError: (info) => seen.push(info) });
  const { res, body } = await call(host, new Request("http://fixture.test/boom"));
  assert.equal(res.status, 500);
  assert.equal(body.reason, "handler_failed");
  assert.equal(body.message, "internal error");
  assert.ok(!JSON.stringify(body).includes("kaboom"), "the exception text must not reach the client");
  // …but it must be recoverable server-side, tied to the id the client was handed.
  assert.equal(seen.length, 1);
  assert.equal((seen[0]!.error as Error).message, "kaboom");
  assert.equal(res.headers.get("x-dsx-correlation-id"), seen[0]!.correlationId);
});

test("host: route naming an unregistered handler → 500 unknown_action", async () => {
  const host = createHost(config);
  const { res, body } = await call(host, new Request("http://fixture.test/ghost"));
  assert.equal(res.status, 500);
  assert.equal(body.reason, "unknown_action");
  assert.ok(body.message!.includes("shop.ghost"));
});

test("host: table ordering — /orders/summary beats /orders/:id whatever the input order", async () => {
  for (const rows of [routes, [...routes].reverse()]) {
    const host = createHost({ ...config, routes: rows });
    const summary = await call(host, new Request("http://fixture.test/orders/summary"));
    assert.equal(summary.body, "summary-route");
    const param = await call(host, new Request("http://fixture.test/orders/77"));
    assert.deepEqual(param.body, { got: { id: "77" } });
  }
});

test("host: an undefined handler return goes out as the JSON body `null`, never an empty response", async () => {
  const host = createHost(config);
  const { res } = await call(host, new Request("http://fixture.test/nothing"));
  const raw = await createHost(config).handle(new Request("http://fixture.test/nothing"));
  assert.equal(res.status, 200);
  assert.equal(raw.status, 200); // the status is the success signal the old `"ok":true` byte used to carry
  // `undefined` is not JSON, so the whole body is the four bytes `null` — a reader never has to
  // distinguish "no body" from "the handler returned nothing".
  assert.equal(await raw.text(), "null");
});

test("host: ctx defaults (config buildInfo, null identity, empty env) and per-call overrides", async () => {
  const host = createHost(config);
  const defaults = await call(host, new Request("http://fixture.test/ctx"));
  assert.deepEqual(defaults.body, { buildInfo: { digest: "fixture-digest" }, identity: null, envX: null });
  const overridden = await call(host, new Request("http://fixture.test/ctx"), {
    identity: { sub: "user-1" },
    env: (key) => (key === "X" ? "42" : undefined),
  });
  assert.deepEqual(overridden.body, { buildInfo: { digest: "fixture-digest" }, identity: { sub: "user-1" }, envX: "42" });
});

// ── the deno edge handler ───────────────────────────────────────────────────────────────

test("edge: strips /functions/v1/dsx and /dsx mounts; bare paths pass through", async () => {
  const edge = createEdgeHandler(config);
  for (const path of ["/functions/v1/dsx/health", "/dsx/health", "/health"]) {
    const res = await edge(new Request(`https://edge.test${path}`));
    assert.equal(res.status, 200, path);
    assert.deepEqual(await res.json(), { up: true });
  }
  const exact = await edge(new Request("https://edge.test/functions/v1/dsx")); // the exact mount = "/"
  assert.equal(exact.status, 200);
  assert.equal(await exact.json(), "root");
});

test("edge: query and body survive the strip; /dsxfoo is not a mount", async () => {
  const edge = createEdgeHandler(config);
  const get = await edge(new Request("https://edge.test/functions/v1/dsx/orders/9?note=hi"));
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { got: { id: "9", note: "hi" } });
  const post = await edge(
    new Request("https://edge.test/dsx/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "s1" }),
    }),
  );
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { created: { sku: "s1" } });
  const notMount = await edge(new Request("https://edge.test/dsxfoo"));
  assert.equal(notMount.status, 404);
});

test("edge: no config = empty table — typed unknown_route, never a crash", async () => {
  const edge = createEdgeHandler();
  const res = await edge(new Request("https://edge.test/dsx/health"));
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as Failure).reason, "unknown_route");
});

// ── the generated-artifacts loader (against its OWN temp fixtures, never generated/) ────

test("loader: a missing generated/ folder names the emitter to run", async () => {
  //  The instruction has to be one a CONSUMER of the published package can act on — it used
  //  to name a build script that ships with the commercial layer, which they do not have
  //  (plan E1, defect D2).
  await assert.rejects(() => loadGenerated(join(tmpdir(), "dsx-no-such-generated-dir")), /despia build/);
});

test("loader: reads routes.json + build-info.json and imports the handlers barrel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-generated-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" })); // pin ESM for the barrel outside the workspace
    writeFileSync(join(dir, "routes.json"), JSON.stringify([{ key: "health", chain: "server.http", action: "health", method: "GET", path: "/health", schedule: "0 * * * *" }]));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ digest: "d1" }));
    writeFileSync(join(dir, "handlers.ts"), 'export const handlers = { "server.http": { health: () => ({ up: true }) } };\n');
    const generated = await loadGenerated(dir);
    assert.equal(generated.buildInfo.digest, "d1");
    const host = createHost({ routes: generated.routes, handlers: generated.handlers, buildInfo: generated.buildInfo });
    const { res, body } = await call(host, new Request("http://fixture.test/health"));
    assert.equal(res.status, 200);
    assert.deepEqual(body, { up: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the node bootloader (a real HTTP round-trip through the translation loop) ───────────

test("node bootloader: serves the generated table over node:http — request and response translate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-generated-serve-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "routes.json"), JSON.stringify([
      { key: "health", chain: "server.http", action: "health", method: "GET", path: "/health" },
      { key: "merge", chain: "server.http", action: "merge", method: "POST", path: "/merge/:c" },
    ]));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ digest: "d2" }));
    writeFileSync(
      join(dir, "handlers.ts"),
      'export const handlers = { "server.http": { health: (_args, ctx) => ({ up: true, digest: ctx.buildInfo.digest }), merge: (args) => args } };\n',
    );
    const booted = await serve({ port: 0, generatedDir: dir }); // port 0 = OS-assigned, echoed back
    try {
      const health = await fetch(`http://localhost:${booted.port}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { up: true, digest: "d2" });
      const merged = await fetch(`http://localhost:${booted.port}/merge/frompath?a=q&b=q`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ b: "body" }),
      });
      assert.equal(merged.status, 200); // the `ok: true` this deepEqual used to carry now lives here
      assert.deepEqual(await merged.json(), { a: "q", b: "body", c: "frompath" });
      const missing = await fetch(`http://localhost:${booted.port}/nope`);
      assert.equal(missing.status, 404);
    } finally {
      await booted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The TRANSPORT-level 500 — the bootloader's own catch, not the host's. It was unreachable by
// any test, so both halves of its contract were unpinned: the client must NOT receive the
// exception text (it carries stack frames and secrets), and the operator MUST still get a
// correlation id to join the sanitized reply to the logged cause. A raw socket is the only way
// in: `new Request()` rejects a URL built from a Host header containing a space, and fetch/undici
// would normalize that away before it ever reached us.
test("bootloader: a transport-level throw is a sanitized 500 that still carries a correlation id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-transport-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "routes.json"), JSON.stringify([
      { key: "health", chain: "server.http", action: "health", method: "GET", path: "/health" },
    ]));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ digest: "d3" }));
    writeFileSync(
      join(dir, "handlers.ts"),
      'export const handlers = { "server.http": { health: () => ({ up: true }) } };\n',
    );
    const booted = await serve({ port: 0, generatedDir: dir });
    try {
      const raw = await new Promise<string>((done, fail) => {
        const sock = connect(booted.port, "127.0.0.1", () => {
          sock.write("GET /health HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n");
        });
        let out = "";
        sock.on("data", (d) => { out += d.toString(); });
        sock.on("end", () => done(out));
        sock.on("error", fail);
      });
      assert.match(raw, /^HTTP\/1\.1 500 /, "transport failure answers 500");
      assert.match(raw, /x-dsx-correlation-id: /i, "and hands back an id the operator can grep");
      assert.match(raw, /"reason":"handler_failed"/);
      assert.match(raw, /"message":"internal error"/, "the client gets the sanitized text, never the exception");
      assert.ok(!/TypeError|Invalid URL|at Object\./.test(raw), "no exception text or stack reaches the wire");
    } finally {
      await booted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loader: a row missing one of the five fields is rejected with the row index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-generated-bad-"));
  try {
    writeFileSync(join(dir, "routes.json"), JSON.stringify([{ key: "k", chain: "c", action: "a", method: "GET" }])); // no path
    writeFileSync(join(dir, "build-info.json"), "{}");
    writeFileSync(join(dir, "handlers.ts"), "export const handlers = {};\n");
    await assert.rejects(() => loadGenerated(dir), /row 0 is missing string "path"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
