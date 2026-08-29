//
//  StackGestures.kt - the U02 gesture family's renderer-neutral pure core (:core, pure
//  JVM): velocity derivation, the slop that separates a tap from a drag, swipe
//  classification, the pinch/rotate transform tracker, the gestureAxis claim, and the
//  COMPOSITION resolver behind gesture= / gestureAxis=. The law is the corpus:
//  OpenSource/Conformance/input/gestures.json (parity/U02-gestures.md). The twin of the
//  web @despia/dom gestures.ts and Swift StackGestures.swift.
//
//  The split is the tooltip one: the Compose adapter owns raw pointer delivery, pointer
//  identity, hover capability and PointerEventPass ordering, then reports normalized
//  samples here. Units are density-independent (dp on this renderer, points on Apple,
//  CSS px on web) and velocities are units per SECOND. The phase vocabulary is the
//  shipped on:drag one - start | move | end - and a cancelled gesture delivers phase
//  "end", already the declared cross-renderer law for on:drag.
//
//  Article 7: a gesture whose input does not exist on a surface never fires there and
//  never degrades into a fake - GESTURE_DEGRADATION is that promise as data, diffed by
//  all three runners.
//
package despia.engine

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot

object StackGestures {

    const val TAP_SLOP = 10.0
    const val AXIS_SLOP = 10.0
    const val SWIPE_MIN_DISTANCE = 24.0
    const val SWIPE_MIN_VELOCITY = 300.0
    const val VELOCITY_WINDOW_MS = 100.0
    const val VELOCITY_SAMPLES = 3
    const val PINCH_SLOP = 0.05
    const val ROTATE_SLOP = 0.087

    /** Which continuous recognizer wins an exclusive contest, most specific first. */
    val PRECEDENCE = listOf("pinch", "rotate", "pan", "scroll", "swipe", "longPress", "tap")

    /** Recognizers that hold the touch for a while, and therefore compete with each other. */
    val CONTINUOUS = setOf("pinch", "rotate", "pan", "scroll")

    /** Recognizers an axis claim can eliminate. */
    val DIRECTIONAL = setOf("pan", "scroll", "swipe")

    /** Article 7 as data: what each gesture needs, and what must exist when it is absent. */
    val DEGRADATION: List<Map<String, String>> = listOf(
        mapOf(
            "gesture" to "pinch", "requires" to "multiTouch", "whenAbsent" to "never-fires",
            "alternative" to "scroll zoom= bounds, an on:adjust step, or explicit zoom controls",
        ),
        mapOf(
            "gesture" to "rotate", "requires" to "multiTouch", "whenAbsent" to "never-fires",
            "alternative" to "an on:adjust step or explicit rotate controls",
        ),
        mapOf(
            "gesture" to "swipe", "requires" to "touch", "whenAbsent" to "never-fires",
            "alternative" to "a visible control for the same action, never swipe-only",
        ),
        mapOf(
            "gesture" to "hover", "requires" to "hoverPointer", "whenAbsent" to "never-fires",
            "alternative" to "content is never gated behind hover - the same content on tap or in place",
        ),
        mapOf(
            "gesture" to "press", "requires" to "pointer", "whenAbsent" to "never-fires",
            "alternative" to "on:tap keeps working; press state is decoration",
        ),
        mapOf(
            "gesture" to "drag", "requires" to "pointer", "whenAbsent" to "never-fires",
            "alternative" to "on:adjust plus a11yValue, which the linter requires anyway",
        ),
    )

    data class Sample1D(val t: Double, val value: Double)
    data class Sample2D(val t: Double, val x: Double, val y: Double)
    data class Velocity2D(val vx: Double, val vy: Double)
    data class Swipe(val direction: String, val velocity: Double, val distance: Double)
    data class Point(val id: String, val x: Double, val y: Double)

    /**
     * The ONE velocity derivation every gesture uses. Weighted moving average over the
     * samples inside the last VELOCITY_WINDOW_MS, capped at VELOCITY_SAMPLES, with the
     * oldest surviving pair weighted 1 and each newer pair one more. A pair whose dt is not
     * positive is DROPPED (never a divide by zero, never Infinity) while still consuming
     * its recency weight; fewer than two usable samples is 0.
     */
    fun velocity1D(samples: List<Sample1D>): Double {
        if (samples.size < 2) return 0.0
        val lastT = samples.last().t
        val kept = samples.filter { lastT - it.t <= VELOCITY_WINDOW_MS }.takeLast(VELOCITY_SAMPLES)
        if (kept.size < 2) return 0.0
        var total = 0.0
        var weightTotal = 0.0
        var weight = 0
        for (i in 0 until kept.size - 1) {
            val a = kept[i]
            val b = kept[i + 1]
            val dt = b.t - a.t
            weight += 1
            if (dt <= 0.0) continue
            total += weight * ((b.value - a.value) / (dt / 1000.0))
            weightTotal += weight
        }
        return if (weightTotal == 0.0) 0.0 else total / weightTotal
    }

    /** velocity1D per axis - no second formula, so on:drag and the swipe gate cannot drift. */
    fun velocity2D(samples: List<Sample2D>): Velocity2D = Velocity2D(
        velocity1D(samples.map { Sample1D(it.t, it.x) }),
        velocity1D(samples.map { Sample1D(it.t, it.y) }),
    )

    /**
     * Direction classification at the end of a pan. The DOMINANT axis wins and an exact
     * |dx| == |dy| diagonal breaks HORIZONTAL (the same tie-break claimAxis uses). Both
     * gates read the chosen axis: distance >= SWIPE_MIN_DISTANCE and |velocity| >=
     * SWIPE_MIN_VELOCITY, which is what makes a slow drag not a swipe. An axis claim of x
     * or y rejects the other axis outright.
     */
    fun resolveSwipe(dx: Double, dy: Double, vx: Double, vy: Double, axis: String = "both"): Swipe? {
        val horizontal = abs(dx) >= abs(dy)
        val directionAxis = if (horizontal) "x" else "y"
        if ((axis == "x" || axis == "y") && axis != directionAxis) return null
        val distance = if (horizontal) abs(dx) else abs(dy)
        val velocity = if (horizontal) abs(vx) else abs(vy)
        if (distance == 0.0) return null
        if (distance < SWIPE_MIN_DISTANCE || velocity < SWIPE_MIN_VELOCITY) return null
        val direction = if (horizontal) {
            if (dx > 0) "right" else "left"
        } else {
            if (dy > 0) "down" else "up"
        }
        return Swipe(direction, velocity, distance)
    }

    /**
     * `gestureAxis=` as the RECOGNIZER-LEVEL claim, not a direction check in the handler:
     * inside the slop nothing is claimed yet (an ancestor scroll may still take the touch);
     * past it an x or y claimer either claims the touch or FAILS it back to the ancestor.
     * This is the iOS pan-subclass technique and the web touch-action declaration,
     * expressed once. Ties break horizontal, exactly as resolveSwipe.
     */
    fun claimAxis(axis: String, dx: Double, dy: Double, slop: Double = AXIS_SLOP): String {
        if (hypot(dx, dy) <= slop) return "pending"
        if (axis != "x" && axis != "y") return "claimed"
        if (axis == "x") return if (abs(dx) >= abs(dy)) "claimed" else "rejected"
        return if (abs(dy) > abs(dx)) "claimed" else "rejected"
    }

    /** Normalize into the half-open turn - exclusive at -pi, inclusive at +pi: the wrap that makes rotation continuous. */
    fun normalizeAngle(angle: Double): Double {
        var a = angle
        while (a > PI) a -= 2 * PI
        while (a <= -PI) a += 2 * PI
        return a
    }

    /**
     * The on:drag payload. Every shipped key keeps its exact meaning and value;
     * translationX / translationY are the named twins of dx / dy (the vocabulary authors
     * expect) and velocityX / velocityY come from the same velocity1D fold. width and
     * height floor at 1, so a zero-sized element never divides by zero.
     */
    fun dragPayload(
        width: Double,
        height: Double,
        x: Double,
        y: Double,
        startX: Double,
        startY: Double,
        samples: List<Sample2D>,
        phase: String,
    ): Map<String, Any?> {
        val w = kotlin.math.max(width, 1.0)
        val h = kotlin.math.max(height, 1.0)
        val v = velocity2D(samples)
        val tx = x - startX
        val ty = y - startY
        return mapOf(
            "x" to x, "y" to y, "width" to w, "height" to h,
            "fraction" to (x / w).coerceIn(0.0, 1.0),
            "fractionY" to (y / h).coerceIn(0.0, 1.0),
            "dx" to tx, "dy" to ty,
            "translationX" to tx, "translationY" to ty,
            "velocityX" to v.vx, "velocityY" to v.vy,
            "phase" to phase,
        )
    }

    // MARK: - the composition resolver

    data class Node(
        val id: String,
        val recognizers: List<String>,
        val gesture: String = "exclusive",
        val axis: String = "both",
    )

    data class Attempt(val kinds: Set<String>, val axis: String = "none", val claimedBy: String? = null)

    data class Fired(val node: String, val kind: String)
    data class Blocked(val node: String, val kind: String, val reason: String)
    data class Composition(val fire: List<Fired>, val blocked: List<Blocked>)

    private fun precedenceIndex(kind: String): Int =
        PRECEDENCE.indexOf(kind).let { if (it < 0) PRECEDENCE.size else it }

    /**
     * Given the ancestor chain (root first) and one attempt, which recognizers may fire
     * together. The attempt is what the RAW input physically matches - the adapter decides
     * that, this decides composition. In order: an axis claim eliminates a directional
     * recognizer running on the other axis; an outstanding claim by one node cancels every
     * other node's recognizers; a `defer` node yields while any ANCESTOR candidate is still
     * viable; the DEEPEST surviving node owns the touch and an ancestor keeps its
     * recognizers only if it declared `simultaneous`; inside a node the continuous
     * recognizers are exclusive by precedence unless the node declared `simultaneous`,
     * while discrete ones never compete.
     */
    fun resolveComposition(tree: List<Node>, attempt: Attempt): Composition {
        class Candidate(val index: Int, val node: String, val kind: String) {
            var blocked: String? = null
            val alive: Boolean get() = blocked == null
        }

        val candidates = mutableListOf<Candidate>()
        tree.forEachIndexed { index, node ->
            node.recognizers
                .filter { it in attempt.kinds }
                .sortedWith(compareBy({ precedenceIndex(it) }, { it }))
                .forEach { candidates += Candidate(index, node.id, it) }
        }

        for (c in candidates) {
            val axis = tree[c.index].axis
            if (c.kind in DIRECTIONAL && (axis == "x" || axis == "y") &&
                (attempt.axis == "x" || attempt.axis == "y") && axis != attempt.axis
            ) {
                c.blocked = "axis"
            }
        }

        if (attempt.claimedBy != null) {
            for (c in candidates) if (c.alive && c.node != attempt.claimedBy) c.blocked = "claimed"
        }

        tree.forEachIndexed { index, node ->
            if (node.gesture != "defer") return@forEachIndexed
            if (candidates.none { it.alive && it.index < index }) return@forEachIndexed
            for (c in candidates) if (c.index == index && c.alive) c.blocked = "deferred"
        }

        val winner = candidates.filter { it.alive }.maxOfOrNull { it.index }
            ?: return Composition(emptyList(), candidates.map { Blocked(it.node, it.kind, it.blocked!!) })

        for (c in candidates) {
            if (c.alive && c.index != winner && tree[c.index].gesture != "simultaneous") c.blocked = "exclusive"
        }

        tree.forEachIndexed { index, node ->
            if (node.gesture == "simultaneous") return@forEachIndexed
            candidates.filter { it.index == index && it.alive && it.kind in CONTINUOUS }
                .drop(1)
                .forEach { it.blocked = "exclusive" }
        }

        return Composition(
            candidates.filter { it.alive }.map { Fired(it.node, it.kind) },
            candidates.filter { !it.alive }.map { Blocked(it.node, it.kind, it.blocked!!) },
        )
    }
}

/**
 * on:pressIn / on:pressOut - the custom press-state channel, and the slop that separates
 * a tap from a drag. pressOut ALWAYS balances pressIn (release, cancellation, unmount); a
 * press that ever exceeded the slop is a drag and never also reports a tap; the slop is
 * radial and one-way; one pointer owns the press.
 */
class StackPressTracker(private val slop: Double = StackGestures.TAP_SLOP) {
    private var active: String? = null
    private var sx = 0.0
    private var sy = 0.0

    /** true once this press has travelled past the slop - it is a drag, not a tap. */
    var dragging = false
        private set

    fun down(pointer: String, x: Double, y: Double): List<String> {
        if (active != null) return emptyList()
        active = pointer
        sx = x
        sy = y
        dragging = false
        return listOf("pressIn")
    }

    fun move(pointer: String, x: Double, y: Double): List<String> {
        if (active != pointer || dragging) return emptyList()
        if (hypot(x - sx, y - sy) > slop) dragging = true
        return emptyList()
    }

    fun up(pointer: String, x: Double, y: Double): List<String> {
        if (active != pointer) return emptyList()
        active = null
        return if (dragging) listOf("pressOut") else listOf("pressOut", "tap")
    }

    fun cancel(pointer: String): List<String> {
        if (active != pointer) return emptyList()
        active = null
        return listOf("pressOut")
    }

    fun unmount(): List<String> {
        if (active == null) return emptyList()
        active = null
        return listOf("pressOut")
    }
}

/**
 * on:hover - the POSITIONAL hover channel that complements the shipped on:hoverStart /
 * on:hoverEnd pair (input/hover.json owns pointer identity and the balanced pair). Only a
 * hover-capable source is ever tracked, so a touch screen never fires it and content is
 * never gated behind hover (Article 7); the enter IS the first sample, the on:drag
 * minimum-distance-0 rule.
 */
class StackHoverMotion {
    data class Emission(val action: String, val x: Double, val y: Double)

    private var active = false

    fun enter(hoverCapable: Boolean, x: Double, y: Double): List<Emission> {
        if (!hoverCapable || active) return emptyList()
        active = true
        return listOf(Emission("hover", x, y))
    }

    fun move(x: Double, y: Double): List<Emission> =
        if (active) listOf(Emission("hover", x, y)) else emptyList()

    fun leave(x: Double, y: Double): List<Emission> {
        if (!active) return emptyList()
        active = false
        return listOf(Emission("hoverEnd", x, y))
    }

    fun unmount(): List<Emission> {
        if (!active) return emptyList()
        active = false
        return listOf(Emission("hoverEnd", 0.0, 0.0))
    }
}

/**
 * The ONE tracker behind on:pinch and on:rotate (the Compose detectTransformGestures
 * analogue). Each update carries the FULL set of pointers currently down and the two
 * lowest-sorted ids define the span. The gesture spans from the first two-pointer
 * engagement until the LAST pointer lifts: dropping to one finger SUSPENDS (values hold,
 * nothing emitted) and a returning finger re-baselines against the held accumulation,
 * which is why the scale never jumps at a finger change. Rotation accumulates normalized
 * frame deltas, so it is continuous across the +-pi wrap and keeps growing past a full
 * turn. A re-baseline never emits; start fires the first frame past pinchSlop or
 * rotateSlop; end fires once, with the last values.
 */
class StackTransformTracker(
    private val pinchSlop: Double = StackGestures.PINCH_SLOP,
    private val rotateSlop: Double = StackGestures.ROTATE_SLOP,
) {
    data class Emission(
        val phase: String,
        val scale: Double,
        val rotation: Double,
        val focusX: Double,
        val focusY: Double,
        val scaleVelocity: Double,
        val rotationVelocity: Double,
    )

    private var engaged = false
    private var spanning = false
    private var started = false
    private var accumScale = 1.0
    private var scale = 1.0
    private var rotation = 0.0
    private var focusX = 0.0
    private var focusY = 0.0
    private var baseDistance = 0.0
    private var lastAngle = 0.0
    private var baseIds: String? = null
    private var samples = mutableListOf<Triple<Double, Double, Double>>()

    fun update(t: Double, points: List<StackGestures.Point>): List<Emission> {
        val pts = points.sortedBy { it.id }
        if (pts.size >= 2) {
            val a = pts[0]
            val b = pts[1]
            val distance = hypot(b.x - a.x, b.y - a.y)
            val angle = atan2(b.y - a.y, b.x - a.x)
            focusX = pts.sumOf { it.x } / pts.size
            focusY = pts.sumOf { it.y } / pts.size
            val ids = "${a.id} ${b.id}"
            if (!spanning || ids != baseIds) {
                accumScale = scale                       // fold the finished span in
                baseDistance = distance
                lastAngle = angle
                baseIds = ids
                spanning = true
                engaged = true
                samples += Triple(t, scale, rotation)
                return emptyList()                       // a re-baseline never emits
            }
            val span = if (baseDistance > 0.0) distance / baseDistance else 1.0
            scale = accumScale * span
            rotation += StackGestures.normalizeAngle(angle - lastAngle)
            lastAngle = angle
            samples += Triple(t, scale, rotation)
            if (!started) {
                if (abs(scale - 1.0) > pinchSlop || abs(rotation) > rotateSlop) {
                    started = true
                    return listOf(emission("start"))
                }
                return emptyList()
            }
            return listOf(emission("move"))
        }
        if (pts.size == 1 && engaged) {
            accumScale = scale                           // suspend: hold, wait for the second finger
            spanning = false
            baseIds = null
            return emptyList()
        }
        if (pts.isEmpty()) {
            val out = if (started) listOf(emission("end")) else emptyList()
            reset()
            return out
        }
        return emptyList()
    }

    /** An ancestor stole the touch: end at the last values, exactly like the final lift. */
    fun cancel(): List<Emission> {
        val out = if (started) listOf(emission("end")) else emptyList()
        reset()
        return out
    }

    private fun reset() {
        engaged = false
        spanning = false
        started = false
        accumScale = 1.0
        scale = 1.0
        rotation = 0.0
        focusX = 0.0
        focusY = 0.0
        baseDistance = 0.0
        lastAngle = 0.0
        baseIds = null
        samples = mutableListOf()
    }

    private fun emission(phase: String) = Emission(
        phase, scale, rotation, focusX, focusY,
        StackGestures.velocity1D(samples.map { StackGestures.Sample1D(it.first, it.second) }),
        StackGestures.velocity1D(samples.map { StackGestures.Sample1D(it.first, it.third) }),
    )
}
