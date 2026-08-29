//
//  vendor-session-conformance.test.ts — the SHARED inline-vendor-surface corpus through
//  the TS kernel (OpenSource/Conformance/inline-surfaces/stripe.json). The Kotlin twin
//  (:core VendorSessionConformanceTest) and the Swift twin (Engine/iOS/VendorSession.swift,
//  record lane) run the SAME file, so `session=` cannot accept a literal on one renderer
//  and refuse it on another, and a payment cannot be startable twice on one renderer and
//  once on the others.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts,
//  and the drift here is a double charge.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  resolveSessionRef, secretFamilyIn,
  VENDOR_VIEWS, VendorSessionMachine, type VendorStep, type VendorView,
  CARD_PARTS, CARD_INCOMPLETE_MESSAGES, CARD_REQUIRED_MESSAGE, cardFieldFold, cardFormField,
  type CardPartState,
  vendorRetainKey, vendorRetainReconcile,
} from "../src/vendor-session.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/inline-surfaces");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/inline-surfaces not found");
    dir = parent;
  }
}

function corpus(): { [k: string]: any } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), "stripe.json"), "utf-8")) as { [k: string]: any };
  assert.equal(doc["version"], 1, "stripe.json: version");
  return doc;
}

// ── 1 · the secret boundary ──────────────────────────────────────────────────────────

test("vendor: the session-reference resolver agrees with the corpus", () => {
  const section = corpus()["sessionRef"];
  const cases = section["cases"] as Array<{ name: string; value: string | null; expect: any }>;
  assert.ok(cases.length > 0, "sessionRef corpus must not be empty");
  for (const testCase of cases) {
    const result = resolveSessionRef(testCase.value);
    const expected = testCase.expect;

    if ("error" in expected) {
      assert.equal(result.ok, false, `${testCase.name}: expected refusal ${expected.error}, got ${JSON.stringify(result)}`);
      if (result.ok !== false) continue;
      assert.equal(result.error, expected.error, `${testCase.name}: refusal code`);
      assert.equal(result.family ?? undefined, expected.family ?? undefined, `${testCase.name}: credential family`);
      continue;
    }

    assert.equal(result.ok, true, `${testCase.name}: expected a resolved reference, got ${JSON.stringify(result)}`);
    if (result.ok !== true) continue;
    assert.equal(result.value.kind, expected.kind, `${testCase.name}: kind`);
    assert.equal(result.value.path, expected.path, `${testCase.name}: path`);
  }
});

test("vendor: the declared vocabularies agree with the corpus", () => {
  const section = corpus()["sessionRef"];
  const kinds = new Set(section["kinds"] as string[]);
  const refusals = new Set(section["refusals"] as string[]);
  const families = new Set(section["families"] as string[]);
  for (const testCase of section["cases"] as Array<{ expect: any }>) {
    if ("error" in testCase.expect) {
      assert.ok(refusals.has(testCase.expect.error), `undeclared refusal ${testCase.expect.error}`);
      if (testCase.expect.family !== undefined) {
        assert.ok(families.has(testCase.expect.family), `undeclared family ${testCase.expect.family}`);
      }
    } else {
      assert.ok(kinds.has(testCase.expect.kind), `undeclared kind ${testCase.expect.kind}`);
    }
  }
});

test("vendor: every declared credential family is reachable, and a reference carries none", () => {
  // The allowlist is the rule; family detection only sharpens the message. Both halves
  // are load-bearing, so both are asserted: no declared family is dead vocabulary, and a
  // legal reference never trips the detector.
  const section = corpus()["sessionRef"];
  const reached = new Set<string>();
  for (const testCase of section["cases"] as Array<{ value: string | null; expect: any }>) {
    if (testCase.expect.family !== undefined) reached.add(testCase.expect.family);
    if (testCase.expect.kind !== undefined && testCase.value !== null) {
      assert.equal(secretFamilyIn(testCase.value), null, `a permitted reference must carry no credential: ${testCase.value}`);
    }
  }
  for (const family of section["families"] as string[]) {
    assert.ok(reached.has(family), `family ${family} is declared but no corpus row pins it`);
  }
});

// ── 2 · one session, two views ───────────────────────────────────────────────────────

test("vendor: the canonical view order agrees with the corpus", () => {
  assert.deepEqual([...VENDOR_VIEWS], corpus()["machine"]["views"]);
});

test("vendor: the component/overlay state machine agrees with the corpus", () => {
  const section = corpus()["machine"];
  const states = new Set(section["states"] as string[]);
  const refusals = new Set(section["refusals"] as string[]);
  const cases = section["cases"] as Array<{ name: string; steps: VendorStep[]; expect: any[] }>;
  assert.ok(cases.length > 0, "machine corpus must not be empty");

  for (const testCase of cases) {
    assert.equal(testCase.steps.length, testCase.expect.length, `${testCase.name}: one expectation per step`);
    const machine = new VendorSessionMachine();
    testCase.steps.forEach((step, index) => {
      const result = machine.step(step);
      const expected = testCase.expect[index];
      const where = `${testCase.name}: step ${index} (${step.op})`;

      assert.ok(states.has(expected.state), `${where}: undeclared state ${expected.state}`);
      if ("error" in expected) {
        assert.equal(result.ok, false, `${where}: expected refusal ${expected.error}, got ${JSON.stringify(result)}`);
        if (result.ok !== false) return;
        assert.ok(refusals.has(expected.error), `${where}: undeclared refusal ${expected.error}`);
        assert.equal(result.error, expected.error, `${where}: refusal code`);
        assert.equal(result.state, expected.state, `${where}: state after a refusal`);
        assert.equal(machine.state, expected.state, `${where}: a refusal never moves the machine`);
        return;
      }

      assert.equal(result.ok, true, `${where}: expected a step, got ${JSON.stringify(result)}`);
      if (result.ok !== true) return;
      assert.equal(result.state, expected.state, `${where}: state`);
      assert.deepEqual([...result.notify], expected.notify, `${where}: notify audience`);
      assert.equal(result.attempts, expected.attempts, `${where}: attempts`);
      assert.equal(result.outcome ?? undefined, expected.outcome ?? undefined, `${where}: outcome`);
      assert.equal(result.by ?? undefined, expected.by ?? undefined, `${where}: originating view`);
      assert.equal(result.code ?? undefined, expected.code ?? undefined, `${where}: failure code`);
      assert.equal(machine.state, expected.state, `${where}: state is stable after the step`);
    });
  }
});

test("vendor: an outcome always reaches the face that started it, attached or not", () => {
  // The law behind the corpus rows, asserted directly so a future edit to the audience
  // rule fails here rather than only in one scenario: the originator is never dropped.
  for (const originator of VENDOR_VIEWS as VendorView[]) {
    const machine = new VendorSessionMachine();
    machine.step({ op: "open" });
    machine.step({ op: "attach", view: originator });
    machine.step({ op: "start", view: originator });
    machine.step({ op: "detach", view: originator });
    const settled = machine.step({ op: "complete" });
    assert.equal(settled.ok, true);
    if (settled.ok !== true) continue;
    assert.ok(settled.notify.includes(originator), `${originator}: a detached originator is still owed its outcome`);
  }
});

// ── 3 · the field-validity fold ──────────────────────────────────────────────────────

test("vendor: the card part order and messages agree with the corpus", () => {
  const section = corpus()["cardField"];
  assert.deepEqual([...CARD_PARTS], section["partOrder"]);
  assert.deepEqual({ ...CARD_INCOMPLETE_MESSAGES }, section["incompleteMessages"]);
  assert.equal(CARD_REQUIRED_MESSAGE, section["requiredMessage"]);
});

test("vendor: the field-validity fold agrees with the corpus", () => {
  const cases = corpus()["cardField"]["cases"] as Array<{
    name: string; required: boolean; parts: CardPartState[]; expect: any;
  }>;
  assert.ok(cases.length > 0, "cardField corpus must not be empty");
  for (const testCase of cases) {
    const fold = cardFieldFold(testCase.parts, testCase.required);
    assert.deepEqual({ ...fold }, testCase.expect, testCase.name);
    assert.ok(fold.value === "" || fold.value === "complete",
              `${testCase.name}: the folded value is a sentinel, never card data`);
  }
});

test("vendor: the folded form field agrees with the corpus", () => {
  const cases = corpus()["cardField"]["formField"]["cases"] as Array<{
    name: string; fieldName: string; required: boolean; parts: CardPartState[]; expect: any;
  }>;
  assert.ok(cases.length > 0, "formField corpus must not be empty");
  for (const testCase of cases) {
    const field = cardFormField(testCase.fieldName, cardFieldFold(testCase.parts, testCase.required));
    assert.deepEqual({ ...field }, testCase.expect, testCase.name);
  }
});

// ── 4 · keyed identity ───────────────────────────────────────────────────────────────

test("vendor: the retain key agrees with the corpus", () => {
  const cases = corpus()["retain"]["keys"] as Array<{ name: string; input: any; expect: string }>;
  assert.ok(cases.length > 0, "retain key corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(vendorRetainKey(testCase.input), testCase.expect, testCase.name);
  }
});

test("vendor: the retain reconcile agrees with the corpus", () => {
  const cases = corpus()["retain"]["reconcile"] as Array<{
    name: string; previous: string[]; next: string[]; expect: any;
  }>;
  assert.ok(cases.length > 0, "retain reconcile corpus must not be empty");
  for (const testCase of cases) {
    const diff = vendorRetainReconcile(testCase.previous, testCase.next);
    assert.deepEqual({ mounted: [...diff.mounted], retained: [...diff.retained], released: [...diff.released] },
                     testCase.expect, testCase.name);
  }
});

test("vendor: a retain key never carries the session value", () => {
  // Keys land in diff logs and render traces. The key derives from the session's
  // REFERENCE path, so even a misconfigured build cannot log a credential through it.
  const key = vendorRetainKey({ tag: "stripe.CardInput", session: "dsx.module.stripe.context.session", index: 0 });
  assert.equal(secretFamilyIn(key), null);
  assert.ok(!key.includes("pk_") && !key.includes("sk_"));
});
