//
//  background.ts - the shared Core/Background pure core: the declaration fold, the
//  constraint translation, the budget countdown, the run-record fold and the release gate
//  on `run`. The law is the corpus, OpenSource/Conformance/background/*.json
//  (parity/F08-background.md); the Kotlin twin is :core BackgroundPlan.kt and the Swift twin
//  is Engine/iOS/BackgroundPlan.swift.
//
//  Everything platform-shaped lives OUTSIDE this file. The Background module submits
//  BGTaskScheduler requests (iOS), enqueues WorkManager work (Android) or registers a service
//  worker sync (web); this file only decides what a declared row MEANS, whether a run may
//  start, how much wall clock is left, and what the last run actually did. Keeping the
//  DECISION separate from the PLUMBING is what lets one corpus judge three renderers.
//
//  HONESTY IS THE FEATURE. iOS BGTaskScheduler gives NO timing guarantee: the OS learns
//  usage patterns and a task may run in twenty minutes or in two days. Android WorkManager
//  will not run a periodic worker more often than every 15 minutes, Doze stretches that
//  further, and OEM battery managers kill background work outright. None of that is
//  something a framework can fix, so this core refuses to paper over it: `minInterval` is a
//  floor that gets clamped and REPORTED, and every run leaves a record.
//

/** The declared kinds. `periodic` repeats no faster than the floor, `deferred` runs once when
 *  its constraints are met, `appRefresh` is the short pre-launch warm (iOS BGAppRefreshTask). */
export const BACKGROUND_KINDS: readonly string[] = ["periodic", "deferred", "appRefresh"];

/** The declared requirement vocabulary, in the canonical order every fold emits. */
export const BACKGROUND_REQUIREMENTS: readonly string[] = [
  "network", "unmeteredNetwork", "charging", "batteryNotLow", "storageNotLow", "idle",
];

/** Android WorkManager will not schedule a periodic worker more often than this, and iOS
 *  treats an earliest-begin-date as a hint. A shorter declaration is clamped, not refused. */
export const BACKGROUND_PERIODIC_FLOOR_SECONDS = 900;

/** The FIXED iOS scheduler buckets. Every BGTaskScheduler identifier must appear in
 *  Info.plist BGTaskSchedulerPermittedIdentifiers before didFinishLaunching returns; a list
 *  generated per app from the task table is a list that goes stale silently, so the module
 *  ships these five constants instead and routes each task into its bucket. */
export const BACKGROUND_BUCKETS: readonly string[] = [
  "refresh", "processing", "processing.net", "processing.power", "processing.net.power",
];

/** The wall-clock budget one run gets, per platform. The platform's numbers, not ours, and
 *  neither is a guarantee: the OS may expire a run sooner, which is the same typed outcome. */
export const BACKGROUND_BUDGET_MS: { readonly [platform: string]: number } = {
  ios: 30_000,
  android: 600_000,
  web: 30_000,
};

/** A resolved task row: what the manifest declaration actually means. */
export interface BackgroundTask {
  readonly id: string;
  readonly action: string;
  readonly kind: string;
  /** 0 for every non-periodic kind: only `periodic` carries a schedule. */
  readonly minIntervalSeconds: number;
  /** True when a declared interval below the floor was raised to it. Reported, never hidden. */
  readonly clamped: boolean;
  readonly requires: readonly string[];
  readonly expedited: boolean;
  readonly bucket: string;
}

/** Why a declaration was refused. Every one of these fails the BUILD (the manifest fan-in
 *  types `action` as an ownAction, so a stale target aborts prepare) rather than the device. */
export type BackgroundRefusal =
  | "invalid_task_id" | "unknown_task_action" | "unknown_kind"
  | "unknown_requirement" | "invalid_interval";

export type BackgroundResolution =
  | { readonly ok: true; readonly value: BackgroundTask }
  | { readonly ok: false; readonly error: BackgroundRefusal };

/** The raw manifest row, as the facet fan-in hands it over: every field a string, because a
 *  facet declaration schema types its fields as strings and maps. */
export interface BackgroundRow {
  readonly action?: string;
  readonly kind?: string;
  readonly minInterval?: string;
  readonly requires?: string;
  readonly expedited?: string;
}

function splitRequires(raw: string | undefined): string[] | null {
  const words = (raw ?? "").split(",").map((w) => w.trim()).filter((w) => w.length > 0);
  for (const word of words) if (!BACKGROUND_REQUIREMENTS.includes(word)) return null;
  return BACKGROUND_REQUIREMENTS.filter((word) => words.includes(word));
}

/** The iOS bucket a row folds into: app refresh is its own short lane, everything else is a
 *  processing lane suffixed by whether it needs a network and whether it needs power. */
export function backgroundBucket(kind: string, requires: readonly string[]): string {
  if (kind === "appRefresh") return "refresh";
  const network = requires.includes("network") || requires.includes("unmeteredNetwork");
  const power = requires.includes("charging");
  return `processing${network ? ".net" : ""}${power ? ".power" : ""}`;
}

/**
 * Fold one declared manifest row into a resolved task.
 *
 * `declaredActions` is the declaring module's own action list: a row naming anything else is
 * `unknown_task_action`, which is the stale-target class the facet fan-in aborts on at
 * prepare time. Vocabulary is exact case, because a case-insensitive vocabulary is one
 * nobody can lint.
 */
export function resolveBackgroundTask(
  id: string | null | undefined,
  row: BackgroundRow | null | undefined,
  declaredActions: readonly string[],
): BackgroundResolution {
  const taskId = (id ?? "").trim();
  if (taskId === "") return { ok: false, error: "invalid_task_id" };
  const spec = row ?? {};

  const action = (spec.action ?? "").trim();
  if (action === "" || !declaredActions.includes(action)) {
    return { ok: false, error: "unknown_task_action" };
  }

  const kind = (spec.kind ?? "").trim();
  if (!BACKGROUND_KINDS.includes(kind)) return { ok: false, error: "unknown_kind" };

  const requires = splitRequires(spec.requires);
  if (requires === null) return { ok: false, error: "unknown_requirement" };

  let minIntervalSeconds = 0;
  let clamped = false;
  if (kind === "periodic") {
    const raw = (spec.minInterval ?? "").trim();
    if (raw !== "") {
      if (!/^\d+$/.test(raw)) return { ok: false, error: "invalid_interval" };
      minIntervalSeconds = Number.parseInt(raw, 10);
    }
    if (minIntervalSeconds < BACKGROUND_PERIODIC_FLOOR_SECONDS) {
      clamped = minIntervalSeconds > 0;
      minIntervalSeconds = BACKGROUND_PERIODIC_FLOOR_SECONDS;
    }
  } else if ((spec.minInterval ?? "").trim() !== "" && !/^\d+$/.test((spec.minInterval ?? "").trim())) {
    return { ok: false, error: "invalid_interval" };
  }

  return {
    ok: true,
    value: {
      id: taskId,
      action,
      kind,
      minIntervalSeconds,
      clamped,
      requires,
      expedited: (spec.expedited ?? "").trim() === "true",
      bucket: backgroundBucket(kind, requires),
    },
  };
}

/** The platform constraint objects a requirement set folds into. Three of the six words have
 *  no iOS twin, and the empty map records that honestly rather than pretending. */
export interface BackgroundConstraints {
  readonly ios: { readonly [key: string]: string };
  readonly android: { readonly [key: string]: string };
}

export function backgroundConstraints(requires: readonly string[]): BackgroundConstraints {
  const ios: { [key: string]: string } = {};
  const android: { [key: string]: string } = {};
  const has = (word: string) => requires.includes(word);

  if (has("network") || has("unmeteredNetwork")) ios["requiresNetworkConnectivity"] = "true";
  if (has("unmeteredNetwork")) android["networkType"] = "UNMETERED";
  else if (has("network")) android["networkType"] = "CONNECTED";
  if (has("charging")) {
    ios["requiresExternalPower"] = "true";
    android["requiresCharging"] = "true";
  }
  if (has("batteryNotLow")) android["requiresBatteryNotLow"] = "true";
  if (has("storageNotLow")) android["requiresStorageNotLow"] = "true";
  if (has("idle")) android["requiresDeviceIdle"] = "true";
  return { ios, android };
}

/** The live device facts a constraint set is folded against. */
export interface BackgroundDeviceState {
  /** "none" | "metered" | "unmetered". */
  readonly network?: string;
  readonly charging?: boolean;
  readonly batteryLow?: boolean;
  readonly storageLow?: boolean;
  readonly idle?: boolean;
}

/** Which declared requirements the device does NOT currently meet, in canonical order. An
 *  unmet task is not a failed task: it stays scheduled, and `status` names what is missing so
 *  an author sees why nothing has happened instead of guessing. */
export function backgroundUnmet(
  requires: readonly string[],
  state: BackgroundDeviceState,
): string[] {
  const network = state.network ?? "none";
  const unmet: string[] = [];
  for (const word of BACKGROUND_REQUIREMENTS) {
    if (!requires.includes(word)) continue;
    switch (word) {
      case "network": if (network === "none") unmet.push(word); break;
      case "unmeteredNetwork": if (network !== "unmetered") unmet.push(word); break;
      case "charging": if (state.charging !== true) unmet.push(word); break;
      case "batteryNotLow": if (state.batteryLow === true) unmet.push(word); break;
      case "storageNotLow": if (state.storageLow === true) unmet.push(word); break;
      case "idle": if (state.idle !== true) unmet.push(word); break;
      default: break;
    }
  }
  return unmet;
}

/** The wall clock left in this run, and whether the budget is spent. An action reads the
 *  first as dsx.module.background.context.remaining while it runs. */
export interface BackgroundBudget {
  readonly remainingMs: number;
  readonly expired: boolean;
}

export function backgroundBudget(platform: string, elapsedMs: number): BackgroundBudget {
  const total = BACKGROUND_BUDGET_MS[platform] ?? BACKGROUND_BUDGET_MS["ios"]!;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const remaining = total - elapsed;
  return { remainingMs: remaining > 0 ? remaining : 0, expired: remaining <= 0 };
}

/** One lifecycle fact about a run. `relaunch` is the process starting again, which is how a
 *  run killed mid-flight is discovered. */
export type BackgroundRunEvent = "start" | "finish" | "fail" | "expire" | "relaunch";

/** What the last run actually did. `killed` is the outcome every other scheduler loses. */
export type BackgroundRunResult =
  | "never" | "running" | "success" | "failed" | "budget_exceeded" | "killed";

export interface BackgroundRunRecord {
  readonly result: BackgroundRunResult;
  readonly failure: boolean;
  readonly running: boolean;
}

/**
 * Fold a run's lifecycle facts into one honest record.
 *
 * The case that matters is `relaunch` while a run is in flight: the OS killed the process
 * mid-run, and without this the task would sit in `status` looking like it had been running
 * for three days. It is recorded as `killed` at the next launch, which is a failure.
 */
export function backgroundRunRecord(events: readonly BackgroundRunEvent[]): BackgroundRunRecord {
  let result: BackgroundRunResult = "never";
  let running = false;
  for (const event of events) {
    switch (event) {
      case "start": running = true; result = "running"; break;
      case "finish": if (running) { running = false; result = "success"; } break;
      case "fail": if (running) { running = false; result = "failed"; } break;
      case "expire": if (running) { running = false; result = "budget_exceeded"; } break;
      case "relaunch": if (running) { running = false; result = "killed"; } break;
      default: break;
    }
  }
  const failure = result === "failed" || result === "budget_exceeded" || result === "killed";
  return { result, failure, running };
}

/** The `run` action is DEBUG ONLY. A scheduler you can fake in production is a scheduler
 *  nobody trusts, and "just to be sure" is exactly how an app ships with background work the
 *  OS has never once exercised. Fails closed: an unclassifiable channel is production. */
export function backgroundRunAllowed(channel: string | null | undefined): boolean {
  const word = (channel ?? "").trim();
  return word === "simulator" || word === "debug" || word === "testflight" || word === "adhoc";
}
