package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The font face-selection conformance runner - executes
 * OpenSource/Conformance/fonts/matching.json through THIS runtime's StackFonts
 * (parity/F01-fonts.md). The TS twin (@despia-native/kernel fonts.ts) and the Swift twin (StackFonts)
 * run the SAME file, so a type ramp cannot come out semibold on one renderer and bold on another.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class FontsConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/fonts/matching.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/fonts/matching.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("matching.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "matching.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String): List<Map<String, Any?>> =
        (root()[name] as? List<Map<String, Any?>>)?.also {
            assertTrue(it.isNotEmpty(), "$name must not be empty")
        } ?: error("matching.json: no $name[]")

    @Test
    @Suppress("UNCHECKED_CAST")
    fun weightMatchingAgreesWithCorpus() {
        for (case in section("matching")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val faces = (case["faces"] as List<Any?>).map { (it as Number).toInt() }
            val request = (case["request"] as Number).toInt()
            val expected = (case["expect"] as? Number)?.toInt()
            assertEquals(expected, StackFonts.matchWeight(faces, request), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun slantSelectionAgreesWithCorpus() {
        for (case in section("italic")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val faces = (case["faces"] as List<Map<String, Any?>>).map {
                StackFonts.Face((it["w"] as Number).toInt(), it["i"] as Boolean)
            }
            val request = case["request"] as Map<String, Any?>
            val got = StackFonts.selectFace(faces, (request["w"] as Number).toInt(), request["i"] as Boolean)
            val expect = case["expect"] as? Map<String, Any?>
            if (expect == null) {
                assertNull(got, name)
                continue
            }
            assertNotNull(got, "$name: expected a selection")
            assertEquals((expect["w"] as Number).toInt(), got.face.weight, "$name: weight")
            assertEquals(expect["i"] as Boolean, got.face.italic, "$name: italic")
            assertEquals(expect["synthesized"] as Boolean, got.synthesized, "$name: synthesized")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun variationClampingAgreesWithCorpus() {
        for (case in section("variation")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val declared = (case["axes"] as? Map<String, Any?>)?.mapValues {
                val range = it.value as List<Any?>
                Pair((range[0] as Number).toDouble(), (range[1] as Number).toDouble())
            }
            val requested = (case["request"] as Map<String, Any?>).mapValues { (it.value as Number).toDouble() }
            val got = StackFonts.resolveVariation(declared, requested)
            val expect = case["expect"] as Map<String, Any?>
            val expectedApplied = (expect["applied"] as Map<String, Any?>)
                .mapValues { (it.value as Number).toDouble() }
            assertEquals(expectedApplied, got.applied, "$name: applied")
            assertEquals((expect["clamped"] as? List<Any?>)?.map { it as String } ?: emptyList(),
                         got.clamped, "$name: clamped")
            assertEquals((expect["dropped"] as? List<Any?>)?.map { it as String } ?: emptyList(),
                         got.dropped, "$name: dropped")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun variationParserAgreesWithCorpus() {
        for (case in section("parse")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = (case["expect"] as Map<String, Any?>).mapValues { (it.value as Number).toDouble() }
            assertEquals(expect, StackFonts.parseVariation(case["input"] as? String), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun featureParserAgreesWithCorpus() {
        for (case in section("features")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = (case["expect"] as List<Any?>).map { it as String }
            assertEquals(expect, StackFonts.parseFeatures(case["input"] as? String), name)
        }
    }
}
