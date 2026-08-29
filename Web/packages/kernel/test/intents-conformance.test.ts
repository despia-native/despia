//
//  intents-conformance.test.ts — the SHARED INTENT corpus
//  (OpenSource/Conformance/intents/launch.json) through the TS core, the REFERENCE leg of
//  Core/Intents (F17.6). The Kotlin twin (:core IntentsConformanceTest) and the Swift twin
//  (Engine/iOS/Intents.swift) read the SAME file, so the refusals a cross-platform caller sees
//  are identical and the generated <queries> block cannot drift from the code that needs it.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  INTENT_FLAGS, INTENT_FLAG_ORDER,
  normalizeIntentAction, normalizeIntentPackage, normalizeIntentData, normalizeIntentType,
  normalizeIntentExtras, foldIntentFlags, normalizeIntent, intentQueries,
  type IntentResult, type IntentSpec, type RawIntent,
} from "../src/intents.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/intents");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("intents corpus not found");
    dir = parent;
  }
}

type StringCase = { name: string; raw: unknown; ok: boolean; expect?: string; error?: string };
type Doc = {
  flagValues: Record<string, number>;
  flagOrder: string[];
  action: StringCase[];
  package: StringCase[];
  data: StringCase[];
  type: StringCase[];
  extras: { name: string; raw: unknown; ok: boolean; expect?: unknown; error?: string }[];
  flags: { name: string; raw: unknown; ok: boolean; mask?: number; words?: string[]; error?: string }[];
  intent: { name: string; raw: RawIntent; ok: boolean; expect?: unknown; error?: string }[];
  queries: {
    name: string;
    specs: { action: string; data: string; type: string; package: string }[];
    expect: unknown[];
  }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "launch.json"), "utf-8")) as Doc;

assert.ok(doc.action.length >= 8, "intents/action corpus is suspiciously small");
assert.ok(doc.intent.length >= 6 && doc.queries.length >= 5, "intents corpus is suspiciously small");

test("intents — the ABI-frozen flag values and their canonical order", () => {
  assert.deepEqual({ ...INTENT_FLAGS }, doc.flagValues);
  assert.deepEqual([...INTENT_FLAG_ORDER], doc.flagOrder);
});

function stringCases(label: string, cases: StringCase[], fn: (raw: unknown) => IntentResult<string>): void {
  for (const c of cases) {
    test(`intents/${label} — ${c.name}`, () => {
      const got = fn(c.raw);
      assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${(got as { detail?: string }).detail ?? ""})`);
      if (got.ok) assert.equal(got.value, c.expect);
      else assert.equal(got.error, c.error, "error");
    });
  }
}

stringCases("action", doc.action, normalizeIntentAction);
stringCases("package", doc.package, normalizeIntentPackage);
stringCases("data", doc.data, normalizeIntentData);
stringCases("type", doc.type, normalizeIntentType);

for (const c of doc.extras) {
  test(`intents/extras — ${c.name}`, () => {
    const got = normalizeIntentExtras(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.deepEqual(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.flags) {
  test(`intents/flags — ${c.name}`, () => {
    const got = foldIntentFlags(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) {
      assert.equal(got.value.mask, c.mask, "mask");
      assert.deepEqual([...got.value.words], c.words);
    } else {
      assert.equal(got.error, c.error, "error");
    }
  });
}

for (const c of doc.intent) {
  test(`intents/intent — ${c.name}`, () => {
    const got = normalizeIntent(c.raw);
    assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${(got as { detail?: string }).detail ?? ""})`);
    if (got.ok) assert.deepEqual(JSON.parse(JSON.stringify(got.value)), c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.queries) {
  test(`intents/queries — ${c.name}`, () => {
    const specs: IntentSpec[] = c.specs.map((s) => {
      const built = normalizeIntent({ action: s.action, data: s.data, type: s.type, package: s.package });
      assert.ok(built.ok, `corpus spec must normalize: ${s.action}`);
      if (!built.ok) throw new Error("unreachable");
      return built.value;
    });
    assert.deepEqual(JSON.parse(JSON.stringify(intentQueries(specs))), c.expect);
  });
}
