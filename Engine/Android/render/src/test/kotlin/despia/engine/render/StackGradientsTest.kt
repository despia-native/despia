package despia.engine.render

import androidx.compose.ui.graphics.Color
import despia.engine.ControlsCore
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gradient layer on Compose, and the twin of the same assertions on the desktop lane
 * (DesktopUniversalStyleTest). Both paint from ControlsCore, so what is worth asserting per lane
 * is the PAINT decision: the type picks the brush, a single colour paints nothing, mesh degrades
 * to layers rather than to a blank, and the sweep rotation Compose cannot express directly is an
 * exact cyclic shift of the stops.
 *
 * Before StackGradients.kt this renderer read `gradient` and the three legacy `gradientDir`
 * tokens and threw the other six declared properties away after the shared core had already
 * resolved them. That is the Article 10 gap these assertions keep closed.
 */
class StackGradientsTest {

    private fun brushes(vararg pairs: Pair<String, String>): List<Any> {
        val attrs = pairs.toMap()
        return StackGradients.layers(
            ControlsCore.resolveGradient(
                gradient = attrs["gradient"],
                gradientType = attrs["gradientType"],
                gradientStops = attrs["gradientStops"],
                gradientAngle = attrs["gradientAngle"],
                gradientCenter = attrs["gradientCenter"],
                gradientRadius = attrs["gradientRadius"],
                gradientPoints = attrs["gradientPoints"],
            )
        )
    }

    @Test
    fun eachGradientTypePaintsItsOwnBrush() {
        val linear = brushes("gradient" to "#000|#fff")
        val radial = brushes("gradient" to "#000|#fff", "gradientType" to "radial")
        val angular = brushes("gradient" to "#000|#fff", "gradientType" to "angular")
        assertEquals(1, linear.size)
        assertEquals(1, radial.size)
        assertEquals(1, angular.size)
        assertEquals(
            "one brush class for all three types is the defect this file exists to prevent",
            3,
            listOf(linear, radial, angular).map { it.first()::class }.distinct().size,
        )
    }

    @Test
    fun aSingleColourIsAFillAndPaintsNothing() {
        assertTrue(brushes("gradient" to "#000").isEmpty())
        assertTrue(brushes().isEmpty())
    }

    @Test
    fun meshDegradesToTheCorpusFallbackLayers() {
        val mesh = brushes(
            "gradientType" to "mesh",
            "gradientPoints" to "0 0 #f00, 1 0 #0f0; 0 1 #00f, 1 1 #ff0",
        )
        assertEquals("a 2x2 mesh degrades to a base fill plus four radials", 5, mesh.size)
    }

    /**
     * Compose's sweep starts at three o'clock and takes no rotation argument; the corpus angle
     * starts at twelve. Rotating a sweep IS a cyclic shift of its stops, so this is exact, and the
     * ring closes at both ends so the wrap point shows no seam the unrotated gradient did not have.
     */
    @Test
    fun sweepRotationIsACyclicStopShiftWithNoSeam() {
        val ring = listOf(0f to Color.Red, 0.5f to Color.Green, 1f to Color.Blue)
        assertEquals(ring, StackGradients.rotatedRing(ring, 0.0))
        assertEquals(ring, StackGradients.rotatedRing(ring, 360.0))

        val quarter = StackGradients.rotatedRing(ring, 90.0)
        assertEquals("the ring must start at 0", 0f, quarter.first().first, 1e-6f)
        assertEquals("the ring must end at 1", 1f, quarter.last().first, 1e-6f)
        assertEquals(
            "a ring's two ends are the same point, so they must be the same colour",
            quarter.first().second, quarter.last().second,
        )
        assertTrue(
            "stops must stay ascending or the shader rejects them",
            quarter.zipWithNext().all { (a, b) -> a.first <= b.first },
        )
        assertTrue(quarter.any { abs(it.first - 0.75f) < 1e-5f && it.second == Color.Green })
        assertEquals(2, quarter.count { abs(it.first - 0.25f) < 1e-5f })
    }
}
