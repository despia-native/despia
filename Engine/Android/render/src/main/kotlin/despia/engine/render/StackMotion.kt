//
//  StackMotion.kt — the DSX motion vocabulary for the Compose renderer. Kotlin twin of
//  Stack.swift's animation surface, one file for the three iOS pieces:
//
//    • `StackStyle.animation(_:duration:)` (Stack.swift ~4671) — the `anim=` curve
//      grammar: spring (response 0.4, damping 0.8; animDuration sets RESPONSE) ·
//      linear · easeIn · easeOut · easeInOut (default). Curve durations default to
//      SwiftUI's 0.35 s; the curves are the SwiftUI unit beziers (easeIn 0.42,0,1,1 ·
//      easeOut 0,0,0.58,1 · easeInOut 0.42,0,0.58,1). Parsed into a PURE `MotionSpec`
//      (JVM-testable), mapped to a Compose AnimationSpec at the edge.
//
//      SINCE THE UI MOTION ENGINE LANDED (architecture/proposals/ui-motion.md), NONE OF
//      THOSE NUMBERS ARE DECIDED HERE. The grammar, the defaults, the unit beziers and
//      the spring conversion all come from the SHARED kernel — :core `despia.engine.Motion`,
//      corpus-pinned in OpenSource/Conformance/motion/ and executed by the TS, Kotlin and
//      Swift runners over the same files. This lane keeps only the COMPOSE EDGE: the
//      render-local `MotionSpec` shape (which the router's duration-scaling fold copies)
//      and the AnimationSpec/EnterTransition/ExitTransition mapping.
//    • `StackStyle.transition(_:)` (Stack.swift ~4657) — the `transition=` enter/leave
//      style, each combined with a fade: fade · scale (from 0, the SwiftUI .scale) ·
//      slide-top/bottom/left/right (move from that edge BY THE ELEMENT'S OWN SIZE —
//      SwiftUI .move; unknown tokens → fade). Applied via AnimatedVisibility.
//    • `StackEntry` (Stack.swift ~3617) — the `enter=` entry animation (HTML
//      @starting-style): the element renders at its FINAL layout from frame one and
//      animates in purely via offset/opacity/scale (a slide travels from the SCREEN
//      edge; fade/scale/unknown fade in; slides stay opaque). One shot, on appear.
//
//  ── DEVIATIONS from the Swift twin (each pinned, none silent) ────────────────────
//  • SwiftUI animates each property under one Animation; here ONE progress float
//    animates with the spec and offset/alpha/scale map linearly onto it — the same
//    trajectories (every property is a linear function of the animated parameter).
//  • spring: SwiftUI .spring(response:dampingFraction:) → Compose spring(dampingRatio,
//    stiffness) via the physics identity stiffness = (2π/response)² (mass 1) — the
//    same oscillator, exact parameter translation.
//  • `enter=` arms ONCE PER COMPOSITION of the node's content: iOS arms StackEntry
//    even while `visible-if` hides the element (the empty Group still "appears"), so
//    an initially-hidden element never entry-animates on iOS; here the entry plays
//    when the element first composes (insertion). Divergence pinned — it surfaces
//    only for enter= + an initially-false visible-if on the SAME element.
//  • AnimatedVisibility (the transition= vehicle) is a wrapper layout node that hugs
//    its content; SwiftUI transitions the element in place. While fully hidden the
//    wrapper is NOT composed (StackNodeView skips it once the exit settles), so a
//    spaced stack shows no phantom gap — layout parity is exact at rest.
//

package despia.engine.render

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.IntOffset
import despia.engine.Motion
import kotlin.math.roundToInt

// MARK: - MotionSpec — the PURE parse of anim=/animDuration= (JVM-testable)

internal sealed class MotionSpec {
    /// A named curve: SwiftUI unit-bezier control points + duration (ms).
    data class Curve(val durationMs: Int, val x1: Float, val y1: Float, val x2: Float, val y2: Float) : MotionSpec()

    /// SwiftUI .spring(response:dampingFraction:).
    data class Spring(val response: Double, val dampingFraction: Double) : MotionSpec()
}

internal object StackMotion {

    /// The SwiftUI unit beziers (== the CSS timing functions of the same names), READ
    /// FROM THE KERNEL (`Motion.CURVES`) — this lane no longer holds a curve table.
    private fun kernelCurve(name: String): FloatArray =
        Motion.CURVES.getValue(name).let { floatArrayOf(it[0].toFloat(), it[1].toFloat(), it[2].toFloat(), it[3].toFloat()) }

    val EASE_IN: FloatArray = kernelCurve("easeIn")
    val EASE_OUT: FloatArray = kernelCurve("easeOut")
    val EASE_IN_OUT: FloatArray = kernelCurve("easeInOut")
    val LINEAR: FloatArray = kernelCurve("linear")

    /// SwiftUI's default curve duration (`.easeInOut` et al. with no duration) — 0.35 s.
    val DEFAULT_DURATION_MS: Int = Motion.DEFAULT_DURATION_MS.roundToInt()

    /// The COMPOSE EDGE of a kernel MotionSpec — the ONE place a shared spec becomes a
    /// render-lane one. Nothing below this line invents a number.
    private fun edge(m: despia.engine.MotionSpec): MotionSpec =
        if (m.isSpring) MotionSpec.Spring(response = m.response, dampingFraction = m.dampingFraction)
        else MotionSpec.Curve(
            durationMs = m.durationMs.roundToInt().coerceAtLeast(0),
            x1 = m.x1.toFloat(), y1 = m.y1.toFloat(), x2 = m.x2.toFloat(), y2 = m.y2.toFloat(),
        )

    /// The keep="true" default fade — the kernel's pinned `keep` preset (Swift
    /// `.easeOut(duration: 0.18)`: snappy, not faded).
    val KEEP_FADE: MotionSpec.Curve = edge(Motion.PRESET_KEEP) as MotionSpec.Curve

    /// The button PRESS SNAP — the kernel's pinned `press` preset; Swift
    /// `StackButtonStyle.makeBody`'s `.animation(.easeOut(duration: 0.12), value:
    /// configuration.isPressed)` (Stack.swift ~4494-4499), the curve behind the 0.92
    /// press scale.
    val PRESS_SNAP: MotionSpec.Curve = edge(Motion.PRESET_PRESS) as MotionSpec.Curve

    /// Twin of Swift `StackStyle.animation(_:duration:)` — the `anim=` grammar, PARSED BY
    /// THE SHARED KERNEL (`Motion.parse`, corpus-pinned) and only mapped to the Compose
    /// edge here. For `spring`, `animDuration` sets the RESPONSE (Stack.swift:
    /// `.spring(response: d ?? 0.4, dampingFraction: 0.8)`); for the curves the duration
    /// in seconds. A malformed word falls back with one kernel diagnostic (Article 7).
    fun animation(name: String?, duration: String?): MotionSpec =
        edge(Motion.parse(name, duration))

    /// spring response → Compose stiffness: the kernel's conversion (the damped-oscillator
    /// identity stiffness = (2π / response)², mass 1) — the same physical spring, and the
    /// same number the SwiftUI and web renderers use.
    fun stiffness(response: Double): Float =
        Motion.springConstants(if (response > 0.0) response else Motion.SPRING_DEFAULT_RESPONSE, 1.0)[0].toFloat()

    /// The Compose AnimationSpec for a parsed MotionSpec. `visibilityThreshold`
    /// matters only for spring specs over vector types (IntOffset slides).
    fun <T> spec(m: MotionSpec, visibilityThreshold: T? = null): FiniteAnimationSpec<T> = when (m) {
        is MotionSpec.Spring -> spring(
            dampingRatio = m.dampingFraction.toFloat(),
            stiffness = stiffness(m.response),
            visibilityThreshold = visibilityThreshold,
        )
        is MotionSpec.Curve -> tween(m.durationMs, easing = easing(m))
    }

    fun easing(m: MotionSpec.Curve): Easing =
        if (m.x1 == 0f && m.y1 == 0f && m.x2 == 1f && m.y2 == 1f) LinearEasing
        else CubicBezierEasing(m.x1, m.y1, m.x2, m.y2)

    // MARK: - transition= (Swift StackStyle.transition — AnyTransition per token)

    /// The slide edge for a transition/enter token as unit signs (dx, dy) —
    /// +1 = from the trailing/bottom edge, -1 = from the leading/top edge.
    /// null = not a slide (fade/scale/unknown). Pure — the JVM-testable half.
    fun slideEdge(token: String?): Pair<Int, Int>? = when (token) {
        "slide-right" -> 1 to 0
        "slide-left" -> -1 to 0
        "slide-bottom" -> 0 to 1
        "slide-top" -> 0 to -1
        else -> null
    }

    /// `transition=` insertion — every token combines with a fade (Swift
    /// `.combined(with: .opacity)`); a bare `anim=` with no transition token is
    /// SwiftUI's DEFAULT insertion transition, which is also the fade.
    fun enter(token: String?, m: MotionSpec): EnterTransition {
        val fade = fadeIn(spec(m))
        val edge = slideEdge(token) ?: return when (token) {
            "scale" -> scaleIn(spec(m), initialScale = 0f) + fade   // SwiftUI .scale grows from 0
            else -> fade                                            // fade / null / unknown
        }
        val (dx, dy) = edge
        return if (dx != 0) slideInHorizontally(spec(m, IntOffset.VisibilityThreshold)) { dx * it } + fade
        else slideInVertically(spec(m, IntOffset.VisibilityThreshold)) { dy * it } + fade
    }

    /// `transition=` removal — SwiftUI transitions are symmetric: the element
    /// moves back out toward the same edge, fading.
    fun exit(token: String?, m: MotionSpec): ExitTransition {
        val fade = fadeOut(spec(m))
        val edge = slideEdge(token) ?: return when (token) {
            "scale" -> scaleOut(spec(m), targetScale = 0f) + fade
            else -> fade
        }
        val (dx, dy) = edge
        return if (dx != 0) slideOutHorizontally(spec(m, IntOffset.VisibilityThreshold)) { dx * it } + fade
        else slideOutVertically(spec(m, IntOffset.VisibilityThreshold)) { dy * it } + fade
    }

    // MARK: - enter= (Swift StackEntry — the @starting-style entry)

    /// The starting pose for an `enter=` token (Swift StackEntry.body): slides
    /// start a full SCREEN off on their axis and stay opaque; fade/scale (and
    /// unknown tokens) fade in from 0; scale additionally grows 0.92 → 1.
    data class EntryStart(val dx: Float, val dy: Float, val scale: Float, val alpha: Float)

    fun entryStart(token: String, screenW: Float, screenH: Float): EntryStart {
        val edge = slideEdge(token)
        val dx = (edge?.first ?: 0) * screenW
        val dy = (edge?.second ?: 0) * screenH
        val slides = dx != 0f || dy != 0f
        return EntryStart(
            dx = dx, dy = dy,
            scale = if (token == "scale") 0.92f else 1f,
            alpha = if (slides) 1f else 0f,   // slides stay opaque — they're off-screen
        )
    }

    /// The `enter=` modifier — layout-stable by construction (graphicsLayer only:
    /// translation/alpha/scale never touch measurement, the .offset/.opacity/
    /// .scaleEffect twin). Armed on first composition (`shown` flips in a
    /// LaunchedEffect, animated by the anim= spec) — see the header pin for the
    /// visible-if arming divergence.
    @Composable
    fun Modifier.entry(token: String, m: MotionSpec): Modifier {
        var shown by remember { mutableStateOf(false) }
        LaunchedEffect(Unit) { shown = true }
        val progress by animateFloatAsState(if (shown) 1f else 0f, spec(m), label = "dsx-enter")
        val containerSize = LocalWindowInfo.current.containerSize
        val screenW = containerSize.width.toFloat()
        val screenH = containerSize.height.toFloat()
        if (progress >= 1f) return this   // settled — zero-cost steady state
        val start = entryStart(token, screenW, screenH)
        return graphicsLayer {
            translationX = start.dx * (1f - progress)
            translationY = start.dy * (1f - progress)
            alpha = start.alpha + (1f - start.alpha) * progress
            scaleX = start.scale + (1f - start.scale) * progress
            scaleY = scaleX
        }
    }
}
