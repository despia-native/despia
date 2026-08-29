package despia.engine.desktop

import androidx.compose.ui.graphics.Color
import despia.engine.ControlsCore
import despia.engine.JSERunner
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DesktopUniversalStyleTest {
    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun everyMotionCurveHasABoundedDeterministicProfile() {
        assertEquals(350, desktopMotionDurationMillis(emptyMap()))
        assertEquals(400, desktopMotionDurationMillis(mapOf("anim" to "spring")))
        assertEquals(0, desktopMotionDurationMillis(mapOf("anim" to "spring", "animDuration" to "-1")))
        assertEquals(10_000, desktopMotionDurationMillis(mapOf("animDuration" to "999999")))

        val spring = desktopMotionProfile(mapOf("anim" to "spring", "animDuration" to "0.5"))
        assertEquals("spring", spring.curve)
        assertEquals(500, spring.durationMillis)
        assertEquals(0.8f, spring.dampingRatio)
        assertTrue(assertNotNull(spring.stiffness).isFinite())

        assertEquals("linear", desktopMotionProfile(mapOf("anim" to "linear")).curve)
        assertEquals("easeIn", desktopMotionProfile(mapOf("anim" to "easeIn")).curve)
        assertEquals("easeOut", desktopMotionProfile(mapOf("anim" to "easeOut")).curve)
        assertEquals("easeInOut", desktopMotionProfile(mapOf("anim" to "bogus")).curve)
        assertEquals("linear", desktopMotionProfile(mapOf("anim" to "spring", "animDuration" to "0")).curve)

        assertEquals(
            DesktopRootExitPlan("slide-right", 250),
            desktopRootExitPlan(mapOf("exit" to "slide-right", "animDuration" to "0.25")),
        )
        assertNull(desktopRootExitPlan(mapOf("exit" to "unsupported")))
    }

    @Test
    fun accessibilityVocabularyIncludesAriaAliasesStaticAndTapDefaults() {
        val aria = desktopAccessibility(
            "vstack",
            mapOf(
                "aria-label" to "Download",
                "aria-description" to "Saves the file",
                "aria-valuetext" to "Ready",
                "a11yTrait" to "link, header, selected",
            ),
        )
        assertEquals("Download", aria.label)
        assertEquals("Saves the file", aria.hint)
        assertEquals("Ready", aria.value)
        assertEquals("link", aria.role)
        assertTrue(aria.heading)
        assertTrue(aria.selected)

        val tappable = desktopAccessibility("vstack", mapOf("on:tap" to "open"))
        assertEquals("button", tappable.role)
        val static = desktopAccessibility("vstack", mapOf("on:tap" to "copy", "a11yTrait" to "static"))
        assertNull(static.role)
        assertTrue(static.staticText)
    }

    @Test
    fun universalEventArgumentsAreInterpolatedTypedAndBoundedByTheRunnerGate() {
        val store = StackStore().also { it.vars["count"] = 7.0 }
        val args = desktopEventArguments(
            mapOf(
                "arg:enabled" to "true",
                "arg:disabled" to "false",
                "arg:count" to "{{ dsx.variable.count }}",
                "arg:title" to "Track {{ dsx.variable.count }}",
                "arg:" to "ignored",
            ),
            store,
            null,
        )
        assertEquals(
            mapOf("enabled" to true, "disabled" to false, "count" to 7.0, "title" to "Track 7"),
            args,
        )

        desktopRunEvent(
            node = StackNode("vstack", mapOf("id" to "payload-probe"), emptyList()),
            event = "drag",
            action = "dsx.variable.eventCount = dsx.this.count; dsx.variable.phase = dsx.this.phase",
            attrs = mapOf("arg:count" to "{{ dsx.variable.count }}"),
            store = store,
            runner = JSERunner(store),
            item = mapOf("count" to -1.0, "row" to "kept"),
            extra = mapOf("phase" to "drag"),
        )
        assertEquals(7.0, store.vars["eventCount"], "typed arg:* must override a same-named row field")
        assertEquals("drag", store.vars["phase"], "gesture payload must be available through dsx.this")
    }

    @Test
    fun styleValueParsersRejectNonFiniteOrUnboundedGeometry() {
        assertEquals(16f / 9f, desktopAspectRatio("16:9"))
        assertEquals(1.25f, desktopAspectRatio("1.25"))
        assertNull(desktopAspectRatio("1:0"))
        assertNull(desktopAspectRatio("NaN"))
        assertNull(desktopAspectRatio("1000001"))

        // The colour bound used to live in a desktop-only parser, which made "how many colours is
        // too many" a property of ONE renderer. It is grammar now (ControlsCore, corpus-pinned),
        // so what this lane asserts is that it reads the shared answer rather than its own.
        assertEquals(
            listOf("#000", "#fff"),
            ControlsCore.resolveGradient(gradient = "#000 | #fff").colors,
        )
        assertFalse(ControlsCore.resolveGradient(gradient = "#000").valid, "one colour is a fill")
        assertEquals(
            ControlsCore.MAX_GRADIENT_COLORS,
            ControlsCore.resolveGradient(
                gradient = (0..200).joinToString("|") { "#$it" },
            ).colors.size,
            "an unbounded colour list must be bounded, not refused",
        )
        // The lane's own inventory of what it does NOT implement. check_style_parity.rb reads it
        // and counts every row as an Article 10 gap, so it only ever SHRINKS - shadowX and
        // shadowY left it when DesktopShadow.kt started painting the shadow instead of asking
        // the platform to light the element.
        assertEquals(3, desktopStyleDeterministicDegradations.size)
        assertTrue(desktopStyleDeterministicDegradations.keys.containsAll(
            setOf("surface", "ignoreSafeArea"),
        ))
        assertTrue(
            desktopStyleDeterministicDegradations.keys.none {
                it == "shadowX" || it == "shadowY" || it == "glassInteractive"
            },
            "the shadow offsets and the glass press are painted now; a row that outlives its " +
                "debt is a standing permission nobody re-argued",
        )
    }

    /**
     * The declared gradient surface, painted from the shared core. Before this the desktop lane
     * read `gradient` and the three legacy `gradientDir` tokens and threw the other six declared
     * properties away after ControlsCore had already resolved them, which is the Article 10 gap
     * this closes. What is asserted here is the PAINT decision - the type picks the brush, and
     * the mesh degradation is layers rather than nothing.
     */
    @Test
    fun gradientTypesEachPaintTheirOwnBrushAndMeshDegradesToLayers() {
        fun brushes(vararg pairs: Pair<String, String>): List<Any> =
            DesktopGradients.layers(
                ControlsCore.resolveGradient(
                    gradient = pairs.toMap()["gradient"],
                    gradientType = pairs.toMap()["gradientType"],
                    gradientStops = pairs.toMap()["gradientStops"],
                    gradientAngle = pairs.toMap()["gradientAngle"],
                    gradientCenter = pairs.toMap()["gradientCenter"],
                    gradientRadius = pairs.toMap()["gradientRadius"],
                    gradientPoints = pairs.toMap()["gradientPoints"],
                ),
            ) { Color.Red }

        val linear = brushes("gradient" to "#000|#fff")
        val radial = brushes("gradient" to "#000|#fff", "gradientType" to "radial")
        val angular = brushes("gradient" to "#000|#fff", "gradientType" to "angular")
        assertEquals(1, linear.size)
        assertEquals(1, radial.size)
        assertEquals(1, angular.size)
        // Three types, three DIFFERENT brush classes. One class for all three is the old defect.
        assertEquals(
            3,
            listOf(linear, radial, angular).map { it.first()::class }.distinct().size,
            "each gradient type must paint its own brush",
        )

        // A single colour is a flat fill, not a gradient: paint nothing rather than a band.
        assertTrue(brushes("gradient" to "#000").isEmpty())

        // Mesh has no Compose primitive at any version, so it degrades to the corpus's declared
        // fallback: the base fill plus one soft radial per control point.
        val mesh = brushes(
            "gradientType" to "mesh",
            "gradientPoints" to "0 0 #f00, 1 0 #0f0; 0 1 #00f, 1 1 #ff0",
        )
        assertEquals(5, mesh.size, "a 2x2 mesh degrades to a base fill plus four radials")
    }

    /**
     * Compose's sweep starts at three o'clock and takes no rotation argument; the corpus angle
     * starts at twelve. Rotating a sweep IS a cyclic shift of its stops, so the conversion is
     * exact rather than an approximation - and the ring is closed at both ends so the wrap point
     * shows no seam the unrotated gradient did not already have.
     */
    @Test
    fun sweepRotationIsACyclicStopShiftWithNoSeam() {
        val ring = listOf(0f to Color.Red, 0.5f to Color.Green, 1f to Color.Blue)
        assertEquals(ring, DesktopGradients.rotatedRing(ring, 0.0), "no rotation changes nothing")
        assertEquals(ring, DesktopGradients.rotatedRing(ring, 360.0), "a full turn changes nothing")

        val quarter = DesktopGradients.rotatedRing(ring, 90.0)
        assertEquals(0f, quarter.first().first, "the ring must start at 0")
        assertEquals(1f, quarter.last().first, "the ring must end at 1")
        assertEquals(
            quarter.first().second, quarter.last().second,
            "a ring's two ends are the same point, so they must be the same colour",
        )
        assertTrue(
            quarter.zipWithNext().all { (a, b) -> a.first <= b.first },
            "stops must stay ascending or the shader rejects them",
        )
        // The 0.5 stop lands at 0.75 after a quarter turn; the 0.0 and 1.0 ends wrap to 0.25.
        assertTrue(quarter.any { kotlin.math.abs(it.first - 0.75f) < 1e-5f && it.second == Color.Green })
        assertEquals(2, quarter.count { kotlin.math.abs(it.first - 0.25f) < 1e-5f })
    }

    @Test
    fun imperativeNodeHandlesRejectUnboundedOrAmbiguousSelectorsBeforeDispatch() {
        val store = StackStore()
        assertFailsWith<IllegalArgumentException> { store.desktopNode("") }
        assertFailsWith<IllegalArgumentException> { store.desktopNode("#bad selector") }
        assertFailsWith<IllegalArgumentException> { store.desktopNode("x".repeat(129)) }
        val handle = store.desktopNode("#safe-id")
        assertFailsWith<IllegalArgumentException> { handle.set("bad attribute", "x") }
        assertFailsWith<IllegalArgumentException> { handle.set("width", "x".repeat(65_537)) }
    }
}
