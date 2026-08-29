package despia.engine.desktop

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import despia.engine.JSERunner

class DesktopStudioElementsTest {
    @Test
    fun waveformInputsAreFiniteBoundedAndDeterministic() {
        val values = buildList<Any?> {
            add(-1.0)
            add(0.25)
            add("0.75")
            add(Double.NaN)
            repeat(MAX_DESKTOP_STUDIO_PEAKS + 50) { add(2.0) }
        }
        val peaks = desktopStudioPeaks(values)
        assertEquals(MAX_DESKTOP_STUDIO_PEAKS, peaks.size)
        assertTrue(peaks.all { it.isFinite() && it in 0.0..1.0 })
        assertEquals(desktopStudioSeedPeaks(73), desktopStudioSeedPeaks(73))
        assertFalse(desktopStudioSeedPeaks(73).all { it == desktopStudioSeedPeaks(74).first() })
    }

    @Test
    fun peakWindowNeverEscapesItsSourceOrReturnsAnEmptyValidSlice() {
        val peaks = (0 until 100).map { it / 100.0 }
        assertEquals((25 until 50).map { it / 100.0 }, desktopStudioPeakWindow(peaks, 10.0, 2.5, 5.0))
        assertEquals(listOf(0.99), desktopStudioPeakWindow(peaks, 10.0, 9.99, 10.0))
        assertTrue(desktopStudioPeakWindow(peaks, 0.0, 0.0, 1.0).isEmpty())
        assertTrue(desktopStudioPeakWindow(emptyList(), 10.0, 0.0, 1.0).isEmpty())
    }

    @Test
    fun timecodeIsLocaleStableClampedAndNeverPrintsNonFiniteValues() {
        assertEquals("0:00.0", desktopStudioTimecode(Double.NaN))
        assertEquals("0:00.0", desktopStudioTimecode(-1.0))
        assertEquals("1:05.2", desktopStudioTimecode(65.29))
        assertEquals("0:00.0", desktopStudioTimecode(Double.POSITIVE_INFINITY))
        assertEquals("600:00.0", desktopStudioTimecode(99_999.0))
    }

    @Test
    fun pitchScaleTablesMatchThePortableStudioGrammar() {
        assertEquals(setOf(0, 2, 4, 5, 7, 9, 11), desktopPitchClasses("major"))
        assertEquals(setOf(0, 3, 5, 6, 7, 10), desktopPitchClasses("blues"))
        assertEquals((0..11).toSet(), desktopPitchClasses("unknown"))
    }

    @Test
    fun studioSnapTrimAndPitchMathMatchesTheCanonicalControlCommits() {
        assertEquals(1.5, desktopStudioSnapTime(1.37, 120.0, true))
        assertEquals(1.37, desktopStudioSnapTime(1.37, 120.0, false))
        val clip = DesktopStudioClip(
            id = 7,
            track = 2,
            start = 1.0,
            duration = 3.0,
            sourceStart = 0.5,
            sourceDuration = 5.0,
            peaks = emptyList(),
        )
        assertEquals(
            DesktopStudioTrimCommit(sourceStart = 1.0, duration = 2.5, start = 1.5),
            desktopStudioTrimStart(clip, 0.5, 120.0, snap = false),
        )
        assertEquals(
            DesktopStudioTrimCommit(sourceStart = 0.5, duration = 4.5, start = 1.0),
            desktopStudioTrimEnd(clip, 99.0, 120.0, snap = false),
        )
        assertEquals(62.0, desktopStudioSnapMidi(61.7, 2, desktopPitchClasses("major"), true))
        assertEquals(61.0, desktopStudioSnapMidi(61.1, 2, desktopPitchClasses("major"), false))
        assertTrue(desktopStudioWheelZoom(100.0, -1f, 16.0, 400.0) > 100.0)
        assertTrue(desktopStudioWheelZoom(100.0, 1f, 16.0, 400.0) < 100.0)
        assertEquals(400.0, desktopStudioWheelZoom(400.0, -10_000f, 16.0, 400.0))
        assertEquals(1.0, desktopStudioWheelZoom(Double.NaN, -1f, 1.0, 16.0))
    }

    @Test
    fun studioDispatchUsesTheCanonicalModuleBusAndRejectsAuthoredTargets() {
        val previous = JSERunner.moduleHandle
        val calls = mutableListOf<Pair<String, Map<String, Any?>>>()
        JSERunner.moduleHandle = { url, args, terminal ->
            calls += url to args
            terminal(despia.engine.JSEModuleOutcome.Resolve(null))
            true
        }
        try {
            assertTrue(desktopStudioDispatch("studio.trimClip", mapOf("id" to 9)))
            assertFalse(desktopStudioDispatch("other.delete", mapOf("id" to 9)))
            assertFalse(desktopStudioDispatch("studio.bad/path", emptyMap()))
            assertEquals(
                listOf<Pair<String, Map<String, Any?>>>("studio://trimClip" to mapOf("id" to 9)),
                calls,
            )
        } finally {
            JSERunner.moduleHandle = previous
        }
    }

    @Test
    fun unavailableCapabilitiesUseStableNonSecretStructuredCodes() {
        // The tag→capability→failure chain now comes from the DATA table, so this pins the
        // shipped table's contract rather than a Kotlin literal: an UNBOUND capability answers
        // with its own stable code, and a BOUND one (remote-dsx-document) is not a failure at
        // all. Codes are machine-readable and messages leak no authored URL.
        val expected = mapOf(
            "DSXWebView" to "native_web_runtime_unavailable",
            "WebView" to "native_web_runtime_unavailable",
            "Scene360" to "scene3d_runtime_unavailable",
            "Scene3D" to "scene3d_runtime_unavailable",
            // rive (U12) landed canonical and this renderer does not implement it, so it
            // answers with its own code rather than being quietly absent. `canvas` (U04) LEFT
            // this table when DesktopCanvas.kt landed: a capability row is for a runtime the
            // build does not bundle, never for one nobody had written yet, and the desktop
            // now paints the same :core display list as every other renderer.
            "rive" to "rive_runtime_unavailable",
        )
        assertEquals(expected.keys + "DSXView", DesktopCapabilities.tags)
        expected.forEach { (tag, code) ->
            assertNull(DesktopCapabilities.renderer(tag), "$tag must have no bundled implementation")
            val failure = DesktopCapabilities.failure(tag)
            assertEquals(code, failure.code)
            assertFalse(failure.message.contains("http", ignoreCase = true))
            assertFalse(failure.message.contains("src=", ignoreCase = true))
        }
        // The other half of the inversion: a claimed tag whose capability IS bundled renders,
        // and never reaches the unavailable surface.
        assertNotNull(DesktopCapabilities.renderer("DSXView"))
    }

    @Test
    fun theCapabilityTableRejectsAMalformedDeclaration() {
        // The table is data the binary trusts; it is validated like every other desktop
        // catalog. A tag pointing at an undeclared capability must ABORT, not silently render
        // a surface with no failure story.
        val header = DesktopCapabilities::class.java.getResourceAsStream("/dsx/DesktopCapabilities.tsv")!!
            .use { String(it.readBytes(), Charsets.UTF_8) }
            .lineSequence().takeWhile { it.startsWith("#") }.joinToString("\n")
        assertFailsWith<IllegalArgumentException> {
            DesktopCapabilities.parse(header + "\ntag\tGhost\tno-such-capability\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopCapabilities.parse(header + "\nnonsense\ta\tb\n")
        }
        // …and the shipped table itself parses, so the header pin above is honest.
        assertTrue(DesktopCapabilities.tags.isNotEmpty())
    }

    @Test
    fun motionDurationUsesOneFiniteBoundForAnimationAndExitHold() {
        assertEquals(350, desktopMotionDurationMillis(emptyMap()))
        assertEquals(0, desktopMotionDurationMillis(mapOf("animDuration" to "-2")))
        assertEquals(10_000, desktopMotionDurationMillis(mapOf("animDuration" to "999999")))
        assertEquals(350, desktopMotionDurationMillis(mapOf("animDuration" to "NaN")))
    }
}
