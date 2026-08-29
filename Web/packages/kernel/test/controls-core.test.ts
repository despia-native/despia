//
//  controls-core.test.ts — the SHARED U07 corpora through the TS kernel
//  (OpenSource/Conformance/controls/{gradients,gauge,colorpicker,masked}.json). The Kotlin twin
//  is :core ControlsConformanceTest and the Swift reference is Engine/iOS/ControlsCore.swift,
//  all three reading the SAME files — so `gradientAngle="135deg"` cannot point one way on one
//  renderer and another way on the next, a gauge cannot report a different meter value, and a
//  colour cannot be announced by a different name.
//
//  Missing corpus = loud failure: a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  GRADIENT_TYPES, GRADIENT_DIRECTION_ALIASES, GRADIENT_ANGLE_DEFAULT, GAUGE_STYLES,
  COLOR_NAMES, COLOR_PICKER_MODES,
  resolveGradient, gradientUnitPoints, parseGradientAngle, parseGradientStops, parseMeshPoints,
  resolveGauge, gaugeTintSegment, parseGradientColors,
  parseHexColor, formatHexColor, nearestColorName, resolveSwatches,
  resolveColorPickerMode, webNeedsCustomColorPanel, resolveMask,
} from "../src/controls-core.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/controls");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/controls not found");
    dir = parent;
  }
}

const loaded: { [name: string]: { [key: string]: unknown } } = {};
function corpus(name: string): { [key: string]: unknown } {
  if (loaded[name] === undefined) {
    const doc = JSON.parse(readFileSync(join(corpusDir(), `${name}.json`), "utf-8")) as { [key: string]: unknown };
    assert.equal(doc["version"], 1, `${name}.json: version`);
    loaded[name] = doc;
  }
  return loaded[name]!;
}

function rows<T>(name: string, section: string): T[] {
  const list = corpus(name)[section] as T[] | undefined;
  assert.ok(Array.isArray(list) && list.length > 0, `${name}.${section}: must not be empty`);
  return list;
}

test("gradients: the vocabulary and defaults agree with the corpus", () => {
  const doc = corpus("gradients");
  assert.deepEqual([...GRADIENT_TYPES], doc["types"]);
  assert.deepEqual({ ...GRADIENT_DIRECTION_ALIASES }, doc["directionAliases"]);
  const defaults = doc["defaults"] as { [k: string]: unknown };
  assert.equal(GRADIENT_ANGLE_DEFAULT, defaults["angle"]);
  const bare = resolveGradient({ gradient: "#000|#FFF" });
  assert.equal(bare.type, defaults["type"]);
  assert.equal(bare.angle, defaults["angle"]);
  assert.deepEqual(bare.center, defaults["center"]);
  assert.equal(bare.radius, defaults["radius"]);
});

test("gradients: the resolver agrees with the corpus, case by case", () => {
  type Case = { name: string; attrs: { [k: string]: string }; expect: unknown };
  for (const row of rows<Case>("gradients", "cases")) {
    const got = resolveGradient(row.attrs);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), row.expect, row.name);
  }
});

test("gradients: 0deg points up and the angle increases clockwise", () => {
  const up = gradientUnitPoints(0);
  assert.deepEqual(up, { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } });
  const right = gradientUnitPoints(90);
  assert.deepEqual(right, { start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } });
  const down = gradientUnitPoints(180);
  assert.deepEqual(down, { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } });
  const left = gradientUnitPoints(270);
  assert.deepEqual(left, { start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 } });
});

test("gradients: the three legacy direction tokens keep their exact meaning", () => {
  for (const [token, angle] of Object.entries(GRADIENT_DIRECTION_ALIASES)) {
    assert.equal(parseGradientAngle(token), angle, token);
    assert.equal(resolveGradient({ gradient: "#000|#FFF", gradientDir: token }).angle, angle, token);
  }
  // The default with neither declared is still vertical: no shipped app moves a pixel.
  assert.equal(resolveGradient({ gradient: "#000|#FFF" }).angle, GRADIENT_DIRECTION_ALIASES["vertical"]);
});

test("gradients: stops clamp, stay monotonic, and fall back on a count mismatch", () => {
  assert.deepEqual(parseGradientStops(null, 3), [0, 0.5, 1]);
  assert.deepEqual(parseGradientStops("0,0.25,1", 3), [0, 0.25, 1]);
  assert.deepEqual(parseGradientStops("0.9,0.1,1", 3), [0.9, 0.9, 1]);
  assert.deepEqual(parseGradientStops("0,1", 3), [0, 0.5, 1]);
  assert.deepEqual(parseGradientStops("nope,1,2", 3), [0, 0.5, 1]);
  assert.deepEqual(parseGradientStops(null, 1), [0]);
  assert.deepEqual(parseGradientStops(null, 0), []);
});

test("gradients: mesh parses a rectangular grid and refuses a ragged one", () => {
  const grid = parseMeshPoints("0 0 #F00, 1 0 #0F0; 0 1 #00F, 1 1 #FF0");
  assert.ok(grid !== null);
  assert.equal(grid!.columns, 2);
  assert.equal(grid!.rows, 2);
  assert.equal(grid!.points.length, 4);
  assert.equal(parseMeshPoints("0 0 #F00, 1 0 #0F0; 0 1 #00F"), null, "ragged");
  assert.equal(parseMeshPoints("0 0 #F00, 1 0 #0F0"), null, "one row is not a mesh");
  assert.equal(parseMeshPoints("0 0 #F00; 0 1 #00F"), null, "one column is not a mesh");
  assert.equal(parseMeshPoints("0 0; 0 1"), null, "a point without a colour");
  // A mesh that cannot be parsed degrades to linear rather than painting nothing.
  const degraded = resolveGradient({ gradientType: "mesh", gradient: "#F00|#00F", gradientPoints: "0 0 #F00" });
  assert.equal(degraded.type, "linear");
  assert.equal(degraded.valid, true);
});

test("gradients: the mesh fallback is declared, not incidental", () => {
  const resolved = resolveGradient({
    gradientType: "mesh",
    gradientPoints: "0 0 #6366F1, 1 0 #EC4899; 0 1 #14B8A6, 1 1 #F59E0B",
  });
  assert.equal(resolved.type, "mesh");
  assert.ok(resolved.meshFallback !== null);
  assert.equal(resolved.meshFallback!.layers.length, 4);
  for (const layer of resolved.meshFallback!.layers) assert.equal(layer.radius, 0.75);
  assert.equal(resolved.colors.length, 4, "the mesh colours ARE the colour list");
});

test("gauge: the style metrics agree with the corpus", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(GAUGE_STYLES)), corpus("gauge")["styles"]);
});

test("gauge: value-to-arc and meter semantics agree with the corpus", () => {
  type Case = {
    name: string; value: number; min: number; max: number;
    style: string | null; currentLabel: string | null; expect: unknown;
  };
  for (const row of rows<Case>("gauge", "cases")) {
    const got = resolveGauge({
      value: row.value, min: row.min, max: row.max,
      style: row.style, currentLabel: row.currentLabel,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(got)), row.expect, row.name);
  }
});

test("gauge: the value-following tint agrees with the corpus", () => {
  type Case = { name: string; tint: string; stops: string | null; fraction: number; expect: unknown };
  for (const row of rows<Case>("gauge", "tint")) {
    const colors = parseGradientColors(row.tint);
    const stops = parseGradientStops(row.stops, colors.length);
    assert.deepEqual(gaugeTintSegment(colors, stops, row.fraction), row.expect, row.name);
  }
  assert.equal(gaugeTintSegment([], [], 0.5), null);
});

test("gauge: an empty or inverted range is a zero fraction, never NaN", () => {
  for (const [min, max] of [[10, 10], [10, 5], [0, 0]]) {
    const got = resolveGauge({ value: 7, min, max, style: "circular" });
    assert.equal(got.fraction, 0);
    assert.equal(Number.isFinite(got.valueAngle), true);
  }
});

test("colorpicker: the name table and modes agree with the corpus", () => {
  assert.deepEqual(COLOR_NAMES.map((entry) => ({ name: entry.name, hex: entry.hex })), corpus("colorpicker")["names"]);
  assert.deepEqual([...COLOR_PICKER_MODES], corpus("colorpicker")["modes"]);
});

test("colorpicker: the hex round-trip agrees with the corpus", () => {
  type Case = {
    name: string; input: string;
    expect: { rgba: { r: number; g: number; b: number; a: number }; hex: string; hexWithAlpha: string; name: string } | null;
  };
  for (const row of rows<Case>("colorpicker", "parse")) {
    const parsed = parseHexColor(row.input);
    if (row.expect === null) { assert.equal(parsed, null, row.name); continue; }
    assert.ok(parsed !== null, row.name);
    assert.deepEqual(parsed, row.expect.rgba, `${row.name}: channels`);
    assert.equal(formatHexColor(parsed!, false), row.expect.hex, `${row.name}: hex`);
    assert.equal(formatHexColor(parsed!, true), row.expect.hexWithAlpha, `${row.name}: hex+alpha`);
    assert.equal(nearestColorName(parsed!), row.expect.name, `${row.name}: name`);
    // A round-trip through the formatter reparses to the same channels.
    assert.deepEqual(parseHexColor(formatHexColor(parsed!, true)), row.expect.rgba, `${row.name}: round-trip`);
  }
});

test("colorpicker: the announced name agrees with the corpus", () => {
  type Case = { name: string; input: string; expect: string };
  for (const row of rows<Case>("colorpicker", "nearestName")) {
    assert.equal(nearestColorName(parseHexColor(row.input)!), row.expect, row.name);
  }
});

test("colorpicker: swatch normalisation agrees with the corpus", () => {
  type Case = { name: string; swatches: string | null; alpha: boolean; expect: string[] };
  for (const row of rows<Case>("colorpicker", "swatches")) {
    assert.deepEqual(resolveSwatches(row.swatches, row.alpha), row.expect, row.name);
  }
  const many = Array.from({ length: 40 }, (_, index) => `#${index.toString(16).padStart(6, "0")}`).join(",");
  assert.equal(resolveSwatches(many).length, 24, "the list caps at 24");
});

test("colorpicker: the mode default and the web panel gate agree with the corpus", () => {
  type Case = { mode: string | null; alpha: boolean; swatchCount: number; expect: { mode: string; webNeedsCustomPanel: boolean } };
  for (const row of rows<Case>("colorpicker", "mode")) {
    assert.equal(resolveColorPickerMode(row.mode, row.alpha, row.swatchCount), row.expect.mode,
      `mode=${row.mode} alpha=${row.alpha} n=${row.swatchCount}`);
    assert.equal(webNeedsCustomColorPanel(row.alpha, row.swatchCount), row.expect.webNeedsCustomPanel);
  }
});

test("masked: the mode fold agrees with the corpus", () => {
  type Case = { name: string; mode: string | null; invert: unknown; expect: unknown };
  for (const row of rows<Case>("masked", "cases")) {
    const got = resolveMask(row.mode, row.invert as boolean | string | null);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), row.expect, row.name);
  }
});

test("masked: the mask child is always hidden and the content keeps its semantics", () => {
  for (const mode of [null, "alpha", "luminance", "bogus"]) {
    for (const invert of [true, false]) {
      const got = resolveMask(mode, invert);
      assert.equal(got.maskChildHidden, true);
      assert.equal(got.contentSemanticsPreserved, true);
    }
  }
});
