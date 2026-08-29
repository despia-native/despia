package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The contacts conformance runner - executes
 * OpenSource/Conformance/contacts/{crud,pick}.json through THIS runtime's ContactsCore folds
 * (parity F12). The TS twin (@despia-native/kernel contacts-core.ts, contacts-conformance.test.ts) and
 * the Swift reference (ContactsConformance) run the SAME files, so an ungranted bulk read, iOS
 * 17 limited access and the paging arithmetic cannot mean one thing on one renderer and
 * something else on another.
 *
 * Missing corpus = loud failure, and so is an empty section.
 */
class ContactsConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/contacts/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/contacts/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(root: Map<String, Any?>, name: String, file: String): List<Map<String, Any?>> {
        val raw = root[name]
        val rows = (raw as? List<Any?>) ?: ((raw as? Map<String, Any?>)?.get("cases") as? List<Any?>)
        val cases = rows?.map { it as Map<String, Any?> }
        assertTrue(cases != null && cases.isNotEmpty(), "$file: $name must be a non-empty case array")
        return cases!!
    }

    private fun int(value: Any?): Int = (value as Number).toInt()

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pagingAgreesWithCorpus() {
        for (case in section(root("crud.json"), "paging", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val page = ContactsCore.page(int(given["total"]), int(given["limit"]), int(given["offset"]))
            assertEquals(int(expect["returned"]), page.returned, "$name: returned")
            assertEquals(expect["hasNextPage"], page.hasNextPage, "$name: hasNextPage")
            assertEquals(expect["endCursor"] as String?, page.endCursor, "$name: endCursor")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun readAccessAgreesWithCorpus() {
        for (case in section(root("crud.json"), "access", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val decision = ContactsCore.readDecision(given["access"] as? String)

            assertEquals(expect["runs"], decision.runs, "$name: runs")
            if (expect.containsKey("prompted")) {
                assertEquals(expect["prompted"], decision.prompted, "$name: prompted")
            }
            assertEquals(expect["error"] as String?, decision.error, "$name: error")
            if (expect.containsKey("access")) {
                assertEquals(expect["access"] as String?, decision.access, "$name: access")
            }
            if (expect.containsKey("returned")) {
                assertEquals(
                    int(expect["returned"]),
                    ContactsCore.readCount(given["access"] as? String, int(given["shared"]), int(given["total"])),
                    "$name: returned",
                )
            }
            if (expect.containsKey("messageNames")) {
                val names = (expect["messageNames"] as String).lowercase()
                assertTrue(decision.message.orEmpty().lowercase().contains(names),
                           "$name: the refusal must name $names, got ${decision.message}")
            }
            if (expect.containsKey("recoverable")) {
                assertEquals(expect["recoverable"], decision.recoverable, "$name: recoverable")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun writeDecisionsAgreeWithCorpus() {
        for (case in section(root("crud.json"), "write", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val contact = given["contact"] as? Map<String, Any?>
            val decision = ContactsCore.writeDecision(
                given["access"] as? String, contact, validate = given.containsKey("contact"))

            assertEquals(expect["runs"], decision.runs, "$name: runs")
            assertEquals(expect["error"] as String?, decision.error, "$name: error")
            if (expect.containsKey("messageNames")) {
                val names = (expect["messageNames"] as String).lowercase()
                assertTrue(decision.message.orEmpty().lowercase().contains(names),
                           "$name: the refusal must name $names, got ${decision.message}")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun shapeFoldsAgreeWithCorpus() {
        for (case in section(root("crud.json"), "shape", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            var asserted = false

            if (expect.containsKey("label")) {
                assertEquals(expect["label"], ContactsCore.normalizeLabel(given["platformLabel"] as? String),
                             "$name: label")
                asserted = true
            }
            if (expect.containsKey("birthday")) {
                assertEquals(expect["birthday"] as String?,
                             ContactsCore.birthday(int(given["year"]), int(given["month"]), int(given["day"])),
                             "$name: birthday")
                asserted = true
            }
            if (expect.containsKey("displayName")) {
                assertEquals(expect["displayName"],
                             ContactsCore.displayName(given["givenName"] as? String, given["familyName"] as? String),
                             "$name: displayName")
                asserted = true
            }
            assertTrue(asserted, "$name: the runner asserted nothing - an unknown shape expectation")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun permissionSurfaceAgreesWithCorpus() {
        val surface = root("pick.json")["permissionSurface"] as Map<String, Any?>
        val declared = surface.filterKeys { !it.startsWith("_") }
        assertTrue(declared.isNotEmpty(), "pick.json: permissionSurface names no actions")
        for ((action, grant) in declared) {
            assertEquals(grant, ContactsCore.PERMISSION_SURFACE[action], "permissionSurface: $action")
        }
        for (action in ContactsCore.PERMISSION_SURFACE.keys) {
            assertTrue(surface.containsKey(action), "permissionSurface: the corpus does not pin $action")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pickerFoldAgreesWithCorpus() {
        for (case in section(root("pick.json"), "cases", "pick.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val args = (case["args"] as? Map<String, Any?>) ?: emptyMap()
            val given = (case["given"] as? Map<String, Any?>) ?: emptyMap()
            val expect = case["expect"] as Map<String, Any?>

            val outcome = ContactsCore.pickOutcome(
                multiple = args["multiple"] == true,
                fields = (args["fields"] as? List<Any?>)?.map { it as String },
                picked = (given["picked"] as? List<Any?>)?.map { it as Map<String, Any?> },
                multiSelect = given["multiSelect"] as? Boolean,
                pickerAvailable = given["pickerAvailable"] as? Boolean,
            )

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertEquals(expectedError, outcome.error, "$name: error")
                continue
            }
            assertEquals(null, outcome.error, "$name: error")
            assertEquals(int(expect["contacts"]), outcome.contacts.size, "$name: contacts")
            if (expect.containsKey("cancelled")) {
                assertEquals(expect["cancelled"], outcome.cancelled, "$name: cancelled")
            }
            if (expect.containsKey("prompted")) {
                assertEquals(expect["prompted"], outcome.prompted, "$name: prompted")
            }
            if (expect.containsKey("multiple")) {
                assertEquals(expect["multiple"] as Boolean?, outcome.multiple, "$name: multiple")
            }
            if (expect.containsKey("keys")) {
                assertEquals((expect["keys"] as List<Any?>).map { it as String },
                             outcome.contacts[0].keys.toList(), "$name: keys")
            }
        }
    }
}
