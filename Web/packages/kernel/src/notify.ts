//
//  notify.ts - the shared Core/Notify pure core: the permission ladder (including
//  iOS provisional authorization and the Settings-changed-while-backgrounded transition),
//  the TRIGGER RESOLVER, the Android channel-importance fold, the foreground-presentation
//  resolution and the tap-payload normalisation. The law is the corpus,
//  OpenSource/Conformance/notify/*.json (parity/F02-notifications.md); the Kotlin twin is
//  :core NotifyCore.kt and the Swift twin is Engine/iOS/NotifyCore.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: UNUserNotificationCenter,
//  NotificationManagerCompat and the browser Notification API all ask this module WHAT to do
//  and then do it. That split is what lets one corpus judge three renderers.
//
//  THE THREE RULES THIS FILE EXISTS FOR:
//
//  1. A REMINDER MUST FIRE AT THE SAME INSTANT ON EVERY PLATFORM. Scheduling is pure date
//     math, and it is where a notification stack is quietly wrong on exactly one platform:
//     an hour early in March, twice on the first Sunday in November, never on a leap day.
//     So the resolver takes ZONE RULES as data - a base offset plus the instants at which it
//     changes - and never asks a platform calendar anything.
//
//  2. PROVISIONAL AUTHORIZATION IS ONE FLAG. iOS will deliver quietly with no prompt at all
//     and then let the user promote it; it is the highest-conversion path in mobile and
//     almost nobody ships it, because it is one constant buried in a bitmask. Here it is
//     `{ provisional: true }`, and the escalation to full authorization is a real transition
//     with its own rule: a DECLINED escalation keeps the quiet grant.
//
//  3. AN UNDECLARED ANDROID CHANNEL IS A TYPED REFUSAL. Post to a channel that was never
//     created and the OS drops the notification with no exception and no log line. The
//     refusal names the id, because "channel not found" without it is the same afternoon.
//

// ---------------------------------------------------------------------------------------
// The permission ladder
// ---------------------------------------------------------------------------------------

/** The authorization statuses, as the module reports them (never a platform enum). */
export const NOTIFY_STATUSES: readonly string[] = ["undetermined", "denied", "provisional", "granted"];

/** The option vocabulary, exact case. `provisional` is an option like the rest so that quiet
 *  authorization is one flag rather than a second API. */
export const NOTIFY_OPTIONS: readonly string[] = [
  "alert", "sound", "badge", "carPlay", "announcement", "critical", "provisional",
];

/** What a request that names no option at all asks for. */
export const NOTIFY_DEFAULT_OPTIONS: readonly string[] = ["alert", "badge", "sound"];

/** What each platform can actually honour. Anything else is dropped AND REPORTED - an app
 *  that asked for critical alerts and got ordinary ones has to be able to find that out. */
export const NOTIFY_PLATFORM_OPTIONS: { readonly [platform: string]: readonly string[] } = {
  ios: ["alert", "sound", "badge", "carPlay", "announcement", "critical", "provisional"],
  android: ["alert", "sound", "badge"],
  web: ["alert", "sound", "badge"],
};

/** POST_NOTIFICATIONS became a runtime permission here. Below it there is nothing to ask. */
export const NOTIFY_ANDROID_RUNTIME_PERMISSION_SDK = 33;

export interface NotifyPermissionState {
  readonly status: string;
  /** True once the OS has shown the full-authorization dialog. It shows it once. */
  readonly promptShown: boolean;
  /** Apple grants the critical-alerts entitlement by application; without it the option is
   *  accepted by the API and silently does nothing. */
  readonly criticalEntitled?: boolean;
}

export interface NotifyPermissionRequest {
  readonly provisional?: boolean;
  readonly critical?: boolean;
  readonly alert?: boolean;
  readonly sound?: boolean;
  readonly badge?: boolean;
  readonly carPlay?: boolean;
  readonly announcement?: boolean;
}

export interface NotifyPermissionPlan {
  /** prompt = show the dialog · authorize = the QUIET provisional grant, no dialog ·
   *  settle = answer with what is already held · refuse = a typed error. */
  readonly action: "prompt" | "authorize" | "settle" | "refuse";
  readonly prompted: boolean;
  readonly quiet: boolean;
  /** True when this prompt is the provisional -> full conversion. */
  readonly escalation: boolean;
  readonly options: readonly string[];
  readonly dropped: readonly string[];
  readonly status?: string;
  readonly error?: string;
}

/** `provisional` and `critical` are MODIFIERS, not content: they say HOW the authorization is
 *  obtained and how loud it may be, not what the notification is allowed to do. So naming one
 *  does not suppress the default alert/badge/sound - `{ provisional: true }` means "the usual
 *  notification, delivered quietly", which is the only reading an author ever intends. */
export const NOTIFY_MODIFIER_OPTIONS: readonly string[] = ["provisional", "critical"];

function requestedOptions(request: NotifyPermissionRequest): string[] {
  const record = request as Record<string, unknown>;
  const content = NOTIFY_OPTIONS
    .filter((word) => !NOTIFY_MODIFIER_OPTIONS.includes(word))
    .filter((word) => record[word] === true);
  const modifiers = NOTIFY_MODIFIER_OPTIONS.filter((word) => record[word] === true);
  // A request that names no CONTENT option asks for the sensible default. A request that names
  // only options this platform cannot honour is NOT defaulted afterwards - it asked for
  // something specific, and the honest answer is an empty set plus the dropped list.
  const base = content.length === 0 ? [...NOTIFY_DEFAULT_OPTIONS] : content;
  return [...base, ...modifiers];
}

/**
 * Decide what a `permission(...)` call should do.
 *
 * The whole ladder in one function. `status` never reaches here: reading is a different verb
 * and it must never be able to prompt.
 */
export function notifyPermissionPlan(
  request: NotifyPermissionRequest,
  state: NotifyPermissionState,
  platform: string,
  sdk = 0,
): NotifyPermissionPlan {
  const supported = NOTIFY_PLATFORM_OPTIONS[platform];
  if (supported === undefined) {
    return {
      action: "refuse", prompted: false, quiet: false, escalation: false,
      options: [], dropped: [], error: "unsupported_platform",
    };
  }

  const asked = requestedOptions(request);
  const dropped: string[] = [];
  const options: string[] = [];
  for (const word of asked) {
    if (!supported.includes(word)) { dropped.push(word); continue; }
    // The entitlement is not a platform capability, it is a per-app grant, so it is checked
    // separately - and a missing one DROPS the option rather than refusing the whole request,
    // because that is exactly what the platform API does and refusing would be worse.
    if (word === "critical" && state.criticalEntitled !== true) { dropped.push(word); continue; }
    options.push(word);
  }
  options.sort();
  dropped.sort();

  const wantsProvisional = options.includes("provisional");
  const settle = (status: string): NotifyPermissionPlan => ({
    action: "settle", status, prompted: false, quiet: false, escalation: false, options, dropped,
  });
  const refuse = (error: string): NotifyPermissionPlan => ({
    action: "refuse", prompted: false, quiet: false, escalation: false, options, dropped, error,
  });

  if (platform === "android" && sdk < NOTIFY_ANDROID_RUNTIME_PERMISSION_SDK) {
    // NOTHING TO ASK. A user who switched the app's notifications off in system settings
    // still reads denied, and no in-app dialog can undo that - so it is a refusal pointing at
    // Settings rather than a prompt that will never appear.
    if (state.status === "denied") return refuse("permission_denied");
    return settle("granted");
  }

  switch (state.status) {
    case "granted":
      return settle("granted");
    case "denied":
      return refuse("permission_denied");
    case "provisional":
      // Asking for quiet again while already quiet changes nothing. Asking for FULL is the
      // conversion, and it is the one prompt iOS will still show from here.
      if (wantsProvisional) return settle("provisional");
      return { action: "prompt", prompted: true, quiet: false, escalation: true, options, dropped };
    default:
      if (wantsProvisional) {
        return { action: "authorize", prompted: false, quiet: true, escalation: false, options, dropped };
      }
      return { action: "prompt", prompted: true, quiet: false, escalation: false, options, dropped };
  }
}

/**
 * Fold the OS's answer to a prompt back into the state.
 *
 * A DECLINED ESCALATION IS NOT A LOST GRANT: an app that was delivering quietly and asked for
 * more must still be delivering quietly afterwards. The naive `granted ? granted : denied`
 * throws away a working feature to record the refusal of a different one, and the user never
 * sees another notification.
 */
export function notifyApplyPermission(
  state: NotifyPermissionState,
  plan: { readonly action: string; readonly escalation?: boolean },
  granted: boolean,
): NotifyPermissionState {
  if (plan.action === "authorize") {
    return { status: granted ? "provisional" : "denied", promptShown: state.promptShown, criticalEntitled: state.criticalEntitled };
  }
  if (plan.action === "prompt") {
    if (plan.escalation === true) {
      return { status: granted ? "granted" : "provisional", promptShown: true, criticalEntitled: state.criticalEntitled };
    }
    return { status: granted ? "granted" : "denied", promptShown: true, criticalEntitled: state.criticalEntitled };
  }
  return state;
}

export interface NotifyObserved {
  readonly state: NotifyPermissionState;
  readonly changed: boolean;
  /** True exactly when the status moved. A permission event on every foreground is noise. */
  readonly broadcast: boolean;
}

/**
 * THE SETTINGS-CHANGED-WHILE-BACKGROUNDED TRANSITION.
 *
 * The user turns notifications off (or on) in Settings while the app is not running. A module
 * that trusts its cached status then prompts into a void forever, or tells a settings screen
 * that notifications are on when they are not. The OS reading always wins.
 *
 * `undetermined` from the OS means the app was reinstalled, so the spent-prompt memory resets
 * with it - otherwise the module would believe it had already burned a dialog it now has back.
 */
export function notifyObservePermission(
  state: NotifyPermissionState,
  osStatus: string,
): NotifyObserved {
  const status = NOTIFY_STATUSES.includes(osStatus) ? osStatus : state.status;
  const promptShown = status === "undetermined" ? false : state.promptShown;
  const changed = status !== state.status || promptShown !== state.promptShown;
  return {
    state: { status, promptShown, criticalEntitled: state.criticalEntitled },
    changed,
    broadcast: status !== state.status,
  };
}

// ---------------------------------------------------------------------------------------
// Time zones, as data
// ---------------------------------------------------------------------------------------

export interface NotifyZoneTransition {
  readonly at: number;
  readonly offset: number;
}

/** A zone is a base offset in MINUTES plus the instants at which it changes. Ordered by `at`. */
export interface NotifyZoneRules {
  readonly base: number;
  readonly transitions: readonly NotifyZoneTransition[];
}

export const NOTIFY_UTC: NotifyZoneRules = { base: 0, transitions: [] };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function notifyOffsetAt(zone: NotifyZoneRules, instant: number): number {
  let offset = zone.base;
  for (const transition of zone.transitions) {
    if (instant >= transition.at) offset = transition.offset; else break;
  }
  return offset;
}

/** An instant, expressed as the epoch-ms value that PRINTS as local time when read as UTC. */
export function notifyToWall(zone: NotifyZoneRules, instant: number): number {
  return instant + notifyOffsetAt(zone, instant) * MINUTE_MS;
}

/**
 * A wall-clock value back to an instant.
 *
 * THE TWO CASES DATE MATH DIES ON:
 *   GAP (spring forward) - the wall time does not exist. Answer the first instant that does,
 *     i.e. the transition itself. A daily reminder that silently skips a day once a year is
 *     worse than one that runs half an hour late once a year.
 *   OVERLAP (fall back) - the wall time happens twice. Answer the EARLIER instant, once.
 *     Firing on both is a duplicate; firing on the second is an hour late.
 */
export function notifyFromWall(zone: NotifyZoneRules, wall: number): number | null {
  const offsets = new Set<number>([zone.base]);
  for (const transition of zone.transitions) offsets.add(transition.offset);
  let best: number | null = null;
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    const instant = wall - offset * MINUTE_MS;
    if (notifyOffsetAt(zone, instant) !== offset) continue;
    if (best === null || instant < best) best = instant;
  }
  if (best !== null) return best;
  for (const transition of zone.transitions) {
    const before = notifyOffsetAt(zone, transition.at - 1);
    const after = transition.offset;
    if (after <= before) continue;
    const low = transition.at + before * MINUTE_MS;
    const high = transition.at + after * MINUTE_MS;
    if (wall >= low && wall < high) return transition.at;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Civil date arithmetic (no platform calendar, on any renderer)
// ---------------------------------------------------------------------------------------

export interface NotifyCivil {
  readonly year: number;
  readonly month: number;   // 1-12
  readonly day: number;     // 1-31
  readonly hour: number;
  readonly minute: number;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function notifyDaysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : MONTH_LENGTHS[month - 1]!;
}

/** Days from 1970-01-01 to year-month-day, Howard Hinnant's civil_from_days inverted. */
export function notifyDaysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function notifyCivilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function notifyWeekday(days: number): number {
  return ((days % 7) + 11) % 7;
}

export function notifyWallOf(civil: NotifyCivil): number {
  return notifyDaysFromCivil(civil.year, civil.month, civil.day) * DAY_MS
    + civil.hour * HOUR_MS + civil.minute * MINUTE_MS;
}

export function notifyCivilOf(wall: number): NotifyCivil {
  const days = Math.floor(wall / DAY_MS);
  const rest = wall - days * DAY_MS;
  const { year, month, day } = notifyCivilFromDays(days);
  return { year, month, day, hour: Math.floor(rest / HOUR_MS), minute: Math.floor((rest % HOUR_MS) / MINUTE_MS) };
}

// ---------------------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------------------

/** The cron search is BOUNDED. A bound is what makes `0 12 30 2 *` answer "never" instead of
 *  hanging a scheduler on a date that does not exist. A shade over four years, so the leap-day
 *  case is inside it. */
export const NOTIFY_CRON_SEARCH_DAYS = 1600;

export interface NotifyCronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

function parseCronField(text: string, low: number, high: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (part.length === 0) return null;
    let body = part;
    let step = 1;
    const slash = body.indexOf("/");
    if (slash >= 0) {
      const stepText = body.slice(slash + 1);
      body = body.slice(0, slash);
      if (!/^[0-9]+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step <= 0) return null;
    }
    let from: number;
    let to: number;
    if (body === "*") {
      from = low; to = high;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      if (a === undefined || b === undefined || !/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return null;
      from = Number(a); to = Number(b);
      if (from > to) return null;
    } else {
      if (!/^[0-9]+$/.test(body)) return null;
      from = Number(body); to = from;
    }
    if (from < low || to > high) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

export function notifyParseCron(expression: string): NotifyCronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const daysOfMonth = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const rawDow = parseCronField(fields[4]!, 0, 7);
  if (minutes === null || hours === null || daysOfMonth === null || months === null || rawDow === null) return null;
  // 7 and 0 are both Sunday, everywhere cron is spoken.
  const daysOfWeek = [...new Set(rawDow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    minutes, hours, daysOfMonth, months, daysOfWeek,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function cronDayMatches(spec: NotifyCronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false;
  const dow = notifyWeekday(notifyDaysFromCivil(year, month, day));
  // Cron's classic OR: when BOTH day fields are restricted, either one matching is a match.
  if (spec.domRestricted && spec.dowRestricted) {
    return spec.daysOfMonth.includes(day) || spec.daysOfWeek.includes(dow);
  }
  if (spec.domRestricted) return spec.daysOfMonth.includes(day);
  if (spec.dowRestricted) return spec.daysOfWeek.includes(dow);
  return true;
}

// ---------------------------------------------------------------------------------------
// The trigger resolver
// ---------------------------------------------------------------------------------------

export const NOTIFY_REPEAT_UNITS: readonly string[] = ["hourly", "daily", "weekly", "monthly", "yearly"];

export interface NotifyTrigger {
  readonly at?: string | number;
  readonly in?: number;
  readonly cron?: string;
  readonly repeats?: string;
}

export type NotifyFirePlan =
  | { readonly ok: true; readonly kind: "once" | "repeating"; readonly fires: readonly number[]; readonly exhausted: boolean }
  | { readonly ok: false; readonly error: "invalid_trigger" };

/** Only the shape the module accepts on the wire: an epoch-ms number, or an ISO-8601 instant
 *  with an explicit zone. A bare "2026-06-01 12:00" is refused rather than guessed at, because
 *  the guess is exactly the bug this whole file exists to prevent. */
export function notifyParseInstant(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?(Z|z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, ms, zone] = match;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  const hour = Number(h); const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const milli = ms === undefined ? 0 : Number(ms.padEnd(3, "0"));
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > notifyDaysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone!.startsWith("-") ? -1 : 1;
    const digits = zone!.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return notifyDaysFromCivil(year, month, day) * DAY_MS
    + hour * HOUR_MS + minute * MINUTE_MS + second * 1000 + milli
    - offsetMinutes * MINUTE_MS;
}

function addMonths(year: number, month: number, count: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * Resolve a trigger to its next `count` fire instants.
 *
 * WALL CLOCK VERSUS INTERVAL, the distinction the corpus exists to pin: `hourly` is an
 * INTERVAL - exactly 3600000 ms apart, straight through a DST transition. Every other unit is
 * WALL CLOCK - a 09:00 daily reminder is still 09:00 the day the clocks move, so the gap
 * between those two fires is 23 or 25 hours. Both are correct; they are different.
 */
export function notifyFireTimes(
  trigger: NotifyTrigger,
  from: number,
  zone: NotifyZoneRules | null | undefined,
  count: number,
): NotifyFirePlan {
  const rules = zone ?? NOTIFY_UTC;
  const want = Math.max(0, Math.trunc(count));
  const invalid: NotifyFirePlan = { ok: false, error: "invalid_trigger" };

  const hasAt = trigger.at !== undefined && trigger.at !== null;
  const hasIn = trigger.in !== undefined && trigger.in !== null;
  const hasCron = typeof trigger.cron === "string" && trigger.cron.trim() !== "";
  const hasRepeats = typeof trigger.repeats === "string" && trigger.repeats.trim() !== "";

  const anchors = (hasAt ? 1 : 0) + (hasIn ? 1 : 0) + (hasCron ? 1 : 0);
  if (anchors !== 1) return invalid;
  if (hasCron && hasRepeats) return invalid;   // a cron already repeats
  if (hasRepeats && !NOTIFY_REPEAT_UNITS.includes(trigger.repeats!.trim())) return invalid;

  if (hasCron) {
    const spec = notifyParseCron(trigger.cron!);
    if (spec === null) return invalid;
    return cronFires(spec, from, rules, want);
  }

  let anchor: number | null;
  if (hasAt) {
    anchor = notifyParseInstant(trigger.at as string | number);
  } else {
    const seconds = trigger.in;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return invalid;
    anchor = from + Math.round(seconds * 1000);
  }
  if (anchor === null) return invalid;

  if (!hasRepeats) {
    // An `at` already in the past resolves to NOTHING rather than firing immediately. A
    // scheduler that fires a stale reminder the moment the app opens is how a user gets
    // yesterday's alarm at breakfast.
    return { ok: true, kind: "once", fires: anchor > from ? [anchor] : [], exhausted: false };
  }
  return repeatFires(anchor, trigger.repeats!.trim(), from, rules, want);
}

function cronFires(spec: NotifyCronSpec, from: number, zone: NotifyZoneRules, count: number): NotifyFirePlan {
  const fires: number[] = [];
  if (count === 0) return { ok: true, kind: "repeating", fires, exhausted: false };
  const startWall = notifyToWall(zone, from);
  const startDay = Math.floor(startWall / DAY_MS);
  for (let offset = 0; offset < NOTIFY_CRON_SEARCH_DAYS; offset += 1) {
    const { year, month, day } = notifyCivilFromDays(startDay + offset);
    if (!cronDayMatches(spec, year, month, day)) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const wall = notifyWallOf({ year, month, day, hour, minute });
        if (wall <= startWall) continue;
        const instant = notifyFromWall(zone, wall);
        if (instant === null || instant <= from) continue;
        // The gap rule can map two distinct wall times onto the same instant (02:00 and 02:30
        // both become 03:00 on the spring-forward day). One fire, not two.
        if (fires.length > 0 && instant <= fires[fires.length - 1]!) continue;
        fires.push(instant);
        if (fires.length >= count) return { ok: true, kind: "repeating", fires, exhausted: false };
      }
    }
  }
  return { ok: true, kind: "repeating", fires, exhausted: true };
}

function repeatFires(anchor: number, unit: string, from: number, zone: NotifyZoneRules, count: number): NotifyFirePlan {
  const fires: number[] = [];
  if (count === 0) return { ok: true, kind: "repeating", fires, exhausted: false };

  if (unit === "hourly") {
    let instant = anchor;
    // Skip forward in whole hours rather than looping one at a time from a distant anchor.
    if (instant <= from) {
      const steps = Math.floor((from - instant) / HOUR_MS) + 1;
      instant += steps * HOUR_MS;
    }
    while (fires.length < count) { fires.push(instant); instant += HOUR_MS; }
    return { ok: true, kind: "repeating", fires, exhausted: false };
  }

  const base = notifyCivilOf(notifyToWall(zone, anchor));
  const baseDays = notifyDaysFromCivil(base.year, base.month, base.day);
  let step = 0;
  let guard = 0;
  const guardLimit = unit === "yearly" ? 4000 : unit === "monthly" ? 4000 : NOTIFY_CRON_SEARCH_DAYS * 2;
  while (fires.length < count && guard < guardLimit) {
    guard += 1;
    let year = base.year; let month = base.month; let day = base.day;
    if (unit === "daily" || unit === "weekly") {
      const days = baseDays + step * (unit === "weekly" ? 7 : 1);
      ({ year, month, day } = notifyCivilFromDays(days));
    } else if (unit === "monthly") {
      ({ year, month } = addMonths(base.year, base.month, step));
      day = base.day;
      // SKIP, never clamp: "the 31st" means the 31st. Clamping to the 30th silently invents a
      // fire the author never asked for, and it is indistinguishable from a bug in February.
      if (day > notifyDaysInMonth(year, month)) { step += 1; continue; }
    } else {
      year = base.year + step;
      day = base.day;
      if (day > notifyDaysInMonth(year, month)) { step += 1; continue; }   // 29 February
    }
    step += 1;
    const instant = notifyFromWall(zone, notifyWallOf({ year, month, day, hour: base.hour, minute: base.minute }));
    if (instant === null || instant <= from) continue;
    if (fires.length > 0 && instant <= fires[fires.length - 1]!) continue;
    fires.push(instant);
  }
  return { ok: true, kind: "repeating", fires, exhausted: fires.length < count };
}

// ---------------------------------------------------------------------------------------
// Android channels
// ---------------------------------------------------------------------------------------

export interface NotifyImportance {
  readonly word: string;
  readonly android: number;
  readonly ios: string;
  readonly headsUp: boolean;
  readonly sound: boolean;
}

/** Six words, exact case. `android` is the real NotificationManager constant; `ios` is the
 *  UNNotificationInterruptionLevel the same intent maps to. `critical` is deliberately absent
 *  from the iOS column: it needs an Apple entitlement, and a channel word must never be the
 *  thing that silently asks for one. */
export const NOTIFY_IMPORTANCE: readonly NotifyImportance[] = [
  { word: "none", android: 0, ios: "passive", headsUp: false, sound: false },
  { word: "min", android: 1, ios: "passive", headsUp: false, sound: false },
  { word: "low", android: 2, ios: "passive", headsUp: false, sound: false },
  { word: "default", android: 3, ios: "active", headsUp: false, sound: true },
  { word: "high", android: 4, ios: "timeSensitive", headsUp: true, sound: true },
  { word: "max", android: 5, ios: "timeSensitive", headsUp: true, sound: true },
];

export const NOTIFY_DEFAULT_IMPORTANCE = "default";

/** Channels arrived in Android 8. Below it a channel id is meaningless, not an error. */
export const NOTIFY_ANDROID_CHANNEL_SDK = 26;

export type NotifyImportanceResolution =
  | { readonly ok: true; readonly value: NotifyImportance }
  | { readonly ok: false; readonly error: "invalid_argument" };

export function notifyImportance(word: string | null | undefined): NotifyImportanceResolution {
  const wanted = (word ?? "").trim() === "" ? NOTIFY_DEFAULT_IMPORTANCE : (word ?? "").trim();
  const found = NOTIFY_IMPORTANCE.find((entry) => entry.word === wanted);
  return found === undefined ? { ok: false, error: "invalid_argument" } : { ok: true, value: found };
}

export interface NotifyChannelState {
  readonly importance: string;
  /** The user changed this channel's importance themselves. Android then ignores the app. */
  readonly userSet?: boolean;
  readonly blocked?: boolean;
}

export type NotifyChannelFold =
  | {
      readonly ok: true;
      readonly importance: string;
      readonly created: boolean;
      readonly changed: boolean;
      readonly lockedByUser: boolean;
      readonly blocked: boolean;
    }
  | { readonly ok: false; readonly error: "invalid_argument" };

/**
 * What a `channels.set` will ACTUALLY produce.
 *
 * THE RULE EVERY LIBRARY GETS WRONG: once a channel exists, Android lets the app LOWER its
 * importance and silently ignores every attempt to raise it, and it remembers a user's own
 * choice forever - deleting and recreating the id does not reset it. So this is not an update,
 * it is a negotiation, and the answer says what the channel will be rather than what was asked
 * for. `lockedByUser` is what a settings screen needs in order to say "you turned this down"
 * instead of rendering a control that does nothing.
 */
export function notifyChannelFold(
  existing: NotifyChannelState | null | undefined,
  requested: string | null | undefined,
): NotifyChannelFold {
  const resolved = notifyImportance(requested);
  if (resolved.ok !== true) return { ok: false, error: "invalid_argument" };
  const wanted = resolved.value;
  if (existing === null || existing === undefined) {
    return { ok: true, importance: wanted.word, created: true, changed: true, lockedByUser: false, blocked: false };
  }
  const current = notifyImportance(existing.importance);
  const held = current.ok === true ? current.value : NOTIFY_IMPORTANCE[3]!;
  const lockedByUser = existing.userSet === true;
  const blocked = existing.blocked === true;
  if (lockedByUser || wanted.android >= held.android) {
    return { ok: true, importance: held.word, created: false, changed: false, lockedByUser, blocked };
  }
  return { ok: true, importance: wanted.word, created: false, changed: true, lockedByUser, blocked };
}

export type NotifyChannelRequirement =
  | { readonly ok: true; readonly channel: string | null }
  | { readonly ok: false; readonly error: "channel_required"; readonly channel: string };

/** The module's own channel, created at first use so that an app which never thinks about
 *  channels still works. */
export const NOTIFY_DEFAULT_CHANNEL = "default";

/**
 * Can this notification be posted.
 *
 * On Android 8+ a post to a channel that was never created is DROPPED BY THE OS - no
 * exception, no log line, no callback. That is the number-one cause of "push does not
 * arrive". Refuse first, and NAME THE ID.
 */
export function notifyChannelRequired(
  platform: string,
  sdk: number,
  channel: string | null | undefined,
  known: readonly string[],
): NotifyChannelRequirement {
  if (platform !== "android" || sdk < NOTIFY_ANDROID_CHANNEL_SDK) return { ok: true, channel: null };
  const id = (channel ?? "").trim();
  if (id === "") return { ok: true, channel: NOTIFY_DEFAULT_CHANNEL };
  if (known.includes(id)) return { ok: true, channel: id };
  return { ok: false, error: "channel_required", channel: id };
}

// ---------------------------------------------------------------------------------------
// Foreground presentation
// ---------------------------------------------------------------------------------------

/** The four words, canonical order - which is the order they are reported in, never sorted. */
export const NOTIFY_PRESENTATION_WORDS: readonly string[] = ["alert", "sound", "badge", "list"];

/** `banner` is what the platforms call it in their own settings UI. */
export const NOTIFY_PRESENTATION_ALIASES: { readonly [word: string]: string } = { banner: "alert" };

export type NotifyPresentation =
  | {
      readonly ok: true;
      readonly present: readonly string[];
      readonly suppressed: boolean;
      readonly headsUp: boolean;
      readonly dropped: readonly string[];
      readonly degraded: readonly string[];
    }
  | { readonly ok: false; readonly error: "invalid_argument" };

/**
 * What a notification does while the app is open.
 *
 * THE DEFAULT IS NOTHING, on every platform, and it surprises every author. iOS makes it a
 * delegate callback nobody implements; Android makes it a channel-importance question; the
 * browser shows the notification but the page usually never hears about it. One word decides
 * it everywhere.
 */
export function notifyPresentation(
  configured: readonly string[] | null | undefined,
  claimed: boolean,
  platform: string,
  importance?: string | null,
): NotifyPresentation {
  const words: string[] = [];
  for (const raw of configured ?? []) {
    const word = NOTIFY_PRESENTATION_ALIASES[raw] ?? raw;
    if (!NOTIFY_PRESENTATION_WORDS.includes(word)) return { ok: false, error: "invalid_argument" };
    if (!words.includes(word)) words.push(word);
  }

  // A CLAIMED notify.received suppresses the system presentation, whatever was configured -
  // that is the entire point of a claimable hook.
  if (claimed) {
    return { ok: true, present: [], suppressed: true, headsUp: false, dropped: [], degraded: [] };
  }

  if (platform === "android") {
    // The OS posts it regardless: `list` is implicit and cannot be configured away. A heads-up
    // needs BOTH the alert word and a high-importance channel, and the channel wins.
    const present = NOTIFY_PRESENTATION_WORDS.filter((w) => words.includes(w) || w === "list");
    const resolved = notifyImportance(importance);
    const level = resolved.ok === true ? resolved.value : NOTIFY_IMPORTANCE[3]!;
    const headsUp = words.includes("alert") && level.headsUp;
    const degraded = words.includes("alert") && !level.headsUp ? ["alert"] : [];
    return { ok: true, present, suppressed: false, headsUp, dropped: [], degraded };
  }

  if (platform === "web") {
    // There is no notification list to land in. Say so rather than accepting the word.
    const dropped = words.includes("list") ? ["list"] : [];
    const present = NOTIFY_PRESENTATION_WORDS.filter((w) => words.includes(w) && w !== "list");
    return { ok: true, present, suppressed: false, headsUp: present.includes("alert"), dropped, degraded: [] };
  }

  const present = NOTIFY_PRESENTATION_WORDS.filter((w) => words.includes(w));
  return { ok: true, present, suppressed: false, headsUp: present.includes("alert"), dropped: [], degraded: [] };
}

// ---------------------------------------------------------------------------------------
// Tap routing
// ---------------------------------------------------------------------------------------

/** The platform constants for "the user tapped the notification body". Normalised AWAY, so
 *  that `if (payload.actionId)` means what it reads like. */
export const NOTIFY_DEFAULT_ACTION_IDS: readonly string[] = [
  "com.apple.UNNotificationDefaultActionIdentifier", "android.intent.action.MAIN", "default",
];

export const NOTIFY_DISMISS_ACTION_IDS: readonly string[] = [
  "com.apple.UNNotificationDismissActionIdentifier",
];

export interface NotifyRawOpen {
  readonly id?: string;
  readonly actionId?: string;
  readonly userText?: string;
  readonly data?: Record<string, unknown>;
}

export interface NotifyOpenPayload {
  readonly kind: "opened" | "dismissed";
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly coldStart: boolean;
  readonly actionId?: string;
  readonly userText?: string;
}

/** One tap arrives in four envelope shapes - plain, action button, text-input action, and a
 *  COLD START where the app was not running. All four end up here, or an app routes three of
 *  them and loses the fourth. */
export function notifyOpenPayload(raw: NotifyRawOpen, coldStart: boolean): NotifyOpenPayload {
  const id = typeof raw.id === "string" ? raw.id : "";
  const actionId = typeof raw.actionId === "string" ? raw.actionId : "";
  if (NOTIFY_DISMISS_ACTION_IDS.includes(actionId)) {
    return { kind: "dismissed", id, data: {}, coldStart };
  }
  const payload: NotifyOpenPayload = {
    kind: "opened", id,
    data: (raw.data ?? {}) as Record<string, unknown>,
    coldStart,
  };
  const named = actionId !== "" && !NOTIFY_DEFAULT_ACTION_IDS.includes(actionId);
  // An EMPTY reply is still a reply, so `userText` rides whenever the platform gave us one.
  if (named && typeof raw.userText === "string") {
    return { ...payload, actionId, userText: raw.userText };
  }
  if (named) return { ...payload, actionId };
  return payload;
}

export const NOTIFY_PATH_BYTES = 8192;
export const NOTIFY_URL_BYTES = 8192;
export const NOTIFY_EVENT_BYTES = 65536;

function utf8Length(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) { total += 4; i += 1; }
    else if (code > 0x7ff) total += 3;
    else if (code > 0x7f) total += 2;
    else total += 1;
  }
  return total;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface NotifyRoutingRecord {
  readonly path: string | null;
  readonly url: string | null;
}

/**
 * The record `Mandatory/PushRouting` already consumes for a VENDOR open, produced for a
 * first-party one.
 *
 * The bounds are restated rather than skipped: a first-party payload must not be the one that
 * gets to bypass the checks a Firebase payload goes through. A field that fails a bound is
 * dropped; the OPEN still happens, because losing the whole event over a bad deep link is a
 * worse failure than losing the deep link.
 */
export function notifyRoutingRecord(payload: { readonly data?: Record<string, unknown> }): NotifyRoutingRecord {
  const data = payload.data ?? {};
  const rawPath = typeof data["path"] === "string" ? (data["path"] as string) : "";
  const rawURL = typeof data["url"] === "string" ? (data["url"] as string) : "";

  let path: string | null = null;
  if (rawPath.startsWith("/") && !rawPath.startsWith("//")
      && !hasControlCharacter(rawPath) && utf8Length(rawPath) <= NOTIFY_PATH_BYTES) {
    path = rawPath;
  }

  let url: string | null = null;
  const lower = rawURL.toLowerCase();
  if ((lower.startsWith("http://") || lower.startsWith("https://"))
      && !hasControlCharacter(rawURL) && utf8Length(rawURL) <= NOTIFY_URL_BYTES) {
    const authority = rawURL.slice(rawURL.indexOf("://") + 3).split("/")[0] ?? "";
    // Credentials in a notification URL are how a phishing payload borrows an app's trust.
    if (!authority.includes("@")) url = rawURL;
  }

  return { path, url };
}
