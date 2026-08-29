//
//  crypto-core.ts - the shared `crypto` module core: the digest-name fold, the UUID bit
//  layouts and the uniform-integer rejection bound. The law is the corpus,
//  OpenSource/Conformance/crypto/ (parity/F15-crypto.md); the Kotlin twin is :core
//  CryptoCore.kt and the Swift twin is Engine/iOS/CryptoCore.swift.
//
//  NOTHING here computes a hash, a MAC or a signature. Those are the platform's job
//  (CryptoKit, java.security + AndroidKeyStore, WebCrypto) and the module facets call
//  straight into them. What lives here is the part that has no platform answer and would
//  therefore drift: which spelling of "sha256" is accepted, exactly which bits of a UUID
//  carry the timestamp, and how many draws a uniform integer costs. Those three must be
//  byte-identical on three renderers or a v7 id minted on iOS sorts differently from one
//  minted in a browser.
//

/** The digest vocabulary. Key = the spelling authors write, value = the WebCrypto name.
 *  sha1 and md5 are present because integrity checks against existing servers need them;
 *  they are marked legacy so a build can switch them off (config `allow_legacy_digests`)
 *  and so no code path can pick one as a default. */
export const CRYPTO_DIGESTS: Readonly<Record<string, { readonly web: string; readonly legacy: boolean }>> = {
  sha256: { web: "SHA-256", legacy: false },
  sha384: { web: "SHA-384", legacy: false },
  sha512: { web: "SHA-512", legacy: false },
  sha1: { web: "SHA-1", legacy: true },
  md5: { web: "MD5", legacy: true },
};

/** The MAC vocabulary is the digest vocabulary minus md5: HMAC-MD5 has no legitimate use
 *  that HMAC-SHA1 does not serve better, and WebCrypto will not do it at all. */
export const CRYPTO_MAC_DIGESTS: readonly string[] = ["sha256", "sha384", "sha512", "sha1"];

/** The largest `randomBytes` request. A page asking for a megabyte of entropy is a bug, and
 *  an unbounded request is a trivially reachable OOM from markup. */
export const CRYPTO_MAX_RANDOM_BYTES = 1048576;

/** Fold an author's algorithm spelling. Case-insensitive after trimming, and the separator
 *  forms every other library accepts (`SHA-256`, `sha_256`) fold to the same id, because a
 *  vocabulary that rejects a hyphen teaches nothing and costs a support ticket. Returns null
 *  for an unknown name, or for a legacy name when the build switched legacy digests off. */
export function foldDigest(name: string | null | undefined, allowLegacy = true): string | null {
  const key = String(name ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  const entry = CRYPTO_DIGESTS[key];
  if (entry === undefined) return null;
  if (entry.legacy && !allowLegacy) return null;
  return key;
}

/** The WebCrypto spelling of a folded id, for the web facet. */
export function digestWebName(id: string): string | null {
  return CRYPTO_DIGESTS[id]?.web ?? null;
}

function hex(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, "0");
}

function format(bytes: readonly number[] | Uint8Array): string {
  const s: string[] = [];
  for (let i = 0; i < 16; i += 1) s.push(hex(bytes[i] ?? 0));
  return `${s.slice(0, 4).join("")}-${s.slice(4, 6).join("")}-${s.slice(6, 8).join("")}-${s.slice(8, 10).join("")}-${s.slice(10, 16).join("")}`;
}

/**
 * RFC 9562 version 4: 16 random bytes with the version and variant nibbles stamped over
 * them. `random` must carry at least 16 bytes; anything past the sixteenth is ignored.
 */
export function uuidV4(random: readonly number[] | Uint8Array): string {
  const b: number[] = [];
  for (let i = 0; i < 16; i += 1) b.push((random[i] ?? 0) & 0xff);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return format(b);
}

/**
 * RFC 9562 version 7: 48 bits of Unix milliseconds big-endian, then the version nibble,
 * then 74 bits of randomness. `random` supplies 10 bytes; the version and variant bits are
 * stamped over the first and third of them.
 *
 * The ordering property is the entire point: two v7 ids minted a millisecond apart compare
 * in mint order as plain strings, so they index and paginate without a separate sort key.
 */
export function uuidV7(unixMillis: number, random: readonly number[] | Uint8Array): string {
  const ms = Math.max(0, Math.floor(unixMillis)) % 0x1000000000000;
  const b: number[] = new Array(16).fill(0);
  b[0] = Math.floor(ms / 0x10000000000) & 0xff;
  b[1] = Math.floor(ms / 0x100000000) & 0xff;
  b[2] = Math.floor(ms / 0x1000000) & 0xff;
  b[3] = Math.floor(ms / 0x10000) & 0xff;
  b[4] = Math.floor(ms / 0x100) & 0xff;
  b[5] = ms & 0xff;
  for (let i = 0; i < 10; i += 1) b[6 + i] = (random[i] ?? 0) & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return format(b);
}

/** The largest exact multiple of `range` that fits in 32 bits. A 32-bit draw at or above
 *  this is DISCARDED; below it, `draw % range` is exactly uniform. `range` is the count of
 *  distinct outcomes (max - min + 1) and must be 1...2^32. */
export function uniformBound(range: number): number {
  if (!Number.isInteger(range) || range < 1 || range > 0x100000000) return 0;
  return 0x100000000 - (0x100000000 % range);
}

/** What `randomInt` does with a supplied sequence of 32-bit draws: skip every draw the bound
 *  rejects, fold the first survivor. Pure and deterministic, which is what lets the corpus
 *  pin the rejection behaviour instead of merely asserting the answer is in range.
 *  Returns null when the sequence ran out before a draw survived. */
export function uniformPick(range: number, draws: readonly number[]): { value: number; consumed: number } | null {
  const bound = uniformBound(range);
  if (bound === 0) return null;
  for (let i = 0; i < draws.length; i += 1) {
    const draw = draws[i] >>> 0;
    if (draw < bound) return { value: draw % range, consumed: i + 1 };
  }
  return null;
}

/** The full `randomInt` fold: validate the range, then pick. `min`/`max` are inclusive. */
export function uniformInt(
  min: number, max: number, draws: readonly number[],
): { ok: true; value: number; consumed: number } | { ok: false; error: "invalid_range" | "exhausted" } {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) return { ok: false, error: "invalid_range" };
  const range = max - min + 1;
  if (range > 0x100000000) return { ok: false, error: "invalid_range" };
  const picked = uniformPick(range, draws);
  if (picked === null) return { ok: false, error: "exhausted" };
  return { ok: true, value: min + picked.value, consumed: picked.consumed };
}
