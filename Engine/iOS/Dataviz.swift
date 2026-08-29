//
//  Dataviz.swift — the shared `<chart>` / `<map>` numeric core: scale domains and ticks, mark
//  geometry, interaction payload arithmetic, the accessible table, web-mercator camera maths
//  and pin clustering. The law is the corpus, `OpenSource/Conformance/dataviz/` (six files —
//  scales · marks · interaction · a11y · camera · cluster; parity/U09-dataviz.md); the Kotlin
//  twin is `:core` Dataviz.kt and the web twin is @despia/kernel's dataviz.ts, and all three
//  run the SAME files.
//
//  Everything platform-shaped lives OUTSIDE this file. Swift Charts, the Compose canvas and
//  the DOM renderer paint pixels three different ways; what they may NOT do is disagree on
//  where a datum lands, how many gridlines there are, which pins share a cluster, or what
//  VoiceOver is told. Keeping the DECISION separate from the PAINTING is what lets one corpus
//  judge three renderers.
//
//  Two rules that look like fussiness and are not:
//   * the decimal exponent and powers of ten are integer LOOPS, never log10/pow — libm
//     rounding differs between platforms and floor(log10(1000)) is allowed to come back 2,
//     which silently moves every tick on one renderer only;
//   * the cluster level is floor(zoom), never zoom — a continuous grid slides continuously,
//     so annotations visibly flicker while the user pinches.
//
//  No UIKit, no MapKit, no Charts import: this file is pure so the record lane can run it
//  headless and so the Maps module can reach it without either framework being present.
//
import Foundation

public enum Dataviz {

    // MARK: - shared shapes

    /// A resolved numeric axis: the extended bounds, the tick step, and the ticks themselves.
    public struct NiceDomain: Equatable {
        public let lo: Double
        public let hi: Double
        public let step: Double
        public let ticks: [Double]
    }

    /// A d3-shaped band scale: one slot per category, padded inside and out.
    public struct BandLayout: Equatable {
        public let step: Double
        public let bandwidth: Double
        public let start: Double
        public let positions: [Double]
        public let centers: [Double]
    }

    /// A log axis, or the typed refusal that replaces a silent clamp.
    public struct LogDomain: Equatable {
        public let valid: Bool
        public let reason: String
        public let lo: Double
        public let hi: Double
        public let ticks: [Double]
    }

    /// A time axis over FIXED durations (no calendar months — a month is not a duration).
    public struct TimeTicks: Equatable {
        public let step: Double
        public let ticks: [Double]
    }

    /// A window on a domain: the payload shape of zoom, pan and the brush.
    public struct DomainWindow: Equatable {
        public let lo: Double
        public let hi: Double
    }

    // MARK: - scales: the arithmetic before a single pixel

    /// floor(log10(|x|)), by an integer loop.
    ///
    /// Never `log10` + `floor`: libm is entitled to return 2.9999999999999996 for log10(1000),
    /// and one renderer's axis then steps differently from the other two. Zero has no
    /// exponent; it answers 0 so callers never see a NaN.
    public static func decimalExponent(_ x: Double) -> Int {
        var a = abs(x)
        if a == 0 || !a.isFinite { return 0 }
        var e = 0
        while a >= 10 { a /= 10; e += 1 }
        while a < 1 { a *= 10; e -= 1 }
        return e
    }

    /// 10^n, by an integer loop, for the same reason `decimalExponent` is one.
    public static func powerOfTen(_ n: Int) -> Double {
        var r = 1.0
        for _ in 0..<abs(n) { r *= 10 }
        return n < 0 ? 1 / r : r
    }

    /// Heckbert's nice number: the closest "human" number to `x` — 1, 2, 5 or 10 times a power
    /// of ten. `round` picks the nearest; otherwise it rounds UP, which is what an axis range
    /// wants so the data always fits inside it.
    public static func niceNumber(_ x: Double, round: Bool) -> Double {
        if !(x > 0) { return 0 }
        let exp = decimalExponent(x)
        let f = x / powerOfTen(exp)
        let nf: Double
        if round {
            nf = f < 1.5 ? 1 : (f < 3 ? 2 : (f < 7 ? 5 : 10))
        } else {
            nf = f <= 1 ? 1 : (f <= 2 ? 2 : (f <= 5 ? 5 : 10))
        }
        return nf * powerOfTen(exp)
    }

    /// The padding a zero-span domain gets before it is made nice.
    private static let zeroSpanPad = 0.5

    /// Heckbert loose labelling: the domain EXTENDS to the nice bounds rather than the ticks
    /// shrinking inside it, so the first and last tick are always the axis ends. Reversed
    /// bounds are ordered first; a zero span is padded before it is made nice.
    ///
    /// Ticks are `lo + i * step`, never an accumulator — accumulating drifts, and a tick that
    /// reads 5.000000000000001 on one renderer and 5 on another is a diff nobody can explain.
    public static func niceLinearDomain(lo: Double, hi: Double, count: Int) -> NiceDomain {
        var low = min(lo, hi)
        var high = max(lo, hi)
        if low == high { low -= zeroSpanPad; high += zeroSpanPad }
        let n = max(2, count)
        let range = niceNumber(high - low, round: false)
        let step = niceNumber(range / Double(n - 1), round: true)
        if !(step > 0) { return NiceDomain(lo: low, hi: high, step: 0, ticks: [low]) }
        let gLo = (low / step).rounded(.down) * step
        let gHi = (high / step).rounded(.up) * step
        let steps = max(0, Int(((gHi - gLo) / step).rounded()))
        var ticks: [Double] = []
        ticks.reserveCapacity(steps + 1)
        for i in 0...steps { ticks.append(gLo + Double(i) * step) }
        return NiceDomain(lo: gLo, hi: gHi, step: step, ticks: ticks)
    }

    /// The axis a series actually gets. `includeZero` is the bar/area rule (a bar that does not
    /// start at zero lies about its length); a line does not invent a zero it was never given.
    /// An empty series is a unit domain, not a NaN.
    public static func valueDomain(
        values: [Double], includeZero: Bool, count: Int
    ) -> NiceDomain {
        if values.isEmpty { return niceLinearDomain(lo: 0, hi: 1, count: count) }
        var lo = values[0]
        var hi = values[0]
        for v in values {
            if v < lo { lo = v }
            if v > hi { hi = v }
        }
        if includeZero { lo = min(lo, 0); hi = max(hi, 0) }
        return niceLinearDomain(lo: lo, hi: hi, count: count)
    }

    /// Map a value onto a range. An inverted range is the y axis; a degenerate domain lands mid.
    public static func linearScale(_ v: Double, domain: [Double], range: [Double]) -> Double {
        if domain[1] == domain[0] { return (range[0] + range[1]) / 2 }
        return range[0] + (v - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0])
    }

    /// The d3 band scale, verbatim: `step = span / (count - paddingInner + 2 * paddingOuter)`,
    /// `bandwidth = step * (1 - paddingInner)`, and the leftover centred by `align`.
    public static func bandScale(
        count: Int, range: [Double], paddingInner: Double, paddingOuter: Double, align: Double
    ) -> BandLayout {
        let span = range[1] - range[0]
        if count <= 0 {
            return BandLayout(
                step: 0, bandwidth: 0, start: range[0], positions: [], centers: []
            )
        }
        let divisor = max(1e-12, Double(count) - paddingInner + 2 * paddingOuter)
        let step = span / divisor
        let bandwidth = step * (1 - paddingInner)
        let start = range[0] + (span - step * (Double(count) - paddingInner)) * align
        var positions: [Double] = []
        var centers: [Double] = []
        positions.reserveCapacity(count)
        centers.reserveCapacity(count)
        for i in 0..<count {
            let p = start + step * Double(i)
            positions.append(p)
            centers.append(p + bandwidth / 2)
        }
        return BandLayout(
            step: step, bandwidth: bandwidth, start: start,
            positions: positions, centers: centers
        )
    }

    /// The decade a value's upper bound rounds up to (exact powers of ten stay put).
    private static func decimalExponentCeiling(_ x: Double) -> Int {
        let e = decimalExponent(x)
        return powerOfTen(e) == x ? e : e + 1
    }

    /// The refusal a log axis reports rather than clamping a non-positive bound into existence.
    public static let logNonpositiveDomain = "nonpositive_domain"

    /// The log decade ladder. The domain extends to whole decades; two decades or fewer get the
    /// 1-2-5 ladder inside each, more get plain decades on a stride that keeps the label count
    /// near `maxTicks`.
    ///
    /// A non-positive bound is a TYPED REFUSAL, never a silent clamp to some epsilon: a log axis
    /// over data containing a zero is an authoring mistake and the author has to see it.
    public static func logDomain(lo: Double, hi: Double, maxTicks: Int) -> LogDomain {
        if !(lo > 0) || !(hi > 0) {
            return LogDomain(
                valid: false, reason: logNonpositiveDomain, lo: 0, hi: 0, ticks: []
            )
        }
        let low = min(lo, hi)
        let high = max(lo, hi)
        let loDec = decimalExponent(low)
        var hiDec = decimalExponentCeiling(high)
        if hiDec <= loDec { hiDec = loDec + 1 }
        let decades = hiDec - loDec
        var ticks: [Double] = []
        if decades <= 2 {
            var d = loDec
            while d < hiDec {
                let base = powerOfTen(d)
                ticks.append(base)
                ticks.append(2 * base)
                ticks.append(5 * base)
                d += 1
            }
        } else {
            let stride = max(
                1, Int((Double(decades) / Double(max(1, maxTicks))).rounded(.up))
            )
            var d = loDec
            while d < hiDec {
                ticks.append(powerOfTen(d))
                d += stride
            }
        }
        ticks.append(powerOfTen(hiDec))
        return LogDomain(
            valid: true, reason: "", lo: powerOfTen(loDec), hi: powerOfTen(hiDec), ticks: ticks
        )
    }

    /// Position on a log axis. A non-positive value pins to the range start rather than -Inf.
    public static func logScale(_ v: Double, domain: [Double], range: [Double]) -> Double {
        if !(domain[0] > 0) || !(domain[1] > 0) || domain[0] == domain[1] { return range[0] }
        if !(v > 0) { return range[0] }
        let t = (log(v) - log(domain[0])) / (log(domain[1]) - log(domain[0]))
        return range[0] + t * (range[1] - range[0])
    }

    /// The fixed-duration ladder, in seconds. Every entry is a duration a human names — a
    /// quarter minute, a quarter hour, six hours, a week. No months and no years: a month is not
    /// a duration, and a ladder that pretends otherwise ticks 28, 30 or 31 days apart depending
    /// on where the window happens to start.
    public static let timeTickLadder: [Double] = [
        1, 2, 5, 10, 15, 30,
        60, 120, 300, 600, 900, 1800,
        3600, 7200, 10800, 21600, 43200,
        86400, 172800, 604800,
    ]

    private static let secondsPerDay = 86400.0

    /// Ticks on a time axis, in epoch seconds. Ticks snap to the STEP GRID rather than to the
    /// window start, so a chart of the last hour puts labels on the quarter hours instead of on
    /// whatever second the user opened the screen, and they stay INSIDE the domain.
    public static func timeTicks(lo: Double, hi: Double, count: Int) -> TimeTicks {
        let low = min(lo, hi)
        let high = max(lo, hi)
        if low == high { return TimeTicks(step: 1, ticks: [low]) }
        let n = max(2, count)
        let target = (high - low) / Double(n - 1)
        var step = 0.0
        for candidate in timeTickLadder where candidate >= target {
            step = candidate
            break
        }
        if step == 0 { step = niceNumber(target / secondsPerDay, round: true) * secondsPerDay }
        if !(step > 0) { return TimeTicks(step: 1, ticks: [low]) }
        let first = Int((low / step - 1e-9).rounded(.up))
        let last = Int((high / step + 1e-9).rounded(.down))
        var ticks: [Double] = []
        if first <= last {
            for i in first...last { ticks.append(Double(i) * step) }
        }
        return TimeTicks(step: step, ticks: ticks)
    }

    // MARK: - marks: datum to coordinate

    private static let degrees = Double.pi / 180

    /// One slice of a pie or donut, with the centroid a label or a callout anchors to.
    public struct PieSlice: Equatable {
        public let index: Int
        public let value: Double
        public let fraction: Double
        public let startAngle: Double
        public let endAngle: Double
        public let sweep: Double
        public let centroidX: Double
        public let centroidY: Double
        /// A lone slice is a CIRCLE. A renderer that draws it as a 360-degree arc draws nothing.
        public let full: Bool
    }

    /// A resolved pie: the slices plus the radii, or `empty` when there is nothing to divide.
    public struct PieLayout: Equatable {
        public let total: Double
        public let empty: Bool
        public let innerRadius: Double
        public let outerRadius: Double
        public let slices: [PieSlice]
    }

    /// Pie / donut geometry. Angles are DEGREES, screen-oriented: -90 is twelve o'clock, +y is
    /// down, and a clockwise pie sweeps toward +x first. `innerRadius` <= 1 is a fraction of the
    /// outer radius; above 1 it is taken verbatim.
    ///
    /// Negative values are SKIPPED, keeping their index, never folded into the total — a pie of
    /// a signed series is meaningless, and quietly taking absolute values is how it ships
    /// anyway. A total of zero is `empty`, not a division by zero.
    public static func pieSlices(
        values: [Double],
        outerRadius: Double,
        innerRadius: Double,
        startAngle: Double,
        padAngle: Double,
        clockwise: Bool
    ) -> PieLayout {
        let inner = innerRadius <= 1 ? innerRadius * outerRadius : innerRadius
        var total = 0.0
        for v in values where v > 0 { total += v }
        if !(total > 0) {
            return PieLayout(
                total: 0, empty: true, innerRadius: inner,
                outerRadius: outerRadius, slices: []
            )
        }
        let centroidRadius = (inner + outerRadius) / 2
        var slices: [PieSlice] = []
        var cursor = startAngle
        for i in values.indices {
            let v = values[i]
            if !(v > 0) { continue }
            let fraction = v / total
            let raw = fraction * 360
            let sweep = max(0, raw - padAngle)
            let a0 = cursor
            let a1 = clockwise ? cursor + sweep : cursor - sweep
            cursor = clockwise ? cursor + raw : cursor - raw
            let mid = (a0 + a1) / 2
            slices.append(
                PieSlice(
                    index: i,
                    value: v,
                    fraction: fraction,
                    startAngle: a0,
                    endAngle: a1,
                    sweep: sweep,
                    centroidX: centroidRadius * cos(mid * degrees),
                    centroidY: centroidRadius * sin(mid * degrees),
                    full: abs(sweep) >= 360 - 1e-9
                )
            )
        }
        return PieLayout(
            total: total, empty: false, innerRadius: inner,
            outerRadius: outerRadius, slices: slices
        )
    }

    /// Bubble radius for a scatter `size` field. Interpolates AREA, not radius, because the eye
    /// reads area: a datum twice as large must cover twice the ink, and a linear radius ramp
    /// makes it cover four times. An all-equal series takes the midpoint rather than the floor —
    /// every bubble at `rMin` reads as "no data" instead of "all the same".
    public static func bubbleRadius(
        _ v: Double, min minValue: Double, max maxValue: Double, rMin: Double, rMax: Double
    ) -> Double {
        if !(maxValue > minValue) { return (rMin + rMax) / 2 }
        var t = (v - minValue) / (maxValue - minValue)
        if t < 0 { t = 0 }
        if t > 1 { t = 1 }
        return (rMin * rMin + t * (rMax * rMax - rMin * rMin)).squareRoot()
    }

    /// One vertex of a radar polygon.
    public struct RadarPoint: Equatable {
        public let index: Int
        public let fraction: Double
        public let angle: Double
        public let x: Double
        public let y: Double
    }

    /// Radar / spider vertices: axis 0 at twelve o'clock, then clockwise, clamped to the ring.
    public static func radarPoints(
        values: [Double], max maxValue: Double, radius: Double,
        centerX: Double, centerY: Double
    ) -> [RadarPoint] {
        let n = values.count
        var out: [RadarPoint] = []
        out.reserveCapacity(n)
        for i in 0..<n {
            var fraction = maxValue > 0 ? values[i] / maxValue : 0
            if fraction < 0 { fraction = 0 }
            if fraction > 1 { fraction = 1 }
            let angle = -90 + 360 * Double(i) / Double(n)
            out.append(
                RadarPoint(
                    index: i,
                    fraction: fraction,
                    angle: angle,
                    x: centerX + radius * fraction * cos(angle * degrees),
                    y: centerY + radius * fraction * sin(angle * degrees)
                )
            )
        }
        return out
    }

    /// One trapezoid of a funnel, plus the two conversion ratios the label wants.
    public struct FunnelStage: Equatable {
        public let index: Int
        public let topWidth: Double
        public let bottomWidth: Double
        public let top: Double
        public let bottom: Double
        public let ofFirst: Double
        public let ofPrevious: Double
    }

    /// Funnel stages. Widths are normalised by the LARGEST value (a widening stage is drawn, not
    /// clamped — a funnel that hides a stage growing is hiding the interesting one), while the
    /// ratios are against the first and the previous stage. The last stage is a rectangle: a
    /// taper to nothing implies a conversion to zero that the data never said.
    public static func funnelStages(
        values: [Double], width: Double, height: Double, gap: Double
    ) -> [FunnelStage] {
        let n = values.count
        if n == 0 { return [] }
        var maxValue = values[0]
        for v in values where v > maxValue { maxValue = v }
        let stageHeight = (height - gap * Double(n - 1)) / Double(n)
        let first = values[0]
        var out: [FunnelStage] = []
        out.reserveCapacity(n)
        for i in 0..<n {
            let v = values[i]
            let next = i + 1 < n ? values[i + 1] : v
            let previous = i == 0 ? v : values[i - 1]
            let top = Double(i) * (stageHeight + gap)
            out.append(
                FunnelStage(
                    index: i,
                    topWidth: maxValue > 0 ? width * v / maxValue : 0,
                    bottomWidth: maxValue > 0 ? width * next / maxValue : 0,
                    top: top,
                    bottom: top + stageHeight,
                    ofFirst: first == 0 ? 0 : v / first,
                    ofPrevious: i == 0 ? 1 : (previous == 0 ? 0 : v / previous)
                )
            )
        }
        return out
    }

    /// Which way a candle closed. `flat` is a doji and still gets a visible body.
    public static func candleDirection(open: Double, close: Double) -> String {
        if close > open { return "up" }
        if close < open { return "down" }
        return "flat"
    }

    /// A timestamped scalar — the input a candlestick is folded from.
    public struct TimePoint: Equatable {
        public let t: Double
        public let v: Double
        public init(t: Double, v: Double) { self.t = t; self.v = v }
    }

    /// One OHLC bucket folded out of a tick stream.
    public struct Candle: Equatable {
        public let bucket: Int
        public let start: Double
        public let open: Double
        public let high: Double
        public let low: Double
        public let close: Double
        public let count: Int
        public let direction: String
    }

    /// Fold a tick stream into OHLC buckets on a fixed grid anchored at `origin`.
    ///
    /// Empty buckets are SKIPPED, never emitted as zeros: a market that did not trade is not a
    /// market that traded at zero, and a chart that draws the gap as a crash is worse than a
    /// chart with a gap. Points are ordered by (t, arrival) first, so `open` and `close` do not
    /// depend on the platform's sort being stable — Swift's is not.
    public static func candleBuckets(
        points: [TimePoint], interval: Double, origin: Double
    ) -> [Candle] {
        if !(interval > 0) || points.isEmpty { return [] }
        let order = points.indices.sorted { a, b in
            points[a].t == points[b].t ? a < b : points[a].t < points[b].t
        }
        var open: [Int: Double] = [:]
        var high: [Int: Double] = [:]
        var low: [Int: Double] = [:]
        var close: [Int: Double] = [:]
        var counts: [Int: Int] = [:]
        for i in order {
            let p = points[i]
            let bucket = Int(((p.t - origin) / interval).rounded(.down))
            if counts[bucket] == nil {
                open[bucket] = p.v
                high[bucket] = p.v
                low[bucket] = p.v
                close[bucket] = p.v
                counts[bucket] = 1
            } else {
                if p.v > high[bucket]! { high[bucket] = p.v }
                if p.v < low[bucket]! { low[bucket] = p.v }
                close[bucket] = p.v
                counts[bucket] = counts[bucket]! + 1
            }
        }
        return counts.keys.sorted().map { bucket in
            Candle(
                bucket: bucket,
                start: origin + Double(bucket) * interval,
                open: open[bucket]!,
                high: high[bucket]!,
                low: low[bucket]!,
                close: close[bucket]!,
                count: counts[bucket]!,
                direction: candleDirection(open: open[bucket]!, close: close[bucket]!)
            )
        }
    }

    /// Where one candle's body and wick land, in range units (y grows downward).
    public struct CandleGeometry: Equatable {
        public let bodyTop: Double
        public let bodyBottom: Double
        public let wickTop: Double
        public let wickBottom: Double
        public let direction: String
    }

    /// One candle's pixels. The range is screen-oriented: `range[1]` is the BOTTOM, so the
    /// domain maximum sits at `range[0]`.
    ///
    /// A doji (open == close) is expanded to `minBody` around its centre — a zero-height body is
    /// invisible, and the flat day is exactly the one a reader is looking for.
    public static func candleGeometry(
        open: Double, high: Double, low: Double, close: Double,
        domain: [Double], range: [Double], minBody: Double
    ) -> CandleGeometry {
        func y(_ v: Double) -> Double {
            if domain[1] == domain[0] { return (range[0] + range[1]) / 2 }
            return range[1] - (v - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0])
        }
        let yOpen = y(open)
        let yClose = y(close)
        var bodyTop = min(yOpen, yClose)
        var bodyBottom = max(yOpen, yClose)
        if bodyBottom - bodyTop < minBody {
            let mid = (bodyTop + bodyBottom) / 2
            bodyTop = mid - minBody / 2
            bodyBottom = mid + minBody / 2
        }
        return CandleGeometry(
            bodyTop: bodyTop,
            bodyBottom: bodyBottom,
            wickTop: y(high),
            wickBottom: y(low),
            direction: candleDirection(open: open, close: close)
        )
    }

    /// One heat-map cell: its bin, the summed weight, and that weight against the hottest cell.
    public struct HeatmapCell: Equatable {
        public let xBin: Int
        public let yBin: Int
        public let value: Double
        public let intensity: Double
    }

    /// The whole grid, row-major (yBin outer, xBin inner), plus the maximum it normalises by.
    public struct HeatmapGrid: Equatable {
        public let max: Double
        public let cells: [HeatmapCell]
    }

    /// A weighted point — the input a heat map (chart or map overlay) is folded from.
    public struct WeightedPoint: Equatable {
        public let x: Double
        public let y: Double
        public let w: Double
        public init(x: Double, y: Double, w: Double) { self.x = x; self.y = y; self.w = w }
    }

    /// Bin weighted points into a heat-map grid.
    ///
    /// The last bin owns its own upper edge: `floor(t * bins)` puts the domain maximum in a
    /// phantom bin `bins`, which is the off-by-one every heat map ships once. Out-of-domain
    /// points clamp into the edge bins rather than vanishing, and an empty grid is zero
    /// intensity everywhere, never NaN.
    public static func heatmapCells(
        points: [WeightedPoint], xBins: Int, yBins: Int,
        xDomain: [Double], yDomain: [Double]
    ) -> HeatmapGrid {
        if xBins <= 0 || yBins <= 0 { return HeatmapGrid(max: 0, cells: []) }
        var grid = [Double](repeating: 0, count: xBins * yBins)
        for p in points {
            let bx = binIndex(p.x, domain: xDomain, bins: xBins)
            let by = binIndex(p.y, domain: yDomain, bins: yBins)
            grid[by * xBins + bx] += p.w
        }
        var maxValue = 0.0
        for v in grid where v > maxValue { maxValue = v }
        var cells: [HeatmapCell] = []
        cells.reserveCapacity(xBins * yBins)
        for by in 0..<yBins {
            for bx in 0..<xBins {
                let value = grid[by * xBins + bx]
                cells.append(
                    HeatmapCell(
                        xBin: bx, yBin: by, value: value,
                        intensity: maxValue > 0 ? value / maxValue : 0
                    )
                )
            }
        }
        return HeatmapGrid(max: maxValue, cells: cells)
    }

    private static func binIndex(_ v: Double, domain: [Double], bins: Int) -> Int {
        if domain[1] == domain[0] { return 0 }
        let i = Int(((v - domain[0]) / (domain[1] - domain[0]) * Double(bins)).rounded(.down))
        if i < 0 { return 0 }
        if i > bins - 1 { return bins - 1 }
        return i
    }

    // MARK: - interaction: what on:select / on:hover / on:brush actually carry

    /// The index a tap at `fraction` across the plot selects. This is the rule the shipped
    /// renderers already use for `on:select`, lifted out so `on:hover` inherits it exactly
    /// instead of growing a second, subtly different one.
    ///
    /// An empty series answers -1 — a typed absence, never index 0 pointing at nothing.
    public static func nearestIndex(fraction: Double, count: Int) -> Int {
        if count <= 0 { return -1 }
        if count == 1 { return 0 }
        let i = Int((fraction * Double(count - 1) + 0.5).rounded(.down))
        if i < 0 { return 0 }
        if i > count - 1 { return count - 1 }
        return i
    }

    /// The nearest datum by VALUE (a continuous x axis). A tie takes the lower index.
    public static func nearestValueIndex(_ value: Double, values: [Double]) -> Int {
        if values.isEmpty { return -1 }
        var best = 0
        var bestDistance = abs(value - values[0])
        for i in 1..<values.count {
            let d = abs(value - values[i])
            if d < bestDistance { bestDistance = d; best = i }
        }
        return best
    }

    /// A brush selection, or the CLEAR that a tap inside a brushable chart really is.
    public struct BrushWindow: Equatable {
        public let start: Double
        public let end: Double
        public let cleared: Bool
    }

    /// Below this fraction of the plot a drag is a tap, and a tap clears the brush.
    public static let brushMinFraction = 0.01

    /// Fold a drag into a brush payload. Direction does not matter — a right-to-left drag
    /// reports the same window — and both ends clamp into the plot.
    public static func brushWindow(
        from: Double, to: Double, domain: [Double]
    ) -> BrushWindow {
        let lo = clamp(min(from, to), 0, 1)
        let hi = clamp(max(from, to), 0, 1)
        if hi - lo < brushMinFraction {
            return BrushWindow(start: domain[0], end: domain[1], cleared: true)
        }
        let span = domain[1] - domain[0]
        return BrushWindow(
            start: domain[0] + lo * span, end: domain[0] + hi * span, cleared: false
        )
    }

    /// The tightest window a pinch may reach, as a fraction of the full data extent.
    public static let zoomMinSpanFraction = 0.01

    /// Zoom the visible domain about an anchor (0 = left edge, 1 = right edge of the plot).
    ///
    /// The window clamps to the full data extent — no rubber band past the data, no inversion —
    /// and the span has a floor so a fast pinch cannot divide by zero. A window pushed past an
    /// edge is SHIFTED back in, not clipped: clipping silently changes the zoom level the user
    /// asked for.
    public static func zoomDomain(
        domain: [Double], full: [Double], factor: Double, anchor: Double
    ) -> DomainWindow {
        let fullSpan = full[1] - full[0]
        if !(fullSpan > 0) || !(factor > 0) { return DomainWindow(lo: full[0], hi: full[1]) }
        let span = domain[1] - domain[0]
        let newSpan = clamp(span / factor, fullSpan * zoomMinSpanFraction, fullSpan)
        let anchorValue = domain[0] + anchor * span
        var lo = anchorValue - anchor * newSpan
        if lo < full[0] { lo = full[0] }
        if lo + newSpan > full[1] { lo = full[1] - newSpan }
        if lo < full[0] { lo = full[0] }
        return DomainWindow(lo: lo, hi: lo + newSpan)
    }

    /// Pan by a fraction of the visible span, keeping the span and staying inside the extent.
    public static func panDomain(
        domain: [Double], full: [Double], delta: Double
    ) -> DomainWindow {
        let span = domain[1] - domain[0]
        var lo = domain[0] + delta * span
        if lo < full[0] { lo = full[0] }
        if lo + span > full[1] { lo = full[1] - span }
        if lo < full[0] { lo = full[0] }
        return DomainWindow(lo: lo, hi: lo + span)
    }

    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        if v < lo { return lo }
        if v > hi { return hi }
        return v
    }

    // MARK: - accessibleTable: the numbers, for the reader who cannot see the chart

    /// One bound cell, typed at the boundary.
    ///
    /// Swift is the renderer where `Any` bites: `NSNumber(1)` casts to `Bool` and `NSNumber(true)`
    /// casts to `Int`, so a bridged JSON value cannot be classified by `as?` alone. Naming the
    /// four shapes here means the ambiguity is resolved ONCE, in `Datum.from`, instead of
    /// differently at every call site.
    public enum Datum: Equatable {
        case string(String)
        case number(Double)
        case boolean(Bool)
        case missing
    }

    /// The accessible representation of a chart: a real table plus the sentence above it.
    public struct AccessibleTable: Equatable {
        public let caption: String
        public let columns: [String]
        public let rows: [[String]]
        /// The same sentence the figure's label speaks, so the two can never drift apart.
        public let summary: String
    }

    /// Which fields of the bound rows the chart is plotting, and what the axes are called.
    public struct AccessibleTableSpec: Equatable {
        public let x: String
        public let y: String
        /// "" for a single-series chart.
        public let series: String
        public let type: String
        public let xTitle: String
        public let yTitle: String
        public init(
            x: String, y: String, series: String, type: String, xTitle: String, yTitle: String
        ) {
            self.x = x
            self.y = y
            self.series = series
            self.type = type
            self.xTitle = xTitle
            self.yTitle = yTitle
        }
    }

    /// Format one cell. An integer prints as an integer and everything else to two decimals — a
    /// screen reader saying "one thousand two hundred point zero zero" for a whole number is
    /// noise, and "1500.5" read as digits is worse than "1500.50".
    public static func formatCell(_ datum: Datum) -> String {
        switch datum {
        case .missing:
            return ""
        case .boolean(let b):
            return b ? "true" : "false"
        case .string(let s):
            return s
        case .number(let d):
            if !d.isFinite { return "" }
            if d == d.rounded(.towardZero) && abs(d) < 1e15 { return String(Int64(d)) }
            return String(format: "%.2f", d)
        }
    }

    /// Pivot a chart's bound rows into the table `accessibleTable=` renders. Default ON, and
    /// nearly free: the data is already structured and `<Table>` already exists, so a blind user
    /// gets the numbers, a sighted user gets the chart, and the author writes one element. On
    /// iOS the same rows also feed `AXChart`'s audio graph.
    ///
    /// Both axes are in FIRST APPEARANCE order, never sorted — the author's row order is the
    /// author's intent. A missing (x, series) cell is an EMPTY STRING, never a zero: a datum
    /// that was not measured is not a measurement of nothing. A duplicate pair is last-wins.
    public static func accessibleTable(
        rows: [[String: Datum]], spec: AccessibleTableSpec
    ) -> AccessibleTable {
        let multiSeries = spec.series != ""
        var xLabels: [String] = []
        var seriesLabels: [String] = []
        var cells: [String: [String: String]] = [:]
        var minValue = 0.0
        var maxValue = 0.0
        var sawNumber = false

        for row in rows {
            let xLabel = formatCell(row[spec.x] ?? .missing)
            if !xLabels.contains(xLabel) { xLabels.append(xLabel) }
            let seriesLabel = multiSeries ? formatCell(row[spec.series] ?? .missing) : ""
            if multiSeries && !seriesLabels.contains(seriesLabel) {
                seriesLabels.append(seriesLabel)
            }
            let raw = row[spec.y] ?? .missing
            if case .number(let d) = raw, d.isFinite {
                if !sawNumber {
                    minValue = d
                    maxValue = d
                    sawNumber = true
                } else {
                    if d < minValue { minValue = d }
                    if d > maxValue { maxValue = d }
                }
            }
            cells[xLabel, default: [:]][seriesLabel] = formatCell(raw)
        }

        let xHeader = spec.xTitle != "" ? spec.xTitle : spec.x
        let yHeader = spec.yTitle != "" ? spec.yTitle : spec.y
        var columns: [String] = [xHeader]
        if multiSeries { columns.append(contentsOf: seriesLabels) } else { columns.append(yHeader) }
        var table: [[String]] = []
        table.reserveCapacity(xLabels.count)
        for xLabel in xLabels {
            let bySeries = cells[xLabel]
            var out: [String] = [xLabel]
            if multiSeries {
                for seriesLabel in seriesLabels { out.append(bySeries?[seriesLabel] ?? "") }
            } else {
                out.append(bySeries?[""] ?? "")
            }
            table.append(out)
        }

        let caption: String
        if multiSeries {
            caption = "\(spec.type) chart. \(rows.count) data points in "
                + "\(seriesLabels.count) series. \(yHeader) by \(xHeader)."
        } else {
            caption = "\(spec.type) chart. \(rows.count) data points. \(yHeader) by \(xHeader)."
        }
        var summary = "\(spec.type) chart with \(rows.count) points"
        if sawNumber {
            summary += "; values range from \(formatCell(.number(minValue)))"
                + " to \(formatCell(.number(maxValue)))"
        }
        return AccessibleTable(
            caption: caption, columns: columns, rows: table, summary: summary
        )
    }

    // MARK: - camera: web mercator, and the two things nobody gets right

    /// One map tile's edge, in points. Every zoom level is `tileSize * 2^zoom` across.
    public static let mapTileSize = 256.0
    public static let mapMinZoom = 0.0
    public static let mapMaxZoom = 22.0
    /// Where a camera sits when the content cannot imply a zoom (one pin, or none).
    public static let mapDefaultZoom = 16.0
    /// Web mercator cannot reach a pole; this is where the projection is cut.
    public static let mapMaxMercatorLatitude = 85.05112878

    /// Wrap a longitude to -180 up to but not including 180. The antimeridian normalises WEST.
    public static func normalizeLongitude(_ lon: Double) -> Double {
        var r = (lon + 180).truncatingRemainder(dividingBy: 360)
        if r < 0 { r += 360 }
        return r - 180
    }

    /// Longitude to normalised world x, 0 at -180 and 1 at +180.
    public static func mercatorX(_ lon: Double) -> Double {
        (normalizeLongitude(lon) + 180) / 360
    }

    /// Latitude to normalised world y, 0 at the north cut and 1 at the south.
    public static func mercatorY(_ lat: Double) -> Double {
        let clamped = clamp(lat, -mapMaxMercatorLatitude, mapMaxMercatorLatitude)
        let s = sin(clamped * degrees)
        return 0.5 - log((1 + s) / (1 - s)) / (4 * Double.pi)
    }

    /// World x back to longitude.
    public static func longitudeAtWorldX(_ worldX: Double) -> Double { worldX * 360 - 180 }

    /// World y back to latitude.
    public static func latitudeAtWorldY(_ worldY: Double) -> Double {
        atan(sinh(Double.pi * (1 - 2 * worldY))) / degrees
    }

    /// A geographic point, the way `pins=`, `fitTo=` and `camera=` all bind it.
    public struct GeoPoint: Equatable {
        public let lat: Double
        public let lon: Double
        public init(lat: Double, lon: Double) { self.lat = lat; self.lon = lon }
    }

    /// Insets that overlaying UI takes out of the map, in points.
    public struct EdgePadding: Equatable {
        public let top: Double
        public let right: Double
        public let bottom: Double
        public let left: Double
        public init(top: Double, right: Double, bottom: Double, left: Double) {
            self.top = top
            self.right = right
            self.bottom = bottom
            self.left = left
        }
    }

    /// A camera, or the typed refusal that replaces a camera at null island.
    public struct CameraFit: Equatable {
        public let valid: Bool
        public let lat: Double
        public let lon: Double
        public let zoom: Double
    }

    /// The western end of the minimal enclosing longitude arc, and its width.
    public struct LongitudeArc: Equatable {
        public let start: Double
        public let span: Double
    }

    /// The minimal enclosing longitude arc of a set of points.
    ///
    /// Taking min and max longitude of a set straddling 180 degrees produces a span of nearly the
    /// whole planet and a camera that flies the long way round. The fix is to sort the
    /// longitudes, find the largest circular GAP, and keep what is left.
    public static func minimalLongitudeArc(_ lons: [Double]) -> LongitudeArc {
        let n = lons.count
        if n == 0 { return LongitudeArc(start: 0, span: 0) }
        let sorted = lons.map { normalizeLongitude($0) }.sorted()
        if n == 1 { return LongitudeArc(start: sorted[0], span: 0) }
        var gap = -1.0
        var gapIndex = 0
        for i in 0..<n {
            let next = (i + 1) % n
            let g = next == 0 ? sorted[0] + 360 - sorted[n - 1] : sorted[next] - sorted[i]
            if g > gap { gap = g; gapIndex = i }
        }
        return LongitudeArc(start: sorted[(gapIndex + 1) % n], span: 360 - gap)
    }

    /// The camera that fits `coords` into a viewport, respecting asymmetric padding.
    ///
    /// The content is centred in the USABLE rectangle, not the viewport, so the camera centre
    /// shifts by half the padding difference converted back to world units AT THE CHOSEN ZOOM —
    /// a bottom sheet covering 40% of the screen otherwise hides the very pins that were fitted.
    /// A single coordinate is not a zero-span bug, it is a request to sit at the default zoom;
    /// no coordinates is a typed invalid.
    public static func fitCamera(
        coords: [GeoPoint], width: Double, height: Double, padding: EdgePadding
    ) -> CameraFit {
        if coords.isEmpty {
            return CameraFit(valid: false, lat: 0, lon: 0, zoom: mapDefaultZoom)
        }
        let usableWidth = max(1, width - padding.left - padding.right)
        let usableHeight = max(1, height - padding.top - padding.bottom)
        let arc = minimalLongitudeArc(coords.map { $0.lon })
        var yLo = mercatorY(coords[0].lat)
        var yHi = yLo
        for c in coords {
            let y = mercatorY(c.lat)
            if y < yLo { yLo = y }
            if y > yHi { yHi = y }
        }
        let spanX = arc.span / 360
        let spanY = yHi - yLo
        let zoomX = spanX > 0 ? log2(usableWidth / (spanX * mapTileSize)) : Double.infinity
        let zoomY = spanY > 0 ? log2(usableHeight / (spanY * mapTileSize)) : Double.infinity
        var zoom = min(zoomX, zoomY)
        if !zoom.isFinite { zoom = mapDefaultZoom }
        zoom = clamp(zoom, mapMinZoom, mapMaxZoom)

        let scale = mapTileSize * pow(2, zoom)
        let shiftX = (padding.left + (width - padding.right)) / 2 - width / 2
        let shiftY = (padding.top + (height - padding.bottom)) / 2 - height / 2
        let centerX = mercatorX(arc.start) + spanX / 2 - shiftX / scale
        let centerY = (yLo + yHi) / 2 - shiftY / scale
        return CameraFit(
            valid: true,
            lat: latitudeAtWorldY(centerY),
            lon: normalizeLongitude(longitudeAtWorldX(centerX)),
            zoom: zoom
        )
    }

    /// What `on:regionChange` carries: the camera, plus the ground it actually covers.
    public struct MapRegion: Equatable {
        public let centerLat: Double
        public let centerLon: Double
        public let zoom: Double
        public let latSpan: Double
        public let lonSpan: Double
    }

    /// The region a camera sees. The latitude span is measured by unprojecting both edges, not by
    /// scaling the longitude span: mercator stretches with latitude, and a "square" viewport over
    /// Oslo covers far less ground north to south than one over Quito.
    public static func mapRegion(
        lat: Double, lon: Double, zoom: Double, width: Double, height: Double
    ) -> MapRegion {
        let scale = mapTileSize * pow(2, zoom)
        let centerY = mercatorY(lat)
        let north = latitudeAtWorldY(centerY - height / 2 / scale)
        let south = latitudeAtWorldY(centerY + height / 2 / scale)
        return MapRegion(
            centerLat: clamp(lat, -mapMaxMercatorLatitude, mapMaxMercatorLatitude),
            centerLon: normalizeLongitude(lon),
            zoom: zoom,
            latSpan: north - south,
            lonSpan: width / scale * 360
        )
    }

    // MARK: - cluster: five hundred pins, grouped the same way three times

    /// The default cell side, in points, at the cluster level.
    public static let clusterDefaultRadius = 60.0
    /// The deepest level the expansion search will look for a split at.
    public static let clusterMaxZoom = 20

    /// One node a map renders: a cluster bubble, or a lone pin passed through.
    public struct ClusterNode: Equatable {
        public let cluster: Bool
        /// `c:<level>:<cx>:<cy>` for a cluster, `p:<pinIndex>` for a lone pin.
        public let id: String
        public let lat: Double
        public let lon: Double
        public let count: Int
        public let members: [Int]
        /// The first level at which the members stop sharing a cell — what `on:clusterTap` flies to.
        public let expansionZoom: Int
    }

    private struct Cell: Hashable {
        let x: Int
        let y: Int
    }

    private static func cell(
        worldX: Double, worldY: Double, level: Int, radius: Double
    ) -> Cell {
        let worldSize = mapTileSize * pow(2, Double(level))
        return Cell(
            x: Int((worldX * worldSize / radius).rounded(.down)),
            y: Int((worldY * worldSize / radius).rounded(.down))
        )
    }

    /// Grid-cluster pins for one camera.
    ///
    /// The algorithm is pinned here rather than left to `MKClusterAnnotation`, maps-utils and
    /// Supercluster, which group differently at the same zoom and make a screenshot test
    /// impossible: project each pin to world space, multiply by the world size at the CLUSTER
    /// LEVEL, and take the integer cell of side `radius`.
    ///
    /// The level is `floor(zoom)`, never `zoom` — a continuous grid slides continuously, so at
    /// 12.37 a pin sits in one cell and at 12.38 in the next, and annotations flicker while the
    /// user pinches. Quantising means membership is identical for every fractional zoom inside a
    /// level. Output is row-major by cell (cy, then cx) so all three renderers emit the same
    /// nodes in the same order with the same ids, which is what stops annotation churn on
    /// redraw. A cell holding one pin is NOT a cluster, and a cluster's coordinate is the mean
    /// of its members in WORLD space, not the mean of their latitudes.
    public static func clusterPins(
        pins: [GeoPoint], zoom: Double, radius: Double, maxZoom: Int
    ) -> [ClusterNode] {
        var level = Int(zoom.rounded(.down))
        if level < 0 { level = 0 }
        if level > maxZoom { level = maxZoom }
        var worldXs = [Double](repeating: 0, count: pins.count)
        var worldYs = [Double](repeating: 0, count: pins.count)
        for i in pins.indices {
            worldXs[i] = mercatorX(pins[i].lon)
            worldYs[i] = mercatorY(pins[i].lat)
        }
        var cells: [Cell: [Int]] = [:]
        for i in pins.indices {
            let key = cell(worldX: worldXs[i], worldY: worldYs[i], level: level, radius: radius)
            cells[key, default: []].append(i)
        }
        let ordered = cells.keys.sorted { a, b in a.y == b.y ? a.x < b.x : a.y < b.y }
        var out: [ClusterNode] = []
        out.reserveCapacity(ordered.count)
        for key in ordered {
            let members = cells[key]!
            if members.count == 1 {
                let i = members[0]
                out.append(
                    ClusterNode(
                        cluster: false,
                        id: "p:\(i)",
                        lat: pins[i].lat,
                        lon: pins[i].lon,
                        count: 1,
                        members: [i],
                        expansionZoom: level
                    )
                )
                continue
            }
            var sumX = 0.0
            var sumY = 0.0
            for i in members {
                sumX += worldXs[i]
                sumY += worldYs[i]
            }
            let meanX = sumX / Double(members.count)
            let meanY = sumY / Double(members.count)
            out.append(
                ClusterNode(
                    cluster: true,
                    id: "c:\(level):\(key.x):\(key.y)",
                    lat: latitudeAtWorldY(meanY),
                    lon: normalizeLongitude(longitudeAtWorldX(meanX)),
                    count: members.count,
                    members: members,
                    expansionZoom: expansionZoom(
                        members: members, worldXs: worldXs, worldYs: worldYs,
                        level: level, radius: radius, maxZoom: maxZoom
                    )
                )
            )
        }
        return out
    }

    private static func expansionZoom(
        members: [Int], worldXs: [Double], worldYs: [Double],
        level: Int, radius: Double, maxZoom: Int
    ) -> Int {
        if level + 1 > maxZoom { return maxZoom }
        for l in (level + 1)...maxZoom {
            let first = cell(
                worldX: worldXs[members[0]], worldY: worldYs[members[0]],
                level: l, radius: radius
            )
            for k in 1..<members.count {
                let other = cell(
                    worldX: worldXs[members[k]], worldY: worldYs[members[k]],
                    level: l, radius: radius
                )
                if other != first { return l }
            }
        }
        return maxZoom
    }
}

extension Dataviz.Datum {

    /// Classify one bound value.
    ///
    /// The `Bool` test is by DYNAMIC TYPE, not `as? Bool`: a bridged `NSNumber(1)` satisfies
    /// `as? Bool` on Apple platforms and would read as `true` instead of `1`. A JSON boolean
    /// arriving as an `NSNumber` therefore lands as a number, which is the safe direction — the
    /// wrong one silently rewrites data as words.
    public static func from(_ value: Any?) -> Dataviz.Datum {
        guard let value = value else { return .missing }
        if value is NSNull { return .missing }
        if type(of: value) == Bool.self, let b = value as? Bool { return .boolean(b) }
        if let s = value as? String { return .string(s) }
        if let n = value as? NSNumber { return .number(n.doubleValue) }
        if let d = value as? Double { return .number(d) }
        if let i = value as? Int { return .number(Double(i)) }
        return .string(String(describing: value))
    }
}
