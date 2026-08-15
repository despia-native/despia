//
//  identity.test.ts - the T2 identity boundary (full-stack.md) on SELF-CONTAINED fixtures:
//  tokens are signed in-test with crypto.subtle (HS256 secret, RS256/ES256 keypairs) and
//  the JWKS is served from an in-test node:http server, so kid caching and the
//  refetch-once rotation contract are observable as request counts. Plus the host's
//  route-level auth gate (auth: "required" → 401 unauthenticated) and the edge bootloader
//  wiring (Bearer → ctx.identity) — never touching the repo's generated/ folder.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createIdentityResolver, type Identity } from "../src/identity.ts";
import { createHost, type HostConfig, type HostContext } from "../src/host.ts";
import { createEdgeHandler } from "../src/bootloader-deno.ts";

// ── token forges (crypto.subtle, same primitives the resolver verifies with) ────────────

type Claims = Record<string, unknown>;

const encoder = new TextEncoder();
const now = (): number => Math.floor(Date.now() / 1000);

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function b64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

async function signHS256(payload: unknown, secret: string, header: Claims = { alg: "HS256", typ: "JWT" }): Promise<string> {
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${input}.${b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(input)))}`;
}

async function signWithKey(privateKey: CryptoKey, alg: "RS256" | "ES256", kid: string, payload: Claims): Promise<string> {
  const input = `${b64urlJson({ alg, typ: "JWT", kid })}.${b64urlJson(payload)}`;
  const params = alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
  return `${input}.${b64url(await crypto.subtle.sign(params, privateKey, encoder.encode(input)))}`;
}

/** Signature validity is deliberately irrelevant to an unknown-kid amplification probe: key
 *  lookup happens first, because there is no key with which to verify it yet. */
function forgedRsaToken(kid: string): string {
  return `${b64urlJson({ alg: "RS256", typ: "JWT", kid })}.${b64urlJson(baseClaims())}.AA`;
}

async function generateRsa(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

const SECRET = "fixture-shared-secret";

function baseClaims(extra: Claims = {}): Claims {
  return { sub: "user-1", role: "authenticated", exp: now() + 3600, ...extra };
}

function bearer(token: string | null): Request {
  return new Request("http://fixture.test/", token === null ? undefined : { headers: { authorization: `Bearer ${token}` } });
}

function envOf(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key];
}

const hsEnv = envOf({ DSX_JWT_SECRET: SECRET });

// ── the in-test JWKS endpoint (mutable keys + a request counter) ────────────────────────

interface JwksServer {
  url: string;
  hits(): number;
  setKeys(next: unknown[]): void;
  close(): Promise<void>;
}

async function serveJwks(initialKeys: unknown[]): Promise<JwksServer> {
  let keys = initialKeys;
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>((listening) => server.listen(0, () => listening()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0; // port 0 = OS-assigned
  return {
    url: `http://localhost:${port}/keys`,
    hits: () => hits,
    setKeys: (next) => {
      keys = next;
    },
    close: () => new Promise<void>((done, failed) => server.close((e) => (e !== undefined ? failed(e) : done()))),
  };
}

// ── HS256 ───────────────────────────────────────────────────────────────────────────────

test("identity: HS256 happy path — sub, role, the full verified claims", async () => {
  const resolve = createIdentityResolver(hsEnv);
  const identity = await resolve(bearer(await signHS256(baseClaims({ email: "hs@fixture.test" }), SECRET)));
  assert.ok(identity !== null);
  assert.equal(identity.sub, "user-1");
  assert.equal(identity.role, "authenticated");
  assert.equal(identity.claims["email"], "hs@fixture.test");
  assert.equal(identity.claims["sub"], "user-1");
});

test("identity: role falls back to app_metadata.role (the Supabase shape), else null", async () => {
  const resolve = createIdentityResolver(hsEnv);
  const viaMeta = await resolve(bearer(await signHS256(baseClaims({ role: undefined, app_metadata: { role: "admin" } }), SECRET)));
  assert.ok(viaMeta !== null);
  assert.equal(viaMeta.role, "admin");
  const nonString = await resolve(bearer(await signHS256(baseClaims({ role: undefined, app_metadata: { role: 7 } }), SECRET)));
  assert.ok(nonString !== null);
  assert.equal(nonString.role, null);
});

test("identity: tampered payload or wrong secret → null", async () => {
  const resolve = createIdentityResolver(hsEnv);
  const parts = (await signHS256(baseClaims(), SECRET)).split(".");
  parts[1] = b64urlJson(baseClaims({ sub: "attacker" })); // payload swap under the original signature
  assert.equal(await resolve(bearer(parts.join("."))), null);
  assert.equal(await resolve(bearer(await signHS256(baseClaims(), "some-other-secret"))), null);
});

test("identity: missing/non-Bearer/malformed tokens → null, never a throw", async () => {
  const resolve = createIdentityResolver(hsEnv);
  assert.equal(await resolve(bearer(null)), null); // no Authorization header at all
  assert.equal(await resolve(new Request("http://fixture.test/", { headers: { authorization: "Basic dXNlcjpwdw==" } })), null);
  assert.equal(await resolve(bearer("not-a-jwt")), null);
  assert.equal(await resolve(bearer("a.b")), null); // two segments
  assert.equal(await resolve(bearer("!!!.@@@.###")), null); // outside the base64url alphabet
  assert.equal(await resolve(bearer(`${b64urlJson([1])}.${b64urlJson({})}.AA`)), null); // header is not an object
  assert.equal(await resolve(bearer(await signHS256([1, 2], SECRET))), null); // validly signed, payload is not an object
});

test("identity: exp/nbf — hard expiry rejects, 60s skew tolerated both ways", async () => {
  const resolve = createIdentityResolver(hsEnv);
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ exp: now() - 3600 }), SECRET))), null); // long expired
  assert.ok(await resolve(bearer(await signHS256(baseClaims({ exp: now() - 30 }), SECRET)))); // expired, but inside skew
  assert.ok(await resolve(bearer(await signHS256(baseClaims({ nbf: now() + 30 }), SECRET)))); // not-yet-valid, inside skew
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ nbf: now() + 3600 }), SECRET))), null); // nbf far future
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ exp: "soon" }), SECRET))), null); // malformed exp
});

test("identity: issuer — exact match when DSX_JWT_ISSUER is set", async () => {
  const resolve = createIdentityResolver(envOf({ DSX_JWT_SECRET: SECRET, DSX_JWT_ISSUER: "https://iss.fixture.test/auth/v1" }));
  assert.ok(await resolve(bearer(await signHS256(baseClaims({ iss: "https://iss.fixture.test/auth/v1" }), SECRET))));
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ iss: "https://evil.fixture.test" }), SECRET))), null);
  assert.equal(await resolve(bearer(await signHS256(baseClaims(), SECRET))), null); // missing iss = mismatch
});

test("identity: audience — containment across string and array aud shapes", async () => {
  const resolve = createIdentityResolver(envOf({ DSX_JWT_SECRET: SECRET, DSX_JWT_AUDIENCE: "authenticated" }));
  assert.ok(await resolve(bearer(await signHS256(baseClaims({ aud: "authenticated" }), SECRET))));
  assert.ok(await resolve(bearer(await signHS256(baseClaims({ aud: ["other", "authenticated"] }), SECRET))));
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ aud: ["other"] }), SECRET))), null);
  assert.equal(await resolve(bearer(await signHS256(baseClaims(), SECRET))), null); // missing aud = mismatch
});

test("identity: missing/blank/non-string sub → null", async () => {
  const resolve = createIdentityResolver(hsEnv);
  assert.equal(await resolve(bearer(await signHS256({ role: "authenticated", exp: now() + 3600 }, SECRET))), null);
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ sub: "" }), SECRET))), null);
  assert.equal(await resolve(bearer(await signHS256(baseClaims({ sub: 42 }), SECRET))), null);
});

test("identity: alg none is never accepted, whatever the casing or signature", async () => {
  const resolve = createIdentityResolver(hsEnv);
  const payload = b64urlJson(baseClaims());
  for (const alg of ["none", "None", "NONE"]) {
    const head = b64urlJson({ alg, typ: "JWT" });
    assert.equal(await resolve(bearer(`${head}.${payload}.`)), null, alg); // empty signature
    assert.equal(await resolve(bearer(`${head}.${payload}.AAAA`)), null, alg); // junk signature
  }
});

test("identity: unknown algs and unconfigured methods → null", async () => {
  const withBoth = createIdentityResolver(envOf({ DSX_JWT_SECRET: SECRET, DSX_JWT_JWKS_URL: "http://localhost:1/keys" }));
  assert.equal(await withBoth(bearer(await signHS256(baseClaims(), SECRET, { alg: "HS384", typ: "JWT" }))), null);
  assert.equal(await withBoth(bearer(await signHS256(baseClaims(), SECRET, { alg: "PS256", typ: "JWT" }))), null);
  const jwksOnly = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: "http://localhost:1/keys" }));
  assert.equal(await jwksOnly(bearer(await signHS256(baseClaims(), SECRET))), null); // HS256 but no secret configured
  const secretOnly = createIdentityResolver(hsEnv); // RS256 but no JWKS configured — no fetch is ever attempted
  assert.equal(await secretOnly(bearer(`${b64urlJson({ alg: "RS256", kid: "k1" })}.${b64urlJson(baseClaims())}.AAAA`)), null);
});

test("identity: no auth env configured — every token resolves null (everything stays public)", async () => {
  const resolve = createIdentityResolver(() => undefined);
  assert.equal(await resolve(bearer(await signHS256(baseClaims(), SECRET))), null);
  assert.equal(await resolve(bearer(null)), null);
});

// ── RS256/ES256 via JWKS ────────────────────────────────────────────────────────────────

test("identity: RS256 via JWKS — happy path, keys cached by kid (one fetch, ever)", async () => {
  const { privateKey, publicJwk } = await generateRsa();
  const jwks = await serveJwks([{ ...publicJwk, kid: "k1", alg: "RS256", use: "sig" }]);
  try {
    const resolve = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: jwks.url }));
    const token = await signWithKey(privateKey, "RS256", "k1", baseClaims({ email: "rsa@fixture.test" }));
    const first = await resolve(bearer(token));
    assert.ok(first !== null);
    assert.equal(first.sub, "user-1");
    assert.equal(first.role, "authenticated");
    assert.equal(first.claims["email"], "rsa@fixture.test");
    assert.equal(jwks.hits(), 1);
    assert.ok(await resolve(bearer(token)));
    assert.equal(jwks.hits(), 1); // module-scope kid cache — the second resolve never refetches
  } finally {
    await jwks.close();
  }
});

test("identity: rotation refresh is issuer-cooled, then a later rotation lands after expiry", async () => {
  const { privateKey, publicJwk } = await generateRsa();
  const k1 = { ...publicJwk, kid: "k1", alg: "RS256", use: "sig" };
  const k2 = { ...publicJwk, kid: "k2", alg: "RS256", use: "sig" };
  const k3 = { ...publicJwk, kid: "k3", alg: "RS256", use: "sig" };
  const jwks = await serveJwks([k1]);
  const realNow = Date.now;
  try {
    const resolve = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: jwks.url }));
    assert.ok(await resolve(bearer(await signWithKey(privateKey, "RS256", "k1", baseClaims()))));
    assert.equal(jwks.hits(), 1);
    jwks.setKeys([k1, k2]); // the provider rotates: k2 appears upstream, the warm cache only knows k1
    assert.ok(await resolve(bearer(await signWithKey(privateKey, "RS256", "k2", baseClaims()))));
    assert.equal(jwks.hits(), 2); // exactly one refetch found it
    jwks.setKeys([k1, k2, k3]);
    assert.equal(await resolve(bearer(await signWithKey(privateKey, "RS256", "k3", baseClaims()))), null);
    assert.equal(jwks.hits(), 2, "a second distinct kid bypassed the issuer-wide cooldown");

    const clock = realNow();
    Date.now = () => clock + 60_001;
    assert.ok(await resolve(bearer(await signWithKey(privateKey, "RS256", "k3", baseClaims()))));
    assert.equal(jwks.hits(), 3, "a legitimate rotation was not observable after cooldown expiry");
    assert.equal(await resolve(bearer(`${b64urlJson({ alg: "RS256" })}.${b64urlJson(baseClaims())}.AAAA`)), null);
    assert.equal(jwks.hits(), 3); // a token without a kid cannot be matched — and costs no fetch
  } finally {
    Date.now = realNow;
    await jwks.close();
  }
});

test("identity: 25 concurrent distinct unknown kids share ONE issuer refresh", async () => {
  const realFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => {
    hits++;
    // Keep the one fetch in flight while every caller reaches the single-flight map.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(JSON.stringify({ keys: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const resolve = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: "https://jwks.single-flight.fixture/keys" }));
    const identities = await Promise.all(
      Array.from({ length: 25 }, (_, i) => resolve(bearer(forgedRsaToken(`ghost-${i}`)))),
    );
    assert.ok(identities.every((identity) => identity === null));
    assert.equal(hits, 1, "25 attacker-chosen kids amplified into more than one outbound fetch");
    assert.equal(await resolve(bearer(forgedRsaToken("ghost-after-wave"))), null);
    assert.equal(hits, 1, "a new kid bypassed the issuer-wide cooldown after the shared miss");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("identity: a hung JWKS issuer is aborted by the hard boundary deadline", async () => {
  const realFetch = globalThis.fetch;
  let aborted = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal !== undefined && signal !== null, "JWKS fetch carried no abort signal");
      signal.addEventListener("abort", () => {
        aborted++;
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      }, { once: true });
    })) as typeof fetch;
  const started = Date.now();
  try {
    const resolve = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: "https://jwks.hung.fixture/keys" }));
    assert.equal(await resolve(bearer(forgedRsaToken("hung"))), null);
    const elapsed = Date.now() - started;
    assert.equal(aborted, 1, "the hung issuer was not aborted");
    assert.ok(elapsed < 3_000, `the resolver exceeded its hard JWKS deadline (${elapsed} ms)`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("identity: an oversized JWKS document and an excessive key set are both rejected", async () => {
  const { privateKey, publicJwk } = await generateRsa();
  const key = { ...publicJwk, kid: "bounded", alg: "RS256", use: "sig" };
  const token = await signWithKey(privateKey, "RS256", "bounded", baseClaims());
  const realFetch = globalThis.fetch;
  let byteHits = 0;
  let keyHits = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("bytes")) {
      byteHits++;
      // No Content-Length: this exercises the ACTUAL streaming counter, not the cheap header.
      return new Response(JSON.stringify({ keys: [key], padding: "x".repeat(300 * 1024) }), { status: 200 });
    }
    keyHits++;
    return new Response(JSON.stringify({
      keys: [key, ...Array.from({ length: 128 }, (_, i) => ({ kid: `extra-${i}` }))],
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const bytes = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: "https://jwks.bytes.fixture/keys" }));
    const keys = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: "https://jwks.keys.fixture/keys" }));
    assert.equal(await bytes(bearer(token)), null, "a >256 KiB JWKS document was accepted");
    assert.equal(await keys(bearer(token)), null, "a 129-key JWKS document was accepted");
    assert.equal(byteHits, 1);
    assert.equal(keyHits, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("identity: a failed rotation refresh preserves the last-good known key", async () => {
  const { privateKey, publicJwk } = await generateRsa();
  const key = { ...publicJwk, kid: "stable", alg: "RS256", use: "sig" };
  const stable = await signWithKey(privateKey, "RS256", "stable", baseClaims());
  const realFetch = globalThis.fetch;
  let healthy = true;
  let hits = 0;
  globalThis.fetch = (async () => {
    hits++;
    return healthy
      ? new Response(JSON.stringify({ keys: [key] }), { status: 200 })
      : new Response("issuer unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    const resolve = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: "https://jwks.last-good.fixture/keys" }));
    assert.ok(await resolve(bearer(stable)));
    assert.equal(hits, 1);
    healthy = false;
    assert.equal(await resolve(bearer(forgedRsaToken("rotated-but-unavailable"))), null);
    assert.equal(hits, 2);
    assert.ok(await resolve(bearer(stable)), "a failed refresh evicted a previously verified key");
    assert.equal(hits, 2, "a cached known key made another network request during issuer failure");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("identity: ES256 via JWKS — raw r||s signatures verify", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = await serveJwks([{ ...publicJwk, kid: "ec1", alg: "ES256", use: "sig" }]);
  try {
    const resolve = createIdentityResolver(envOf({ DSX_JWT_JWKS_URL: jwks.url }));
    const identity = await resolve(bearer(await signWithKey(pair.privateKey, "ES256", "ec1", baseClaims())));
    assert.ok(identity !== null);
    assert.equal(identity.sub, "user-1");
  } finally {
    await jwks.close();
  }
});

// ── the host's route-level auth gate + the bootloader wiring ────────────────────────────

const authedConfig: HostConfig = {
  routes: [
    { key: "open", chain: "t", action: "open", method: "GET", path: "/open" },
    { key: "me", chain: "t", action: "me", method: "GET", path: "/me", auth: "required" },
  ],
  handlers: {
    t: {
      open: () => "public",
      me: (_args, ctx: HostContext) => ({ identity: ctx.identity }),
    },
  },
};

test('host auth: auth "required" → 401 unauthenticated without an identity, 200 with; public rows unaffected', async () => {
  const host = createHost(authedConfig);
  const denied = await host.handle(new Request("http://fixture.test/me"));
  assert.equal(denied.status, 401); // the status is the failure signal — the body carries no `ok`
  assert.deepEqual(await denied.json(), { reason: "unauthenticated", message: 'route "me" requires an authenticated identity' });
  const identity: Identity = { sub: "user-1", role: "authenticated", claims: { sub: "user-1" }, token: "fixture.jwt.sig" };
  const granted = await host.handle(new Request("http://fixture.test/me"), { identity, env: () => undefined });
  assert.equal(granted.status, 200);
  assert.deepEqual(await granted.json(), { identity });
  const open = await host.handle(new Request("http://fixture.test/open")); // anonymous on a public row
  assert.equal(open.status, 200);
  assert.deepEqual(await open.json(), "public");
});

test("edge wiring: the bootloader resolves Bearer → ctx.identity and the auth gate opens", async () => {
  process.env["DSX_JWT_SECRET"] = SECRET; // the edge bootloader reads the platform env, per request
  try {
    const edge = createEdgeHandler(authedConfig);
    const token = await signHS256(baseClaims(), SECRET);
    const granted = await edge(new Request("https://edge.test/dsx/me", { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(granted.status, 200);
    const body = (await granted.json()) as { identity: Identity };
    assert.equal(body.identity.sub, "user-1");
    assert.equal(body.identity.role, "authenticated");
    const denied = await edge(new Request("https://edge.test/dsx/me")); // anonymous
    assert.equal(denied.status, 401);
    const invalid = await edge(new Request("https://edge.test/dsx/me", { headers: { authorization: "Bearer x.y.z" } }));
    assert.equal(invalid.status, 401); // an unverifiable token is anonymous, not an error
    const open = await edge(new Request("https://edge.test/dsx/open"));
    assert.equal(open.status, 200);
  } finally {
    delete process.env["DSX_JWT_SECRET"];
  }
});
