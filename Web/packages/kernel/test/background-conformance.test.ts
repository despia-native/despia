//
//  background-conformance.test.ts - the SHARED background corpus through the TS kernel
//  (OpenSource/Conformance/background/{declaration,constraints,budget}.json). The Kotlin twin
//  (:core BackgroundConformanceTest) and the Swift twin (Engine/iOS BackgroundPlan) run the
//  SAME files, so a declared task cannot mean one thing on one renderer and something else on
//  another: the same clamp, the same constraint translation, the same budget, and the same
//  honest run record when the OS kills the process mid-flight.
//
//  Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
//
//  Imported from ../src/background.ts directly rather than through the package barrel: the
//  barrel is a shared file this workstream does not own (parity/AGENT-CONTRACT.md), and the
//  export line rides in the handoff.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  BACKGROUND_KINDS, BACKGROUND_REQUIREMENTS, BACKGROUND_PERIODIC_FLOOR_SECONDS,
  BACKGROUND_BUCKETS, BACKGROUND_BUDGET_MS,
  resolveBackgroundTask, backgroundConstraints, backgroundUnmet, backgroundBudget,
  backgroundRunRecord, backgroundRunAllowed,
  type BackgroundRow, type BackgroundRunEvent, type BackgroundDeviceState,
} from "../src/background.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/background");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/background not found");
    dir = parent;
  }
}

function corpus(name: string): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), `${name}.json`), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, `${name}.json: version`);
  return doc;
}

test("background: the declared vocabulary agrees with the corpus", () => {
  const doc = corpus("declaration");
  assert.deepEqual([...BACKGROUND_KINDS], doc["kinds"]);
  assert.deepEqual([...BACKGROUND_REQUIREMENTS], doc["requirements"]);
  assert.deepEqual([...BACKGROUND_BUCKETS], doc["buckets"]);
  assert.equal(BACKGROUND_PERIODIC_FLOOR_SECONDS, doc["periodicFloorSeconds"]);
});

test("background: the declaration fold agrees with the corpus", () => {
  type Case = {
    name: string; id: string; declaredActions: string[]; row: BackgroundRow;
    expect: { [k: string]: unknown };
  };
  const cases = corpus("declaration")["declare"] as Case[];
  assert.ok(cases.length > 0, "declare corpus must not be empty");
  for (const testCase of cases) {
    const result = resolveBackgroundTask(testCase.id, testCase.row, testCase.declaredActions);
    const expected = testCase.expect;

    if ("error" in expected) {
      assert.equal(result.ok, false, `${testCase.name}: expected refusal ${String(expected["error"])}`);
      assert.equal(result.ok === false && result.error, expected["error"], `${testCase.name}: refusal code`);
      continue;
    }

    assert.equal(result.ok, true, `${testCase.name}: expected a resolved task`);
    if (result.ok !== true) continue;
    const task = result.value;
    assert.equal(task.id, testCase.id, `${testCase.name}: id`);
    assert.equal(task.action, expected["action"], `${testCase.name}: action`);
    assert.equal(task.kind, expected["kind"], `${testCase.name}: kind`);
    assert.equal(task.minIntervalSeconds, expected["minIntervalSeconds"], `${testCase.name}: minIntervalSeconds`);
    assert.equal(task.clamped, expected["clamped"], `${testCase.name}: clamped`);
    assert.deepEqual([...task.requires], expected["requires"], `${testCase.name}: requires`);
    assert.equal(task.expedited, expected["expedited"], `${testCase.name}: expedited`);
    assert.equal(task.bucket, expected["bucket"], `${testCase.name}: bucket`);
    assert.ok(BACKGROUND_BUCKETS.includes(task.bucket), `${testCase.name}: bucket is one of the fixed five`);
  }
});

test("background: each requirement translates to the platform constraint the corpus pins", () => {
  type Row = { requirement: string; ios: { [k: string]: string }; android: { [k: string]: string } };
  const rows = corpus("constraints")["map"] as Row[];
  assert.equal(rows.length, BACKGROUND_REQUIREMENTS.length, "every requirement is mapped");
  for (const row of rows) {
    const folded = backgroundConstraints([row.requirement]);
    assert.deepEqual(folded.ios, row.ios, `${row.requirement}: iOS constraints`);
    assert.deepEqual(folded.android, row.android, `${row.requirement}: Android constraints`);
  }
});

test("background: constraint sets fold as the corpus pins", () => {
  type Case = { name: string; requires: string[]; ios: { [k: string]: string }; android: { [k: string]: string } };
  const cases = corpus("constraints")["fold"] as Case[];
  assert.ok(cases.length > 0, "fold corpus must not be empty");
  for (const testCase of cases) {
    const folded = backgroundConstraints(testCase.requires);
    assert.deepEqual(folded.ios, testCase.ios, `${testCase.name}: iOS`);
    assert.deepEqual(folded.android, testCase.android, `${testCase.name}: Android`);
  }
});

test("background: a task does not run while a constraint is unmet", () => {
  type Case = {
    name: string; requires: string[]; state: BackgroundDeviceState;
    expect: { satisfied: boolean; unmet: string[] };
  };
  const cases = corpus("constraints")["satisfy"] as Case[];
  assert.ok(cases.length > 0, "satisfy corpus must not be empty");
  for (const testCase of cases) {
    const unmet = backgroundUnmet(testCase.requires, testCase.state);
    assert.deepEqual(unmet, testCase.expect.unmet, `${testCase.name}: unmet`);
    assert.equal(unmet.length === 0, testCase.expect.satisfied, `${testCase.name}: satisfied`);
  }
});

test("background: the budget countdown agrees with the corpus", () => {
  const doc = corpus("budget");
  assert.deepEqual({ ...BACKGROUND_BUDGET_MS }, doc["budgets"]);

  type Case = { name: string; platform: string; elapsedMs: number; expect: { remainingMs: number; expired: boolean } };
  const cases = doc["countdown"] as Case[];
  assert.ok(cases.length > 0, "countdown corpus must not be empty");
  for (const testCase of cases) {
    const budget = backgroundBudget(testCase.platform, testCase.elapsedMs);
    assert.equal(budget.remainingMs, testCase.expect.remainingMs, `${testCase.name}: remainingMs`);
    assert.equal(budget.expired, testCase.expect.expired, `${testCase.name}: expired`);
  }
});

test("background: the run record agrees with the corpus, kills included", () => {
  type Case = {
    name: string; events: BackgroundRunEvent[];
    expect: { result: string; failure: boolean; running: boolean };
  };
  const cases = corpus("budget")["record"] as Case[];
  assert.ok(cases.length > 0, "record corpus must not be empty");
  for (const testCase of cases) {
    const record = backgroundRunRecord(testCase.events);
    assert.equal(record.result, testCase.expect.result, `${testCase.name}: result`);
    assert.equal(record.failure, testCase.expect.failure, `${testCase.name}: failure`);
    assert.equal(record.running, testCase.expect.running, `${testCase.name}: running`);
  }
});

test("background: run is refused in release, and fails closed", () => {
  type Case = { name: string; channel: string; expect: { allowed: boolean; error?: string } };
  const cases = corpus("budget")["debugGate"] as Case[];
  assert.ok(cases.length > 0, "debugGate corpus must not be empty");
  for (const testCase of cases) {
    const allowed = backgroundRunAllowed(testCase.channel);
    assert.equal(allowed, testCase.expect.allowed, `${testCase.name}: allowed`);
    if (testCase.expect.allowed === false) {
      assert.equal(testCase.expect.error, "debug_only", `${testCase.name}: the refusal is typed`);
    }
  }
});
