package despia.engine

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * BootGates — the composable launch-gate chain: highest-priority-first sequencing (stable for
 * equal priorities), `when` skips, the idempotent advance, the async hard-block, and the
 * present/context seams. The registry is a process global, so every test resets it.
 */
class BootGateTest {

    @BeforeEach fun fresh() {
        BootGates.reset()
        CompromisedDeviceBootGate.reset()
    }

    @AfterEach fun teardown() {
        BootGates.reset()
        CompromisedDeviceBootGate.reset()
    }

    private fun handle(c: Any): BootHandle = c as BootHandle

    // MARK: chain order

    @Test fun noGatesMountsImmediately() {
        var mounted = 0
        BootGates.run(present = { }, then = { mounted += 1 })
        assertEquals(1, mounted)
    }

    @Test fun highestPriorityRunsFirstAndEqualPrioritiesKeepRegistrationOrder() {
        val order = mutableListOf<String>()
        val proxy = BootProxy(null)
        proxy.gate(priority = 10) { c -> order.add("ten"); handle(c).resolve() }
        proxy.gate(priority = 100) { c -> order.add("hundred"); handle(c).resolve() }
        proxy.gate(priority = 50) { c -> order.add("fiftyA"); handle(c).resolve() }
        proxy.gate(priority = 50) { c -> order.add("fiftyB"); handle(c).resolve() }
        var mounted = false
        BootGates.run(present = { }, then = { mounted = true })
        assertEquals(listOf("hundred", "fiftyA", "fiftyB", "ten"), order)   // stable sort pinned
        assertTrue(mounted)                                                 // mounts only after the LAST gate settles
    }

    // MARK: `when` scoping

    @Test fun whenFalseSkipsTheGateEntirely() {
        val order = mutableListOf<String>()
        val proxy = BootProxy(null)
        proxy.gate(priority = 9, `when` = { false }) { c -> order.add("skipped"); handle(c).resolve() }
        proxy.gate { c -> order.add("ran"); handle(c).resolve() }
        var mounted = false
        BootGates.run(present = { }, then = { mounted = true })
        assertEquals(listOf("ran"), order)
        assertTrue(mounted)
    }

    @Test fun allGatesSkippedMountsImmediately() {
        val proxy = BootProxy(null)
        proxy.gate(`when` = { false }) { c -> handle(c).resolve() }
        var mounted = false
        BootGates.run(present = { }, then = { mounted = true })
        assertTrue(mounted)
    }

    // MARK: settle semantics (resolve is the terminal; async holds; double-fire is idempotent)

    @Test fun anUnresolvedGateHoldsTheLaunchUntilItSettles() {
        val order = mutableListOf<String>()
        var held: BootHandle? = null
        val proxy = BootProxy(null)
        proxy.gate(priority = 1) { c -> held = handle(c) }                 // async work — returns without settling
        proxy.gate(priority = 0) { c -> order.add("second"); handle(c).resolve() }
        var mounted = false
        BootGates.run(present = { }, then = { mounted = true })
        assertFalse(mounted)                                               // the hard block (forced-update semantics)
        assertTrue(order.isEmpty())                                        // one at a time — the next gate hasn't run
        held!!.resolve()                                                   // settle later → the boot advances
        assertEquals(listOf("second"), order)
        assertTrue(mounted)
    }

    @Test fun doubleResolveAdvancesExactlyOnce() {
        var runs = 0
        var mounted = 0
        val proxy = BootProxy(null)
        proxy.gate(priority = 2) { c -> handle(c).resolve(); handle(c).resolve() }
        proxy.gate(priority = 1) { c -> runs += 1; handle(c).resolve() }
        BootGates.run(present = { }, then = { mounted += 1 })
        assertEquals(1, runs)
        assertEquals(1, mounted)
    }

    @Test fun errorIsATerminalThatStillHandsOff() {
        var mounted = false
        val proxy = BootProxy(null)
        proxy.gate { c -> handle(c).error("denied") }
        BootGates.run(present = { }, then = { mounted = true })
        assertTrue(mounted)
    }

    // MARK: seams — the presenter and the per-run context factory

    @Test fun presentReceivesTheGatesMountedScreenFromTheFactoryProbe() {
        val presented = mutableListOf<Any>()
        BootGates.contextFactory = { gate, advance ->
            BootGates.GateRun(BootHandle(advance)) { if (gate.priority == 9) "SCREEN" else null }
        }
        val proxy = BootProxy(null)
        proxy.gate(priority = 9) { c -> handle(c).resolve() }              // mounts a screen (per the probe)
        proxy.gate(priority = 1) { c -> handle(c).resolve() }              // mounts nothing
        var mounted = false
        BootGates.run(present = { presented.add(it) }, then = { mounted = true })
        assertEquals(listOf<Any>("SCREEN"), presented)                     // only the mounting gate presents
        assertTrue(mounted)
    }

    @Test fun defaultFactoryHandsAPlainHandleAndNoMount() {
        var seen: Any? = null
        var presented = false
        val proxy = BootProxy(null)
        proxy.gate { c -> seen = c; handle(c).resolve() }
        BootGates.run(present = { presented = true }, then = { })
        assertTrue(seen is BootHandle)
        assertFalse(presented)
    }

    @Test fun contextFactorySeesTheGateAndItsRegisteringStore() {
        var seenStore: Any? = null
        var seenPriority: Int? = null
        BootGates.contextFactory = { gate, advance ->
            seenStore = gate.store
            seenPriority = gate.priority
            BootGates.GateRun(BootHandle(advance)) { null }
        }
        BootProxy("registration").gate(priority = 7) { c -> handle(c).resolve() }
        BootGates.run(present = { }, then = { })
        assertEquals("registration", seenStore)                            // BootProxy records dsx as the store
        assertEquals(7, seenPriority)
    }

    @Test fun registerAcceptsABareGateOutsideTheProxy() {
        var ran = false
        BootGates.register(BootGate(priority = 0, `when` = { true }, store = null,
                                    run = { c -> ran = true; handle(c).resolve() }))
        var mounted = false
        BootGates.run(present = { }, then = { mounted = true })
        assertTrue(ran)
        assertTrue(mounted)
    }

    // MARK: non-router compromised-device root

    @Test fun compromisedDeviceGateDefaultsOpenUntilTheSecurityPackageInstallsItsPolicy() {
        assertEquals(null, CompromisedDeviceBootGate.blockedComponent())
    }

    @Test fun compromisedDeviceGateEvaluatesBothPolicyAndDetectorAndKeepsTheFirstInstaller() {
        CompromisedDeviceBootGate.installPolicy { enabled, compromised ->
            if (enabled == true && compromised == true) "DSXSecurityBlocked" else null
        }
        // A later package cannot replace the Mandatory Security package's boot decision.
        CompromisedDeviceBootGate.installPolicy { _, _ -> "BYPASS" }

        assertEquals(null, CompromisedDeviceBootGate.blockedComponent(false, true))
        assertEquals(null, CompromisedDeviceBootGate.blockedComponent(true, false))
        assertEquals(
            "DSXSecurityBlocked",
            CompromisedDeviceBootGate.blockedComponent(true, true),
        )
    }
}
