//
//  fonts-conformance.test.ts — the SHARED font face-selection corpus through the TS kernel
//  (OpenSource/Conformance/fonts/matching.json). The Kotlin twin (:core FontsConformanceTest)
//  and the Swift twin (StackFonts) run the SAME file, so a type ramp cannot come out semibold on
//  one renderer and bold on another.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  matchFontWeight, selectFontFace, parseFontVariation, resolveFontVariation, parseFontFeatures,
  type FontFace,
} from "../src/index.ts";

function corpus(): { [k: string]: unknown } {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/fonts/matching.json");
    if (existsSync(candidate)) {
      const doc = JSON.parse(readFileSync(candidate, "utf-8")) as { [k: string]: unknown };
      assert.equal(doc["version"], 1, "matching.json: version");
      return doc;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/fonts/matching.json not found");
    dir = parent;
  }
}

test("fonts: the CSS weight-matching algorithm agrees with the corpus", () => {
  const cases = corpus()["matching"] as { name: string; faces: number[]; request: number; expect: number | null }[];
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.equal(matchFontWeight(c.faces, c.request), c.expect, c.name);
  }
});

test("fonts: slant selection and italic synthesis agree with the corpus", () => {
  type Case = {
    name: string;
    faces: { w: number; i: boolean }[];
    request: { w: number; i: boolean };
    expect: { w: number; i: boolean; synthesized: boolean } | null;
  };
  const cases = corpus()["italic"] as Case[];
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const faces: FontFace[] = c.faces.map((f) => ({ weight: f.w, italic: f.i }));
    const got = selectFontFace(faces, c.request.w, c.request.i);
    if (c.expect === null) { assert.equal(got, null, c.name); continue; }
    assert.ok(got, `${c.name}: expected a selection`);
    assert.equal(got.face.weight, c.expect.w, `${c.name}: weight`);
    assert.equal(got.face.italic, c.expect.i, `${c.name}: italic`);
    assert.equal(got.synthesized, c.expect.synthesized, `${c.name}: synthesized`);
  }
});

test("fonts: variable-axis clamping agrees with the corpus", () => {
  type Case = {
    name: string;
    axes: { [k: string]: [number, number] } | null;
    request: { [k: string]: number };
    expect: { applied: { [k: string]: number }; clamped?: string[]; dropped?: string[] };
  };
  const cases = corpus()["variation"] as Case[];
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const got = resolveFontVariation(c.axes, c.request);
    assert.deepEqual(got.applied, c.expect.applied, `${c.name}: applied`);
    assert.deepEqual([...got.clamped], c.expect.clamped ?? [], `${c.name}: clamped`);
    assert.deepEqual([...got.dropped], c.expect.dropped ?? [], `${c.name}: dropped`);
  }
});

test("fonts: the fontVariation parser agrees with the corpus", () => {
  const cases = corpus()["parse"] as { name: string; input: string; expect: { [k: string]: number } }[];
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.deepEqual(parseFontVariation(c.input), c.expect, c.name);
  }
});

test("fonts: the fontFeature parser agrees with the corpus", () => {
  const cases = corpus()["features"] as { name: string; input: string; expect: string[] }[];
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.deepEqual(parseFontFeatures(c.input), c.expect, c.name);
  }
});
