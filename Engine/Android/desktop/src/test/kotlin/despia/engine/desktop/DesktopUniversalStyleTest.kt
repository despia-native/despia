package despia.engine.desktop

import despia.engine.JSERunner
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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

        assertEquals(listOf("#000", "#fff"), desktopGradientColors("#000 | #fff"))
        assertNull(desktopGradientColors("#000"))
        assertNull(desktopGradientColors((0..64).joinToString("|") { "#$it" }))
        assertEquals(6, desktopStyleDeterministicDegradations.size)
        assertTrue(desktopStyleDeterministicDegradations.keys.containsAll(
            setOf("surface", "glassInteractive", "shadowX", "shadowY", "ignoreSafeArea"),
        ))
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
