package despia.engine.render

import despia.engine.render.elements.AndroidSheetPresentationPolicy
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidSheetPresentationPolicyTest {
    @Test
    fun standardAndroidDetentsUseTheRealMaterialSheet() {
        assertTrue(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("half", "full"), card = false))
        assertTrue(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("full"), card = false))
        assertFalse(AndroidSheetPresentationPolicy.skipsPartiallyExpanded(listOf("half", "full")))
        assertTrue(AndroidSheetPresentationPolicy.skipsPartiallyExpanded(listOf("full")))
    }

    @Test
    fun materialCannotRepresentCustomDetentsOrFloatingCards() {
        assertFalse(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("content"), card = false))
        assertFalse(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("content", "half", "full"), card = false))
        assertFalse(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("half"), card = false))
        assertFalse(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("full", "half"), card = false))
        assertFalse(AndroidSheetPresentationPolicy.usesMaterialSheet(listOf("half", "full"), card = true))
    }
}
