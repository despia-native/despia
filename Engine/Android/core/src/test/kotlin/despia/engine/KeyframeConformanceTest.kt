package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The KEYFRAME corpus on this runtime (OpenSource/Conformance/motion/keyframes.json) - the same
 * file the TS core runs (packages/kernel/test/keyframes-conformance.test.ts) and the Swift twin
 * is judged against (record lane, KeyframeConformance). Distinct from MotionConformanceTest,
 * which runs the UI-motion corpus (curves/spring/retarget/physics) over a different kernel.
 *
 * THE REFERENCE IS THE BROWSER. The web renderer never calls a DSX motion core, because a
 * browser owns its own animations; every expectation in the corpus is what CSS itself does, and
 * this suite is how the native lane proves it agrees. That is the whole point of runtime-pressure
 * R28: `@keyframes` reached these sheets verbatim and was dropped, so the catalogue promised the
 * author motion on every target while two targets silently disagreed.
 *
 * Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
 */
class KeyframeConformanceTest {

    private fun corpus(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/motion/keyframes.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/motion/keyframes.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(corpus().readText()).foundationValue as? Map<String, Any?>
            ?: error("keyframes.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun group(key: String): List<Map<String, Any?>> {
        val list = doc()[key] as? List<*> ?: error("keyframes.json: no $key group")
        assertTrue(list.isNotEmpty(), "keyframes.json: $key is empty")
        return list.map { it as Map<String, Any?> }
    }

    @Suppress("UNCHECKED_CAST")
    private fun rules(any: Any?): List<Pair<String, Map<String, String>>> =
        (any as? List<*> ?: emptyList<Any?>()).map {
            val row = it as Map<String, Any?>
            val declarations = (row["declarations"] as? Map<String, Any?> ?: emptyMap())
                .mapValues { entry -> entry.value.toString() }
            (row["selector"] as? String ?: "") to declarations
        }

    private fun num(any: Any?): Double = when (any) {
        is Number -> any.toDouble()
        is String -> any.toDoubleOrNull() ?: 0.0
        else -> 0.0
    }

    @Test
    fun theShorthandParsesTheWayCssReadsIt() {
        for (case in group("parse")) {
            val note = case["note"] as? String ?: ""
            val shorthand = case["shorthand"] as? String ?: ""
            @Suppress("UNCHECKED_CAST")
            val want = case["expect"] as Map<String, Any?>
            val got = MotionCore.parseAnimation(shorthand)
            assertEquals(want["name"], got.name, "$note - name")
            assertEquals(num(want["duration"]), got.duration, "$note - duration")
            assertEquals(num(want["delay"]), got.delay, "$note - delay")
            assertEquals(want["easing"], got.easing, "$note - easing")
            assertEquals(num(want["iterations"]), got.iterations, "$note - iterations")
            assertEquals(want["direction"], got.direction, "$note - direction")
            assertEquals(want["fill"], got.fill, "$note - fill")
            assertEquals(want["paused"], got.paused, "$note - paused")
            assertEquals(want["none"], got.none, "$note - none")
        }
    }

    @Test
    fun aKeyframesBodyNormalizesToOrderedStops() {
        for (case in group("normalize")) {
            val name = case["name"] as? String ?: ""
            val got = MotionCore.keyframeTimeline(rules(case["rules"]))
            @Suppress("UNCHECKED_CAST")
            val want = case["expect"] as List<Map<String, Any?>>
            assertEquals(want.size, got.size, "$name - stop count")
            for (i in want.indices) {
                assertEquals(num(want[i]["offset"]), got[i].offset, "$name - stop $i offset")
                @Suppress("UNCHECKED_CAST")
                val decls = (want[i]["declarations"] as Map<String, Any?>)
                    .mapValues { it.value.toString() }
                assertEquals(decls, got[i].declarations, "$name - stop $i declarations")
            }
        }
    }

    @Test
    fun samplingAtTIsWhatTheBrowserShowsAtT() {
        val timelines = HashMap<String, List<Pair<String, Map<String, String>>>>()
        for (case in group("normalize")) {
            timelines[case["name"] as? String ?: ""] = rules(case["rules"])
        }
        for (case in group("sample")) {
            val note = case["note"] as? String ?: ""
            val key = case["timeline"] as? String ?: ""
            val source = timelines[key] ?: error("$key is not a corpus timeline")
            val spec = MotionCore.parseAnimation(case["shorthand"] as? String ?: "")
            val got = MotionCore.sampleMotion(
                MotionCore.keyframeTimeline(source), spec, num(case["elapsed"]),
            )
            @Suppress("UNCHECKED_CAST")
            val want = case["expect"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val values = (want["values"] as Map<String, Any?>).mapValues { it.value.toString() }
            @Suppress("UNCHECKED_CAST")
            val dropped = (want["dropped"] as List<Any?>).map { it.toString() }
            val where = "$note - $key ${case["shorthand"]} @${case["elapsed"]}ms"
            assertEquals(values, got.values, "$where - values")
            assertEquals(dropped, got.dropped, "$where - dropped")
            assertEquals(want["active"], got.active, "$where - active")
        }
    }

    @Test
    fun everyLonghandMeansSomethingOrTheCatalogueIsLying() {
        for (case in group("spec")) {
            val note = case["note"] as? String ?: ""
            @Suppress("UNCHECKED_CAST")
            val attrs = (case["attrs"] as? Map<String, Any?> ?: emptyMap())
                .mapValues { it.value.toString() }
            @Suppress("UNCHECKED_CAST")
            val want = case["expect"] as Map<String, Any?>
            val got = MotionCore.animationSpec(attrs)
            assertEquals(want["name"], got.name, "$note - name")
            assertEquals(num(want["duration"]), got.duration, "$note - duration")
            assertEquals(num(want["delay"]), got.delay, "$note - delay")
            assertEquals(want["easing"], got.easing, "$note - easing")
            assertEquals(num(want["iterations"]), got.iterations, "$note - iterations")
            assertEquals(want["direction"], got.direction, "$note - direction")
            assertEquals(want["fill"], got.fill, "$note - fill")
            assertEquals(want["paused"], got.paused, "$note - paused")
            assertEquals(want["none"], got.none, "$note - none")
        }
    }

    @Test
    fun aSampledFrameDecomposesIntoTheAttributesTheLadderApplies() {
        for (case in group("attributes")) {
            val note = case["note"] as? String ?: ""
            @Suppress("UNCHECKED_CAST")
            val values = (case["values"] as? Map<String, Any?> ?: emptyMap())
                .mapValues { it.value.toString() }
            @Suppress("UNCHECKED_CAST")
            val want = case["expect"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val attributes = (want["attributes"] as Map<String, Any?>)
                .mapValues { it.value.toString() }
            @Suppress("UNCHECKED_CAST")
            val unsupported = (want["unsupported"] as List<Any?>).map { it.toString() }
            val got = MotionCore.motionAttributes(values)
            assertEquals(attributes, got.attributes, "$note - attributes")
            assertEquals(unsupported, got.unsupported, "$note - unsupported")
        }
    }

    @Test
    fun infiniteIsANumberAndTheAllowlistIsThePromise() {
        assertEquals(-1.0, MotionCore.INFINITE)
        assertEquals(MotionCore.INFINITE, MotionCore.parseAnimation("x 1s infinite").iterations)
        @Suppress("UNCHECKED_CAST")
        val animatable = (doc()["animatable"] as List<Any?>).map { it.toString() }
        @Suppress("UNCHECKED_CAST")
        val keys = (doc()["animationKeys"] as List<Any?>).map { it.toString() }
        assertEquals(animatable, MotionCore.PROPERTIES)
        assertEquals(keys, MotionCore.ANIMATION_KEYS)
    }

    @Test
    fun aLoopIsPeriodicToTheMillisecond() {
        val timeline = MotionCore.keyframeTimeline(
            listOf(
                "0%, 80%, 100%" to mapOf("opacity" to "0.28", "transform" to "scale(0.82)"),
                "40%" to mapOf("opacity" to "1", "transform" to "scale(1)"),
            ),
        )
        val spec = MotionCore.parseAnimation("pulse 1.2s ease-in-out infinite")
        for (t in listOf(0.0, 137.0, 450.0, 900.0, 1199.0)) {
            assertEquals(
                MotionCore.sampleMotion(timeline, spec, t).values,
                MotionCore.sampleMotion(timeline, spec, t + 1200.0).values,
                "t=$t and t+period disagree",
            )
            assertTrue(
                MotionCore.sampleMotion(timeline, spec, t + 1_200_000.0).active,
                "an infinite loop never ends",
            )
        }
    }
}

/**
 * The resolver half of R28: keyframes reach the generated sheets verbatim, so the lookup that
 * finds them is the seam between "the sheet carries it" and "the frame loop can sample it".
 * These are the cases a corpus of pure sampling cannot state, because they are about the SHEET.
 */
class MotionKeyframeLookupTest {

    /** The sheets are DELIVERED as the compiled IR, so the fixtures are built the same way. */
    private fun sheet(json: String): CSSSheet =
        CSSSheet.fromJson(json) ?: error("fixture sheet did not decode")

    private fun stop(selector: String, property: String, value: String): String =
        """{"type":"rule","selector":"$selector","declarations":[{"property":"$property","value":"$value"}],"children":[]}"""

    private fun keyframes(name: String, vararg stops: String): String =
        """{"type":"at","name":"keyframes","prelude":"$name","declarations":[],"children":[${stops.joinToString(",")}]}"""

    private fun ctx(vararg classes: String): CSSResolver.Context =
        CSSResolver.Context(classes = classes.toSet())

    @Test
    fun aKeyframesBlockIsFoundByNameAndNormalized() {
        val s = sheet(
            """{"rules":[${keyframes("pulse",
                stop("0%, 80%, 100%", "opacity", "0.28"),
                stop("40%", "opacity", "1"))}]}""",
        )
        val timeline = CSSResolver.keyframes(s, "pulse", ctx("dot"))
        assertEquals(4, timeline.size, "0%, 80% and 100% are three stops, plus 40%")
        assertEquals(0.0, timeline[0].offset)
        assertEquals("0.28", timeline[0].declarations["opacity"])
        assertEquals(0.4, timeline[1].offset)
        assertEquals("1", timeline[1].declarations["opacity"])
    }

    @Test
    fun anUnknownNameIsAnEmptyTimelineRatherThanAThrow() {
        val s = sheet("""{"rules":[${keyframes("pulse", stop("from", "opacity", "0"))}]}""")
        assertTrue(CSSResolver.keyframes(s, "spin", ctx()).isEmpty())
    }

    @Test
    fun theLastBlockWinsOnADuplicateName() {
        val s = sheet(
            """{"rules":[${keyframes("x", stop("from", "opacity", "0"), stop("to", "opacity", "0.5"))},
                        ${keyframes("x", stop("from", "opacity", "0"), stop("to", "opacity", "1"))}]}""",
        )
        val timeline = CSSResolver.keyframes(s, "x", ctx())
        assertEquals("1", timeline.last().declarations["opacity"], "CSS keeps the later block")
    }

    @Test
    fun theDeclarationPathStillDoesNotSurfaceKeyframes() {
        // The reason `keyframes()` is its own lookup: a keyframe is a TABLE the element's
        // `animation` names, not a declaration that applies to the element.
        val s = sheet(
            """{"rules":[${keyframes("x", stop("from", "opacity", "0"), stop("to", "opacity", "1"))},
                        {"type":"rule","selector":".a","declarations":[{"property":"color","value":"red"}],"children":[]}]}""",
        )
        val decls = CSSResolver.declarations(s, ctx("a"), emptyMap())
        assertEquals("red", decls["color"])
        assertTrue(!decls.containsKey("opacity"), "a keyframe stop must never leak into paint")
    }
}

/**
 * The whole R28 path on one fixture, sheet to style attribute: the shipped ThinkingOrb shape -
 * a `@keyframes` block, one rule that names it with the shorthand, and a second rule that
 * staggers a sibling with the `animation-delay` LONGHAND alone.
 *
 * Every earlier suite tests one link. This is the chain: register -> resolve -> bridge -> fold
 * the spec -> look the table up -> sample -> decompose into the attributes StackStyle applies.
 * The stagger is the case that mattered most and was hardest to see: three dots that pulse in
 * lockstep instead of in sequence is not a crash, not a log line, and not something a unit test
 * of any single link would notice.
 */
class KeyframePipelineTest {

    private val thinkingOrb = """
        {"rules":[
          {"type":"at","name":"keyframes","prelude":"dsx-thinking-pulse","declarations":[],"children":[
            {"type":"rule","selector":"0%, 80%, 100%","children":[],"declarations":[
              {"property":"opacity","value":"0.28"},{"property":"transform","value":"scale(0.82)"}]},
            {"type":"rule","selector":"40%","children":[],"declarations":[
              {"property":"opacity","value":"1"},{"property":"transform","value":"scale(1)"}]}]},
          {"type":"rule","selector":".dsx-thinking-dot","children":[],"declarations":[
            {"property":"opacity","value":"0.75"},
            {"property":"animation","value":"dsx-thinking-pulse 1.2s ease-in-out infinite"}]},
          {"type":"rule","selector":".dsx-thinking-dot-2","children":[],"declarations":[
            {"property":"animation-delay","value":"0.16s"}]}]}
    """.trimIndent()

    private fun attrs(vararg classes: String): Map<String, String> {
        CSSEngine.reset()
        CSSEngine.register("ThinkingOrb", thinkingOrb)
        return CSSEngine.sheetAttributes(
            "ThinkingOrb", CSSResolver.Context(classes = classes.toSet()),
        )
    }

    @Test
    fun theShorthandAndTheDelayLonghandBothSurviveTheBridge() {
        val dot = attrs("dsx-thinking-dot")
        assertEquals("dsx-thinking-pulse 1.2s ease-in-out infinite", dot["animation"])
        assertEquals("0.75", dot["opacity"])
        val second = attrs("dsx-thinking-dot", "dsx-thinking-dot-2")
        assertEquals("0.16s", second["animationDelay"], "the stagger rides the longhand alone")
    }

    @Test
    fun theStaggeredSiblingIsBehindTheFirstByExactlyItsDelay() {
        val ctx = CSSResolver.Context(classes = setOf("dsx-thinking-dot", "dsx-thinking-dot-2"))
        val first = MotionCore.animationSpec(attrs("dsx-thinking-dot"))
        val second = MotionCore.animationSpec(attrs("dsx-thinking-dot", "dsx-thinking-dot-2"))
        assertEquals(0.0, first.delay)
        assertEquals(160.0, second.delay)
        assertEquals(first.name, second.name, "the delay longhand must not disturb the name")
        assertEquals(MotionCore.INFINITE, second.iterations)

        val timeline = CSSEngine.keyframes("ThinkingOrb", first.name, ctx)
        assertEquals(4, timeline.size)
        // The stagger IS the offset: dot 2 at t shows what dot 1 showed 160 ms earlier.
        for (t in listOf(200.0, 640.0, 1_000.0, 5_000.0)) {
            assertEquals(
                MotionCore.sampleMotion(timeline, first, t - 160.0).values,
                MotionCore.sampleMotion(timeline, second, t).values,
                "dot 2 at ${t}ms must be dot 1 at ${t - 160}ms",
            )
        }
    }

    @Test
    fun aSampledFrameArrivesAsAttributesTheStyleLadderAlreadyApplies() {
        val ctx = CSSResolver.Context(classes = setOf("dsx-thinking-dot"))
        val spec = MotionCore.animationSpec(attrs("dsx-thinking-dot"))
        val timeline = CSSEngine.keyframes("ThinkingOrb", spec.name, ctx)

        val start = MotionCore.motionAttributes(
            MotionCore.sampleMotion(timeline, spec, 0.0).values,
        )
        assertTrue(start.unsupported.isEmpty(), "a uniform scale decomposes exactly")
        assertEquals(setOf("opacity", "scale"), start.attributes.keys)
        assertEquals("0.28", start.attributes["opacity"])
        assertEquals("0.82", start.attributes["scale"])

        // The peak stop sits at OFFSET 0.4, which is not the same instant as 40% of the
        // duration: `ease-in-out` is slow to start, so the eased fraction at t=480ms is below
        // 0.4 and the dot has not peaked yet. Getting this backwards is how an eased loop ends
        // up looking like a linear one.
        val atFourTenths = MotionCore.sampleMotion(timeline, spec, 480.0).values
        assertTrue(
            atFourTenths["opacity"]!!.toDouble() < 1.0,
            "ease-in-out has not reached the 40% stop by 40% of the duration",
        )
        val later = MotionCore.sampleMotion(timeline, spec, 560.0).values
        assertTrue(
            later["opacity"]!!.toDouble() > atFourTenths["opacity"]!!.toDouble(),
            "the dot is still brightening on its way to the peak",
        )
    }

    @Test
    fun aKeyframeStopNeverLeaksIntoTheElementsOwnPaint() {
        val dot = attrs("dsx-thinking-dot")
        assertEquals("0.75", dot["opacity"], "the RULE's opacity, never a stop's")
        assertTrue(!dot.containsKey("scale"), "a stop's transform is not a declaration on the element")
    }
}
