//
//  passkeys-conformance.test.ts — the SHARED PASSKEY corpus
//  (OpenSource/Conformance/passkeys/ceremony.json) through the TS core, the REFERENCE leg of
//  Core/Passkeys (F17.3). The Kotlin twin (:core PasskeysConformanceTest) and the Swift twin
//  (Engine/iOS/Passkeys.swift) read the SAME file, so a challenge cannot be padded on one
//  renderer and unpadded on another.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  PASSKEY_MIN_CHALLENGE_BYTES, PASSKEY_MAX_CHALLENGE_BYTES, PASSKEY_MAX_USER_ID_BYTES,
  PASSKEY_MIN_TIMEOUT_MS, PASSKEY_DEFAULT_TIMEOUT_MS, PASSKEY_MAX_TIMEOUT_MS,
  PASSKEY_ATTESTATIONS, PASSKEY_MEDIATIONS, PASSKEY_VERIFICATIONS, PASSKEY_RESIDENT_KEYS,
  base64UrlEncode, base64UrlDecode, normalizeRpId, normalizeChallenge, normalizeUser,
  foldAttestation, foldMediation, foldUserVerification, foldResidentKey,
  clampPasskeyTimeout, normalizeCredentialIds, normalizeCreateOptions, normalizeGetOptions,
  type PasskeyResult,
} from "../src/passkeys.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/passkeys");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("passkeys corpus not found");
    dir = parent;
  }
}

type Doc = {
  limits: Record<string, number>;
  vocabulary: { attestations: string[]; mediations: string[]; verifications: string[]; residentKeys: string[] };
  encode: { name: string; bytes: number[]; expect: string }[];
  decode: { name: string; text: string; ok: boolean; bytes?: number[] }[];
  rpId: { name: string; raw: string; ok: boolean; expect?: string; error?: string }[];
  challenge: { name: string; raw: string; ok: boolean; expect?: string; error?: string }[];
  user: { name: string; raw: unknown; ok: boolean; expect?: unknown; error?: string }[];
  words: { name: string; kind: string; raw: unknown; ok: boolean; expect?: string; error?: string }[];
  timeout: { name: string; raw: unknown; expect: number }[];
  credentials: { name: string; raw: unknown; ok: boolean; expect?: string[]; error?: string }[];
  create: { name: string; raw: Record<string, unknown>; ok: boolean; expect?: unknown; error?: string }[];
  get: { name: string; raw: Record<string, unknown>; ok: boolean; expect?: unknown; error?: string }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "ceremony.json"), "utf-8")) as Doc;

assert.ok(doc.encode.length >= 8, "passkeys/encode corpus is suspiciously small");
assert.ok(doc.rpId.length >= 12, "passkeys/rpId corpus is suspiciously small");
assert.ok(doc.create.length >= 5 && doc.get.length >= 4, "passkeys ceremony corpus is suspiciously small");

test("passkeys — the pinned limits and vocabulary", () => {
  assert.equal(PASSKEY_MIN_CHALLENGE_BYTES, doc.limits["minChallengeBytes"]);
  assert.equal(PASSKEY_MAX_CHALLENGE_BYTES, doc.limits["maxChallengeBytes"]);
  assert.equal(PASSKEY_MAX_USER_ID_BYTES, doc.limits["maxUserIdBytes"]);
  assert.equal(PASSKEY_MIN_TIMEOUT_MS, doc.limits["minTimeoutMs"]);
  assert.equal(PASSKEY_DEFAULT_TIMEOUT_MS, doc.limits["defaultTimeoutMs"]);
  assert.equal(PASSKEY_MAX_TIMEOUT_MS, doc.limits["maxTimeoutMs"]);
  assert.deepEqual([...PASSKEY_ATTESTATIONS], doc.vocabulary.attestations);
  assert.deepEqual([...PASSKEY_MEDIATIONS], doc.vocabulary.mediations);
  assert.deepEqual([...PASSKEY_VERIFICATIONS], doc.vocabulary.verifications);
  assert.deepEqual([...PASSKEY_RESIDENT_KEYS], doc.vocabulary.residentKeys);
});

for (const c of doc.encode) {
  test(`passkeys/encode — ${c.name}`, () => {
    assert.equal(base64UrlEncode(c.bytes), c.expect);
    // Every encode case is also a round trip: the codec's only real contract.
    assert.deepEqual(base64UrlDecode(c.expect), c.bytes);
  });
}

for (const c of doc.decode) {
  test(`passkeys/decode — ${c.name}`, () => {
    const got = base64UrlDecode(c.text);
    if (c.ok) assert.deepEqual(got, c.bytes);
    else assert.equal(got, null);
  });
}

function check<T>(got: PasskeyResult<T>, c: { ok: boolean; error?: string }, expect: unknown): void {
  assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${got.detail ?? ""})`);
  if (got.ok) assert.deepEqual(JSON.parse(JSON.stringify(got.value)), expect);
  else assert.equal(got.error, c.error, "error");
}

for (const c of doc.rpId) {
  test(`passkeys/rpId — ${c.name}`, () => check(normalizeRpId(c.raw), c, c.expect));
}

for (const c of doc.challenge) {
  test(`passkeys/challenge — ${c.name}`, () => check(normalizeChallenge(c.raw), c, c.expect));
}

for (const c of doc.user) {
  test(`passkeys/user — ${c.name}`, () => check(normalizeUser(c.raw), c, c.expect));
}

const FOLDS: Record<string, (raw: unknown) => PasskeyResult<string>> = {
  attestation: foldAttestation,
  mediation: foldMediation,
  verification: foldUserVerification,
  residentKey: foldResidentKey,
};

for (const c of doc.words) {
  test(`passkeys/words — ${c.name}`, () => {
    const fold = FOLDS[c.kind];
    assert.ok(fold !== undefined, `no fold for ${c.kind}`);
    check(fold(c.raw), c, c.expect);
  });
}

for (const c of doc.timeout) {
  test(`passkeys/timeout — ${c.name}`, () => {
    assert.equal(clampPasskeyTimeout(c.raw), c.expect);
  });
}

for (const c of doc.credentials) {
  test(`passkeys/credentials — ${c.name}`, () => check(normalizeCredentialIds(c.raw), c, c.expect));
}

for (const c of doc.create) {
  test(`passkeys/create — ${c.name}`, () => check(normalizeCreateOptions(c.raw), c, c.expect));
}

for (const c of doc.get) {
  test(`passkeys/get — ${c.name}`, () => check(normalizeGetOptions(c.raw), c, c.expect));
}
