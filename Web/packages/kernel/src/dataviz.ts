//
//  dataviz.ts — the shared `<chart>` / `<map>` numeric core: scale domains and ticks, mark
//  geometry, interaction payload arithmetic, the accessible table, web-mercator camera maths
//  and pin clustering. The law is the corpus, OpenSource/Conformance/dataviz/ (six files —
//  scales · marks · interaction · a11y · camera · cluster; parity/U09-dataviz.md); the Kotlin
//  twin is :core Dataviz.kt and the Swift twin is Engine/iOS/Dataviz.swift, and all three run
//  the SAME files.
//
//  Everything platform-shaped lives OUTSIDE this file. Swift Charts, the Compose canvas and
//  the DOM renderer paint pixels three different ways; what they may NOT do is disagree on
//  where a datum lands, how many gridlines there are, which pins share a cluster, or what a
//  screen reader is told. Keeping the DECISION separate from the PAINTING is what lets one
//  corpus judge three renderers.
//
//  Two rules that look like fussiness and are not:
//   * the decimal exponent and powers of ten are integer LOOPS, never log10/pow — libm
//     rounding differs between platforms and floor(log10(1000)) is allowed to come back 2,
//     which silently moves every tick on one renderer only;
//   * the cluster level is floor(zoom), never zoom — a continuous grid slides continuously,
//     so markers visibly flicker while the user pinches.
//

// ── shared shapes ───────────────────────────────────────────────────────────────────────

/** A resolved numeric axis: the extended bounds, the tick step, and the ticks themselves. */
export interface NiceDomain {
  readonly lo: number;
  readonly hi: number;
  readonly step: number;
  readonly ticks: readonly number[];
}

/** A d3-shaped band scale: one slot per category, padded inside and out. */
export interface BandLayout {
  readonly step: number;
  readonly bandwidth: number;
  readonly start: number;
  readonly positions: readonly number[];
  readonly centers: readonly number[];
}

/** A log axis, or the typed refusal that replaces a silent clamp on a non-positive domain. */
export interface LogDomain {
  readonly valid: boolean;
  readonly reason: string;
  readonly lo: number;
  readonly hi: number;
  readonly ticks: readonly number[];
}

/** A time axis over FIXED durations (no calendar months — a month is not a duration). */
export interface TimeTicks {
  readonly step: number;
  readonly ticks: readonly number[];
}

/** A window on a domain: the payload shape of zoom, pan and the brush. */
export interface DomainWindow {
  readonly lo: number;
  readonly hi: number;
}

// ── scales: the arithmetic before a single pixel ────────────────────────────────────────

/**
 * floor(log10(|x|)), by an integer loop.
 *
 * Never `Math.log10` + `Math.floor`: libm is entitled to return 2.9999999999999996 for
 * log10(1000), and one renderer's axis then steps differently from the other two. Zero has
 * no exponent; it answers 0 so callers never see a NaN.
 */
export function decimalExponent(x: number): number {
  let a = Math.abs(x);
  if (a === 0 || !Number.isFinite(a)) return 0;
  let e = 0;
  while (a >= 10) { a /= 10; e += 1; }
  while (a < 1) { a *= 10; e -= 1; }
  return e;
}

/** 10^n, by an integer loop, for the same reason `decimalExponent` is one. */
export function powerOfTen(n: number): number {
  const k = Math.abs(Math.trunc(n));
  let r = 1;
  for (let i = 0; i < k; i += 1) r *= 10;
  return n < 0 ? 1 / r : r;
}

/**
 * Heckbert's nice number: the closest "human" number to `x` — 1, 2, 5 or 10 times a power
 * of ten. `round` picks the nearest; otherwise it rounds UP, which is what an axis range
 * wants so the data always fits inside it.
 */
export function niceNumber(x: number, round: boolean): number {
  if (!(x > 0)) return 0;
  const exp = decimalExponent(x);
  const f = x / powerOfTen(exp);
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * powerOfTen(exp);
}

/** The padding a zero-span domain gets before it is made nice, so one datum is not a line. */
const ZERO_SPAN_PAD = 0.5;

/**
 * Heckbert loose labelling: the domain EXTENDS to the nice bounds rather than the ticks
 * shrinking inside it, so the first and last tick are always the axis ends. Reversed bounds
 * are ordered first; a zero span is padded before it is made nice.
 *
 * Ticks are `lo + i * step`, never an accumulator — accumulating drifts, and a tick that
 * reads 5.000000000000001 on one renderer and 5 on another is a diff nobody can explain.
 */
export function niceLinearDomain(lo: number, hi: number, count: number): NiceDomain {
  let low = Math.min(lo, hi);
  let high = Math.max(lo, hi);
  if (low === high) { low -= ZERO_SPAN_PAD; high += ZERO_SPAN_PAD; }
  const n = Math.max(2, Math.trunc(count));
  const range = niceNumber(high - low, false);
  const step = niceNumber(range / (n - 1), true);
  if (!(step > 0)) return { lo: low, hi: high, step: 0, ticks: [low] };
  const gLo = Math.floor(low / step) * step;
  const gHi = Math.ceil(high / step) * step;
  const steps = Math.max(0, Math.round((gHi - gLo) / step));
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i += 1) ticks.push(gLo + i * step);
  return { lo: gLo, hi: gHi, step, ticks };
}

/**
 * The axis a series actually gets. `includeZero` is the bar/area rule (a bar that does not
 * start at zero lies about its length); a line does not invent a zero it was never given.
 * An empty series is a unit domain, not a NaN.
 */
export function valueDomain(
  values: readonly number[],
  includeZero: boolean,
  count: number,
): NiceDomain {
  if (values.length === 0) return niceLinearDomain(0, 1, count);
  let lo = values[0]!;
  let hi = values[0]!;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  return niceLinearDomain(lo, hi, count);
}

/** Map a value onto a range. An inverted range is the y axis; a degenerate domain lands mid. */
export function linearScale(
  v: number,
  domain: readonly [number, number],
  range: readonly [number, number],
): number {
  if (domain[1] === domain[0]) return (range[0] + range[1]) / 2;
  return range[0] + ((v - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
}

/**
 * The d3 band scale, verbatim: `step = span / (count - paddingInner + 2 * paddingOuter)`,
 * `bandwidth = step * (1 - paddingInner)`, and the leftover centred by `align`.
 */
export function bandScale(
  count: number,
  range: readonly [number, number],
  paddingInner: number,
  paddingOuter: number,
  align: number,
): BandLayout {
  const span = range[1] - range[0];
  if (count <= 0) {
    return { step: 0, bandwidth: 0, start: range[0], positions: [], centers: [] };
  }
  const divisor = Math.max(1e-12, count - paddingInner + 2 * paddingOuter);
  const step = span / divisor;
  const bandwidth = step * (1 - paddingInner);
  const start = range[0] + (span - step * (count - paddingInner)) * align;
  const positions: number[] = [];
  const centers: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = start + step * i;
    positions.push(p);
    centers.push(p + bandwidth / 2);
  }
  return { step, bandwidth, start, positions, centers };
}

/** The decade a value's upper bound rounds up to (exact powers of ten stay put). */
function decimalExponentCeiling(x: number): number {
  const e = decimalExponent(x);
  return powerOfTen(e) === x ? e : e + 1;
}

/** The refusal a log axis reports rather than clamping a non-positive bound into existence. */
export const LOG_NONPOSITIVE_DOMAIN = "nonpositive_domain";

/**
 * The log decade ladder. The domain extends to whole decades; two decades or fewer get the
 * 1-2-5 ladder inside each, more get plain decades on a stride that keeps the label count
 * near `maxTicks`.
 *
 * A non-positive bound is a TYPED REFUSAL, never a silent clamp to some epsilon: a log axis
 * over data containing a zero is an authoring mistake and the author has to see it.
 */
export function logDomain(lo: number, hi: number, maxTicks: number): LogDomain {
  if (!(lo > 0) || !(hi > 0)) {
    return { valid: false, reason: LOG_NONPOSITIVE_DOMAIN, lo: 0, hi: 0, ticks: [] };
  }
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  const loDec = decimalExponent(low);
  let hiDec = decimalExponentCeiling(high);
  if (hiDec <= loDec) hiDec = loDec + 1;
  const decades = hiDec - loDec;
  const ticks: number[] = [];
  if (decades <= 2) {
    for (let d = loDec; d < hiDec; d += 1) {
      const base = powerOfTen(d);
      ticks.push(base, 2 * base, 5 * base);
    }
  } else {
    const stride = Math.max(1, Math.ceil(decades / Math.max(1, Math.trunc(maxTicks))));
    for (let d = loDec; d < hiDec; d += stride) ticks.push(powerOfTen(d));
  }
  ticks.push(powerOfTen(hiDec));
  return { valid: true, reason: "", lo: powerOfTen(loDec), hi: powerOfTen(hiDec), ticks };
}

/** Position on a log axis. A non-positive value pins to the range start rather than -Inf. */
export function logScale(
  v: number,
  domain: readonly [number, number],
  range: readonly [number, number],
): number {
  if (!(domain[0] > 0) || !(domain[1] > 0) || domain[0] === domain[1]) return range[0];
  if (!(v > 0)) return range[0];
  const t = (Math.log(v) - Math.log(domain[0])) / (Math.log(domain[1]) - Math.log(domain[0]));
  return range[0] + t * (range[1] - range[0]);
}

/**
 * The fixed-duration ladder, in seconds. Every entry is a duration a human names — a
 * quarter minute, a quarter hour, six hours, a week. No months and no years: a month is not
 * a duration, and a ladder that pretends otherwise ticks 28, 30 or 31 days apart depending
 * on where the window happens to start.
 */
export const TIME_TICK_LADDER: readonly number[] = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200,
  86400, 172800, 604800,
];

const SECONDS_PER_DAY = 86400;

/**
 * Ticks on a time axis, in epoch seconds. Ticks snap to the STEP GRID rather than to the
 * window start, so a chart of the last hour puts labels on the quarter hours instead of on
 * whatever second the user opened the screen, and they stay INSIDE the domain.
 */
export function timeTicks(lo: number, hi: number, count: number): TimeTicks {
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  if (low === high) return { step: 1, ticks: [low] };
  const n = Math.max(2, Math.trunc(count));
  const target = (high - low) / (n - 1);
  let step = 0;
  for (const candidate of TIME_TICK_LADDER) {
    if (candidate >= target) { step = candidate; break; }
  }
  if (step === 0) step = niceNumber(target / SECONDS_PER_DAY, true) * SECONDS_PER_DAY;
  if (!(step > 0)) return { step: 1, ticks: [low] };
  const first = Math.ceil(low / step - 1e-9);
  const last = Math.floor(high / step + 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i += 1) ticks.push(i * step);
  return { step, ticks };
}

// ── marks: datum to coordinate ──────────────────────────────────────────────────────────

const DEGREES = Math.PI / 180;

/** One slice of a pie or donut, with the centroid a label or a callout anchors to. */
export interface PieSlice {
  readonly index: number;
  readonly value: number;
  readonly fraction: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly sweep: number;
  readonly centroidX: number;
  readonly centroidY: number;
  /** A lone slice is a CIRCLE. A renderer that draws it as a 360-degree arc draws nothing. */
  readonly full: boolean;
}

/** A resolved pie: the slices plus the radii, or `empty` when there is nothing to divide. */
export interface PieLayout {
  readonly total: number;
  readonly empty: boolean;
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly slices: readonly PieSlice[];
}

/** How a pie is laid out. `innerRadius` <= 1 is a fraction of the outer; above 1 is points. */
export interface PieOptions {
  readonly outerRadius: number;
  readonly innerRadius: number;
  readonly startAngle: number;
  readonly padAngle: number;
  readonly clockwise: boolean;
}

/**
 * Pie / donut geometry. Angles are DEGREES, screen-oriented: -90 is twelve o'clock, +y is
 * down, and a clockwise pie sweeps toward +x first.
 *
 * Negative values are SKIPPED, keeping their index, never folded into the total — a pie of a
 * signed series is meaningless, and quietly taking absolute values is how it ships anyway.
 * A total of zero is `empty`, not a division by zero.
 */
export function pieSlices(values: readonly number[], options: PieOptions): PieLayout {
  const inner = options.innerRadius <= 1
    ? options.innerRadius * options.outerRadius
    : options.innerRadius;
  let total = 0;
  for (const v of values) if (v > 0) total += v;
  if (!(total > 0)) {
    return {
      total: 0, empty: true, innerRadius: inner, outerRadius: options.outerRadius, slices: [],
    };
  }
  const centroidRadius = (inner + options.outerRadius) / 2;
  const slices: PieSlice[] = [];
  let cursor = options.startAngle;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (!(v > 0)) continue;
    const fraction = v / total;
    const raw = fraction * 360;
    const sweep = Math.max(0, raw - options.padAngle);
    const startAngle = cursor;
    const endAngle = options.clockwise ? cursor + sweep : cursor - sweep;
    cursor = options.clockwise ? cursor + raw : cursor - raw;
    const mid = (startAngle + endAngle) / 2;
    slices.push({
      index: i,
      value: v,
      fraction,
      startAngle,
      endAngle,
      sweep,
      centroidX: centroidRadius * Math.cos(mid * DEGREES),
      centroidY: centroidRadius * Math.sin(mid * DEGREES),
      full: Math.abs(sweep) >= 360 - 1e-9,
    });
  }
  return {
    total, empty: false, innerRadius: inner, outerRadius: options.outerRadius, slices,
  };
}

/**
 * Bubble radius for a scatter `size` field. Interpolates AREA, not radius, because the eye
 * reads area: a datum twice as large must cover twice the ink, and a linear radius ramp
 * makes it cover four times. An all-equal series takes the midpoint rather than the floor —
 * every bubble at `rMin` reads as "no data" instead of "all the same".
 */
export function bubbleRadius(
  v: number, min: number, max: number, rMin: number, rMax: number,
): number {
  if (!(max > min)) return (rMin + rMax) / 2;
  let t = (v - min) / (max - min);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return Math.sqrt(rMin * rMin + t * (rMax * rMax - rMin * rMin));
}

/** One vertex of a radar polygon. */
export interface RadarPoint {
  readonly index: number;
  readonly fraction: number;
  readonly angle: number;
  readonly x: number;
  readonly y: number;
}

/** Radar / spider vertices: axis 0 at twelve o'clock, then clockwise, clamped to the ring. */
export function radarPoints(
  values: readonly number[],
  max: number,
  radius: number,
  centerX: number,
  centerY: number,
): RadarPoint[] {
  const n = values.length;
  const out: RadarPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    let fraction = max > 0 ? values[i]! / max : 0;
    if (fraction < 0) fraction = 0;
    if (fraction > 1) fraction = 1;
    const angle = -90 + (360 * i) / n;
    out.push({
      index: i,
      fraction,
      angle,
      x: centerX + radius * fraction * Math.cos(angle * DEGREES),
      y: centerY + radius * fraction * Math.sin(angle * DEGREES),
    });
  }
  return out;
}

/** One trapezoid of a funnel, plus the two conversion ratios the label wants. */
export interface FunnelStage {
  readonly index: number;
  readonly topWidth: number;
  readonly bottomWidth: number;
  readonly top: number;
  readonly bottom: number;
  readonly ofFirst: number;
  readonly ofPrevious: number;
}

/**
 * Funnel stages. Widths are normalised by the LARGEST value (a widening stage is drawn, not
 * clamped — a funnel that hides a stage growing is hiding the interesting one), while the
 * ratios are against the first and the previous stage. The last stage is a rectangle: a
 * taper to nothing implies a conversion to zero that the data never said.
 */
export function funnelStages(
  values: readonly number[], width: number, height: number, gap: number,
): FunnelStage[] {
  const n = values.length;
  if (n === 0) return [];
  let max = values[0]!;
  for (const v of values) if (v > max) max = v;
  const stageHeight = (height - gap * (n - 1)) / n;
  const first = values[0]!;
  const out: FunnelStage[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = values[i]!;
    const next = i + 1 < n ? values[i + 1]! : v;
    const previous = i === 0 ? v : values[i - 1]!;
    const top = i * (stageHeight + gap);
    out.push({
      index: i,
      topWidth: max > 0 ? (width * v) / max : 0,
      bottomWidth: max > 0 ? (width * next) / max : 0,
      top,
      bottom: top + stageHeight,
      ofFirst: first === 0 ? 0 : v / first,
      ofPrevious: i === 0 ? 1 : (previous === 0 ? 0 : v / previous),
    });
  }
  return out;
}

/** Which way a candle closed. `flat` is a doji and still gets a visible body. */
export type CandleDirection = "up" | "down" | "flat";

/** One OHLC bucket folded out of a tick stream. */
export interface Candle {
  readonly bucket: number;
  readonly start: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly count: number;
  readonly direction: CandleDirection;
}

/** A timestamped scalar — the input a candlestick or a heat map is folded from. */
export interface TimePoint { readonly t: number; readonly v: number }

/**
 * Fold a tick stream into OHLC buckets on a fixed grid anchored at `origin`.
 *
 * Empty buckets are SKIPPED, never emitted as zeros: a market that did not trade is not a
 * market that traded at zero, and a chart that draws the gap as a crash is worse than a
 * chart with a gap. Points are ordered by (t, arrival) first, so `open` and `close` do not
 * depend on the platform's sort being stable.
 */
export function candleBuckets(
  points: readonly TimePoint[], interval: number, origin: number,
): Candle[] {
  if (!(interval > 0) || points.length === 0) return [];
  const order: number[] = points.map((_, i) => i);
  order.sort((a, b) => (points[a]!.t - points[b]!.t) || (a - b));
  const byBucket = new Map<number, {
    bucket: number; start: number; open: number; high: number;
    low: number; close: number; count: number;
  }>();
  for (const i of order) {
    const p = points[i]!;
    const bucket = Math.floor((p.t - origin) / interval);
    const existing = byBucket.get(bucket);
    if (existing === undefined) {
      byBucket.set(bucket, {
        bucket,
        start: origin + bucket * interval,
        open: p.v, high: p.v, low: p.v, close: p.v, count: 1,
      });
    } else {
      if (p.v > existing.high) existing.high = p.v;
      if (p.v < existing.low) existing.low = p.v;
      existing.close = p.v;
      existing.count += 1;
    }
  }
  const buckets = [...byBucket.keys()].sort((a, b) => a - b);
  return buckets.map((b) => {
    const c = byBucket.get(b)!;
    return {
      bucket: c.bucket,
      start: c.start,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      count: c.count,
      direction: candleDirection(c.open, c.close),
    };
  });
}

function candleDirection(open: number, close: number): CandleDirection {
  if (close > open) return "up";
  if (close < open) return "down";
  return "flat";
}

/** Where one candle's body and wick land, in range units (y grows downward). */
export interface CandleGeometry {
  readonly bodyTop: number;
  readonly bodyBottom: number;
  readonly wickTop: number;
  readonly wickBottom: number;
  readonly direction: CandleDirection;
}

/**
 * One candle's pixels. The range is screen-oriented: `range[1]` is the BOTTOM, so the
 * domain maximum sits at `range[0]`.
 *
 * A doji (open === close) is expanded to `minBody` around its centre — a zero-height body
 * is invisible, and the flat day is exactly the one a reader is looking for.
 */
export function candleGeometry(
  open: number, high: number, low: number, close: number,
  domain: readonly [number, number],
  range: readonly [number, number],
  minBody: number,
): CandleGeometry {
  const y = (v: number): number => {
    if (domain[1] === domain[0]) return (range[0] + range[1]) / 2;
    return range[1] - ((v - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
  };
  const yOpen = y(open);
  const yClose = y(close);
  let bodyTop = Math.min(yOpen, yClose);
  let bodyBottom = Math.max(yOpen, yClose);
  if (bodyBottom - bodyTop < minBody) {
    const mid = (bodyTop + bodyBottom) / 2;
    bodyTop = mid - minBody / 2;
    bodyBottom = mid + minBody / 2;
  }
  return {
    bodyTop,
    bodyBottom,
    wickTop: y(high),
    wickBottom: y(low),
    direction: candleDirection(open, close),
  };
}

/** One heat-map cell: its bin, the summed weight, and that weight against the hottest cell. */
export interface HeatmapCell {
  readonly xBin: number;
  readonly yBin: number;
  readonly value: number;
  readonly intensity: number;
}

/** The whole grid, row-major (yBin outer, xBin inner), plus the maximum it normalises by. */
export interface HeatmapGrid {
  readonly max: number;
  readonly cells: readonly HeatmapCell[];
}

/** A weighted point — the input a heat map (chart or map overlay) is folded from. */
export interface WeightedPoint {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/**
 * Bin weighted points into a heat-map grid.
 *
 * The last bin owns its own upper edge: `floor(t * bins)` puts the domain maximum in a
 * phantom bin `bins`, which is the off-by-one every heat map ships once. Out-of-domain
 * points clamp into the edge bins rather than vanishing, and an empty grid is zero
 * intensity everywhere, never NaN.
 */
export function heatmapCells(
  points: readonly WeightedPoint[],
  xBins: number,
  yBins: number,
  xDomain: readonly [number, number],
  yDomain: readonly [number, number],
): HeatmapGrid {
  if (xBins <= 0 || yBins <= 0) return { max: 0, cells: [] };
  const grid = new Array<number>(xBins * yBins).fill(0);
  for (const p of points) {
    const bx = binIndex(p.x, xDomain, xBins);
    const by = binIndex(p.y, yDomain, yBins);
    grid[by * xBins + bx] += p.w;
  }
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  const cells: HeatmapCell[] = [];
  for (let by = 0; by < yBins; by += 1) {
    for (let bx = 0; bx < xBins; bx += 1) {
      const value = grid[by * xBins + bx]!;
      cells.push({ xBin: bx, yBin: by, value, intensity: max > 0 ? value / max : 0 });
    }
  }
  return { max, cells };
}

function binIndex(v: number, domain: readonly [number, number], bins: number): number {
  if (domain[1] === domain[0]) return 0;
  const i = Math.floor(((v - domain[0]) / (domain[1] - domain[0])) * bins);
  if (i < 0) return 0;
  if (i > bins - 1) return bins - 1;
  return i;
}

// ── interaction: what on:select / on:hover / on:brush actually carry ─────────────────────

/**
 * The index a tap at `fraction` across the plot selects. This is the rule the shipped
 * renderers already use for `on:select`, lifted out so `on:hover` inherits it exactly
 * instead of growing a second, subtly different one.
 *
 * An empty series answers -1 — a typed absence, never index 0 pointing at nothing.
 */
export function nearestIndex(fraction: number, count: number): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const i = Math.floor(fraction * (count - 1) + 0.5);
  if (i < 0) return 0;
  if (i > count - 1) return count - 1;
  return i;
}

/** The nearest datum by VALUE (a continuous x axis). A tie takes the lower index. */
export function nearestValueIndex(value: number, values: readonly number[]): number {
  if (values.length === 0) return -1;
  let best = 0;
  let bestDistance = Math.abs(value - values[0]!);
  for (let i = 1; i < values.length; i += 1) {
    const d = Math.abs(value - values[i]!);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return best;
}

/** A brush selection, or the CLEAR that a tap inside a brushable chart really is. */
export interface BrushWindow {
  readonly start: number;
  readonly end: number;
  readonly cleared: boolean;
}

/** Below this fraction of the plot a drag is a tap, and a tap clears the brush. */
export const BRUSH_MIN_FRACTION = 0.01;

/**
 * Fold a drag into a brush payload. Direction does not matter — a right-to-left drag
 * reports the same window — and both ends clamp into the plot.
 */
export function brushWindow(
  from: number, to: number, domain: readonly [number, number],
): BrushWindow {
  const lo = clamp(Math.min(from, to), 0, 1);
  const hi = clamp(Math.max(from, to), 0, 1);
  if (hi - lo < BRUSH_MIN_FRACTION) {
    return { start: domain[0], end: domain[1], cleared: true };
  }
  const span = domain[1] - domain[0];
  return { start: domain[0] + lo * span, end: domain[0] + hi * span, cleared: false };
}

/** The tightest window a pinch may reach, as a fraction of the full data extent. */
export const ZOOM_MIN_SPAN_FRACTION = 0.01;

/**
 * Zoom the visible domain about an anchor (0 = left edge, 1 = right edge of the plot).
 *
 * The window clamps to the full data extent — no rubber band past the data, no inversion —
 * and the span has a floor so a fast pinch cannot divide by zero. A window pushed past an
 * edge is SHIFTED back in, not clipped: clipping silently changes the zoom level the user
 * asked for.
 */
export function zoomDomain(
  domain: readonly [number, number],
  full: readonly [number, number],
  factor: number,
  anchor: number,
): DomainWindow {
  const fullSpan = full[1] - full[0];
  if (!(fullSpan > 0) || !(factor > 0)) return { lo: full[0], hi: full[1] };
  const span = domain[1] - domain[0];
  const newSpan = clamp(span / factor, fullSpan * ZOOM_MIN_SPAN_FRACTION, fullSpan);
  const anchorValue = domain[0] + anchor * span;
  let lo = anchorValue - anchor * newSpan;
  if (lo < full[0]) lo = full[0];
  if (lo + newSpan > full[1]) lo = full[1] - newSpan;
  if (lo < full[0]) lo = full[0];
  return { lo, hi: lo + newSpan };
}

/** Pan by a fraction of the visible span, keeping the span and staying inside the extent. */
export function panDomain(
  domain: readonly [number, number],
  full: readonly [number, number],
  delta: number,
): DomainWindow {
  const span = domain[1] - domain[0];
  let lo = domain[0] + delta * span;
  if (lo < full[0]) lo = full[0];
  if (lo + span > full[1]) lo = full[1] - span;
  if (lo < full[0]) lo = full[0];
  return { lo, hi: lo + span };
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// ── accessibleTable: the numbers, for the reader who cannot see the chart ────────────────

/** The accessible representation of a chart: a real table plus the sentence above it. */
export interface AccessibleTable {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** The same sentence the figure's label speaks, so the two can never drift apart. */
  readonly summary: string;
}

/** Which fields of the bound rows the chart is plotting, and what the axes are called. */
export interface AccessibleTableSpec {
  readonly x: string;
  readonly y: string;
  /** "" for a single-series chart. */
  readonly series: string;
  readonly type: string;
  readonly xTitle: string;
  readonly yTitle: string;
}

/**
 * Format one cell. An integer prints as an integer and everything else to two decimals —
 * a screen reader saying "one thousand two hundred point zero zero" for a whole number is
 * noise, and "1500.5" read as digits is worse than "1500.50".
 */
export function formatDatavizCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (Math.floor(value) === value && Math.abs(value) < 1e15) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

/**
 * Pivot a chart's bound rows into the table `accessibleTable` renders. Default ON, and
 * nearly free: the data is already structured and `<Table>` already exists, so a blind user
 * gets the numbers, a sighted user gets the chart, and the author writes one element.
 *
 * Both axes are in FIRST APPEARANCE order, never sorted — the author's row order is the
 * author's intent. A missing (x, series) cell is an EMPTY STRING, never a zero: a datum
 * that was not measured is not a measurement of nothing. A duplicate pair is last-wins.
 */
export function accessibleTable(
  rows: readonly Record<string, unknown>[],
  spec: AccessibleTableSpec,
): AccessibleTable {
  const multiSeries = spec.series !== "";
  const xLabels: string[] = [];
  const seriesLabels: string[] = [];
  const cells = new Map<string, Map<string, string>>();
  let min = Number.NaN;
  let max = Number.NaN;
  let sawNumber = false;

  for (const row of rows) {
    const xLabel = formatDatavizCell(row[spec.x]);
    if (!xLabels.includes(xLabel)) xLabels.push(xLabel);
    const seriesLabel = multiSeries ? formatDatavizCell(row[spec.series]) : "";
    if (multiSeries && !seriesLabels.includes(seriesLabel)) seriesLabels.push(seriesLabel);
    const raw = row[spec.y];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      if (!sawNumber) { min = raw; max = raw; sawNumber = true; }
      else { if (raw < min) min = raw; if (raw > max) max = raw; }
    }
    let bySeries = cells.get(xLabel);
    if (bySeries === undefined) { bySeries = new Map<string, string>(); cells.set(xLabel, bySeries); }
    bySeries.set(seriesLabel, formatDatavizCell(raw));
  }

  const xHeader = spec.xTitle !== "" ? spec.xTitle : spec.x;
  const yHeader = spec.yTitle !== "" ? spec.yTitle : spec.y;
  const columns = multiSeries ? [xHeader, ...seriesLabels] : [xHeader, yHeader];
  const table: string[][] = [];
  for (const xLabel of xLabels) {
    const bySeries = cells.get(xLabel);
    const out: string[] = [xLabel];
    if (multiSeries) {
      for (const seriesLabel of seriesLabels) out.push(bySeries?.get(seriesLabel) ?? "");
    } else {
      out.push(bySeries?.get("") ?? "");
    }
    table.push(out);
  }

  const caption = multiSeries
    ? `${spec.type} chart. ${rows.length} data points in ${seriesLabels.length} series. ${yHeader} by ${xHeader}.`
    : `${spec.type} chart. ${rows.length} data points. ${yHeader} by ${xHeader}.`;
  let summary = `${spec.type} chart with ${rows.length} points`;
  if (sawNumber) {
    summary += `; values range from ${formatDatavizCell(min)} to ${formatDatavizCell(max)}`;
  }
  return { caption, columns, rows: table, summary };
}

// ── camera: web mercator, and the two things nobody gets right ───────────────────────────

/** One map tile's edge, in points. Every zoom level is `tileSize * 2^zoom` across. */
export const MAP_TILE_SIZE = 256;
export const MAP_MIN_ZOOM = 0;
export const MAP_MAX_ZOOM = 22;
/** Where a camera sits when the content cannot imply a zoom (one pin, or none). */
export const MAP_DEFAULT_ZOOM = 16;
/** Web mercator cannot reach a pole; this is where the projection is cut. */
export const MAP_MAX_MERCATOR_LATITUDE = 85.05112878;

/** Wrap a longitude into [-180, 180). The antimeridian normalises WEST. */
export function normalizeLongitude(lon: number): number {
  let r = (lon + 180) % 360;
  if (r < 0) r += 360;
  return r - 180;
}

/** Longitude to normalised world x, 0 at -180 and 1 at +180. */
export function mercatorX(lon: number): number {
  return (normalizeLongitude(lon) + 180) / 360;
}

/** Latitude to normalised world y, 0 at the north cut and 1 at the south. */
export function mercatorY(lat: number): number {
  const clamped = clamp(lat, -MAP_MAX_MERCATOR_LATITUDE, MAP_MAX_MERCATOR_LATITUDE);
  const s = Math.sin(clamped * DEGREES);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** World x back to longitude. */
export function longitudeAtWorldX(worldX: number): number {
  return worldX * 360 - 180;
}

/** World y back to latitude. */
export function latitudeAtWorldY(worldY: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) / DEGREES;
}

/** A geographic point, the way `pins=`, `fitTo=` and `camera=` all bind it. */
export interface GeoPoint { readonly lat: number; readonly lon: number }

/** Insets that overlaying UI takes out of the map, in points. */
export interface EdgePadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A camera, or the typed refusal that replaces a camera at null island. */
export interface CameraFit {
  readonly valid: boolean;
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
}

/**
 * The minimal enclosing longitude arc of a set of points: its western end and its width.
 *
 * Taking min and max longitude of a set straddling 180 degrees produces a span of nearly
 * the whole planet and a camera that flies the long way round. The fix is to sort the
 * longitudes, find the largest circular GAP, and keep what is left.
 */
export function minimalLongitudeArc(lons: readonly number[]): { start: number; span: number } {
  const n = lons.length;
  if (n === 0) return { start: 0, span: 0 };
  const sorted = lons.map(normalizeLongitude).sort((a, b) => a - b);
  if (n === 1) return { start: sorted[0]!, span: 0 };
  let gap = -1;
  let gapIndex = 0;
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    const g = next === 0 ? sorted[0]! + 360 - sorted[n - 1]! : sorted[next]! - sorted[i]!;
    if (g > gap) { gap = g; gapIndex = i; }
  }
  return { start: sorted[(gapIndex + 1) % n]!, span: 360 - gap };
}

/**
 * The camera that fits `coords` into a viewport, respecting asymmetric padding.
 *
 * The content is centred in the USABLE rectangle, not the viewport, so the camera centre
 * shifts by half the padding difference converted back to world units AT THE CHOSEN ZOOM —
 * a bottom sheet covering 40% of the screen otherwise hides the very pins that were fitted.
 * A single coordinate is not a zero-span bug, it is a request to sit at the default zoom;
 * no coordinates is a typed invalid.
 */
export function fitCamera(
  coords: readonly GeoPoint[],
  width: number,
  height: number,
  padding: EdgePadding,
): CameraFit {
  if (coords.length === 0) {
    return { valid: false, lat: 0, lon: 0, zoom: MAP_DEFAULT_ZOOM };
  }
  const usableWidth = Math.max(1, width - padding.left - padding.right);
  const usableHeight = Math.max(1, height - padding.top - padding.bottom);
  const arc = minimalLongitudeArc(coords.map((c) => c.lon));
  let yLo = mercatorY(coords[0]!.lat);
  let yHi = yLo;
  for (const c of coords) {
    const y = mercatorY(c.lat);
    if (y < yLo) yLo = y;
    if (y > yHi) yHi = y;
  }
  const spanX = arc.span / 360;
  const spanY = yHi - yLo;
  const zoomX = spanX > 0 ? Math.log2(usableWidth / (spanX * MAP_TILE_SIZE)) : Infinity;
  const zoomY = spanY > 0 ? Math.log2(usableHeight / (spanY * MAP_TILE_SIZE)) : Infinity;
  let zoom = Math.min(zoomX, zoomY);
  if (!Number.isFinite(zoom)) zoom = MAP_DEFAULT_ZOOM;
  zoom = clamp(zoom, MAP_MIN_ZOOM, MAP_MAX_ZOOM);

  const scale = MAP_TILE_SIZE * Math.pow(2, zoom);
  const shiftX = (padding.left + (width - padding.right)) / 2 - width / 2;
  const shiftY = (padding.top + (height - padding.bottom)) / 2 - height / 2;
  const centerX = mercatorX(arc.start) + spanX / 2 - shiftX / scale;
  const centerY = (yLo + yHi) / 2 - shiftY / scale;
  return {
    valid: true,
    lat: latitudeAtWorldY(centerY),
    lon: normalizeLongitude(longitudeAtWorldX(centerX)),
    zoom,
  };
}

/** What `on:regionChange` carries: the camera, plus the ground it actually covers. */
export interface MapRegion {
  readonly centerLat: number;
  readonly centerLon: number;
  readonly zoom: number;
  readonly latSpan: number;
  readonly lonSpan: number;
}

/**
 * The region a camera sees. The latitude span is measured by unprojecting both edges, not
 * by scaling the longitude span: mercator stretches with latitude, and a "square" viewport
 * over Oslo covers far less ground north to south than one over Quito.
 */
export function mapRegion(
  lat: number, lon: number, zoom: number, width: number, height: number,
): MapRegion {
  const scale = MAP_TILE_SIZE * Math.pow(2, zoom);
  const centerY = mercatorY(lat);
  const north = latitudeAtWorldY(centerY - height / 2 / scale);
  const south = latitudeAtWorldY(centerY + height / 2 / scale);
  return {
    centerLat: clamp(lat, -MAP_MAX_MERCATOR_LATITUDE, MAP_MAX_MERCATOR_LATITUDE),
    centerLon: normalizeLongitude(lon),
    zoom,
    latSpan: north - south,
    lonSpan: (width / scale) * 360,
  };
}

// ── cluster: five hundred pins, grouped the same way three times ─────────────────────────

/** The default cell side, in points, at the cluster level. */
export const CLUSTER_DEFAULT_RADIUS = 60;
/** The deepest level the expansion search will look for a split at. */
export const CLUSTER_MAX_ZOOM = 20;

/** One node a map renders: a cluster bubble, or a lone pin passed through. */
export interface ClusterNode {
  readonly cluster: boolean;
  /** `c:<level>:<cx>:<cy>` for a cluster, `p:<pinIndex>` for a lone pin. Stable across redraws. */
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly count: number;
  readonly members: readonly number[];
  /** The first level at which the members stop sharing a cell — what `on:clusterTap` flies to. */
  readonly expansionZoom: number;
}

function clusterCell(worldX: number, worldY: number, level: number, radius: number): [number, number] {
  const worldSize = MAP_TILE_SIZE * Math.pow(2, level);
  return [
    Math.floor((worldX * worldSize) / radius),
    Math.floor((worldY * worldSize) / radius),
  ];
}

/**
 * Grid-cluster pins for one camera.
 *
 * The algorithm is pinned here rather than left to MKClusterAnnotation, maps-utils and
 * Supercluster, which group differently at the same zoom and make a screenshot test
 * impossible: project each pin to world space, multiply by the world size at the CLUSTER
 * LEVEL, and take the integer cell of side `radius`.
 *
 * The level is `floor(zoom)`, never `zoom` — a continuous grid slides continuously, so at
 * 12.37 a pin sits in one cell and at 12.38 in the next, and markers flicker while the user
 * pinches. Quantising means membership is identical for every fractional zoom inside a
 * level. Output is row-major by cell (cy, then cx) so all three renderers emit the same
 * nodes in the same order with the same ids, which is what stops marker churn on redraw. A
 * cell holding one pin is NOT a cluster, and a cluster's coordinate is the mean of its
 * members in WORLD space, not the mean of their latitudes.
 */
export function clusterPins(
  pins: readonly GeoPoint[],
  zoom: number,
  radius: number,
  maxZoom: number,
): ClusterNode[] {
  const level = Math.trunc(clamp(Math.floor(zoom), 0, maxZoom));
  const worldXs: number[] = [];
  const worldYs: number[] = [];
  for (const p of pins) {
    worldXs.push(mercatorX(p.lon));
    worldYs.push(mercatorY(p.lat));
  }
  const cells = new Map<string, { cx: number; cy: number; members: number[] }>();
  for (let i = 0; i < pins.length; i += 1) {
    const [cx, cy] = clusterCell(worldXs[i]!, worldYs[i]!, level, radius);
    const key = `${cx}:${cy}`;
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, { cx, cy, members: [i] });
    else bucket.members.push(i);
  }
  const ordered = [...cells.values()].sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
  const out: ClusterNode[] = [];
  for (const cell of ordered) {
    if (cell.members.length === 1) {
      const i = cell.members[0]!;
      out.push({
        cluster: false,
        id: `p:${i}`,
        lat: pins[i]!.lat,
        lon: pins[i]!.lon,
        count: 1,
        members: [i],
        expansionZoom: level,
      });
      continue;
    }
    let sumX = 0;
    let sumY = 0;
    for (const i of cell.members) { sumX += worldXs[i]!; sumY += worldYs[i]!; }
    const meanX = sumX / cell.members.length;
    const meanY = sumY / cell.members.length;
    out.push({
      cluster: true,
      id: `c:${level}:${cell.cx}:${cell.cy}`,
      lat: latitudeAtWorldY(meanY),
      lon: normalizeLongitude(longitudeAtWorldX(meanX)),
      count: cell.members.length,
      members: cell.members,
      expansionZoom: clusterExpansionZoom(cell.members, worldXs, worldYs, level, radius, maxZoom),
    });
  }
  return out;
}

function clusterExpansionZoom(
  members: readonly number[],
  worldXs: readonly number[],
  worldYs: readonly number[],
  level: number,
  radius: number,
  maxZoom: number,
): number {
  for (let l = level + 1; l <= maxZoom; l += 1) {
    const [cx0, cy0] = clusterCell(worldXs[members[0]!]!, worldYs[members[0]!]!, l, radius);
    for (let k = 1; k < members.length; k += 1) {
      const [cx, cy] = clusterCell(worldXs[members[k]!]!, worldYs[members[k]!]!, l, radius);
      if (cx !== cx0 || cy !== cy0) return l;
    }
  }
  return maxZoom;
}
