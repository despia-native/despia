// ServerFixture - a real server, on a real socket, for the tests below.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Every server test in this package drives an actual bound listener with an
// actual HTTP client rather than calling `handle` directly. That is deliberate:
// the checks being asserted (the bind address, the header the token rides in,
// the mode on a file) are properties of the deployed thing, and a test that
// reached past the socket could not tell the difference between a transport
// that refuses a request and one that merely intends to.

package com.despia.mcp

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets

/** One raw HTTP answer, split into the parts a test asserts about. */
data class RawReply(val status: Int, val headers: Map<String, String>, val body: String) {

    @Suppress("UNCHECKED_CAST")
    fun json(): Map<String, Any?> = Json.decodeObject(body)

    fun result(): Map<String, Any?> {
        val value = json()["result"]
        return (value as? Map<String, Any?>) ?: error("no result in $body")
    }

    fun error(): Map<String, Any?> {
        val value = json()["error"]
        return (value as? Map<String, Any?>) ?: error("no error in $body")
    }

    /** The Despia refusal code carried in `error.data.code`, or null. */
    fun code(): String? {
        val data = error()["data"] as? Map<*, *> ?: return null
        return data["code"] as? String
    }
}

/**
 * A deliberately dumb HTTP client.
 *
 * It writes exactly the bytes it is told to and does not "helpfully" add a
 * header, follow a redirect or retry. A test asserting that a missing
 * `Authorization` header is refused must be able to actually omit it.
 */
object RawClient {

    fun post(
        port: Int,
        body: String,
        token: String? = null,
        headers: Map<String, String> = emptyMap(),
        method: String = "POST",
        path: String = MCP_ENDPOINT_PATH,
        host: String = LoopbackHosts.IPV4,
    ): RawReply {
        val payload = body.toByteArray(StandardCharsets.UTF_8)
        val head = StringBuilder()
        head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
        head.append("Host: ").append(host).append(':').append(port).append("\r\n")
        if (token != null) {
            head.append("Authorization: ").append(McpSession.BEARER_PREFIX).append(token).append("\r\n")
        }
        if (!headers.keys.any { it.equals("content-type", ignoreCase = true) }) {
            head.append("Content-Type: application/json\r\n")
        }
        for ((name, value) in headers) head.append(name).append(": ").append(value).append("\r\n")
        head.append("Content-Length: ").append(payload.size).append("\r\n")
        head.append("Connection: close\r\n\r\n")

        Socket(InetAddress.getByName(LoopbackHosts.IPV4), port).use { socket ->
            socket.soTimeout = 10_000
            socket.getOutputStream().apply {
                write(head.toString().toByteArray(StandardCharsets.ISO_8859_1))
                write(payload)
                flush()
            }
            val input = socket.getInputStream()
            val out = ByteArrayOutputStream()
            while (true) {
                val value = input.read()
                if (value < 0) break
                out.write(value)
            }
            return parse(String(out.toByteArray(), StandardCharsets.UTF_8))
        }
    }

    private fun parse(raw: String): RawReply {
        val cut = raw.indexOf("\r\n\r\n")
        val head = if (cut < 0) raw else raw.substring(0, cut)
        val body = if (cut < 0) "" else raw.substring(cut + 4)
        val lines = head.split("\r\n")
        val status = lines.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull() ?: 0
        val headers = LinkedHashMap<String, String>()
        for (index in 1 until lines.size) {
            val colon = lines[index].indexOf(':')
            if (colon <= 0) continue
            headers[lines[index].substring(0, colon).trim().lowercase()] =
                lines[index].substring(colon + 1).trim()
        }
        return RawReply(status, headers, body)
    }
}

/** The two rows every server test uses: one read, one write. */
object Rows {
    val search: ServedRow = ServedRow(
        action = "notes.search",
        description = "Search the user's notes.",
        args = mapOf("q" to ArgSpec("string", required = true)),
    )

    val add: ServedRow = ServedRow(
        action = "notes.add",
        description = "Add a note.",
        args = mapOf("text" to ArgSpec("string", required = true)),
        mutates = "base",
    )

    val all: List<ServedRow> = listOf(search, add)
}

/** Records what a server did, in the order it did it. */
class Recorder {
    val order: MutableList<String> = java.util.Collections.synchronizedList(ArrayList())
    val dispatched: MutableList<Pair<String, Map<String, Any?>>> =
        java.util.Collections.synchronizedList(ArrayList())
    val approvals: MutableList<McpApprovalRequest> =
        java.util.Collections.synchronizedList(ArrayList())

    var decision: McpApprovalDecision = McpApprovalDecision.approve
    var snapshotFails: Boolean = false

    val dispatcher: McpDispatcher = McpDispatcher { name, arguments ->
        order.add("dispatch:$name")
        dispatched.add(name to arguments)
        mapOf("ok" to true, "tool" to name)
    }

    val approver: McpApprover = McpApprover { request ->
        order.add("approve:${request.tool}")
        approvals.add(request)
        decision
    }

    val snapshotter: McpSnapshotter = McpSnapshotter { scope ->
        order.add("snapshot:$scope")
        if (snapshotFails) throw IllegalStateException("the store would not snapshot")
    }
}

/** A throwaway container directory for the discovery file. */
fun temporaryHome(): File = java.nio.file.Files.createTempDirectory("despia-mcp-test").toFile()

fun rpc(id: Any?, method: String, params: Map<String, Any?>? = null): String {
    val frame = linkedMapOf<String, Any?>("jsonrpc" to "2.0", "method" to method)
    if (id != null) frame["id"] = id
    if (params != null) frame["params"] = params
    return Json.encode(frame)
}
