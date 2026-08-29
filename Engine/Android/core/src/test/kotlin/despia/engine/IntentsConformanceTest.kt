package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED INTENT corpus (OpenSource/Conformance/intents/launch.json) through THIS runtime's
 * Intents core — the Kotlin leg of Core/Intents (F17.6), and the platform the capability
 * actually runs on. The TS reference (packages/kernel/test/intents-conformance.test.ts) and the
 * Swift twin (Engine/iOS/Intents.swift) read the SAME file, so the refusals a cross-platform
 * caller sees are identical and the generated <queries> block cannot drift from the code that
 * needs it.
 */
class IntentsConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/intents")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/intents not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "launch.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("launch.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "intents/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun flagValuesAndOrder() {
        val d = doc()
        val values = d["flagValues"] as Map<String, Any?>
        assertEquals(values.size, Intents.FLAGS.size, "flag count")
        for ((word, value) in values) {
            assertEquals((value as Number).toInt(), Intents.FLAGS[word], "flag $word")
        }
        assertEquals(strings(d["flagOrder"]), Intents.FLAG_ORDER, "flagOrder")
    }

    private fun stringCases(
        key: String, minimum: Int, fn: (Any?) -> Result<String>,
    ): List<DynamicTest> = rows(key, minimum).map { c ->
        DynamicTest.dynamicTest("intents/$key — ${name(c)}") {
            val got = fn(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(str(c["expect"]), got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), Intents.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun action(): List<DynamicTest> = stringCases("action", 8) { Intents.normalizeAction(it) }

    @TestFactory
    fun packageName(): List<DynamicTest> = stringCases("package", 3) { Intents.normalizePackage(it) }

    @TestFactory
    fun data(): List<DynamicTest> = stringCases("data", 6) { Intents.normalizeData(it) }

    @TestFactory
    fun type(): List<DynamicTest> = stringCases("type", 6) { Intents.normalizeType(it) }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun extras(): List<DynamicTest> = rows("extras", 5).map { c ->
        DynamicTest.dynamicTest("intents/extras — ${name(c)}") {
            val got = Intents.normalizeExtras(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(c["expect"] as Map<String, Any?>, got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), Intents.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun flags(): List<DynamicTest> = rows("flags", 6).map { c ->
        DynamicTest.dynamicTest("intents/flags — ${name(c)}") {
            val got = Intents.foldFlags(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals((c["mask"] as Number).toInt(), got.getOrThrow().mask, "mask")
                assertEquals(strings(c["words"]), got.getOrThrow().words, "words")
            } else {
                assertEquals(str(c["error"]), Intents.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun intent(): List<DynamicTest> = rows("intent", 6).map { c ->
        DynamicTest.dynamicTest("intents/intent — ${name(c)}") {
            val got = Intents.normalize(c["raw"] as Map<String, Any?>)
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] != true) {
                assertEquals(str(c["error"]), Intents.code(got.exceptionOrNull()!!), "error")
                return@dynamicTest
            }
            val want = c["expect"] as Map<String, Any?>
            val spec = got.getOrThrow()
            assertEquals(str(want["action"]), spec.action, "action")
            assertEquals(str(want["package"]), spec.pkg, "package")
            assertEquals(str(want["data"]), spec.data, "data")
            assertEquals(str(want["type"]), spec.type, "type")
            assertEquals(strings(want["categories"]), spec.categories, "categories")
            assertEquals(want["extras"] as Map<String, Any?>, spec.extras, "extras")
            val wantFlags = want["flags"] as Map<String, Any?>
            assertEquals((wantFlags["mask"] as Number).toInt(), spec.flags.mask, "flags.mask")
            assertEquals(strings(wantFlags["words"]), spec.flags.words, "flags.words")
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun queries(): List<DynamicTest> = rows("queries", 5).map { c ->
        DynamicTest.dynamicTest("intents/queries — ${name(c)}") {
            val specs = (c["specs"] as List<Map<String, Any?>>).map { row ->
                Intents.normalize(
                    mapOf(
                        "action" to row["action"], "data" to row["data"],
                        "type" to row["type"], "package" to row["package"],
                    ),
                ).getOrElse { error("corpus spec must normalize: ${row["action"]}") }
            }
            val want = (c["expect"] as List<Map<String, Any?>>).map { row ->
                Intents.Query(
                    str(row["kind"]), str(row["action"]), str(row["scheme"]),
                    str(row["mimeType"]), str(row["name"]),
                )
            }
            assertEquals(want, Intents.queries(specs))
        }
    }
}
