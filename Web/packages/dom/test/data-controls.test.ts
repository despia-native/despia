import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DATA_CONTROL_ELEMENTS,
  DATA_CONTROL_GLOBAL_ELEMENTS,
  DATA_CONTROL_LIMITS,
  DATA_CONTROL_TAGS,
  DATA_CONTROLS_CSS,
  calendarDateKey,
  calendarFirstWeekday,
  calendarMonthGrid,
  normalizeDataControlOptions,
  normalizeCalendarLocale,
  normalizeSegmentedSelection,
  parseCalendarDate,
  parseDataControlCsv,
  registerDataControls,
} from "../src/data-controls.ts";
import { ELEMENTS, GLOBAL_ELEMENTS } from "../src/elements.ts";

test("data controls register lowercase primitives and capitalized global fallbacks separately", () => {
  assert.equal(ELEMENTS["calendar"], undefined);
  assert.equal(GLOBAL_ELEMENTS["Table"], undefined);
  registerDataControls();
  for (const tag of ["calendar", "segmentedButton", "refreshable", "refresh"]) {
    assert.equal(ELEMENTS[tag], DATA_CONTROL_ELEMENTS[tag]);
    assert.equal(DATA_CONTROL_TAGS.has(tag), true);
  }
  for (const tag of ["Table", "RadioGroup"]) {
    assert.equal(GLOBAL_ELEMENTS[tag], DATA_CONTROL_GLOBAL_ELEMENTS[tag]);
    assert.equal(DATA_CONTROL_TAGS.has(tag), true);
    assert.equal(ELEMENTS[tag], undefined, `${tag} remains a global fallback so authored composition keeps precedence`);
  }
});

test("CSV and bound options have fixed allocation and text ceilings", () => {
  assert.deepEqual(parseDataControlCsv(" Day, Week,, Month "), ["Day", "Week", "Month"]);
  assert.deepEqual(normalizeDataControlOptions([
    { key: 7, title: "Seven" },
    "Plain",
    { key: "", title: "Rejected" },
  ], "key", "title"), [
    { value: "7", label: "Seven" },
    { value: "Plain", label: "Plain" },
  ]);
  const hostile = normalizeDataControlOptions(Array.from({ length: DATA_CONTROL_LIMITS.options + 10 }, (_, index) => index));
  assert.equal(hostile.length, DATA_CONTROL_LIMITS.options);
  assert.equal(normalizeDataControlOptions(["x".repeat(DATA_CONTROL_LIMITS.textCharacters + 10)])[0]?.value.length,
    DATA_CONTROL_LIMITS.textCharacters);
});

test("calendar wire parser is strict, leap-safe and accepts a datetime date prefix", () => {
  assert.deepEqual(parseCalendarDate("2028-02-29T23:59:00Z"), { year: 2028, month: 2, day: 29 });
  assert.equal(parseCalendarDate("2027-02-29"), null);
  assert.equal(parseCalendarDate("2026-13-01"), null);
  assert.equal(parseCalendarDate("2026-04-31"), null);
  assert.equal(calendarDateKey({ year: 42, month: 3, day: 7 }), "0042-03-07");
  assert.deepEqual(calendarMonthGrid(42, 3, 0), { days: 31, leading: 6 }, "years below 100 stay proleptic");
});

test("calendar month geometry and locale first-weekday logic are deterministic", () => {
  // July 2026 begins Wednesday. Sunday-first has three blanks; Monday-first two.
  assert.deepEqual(calendarMonthGrid(2026, 7, 0), { days: 31, leading: 3 });
  assert.deepEqual(calendarMonthGrid(2026, 7, 1), { days: 31, leading: 2 });
  assert.equal(calendarFirstWeekday("en-US"), 0);
  assert.equal(calendarFirstWeekday("de-DE"), 1);
  assert.equal(calendarFirstWeekday("not_a_locale"), calendarFirstWeekday("en"));
  assert.equal(normalizeCalendarLocale("not_a_locale"), "en");
});

test("segmented selection rejects foreign IDs, de-duplicates and preserves option order", () => {
  assert.deepEqual(normalizeSegmentedSelection("Month,Day,Month,Unknown", ["Day", "Week", "Month"]), ["Day", "Month"]);
  assert.deepEqual(normalizeSegmentedSelection(null, ["A", "B"]), []);
});

test("weak data-control sheet covers responsive, RTL-safe, reduced-motion and forced-colors behavior", () => {
  assert.ok(DATA_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(DATA_CONTROLS_CSS.includes("content-visibility: auto"));
  assert.ok(DATA_CONTROLS_CSS.includes("@media (prefers-reduced-motion: reduce)"));
  assert.ok(DATA_CONTROLS_CSS.includes("@media (forced-colors: active)"));
  assert.ok(DATA_CONTROLS_CSS.includes("var(--dsx-surface-highlight)"));
  assert.ok(DATA_CONTROLS_CSS.includes("box-shadow: inset 0 0 0 3px var(--dsx-data-tint)"));
  assert.match(
    DATA_CONTROLS_CSS,
    /@media \(min-width: 64rem\)[\s\S]*?\.dsx-segmented-button-item\s*\{[^}]*min-height:\s*36px;/,
    "desktop segmented actions remain within the 36–40px precision contract",
  );
  assert.ok(!DATA_CONTROLS_CSS.includes("!important"));
  assert.ok(!DATA_CONTROLS_CSS.includes("border-inline-start"));
  assert.equal(DATA_CONTROL_LIMITS.refreshBusyMaximumMs <= 120_000, true);
});
