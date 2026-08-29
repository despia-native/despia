package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The orientation grammar conformance runner - executes
 * OpenSource/Conformance/input/orientation.json through THIS runtime's StackOrientation fold
 * and OrientationClaimStack (parity/F07-orientation.md). The TS twin (@despia/kernel
 * resolveOrientation/OrientationClaimStack, orientation.test.ts) and the Swift reference
 * (StackOrientation) run the SAME file, so a lock cannot mean one thing on one renderer and
 * something else on another: an unrecognized word and an undeclared orientation are both
 * refused loudly, and the claim stack reverts through one funnel.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class OrientationConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/input/orientation.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/input/orientation.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("orientation.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "orientation.json version")
        return root
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun canonicalOrderAgreesWithCorpus() {
        val order = (root()["canonicalOrder"] as? List<Any?>)?.map { it as String }
            ?: error("orientation.json: no canonicalOrder")
        assertEquals(order, StackOrientation.CANONICAL, "canonical order")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun resolveAgreesWithCorpus() {
        val cases = root()["resolve"] as? List<Map<String, Any?>> ?: error("orientation.json: no resolve[]")
        assertTrue(cases.isNotEmpty(), "resolve corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val allowed = (case["allowed"] as? List<Any?>)?.map { it as String } ?: emptyList()
            val result = StackOrientation.resolve(case["to"] as? String, allowed, case["current"] as? String)
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                val failure = result.exceptionOrNull() as? StackOrientation.RefusalError
                assertTrue(result.isFailure, "$name: expected refusal $expectedError, got ${result.getOrNull()}")
                assertEquals(expectedError, StackOrientation.code(failure!!.refusal), "$name: refusal code")
                continue
            }

            assertTrue(result.isSuccess, "$name: expected a resolved lock, got ${result.exceptionOrNull()?.message}")
            val resolved = result.getOrThrow()
            assertEquals((expect["mask"] as List<Any?>).map { it as String }, resolved.mask, "$name: mask")
            assertEquals(expect["primary"] as String, resolved.primary, "$name: primary")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun claimStackAgreesWithCorpus() {
        val cases = root()["lifecycle"] as? List<Map<String, Any?>> ?: error("orientation.json: no lifecycle[]")
        assertTrue(cases.isNotEmpty(), "lifecycle corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val steps = case["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps")
            val expect = (case["expect"] as? List<Any?>) ?: error("$name: no expect")
            assertEquals(steps.size, expect.size, "$name: one expectation per step")

            val stack = OrientationClaimStack()
            steps.forEachIndexed { i, step ->
                val actual = when {
                    step["claim"] != null -> stack.claim(step["claim"] as String, step["to"] as String)
                    step["release"] != null -> stack.release(step["release"] as String)
                    step["reset"] == true -> stack.reset()
                    else -> error("$name: step $i names no operation")
                }
                assertEquals(expect[i] as String?, actual, "$name: effective after step $i")
                assertEquals(expect[i] as String?, stack.effective, "$name: effective is stable after step $i")
            }
        }
    }
}
