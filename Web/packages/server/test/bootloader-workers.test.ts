//
//  bootloader-workers.test.ts — the Workers bootloader's OWN seams (v0-live-plan W1): the
//  env-as-argument boot, the Hyperdrive → DSX_DATABASE_URL mapping, the per-env boot cache
//  and its honest 503, the site-face chain, and the scheduled dispatcher that twins the
//  pg_cron rows. The WIRE contract itself runs on the shared fixtures — here directly, and
//  under real workerd in test/workers/ (same table, three bootloaders, one behavior).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WORKERS_QUEUE_CRON,
  WORKERS_RETENTION_CRON,
  createWorkersHandler,
  workersClientAddress,
  workersEnv,
  type WorkersEnv,
  type WorkersExecutionContext,
} from "../src/bootloader-workers.ts";
import type { ServerConfig } from "../src/config.ts";
import { wireConfig } from "./wire-fixtures.ts";

/** A ctx whose waitUntil hands the promise back, so a test can await (or expect) the tick. */
function capturingCtx(): WorkersExecutionContext & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    waitUntil(p: Promise<unknown>) {
      waited.push(p);
    },
  };
}

const ctx = (): WorkersExecutionContext => capturingCtx();

// ── the env reader ──────────────────────────────────────────────────────────────────────

test("workersEnv: string vars read as-is; non-strings and empties are absent", () => {
  const env = workersEnv({ A: "x", EMPTY: "", NUM: 7, OBJ: {} });
  assert.equal(env("A"), "x");
  assert.equal(env("EMPTY"), undefined);
  assert.equal(env("NUM"), undefined);
  assert.equal(env("OBJ"), undefined);
  assert.equal(env("MISSING"), undefined);
});

test("workersEnv: the Hyperdrive binding answers for DSX_DATABASE_URL — explicit var wins", () => {
  const viaBinding = workersEnv({ HYPERDRIVE: { connectionString: "postgres://hyperdrive/db" } });
  assert.equal(viaBinding("DSX_DATABASE_URL"), "postgres://hyperdrive/db");
  const explicit = workersEnv({
    DSX_DATABASE_URL: "postgres://explicit/db",
    HYPERDRIVE: { connectionString: "postgres://hyperdrive/db" },
  });
  assert.equal(explicit("DSX_DATABASE_URL"), "postgres://explicit/db");
  // the binding answers ONLY for the database key — no generic binding-to-env leakage
  assert.equal(viaBinding("HYPERDRIVE"), undefined);
});

test("workersClientAddress: CF-Connecting-IP or null, never a guess", () => {
  assert.equal(workersClientAddress(new Request("https://w.test/", { headers: { "cf-connecting-ip": "203.0.113.9" } })), "203.0.113.9");
  assert.equal(workersClientAddress(new Request("https://w.test/")), null);
});

// ── the fetch path: same wire, workers-shaped ───────────────────────────────────────────

test("workers: wire parity on the shared fixtures — status, envelope, params, merge", async () => {
  const handler = createWorkersHandler(wireConfig);
  const env: WorkersEnv = {};

  const health = await handler.fetch(new Request("https://w.test/health"), env, ctx());
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { up: true });

  const param = await handler.fetch(new Request("https://w.test/orders/A%2F42"), env, ctx());
  assert.deepEqual(await param.json(), { got: { id: "A/42" } });

  const merge = await handler.fetch(
    new Request("https://w.test/merge/frompath?a=fromquery&b=fromquery&c=fromquery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ b: "frombody", c: "frombody" }),
    }),
    env,
    ctx(),
  );
  assert.deepEqual(await merge.json(), { a: "fromquery", b: "frombody", c: "frompath" });

  const missing = await handler.fetch(new Request("https://w.test/nope"), env, ctx());
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { reason: string }).reason, "unknown_route");

  const wrongMethod = await handler.fetch(new Request("https://w.test/orders"), env, ctx());
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const thrown = await handler.fetch(new Request("https://w.test/boom"), env, ctx());
  assert.equal(thrown.status, 500);
  const body = (await thrown.json()) as { reason: string; message: string };
  assert.equal(body.reason, "handler_failed");
  assert.ok(!JSON.stringify(body).includes("kaboom"), "the exception text must not reach the client");
});

test("workers: strips /functions/v1/dsx and /dsx mounts; query and body survive", async () => {
  const handler = createWorkersHandler(wireConfig);
  const env: WorkersEnv = {};
  for (const path of ["/functions/v1/dsx/health", "/dsx/health", "/health"]) {
    const res = await handler.fetch(new Request(`https://w.test${path}`), env, ctx());
    assert.equal(res.status, 200, path);
  }
  const post = await handler.fetch(
    new Request("https://w.test/dsx/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "s1" }),
    }),
    env,
    ctx(),
  );
  assert.deepEqual(await post.json(), { created: { sku: "s1" } });
  const notMount = await handler.fetch(new Request("https://w.test/dsxfoo"), env, ctx());
  assert.equal(notMount.status, 404);
});

test("workers: no config = empty table — typed unknown_route, never a crash", async () => {
  const handler = createWorkersHandler();
  const res = await handler.fetch(new Request("https://w.test/dsx/health"), {}, ctx());
  assert.equal(res.status, 404);
});

// ── boot: per-env, lazy, failure as a message ───────────────────────────────────────────

const demandingConfig: ServerConfig = {
  settings: {},
  env: {},
  required: [{ key: "database_url", env: "DSX_DATABASE_URL", friendlyName: "Database address", setting: "config.json → database_url" }],
};

test("workers: a boot failure answers 503 boot_failed naming the setting — and is cached per env", async () => {
  const handler = createWorkersHandler(wireConfig, demandingConfig);
  const env: WorkersEnv = {};
  for (let i = 0; i < 2; i++) {
    const res = await handler.fetch(new Request("https://w.test/health"), env, ctx());
    assert.equal(res.status, 503);
    const body = (await res.json()) as { reason: string; message: string };
    assert.equal(body.reason, "boot_failed");
    assert.ok(body.message.includes("Database address"), "the friendly name must reach the operator");
  }
});

test("workers: a different env boots separately — the satisfied one serves", async () => {
  const handler = createWorkersHandler(wireConfig, demandingConfig);
  const broken: WorkersEnv = {};
  const satisfied: WorkersEnv = { DSX_DATABASE_URL: "postgres://db.test/app" };
  assert.equal((await handler.fetch(new Request("https://w.test/health"), broken, ctx())).status, 503);
  assert.equal((await handler.fetch(new Request("https://w.test/health"), satisfied, ctx())).status, 200);
});

test("workers: the Hyperdrive binding satisfies a required database_url at boot", async () => {
  const handler = createWorkersHandler(wireConfig, demandingConfig);
  const env: WorkersEnv = { HYPERDRIVE: { connectionString: "postgres://hyperdrive/db" } };
  assert.equal((await handler.fetch(new Request("https://w.test/health"), env, ctx())).status, 200);
});

// ── the site face ───────────────────────────────────────────────────────────────────────

/** An empty registry: every page request misses, so the chain's fall-through is observable. */
const emptyRegistry = { components: {}, routes: [], schemes: [] } as never;

test("workers: site chain — asset hit served verbatim, 404 falls through to the API host", async () => {
  const served: string[] = [];
  const assets = {
    fetch: (req: Request): Promise<Response> => {
      const { pathname } = new URL(req.url);
      served.push(pathname);
      return Promise.resolve(
        pathname === "/app.css"
          ? new Response("body{}", { headers: { "content-type": "text/css" } })
          : new Response("no such asset", { status: 404 }),
      );
    },
  };
  const handler = createWorkersHandler(wireConfig, undefined, { siteRegistry: emptyRegistry });
  const env: WorkersEnv = { ASSETS: assets };

  const css = await handler.fetch(new Request("https://w.test/app.css"), env, ctx());
  assert.equal(css.status, 200);
  assert.equal(await css.text(), "body{}");

  // no asset, no page route — the API host answers (its typed 404 for an unknown path)
  const api = await handler.fetch(new Request("https://w.test/health"), env, ctx());
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { up: true });

  // non-GET/HEAD skips the site face entirely: the asset binding never saw the POST
  await handler.fetch(new Request("https://w.test/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env, ctx());
  assert.deepEqual(served, ["/app.css", "/health"]);
});

test("workers: no ASSETS binding + a site registry still chains the page handler", async () => {
  const handler = createWorkersHandler(wireConfig, undefined, { siteRegistry: emptyRegistry });
  const res = await handler.fetch(new Request("https://w.test/health"), {}, ctx());
  assert.equal(res.status, 200);
});

// ── the scheduled dispatcher: the pg_cron twin ──────────────────────────────────────────

test("scheduled: the queue cron drains every worker row through the internal-key path", async () => {
  const drained: string[] = [];
  const handler = createWorkersHandler({
    routes: [
      { key: "drain-a", chain: "q", action: "drainA", method: "POST", path: "/internal/a/drain", auth: "required", worker: "a", reach: [] },
      { key: "drain-b", chain: "q", action: "drainB", method: "POST", path: "/internal/b/drain", auth: "required", worker: "b", reach: [] },
      { key: "plain", chain: "q", action: "plain", method: "GET", path: "/plain" },
    ],
    handlers: {
      q: {
        drainA: () => { drained.push("a"); return { drained: 0 }; },
        drainB: () => { drained.push("b"); return { drained: 0 }; },
        plain: () => { drained.push("plain"); return null; },
      },
    },
  });
  const c = capturingCtx();
  handler.scheduled({ cron: WORKERS_QUEUE_CRON, scheduledTime: 0 }, { DSX_INTERNAL_KEY: "k-1" }, c);
  assert.equal(c.waited.length, 1);
  await c.waited[0];
  assert.deepEqual(drained.sort(), ["a", "b"]); // the plain row did not fire
});

test("scheduled: a declared `schedule` row fires on its own cron, and only its own", async () => {
  const fired: string[] = [];
  const handler = createWorkersHandler({
    routes: [
      { key: "digest", chain: "jobs", action: "digest", method: "POST", path: "/internal/digest", auth: "required", reach: [], schedule: "0 6 * * *" },
    ],
    handlers: { jobs: { digest: () => { fired.push("digest"); return null; } } },
  });
  const env: WorkersEnv = { DSX_INTERNAL_KEY: "k-1" };

  const miss = capturingCtx();
  handler.scheduled({ cron: WORKERS_QUEUE_CRON, scheduledTime: 0 }, env, miss);
  await miss.waited[0];
  assert.deepEqual(fired, []);

  const hit = capturingCtx();
  handler.scheduled({ cron: "0 6 * * *", scheduledTime: 0 }, env, hit);
  await hit.waited[0];
  assert.deepEqual(fired, ["digest"]);
});

test("scheduled: due rows with no internal key REFUSE loudly — the silent-drain failure, deleted", async () => {
  const handler = createWorkersHandler({
    routes: [{ key: "drain", chain: "q", action: "drain", method: "POST", path: "/internal/q/drain", auth: "required", worker: "q", reach: [] }],
    handlers: { q: { drain: () => null } },
  });
  const c = capturingCtx();
  handler.scheduled({ cron: WORKERS_QUEUE_CRON, scheduledTime: 0 }, {}, c);
  await assert.rejects(() => c.waited[0]!, /DSX_INTERNAL_KEY/);
});

test("scheduled: one failing row does not stop the others; the tick still reports red", async () => {
  const drained: string[] = [];
  const handler = createWorkersHandler({
    routes: [
      { key: "bad", chain: "q", action: "bad", method: "POST", path: "/internal/bad/drain", auth: "required", worker: "bad", reach: [] },
      { key: "good", chain: "q", action: "good", method: "POST", path: "/internal/good/drain", auth: "required", worker: "good", reach: [] },
    ],
    handlers: {
      q: {
        bad: () => { throw new Error("drain exploded"); },
        good: () => { drained.push("good"); return null; },
      },
    },
  });
  const c = capturingCtx();
  handler.scheduled({ cron: WORKERS_QUEUE_CRON, scheduledTime: 0 }, { DSX_INTERNAL_KEY: "k-1" }, c);
  await assert.rejects(() => c.waited[0]!, /1 failure/);
  assert.deepEqual(drained, ["good"]);
});

test("scheduled: the retention cron resolves cleanly with no transport installed (sweeps are no-ops)", async () => {
  const handler = createWorkersHandler(wireConfig);
  const c = capturingCtx();
  handler.scheduled({ cron: WORKERS_RETENTION_CRON, scheduledTime: 0 }, {}, c);
  await c.waited[0]; // resolving IS the assertion — a tree on another backend pays nothing
});

test("scheduled: a boot failure rejects the tick with the boot detail", async () => {
  const handler = createWorkersHandler(wireConfig, demandingConfig);
  const c = capturingCtx();
  handler.scheduled({ cron: WORKERS_QUEUE_CRON, scheduledTime: 0 }, {}, c);
  await assert.rejects(() => c.waited[0]!, /boot failed/);
});
