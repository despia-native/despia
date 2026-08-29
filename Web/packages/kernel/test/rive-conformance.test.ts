//
//  rive-conformance.test.ts - the SHARED `<rive>` corpus
//  (OpenSource/Conformance/rive/{inputs,selection,fit,playback,events,a11y}.json) through the
//  TS rive core - the reference leg of parity/U12-rive.md. The Kotlin twin is :core
//  RiveConformanceTest.kt and the Swift twin is Engine/iOS/RiveCore.swift, all reading the
//  SAME six files off disk, so three renderers cannot disagree about when a trigger fires.
//
//  What this corpus pins is DECISIONS, not pixels. Rive's own runtime draws the picture on
//  every platform, so pixel parity is the vendor's problem and is asserted nowhere here.
//  Everything AROUND the vendor is ours and is asserted exactly: the input fold, the
//  selection refusals, the fit geometry (to 1e-6), the lifecycle counters, the payload shapes
//  and the accessibility verdict.
//
//  Expected values come from an independent scratch implementation, never from this core.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  riveInputPlan, riveSelection, riveFit, rivePlaybackSchedule, riveResidency,
  riveStateChanges, riveEventPayload, riveLoadPayload, riveErrorPayload, riveA11y,
  type RiveDeclaredInput, type RiveManifest, type RivePlaybackEvent, type RiveResidencyEvent,
} from "../src/rive-core.ts";

const TOLERANCE = 1e-6;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/rive");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("rive corpus not found");
    dir = parent;
  }
}

function corpus(file: string): { [key: string]: unknown } {
  return JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { [key: string]: unknown };
}

function rows<T>(file: string, key: string, minimum: number): T[] {
  const list = corpus(file)[key] as T[] | undefined;
  assert.ok(Array.isArray(list), `${file}: no ${key}[]`);
  assert.ok(list.length >= minimum, `${file}.${key}: corpus is suspiciously small (${list.length})`);
  return list;
}

/** deep structural equality with a numeric tolerance. Key sets are compared BOTH ways: an
 *  extra field is a drift too. */
function like(actual: unknown, expected: unknown, where: string): void {
  if (expected === null) {
    assert.equal(actual, null, `${where}: expected null, got ${JSON.stringify(actual)}`);
    return;
  }
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${where}: expected a number, got ${JSON.stringify(actual)}`);
    assert.ok(Math.abs((actual as number) - expected) <= TOLERANCE, `${where}: ${actual} !~ ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal((actual as unknown[]).length, expected.length, `${where}: length`);
    expected.forEach((value, i) => like((actual as unknown[])[i], value, `${where}[${i}]`));
    return;
  }
  if (typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual),
      `${where}: expected an object, got ${JSON.stringify(actual)}`);
    const got = actual as { [k: string]: unknown };
    const want = expected as { [k: string]: unknown };
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${where}: field set`);
    for (const key of Object.keys(want)) like(got[key], want[key], `${where}.${key}`);
    return;
  }
  assert.equal(actual, expected, where);
}

// ── inputs.json ──────────────────────────────────────────────────────────────────────

type InputCase = {
  name: string;
  declared: RiveDeclaredInput[];
  bound: { [name: string]: unknown };
  previous: { [name: string]: string };
  plan: unknown;
};

for (const c of rows<InputCase>("inputs.json", "cases", 15)) {
  test(`rive-inputs/${c.name}`, () => {
    like(riveInputPlan(c.declared, c.bound, c.previous), c.plan, "plan");
  });
}

test("rive-inputs/the plan is a pure function of its three arguments", () => {
  const declared: RiveDeclaredInput[] = [{ name: "n", type: "number" }, { name: "t", type: "trigger" }];
  const bound = { n: 1, t: true };
  const previous = { n: "0" };
  const first = riveInputPlan(declared, bound, previous);
  const second = riveInputPlan(declared, bound, previous);
  like(second, JSON.parse(JSON.stringify(first)), "second call");
  assert.deepEqual(previous, { n: "0" }, "the previous map is never mutated");
});

// ── selection.json ───────────────────────────────────────────────────────────────────

type SelectionCase = {
  name: string; manifest: RiveManifest; attrs: { [name: string]: unknown }; selection: unknown;
};

for (const c of rows<SelectionCase>("selection.json", "cases", 12)) {
  test(`rive-selection/${c.name}`, () => {
    like(riveSelection(c.manifest, c.attrs), c.selection, "selection");
  });
}

// ── fit.json ─────────────────────────────────────────────────────────────────────────

type FitCase = {
  name: string; fit: string | null; alignment: string | null;
  content: [number, number]; box: [number, number];
  placement: { [key: string]: unknown };
};

for (const c of rows<FitCase>("fit.json", "cases", 14)) {
  test(`rive-fit/${c.name}`, () => {
    const placement = riveFit(c.fit, c.alignment, c.content[0], c.content[1], c.box[0], c.box[1]);
    const got = {
      fit: placement.fit, alignment: placement.alignment,
      scaleX: placement.scaleX, scaleY: placement.scaleY,
      x: placement.x, y: placement.y,
      diagnostics: placement.diagnostics.length,
    };
    like(got, c.placement, "placement");
  });
}

// ── playback.json ────────────────────────────────────────────────────────────────────

type PlaybackCase = {
  name: string; autoplay: boolean; events: RivePlaybackEvent[]; fold: unknown;
};

for (const c of rows<PlaybackCase>("playback.json", "schedule", 10)) {
  test(`rive-playback/${c.name}`, () => {
    like(rivePlaybackSchedule(c.autoplay, c.events), c.fold, "fold");
  });
}

type ResidencyCase = {
  name: string; capacity: number; events: RiveResidencyEvent[]; fold: unknown;
};

for (const c of rows<ResidencyCase>("playback.json", "residency", 6)) {
  test(`rive-residency/${c.name}`, () => {
    const fold = riveResidency(c.capacity, c.events);
    like(fold, c.fold, "fold");
    const cap = Math.max(1, c.capacity);
    assert.ok(fold.live.length <= cap, `live ${fold.live.length} exceeds the cap ${cap}`);
  });
}

// ── events.json ──────────────────────────────────────────────────────────────────────

type StateCase = { name: string; machine: string; states: (string | null)[]; emitted: unknown };

for (const c of rows<StateCase>("events.json", "stateChanges", 4)) {
  test(`rive-statechange/${c.name}`, () => {
    like(riveStateChanges(c.machine, c.states), c.emitted, "emitted");
  });
}

type EventCase = { name: string; event: string; properties: { [k: string]: unknown }; result: unknown };

for (const c of rows<EventCase>("events.json", "events", 5)) {
  test(`rive-event/${c.name}`, () => {
    like(riveEventPayload(c.event, c.properties), c.result, "result");
  });
}

type LoadCase = { name: string; selection: never; size: [number, number]; payload: unknown };

for (const c of rows<LoadCase>("events.json", "load", 2)) {
  test(`rive-load/${c.name}`, () => {
    like(riveLoadPayload(c.selection, c.size[0], c.size[1]), c.payload, "payload");
  });
}

type ErrorCase = { name: string; code: string; payload: unknown };

for (const c of rows<ErrorCase>("events.json", "errors", 6)) {
  test(`rive-error/${c.name}`, () => {
    like(riveErrorPayload(c.code), c.payload, "payload");
  });
}

// ── a11y.json ────────────────────────────────────────────────────────────────────────

type A11yCase = {
  name: string;
  attrs: { [name: string]: unknown };
  listeners?: boolean;
  a11yChildren?: { role?: string; label?: string; value?: string | null }[];
  verdict: unknown;
};

for (const c of rows<A11yCase>("a11y.json", "cases", 12)) {
  test(`rive-a11y/${c.name}`, () => {
    like(riveA11y(c.attrs, c.a11yChildren ?? null, c.listeners === true), c.verdict, "verdict");
  });
}

test("rive-a11y/the lint verdict is the linter's rule, verbatim", () => {
  // lint_dsx.rb carries the same code and the same sentence; a change here that is not
  // mirrored there is a rule that means two things.
  const verdict = riveA11y({ "on:tap": "poke()" });
  assert.equal(verdict.lint?.code, "rive-a11y-label");
  assert.equal(verdict.lint?.level, "error");
  assert.match(verdict.lint?.message ?? "", /^<rive> with a gesture handler needs a11yLabel/);
});
