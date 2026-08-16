//
//  ratelimit.test.ts — the request budget, and the host wiring that spends it.
//
//  The interesting assertions are the ones about ORDER and about FAILURE. A limiter charged before
//  the 401 lets a stranger drain somebody else's budget; one charged after the body read stops
//  nothing it was declared to stop; one that fails closed converts its own store's hiccup into a
//  total outage. All three are pinned here.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHost, parseRateRule, type ServerRoute } from "../src/host.ts";
import { rateHeaders, RateLimitSeam, spend } from "../src/ratelimit.ts";

/** An exact in-memory counter — the same arithmetic the SQL upsert performs. */
function counting(): { hits: string[]; reset(): void } {
  const counts = new Map<string, number>();
  const hits: string[] = [];
  RateLimitSeam.store = {
    hit: async (bucket, windowStartMs) => {
      const key = `${bucket}@${windowStartMs}`;
      hits.push(bucket);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
  return { hits, reset: () => counts.clear() };
}

// ── the rule grammar ────────────────────────────────────────────────────────────────────

test("ratelimit: the declared grammar parses, and a typo yields no limit rather than a boot failure", () => {
  assert.deepEqual(parseRateRule("60/m"), { limit: 60, windowMs: 60_000 });
  assert.deepEqual(parseRateRule("5/s"), { limit: 5, windowMs: 1000 });
  assert.deepEqual(parseRateRule("1000/h"), { limit: 1000, windowMs: 3_600_000 });
  assert.deepEqual(parseRateRule("30/15m"), { limit: 30, windowMs: 900_000 });
  for (const bogus of ["", "60", "60/x", "0/m", "-1/m", "60 / m", "abc", undefined]) {
    assert.equal(parseRateRule(bogus), null, `"${String(bogus)}" produced a rule`);
  }
});

// ── the counter ─────────────────────────────────────────────────────────────────────────

test("ratelimit: the Nth request inside a window is the last one allowed", async () => {
  counting();
  const rule = { limit: 3, windowMs: 60_000 };
  const at = 1_000_000_000_000;
  const verdicts = [];
  for (let i = 0; i < 5; i++) verdicts.push(await spend("b", rule, { nowMs: at }));

  assert.deepEqual(verdicts.map((v) => v.allowed), [true, true, true, false, false]);
  assert.deepEqual(verdicts.map((v) => v.remaining), [2, 1, 0, 0, 0]);
  assert.ok(verdicts[3]!.retryAfterSeconds >= 1, "a refusal must never invite an immediate retry");
});

test("ratelimit: windows are aligned to the epoch, so two callers agree on which window they are in", async () => {
  counting();
  const rule = { limit: 1, windowMs: 60_000 };
  // Two requests 59s apart that land in the SAME aligned minute: the second is refused.
  const base = Math.floor(1_000_000_000_000 / 60_000) * 60_000;
  assert.equal((await spend("b", rule, { nowMs: base + 500 })).allowed, true);
  assert.equal((await spend("b", rule, { nowMs: base + 59_000 })).allowed, false);
  // …and one in the NEXT aligned minute is allowed again.
  assert.equal((await spend("b", rule, { nowMs: base + 60_001 })).allowed, true);
});

test("ratelimit: with NO store installed every request is allowed", async () => {
  RateLimitSeam.store = null;
  const verdict = await spend("b", { limit: 1, windowMs: 1000 }, { nowMs: 1 });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.remaining, 1);
});

test("ratelimit: a store FAILURE allows the request and reports the fault — it never 500s", async () => {
  const seen: unknown[] = [];
  RateLimitSeam.store = {
    hit: async () => {
      throw new Error("connection refused");
    },
  };
  const verdict = await spend("b", { limit: 1, windowMs: 1000 }, { nowMs: 1, onError: (e) => seen.push(e) });
  assert.equal(verdict.allowed, true, "a limiter that fails closed turns its own outage into a total one");
  assert.equal(seen.length, 1, "the failure must still be reported, not swallowed");
});

test("ratelimit: an oversized bucket key is truncated, so a caller cannot choose the index size", async () => {
  const store = counting();
  await spend("x".repeat(5000), { limit: 10, windowMs: 1000 }, { nowMs: 1 });
  assert.ok(store.hits[0]!.length <= 200, `the key reached the store at ${store.hits[0]!.length} bytes`);
});

test("ratelimit: the advisory headers are present on an allowed request too", () => {
  const headers = rateHeaders({ allowed: true, limit: 10, remaining: 7, resetAtMs: 60_000, retryAfterSeconds: 0 });
  assert.equal(headers["x-ratelimit-limit"], "10");
  assert.equal(headers["x-ratelimit-remaining"], "7");
  assert.equal(headers["retry-after"], undefined, "an allowed request must not carry Retry-After");
  const refused = rateHeaders({ allowed: false, limit: 10, remaining: 0, resetAtMs: 60_000, retryAfterSeconds: 12 });
  assert.equal(refused["retry-after"], "12");
});

// ── the host wiring ─────────────────────────────────────────────────────────────────────

const PUBLIC_ROUTE: ServerRoute = { key: "ping", chain: "server.http", action: "ping", method: "POST", path: "/ping", rate: "2/m", reach: ["web"] };

test("ratelimit: an over-budget request is 429 with Retry-After, and the handler never runs", async () => {
  counting();
  let ran = 0;
  const server = createHost({
    routes: [PUBLIC_ROUTE],
    handlers: { "server.http": { ping: () => { ran++; return {}; } } },
  });
  const call = (): Promise<Response> => server.handle(new Request("https://x/ping", { method: "POST" }));

  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const refused = await call();
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after") !== null, true);
  assert.deepEqual(await refused.json(), { reason: "rate_limited", message: 'too many requests for route "ping"' });
  assert.equal(ran, 2, "the handler ran for a request that was over budget");
});

test("ratelimit: an UNAUTHENTICATED request is refused BEFORE it can spend anyone's budget", async () => {
  //  Order matters: charging before the identity gate lets a stranger exhaust the budget of the
  //  user whose bucket the request would have landed in.
  const store = counting();
  const server = createHost({
    routes: [{ ...PUBLIC_ROUTE, auth: "required" }],
    handlers: { "server.http": { ping: () => ({}) } },
  });
  const response = await server.handle(new Request("https://x/ping", { method: "POST" }));
  assert.equal(response.status, 401);
  assert.equal(store.hits.length, 0, "an unauthenticated request spent a budget");
});

test("ratelimit: two identities have SEPARATE budgets, and the bucket is the verified subject", async () => {
  const store = counting();
  const server = createHost({
    routes: [{ ...PUBLIC_ROUTE, auth: "required" }],
    handlers: { "server.http": { ping: () => ({}) } },
  });
  const as = (sub: string): Promise<Response> =>
    server.handle(new Request("https://x/ping", { method: "POST" }), { identity: { sub, role: null, claims: {}, token: "t" } });

  assert.equal((await as("alice")).status, 200);
  assert.equal((await as("alice")).status, 200);
  assert.equal((await as("alice")).status, 429);
  assert.equal((await as("bob")).status, 200, "bob was charged alice's budget");
  assert.deepEqual(store.hits.slice(0, 2), ["ping|u:alice", "ping|u:alice"]);
});

test("ratelimit: an anonymous caller is bucketed by clientAddress when the bootloader supplies one", async () => {
  const store = counting();
  const server = createHost({
    routes: [PUBLIC_ROUTE],
    handlers: { "server.http": { ping: () => ({}) } },
    clientAddress: (req) => req.headers.get("x-test-addr"),
  });
  const from = (addr: string): Promise<Response> =>
    server.handle(new Request("https://x/ping", { method: "POST", headers: { "x-test-addr": addr } }));

  assert.equal((await from("1.1.1.1")).status, 200);
  assert.equal((await from("1.1.1.1")).status, 200);
  assert.equal((await from("1.1.1.1")).status, 429);
  assert.equal((await from("2.2.2.2")).status, 200, "one address exhausted another's budget");
  assert.deepEqual(store.hits.at(-1), "ping|a:2.2.2.2");
});

test("ratelimit: a route with NO declared rate spends nothing", async () => {
  const store = counting();
  const server = createHost({
    routes: [{ ...PUBLIC_ROUTE, rate: undefined }],
    handlers: { "server.http": { ping: () => ({}) } },
  });
  for (let i = 0; i < 10; i++) assert.equal((await server.handle(new Request("https://x/ping", { method: "POST" }))).status, 200);
  assert.equal(store.hits.length, 0, "a route that declared no budget was charged one");
});

test("ratelimit: the budget headers ride the SUCCESS response, so a client can back off early", async () => {
  counting();
  const server = createHost({
    routes: [PUBLIC_ROUTE],
    handlers: { "server.http": { ping: () => ({}) } },
  });
  const response = await server.handle(new Request("https://x/ping", { method: "POST" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ratelimit-limit"), "2");
  assert.equal(response.headers.get("x-ratelimit-remaining"), "1");
});
