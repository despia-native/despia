//
//  geo.ts - the shared Core/Geo pure core: the two-step permission ladder, the escalation
//  route, the precise-location decision, the region-limit accounting, the accuracy vocabulary
//  and the battery filter. The law is the corpus, OpenSource/Conformance/geo/*.json
//  (parity/F09-geo.md); the Kotlin twin is :core GeoPolicy.kt and the Swift twin is
//  Engine/iOS/GeoPolicy.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: CLLocationManager,
//  FusedLocationProviderClient and navigator.geolocation all ask this module WHAT to do and
//  then do it. Keeping the DECISION separate from the PLUMBING is what lets one corpus judge
//  three renderers - and it is what makes "the ladder is enforced, not documented" a testable
//  claim rather than a paragraph in a README.
//
//  THE TWO RULES THIS FILE EXISTS FOR:
//
//  1. ASK FOR whenInUse FIRST. A cold `always` request is denied by most users and flagged in
//     App Store and Play review, and on Android 11+ the system will not even show the dialog.
//     So `always` without a granted `whenInUse` refuses with escalation_required and never
//     reaches a prompt. The module makes the correct sequence the only sequence.
//
//  2. THE REGION CAP IS A TYPED ERROR. iOS monitors twenty regions per app, Android starts
//     dropping above a hundred, and every library silently loses the overflow. Here the
//     twenty-first region refuses with region_limit and names the limit and the count.
//

// ---------------------------------------------------------------------------------------
// The permission ladder
// ---------------------------------------------------------------------------------------

/** The authorization statuses, as the module reports them (never a platform enum). */
export const GEO_STATUSES: readonly string[] = [
  "notDetermined", "denied", "restricted", "whenInUse", "always",
];

/** The two levels an app may ask for. There is no third. */
export const GEO_LEVELS: readonly string[] = ["whenInUse", "always"];

/** What the module knows about this app's grant right now. */
export interface GeoPermissionState {
  readonly status: string;
  /** True once the OS has shown the Always prompt. It shows it ONCE; after that a repeat
   *  request displays nothing, so the honest move is a Settings deep link. */
  readonly escalationOffered: boolean;
  readonly precise?: boolean;
}

/** What to do about a permission request: prompt, settle with what we already hold, or refuse. */
export type GeoPermissionPlan =
  | { readonly action: "prompt"; readonly prompt: string }
  | { readonly action: "settle"; readonly status: string; readonly prompted: false }
  | { readonly action: "refuse"; readonly error: string };

/**
 * Decide what a `permission({ level })` call should do.
 *
 * The ladder in one function: `whenInUse` prompts once and then settles; `always` is legal
 * ONLY on top of a granted `whenInUse`, and only once, because that is the only shape either
 * platform actually supports.
 */
export function geoPermissionPlan(
  level: string | null | undefined,
  state: GeoPermissionState,
): GeoPermissionPlan {
  const want = (level ?? "").trim();
  if (!GEO_LEVELS.includes(want)) return { action: "refuse", error: "invalid_argument" };
  const status = state.status;

  if (status === "restricted") return { action: "refuse", error: "permission_denied" };

  if (want === "whenInUse") {
    if (status === "whenInUse" || status === "always") {
      return { action: "settle", status, prompted: false };
    }
    if (status === "denied") return { action: "refuse", error: "permission_denied" };
    return { action: "prompt", prompt: "whenInUse" };
  }

  // want === "always"
  if (status === "always") return { action: "settle", status, prompted: false };
  if (status !== "whenInUse") return { action: "refuse", error: "escalation_required" };
  if (state.escalationOffered) return { action: "settle", status: "whenInUse", prompted: false };
  return { action: "prompt", prompt: "always" };
}

/**
 * Fold the OS's answer to a prompt back into the state.
 *
 * A DECLINED ESCALATION IS NOT A LOST GRANT: the app still holds `whenInUse`, and the one
 * available offer has been spent. Throwing the foreground grant away here (which is what a
 * naive `granted ? always : denied` does) would break the app's working feature to record a
 * refusal of a different one.
 */
export function geoApplyPermission(
  state: GeoPermissionState,
  prompted: string,
  granted: boolean,
): GeoPermissionState {
  if (prompted === "always") {
    return {
      status: granted ? "always" : state.status,
      escalationOffered: true,
      precise: state.precise,
    };
  }
  return {
    status: granted ? "whenInUse" : "denied",
    escalationOffered: state.escalationOffered,
    precise: state.precise,
  };
}

/**
 * How the `always` escalation is actually obtained on this platform.
 *
 * THE ANDROID BACKGROUND SPLIT: `always` is ACCESS_BACKGROUND_LOCATION, and from Android 11
 * (API 30) the system refuses to show it in a request dialog at all - the only path is the app
 * settings screen. An app that calls requestPermissions and waits for a callback waits forever.
 */
export function geoEscalationRoute(platform: string, sdk: number): string {
  if (platform === "ios") return "prompt";
  if (platform === "android") return sdk >= 30 ? "settings" : "prompt";
  return "unsupported";
}

/** Whether a reduced-accuracy grant satisfies what the caller asked for. */
export type GeoPreciseOutcome =
  | { readonly ok: true; readonly precise: boolean }
  | { readonly ok: false; readonly error: "precise_denied" };

/** iOS 14 and Android 12 both let a user grant APPROXIMATE location. An app that needs
 *  precision must be told, rather than left to wonder why every fix is three kilometres wide. */
export function geoPreciseOutcome(requested: boolean, granted: boolean): GeoPreciseOutcome {
  if (requested && !granted) return { ok: false, error: "precise_denied" };
  return { ok: true, precise: granted };
}

// ---------------------------------------------------------------------------------------
// Region monitoring
// ---------------------------------------------------------------------------------------

/** The per-platform region caps. iOS 20 is a hard OS limit; Android starts dropping above 100. */
export const GEO_REGION_CAPS: { readonly [platform: string]: number } = {
  ios: 20, android: 100, web: 0,
};

/** The radius bounds a monitored region is held to. Below the floor a region fires
 *  unreliably or not at all; above the ceiling the platforms stop honouring it. */
export const GEO_RADIUS_FLOOR_METERS = 100;
export const GEO_RADIUS_CEILING_METERS = 100_000;

export interface GeoRadius {
  readonly radius: number;
  readonly clamped: boolean;
}

/** Correct a radius the platform will not honour, and SAY that it was corrected. A region that
 *  silently never fires is indistinguishable from a broken geofence implementation. */
export function geoRadius(requested: number): GeoRadius {
  const value = Number.isFinite(requested) ? requested : 0;
  if (value < GEO_RADIUS_FLOOR_METERS) return { radius: GEO_RADIUS_FLOOR_METERS, clamped: true };
  if (value > GEO_RADIUS_CEILING_METERS) return { radius: GEO_RADIUS_CEILING_METERS, clamped: true };
  return { radius: value, clamped: false };
}

export type GeoRegionResult =
  | { readonly ok: true; readonly id: string; readonly count: number; readonly removed?: boolean }
  | { readonly ok: false; readonly error: string; readonly limit?: number; readonly count?: number };

/**
 * The monitored-region set, with the cap accounted for rather than discovered.
 *
 * Re-adding a live id REPLACES it in place and consumes no slot, so a screen that re-declares
 * its regions on every appear cannot exhaust the cap by itself - which is how apps hit the
 * limit in the field.
 */
export class GeoRegionSet {
  #ids: string[] = [];
  readonly #cap: number;

  constructor(cap: number) {
    this.#cap = cap;
  }

  get count(): number { return this.#ids.length; }
  get cap(): number { return this.#cap; }

  list(): string[] { return [...this.#ids]; }

  add(id: string | null | undefined): GeoRegionResult {
    const key = (id ?? "").trim();
    if (key === "") return { ok: false, error: "invalid_argument" };
    if (this.#ids.includes(key)) return { ok: true, id: key, count: this.#ids.length };
    if (this.#ids.length >= this.#cap) {
      return { ok: false, error: "region_limit", limit: this.#cap, count: this.#ids.length };
    }
    this.#ids.push(key);
    return { ok: true, id: key, count: this.#ids.length };
  }

  remove(id: string | null | undefined): GeoRegionResult {
    const key = (id ?? "").trim();
    if (key === "") return { ok: false, error: "invalid_argument" };
    const before = this.#ids.length;
    this.#ids = this.#ids.filter((entry) => entry !== key);
    return { ok: true, id: key, count: this.#ids.length, removed: this.#ids.length !== before };
  }
}

/** Where one crossing goes. A geofence wakes the app with NO UI, so a delivery path that only
 *  reaches a mounted screen is a feature that works in the simulator and never in production:
 *  a region may name a declared Core/Background task, and the crossing runs it. */
export interface GeoDeliveryPlan {
  readonly broadcast: boolean;
  readonly background: boolean;
  readonly foreground: boolean;
}

export function geoDeliveryPlan(
  task: string | null | undefined,
  screenMounted: boolean,
): GeoDeliveryPlan {
  return {
    broadcast: true,
    background: (task ?? "").trim() !== "",
    foreground: screenMounted === true,
  };
}

// ---------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------

/** One accuracy word, and the real platform constant it names. */
export interface GeoAccuracy {
  readonly word: string;
  readonly ios: string;
  readonly android: string;
  readonly web: string;
  readonly meters: number;
}

export const GEO_ACCURACIES: readonly GeoAccuracy[] = [
  { word: "navigation", ios: "kCLLocationAccuracyBestForNavigation", android: "PRIORITY_HIGH_ACCURACY", web: "high", meters: 0 },
  { word: "best", ios: "kCLLocationAccuracyBest", android: "PRIORITY_HIGH_ACCURACY", web: "high", meters: 0 },
  { word: "balanced", ios: "kCLLocationAccuracyNearestTenMeters", android: "PRIORITY_BALANCED_POWER_ACCURACY", web: "low", meters: 10 },
  { word: "low", ios: "kCLLocationAccuracyHundredMeters", android: "PRIORITY_LOW_POWER", web: "low", meters: 100 },
  { word: "passive", ios: "kCLLocationAccuracyThreeKilometers", android: "PRIORITY_PASSIVE", web: "low", meters: 3000 },
];

export const GEO_DEFAULT_ACCURACY = "balanced";

export type GeoAccuracyResolution =
  | { readonly ok: true; readonly value: GeoAccuracy }
  | { readonly ok: false; readonly error: "invalid_argument" };

/** Fold an accuracy word. Absent takes the balanced default; an unrecognised word is refused
 *  rather than silently downgraded, because a silent downgrade is a battery decision made on
 *  the author's behalf. */
export function geoAccuracy(word: string | null | undefined): GeoAccuracyResolution {
  const key = (word ?? "").trim();
  const wanted = key === "" ? GEO_DEFAULT_ACCURACY : key;
  const found = GEO_ACCURACIES.find((entry) => entry.word === wanted);
  return found === undefined ? { ok: false, error: "invalid_argument" } : { ok: true, value: found };
}

/** The IUGG mean Earth radius, in metres. Pinned so three runtimes agree on a distance. */
export const GEO_EARTH_RADIUS_METERS = 6_371_008.8;

/** Great-circle distance between two fixes, in metres (haversine). */
export function geoDistanceMeters(
  fromLat: number, fromLon: number, toLat: number, toLon: number,
): number {
  const rad = Math.PI / 180;
  const phi1 = fromLat * rad;
  const phi2 = toLat * rad;
  const dPhi = (toLat - fromLat) * rad;
  const dLambda = (toLon - fromLon) * rad;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * GEO_EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A delivered fix, reduced to what the filter needs. */
export interface GeoFix {
  readonly lat: number;
  readonly lon: number;
  readonly at: number;
}

export interface GeoFilterVerdict {
  readonly deliver: boolean;
  /** Which filter suppressed it, for the honest reason a caller can log. */
  readonly reason?: "distance" | "interval";
}

/**
 * Does this fix go to the caller.
 *
 * THE BATTERY BUG THIS PREVENTS: a module that accepts `distanceFilter` and delivers every fix
 * anyway passes every test that only checks that positions arrive, and drains a phone in an
 * afternoon. Both filters must pass when both are set; the first fix of a session always goes
 * out, because a filter that swallows the opening position renders a map in the ocean.
 */
export function geoShouldDeliver(
  last: GeoFix | null | undefined,
  next: GeoFix,
  distanceFilter: number,
  intervalMs: number,
): GeoFilterVerdict {
  if (last === null || last === undefined) return { deliver: true };
  if (intervalMs > 0) {
    const elapsed = next.at - last.at;
    // A clock change or a late-queued fix must not wedge the stream forever.
    if (elapsed >= 0 && elapsed < intervalMs) return { deliver: false, reason: "interval" };
  }
  if (distanceFilter > 0) {
    const moved = geoDistanceMeters(last.lat, last.lon, next.lat, next.lon);
    if (moved < distanceFilter) return { deliver: false, reason: "distance" };
  }
  return { deliver: true };
}

/** Whether a cached fix is fresh enough to answer `last({ maxAge })` WITHOUT waking the radio,
 *  which is the whole point of the call. A stale cache is the typed absence, never a stale fix
 *  handed back as though it were current. */
export function geoCacheServes(ageMs: number, maxAgeMs: number): boolean {
  if (!(maxAgeMs > 0)) return true;
  return ageMs <= maxAgeMs;
}
