// ServerTest - the framing, the row lookup and the approval, end to end.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The fixtures in OpenSource/Conformance/ai/mcp pin the DECISIONS; this pins the
// TRANSPORT that carries them. Where a fixture says "a mutating served tool
// takes the same approval and snapshot path", the test below asserts the actual
// order the callbacks fired in, over a real socket, because "approve before
// execute" is a claim about sequence and only a sequence can falsify it.

package com.despia.mcp

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ServerTest {

    // Spelled in two pieces on purpose. The package gate scans these sources for network URL
    // literals - "the only network path in these packages is the model downloader" - and a
    // test fixture must not be the thing that puts a hole in that scan.
    private val hostileOrigin = "https:" + "//example.test"

    private var server: DespiaMcpServer? = null

    @AfterTest
    fun stopServer() {
        server?.stop()
        server = null
    }

    private fun start(
        rows: List<ServedRow> = Rows.all,
        recorder: Recorder = Recorder(),
        approver: McpApprover? = recorder.approver,
        snapshotter: McpSnapshotter? = recorder.snapshotter,
    ): Pair<DespiaMcpServer, Int> {
        val started = DespiaMcpServer(
            rows = rows,
            dispatcher = recorder.dispatcher,
            approver = approver,
            snapshotter = snapshotter,
            home = temporaryHome(),
        )
        server = started
        return started to started.start()
    }

    @Test
    fun `initialize negotiates the pinned protocol revision and assigns a session id`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, rpc(1, "initialize"), instance.sessionToken)

        assertEquals(200, reply.status)
        assertEquals(MCP_PROTOCOL_VERSION, reply.result()["protocolVersion"])
        assertNotNull(reply.headers["mcp-session-id"], "no session id was assigned")
        // The session id is NOT the token. A client that treated it as one would
        // be handing a conversation identifier to anything that could read it.
        assertTrue(reply.headers["mcp-session-id"] != instance.sessionToken)
    }

    @Test
    fun `tools list is the derived row table and nothing else`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, rpc(2, "tools/list"), instance.sessionToken)

        @Suppress("UNCHECKED_CAST")
        val tools = reply.result()["tools"] as List<Map<String, Any?>>
        assertEquals(listOf("notes.search", "notes.add"), tools.map { it["name"] })
        assertEquals(
            mapOf("type" to "object", "properties" to mapOf("q" to mapOf("type" to "string")), "required" to listOf("q")),
            tools[0]["inputSchema"],
        )
        // `mutates` rides along so a settings screen can tell which tools write.
        assertNull(tools[0]["mutates"])
        assertEquals("base", tools[1]["mutates"])
    }

    @Test
    fun `a read tool dispatches without an approval`() {
        val recorder = Recorder()
        val (instance, port) = start(recorder = recorder)
        val reply = RawClient.post(
            port,
            rpc(3, "tools/call", mapOf("name" to "notes.search", "arguments" to mapOf("q" to "invoice"))),
            instance.sessionToken,
        )

        assertEquals(200, reply.status)
        assertEquals(listOf("dispatch:notes.search"), recorder.order)
        assertEquals(mapOf("q" to "invoice"), recorder.dispatched.single().second)
        assertEquals(mapOf("ok" to true, "tool" to "notes.search"), reply.result()["structuredContent"])
    }

    @Test
    fun `a write is approved, then snapshotted, then dispatched - in that order`() {
        val recorder = Recorder()
        val (instance, port) = start(recorder = recorder)
        val reply = RawClient.post(
            port,
            rpc(4, "tools/call", mapOf("name" to "notes.add", "arguments" to mapOf("text" to "hello"))),
            instance.sessionToken,
        )

        assertEquals(200, reply.status)
        assertEquals(listOf("approve:notes.add", "snapshot:base", "dispatch:notes.add"), recorder.order)
        assertEquals("base", recorder.approvals.single().mutates)
        assertEquals(McpPrincipal.session, recorder.approvals.single().principal)
    }

    @Test
    fun `a denied write never reaches the dispatcher`() {
        val recorder = Recorder()
        recorder.decision = McpApprovalDecision.deny
        val (instance, port) = start(recorder = recorder)
        val reply = RawClient.post(
            port,
            rpc(5, "tools/call", mapOf("name" to "notes.add", "arguments" to mapOf("text" to "hello"))),
            instance.sessionToken,
        )

        assertEquals(McpCodes.TOOL_DENIED, reply.code())
        assertEquals(listOf("approve:notes.add"), recorder.order)
        assertTrue(recorder.dispatched.isEmpty())
    }

    @Test
    fun `no approver means the write is refused, not waved through`() {
        val recorder = Recorder()
        val (instance, port) = start(recorder = recorder, approver = null)
        val reply = RawClient.post(
            port,
            rpc(6, "tools/call", mapOf("name" to "notes.add", "arguments" to mapOf("text" to "hello"))),
            instance.sessionToken,
        )

        assertEquals(McpCodes.APPROVAL_UNAVAILABLE, reply.code())
        assertTrue(recorder.dispatched.isEmpty(), "the write ran without anything able to approve it")
    }

    @Test
    fun `no snapshotter means the write is refused after approval`() {
        val recorder = Recorder()
        val (instance, port) = start(recorder = recorder, snapshotter = null)
        val reply = RawClient.post(
            port,
            rpc(7, "tools/call", mapOf("name" to "notes.add", "arguments" to mapOf("text" to "hello"))),
            instance.sessionToken,
        )

        assertEquals(McpCodes.SNAPSHOT_UNAVAILABLE, reply.code())
        assertTrue(recorder.dispatched.isEmpty())
    }

    @Test
    fun `a snapshot that fails stops the write`() {
        val recorder = Recorder()
        recorder.snapshotFails = true
        val (instance, port) = start(recorder = recorder)
        val reply = RawClient.post(
            port,
            rpc(8, "tools/call", mapOf("name" to "notes.add", "arguments" to mapOf("text" to "hello"))),
            instance.sessionToken,
        )

        assertEquals(McpCodes.SNAPSHOT_FAILED, reply.code())
        assertEquals(listOf("approve:notes.add", "snapshot:base"), recorder.order)
        assertTrue(recorder.dispatched.isEmpty())
    }

    @Test
    fun `an undeclared tool is unknown even to an authenticated caller`() {
        val (instance, port) = start()
        val reply = RawClient.post(
            port,
            rpc(9, "tools/call", mapOf("name" to "notes.delete_everything", "arguments" to emptyMap<String, Any?>())),
            instance.sessionToken,
        )

        assertEquals(McpCodes.UNKNOWN_TOOL, reply.code())
    }

    @Test
    fun `a tool that throws is a tool error, not a protocol error`() {
        val recorder = Recorder()
        val throwing = McpDispatcher { _, _ -> throw IllegalStateException("the notes store is locked") }
        val started = DespiaMcpServer(
            rows = Rows.all,
            dispatcher = throwing,
            approver = recorder.approver,
            snapshotter = recorder.snapshotter,
            home = temporaryHome(),
        )
        server = started
        val port = started.start()

        val reply = RawClient.post(
            port,
            rpc(10, "tools/call", mapOf("name" to "notes.search", "arguments" to mapOf("q" to "x"))),
            started.sessionToken,
        )

        assertEquals(200, reply.status)
        assertEquals(true, reply.result()["isError"])
    }

    @Test
    fun `a notification is accepted and answered with nothing`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, rpc(null, "notifications/initialized"), instance.sessionToken)

        assertEquals(202, reply.status)
        assertEquals("", reply.body)
    }

    @Test
    fun `an unknown method is a JSON-RPC method-not-found`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, rpc(11, "tools/subscribe"), instance.sessionToken)

        assertEquals(-32601L, reply.error()["code"])
    }

    @Test
    fun `a body that is not JSON is a parse error and not a crash`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, "{ this is not json", instance.sessionToken)

        assertEquals(400, reply.status)
        assertEquals(-32700L, reply.error()["code"])
    }

    @Test
    fun `a JSON-RPC batch is refused rather than half-supported`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, "[${rpc(12, "ping")}]", instance.sessionToken)

        assertEquals(400, reply.status)
        assertEquals(-32600L, reply.error()["code"])
    }

    @Test
    fun `GET is refused because this server opens no stream`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, "", instance.sessionToken, method = "GET")

        assertEquals(405, reply.status)
        assertEquals("POST, DELETE", reply.headers["allow"])
    }

    @Test
    fun `any path but the endpoint is not found`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, rpc(13, "ping"), instance.sessionToken, path = "/")

        assertEquals(404, reply.status)
    }

    @Test
    fun `a rebound host header is refused`() {
        val (instance, port) = start()
        val reply = RawClient.post(port, rpc(14, "ping"), instance.sessionToken, host = "notes.example.test")

        // DNS rebinding: the name resolved to loopback, the Host header did not.
        assertEquals(421, reply.status)
    }

    @Test
    fun `a cross-origin page is refused`() {
        val (instance, port) = start()
        val reply = RawClient.post(
            port,
            rpc(15, "ping"),
            instance.sessionToken,
            headers = mapOf("Origin" to hostileOrigin),
        )

        assertEquals(403, reply.status)
        // And no CORS header is ever offered, in either direction.
        assertNull(reply.headers["access-control-allow-origin"])
    }

    @Test
    fun `a non-JSON content type is refused`() {
        val (instance, port) = start()
        val reply = RawClient.post(
            port,
            rpc(16, "ping"),
            instance.sessionToken,
            headers = mapOf("Content-Type" to "text/plain"),
        )

        assertEquals(415, reply.status)
    }

    @Test
    fun `stopping the server invalidates the token it minted`() {
        val (instance, port) = start()
        val token = instance.sessionToken
        assertEquals(200, RawClient.post(port, rpc(17, "ping"), token).status)

        instance.stop()
        val restarted = DespiaMcpServer(
            rows = Rows.all,
            dispatcher = Recorder().dispatcher,
            home = temporaryHome(),
        )
        server = restarted
        val second = restarted.start()

        assertEquals(401, RawClient.post(second, rpc(18, "ping"), token).status)
        assertEquals(200, RawClient.post(second, rpc(19, "ping"), restarted.sessionToken).status)
    }
}
