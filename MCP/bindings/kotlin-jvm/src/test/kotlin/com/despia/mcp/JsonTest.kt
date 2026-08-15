// JsonTest - the codec, including the inputs it must refuse.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// What is asserted here is not "JSON works". It is the four properties this
// transport actually depends on: an integer id survives a round trip, nesting
// is bounded, the lenient dialects are refused, and a string cannot smuggle a
// raw control character into a value that later lands in a log line.

package com.despia.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class JsonTest {

    @Test
    fun `an object round-trips with its key order intact`() {
        val value = linkedMapOf<String, Any?>(
            "jsonrpc" to "2.0",
            "id" to 7L,
            "params" to linkedMapOf<String, Any?>("name" to "notes.add", "arguments" to mapOf("text" to "hi")),
        )
        val text = Json.encode(value)

        assertEquals("""{"jsonrpc":"2.0","id":7,"params":{"name":"notes.add","arguments":{"text":"hi"}}}""", text)
        assertEquals(value, Json.decode(text))
    }

    @Test
    fun `an integer id stays an integer`() {
        // JSON-RPC puts request ids in this field, and widening them to Double
        // would silently round the large ones.
        val decoded = Json.decodeObject("""{"id":9007199254740993}""")

        assertEquals(9007199254740993L, decoded["id"])
        assertEquals("""{"id":9007199254740993}""", Json.encode(decoded))
    }

    @Test
    fun `the value vocabulary decodes to plain Kotlin types`() {
        val decoded = Json.decodeObject(
            """{"s":"x","i":3,"d":1.5,"b":true,"n":null,"a":[1,"two",false]}""",
        )

        assertEquals("x", decoded["s"])
        assertEquals(3L, decoded["i"])
        assertEquals(1.5, decoded["d"])
        assertEquals(true, decoded["b"])
        assertNull(decoded["n"])
        assertEquals(listOf(1L, "two", false), decoded["a"])
    }

    @Test
    fun `nesting past the cap is refused rather than overflowing the stack`() {
        val deep = "[".repeat(Json.MAXIMUM_DEPTH + 8) + "]".repeat(Json.MAXIMUM_DEPTH + 8)

        assertFailsWith<Json.MalformedException> { Json.decode(deep) }
    }

    @Test
    fun `the lenient dialects are refused`() {
        val refused = listOf(
            "{'key': 1}",              // single quotes
            "{key: 1}",                // unquoted key
            """{"a":1,}""",            // trailing comma
            """{"a":1} // note""",     // a comment
            """{"a":NaN}""",           // not a number
            """{"a":1""",              // truncated
            """{"a":1}{"b":2}""",      // two documents
        )

        for (text in refused) {
            assertFailsWith<Json.MalformedException>("accepted ${text.take(24)}") { Json.decode(text) }
        }
    }

    @Test
    fun `a raw control character inside a string is refused and an escaped one is not`() {
        assertFailsWith<Json.MalformedException> { Json.decode("\"a\nb\"") }
        assertEquals("a\nb", Json.decode("\"a\\nb\""))
    }

    @Test
    fun `encoding escapes what a log line would otherwise inherit`() {
        val text = Json.encode(mapOf("message" to "line\nnext\ttab\u0007bell\"quote"))

        assertTrue(text.contains("\\n"))
        assertTrue(text.contains("\\t"))
        assertTrue(text.contains("\\u0007"))
        assertTrue(text.contains("\\\""))
    }

    @Test
    fun `a value with no JSON form is refused rather than silently changed`() {
        assertFailsWith<Json.MalformedException> { Json.encode(Double.NaN) }
        assertFailsWith<Json.MalformedException> { Json.encode(Double.POSITIVE_INFINITY) }
        assertFailsWith<Json.MalformedException> { Json.encode(Object()) }
    }

    @Test
    fun `a duplicated key keeps one value, and it is the last`() {
        val decoded = Json.decodeObject("""{"token":"first","token":"second"}""")

        assertEquals(1, decoded.size)
        assertEquals("second", decoded["token"])
    }
}
