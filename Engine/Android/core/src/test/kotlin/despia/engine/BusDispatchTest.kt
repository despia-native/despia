package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// X1 H5, stated as a test: a native component's bus call must report the SETTLE, not the
/// CLAIM. The old shape answered the claim (Swift) or nothing at all (Kotlin), so a component
/// gating a side effect on it failed OPEN — a REFUSED call is still a claimed one, which is how
/// AdMob's inline consent gate read correctly in source and requested the vendor banner anyway.
///
/// Every case below is the same question asked once per outcome: what does a component learn?
class BusDispatchTest {

    @AfterTest fun restoreSeam() { JSERunner.moduleHandle = { _, _, _ -> false } }

    /// Stand in for the registry: `claimed` is what the mount answers, `outcome` is what the
    /// module settles with (null = claimed and still in flight).
    private fun seam(claimed: Boolean, outcome: JSEModuleOutcome?, async: Boolean = false):
        MutableList<(JSEModuleOutcome) -> Unit> {
        val parked = mutableListOf<(JSEModuleOutcome) -> Unit>()
        JSERunner.moduleHandle = { _, _, onTerminal ->
            if (outcome != null) { if (async) parked.add(onTerminal) else onTerminal(outcome) }
            claimed
        }
        return parked
    }

    // -- the failure mode itself --

    @Test fun aRefusedCallIsNotASuccess() {
        seam(claimed = true, outcome = JSEModuleOutcome.Error("consent_required", mapOf("gdpr" to true)))
        val v = DSXBusDispatch.run("admob.load", mapOf("view" to "inline"))
        assertTrue(v.claimed, "the module DID take the call — that was never in question")
        assertTrue(v.settled)
        assertFalse(v.succeeded, "the whole defect: a refused load must never read as a loaded one")
        assertEquals("consent_required", v.code)
        assertEquals(mapOf("gdpr" to true), v.value)
        assertEquals("admob", v.scheme)
        assertEquals("load", v.action)
    }

    @Test fun aResolvedCallSucceeds() {
        seam(claimed = true, outcome = JSEModuleOutcome.Resolve(mapOf("filled" to true)))
        val v = DSXBusDispatch.run("admob.load", emptyMap())
        assertTrue(v.claimed)
        assertTrue(v.settled)
        assertTrue(v.succeeded)
        assertNull(v.code)
        assertEquals(mapOf("filled" to true), v.value)
    }

    // -- the three fail-closed readings --

    @Test fun anUnclaimedCallIsUnavailableAndNotASuccess() {
        seam(claimed = false, outcome = null)
        val v = DSXBusDispatch.run("ghost.load", emptyMap())
        assertFalse(v.claimed)
        assertFalse(v.settled)
        assertFalse(v.succeeded)
        assertEquals("unavailable", v.code, "the spelling the markup path already raises")
    }

    @Test fun anInFlightCallIsNotYetASuccess() {
        seam(claimed = true, outcome = JSEModuleOutcome.Resolve("later"), async = true)
        val v = DSXBusDispatch.run("stream.join", emptyMap())
        assertTrue(v.claimed, "claimed is the ONE thing that is known synchronously")
        assertFalse(v.settled)
        assertFalse(v.succeeded, "a gate must not open on an answer that has not arrived")
        assertNull(v.code, "in flight is not a refusal — it has no code")
    }

    @Test fun anEmptyCallIsUnavailable() {
        seam(claimed = true, outcome = JSEModuleOutcome.Resolve(null))
        val v = DSXBusDispatch.run("", emptyMap())
        assertFalse(v.claimed)
        assertEquals("unavailable", v.code)
    }

    // -- the `then` form: exactly once, whenever the answer lands --

    @Test fun theThenFormFiresOnceForASynchronousSettle() {
        seam(claimed = true, outcome = JSEModuleOutcome.Error("no_fill", null))
        val seen = mutableListOf<DSXDispatchVerdict>()
        DSXBusDispatch.run("admob.load", emptyMap()) { seen.add(it) }
        assertEquals(1, seen.size, "a synchronous settle must not be delivered twice")
        assertFalse(seen.single().succeeded)
        assertEquals("no_fill", seen.single().code)
    }

    @Test fun theThenFormFiresOnceWhenTheAnswerArrivesLate() {
        val parked = seam(claimed = true, outcome = JSEModuleOutcome.Resolve("ok"), async = true)
        val seen = mutableListOf<DSXDispatchVerdict>()
        val immediate = DSXBusDispatch.run("stream.join", emptyMap()) { seen.add(it) }
        assertFalse(immediate.settled)
        assertTrue(seen.isEmpty(), "nothing has settled yet — reporting now would be the old lie")
        parked.single().invoke(JSEModuleOutcome.Resolve("ok"))
        assertEquals(1, seen.size)
        assertTrue(seen.single().succeeded)
        assertEquals("ok", seen.single().value)
    }

    @Test fun theThenFormFiresForACallNothingWillEverSettle() {
        seam(claimed = false, outcome = null)
        val seen = mutableListOf<DSXDispatchVerdict>()
        DSXBusDispatch.run("ghost.load", emptyMap()) { seen.add(it) }
        assertEquals(1, seen.size, "an unclaimed call is final — a `then` that never runs is a hang")
        assertEquals("unavailable", seen.single().code)
    }

    // -- routing identity, so a log line can name who was asked --

    @Test fun theVerdictNamesTheSchemeAndActionAsRouted() {
        seam(claimed = true, outcome = JSEModuleOutcome.Resolve(null))
        val v = DSXBusDispatch.run("stream.join?mic=1", emptyMap())
        assertEquals("stream", v.scheme)
        assertEquals("join", v.action, "the query slot is not part of the action name")
    }

    /// AS ROUTED, not as folded. `normalizeCall` puts the HEAD segment in the scheme slot and
    /// leaves the rest in the action path — the longest-known-prefix fold onto a nested chain
    /// (`watch.health`) happens inside the registry's dispatch funnel, downstream of here. The
    /// verdict reports the carrier it actually sent, which is the only pair it can know, and it
    /// is the same split the Swift twin's `dispatchCarrier` makes.
    @Test fun aNestedChainReportsTheCarrierItSentNotTheFoldedIdentity() {
        seam(claimed = true, outcome = JSEModuleOutcome.Resolve(null))
        val v = DSXBusDispatch.run("watch.health.heartRate", emptyMap())
        assertEquals("watch", v.scheme)
        assertEquals("health.heartRate", v.action)
    }
}
