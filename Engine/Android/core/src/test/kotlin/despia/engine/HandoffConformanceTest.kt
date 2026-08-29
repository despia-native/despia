package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED CONTINUITY corpus (OpenSource/Conformance/handoff/activity.json) through THIS
 * runtime's Handoff core — the Kotlin leg of Core/Handoff (F17.8). The TS reference
 * (packages/kernel/test/handoff-conformance.test.ts) and the Swift twin
 * (Engine/iOS/Handoff.swift) read the SAME file, so the payload ceiling is the same number of
 * the same bytes everywhere. Android advertises nothing, but validating against the same
 * grammar is what makes a payload built here one the iPhone will actually advertise.
 */
class HandoffConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/handoff")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/handoff not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "activity.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("activity.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "handoff/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun limits() {
        val limits = doc()["limits"] as Map<String, Any?>
        assertEquals((limits["maxPayloadBytes"] as Number).toInt(), Handoff.MAX_PAYLOAD_BYTES)
        assertEquals((limits["maxTitleChars"] as Number).toInt(), Handoff.MAX_TITLE_CHARS)
    }

    @TestFactory
    fun activityType(): List<DynamicTest> = rows("activityType", 9).map { c ->
        DynamicTest.dynamicTest("handoff/activityType — ${name(c)}") {
            val got = Handoff.normalizeActivityType(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(str(c["expect"]), got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), Handoff.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun url(): List<DynamicTest> = rows("url", 6).map { c ->
        DynamicTest.dynamicTest("handoff/url — ${name(c)}") {
            val got = Handoff.normalizeUrl(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(str(c["expect"]), got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), Handoff.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun canonical(): List<DynamicTest> = rows("canonical", 12).map { c ->
        DynamicTest.dynamicTest("handoff/canonical — ${name(c)}") {
            val got = Handoff.canonicalJson(c["payload"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] != true) {
                assertEquals(str(c["error"]), Handoff.code(got.exceptionOrNull()!!), "error")
                return@dynamicTest
            }
            val text = got.getOrThrow()
            assertEquals(str(c["text"]), text, "canonical text")
            val bytes = (c["bytes"] as Number).toInt()
            assertEquals(bytes, Handoff.utf8ByteLength(text), "utf-8 bytes")
            assertEquals(bytes, Handoff.payloadBytes(c["payload"]).getOrThrow(), "payloadBytes")
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun activity(): List<DynamicTest> = rows("activity", 6).map { c ->
        DynamicTest.dynamicTest("handoff/activity — ${name(c)}") {
            val got = Handoff.normalize(c["raw"] as Map<String, Any?>)
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] != true) {
                assertEquals(str(c["error"]), Handoff.code(got.exceptionOrNull()!!), "error")
                return@dynamicTest
            }
            val want = c["expect"] as Map<String, Any?>
            val value = got.getOrThrow()
            assertEquals(str(want["activity"]), value.activity, "activity")
            assertEquals(str(want["title"]), value.title, "title")
            assertEquals(str(want["url"]), value.url, "url")
            assertEquals((want["payloadBytes"] as Number).toInt(), value.payloadBytes, "payloadBytes")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun oversizeIsRefusedWithBothNumbers() {
        val spec = doc()["oversize"] as Map<String, Any?>
        val blob = str(spec["filler"]).repeat((spec["repeat"] as Number).toInt())
        val payload = mapOf(str(spec["key"]) to blob)
        val bytes = Handoff.payloadBytes(payload).getOrThrow()
        assertTrue(
            bytes > Handoff.MAX_PAYLOAD_BYTES,
            "the corpus filler must actually exceed the ceiling ($bytes)",
        )
        val got = Handoff.normalize(mapOf("activity" to "com.example.viewing", "payload" to payload))
        assertTrue(got.isFailure, "an oversized payload is refused")
        assertEquals(str(spec["error"]), Handoff.code(got.exceptionOrNull()!!), "error")
    }

    @Test
    fun exactCeilingIsInclusive() {
        // `{"blob":"…"}` is 11 characters of envelope around the value.
        val envelope = Handoff.utf8ByteLength("{\"blob\":\"\"}")
        val blob = "a".repeat(Handoff.MAX_PAYLOAD_BYTES - envelope)
        val got = Handoff.normalize(
            mapOf("activity" to "com.example.viewing", "payload" to mapOf("blob" to blob)),
        )
        assertTrue(got.isSuccess, "the exact ceiling is inclusive")
        assertEquals(Handoff.MAX_PAYLOAD_BYTES, got.getOrThrow().payloadBytes)
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun continuation(): List<DynamicTest> = rows("continuation", 3).map { c ->
        DynamicTest.dynamicTest("handoff/continuation — ${name(c)}") {
            val got = Handoff.parseContinuation(c["raw"] as Map<String, Any?>)
            assertTrue(got.isSuccess, "a continuation is normalised, not refused")
            val want = c["expect"] as Map<String, Any?>
            val value = got.getOrThrow()
            assertEquals(str(want["activity"]), value.activity, "activity")
            assertEquals(str(want["title"]), value.title, "title")
            assertEquals(str(want["url"]), value.url, "url")
            assertEquals((want["payloadBytes"] as Number).toInt(), value.payloadBytes, "payloadBytes")
        }
    }
}
