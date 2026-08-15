package despia.engine.desktop

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DesktopMediaGatewayTest {
    @Test
    fun hlsRewriteMediatesUriLinesAndTagAttributesWithoutLeakingAuthoredUrls() {
        val resolved = ArrayList<URI>()
        val input = ("#EXTM3U\r\n" +
            "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin?token=key-secret\"\r\n" +
            "segments/one.ts?token=segment-secret\r\n").toByteArray()
        val rewritten = rewriteDesktopHlsPlaylist(
            input,
            URI("http://127.0.0.1:8080/media/master.m3u8?token=manifest-secret"),
        ) { uri ->
            resolved += uri
            "http://127.0.0.1:9090/root/${resolved.size}"
        }.toString(Charsets.UTF_8)

        assertEquals(2, resolved.size)
        assertEquals("/media/keys/key.bin", resolved[0].path)
        assertEquals("token=key-secret", resolved[0].query)
        assertEquals("/media/segments/one.ts", resolved[1].path)
        assertFalse(rewritten.contains("secret"))
        assertTrue(rewritten.contains("URI=\"http://127.0.0.1:9090/root/1\""))
        assertTrue(rewritten.contains("http://127.0.0.1:9090/root/2\r\n"))
    }

    @Test
    fun hlsRewriteRejectsMalformedTraversalAndUnmediatedSchemes() {
        val base = URI("http://127.0.0.1:8080/master.m3u8")
        assertFailsWith<IllegalArgumentException> {
            rewriteDesktopHlsPlaylist("not-hls\nsegment.ts".toByteArray(), base) { it.toString() }
        }
        assertFailsWith<Throwable> {
            rewriteDesktopHlsPlaylist("#EXTM3U\nfile:///private/key".toByteArray(), base) { it.toString() }
        }
        assertFailsWith<Throwable> {
            rewriteDesktopHlsPlaylist("#EXTM3U\nhttps://user:password@example.com/a.ts".toByteArray(), base) { it.toString() }
        }
    }

    @Test
    fun hlsRewriteAcceptsMixedCaseCanonicalUriAndRejectsAmbiguousAttributeSyntax() {
        val base = URI("http://127.0.0.1:8080/master.m3u8")
        val mixedCase = rewriteDesktopHlsPlaylist(
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,uRi=\"key.bin\"".toByteArray(),
            base,
        ) { "http://127.0.0.1:9090/opaque" }.toString(Charsets.UTF_8)
        assertTrue(mixedCase.endsWith("URI=\"http://127.0.0.1:9090/opaque\""))

        listOf(
            "URI=key.bin",
            "URI =\"key.bin\"",
            "URI= \"key.bin\"",
            " URI=\"key.bin\"",
            "URI=\"one\",URI=\"two\"",
            "URI=\"unterminated",
            "URI=\"one\"trailing",
            "X=1 URI=\"key.bin\"",
        ).forEach { attributes ->
            assertFailsWith<IllegalArgumentException>(attributes) {
                rewriteDesktopHlsPlaylist(
                    "#EXTM3U\n#EXT-X-KEY:$attributes".toByteArray(),
                    base,
                ) { it.toString() }
            }
        }
    }

    @Test
    fun hlsRewriteRejectsEmbeddedCarriageReturnOrLineFeedInUriAttribute() {
        val base = URI("http://127.0.0.1:8080/master.m3u8")
        listOf(
            "#EXTM3U\n#EXT-X-KEY:URI=\"key\rname.bin\"",
            "#EXTM3U\n#EXT-X-KEY:URI=\"key\nname.bin\"",
        ).forEach { playlist ->
            assertFailsWith<IllegalArgumentException> {
                rewriteDesktopHlsPlaylist(playlist.toByteArray(), base) { it.toString() }
            }
        }
    }

    @Test
    fun gatewayForwardsOnlyValidatedRangeAndNeverDownstreamCredentials() {
        val upstreamCookie = AtomicReference<String?>()
        val upstreamAuthorization = AtomicReference<String?>()
        val upstreamRange = AtomicReference<String?>()
        withUpstream { server ->
            server.createContext("/media") { exchange ->
                upstreamCookie.set(exchange.requestHeaders.getFirst("Cookie"))
                upstreamAuthorization.set(exchange.requestHeaders.getFirst("Authorization"))
                upstreamRange.set(exchange.requestHeaders.getFirst("Range"))
                val all = "abcdefghij".toByteArray()
                val body = if (upstreamRange.get() == "bytes=2-5") all.copyOfRange(2, 6) else all
                exchange.responseHeaders.set("Content-Type", "video/mp4")
                if (body.size != all.size) {
                    exchange.responseHeaders.set("Accept-Ranges", "bytes")
                    exchange.responseHeaders.set("Content-Range", "bytes 2-5/${all.size}")
                    exchange.sendResponseHeaders(206, body.size.toLong())
                } else {
                    exchange.sendResponseHeaders(200, body.size.toLong())
                }
                exchange.responseBody.use { it.write(body) }
            }
            val authored = "http://127.0.0.1:${server.address.port}/media?token=upstream-secret"
            DesktopMediaGateway.start(authored, maximumSessionBytes = 64, maximumResponseBytes = 32).use { gateway ->
                assertFalse(gateway.url.contains("secret"))
                val request = HttpRequest.newBuilder(URI(gateway.url))
                    .header("Range", "bytes=2-5")
                    .header("Cookie", "session=downstream-secret")
                    .header("Authorization", "Bearer downstream-secret")
                    .GET().build()
                val response = testClient.send(request, HttpResponse.BodyHandlers.ofByteArray())
                assertEquals(206, response.statusCode())
                assertEquals("cdef", response.body().toString(Charsets.UTF_8))
                assertEquals("bytes 2-5/10", response.headers().firstValue("Content-Range").orElse(null))
                assertEquals("bytes=2-5", upstreamRange.get())
                assertEquals(null, upstreamCookie.get())
                assertEquals(null, upstreamAuthorization.get())
                assertEquals(4, gateway.consumedBytes)
            }
        }
    }

    @Test
    fun gatewayAggregateBudgetFailsClosedAcrossRepeatedDecoderRequests() {
        withUpstream { server ->
            server.createContext("/chunk") { exchange -> respond(exchange, "123456".toByteArray(), "audio/mpeg") }
            DesktopMediaGateway.start(
                "http://127.0.0.1:${server.address.port}/chunk",
                maximumSessionBytes = 10,
                maximumResponseBytes = 10,
            ).use { gateway ->
                val request = HttpRequest.newBuilder(URI(gateway.url)).GET().build()
                assertEquals(200, testClient.send(request, HttpResponse.BodyHandlers.ofByteArray()).statusCode())
                assertEquals(6, gateway.consumedBytes)
                assertEquals(502, testClient.send(request, HttpResponse.BodyHandlers.ofByteArray()).statusCode())
                assertEquals(6, gateway.consumedBytes)
            }
        }
    }

    @Test
    fun liveHlsGatewayReturnsOnlyOpaqueReferencesAndMediatesSegments() {
        withUpstream { server ->
            server.createContext("/master.m3u8") { exchange ->
                respond(
                    exchange,
                    "#EXTM3U\n#EXTINF:1,\nsegment.ts?token=segment-secret\n".toByteArray(),
                    "application/vnd.apple.mpegurl",
                )
            }
            server.createContext("/segment.ts") { exchange ->
                assertEquals("token=segment-secret", exchange.requestURI.rawQuery)
                respond(exchange, "segment-payload".toByteArray(), "video/mp2t")
            }
            DesktopMediaGateway.start(
                "http://127.0.0.1:${server.address.port}/master.m3u8?token=manifest-secret",
                maximumSessionBytes = 4096,
                maximumResponseBytes = 2048,
            ).use { gateway ->
                val playlist = testClient.send(
                    HttpRequest.newBuilder(URI(gateway.url)).GET().build(),
                    HttpResponse.BodyHandlers.ofString(),
                )
                assertEquals(200, playlist.statusCode())
                assertFalse(playlist.body().contains("secret"))
                val segmentUrl = playlist.body().lineSequence().first { it.startsWith("http://127.0.0.1:") }
                val segment = testClient.send(
                    HttpRequest.newBuilder(URI(segmentUrl)).GET().build(),
                    HttpResponse.BodyHandlers.ofString(),
                )
                assertEquals(200, segment.statusCode())
                assertEquals("segment-payload", segment.body())
                assertTrue(gateway.consumedBytes >= "segment-payload".length)
            }
        }
    }

    @Test
    fun lottieAdmissionAcceptsBoundedJsonAndRejectsExternalAssetsAndExtremeDepth() {
        val valid = minimalLottieJson().toByteArray()
        assertEquals(minimalLottieJson(), validateDesktopLottieJson(valid))
        val external = minimalLottieJson(assets = "[{\"id\":\"image_0\",\"p\":\"cover.png\",\"u\":\"images/\"}]")
        assertFailsWith<IllegalArgumentException> { validateDesktopLottieJson(external.toByteArray()) }
        listOf(
            "[{\"id\":\"image_0\",\"p\":\"data:image/png;base64,AA==\"}]",
            "[{\"id\":\"font_0\",\"fPath\":\"https://example.test/font.ttf\"}]",
            "[{\"id\":\"text_0\",\"note\":\"file:///private/leak\"}]",
        ).forEach { assets ->
            assertFailsWith<IllegalArgumentException> { validateDesktopLottieJson(minimalLottieJson(assets).toByteArray()) }
        }
        val deep = "{\"x\":" + "[".repeat(DESKTOP_LOTTIE_MAX_JSON_DEPTH + 1) +
            "0" + "]".repeat(DESKTOP_LOTTIE_MAX_JSON_DEPTH + 1) + "}"
        assertFailsWith<IllegalArgumentException> { validateDesktopLottieJson(deep.toByteArray()) }
    }

    @Test
    fun dotLottieAdmissionRequiresSafeManifestAndAnimationEntries() {
        val valid = zipOf(
            "manifest.json" to "{\"animations\":[{\"id\":\"main\"}]}".toByteArray(),
            "animations/main.json" to minimalLottieJson().toByteArray(),
        )
        validateDesktopDotLottie(valid)
        val traversal = zipOf(
            "manifest.json" to "{\"animations\":[{\"id\":\"main\"}]}".toByteArray(),
            "../animations/main.json" to minimalLottieJson().toByteArray(),
        )
        assertFailsWith<IllegalArgumentException> { validateDesktopDotLottie(traversal) }
        val missingManifest = zipOf("animations/main.json" to minimalLottieJson().toByteArray())
        assertFailsWith<IllegalArgumentException> { validateDesktopDotLottie(missingManifest) }
        val arbitraryBinary = zipOf(
            "manifest.json" to "{\"animations\":[{\"id\":\"main\"}]}".toByteArray(),
            "animations/main.json" to minimalLottieJson().toByteArray(),
            "images/bomb.png" to ByteArray(32),
        )
        assertFailsWith<IllegalArgumentException> { validateDesktopDotLottie(arbitraryBinary) }
        val unreferencedAnimation = zipOf(
            "manifest.json" to "{\"animations\":[{\"id\":\"main\"}]}".toByteArray(),
            "animations/main.json" to minimalLottieJson().toByteArray(),
            "animations/hidden.json" to minimalLottieJson().toByteArray(),
        )
        assertFailsWith<IllegalArgumentException> { validateDesktopDotLottie(unreferencedAnimation) }
    }

    @Test
    fun mediaBooleanGrammarMatchesCanonicalNumericTruthiness() {
        assertTrue(desktopMediaBool(null, true))
        assertFalse(desktopMediaBool(null, false))
        assertTrue(desktopMediaBool("true", false))
        assertTrue(desktopMediaBool("1", false))
        assertFalse(desktopMediaBool("0", true))
        assertFalse(desktopMediaBool("false", true))
    }

    private fun withUpstream(block: (HttpServer) -> Unit) {
        val server = HttpServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 8)
        val executor = Executors.newFixedThreadPool(4)
        server.executor = executor
        server.start()
        try {
            block(server)
        } finally {
            server.stop(0)
            executor.shutdownNow()
        }
    }

    private fun respond(exchange: HttpExchange, body: ByteArray, contentType: String) {
        exchange.responseHeaders.set("Content-Type", contentType)
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }

    private fun minimalLottieJson(assets: String = "[]"): String =
        "{\"v\":\"5.12.0\",\"fr\":30,\"ip\":0,\"op\":30,\"w\":64,\"h\":64,\"assets\":$assets,\"layers\":[]}"

    private fun zipOf(vararg entries: Pair<String, ByteArray>): ByteArray {
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            entries.forEach { (name, bytes) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return output.toByteArray()
    }

    private companion object {
        val testClient: HttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build()
    }
}
