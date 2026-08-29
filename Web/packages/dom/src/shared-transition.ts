//
//  shared-transition.ts — the WEB half of U03 shared element transitions
//  (parity/U03-shared-transitions.md). The DECISIONS all live in the platform-neutral core
//  (@despia/kernel shared-transition.ts, corpus OpenSource/Conformance/router/shared.json);
//  this file is the DOM plumbing: find the `shared=` nodes in a frame, measure them, fly a
//  layer between the two frames, and let a gesture take that flight over mid-air.
//
//  THE FLIGHT IS A FLIP, NOT A VIEW TRANSITION, whenever the transition can be interrupted.
//  `document.startViewTransition` gives the browser the whole animation and hands back only
//  `skipTransition()`; there is no way to drive its progress from a finger, so an
//  interruptible lane driven by it would SNAP on a back-swipe — the exact failure U03 exists
//  to rule out. So: View Transitions for a lane that cannot be interrupted (the crisper
//  element-identity handoff, and free reduced-motion handling), a WAAPI FLIP everywhere else,
//  and a typed absence when the browser has neither. Never a silent no-op.
//
//  The `shared`/`sharedMode`/`sharedAnim`/`sharedOrder` attributes reach the DOM as
//  `data-dsx-shared*` (stamped in mount.ts alongside `theme=`/`density=`), so this file reads
//  the rendered tree rather than the compiled one — which is the only place the real geometry
//  exists.
//
import {
  matchSharedElements, sampleSharedPair, SharedTransitionMachine,
  type SharedElement, type SharedPair,
} from "@despia/kernel";

/** What this browser can actually do. Reported, never assumed — U03's "typed absence, not a
 *  silent no-op": a lane that cannot fly the pair still runs the ordinary frame transition. */
export type SharedSupport = "view-transitions" | "flip" | "unsupported";

export function sharedSupport(): SharedSupport {
  if (typeof document === "undefined") return "unsupported";
  if (typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === "function") {
    return "view-transitions";
  }
  if (typeof Element !== "undefined" && typeof Element.prototype.animate === "function") return "flip";
  return "unsupported";
}

const SHARED_SELECTOR = "[data-dsx-shared]";

function numberAttr(el: HTMLElement, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function stringAttr(el: HTMLElement, name: string): string | null {
  const raw = el.getAttribute(name);
  return raw === null || raw.trim() === "" ? null : raw.trim();
}

/** `object-fit` is the web's content mode; the core only ever compares the two ends, so the
 *  vocabulary just has to be stable. */
function contentModeOf(style: CSSStyleDeclaration): string {
  const fit = style.objectFit;
  return fit === "" || fit === "fill" ? "fill" : fit;
}

function firstRadius(style: CSSStyleDeclaration): number {
  const value = Number.parseFloat(style.borderTopLeftRadius);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Every `shared=` node inside `root`, measured in the coordinate space of `origin` (the router
 * host), in DOCUMENT order — which is what the core's tie-break needs.
 *
 * A node the layout engine has not reached yet reports a zero rect; that is passed through
 * honestly as `laid: false` so the core can apply the unrealised-destination rule instead of
 * animating into nothing.
 */
export function collectSharedElements(root: HTMLElement, origin: HTMLElement): SharedElement[] {
  const base = origin.getBoundingClientRect();
  const out: SharedElement[] = [];
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(SHARED_SELECTOR))) {
    const id = stringAttr(node, "data-dsx-shared");
    if (id === null) continue;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    out.push({
      id,
      frame: { x: box.left - base.left, y: box.top - base.top, width: box.width, height: box.height },
      radius: firstRadius(style),
      opacity: Number.parseFloat(style.opacity) || (style.opacity === "0" ? 0 : 1),
      contentMode: contentModeOf(style),
      laid: box.width > 0 && box.height > 0,
      order: numberAttr(node, "data-dsx-shared-order"),
      mode: stringAttr(node, "data-dsx-shared-mode"),
      anim: stringAttr(node, "data-dsx-shared-anim"),
    });
  }
  return out;
}

/** The DOM nodes behind one pair, so the flight can hide the originals and clone them. */
interface Flown {
  pair: SharedPair;
  layer: HTMLElement;
  sourceNode: HTMLElement | null;
  destinationNode: HTMLElement | null;
  sourceClone: HTMLElement;
  destinationClone: HTMLElement | null;
}

function findShared(root: HTMLElement, id: string): HTMLElement | null {
  // The core already resolved a duplicate id to the FIRST in document order; querySelector
  // returns exactly that, so the DOM and the pure fold cannot disagree.
  return root.querySelector<HTMLElement>(`[data-dsx-shared="${CSS.escape(id)}"]`);
}

/**
 * One shared-element flight between two frames — created by the router at the moment it starts
 * a push, a pop or a presentation, and driven either by its own rAF loop or, once a gesture
 * takes it over, by the finger.
 *
 * `progress` is always measured toward the DESTINATION (the core's convention), so the same
 * flight object serves a push, a pop, and an interrupted push that becomes a pop.
 */
export class SharedFlight {
  readonly machine = new SharedTransitionMachine();
  private readonly plane: HTMLElement;
  private readonly flown: Flown[] = [];
  private raf = 0;
  private startedAt = 0;
  private startProgress = 0;
  private duration: number;
  private ended = false;
  private onEnd: (() => void) | null = null;

  /** null when nothing paired — the caller then runs the ordinary frame transition untouched. */
  static create(
    host: HTMLElement,
    sourceRoot: HTMLElement,
    destinationRoot: HTMLElement,
    options: { reducedMotion?: boolean; frameAnim?: string | null; durationMs?: number } = {},
  ): SharedFlight | null {
    if (sharedSupport() === "unsupported") return null;
    const matchOptions: { reducedMotion?: boolean; frameAnim?: string | null } = {};
    if (options.reducedMotion !== undefined) matchOptions.reducedMotion = options.reducedMotion;
    if (options.frameAnim !== undefined) matchOptions.frameAnim = options.frameAnim;
    const match = matchSharedElements(
      collectSharedElements(sourceRoot, host),
      collectSharedElements(destinationRoot, host),
      matchOptions,
    );
    if (match.duplicates.length > 0) {
      // A lint error at author time; at runtime the core already picked the first occurrence,
      // so the transition is correct — say so once rather than failing the navigation.
      console.warn(`[dsx router] duplicate shared id(s) in one frame: ${match.duplicates.join(", ")}`);
    }
    if (match.pairs.length === 0) return null;   // the unmatched law: the ordinary transition, silently
    return new SharedFlight(host, sourceRoot, destinationRoot, match.pairs, options.durationMs ?? 340);
  }

  private constructor(
    host: HTMLElement,
    sourceRoot: HTMLElement,
    destinationRoot: HTMLElement,
    pairs: SharedPair[],
    duration: number,
  ) {
    this.duration = Math.max(1, duration);
    this.plane = document.createElement("div");
    this.plane.className = "dsx-shared-plane";
    this.plane.setAttribute("aria-hidden", "true");
    this.plane.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:2000;overflow:hidden;";
    host.appendChild(this.plane);

    pairs.forEach((pair, index) => {
      const sourceNode = findShared(sourceRoot, pair.id);
      const destinationNode = findShared(destinationRoot, pair.id);
      const layer = document.createElement("div");
      // `sharedOrder` IS the z-order among the pairs, and the core already sorted them.
      layer.style.cssText =
        `position:absolute;left:0;top:0;transform-origin:top left;overflow:hidden;z-index:${index + 1};`;
      const sourceClone = this.clone(sourceNode);
      const destinationClone = destinationNode === null ? null : this.clone(destinationNode);
      layer.appendChild(sourceClone);
      if (destinationClone !== null) layer.appendChild(destinationClone);
      this.plane.appendChild(layer);
      // The real nodes stay in the tree (layout must not shift) but go invisible for the
      // flight, so the eye sees exactly one of each element.
      if (sourceNode !== null) sourceNode.style.visibility = "hidden";
      if (destinationNode !== null) destinationNode.style.visibility = "hidden";
      this.flown.push({ pair, layer, sourceNode, destinationNode, sourceClone, destinationClone });
    });
  }

  private clone(node: HTMLElement | null): HTMLElement {
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;inset:0;";
    if (node !== null) {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
      copy.style.visibility = "visible";
      copy.style.width = "100%";
      copy.style.height = "100%";
      copy.style.margin = "0";
      holder.appendChild(copy);
    }
    return holder;
  }

  /** Paint every pair at `progress`. Pure read of the core, then one style write per layer. */
  private paint(progress: number): void {
    for (const flown of this.flown) {
      const s = sampleSharedPair(flown.pair, progress);
      flown.layer.style.transform = `translate(${s.x}px, ${s.y}px)`;
      flown.layer.style.width = `${s.width}px`;
      flown.layer.style.height = `${s.height}px`;
      flown.layer.style.borderRadius = `${s.radius}px`;
      flown.layer.style.opacity = String(s.alpha);
      flown.sourceClone.style.opacity = String(s.sourceOpacity);
      // `clip` is the mode for text that changes size: the frame animates, the glyphs do not
      // stretch with it, so the content keeps its natural box and is clipped by the layer.
      flown.sourceClone.style.inset = s.scaleContent ? "0" : "auto auto auto 0";
      if (flown.destinationClone !== null) {
        flown.destinationClone.style.opacity = String(s.destinationOpacity);
        flown.destinationClone.style.inset = s.scaleContent ? "0" : "auto auto auto 0";
      }
    }
  }

  /** Start the flight and run it to its target unless a gesture takes over. */
  begin(direction: "forward" | "reverse", onEnd?: () => void): void {
    this.onEnd = onEnd ?? null;
    const snapshot = this.machine.begin(direction);
    this.paint(snapshot.progress);
    this.run();
  }

  /** Arm the flight with the finger already on it — a swipe-back that begins from rest. The
   *  machine goes `running(reverse)` then straight to `interactive` at progress 1, so no
   *  animation ever runs and every subsequent pose comes from `drag`. */
  beginInteractive(onEnd?: () => void): void {
    this.onEnd = onEnd ?? null;
    this.machine.begin("reverse");
    this.paint(this.machine.interrupt(1).progress);
  }

  /** Is a non-interactive animation still in the air? The router asks before letting a gesture
   *  adopt the flight (and to know whether the frame motion needs cancelling too). */
  get running(): boolean { return this.machine.state === "running"; }

  /** Where the flight actually is — the router seeds its drag from this so the frame under the
   *  finger continues from the pose the push had reached instead of jumping. */
  get progress(): number { return this.machine.progress; }

  private run(): void {
    if (this.ended) return;
    cancelAnimationFrame(this.raf);
    const snapshot = this.machine.snapshot();
    this.startProgress = snapshot.progress;
    const target = snapshot.target;
    // A reversal costs what is LEFT, never a full replay — the corpus's `remaining`.
    const span = Math.max(1, this.duration * snapshot.remaining);
    this.startedAt = performance.now();
    const step = (now: number): void => {
      if (this.ended || this.machine.state !== "running") return;
      const t = Math.min(1, (now - this.startedAt) / span);
      // easeOutCubic: the same "arrive gently" shape the router's own frame motion uses.
      const eased = 1 - Math.pow(1 - t, 3);
      const progress = this.startProgress + (target - this.startProgress) * eased;
      this.paint(this.machine.tick(progress).progress);
      if (t < 1) this.raf = requestAnimationFrame(step);
      else { this.machine.settle(); this.finish(); }
    };
    this.raf = requestAnimationFrame(step);
  }

  /** A gesture takes the flight over WHERE IT IS. This is the whole acceptance test: nothing
   *  restarts, nothing snaps — the finger inherits the pose the animation had reached. */
  interrupt(): number {
    cancelAnimationFrame(this.raf);
    const snapshot = this.machine.interrupt(this.machine.progress);
    this.paint(snapshot.progress);
    return snapshot.progress;
  }

  /** The finger moving, as an absolute progress toward the destination. */
  drag(progress: number): void {
    this.paint(this.machine.drag(progress).progress);
  }

  /** The finger lifting: commit the reversal, or cancel it and resume forward. */
  release(commit: boolean): void {
    this.machine.release(commit ? "commit" : "cancel");
    this.run();
  }

  /** Tear the flight down and give the real nodes their visibility back. Idempotent. */
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    for (const flown of this.flown) {
      if (flown.sourceNode !== null) flown.sourceNode.style.visibility = "";
      if (flown.destinationNode !== null) flown.destinationNode.style.visibility = "";
    }
    this.plane.remove();
    const onEnd = this.onEnd;
    this.onEnd = null;
    onEnd?.();
  }

  /** `reversed` after an interrupted flight the finger committed, `completed` otherwise. */
  get outcome(): "completed" | "reversed" | null { return this.machine.outcome; }
}
