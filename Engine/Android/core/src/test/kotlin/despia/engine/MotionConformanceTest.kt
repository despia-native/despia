package despia.engine

import java.io.File
import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED UI MOTION corpus (OpenSource/Conformance/motion/
 * {curves,spring,retarget,physics}.json) through THIS runtime's motion kernel — the
 * Kotlin leg of ui-motion.md. The TS reference (packages/kernel/test/
 * motion-conformance.test.ts) and the Swift twin (record lane, MotionConformance) run the
 * SAME files, so `anim="spring"` can never again mean three different curves on the three
 * renderers. Expected numbers were computed by an independent scratch derivation, never
 * by any kernel under test.
 *
 * The Compose edge (:render StackMotion.kt) derives its AnimationSpec numbers from the
 * MotionSpec this test pins, so a green run here is a green run for the actual UI.
 */
class MotionConformanceTest {

    private val tolerance = 1.5e-6

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/motion")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/motion not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun load(file: String): Map<String, Any?> =
        json(File(corpusDir(), file).readText()).foundationValue as? Map<String, Any?>
            ?: error("$file: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(doc: Map<String, Any?>, key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "motion/$key is suspiciously small (${list.size})")
        return list
    }

    private fun num(v: Any?): Double = (v as Number).toDouble()
    private fun str(v: Any?): String? = v as? String

    private fun close(actual: Double, expected: Double, label: String) {
        assertTrue(abs(actual - expected) <= tolerance, "$label: $actual !~ $expected")
    }

    // ── curves.json ──────────────────────────────────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun curvesParse(): List<DynamicTest> {
        val doc = load("curves.json")
        return rows(doc, "parse", 15).map { c ->
            val name = str(c["name"]) ?: "?"
            DynamicTest.dynamicTest("motion/curves parse — $name") {
                val codes = mutableListOf<String>()
                val spec = Motion.parse(str(c["anim"]), str(c["animDuration"])) { code, _ -> codes.add(code) }
                val expect = c["expect"] as Map<String, Any?>
                assertEquals(str(expect["name"]), spec.name, "name")
                assertEquals(str(expect["kind"]), if (spec.isSpring) "spring" else "curve", "kind")
                close(spec.durationMs, num(expect["durationMs"]), "durationMs")
                close(Motion.settleMs(spec), num(expect["durationMs"]), "settleMs")
                if (spec.isSpring) {
                    close(spec.response, num(expect["response"]), "response")
                    close(spec.dampingFraction, num(expect["dampingFraction"]), "dampingFraction")
                } else {
                    close(spec.x1, num(expect["x1"]), "x1")
                    close(spec.y1, num(expect["y1"]), "y1")
                    close(spec.x2, num(expect["x2"]), "x2")
                    close(spec.y2, num(expect["y2"]), "y2")
                }
                val wanted = (c["diagnostics"] as List<Any?>).joinToString(",") { str(it) ?: "" }
                assertEquals(wanted, codes.joinToString(","), "diagnostics")
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun curvesPresets(): List<DynamicTest> {
        val presets = load("curves.json")["presets"] as Map<String, Map<String, Any?>>
        val table = mapOf(
            "keep" to Motion.PRESET_KEEP,
            "press" to Motion.PRESET_PRESS,
            "default" to Motion.PRESET_DEFAULT,
        )
        return presets.entries.map { (key, expect) ->
            DynamicTest.dynamicTest("motion/curves preset — $key") {
                val spec = table[key] ?: error("no preset for $key")
                assertEquals(str(expect["name"]), spec.name, "$key: name")
                assertEquals(str(expect["kind"]), if (spec.isSpring) "spring" else "curve", "$key: kind")
                close(spec.durationMs, num(expect["durationMs"]), "$key: durationMs")
                close(spec.x1, num(expect["x1"]), "$key: x1")
                close(spec.y1, num(expect["y1"]), "$key: y1")
                close(spec.x2, num(expect["x2"]), "$key: x2")
                close(spec.y2, num(expect["y2"]), "$key: y2")
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun curvesProgress(): List<DynamicTest> {
        val doc = load("curves.json")
        return rows(doc, "progress", 8).map { c ->
            val name = str(c["name"]) ?: "?"
            DynamicTest.dynamicTest("motion/curves progress — $name") {
                val spec = Motion.parse(str(c["anim"]), str(c["animDuration"]))
                close(spec.durationMs, num(c["durationMs"]), "durationMs")
                for (s in c["samples"] as List<Map<String, Any?>>) {
                    close(Motion.progress(spec, num(s["t"])), num(s["p"]), "p(${num(s["t"])})")
                }
            }
        }
    }

    // ── spring.json — the crux of the 1:1 claim ──────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun springConversion(): List<DynamicTest> {
        val doc = load("spring.json")
        return rows(doc, "conversion", 5).map { c ->
            val name = str(c["name"]) ?: "?"
            DynamicTest.dynamicTest("motion/spring conversion — $name") {
                val response = num(c["response"])
                val dampingFraction = num(c["dampingFraction"])
                val k = Motion.springConstants(response, dampingFraction)
                close(sqrt(k[0]), num(c["omega"]), "omega")
                close(k[0], num(c["stiffness"]), "stiffness")
                close(k[1], num(c["damping"]), "damping")
                close(k[1] / (2.0 * sqrt(k[0])), num(c["zeta"]), "zeta")
                // At the authored damping fraction (0.8 — the only one `anim=` reaches),
                // the parse must produce exactly these numbers and this settle time.
                if (dampingFraction == 0.8) {
                    val spec = Motion.parse("spring", response.toString())
                    assertTrue(spec.isSpring, "spring")
                    close(spec.stiffness, num(c["stiffness"]), "spec.stiffness")
                    close(spec.damping, num(c["damping"]), "spec.damping")
                    close(spec.durationMs, num(c["settleMs"]), "settleMs")
                }
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun springProgress(): List<DynamicTest> {
        val doc = load("spring.json")
        return rows(doc, "progress", 4).map { c ->
            val name = str(c["name"]) ?: "?"
            DynamicTest.dynamicTest("motion/spring progress — $name") {
                // Non-default damping fractions are not reachable through `anim=`; build
                // from the authoring plane so the corpus pins the whole family.
                val spec = Motion.spring(num(c["response"]), num(c["dampingFraction"]))
                close(Motion.settleMs(spec), num(c["settleMs"]), "settleMs")
                for (s in c["samples"] as List<Map<String, Any?>>) {
                    close(Motion.progress(spec, num(s["t"])), num(s["p"]), "p(${num(s["t"])})")
                }
            }
        }
    }

    // ── retarget.json — the interruption law ─────────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun retarget(): List<DynamicTest> {
        val doc = load("retarget.json")
        return rows(doc, "cases", 6).map { c ->
            val name = str(c["name"]) ?: "?"
            DynamicTest.dynamicTest("motion/retarget — $name") {
                val spec = Motion.parse(str(c["anim"]), str(c["animDuration"]))
                var state = Motion.start(num(c["from"]), num(c["to"]), 0.0)
                val events = (c["events"] as List<Map<String, Any?>>).sortedBy { num(it["at"]) }
                var next = 0
                for (s in c["samples"] as List<Map<String, Any?>>) {
                    val t = num(s["t"])
                    while (next < events.size && num(events[next]["at"]) <= t) {
                        state = Motion.retarget(spec, state, num(events[next]["to"]), num(events[next]["at"]))
                        next += 1
                    }
                    val got = Motion.value(spec, state, t)
                    close(got.value, num(s["value"]), "value($t)")
                    assertEquals(s["done"] as Boolean, got.done, "done($t)")
                }
            }
        }
    }

    // ── physics.json — the UI physics primitives ─────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun physics(): List<DynamicTest> {
        val doc = load("physics.json")
        val out = mutableListOf<DynamicTest>()

        val constants = doc["constants"] as Map<String, Any?>
        out.add(DynamicTest.dynamicTest("motion/physics — the pinned constants") {
            close(Motion.DECELERATION_RATE, num(constants["decelerationRate"]), "decelerationRate")
            close(Motion.DECAY_TAU_MS, num(constants["tauMs"]), "tauMs")
            close(Motion.DECAY_MIN_VELOCITY, num(constants["minVelocity"]), "minVelocity")
            close(Motion.RUBBER_BAND_C, num(constants["rubberBandC"]), "rubberBandC")
            assertTrue(Motion.RUBBER_BAND_RELEASE.isSpring, "the release spec is a spring")
            close(Motion.RUBBER_BAND_RELEASE.response, num(constants["releaseResponse"]), "releaseResponse")
            close(
                Motion.RUBBER_BAND_RELEASE.dampingFraction,
                num(constants["releaseDampingFraction"]), "releaseDampingFraction",
            )
        })

        for (c in rows(doc, "decay", 3)) {
            out.add(DynamicTest.dynamicTest("motion/physics decay — ${str(c["name"])}") {
                val x0 = num(c["x0"])
                val v0 = num(c["v0"])
                close(Motion.decayTarget(x0, v0), num(c["target"]), "target")
                close(Motion.decayDurationMs(v0), num(c["durationMs"]), "durationMs")
                for (s in c["samples"] as List<Map<String, Any?>>) {
                    close(Motion.decayAt(x0, v0, num(s["t"])), num(s["x"]), "x(${num(s["t"])})")
                }
            })
        }

        for (c in rows(doc, "rubberBand", 6)) {
            out.add(DynamicTest.dynamicTest("motion/physics rubberBand — ${str(c["name"])}") {
                val d = num(c["dimension"])
                val y = Motion.rubberBand(num(c["x"]), d)
                close(y, num(c["y"]), "y")
                close(Motion.rubberBandInverse(y, d), num(c["inverse"]), "inverse round trip")
            })
        }

        for (c in rows(doc, "snap", 6)) {
            out.add(DynamicTest.dynamicTest("motion/physics snap — ${str(c["name"])}") {
                val points = (c["points"] as List<Any?>).map { num(it) }
                val got = Motion.snapTarget(num(c["x0"]), num(c["v0"]), points)
                close(got.projected, num(c["projected"]), "projected")
                close(got.target, num(c["target"]), "target")
                assertEquals((num(c["index"])).toInt(), got.index, "index")
            })
        }

        return out
    }
}
