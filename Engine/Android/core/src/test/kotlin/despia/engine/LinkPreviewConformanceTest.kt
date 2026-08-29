package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED LINK-PREVIEW corpus (OpenSource/Conformance/preview/metadata.json) through THIS
 * runtime's LinkPreview core — the Kotlin leg of Core/Preview (F17.1). The TS reference
 * (packages/kernel/test/linkpreview-conformance.test.ts) and the Swift twin
 * (Engine/iOS/LinkPreview.swift) read the SAME file, so `og:image` cannot resolve to three
 * different URLs on three renderers.
 */
class LinkPreviewConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/preview")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/preview not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "metadata.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("metadata.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "preview/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    private fun targetOf(raw: String): LinkPreview.Target =
        LinkPreview.resolveTarget(raw).getOrElse { error("corpus base is not a valid URL: $raw") }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun budget() {
        val b = doc()["budget"] as Map<String, Any?>
        assertEquals((b["maxBytes"] as Number).toInt(), LinkPreview.MAX_BYTES, "maxBytes")
        assertEquals((b["maxRedirects"] as Number).toInt(), LinkPreview.MAX_REDIRECTS, "maxRedirects")
        assertEquals((b["defaultTimeoutMs"] as Number).toInt(), LinkPreview.DEFAULT_TIMEOUT_MS, "defaultTimeoutMs")
        assertEquals((b["minTimeoutMs"] as Number).toInt(), LinkPreview.MIN_TIMEOUT_MS, "minTimeoutMs")
        assertEquals((b["maxTimeoutMs"] as Number).toInt(), LinkPreview.MAX_TIMEOUT_MS, "maxTimeoutMs")
    }

    @TestFactory
    fun timeout(): List<DynamicTest> = rows("timeout", 6).map { c ->
        DynamicTest.dynamicTest("preview/timeout — ${name(c)}") {
            assertEquals((c["expect"] as Number).toInt(), LinkPreview.clampTimeout(c["raw"]))
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun url(): List<DynamicTest> = rows("url", 18).map { c ->
        DynamicTest.dynamicTest("preview/url — ${name(c)}") {
            val got = LinkPreview.resolveTarget(c["raw"])
            val expectOk = c["ok"] == true
            assertEquals(expectOk, got.isSuccess, "ok")
            if (expectOk) {
                val want = c["value"] as Map<String, Any?>
                val t = got.getOrThrow()
                assertEquals(str(want["url"]), t.url, "url")
                assertEquals(str(want["origin"]), t.origin, "origin")
                assertEquals(str(want["host"]), t.host, "host")
                assertEquals(str(want["scheme"]), t.scheme, "scheme")
                assertEquals(str(want["path"]), t.path, "path")
            } else {
                assertEquals(str(c["error"]), LinkPreview.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun reference(): List<DynamicTest> = rows("reference", 14).map { c ->
        DynamicTest.dynamicTest("preview/reference — ${name(c)}") {
            assertEquals(str(c["expect"]), LinkPreview.resolveReference(targetOf(str(c["base"])), c["ref"]))
        }
    }

    @TestFactory
    fun entities(): List<DynamicTest> = rows("entities", 6).map { c ->
        DynamicTest.dynamicTest("preview/entities — ${name(c)}") {
            assertEquals(str(c["expect"]), LinkPreview.decodeEntities(str(c["raw"])))
        }
    }

    @TestFactory
    fun collapse(): List<DynamicTest> = rows("collapse", 3).map { c ->
        DynamicTest.dynamicTest("preview/collapse — ${name(c)}") {
            assertEquals(str(c["expect"]), LinkPreview.collapseText(str(c["raw"])))
        }
    }

    @TestFactory
    fun siteFallback(): List<DynamicTest> = rows("siteFallback", 3).map { c ->
        DynamicTest.dynamicTest("preview/siteFallback — ${name(c)}") {
            assertEquals(str(c["expect"]), LinkPreview.siteFallback(str(c["host"])))
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun parse(): List<DynamicTest> = rows("parse", 14).map { c ->
        DynamicTest.dynamicTest("preview/parse — ${name(c)}") {
            val got = LinkPreview.parse(str(c["html"]), targetOf(str(c["requestUrl"])))
            val want = c["expect"] as Map<String, Any?>
            assertEquals(str(want["title"]), got.title, "title")
            assertEquals(str(want["description"]), got.description, "description")
            assertEquals(str(want["image"]), got.image, "image")
            assertEquals(str(want["siteName"]), got.siteName, "siteName")
            assertEquals(str(want["favicon"]), got.favicon, "favicon")
            assertEquals(str(want["type"]), got.type, "type")
            assertEquals(str(want["canonical"]), got.canonical, "canonical")
        }
    }
}
