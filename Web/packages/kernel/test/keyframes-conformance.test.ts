//
//  keyframes-conformance.test.ts — the KEYFRAME corpus
//  (OpenSource/Conformance/motion/keyframes.json) through the TS keyframe sampler, the
//  REFERENCE leg of runtime-pressure R28. The Kotlin twin (:core MotionConformanceTest) and
//  the Swift twin (record lane, MotionConformance) run the SAME file.
//
//  Unusually for a conformance corpus, the reference here is not this kernel: it is the
//  BROWSER. The web renderer never calls the sampler, because a browser owns its own
//  animations, so every expectation in the file is what CSS itself does and all three runners
//  exist to prove the two native lanes agree with it.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  parseAnimation, animationSpec, keyframeTimeline, sampleMotion, motionAttributes,
  MOTION_PROPERTIES, MOTION_ANIMATION_KEYS, MOTION_INFINITE,
  type KeyframeSpec, type KeyframeStop, type KeyframeSample, type KeyframeAttributes,
} from "../src/index.ts";

type Rule = { selector: string; declarations: Record<string, string> };
type Corpus = {
  version: number;
  animatable: string[];
  animationKeys: string[];
  parse: { note: string; shorthand: string; expect: KeyframeSpec }[];
  normalize: { name: string; rules: Rule[]; expect: KeyframeStop[] }[];
  sample: {
    note: string; timeline: string; shorthand: string; elapsed: number; expect: KeyframeSample;
  }[];
  spec: { note: string; attrs: Record<string, string>; expect: KeyframeSpec }[];
  attributes: {
    note: string; values: Record<string, string>; expect: KeyframeAttributes;
  }[];
};

function corpus(): Corpus {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/motion/keyframes.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf-8")) as Corpus;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("motion/keyframes corpus not found");
    dir = parent;
  }
}

const doc = corpus();
assert.equal(doc.version, 1, "motion/keyframes: unsupported corpus version");

for (const c of doc.parse) {
  test(`keyframes/parse — ${c.note}`, () => {
    assert.deepEqual(parseAnimation(c.shorthand), c.expect);
  });
}

for (const c of doc.normalize) {
  test(`keyframes/normalize — ${c.name}`, () => {
    assert.deepEqual(keyframeTimeline(c.rules), c.expect);
  });
}

const timelines = new Map(doc.normalize.map((c) => [c.name, c.rules]));

for (const [i, c] of doc.sample.entries()) {
  test(`keyframes/sample ${i} — ${c.timeline} "${c.shorthand}" @${c.elapsed}ms`, () => {
    const rules = timelines.get(c.timeline);
    assert.ok(rules !== undefined, `${c.timeline} is not a corpus timeline`);
    const got = sampleMotion(keyframeTimeline(rules), parseAnimation(c.shorthand), c.elapsed);
    assert.deepEqual(got, c.expect, c.note);
  });
}

for (const [i, c] of doc.spec.entries()) {
  test(`keyframes/spec ${i} — ${c.note}`, () => {
    assert.deepEqual(animationSpec(c.attrs), c.expect);
  });
}

for (const [i, c] of doc.attributes.entries()) {
  test(`keyframes/attributes ${i} — ${c.note}`, () => {
    assert.deepEqual(motionAttributes(c.values), c.expect);
  });
}

// The two facts a corpus row cannot state: `infinite` is a NUMBER (JSON has no spelling for
// it), and the animatable allowlist IS the promise — outside it a property is dropped, never
// half-applied.
test("keyframes — infinite is a sentinel and the allowlist is the promise", () => {
  assert.equal(MOTION_INFINITE, -1);
  assert.equal(parseAnimation("x 1s infinite").iterations, MOTION_INFINITE);
  assert.deepEqual([...MOTION_PROPERTIES], doc.animatable);
  assert.deepEqual([...MOTION_ANIMATION_KEYS], doc.animationKeys);
});

test("keyframes — a loop is periodic to the millisecond", () => {
  const timeline = keyframeTimeline([
    { selector: "0%, 80%, 100%", declarations: { opacity: "0.28", transform: "scale(0.82)" } },
    { selector: "40%", declarations: { opacity: "1", transform: "scale(1)" } },
  ]);
  const spec = parseAnimation("pulse 1.2s ease-in-out infinite");
  for (const t of [0, 137, 450, 900, 1199]) {
    assert.deepEqual(sampleMotion(timeline, spec, t).values,
      sampleMotion(timeline, spec, t + 1200).values, `t=${t} and t+period disagree`);
    assert.ok(sampleMotion(timeline, spec, t + 1_200_000).active, "an infinite loop never ends");
  }
});
