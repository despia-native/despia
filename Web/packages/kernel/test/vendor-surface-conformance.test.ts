//
//  vendor-surface-conformance.test.ts - the V02..V06 inline-vendor-surface corpora through
//  the TS kernel: OpenSource/Conformance/inline-surfaces/{stream,clerk,admob,revenuecat,
//  scanner}.json. The Kotlin twin (:core VendorSurfaceConformanceTest) and the Swift twin
//  (Engine/iOS/VendorSurface.swift, record lane) run the SAME five files.
//
//  Two things are being proven here at once, and both matter:
//
//    1. THE SHARED CORE IS SHARED. Every vendor's `sessionRef`, `machine` and `retain`
//       section runs through V01's vendor-session.ts unchanged. Five vendors, ONE session
//       machine: if this file ever needs a per-vendor branch, the family has forked and
//       the law in inline-native-surfaces.md is broken.
//    2. THE FAMILY FOLDS AGREE. The permission ladder, the call roster, the ad slot and
//       request gate, the paywall ordering, the sign-in ladder and the scan dedupe are
//       one implementation each, judged by the corpus rather than by a renderer.
//
//  Missing corpus = loud failure. A silently-skipped conformance suite is how drift
//  starts, and the drift here is a camera surface that asks for permission on one
//  platform and refuses on another.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  resolveSessionRef, VendorSessionMachine, type VendorStep,
  vendorRetainKey,
} from "../src/vendor-session.ts";
import {
  surfaceGate, rosterFold, rosterColumns, adSlot, AD_SIZES, adRequestGate,
  paywallFold, PACKAGE_ORDER, PACKAGE_MONTHS, signInLadder, SIGNIN_STRATEGY_ORDER,
  scanGate, SCAN_DEBOUNCE_MS,
} from "../src/vendor-surface.ts";

const VENDORS = ["stream", "clerk", "admob", "revenuecat", "scanner", "pay"] as const;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/inline-surfaces");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/inline-surfaces not found");
    dir = parent;
  }
}

function corpus(vendor: string): { [k: string]: any } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), `${vendor}.json`), "utf-8")) as { [k: string]: any };
  assert.equal(doc["version"], 1, `${vendor}.json: version`);
  return doc;
}

/** Every section that declares one, across all five files. */
function sections(name: string): Array<[string, { [k: string]: any }]> {
  const found: Array<[string, { [k: string]: any }]> = [];
  for (const vendor of VENDORS) {
    const section = corpus(vendor)[name];
    if (section !== undefined) found.push([vendor, section]);
  }
  assert.ok(found.length > 0, `no corpus declares a ${name} section`);
  return found;
}

// -- 1 - the SHARED secret boundary, five vendors -------------------------------------

test("family: every vendor's session reference resolves through the ONE shared resolver", () => {
  for (const [vendor, section] of sections("sessionRef")) {
    const kinds = new Set(section["kinds"] as string[]);
    const refusals = new Set(section["refusals"] as string[]);
    const families = new Set(section["families"] as string[]);
    const reached = new Set<string>();
    const cases = section["cases"] as Array<{ name: string; value: string | null; expect: any }>;
    assert.ok(cases.length > 0, `${vendor}: sessionRef corpus must not be empty`);

    for (const row of cases) {
      const where = `${vendor}: ${row.name}`;
      const result = resolveSessionRef(row.value);
      if ("error" in row.expect) {
        assert.equal(result.ok, false, `${where}: expected refusal ${row.expect.error}, got ${JSON.stringify(result)}`);
        if (result.ok !== false) continue;
        assert.ok(refusals.has(row.expect.error), `${where}: undeclared refusal ${row.expect.error}`);
        assert.equal(result.error, row.expect.error, `${where}: refusal code`);
        assert.equal(result.family ?? undefined, row.expect.family ?? undefined, `${where}: credential family`);
        if (row.expect.family !== undefined) {
          assert.ok(families.has(row.expect.family), `${where}: undeclared family ${row.expect.family}`);
          reached.add(row.expect.family);
        }
        continue;
      }
      assert.equal(result.ok, true, `${where}: expected a reference, got ${JSON.stringify(result)}`);
      if (result.ok !== true) continue;
      assert.ok(kinds.has(row.expect.kind), `${where}: undeclared kind ${row.expect.kind}`);
      assert.equal(result.value.kind, row.expect.kind, `${where}: kind`);
      assert.equal(result.value.path, row.expect.path, `${where}: path`);
    }
    for (const family of families) {
      assert.ok(reached.has(family), `${vendor}: family ${family} is declared but no row pins it`);
    }
  }
});

// -- 2 - the SHARED session machine, five vendors -------------------------------------

test("family: every vendor's lifecycle runs on the ONE shared session machine", () => {
  for (const [vendor, section] of sections("machine")) {
    assert.deepEqual(section["views"], ["overlay", "inline"], `${vendor}: canonical view order`);
    const states = new Set(section["states"] as string[]);
    const refusals = new Set(section["refusals"] as string[]);
    const cases = section["cases"] as Array<{ name: string; steps: VendorStep[]; expect: any[] }>;
    assert.ok(cases.length > 0, `${vendor}: machine corpus must not be empty`);

    for (const row of cases) {
      assert.equal(row.steps.length, row.expect.length, `${vendor}: ${row.name}: one expectation per step`);
      const machine = new VendorSessionMachine();
      row.steps.forEach((step, index) => {
        const result = machine.step(step);
        const expected = row.expect[index];
        const where = `${vendor}: ${row.name}: step ${index} (${step.op})`;
        assert.ok(states.has(expected.state), `${where}: undeclared state ${expected.state}`);

        if ("error" in expected) {
          assert.equal(result.ok, false, `${where}: expected refusal ${expected.error}, got ${JSON.stringify(result)}`);
          if (result.ok !== false) return;
          assert.ok(refusals.has(expected.error), `${where}: undeclared refusal ${expected.error}`);
          assert.equal(result.error, expected.error, `${where}: refusal code`);
          assert.equal(result.state, expected.state, `${where}: state after a refusal`);
          assert.equal(machine.state, expected.state, `${where}: a refusal never moves the machine`);
          return;
        }
        assert.equal(result.ok, true, `${where}: expected a step, got ${JSON.stringify(result)}`);
        if (result.ok !== true) return;
        assert.equal(result.state, expected.state, `${where}: state`);
        assert.deepEqual([...result.notify], expected.notify, `${where}: notify audience`);
        assert.equal(result.attempts, expected.attempts, `${where}: attempts`);
        assert.equal(result.outcome ?? undefined, expected.outcome ?? undefined, `${where}: outcome`);
        assert.equal(result.by ?? undefined, expected.by ?? undefined, `${where}: originating view`);
        assert.equal(result.code ?? undefined, expected.code ?? undefined, `${where}: failure code`);
      });
    }
  }
});

test("family: the double-attempt guard holds for every vendor in the family", () => {
  // The law behind the per-vendor rows, asserted directly: whatever the vendor calls its
  // attempt - a join, a submit, an ad request, a purchase, a delivered code - a second one
  // while the first is in flight is refused, from EITHER face.
  for (const originator of ["inline", "overlay"] as const) {
    const other = originator === "inline" ? "overlay" : "inline";
    const machine = new VendorSessionMachine();
    machine.step({ op: "open" });
    machine.step({ op: "attach", view: originator });
    machine.step({ op: "attach", view: other });
    machine.step({ op: "start", view: originator });
    const second = machine.step({ op: "start", view: other });
    assert.equal(second.ok, false);
    if (second.ok === false) assert.equal(second.error, "busy");
  }
});

// -- 3 - keyed identity, five vendors -------------------------------------------------

test("family: every vendor's retain keys agree with the corpus", () => {
  for (const [vendor, section] of sections("retain")) {
    const cases = section["keys"] as Array<{ name: string; input: any; expect: string }>;
    assert.ok(cases.length > 0, `${vendor}: retain corpus must not be empty`);
    for (const row of cases) {
      assert.equal(vendorRetainKey(row.input), row.expect, `${vendor}: ${row.name}`);
    }
  }
});

// -- 4 - the live-surface permission ladder -------------------------------------------

test("family: the surface gate agrees with the corpus", () => {
  for (const [vendor, section] of sections("gate")) {
    const renders = new Set(section["renders"] as string[]);
    const codes = new Set(section["codes"] as string[]);
    const cases = section["cases"] as Array<{ name: string; input: any; expect: any }>;
    assert.ok(cases.length > 0, `${vendor}: gate corpus must not be empty`);
    for (const row of cases) {
      const gate = surfaceGate(row.input);
      assert.deepEqual({ ...gate }, row.expect, `${vendor}: ${row.name}`);
      assert.ok(renders.has(gate.render), `${vendor}: undeclared render ${gate.render}`);
      assert.ok(codes.has(gate.code), `${vendor}: undeclared code ${gate.code}`);
      assert.equal(gate.code === "", gate.render === "surface",
                   `${vendor}: ${row.name}: only the live surface is codeless`);
    }
  }
});

test("family: one permission ladder, not one per vendor", () => {
  // stream.json and scanner.json both pin the gate. The rows they share must agree, or
  // there are two ladders wearing one name.
  const stream = corpus("stream")["gate"]["cases"] as Array<{ input: any; expect: any }>;
  const scanner = corpus("scanner")["gate"]["cases"] as Array<{ input: any; expect: any }>;
  for (const row of scanner) {
    const twin = stream.find((s) => JSON.stringify(s.input) === JSON.stringify(row.input));
    if (twin !== undefined) assert.deepEqual(row.expect, twin.expect, "the two files disagree about one input");
  }
});

// -- 5 - the call roster ---------------------------------------------------------------

test("family: the call roster agrees with the corpus", () => {
  const section = corpus("stream")["roster"];
  const cases = section["cases"] as Array<{ name: string; input: any; expect: any }>;
  assert.ok(cases.length > 0, "roster corpus must not be empty");
  for (const row of cases) {
    const fold = rosterFold(row.input);
    assert.deepEqual({
      order: [...fold.order], visible: [...fold.visible], overflow: fold.overflow,
      spotlight: fold.spotlight, columns: fold.columns, rows: fold.rows,
    }, row.expect, row.name);
    assert.ok(fold.rows * fold.columns >= fold.visible.length, `${row.name}: the grid must fit its tiles`);
  }
});

test("family: the roster is a total order, so the grid cannot shuffle", () => {
  const people = [
    { id: "c", joinedAt: 1 }, { id: "a", joinedAt: 1 }, { id: "b", joinedAt: 1, local: true },
    { id: "d", joinedAt: 1, dominant: true },
  ];
  const once = rosterFold({ participants: people });
  const shuffled = rosterFold({ participants: [...people].reverse() });
  assert.deepEqual([...once.order], [...shuffled.order], "input order must not reach the output");
  assert.equal(rosterColumns(0), 0);
});

// -- 6 - the ad slot and the request gate ----------------------------------------------

test("family: the ad slot geometry agrees with the corpus", () => {
  const section = corpus("admob")["slot"];
  for (const size of section["sizes"] as string[]) {
    if (size === "adaptive") continue;
    assert.ok(AD_SIZES[size] !== undefined, `declared size ${size} has no geometry`);
  }
  for (const row of section["cases"] as Array<{ name: string; input: any; expect: any }>) {
    const slot = adSlot(row.input.size, row.input.width);
    assert.deepEqual({ ...slot }, row.expect, row.name);
    assert.ok(!(slot.adaptive && slot.height > 0), `${row.name}: an adaptive slot must not carry a guessed height`);
  }
});

test("family: the ad request gate agrees with the corpus", () => {
  const section = corpus("admob")["request"];
  const codes = new Set(section["codes"] as string[]);
  for (const row of section["cases"] as Array<{ name: string; input: any; expect: any }>) {
    const gate = adRequestGate(row.input);
    assert.deepEqual({ ...gate }, row.expect, row.name);
    assert.ok(codes.has(gate.code), `${row.name}: undeclared code ${gate.code}`);
    assert.equal(gate.request, gate.code === "", `${row.name}: a refused request must name a code`);
  }
});

test("family: no consent state that is not obtained or not_required ever requests", () => {
  // The policy half, asserted directly rather than only through rows: the gate is what
  // keeps an unconsented request off the wire, and that must not depend on a row existing.
  for (const consent of ["required", "unknown"] as const) {
    const gate = adRequestGate({ unitId: "ca-app-pub-x/y", enabled: true, consent });
    assert.equal(gate.request, false, `${consent} must never request`);
  }
});

// -- 7 - the paywall --------------------------------------------------------------------

test("family: the paywall fold agrees with the corpus", () => {
  const section = corpus("revenuecat")["paywall"];
  assert.deepEqual([...PACKAGE_ORDER], section["packageOrder"]);
  assert.deepEqual({ ...PACKAGE_MONTHS }, section["comparableMonths"]);
  for (const row of section["cases"] as Array<{ name: string; input: any; expect: any }>) {
    const fold = paywallFold(row.input);
    assert.deepEqual({
      order: [...fold.order], defaultId: fold.defaultId, badgeId: fold.badgeId, savings: fold.savings,
    }, row.expect, row.name);
    assert.equal(fold.badgeId === "", fold.savings === 0, `${row.name}: a badge and a saving travel together`);
    if (fold.defaultId !== "") assert.ok(fold.order.includes(fold.defaultId), `${row.name}: the default must be a real row`);
  }
});

// -- 8 - the sign-in ladder --------------------------------------------------------------

test("family: the sign-in ladder agrees with the corpus", () => {
  const section = corpus("clerk")["ladder"];
  assert.deepEqual([...SIGNIN_STRATEGY_ORDER], section["strategyOrder"]);
  const steps = new Set(section["steps"] as string[]);
  for (const row of section["cases"] as Array<{ name: string; input: any; expect: any }>) {
    const ladder = signInLadder(row.input);
    assert.deepEqual({
      step: ladder.step, fields: [...ladder.fields], strategies: [...ladder.strategies],
      terminal: ladder.terminal, code: ladder.code,
    }, row.expect, row.name);
    assert.ok(steps.has(ladder.step), `${row.name}: undeclared step ${ladder.step}`);
    assert.ok(ladder.terminal || ladder.step === "restart" || ladder.fields.length > 0,
              `${row.name}: a non-terminal rung must ask for something`);
  }
});

// -- 9 - the scan dedupe -----------------------------------------------------------------

test("family: the scan gate agrees with the corpus", () => {
  const section = corpus("scanner")["scan"];
  assert.equal(SCAN_DEBOUNCE_MS, section["defaultDebounceMs"]);
  const reasons = new Set(section["reasons"] as string[]);
  for (const row of section["cases"] as Array<{ name: string; input: any; expect: any }>) {
    const gate = scanGate(row.input);
    assert.deepEqual({ ...gate }, row.expect, row.name);
    assert.ok(reasons.has(gate.reason), `${row.name}: undeclared reason ${gate.reason}`);
  }
});

test("family: a live preview cannot fire the same code twice inside one window", () => {
  // Thirty frames of the same code, the bug this fold exists to stop.
  let last = "";
  let lastAt = 0;
  let fired = 0;
  for (let frame = 0; frame < 30; frame += 1) {
    const at = frame * 33;
    const gate = scanGate({ value: "https://despia.com", format: "qr", at, mode: "continuous", lastValue: last, lastAt });
    if (gate.emit) { fired += 1; last = "https://despia.com"; lastAt = at; }
  }
  assert.equal(fired, 1, "one code, one event");
});
