//
//  vendor-surface.ts - THE INLINE-VENDOR-SURFACE FAMILY FOLDS (V02..V06,
//  architecture/proposals/inline-native-surfaces.md). The SECOND half of the pure core
//  V01 started in vendor-session.ts, and deliberately a sibling file rather than a fork:
//
//    * resolveSessionRef (the secret boundary), VendorSessionMachine (one session, two
//      views) and vendorRetainKey (keyed identity) are SHARED, unchanged, and every
//      vendor in this family uses them as they are. There is exactly one session machine
//      in this codebase and this file does not add a second.
//    * What the family needed and V01 did not have is here: the permission gate a LIVE
//      surface renders through, the participant roster a call grid orders by, the ad slot
//      geometry and request gate, the paywall package ordering, the sign-in step ladder,
//      and the scan dedupe a live camera preview needs to stop firing sixty times a
//      second. Each is a fold no vendor SDK agrees on and every renderer must.
//
//  The law is the corpus: OpenSource/Conformance/inline-surfaces/{stream,clerk,admob,
//  revenuecat,scanner}.json. The Kotlin twin is :core VendorSurface.kt and the Swift twin
//  is Engine/iOS/VendorSurface.swift.
//
//  PURE by construction: no DOM, no RegExp, no imports, no vendor SDK. Everything is a
//  function of its arguments, which is what lets one corpus judge three runtimes and what
//  lets a camera permission ladder be tested without a camera.
//

// -----------------------------------------------------------------------------
// 1 - THE SURFACE GATE: what a live vendor surface renders, before it renders
// -----------------------------------------------------------------------------

/** Does this build have the hardware and the linked SDK the surface needs. */
export type SurfaceCapability = "present" | "absent";

/** The platform's answer for the permission the surface needs. `unknown` is the honest
 *  word for "not asked yet on a platform that does not distinguish", and it is treated as
 *  `prompt` rather than as a denial: a surface that fails closed on a not-yet-asked
 *  permission never gets asked. */
export type SurfacePermission = "granted" | "prompt" | "denied" | "restricted" | "unknown";

/** What the component puts on screen. `request` is the affordance that asks; `fallback` is
 *  the author's slot children, or the typed-absence caption where there are none. */
export type SurfaceRender = "surface" | "request" | "fallback";

export type SurfaceGateCode =
  | ""
  | "unsupported_platform"
  | "permission_required"
  | "permission_denied"
  | "permission_restricted";

/** One wording per code, so three renderers cannot say it differently. `{subject}` is the
 *  only substitution, and it names the capability ("Camera", "Microphone"). */
export const SURFACE_GATE_MESSAGES: Readonly<Record<string, string>> = {
  unsupported_platform: "{subject} is not available on this device.",
  permission_required: "{subject} access has not been granted yet.",
  permission_denied: "{subject} access was denied. Enable it in Settings to continue.",
  permission_restricted: "{subject} access is restricted on this device.",
};

export const SURFACE_GATE_SUBJECT = "This surface";

export type SurfaceGateInput = Readonly<{
  capability?: SurfaceCapability;
  permission?: SurfacePermission;
  subject?: string;
}>;

export type SurfaceGate = Readonly<{
  render: SurfaceRender;
  code: SurfaceGateCode;
  message: string;
  /** Can the user do something about it. Denied is recoverable (Settings); restricted by
   *  policy and absent hardware are not. */
  recoverable: boolean;
}>;

/**
 * The ladder a live vendor surface descends before it shows anything.
 *
 * ORDER IS THE LAW. Capability first: a device with no camera must not be asked for
 * camera permission, and an SDK that is not linked in this build must answer
 * `unsupported_platform` rather than a permission word it cannot know. Then the
 * permission, where `prompt` and `unknown` both render the ASK rather than the refusal.
 */
export function surfaceGate(input: SurfaceGateInput): SurfaceGate {
  const subject = (input.subject ?? "").trim() === "" ? SURFACE_GATE_SUBJECT : input.subject!.trim();
  const say = (code: SurfaceGateCode): string =>
    code === "" ? "" : (SURFACE_GATE_MESSAGES[code] ?? "").split("{subject}").join(subject);

  if ((input.capability ?? "present") === "absent") {
    return { render: "fallback", code: "unsupported_platform", message: say("unsupported_platform"), recoverable: false };
  }
  switch (input.permission ?? "unknown") {
    case "granted":
      return { render: "surface", code: "", message: "", recoverable: false };
    case "denied":
      return { render: "fallback", code: "permission_denied", message: say("permission_denied"), recoverable: true };
    case "restricted":
      return { render: "fallback", code: "permission_restricted", message: say("permission_restricted"), recoverable: false };
    default:
      return { render: "request", code: "permission_required", message: say("permission_required"), recoverable: true };
  }
}

// -----------------------------------------------------------------------------
// 2 - THE CALL ROSTER: who is on screen, in what order, in how many columns
// -----------------------------------------------------------------------------

export type RosterParticipant = Readonly<{
  id: string;
  local?: boolean;
  pinned?: boolean;
  dominant?: boolean;
  screenShare?: boolean;
  joinedAt?: number;
}>;

/** The tiers, most important first. A tier is a POSITION rule, never a visibility rule:
 *  everyone is in `order`, and only `max` decides who is visible. */
export const ROSTER_TIERS: readonly string[] = ["pinned", "screenShare", "dominant", "remote", "local"];

/** Visible tiles to grid columns. Hardcoded on all three renderers on purpose, so a
 *  three-person call is never 2x2 on one platform and 3x1 on another. */
export function rosterColumns(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export type RosterFoldInput = Readonly<{
  participants?: readonly RosterParticipant[];
  /** 0 or less means no cap. */
  max?: number;
  layout?: string;
}>;

export type RosterFold = Readonly<{
  order: readonly string[];
  visible: readonly string[];
  overflow: number;
  /** The one tile a spotlight layout enlarges, or "". */
  spotlight: string;
  columns: number;
  rows: number;
}>;

function rosterTier(p: RosterParticipant): number {
  if (p.pinned === true) return 0;
  if (p.screenShare === true) return 1;
  if (p.dominant === true) return 2;
  if (p.local === true) return 4;
  return 3;
}

/**
 * Order a call's participants deterministically.
 *
 * The local participant sinks to the bottom unless something promotes it (a pin, a screen
 * share, the floor), because a user looking at their own face instead of the person
 * talking is the complaint every call app gets first. Ties break on join time and then on
 * id, so the same roster produces the same grid on three renderers and a re-render does
 * not shuffle tiles under a finger.
 */
export function rosterFold(input: RosterFoldInput): RosterFold {
  const people = [...(input.participants ?? [])].filter((p) => (p.id ?? "") !== "");
  const ranked = people
    .map((p, i) => ({ p, i, tier: rosterTier(p), at: p.joinedAt ?? 0 }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.at !== b.at) return a.at - b.at;
      if (a.p.id !== b.p.id) return a.p.id < b.p.id ? -1 : 1;
      return a.i - b.i;
    });

  const order = ranked.map((r) => r.p.id);
  const max = input.max ?? 0;
  const visible = max > 0 ? order.slice(0, max) : order;
  const columns = rosterColumns(visible.length);
  return {
    order,
    visible,
    overflow: order.length - visible.length,
    spotlight: (input.layout ?? "") === "spotlight" ? (order[0] ?? "") : "",
    columns,
    rows: columns === 0 ? 0 : Math.ceil(visible.length / columns),
  };
}

// -----------------------------------------------------------------------------
// 3 - THE AD SLOT: geometry, and whether a request may be made at all
// -----------------------------------------------------------------------------

/** The IAB sizes the vendor SDKs name, in density-independent pixels. Data, not code,
 *  because these are the vendor's numbers and all three renderers must hardcode the same
 *  ones (check_renderer_constants territory). */
export const AD_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  banner: [320, 50],
  largeBanner: [320, 100],
  mediumRectangle: [300, 250],
  fullBanner: [468, 60],
  leaderboard: [728, 90],
  skyscraper: [120, 600],
};

export type AdSlotCode = "" | "unknown_size" | "unknown_width";

export type AdSlot = Readonly<{
  width: number;
  height: number;
  /** The SDK measures this one. The fold refuses to invent an adaptive height: Google
   *  computes it from the device at request time, and a number guessed here would be a
   *  layout that jumps the first time a real ad lands. */
  adaptive: boolean;
  code: AdSlotCode;
}>;

export function adSlot(size: string | null | undefined, width: number = 0): AdSlot {
  const word = (size ?? "").trim();
  if (word === "" || word === "adaptive") {
    return width > 0
      ? { width, height: 0, adaptive: true, code: "" }
      : { width: 0, height: 0, adaptive: true, code: "unknown_width" };
  }
  const fixed = AD_SIZES[word];
  if (fixed === undefined) return { width: 0, height: 0, adaptive: false, code: "unknown_size" };
  return { width: fixed[0], height: fixed[1], adaptive: false, code: "" };
}

/** What the consent platform answered. `not_required` is a real state (a user outside the
 *  regions that require a form), and it is not the same as `obtained`. */
export type AdConsent = "obtained" | "required" | "not_required" | "unknown";

/** The consent words, ordered from the least to the most that is known to be permitted.
 *  `required` (a form is outstanding) is more restrictive than `not_required` (this user is
 *  outside the regions that need one), and `unknown` is the floor because nothing has been
 *  asked yet. The order is what makes the fold below a minimum. */
export const AD_CONSENT_RANK: Readonly<Record<string, number>> = {
  unknown: 0, required: 1, not_required: 2, obtained: 3,
};

/**
 * The MODULE's consent answer folded with what a caller asserted. Minimum wins.
 *
 * The module holds the platform's answer (UMP's `canRequestAds` and `consentStatus`); a
 * caller — a component attribute, a page, a markup `session()` arg — holds an assertion.
 * An assertion may only NARROW: a caller that says `obtained` over an `unknown` module
 * answer is asking the build to request an ad on a consent nobody gathered, which is the
 * policy breach this fold exists to make unreachable.
 *
 * An assertion that is absent, empty, or not one of the four words is not a consent
 * statement at all, so the module's answer stands rather than being dragged to the floor
 * by a typo. An unrecognised MODULE answer is `unknown`, because the module's word is the
 * authority and an authority that cannot be read has answered nothing.
 */
export function adConsentFold(module: string | null | undefined, asserted?: string | null): AdConsent {
  const own = (module ?? "").trim();
  const mine = AD_CONSENT_RANK[own] === undefined ? "unknown" : (own as AdConsent);
  const claim = (asserted ?? "").trim();
  if (AD_CONSENT_RANK[claim] === undefined) return mine;
  return AD_CONSENT_RANK[claim] < AD_CONSENT_RANK[mine] ? (claim as AdConsent) : mine;
}

export type AdRequestGateInput = Readonly<{
  unitId?: string;
  enabled?: boolean;
  /** The MODULE's own answer, from the consent platform. */
  consent?: AdConsent;
  /** What the caller asserted, folded into `consent` by `adConsentFold`. Narrowing only. */
  asserted?: string | null;
}>;

export type AdRequestCode = "" | "missing_ad_unit" | "ads_disabled" | "consent_required" | "consent_pending";

export type AdRequestGate = Readonly<{ request: boolean; code: AdRequestCode; recoverable: boolean }>;

/**
 * Whether an ad request may leave the device.
 *
 * ORDER IS THE LAW, and the consent rows are the reason: a build that requests an ad
 * while a consent form is outstanding is a policy violation, not a missed impression, so
 * `consent_required` must be answered before anything that could look like a reason to
 * proceed. A missing unit id is checked first only because it is a build mistake, and
 * saying "ads are disabled" to someone who forgot the id sends them to the wrong file.
 *
 * The consent the gate judges is `adConsentFold(consent, asserted)` — the module's answer
 * narrowed by the caller's, never widened by it.
 */
export function adRequestGate(input: AdRequestGateInput): AdRequestGate {
  if ((input.unitId ?? "").trim() === "") return { request: false, code: "missing_ad_unit", recoverable: false };
  if ((input.enabled ?? true) === false) return { request: false, code: "ads_disabled", recoverable: false };
  const consent = adConsentFold(input.consent ?? "unknown", input.asserted);
  if (consent === "required") return { request: false, code: "consent_required", recoverable: true };
  if (consent === "unknown") return { request: false, code: "consent_pending", recoverable: true };
  return { request: true, code: "", recoverable: false };
}

// -----------------------------------------------------------------------------
// 4 - THE PAYWALL: the vendor's packages, in one order, with one default
// -----------------------------------------------------------------------------

/** The vendor's own package-type vocabulary, in the order a paywall lists them. */
export const PACKAGE_ORDER: readonly string[] = [
  "lifetime", "annual", "six_month", "three_month", "two_month", "monthly", "weekly", "custom", "unknown",
];

/** Months per package type, for the per-month comparison. A type absent from this table is
 *  NOT comparable, and the fold refuses to compare it rather than inventing a length:
 *  `lifetime` has no term and `weekly` is not a whole number of months. */
export const PACKAGE_MONTHS: Readonly<Record<string, number>> = {
  annual: 12, six_month: 6, three_month: 3, two_month: 2, monthly: 1,
};

export type PaywallPackage = Readonly<{
  id: string;
  type?: string;
  /** The price in the store's own currency, as the vendor reports it. */
  price?: number;
}>;

export type PaywallFoldInput = Readonly<{
  packages?: readonly PaywallPackage[];
  /** The author's or the user's current choice. Honoured when it names a real package. */
  selected?: string | null;
}>;

export type PaywallFold = Readonly<{
  order: readonly string[];
  /** What is selected when the paywall opens. */
  defaultId: string;
  /** The package that carries the "best value" badge, or "". */
  badgeId: string;
  /** That package's whole-percent saving against the monthly price, or 0. */
  savings: number;
}>;

function packageRank(type: string | undefined): number {
  const index = PACKAGE_ORDER.indexOf((type ?? "unknown").trim());
  return index < 0 ? PACKAGE_ORDER.length : index;
}

/**
 * Order a paywall's packages and pick its default and its badge.
 *
 * The saving is computed against the MONTHLY package because that is the comparison a
 * buyer makes, and it is computed only where the term is a whole number of months. With
 * no monthly package there is nothing honest to compare against, so there is no badge:
 * a "save 40%" against a price the store does not offer is the dark pattern this fold
 * exists to not ship.
 */
export function paywallFold(input: PaywallFoldInput): PaywallFold {
  const rows = [...(input.packages ?? [])].filter((p) => (p.id ?? "") !== "");
  const ranked = rows
    .map((p, i) => ({ p, i, rank: packageRank(p.type) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.p.id !== b.p.id) return a.p.id < b.p.id ? -1 : 1;
      return a.i - b.i;
    });
  const order = ranked.map((r) => r.p.id);

  const selected = (input.selected ?? "").trim();
  const annual = ranked.find((r) => (r.p.type ?? "") === "annual");
  const defaultId = order.includes(selected)
    ? selected
    : annual !== undefined ? annual.p.id : (order[0] ?? "");

  const monthly = ranked.find((r) => (r.p.type ?? "") === "monthly");
  const base = monthly === undefined ? 0 : (monthly.p.price ?? 0);
  let badgeId = "";
  let savings = 0;
  if (base > 0) {
    for (const row of ranked) {
      const months = PACKAGE_MONTHS[(row.p.type ?? "").trim()];
      if (months === undefined || months <= 1) continue;
      const price = row.p.price ?? 0;
      if (price <= 0) continue;
      const saving = Math.round((1 - price / months / base) * 100);
      if (saving > savings) {
        savings = saving;
        badgeId = row.p.id;
      }
    }
  }
  return { order, defaultId, badgeId, savings };
}

// -----------------------------------------------------------------------------
// 5 - THE SIGN-IN LADDER: one step of a vendor auth attempt, inline
// -----------------------------------------------------------------------------

/** The vendor's own status vocabulary for a sign-in attempt. */
export type SignInStatus =
  | "needs_identifier" | "needs_first_factor" | "needs_second_factor"
  | "needs_new_password" | "missing_requirements" | "complete" | "abandoned";

export type SignInStep =
  | "identifier" | "first_factor" | "second_factor" | "new_password" | "requirements" | "complete" | "restart";

/** Strategy display order. A password field beats a code the user has to go and fetch, and
 *  a passkey beats both where the device has one, so the ladder puts the cheapest gesture
 *  first and leaves the rest as alternates. */
export const SIGNIN_STRATEGY_ORDER: readonly string[] = [
  "passkey", "password", "email_code", "phone_code", "email_link", "reset_password_email_code",
];

export type SignInLadderInput = Readonly<{
  status?: string;
  strategies?: readonly string[];
  /** Fields the vendor says are still missing, for the requirements step. */
  missing?: readonly string[];
}>;

export type SignInLadder = Readonly<{
  step: SignInStep;
  /** What the inline form puts on screen for this step. */
  fields: readonly string[];
  /** The offered strategies, ordered, with unknown ones kept and sorted after. */
  strategies: readonly string[];
  /** No further step: the attempt is finished, one way or the other. */
  terminal: boolean;
  code: "" | "unknown_status";
}>;

function orderStrategies(raw: readonly string[]): string[] {
  const seen: string[] = [];
  for (const s of raw) {
    const name = (s ?? "").trim();
    if (name !== "" && !seen.includes(name)) seen.push(name);
  }
  const known = seen.filter((s) => SIGNIN_STRATEGY_ORDER.includes(s))
    .sort((a, b) => SIGNIN_STRATEGY_ORDER.indexOf(a) - SIGNIN_STRATEGY_ORDER.indexOf(b));
  const rest = seen.filter((s) => !SIGNIN_STRATEGY_ORDER.includes(s)).sort();
  return [...known, ...rest];
}

/**
 * One rung of a vendor sign-in attempt, as an inline component renders it.
 *
 * The vendor owns the attempt; this only decides what is on screen for the status the
 * vendor last reported. An UNKNOWN status is a restart with a code rather than a blank
 * screen: a vendor that adds a status next quarter must degrade to "start again", which
 * is recoverable, and never to a form with no fields, which is not.
 */
export function signInLadder(input: SignInLadderInput): SignInLadder {
  const strategies = orderStrategies(input.strategies ?? []);
  const has = (name: string): boolean => strategies.includes(name);
  const done = (step: SignInStep, fields: readonly string[], terminal = false, code: "" | "unknown_status" = ""):
    SignInLadder => ({ step, fields, strategies, terminal, code });

  switch ((input.status ?? "").trim()) {
    case "needs_identifier":
      return done("identifier", ["identifier"]);
    case "needs_first_factor":
      return done("first_factor", has("password") ? ["password"] : ["code"]);
    case "needs_second_factor":
      return done("second_factor", ["code"]);
    case "needs_new_password":
      return done("new_password", ["password", "confirmation"]);
    case "missing_requirements": {
      const missing = (input.missing ?? []).map((m) => (m ?? "").trim()).filter((m) => m !== "");
      return done("requirements", missing.length > 0 ? missing : ["identifier"]);
    }
    case "complete":
      return done("complete", [], true);
    case "abandoned":
      return done("restart", [], true);
    default:
      return done("restart", [], false, "unknown_status");
  }
}

// -----------------------------------------------------------------------------
// 6 - THE SCAN GATE: a live camera emits the same code sixty times a second
// -----------------------------------------------------------------------------

export type ScanMode = "once" | "continuous";

export type ScanReason =
  | "empty"              // the frame decoded nothing
  | "format_filtered"    // a real code, of a format this surface did not ask for
  | "duplicate_settled"  // mode="once" and this surface already delivered
  | "first"              // the first code this surface has seen
  | "changed"            // a different code than the last one
  | "repeat_debounced"   // the same code, inside the window
  | "repeat";            // the same code, after the window: a deliberate re-scan

export type ScanGateInput = Readonly<{
  value?: string;
  format?: string;
  at?: number;
  /** The formats the surface declared. Empty means every format the SDK decodes. */
  formats?: readonly string[];
  mode?: ScanMode;
  debounceMs?: number;
  lastValue?: string;
  lastAt?: number;
  emitted?: boolean;
}>;

export type ScanGate = Readonly<{ emit: boolean; reason: ScanReason }>;

export const SCAN_DEBOUNCE_MS = 1500;

/**
 * Whether a decoded frame becomes an event.
 *
 * A live preview hands the same payload to the analyzer on every frame. Without this a
 * `on:scan` handler that pushes a route fires thirty times before the transition starts,
 * which is the bug every camera integration ships once. The order below is the law: an
 * unwanted FORMAT is filtered before the mode is consulted, so a barcode in a QR-only
 * surface never settles a `once` scanner and leaves it deaf to the code it wanted.
 */
export function scanGate(input: ScanGateInput): ScanGate {
  const value = input.value ?? "";
  if (value === "") return { emit: false, reason: "empty" };

  const formats = (input.formats ?? []).map((f) => (f ?? "").trim()).filter((f) => f !== "");
  if (formats.length > 0 && !formats.includes((input.format ?? "").trim())) {
    return { emit: false, reason: "format_filtered" };
  }
  if ((input.mode ?? "once") === "once" && input.emitted === true) {
    return { emit: false, reason: "duplicate_settled" };
  }
  if ((input.lastValue ?? "") === "") return { emit: true, reason: "first" };
  if (value !== input.lastValue) return { emit: true, reason: "changed" };

  const window = input.debounceMs ?? SCAN_DEBOUNCE_MS;
  const elapsed = (input.at ?? 0) - (input.lastAt ?? 0);
  return elapsed < window ? { emit: false, reason: "repeat_debounced" } : { emit: true, reason: "repeat" };
}
