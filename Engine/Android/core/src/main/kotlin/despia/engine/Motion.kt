//
//  Motion.kt - THE UI MOTION ENGINE, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/motion.ts (architecture/proposals/ui-motion.md).
//  Corpus: OpenSource/Conformance/motion/{curves,spring,retarget,physics}.json, executed
//  here by MotionConformanceTest — the SAME files the TS reference and the Swift twin
//  (record lane) run, so `anim="spring"` can never mean three different curves again.
//
//  THE PROBLEM THIS FILE ENDS: the UI layer carried a motion VOCABULARY (`enter` ·
//  `transition` · `keep` · `anim` · `animDuration`, universal attributes on every element
//  on every renderer) with no motion ENGINE behind it — iOS resolved it through SwiftUI,
//  Android through Compose, the web through a hand-picked cubic-bezier, and nothing held
//  the three to the same curve. The SCENE layer already solved exactly this for `<scene>`
//  (SceneAnim.kt + the animation corpus); this is the UI layer's twin.
//
//  ONE SPRING, ONE BEZIER SOLVER: this file implements NEITHER. It calls
//  despia.engine.scene's `sceneBezier` / `sceneSpring` / `springSettleSeconds`. A second
//  spring in this codebase would be a bug.
//
//  PURE JVM by construction (:core, no android.*, no Compose) — the Compose edge mapping
//  lives in :render StackMotion.kt, which derives its AnimationSpec numbers from HERE.
//

package despia.engine

import despia.engine.scene.sceneBezier
import despia.engine.scene.sceneSpring
import despia.engine.scene.springSettleSeconds
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.max
import kotlin.math.sqrt

/** One `malformed-motion` diagnostic per malformed word (Article 7: failure is a value —
 *  the element still animates, with the default). */
typealias MotionDiag = (code: String, message: String) -> Unit

/**
 * The parsed `anim=`/`animDuration=` pair. [durationMs] is the CLIP LENGTH: the authored
 * duration for a curve, the SETTLE TIME for a spring (a spring owns its clock —
 * `animDuration` set its RESPONSE, not its length).
 */
class MotionSpec(
    /** "spring" · "linear" · "easeIn" · "easeOut" · "easeInOut" */
    val name: String,
    val durationMs: Double,
    // curve plane (meaningless for a spring)
    val x1: Double = 0.0,
    val y1: Double = 0.0,
    val x2: Double = 1.0,
    val y2: Double = 1.0,
    // spring plane: the AUTHORING numbers (SwiftUI .spring(response:dampingFraction:))
    val response: Double = 0.0,
    val dampingFraction: Double = 0.0,
    // spring plane: the MATH numbers (the mass-1 oscillator SceneAnim evaluates)
    val stiffness: Double = 0.0,
    val damping: Double = 0.0,
) {
    val isSpring: Boolean get() = name == "spring"
}

object Motion {

    /** The SwiftUI unit beziers — identical to the CSS timing functions of the same
     *  names. `linear` is the degenerate (0,0,1,1) whose y(s) = x(s), i.e. the identity. */
    val CURVES: Map<String, DoubleArray> = mapOf(
        "linear" to doubleArrayOf(0.0, 0.0, 1.0, 1.0),
        "easeIn" to doubleArrayOf(0.42, 0.0, 1.0, 1.0),
        "easeOut" to doubleArrayOf(0.0, 0.0, 0.58, 1.0),
        "easeInOut" to doubleArrayOf(0.42, 0.0, 0.58, 1.0),
    )

    /** SwiftUI's default curve duration when none is authored. */
    const val DEFAULT_DURATION_MS = 350.0
    /** SwiftUI `.spring(response: 0.4, dampingFraction: 0.8)` — the native `anim="spring"`. */
    const val SPRING_DEFAULT_RESPONSE = 0.4
    const val SPRING_DEFAULT_DAMPING_FRACTION = 0.8

    /** The `animDuration=` grammar: a plain decimal number of SECONDS, on the TRIMMED
     *  string. Deliberately stricter than a bare toDoubleOrNull()/JSE.number — the three
     *  runtimes must agree on what IS a duration, so the shape is one regex all three
     *  spell the same way. */
    private val DURATION_RE = Regex("^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?$")

    /** THE CONVERSION — the crux of the 1:1 claim, pinned in motion/spring.json. SwiftUI's
     *  response/dampingFraction describe a mass-1 damped oscillator: ωₙ = 2π/response,
     *  stiffness = ωₙ², damping = 2·dampingFraction·ωₙ (so ζ = dampingFraction). */
    fun springConstants(response: Double, dampingFraction: Double): DoubleArray {
        val omega = 2.0 * PI / response
        return doubleArrayOf(omega * omega, 2.0 * dampingFraction * omega)
    }

    /** A spring spec built directly from the AUTHORING plane, for the framework's own
     *  springs (the overscroll release below) — `anim="spring"` can only ever reach
     *  damping fraction 0.8, but the kernel's physics primitives name their own. */
    fun spring(response: Double, dampingFraction: Double): MotionSpec {
        val k = springConstants(response, dampingFraction)
        val stiffness = k[0]
        val damping = k[1]
        return MotionSpec(
            name = "spring", durationMs = springSettleSeconds(stiffness, damping) * 1000.0,
            response = response, dampingFraction = dampingFraction,
            stiffness = stiffness, damping = damping,
        )
    }

    /** THE PARSE LAW. `anim` absent/empty is easeInOut and is NOT an error; any other word
     *  falls back to easeInOut with one diagnostic. `animDuration` sets the curve duration
     *  in seconds, or — for `spring` — the RESPONSE. */
    fun parse(anim: String?, animDuration: String?, diag: MotionDiag? = null): MotionSpec {
        var seconds: Double? = null
        val raw = animDuration?.trim()
        if (raw != null && raw.isNotEmpty()) {
            val value = if (DURATION_RE.matches(raw)) raw.toDoubleOrNull() else null
            if (value == null || !value.isFinite() || value <= 0.0) {
                diag?.invoke(
                    "malformed-motion",
                    "animDuration=\"$animDuration\" is not a positive number of seconds — using the default",
                )
            } else {
                seconds = value
            }
        }

        var name = (anim ?: "").trim()
        if (name.isEmpty()) name = "easeInOut"
        if (name == "spring") return spring(seconds ?: SPRING_DEFAULT_RESPONSE, SPRING_DEFAULT_DAMPING_FRACTION)
        if (!CURVES.containsKey(name)) {
            diag?.invoke(
                "malformed-motion",
                "anim=\"${anim ?: ""}\" is not spring·linear·easeIn·easeOut·easeInOut — using easeInOut",
            )
            name = "easeInOut"
        }
        val b = CURVES.getValue(name)
        return MotionSpec(
            name = name,
            durationMs = if (seconds == null) DEFAULT_DURATION_MS else seconds * 1000.0,
            x1 = b[0], y1 = b[1], x2 = b[2], y2 = b[3],
        )
    }

    /** The two motion PRESETS a renderer applies when the author sets no `anim=` on a
     *  built-in behaviour, pinned in curves.json `presets` — a renderer must not invent a
     *  third. KEEP = the `keep="true"` hide/show fade; PRESS = the button press-scale snap. */
    val PRESET_KEEP: MotionSpec = parse("easeOut", "0.18")
    val PRESET_PRESS: MotionSpec = parse("easeOut", "0.12")
    val PRESET_DEFAULT: MotionSpec = parse(null, null)

    /** THE PROGRESS LAW: 0..1 at elapsed CLIP time (ms). A curve normalizes by its
     *  duration; a spring runs on the REAL clock and clamps to exactly 1 at/after settle,
     *  so ending never snaps. An underdamped spring legitimately returns > 1 mid-flight. */
    fun progress(spec: MotionSpec, elapsedMs: Double): Double {
        if (spec.isSpring) {
            if (elapsedMs >= spec.durationMs) return 1.0
            if (elapsedMs <= 0.0) return 0.0
            return sceneSpring(elapsedMs / 1000.0, spec.stiffness, spec.damping)
        }
        val u = if (spec.durationMs <= 0.0) 1.0 else min(max(elapsedMs / spec.durationMs, 0.0), 1.0)
        if (spec.name == "linear") return u
        return sceneBezier(u, spec.x1, spec.y1, spec.x2, spec.y2)
    }

    /** THE SETTLE LAW: when a clip ends — the authored duration for a curve, the pinned
     *  0.1%-envelope time for a spring (which is what [MotionSpec.durationMs] holds). */
    fun settleMs(spec: MotionSpec): Double = spec.durationMs

    // ── the retarget law (the CSS-transition interruption model, on scalars) ─────────

    /** One in-flight glide: the rendered value travels [from] → [to] starting at [startMs]. */
    class MotionState(val from: Double, val to: Double, val startMs: Double)

    class MotionSample(val value: Double, val done: Boolean)

    fun start(from: Double, to: Double, startMs: Double) = MotionState(from, to, startMs)

    /** The rendered value at [nowMs], and whether the clip has completed (at/after which
     *  the value is EXACTLY `to` — the override retires without a snap). */
    fun value(spec: MotionSpec, state: MotionState, nowMs: Double): MotionSample {
        val elapsed = nowMs - state.startMs
        if (spec.durationMs <= 0.0 || elapsed >= spec.durationMs) return MotionSample(state.to, true)
        val p = progress(spec, elapsed)
        return MotionSample(state.from + (state.to - state.from) * p, false)
    }

    /** THE RETARGET LAW: a new target mid-flight starts a FRESH clip from the CURRENT
     *  rendered value. Never snap to the new target, never queue behind the old clip, and
     *  no special case for retargeting to the value already being animated toward. */
    fun retarget(spec: MotionSpec, state: MotionState, to: Double, nowMs: Double): MotionState =
        MotionState(value(spec, state, nowMs).value, to, nowMs)

    // ── the UI physics primitives (ui-motion.md phase 2) ─────────────────────────────
    //
    // Offsets and dimensions are POINTS; velocities are POINTS PER MILLISECOND. Pure
    // folds the elements call — sheet detents, pagers, pickers, pull-to-refresh and
    // lightbox dismissal all stop re-deriving their own feel.

    /** `UIScrollView.DecelerationRate.normal`, per millisecond. */
    const val DECELERATION_RATE = 0.998
    /** τ = −1 / ln(rate) ms — the decay time constant (≈ 499.499833 ms). */
    val DECAY_TAU_MS: Double = -1.0 / ln(DECELERATION_RATE)
    /** Terminal velocity: at or under this a fling does not move at all (1 pt/s). */
    const val DECAY_MIN_VELOCITY = 0.001
    /** The standard iOS overscroll compression constant. */
    const val RUBBER_BAND_C = 0.55
    /** The overscroll RELEASE spring — critically damped, because a snap-back must never
     *  bounce past the edge it is returning to. */
    val RUBBER_BAND_RELEASE: MotionSpec = spring(0.35, 1.0)

    private fun atRest(v0: Double): Boolean = !(abs(v0) > DECAY_MIN_VELOCITY)

    /** THE DECAY LAW: x(t) = x0 + v0·τ·(1 − e^(−t/τ)). */
    fun decayAt(x0: Double, v0: Double, tMs: Double): Double {
        if (tMs <= 0.0 || atRest(v0)) return x0
        return x0 + v0 * DECAY_TAU_MS * (1.0 - exp(-tMs / DECAY_TAU_MS))
    }

    /** The resting offset — the t → ∞ limit x0 + v0·τ (x0 for a sub-threshold release). */
    fun decayTarget(x0: Double, v0: Double): Double =
        if (atRest(v0)) x0 else x0 + v0 * DECAY_TAU_MS

    /** How long the fling lasts: τ·ln(|v0| / threshold), 0 for a sub-threshold release —
     *  never negative. */
    fun decayDurationMs(v0: Double): Double =
        if (atRest(v0)) 0.0 else DECAY_TAU_MS * ln(abs(v0) / DECAY_MIN_VELOCITY)

    /** THE RUBBER-BAND LAW: f(x) = sign(x)·(1 − 1/(|x|·c/d + 1))·d — asymptotic, so no
     *  amount of finger travel moves the content more than [dimension] past the edge. */
    fun rubberBand(x: Double, dimension: Double, c: Double = RUBBER_BAND_C): Double {
        if (dimension <= 0.0) return 0.0
        val sign = if (x < 0.0) -1.0 else 1.0
        val a = abs(x)
        return sign * (1.0 - 1.0 / (a * c / dimension + 1.0)) * dimension
    }

    /** Its exact inverse — x = (d/c)·(1/(1 − |y|/d) − 1), |y| clamped just inside d — so a
     *  gesture can resume from an already-compressed offset. */
    fun rubberBandInverse(y: Double, dimension: Double, c: Double = RUBBER_BAND_C): Double {
        if (dimension <= 0.0) return 0.0
        val sign = if (y < 0.0) -1.0 else 1.0
        val a = min(abs(y), dimension * 0.999999)
        return sign * (dimension / c) * (1.0 / (1.0 - a / dimension) - 1.0)
    }

    class SnapResult(val projected: Double, val target: Double, val index: Int)

    /** THE SNAP LAW: project the release with the decay fold, then take the NEAREST snap
     *  point to that projection; an exact tie takes the LOWER point (deterministic on all
     *  three runtimes). The one law behind sheet detents, pagers and pickers. */
    fun snapTarget(x0: Double, v0: Double, points: List<Double>): SnapResult {
        val projected = decayTarget(x0, v0)
        if (points.isEmpty()) return SnapResult(projected, projected, -1)
        var bestIndex = 0
        var bestDistance = abs(points[0] - projected)
        for (i in 1 until points.size) {
            val distance = abs(points[i] - projected)
            if (distance < bestDistance - 1e-12 ||
                (abs(distance - bestDistance) <= 1e-12 && points[i] < points[bestIndex])
            ) {
                bestDistance = distance
                bestIndex = i
            }
        }
        return SnapResult(projected, points[bestIndex], bestIndex)
    }

    /** ωₙ of a spring spec — the natural frequency the conversion produced. */
    fun omega(spec: MotionSpec): Double = sqrt(spec.stiffness)
}
