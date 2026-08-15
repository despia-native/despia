package despia.engine.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PagerLayoutPolicyTest {
    @Test fun onlyVerticalPagerNeedsTheViewportHeightBridge() {
        assertTrue(PagerLayoutPolicy.requiresViewportHeight("vertical"))
        assertFalse(PagerLayoutPolicy.requiresViewportHeight(""))
        assertFalse(PagerLayoutPolicy.requiresViewportHeight("horizontal"))
    }

    @Test fun viewportPixelsConvertToDensityIndependentHeight() {
        assertEquals(800f, PagerLayoutPolicy.viewportHeightDp(1600, 2f)!!, 0.001f)
        assertEquals(853.3333f, PagerLayoutPolicy.viewportHeightDp(2560, 3f)!!, 0.001f)
    }

    @Test fun invalidViewportFactsDoNotCreateAConstraint() {
        assertNull(PagerLayoutPolicy.viewportHeightDp(0, 2f))
        assertNull(PagerLayoutPolicy.viewportHeightDp(-1, 2f))
        assertNull(PagerLayoutPolicy.viewportHeightDp(1600, 0f))
        assertNull(PagerLayoutPolicy.viewportHeightDp(1600, Float.NaN))
    }
}
