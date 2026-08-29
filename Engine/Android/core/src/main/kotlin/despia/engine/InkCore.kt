//
//  InkCore.kt — the INK PRIMITIVE's pure core: the wire shape of a captured drawing, the
//  capture folds (clamp · round · coalesce), the ink curve, and the tier-1 canvas nodes a
//  committed drawing becomes. Nothing Compose-shaped in it.
//
//  This is the `<ink>` child of `<canvas>`: the one primitive a drawing surface needs that a
//  display list cannot express — a pointer stream captured and painted NATIVELY, at pointer
//  rate, without a store write per sample. `<Signature>` is its first consumer.
//
//  The law is OpenSource/Conformance/canvas/ink.json; the TS twin is @despia/kernel
//  ink-core.ts and the Swift twin Engine/iOS/InkCore.swift.
//
//  THE VALUE IS THE API. A drawing is `[{ points: [[x, y], …], width }]` with x/y NORMALIZED
//  0…1 against the surface box and rounded to 1/COORDINATE_SCALE at CAPTURE — so the number
//  written to the store is the number every renderer draws, a phone capture replays on a
//  desktop surface, and clearing is `drawing = []` rather than a control channel.
//
//  THE COMMITTED DRAWING IS ORDINARY TIER 1. `nodes()` turns the stored strokes into the same
//  `path` markup nodes an author could have written by hand, so the display list, its keyed
//  diff and its SVG serialisation need no special case for ink. Only the IN-FLIGHT stroke is
//  transient native paint.
//

package despia.engine

import kotlin.math.roundToLong

object InkCore {

    // Ink defaults and the capture folds.
    const val STROKE_WIDTH = 3.0
    /** Samples closer than this (in pad points, before normalization) are dropped. */
    const val MIN_POINT_DISTANCE = 1.5
    /** The normalized pair is rounded to 1/10000 at capture. */
    const val COORDINATE_SCALE = 10000.0

    /** The ink paint every renderer applies to a committed stroke. */
    const val LINECAP = "round"
    const val LINEJOIN = "round"

    /** One captured point, normalized 0…1. Doubles, not Floats: this pair IS the stored value. */
    data class Point(val x: Double, val y: Double)

    data class Stroke(val points: List<Point>, val width: Double)

    enum class Verb { MOVE, LINE, QUAD }

    data class Op(val verb: Verb, val x: Double, val y: Double,
                  val cx: Double = 0.0, val cy: Double = 0.0)

    /** Read a stored signature. Anything that is not a usable stroke is dropped, never guessed. */
    fun decode(rows: List<Map<String, Any?>>): List<Stroke> = rows.mapNotNull { row ->
        val raw = row["points"] as? List<*> ?: return@mapNotNull null
        val points = raw.mapNotNull { pair ->
            val xy = pair as? List<*> ?: return@mapNotNull null
            if (xy.size < 2) return@mapNotNull null
            val x = JSE.number(xy[0]) ?: return@mapNotNull null
            val y = JSE.number(xy[1]) ?: return@mapNotNull null
            Point(x, y)
        }
        if (points.isEmpty()) null else Stroke(points, JSE.number(row["width"]) ?: STROKE_WIDTH)
    }

    /** The store shape — plain lists, so the value survives every transport unchanged. */
    fun encode(strokes: List<Stroke>): List<Map<String, Any?>> = strokes.map { stroke ->
        mapOf("points" to stroke.points.map { listOf(it.x, it.y) }, "width" to stroke.width)
    }

    /** Clamp a pointer position to the pad box and round it AT CAPTURE. */
    fun point(x: Double, y: Double, width: Double, height: Double): Point =
        Point(round01(if (width > 0.0) x / width else 0.0),
              round01(if (height > 0.0) y / height else 0.0))

    private fun round01(v: Double): Double {
        val clamped = if (v.isFinite()) v.coerceIn(0.0, 1.0) else 0.0
        return (clamped * COORDINATE_SCALE).roundToLong() / COORDINATE_SCALE
    }

    /** The coalescing floor: is the new sample far enough from the last one to keep? */
    fun farEnough(last: Point, next: Point, width: Double, height: Double): Boolean {
        val dx = (next.x - last.x) * width
        val dy = (next.y - last.y) * height
        return dx * dx + dy * dy >= MIN_POINT_DISTANCE * MIN_POINT_DISTANCE
    }

    /**
     * The INK LAW: a quadratic Bézier through the MIDPOINTS of consecutive samples, so the same
     * stroke list draws the same curve on all four renderers. A one-point stroke is a dot,
     * painted by the round cap.
     */
    fun ops(points: List<Point>, width: Double, height: Double): List<Op> {
        if (points.isEmpty()) return emptyList()
        val at = points.map { Point(it.x * width, it.y * height) }
        val ops = ArrayList<Op>(at.size)
        ops.add(Op(Verb.MOVE, at[0].x, at[0].y))
        if (at.size == 1) {
            ops.add(Op(Verb.LINE, at[0].x, at[0].y))
            return ops
        }
        for (i in 1 until at.size - 1) {
            ops.add(Op(Verb.QUAD, (at[i].x + at[i + 1].x) / 2, (at[i].y + at[i + 1].y) / 2,
                       at[i].x, at[i].y))
        }
        ops.add(Op(Verb.LINE, at[at.size - 1].x, at[at.size - 1].y))
        return ops
    }

    /** The same ops as an SVG `d` — the serialised form the tier-1 nodes carry. */
    fun pathData(points: List<Point>, width: Double, height: Double): String =
        ops(points, width, height).joinToString(" ") { op ->
            when (op.verb) {
                Verb.QUAD -> "Q ${trim(op.cx)} ${trim(op.cy)} ${trim(op.x)} ${trim(op.y)}"
                Verb.MOVE -> "M ${trim(op.x)} ${trim(op.y)}"
                Verb.LINE -> "L ${trim(op.x)} ${trim(op.y)}"
            }
        }

    private fun trim(v: Double): String {
        val rounded = Math.round(v * 1000.0) / 1000.0
        return if (rounded == Math.floor(rounded) && !rounded.isInfinite()) {
            rounded.toLong().toString()
        } else {
            rounded.toString()
        }
    }

    /**
     * The committed drawing as TIER-1 markup nodes — one stroked `path` per stroke, in the
     * surface's own pixel space. The display list, its keyed diff and its SVG serialisation
     * then treat ink exactly like geometry an author wrote by hand.
     */
    fun nodes(strokes: List<Stroke>, width: Double, height: Double, stroke: String): List<CanvasMarkupNode> =
        strokes.map { entry ->
            CanvasMarkupNode(
                "path",
                mapOf(
                    "d" to pathData(entry.points, width, height),
                    "fill" to "none",
                    "stroke" to stroke,
                    "strokeWidth" to entry.width,
                    "strokeLinecap" to LINECAP,
                    "strokeLinejoin" to LINEJOIN,
                ),
            )
        }
}
