//
//  JsonTest.kt
//  DespiaScript
//
//  The Kotlin twin of JSON.swift, pinned test-by-test: literals, the fluent
//  builder, JSON.from, foundationValue, asJSON, and the static json(...) parser.
//

package despia.engine

import kotlin.test.*

class JsonTest {

    // MARK: - Literal constructors (the cross-runtime `JSON(...)` entry point)

    @Test fun mapLiteralConstructor() {
        // The api-mapping contract line, verbatim.
        val j = JSON(mapOf("count" to 2, "users" to listOf(JSON(mapOf("id" to 1)))))
        assertEquals(mapOf("count" to 2, "users" to listOf(mapOf("id" to 1))), j.foundationValue)
    }

    @Test fun listLiteralConstructor() {
        val j = JSON(listOf(1, "a", true, null))
        assertEquals(listOf(1, "a", true, null), j.foundationValue)
    }

    @Test fun mapLiteralTakesScalarsNestedJsonListsAndNull() {
        val j = JSON(mapOf(
            "s" to "hi",
            "i" to 7,
            "d" to 2.5,
            "b" to false,
            "nil" to null,
            "nested" to JSON(mapOf("id" to 1)),
            "list" to listOf(1, 2, 3),
        ))
        val fv = j.foundationValue as Map<*, *>
        assertEquals("hi", fv["s"])
        assertEquals(7, fv["i"])
        assertEquals(2.5, fv["d"])
        assertEquals(false, fv["b"])
        assertTrue(fv.containsKey("nil"))   // JSON null: key present, value null
        assertNull(fv["nil"])
        assertEquals(mapOf("id" to 1), fv["nested"])
        assertEquals(listOf(1, 2, 3), fv["list"])
    }

    // MARK: - The fluent builder (byte-identical spelling to Swift)

    @Test fun objBuilder() {
        val j = JSON.obj().put("count", 2).put("ok", true)
        assertEquals(mapOf("count" to 2, "ok" to true), j.foundationValue)
    }

    @Test fun objStartsEmpty() {
        assertEquals(emptyMap<String, Any?>(), JSON.obj().foundationValue)
    }

    @Test fun putIsImmutable() {
        val base = JSON.obj()
        val grown = base.put("a", 1)
        assertEquals(emptyMap<String, Any?>(), base.foundationValue)   // value semantics: receiver untouched
        assertEquals(mapOf("a" to 1), grown.foundationValue)
    }

    @Test fun putOverwritesExistingKey() {
        val j = JSON.obj().put("a", 1).put("a", 2)
        assertEquals(mapOf("a" to 2), j.foundationValue)
    }

    @Test fun putOnNonObjectStartsFreshObject() {
        // Swift: `.object([key: from(value)])` — the old scalar is discarded.
        val j = JSON.from("scalar").put("k", 1)
        assertEquals(mapOf("k" to 1), j.foundationValue)
    }

    @Test fun putNullStoresJsonNull() {
        val fv = JSON.obj().put("k", null).foundationValue as Map<*, *>
        assertTrue(fv.containsKey("k"))
        assertNull(fv["k"])
    }

    @Test fun putAcceptsNestedJsonAndLists() {
        val j = JSON.obj().put("user", JSON.obj().put("id", 1)).put("tags", listOf("a", "b"))
        assertEquals(mapOf("user" to mapOf("id" to 1), "tags" to listOf("a", "b")), j.foundationValue)
    }

    @Test fun arrBuilder() {
        assertEquals(listOf("track", "event"), JSON.arr("track", "event").foundationValue)
        assertEquals(emptyList<Any?>(), JSON.arr().foundationValue)
    }

    @Test fun arrItemsBecomeJsonViaFrom() {
        val j = JSON.arr(1, null, JSON.obj().put("x", 1), listOf(true))
        assertEquals(listOf(1, null, mapOf("x" to 1), listOf(true)), j.foundationValue)
    }

    @Test fun addChainsAndIsImmutable() {
        val base = JSON.arr()
        val grown = base.add(1).add("x").add(null)
        assertEquals(emptyList<Any?>(), base.foundationValue)
        assertEquals(listOf(1, "x", null), grown.foundationValue)
    }

    @Test fun addOnNonArrayStartsFreshArray() {
        val j = JSON.obj().put("a", 1).add(5)
        assertEquals(listOf(5), j.foundationValue)
    }

    // MARK: - JSON.from (the dynamic forwarder)

    @Test fun fromNull() = assertNull(JSON.from(null).foundationValue)

    @Test fun fromJsonPassesThroughSameInstance() {
        val j = JSON.obj().put("a", 1)
        assertSame(j, JSON.from(j))
    }

    @Test fun fromScalars() {
        assertEquals("hi", JSON.from("hi").foundationValue)
        assertEquals(42, JSON.from(42).foundationValue)
        assertEquals(true, JSON.from(true).foundationValue)
        assertEquals(false, JSON.from(false).foundationValue)
        assertEquals(9.99, JSON.from(9.99).foundationValue)
    }

    @Test fun fromBoolIsNotANumber() {
        // The CFBoolean check in Swift: true must never collapse to 1.
        assertNotEquals<Any?>(1, JSON.from(true).foundationValue)
        assertNotEquals<Any?>(JSON.from(1), JSON.from(true))
    }

    @Test fun fromWholeDoubleCollapsesToInt() {
        // Swift: NSNumber double 3.0 -> .int(3).
        assertEquals(3, JSON.from(3.0).foundationValue)
        assertEquals(-2, JSON.from(-2.0).foundationValue)
        assertEquals(0, JSON.from(-0.0).foundationValue)
        assertEquals(100, JSON.from(1e2).foundationValue)
    }

    @Test fun fromFractionalDoubleStaysDouble() {
        assertEquals(2.5, JSON.from(2.5).foundationValue)
        assertEquals(-9.99, JSON.from(-9.99).foundationValue)
    }

    @Test fun fromNanStaysDouble() {
        assertTrue((JSON.from(Double.NaN).foundationValue as Double).isNaN())
    }

    @Test fun fromIntegerWidths() {
        assertEquals(2, JSON.from(2L).foundationValue)                              // fits Int -> Int
        assertEquals(2147483648L, JSON.from(Int.MAX_VALUE.toLong() + 1).foundationValue)  // above -> Long
        assertEquals(1_000_000_000_000_000_000L, JSON.from(1e18).foundationValue)   // whole double, Long range
        assertEquals(1e20, JSON.from(1e20).foundationValue)                         // whole but beyond 64-bit: stays Double
        assertEquals(7, JSON.from(7.toShort()).foundationValue)
        assertEquals(7, JSON.from(7.toByte()).foundationValue)
        assertEquals(2.5, JSON.from(2.5f).foundationValue)
    }

    @Test fun fromListAndMap() {
        assertEquals(listOf(1, "a", null), JSON.from(listOf(1, "a", null)).foundationValue)
        assertEquals(mapOf("a" to 1, "b" to listOf(true)), JSON.from(mapOf("a" to 1, "b" to listOf(true))).foundationValue)
    }

    @Test fun fromNestedDynamicTree() {
        val native = mapOf("users" to listOf(mapOf("id" to 1, "name" to "a"), mapOf("id" to 2, "name" to null)))
        assertEquals(native, JSON.from(native).foundationValue)
    }

    @Test fun fromUnknownValueFallsBackToDescription() {
        class Blob { override fun toString() = "blob!" }
        assertEquals("blob!", JSON.from(Blob()).foundationValue)
    }

    @Test fun fromMapWithNonStringKeysFallsBackToDescription() {
        // Swift's `as [String: Any]` cast fails -> description string.
        assertEquals(mapOf(1 to "a").toString(), JSON.from(mapOf(1 to "a")).foundationValue)
    }

    // MARK: - foundationValue

    @Test fun foundationValueDeep() {
        val j = JSON.obj()
            .put("s", "héllo ✓ 🐘")
            .put("n", 5)
            .put("big", 5_000_000_000L)
            .put("d", 1.25)
            .put("b", true)
            .put("nil", null)
            .put("arr", JSON.arr(1, JSON.obj().put("deep", listOf("x"))))
        assertEquals(
            mapOf(
                "s" to "héllo ✓ 🐘",
                "n" to 5,
                "big" to 5_000_000_000L,
                "d" to 1.25,
                "b" to true,
                "nil" to null,
                "arr" to listOf(1, mapOf("deep" to listOf("x"))),
            ),
            j.foundationValue,
        )
    }

    @Test fun foundationValuePreservesInsertionOrder() {
        val fv = JSON.obj().put("z", 1).put("a", 2).put("m", 3).foundationValue as Map<*, *>
        assertEquals(listOf("z", "a", "m"), fv.keys.toList())
    }

    // MARK: - JSONConvertible / asJSON

    @Test fun jsonAsJsonIsItself() {
        val j = JSON.obj().put("a", 1)
        assertSame(j, j.asJSON)
    }

    @Test fun scalarAsJsonExtensions() {
        assertEquals("hi", "hi".asJSON.foundationValue)
        assertEquals(5, 5.asJSON.foundationValue)
        assertEquals(5_000_000_000L, 5_000_000_000L.asJSON.foundationValue)
        assertEquals(2.5, 2.5.asJSON.foundationValue)
        assertEquals(true, true.asJSON.foundationValue)
        assertEquals(listOf(1, "a"), listOf(1, "a").asJSON.foundationValue)
    }

    @Test fun optionalAsJsonCarriesThroughAsNull() {
        // Swift's `Optional: JSONConvertible` conformance -> nullable receivers.
        assertNull((null as String?).asJSON.foundationValue)
        assertNull((null as Int?).asJSON.foundationValue)
        assertNull((null as Boolean?).asJSON.foundationValue)
        assertNull((null as List<Any?>?).asJSON.foundationValue)
        assertNull((null as JSON?).asJSON.foundationValue)
    }

    @Test fun customJsonConvertible() {
        class Battery : JSONConvertible {
            override val asJSON: JSON get() = JSON.obj().put("percent", 80)
        }
        assertEquals(mapOf("percent" to 80), Battery().asJSON.foundationValue)
    }

    // MARK: - Equality (JVM structural equals; Swift exposes no ==)

    @Test fun structuralEquality() {
        val a = JSON(mapOf("count" to 2, "ok" to true))
        val b = JSON.obj().put("count", 2).put("ok", true)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        assertNotEquals(a, b.put("more", 1))
        assertEquals(JSON.from(null), JSON.from(null))
    }

    // MARK: - json(...) — the static-payload parser

    @Test fun parsesTheDocExample() {
        val j = json("""{ "sku": "gold", "value": 9.99 }""")
        assertEquals(mapOf("sku" to "gold", "value" to 9.99), j.foundationValue)
    }

    @Test fun parsesNestedStructures() {
        val j = json("""{"a":{"b":[1,{"c":null}]},"d":[[],{}],"e":true,"f":false}""")
        assertEquals(
            mapOf(
                "a" to mapOf("b" to listOf(1, mapOf("c" to null))),
                "d" to listOf(emptyList<Any?>(), emptyMap<String, Any?>()),
                "e" to true,
                "f" to false,
            ),
            j.foundationValue,
        )
    }

    @Test fun parsesFragments() {
        // JSONSerialization .allowFragments: top-level scalars are fine.
        assertEquals(5, json("5").foundationValue)
        assertEquals("hi", json("\"hi\"").foundationValue)
        assertEquals(true, json("true").foundationValue)
        assertEquals(false, json("false").foundationValue)
        assertNull(json(" null ").foundationValue)
    }

    @Test fun parsesNumbersLikeTheSwiftPipeline() {
        assertEquals(2, json("2.0").foundationValue)      // whole double -> int, as on Swift
        assertEquals(100, json("1e2").foundationValue)
        assertEquals(-3, json("-3").foundationValue)
        assertEquals(0, json("0").foundationValue)
        assertEquals(9.99, json("9.99").foundationValue)
        assertEquals(-0.5, json("-0.5").foundationValue)
        assertEquals(1.5e-3, json("1.5e-3").foundationValue)
        assertEquals(5_000_000_000L, json("5000000000").foundationValue)
        val huge = json("123456789012345678901234567890").foundationValue  // beyond 64-bit -> Double
        assertIs<Double>(huge)
        assertEquals("123456789012345678901234567890".toDouble(), huge)
    }

    @Test fun parsesStringEscapes() {
        assertEquals("\n", json("\"\\n\"").foundationValue)
        assertEquals("\t", json("\"\\t\"").foundationValue)
        assertEquals("\r", json("\"\\r\"").foundationValue)
        assertEquals("\b", json("\"\\b\"").foundationValue)
        assertEquals("\u000C", json("\"\\f\"").foundationValue)
        assertEquals("\"", json("\"\\\"\"").foundationValue)
        assertEquals("\\", json("\"\\\\\"").foundationValue)
        assertEquals("/", json("\"\\/\"").foundationValue)
        assertEquals("A", json("\"\\u0041\"").foundationValue)
        assertEquals("café", json("\"caf\\u00e9\"").foundationValue)
        assertEquals("😀", json("\"\\ud83d\\ude00\"").foundationValue)  // surrogate pair -> one emoji
    }

    @Test fun parsesLiteralUnicode() {
        assertEquals(mapOf("name" to "héllo ✓ 🐘"), json("""{"name":"héllo ✓ 🐘"}""").foundationValue)
    }

    @Test fun toleratesWhitespace() {
        assertEquals(mapOf("a" to listOf(1, 2)), json("  { \"a\" : [ 1 , 2 ] }\n\t").foundationValue)
    }

    @Test fun duplicateKeysLastWins() {
        assertEquals(mapOf("a" to 2), json("""{"a":1,"a":2}""").foundationValue)
    }

    @Test fun invalidJsonIsNull() {
        val bad = listOf(
            "", "   ",                       // nothing
            "{", "[1,]", "{\"a\":1,}",       // unterminated / trailing comma
            "{'a':1}", "{\"a\"}", "[1 2]",   // not-JSON punctuation
            "{} x", "5 5",                   // trailing garbage
            "01", "+5", "--1", "1.", ".5", "1e",  // malformed numbers
            "tru", "nul", "TRUE",            // malformed literals
            "\"open", "\"bad\\q\"", "\"a\nb\"",   // unterminated / bad escape / raw control char
        )
        for (text in bad) assertNull(json(text).foundationValue, "expected null for: $text")
    }

    @Test fun rejectsPathologicalNesting() {
        val deep = "[".repeat(600) + "1" + "]".repeat(600)
        assertNull(json(deep).foundationValue)
    }

    @Test fun roundTripsThroughDebugDescription() {
        val original = JSON.obj()
            .put("s", "quote \" slash \\ line\nunicode é 🐘")
            .put("n", 5)
            .put("d", 1.25)
            .put("b", false)
            .put("nil", null)
            .put("arr", JSON.arr(1, "two", JSON.obj().put("deep", true)))
        assertEquals(original, json(original.toString()))
    }
}
