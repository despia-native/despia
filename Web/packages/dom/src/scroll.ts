//
//  scroll.ts — the `<scroll>` WEB ADAPTER (U01). The decisions all live in the shared core
//  (@despia-native/kernel scroll.ts, corpus OpenSource/Conformance/scroll/); this file is the plumbing
//  the browser needs and nothing else: CSS for the declarative attributes, one rAF-coalesced
//  listener, the `--scroll-*` publication, and the imperative surface behind `ref=`.
//
//  WHY THIS IS ITS OWN FILE. elements.ts is shared by every UI workstream, so the `<scroll>`
//  factory there stays a two-line container and calls in here. The call site is
//  `applyScrollBehaviour(e, node.attrs, api)` — one line to merge, four hundred to own.
//
//  THE BROWSER GIVES US THE HARD HALF OF `--scroll-*` FOR FREE. Custom properties cascade, so
//  publishing a node's own axis plane onto the scroll container IS the corpus's "nearest
//  ancestor per axis" resolution: a horizontal rail inside a vertical page sets `--scroll-x*` on
//  itself and inherits `--scroll-y*` from the page, with no scope walk and no bus traffic. The
//  native renderers have to compute `resolveLinkedScope` because their style systems do not
//  cascade custom properties; here the platform already agrees with the corpus.
//
//  WHAT THE WEB CANNOT DO, STATED RATHER THAN FAKED: there is no end-of-deceleration event, so
//  `on:scrollEnd` fires SETTLE_MS after the last movement (the core's own constant, shared with
//  every renderer that lacks the callback).
//

import {
  parseScrollConfig,
  scrollMetrics,
  scrollMotion,
  shouldDispatchScroll,
  reachEndState,
  resolveScrollCommand,
  resolveSnap,
  maintainPositionOffset,
  scrollLinkedProperties,
  namedScrollProperties,
  SETTLE_MS,
  RefRegistry,
  type ScrollAxis,
  type ScrollConfig,
  type ScrollDirection,
  type ScrollMetrics,
  type ChildFrame,
  type Align,
} from "@despia-native/kernel";

/** What the adapter needs from the renderer. `ElementApi` satisfies it structurally, so the
 *  call site passes `api` straight through and the tests pass a four-line stub. */
export interface ScrollHooks {
  handler(name: string, payload?: Record<string, unknown>): void;
  hasHandler(name: string): boolean;
  writeBack?(path: string | undefined, value: unknown): void;
}

/** Injected clock and frame source. Present so a headless test drives real time rather than
 *  waiting for it — never so production can run on a different policy. */
export interface ScrollEnvironment {
  now(): number;
  requestFrame(run: () => void): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

function defaultEnvironment(): ScrollEnvironment {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
    performance?: { now(): number };
  };
  return {
    now: () => (g.performance !== undefined ? g.performance.now() : Date.now()),
    requestFrame: (run) => {
      if (typeof g.requestAnimationFrame === "function") g.requestAnimationFrame(run);
      else g.setTimeout(run, 0);
    },
    setTimer: (run, ms) => g.setTimeout(run, ms),
    clearTimer: (handle) => g.clearTimeout(handle),
  };
}

/** The `<scroll>` presenter for one element. Held off the element in a WeakMap so nothing keeps
 *  a detached node alive, and reached by name through the ONE ref registry. */
export class ScrollController {
  readonly element: HTMLElement;
  readonly config: ScrollConfig;
  /** The node's `ref`, which is also the name of the plane it publishes at document root. Empty
   *  when it has none, and then nothing named is published. */
  readonly ref: string;
  private readonly hooks: ScrollHooks;
  private readonly env: ScrollEnvironment;
  private lastSample: { x: number; y: number; t: number } | null = null;
  private lastDirection: ScrollDirection | null = null;
  private lastDispatchAt: number | null = null;
  private reachLatched = false;
  private settleHandle: unknown = null;
  private framePending = false;
  private disposed = false;
  private resize: ResizeObserver | null = null;
  private anchorBefore: number | null = null;

  constructor(
    element: HTMLElement,
    config: ScrollConfig,
    hooks: ScrollHooks,
    env: ScrollEnvironment,
    ref = "",
  ) {
    this.element = element;
    this.config = config;
    this.hooks = hooks;
    this.env = env;
    this.ref = ref;
  }

  /** Where a NAMED plane is published. The node's own plane goes on the node and the cascade
   *  carries it to descendants; the named twin exists for everything that is NOT a descendant,
   *  so it has to sit above all of them. `:root` is the only element that qualifies. */
  private root(): HTMLElement | null {
    return this.element.ownerDocument?.documentElement ?? null;
  }

  get axis(): ScrollAxis {
    return this.config.axis;
  }

  /** The geometry the core reasons over, read once per frame. */
  metrics(): ScrollMetrics {
    const e = this.element;
    return scrollMetrics({
      x: e.scrollLeft,
      y: e.scrollTop,
      viewportWidth: e.clientWidth,
      viewportHeight: e.clientHeight,
      contentWidth: e.scrollWidth,
      contentHeight: e.scrollHeight,
    });
  }

  /** One sample: publish the style plane, then dispatch the LOGIC handlers under the coalescing
   *  budget. The publication is unconditional and the dispatch is not — that split is the whole
   *  performance contract, and it is why a page with no `on:scroll` costs a style write. */
  sample(options?: { settling?: boolean }): void {
    if (this.disposed) return;
    const now = this.env.now();
    const m = this.metrics();
    const previous = this.lastSample;
    const next = { x: m.x, y: m.y, t: now };
    const motion = previous === null
      ? { dx: 0, dy: 0, velocityX: 0, velocityY: 0, velocity: 0, direction: (this.lastDirection ?? "none") as ScrollDirection }
      : scrollMotion(previous, next, this.lastDirection);
    this.lastSample = next;
    this.lastDirection = motion.direction;

    for (const [name, value] of Object.entries(scrollLinkedProperties(this.axis, m, motion.velocity))) {
      this.element.style.setProperty(name, value);
    }
    if (this.ref !== "") {
      const root = this.root();
      const named = namedScrollProperties(this.ref, this.axis, m, motion.velocity);
      if (root !== null) {
        for (const [name, value] of Object.entries(named)) root.style.setProperty(name, value);
      }
    }

    if (this.config.bind !== null && this.hooks.writeBack !== undefined) {
      this.hooks.writeBack(this.config.bind, { x: m.x, y: m.y });
    }

    const hasScroll = this.hooks.hasHandler("scroll");
    if (shouldDispatchScroll(hasScroll, this.lastDispatchAt, now)) {
      this.lastDispatchAt = now;
      this.hooks.handler("scroll", {
        x: m.x, y: m.y, dx: motion.dx, dy: motion.dy,
        width: this.element.clientWidth, height: this.element.clientHeight,
        contentWidth: this.element.scrollWidth, contentHeight: this.element.scrollHeight,
        atTop: m.atTop, atBottom: m.atBottom,
        direction: motion.direction, velocity: motion.velocity,
      });
    }

    const reach = reachEndState(this.reachLatched, m, this.config.threshold, this.axis);
    this.reachLatched = reach.latched;
    if (reach.fire && this.hooks.hasHandler("reachEnd")) {
      this.hooks.handler("reachEnd", { remaining: reach.remaining });
    }

    // Only a real scroll arms the settle timer. The resting publish at mount is not a scroll,
    // and arming from it would fire `on:scrollEnd` (and run a snap) 120ms after every mount,
    // with the finger never having touched the surface.
    if (options?.settling !== false) this.armSettle();
  }

  /** No end-of-deceleration event exists on the web, so settle on silence — the core's own
   *  SETTLE_MS, so every renderer without the callback answers at the same moment. */
  private armSettle(): void {
    if (this.settleHandle !== null) this.env.clearTimer(this.settleHandle);
    this.settleHandle = this.env.setTimer(() => {
      this.settleHandle = null;
      this.settle();
    }, SETTLE_MS);
  }

  /** Deceleration finished: snap if the container proposes one, then announce. */
  settle(): void {
    if (this.disposed) return;
    const m = this.metrics();
    // Settle means the platform has already decelerated to rest, so the snap decision is the
    // AT-REST one (nearest candidate, ties to the smaller offset). Feeding the last observed
    // velocity here would re-apply a fling the browser has already spent.
    const velocity = 0;
    const horizontal = this.axis === "horizontal";
    const target = resolveSnap(
      this.config.snap,
      horizontal ? m.x : m.y,
      horizontal ? this.element.clientWidth : this.element.clientHeight,
      horizontal ? this.element.scrollWidth : this.element.scrollHeight,
      this.childFrames(),
      velocity,
    );
    if (target !== null) this.scrollTo(horizontal ? target : m.x, horizontal ? m.y : target, true);
    if (this.hooks.hasHandler("scrollEnd")) {
      this.hooks.handler("scrollEnd", { x: m.x, y: m.y, atTop: m.atTop, atBottom: m.atBottom });
    }
  }

  /** Child frames along the scrolling axis, for `snap` and `toElement`. */
  childFrames(): ChildFrame[] {
    const horizontal = this.axis === "horizontal";
    const frames: ChildFrame[] = [];
    for (const child of Array.from(this.element.children) as HTMLElement[]) {
      frames.push(horizontal
        ? { start: child.offsetLeft, length: child.offsetWidth }
        : { start: child.offsetTop, length: child.offsetHeight });
    }
    return frames;
  }

  /** `maintainPosition` — call BEFORE the mutation with a still-visible child, and again after.
   *  An anchor rather than a height delta is the whole design: a height diff cannot tell a
   *  prepend from an append. */
  captureAnchor(child: HTMLElement): void {
    this.anchorBefore = this.axis === "horizontal" ? child.offsetLeft : child.offsetTop;
  }

  restoreAnchor(child: HTMLElement): void {
    if (!this.config.maintainPosition || this.anchorBefore === null) return;
    const horizontal = this.axis === "horizontal";
    const after = horizontal ? child.offsetLeft : child.offsetTop;
    const result = maintainPositionOffset(
      horizontal ? this.element.scrollLeft : this.element.scrollTop,
      this.anchorBefore,
      after,
      horizontal ? this.element.clientWidth : this.element.clientHeight,
      horizontal ? this.element.scrollWidth : this.element.scrollHeight,
    );
    this.anchorBefore = null;
    if (result.delta === 0) return;
    this.scrollTo(horizontal ? result.offset : this.element.scrollLeft,
                  horizontal ? this.element.scrollTop : result.offset, false);
  }

  private scrollTo(x: number, y: number, animated: boolean): void {
    const e = this.element as HTMLElement & { scrollTo?: (options: { left: number; top: number; behavior: string }) => void };
    if (typeof e.scrollTo === "function") {
      e.scrollTo({ left: x, top: y, behavior: animated ? "smooth" : "auto" });
      return;
    }
    this.element.scrollLeft = x;
    this.element.scrollTop = y;
  }

  // ── the imperative surface: dsx.scroll(ref).to / .toTop / .toBottom / .toElement ──

  to(options: { x?: number; y?: number; animated?: boolean }): boolean {
    return this.run({ kind: "to", ...options });
  }

  toTop(animated = true): boolean {
    return this.run({ kind: "toTop", animated });
  }

  toBottom(animated = true): boolean {
    return this.run({ kind: "toBottom", animated });
  }

  /**
   * `toElement` resolves its target through the SAME ref registry `ref=` publishes into — there
   * is exactly one name table in the renderer. A target that is not a descendant, or a row a
   * virtualiser has not realised, resolves to no frame and the core answers null: the call is a
   * no-op rather than a scroll to a guessed offset.
   */
  toElement(options: { ref?: string; element?: HTMLElement | null; align?: Align; animated?: boolean; focus?: boolean }): boolean {
    const target = options.element ?? (options.ref === undefined ? null : resolveRefElement(options.ref));
    if (target === null || !this.element.contains(target)) return false;
    const horizontal = this.axis === "horizontal";
    const child: ChildFrame = horizontal
      ? { start: target.offsetLeft, length: target.offsetWidth }
      : { start: target.offsetTop, length: target.offsetHeight };
    const moved = this.run({ kind: "toElement", child, align: options.align ?? "nearest", animated: options.animated ?? true });
    // Accessibility focus moves ONLY when the caller asks: a scroll is not a focus change, and
    // silently stealing focus is how a "scroll to section" button breaks a screen reader's place.
    if (moved && options.focus === true && typeof (target as HTMLElement & { focus?: () => void }).focus === "function") {
      (target as HTMLElement & { focus: () => void }).focus();
    }
    return moved;
  }

  private run(command: Parameters<typeof resolveScrollCommand>[0]): boolean {
    const target = resolveScrollCommand(command, {
      x: this.element.scrollLeft,
      y: this.element.scrollTop,
      viewportWidth: this.element.clientWidth,
      viewportHeight: this.element.clientHeight,
      contentWidth: this.element.scrollWidth,
      contentHeight: this.element.scrollHeight,
    }, this.axis);
    if (target === null) return false;
    this.scrollTo(target.x, target.y, target.animated);
    return true;
  }

  /** The listener the factory installs, coalesced to one read per frame. */
  onScrollEvent = (): void => {
    if (this.framePending || this.disposed) return;
    this.framePending = true;
    this.env.requestFrame(() => {
      this.framePending = false;
      this.sample();
    });
  };

  /** Re-publish when the GEOMETRY changes with no scroll event: content arriving, a row loading,
   *  the viewport resizing. Half the plane is derived from content size - `--scroll-progress` and
   *  `--scroll-remaining` both are - so a plane published once at mount describes a layout that
   *  had not happened yet, and nothing would correct it until the first finger. */
  observeGeometry(): void {
    const Observer = (globalThis as unknown as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    if (Observer === undefined || this.resize !== null) return;
    this.resize = new Observer(() => {
      if (!this.disposed) this.sample({ settling: false });
    });
    this.resize.observe(this.element);
    for (const child of Array.from(this.element.children)) this.resize.observe(child);
  }

  dispose(): void {
    this.disposed = true;
    if (this.settleHandle !== null) this.env.clearTimer(this.settleHandle);
    this.settleHandle = null;
    this.resize?.disconnect();
    this.resize = null;
    // A named plane outlives its element unless it is withdrawn: `var(--scroll-feed-y)` would
    // otherwise keep resolving to the last offset a scroller had before it unmounted, which is
    // the stale-chrome bug the typed-absence rule exists to prevent.
    if (this.ref !== "") {
      const root = this.root();
      if (root !== null) {
        const m = this.metrics();
        for (const name of Object.keys(namedScrollProperties(this.ref, this.axis, m, 0))) {
          root.style.removeProperty(name);
        }
      }
    }
    CONTROLLERS.delete(this.element);
  }
}

const CONTROLLERS = new WeakMap<HTMLElement, ScrollController>();

/** The ONE process-wide ref table — the same well-known symbol mount.ts publishes into, reached
 *  by symbol rather than by import so this file adds no cycle and no second lookup mechanism. */
function refs(): RefRegistry<HTMLElement> {
  const slot = Symbol.for("dsx.refs.v1");
  const g = globalThis as unknown as { [k: symbol]: RefRegistry<HTMLElement> | undefined };
  return (g[slot] ??= new RefRegistry<HTMLElement>());
}

function resolveRefElement(name: string): HTMLElement | null {
  const resolution = refs().resolve(name);
  return resolution.ok ? resolution.view : null;
}

/** `dsx.scroll("feed")` — the named scroll view's controller, or null. `unknown_ref` is the
 *  caller's own answer to null; this returns the value, not an error envelope. */
export function scrollController(name: string): ScrollController | null {
  const element = resolveRefElement(name);
  if (element === null) return null;
  return CONTROLLERS.get(element) ?? null;
}

/** CSS `object-position`-style percentages from the core's 0…1 anchor pair. */
function overscrollValue(overscroll: string): string {
  if (overscroll === "never") return "none";
  if (overscroll === "always") return "auto";
  return "auto";
}

/**
 * THE CALL SITE. `applyScrollBehaviour(e, node.attrs, api)` from the `<scroll>` factory in
 * elements.ts, and everything U01 promises is wired: the declarative attributes as CSS, the
 * observation plane, `--scroll-*`, and the element's entry in the imperative table.
 */
export function applyScrollBehaviour(
  element: HTMLElement,
  attributes: Record<string, string | undefined>,
  hooks: ScrollHooks,
  environment?: Partial<ScrollEnvironment>,
): ScrollController {
  const config = parseScrollConfig(attributes);
  const env: ScrollEnvironment = { ...defaultEnvironment(), ...(environment ?? {}) };
  const horizontal = config.axis === "horizontal";

  const style = element.style;
  style.setProperty("overflow-" + (horizontal ? "x" : "y"), "auto");
  style.setProperty("overflow-" + (horizontal ? "y" : "x"), "hidden");
  style.setProperty("overscroll-behavior", overscrollValue(config.overscroll));
  // `indicators=false` hides the bar on every engine that has an opinion; the scroll itself is
  // untouched, because an element the user cannot scroll is scroll-jacking and U01 refuses it.
  if (!config.indicators) style.setProperty("scrollbar-width", "none");
  if (config.snap !== "none") {
    style.setProperty("scroll-snap-type",
      (horizontal ? "x" : "y") + " " + (config.snap === "page" ? "mandatory" : "proximity"));
    const align = config.snap === "page" ? "start" : config.snap;
    for (const child of Array.from(element.children) as HTMLElement[]) {
      child.style.setProperty("scroll-snap-align", align);
    }
  }
  // `bounces` is a TRISTATE and null means the platform decides: a browser has no rubber band to
  // turn off, so only an explicit false writes anything, and it writes the containment word.
  if (config.bounces === false) style.setProperty("overscroll-behavior", "contain");
  const inset = config.contentInset;
  if (inset.top !== 0 || inset.right !== 0 || inset.bottom !== 0 || inset.left !== 0) {
    style.setProperty("scroll-padding",
      `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`);
    style.setProperty("padding",
      `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`);
  }
  element.setAttribute("data-dsx-scroll-axis", config.axis);
  // `keyboardDismiss` is an iOS/Android scroll-view behaviour with no browser twin. Recorded
  // rather than silently dropped, so the gap is inspectable instead of mysterious.
  if (config.keyboardDismiss !== "interactive") {
    element.setAttribute("data-dsx-keyboard-dismiss", config.keyboardDismiss);
  }

  const controller = new ScrollController(element, config, hooks, env, (attributes["ref"] ?? "").trim());
  CONTROLLERS.set(element, controller);
  element.addEventListener("scroll", controller.onScrollEvent, { passive: true });
  // Publish the resting plane immediately: a header bound to `--scroll-progress` must render
  // correctly on the first frame, not on the first finger.
  controller.sample({ settling: false });
  controller.observeGeometry();
  return controller;
}
