package despia.engine.render

import org.junit.Assert.assertEquals
import org.junit.Test

//
//  Pins the `<pressable>` multi-gesture contract (Pressable.swift header, the TikTok model)
//  on the pure recognizer machine — Conformance/elements/pressable.json is the fixture:
//  on:tap fires INSTANTLY on every tap-up including each tap of a double, on:doubleTap fires
//  ADDITIONALLY on the second, long-press is a balanced begin/end lifecycle at the 0.4 s
//  hold, and a plain tap fires neither long event.
//
class PressableGestureMachineTest {

    private fun machine(
        primary: Boolean = true,
        double: Boolean = true,
        long: Boolean = true,
        window: Long = 300,
    ) = PressableGestureMachine(
        hasPrimary = primary, hasDouble = double, hasLong = long, doubleTapWindowMillis = window)

    @Test
    fun everyTapUpFiresPrimaryInstantlyAndTheSecondAddsDouble() {
        val m = machine()
        m.down(0)
        assertEquals(listOf(PressableEvent.Primary), m.up(80))
        m.down(200)   // within the 300 ms window of the first tap-up
        assertEquals(listOf(PressableEvent.Primary, PressableEvent.Double), m.up(260))
    }

    @Test
    fun aConsumedDoubleChainResetsSoTheThirdTapIsPrimaryOnly() {
        val m = machine()
        m.down(0); m.up(80)
        m.down(200); m.up(260)                       // the double
        m.down(400)                                  // within 300 of 260 — but the chain reset
        assertEquals(listOf(PressableEvent.Primary), m.up(460))
    }

    @Test
    fun aLateSecondTapOutsideTheWindowIsAFreshPrimary() {
        val m = machine()
        m.down(0); m.up(80)
        m.down(500)                                  // 420 ms after the tap-up — window is 300
        assertEquals(listOf(PressableEvent.Primary), m.up(560))
    }

    @Test
    fun aRecognizedHoldFiresBeginThenBalancesEndOnLiftAndSuppressesPrimary() {
        val m = machine()
        m.down(0)
        assertEquals(listOf(PressableEvent.LongBegin), m.holdElapsed())
        assertEquals(listOf(PressableEvent.LongEnd), m.up(900))
    }

    @Test
    fun aPlainTapReleasedBeforeTheHoldFiresNeitherLongEvent() {
        val m = machine()
        m.down(0)
        assertEquals(listOf(PressableEvent.Primary), m.up(120))
    }

    @Test
    fun aSlowReleaseWithNoLongHandlerStaysATap() {
        // The disabled-recognizer arm (Pressable.swift setRecognizer): only tap+double are
        // declared, so a 1 s hold then release still fires primary.
        val m = machine(long = false)
        m.down(0)
        assertEquals(emptyList<PressableEvent>(), m.holdElapsed())
        assertEquals(listOf(PressableEvent.Primary), m.up(1000))
    }

    @Test
    fun movementPastTheSlopKillsTheGesture() {
        val m = machine()
        m.down(0)
        m.moved()
        assertEquals(emptyList<PressableEvent>(), m.holdElapsed())   // no long recognition
        assertEquals(emptyList<PressableEvent>(), m.up(500))         // no tap either
    }

    @Test
    fun movementAfterRecognitionStillBalancesTheEnd() {
        val m = machine()
        m.down(0)
        assertEquals(listOf(PressableEvent.LongBegin), m.holdElapsed())
        m.moved()                                     // post-recognition travel is legal
        assertEquals(listOf(PressableEvent.LongEnd), m.up(900))
    }

    @Test
    fun cancelAfterRecognitionBalancesTheEndAndCancelBeforeFiresNothing() {
        val recognized = machine()
        recognized.down(0)
        recognized.holdElapsed()
        assertEquals(listOf(PressableEvent.LongEnd), recognized.cancel())

        val fresh = machine()
        fresh.down(0)
        assertEquals(emptyList<PressableEvent>(), fresh.cancel())
    }

    @Test
    fun aRecognizedHoldNeverJoinsADoubleChain() {
        val m = machine()
        m.down(0); m.up(80)                          // first tap
        m.down(200)                                  // second tap begins in the window…
        assertEquals(listOf(PressableEvent.LongBegin), m.holdElapsed())   // …but becomes a hold
        assertEquals(listOf(PressableEvent.LongEnd), m.up(900))           // no Primary, no Double
        m.down(1000)                                 // and the chain did not survive the hold
        assertEquals(listOf(PressableEvent.Primary), m.up(1060))
    }

    @Test
    fun aMovedGestureResetsTheDoubleChain() {
        val m = machine()
        m.down(0); m.up(80)
        m.down(200); m.moved()
        assertEquals(emptyList<PressableEvent>(), m.up(260))   // dead gesture
        m.down(400)
        assertEquals(listOf(PressableEvent.Primary), m.up(460))   // fresh, not a double
    }

    @Test
    fun aDoubleTapOnlySurfaceFiresJustTheDoubleOnTheSecondUp() {
        val m = machine(primary = false, long = false)
        m.down(0)
        assertEquals(emptyList<PressableEvent>(), m.up(80))
        m.down(200)
        assertEquals(listOf(PressableEvent.Double), m.up(260))
    }
}
