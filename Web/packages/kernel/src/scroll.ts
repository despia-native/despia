/**
 * scroll.ts — the `<scroll>` observation plane and the scroll-linked style substrate, TS twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/scroll/README.md; the cases live in
 * that folder's seven .json files and run against THIS file
 * (packages/kernel/test/scroll-conformance.test.ts), against the Kotlin twin
 * (:core ScrollLinkedConformanceTest) and against the Swift twin (ScrollLinked.swift).
 *
 * Everything here is pure: geometry in, values out. The surface work — observing the scroll
 * view, driving the display link, writing resolved values into the render tree, and the `ref`
 * registry behind `dsx.scroll(name)` — belongs to each renderer's presenter. Keeping the
 * decision separate from the plumbing is what lets one corpus judge three runtimes.
 *
 * THE SPLIT THIS FILE EXISTS FOR. `on:scroll` is for LOGIC and is coalesced to the display
 * link; `--scroll-*` is for STYLE and is a pure function of one sample, so a renderer resolves
 * it inside its own frame callback and nothing crosses the bus. A scroll handler dispatched per
 * frame through a message bus is how a framework earns its reputation, and it is the one thing
 * this design refuses to make possible.
 */

/** Sub-pixel tolerance, in points. Momentum deceleration lands a fraction of a point short of
 *  the rail; a strict comparison makes `atBottom` flicker false at rest, which is how an
 *  infinite-scroll trigger misses. The same tolerance gives `direction` its stickiness. */
export const SCROLL_EPSILON = 0.5;

/** One display-link tick at 60 Hz. The default coalescing budget for `on:scroll`. */
export const FRAME_BUDGET_MS = 16;

/** How long without movement counts as settled, on a renderer with no platform deceleration
 *  callback (the web). iOS and Android have real end-of-deceleration signals and use those. */
export const SETTLE_MS = 120;

/** Above this speed a snap follows the direction of travel instead of the nearest candidate.
 *  It is what makes a 10% flick turn a page. Points per second. */
export const FLING_VELOCITY = 500;

/** `on:collapse` quantum: a hundredth of the collapse range. */
export const COLLAPSE_EPSILON = 0.01;

/** Where `<CollapsingHeader titleTransition="move">` hands the title to the nav bar. The header
 *  title's opacity reaches 0 exactly here and the nav bar's leaves 0 exactly here, so the two
 *  are never both visible and the title is ONE accessibility element at every fraction. */
export const TITLE_HANDOFF_FRACTION = 0.75;

/** Full-collapse blur radius for `blurOnCollapse`. */
export const BLUR_MAX = 20;

/** The default `<CollapsingHeader>` scrim: a bottom-anchored gradient from transparent at 60%
 *  of the height to 60% black at the bottom edge. It exists by default because a white title
 *  over a light photo is unreadable, and every app that ships this without one ships that bug. */
export const SCRIM_START = 0.6;
export const SCRIM_ALPHA = 0.6;

/** The default `minHeight` when the author names none. A host that knows its real bar height
 *  passes it; 56 is the shared floor (M3 small top app bar, comfortably over an iOS bar). */
export const NAV_BAR_HEIGHT = 56;

export type ScrollAxis = 'vertical' | 'horizontal';
export type ScrollDirection = 'none' | 'up' | 'down' | 'left' | 'right';
export type SnapMode = 'none' | 'start' | 'center' | 'end' | 'page';
export type KeyboardDismiss = 'none' | 'onDrag' | 'interactive';
export type Overscroll = 'auto' | 'never' | 'always';
export type TitleTransition = 'move' | 'fade' | 'none';
export type Align = 'start' | 'center' | 'end' | 'nearest';

/** A number that survived a platform report. Nonsense reads as the origin rather than poisoning
 *  every value derived from it: one NaN offset otherwise becomes a NaN CSS length, and a dropped
 *  declaration is a silent layout hole. */
function finite(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Round half away from zero to four decimals. Half-away-from-zero rather than half-to-even
 *  because three languages must agree, and only this rule is spelled the same in all three. */
export function round4(value: unknown): number {
  const v = finite(value);
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.floor(Math.abs(v) * 10000 + 0.5)) / 10000;
}

/** The published spelling of a number. Part of the contract: the corpus compares strings, so
 *  three languages must format identically. No exponent, no trailing zeros, no negative zero. */
export function formatNumber(value: unknown): string {
  const r = round4(value);
  if (r === 0) return '0';
  let s = r.toFixed(4);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------- metrics

export interface ScrollGeometry {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export interface ScrollMetrics {
  /** The RAW offset, sign intact: rubber-band over-scroll is real, and `<CollapsingHeader
   *  stretch>` is built on reading it. */
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  /** 0..1 across the vertical range, from the CLAMPED offset so over-scroll cannot leave it. */
  progress: number;
  progressX: number;
  atTop: boolean;
  atBottom: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/**
 * The offset math every other function here builds on.
 *
 * The degenerate case is pinned on purpose: content no taller than the viewport is at BOTH ends
 * (a page with nothing to scroll IS at each of them, and that is what makes `on:reachEnd` fire
 * once for a short list) and reports progress 0, never 1 — a non-scrollable plane must publish
 * the RESTING state, because a header that boots into its collapsed look on a short page is the
 * visible bug.
 */
export function scrollMetrics(geometry: Partial<ScrollGeometry>): ScrollMetrics {
  const x = finite(geometry.x);
  const y = finite(geometry.y);
  const maxX = Math.max(0, finite(geometry.contentWidth) - finite(geometry.viewportWidth));
  const maxY = Math.max(0, finite(geometry.contentHeight) - finite(geometry.viewportHeight));
  return {
    x: round4(x),
    y: round4(y),
    maxX: round4(maxX),
    maxY: round4(maxY),
    progress: round4(maxY <= 0 ? 0 : clamp(y, 0, maxY) / maxY),
    progressX: round4(maxX <= 0 ? 0 : clamp(x, 0, maxX) / maxX),
    atTop: y <= SCROLL_EPSILON,
    atBottom: y >= maxY - SCROLL_EPSILON,
    atStart: x <= SCROLL_EPSILON,
    atEnd: x >= maxX - SCROLL_EPSILON,
  };
}

// ---------------------------------------------------------------------------- motion

export interface ScrollSample {
  x: number;
  y: number;
  /** Milliseconds, from any monotonic clock the renderer already has. */
  t: number;
}

export interface ScrollMotion {
  dx: number;
  dy: number;
  velocityX: number;
  velocityY: number;
  /** Signed along the axis `direction` names, so the two are one coherent statement. */
  velocity: number;
  direction: ScrollDirection;
}

/**
 * Motion from a SAMPLE PAIR, never from an accumulated delta.
 *
 * `direction` is STICKY below the tolerance. A one-pixel jitter that flips the word every frame
 * is exactly the shrinking-header flicker, so a sub-tolerance sample keeps the previous word
 * rather than inventing `none`; `none` is only ever the state before the first real movement.
 * A non-monotonic or backwards clock yields velocity 0 rather than an infinity.
 */
export function scrollMotion(
  previous: ScrollSample,
  next: ScrollSample,
  previousDirection?: ScrollDirection | null,
): ScrollMotion {
  const dx = finite(next.x) - finite(previous.x);
  const dy = finite(next.y) - finite(previous.y);
  const dt = finite(next.t) - finite(previous.t);
  const velocityX = dt > 0 ? (dx * 1000) / dt : 0;
  const velocityY = dt > 0 ? (dy * 1000) / dt : 0;
  // An exact tie prefers the vertical axis: it is the default axis of a <scroll>.
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const delta = vertical ? dy : dx;
  let direction: ScrollDirection;
  if (Math.abs(delta) <= SCROLL_EPSILON) direction = previousDirection ?? 'none';
  else if (vertical) direction = delta > 0 ? 'down' : 'up';
  else direction = delta > 0 ? 'right' : 'left';
  return {
    dx: round4(dx),
    dy: round4(dy),
    velocityX: round4(velocityX),
    velocityY: round4(velocityY),
    velocity: round4(vertical ? velocityY : velocityX),
    direction,
  };
}

// ---------------------------------------------------------------------------- coalescing

/**
 * The performance contract, as one predicate.
 *
 * With no handler bound the answer is FALSE, not "cheap": a scroll nobody is listening to costs
 * nothing at all. Otherwise at most one dispatch per display-link tick, and the first sample of
 * a gesture always dispatches so a handler sees the start.
 */
export function shouldDispatchScroll(
  hasHandler: boolean,
  lastDispatchAt: number | null,
  now: number,
  frameBudgetMs: number = FRAME_BUDGET_MS,
): boolean {
  if (!hasHandler) return false;
  if (lastDispatchAt === null) return true;
  return finite(now) - finite(lastDispatchAt) >= finite(frameBudgetMs);
}

export interface CoalesceResult {
  dispatches: number;
  at: number[];
}

/** Run a whole sample train through the policy. The corpus asserts the COUNT over a fixed train,
 *  so a coalescing regression is caught rather than felt. */
export function coalesceScroll(
  samples: readonly number[],
  hasHandler: boolean,
  frameBudgetMs: number = FRAME_BUDGET_MS,
): CoalesceResult {
  if (!hasHandler) return { dispatches: 0, at: [] };
  const at: number[] = [];
  let last: number | null = null;
  for (const raw of samples) {
    const t = finite(raw);
    if (shouldDispatchScroll(true, last, t, frameBudgetMs)) {
      at.push(round4(t));
      last = t;
    }
  }
  return { dispatches: at.length, at };
}

// ---------------------------------------------------------------------------- reachEnd

export interface ReachEndState {
  fire: boolean;
  latched: boolean;
  remaining: number;
}

/**
 * `on:reachEnd`, EDGE-TRIGGERED. It fires on the sample that crosses the threshold, not on every
 * frame spent at the bottom; the latch releases when the user scrolls back out. Without the
 * latch a "load more" handler is called sixty times a second at the rail, which is the classic
 * duplicate-page bug.
 */
export function reachEndState(
  latched: boolean,
  metrics: ScrollMetrics,
  threshold: number,
  axis: ScrollAxis = 'vertical',
): ReachEndState {
  const remaining =
    axis === 'horizontal'
      ? metrics.maxX - clamp(metrics.x, 0, metrics.maxX)
      : metrics.maxY - clamp(metrics.y, 0, metrics.maxY);
  const crossed = remaining <= finite(threshold) + SCROLL_EPSILON;
  return { fire: crossed && !latched, latched: crossed, remaining: round4(remaining) };
}

// ---------------------------------------------------------------------------- imperative

export interface ChildFrame {
  start: number;
  length: number;
}

export type ScrollCommand =
  | { kind: 'to'; x?: number; y?: number; animated?: boolean }
  | { kind: 'toTop'; animated?: boolean }
  | { kind: 'toBottom'; animated?: boolean }
  | { kind: 'toElement'; child?: ChildFrame | null; align?: Align; animated?: boolean };

export interface ScrollTarget {
  x: number;
  y: number;
  animated: boolean;
}

/**
 * `dsx.scroll(ref).to/.toTop/.toBottom/.toElement`, reduced to one offset.
 *
 * Three rules. An imperative call NEVER over-scrolls, so every target clamps into 0..max —
 * `to({y: 99999})` parks on the rail instead of leaving a band of nothing under the content.
 * `toTop`/`toBottom` name the PRIMARY AXIS rather than the vertical one, so the familiar words
 * keep working on a horizontal rail. `align: "nearest"` is the only alignment allowed to decide
 * not to move, which is what makes `toElement` safe to call on every selection change.
 *
 * An unrealised row in a virtualised list returns null rather than guessing at an offset it
 * cannot know; a virtualiser carrying an estimate passes the estimated frame and gets a real
 * answer, then re-resolves once the row is realised.
 */
export function resolveScrollCommand(
  command: ScrollCommand,
  geometry: Partial<ScrollGeometry>,
  axis: ScrollAxis = 'vertical',
): ScrollTarget | null {
  const m = scrollMetrics(geometry);
  const horizontal = axis === 'horizontal';
  const animated = command.animated ?? true;
  const offset = horizontal ? m.x : m.y;
  const limit = horizontal ? m.maxX : m.maxY;
  const view = finite(horizontal ? geometry.viewportWidth : geometry.viewportHeight);

  if (command.kind === 'to') {
    return {
      x: round4(command.x === undefined ? m.x : clamp(finite(command.x), 0, m.maxX)),
      y: round4(command.y === undefined ? m.y : clamp(finite(command.y), 0, m.maxY)),
      animated,
    };
  }

  let target: number;
  if (command.kind === 'toTop') target = 0;
  else if (command.kind === 'toBottom') target = limit;
  else {
    const child = command.child;
    if (!child) return null;
    const start = finite(child.start);
    const length = finite(child.length);
    const align = command.align ?? 'nearest';
    if (align === 'start') target = start;
    else if (align === 'center') target = start + length / 2 - view / 2;
    else if (align === 'end') target = start + length - view;
    else if (start >= offset && start + length <= offset + view) target = offset;
    else if (start < offset) target = start;
    else target = start + length - view;
  }
  target = clamp(target, 0, limit);
  return {
    x: round4(horizontal ? target : m.x),
    y: round4(horizontal ? m.y : target),
    animated,
  };
}

// ---------------------------------------------------------------------------- snap

function roundHalfUp(v: number): number {
  return v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5);
}

/**
 * The snap target, or null when the container proposes none.
 *
 * `paging` is `page` (the viewport is the stride); `start`/`center`/`end` snap to CHILD
 * BOUNDARIES, which is why real child frames are the input and a fixed stride is not — a rail of
 * variable-width cards is the common case. At rest the nearest candidate wins and an exact tie
 * takes the SMALLER offset, because a tie that advances is a snap that fights the finger. Past
 * the fling threshold the target is the next candidate in the direction of travel.
 */
export function resolveSnap(
  mode: SnapMode,
  offset: number,
  viewportLength: number,
  contentLength: number,
  children: readonly ChildFrame[],
  velocity: number,
): number | null {
  const view = finite(viewportLength);
  const limit = Math.max(0, finite(contentLength) - view);
  const at = finite(offset);
  const v = finite(velocity);
  if (mode === 'none' || limit <= 0) return null;

  if (mode === 'page') {
    if (view <= 0) return null;
    const index = Math.floor(at / view);
    const fraction = at / view - index;
    let target: number;
    if (v >= FLING_VELOCITY) target = (index + 1) * view;
    else if (v <= -FLING_VELOCITY) target = fraction > 0 ? index * view : (index - 1) * view;
    else target = roundHalfUp(at / view) * view;
    return round4(clamp(target, 0, limit));
  }

  const candidates: number[] = [];
  for (const child of children) {
    const start = finite(child.start);
    const length = finite(child.length);
    const raw =
      mode === 'start' ? start : mode === 'center' ? start + length / 2 - view / 2 : start + length - view;
    candidates.push(clamp(raw, 0, limit));
  }
  if (candidates.length === 0) return null;

  if (v >= FLING_VELOCITY) {
    const ahead = candidates.filter((c) => c > at + SCROLL_EPSILON);
    if (ahead.length > 0) return round4(Math.min(...ahead));
  } else if (v <= -FLING_VELOCITY) {
    const behind = candidates.filter((c) => c < at - SCROLL_EPSILON);
    if (behind.length > 0) return round4(Math.max(...behind));
  }

  let best = candidates[0]!;
  for (const c of candidates) {
    const d = Math.abs(c - at);
    const bd = Math.abs(best - at);
    if (d < bd || (d === bd && c < best)) best = c;
  }
  return round4(best);
}

// ---------------------------------------------------------------------------- maintainPosition

export interface MaintainResult {
  offset: number;
  delta: number;
}

/**
 * Keep the visual position across a content mutation.
 *
 * THE INPUT IS AN ANCHOR, not a content-height delta, and that is the whole design. A content
 * height diff cannot tell a prepend from an append, so compensating on it makes an appending
 * chat jump exactly as badly as a prepending one failed to. The anchor is a previously visible
 * child's frame origin before and after the mutation; prepend, append and removal-above then all
 * fall out of ONE formula, and the append case correctly compensates by zero.
 */
export function maintainPositionOffset(
  offset: number,
  anchorBefore: number,
  anchorAfter: number,
  viewportLength: number,
  contentLength: number,
): MaintainResult {
  const limit = Math.max(0, finite(contentLength) - finite(viewportLength));
  const delta = finite(anchorAfter) - finite(anchorBefore);
  return { offset: round4(clamp(finite(offset) + delta, 0, limit)), delta: round4(delta) };
}

// ---------------------------------------------------------------------------- linked properties

export type ScrollProperties = Record<string, string>;

/** The prefix every published key carries. A named plane is spelled by inserting the ref right
 *  after it, so the two families are one family with one namespace. */
const SCROLL_PREFIX = '--scroll-';

/**
 * The unqualified keys the two axis planes own. A named scroller may never publish one of them:
 * `ref="progress"` would otherwise spell `--scroll-progress-x` and shadow the horizontal plane
 * of whatever page it sits on. The reserved key wins and the named twin is simply not published,
 * which keeps the collision a naming inconvenience rather than an action at a distance.
 */
export const RESERVED_SCROLL_KEYS: readonly string[] = [
  '--scroll-y', '--scroll-y-px', '--scroll-progress', '--scroll-velocity',
  '--scroll-remaining', '--scroll-remaining-px',
  '--scroll-x', '--scroll-x-px', '--scroll-progress-x', '--scroll-velocity-x',
  '--scroll-remaining-x', '--scroll-remaining-x-px',
];

/** Points still to travel on an axis, from the CLAMPED offset so rubber-band over-scroll cannot
 *  push it past either end. `--scroll-y` measures from the top and this measures from the
 *  bottom; without it a bottom-anchored effect can only be written in `progress`, which is a
 *  fraction of the content and therefore a different distance on every list. */
function remainingOf(offset: number, max: number): number {
  return finite(max) - clamp(finite(offset), 0, finite(max));
}

/**
 * The plane one scroll node publishes. A node contributes ONLY the plane of its own axis, so a
 * horizontal rail inside a vertical page owns `--scroll-x*` and leaves `--scroll-y*` to the page.
 *
 * Two spellings per length, and this is a CORRECTION to the U01 plan: `--scroll-y` is unitless
 * points so `calc(1 - var(--scroll-y) / 280)` types as a number, and `--scroll-y-px` carries px
 * so `translateY(calc(var(--scroll-y-px) * 0.5))` types as a length. A single property cannot be
 * both, and the plan's example is rejected by every engine, ours and a browser's alike.
 */
export function scrollLinkedProperties(
  axis: ScrollAxis,
  metrics: ScrollMetrics,
  velocity: number,
): ScrollProperties {
  if (axis === 'horizontal') {
    const remaining = remainingOf(metrics.x, metrics.maxX);
    return {
      '--scroll-x': formatNumber(metrics.x),
      '--scroll-x-px': formatNumber(metrics.x) + 'px',
      '--scroll-progress-x': formatNumber(metrics.progressX),
      '--scroll-velocity-x': formatNumber(velocity),
      '--scroll-remaining-x': formatNumber(remaining),
      '--scroll-remaining-x-px': formatNumber(remaining) + 'px',
    };
  }
  const remaining = remainingOf(metrics.y, metrics.maxY);
  return {
    '--scroll-y': formatNumber(metrics.y),
    '--scroll-y-px': formatNumber(metrics.y) + 'px',
    '--scroll-progress': formatNumber(metrics.progress),
    '--scroll-velocity': formatNumber(velocity),
    '--scroll-remaining': formatNumber(remaining),
    '--scroll-remaining-px': formatNumber(remaining) + 'px',
  };
}

/**
 * Whether a `ref` can name a plane. The ref registry treats a name as opaque, but a published
 * key is a CSS custom property, and a name carrying a space or a dot does not spell one - so it
 * publishes NOTHING rather than an unreachable key or, worse, a truncated one that another ref
 * could also spell. The imperative surface behind the same ref is unaffected.
 */
export function isScrollPlaneRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charAt(i);
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
      c === '-' || c === '_';
    if (!ok) return false;
  }
  return true;
}

/**
 * The same plane, published under the node's `ref` and scoped to the DOCUMENT ROOT rather than
 * to the node's descendants.
 *
 * THE CASE THE CASCADE CANNOT SERVE (R27). Pinned chrome - fade edges, a floating back-to-top,
 * a progress rail - sits OVER a scroller and is by definition not inside it, so no cascade can
 * ever reach it; and every way to make it a descendant makes it scroll away. Naming the scroller
 * is the web's own answer to the same problem (`scroll-timeline` + `timeline-scope` name a
 * scroller precisely so something outside its subtree can read it), and it needs no new value
 * grammar here: the key is an ordinary custom property and `var()` already reads it.
 */
export function namedScrollProperties(
  ref: string,
  axis: ScrollAxis,
  metrics: ScrollMetrics,
  velocity: number,
): ScrollProperties {
  if (!isScrollPlaneRef(ref)) return {};
  const out: ScrollProperties = {};
  for (const [key, value] of Object.entries(scrollLinkedProperties(axis, metrics, velocity))) {
    const named = SCROLL_PREFIX + ref + '-' + key.slice(SCROLL_PREFIX.length);
    if (RESERVED_SCROLL_KEYS.indexOf(named) >= 0) continue;
    out[named] = value;
  }
  return out;
}

export interface LinkedAncestor {
  axis: ScrollAxis;
  properties: ScrollProperties;
}

/** One named scroller's contribution to the root scope. */
export interface NamedScrollPlane {
  ref: string;
  properties: ScrollProperties;
}

/**
 * Resolve the properties in scope for an element, from its scroll ancestors NEAREST FIRST, plus
 * every named plane in the document.
 *
 * Each axis resolves independently from its own nearest ancestor, which is what an author
 * expects of a horizontal rail inside a vertical page. An axis with no ancestor contributes
 * NOTHING rather than zero, so `var(--scroll-y, 0)` can tell "no scroller" from "at the top".
 *
 * Named planes are document-wide and apply to every element, ancestor or not. They are merged in
 * document order so a duplicated ref resolves to its LAST provider, which is the ref registry's
 * own law (`Conformance/input/ref.json`) rather than a second opinion about it. A reserved key is
 * dropped here as well as at publication, so a hand-built plane cannot shadow an axis either.
 */
export function resolveLinkedScope(
  ancestors: readonly LinkedAncestor[],
  named: readonly NamedScrollPlane[] = [],
): ScrollProperties {
  const out: ScrollProperties = {};
  for (const plane of named) {
    for (const [key, value] of Object.entries(plane.properties)) {
      if (RESERVED_SCROLL_KEYS.indexOf(key) >= 0) continue;
      out[key] = value;
    }
  }
  let vertical = false;
  let horizontal = false;
  for (const ancestor of ancestors) {
    if (ancestor.axis === 'vertical' && !vertical) {
      Object.assign(out, ancestor.properties);
      vertical = true;
    } else if (ancestor.axis === 'horizontal' && !horizontal) {
      Object.assign(out, ancestor.properties);
      horizontal = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- var()/calc()

/**
 * The native twin of what a browser does for free: substitute `var()`, then fold every `calc()`
 * with CSS's own unit algebra. The web renderer never calls it — the browser owns calc there —
 * but the two native renderers must agree with the browser to the last decimal, so the reference
 * implementation lives here and the corpus judges all three.
 *
 * Anything it cannot type DROPS the declaration (returns null), which is what CSS itself does
 * for a value that is invalid at computed value, and what CssValue already does for a cyclic
 * var() chain.
 */
export function evaluateScrollLinked(expression: string, properties: ScrollProperties): string | null {
  const substituted = substituteVars(expression, properties, 0);
  if (substituted === null) return null;
  let out = '';
  let i = 0;
  for (;;) {
    const at = nextMathFunction(substituted, i);
    if (at === null) {
      out += substituted.slice(i);
      return out;
    }
    out += substituted.slice(i, at.start);
    const close = matchParen(substituted, at.open + 1);
    if (close < 0) return null;
    const folded = foldCalc(substituted.slice(at.start, close + 1));
    if (folded === null) return null;
    out += formatNumber(folded.value) + folded.unit;
    i = close + 1;
  }
}

/** The four CSS math functions this evaluator folds, longest first so `calc` cannot shadow one. */
const MATH_FUNCTIONS = ['clamp(', 'calc(', 'min(', 'max('];

/**
 * The next math function at or after `from`, ignoring one that is only the tail of a longer
 * identifier (`admin(` is not `min(`). Returns where the name starts and where its `(` sits.
 */
function nextMathFunction(source: string, from: number): { start: number; open: number } | null {
  const lower = source.toLowerCase();
  let best: { start: number; open: number } | null = null;
  for (const name of MATH_FUNCTIONS) {
    let at = lower.indexOf(name, from);
    while (at >= 0) {
      const before = at > 0 ? lower[at - 1]! : '';
      const glued = (before >= 'a' && before <= 'z') || (before >= '0' && before <= '9')
        || before === '-' || before === '_';
      if (!glued) {
        if (best === null || at < best.start) best = { start: at, open: at + name.length - 1 };
        break;
      }
      at = lower.indexOf(name, at + 1);
    }
  }
  return best;
}

/** Index of the `)` closing a `(` whose CONTENT starts at `from`, or -1. */
function matchParen(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const VAR_DEPTH_BUDGET = 8;

function substituteVars(source: string, properties: ScrollProperties, depth: number): string | null {
  if (source.indexOf('var(') < 0) return source;
  // A cyclic definition rotates forever; the budget terminates it exactly as CssValue does.
  if (depth > VAR_DEPTH_BUDGET) return null;
  let out = '';
  let i = 0;
  for (;;) {
    const at = source.indexOf('var(', i);
    if (at < 0) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, at);
    const close = matchParen(source, at + 4);
    if (close < 0) return null;
    const inner = source.slice(at + 4, close);
    const comma = splitTopLevel(inner, ',');
    const name = comma[0]!.trim();
    const fallback = comma.length > 1 ? comma.slice(1).join(',').trim() : null;
    if (Object.prototype.hasOwnProperty.call(properties, name)) out += properties[name]!;
    else if (fallback !== null) out += fallback;
    else return null;
    i = close + 1;
  }
  return substituteVars(out, properties, depth + 1);
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of source) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

interface Dimension {
  value: number;
  unit: string;
}

// `m` / `x` / `c` are the heads of min() / max() / clamp(); each is followed by its own `(`, so
// the parser reads a function exactly the way it reads a parenthesised group plus an arity.
type Token =
  | { kind: '(' | ')' | '+' | '-' | '*' | '/' | ',' | 'm' | 'x' | 'c' }
  | { kind: 'num'; value: number; unit: string };

const CALC_UNITS = ['rem', 'deg', 'ms', 'em', 'px', 'pt', 'vh', 'vw', '%', 's'];

function tokenizeCalc(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '+' || ch === '-' || ch === '*' || ch === '/'
        || ch === ',') {
      tokens.push({ kind: ch });
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      while (j < source.length && ((source[j]! >= '0' && source[j]! <= '9') || source[j] === '.')) j += 1;
      const value = Number(source.slice(i, j));
      if (!Number.isFinite(value)) return null;
      let unit = '';
      for (const candidate of CALC_UNITS) {
        if (source.slice(j, j + candidate.length).toLowerCase() === candidate) {
          unit = candidate;
          j += candidate.length;
          break;
        }
      }
      tokens.push({ kind: 'num', value, unit });
      i = j;
      continue;
    }
    if (source.slice(i, i + 5).toLowerCase() === 'calc(') {
      tokens.push({ kind: '(' });
      i += 5;
      continue;
    }
    if (source.slice(i, i + 4).toLowerCase() === 'min(') {
      tokens.push({ kind: 'm' }, { kind: '(' });
      i += 4;
      continue;
    }
    if (source.slice(i, i + 4).toLowerCase() === 'max(') {
      tokens.push({ kind: 'x' }, { kind: '(' });
      i += 4;
      continue;
    }
    if (source.slice(i, i + 6).toLowerCase() === 'clamp(') {
      tokens.push({ kind: 'c' }, { kind: '(' });
      i += 6;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * Fold one math function, HEAD INCLUDED (`calc(…)`, `min(…)`, `max(…)`, `clamp(…)`, nested
 * freely). CSS's unit algebra, and nothing beyond it: `+`/`-` need matching units
 * (zero being the one unitless length), at most one operand of a product may carry a unit, and a
 * divisor must be a non-zero number. Every refusal returns null so the caller drops the whole
 * declaration rather than shipping a half-typed value.
 */
/**
 * `min()` / `max()` / `clamp()`. CSS compares LIKE with LIKE, so every argument must carry the
 * same unit - a bound is meaningless between a length and a ratio - and `clamp()` is exactly
 * three arguments, folded as `max(low, min(value, high))`, which is CSS's own definition and is
 * what makes an inverted pair resolve to the low bound rather than to nothing.
 */
function compare(fn: 'm' | 'x' | 'c', args: readonly Dimension[]): Dimension | null {
  if (args.length === 0) return null;
  const unit = args[0]!.unit;
  for (const arg of args) if (arg.unit !== unit) return null;
  if (fn === 'c') {
    if (args.length !== 3) return null;
    const [low, value, high] = args as [Dimension, Dimension, Dimension];
    return { value: Math.max(low.value, Math.min(value.value, high.value)), unit };
  }
  let out = args[0]!.value;
  for (const arg of args) out = fn === 'm' ? Math.min(out, arg.value) : Math.max(out, arg.value);
  return { value: out, unit };
}

function foldCalc(body: string): Dimension | null {
  const parsed = tokenizeCalc(body);
  if (parsed === null) return null;
  // Declared non-nullable rather than narrowed: the recursive-descent helpers below are HOISTED
  // function declarations, and the null check above does not reach across a hoist.
  const tokens: Token[] = parsed;
  let pos = 0;
  const peek = (): string | null => (pos < tokens.length ? tokens[pos]!.kind : null);

  function primary(): Dimension | null {
    const kind = peek();
    if (kind === '(') {
      pos += 1;
      const inner = sum();
      if (inner === null || peek() !== ')') return null;
      pos += 1;
      return inner;
    }
    if (kind === '-') {
      pos += 1;
      const inner = primary();
      return inner === null ? null : { value: -inner.value, unit: inner.unit };
    }
    if (kind === '+') {
      pos += 1;
      return primary();
    }
    if (kind === 'm' || kind === 'x' || kind === 'c') {
      pos += 1;
      if (peek() !== '(') return null;
      pos += 1;
      const args: Dimension[] = [];
      for (;;) {
        const arg = sum();
        if (arg === null) return null;
        args.push(arg);
        if (peek() !== ',') break;
        pos += 1;
      }
      if (peek() !== ')') return null;
      pos += 1;
      return compare(kind, args);
    }
    if (kind === 'num') {
      const token = tokens[pos] as { kind: 'num'; value: number; unit: string };
      pos += 1;
      return { value: token.value, unit: token.unit };
    }
    return null;
  }

  function product(): Dimension | null {
    let left = primary();
    if (left === null) return null;
    for (;;) {
      const op = peek();
      if (op !== '*' && op !== '/') return left;
      pos += 1;
      const right = primary();
      if (right === null) return null;
      if (op === '*') {
        if (left.unit && right.unit) return null; // CSS has no square pixels.
        left = { value: left.value * right.value, unit: left.unit || right.unit };
      } else {
        if (right.unit) return null; // Division BY a dimension is not a CSS operation.
        if (right.value === 0) return null; // An infinity in a declaration is a dropped declaration.
        left = { value: left.value / right.value, unit: left.unit };
      }
    }
  }

  function sum(): Dimension | null {
    let left = product();
    if (left === null) return null;
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') return left;
      pos += 1;
      const right = product();
      if (right === null) return null;
      let unit: string = left.unit;   // annotated: `left` is reassigned from `unit` below, so inference is circular
      if (left.unit && right.unit) {
        if (left.unit !== right.unit) return null;
      } else if (left.unit && !right.unit) {
        if (right.value !== 0) return null;
      } else if (!left.unit && right.unit) {
        if (left.value !== 0) return null;
        unit = right.unit;
      }
      left = { value: op === '+' ? left.value + right.value : left.value - right.value, unit };
    }
  }

  const result = sum();
  if (result === null || pos !== tokens.length) return null;
  return result;
}

// ---------------------------------------------------------------------------- collapse (U10)

export interface CollapseInput {
  scrollY: number;
  height?: number;
  minHeight?: number;
  pinnedHeight?: number;
  parallax?: number;
  stretch?: boolean;
  blurOnCollapse?: boolean;
  titleTransition?: TitleTransition;
  reduceMotion?: boolean;
}

export interface CollapseState {
  fraction: number;
  headerHeight: number;
  effectiveMinHeight: number;
  imageTranslation: number;
  imageScale: number;
  effectiveParallax: number;
  headerTitleOpacity: number;
  navBarTitleOpacity: number;
  titleOwner: 'header' | 'navbar';
  blurRadius: number;
  pinnedOffset: number;
}

/**
 * `<CollapsingHeader>` (U10), which is a pure function of `--scroll-y` and therefore lives here.
 *
 * THE TITLE IS ONE ACCESSIBILITY ELEMENT AT EVERY FRACTION, and that is enforced by construction
 * rather than by review: `titleOwner` is a single value, and under `move` the header's opacity
 * reaches 0 exactly where the nav bar's leaves 0. A naive implementation cross-fades the two over
 * the whole range and a screen reader then finds the title twice, which is the defect this
 * pattern produces when implemented the obvious way.
 *
 * THE PINNED SLOT RAISES THE FLOOR. `effectiveMinHeight` is max(minHeight, pinnedHeight), so
 * content that must survive the collapse cannot be clipped by a minHeight the author chose
 * before adding it.
 *
 * REDUCED MOTION zeroes parallax and keeps everything else: the collapse is LAYOUT and must
 * still happen, and `stretch` survives because it tracks the finger one to one rather than
 * animating on its own, which is not what the vestibular guidance is about.
 */
export function collapseState(input: CollapseInput): CollapseState {
  const height = Math.max(0, finite(input.height ?? 280));
  const pinned = Math.max(0, finite(input.pinnedHeight ?? 0));
  const minHeight = clamp(Math.max(finite(input.minHeight ?? NAV_BAR_HEIGHT), pinned), 0, height);
  const scrollY = finite(input.scrollY);
  const parallax = clamp(finite(input.parallax ?? 0.5), 0, 1);
  const stretch = input.stretch ?? true;
  const transition: TitleTransition = input.titleTransition ?? 'move';
  const reduceMotion = input.reduceMotion ?? false;

  const range = Math.max(0, height - minHeight);
  // The degenerate case answers 0, matching metrics.json: nothing to collapse means the RESTING
  // state, because booting into the collapsed look on a short page is the visible bug.
  const fraction = range <= 0 ? 0 : clamp(scrollY / range, 0, 1);

  const stretching = scrollY < 0 && stretch;
  const headerHeight = stretching ? height - scrollY : height - fraction * range;
  const imageScale = stretching && height > 0 ? (height - scrollY) / height : 1;

  const effectiveParallax = reduceMotion ? 0 : parallax;
  // Clamped to the range: once the header has stopped shrinking there is nothing left to move
  // the image against, and an unclamped translation walks the image out of its own header.
  const imageTranslation = clamp(scrollY, 0, range) * effectiveParallax;

  let headerTitleOpacity: number;
  let navBarTitleOpacity: number;
  let titleOwner: 'header' | 'navbar';
  if (transition === 'move') {
    headerTitleOpacity = clamp(1 - fraction / TITLE_HANDOFF_FRACTION, 0, 1);
    navBarTitleOpacity = clamp((fraction - TITLE_HANDOFF_FRACTION) / (1 - TITLE_HANDOFF_FRACTION), 0, 1);
    titleOwner = fraction >= TITLE_HANDOFF_FRACTION ? 'navbar' : 'header';
  } else if (transition === 'fade') {
    headerTitleOpacity = clamp(1 - fraction, 0, 1);
    navBarTitleOpacity = 0;
    titleOwner = 'header';
  } else {
    headerTitleOpacity = 1;
    navBarTitleOpacity = 0;
    titleOwner = 'header';
  }

  return {
    fraction: round4(fraction),
    headerHeight: round4(headerHeight),
    effectiveMinHeight: round4(minHeight),
    imageTranslation: round4(imageTranslation),
    imageScale: round4(imageScale),
    effectiveParallax: round4(effectiveParallax),
    headerTitleOpacity: round4(headerTitleOpacity),
    navBarTitleOpacity: round4(navBarTitleOpacity),
    titleOwner,
    blurRadius: round4((input.blurOnCollapse ?? false) ? fraction * BLUR_MAX : 0),
    pinnedOffset: round4(Math.max(0, headerHeight - pinned)),
  };
}

/** `on:collapse` is quantised to a hundredth of the range, with the endpoints ALWAYS emitted so
 *  a handler can rely on seeing exactly 0 and exactly 1. */
export function shouldEmitCollapse(previousFraction: number | null, fraction: number): boolean {
  if (previousFraction === null) return true;
  if (fraction !== previousFraction && (fraction === 0 || fraction === 1)) return true;
  return Math.abs(fraction - previousFraction) >= COLLAPSE_EPSILON;
}

// ---------------------------------------------------------------------------- attributes

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ScrollConfig {
  axis: ScrollAxis;
  bind: string | null;
  indicators: boolean;
  /** TRISTATE. null is not `true`: it means the PLATFORM decides, and collapsing that to a
   *  boolean is how a framework ends up overriding iOS's own bounce on every scroll view. */
  bounces: boolean | null;
  paging: boolean;
  snap: SnapMode;
  keyboardDismiss: KeyboardDismiss;
  overscroll: Overscroll;
  contentInset: EdgeInsets;
  maintainPosition: boolean;
  threshold: number;
}

type Attributes = Record<string, string | null | undefined>;

function boolAttribute(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  const word = value.trim().toLowerCase();
  if (word === 'false' || word === '0' || word === 'no' || word === 'off') return false;
  if (word === 'true' || word === '1' || word === 'yes' || word === 'on' || word === '') return true;
  return fallback;
}

function numberAttribute(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  // An empty string is ABSENCE, not zero: Number('') is 0 in JS and null in Kotlin/Swift, and a
  // twin that disagrees on the empty attribute disagrees on every unset one.
  const text = value.trim().replace(/%$/, '').replace(/px$/i, '').replace(/pt$/i, '');
  if (text === '') return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

function wordAttribute<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  if (value === null || value === undefined) return fallback;
  const word = value.trim().toLowerCase();
  for (const candidate of allowed) if (candidate.toLowerCase() === word) return candidate;
  return fallback;
}

/** CSS edge shorthand, exactly: 1, 2, 3 or 4 values. An author who has written CSS knows it. */
export function parseEdgeInsets(value: string | null | undefined): EdgeInsets {
  const zero: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (value === null || value === undefined) return zero;
  const parts = value.replace(/,/g, ' ').split(/\s+/).filter((p) => p.length > 0);
  const nums = parts.map((p) => numberAttribute(p, 0));
  if (nums.length === 0) return zero;
  if (nums.length === 1) return { top: round4(nums[0]!), right: round4(nums[0]!), bottom: round4(nums[0]!), left: round4(nums[0]!) };
  if (nums.length === 2) return { top: round4(nums[0]!), right: round4(nums[1]!), bottom: round4(nums[0]!), left: round4(nums[1]!) };
  if (nums.length === 3) return { top: round4(nums[0]!), right: round4(nums[1]!), bottom: round4(nums[2]!), left: round4(nums[1]!) };
  return { top: round4(nums[0]!), right: round4(nums[1]!), bottom: round4(nums[2]!), left: round4(nums[3]!) };
}

/**
 * The whole `<scroll>` attribute table, folded through ONE total function: no input throws, no
 * unrecognised word fails a build, and every unknown value falls back to the documented default.
 * These values come from authored markup and a dashboard field, not from a schema.
 *
 * `paging` and `snap` are one setting with two spellings, so paging resolves to `page` and
 * outranks a declared snap word rather than silently fighting it.
 */
export function parseScrollConfig(attributes: Attributes): ScrollConfig {
  const paging = boolAttribute(attributes['paging'], false);
  const snapWord = wordAttribute(attributes['snap'], ['none', 'start', 'center', 'end'] as const, 'none');
  const bounces = attributes['bounces'];
  return {
    axis: wordAttribute(attributes['axis'] ?? attributes['direction'], ['vertical', 'horizontal'] as const, 'vertical'),
    bind: attributes['bind'] ?? null,
    indicators: boolAttribute(attributes['indicators'], true),
    bounces: bounces === null || bounces === undefined ? null : boolAttribute(bounces, true),
    paging,
    snap: paging ? 'page' : snapWord,
    keyboardDismiss: wordAttribute(
      attributes['keyboardDismiss'],
      ['none', 'onDrag', 'interactive'] as const,
      'interactive',
    ),
    overscroll: wordAttribute(attributes['overscroll'], ['auto', 'never', 'always'] as const, 'auto'),
    contentInset: parseEdgeInsets(attributes['contentInset']),
    maintainPosition: boolAttribute(attributes['maintainPosition'], false),
    threshold: round4(Math.max(0, numberAttribute(attributes['threshold'], 0))),
  };
}
