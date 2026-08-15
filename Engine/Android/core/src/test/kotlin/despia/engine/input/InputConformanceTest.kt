package despia.engine.input

import despia.engine.JSE
import despia.engine.json
import java.io.File
import kotlin.math.sqrt
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED G4 unified-input corpus (OpenSource/Conformance/input/
 * {mappings,axis,attenuation}.json) through THIS runtime's input kernel — the Kotlin leg of
 * dsx-game.md §2 G4. The TS reference (packages/kernel/test/input-conformance.test.ts) and
 * the Swift twin (InputConformance, record lane) run the SAME files, so the mapping table,
 * the axis math, the edge law and the audio attenuation curve cannot drift by a decimal.
 * Expected numbers were computed by an independent scratch implementation, never by any
 * kernel under test.
 *
 * Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
 */
class InputConformanceTest {

    private val tolerance = 1.5e-6

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    private fun num(v: Any?): Double = (v as Number).toDouble()

    private fun close(actual: Double, expected: Double, label: String) {
        assertTrue(kotlin.math.abs(actual - expected) <= tolerance, "$label: $actual !~ $expected")
    }

    @Suppress("UNCHECKED_CAST")
    private fun declarations(raw: Any?): List<Map<String, String?>> =
        (raw as List<Map<String, Any?>>).map { row -> row.mapValues { (_, v) -> v as? String } }

    // ── mappings.json ───────────────────────────────────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun mappingCasesAgreeWithCorpus(): List<DynamicTest> {
        val root = doc("mappings.json")
        val cases = root["cases"] as List<Map<String, Any?>>
        assertTrue(cases.size >= 30, "mappings.json: suspiciously small (${cases.size})")
        return cases.map { case ->
            val name = case["name"] as? String ?: "?"
            DynamicTest.dynamicTest("input-mappings/$name") {
                val got = SceneInput.resolveDeclarations(declarations(case["declarations"]))
                val want = case["bindings"] as List<Map<String, Any?>>
                assertEquals(want.size, got.bindings.size, "$name: binding count")
                want.forEachIndexed { i, expected ->
                    val have = got.bindings[i]
                    assertEquals(expected["name"], have.name, "$name[$i]: name")
                    assertEquals(expected["axis"], have.axis, "$name[$i]: axis")
                    close(have.deadzone, num(expected["deadzone"]), "$name[$i]: deadzone")
                    assertEquals(expected["keys"], have.keys, "$name[$i]: keys")
                    assertEquals(expected["buttons"], have.buttons, "$name[$i]: buttons")
                    assertEquals(expected["sticks"], have.sticks, "$name[$i]: sticks")
                    assertEquals(expected["touch"], have.touch, "$name[$i]: touch")
                }
                assertEquals(case["diagnostics"], got.diagnostics.map { it.code }, "$name: diagnostics")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun diagnosticCodesAreExactlyTheDeclaredSet() {
        val root = doc("mappings.json")
        val declared = (root["diagnosticCodes"] as List<String>).toSet()
        val seen = mutableSetOf<String>()
        for (case in root["cases"] as List<Map<String, Any?>>) {
            seen.addAll(case["diagnostics"] as List<String>)
        }
        for (code in seen) assertTrue(code in declared, "undeclared diagnostic code $code")
        for (code in declared) assertTrue(code in seen, "declared code $code is never exercised")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun dsxInputFoldsToTheGlobalInputPlane() {
        for (row in doc("mappings.json")["scope"] as List<Map<String, Any?>>) {
            assertEquals(row["resolved"], JSE.normalizeScope(row["path"] as String), "scope ${row["path"]}")
        }
    }

    @Test
    fun kernelConstantsAgreeWithTheCorpusLaw() {
        assertEquals(0.15, INPUT_DEFAULT_DEADZONE)
        assertEquals(listOf("W", "A", "S", "D"), SceneInput.KEY_SETS["wasd"])
        assertEquals(listOf("ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"), SceneInput.KEY_SETS["arrows"])
        assertEquals(listOf("Z", "Q", "S", "D"), SceneInput.KEY_SETS["zqsd"])
        assertEquals(listOf("I", "J", "K", "L"), SceneInput.KEY_SETS["ijkl"])
        assertEquals(0 to 1, SceneInput.PAD_STICKS["leftStick"])
        assertEquals(2 to 3, SceneInput.PAD_STICKS["rightStick"])
        val order = listOf(
            "A", "B", "X", "Y", "L", "R", "L2", "R2", "Select", "Start",
            "LStick", "RStick", "DPadUp", "DPadDown", "DPadLeft", "DPadRight",
        )
        order.forEachIndexed { index, word -> assertEquals(index, SceneInput.PAD_BUTTONS[word], "pad $word") }
        assertEquals(
            listOf("hold", "swipeDown", "swipeLeft", "swipeRight", "swipeUp", "tap"),
            SceneInput.TOUCH_WORDS.values.sorted(),
        )
        assertEquals(
            listOf("swipeDown", "swipeLeft", "swipeRight", "swipeUp", "tap"),
            SceneInput.MOMENTARY_TOUCH.sorted(),
        )
    }

    // ── axis.json ───────────────────────────────────────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun digitalFoldAgreesWithCorpus(): List<DynamicTest> =
        (doc("axis.json")["digital"] as List<Map<String, Any?>>).map { case ->
            val name = case["name"] as? String ?: "?"
            DynamicTest.dynamicTest("input-axis-digital/$name") {
                val vector = case["vector"] as List<Any?>
                val got = SceneInput.digitalAxis(
                    case["up"] as Boolean, case["left"] as Boolean,
                    case["down"] as Boolean, case["right"] as Boolean,
                )
                close(got.first, num(vector[0]), "$name.x")
                close(got.second, num(vector[1]), "$name.y")
            }
        }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun analogFoldAgreesWithCorpus(): List<DynamicTest> =
        (doc("axis.json")["analog"] as List<Map<String, Any?>>).map { case ->
            val name = case["name"] as? String ?: "?"
            DynamicTest.dynamicTest("input-axis-analog/$name") {
                val raw = case["raw"] as List<Any?>
                val vector = case["vector"] as List<Any?>
                val got = SceneInput.analogAxis(num(raw[0]), num(raw[1]), num(case["deadzone"]))
                close(got.first, num(vector[0]), "$name.x")
                close(got.second, num(vector[1]), "$name.y")
                val magnitude = sqrt(got.first * got.first + got.second * got.second)
                close(magnitude, num(case["magnitude"]), "$name.magnitude")
                assertTrue(magnitude <= 1.0 + tolerance, "$name: magnitude never exceeds 1")
            }
        }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun combinedLegsAgreeWithCorpus(): List<DynamicTest> =
        (doc("axis.json")["combined"] as List<Map<String, Any?>>).map { case ->
            val name = case["name"] as? String ?: "?"
            DynamicTest.dynamicTest("input-axis-combined/$name") {
                val resolved = SceneInput.resolveDeclarations(declarations(listOf(case["declaration"])))
                assertEquals(emptyList(), resolved.diagnostics, "$name: the declaration is clean")
                val machine = InputMachine(resolved.bindings)
                for (k in case["keysDown"] as List<String>) machine.keyDown(k)
                val pad = case["gamepad"] as? Map<String, Any?>
                if (pad != null) {
                    machine.gamepad(InputPadSnapshot(
                        (pad["buttons"] as List<Any?>).map { num(it) },
                        (pad["axes"] as List<Any?>).map { num(it) },
                    ))
                }
                @Suppress("UNCHECKED_CAST")
                val value = machine.commit().values[resolved.bindings[0].name] as Pair<Double, Double>
                val vector = case["vector"] as List<Any?>
                close(value.first, num(vector[0]), "$name.x")
                close(value.second, num(vector[1]), "$name.y")
            }
        }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun frameStreamsAgreeWithCorpus(): List<DynamicTest> =
        (doc("axis.json")["frames"] as List<Map<String, Any?>>).map { stream ->
            val name = stream["name"] as? String ?: "?"
            DynamicTest.dynamicTest("input-frames/$name") {
                val resolved = SceneInput.resolveDeclarations(declarations(stream["declarations"]))
                assertEquals(emptyList(), resolved.diagnostics, "$name: the declarations are clean")
                val machine = InputMachine(resolved.bindings)
                (stream["frames"] as List<Map<String, Any?>>).forEachIndexed { i, frame ->
                    for (op in frame["ops"] as List<Map<String, Any?>>) {
                        when (op["op"]) {
                            "keyDown" -> machine.keyDown(op["key"] as String)
                            "keyUp" -> machine.keyUp(op["key"] as String)
                            "touch" -> machine.touch(op["word"] as String)
                            "touchRelease" -> machine.touchRelease(op["word"] as String)
                            "gamepad" -> machine.gamepad(InputPadSnapshot(
                                (op["buttons"] as List<Any?>).map { num(it) },
                                (op["axes"] as List<Any?>).map { num(it) },
                            ))
                            else -> error("$name[$i]: unknown op ${op["op"]}")
                        }
                    }
                    val got = machine.commit()
                    for ((key, want) in frame["values"] as Map<String, Any?>) {
                        val have = got.values[key]
                        if (want is Boolean) {
                            assertEquals(want, have, "$name[$i].$key")
                        } else {
                            @Suppress("UNCHECKED_CAST")
                            val axis = have as Pair<Double, Double>
                            val expected = want as Map<String, Any?>
                            close(axis.first, num(expected["x"]), "$name[$i].$key.x")
                            close(axis.second, num(expected["y"]), "$name[$i].$key.y")
                        }
                    }
                    val wantEvents = frame["events"] as List<Map<String, Any?>>
                    assertEquals(wantEvents.size, got.events.size, "$name[$i]: event count ${got.events}")
                    got.events.forEachIndexed { j, event ->
                        assertEquals(wantEvents[j]["name"], event.name, "$name[$i].event[$j].name")
                        close(event.x, num(wantEvents[j]["x"]), "$name[$i].event[$j].x")
                        close(event.y, num(wantEvents[j]["y"]), "$name[$i].event[$j].y")
                    }
                }
            }
        }

    // ── attenuation.json ────────────────────────────────────────────────────────────────

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun audioAttenuationAgreesWithCorpus(): List<DynamicTest> {
        val root = doc("attenuation.json")
        val cases = root["cases"] as List<Map<String, Any?>>
        assertTrue(cases.size >= 12, "attenuation.json: suspiciously small")
        return cases.map { case ->
            val name = case["name"] as? String ?: "?"
            DynamicTest.dynamicTest("audio-attenuation/$name") {
                val listener = (case["listener"] as List<Any?>).map { num(it) }.toDoubleArray()
                val source = (case["source"] as List<Any?>).map { num(it) }.toDoubleArray()
                val got = SceneInput.audioAttenuation(
                    listener, source,
                    ref = num(case["ref"]), max = num(case["max"]), rolloff = num(case["rolloff"]),
                )
                close(got.distance, num(case["distance"]), "$name.distance")
                close(got.gain, num(case["gain"]), "$name.gain")
                close(got.pan, num(case["pan"]), "$name.pan")
                assertTrue(got.gain > 0.0 && got.gain <= 1.0 + tolerance, "$name: gain stays in (0, 1]")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun audioDefaultsAgreeWithTheCorpus() {
        val defaults = doc("attenuation.json")["defaults"] as Map<String, Any?>
        val explicit = SceneInput.audioAttenuation(
            doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(7.0, 0.0, 0.0),
            ref = num(defaults["ref"]), max = num(defaults["max"]), rolloff = num(defaults["rolloff"]),
        )
        val implicit = SceneInput.audioAttenuation(doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(7.0, 0.0, 0.0))
        assertEquals(explicit, implicit)
    }
}
