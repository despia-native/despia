// ServedRowsTest - the derived tool list, pinned to the fixture it comes from.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The expected payload here is the one in the corpus case "served tools are
// derived from declared rows, not written by hand"
// (Conformance/ai/mcp/mcp.json). Written out as data rather than parsed from the
// file on purpose: this face carries no JSON parser, and a parser written for a
// test is a second thing to keep honest.

package com.despia.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ServedRowsTest {

    private val rows = listOf(
        ServedRow(
            action = "notes.search",
            description = "Search the user's notes.",
            args = mapOf("q" to ArgSpec("string", required = true)),
        ),
        ServedRow(
            action = "notes.add",
            description = "Add a note.",
            args = mapOf("text" to ArgSpec("string", required = true)),
            mutates = "base",
        ),
    )

    @Test
    fun `the tool list matches the fixture exactly`() {
        assertEquals(
            listOf(
                mapOf(
                    "name" to "notes.search",
                    "description" to "Search the user's notes.",
                    "inputSchema" to mapOf(
                        "type" to "object",
                        "properties" to mapOf("q" to mapOf("type" to "string")),
                        "required" to listOf("q"),
                    ),
                ),
                mapOf(
                    "name" to "notes.add",
                    "description" to "Add a note.",
                    "inputSchema" to mapOf(
                        "type" to "object",
                        "properties" to mapOf("text" to mapOf("type" to "string")),
                        "required" to listOf("text"),
                    ),
                    "mutates" to "base",
                ),
            ),
            ServedCatalog.toolList(rows),
        )
    }

    @Test
    fun `required is absent when nothing is required`() {
        val schema = ServedCatalog.deriveSchema(mapOf("q" to ArgSpec("string")))

        // An empty `required: []` says the same thing, but the fixtures pin the
        // terser form and matching them exactly costs nothing.
        assertEquals(setOf("type", "properties"), schema.keys)
        assertEquals(mapOf("q" to mapOf("type" to "string")), schema["properties"])
    }

    @Test
    fun `a row with no arguments still derives an object schema`() {
        val schema = ServedCatalog.deriveSchema(emptyMap())

        assertEquals("object", schema["type"])
        assertEquals(emptyMap<String, Any?>(), schema["properties"])
        assertNull(schema["required"])
    }

    @Test
    fun `argument order is declaration order`() {
        val schema = ServedCatalog.deriveSchema(
            linkedMapOf(
                "z" to ArgSpec("string", required = true),
                "a" to ArgSpec("integer"),
                "m" to ArgSpec("boolean", required = true),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val properties = schema["properties"] as Map<String, Any?>
        assertEquals(listOf("z", "a", "m"), properties.keys.toList())
        assertEquals(listOf("z", "m"), schema["required"])
    }

    @Test
    fun `a mutating row is approval-gated and says so in the list`() {
        assertTrue(rows[1].requiresApproval)
        assertFalse(rows[0].requiresApproval)
        // An empty string is not a declaration of anything.
        assertFalse(ServedRow("notes.ping", "Ping.", mutates = "").requiresApproval)

        val list = ServedCatalog.toolList(rows)
        assertFalse(list[0].containsKey("mutates"))
        assertEquals("base", list[1]["mutates"])
    }

    @Test
    fun `lookup is by the declared action name`() {
        assertEquals(rows[1], ServedCatalog.find(rows, "notes.add"))
        assertNull(ServedCatalog.find(rows, "notes.delete"))
    }
}
