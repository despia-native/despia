package despia.engine

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * ScrollLinked.kt — the `<scroll>` observation plane and the scroll-linked style substrate,
 * Kotlin twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/scroll/README.md; the cases live in
 * that folder's seven .json files and run against THIS file (:core ScrollLinkedConformanceTest),
 * against the TS twin (packages/kernel/src/scroll.ts) and against the Swift twin
 * (OpenSource/Engine/iOS/ScrollLinked.swift).
 *
 * Everything here is pure: geometry in, values out. The surface work — the NestedScrollConnection,
 * the LazyListState, writing resolved values into the composition, and the `ref` registry behind
 * `dsx.scroll(name)` — belongs to :render. Keeping the decision separate from the plumbing is what
 * lets one corpus judge three runtimes, and is why this lives in :core and runs without an
 * Android SDK.
 *
 * THE SPLIT THIS FILE EXISTS FOR. `on:scroll` is for LOGIC and is coalesced to the display link;
 * `--scroll-*` is for STYLE and is a pure function of one sample, so a renderer resolves it inside
 * its own frame callback and nothing crosses the bus.
 */

/** The RAW offset keeps its sign: rubber-band over-scroll is real, and CollapsingHeader's
 *  `stretch` is built on reading it. `progress` comes from the CLAMPED offset. */
data class ScrollMetrics(
    val x: Double,
    val y: Double,
    val maxX: Double,
    val maxY: Double,
    val progress: Double,
    val progressX: Double,
    val atTop: Boolean,
    val atBottom: Boolean,
    val atStart: Boolean,
    val atEnd: Boolean,
)

data class ScrollSample(val x: Double, val y: Double, val t: Double)

data class ScrollMotionState(
    val dx: Double,
    val dy: Double,
    val velocityX: Double,
    val velocityY: Double,
    /** Signed along the axis [direction] names, so the two are one coherent statement. */
    val velocity: Double,
    val direction: String,
)

data class ScrollCoalesceResult(val dispatches: Int, val at: List<Double>)

data class ScrollReachEndState(val fire: Boolean, val latched: Boolean, val remaining: Double)

data class ScrollChildFrame(val start: Double, val length: Double)

data class ScrollTarget(val x: Double, val y: Double, val animated: Boolean)

data class ScrollMaintainResult(val offset: Double, val delta: Double)

data class ScrollLinkedAncestor(val axis: String, val properties: Map<String, String>)

/** One named scroller's contribution to the root scope. */
data class NamedScrollPlane(val ref: String, val properties: Map<String, String>)

data class ScrollEdgeInsets(val top: Double, val right: Double, val bottom: Double, val left: Double)

data class ScrollConfig(
    val axis: String,
    val bind: String?,
    val indicators: Boolean,
    /** TRISTATE. null is not `true`: it means the PLATFORM decides, and collapsing that to a
     *  boolean is how a framework ends up overriding the platform's own bounce everywhere. */
    val bounces: Boolean?,
    val paging: Boolean,
    val snap: String,
    val keyboardDismiss: String,
    val overscroll: String,
    val contentInset: ScrollEdgeInsets,
    val maintainPosition: Boolean,
    val threshold: Double,
)

data class CollapseState(
    val fraction: Double,
    val headerHeight: Double,
    val effectiveMinHeight: Double,
    val imageTranslation: Double,
    val imageScale: Double,
    val effectiveParallax: Double,
    val headerTitleOpacity: Double,
    val navBarTitleOpacity: Double,
    val titleOwner: String,
    val blurRadius: Double,
    val pinnedOffset: Double,
)

object ScrollCore {

    /** Sub-pixel tolerance, in points. Momentum deceleration lands a fraction of a point short of
     *  the rail; a strict comparison makes `atBottom` flicker false at rest, which is how an
     *  infinite-scroll trigger misses. The same tolerance gives `direction` its stickiness. */
    const val EPSILON: Double = 0.5

    /** One display-link tick at 60 Hz: the default coalescing budget for `on:scroll`. */
    const val FRAME_BUDGET_MS: Double = 16.0

    /** How long without movement counts as settled, where there is no platform deceleration
     *  callback. Android has `isScrollInProgress`; this is the shared fallback number. */
    const val SETTLE_MS: Double = 120.0

    /** Above this speed a snap follows the direction of travel instead of the nearest candidate.
     *  It is what makes a 10% flick turn a page. Points per second. */
    const val FLING_VELOCITY: Double = 500.0

    /** `on:collapse` quantum: a hundredth of the collapse range. */
    const val COLLAPSE_EPSILON: Double = 0.01

    /** Where `titleTransition="move"` hands the title to the nav bar. The header title's opacity
     *  reaches 0 exactly here and the nav bar's leaves 0 exactly here, so the two are never both
     *  visible and the title is ONE accessibility element at every fraction. */
    const val TITLE_HANDOFF_FRACTION: Double = 0.75

    const val BLUR_MAX: Double = 20.0

    /** The default scrim: a bottom-anchored gradient from transparent at 60% of the height to 60%
     *  black at the bottom edge. It exists by default because a white title over a light photo is
     *  unreadable, and every app that ships this without one ships that bug. */
    const val SCRIM_START: Double = 0.6
    const val SCRIM_ALPHA: Double = 0.6

    /** The default `minHeight` when the author names none (M3 small top app bar). */
    const val NAV_BAR_HEIGHT: Double = 56.0

    private val CALC_UNITS = listOf("rem", "deg", "ms", "em", "px", "pt", "vh", "vw", "%", "s")
    private const val VAR_DEPTH_BUDGET = 8

    // ------------------------------------------------------------------ numbers

    /** A number that survived a platform report. Nonsense reads as the origin rather than
     *  poisoning every value derived from it: one NaN offset otherwise becomes a NaN CSS length,
     *  and a dropped declaration is a silent layout hole. */
    fun finite(value: Any?): Double {
        val d = when (value) {
            null -> 0.0
            is Number -> value.toDouble()
            is String -> value.trim().toDoubleOrNull() ?: 0.0
            else -> 0.0
        }
        return if (d.isFinite()) d else 0.0
    }

    /** Round half AWAY FROM ZERO to four decimals. Away-from-zero rather than half-to-even because
     *  three languages must agree, and only this rule is spelled the same in all three. */
    fun round4(value: Any?): Double {
        val v = finite(value)
        val sign = if (v < 0) -1.0 else 1.0
        return sign * floor(abs(v) * 10000.0 + 0.5) / 10000.0
    }

    /** The published spelling of a number. Part of the contract: the corpus compares strings, so
     *  three languages must format identically. No exponent, no trailing zeros, no negative zero. */
    fun formatNumber(value: Any?): String {
        val r = round4(value)
        if (r == 0.0) return "0"
        var s = String.format(Locale.ROOT, "%.4f", r)
        if (s.contains('.')) s = s.trimEnd('0').trimEnd('.')
        return s
    }

    private fun clamp(v: Double, lo: Double, hi: Double): Double = if (v < lo) lo else if (v > hi) hi else v

    // ------------------------------------------------------------------ metrics

    /**
     * The offset math every other function here builds on.
     *
     * The degenerate case is pinned on purpose: content no taller than the viewport is at BOTH
     * ends (a page with nothing to scroll IS at each of them, and that is what makes `on:reachEnd`
     * fire once for a short list) and reports progress 0, never 1 — a non-scrollable plane must
     * publish the RESTING state, because a header that boots into its collapsed look on a short
     * page is the visible bug.
     */
    fun metrics(
        x: Any?,
        y: Any?,
        viewportWidth: Any?,
        viewportHeight: Any?,
        contentWidth: Any?,
        contentHeight: Any?,
    ): ScrollMetrics {
        val ox = finite(x)
        val oy = finite(y)
        val maxX = maxOf(0.0, finite(contentWidth) - finite(viewportWidth))
        val maxY = maxOf(0.0, finite(contentHeight) - finite(viewportHeight))
        return ScrollMetrics(
            x = round4(ox),
            y = round4(oy),
            maxX = round4(maxX),
            maxY = round4(maxY),
            progress = round4(if (maxY <= 0.0) 0.0 else clamp(oy, 0.0, maxY) / maxY),
            progressX = round4(if (maxX <= 0.0) 0.0 else clamp(ox, 0.0, maxX) / maxX),
            atTop = oy <= EPSILON,
            atBottom = oy >= maxY - EPSILON,
            atStart = ox <= EPSILON,
            atEnd = ox >= maxX - EPSILON,
        )
    }

    // ------------------------------------------------------------------ motion

    /**
     * Motion from a SAMPLE PAIR, never from an accumulated delta.
     *
     * `direction` is STICKY below the tolerance. A one-pixel jitter that flips the word every frame
     * is exactly the shrinking-header flicker, so a sub-tolerance sample keeps the previous word
     * rather than inventing "none"; "none" is only ever the state before the first real movement.
     * A non-monotonic or backwards clock yields velocity 0 rather than an infinity.
     */
    fun motion(previous: ScrollSample, next: ScrollSample, previousDirection: String?): ScrollMotionState {
        val dx = next.x - previous.x
        val dy = next.y - previous.y
        val dt = next.t - previous.t
        val velocityX = if (dt > 0) dx * 1000.0 / dt else 0.0
        val velocityY = if (dt > 0) dy * 1000.0 / dt else 0.0
        // An exact tie prefers the vertical axis: it is the default axis of a <scroll>.
        val vertical = abs(dy) >= abs(dx)
        val delta = if (vertical) dy else dx
        val direction = when {
            abs(delta) <= EPSILON -> previousDirection ?: "none"
            vertical -> if (delta > 0) "down" else "up"
            else -> if (delta > 0) "right" else "left"
        }
        return ScrollMotionState(
            dx = round4(dx),
            dy = round4(dy),
            velocityX = round4(velocityX),
            velocityY = round4(velocityY),
            velocity = round4(if (vertical) velocityY else velocityX),
            direction = direction,
        )
    }

    // ------------------------------------------------------------------ coalescing

    /**
     * The performance contract, as one predicate.
     *
     * With no handler bound the answer is FALSE, not "cheap": a scroll nobody is listening to costs
     * nothing at all. Otherwise at most one dispatch per display-link tick, and the first sample of
     * a gesture always dispatches so a handler sees the start.
     */
    fun shouldDispatch(
        hasHandler: Boolean,
        lastDispatchAt: Double?,
        now: Double,
        frameBudgetMs: Double = FRAME_BUDGET_MS,
    ): Boolean {
        if (!hasHandler) return false
        if (lastDispatchAt == null) return true
        return finite(now) - finite(lastDispatchAt) >= finite(frameBudgetMs)
    }

    /** Run a whole sample train through the policy. The corpus asserts the COUNT over a fixed
     *  train, so a coalescing regression is caught rather than felt. */
    fun coalesce(
        samples: List<Any?>,
        hasHandler: Boolean,
        frameBudgetMs: Double = FRAME_BUDGET_MS,
    ): ScrollCoalesceResult {
        if (!hasHandler) return ScrollCoalesceResult(0, emptyList())
        val at = mutableListOf<Double>()
        var last: Double? = null
        for (raw in samples) {
            val t = finite(raw)
            if (shouldDispatch(true, last, t, frameBudgetMs)) {
                at.add(round4(t))
                last = t
            }
        }
        return ScrollCoalesceResult(at.size, at)
    }

    // ------------------------------------------------------------------ reachEnd

    /**
     * `on:reachEnd`, EDGE-TRIGGERED. It fires on the sample that crosses the threshold, not on
     * every frame spent at the bottom; the latch releases when the user scrolls back out. Without
     * the latch a "load more" handler is called sixty times a second at the rail, which is the
     * classic duplicate-page bug.
     */
    fun reachEnd(latched: Boolean, m: ScrollMetrics, threshold: Any?, axis: String): ScrollReachEndState {
        val remaining = if (axis == "horizontal") {
            m.maxX - clamp(m.x, 0.0, m.maxX)
        } else {
            m.maxY - clamp(m.y, 0.0, m.maxY)
        }
        val crossed = remaining <= finite(threshold) + EPSILON
        return ScrollReachEndState(fire = crossed && !latched, latched = crossed, remaining = round4(remaining))
    }

    // ------------------------------------------------------------------ imperative

    /**
     * `dsx.scroll(ref).to/.toTop/.toBottom/.toElement`, reduced to one offset.
     *
     * Three rules. An imperative call NEVER over-scrolls, so every target clamps into 0..max.
     * `toTop`/`toBottom` name the PRIMARY AXIS rather than the vertical one, so the familiar words
     * keep working on a horizontal rail. `align="nearest"` is the only alignment allowed to decide
     * not to move, which is what makes `toElement` safe to call on every selection change.
     *
     * An unrealised row in a virtualised list returns null rather than guessing at an offset it
     * cannot know; a virtualiser carrying an estimate passes the estimated frame and gets a real
     * answer, then re-resolves once the row is realised.
     */
    fun resolveCommand(
        kind: String,
        m: ScrollMetrics,
        viewportWidth: Any?,
        viewportHeight: Any?,
        axis: String,
        animated: Boolean = true,
        toX: Double? = null,
        toY: Double? = null,
        child: ScrollChildFrame? = null,
        align: String = "nearest",
    ): ScrollTarget? {
        val horizontal = axis == "horizontal"
        val offset = if (horizontal) m.x else m.y
        val limit = if (horizontal) m.maxX else m.maxY
        val view = finite(if (horizontal) viewportWidth else viewportHeight)

        if (kind == "to") {
            return ScrollTarget(
                x = round4(if (toX == null) m.x else clamp(finite(toX), 0.0, m.maxX)),
                y = round4(if (toY == null) m.y else clamp(finite(toY), 0.0, m.maxY)),
                animated = animated,
            )
        }

        var target: Double
        when (kind) {
            "toTop" -> target = 0.0
            "toBottom" -> target = limit
            "toElement" -> {
                if (child == null) return null
                val start = child.start
                val length = child.length
                target = when {
                    align == "start" -> start
                    align == "center" -> start + length / 2.0 - view / 2.0
                    align == "end" -> start + length - view
                    start >= offset && start + length <= offset + view -> offset
                    start < offset -> start
                    else -> start + length - view
                }
            }
            else -> return null
        }
        target = clamp(target, 0.0, limit)
        return ScrollTarget(
            x = round4(if (horizontal) target else m.x),
            y = round4(if (horizontal) m.y else target),
            animated = animated,
        )
    }

    // ------------------------------------------------------------------ snap

    private fun roundHalfUp(v: Double): Double = if (v >= 0) floor(v + 0.5) else -floor(-v + 0.5)

    /**
     * The snap target, or null when the container proposes none.
     *
     * `paging` is "page" (the viewport is the stride); "start"/"center"/"end" snap to CHILD
     * BOUNDARIES, which is why real child frames are the input and a fixed stride is not — a rail
     * of variable-width cards is the common case. At rest the nearest candidate wins and an exact
     * tie takes the SMALLER offset, because a tie that advances is a snap that fights the finger.
     * Past the fling threshold the target is the next candidate in the direction of travel.
     */
    fun resolveSnap(
        mode: String,
        offset: Any?,
        viewportLength: Any?,
        contentLength: Any?,
        children: List<ScrollChildFrame>,
        velocity: Any?,
    ): Double? {
        val view = finite(viewportLength)
        val limit = maxOf(0.0, finite(contentLength) - view)
        val at = finite(offset)
        val v = finite(velocity)
        if (mode == "none" || limit <= 0.0) return null

        if (mode == "page") {
            if (view <= 0.0) return null
            val index = floor(at / view)
            val fraction = at / view - index
            val target = when {
                v >= FLING_VELOCITY -> (index + 1) * view
                v <= -FLING_VELOCITY -> if (fraction > 0) index * view else (index - 1) * view
                else -> roundHalfUp(at / view) * view
            }
            return round4(clamp(target, 0.0, limit))
        }

        val candidates = children.map { child ->
            val raw = when (mode) {
                "start" -> child.start
                "center" -> child.start + child.length / 2.0 - view / 2.0
                else -> child.start + child.length - view
            }
            clamp(raw, 0.0, limit)
        }
        if (candidates.isEmpty()) return null

        if (v >= FLING_VELOCITY) {
            val ahead = candidates.filter { it > at + EPSILON }
            if (ahead.isNotEmpty()) return round4(ahead.reduce { a, b -> if (a < b) a else b })
        } else if (v <= -FLING_VELOCITY) {
            val behind = candidates.filter { it < at - EPSILON }
            if (behind.isNotEmpty()) return round4(behind.reduce { a, b -> if (a > b) a else b })
        }

        var best = candidates[0]
        for (c in candidates) {
            val d = abs(c - at)
            val bd = abs(best - at)
            if (d < bd || (d == bd && c < best)) best = c
        }
        return round4(best)
    }

    // ------------------------------------------------------------------ maintainPosition

    /**
     * Keep the visual position across a content mutation.
     *
     * THE INPUT IS AN ANCHOR, not a content-height delta, and that is the whole design. A content
     * height diff cannot tell a prepend from an append, so compensating on it makes an appending
     * chat jump exactly as badly as a prepending one failed to. The anchor is a previously visible
     * child's frame origin before and after the mutation; prepend, append and removal-above then
     * all fall out of ONE formula, and the append case correctly compensates by zero.
     */
    fun maintainPosition(
        offset: Any?,
        anchorBefore: Any?,
        anchorAfter: Any?,
        viewportLength: Any?,
        contentLength: Any?,
    ): ScrollMaintainResult {
        val limit = maxOf(0.0, finite(contentLength) - finite(viewportLength))
        val delta = finite(anchorAfter) - finite(anchorBefore)
        return ScrollMaintainResult(offset = round4(clamp(finite(offset) + delta, 0.0, limit)), delta = round4(delta))
    }

    // ------------------------------------------------------------------ linked properties

    /** The prefix every published key carries. A named plane is spelled by inserting the ref right
     *  after it, so the two families are one family with one namespace. */
    private const val SCROLL_PREFIX = "--scroll-"

    /**
     * The unqualified keys the two axis planes own. A named scroller may never publish one of them:
     * `ref="progress"` would otherwise spell `--scroll-progress-x` and shadow the horizontal plane
     * of whatever page it sits on. The reserved key wins and the named twin is simply not
     * published, which keeps the collision a naming inconvenience rather than action at a distance.
     */
    val RESERVED_SCROLL_KEYS: Set<String> = setOf(
        "--scroll-y", "--scroll-y-px", "--scroll-progress", "--scroll-velocity",
        "--scroll-remaining", "--scroll-remaining-px",
        "--scroll-x", "--scroll-x-px", "--scroll-progress-x", "--scroll-velocity-x",
        "--scroll-remaining-x", "--scroll-remaining-x-px",
    )

    /** Points still to travel on an axis, from the CLAMPED offset so rubber-band over-scroll cannot
     *  push it past either end. `--scroll-y` measures from the top and this measures from the
     *  bottom; without it a bottom-anchored effect can only be written in `progress`, which is a
     *  fraction of the content and therefore a different distance on every list. */
    private fun remainingOf(offset: Double, max: Double): Double =
        finite(max) - clamp(finite(offset), 0.0, finite(max))

    /**
     * The plane one scroll node publishes. A node contributes ONLY the plane of its own axis, so a
     * horizontal rail inside a vertical page owns `--scroll-x*` and leaves `--scroll-y*` to the
     * page.
     *
     * Two spellings per length, and this is a CORRECTION to the U01 plan: `--scroll-y` is unitless
     * points so `calc(1 - var(--scroll-y) / 280)` types as a number, and `--scroll-y-px` carries
     * px so `translateY(calc(var(--scroll-y-px) * 0.5))` types as a length. A single property
     * cannot be both, and the plan's example is rejected by every engine, ours and a browser's.
     */
    fun linkedProperties(axis: String, m: ScrollMetrics, velocity: Any?): Map<String, String> {
        if (axis == "horizontal") {
            val remaining = remainingOf(m.x, m.maxX)
            return linkedMapOf(
                "--scroll-x" to formatNumber(m.x),
                "--scroll-x-px" to formatNumber(m.x) + "px",
                "--scroll-progress-x" to formatNumber(m.progressX),
                "--scroll-velocity-x" to formatNumber(velocity),
                "--scroll-remaining-x" to formatNumber(remaining),
                "--scroll-remaining-x-px" to formatNumber(remaining) + "px",
            )
        }
        val remaining = remainingOf(m.y, m.maxY)
        return linkedMapOf(
            "--scroll-y" to formatNumber(m.y),
            "--scroll-y-px" to formatNumber(m.y) + "px",
            "--scroll-progress" to formatNumber(m.progress),
            "--scroll-velocity" to formatNumber(velocity),
            "--scroll-remaining" to formatNumber(remaining),
            "--scroll-remaining-px" to formatNumber(remaining) + "px",
        )
    }

    /**
     * Whether a `ref` can name a plane. The ref registry treats a name as opaque, but a published
     * key is a CSS custom property, and a name carrying a space or a dot does not spell one - so
     * it publishes NOTHING rather than an unreachable key or, worse, a truncated one that another
     * ref could also spell. The imperative surface behind the same ref is unaffected.
     */
    fun isScrollPlaneRef(ref: String): Boolean {
        if (ref.isEmpty()) return false
        for (c in ref) {
            val ok = (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || c == '-' || c == '_'
            if (!ok) return false
        }
        return true
    }

    /**
     * The same plane, published under the node's `ref` and scoped to the DOCUMENT ROOT rather than
     * to the node's descendants.
     *
     * THE CASE THE CASCADE CANNOT SERVE (R27). Pinned chrome - fade edges, a floating back-to-top,
     * a progress rail - sits OVER a scroller and is by definition not inside it, so no cascade can
     * ever reach it; and every way to make it a descendant makes it scroll away. Naming the
     * scroller is the web's own answer to the same problem (`scroll-timeline` + `timeline-scope`
     * name a scroller precisely so something outside its subtree can read it), and it needs no new
     * value grammar here: the key is an ordinary custom property and `var()` already reads it.
     */
    fun namedLinkedProperties(
        ref: String,
        axis: String,
        m: ScrollMetrics,
        velocity: Any?,
    ): Map<String, String> {
        if (!isScrollPlaneRef(ref)) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for ((key, value) in linkedProperties(axis, m, velocity)) {
            val named = SCROLL_PREFIX + ref + "-" + key.substring(SCROLL_PREFIX.length)
            if (named in RESERVED_SCROLL_KEYS) continue
            out[named] = value
        }
        return out
    }

    /**
     * Resolve the properties in scope for an element, from its scroll ancestors NEAREST FIRST, plus
     * every named plane in the document.
     *
     * Each axis resolves independently from its own nearest ancestor, which is what an author
     * expects of a horizontal rail inside a vertical page. An axis with no ancestor contributes
     * NOTHING rather than zero, so `var(--scroll-y, 0)` can tell "no scroller" from "at the top".
     *
     * Named planes are document-wide and apply to every element, ancestor or not. They are merged
     * in document order so a duplicated ref resolves to its LAST provider, which is the ref
     * registry's own law (`Conformance/input/ref.json`) rather than a second opinion about it. A
     * reserved key is dropped here as well as at publication, so a hand-built plane cannot shadow
     * an axis either.
     */
    fun resolveLinkedScope(
        ancestors: List<ScrollLinkedAncestor>,
        named: List<NamedScrollPlane> = emptyList(),
    ): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (plane in named) {
            for ((key, value) in plane.properties) {
                if (key in RESERVED_SCROLL_KEYS) continue
                out[key] = value
            }
        }
        var vertical = false
        var horizontal = false
        for (ancestor in ancestors) {
            if (ancestor.axis == "vertical" && !vertical) {
                out.putAll(ancestor.properties)
                vertical = true
            } else if (ancestor.axis == "horizontal" && !horizontal) {
                out.putAll(ancestor.properties)
                horizontal = true
            }
        }
        return out
    }

    // ------------------------------------------------------------------ var()/calc()

    private data class Dimension(val value: Double, val unit: String)

    /**
     * The native twin of what a browser does for free: substitute `var()`, then fold every `calc()`
     * with CSS's own unit algebra. Anything it cannot type DROPS the declaration (returns null),
     * which is what CSS itself does for a value that is invalid at computed value, and what
     * CssValue already does for a cyclic var() chain.
     */
    fun evaluateLinked(expression: String, properties: Map<String, String>): String? {
        val substituted = substituteVars(expression, properties, 0) ?: return null
        val out = StringBuilder()
        var i = 0
        while (true) {
            val at = nextMathFunction(substituted, i)
            if (at == null) {
                out.append(substituted.substring(i))
                return out.toString()
            }
            out.append(substituted, i, at.first)
            val close = matchParen(substituted, at.second + 1)
            if (close < 0) return null
            val folded = foldCalc(substituted.substring(at.first, close + 1)) ?: return null
            out.append(formatNumber(folded.value)).append(folded.unit)
            i = close + 1
        }
    }

    /** The four CSS math functions this evaluator folds, longest first so `calc` cannot shadow one. */
    private val MATH_FUNCTIONS = listOf("clamp(", "calc(", "min(", "max(")

    /**
     * The next math function at or after [from] as (name start, `(` index), ignoring one that is
     * only the tail of a longer identifier (`admin(` is not `min(`).
     */
    private fun nextMathFunction(source: String, from: Int): Pair<Int, Int>? {
        val lower = source.lowercase()
        var best: Pair<Int, Int>? = null
        for (name in MATH_FUNCTIONS) {
            var at = lower.indexOf(name, from)
            while (at >= 0) {
                val before = if (at > 0) lower[at - 1] else ' '
                val glued = before.isLetterOrDigit() || before == '-' || before == '_'
                if (!glued) {
                    if (best == null || at < best.first) best = Pair(at, at + name.length - 1)
                    break
                }
                at = lower.indexOf(name, at + 1)
            }
        }
        return best
    }

    /** Index of the `)` closing a `(` whose CONTENT starts at [from], or -1. */
    private fun matchParen(source: String, from: Int): Int {
        var depth = 1
        var i = from
        while (i < source.length) {
            if (source[i] == '(') depth += 1
            else if (source[i] == ')') {
                depth -= 1
                if (depth == 0) return i
            }
            i += 1
        }
        return -1
    }

    private fun substituteVars(source: String, properties: Map<String, String>, depth: Int): String? {
        if (!source.contains("var(")) return source
        // A cyclic definition rotates forever; the budget terminates it exactly as CssValue does.
        if (depth > VAR_DEPTH_BUDGET) return null
        val out = StringBuilder()
        var i = 0
        while (true) {
            val at = source.indexOf("var(", i)
            if (at < 0) {
                out.append(source.substring(i))
                break
            }
            out.append(source, i, at)
            val close = matchParen(source, at + 4)
            if (close < 0) return null
            val inner = source.substring(at + 4, close)
            val comma = splitTopLevel(inner, ',')
            val name = comma[0].trim()
            val fallback = if (comma.size > 1) comma.drop(1).joinToString(",").trim() else null
            val resolved = properties[name]
            when {
                resolved != null -> out.append(resolved)
                fallback != null -> out.append(fallback)
                else -> return null
            }
            i = close + 1
        }
        return substituteVars(out.toString(), properties, depth + 1)
    }

    private fun splitTopLevel(source: String, separator: Char): List<String> {
        val parts = mutableListOf<String>()
        var depth = 0
        val current = StringBuilder()
        for (ch in source) {
            if (ch == '(') depth += 1
            else if (ch == ')') depth -= 1
            if (ch == separator && depth == 0) {
                parts.add(current.toString())
                current.setLength(0)
            } else {
                current.append(ch)
            }
        }
        parts.add(current.toString())
        return parts
    }

    private sealed class CalcToken {
        data class Op(val ch: Char) : CalcToken()
        data class Num(val value: Double, val unit: String) : CalcToken()
    }

    private fun tokenizeCalc(source: String): List<CalcToken>? {
        val tokens = mutableListOf<CalcToken>()
        var i = 0
        while (i < source.length) {
            val ch = source[i]
            if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
                i += 1
                continue
            }
            if (ch == '(' || ch == ')' || ch == '+' || ch == '-' || ch == '*' || ch == '/' ||
                ch == ','
            ) {
                tokens.add(CalcToken.Op(ch))
                i += 1
                continue
            }
            if (ch.isDigit() || ch == '.') {
                var j = i
                while (j < source.length && (source[j].isDigit() || source[j] == '.')) j += 1
                val value = source.substring(i, j).toDoubleOrNull() ?: return null
                if (!value.isFinite()) return null
                var unit = ""
                for (candidate in CALC_UNITS) {
                    val end = j + candidate.length
                    if (end <= source.length && source.substring(j, end).lowercase() == candidate) {
                        unit = candidate
                        j = end
                        break
                    }
                }
                tokens.add(CalcToken.Num(value, unit))
                i = j
                continue
            }
            if (i + 5 <= source.length && source.substring(i, i + 5).lowercase() == "calc(") {
                tokens.add(CalcToken.Op('('))
                i += 5
                continue
            }
            // `m` / `x` / `c` are the heads of min() / max() / clamp(); each keeps its own `(`, so
            // the parser reads a function the way it reads a group plus an arity.
            if (i + 4 <= source.length && source.substring(i, i + 4).lowercase() == "min(") {
                tokens.add(CalcToken.Op('m'))
                tokens.add(CalcToken.Op('('))
                i += 4
                continue
            }
            if (i + 4 <= source.length && source.substring(i, i + 4).lowercase() == "max(") {
                tokens.add(CalcToken.Op('x'))
                tokens.add(CalcToken.Op('('))
                i += 4
                continue
            }
            if (i + 6 <= source.length && source.substring(i, i + 6).lowercase() == "clamp(") {
                tokens.add(CalcToken.Op('c'))
                tokens.add(CalcToken.Op('('))
                i += 6
                continue
            }
            return null
        }
        return tokens
    }

    /**
     * Fold one calc() body. CSS's unit algebra and nothing beyond it: `+`/`-` need matching units
     * (zero being the one unitless length), at most one operand of a product may carry a unit, and
     * a divisor must be a non-zero number. Every refusal returns null so the caller drops the whole
     * declaration rather than shipping a half-typed value.
     *
     * A class rather than nested local functions because the three levels are mutually recursive
     * (a parenthesised group re-enters the sum), which Kotlin cannot express with local `fun`s.
     */
    private class CalcParser(private val tokens: List<CalcToken>) {
        private var pos = 0

        fun parse(): Dimension? {
            val result = sum() ?: return null
            if (pos != tokens.size) return null
            return result
        }

        private fun peek(): Char? {
            if (pos >= tokens.size) return null
            val token = tokens[pos]
            return if (token is CalcToken.Op) token.ch else 'n'
        }

        private fun primary(): Dimension? {
            when (peek()) {
                '(' -> {
                    pos += 1
                    val inner = sum() ?: return null
                    if (peek() != ')') return null
                    pos += 1
                    return inner
                }
                '-' -> {
                    pos += 1
                    val inner = primary() ?: return null
                    return Dimension(-inner.value, inner.unit)
                }
                '+' -> {
                    pos += 1
                    return primary()
                }
                'm', 'x', 'c' -> {
                    val fn = peek()!!
                    pos += 1
                    if (peek() != '(') return null
                    pos += 1
                    val args = mutableListOf<Dimension>()
                    while (true) {
                        args.add(sum() ?: return null)
                        if (peek() != ',') break
                        pos += 1
                    }
                    if (peek() != ')') return null
                    pos += 1
                    return compare(fn, args)
                }
                'n' -> {
                    val token = tokens[pos] as CalcToken.Num
                    pos += 1
                    return Dimension(token.value, token.unit)
                }
                else -> return null
            }
        }

        /**
         * `min()` / `max()` / `clamp()`. CSS compares LIKE with LIKE, so every argument must carry
         * the same unit - a bound is meaningless between a length and a ratio - and `clamp()` is
         * exactly three arguments, folded as `max(low, min(value, high))`, which is CSS's own
         * definition and is what makes an inverted pair resolve to the low bound rather than to
         * nothing.
         */
        private fun compare(fn: Char, args: List<Dimension>): Dimension? {
            if (args.isEmpty()) return null
            val unit = args[0].unit
            for (arg in args) if (arg.unit != unit) return null
            if (fn == 'c') {
                if (args.size != 3) return null
                val value = min(args[1].value, args[2].value)
                return Dimension(max(args[0].value, value), unit)
            }
            var out = args[0].value
            for (arg in args) out = if (fn == 'm') min(out, arg.value) else max(out, arg.value)
            return Dimension(out, unit)
        }

        private fun product(): Dimension? {
            var left = primary() ?: return null
            while (true) {
                val op = peek()
                if (op != '*' && op != '/') return left
                pos += 1
                val right = primary() ?: return null
                left = if (op == '*') {
                    // CSS has no square pixels.
                    if (left.unit.isNotEmpty() && right.unit.isNotEmpty()) return null
                    Dimension(
                        left.value * right.value,
                        if (left.unit.isNotEmpty()) left.unit else right.unit,
                    )
                } else {
                    // Division BY a dimension is not a CSS operation, and an infinity in a
                    // declaration is a dropped declaration.
                    if (right.unit.isNotEmpty()) return null
                    if (right.value == 0.0) return null
                    Dimension(left.value / right.value, left.unit)
                }
            }
        }

        private fun sum(): Dimension? {
            var left = product() ?: return null
            while (true) {
                val op = peek()
                if (op != '+' && op != '-') return left
                pos += 1
                val right = product() ?: return null
                var unit = left.unit
                if (left.unit.isNotEmpty() && right.unit.isNotEmpty()) {
                    if (left.unit != right.unit) return null
                } else if (left.unit.isNotEmpty() && right.unit.isEmpty()) {
                    if (right.value != 0.0) return null
                } else if (left.unit.isEmpty() && right.unit.isNotEmpty()) {
                    if (left.value != 0.0) return null
                    unit = right.unit
                }
                left = Dimension(
                    if (op == '+') left.value + right.value else left.value - right.value,
                    unit,
                )
            }
        }
    }

    private fun foldCalc(body: String): Dimension? {
        val tokens = tokenizeCalc(body) ?: return null
        return CalcParser(tokens).parse()
    }

    // ------------------------------------------------------------------ collapse (U10)

    /**
     * `<CollapsingHeader>` (U10), which is a pure function of `--scroll-y` and therefore lives here.
     *
     * THE TITLE IS ONE ACCESSIBILITY ELEMENT AT EVERY FRACTION, and that is enforced by
     * construction rather than by review: [CollapseState.titleOwner] is a single value, and under
     * "move" the header's opacity reaches 0 exactly where the nav bar's leaves 0. A naive
     * implementation cross-fades the two over the whole range and a screen reader then finds the
     * title twice, which is the defect this pattern produces when implemented the obvious way.
     *
     * THE PINNED SLOT RAISES THE FLOOR. `effectiveMinHeight` is max(minHeight, pinnedHeight), so
     * content that must survive the collapse cannot be clipped by a minHeight the author chose
     * before adding it.
     *
     * REDUCED MOTION zeroes parallax and keeps everything else: the collapse is LAYOUT and must
     * still happen, and `stretch` survives because it tracks the finger one to one rather than
     * animating on its own, which is not what the vestibular guidance is about.
     */
    fun collapse(
        scrollY: Any?,
        height: Any? = 280.0,
        minHeight: Any? = NAV_BAR_HEIGHT,
        pinnedHeight: Any? = 0.0,
        parallax: Any? = 0.5,
        stretch: Boolean = true,
        blurOnCollapse: Boolean = false,
        titleTransition: String = "move",
        reduceMotion: Boolean = false,
    ): CollapseState {
        val h = maxOf(0.0, finite(height))
        val pinned = maxOf(0.0, finite(pinnedHeight))
        val floor = clamp(maxOf(finite(minHeight), pinned), 0.0, h)
        val y = finite(scrollY)
        val p = clamp(finite(parallax), 0.0, 1.0)

        val range = maxOf(0.0, h - floor)
        // The degenerate case answers 0, matching metrics.json: nothing to collapse means the
        // RESTING state, because booting into the collapsed look on a short page is the visible bug.
        val fraction = if (range <= 0.0) 0.0 else clamp(y / range, 0.0, 1.0)

        val stretching = y < 0.0 && stretch
        val headerHeight = if (stretching) h - y else h - fraction * range
        val imageScale = if (stretching && h > 0.0) (h - y) / h else 1.0

        val effectiveParallax = if (reduceMotion) 0.0 else p
        // Clamped to the range: once the header has stopped shrinking there is nothing left to move
        // the image against, and an unclamped translation walks the image out of its own header.
        val imageTranslation = clamp(y, 0.0, range) * effectiveParallax

        val headerTitleOpacity: Double
        val navBarTitleOpacity: Double
        val titleOwner: String
        when (titleTransition) {
            "move" -> {
                headerTitleOpacity = clamp(1.0 - fraction / TITLE_HANDOFF_FRACTION, 0.0, 1.0)
                navBarTitleOpacity =
                    clamp((fraction - TITLE_HANDOFF_FRACTION) / (1.0 - TITLE_HANDOFF_FRACTION), 0.0, 1.0)
                titleOwner = if (fraction >= TITLE_HANDOFF_FRACTION) "navbar" else "header"
            }
            "fade" -> {
                headerTitleOpacity = clamp(1.0 - fraction, 0.0, 1.0)
                navBarTitleOpacity = 0.0
                titleOwner = "header"
            }
            else -> {
                headerTitleOpacity = 1.0
                navBarTitleOpacity = 0.0
                titleOwner = "header"
            }
        }

        return CollapseState(
            fraction = round4(fraction),
            headerHeight = round4(headerHeight),
            effectiveMinHeight = round4(floor),
            imageTranslation = round4(imageTranslation),
            imageScale = round4(imageScale),
            effectiveParallax = round4(effectiveParallax),
            headerTitleOpacity = round4(headerTitleOpacity),
            navBarTitleOpacity = round4(navBarTitleOpacity),
            titleOwner = titleOwner,
            blurRadius = round4(if (blurOnCollapse) fraction * BLUR_MAX else 0.0),
            pinnedOffset = round4(maxOf(0.0, headerHeight - pinned)),
        )
    }

    /** `on:collapse` is quantised to a hundredth of the range, with the endpoints ALWAYS emitted so
     *  a handler can rely on seeing exactly 0 and exactly 1. */
    fun shouldEmitCollapse(previousFraction: Double?, fraction: Double): Boolean {
        if (previousFraction == null) return true
        if (fraction != previousFraction && (fraction == 0.0 || fraction == 1.0)) return true
        return abs(fraction - previousFraction) >= COLLAPSE_EPSILON
    }

    // ------------------------------------------------------------------ attributes

    fun boolAttribute(value: String?, fallback: Boolean): Boolean {
        if (value == null) return fallback
        return when (value.trim().lowercase()) {
            "false", "0", "no", "off" -> false
            "true", "1", "yes", "on", "" -> true
            else -> fallback
        }
    }

    fun numberAttribute(value: String?, fallback: Double): Double {
        if (value == null) return fallback
        var cleaned = value.trim().removeSuffix("%")
        val lower = cleaned.lowercase()
        if (lower.endsWith("px") || lower.endsWith("pt")) cleaned = cleaned.dropLast(2)
        if (cleaned.isEmpty()) return fallback
        val n = cleaned.toDoubleOrNull() ?: return fallback
        return if (n.isFinite()) n else fallback
    }

    fun wordAttribute(value: String?, allowed: List<String>, fallback: String): String {
        if (value == null) return fallback
        val word = value.trim().lowercase()
        for (candidate in allowed) if (candidate.lowercase() == word) return candidate
        return fallback
    }

    /** CSS edge shorthand, exactly: 1, 2, 3 or 4 values. An author who has written CSS knows it. */
    fun parseEdgeInsets(value: String?): ScrollEdgeInsets {
        val zero = ScrollEdgeInsets(0.0, 0.0, 0.0, 0.0)
        if (value == null) return zero
        val nums = value.replace(",", " ").split(Regex("\\s+"))
            .filter { it.isNotEmpty() }
            .map { numberAttribute(it, 0.0) }
        return when (nums.size) {
            0 -> zero
            1 -> ScrollEdgeInsets(round4(nums[0]), round4(nums[0]), round4(nums[0]), round4(nums[0]))
            2 -> ScrollEdgeInsets(round4(nums[0]), round4(nums[1]), round4(nums[0]), round4(nums[1]))
            3 -> ScrollEdgeInsets(round4(nums[0]), round4(nums[1]), round4(nums[2]), round4(nums[1]))
            else -> ScrollEdgeInsets(round4(nums[0]), round4(nums[1]), round4(nums[2]), round4(nums[3]))
        }
    }

    /**
     * The whole `<scroll>` attribute table, folded through ONE total function: no input throws, no
     * unrecognised word fails a build, and every unknown value falls back to the documented
     * default. These values come from authored markup and a dashboard field, not from a schema.
     *
     * `paging` and `snap` are one setting with two spellings, so paging resolves to "page" and
     * outranks a declared snap word rather than silently fighting it.
     */
    fun parseConfig(attributes: Map<String, String?>): ScrollConfig {
        val paging = boolAttribute(attributes["paging"], false)
        val snapWord = wordAttribute(attributes["snap"], listOf("none", "start", "center", "end"), "none")
        val bouncesWord = attributes["bounces"]
        return ScrollConfig(
            axis = wordAttribute(
                attributes["axis"] ?: attributes["direction"],
                listOf("vertical", "horizontal"),
                "vertical",
            ),
            bind = attributes["bind"],
            indicators = boolAttribute(attributes["indicators"], true),
            bounces = if (bouncesWord == null) null else boolAttribute(bouncesWord, true),
            paging = paging,
            snap = if (paging) "page" else snapWord,
            keyboardDismiss = wordAttribute(
                attributes["keyboardDismiss"],
                listOf("none", "onDrag", "interactive"),
                "interactive",
            ),
            overscroll = wordAttribute(attributes["overscroll"], listOf("auto", "never", "always"), "auto"),
            contentInset = parseEdgeInsets(attributes["contentInset"]),
            maintainPosition = boolAttribute(attributes["maintainPosition"], false),
            threshold = round4(maxOf(0.0, numberAttribute(attributes["threshold"], 0.0))),
        )
    }
}
