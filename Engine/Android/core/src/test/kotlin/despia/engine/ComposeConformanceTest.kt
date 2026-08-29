package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The composer conformance runner - executes OpenSource/Conformance/compose/result.json through
 * THIS runtime's ComposeCore folds (parity F13). The TS twin (@despia/kernel compose-core.ts,
 * compose-conformance.test.ts) and the Swift reference (ComposeConformance) run the SAME file,
 * so `unknown` cannot quietly become `sent` on the renderer that never learns what the user did.
 *
 * Missing corpus = loud failure, and so is an empty section.
 */
class ComposeConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/compose/result.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/compose/result.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("result.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "result.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String): List<Map<String, Any?>> {
        val raw = root()[name]
        val rows = (raw as? List<Any?>) ?: ((raw as? Map<String, Any?>)?.get("cases") as? List<Any?>)
        val cases = rows?.map { it as Map<String, Any?> }
        assertTrue(cases != null && cases.isNotEmpty(), "result.json: $name must be a non-empty case array")
        return cases!!
    }

    private fun int(value: Any?): Int = (value as Number).toInt()

    @Test
    @Suppress("UNCHECKED_CAST")
    fun vocabularyAgreesWithCorpus() {
        assertEquals((root()["vocabulary"] as List<Any?>).map { it as String }, ComposeCore.RESULTS)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun resultFidelityAgreesWithCorpus() {
        val fidelity = (root()["resultFidelity"] as Map<String, Any?>).filterKeys { !it.startsWith("_") }
        assertTrue(fidelity.isNotEmpty(), "result.json: resultFidelity names no renderers")
        for ((renderer, actions) in fidelity) {
            for ((action, results) in (actions as Map<String, Any?>)) {
                assertEquals((results as List<Any?>).map { it as String },
                             ComposeCore.RESULT_FIDELITY[renderer]?.get(action),
                             "resultFidelity: $renderer.$action")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun permissionSurfaceIsEmptyOnEveryAction() {
        val surface = root()["permissionSurface"] as Map<String, Any?>
        val declared = surface.filterKeys { !it.startsWith("_") }.filterValues { it is String }
        assertTrue(declared.isNotEmpty(), "result.json: permissionSurface names no actions")
        for ((action, grant) in declared) {
            assertEquals("none", grant, "permissionSurface: $action must need no grant")
            assertEquals("none", ComposeCore.PERMISSION_SURFACE[action], "permissionSurface: $action")
        }
        assertEquals((surface["forbiddenPermissions"] as List<Any?>).map { it as String },
                     ComposeCore.FORBIDDEN_PERMISSIONS)
        for (permission in ComposeCore.FORBIDDEN_PERMISSIONS) {
            assertTrue(permission !in ComposeCore.PERMISSION_SURFACE.values,
                       "$permission must never appear in the permission surface")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun resultLadderAgreesWithCorpus() {
        val fidelity = root()["resultFidelity"] as Map<String, Any?>
        for (case in section("cases")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val renderer = given["renderer"] as String
            val action = given["action"] as String

            val outcome = ComposeCore.outcome(
                renderer = renderer,
                composerResult = given["composerResult"] as? String,
                launched = given["launched"] as? Boolean ?: true,
                isHtml = given["isHtml"] == true,
            )

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertEquals(expectedError, outcome.error, "$name: error")
                continue
            }
            assertNull(outcome.error, "$name: error")
            assertEquals(expect["result"], outcome.result, "$name: result")
            if (expect.containsKey("isHtml")) {
                assertEquals(expect["isHtml"] as Boolean?, outcome.isHtml, "$name: isHtml")
            }
            val allowed = ((fidelity[renderer] as Map<String, Any?>)[action] as List<Any?>).map { it as String }
            assertTrue(outcome.result in allowed,
                       "$name: ${outcome.result} is outside $renderer.$action's fidelity list")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun capabilitiesAgreeWithCorpus() {
        for (case in section("capabilities")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val capabilities = ComposeCore.capabilities(
                renderer = given["renderer"] as String,
                canText = given["canText"] == true,
                canMail = given["canMail"] == true,
                smsResolver = given["smsResolver"] as? String,
                mailResolver = given["mailResolver"] as? String,
            )
            assertEquals(expect["sms"], capabilities.sms, "$name: sms")
            assertEquals(expect["mail"], capabilities.mail, "$name: mail")
            if (expect.containsKey("defaultMailClient")) {
                assertEquals(expect["defaultMailClient"] as String?, capabilities.defaultMailClient,
                             "$name: defaultMailClient")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun recipientCapAgreesWithCorpus() {
        for (case in section("recipients")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val count = if (given.containsKey("count")) int(given["count"])
                        else int(given["to"] ?: 0) + int(given["cc"] ?: 0) + int(given["bcc"] ?: 0)
            val decision = ComposeCore.recipientDecision(count, int(given["cap"]))
            assertEquals(expect["runs"], decision.runs, "$name: runs")
            assertEquals(expect["error"] as String?, decision.error, "$name: error")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun attachmentRuleAgreesWithCorpus() {
        for (case in section("attachments")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val decision = ComposeCore.attachmentDecision(
                renderer = given["renderer"] as String,
                path = given["path"] as? String,
                insideRoots = given["insideRoots"] as? Boolean,
                exists = given["exists"] as? Boolean,
            )
            assertEquals(expect["runs"], decision.runs, "$name: runs")
            assertEquals(expect["error"] as String?, decision.error, "$name: error")
        }
    }
}
