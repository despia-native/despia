// The universal-ATTRIBUTE support gate.
//
// element-support.json was keyed BY ELEMENT, so an attribute-level gap was structurally
// unrecordable: the catalog's universal motion attributes (enter/exit/keep/transition/
// anim/animDuration) were silently inert on this renderer with no ledger row able to say
// so, and no test able to fail. This gate closes both halves:
//
//   COMPLETENESS — every universalAttributes key in the catalog
//   (OpenSource/Documentation/reference/stack-elements.json) must have a row in the
//   ledger's universalAttributes plane, and every row must name a catalog key. Adding a
//   universal attribute without a web-support decision is a RED test, not a silent gap.
//
//   HONESTY (motion family) — a row claiming `supported` for a motion attribute must be
//   backed by element-motion.ts's MOTION_HANDLED export; delete the implementation and
//   this test goes red, so the ledger can never again claim motion support it lost.
//
//   Every `unsupported` row must carry a non-empty reason — a recorded divergence, never
//   a bare "no".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { MOTION_HANDLED, motionTiming, motionFrom, KEEP_DEFAULT, SPRING_SAMPLE_STOPS } from "../src/element-motion.ts";
import { parseMotion, motionProgress } from "@despia/kernel";
import { ElementMotionSeam } from "../src/mount.ts";
import { registerElementMotion } from "../src/element-motion.ts";

const webRoot = resolve(import.meta.dirname, "../../..");
const ledger = JSON.parse(readFileSync(join(webRoot, "support/element-support.json"), "utf8")) as {
  universalAttributes: Record<string, { status?: string; reason?: string } | string>;
};
const catalog = JSON.parse(
  readFileSync(join(webRoot, "../Documentation/reference/stack-elements.json"), "utf8"),
) as { universalAttributes: Record<string, unknown> };

const catalogKeys = Object.keys(catalog.universalAttributes).sort();
const ledgerRows = Object.fromEntries(
  Object.entries(ledger.universalAttributes).filter(([k]) => !k.startsWith("_")),
) as Record<string, { status?: string; reason?: string }>;
const ledgerKeys = Object.keys(ledgerRows).sort();

test("every catalog universal attribute has a web-support decision (and no stray rows)", () => {
  const missing = catalogKeys.filter((k) => !ledgerKeys.includes(k));
  const stray = ledgerKeys.filter((k) => !catalogKeys.includes(k));
  assert.deepEqual(missing, [],
    `catalog universal attribute(s) with NO web-support row — add a universalAttributes row (a decision, not silence): ${missing.join(", ")}`);
  assert.deepEqual(stray, [],
    `ledger row(s) naming no catalog attribute (stale? renamed?): ${stray.join(", ")}`);
});

test("rows carry a valid status, and unsupported rows carry a reason", () => {
  for (const [key, row] of Object.entries(ledgerRows)) {
    assert.ok(["supported", "partial", "unsupported"].includes(row.status ?? ""),
      `${key}: status must be supported|partial|unsupported, got ${JSON.stringify(row.status)}`);
    if (row.status !== "supported") {
      assert.ok((row.reason ?? "").length > 0, `${key}: a non-supported row must record WHY`);
    }
  }
});

test("motion rows claiming support are backed by the element-motion implementation", () => {
  const MOTION_FAMILY = ["enter", "exit", "keep", "transition", "anim", "animDuration"];
  for (const key of MOTION_FAMILY) {
    const row = ledgerRows[key];
    assert.ok(row !== undefined, `${key}: missing motion row`);
    if (row.status === "supported") {
      assert.ok((MOTION_HANDLED as readonly string[]).includes(key),
        `${key}: ledger says supported but element-motion.ts MOTION_HANDLED does not implement it`);
    } else {
      assert.ok(!(MOTION_HANDLED as readonly string[]).includes(key),
        `${key}: implemented in MOTION_HANDLED but the ledger does not say supported — update the row`);
    }
  }
});

test("motion timing comes from the SHARED motion kernel, not a web-local curve table", () => {
  // The numbers below are the corpus-pinned ones (OpenSource/Conformance/motion/) that
  // the SwiftUI and Compose renderers also derive from — this test exists to catch the
  // web drifting back to its own table (it used to say 0.25s / 0.4s / `ease-in-out`).
  assert.deepEqual(motionTiming({}), { durMs: 350, curve: "cubic-bezier(0.42,0,0.58,1)" });
  assert.deepEqual(motionTiming({ anim: "linear", animDuration: "0.5" }),
    { durMs: 500, curve: "linear" });
  assert.deepEqual(motionTiming({ anim: "easeOut" }).curve, "cubic-bezier(0,0,0.58,1)");
  // an unknown curve degrades to easeInOut (native `default:`)
  assert.deepEqual(motionTiming({ anim: "bounce" }).curve, "cubic-bezier(0.42,0,0.58,1)");
  // a malformed duration falls back to the pinned default, never NaN
  assert.deepEqual(motionTiming({ animDuration: "soon" }).durMs, 350);
  // keep-mode fallback applies ONLY when no anim= is authored (native visibilityAnimation)
  assert.deepEqual(motionTiming({}, KEEP_DEFAULT),
    { durMs: 180, curve: "cubic-bezier(0,0,0.58,1)" });
  assert.deepEqual(motionTiming({ anim: "linear" }, KEEP_DEFAULT).curve, "linear");
});

test("anim=\"spring\" is the KERNEL spring sampled into linear(), not a bezier lookalike", () => {
  const t = motionTiming({ anim: "spring" });
  // the settle time of the pinned default spring (response 0.4 / damping 0.8)
  assert.equal(t.durMs, 550);
  assert.ok(t.curve.startsWith("linear("), `expected a sampled linear() easing, got ${t.curve}`);
  const stops = t.curve.slice("linear(".length, -1).split(",").map(Number);
  assert.equal(stops.length, SPRING_SAMPLE_STOPS + 1, "one stop per sample plus the endpoint");
  assert.equal(stops[0], 0);
  assert.equal(stops[stops.length - 1], 1);
  // an underdamped spring MUST overshoot past 1 — that is the whole point of the
  // sampling, and it is exactly what the old cubic-bezier approximation could not do
  // faithfully. Peak lines up with the corpus (spring.json, ~1.0125 near t = 300ms).
  const peak = Math.max(...stops);
  assert.ok(peak > 1.01 && peak < 1.02, `spring overshoot ${peak} left the pinned band`);
  // and the sampled values ARE the kernel's, at the pinned cadence
  const spec = parseMotion("spring", undefined);
  for (let i = 0; i <= SPRING_SAMPLE_STOPS; i += 1) {
    const expected = Number(motionProgress(spec, (spec.durationMs * i) / SPRING_SAMPLE_STOPS).toFixed(5));
    assert.ok(Math.abs(stops[i]! - expected) < 1e-9, `stop ${i}: ${stops[i]} !~ ${expected}`);
  }
});

test("transition tokens mirror the native StackStyle.transition table (all combine with fade)", () => {
  assert.deepEqual(motionFrom("fade"), { opacity: "0", transform: "" });
  assert.deepEqual(motionFrom("scale").transform, "scale(0.92)");
  assert.deepEqual(motionFrom("slide-top").transform, "translateY(-16px)");
  assert.deepEqual(motionFrom("slide-bottom").transform, "translateY(16px)");
  assert.deepEqual(motionFrom("slide-left").transform, "translateX(-16px)");
  assert.deepEqual(motionFrom("slide-right").transform, "translateX(16px)");
  // unknown token degrades to fade (native `default:`)
  assert.deepEqual(motionFrom("wobble"), { opacity: "0", transform: "" });
  for (const token of ["fade", "scale", "slide-top", "slide-bottom", "slide-left", "slide-right"]) {
    assert.equal(motionFrom(token).opacity, "0", `${token} must combine with fade`);
  }
});

test("registerElementMotion fills the mount seam exactly once (idempotent)", () => {
  assert.equal(ElementMotionSeam.impl, null, "seam must start EMPTY — embeds rely on it");
  registerElementMotion();
  const first = ElementMotionSeam.impl;
  assert.notEqual(first, null);
  registerElementMotion();
  assert.equal(ElementMotionSeam.impl, first, "second register must be a no-op");
  ElementMotionSeam.impl = null; // restore for any later test in this process
});
