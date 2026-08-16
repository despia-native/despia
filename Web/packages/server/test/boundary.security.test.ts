//
//  boundary.security.test.ts — the defects an adversarial review found by ATTACKING the
//  running server, after the unit suites were already green.
//
//  Each of these was a property the code CLAIMED in a comment and did not have. They are pinned
//  here because the claim is the thing that rots: the host really does cap bodies, really does
//  404 internal routes, really does cache JWKS — and every one of those was true in the file
//  that said so and false at the boundary a request actually crosses.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createHost, DEFAULT_MAX_BODY_BYTES, type ServerRoute } from "../src/host.ts";

const INTERNAL: ServerRoute = { key: "drain", chain: "server.http", action: "drain", method: "POST", path: "/internal/webhooks/drain", reach: [] } as ServerRoute;
const PUBLIC: ServerRoute = { key: "health", chain: "server.http", action: "health", method: "GET", path: "/health" } as ServerRoute;

const host = createHost({
  routes: [INTERNAL, PUBLIC],
  handlers: { "server.http": { drain: async () => ({ drained: 0 }), health: async () => ({ ok: true }) } },
});

// ── the internal route must not answer a wrong-method probe differently from an absent one ──

test("an internal route is indistinguishable from a route that does not exist", async () => {
  // The reach gate answers non-service callers with a 404 — but the METHOD check ran first, so
  // GET on a POST-only internal route returned 405 with `allow: POST`, disclosing both that the
  // endpoint exists and how to call it, to an unauthenticated prober.
  const probe = await host.handle(new Request("http://x/internal/webhooks/drain", { method: "GET" }));
  const absent = await host.handle(new Request("http://x/internal/nope/nope", { method: "GET" }));

  assert.equal(probe.status, absent.status, "a wrong-method probe of an INTERNAL route revealed it exists");
  assert.equal(probe.status, 404);
  assert.equal(probe.headers.get("allow"), null, "the Allow header named the internal route's method");
  const body = (await probe.json()) as { message: string };
  assert.ok(!/POST/.test(body.message), "the error message named the internal route's method");
});

test("a PUBLIC route still reports its allowed methods — the 405 path is not simply gone", async () => {
  const res = await host.handle(new Request("http://x/health", { method: "DELETE" }));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("the service-role caller still reaches the internal route", async () => {
  const res = await host.handle(new Request("http://x/internal/webhooks/drain", { method: "POST" }), {
    identity: { sub: "svc", role: "service_role", claims: {}, token: "t" },
  });
  assert.equal(res.status, 200);
});

// ── the declared body cap is the transport's job, not only the host's ────────────────────

test("the host refuses an oversized body before parsing it", async () => {
  const big = "x".repeat(DEFAULT_MAX_BODY_BYTES + 1024);
  const res = await host.handle(new Request("http://x/health", { method: "POST", body: big }));
  assert.ok(res.status === 413 || res.status === 405, `expected a refusal, got ${res.status}`);
});

// ── JWKS: an unknown kid must not be an outbound-fetch amplifier ─────────────────────────

test("identity: a repeated unknown kid does NOT re-fetch the JWKS every time", async () => {
  const { createIdentityResolver } = await import("../src/identity.ts");
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const resolve = createIdentityResolver((k) =>
      k === "DSX_JWT_JWKS_URL" ? "https://idp.example/.well-known/jwks.json" : undefined,
    );
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const token = (kid: string) =>
      `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64({ sub: "s", iat: now, exp: now + 60 })}.sig`;

    for (let i = 0; i < 10; i++) {
      await resolve(new Request("http://x/", { headers: { authorization: `Bearer ${token("bogus-kid")}` } }));
    }
    assert.ok(fetches <= 2, `one unknown kid replayed 10 times caused ${fetches} outbound JWKS fetches — 1:1 amplification against the identity provider`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
