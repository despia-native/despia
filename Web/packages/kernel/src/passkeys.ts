//
//  passkeys.ts — the SHARED PURE CORE behind Core/Passkeys (F17.3): what a passkey ceremony's
//  INPUT is, decided once and run identically by all three renderers.
//
//  WHY THIS IS A CORE AND NOT THREE ADAPTERS. WebAuthn's own data model is binary: a challenge,
//  a user handle and a credential id are byte strings. The three platforms then disagree about
//  how those bytes cross the language boundary — the browser wants BufferSource, Apple wants
//  Data, Android's Credential Manager wants a base64url string inside a JSON document. If each
//  facet did its own conversion, a challenge that round-trips on one platform would be padded,
//  truncated or re-encoded on another, and the server would reject the assertion with no clue
//  why. So base64url is the ONE wire form on the DSX bus, its codec lives here, and the
//  round trip is corpus-pinned (OpenSource/Conformance/passkeys/ceremony.json).
//
//  THE OTHER HALF is the vocabulary: `attestation`, `mediation`, `userVerification` and
//  `residentKey` are closed word sets in the spec, and every platform silently substitutes its
//  own default for a word it does not recognise. Silent substitution in an auth ceremony is how
//  a "passwordless" login quietly stops verifying the user. Here an unknown word is refused.
//
//  WHAT IS DELIBERATELY NOT HERE: any key material, any signature check, any storage. This file
//  validates and shapes a request; the platform performs the ceremony and the developer's own
//  backend verifies the result.
//

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A challenge shorter than this is not a challenge: 16 bytes is the floor every WebAuthn
 *  hardening guide names, and a replayable 4-byte nonce defeats the whole ceremony. */
export const PASSKEY_MIN_CHALLENGE_BYTES = 16;
export const PASSKEY_MAX_CHALLENGE_BYTES = 1024;
/** The spec's own ceiling on a user handle. */
export const PASSKEY_MAX_USER_ID_BYTES = 64;

export const PASSKEY_MIN_TIMEOUT_MS = 15000;
export const PASSKEY_DEFAULT_TIMEOUT_MS = 60000;
export const PASSKEY_MAX_TIMEOUT_MS = 600000;

export const PASSKEY_ATTESTATIONS: readonly string[] = ["none", "indirect", "direct", "enterprise"];
export const PASSKEY_MEDIATIONS: readonly string[] = ["silent", "optional", "conditional", "required"];
export const PASSKEY_VERIFICATIONS: readonly string[] = ["required", "preferred", "discouraged"];
export const PASSKEY_RESIDENT_KEYS: readonly string[] = ["discouraged", "preferred", "required"];

export type PasskeyRefusal =
  | "invalid_rp_id"
  | "invalid_challenge"
  | "invalid_user"
  | "invalid_credential"
  | "unknown_attestation"
  | "unknown_mediation"
  | "unknown_verification"
  | "unknown_resident_key";

export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; error: PasskeyRefusal; detail?: string };

function fail<T>(error: PasskeyRefusal, detail?: string): PasskeyResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

// ── base64url, the one wire form ─────────────────────────────────────────────────────

/** Encode bytes as UNPADDED base64url. Unpadded because the WebAuthn JSON serialisations all
 *  are, and a stray `=` is the most common cause of a server rejecting a valid assertion. */
export function base64UrlEncode(bytes: readonly number[] | Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i]! & 0xff;
    const b1 = i + 1 < n ? bytes[i + 1]! & 0xff : 0;
    const b2 = i + 2 < n ? bytes[i + 2]! & 0xff : 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < n) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < n) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Decode base64url to bytes, or `null` when the text is not base64url.
 *
 * TOLERANT ON INPUT, STRICT ON OUTPUT: standard base64's `+` and `/` are accepted and so is
 * `=` padding, because half the world's servers emit them, but the encoder never produces
 * either. A length that cannot be a base64 group (one leftover character) is `null` rather
 * than a silently truncated buffer.
 */
export function base64UrlDecode(text: unknown): number[] | null {
  if (typeof text !== "string") return null;
  let clean = "";
  for (const c of text) {
    if (c === "=" || c === "\n" || c === "\r" || c === " ") continue;
    if (c === "+") { clean += "-"; continue; }
    if (c === "/") { clean += "_"; continue; }
    if (B64URL_ALPHABET.indexOf(c) < 0) return null;
    clean += c;
  }
  if (clean.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = clean.slice(i, i + 4);
    const v0 = B64URL_ALPHABET.indexOf(chunk[0] ?? "A");
    const v1 = B64URL_ALPHABET.indexOf(chunk[1] ?? "A");
    const v2 = chunk.length > 2 ? B64URL_ALPHABET.indexOf(chunk[2]!) : -1;
    const v3 = chunk.length > 3 ? B64URL_ALPHABET.indexOf(chunk[3]!) : -1;
    out.push(((v0 << 2) | (v1 >> 4)) & 0xff);
    if (v2 >= 0) out.push(((v1 << 4) | (v2 >> 2)) & 0xff);
    if (v3 >= 0) out.push(((v2 << 6) | v3) & 0xff);
  }
  return out;
}

/** How many bytes a base64url string carries, or -1 when it is not base64url. */
export function base64UrlByteLength(text: unknown): number {
  const bytes = base64UrlDecode(text);
  return bytes === null ? -1 : bytes.length;
}

// ── the relying party ────────────────────────────────────────────────────────────────

/**
 * Normalize a relying-party id: a bare registrable domain, lowercase, no scheme, no port, no
 * path. Every one of those is a real mistake developers make, and each produces a ceremony
 * that fails on device with a message about "origin mismatch" that names nothing useful.
 *
 * A single label (`localhost`) is allowed on purpose: it is the only rpId that works in local
 * development, and refusing it would make the module untestable before deployment.
 */
export function normalizeRpId(raw: unknown): PasskeyResult<string> {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text.length === 0) return fail("invalid_rp_id", "an rpId is required");
  if (text.includes("://")) return fail("invalid_rp_id", "an rpId is a domain, not a URL");
  if (text.includes("/") || text.includes("?") || text.includes("#")) {
    return fail("invalid_rp_id", "an rpId carries no path");
  }
  if (text.includes(":")) return fail("invalid_rp_id", "an rpId carries no port");
  if (text.length > 253) return fail("invalid_rp_id", "too long to be a domain");
  for (const label of text.split(".")) {
    if (label.length === 0 || label.length > 63) return fail("invalid_rp_id", "malformed domain label");
    if (label.startsWith("-") || label.endsWith("-")) {
      return fail("invalid_rp_id", "a domain label cannot start or end with a hyphen");
    }
    for (const c of label) {
      const ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-";
      if (!ok) return fail("invalid_rp_id", "a domain label is letters, digits and hyphens");
    }
  }
  return { ok: true, value: text };
}

/** A challenge is base64url and long enough to be unguessable. Both halves matter: a
 *  hex-encoded challenge that happens to decode is still the wrong bytes on the wire. */
export function normalizeChallenge(raw: unknown): PasskeyResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return fail("invalid_challenge", "a challenge is required");
  const length = base64UrlByteLength(text);
  if (length < 0) return fail("invalid_challenge", "a challenge is base64url");
  if (length < PASSKEY_MIN_CHALLENGE_BYTES) {
    return fail("invalid_challenge", `a challenge is at least ${PASSKEY_MIN_CHALLENGE_BYTES} bytes`);
  }
  if (length > PASSKEY_MAX_CHALLENGE_BYTES) {
    return fail("invalid_challenge", `a challenge is at most ${PASSKEY_MAX_CHALLENGE_BYTES} bytes`);
  }
  return { ok: true, value: base64UrlEncode(base64UrlDecode(text)!) };
}

export interface PasskeyUser {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

/** The user handle the authenticator stores. `id` is OPAQUE BYTES and must not be an email or
 *  a username: it is written into the authenticator, syncs to the user's other devices, and can
 *  never be changed. Putting a PII string there is a privacy defect that outlives the account. */
export function normalizeUser(raw: unknown): PasskeyResult<PasskeyUser> {
  if (raw === null || typeof raw !== "object") return fail("invalid_user", "a user object is required");
  const user = raw as { id?: unknown; name?: unknown; displayName?: unknown };
  const id = String(user.id ?? "").trim();
  const length = base64UrlByteLength(id);
  if (length <= 0) return fail("invalid_user", "user.id is base64url bytes, not a username");
  if (length > PASSKEY_MAX_USER_ID_BYTES) {
    return fail("invalid_user", `user.id is at most ${PASSKEY_MAX_USER_ID_BYTES} bytes`);
  }
  const name = String(user.name ?? "").trim();
  if (name.length === 0) return fail("invalid_user", "user.name is what the account picker shows");
  const displayNameRaw = String(user.displayName ?? "").trim();
  return {
    ok: true,
    value: {
      id: base64UrlEncode(base64UrlDecode(id)!),
      name,
      displayName: displayNameRaw.length > 0 ? displayNameRaw : name,
    },
  };
}

function foldWord(
  raw: unknown, vocabulary: readonly string[], fallback: string, refusal: PasskeyRefusal,
): PasskeyResult<string> {
  const text = String(raw ?? "").trim().toLowerCase().replace(/[\s\-_]/g, "");
  if (text.length === 0) return { ok: true, value: fallback };
  for (const word of vocabulary) {
    if (word.toLowerCase() === text) return { ok: true, value: word };
  }
  return fail(refusal, String(raw ?? ""));
}

export function foldAttestation(raw: unknown): PasskeyResult<string> {
  return foldWord(raw, PASSKEY_ATTESTATIONS, "none", "unknown_attestation");
}

export function foldMediation(raw: unknown): PasskeyResult<string> {
  return foldWord(raw, PASSKEY_MEDIATIONS, "optional", "unknown_mediation");
}

export function foldUserVerification(raw: unknown): PasskeyResult<string> {
  return foldWord(raw, PASSKEY_VERIFICATIONS, "preferred", "unknown_verification");
}

export function foldResidentKey(raw: unknown): PasskeyResult<string> {
  return foldWord(raw, PASSKEY_RESIDENT_KEYS, "preferred", "unknown_resident_key");
}

/** Clamp rather than refuse: a caller asking for an hour wants "as long as the platform will
 *  allow", and refusing that is a worse answer than honouring the ceiling. */
export function clampPasskeyTimeout(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PASSKEY_DEFAULT_TIMEOUT_MS;
  if (n < PASSKEY_MIN_TIMEOUT_MS) return PASSKEY_MIN_TIMEOUT_MS;
  if (n > PASSKEY_MAX_TIMEOUT_MS) return PASSKEY_MAX_TIMEOUT_MS;
  return Math.round(n);
}

/** Credential ids named in an allow list. Each must be base64url; an unparseable one is
 *  refused rather than dropped, because a silently shortened allow list reads to the user as
 *  "this device has no passkey" and there is nothing to debug. */
export function normalizeCredentialIds(raw: unknown): PasskeyResult<readonly string[]> {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.length > 0 ? [raw] : [];
  const out: string[] = [];
  for (const entry of list) {
    const text = typeof entry === "string" ? entry.trim() : String((entry as { id?: unknown })?.id ?? "").trim();
    const bytes = base64UrlDecode(text);
    if (bytes === null || bytes.length === 0) return fail("invalid_credential", text);
    const canonical = base64UrlEncode(bytes);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return { ok: true, value: out };
}

export interface PasskeyCreateOptions {
  readonly rpId: string;
  readonly user: PasskeyUser;
  readonly challenge: string;
  readonly attestation: string;
  readonly userVerification: string;
  readonly residentKey: string;
  readonly excludeCredentials: readonly string[];
  readonly timeoutMs: number;
}

export interface PasskeyGetOptions {
  readonly rpId: string;
  readonly challenge: string;
  readonly mediation: string;
  readonly userVerification: string;
  readonly allowCredentials: readonly string[];
  readonly timeoutMs: number;
}

export function normalizeCreateOptions(raw: Record<string, unknown>): PasskeyResult<PasskeyCreateOptions> {
  const rpId = normalizeRpId(raw["rpId"]);
  if (rpId.ok !== true) return fail(rpId.error, rpId.detail);
  const user = normalizeUser(raw["user"]);
  if (user.ok !== true) return fail(user.error, user.detail);
  const challenge = normalizeChallenge(raw["challenge"]);
  if (challenge.ok !== true) return fail(challenge.error, challenge.detail);
  const attestation = foldAttestation(raw["attestation"]);
  if (attestation.ok !== true) return fail(attestation.error, attestation.detail);
  const verification = foldUserVerification(raw["userVerification"]);
  if (verification.ok !== true) return fail(verification.error, verification.detail);
  const residentKey = foldResidentKey(raw["residentKey"]);
  if (residentKey.ok !== true) return fail(residentKey.error, residentKey.detail);
  const exclude = normalizeCredentialIds(raw["exclude"] ?? raw["excludeCredentials"]);
  if (exclude.ok !== true) return fail(exclude.error, exclude.detail);

  return {
    ok: true,
    value: {
      rpId: rpId.value, user: user.value, challenge: challenge.value,
      attestation: attestation.value, userVerification: verification.value,
      residentKey: residentKey.value, excludeCredentials: exclude.value,
      timeoutMs: clampPasskeyTimeout(raw["timeout"]),
    },
  };
}

export function normalizeGetOptions(raw: Record<string, unknown>): PasskeyResult<PasskeyGetOptions> {
  const rpId = normalizeRpId(raw["rpId"]);
  if (rpId.ok !== true) return fail(rpId.error, rpId.detail);
  const challenge = normalizeChallenge(raw["challenge"]);
  if (challenge.ok !== true) return fail(challenge.error, challenge.detail);
  const mediation = foldMediation(raw["mediation"]);
  if (mediation.ok !== true) return fail(mediation.error, mediation.detail);
  const verification = foldUserVerification(raw["userVerification"]);
  if (verification.ok !== true) return fail(verification.error, verification.detail);
  const allow = normalizeCredentialIds(raw["allow"] ?? raw["allowCredentials"]);
  if (allow.ok !== true) return fail(allow.error, allow.detail);

  return {
    ok: true,
    value: {
      rpId: rpId.value, challenge: challenge.value, mediation: mediation.value,
      userVerification: verification.value, allowCredentials: allow.value,
      timeoutMs: clampPasskeyTimeout(raw["timeout"]),
    },
  };
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const PASSKEY_MESSAGES: Readonly<Record<PasskeyRefusal, string>> = {
  invalid_rp_id: "That is not a relying-party domain.",
  invalid_challenge: "That is not a usable challenge.",
  invalid_user: "That is not a usable user handle.",
  invalid_credential: "That is not a base64url credential id.",
  unknown_attestation: "That is not an attestation preference.",
  unknown_mediation: "That is not a mediation mode.",
  unknown_verification: "That is not a user-verification preference.",
  unknown_resident_key: "That is not a resident-key preference.",
};
