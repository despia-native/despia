//
//  input-conformance.test.ts — the SHARED G4 unified-input corpus through the TS kernel
//  (OpenSource/Conformance/input/{mappings,axis,attenuation}.json). The Kotlin twin
//  (:core InputConformanceTest) and the Swift twin (InputConformance, record lane) run the
//  SAME files, so the mapping table, the axis math, the edge law and the audio attenuation
//  curve cannot drift by a single decimal. Every expected number was computed by an
//  independent scratch implementation, never by this kernel.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  JSE,
  resolveInputDeclarations, inputDigitalAxis, inputAnalogAxis, InputMachine,
  sceneAudioAttenuation,
  INPUT_DEFAULT_DEADZONE, INPUT_PAD_BUTTONS, INPUT_PAD_STICKS, INPUT_KEY_SETS,
  INPUT_TOUCH_WORDS, INPUT_MOMENTARY_TOUCH,
  AUDIO_DEFAULT_REF_DISTANCE, AUDIO_DEFAULT_MAX_DISTANCE, AUDIO_DEFAULT_ROLLOFF,
  type InputDeclaration, type InputBinding, type InputAxisValue,
} from "../src/index.ts";

const TOLERANCE = 1.5e-6;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/input");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/input not found");
    dir = parent;
  }
}

function load(file: string): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, `${file}: version`);
  return doc;
}

function close(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${label}: ${actual} !~ ${expected}`);
}

// ── mappings.json — declaration → resolved binding ──────────────────────────────────────

const mappings = load("mappings.json");

type MappingCase = {
  name: string;
  declarations: InputDeclaration[];
  bindings: InputBinding[];
  diagnostics: string[];
};

const mappingCases = mappings["cases"] as MappingCase[];
assert.ok(mappingCases.length >= 30, `mappings.json: suspiciously small (${mappingCases.length})`);

for (const c of mappingCases) {
  test(`input-mappings/${c.name}`, () => {
    const got = resolveInputDeclarations(c.declarations);
    assert.equal(got.bindings.length, c.bindings.length, `${c.name}: binding count`);
    for (let i = 0; i < c.bindings.length; i += 1) {
      const want = c.bindings[i]!;
      const have = got.bindings[i]!;
      assert.equal(have.name, want.name, `${c.name}[${i}]: name`);
      assert.equal(have.axis, want.axis, `${c.name}[${i}]: axis`);
      close(have.deadzone, want.deadzone, `${c.name}[${i}]: deadzone`);
      assert.deepEqual(have.keys, want.keys, `${c.name}[${i}]: keys`);
      assert.deepEqual(have.buttons, want.buttons, `${c.name}[${i}]: buttons`);
      assert.deepEqual(have.sticks, want.sticks, `${c.name}[${i}]: sticks`);
      assert.deepEqual(have.touch, want.touch, `${c.name}[${i}]: touch`);
    }
    assert.deepEqual(got.diagnostics.map((d) => d.code), c.diagnostics, `${c.name}: diagnostics`);
  });
}

test("input-mappings/diagnostic codes are exactly the declared set", () => {
  const declared = new Set(mappings["diagnosticCodes"] as string[]);
  const seen = new Set<string>();
  for (const c of mappingCases) for (const code of c.diagnostics) seen.add(code);
  for (const code of seen) assert.ok(declared.has(code), `undeclared diagnostic code ${code}`);
  // every declared code is EXERCISED — a code nothing produces is a dead law
  for (const code of declared) assert.ok(seen.has(code), `declared code ${code} is never exercised`);
});

test("input-mappings/dsx.input folds to the global input plane", () => {
  for (const row of mappings["scope"] as Array<{ path: string; resolved: string }>) {
    assert.equal(JSE.normalizeScope(row.path), row.resolved, `scope ${row.path}`);
  }
});

test("input-mappings/kernel constants agree with the corpus law", () => {
  assert.equal(INPUT_DEFAULT_DEADZONE, 0.15);
  assert.deepEqual(INPUT_KEY_SETS["wasd"], ["W", "A", "S", "D"]);
  assert.deepEqual(INPUT_KEY_SETS["arrows"], ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]);
  assert.deepEqual(INPUT_KEY_SETS["zqsd"], ["Z", "Q", "S", "D"]);
  assert.deepEqual(INPUT_KEY_SETS["ijkl"], ["I", "J", "K", "L"]);
  assert.deepEqual(INPUT_PAD_STICKS["leftStick"], [0, 1]);
  assert.deepEqual(INPUT_PAD_STICKS["rightStick"], [2, 3]);
  const order = ["A", "B", "X", "Y", "L", "R", "L2", "R2", "Select", "Start",
    "LStick", "RStick", "DPadUp", "DPadDown", "DPadLeft", "DPadRight"];
  order.forEach((word, index) => assert.equal(INPUT_PAD_BUTTONS[word], index, `pad ${word}`));
  assert.deepEqual(Object.values(INPUT_TOUCH_WORDS).sort(),
    ["hold", "swipeDown", "swipeLeft", "swipeRight", "swipeUp", "tap"]);
  assert.deepEqual([...INPUT_MOMENTARY_TOUCH].sort(),
    ["swipeDown", "swipeLeft", "swipeRight", "swipeUp", "tap"]);
});

// ── axis.json — the folds and the edge law ──────────────────────────────────────────────

const axisDoc = load("axis.json");

type DigitalCase = { name: string; up: boolean; left: boolean; down: boolean; right: boolean; vector: number[] };
for (const c of axisDoc["digital"] as DigitalCase[]) {
  test(`input-axis-digital/${c.name}`, () => {
    const [x, y] = inputDigitalAxis(c.up, c.left, c.down, c.right);
    close(x, c.vector[0]!, `${c.name}.x`);
    close(y, c.vector[1]!, `${c.name}.y`);
  });
}

type AnalogCase = { name: string; raw: number[]; deadzone: number; vector: number[]; magnitude: number };
for (const c of axisDoc["analog"] as AnalogCase[]) {
  test(`input-axis-analog/${c.name}`, () => {
    const [x, y] = inputAnalogAxis(c.raw[0]!, c.raw[1]!, c.deadzone);
    close(x, c.vector[0]!, `${c.name}.x`);
    close(y, c.vector[1]!, `${c.name}.y`);
    close(Math.sqrt(x * x + y * y), c.magnitude, `${c.name}.magnitude`);
    assert.ok(Math.sqrt(x * x + y * y) <= 1 + TOLERANCE, `${c.name}: magnitude never exceeds 1`);
  });
}

type CombinedCase = {
  name: string; declaration: InputDeclaration; keysDown: string[];
  gamepad: { buttons: number[]; axes: number[] } | null; vector: number[];
};
for (const c of axisDoc["combined"] as CombinedCase[]) {
  test(`input-axis-combined/${c.name}`, () => {
    const { bindings, diagnostics } = resolveInputDeclarations([c.declaration]);
    assert.deepEqual(diagnostics, [], `${c.name}: the declaration is clean`);
    const machine = new InputMachine(bindings);
    for (const k of c.keysDown) machine.keyDown(k);
    if (c.gamepad !== null) machine.gamepad(c.gamepad);
    const value = machine.commit().values[bindings[0]!.name] as InputAxisValue;
    close(value.x, c.vector[0]!, `${c.name}.x`);
    close(value.y, c.vector[1]!, `${c.name}.y`);
  });
}

type FrameOp = { op: string; key?: string; word?: string; buttons?: number[]; axes?: number[] };
type StreamCase = {
  name: string;
  declarations: InputDeclaration[];
  frames: Array<{
    ops: FrameOp[];
    values: { [name: string]: boolean | { x: number; y: number } };
    events: Array<{ name: string; x: number; y: number }>;
  }>;
};
for (const c of axisDoc["frames"] as StreamCase[]) {
  test(`input-frames/${c.name}`, () => {
    const { bindings, diagnostics } = resolveInputDeclarations(c.declarations);
    assert.deepEqual(diagnostics, [], `${c.name}: the declarations are clean`);
    const machine = new InputMachine(bindings);
    c.frames.forEach((frame, i) => {
      for (const op of frame.ops) {
        if (op.op === "keyDown") machine.keyDown(op.key!);
        else if (op.op === "keyUp") machine.keyUp(op.key!);
        else if (op.op === "touch") machine.touch(op.word!);
        else if (op.op === "touchRelease") machine.touchRelease(op.word!);
        else if (op.op === "gamepad") machine.gamepad({ buttons: op.buttons!, axes: op.axes! });
        else assert.fail(`${c.name}[${i}]: unknown op ${op.op}`);
      }
      const got = machine.commit();
      for (const [name, want] of Object.entries(frame.values)) {
        const have = got.values[name];
        if (typeof want === "boolean") {
          assert.equal(have, want, `${c.name}[${i}].${name}`);
        } else {
          const axis = have as InputAxisValue;
          close(axis.x, want.x, `${c.name}[${i}].${name}.x`);
          close(axis.y, want.y, `${c.name}[${i}].${name}.y`);
        }
      }
      assert.equal(got.events.length, frame.events.length,
        `${c.name}[${i}]: event count ${JSON.stringify(got.events)}`);
      got.events.forEach((e, j) => {
        assert.equal(e.name, frame.events[j]!.name, `${c.name}[${i}].event[${j}].name`);
        close(e.x, frame.events[j]!.x, `${c.name}[${i}].event[${j}].x`);
        close(e.y, frame.events[j]!.y, `${c.name}[${i}].event[${j}].y`);
      });
    });
  });
}

// ── attenuation.json — the positional-audio fold ────────────────────────────────────────

const attenuation = load("attenuation.json");

type AttenuationCase = {
  name: string; listener: number[]; source: number[];
  ref: number; max: number; rolloff: number;
  distance: number; gain: number; pan: number;
};
const attenuationCases = attenuation["cases"] as AttenuationCase[];
assert.ok(attenuationCases.length >= 12, "attenuation.json: suspiciously small");

for (const c of attenuationCases) {
  test(`audio-attenuation/${c.name}`, () => {
    const got = sceneAudioAttenuation(
      c.listener as [number, number, number],
      c.source as [number, number, number],
      { ref: c.ref, max: c.max, rolloff: c.rolloff },
    );
    close(got.distance, c.distance, `${c.name}.distance`);
    close(got.gain, c.gain, `${c.name}.gain`);
    close(got.pan, c.pan, `${c.name}.pan`);
    assert.ok(got.gain > 0 && got.gain <= 1 + TOLERANCE, `${c.name}: gain stays in (0, 1]`);
  });
}

test("audio-attenuation/kernel defaults agree with the corpus", () => {
  const defaults = attenuation["defaults"] as { ref: number; max: number; rolloff: number };
  assert.equal(AUDIO_DEFAULT_REF_DISTANCE, defaults.ref);
  assert.equal(AUDIO_DEFAULT_MAX_DISTANCE, defaults.max);
  assert.equal(AUDIO_DEFAULT_ROLLOFF, defaults.rolloff);
  // the defaults are what an omitted-opts call uses
  const explicit = sceneAudioAttenuation([0, 0, 0], [7, 0, 0], defaults);
  const implicit = sceneAudioAttenuation([0, 0, 0], [7, 0, 0]);
  assert.deepEqual(implicit, explicit);
});
