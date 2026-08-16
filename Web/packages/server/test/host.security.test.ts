//
//  host.security.test.ts — the ADVERSARIAL half of the host contract (plan phase B1+B2).
//
//  Every test here was written to FAIL on the pre-hardening host, so each one pins a defect
//  that actually existed rather than describing behaviour that happened to be true:
//
//    S1  a handler exception was returned to the client verbatim (`errorMessage(e)`) — stack
//        frames, SQL text and secrets rode out on the wire.
//    S2  the body was read with an unbounded `await req.text()` — a memory-exhaustion DoS in
//        one request.
//    S4  query ⊕ body ⊕ path params were merged into ONE bag with no way for a handler to tell
//        the planes apart — mass assignment the moment a write consumes it.
//    S5  `provides`/`reach` is documented in full-stack.md as "the API gateway … a fail-closed
//        allowlist", but nothing read it: any api row was publicly dispatchable, so a queue
//        drain was a public POST guarded only by "any valid user JWT".
//
//  Verified by mutation while writing: reverting each fix in host.ts turns the matching test
//  red, and reverting none of them leaves the suite green.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHost, type HostConfig, type HostContext, type ServerRoute } from "../src/host.ts";

// The wire has no envelope: a SUCCESS is 200 carrying the handler's value verbatim, a FAILURE is its
// real status carrying { reason, message }. With no `ok` field the status line is the only
// success/failure signal, so every test below pins `res.status` as well as the body.
type Failure = { reason: string; message: string };
/** What call() hands back, parsed — either shape (object bodies here; a success may also be a scalar). */
type Body = Partial<Failure> & Record<string, unknown>;

const routes: ServerRoute[] = [
  { key: "open", chain: "shop", action: "open", method: "GET", path: "/open", reach: ["app", "web"] },
  { key: "echo", chain: "shop", action: "echo", method: "POST", path: "/echo/:p", reach: ["app"] },
  { key: "boom", chain: "shop", action: "boom", method: "GET", path: "/boom", reach: ["web"] },
  // reach: [] ⇒ INTERNAL — a cron/queue drain, never client-callable
  { key: "drain", chain: "shop", action: "drain", method: "POST", path: "/internal/drain", auth: "required", reach: [], worker: "jobs", idempotencyKey: "event_id" },
  // no reach at all ⇒ legacy row (pre-gateway tables): stays dispatchable, never silently blocked
  { key: "legacy", chain: "shop", action: "open", method: "GET", path: "/legacy" },
];

function makeConfig(over: Partial<HostConfig> = {}): HostConfig {
  return {
    routes,
    handlers: {
      shop: {
        open: () => "ok",
        echo: (args, ctx) => ({ args, query: ctx.query, body: ctx.body, params: ctx.params }),
        boom: () => { throw new Error("kaboom: SELECT * FROM users WHERE token='s3cr3t'"); },
        drain: (_a, ctx) => ({ drained: true, by: (ctx.identity as { sub?: string } | null)?.sub ?? null }),
      },
    },
    ...over,
  };
}

async function call(cfg: HostConfig, req: Request, ctx?: Partial<HostContext>) {
  const res = await createHost(cfg).handle(req, ctx);
  return { res, body: (await res.json()) as Body };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://fixture.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ── S1 · the exception must never reach the client ───────────────────────────────────────

test("S1: a handler exception is NOT echoed to the client (no stack, no SQL, no secret)", async () => {
  const seen: unknown[] = [];
  const { res, body } = await call(
    makeConfig({ onError: (info) => seen.push(info.error) }),
    new Request("http://fixture.test/boom"),
  );
  assert.equal(res.status, 500);
  assert.equal(body.reason, "handler_failed");
  const wire = JSON.stringify(body); // the body IS the wire now — nothing of the failure is outside it
  assert.ok(!wire.includes("kaboom"), "exception text leaked to the client");
  assert.ok(!wire.includes("SELECT"), "SQL leaked to the client");
  assert.ok(!wire.includes("s3cr3t"), "a secret leaked to the client");
  // the detail must still be recoverable server-side
  assert.equal((seen[0] as Error).message.includes("s3cr3t"), true);
});

test("S1: the client's correlation id matches the one handed to the failure sink", async () => {
  const seen: { correlationId: string }[] = [];
  const { res } = await call(
    makeConfig({ onError: (info) => seen.push(info) }),
    new Request("http://fixture.test/boom"),
  );
  const header = res.headers.get("x-dsx-correlation-id");
  assert.ok(header && header.length > 0, "no correlation id on the response");
  assert.equal(header, seen[0]!.correlationId);
});

test("S1: a malformed JSON body does not echo the parser's message (which quotes body bytes)", async () => {
  const { res, body } = await call(makeConfig(), post("/echo/x", "{ not json 's3cr3t'"));
  assert.equal(res.status, 400);
  assert.equal(body.reason, "bad_request");
  assert.ok(!JSON.stringify(body).includes("s3cr3t"), "body bytes echoed back through the parser message");
});

// ── S2 · the body ceiling ────────────────────────────────────────────────────────────────

test("S2: a body over the ceiling is refused 413 before the handler runs", async () => {
  let ran = false;
  const cfg = makeConfig({ maxBodyBytes: 256 });
  cfg.handlers["shop"]!["echo"] = () => { ran = true; return "should not happen"; };
  const { res, body } = await call(cfg, post("/echo/x", { blob: "z".repeat(4000) }));
  assert.equal(res.status, 413);
  assert.equal(body.reason, "bad_request");
  assert.equal(ran, false, "the handler ran on an oversized body");
});

test("S2: a LIED-ABOUT Content-Length does not get past the cap (the stream is what counts)", async () => {
  const cfg = makeConfig({ maxBodyBytes: 256 });
  const big = JSON.stringify({ blob: "z".repeat(4000) });
  const req = new Request("http://fixture.test/echo/x", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "12" }, // a lie
    body: big,
  });
  const { res } = await call(cfg, req);
  assert.equal(res.status, 413, "the declared length was trusted over the actual stream");
});

test("S2: a body inside the ceiling still works (the cap is not a wall)", async () => {
  const { res, body } = await call(makeConfig({ maxBodyBytes: 4096 }), post("/echo/x", { hello: "world" }));
  assert.equal(res.status, 200);
  // the echo handler's own value is the whole body; its `body` key is the request's body plane
  assert.deepEqual((body as { body: unknown }).body, { hello: "world" });
});

// ── S4 · the arg planes stay distinguishable ─────────────────────────────────────────────

test("S4: query / body / params are separately addressable, so a write need never trust the merge", async () => {
  const { res, body } = await call(makeConfig(), post("/echo/PARAM?q=fromQuery", { b: "fromBody" }));
  assert.equal(res.status, 200);
  const data = body as {
    args: Record<string, unknown>; query: Record<string, string>;
    body: Record<string, unknown>; params: Record<string, string>;
  };
  assert.deepEqual(data.query, { q: "fromQuery" });
  assert.deepEqual(data.body, { b: "fromBody" });
  assert.deepEqual(data.params, { p: "PARAM" });
  // the convenience merge keeps its documented precedence (query < body < params)
  assert.deepEqual(data.args, { q: "fromQuery", b: "fromBody", p: "PARAM" });
});

test("S4: a client-supplied owner_id lands ONLY in body — never disguised as a path param", async () => {
  const { res, body } = await call(makeConfig(), post("/echo/real", { owner_id: "attacker", id: "forged" }));
  assert.equal(res.status, 200);
  const data = body as { body: Record<string, unknown>; params: Record<string, string> };
  assert.deepEqual(data.params, { p: "real" }, "params must carry only what the PATH matched");
  assert.equal(data.body["owner_id"], "attacker");
  // The repository (B3) binds against ctx.body with a field allowlist; this test pins that the
  // planes make that possible at all — pre-fix there was one indistinguishable bag.
});

// ── S6 · a hostile JSON body cannot poison the body plane's prototype ─────────────────────
//
// WS-C6 (the completed security-lens review). The body plane is documented as trustworthy
// field-by-field (HostContext.body), and a hand-written server action reading `ctx.body.<field>`
// directly is the recommended, shipping pattern. A `{"__proto__": …}` body reached the plane
// through `Object.assign(body, parsed)`, whose [[Set]] of the key "__proto__" ran the
// Object.prototype setter and REPLACED body's prototype with a caller-supplied object — so
// `ctx.body.<any-key-the-client-never-sent>` then resolved to attacker data instead of
// `undefined`. Unauthenticated, one request. Mutation proof: restore `Object.assign(body, parsed)`
// in host.ts and both assertions below go red.

test("S6: a __proto__ key in the JSON body does not poison ctx.body (absent fields stay undefined)", async () => {
  // The observation MUST be made inside the handler: JSON-serialising the response and building
  // the merged args bag are both own-key-only, so a poisoned PROTOTYPE is invisible from the
  // wire — the only place it bites is a handler reading `ctx.body.<field>` directly, which is
  // exactly the shipping pattern. `owner_id` here doubles as the field a write must never take
  // from the client: a handler consulting `ctx.body.owner_id` must see what the client SENT
  // (nothing), not an injected value.
  const captured: { absent?: unknown; ownerId?: unknown; protoClean?: boolean; title?: unknown; keys?: string[]; argsOwner?: unknown } = {};
  const cfg = makeConfig();
  cfg.handlers["shop"]!["echo"] = (args, ctx) => {
    captured.absent = (ctx.body as Record<string, unknown>)["isAdmin"];  // never sent as an own field
    captured.ownerId = (ctx.body as Record<string, unknown>)["owner_id"]; // never sent as an own field
    captured.protoClean = Object.getPrototypeOf(ctx.body) === Object.prototype;
    captured.title = (ctx.body as Record<string, unknown>)["title"];      // the legitimate field survives
    captured.keys = Object.keys(ctx.body);
    captured.argsOwner = (args as Record<string, unknown>)["owner_id"];   // nor via the merge
    return "ok";
  };
  const attack = '{"__proto__":{"isAdmin":true,"owner_id":"victim"},"title":"real"}';
  const { res } = await call(cfg, post("/echo/x", attack));
  assert.equal(res.status, 200);
  assert.equal(captured.absent, undefined, "an unsent body field resolved to an injected __proto__ value — mass assignment via prototype");
  assert.equal(captured.ownerId, undefined, "owner_id was smuggled onto the body plane through the prototype");
  assert.equal(captured.protoClean, true, "ctx.body's prototype was replaced by caller-controlled data");
  assert.equal(captured.argsOwner, undefined, "the injected field reached the merged args bag");
  // the fix drops ONLY "__proto__": a normal field still lands, exactly like a legitimate body
  assert.equal(captured.title, "real");
  assert.deepEqual(captured.keys, ["title"]);
  // and the GLOBAL prototype was never in danger (Object.assign is shallow) — pinned so the
  // safe-conclusion is durable rather than assumed
  assert.equal(({} as Record<string, unknown>)["isAdmin"], undefined, "global Object.prototype was polluted");
});

// ── S5 · the gateway is real ─────────────────────────────────────────────────────────────

test("S5: an INTERNAL route (reach: []) is INDISTINGUISHABLE from a route that does not exist", async () => {
  const blocked = await call(makeConfig(), post("/internal/drain", {}));
  assert.equal(blocked.res.status, 404, "an internal route must not be reachable anonymously");
  assert.equal(blocked.body.reason, "unknown_route");
  // 404, not 403 — and the failure BODY must match a genuinely-absent route byte for byte, or the
  // difference itself tells a prober the endpoint is real and merely forbidden. (Comparing to a
  // fabricated path is the honest check: asserting "the key is absent" would pass by accident
  // whenever the key happens not to be a substring of the path the caller already supplied.)
  const absent = await call(makeConfig(), post("/internal/does-not-exist", {}));
  assert.equal(absent.res.status, blocked.res.status);
  assert.equal(absent.body.reason, blocked.body.reason);
  assert.equal(
    blocked.body.message!.replace("/internal/drain", "<path>"),
    absent.body.message!.replace("/internal/does-not-exist", "<path>"),
    "the blocked and absent failures differ — existence is observable",
  );
});

test("S5: an INTERNAL route is 404 to an ordinary authenticated USER (the pre-fix hole)", async () => {
  const { res } = await call(makeConfig(), post("/internal/drain", {}), {
    identity: { sub: "user-123", role: "authenticated" },
  });
  assert.equal(res.status, 404, "any valid user JWT reached a queue drain");
});

test("S5: an INTERNAL route serves a SERVICE-ROLE caller", async () => {
  const { res, body } = await call(makeConfig(), post("/internal/drain", {}), {
    identity: { sub: "cron", role: "service_role" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { drained: true, by: "cron" });
});

// ── S5b · the declared internal key (the pg_cron drain) ──────────────────────────────────
//
// A Supabase service_role key is a ~10-year JWT and identity.ts refuses any token over a 24h
// lifetime, so a platform service key resolves to NO identity and the drain gets the prober's
// 404 — measured live: 10-year token → 404, 5-minute token → 200. The declared key admits the
// machine caller without weakening that ceiling for anything that is actually a user.

const KEY = "s3cret-internal-key-of-known-length";
const keyed = (k: string | null): Request =>
  new Request("http://fixture.test/internal/drain", {
    method: "POST",
    headers: k === null ? {} : { "x-dsx-internal-key": k },
  });

test("S5b: the declared internal key admits a drain with NO identity at all", async () => {
  const { res, body } = await call(makeConfig({ internalKey: KEY }), keyed(KEY));
  assert.equal(res.status, 200, "the cron drain could not reach its own endpoint");
  assert.deepEqual(body, { drained: true, by: null }, "admitted by key ⇒ there is no identity to attribute");
});

test("S5b: a WRONG key is the same 404 as no key — and so is a right key on a host with none", async () => {
  const wrong = await call(makeConfig({ internalKey: KEY }), keyed("not-the-key-but-same-length--------"));
  assert.equal(wrong.res.status, 404);
  const none = await call(makeConfig({ internalKey: KEY }), keyed(null));
  assert.equal(none.res.status, 404);
  // A host that declares no key must not be openable by presenting one — otherwise "unset"
  // would be a skeleton key rather than a closed door.
  const unset = await call(makeConfig(), keyed(KEY));
  assert.equal(unset.res.status, 404, "an unconfigured host accepted an internal key");
});

test("S5b: an EMPTY declared key is 'not configured', not a key an empty header matches", async () => {
  // The failure this pins: a blank DSX_INTERNAL_KEY (unset variable, empty secret store entry)
  // becoming a credential that `x-dsx-internal-key: ` satisfies — which would silently open every
  // drain on any deployment that forgot to set it.
  const cfg = makeConfig({ internalKey: "" });
  assert.equal((await call(cfg, keyed(""))).res.status, 404);
  assert.equal((await call(cfg, keyed(null))).res.status, 404);
});

test("S5b: the key opens ONLY internal routes — it is not a bypass for auth: required", async () => {
  // The key's whole scope is the reach:[] gate. It must not become a general-purpose skeleton
  // key: a client-reaching route that demands an identity still demands one.
  const cfg = makeConfig({
    internalKey: KEY,
    routes: [...routes, { key: "acct", chain: "shop", action: "open", method: "GET", path: "/acct", auth: "required", reach: ["app"] }],
  });
  const res = await createHost(cfg).handle(
    new Request("http://fixture.test/acct", { headers: { "x-dsx-internal-key": KEY } }),
  );
  assert.equal(res.status, 401, "the internal key satisfied an auth:required route");
});

test("S5b: a service-role identity still works when a key is also configured", async () => {
  const { res } = await call(makeConfig({ internalKey: KEY }), post("/internal/drain", {}), {
    identity: { sub: "cron", role: "service_role" },
  });
  assert.equal(res.status, 200, "adding a key must not remove the role path");
});

test("S5: the service-role vocabulary is configurable, and a foreign role does not pass", async () => {
  const cfg = makeConfig({ serviceRoles: ["ops"] });
  const ok = await call(cfg, post("/internal/drain", {}), { identity: { sub: "c", role: "ops" } });
  assert.equal(ok.res.status, 200);
  const no = await call(cfg, post("/internal/drain", {}), { identity: { sub: "c", role: "service_role" } });
  assert.equal(no.res.status, 404, "a role outside the configured set must not pass");
});

test("S5: a client-reaching route is unaffected, and a reach-less LEGACY row still dispatches", async () => {
  const open = await call(makeConfig(), new Request("http://fixture.test/open"));
  assert.equal(open.res.status, 200);
  // `reach` absent (not empty) = a table emitted before the gateway existed: fail-OPEN by
  // Article 7, because silently 404-ing every legacy route would be a worse failure than the
  // gap it closes. The BUILD is what forbids a new unreachable row (prepare_server.rb).
  const legacy = await call(makeConfig(), new Request("http://fixture.test/legacy"));
  assert.equal(legacy.res.status, 200);
});
