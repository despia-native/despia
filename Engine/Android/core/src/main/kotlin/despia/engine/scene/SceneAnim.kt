//
//  SceneAnim.kt - the DSX Scene animation system, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/anim.ts (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/animation.json. THE SEMANTICS LAW: an animation produces
//  a value that OVERRIDES the authored/bound base value of ONE property while active;
//  when it ends, the property returns to base (or holds, per fill="hold"). Two shapes
//  share this evaluator:
//
//  - IMPLICIT TRANSITIONS — `transition="position 300ms ease-out, color 200ms"` on any
//    scene node: when the property's resolved BASE value changes, the rendered value
//    RETARGETS from its CURRENT RENDERED value to the new base over the duration (the
//    CSS transition model: interrupt = start from where you are, never snap, never
//    queue). A store write glides.
//  - EXPLICIT TWEENS — `<animate target from to duration delay easing loop when fill
//    on:done/>` as a CHILD of the node it animates.
//
//  EASING IS PINNED MATH (the exact constants and formulas live in the corpus README):
//  linear; ease/ease-in/ease-out/ease-in-out as the CSS cubic-bezier constants (solved
//  by 60 bisection iterations — deterministic across IEEE-double runtimes); and
//  spring(stiffness, damping), the analytic mass-1 damped spring evaluated on the REAL
//  clock (duration is ignored; the clip ends at the pinned settle time). Vector and
//  color properties interpolate COMPONENTWISE — colors on the LINEAR-RGB value plane.
//
//  DETERMINISM: value(t) is a pure function of the spec + start state — that is what
//  the corpus samples pin to 6 decimals. The RUNTIME half here is [SceneAnimator], the
//  ONE clock-agnostic state machine BOTH JVM `<scene>` elements drive (the SceneRaster
//  precedent: shared in :core so the two lanes are 1:1 by construction) — the elements
//  own only the Compose frame loop (withFrameNanos + the SceneFrameClock budget) and the
//  law that the loop exists ONLY while an animation is active or on:frame is authored.
//

package despia.engine.scene

import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

// ── easing: the pinned curves ────────────────────────────────────────────────────────

sealed class SceneEasing {
    object Linear : SceneEasing()
    class Bezier(val x1: Double, val y1: Double, val x2: Double, val y2: Double) : SceneEasing()
    class Spring(val stiffness: Double, val damping: Double) : SceneEasing()
}

/** the CSS keyword constants, verbatim */
val SCENE_EASE_CONSTANTS: Map<String, DoubleArray> = mapOf(
    "ease" to doubleArrayOf(0.25, 0.1, 0.25, 1.0),
    "ease-in" to doubleArrayOf(0.42, 0.0, 1.0, 1.0),
    "ease-out" to doubleArrayOf(0.0, 0.0, 0.58, 1.0),
    "ease-in-out" to doubleArrayOf(0.42, 0.0, 0.58, 1.0),
)

const val SCENE_SPRING_DEFAULT_STIFFNESS = 100.0
const val SCENE_SPRING_DEFAULT_DAMPING = 10.0

private val SPRING_WORD = Regex("^spring\\(\\s*([^,)\\s]*)\\s*(?:,\\s*([^,)\\s]*)\\s*)?\\)$")

/** `linear` · a CSS keyword · `spring(stiffness,damping)` (either arg omissible —
 *  `spring()` = spring(100,10)). Malformed → `ease` with one diagnostic. */
fun parseSceneEasing(raw: String, diag: SceneDiag? = null): SceneEasing {
    val text = raw.trim()
    if (text.isEmpty() || text == "ease") {
        val c = SCENE_EASE_CONSTANTS.getValue("ease")
        return SceneEasing.Bezier(c[0], c[1], c[2], c[3])
    }
    if (text == "linear") return SceneEasing.Linear
    val keyword = SCENE_EASE_CONSTANTS[text]
    if (keyword != null) return SceneEasing.Bezier(keyword[0], keyword[1], keyword[2], keyword[3])
    val spring = SPRING_WORD.find(text)
    if (spring != null) {
        val stiffness = spring.groupValues[1].ifEmpty { null }?.let(::sceneAttrDouble) ?: SCENE_SPRING_DEFAULT_STIFFNESS
        val damping = spring.groupValues[2].ifEmpty { null }?.let(::sceneAttrDouble) ?: SCENE_SPRING_DEFAULT_DAMPING
        if (stiffness.isFinite() && stiffness > 0.0 && damping.isFinite() && damping > 0.0) {
            return SceneEasing.Spring(stiffness, damping)
        }
    }
    diag?.invoke(SceneDiagnostic(
        SceneDiagnosticCode.MALFORMED_ANIMATION,
        "easing=\"$raw\" is not a known easing — using ease",
    ))
    val c = SCENE_EASE_CONSTANTS.getValue("ease")
    return SceneEasing.Bezier(c[0], c[1], c[2], c[3])
}

/** cubic-bezier((0,0) P1 P2 (1,1)) sampled at parameter s */
private fun bezierAxis(s: Double, c1: Double, c2: Double): Double {
    val inverse = 1.0 - s
    return 3.0 * inverse * inverse * s * c1 + 3.0 * inverse * s * s * c2 + s * s * s
}

/** THE PINNED SOLVER: find s with x(s) = u by exactly 60 bisection iterations on
 *  s ∈ [0, 1] (x is monotone for CSS-legal x1/x2 ∈ [0, 1]) — deterministic on every
 *  IEEE-double runtime, then return y(s). */
fun sceneBezier(u: Double, x1: Double, y1: Double, x2: Double, y2: Double): Double {
    if (u <= 0.0) return 0.0
    if (u >= 1.0) return 1.0
    var lo = 0.0
    var hi = 1.0
    for (i in 0 until 60) {
        val mid = (lo + hi) / 2.0
        if (bezierAxis(mid, x1, x2) < u) lo = mid else hi = mid
    }
    val s = (lo + hi) / 2.0
    return bezierAxis(s, y1, y2)
}

/** THE SPRING LAW: the analytic mass-1 damped spring from 0 to 1 (initial position 0,
 *  initial velocity 0) at REAL elapsed seconds t. ωₙ = √stiffness, ζ = damping/(2·√stiffness).
 *  ζ<1: 1 − e^(−ζωₙt)·(cos(ω_d t) + (ζωₙ/ω_d)·sin(ω_d t)) with ω_d = ωₙ√(1−ζ²);
 *  ζ=1: 1 − e^(−ωₙt)·(1 + ωₙt);
 *  ζ>1: 1 − (s₂·e^(s₁t) − s₁·e^(s₂t))/(s₂ − s₁) with s₁,₂ = −ζωₙ ± ωₙ√(ζ²−1). */
fun sceneSpring(tSec: Double, stiffness: Double, damping: Double): Double {
    if (tSec <= 0.0) return 0.0
    val omega = sqrt(stiffness)
    val zeta = damping / (2.0 * omega)
    if (zeta < 1.0) {
        val damped = omega * sqrt(1.0 - zeta * zeta)
        return 1.0 - exp(-zeta * omega * tSec) *
            (cos(damped * tSec) + (zeta * omega / damped) * sin(damped * tSec))
    }
    if (zeta == 1.0) return 1.0 - exp(-omega * tSec) * (1.0 + omega * tSec)
    val root = omega * sqrt(zeta * zeta - 1.0)
    val s1 = -zeta * omega + root
    val s2 = -zeta * omega - root
    return 1.0 - (s2 * exp(s1 * tSec) - s1 * exp(s2 * tSec)) / (s2 - s1)
}

/** THE SETTLE LAW: a spring clip ignores `duration` — it completes at the pinned time
 *  its envelope decays to 0.1%: T = ln(1000) / (ωₙ·(ζ − √(max(0, ζ²−1)))). At and past
 *  T the progress clamps to exactly 1, so ending never snaps. */
fun springSettleSeconds(stiffness: Double, damping: Double): Double {
    val omega = sqrt(stiffness)
    val zeta = damping / (2.0 * omega)
    return ln(1000.0) / (omega * (zeta - sqrt(max(0.0, zeta * zeta - 1.0))))
}

/** a clip's length in ms: the authored duration, except spring which owns its clock */
fun sceneClipMs(easing: SceneEasing, durationMs: Double): Double = when (easing) {
    is SceneEasing.Spring -> springSettleSeconds(easing.stiffness, easing.damping) * 1000.0
    else -> durationMs
}

/** progress at elapsed CLIP time (ms; the caller has already removed delay + loop
 *  arithmetic). linear/bezier normalize by the clip; spring runs on real seconds and
 *  clamps to 1 at/after settle. */
fun sceneEasingProgress(easing: SceneEasing, elapsedMs: Double, durationMs: Double): Double {
    if (easing is SceneEasing.Spring) {
        val settle = springSettleSeconds(easing.stiffness, easing.damping)
        if (elapsedMs / 1000.0 >= settle) return 1.0
        return sceneSpring(elapsedMs / 1000.0, easing.stiffness, easing.damping)
    }
    val u = if (durationMs <= 0.0) 1.0 else min(max(elapsedMs / durationMs, 0.0), 1.0)
    return when (easing) {
        is SceneEasing.Linear -> u
        is SceneEasing.Bezier -> sceneBezier(u, easing.x1, easing.y1, easing.x2, easing.y2)
        else -> u // unreachable — spring handled above
    }
}

// ── the value plane (componentwise; colors in LINEAR RGB) ────────────────────────────

/** THE SUPPORTED TARGET SET, closed: position · rotation · scale (vec3) · color
 *  (linear-RGB triple) · intensity · fov (scalars). opacity is a NAMED ABSENCE — the
 *  scene material plane has no opacity channel. */
val SCENE_ANIM_TARGETS: Set<String> = setOf(
    "position", "rotation", "scale", "color", "intensity", "fov",
)

fun sceneAnimComponents(target: String): Int =
    if (target == "intensity" || target == "fov") 1 else 3

/** sRGB channel (0..1) → linear (the IEC 61966-2-1 curve) */
fun srgbToLinear(c: Double): Double =
    if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)

/** linear channel → sRGB (0..1) */
fun linearToSrgb(c: Double): Double {
    val clamped = min(max(c, 0.0), 1.0)
    return if (clamped <= 0.0031308) clamped * 12.92 else 1.055 * clamped.pow(1.0 / 2.4) - 0.055
}

/** an authored value string → the animation VALUE PLANE: vec3 targets parse the
 *  space-separated triple; scalars one number; `color` parses #hex and LINEARIZES each
 *  channel (interpolation is plain componentwise lerp on this plane for every target).
 *  null = malformed (the caller diags + treats the animation as inert). */
fun parseSceneAnimValue(target: String, raw: String): DoubleArray? {
    if (target == "color") {
        val srgb = parseSceneColor(raw) ?: return null
        return DoubleArray(3) { srgbToLinear(srgb[it]) }
    }
    val parts = raw.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.size != sceneAnimComponents(target)) return null
    val numbers = DoubleArray(parts.size)
    for ((i, part) in parts.withIndex()) {
        val value = sceneAttrDouble(part)
        if (value == null || !value.isFinite()) return null
        numbers[i] = value
    }
    return numbers
}

/** the value plane → the RESOLVED-ATTRIBUTE string a renderer's resolver overrides
 *  with: vec3/scalar as full-precision space-separated numbers (JS-String formatting —
 *  the sceneNumberString twin); color delinearizes to #rrggbb (displays are 8-bit — the
 *  corpus pins the linear plane, the hex is the last-step quantization). */
fun formatSceneAnimValue(target: String, value: DoubleArray): String {
    if (target == "color") {
        return "#" + value.joinToString("") { c ->
            val byte = min(255, max(0, (linearToSrgb(c) * 255.0).roundToInt()))
            byte.toString(16).padStart(2, '0')
        }
    }
    return value.joinToString(" ") { sceneNumberString(it) }
}

private fun lerpComponents(from: DoubleArray, to: DoubleArray, p: Double): DoubleArray =
    DoubleArray(to.size) { i ->
        val f = if (i < from.size) from[i] else 0.0
        f + (to[i] - f) * p
    }

// ── duration / loop words ────────────────────────────────────────────────────────────

private val DURATION_WORD = Regex("^([0-9]*\\.?[0-9]+)(ms|s)?$")

/** `2s` · `300ms` · bare `300` (ms). null = malformed. Negative is malformed. */
fun parseSceneDuration(raw: String): Double? {
    val m = DURATION_WORD.find(raw.trim()) ?: return null
    val value = sceneAttrDouble(m.groupValues[1]) ?: return null
    if (!value.isFinite() || value < 0.0) return null
    return if (m.groupValues[2] == "s") value * 1000.0 else value
}

sealed class SceneLoop {
    object None : SceneLoop()
    object Infinite : SceneLoop()
    class Count(val count: Int) : SceneLoop()
    object Pingpong : SceneLoop()
}

/** absent/`false` → none · `true` → infinite · positive integer N → count ·
 *  `pingpong` → infinite ping-pong. Malformed → none + one diagnostic. */
fun parseSceneLoop(raw: String?, diag: SceneDiag? = null): SceneLoop {
    if (raw == null) return SceneLoop.None
    val text = raw.trim()
    if (text.isEmpty() || text == "false") return SceneLoop.None
    if (text == "true") return SceneLoop.Infinite
    if (text == "pingpong") return SceneLoop.Pingpong
    if (Regex("^[0-9]+$").matches(text)) {
        val count = text.toIntOrNull()
        if (count != null && count > 0) return SceneLoop.Count(count)
    }
    diag?.invoke(SceneDiagnostic(
        SceneDiagnosticCode.MALFORMED_ANIMATION,
        "loop=\"$raw\" is not false, true, a positive integer or pingpong — not looping",
    ))
    return SceneLoop.None
}

// ── explicit tweens (`<animate>`) ────────────────────────────────────────────────────

class SceneTweenSpec(
    val target: String,
    /** null = capture the BASE value at clip start (the from-default law) */
    val from: DoubleArray?,
    val to: DoubleArray,
    val durationMs: Double,
    val delayMs: Double,
    val easing: SceneEasing,
    val loop: SceneLoop,
    /** "none" | "hold" */
    val fill: String,
)

const val SCENE_TWEEN_DEFAULT_DURATION_MS = 300.0

/** parse an `<animate>` node's resolved attributes into the spec. A missing/unknown
 *  target or a malformed `to` makes the animation INERT (null + one diagnostic) —
 *  failure is a value, the scene keeps rendering (Article 7). */
fun parseSceneTween(node: SceneNode, resolve: SceneResolve, diag: SceneDiag? = null): SceneTweenSpec? {
    fun read(name: String): String? {
        val raw = node.attrs[name] ?: return null
        return resolve(node, name, raw)
    }
    val target = read("target") ?: ""
    if (target !in SCENE_ANIM_TARGETS) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_ANIMATION,
            "<animate target=\"$target\"> is not one of position·rotation·scale·color·intensity·fov — inert",
        ))
        return null
    }
    val toRaw = read("to")
    val to = toRaw?.let { parseSceneAnimValue(target, it) }
    if (to == null) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_ANIMATION,
            "<animate to=\"${toRaw ?: ""}\"> is not a $target value — inert",
        ))
        return null
    }
    var from: DoubleArray? = null
    val fromRaw = read("from")
    if (fromRaw != null) {
        from = parseSceneAnimValue(target, fromRaw)
        if (from == null) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_ANIMATION,
                "<animate from=\"$fromRaw\"> is not a $target value — using the base value at start",
            ))
        }
    }
    var durationMs = SCENE_TWEEN_DEFAULT_DURATION_MS
    val durationRaw = read("duration")
    if (durationRaw != null) {
        val parsed = parseSceneDuration(durationRaw)
        if (parsed == null) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_ANIMATION,
                "duration=\"$durationRaw\" is not ms|s — using 300ms",
            ))
        } else durationMs = parsed
    }
    var delayMs = 0.0
    val delayRaw = read("delay")
    if (delayRaw != null) {
        val parsed = parseSceneDuration(delayRaw)
        if (parsed == null) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_ANIMATION,
                "delay=\"$delayRaw\" is not ms|s — using 0",
            ))
        } else delayMs = parsed
    }
    val fillRaw = read("fill")
    val fill = if (fillRaw == "hold") "hold" else "none"
    if (fillRaw != null && fillRaw != "hold" && fillRaw != "none") {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.MALFORMED_ANIMATION,
            "fill=\"$fillRaw\" is not none or hold — using none",
        ))
    }
    return SceneTweenSpec(
        target = target, from = from, to = to, durationMs = durationMs, delayMs = delayMs,
        easing = parseSceneEasing(read("easing") ?: "", diag),
        loop = parseSceneLoop(read("loop"), diag),
        fill = fill,
    )
}

class SceneTweenSample(
    /** the rendered value of the target property at t */
    val value: DoubleArray,
    /** true while the animation is producing the value (false = the property shows base) */
    val overriding: Boolean,
    /** true once the clip has COMPLETED (loop none/count exhausted) — on:done fires on
     *  the false→true edge, once, never per loop iteration */
    val done: Boolean,
)

/** THE VALUE LAW, pure: sample a tween at t ms since clip start. `from` is the
 *  captured start value (spec.from, or base at start when unauthored); `base` is the
 *  property's current resolved base value.
 *  - t < delay → base, not overriding (the delay shows base; delay applies ONCE).
 *  - looping: cycle c = floor((t−delay)/clip), u = (t−delay) − c·clip. pingpong
 *    samples the easing at (clip − u) on odd cycles (the same curve, traversed
 *    backwards). At an exact wrap instant u = 0 (the new cycle's start).
 *  - completion (loop none at clip end; loop N at N·clip): fill="hold" keeps the final
 *    value (= to) and stays overriding; fill="none" returns to base. done = true.
 *  - the clip length is `duration` for linear/bezier and the SETTLE TIME for spring. */
fun sceneTweenValue(
    spec: SceneTweenSpec, from: DoubleArray, base: DoubleArray, tMs: Double,
): SceneTweenSample {
    if (tMs < spec.delayMs) return SceneTweenSample(base.copyOf(), overriding = false, done = false)
    val clip = sceneClipMs(spec.easing, spec.durationMs)
    val elapsed = tMs - spec.delayMs
    val finished =
        (spec.loop is SceneLoop.None && (clip <= 0.0 || elapsed >= clip)) ||
            (spec.loop is SceneLoop.Count && (clip <= 0.0 || elapsed >= spec.loop.count * clip))
    if (finished) {
        return if (spec.fill == "hold") SceneTweenSample(spec.to.copyOf(), overriding = true, done = true)
        else SceneTweenSample(base.copyOf(), overriding = false, done = true)
    }
    var cycleMs = elapsed
    var reversed = false
    if (spec.loop !is SceneLoop.None && clip > 0.0) {
        val cycle = floor(elapsed / clip)
        cycleMs = elapsed - cycle * clip
        reversed = spec.loop is SceneLoop.Pingpong && cycle.toLong() % 2L == 1L
    }
    val p = sceneEasingProgress(spec.easing, if (reversed) clip - cycleMs else cycleMs, spec.durationMs)
    return SceneTweenSample(lerpComponents(from, spec.to, p), overriding = true, done = false)
}

// ── implicit transitions ─────────────────────────────────────────────────────────────

class SceneTransitionEntry(
    val property: String,
    val durationMs: Double,
    val easing: SceneEasing,
    val delayMs: Double,
)

/** split on top-level commas only — a comma inside `spring(100,10)` belongs to the
 *  easing, not the entry list */
private fun splitTransitionEntries(raw: String): List<String> {
    val out = ArrayList<String>()
    var depth = 0
    var start = 0
    for (i in raw.indices) {
        when (raw[i]) {
            '(' -> depth += 1
            ')' -> depth = max(0, depth - 1)
            ',' -> if (depth == 0) { out.add(raw.substring(start, i)); start = i + 1 }
        }
    }
    out.add(raw.substring(start))
    return out
}

/** `transition="position 300ms ease-out, color 200ms"` — comma-separated entries of
 *  `<property> <duration> [<easing>] [<delay>]` (commas inside `spring(…)` stay with
 *  the easing). A malformed entry is skipped with one diagnostic; the rest still apply. */
fun parseSceneTransitions(raw: String, diag: SceneDiag? = null): List<SceneTransitionEntry> {
    val out = ArrayList<SceneTransitionEntry>()
    for (entry in splitTransitionEntries(raw)) {
        val text = entry.trim()
        if (text.isEmpty()) continue
        val words = text.split(Regex("\\s+"))
        val property = words.getOrNull(0) ?: ""
        val durationMs = if (words.size > 1) parseSceneDuration(words[1]) else null
        if (property !in SCENE_ANIM_TARGETS || durationMs == null) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_ANIMATION,
                "transition entry \"$text\" is not \"<property> <duration> [easing] [delay]\" — skipped",
            ))
            continue
        }
        var easing: SceneEasing = parseSceneEasing("", null)
        var delayMs = 0.0
        var bad = false
        for (word in words.drop(2)) {
            val asDelay = parseSceneDuration(word)
            if (asDelay != null) { delayMs = asDelay; continue }
            var easingBad = false
            easing = parseSceneEasing(word) { easingBad = true }
            if (easingBad) { bad = true; break }
        }
        if (bad) {
            diag?.invoke(SceneDiagnostic(
                SceneDiagnosticCode.MALFORMED_ANIMATION,
                "transition entry \"$text\" is not \"<property> <duration> [easing] [delay]\" — skipped",
            ))
            continue
        }
        out.add(SceneTransitionEntry(property, durationMs, easing, delayMs))
    }
    return out
}

/** one in-flight retarget: rendered glides from `from` toward `to`; startMs is the
 *  base-change instant */
class SceneTransitionState(var from: DoubleArray, var to: DoubleArray, var startMs: Double)

class SceneTransitionSample(val value: DoubleArray, val done: Boolean)

/** THE RETARGET LAW, pure: when the base changes, the caller builds a fresh state with
 *  `from` = the CURRENT RENDERED value (mid-flight or at rest — never snap, never
 *  queue) and `to` = the new base. During the entry's delay the rendered value HOLDS
 *  `from` (already overriding); then it eases to `to`. done = the clip completed (the
 *  rendered value equals base again — the override retires). */
fun sceneTransitionValue(
    entry: SceneTransitionEntry, state: SceneTransitionState, nowMs: Double,
): SceneTransitionSample {
    val t = nowMs - state.startMs
    if (t < entry.delayMs) return SceneTransitionSample(state.from.copyOf(), done = false)
    val clip = sceneClipMs(entry.easing, entry.durationMs)
    val elapsed = t - entry.delayMs
    if (clip <= 0.0 || elapsed >= clip) return SceneTransitionSample(state.to.copyOf(), done = true)
    val p = sceneEasingProgress(entry.easing, elapsed, entry.durationMs)
    return SceneTransitionSample(lerpComponents(state.from, state.to, p), done = false)
}

// ── the shared runtime driver (both JVM `<scene>` elements) ──────────────────────────

/** the page-JS falsy words the `when` gate honors (the web element's set, verbatim) */
private val FALSY_WHEN = setOf("", "false", "0", "null", "undefined")

/**
 * The clock-agnostic animation state machine BOTH JVM `<scene>` elements drive — the
 * web element's advanceTransitions/advanceAnimations fold as one shared object (the
 * SceneRaster stance: runtime halves the two lanes must share live in :core).
 *
 * THE OVERRIDE PLANE DECISION (dsx-scene.md §8, verbatim): animations override at the
 * RESOLVED ATTRIBUTE plane — [resolve] wraps the element's base resolver and consults
 * the override map first, so the corpus-pinned worldMatrices/sceneCamera/sceneLighting
 * folds need ZERO signature changes, and the same seam serves tweens, transitions and
 * orbit controls. The TOTAL-RESOLVE LAW makes unauthored properties reachable.
 *
 * The element calls, in order: [attach] once per mounted subtree (bound rows attach on
 * spawn, [detach] on removal — removing a row STOPS its animations), [noteBase] every
 * recomposition (base changes retarget transitions from the CURRENT RENDERED value),
 * [tick] from its frame loop (true = overrides changed, re-raster), and [wantsTick] to
 * decide whether the loop may exist at all (the zero-cost static law).
 */
class SceneAnimator(private val diag: SceneDiag? = null) {

    private class TweenRec(val node: SceneNode, val target: SceneNode) {
        var playing = false
        var finished = false
        var doneFired = false
        var startMs = 0.0
        var spec: SceneTweenSpec? = null
        var from: DoubleArray? = null
    }

    private class TransitionRec(val entry: SceneTransitionEntry, val state: SceneTransitionState) {
        /** true until the first tick stamps the real clock (retargets are noted during
         *  composition, but values only ever advance on the loop's time plane) */
        var pendingStart = true
    }

    private val overrides = HashMap<SceneNode, HashMap<String, String>>()
    private val tweens = LinkedHashMap<SceneNode, TweenRec>()
    private val transitionNodes = LinkedHashSet<SceneNode>()
    private val transitionParse = HashMap<SceneNode, Pair<String, List<SceneTransitionEntry>>>()
    private val transitions = HashMap<SceneNode, HashMap<String, TransitionRec>>()
    /** last observed base values of transition-covered properties (the change detector) */
    private val baseSnapshot = HashMap<SceneNode, HashMap<String, DoubleArray>>()
    private var lastTickMs = 0.0

    /** the override plane: consult an active animation's value first, else the base */
    fun resolve(base: SceneResolve): SceneResolve = { node, name, raw ->
        (if (node != null) overrides[node]?.get(name) else null) ?: base(node, name, raw)
    }

    /** an out-of-band override write (orbit controls ride the same plane) */
    fun setOverride(node: SceneNode, name: String, value: String) {
        overrides.getOrPut(node) { HashMap() }[name] = value
    }

    /** an out-of-band GLIDE (the scene bus's camera flyTo — dsx-game.md G5): seed one
     *  transition on [target] from [from] to [to] over [durationMs] with [easing],
     *  riding the SAME transition machinery `transition=` retargets use (pendingStart:
     *  the clock stamps on the next loop tick). The override holds [from] immediately
     *  so the very next raster never snaps. */
    fun glide(node: SceneNode, target: String, from: DoubleArray, to: DoubleArray,
              durationMs: Double, easing: SceneEasing) {
        // a fresh record EVERY time — a glide issued mid-flight must honor ITS OWN
        // duration/easing, not the in-flight record's (the web/iOS twins replace the
        // whole record; reusing `existing.entry` kept the old timing here)
        transitions.getOrPut(node) { HashMap() }[target] = TransitionRec(
            SceneTransitionEntry(target, durationMs, easing, 0.0),
            SceneTransitionState(from, to, 0.0),
        )
        setOverride(node, target, formatSceneAnimValue(target, from))
    }

    /** the G2 teleport law's hook (ScenePhysicsRuntime): a base `position` write on a
     *  dynamic/character body must never glide — retire any in-flight transition on
     *  [target] and re-sync the base snapshot so the next [noteBase] does not start one */
    fun cancelTransition(node: SceneNode, target: String, resolveBase: SceneResolve) {
        transitions[node]?.let { bucket ->
            bucket.remove(target)
            if (bucket.isEmpty()) transitions.remove(node)
        }
        baseSnapshot[node]?.let { it[target] = baseValueFor(node, target, resolveBase) }
    }

    /** the stats() honest read (the scene bus): in-flight transitions + playing tweens */
    fun activeAnimationCount(resolveBase: SceneResolve): Int {
        var count = transitions.values.sumOf { it.size }
        for (rec in tweens.values) {
            if (rec.playing && !rec.finished && gateOpen(rec.node, resolveBase)) count += 1
        }
        return count
    }

    private fun clearOverride(node: SceneNode, name: String) {
        val bucket = overrides[node] ?: return
        bucket.remove(name)
        if (bucket.isEmpty()) overrides.remove(node)
    }

    /** register a mounted subtree: `<animate>` children bind to their PARENT (the node
     *  they animate); `transition=`-bearing nodes snapshot their base values so the
     *  first [noteBase] never phantom-retargets. */
    fun attach(nodes: List<SceneNode>, parent: SceneNode?, resolveBase: SceneResolve) {
        for (node in nodes) {
            if (node.kind == SceneNodeKind.ANIMATE) {
                if (parent == null || parent.kind == SceneNodeKind.ANIMATE) {
                    diag?.invoke(SceneDiagnostic(
                        SceneDiagnosticCode.MALFORMED_ANIMATION,
                        "<animate> must be the child of the node it animates — inert",
                    ))
                    continue
                }
                tweens[node] = TweenRec(node, parent)
                continue
            }
            if (node.attrs.containsKey("transition")) {
                transitionNodes.add(node)
                val snapshot = HashMap<String, DoubleArray>()
                for (entry in transitionEntriesFor(node, resolveBase)) {
                    snapshot[entry.property] = baseValueFor(node, entry.property, resolveBase)
                }
                baseSnapshot[node] = snapshot
            }
            attach(node.children, node, resolveBase)
        }
    }

    /** unregister a subtree (a removed bound row) — stops its animations (the bind law) */
    fun detach(nodes: List<SceneNode>) {
        for (node in nodes) {
            overrides.remove(node)
            transitionNodes.remove(node)
            transitionParse.remove(node)
            transitions.remove(node)
            baseSnapshot.remove(node)
            tweens.remove(node)
            tweens.entries.removeAll { it.value.target === node }
            detach(node.children)
        }
    }

    private fun transitionEntriesFor(node: SceneNode, resolveBase: SceneResolve): List<SceneTransitionEntry> {
        val raw = node.attrs["transition"] ?: return emptyList()
        val source = resolveBase(node, "transition", raw)
        val cached = transitionParse[node]
        if (cached != null && cached.first == source) return cached.second
        val entries = parseSceneTransitions(source, diag)
        transitionParse[node] = source to entries
        return entries
    }

    /** the property's BASE on the animation value plane (what a finished tween returns
     *  to, what a transition retargets toward) */
    fun baseValueFor(node: SceneNode, target: String, resolveBase: SceneResolve): DoubleArray {
        val props = resolvedProps(node, resolveBase, diag)
        return when (target) {
            "position" -> props.position.copyOf()
            "rotation" -> props.rotation.copyOf()
            "scale" -> props.scale.copyOf()
            "intensity" -> doubleArrayOf(props.intensity)
            "fov" -> doubleArrayOf(props.fov)
            else -> parseSceneAnimValue("color", props.color) ?: doubleArrayOf(1.0, 1.0, 1.0)
        }
    }

    /** an ACTIVE explicit tween owns its property — implicit transitions yield to it */
    private fun tweenOwns(node: SceneNode, target: String): Boolean =
        tweens.values.any { it.target === node && it.playing && !it.finished && it.spec?.target == target }

    private fun gateOpen(animNode: SceneNode, resolveBase: SceneResolve): Boolean {
        val raw = animNode.attrs["when"] ?: return true
        return resolveBase(animNode, "when", raw).trim() !in FALSY_WHEN
    }

    /** THE RETARGET LAW's detector, called every recomposition: a changed base on a
     *  transition-covered property starts a glide FROM THE CURRENT RENDERED VALUE
     *  (the mid-flight override when one exists, else the previous base) — never snap,
     *  never queue. The override is written immediately so the very next raster holds
     *  the pre-change value; the clock stamps on the next loop tick. */
    fun noteBase(resolveBase: SceneResolve) {
        for (node in transitionNodes) {
            val entries = transitionEntriesFor(node, resolveBase)
            val snapshot = baseSnapshot.getOrPut(node) { HashMap() }
            for (entry in entries) {
                val next = baseValueFor(node, entry.property, resolveBase)
                val previous = snapshot[entry.property]
                if (previous == null) { snapshot[entry.property] = next; continue }
                if (previous.contentEquals(next)) continue
                snapshot[entry.property] = next
                if (tweenOwns(node, entry.property)) continue
                val rendered = overrides[node]?.get(entry.property)
                    ?.let { parseSceneAnimValue(entry.property, it) } ?: previous
                val bucket = transitions.getOrPut(node) { HashMap() }
                val existing = bucket[entry.property]
                if (existing != null) {
                    existing.state.from = rendered
                    existing.state.to = next
                    existing.pendingStart = true
                } else {
                    bucket[entry.property] = TransitionRec(entry, SceneTransitionState(rendered, next, 0.0))
                }
                setOverride(node, entry.property, formatSceneAnimValue(entry.property, rendered))
            }
        }
    }

    /** true while at least one animation needs the frame loop: an in-flight transition,
     *  a tween that will start or is mid-flight, or a gated tween needing its stop tick */
    fun wantsTick(resolveBase: SceneResolve): Boolean {
        if (transitions.isNotEmpty()) return true
        for (rec in tweens.values) {
            val open = gateOpen(rec.node, resolveBase)
            if (open && !(rec.playing && rec.finished)) return true
            if (!open && rec.playing) return true
        }
        return false
    }

    /** advance every animation to nowMs (the loop's time plane). Returns true when any
     *  override changed — the element re-rasters. [onDone] fires ONCE per tween
     *  completion (never per loop iteration — the corpus law). */
    fun tick(nowMs: Double, resolveBase: SceneResolve, onDone: (animNode: SceneNode, target: SceneNode) -> Unit = { _, _ -> }): Boolean {
        lastTickMs = nowMs
        var changed = false

        // explicit tweens first — an active tween owns its property (explicit wins)
        for (rec in tweens.values) {
            val open = gateOpen(rec.node, resolveBase)
            if (!open) {
                // the when law: falsy stops at base (no on:done); next truthy edge restarts
                if (rec.playing) {
                    rec.spec?.let { spec ->
                        if (overrides[rec.target]?.containsKey(spec.target) == true) {
                            clearOverride(rec.target, spec.target)
                            changed = true
                        }
                    }
                }
                rec.playing = false
                rec.finished = false
                continue
            }
            if (!rec.playing) {
                rec.spec = parseSceneTween(rec.node, resolveBase, diag)
                rec.playing = true
                rec.doneFired = false
                val spec = rec.spec
                if (spec == null) { rec.finished = true; continue } // inert (diagnosed)
                rec.finished = false
                rec.startMs = nowMs
                // from defaults to the BASE at start; an explicit tween cancels the
                // implicit transition on its property (explicit wins)
                rec.from = spec.from ?: baseValueFor(rec.target, spec.target, resolveBase)
                transitions[rec.target]?.let { bucket ->
                    bucket.remove(spec.target)
                    if (bucket.isEmpty()) transitions.remove(rec.target)
                }
            }
            val spec = rec.spec
            if (rec.finished || spec == null) continue
            val sample = sceneTweenValue(
                spec, rec.from!!, baseValueFor(rec.target, spec.target, resolveBase), nowMs - rec.startMs,
            )
            if (sample.overriding) {
                val formatted = formatSceneAnimValue(spec.target, sample.value)
                if (overrides[rec.target]?.get(spec.target) != formatted) {
                    setOverride(rec.target, spec.target, formatted)
                    changed = true
                }
            } else if (overrides[rec.target]?.containsKey(spec.target) == true) {
                clearOverride(rec.target, spec.target)
                changed = true
            }
            if (sample.done) {
                rec.finished = true // fill=hold keeps its final override; fill=none cleared above
                if (!rec.doneFired) { rec.doneFired = true; onDone(rec.node, rec.target) }
            }
        }

        // implicit transitions (skipping tween-owned properties)
        val emptyTransitionNodes = ArrayList<SceneNode>()
        for ((node, bucket) in transitions) {
            val doneProperties = ArrayList<String>()
            for ((target, rec) in bucket) {
                if (tweenOwns(node, target)) continue // explicit beats implicit
                if (rec.pendingStart) { rec.state.startMs = nowMs; rec.pendingStart = false }
                val result = sceneTransitionValue(rec.entry, rec.state, nowMs)
                if (result.done) {
                    // the glide reached base — the override retires, the property shows base
                    clearOverride(node, target)
                    doneProperties.add(target)
                    changed = true
                } else {
                    val formatted = formatSceneAnimValue(target, result.value)
                    if (overrides[node]?.get(target) != formatted) {
                        setOverride(node, target, formatted)
                        changed = true
                    }
                }
            }
            for (target in doneProperties) bucket.remove(target)
            if (bucket.isEmpty()) emptyTransitionNodes.add(node)
        }
        for (node in emptyTransitionNodes) transitions.remove(node)

        return changed
    }
}
