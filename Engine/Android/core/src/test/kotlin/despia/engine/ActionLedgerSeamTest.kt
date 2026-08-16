package despia.engine

import java.util.concurrent.Executor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/// THE ACTIONS SIDECAR'S TWO PUBLIC HALVES — `registerAction` (a renderer declares a head
/// `<action>`) and `clearActions` (a satellite runtime swaps SCREENS over ONE long-lived
/// store, so the next head starts from a fresh map). Before the clear half existed, the Wear
/// runtime could only BLANK a departed screen's names to empty bodies, and a stale
/// `dsx.action.x()` silently no-opped instead of settling `unavailable` — the pin this closes
/// (android-status.md Core/Extensions/Watch, WearStore.mountHead).
///
/// Also pins the `HookProducer` typealias as a RUNTIME-CHECKABLE shape: the Dom relay's
/// navReissue producer distinguishes "a claimant answered with a producer" from "a claimant
/// answered with a plain value" by exactly this cast (WebDelegate.kt `reissue`).
class ActionLedgerSeamTest {

    private fun inlineExecutors() {
        ModuleRegistry.shared.mainExecutor = Executor { it.run() }
        JSERunner.mainExecutor = Executor { it.run() }
    }

    @Test fun clearActionsDropsEveryRegistrationSoAStaleNameIsNoLongerCallable() {
        inlineExecutors()
        val store = StackStore()
        store.registerAction("bump", emptyMap(), "n = 41 + 1")
        JSERunner(store).run("dsx.action.bump()", null)
        assertEquals(42.0, (store.vars["n"] as? Number)?.toDouble())

        store.vars.remove("n")
        store.clearActions()
        // The name is gone: the call no longer runs a body (it falls through to the package
        // funnel, which answers the typed `unavailable` for an unregistered scheme).
        JSERunner(store).run("dsx.action.bump()", null)
        assertNull(store.vars["n"])

        // Re-declaring the same name after a clear restores it — a screen swap back and forth.
        store.registerAction("bump", emptyMap(), "n = 7")
        JSERunner(store).run("dsx.action.bump()", null)
        assertEquals(7.0, (store.vars["n"] as? Number)?.toDouble())
    }

    @Test fun hookProducerIsDistinguishableFromAPlainClaimValue() {
        val producer: HookProducer = { mapOf("url" to "https://example.test/") }
        assertEquals(producer, producer as? HookProducer)
        assertNull("reissue" as? HookProducer)
        assertNull(mapOf("url" to "https://example.test/") as? HookProducer)
        assertNull(null as? HookProducer)
    }
}
