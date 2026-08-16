package despia.engine.desktop

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DesktopScreenMetricsTest {
    @Test
    fun canonicalBreakpointBoundariesAndSizeClassesMatchTheNativeContract() {
        val expected = listOf(
            320 to ("sm" to "compact"),
            479 to ("sm" to "compact"),
            480 to ("md" to "compact"),
            767 to ("md" to "compact"),
            768 to ("lg" to "regular"),
            1023 to ("lg" to "regular"),
            1024 to ("xl" to "regular"),
        )
        expected.forEach { (width, names) ->
            val metrics = requireNotNull(desktopScreenMetrics(width, 900, 1f))
            assertEquals(names.first, metrics.breakpoint, "width=$width")
            assertEquals(names.second, metrics.sizeClass, "width=$width")
        }
    }

    @Test
    fun metricsUseDensityIndependentWindowUnitsAndStableOrientation() {
        val landscape = requireNotNull(desktopScreenMetrics(2_048, 1_440, 2f))
        assertEquals(1024.0, landscape.width)
        assertEquals(720.0, landscape.height)
        assertEquals("landscape", landscape.orientation)
        assertEquals("xl", landscape.breakpoint)

        val square = requireNotNull(desktopScreenMetrics(800, 800, 1f))
        assertEquals("landscape", square.orientation)
        assertNull(desktopScreenMetrics(0, 800, 1f))
        assertNull(desktopScreenMetrics(800, -1, 1f))
        assertNull(desktopScreenMetrics(800, 800, Float.NaN))
        assertNull(desktopScreenMetrics(800, 800, 0f))
    }

    @Test
    fun publishingOverlaysMetricsWithoutErasingLifecycleState() {
        val metrics = requireNotNull(desktopScreenMetrics(768, 1_024, 1f))
        val state = desktopScreenState(
            mapOf<Any, Any?>("phase" to "ready", "width" to -1, 7 to "ignored"),
            metrics,
        )
        assertEquals("ready", state["phase"])
        assertEquals(768.0, state["width"])
        assertEquals("portrait", state["orientation"])
        assertEquals(null, state["7"])
    }
}
