package despia.engine.desktop

import com.sun.net.httpserver.HttpServer
import despia.engine.ContentStore
import despia.engine.Context
import despia.engine.DSXContent
import despia.engine.FetchError
import java.io.InputStream
import java.io.OutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.http.HttpTimeoutException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class DesktopNetworkTest {
    @TempDir
    lateinit var temporary: Path

    private var server: HttpServer? = null
    private var secondaryServer: HttpServer? = null
    private val serverExecutors = mutableListOf<ExecutorService>()
    private val originalContentLimit = DSXContent.contentMaxBlobMB

    @AfterEach
    fun stopServer() {
        server?.stop(0)
        secondaryServer?.stop(0)
        serverExecutors.forEach { it.shutdownNow() }
        DSXContent.contentMaxBlobMB = originalContentLimit
    }

    private fun concurrentHandlers(): ExecutorService = Executors.newCachedThreadPool { task ->
        Thread(task, "dsx-desktop-network-test-server").apply { isDaemon = true }
    }.also(serverExecutors::add)

    @Test
    fun loopbackDevelopmentApiUsesTheNativeJdkTransport() = runBlocking {
        DesktopHost.boot("Linux")
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/health") { exchange ->
            val body = "${exchange.requestMethod}:${exchange.requestURI.rawQuery}".toByteArray()
            exchange.responseHeaders.add("Content-Type", "text/plain")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()
        val response = Context.fetchImpl!!.invoke(
            "http://127.0.0.1:${local.address.port}/health",
            "GET",
            emptyMap(),
            mapOf("hello world" to "a&b"),
            null,
            5.0,
        )
        assertEquals(200, response.status)
        assertEquals("GET:hello%20world=a%26b", response.text())
        assertTrue(response.headers.keys.any { it.equals("content-type", ignoreCase = true) })
    }

    @Test
    fun cleartextRemoteAndCredentialBearingUrlsFailBeforeTheSocket(): Unit = runBlocking {
        DesktopHost.boot("Linux")
        assertFailsWith<FetchError.InvalidURL> {
            Context.fetchImpl!!.invoke("http://example.com/", "GET", emptyMap(), emptyMap(), null, 1.0)
        }
        assertFailsWith<FetchError.InvalidURL> {
            Context.fetchImpl!!.invoke("https://user:secret@example.com/", "GET", emptyMap(), emptyMap(), null, 1.0)
        }
    }

    @Test
    fun everyRedirectTargetIsRevalidatedBeforeAnotherSocketIsOpened(): Unit = runBlocking {
        DesktopHost.boot("Linux")
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/escape") { exchange ->
            exchange.responseHeaders.add("Location", "http://192.0.2.1/forbidden")
            exchange.sendResponseHeaders(302, -1)
            exchange.close()
        }
        local.start()

        assertFailsWith<FetchError.InvalidURL> {
            Context.fetchImpl!!.invoke(
                "http://127.0.0.1:${local.address.port}/escape",
                "GET",
                emptyMap(),
                emptyMap(),
                null,
                1.0,
            )
        }
    }

    @Test
    fun allowedRelativeRedirectStillUsesTheNativeTransport() = runBlocking {
        DesktopHost.boot("Linux")
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/redirect") { exchange ->
            exchange.responseHeaders.add("Location", "/final")
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        local.createContext("/final") { exchange ->
            val body = "redirect-ok".toByteArray()
            exchange.responseHeaders.add("Content-Type", "text/plain")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()

        val response = Context.fetchImpl!!.invoke(
            "http://127.0.0.1:${local.address.port}/redirect",
            "GET",
            emptyMap(),
            emptyMap(),
            null,
            5.0,
        )
        assertEquals(200, response.status)
        assertEquals("redirect-ok", response.text())
    }

    @Test
    fun crossOriginRedirectForwardsOnlyTheSafeHeaderAllowlistWhileSameOriginRetainsAuthoredHeaders() = runBlocking {
        DesktopHost.boot("Linux")
        val source = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        val target = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { secondaryServer = it }
        val crossOriginHeaders = AtomicReference<com.sun.net.httpserver.Headers>()
        val sameOriginHeaders = AtomicReference<com.sun.net.httpserver.Headers>()

        target.createContext("/cross-target") { exchange ->
            crossOriginHeaders.set(com.sun.net.httpserver.Headers().also { it.putAll(exchange.requestHeaders) })
            val body = "cross-ok".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        source.createContext("/cross") { exchange ->
            exchange.responseHeaders.add(
                "Location",
                "http://127.0.0.1:${target.address.port}/cross-target",
            )
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        source.createContext("/same") { exchange ->
            exchange.responseHeaders.add("Location", "/same-target")
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        source.createContext("/same-target") { exchange ->
            sameOriginHeaders.set(com.sun.net.httpserver.Headers().also { it.putAll(exchange.requestHeaders) })
            val body = "same-ok".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        target.start()
        source.start()
        val headers = linkedMapOf(
            "Accept" to "application/dsx+json",
            "Accept-Language" to "fr-CA",
            "Content-Language" to "en",
            "Content-Type" to "application/json",
            "Authorization" to "Bearer caller-secret",
            "X-Api-Key" to "caller-api-secret",
            "X-Request-ID" to "private-correlation-value",
        )

        val cross = Context.fetchImpl!!.invoke(
            "http://127.0.0.1:${source.address.port}/cross",
            "GET",
            headers,
            emptyMap(),
            null,
            5.0,
        )
        val same = Context.fetchImpl!!.invoke(
            "http://127.0.0.1:${source.address.port}/same",
            "GET",
            headers,
            emptyMap(),
            null,
            5.0,
        )

        assertEquals("cross-ok", cross.text())
        assertEquals("application/dsx+json", crossOriginHeaders.get().getFirst("Accept"))
        assertEquals("fr-CA", crossOriginHeaders.get().getFirst("Accept-Language"))
        assertEquals("en", crossOriginHeaders.get().getFirst("Content-Language"))
        assertEquals("application/json", crossOriginHeaders.get().getFirst("Content-Type"))
        assertEquals(null, crossOriginHeaders.get().getFirst("Authorization"))
        assertEquals(null, crossOriginHeaders.get().getFirst("X-Api-Key"))
        assertEquals(null, crossOriginHeaders.get().getFirst("X-Request-ID"))

        assertEquals("same-ok", same.text())
        assertEquals("Bearer caller-secret", sameOriginHeaders.get().getFirst("Authorization"))
        assertEquals("caller-api-secret", sameOriginHeaders.get().getFirst("X-Api-Key"))
        assertEquals("private-correlation-value", sameOriginHeaders.get().getFirst("X-Request-ID"))
    }

    @Test
    fun crossOriginRedirectCannotForwardARequestBody() = runBlocking {
        DesktopHost.boot("Linux")
        val source = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        val target = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { secondaryServer = it }
        val targetRequests = AtomicInteger()
        target.createContext("/collect") { exchange ->
            targetRequests.incrementAndGet()
            exchange.sendResponseHeaders(204, -1)
            exchange.close()
        }
        source.createContext("/redirect") { exchange ->
            exchange.responseHeaders.add("Location", "http://127.0.0.1:${target.address.port}/collect")
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        target.start()
        source.start()

        assertFailsWith<FetchError.Transport> {
            Context.fetchImpl!!.invoke(
                "http://127.0.0.1:${source.address.port}/redirect",
                "POST",
                mapOf("Content-Type" to "application/json"),
                emptyMap(),
                mapOf("secret" to "never-forward"),
                5.0,
            )
        }
        assertEquals(0, targetRequests.get())
    }

    @Test
    fun responseBodyReadUsesTheOriginalOverallDeadlineAcrossRedirects() = runBlocking {
        DesktopHost.boot("Linux")
        val releaseBody = CountDownLatch(1)
        val bodyStarted = CountDownLatch(1)
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.executor = concurrentHandlers()
        local.createContext("/delayed-redirect") { exchange ->
            Thread.sleep(300)
            exchange.responseHeaders.add("Location", "/stalled-body")
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        local.createContext("/stalled-body") { exchange ->
            try {
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write(0x41)
                exchange.responseBody.flush()
                bodyStarted.countDown()
                releaseBody.await(5, TimeUnit.SECONDS)
            } finally {
                exchange.close()
            }
        }
        local.start()
        val startedAt = System.nanoTime()

        try {
            val failure = assertFailsWith<FetchError.Transport> {
                withTimeout(2_000) {
                    Context.fetchImpl!!.invoke(
                        "http://127.0.0.1:${local.address.port}/delayed-redirect",
                        "GET",
                        emptyMap(),
                        emptyMap(),
                        null,
                        0.55,
                    )
                }
            }
            val elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
            assertTrue(bodyStarted.await(1, TimeUnit.SECONDS))
            assertTrue(failure.cause is HttpTimeoutException, "expected hard deadline, got ${failure.cause}")
            assertTrue(elapsedMillis in 350..800, "overall deadline drifted: ${elapsedMillis}ms")
        } finally {
            releaseBody.countDown()
        }
    }

    @Test
    fun fourStalledBodiesCannotExhaustTheSharedHttpExecutor() = runBlocking {
        DesktopHost.boot("Linux")
        val releaseBodies = CountDownLatch(1)
        val bodiesStarted = CountDownLatch(4)
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.executor = concurrentHandlers()
        local.createContext("/stall") { exchange ->
            try {
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write(0x41)
                exchange.responseBody.flush()
                bodiesStarted.countDown()
                releaseBodies.await(10, TimeUnit.SECONDS)
            } finally {
                exchange.close()
            }
        }
        local.createContext("/quick") { exchange ->
            val body = "executor-free".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()
        val calls = (0 until 4).map { index ->
            DesktopNetwork.apiFetch.request(
                "http://127.0.0.1:${local.address.port}/stall?id=$index",
                mapOf("method" to "GET", "expect" to "text", "timeout" to 5.0),
            ) {}
        }

        try {
            assertTrue(bodiesStarted.await(5, TimeUnit.SECONDS))
            // Let all four response callbacks enter their blocking reads before the
            // probe. This is deterministic against the old four-thread shared pool.
            Thread.sleep(150)
            val probe = withTimeout(2_000) {
                Context.fetchImpl!!.invoke(
                    "http://127.0.0.1:${local.address.port}/quick",
                    "GET",
                    emptyMap(),
                    emptyMap(),
                    null,
                    1.5,
                )
            }
            assertEquals(200, probe.status)
            assertEquals("executor-free", probe.text())
        } finally {
            calls.forEach { it.cancel() }
            releaseBodies.countDown()
        }
    }

    @Test
    fun authoredMediaTransportNeverAttachesTheApiCookieJar(): Unit = runBlocking {
        DesktopHost.boot("Linux")
        val seenCookie = AtomicReference<String?>()
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/session") { exchange ->
            exchange.responseHeaders.add("Set-Cookie", "dsx_session=private; Path=/; HttpOnly")
            exchange.sendResponseHeaders(204, -1)
            exchange.close()
        }
        local.createContext("/media") { exchange ->
            seenCookie.set(exchange.requestHeaders.getFirst("Cookie"))
            val body = "media".toByteArray()
            exchange.responseHeaders.add("Content-Type", "image/png")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()
        val base = "http://127.0.0.1:${local.address.port}"

        Context.fetchImpl!!.invoke("$base/session", "GET", emptyMap(), emptyMap(), null, 5.0)
        val response = DesktopNetwork.fetchAnonymousMedia("$base/media", 1_024)

        assertEquals(200, response.status)
        assertEquals("image/png", response.contentType)
        assertEquals(null, seenCookie.get())
    }

    @Test
    fun httpOnlyCookieHeadersAreConsumedNativelyButNeverExposedToDsx() = runBlocking {
        DesktopHost.boot("Linux")
        val seenCookie = AtomicReference<String?>()
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/session") { exchange ->
            exchange.responseHeaders.add("Set-Cookie", "dsx_http_only=private; Path=/; HttpOnly")
            exchange.responseHeaders.add("Set-Cookie2", "legacy_private=value; Path=/; HttpOnly")
            exchange.responseHeaders.add("X-Visible", "yes")
            exchange.sendResponseHeaders(204, -1)
            exchange.close()
        }
        local.createContext("/cookie-check") { exchange ->
            seenCookie.set(exchange.requestHeaders.getFirst("Cookie"))
            exchange.sendResponseHeaders(204, -1)
            exchange.close()
        }
        local.start()
        val base = "http://127.0.0.1:${local.address.port}"

        val response = Context.fetchImpl!!.invoke("$base/session", "GET", emptyMap(), emptyMap(), null, 5.0)
        assertEquals("yes", response.headers.entries.first { it.key.equals("x-visible", true) }.value)
        assertTrue(response.headers.keys.none { it.equals("set-cookie", true) || it.equals("set-cookie2", true) })
        Context.fetchImpl!!.invoke("$base/cookie-check", "GET", emptyMap(), emptyMap(), null, 5.0)
        assertTrue(seenCookie.get().orEmpty().contains("dsx_http_only=private"))
    }

    @Test
    fun contentDownloadsStreamAtomicallyAndHonorTheConfiguredBlobLimit() = runBlocking {
        DesktopHost.boot("Linux")
        DSXContent.contentMaxBlobMB = { 1 }
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        val body = ByteArray(256 * 1024) { index -> (index % 251).toByte() }
        local.createContext("/blob") { exchange ->
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.createContext("/oversize") { exchange ->
            exchange.sendResponseHeaders(200, 2L * 1024L * 1024L)
            exchange.close()
        }
        local.start()
        val fetch = requireNotNull(ContentStore.shared.fetch)
        val destination = temporary.resolve("content.blob")

        assertEquals(200, fetch.download("http://127.0.0.1:${local.address.port}/blob", destination.toFile()))
        assertTrue(Files.readAllBytes(destination).contentEquals(body))
        val rejected = temporary.resolve("oversize.blob")
        assertEquals(null, fetch.download("http://127.0.0.1:${local.address.port}/oversize", rejected.toFile()))
        assertTrue(Files.notExists(rejected))
        assertTrue(Files.list(temporary).use { paths -> paths.noneMatch { it.fileName.toString().startsWith(".dsx-download-") } })
    }

    @Test
    fun streamingBodyAndSseDecodingHaveHardMemoryShapeBounds() {
        val byteCount = 70L * 1024L * 1024L
        val generated = object : InputStream() {
            var remaining = byteCount
            override fun read(): Int = if (remaining-- > 0) 0 else -1
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                if (remaining <= 0) return -1
                val count = minOf(length.toLong(), remaining).toInt()
                remaining -= count
                return count
            }
        }
        assertEquals(
            byteCount,
            DesktopNetwork.streamBounded(
                generated,
                OutputStream.nullOutputStream(),
                80L * 1024L * 1024L,
                Long.MAX_VALUE,
            ) { false },
        )
        val maximum = buildString { repeat(10_000) { append("data: null\n\n") } }
        assertEquals(10_000, DesktopNetwork.decodeServerSentEvents(maximum).size)
        assertFailsWith<IOException> {
            DesktopNetwork.decodeServerSentEvents(maximum + "data: null\n\n")
        }
        assertFailsWith<IOException> {
            DesktopNetwork.decodeServerSentEvents("data: ${"x".repeat(65_537)}\n\n")
        }
        val maximumData = "x".repeat(60 * 1024)
        assertFailsWith<IOException> {
            DesktopNetwork.decodeServerSentEvents(buildString {
                repeat(18) { append("data: ").append(maximumData).append("\n\n") }
            })
        }
        assertEquals(
            listOf(mapOf("ready" to true), "hello\nworld", ""),
            DesktopNetwork.decodeServerSentEvents(
                "\uFEFFdata: {\"ready\":true}\r\n\r\n" +
                    ": heartbeat\revent: ignored\rdata: hello\rdata:world\r\r" +
                    "data\n\n",
            ),
        )
        DesktopNetwork.validateJsonComplexity("{\"literal\":\"[{},:]\",\"ok\":true}")
        assertFailsWith<IllegalArgumentException> {
            DesktopNetwork.validateJsonComplexity(buildString {
                append('[')
                repeat(50_001) { index -> if (index > 0) append(','); append('0') }
                append(']')
            })
        }
    }

    @Test
    fun serverSentEventsArriveBeforeEofAndHeartbeatTrafficExtendsOnlyTheIdleDeadline() {
        DesktopHost.boot("Linux")
        val firstFrameWritten = CountDownLatch(1)
        val releaseRemainder = CountDownLatch(1)
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.executor = concurrentHandlers()
        local.createContext("/events") { exchange ->
            try {
                exchange.responseHeaders.add("Content-Type", "text/event-stream; charset=utf-8")
                exchange.responseHeaders.add("Cache-Control", "no-cache")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write("\uFEFFdata: {\"step\":1}\r\n\r\n".toByteArray())
                exchange.responseBody.flush()
                firstFrameWritten.countDown()
                releaseRemainder.await(5, TimeUnit.SECONDS)
                // The total stream lifetime is longer than the authored timeout, but
                // every heartbeat is comfortably inside its inactivity window.
                repeat(7) {
                    Thread.sleep(100)
                    exchange.responseBody.write(": heartbeat\n\n".toByteArray())
                    exchange.responseBody.flush()
                }
                exchange.responseBody.write("data: hello\rdata: world\r\r".toByteArray())
                exchange.responseBody.flush()
            } finally {
                exchange.close()
            }
        }
        local.start()

        val firstMessage = CountDownLatch(1)
        val terminal = CountDownLatch(1)
        val messages = CopyOnWriteArrayList<Any?>()
        val terminalEnvelope = AtomicReference<Map<String, Any?>>()
        val call = DesktopNetwork.apiFetch.request(
            "http://127.0.0.1:${local.address.port}/events",
            mapOf("method" to "GET", "expect" to "json", "timeout" to 0.5),
        ) { envelope ->
            if (envelope["partial"] == true) {
                messages += envelope["message"]
                firstMessage.countDown()
            } else {
                terminalEnvelope.set(envelope)
                terminal.countDown()
            }
        }

        try {
            assertTrue(firstFrameWritten.await(5, TimeUnit.SECONDS))
            assertTrue(firstMessage.await(2, TimeUnit.SECONDS), "first SSE event was buffered until EOF")
            assertEquals(listOf(mapOf("step" to 1)), messages.toList())
            assertEquals(1L, terminal.count, "stream completed before the server closed it")

            releaseRemainder.countDown()
            assertTrue(terminal.await(5, TimeUnit.SECONDS))
            assertEquals(listOf(mapOf("step" to 1), "hello\nworld"), messages.toList())
            assertEquals(true, terminalEnvelope.get()["ok"])
            assertEquals(true, terminalEnvelope.get()["streamed"])
            assertEquals(null, terminalEnvelope.get()["data"])
            assertEquals(null, terminalEnvelope.get()["stream"])
        } finally {
            releaseRemainder.countDown()
            call.cancel()
        }
    }

    @Test
    fun silentServerSentEventStreamIsClosedByTheAuthoredIdleTimeout() {
        DesktopHost.boot("Linux")
        val streamStarted = CountDownLatch(1)
        val releaseServer = CountDownLatch(1)
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.executor = concurrentHandlers()
        local.createContext("/silent-events") { exchange ->
            try {
                exchange.responseHeaders.add("Content-Type", "text/event-stream")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write(": connected\n\n".toByteArray())
                exchange.responseBody.flush()
                streamStarted.countDown()
                releaseServer.await(5, TimeUnit.SECONDS)
            } finally {
                exchange.close()
            }
        }
        local.start()

        val completion = CountDownLatch(1)
        val received = AtomicReference<Map<String, Any?>>()
        val call = DesktopNetwork.apiFetch.request(
            "http://127.0.0.1:${local.address.port}/silent-events",
            mapOf("method" to "GET", "timeout" to 0.35),
        ) { envelope ->
            received.set(envelope)
            completion.countDown()
        }
        try {
            assertTrue(streamStarted.await(5, TimeUnit.SECONDS))
            assertTrue(completion.await(3, TimeUnit.SECONDS), "silent SSE stream ignored its idle timeout")
            assertEquals(false, received.get()["ok"])
            assertEquals(0.0, received.get()["status"])
            assertEquals("network", received.get()["error"])
        } finally {
            call.cancel()
            releaseServer.countDown()
        }
    }

    @Test
    fun declarativeApiTransportReturnsThePortableEnvelope() {
        DesktopHost.boot("Linux")
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/api") { exchange ->
            val body = "{\"ready\":true,\"count\":2}".toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(201, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()
        val completion = CountDownLatch(1)
        val received = AtomicReference<Map<String, Any?>>()
        DesktopNetwork.apiFetch.request(
            "http://127.0.0.1:${local.address.port}/api",
            mapOf("method" to "GET", "expect" to "json"),
        ) {
            received.set(it)
            completion.countDown()
        }
        assertTrue(completion.await(5, TimeUnit.SECONDS))
        val envelope = received.get()
        assertEquals(true, envelope["ok"])
        assertEquals(201.0, envelope["status"])
        assertEquals(mapOf("ready" to true, "count" to 2), envelope["data"])
    }

    @Test
    fun jsonExpectationRejectsAValidJsonBodyWithANonJsonContentType() {
        DesktopHost.boot("Linux")
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/mime-confusion") { exchange ->
            val body = "{\"trusted\":true}".toByteArray()
            exchange.responseHeaders.add("Content-Type", "text/plain")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()
        val completion = CountDownLatch(1)
        val received = AtomicReference<Map<String, Any?>>()
        DesktopNetwork.apiFetch.request(
            "http://127.0.0.1:${local.address.port}/mime-confusion",
            mapOf("method" to "GET", "expect" to "json"),
        ) {
            received.set(it)
            completion.countDown()
        }

        assertTrue(completion.await(5, TimeUnit.SECONDS))
        val envelope = received.get()
        assertEquals(false, envelope["ok"])
        assertEquals(-2.0, envelope["status"])
        assertEquals("invalid_response", envelope["error"])
        assertEquals(null, envelope["data"])
    }

    @Test
    fun cancellationClosesTheActiveResponseStreamAndSettlesAbortedOnce() {
        DesktopHost.boot("Linux")
        val responseStarted = CountDownLatch(1)
        val clientDisconnected = CountDownLatch(1)
        val stopWriting = CountDownLatch(1)
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }
        local.createContext("/unbounded") { exchange ->
            try {
                exchange.responseHeaders.add("Content-Type", "text/plain")
                exchange.sendResponseHeaders(200, 0)
                val chunk = ByteArray(32 * 1024) { 0x41 }
                exchange.responseBody.write(chunk)
                exchange.responseBody.flush()
                responseStarted.countDown()
                while (!stopWriting.await(5, TimeUnit.MILLISECONDS)) {
                    exchange.responseBody.write(chunk)
                    exchange.responseBody.flush()
                }
            } catch (_: IOException) {
                clientDisconnected.countDown()
            } finally {
                exchange.close()
            }
        }
        local.start()
        val completion = CountDownLatch(1)
        val deliveries = AtomicInteger()
        val received = AtomicReference<Map<String, Any?>>()

        try {
            val call = DesktopNetwork.apiFetch.request(
                "http://127.0.0.1:${local.address.port}/unbounded",
                mapOf("method" to "GET", "expect" to "text"),
            ) {
                deliveries.incrementAndGet()
                received.set(it)
                completion.countDown()
            }
            assertTrue(responseStarted.await(5, TimeUnit.SECONDS))
            call.cancel()

            assertTrue(completion.await(5, TimeUnit.SECONDS))
            assertEquals(1, deliveries.get())
            assertEquals(true, received.get()["aborted"])
            assertEquals(-1.0, received.get()["status"])
            assertTrue(clientDisconnected.await(5, TimeUnit.SECONDS))
        } finally {
            stopWriting.countDown()
        }
    }
}
