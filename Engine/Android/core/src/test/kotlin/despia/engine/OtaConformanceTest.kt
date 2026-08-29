package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The OTA runtime-safety conformance runner - executes OpenSource/Conformance/ota/rollout.json
 * through THIS runtime's OtaGeneration (parity/P05-ota.md 4b + 4c). The TS twin
 * (@despia/kernel ota.ts, ota-conformance.test.ts) and the Swift reference (OtaGeneration, the
 * record lane) run the SAME file, so a staged rollout cannot include a device on one renderer
 * and hold it on another, and a runtimeVersion gate cannot refuse a generation on one and
 * apply it on another.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class OtaConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/ota/rollout.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/ota/rollout.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("rollout.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "rollout.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun block(name: String): Map<String, Any?> =
        root()[name] as? Map<String, Any?> ?: error("rollout.json: no $name block")

    @Suppress("UNCHECKED_CAST")
    private fun cases(name: String): List<Map<String, Any?>> {
        val list = block(name)["cases"] as? List<Map<String, Any?>> ?: error("rollout.json: no $name.cases[]")
        assertTrue(list.isNotEmpty(), "$name corpus must not be empty")
        return list
    }

    @Test
    fun hashConstantsAgreeWithCorpus() {
        val hash = block("hash")
        assertEquals("fnv1a32", hash["algorithm"], "algorithm")
        assertEquals(2166136261L, (hash["offsetBasis"] as Number).toLong(), "offset basis")
        assertEquals(16777619L, (hash["prime"] as Number).toLong(), "prime")
        assertEquals(4294967296.0, (hash["divisor"] as Number).toDouble(), "divisor")
        assertEquals("{installationId}:{salt}", hash["inputTemplate"], "input template")
        assertEquals(4294967296.0, OtaGeneration.BUCKET_DIVISOR, "the runtime's own divisor")
    }

    @Test
    fun hashesAndBucketsReproduceExactly() {
        for (case in cases("hash")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val id = case["installationId"] as String
            val salt = case["salt"] as String
            assertEquals((case["hash"] as Number).toLong(), OtaGeneration.hash32("$id:$salt"), "$name: hash")
            val bucket = OtaGeneration.bucket(id, salt)
            val expected = (case["bucket"] as Number).toDouble()
            assertTrue(Math.abs(bucket - expected) < 1e-12, "$name: bucket $bucket != $expected")
            assertTrue(bucket >= 0.0 && bucket < 1.0, "$name: bucket is in [0,1)")
        }
    }

    @Test
    fun rolloutRuleAgreesWithCorpus() {
        for (case in cases("rollout")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val applies = OtaGeneration.rolloutApplies(
                case["installationId"] as String,
                case["salt"] as String,
                (case["fraction"] as Number).toDouble())
            assertEquals(case["applies"] as Boolean, applies, name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun raisingTheFractionOnlyGrowsThePopulation() {
        val fractions = (block("monotonic")["fractions"] as List<Any?>).map { (it as Number).toDouble() }
        for (case in cases("monotonic")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val id = case["installationId"] as String
            val salt = case["salt"] as String
            val expected = (case["applies"] as List<Any?>).map { it as Boolean }
            assertEquals(fractions.size, expected.size, "$name: one expectation per fraction")
            var previous = false
            fractions.forEachIndexed { index, fraction ->
                val actual = OtaGeneration.rolloutApplies(id, salt, fraction)
                assertEquals(expected[index], actual, "$name: fraction $fraction")
                assertTrue(!(previous && !actual), "$name: fraction $fraction dropped a device already in")
                previous = actual
            }
        }
    }

    @Test
    fun runtimeVersionPrecedenceAgreesWithCorpus() {
        for (case in cases("compare")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val a = case["a"] as String
            val b = case["b"] as String
            val expected = (case["expect"] as? Number)?.toInt()
            val actual = OtaGeneration.compareVersions(a, b)
            assertEquals(expected, actual, "$name: compare($a, $b)")
            if (expected == null) {
                assertNull(OtaGeneration.runtimeVersionSatisfied(b, a), "$name: satisfied is undecidable")
                assertTrue(
                    !OtaGeneration.isParseableVersion(a) || !OtaGeneration.isParseableVersion(b),
                    "$name: a null compare means one side is unparseable")
            } else {
                // Antisymmetry is not in the corpus because it is a property, not a case.
                assertEquals(-expected, OtaGeneration.compareVersions(b, a), "$name: reversed")
                assertEquals(expected >= 0, OtaGeneration.runtimeVersionSatisfied(b, a), "$name: satisfied")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun generationGateAgreesWithCorpus() {
        val verdicts = (block("generation")["verdicts"] as List<Any?>).map { it as String }
        val list = cases("generation")
        for (case in list) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expected = case["expect"] as String
            assertTrue(verdicts.contains(expected), "$name: '$expected' is outside the declared vocabulary")
            val manifest = case["manifest"] as? Map<String, Any?> ?: emptyMap()
            val client = case["client"] as? Map<String, Any?> ?: emptyMap()
            val decision = OtaGeneration.evaluate(
                manifest,
                client["runtimeVersion"] as? String,
                client["installationId"] as? String)
            assertEquals(expected, OtaGeneration.code(decision.verdict), name)
        }
        for (verdict in verdicts) {
            assertTrue(list.any { it["expect"] == verdict }, "no corpus case reaches '$verdict'")
        }
    }
}
