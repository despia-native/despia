package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The density grammar conformance runner — executes
 * OpenSource/Conformance/input/density.json through THIS runtime's StackDensity fold and
 * subtree resolution (component-library.md W9 — the universal density knob). The TS twin
 * (@despia/dom resolveDensity/effectiveDensity, density.test.ts) and the Swift reference
 * (StackDensity + the record lane) run the SAME file, so the knob cannot drift between
 * renderers: exact-lowercase vocabulary, nearest-ancestor pin, fine-pointer platform
 * default compact.
 *
 * Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
 */
class DensityConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/density.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/density.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("density.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "density.json version")
        return root
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun resolveAgreesWithCorpus() {
        val cases = root()["resolve"] as? List<Map<String, Any?>> ?: error("density.json: no resolve[]")
        assertTrue(cases.isNotEmpty(), "resolve corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val got = StackDensity.resolve(case["density"] as? String)
            assertEquals(case["expect"] as? String, got, "density/$name")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun effectiveAgreesWithCorpus() {
        val cases = root()["effective"] as? List<Map<String, Any?>> ?: error("density.json: no effective[]")
        assertTrue(cases.isNotEmpty(), "effective corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val chain = (case["chain"] as? List<Any?> ?: emptyList()).map { it as? String }
            val got = StackDensity.effective(chain, case["finePointer"] as? Boolean ?: false)
            assertEquals(case["expect"] as? String, got, "density/$name")
        }
    }
}
