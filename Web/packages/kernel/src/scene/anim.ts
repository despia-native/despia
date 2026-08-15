//
//  scene/anim.ts - the DSX Scene animation system (dsx-scene.md P5), platform-neutral
//  and corpus-pinned (OpenSource/Conformance/scene/animation.json). THE SEMANTICS LAW:
//  an animation produces a value that OVERRIDES the authored/bound base value of ONE
//  property while active; when it ends, the property returns to base (or holds, per
//  fill="hold"). Two shapes share this evaluator:
//
//  - IMPLICIT TRANSITIONS — `transition="position 300ms ease-out, color 200ms"` on any
//    scene node: when the property's resolved BASE value changes, the rendered value
//    RETARGETS from its CURRENT RENDERED value to the new base over the duration (the
//    CSS transition model: interrupt = start from where you are, never snap, never
//    queue). A store write glides.
//  - EXPLICIT TWEENS — `<animate target from to duration delay easing loop when fill
//    on:done/>` as a CHILD of the node it animates.
//
//  EASING IS PINNED MATH (the exact constants and formulas live in the corpus README):
//  linear; ease/ease-in/ease-out/ease-in-out as the CSS cubic-bezier constants (solved
//  by 60 bisection iterations — deterministic across IEEE-double runtimes); and
//  spring(stiffness, damping), the analytic mass-1 damped spring evaluated on the REAL
//  clock (duration is ignored; the clip ends at the pinned settle time). Vector and
//  color properties interpolate COMPONENTWISE — colors on the LINEAR-RGB value plane.
//
//  DETERMINISM: value(t) is a pure function of the spec + start state — that is what
//  the corpus samples pin to 6 decimals. The RUNTIME law (animations ride the existing
//  kernel frame clock; the loop runs only while at least one animation is active or an
//  on:frame handler exists) belongs to each surface's adapter, not this module.
//

import type { SceneDiag, SceneNode, SceneResolve } from "./ir.ts";
import { parseSceneColor } from "./ir.ts";
import type { Vec3 } from "./math.ts";

// ── easing: the pinned curves ────────────────────────────────────────────────────────

export type SceneEasing =
  | { kind: "linear" }
  | { kind: "bezier"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "spring"; stiffness: number; damping: number };

/** the CSS keyword constants, verbatim */
export const SCENE_EASE_CONSTANTS: { readonly [name: string]: readonly [number, number, number, number] } = {
  "ease": [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

export const SCENE_SPRING_DEFAULT_STIFFNESS = 100;
export const SCENE_SPRING_DEFAULT_DAMPING = 10;

/** `linear` · a CSS keyword · `spring(stiffness,damping)` (either arg omissible —
 *  `spring()` = spring(100,10)). Malformed → `ease` with one diagnostic. */
export function parseSceneEasing(raw: string, diag?: SceneDiag): SceneEasing {
  const text = raw.trim();
  if (text.length === 0 || text === "ease") {
    const [x1, y1, x2, y2] = SCENE_EASE_CONSTANTS["ease"]!;
    return { kind: "bezier", x1, y1, x2, y2 };
  }
  if (text === "linear") return { kind: "linear" };
  const keyword = SCENE_EASE_CONSTANTS[text];
  if (keyword !== undefined) {
    const [x1, y1, x2, y2] = keyword;
    return { kind: "bezier", x1, y1, x2, y2 };
  }
  const spring = /^spring\(\s*([^,)\s]*)\s*(?:,\s*([^,)\s]*)\s*)?\)$/.exec(text);
  if (spring !== null) {
    const stiffness = spring[1] === undefined || spring[1] === "" ? SCENE_SPRING_DEFAULT_STIFFNESS : Number(spring[1]);
    const damping = spring[2] === undefined || spring[2] === "" ? SCENE_SPRING_DEFAULT_DAMPING : Number(spring[2]);
    if (Number.isFinite(stiffness) && stiffness > 0 && Number.isFinite(damping) && damping > 0) {
      return { kind: "spring", stiffness, damping };
    }
  }
  diag?.({ code: "malformed-animation", message: `easing="${raw}" is not a known easing — using ease` });
  const [x1, y1, x2, y2] = SCENE_EASE_CONSTANTS["ease"]!;
  return { kind: "bezier", x1, y1, x2, y2 };
}

/** cubic-bezier((0,0) P1 P2 (1,1)) sampled at parameter s */
function bezierAxis(s: number, c1: number, c2: number): number {
  const inverse = 1 - s;
  return 3 * inverse * inverse * s * c1 + 3 * inverse * s * s * c2 + s * s * s;
}

/** THE PINNED SOLVER: find s with x(s) = u by exactly 60 bisection iterations on
 *  s ∈ [0, 1] (x is monotone for CSS-legal x1/x2 ∈ [0, 1]) — deterministic on every
 *  IEEE-double runtime, then return y(s). */
export function sceneBezier(u: number, x1: number, y1: number, x2: number, y2: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezierAxis(mid, x1, x2) < u) lo = mid;
    else hi = mid;
  }
  const s = (lo + hi) / 2;
  return bezierAxis(s, y1, y2);
}

/** THE SPRING LAW: the analytic mass-1 damped spring from 0 to 1 (initial position 0,
 *  initial velocity 0) at REAL elapsed seconds t. ωₙ = √stiffness, ζ = damping/(2·√stiffness).
 *  ζ<1: 1 − e^(−ζωₙt)·(cos(ω_d t) + (ζωₙ/ω_d)·sin(ω_d t)) with ω_d = ωₙ√(1−ζ²);
 *  ζ=1: 1 − e^(−ωₙt)·(1 + ωₙt);
 *  ζ>1: 1 − (s₂·e^(s₁t) − s₁·e^(s₂t))/(s₂ − s₁) with s₁,₂ = −ζωₙ ± ωₙ√(ζ²−1). */
export function sceneSpring(tSec: number, stiffness: number, damping: number): number {
  if (tSec <= 0) return 0;
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * tSec)
      * (Math.cos(damped * tSec) + (zeta * omega / damped) * Math.sin(damped * tSec));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * tSec) * (1 + omega * tSec);
  const root = omega * Math.sqrt(zeta * zeta - 1);
  const s1 = -zeta * omega + root;
  const s2 = -zeta * omega - root;
  return 1 - (s2 * Math.exp(s1 * tSec) - s1 * Math.exp(s2 * tSec)) / (s2 - s1);
}

/** THE SETTLE LAW: a spring clip ignores `duration` — it completes at the pinned time
 *  its envelope decays to 0.1%: T = ln(1000) / (ωₙ·(ζ − √(max(0, ζ²−1)))). At and past
 *  T the progress clamps to exactly 1, so ending never snaps. */
export function springSettleSeconds(stiffness: number, damping: number): number {
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  return Math.log(1000) / (omega * (zeta - Math.sqrt(Math.max(0, zeta * zeta - 1))));
}

/** a clip's length in ms: the authored duration, except spring which owns its clock */
export function sceneClipMs(easing: SceneEasing, durationMs: number): number {
  return easing.kind === "spring"
    ? springSettleSeconds(easing.stiffness, easing.damping) * 1000
    : durationMs;
}

/** progress at elapsed CLIP time (ms; the caller has already removed delay + loop
 *  arithmetic). linear/bezier normalize by the clip; spring runs on real seconds and
 *  clamps to 1 at/after settle. */
export function sceneEasingProgress(easing: SceneEasing, elapsedMs: number, durationMs: number): number {
  if (easing.kind === "spring") {
    const settle = springSettleSeconds(easing.stiffness, easing.damping);
    if (elapsedMs / 1000 >= settle) return 1;
    return sceneSpring(elapsedMs / 1000, easing.stiffness, easing.damping);
  }
  const u = durationMs <= 0 ? 1 : Math.min(Math.max(elapsedMs / durationMs, 0), 1);
  if (easing.kind === "linear") return u;
  return sceneBezier(u, easing.x1, easing.y1, easing.x2, easing.y2);
}

// ── the value plane (componentwise; colors in LINEAR RGB) ────────────────────────────

export type SceneAnimTarget = "position" | "rotation" | "scale" | "color" | "intensity" | "fov";

/** THE SUPPORTED TARGET SET, closed: position · rotation · scale (vec3) · color
 *  (linear-RGB triple) · intensity · fov (scalars). opacity is a NAMED ABSENCE — the
 *  scene material plane has no opacity channel. */
export const SCENE_ANIM_TARGETS: ReadonlySet<string> = new Set([
  "position", "rotation", "scale", "color", "intensity", "fov",
]);

export function sceneAnimComponents(target: SceneAnimTarget): number {
  return target === "intensity" || target === "fov" ? 1 : 3;
}

/** sRGB channel (0..1) → linear (the IEC 61966-2-1 curve) */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** linear channel → sRGB (0..1) */
export function linearToSrgb(c: number): number {
  const clamped = Math.min(Math.max(c, 0), 1);
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** an authored value string → the animation VALUE PLANE: vec3 targets parse the
 *  space-separated triple; scalars one number; `color` parses #hex and LINEARIZES each
 *  channel (interpolation is plain componentwise lerp on this plane for every target).
 *  null = malformed (the caller diags + treats the animation as inert). */
export function parseSceneAnimValue(target: SceneAnimTarget, raw: string): number[] | null {
  if (target === "color") {
    const srgb = parseSceneColor(raw);
    return srgb === null ? null : srgb.map(srgbToLinear);
  }
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length !== sceneAnimComponents(target)) return null;
  const numbers = parts.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

/** the value plane → the RESOLVED-ATTRIBUTE string a renderer's resolver overrides
 *  with: vec3/scalar as full-precision space-separated numbers (String round-trips
 *  IEEE doubles); color delinearizes to #rrggbb (displays are 8-bit — the corpus pins
 *  the linear plane, the hex is the last-step quantization). */
export function formatSceneAnimValue(target: SceneAnimTarget, value: readonly number[]): string {
  if (target === "color") {
    const hex = value.map((c) => {
      const byte = Math.min(255, Math.max(0, Math.round(linearToSrgb(c) * 255)));
      return byte.toString(16).padStart(2, "0");
    });
    return `#${hex.join("")}`;
  }
  return value.map((v) => String(v)).join(" ");
}

function lerpComponents(from: readonly number[], to: readonly number[], p: number): number[] {
  return to.map((t, i) => (from[i] ?? 0) + (t - (from[i] ?? 0)) * p);
}

// ── duration / loop words ────────────────────────────────────────────────────────────

// `2s` · `300ms` · bare `300` (ms). null = malformed. Negative is malformed.
// The definition moved to ir.ts (G3: the model `blend` word shares it) — re-exported
// here so every existing import keeps working.
export { parseSceneDuration } from "./ir.ts";
import { parseSceneDuration } from "./ir.ts";

export type SceneLoop =
  | { kind: "none" }
  | { kind: "infinite" }
  | { kind: "count"; count: number }
  | { kind: "pingpong" };

/** absent/`false` → none · `true` → infinite · positive integer N → count ·
 *  `pingpong` → infinite ping-pong. Malformed → none + one diagnostic. */
export function parseSceneLoop(raw: string | undefined, diag?: SceneDiag): SceneLoop {
  if (raw === undefined) return { kind: "none" };
  const text = raw.trim();
  if (text === "" || text === "false") return { kind: "none" };
  if (text === "true") return { kind: "infinite" };
  if (text === "pingpong") return { kind: "pingpong" };
  if (/^[0-9]+$/.test(text)) {
    const count = Number(text);
    if (count > 0) return { kind: "count", count };
  }
  diag?.({ code: "malformed-animation", message: `loop="${raw}" is not false, true, a positive integer or pingpong — not looping` });
  return { kind: "none" };
}

// ── explicit tweens (`<animate>`) ────────────────────────────────────────────────────

export type SceneTweenSpec = {
  target: SceneAnimTarget;
  /** null = capture the BASE value at clip start (the from-default law) */
  from: number[] | null;
  to: number[];
  durationMs: number;
  delayMs: number;
  easing: SceneEasing;
  loop: SceneLoop;
  fill: "none" | "hold";
};

export const SCENE_TWEEN_DEFAULT_DURATION_MS = 300;

/** parse an `<animate>` node's resolved attributes into the spec. A missing/unknown
 *  target or a malformed `to` makes the animation INERT (null + one diagnostic) —
 *  failure is a value, the scene keeps rendering (Article 7). */
export function parseSceneTween(node: SceneNode, resolve: SceneResolve, diag?: SceneDiag): SceneTweenSpec | null {
  const read = (name: string): string | null => {
    const raw = node.attrs[name];
    return raw === undefined ? null : resolve(node, name, raw);
  };
  const targetRaw = read("target") ?? "";
  if (!SCENE_ANIM_TARGETS.has(targetRaw)) {
    diag?.({ code: "malformed-animation", message: `<animate target="${targetRaw}"> is not one of position·rotation·scale·color·intensity·fov — inert` });
    return null;
  }
  const target = targetRaw as SceneAnimTarget;
  const toRaw = read("to");
  const to = toRaw === null ? null : parseSceneAnimValue(target, toRaw);
  if (to === null) {
    diag?.({ code: "malformed-animation", message: `<animate to="${toRaw ?? ""}"> is not a ${target} value — inert` });
    return null;
  }
  let from: number[] | null = null;
  const fromRaw = read("from");
  if (fromRaw !== null) {
    from = parseSceneAnimValue(target, fromRaw);
    if (from === null) {
      diag?.({ code: "malformed-animation", message: `<animate from="${fromRaw}"> is not a ${target} value — using the base value at start` });
    }
  }
  let durationMs = SCENE_TWEEN_DEFAULT_DURATION_MS;
  const durationRaw = read("duration");
  if (durationRaw !== null) {
    const parsed = parseSceneDuration(durationRaw);
    if (parsed === null) diag?.({ code: "malformed-animation", message: `duration="${durationRaw}" is not ms|s — using 300ms` });
    else durationMs = parsed;
  }
  let delayMs = 0;
  const delayRaw = read("delay");
  if (delayRaw !== null) {
    const parsed = parseSceneDuration(delayRaw);
    if (parsed === null) diag?.({ code: "malformed-animation", message: `delay="${delayRaw}" is not ms|s — using 0` });
    else delayMs = parsed;
  }
  const fillRaw = read("fill");
  const fill: "none" | "hold" = fillRaw === "hold" ? "hold" : "none";
  if (fillRaw !== null && fillRaw !== "hold" && fillRaw !== "none") {
    diag?.({ code: "malformed-animation", message: `fill="${fillRaw}" is not none or hold — using none` });
  }
  return {
    target, from, to, durationMs, delayMs,
    easing: parseSceneEasing(read("easing") ?? "", diag),
    loop: parseSceneLoop(read("loop") ?? undefined, diag),
    fill,
  };
}

export type SceneTweenSample = {
  /** the rendered value of the target property at t */
  value: number[];
  /** true while the animation is producing the value (false = the property shows base) */
  overriding: boolean;
  /** true once the clip has COMPLETED (loop none/count exhausted) — on:done fires on
   *  the false→true edge, once, never per loop iteration */
  done: boolean;
};

/** THE VALUE LAW, pure: sample a tween at t ms since clip start. `from` is the
 *  captured start value (spec.from, or base at start when unauthored); `base` is the
 *  property's current resolved base value.
 *  - t < delay → base, not overriding (the delay shows base; delay applies ONCE).
 *  - looping: cycle c = floor((t−delay)/clip), u = (t−delay) − c·clip. pingpong
 *    samples the easing at (clip − u) on odd cycles (the same curve, traversed
 *    backwards). At an exact wrap instant u = 0 (the new cycle's start).
 *  - completion (loop none at clip end; loop N at N·clip): fill="hold" keeps the final
 *    value (= to) and stays overriding; fill="none" returns to base. done = true.
 *  - the clip length is `duration` for linear/bezier and the SETTLE TIME for spring. */
export function sceneTweenValue(
  spec: SceneTweenSpec, from: readonly number[], base: readonly number[], tMs: number,
): SceneTweenSample {
  if (tMs < spec.delayMs) return { value: [...base], overriding: false, done: false };
  const clip = sceneClipMs(spec.easing, spec.durationMs);
  const elapsed = tMs - spec.delayMs;
  const finished =
    (spec.loop.kind === "none" && (clip <= 0 || elapsed >= clip))
    || (spec.loop.kind === "count" && (clip <= 0 || elapsed >= spec.loop.count * clip));
  if (finished) {
    return spec.fill === "hold"
      ? { value: [...spec.to], overriding: true, done: true }
      : { value: [...base], overriding: false, done: true };
  }
  let cycleMs = elapsed;
  let reversed = false;
  if (spec.loop.kind !== "none" && clip > 0) {
    const cycle = Math.floor(elapsed / clip);
    cycleMs = elapsed - cycle * clip;
    reversed = spec.loop.kind === "pingpong" && cycle % 2 === 1;
  }
  const p = sceneEasingProgress(spec.easing, reversed ? clip - cycleMs : cycleMs, spec.durationMs);
  return { value: lerpComponents(from, spec.to, p), overriding: true, done: false };
}

// ── implicit transitions ─────────────────────────────────────────────────────────────

export type SceneTransitionEntry = {
  property: SceneAnimTarget;
  durationMs: number;
  easing: SceneEasing;
  delayMs: number;
};

/** split on top-level commas only — a comma inside `spring(100,10)` belongs to the
 *  easing, not the entry list */
function splitTransitionEntries(raw: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) { out.push(raw.slice(start, i)); start = i + 1; }
  }
  out.push(raw.slice(start));
  return out;
}

/** `transition="position 300ms ease-out, color 200ms"` — comma-separated entries of
 *  `<property> <duration> [<easing>] [<delay>]` (commas inside `spring(…)` stay with
 *  the easing). A malformed entry is skipped with one diagnostic; the rest still apply. */
export function parseSceneTransitions(raw: string, diag?: SceneDiag): SceneTransitionEntry[] {
  const out: SceneTransitionEntry[] = [];
  for (const entry of splitTransitionEntries(raw)) {
    const text = entry.trim();
    if (text.length === 0) continue;
    const words = text.split(/\s+/);
    const property = words[0] ?? "";
    const durationMs = words.length > 1 ? parseSceneDuration(words[1]!) : null;
    if (!SCENE_ANIM_TARGETS.has(property) || durationMs === null) {
      diag?.({ code: "malformed-animation", message: `transition entry "${text}" is not "<property> <duration> [easing] [delay]" — skipped` });
      continue;
    }
    let easing: SceneEasing = parseSceneEasing("", undefined);
    let delayMs = 0;
    let bad = false;
    for (const word of words.slice(2)) {
      const asDelay = parseSceneDuration(word);
      if (asDelay !== null) { delayMs = asDelay; continue; }
      let easingBad = false;
      easing = parseSceneEasing(word, () => { easingBad = true; });
      if (easingBad) { bad = true; break; }
    }
    if (bad) {
      diag?.({ code: "malformed-animation", message: `transition entry "${text}" is not "<property> <duration> [easing] [delay]" — skipped` });
      continue;
    }
    out.push({ property: property as SceneAnimTarget, durationMs, easing, delayMs });
  }
  return out;
}

/** one in-flight retarget: rendered glides from `from` toward `to`; startMs is the
 *  base-change instant */
export type SceneTransitionState = { from: number[]; to: number[]; startMs: number };

/** THE RETARGET LAW, pure: when the base changes, the caller builds a fresh state with
 *  `from` = the CURRENT RENDERED value (mid-flight or at rest — never snap, never
 *  queue) and `to` = the new base. During the entry's delay the rendered value HOLDS
 *  `from` (already overriding); then it eases to `to`. done = the clip completed (the
 *  rendered value equals base again — the override retires). */
export function sceneTransitionValue(
  entry: SceneTransitionEntry, state: SceneTransitionState, nowMs: number,
): { value: number[]; done: boolean } {
  const t = nowMs - state.startMs;
  if (t < entry.delayMs) return { value: [...state.from], done: false };
  const clip = sceneClipMs(entry.easing, entry.durationMs);
  const elapsed = t - entry.delayMs;
  if (clip <= 0 || elapsed >= clip) return { value: [...state.to], done: true };
  const p = sceneEasingProgress(entry.easing, elapsed, entry.durationMs);
  return { value: lerpComponents(state.from, state.to, p), done: false };
}
