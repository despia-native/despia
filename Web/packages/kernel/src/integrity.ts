//
//  integrity.ts — the SHARED PURE CORE behind Core/Integrity (F17.4): what a server-verifiable
//  attestation REQUEST and ENVELOPE are, decided once and run identically by all three
//  renderers.
//
//  WHAT THIS CAPABILITY ACTUALLY IS. Mandatory/Security answers "does this device look
//  tampered with?", which a determined attacker simply lies about, because the code asking the
//  question runs on the machine being questioned. App Attest and Play Integrity answer a
//  DIFFERENT question: they hand back a token that the DEVELOPER'S BACKEND can verify with
//  Apple or Google, so the trust anchor is off-device. Those are not the same claim and this
//  module never blurs them.
//
//  THEREFORE THERE IS NO CLIENT-SIDE VERDICT, and this file contains no function that could be
//  mistaken for one. What it does contain is the ENVELOPE: the exact JSON shape a backend
//  receives, identical on both platforms, so a server can be written once against a stable
//  contract instead of sniffing which mobile OS sent the request.
//
//  The base64url codec is shared with passkeys.ts rather than reimplemented: the kernel is one
//  unit, both capabilities put server-bound bytes on the same bus, and two codecs that agree
//  today are two codecs that drift.
//
//  Pinned by OpenSource/Conformance/integrity/attestation.json.
//

import { base64UrlDecode, base64UrlEncode } from "./passkeys.ts";

/** Who can vouch for this app, per platform. `none` is a first-class answer, not an error. */
export const INTEGRITY_PROVIDERS: readonly string[] = ["appattest", "playintegrity", "none"];

/** The token formats a backend must be able to tell apart. The provider alone is not enough:
 *  App Attest issues two shapes for two different ceremonies, and a server that treats an
 *  assertion as an attestation fails verification with an opaque error. */
export const INTEGRITY_FORMATS: readonly string[] = [
  "apple.attest", "apple.assert", "google.playintegrity",
];

/** Play Integrity's nonce ceiling is the binding constraint across both platforms: Apple hashes
 *  the challenge so any length works there, Google refuses above 500 bytes. One rule, so a
 *  challenge that works on one platform cannot fail on the other. */
export const INTEGRITY_MIN_CHALLENGE_BYTES = 16;
export const INTEGRITY_MAX_CHALLENGE_BYTES = 500;

/** A key reference is an opaque platform handle; the cap is a sanity bound, not a spec value. */
export const INTEGRITY_MAX_KEY_REF_CHARS = 512;

/**
 * The sentence every caller gets back with a token, and the reason `verdict` exists at all.
 * Enforcing an attestation result on the device that produced it is theatre, and a developer
 * who believes otherwise ships an app that a five-line patch defeats. Saying so in the payload
 * is cheaper than saying it in documentation nobody reads.
 */
export const INTEGRITY_ADVISORY =
  "This token is only meaningful once your backend verifies it with Apple or Google. Nothing decided on the device is a security decision.";

export type IntegrityRefusal =
  | "invalid_challenge"
  | "invalid_key_ref"
  | "unknown_provider"
  | "unknown_format";

export type IntegrityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IntegrityRefusal; detail?: string };

function fail<T>(error: IntegrityRefusal, detail?: string): IntegrityResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

/** Which attestation service, if any, can vouch for this app on a given platform. */
export function integrityProviderFor(platform: unknown): string {
  const name = String(platform ?? "").trim().toLowerCase();
  if (name === "ios" || name === "ipados" || name === "macos" || name === "tvos" || name === "watchos") {
    return "appattest";
  }
  if (name === "android") return "playintegrity";
  return "none";
}

/** The format word for a provider and a ceremony kind. Refuses rather than guessing, because a
 *  backend that receives the wrong word fails verification with an opaque platform error. */
export function integrityFormat(provider: unknown, kind: unknown): IntegrityResult<string> {
  const p = String(provider ?? "").trim().toLowerCase();
  const k = String(kind ?? "").trim().toLowerCase();
  if (p === "appattest" && k === "attest") return { ok: true, value: "apple.attest" };
  if (p === "appattest" && k === "assert") return { ok: true, value: "apple.assert" };
  if (p === "playintegrity" && (k === "attest" || k === "assert")) {
    // Play Integrity draws no attest/assert distinction: one request, one token, every time.
    return { ok: true, value: "google.playintegrity" };
  }
  if (p !== "appattest" && p !== "playintegrity") return fail("unknown_provider", p);
  return fail("unknown_format", `${p}/${k}`);
}

/**
 * A challenge is base64url and long enough to be unguessable, with ONE length rule across both
 * platforms (see INTEGRITY_MAX_CHALLENGE_BYTES). A challenge the client invented is worthless:
 * it must come from the server that will later verify the token, which is why there is no
 * "generate a challenge" function anywhere in this module.
 */
export function normalizeIntegrityChallenge(raw: unknown): IntegrityResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return fail("invalid_challenge", "a challenge is required");
  const bytes = base64UrlDecode(text);
  if (bytes === null) return fail("invalid_challenge", "a challenge is base64url");
  if (bytes.length < INTEGRITY_MIN_CHALLENGE_BYTES) {
    return fail("invalid_challenge", `a challenge is at least ${INTEGRITY_MIN_CHALLENGE_BYTES} bytes`);
  }
  if (bytes.length > INTEGRITY_MAX_CHALLENGE_BYTES) {
    return fail("invalid_challenge", `a challenge is at most ${INTEGRITY_MAX_CHALLENGE_BYTES} bytes`);
  }
  return { ok: true, value: base64UrlEncode(bytes) };
}

/** The handle `attest` produced and `assert` needs back. Opaque: its INTERNAL shape is Apple's
 *  business, so only emptiness and absurd length are refused. */
export function normalizeKeyRef(raw: unknown): IntegrityResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return fail("invalid_key_ref", "a key reference is required");
  if (text.length > INTEGRITY_MAX_KEY_REF_CHARS) {
    return fail("invalid_key_ref", `a key reference is at most ${INTEGRITY_MAX_KEY_REF_CHARS} characters`);
  }
  for (const c of text) {
    const ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
      || c === "-" || c === "_" || c === "+" || c === "/" || c === "=";
    if (!ok) return fail("invalid_key_ref", "a key reference is a base64 handle");
  }
  return { ok: true, value: text };
}

export interface IntegrityEnvelope {
  readonly provider: string;
  readonly format: string;
  readonly token: string;
  readonly challenge: string;
  readonly keyRef: string;
  readonly advisory: string;
}

/**
 * Build the payload the backend receives. THE SHAPE IS THE PRODUCT: a server written against
 * this envelope does not care which mobile OS sent the request, because `format` tells it which
 * verification call to make and every field is present on both platforms (empty where a
 * platform has no such thing, never absent). A field that is sometimes missing is a server
 * branch nobody remembers to write.
 */
export function integrityEnvelope(
  provider: unknown, kind: unknown, token: unknown, challenge: string, keyRef: string,
): IntegrityResult<IntegrityEnvelope> {
  const format = integrityFormat(provider, kind);
  if (format.ok !== true) return fail(format.error, format.detail);
  return {
    ok: true,
    value: {
      provider: String(provider ?? "").trim().toLowerCase(),
      format: format.value,
      token: String(token ?? ""),
      challenge,
      keyRef,
      advisory: INTEGRITY_ADVISORY,
    },
  };
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const INTEGRITY_MESSAGES: Readonly<Record<IntegrityRefusal, string>> = {
  invalid_challenge: "That is not a usable attestation challenge.",
  invalid_key_ref: "That is not a usable key reference.",
  unknown_provider: "That is not an attestation provider this platform has.",
  unknown_format: "That is not a ceremony this provider performs.",
};
