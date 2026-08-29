//
//  integrity-conformance.test.ts — the SHARED ATTESTATION corpus
//  (OpenSource/Conformance/integrity/attestation.json) through the TS core, the REFERENCE leg
//  of Core/Integrity (F17.4). The Kotlin twin (:core IntegrityConformanceTest) and the Swift
//  twin (Engine/iOS/Integrity.swift) read the SAME file, so one backend contract serves both
//  platforms.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  INTEGRITY_PROVIDERS, INTEGRITY_FORMATS, INTEGRITY_ADVISORY,
  INTEGRITY_MIN_CHALLENGE_BYTES, INTEGRITY_MAX_CHALLENGE_BYTES, INTEGRITY_MAX_KEY_REF_CHARS,
  integrityProviderFor, integrityFormat, normalizeIntegrityChallenge, normalizeKeyRef,
  integrityEnvelope,
} from "../src/integrity.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/integrity");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("integrity corpus not found");
    dir = parent;
  }
}

type Doc = {
  limits: Record<string, number>;
  vocabulary: { providers: string[]; formats: string[] };
  advisory: string;
  provider: { name: string; platform: string; expect: string }[];
  format: { name: string; provider: string; kind: string; ok: boolean; expect?: string; error?: string }[];
  challenge: { name: string; raw: string; ok: boolean; expect?: string; error?: string }[];
  keyRef: { name: string; raw: string; ok: boolean; expect?: string; error?: string }[];
  envelope: {
    name: string; provider: string; kind: string; token: string; challenge: string; keyRef: string;
    ok: boolean; expect?: unknown; error?: string;
  }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "attestation.json"), "utf-8")) as Doc;

assert.ok(doc.provider.length >= 6, "integrity/provider corpus is suspiciously small");
assert.ok(doc.envelope.length >= 4, "integrity/envelope corpus is suspiciously small");

test("integrity — the pinned limits, vocabulary and advisory", () => {
  assert.equal(INTEGRITY_MIN_CHALLENGE_BYTES, doc.limits["minChallengeBytes"]);
  assert.equal(INTEGRITY_MAX_CHALLENGE_BYTES, doc.limits["maxChallengeBytes"]);
  assert.equal(INTEGRITY_MAX_KEY_REF_CHARS, doc.limits["maxKeyRefChars"]);
  assert.deepEqual([...INTEGRITY_PROVIDERS], doc.vocabulary.providers);
  assert.deepEqual([...INTEGRITY_FORMATS], doc.vocabulary.formats);
  assert.equal(INTEGRITY_ADVISORY, doc.advisory);
});

for (const c of doc.provider) {
  test(`integrity/provider — ${c.name}`, () => {
    assert.equal(integrityProviderFor(c.platform), c.expect);
  });
}

for (const c of doc.format) {
  test(`integrity/format — ${c.name}`, () => {
    const got = integrityFormat(c.provider, c.kind);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.challenge) {
  test(`integrity/challenge — ${c.name}`, () => {
    const got = normalizeIntegrityChallenge(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.keyRef) {
  test(`integrity/keyRef — ${c.name}`, () => {
    const got = normalizeKeyRef(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.envelope) {
  test(`integrity/envelope — ${c.name}`, () => {
    const got = integrityEnvelope(c.provider, c.kind, c.token, c.challenge, c.keyRef);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.deepEqual(JSON.parse(JSON.stringify(got.value)), c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}
