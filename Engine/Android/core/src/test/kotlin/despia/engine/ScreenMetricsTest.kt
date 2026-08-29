package despia.engine

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The pure screen-plane table (`dsx.screen.*`) — moved up from the desktop host so the
 *  app renderer (:render RouterHost) and :desktop publish through one :core-tested math.
 *  Boundaries mirror the web contract (packages/dom/src/boot.ts screenMetrics). */
class ScreenMetricsTest {
    @Test
    fun canonicalBreakpointBoundariesAndSizeClassesMatchTheWebContract() {
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
            val metrics = requireNotNull(screenMetrics(width, 900, 1f))
            assertEquals(names.first, metrics.breakpoint, "width=$width")
            assertEquals(names.second, metrics.sizeClass, "width=$width")
        }
    }

    @Test
    fun metricsUseDensityIndependentWindowUnitsAndStableOrientation() {
        val landscape = requireNotNull(screenMetrics(2_048, 1_440, 2f))
        assertEquals(1024.0, landscape.width)
        assertEquals(720.0, landscape.height)
        assertEquals("landscape", landscape.orientation)
        assertEquals("xl", landscape.breakpoint)

        val square = requireNotNull(screenMetrics(800, 800, 1f))
        assertEquals("landscape", square.orientation)
        assertNull(screenMetrics(0, 800, 1f))
        assertNull(screenMetrics(800, -1, 1f))
        assertNull(screenMetrics(800, 800, Float.NaN))
        assertNull(screenMetrics(800, 800, 0f))
    }

    @Test
    fun publishingOverlaysMetricsWithoutErasingLifecycleState() {
        val metrics = requireNotNull(screenMetrics(768, 1_024, 1f))
        val state = screenState(
            mapOf<Any, Any?>("phase" to "ready", "width" to -1, 7 to "ignored"),
            metrics,
        )
        assertEquals("ready", state["phase"])
        assertEquals(768.0, state["width"])
        assertEquals("portrait", state["orientation"])
        assertEquals(null, state["7"])
    }

    @Test
    fun rotationSwapsOrientationAndKeepsTheOverlayLive() {
        val portrait = requireNotNull(screenMetrics(1_080, 2_400, 3f))
        assertEquals("portrait", portrait.orientation)
        val rotated = requireNotNull(screenMetrics(2_400, 1_080, 3f))
        assertEquals("landscape", rotated.orientation)
        val state = screenState(screenState(mapOf("phase" to "ready"), portrait), rotated)
        assertEquals("ready", state["phase"])
        assertEquals(800.0, state["width"])
        assertEquals("landscape", state["orientation"])
        assertEquals("lg", state["breakpoint"])
    }
}
