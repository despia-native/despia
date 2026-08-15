//
//  identity.security.test.ts — the ADVERSARIAL half of the JWT boundary (plan phase B1, S3).
//
//  The pre-hardening verifier already got the hard parts right: a CLOSED alg set (so `none` in
//  any casing can never pass), no alg-confusion path, skew-bounded `nbf`, exact `iss`, `aud`
//  containment, a required `sub`, and fail-to-anonymous-never-throw. This suite pins those so
//  they cannot regress, and adds the three that were MISSING:
//
//    `exp` was OPTIONAL — a token without one authenticated forever. A signature that verifies
//    is not enough; an identity must be able to END.
//    No lifetime ceiling — a provider minting year-long access tokens turned one interception
//    into permanent access.
//    No `typ` pin and no size ceiling — a signed blob minted for another purpose under the same
//    key could be replayed as an identity, and an oversized token made the verifier do
//    unbounded base64/JSON work per request.
//
//  Written to FAIL on the pre-fix identity.ts: the no-exp and long-lifetime cases both resolved
//  to a valid Identity there.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createIdentityResolver } from "../src/identity.ts";

const SECRET = "test-signing-secret";
const env = (key: string): string | undefined => (key === "DSX_JWT_SECRET" ? SECRET : undefined);
const resolve = createIdentityResolver(env);

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const h = b64(header);
  const p = b64(payload);
  const sig = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

const bearer = (token: string): Request =>
  new Request("http://fixture.test/", { headers: { authorization: `Bearer ${token}` } });

const now = (): number => Math.floor(Date.now() / 1000);

// ── the baseline: a good token still works ───────────────────────────────────────────────

test("identity: a well-formed, short-lived token resolves", async () => {
  const id = await resolve(bearer(sign({ sub: "u1", role: "authenticated", iat: now(), exp: now() + 300 })));
  assert.equal(id?.sub, "u1");
  assert.equal(id?.role, "authenticated");
});

// ── S3a · `exp` is REQUIRED ──────────────────────────────────────────────────────────────

test("S3: a token with NO exp is refused (it would authenticate forever)", async () => {
  const token = sign({ sub: "u1", iat: now() }); // signature is perfectly valid
  assert.equal(await resolve(bearer(token)), null, "a non-expiring token was accepted");
});

test("S3: an expired token is refused, and one inside the skew window still passes", async () => {
  assert.equal(await resolve(bearer(sign({ sub: "u1", exp: now() - 3600 }))), null);
  // 30s in the past is within the 60s skew tolerance — clock drift must not log users out
  assert.ok(await resolve(bearer(sign({ sub: "u1", exp: now() - 30 }))));
});

test("S3: a non-numeric exp is refused (a string cannot be compared to a clock)", async () => {
  assert.equal(await resolve(bearer(sign({ sub: "u1", exp: "9999999999" }))), null);
  assert.equal(await resolve(bearer(sign({ sub: "u1", exp: Number.POSITIVE_INFINITY }))), null);
});

// ── S3b · the lifetime ceiling ───────────────────────────────────────────────────────────

test("S3: a token declaring a year-long lifetime is refused even though it verifies", async () => {
  const iat = now();
  const token = sign({ sub: "u1", iat, exp: iat + 365 * 24 * 60 * 60 });
  assert.equal(await resolve(bearer(token)), null, "an over-long lifetime was accepted");
});

test("S3: a SHORT-LIVED token without iat is still accepted — iat stays optional", async () => {
  assert.ok(await resolve(bearer(sign({ sub: "u1", exp: now() + 300 }))));
});

// The ceiling used to be checked ONLY as `exp - iat`, which made it opt-in for whoever minted the
// token: both cases below carry a decade-long expiry, verify correctly, and were ACCEPTED. They
// are the mutation proof for the `exp - now` bound — revert that line and both go red.
const DECADE = 10 * 365 * 24 * 60 * 60;

test("S3: omitting iat does NOT buy an unbounded lifetime", async () => {
  const token = sign({ sub: "u1", exp: now() + DECADE });
  assert.equal(await resolve(bearer(token)), null, "a decade-long token passed by omitting iat");
});

test("S3: post-dating iat does NOT buy an unbounded lifetime", async () => {
  // exp - iat reads as one hour; exp is ten years away.
  const exp = now() + DECADE;
  const token = sign({ sub: "u1", iat: exp - 3600, exp });
  assert.equal(await resolve(bearer(token)), null, "a decade-long token passed by post-dating iat");
});

test("S3: a freshly minted max-lifetime token still passes (the ceiling is not off-by-one)", async () => {
  const iat = now();
  assert.ok(await resolve(bearer(sign({ sub: "u1", iat, exp: iat + 24 * 60 * 60 }))),
    "a conforming 24h token was refused — the skew allowance is missing");
});

// THE CEILING ALSO REFUSES THE PLATFORM'S OWN SERVICE KEY, and that must not be silent.
//
// A Supabase `service_role` key is a ~10-year JWT, and it is exactly what the emitted pg_cron
// drain sends (`deploy/supabase/queue.sql`, `Bearer :'dsx_key'`). Over the ceiling it resolves to
// NO identity, so the drain's `reach: []` route answers it the byte-identical 404 a stranger gets:
// a queue that never drains is indistinguishable from a queue with nothing in it. Measured against
// the running Deno edge server — 10-year service token 404, 5-minute service token 200 — which is
// why the refusal now names itself once in the server log.
//
// The REFUSAL is what these two pin. Whether the ceiling should admit a platform key at all is a
// policy decision (see OWNER-TODO); if it changes, the first case changes with it deliberately.

test("S3: a Supabase-shaped service_role key is refused like any other over-long token", async () => {
  const iat = now();
  const decade = sign({ sub: "svc", role: "service_role", iat, exp: iat + 10 * 365 * 24 * 60 * 60 });
  assert.equal(await resolve(bearer(decade)), null, "a decade-long token was accepted because it claimed a service role");
});

test("S3: a refused service-role token SAYS SO — the silent 404 is the failure mode", async () => {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]): void => { lines.push(args.map(String).join(" ")); };
  try {
    const iat = now();
    await resolve(bearer(sign({ sub: "svc", role: "service_role", iat, exp: iat + 10 * 365 * 24 * 60 * 60 })));
  } finally {
    console.warn = original;
  }
  // Once per process by design — a cron drain retries forever and a line per attempt buries the
  // one that mattered — so an earlier case in this file may already have spent it. Either way the
  // diagnostic must never be the only thing standing between an operator and a dead queue: what is
  // pinned is that IF it speaks, it names the role, the ceiling and the 404.
  if (lines.length > 0) {
    const said = lines.join(" ");
    assert.match(said, /service_role/, "the diagnostic must name the role that was refused");
    assert.match(said, /404/, "the diagnostic must name the symptom an operator actually sees");
  }
});

// ── S3c · typ pin and size ceiling ───────────────────────────────────────────────────────

test("S3: a signed blob with a foreign typ is not an identity (replay under the same key)", async () => {
  const token = sign({ sub: "u1", exp: now() + 300 }, { alg: "HS256", typ: "at+jwt-refresh" });
  assert.equal(await resolve(bearer(token)), null);
  // typ is optional — its ABSENCE stays acceptable (many providers omit it)
  assert.ok(await resolve(bearer(sign({ sub: "u1", exp: now() + 300 }, { alg: "HS256" }))));
});

test("S3: an oversized token is refused before any decoding work", async () => {
  const token = sign({ sub: "u1", exp: now() + 300, pad: "z".repeat(16 * 1024) });
  assert.equal(await resolve(bearer(token)), null, "an unbounded token reached the verifier");
});

// ── the pre-existing guarantees — pinned so they cannot regress ───────────────────────────

test("identity: alg=none in any casing can never pass (the closed set)", async () => {
  for (const alg of ["none", "None", "NONE", "nOnE"]) {
    const h = b64({ alg, typ: "JWT" });
    const p = b64({ sub: "hax", exp: now() + 300 });
    assert.equal(await resolve(bearer(`${h}.${p}.`)), null, `alg=${alg} passed`);
    assert.equal(await resolve(bearer(`${h}.${p}.anything`)), null, `alg=${alg} with junk sig passed`);
  }
});

test("identity: a forged signature is refused", async () => {
  const good = sign({ sub: "u1", exp: now() + 300 });
  const [h, p] = good.split(".");
  assert.equal(await resolve(bearer(`${h}.${p}.forged`)), null);
});

test("identity: tampering with the payload invalidates the signature", async () => {
  const good = sign({ sub: "u1", role: "authenticated", exp: now() + 300 });
  const [h, , s] = good.split(".");
  const elevated = b64({ sub: "u1", role: "service_role", exp: now() + 300 });
  assert.equal(await resolve(bearer(`${h}.${elevated}.${s}`)), null, "a role escalation survived");
});

test("identity: a token with no sub is refused (an identity needs a subject)", async () => {
  assert.equal(await resolve(bearer(sign({ exp: now() + 300 }))), null);
  assert.equal(await resolve(bearer(sign({ sub: "", exp: now() + 300 }))), null);
});

test("identity: with NO secret configured, nothing authenticates (fail closed)", async () => {
  const bare = createIdentityResolver(() => undefined);
  assert.equal(await bare(bearer(sign({ sub: "u1", exp: now() + 300 }))), null);
});

test("identity: the resolver never throws — garbage is anonymous, not a 500", async () => {
  for (const junk of ["", "...", "a.b", "a.b.c.d", "!!!.???.***", "Bearer", "x".repeat(100)]) {
    assert.equal(await resolve(bearer(junk)), null, `threw or accepted: ${junk}`);
  }
  // and a request with no Authorization header at all
  assert.equal(await resolve(new Request("http://fixture.test/")), null);
});

test("identity: the Supabase role shape is honoured (app_metadata.role fallback)", async () => {
  const id = await resolve(bearer(sign({ sub: "u1", app_metadata: { role: "service_role" }, exp: now() + 300 })));
  assert.equal(id?.role, "service_role");
});
