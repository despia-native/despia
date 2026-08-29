//
//  systembars-conformance.test.ts — the SHARED SYSTEM-BAR corpus
//  (OpenSource/Conformance/systembars/bars.json) through the TS core, the REFERENCE leg of
//  Core/SystemBars (F17.5). The Kotlin twin (:core SystemBarsConformanceTest) and the Swift
//  twin (Engine/iOS/SystemBars.swift) read the SAME file, so `immersive` cannot mean three
//  different things on three renderers.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  BAR_STYLES, BAR_BEHAVIORS, IMMERSIVE_MODES, BAR_LUMA_THRESHOLD,
  foldBarStyle, foldBarBehavior, foldImmersiveMode,
  parseBarColor, barLuma, barIconsDark, planSystemBars,
  type BarResult, type RawBarRequest,
} from "../src/systembars.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/systembars");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("systembars corpus not found");
    dir = parent;
  }
}

type Doc = {
  vocabulary: { styles: string[]; behaviors: string[]; modes: string[]; lumaThreshold: number };
  style: { name: string; kind: string; raw: unknown; ok: boolean; expect?: string; error?: string }[];
  color: { name: string; raw: string; ok: boolean; expect?: unknown; error?: string }[];
  luma: { name: string; color: string; luma: number; iconsDark: boolean }[];
  transparentIcons: { name: string; color: string; appearanceIsDark: boolean; iconsDark: boolean }[];
  plan: { name: string; raw: RawBarRequest; ok: boolean; expect?: unknown; error?: string }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "bars.json"), "utf-8")) as Doc;

assert.ok(doc.color.length >= 14, "systembars/color corpus is suspiciously small");
assert.ok(doc.plan.length >= 10, "systembars/plan corpus is suspiciously small");

const TOLERANCE = 1e-6;

test("systembars — the pinned vocabulary and threshold", () => {
  assert.deepEqual([...BAR_STYLES], doc.vocabulary.styles);
  assert.deepEqual([...BAR_BEHAVIORS], doc.vocabulary.behaviors);
  assert.deepEqual([...IMMERSIVE_MODES], doc.vocabulary.modes);
  assert.equal(BAR_LUMA_THRESHOLD, doc.vocabulary.lumaThreshold);
});

const FOLDS: Record<string, (raw: unknown) => BarResult<string>> = {
  style: foldBarStyle,
  behavior: foldBarBehavior,
  mode: foldImmersiveMode,
};

for (const c of doc.style) {
  test(`systembars/vocabulary — ${c.name}`, () => {
    const fold = FOLDS[c.kind];
    assert.ok(fold !== undefined, `no fold for ${c.kind}`);
    const got = fold(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.color) {
  test(`systembars/color — ${c.name}`, () => {
    const got = parseBarColor(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.deepEqual({ ...got.value }, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.luma) {
  test(`systembars/luma — ${c.name}`, () => {
    const parsed = parseBarColor(c.color);
    assert.ok(parsed.ok, "corpus colour must parse");
    if (!parsed.ok) return;
    assert.ok(Math.abs(barLuma(parsed.value) - c.luma) <= TOLERANCE,
      `${barLuma(parsed.value)} !~ ${c.luma}`);
    assert.equal(barIconsDark(parsed.value, false), c.iconsDark, "iconsDark");
  });
}

for (const c of doc.transparentIcons) {
  test(`systembars/transparentIcons — ${c.name}`, () => {
    const parsed = parseBarColor(c.color);
    assert.ok(parsed.ok, "corpus colour must parse");
    if (!parsed.ok) return;
    assert.equal(barIconsDark(parsed.value, c.appearanceIsDark), c.iconsDark);
  });
}

for (const c of doc.plan) {
  test(`systembars/plan — ${c.name}`, () => {
    const got = planSystemBars(c.raw);
    assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${(got as { detail?: string }).detail ?? ""})`);
    if (got.ok) assert.deepEqual(JSON.parse(JSON.stringify(got.value)), c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}
