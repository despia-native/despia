//
//  gestures.ts - the U02 gesture family: the renderer-neutral PURE CORE plus the web
//  adapter that feeds it Pointer Events.
//
//  The split is the tooltip one (input/tooltip.json): everything a platform cannot
//  disagree about - velocity derivation, the slop that separates a tap from a drag,
//  swipe classification, transform accumulation, the axis claim, and the COMPOSITION
//  resolver behind `gesture=` / `gestureAxis=` - lives in the pure half and is gated by
//  OpenSource/Conformance/input/gestures.json, which the Kotlin (StackGestures.kt) and
//  Swift (StackGestures.swift) twins execute verbatim. The platform half owns only what
//  is genuinely platform: raw event delivery, pointer identity, hover capability, and
//  the touch-action declaration.
//
//  Units are density-independent (CSS px here, points on Apple targets, dp on Android)
//  and velocities are units per SECOND. The phase vocabulary is the shipped on:drag one -
//  start | move | end - and a cancelled gesture delivers phase "end", already the
//  declared cross-renderer law for on:drag.
//
//  Article 7: a gesture whose input does not exist on a surface never fires there and
//  never degrades into a fake - GESTURE_DEGRADATION is that promise as data, diffed by
//  all three runners.
//

import type { XmlNode } from "@despia/compiler/xml";
import type { ElementApi } from "./elements.ts";

// MARK: - constants (the corpus pins every one of these)

export const TAP_SLOP = 10;
export const AXIS_SLOP = 10;
export const SWIPE_MIN_DISTANCE = 24;
export const SWIPE_MIN_VELOCITY = 300;
export const VELOCITY_WINDOW_MS = 100;
export const VELOCITY_SAMPLES = 3;
export const PINCH_SLOP = 0.05;
export const ROTATE_SLOP = 0.087;

/** Which continuous recognizer wins an exclusive contest, most specific first. */
export const GESTURE_PRECEDENCE = ["pinch", "rotate", "pan", "scroll", "swipe", "longPress", "tap"] as const;
/** Recognizers that hold the touch for a while, and therefore compete with each other. */
export const CONTINUOUS_KINDS: ReadonlySet<string> = new Set(["pinch", "rotate", "pan", "scroll"]);
/** Recognizers an axis claim can eliminate. */
export const DIRECTIONAL_KINDS: ReadonlySet<string> = new Set(["pan", "scroll", "swipe"]);

export type GesturePhase = "start" | "move" | "end";
export type GestureAxis = "x" | "y" | "both";
export type GestureComposition = "exclusive" | "simultaneous" | "defer";

/** Article 7 as data: what each gesture needs, and what must exist when it is absent. */
export const GESTURE_DEGRADATION: ReadonlyArray<{
  gesture: string; requires: string; whenAbsent: string; alternative: string;
}> = [
  { gesture: "pinch", requires: "multiTouch", whenAbsent: "never-fires",
    alternative: "scroll zoom= bounds, an on:adjust step, or explicit zoom controls" },
  { gesture: "rotate", requires: "multiTouch", whenAbsent: "never-fires",
    alternative: "an on:adjust step or explicit rotate controls" },
  { gesture: "swipe", requires: "touch", whenAbsent: "never-fires",
    alternative: "a visible control for the same action, never swipe-only" },
  { gesture: "hover", requires: "hoverPointer", whenAbsent: "never-fires",
    alternative: "content is never gated behind hover - the same content on tap or in place" },
  { gesture: "press", requires: "pointer", whenAbsent: "never-fires",
    alternative: "on:tap keeps working; press state is decoration" },
  { gesture: "drag", requires: "pointer", whenAbsent: "never-fires",
    alternative: "on:adjust plus a11yValue, which the linter requires anyway" },
];

// MARK: - velocity

export type Sample1D = { t: number; value: number };
export type Sample2D = { t: number; x: number; y: number };

/**
 * The ONE velocity derivation every gesture uses. Weighted moving average over the
 * samples inside the last VELOCITY_WINDOW_MS, capped at VELOCITY_SAMPLES, with the
 * oldest surviving pair weighted 1 and each newer pair one more. A pair whose dt is not
 * positive is DROPPED (never a divide by zero, never Infinity) while still consuming its
 * recency weight; fewer than two usable samples is 0.
 */
export function velocity1D(samples: readonly Sample1D[]): number {
  if (samples.length < 2) return 0;
  const lastT = samples[samples.length - 1]!.t;
  const inWindow = samples.filter((s) => lastT - s.t <= VELOCITY_WINDOW_MS);
  const kept = inWindow.slice(-VELOCITY_SAMPLES);
  if (kept.length < 2) return 0;
  let total = 0, weightTotal = 0, weight = 0;
  for (let i = 0; i < kept.length - 1; i++) {
    const a = kept[i]!, b = kept[i + 1]!;
    const dt = b.t - a.t;
    weight += 1;
    if (dt <= 0) continue;
    total += weight * ((b.value - a.value) / (dt / 1000));
    weightTotal += weight;
  }
  return weightTotal === 0 ? 0 : total / weightTotal;
}

/** velocity1D per axis - no second formula, so on:drag and the swipe gate cannot drift. */
export function velocity2D(samples: readonly Sample2D[]): { vx: number; vy: number } {
  return {
    vx: velocity1D(samples.map((s) => ({ t: s.t, value: s.x }))),
    vy: velocity1D(samples.map((s) => ({ t: s.t, value: s.y }))),
  };
}

// MARK: - press (on:pressIn / on:pressOut) and the tap-vs-drag slop

export type PressAction = "pressIn" | "pressOut" | "tap";

/**
 * The custom press-state machine. pressOut ALWAYS balances pressIn (release,
 * cancellation, unmount); a press that ever exceeded the slop is a drag and never also
 * reports a tap; the slop is radial and one-way; one pointer owns the press.
 */
export class PressTracker {
  private active: string | null = null;
  private sx = 0;
  private sy = 0;
  private drag = false;
  private readonly slop: number;

  constructor(slop: number = TAP_SLOP) { this.slop = slop; }

  /** true once this press has travelled past the slop - it is a drag, not a tap. */
  get dragging(): boolean { return this.drag; }

  down(pointer: string, x: number, y: number): PressAction[] {
    if (this.active !== null) return [];
    this.active = pointer;
    this.sx = x; this.sy = y; this.drag = false;
    return ["pressIn"];
  }

  move(pointer: string, x: number, y: number): PressAction[] {
    if (this.active !== pointer || this.drag) return [];
    if (Math.hypot(x - this.sx, y - this.sy) > this.slop) this.drag = true;
    return [];
  }

  up(pointer: string, _x: number, _y: number): PressAction[] {
    if (this.active !== pointer) return [];
    this.active = null;
    return this.drag ? ["pressOut"] : ["pressOut", "tap"];
  }

  cancel(pointer: string): PressAction[] {
    if (this.active !== pointer) return [];
    this.active = null;
    return ["pressOut"];
  }

  unmount(): PressAction[] {
    if (this.active === null) return [];
    this.active = null;
    return ["pressOut"];
  }
}

// MARK: - hover motion (on:hover)

export type HoverEmission = { action: "hover" | "hoverEnd"; x: number; y: number };

/**
 * The POSITIONAL hover channel that complements the shipped on:hoverStart / on:hoverEnd
 * pair (input/hover.json owns pointer identity and the balanced pair). Only a
 * hover-capable source is ever tracked, so a touch screen never fires it; the enter IS
 * the first sample, the on:drag minimum-distance-0 rule.
 */
export class HoverMotion {
  private active = false;

  enter(hoverCapable: boolean, x: number, y: number): HoverEmission[] {
    if (!hoverCapable || this.active) return [];
    this.active = true;
    return [{ action: "hover", x, y }];
  }

  move(x: number, y: number): HoverEmission[] {
    return this.active ? [{ action: "hover", x, y }] : [];
  }

  leave(x: number, y: number): HoverEmission[] {
    if (!this.active) return [];
    this.active = false;
    return [{ action: "hoverEnd", x, y }];
  }

  unmount(): HoverEmission[] {
    if (!this.active) return [];
    this.active = false;
    return [{ action: "hoverEnd", x: 0, y: 0 }];
  }
}

// MARK: - swipe

export type SwipeResult = { direction: "left" | "right" | "up" | "down"; velocity: number; distance: number };

/**
 * Direction classification at the end of a pan. The DOMINANT axis wins and an exact
 * |dx| === |dy| diagonal breaks HORIZONTAL (the same tie-break claimAxis uses). Both
 * gates read the chosen axis: distance >= SWIPE_MIN_DISTANCE and |velocity| >=
 * SWIPE_MIN_VELOCITY, which is what makes a slow drag not a swipe. An axis claim of x or
 * y rejects the other axis outright.
 */
export function resolveSwipe(
  dx: number, dy: number, vx: number, vy: number, axis: GestureAxis | string = "both",
): SwipeResult | null {
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const directionAxis = horizontal ? "x" : "y";
  if ((axis === "x" || axis === "y") && axis !== directionAxis) return null;
  const distance = horizontal ? Math.abs(dx) : Math.abs(dy);
  const velocity = horizontal ? Math.abs(vx) : Math.abs(vy);
  if (distance === 0) return null;
  if (distance < SWIPE_MIN_DISTANCE || velocity < SWIPE_MIN_VELOCITY) return null;
  const direction = horizontal ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
  return { direction, velocity, distance };
}

// MARK: - the axis claim

export type AxisClaim = "pending" | "claimed" | "rejected";

/**
 * `gestureAxis=` as the RECOGNIZER-LEVEL claim, not a direction check in the handler:
 * inside the slop nothing is claimed yet (an ancestor scroll may still take the touch);
 * past it an x or y claimer either claims the touch or FAILS it back to the ancestor.
 * This is the iOS pan-subclass technique and the web touch-action declaration, expressed
 * once. Ties break horizontal, exactly as resolveSwipe.
 */
export function claimAxis(axis: GestureAxis | string, dx: number, dy: number, slop: number = AXIS_SLOP): AxisClaim {
  if (Math.hypot(dx, dy) <= slop) return "pending";
  if (axis !== "x" && axis !== "y") return "claimed";
  if (axis === "x") return Math.abs(dx) >= Math.abs(dy) ? "claimed" : "rejected";
  return Math.abs(dy) > Math.abs(dx) ? "claimed" : "rejected";
}

// MARK: - transform (on:pinch + on:rotate)

export type TransformPoint = { id: string; x: number; y: number };
export type TransformEmission = {
  phase: GesturePhase;
  scale: number;
  rotation: number;
  focusX: number;
  focusY: number;
  scaleVelocity: number;
  rotationVelocity: number;
};

/** Normalize into the half-open turn - exclusive at -pi, inclusive at +pi: the wrap that makes rotation continuous. */
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * The ONE tracker behind on:pinch and on:rotate. Each update carries the FULL set of
 * pointers currently down and the two lowest-sorted ids define the span. The gesture
 * spans from the first two-pointer engagement until the LAST pointer lifts: dropping to
 * one finger SUSPENDS (values hold, nothing emitted) and a returning finger re-baselines
 * against the held accumulation, which is why the scale never jumps at a finger change.
 * Rotation accumulates normalized frame deltas, so it is continuous across the +-pi wrap
 * and keeps growing past a full turn. A re-baseline never emits; start fires the first
 * frame past PINCH_SLOP or ROTATE_SLOP; end fires once, with the last values.
 */
export class TransformTracker {
  private engaged = false;
  private spanning = false;
  private started = false;
  private accumScale = 1;
  private scale = 1;
  private rotation = 0;
  private focusX = 0;
  private focusY = 0;
  private baseDistance = 0;
  private lastAngle = 0;
  private baseIds: string | null = null;
  private samples: Array<{ t: number; scale: number; rotation: number }> = [];
  private readonly pinchSlop: number;
  private readonly rotateSlop: number;

  constructor(pinchSlop: number = PINCH_SLOP, rotateSlop: number = ROTATE_SLOP) {
    this.pinchSlop = pinchSlop;
    this.rotateSlop = rotateSlop;
  }

  update(t: number, points: readonly TransformPoint[]): TransformEmission[] {
    const pts = [...points].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (pts.length >= 2) {
      const a = pts[0]!, b = pts[1]!;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      this.focusX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
      this.focusY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
      const ids = `${a.id} ${b.id}`;
      if (!this.spanning || ids !== this.baseIds) {
        this.accumScale = this.scale;               // fold the finished span in
        this.baseDistance = distance;
        this.lastAngle = angle;
        this.baseIds = ids;
        this.spanning = true;
        this.engaged = true;
        this.samples.push({ t, scale: this.scale, rotation: this.rotation });
        return [];                                   // a re-baseline never emits
      }
      const span = this.baseDistance > 0 ? distance / this.baseDistance : 1;
      this.scale = this.accumScale * span;
      this.rotation += normalizeAngle(angle - this.lastAngle);
      this.lastAngle = angle;
      this.samples.push({ t, scale: this.scale, rotation: this.rotation });
      if (!this.started) {
        if (Math.abs(this.scale - 1) > this.pinchSlop || Math.abs(this.rotation) > this.rotateSlop) {
          this.started = true;
          return [this.emission("start")];
        }
        return [];
      }
      return [this.emission("move")];
    }
    if (pts.length === 1 && this.engaged) {
      this.accumScale = this.scale;                  // suspend: hold, wait for the second finger
      this.spanning = false;
      this.baseIds = null;
      return [];
    }
    if (pts.length === 0) {
      const out = this.started ? [this.emission("end")] : [];
      this.reset();
      return out;
    }
    return [];
  }

  /** An ancestor stole the touch: end at the last values, exactly like the final lift. */
  cancel(): TransformEmission[] {
    const out = this.started ? [this.emission("end")] : [];
    this.reset();
    return out;
  }

  private reset(): void {
    this.engaged = false; this.spanning = false; this.started = false;
    this.accumScale = 1; this.scale = 1; this.rotation = 0;
    this.focusX = 0; this.focusY = 0;
    this.baseDistance = 0; this.lastAngle = 0; this.baseIds = null;
    this.samples = [];
  }

  private emission(phase: GesturePhase): TransformEmission {
    return {
      phase,
      scale: this.scale,
      rotation: this.rotation,
      focusX: this.focusX,
      focusY: this.focusY,
      scaleVelocity: velocity1D(this.samples.map((s) => ({ t: s.t, value: s.scale }))),
      rotationVelocity: velocity1D(this.samples.map((s) => ({ t: s.t, value: s.rotation }))),
    };
  }
}

// MARK: - the on:drag payload (additive)

export type DragPayload = {
  x: number; y: number; width: number; height: number;
  fraction: number; fractionY: number;
  dx: number; dy: number;
  translationX: number; translationY: number;
  velocityX: number; velocityY: number;
  phase: string;
};

/**
 * Every shipped key keeps its exact meaning and value; translationX / translationY are
 * the named twins of dx / dy (the vocabulary authors expect) and velocityX / velocityY
 * come from the same velocity1D fold. width and height floor at 1, so a zero-sized
 * element never divides by zero.
 */
export function dragPayload(input: {
  width: number; height: number; x: number; y: number;
  startX: number; startY: number; samples: readonly Sample2D[]; phase: string;
}): DragPayload {
  const w = Math.max(input.width, 1);
  const h = Math.max(input.height, 1);
  const { vx, vy } = velocity2D(input.samples);
  const tx = input.x - input.startX;
  const ty = input.y - input.startY;
  return {
    x: input.x, y: input.y, width: w, height: h,
    fraction: Math.min(Math.max(input.x / w, 0), 1),
    fractionY: Math.min(Math.max(input.y / h, 0), 1),
    dx: tx, dy: ty,
    translationX: tx, translationY: ty,
    velocityX: vx, velocityY: vy,
    phase: input.phase,
  };
}

// MARK: - the composition resolver

export type GestureNode = {
  id: string;
  recognizers: readonly string[];
  gesture?: GestureComposition | string;
  axis?: GestureAxis | string;
};
export type GestureAttempt = {
  kinds: readonly string[];
  axis?: GestureAxis | "none" | string;
  claimedBy?: string;
};
export type BlockReason = "axis" | "claimed" | "deferred" | "exclusive";
export type CompositionResult = {
  fire: Array<{ node: string; kind: string }>;
  blocked: Array<{ node: string; kind: string; reason: BlockReason }>;
};

function precedenceIndex(kind: string): number {
  const index = (GESTURE_PRECEDENCE as readonly string[]).indexOf(kind);
  return index < 0 ? GESTURE_PRECEDENCE.length : index;
}

/**
 * Given the ancestor chain (root first) and one attempt, which recognizers may fire
 * together. The attempt is what the RAW input physically matches - the adapter decides
 * that, this decides composition. In order: an axis claim eliminates a directional
 * recognizer running on the other axis; an outstanding claim by one node cancels every
 * other node's recognizers; a `defer` node yields while any ANCESTOR candidate is still
 * viable; the DEEPEST surviving node owns the touch and an ancestor keeps its
 * recognizers only if it declared `simultaneous`; inside a node the continuous
 * recognizers are exclusive by precedence unless the node declared `simultaneous`, while
 * discrete ones never compete.
 */
export function resolveComposition(tree: readonly GestureNode[], attempt: GestureAttempt): CompositionResult {
  const kinds = new Set(attempt.kinds);
  const attemptAxis = attempt.axis ?? "none";
  const claimedBy = attempt.claimedBy;

  type Candidate = { index: number; node: string; kind: string; blocked: BlockReason | null };
  const candidates: Candidate[] = [];
  tree.forEach((node, index) => {
    const nodeKinds = node.recognizers.filter((k) => kinds.has(k));
    nodeKinds.sort((a, b) => (precedenceIndex(a) - precedenceIndex(b)) || (a < b ? -1 : a > b ? 1 : 0));
    for (const kind of nodeKinds) candidates.push({ index, node: node.id, kind, blocked: null });
  });
  const alive = (c: Candidate): boolean => c.blocked === null;

  for (const c of candidates) {
    const axis = tree[c.index]!.axis ?? "both";
    if (DIRECTIONAL_KINDS.has(c.kind) && (axis === "x" || axis === "y")
      && (attemptAxis === "x" || attemptAxis === "y") && axis !== attemptAxis) {
      c.blocked = "axis";
    }
  }

  if (claimedBy !== undefined) {
    for (const c of candidates) if (alive(c) && c.node !== claimedBy) c.blocked = "claimed";
  }

  tree.forEach((node, index) => {
    if ((node.gesture ?? "exclusive") !== "defer") return;
    if (!candidates.some((c) => alive(c) && c.index < index)) return;
    for (const c of candidates) if (c.index === index && alive(c)) c.blocked = "deferred";
  });

  let winner = -1;
  for (const c of candidates) if (alive(c) && c.index > winner) winner = c.index;
  if (winner < 0) {
    return {
      fire: [],
      blocked: candidates.map((c) => ({ node: c.node, kind: c.kind, reason: c.blocked as BlockReason })),
    };
  }
  for (const c of candidates) {
    if (alive(c) && c.index !== winner && (tree[c.index]!.gesture ?? "exclusive") !== "simultaneous") {
      c.blocked = "exclusive";
    }
  }

  tree.forEach((node, index) => {
    if ((node.gesture ?? "exclusive") === "simultaneous") return;
    const continuous = candidates.filter((c) => c.index === index && alive(c) && CONTINUOUS_KINDS.has(c.kind));
    for (const c of continuous.slice(1)) c.blocked = "exclusive";
  });

  return {
    fire: candidates.filter(alive).map((c) => ({ node: c.node, kind: c.kind })),
    blocked: candidates.filter((c) => !alive(c))
      .map((c) => ({ node: c.node, kind: c.kind, reason: c.blocked as BlockReason })),
  };
}

// MARK: - the web adapter

/** `gestureAxis=` maps 1:1 onto touch-action: claiming x leaves the browser pan-y, and
 *  claiming both takes the whole surface. The declaration IS the claim on this renderer. */
export function touchActionFor(axis: GestureAxis | string | undefined): string {
  if (axis === "x") return "pan-y";
  if (axis === "y") return "pan-x";
  return "none";
}

function hoverCapablePointer(e: PointerEvent): boolean {
  if (e.pointerType === "touch") return false;
  try {
    return typeof matchMedia === "function" ? matchMedia("(any-hover: hover)").matches : true;
  } catch {
    return true;
  }
}

const GESTURE_HANDLERS = [
  "pinch", "pinchEnd", "rotate", "rotateEnd", "swipe", "hover", "pressIn", "pressOut",
] as const;

/** Does this element author any of the U02 family? (the call site's cheap guard) */
export function hasGestureFamily(api: ElementApi): boolean {
  return GESTURE_HANDLERS.some((name) => api.hasHandler(name));
}

/**
 * Wire on:pinch / on:pinchEnd, on:rotate / on:rotateEnd, on:swipe, on:hover, and
 * on:pressIn / on:pressOut onto a real element. Pointer Events feed the pure core; only
 * pointer identity, hover capability and the touch-action declaration are decided here.
 * The gesture= composition word rides the DOM's own capture semantics: `simultaneous`
 * leaves ancestor scrolling alone, `exclusive` (the default) takes the pointer, `defer`
 * keeps the browser's native panning on the claimed axis until the recognizer commits.
 */
export function wireGestureFamily(el: HTMLElement, node: XmlNode, api: ElementApi): () => void {
  const axis = node.attrs["gestureAxis"] ?? "both";
  const composition = node.attrs["gesture"] ?? "exclusive";
  const wantsTransform = api.hasHandler("pinch") || api.hasHandler("pinchEnd")
    || api.hasHandler("rotate") || api.hasHandler("rotateEnd");
  const wantsSwipe = api.hasHandler("swipe");
  const wantsPress = api.hasHandler("pressIn") || api.hasHandler("pressOut");
  const wantsHover = api.hasHandler("hover");

  if (wantsTransform || wantsSwipe) {
    // `defer` keeps the browser's panning until the recognizer commits, which is exactly
    // the ancestor-first rule the resolver states; every other word claims the axis now.
    el.style.touchAction = composition === "defer" ? "auto" : touchActionFor(axis);
  }

  const transform = new TransformTracker();
  const press = new PressTracker();
  const hover = new HoverMotion();
  const active = new Map<number, TransformPoint>();
  let samples: Sample2D[] = [];
  let swipeId: number | null = null;
  let sx = 0, sy = 0;

  const emitTransform = (out: TransformEmission[]): void => {
    for (const e of out) {
      const pinchEnd = e.phase === "end" && api.hasHandler("pinchEnd");
      const rotateEnd = e.phase === "end" && api.hasHandler("rotateEnd");
      api.handler(pinchEnd ? "pinchEnd" : "pinch", {
        scale: e.scale, velocity: e.scaleVelocity, focusX: e.focusX, focusY: e.focusY, phase: e.phase,
      });
      api.handler(rotateEnd ? "rotateEnd" : "rotate", {
        rotation: e.rotation, velocity: e.rotationVelocity, phase: e.phase,
      });
    }
  };
  const emitPress = (out: PressAction[], e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    const point = { x: e.clientX - r.left, y: e.clientY - r.top };
    for (const action of out) if (action !== "tap") api.handler(action, point);
  };
  const emitHover = (out: HoverEmission[]): void => {
    for (const e of out) api.handler(e.action, { x: e.x, y: e.y });
  };

  const down = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (wantsPress) emitPress(press.down(String(e.pointerId), e.clientX, e.clientY), e);
    if (wantsTransform) {
      active.set(e.pointerId, { id: String(e.pointerId), x: e.clientX, y: e.clientY });
      emitTransform(transform.update(e.timeStamp, [...active.values()]));
    }
    if (wantsSwipe && swipeId === null) {
      swipeId = e.pointerId; sx = e.clientX; sy = e.clientY;
      samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
    }
    try { el.setPointerCapture(e.pointerId); } catch { /* foreign or detached pointer */ }
  };
  const move = (e: PointerEvent): void => {
    if (wantsPress) press.move(String(e.pointerId), e.clientX, e.clientY);
    if (wantsTransform && active.has(e.pointerId)) {
      active.set(e.pointerId, { id: String(e.pointerId), x: e.clientX, y: e.clientY });
      emitTransform(transform.update(e.timeStamp, [...active.values()]));
    }
    if (wantsSwipe && e.pointerId === swipeId) samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
  };
  const up = (e: PointerEvent, cancelled: boolean): void => {
    if (wantsPress) {
      emitPress(cancelled ? press.cancel(String(e.pointerId)) : press.up(String(e.pointerId), e.clientX, e.clientY), e);
    }
    if (wantsTransform && active.delete(e.pointerId)) {
      emitTransform(cancelled ? transform.cancel() : transform.update(e.timeStamp, [...active.values()]));
    }
    if (wantsSwipe && e.pointerId === swipeId) {
      swipeId = null;
      if (!cancelled) {
        samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
        const { vx, vy } = velocity2D(samples);
        const swipe = resolveSwipe(e.clientX - sx, e.clientY - sy, vx, vy, axis);
        if (swipe !== null) api.handler("swipe", { ...swipe });
      }
      samples = [];
    }
  };
  const enter = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    emitHover(hover.enter(hoverCapablePointer(e), e.clientX - r.left, e.clientY - r.top));
  };
  const hoverMove = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    emitHover(hover.move(e.clientX - r.left, e.clientY - r.top));
  };
  const leave = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    emitHover(hover.leave(e.clientX - r.left, e.clientY - r.top));
  };

  const onDown = (e: PointerEvent): void => down(e);
  const onMove = (e: PointerEvent): void => move(e);
  const onUp = (e: PointerEvent): void => up(e, false);
  const onCancel = (e: PointerEvent): void => up(e, true);

  if (wantsTransform || wantsSwipe || wantsPress) {
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  }
  if (wantsHover) {
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointermove", hoverMove);
    el.addEventListener("pointerleave", leave);
  }

  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("pointerenter", enter);
    el.removeEventListener("pointermove", hoverMove);
    el.removeEventListener("pointerleave", leave);
    emitHover(hover.unmount());
    for (const action of press.unmount()) if (action !== "tap") api.handler(action, { x: 0, y: 0 });
    emitTransform(transform.cancel());
  };
}
