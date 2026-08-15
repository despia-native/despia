// JniStringTest.kt - text survives the crossing, in both directions.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// JNI's own string calls speak MODIFIED UTF-8; the C ABI speaks standard UTF-8.
// They agree on everything up to U+FFFF and disagree about exactly the
// characters a language model emits all day: an emoji is one four-byte sequence
// on one side and a pair of three-byte surrogate halves on the other. Handing a
// four-byte sequence to NewStringUTF is not a slow path, it is undefined - the
// string comes back corrupted on one runtime and the process aborts under
// checked JNI on another.
//
// So the round trip is driven rather than assumed: the text goes DOWN through
// the model document (Kotlin -> UTF-8 -> the engine's JSON parser -> the mock
// script) and comes BACK up through the event stream (the engine's JSON dump ->
// UTF-8 -> Kotlin). A character that is wrong in either direction fails here,
// and the case is deterministic - the mock backend, no weights - so it holds in
// CI rather than only on a machine with a model on it.

package com.despia.ai

import kotlin.test.Test
import kotlin.test.fail

class JniStringTest {

    /** Written as code points so the case says which characters it is about
     *  rather than depending on how a file happens to be encoded. */
    private val astral = String(Character.toChars(0x1F642))          // 4-byte UTF-8
    private val subject =
        "caf\u00e9 " +                    // 2-byte: a Latin-1 letter
        "\u6f22\u5b57 " +                 // 3-byte: two CJK ideographs
        "$astral " +                      // 4-byte: outside the BMP
        "\u20ac\u00a0" +                  // a currency sign and a no-break space
        "\"quoted\" \\ back\tslash"       // and the characters JSON escapes

    private fun scriptFor(text: String): Json = jsonOf(
        "id" to Json.Str("m1"),
        "engine" to Json.Str("mock"),
        "format" to Json.Str("mock"),
        "mock" to jsonOf(
            "script" to Json.Arr(
                listOf(
                    jsonOf("token" to Json.Str(text)),
                    jsonOf("complete" to Json.Obj(emptyMap())),
                ),
            ),
        ),
    )

    @Test
    fun `text crosses the seam unchanged in both directions`() {
        Engine().use { engine ->
            engine.loadModel(scriptFor(subject))
            val events = engine.drain(Json.parse("""{"kind":"completion","model":"m1"}"""))

            val token = events.firstOrNull { it["event"].string() == "token" }
                ?: fail("no token event arrived: " + events.joinToString(",") { it["event"].string() })
            val delta = token["data"]["delta"]["text"].string()
            val snapshot = events.last()["data"]["snapshot"][0]["text"].string()

            println("[jni strings] round trip: ${delta.length} chars, ${delta.codePointCount(0, delta.length)} code points")
            if (delta != subject) {
                fail(
                    "the token text changed crossing the seam:\n" +
                        "  sent " + subject.codePoints().toArray().joinToString(",") { "%04x".format(it) } + "\n" +
                        "  back " + delta.codePoints().toArray().joinToString(",") { "%04x".format(it) },
                )
            }
            if (snapshot != subject) fail("the terminal snapshot text is $snapshot")
            if (delta.contains('\uFFFD')) fail("the round trip introduced a replacement character")
        }
    }

    @Test
    fun `an astral character survives on its own`() {
        // The single case NewStringUTF cannot express. Kept separate so that a
        // regression names itself instead of hiding inside the mixed string.
        Engine().use { engine ->
            engine.loadModel(scriptFor(astral))
            val events = engine.drain(Json.parse("""{"kind":"completion","model":"m1"}"""))
            val delta = events.first { it["event"].string() == "token" }["data"]["delta"]["text"].string()
            println("[jni strings] astral round trip: ${delta.codePoints().toArray().joinToString(",") { "%04x".format(it) }}")
            if (delta != astral) fail("an astral character did not survive: got '$delta'")
            if (delta.length != 2) fail("expected a surrogate pair, got ${delta.length} units")
        }
    }
}
