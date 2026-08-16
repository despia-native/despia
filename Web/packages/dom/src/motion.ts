//
//  motion.ts — OPT-IN DSX router motion (/web/04's transition lane): a neutral Web
//  transition, legacy compatibility transitions, the edge swipe-back, and the master-detail split. CONFIG-PLANE
//  ONLY (`registry.router`, compiled from the app config) — DSX markup and the dsx API are
//  byte-identical whether motion is on or off, and an app that omits the config keeps today's
//  instant swaps. This file is the pure half (policy + math + the stylesheet); the DOM half
//  (animations, the gesture, the split layout) lives in router.ts against these decisions.
//
//  THE SILENCE RULE (SSR / direct routes): motion applies to INTERACTIVE navigation only.
//  Every boot-path mount — the entry frame, a deep link's routed page over it, the 404 —
//  happens before the router flips `interactive`, so a server-rendered direct URL
//  replace-mounts its page with zero transition classes, zero intermediate DOM states, zero
//  flash (the F7 `browserHistoryInitialMatch` behavior, kept absolute here).
//
//  The policy lanes (pure, unit-tested in test/motion.test.ts):
//    • transition: "dsx" | "ios" | "md" | "auto" | "none" — "auto" is the neutral DSX
//      Web family on every browser. `ios` and `md` remain explicit legacy compatibility
//      choices; DSX never fingerprints a UA to choose presentation.
//    • MOBILE lane (width < masterDetailBreakpoint): full-page transitions; edge swipe-back
//      when `swipeBack` and the explicitly resolved motion is ios (legacy compatibility).
//    • WIDE lane (width >= breakpoint): transitions default OFF — a desktop page swap should
//      feel like a web app, not a phone — or `wide: "same"` keeps them; routes flagged
//      `master: true` pin as the persistent left pane while details swap beside it (the F7
//      master-detail shape: the sidebar stays put, only the detail region changes).
//    • prefers-reduced-motion: reduce → the runtime skips every animation (checked at the
//      animation call sites, not here — policy stays pure).
//
//  DSX's neutral family is a short opacity-only crossfade. It deliberately changes no
//  geometry: responsive reflow, late content, and pressed controls must never look as if
//  their chrome is moving independently from their labels. The older native-derived
//  iOS/MD figures are retained only for applications that explicitly request those
//  compatibility families. Timings are pinned constants — never UA-derived and never
//  read from application content.
//

export type RouterMotionConfig = {
  /** the page-transition family; "auto" = neutral DSX Web; omitted/"none" = no motion */
  transition?: "dsx" | "ios" | "md" | "auto" | "none";
  /** the edge swipe-back gesture (mobile lane, explicit legacy ios motion only) */
  swipeBack?: boolean;
  /** the mobile↔wide lane boundary in px (also the master-detail split threshold) */
  masterDetailBreakpoint?: number;
  /** wide-lane transitions: "none" (default — instant swaps) or "same" (keep animating) */
  wide?: "none" | "same";
};

export type MotionFamily = "dsx" | "ios" | "md";
export type MotionKind = MotionFamily | "none";

export const MASTER_DETAIL_DEFAULT = 960;
export const DSX_MS = 160;
export const DSX_EASING = "ease-out";
export const IOS_MS = 400;
export const IOS_EASING = "cubic-bezier(0.25, 0.1, 0.25, 1)";
export const IOS_PARALLAX = -20; // outgoing page translate %, under the incoming one
export const IOS_DIM_PEAK = 0.1; // the outgoing page's dim overlay at rest-under
export const MD_MS = 300;
export const MD_EASING = "cubic-bezier(0, 0, 0.2, 1)";
export const MD_RISE_PX = 56;    // incoming page starts this far below (md slide-up)
export const SWIPE_EDGE_PX = 30; // the gesture's active area from the left edge (F7 default)

/** Neutral web route motion never owns layout or transform. Keeping this plan pure lets
 *  tests prove that future presentation work cannot reintroduce control/text drift. */
export function dsxRouteFrames(direction: "enter" | "exit"): Keyframe[] {
  return direction === "enter"
    ? [{ opacity: "0" }, { opacity: "1" }]
    : [{ opacity: "1" }, { opacity: "0" }];
}

/** Resolve `auto` once per boot. The argument stays for source compatibility with callers
 *  compiled against the old helper, but presentation is deliberately UA-independent. */
export function autoTheme(_userAgent: string): "dsx" {
  return "dsx";
}

/** The pure policy: which motion an interactive push/pop runs right now. */
export function motionFor(
  cfg: RouterMotionConfig | undefined,
  _theme: MotionFamily,
  width: number,
  interactive: boolean,
): MotionKind {
  if (cfg === undefined || !interactive) return "none";
  const t = cfg.transition ?? "none";
  if (t === "none") return "none";
  const resolved = t === "auto" ? "dsx" : t;
  if (width >= (cfg.masterDetailBreakpoint ?? MASTER_DETAIL_DEFAULT)) {
    return (cfg.wide ?? "none") === "same" ? resolved : "none";
  }
  return resolved;
}

/** swipe-back completion — F7's verified rule (deep-research 2026-07-15: a release under
 *  300ms completes as a FLICK when the drag passed the flick floor, otherwise the drag must
 *  pass HALF the view width), with ONE deliberate divergence: F7's flick floor is 10px,
 *  which pops a page on accidental edge grazes; ours is 24px — still an easy flick, never
 *  a twitch. */
export function swipeCompletes(dx: number, width: number, elapsedMs: number): boolean {
  if (dx <= 0 || width <= 0) return false;
  return dx > width * 0.5 || (elapsedMs < 300 && dx > 24);
}

/** swipe-back is a mobile-lane, ios-motion gesture with something to pop. */
export function swipeEnabled(
  cfg: RouterMotionConfig | undefined,
  theme: MotionFamily,
  width: number,
  depth: number,
): boolean {
  if (cfg === undefined || cfg.swipeBack !== true || depth <= 1) return false;
  if (width >= (cfg.masterDetailBreakpoint ?? MASTER_DETAIL_DEFAULT)) return false;
  return motionFor(cfg, theme, width, true) === "ios";
}

/** The split decision: the DEEPEST master frame BELOW the top (a master with no detail
 *  above it fills the window alone), wide lane only. Returns the master's index or -1. */
export function splitMasterIndex(masters: boolean[], width: number, breakpoint: number): number {
  if (width < breakpoint) return -1;
  for (let i = masters.length - 2; i >= 0; i -= 1) {
    if (masters[i] === true) return i;
  }
  return -1;
}

/** Injected once (id "dsx-motion") when the config opts in: the legacy iOS family's edge
 *  shadow, the master-detail split geometry, and the reduced-motion kill. The animations themselves
 *  are WAAPI (router.ts) — cancellable mid-flight for the swipe, no transitionend
 *  bookkeeping — so this sheet carries only what keyframes can't. */
export const MOTION_CSS = `
  [data-dsx-root] { overflow-x: hidden; }

  .dsx-motion-top { will-change: transform, opacity; }

  /* Compatibility-only: neutral DSX/MD motion never borrows the iOS edge treatment. */
  .dsx-motion-top.dsx-motion-ios::before {
    content: ""; position: absolute; top: 0; bottom: 0; right: 100%; width: 16px;
    background: linear-gradient(to left, rgba(0,0,0,0.12), rgba(0,0,0,0)); pointer-events: none;
  }

  /* the dim overlay the runtime drops onto the outgoing/under page during a transition */
  .dsx-motion-dim {
    position: absolute; inset: 0; background: #000; opacity: 0;
    pointer-events: none; z-index: 9;
  }

  /* master-detail (wide lane): the master pins as the persistent left pane — never
     transformed, never dimmed — and detail frames own the remaining region, so their
     100%-translate transitions are naturally region-sized. */
  .dsx-split .dsx-master {
    inset-block: 0; inset-inline-start: 0; inset-inline-end: auto;
    inline-size: var(--dsx-master-width, min(360px, 38%));
    border-inline-end: 1px solid var(--dsx-separator, rgba(60,60,67,0.29));
    transform: none !important;
  }
  .dsx-split .dsx-detail { inset-inline-start: var(--dsx-master-width, min(360px, 38%)); }

  @media (prefers-reduced-motion: reduce) {
    .dsx-motion-top.dsx-motion-ios::before { display: none; }
  }
`;
