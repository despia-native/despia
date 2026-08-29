package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The `<scroll>` conformance runner — executes every file in OpenSource/Conformance/scroll/
 * through this runtime (the TS and Swift runners execute the SAME files). The law and the
 * reasoning are in that corpus's README.
 *
 * The two rules worth restating, because they are the ones a renderer is tempted to break:
 * `on:scroll` NEVER dispatches when no handler is bound and is otherwise coalesced to the display
 * link, and `--scroll-*` is a pure function of one sample so it resolves on the render thread with
 * nothing crossing the bus.
 *
 * Missing corpus = loud failure; a silently-skipped conformance suite is how drift starts.
 */
class ScrollLinkedConformanceTest {

    private fun corpus(file: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/scroll/$file")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/scroll/$file not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(file: String): List<Map<String, Any?>> {
        val doc = json(corpus(file).readText()).foundationValue as? Map<String, Any?>
            ?: error("$file: not a JSON object")
        val list = doc["cases"] as? List<*> ?: error("$file: no cases")
        assertTrue(list.isNotEmpty(), "$file: corpus is empty")
        return list.map { it as Map<String, Any?> }
    }

    private fun num(any: Any?): Double = ScrollCore.finite(any)
    private fun name(case: Map<String, Any?>): String = case["name"] as? String ?: "(unnamed)"

    @Suppress("UNCHECKED_CAST")
    private fun map(any: Any?): Map<String, Any?> = (any as? Map<String, Any?>) ?: emptyMap()

    @Suppress("UNCHECKED_CAST")
    private fun frames(any: Any?): List<ScrollChildFrame> =
        (any as? List<*> ?: emptyList<Any?>()).map {
            val child = it as Map<String, Any?>
            ScrollChildFrame(num(child["start"]), num(child["length"]))
        }

    private fun metricsOf(any: Any?): ScrollMetrics {
        val g = map(any)
        return ScrollCore.metrics(
            g["x"], g["y"], g["viewportWidth"], g["viewportHeight"], g["contentWidth"], g["contentHeight"],
        )
    }

    private fun assertMetrics(expect: Map<String, Any?>, got: ScrollMetrics, label: String) {
        assertEquals(num(expect["x"]), got.x, "$label — x")
        assertEquals(num(expect["y"]), got.y, "$label — y")
        assertEquals(num(expect["maxX"]), got.maxX, "$label — maxX")
        assertEquals(num(expect["maxY"]), got.maxY, "$label — maxY")
        assertEquals(num(expect["progress"]), got.progress, "$label — progress")
        assertEquals(num(expect["progressX"]), got.progressX, "$label — progressX")
        assertEquals(expect["atTop"] as Boolean, got.atTop, "$label — atTop")
        assertEquals(expect["atBottom"] as Boolean, got.atBottom, "$label — atBottom")
        assertEquals(expect["atStart"] as Boolean, got.atStart, "$label — atStart")
        assertEquals(expect["atEnd"] as Boolean, got.atEnd, "$label — atEnd")
    }

    @Test
    fun metrics() {
        for (case in cases("metrics.json")) {
            assertMetrics(map(case["expect"]), metricsOf(case["geometry"]), name(case))
        }
    }

    @Test
    fun events() {
        var motion = 0
        var coalesce = 0
        var reach = 0
        for (case in cases("events.json")) {
            val label = name(case)
            val expect = map(case["expect"])
            when {
                case["previous"] != null -> {
                    motion += 1
                    val previous = map(case["previous"])
                    val next = map(case["next"])
                    val got = ScrollCore.motion(
                        ScrollSample(num(previous["x"]), num(previous["y"]), num(previous["t"])),
                        ScrollSample(num(next["x"]), num(next["y"]), num(next["t"])),
                        case["previousDirection"] as? String,
                    )
                    assertEquals(num(expect["dx"]), got.dx, "$label — dx")
                    assertEquals(num(expect["dy"]), got.dy, "$label — dy")
                    assertEquals(num(expect["velocityX"]), got.velocityX, "$label — velocityX")
                    assertEquals(num(expect["velocityY"]), got.velocityY, "$label — velocityY")
                    assertEquals(num(expect["velocity"]), got.velocity, "$label — velocity")
                    assertEquals(expect["direction"] as String, got.direction, "$label — direction")
                }
                case["samples"] != null -> {
                    coalesce += 1
                    val samples = (case["samples"] as List<*>).toList()
                    val got = ScrollCore.coalesce(
                        samples,
                        case["hasHandler"] as Boolean,
                        num(case["frameBudgetMs"]),
                    )
                    assertEquals((expect["dispatches"] as Number).toInt(), got.dispatches, "$label — dispatches")
                    val at = (expect["at"] as List<*>).map { num(it) }
                    assertEquals(at, got.at, "$label — dispatch times")
                }
                else -> {
                    reach += 1
                    val got = ScrollCore.reachEnd(
                        case["latched"] as Boolean,
                        metricsOf(case["geometry"]),
                        case["threshold"],
                        case["axis"] as String,
                    )
                    assertEquals(expect["fire"] as Boolean, got.fire, "$label — fire")
                    assertEquals(expect["latched"] as Boolean, got.latched, "$label — latched")
                    assertEquals(num(expect["remaining"]), got.remaining, "$label — remaining")
                }
            }
        }
        assertTrue(motion > 0 && coalesce > 0 && reach > 0, "events.json lost one of its three groups")
    }

    @Test
    fun imperative() {
        for (case in cases("imperative.json")) {
            val label = name(case)
            val command = map(case["command"])
            val geometry = map(case["geometry"])
            val childMap = command["child"]
            val got = ScrollCore.resolveCommand(
                kind = command["kind"] as String,
                m = metricsOf(case["geometry"]),
                viewportWidth = geometry["viewportWidth"],
                viewportHeight = geometry["viewportHeight"],
                axis = case["axis"] as String,
                animated = command["animated"] as? Boolean ?: true,
                toX = if (command.containsKey("x")) num(command["x"]) else null,
                toY = if (command.containsKey("y")) num(command["y"]) else null,
                child = if (childMap == null) null else {
                    val c = map(childMap)
                    ScrollChildFrame(num(c["start"]), num(c["length"]))
                },
                align = command["align"] as? String ?: "nearest",
            )
            val expect = case["expect"]
            if (expect == null) {
                assertNull(got, "$label — expected a refusal")
                continue
            }
            val e = map(expect)
            checkNotNull(got) { "$label — expected a target" }
            assertEquals(num(e["x"]), got.x, "$label — x")
            assertEquals(num(e["y"]), got.y, "$label — y")
            assertEquals(e["animated"] as Boolean, got.animated, "$label — animated")
        }
    }

    @Test
    fun snapAndMaintainPosition() {
        var snaps = 0
        var maintains = 0
        for (case in cases("snap.json")) {
            val label = name(case)
            if (case["mode"] != null) {
                snaps += 1
                val got = ScrollCore.resolveSnap(
                    case["mode"] as String,
                    case["offset"],
                    case["viewportLength"],
                    case["contentLength"],
                    frames(case["children"]),
                    case["velocity"],
                )
                val expect = case["expect"]
                if (expect == null) assertNull(got, "$label — expected no snap target")
                else assertEquals(num(expect), got, "$label — target")
            } else {
                maintains += 1
                val expect = map(case["expect"])
                val got = ScrollCore.maintainPosition(
                    case["offset"], case["anchorBefore"], case["anchorAfter"],
                    case["viewportLength"], case["contentLength"],
                )
                assertEquals(num(expect["offset"]), got.offset, "$label — offset")
                assertEquals(num(expect["delta"]), got.delta, "$label — delta")
            }
        }
        assertTrue(snaps > 0 && maintains > 0, "snap.json lost one of its two groups")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun linked() {
        var published = 0
        var namedPublished = 0
        var scopes = 0
        var evaluated = 0
        for (case in cases("linked.json")) {
            val label = name(case)
            when {
                case["ref"] != null -> {
                    namedPublished += 1
                    val got = ScrollCore.namedLinkedProperties(
                        case["ref"] as String, case["axis"] as String,
                        metricsOf(case["geometry"]), case["velocity"],
                    )
                    assertEquals(strings(case["expect"]), got, label)
                }
                case["geometry"] != null -> {
                    published += 1
                    val got = ScrollCore.linkedProperties(
                        case["axis"] as String, metricsOf(case["geometry"]), case["velocity"],
                    )
                    assertEquals(strings(case["expect"]), got, label)
                }
                case["ancestors"] != null -> {
                    scopes += 1
                    val ancestors = (case["ancestors"] as List<*>).map {
                        val a = it as Map<String, Any?>
                        ScrollLinkedAncestor(a["axis"] as String, strings(a["properties"]))
                    }
                    val named = ((case["named"] ?: emptyList<Any?>()) as List<*>).map {
                        val n = it as Map<String, Any?>
                        NamedScrollPlane(n["ref"] as String, strings(n["properties"]))
                    }
                    assertEquals(
                        strings(case["expect"]),
                        ScrollCore.resolveLinkedScope(ancestors, named),
                        label,
                    )
                }
                else -> {
                    evaluated += 1
                    val got = ScrollCore.evaluateLinked(
                        case["expression"] as String, strings(case["properties"]),
                    )
                    assertEquals(case["expect"] as? String, got, label)
                }
            }
        }
        assertTrue(
            published > 0 && namedPublished > 0 && scopes > 0 && evaluated > 0,
            "linked.json lost one of its four groups",
        )
    }

    private fun strings(any: Any?): Map<String, String> =
        map(any).entries.associate { (key, value) -> key to (value as String) }

    @Test
    fun collapse() {
        var states = 0
        var emits = 0
        for (case in cases("collapse.json")) {
            val label = name(case)
            if (case["input"] != null) {
                states += 1
                val input = map(case["input"])
                val expect = map(case["expect"])
                val got = ScrollCore.collapse(
                    scrollY = input["scrollY"],
                    height = input["height"] ?: 280.0,
                    minHeight = input["minHeight"] ?: ScrollCore.NAV_BAR_HEIGHT,
                    pinnedHeight = input["pinnedHeight"] ?: 0.0,
                    parallax = input["parallax"] ?: 0.5,
                    stretch = input["stretch"] as? Boolean ?: true,
                    blurOnCollapse = input["blurOnCollapse"] as? Boolean ?: false,
                    titleTransition = input["titleTransition"] as? String ?: "move",
                    reduceMotion = input["reduceMotion"] as? Boolean ?: false,
                )
                assertEquals(num(expect["fraction"]), got.fraction, "$label — fraction")
                assertEquals(num(expect["headerHeight"]), got.headerHeight, "$label — headerHeight")
                assertEquals(num(expect["effectiveMinHeight"]), got.effectiveMinHeight, "$label — effectiveMinHeight")
                assertEquals(num(expect["imageTranslation"]), got.imageTranslation, "$label — imageTranslation")
                assertEquals(num(expect["imageScale"]), got.imageScale, "$label — imageScale")
                assertEquals(num(expect["effectiveParallax"]), got.effectiveParallax, "$label — effectiveParallax")
                assertEquals(num(expect["headerTitleOpacity"]), got.headerTitleOpacity, "$label — headerTitleOpacity")
                assertEquals(num(expect["navBarTitleOpacity"]), got.navBarTitleOpacity, "$label — navBarTitleOpacity")
                assertEquals(expect["titleOwner"] as String, got.titleOwner, "$label — titleOwner")
                assertEquals(num(expect["blurRadius"]), got.blurRadius, "$label — blurRadius")
                assertEquals(num(expect["pinnedOffset"]), got.pinnedOffset, "$label — pinnedOffset")
            } else {
                emits += 1
                val expect = map(case["expect"])
                val previous = case["previousFraction"]
                val got = ScrollCore.shouldEmitCollapse(
                    if (previous == null) null else num(previous),
                    num(case["fraction"]),
                )
                assertEquals(expect["emit"] as Boolean, got, label)
            }
        }
        assertTrue(states > 0 && emits > 0, "collapse.json lost one of its two groups")
    }

    @Test
    fun config() {
        for (case in cases("config.json")) {
            val label = name(case)
            val attributes = map(case["attributes"]).entries.associate { (key, value) -> key to value as String? }
            val expect = map(case["expect"])
            val got = ScrollCore.parseConfig(attributes)
            assertEquals(expect["axis"] as String, got.axis, "$label — axis")
            assertEquals(expect["bind"] as String?, got.bind, "$label — bind")
            assertEquals(expect["indicators"] as Boolean, got.indicators, "$label — indicators")
            assertEquals(expect["bounces"] as Boolean?, got.bounces, "$label — bounces")
            assertEquals(expect["paging"] as Boolean, got.paging, "$label — paging")
            assertEquals(expect["snap"] as String, got.snap, "$label — snap")
            assertEquals(expect["keyboardDismiss"] as String, got.keyboardDismiss, "$label — keyboardDismiss")
            assertEquals(expect["overscroll"] as String, got.overscroll, "$label — overscroll")
            assertEquals(expect["maintainPosition"] as Boolean, got.maintainPosition, "$label — maintainPosition")
            assertEquals(num(expect["threshold"]), got.threshold, "$label — threshold")
            val inset = map(expect["contentInset"])
            assertEquals(
                ScrollEdgeInsets(num(inset["top"]), num(inset["right"]), num(inset["bottom"]), num(inset["left"])),
                got.contentInset,
                "$label — contentInset",
            )
        }
    }

    // ---------------------------------------------------------------- properties the corpus cannot state

    @Test
    fun noHandlerBoundMeansZeroDispatches() {
        val train = (0 until 600).map { (it * 4).toDouble() }
        assertEquals(0, ScrollCore.coalesce(train, false).dispatches)
        assertEquals(0, ScrollCore.coalesce(train, false, 0.0).dispatches)
        for (t in train) assertFalse(ScrollCore.shouldDispatch(false, null, t))
    }

    @Test
    fun metricsAreTotalAndProgressNeverLeavesTheRange() {
        val wild = listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -1e9, 0.0, 1e9)
        for (y in wild) {
            for (contentHeight in wild) {
                for (viewportHeight in listOf(0.0, 800.0)) {
                    val m = ScrollCore.metrics(0.0, y, 390.0, viewportHeight, 390.0, contentHeight)
                    assertTrue(m.progress in 0.0..1.0, "progress left the range for $y/$contentHeight")
                    assertTrue(m.maxY >= 0.0, "maxY went negative")
                    assertTrue(m.y.isFinite() && m.progress.isFinite(), "a non-finite escaped")
                }
            }
        }
    }

    @Test
    fun reachEndFiresExactlyOncePerCrossing() {
        var latched = false
        var fired = 0
        for (y in listOf(0.0, 400.0, 900.0, 1200.0, 1200.0, 1200.0, 1199.9, 1200.0)) {
            val state = ScrollCore.reachEnd(latched, ScrollCore.metrics(0.0, y, 390.0, 800.0, 390.0, 2000.0), 0.0, "vertical")
            if (state.fire) fired += 1
            latched = state.latched
        }
        assertEquals(1, fired, "a latched reachEnd is what stops the duplicate-page bug")
        latched = ScrollCore.reachEnd(latched, ScrollCore.metrics(0.0, 200.0, 390.0, 800.0, 390.0, 2000.0), 0.0, "vertical").latched
        assertTrue(ScrollCore.reachEnd(latched, ScrollCore.metrics(0.0, 1200.0, 390.0, 800.0, 390.0, 2000.0), 0.0, "vertical").fire)
    }

    @Test
    fun directionIsStickyUnderTheTolerance() {
        var direction = "none"
        direction = ScrollCore.motion(ScrollSample(0.0, 600.0, 0.0), ScrollSample(0.0, 700.0, 100.0), direction).direction
        assertEquals("down", direction)
        for (i in 0 until 20) {
            val y = 700.0 + if (i % 2 == 0) 0.25 else -0.25
            direction = ScrollCore.motion(
                ScrollSample(0.0, 700.0, 100.0 + i * 8.0),
                ScrollSample(0.0, y, 100.0 + i * 8.0),
                direction,
            ).direction
            assertEquals("down", direction, "flipped on jitter $i")
        }
    }

    @Test
    fun theEvaluatorDropsWhatItCannotType() {
        val props = mapOf("--scroll-y" to "600", "--scroll-y-px" to "600px")
        for (bad in listOf(
            "calc(8px * 8px)", "calc(8px / 2px)", "calc(8px / 0)", "calc(8px + 2)",
            "calc(8px + 2rem)", "calc(var(--missing))", "calc(1 +)", "calc()", "calc(1 2)", "calc(red)",
        )) {
            assertNull(ScrollCore.evaluateLinked(bad, props), bad)
        }
        assertEquals("300px", ScrollCore.evaluateLinked("calc(var(--scroll-y-px) * 0.5)", props))
        assertEquals("1", ScrollCore.evaluateLinked("calc(var(--scroll-x, 0) + 1)", props))
    }

    @Test
    fun numberFormattingAgreesOnTheAwkwardValues() {
        assertEquals("0", ScrollCore.formatNumber(0.0))
        assertEquals("0", ScrollCore.formatNumber(-0.0))
        assertEquals("0", ScrollCore.formatNumber(-0.00001))
        assertEquals("1200", ScrollCore.formatNumber(1200.0))
        assertEquals("0.5", ScrollCore.formatNumber(0.5))
        assertEquals("0.3333", ScrollCore.formatNumber(1.0 / 3.0))
        assertEquals("-0.3333", ScrollCore.formatNumber(-1.0 / 3.0))
        assertEquals("0.6667", ScrollCore.formatNumber(2.0 / 3.0))
        assertEquals("0", ScrollCore.formatNumber(Double.NaN))
        assertEquals("0", ScrollCore.formatNumber(Double.POSITIVE_INFINITY))
    }

    @Test
    fun theTitleIsExactlyOneAccessibilityElementAtEveryFraction() {
        var step = -40
        while (step <= 300) {
            val state = ScrollCore.collapse(scrollY = step.toDouble(), height = 280.0, minHeight = 56.0)
            val visible = (if (state.headerTitleOpacity > 0) 1 else 0) + (if (state.navBarTitleOpacity > 0) 1 else 0)
            assertTrue(visible <= 1, "two titles visible at scrollY $step")
            val expected = if (state.fraction >= ScrollCore.TITLE_HANDOFF_FRACTION) "navbar" else "header"
            assertEquals(expected, state.titleOwner, "owner disagreed with the hand-off at $step")
            step += 1
        }
    }

    @Test
    fun thePinnedSlotSurvivesAFullCollapse() {
        val state = ScrollCore.collapse(scrollY = 10_000.0, height = 280.0, minHeight = 56.0, pinnedHeight = 88.0)
        assertEquals(1.0, state.fraction)
        assertEquals(88.0, state.effectiveMinHeight, "minHeight must not clip content that survives the collapse")
        assertEquals(88.0, state.headerHeight)
        assertEquals(0.0, state.pinnedOffset, "the pinned slot sits on the header's bottom edge")
    }

    @Test
    fun reducedMotionDisablesParallaxAndKeepsTheCollapse() {
        val moving = ScrollCore.collapse(scrollY = 112.0, height = 280.0, minHeight = 56.0)
        val reduced = ScrollCore.collapse(scrollY = 112.0, height = 280.0, minHeight = 56.0, reduceMotion = true)
        assertEquals(moving.fraction, reduced.fraction, "the collapse is layout, and layout still happens")
        assertEquals(moving.headerHeight, reduced.headerHeight)
        assertEquals(0.0, reduced.imageTranslation)
        assertEquals(0.0, reduced.effectiveParallax)
        // Stretch tracks the finger one to one, so it is not what the vestibular guidance is about.
        assertEquals(1.5, ScrollCore.collapse(scrollY = -140.0, height = 280.0, minHeight = 56.0, reduceMotion = true).imageScale)
    }

    @Test
    fun theCollapseFractionIsMonotoneAndBounded() {
        var previous = -1.0
        var y = -200
        while (y <= 600) {
            val f = ScrollCore.collapse(scrollY = y.toDouble(), height = 280.0, minHeight = 56.0).fraction
            assertTrue(f in 0.0..1.0, "fraction left the range at $y")
            assertTrue(f >= previous, "fraction went backwards at $y")
            previous = f
            y += 1
        }
    }

    @Test
    fun theAttributeTableIsTotal() {
        val junk = listOf("", "   ", "yes", "TRUE", "0", "nope", "12;drop", "-", "NaN")
        for (value in junk) {
            for (key in listOf(
                "axis", "indicators", "bounces", "paging", "snap", "keyboardDismiss",
                "overscroll", "contentInset", "maintainPosition", "threshold",
            )) {
                val config = ScrollCore.parseConfig(mapOf(key to value))
                assertTrue(config.axis == "vertical" || config.axis == "horizontal", "$key=$value")
                assertTrue(config.snap in listOf("none", "start", "center", "end", "page"), "$key=$value")
                assertTrue(config.threshold >= 0.0 && config.threshold.isFinite(), "$key=$value")
            }
        }
        assertNull(ScrollCore.parseConfig(emptyMap()).bounces, "bounces is tristate: unset means the platform decides")
        assertEquals(false, ScrollCore.parseConfig(mapOf("bounces" to "false")).bounces)
        assertEquals("page", ScrollCore.parseConfig(mapOf("paging" to "true", "snap" to "center")).snap, "paging outranks snap")
    }
}
