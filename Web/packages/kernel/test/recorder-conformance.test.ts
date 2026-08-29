//
//  recorder-conformance.test.ts - the SHARED recorder corpus through the TS kernel
//  (OpenSource/Conformance/recorder/{lifecycle,interruption}.json). The Kotlin twin is
//  :core RecorderConformanceTest and the Swift reference is Engine/iOS/RecorderCore.swift.
//
//  The two things that have to be identical across renderers are here and nowhere else: the
//  metering curve (iOS reports dBFS, Android reports a 16-bit amplitude, and without one
//  fold the same voice fills the bar on one platform and not the other) and the state
//  machine, including the interruption path where every naive recorder loses a take.
//
//  Missing corpus = loud failure.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  RECORDER_FLOOR_DB, RECORDER_METER_INTERVAL_MS, RECORDER_STATES,
  foldRecorderFormat, recorderMeterLevel, recorderAmplitudeDb, recorderMeterFromAmplitude,
  recorderTransition,
} from "../src/recorder-core.ts";

type Dict = { [k: string]: unknown };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/recorder");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/recorder not found");
    dir = parent;
  }
}

function corpus(name: string): Dict {
  const doc = JSON.parse(readFileSync(join(corpusDir(), name), "utf-8")) as Dict;
  assert.equal(doc["version"], 1, `${name}: version`);
  return doc;
}

function rows<T>(doc: Dict, key: string): T[] {
  const list = doc[key];
  assert.ok(Array.isArray(list) && list.length > 0, `${key} must be a non-empty array`);
  return list as T[];
}

test("recorder lifecycle: the curve constants", () => {
  const curve = corpus("lifecycle.json")["curve"] as Dict;
  assert.equal(RECORDER_FLOOR_DB, curve["floorDb"]);
  assert.equal(RECORDER_METER_INTERVAL_MS, curve["meterIntervalMs"]);
  assert.deepEqual([...RECORDER_STATES], corpus("lifecycle.json")["states"]);
});

test("recorder lifecycle: dBFS folds to the pinned meter level", () => {
  for (const row of rows<Dict>(corpus("lifecycle.json"), "meter")) {
    assert.equal(recorderMeterLevel(row["db"] as number), row["expect"], row["name"] as string);
  }
});

test("recorder lifecycle: a linear amplitude folds through the same curve", () => {
  for (const row of rows<Dict>(corpus("lifecycle.json"), "amplitude")) {
    const db = recorderAmplitudeDb(row["amplitude"] as number, row["fullScale"] as number);
    assert.equal(db, row["expectDb"], `${row["name"]}: dB`);
    assert.equal(recorderMeterFromAmplitude(row["amplitude"] as number, row["fullScale"] as number),
      row["expectLevel"], `${row["name"]}: level`);
  }
});

test("recorder lifecycle: the format fold", () => {
  for (const row of rows<Dict>(corpus("lifecycle.json"), "formats")) {
    assert.equal(foldRecorderFormat(row["input"] as string), row["expect"], row["name"] as string);
  }
});

test("recorder lifecycle: the state machine", () => {
  for (const row of rows<Dict>(corpus("lifecycle.json"), "transitions")) {
    const expect = row["expect"] as Dict;
    const got = recorderTransition(row["from"] as string, row["event"] as string);
    assert.equal(got.state, expect["state"], `${row["name"]}: state`);
    assert.equal(got.error ?? undefined, expect["error"] ?? undefined, `${row["name"]}: error`);
  }
});

test("recorder interruption: every sequence walks the pinned states and emits", () => {
  for (const row of rows<Dict>(corpus("interruption.json"), "sequences")) {
    const steps = row["steps"] as string[];
    const states = row["expect"] as string[];
    const emits = row["emits"] as (string | null)[];
    assert.equal(steps.length, states.length, `${row["name"]}: one expected state per step`);
    assert.equal(steps.length, emits.length, `${row["name"]}: one expected emission per step`);

    let state = "idle";
    for (let i = 0; i < steps.length; i += 1) {
      const got = recorderTransition(state, steps[i]);
      state = got.state;
      assert.equal(state, states[i], `${row["name"]} step ${i + 1} (${steps[i]}): state`);
      assert.equal(got.emit ?? null, emits[i], `${row["name"]} step ${i + 1} (${steps[i]}): emission`);
    }
  }
});

test("recorder interruption: the take is never lost to an interruption", () => {
  // The property in one line of code: from any interrupted take, `stop` still reaches idle
  // through the normal path, which is what makes the partial file finalisable.
  let state = recorderTransition("idle", "start").state;
  state = recorderTransition(state, "interrupt").state;
  assert.equal(state, "interrupted");
  const stopped = recorderTransition(state, "stop");
  assert.equal(stopped.state, "idle");
  assert.equal(stopped.error, undefined, "stopping an interrupted take must not be refused");
});

test("recorder interruption: the declared broadcasts are the ones the machine emits", () => {
  const declared = Object.keys(corpus("interruption.json")["broadcasts"] as Dict).filter((k) => !k.startsWith("_"));
  const emitted = new Set<string>();
  for (const from of RECORDER_STATES) {
    for (const event of ["start", "pause", "resume", "stop", "cancel", "interrupt", "endInterruption", "maxDuration"]) {
      const emit = recorderTransition(from, event).emit;
      if (emit !== undefined) emitted.add(emit);
    }
  }
  assert.deepEqual([...emitted].sort(), declared.sort());
});
