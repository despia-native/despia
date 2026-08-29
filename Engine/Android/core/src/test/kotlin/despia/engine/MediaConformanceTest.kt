package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The media conformance runner - executes
 * OpenSource/Conformance/media/{pick,manipulate,permissions}.json through THIS runtime
 * (parity/F04-media.md). The TS twin is packages/kernel/test/media-conformance.test.ts and the
 * Swift reference is Engine/iOS/MediaCore.swift.
 *
 * Opening a picker and turning a JPEG into pixels is platform work and is not pinned here.
 * What is pinned is the ARITHMETIC AND THE ORDER - crop-then-resize is not resize-then-crop,
 * EXIF orientation is normalised before the first op, and the decode hint is the difference
 * between an export and an OOM kill - plus the PERMISSION POSTURE, which is law rather than
 * documentation.
 *
 * Missing corpus = loud failure.
 */
class MediaConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/media/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/media/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(doc: Map<String, Any?>, key: String): List<Map<String, Any?>> {
        val list = doc[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.isNotEmpty(), "$key must not be empty")
        return list
    }

    @Suppress("UNCHECKED_CAST")
    private fun invariants(doc: Map<String, Any?>, keys: List<String>, label: String) {
        val declared = doc["invariants"] as? Map<String, Any?> ?: error("$label: no invariants block")
        for (key in keys) {
            val text = declared[key] as? String
            assertTrue(text != null && text.length > 40, "$label must declare the $key invariant")
        }
    }

    private fun box(spec: Map<String, Any?>): MediaCore.Box =
        MediaCore.Box((spec["width"] as Number).toInt(), (spec["height"] as Number).toInt())

    // -- manipulate.json ---------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun budgetConstantAgreesWithCorpus() {
        val budget = corpus("manipulate.json")["budget"] as Map<String, Any?>
        assertEquals((budget["maxPixels"] as Number).toLong(), MediaCore.MAX_PIXELS)
    }

    @Test
    fun formatFoldAgreesWithCorpus() {
        for (case in rows(corpus("manipulate.json"), "formats")) {
            val name = case["name"] as? String
            val expect = case["expect"] as? String
            val got = MediaCore.foldFormat(case["input"] as? String)
            if (expect == null) assertNull(got, name) else assertEquals(expect, got, name)
        }
        for (format in MediaCore.FORMATS) assertEquals(format, MediaCore.foldFormat(format))
    }

    @Test
    fun qualityIsClampedAndAPercentIsAPercent() {
        for (case in rows(corpus("manipulate.json"), "quality")) {
            val expect = (case["expect"] as Number).toDouble()
            assertEquals(expect, MediaCore.quality(case["input"]), case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun encodeSupportTableIsTheCorpusTable() {
        val support = corpus("manipulate.json")["support"] as Map<String, Any?>
        assertEquals(support.keys.sorted(), MediaCore.FORMAT_SUPPORT.keys.sorted())
        for ((platform, table) in support) {
            val declared = MediaCore.FORMAT_SUPPORT.getValue(platform)
            val expected = table as Map<String, Any?>
            assertEquals(expected.keys.sorted(), declared.keys.sorted(), "$platform: formats")
            for ((format, value) in expected) {
                assertEquals(value, declared[format], "$platform/$format: encode support")
                assertTrue(MediaCore.FORMATS.contains(format), "$platform: $format is not an output format")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun formatPlanFallsBackRatherThanLying() {
        for (case in rows(corpus("manipulate.json"), "formatPlans")) {
            val name = case["name"] as? String
            val got = MediaCore.formatPlan(
                case["requested"] as? String,
                case["platform"] as String,
                case["deviceCanEncode"] == true,
            )
            val expect = case["expect"] as Map<String, Any?>
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(got is MediaCore.FormatPlanResult.Refused, "$name: expected a refusal, got $got")
                assertEquals(expectedError, (got as MediaCore.FormatPlanResult.Refused).error, name)
                continue
            }
            assertTrue(got is MediaCore.FormatPlanResult.Value, "$name: expected a plan, got $got")
            val plan = (got as MediaCore.FormatPlanResult.Value).plan
            assertEquals(expect["format"], plan.format, "$name: format")
            assertEquals(expect["requested"], plan.requested, "$name: requested")
            assertEquals(expect["fellBack"], plan.fellBack, "$name: fellBack")
            assertEquals(expect["lossless"], plan.lossless, "$name: lossless")
            assertEquals(MediaCore.formatLossless(plan.format), plan.lossless,
                "$name: lossless agrees with the format")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun exifOrientationIsNormalisedBeforeAnythingElse() {
        for (case in rows(corpus("manipulate.json"), "exif")) {
            val name = case["name"] as? String
            val got = MediaCore.exifNormalise(case["width"], case["height"], case["orientation"])
            val expect = case["expect"] as Map<String, Any?>
            assertEquals((expect["orientation"] as Number).toInt(), got.orientation, "$name: orientation")
            assertEquals((expect["width"] as Number).toInt(), got.width, "$name: width")
            assertEquals((expect["height"] as Number).toInt(), got.height, "$name: height")
            assertEquals((expect["rotate"] as Number).toInt(), got.rotate, "$name: rotate")
            assertEquals(expect["mirrored"], got.mirrored, "$name: mirrored")
            assertEquals(expect["swaps"], got.swaps, "$name: swaps")
            // The axes trade places exactly when the tag says they do; a table that disagreed
            // with itself would report a portrait photo as landscape on one renderer only.
            assertEquals(got.rotate == 90 || got.rotate == 270, got.swaps, "$name: swaps follows the rotation")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theOpChainIsExactAndItsOrderIsTheContract() {
        for (case in rows(corpus("manipulate.json"), "chains")) {
            val name = case["name"] as? String
            val got = MediaCore.resolveOps(box(case["source"] as Map<String, Any?>), case["ops"])
            val expect = case["expect"] as Map<String, Any?>
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(got is MediaCore.OpsResult.Refused, "$name: expected a refusal, got $got")
                val refusal = got as MediaCore.OpsResult.Refused
                assertEquals(expectedError, refusal.error, "$name: error")
                assertEquals((expect["at"] as Number).toInt(), refusal.at, "$name: the index must name the bad op")
                continue
            }
            assertTrue(got is MediaCore.OpsResult.Value, "$name: expected a geometry, got $got")
            val ok = got as MediaCore.OpsResult.Value
            assertEquals((expect["width"] as Number).toInt(), ok.width, "$name: width")
            assertEquals((expect["height"] as Number).toInt(), ok.height, "$name: height")
            val steps = expect["steps"] as List<Map<String, Any?>>
            assertEquals(steps.size, ok.steps.size, "$name: one step per op")
            steps.forEachIndexed { i, want ->
                val step = ok.steps[i]
                assertEquals(want["op"], step.op, "$name: step $i op")
                assertEquals((want["width"] as Number).toInt(), step.width, "$name: step $i width")
                assertEquals((want["height"] as Number).toInt(), step.height, "$name: step $i height")
                val rect = want["rect"] as? Map<String, Any?>
                if (rect == null) {
                    assertNull(step.rect, "$name: step $i must select no region")
                } else {
                    assertEquals((rect["x"] as Number).toInt(), step.rect?.x, "$name: step $i rect x")
                    assertEquals((rect["y"] as Number).toInt(), step.rect?.y, "$name: step $i rect y")
                    assertEquals((rect["width"] as Number).toInt(), step.rect?.width, "$name: step $i rect width")
                    assertEquals((rect["height"] as Number).toInt(), step.rect?.height, "$name: step $i rect height")
                }
            }
            // The last step's geometry IS the result; a resolver that reported one and returned
            // the other would be exact per-step and wrong overall.
            val last = ok.steps.lastOrNull()
            if (last != null) {
                assertEquals(last.width, ok.width, "$name: the result is the last step")
                assertEquals(last.height, ok.height, "$name: the result is the last step")
            }
        }
    }

    @Test
    fun theFitsAreExactlyThree() {
        assertEquals(listOf("contain", "cover", "fill"), MediaCore.RESIZE_FITS.sorted())
        for (fit in MediaCore.RESIZE_FITS) {
            val ops = listOf(mapOf("resize" to mapOf("width" to 100, "height" to 100, "fit" to fit)))
            assertTrue(MediaCore.resolveOps(MediaCore.Box(800, 600), ops) is MediaCore.OpsResult.Value,
                "$fit must resolve")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theDecodeHintNeverAllocatesTheFullBitmap() {
        for (case in rows(corpus("manipulate.json"), "decode")) {
            val name = case["name"] as? String
            val source = box(case["source"] as Map<String, Any?>)
            val got = MediaCore.decodeHint(source, case["ops"])
            val expect = case["expect"] as Map<String, Any?>
            assertEquals((expect["sampleSize"] as Number).toInt(), got.sampleSize, "$name: sampleSize")
            assertEquals((expect["width"] as Number).toInt(), got.width, "$name: width")
            assertEquals((expect["height"] as Number).toInt(), got.height, "$name: height")
            // A sample size is a power of two - it is handed straight to inSampleSize, which
            // rounds anything else down and would decode larger than the hint promised.
            assertTrue(got.sampleSize >= 1 && (got.sampleSize and (got.sampleSize - 1)) == 0,
                "$name: sampleSize must be a power of two")
            // The hint is a decode of the SOURCE, so it can never claim more pixels than exist.
            assertTrue(got.width <= source.width && got.height <= source.height,
                "$name: a hint may only ever subsample")
        }
    }

    @Test
    fun manipulateInvariantsAreDeclared() {
        invariants(corpus("manipulate.json"),
            listOf("orientationBeforeOps", "orientationStrippedOnWrite", "decodeAtTargetSize",
                   "streamToDisk", "chainIsOneRenderPass", "qualityIgnoredForLossless"),
            "manipulate.json")
    }

    // -- pick.json ------------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pickVocabularyAndTheSelectionCeiling() {
        val doc = corpus("pick.json")
        assertEquals(doc["types"] as List<String>, MediaCore.PICK_TYPES)
        assertEquals(doc["sources"] as List<String>, MediaCore.PICK_SOURCES)
        assertEquals((doc["maxSelection"] as Number).toInt(), MediaCore.PICK_MAX)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pickPlanFoldAgreesWithCorpus() {
        for (case in rows(corpus("pick.json"), "plans")) {
            val name = case["name"] as? String
            val got = MediaCore.pickPlan(case["args"] as? Map<String, Any?>)
            val expect = case["expect"] as Map<String, Any?>
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(got is MediaCore.PickPlanResult.Refused, "$name: expected a refusal, got $got")
                assertEquals(expectedError, (got as MediaCore.PickPlanResult.Refused).error, name)
                continue
            }
            assertTrue(got is MediaCore.PickPlanResult.Value, "$name: expected a plan, got $got")
            val plan = (got as MediaCore.PickPlanResult.Value).plan
            assertEquals(expect["type"], plan.type, "$name: type")
            assertEquals(expect["source"], plan.source, "$name: source")
            assertEquals((expect["limit"] as Number).toInt(), plan.limit, "$name: limit")
            assertEquals(expect["multiple"], plan.multiple, "$name: multiple")
            assertEquals(expect["ordered"], plan.ordered, "$name: ordered")
            assertEquals(expect["permissionFree"], plan.permissionFree, "$name: permissionFree")
            // Three folds the corpus states as prose and every facet depends on:
            assertTrue(plan.multiple || plan.limit == 1, "$name: a single pick is always limit 1")
            assertTrue(!plan.ordered || plan.multiple, "$name: ordered is meaningless without a multi-pick")
            assertEquals(plan.source == "library", plan.permissionFree,
                "$name: only the library path is permission-free")
            assertTrue(plan.limit <= MediaCore.PICK_MAX, "$name: the ceiling is never exceeded")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun pickMimeFilterAgreesWithCorpus() {
        for (case in rows(corpus("pick.json"), "mimeTypes")) {
            assertEquals(case["expect"] as List<String>,
                MediaCore.pickMimeTypes(case["type"] as String), "mimeTypes for ${case["type"]}")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun cancellationResolvesRatherThanFailing() {
        val doc = corpus("pick.json")
        val cancelled = (doc["resolve"] as Map<String, Any?>)["cancelled"] as Map<String, Any?>
        assertEquals(emptyList<Any?>(), cancelled["assets"], "a cancelled pick carries an empty asset list")
        assertEquals(true, cancelled["cancelled"])
        for (case in rows(doc, "cancellation")) {
            val name = case["name"] as? String
            val expect = case["expect"] as Map<String, Any?>
            val dismissed = case["outcome"] == "dismissed"
            assertEquals(dismissed, expect["cancelled"], "$name: cancelled follows the outcome")
            assertEquals(dismissed, (expect["assets"] as Number).toInt() == 0,
                "$name: a dismissal carries no assets")
            assertNull(expect["error"], "$name: a dismissal is never an error")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theResolveShapeNamesEveryFieldOnce() {
        val shape = corpus("pick.json")["resolve"] as Map<String, Any?>
        val required = shape["required"] as List<String>
        val optional = shape["optional"] as List<String>
        assertTrue(required.isNotEmpty(), "an asset must carry at least one required field")
        for (field in required) {
            assertTrue(!optional.contains(field), "$field cannot be both required and optional")
        }
    }

    @Test
    fun pickInvariantsAreDeclared() {
        invariants(corpus("pick.json"),
            listOf("cancelResolves", "orderedIsSelectionOrder", "pathIsADocumentPath",
                   "copiedBeforeResolve", "limitIsAdvisory"),
            "pick.json")
    }

    // -- permissions.json - the fixture that matters most ---------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun everyMatrixRowGradesItselfFromTheDeclaredVocabulary() {
        val doc = corpus("permissions.json")
        val grades = (doc["grades"] as List<String>).toSet()
        val platforms = setOf("ios", "android", "web")
        for (row in rows(doc, "matrix")) {
            val label = "${row["action"]}/${row["source"] ?: "-"}/${row["platform"]}"
            assertTrue(platforms.contains(row["platform"]), "$label: unknown platform")
            assertTrue(grades.contains(row["prompts"]), "$label: '${row["prompts"]}' is not a grade")
            if (row["unsupported"] == true) {
                assertNull(row["api"], "$label: typed absence names no API")
                assertEquals("none", row["prompts"], "$label: an absent capability cannot prompt")
            } else {
                val api = row["api"] as? String
                assertTrue(api != null && api.isNotEmpty(),
                    "$label: a supported row must name the platform API it uses")
            }
            // An iOS row that prompts must name the usage string, and one that does not must
            // not: a declared usage string with no prompt behind it is an App Store question
            // nobody can answer.
            if (row["platform"] == "ios") {
                if (row["prompts"] == "none") {
                    assertNull(row["usageKey"], "$label: a silent path declares no usage string")
                } else {
                    assertTrue(row["usageKey"] is String, "$label: a prompt must name its usage string")
                }
            }
        }
    }

    @Test
    fun theDefaultPickPromptsOnNoPlatform() {
        val doc = corpus("permissions.json")
        val picks = rows(doc, "matrix").filter { it["action"] == "pick" && it["source"] == "library" }
        assertEquals(3, picks.size, "the permission-free path must be pinned on all three renderers")
        for (row in picks) {
            assertEquals("none", row["prompts"], "pick/library on ${row["platform"]} must never prompt")
            assertNull(row["usageKey"], "pick/library on ${row["platform"]} needs no usage string")
            assertNull(row["androidPermission"], "pick/library on ${row["platform"]} needs no permission")
        }
        // The default pick plan IS the library plan, so the row above is the one an author hits
        // without asking for anything.
        val got = MediaCore.pickPlan(emptyMap())
        assertTrue(got is MediaCore.PickPlanResult.Value)
        val plan = (got as MediaCore.PickPlanResult.Value).plan
        assertEquals(true, plan.permissionFree)
        assertEquals("library", plan.source)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theEscalationLadderIsExactlyAlbumsAndAssets() {
        val doc = corpus("permissions.json")
        val escalation = doc["escalation"] as Map<String, Any?>
        val escalates = escalation["escalates"] as List<String>
        val never = escalation["neverEscalates"] as List<String>
        assertEquals(listOf("albums", "assets"), escalates.sorted())
        assertEquals("first-call", escalation["timing"], "a grant is asked at the call that needs it")
        assertEquals("permission_denied", escalation["refusalCode"])

        val actions = rows(doc, "matrix").map { it["action"] as String }.toSet()
        assertEquals(actions.sorted(), (escalates + never).sorted(),
            "every action is graded exactly once by the ladder")
        for (name in escalates) {
            for (row in rows(doc, "matrix").filter { it["action"] == name }) {
                if (row["unsupported"] == true) continue
                assertEquals("full", row["prompts"], "$name on ${row["platform"]} is the full-access grade")
            }
        }
        for (row in rows(doc, "matrix").filter { it["action"] == "save" }) {
            if (row["unsupported"] == true) continue
            assertEquals("add", row["prompts"],
                "save on ${row["platform"]} must use the weaker add-only grant, never full access")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun thePostureTakesNoOverridingArgument() {
        val spec = corpus("permissions.json")["manifest"] as Map<String, Any?>
        val banned = spec["forbiddenArgs"] as List<String>
        assertTrue(banned.size >= 4, "the forbidden-argument list must be more than a token gesture")
        assertTrue((spec["infoPlist"] as List<String>).isNotEmpty(), "the iOS usage strings must be named")
        assertTrue((spec["androidPermissions"] as List<String>).isNotEmpty(),
            "the Android permissions must be named")
        assertEquals(true, spec["usageStringsAreConfigTokens"],
            "a usage string is an app's own words, never a framework literal")
    }

    @Test
    fun permissionInvariantsAreDeclared() {
        invariants(corpus("permissions.json"),
            listOf("safeByDefault", "noPromptOnLaunch", "limitedLibraryIsNotAFailure",
                   "denialIsRecoverable", "saveNeverReadsBack"),
            "permissions.json")
    }
}
