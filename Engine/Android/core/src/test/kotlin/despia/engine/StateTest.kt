package despia.engine

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import org.junit.jupiter.api.parallel.ResourceLock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * DSXState — the app store's dot-path semantics, the StateFlow/sink reactivity seams, and
 * the DSXGlobal / DSXValue / DSXConfigValue / DSXStateProxy faces. `DSX.state` and the
 * Generated* registries are process singletons, so every test uses its own key namespace
 * and restores any seam/registry it swaps.
 */
@ResourceLock("despia-engine-runtime-executors")
class StateTest {

    // MARK: dot-path get/set on a store

    @Test fun getPathOnMissingOrWrongShapedPathIsNull() {
        val store = StackStore()
        assertNull(store.getPath("a.b"))
        store.set("s", "scalar")
        assertNull(store.getPath("s.child"))            // descending through a scalar → null, no crash
        store.set("n", listOf(1, 2))
        assertNull(store.getPath("n.name"))             // non-numeric segment on an array → null
    }

    @Test fun setPathCreatesIntermediateDictionariesAndKeepsSiblings() {
        val store = StackStore()
        store.setPath("session.user.name", "ada")
        assertEquals("ada", store.getPath("session.user.name"))
        store.setPath("session.user.plan", "pro")       // sibling write rebuilds, never clobbers
        assertEquals("ada", store.getPath("session.user.name"))
        assertEquals("pro", store.getPath("session.user.plan"))
    }

    @Test fun declaredObjectDefaultsAreReadableAndPromotedWithoutLosingSiblings() {
        val store = StackStore()
        store.initials["qualification"] = mapOf(
            "focus" to "email",
            "values" to mapOf("email" to ""),
            "fields" to mapOf("email" to mapOf("error" to "")),
        )

        assertEquals("email", store.getPath("qualification.focus"))
        assertEquals("", store.getPath("qualification.values.email"))

        store.setPath("qualification.fieldOrder", listOf("email"))

        assertEquals("email", store.getPath("qualification.focus"))
        assertEquals("", store.getPath("qualification.values.email"))
        assertEquals("", store.getPath("qualification.fields.email.error"))
        assertEquals(listOf("email"), store.getPath("qualification.fieldOrder"))
        assertTrue(store.vars.containsKey("qualification"))
    }

    @Test fun liveTopLevelStateOverridesItsDeclaredDefault() {
        val store = StackStore()
        store.initials["form"] = mapOf("focus" to "email")
        store.set("form", mapOf("focus" to "password"))

        assertEquals("password", store.getPath("form.focus"))
    }

    @Test fun setPathOfASingleSegmentIsAPlainSet() {
        val store = StackStore()
        store.setPath("x", 5)
        assertEquals(5, store.vars["x"])
        store.setPath("", "ignored")                    // no head → no-op, like Swift's guard
        assertNull(store.vars[""])
    }

    @Test fun getPathTraversesArraysByNumericSegmentBoundsChecked() {
        val store = StackStore()
        store.set("feed", mapOf("data" to listOf(mapOf("name" to "a"), mapOf("name" to "b"))))
        assertEquals("b", store.getPath("feed.data.1.name"))
        assertNull(store.getPath("feed.data.9.name"))   // out of bounds → null
        assertNull(store.getPath("feed.data.-1"))       // negative → null
        store.set("m", mapOf("5" to "five"))
        assertEquals("five", store.getPath("m.5"))      // numeric segment on a DICT is a literal key
    }

    @Test fun setPathGrowsArraysWithEmptyDictFiller() {
        val store = StackStore()
        store.setPath("list.items.2.name", "third")
        val items = store.getPath("list.items") as List<*>
        assertEquals(3, items.size)
        assertTrue((items[0] as Map<*, *>).isEmpty())   // growth filler is an empty dict
        assertEquals("third", store.getPath("list.items.2.name"))
    }

    @Test fun hostilePathsFailClosedBeforeUnboundedAllocation() {
        val store = StackStore()
        store.setPath("negative.-1.value", "blocked")
        store.setPath("signed.+10000.value", "blocked")
        store.setPath("huge.10000.value", "blocked")
        store.setPath("overflow.999999999999999999999.value", "blocked")
        store.setPath("growth.1024.value", "blocked") // 1,025 fillers exceeds one-write growth budget
        store.setPath((listOf("deep") + (0 until 64).map { "d$it" }).joinToString("."), "blocked")
        store.setPath("long.${"x".repeat(257)}", "blocked")
        store.setPath("unicode.${"é".repeat(129)}", "blocked") // 258 UTF-8 bytes
        store.setPath("leading..empty", "blocked")
        store.setPath("trailing.", "blocked")
        store.setPath(".prefixed", "blocked")

        for (key in listOf(
            "negative", "signed", "huge", "overflow", "growth", "deep", "long", "unicode",
            "leading", "trailing", "prefixed",
        )) {
            assertFalse(store.vars.containsKey(key), "$key must not leave a partial top-level container")
        }

        store.setPath("boundary.1023.value", "ok")
        assertEquals("ok", store.getPath("boundary.1023.value"))
        assertEquals(1024, (store.getPath("boundary") as List<*>).size)
    }

    @Test fun setPathEditsAnExistingArrayIndexInPlace() {
        val store = StackStore()
        store.set("arr", mapOf("rows" to listOf(mapOf("v" to 1), mapOf("v" to 2))))
        store.setPath("arr.rows.0.v", 9)
        assertEquals(9, store.getPath("arr.rows.0.v"))
        assertEquals(2, store.getPath("arr.rows.1.v"))  // the sibling row survives the rebuild
    }

    @Test fun getPathOfTheEmptyPathIsTheRootDictionary() {
        val store = StackStore()
        store.set("k", 1)
        val root = store.getPath("") as Map<*, *>
        assertEquals(1, root["k"])
    }

    // MARK: reactivity — sink (the $vars.sink twin)

    @Test fun sinkFiresImmediatelyThenOnEveryPublishedWrite() {
        val store = StackStore()
        store.set("k", 1)
        val seen = ArrayList<Any?>()
        val sub = store.sink { seen.add(it["k"]) }
        assertEquals(listOf<Any?>(1), seen)             // @Published contract: current value on subscribe
        store.set("k", 2)
        assertEquals(listOf<Any?>(1, 2), seen)
        sub.cancel()
        store.set("k", 3)
        assertEquals(listOf<Any?>(1, 2), seen)          // cancelled → no more delivery
    }

    @Test fun cancelSuppressesAQueuedInitialSinkSnapshot() {
        val queued = ArrayDeque<Runnable>()
        val prior = StackStorePublisher.mainExecutor
        StackStorePublisher.mainExecutor = Executor { queued.addLast(it) }
        var subscription: AnyCancellable? = null
        try {
            var calls = 0
            val activeSubscription = StackStore().sink { calls += 1 }
            subscription = activeSubscription
            assertEquals(1, queued.size)

            activeSubscription.cancel()
            queued.removeFirst().run()

            assertEquals(0, calls)
        } finally {
            subscription?.cancel()
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun rejectedInitialSinkSchedulingRemovesTheRegistration() {
        val prior = StackStorePublisher.mainExecutor
        val store = StackStore()
        var calls = 0
        try {
            StackStorePublisher.mainExecutor = Executor {
                throw RejectedExecutionException("intentional initial rejection")
            }
            assertFailsWith<RejectedExecutionException> {
                store.sink { calls += 1 }
            }

            StackStorePublisher.mainExecutor = Executor { it.run() }
            store.set("after-rejection", true)
            assertEquals(0, calls)
        } finally {
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun throwingInlineInitialSinkRemovesTheRegistrationAndRethrows() {
        val prior = StackStorePublisher.mainExecutor
        val store = StackStore()
        var calls = 0
        try {
            StackStorePublisher.mainExecutor = Executor { it.run() }
            assertFailsWith<IllegalStateException> {
                store.sink {
                    calls += 1
                    throw IllegalStateException("intentional initial failure")
                }
            }
            assertEquals(1, calls)

            store.set("after-handler-failure", true)
            assertEquals(1, calls)
        } finally {
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun earlierSinkCanCancelALaterSinkInTheSamePublication() {
        val prior = StackStorePublisher.mainExecutor
        StackStorePublisher.mainExecutor = Executor { it.run() }
        val store = StackStore()
        var later: AnyCancellable? = null
        var laterUpdates = 0
        val earlier = store.sink { snapshot ->
            if (snapshot["lifecycle"] == 1) later?.cancel()
        }
        try {
            later = store.sink { snapshot ->
                if (snapshot["lifecycle"] == 1) laterUpdates += 1
            }

            store.set("lifecycle", 1)

            assertEquals(0, laterUpdates)
        } finally {
            later?.cancel()
            earlier.cancel()
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun reorderedInitialSinkSnapshotDrainsBeforeEveryNewerPublication() {
        val prior = StackStorePublisher.mainExecutor
        val executor = FirstSubmissionLastExecutor()
        val store = StackStore()
        val seen = ArrayList<Any?>()
        var subscription: AnyCancellable? = null
        var failure: Throwable? = null
        StackStorePublisher.mainExecutor = executor
        val subscribing = Thread {
            try {
                subscription = store.sink { seen += it["revision"] }
            } catch (error: Throwable) {
                failure = error
            }
        }.apply { isDaemon = true }
        subscribing.start()
        try {
            assertTrue(executor.awaitFirstSubmission())
            store.set("revision", 1) // queued before the blocked current-value task
            assertEquals(1, executor.queuedCount())
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            assertFalse(subscribing.isAlive)
            failure?.let { throw AssertionError("subscription failed", it) }
            assertEquals(2, executor.queuedCount())

            executor.drain()

            assertEquals(listOf<Any?>(null, 1), seen)
        } finally {
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            subscription?.cancel()
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun concurrentAndReentrantWritesDrainEverySnapshotInCommitOrder() {
        val prior = StackStorePublisher.mainExecutor
        StackStorePublisher.mainExecutor = Executor { it.run() }
        val store = StackStore()
        val seenSizes = ArrayList<Int>()
        val flowSizesAtSink = ArrayList<Int>()
        val sub = store.sink { snapshot ->
            seenSizes += snapshot.size
            flowSizesAtSink += store.varsFlow.value.size
        }
        try {
            val workers = (0 until 8).map { worker ->
                Thread {
                    repeat(40) { index -> store.set("fifo-$worker-$index", index) }
                }.apply { isDaemon = true }
            }
            workers.forEach(Thread::start)
            workers.forEach { it.join(10_000) }
            assertTrue(workers.none(Thread::isAlive))

            assertEquals((0..320).toList(), seenSizes)
            assertEquals(seenSizes, flowSizesAtSink)
            assertEquals(320, store.varsFlow.value.size)
        } finally {
            sub.cancel()
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun reentrantWriteJoinsTheSameFifoAfterTheCurrentPublication() {
        val prior = StackStorePublisher.mainExecutor
        StackStorePublisher.mainExecutor = Executor { it.run() }
        val store = StackStore()
        val seen = ArrayList<Int?>()
        var reentered = false
        val sub = store.sink { snapshot ->
            val value = snapshot["reentrant"] as? Int
            seen += value
            if (value == 1 && !reentered) {
                reentered = true
                store.set("reentrant", 2)
            }
        }
        try {
            store.set("reentrant", 1)
            assertEquals(listOf(null, 1, 2), seen)
            assertEquals(2, store.varsFlow.value["reentrant"])
        } finally {
            sub.cancel()
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun publishedSnapshotsRejectTopLevelMutationAndCannotCorruptOtherConsumers() {
        val store = StackStore()
        store.set("trusted", 1)

        assertFailsWith<UnsupportedOperationException> {
            @Suppress("UNCHECKED_CAST")
            (store.varsFlow.value as MutableMap<String, Any?>)["forged"] = true
        }

        val observed = ArrayList<Map<String, Any?>>()
        val hostile = store.sink { snapshot ->
            assertFailsWith<UnsupportedOperationException> {
                @Suppress("UNCHECKED_CAST")
                (snapshot as MutableMap<String, Any?>)["forged"] = true
            }
        }
        val witness = store.sink { observed += it }
        try {
            store.set("next", 2)

            assertFalse(store.varsFlow.value.containsKey("forged"))
            assertFalse(store.vars.containsKey("forged"))
            assertTrue(observed.none { it.containsKey("forged") })
            assertEquals(2, observed.last()["next"])
        } finally {
            hostile.cancel()
            witness.cancel()
        }
    }

    @Test fun deepEqualWritesAreElided() {
        val store = StackStore()
        store.set("cfg", mapOf("a" to listOf(1, 2)))
        var fires = 0
        val sub = store.sink { fires++ }                // the immediate fire
        assertEquals(1, fires)
        store.set("cfg", mapOf("a" to listOf(1, 2)))    // deep-equal top-level write → elided
        assertEquals(1, fires)
        store.setPath("cfg.a", listOf(1, 2))            // deep-equal REBUILT head → elided too
        assertEquals(1, fires)
        store.set("cfg", mapOf("a" to listOf(1, 3)))    // a real change publishes
        assertEquals(2, fires)
        sub.cancel()
    }

    @Test fun nullablePathWritesPublishPresentNullAndElideARepeat() {
        val store = StackStore()
        store.setPath("api.data", mapOf("id" to 1))
        var fires = 0
        val sub = store.sink { fires++ }

        store.setPath("api.data", null)

        val api = store.varsFlow.value["api"] as Map<*, *>
        assertTrue(api.containsKey("data"))
        assertNull(api["data"])
        assertEquals(2, fires)                         // immediate snapshot + the null transition

        store.setPath("api.data", null)
        assertEquals(2, fires)                         // present-null → present-null is a no-op

        store.set("topNull", null)
        assertTrue(store.varsFlow.value.containsKey("topNull"))
        assertNull(store.varsFlow.value["topNull"])
        assertEquals(3, fires)
        store.set("topNull", null)
        assertEquals(3, fires)                         // containsKey distinguishes absent from present-null
        sub.cancel()
    }

    // MARK: reactivity — varsFlow (the $vars twin)

    @Test fun varsFlowCollectorSeesThePublishedSnapshot() = runBlocking {
        val store = StackStore()
        val seen = ArrayList<Map<String, Any?>>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            store.varsFlow.take(2).toList(seen)
        }
        store.set("x", 1)
        job.join()
        assertEquals(2, seen.size)
        assertTrue(seen[0].isEmpty())                   // the initial snapshot
        assertEquals(1, seen[1]["x"])                   // the published one
        assertEquals(1, store.varsFlow.value["x"])      // .value is the live snapshot
    }

    @Test fun writesRouteThroughTheMainExecutorSeam() {
        // Swift hops off-main writes to DispatchQueue.main; the JVM seam is
        // StackStorePublisher.mainExecutor. Swap in a deferring executor and observe.
        val queued = ArrayList<Runnable>()
        val prior = StackStorePublisher.mainExecutor
        StackStorePublisher.mainExecutor = Executor { queued.add(it) }
        try {
            val store = StackStore()
            store.set("k", 1)
            assertNull(store.vars["k"])                 // deferred by the seam
            queued.forEach { it.run() }
            assertEquals(1, store.vars["k"])            // applied when the "main thread" runs
        } finally {
            StackStorePublisher.mainExecutor = prior
        }
    }

    @Test fun concurrentWritesSmoke() {
        val store = StackStore()
        val threads = (0 until 8).map { t ->
            Thread { for (i in 0 until 50) store.setPath("t$t.k$i", i) }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        for (t in 0 until 8) for (i in 0 until 50) assertEquals(i, store.getPath("t$t.k$i"))
    }

    // MARK: writeBound — the scope router

    @Test fun writeBoundRoutesByScope() {
        val surface = StackStore()
        surface.writeBound("global.wb1.premium", true)  // global.* → the app store, prefix stripped
        assertEquals(true, DSX.state.getPath("wb1.premium"))
        assertNull(surface.vars["global.wb1.premium"])
        surface.writeBound("route.wb.path", "/premium") // route.* → the app store, prefix KEPT
        assertEquals("/premium", DSX.state.getPath("route.wb.path"))
        surface.writeBound("dsx.global.wb2.x", 7)       // the dsx.-rooted spelling normalizes first
        assertEquals(7, DSX.state.getPath("wb2.x"))
        surface.writeBound("wbuser.email", "a@b.c")     // bare path → THIS surface store
        assertEquals("a@b.c", surface.getPath("wbuser.email"))
        assertNull(DSX.state.getPath("wbuser.email"))
    }

    // MARK: dsx.global — string-path verbs + the DSXValue chain

    @Test fun globalStringPathVerbs() {
        val g = DSXGlobal()
        g.set("g1.session.credits", 200)
        assertEquals(200, g.get("g1.session.credits"))
        assertNull(g.get("g1.absent.path"))
        g.state("g2", mapOf("userId" to "1", "plan" to "pro"))
        assertEquals("1", g.get("g2.userId"))
        g.state("g2", mapOf("plan" to "free"))          // seed/REPLACE the whole top-level key
        assertNull(g.get("g2.userId"))
        assertEquals("free", g.get("g2.plan"))
    }

    @Test fun globalValueChainReadsTyped() {
        val g = DSXGlobal()
        g.set("g3.user.name", "ada")
        g.set("g3.user.credits", 41.9)
        assertEquals("ada", g.value("g3.user")["name"].string)
        assertEquals(41, g.value("g3.user")["credits"].int)     // a Double leaf truncates, like Int.init
        assertEquals(41.9, g.value("g3.user")["credits"].double)
        assertEquals("ada", g.value("g3.user.name").string)     // the entry accepts a dotted path (getPath)
        val missing = g.value("g3.nothing")["deeper"]
        assertFalse(missing.exists)
        assertNull(missing.string)
        assertNull(missing.bool)
        assertNull(missing.any)
        assertNull(g.value("g3.user")["name"]["down"].string)   // descending through a leaf → empty, no crash
        assertTrue(g.value("g3.user").dict?.containsKey("name") ?: false)
    }

    // MARK: DSXLocale

    @Test fun localePickWalksExactThenLanguageThenDefault() {
        val prior = DSXLocale.preferredLanguages
        try {
            val map = mapOf("default" to "Save", "de-DE" to "Sichern", "fr" to "Enregistrer")
            DSXLocale.preferredLanguages = { listOf("de-DE") }
            assertEquals("Sichern", DSXLocale.pick(map))        // exact tag
            DSXLocale.preferredLanguages = { listOf("DE-de") }
            assertEquals("Sichern", DSXLocale.pick(map))        // case-insensitive
            DSXLocale.preferredLanguages = { listOf("fr-CA") }
            assertEquals("Enregistrer", DSXLocale.pick(map))    // bare-language rung
            DSXLocale.preferredLanguages = { listOf("es-MX") }
            assertEquals("Save", DSXLocale.pick(map))           // default rung
            assertEquals("", DSXLocale.pick(mapOf("de" to "x")))   // no default → ""
        } finally {
            DSXLocale.preferredLanguages = prior
        }
    }

    // MARK: DSXConfigValue

    @Test fun configValueScalarAndLocalizedShapes() {
        val prior = DSXLocale.preferredLanguages
        try {
            DSXLocale.preferredLanguages = { listOf("de-DE") }
            val localized = DSXConfigValue(mapOf("default" to "Buy", "de-DE" to "Kaufen", "fr" to "Acheter"))
            assertTrue(localized.exists)
            assertTrue(localized.isLocalized)
            assertEquals(listOf("de-DE", "fr"), localized.locales)  // sorted, sans "default"
            assertEquals("Kaufen", localized.value)                 // device-locale resolution
            assertEquals("Buy", localized.default)
            assertEquals("Acheter", localized.forLocale("fr-CA"))   // bare-language rung
            assertEquals("Buy", localized.forLocale("es"))          // default rung
            assertEquals(3, localized.byLocale.size)

            val scalar = DSXConfigValue("hello")
            assertFalse(scalar.isLocalized)
            assertEquals("hello", scalar.value)
            assertEquals("hello", scalar.default)                   // uniform: scalar IS the default
            assertEquals("hello", scalar.forLocale("de"))
            assertEquals(mapOf("default" to "hello"), scalar.byLocale)

            val structured = DSXConfigValue(mapOf("default" to 1))  // non-string values → NOT localized
            assertFalse(structured.isLocalized)
            assertNull(structured.default)
        } finally {
            DSXLocale.preferredLanguages = prior
        }
    }

    @Test fun configValueTypedScalarReads() {
        val flag = DSXConfigValue(true)
        assertTrue(flag.bool)
        assertNull(flag.default)                        // a Bool has no string default
        assertEquals("", flag.value)

        val n = DSXConfigValue(42)
        assertEquals(42, n.int)
        assertEquals(42.0, n.double)
        val d = DSXConfigValue(3.7)
        assertEquals(3, d.int)                          // truncation, like Int.init

        val l = DSXConfigValue(listOf("a", 1, "b"))
        assertEquals(listOf("a", 1, "b"), l.list)
        assertEquals(listOf("a", "b"), l.strings)       // heterogeneous list filters to strings

        val absent = DSXConfigValue(null)
        assertFalse(absent.exists)
        assertEquals("", absent.value)
        assertEquals(0, absent.int)
        assertFalse(absent.bool)
        assertTrue(absent.strings.isEmpty())
    }

    // MARK: dsx.config — the proxy over GeneratedConfigRaw

    @Test fun configProxyReadsThisSchemesRawConfig() {
        val prior = GeneratedConfigRaw.byScheme
        try {
            GeneratedConfigRaw.byScheme = mapOf("cp1" to mapOf("api_key" to "k-1", "max" to 3))
            val config = DSXConfigProxy("cp1")
            assertEquals("k-1", config["api_key"].value)
            assertEquals(3, config["max"].int)
            assertFalse(config["typo"].exists)          // unknown key → empty value, never a crash
            assertFalse(DSXConfigProxy("excluded")["api_key"].exists)   // absent scheme → empty too
        } finally {
            GeneratedConfigRaw.byScheme = prior
        }
    }

    // MARK: dsx.context / dsx.module.x.context — DSXStateProxy

    @Test fun stateProxyStaticLiveAndDefaultResolution() {
        val priorState = GeneratedStateRegistry.byScheme
        val priorConfig = GeneratedConfigRaw.byScheme
        try {
            GeneratedStateRegistry.byScheme = mapOf(
                "sp1" to mapOf(
                    "enabled" to mapOf("source" to "sp1_enabled"),  // STATIC: mirrors a config key
                    "credits" to mapOf("default" to 5),             // LIVE with a declared default
                    "session" to emptyMap(),                        // LIVE, no default
                ),
            )
            GeneratedConfigRaw.byScheme = mapOf("sp1" to mapOf("sp1_enabled" to true))
            val ctx = DSXStateProxy("sp1")

            assertTrue(ctx["enabled"].bool)                    // static resolves from config
            assertNull(ctx["enabled"]["nested"].raw)           // config-backed vars don't nest
            ctx.set("enabled", false)                          // a STATIC write is inert for reads
            assertTrue(ctx["enabled"].bool)

            assertEquals(5, ctx["credits"].int)                // live: declared default until set
            ctx.set("credits", 12)                             // publish → the reactive store
            assertEquals(12, ctx["credits"].int)
            assertEquals(12, DSX.state.getPath("sp1.credits")) // stored at "<scheme>.<var>"

            ctx.set("session.user", "ada")                     // nested live var
            assertEquals("ada", ctx["session"]["user"].string)

            assertFalse(ctx["unknown"].exists)                 // undeclared var → typed defaults
            assertEquals("", ctx["unknown"].string)
            assertNull(DSXStateProxy("gone")["anything"].raw)  // excluded owner → null, never a crash
            assertNull(ctx.raw)                                // the root ("" path) resolves nothing
        } finally {
            GeneratedStateRegistry.byScheme = priorState
            GeneratedConfigRaw.byScheme = priorConfig
        }
    }

    @Test fun stateProxyOnFiresNowDedupesAndRefires() {
        val priorState = GeneratedStateRegistry.byScheme
        try {
            GeneratedStateRegistry.byScheme = mapOf("sp2" to mapOf("flag" to mapOf("default" to false)))
            val ctx = DSXStateProxy("sp2")
            val seen = ArrayList<Boolean>()
            val sub = ctx.on("flag") { seen.add(it.bool) }
            assertEquals(listOf(false), seen)                  // fires NOW with the current (default) value
            ctx.set("flag", true)
            assertEquals(listOf(false, true), seen)            // re-fires on a real change
            ctx.set("flag", true)                              // elided write → no publish → no re-fire
            assertEquals(listOf(false, true), seen)
            DSX.state.setPath("sp2noise.k", 1)                 // unrelated publish → sameRaw dedupe
            assertEquals(listOf(false, true), seen)
            sub.cancel()
            ctx.set("flag", false)
            assertEquals(listOf(false, true), seen)            // cancelled → no more delivery
        } finally {
            GeneratedStateRegistry.byScheme = priorState
        }
    }

    @Test fun stateProxyOnInitialDeliveryUsesThePublisherExecutor() {
        val priorState = GeneratedStateRegistry.byScheme
        val priorExecutor = StackStorePublisher.mainExecutor
        val queued = ArrayDeque<Runnable>()
        var sub: AnyCancellable? = null
        try {
            GeneratedStateRegistry.byScheme = mapOf(
                "sp3" to mapOf("flag" to mapOf("default" to false)),
            )
            StackStorePublisher.mainExecutor = Executor { queued.addLast(it) }
            val callbackThreads = ArrayList<Thread>()

            sub = DSXStateProxy("sp3").on("flag") { callbackThreads += Thread.currentThread() }

            assertTrue(callbackThreads.isEmpty(), "initial delivery must not bypass the executor")
            assertEquals(1, queued.size)
            val deliveryThread = Thread({ queued.removeFirst().run() }, "state-proxy-main")
            deliveryThread.start()
            deliveryThread.join(5_000)
            assertFalse(deliveryThread.isAlive)
            assertEquals(listOf("state-proxy-main"), callbackThreads.map { it.name })
        } finally {
            sub?.cancel()
            StackStorePublisher.mainExecutor = priorExecutor
            GeneratedStateRegistry.byScheme = priorState
        }
    }

    @Test fun stateProxyOnDoesNotLoseAReentrantWriteFromItsInitialHandler() {
        val priorState = GeneratedStateRegistry.byScheme
        val priorExecutor = StackStorePublisher.mainExecutor
        var sub: AnyCancellable? = null
        try {
            GeneratedStateRegistry.byScheme = mapOf(
                "sp4" to mapOf("flag" to mapOf("default" to false)),
            )
            StackStorePublisher.mainExecutor = Executor { it.run() }
            val context = DSXStateProxy("sp4")
            val seen = ArrayList<Boolean>()

            sub = context.on("flag") { value ->
                seen += value.bool
                if (seen.size == 1) {
                    context.set("flag", true)
                    context.set("flag", false)
                }
            }

            assertEquals(listOf(false, true, false), seen)
        } finally {
            sub?.cancel()
            StackStorePublisher.mainExecutor = priorExecutor
            GeneratedStateRegistry.byScheme = priorState
        }
    }

    @Test fun stateProxyOnUsesEachCapturedSnapshotWhenInitialSubmissionRunsLast() {
        val priorState = GeneratedStateRegistry.byScheme
        val priorExecutor = StackStorePublisher.mainExecutor
        val executor = FirstSubmissionLastExecutor()
        val context = DSXStateProxy("sp5")
        val seen = ArrayList<Boolean>()
        var sub: AnyCancellable? = null
        var failure: Throwable? = null
        StackStorePublisher.mainExecutor = executor
        GeneratedStateRegistry.byScheme = mapOf(
            "sp5" to mapOf("flag" to mapOf("default" to false)),
        )
        val subscribing = Thread {
            try {
                sub = context.on("flag") { seen += it.bool }
            } catch (error: Throwable) {
                failure = error
            }
        }.apply { isDaemon = true }
        subscribing.start()
        try {
            assertTrue(executor.awaitFirstSubmission())
            context.set("flag", true)
            assertEquals(1, executor.queuedCount())
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            assertFalse(subscribing.isAlive)
            failure?.let { throw AssertionError("proxy subscription failed", it) }
            assertEquals(2, executor.queuedCount())

            executor.drain()

            assertEquals(listOf(false, true), seen)
        } finally {
            executor.releaseFirstSubmission()
            subscribing.join(10_000)
            sub?.cancel()
            StackStorePublisher.mainExecutor = priorExecutor
            GeneratedStateRegistry.byScheme = priorState
        }
    }

    // MARK: DSXConfigTemplate — {{ dsx.* }} in config strings

    @Test fun configTemplateResolvesDsxTokensAgainstTheStore() {
        DSX.state.setPath("app.host", "example.de")
        DSX.state.setPath("app.build", 260)
        assertEquals("no tokens", DSXConfigTemplate.resolve("no tokens"))   // the cheap common case
        assertEquals("https://example.de/app", DSXConfigTemplate.resolve("https://{{ dsx.app.host }}/app"))
        assertEquals("b=260", DSXConfigTemplate.resolve("b={{ dsx.app.build }}"))   // non-string stringifies
        assertEquals("=", DSXConfigTemplate.resolve("{{ dsx.app.missing }}="))      // store-scoped + absent → "" (markup semantics)
        assertEquals(
            "a example.de b example.de",
            DSXConfigTemplate.resolve("a {{dsx.app.host}} b {{ dsx.app.host }}"),   // spacing-tolerant, multi-span
        )
    }

    @Test fun configTemplatePreservesTokensAddressedToAnotherStage() {
        DSX.state.setPath("app.host", "example.de")
        // The config read consumes ONLY store-scoped tokens; anything else survives verbatim for
        // its own stage. THE regression this pins: a Live-Activity layout sourced into config
        // carries {{ dsx.variable.* }} bindings that only the extension's renderer can resolve —
        // eating them here blanked every binding before the layout ever reached the widget.
        assertEquals(
            "<text>{{ dsx.variable.name }}</text>",
            DSXConfigTemplate.resolve("<text>{{ dsx.variable.name }}</text>"),
        )
        assertEquals("x={{ env.HOST }}", DSXConfigTemplate.resolve("x={{ env.HOST }}"))   // non-dsx → not ours
        assertEquals(
            // Mixed spans: the store token resolves, the surface token rides through untouched.
            "https://example.de <gauge value=\"{{ dsx.variable.progress }}\"/>",
            DSXConfigTemplate.resolve("https://{{ dsx.app.host }} <gauge value=\"{{ dsx.variable.progress }}\"/>"),
        )
    }
}
