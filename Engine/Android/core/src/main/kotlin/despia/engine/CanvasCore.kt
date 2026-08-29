//
//  CanvasCore.kt - the shared `<canvas>` core (:core, pure JVM): the SVG path-data parser,
//  the 2-D transform plane, fill-rule resolution, gradient normalisation, the tier-1
//  display list (+ its keyed diff and SVG serialisation), the tier-2 command recorder, the
//  `on:frame` schedule and the accessibility fold. The law is the corpus,
//  OpenSource/Conformance/canvas/ (parity/U04-canvas.md). The twin of the web
//  @despia-native/kernel canvas-core.ts and of Swift CanvasCore.
//
//  WHY THIS IS A SHARED CORE AND NOT THREE RASTERISERS. Three rasterisers will never be
//  bit-identical, so the determinism split is deliberate: PIXELS are toleranced and belong
//  to the platform (DrawScope / GraphicsContext / canvas 2D), GEOMETRY is exact and lives
//  here. A path's normalized segment list, a transform's composed matrix, a gradient's stop
//  offsets, a display list's keys and diff, a tier-2 command stream and the frame budget are
//  all pure data folds, and a renderer that disagrees with one of them draws a different
//  picture no tolerance can excuse.
//
package despia.engine

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

// -- numbers ---------------------------------------------------------------------------

/** the affine six: x' = a*x + c*y + e, y' = b*x + d*y + f (the SVG / Canvas2D spelling,
 *  never the scene kernel's column-major mat4 - a 2-D canvas has no third axis and
 *  borrowing the 3-D shape would invite silent index drift) */
data class CanvasMatrix(
    val a: Double, val b: Double, val c: Double,
    val d: Double, val e: Double, val f: Double,
) {
    fun toList(): List<Double> = listOf(a, b, c, d, e, f)

    val isIdentity: Boolean
        get() = a == 1.0 && b == 0.0 && c == 0.0 && d == 1.0 && e == 0.0 && f == 0.0

    companion object {
        val IDENTITY = CanvasMatrix(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    }
}

/** world = parentWorld * local, the same fold the scene kernel uses one dimension up */
fun canvasMatMul(m: CanvasMatrix, n: CanvasMatrix): CanvasMatrix = CanvasMatrix(
    m.a * n.a + m.c * n.b,
    m.b * n.a + m.d * n.b,
    m.a * n.c + m.c * n.d,
    m.b * n.c + m.d * n.d,
    m.a * n.e + m.c * n.f + m.e,
    m.b * n.e + m.d * n.f + m.f,
)

fun canvasApply(m: CanvasMatrix, x: Double, y: Double): DoubleArray =
    doubleArrayOf(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)

private const val DEG = Math.PI / 180.0

private fun asDouble(value: Any?, fallback: Double): Double = when (value) {
    null -> fallback
    is Number -> if (value.toDouble().isFinite()) value.toDouble() else fallback
    is String -> value.trim().toDoubleOrNull()?.takeIf { it.isFinite() } ?: fallback
    else -> fallback
}

// -- path data (`d`) ---------------------------------------------------------------------

/** one normalized ABSOLUTE segment. Every authored command folds to M / L / C / Q / Z:
 *  H and V become L, S and T resolve their reflected control point, and an elliptical arc
 *  becomes 1..4 cubics. */
class CanvasSegment(val cmd: String, val values: DoubleArray) {
    fun toList(): List<Any> = listOf<Any>(cmd) + values.toList()

    override fun equals(other: Any?): Boolean =
        other is CanvasSegment && other.cmd == cmd && other.values.contentEquals(values)

    override fun hashCode(): Int = cmd.hashCode() * 31 + values.contentHashCode()

    override fun toString(): String = toList().toString()
}

class CanvasPathParse(val segments: List<CanvasSegment>, val diagnostics: List<String>)

private const val PATH_COMMANDS = "MmLlHhVvCcSsQqTtAaZz"

private class PathScanner(private val s: String) {
    private var i = 0

    /** whitespace or a comma; 12 is the form feed the SVG grammar also accepts */
    private fun isSep(c: Char): Boolean =
        c == ' ' || c == '\t' || c == '\n' || c == '\r' || c.code == 12 || c == ','

    fun skipSep() {
        while (i < s.length && isSep(s[i])) i += 1
    }

    fun atEnd(): Boolean {
        skipSep()
        return i >= s.length
    }

    fun peek(): Char = if (i < s.length) s[i] else ' '

    fun advance() {
        i += 1
    }

    /** the SVG number grammar: sign, digit runs, a bare leading '.', and exponents.
     *  '.5.5' is deliberately TWO numbers - a second '.' terminates the first. */
    fun number(): Double? {
        skipSep()
        val start = i
        if (peek() == '+' || peek() == '-') i += 1
        var digits = 0
        while (i < s.length && s[i] in '0'..'9') { i += 1; digits += 1 }
        if (peek() == '.') {
            i += 1
            while (i < s.length && s[i] in '0'..'9') { i += 1; digits += 1 }
        }
        if (digits == 0) { i = start; return null }
        val e = peek()
        if (e == 'e' || e == 'E') {
            val mark = i
            i += 1
            if (peek() == '+' || peek() == '-') i += 1
            var expDigits = 0
            while (i < s.length && s[i] in '0'..'9') { i += 1; expDigits += 1 }
            if (expDigits == 0) i = mark
        }
        val value = s.substring(start, i).toDoubleOrNull()
        if (value == null || !value.isFinite()) { i = start; return null }
        return value
    }

    /** the two arc flags are SINGLE characters, so `a5 5 0 0110 0` is fa=0 fs=1 x=10 y=0 */
    fun flag(): Int? {
        skipSep()
        return when (peek()) {
            '0' -> { i += 1; 0 }
            '1' -> { i += 1; 1 }
            else -> null
        }
    }
}

private fun arcK(delta: Double): Double = (4.0 / 3.0) * tan(delta / 4.0)

/** centre parameterisation -> 1..4 cubics, split at ceil(|dTheta| / 90deg) */
private fun arcCentreToCubics(
    cx: Double, cy: Double, rx: Double, ry: Double, phi: Double,
    theta1: Double, dtheta: Double,
): List<CanvasSegment> {
    val out = ArrayList<CanvasSegment>()
    val cosPhi = cos(phi)
    val sinPhi = sin(phi)
    fun point(t: Double): DoubleArray {
        val x = rx * cos(t)
        val y = ry * sin(t)
        return doubleArrayOf(cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y)
    }
    fun deriv(t: Double): DoubleArray {
        val x = -rx * sin(t)
        val y = ry * cos(t)
        return doubleArrayOf(cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y)
    }
    val count = max(1, ceil(abs(dtheta) / (Math.PI / 2.0) - 1e-9).toInt())
    val step = dtheta / count
    val k = arcK(step)
    for (i in 0 until count) {
        val t1 = theta1 + step * i
        val t2 = t1 + step
        val p1 = point(t1)
        val p2 = point(t2)
        val d1 = deriv(t1)
        val d2 = deriv(t2)
        out.add(CanvasSegment("C", doubleArrayOf(
            p1[0] + k * d1[0], p1[1] + k * d1[1],
            p2[0] - k * d2[0], p2[1] - k * d2[1],
            p2[0], p2[1],
        )))
    }
    return out
}

/** the F.6.5 endpoint->centre conversion plus the F.6.6 corrections: rx = |rx|, ry = |ry|;
 *  identical endpoints emit NOTHING; a zero radius degenerates to a line; radii too small
 *  are scaled by sqrt(lambda). */
fun canvasArcToCubics(
    x1: Double, y1: Double, rxIn: Double, ryIn: Double, phiDeg: Double,
    largeArc: Int, sweep: Int, x2: Double, y2: Double,
): List<CanvasSegment> {
    if (x1 == x2 && y1 == y2) return emptyList()
    var rx = abs(rxIn)
    var ry = abs(ryIn)
    if (rx == 0.0 || ry == 0.0) return listOf(CanvasSegment("L", doubleArrayOf(x2, y2)))
    val phi = ((phiDeg % 360.0) + 360.0) % 360.0 * DEG
    val cosPhi = cos(phi)
    val sinPhi = sin(phi)
    val dx = (x1 - x2) / 2.0
    val dy = (y1 - y2) / 2.0
    val x1p = cosPhi * dx + sinPhi * dy
    val y1p = -sinPhi * dx + cosPhi * dy
    val lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (lambda > 1.0) {
        val scale = sqrt(lambda)
        rx *= scale
        ry *= scale
    }
    val rx2 = rx * rx
    val ry2 = ry * ry
    val numerator = max(0.0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p)
    val denominator = rx2 * y1p * y1p + ry2 * x1p * x1p
    val coefficient = if (denominator == 0.0) 0.0 else sqrt(numerator / denominator)
    val signum = if (largeArc == sweep) -1.0 else 1.0
    val cxp = signum * coefficient * ((rx * y1p) / ry)
    val cyp = signum * coefficient * (-(ry * x1p) / rx)
    val cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2.0
    val cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2.0
    val theta1 = atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    val theta2 = atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    var dtheta = theta2 - theta1
    if (sweep == 0 && dtheta > 0) dtheta -= 2 * Math.PI
    else if (sweep == 1 && dtheta < 0) dtheta += 2 * Math.PI
    return arcCentreToCubics(cx, cy, rx, ry, phi, theta1, dtheta)
}

/**
 * The SVG path-data mini-language -> the normalized ABSOLUTE segment list.
 *
 * ARTICLE 7: a malformed token STOPS the parse, keeps every segment already produced and
 * emits exactly ONE diagnostic - never a crash, never a partial number.
 */
fun parseCanvasPath(d: String?): CanvasPathParse {
    val segments = ArrayList<CanvasSegment>()
    val diagnostics = ArrayList<String>()
    val scan = PathScanner(d ?: "")
    var cmd: Char? = null
    var cx = 0.0
    var cy = 0.0
    var sx = 0.0
    var sy = 0.0
    var lastCubic: DoubleArray? = null
    var lastQuad: DoubleArray? = null
    var reopen = false

    fun openIfNeeded() {
        if (!reopen) return
        segments.add(CanvasSegment("M", doubleArrayOf(cx, cy)))
        reopen = false
    }

    loop@ while (!scan.atEnd()) {
        val head = scan.peek()
        if (head.isLetter()) {
            if (!PATH_COMMANDS.contains(head)) {
                diagnostics.add("canvas.path: unknown command '$head'")
                break@loop
            }
            cmd = head
            scan.advance()
        } else {
            val current = cmd
            if (current == null) {
                diagnostics.add("canvas.path: data does not start with a command")
                break@loop
            }
            cmd = when (current) {
                'M' -> 'L'
                'm' -> 'l'
                'Z', 'z' -> {
                    diagnostics.add("canvas.path: an argument after closepath")
                    break@loop
                }
                else -> current
            }
        }

        val active = cmd!!
        val rel = active.isLowerCase()
        val upper = active.uppercaseChar()
        var failed = false
        fun need(): Double {
            val v = scan.number()
            if (v == null) { failed = true; return 0.0 }
            return v
        }

        when (upper) {
            'Z' -> {
                segments.add(CanvasSegment("Z", DoubleArray(0)))
                cx = sx
                cy = sy
                lastCubic = null
                lastQuad = null
                reopen = true
            }
            'M' -> {
                val x = need(); val y = need()
                if (failed) { diagnostics.add("canvas.path: truncated moveto"); break@loop }
                cx = if (rel) cx + x else x
                cy = if (rel) cy + y else y
                sx = cx; sy = cy
                segments.add(CanvasSegment("M", doubleArrayOf(cx, cy)))
                lastCubic = null; lastQuad = null; reopen = false
            }
            'L' -> {
                val x = need(); val y = need()
                if (failed) { diagnostics.add("canvas.path: truncated lineto"); break@loop }
                openIfNeeded()
                cx = if (rel) cx + x else x
                cy = if (rel) cy + y else y
                segments.add(CanvasSegment("L", doubleArrayOf(cx, cy)))
                lastCubic = null; lastQuad = null
            }
            'H' -> {
                val x = need()
                if (failed) { diagnostics.add("canvas.path: truncated horizontal lineto"); break@loop }
                openIfNeeded()
                cx = if (rel) cx + x else x
                segments.add(CanvasSegment("L", doubleArrayOf(cx, cy)))
                lastCubic = null; lastQuad = null
            }
            'V' -> {
                val y = need()
                if (failed) { diagnostics.add("canvas.path: truncated vertical lineto"); break@loop }
                openIfNeeded()
                cy = if (rel) cy + y else y
                segments.add(CanvasSegment("L", doubleArrayOf(cx, cy)))
                lastCubic = null; lastQuad = null
            }
            'C', 'S' -> {
                var c1x: Double
                var c1y: Double
                if (upper == 'S') {
                    val reflected = lastCubic ?: doubleArrayOf(cx, cy)
                    c1x = 2 * cx - reflected[0]
                    c1y = 2 * cy - reflected[1]
                } else {
                    c1x = need(); c1y = need()
                    if (!failed) {
                        c1x = if (rel) cx + c1x else c1x
                        c1y = if (rel) cy + c1y else c1y
                    }
                }
                var c2x = need(); var c2y = need(); var x = need(); var y = need()
                if (failed) { diagnostics.add("canvas.path: truncated cubic"); break@loop }
                c2x = if (rel) cx + c2x else c2x
                c2y = if (rel) cy + c2y else c2y
                x = if (rel) cx + x else x
                y = if (rel) cy + y else y
                openIfNeeded()
                segments.add(CanvasSegment("C", doubleArrayOf(c1x, c1y, c2x, c2y, x, y)))
                cx = x; cy = y
                lastCubic = doubleArrayOf(c2x, c2y)
                lastQuad = null
            }
            'Q', 'T' -> {
                var qx: Double
                var qy: Double
                if (upper == 'T') {
                    val reflected = lastQuad ?: doubleArrayOf(cx, cy)
                    qx = 2 * cx - reflected[0]
                    qy = 2 * cy - reflected[1]
                } else {
                    qx = need(); qy = need()
                    if (!failed) {
                        qx = if (rel) cx + qx else qx
                        qy = if (rel) cy + qy else qy
                    }
                }
                var x = need(); var y = need()
                if (failed) { diagnostics.add("canvas.path: truncated quadratic"); break@loop }
                x = if (rel) cx + x else x
                y = if (rel) cy + y else y
                openIfNeeded()
                segments.add(CanvasSegment("Q", doubleArrayOf(qx, qy, x, y)))
                cx = x; cy = y
                lastQuad = doubleArrayOf(qx, qy)
                lastCubic = null
            }
            'A' -> {
                val rx = need(); val ry = need(); val rot = need()
                val fa = scan.flag(); val fs = scan.flag()
                if (fa == null || fs == null) failed = true
                var x = need(); var y = need()
                if (failed) { diagnostics.add("canvas.path: truncated arc"); break@loop }
                x = if (rel) cx + x else x
                y = if (rel) cy + y else y
                val cubics = canvasArcToCubics(cx, cy, rx, ry, rot, fa!!, fs!!, x, y)
                if (cubics.isNotEmpty()) {
                    openIfNeeded()
                    segments.addAll(cubics)
                    cx = x; cy = y
                }
                lastCubic = null; lastQuad = null
            }
        }
    }
    return CanvasPathParse(segments, diagnostics)
}

// -- bounding box (TIGHT: curve extrema solved analytically) -----------------------------

private fun cubicExtrema(p0: Double, p1: Double, p2: Double, p3: Double): List<Double> {
    val a = -p0 + 3 * p1 - 3 * p2 + p3
    val b = 2 * (p0 - 2 * p1 + p2)
    val c = p1 - p0
    val roots = ArrayList<Double>()
    if (abs(a) < 1e-12) {
        if (abs(b) > 1e-12) roots.add(-c / b)
    } else {
        val disc = b * b - 4 * a * c
        if (disc >= 0) {
            val s = sqrt(disc)
            roots.add((-b + s) / (2 * a))
            roots.add((-b - s) / (2 * a))
        }
    }
    return roots.filter { it > 0.0 && it < 1.0 }
}

private fun cubicAt(p0: Double, p1: Double, p2: Double, p3: Double, t: Double): Double {
    val u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

private fun quadAt(p0: Double, p1: Double, p2: Double, t: Double): Double {
    val u = 1 - t
    return u * u * p0 + 2 * u * t * p1 + t * t * p2
}

/** the TIGHT bounding box - the geometry half of the determinism split, exact on every
 *  renderer. null for an empty path. */
fun canvasPathBBox(segments: List<CanvasSegment>): DoubleArray? {
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    var seen = false
    var cx = 0.0
    var cy = 0.0
    var sx = 0.0
    var sy = 0.0
    fun hit(x: Double, y: Double) {
        seen = true
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
    }
    for (seg in segments) {
        val v = seg.values
        when (seg.cmd) {
            "M" -> { cx = v[0]; cy = v[1]; sx = cx; sy = cy; hit(cx, cy) }
            "L" -> { cx = v[0]; cy = v[1]; hit(cx, cy) }
            "Q" -> {
                hit(v[2], v[3])
                val dx = cx - 2 * v[0] + v[2]
                if (abs(dx) >= 1e-12) {
                    val t = (cx - v[0]) / dx
                    if (t > 0 && t < 1) hit(quadAt(cx, v[0], v[2], t), cy)
                }
                val dy = cy - 2 * v[1] + v[3]
                if (abs(dy) >= 1e-12) {
                    val t = (cy - v[1]) / dy
                    if (t > 0 && t < 1) hit(cx, quadAt(cy, v[1], v[3], t))
                }
                cx = v[2]; cy = v[3]
            }
            "C" -> {
                hit(v[4], v[5])
                for (t in cubicExtrema(cx, v[0], v[2], v[4])) hit(cubicAt(cx, v[0], v[2], v[4], t), cy)
                for (t in cubicExtrema(cy, v[1], v[3], v[5])) hit(cx, cubicAt(cy, v[1], v[3], v[5], t))
                cx = v[4]; cy = v[5]
            }
            else -> { cx = sx; cy = sy }
        }
    }
    return if (seen) doubleArrayOf(minX, minY, maxX, maxY) else null
}

// -- the transform attribute -------------------------------------------------------------

class CanvasTransformParse(val matrix: CanvasMatrix, val diagnostics: List<String>)

private val TRANSFORM_ARITY: Map<String, List<Int>> = mapOf(
    "translate" to listOf(1, 2), "scale" to listOf(1, 2), "rotate" to listOf(1, 3),
    "skewX" to listOf(1), "skewY" to listOf(1), "matrix" to listOf(6),
)

private fun transformFunction(name: String, a: List<Double>): CanvasMatrix? = when (name) {
    "translate" -> CanvasMatrix(1.0, 0.0, 0.0, 1.0, a[0], if (a.size > 1) a[1] else 0.0)
    "scale" -> CanvasMatrix(a[0], 0.0, 0.0, if (a.size > 1) a[1] else a[0], 0.0, 0.0)
    "rotate" -> {
        val r = a[0] * DEG
        val rot = CanvasMatrix(cos(r), sin(r), -sin(r), cos(r), 0.0, 0.0)
        if (a.size == 1) rot else canvasMatMul(
            canvasMatMul(CanvasMatrix(1.0, 0.0, 0.0, 1.0, a[1], a[2]), rot),
            CanvasMatrix(1.0, 0.0, 0.0, 1.0, -a[1], -a[2]),
        )
    }
    "skewX" -> CanvasMatrix(1.0, 0.0, tan(a[0] * DEG), 1.0, 0.0, 0.0)
    "skewY" -> CanvasMatrix(1.0, tan(a[0] * DEG), 0.0, 1.0, 0.0, 0.0)
    "matrix" -> CanvasMatrix(a[0], a[1], a[2], a[3], a[4], a[5])
    else -> null
}

private val TRANSFORM_PATTERN = Regex("([A-Za-z][A-Za-z0-9]*)\\s*\\(([\\s\\S]*?)\\)")
private val SEPARATORS = Regex("[\\s,]+")

/**
 * The SVG function list, applied LEFT TO RIGHT: the leftmost function is outermost, so
 * M = M1*M2*...*Mn and `translate(10,0) scale(2)` is NOT `scale(2) translate(10,0)`.
 *
 * ARTICLE 7: an unknown function, a wrong-arity function, a non-numeric argument or junk
 * between functions costs exactly ONE diagnostic and is SKIPPED - every other function in
 * the list still applies.
 */
fun parseCanvasTransform(input: String?): CanvasTransformParse {
    val source = input ?: ""
    val diagnostics = ArrayList<String>()
    var matrix = CanvasMatrix.IDENTITY
    var cursor = 0
    fun gap(text: String) {
        if (text.replace(SEPARATORS, "").isNotEmpty()) {
            diagnostics.add("canvas.transform: junk '${text.trim()}'")
        }
    }
    for (match in TRANSFORM_PATTERN.findAll(source)) {
        gap(source.substring(cursor, match.range.first))
        cursor = match.range.last + 1
        val name = match.groupValues[1]
        val arity = TRANSFORM_ARITY[name]
        if (arity == null) {
            diagnostics.add("canvas.transform: unknown function '$name'")
            continue
        }
        val words = match.groupValues[2].split(SEPARATORS).filter { it.isNotEmpty() }
        if (!arity.contains(words.size)) {
            diagnostics.add("canvas.transform: $name takes ${arity.joinToString(" or ")} arguments")
            continue
        }
        val args = ArrayList<Double>()
        var numeric = true
        for (word in words) {
            val value = word.toDoubleOrNull()
            if (value == null || !value.isFinite()) { numeric = false; break }
            args.add(value)
        }
        if (!numeric) {
            diagnostics.add("canvas.transform: $name has a non-numeric argument")
            continue
        }
        val local = transformFunction(name, args)
        if (local != null) matrix = canvasMatMul(matrix, local)
    }
    gap(source.substring(cursor))
    return CanvasTransformParse(matrix, diagnostics)
}

// -- flattening and the fill rules -------------------------------------------------------

/** uniform in t, never adaptive: adaptive subdivision is per-implementation and would make
 *  the fill-rule corpus unpinnable */
const val CANVAS_FLATTEN_SEGMENTS = 16

/** every subpath, closed, as a point list */
fun canvasFlatten(segments: List<CanvasSegment>): List<List<DoubleArray>> {
    val out = ArrayList<MutableList<DoubleArray>>()
    var current: MutableList<DoubleArray>? = null
    var cx = 0.0
    var cy = 0.0
    var sx = 0.0
    var sy = 0.0
    fun push(x: Double, y: Double) {
        val target = current ?: ArrayList<DoubleArray>().also { out.add(it); current = it }
        target.add(doubleArrayOf(x, y))
    }
    for (seg in segments) {
        val v = seg.values
        when (seg.cmd) {
            "M" -> { current = null; cx = v[0]; cy = v[1]; sx = cx; sy = cy; push(cx, cy) }
            "L" -> { if (current == null) push(cx, cy); cx = v[0]; cy = v[1]; push(cx, cy) }
            "Q" -> {
                if (current == null) push(cx, cy)
                for (i in 1..CANVAS_FLATTEN_SEGMENTS) {
                    val t = i.toDouble() / CANVAS_FLATTEN_SEGMENTS
                    push(quadAt(cx, v[0], v[2], t), quadAt(cy, v[1], v[3], t))
                }
                cx = v[2]; cy = v[3]
            }
            "C" -> {
                if (current == null) push(cx, cy)
                for (i in 1..CANVAS_FLATTEN_SEGMENTS) {
                    val t = i.toDouble() / CANVAS_FLATTEN_SEGMENTS
                    push(cubicAt(cx, v[0], v[2], v[4], t), cubicAt(cy, v[1], v[3], v[5], t))
                }
                cx = v[4]; cy = v[5]
            }
            else -> { cx = sx; cy = sy; current = null }
        }
    }
    return out.filter { it.size > 1 }
}

/** the signed shoelace area of the FLATTENED path - positive is clockwise in the y-down
 *  canvas space. It pins the flattening itself, not just the inside/outside verdicts. */
fun canvasPathArea(segments: List<CanvasSegment>): Double {
    var total = 0.0
    for (sub in canvasFlatten(segments)) {
        for (i in sub.indices) {
            val a = sub[i]
            val b = sub[(i + 1) % sub.size]
            total += a[0] * b[1] - b[0] * a[1]
        }
    }
    return total / 2.0
}

private fun crossings(segments: List<CanvasSegment>, px: Double, py: Double): IntArray {
    var winding = 0
    var count = 0
    for (sub in canvasFlatten(segments)) {
        for (i in sub.indices) {
            val a = sub[i]
            val b = sub[(i + 1) % sub.size]
            val up = a[1] <= py && py < b[1]
            val down = b[1] <= py && py < a[1]
            if (!up && !down) continue
            val x = a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
            if (x <= px) continue
            count += 1
            winding += if (up) 1 else -1
        }
    }
    return intArrayOf(winding, count)
}

/** the winding number at a point (half-open in y, crossings strictly right of the point) */
fun canvasWindingAt(segments: List<CanvasSegment>, x: Double, y: Double): Int =
    crossings(segments, x, y)[0]

fun canvasCrossingsAt(segments: List<CanvasSegment>, x: Double, y: Double): Int =
    crossings(segments, x, y)[1]

/** is this point inside, under `rule`? */
fun canvasContains(segments: List<CanvasSegment>, x: Double, y: Double, rule: String): Boolean {
    val c = crossings(segments, x, y)
    return if (rule == "evenodd") c[1] % 2 == 1 else c[0] != 0
}

// -- colour -------------------------------------------------------------------------------

/** a resolved paint. A SEMANTIC TOKEN survives the pure core UNRESOLVED - the theme resolves
 *  it at paint time, so the core must not bake it. */
sealed class CanvasPaint {
    data class Rgba(val r: Double, val g: Double, val b: Double, val a: Double) : CanvasPaint() {
        fun toList(): List<Double> = listOf(r, g, b, a)
    }

    data class Token(val token: String) : CanvasPaint()
    data class Gradient(val id: String) : CanvasPaint()

    companion object {
        val BLACK = Rgba(0.0, 0.0, 0.0, 1.0)
    }
}

/** the semantic colour words (the StackStyle.color vocabulary) -> their web custom property.
 *  `clear` is the one word with no token: it is literally transparent. */
val CANVAS_COLOR_TOKENS: Map<String, String> = linkedMapOf(
    "clear" to "transparent",
    "label" to "--dsx-label",
    "text" to "--dsx-label",
    "secondary" to "--dsx-secondary-label",
    "secondaryLabel" to "--dsx-secondary-label",
    "tertiary" to "--dsx-tertiary-label",
    "tertiaryLabel" to "--dsx-tertiary-label",
    "quaternary" to "--dsx-tertiary-label",
    "accent" to "--dsx-accent",
    "destructive" to "--dsx-destructive",
    "separator" to "--dsx-separator",
    "fill" to "--dsx-fill",
    "fillFaint" to "--dsx-fill",
    "background" to "--dsx-background",
    "systemBackground" to "--dsx-background",
    "secondaryBackground" to "--dsx-secondary-background",
    "tertiaryBackground" to "--dsx-tertiary-background",
    "groupedBackground" to "--dsx-grouped-background",
    "secondaryGroupedBackground" to "--dsx-secondary-grouped-background",
)

private val LITERAL_WORDS: Map<String, CanvasPaint.Rgba> = mapOf(
    "white" to CanvasPaint.Rgba(1.0, 1.0, 1.0, 1.0),
    "black" to CanvasPaint.Rgba(0.0, 0.0, 0.0, 1.0),
)

/** `none` is the ABSENCE of a paint and is distinct from an unparseable one: none paints
 *  nothing with no diagnostic, garbage costs one diagnostic and falls back to black. */
class CanvasPaintParse(val paint: CanvasPaint?, val ok: Boolean)

private val URL_PATTERN = Regex("^url\\(\\s*#([^)\\s]+)\\s*\\)$")
private val RGB_PATTERN = Regex("^rgba?\\(([^)]*)\\)$", RegexOption.IGNORE_CASE)
private val HEX_PATTERN = Regex("^[0-9a-fA-F]+$")
private val RGB_SEPARATORS = Regex("[,/\\s]+")

fun parseCanvasPaint(input: String?): CanvasPaintParse {
    val raw = (input ?: "").trim()
    if (raw.isEmpty()) return CanvasPaintParse(null, false)
    if (raw == "none" || raw == "transparent") return CanvasPaintParse(null, true)
    val url = URL_PATTERN.find(raw)
    if (url != null) return CanvasPaintParse(CanvasPaint.Gradient(url.groupValues[1]), true)
    LITERAL_WORDS[raw]?.let { return CanvasPaintParse(it, true) }
    if (CANVAS_COLOR_TOKENS.containsKey(raw)) return CanvasPaintParse(CanvasPaint.Token(raw), true)
    val rgba = parseCanvasRgba(raw)
    return if (rgba != null) CanvasPaintParse(rgba, true) else CanvasPaintParse(null, false)
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb(r,g,b)` / `rgba(r,g,b,a)`, in STRAIGHT
 *  (non-premultiplied) sRGB, components 0..1 */
fun parseCanvasRgba(input: String): CanvasPaint.Rgba? {
    val raw = input.trim()
    if (raw.startsWith("#")) {
        val hex = raw.substring(1)
        if (!HEX_PATTERN.matches(hex)) return null
        fun wide(n: Int): Double = "${hex[n]}${hex[n]}".toInt(16) / 255.0
        fun pair(n: Int): Double = hex.substring(n, n + 2).toInt(16) / 255.0
        return when (hex.length) {
            3 -> CanvasPaint.Rgba(wide(0), wide(1), wide(2), 1.0)
            4 -> CanvasPaint.Rgba(wide(0), wide(1), wide(2), wide(3))
            6 -> CanvasPaint.Rgba(pair(0), pair(2), pair(4), 1.0)
            8 -> CanvasPaint.Rgba(pair(0), pair(2), pair(4), pair(6))
            else -> null
        }
    }
    val call = RGB_PATTERN.find(raw) ?: return null
    val parts = call.groupValues[1].split(RGB_SEPARATORS).filter { it.isNotEmpty() }
    if (parts.size < 3 || parts.size > 4) return null
    fun channel(text: String): Double? {
        val value = if (text.endsWith("%")) text.dropLast(1).toDoubleOrNull()?.times(2.55)
                    else text.toDoubleOrNull()
        return if (value != null && value.isFinite()) min(1.0, max(0.0, value / 255.0)) else null
    }
    val r = channel(parts[0]) ?: return null
    val g = channel(parts[1]) ?: return null
    val b = channel(parts[2]) ?: return null
    var a = 1.0
    if (parts.size == 4) {
        val text = parts[3]
        val value = if (text.endsWith("%")) text.dropLast(1).toDoubleOrNull()?.div(100.0)
                    else text.toDoubleOrNull()
        if (value == null || !value.isFinite()) return null
        a = min(1.0, max(0.0, value))
    }
    return CanvasPaint.Rgba(r, g, b, a)
}

// -- gradients -----------------------------------------------------------------------------

class CanvasStopInput(val offset: Any?, val color: String?, val opacity: Any?)

/** a normalized stop: an rgba stop has its `stop-opacity` already multiplied in; a TOKEN stop
 *  keeps the word and its opacity for the theme to resolve at paint time */
class CanvasStop(
    val offset: Double,
    val rgba: CanvasPaint.Rgba?,
    val token: String?,
    val opacity: Double,
)

class CanvasStopsParse(val stops: List<CanvasStop>, val diagnostics: List<String>)

private fun parseOffset(value: Any?): Double? = when (value) {
    null -> null
    is Number -> if (value.toDouble().isFinite()) min(1.0, max(0.0, value.toDouble())) else null
    is String -> {
        val text = value.trim()
        if (text.isEmpty()) null else {
            val percent = text.endsWith("%")
            val parsed = (if (percent) text.dropLast(1) else text).toDoubleOrNull()
            if (parsed == null || !parsed.isFinite()) null
            else min(1.0, max(0.0, if (percent) parsed / 100.0 else parsed))
        }
    }
    else -> null
}

/**
 * THE LAW, in order: parse each offset (a number or a percentage) and CLAMP it into 0..1; a
 * missing FIRST offset is 0 and a missing LAST is 1; a run of missing interior offsets spaces
 * EVENLY between its two known neighbours; then walk left to right forcing MONOTONIC
 * non-decreasing offsets (a decreasing offset is raised to its predecessor - never re-sorted,
 * because author order is the paint order).
 */
fun normalizeCanvasStops(input: List<CanvasStopInput>): CanvasStopsParse {
    val diagnostics = ArrayList<String>()
    if (input.isEmpty()) {
        diagnostics.add("canvas.gradient: no stops")
        return CanvasStopsParse(emptyList(), diagnostics)
    }
    val offsets: MutableList<Double?> = input.map { parseOffset(it.offset) }.toMutableList()
    if (offsets[0] == null) offsets[0] = 0.0
    if (offsets[offsets.size - 1] == null) offsets[offsets.size - 1] = 1.0
    var i = 0
    while (i < offsets.size) {
        if (offsets[i] != null) { i += 1; continue }
        var j = i
        while (j < offsets.size && offsets[j] == null) j += 1
        val before = offsets[i - 1]!!
        val after = offsets[j]!!
        val span = j - i + 1
        for (k in i until j) offsets[k] = before + ((after - before) * (k - i + 1)) / span
        i = j
    }
    var previous: Double? = null
    val stops = ArrayList<CanvasStop>()
    for (k in input.indices) {
        val prior = previous
        val offset = if (prior == null) offsets[k]!! else max(offsets[k]!!, prior)
        previous = offset
        val raw = input[k]
        val opacity = min(1.0, max(0.0, if (raw.opacity == null) 1.0 else asDouble(raw.opacity, 1.0)))
        val parsed = parseCanvasPaint(raw.color)
        when (val paint = parsed.paint) {
            is CanvasPaint.Token -> stops.add(CanvasStop(offset, null, paint.token, opacity))
            is CanvasPaint.Rgba ->
                stops.add(CanvasStop(offset, CanvasPaint.Rgba(paint.r, paint.g, paint.b, paint.a * opacity), null, opacity))
            else -> {
                if (!parsed.ok) diagnostics.add("canvas.gradient: unparseable colour '${raw.color}'")
                stops.add(CanvasStop(offset, CanvasPaint.Rgba(0.0, 0.0, 0.0, opacity), null, opacity))
            }
        }
    }
    return CanvasStopsParse(stops, diagnostics)
}

/** Sample the normalized stop list at t, interpolating componentwise in STRAIGHT
 *  (non-premultiplied) sRGB - not linear-light, not premultiplied, because that is what
 *  Canvas2D, CoreGraphics and Compose all do by default. Two stops at the SAME offset are a
 *  hard stop: the earlier stop owns the offset itself, the later one owns everything after
 *  it. A token stop cannot be sampled here - resolve the theme first. */
fun sampleCanvasStops(stops: List<CanvasStop>, t: Double): CanvasPaint.Rgba? {
    if (stops.isEmpty()) return null
    if (t <= stops[0].offset) return stops[0].rgba
    var index = -1
    for (i in 1 until stops.size) {
        if (t <= stops[i].offset) { index = i; break }
    }
    if (index == -1) return stops[stops.size - 1].rgba
    val a = stops[index - 1].rgba ?: return null
    val b = stops[index].rgba ?: return null
    val span = stops[index].offset - stops[index - 1].offset
    val u = if (span <= 0) 1.0 else (t - stops[index - 1].offset) / span
    return CanvasPaint.Rgba(
        a.r + (b.r - a.r) * u,
        a.g + (b.g - a.g) * u,
        a.b + (b.b - a.b) * u,
        a.a + (b.a - a.a) * u,
    )
}

/** the 1-D paint coordinate for each gradient kind. linear is the CLAMPED projection onto the
 *  axis, radial the clamped distance ratio, angular the turn fraction from `start`, measured
 *  with atan2 in the y-down canvas space and wrapped into [0,1). */
fun canvasGradientT(kind: String, geom: List<Double>, x: Double, y: Double): Double {
    fun at(i: Int): Double = if (i < geom.size) geom[i] else 0.0
    if (kind == "linear") {
        val dx = at(2) - at(0)
        val dy = at(3) - at(1)
        val len2 = dx * dx + dy * dy
        if (len2 == 0.0) return 0.0
        return min(1.0, max(0.0, ((x - at(0)) * dx + (y - at(1)) * dy) / len2))
    }
    val cx = at(0)
    val cy = at(1)
    if (kind == "radial") {
        val r = at(2)
        if (r <= 0.0) return 1.0
        return min(1.0, max(0.0, hypot(x - cx, y - cy) / r))
    }
    val degrees = atan2(y - cy, x - cx) / DEG
    val turn = (degrees - at(2)) / 360.0
    return turn - floor(turn)
}

class CanvasGradient(val kind: String, val geom: List<Double>, val stops: List<CanvasStop>)

// -- tier 1: the display list --------------------------------------------------------------

class CanvasMarkupNode(
    val kind: String,
    val attrs: Map<String, Any?> = emptyMap(),
    val children: List<CanvasMarkupNode> = emptyList(),
)

sealed class CanvasEffect {
    data class Blur(val radius: Double) : CanvasEffect()
    data class Shadow(val dx: Double, val dy: Double, val radius: Double, val color: CanvasPaint) : CanvasEffect()
    data class Blend(val mode: String) : CanvasEffect()
}

class CanvasClip(val path: List<CanvasSegment>, val transform: CanvasMatrix)

/** ONE drawing op. The path is in LOCAL coordinates and the matrix rides beside it - never a
 *  baked path, because tier 1 is RETAINED and only the matrix changes when a transform
 *  animates. `isShape` decides which of the optional fields are meaningful, exactly as the
 *  corpus op shape does. */
class CanvasOp(
    val key: String,
    val kind: String,
    val transform: CanvasMatrix,
    val opacity: Double,
    val path: List<CanvasSegment>? = null,
    val fill: CanvasPaint? = null,
    val stroke: CanvasPaint? = null,
    val strokeWidth: Double = 1.0,
    val fillRule: String = "nonzero",
    val strokeLinecap: String = "butt",
    val strokeLinejoin: String = "miter",
    val text: String? = null,
    val x: Double = 0.0,
    val y: Double = 0.0,
    val width: Double? = null,
    val height: Double? = null,
    val fontSize: Double = 16.0,
    val textAnchor: String = "start",
    val src: String? = null,
    val clip: CanvasClip? = null,
    val effects: List<CanvasEffect> = emptyList(),
)

class CanvasDisplayList(
    val ops: List<CanvasOp>,
    val gradients: Map<String, CanvasGradient>,
    val diagnostics: List<String>,
)

private val SHAPE_KINDS = setOf("path", "rect", "circle", "ellipse", "line", "polygon", "polyline")
private val WRAPPER_KINDS = setOf("group", "blur", "shadow", "blend")

/** the ONE kind whose unstyled default fill is absent rather than SVG black: a line has no
 *  interior to fill */
private val UNFILLED_KINDS = setOf("line")

private class Inherited(
    var fill: CanvasPaint? = null,
    var hasFill: Boolean = false,
    var stroke: CanvasPaint? = null,
    var hasStroke: Boolean = false,
    var strokeWidth: Double? = null,
    var fillRule: String? = null,
    var strokeLinecap: String? = null,
    var strokeLinejoin: String? = null,
) {
    fun duplicate(): Inherited =
        Inherited(fill, hasFill, stroke, hasStroke, strokeWidth, fillRule, strokeLinecap, strokeLinejoin)
}

private fun textAttr(node: CanvasMarkupNode, name: String): String? = node.attrs[name]?.toString()

private fun numberAttr(node: CanvasMarkupNode, name: String, fallback: Double): Double =
    asDouble(node.attrs[name], fallback)

private fun parsePoints(source: String): List<DoubleArray> {
    val words = source.split(SEPARATORS).filter { it.isNotEmpty() }
    val out = ArrayList<DoubleArray>()
    var i = 0
    while (i + 1 < words.size) {
        val x = words[i].toDoubleOrNull()
        val y = words[i + 1].toDoubleOrNull()
        if (x == null || y == null) break
        out.add(doubleArrayOf(x, y))
        i += 2
    }
    return out
}

/** rect/circle/ellipse/roundRect all become paths through the SAME arc->cubic converter as
 *  `d`, so a circle is four cubics with k = 4/3*tan(pi/8) on every renderer */
fun canvasRectPath(x: Double, y: Double, w: Double, h: Double, rxIn: Double, ryIn: Double): List<CanvasSegment> {
    val rx = min(abs(rxIn), abs(w) / 2.0)
    val ry = min(abs(ryIn), abs(h) / 2.0)
    if (rx <= 0.0 || ry <= 0.0) {
        return listOf(
            CanvasSegment("M", doubleArrayOf(x, y)),
            CanvasSegment("L", doubleArrayOf(x + w, y)),
            CanvasSegment("L", doubleArrayOf(x + w, y + h)),
            CanvasSegment("L", doubleArrayOf(x, y + h)),
            CanvasSegment("Z", DoubleArray(0)),
        )
    }
    val out = ArrayList<CanvasSegment>()
    out.add(CanvasSegment("M", doubleArrayOf(x + rx, y)))
    out.add(CanvasSegment("L", doubleArrayOf(x + w - rx, y)))
    fun corner(x1: Double, y1: Double, x2: Double, y2: Double) {
        out.addAll(canvasArcToCubics(x1, y1, rx, ry, 0.0, 0, 1, x2, y2))
    }
    corner(x + w - rx, y, x + w, y + ry)
    out.add(CanvasSegment("L", doubleArrayOf(x + w, y + h - ry)))
    corner(x + w, y + h - ry, x + w - rx, y + h)
    out.add(CanvasSegment("L", doubleArrayOf(x + rx, y + h)))
    corner(x + rx, y + h, x, y + h - ry)
    out.add(CanvasSegment("L", doubleArrayOf(x, y + ry)))
    corner(x, y + ry, x + rx, y)
    out.add(CanvasSegment("Z", DoubleArray(0)))
    return out
}

fun canvasEllipsePath(cx: Double, cy: Double, rx: Double, ry: Double): List<CanvasSegment> {
    val out = ArrayList<CanvasSegment>()
    out.add(CanvasSegment("M", doubleArrayOf(cx + rx, cy)))
    out.addAll(arcCentreToCubics(cx, cy, rx, ry, 0.0, 0.0, 2 * Math.PI))
    out.add(CanvasSegment("Z", DoubleArray(0)))
    return out
}

private fun shapePath(node: CanvasMarkupNode, diagnostics: MutableList<String>): List<CanvasSegment> =
    when (node.kind) {
        "path" -> {
            val parsed = parseCanvasPath(textAttr(node, "d"))
            diagnostics.addAll(parsed.diagnostics)
            parsed.segments
        }
        "rect" -> {
            val rxRaw = node.attrs["rx"]
            val ryRaw = node.attrs["ry"]
            val rx = if (rxRaw != null) asDouble(rxRaw, 0.0)
                     else if (ryRaw != null) asDouble(ryRaw, 0.0) else 0.0
            val ry = if (ryRaw != null) asDouble(ryRaw, 0.0) else rx
            canvasRectPath(
                numberAttr(node, "x", 0.0), numberAttr(node, "y", 0.0),
                numberAttr(node, "width", 0.0), numberAttr(node, "height", 0.0), rx, ry,
            )
        }
        "circle" -> {
            val r = numberAttr(node, "r", 0.0)
            canvasEllipsePath(numberAttr(node, "cx", 0.0), numberAttr(node, "cy", 0.0), r, r)
        }
        "ellipse" -> canvasEllipsePath(
            numberAttr(node, "cx", 0.0), numberAttr(node, "cy", 0.0),
            numberAttr(node, "rx", 0.0), numberAttr(node, "ry", 0.0),
        )
        "line" -> listOf(
            CanvasSegment("M", doubleArrayOf(numberAttr(node, "x1", 0.0), numberAttr(node, "y1", 0.0))),
            CanvasSegment("L", doubleArrayOf(numberAttr(node, "x2", 0.0), numberAttr(node, "y2", 0.0))),
        )
        "polygon", "polyline" -> {
            val points = parsePoints(textAttr(node, "points") ?: "")
            if (points.isEmpty()) emptyList() else {
                val out = ArrayList<CanvasSegment>()
                out.add(CanvasSegment("M", doubleArrayOf(points[0][0], points[0][1])))
                for (i in 1 until points.size) out.add(CanvasSegment("L", doubleArrayOf(points[i][0], points[i][1])))
                if (node.kind == "polygon") out.add(CanvasSegment("Z", DoubleArray(0)))
                out
            }
        }
        else -> emptyList()
    }

private fun readInherited(
    node: CanvasMarkupNode, parent: Inherited, diagnostics: MutableList<String>,
): Inherited {
    val next = parent.duplicate()
    fun paint(name: String): Pair<Boolean, CanvasPaint?> {
        val raw = textAttr(node, name) ?: return false to null
        val parsed = parseCanvasPaint(raw)
        if (!parsed.ok) {
            diagnostics.add("canvas.$name: unparseable colour '$raw'")
            return true to CanvasPaint.BLACK
        }
        return true to parsed.paint
    }
    val (setFill, fill) = paint("fill")
    if (setFill) { next.fill = fill; next.hasFill = true }
    val (setStroke, stroke) = paint("stroke")
    if (setStroke) { next.stroke = stroke; next.hasStroke = true }
    node.attrs["strokeWidth"]?.let { next.strokeWidth = asDouble(it, 1.0) }
    val rule = textAttr(node, "fillRule")
    if (rule == "evenodd" || rule == "nonzero") next.fillRule = rule
    textAttr(node, "strokeLinecap")?.let { next.strokeLinecap = it }
    textAttr(node, "strokeLinejoin")?.let { next.strokeLinejoin = it }
    return next
}

private fun clampUnit(v: Double): Double = min(1.0, max(0.0, v))

private fun registerGradient(
    node: CanvasMarkupNode, into: MutableMap<String, CanvasGradient>, diagnostics: MutableList<String>,
) {
    val id = textAttr(node, "id")
    if (id.isNullOrEmpty()) {
        diagnostics.add("canvas.gradient: a gradient needs an id")
        return
    }
    val word = textAttr(node, "kind") ?: "linear"
    val kind = if (word == "radial" || word == "angular") word else "linear"
    val geom = when (kind) {
        "linear" -> listOf(
            numberAttr(node, "x1", 0.0), numberAttr(node, "y1", 0.0),
            numberAttr(node, "x2", 0.0), numberAttr(node, "y2", 0.0),
        )
        "radial" -> listOf(numberAttr(node, "cx", 0.0), numberAttr(node, "cy", 0.0), numberAttr(node, "r", 0.0))
        else -> listOf(numberAttr(node, "cx", 0.0), numberAttr(node, "cy", 0.0), numberAttr(node, "start", 0.0))
    }
    val inputs = node.children.filter { it.kind == "stop" }
        .map { CanvasStopInput(it.attrs["offset"], textAttr(it, "color"), it.attrs["opacity"]) }
    val normalized = normalizeCanvasStops(inputs)
    diagnostics.addAll(normalized.diagnostics)
    into[id] = CanvasGradient(kind, geom, normalized.stops)
}

/**
 * THE BUILD LAW: walk the children in document order; a wrapper (group / blur / shadow /
 * blend) emits NO op and instead folds into its descendants - transform composes, opacity
 * MULTIPLIES, paint attributes INHERIT, `clip` on a group rides every descendant op with the
 * matrix in force where the clip was authored, and each effect wrapper APPENDS to the op's
 * effect chain outermost-first. A `<gradient id>` child registers a paint and emits no op. An
 * unknown child tag is one diagnostic and no op - a canvas draws, it does not lay out.
 *
 * THE KEY LAW (the `<list>` keying law verbatim): an authored `key` wins, an unkeyed node keys
 * on its KIND plus its position among same-kind siblings, a duplicate gets the middot-n suffix
 * in encounter order, and the key is PATH-PREFIXED by its ancestors' keys.
 */
fun buildCanvasDisplayList(tree: List<CanvasMarkupNode>): CanvasDisplayList {
    val ops = ArrayList<CanvasOp>()
    val gradients = LinkedHashMap<String, CanvasGradient>()
    val diagnostics = ArrayList<String>()

    fun walk(
        nodes: List<CanvasMarkupNode>, prefix: String, world: CanvasMatrix, opacity: Double,
        inherited: Inherited, effects: List<CanvasEffect>, clip: CanvasClip?,
    ) {
        val used = HashSet<String>()
        fun keyFor(node: CanvasMarkupNode): String {
            val authored = textAttr(node, "key")
            val base = if (!authored.isNullOrEmpty()) authored else node.kind
            var key = base
            var n = 1
            while (used.contains(key)) { key = base + "·" + n; n += 1 }
            used.add(key)
            return if (prefix.isEmpty()) key else "$prefix/$key"
        }

        for (node in nodes) {
            if (node.kind == "gradient") { registerGradient(node, gradients, diagnostics); continue }
            if (node.kind == "stop") continue
            val isWrapper = WRAPPER_KINDS.contains(node.kind)
            val isShape = SHAPE_KINDS.contains(node.kind)
            val isText = node.kind == "text"
            val isImage = node.kind == "image"
            if (!isWrapper && !isShape && !isText && !isImage) {
                diagnostics.add("canvas: <${node.kind}> is not a drawing primitive")
                continue
            }

            val key = keyFor(node)
            val local = parseCanvasTransform(textAttr(node, "transform"))
            diagnostics.addAll(local.diagnostics)
            val nodeWorld = if (local.matrix.isIdentity) world else canvasMatMul(world, local.matrix)
            val nodeOpacity = opacity * clampUnit(numberAttr(node, "opacity", 1.0))
            val nodeInherited = readInherited(node, inherited, diagnostics)

            if (isWrapper) {
                val nodeEffects = when (node.kind) {
                    "blur" -> effects + CanvasEffect.Blur(numberAttr(node, "radius", 0.0))
                    "shadow" -> effects + CanvasEffect.Shadow(
                        numberAttr(node, "dx", 0.0), numberAttr(node, "dy", 0.0),
                        numberAttr(node, "radius", 0.0),
                        parseCanvasPaint(textAttr(node, "color") ?: "#000000").paint ?: CanvasPaint.BLACK,
                    )
                    "blend" -> effects + CanvasEffect.Blend(textAttr(node, "mode") ?: "normal")
                    else -> effects
                }
                var nodeClip = clip
                val clipData = textAttr(node, "clip")
                if (clipData != null) {
                    val parsed = parseCanvasPath(clipData)
                    diagnostics.addAll(parsed.diagnostics)
                    // Nested clips are NOT intersected here: the innermost authored clip wins.
                    // Path intersection is a rasteriser job and no two of them agree on it.
                    nodeClip = CanvasClip(parsed.segments, nodeWorld)
                }
                walk(node.children, key, nodeWorld, nodeOpacity, nodeInherited, nodeEffects, nodeClip)
                continue
            }

            val op = when {
                isText -> CanvasOp(
                    key = key, kind = node.kind, transform = nodeWorld, opacity = nodeOpacity,
                    text = textAttr(node, "value") ?: "",
                    x = numberAttr(node, "x", 0.0), y = numberAttr(node, "y", 0.0),
                    fontSize = numberAttr(node, "fontSize", 16.0),
                    textAnchor = textAttr(node, "textAnchor") ?: "start",
                    fill = if (nodeInherited.hasFill) nodeInherited.fill else CanvasPaint.BLACK,
                    clip = clip, effects = effects,
                )
                isImage -> CanvasOp(
                    key = key, kind = node.kind, transform = nodeWorld, opacity = nodeOpacity,
                    src = textAttr(node, "src") ?: "",
                    x = numberAttr(node, "x", 0.0), y = numberAttr(node, "y", 0.0),
                    width = if (node.attrs.containsKey("width")) numberAttr(node, "width", 0.0) else null,
                    height = if (node.attrs.containsKey("height")) numberAttr(node, "height", 0.0) else null,
                    clip = clip, effects = effects,
                )
                else -> CanvasOp(
                    key = key, kind = node.kind, transform = nodeWorld, opacity = nodeOpacity,
                    path = shapePath(node, diagnostics),
                    fill = if (nodeInherited.hasFill) nodeInherited.fill
                           else if (UNFILLED_KINDS.contains(node.kind)) null else CanvasPaint.BLACK,
                    stroke = if (nodeInherited.hasStroke) nodeInherited.stroke else null,
                    strokeWidth = nodeInherited.strokeWidth ?: 1.0,
                    fillRule = nodeInherited.fillRule ?: "nonzero",
                    strokeLinecap = nodeInherited.strokeLinecap ?: "butt",
                    strokeLinejoin = nodeInherited.strokeLinejoin ?: "miter",
                    clip = clip, effects = effects,
                )
            }
            ops.add(op)
        }
    }

    walk(tree, "", CanvasMatrix.IDENTITY, 1.0, Inherited(), emptyList(), null)
    return CanvasDisplayList(ops, gradients, diagnostics)
}

// -- the keyed diff --------------------------------------------------------------------------

class CanvasDiffEntry(val op: String, val key: String, val to: Int?, val from: Int?)

private fun paintKey(paint: CanvasPaint?): String = when (paint) {
    null -> "none"
    is CanvasPaint.Rgba -> "rgba:${paint.r},${paint.g},${paint.b},${paint.a}"
    is CanvasPaint.Token -> "token:${paint.token}"
    is CanvasPaint.Gradient -> "gradient:${paint.id}"
}

private fun effectKey(effect: CanvasEffect): String = when (effect) {
    is CanvasEffect.Blur -> "blur:${effect.radius}"
    is CanvasEffect.Shadow -> "shadow:${effect.dx},${effect.dy},${effect.radius},${paintKey(effect.color)}"
    is CanvasEffect.Blend -> "blend:${effect.mode}"
}

private fun contentKey(op: CanvasOp): String = buildString {
    append(op.kind).append('|').append(op.transform.toList()).append('|').append(op.opacity)
    append('|').append(op.path?.map { it.toList() })
    append('|').append(paintKey(op.fill)).append('|').append(paintKey(op.stroke))
    append('|').append(op.strokeWidth).append('|').append(op.fillRule)
    append('|').append(op.strokeLinecap).append('|').append(op.strokeLinejoin)
    append('|').append(op.text).append('|').append(op.x).append('|').append(op.y)
    append('|').append(op.width).append('|').append(op.height)
    append('|').append(op.fontSize).append('|').append(op.textAnchor).append('|').append(op.src)
    append('|').append(op.clip?.path?.map { it.toList() }).append('|').append(op.clip?.transform?.toList())
    append('|').append(op.effects.map { effectKey(it) })
}

/** the complement of a longest increasing subsequence of the retained previous indices, so a
 *  single item moved to the front is ONE move, not n */
private fun longestIncreasing(values: List<Int>): List<Int> {
    if (values.isEmpty()) return emptyList()
    val tails = ArrayList<Int>()
    val parents = IntArray(values.size) { -1 }
    for (i in values.indices) {
        var lo = 0
        var hi = tails.size
        while (lo < hi) {
            val mid = (lo + hi) / 2
            if (values[tails[mid]] < values[i]) lo = mid + 1 else hi = mid
        }
        if (lo > 0) parents[i] = tails[lo - 1]
        if (lo < tails.size) tails[lo] = i else tails.add(i)
    }
    val out = ArrayList<Int>()
    var cursor = tails[tails.size - 1]
    while (cursor != -1) { out.add(cursor); cursor = parents[cursor] }
    return out.reversed()
}

/** THE DIFF LAW: keys present on both sides KEEP their identity across reorder. */
fun diffCanvasDisplayList(before: List<CanvasOp>, after: List<CanvasOp>): List<CanvasDiffEntry> {
    val beforeIndex = HashMap<String, Int>()
    before.forEachIndexed { i, op -> beforeIndex[op.key] = i }
    val afterKeys = after.map { it.key }.toHashSet()
    val out = ArrayList<CanvasDiffEntry>()
    for (op in before) {
        if (!afterKeys.contains(op.key)) out.add(CanvasDiffEntry("remove", op.key, null, null))
    }
    val retained = ArrayList<Int>()
    val retainedAt = ArrayList<Int>()
    after.forEachIndexed { i, op ->
        val previous = beforeIndex[op.key]
        if (previous != null) { retained.add(previous); retainedAt.add(i) }
    }
    val stable = longestIncreasing(retained).map { retainedAt[it] }.toHashSet()
    after.forEachIndexed { i, op ->
        val previous = beforeIndex[op.key]
        when {
            previous == null -> out.add(CanvasDiffEntry("insert", op.key, i, null))
            !stable.contains(i) -> out.add(CanvasDiffEntry("move", op.key, i, previous))
            contentKey(before[previous]) == contentKey(op) -> out.add(CanvasDiffEntry("keep", op.key, i, null))
            else -> out.add(CanvasDiffEntry("update", op.key, i, null))
        }
    }
    return out
}

// -- the SSR SVG serialisation ---------------------------------------------------------------

/** round to 6 decimals and trim: the ONE number spelling the SVG bytes are pinned to */
fun canvasNumberText(value: Double): String {
    if (!value.isFinite()) return "0"
    val rounded = Math.round(value * 1e6) / 1e6
    if (rounded == 0.0) return "0"
    val whole = rounded.toLong()
    if (rounded == whole.toDouble()) return whole.toString()
    return java.math.BigDecimal.valueOf(rounded).stripTrailingZeros().toPlainString()
}

private fun hexByte(v: Double): String {
    val n = min(255, max(0, (v * 255.0).roundToInt()))
    return n.toString(16).padStart(2, '0')
}

fun canvasRgbaHex(rgba: CanvasPaint.Rgba): String =
    "#" + hexByte(rgba.r) + hexByte(rgba.g) + hexByte(rgba.b)

private fun paintText(paint: CanvasPaint?): String = when (paint) {
    null -> "none"
    is CanvasPaint.Rgba -> canvasRgbaHex(paint)
    is CanvasPaint.Gradient -> "url(#${paint.id})"
    is CanvasPaint.Token -> {
        val token = CANVAS_COLOR_TOKENS[paint.token]
        if (token == null || token == "transparent") "transparent" else "var($token)"
    }
}

private fun paintAlpha(paint: CanvasPaint?): Double = if (paint is CanvasPaint.Rgba) paint.a else 1.0

fun canvasEscapeXml(source: String): String =
    source.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

private fun pathText(segments: List<CanvasSegment>): String {
    val parts = ArrayList<String>()
    for (seg in segments) {
        parts.add(seg.cmd)
        for (v in seg.values) parts.add(canvasNumberText(v))
    }
    return parts.joinToString(" ")
}

private fun matrixText(m: CanvasMatrix): String =
    "matrix(" + m.toList().joinToString(",") { canvasNumberText(it) } + ")"

/**
 * The tier-1 tree renders SERVER-SIDE as SVG and hydrates onto a canvas with no repaint
 * flash: a capability neither RN nor Flutter has, and it costs one serialiser.
 *
 * NAMED ABSENCE: SVG has no conic-gradient primitive, so an `angular` gradient serialises as a
 * radialGradient with the same stops - the SSR frame approximates and the live canvas paints
 * the real sweep. Everything else is byte-pinned by the corpus.
 */
fun canvasToSvg(list: CanvasDisplayList, width: Double, height: Double): String {
    val defs = ArrayList<String>()
    var fxCounter = 0
    fun fxId(): String { fxCounter += 1; return "dsx-fx-$fxCounter" }

    for ((id, gradient) in list.gradients) {
        val stops = gradient.stops.joinToString("") { s ->
            val bits = ArrayList<String>()
            bits.add("offset=\"" + canvasNumberText(s.offset) + "\"")
            val rgba = s.rgba
            if (rgba != null) {
                bits.add("stop-color=\"" + canvasRgbaHex(rgba) + "\"")
                if (rgba.a < 1.0) bits.add("stop-opacity=\"" + canvasNumberText(rgba.a) + "\"")
            } else {
                val token = CANVAS_COLOR_TOKENS[s.token]
                val spelling = if (token == null || token == "transparent") "transparent" else "var($token)"
                bits.add("stop-color=\"$spelling\"")
                if (s.opacity < 1.0) bits.add("stop-opacity=\"" + canvasNumberText(s.opacity) + "\"")
            }
            "<stop " + bits.joinToString(" ") + "/>"
        }
        fun g(i: Int): Double = if (i < gradient.geom.size) gradient.geom[i] else 0.0
        if (gradient.kind == "linear") {
            defs.add(
                "<linearGradient id=\"" + id + "\" gradientUnits=\"userSpaceOnUse\" x1=\"" +
                    canvasNumberText(g(0)) + "\" y1=\"" + canvasNumberText(g(1)) + "\" x2=\"" +
                    canvasNumberText(g(2)) + "\" y2=\"" + canvasNumberText(g(3)) + "\">" + stops +
                    "</linearGradient>"
            )
        } else {
            val r = if (gradient.kind == "radial") g(2) else max(width, height) / 2.0
            defs.add(
                "<radialGradient id=\"" + id + "\" gradientUnits=\"userSpaceOnUse\" cx=\"" +
                    canvasNumberText(g(0)) + "\" cy=\"" + canvasNumberText(g(1)) + "\" r=\"" +
                    canvasNumberText(r) + "\">" + stops + "</radialGradient>"
            )
        }
    }

    val body = ArrayList<String>()
    for (op in list.ops) {
        var inner: String
        if (op.kind == "text") {
            val bits = ArrayList<String>()
            bits.add("x=\"" + canvasNumberText(op.x) + "\"")
            bits.add("y=\"" + canvasNumberText(op.y) + "\"")
            bits.add("font-size=\"" + canvasNumberText(op.fontSize) + "\"")
            bits.add("fill=\"" + paintText(op.fill) + "\"")
            if (paintAlpha(op.fill) < 1.0) bits.add("fill-opacity=\"" + canvasNumberText(paintAlpha(op.fill)) + "\"")
            bits.add("text-anchor=\"" + op.textAnchor + "\"")
            inner = "<text " + bits.joinToString(" ") + ">" + canvasEscapeXml(op.text ?: "") + "</text>"
        } else if (op.kind == "image") {
            val bits = ArrayList<String>()
            bits.add("x=\"" + canvasNumberText(op.x) + "\"")
            bits.add("y=\"" + canvasNumberText(op.y) + "\"")
            op.width?.let { bits.add("width=\"" + canvasNumberText(it) + "\"") }
            op.height?.let { bits.add("height=\"" + canvasNumberText(it) + "\"") }
            bits.add("href=\"" + canvasEscapeXml(op.src ?: "") + "\"")
            inner = "<image " + bits.joinToString(" ") + "/>"
        } else {
            val bits = ArrayList<String>()
            bits.add("d=\"" + pathText(op.path ?: emptyList()) + "\"")
            bits.add("fill=\"" + paintText(op.fill) + "\"")
            if (paintAlpha(op.fill) < 1.0) bits.add("fill-opacity=\"" + canvasNumberText(paintAlpha(op.fill)) + "\"")
            if (op.fillRule != "nonzero") bits.add("fill-rule=\"" + op.fillRule + "\"")
            val stroke = op.stroke
            if (stroke != null) {
                bits.add("stroke=\"" + paintText(stroke) + "\"")
                bits.add("stroke-width=\"" + canvasNumberText(op.strokeWidth) + "\"")
                if (paintAlpha(stroke) < 1.0) bits.add("stroke-opacity=\"" + canvasNumberText(paintAlpha(stroke)) + "\"")
                if (op.strokeLinecap != "butt") bits.add("stroke-linecap=\"" + op.strokeLinecap + "\"")
                if (op.strokeLinejoin != "miter") bits.add("stroke-linejoin=\"" + op.strokeLinejoin + "\"")
            }
            inner = "<path " + bits.joinToString(" ") + "/>"
        }

        val wrap = ArrayList<String>()
        if (!op.transform.isIdentity) wrap.add("transform=\"" + matrixText(op.transform) + "\"")
        if (op.opacity != 1.0) wrap.add("opacity=\"" + canvasNumberText(op.opacity) + "\"")
        val clip = op.clip
        if (clip != null) {
            val id = fxId()
            val clipTransform = if (clip.transform.isIdentity) "" else " transform=\"" + matrixText(clip.transform) + "\""
            defs.add("<clipPath id=\"" + id + "\" clipPathUnits=\"userSpaceOnUse\"><path d=\"" +
                pathText(clip.path) + "\"" + clipTransform + "/></clipPath>")
            wrap.add("clip-path=\"url(#$id)\"")
        }
        if (wrap.isNotEmpty()) inner = "<g " + wrap.joinToString(" ") + ">" + inner + "</g>"

        for (i in op.effects.indices.reversed()) {
            when (val effect = op.effects[i]) {
                is CanvasEffect.Blend -> inner = "<g style=\"mix-blend-mode:" + effect.mode + "\">" + inner + "</g>"
                is CanvasEffect.Blur -> {
                    val id = fxId()
                    defs.add("<filter id=\"" + id + "\"><feGaussianBlur stdDeviation=\"" +
                        canvasNumberText(effect.radius / 2.0) + "\"/></filter>")
                    inner = "<g filter=\"url(#$id)\">" + inner + "</g>"
                }
                is CanvasEffect.Shadow -> {
                    val id = fxId()
                    val rgba = effect.color as? CanvasPaint.Rgba ?: CanvasPaint.BLACK
                    defs.add("<filter id=\"" + id + "\"><feDropShadow dx=\"" + canvasNumberText(effect.dx) +
                        "\" dy=\"" + canvasNumberText(effect.dy) + "\" stdDeviation=\"" +
                        canvasNumberText(effect.radius / 2.0) + "\" flood-color=\"" + canvasRgbaHex(rgba) +
                        "\" flood-opacity=\"" + canvasNumberText(rgba.a) + "\"/></filter>")
                    inner = "<g filter=\"url(#$id)\">" + inner + "</g>"
                }
            }
        }
        body.add(inner)
    }

    val defsText = if (defs.isEmpty()) "" else "<defs>" + defs.joinToString("") + "</defs>"
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + canvasNumberText(width) +
        "\" height=\"" + canvasNumberText(height) + "\" viewBox=\"0 0 " + canvasNumberText(width) +
        " " + canvasNumberText(height) + "\">" + defsText + body.joinToString("") + "</svg>"
}

// -- tier 2: the command recorder ------------------------------------------------------------

class CanvasShadow(val dx: Double, val dy: Double, val radius: Double, val color: CanvasPaint)

class CanvasClipState(val path: List<CanvasSegment>, val rule: String)

class CanvasDrawEntry(
    val alpha: Double,
    val ctm: CanvasMatrix,
    val op: String,
    val clip: CanvasClipState? = null,
    val shadow: CanvasShadow? = null,
    val blend: String? = null,
    val path: List<CanvasSegment>? = null,
    val rect: DoubleArray? = null,
    val src: String? = null,
    val text: String? = null,
    val x: Double? = null,
    val y: Double? = null,
    val width: Double? = null,
    val height: Double? = null,
    val style: CanvasPaint? = null,
    val fontSize: Double? = null,
    val rule: String? = null,
    val lineWidth: Double? = null,
    val cap: String? = null,
    val join: String? = null,
)

class CanvasMeasurement(val text: String, val width: Double, val ascent: Double, val descent: Double)

class CanvasScriptResult(
    val log: List<CanvasDrawEntry>,
    val measurements: List<CanvasMeasurement>,
    val diagnostics: List<String>,
)

/** the fallback text metrics, pinned so the fallback itself cannot drift. A platform WITH real
 *  font metrics answers from them, and that divergence is documented, not silent. */
const val CANVAS_FALLBACK_ADVANCE = 0.6
const val CANVAS_FALLBACK_ASCENT = 0.8
const val CANVAS_FALLBACK_DESCENT = 0.2

fun canvasFallbackMetrics(text: String, fontSize: Double): CanvasMeasurement = CanvasMeasurement(
    text,
    CANVAS_FALLBACK_ADVANCE * fontSize * text.length,
    CANVAS_FALLBACK_ASCENT * fontSize,
    CANVAS_FALLBACK_DESCENT * fontSize,
)

private class PaintState(
    var ctm: CanvasMatrix = CanvasMatrix.IDENTITY,
    var fill: CanvasPaint = CanvasPaint.BLACK,
    var stroke: CanvasPaint = CanvasPaint.BLACK,
    var lineWidth: Double = 1.0,
    var cap: String = "butt",
    var join: String = "miter",
    var alpha: Double = 1.0,
    var shadow: CanvasShadow? = null,
    var blend: String? = null,
    var clip: CanvasClipState? = null,
    var fontSize: Double = 10.0,
) {
    fun duplicate(): PaintState =
        PaintState(ctm, fill, stroke, lineWidth, cap, join, alpha, shadow, blend, clip, fontSize)
}

/**
 * The Canvas2D subset as a RECORDER: every call folds into a command stream a renderer replays,
 * which is why this corpus is exact on all three renderers - it asserts the stream, never the
 * pixels.
 *
 * (1) The CTM is baked into each path point AT POINT-ADD TIME - the Canvas2D rule, not the SVG
 * one. (2) save/restore push and pop the matrix AND the paint state as one unit. (3) `arc`
 * takes RADIANS (the Canvas2D signature authors know), `rotate` takes DEGREES (every other DSX
 * angle). (4) A draw with an EMPTY path emits nothing at all.
 */
class CanvasRecorder {
    val log = ArrayList<CanvasDrawEntry>()
    val measurements = ArrayList<CanvasMeasurement>()
    val diagnostics = ArrayList<String>()

    private var state = PaintState()
    private val stack = ArrayList<PaintState>()
    private val path = ArrayList<CanvasSegment>()
    private var userX = 0.0
    private var userY = 0.0
    private var startX = 0.0
    private var startY = 0.0
    private var hasCurrent = false

    fun run(script: List<List<Any?>>): CanvasScriptResult {
        for (command in script) call(command)
        return CanvasScriptResult(log, measurements, diagnostics)
    }

    private fun bake(x: Double, y: Double): DoubleArray = canvasApply(state.ctm, x, y)

    private fun moveTo(x: Double, y: Double) {
        val p = bake(x, y)
        path.add(CanvasSegment("M", doubleArrayOf(p[0], p[1])))
        userX = x; userY = y; startX = x; startY = y; hasCurrent = true
    }

    private fun lineTo(x: Double, y: Double) {
        if (!hasCurrent) { moveTo(x, y); return }
        val p = bake(x, y)
        path.add(CanvasSegment("L", doubleArrayOf(p[0], p[1])))
        userX = x; userY = y
    }

    private fun numbers(command: List<Any?>, count: Int, from: Int = 1): DoubleArray? {
        val out = DoubleArray(count)
        for (i in 0 until count) {
            val raw = command.getOrNull(from + i) ?: return null
            val value = when (raw) {
                is Number -> raw.toDouble()
                is String -> raw.toDoubleOrNull() ?: return null
                else -> return null
            }
            if (!value.isFinite()) return null
            out[i] = value
        }
        return out
    }

    private fun call(command: List<Any?>) {
        val name = command.getOrNull(0)?.toString() ?: ""
        fun missing() { diagnostics.add("canvas.ctx.$name: missing argument") }
        when (name) {
            "beginPath" -> { path.clear(); hasCurrent = false }
            "closePath" -> {
                if (path.isEmpty()) return
                path.add(CanvasSegment("Z", DoubleArray(0)))
                userX = startX; userY = startY
            }
            "moveTo" -> { val a = numbers(command, 2) ?: return missing(); moveTo(a[0], a[1]) }
            "lineTo" -> { val a = numbers(command, 2) ?: return missing(); lineTo(a[0], a[1]) }
            "quadTo" -> {
                val a = numbers(command, 4) ?: return missing()
                if (!hasCurrent) moveTo(a[0], a[1])
                val c = bake(a[0], a[1]); val p = bake(a[2], a[3])
                path.add(CanvasSegment("Q", doubleArrayOf(c[0], c[1], p[0], p[1])))
                userX = a[2]; userY = a[3]
            }
            "cubicTo" -> {
                val a = numbers(command, 6) ?: return missing()
                if (!hasCurrent) moveTo(a[0], a[1])
                val c1 = bake(a[0], a[1]); val c2 = bake(a[2], a[3]); val p = bake(a[4], a[5])
                path.add(CanvasSegment("C", doubleArrayOf(c1[0], c1[1], c2[0], c2[1], p[0], p[1])))
                userX = a[4]; userY = a[5]
            }
            "arc" -> {
                val a = numbers(command, 5) ?: return missing()
                arc(a[0], a[1], a[2], a[3], a[4], command.getOrNull(6) == true)
            }
            "arcTo" -> {
                val a = numbers(command, 5) ?: return missing()
                arcTo(a[0], a[1], a[2], a[3], a[4])
            }
            "rect" -> {
                val a = numbers(command, 4) ?: return missing()
                appendUserPath(canvasRectPath(a[0], a[1], a[2], a[3], 0.0, 0.0), a[0], a[1])
            }
            "roundRect" -> {
                val a = numbers(command, 5) ?: return missing()
                appendUserPath(canvasRectPath(a[0], a[1], a[2], a[3], a[4], a[4]), a[0], a[1])
            }
            "fill", "stroke" -> {
                if (path.isEmpty()) return
                log.add(
                    if (name == "fill") CanvasDrawEntry(
                        alpha = state.alpha, ctm = state.ctm, op = name, clip = state.clip,
                        shadow = state.shadow, blend = state.blend, path = ArrayList(path),
                        style = state.fill,
                        rule = if (command.getOrNull(1) == "evenodd") "evenodd" else "nonzero",
                    ) else CanvasDrawEntry(
                        alpha = state.alpha, ctm = state.ctm, op = name, clip = state.clip,
                        shadow = state.shadow, blend = state.blend, path = ArrayList(path),
                        style = state.stroke, lineWidth = state.lineWidth,
                        cap = state.cap, join = state.join,
                    )
                )
            }
            "clip" -> {
                if (path.isEmpty()) return
                val rule = if (command.getOrNull(1) == "evenodd") "evenodd" else "nonzero"
                state = state.duplicate().also { it.clip = CanvasClipState(ArrayList(path), rule) }
            }
            "clear" -> {
                log.add(CanvasDrawEntry(
                    alpha = state.alpha, ctm = state.ctm, op = "clear", clip = state.clip,
                    shadow = state.shadow, blend = state.blend, rect = numbers(command, 4),
                ))
            }
            "save" -> stack.add(state.duplicate())
            "restore" -> {
                if (stack.isEmpty()) {
                    diagnostics.add("canvas.ctx.restore: the state stack is empty")
                    return
                }
                state = stack.removeAt(stack.size - 1)
            }
            "translate" -> {
                val a = numbers(command, 2) ?: return missing()
                compose(CanvasMatrix(1.0, 0.0, 0.0, 1.0, a[0], a[1]))
            }
            "scale" -> {
                val a = numbers(command, 2) ?: return missing()
                compose(CanvasMatrix(a[0], 0.0, 0.0, a[1], 0.0, 0.0))
            }
            "rotate" -> {
                val a = numbers(command, 1) ?: return missing()
                val r = a[0] * DEG
                compose(CanvasMatrix(cos(r), sin(r), -sin(r), cos(r), 0.0, 0.0))
            }
            "transform" -> {
                val a = numbers(command, 6) ?: return missing()
                compose(CanvasMatrix(a[0], a[1], a[2], a[3], a[4], a[5]))
            }
            "drawImage" -> {
                val src = command.getOrNull(1) as? String ?: return missing()
                val a = numbers(command, 2, 2) ?: return missing()
                val size = numbers(command, 2, 4)
                log.add(CanvasDrawEntry(
                    alpha = state.alpha, ctm = state.ctm, op = "drawImage", clip = state.clip,
                    shadow = state.shadow, blend = state.blend, src = src, x = a[0], y = a[1],
                    width = size?.get(0), height = size?.get(1),
                ))
            }
            "fillText", "strokeText" -> {
                val body = command.getOrNull(1) as? String ?: return missing()
                val a = numbers(command, 2, 2) ?: return missing()
                log.add(CanvasDrawEntry(
                    alpha = state.alpha, ctm = state.ctm, op = name, clip = state.clip,
                    shadow = state.shadow, blend = state.blend, text = body, x = a[0], y = a[1],
                    style = if (name == "fillText") state.fill else state.stroke,
                    fontSize = state.fontSize,
                    lineWidth = if (name == "strokeText") state.lineWidth else null,
                ))
            }
            "measureText" -> {
                val body = command.getOrNull(1) as? String ?: return missing()
                measurements.add(canvasFallbackMetrics(body, state.fontSize))
            }
            "setFillStyle", "setStrokeStyle" -> {
                val raw = command.getOrNull(1) as? String ?: return missing()
                val parsed = parseCanvasPaint(raw)
                val paint = parsed.paint
                if (paint == null) {
                    if (!parsed.ok) diagnostics.add("canvas.ctx.$name: unparseable colour '$raw'")
                    return
                }
                state = state.duplicate().also {
                    if (name == "setFillStyle") it.fill = paint else it.stroke = paint
                }
            }
            "setLineWidth" -> {
                val a = numbers(command, 1) ?: return missing()
                state = state.duplicate().also { it.lineWidth = a[0] }
            }
            "setLineCap" -> {
                val raw = command.getOrNull(1) as? String ?: return missing()
                state = state.duplicate().also { it.cap = raw }
            }
            "setLineJoin" -> {
                val raw = command.getOrNull(1) as? String ?: return missing()
                state = state.duplicate().also { it.join = raw }
            }
            "setShadow" -> {
                val a = numbers(command, 3)
                val raw = command.getOrNull(4) as? String
                if (a == null || raw == null) return missing()
                val parsed = parseCanvasPaint(raw)
                state = state.duplicate().also {
                    it.shadow = CanvasShadow(a[0], a[1], a[2], parsed.paint ?: CanvasPaint.BLACK)
                }
            }
            "setBlendMode" -> {
                val raw = command.getOrNull(1) as? String ?: return missing()
                state = state.duplicate().also { it.blend = raw }
            }
            "setGlobalAlpha" -> {
                val a = numbers(command, 1) ?: return missing()
                state = state.duplicate().also { it.alpha = clampUnit(a[0]) }
            }
            "setFont" -> {
                val a = numbers(command, 1) ?: return missing()
                state = state.duplicate().also { it.fontSize = a[0] }
            }
            else -> diagnostics.add("canvas.ctx: unknown method '$name'")
        }
    }

    private fun compose(local: CanvasMatrix) {
        state = state.duplicate().also { it.ctm = canvasMatMul(state.ctm, local) }
    }

    /** a user-space subpath, every point baked through the CTM as it is added */
    private fun appendUserPath(segments: List<CanvasSegment>, endX: Double, endY: Double) {
        appendUserCurves(segments)
        userX = endX; userY = endY; startX = endX; startY = endY; hasCurrent = true
    }

    private fun appendUserCurves(segments: List<CanvasSegment>) {
        for (seg in segments) {
            if (seg.cmd == "Z") { path.add(CanvasSegment("Z", DoubleArray(0))); continue }
            val out = DoubleArray(seg.values.size)
            var i = 0
            while (i < seg.values.size) {
                val p = bake(seg.values[i], seg.values[i + 1])
                out[i] = p[0]; out[i + 1] = p[1]
                i += 2
            }
            path.add(CanvasSegment(seg.cmd, out))
        }
    }

    /** joins from the current point with a line, sweeps clockwise unless anticlockwise is set,
     *  clamps at a full turn, and folds to cubics through the same converter as `d` */
    private fun arc(cx: Double, cy: Double, r: Double, a0: Double, a1: Double, ccw: Boolean) {
        val sxPoint = cx + r * cos(a0)
        val syPoint = cy + r * sin(a0)
        if (hasCurrent) lineTo(sxPoint, syPoint) else moveTo(sxPoint, syPoint)
        val full = 2 * Math.PI
        var delta = a1 - a0
        if (!ccw) {
            if (delta >= full) delta = full
            else { delta %= full; if (delta < 0) delta += full }
        } else if (delta <= -full) {
            delta = -full
        } else {
            delta %= full
            if (delta > 0) delta -= full
        }
        if (delta == 0.0) return
        appendUserCurves(arcCentreToCubics(cx, cy, r, r, 0.0, a0, delta))
        userX = cx + r * cos(a0 + delta)
        userY = cy + r * sin(a0 + delta)
    }

    private fun arcTo(x1: Double, y1: Double, x2: Double, y2: Double, r: Double) {
        if (!hasCurrent) { moveTo(x1, y1); return }
        val v1x = userX - x1
        val v1y = userY - y1
        val v2x = x2 - x1
        val v2y = y2 - y1
        val l1 = hypot(v1x, v1y)
        val l2 = hypot(v2x, v2y)
        val cross = v1x * v2y - v1y * v2x
        if (l1 == 0.0 || l2 == 0.0 || r <= 0.0 || abs(cross) < 1e-12) { lineTo(x1, y1); return }
        val u1x = v1x / l1; val u1y = v1y / l1
        val u2x = v2x / l2; val u2y = v2y / l2
        val angle = acos(min(1.0, max(-1.0, u1x * u2x + u1y * u2y)))
        val d = r / tan(angle / 2.0)
        val t1x = x1 + u1x * d; val t1y = y1 + u1y * d
        val t2x = x1 + u2x * d; val t2y = y1 + u2y * d
        var bx = u1x + u2x
        var by = u1y + u2y
        val bl = hypot(bx, by)
        if (bl == 0.0) { lineTo(x1, y1); return }
        bx /= bl; by /= bl
        val centreDistance = r / sin(angle / 2.0)
        val cx = x1 + bx * centreDistance
        val cy = y1 + by * centreDistance
        lineTo(t1x, t1y)
        val theta1 = atan2(t1y - cy, t1x - cx)
        val theta2 = atan2(t2y - cy, t2x - cx)
        var delta = theta2 - theta1
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        appendUserCurves(arcCentreToCubics(cx, cy, r, r, 0.0, theta1, delta))
        userX = t2x; userY = t2y
    }
}

fun runCanvasScript(script: List<List<Any?>>): CanvasScriptResult = CanvasRecorder().run(script)

// -- `on:frame`: the display-link contract ----------------------------------------------------

/** the 60/s budget - the SAME constant the scene kernel uses, deliberately shared */
const val CANVAS_FRAME_MIN_INTERVAL_MS: Double = 1000.0 / 60.0

class CanvasFramePayload(val time: Double, val delta: Double, val frame: Int)

class CanvasFrameFold(
    val emitted: List<CanvasFramePayload>,
    val installs: Int,
    val uninstalls: Int,
    val installed: Boolean,
)

/**
 * An always-running frame callback is a BATTERY BUG, so the law is enforced by fixture, not by
 * intent. The loop is installed ONLY while an `on:frame` handler is bound AND the canvas is
 * mounted AND it is on screen; ticks arriving while the loop is not installed are DROPPED,
 * never queued; `delta` is 0 on the first tick after every install and `time` is accumulated
 * delta, so it EXCLUDES offscreen intervals; `frame` counts emissions.
 */
class CanvasFrameLoop(private var bound: Boolean) {
    private var mounted = false
    private var visible = true
    private var installedFlag = false
    private var lastEmitted: Double? = null
    private var time = 0.0
    private var frame = 0

    var installs = 0
        private set
    var uninstalls = 0
        private set

    val installed: Boolean get() = installedFlag

    fun setBound(value: Boolean) { bound = value; settle() }
    fun setMounted(value: Boolean) { mounted = value; settle() }
    fun setVisible(value: Boolean) { visible = value; settle() }

    private fun settle() {
        val want = bound && mounted && visible
        if (want && !installedFlag) {
            installedFlag = true
            installs += 1
            lastEmitted = null
        } else if (!want && installedFlag) {
            installedFlag = false
            uninstalls += 1
        }
    }

    /** one raw platform tick (ms); the payload to emit, or null when dropped or coalesced */
    fun tick(nowMs: Double): CanvasFramePayload? {
        if (!installedFlag) return null
        val last = lastEmitted
        if (last == null) {
            lastEmitted = nowMs
            val payload = CanvasFramePayload(time, 0.0, frame)
            frame += 1
            return payload
        }
        val gap = nowMs - last
        if (gap < CANVAS_FRAME_MIN_INTERVAL_MS) return null
        lastEmitted = nowMs
        val delta = gap / 1000.0
        time += delta
        val payload = CanvasFramePayload(time, delta, frame)
        frame += 1
        return payload
    }
}

/** the pure fold the corpus pins: a bound flag plus a lifecycle/tick event list */
fun canvasFrameSchedule(bound: Boolean, events: List<Map<String, Any?>>): CanvasFrameFold {
    val loop = CanvasFrameLoop(bound)
    val emitted = ArrayList<CanvasFramePayload>()
    for (event in events) {
        when (event["type"]?.toString()) {
            "mount" -> loop.setMounted(true)
            "unmount" -> loop.setMounted(false)
            "visible" -> loop.setVisible(event["value"] == true)
            "tick" -> loop.tick(asDouble(event["at"], 0.0))?.let { emitted.add(it) }
        }
    }
    return CanvasFrameFold(emitted, loop.installs, loop.uninstalls, loop.installed)
}

// -- accessibility -----------------------------------------------------------------------------

/** the gesture words that make a canvas INTERACTIVE. `on:draw` and `on:frame` are deliberately
 *  absent: a painted background is decorative. */
val CANVAS_GESTURE_HANDLERS: List<String> = listOf(
    "on:tap", "on:doubletap", "on:longpress", "on:drag", "on:pan",
    "on:pinch", "on:rotate", "on:swipe", "on:press", "on:adjust",
)

const val CANVAS_A11Y_LINT_CODE = "canvas-a11y-label"
const val CANVAS_A11Y_LINT_MESSAGE =
    "<canvas> with a gesture handler needs a11yLabel \u2014 a canvas is opaque to assistive tech"

class CanvasA11yChild(val role: String, val label: String, val value: String?)

class CanvasA11yLint(val code: String, val level: String, val message: String)

class CanvasA11yVerdict(
    val interactive: Boolean,
    val label: String?,
    val children: List<CanvasA11yChild>,
    val role: String,
    val hidden: Boolean,
    val lint: CanvasA11yLint?,
)

/**
 * A canvas is OPAQUE to assistive tech by construction - there is no view tree to inspect, only
 * pixels - so the semantics are declared or they do not exist. One fold, one rule, three
 * surfaces: this is what all three renderers apply AND what `lint_dsx.rb` enforces.
 */
fun canvasA11y(
    attrs: Map<String, Any?>,
    a11yChildren: List<Map<String, Any?>>? = null,
): CanvasA11yVerdict {
    val interactive = CANVAS_GESTURE_HANDLERS.any { name ->
        val raw = attrs[name]
        raw != null && raw.toString().trim().isNotEmpty()
    }
    val trimmed = attrs["a11yLabel"]?.toString()?.trim() ?: ""
    val label = if (trimmed.isEmpty()) null else trimmed
    val children = (a11yChildren ?: emptyList()).map {
        CanvasA11yChild(
            it["role"]?.toString() ?: "image",
            it["label"]?.toString() ?: "",
            it["value"]?.toString(),
        )
    }
    val declared = label != null || children.isNotEmpty()
    val role = when {
        children.isNotEmpty() -> "group"
        interactive -> if (label != null) "button" else "group"
        else -> if (label != null) "image" else "none"
    }
    return CanvasA11yVerdict(
        interactive = interactive,
        label = label,
        children = children,
        role = role,
        hidden = !interactive && !declared,
        lint = if (interactive && !declared)
            CanvasA11yLint(CANVAS_A11Y_LINT_CODE, "error", CANVAS_A11Y_LINT_MESSAGE) else null,
    )
}
