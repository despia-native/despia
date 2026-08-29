//
//  auth-proof.ts — THE AUTHENTICATION PROOF PURE CORE (A1,
//  ClosedSource/Documentation/v4-launch/completeness/A1-auth-hardening.md). Two folds, and a
//  login is the one flow where a fail-open default is a compromise:
//
//    1. THE TRIGGER FOLD — `matchesConfiguredTrigger` / `isAllowedAuthorizationUrl`.
//       LoginHelper decides on every main-frame navigation whether the URL about to load is a
//       configured identity provider; a match cancels the app's own navigation and hands the
//       URL to a web view that carries a provider-accepted user agent and SHARES the app's
//       cookie jar. A raw string prefix therefore gives anyone who controls
//       `idp.example.attacker.invalid` a login surface wearing the IdP's clothes. A configured
//       prefix that parses as an absolute URL is pinned to its exact scheme, host and port and
//       refuses userinfo; one that does not parse keeps raw-prefix behaviour, because
//       deployments configure bare host fragments and silently dropping them disables their
//       logins.
//
//    2. THE PROOF FOLD — PKCE (RFC 7636), `state` (RFC 6749 §10.12, RFC 9700 §2.1) and OIDC
//       `nonce`. Which proofs a module owns for a given authorize URL (adopt what the caller
//       wrote, mint what is missing), the exact URL it builds, and the verdict a returning
//       callback earns. `unproven` is the compatibility floor — a flow this module never armed
//       keeps the behaviour it has today, because refusing there breaks working logins to fix
//       nothing. Everything else refuses, and a refusal never resolves and never echoes the
//       received value back: that value is attacker-controlled and a message is a log line.
//
//  The law is the corpus, OpenSource/Conformance/auth/{trigger,pkce}.json; the Kotlin twin is
//  :core AuthProof.kt and the Swift twin is Engine/iOS/AuthProof.swift.
//
//  NOTHING here hashes and nothing here draws entropy. RFC 7636's S256 is
//  BASE64URL-ENCODE(SHA256(ASCII(verifier))): the SHA-256 half is the platform's job
//  (CryptoKit / MessageDigest / WebCrypto), exactly as crypto-core.ts says, and the CSPRNG
//  behind a minted value is the platform's too. What lives here is the half that has no
//  platform answer and would therefore drift — an ABNF, an alphabet, a dropped padding
//  character, a URL parse, and a verdict — which is also what makes a login proof testable
//  without an identity provider.
//
//  PURE by construction: no DOM, no URL, no RegExp on any security decision, no imports. The
//  URL splitter is hand-rolled precisely BECAUSE three platform URL parsers disagree about
//  userinfo, backslashes and percent-escaped hosts, and a security fold cannot be the union of
//  three parsers' bugs.
//

// ─────────────────────────────────────────────────────────────────────────────
// 0 · The hand-rolled absolute-URL split — one parser, three runtimes
// ─────────────────────────────────────────────────────────────────────────────

/** An absolute URL's origin parts. `port` is -1 when none was written; `hasUserInfo` is kept
 *  rather than the userinfo itself, because nothing here has any business reading it. */
export type UrlOrigin = Readonly<{
  scheme: string;
  host: string;
  port: number;
  hasUserInfo: boolean;
}>;

function isDigit(ch: string): boolean { return ch >= "0" && ch <= "9"; }
function isAlpha(ch: string): boolean { return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"); }

/** Characters that must never appear inside an authority. A backslash is the whole reason this
 *  list exists: some parsers normalize `\` to `/`, some do not, and `https://idp.example\@evil`
 *  therefore means two different hosts on two renderers. Anything ambiguous is refused, never
 *  guessed — the cost of a false refusal here is a login that is not intercepted, which is the
 *  behaviour the navigation already had. */
function authorityIsClean(authority: string): boolean {
  for (const ch of authority) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c === 0x7f) return false;
    if (ch === "\\" || ch === "<" || ch === ">" || ch === '"' || ch === "^" ||
        ch === "{" || ch === "}" || ch === "|" || ch === "`") return false;
  }
  return true;
}

/** Split an absolute `scheme://authority…` URL into its origin, or null when it is not one or
 *  is not unambiguous. A percent escape in the host is refused rather than decoded: `%2e` is a
 *  dot to some parsers and a literal to others, and either answer is a lookalike host. */
export function splitOrigin(raw: string | null | undefined): UrlOrigin | null {
  const text = String(raw ?? "");
  if (text.length === 0) return null;

  let i = 0;
  if (!isAlpha(text[0]!)) return null;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ":") break;
    if (!isAlpha(ch) && !isDigit(ch) && ch !== "+" && ch !== "-" && ch !== ".") return null;
    i += 1;
  }
  if (i >= text.length || text[i] !== ":") return null;
  const scheme = text.slice(0, i).toLowerCase();
  if (!text.startsWith("://", i)) return null;

  let end = i + 3;
  while (end < text.length) {
    const ch = text[end]!;
    if (ch === "/" || ch === "?" || ch === "#") break;
    end += 1;
  }
  const authority = text.slice(i + 3, end);
  if (!authorityIsClean(authority)) return null;

  const at = authority.lastIndexOf("@");
  const hasUserInfo = at >= 0;
  const hostPort = hasUserInfo ? authority.slice(at + 1) : authority;

  let host = hostPort;
  let port = -1;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return null;
    host = hostPort.slice(0, close + 1);
    const rest = hostPort.slice(close + 1);
    if (rest.length > 0) {
      if (rest[0] !== ":") return null;
      const digits = rest.slice(1);
      if (digits.length === 0) return null;
      for (const ch of digits) if (!isDigit(ch)) return null;
      port = Number(digits);
    }
  } else {
    const colon = hostPort.indexOf(":");
    if (colon >= 0) {
      host = hostPort.slice(0, colon);
      const digits = hostPort.slice(colon + 1);
      if (digits.length === 0) return null;
      for (const ch of digits) if (!isDigit(ch)) return null;
      port = Number(digits);
    }
  }
  if (host.length === 0) return null;
  for (const ch of host) if (ch === "%" || ch === ":" || ch === "@") return null;

  return { scheme, host: host.toLowerCase(), port, hasUserInfo };
}

/** Does this text CLAIM a URI scheme, whether or not it parses into an origin? The distinction
 *  matters exactly once, and it is a security decision: `https://` and `javascript:alert` both
 *  claim a scheme and neither yields an origin, so treating either as a legacy raw prefix would
 *  make the first match every https URL there is and the second hand a script URL to a login
 *  surface. A claim that does not parse is refused; only text that never claimed is legacy. */
export function claimsUriScheme(raw: string | null | undefined): boolean {
  const text = String(raw ?? "");
  if (text.length === 0 || !isAlpha(text[0]!)) return false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ":") return true;
    if (!isAlpha(ch) && !isDigit(ch) && ch !== "+" && ch !== "-" && ch !== ".") return false;
    i += 1;
  }
  return false;
}

/** The port an origin comparison uses: the written one, else the scheme's default, else -1 so
 *  two custom-scheme origins still compare equal to each other. */
export function normalizedPort(origin: UrlOrigin): number {
  if (origin.port >= 0) return origin.port;
  if (origin.scheme === "https") return 443;
  if (origin.scheme === "http") return 80;
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · THE TRIGGER FOLD — a configured login trigger is an origin, not a prefix
// ─────────────────────────────────────────────────────────────────────────────

/** Does `candidate` belong to the identity provider configured as `configuredPrefix`?
 *
 *  The raw prefix is NECESSARY, never sufficient: it runs first so nothing that already failed
 *  the legacy test starts matching, and an absolute prefix then additionally pins scheme, host
 *  and port and refuses userinfo. Case is deliberately not folded on the prefix test — an
 *  uppercase host that fails the byte prefix simply is not intercepted, which is the direction
 *  that costs nothing. */
export function matchesConfiguredTrigger(candidate: string | null | undefined,
                                         configuredPrefix: string | null | undefined): boolean {
  const prefix = String(configuredPrefix ?? "");
  const target = String(candidate ?? "");
  if (prefix.length === 0 || !target.startsWith(prefix)) return false;

  const trigger = splitOrigin(prefix);
  if (trigger === null) return !claimsUriScheme(prefix);   // legacy non-URL prefix configuration
  const actual = splitOrigin(target);
  if (actual === null) return false;

  return actual.scheme === trigger.scheme &&
    actual.host === trigger.host &&
    normalizedPort(actual) === normalizedPort(trigger) &&
    !actual.hasUserInfo;
}

/** May this URL be handed to a browser as an authorization START? Confidential transport, a
 *  real host, and no URL credentials: a `javascript:` / `intent:` / `file:` authorization start
 *  is not an authorization start, and userinfo in an authorization URL is a phishing primitive
 *  some browsers still render. */
export function isAllowedAuthorizationUrl(raw: string | null | undefined): boolean {
  const origin = splitOrigin(raw);
  if (origin === null) return false;
  return origin.scheme === "https" && origin.host.length > 0 && !origin.hasUserInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · THE PROOF FOLD — base64url, the verifier ABNF, the S256 challenge
// ─────────────────────────────────────────────────────────────────────────────

/** RFC 7636 §4.1: code-verifier = 43*128unreserved. */
export const PKCE_VERIFIER_MIN_LENGTH = 43;
export const PKCE_VERIFIER_MAX_LENGTH = 128;

/** RFC 7636 §7.1: "a minimum of 256 bits of entropy… a 32-octet sequence". 32 octets
 *  base64url-encode to exactly 43 characters, which is also the ABNF floor — the two
 *  constraints meet, which is why 32 is the number and not a taste. */
export const PKCE_VERIFIER_ENTROPY_BYTES = 32;

/** `state` and `nonce` are unguessability tokens, not key material; 128 bits is the floor. */
export const AUTH_PROOF_ENTROPY_BYTES = 16;

/** The only challenge method this core will build. RFC 7636 §4.2 makes S256 mandatory to
 *  implement on the server, and `plain` exists only for clients that cannot hash — which
 *  describes no platform this runs on. */
export const PKCE_CHALLENGE_METHOD = "S256";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 §5 with "all trailing '=' characters omitted" (RFC 7636 §A). One encoder serves the
 *  verifier, the challenge, `state` and `nonce`, so a padding character can never appear in any
 *  of them. Octets are read unsigned so no runtime has to agree about signed bytes first. */
export function base64UrlNoPad(bytes: readonly number[] | Uint8Array): string {
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i + 2 < n) {
    const a = bytes[i]! & 0xff, b = bytes[i + 1]! & 0xff, c = bytes[i + 2]! & 0xff;
    out += B64URL[a >> 2]! + B64URL[((a & 0x03) << 4) | (b >> 4)]! +
           B64URL[((b & 0x0f) << 2) | (c >> 6)]! + B64URL[c & 0x3f]!;
    i += 3;
  }
  const left = n - i;
  if (left === 1) {
    const a = bytes[i]! & 0xff;
    out += B64URL[a >> 2]! + B64URL[(a & 0x03) << 4]!;
  } else if (left === 2) {
    const a = bytes[i]! & 0xff, b = bytes[i + 1]! & 0xff;
    out += B64URL[a >> 2]! + B64URL[((a & 0x03) << 4) | (b >> 4)]! + B64URL[(b & 0x0f) << 2]!;
  }
  return out;
}

/** RFC 4648 §5 the other way, to UTF-8 text. Refuses padding, refuses an alphabet outside
 *  base64url, refuses the impossible residue of one, and refuses bytes that are not UTF-8 —
 *  every one of those is a malformed token rather than something to salvage. */
export function base64UrlDecodeUtf8(segment: string | null | undefined): string | null {
  const text = String(segment ?? "");
  if (text.length === 0 || text.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

/** A hand-rolled UTF-8 decode: `TextDecoder` substitutes U+FFFD for malformed input on the web
 *  and the JVM does something else again, so a shared fold cannot delegate. Overlong forms,
 *  surrogates and out-of-range scalars are refusals, not replacements. */
function utf8Decode(bytes: readonly number[]): string | null {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp = 0;
    let extra = 0;
    let min = 0;
    if (b0 < 0x80) { cp = b0; extra = 0; min = 0; }
    else if (b0 >= 0xc2 && b0 <= 0xdf) { cp = b0 & 0x1f; extra = 1; min = 0x80; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { cp = b0 & 0x0f; extra = 2; min = 0x800; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { cp = b0 & 0x07; extra = 3; min = 0x10000; }
    else return null;
    if (i + extra >= bytes.length) return null;
    for (let k = 1; k <= extra; k += 1) {
      const b = bytes[i + k]!;
      if (b < 0x80 || b > 0xbf) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min) return null;
    if (cp > 0x10ffff) return null;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    out += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return out;
}

/** RFC 7636 §4.1 verbatim: 43*128 of ALPHA / DIGIT / "-" / "." / "_" / "~". No trimming, no
 *  case folding — a verifier is compared byte for byte at the token endpoint, so a fold that
 *  accepts what the server will not is a login that dies there with a useless message. */
export function isCodeVerifier(value: string | null | undefined): boolean {
  const text = String(value ?? "");
  if (text.length < PKCE_VERIFIER_MIN_LENGTH || text.length > PKCE_VERIFIER_MAX_LENGTH) return false;
  for (const ch of text) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) continue;
    if (ch === "-" || ch === "." || ch === "_" || ch === "~") continue;
    return false;
  }
  return true;
}

/** A verifier from platform entropy, or null when there is not enough of it. Expressed as a
 *  refusal rather than a short value on purpose: a silently-padded verifier is a weak one that
 *  still works, which is the failure nobody finds. */
export function codeVerifierFromEntropy(bytes: readonly number[] | Uint8Array): string | null {
  if (bytes.length < PKCE_VERIFIER_ENTROPY_BYTES) return null;
  return base64UrlNoPad(bytes);
}

/** A `state` or `nonce` from platform entropy, or null when there is not enough of it. */
export function opaqueProof(bytes: readonly number[] | Uint8Array): string | null {
  if (bytes.length < AUTH_PROOF_ENTROPY_BYTES) return null;
  return base64UrlNoPad(bytes);
}

/** RFC 7636 §4.2: code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))). The digest
 *  arrives already computed, because hashing is the platform's. A digest of any other length is
 *  refused rather than encoded: a short one produces a challenge the server accepts and no
 *  verifier can ever satisfy, which strands every login on that build. */
export function codeChallengeS256(digest: readonly number[] | Uint8Array): string | null {
  if (digest.length !== 32) return null;
  return base64UrlNoPad(digest);
}

/** Every proof comparison runs through here. No early return on the first differing byte and
 *  none on a length difference: both lengths and every position fold into one accumulator, so a
 *  wrong `state` costs the same time as a right one. */
export function constantTimeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "");
  const right = String(b ?? "");
  let diff = left.length ^ right.length;
  const span = left.length > right.length ? left.length : right.length;
  for (let i = 0; i < span; i += 1) {
    const l = i < left.length ? left.charCodeAt(i) : 0;
    const r = i < right.length ? right.charCodeAt(i) : 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · THE PROOF PLAN — adopt what the caller wrote, mint what is missing
// ─────────────────────────────────────────────────────────────────────────────

export type AuthProofRefusal = "pkce_unsupported";

export type AuthorizeProofPlan = Readonly<{
  /** null when the plan stands; a declared refusal code otherwise, and then nothing is minted. */
  refusal: AuthProofRefusal | null;
  mintState: boolean;
  /** The caller's own `state`, adopted verbatim, or null when the module mints one. */
  adoptedState: string | null;
  mintNonce: boolean;
  adoptedNonce: string | null;
  mintPkce: boolean;
}>;

/** Percent-decode a query value the way a form-encoded query is read: `+` is a space, `%XX` is
 *  a byte, an incomplete escape is left literal rather than dropped. The authorization server
 *  echoes `state` back through this same encoding, so adopting it decoded is what makes the
 *  later comparison compare the same two things. */
function decodeQueryValue(raw: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "+") { bytes.push(0x20); i += 1; continue; }
    if (ch === "%" && i + 2 < raw.length) {
      const hi = hexValue(raw[i + 1]!);
      const lo = hexValue(raw[i + 2]!);
      if (hi >= 0 && lo >= 0) { bytes.push((hi << 4) | lo); i += 3; continue; }
    }
    for (const b of utf8Encode(ch)) bytes.push(b);
    i += 1;
  }
  return utf8Decode(bytes) ?? "";
}

function hexValue(ch: string): number {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "a" && ch <= "f") return ch.charCodeAt(0) - 87;
  if (ch >= "A" && ch <= "F") return ch.charCodeAt(0) - 55;
  return -1;
}

function utf8Encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

/** The query string of a URL: everything between the first `?` and the first `#` after it. */
function queryOf(url: string): string {
  const hash = url.indexOf("#");
  const stop = hash < 0 ? url.length : hash;
  const q = url.indexOf("?");
  if (q < 0 || q > stop) return "";
  return url.slice(q + 1, stop);
}

/** The first value of `name` in a form-encoded query, decoded, or null. An empty value is null:
 *  `state=` is not a state, it is a caller who built the parameter and forgot the value. */
function queryValue(query: string, name: string): string | null {
  let i = 0;
  while (i <= query.length) {
    let end = query.indexOf("&", i);
    if (end < 0) end = query.length;
    const pair = query.slice(i, end);
    i = end + 1;
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = decodeQueryValue(eq < 0 ? pair : pair.slice(0, eq));
    if (key !== name) continue;
    if (eq < 0) return null;
    const value = decodeQueryValue(pair.slice(eq + 1));
    return value.length === 0 ? null : value;
  }
  return null;
}

/** Does a space-separated `response_type` carry `token` (bare) as a token? */
function responseTypeHas(responseType: string | null, token: string): boolean {
  if (responseType === null) return false;
  for (const part of responseType.split(" ")) {
    if (part.toLowerCase() === token) return true;
  }
  return false;
}

/** Which proofs this module owns for `authorizeUrl`.
 *
 *  A parameter already in the URL is ADOPTED — the caller built it, the module verifies what
 *  comes back — and one that is absent is MINTED. That is what makes this non-breaking: every
 *  integration shipped against the old contract keeps the exact authorize URL it built, plus a
 *  `state` it did not have to write.
 *
 *  `nonce` is owned only for an OIDC request (`scope` contains `openid`, or `response_type`
 *  contains `id_token`): minting one onto a plain OAuth request is noise, and RFC 9700 §2.1
 *  says PKCE carries the same protection.
 *
 *  PKCE is OPT-IN, and that is the load-bearing decision. A module-minted verifier is one the
 *  module must also redeem, so appending `code_challenge` to a flow whose token exchange the
 *  CALLER performs breaks that exchange at the authorization server — a worse failure than the
 *  one being fixed, and one that would land on every shipped integration at once. */
export function planAuthorizeProofs(authorizeUrl: string | null | undefined,
                                    wantsPkce: boolean): AuthorizeProofPlan {
  const query = queryOf(String(authorizeUrl ?? ""));
  const state = queryValue(query, "state");
  const nonce = queryValue(query, "nonce");
  const challenge = queryValue(query, "code_challenge");
  const responseType = queryValue(query, "response_type");
  const scope = queryValue(query, "scope");

  const isCodeFlow = responseTypeHas(responseType, "code");
  if (wantsPkce && (challenge !== null || !isCodeFlow)) {
    return {
      refusal: "pkce_unsupported",
      mintState: false, adoptedState: null, mintNonce: false, adoptedNonce: null, mintPkce: false,
    };
  }

  const oidc = responseTypeHas(responseType, "id_token") ||
    (scope !== null && scope.split(" ").some((s) => s.toLowerCase() === "openid"));

  return {
    refusal: null,
    mintState: state === null,
    adoptedState: state,
    mintNonce: oidc && nonce === null,
    adoptedNonce: nonce,
    mintPkce: wantsPkce,
  };
}

export type MintedProofs = Readonly<{
  state?: string | null;
  nonce?: string | null;
  challenge?: string | null;
}>;

/** Percent-escape everything outside RFC 3986's unreserved set. Minted values are base64url and
 *  pass through untouched; the escaping exists so a value that came from somewhere else can
 *  never break out of its parameter. */
function encodeQueryValue(value: string): string {
  let out = "";
  for (const b of utf8Encode(value)) {
    const ch = String.fromCharCode(b);
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") ||
        ch === "-" || ch === "." || ch === "_" || ch === "~") {
      out += ch;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** The authorize URL with the minted parameters appended, in a fixed order so three runtimes
 *  build the same string. Appending, never rewriting: the caller's URL is reproduced byte for
 *  byte. A fragment stays last, because a query appended after a fragment is not a query. */
export function applyAuthorizeProofs(authorizeUrl: string | null | undefined,
                                     minted: MintedProofs): string {
  const url = String(authorizeUrl ?? "");
  const pairs: string[] = [];
  if (minted.state !== undefined && minted.state !== null && minted.state.length > 0) {
    pairs.push("state=" + encodeQueryValue(minted.state));
  }
  if (minted.nonce !== undefined && minted.nonce !== null && minted.nonce.length > 0) {
    pairs.push("nonce=" + encodeQueryValue(minted.nonce));
  }
  if (minted.challenge !== undefined && minted.challenge !== null && minted.challenge.length > 0) {
    pairs.push("code_challenge=" + encodeQueryValue(minted.challenge));
    pairs.push("code_challenge_method=" + PKCE_CHALLENGE_METHOD);
  }
  if (pairs.length === 0) return url;

  const hash = url.indexOf("#");
  const head = hash < 0 ? url : url.slice(0, hash);
  const tail = hash < 0 ? "" : url.slice(hash);
  const q = head.indexOf("?");
  const joiner = q < 0 ? "?" : (head.endsWith("?") || head.endsWith("&") ? "" : "&");
  return head + joiner + pairs.join("&") + tail;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · THE CALLBACK VERDICT — the only place a callback becomes deliverable
// ─────────────────────────────────────────────────────────────────────────────

export type CallbackVerdict =
  | "ok"              // proven, or nothing to prove and nothing suspicious
  | "unproven"        // this module armed no expectation — the compatibility floor
  | "missing_state"   // an armed flow whose callback carries no state
  | "state_mismatch"  // an armed flow whose callback carries the wrong state
  | "replayed"        // a state this module already consumed, coming back again
  | "nonce_mismatch"; // the state proved out, the returned id_token's nonce did not

/** The verdict a returning callback earns.
 *
 *  `unproven` is the compatibility floor and is deliberately permissive: a cold start after the
 *  process died behind the browser, or a deep link that is not a callback at all, has no armed
 *  expectation, and refusing there would break working logins to fix nothing.
 *
 *  `replayed` exists because clearing the expectation on success is not enough. A one-shot
 *  authorization code replayed a second later would otherwise land in the `unproven` arm and be
 *  delivered, which is the exact attack `state` is there to stop. */
export function verifyCallbackProofs(expectedState: string | null | undefined,
                                     consumedStates: readonly string[],
                                     receivedState: string | null | undefined,
                                     expectedNonce?: string | null,
                                     idTokenNonce?: string | null): CallbackVerdict {
  const expected = expectedState === undefined || expectedState === null || expectedState.length === 0
    ? null : expectedState;
  const received = receivedState === undefined || receivedState === null || receivedState.length === 0
    ? null : receivedState;

  if (expected === null) {
    if (received !== null) {
      for (const seen of consumedStates) {
        if (constantTimeEquals(seen, received)) return "replayed";
      }
    }
    return "unproven";
  }
  if (received === null) return "missing_state";
  if (!constantTimeEquals(expected, received)) return "state_mismatch";

  const wantNonce = expectedNonce === undefined || expectedNonce === null || expectedNonce.length === 0
    ? null : expectedNonce;
  if (wantNonce === null) return "ok";
  // No id_token in this callback means the nonce rides the token exchange instead; an id_token
  // that carries no nonce claim at all, against an armed nonce, is the injection this refuses.
  if (idTokenNonce === undefined || idTokenNonce === null) return "ok";
  return constantTimeEquals(wantNonce, idTokenNonce) ? "ok" : "nonce_mismatch";
}

/** A JWT's middle segment, base64url-decoded to UTF-8, and nothing else. The signature is NOT
 *  checked and the result has exactly one use: REFUSING a callback whose nonce does not match.
 *  It never makes a token valid, and reading the claim out of the returned JSON is each
 *  renderer's own parser — which is why this stops at the decoded string. */
export function idTokenPayload(jwt: string | null | undefined): string | null {
  const text = String(jwt ?? "");
  const first = text.indexOf(".");
  if (first < 0) return null;
  const second = text.indexOf(".", first + 1);
  if (second < 0) return null;
  if (text.indexOf(".", second + 1) >= 0) return null;
  return base64UrlDecodeUtf8(text.slice(first + 1, second));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 · THE VERIFIER RELEASE BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

/** May a module-minted verifier be sent to this token endpoint?
 *
 *  The verifier is the one secret this core's consumer holds, and the token exchange is the
 *  only path that sends it anywhere. The destination is therefore not the caller's to choose
 *  freely: it must be an https origin the APP declared in config. An empty declaration allows
 *  nothing, so a build that never opted in cannot leak a verifier at all — the fail-closed
 *  direction, and the reason this is an allowlist rather than a shape check. */
export function tokenEndpointAllowed(tokenUrl: string | null | undefined,
                                     declaredOrigins: readonly string[]): boolean {
  const target = splitOrigin(tokenUrl);
  if (target === null || target.scheme !== "https" || target.hasUserInfo) return false;
  for (const declared of declaredOrigins) {
    const origin = splitOrigin(declared);
    if (origin === null || origin.scheme !== "https") continue;
    if (origin.host === target.host && normalizedPort(origin) === normalizedPort(target)) return true;
  }
  return false;
}
