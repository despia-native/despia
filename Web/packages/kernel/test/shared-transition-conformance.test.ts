//
//  shared-transition-conformance.test.ts — the SHARED U03 corpus through the TS kernel
//  (OpenSource/Conformance/router/shared.json). The Kotlin twin (:core
//  SharedTransitionConformanceTest) and the Swift reference (StackSharedTransition, via the
//  record lane) run the SAME file, so `shared="cover-3"` cannot pair one way on one renderer
//  and another way on the next: the matching, the interpolation schedule and — the case that
//  actually matters — the interruption/reversal machine are one contract.
//
//  Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  SHARED_MODES, SHARED_HANDOFF_START, SHARED_A11Y_FOCUS,
  matchSharedElements, sampleSharedPair, SharedTransitionMachine,
  type SharedElement, type SharedPair, type SharedSample, type SharedMachineSnapshot,
} from "../src/shared-transition.ts";

type MatchCase = {
  name: string;
  source: SharedElement[];
  destination: SharedElement[];
  reducedMotion?: boolean;
  frameAnim?: string | null;
  presentation?: string;
  expect: {
    pairs: SharedPair[];
    unmatchedSource: string[];
    unmatchedDestination: string[];
    duplicates: string[];
  };
};
type InterpolateCase = { name: string; pair: SharedPair; samples: { progress: number; expect: SharedSample }[] };
type MachineEvent = {
  begin?: "forward" | "reverse"; tick?: number; interrupt?: number; drag?: number;
  release?: "commit" | "cancel"; settle?: boolean;
};
type MachineCase = { name: string; steps: { event: MachineEvent; expect: SharedMachineSnapshot }[]; maxStep?: number };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/router");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/router not found");
    dir = parent;
  }
}

function corpus(): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), "shared.json"), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, "shared.json: version");
  return doc;
}

const TOLERANCE = 1e-6;

function near(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= TOLERANCE,
            `${what}: expected ${expected}, got ${actual}`);
}

test("shared transitions: the vocabulary and the pinned constants agree with the corpus", () => {
  const doc = corpus();
  assert.deepEqual([...SHARED_MODES], doc["modes"]);
  near(SHARED_HANDOFF_START, doc["handoffStart"] as number, "handoffStart");
  const a11y = doc["a11y"] as { focus: string; at: string };
  assert.equal(SHARED_A11Y_FOCUS.target, a11y.focus, "a11y focus target");
  assert.equal(SHARED_A11Y_FOCUS.at, a11y.at, "a11y focus timing");
  near(TOLERANCE, doc["tolerance"] as number, "tolerance");
});

test("shared transitions: the matching algorithm agrees with the corpus", () => {
  const cases = corpus()["match"] as MatchCase[];
  assert.ok(cases.length > 0, "match corpus must not be empty");
  for (const testCase of cases) {
    const options: { reducedMotion?: boolean; frameAnim?: string | null } = {};
    if (testCase.reducedMotion !== undefined) options.reducedMotion = testCase.reducedMotion;
    if (testCase.frameAnim !== undefined) options.frameAnim = testCase.frameAnim;
    const actual = matchSharedElements(testCase.source, testCase.destination, options);
    const expected = testCase.expect;

    assert.equal(actual.pairs.length, expected.pairs.length, `${testCase.name}: pair count`);
    actual.pairs.forEach((pair, index) => {
      const want = expected.pairs[index]!;
      const at = `${testCase.name}: pair ${index}`;
      assert.equal(pair.id, want.id, `${at}: id (order is sharedOrder then destination document order)`);
      assert.equal(pair.order, want.order, `${at}: order`);
      assert.equal(pair.mode, want.mode, `${at}: mode`);
      assert.equal(pair.anim, want.anim, `${at}: anim`);
      assert.equal(pair.deferred, want.deferred, `${at}: deferred`);
      for (const end of ["from", "to"] as const) {
        for (const key of ["x", "y", "width", "height", "radius", "opacity"] as const) {
          near(pair[end][key], want[end][key], `${at}: ${end}.${key}`);
        }
        assert.equal(pair[end].contentMode, want[end].contentMode, `${at}: ${end}.contentMode`);
      }
      if (pair.deferred) {
        assert.ok(pair.to.width > 0 && pair.to.height > 0,
                  `${at}: an unrealised destination must never produce a zero rect`);
      }
    });
    assert.deepEqual(actual.unmatchedSource, expected.unmatchedSource, `${testCase.name}: unmatchedSource`);
    assert.deepEqual(actual.unmatchedDestination, expected.unmatchedDestination, `${testCase.name}: unmatchedDestination`);
    assert.deepEqual(actual.duplicates, expected.duplicates, `${testCase.name}: duplicates`);
  }
});

test("shared transitions: the interpolation schedule agrees with the corpus", () => {
  const cases = corpus()["interpolate"] as InterpolateCase[];
  assert.ok(cases.length > 0, "interpolate corpus must not be empty");
  for (const testCase of cases) {
    for (const step of testCase.samples) {
      const actual = sampleSharedPair(testCase.pair, step.progress);
      const at = `${testCase.name} @ ${step.progress}`;
      for (const key of ["x", "y", "width", "height", "radius", "alpha",
                         "sourceOpacity", "destinationOpacity"] as const) {
        near(actual[key], step.expect[key], `${at}: ${key}`);
      }
      assert.equal(actual.contentMode, step.expect.contentMode, `${at}: contentMode`);
      assert.equal(actual.scaleContent, step.expect.scaleContent, `${at}: scaleContent`);
    }
  }
});

test("shared transitions: the interruption machine agrees with the corpus", () => {
  const cases = corpus()["machine"] as MachineCase[];
  assert.ok(cases.length > 0, "machine corpus must not be empty");
  for (const testCase of cases) {
    const machine = new SharedTransitionMachine();
    let previous = machine.snapshot().progress;
    let maxStep: number | null = null;
    let gesture = false;
    testCase.steps.forEach((step, index) => {
      const event = step.event;
      let actual: SharedMachineSnapshot;
      if (event.begin !== undefined) actual = machine.begin(event.begin);
      else if (event.tick !== undefined) actual = machine.tick(event.tick);
      else if (event.interrupt !== undefined) actual = machine.interrupt(event.interrupt);
      else if (event.drag !== undefined) actual = machine.drag(event.drag);
      else if (event.release !== undefined) actual = machine.release(event.release);
      else if (event.settle === true) actual = machine.settle();
      else throw new Error(`${testCase.name}: step ${index} names no event`);

      const at = `${testCase.name}: step ${index}`;
      assert.equal(actual.state, step.expect.state, `${at}: state`);
      assert.equal(actual.direction, step.expect.direction, `${at}: direction`);
      near(actual.progress, step.expect.progress, `${at}: progress`);
      near(actual.target, step.expect.target, `${at}: target`);
      near(actual.remaining, step.expect.remaining, `${at}: remaining`);
      assert.equal(actual.outcome, step.expect.outcome, `${at}: outcome`);
      // the snapshot must be a READ, not a mutation — asking twice cannot move the machine
      assert.deepEqual(machine.snapshot(), actual, `${at}: snapshot is stable`);

      // THE GESTURE WINDOW: from the interrupt that hands the transition to the finger
      // through the release that gives it back. Progress inside it may only move as far as
      // the finger did — a snap is a jump of the whole remaining distance.
      const delta = Math.abs(actual.progress - previous);
      if (event.interrupt !== undefined) {
        maxStep = gesture ? Math.max(maxStep ?? 0, delta) : delta;
        gesture = true;
        assert.ok(delta <= TOLERANCE,
                  `${at}: an interruption must ADOPT the transition at its current progress, ` +
                  `not restart or snap it (progress moved ${delta})`);
      } else if (gesture) {
        maxStep = Math.max(maxStep ?? 0, delta);
        if (event.release !== undefined) gesture = false;
      }
      previous = actual.progress;
    });
    if (testCase.maxStep !== undefined) {
      assert.notEqual(maxStep, null, `${testCase.name}: maxStep is pinned but no gesture ran`);
      // THE acceptance test, stated as a number: a snapping implementation jumps the whole
      // remaining distance in one step, a reversing one never moves further than the finger did.
      assert.ok((maxStep ?? 0) <= testCase.maxStep + TOLERANCE,
                `${testCase.name}: the transition SNAPPED — largest single-step progress delta was ` +
                `${maxStep}, the corpus allows ${testCase.maxStep}`);
    }
  }
});
