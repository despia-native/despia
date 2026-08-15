// Despia MCP - the stdio launcher's other half.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// An agent host's config file is static and its transport is stdio. Our port is
// ephemeral and our transport is HTTP on loopback. This is the adapter, and it
// is the ONLY place the two meet.
//
// It carries no credential of its own. It reads the 0600 discovery file at run
// time - which means the operating system's file permissions, not this code,
// are what keep the pairing token from a co-resident process - and it stops
// working the moment consent is withdrawn, because the file is gone and the
// token has been rotated. That is the whole design: the launcher script an
// integrator pastes into a config (and, eventually, into a bug report) is inert
// text.
//
// The HTTP client is a raw socket rather than the JDK's URL machinery, for two
// reasons that both matter. A URL client consults the JVM's proxy
// configuration, and a proxy on a loopback request is either a no-op or a leak.
// And a raw socket has no redirect handling, no cookie jar and no connection
// reuse across hosts - three behaviours with no business on a loopback call and
// three more things to reason about if they were there.

package com.despia.mcp

import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.Writer
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets

/** One answer from the local server. */
public data class LoopbackReply(val status: Int, val body: String, val headers: Map<String, String>)

/**
 * A minimal HTTP/1.1 POST client, loopback only.
 *
 * There is no host parameter here either. The address is the constant from
 * [LoopbackHosts]; the discovery file supplies a port and nothing else.
 */
public class McpLoopbackClient(
    private val port: Int,
    private val token: String,
    private val connectTimeoutMillis: Int = 2_000,
    private val readTimeoutMillis: Int = 120_000,
) {

    public fun post(body: String, sessionId: String? = null): LoopbackReply {
        val payload = body.toByteArray(StandardCharsets.UTF_8)
        Socket().use { socket ->
            socket.connect(
                java.net.InetSocketAddress(InetAddress.getByName(LoopbackHosts.IPV4), port),
                connectTimeoutMillis,
            )
            socket.soTimeout = readTimeoutMillis
            socket.tcpNoDelay = true

            val head = StringBuilder()
            head.append("POST ").append(MCP_ENDPOINT_PATH).append(" HTTP/1.1\r\n")
            head.append("Host: ").append(LoopbackHosts.IPV4).append(':').append(port).append("\r\n")
            // The token travels HERE and nowhere else. Never a query string.
            head.append("Authorization: ").append(McpSession.BEARER_PREFIX).append(token).append("\r\n")
            head.append("Content-Type: application/json\r\n")
            head.append("Accept: application/json\r\n")
            head.append("MCP-Protocol-Version: ").append(MCP_PROTOCOL_VERSION).append("\r\n")
            if (sessionId != null) head.append("Mcp-Session-Id: ").append(sessionId).append("\r\n")
            head.append("Content-Length: ").append(payload.size).append("\r\n")
            head.append("Connection: close\r\n\r\n")

            val output = socket.getOutputStream()
            output.write(head.toString().toByteArray(StandardCharsets.ISO_8859_1))
            output.write(payload)
            output.flush()

            return readReply(BufferedInputStream(socket.getInputStream(), 8 * 1_024))
        }
    }

    private fun readReply(input: BufferedInputStream): LoopbackReply {
        val head = StringBuilder()
        var state = 0
        while (state < 4) {
            val value = input.read()
            if (value < 0) break
            head.append(value.toChar())
            state = when {
                state == 0 && value == '\r'.code -> 1
                state == 1 && value == '\n'.code -> 2
                state == 2 && value == '\r'.code -> 3
                state == 3 && value == '\n'.code -> 4
                value == '\r'.code -> 1
                else -> 0
            }
        }
        val lines = head.toString().split("\r\n")
        val status = lines.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull() ?: 0
        val headers = LinkedHashMap<String, String>()
        for (index in 1 until lines.size) {
            val colon = lines[index].indexOf(':')
            if (colon <= 0) continue
            headers[lines[index].substring(0, colon).trim().lowercase()] =
                lines[index].substring(colon + 1).trim()
        }
        val declared = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(declared)
        var received = 0
        while (received < declared) {
            val count = input.read(body, received, declared - received)
            if (count <= 0) break
            received += count
        }
        return LoopbackReply(status, String(body, 0, received, StandardCharsets.UTF_8), headers)
    }
}

/**
 * The pump. Newline-delimited JSON-RPC on stdin and stdout, HTTP on loopback.
 *
 * A notification (no `id`) gets no reply and produces no output line, which is
 * what the stdio transport expects. A transport failure is turned into a
 * JSON-RPC error carrying the request's own id, so a host waiting on an answer
 * gets one instead of hanging - a bridge that silently dropped a request would
 * look exactly like a slow tool.
 */
public object McpStdioBridge {

    @JvmStatic
    public fun main(arguments: Array<String>) {
        if (arguments.isEmpty()) {
            System.err.println("usage: McpStdioBridge <discovery.json>")
            kotlin.system.exitProcess(2)
        }
        val reader = BufferedReader(InputStreamReader(System.`in`, StandardCharsets.UTF_8))
        val writer = BufferedWriter(OutputStreamWriter(System.out, StandardCharsets.UTF_8))
        val code = run(File(arguments[0]), reader, writer)
        writer.flush()
        kotlin.system.exitProcess(code)
    }

    /**
     * Runs the pump against an explicit discovery file and streams.
     *
     * Exposed so a test can drive it with real streams against a real server
     * rather than asserting that a script contains the right words.
     */
    public fun run(discoveryFile: File, input: BufferedReader, output: Writer): Int {
        val record = readDiscovery(discoveryFile)
            ?: run {
                System.err.println(
                    "no readable discovery file at ${discoveryFile.absolutePath} - external access " +
                        "is not granted, or it was withdrawn",
                )
                return 1
            }
        val port = (record["port"] as? Number)?.toInt() ?: return 1
        val token = record["token"] as? String ?: return 1
        val client = McpLoopbackClient(port, token)
        var sessionId: String? = null

        while (true) {
            val line = input.readLine() ?: break
            if (line.isBlank()) continue
            val id = runCatching { (Json.decode(line) as? Map<*, *>)?.get("id") }.getOrNull()
            val reply = try {
                client.post(line, sessionId)
            } catch (e: Exception) {
                if (id != null) writeLine(output, transportError(id, e.message ?: "the local server did not answer"))
                continue
            }
            reply.headers["mcp-session-id"]?.let { sessionId = it }
            when {
                // A notification, answered 202 with no body: nothing to forward.
                reply.body.isEmpty() -> if (id != null && reply.status != 202) {
                    writeLine(output, transportError(id, "the local server answered ${reply.status}"))
                }
                else -> writeLine(output, reply.body)
            }
        }
        return 0
    }

    private fun readDiscovery(file: File): Map<String, Any?>? = runCatching {
        Json.decodeObject(file.readText(StandardCharsets.UTF_8))
    }.getOrNull()

    /**
     * A transport failure, spoken as JSON-RPC.
     *
     * It carries no Despia refusal code: the bridge does not know WHY the
     * server refused, and inventing `unauthorized` here would put a specific
     * accusation on a generic failure - the host would show a user the wrong
     * remedy for a closed socket.
     */
    private fun transportError(id: Any?, message: String): String = Json.encode(
        linkedMapOf(
            "jsonrpc" to "2.0",
            "id" to id,
            "error" to linkedMapOf("code" to -32001, "message" to message),
        ),
    )

    private fun writeLine(output: Writer, text: String) {
        // One message per line, so a newline inside a value would desynchronize
        // the stream. The encoder escapes them; this asserts the invariant the
        // decoder on the other side depends on.
        output.write(text.replace("\n", "").replace("\r", ""))
        output.write("\n")
        output.flush()
    }
}
