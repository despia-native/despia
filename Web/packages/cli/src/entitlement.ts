//
//  entitlement.ts — minting `despia-entitlement.json`, the perpetual per-app licence.
//
//  THE FOURTH IMPLEMENTATION OF ONE RULE, and that is the whole risk. `sign_entitlement.rb`
//  mints, `LicenseCheck/swift/Entitlement.swift` verifies on iOS, `LicenseCheck/kotlin/
//  Entitlement.kt` verifies on Android, and this signs from the toolchain. The signature covers
//  CANONICAL BYTES, so if any one of the four renders those bytes differently by a single
//  character, every signature it produces fails everywhere else — and the failure looks like
//  piracy rather than a bug: a paying customer sees the watermark on one platform and not the
//  other. `entitlement_native_parity_test.rb` executes all four over one corpus for that reason;
//  a unit test here would only prove this file agrees with itself.
//
//  THE KEY NEVER TOUCHES THE SERVER. An entitlement verifies offline, forever, in every shipped
//  app, so a leaked signing key mints licences for every app and every version with no
//  revocation anyone can reach — strictly worse than a leaked database. The platform records the
//  CLAIMS at purchase and publishes them on an internal route; this signs them where the key
//  actually lives and hands the signature back.
//

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export class EntitlementError extends Error {}

/** The claim set, before or after signing. */
export interface EntitlementClaims {
  appId: string;
  issued: string;
  licenseId: string;
  majorVersion: number;
  platform: string;
  variants: string[];
  signature?: string;
}

export const PLATFORMS = ["ios", "android"] as const;

/**
 * The documented child-suffix set. TestFlight and internal-track builds ship as RELEASE builds
 * under a child id, so exact-match-only would watermark a developer's own staging app. A suffix
 * is strictly a child namespace and can never reach another customer's identifier.
 */
export const VARIANT_SUFFIXES = [".dev", ".staging", ".beta", ".internal", ".debug"] as const;

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * THE EXACT BYTES THE SIGNATURE COVERS. Every verifier must reproduce this character for
 * character.
 *
 * Top-level keys sorted, `signature` excluded, compact separators, nothing else touched — array
 * order is preserved (it is data, not a key set) and nested objects are left alone, because the
 * Ruby only sorts the top level and a "tidier" rule here would be a silent divergence. Ruby's
 * `JSON.generate` and JS's `JSON.stringify` agree on the rest: no spaces, non-ASCII emitted as
 * raw UTF-8 rather than escaped, `"` and `\` escaped, control characters as the short forms.
 */
export function canonicalBytes(claims: EntitlementClaims | Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(claims).filter((k) => k !== "signature").sort()) {
    body[key] = (claims as Record<string, unknown>)[key];
  }
  return JSON.stringify(body);
}

export interface BuildInput {
  app: string;
  platform: string;
  major: number;
  variants?: string[];
  licenseId: string;
  issued: string;
}

/**
 * The claim set, validated. `licenseId` and `issued` are REQUIRED here, unlike in the Ruby CLI
 * which may mint them: this signer works from claims a purchase already recorded, and inventing
 * either would produce a file that disagrees with the row it was signed for.
 */
export function buildClaims(input: BuildInput): EntitlementClaims {
  if (!APP_ID.test(input.app)) throw new EntitlementError(`"${input.app}" is not a package identifier`);
  if (!(PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new EntitlementError(`platform must be one of ${PLATFORMS.join(", ")}`);
  }
  if (!Number.isInteger(input.major) || input.major <= 0) {
    throw new EntitlementError("major version must be a positive integer");
  }
  const variants = input.variants ?? [];
  for (const variant of variants) {
    if (!APP_ID.test(variant)) throw new EntitlementError(`variant "${variant}" is not a package identifier`);
  }
  if (input.licenseId === "") throw new EntitlementError("a licence id is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issued)) throw new EntitlementError("issued must be a YYYY-MM-DD date");
  // Insertion order is irrelevant to the signature (canonicalBytes sorts), but matching the
  // Ruby's order keeps a hand-diff of two files readable.
  return {
    appId: input.app,
    issued: input.issued,
    licenseId: input.licenseId,
    majorVersion: input.major,
    platform: input.platform,
    variants,
  };
}

/** Sign the claims with a PEM Ed25519 private key, returning the claims plus `signature`. */
export function signClaims(claims: EntitlementClaims, privateKeyPem: string): EntitlementClaims {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new EntitlementError("the signing key is not a readable PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new EntitlementError(`the signing key is ${key.asymmetricKeyType ?? "unknown"}, not ed25519`);
  }
  const signature = cryptoSign(null, Buffer.from(canonicalBytes(claims), "utf8"), key);
  return { ...claims, signature: signature.toString("base64") };
}

/**
 * Does the signed appId cover the identifier the app actually runs under?
 *
 * Takes the minimal shape rather than the full claim set, because `licence.ts` asks the same
 * question of a file it read off disk (where every field is optional until validated) and the
 * answer must not depend on which struct the caller happens to hold. This is the ONLY copy of
 * the rule in the toolchain: it used to exist here and in licence.ts, which is two chances for
 * the suffix list to drift and one of them silently letting an unlicensed build export.
 */
export function coversApp(claims: { appId?: string; variants?: string[] }, liveAppId: string): boolean {
  if (claims.appId === liveAppId) return true;
  if ((claims.variants ?? []).includes(liveAppId)) return true;
  return VARIANT_SUFFIXES.some((suffix) => liveAppId === `${claims.appId}${suffix}`);
}

/**
 * The complete rule, as the device applies it. Returned rather than thrown, and the reason is
 * the exact sentence a support ticket should carry.
 *
 * This exists so the toolchain can check its OWN output before handing it to a customer: a
 * signer that emits a file no device accepts is the one bug this whole chain is built to avoid.
 */
export function verifyEntitlement(
  claims: EntitlementClaims,
  publicKeyPem: string,
  against: { app: string; platform: string; major: number },
): { ok: true } | { ok: false; reason: string } {
  const signature = claims.signature;
  if (signature === undefined || signature === "") {
    return { ok: false, reason: "the entitlement carries no signature" };
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(signature, "base64");
    // Buffer.from is permissive where Ruby's strict_decode64 is not: it drops invalid characters
    // instead of refusing, so a garbage signature would silently become a short buffer and get
    // reported as the wrong failure. Round-trip to catch that.
    if (raw.toString("base64") !== signature) return { ok: false, reason: "the signature is not valid base64" };
  } catch {
    return { ok: false, reason: "the signature is not valid base64" };
  }
  if (raw.length !== 64) return { ok: false, reason: "the signature is not 64 bytes (Ed25519 raw)" };

  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "the public key is not a readable PEM key" };
  }
  const verified = cryptoVerify(null, Buffer.from(canonicalBytes(claims), "utf8"), key, raw);
  if (!verified) {
    return { ok: false, reason: "the signature does not verify: the entitlement was altered or signed by another key" };
  }
  if (!coversApp(claims, against.app)) {
    return { ok: false, reason: `this entitlement is for "${claims.appId}", but the app is running as "${against.app}"` };
  }
  if (claims.platform !== against.platform) {
    return { ok: false, reason: `this entitlement is for "${claims.platform}", not "${against.platform}"` };
  }
  if (claims.majorVersion !== against.major) {
    // Word for word the Ruby's sentence (and the natives'), because this is what a support
    // ticket carries: the same failure must not read differently depending on which of the four
    // implementations the developer happened to hit.
    return {
      ok: false,
      reason: `this entitlement covers Despia ${claims.majorVersion}, and this runtime is ${against.major} \u2014 a major version is a new licence`,
    };
  }
  return { ok: true };
}
