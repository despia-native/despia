//
//  RouterHostTest.kt — plain-JVM units for the frame host's pure halves (RouterHost.kt):
//  the stack-diff → transition classification (`RouterStackDiff` — one transition per
//  publish, prefix-matched push/pop, everything else silent), the screen-presentation pose
//  math (`RouterMotion` — the declared StackMotion default spec + the pinned iOS-family
//  parallax/dim figures), and the canonical `routeFrameRoot` (the host shell delegates
//  here; RouteFrameRootTest pins the same contract through the delegate). The composables
//  themselves are gated by compilation (:render:assembleDebug) — RouterTest (:core) pins
//  the state shapes they consume.
//

package despia.engine.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterHostTest {

    // ── RouterStackDiff.classify: ONE transition per publish ────────────────────────────

    @Test fun equalStacksAreNoChange() {
        assertEquals(RouterStackDiff.Kind.NONE, RouterStackDiff.classify(listOf(1, 2), listOf(1, 2)))
        assertEquals(RouterStackDiff.Kind.NONE, RouterStackDiff.classify(emptyList(), emptyList()))
    }

    @Test fun aGrownMatchingPrefixIsAPush() {
        assertEquals(RouterStackDiff.Kind.PUSH, RouterStackDiff.classify(listOf(1), listOf(1, 2)))
        // a multi-push is still ONE push transition (old top → new top)
        assertEquals(RouterStackDiff.Kind.PUSH, RouterStackDiff.classify(listOf(1), listOf(1, 2, 3)))
    }

    @Test fun aShrunkMatchingPrefixIsAPop() {
        assertEquals(RouterStackDiff.Kind.POP, RouterStackDiff.classify(listOf(1, 2), listOf(1)))
        // popTo / popToRoot: a multi-pop is ONE pop transition (the popto.json contract)
        assertEquals(RouterStackDiff.Kind.POP, RouterStackDiff.classify(listOf(1, 2, 3, 4), listOf(1)))
    }

    @Test fun everythingElseSwapsSilently() {
        // boot: the first adopted stack never animates (the silence rule)
        assertEquals(RouterStackDiff.Kind.SWAP, RouterStackDiff.classify(emptyList(), listOf(1)))
        assertEquals(RouterStackDiff.Kind.SWAP, RouterStackDiff.classify(listOf(1), emptyList()))
        // replace: same depth, new top id
        assertEquals(RouterStackDiff.Kind.SWAP, RouterStackDiff.classify(listOf(1, 2), listOf(1, 3)))
        // reset / root heal: the root id changed
        assertEquals(RouterStackDiff.Kind.SWAP, RouterStackDiff.classify(listOf(1, 2), listOf(3)))
        // grown but the prefix does not match
        assertEquals(RouterStackDiff.Kind.SWAP, RouterStackDiff.classify(listOf(1, 2), listOf(1, 3, 4)))
    }

    @Test fun frameIdCoercesLikeTheRouter() {
        assertEquals(7, RouterStackDiff.frameId(7))
        assertEquals(7, RouterStackDiff.frameId(7.0))     // a JSON round-trip's Double
        assertNull(RouterStackDiff.frameId("7"))
        assertNull(RouterStackDiff.frameId(null))
    }

    // ── RouterMotion: the declared figures, never invented ──────────────────────────────

    @Test fun navSpecIsTheDeclaredStackMotionDefault() {
        // StackMotion.animation(null, null): SwiftUI easeInOut, 0.35 s — the vocabulary's
        // default (Stack.swift StackStyle.animation), the closest DECLARED token to the
        // system NavigationStack transition iOS rides.
        val spec = RouterMotion.NAV
        assertTrue(spec is MotionSpec.Curve)
        spec as MotionSpec.Curve
        assertEquals(StackMotion.DEFAULT_DURATION_MS, spec.durationMs)
        assertEquals(StackMotion.EASE_IN_OUT[0], spec.x1, 0f)
        assertEquals(StackMotion.EASE_IN_OUT[1], spec.y1, 0f)
        assertEquals(StackMotion.EASE_IN_OUT[2], spec.x2, 0f)
        assertEquals(StackMotion.EASE_IN_OUT[3], spec.y2, 0f)
    }

    @Test fun posesFollowTheCoverageParameter() {
        val w = 1000f
        // top: off the trailing edge at coverage 0, at rest at 1
        assertEquals(w, RouterMotion.topX(w, 0f), 0f)
        assertEquals(0f, RouterMotion.topX(w, 1f), 0f)
        assertEquals(w / 2f, RouterMotion.topX(w, 0.5f), 0f)
        // under: the −20% iOS-family rest when fully covered, home when revealed
        assertEquals(-200f, RouterMotion.underX(w, 1f), 0f)
        assertEquals(0f, RouterMotion.underX(w, 0f), 0f)
        // dim: the 0.1 iOS-family peak, linear in coverage
        assertEquals(0.1f, RouterMotion.underDim(1f), 1e-6f)
        assertEquals(0.05f, RouterMotion.underDim(0.5f), 1e-6f)
        assertEquals(0f, RouterMotion.underDim(0f), 0f)
    }

    @Test fun coverageClampsAndGestureMapsInverted() {
        // out-of-range coverage clamps (a spring overshoot must not fling the under screen)
        assertEquals(0f, RouterMotion.topX(1000f, 1.5f), 0f)
        assertEquals(1000f, RouterMotion.topX(1000f, -0.5f), 0f)
        assertEquals(0.1f, RouterMotion.underDim(2f), 1e-6f)
        // the system back-gesture progress drives pop coverage directly (1 − p, clamped)
        assertEquals(1f, RouterMotion.gestureCoverage(0f), 0f)
        assertEquals(0f, RouterMotion.gestureCoverage(1f), 0f)
        assertEquals(0.75f, RouterMotion.gestureCoverage(0.25f), 1e-6f)
        assertEquals(1f, RouterMotion.gestureCoverage(-1f), 0f)
        assertEquals(0f, RouterMotion.gestureCoverage(2f), 0f)
    }

    @Test fun predictiveSettleKeepsTheDeclaredCurveAndScalesToRemainingDistance() {
        val half = RouterMotion.settleSpec(0.5f, 0f) as MotionSpec.Curve
        assertEquals(StackMotion.DEFAULT_DURATION_MS / 2, half.durationMs)
        assertEquals(StackMotion.EASE_IN_OUT[0], half.x1, 0f)
        assertEquals(StackMotion.EASE_IN_OUT[1], half.y1, 0f)
        assertEquals(StackMotion.EASE_IN_OUT[2], half.x2, 0f)
        assertEquals(StackMotion.EASE_IN_OUT[3], half.y2, 0f)

        assertEquals(
            StackMotion.DEFAULT_DURATION_MS,
            (RouterMotion.settleSpec(1f, 0f) as MotionSpec.Curve).durationMs,
        )
        assertEquals(
            35,
            (RouterMotion.settleSpec(0.1f, 0f) as MotionSpec.Curve).durationMs,
        )
        assertEquals(
            0,
            (RouterMotion.settleSpec(-1f, -2f) as MotionSpec.Curve).durationMs,
        )
    }

    @Test fun systemBackOnlyConsumesWhenARealDestinationExists() {
        assertFalse(RouterBackDispatch.canPop(0))
        assertFalse(RouterBackDispatch.canPop(1))
        assertTrue(RouterBackDispatch.canPop(2))
        assertTrue(RouterBackDispatch.canPop(3))
    }

    @Test fun committedPredictiveBackEnablesAnotherRapidPopFromTheNewDepth() {
        // The first API 34+ completed callback adopts depth 2 synchronously. Its return value
        // must keep the callback enabled so a second hardware Back 75 ms later can commit root
        // while the first visual settle is still drawing.
        assertTrue(RouterBackDispatch.canPop(2))
        assertFalse(RouterBackDispatch.canPop(1))
    }

    @Test fun repeatedBackCoalescesOnlyAnExistingPopWithAnotherDestination() {
        assertTrue(RouterBackDispatch.coalescesRapidPop(inFlightIsPop = true, stackDepth = 3))
        assertTrue(RouterBackDispatch.coalescesRapidPop(inFlightIsPop = true, stackDepth = 2))
        assertFalse(RouterBackDispatch.coalescesRapidPop(inFlightIsPop = true, stackDepth = 1))
        assertFalse(RouterBackDispatch.coalescesRapidPop(inFlightIsPop = false, stackDepth = 3))
    }

    @Test fun queuedSecondBackStillCountsAsRapidAfterTheFirstSettle() {
        assertEquals(800L, RouterBackDispatch.RAPID_POP_WINDOW_MS)
        assertTrue(RouterBackDispatch.followsRecentPop(lastCommitAtMs = 1_000, nowMs = 1_800))
        assertFalse(RouterBackDispatch.followsRecentPop(lastCommitAtMs = 1_000, nowMs = 1_801))
        assertFalse(RouterBackDispatch.followsRecentPop(lastCommitAtMs = -1, nowMs = 100))
        assertFalse(RouterBackDispatch.followsRecentPop(lastCommitAtMs = 200, nowMs = 100))
    }

    // ── routeFrameRoot: the canonical copy (the host shell delegates here) ──────────────

    @Test fun nativeStarterFrameBuildsTheRegisteredDsxTag() {
        val root = routeFrameRoot(
            mapOf("id" to 1, "view" to "DSXStartup", "src" to "", "path" to "/", "origin" to ""))
        assertEquals("DSXStartup", root?.tag)
        assertEquals(mapOf("src" to "", "path" to "/", "origin" to ""), root?.attrs)
    }

    @Test fun explicitWebFrameRemainsADataDrivenRendererChoice() {
        val root = routeFrameRoot(
            mapOf("view" to "DSXWebView", "src" to "/app", "path" to "/inbox?filter=new",
                  "origin" to "https://app.example.com"))
        assertEquals("DSXWebView", root?.tag)
        assertEquals("/app", root?.attrs?.get("src"))
        assertEquals("/inbox?filter=new", root?.attrs?.get("path"))
        assertEquals("https://app.example.com", root?.attrs?.get("origin"))
    }

    @Test fun heldNativeAndMalformedFramesDoNotCreateDuplicateRoots() {
        assertNull(routeFrameRoot(mapOf("native" to true, "view" to "__native")))
        assertNull(routeFrameRoot(mapOf("view" to "   ")))
        assertNull(routeFrameRoot(null))
    }
}
