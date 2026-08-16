// Despia MCP - the bounded loopback listener the Streamable-HTTP framing runs on.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// There is no HTTP server framework here, on purpose. The framing this package
// needs is one endpoint, three methods and a JSON body; a server framework
// would bring a configuration surface, a routing layer and a set of defaults
// that all have to be audited to say anything true about the security of a
// process that executes app behaviour on request. What it would save is the
// four hundred lines below, which are the four hundred lines a reviewer most
// wants to be able to read.
//
// The invariants, each of which a test asserts against a REAL bound socket:
//
//   * NUMERIC LOOPBACK ONLY. 127.0.0.1, and ::1 when the platform has it. Not a
//     hostname - a hostname resolves, and a resolver is an input. Not a
//     wildcard - a wildcard puts a phone's MCP server on the local network.
//     There is no host parameter anywhere in this file.
//   * AN OS-SELECTED EPHEMERAL PORT. A fixed port is a fixed target.
//   * EVERY PHASE IS BOUNDED. Header bytes, header count, body bytes,
//     concurrent connections, worker threads, and a separate deadline for the
//     header phase, the body phase and the response.
//
// Deliberately NOT here: authentication. The listener carries bytes; the
// transport above it decides who may be heard. Keeping that split means the
// token check has exactly one implementation and one place to regress.

package com.despia.mcp

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Base64
import java.util.Collections
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.math.min

/** The only two addresses this package will ever bind. Not configurable. */
public object LoopbackHosts {
    public const val IPV4: String = "127.0.0.1"
    public const val IPV6: String = "::1"
}

/** Every bound this listener enforces, in one readable block. */
public data class LoopbackLimits(
    val maximumHeaderBytes: Int = 16 * 1_024,
    val maximumHeaderCount: Int = 64,
    val maximumRequestTargetBytes: Int = 2 * 1_024,
    val maximumBodyBytes: Long = 4L * 1_024 * 1_024,
    val maximumConnections: Int = 8,
    val maximumWorkers: Int = 4,
    val headerDeadlineMillis: Int = 5_000,
    val bodyIdleDeadlineMillis: Int = 10_000,
    val bodyAbsoluteDeadlineMillis: Long = 30_000,
    val responseAbsoluteDeadlineMillis: Long = 60_000,
) {
    public companion object {
        public val production: LoopbackLimits = LoopbackLimits()
    }
}

/** Why a request was refused before it reached the transport. */
public enum class LoopbackRefusal { malformed, headerTooLarge, bodyTooLarge, targetTooLong }

public class LoopbackPolicyException(public val kind: LoopbackRefusal) : Exception(kind.name)

/** One parsed request. Header names are lowercased once, here, and nowhere else. */
public data class LoopbackRequest(
    val method: String,
    val path: String,
    val query: String,
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    public fun header(name: String): String? = headers[name.lowercase()]

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/** One response. The listener adds `Content-Length` and `Connection: close`. */
public data class LoopbackResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray = ByteArray(0),
) {
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)

    public companion object {
        public fun json(status: Int, text: String, extra: Map<String, String> = emptyMap()): LoopbackResponse =
            LoopbackResponse(
                status,
                linkedMapOf(
                    "Content-Type" to "application/json",
                    "Cache-Control" to "no-store",
                ) + extra,
                text.toByteArray(StandardCharsets.UTF_8),
            )

        public fun empty(status: Int, extra: Map<String, String> = emptyMap()): LoopbackResponse =
            LoopbackResponse(status, extra, ByteArray(0))
    }
}

/** Token minting and comparison. One implementation, used by every token in this package. */
public object LoopbackTokens {

    private val random = SecureRandom()

    /** 256 bits from the platform CSPRNG, URL-safe so it survives being pasted. */
    public fun mint(byteCount: Int = 32): String {
        require(byteCount >= 32) { "a loopback token needs at least 256 bits" }
        val bytes = ByteArray(byteCount)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /**
     * Length-independent, value-independent comparison. Returning early on the
     * first differing byte would leak the prefix a caller got right, one
     * request at a time, and loopback callers can make a great many requests.
     */
    public fun constantTimeEquals(lhs: String?, rhs: String?): Boolean {
        if (lhs == null || rhs == null) return false
        val a = lhs.toByteArray(StandardCharsets.UTF_8)
        val b = rhs.toByteArray(StandardCharsets.UTF_8)
        var difference = a.size xor b.size
        for (i in 0 until maxOf(a.size, b.size)) {
            val left = if (i < a.size) a[i].toInt() and 0xff else 0
            val right = if (i < b.size) b[i].toInt() and 0xff else 0
            difference = difference or (left xor right)
        }
        return difference == 0
    }
}

/**
 * The listener. Construct, [start], read [port], [stop].
 *
 * [handler] runs on a bounded worker thread and must not block indefinitely -
 * the response deadline closes the socket underneath it if it does, which turns
 * a hung tool into a dropped connection rather than a leaked worker.
 */
public class LoopbackListener(
    private val limits: LoopbackLimits = LoopbackLimits.production,
    private val handler: (LoopbackRequest) -> LoopbackResponse,
) {

    private val lock = Any()
    private var primary: ServerSocket? = null
    private var secondary: ServerSocket? = null
    private var workers: ThreadPoolExecutor? = null
    private var deadlines: ScheduledExecutorService? = null
    private val open = Collections.synchronizedSet(LinkedHashSet<Socket>())

    @Volatile
    public var port: Int = 0
        private set

    /** The addresses actually bound, for a test that refuses to take this on faith. */
    @Volatile
    public var boundAddresses: List<InetAddress> = emptyList()
        private set

    public val isRunning: Boolean get() = synchronized(lock) { primary?.isClosed == false && port > 0 }

    public fun start(): Int {
        synchronized(lock) {
            if (primary?.isClosed == false) return port

            // Port 0 = ask the OS. The address is the constant above; there is no
            // parameter, no config key and no override.
            val four = ServerSocket(0, limits.maximumConnections, InetAddress.getByName(LoopbackHosts.IPV4))
            val chosen = four.localPort

            // The same port on IPv6 loopback when the platform offers one. A host
            // that resolves "localhost" to ::1 would otherwise find nothing. When
            // it is unavailable this is simply skipped: IPv4 loopback is the
            // guarantee, IPv6 is a convenience.
            val six = runCatching {
                ServerSocket(chosen, limits.maximumConnections, InetAddress.getByName(LoopbackHosts.IPV6))
            }.getOrNull()

            val pool = ThreadPoolExecutor(
                limits.maximumWorkers,
                limits.maximumWorkers,
                0L,
                TimeUnit.MILLISECONDS,
                ArrayBlockingQueue(maxOf(1, limits.maximumConnections - limits.maximumWorkers)),
                { runnable -> Thread(runnable, "despia-mcp-worker").apply { isDaemon = true } },
                ThreadPoolExecutor.AbortPolicy(),
            )
            val timer = Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "despia-mcp-deadlines").apply { isDaemon = true }
            }

            primary = four
            secondary = six
            workers = pool
            deadlines = timer
            port = chosen
            boundAddresses = listOfNotNull(four.inetAddress, six?.inetAddress)

            accept(four, pool)
            if (six != null) accept(six, pool)
            return chosen
        }
    }

    public fun stop() {
        val sockets: List<ServerSocket>
        val pool: ThreadPoolExecutor?
        val timer: ScheduledExecutorService?
        synchronized(lock) {
            sockets = listOfNotNull(primary, secondary)
            pool = workers
            timer = deadlines
            primary = null
            secondary = null
            workers = null
            deadlines = null
            port = 0
            boundAddresses = emptyList()
        }
        sockets.forEach { runCatching { it.close() } }
        synchronized(open) {
            open.toList().forEach { runCatching { it.close() } }
            open.clear()
        }
        pool?.shutdownNow()
        timer?.shutdownNow()
        runCatching { pool?.awaitTermination(2, TimeUnit.SECONDS) }
    }

    private fun accept(server: ServerSocket, pool: ThreadPoolExecutor) {
        Thread({
            while (!server.isClosed) {
                val client = try {
                    server.accept()
                } catch (_: SocketException) {
                    break
                } catch (_: Exception) {
                    continue
                }
                if (open.size >= limits.maximumConnections) {
                    refuseOverload(client)
                    continue
                }
                open.add(client)
                try {
                    pool.execute {
                        try {
                            serve(client)
                        } catch (_: Exception) {
                            // One hostile request never escapes its own connection.
                        } finally {
                            open.remove(client)
                            runCatching { client.close() }
                        }
                    }
                } catch (_: RejectedExecutionException) {
                    open.remove(client)
                    refuseOverload(client)
                }
            }
        }, "despia-mcp-accept").apply { isDaemon = true }.start()
    }

    private fun refuseOverload(client: Socket) {
        runCatching {
            client.soTimeout = 250
            client.getOutputStream().apply {
                write(
                    ("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n" +
                        "Content-Length: 0\r\nRetry-After: 1\r\n\r\n").toByteArray(StandardCharsets.ISO_8859_1),
                )
                flush()
            }
        }
        runCatching { client.close() }
    }

    private fun serve(client: Socket) {
        client.tcpNoDelay = true
        val input = BufferedInputStream(client.getInputStream(), 8 * 1_024)
        val output = BufferedOutputStream(client.getOutputStream(), 32 * 1_024)

        val headBytes = try {
            readHead(client, input)
        } catch (_: SocketTimeoutException) {
            return write(output, LoopbackResponse.empty(408))
        } catch (e: LoopbackPolicyException) {
            return write(output, LoopbackResponse.empty(if (e.kind == LoopbackRefusal.headerTooLarge) 431 else 400))
        }

        val head = try {
            parseHead(headBytes)
        } catch (e: LoopbackPolicyException) {
            val status = when (e.kind) {
                LoopbackRefusal.headerTooLarge -> 431
                LoopbackRefusal.targetTooLong -> 414
                else -> 400
            }
            return write(output, LoopbackResponse.empty(status))
        }

        val declared = head.headers["content-length"]?.toLongOrNull() ?: 0L
        if (declared < 0 || declared > limits.maximumBodyBytes) {
            return write(output, LoopbackResponse.empty(413))
        }
        // Chunked bodies are refused rather than assembled: an MCP request is a
        // JSON document of known length, and a decoder is a parser we do not
        // need to own.
        if (head.headers["transfer-encoding"] != null) {
            return write(output, LoopbackResponse.empty(411))
        }
        if (head.headers["expect"] != null) {
            return write(output, LoopbackResponse.empty(417))
        }

        val body = if (declared > 0) {
            try {
                readBody(client, input, declared)
            } catch (_: SocketTimeoutException) {
                return write(output, LoopbackResponse.empty(408))
            } catch (_: Exception) {
                return write(output, LoopbackResponse.empty(400))
            }
        } else {
            ByteArray(0)
        }

        val request = LoopbackRequest(head.method, head.path, head.query, head.headers, body)
        val guard = synchronized(lock) { deadlines }?.schedule(
            { runCatching { client.close() } },
            limits.responseAbsoluteDeadlineMillis,
            TimeUnit.MILLISECONDS,
        )
        try {
            val response = try {
                handler(request)
            } catch (_: Exception) {
                LoopbackResponse.empty(500)
            }
            write(output, response, suppressBody = head.method == "HEAD")
        } finally {
            guard?.cancel(false)
        }
    }

    private fun readHead(client: Socket, input: BufferedInputStream): ByteArray {
        val out = ByteArrayOutputStream(min(2_048, limits.maximumHeaderBytes))
        val started = System.nanoTime()
        var state = 0
        while (true) {
            val elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            val remaining = limits.headerDeadlineMillis - elapsed
            if (remaining <= 0) throw SocketTimeoutException("header deadline")
            client.soTimeout = remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt().coerceAtLeast(1)
            val value = input.read()
            if (value < 0) throw LoopbackPolicyException(LoopbackRefusal.malformed)
            out.write(value)
            if (out.size() > limits.maximumHeaderBytes + 4) {
                throw LoopbackPolicyException(LoopbackRefusal.headerTooLarge)
            }
            state = when {
                state == 0 && value == '\r'.code -> 1
                state == 1 && value == '\n'.code -> 2
                state == 2 && value == '\r'.code -> 3
                state == 3 && value == '\n'.code -> 4
                value == '\r'.code -> 1
                else -> 0
            }
            if (state == 4) {
                val bytes = out.toByteArray()
                return bytes.copyOf(bytes.size - 4)
            }
        }
    }

    private data class Head(
        val method: String,
        val path: String,
        val query: String,
        val headers: Map<String, String>,
    )

    private fun parseHead(bytes: ByteArray): Head {
        val text = String(bytes, StandardCharsets.ISO_8859_1)
        val lines = text.split("\r\n")
        if (lines.isEmpty()) throw LoopbackPolicyException(LoopbackRefusal.malformed)
        val request = lines[0].split(' ')
        if (request.size != 3) throw LoopbackPolicyException(LoopbackRefusal.malformed)
        val method = request[0].uppercase()
        val target = request[1]
        if (target.toByteArray(StandardCharsets.ISO_8859_1).size > limits.maximumRequestTargetBytes) {
            throw LoopbackPolicyException(LoopbackRefusal.targetTooLong)
        }
        if (!request[2].startsWith("HTTP/1.")) throw LoopbackPolicyException(LoopbackRefusal.malformed)

        val split = target.indexOf('?')
        val path = if (split < 0) target else target.substring(0, split)
        val query = if (split < 0) "" else target.substring(split + 1)
        if (!path.startsWith("/")) throw LoopbackPolicyException(LoopbackRefusal.malformed)

        val headers = LinkedHashMap<String, String>()
        for (index in 1 until lines.size) {
            val line = lines[index]
            if (line.isEmpty()) continue
            if (headers.size >= limits.maximumHeaderCount) {
                throw LoopbackPolicyException(LoopbackRefusal.headerTooLarge)
            }
            val colon = line.indexOf(':')
            if (colon <= 0) throw LoopbackPolicyException(LoopbackRefusal.malformed)
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            // Last value wins rather than joining: a duplicated Authorization
            // header must never become a comma list a comparison could pass.
            headers[name] = value
        }
        return Head(method, path, query, headers)
    }

    private fun readBody(client: Socket, input: BufferedInputStream, length: Long): ByteArray {
        val out = ByteArrayOutputStream(min(length, 64L * 1_024).toInt())
        val buffer = ByteArray(32 * 1_024)
        val started = System.nanoTime()
        var received = 0L
        while (received < length) {
            val elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            val absolute = limits.bodyAbsoluteDeadlineMillis - elapsed
            if (absolute <= 0) throw SocketTimeoutException("body deadline")
            client.soTimeout = min(limits.bodyIdleDeadlineMillis.toLong(), absolute)
                .coerceAtMost(Int.MAX_VALUE.toLong()).toInt().coerceAtLeast(1)
            val count = input.read(buffer, 0, min(buffer.size.toLong(), length - received).toInt())
            if (count <= 0) throw IllegalStateException("truncated body")
            out.write(buffer, 0, count)
            received += count
        }
        return out.toByteArray()
    }

    private fun write(output: OutputStream, response: LoopbackResponse, suppressBody: Boolean = false) {
        val head = StringBuilder("HTTP/1.1 ${response.status} ${reason(response.status)}\r\n")
        head.append("Connection: close\r\n")
        head.append("Content-Length: ${response.body.size}\r\n")
        // Fixed on every response, not per route: a response that forgets them
        // is the one that matters.
        head.append("X-Content-Type-Options: nosniff\r\n")
        head.append("Referrer-Policy: no-referrer\r\n")
        for ((name, raw) in response.headers) {
            val value = raw.replace("\r", "").replace("\n", "")
            head.append(name).append(": ").append(value).append("\r\n")
        }
        head.append("\r\n")
        output.write(head.toString().toByteArray(StandardCharsets.ISO_8859_1))
        if (!suppressBody && response.body.isNotEmpty()) output.write(response.body)
        output.flush()
    }

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"; 202 -> "Accepted"; 204 -> "No Content"
        400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
        405 -> "Method Not Allowed"; 406 -> "Not Acceptable"; 408 -> "Request Timeout"
        411 -> "Length Required"; 413 -> "Payload Too Large"; 414 -> "URI Too Long"
        415 -> "Unsupported Media Type"; 417 -> "Expectation Failed"; 421 -> "Misdirected Request"
        429 -> "Too Many Requests"; 431 -> "Request Header Fields Too Large"
        500 -> "Internal Server Error"; 503 -> "Service Unavailable"
        else -> "Response"
    }
}
