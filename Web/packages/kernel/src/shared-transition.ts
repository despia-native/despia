//
//  shared-transition.ts — the shared-element (`shared=`) transition PURE CORE: the matching
//  algorithm, the interpolation schedule and the interruption/reversal state machine. The law
//  is the corpus, OpenSource/Conformance/router/shared.json (parity/U03-shared-transitions.md);
//  the Kotlin twin is :core StackSharedTransition.kt and the Swift twin is
//  Engine/iOS/StackSharedTransition.swift.
//
//  Everything platform-shaped lives OUTSIDE this file. iOS flies the pairs under
//  UIViewControllerAnimatedTransitioning with a snapshot layer driven by a
//  UIViewPropertyAnimator; Android places them inside a shared LookaheadScope; web sets
//  `view-transition-name` where the View Transitions API exists and runs a WAAPI FLIP
//  otherwise. All three ask THIS file which ids pair, where the pair is at a given progress,
//  and what an interruption does — which is why one corpus can judge three renderers.
//
//  THE TWO LAWS THAT ARE EASY TO GET WRONG, both pinned here rather than per platform:
//    • an UNMATCHED id is not an error. It takes the ordinary frame transition, silently.
//    • an UNREALISED destination (a virtualised row, an image still loading) animates from the
//      SOURCE geometry to the SOURCE geometry and cross-fades. Animating to the zero rect a
//      not-yet-laid-out node reports is what makes the naive implementation look like the
//      image collapsing into nothing.
//

/** The three shared modes. `move` is the default; `crossfade` is what reduced motion and an
 *  unrealised destination downgrade to; `clip` is for text that changes size, where scaling
 *  the glyphs would distort them. */
export const SHARED_MODES: readonly string[] = ["move", "crossfade", "clip"];

/** `move` keeps the source snapshot for the whole flight and fades the destination in over the
 *  final third. Pinned so the three renderers hand off at the same instant. */
export const SHARED_HANDOFF_START = 2 / 3;

/** Accessibility focus moves to the DESTINATION frame at transition START, not end, so a
 *  VoiceOver user is never narrating a moving snapshot. A constant, because there is nothing
 *  to decide: the law has no parameters and no opt-out. */
export const SHARED_A11Y_FOCUS = { target: "destination", at: "start" } as const;

export interface SharedRect { x: number; y: number; width: number; height: number }

/** One `shared=` element as its renderer measured it. `laid` is the renderer saying the node
 *  has been through a layout pass; `order`/`mode`/`anim` are null when the author did not
 *  declare them, which is what makes "the destination declares, the source is the fallback"
 *  expressible. */
export interface SharedElement {
  id: string;
  frame: SharedRect;
  radius?: number;
  opacity?: number;
  contentMode?: string;
  laid?: boolean;
  order?: number | null;
  mode?: string | null;
  anim?: string | null;
}

/** One end of a pair, fully resolved — no optionals left for a renderer to guess at. */
export interface SharedGeometry {
  x: number; y: number; width: number; height: number;
  radius: number; opacity: number; contentMode: string;
}

export interface SharedPair {
  id: string;
  order: number;
  mode: string;
  /** the resolved curve word, or null to inherit whatever the frame transition uses */
  anim: string | null;
  /** true when the destination was not laid out: `to` is a copy of `from` and the mode is crossfade */
  deferred: boolean;
  from: SharedGeometry;
  to: SharedGeometry;
}

export interface SharedMatch {
  pairs: SharedPair[];
  /** ids the outgoing frame declared that nothing on the incoming frame answers */
  unmatchedSource: string[];
  unmatchedDestination: string[];
  /** ids declared more than once within ONE frame — a lint error at author time, resolved to
   *  the first occurrence here so the runtime is deterministic rather than platform-dependent */
  duplicates: string[];
}

export interface SharedMatchOptions {
  reducedMotion?: boolean;
  /** the frame transition's own `anim`, the floor a pair inherits when neither end declares one */
  frameAnim?: string | null;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0;
}

function geometry(element: SharedElement): SharedGeometry {
  return {
    x: round6(element.frame.x),
    y: round6(element.frame.y),
    width: round6(element.frame.width),
    height: round6(element.frame.height),
    radius: round6(element.radius ?? 0),
    opacity: round6(element.opacity ?? 1),
    contentMode: element.contentMode ?? "fill",
  };
}

/** Has the destination actually been laid out? An explicit `laid: false` says no; so does a
 *  zero width or height, which is what a virtualised row reports before it is measured. */
function realised(element: SharedElement): boolean {
  if (element.laid === false) return false;
  return element.frame.width > 0 && element.frame.height > 0;
}

/** ONE inheritance rule for `sharedMode`, `sharedAnim` and `sharedOrder`: the arriving screen
 *  decides, the outgoing screen fills the gap, and the caller's floor is the last resort. */
function inherit<T>(destination: T | null | undefined, source: T | null | undefined, floor: T): T {
  if (destination !== null && destination !== undefined) return destination;
  if (source !== null && source !== undefined) return source;
  return floor;
}

/** First occurrence in document order wins; every id seen twice is reported. */
function indexSide(elements: readonly SharedElement[]): {
  first: Map<string, { index: number; element: SharedElement }>;
  duplicates: string[];
  order: string[];
} {
  const first = new Map<string, { index: number; element: SharedElement }>();
  const duplicates: string[] = [];
  const order: string[] = [];
  elements.forEach((element, index) => {
    if (first.has(element.id)) {
      if (!duplicates.includes(element.id)) duplicates.push(element.id);
      return;
    }
    first.set(element.id, { index, element });
    order.push(element.id);
  });
  return { first, duplicates, order };
}

/**
 * Pair the `shared` ids across the outgoing and incoming frames.
 *
 * Collect the ids on each side (first occurrence wins), intersect, order by `sharedOrder` then
 * DESTINATION document order, and resolve each pair's mode/anim/geometry. Everything outside
 * the intersection takes the ordinary frame transition — reported, never thrown.
 */
export function matchSharedElements(
  source: readonly SharedElement[],
  destination: readonly SharedElement[],
  options: SharedMatchOptions = {},
): SharedMatch {
  const reducedMotion = options.reducedMotion === true;
  const frameAnim = options.frameAnim ?? null;
  const src = indexSide(source);
  const dst = indexSide(destination);

  const ordered: { pair: SharedPair; documentIndex: number }[] = [];
  for (const id of dst.order) {
    const sourceEntry = src.first.get(id);
    if (sourceEntry === undefined) continue;
    const destinationEntry = dst.first.get(id)!;
    const deferred = !realised(destinationEntry.element);
    const from = geometry(sourceEntry.element);
    const to = deferred ? { ...from } : geometry(destinationEntry.element);
    let mode = inherit(destinationEntry.element.mode, sourceEntry.element.mode, "move");
    if (!SHARED_MODES.includes(mode)) mode = "move";
    if (deferred || reducedMotion) mode = "crossfade";
    ordered.push({
      documentIndex: destinationEntry.index,
      pair: {
        id,
        order: inherit(destinationEntry.element.order, sourceEntry.element.order, 0),
        mode,
        anim: inherit(destinationEntry.element.anim, sourceEntry.element.anim, frameAnim),
        deferred,
        from,
        to,
      },
    });
  }
  ordered.sort((a, b) => (a.pair.order - b.pair.order) || (a.documentIndex - b.documentIndex));
  const pairs = ordered.map((entry) => entry.pair);
  const paired = new Set(pairs.map((pair) => pair.id));

  return {
    pairs,
    unmatchedSource: src.order.filter((id) => !paired.has(id)),
    unmatchedDestination: dst.order.filter((id) => !paired.has(id)),
    duplicates: [...new Set([...src.duplicates, ...dst.duplicates])].sort(),
  };
}

/** The pair's state at one instant. `sourceOpacity`/`destinationOpacity` are the two snapshots'
 *  weights INSIDE the flying layer; `alpha` is the layer's own opacity. `scaleContent` false is
 *  `clip`: the frame animates, the content does not stretch with it. */
export interface SharedSample {
  x: number; y: number; width: number; height: number;
  radius: number; alpha: number;
  sourceOpacity: number; destinationOpacity: number;
  contentMode: string; scaleContent: boolean;
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;   // also catches NaN
  return value > 1 ? 1 : value;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/**
 * Where the pair is at `progress` (0 = fully at the source, 1 = fully at the destination).
 * Out-of-range progress clamps rather than overshooting — an interruption can hand this
 * function a value past either end while a spring is still settling.
 */
export function sampleSharedPair(pair: SharedPair, progress: number): SharedSample {
  const p = clamp01(progress);
  const { from, to } = pair;
  const sourceOpacity = pair.mode === "move" ? 1 : 1 - p;
  const destinationOpacity = pair.mode === "move"
    ? clamp01((p - SHARED_HANDOFF_START) * 3)
    : p;
  return {
    x: round6(lerp(from.x, to.x, p)),
    y: round6(lerp(from.y, to.y, p)),
    width: round6(lerp(from.width, to.width, p)),
    height: round6(lerp(from.height, to.height, p)),
    radius: round6(lerp(from.radius, to.radius, p)),
    alpha: round6(lerp(from.opacity, to.opacity, p)),
    sourceOpacity: round6(sourceOpacity),
    destinationOpacity: round6(destinationOpacity),
    // A discrete value cannot interpolate; it switches at the midpoint, where the aspect
    // mismatch between the two content modes is smallest.
    contentMode: p < 0.5 ? from.contentMode : to.contentMode,
    scaleContent: pair.mode !== "clip",
  };
}

export type SharedState = "idle" | "running" | "interactive" | "settled";
export type SharedDirection = "forward" | "reverse";
export type SharedOutcome = "completed" | "reversed" | null;

export interface SharedMachineSnapshot {
  state: SharedState;
  direction: SharedDirection;
  progress: number;
  target: number;
  /** the distance still to travel — a reversal costs what is LEFT, never a full replay */
  remaining: number;
  outcome: SharedOutcome;
}

/**
 * The interruption/reversal state machine — the one thing that separates a real shared-element
 * implementation from a demo.
 *
 * `progress` is always measured toward the DESTINATION: 0 is the source frame, 1 the
 * destination, regardless of which way the transition is travelling. An interruption
 * (`interrupt`) adopts the transition AT ITS CURRENT PROGRESS and flips the direction; it never
 * restarts at 1 and never snaps to 0. The release then commits (target 0, the back-swipe won)
 * or cancels (target 1, the push resumes), and the settle travels only `remaining`.
 *
 * Platform mapping: iOS drives this from a UIPercentDrivenInteractiveTransition against a
 * UIViewPropertyAnimator (a `UIView.animate` block cannot be reversed mid-flight, which is
 * exactly how an implementation ends up snapping); Android from the predictive-back progress
 * callbacks against the same Animatable the router pose already uses; web from the pointer
 * stream against a paused WAAPI animation, whose `currentTime` is settable.
 */
export class SharedTransitionMachine {
  #state: SharedState = "idle";
  #direction: SharedDirection = "forward";
  #progress = 0;
  #target = 1;
  #outcome: SharedOutcome = null;
  #interrupted = false;

  get state(): SharedState { return this.#state; }
  get direction(): SharedDirection { return this.#direction; }
  get progress(): number { return round6(this.#progress); }
  get target(): number { return round6(this.#target); }
  get outcome(): SharedOutcome { return this.#outcome; }
  /** true once a gesture has taken this transition over — the renderer must keep its animator
   *  interruptible for the rest of the flight rather than restoring a fire-and-forget curve */
  get interrupted(): boolean { return this.#interrupted; }

  snapshot(): SharedMachineSnapshot {
    return {
      state: this.#state,
      direction: this.#direction,
      progress: round6(this.#progress),
      target: round6(this.#target),
      remaining: round6(Math.abs(this.#target - this.#progress)),
      outcome: this.#outcome,
    };
  }

  /** Start a push (`forward`, from the source) or a pop (`reverse`, from the destination). */
  begin(direction: SharedDirection): SharedMachineSnapshot {
    this.#state = "running";
    this.#direction = direction;
    this.#progress = direction === "forward" ? 0 : 1;
    this.#target = direction === "forward" ? 1 : 0;
    this.#outcome = null;
    this.#interrupted = false;
    return this.snapshot();
  }

  /** The animator reporting where it is. Ignored while a gesture owns the transition. */
  tick(progress: number): SharedMachineSnapshot {
    if (this.#state === "running") this.#progress = clamp01(progress);
    return this.snapshot();
  }

  /** A gesture takes the transition over at `progress`. A settled transition is NOT resurrected. */
  interrupt(progress: number): SharedMachineSnapshot {
    if (this.#state === "running" || this.#state === "interactive") {
      this.#state = "interactive";
      this.#direction = "reverse";
      this.#progress = clamp01(progress);
      this.#target = 0;
      this.#interrupted = true;
    }
    return this.snapshot();
  }

  /** The finger moving, as an ABSOLUTE progress (the renderer owns the pixels→progress map). */
  drag(progress: number): SharedMachineSnapshot {
    if (this.#state === "interactive") this.#progress = clamp01(progress);
    return this.snapshot();
  }

  /** The finger lifting: commit the reversal, or cancel it and resume forward. */
  release(decision: "commit" | "cancel"): SharedMachineSnapshot {
    if (this.#state === "interactive") {
      const commit = decision === "commit";
      this.#direction = commit ? "reverse" : "forward";
      this.#target = commit ? 0 : 1;
      this.#state = "running";
    }
    return this.snapshot();
  }

  /** The animator reached its target. */
  settle(): SharedMachineSnapshot {
    if (this.#state === "running") {
      this.#progress = this.#target;
      this.#state = "settled";
      this.#outcome = this.#target === 0 ? "reversed" : "completed";
    }
    return this.snapshot();
  }
}
