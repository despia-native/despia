package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ApiBlockReactivityTest {

    @AfterTest
    fun clearCache() {
        ApiBlock.clearCache()
        ApiBlock.cachePartition = { "" }
        ApiBlock.requestCachePartition = { ApiBlock.cachePartition() }
    }

    @Test
    fun invalidAsIdentifierCannotMutateStateOrStartTransport() {
        val store = StackStore()
        var calls = 0
        val block = ApiBlock(
            spec = mapOf("as" to "payload.-1", "url" to "/api/data"),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to null)
            },
        )

        assertEquals(0, calls)
        assertTrue(store.vars.isEmpty())
        assertNull(block.send())
        assertEquals(0, calls)
        block.dispose()
        assertTrue(store.vars.isEmpty())
    }

    @Test
    fun successPublishesLoadingDataNullErrorAndFetchedAtToVarsFlow() {
        val store = StackStore()
        val flow = store.varsFlow
        val published = ArrayList<Map<String, Any?>>()
        val subscription = store.sink { published += it }
        var sawLoadingInFlow = false

        val block = ApiBlock(
            spec = mapOf("as" to "request", "url" to "https://example.test/success"),
            store = store,
            fetch = { _, _ ->
                val inFlight = flow.value.envelope("request")
                sawLoadingInFlow = inFlight["loading"] == true
                linkedMapOf(
                    "ok" to true,
                    "status" to 200.0,
                    "data" to linkedMapOf("id" to 7.0),
                )
            },
            now = { 42_000L },
        )

        assertTrue(sawLoadingInFlow, "varsFlow must expose loading=true before fetch starts")
        val settled = flow.value.envelope("request")
        assertFalse(settled["loading"] as Boolean)
        assertEquals(linkedMapOf("id" to 7.0), settled["data"])
        assertTrue(settled.containsKey("error"), "a real null error remains a present envelope field")
        assertNull(settled["error"])
        assertEquals(42_000.0, settled["fetchedAt"])
        assertTrue(published.any { it.envelopeOrNull("request")?.get("loading") == true })
        assertTrue(published.any { it.envelopeOrNull("request")?.get("data") == linkedMapOf("id" to 7.0) })
        assertTrue(published.any { it.envelopeOrNull("request")?.get("fetchedAt") == 42_000.0 })

        subscription.cancel()
        block.dispose()
    }

    @Test
    fun failurePublishesErrorWhilePreservingPresentNullData() {
        val store = StackStore()
        val flow = store.varsFlow
        var sawLoadingInFlow = false

        val block = ApiBlock(
            spec = mapOf("as" to "request", "url" to "https://example.test/failure"),
            store = store,
            fetch = { _, _ ->
                sawLoadingInFlow = flow.value.envelope("request")["loading"] == true
                linkedMapOf(
                    "ok" to false,
                    "status" to 503.0,
                    "data" to linkedMapOf("reason" to "maintenance"),
                    "error" to "temporarily unavailable",
                )
            },
            now = { 81_000L },
        )

        assertTrue(sawLoadingInFlow)
        val settled = flow.value.envelope("request")
        assertFalse(settled["loading"] as Boolean)
        assertTrue(settled.containsKey("data"))
        assertNull(settled["data"])
        assertEquals(81_000.0, settled["fetchedAt"])
        val error = settled["error"] as Map<*, *>
        assertEquals(503.0, error["status"])
        assertEquals("temporarily unavailable", error["message"])
        assertEquals(linkedMapOf("reason" to "maintenance"), error["body"])

        block.dispose()
    }

    @Test
    fun cancelSettlesAwaitedSendExactlyOnceEvenWhenTransportNeverCompletes() {
        val store = StackStore()
        var transportCompletion: ((Map<String, Any?>) -> Unit)? = null
        var transportCancels = 0
        var continuationCalls = 0
        var continuationValue: Map<String, Any?>? = mapOf("sentinel" to true)
        val block = ApiBlock(
            spec = mapOf(
                "as" to "save",
                "url" to "https://example.test/save",
                "method" to "POST",
                "auto" to "false",
            ),
            store = store,
            fetch = { _, _ -> error("blocking fetch must not run") },
            asyncFetch = ApiBlockAsyncFetch { _, _, completion ->
                transportCompletion = completion
                ApiBlockFetchCall { transportCancels += 1 }
            },
        )

        block.send(mapOf("id" to 7.0)) {
            continuationCalls += 1
            continuationValue = it
        }
        assertTrue(store.varsFlow.value.envelope("save")["loading"] as Boolean)

        block.cancel()
        assertEquals(1, transportCancels)
        assertEquals(1, continuationCalls)
        assertNull(continuationValue)
        assertFalse(store.varsFlow.value.envelope("save")["loading"] as Boolean)

        // A late and even duplicated callback from a broken transport is stale.
        val late = linkedMapOf<String, Any?>("ok" to true, "status" to 200.0, "data" to "late")
        transportCompletion?.invoke(late)
        transportCompletion?.invoke(late)
        block.dispose()
        assertEquals(1, continuationCalls)
    }

    @Test
    fun dependencyChangesDebounceToTheNewestMaterializedRequestAndCancelDropsIt() {
        val store = StackStore()
        store.set("query", "first")
        val calls = ArrayList<String>()
        var scheduled: (() -> Unit)? = null
        val block = ApiBlock(
            spec = mapOf(
                "as" to "search",
                "url" to "https://example.test/search?q={{query}}",
                "debounce" to "100",
            ),
            store = store,
            fetch = { url, _ ->
                calls += url
                mapOf("ok" to true, "status" to 200.0, "data" to url)
            },
            schedule = { _, work ->
                scheduled = work
                ApiBlockFetchCall { if (scheduled === work) scheduled = null }
            },
        )

        // Initial auto-fetch is immediate. Only reactive dependency changes debounce.
        assertEquals(listOf("https://example.test/search?q=first"), calls)
        store.set("query", "second")
        block.storeChanged()
        val superseded = scheduled
        store.set("query", "third")
        block.storeChanged()
        superseded?.invoke() // a broken scheduler firing a cancelled task is stale
        assertEquals(1, calls.size)
        scheduled?.invoke()
        assertEquals(
            listOf(
                "https://example.test/search?q=first",
                "https://example.test/search?q=third",
            ),
            calls,
        )

        store.set("query", "fourth")
        block.storeChanged()
        block.cancel()
        scheduled?.invoke()
        assertEquals(2, calls.size)
        block.dispose()
    }

    @Test
    fun effectiveCookiePartitionChangeRefetchesOnceWithoutRequestAttributeChanges() {
        val store = StackStore()
        var partition = "anonymous"
        var calls = 0
        ApiBlock.requestCachePartition = { partition }
        val block = ApiBlock(
            spec = mapOf("as" to "profile", "url" to "/me"),
            store = store,
            fetch = { _, _ ->
                calls += 1
                mapOf("ok" to true, "status" to 200.0, "data" to partition)
            },
        )
        assertEquals(1, calls)

        partition = "signed-in"
        block.storeChanged()
        assertEquals(2, calls)
        assertEquals("signed-in", store.getPath("profile.data"))

        // Same semantic cookie identity (for example an expiry renewal) is a no-op.
        block.storeChanged()
        assertEquals(2, calls)
        block.dispose()
    }

    @Test
    fun throwingAuthorEventHandlerCannotAbortSettlement() {
        val store = StackStore()
        val block = ApiBlock(
            spec = mapOf("as" to "request", "url" to "/ok"),
            store = store,
            fetch = { _, _ ->
                mapOf("ok" to true, "status" to 200.0, "data" to "settled")
            },
            onEvent = { _, _ -> throw IllegalStateException("author handler failed") },
        )

        assertEquals("settled", store.getPath("request.data"))
        assertFalse(store.getPath("request.loading") as Boolean)
        block.dispose()
    }

    @Test
    fun customStreamingTransportCannotExceedAggregateRetentionBound() {
        var transportCancels = 0
        var messages = 0
        var settled: Map<String, Any?>? = null
        val block = ApiBlock(
            spec = mapOf(
                "as" to "feed",
                "url" to "/events",
                "auto" to "false",
            ),
            store = StackStore(),
            fetch = { _, _ -> error("blocking transport must not run") },
            asyncFetch = ApiBlockAsyncFetch { _, _, completion ->
                completion(
                    mapOf(
                        "partial" to true,
                        // UTF-16 approximation exceeds the 16MiB retained aggregate cap.
                        "message" to "x".repeat(8 * 1024 * 1024 + 1),
                    ),
                )
                // A broken adapter may still try to settle after the core closed its gate.
                completion(mapOf("ok" to true, "status" to 200.0, "streamed" to true))
                ApiBlockFetchCall { transportCancels += 1 }
            },
            onEvent = { event, _ -> if (event == "message") messages += 1 },
        )

        block.refresh { settled = it }

        assertEquals(-2.0, settled?.get("status"))
        assertEquals("response_too_large", settled?.get("error"))
        assertEquals(0, messages)
        assertEquals(1, transportCancels)
        block.dispose()
    }

    @Test
    fun incrementalStreamPublishesImmutablePrefixesAndFinalizesWithoutReplay() {
        val store = StackStore()
        var transportCompletion: ((Map<String, Any?>) -> Unit)? = null
        val events = ArrayList<Pair<String, Any?>>()
        var settled: Map<String, Any?>? = null
        val block = ApiBlock(
            spec = mapOf(
                "as" to "feed",
                "url" to "/events",
                "auto" to "false",
            ),
            store = store,
            fetch = { _, _ -> error("blocking transport must not run") },
            asyncFetch = ApiBlockAsyncFetch { _, _, completion ->
                transportCompletion = completion
                ApiBlockFetchCall {}
            },
            onEvent = { name, payload -> events += name to payload["data"] },
        )

        block.refresh { settled = it }
        transportCompletion?.invoke(mapOf("partial" to true, "message" to "one"))
        @Suppress("UNCHECKED_CAST")
        val firstPrefix = store.getPath("feed.data") as List<Any?>
        transportCompletion?.invoke(mapOf("partial" to true, "message" to "two"))

        assertEquals(listOf("one"), firstPrefix, "a previously published prefix must not grow")
        assertEquals(listOf("one", "two"), store.getPath("feed.data"))
        assertEquals(
            listOf<Pair<String, Any?>>("message" to "one", "message" to "two"),
            events,
        )

        transportCompletion?.invoke(
            mapOf("ok" to true, "status" to 200.0, "data" to null, "streamed" to true),
        )
        assertEquals(listOf("one", "two"), store.getPath("feed.data"))
        assertEquals(
            listOf<Pair<String, Any?>>(
                "message" to "one",
                "message" to "two",
                "success" to listOf("one", "two"),
            ),
            events,
        )
        assertEquals(listOf("one", "two"), settled?.get("data"))
        block.dispose()
    }

    @Test
    fun terminalStreamHandlesTheFullEventBoundWithLinearPrefixPublication() {
        val store = StackStore()
        val stream = List(ApiBlock.maxStreamEvents) { it }
        var messages = 0
        val block = ApiBlock(
            spec = mapOf("as" to "feed", "url" to "/batch-events"),
            store = store,
            fetch = { _, _ ->
                mapOf(
                    "ok" to true,
                    "status" to 200.0,
                    "data" to null,
                    "stream" to stream,
                )
            },
            onEvent = { name, _ -> if (name == "message") messages += 1 },
        )

        val settled = store.getPath("feed.data") as List<*>
        assertEquals(ApiBlock.maxStreamEvents, messages)
        assertEquals(ApiBlock.maxStreamEvents, settled.size)
        assertEquals(0, settled.first())
        assertEquals(ApiBlock.maxStreamEvents - 1, settled.last())
        block.dispose()
    }

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.envelope(name: String): Map<String, Any?> =
        envelopeOrNull(name) ?: error("$name envelope is missing from varsFlow")

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.envelopeOrNull(name: String): Map<String, Any?>? =
        this[name] as? Map<String, Any?>
}
