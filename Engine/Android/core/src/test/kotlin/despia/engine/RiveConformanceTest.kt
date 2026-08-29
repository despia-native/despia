package despia.engine

import java.io.File
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.jupiter.api.Test

/**
 * The rive conformance runner - executes
 * OpenSource/Conformance/rive/{inputs,selection,fit,playback,events,a11y}.json through THIS
 * runtime (parity/U12-rive.md). The TS twin is packages/kernel/test/rive-conformance.test.ts
 * and the Swift twin is Engine/iOS/RiveCore.swift, all reading the SAME six files off disk.
 *
 * What this corpus pins is DECISIONS, not pixels. Rive's own runtime draws the picture on
 * every platform, so pixel parity is the vendor's problem and is asserted nowhere here.
 * Everything AROUND the vendor is ours and is asserted exactly: the input fold, the selection
 * refusals, the fit geometry (to 1e-6), the lifecycle counters, the payload shapes and the
 * accessibility verdict.
 *
 * Missing corpus = loud failure.
 */
class RiveConformanceTest {

    private val tolerance = 1e-6

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/rive/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/rive/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(name: String): Map<String, Any?> =
        json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(file: String, key: String, minimum: Int): List<Map<String, Any?>> {
        val list = corpus(file)[key] as? List<Map<String, Any?>> ?: error("$file: no $key[]")
        assertTrue(list.size >= minimum, "$file.$key: corpus is suspiciously small (${list.size})")
        return list
    }

    private fun label(case: Map<String, Any?>): String = case["name"]?.toString() ?: "?"

    /** deep structural equality with a numeric tolerance. Key sets are compared BOTH ways: an
     *  extra field is a drift too. */
    private fun like(actual: Any?, expected: Any?, where: String) {
        when (expected) {
            null -> assertNull(actual, "$where: expected null, got $actual")
            is Boolean -> assertEquals(expected, actual, where)
            is Number -> {
                val got = actual as? Number ?: fail("$where: expected a number, got $actual")
                assertTrue(
                    abs(got.toDouble() - expected.toDouble()) <= tolerance,
                    "$where: ${got.toDouble()} !~ ${expected.toDouble()}",
                )
            }
            is List<*> -> {
                val got = actual as? List<*> ?: fail("$where: expected a list, got $actual")
                assertEquals(expected.size, got.size, "$where: length")
                expected.forEachIndexed { i, value -> like(got[i], value, "$where[$i]") }
            }
            is Map<*, *> -> {
                val got = actual as? Map<*, *> ?: fail("$where: expected a map, got $actual")
                assertEquals(
                    expected.keys.map { it.toString() }.sorted(),
                    got.keys.map { it.toString() }.sorted(),
                    "$where: field set",
                )
                for ((key, value) in expected) like(got[key.toString()], value, "$where.$key")
            }
            else -> assertEquals(expected, actual, where)
        }
    }

    private fun number(value: Any?, fallback: Double = 0.0): Double =
        (value as? Number)?.toDouble() ?: fallback

    // -- inputs.json --------------------------------------------------------------------------

    private fun planMap(plan: RiveInputPlan): Map<String, Any?> = mapOf(
        "ops" to plan.ops.map { mapOf("name" to it.name, "kind" to it.kind, "value" to it.value) },
        "refusals" to plan.refusals.map {
            mapOf("name" to it.name, "code" to it.code, "message" to it.message)
        },
        "values" to plan.values,
    )

    @Test
    @Suppress("UNCHECKED_CAST")
    fun inputPlanAgreesWithCorpus() {
        for (case in rows("inputs.json", "cases", 15)) {
            val declared = (case["declared"] as List<Map<String, Any?>>).map {
                RiveDeclaredInput(it["name"].toString(), it["type"].toString())
            }
            val bound = case["bound"] as Map<String, Any?>
            val previous = (case["previous"] as Map<String, Any?>)
                .mapValues { it.value.toString() }
            like(planMap(riveInputPlan(declared, bound, previous)), case["plan"], "${label(case)}.plan")
        }
    }

    // -- selection.json -----------------------------------------------------------------------

    private fun selectionMap(selection: RiveSelection): Map<String, Any?> = mapOf(
        "artboard" to selection.artboard,
        "stateMachine" to selection.stateMachine,
        "animation" to selection.animation,
        "mode" to selection.mode,
        "error" to selection.error?.let { mapOf("code" to it.code, "message" to it.message) },
    )

    @Suppress("UNCHECKED_CAST")
    private fun artboards(manifest: Map<String, Any?>): List<RiveArtboard> =
        (manifest["artboards"] as? List<Map<String, Any?>> ?: emptyList()).map { board ->
            RiveArtboard(
                board["name"].toString(),
                board["default"] == true,
                (board["stateMachines"] as? List<Any?> ?: emptyList()).map { it.toString() },
                (board["animations"] as? List<Any?> ?: emptyList()).map { it.toString() },
            )
        }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun selectionAgreesWithCorpus() {
        for (case in rows("selection.json", "cases", 12)) {
            val selection = riveSelection(
                artboards(case["manifest"] as Map<String, Any?>),
                case["attrs"] as Map<String, Any?>,
            )
            like(selectionMap(selection), case["selection"], "${label(case)}.selection")
        }
    }

    // -- fit.json -----------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun fitAndAlignmentAgreeWithCorpus() {
        for (case in rows("fit.json", "cases", 14)) {
            val content = case["content"] as List<Any?>
            val box = case["box"] as List<Any?>
            val placement = riveFit(
                case["fit"], case["alignment"],
                number(content[0]), number(content[1]), number(box[0]), number(box[1]),
            )
            val got = mapOf(
                "fit" to placement.fit,
                "alignment" to placement.alignment,
                "scaleX" to placement.scaleX,
                "scaleY" to placement.scaleY,
                "x" to placement.x,
                "y" to placement.y,
                "diagnostics" to placement.diagnostics.size,
            )
            like(got, case["placement"], "${label(case)}.placement")
        }
    }

    // -- playback.json ------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun playbackScheduleAgreesWithCorpus() {
        for (case in rows("playback.json", "schedule", 10)) {
            val fold = rivePlaybackSchedule(
                case["autoplay"] == true,
                case["events"] as List<Map<String, Any?>>,
            )
            val got = mapOf(
                "emitted" to fold.emitted.map {
                    mapOf("time" to it.time, "delta" to it.delta, "frame" to it.frame)
                },
                "starts" to fold.starts,
                "pauses" to fold.pauses,
                "instantiations" to fold.instantiations,
                "disposals" to fold.disposals,
                "drops" to fold.drops,
                "advancing" to fold.advancing,
                "live" to fold.live,
            )
            like(got, case["fold"], "${label(case)}.fold")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun residencyAgreesWithCorpus() {
        for (case in rows("playback.json", "residency", 6)) {
            val capacity = number(case["capacity"])
            val fold = riveResidency(capacity, case["events"] as List<Map<String, Any?>>)
            val got = mapOf(
                "live" to fold.live,
                "instantiated" to fold.instantiated,
                "disposed" to fold.disposed,
            )
            like(got, case["fold"], "${label(case)}.fold")
            val cap = if (capacity < 1.0) 1 else capacity.toInt()
            assertTrue(fold.live.size <= cap, "${label(case)}: live ${fold.live.size} exceeds the cap $cap")
        }
    }

    // -- events.json --------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun stateChangesAgreeWithCorpus() {
        for (case in rows("events.json", "stateChanges", 4)) {
            val emitted = riveStateChanges(
                case["machine"].toString(),
                case["states"] as List<Any?>,
            )
            like(
                emitted.map { mapOf("machine" to it.machine, "state" to it.state) },
                case["emitted"], "${label(case)}.emitted",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun eventPayloadsAgreeWithCorpus() {
        for (case in rows("events.json", "events", 5)) {
            val fold = riveEventPayload(case["event"], case["properties"] as? Map<String, Any?>)
            val got = mapOf(
                "payload" to fold.payload?.let {
                    mapOf("name" to it.name, "properties" to it.properties)
                },
                "dropped" to fold.dropped,
            )
            like(got, case["result"], "${label(case)}.result")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun loadPayloadsAgreeWithCorpus() {
        for (case in rows("events.json", "load", 2)) {
            val selection = case["selection"] as Map<String, Any?>
            val size = case["size"] as List<Any?>
            val payload = riveLoadPayload(
                RiveSelection(
                    selection["artboard"]?.toString(),
                    selection["stateMachine"]?.toString(),
                    selection["animation"]?.toString(),
                    selection["mode"].toString(),
                    null,
                ),
                number(size[0]), number(size[1]),
            )
            val got = mapOf(
                "artboard" to payload.artboard,
                "stateMachine" to payload.stateMachine,
                "animation" to payload.animation,
                "width" to payload.width,
                "height" to payload.height,
            )
            like(got, case["payload"], "${label(case)}.payload")
        }
    }

    @Test
    fun errorPayloadsAgreeWithCorpus() {
        for (case in rows("events.json", "errors", 6)) {
            val payload = riveErrorPayload(case["code"])
            like(
                mapOf("code" to payload.code, "message" to payload.message),
                case["payload"], "${label(case)}.payload",
            )
        }
    }

    // -- a11y.json ----------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun accessibilityVerdictAgreesWithCorpus() {
        for (case in rows("a11y.json", "cases", 12)) {
            val verdict = riveA11y(
                case["attrs"] as Map<String, Any?>,
                case["a11yChildren"] as? List<Map<String, Any?>>,
                case["listeners"] == true,
            )
            val got = mapOf(
                "interactive" to verdict.interactive,
                "label" to verdict.label,
                "children" to verdict.children.map {
                    mapOf("role" to it.role, "label" to it.label, "value" to it.value)
                },
                "role" to verdict.role,
                "hidden" to verdict.hidden,
                "lint" to verdict.lint?.let {
                    mapOf("code" to it.code, "level" to it.level, "message" to it.message)
                },
            )
            like(got, case["verdict"], "${label(case)}.verdict")
        }
    }

    /** lint_dsx.rb carries the same code and the same sentence; a change here that is not
     *  mirrored there is a rule that means two things. */
    @Test
    fun lintVerdictIsTheLintersRuleVerbatim() {
        val verdict = riveA11y(mapOf("on:tap" to "poke()"))
        assertEquals("rive-a11y-label", verdict.lint?.code)
        assertEquals("error", verdict.lint?.level)
        assertEquals(RIVE_A11Y_LINT_MESSAGE, verdict.lint?.message)
        assertTrue(RIVE_A11Y_LINT_MESSAGE.startsWith("<rive> with a gesture handler needs a11yLabel"))
    }
}
