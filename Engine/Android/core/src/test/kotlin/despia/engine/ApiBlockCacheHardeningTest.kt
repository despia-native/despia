package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApiBlockCacheHardeningTest {
    @AfterTest
    fun reset() {
        ApiBlock.clearCache()
        ApiBlock.cachePartition = { "" }
        ApiBlock.requestCachePartition = { ApiBlock.cachePartition() }
    }

    @Test
    fun noStoreResponseIsNeverRetainedForALaterCacheEnabledDeclaration() {
        val store = StackStore()
        var calls = 0
        fun mount(cache: String, value: String) = ApiBlock(
            spec = mapOf("as" to "result", "url" to "/same", "cache" to cache),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to value)
            },
            now = { 1_000L },
        )

        mount("no-store", "secret").dispose()
        mount("max-age(60)", "fresh").dispose()

        assertEquals(2, calls)
        assertEquals("fresh", store.getPath("result.data"))
    }

    @Test
    fun authorizationHeadersPartitionCacheEntries() {
        val store = StackStore()
        var calls = 0
        val spec = mapOf(
            "as" to "result",
            "url" to "/private",
            "headers" to "auth",
            "cache" to "max-age(60)",
        )
        fun mount() = ApiBlock(
            spec = spec,
            store = store,
            fetch = { _, request ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to request["headers"])
            },
            now = { 1_000L },
        )

        store.set("auth", mapOf("Authorization" to "Bearer user-a"))
        mount().dispose()
        store.set("auth", mapOf("Authorization" to "Bearer user-b"))
        mount().dispose()

        assertEquals(2, calls)
        assertEquals(
            mapOf("authorization" to "Bearer user-b"),
            store.getPath("result.data"),
        )
    }

    @Test
    fun expectModePartitionsDecodedCacheValues() {
        val store = StackStore()
        var calls = 0
        fun mount(expect: String) = ApiBlock(
            spec = mapOf(
                "as" to "result",
                "url" to "/same",
                "expect" to expect,
                "cache" to "max-age(60)",
            ),
            store = store,
            fetch = { _, request ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to request["expect"])
            },
            now = { 1_000L },
        )

        mount("json").dispose()
        mount("text").dispose()

        assertEquals(2, calls)
        assertEquals("text", store.getPath("result.data"))
    }

    @Test
    fun partitionIsSnapshottedAtRequestStartNotResponseSettle() {
        val store = StackStore()
        var partition = "session-a"
        ApiBlock.cachePartition = { partition }
        val completions = ArrayList<(Map<String, Any?>) -> Unit>()
        var calls = 0
        fun mount() = ApiBlock(
            spec = mapOf("as" to "result", "url" to "/private", "cache" to "max-age(60)"),
            store = store,
            fetch = { _, _ -> error("blocking transport must not run") },
            asyncFetch = ApiBlockAsyncFetch { _, _, completion ->
                calls += 1
                completions += completion
                ApiBlockFetchCall {}
            },
            now = { 1_000L },
        )

        val first = mount()
        partition = "session-b" // response-side Set-Cookie/session rotation
        completions.removeAt(0).invoke(
            mapOf("ok" to true, "status" to 200.0, "data" to "old-session"))
        first.dispose()
        val second = mount()

        assertEquals(2, calls, "session-b must not consume session-a's in-flight result")
        second.dispose()
    }

    @Test
    fun separateSurfaceStoresNeverShareCacheData() {
        var calls = 0
        fun mount(store: StackStore, owner: String) = ApiBlock(
            spec = mapOf("as" to "result", "url" to "/private", "cache" to "max-age(60)"),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to owner)
            },
            now = { 1_000L },
        )

        val first = StackStore()
        val second = StackStore()
        mount(first, "first").dispose()
        mount(second, "second").dispose()

        assertEquals(2, calls)
        assertEquals("first", first.getPath("result.data"))
        assertEquals("second", second.getPath("result.data"))
    }

    @Test
    fun leastRecentlyUsedEntryIsEvictedAtTheBound() {
        val store = StackStore()
        var calls = 0
        fun mount(index: Int) = ApiBlock(
            spec = mapOf(
                "as" to "result",
                "url" to "/entry/$index",
                "cache" to "max-age(60)",
            ),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to index.toDouble())
            },
            now = { 1_000L },
        )

        for (index in 0..ApiBlock.cacheLimit) mount(index).dispose()
        mount(0).dispose()

        assertEquals(ApiBlock.cacheLimit + 2, calls)
        assertEquals(0.0, store.getPath("result.data"))
    }

    @Test
    fun oversizedSuccessfulResponseIsServedButNeverRetained() {
        val store = StackStore()
        val oversized = ByteArray((ApiBlock.maxCacheEntryBytes + 1L).toInt())
        var calls = 0
        fun mount() = ApiBlock(
            spec = mapOf(
                "as" to "result",
                "url" to "/oversized",
                "cache" to "max-age(60)",
            ),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to oversized)
            },
            now = { 1_000L },
        )

        mount().dispose()
        assertEquals(oversized, store.getPath("result.data"))
        mount().dispose()

        assertEquals(2, calls)
    }

    @Test
    fun cachedGraphsAreDetachedAtInsertionAndEveryCacheHit() {
        val store = StackStore()
        val response = arrayListOf<Any?>("seed")
        var calls = 0
        fun mount() = ApiBlock(
            spec = mapOf("as" to "result", "url" to "/mutable", "cache" to "max-age(60)"),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to response)
            },
            now = { 1_000L },
        )

        mount().dispose()
        response += "transport-mutation"
        mount().dispose()
        @Suppress("UNCHECKED_CAST")
        val firstHit = store.getPath("result.data") as MutableList<Any?>
        assertEquals(listOf<Any?>("seed"), firstHit)

        firstHit += "consumer-mutation"
        mount().dispose()
        assertEquals(listOf<Any?>("seed"), store.getPath("result.data"))
        assertEquals(1, calls)
    }

    @Test
    fun cyclicCacheGraphsAreServedButNotCachedWithoutRecursiveCopying() {
        val store = StackStore()
        val response = ArrayList<Any?>()
        response.add(response)
        var calls = 0
        fun mount() = ApiBlock(
            spec = mapOf("as" to "result", "url" to "/cycle", "cache" to "max-age(60)"),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to response)
            },
            now = { 1_000L },
        )

        mount().dispose()
        mount().dispose()
        assertEquals(2, calls)
        assertTrue(response === response[0])
    }

    @Test
    fun overDepthGraphsAreServedButNotCachedWithoutRecursiveCopying() {
        val store = StackStore()
        var response: Any? = "leaf"
        repeat(ApiBlock.maxCacheGraphDepth + 2) { response = listOf(response) }
        var calls = 0
        fun mount() = ApiBlock(
            spec = mapOf("as" to "result", "url" to "/deep", "cache" to "max-age(60)"),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to response)
            },
            now = { 1_000L },
        )

        mount().dispose()
        mount().dispose()
        assertEquals(2, calls)
    }

    @Test
    fun byteBudgetEvictsTheLeastRecentlyUsedEntryBeforeTheCountLimit() {
        val store = StackStore()
        // Reuse one backing allocation so this test verifies accounting without
        // forcing the test JVM itself to retain one large array per cache entry.
        val payload = ByteArray((12L * 1024L * 1024L).toInt())
        var calls = 0
        fun mount(index: Int) = ApiBlock(
            spec = mapOf(
                "as" to "result",
                "url" to "/large/$index",
                "cache" to "max-age(60)",
            ),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to payload)
            },
            now = { 1_000L },
        )

        mount(0).dispose()
        mount(0).dispose()
        assertEquals(1, calls, "an individually eligible entry should be cached")
        for (index in 1..5) mount(index).dispose()
        mount(0).dispose()

        assertEquals(7, calls, "aggregate byte pressure should evict the oldest entry")
    }

    @Test
    fun successfulMutationInvalidatesSurfaceReadCache() {
        val store = StackStore()
        var reads = 0
        fun read(value: String) = ApiBlock(
            spec = mapOf(
                "as" to "read",
                "url" to "/items",
                "cache" to "max-age(60)",
            ),
            store = store,
            fetch = { _, _ ->
                reads += 1
                mapOf("ok" to true, "status" to 200.0, "data" to value)
            },
            now = { 1_000L },
        )

        read("before").dispose()
        read("cached").dispose()
        assertEquals(1, reads)

        val mutation = ApiBlock(
            spec = mapOf(
                "as" to "write",
                "url" to "/items",
                "method" to "POST",
                "auto" to "false",
            ),
            store = store,
            fetch = { _, _ ->
                mapOf("ok" to true, "status" to 204.0, "data" to null)
            },
            now = { 1_000L },
        )
        mutation.send(mapOf("id" to 1.0))
        mutation.dispose()

        read("after").dispose()
        assertEquals(2, reads)
        assertEquals("after", store.getPath("read.data"))
    }
}
