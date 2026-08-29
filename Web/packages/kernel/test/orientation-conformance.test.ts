//
//  orientation-conformance.test.ts — the SHARED orientation corpus through the TS kernel
//  (OpenSource/Conformance/input/orientation.json). The Kotlin twin (:core
//  OrientationConformanceTest) and the Swift twin (StackOrientation) run the SAME file, so
//  `lockOrientation="landscape"` cannot mean one thing on one renderer and something else on
//  another: an unrecognized word and an undeclared orientation are both refused loudly, and
//  the claim stack reverts through one funnel on every dismissal path.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  ORIENTATION_CANONICAL, resolveOrientation, OrientationClaimStack,
} from "../src/index.ts";

type ResolveCase = {
  name: string;
  to?: string;
  current?: string;
  allowed: string[];
  expect: { mask: string[]; primary: string } | { error: string };
};
type LifecycleStep = { claim?: string; to?: string; release?: string; reset?: boolean };
type LifecycleCase = { name: string; steps: LifecycleStep[]; expect: (string | null)[] };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/input");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/input not found");
    dir = parent;
  }
}

function corpus(): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), "orientation.json"), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, "orientation.json: version");
  return doc;
}

test("orientation: the canonical order agrees with the corpus", () => {
  const order = corpus()["canonicalOrder"] as string[];
  assert.deepEqual([...ORIENTATION_CANONICAL], order);
});

test("orientation: the vocabulary fold agrees with the corpus", () => {
  const cases = corpus()["resolve"] as ResolveCase[];
  assert.ok(cases.length > 0, "resolve corpus must not be empty");
  for (const testCase of cases) {
    const result = resolveOrientation(testCase.to, testCase.allowed, testCase.current);
    const expected = testCase.expect;

    if ("error" in expected) {
      assert.equal(result.ok, false, `${testCase.name}: expected refusal ${expected.error}`);
      assert.equal(result.ok === false && result.error, expected.error, `${testCase.name}: refusal code`);
      continue;
    }

    assert.equal(result.ok, true, `${testCase.name}: expected a resolved lock`);
    if (result.ok !== true) continue;
    assert.deepEqual([...result.value.mask], expected.mask, `${testCase.name}: mask`);
    assert.equal(result.value.primary, expected.primary, `${testCase.name}: primary`);
  }
});

test("orientation: the claim stack agrees with the corpus", () => {
  const cases = corpus()["lifecycle"] as LifecycleCase[];
  assert.ok(cases.length > 0, "lifecycle corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(testCase.steps.length, testCase.expect.length, `${testCase.name}: one expectation per step`);
    const stack = new OrientationClaimStack();
    testCase.steps.forEach((step, index) => {
      let actual: string | null;
      if (step.claim !== undefined) actual = stack.claim(step.claim, step.to as string);
      else if (step.release !== undefined) actual = stack.release(step.release);
      else if (step.reset === true) actual = stack.reset();
      else throw new Error(`${testCase.name}: step ${index} names no operation`);
      assert.equal(actual, testCase.expect[index], `${testCase.name}: effective after step ${index}`);
      assert.equal(stack.effective, testCase.expect[index], `${testCase.name}: effective is stable after step ${index}`);
    });
  }
});
