//
//  ota-conformance.test.ts — the SHARED OTA-safety corpus through the TS kernel
//  (OpenSource/Conformance/ota/rollout.json). The Kotlin twin (:core OtaConformanceTest) and
//  the Swift twin (OtaGeneration, record lane) run the SAME file, so a staged rollout cannot
//  include a device on one renderer and hold it on another, and a runtimeVersion gate cannot
//  refuse a generation on one and apply it on another.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//
//  Imported from ../src/ota.ts rather than the barrel: the export line in src/index.ts is a
//  shared-file edit the coordinator applies, and this suite must be runnable before it lands.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  otaHash32, rolloutBucket, rolloutApplies,
  compareRuntimeVersions, runtimeVersionSatisfied, parseRuntimeVersion,
  evaluateGeneration,
} from "../src/ota.ts";

type HashCase = { name: string; installationId: string; salt: string; hash: number; bucket: number };
type RolloutCase = { name: string; installationId: string; salt: string; fraction: number; applies: boolean };
type MonotonicCase = { name: string; installationId: string; salt: string; applies: boolean[] };
type CompareCase = { name: string; a: string; b: string; expect: number | null };
type GenerationCase = {
  name: string;
  manifest: { runtimeVersion?: unknown; rollout?: unknown };
  client: { runtimeVersion?: unknown; installationId?: unknown };
  expect: string;
};
type HashBlock = {
  algorithm: string; offsetBasis: number; prime: number; divisor: number;
  inputTemplate: string; cases: HashCase[];
};
type MonotonicBlock = { fractions: number[]; cases: MonotonicCase[] };
type GenerationBlock = { verdicts: string[]; cases: GenerationCase[] };
type Corpus = {
  version: number;
  hash: HashBlock;
  rollout: { cases: RolloutCase[] };
  monotonic: MonotonicBlock;
  compare: { cases: CompareCase[] };
  generation: GenerationBlock;
};

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/ota");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/ota not found");
    dir = parent;
  }
}

function corpus(): Corpus {
  const doc = JSON.parse(readFileSync(join(corpusDir(), "rollout.json"), "utf-8")) as Corpus;
  assert.equal(doc.version, 1, "rollout.json: version");
  return doc;
}

test("ota: the hash constants agree with the corpus", () => {
  const hash = corpus().hash;
  assert.equal(hash.algorithm, "fnv1a32");
  assert.equal(hash.offsetBasis, 2166136261);
  assert.equal(hash.prime, 16777619);
  assert.equal(hash.divisor, 4294967296);
  assert.equal(hash.inputTemplate, "{installationId}:{salt}");
});

test("ota: every pinned hash and bucket reproduces exactly", () => {
  const cases = corpus().hash.cases;
  assert.ok(cases.length > 0, "hash corpus must not be empty");
  for (const c of cases) {
    assert.equal(otaHash32(`${c.installationId}:${c.salt}`), c.hash, `${c.name}: hash`);
    const bucket = rolloutBucket(c.installationId, c.salt);
    assert.ok(Math.abs(bucket - c.bucket) < 1e-12, `${c.name}: bucket ${bucket} != ${c.bucket}`);
    assert.ok(bucket >= 0 && bucket < 1, `${c.name}: bucket is in [0,1)`);
  }
});

test("ota: a different salt reshuffles the population", () => {
  const cases = corpus().hash.cases;
  const byId = new Map<string, Set<number>>();
  for (const c of cases) {
    const seen = byId.get(c.installationId) ?? new Set<number>();
    seen.add(c.hash);
    byId.set(c.installationId, seen);
  }
  // At least one id must appear under two salts with two different buckets, or the corpus
  // is not actually pinning the reshuffle it claims to.
  const reshuffled = [...byId.values()].some((set) => set.size > 1);
  assert.ok(reshuffled, "the corpus must pin one id under two salts landing in two buckets");
});

test("ota: the rollout rule agrees with the corpus", () => {
  const cases = corpus().rollout.cases;
  assert.ok(cases.length > 0, "rollout corpus must not be empty");
  for (const c of cases) {
    assert.equal(rolloutApplies(c.installationId, c.salt, c.fraction), c.applies, c.name);
  }
});

test("ota: raising the fraction only ever grows the population", () => {
  const block = corpus().monotonic;
  const fractions = block.fractions;
  const cases = block.cases;
  assert.ok(cases.length > 0, "monotonic corpus must not be empty");
  for (const c of cases) {
    assert.equal(c.applies.length, fractions.length, `${c.name}: one expectation per fraction`);
    let previous = false;
    fractions.forEach((fraction, index) => {
      const actual = rolloutApplies(c.installationId, c.salt, fraction);
      assert.equal(actual, c.applies[index], `${c.name}: fraction ${fraction}`);
      assert.ok(!(previous && !actual), `${c.name}: fraction ${fraction} dropped a device that was already in`);
      previous = actual;
    });
  }
});

test("ota: runtimeVersion precedence agrees with the corpus", () => {
  const cases = corpus().compare.cases;
  assert.ok(cases.length > 0, "compare corpus must not be empty");
  for (const c of cases) {
    assert.equal(compareRuntimeVersions(c.a, c.b), c.expect, `${c.name}: compare(${c.a}, ${c.b})`);
    if (c.expect !== null) {
      // Antisymmetry is not in the corpus because it is a property, not a case.
      const reversed = c.expect === 0 ? 0 : -c.expect;   // -0 is not 0 to a strict assert
      assert.equal(compareRuntimeVersions(c.b, c.a), reversed, `${c.name}: reversed`);
      assert.equal(runtimeVersionSatisfied(c.b, c.a), c.expect >= 0, `${c.name}: satisfied`);
    } else {
      assert.equal(runtimeVersionSatisfied(c.b, c.a), null, `${c.name}: satisfied is undecidable`);
      assert.ok(
        parseRuntimeVersion(c.a) === null || parseRuntimeVersion(c.b) === null,
        `${c.name}: null compare means one side is unparseable`,
      );
    }
  }
});

test("ota: the generation gate agrees with the corpus", () => {
  const block = corpus().generation;
  const verdicts = block.verdicts;
  const cases = block.cases;
  assert.ok(cases.length > 0, "generation corpus must not be empty");
  for (const c of cases) {
    assert.ok(verdicts.includes(c.expect), `${c.name}: '${c.expect}' is outside the declared vocabulary`);
    const decision = evaluateGeneration(c.manifest, c.client);
    assert.equal(decision.verdict, c.expect, c.name);
  }
});

test("ota: every declared verdict is exercised by at least one case", () => {
  const block = corpus().generation;
  const verdicts = block.verdicts;
  const cases = block.cases;
  for (const verdict of verdicts) {
    assert.ok(cases.some((c) => c.expect === verdict), `no corpus case reaches '${verdict}'`);
  }
});
