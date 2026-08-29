//
//  orientation-binding-conformance.test.ts — the SHARED `lockOrientation=` router-binding corpus
//  through the TS kernel (OpenSource/Conformance/input/orientation-binding.json). The Kotlin twin
//  (:core OrientationBindingConformanceTest) and the Swift reference
//  (OrientationBindingConformance, record lane) run the SAME file.
//
//  The corpus drives the reconcile AND feeds its plan into the real OrientationClaimStack, so the
//  two halves of the feature are pinned against each other: a plan that looks right but leaves
//  the stack holding a dead claim fails here, not on a device.
//
//  Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { OrientationClaimStack, ORIENTATION_IMPERATIVE_ID } from "../src/orientation.ts";
import {
  orientationClaimPlan, orientationFrameSurface, orientationModalSurface,
  type OrientationOp, type OrientationSurface,
} from "../src/orientation-binding.ts";

type Step = {
  publish: string;
  live: OrientationSurface[];
  expectOps: OrientationOp[];
  expectLedger: OrientationSurface[];
  expectEffective: string | null;
};
type ReconcileCase = { name: string; imperative?: string; steps: Step[] };

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
  const doc = JSON.parse(readFileSync(join(corpusDir(), "orientation-binding.json"), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, "orientation-binding.json: version");
  return doc;
}

test("lockOrientation: the surface-id derivation agrees with the corpus", () => {
  const ids = corpus()["surfaceIds"] as { frame: string; modal: string };
  assert.equal(orientationFrameSurface(4), ids.frame.replace("<frameId>", "4"));
  assert.equal(orientationModalSurface(4), ids.modal.replace("<modalId>", "4"));
  assert.notEqual(orientationFrameSurface(4), orientationModalSurface(4),
                  "a frame and a presentation with the same id must not collide");
});

test("lockOrientation: the router reconcile agrees with the corpus", () => {
  const cases = corpus()["reconcile"] as ReconcileCase[];
  assert.ok(cases.length > 0, "reconcile corpus must not be empty");
  for (const testCase of cases) {
    // the SHIPPED claim stack, driven by the plan — the two halves pinned against each other
    const stack = new OrientationClaimStack();
    if (testCase.imperative !== undefined) stack.claim(ORIENTATION_IMPERATIVE_ID, testCase.imperative);
    let ledger: OrientationSurface[] = [];

    testCase.steps.forEach((step, index) => {
      const at = `${testCase.name}: publish ${index} (${step.publish})`;
      const plan = orientationClaimPlan(step.live, ledger);
      assert.deepEqual(plan.ops, step.expectOps, `${at}: ops`);
      assert.deepEqual(plan.ledger, step.expectLedger, `${at}: ledger`);

      for (const op of plan.ops) {
        if (op.op === "release") stack.release(op.surface);
        else stack.claim(op.surface, op.to);
      }
      assert.equal(stack.effective, step.expectEffective, `${at}: the stack's effective lock`);

      // the reconcile must be a FIXED POINT: re-running it against the same live set changes
      // nothing. This is the becomeActive re-assert, and the reason a covered screen is safe.
      const again = orientationClaimPlan(step.live, plan.ledger);
      assert.deepEqual(again.ops, [], `${at}: re-running the reconcile must be a no-op`);
      ledger = plan.ledger;
    });
  }
});
