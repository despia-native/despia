//
//  The unit plane on the TS runner (reference). OpenSource/Conformance/units/length.json is
//  platform-neutral because the same question is asked by every editor surface on every
//  renderer: what happens to the number when the unit changes.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  convertLength, lengthUnitOf, parseLength, ROOT_FONT_SIZE_PX, DEFAULT_LENGTH_UNIT,
  SWITCHABLE_LENGTH_UNITS, type LengthUnit,
} from "../dist/index.js";

const corpus = JSON.parse(readFileSync(
  join(import.meta.dirname, "../../../../Conformance/units/length.json"), "utf8"));

test("units: the root the rem relationship is defined against is the documented one", () => {
  assert.equal(ROOT_FONT_SIZE_PX, corpus.rootFontSizePx);
  assert.equal(DEFAULT_LENGTH_UNIT, "rem",
    "rem is the default: a length in rem is accessibility-responsive, one in px is frozen");
  assert.deepEqual([...SWITCHABLE_LENGTH_UNITS], ["rem", "px"]);
});

for (const c of corpus.convert as Array<{ name: string; from: string; to: LengthUnit; expect: string }>) {
  test(`units/convert: ${c.name}`, () => {
    assert.equal(convertLength(c.from, c.to), c.expect);
  });
}

for (const c of corpus.unitOf as Array<{ name: string; text: string; expect: LengthUnit }>) {
  test(`units/unitOf: ${c.name}`, () => {
    assert.equal(lengthUnitOf(c.text), c.expect);
  });
}

test("units: a round trip through both units returns the original text", () => {
  // The property that matters at the keyboard: an author toggling the chip twice must get
  // their own value back, not one that drifted by a rounding step each time.
  for (const original of ["42px", "17px", "15px", "24px", "1.5rem", "0.9375rem"]) {
    const other: LengthUnit = original.endsWith("px") ? "rem" : "px";
    const back: LengthUnit = original.endsWith("px") ? "px" : "rem";
    assert.equal(convertLength(convertLength(original, other), back), original);
  }
});

test("units: parseLength refuses what it cannot own", () => {
  assert.deepEqual(parseLength("16px"), { value: 16, unit: "px" });
  assert.deepEqual(parseLength("16"), { value: 16, unit: "" });
  assert.equal(parseLength("calc(1px + 1rem)"), null);
  assert.equal(parseLength(undefined), null);
  assert.equal(parseLength("var(--dsx-space-3)"), null);
});
