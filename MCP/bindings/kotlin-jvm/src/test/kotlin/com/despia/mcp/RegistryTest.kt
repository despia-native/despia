// RegistryTest - the namespacing law, asserted.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The cases here mirror two fixtures from the shared corpus
// (Conformance/ai/mcp/mcp.json): "discovered tools join the registry namespaced
// by server" and "a server that is down removes only its own tools". The corpus
// runs against the host harnesses; this runs against the real registry, which is
// the code an app actually links.

package com.despia.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RegistryTest {

    private val notesSearch = DiscoveredTool(
        name = "search",
        description = "Search notes.",
        inputSchema = mapOf(
            "type" to "object",
            "properties" to mapOf("q" to mapOf("type" to "string")),
            "required" to listOf("q"),
        ),
    )

    private val docsSearch = DiscoveredTool(
        name = "search",
        description = "Search docs.",
        inputSchema = mapOf(
            "type" to "object",
            "properties" to mapOf(
                "query" to mapOf("type" to "string"),
                "top_k" to mapOf("type" to "integer"),
            ),
        ),
    )

    @Test
    fun `two servers offering the same tool name produce two tools`() {
        val registry = ToolRegistry()
        registry.register("notes", listOf(notesSearch))
        registry.register("docs", listOf(docsSearch))

        assertEquals(listOf("mcp.notes.search", "mcp.docs.search"), registry.names())

        val notes = registry.definition("mcp.notes.search")!!
        val docs = registry.definition("mcp.docs.search")!!
        assertEquals("Search notes.", notes.description)
        assertEquals("Search docs.", docs.description)
    }

    @Test
    fun `a foreign schema is carried through verbatim`() {
        val registry = ToolRegistry()
        registry.register("docs", listOf(docsSearch))

        // Not re-derived, not narrowed, not reordered: the same document the
        // server advertised, because anything else loses what it accepts.
        assertEquals(docsSearch.inputSchema, registry.definition("mcp.docs.search")!!.parameters)
    }

    @Test
    fun `every entry carries the server it came from`() {
        val registry = ToolRegistry()
        registry.register("notes", listOf(notesSearch))

        val definition = registry.definition("mcp.notes.search")!!
        assertEquals("mcp", definition.source)
        assertEquals("notes", definition.server)
        // A description is untrusted text, so it stays labelled with its origin.
        assertEquals("mcp:notes", definition.provenance)
    }

    @Test
    fun `dropping one server leaves every other server untouched`() {
        val registry = ToolRegistry()
        registry.register("notes", listOf(notesSearch))
        registry.register("remote", listOf(DiscoveredTool("fetch", "Fetch.", mapOf("type" to "object"))))

        registry.remove("remote")

        assertEquals(listOf("mcp.notes.search"), registry.names())
        assertEquals(listOf("notes"), registry.serversWithTools())
        assertNull(registry.definition("mcp.remote.fetch"))
    }

    @Test
    fun `re-registering a server replaces its rows rather than merging them`() {
        val registry = ToolRegistry()
        registry.register("notes", listOf(notesSearch, DiscoveredTool("add", "Add.", mapOf("type" to "object"))))
        registry.register("notes", listOf(notesSearch))

        // A tool the server dropped between two connects must not linger.
        assertEquals(listOf("mcp.notes.search"), registry.names())
    }

    @Test
    fun `a namespaced name splits back into its server and its tool`() {
        val registry = ToolRegistry()

        assertEquals("notes" to "search", registry.split("mcp.notes.search"))
        // A tool name may contain dots; only the first segment is the server.
        assertEquals("notes" to "a.b", registry.split("mcp.notes.a.b"))
        assertNull(registry.split("notes.search"))
        assertNull(registry.split("mcp.notes"))
        assertNull(registry.split("mcp..search"))
        assertNull(registry.split("mcp.notes."))
    }

    @Test
    fun `registration order is the order the model sees`() {
        val registry = ToolRegistry()
        registry.register("notes", listOf(notesSearch, DiscoveredTool("add", "Add.", mapOf("type" to "object"))))
        registry.register("docs", listOf(docsSearch))

        assertEquals(
            listOf("mcp.notes.search", "mcp.notes.add", "mcp.docs.search"),
            registry.definitions().map { it.name },
        )
    }

    @Test
    fun `clear empties both tables`() {
        val registry = ToolRegistry()
        registry.register("notes", listOf(notesSearch))
        registry.clear()

        assertTrue(registry.names().isEmpty())
        assertTrue(registry.serversWithTools().isEmpty())
    }
}
