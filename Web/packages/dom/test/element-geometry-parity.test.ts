//
//  The LEDGER half of the element-contract geometry gate, in the ordinary Node suite.
//
//  runtime-pressure.md R23: the elements corpus pins per-element geometry from the Swift
//  reference and Compose is held to all of it, while web read the directory only to ask
//  whether a tag exists. `element-colour-parity.test.ts` closed the colour half. Geometry
//  needs a browser to be closed, and the browser leg is the file this one's ledger feeds.
//
//  WHAT RUNS HERE. Everything about the ledger that does not need a browser: that every
//  corpus key is classified, that no entry names a key the corpus dropped, that a reason is
//  a real sentence rather than a placeholder, and that the coverage numbers only move with
//  intent. That last one is the part that matters: a census kept honest without a browser is
//  what stops the browser leg's remaining findings from being quietly reclassified as
//  "absent" to make a run go green.
//
import { test } from "node:test";
import assert from "node:assert/strict";

import { census, geometryKeys, LEDGER } from "../oracle/element-geometry-parity.ts";

// The census as measured today. It moves ONLY with the landed change named: a promotion
// from drift to assert means the web renderer came into agreement, and a new corpus key
// means an element gained a pinned fact.
const ASSERTED = 62;   // +6: <Signature> landed - pad height, radius, border, the signing rule's
                       // two insets and the hint's size are all boxes a probe can measure
const DRIFT = 24;
const ADAPT = 1;
const ABSENT = 26;     // +1: <Signature>'s strokeWidth is a canvas lineWidth, not a box. Its
                       // minPointDistance and coordinateScale left the fixture entirely when the
                       // ink LAW moved to the `<ink>` primitive (Conformance/canvas/ink.json)

test("every corpus geometry key is classified, and no entry outlives its key", () => {
  const c = census();
  assert.deepEqual(c.unclassified, [],
    "a corpus key with no ledger entry is a fact nobody decided about");
  assert.deepEqual(c.stale, [],
    "a ledger entry naming a key the corpus dropped is a rule about nothing");
  assert.equal(c.total, c.asserted + c.allowlisted + c.absent, "the three numbers tile");
});

test("the coverage census moves only with the landed change named", () => {
  const c = census();
  assert.equal(c.asserted, ASSERTED,
    `asserted is ${c.asserted}, pinned at ${ASSERTED}. UP means a divergence was fixed or a `
    + `probe was written - say which. DOWN means an assertion was downgraded, which needs a `
    + `louder reason than a green run.`);
  assert.equal(c.drift, DRIFT, `drift is ${c.drift}, pinned at ${DRIFT}`);
  assert.equal(c.adapt, ADAPT, `adapt is ${c.adapt}, pinned at ${ADAPT}`);
  assert.equal(c.absent, ABSENT, `absent is ${c.absent}, pinned at ${ABSENT}`);
});

test("every allowlisted divergence carries a reason, and every absence says who owns it", () => {
  for (const { where } of geometryKeys()) {
    const entry = LEDGER[where]!;
    if (entry.kind === "assert") continue;
    const reason = (entry as { note?: string }).note ?? "";
    assert.ok(reason.trim().length >= 24,
      `${where}: kind "${entry.kind}" needs a written note, got ${JSON.stringify(reason)}`);
    assert.ok(!/^(tbd|todo|fixme|n\/a|unknown)\b/i.test(reason.trim()),
      `${where}: "${reason}" is a placeholder, not a reason`);
  }
});

test("a pinned divergence records the web value it is pinned at, so it cannot drift twice", () => {
  for (const { where } of geometryKeys()) {
    const entry = LEDGER[where]!;
    if (entry.kind !== "drift" && entry.kind !== "adapt") continue;
    const web = (entry as { web?: number }).web;
    assert.equal(typeof web, "number",
      `${where}: a pinned divergence must carry the measured web value, or the next move is invisible`);
  }
});
