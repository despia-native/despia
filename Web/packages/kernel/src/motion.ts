//
//  motion.ts — THE UI MOTION ENGINE: the shared, corpus-pinned physics/math kernel for
//  the NATIVE UI layer (`<stack>`, `<list>`, `<sheet>` — every element), platform-neutral
//  and DOM-free. Law: architecture/proposals/ui-motion.md. Corpus:
//  OpenSource/Conformance/motion/{curves,spring,retarget,physics}.json.
//
//  THE PROBLEM THIS FILE ENDS: the UI layer has carried a motion VOCABULARY — `enter` ·
//  `transition` · `keep` · `anim` · `animDuration`, universal attributes on every element
//  on every renderer — with no motion ENGINE behind it. iOS resolved `anim="spring"`
//  through SwiftUI, Android through Compose, the web through a hand-picked
//  `cubic-bezier(0.34, 1.28, 0.64, 1)`, and nothing held the three to the same curve.
//  The SCENE layer already solved this for `<scene>` (scene/anim.ts + the animation
//  corpus); this is the same treatment for the UI layer.
//
//  ONE SPRING, ONE BEZIER SOLVER. This module implements NEITHER — it imports
//  sceneBezier / sceneSpring / springSettleSeconds from ./scene/anim.ts and re-exports
//  them. A second spring in this codebase would be a bug. What lives here is:
//
//   • the `anim=`/`animDuration=` PARSE into a typed MotionSpec, matching the native
//     defaults exactly (SwiftUI unit beziers, 0.35 s curves; spring response 0.4 /
//     damping 0.8 with animDuration setting the RESPONSE),
//   • the SwiftUI response/dampingFraction → stiffness/damping CONVERSION (the crux of
//     the 1:1 claim — pinned in spring.json),
//   • motionProgress / motionSettleMs,
//   • the RETARGET fold (the CSS-transition interruption model, on scalars),
//   • the UI PHYSICS primitives: decay/fling, rubber-band overscroll, snap projection.
//
//  Every renderer derives its native animation object from this: Compose's
//  spring(dampingRatio, stiffness) / tween(ms, CubicBezierEasing) (StackMotion.kt),
//  SwiftUI's .spring(response:dampingFraction:) / .timingCurve(…) (Stack.swift), and the
//  web's CSS timing functions (dom/element-motion.ts — where the spring is sampled into
//  a `linear()` easing, since CSS has no spring; that approximation is NAMED, not silent).
//

import {
  sceneBezier, sceneSpring, springSettleSeconds, type SceneEasing,
} from "./scene/anim.ts";

// THE one spring / one solver re-export — importers take them from here or from
// scene/anim.ts; there is no third implementation.
export { sceneBezier, sceneSpring, springSettleSeconds };

/** One `malformed-motion` diagnostic per malformed word (Article 7: failure is a
 *  value — the element still animates, with the default). */
export type MotionDiag = (d: { code: "malformed-motion"; message: string }) => void;

export type MotionCurveName = "linear" | "easeIn" | "easeOut" | "easeInOut";
export type MotionName = MotionCurveName | "spring";

/** The parsed `anim=`/`animDuration=` pair. `durationMs` is the CLIP LENGTH: the
 *  authored duration for a curve, the SETTLE TIME for a spring (a spring owns its
 *  clock — `animDuration` set its RESPONSE, not its length). */
export type MotionSpec =
  | {
      kind: "curve"; name: MotionCurveName; durationMs: number;
      x1: number; y1: number; x2: number; y2: number;
    }
  | {
      kind: "spring"; name: "spring"; durationMs: number;
      /** the AUTHORING plane (SwiftUI `.spring(response:dampingFraction:)`) */
      response: number; dampingFraction: number;
      /** the MATH plane (the mass-1 oscillator scene/anim.ts evaluates) */
      stiffness: number; damping: number;
    };

/** The SwiftUI unit beziers — identical to the CSS timing functions of the same names.
 *  `linear` is the degenerate (0,0,1,1) whose y(s) = x(s), i.e. the identity. */
export const MOTION_CURVES: { readonly [K in MotionCurveName]: readonly [number, number, number, number] } = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** SwiftUI's default curve duration when none is authored. */
export const MOTION_DEFAULT_DURATION_MS = 350;
/** SwiftUI `.spring(response: 0.4, dampingFraction: 0.8)` — the native `anim="spring"`. */
export const MOTION_SPRING_DEFAULT_RESPONSE = 0.4;
export const MOTION_SPRING_DEFAULT_DAMPING_FRACTION = 0.8;

/** THE CONVERSION — the crux of the 1:1 claim, pinned in Conformance/motion/spring.json.
 *  SwiftUI's response/dampingFraction describe a mass-1 damped oscillator:
 *  ωₙ = 2π/response · stiffness = ωₙ² · damping = 2·dampingFraction·ωₙ (so ζ = dampingFraction). */
export function motionSpringConstants(
  response: number, dampingFraction: number,
): { stiffness: number; damping: number } {
  const omega = (2 * Math.PI) / response;
  return { stiffness: omega * omega, damping: 2 * dampingFraction * omega };
}

/** The `animDuration=` grammar: a plain decimal number of SECONDS, strictly > 0, on the
 *  TRIMMED string. `null` = absent (use the default, no diagnostic); `NaN` = malformed
 *  (one diagnostic + the default). Deliberately stricter than a bare Number()/Double():
 *  the three runtimes must agree on what is a duration, so the shape is a regex both
 *  Kotlin and Swift spell the same way. */
const DURATION_RE = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function parseDurationSeconds(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (!DURATION_RE.test(text)) return NaN;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return value;
}

/** THE PARSE LAW. `anim` absent/empty is easeInOut and is NOT an error; any other word
 *  falls back to easeInOut with one diagnostic. `animDuration` sets the curve duration
 *  in seconds, or — for `spring` — the RESPONSE. */
export function parseMotion(
  anim: string | undefined | null, animDuration: string | undefined | null, diag?: MotionDiag,
): MotionSpec {
  const parsedDuration = parseDurationSeconds(animDuration);
  let seconds: number | null = null;
  if (parsedDuration !== null && Number.isNaN(parsedDuration)) {
    diag?.({
      code: "malformed-motion",
      message: `animDuration="${animDuration ?? ""}" is not a positive number of seconds — using the default`,
    });
  } else {
    seconds = parsedDuration;
  }

  let name = (anim ?? "").trim();
  if (name.length === 0) name = "easeInOut";
  if (name === "spring") {
    const response = seconds ?? MOTION_SPRING_DEFAULT_RESPONSE;
    const dampingFraction = MOTION_SPRING_DEFAULT_DAMPING_FRACTION;
    const { stiffness, damping } = motionSpringConstants(response, dampingFraction);
    return {
      kind: "spring", name: "spring", response, dampingFraction, stiffness, damping,
      durationMs: springSettleSeconds(stiffness, damping) * 1000,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(MOTION_CURVES, name)) {
    diag?.({
      code: "malformed-motion",
      message: `anim="${anim ?? ""}" is not spring·linear·easeIn·easeOut·easeInOut — using easeInOut`,
    });
    name = "easeInOut";
  }
  const [x1, y1, x2, y2] = MOTION_CURVES[name as MotionCurveName];
  return {
    kind: "curve", name: name as MotionCurveName,
    durationMs: seconds === null ? MOTION_DEFAULT_DURATION_MS : seconds * 1000,
    x1, y1, x2, y2,
  };
}

/** A spring spec built directly from the AUTHORING plane, for the framework's own
 *  springs (the overscroll release below) — `anim="spring"` can only ever reach damping
 *  fraction 0.8, but the kernel's physics primitives name their own. */
export function motionSpring(response: number, dampingFraction: number): MotionSpec {
  const { stiffness, damping } = motionSpringConstants(response, dampingFraction);
  return {
    kind: "spring", name: "spring", response, dampingFraction, stiffness, damping,
    durationMs: springSettleSeconds(stiffness, damping) * 1000,
  };
}

/** Attribute-map convenience — the shape every renderer actually holds. */
export function motionFromAttrs(
  attrs: { readonly [k: string]: string | undefined }, diag?: MotionDiag,
): MotionSpec {
  return parseMotion(attrs["anim"], attrs["animDuration"], diag);
}

/** The two motion PRESETS a renderer applies when the author sets no `anim=` on a
 *  built-in behaviour. Pinned in curves.json `presets` — a renderer must not invent a
 *  third. `keep` = the `keep="true"` hide/show fade; `press` = the button press-scale
 *  snap; `default` = a bare, unauthored `anim`. */
export const MOTION_PRESET_KEEP: MotionSpec = parseMotion("easeOut", "0.18");
export const MOTION_PRESET_PRESS: MotionSpec = parseMotion("easeOut", "0.12");
export const MOTION_PRESET_DEFAULT: MotionSpec = parseMotion(undefined, undefined);

/** The scene easing a spec evaluates through — the bridge to the ONE spring/solver. */
export function motionEasing(spec: MotionSpec): SceneEasing {
  if (spec.kind === "spring") {
    return { kind: "spring", stiffness: spec.stiffness, damping: spec.damping };
  }
  if (spec.name === "linear") return { kind: "linear" };
  return { kind: "bezier", x1: spec.x1, y1: spec.y1, x2: spec.x2, y2: spec.y2 };
}

/** THE PROGRESS LAW: 0..1 at elapsed CLIP time (ms). A curve normalizes by its
 *  duration; a spring runs on the REAL clock and clamps to exactly 1 at/after settle,
 *  so ending never snaps. An underdamped spring legitimately returns > 1 mid-flight. */
export function motionProgress(spec: MotionSpec, elapsedMs: number): number {
  if (spec.kind === "spring") {
    if (elapsedMs >= spec.durationMs) return 1;
    if (elapsedMs <= 0) return 0;
    return sceneSpring(elapsedMs / 1000, spec.stiffness, spec.damping);
  }
  const u = spec.durationMs <= 0 ? 1 : Math.min(Math.max(elapsedMs / spec.durationMs, 0), 1);
  if (spec.name === "linear") return u;
  return sceneBezier(u, spec.x1, spec.y1, spec.x2, spec.y2);
}

/** THE SETTLE LAW: when a clip ends — the authored duration for a curve, the pinned
 *  0.1%-envelope time for a spring (which is what `durationMs` already holds). */
export function motionSettleMs(spec: MotionSpec): number {
  return spec.durationMs;
}

// ── the retarget law (the CSS-transition interruption model, on scalars) ─────────────

/** One in-flight glide: the rendered value travels `from` → `to` starting at `startMs`. */
export type MotionState = { from: number; to: number; startMs: number };

export function motionStart(from: number, to: number, startMs: number): MotionState {
  return { from, to, startMs };
}

/** The rendered value at `nowMs`, and whether the clip has completed (at/after which
 *  the value is EXACTLY `to` — the override retires without a snap). */
export function motionValue(
  spec: MotionSpec, state: MotionState, nowMs: number,
): { value: number; done: boolean } {
  const elapsed = nowMs - state.startMs;
  if (spec.durationMs <= 0 || elapsed >= spec.durationMs) return { value: state.to, done: true };
  const p = motionProgress(spec, elapsed);
  return { value: state.from + (state.to - state.from) * p, done: false };
}

/** THE RETARGET LAW: a new target mid-flight starts a FRESH clip from the CURRENT
 *  rendered value. Never snap to the new target, never queue behind the old clip, and
 *  no special case for retargeting to the value already being animated toward. */
export function motionRetarget(
  spec: MotionSpec, state: MotionState, to: number, nowMs: number,
): MotionState {
  return { from: motionValue(spec, state, nowMs).value, to, startMs: nowMs };
}

// ── the UI physics primitives (ui-motion.md phase 2) ─────────────────────────────────
//
// Offsets and dimensions are POINTS; velocities are POINTS PER MILLISECOND. These are
// pure folds the elements call — sheet detents, pagers, pickers, pull-to-refresh and
// lightbox dismissal all stop re-deriving their own feel.

/** `UIScrollView.DecelerationRate.normal`, per millisecond. */
export const MOTION_DECELERATION_RATE = 0.998;
/** τ = −1 / ln(rate) ms — the decay time constant (≈ 499.499833 ms). */
export const MOTION_DECAY_TAU_MS = -1 / Math.log(MOTION_DECELERATION_RATE);
/** Terminal velocity: at or under this a fling does not move at all (1 pt/s). */
export const MOTION_DECAY_MIN_VELOCITY = 0.001;
/** The standard iOS overscroll compression constant. */
export const MOTION_RUBBER_BAND_C = 0.55;
/** The overscroll RELEASE spring — critically damped, because a snap-back must never
 *  bounce past the edge it is returning to. */
export const MOTION_RUBBER_BAND_RELEASE: MotionSpec = motionSpring(0.35, 1);

function atRest(v0: number): boolean {
  return !(Math.abs(v0) > MOTION_DECAY_MIN_VELOCITY);
}

/** THE DECAY LAW: x(t) = x0 + v0·τ·(1 − e^(−t/τ)). */
export function decayAt(x0: number, v0: number, tMs: number): number {
  if (tMs <= 0 || atRest(v0)) return x0;
  return x0 + v0 * MOTION_DECAY_TAU_MS * (1 - Math.exp(-tMs / MOTION_DECAY_TAU_MS));
}

/** The resting offset — the t → ∞ limit x0 + v0·τ (x0 for a sub-threshold release). */
export function decayTarget(x0: number, v0: number): number {
  return atRest(v0) ? x0 : x0 + v0 * MOTION_DECAY_TAU_MS;
}

/** How long the fling lasts: τ·ln(|v0| / threshold), 0 for a sub-threshold release —
 *  never negative. */
export function decayDurationMs(v0: number): number {
  if (atRest(v0)) return 0;
  return MOTION_DECAY_TAU_MS * Math.log(Math.abs(v0) / MOTION_DECAY_MIN_VELOCITY);
}

/** THE RUBBER-BAND LAW: f(x) = sign(x)·(1 − 1/(|x|·c/d + 1))·d — asymptotic, so no
 *  amount of finger travel moves the content more than `dimension` past the edge. */
export function rubberBand(x: number, dimension: number, c: number = MOTION_RUBBER_BAND_C): number {
  if (!(dimension > 0)) return 0;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  return sign * (1 - 1 / ((a * c) / dimension + 1)) * dimension;
}

/** Its exact inverse — x = (d/c)·(1/(1 − |y|/d) − 1), |y| clamped just inside d — so a
 *  gesture can resume from an already-compressed offset. */
export function rubberBandInverse(y: number, dimension: number, c: number = MOTION_RUBBER_BAND_C): number {
  if (!(dimension > 0)) return 0;
  const sign = y < 0 ? -1 : 1;
  const a = Math.min(Math.abs(y), dimension * 0.999999);
  return sign * (dimension / c) * (1 / (1 - a / dimension) - 1);
}

/** THE SNAP LAW: project the release with the decay fold, then take the NEAREST snap
 *  point to that projection; an exact tie takes the LOWER point (deterministic on all
 *  three runtimes). The one law behind sheet detents, pagers and pickers. */
export function snapTarget(
  x0: number, v0: number, points: readonly number[],
): { projected: number; target: number; index: number } {
  const projected = decayTarget(x0, v0);
  if (points.length === 0) return { projected, target: projected, index: -1 };
  let bestIndex = 0;
  let bestDistance = Math.abs(points[0]! - projected);
  for (let i = 1; i < points.length; i += 1) {
    const distance = Math.abs(points[i]! - projected);
    if (distance < bestDistance - 1e-12
      || (Math.abs(distance - bestDistance) <= 1e-12 && points[i]! < points[bestIndex]!)) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return { projected, target: points[bestIndex]!, index: bestIndex };
}
