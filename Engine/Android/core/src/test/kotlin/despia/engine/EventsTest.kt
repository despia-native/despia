package despia.engine

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.Collections
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.parallel.ResourceLock

/// Conformance tests for the DSXEvents bus — behavior pinned to DSXEvents.swift.
/// The shared bus is a process singleton, so every test uses its own scheme names
/// and cancels its handles; the default direct `mainExecutor` makes delivery
/// synchronous (Swift's already-on-main path), so no waiting is needed.
@ResourceLock("despia-engine-runtime-executors")
class EventsTest {

    private val events = DSXEvents()

    // -- on / publish --

    @Test fun onReceivesPublishedEventAndData() {
        val received = mutableListOf<Pair<String, Any?>>()
        val handle = events.on("evt.basic") { event, data -> received.add(event to data) }
        try {
            events.publish("evt.basic", "changed", mapOf("count" to 2))
            assertEquals(listOf<Pair<String, Any?>>("changed" to mapOf("count" to 2)), received)
        } finally { handle.cancel() }
    }

    @Test fun dataIsUntypedByContractAndCastsBack() {
        var got: Any? = null
        val handle = events.on("evt.cast") { _, data -> got = data }
        try {
            events.publish("evt.cast", "e", mapOf("id" to 7))
            @Suppress("UNCHECKED_CAST")
            assertEquals(7, (got as Map<String, Any?>)["id"])
            events.publish("evt.cast", "e", null)   // nil payload is legal
            assertEquals(null, got)
        } finally { handle.cancel() }
    }

    @Test fun subscriberOnlyHearsItsScheme() {
        val received = AtomicInteger()
        val handle = events.on("evt.mine") { _, _ -> received.incrementAndGet() }
        try {
            events.publish("evt.other", "e", null)
            assertEquals(0, received.get())
            events.publish("evt.mine", "e", null)
            assertEquals(1, received.get())
        } finally { handle.cancel() }
    }

    // -- "*" firehose --

    @Test fun firehoseHearsEveryScheme() {
        val received = mutableListOf<String>()
        val handle = events.on("*") { event, _ -> received.add(event) }
        try {
            events.publish("evt.fh.one", "a", null)
            events.publish("evt.fh.two", "b", 1)
            assertEquals(listOf("a", "b"), received)
        } finally { handle.cancel() }
    }

    // -- unsubscribe --

    @Test fun cancelStopsDelivery() {
        val received = AtomicInteger()
        val handle = events.on("evt.cancel") { _, _ -> received.incrementAndGet() }
        events.publish("evt.cancel", "e", null)
        handle.cancel()
        events.publish("evt.cancel", "e", null)
        assertEquals(1, received.get())
    }

    @Test fun cancelIsScopedToItsOwnToken() {
        val a = AtomicInteger(); val b = AtomicInteger()
        val ha = events.on("evt.scoped") { _, _ -> a.incrementAndGet() }
        val hb = events.on("evt.scoped") { _, _ -> b.incrementAndGet() }
        try {
            ha.cancel()
            events.publish("evt.scoped", "e", null)
            assertEquals(0, a.get())
            assertEquals(1, b.get())
        } finally { hb.cancel() }
    }

    @Test fun droppingTheHandleDoesNotAutoUnsubscribe() {
        // The bus holds the lambda strongly; only cancel() stops it (pinned Swift contract).
        val received = AtomicInteger()
        var handle: DSXEventSubscription? = events.on("evt.dropped") { _, _ -> received.incrementAndGet() }
        val keptForCleanup = handle!!
        handle = null
        System.gc()
        events.publish("evt.dropped", "e", null)
        assertEquals(1, received.get())
        keptForCleanup.cancel()
    }

    // -- multiple listeners + ordering --

    @Test fun allListenersOnASchemeReceiveInSubscriptionOrder() {
        val order = mutableListOf<Int>()
        val h1 = events.on("evt.order") { _, _ -> order.add(1) }
        val h2 = events.on("evt.order") { _, _ -> order.add(2) }
        val h3 = events.on("evt.order") { _, _ -> order.add(3) }
        try {
            events.publish("evt.order", "e", null)
            assertEquals(listOf(1, 2, 3), order)
        } finally { h1.cancel(); h2.cancel(); h3.cancel() }
    }

    @Test fun schemeListenersDeliverBeforeTheFirehose() {
        // Pinned to the Swift concatenation: scheme handlers first, then "*" — even
        // when the firehose subscribed earlier.
        val order = mutableListOf<String>()
        val hStar = events.on("*") { _, _ -> order.add("firehose") }
        val hScheme = events.on("evt.before") { _, _ -> order.add("scheme") }
        try {
            events.publish("evt.before", "e", null)
            assertEquals(listOf("scheme", "firehose"), order)
        } finally { hStar.cancel(); hScheme.cancel() }
    }

    // -- the main-thread seam --

    @Test fun publishWithoutSubscribersSkipsTheHop() {
        val previous = DSXEvents.mainExecutor
        val hops = AtomicInteger()
        DSXEvents.mainExecutor = Executor { hops.incrementAndGet(); it.run() }
        try {
            events.publish("evt.nobody", "e", null)
            assertEquals(0, hops.get())     // Swift guards before the hop
        } finally { DSXEvents.mainExecutor = previous }
    }

    @Test fun deliveryGoesThroughTheMainExecutorSeam() {
        val queued = mutableListOf<Runnable>()
        val received = mutableListOf<Pair<String, Any?>>()
        val handle = events.on("evt.seam") { e, d -> received.add(e to d) }
        val previous = DSXEvents.mainExecutor
        DSXEvents.mainExecutor = Executor { queued.add(it) }
        try {
            events.publish("evt.seam", "later", 1)
            assertTrue(received.isEmpty())              // parked on the seam
            assertEquals(1, queued.size)
            queued.forEach { it.run() }                 // "hop" lands
            assertEquals(listOf<Pair<String, Any?>>("later" to 1), received)
        } finally {
            DSXEvents.mainExecutor = previous
            handle.cancel()
        }
    }

    @Test fun queuedPublishDoesNotInvokeSubscriptionAfterCancelReturns() {
        val queued = ArrayDeque<Runnable>()
        val received = mutableListOf<String>()
        val handle = events.on("evt.queued.cancel") { event, _ -> received.add(event) }
        val previous = DSXEvents.mainExecutor
        DSXEvents.mainExecutor = Executor { queued.addLast(it) }
        try {
            events.publish("evt.queued.cancel", "stale", null)
            assertEquals(1, queued.size)

            handle.cancel()
            queued.removeFirst().run()

            assertTrue(received.isEmpty())
        } finally {
            DSXEvents.mainExecutor = previous
            handle.cancel()
        }
    }

    @Test fun queuedPublishesPreserveOrderForAnActiveSubscription() {
        val queued = ArrayDeque<Runnable>()
        val received = mutableListOf<String>()
        val handle = events.on("evt.queued.order") { event, _ -> received.add(event) }
        val previous = DSXEvents.mainExecutor
        DSXEvents.mainExecutor = Executor { queued.addLast(it) }
        try {
            events.publish("evt.queued.order", "first", null)
            events.publish("evt.queued.order", "second", null)
            while (queued.isNotEmpty()) queued.removeFirst().run()
            assertEquals(listOf("first", "second"), received)
        } finally {
            DSXEvents.mainExecutor = previous
            handle.cancel()
        }
    }

    @Test fun concurrentHandlersCanCancelEachOtherWithoutLifecycleDeadlock() {
        val entered = CountDownLatch(2)
        val finished = CountDownLatch(2)
        val errors = Collections.synchronizedList(mutableListOf<Throwable>())
        val executor = Executors.newFixedThreadPool(2) { runnable ->
            Thread(runnable, "events-mutual-cancel").apply { isDaemon = true }
        }
        lateinit var first: DSXEventSubscription
        lateinit var second: DSXEventSubscription
        fun crossCancel(other: () -> Unit) {
            try {
                entered.countDown()
                check(entered.await(5, TimeUnit.SECONDS)) { "peer handler never entered" }
                other()
            } catch (failure: Throwable) {
                errors.add(failure)
            } finally {
                finished.countDown()
            }
        }

        val previous = DSXEvents.mainExecutor
        DSXEvents.mainExecutor = executor
        first = events.on("evt.cross.first") { _, _ -> crossCancel { second.cancel() } }
        second = events.on("evt.cross.second") { _, _ -> crossCancel { first.cancel() } }
        try {
            events.publish("evt.cross.first", "run", null)
            events.publish("evt.cross.second", "run", null)
            assertTrue(finished.await(10, TimeUnit.SECONDS), "mutual cancel deadlocked")
            assertTrue(errors.isEmpty(), "mutual cancel failed: $errors")
        } finally {
            first.cancel()
            second.cancel()
            DSXEvents.mainExecutor = previous
            executor.shutdownNow()
        }
    }

    @Test fun publicExecutorMovesWorkerPublicationToItsDeliveryThread() {
        val previous = DSXEvents.mainExecutor
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "events-host-main").apply { isDaemon = true }
        }
        val delivered = CountDownLatch(1)
        var deliveryThread = ""
        val handle = events.on("evt.worker.main") { _, _ ->
            deliveryThread = Thread.currentThread().name
            delivered.countDown()
        }
        DSXEvents.mainExecutor = executor
        try {
            val publisher = Thread { events.publish("evt.worker.main", "tick", null) }
            publisher.start()
            publisher.join(5_000)
            assertFalse(publisher.isAlive)
            assertTrue(delivered.await(5, TimeUnit.SECONDS))
            assertEquals("events-host-main", deliveryThread)
        } finally {
            handle.cancel()
            DSXEvents.mainExecutor = previous
            executor.shutdownNow()
        }
    }

    // -- thread-safety smoke --

    @Test fun concurrentEmitAndSubscribeDoNotThrow() {
        val received = AtomicInteger()
        val errors = Collections.synchronizedList(mutableListOf<Throwable>())
        val kept = events.on("evt.smoke") { _, _ -> received.incrementAndGet() }
        val threads = 8
        val perThread = 200
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val done = CountDownLatch(threads)
        repeat(threads) { n ->
            pool.execute {
                try {
                    start.await()
                    repeat(perThread) { i ->
                        if (n % 2 == 0) {
                            events.publish("evt.smoke", "e$i", i)
                        } else {
                            events.on("evt.smoke") { _, _ -> received.incrementAndGet() }.cancel()
                        }
                    }
                } catch (t: Throwable) { errors.add(t) } finally { done.countDown() }
            }
        }
        start.countDown()
        assertTrue(done.await(30, TimeUnit.SECONDS), "smoke did not finish")
        pool.shutdown()
        kept.cancel()
        assertTrue(errors.isEmpty(), "concurrent emit/subscribe threw: $errors")
        // The kept subscriber saw every publish from the emitting threads.
        assertTrue(received.get() >= (threads / 2) * perThread)
    }

    @Test fun runtimeSignalReachesMountedSurfacesBeforeNativeSubscribers() {
        val order = mutableListOf<String>()
        val queuedMain = ArrayDeque<Runnable>()
        val previousMain = ModuleRegistry.shared.mainExecutor
        val mount = DSXMessenger().mount("evt.runtime.surface") { egress ->
            order += "surface"
            assertEquals("dsx-view", egress.scheme)
            assertEquals("ready", egress.payload["event"])
            assertEquals(mapOf("src" to "/screen.dsx"), egress.payload["data"])
        }
        val handle = events.on("dsx-view") { event, data ->
            order += "native"
            assertEquals("ready", event)
            assertEquals(mapOf("src" to "/screen.dsx"), data)
        }
        ModuleRegistry.shared.mainExecutor = Executor { queuedMain.addLast(it) }
        try {
            DSXRuntimeSignals.broadcast("dsx-view", "ready", mapOf("src" to "/screen.dsx"))
            assertTrue(order.isEmpty())
            assertEquals(1, queuedMain.size) // one main funnel around the complete fan-out
            queuedMain.removeFirst().run()
            assertEquals(listOf("surface", "native"), order)
        } finally {
            ModuleRegistry.shared.mainExecutor = previousMain
            handle.cancel()
            mount.unmount()
        }
    }

    @Test fun runtimeSignalRejectsMalformedSchemeAndEventWithoutDelivery() {
        val received = AtomicInteger()
        val handle = events.on("dsx-view") { _, _ -> received.incrementAndGet() }
        try {
            DSXRuntimeSignals.broadcast("dsx-view/escape", "ready")
            DSXRuntimeSignals.broadcast("dsx-view", "bad:event")
            assertEquals(0, received.get())
        } finally { handle.cancel() }
    }
}
