package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The capture conformance runner - executes
 * OpenSource/Conformance/capture/{element,offscreen,secure}.json through THIS runtime
 * (parity/F11-capture.md). The TS twin is packages/kernel/test/capture-conformance.test.ts
 * and the Swift reference is Engine/iOS/CaptureCore.swift.
 *
 * Rasterising is platform work and is not pinned here. The arithmetic is: a card asked for
 * at 1200x630 must come out at 1200x630 on every renderer, and the 20000x20000 request has
 * to be refused BEFORE any allocation, which is the difference between an error and a crash.
 *
 * Missing corpus = loud failure.
 */
class CaptureConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/capture/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/capture/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(doc: Map<String, Any?>, key: String): List<Map<String, Any?>> {
        val list = doc[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.isNotEmpty(), "$key must not be empty")
        return list
    }

    @Suppress("UNCHECKED_CAST")
    private fun assertSize(got: CaptureCore.SizeResult, expect: Map<String, Any?>, label: String?) {
        val expectedError = expect["error"] as? String
        if (expectedError != null) {
            assertTrue(got is CaptureCore.SizeResult.Refused, "$label: expected a refusal, got $got")
            assertEquals(expectedError, (got as CaptureCore.SizeResult.Refused).code, label)
            return
        }
        assertTrue(got is CaptureCore.SizeResult.Value, "$label: expected a size, got $got")
        val size = got as CaptureCore.SizeResult.Value
        assertEquals((expect["width"] as Number).toInt(), size.width, "$label: width")
        assertEquals((expect["height"] as Number).toInt(), size.height, "$label: height")
    }

    // ── element.json ─────────────────────────────────────────────────────────────────────

    @Test
    @Suppress("UNCHECKED_CAST")
    fun budgetConstantAgreesWithCorpus() {
        val budget = corpus("element.json")["budget"] as Map<String, Any?>
        assertEquals((budget["maxPixels"] as Number).toLong(), CaptureCore.MAX_PIXELS)
    }

    @Test
    fun formatFoldAgreesWithCorpus() {
        for (case in rows(corpus("element.json"), "formats")) {
            val expect = case["expect"] as? String
            val got = CaptureCore.foldFormat(case["input"] as? String)
            if (expect == null) assertNull(got, case["name"] as? String) else assertEquals(expect, got, case["name"] as? String)
        }
    }

    @Test
    fun qualityIsClamped() {
        for (case in rows(corpus("element.json"), "quality")) {
            assertEquals((case["expect"] as Number).toDouble(),
                CaptureCore.quality(case["input"]), case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun scaleResolutionAgreesWithCorpus() {
        for (case in rows(corpus("element.json"), "scale")) {
            val name = case["name"] as? String
            val got = CaptureCore.resolveScale(case["input"], (case["deviceScale"] as Number).toDouble())
            val expect = case["expect"]
            if (expect is Map<*, *>) {
                assertTrue(got is CaptureCore.ScaleResult.Refused, "$name: expected a refusal, got $got")
                assertEquals(expect["error"], (got as CaptureCore.ScaleResult.Refused).code, name)
                continue
            }
            assertTrue(got is CaptureCore.ScaleResult.Value, "$name: expected a scale, got $got")
            assertEquals((expect as Number).toDouble(), (got as CaptureCore.ScaleResult.Value).scale, name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pointSizeBecomesThePinnedPixelSize() {
        for (case in rows(corpus("element.json"), "pixels")) {
            assertSize(CaptureCore.pixelSize((case["pointWidth"] as Number).toDouble(),
                                             (case["pointHeight"] as Number).toDouble(),
                                             (case["scale"] as Number).toDouble()),
                       case["expect"] as Map<String, Any?>, case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun elementInvariantsAreDeclared() {
        val invariants = corpus("element.json")["invariants"] as Map<String, Any?>
        for (key in listOf("transparentByDefault", "videoSurfaceIsNotBlack", "refIsSurfaceScoped",
                           "notRenderedIsDistinct", "screenIsOurWindow")) {
            val text = invariants[key] as? String
            assertTrue(text != null && text.length > 40, "element.json must declare the $key invariant")
        }
    }

    // ── offscreen.json ───────────────────────────────────────────────────────────────────

    @Test
    @Suppress("UNCHECKED_CAST")
    fun offscreenSizesComeOutExactlyAsAsked() {
        for (case in rows(corpus("offscreen.json"), "sizes")) {
            assertSize(CaptureCore.pixelSize((case["width"] as Number).toDouble(),
                                             (case["height"] as Number).toDouble(),
                                             (case["scale"] as Number).toDouble()),
                       case["expect"] as Map<String, Any?>, case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun offscreenInvariantsAreDeclared() {
        val invariants = corpus("offscreen.json")["invariants"] as Map<String, Any?>
        for (key in listOf("neverVisible", "sizeIsIndependentOfScreen", "oneLayoutPass", "disposal",
                           "sameComponentRegistry", "noSideEffects")) {
            val text = invariants[key] as? String
            assertTrue(text != null && text.length > 40, "offscreen.json must declare the $key invariant")
        }
    }

    // ── secure.json ──────────────────────────────────────────────────────────────────────

    @Test
    @Suppress("UNCHECKED_CAST")
    fun everyLiveSurfaceActionRefusesOnProtectedContent() {
        val refusing = sortedSetOf<String>()
        val allowed = sortedSetOf<String>()
        for (case in rows(corpus("secure.json"), "cases")) {
            val expect = case["expect"] as Map<String, Any?>
            if (case["protected"] != true) {
                assertEquals(true, expect["ok"], "${case["name"]}: an unprotected surface must capture")
                continue
            }
            if (expect["error"] == "secure_content") refusing.add(case["action"] as String)
            else allowed.add(case["action"] as String)
        }
        assertEquals(listOf("element", "pdf", "screen"), refusing.toList())
        assertEquals(listOf("offscreen"), allowed.toList())
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theRefusalTakesNoOverride() {
        val spec = corpus("secure.json")["notOverridable"] as Map<String, Any?>
        assertEquals("secure_content", spec["code"])
        assertEquals(false, spec["recoverable"])
        assertTrue((spec["forbiddenArgs"] as List<*>).size >= 4)
    }

    // ── the PDF geometry ─────────────────────────────────────────────────────────────────

    @Test
    fun namedPageBoxesAreOneSizeEverywhere() {
        assertEquals(CaptureCore.PageResult.Value(595.28, 841.89), CaptureCore.pageSize("a4"))
        assertEquals(CaptureCore.PageResult.Value(595.28, 841.89), CaptureCore.pageSize(null))
        assertEquals(CaptureCore.PageResult.Value(612.0, 792.0), CaptureCore.pageSize("Letter"))
        assertEquals(CaptureCore.PageResult.Value(612.0, 1008.0), CaptureCore.pageSize("legal"))
        assertEquals(CaptureCore.PageResult.Value(841.89, 595.28), CaptureCore.pageSize("a4/landscape"))
        assertEquals(CaptureCore.PageResult.Value(300.0, 400.0),
            CaptureCore.pageSize(mapOf("width" to 300, "height" to 400)))
        assertEquals(CaptureCore.PageResult.Refused("invalid_page_size"), CaptureCore.pageSize("a9"))
        assertEquals(CaptureCore.PageResult.Refused("invalid_page_size"),
            CaptureCore.pageSize(mapOf("width" to 0, "height" to 400)))
    }

    @Test
    fun marginsFillFromANumberOrAnObject() {
        assertEquals(CaptureCore.Margins(36.0, 36.0, 36.0, 36.0), CaptureCore.margins(null))
        assertEquals(CaptureCore.Margins(0.0, 0.0, 0.0, 0.0), CaptureCore.margins(0))
        assertEquals(CaptureCore.Margins(12.0, 12.0, 12.0, 12.0), CaptureCore.margins(12))
        assertEquals(CaptureCore.Margins(10.0, 36.0, 36.0, 36.0), CaptureCore.margins(mapOf("top" to 10)))
        assertEquals(CaptureCore.Margins(1.0, 2.0, 3.0, 4.0),
            CaptureCore.margins(mapOf("top" to 1, "right" to 2, "bottom" to 3, "left" to 4)))
        assertEquals(CaptureCore.Margins(36.0, 36.0, 36.0, 36.0), CaptureCore.margins(mapOf("top" to -5)))
    }
}
