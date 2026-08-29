package despia.engine.render

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TooltipAnchorPosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The pure seams of the tooltip= render adapter (StackNodeView.kt StackTooltipHost /
 * StackStyle.kt a11yHintSlot). The grammar itself is corpus-gated in :core
 * (TooltipConformanceTest over OpenSource/Conformance/input/tooltip.json); these tests pin
 * the two adapter-side folds a composition is not needed for: the side word → M3
 * anchor-position mapping, and the described duty's hint-slot precedence.
 */
@OptIn(ExperimentalMaterial3Api::class)
class StackTooltipAdapterTest {

    @Test
    fun sideWordsMapOntoTheAnchorPositionSolver() {
        assertEquals(TooltipAnchorPosition.Above, tooltipAnchorPosition("top"))
        assertEquals(TooltipAnchorPosition.Below, tooltipAnchorPosition("bottom"))
        assertEquals(TooltipAnchorPosition.Start, tooltipAnchorPosition("leading"))
        assertEquals(TooltipAnchorPosition.End, tooltipAnchorPosition("trailing"))
        // resolve() already normalized unknowns to "top"; the mapping stays total anyway.
        assertEquals(TooltipAnchorPosition.Above, tooltipAnchorPosition("underneath"))
    }

    @Test
    fun tooltipTextFillsTheHintSlotOnlyWhenUnauthored() {
        fun slot(attrs: Map<String, String>): String? = StackStyle.a11yHintSlot { attrs[it] }
        assertEquals("Save draft", slot(mapOf("tooltip" to "  Save draft  ")))
        assertEquals("Authored", slot(mapOf("tooltip" to "Save", "a11yHint" to "Authored")))
        assertEquals("Aria", slot(mapOf("tooltip" to "Save", "aria-description" to "Aria")))
        // A PRESENT authored key wins even resolving empty — the iOS decorate gate agrees.
        assertEquals("", slot(mapOf("tooltip" to "Save", "a11yHint" to "")))
        // No tooltip, or whitespace-only text, contributes nothing.
        assertNull(slot(emptyMap()))
        assertNull(slot(mapOf("tooltip" to "   ")))
    }
}
