package despia.engine

import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.jupiter.api.parallel.ResourceLock

/**
 * DSXShared / DSXValues — the registries are process singletons, so every test uses its
 * own key namespace. Weak-collection is observed via the provide(null) path (a cleared
 * WeakBox and a null-provided one are indistinguishable by contract) — no flaky GC tests.
 */
@ResourceLock("despia-engine-runtime-executors")
class SharedTest {
    private val shared = DSXShared()
    private val values = DSXValues()

    @AfterTest fun restoreExecutor() {
        DSXShared.mainExecutor = Executor { it.run() }
    }

    // MARK: dsx.shared — provide / use

    @Test fun provideThenUseReturnsTheSameInstance() {
        val handle = Any()
        shared.provide("t1.web", handle)
        assertSame(handle, shared.use("t1.web"))
    }

    @Test fun useOfUnknownKeyIsNull() {
        assertNull(shared.use("t2.never-provided"))
    }

    @Test fun reprovideReplacesTheHandle() {
        val first = Any()
        val second = Any()
        shared.provide("t3.web", first)
        shared.provide("t3.web", second)
        assertSame(second, shared.use("t3.web"))
    }

    @Test fun provideNullClearsAndReadsAsAbsent() {
        // The collected-provider contract: once the handle is gone (cleared here rather
        // than GC'd), use() reads null — same observable result as a pruned WeakReference.
        val handle = Any()
        shared.provide("t4.web", handle)
        assertSame(handle, shared.use("t4.web"))
        shared.provide("t4.web", null)
        assertNull(shared.use("t4.web"))
    }

    // MARK: dsx.shared — on / cancel

    @Test fun onFiresImmediatelyWhenAProviderIsAlreadyUp() {
        val handle = Any()
        shared.provide("t5.web", handle)
        var got: Any? = null
        val token = shared.on("t5.web") { got = it }
        try {
            assertSame(handle, got)
        } finally { shared.cancel("t5.web", token) }
    }

    @Test fun onDoesNotFireWhenNoProviderIsUp() {
        var fired = false
        val token = shared.on("t6.web") { fired = true }
        // ...and a null provide does not count as "already up" either.
        shared.provide("t6b.web", null)
        var firedB = false
        val tokenB = shared.on("t6b.web") { firedB = true }
        try {
            assertFalse(fired)
            assertFalse(firedB)
        } finally {
            shared.cancel("t6.web", token)
            shared.cancel("t6b.web", tokenB)
        }
    }

    @Test fun observersAreNotifiedOnEveryProvideIncludingNull() {
        val seen = ArrayList<Any?>()
        val token = shared.on("t7.web") { seen.add(it) }
        val first = Any()
        val second = Any()
        try {
            shared.provide("t7.web", first)
            shared.provide("t7.web", second)
            shared.provide("t7.web", null)   // clear notifies too
            assertEquals(listOf<Any?>(first, second, null), seen)
        } finally { shared.cancel("t7.web", token) }
    }

    @Test fun cancelStopsDelivery() {
        var count = 0
        val token = shared.on("t8.web") { count++ }
        shared.provide("t8.web", Any())
        assertEquals(1, count)
        shared.cancel("t8.web", token)
        shared.provide("t8.web", Any())
        assertEquals(1, count)
    }

    @Test fun deliveryRoutesThroughTheMainThreadSeam() {
        // Swift delivers on the main queue; the JVM seam is DSXShared.mainExecutor.
        // Swap in a deferring dispatcher and observe that notify goes through it.
        val queued = ArrayList<Runnable>()
        val prior = DSXShared.mainExecutor
        var token: UUID? = null
        DSXShared.mainExecutor = Executor { queued.add(it) }
        try {
            var got: Any? = null
            token = shared.on("t9.web") { got = it }
            val handle = Any()
            shared.provide("t9.web", handle)
            assertNull(got)                 // deferred by the seam
            queued.forEach { it.run() }
            assertSame(handle, got)         // delivered when the "main thread" runs
        } finally {
            token?.let { shared.cancel("t9.web", it) }
            DSXShared.mainExecutor = prior
        }
    }

    @Test fun cancelSuppressesQueuedCurrentAndFutureHandleDeliveries() {
        val queued = ArrayDeque<Runnable>()
        val prior = DSXShared.mainExecutor
        val currentKey = "t10.current"
        val futureKey = "t10.future"
        var currentToken: UUID? = null
        var futureToken: UUID? = null
        DSXShared.mainExecutor = Executor { queued.addLast(it) }
        try {
            val current = Any()
            shared.provide(currentKey, current)
            var currentCalls = 0
            val activeCurrentToken = shared.on(currentKey) { currentCalls += 1 }
            currentToken = activeCurrentToken
            assertEquals(1, queued.size)
            shared.cancel(currentKey, activeCurrentToken)
            queued.removeFirst().run()
            assertEquals(0, currentCalls)

            var futureCalls = 0
            val activeFutureToken = shared.on(futureKey) { futureCalls += 1 }
            futureToken = activeFutureToken
            shared.provide(futureKey, Any())
            assertEquals(1, queued.size)
            shared.cancel(futureKey, activeFutureToken)
            queued.removeFirst().run()
            assertEquals(0, futureCalls)
        } finally {
            currentToken?.let { shared.cancel(currentKey, it) }
            futureToken?.let { shared.cancel(futureKey, it) }
            DSXShared.mainExecutor = prior
        }
    }

    @Test fun observersKeepInsertionOrderAndCancellationAppliesWithinOneProvide() {
        val key = "t11.ordered"
        val seen = ArrayList<String>()
        var later: UUID? = null
        val earlier = shared.on(key) {
            seen += "earlier"
            later?.let { shared.cancel(key, it) }
        }
        try {
            later = shared.on(key) { seen += "later" }

            shared.provide(key, Any())

            assertEquals(listOf("earlier"), seen)
        } finally {
            later?.let { shared.cancel(key, it) }
            shared.cancel(key, earlier)
        }
    }

    @Test fun reorderedCurrentHandleCannotRegressANewerProvide() {
        val key = "t12.revision"
        val oldHandle = Any()
        val newHandle = Any()
        shared.provide(key, oldHandle)
        val prior = DSXShared.mainExecutor
        val executor = FirstSubmissionLastExecutor()
        val seen = ArrayList<Any?>()
        var token: UUID? = null
        var failure: Throwable? = null
        DSXShared.mainExecutor = executor
        val subscribing = Thread {
            try {
                token = shared.on(key) { seen += it }
            } catch (error: Throwable) {
                failure = error
            }
        }.apply { isDaemon = true }
        subscribing.start()
        try {
            assertTrue(executor.awaitFirstSubmission())
            shared.provide(key, newHandle) // enqueued before the blocked current handle
            assertEquals(0, executor.queuedCount())
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            assertFalse(subscribing.isAlive)
            failure?.let { throw AssertionError("subscription failed", it) }
            assertEquals(1, executor.queuedCount())

            executor.drain()

            assertEquals(1, seen.size)
            assertSame(newHandle, seen.single())
        } finally {
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            token?.let { shared.cancel(key, it) }
            DSXShared.mainExecutor = prior
        }
    }

    @Test fun rejectedInitialDeliveryRollsBackTheRegistration() {
        val key = "t13.reject-initial"
        val handle = Any()
        var calls = 0
        shared.provide(key, handle)
        DSXShared.mainExecutor = Executor { throw RejectedExecutionException("host stopped") }

        assertFailsWith<RejectedExecutionException> {
            shared.on(key) { calls += 1 }
        }

        DSXShared.mainExecutor = Executor { it.run() }
        shared.provide(key, Any())
        assertEquals(0, calls, "failed registration must not remain observable")
    }

    @Test fun throwingInitialHandlerRollsBackTheRegistration() {
        val key = "t14.throw-initial"
        var calls = 0
        shared.provide(key, Any())

        assertFailsWith<IllegalStateException> {
            shared.on(key) {
                calls += 1
                throw IllegalStateException("handler failed")
            }
        }

        shared.provide(key, Any())
        assertEquals(1, calls, "throwing initial registration must be removed")
    }

    @Test fun deferredThrowingInitialHandlerRollsBackBeforeRethrowing() {
        val key = "t14b.throw-deferred-initial"
        val queued = ArrayDeque<Runnable>()
        var calls = 0
        shared.provide(key, Any())
        DSXShared.mainExecutor = Executor { queued.addLast(it) }
        val token = shared.on(key) {
            calls += 1
            throw IllegalStateException("deferred handler failed")
        }
        try {
            assertEquals(1, queued.size)
            assertFailsWith<IllegalStateException> { queued.removeFirst().run() }
            assertEquals(1, calls)

            shared.provide(key, Any())
            assertTrue(queued.isEmpty(), "failed async initial registration must be removed")
            assertEquals(1, calls)
        } finally {
            shared.cancel(key, token)
        }
    }

    @Test fun throwingFirstCallbackAfterSkippedInitialAlsoRollsBack() {
        val key = "t14c.throw-after-skipped-initial"
        val queued = ArrayDeque<Runnable>()
        var calls = 0
        shared.provide(key, Any())
        DSXShared.mainExecutor = Executor { queued.addLast(it) }
        val token = shared.on(key) {
            calls += 1
            throw IllegalStateException("newer first callback failed")
        }
        try {
            // The newer publication joins the mailbox before its sole drain runs,
            // causing the stale initial snapshot to be skipped.
            shared.provide(key, Any())
            assertEquals(1, queued.size)
            assertFailsWith<IllegalStateException> { queued.removeFirst().run() }
            assertEquals(1, calls)

            shared.provide(key, Any())
            assertTrue(queued.isEmpty(), "failed first actual callback must be removed")
            assertEquals(1, calls)
        } finally {
            shared.cancel(key, token)
        }
    }

    @Test fun reentrantPublicationPreservesFifoForEveryRegistration() {
        val key = "t15.reentrant"
        val firstHandle = Any()
        val secondHandle = Any()
        val firstSeen = ArrayList<Any?>()
        val secondSeen = ArrayList<Any?>()
        var republished = false
        val first = shared.on(key) { handle ->
            firstSeen += handle
            if (handle === firstHandle && !republished) {
                republished = true
                shared.provide(key, secondHandle)
            }
        }
        val second = shared.on(key) { secondSeen += it }
        try {
            shared.provide(key, firstHandle)

            assertEquals(listOf<Any?>(firstHandle, secondHandle), firstSeen)
            assertEquals(listOf<Any?>(firstHandle, secondHandle), secondSeen)
        } finally {
            shared.cancel(key, first)
            shared.cancel(key, second)
        }
    }

    @Test fun concurrentPublicationsDrainInRegistryRevisionOrder() {
        val key = "t16.concurrent"
        val firstHandle = Any()
        val secondHandle = Any()
        val executor = FirstSubmissionLastExecutor()
        val seen = ArrayList<Any?>()
        val token = shared.on(key) { seen += it }
        DSXShared.mainExecutor = executor
        val publisher = Thread { shared.provide(key, firstHandle) }.apply { isDaemon = true }
        try {
            publisher.start()
            assertTrue(executor.awaitFirstSubmission())
            shared.provide(key, secondHandle)
            assertEquals(0, executor.queuedCount())
            executor.releaseFirstSubmission()
            publisher.join(10_000)
            assertFalse(publisher.isAlive)
            assertEquals(1, executor.queuedCount())

            executor.drain()
            assertEquals(listOf<Any?>(firstHandle, secondHandle), seen)
        } finally {
            executor.releaseFirstSubmission()
            publisher.join(10_000)
            shared.cancel(key, token)
        }
    }

    @Test fun publicExecutorMovesWorkerPublicationToItsDeliveryThread() {
        val key = "t17.worker-main"
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "shared-host-main").apply { isDaemon = true }
        }
        val delivered = CountDownLatch(1)
        var deliveryThread = ""
        DSXShared.mainExecutor = executor
        val token = shared.on(key) {
            deliveryThread = Thread.currentThread().name
            delivered.countDown()
        }
        try {
            val publisher = Thread { shared.provide(key, Any()) }
            publisher.start()
            publisher.join(5_000)
            assertFalse(publisher.isAlive)
            assertTrue(delivered.await(5, TimeUnit.SECONDS))
            assertEquals("shared-host-main", deliveryThread)
        } finally {
            shared.cancel(key, token)
            DSXShared.mainExecutor = Executor { it.run() }
            executor.shutdownNow()
        }
    }

    // MARK: dsx.values — strong-ref VALUE state

    @Test fun valuesSetGetRemove() {
        values.set("v1.key", "hello")
        assertEquals("hello", values.get("v1.key"))
        values.remove("v1.key")
        assertNull(values.get("v1.key"))
    }

    @Test fun valuesSetNullRemoves() {
        values.set("v2.key", 42)
        values.set("v2.key", null)
        assertNull(values.get("v2.key"))
    }

    @Test fun valuesBoolIsNumberTolerantAndDefaultsFalse() {
        values.set("v3.t", true)
        values.set("v3.f", false)
        values.set("v3.one", 1)          // NSNumber tolerance: nonzero number reads true
        values.set("v3.zero", 0)
        values.set("v3.str", "true")     // a String is NOT a number — false, as on Swift
        assertTrue(values.bool("v3.t"))
        assertFalse(values.bool("v3.f"))
        assertTrue(values.bool("v3.one"))
        assertFalse(values.bool("v3.zero"))
        assertFalse(values.bool("v3.str"))
        assertFalse(values.bool("v3.unset"))
    }

    @Test fun valuesStringTypedRead() {
        values.set("v4.s", "auth.ok")
        values.set("v4.n", 7)
        assertEquals("auth.ok", values.string("v4.s"))
        assertNull(values.string("v4.n"))   // wrong type reads null, as on Swift
        assertNull(values.string("v4.unset"))
    }
}
