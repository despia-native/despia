// SecurityGuardsTest - the three properties that make the local server safe.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// ContentServer's security-guard suite is the model: a small, separate file
// whose only job is that the properties a reviewer was promised are still true,
// so that a regression is a red gate rather than a review someone was tired for.
//
// It differs from that suite in one way, on purpose. ContentServer's guards are
// text assertions over Swift source, because Swift does not compile in that
// lane. These compile and run, so they assert BEHAVIOUR: a real bind, a real
// connect from a non-loopback address, a real HTTP exchange with a real
// credential, and a real file whose real mode is read back off the filesystem.
//
// THE THREE, and what a regression in each would mean:
//
//   1. THE BIND ADDRESS. A wildcard bind puts a phone's MCP server on the local
//      network, where every device on the café Wi-Fi can execute app behaviour.
//      Asserted by connecting from this machine's non-loopback address and
//      requiring the connection to be refused.
//   2. THE TOKEN CHECK. Loopback is reachable by every co-resident app; the
//      token is the only thing between them and the tools. Asserted by driving
//      a missing token, a wrong token, a prefix of the right token, a token in
//      a query string, and a token from a previous run - each of which must get
//      the same refusal, with nothing in the answer to tell them apart.
//   3. THE FILE MODE. A discovery file another user can read is the pairing
//      token, published. Asserted by reading the POSIX mode back after a write.
//
// Each is written so that weakening the thing it guards makes it fail. That was
// verified by weakening each one and watching it go red before it was committed.

package com.despia.mcp

import java.io.BufferedReader
import java.io.StringReader
import java.io.StringWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.Collections
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SecurityGuardsTest {

    private var server: DespiaMcpServer? = null

    @AfterTest
    fun stopServer() {
        server?.stop()
        server = null
    }

    private fun start(): Pair<DespiaMcpServer, Int> {
        val recorder = Recorder()
        val started = DespiaMcpServer(
            rows = Rows.all,
            dispatcher = recorder.dispatcher,
            approver = recorder.approver,
            snapshotter = recorder.snapshotter,
            home = temporaryHome(),
        )
        server = started
        return started to started.start()
    }

    // --- 1. the bind address ---------------------------------------------

    @Test
    fun `the server binds loopback literals and no other address`() {
        val (instance, port) = start()

        assertTrue(port in 1..65_535, "the OS picked no port")
        val allowed = setOf(
            InetAddress.getByName(LoopbackHosts.IPV4).hostAddress,
            InetAddress.getByName(LoopbackHosts.IPV6).hostAddress,
        )
        assertTrue(instance.boundAddresses.isNotEmpty(), "nothing was bound")
        for (address in instance.boundAddresses) {
            assertTrue(address in allowed, "$address is not a loopback literal")
        }
    }

    @Test
    fun `the server is not reachable from this machine's own network address`() {
        val (_, port) = start()
        val external = nonLoopbackAddresses()
        assertTrue(
            external.isNotEmpty(),
            "this machine has no non-loopback address, so the guard cannot prove anything - " +
                "run it somewhere with a network interface rather than trusting it here",
        )

        for (address in external) {
            val reachable = runCatching {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(address, port), 1_500)
                    socket.isConnected
                }
            }.getOrDefault(false)
            assertFalse(
                reachable,
                "the server answered on ${address.hostAddress}:$port - a non-loopback bind puts " +
                    "this device's tools on the local network",
            )
        }
    }

    private fun nonLoopbackAddresses(): List<InetAddress> =
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { runCatching { it.isUp }.getOrDefault(false) }
            .flatMap { Collections.list(it.inetAddresses) }
            .filter { !it.isLoopbackAddress && !it.isAnyLocalAddress && !it.isLinkLocalAddress }

    // --- 2. the token check ----------------------------------------------

    @Test
    fun `every wrong way to present a token gets the same refusal`() {
        val (instance, port) = start()
        val real = instance.sessionToken!!
        val call = rpc(1, "tools/call", mapOf("name" to "notes.search", "arguments" to mapOf("q" to "x")))

        val refusals = listOf(
            "missing" to RawClient.post(port, call, token = null),
            "empty" to RawClient.post(port, call, token = ""),
            "wrong" to RawClient.post(port, call, token = LoopbackTokens.mint()),
            "prefix" to RawClient.post(port, call, token = real.dropLast(1)),
            "extended" to RawClient.post(port, call, token = real + "x"),
            "case-shifted" to RawClient.post(port, call, token = real.uppercase() + "="),
        )

        for ((name, reply) in refusals) {
            assertEquals(401, reply.status, "$name was not refused")
            // Byte-identical answers. Anything that differed between them would
            // be an oracle a co-resident app can query as fast as it likes.
            assertEquals("", reply.body, "$name leaked a body")
            assertEquals("Bearer", reply.headers["www-authenticate"], "$name answered differently")
        }

        // And the real one still works, so the guard is not passing by refusing
        // everything.
        assertEquals(200, RawClient.post(port, call, token = real).status)
    }

    @Test
    fun `a token in the query string authenticates nothing`() {
        val (instance, port) = start()
        val real = instance.sessionToken!!
        val call = rpc(2, "ping")

        val viaQuery = RawClient.post(
            port,
            call,
            token = null,
            path = "$MCP_ENDPOINT_PATH?token=$real&access_token=$real",
        )

        assertEquals(401, viaQuery.status, "a token in a URL was accepted - URLs land in logs")
        assertEquals(200, RawClient.post(port, call, token = real).status)
    }

    @Test
    fun `a token from a previous run does not work after a restart`() {
        val (instance, port) = start()
        val old = instance.sessionToken!!
        assertEquals(200, RawClient.post(port, rpc(3, "ping"), old).status)

        instance.stop()
        val (restarted, second) = start()

        assertNotEquals(old, restarted.sessionToken)
        assertEquals(401, RawClient.post(second, rpc(4, "ping"), old).status)
    }

    @Test
    fun `the session token and the pairing token are never the same value`() {
        val (instance, port) = start()
        instance.grantExternalConsent(true)

        val session = instance.sessionToken!!
        val pairing = instance.pairingToken!!
        assertNotEquals(session, pairing)

        // Both work while consent stands; they are separate credentials, not a
        // second copy of one.
        assertEquals(200, RawClient.post(port, rpc(5, "ping"), session).status)
        assertEquals(200, RawClient.post(port, rpc(6, "ping"), pairing).status)
    }

    // --- 3. the file mode -------------------------------------------------

    @Test
    fun `the discovery file is owner-only and so is the directory holding it`() {
        val (instance, _) = start()
        instance.grantExternalConsent(true)

        val discovery = instance.discovery
        assertTrue(discovery.exists(), "consent was granted and no discovery file was written")
        assertEquals("0600", discovery.mode(), "the discovery file is not owner-only")
        assertEquals("0700", discovery.mode(discovery.directory), "the container directory is not owner-only")
        assertEquals("0700", discovery.mode(discovery.launcher), "the launcher is not owner-only")
    }

    @Test
    fun `the discovery file carries the port and the pairing token, not the session token`() {
        val (instance, port) = start()
        instance.grantExternalConsent(true)

        val record = instance.discovery.read()
        assertNotNull(record)
        assertEquals(port.toLong(), (record["port"] as Number).toLong())
        assertEquals(MCP_PROTOCOL_VERSION, record["protocol"])
        assertEquals(instance.pairingToken, record["token"])
        assertNotEquals(instance.sessionToken, record["token"])
    }

    @Test
    fun `withdrawing consent removes the file and rotates the token behind it`() {
        val (instance, port) = start()
        instance.grantExternalConsent(true)
        val cached = instance.pairingToken!!
        assertEquals(200, RawClient.post(port, rpc(7, "ping"), cached).status)

        instance.grantExternalConsent(false)

        assertFalse(instance.discovery.exists(), "the discovery file survived a withdrawal")
        assertNull(instance.pairingToken)
        // The part that matters: a host that kept the value is refused, rather
        // than merely inconvenienced by a missing file it already read.
        assertEquals(401, RawClient.post(port, rpc(8, "ping"), cached).status)
        assertEquals(200, RawClient.post(port, rpc(9, "ping"), instance.sessionToken).status)
    }

    @Test
    fun `the launcher script carries no credential`() {
        val (instance, _) = start()
        instance.grantExternalConsent(true)

        val script = instance.discovery.launcher.readText()
        assertFalse(script.contains(instance.pairingToken!!), "the launcher embeds the pairing token")
        assertFalse(script.contains(instance.sessionToken!!), "the launcher embeds the session token")
        // It names the file instead, which is the whole point of the indirection.
        assertTrue(script.contains(instance.discovery.file.absolutePath))
    }

    @Test
    fun `the stdio bridge reaches the server through the discovery file alone`() {
        val (instance, _) = start()
        instance.grantExternalConsent(true)

        val output = StringWriter()
        val code = McpStdioBridge.run(
            instance.discovery.file,
            BufferedReader(StringReader(rpc(10, "tools/list") + "\n")),
            output,
        )

        assertEquals(0, code)
        val answer = Json.decodeObject(output.toString().trim())
        @Suppress("UNCHECKED_CAST")
        val result = answer["result"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val tools = result["tools"] as List<Map<String, Any?>>
        assertEquals(listOf("notes.search", "notes.add"), tools.map { it["name"] })
    }

    @Test
    fun `the stdio bridge stops working the moment consent is withdrawn`() {
        val (instance, _) = start()
        instance.grantExternalConsent(true)
        val file = instance.discovery.file
        instance.grantExternalConsent(false)

        val output = StringWriter()
        val code = McpStdioBridge.run(
            file,
            BufferedReader(StringReader(rpc(11, "tools/list") + "\n")),
            output,
        )

        assertEquals(1, code, "the bridge kept working after consent was withdrawn")
        assertEquals("", output.toString())
    }
}
