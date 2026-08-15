package despia.engine.render

import org.junit.Assert.assertEquals
import org.junit.Test

class AccessibilityModifiersTest {

    @Test
    fun continuousKeyboardAdjustmentUsesFivePercentAndClamps() {
        val range = 0f..10f
        assertEquals(5.5f, accessibilityAdjustedValue(5f, range, 0, 1), 0.0001f)
        assertEquals(0f, accessibilityAdjustedValue(0f, range, 0, -1), 0.0001f)
        assertEquals(10f, accessibilityAdjustedValue(10f, range, 0, 1), 0.0001f)
    }

    @Test
    fun discreteKeyboardAdjustmentUsesAuthoredStops() {
        val range = 0f..10f
        assertEquals(4f, accessibilityAdjustedValue(2f, range, 4, 1), 0.0001f)
        assertEquals(0f, accessibilityAdjustedValue(2f, range, 4, -1), 0.0001f)
    }

    @Test
    fun degenerateAndInvalidDirectionsRemainInRange() {
        assertEquals(3f, accessibilityAdjustedValue(9f, 3f..3f, 0, 1), 0.0001f)
        assertEquals(4f, accessibilityAdjustedValue(4f, 0f..10f, 0, 0), 0.0001f)
    }

    @Test
    fun authoredIncrementMapsToComposeIntermediateStepCount() {
        assertEquals(4, accessibilityStepsForIncrement(0.0, 10.0, 2.0))
        assertEquals(0, accessibilityStepsForIncrement(0.0, 1.0, null))
        assertEquals(0, accessibilityStepsForIncrement(1.0, 1.0, 0.25))
        assertEquals(0, accessibilityStepsForIncrement(0.0, 1.0, 0.0))
    }
}
