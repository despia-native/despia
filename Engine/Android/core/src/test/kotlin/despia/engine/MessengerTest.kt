package despia.engine

import java.util.concurrent.Executor
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.Collections
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith
import org.junit.jupiter.api.parallel.ResourceLock

/// Conformance tests for the dsx.messenger hub — behavior pinned to Messenger.swift.
/// The hub is a process singleton, so every test uses its own surface ids and
/// unmounts them; the default direct executor seams make delivery synchronous, and
/// all process-global seams are restored after each test.
@ResourceLock("despia-engine-runtime-executors")
class MessengerTest {

    private val messenger = DSXMessenger()

    @AfterTest fun restoreSeams() {
        DSXMessenger.inboundMainExecutor = Executor { it.run() }
        DSXMessenger.outboundMainExecutor = Executor { it.run() }
        DSXMessengerMount.dispatch = { _, _, _, _, _ -> false }
        DSXMessengerMount.mountedDispatch = { scheme, action, args, rid, surfaceID, _ ->
            DSXMessengerMount.dispatch(scheme, action, args, rid, surfaceID)
        }
    }

    private fun egress(target: String, scheme: String = "battery", rid: String? = "r1"): DSXEgress =
        DSXEgress(target = target, scheme = scheme, rid = rid,
                  payload = mapOf("id" to rid, "scheme" to scheme, "event" to "resolve", "final" to true))

    // -- mount / deliver (correlated, routed by surfaceID) --

    @Test fun deliverRoutesToTheMountedSink() {
        val received = mutableListOf<DSXEgress>()
        val mount = messenger.mount("msg.web") { received.add(it) }
        try {
            val e = egress("msg.web")
            assertTrue(messenger.deliver("msg.web", e))
            assertEquals(1, received.size)
            assertSame(e, received[0])           // the envelope arrives as-is
            assertEquals("msg.web", mount.id)
        } finally { mount.unmount() }
    }

    @Test fun deliverToUnknownSurfaceReturnsFalseWithoutHopping() {
        // A pure-native app's web target / a torn-down surface: false, and the
        // hop never happens (Swift guards on the sink before touching the main thread).
        val hops = AtomicInteger()
        DSXMessenger.outboundMainExecutor = Executor { hops.incrementAndGet(); it.run() }
        assertFalse(messenger.deliver("msg.ghost", egress("msg.ghost")))
        assertEquals(0, hops.get())
    }

    @Test fun deliverOnlyReachesTheTargetSurface() {
        val a = mutableListOf<DSXEgress>()
        val b = mutableListOf<DSXEgress>()
        val ma = messenger.mount("msg.a") { a.add(it) }
        val mb = messenger.mount("msg.b") { b.add(it) }
        try {
            messenger.deliver("msg.a", egress("msg.a"))
            assertEquals(1, a.size)
            assertTrue(b.isEmpty())
        } finally { ma.unmount(); mb.unmount() }
    }

    @Test fun remountingTheSameIdReplacesTheSink() {
        // A re-created surface rebinds — pinned Swift contract.
        val replaced = AtomicInteger()
        val active = AtomicInteger()
        val first = messenger.mount("msg.rebind") { replaced.incrementAndGet() }
        val second = messenger.mount("msg.rebind") { active.incrementAndGet() }
        try {
            messenger.deliver("msg.rebind", egress("msg.rebind"))
            assertEquals(0, replaced.get())
            assertEquals(1, active.get())
        } finally { second.unmount(); first.unmount() }
    }

    @Test fun unmountDetachesTheSink() {
        val received = AtomicInteger()
        val mount = messenger.mount("msg.gone") { received.incrementAndGet() }
        assertTrue(messenger.deliver("msg.gone", egress("msg.gone")))
        mount.unmount()
        assertFalse(messenger.deliver("msg.gone", egress("msg.gone")))
        assertEquals(1, received.get())
    }

    // -- broadcast fan-out --

    @Test fun broadcastFansOutToEveryMountedSink() {
        val a = mutableListOf<DSXEgress>()
        val b = mutableListOf<DSXEgress>()
        val ma = messenger.mount("msg.fan.a") { a.add(it) }
        val mb = messenger.mount("msg.fan.b") { b.add(it) }
        try {
            val e = egress("*", scheme = "player_state", rid = null)   // rid == null ⇒ out-of-band
            messenger.deliverBroadcast(e)
            assertSame(e, a.single())
            assertSame(e, b.single())
        } finally { ma.unmount(); mb.unmount() }
    }

    @Test fun broadcastWithNoSinksSkipsTheHop() {
        val hops = AtomicInteger()
        DSXMessenger.outboundMainExecutor = Executor { hops.incrementAndGet(); it.run() }
        messenger.deliverBroadcast(egress("*", rid = null))
        assertEquals(0, hops.get())              // Swift guards before the hop
    }

    // -- the main-thread seam --

    @Test fun deliveryGoesThroughTheMainExecutorSeam() {
        val queued = ArrayDeque<Runnable>()
        val received = mutableListOf<DSXEgress>()
        val mount = messenger.mount("msg.seam") { received.add(it) }
        DSXMessenger.outboundMainExecutor = Executor { queued.add(it) }
        try {
            assertTrue(messenger.deliver("msg.seam", egress("msg.seam")))
            assertTrue(received.isEmpty())       // parked on the seam
            assertEquals(1, queued.size)
            queued.removeFirst().run()           // the "hop" lands
            assertEquals(1, received.size)
        } finally { mount.unmount() }
    }

    @Test fun queuedCorrelatedAndBroadcastDeliveriesAreDroppedAfterUnmountReturns() {
        val queued = ArrayDeque<Runnable>()
        val received = mutableListOf<DSXEgress>()
        val mount = messenger.mount("msg.queued.unmount") { received.add(it) }
        DSXMessenger.outboundMainExecutor = Executor { queued.addLast(it) }
        try {
            assertTrue(messenger.deliver(
                "msg.queued.unmount",
                egress("msg.queued.unmount", rid = "before-unmount"),
            ))
            messenger.deliverBroadcast(egress("*", rid = null))
            assertEquals(2, queued.size)

            mount.unmount()
            while (queued.isNotEmpty()) queued.removeFirst().run()

            assertTrue(received.isEmpty())
            assertFalse(messenger.deliver(
                "msg.queued.unmount",
                egress("msg.queued.unmount", rid = "after-unmount"),
            ))
        } finally { mount.unmount() }
    }

    @Test fun queuedDeliveryCannotReachStaleSinkOrNewSinkAfterReplacement() {
        val queued = ArrayDeque<Runnable>()
        val stale = mutableListOf<String?>()
        val current = mutableListOf<String?>()
        DSXMessenger.outboundMainExecutor = Executor { queued.addLast(it) }
        val first = messenger.mount("msg.queued.replace") { stale.add(it.rid) }
        val second: DSXMessengerMount
        try {
            assertTrue(messenger.deliver(
                "msg.queued.replace",
                egress("msg.queued.replace", rid = "for-first"),
            ))
            second = messenger.mount("msg.queued.replace") { current.add(it.rid) }
            try {
                queued.removeFirst().run()
                assertTrue(stale.isEmpty())
                assertTrue(current.isEmpty()) // a new sink never receives an older mount's work

                // A stale handle is ownership-scoped and cannot detach its replacement.
                first.unmount()
                assertTrue(messenger.deliver(
                    "msg.queued.replace",
                    egress("msg.queued.replace", rid = "for-second"),
                ))
                queued.removeFirst().run()
                assertEquals(listOf<String?>("for-second"), current)
            } finally { second.unmount() }
        } finally { first.unmount() }
    }

    @Test fun queuedDeliveriesPreserveSubmissionOrderForAnActiveMount() {
        val queued = ArrayDeque<Runnable>()
        val received = mutableListOf<String?>()
        val mount = messenger.mount("msg.queued.order") { received.add(it.rid) }
        DSXMessenger.outboundMainExecutor = Executor { queued.addLast(it) }
        try {
            assertTrue(messenger.deliver(
                "msg.queued.order",
                egress("msg.queued.order", rid = "first"),
            ))
            assertTrue(messenger.deliver(
                "msg.queued.order",
                egress("msg.queued.order", rid = "second"),
            ))
            while (queued.isNotEmpty()) queued.removeFirst().run()
            assertEquals(listOf<String?>("first", "second"), received)
        } finally { mount.unmount() }
    }

    @Test fun concurrentSinksCanUnmountEachOtherWithoutLifecycleDeadlock() {
        val entered = CountDownLatch(2)
        val finished = CountDownLatch(2)
        val errors = Collections.synchronizedList(mutableListOf<Throwable>())
        val executor = Executors.newFixedThreadPool(2) { runnable ->
            Thread(runnable, "messenger-mutual-unmount").apply { isDaemon = true }
        }
        lateinit var first: DSXMessengerMount
        lateinit var second: DSXMessengerMount
        fun crossUnmount(other: () -> Unit) {
            try {
                entered.countDown()
                check(entered.await(5, TimeUnit.SECONDS)) { "peer sink never entered" }
                other()
            } catch (failure: Throwable) {
                errors.add(failure)
            } finally {
                finished.countDown()
            }
        }

        DSXMessenger.outboundMainExecutor = executor
        first = messenger.mount("msg.cross.first") { crossUnmount { second.unmount() } }
        second = messenger.mount("msg.cross.second") { crossUnmount { first.unmount() } }
        try {
            assertTrue(messenger.deliver("msg.cross.first", egress("msg.cross.first")))
            assertTrue(messenger.deliver("msg.cross.second", egress("msg.cross.second")))
            val completed = finished.await(10, TimeUnit.SECONDS)
            assertTrue(completed, "mutual unmount deadlocked")
            assertTrue(errors.isEmpty(), "mutual unmount failed: $errors")
        } finally {
            first.unmount()
            second.unmount()
            DSXMessenger.outboundMainExecutor = Executor { it.run() }
            executor.shutdownNow()
        }
    }

    // -- receive: the INBOUND half --

    @Test fun receiveDispatchesAtTheUntrustedTierWithFullCorrelation() {
        val calls = mutableListOf<List<Any?>>()
        val received = mutableListOf<DSXEgress>()
        DSXMessengerMount.dispatch = { scheme, action, args, rid, surfaceID ->
            calls.add(listOf(scheme, action, args, rid, surfaceID)); true
        }
        val mount = messenger.mount("godot") { received.add(it) }
        try {
            mount.receive("battery", "level", mapOf("q" to 1), "r7")
            assertEquals(listOf(listOf<Any?>("battery", "level", mapOf("q" to 1), "r7", "godot")), calls)
            assertTrue(received.isEmpty())       // handled ⇒ no synthetic envelope
        } finally { mount.unmount() }
    }

    @Test fun receiveDefaultsArgsToEmptyAndRidToNull() {
        var seen: List<Any?>? = null
        DSXMessengerMount.dispatch = { scheme, action, args, rid, surfaceID ->
            seen = listOf(scheme, action, args, rid, surfaceID); true
        }
        val mount = messenger.mount("msg.defaults") { }
        try {
            mount.receive("battery", "level")
            assertEquals(listOf<Any?>("battery", "level", emptyMap<String, Any?>(), null, "msg.defaults"), seen)
        } finally { mount.unmount() }
    }

    @Test fun compatibilityHandleDispatchesWithoutOwningTheRegisteredSink() {
        var seen: List<Any?>? = null
        val delivered = mutableListOf<DSXEgress>()
        DSXMessengerMount.dispatch = { scheme, action, args, rid, surfaceID ->
            seen = listOf(scheme, action, args, rid, surfaceID)
            true
        }
        val registered = messenger.mount("msg.compat") { delivered.add(it) }
        val compatibility = DSXMessengerMount("msg.compat")
        try {
            compatibility.receive("battery", "level", mapOf("q" to 1), "r1")
            assertEquals(
                listOf<Any?>("battery", "level", mapOf("q" to 1), "r1", "msg.compat"),
                seen,
            )

            compatibility.unmount()
            assertTrue(messenger.deliver("msg.compat", egress("msg.compat")))
            assertEquals(1, delivered.size)
        } finally {
            compatibility.unmount()
            registered.unmount()
        }
    }

    @Test fun replacingLegacyDispatchAlsoRelinquishesMountedRegistryOwnership() {
        DSXMessengerMount.bindRegistry()
        var calls = 0
        DSXMessengerMount.dispatch = { _, _, _, _, _ ->
            calls += 1
            true
        }
        val mount = messenger.mount("msg.dispatch.owner") { }
        try {
            mount.receive("battery", "level")
            assertEquals(1, calls)
        } finally { mount.unmount() }
    }

    @Test fun unownedSchemeSynthesizesNotLoaded() {
        // Default dispatch seam = inert false — the surface's pending call still
        // settles, exactly the way the web's would.
        val received = mutableListOf<DSXEgress>()
        val mount = messenger.mount("msg.orphan") { received.add(it) }
        try {
            mount.receive("nobody", "ping", rid = "r9")
            val e = received.single()
            assertEquals("msg.orphan", e.target)
            assertEquals("nobody", e.scheme)
            assertEquals("r9", e.rid)
            assertEquals(
                mapOf<String, Any?>(
                    "id" to "r9", "scheme" to "nobody", "host" to "ping",
                    "event" to "error", "final" to true, "data" to null,
                    "code" to "not_loaded", "recoverable" to false,
                ),
                e.payload,
            )
        } finally { mount.unmount() }
    }

    @Test fun emptySchemeSynthesizesInvalidUriWithoutDispatching() {
        val dispatched = AtomicInteger()
        DSXMessengerMount.dispatch = { _, _, _, _, _ -> dispatched.incrementAndGet(); true }
        val received = mutableListOf<DSXEgress>()
        val mount = messenger.mount("msg.baduri") { received.add(it) }
        try {
            mount.receive("", "ping")            // rid == null: the id KEY stays, value null
            assertEquals(0, dispatched.get())
            val e = received.single()
            assertNull(e.rid)
            assertTrue(e.payload.containsKey("id"))
            assertNull(e.payload["id"])
            assertEquals("invalid_uri", e.payload["code"])
            assertEquals("error", e.payload["event"])
            assertEquals(true, e.payload["final"])
        } finally { mount.unmount() }
    }

    @Test fun receiveHopsThroughTheExecutorSeam() {
        // Swift hops receive with main.async — the dispatch (and any synthetic
        // reply) rides the same injectable seam.
        val queued = ArrayDeque<Runnable>()
        val dispatched = AtomicInteger()
        val received = mutableListOf<DSXEgress>()
        DSXMessengerMount.dispatch = { _, _, _, _, _ -> dispatched.incrementAndGet(); false }
        val mount = messenger.mount("msg.hop") { received.add(it) }
        DSXMessenger.inboundMainExecutor = Executor { queued.add(it) }
        try {
            mount.receive("battery", "level", rid = "r1")
            assertEquals(0, dispatched.get())    // parked on the seam
            while (queued.isNotEmpty()) queued.removeFirst().run()
            assertEquals(1, dispatched.get())
            assertEquals("not_loaded", received.single().payload["code"])
        } finally { mount.unmount() }
    }

    @Test fun queuedReceiveFromReplacedMountNeverDispatchesOrReachesReplacement() {
        val queued = ArrayDeque<Runnable>()
        val dispatched = AtomicInteger()
        val staleReceived = mutableListOf<DSXEgress>()
        val replacementReceived = mutableListOf<DSXEgress>()
        DSXMessenger.inboundMainExecutor = Executor { queued.addLast(it) }
        DSXMessengerMount.dispatch = { _, _, _, _, _ -> dispatched.incrementAndGet(); false }
        val stale = messenger.mount("msg.receive.replace") { staleReceived.add(it) }
        stale.receive("battery", "level", rid = "owned")
        stale.receive("", "bad", rid = "invalid")
        val replacement = messenger.mount("msg.receive.replace") { replacementReceived.add(it) }
        try {
            while (queued.isNotEmpty()) queued.removeFirst().run()

            assertEquals(0, dispatched.get())
            assertTrue(staleReceived.isEmpty())
            assertTrue(replacementReceived.isEmpty())

            // The old handle is rejected before enqueue after replacement too.
            stale.receive("battery", "late", rid = "late")
            assertTrue(queued.isEmpty())
        } finally {
            stale.unmount()
            replacement.unmount()
        }
    }

    @Test fun unmountedReceiveIsRejectedBeforeTheInboundExecutor() {
        val queued = ArrayDeque<Runnable>()
        val dispatched = AtomicInteger()
        DSXMessenger.inboundMainExecutor = Executor { queued.addLast(it) }
        DSXMessengerMount.dispatch = { _, _, _, _, _ -> dispatched.incrementAndGet(); true }
        val mount = messenger.mount("msg.receive.unmounted") { }
        mount.unmount()

        mount.receive("battery", "level")

        assertTrue(queued.isEmpty())
        assertEquals(0, dispatched.get())
    }

    @Test fun mountedDispatchCarriesExactGenerationAndGenerationDeliveryNeverRetargets() {
        val admissions = ArrayList<Pair<String, DSXMessengerRegistration>>()
        DSXMessengerMount.mountedDispatch = { _, _, _, _, surfaceID, registration ->
            admissions += surfaceID to registration
            true
        }
        val staleReceived = ArrayList<String?>()
        val currentReceived = ArrayList<String?>()
        val stale = messenger.mount("msg.generation") { staleReceived += it.rid }
        var current: DSXMessengerMount? = null
        try {
            stale.receive("battery", "first", rid = "same-rid")
            val staleGeneration = assertNotNull(admissions.single().second)
            assertEquals("msg.generation", admissions.single().first)
            messenger.deliver(
                staleGeneration,
                egress("msg.generation", rid = "before-replacement"),
            )
            assertEquals(listOf<String?>("before-replacement"), staleReceived)

            current = messenger.mount("msg.generation") { currentReceived += it.rid }
            current.receive("battery", "second", rid = "same-rid")
            val currentGeneration = admissions.last().second
            assertNotSame(staleGeneration, currentGeneration)

            // Even with the same public id and reused rid, old-generation work is
            // dropped rather than looked up against the replacement's sink.
            messenger.deliver(
                staleGeneration,
                egress("msg.generation", rid = "same-rid"),
            )
            assertEquals(listOf<String?>("before-replacement"), staleReceived)
            assertTrue(currentReceived.isEmpty())

            messenger.deliver(
                currentGeneration,
                egress("msg.generation", rid = "current"),
            )
            assertEquals(listOf<String?>("current"), currentReceived)
        } finally {
            stale.unmount()
            current?.unmount()
        }
    }

    @Test fun rejectedInboundSubmissionPropagatesWithoutDispatching() {
        val dispatched = AtomicInteger()
        DSXMessenger.inboundMainExecutor = Executor {
            throw RejectedExecutionException("host stopped")
        }
        DSXMessengerMount.dispatch = { _, _, _, _, _ -> dispatched.incrementAndGet(); true }
        val mount = messenger.mount("msg.receive.rejected") { }
        try {
            assertFailsWith<RejectedExecutionException> {
                mount.receive("battery", "level")
            }
            assertEquals(0, dispatched.get())
        } finally { mount.unmount() }
    }

    @Test fun inboundExecutorMovesWorkerReceiveToItsDeliveryThread() {
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "messenger-host-main").apply { isDaemon = true }
        }
        val delivered = CountDownLatch(1)
        var deliveryThread = ""
        DSXMessenger.inboundMainExecutor = executor
        DSXMessengerMount.dispatch = { _, _, _, _, _ ->
            deliveryThread = Thread.currentThread().name
            delivered.countDown()
            true
        }
        val mount = messenger.mount("msg.receive.worker") { }
        try {
            val worker = Thread { mount.receive("battery", "level") }
            worker.start()
            worker.join(5_000)
            assertFalse(worker.isAlive)
            assertTrue(delivered.await(5, TimeUnit.SECONDS))
            assertEquals("messenger-host-main", deliveryThread)
        } finally {
            mount.unmount()
            DSXMessenger.inboundMainExecutor = Executor { it.run() }
            executor.shutdownNow()
        }
    }
}
