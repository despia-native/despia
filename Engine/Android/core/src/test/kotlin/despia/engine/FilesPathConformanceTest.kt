package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The `files` path conformance runner - executes OpenSource/Conformance/files/{paths,errors,
 * operations,transfer}.json through THIS runtime's DSXFilePaths (parity/F03-files.md). The TS
 * twin (@despia/kernel parseFilePath / filePathContains, files-conformance.test.ts) runs the
 * SAME files, so a path that escapes its root cannot be refused on one renderer and quietly
 * followed on another.
 *
 * paths.json is the security boundary and gets the most weight: the root vocabulary, the
 * per-platform base table, the textual fold (normalise, THEN test for escape), and the
 * post-canonicalisation containment check. errors.json pins the `recoverable` verdicts and the
 * typed-absence roster. operations.json and transfer.json describe runtime semantics the facets
 * implement; what is checkable without a filesystem is checked here - every action name, every
 * error code and every path literal in those fixtures runs through the real vocabulary and the
 * real parser, and every progress sequence must be monotonic with a fraction that agrees with
 * its own arithmetic.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class FilesPathConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/files/$name.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/files/$name.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name.json: not a JSON object")
        assertEquals(1, (root[VERSION] as? Number)?.toInt(), "$name.json version")
        return root
    }

    /** Every path literal a fixture names, so none of them can be one the sandbox would refuse. */
    @Suppress("UNCHECKED_CAST")
    private fun pathsOf(step: Map<String, Any?>): List<String> {
        val args = step["args"] as? Map<String, Any?> ?: emptyMap()
        return listOf("path", "from", "to").mapNotNull { args[it] as? String }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun vocabularyAgreesWithCorpus() {
        val doc = root("paths")
        assertEquals((doc["roots"] as List<Any?>).map { it as String }, DSXFilePaths.ROOTS, "roots")
        assertEquals((doc["actions"] as List<Any?>).map { it as String }, DSXFilePaths.ACTIONS, "actions")
        assertEquals((doc["platforms"] as List<Any?>).map { it as String }, DSXFilePaths.PLATFORMS, "platforms")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun baseTableAgreesWithCorpus() {
        val rows = root("paths")["bases"] as? List<Map<String, Any?>> ?: error("paths.json: no bases[]")
        assertEquals(DSXFilePaths.ROOTS.size, rows.size, "one base row per root")
        for (row in rows) {
            val rootName = row["root"] as String
            assertTrue(rootName in DSXFilePaths.ROOTS, "bases: unknown root $rootName")
            assertEquals(row["writable"] as Boolean, DSXFilePaths.writable(rootName), "$rootName: writable")
            for (platform in DSXFilePaths.PLATFORMS) {
                assertEquals(row[platform] as String?, DSXFilePaths.base(rootName, platform),
                             "$rootName/$platform: base")
            }
        }
        assertEquals(null, DSXFilePaths.base("nope", "ios"), "an unknown root has no base")
        assertEquals(null, DSXFilePaths.base("documents", "watch"), "an unknown platform has no base")
        assertFalse(DSXFilePaths.writable("nope"), "an unknown root is not writable")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pathFoldAgreesWithCorpus() {
        val cases = root("paths")["parse"] as? List<Map<String, Any?>> ?: error("paths.json: no parse[]")
        assertTrue(cases.isNotEmpty(), "parse corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val result = DSXFilePaths.parse(case["path"] as? String)

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(result.isFailure, "$name: expected refusal $expectedError, got ${result.getOrNull()}")
                assertEquals(expectedError, DSXFilePaths.REFUSAL, "$name: refusal code")
                continue
            }

            assertTrue(result.isSuccess, "$name: expected a parsed path")
            val parsed = result.getOrThrow()
            assertEquals(expect["root"] as String, parsed.root, "$name: root")
            assertEquals(expect["relative"] as String, parsed.relative, "$name: relative")
        }
    }

    /**
     * The property behind the corpus: whatever survives the fold is inert. Re-parsing a
     * normalised result must give back exactly the same result, or normalisation is not a fixed
     * point and some second consumer will disagree with the first.
     */
    @Test
    @Suppress("UNCHECKED_CAST")
    fun theFoldIsIdempotent() {
        val cases = root("paths")["parse"] as? List<Map<String, Any?>> ?: error("paths.json: no parse[]")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val first = DSXFilePaths.parse(case["path"] as? String).getOrNull() ?: continue
            val again = DSXFilePaths.parse("${first.root}:${first.relative}")
            assertTrue(again.isSuccess, "$name: a folded path re-parses")
            assertEquals(first, again.getOrThrow(), "$name: the fold is idempotent")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun containmentAgreesWithCorpus() {
        val cases = root("paths")["contains"] as? List<Map<String, Any?>> ?: error("paths.json: no contains[]")
        assertTrue(cases.isNotEmpty(), "contains corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertEquals(case["expect"] as Boolean,
                         DSXFilePaths.contains(case["base"] as String, case["candidate"] as String), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun listGlobAgreesWithCorpus() {
        val cases = root("paths")["glob"] as? List<Map<String, Any?>> ?: error("paths.json: no glob[]")
        assertTrue(cases.isNotEmpty(), "glob corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertEquals(case["expect"] as Boolean,
                         DSXFilePaths.globMatch(case["pattern"] as String, case["path"] as String), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun errorCatalogAgreesWithCorpus() {
        val doc = root("errors")
        val codes = doc["codes"] as? Map<String, Any?> ?: error("errors.json: no codes{}")
        assertEquals(codes.keys.sorted(), DSXFilePaths.ERROR_RECOVERABLE.keys.sorted(), "codes")
        for ((code, descriptor) in codes) {
            val recoverable = (descriptor as Map<String, Any?>)["recoverable"] as Boolean
            assertEquals(recoverable, DSXFilePaths.ERROR_RECOVERABLE[code], "$code: recoverable")
        }

        val roster = doc["unsupportedByPlatform"] as? Map<String, Any?>
            ?: error("errors.json: no unsupportedByPlatform{}")
        assertEquals(DSXFilePaths.PLATFORMS.sorted(), roster.keys.sorted(), "roster platforms")
        val capabilities = (doc["capabilities"] as Map<String, Any?>).keys
        for (platform in DSXFilePaths.PLATFORMS) {
            val listed = (roster[platform] as List<Any?>).map { it as String }
            assertEquals(DSXFilePaths.UNSUPPORTED[platform]?.sorted() ?: emptyList<String>(), listed.sorted(), platform)
            for (capability in listed) {
                assertTrue(capability in capabilities, "$platform: undocumented capability $capability")
                assertTrue(DSXFilePaths.unsupported(platform, capability), "$platform/$capability")
            }
        }
        assertFalse(DSXFilePaths.unsupported("ios", "zip"), "iOS zips")
        assertFalse(DSXFilePaths.unsupported("web", "read"), "the roster names absences, not everything")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun operationsMatrixNamesOnlyRealActionsCodesAndPaths() {
        val cases = root("operations")["cases"] as? List<Map<String, Any?>>
            ?: error("operations.json: no cases[]")
        assertTrue(cases.isNotEmpty(), "operations corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val steps = case["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps[]")
            assertTrue(steps.isNotEmpty(), "$name: a case runs at least one step")

            val seeded = ((case["given"] as? List<Map<String, Any?>>) ?: emptyList()) +
                ((case["then"] as? List<Map<String, Any?>>) ?: emptyList())
            for (entry in seeded) {
                assertTrue(DSXFilePaths.parse(entry["path"] as? String).isSuccess,
                           "$name: the fixture seeds an unaddressable path ${entry["path"]}")
            }

            for (step in steps) {
                val action = step["action"] as String
                assertTrue(action in DSXFilePaths.ACTIONS, "$name: unknown action $action")
                assertFalse(step.containsKey("resolve") && step.containsKey("error"),
                            "$name/$action: a step settles once, either resolve or error")
                assertTrue(step.containsKey("resolve") || step.containsKey("error"),
                           "$name/$action: a step states its outcome")

                val code = step["error"] as? String
                if (code != null) {
                    assertTrue(DSXFilePaths.ERROR_RECOVERABLE.containsKey(code),
                               "$name/$action: undeclared error code $code")
                }

                val refused = pathsOf(step).filter { DSXFilePaths.parse(it).isFailure }
                if (code == "unsupported_root") {
                    assertTrue(refused.isNotEmpty(),
                               "$name/$action: an unsupported_root step must name a refused path")
                } else {
                    assertEquals(emptyList<String>(), refused,
                                 "$name/$action: an accepted step names only addressable paths")
                }
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun everyTransferStreamIsMonotonicAndSettlesOnce() {
        val doc = root("transfer")
        val streams = doc["streams"] as? List<Map<String, Any?>> ?: error("transfer.json: no streams[]")
        assertTrue(streams.isNotEmpty(), "transfer corpus must not be empty")

        for (stream in streams) {
            val name = stream["name"] as? String ?: "<unnamed>"
            val action = stream["action"] as String
            assertTrue(action in DSXFilePaths.ACTIONS, "$name: unknown action $action")
            assertTrue(action == "download" || action == "upload", "$name: only transfers stream")
            assertFalse(stream.containsKey("resolve") && stream.containsKey("error"),
                        "$name: a transfer settles once, either resolve or error")
            assertTrue(stream.containsKey("resolve") || stream.containsKey("error"),
                       "$name: a transfer states its outcome")

            val code = stream["error"] as? String
            if (code != null) {
                assertTrue(DSXFilePaths.ERROR_RECOVERABLE.containsKey(code),
                           "$name: undeclared error code $code")
            }

            val refused = pathsOf(stream).filter { DSXFilePaths.parse(it).isFailure }
            if (code == "unsupported_root") {
                assertTrue(refused.isNotEmpty(), "$name: an unsupported_root transfer must name a refused path")
            } else {
                assertEquals(emptyList<String>(), refused, "$name: a started transfer names only addressable paths")
            }
            val after = (stream["then"] as? List<Map<String, Any?>>) ?: emptyList()
            for (entry in after) {
                assertTrue(DSXFilePaths.parse(entry["path"] as? String).isSuccess,
                           "$name: unaddressable outcome path")
            }

            var lastAt = -1.0
            var lastMoved = -1.0
            var lastFraction = -1.0
            for (event in (stream["events"] as? List<Map<String, Any?>>) ?: emptyList()) {
                assertEquals("progress", event["event"] as String, "$name: a transfer streams only progress")
                val at = (event["at"] as Number).toDouble()
                assertTrue(at >= lastAt, "$name: progress at $at arrives after $lastAt")
                lastAt = at

                val data = event["data"] as Map<String, Any?>
                val moved = ((if (action == "download") data["received"] else data["sent"]) as Number).toDouble()
                val total = (data["total"] as Number).toDouble()
                val fraction = (data["fraction"] as Number).toDouble()
                assertTrue(moved >= lastMoved, "$name: bytes moved is monotonic ($moved after $lastMoved)")
                lastMoved = moved
                assertTrue(fraction in 0.0..1.0, "$name: fraction $fraction is a fraction")
                assertTrue(fraction >= lastFraction, "$name: fraction is monotonic ($fraction after $lastFraction)")
                lastFraction = fraction

                // An unknown body length reports total 0 and fraction 0 - never a guessed percentage.
                val expected = if (total > 0) moved / total else 0.0
                assertTrue(kotlin.math.abs(fraction - expected) < 1e-9,
                           "$name: fraction $fraction does not match $moved/$total")
                if (total > 0) assertTrue(moved <= total, "$name: bytes moved never exceeds the total")
            }

            // A REFUSED request names its status. `http_error` exists precisely so a caller can
            // tell a 413 from a 401 without parsing a message, which is only true if it travels.
            if (code == "http_error") {
                val data = stream["data"] as? Map<String, Any?>
                assertTrue(data != null, "$name: an http_error carries data")
                val status = (data!!["status"] as Number).toInt()
                assertTrue(status < 200 || status >= 300, "$name: $status is not a refusal")
            }

            // A failed transfer leaves nothing at the destination - the plan's whole point about
            // writing to a partial and moving it into place only on success.
            if (code != null) {
                val destination = (stream["args"] as Map<String, Any?>)["to"]
                for (entry in after) {
                    if (entry["path"] == destination) {
                        assertEquals(false, entry["exists"], "$name: a failed download leaves no partial file")
                    }
                }
            }
        }

        val background = doc["background"] as? List<Map<String, Any?>> ?: error("transfer.json: no background[]")
        assertEquals(DSXFilePaths.PLATFORMS.sorted(), background.map { it["platform"] as String }.sorted())
        for (row in background) {
            val platform = row["platform"] as String
            assertEquals(!DSXFilePaths.unsupported(platform, "background"), row["supported"] as Boolean,
                         "$platform: background support agrees with the typed-absence roster")
            if (row["supported"] == false) {
                assertEquals("unsupported_platform", row["error"] as String, "$platform: absence is typed")
            }
        }
    }

    /** THE SETTLE TABLE - what decides a transfer's outcome, stated once so three renderers
     *  cannot disagree. One sentence: the STATUS decides, not the transport. Only 2xx resolves;
     *  every other status reached the server and was refused (`http_error`, with the status on
     *  `data`); no answer at all is `network_failed`, which is also the only outcome worth
     *  resuming. The TS twin runs the identical assertions over the identical file. */
    @Test
    @Suppress("UNCHECKED_CAST")
    fun theTransferSettleTableIsDecidedByTheStatus() {
        val rows = root("transfer")["settle"] as? List<Map<String, Any?>>
            ?: error("transfer.json: no settle[]")
        assertTrue(rows.isNotEmpty(), "the settle table must not be empty")

        val seen = HashSet<Int?>()
        for (row in rows) {
            val whenever = row["when"] as? String ?: "<unnamed>"
            val status = (row["status"] as? Number)?.toInt()
            val outcome = row["outcome"] as String

            assertTrue(seen.add(status), "$whenever: status $status is stated twice")
            if (outcome != "resolve") {
                assertTrue(DSXFilePaths.ERROR_RECOVERABLE.containsKey(outcome),
                           "$whenever: undeclared error code $outcome")
            }

            if (status != null && status in 200..299) {
                assertEquals("resolve", outcome, "$whenever: $status is a success")
                assertEquals("written", row["destination"], "$whenever: a success writes the destination")
            } else if (status == null) {
                assertEquals("network_failed", outcome, "$whenever: no answer is a transport failure")
            } else {
                assertEquals("http_error", outcome, "$whenever: $status is a refusal, not a success")
                assertEquals(true, DSXFilePaths.ERROR_RECOVERABLE["http_error"],
                             "a refusal is recoverable - 401/429/503 are routinely fixed by retrying")
                assertEquals(listOf("status", "headers", "body"), row["carries"],
                             "$whenever: a refusal carries the status, the headers and the explanation")
            }

            // Every failing row leaves the caller's destination exactly as it was. This is the
            // whole defect: a 404 used to resolve with the server's error page written there.
            if (outcome != "resolve") {
                assertEquals("untouched", row["destination"], "$whenever: a failure touches no destination")
            }
        }

        val outcomes = rows.map { it["outcome"] as String }.toSet()
        for (required in listOf("resolve", "http_error", "network_failed")) {
            assertTrue(required in outcomes, "the settle table must state the $required outcome")
        }
    }

    private companion object {
        const val VERSION = "version"
    }
}
