// LoopbackTest - the bind address and the bounds, against a real socket.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// docs/security.md says "a test binds the real socket, reads back the bound
// address, and fails if it is anything else". This is that test, and the limit
// cases below are the rest of the sentence: a hostile request is bounded by
// construction, so each bound is driven through a real client connection rather
// than asserted about the constants.

package com.despia.mcp

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

class LoopbackTest {

    private var listener: LoopbackListener? = null

    @AfterTest
    fun stopListener() {
        listener?.stop()
        listener = null
    }

    private fun start(
        limits: LoopbackLimits = LoopbackLimits.production,
        handler: (LoopbackRequest) -> LoopbackResponse,
    ): Int {
        val started = LoopbackListener(limits, handler)
        listener = started
        return started.start()
    }

    /** Writes a raw request and reads until the server closes. */
    private fun exchange(port: Int, raw: String?): String {
        Socket(InetAddress.getByName(LoopbackHosts.IPV4), port).use { socket ->
            socket.soTimeout = 5_000
            if (raw != null) {
                socket.getOutputStream().apply {
                    write(raw.toByteArray(StandardCharsets.ISO_8859_1))
                    flush()
                }
            }
            val input = socket.getInputStream()
            val out = ByteArrayOutputStream()
            while (true) {
                val value = input.read()
                if (value < 0) break
                out.write(value)
            }
            return String(out.toByteArray(), StandardCharsets.ISO_8859_1)
        }
    }

    private fun status(response: String): String = response.lineSequence().first().trim()

    private fun body(response: String): String {
        val cut = response.indexOf("\r\n\r\n")
        return if (cut < 0) "" else response.substring(cut + 4)
    }

    private fun ok(text: String) = LoopbackResponse.json(200, text)

    @Test
    fun `the listener binds numeric loopback and nothing else`() {
        val port = start { ok("{}") }
        val bound = listener!!.boundAddresses

        assertTrue(port in 1..65535, "the OS picked no port")
        assertTrue(bound.isNotEmpty(), "nothing was bound")
        assertTrue(listener!!.isRunning)

        val allowed = setOf(
            InetAddress.getByName(LoopbackHosts.IPV4).hostAddress,
            InetAddress.getByName(LoopbackHosts.IPV6).hostAddress,
        )
        for (address in bound) {
            assertTrue(address.isLoopbackAddress, "${address.hostAddress} is not loopback")
            assertFalse(address.isAnyLocalAddress, "${address.hostAddress} is a wildcard bind")
            assertTrue(address.hostAddress in allowed, "${address.hostAddress} is not one of $allowed")
        }
    }

    @Test
    fun `a request round-trips with its method, target, headers and body`() {
        val seen = AtomicReference<LoopbackRequest>()
        val port = start { request ->
            seen.set(request)
            ok("{\"ok\":true}")
        }

        val response = exchange(
            port,
            "POST /mcp?v=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" +
                "Content-Length: 9\r\n\r\n{\"id\":42}",
        )

        val request = seen.get() ?: fail("the handler never ran")
        assertEquals("POST", request.method)
        assertEquals("/mcp", request.path)
        assertEquals("v=1", request.query)
        // Header names are lowercased once, in the parser, so a lookup does not
        // have to guess the caller's capitalisation.
        assertEquals("application/json", request.header("Content-Type"))
        assertEquals("{\"id\":42}", String(request.body, StandardCharsets.UTF_8))

        assertEquals("HTTP/1.1 200 OK", status(response))
        assertTrue(response.contains("Content-Length: 11\r\n"))
        assertTrue(response.contains("X-Content-Type-Options: nosniff\r\n"))
        assertTrue(response.contains("Referrer-Policy: no-referrer\r\n"))
        assertTrue(response.contains("Cache-Control: no-store\r\n"))
        assertEquals("{\"ok\":true}", body(response))
    }

    @Test
    fun `a duplicated header keeps the last value rather than joining them`() {
        val seen = AtomicReference<LoopbackRequest>()
        val port = start { request ->
            seen.set(request)
            ok("{}")
        }

        exchange(
            port,
            "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
                "Authorization: Bearer first\r\nAuthorization: Bearer second\r\n\r\n",
        )

        // A comma list is a value a comparison could be talked into accepting.
        assertEquals("Bearer second", seen.get()!!.header("authorization"))
    }

    @Test
    fun `HEAD gets the headers without the body`() {
        val port = start { ok("{\"ok\":true}") }

        val response = exchange(port, "HEAD /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")

        assertEquals("HTTP/1.1 200 OK", status(response))
        assertTrue(response.contains("Content-Length: 11\r\n"))
        assertEquals("", body(response))
    }

    @Test
    fun `too many header lines is refused before the handler runs`() {
        val ran = AtomicInteger()
        val port = start(LoopbackLimits(maximumHeaderCount = 4)) {
            ran.incrementAndGet()
            ok("{}")
        }

        val headers = (1..8).joinToString("") { "X-Pad-$it: value\r\n" }
        val response = exchange(port, "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n$headers\r\n")

        assertEquals("HTTP/1.1 431 Request Header Fields Too Large", status(response))
        assertEquals(0, ran.get())
    }

    @Test
    fun `an oversized request target is refused`() {
        val ran = AtomicInteger()
        val port = start(LoopbackLimits(maximumRequestTargetBytes = 32)) {
            ran.incrementAndGet()
            ok("{}")
        }

        val response = exchange(port, "GET /mcp?q=${"a".repeat(64)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")

        assertEquals("HTTP/1.1 414 URI Too Long", status(response))
        assertEquals(0, ran.get())
    }

    @Test
    fun `a body larger than the cap is refused on its declared length`() {
        val ran = AtomicInteger()
        val port = start(LoopbackLimits(maximumBodyBytes = 1_024)) {
            ran.incrementAndGet()
            ok("{}")
        }

        // The declaration is enough: the bytes are never read, so a hostile
        // sender cannot make the process hold them.
        val response = exchange(
            port,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 65536\r\n\r\n",
        )

        assertEquals("HTTP/1.1 413 Payload Too Large", status(response))
        assertEquals(0, ran.get())
    }

    @Test
    fun `a chunked body is refused rather than assembled`() {
        val ran = AtomicInteger()
        val port = start {
            ran.incrementAndGet()
            ok("{}")
        }

        val response = exchange(
            port,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        )

        assertEquals("HTTP/1.1 411 Length Required", status(response))
        assertEquals(0, ran.get())
    }

    @Test
    fun `a malformed request line is refused`() {
        val port = start { ok("{}") }

        assertEquals("HTTP/1.1 400 Bad Request", status(exchange(port, "GET /mcp\r\nHost: 127.0.0.1\r\n\r\n")))
    }

    @Test
    fun `a connection past the cap is refused instead of queued forever`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val port = start(LoopbackLimits(maximumConnections = 1, maximumWorkers = 1)) {
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            ok("{}")
        }

        val holder = Socket(InetAddress.getByName(LoopbackHosts.IPV4), port)
        try {
            holder.soTimeout = 5_000
            holder.getOutputStream().apply {
                write("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".toByteArray(StandardCharsets.ISO_8859_1))
                flush()
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS), "the first connection never reached the handler")

            // Nothing is sent on the second connection: the refusal happens at
            // accept, before a byte of a hostile request is read.
            val refused = exchange(port, null)
            assertEquals("HTTP/1.1 503 Service Unavailable", status(refused))
            assertTrue(refused.contains("Retry-After: 1\r\n"))
        } finally {
            release.countDown()
            holder.close()
        }
    }

    @Test
    fun `stop closes the listener and forgets the port`() {
        val port = start { ok("{}") }
        assertTrue(port > 0)

        listener!!.stop()

        assertFalse(listener!!.isRunning)
        assertEquals(0, listener!!.port)
        assertTrue(listener!!.boundAddresses.isEmpty())
    }
}
