package despia.engine

import java.io.File
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED SYSTEM-BAR corpus (OpenSource/Conformance/systembars/bars.json) through THIS
 * runtime's SystemBars core — the Kotlin leg of Core/SystemBars (F17.5). The TS reference
 * (packages/kernel/test/systembars-conformance.test.ts) and the Swift twin
 * (Engine/iOS/SystemBars.swift) read the SAME file, so `immersive` cannot mean three different
 * things on three renderers.
 */
class SystemBarsConformanceTest {

    private val tolerance = 1e-6

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/systembars")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/systembars not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "bars.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("bars.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "systembars/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Suppress("UNCHECKED_CAST")
    private fun colorOf(v: Any?): SystemBars.Color {
        val m = v as Map<String, Any?>
        return SystemBars.Color(
            (m["r"] as Number).toInt(), (m["g"] as Number).toInt(),
            (m["b"] as Number).toInt(), (m["a"] as Number).toInt(),
        )
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun vocabularyAndThreshold() {
        val vocab = doc()["vocabulary"] as Map<String, Any?>
        assertEquals(strings(vocab["styles"]), SystemBars.STYLES)
        assertEquals(strings(vocab["behaviors"]), SystemBars.BEHAVIORS)
        assertEquals(strings(vocab["modes"]), SystemBars.MODES)
        assertEquals((vocab["lumaThreshold"] as Number).toDouble(), SystemBars.LUMA_THRESHOLD)
    }

    @TestFactory
    fun vocabulary(): List<DynamicTest> = rows("style", 10).map { c ->
        DynamicTest.dynamicTest("systembars/vocabulary — ${name(c)}") {
            val got = when (str(c["kind"])) {
                "style" -> SystemBars.foldStyle(c["raw"])
                "behavior" -> SystemBars.foldBehavior(c["raw"])
                "mode" -> SystemBars.foldMode(c["raw"])
                else -> error("no fold for ${str(c["kind"])}")
            }
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(str(c["expect"]), got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), SystemBars.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun color(): List<DynamicTest> = rows("color", 14).map { c ->
        DynamicTest.dynamicTest("systembars/color — ${name(c)}") {
            val got = SystemBars.parseColor(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(colorOf(c["expect"]), got.getOrThrow())
            } else {
                assertEquals(str(c["error"]), SystemBars.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun luma(): List<DynamicTest> = rows("luma", 6).map { c ->
        DynamicTest.dynamicTest("systembars/luma — ${name(c)}") {
            val color = SystemBars.parseColor(c["color"]).getOrThrow()
            val expected = (c["luma"] as Number).toDouble()
            assertTrue(
                abs(SystemBars.luma(color) - expected) <= tolerance,
                "${SystemBars.luma(color)} !~ $expected",
            )
            assertEquals(c["iconsDark"] == true, SystemBars.iconsDark(color, false), "iconsDark")
        }
    }

    @TestFactory
    fun transparentIcons(): List<DynamicTest> = rows("transparentIcons", 3).map { c ->
        DynamicTest.dynamicTest("systembars/transparentIcons — ${name(c)}") {
            val color = SystemBars.parseColor(c["color"]).getOrThrow()
            assertEquals(
                c["iconsDark"] == true,
                SystemBars.iconsDark(color, c["appearanceIsDark"] == true),
            )
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun plan(): List<DynamicTest> = rows("plan", 10).map { c ->
        DynamicTest.dynamicTest("systembars/plan — ${name(c)}") {
            val got = SystemBars.plan(c["raw"] as Map<String, Any?>)
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] != true) {
                assertEquals(str(c["error"]), SystemBars.code(got.exceptionOrNull()!!), "error")
                return@dynamicTest
            }
            val want = c["expect"] as Map<String, Any?>
            val plan = got.getOrThrow()
            assertEquals(want["visible"] == true, plan.visible, "visible")
            assertEquals(str(want["style"]), plan.style, "style")
            assertEquals(str(want["behavior"]), plan.behavior, "behavior")
            assertEquals(str(want["immersive"]), plan.immersive, "immersive")
            assertEquals(want["edgeToEdge"] == true, plan.edgeToEdge, "edgeToEdge")
            assertEquals(colorOf(want["color"]), plan.color, "color")
            assertEquals(colorOf(want["dividerColor"]), plan.dividerColor, "dividerColor")
            assertEquals(want["iconsDark"] == true, plan.iconsDark, "iconsDark")
            assertEquals(want["insetTop"] == true, plan.insetTop, "insetTop")
            assertEquals(want["insetBottom"] == true, plan.insetBottom, "insetBottom")
            assertEquals(want["hidesHomeIndicator"] == true, plan.hidesHomeIndicator, "hidesHomeIndicator")
            assertEquals(strings(want["diagnostics"]), plan.diagnostics, "diagnostics")
        }
    }
}
