package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED AMBIENT-LIGHT corpus (OpenSource/Conformance/light/ambient.json) through THIS
 * runtime's LightSensor core — the Kotlin leg of Core/LightSensor (F17.9), and the platform the
 * capability actually runs on. The TS reference
 * (packages/kernel/test/lightsensor-conformance.test.ts) and the Swift twin
 * (Engine/iOS/LightSensor.swift) read the SAME file, so "dark room" means the same number of lux
 * on every renderer and the stream costs the same battery.
 */
class LightSensorConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/light")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/light not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "ambient.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("ambient.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "light/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun bandsAndThresholds() {
        val d = doc()
        val limits = d["limits"] as Map<String, Any?>
        assertEquals((limits["minIntervalMs"] as Number).toInt(), LightSensor.MIN_INTERVAL_MS)
        assertEquals((limits["defaultIntervalMs"] as Number).toInt(), LightSensor.DEFAULT_INTERVAL_MS)
        assertEquals((limits["maxIntervalMs"] as Number).toInt(), LightSensor.MAX_INTERVAL_MS)
        assertEquals((limits["minAbsoluteChange"] as Number).toDouble(), LightSensor.MIN_ABSOLUTE_CHANGE)
        assertEquals((limits["minRelativeChange"] as Number).toDouble(), LightSensor.MIN_RELATIVE_CHANGE)
        assertEquals(strings(d["categories"]), LightSensor.CATEGORIES)
        assertEquals(
            (d["thresholds"] as List<Any?>).map { (it as Number).toDouble() },
            LightSensor.THRESHOLDS,
        )
    }

    @TestFactory
    fun category(): List<DynamicTest> = rows("category", 12).map { c ->
        DynamicTest.dynamicTest("light/category — ${name(c)}") {
            assertEquals(str(c["expect"]), LightSensor.category(c["lux"]))
        }
    }

    @TestFactory
    fun interval(): List<DynamicTest> = rows("interval", 6).map { c ->
        DynamicTest.dynamicTest("light/interval — ${name(c)}") {
            assertEquals((c["expect"] as Number).toInt(), LightSensor.clampInterval(c["raw"]))
        }
    }

    @TestFactory
    fun emit(): List<DynamicTest> = rows("emit", 10).map { c ->
        DynamicTest.dynamicTest("light/emit — ${name(c)}") {
            val previous = (c["previous"] as? Number)?.toDouble()
            assertEquals(c["expect"] == true, LightSensor.shouldEmit(previous, c["next"]))
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun sample(): List<DynamicTest> = rows("sample", 4).map { c ->
        DynamicTest.dynamicTest("light/sample — ${name(c)}") {
            val want = c["expect"] as Map<String, Any?>
            val got = LightSensor.sample(c["lux"])
            assertEquals((want["lux"] as Number).toDouble(), got.lux, "lux")
            assertEquals(str(want["category"]), got.category, "category")
        }
    }
}
