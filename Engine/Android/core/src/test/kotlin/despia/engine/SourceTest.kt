package despia.engine

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class SourceTest {
    private class FakeStampStore : DSXSourceStampStore {
        val values = ConcurrentHashMap<String, String>()
        override fun read(key: String): String? = values[key]
        override fun write(key: String, value: String) { values.putIfAbsent(key, value) }
    }

    @AfterTest
    fun reset() {
        DSXSource.resetForTests()
    }

    @Test
    fun trackAndPublishPreserveNeverStaleLiveContractAcrossStoreReinstall() {
        val store = FakeStampStore()
        DSXSource.installStampStore(store)
        DSXSource.clock = Clock.fixed(Instant.parse("2026-07-23T12:34:56Z"), ZoneOffset.UTC)
        val plane = "view_source_test"
        val key = "example.test"

        DSXSource.track(plane, key)
        assertEquals("never", DSXSource.state(plane))

        DSXSource.publish(plane, DSXSource.servingCache, fresh = false, key = key)
        assertEquals(
            mapOf(
                "state" to "never",
                "serving" to "cache",
                "at" to "2026-07-23T12:34:56Z",
            ),
            DSX.state.getPath("source.$plane"),
        )

        DSXSource.publish(plane, DSXSource.servingOrigin, fresh = true, key = key)
        assertEquals("live", DSXSource.state(plane))
        assertEquals(1, store.values.size)

        // A new session reusing the host's durable store starts stale until origin answers.
        DSXSource.installStampStore(store)
        DSXSource.track(plane, key)
        assertEquals("stale", DSXSource.state(plane))
        DSXSource.publish(plane, DSXSource.servingBundle, fresh = false, key = key)
        assertEquals("stale", DSXSource.state(plane))
    }

    @Test
    fun persistenceKeysAreFixedSizeNonSecretAndOriginScoped() {
        val a = DSXSource.stampKey("view", "user:secret@example.test")
        val b = DSXSource.stampKey("view", "other.example.test")
        assertEquals(67, a.length)
        assertTrue(a.startsWith("v1."))
        assertFalse(a.contains("secret"))
        assertNotEquals(a, b)
    }

    @Test
    fun invalidPlanesServingValuesAndReservedMetaCannotCorruptSourceShape() {
        val before = DSX.state.getPath("source")
        DSXSource.track("bad.plane", "x")
        assertEquals(before, DSX.state.getPath("source"))

        val plane = "source_validation_test"
        DSXSource.publish(plane, "network-ish", fresh = true, key = "x")
        assertEquals("", DSXSource.state(plane))
        DSXSource.publish(
            plane,
            DSXSource.servingOrigin,
            fresh = true,
            key = "x",
            meta = mapOf("state" to "forged", "serving" to "forged", "path" to "/safe"),
        )
        val slice = DSX.state.getPath("source.$plane") as Map<*, *>
        assertEquals("live", slice["state"])
        assertEquals("origin", slice["serving"])
        assertEquals("/safe", slice["path"])

        val beforeOversizedKey = DSX.state.getPath("source")
        DSXSource.publish(
            "oversized_source_key_test",
            DSXSource.servingOrigin,
            fresh = true,
            key = "x".repeat(8 * 1_024 + 1),
        )
        assertEquals(beforeOversizedKey, DSX.state.getPath("source"))
    }

    @Test
    fun seedPublishesFirstThenWarmAcrossInstallsAndOnlineOnlyWhenObservable() {
        val store = FakeStampStore()
        DSXSource.installStampStore(store)
        DSXSource.clock = Clock.fixed(Instant.parse("2026-07-23T12:34:56Z"), ZoneOffset.UTC)

        DSXSource.seed(online = true)
        assertEquals("first", DSX.state.getPath("source.boot"))
        assertEquals(true, DSX.state.getPath("source.online"))
        assertEquals(1, store.values.size)

        // A later launch of the SAME install reads the durable stamp — "warm" forever after.
        DSXSource.installStampStore(store)
        DSXSource.seed(online = false)
        assertEquals("warm", DSX.state.getPath("source.boot"))
        assertEquals(false, DSX.state.getPath("source.online"))
        assertEquals(1, store.values.size)

        // A host that cannot OBSERVE reachability leaves the fact standing rather than guessing.
        DSX.state.setPath("source.online", "sentinel")
        DSXSource.seed(online = null)
        assertEquals("sentinel", DSX.state.getPath("source.online"))
    }

    private class OnlineWatcher : Module() {
        override val scheme get() = "src.online.watch"
        override fun setup() { dsx.delegate.listen("source.changed") { input -> seen.add(input); null } }
        companion object { val seen = mutableListOf<Any?>() }
    }

    @Test
    fun setOnlineDedupesAndOnlyFiresSourceChangedOnRealEdges() {
        ModuleRegistry.shared.register { OnlineWatcher() }
        DSX.state.setPath("source.online", true)
        OnlineWatcher.seen.clear()

        DSXSource.setOnline(true)          // unchanged — neither publishes nor fires
        assertEquals(0, OnlineWatcher.seen.size)
        DSXSource.setOnline(false)
        assertEquals(false, DSX.state.getPath("source.online"))
        assertEquals(
            listOf<Any?>(mapOf("plane" to "online", "state" to false)),
            OnlineWatcher.seen,
        )
        DSXSource.setOnline(false)
        assertEquals(1, OnlineWatcher.seen.size)
    }

    @Test
    fun concurrentPublishAndTrackKeepOneOriginStampAndAValidSlice() {
        val store = FakeStampStore()
        DSXSource.installStampStore(store)
        val pool = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        val done = CountDownLatch(64)
        repeat(64) { index ->
            pool.execute {
                try {
                    start.await()
                    if (index % 3 == 0) DSXSource.track("view_concurrent_test", "example.test")
                    else DSXSource.publish(
                        "view_concurrent_test",
                        if (index % 2 == 0) DSXSource.servingOrigin else DSXSource.servingCache,
                        fresh = index % 2 == 0,
                        key = "example.test",
                    )
                } finally {
                    done.countDown()
                }
            }
        }
        start.countDown()
        assertTrue(done.await(10, TimeUnit.SECONDS))
        pool.shutdownNow()
        assertEquals(1, store.values.size)
        val slice = DSX.state.getPath("source.view_concurrent_test") as Map<*, *>
        assertTrue(slice["state"] in setOf("stale", "live"))
        assertTrue(slice["serving"] in setOf("cache", "origin", null))
    }
}
