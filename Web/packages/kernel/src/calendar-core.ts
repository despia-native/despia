//
//  calendar-core.ts — the shared Core/Calendar core: the `futureEvents` span decision, the one
//  date grammar, the iOS 17 access split, the calendar-target refusals, the reminders absence,
//  the editor result-fidelity ladder and RFC 5545 recurrence. The law is the corpus,
//  OpenSource/Conformance/calendar/{crud,present,recurrence}.json (parity F12); the Kotlin twin
//  is :core CalendarCore.kt and the Swift twin is Engine/iOS/CalendarCore.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: EventKit, CalendarContract and the .ics
//  handoff are per-renderer plumbing. Three different mechanisms have to agree on the same
//  strings and the same refusals, and this is where that agreement is written down once.
//

// ─── the span decision ──────────────────────────────────────────────────────────────────────

/** What one write actually touches. `scope` is the shared word; the mechanism differs per
 *  renderer (EKSpan on iOS, a series update vs a single-occurrence exception row on Android). */
export type CalendarSpan = "thisEvent" | "futureEvents";

/**
 * The dangerous default in every calendar API is the one where editing or deleting a single
 * occurrence quietly takes the whole recurring series with it, and it is unrecoverable from
 * inside the app. So `futureEvents` has NO series-wide default anywhere: omitted means this
 * occurrence only, and only an explicit true widens the blast radius.
 */
export function calendarSpan(recurring: boolean, futureEvents: boolean | null | undefined): CalendarSpan {
  return recurring && futureEvents === true ? "futureEvents" : "thisEvent";
}

// ─── the date grammar ───────────────────────────────────────────────────────────────────────

export const CALENDAR_INVALID_DATE = "invalid_date";
export const CALENDAR_INVALID_DATE_MESSAGE =
  "start and end must be ISO-8601 strings or epoch seconds, and end must not precede start.";

/** Days since the epoch for a proleptic-Gregorian civil date. Pure arithmetic on purpose: a
 *  date library would be a fourth implementation to keep in step with three renderers. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The one date grammar on all three renderers: ISO-8601 (with or without fractional seconds and
 * with an offset or Z) or epoch SECONDS, as a number or a numeric string. Anything else is
 * refused before the store is touched, so prose never becomes a silently wrong event.
 *
 * Returns epoch SECONDS, or null.
 */
export function parseCalendarDate(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return Number(text);

  const match = ISO_DATE_TIME.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  let offset = 0;
  const zone = match[7];
  if (zone !== undefined && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offset = sign * (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4)) * 60);
  }
  return daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
}

/** A start/end pair. A zero-length event is LEGAL — it is a marker, not a mistake — but an end
 *  before its start is refused. */
export function calendarWindow(start: unknown, end: unknown): { start: number; end: number } | null {
  const from = parseCalendarDate(start);
  const to = parseCalendarDate(end);
  if (from === null || to === null || to < from) return null;
  return { start: from, end: to };
}

// ─── the access split ───────────────────────────────────────────────────────────────────────

/**
 * Which grant each action requires. `present` with an `id` is the one asterisk: reading the
 * event back to prefill the editor is a read, so THAT spelling needs a read grant while the
 * prefill-a-new-event spelling needs none.
 */
export const CALENDAR_PERMISSION_SURFACE: { readonly [action: string]: string } = {
  present: "none",
  "present.withId": "read",
  permission: "none",
  calendars: "read",
  events: "read",
  create: "write",
  update: "write",
  remove: "write",
  add: "none",
  ics: "none",
};

export const CALENDAR_READ_REFUSAL =
  'Calendar access has not been granted. Call dsx.module.calendar.permission with level "read" first.';
export const CALENDAR_WRITE_REFUSAL =
  'Writing to the calendar has not been granted. Call dsx.module.calendar.permission with level '
  + '"write" first, or use dsx.module.calendar.present, which needs no permission.';
export const CALENDAR_WITH_ID_REFUSAL =
  'Opening an existing event needs a read grant. Call dsx.module.calendar.permission with level "read" first.';

export interface CalendarDecision {
  readonly runs: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly recoverable: boolean;
  /** Always false: no action in this module prompts on the caller's behalf. */
  readonly prompted: boolean;
}

const CALENDAR_ALLOWED: CalendarDecision =
  { runs: true, error: null, message: null, recoverable: true, prompted: false };

function deny(error: string, message: string, recoverable = true): CalendarDecision {
  return { runs: false, error, message, recoverable, prompted: false };
}

/**
 * The iOS 17 split. `writeOnly` is a real grant that can create and change events but must NEVER
 * satisfy a read: an app that got write-only access and then enumerated the diary would be
 * defeating the point of the split.
 */
export function calendarAccessDecision(access: string | null | undefined, action: string): CalendarDecision {
  const needs = CALENDAR_PERMISSION_SURFACE[action];
  if (needs === undefined) return deny("permission_denied", CALENDAR_READ_REFUSAL);
  if (needs === "none") return CALENDAR_ALLOWED;
  const word = String(access ?? "").trim();
  if (word === "restricted") {
    return deny("permission_denied", needs === "read" ? CALENDAR_READ_REFUSAL : CALENDAR_WRITE_REFUSAL, false);
  }
  if (needs === "read") {
    if (word === "granted") return CALENDAR_ALLOWED;
    return deny("permission_denied", action === "present.withId" ? CALENDAR_WITH_ID_REFUSAL : CALENDAR_READ_REFUSAL);
  }
  if (word === "granted" || word === "writeOnly") return CALENDAR_ALLOWED;
  return deny("permission_denied", CALENDAR_WRITE_REFUSAL);
}

/**
 * A subscribed or holiday calendar cannot take a write. Refusing is the contract; silently
 * retargeting the default calendar would put the user's event somewhere they did not choose.
 */
export function calendarTargetDecision(target: {
  readonly calendarId?: string | null;
  readonly exists?: boolean;
  readonly writable?: boolean;
  readonly hasDefault?: boolean;
}): CalendarDecision {
  const id = target.calendarId ?? null;
  if (id === null || id === "") {
    return target.hasDefault === false
      ? deny("read_only_calendar", "That calendar does not accept new events.")
      : CALENDAR_ALLOWED;
  }
  if (target.exists === false) {
    return deny("not_found", "No calendar with that id exists on this device.", false);
  }
  if (target.writable === false) {
    return deny("read_only_calendar", "That calendar does not accept new events.");
  }
  return CALENDAR_ALLOWED;
}

/** Reminders exist on iOS only. Everywhere else the whole sub-namespace is the TYPED ABSENCE:
 *  never an empty list, which a caller would read as "this user has no reminders". */
export function calendarRemindersSupport(renderer: string): {
  supported: boolean; error: string | null; remindersAccess: string | null;
} {
  if (renderer === "ios") return { supported: true, error: null, remindersAccess: null };
  return { supported: false, error: "unsupported_platform", remindersAccess: "unsupported" };
}

// ─── the editor result-fidelity ladder ──────────────────────────────────────────────────────

/** renderer -> the results it can actually report. A renderer must never resolve a result
 *  outside its own list, and `unknown` is never upgraded to `saved` on a hope. */
export const CALENDAR_RESULT_FIDELITY: { readonly [renderer: string]: readonly string[] } = {
  ios: ["saved", "cancelled", "deleted"],
  android: ["saved", "cancelled", "unknown"],
  web: ["unknown"],
};

export interface CalendarPresentOutcome {
  readonly result: string | null;
  readonly hasId: boolean;
  /** The v3 wire spelling of the outcome, or null when nothing is known to have happened. */
  readonly broadcast: string | null;
  readonly error: string | null;
  readonly presented: boolean;
}

export interface CalendarPresentInput {
  readonly renderer: string;
  readonly access?: string | null;
  /** What the editor reported, or null/absent when the platform reports nothing at all. */
  readonly editorAction?: string | null;
  /** The store verification, where a read grant made one possible. */
  readonly eventFound?: boolean;
  readonly id?: string | null;
  readonly start?: unknown;
  readonly end?: unknown;
}

/**
 * The result-fidelity ladder: iOS knows exactly what the user did, Android knows only if a read
 * grant lets it verify against the provider, and the web never knows. `unknown` is the honest
 * answer at each rung where the platform does not report.
 *
 * Both refusals happen BEFORE anything is presented: an unparseable window and a `present({id})`
 * with no read grant each cost the user nothing, and opening an empty editor first would.
 */
export function calendarPresentOutcome(input: CalendarPresentInput): CalendarPresentOutcome {
  const refused = (error: string): CalendarPresentOutcome =>
    ({ result: null, hasId: false, broadcast: null, error, presented: false });

  if (input.id !== undefined && input.id !== null && input.id !== "") {
    const decision = calendarAccessDecision(input.access, "present.withId");
    if (!decision.runs) return refused(decision.error ?? "permission_denied");
  } else if (input.start !== undefined || input.end !== undefined) {
    if (calendarWindow(input.start, input.end) === null) return refused(CALENDAR_INVALID_DATE);
  }

  const reported = input.editorAction ?? null;
  if (reported !== null) {
    switch (reported) {
      case "saved":
        return { result: "saved", hasId: true, broadcast: "saved", error: null, presented: true };
      case "deleted":
        return { result: "deleted", hasId: false, broadcast: "deleted", error: null, presented: true };
      case "canceled": case "cancelled":
        return { result: "cancelled", hasId: false, broadcast: "canceled", error: null, presented: true };
      default:
        return { result: "unknown", hasId: false, broadcast: null, error: null, presented: true };
    }
  }

  // Nothing reported. A read grant is the only thing that makes verification possible; without
  // one, `unknown` is the honest answer and must never be upgraded.
  if (input.eventFound !== undefined && calendarAccessDecision(input.access, "events").runs) {
    return input.eventFound
      ? { result: "saved", hasId: true, broadcast: "saved", error: null, presented: true }
      : { result: "cancelled", hasId: false, broadcast: "canceled", error: null, presented: true };
  }
  return { result: "unknown", hasId: false, broadcast: null, error: null, presented: true };
}

// ─── RFC 5545 recurrence ────────────────────────────────────────────────────────────────────

export const CALENDAR_INVALID_RECURRENCE = "invalid_recurrence";
export const CALENDAR_INVALID_RECURRENCE_MESSAGE = "recurrence must be an RFC 5545 RRULE string.";

export const RRULE_FREQUENCIES: readonly string[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
export const RRULE_DAYS: readonly string[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** One BYDAY entry. `ordinal` 0 means "every such weekday"; -1 is "the last one in the period". */
export interface RecurrenceDay { readonly day: string; readonly ordinal: number }

/** A parsed RRULE. `until` is an ISO-8601 instant, never a wall-clock day: a renderer that
 *  stored it as a day would end a DST-crossing series an hour early or late. */
export interface RecurrenceRule {
  readonly freq: string;
  readonly interval: number;
  readonly byDay?: readonly RecurrenceDay[];
  readonly byMonthDay?: readonly number[];
  readonly byMonth?: readonly number[];
  readonly bySetPos?: readonly number[];
  readonly count?: number;
  readonly until?: string;
}

/** Strip the optional `RRULE:` prefix and the surrounding whitespace, nothing else. */
export function normalizeRRule(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  return /^rrule:/i.test(text) ? text.slice(6) : text;
}

const ICS_INSTANT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** An iCalendar DATE-TIME to an ISO-8601 instant, or null. `20261231T235959Z` is an ABSOLUTE
 *  moment, which is exactly why a series ends when it was told to. */
export function icsInstantToISO(raw: string): string | null {
  const match = ICS_INSTANT.exec(raw.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, zulu] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zulu}`;
}

/** The inverse: an ISO instant back to the iCalendar spelling, exactly. */
export function isoToICSInstant(iso: string): string {
  return iso.replace(/[-:]/g, "");
}

function parseSignedList(raw: string, low: number, high: number): number[] | null {
  const out: number[] = [];
  for (const token of raw.split(",")) {
    const text = token.trim();
    if (!/^[+-]?\d+$/.test(text)) return null;
    const value = Number(text);
    if (value === 0 || value < low || value > high) return null;
    out.push(value);
  }
  return out.length === 0 ? null : out;
}

/**
 * Parse an RRULE. `recurrence` is an RRULE string and nothing else, because inventing a shape
 * for recurrence is how you ship a calendar integration that cannot express "the last Friday of
 * every month". A string that does not parse is a REFUSAL, never an event that quietly does not
 * repeat.
 */
export function parseRecurrence(raw: string | null | undefined): RecurrenceRule | null {
  const text = normalizeRRule(raw);
  if (text === "") return null;

  const parts: { [key: string]: string } = {};
  for (const pair of text.split(";")) {
    if (pair === "") continue;
    const kv = pair.split("=");
    if (kv.length !== 2 || kv[0] === "" || kv[1] === "") return null;
    parts[kv[0]!.toUpperCase()] = kv[1]!;
  }

  const freq = String(parts["FREQ"] ?? "").toUpperCase();
  if (!RRULE_FREQUENCIES.includes(freq)) return null;

  let interval = 1;
  if (parts["INTERVAL"] !== undefined) {
    if (!/^\d+$/.test(parts["INTERVAL"])) return null;
    interval = Number(parts["INTERVAL"]);
    if (interval < 1) return null;
  }

  let count: number | undefined;
  let until: string | undefined;
  if (parts["COUNT"] !== undefined) {
    if (!/^\d+$/.test(parts["COUNT"])) return null;
    count = Number(parts["COUNT"]);
    if (count < 1) return null;
  } else if (parts["UNTIL"] !== undefined) {
    const iso = icsInstantToISO(parts["UNTIL"]);
    if (iso === null) return null;
    until = iso;
  }

  let byDay: RecurrenceDay[] | undefined;
  if (parts["BYDAY"] !== undefined) {
    byDay = [];
    for (const token of parts["BYDAY"].split(",")) {
      const text2 = token.trim().toUpperCase();
      if (text2.length < 2) return null;
      const day = text2.slice(-2);
      if (!RRULE_DAYS.includes(day)) return null;
      const ordinalText = text2.slice(0, -2);
      let ordinal = 0;
      if (ordinalText !== "") {
        if (!/^[+-]?\d+$/.test(ordinalText)) return null;
        ordinal = Number(ordinalText);
        if (ordinal === 0 || Math.abs(ordinal) > 53) return null;
      }
      byDay.push({ day, ordinal });
    }
    if (byDay.length === 0) return null;
  }

  let byMonthDay: number[] | undefined;
  if (parts["BYMONTHDAY"] !== undefined) {
    const parsed = parseSignedList(parts["BYMONTHDAY"], -31, 31);
    if (parsed === null) return null;
    byMonthDay = parsed;
  }
  let byMonth: number[] | undefined;
  if (parts["BYMONTH"] !== undefined) {
    const parsed = parseSignedList(parts["BYMONTH"], 1, 12);
    if (parsed === null) return null;
    byMonth = parsed;
  }
  let bySetPos: number[] | undefined;
  if (parts["BYSETPOS"] !== undefined) {
    const parsed = parseSignedList(parts["BYSETPOS"], -366, 366);
    if (parsed === null) return null;
    bySetPos = parsed;
  }

  return { freq, interval, byDay, byMonthDay, byMonth, bySetPos, count, until };
}

/**
 * Serialise back to the canonical form, which is NOT always the input: an explicit `INTERVAL=1`
 * is dropped because it is the default, the `RRULE:` prefix is dropped, and the keys emit in one
 * fixed order so a round-trip on three renderers produces one string.
 */
export function formatRecurrence(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay !== undefined && rule.byDay.length > 0) {
    parts.push("BYDAY=" + rule.byDay
      .map((entry) => (entry.ordinal === 0 ? entry.day : `${entry.ordinal}${entry.day}`)).join(","));
  }
  if (rule.byMonthDay !== undefined && rule.byMonthDay.length > 0) {
    parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  }
  if (rule.byMonth !== undefined && rule.byMonth.length > 0) {
    parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  }
  if (rule.bySetPos !== undefined && rule.bySetPos.length > 0) {
    parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`);
  }
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  else if (rule.until !== undefined) parts.push(`UNTIL=${isoToICSInstant(rule.until)}`);
  return parts.join(";");
}
