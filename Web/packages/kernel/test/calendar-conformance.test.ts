//
//  calendar-conformance.test.ts — the SHARED calendar corpus through the TS kernel
//  (OpenSource/Conformance/calendar/{crud,present,recurrence}.json). The Kotlin twin (:core
//  CalendarConformanceTest) and the Swift reference (CalendarConformance, record lane) run the
//  SAME files, so the `futureEvents` blast radius, the iOS 17 writeOnly split, the editor
//  result-fidelity ladder and an RRULE round-trip cannot mean one thing on one renderer and
//  something else on another.
//
//  Missing corpus = loud failure, and so is an empty section.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  calendarSpan, parseCalendarDate, calendarWindow, calendarAccessDecision,
  calendarTargetDecision, calendarRemindersSupport, calendarPresentOutcome,
  parseRecurrence, formatRecurrence, CALENDAR_PERMISSION_SURFACE, CALENDAR_RESULT_FIDELITY,
} from "../src/calendar-core.ts";

type Json = { [key: string]: any };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/calendar");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/calendar not found");
    dir = parent;
  }
}

function corpus(file: string): Json {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as Json;
  assert.equal(doc["version"], 1, `${file}: version`);
  return doc;
}

function section(doc: Json, name: string, file: string): Json[] {
  const raw = doc[name];
  const rows = Array.isArray(raw) ? raw : (raw as Json | undefined)?.["cases"];
  assert.ok(Array.isArray(rows) && rows.length > 0, `${file}: ${name} must be a non-empty case array`);
  return rows as Json[];
}

test("calendar: the futureEvents span decision agrees with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "span", "crud.json")) {
    const given = testCase["given"] as Json;
    assert.equal(
      calendarSpan(given["recurring"] === true, given["futureEvents"] as boolean | null),
      (testCase["expect"] as Json)["scope"],
      `${testCase["name"]}: scope`,
    );
  }
});

test("calendar: the date grammar agrees with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "dates", "crud.json")) {
    const input = testCase["input"];
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;

    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      const window = calendarWindow((input as Json)["start"], (input as Json)["end"]);
      const error = window === null ? "invalid_date" : null;
      assert.equal(error, expect["error"] ?? null, `${name}: window`);
      continue;
    }
    const epoch = parseCalendarDate(input);
    if (expect["error"] !== undefined && expect["error"] !== null) {
      assert.equal(epoch, null, `${name}: expected ${expect["error"]}`);
      continue;
    }
    assert.equal(epoch, expect["epoch"], `${name}: epoch`);
  }
});

test("calendar: the access split agrees with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "access", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;
    const decision = calendarAccessDecision(given["access"] as string, given["action"] as string);

    assert.equal(decision.runs, expect["runs"], `${name}: runs`);
    if (expect["prompted"] !== undefined) assert.equal(decision.prompted, expect["prompted"], `${name}: prompted`);
    assert.equal(decision.error, expect["error"] ?? null, `${name}: error`);
    if (expect["messageNames"] !== undefined) {
      assert.ok(
        String(decision.message ?? "").toLowerCase().includes(String(expect["messageNames"]).toLowerCase()),
        `${name}: the refusal must name ${expect["messageNames"]}, got ${decision.message}`,
      );
    }
  }
});

test("calendar: the calendar-target refusals agree with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "calendars", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const decision = calendarTargetDecision({
      calendarId: given["calendarId"] as string | null,
      exists: given["exists"] as boolean | undefined,
      writable: given["writable"] as boolean | undefined,
      hasDefault: given["hasDefault"] as boolean | undefined,
    });
    assert.equal(decision.runs, expect["runs"], `${testCase["name"]}: runs`);
    assert.equal(decision.error, expect["error"] ?? null, `${testCase["name"]}: error`);
  }
});

test("calendar: the reminders absence agrees with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "reminders", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const support = calendarRemindersSupport(given["renderer"] as string);
    assert.equal(support.supported, expect["supported"], `${testCase["name"]}: supported`);
    assert.equal(support.error, expect["error"] ?? null, `${testCase["name"]}: error`);
    if (expect["remindersAccess"] !== undefined) {
      assert.equal(support.remindersAccess, expect["remindersAccess"], `${testCase["name"]}: remindersAccess`);
    }
  }
});

test("calendar: the present permission surface agrees with the corpus", () => {
  const surface = corpus("present.json")["permissionSurface"] as Json;
  const declared = Object.entries(surface).filter(([key]) => !key.startsWith("_"));
  assert.ok(declared.length > 0, "present.json: permissionSurface names no actions");
  for (const [action, grant] of declared) {
    assert.equal(CALENDAR_PERMISSION_SURFACE[action], grant, `permissionSurface: ${action}`);
  }
  for (const action of Object.keys(CALENDAR_PERMISSION_SURFACE)) {
    assert.ok(action in surface, `permissionSurface: the corpus does not pin ${action}`);
  }
});

test("calendar: the result-fidelity table agrees with the corpus", () => {
  const fidelity = corpus("present.json")["resultFidelity"] as Json;
  const declared = Object.entries(fidelity).filter(([key]) => !key.startsWith("_"));
  assert.ok(declared.length > 0, "present.json: resultFidelity names no renderers");
  for (const [renderer, results] of declared) {
    assert.deepEqual([...(CALENDAR_RESULT_FIDELITY[renderer] ?? [])], results, `resultFidelity: ${renderer}`);
  }
});

test("calendar: the present outcome ladder agrees with the corpus", () => {
  const doc = corpus("present.json");
  const fidelity = doc["resultFidelity"] as Json;
  for (const testCase of section(doc, "cases", "present.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;

    const outcome = calendarPresentOutcome({
      renderer: given["renderer"] as string,
      access: given["access"] as string,
      editorAction: given["editorAction"] as string | null,
      eventFound: given["eventFound"] as boolean | undefined,
      id: given["id"] as string | undefined,
      start: given["start"],
      end: given["end"],
    });

    if (expect["error"] !== undefined && expect["error"] !== null) {
      assert.equal(outcome.error, expect["error"], `${name}: error`);
      assert.equal(outcome.presented, expect["presented"] ?? false, `${name}: presented`);
      continue;
    }
    assert.equal(outcome.error, null, `${name}: error`);
    assert.equal(outcome.result, expect["result"], `${name}: result`);
    if (expect["hasId"] !== undefined) assert.equal(outcome.hasId, expect["hasId"], `${name}: hasId`);
    if ("broadcast" in expect) assert.equal(outcome.broadcast, expect["broadcast"], `${name}: broadcast`);
    assert.ok(
      (fidelity[given["renderer"] as string] as string[]).includes(outcome.result as string),
      `${name}: ${outcome.result} is outside ${given["renderer"]}'s fidelity list`,
    );
  }
});

test("calendar: the RRULE round-trip agrees with the corpus", () => {
  for (const testCase of section(corpus("recurrence.json"), "roundTrip", "recurrence.json")) {
    const name = testCase["name"] as string;
    const rule = parseRecurrence(testCase["rrule"] as string);
    assert.ok(rule !== null, `${name}: expected a parsed rule`);

    const parsed = testCase["parsed"] as Json;
    assert.equal(rule.freq, parsed["freq"], `${name}: freq`);
    assert.equal(rule.interval, parsed["interval"], `${name}: interval`);
    if (parsed["count"] !== undefined) assert.equal(rule.count, parsed["count"], `${name}: count`);
    if (parsed["until"] !== undefined) assert.equal(rule.until, parsed["until"], `${name}: until`);
    if (parsed["byDay"] !== undefined) {
      assert.deepEqual(rule.byDay?.map((d) => ({ day: d.day, ordinal: d.ordinal })), parsed["byDay"], `${name}: byDay`);
    }
    if (parsed["byMonthDay"] !== undefined) {
      assert.deepEqual([...(rule.byMonthDay ?? [])], parsed["byMonthDay"], `${name}: byMonthDay`);
    }
    if (parsed["byMonth"] !== undefined) {
      assert.deepEqual([...(rule.byMonth ?? [])], parsed["byMonth"], `${name}: byMonth`);
    }
    assert.equal(formatRecurrence(rule), testCase["canonical"], `${name}: canonical`);
  }
});

test("calendar: every rejected RRULE is refused loudly", () => {
  for (const testCase of section(corpus("recurrence.json"), "rejected", "recurrence.json")) {
    assert.equal(parseRecurrence(testCase["rrule"] as string), null, `${testCase["name"]}: must not parse`);
    assert.equal(testCase["error"], "invalid_recurrence", `${testCase["name"]}: error code`);
  }
});
