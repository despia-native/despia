//
//  StackMotionTest.kt — plain-JVM units for the motion vocabulary's pure halves
//  (StackMotion.kt): the anim=/animDuration= grammar (Swift StackStyle.animation),
//  the spring translation, the transition slide edges (Swift StackStyle.transition),
//  the enter= starting pose (Swift StackEntry), and the keep-fade default. The
//  Compose animation RUNTIME (AnimatedVisibility choreography, animateFloatAsState)
//  is behavior compilation + the smoke gate pin — untestable off-device (RenderSmoke
//  rule), the numbers below ARE the contract it plays back.
//

package despia.engine.render

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.TweenSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class StackMotionTest {

    // ── animation(): the anim= grammar (Stack.swift ~4671) ────────────────────────────

    @Test fun defaultIsEaseInOutAt350ms() {
        val m = StackMotion.animation(null, null) as MotionSpec.Curve
        assertEquals(350, m.durationMs)                          // SwiftUI default duration
        assertEquals(listOf(0.42f, 0f, 0.58f, 1f), listOf(m.x1, m.y1, m.x2, m.y2))
        assertEquals(m, StackMotion.animation("easeInOut", null))
        assertEquals(m, StackMotion.animation("bogus", null))    // unknown token → the default curve
    }

    @Test fun namedCurvesCarryTheirBeziers() {
        val easeIn = StackMotion.animation("easeIn", null) as MotionSpec.Curve
        assertEquals(listOf(0.42f, 0f, 1f, 1f), listOf(easeIn.x1, easeIn.y1, easeIn.x2, easeIn.y2))
        val easeOut = StackMotion.animation("easeOut", null) as MotionSpec.Curve
        assertEquals(listOf(0f, 0f, 0.58f, 1f), listOf(easeOut.x1, easeOut.y1, easeOut.x2, easeOut.y2))
        val linear = StackMotion.animation("linear", null) as MotionSpec.Curve
        assertSame(LinearEasing, StackMotion.easing(linear))     // (0,0,1,1) resolves to the linear easing
    }

    @Test fun animDurationIsSecondsForCurves() {
        val m = StackMotion.animation("easeOut", "0.2") as MotionSpec.Curve
        assertEquals(200, m.durationMs)
        // Swift Double(String) grammar via JSE — a junk duration falls back to the default.
        assertEquals(350, (StackMotion.animation("easeOut", "fast") as MotionSpec.Curve).durationMs)
    }

    @Test fun springIsResponse04Damping08AndDurationSetsResponse() {
        val s = StackMotion.animation("spring", null) as MotionSpec.Spring
        assertEquals(0.4, s.response, 1e-9)
        assertEquals(0.8, s.dampingFraction, 1e-9)
        val slow = StackMotion.animation("spring", "0.8") as MotionSpec.Spring
        assertEquals(0.8, slow.response, 1e-9)                   // animDuration sets RESPONSE (Stack.swift)
    }

    @Test fun springTranslationMatchesTheOscillatorIdentity() {
        // stiffness = (2π/response)², mass 1 — response 0.4 ≈ 246.74.
        assertEquals(246.74f, StackMotion.stiffness(0.4), 0.01f)
        val spec = StackMotion.spec<Float>(MotionSpec.Spring(0.4, 0.8)) as SpringSpec<Float>
        assertEquals(0.8f, spec.dampingRatio, 1e-6f)
        assertEquals(246.74f, spec.stiffness, 0.01f)
    }

    @Test fun curveSpecIsATweenOfTheParsedDuration() {
        val spec = StackMotion.spec<Float>(StackMotion.animation("easeIn", "0.5")) as TweenSpec<Float>
        assertEquals(500, spec.durationMillis)
    }

    // ── transition tokens (Stack.swift ~4657): the slide edges, fade fallback ─────────

    @Test fun slideEdgesMatchTheIOSVocabulary() {
        assertEquals(1 to 0, StackMotion.slideEdge("slide-right"))
        assertEquals(-1 to 0, StackMotion.slideEdge("slide-left"))
        assertEquals(0 to 1, StackMotion.slideEdge("slide-bottom"))
        assertEquals(0 to -1, StackMotion.slideEdge("slide-top"))
        assertNull(StackMotion.slideEdge("fade"))
        assertNull(StackMotion.slideEdge("scale"))
        assertNull(StackMotion.slideEdge("wiggle"))              // unknown → fade path
        assertNull(StackMotion.slideEdge(null))                  // bare anim= → default fade
    }

    @Test fun transitionsBuildForEveryToken() {
        // The EnterTransition/ExitTransition internals are opaque; the contract here is
        // total construction (every token yields a transition, nothing throws).
        val m = StackMotion.animation("spring", null)
        for (t in listOf(null, "fade", "scale", "slide-top", "slide-bottom", "slide-left", "slide-right", "junk")) {
            StackMotion.enter(t, m)
            StackMotion.exit(t, m)
        }
    }

    // ── enter= starting pose (Swift StackEntry.body) ───────────────────────────────────

    @Test fun entrySlidesStartAFullScreenOffAndStayOpaque() {
        val r = StackMotion.entryStart("slide-right", 390f, 844f)
        assertEquals(390f, r.dx, 0f); assertEquals(0f, r.dy, 0f)
        assertEquals(1f, r.alpha, 0f)                            // slides stay opaque — off-screen
        assertEquals(1f, r.scale, 0f)
        val b = StackMotion.entryStart("slide-bottom", 390f, 844f)
        assertEquals(844f, b.dy, 0f)
        val l = StackMotion.entryStart("slide-left", 390f, 844f)
        assertEquals(-390f, l.dx, 0f)
        val t = StackMotion.entryStart("slide-top", 390f, 844f)
        assertEquals(-844f, t.dy, 0f)
    }

    @Test fun entryFadeScaleAndUnknownFadeIn() {
        val f = StackMotion.entryStart("fade", 390f, 844f)
        assertEquals(0f, f.alpha, 0f); assertEquals(1f, f.scale, 0f)
        val s = StackMotion.entryStart("scale", 390f, 844f)
        assertEquals(0f, s.alpha, 0f)
        assertEquals(0.92f, s.scale, 1e-6f)                      // the StackEntry 0.92 pop
        val u = StackMotion.entryStart("mystery", 390f, 844f)    // unknown → fade
        assertEquals(0f, u.alpha, 0f); assertEquals(1f, u.scale, 0f)
        assertEquals(0f, u.dx, 0f); assertEquals(0f, u.dy, 0f)
    }

    // ── keep="true" default fade (Swift .easeOut(duration: 0.18)) ──────────────────────

    @Test fun keepFadeIsEaseOut180ms() {
        assertEquals(180, StackMotion.KEEP_FADE.durationMs)
        assertEquals(listOf(0f, 0f, 0.58f, 1f),
                     listOf(StackMotion.KEEP_FADE.x1, StackMotion.KEEP_FADE.y1,
                            StackMotion.KEEP_FADE.x2, StackMotion.KEEP_FADE.y2))
        assertTrue(StackMotion.spec<Float>(StackMotion.KEEP_FADE) is TweenSpec)
    }
}
