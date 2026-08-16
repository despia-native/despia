package despia.engine.platform

import despia.engine.ApiBlock
import despia.engine.ContentStore
import despia.engine.Context
import despia.engine.DSXCookies
import despia.engine.FetchError
import despia.engine.StackStore
import despia.engine.getPath
import java.io.File
import java.net.HttpCookie
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class NetworkBackendTest {
    private lateinit var server: MockWebServer
    private lateinit var temp: File
    private val routes =
        ConcurrentHashMap<String, (RecordedRequest) -> MockResponse>()
    private val origin: String
        get() = server.url("/").toString().removeSuffix("/")

    @Before
    fun start() {
        temp = Files.createTempDirectory("dsx-network-test").toFile()
        routes.clear()
        server = MockWebServer().also {
            it.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    routes[request.requestUrl?.encodedPath]?.invoke(request)
                        ?: MockResponse().setResponseCode(404)
            }
            it.start()
        }
        NetworkBackend.installForTests(
            origin = { origin },
            cleartext = true,
            manifestCacheDirectory = File(temp, "cache"),
        )
    }

    @After
    fun stop() {
        server.shutdown()
        routes.clear()
        temp.deleteRecursively()
    }

    @Test
    fun installerMapsRelativeUrlQueryHeadersJsonBodyAndResponse() = runBlocking {
        var method = ""
        var query = ""
        var requestHeader = ""
        var contentType = ""
        var requestBody = ""
        route("/mapped") { request ->
            method = request.method.orEmpty()
            query = request.requestUrl?.encodedQuery.orEmpty()
            requestHeader = request.getHeader("X-Test").orEmpty()
            contentType = request.getHeader("Content-Type").orEmpty()
            requestBody = request.body.readUtf8()
            response(201, """{"accepted":true}""")
                .setHeader("Content-Type", "application/json")
                .setHeader("X-Reply", "yes")
        }

        val response = Context.fetchImpl!!.invoke(
            "/mapped",
            "POST",
            mapOf("X-Test" to "mapped"),
            mapOf("space" to "a b", "symbol" to "a&b"),
            mapOf("id" to 7, "enabled" to true),
            2.0,
        )

        assertEquals(201, response.status)
        assertTrue(response.ok)
        assertEquals(true, response.dictionary["accepted"])
        assertEquals("POST", method)
        assertTrue(query.contains("space=a%20b"))
        assertTrue(query.contains("symbol=a%26b"))
        assertEquals("mapped", requestHeader)
        assertTrue(contentType.startsWith("application/json"))
        assertEquals("""{"id":7,"enabled":true}""", requestBody)
        assertEquals("yes", response.headers["X-Reply"])
    }

    @Test
    fun requestConstructionRejectsHostileUrlQueryHeaderMethodAndCredentialsBeforeNetwork() = runBlocking {
        suspend fun failure(
            url: String = "$origin/never",
            method: String = "GET",
            headers: Map<String, String> = emptyMap(),
            query: Map<String, String> = emptyMap(),
        ): Throwable? = try {
            Context.fetchImpl!!.invoke(url, method, headers, query, null, 1.0)
            null
        } catch (error: Throwable) {
            error
        }

        assertTrue(
            failure(url = "$origin/${"x".repeat(NetworkBackend.MAX_REQUEST_URL_BYTES.toInt())}")
                is FetchError.InvalidURL,
        )
        assertTrue(
            failure(url = "http://user:pass@127.0.0.1:${server.port}/never")
                is FetchError.InvalidURL,
        )
        for (networkPath in listOf(
            "//evil.test/path",
            "\\\\evil.test\\path",
            "/\\evil.test/path",
            "\\/evil.test/path",
        )) {
            assertTrue(
                "network-path reference must fail before I/O: $networkPath",
                failure(url = networkPath) is FetchError.InvalidURL,
            )
        }
        assertTrue(
            failure(query = mapOf("key" to "v".repeat(NetworkBackend.MAX_REQUEST_URL_BYTES.toInt())))
                is FetchError.InvalidURL,
        )
        assertTrue(
            failure(query = mapOf("encoded" to " ".repeat(24 * 1_024)))
                is FetchError.InvalidURL,
        )
        assertTrue(
            failure(query = (0..NetworkBackend.MAX_REQUEST_QUERY_ITEMS).associate { "k$it" to "v" })
                is FetchError.InvalidURL,
        )
        assertTrue(
            failure(method = "X".repeat(NetworkBackend.MAX_REQUEST_METHOD_BYTES.toInt() + 1))
                is FetchError.Transport,
        )
        assertTrue(failure(method = "GET\nInjected") is FetchError.Transport)
        assertTrue(
            failure(headers = (0..NetworkBackend.MAX_REQUEST_HEADER_COUNT).associate { "X-$it" to "v" })
                is FetchError.Transport,
        )
        assertTrue(
            failure(headers = mapOf("X-Large" to "v".repeat(NetworkBackend.MAX_REQUEST_HEADER_BYTES.toInt())))
                is FetchError.Transport,
        )
        assertTrue(failure(headers = mapOf("Bad Header" to "x")) is FetchError.Transport)
        assertTrue(failure(headers = mapOf("X-Test" to "ok\r\nInjected: yes")) is FetchError.Transport)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun timeoutAndProductionCleartextPolicyFailClosed() = runBlocking {
        route("/slow") {
            response(200, "late")
                .setBodyDelay(250, TimeUnit.MILLISECONDS)
        }
        var timeoutError: Throwable? = null
        try {
            Context.fetchImpl!!.invoke(
                "$origin/slow", "GET", emptyMap(), emptyMap(), null, 0.03)
        } catch (error: Throwable) {
            timeoutError = error
        }
        assertTrue(timeoutError is FetchError.Transport)

        NetworkBackend.installForTests(origin = { origin }, cleartext = false)
        var cleartextError: Throwable? = null
        try {
            Context.fetchImpl!!.invoke(
                "$origin/slow", "GET", emptyMap(), emptyMap(), null, 1.0)
        } catch (error: Throwable) {
            cleartextError = error
        }
        assertTrue(cleartextError is FetchError.InvalidURL)
    }

    @Test
    fun cookiesRoundTripRespectDomainPathSecureAndExpiry() = runBlocking {
        route("/set") {
            response(200, "set")
                .addHeader("Set-Cookie", "sid=abc; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "privateOnly=one; Path=/private")
        }
        val seen = LinkedHashMap<String, String>()
        route("/public/check") { request ->
            seen["public"] = request.getHeader("Cookie").orEmpty()
            response(200, "ok")
        }
        route("/private/check") { request ->
            seen[request.getHeader("Host").orEmpty()] =
                request.getHeader("Cookie").orEmpty()
            response(200, "ok")
        }

        Context.fetchImpl!!.invoke("$origin/set", "GET", emptyMap(), emptyMap(), null, 2.0)
        Context.fetchImpl!!.invoke(
            "$origin/public/check", "GET", emptyMap(), emptyMap(), null, 2.0)
        Context.fetchImpl!!.invoke(
            "$origin/private/check", "GET", emptyMap(), emptyMap(), null, 2.0)

        val secure = HttpCookie("secureOnly", "yes").also {
            it.domain = "localhost"; it.path = "/"; it.secure = true
        }
        DSXCookies.shared.nativeStore(secure)
        val expired = HttpCookie("expired", "no").also {
            it.domain = "localhost"; it.path = "/"; it.maxAge = 0
        }
        DSXCookies.shared.nativeStore(expired)
        Context.fetchImpl!!.invoke(
            "http://127.0.0.1:${server.port}/private/check",
            "GET", emptyMap(), emptyMap(), null, 2.0)

        assertTrue(seen["public"].orEmpty().contains("sid=abc"))
        assertFalse(seen["public"].orEmpty().contains("privateOnly=one"))
        val local = seen.entries.first { it.key.startsWith("localhost:") }.value
        assertTrue(local.contains("sid=abc"))
        assertTrue(local.contains("privateOnly=one"))
        assertFalse(local.contains("secureOnly=yes"))
        assertFalse(local.contains("expired=no"))
        val ip = seen.entries.first { it.key.startsWith("127.0.0.1:") }.value
        assertFalse(ip.contains("sid=abc"))
        assertNull(DSXCookies.shared.jar["sid"])
        assertEquals("one", DSXCookies.shared.jar["privateOnly"])
    }

    @Test
    fun contentManifestUsesProtocolCacheAndBlobPublishesAtomicallyWithoutCache() = runBlocking {
        val manifestCalls = AtomicInteger(0)
        var conditional = false
        route("/manifest") { request ->
            manifestCalls.incrementAndGet()
            val revalidating = request.getHeader("If-None-Match") == "\"v1\""
            conditional = conditional || revalidating
            if (revalidating) {
                MockResponse()
                    .setResponseCode(304)
                    .setHeader("ETag", "\"v1\"")
                    .setHeader("Cache-Control", "no-cache")
            } else {
                response(200, """{"version":1}""")
                    .setHeader("ETag", "\"v1\"")
                    .setHeader("Cache-Control", "no-cache")
            }
        }
        val blob = ByteArray(512 * 1024) { (it % 251).toByte() }
        route("/blob") {
            MockResponse()
                .setResponseCode(200)
                .setChunkedBody(Buffer().write(blob), 4096)
        }
        route("/truncated") {
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(byteArrayOf(1, 2, 3)))
                .setHeader("Content-Length", "100")
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        }

        val fetch = ContentStore.shared.fetch!!
        assertEquals(200, fetch.data("$origin/manifest")?.status)
        assertEquals(200, fetch.data("$origin/manifest")?.status) // OkHttp combines cached 200 + network 304
        assertEquals(2, manifestCalls.get())
        assertTrue(conditional)

        val destination = File(temp, "blob.bin")
        assertEquals(200, fetch.download("$origin/blob", destination))
        assertArrayEquals(blob, destination.readBytes())
        destination.writeText("previous")
        assertNull(fetch.download("$origin/truncated", destination))
        assertEquals("previous", destination.readText())
    }

    @Test
    fun blobDownloadsEnforceAdvertisedAndActualLimitsAndDeleteStagingFiles() = runBlocking {
        NetworkBackend.installForTests(
            origin = { origin },
            cleartext = true,
            manifestCacheDirectory = File(temp, "bounded-cache"),
            maxBlobResponseBytes = 1024,
        )
        route("/advertised-too-large") {
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", "1025")
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        }
        route("/streamed-too-large") {
            MockResponse()
                .setResponseCode(200)
                .setChunkedBody(Buffer().write(ByteArray(1025) { 7 }), 97)
        }

        val destination = File(temp, "bounded-blob.bin").apply { writeText("previous") }
        val fetch = ContentStore.shared.fetch!!
        assertNull(fetch.download("$origin/advertised-too-large", destination))
        assertEquals("previous", destination.readText())
        assertNull(fetch.download("$origin/streamed-too-large", destination))
        assertEquals("previous", destination.readText())
        assertTrue(
            requireNotNull(destination.parentFile).listFiles().orEmpty().none {
                it.name.startsWith(".${destination.name}.") && it.name.endsWith(".part")
            },
        )
    }

    @Test
    fun oversizedInMemoryResponseIsRejectedBeforeAllocation() = runBlocking {
        route("/huge") {
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", 17L * 1024L * 1024L)
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        }
        var error: Throwable? = null
        try {
            Context.fetchImpl!!.invoke(
                "$origin/huge", "GET", emptyMap(), emptyMap(), null, 2.0)
        } catch (caught: Throwable) {
            error = caught
        }
        assertTrue(error is FetchError.Transport)
    }

    @Test
    fun controlFetchUsesFourMiBWhileGenericFetchKeepsSixteenMiBContract() = runBlocking {
        val payload = ByteArray(4 * 1024 * 1024 + 1) { 0x41 }
        route("/control-advertised") {
            MockResponse().setResponseCode(200).setBody(Buffer().write(payload))
        }

        var controlError: Throwable? = null
        try {
            Context.controlFetchImpl!!.invoke(
                "$origin/control-advertised", "GET", emptyMap(), emptyMap(), null, 2.0)
        } catch (caught: Throwable) {
            controlError = caught
        }
        assertTrue(controlError is FetchError.Transport)

        val generic = Context.fetchImpl!!.invoke(
            "$origin/control-advertised", "GET", emptyMap(), emptyMap(), null, 2.0)
        assertEquals(payload.size, generic.body.size)

        route("/control-chunked") {
            MockResponse().setResponseCode(200)
                .setChunkedBody(Buffer().write(payload), 8 * 1024)
        }
        controlError = null
        try {
            Context.controlFetchImpl!!.invoke(
                "$origin/control-chunked", "GET", emptyMap(), emptyMap(), null, 2.0)
        } catch (caught: Throwable) {
            controlError = caught
        }
        assertTrue(controlError is FetchError.Transport)
    }

    @Test
    fun bareManifestHostResolvesToHttpsAndProductionDisablesCrossSchemeRedirects() {
        NetworkBackend.installForTests(
            origin = { "api.example.com:8443/base/" },
            cleartext = false,
        )

        assertEquals(
            "https://api.example.com:8443/base/users",
            NetworkBackend.resolvedUrlForTests("users"),
        )
        assertFalse(NetworkBackend.followsCrossSchemeRedirectsForTests())
    }

    @Test
    fun malformedJsonAndOversizedBodiesAreTerminalAndNeverRetried() {
        val malformedCalls = AtomicInteger()
        route("/malformed") {
            malformedCalls.incrementAndGet()
            response(200, """{"broken":""")
                .setHeader("Content-Type", "application/json")
        }
        val store = StackStore()
        val malformed = ApiBlock(
            spec = mapOf(
                "as" to "bad",
                "url" to "$origin/malformed",
                "auto" to "false",
                "retry" to "3",
            ),
            store = store,
            fetch = { _, _ -> error("blocking transport used") },
            asyncFetch = NetworkBackend.apiFetch,
        )
        val malformedResult = awaitBlock { done -> malformed.refresh(done) }
        assertEquals(-2.0, malformedResult?.get("status"))
        assertEquals("invalid_response", malformedResult?.get("error"))
        assertEquals(1, malformedCalls.get())
        malformed.dispose()

        val oversizedCalls = AtomicInteger()
        route("/response-too-large") {
            oversizedCalls.incrementAndGet()
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", 17L * 1024L * 1024L)
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        }
        val oversized = ApiBlock(
            spec = mapOf(
                "as" to "oversized",
                "url" to "$origin/response-too-large",
                "auto" to "false",
                "retry" to "3",
            ),
            store = StackStore(),
            fetch = { _, _ -> error("blocking transport used") },
            asyncFetch = NetworkBackend.apiFetch,
        )
        val oversizedResult = awaitBlock { done -> oversized.refresh(done) }
        assertEquals(-2.0, oversizedResult?.get("status"))
        assertEquals("response_too_large", oversizedResult?.get("error"))
        assertEquals(1, oversizedCalls.get())
        oversized.dispose()

        val sseOversizedCalls = AtomicInteger()
        route("/sse-event-too-large") {
            sseOversizedCalls.incrementAndGet()
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setChunkedBody(
                    "data: " + "x".repeat(1024 * 1024 + 1) + "\n\n",
                    8192,
                )
        }
        val oversizedEvent = ApiBlock(
            spec = mapOf(
                "as" to "oversizedEvent",
                "url" to "$origin/sse-event-too-large",
                "auto" to "false",
                "retry" to "3",
            ),
            store = StackStore(),
            fetch = { _, _ -> error("blocking transport used") },
            asyncFetch = NetworkBackend.apiFetch,
        )
        val oversizedEventResult = awaitBlock { done -> oversizedEvent.refresh(done) }
        assertEquals(-2.0, oversizedEventResult?.get("status"))
        assertEquals("response_too_large", oversizedEventResult?.get("error"))
        assertEquals(1, sseOversizedCalls.get())
        oversizedEvent.dispose()

        val requestCalls = AtomicInteger()
        route("/request-too-large") {
            requestCalls.incrementAndGet()
            response(200, "unexpected")
        }
        val large = ApiBlock(
            spec = mapOf(
                "as" to "large",
                "url" to "$origin/request-too-large",
                "method" to "POST",
                "auto" to "false",
                "retry" to "3",
            ),
            store = StackStore(),
            fetch = { _, _ -> error("blocking transport used") },
            asyncFetch = NetworkBackend.apiFetch,
        )
        val largeResult = awaitBlock { done ->
            large.send(mapOf("payload" to "x".repeat(4 * 1024 * 1024 + 1)), done)
        }
        assertEquals(-2.0, largeResult?.get("status"))
        assertEquals("request_too_large", largeResult?.get("error"))
        assertEquals(0, requestCalls.get())
        large.dispose()
    }

    @Test
    fun expectIsCaseNormalizedAndBlobUsesTheCrossPlatformEnvelope() {
        route("/typed") {
            response(200, """{"value":7}""")
                .setHeader("Content-Type", "application/json; charset=utf-8")
        }

        val text = awaitApi(
            "$origin/typed",
            mapOf("method" to "GET", "expect" to "TEXT"),
        )
        assertEquals("""{"value":7}""", text["data"])

        val blob = awaitApi(
            "$origin/typed",
            mapOf("method" to "GET", "expect" to "blob"),
        )
        @Suppress("UNCHECKED_CAST")
        val data = blob["data"] as Map<String, Any?>
        assertEquals("application/json", data["type"])
        assertEquals(11.0, data["size"])
        assertEquals("eyJ2YWx1ZSI6N30=", data["__blob"])
    }

    @Test
    fun cancellationSettlesAbortedExactlyOnce() {
        route("/cancel") {
            response(200, "late")
                .setBodyDelay(250, TimeUnit.MILLISECONDS)
        }
        val latch = CountDownLatch(1)
        val deliveries = AtomicInteger()
        val result = AtomicReference<Map<String, Any?>>()
        val call = NetworkBackend.apiFetch.request(
            "$origin/cancel",
            mapOf("method" to "GET", "expect" to "text"),
        ) {
            deliveries.incrementAndGet()
            result.set(it)
            latch.countDown()
        }
        call.cancel()

        assertTrue(latch.await(2, TimeUnit.SECONDS))
        assertEquals(1, deliveries.get())
        assertEquals(true, result.get()["aborted"])
        assertEquals(-1.0, result.get()["status"])
    }

    @Test
    fun webCookieIdentityIsReconciledBeforeApiCacheLookup() {
        class MutableWebBridge : WebCookieBridge {
            @Volatile var header = "sid=user-a"
            override fun cookies(url: String): String = header
        }
        val bridge = MutableWebBridge()
        NetworkBackend.installForTests(
            origin = { origin },
            cleartext = true,
            manifestCacheDirectory = File(temp, "cache-web"),
            web = bridge,
        )
        val calls = AtomicInteger()
        val seen = ArrayList<String>()
        route("/profile") { request ->
            calls.incrementAndGet()
            seen += request.getHeader("Cookie").orEmpty()
            response(200, calls.get().toString())
        }
        val store = StackStore()
        fun mount(): ApiBlock {
            val latch = CountDownLatch(1)
            return ApiBlock(
                spec = mapOf(
                    "as" to "profile",
                    "url" to "$origin/profile",
                    "expect" to "text",
                    "cache" to "max-age(60)",
                ),
                store = store,
                fetch = { _, _ -> error("blocking transport used") },
                asyncFetch = NetworkBackend.apiFetch,
                onEvent = { event, _ -> if (event == "success") latch.countDown() },
            ).also {
                assertTrue(latch.await(2, TimeUnit.SECONDS))
            }
        }

        mount().dispose()
        bridge.header = "sid=user-b"
        mount().dispose()

        assertEquals(2, calls.get())
        assertTrue(seen[0].contains("sid=user-a"))
        assertTrue(seen[1].contains("sid=user-b"))
    }

    @Test
    fun corruptManifestCachePathFallsBackWithoutCrashingInstall() = runBlocking {
        val notDirectory = File(temp, "cache-file").also { it.writeText("not a directory") }
        NetworkBackend.installForTests(
            origin = { origin },
            cleartext = true,
            manifestCacheDirectory = notDirectory,
        )
        route("/manifest-fallback") {
            response(200, "ok")
        }

        assertEquals(
            200,
            ContentStore.shared.fetch?.data("$origin/manifest-fallback")?.status,
        )
    }

    @Test
    fun concurrentWebCookieReconciliationReturnsEachUrlsOwnSnapshot() {
        val rendezvous = CyclicBarrier(2)
        val bridge = WebCookieBridge { url ->
            rendezvous.await(2, TimeUnit.SECONDS)
            if (url.contains("/admin")) "sid=admin" else "sid=public"
        }
        val jar = DsxCookieJar(bridge)
        val workers = Executors.newFixedThreadPool(2)
        try {
            val admin = workers.submit<List<Cookie>> {
                jar.loadForRequest("https://example.test/admin".toHttpUrl())
            }
            val public = workers.submit<List<Cookie>> {
                jar.loadForRequest("https://example.test/public".toHttpUrl())
            }

            assertEquals("admin", admin.get(2, TimeUnit.SECONDS).single().value)
            assertEquals("public", public.get(2, TimeUnit.SECONDS).single().value)
        } finally {
            workers.shutdownNow()
        }
    }

    @Test
    fun cookieExpiryRenewalDoesNotChangeSemanticPartitionRevision() {
        val jar = DsxCookieJar()
        val url = "https://example.test/".toHttpUrl()
        fun cookie(expiresAt: Long) = Cookie.Builder()
            .name("sid")
            .value("same")
            .hostOnlyDomain("example.test")
            .path("/")
            .expiresAt(expiresAt)
            .build()

        jar.saveFromResponse(url, listOf(cookie(System.currentTimeMillis() + 60_000)))
        val before = jar.revision()
        jar.saveFromResponse(url, listOf(cookie(System.currentTimeMillis() + 120_000)))

        assertEquals(before, jar.revision())
    }

    @Test
    fun sseMessagesArriveBeforeEofAndTerminalDoesNotReplayThem() {
        val firstFrame = "data: {\"n\":1}\r\n\r\n"
        val secondFrame = "data: hello\rdata: world\r\r"
        route("/events") {
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setChunkedBody(firstFrame + secondFrame, firstFrame.toByteArray().size)
                // MockWebServer writes the first period immediately, then pauses before
                // the second frame. This proves ApiBlock publishes before response EOF.
                .throttleBody(
                    firstFrame.toByteArray().size.toLong(),
                    750,
                    TimeUnit.MILLISECONDS,
                )
        }

        val firstMessage = CountDownLatch(1)
        val terminal = CountDownLatch(1)
        val events = ArrayList<String>()
        val terminalResult = AtomicReference<Map<String, Any?>?>()
        val store = StackStore()
        val block = ApiBlock(
            spec = mapOf(
                "as" to "feed",
                "url" to "$origin/events",
                "auto" to "false",
                "cache" to "max-age(60)",
            ),
            store = store,
            fetch = { _, _ -> error("blocking transport used") },
            asyncFetch = NetworkBackend.apiFetch,
            onEvent = { event, _ ->
                events += event
                if (event == "message") {
                    firstMessage.countDown()
                    if (events.count { it == "message" } == 1) {
                        throw IllegalStateException("author handler failure")
                    }
                }
            },
        )
        try {
            block.refresh {
                terminalResult.set(it)
                terminal.countDown()
            }

            assertTrue(firstMessage.await(2, TimeUnit.SECONDS))
            assertEquals(1L, terminal.count)
            assertEquals(listOf(mapOf("n" to 1)), store.getPath("feed.data"))
            assertEquals(false, store.getPath("feed.refreshing"))

            assertTrue(terminal.await(3, TimeUnit.SECONDS))
            assertEquals(listOf("message", "message", "success"), events)
            assertEquals(
                listOf(mapOf("n" to 1), "hello\nworld"),
                terminalResult.get()?.get("data"),
            )
            assertEquals(200.0, terminalResult.get()?.get("status"))
        } finally {
            block.dispose()
        }
    }

    @Test
    fun cancellingAfterAnSseMessageSettlesAwaitOnceAndDropsLateTerminal() {
        val firstFrame = "data: first\n\n"
        route("/events-cancel") {
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setChunkedBody(firstFrame + "data: late\n\n", firstFrame.toByteArray().size)
                .throttleBody(
                    firstFrame.toByteArray().size.toLong(),
                    750,
                    TimeUnit.MILLISECONDS,
                )
        }
        val message = CountDownLatch(1)
        val duplicateCompletion = CountDownLatch(1)
        val completions = AtomicInteger()
        val completionValue = AtomicReference<Map<String, Any?>?>(
            mapOf("sentinel" to true),
        )
        val block = ApiBlock(
            spec = mapOf(
                "as" to "feed",
                "url" to "$origin/events-cancel",
                "auto" to "false",
            ),
            store = StackStore(),
            fetch = { _, _ -> error("blocking transport used") },
            asyncFetch = NetworkBackend.apiFetch,
            onEvent = { event, _ -> if (event == "message") message.countDown() },
        )
        try {
            block.refresh {
                if (completions.incrementAndGet() > 1) duplicateCompletion.countDown()
                completionValue.set(it)
            }
            assertTrue(message.await(2, TimeUnit.SECONDS))
            block.cancel()
            assertEquals(1, completions.get())
            assertNull(completionValue.get())

            assertFalse(duplicateCompletion.await(2, TimeUnit.SECONDS))
            assertEquals(1, completions.get())
        } finally {
            block.dispose()
        }
    }

    private fun awaitApi(
        url: String,
        request: Map<String, Any?>,
    ): Map<String, Any?> {
        val latch = CountDownLatch(1)
        val result = AtomicReference<Map<String, Any?>>()
        NetworkBackend.apiFetch.request(url, request) {
            result.set(it)
            latch.countDown()
        }
        assertTrue(latch.await(2, TimeUnit.SECONDS))
        return result.get()
    }

    private fun awaitBlock(
        start: (((Map<String, Any?>?) -> Unit) -> Unit),
    ): Map<String, Any?>? {
        val latch = CountDownLatch(1)
        val result = AtomicReference<Map<String, Any?>?>()
        start {
            result.set(it)
            latch.countDown()
        }
        assertTrue(latch.await(3, TimeUnit.SECONDS))
        return result.get()
    }

    private fun route(
        path: String,
        handler: (RecordedRequest) -> MockResponse,
    ) {
        routes[path] = handler
    }

    private fun response(status: Int, text: String): MockResponse =
        MockResponse()
            .setResponseCode(status)
            .setBody(text)
}
