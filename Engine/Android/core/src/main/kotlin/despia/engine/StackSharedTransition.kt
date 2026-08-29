//
//  StackSharedTransition.kt - the shared-element (`shared=`) transition PURE CORE (:core, pure
//  JVM): the matching algorithm, the interpolation schedule and the interruption/reversal state
//  machine. The law is the corpus: OpenSource/Conformance/router/shared.json
//  (parity/U03-shared-transitions.md). Twin of the TS @despia-native/kernel shared-transition.ts and
//  the Swift Engine/iOS/StackSharedTransition.swift.
//
//  Everything platform-shaped lives OUTSIDE this file. Android places the pairs inside a shared
//  LookaheadScope and drives progress from the predictive-back callbacks; iOS flies snapshots
//  under UIViewControllerAnimatedTransitioning with a UIViewPropertyAnimator; web sets
//  `view-transition-name` where the View Transitions API exists and runs a WAAPI FLIP
//  otherwise. All three ask THIS file which ids pair, where a pair is at a given progress, and
//  what an interruption does - which is why one corpus can judge three renderers.
//
//  THE TWO LAWS THAT ARE EASY TO GET WRONG, both pinned here rather than per platform:
//    * an UNMATCHED id is not an error. It takes the ordinary frame transition, silently.
//    * an UNREALISED destination (a virtualised row, an image still loading) animates from the
//      SOURCE geometry to the SOURCE geometry and cross-fades. Animating to the zero rect a
//      not-yet-laid-out node reports is what makes the naive implementation look like the
//      image collapsing into nothing.
//
package despia.engine

import kotlin.math.abs
import kotlin.math.round

object StackSharedTransition {

    /** The three shared modes. `move` is the default; `crossfade` is what reduced motion and
     *  an unrealised destination downgrade to; `clip` is for text that changes size, where
     *  scaling the glyphs would distort them. */
    val MODES: List<String> = listOf("move", "crossfade", "clip")

    /** `move` keeps the source snapshot for the whole flight and fades the destination in over
     *  the final third. Pinned so the three renderers hand off at the same instant. */
    const val HANDOFF_START: Double = 2.0 / 3.0

    /** Accessibility focus moves to the DESTINATION frame at transition START, not end, so a
     *  screen-reader user is never narrating a moving snapshot. A constant, because the law has
     *  no parameters and no opt-out. */
    const val A11Y_FOCUS_TARGET: String = "destination"
    const val A11Y_FOCUS_AT: String = "start"

    data class Rect(val x: Double, val y: Double, val width: Double, val height: Double)

    /** One `shared=` element as the renderer measured it. `laid` is the renderer saying the node
     *  has been through a layout pass; null `order`/`mode`/`anim` mean the author did not
     *  declare them, which is what makes "the destination declares, the source is the fallback"
     *  expressible. */
    data class Element(
        val id: String,
        val frame: Rect,
        val radius: Double = 0.0,
        val opacity: Double = 1.0,
        val contentMode: String = "fill",
        val laid: Boolean = true,
        val order: Int? = null,
        val mode: String? = null,
        val anim: String? = null,
    )

    /** One end of a pair, fully resolved - no optionals left for a renderer to guess at. */
    data class Geometry(
        val x: Double, val y: Double, val width: Double, val height: Double,
        val radius: Double, val opacity: Double, val contentMode: String,
    )

    data class Pair(
        val id: String,
        val order: Int,
        val mode: String,
        /** the resolved curve word, or null to inherit whatever the frame transition uses */
        val anim: String?,
        /** true when the destination was not laid out: `to` copies `from`, mode is crossfade */
        val deferred: Boolean,
        val from: Geometry,
        val to: Geometry,
    )

    data class Match(
        val pairs: List<Pair>,
        /** ids the outgoing frame declared that nothing on the incoming frame answers */
        val unmatchedSource: List<String>,
        val unmatchedDestination: List<String>,
        /** ids declared more than once within ONE frame - a lint error at author time, resolved
         *  to the first occurrence here so the runtime is deterministic, not platform-dependent */
        val duplicates: List<String>,
    )

    internal fun round6(value: Double): Double = round(value * 1e6) / 1e6 + 0.0

    private fun geometry(element: Element): Geometry = Geometry(
        x = round6(element.frame.x),
        y = round6(element.frame.y),
        width = round6(element.frame.width),
        height = round6(element.frame.height),
        radius = round6(element.radius),
        opacity = round6(element.opacity),
        contentMode = element.contentMode,
    )

    /** Has the destination actually been laid out? An explicit `laid = false` says no; so does a
     *  zero width or height, which is what a virtualised row reports before it is measured. */
    private fun realised(element: Element): Boolean =
        element.laid && element.frame.width > 0.0 && element.frame.height > 0.0

    /** ONE inheritance rule for `sharedMode`, `sharedAnim` and `sharedOrder`: the arriving screen
     *  decides, the outgoing screen fills the gap, and the caller's floor is the last resort. */
    private fun <T> inherit(destination: T?, source: T?, floor: T?): T? = destination ?: source ?: floor

    private class Side(
        val first: LinkedHashMap<String, kotlin.Pair<Int, Element>>,
        val duplicates: List<String>,
        val order: List<String>,
    )

    /** First occurrence in document order wins; every id seen twice is reported. */
    private fun indexSide(elements: List<Element>): Side {
        val first = LinkedHashMap<String, kotlin.Pair<Int, Element>>()
        val duplicates = ArrayList<String>()
        val order = ArrayList<String>()
        elements.forEachIndexed { index, element ->
            if (first.containsKey(element.id)) {
                if (element.id !in duplicates) duplicates.add(element.id)
                return@forEachIndexed
            }
            first[element.id] = kotlin.Pair(index, element)
            order.add(element.id)
        }
        return Side(first, duplicates, order)
    }

    /**
     * Pair the `shared` ids across the outgoing and incoming frames.
     *
     * Collect the ids on each side (first occurrence wins), intersect, order by `sharedOrder`
     * then DESTINATION document order, and resolve each pair's mode/anim/geometry. Everything
     * outside the intersection takes the ordinary frame transition - reported, never thrown.
     */
    fun match(
        source: List<Element>,
        destination: List<Element>,
        reducedMotion: Boolean = false,
        frameAnim: String? = null,
    ): Match {
        val src = indexSide(source)
        val dst = indexSide(destination)

        val ordered = ArrayList<kotlin.Pair<Int, Pair>>()
        for (id in dst.order) {
            val sourceEntry = src.first[id] ?: continue
            val destinationEntry = dst.first.getValue(id)
            val deferred = !realised(destinationEntry.second)
            val from = geometry(sourceEntry.second)
            val to = if (deferred) from else geometry(destinationEntry.second)
            var mode = inherit(destinationEntry.second.mode, sourceEntry.second.mode, "move") ?: "move"
            if (mode !in MODES) mode = "move"
            if (deferred || reducedMotion) mode = "crossfade"
            ordered.add(
                kotlin.Pair(
                    destinationEntry.first,
                    Pair(
                        id = id,
                        order = inherit(destinationEntry.second.order, sourceEntry.second.order, 0) ?: 0,
                        mode = mode,
                        anim = inherit(destinationEntry.second.anim, sourceEntry.second.anim, frameAnim),
                        deferred = deferred,
                        from = from,
                        to = to,
                    ),
                )
            )
        }
        ordered.sortWith(compareBy({ it.second.order }, { it.first }))
        val pairs = ordered.map { it.second }
        val paired = pairs.map { it.id }.toHashSet()

        return Match(
            pairs = pairs,
            unmatchedSource = src.order.filter { it !in paired },
            unmatchedDestination = dst.order.filter { it !in paired },
            duplicates = (src.duplicates + dst.duplicates).distinct().sorted(),
        )
    }

    /** The pair's state at one instant. `sourceOpacity`/`destinationOpacity` are the two
     *  snapshots' weights INSIDE the flying layer; `alpha` is the layer's own opacity.
     *  `scaleContent = false` is `clip`: the frame animates, the content does not stretch. */
    data class Sample(
        val x: Double, val y: Double, val width: Double, val height: Double,
        val radius: Double, val alpha: Double,
        val sourceOpacity: Double, val destinationOpacity: Double,
        val contentMode: String, val scaleContent: Boolean,
    )

    internal fun clamp01(value: Double): Double = when {
        !(value > 0.0) -> 0.0     // also catches NaN
        value > 1.0 -> 1.0
        else -> value
    }

    private fun lerp(a: Double, b: Double, p: Double): Double = a + (b - a) * p

    /**
     * Where the pair is at [progress] (0 = fully at the source, 1 = fully at the destination).
     * Out-of-range progress clamps rather than overshooting - an interruption can hand this
     * function a value past either end while a spring is still settling.
     */
    fun sample(pair: Pair, progress: Double): Sample {
        val p = clamp01(progress)
        val from = pair.from
        val to = pair.to
        val sourceOpacity = if (pair.mode == "move") 1.0 else 1.0 - p
        val destinationOpacity = if (pair.mode == "move") clamp01((p - HANDOFF_START) * 3.0) else p
        return Sample(
            x = round6(lerp(from.x, to.x, p)),
            y = round6(lerp(from.y, to.y, p)),
            width = round6(lerp(from.width, to.width, p)),
            height = round6(lerp(from.height, to.height, p)),
            radius = round6(lerp(from.radius, to.radius, p)),
            alpha = round6(lerp(from.opacity, to.opacity, p)),
            sourceOpacity = round6(sourceOpacity),
            destinationOpacity = round6(destinationOpacity),
            // A discrete value cannot interpolate; it switches at the midpoint, where the
            // aspect mismatch between the two content modes is smallest.
            contentMode = if (p < 0.5) from.contentMode else to.contentMode,
            scaleContent = pair.mode != "clip",
        )
    }

    enum class State { IDLE, RUNNING, INTERACTIVE, SETTLED }
    enum class Direction { FORWARD, REVERSE }
    enum class Outcome { COMPLETED, REVERSED }

    data class Snapshot(
        val state: State,
        val direction: Direction,
        val progress: Double,
        val target: Double,
        /** the distance still to travel - a reversal costs what is LEFT, never a full replay */
        val remaining: Double,
        val outcome: Outcome?,
    )

    /** The corpus spells these lowercase; one place converts, so no caller invents a spelling. */
    fun word(state: State): String = state.name.lowercase()
    fun word(direction: Direction): String = direction.name.lowercase()
    fun word(outcome: Outcome?): String? = outcome?.name?.lowercase()
}

/**
 * The interruption/reversal state machine - the one thing that separates a real shared-element
 * implementation from a demo.
 *
 * `progress` is always measured toward the DESTINATION: 0 is the source frame, 1 the
 * destination, regardless of which way the transition is travelling. An interruption
 * ([interrupt]) adopts the transition AT ITS CURRENT PROGRESS and flips the direction; it never
 * restarts at 1 and never snaps to 0. The release then commits (target 0, the back-swipe won) or
 * cancels (target 1, the push resumes), and the settle travels only `remaining`.
 *
 * Platform mapping: Android drives this from the predictive-back progress callbacks against the
 * same Animatable the router pose already uses; iOS from a UIPercentDrivenInteractiveTransition
 * against a UIViewPropertyAnimator (a UIView.animate block cannot be reversed mid-flight, which
 * is exactly how an implementation ends up snapping); web from the pointer stream against a
 * paused WAAPI animation, whose currentTime is settable.
 */
class SharedTransitionMachine {

    var state: StackSharedTransition.State = StackSharedTransition.State.IDLE
        private set
    var direction: StackSharedTransition.Direction = StackSharedTransition.Direction.FORWARD
        private set
    var progress: Double = 0.0
        private set
    var target: Double = 1.0
        private set
    var outcome: StackSharedTransition.Outcome? = null
        private set

    /** true once a gesture has taken this transition over - the renderer must keep its animator
     *  interruptible for the rest of the flight rather than restoring a fire-and-forget curve */
    var interrupted: Boolean = false
        private set

    fun snapshot(): StackSharedTransition.Snapshot = StackSharedTransition.Snapshot(
        state = state,
        direction = direction,
        progress = StackSharedTransition.round6(progress),
        target = StackSharedTransition.round6(target),
        remaining = StackSharedTransition.round6(abs(target - progress)),
        outcome = outcome,
    )

    /** Start a push (FORWARD, from the source) or a pop (REVERSE, from the destination). */
    fun begin(direction: StackSharedTransition.Direction): StackSharedTransition.Snapshot {
        state = StackSharedTransition.State.RUNNING
        this.direction = direction
        progress = if (direction == StackSharedTransition.Direction.FORWARD) 0.0 else 1.0
        target = if (direction == StackSharedTransition.Direction.FORWARD) 1.0 else 0.0
        outcome = null
        interrupted = false
        return snapshot()
    }

    /** The animator reporting where it is. Ignored while a gesture owns the transition. */
    fun tick(progress: Double): StackSharedTransition.Snapshot {
        if (state == StackSharedTransition.State.RUNNING) {
            this.progress = StackSharedTransition.clamp01(progress)
        }
        return snapshot()
    }

    /** A gesture takes the transition over at [progress]. A settled transition is NOT resurrected. */
    fun interrupt(progress: Double): StackSharedTransition.Snapshot {
        if (state == StackSharedTransition.State.RUNNING || state == StackSharedTransition.State.INTERACTIVE) {
            state = StackSharedTransition.State.INTERACTIVE
            direction = StackSharedTransition.Direction.REVERSE
            this.progress = StackSharedTransition.clamp01(progress)
            target = 0.0
            interrupted = true
        }
        return snapshot()
    }

    /** The finger moving, as an ABSOLUTE progress (the renderer owns the pixels-to-progress map). */
    fun drag(progress: Double): StackSharedTransition.Snapshot {
        if (state == StackSharedTransition.State.INTERACTIVE) {
            this.progress = StackSharedTransition.clamp01(progress)
        }
        return snapshot()
    }

    /** The finger lifting: commit the reversal, or cancel it and resume forward. */
    fun release(commit: Boolean): StackSharedTransition.Snapshot {
        if (state == StackSharedTransition.State.INTERACTIVE) {
            direction = if (commit) StackSharedTransition.Direction.REVERSE
                        else StackSharedTransition.Direction.FORWARD
            target = if (commit) 0.0 else 1.0
            state = StackSharedTransition.State.RUNNING
        }
        return snapshot()
    }

    /** The animator reached its target. */
    fun settle(): StackSharedTransition.Snapshot {
        if (state == StackSharedTransition.State.RUNNING) {
            progress = target
            state = StackSharedTransition.State.SETTLED
            outcome = if (target == 0.0) StackSharedTransition.Outcome.REVERSED
                      else StackSharedTransition.Outcome.COMPLETED
        }
        return snapshot()
    }
}
