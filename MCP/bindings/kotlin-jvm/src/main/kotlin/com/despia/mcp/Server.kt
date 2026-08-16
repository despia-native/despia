// Despia MCP - the local server: rows, a dispatcher and an approver, tied.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This is the file the other four exist for. `ServedRows` says what may be
// called, `Loopback` carries the bytes, `Session` holds the credential,
// `Discovery` publishes the endpoint - and this decides, per request, whether
// something runs.
//
// The framing is Streamable HTTP, implemented directly on the bounded listener
// rather than on a server framework. That is a deliberate cost: the four
// hundred lines below are four hundred lines a reviewer can read, where a
// framework's routing layer, its defaults and its middleware chain would all
// have to be audited before anyone could say anything true about a process that
// executes app behaviour on request.
//
// THE ORDER OF THE CHECKS IS THE DESIGN. In sequence, and every one of them
// before a single row is looked up:
//
//   1. ORIGIN and HOST must be loopback. This is the DNS-rebinding defence: a
//      page on a hostile site whose name resolves to 127.0.0.1 arrives with its
//      own Host header, and that is the only thing distinguishing it. It is a
//      defence against browsers and nothing else - a co-resident app sends
//      whatever headers it likes.
//   2. PATH and METHOD. One endpoint, POST and DELETE. GET would be the
//      server-initiated stream, which this server does not open, so it is 405
//      rather than an empty stream nobody can distinguish from a hang.
//   3. THE TOKEN. Missing and wrong are one answer. This is the actual
//      boundary; everything above it is hygiene.
//   4. CONTENT NEGOTIATION and the body cap (the listener's, already applied).
//   5. THE JSON-RPC ENVELOPE.
//   6. THE ROW, and only then the approval.
//
// Nothing below is a "fast path" around that order, and nothing may become one.

package com.despia.mcp

import java.io.File
import java.nio.charset.StandardCharsets

/** What an approver is asked to decide about. */
public data class McpApprovalRequest(
    val tool: String,
    val arguments: Map<String, Any?>,
    /** What the row said it changes. Never empty for an approval request. */
    val mutates: String,
    /** Who asked - the app's own surface, or a paired external host. */
    val principal: McpPrincipal,
)

/** The only two answers. A timeout is the caller's business, and it denies. */
public enum class McpApprovalDecision { approve, deny }

/** Executes a declared action. In a Despia app this is ordinary bus dispatch. */
public fun interface McpDispatcher {
    public fun call(tool: String, arguments: Map<String, Any?>): Any?
}

/** Asks the human. Returning [McpApprovalDecision.deny] is always safe. */
public fun interface McpApprover {
    public fun review(request: McpApprovalRequest): McpApprovalDecision
}

/** Captures recoverable state before a write. Throwing refuses the write. */
public fun interface McpSnapshotter {
    public fun snapshot(scope: String)
}

/** The refusal vocabulary, spelled once so no caller invents a spelling. */
public object McpCodes {
    public const val UNAUTHORIZED: String = "unauthorized"
    public const val UNKNOWN_TOOL: String = "unknown_tool"
    public const val TOOL_DENIED: String = "tool_denied"
    public const val APPROVAL_UNAVAILABLE: String = "approval_unavailable"
    public const val SNAPSHOT_UNAVAILABLE: String = "snapshot_unavailable"
    public const val SNAPSHOT_FAILED: String = "snapshot_failed"
}

/**
 * The local MCP server.
 *
 * ```
 * val server = DespiaMcpServer(
 *     rows = rows,
 *     dispatcher = { name, arguments -> app.call(name, arguments) },
 *     approver = { request -> app.approve(request) },
 *     snapshotter = { scope -> app.snapshot(scope) },
 *     home = appContainerDirectory,
 * )
 * val port = server.start()
 * server.grantExternalConsent(true)
 * ```
 *
 * [rows] are not written by hand in a shipped app: they are the `facets.mcp`
 * declarations of every enabled module, fanned in at build time. The
 * constructor takes them directly so the package works, and is testable,
 * without a build system.
 */
public class DespiaMcpServer(
    private val rows: List<ServedRow>,
    private val dispatcher: McpDispatcher,
    private val approver: McpApprover? = null,
    private val snapshotter: McpSnapshotter? = null,
    home: File,
    limits: LoopbackLimits = LoopbackLimits.production,
    private val serverName: String = "despia-mcp",
) {

    public val discovery: McpDiscovery = McpDiscovery(home)

    private val session = McpSession()
    private val listener = LoopbackListener(limits) { request -> handle(request) }
    private val lock = Any()

    /**
     * The HTTP session id, assigned at `initialize`.
     *
     * It is an IDENTIFIER, not a credential - it is checked so that a client
     * holding a stale one is told to re-initialize rather than silently talking
     * to a server that restarted underneath it. The token is what authenticates.
     */
    @Volatile
    private var httpSessionId: String? = null

    public val port: Int get() = listener.port
    public val isRunning: Boolean get() = listener.isRunning
    public val sessionToken: String? get() = session.sessionToken
    public val pairingToken: String? get() = session.pairingToken

    /** The addresses actually bound, for a caller that refuses to take it on faith. */
    public val boundAddresses: List<String> get() = listener.boundAddresses.map { it.hostAddress }

    /** True while a discovery file stands - the one visible sign of external pairing. */
    public val hasExternalConsent: Boolean get() = session.pairingToken != null && discovery.exists()

    /** Every served tool, in declaration order. The same list `tools/list` answers. */
    public fun tools(): List<Map<String, Any?>> = ServedCatalog.toolList(rows)

    /**
     * Binds loopback on an ephemeral port and mints a fresh session token.
     *
     * Returns the port. Starting an already-started server returns the port it
     * is on and does not re-mint - re-minting would log the app's own surfaces
     * out on a redundant call.
     */
    public fun start(): Int = synchronized(lock) {
        if (listener.isRunning) return listener.port
        session.start()
        httpSessionId = null
        listener.start()
    }

    /**
     * Stops the listener, drops both tokens and removes the discovery file.
     *
     * Order matters: the tokens die before the file is removed, so there is no
     * instant in which the file names a port that still answers to a token the
     * app has forgotten it issued.
     */
    public fun stop() {
        synchronized(lock) {
            session.stop()
            httpSessionId = null
            listener.stop()
        }
        runCatching { discovery.removeAll() }
    }

    /**
     * Grants or withdraws external pairing.
     *
     * Granting mints a pairing token DISTINCT from the session token and writes
     * the 0600 discovery file plus the stdio launcher. Withdrawing removes the
     * file and rotates the token, so a host that cached the old value is
     * refused on its next request rather than merely inconvenienced.
     *
     * Granting on a stopped server throws: a discovery file naming a port
     * nothing is listening on is worse than no file.
     */
    public fun grantExternalConsent(granted: Boolean) {
        if (!granted) {
            session.withdrawExternal()
            discovery.remove()
            return
        }
        check(listener.isRunning) { "external consent needs a running server to point at" }
        val pairing = session.grantExternal()
        try {
            discovery.write(listener.port, pairing)
            discovery.writeStdioLauncher()
        } catch (e: Exception) {
            // The file is the grant. If it could not be written safely, the
            // grant did not happen, and the token that would have been in it
            // must not stay valid.
            session.withdrawExternal()
            runCatching { discovery.remove() }
            throw e
        }
    }

    // --- the request path ------------------------------------------------

    internal fun handle(request: LoopbackRequest): LoopbackResponse {
        // 1. Browser defences. A co-resident app is not stopped by these; a page
        //    steered at the loopback origin is.
        if (!originIsLoopback(request.header("origin"))) return LoopbackResponse.empty(403)
        if (!hostIsLoopback(request.header("host"))) return LoopbackResponse.empty(421)

        // 2. One endpoint, and the methods it has.
        if (request.path != MCP_ENDPOINT_PATH) return LoopbackResponse.empty(404)
        when (request.method) {
            "POST", "DELETE" -> Unit
            "GET", "HEAD" -> return LoopbackResponse.empty(405, mapOf("Allow" to "POST, DELETE"))
            else -> return LoopbackResponse.empty(405, mapOf("Allow" to "POST, DELETE"))
        }

        // 3. The boundary. No body, no hint, no distinction between missing and wrong.
        val principal = session.authorize(request.header("authorization"))
            ?: return LoopbackResponse.empty(401, mapOf("WWW-Authenticate" to "Bearer"))

        if (request.method == "DELETE") {
            // Session termination. The listener stays up: what ends is the
            // client's initialized session, not the server.
            httpSessionId = null
            return LoopbackResponse.empty(204)
        }

        // 4. Content negotiation.
        val accept = request.header("accept")
        if (accept != null && !accept.contains("application/json") && !accept.contains("*/*") &&
            !accept.contains("text/event-stream")
        ) {
            return LoopbackResponse.empty(406)
        }
        val contentType = request.header("content-type")?.substringBefore(';')?.trim()?.lowercase()
        if (contentType != null && contentType != "application/json") {
            return LoopbackResponse.empty(415)
        }

        // 5. The envelope.
        val text = String(request.body, StandardCharsets.UTF_8)
        val frame = try {
            Json.decode(text)
        } catch (_: Json.MalformedException) {
            return rpcError(null, -32700, "the request body is not JSON", status = 400)
        }
        if (frame is List<*>) {
            // Batching left the protocol in the 2025-06-18 revision. Answering a
            // batch would mean supporting a shape the pinned SDKs no longer send.
            return rpcError(null, -32600, "JSON-RPC batching is not supported", status = 400)
        }
        if (frame !is Map<*, *>) {
            return rpcError(null, -32600, "a JSON-RPC message is an object", status = 400)
        }
        @Suppress("UNCHECKED_CAST")
        val message = frame as Map<String, Any?>
        if (message["jsonrpc"] != "2.0") {
            return rpcError(message["id"], -32600, "jsonrpc must be \"2.0\"", status = 400)
        }
        val method = message["method"] as? String
            ?: return rpcError(message["id"], -32600, "a JSON-RPC request names a method", status = 400)
        val id = message["id"]

        // A notification carries no id and therefore has no response body.
        if (id == null) {
            return LoopbackResponse.empty(202)
        }

        // The session id is checked only once one has been issued, and it is
        // checked AFTER the token: it identifies a conversation, it does not
        // authorize one.
        val issued = httpSessionId
        if (issued != null && method != "initialize") {
            val presented = request.header("mcp-session-id")
            if (presented != null && presented != issued) {
                return rpcError(id, -32600, "this session has ended; initialize again", status = 404)
            }
        }

        return try {
            dispatch(method, message, id, principal)
        } catch (e: Exception) {
            rpcError(id, -32603, e.message ?: "the server failed to answer")
        }
    }

    private fun dispatch(
        method: String,
        message: Map<String, Any?>,
        id: Any?,
        principal: McpPrincipal,
    ): LoopbackResponse = when (method) {
        "initialize" -> {
            val assigned = LoopbackTokens.mint()
            httpSessionId = assigned
            rpcResult(
                id,
                linkedMapOf(
                    "protocolVersion" to MCP_PROTOCOL_VERSION,
                    "capabilities" to mapOf("tools" to mapOf("listChanged" to false)),
                    "serverInfo" to mapOf("name" to serverName, "version" to packageVersion()),
                ),
                extra = mapOf("Mcp-Session-Id" to assigned),
            )
        }

        "ping" -> rpcResult(id, emptyMap<String, Any?>())

        "tools/list" -> rpcResult(id, mapOf("tools" to ServedCatalog.toolList(rows)))

        "tools/call" -> callTool(message, id, principal)

        else -> rpcError(id, -32601, "unknown method \"$method\"")
    }

    @Suppress("UNCHECKED_CAST")
    private fun callTool(message: Map<String, Any?>, id: Any?, principal: McpPrincipal): LoopbackResponse {
        val params = message["params"] as? Map<String, Any?> ?: emptyMap()
        val name = params["name"] as? String
            ?: return rpcError(id, -32602, "tools/call needs a tool name")
        val arguments = (params["arguments"] as? Map<String, Any?>) ?: emptyMap()

        // The declared table is the whole allowlist. There is no dynamic
        // registration path, so an unknown name is unknown to an authenticated
        // caller exactly as it is to an unauthenticated one.
        val row = ServedCatalog.find(rows, name)
            ?: return rpcError(id, -32602, "no such tool", data = mapOf("code" to McpCodes.UNKNOWN_TOOL))

        if (row.requiresApproval) {
            val mutates = row.mutates ?: ""
            val decide = approver
                // Fail CLOSED. An app that ships served writes without wiring an
                // approver does not get a silent bypass; it gets a refusal it
                // will notice the first time it tests.
                ?: return rpcError(
                    id, -32000, "this tool writes and nothing can approve it",
                    data = mapOf("code" to McpCodes.APPROVAL_UNAVAILABLE),
                )
            val decision = try {
                decide.review(McpApprovalRequest(name, arguments, mutates, principal))
            } catch (_: Exception) {
                McpApprovalDecision.deny
            }
            if (decision != McpApprovalDecision.approve) {
                return rpcError(
                    id, -32000, "the write was not approved",
                    data = mapOf("code" to McpCodes.TOOL_DENIED),
                )
            }
            val capture = snapshotter
                ?: return rpcError(
                    id, -32000, "this tool writes and nothing can snapshot it",
                    data = mapOf("code" to McpCodes.SNAPSHOT_UNAVAILABLE),
                )
            // BEFORE the write, never after, and a failure here stops the write.
            try {
                capture.snapshot(mutates)
            } catch (e: Exception) {
                return rpcError(
                    id, -32000, e.message ?: "the snapshot failed",
                    data = mapOf("code" to McpCodes.SNAPSHOT_FAILED),
                )
            }
        }

        return try {
            val produced = dispatcher.call(name, arguments)
            rpcResult(id, toolResult(produced, isError = false))
        } catch (e: Exception) {
            // A tool that threw is a TOOL error, not a protocol error: the model
            // is supposed to see it and be able to react, which a JSON-RPC error
            // would deny it.
            rpcResult(id, toolResult(e.message ?: "the tool failed", isError = true))
        }
    }

    private fun toolResult(produced: Any?, isError: Boolean): Map<String, Any?> {
        val text = when (produced) {
            null -> ""
            is String -> produced
            else -> Json.encode(produced)
        }
        val out = linkedMapOf<String, Any?>(
            "content" to listOf(mapOf("type" to "text", "text" to text)),
        )
        if (produced is Map<*, *>) out["structuredContent"] = produced
        if (isError) out["isError"] = true
        return out
    }

    // --- envelopes -------------------------------------------------------

    private fun rpcResult(
        id: Any?,
        result: Any?,
        extra: Map<String, String> = emptyMap(),
    ): LoopbackResponse = LoopbackResponse.json(
        200,
        Json.encode(linkedMapOf("jsonrpc" to "2.0", "id" to id, "result" to result)),
        extra,
    )

    private fun rpcError(
        id: Any?,
        code: Int,
        message: String,
        data: Map<String, Any?>? = null,
        status: Int = 200,
    ): LoopbackResponse {
        val error = linkedMapOf<String, Any?>("code" to code, "message" to message)
        if (data != null) error["data"] = data
        return LoopbackResponse.json(
            status,
            Json.encode(linkedMapOf("jsonrpc" to "2.0", "id" to id, "error" to error)),
        )
    }

    // --- guards ----------------------------------------------------------

    /**
     * An absent Origin is fine - that is a non-browser client, and the token
     * governs it. A PRESENT Origin must be loopback, because the only thing
     * that sends one is a page, and the only page allowed to talk to this
     * server is one the app itself served from loopback.
     */
    private fun originIsLoopback(origin: String?): Boolean {
        val value = origin?.trim() ?: return true
        if (value.isEmpty() || value == "null") return true
        val withoutScheme = value.substringAfter("://", value)
        return authorityIsLoopback(withoutScheme)
    }

    /**
     * DNS rebinding, refused. A name that resolves to 127.0.0.1 still arrives
     * carrying its own Host header, and that is what this reads.
     */
    private fun hostIsLoopback(host: String?): Boolean {
        val value = host?.trim() ?: return true
        if (value.isEmpty()) return true
        return authorityIsLoopback(value)
    }

    private fun authorityIsLoopback(authority: String): Boolean {
        val trimmed = authority.trim().trimEnd('/')
        val hostPart = if (trimmed.startsWith("[")) {
            trimmed.substringBefore(']').removePrefix("[")
        } else {
            trimmed.substringBefore(':')
        }
        return when (hostPart.lowercase()) {
            LoopbackHosts.IPV4, LoopbackHosts.IPV6, "localhost" -> true
            else -> false
        }
    }

    private fun packageVersion(): String =
        DespiaMcpServer::class.java.`package`?.implementationVersion ?: "unknown"
}
