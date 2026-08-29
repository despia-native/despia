//
//  gestures.test.ts - the U02 gesture conformance runner on the TS renderer.
//
//  Executes OpenSource/Conformance/input/gestures.json verbatim through the pure core in
//  ../src/gestures.ts. The Kotlin twin (StackGestures.kt + GesturesConformanceTest) and
//  the Swift reference (StackGestures.swift, the record lane) run the SAME file, so
//  recognition thresholds, velocity derivation, swipe classification, transform
//  accumulation, the axis claim and the composition resolver cannot drift between
//  renderers. A missing or empty section is a loud failure, never a silent skip.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TAP_SLOP, AXIS_SLOP, SWIPE_MIN_DISTANCE, SWIPE_MIN_VELOCITY, VELOCITY_WINDOW_MS, VELOCITY_SAMPLES,
  PINCH_SLOP, ROTATE_SLOP, GESTURE_PRECEDENCE, CONTINUOUS_KINDS, DIRECTIONAL_KINDS, GESTURE_DEGRADATION,
  velocity1D, velocity2D, PressTracker, HoverMotion, resolveSwipe, claimAxis, TransformTracker,
  dragPayload, resolveComposition,
  type Sample1D, type Sample2D, type TransformPoint, type GestureNode, type GestureAttempt,
} from "../src/gestures.ts";

type Section<T> = { _note?: string; cases: T[] };
type Corpus = {
  version: number;
  constants: {
    tapSlop: number; axisSlop: number; swipeMinDistance: number; swipeMinVelocity: number;
    velocityWindowMs: number; velocitySamples: number; pinchSlop: number; rotateSlop: number;
    precedence: string[]; continuous: string[]; directional: string[]; phases: string[]; tolerance: number;
  };
  velocity: Section<{ name: string; samples: Sample1D[]; expect: number }>;
  velocity2D: Section<{ name: string; samples: Sample2D[]; expect: { vx: number; vy: number } }>;
  press: Section<{
    name: string;
    events: Array<{ type: string; id?: string; x?: number; y?: number }>;
    expect: string[]; expectDragging: boolean;
  }>;
  hover: Section<{
    name: string;
    events: Array<{ type: string; hoverCapable?: boolean; x?: number; y?: number }>;
    expect: Array<{ action: string; x: number; y: number }>;
  }>;
  swipe: Section<{
    name: string; dx: number; dy: number; vx: number; vy: number; axis: string;
    expect: { direction: string; velocity: number; distance: number } | null;
  }>;
  axisClaim: Section<{ name: string; axis: string; dx: number; dy: number; expect: string }>;
  transform: Section<{
    name: string;
    events: Array<{ type: string; t?: number; points?: TransformPoint[] }>;
    expect: Array<Record<string, number | string>>;
  }>;
  drag: Section<{
    name: string; width: number; height: number; x: number; y: number; startX: number; startY: number;
    samples: Sample2D[]; phase: string; expect: Record<string, number | string>;
  }>;
  composition: Section<{
    name: string; tree: GestureNode[]; attempt: GestureAttempt;
    expect: { fire: Array<{ node: string; kind: string }>; blocked: Array<{ node: string; kind: string; reason: string }> };
  }>;
  degradation: { _note?: string; rows: Array<Record<string, string>> };
};

const corpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/gestures.json", import.meta.url), "utf8",
)) as Corpus;

assert.equal(corpus.version, 1, "gestures.json version");
const TOLERANCE = corpus.constants.tolerance;

function close(actual: number, expected: number, label: string): void {
  assert.ok(Number.isFinite(actual), `${label}: ${actual} is not finite`);
  assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${label}: ${actual} != ${expected}`);
}

function nonEmpty<T>(section: Section<T>, name: string): T[] {
  assert.ok(Array.isArray(section?.cases) && section.cases.length > 0, `${name}: empty corpus section`);
  return section.cases;
}

test("gestures: the recognition constants match the corpus", () => {
  const c = corpus.constants;
  assert.equal(TAP_SLOP, c.tapSlop);
  assert.equal(AXIS_SLOP, c.axisSlop);
  assert.equal(SWIPE_MIN_DISTANCE, c.swipeMinDistance);
  assert.equal(SWIPE_MIN_VELOCITY, c.swipeMinVelocity);
  assert.equal(VELOCITY_WINDOW_MS, c.velocityWindowMs);
  assert.equal(VELOCITY_SAMPLES, c.velocitySamples);
  assert.equal(PINCH_SLOP, c.pinchSlop);
  assert.equal(ROTATE_SLOP, c.rotateSlop);
  assert.deepEqual([...GESTURE_PRECEDENCE], c.precedence);
  assert.deepEqual([...CONTINUOUS_KINDS].sort(), c.continuous);
  assert.deepEqual([...DIRECTIONAL_KINDS].sort(), c.directional);
});

test("gestures: velocity1D agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.velocity, "velocity")) {
    close(velocity1D(c.samples), c.expect, `velocity/${c.name}`);
  }
});

test("gestures: velocity2D agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.velocity2D, "velocity2D")) {
    const got = velocity2D(c.samples);
    close(got.vx, c.expect.vx, `velocity2D/${c.name} vx`);
    close(got.vy, c.expect.vy, `velocity2D/${c.name} vy`);
  }
});

test("gestures: the press machine agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.press, "press")) {
    const tracker = new PressTracker();
    const actions: string[] = [];
    for (const e of c.events) {
      const id = e.id ?? "p1";
      const x = e.x ?? 0, y = e.y ?? 0;
      switch (e.type) {
        case "down": actions.push(...tracker.down(id, x, y)); break;
        case "move": actions.push(...tracker.move(id, x, y)); break;
        case "up": actions.push(...tracker.up(id, x, y)); break;
        case "cancel": actions.push(...tracker.cancel(id)); break;
        case "unmount": actions.push(...tracker.unmount()); break;
        default: assert.fail(`press/${c.name}: unknown event ${e.type}`);
      }
    }
    assert.deepEqual(actions, c.expect, `press/${c.name}`);
    assert.equal(tracker.dragging, c.expectDragging, `press/${c.name} dragging`);
  }
});

test("gestures: the hover motion channel agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.hover, "hover")) {
    const motion = new HoverMotion();
    const emitted: Array<{ action: string; x: number; y: number }> = [];
    for (const e of c.events) {
      const x = e.x ?? 0, y = e.y ?? 0;
      switch (e.type) {
        case "enter": emitted.push(...motion.enter(e.hoverCapable ?? false, x, y)); break;
        case "move": emitted.push(...motion.move(x, y)); break;
        case "leave": emitted.push(...motion.leave(x, y)); break;
        case "unmount": emitted.push(...motion.unmount()); break;
        default: assert.fail(`hover/${c.name}: unknown event ${e.type}`);
      }
    }
    assert.deepEqual(emitted, c.expect, `hover/${c.name}`);
  }
});

test("gestures: swipe classification agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.swipe, "swipe")) {
    const got = resolveSwipe(c.dx, c.dy, c.vx, c.vy, c.axis);
    if (c.expect === null) {
      assert.equal(got, null, `swipe/${c.name}`);
      continue;
    }
    assert.notEqual(got, null, `swipe/${c.name}`);
    assert.equal(got!.direction, c.expect.direction, `swipe/${c.name} direction`);
    close(got!.velocity, c.expect.velocity, `swipe/${c.name} velocity`);
    close(got!.distance, c.expect.distance, `swipe/${c.name} distance`);
  }
});

test("gestures: the axis claim agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.axisClaim, "axisClaim")) {
    assert.equal(claimAxis(c.axis, c.dx, c.dy), c.expect, `axisClaim/${c.name}`);
  }
});

test("gestures: the transform tracker agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.transform, "transform")) {
    const tracker = new TransformTracker();
    const emitted: Array<Record<string, number | string>> = [];
    for (const e of c.events) {
      const out = e.type === "cancel" ? tracker.cancel() : tracker.update(e.t ?? 0, e.points ?? []);
      for (const o of out) emitted.push(o as unknown as Record<string, number | string>);
    }
    assert.equal(emitted.length, c.expect.length, `transform/${c.name}: emission count`);
    c.expect.forEach((expected, i) => {
      const got = emitted[i]!;
      assert.equal(got["phase"], expected["phase"], `transform/${c.name}[${i}] phase`);
      for (const key of ["scale", "rotation", "focusX", "focusY", "scaleVelocity", "rotationVelocity"]) {
        close(got[key] as number, expected[key] as number, `transform/${c.name}[${i}] ${key}`);
      }
    });
  }
});

test("gestures: the drag payload stays additive", () => {
  for (const c of nonEmpty(corpus.drag, "drag")) {
    const got = dragPayload({
      width: c.width, height: c.height, x: c.x, y: c.y,
      startX: c.startX, startY: c.startY, samples: c.samples, phase: c.phase,
    }) as unknown as Record<string, number | string>;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(c.expect).sort(), `drag/${c.name}: payload keys`);
    for (const [key, expected] of Object.entries(c.expect)) {
      if (typeof expected === "number") close(got[key] as number, expected, `drag/${c.name} ${key}`);
      else assert.equal(got[key], expected, `drag/${c.name} ${key}`);
    }
  }
});

test("gestures: the composition resolver agrees with the corpus", () => {
  for (const c of nonEmpty(corpus.composition, "composition")) {
    const got = resolveComposition(c.tree, c.attempt);
    assert.deepEqual(got.fire, c.expect.fire, `composition/${c.name} fire`);
    assert.deepEqual(got.blocked, c.expect.blocked, `composition/${c.name} blocked`);
  }
});

test("gestures: the Article 7 degradation table matches the corpus", () => {
  const rows = corpus.degradation?.rows ?? [];
  assert.ok(rows.length > 0, "degradation: empty corpus section");
  assert.deepEqual(GESTURE_DEGRADATION.map((r) => ({ ...r })), rows);
  for (const row of rows) {
    assert.equal(row["whenAbsent"], "never-fires", `degradation/${row["gesture"]}: a gesture never fakes its input`);
    assert.ok((row["alternative"] ?? "").length > 0, `degradation/${row["gesture"]}: needs a reachable alternative`);
  }
});
