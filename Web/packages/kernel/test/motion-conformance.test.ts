//
//  motion-conformance.test.ts — the SHARED UI MOTION corpus
//  (OpenSource/Conformance/motion/{curves,spring,retarget,physics}.json) through the TS
//  motion kernel — the REFERENCE leg of ui-motion.md. The Kotlin twin
//  (:core MotionConformanceTest) and the Swift twin (record lane, MotionConformance) run
//  the SAME files, so `anim="spring"` cannot mean three different curves again. Expected
//  numbers were computed by an independent scratch derivation, never by this kernel.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  parseMotion, motionProgress, motionSettleMs, motionSpringConstants,
  motionStart, motionValue, motionRetarget, motionSpring,
  decayAt, decayTarget, decayDurationMs, rubberBand, rubberBandInverse, snapTarget,
  MOTION_PRESET_KEEP, MOTION_PRESET_PRESS, MOTION_PRESET_DEFAULT,
  MOTION_DECELERATION_RATE, MOTION_DECAY_TAU_MS, MOTION_DECAY_MIN_VELOCITY,
  MOTION_RUBBER_BAND_C, MOTION_RUBBER_BAND_RELEASE,
  type MotionSpec,
} from "../src/index.ts";

const TOLERANCE = 1.5e-6;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/motion");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("motion corpus not found");
    dir = parent;
  }
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as T;
}

function close(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${label}: ${actual} !~ ${expected}`);
}

// ── curves.json ──────────────────────────────────────────────────────────────────────

type ParseCase = {
  name: string; anim: string | null; animDuration: string | null;
  expect: {
    name: string; kind: string; durationMs: number;
    x1?: number; y1?: number; x2?: number; y2?: number;
    response?: number; dampingFraction?: number;
  };
  diagnostics: string[];
};
type ProgressCase = {
  name: string; anim: string | null; animDuration: string | null; durationMs: number;
  samples: { t: number; p: number }[];
};
type PresetShape = { name: string; kind: string; durationMs: number; x1: number; y1: number; x2: number; y2: number };
type CurvesDoc = { presets: Record<string, PresetShape>; parse: ParseCase[]; progress: ProgressCase[] };

const curves = load<CurvesDoc>("curves.json");
assert.ok(curves.parse.length >= 15, "motion/curves parse corpus is suspiciously small");
assert.ok(curves.progress.length >= 8, "motion/curves progress corpus is suspiciously small");

for (const c of curves.parse) {
  test(`motion/curves parse — ${c.name}`, () => {
    const codes: string[] = [];
    const spec = parseMotion(c.anim, c.animDuration, (d) => codes.push(d.code));
    assert.equal(spec.kind, c.expect.kind, "kind");
    assert.equal(spec.name, c.expect.name, "name");
    close(spec.durationMs, c.expect.durationMs, "durationMs");
    close(motionSettleMs(spec), c.expect.durationMs, "motionSettleMs");
    if (spec.kind === "spring") {
      close(spec.response, c.expect.response!, "response");
      close(spec.dampingFraction, c.expect.dampingFraction!, "dampingFraction");
    } else {
      assert.deepEqual([spec.x1, spec.y1, spec.x2, spec.y2],
        [c.expect.x1, c.expect.y1, c.expect.x2, c.expect.y2], "control points");
    }
    assert.deepEqual(codes, c.diagnostics, "diagnostics");
  });
}

test("motion/curves — the pinned presets", () => {
  const table: Record<string, MotionSpec> = {
    keep: MOTION_PRESET_KEEP, press: MOTION_PRESET_PRESS, default: MOTION_PRESET_DEFAULT,
  };
  for (const [key, expect] of Object.entries(curves.presets)) {
    const spec = table[key];
    assert.ok(spec !== undefined, `no preset for ${key}`);
    assert.equal(spec.kind, expect.kind, `${key}: kind`);
    assert.equal(spec.name, expect.name, `${key}: name`);
    close(spec.durationMs, expect.durationMs, `${key}: durationMs`);
    assert.equal(spec.kind, "curve");
    if (spec.kind === "curve") {
      assert.deepEqual([spec.x1, spec.y1, spec.x2, spec.y2],
        [expect.x1, expect.y1, expect.x2, expect.y2], `${key}: control points`);
    }
  }
});

for (const c of curves.progress) {
  test(`motion/curves progress — ${c.name}`, () => {
    const spec = parseMotion(c.anim, c.animDuration);
    close(spec.durationMs, c.durationMs, "durationMs");
    for (const s of c.samples) close(motionProgress(spec, s.t), s.p, `p(${s.t})`);
  });
}

// ── spring.json ──────────────────────────────────────────────────────────────────────

type ConversionCase = {
  name: string; response: number; dampingFraction: number;
  omega: number; stiffness: number; damping: number; zeta: number; settleMs: number;
};
type SpringProgressCase = {
  name: string; response: number; dampingFraction: number; settleMs: number;
  samples: { t: number; p: number }[];
};
const spring = load<{ conversion: ConversionCase[]; progress: SpringProgressCase[] }>("spring.json");
assert.ok(spring.conversion.length >= 5, "motion/spring conversion corpus is suspiciously small");
assert.ok(spring.progress.length >= 4, "motion/spring progress corpus is suspiciously small");

for (const c of spring.conversion) {
  test(`motion/spring conversion — ${c.name}`, () => {
    const { stiffness, damping } = motionSpringConstants(c.response, c.dampingFraction);
    close(Math.sqrt(stiffness), c.omega, "omega");
    close(stiffness, c.stiffness, "stiffness");
    close(damping, c.damping, "damping");
    close(damping / (2 * Math.sqrt(stiffness)), c.zeta, "zeta");
    // At the authored damping fraction (0.8 — the only one `anim=` can reach), the
    // parse must produce exactly these numbers and this settle time.
    if (c.dampingFraction === 0.8) {
      const spec = parseMotion("spring", String(c.response));
      assert.equal(spec.kind, "spring");
      if (spec.kind === "spring") {
        close(spec.stiffness, c.stiffness, "spec.stiffness");
        close(spec.damping, c.damping, "spec.damping");
      }
      close(spec.durationMs, c.settleMs, "settleMs");
    }
  });
}

for (const c of spring.progress) {
  test(`motion/spring progress — ${c.name}`, () => {
    // Non-default damping fractions are not reachable through `anim=`; build the spec
    // from the authoring plane so the corpus can pin the whole oscillator family.
    const pinned = motionSpring(c.response, c.dampingFraction);
    close(motionSettleMs(pinned), c.settleMs, "settleMs");
    for (const s of c.samples) close(motionProgress(pinned, s.t), s.p, `p(${s.t})`);
  });
}

// ── retarget.json ────────────────────────────────────────────────────────────────────

type RetargetCase = {
  name: string; anim: string | null; animDuration: string | null;
  from: number; to: number;
  events: { at: number; to: number }[];
  samples: { t: number; value: number; done: boolean }[];
};
const retarget = load<{ cases: RetargetCase[] }>("retarget.json");
assert.ok(retarget.cases.length >= 6, "motion/retarget corpus is suspiciously small");

for (const c of retarget.cases) {
  test(`motion/retarget — ${c.name}`, () => {
    const spec = parseMotion(c.anim, c.animDuration);
    let state = motionStart(c.from, c.to, 0);
    const pending = [...c.events].sort((a, b) => a.at - b.at);
    let next = 0;
    for (const s of c.samples) {
      while (next < pending.length && pending[next]!.at <= s.t) {
        state = motionRetarget(spec, state, pending[next]!.to, pending[next]!.at);
        next += 1;
      }
      const got = motionValue(spec, state, s.t);
      close(got.value, s.value, `value(${s.t})`);
      assert.equal(got.done, s.done, `done(${s.t})`);
    }
  });
}

// ── physics.json ─────────────────────────────────────────────────────────────────────

type PhysicsDoc = {
  constants: {
    decelerationRate: number; tauMs: number; minVelocity: number; rubberBandC: number;
    releaseResponse: number; releaseDampingFraction: number;
  };
  decay: { name: string; x0: number; v0: number; target: number; durationMs: number; samples: { t: number; x: number }[] }[];
  rubberBand: { name: string; x: number; dimension: number; y: number; inverse: number }[];
  snap: { name: string; x0: number; v0: number; points: number[]; projected: number; target: number; index: number }[];
};
const physics = load<PhysicsDoc>("physics.json");
assert.ok(physics.decay.length >= 3 && physics.rubberBand.length >= 6 && physics.snap.length >= 6,
  "motion/physics corpus is suspiciously small");

test("motion/physics — the pinned constants", () => {
  close(MOTION_DECELERATION_RATE, physics.constants.decelerationRate, "decelerationRate");
  close(MOTION_DECAY_TAU_MS, physics.constants.tauMs, "tauMs");
  close(MOTION_DECAY_MIN_VELOCITY, physics.constants.minVelocity, "minVelocity");
  close(MOTION_RUBBER_BAND_C, physics.constants.rubberBandC, "rubberBandC");
  assert.equal(MOTION_RUBBER_BAND_RELEASE.kind, "spring");
  if (MOTION_RUBBER_BAND_RELEASE.kind === "spring") {
    close(MOTION_RUBBER_BAND_RELEASE.response, physics.constants.releaseResponse, "releaseResponse");
    close(MOTION_RUBBER_BAND_RELEASE.dampingFraction, physics.constants.releaseDampingFraction,
      "releaseDampingFraction");
  }
});

for (const c of physics.decay) {
  test(`motion/physics decay — ${c.name}`, () => {
    close(decayTarget(c.x0, c.v0), c.target, "target");
    close(decayDurationMs(c.v0), c.durationMs, "durationMs");
    for (const s of c.samples) close(decayAt(c.x0, c.v0, s.t), s.x, `x(${s.t})`);
  });
}

for (const c of physics.rubberBand) {
  test(`motion/physics rubberBand — ${c.name}`, () => {
    const y = rubberBand(c.x, c.dimension);
    close(y, c.y, "y");
    close(rubberBandInverse(y, c.dimension), c.inverse, "inverse round trip");
  });
}

for (const c of physics.snap) {
  test(`motion/physics snap — ${c.name}`, () => {
    const got = snapTarget(c.x0, c.v0, c.points);
    close(got.projected, c.projected, "projected");
    close(got.target, c.target, "target");
    assert.equal(got.index, c.index, "index");
  });
}
