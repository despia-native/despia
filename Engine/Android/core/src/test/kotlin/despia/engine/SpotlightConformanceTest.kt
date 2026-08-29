package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED SEARCH-INDEX corpus (OpenSource/Conformance/spotlight/index.json) through THIS
 * runtime's Spotlight core — the Kotlin leg of Core/Spotlight (F17.7). The TS reference
 * (packages/kernel/test/spotlight-conformance.test.ts) and the Swift twin
 * (Engine/iOS/Spotlight.swift) read the SAME file, so a tap on an indexed item resolves to the
 * same route on every platform.
 */
class SpotlightConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/spotlight")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/spotlight not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "index.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("index.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "spotlight/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun limits() {
        val limits = doc()["limits"] as Map<String, Any?>
        assertEquals((limits["batchMax"] as Number).toInt(), Spotlight.BATCH_MAX)
        assertEquals((limits["maxIdChars"] as Number).toInt(), Spotlight.MAX_ID_CHARS)
        assertEquals((limits["maxTitleChars"] as Number).toInt(), Spotlight.MAX_TITLE_CHARS)
        assertEquals((limits["maxDescriptionChars"] as Number).toInt(), Spotlight.MAX_DESCRIPTION_CHARS)
        assertEquals((limits["maxKeywords"] as Number).toInt(), Spotlight.MAX_KEYWORDS)
    }

    @TestFactory
    fun domain(): List<DynamicTest> = rows("domain", 5).map { c ->
        DynamicTest.dynamicTest("spotlight/domain — ${name(c)}") {
            val got = Spotlight.normalizeDomain(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(str(c["expect"]), got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), Spotlight.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun uniqueId(): List<DynamicTest> = rows("uniqueId", 3).map { c ->
        DynamicTest.dynamicTest("spotlight/uniqueId — ${name(c)}") {
            val encoded = Spotlight.uniqueId(str(c["domain"]), str(c["id"]))
            assertEquals(str(c["expect"]), encoded)
            // Every encode case is also a round trip: the encoding's only real contract.
            assertEquals(Pair(str(c["domain"]), str(c["id"])), Spotlight.parseUniqueId(encoded))
        }
    }

    @TestFactory
    fun parseUniqueId(): List<DynamicTest> = rows("parseUniqueId", 5).map { c ->
        DynamicTest.dynamicTest("spotlight/parseUniqueId — ${name(c)}") {
            val got = Spotlight.parseUniqueId(c["raw"])
            if (c["ok"] == true) {
                assertEquals(Pair(str(c["domain"]), str(c["id"])), got)
            } else {
                assertNull(got)
            }
        }
    }

    @TestFactory
    fun keywords(): List<DynamicTest> = rows("keywords", 5).map { c ->
        DynamicTest.dynamicTest("spotlight/keywords — ${name(c)}") {
            assertEquals(strings(c["expect"]), Spotlight.normalizeKeywords(c["raw"]))
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun item(): List<DynamicTest> = rows("item", 10).map { c ->
        DynamicTest.dynamicTest("spotlight/item — ${name(c)}") {
            val got = Spotlight.normalizeItem(c["raw"] as Map<String, Any?>)
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] != true) {
                assertEquals(str(c["error"]), Spotlight.code(got.exceptionOrNull()!!), "error")
                return@dynamicTest
            }
            val want = c["expect"] as Map<String, Any?>
            val item = got.getOrThrow()
            assertEquals(str(want["id"]), item.id, "id")
            assertEquals(str(want["title"]), item.title, "title")
            assertEquals(str(want["description"]), item.description, "description")
            assertEquals(strings(want["keywords"]), item.keywords, "keywords")
            assertEquals(str(want["image"]), item.image, "image")
            assertEquals(str(want["route"]), item.route, "route")
            assertEquals(str(want["domain"]), item.domain, "domain")
            assertEquals((want["expires"] as Number).toLong(), item.expires, "expires")
        }
    }

    @TestFactory
    fun batch(): List<DynamicTest> = rows("batch", 3).map { c ->
        DynamicTest.dynamicTest("spotlight/batch — ${name(c)}") {
            val got = Spotlight.normalizeItems(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals((c["count"] as Number).toInt(), got.getOrThrow().size, "count")
            } else {
                assertEquals(str(c["error"]), Spotlight.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun chunk(): List<DynamicTest> = rows("chunk", 5).map { c ->
        DynamicTest.dynamicTest("spotlight/chunk — ${name(c)}") {
            val items = (0 until (c["count"] as Number).toInt()).toList()
            val sizes = (c["sizes"] as List<Any?>).map { (it as Number).toInt() }
            assertEquals(sizes, Spotlight.chunk(items, (c["max"] as Number).toInt()).map { it.size })
        }
    }
}
