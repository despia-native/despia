//
//  SheetMathTest.kt — plain-JVM units for the sheet wave's pure halves (Sheets.kt):
//  SheetMath (the drag-release detent decision — nearest-stop slow releases, UIKit
//  momentum projection, ahead-of-the-fling snapping, the dismiss line) and SheetMotion
//  (the Stack.swift StackSurface present/dismiss curve constants). The gesture/animation
//  composables themselves are gated by compilation (the RenderSmoke rule).
//

package despia.engine.render

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.TweenSpec
import despia.engine.render.elements.SheetMath
import despia.engine.render.elements.SheetMotion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SheetMathTest {

    // The canonical two-detent sheet: half at 500px, full at 900px (dismiss line = 250).
    private val halfFull = listOf("half" to 500f, "full" to 900f)
    private val fling = 300f                                    // the pinned floor, as px here

    // ── the pinned constants (header DEVIATIONS — UIKit's documented approximations) ──

    @Test fun constantsArePinned() {
        // τ, from the shared motion kernel (Motion.DECAY_TAU_MS / 1000) — this used to be
        // a rounded local 0.499f; it is now the corpus-pinned 0.4994998 s.
        assertEquals(0.4994998f, SheetMath.PROJECTION, 1e-7f)   // UIScrollView .normal deceleration
        assertEquals(300f, SheetMath.FLING_DP_PER_SEC, 0f)      // the fling floor (dp/s)
    }

    @Test fun projectionCoastsWithTheUIKitDeceleration() {
        assertEquals(999.4998f, SheetMath.project(500f, 1000f), 1e-2f)   // travel = v·τ
        assertEquals(0.5002f, SheetMath.project(500f, -1000f), 1e-2f)
        assertEquals(500f, SheetMath.project(500f, 0f), 0f)              // no velocity, no travel
        // The kernel's terminal-velocity gate: a release under 1 px/s does not coast.
        assertEquals(500f, SheetMath.project(500f, 0.5f), 0f)
    }

    // ── slow releases: the NEAREST stop ──────────────────────────────────────────────

    @Test fun slowReleaseParksOnTheNearestStop() {
        assertEquals("half", SheetMath.settleDetent(halfFull, 560f, 0f, fling))
        assertEquals("full", SheetMath.settleDetent(halfFull, 800f, 0f, fling))
        assertEquals("half", SheetMath.settleDetent(halfFull, 560f, 299f, fling))  // under the floor = slow
    }

    @Test fun slowReleaseBelowHalfTheSmallestStopDismisses() {
        assertNull(SheetMath.settleDetent(halfFull, 200f, 0f, fling))   // 200 < 500·0.5
        assertEquals("half", SheetMath.settleDetent(halfFull, 260f, 0f, fling))  // just above the line
    }

    @Test fun emptyStopsDismiss() {
        assertNull(SheetMath.settleDetent(emptyList(), 500f, 0f, fling))
    }

    // ── flings: project, then snap AHEAD of the gesture ──────────────────────────────

    @Test fun flingAtTheFloorIsAFling() {
        // v == floor takes the fling branch (strict <): up from between the stops → full,
        // where a 299 release (slow) parks back on half.
        assertEquals("full", SheetMath.settleDetent(halfFull, 560f, 300f, fling))
        assertEquals("half", SheetMath.settleDetent(halfFull, 560f, 299f, fling))
    }

    @Test fun flingNeverSnapsBackwards() {
        // 510px moving up at 320: the projection (≈670) is NEARER half(500) than full(900),
        // but a fling only considers stops ahead — it advances to full.
        assertEquals("full", SheetMath.settleDetent(halfFull, 510f, 320f, fling))
        // And the mirror: 880px moving down at 320 lands on half, never re-parks on full.
        assertEquals("half", SheetMath.settleDetent(halfFull, 880f, -320f, fling))
    }

    @Test fun hardFlingSkipsIntermediateStops() {
        val three = listOf("content" to 300f, "half" to 600f, "full" to 900f)
        // full → smallest in one gesture: projection 900 − 1200·τ ≈ 300.6 parks on content.
        assertEquals("content", SheetMath.settleDetent(three, 900f, -1200f, fling))
        // A gentler fling from full only reaches half (projection ≈ 650).
        assertEquals("half", SheetMath.settleDetent(three, 900f, -500f, fling))
    }

    @Test fun downwardFlingWithNoStopBelowDismisses() {
        // At the smallest stop, moving down, projection still above the dismiss line
        // (500 − 400·τ ≈ 300.2 ≥ 250) — no stop ahead ⇒ dismiss.
        assertNull(SheetMath.settleDetent(halfFull, 500f, -400f, fling))
    }

    @Test fun flingProjectingPastTheDismissLineDismisses() {
        // 400px moving down at 800: projection ≈ 0.8 < 250 — coasts out before any snap.
        assertNull(SheetMath.settleDetent(halfFull, 400f, -800f, fling))
    }

    @Test fun upwardFlingPastTheTopStopParksOnTop() {
        assertEquals("full", SheetMath.settleDetent(halfFull, 900f, 800f, fling))
    }

    // ── the transition curves (Stack.swift StackSurface present/dismiss) ──────────────

    @Test fun enterSpringCarriesTheStackSurfaceConstants() {
        val spec = SheetMotion.enterSpring() as SpringSpec<Float>
        assertEquals(0.88f, spec.dampingRatio, 0f)              // usingSpringWithDamping: 0.88
        assertEquals(380f, spec.stiffness, 0f)                  // pinned — the ≈0.4s settle
    }

    @Test fun exitTweenIsTheUIKitEaseInOver280ms() {
        val spec = SheetMotion.exitTween() as TweenSpec<Float>
        assertEquals(280, spec.durationMillis)                  // withDuration: 0.28
        // The exact .curveEaseIn bezier (0.42, 0, 1, 1) — compare the curve, not identity.
        val expected = CubicBezierEasing(0.42f, 0f, 1f, 1f)
        for (t in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) {
            assertEquals(expected.transform(t), spec.easing.transform(t), 1e-4f)
        }
    }
}
