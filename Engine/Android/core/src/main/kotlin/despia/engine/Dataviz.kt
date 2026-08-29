//
//  Dataviz.kt - the shared <chart> / <map> numeric core (:core, pure JVM): scale domains and
//  ticks, mark geometry, interaction payload arithmetic, the accessible table, web-mercator
//  camera maths and pin clustering. The law is the corpus:
//  OpenSource/Conformance/dataviz/ (six files - scales, marks, interaction, a11y, camera,
//  cluster; parity/U09-dataviz.md). The twin of Swift Dataviz.swift and the web
//  @despia-native/kernel dataviz.ts, and all three run the SAME files.
//
//  Everything platform-shaped lives OUTSIDE this file. Swift Charts, the Compose canvas and
//  the DOM renderer paint pixels three different ways; what they may NOT do is disagree on
//  where a datum lands, how many gridlines there are, which pins share a cluster, or what a
//  screen reader is told. Keeping the DECISION separate from the PAINTING is what lets one
//  corpus judge three renderers.
//
//  Two rules that look like fussiness and are not:
//   * the decimal exponent and powers of ten are integer LOOPS, never log10/pow - libm
//     rounding differs between platforms and floor(log10(1000)) is allowed to come back 2,
//     which silently moves every tick on one renderer only;
//   * the cluster level is floor(zoom), never zoom - a continuous grid slides continuously,
//     so markers visibly flicker while the user pinches.
//
package despia.engine

import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log2
import kotlin.math.sin
import kotlin.math.sinh
import kotlin.math.pow
import kotlin.math.sqrt

object Dataviz {

    // -- shared shapes ------------------------------------------------------------------

    /** A resolved numeric axis: the extended bounds, the tick step, and the ticks. */
    data class NiceDomain(val lo: Double, val hi: Double, val step: Double, val ticks: List<Double>)

    /** A d3-shaped band scale: one slot per category, padded inside and out. */
    data class BandLayout(
        val step: Double,
        val bandwidth: Double,
        val start: Double,
        val positions: List<Double>,
        val centers: List<Double>,
    )

    /** A log axis, or the typed refusal that replaces a silent clamp. */
    data class LogDomain(
        val valid: Boolean,
        val reason: String,
        val lo: Double,
        val hi: Double,
        val ticks: List<Double>,
    )

    /** A time axis over FIXED durations (no calendar months - a month is not a duration). */
    data class TimeTicks(val step: Double, val ticks: List<Double>)

    /** A window on a domain: the payload shape of zoom, pan and the brush. */
    data class DomainWindow(val lo: Double, val hi: Double)

    // -- scales: the arithmetic before a single pixel ------------------------------------

    /**
     * floor(log10(|x|)), by an integer loop.
     *
     * Never log10 + floor: libm is entitled to return 2.9999999999999996 for log10(1000),
     * and one renderer's axis then steps differently from the other two. Zero has no
     * exponent; it answers 0 so callers never see a NaN.
     */
    fun decimalExponent(x: Double): Int {
        var a = abs(x)
        if (a == 0.0 || !a.isFinite()) return 0
        var e = 0
        while (a >= 10.0) { a /= 10.0; e += 1 }
        while (a < 1.0) { a *= 10.0; e -= 1 }
        return e
    }

    /** 10^n, by an integer loop, for the same reason `decimalExponent` is one. */
    fun powerOfTen(n: Int): Double {
        var r = 1.0
        for (i in 0 until abs(n)) r *= 10.0
        return if (n < 0) 1.0 / r else r
    }

    /**
     * Heckbert's nice number: the closest "human" number to `x` - 1, 2, 5 or 10 times a
     * power of ten. `round` picks the nearest; otherwise it rounds UP, which is what an
     * axis range wants so the data always fits inside it.
     */
    fun niceNumber(x: Double, round: Boolean): Double {
        if (!(x > 0.0)) return 0.0
        val exp = decimalExponent(x)
        val f = x / powerOfTen(exp)
        val nf = if (round) {
            if (f < 1.5) 1.0 else if (f < 3.0) 2.0 else if (f < 7.0) 5.0 else 10.0
        } else {
            if (f <= 1.0) 1.0 else if (f <= 2.0) 2.0 else if (f <= 5.0) 5.0 else 10.0
        }
        return nf * powerOfTen(exp)
    }

    /** The padding a zero-span domain gets before it is made nice. */
    private const val ZERO_SPAN_PAD = 0.5

    /**
     * Heckbert loose labelling: the domain EXTENDS to the nice bounds rather than the ticks
     * shrinking inside it, so the first and last tick are always the axis ends. Reversed
     * bounds are ordered first; a zero span is padded before it is made nice.
     *
     * Ticks are `lo + i * step`, never an accumulator - accumulating drifts, and a tick that
     * reads 5.000000000000001 on one renderer and 5 on another is a diff nobody can explain.
     */
    fun niceLinearDomain(lo: Double, hi: Double, count: Int): NiceDomain {
        var low = minOf(lo, hi)
        var high = maxOf(lo, hi)
        if (low == high) { low -= ZERO_SPAN_PAD; high += ZERO_SPAN_PAD }
        val n = maxOf(2, count)
        val range = niceNumber(high - low, false)
        val step = niceNumber(range / (n - 1), true)
        if (!(step > 0.0)) return NiceDomain(low, high, 0.0, listOf(low))
        val gLo = floor(low / step) * step
        val gHi = ceil(high / step) * step
        val steps = maxOf(0, Math.round((gHi - gLo) / step).toInt())
        val ticks = ArrayList<Double>(steps + 1)
        for (i in 0..steps) ticks.add(gLo + i * step)
        return NiceDomain(gLo, gHi, step, ticks)
    }

    /**
     * The axis a series actually gets. `includeZero` is the bar/area rule (a bar that does
     * not start at zero lies about its length); a line does not invent a zero it was never
     * given. An empty series is a unit domain, not a NaN.
     */
    fun valueDomain(values: List<Double>, includeZero: Boolean, count: Int): NiceDomain {
        if (values.isEmpty()) return niceLinearDomain(0.0, 1.0, count)
        var lo = values[0]
        var hi = values[0]
        for (v in values) { if (v < lo) lo = v; if (v > hi) hi = v }
        if (includeZero) { lo = minOf(lo, 0.0); hi = maxOf(hi, 0.0) }
        return niceLinearDomain(lo, hi, count)
    }

    /** Map a value onto a range. An inverted range is the y axis; a degenerate domain lands mid. */
    fun linearScale(v: Double, domain: List<Double>, range: List<Double>): Double {
        if (domain[1] == domain[0]) return (range[0] + range[1]) / 2.0
        return range[0] + (v - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0])
    }

    /**
     * The d3 band scale, verbatim: step = span / (count - paddingInner + 2 * paddingOuter),
     * bandwidth = step * (1 - paddingInner), and the leftover centred by `align`.
     */
    fun bandScale(
        count: Int,
        range: List<Double>,
        paddingInner: Double,
        paddingOuter: Double,
        align: Double,
    ): BandLayout {
        val span = range[1] - range[0]
        if (count <= 0) return BandLayout(0.0, 0.0, range[0], emptyList(), emptyList())
        val divisor = maxOf(1e-12, count - paddingInner + 2 * paddingOuter)
        val step = span / divisor
        val bandwidth = step * (1.0 - paddingInner)
        val start = range[0] + (span - step * (count - paddingInner)) * align
        val positions = ArrayList<Double>(count)
        val centers = ArrayList<Double>(count)
        for (i in 0 until count) {
            val p = start + step * i
            positions.add(p)
            centers.add(p + bandwidth / 2.0)
        }
        return BandLayout(step, bandwidth, start, positions, centers)
    }

    /** The decade a value's upper bound rounds up to (exact powers of ten stay put). */
    private fun decimalExponentCeiling(x: Double): Int {
        val e = decimalExponent(x)
        return if (powerOfTen(e) == x) e else e + 1
    }

    /** The refusal a log axis reports rather than clamping a non-positive bound into existence. */
    const val LOG_NONPOSITIVE_DOMAIN = "nonpositive_domain"

    /**
     * The log decade ladder. The domain extends to whole decades; two decades or fewer get
     * the 1-2-5 ladder inside each, more get plain decades on a stride that keeps the label
     * count near `maxTicks`.
     *
     * A non-positive bound is a TYPED REFUSAL, never a silent clamp to some epsilon: a log
     * axis over data containing a zero is an authoring mistake and the author has to see it.
     */
    fun logDomain(lo: Double, hi: Double, maxTicks: Int): LogDomain {
        if (!(lo > 0.0) || !(hi > 0.0)) {
            return LogDomain(false, LOG_NONPOSITIVE_DOMAIN, 0.0, 0.0, emptyList())
        }
        val low = minOf(lo, hi)
        val high = maxOf(lo, hi)
        val loDec = decimalExponent(low)
        var hiDec = decimalExponentCeiling(high)
        if (hiDec <= loDec) hiDec = loDec + 1
        val decades = hiDec - loDec
        val ticks = ArrayList<Double>()
        if (decades <= 2) {
            var d = loDec
            while (d < hiDec) {
                val base = powerOfTen(d)
                ticks.add(base); ticks.add(2.0 * base); ticks.add(5.0 * base)
                d += 1
            }
        } else {
            val stride = maxOf(1, ceil(decades.toDouble() / maxOf(1, maxTicks).toDouble()).toInt())
            var d = loDec
            while (d < hiDec) { ticks.add(powerOfTen(d)); d += stride }
        }
        ticks.add(powerOfTen(hiDec))
        return LogDomain(true, "", powerOfTen(loDec), powerOfTen(hiDec), ticks)
    }

    /** Position on a log axis. A non-positive value pins to the range start rather than -Inf. */
    fun logScale(v: Double, domain: List<Double>, range: List<Double>): Double {
        if (!(domain[0] > 0.0) || !(domain[1] > 0.0) || domain[0] == domain[1]) return range[0]
        if (!(v > 0.0)) return range[0]
        val t = (ln(v) - ln(domain[0])) / (ln(domain[1]) - ln(domain[0]))
        return range[0] + t * (range[1] - range[0])
    }

    /**
     * The fixed-duration ladder, in seconds. Every entry is a duration a human names - a
     * quarter minute, a quarter hour, six hours, a week. No months and no years: a month is
     * not a duration, and a ladder that pretends otherwise ticks 28, 30 or 31 days apart
     * depending on where the window happens to start.
     */
    val TIME_TICK_LADDER: List<Double> = listOf(
        1.0, 2.0, 5.0, 10.0, 15.0, 30.0,
        60.0, 120.0, 300.0, 600.0, 900.0, 1800.0,
        3600.0, 7200.0, 10800.0, 21600.0, 43200.0,
        86400.0, 172800.0, 604800.0,
    )

    private const val SECONDS_PER_DAY = 86400.0

    /**
     * Ticks on a time axis, in epoch seconds. Ticks snap to the STEP GRID rather than to the
     * window start, so a chart of the last hour puts labels on the quarter hours instead of
     * on whatever second the user opened the screen, and they stay INSIDE the domain.
     */
    fun timeTicks(lo: Double, hi: Double, count: Int): TimeTicks {
        val low = minOf(lo, hi)
        val high = maxOf(lo, hi)
        if (low == high) return TimeTicks(1.0, listOf(low))
        val n = maxOf(2, count)
        val target = (high - low) / (n - 1)
        var step = 0.0
        for (candidate in TIME_TICK_LADDER) if (candidate >= target) { step = candidate; break }
        if (step == 0.0) step = niceNumber(target / SECONDS_PER_DAY, true) * SECONDS_PER_DAY
        if (!(step > 0.0)) return TimeTicks(1.0, listOf(low))
        val first = ceil(low / step - 1e-9).toLong()
        val last = floor(high / step + 1e-9).toLong()
        val ticks = ArrayList<Double>()
        var i = first
        while (i <= last) { ticks.add(i * step); i += 1 }
        return TimeTicks(step, ticks)
    }

    // -- marks: datum to coordinate ------------------------------------------------------

    private const val DEGREES = PI / 180.0

    /** One slice of a pie or donut, with the centroid a label or a callout anchors to. */
    data class PieSlice(
        val index: Int,
        val value: Double,
        val fraction: Double,
        val startAngle: Double,
        val endAngle: Double,
        val sweep: Double,
        val centroidX: Double,
        val centroidY: Double,
        /** A lone slice is a CIRCLE. A renderer that draws it as a 360-degree arc draws nothing. */
        val full: Boolean,
    )

    /** A resolved pie: the slices plus the radii, or `empty` when there is nothing to divide. */
    data class PieLayout(
        val total: Double,
        val empty: Boolean,
        val innerRadius: Double,
        val outerRadius: Double,
        val slices: List<PieSlice>,
    )

    /**
     * Pie / donut geometry. Angles are DEGREES, screen-oriented: -90 is twelve o'clock, +y
     * is down, and a clockwise pie sweeps toward +x first. `innerRadius` <= 1 is a fraction
     * of the outer radius; above 1 it is taken verbatim.
     *
     * Negative values are SKIPPED, keeping their index, never folded into the total - a pie
     * of a signed series is meaningless, and quietly taking absolute values is how it ships
     * anyway. A total of zero is `empty`, not a division by zero.
     */
    fun pieSlices(
        values: List<Double>,
        outerRadius: Double,
        innerRadius: Double,
        startAngle: Double,
        padAngle: Double,
        clockwise: Boolean,
    ): PieLayout {
        val inner = if (innerRadius <= 1.0) innerRadius * outerRadius else innerRadius
        var total = 0.0
        for (v in values) if (v > 0.0) total += v
        if (!(total > 0.0)) return PieLayout(0.0, true, inner, outerRadius, emptyList())
        val centroidRadius = (inner + outerRadius) / 2.0
        val slices = ArrayList<PieSlice>()
        var cursor = startAngle
        for (i in values.indices) {
            val v = values[i]
            if (!(v > 0.0)) continue
            val fraction = v / total
            val raw = fraction * 360.0
            val sweep = maxOf(0.0, raw - padAngle)
            val a0 = cursor
            val a1 = if (clockwise) cursor + sweep else cursor - sweep
            cursor = if (clockwise) cursor + raw else cursor - raw
            val mid = (a0 + a1) / 2.0
            slices.add(
                PieSlice(
                    index = i,
                    value = v,
                    fraction = fraction,
                    startAngle = a0,
                    endAngle = a1,
                    sweep = sweep,
                    centroidX = centroidRadius * cos(mid * DEGREES),
                    centroidY = centroidRadius * sin(mid * DEGREES),
                    full = abs(sweep) >= 360.0 - 1e-9,
                ),
            )
        }
        return PieLayout(total, false, inner, outerRadius, slices)
    }

    /**
     * Bubble radius for a scatter `size` field. Interpolates AREA, not radius, because the
     * eye reads area: a datum twice as large must cover twice the ink, and a linear radius
     * ramp makes it cover four times. An all-equal series takes the midpoint rather than the
     * floor - every bubble at `rMin` reads as "no data" instead of "all the same".
     */
    fun bubbleRadius(v: Double, min: Double, max: Double, rMin: Double, rMax: Double): Double {
        if (!(max > min)) return (rMin + rMax) / 2.0
        var t = (v - min) / (max - min)
        if (t < 0.0) t = 0.0
        if (t > 1.0) t = 1.0
        return sqrt(rMin * rMin + t * (rMax * rMax - rMin * rMin))
    }

    /** One vertex of a radar polygon. */
    data class RadarPoint(
        val index: Int,
        val fraction: Double,
        val angle: Double,
        val x: Double,
        val y: Double,
    )

    /** Radar / spider vertices: axis 0 at twelve o'clock, then clockwise, clamped to the ring. */
    fun radarPoints(
        values: List<Double>,
        max: Double,
        radius: Double,
        centerX: Double,
        centerY: Double,
    ): List<RadarPoint> {
        val n = values.size
        val out = ArrayList<RadarPoint>(n)
        for (i in 0 until n) {
            var fraction = if (max > 0.0) values[i] / max else 0.0
            if (fraction < 0.0) fraction = 0.0
            if (fraction > 1.0) fraction = 1.0
            val angle = -90.0 + 360.0 * i / n
            out.add(
                RadarPoint(
                    index = i,
                    fraction = fraction,
                    angle = angle,
                    x = centerX + radius * fraction * cos(angle * DEGREES),
                    y = centerY + radius * fraction * sin(angle * DEGREES),
                ),
            )
        }
        return out
    }

    /** One trapezoid of a funnel, plus the two conversion ratios the label wants. */
    data class FunnelStage(
        val index: Int,
        val topWidth: Double,
        val bottomWidth: Double,
        val top: Double,
        val bottom: Double,
        val ofFirst: Double,
        val ofPrevious: Double,
    )

    /**
     * Funnel stages. Widths are normalised by the LARGEST value (a widening stage is drawn,
     * not clamped - a funnel that hides a stage growing is hiding the interesting one),
     * while the ratios are against the first and the previous stage. The last stage is a
     * rectangle: a taper to nothing implies a conversion to zero that the data never said.
     */
    fun funnelStages(
        values: List<Double>,
        width: Double,
        height: Double,
        gap: Double,
    ): List<FunnelStage> {
        val n = values.size
        if (n == 0) return emptyList()
        var max = values[0]
        for (v in values) if (v > max) max = v
        val stageHeight = (height - gap * (n - 1)) / n
        val first = values[0]
        val out = ArrayList<FunnelStage>(n)
        for (i in 0 until n) {
            val v = values[i]
            val next = if (i + 1 < n) values[i + 1] else v
            val previous = if (i == 0) v else values[i - 1]
            val top = i * (stageHeight + gap)
            out.add(
                FunnelStage(
                    index = i,
                    topWidth = if (max > 0.0) width * v / max else 0.0,
                    bottomWidth = if (max > 0.0) width * next / max else 0.0,
                    top = top,
                    bottom = top + stageHeight,
                    ofFirst = if (first == 0.0) 0.0 else v / first,
                    ofPrevious = if (i == 0) 1.0 else (if (previous == 0.0) 0.0 else v / previous),
                ),
            )
        }
        return out
    }

    /** Which way a candle closed. "flat" is a doji and still gets a visible body. */
    fun candleDirection(open: Double, close: Double): String =
        if (close > open) "up" else if (close < open) "down" else "flat"

    /** A timestamped scalar - the input a candlestick is folded from. */
    data class TimePoint(val t: Double, val v: Double)

    /** One OHLC bucket folded out of a tick stream. */
    data class Candle(
        val bucket: Long,
        val start: Double,
        val open: Double,
        val high: Double,
        val low: Double,
        val close: Double,
        val count: Int,
        val direction: String,
    )

    /**
     * Fold a tick stream into OHLC buckets on a fixed grid anchored at `origin`.
     *
     * Empty buckets are SKIPPED, never emitted as zeros: a market that did not trade is not
     * a market that traded at zero, and a chart that draws the gap as a crash is worse than
     * a chart with a gap. Points are ordered by (t, arrival) first, so `open` and `close` do
     * not depend on the platform's sort being stable.
     */
    fun candleBuckets(points: List<TimePoint>, interval: Double, origin: Double): List<Candle> {
        if (!(interval > 0.0) || points.isEmpty()) return emptyList()
        val order = points.indices.sortedWith(
            compareBy({ points[it].t }, { it }),
        )
        val byBucket = LinkedHashMap<Long, DoubleArray>()
        val counts = LinkedHashMap<Long, Int>()
        for (i in order) {
            val p = points[i]
            val bucket = floor((p.t - origin) / interval).toLong()
            val existing = byBucket[bucket]
            if (existing == null) {
                byBucket[bucket] = doubleArrayOf(p.v, p.v, p.v, p.v)
                counts[bucket] = 1
            } else {
                if (p.v > existing[1]) existing[1] = p.v
                if (p.v < existing[2]) existing[2] = p.v
                existing[3] = p.v
                counts[bucket] = (counts[bucket] ?: 0) + 1
            }
        }
        return byBucket.keys.sorted().map { bucket ->
            val o = byBucket.getValue(bucket)
            Candle(
                bucket = bucket,
                start = origin + bucket * interval,
                open = o[0],
                high = o[1],
                low = o[2],
                close = o[3],
                count = counts.getValue(bucket),
                direction = candleDirection(o[0], o[3]),
            )
        }
    }

    /** Where one candle's body and wick land, in range units (y grows downward). */
    data class CandleGeometry(
        val bodyTop: Double,
        val bodyBottom: Double,
        val wickTop: Double,
        val wickBottom: Double,
        val direction: String,
    )

    /**
     * One candle's pixels. The range is screen-oriented: range[1] is the BOTTOM, so the
     * domain maximum sits at range[0].
     *
     * A doji (open == close) is expanded to `minBody` around its centre - a zero-height body
     * is invisible, and the flat day is exactly the one a reader is looking for.
     */
    fun candleGeometry(
        open: Double,
        high: Double,
        low: Double,
        close: Double,
        domain: List<Double>,
        range: List<Double>,
        minBody: Double,
    ): CandleGeometry {
        fun y(v: Double): Double {
            if (domain[1] == domain[0]) return (range[0] + range[1]) / 2.0
            return range[1] - (v - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0])
        }
        val yOpen = y(open)
        val yClose = y(close)
        var bodyTop = minOf(yOpen, yClose)
        var bodyBottom = maxOf(yOpen, yClose)
        if (bodyBottom - bodyTop < minBody) {
            val mid = (bodyTop + bodyBottom) / 2.0
            bodyTop = mid - minBody / 2.0
            bodyBottom = mid + minBody / 2.0
        }
        return CandleGeometry(bodyTop, bodyBottom, y(high), y(low), candleDirection(open, close))
    }

    /** One heat-map cell: its bin, the summed weight, and that weight against the hottest cell. */
    data class HeatmapCell(val xBin: Int, val yBin: Int, val value: Double, val intensity: Double)

    /** The whole grid, row-major (yBin outer, xBin inner), plus the maximum it normalises by. */
    data class HeatmapGrid(val max: Double, val cells: List<HeatmapCell>)

    /** A weighted point - the input a heat map (chart or map overlay) is folded from. */
    data class WeightedPoint(val x: Double, val y: Double, val w: Double)

    /**
     * Bin weighted points into a heat-map grid.
     *
     * The last bin owns its own upper edge: floor(t * bins) puts the domain maximum in a
     * phantom bin `bins`, which is the off-by-one every heat map ships once. Out-of-domain
     * points clamp into the edge bins rather than vanishing, and an empty grid is zero
     * intensity everywhere, never NaN.
     */
    fun heatmapCells(
        points: List<WeightedPoint>,
        xBins: Int,
        yBins: Int,
        xDomain: List<Double>,
        yDomain: List<Double>,
    ): HeatmapGrid {
        if (xBins <= 0 || yBins <= 0) return HeatmapGrid(0.0, emptyList())
        val grid = DoubleArray(xBins * yBins)
        for (p in points) {
            val bx = binIndex(p.x, xDomain, xBins)
            val by = binIndex(p.y, yDomain, yBins)
            grid[by * xBins + bx] += p.w
        }
        var max = 0.0
        for (v in grid) if (v > max) max = v
        val cells = ArrayList<HeatmapCell>(xBins * yBins)
        for (by in 0 until yBins) {
            for (bx in 0 until xBins) {
                val value = grid[by * xBins + bx]
                cells.add(HeatmapCell(bx, by, value, if (max > 0.0) value / max else 0.0))
            }
        }
        return HeatmapGrid(max, cells)
    }

    private fun binIndex(v: Double, domain: List<Double>, bins: Int): Int {
        if (domain[1] == domain[0]) return 0
        val i = floor((v - domain[0]) / (domain[1] - domain[0]) * bins).toInt()
        if (i < 0) return 0
        if (i > bins - 1) return bins - 1
        return i
    }

    // -- interaction: what on:select / on:hover / on:brush actually carry -----------------

    /**
     * The index a tap at `fraction` across the plot selects. This is the rule the shipped
     * renderers already use for on:select, lifted out so on:hover inherits it exactly
     * instead of growing a second, subtly different one.
     *
     * An empty series answers -1 - a typed absence, never index 0 pointing at nothing.
     */
    fun nearestIndex(fraction: Double, count: Int): Int {
        if (count <= 0) return -1
        if (count == 1) return 0
        val i = floor(fraction * (count - 1) + 0.5).toInt()
        if (i < 0) return 0
        if (i > count - 1) return count - 1
        return i
    }

    /** The nearest datum by VALUE (a continuous x axis). A tie takes the lower index. */
    fun nearestValueIndex(value: Double, values: List<Double>): Int {
        if (values.isEmpty()) return -1
        var best = 0
        var bestDistance = abs(value - values[0])
        for (i in 1 until values.size) {
            val d = abs(value - values[i])
            if (d < bestDistance) { bestDistance = d; best = i }
        }
        return best
    }

    /** A brush selection, or the CLEAR that a tap inside a brushable chart really is. */
    data class BrushWindow(val start: Double, val end: Double, val cleared: Boolean)

    /** Below this fraction of the plot a drag is a tap, and a tap clears the brush. */
    const val BRUSH_MIN_FRACTION = 0.01

    /**
     * Fold a drag into a brush payload. Direction does not matter - a right-to-left drag
     * reports the same window - and both ends clamp into the plot.
     */
    fun brushWindow(from: Double, to: Double, domain: List<Double>): BrushWindow {
        val lo = clamp(minOf(from, to), 0.0, 1.0)
        val hi = clamp(maxOf(from, to), 0.0, 1.0)
        if (hi - lo < BRUSH_MIN_FRACTION) return BrushWindow(domain[0], domain[1], true)
        val span = domain[1] - domain[0]
        return BrushWindow(domain[0] + lo * span, domain[0] + hi * span, false)
    }

    /** The tightest window a pinch may reach, as a fraction of the full data extent. */
    const val ZOOM_MIN_SPAN_FRACTION = 0.01

    /**
     * Zoom the visible domain about an anchor (0 = left edge, 1 = right edge of the plot).
     *
     * The window clamps to the full data extent - no rubber band past the data, no
     * inversion - and the span has a floor so a fast pinch cannot divide by zero. A window
     * pushed past an edge is SHIFTED back in, not clipped: clipping silently changes the
     * zoom level the user asked for.
     */
    fun zoomDomain(
        domain: List<Double>,
        full: List<Double>,
        factor: Double,
        anchor: Double,
    ): DomainWindow {
        val fullSpan = full[1] - full[0]
        if (!(fullSpan > 0.0) || !(factor > 0.0)) return DomainWindow(full[0], full[1])
        val span = domain[1] - domain[0]
        val newSpan = clamp(span / factor, fullSpan * ZOOM_MIN_SPAN_FRACTION, fullSpan)
        val anchorValue = domain[0] + anchor * span
        var lo = anchorValue - anchor * newSpan
        if (lo < full[0]) lo = full[0]
        if (lo + newSpan > full[1]) lo = full[1] - newSpan
        if (lo < full[0]) lo = full[0]
        return DomainWindow(lo, lo + newSpan)
    }

    /** Pan by a fraction of the visible span, keeping the span and staying inside the extent. */
    fun panDomain(domain: List<Double>, full: List<Double>, delta: Double): DomainWindow {
        val span = domain[1] - domain[0]
        var lo = domain[0] + delta * span
        if (lo < full[0]) lo = full[0]
        if (lo + span > full[1]) lo = full[1] - span
        if (lo < full[0]) lo = full[0]
        return DomainWindow(lo, lo + span)
    }

    private fun clamp(v: Double, lo: Double, hi: Double): Double =
        if (v < lo) lo else if (v > hi) hi else v

    // -- accessibleTable: the numbers, for the reader who cannot see the chart ------------

    /** The accessible representation of a chart: a real table plus the sentence above it. */
    data class AccessibleTable(
        val caption: String,
        val columns: List<String>,
        val rows: List<List<String>>,
        /** The same sentence the figure's label speaks, so the two can never drift apart. */
        val summary: String,
    )

    /** Which fields of the bound rows the chart is plotting, and what the axes are called. */
    data class AccessibleTableSpec(
        val x: String,
        val y: String,
        /** "" for a single-series chart. */
        val series: String,
        val type: String,
        val xTitle: String,
        val yTitle: String,
    )

    /**
     * Format one cell. An integer prints as an integer and everything else to two decimals -
     * a screen reader saying "one thousand two hundred point zero zero" for a whole number
     * is noise, and "1500.5" read as digits is worse than "1500.50".
     */
    fun formatCell(value: Any?): String = when (value) {
        null -> ""
        is Boolean -> if (value) "true" else "false"
        is Number -> {
            val d = value.toDouble()
            if (!d.isFinite()) ""
            else if (floor(d) == d && abs(d) < 1e15) d.toLong().toString()
            else String.format(Locale.ROOT, "%.2f", d)
        }
        else -> value.toString()
    }

    /**
     * Pivot a chart's bound rows into the table `accessibleTable` renders. Default ON, and
     * nearly free: the data is already structured and <Table> already exists, so a blind
     * user gets the numbers, a sighted user gets the chart, and the author writes one
     * element.
     *
     * Both axes are in FIRST APPEARANCE order, never sorted - the author's row order is the
     * author's intent. A missing (x, series) cell is an EMPTY STRING, never a zero: a datum
     * that was not measured is not a measurement of nothing. A duplicate pair is last-wins.
     */
    fun accessibleTable(
        rows: List<Map<String, Any?>>,
        spec: AccessibleTableSpec,
    ): AccessibleTable {
        val multiSeries = spec.series != ""
        val xLabels = ArrayList<String>()
        val seriesLabels = ArrayList<String>()
        val cells = LinkedHashMap<String, LinkedHashMap<String, String>>()
        var min = 0.0
        var max = 0.0
        var sawNumber = false

        for (row in rows) {
            val xLabel = formatCell(row[spec.x])
            if (!xLabels.contains(xLabel)) xLabels.add(xLabel)
            val seriesLabel = if (multiSeries) formatCell(row[spec.series]) else ""
            if (multiSeries && !seriesLabels.contains(seriesLabel)) seriesLabels.add(seriesLabel)
            val raw = row[spec.y]
            if (raw is Number) {
                val d = raw.toDouble()
                if (d.isFinite()) {
                    if (!sawNumber) { min = d; max = d; sawNumber = true }
                    else { if (d < min) min = d; if (d > max) max = d }
                }
            }
            cells.getOrPut(xLabel) { LinkedHashMap() }[seriesLabel] = formatCell(raw)
        }

        val xHeader = if (spec.xTitle != "") spec.xTitle else spec.x
        val yHeader = if (spec.yTitle != "") spec.yTitle else spec.y
        val columns = ArrayList<String>()
        columns.add(xHeader)
        if (multiSeries) columns.addAll(seriesLabels) else columns.add(yHeader)
        val table = ArrayList<List<String>>(xLabels.size)
        for (xLabel in xLabels) {
            val bySeries = cells[xLabel]
            val out = ArrayList<String>()
            out.add(xLabel)
            if (multiSeries) {
                for (seriesLabel in seriesLabels) out.add(bySeries?.get(seriesLabel) ?: "")
            } else {
                out.add(bySeries?.get("") ?: "")
            }
            table.add(out)
        }

        val caption = if (multiSeries) {
            "${spec.type} chart. ${rows.size} data points in ${seriesLabels.size} series. " +
                "$yHeader by $xHeader."
        } else {
            "${spec.type} chart. ${rows.size} data points. $yHeader by $xHeader."
        }
        var summary = "${spec.type} chart with ${rows.size} points"
        if (sawNumber) {
            summary += "; values range from ${formatCell(min)} to ${formatCell(max)}"
        }
        return AccessibleTable(caption, columns, table, summary)
    }

    // -- camera: web mercator, and the two things nobody gets right ----------------------

    /** One map tile's edge, in points. Every zoom level is tileSize * 2^zoom across. */
    const val MAP_TILE_SIZE = 256.0
    const val MAP_MIN_ZOOM = 0.0
    const val MAP_MAX_ZOOM = 22.0

    /** Where a camera sits when the content cannot imply a zoom (one pin, or none). */
    const val MAP_DEFAULT_ZOOM = 16.0

    /** Web mercator cannot reach a pole; this is where the projection is cut. */
    const val MAP_MAX_MERCATOR_LATITUDE = 85.05112878

    /** Wrap a longitude into [-180, 180). The antimeridian normalises WEST. */
    fun normalizeLongitude(lon: Double): Double {
        var r = (lon + 180.0) % 360.0
        if (r < 0.0) r += 360.0
        return r - 180.0
    }

    /** Longitude to normalised world x, 0 at -180 and 1 at +180. */
    fun mercatorX(lon: Double): Double = (normalizeLongitude(lon) + 180.0) / 360.0

    /** Latitude to normalised world y, 0 at the north cut and 1 at the south. */
    fun mercatorY(lat: Double): Double {
        val clamped = clamp(lat, -MAP_MAX_MERCATOR_LATITUDE, MAP_MAX_MERCATOR_LATITUDE)
        val s = sin(clamped * DEGREES)
        return 0.5 - ln((1.0 + s) / (1.0 - s)) / (4.0 * PI)
    }

    /** World x back to longitude. */
    fun longitudeAtWorldX(worldX: Double): Double = worldX * 360.0 - 180.0

    /** World y back to latitude. */
    fun latitudeAtWorldY(worldY: Double): Double = atan(sinh(PI * (1.0 - 2.0 * worldY))) / DEGREES

    /** A geographic point, the way pins=, fitTo= and camera= all bind it. */
    data class GeoPoint(val lat: Double, val lon: Double)

    /** Insets that overlaying UI takes out of the map, in points. */
    data class EdgePadding(
        val top: Double,
        val right: Double,
        val bottom: Double,
        val left: Double,
    )

    /** A camera, or the typed refusal that replaces a camera at null island. */
    data class CameraFit(val valid: Boolean, val lat: Double, val lon: Double, val zoom: Double)

    /** The western end of the minimal enclosing longitude arc, and its width. */
    data class LongitudeArc(val start: Double, val span: Double)

    /**
     * The minimal enclosing longitude arc of a set of points.
     *
     * Taking min and max longitude of a set straddling 180 degrees produces a span of nearly
     * the whole planet and a camera that flies the long way round. The fix is to sort the
     * longitudes, find the largest circular GAP, and keep what is left.
     */
    fun minimalLongitudeArc(lons: List<Double>): LongitudeArc {
        val n = lons.size
        if (n == 0) return LongitudeArc(0.0, 0.0)
        val sorted = lons.map { normalizeLongitude(it) }.sorted()
        if (n == 1) return LongitudeArc(sorted[0], 0.0)
        var gap = -1.0
        var gapIndex = 0
        for (i in 0 until n) {
            val next = (i + 1) % n
            val g = if (next == 0) sorted[0] + 360.0 - sorted[n - 1] else sorted[next] - sorted[i]
            if (g > gap) { gap = g; gapIndex = i }
        }
        return LongitudeArc(sorted[(gapIndex + 1) % n], 360.0 - gap)
    }

    /**
     * The camera that fits `coords` into a viewport, respecting asymmetric padding.
     *
     * The content is centred in the USABLE rectangle, not the viewport, so the camera centre
     * shifts by half the padding difference converted back to world units AT THE CHOSEN
     * ZOOM - a bottom sheet covering 40% of the screen otherwise hides the very pins that
     * were fitted. A single coordinate is not a zero-span bug, it is a request to sit at the
     * default zoom; no coordinates is a typed invalid.
     */
    fun fitCamera(
        coords: List<GeoPoint>,
        width: Double,
        height: Double,
        padding: EdgePadding,
    ): CameraFit {
        if (coords.isEmpty()) return CameraFit(false, 0.0, 0.0, MAP_DEFAULT_ZOOM)
        val usableWidth = maxOf(1.0, width - padding.left - padding.right)
        val usableHeight = maxOf(1.0, height - padding.top - padding.bottom)
        val arc = minimalLongitudeArc(coords.map { it.lon })
        var yLo = mercatorY(coords[0].lat)
        var yHi = yLo
        for (c in coords) {
            val y = mercatorY(c.lat)
            if (y < yLo) yLo = y
            if (y > yHi) yHi = y
        }
        val spanX = arc.span / 360.0
        val spanY = yHi - yLo
        val zoomX = if (spanX > 0.0) log2(usableWidth / (spanX * MAP_TILE_SIZE)) else Double.POSITIVE_INFINITY
        val zoomY = if (spanY > 0.0) log2(usableHeight / (spanY * MAP_TILE_SIZE)) else Double.POSITIVE_INFINITY
        var zoom = minOf(zoomX, zoomY)
        if (!zoom.isFinite()) zoom = MAP_DEFAULT_ZOOM
        zoom = clamp(zoom, MAP_MIN_ZOOM, MAP_MAX_ZOOM)

        val scale = MAP_TILE_SIZE * 2.0.pow(zoom)
        val shiftX = (padding.left + (width - padding.right)) / 2.0 - width / 2.0
        val shiftY = (padding.top + (height - padding.bottom)) / 2.0 - height / 2.0
        val centerX = mercatorX(arc.start) + spanX / 2.0 - shiftX / scale
        val centerY = (yLo + yHi) / 2.0 - shiftY / scale
        return CameraFit(
            valid = true,
            lat = latitudeAtWorldY(centerY),
            lon = normalizeLongitude(longitudeAtWorldX(centerX)),
            zoom = zoom,
        )
    }

    /** What on:regionChange carries: the camera, plus the ground it actually covers. */
    data class MapRegion(
        val centerLat: Double,
        val centerLon: Double,
        val zoom: Double,
        val latSpan: Double,
        val lonSpan: Double,
    )

    /**
     * The region a camera sees. The latitude span is measured by unprojecting both edges,
     * not by scaling the longitude span: mercator stretches with latitude, and a "square"
     * viewport over Oslo covers far less ground north to south than one over Quito.
     */
    fun mapRegion(
        lat: Double,
        lon: Double,
        zoom: Double,
        width: Double,
        height: Double,
    ): MapRegion {
        val scale = MAP_TILE_SIZE * 2.0.pow(zoom)
        val centerY = mercatorY(lat)
        val north = latitudeAtWorldY(centerY - height / 2.0 / scale)
        val south = latitudeAtWorldY(centerY + height / 2.0 / scale)
        return MapRegion(
            centerLat = clamp(lat, -MAP_MAX_MERCATOR_LATITUDE, MAP_MAX_MERCATOR_LATITUDE),
            centerLon = normalizeLongitude(lon),
            zoom = zoom,
            latSpan = north - south,
            lonSpan = width / scale * 360.0,
        )
    }

    // -- cluster: five hundred pins, grouped the same way three times --------------------

    /** The default cell side, in points, at the cluster level. */
    const val CLUSTER_DEFAULT_RADIUS = 60.0

    /** The deepest level the expansion search will look for a split at. */
    const val CLUSTER_MAX_ZOOM = 20

    /** One node a map renders: a cluster bubble, or a lone pin passed through. */
    data class ClusterNode(
        val cluster: Boolean,
        /** c:<level>:<cx>:<cy> for a cluster, p:<pinIndex> for a lone pin. Stable across redraws. */
        val id: String,
        val lat: Double,
        val lon: Double,
        val count: Int,
        val members: List<Int>,
        /** The first level at which the members stop sharing a cell - what on:clusterTap flies to. */
        val expansionZoom: Int,
    )

    private fun cellX(worldX: Double, level: Int, radius: Double): Long =
        floor(worldX * (MAP_TILE_SIZE * 2.0.pow(level.toDouble())) / radius).toLong()

    private fun cellY(worldY: Double, level: Int, radius: Double): Long =
        floor(worldY * (MAP_TILE_SIZE * 2.0.pow(level.toDouble())) / radius).toLong()

    /**
     * Grid-cluster pins for one camera.
     *
     * The algorithm is pinned here rather than left to MKClusterAnnotation, maps-utils and
     * Supercluster, which group differently at the same zoom and make a screenshot test
     * impossible: project each pin to world space, multiply by the world size at the CLUSTER
     * LEVEL, and take the integer cell of side `radius`.
     *
     * The level is floor(zoom), never zoom - a continuous grid slides continuously, so at
     * 12.37 a pin sits in one cell and at 12.38 in the next, and markers flicker while the
     * user pinches. Quantising means membership is identical for every fractional zoom
     * inside a level. Output is row-major by cell (cy, then cx) so all three renderers emit
     * the same nodes in the same order with the same ids, which is what stops marker churn
     * on redraw. A cell holding one pin is NOT a cluster, and a cluster's coordinate is the
     * mean of its members in WORLD space, not the mean of their latitudes.
     */
    fun clusterPins(
        pins: List<GeoPoint>,
        zoom: Double,
        radius: Double,
        maxZoom: Int,
    ): List<ClusterNode> {
        val level = floor(zoom).toInt().coerceIn(0, maxZoom)
        val worldXs = DoubleArray(pins.size)
        val worldYs = DoubleArray(pins.size)
        for (i in pins.indices) {
            worldXs[i] = mercatorX(pins[i].lon)
            worldYs[i] = mercatorY(pins[i].lat)
        }
        val cells = LinkedHashMap<Pair<Long, Long>, MutableList<Int>>()
        for (i in pins.indices) {
            val key = Pair(cellX(worldXs[i], level, radius), cellY(worldYs[i], level, radius))
            val bucket = cells[key]
            if (bucket == null) cells[key] = mutableListOf(i) else bucket.add(i)
        }
        val ordered = cells.entries.sortedWith(
            compareBy({ it.key.second }, { it.key.first }),
        )
        val out = ArrayList<ClusterNode>(ordered.size)
        for (cell in ordered) {
            val members = cell.value
            if (members.size == 1) {
                val i = members[0]
                out.add(
                    ClusterNode(
                        cluster = false,
                        id = "p:$i",
                        lat = pins[i].lat,
                        lon = pins[i].lon,
                        count = 1,
                        members = listOf(i),
                        expansionZoom = level,
                    ),
                )
                continue
            }
            var sumX = 0.0
            var sumY = 0.0
            for (i in members) { sumX += worldXs[i]; sumY += worldYs[i] }
            val meanX = sumX / members.size
            val meanY = sumY / members.size
            out.add(
                ClusterNode(
                    cluster = true,
                    id = "c:$level:${cell.key.first}:${cell.key.second}",
                    lat = latitudeAtWorldY(meanY),
                    lon = normalizeLongitude(longitudeAtWorldX(meanX)),
                    count = members.size,
                    members = members.toList(),
                    expansionZoom = expansionZoom(members, worldXs, worldYs, level, radius, maxZoom),
                ),
            )
        }
        return out
    }

    private fun expansionZoom(
        members: List<Int>,
        worldXs: DoubleArray,
        worldYs: DoubleArray,
        level: Int,
        radius: Double,
        maxZoom: Int,
    ): Int {
        for (l in (level + 1)..maxZoom) {
            val cx0 = cellX(worldXs[members[0]], l, radius)
            val cy0 = cellY(worldYs[members[0]], l, radius)
            for (k in 1 until members.size) {
                val cx = cellX(worldXs[members[k]], l, radius)
                val cy = cellY(worldYs[members[k]], l, radius)
                if (cx != cx0 || cy != cy0) return l
            }
        }
        return maxZoom
    }
}
