//
//  sheet-gesture.test.ts — the iOS sheet RELEASE POLICY (overlay-controls.ts
//  `sheetRelease`). The contract under test: a sheet settles the way UIKit's does — a
//  flick outruns distance, distance decides when the flick is slow, an upward gesture
//  steps to a larger detent, and a downward gesture from the SMALLEST detent dismisses
//  instead of rubber-banding into nothing.
//
//  Pure policy only: the pointer plumbing lives in the factory and is exercised by the
//  browser oracle.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { sheetRelease } from "../src/overlay-controls.ts";

const H = 600;            // a representative panel height
const rest = { dy: 0, velocity: 0, height: H };

test("a gesture that goes nowhere settles back on its own detent", () => {
  assert.deepEqual(sheetRelease({ ...rest, index: 1, count: 2 }), { index: 1, dismiss: false });
  assert.deepEqual(sheetRelease({ ...rest, dy: 20, index: 1, count: 2 }), { index: 1, dismiss: false });
});

test("a downward flick outruns distance", () => {
  // barely moved, but thrown: still steps down
  const out = sheetRelease({ dy: 12, velocity: 1.2, height: H, index: 1, count: 2 });
  assert.deepEqual(out, { index: 0, dismiss: false });
});

test("distance alone steps down when the flick is slow", () => {
  const out = sheetRelease({ dy: H * 0.4, velocity: 0.05, height: H, index: 1, count: 2 });
  assert.deepEqual(out, { index: 0, dismiss: false });
});

test("down from the SMALLEST detent dismisses", () => {
  assert.deepEqual(sheetRelease({ dy: 200, velocity: 0, height: H, index: 0, count: 2 }),
    { index: 0, dismiss: true });
  assert.deepEqual(sheetRelease({ dy: 8, velocity: 1.5, height: H, index: 0, count: 2 }),
    { index: 0, dismiss: true });
});

test("upward steps to a larger detent and stops at the largest", () => {
  assert.deepEqual(sheetRelease({ dy: -200, velocity: 0, height: H, index: 0, count: 2 }),
    { index: 1, dismiss: false });
  assert.deepEqual(sheetRelease({ dy: -200, velocity: 0, height: H, index: 1, count: 2 }),
    { index: 1, dismiss: false });
});

test("a single-detent sheet dismisses downward and never grows", () => {
  assert.deepEqual(sheetRelease({ dy: 300, velocity: 0, height: H, index: 0, count: 1 }),
    { index: 0, dismiss: true });
  assert.deepEqual(sheetRelease({ dy: -300, velocity: 0, height: H, index: 0, count: 1 }),
    { index: 0, dismiss: false });
});

test("the travel floor keeps a short sheet dismissible", () => {
  // 48px floor: on a 120px sheet, 25% would be 30px — too twitchy to be intentional
  assert.deepEqual(sheetRelease({ dy: 40, velocity: 0, height: 120, index: 0, count: 2 }),
    { index: 0, dismiss: false });
  assert.deepEqual(sheetRelease({ dy: 60, velocity: 0, height: 120, index: 0, count: 2 }),
    { index: 0, dismiss: true });
});
