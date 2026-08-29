//
//  lightsensor-conformance.test.ts — the SHARED AMBIENT-LIGHT corpus
//  (OpenSource/Conformance/light/ambient.json) through the TS core, the REFERENCE leg of
//  Core/LightSensor (F17.9). The Kotlin twin (:core LightSensorConformanceTest) and the Swift
//  twin (Engine/iOS/LightSensor.swift) read the SAME file, so "dark room" means the same
//  number of lux on every renderer and the stream costs the same battery.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  LIGHT_MIN_INTERVAL_MS, LIGHT_DEFAULT_INTERVAL_MS, LIGHT_MAX_INTERVAL_MS,
  LIGHT_MIN_ABSOLUTE_CHANGE, LIGHT_MIN_RELATIVE_CHANGE,
  LIGHT_CATEGORIES, LIGHT_THRESHOLDS,
  luxCategory, clampLightInterval, shouldEmitLux, lightSample,
} from "../src/lightsensor.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/light");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("light corpus not found");
    dir = parent;
  }
}

type Doc = {
  limits: Record<string, number>;
  categories: string[];
  thresholds: number[];
  category: { name: string; lux: number; expect: string }[];
  interval: { name: string; raw: unknown; expect: number }[];
  emit: { name: string; previous: number | null; next: unknown; expect: boolean }[];
  sample: { name: string; lux: number; expect: { lux: number; category: string } }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "ambient.json"), "utf-8")) as Doc;

assert.ok(doc.category.length >= 12, "light/category corpus is suspiciously small");
assert.ok(doc.emit.length >= 10, "light/emit corpus is suspiciously small");

test("light — the pinned bands and thresholds", () => {
  assert.equal(LIGHT_MIN_INTERVAL_MS, doc.limits["minIntervalMs"]);
  assert.equal(LIGHT_DEFAULT_INTERVAL_MS, doc.limits["defaultIntervalMs"]);
  assert.equal(LIGHT_MAX_INTERVAL_MS, doc.limits["maxIntervalMs"]);
  assert.equal(LIGHT_MIN_ABSOLUTE_CHANGE, doc.limits["minAbsoluteChange"]);
  assert.equal(LIGHT_MIN_RELATIVE_CHANGE, doc.limits["minRelativeChange"]);
  assert.deepEqual([...LIGHT_CATEGORIES], doc.categories);
  assert.deepEqual([...LIGHT_THRESHOLDS], doc.thresholds);
});

for (const c of doc.category) {
  test(`light/category — ${c.name}`, () => {
    assert.equal(luxCategory(c.lux), c.expect);
  });
}

for (const c of doc.interval) {
  test(`light/interval — ${c.name}`, () => {
    assert.equal(clampLightInterval(c.raw), c.expect);
  });
}

for (const c of doc.emit) {
  test(`light/emit — ${c.name}`, () => {
    assert.equal(shouldEmitLux(c.previous, c.next), c.expect);
  });
}

for (const c of doc.sample) {
  test(`light/sample — ${c.name}`, () => {
    assert.deepEqual({ ...lightSample(c.lux) }, c.expect);
  });
}
