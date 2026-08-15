//
//  identity.ts - the T2 identity boundary (full-stack.md): verify a provider JWT from
//  `Authorization: Bearer` into a typed Identity, or null — identity lives at the boundary,
//  never in business args. Platform-free by construction: zero imports, WebCrypto only
//  (globalThis.crypto.subtle — present in Node 22 and Deno alike). Configuration is read
//  through the bootloader's env fn AT RESOLVE TIME (DSX_JWT_SECRET · DSX_JWT_JWKS_URL ·
//  DSX_JWT_ISSUER · DSX_JWT_AUDIENCE), so secrets stay at the bootloader seam and the
//  resolver NEVER throws — anything unverifiable is "no identity", not an error.
//

/** The verified request identity the host hands to handlers via ctx. */
export interface Identity {
  /** the token's `sub` claim — required; a token without one never resolves */
  sub: string;
  /** the `role` claim if a string, else `app_metadata.role` if a string (the Supabase shape), else null */
  role: string | null;
  /** the full verified payload */
  claims: Record<string, unknown>;
  /**
   * The VERIFIED bearer token, carried forward so a request-scoped database client can present
   * it and have Postgres evaluate RLS as this user (repo.ts). It is populated only after the
   * signature, expiry, issuer and audience checks have all passed — an unverified token never
   * reaches this field, so anything holding an Identity is holding a token worth forwarding.
   */
  token: string;
}

export type IdentityResolver = (req: Request) => Promise<Identity | null>;

/** seconds of clock skew tolerated on `exp` (past) and `nbf` (future) */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Hard ceiling on a whole bearer token (bytes). A JWT is a header, a small claim set and a
 * signature; anything larger is either a mistake or an attempt to make the verifier do expensive
 * base64/JSON work per request. Rejected before ANY decoding.
 */
const MAX_TOKEN_BYTES = 8 * 1024;

/**
 * Ceiling on a token's own lifetime (`exp - iat`), when it declares `iat`. A provider that mints
 * year-long access tokens turns a single interception into permanent access; DSX refuses to treat
 * such a token as an identity even though its signature verifies. 24h matches the longest session
 * a refresh-token flow should ever need.
 *
 * THIS BOUND ALSO BITES A CREDENTIAL YOU DID NOT MINT, and the failure is otherwise silent — see
 * `overLongLifetime` below. A Supabase `service_role` key is a JWT with a ~10-year `exp`, and it is
 * what the emitted pg_cron drain sends (`deploy/supabase/queue.sql`, `Bearer :'dsx_key'`). Over the
 * ceiling it resolves to no identity at all, so an internal `reach: []` route answers it the same
 * byte-identical 404 it gives a stranger, and a queue that never drains looks exactly like a queue
 * with nothing in it. Measured against the running edge server: a 10-year service_role token gets
 * 404 on the drain, a 5-minute one gets 200.
 */
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

// ── decoding ────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null; // base64url alphabet only — never padded
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** null on any failure — callers demand a record anyway, so JSON `null` needs no sentinel */
function decodeJsonSegment(segment: string): unknown {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** the token from `Authorization: Bearer <jwt>` — the ONLY accepted carrier */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1]!;
}

// ── the JWKS key cache (module scope — warm across requests) ────────────────────────────

// url → kid → the last valid JWK set. A failed refresh NEVER replaces this map: a
// provider outage must not invalidate keys which were already verified and cached.
const jwksCache = new Map<string, Map<string, Record<string, unknown>>>();

/**
 * JWKS is reached before a token's signature can be verified, so every byte and every wait on
 * this path is attacker-triggerable. These are protocol ceilings rather than tuning knobs:
 * provider key sets are small JSON documents, and accepting an unbounded one only gives an
 * unauthenticated caller a remote memory/connection exhaustion primitive.
 */
const JWKS_FETCH_TIMEOUT_MS = 2_000;
const MAX_JWKS_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 128;

/** Read a response against the actual stream, never an unbounded `json()`/`arrayBuffer()`. */
async function readJwksBody(res: Response): Promise<unknown | null> {
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_JWKS_BYTES) {
      await res.body?.cancel("jwks_too_large").catch(() => {});
      return null;
    }
  }
  if (res.body === null) return null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_JWKS_BYTES) {
        await reader.cancel("jwks_too_large").catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** fetch + parse the JWKS; null on any failure (the cache keeps its last good copy) */
async function fetchJwks(url: string): Promise<Map<string, Record<string, unknown>> | null> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = setTimeout(() => controller?.abort(), JWKS_FETCH_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetch(url, controller === null ? undefined : { signal: controller.signal });
    if (!res.ok) return null;
    body = await readJwksBody(res);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!isRecord(body) || !Array.isArray(body["keys"])) return null;
  const entries: unknown[] = body["keys"];
  if (entries.length > MAX_JWKS_KEYS) return null;
  const byKid = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const kid = entry["kid"];
    if (typeof kid === "string" && kid !== "") byKid.set(kid, entry);
  }
  jwksCache.set(url, byKid);
  return byKid;
}

/**
 * How long the ISSUER, not one attacker-chosen kid, is held after an unknown-kid refresh.
 *
 * Short enough that a genuinely rotated key is picked up within the minute; long enough that a
 * flood of DISTINCT bogus kids cannot keep re-arming the refetch path. A per-kid cache is not a
 * defence here: measured before this guard, 25 distinct forged kids caused 25 outbound fetches.
 */
const JWKS_REFRESH_COOLDOWN_MS = 60_000;
const jwksRefreshAfter = new Map<string, number>(); // url → earliest next rotation refresh

/** One issuer can have exactly one fetch in flight, including a cold start. */
const jwksRefreshes = new Map<string, Promise<Map<string, Record<string, unknown>> | null>>();

function refreshJwks(url: string): Promise<Map<string, Record<string, unknown>> | null> {
  const inFlight = jwksRefreshes.get(url);
  if (inFlight !== undefined) return inFlight;
  const refresh = fetchJwks(url).finally(() => {
    // Delete only our own flight; a future implementation may deliberately replace it.
    if (jwksRefreshes.get(url) === refresh) jwksRefreshes.delete(url);
  });
  jwksRefreshes.set(url, refresh);
  return refresh;
}

async function jwkForKid(url: string, kid: string): Promise<Record<string, unknown> | null> {
  const cached = jwksCache.get(url)?.get(kid);
  if (cached !== undefined) return cached;

  // Join an already-running refresh BEFORE consulting the cooldown: all concurrent rotation
  // candidates get one answer, and 25 distinct kids cost one outbound request, not 25.
  const inFlight = jwksRefreshes.get(url);
  if (inFlight !== undefined) return (await inFlight)?.get(kid) ?? null;

  const now = Date.now();
  const hasWarmSet = jwksCache.has(url);
  if (hasWarmSet) {
    const refreshAfter = jwksRefreshAfter.get(url) ?? 0;
    if (refreshAfter > now) return null;
    // Arm BEFORE the await. Single-flight handles this turn's concurrency; the issuer-wide
    // cooldown handles the next turn's distinct-kid spray whether this refresh succeeds or not.
    jwksRefreshAfter.set(url, now + JWKS_REFRESH_COOLDOWN_MS);
  }

  const fresh = await refreshJwks(url); // cold fetch or the one permitted rotation refresh
  const found = fresh?.get(kid) ?? null;
  // A cold request for an unknown kid also arms the issuer-wide cooldown. A cold request that
  // FOUND its key does not: the first legitimate rotation must still be observable immediately.
  if (found === null && !hasWarmSet) jwksRefreshAfter.set(url, now + JWKS_REFRESH_COOLDOWN_MS);
  return found;
}

// Rebuild the JWK for importKey from validated fields only — nothing unvetted crosses into
// WebCrypto, and a key of the wrong type for the token's alg fails here, not in the platform.
function publicJwkFor(alg: "RS256" | "ES256", record: Record<string, unknown>): JsonWebKey | null {
  if (alg === "RS256") {
    const n = record["n"];
    const e = record["e"];
    return typeof n === "string" && typeof e === "string" ? { kty: "RSA", n, e } : null;
  }
  const crv = record["crv"];
  const x = record["x"];
  const y = record["y"];
  return crv === "P-256" && typeof x === "string" && typeof y === "string" ? { kty: "EC", crv, x, y } : null;
}

// ── signature verification (selection by the token's `alg`, never by trust) ─────────────

async function verifyHS256(secret: string, signature: Uint8Array<ArrayBuffer>, signingInput: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret), // the Supabase legacy JWT secret shape — a raw UTF-8 string
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, signingInput);
}

async function verifyJwks(
  alg: "RS256" | "ES256",
  jwksUrl: string,
  kid: string,
  signature: Uint8Array<ArrayBuffer>,
  signingInput: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const record = await jwkForKid(jwksUrl, kid);
  if (record === null) return false;
  const jwk = publicJwkFor(alg, record);
  if (jwk === null) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  // JWS ES256 signatures are raw r||s — exactly WebCrypto's ECDSA wire format, no re-coding
  return crypto.subtle.verify(alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" }, key, signature, signingInput);
}

// ── claims → Identity ───────────────────────────────────────────────────────────────────

/**
 * Refuse an over-long token — and SAY SO ONCE when it claimed a service role.
 *
 * The refusal itself is unchanged and unconditional: the answer is still `null`, so nothing about
 * who gets in has moved. What changes is that the operator can find out why. A rejected USER token
 * is ordinary (an expired session, a foreign issuer) and must stay quiet, or a hostile caller could
 * fill the log at will. A rejected SERVICE-ROLE token is not ordinary — nobody holds one by
 * accident — and it means a platform credential is being refused, which on the drain path presents
 * as a queue that silently never drains. That is the failure mode B4 exists to abolish: "a server
 * that will refuse everyone must never look healthy."
 *
 * ONCE, not per request: a cron drain retries on a schedule forever, and a line per attempt would
 * bury the one that mattered. The role is read straight off the payload rather than through a
 * verified identity because there is no identity — that is the whole point — and it is used only to
 * decide whether to log, never to grant anything.
 */
let warnedOverLongService = false;

function overLongLifetime(payload: Record<string, unknown>, seconds: number): null {
  const role = roleOf(payload);
  if (role !== null && role !== "" && role !== "authenticated" && role !== "anon" && !warnedOverLongService) {
    warnedOverLongService = true;
    const days = Math.round(seconds / 86_400);
    console.warn(
      `[dsx.server] a "${role}" token was REFUSED: its lifetime is ~${days} day(s), over the ${MAX_TOKEN_LIFETIME_SECONDS / 3600}h ceiling. ` +
        `It resolves to NO identity, so internal (reach: []) routes answer it the same 404 they give a stranger — ` +
        `a pg_cron drain sending a platform service key looks exactly like an empty queue. ` +
        `Send a short-lived token minted for the job, or raise the ceiling deliberately in identity.ts.`,
    );
  }
  return null;
}

function roleOf(claims: Record<string, unknown>): string | null {
  const role = claims["role"];
  if (typeof role === "string") return role;
  const meta = claims["app_metadata"];
  if (isRecord(meta)) {
    const metaRole = meta["role"];
    if (typeof metaRole === "string") return metaRole;
  }
  return null;
}

async function verifyToken(token: string, env: (key: string) => string | undefined): Promise<Identity | null> {
  // Size ceiling FIRST — before split/base64/JSON, so an oversized token costs a length check.
  if (token.length > MAX_TOKEN_BYTES) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJsonSegment(headerB64);
  if (!isRecord(header)) return null;
  // `typ`, when present, must say JWT: it stops a signed blob minted for another purpose by the
  // same key (a JWS over different content) from being replayed here as an identity.
  const typ = header["typ"];
  if (typ !== undefined && String(typ).toUpperCase() !== "JWT") return null;
  const alg = header["alg"];
  if (alg !== "HS256" && alg !== "RS256" && alg !== "ES256") return null; // closed set — `none` (any casing) can never pass
  const signature = base64UrlDecode(signatureB64);
  if (signature === null) return null;
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  if (alg === "HS256") {
    const secret = env("DSX_JWT_SECRET");
    if (secret === undefined || secret === "") return null; // no method configured = no identity
    if (!(await verifyHS256(secret, signature, signingInput))) return null;
  } else {
    const jwksUrl = env("DSX_JWT_JWKS_URL");
    if (jwksUrl === undefined || jwksUrl === "") return null;
    const kid = header["kid"];
    if (typeof kid !== "string" || kid === "") return null; // JWKS keys are matched by kid — a token without one cannot be
    if (!(await verifyJwks(alg, jwksUrl, kid, signature, signingInput))) return null;
  }

  const payload = decodeJsonSegment(payloadB64);
  if (!isRecord(payload)) return null;

  const now = Math.floor(Date.now() / 1000);
  // `exp` is REQUIRED, not optional. A token without an expiry is a permanent credential: once
  // intercepted it authenticates forever, and no rotation or logout can revoke it. A signature
  // that verifies is not enough — an identity must also be able to END.
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now - CLOCK_SKEW_SECONDS) return null;
  const nbf = payload["nbf"];
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf > now + CLOCK_SKEW_SECONDS)) return null;
  // A lifetime beyond the ceiling is refused even with a valid signature (see
  // MAX_TOKEN_LIFETIME_SECONDS). BOTH bounds are required, because `iat` is OPTIONAL in RFC 7519
  // and every claim here is chosen by whoever mints the token:
  //   exp - iat  refuses a token that DECLARES an over-long life;
  //   exp - now  refuses the two ways that first check is dodged — omitting `iat` so it never runs
  //              at all, and POST-DATING `iat` so a decade-long token declares a one-hour span.
  // Checking only the declared span made the ceiling opt-in for the attacker. The ceiling has to
  // bound what we GRANT, not what the token says about itself. The skew allowance matches `exp`
  // and `nbf` above so a freshly minted max-lifetime token is not refused by clock drift.
  const iat = payload["iat"];
  if (typeof iat === "number" && Number.isFinite(iat) && exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
    return overLongLifetime(payload, exp - iat);
  }
  if (exp - now > MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) return overLongLifetime(payload, exp - now);

  const issuer = env("DSX_JWT_ISSUER");
  if (issuer !== undefined && issuer !== "" && payload["iss"] !== issuer) return null; // exact match, nothing fuzzier

  const audience = env("DSX_JWT_AUDIENCE");
  if (audience !== undefined && audience !== "") {
    const aud = payload["aud"];
    const contained = typeof aud === "string" ? aud === audience : Array.isArray(aud) ? aud.includes(audience) : false;
    if (!contained) return null;
  }

  const sub = payload["sub"];
  if (typeof sub !== "string" || sub === "") return null;
  return { sub, role: roleOf(payload), claims: payload, token };
}

// ── the resolver ────────────────────────────────────────────────────────────────────────

/**
 * Build the per-boot identity resolver over the bootloader's env fn. Env is read at
 * resolve time, so rotated secrets apply without a restart; the JWKS key cache is module
 * scope, so it stays warm across requests AND resolver instances.
 */
export function createIdentityResolver(env: (key: string) => string | undefined): IdentityResolver {
  return async (req: Request): Promise<Identity | null> => {
    try {
      const token = bearerToken(req);
      if (token === null) return null;
      return await verifyToken(token, env);
    } catch {
      return null; // the resolver NEVER throws — an unverifiable token is anonymous, not an error
    }
  };
}
