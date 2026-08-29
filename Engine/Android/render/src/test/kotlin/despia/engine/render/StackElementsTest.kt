//
//  StackElementsTest.kt — plain-JVM units for the overlay/structure element wave's pure
//  halves (registration surface, detent grammar, table CSV defaults, popover arrow edge,
//  field validator messages, ring fraction guards, chat-bubble tail). The composables
//  themselves are gated by compilation (RenderSmokeOverlays.kt — the RenderSmoke rule).
//

package despia.engine.render

import androidx.compose.ui.unit.dp
import despia.engine.render.elements.StackElements
import despia.engine.render.elements.chatBubbleShape
import despia.engine.render.elements.fieldMessage
import despia.engine.render.elements.firstDetent
import despia.engine.render.elements.modalDetentToken
import despia.engine.render.elements.parseDetents
import despia.engine.render.elements.popoverArrowEdge
import despia.engine.render.elements.MenuItem
import despia.engine.render.elements.ringFraction
import despia.engine.render.elements.tableCsv
import despia.engine.render.elements.tableFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class StackElementsTest {
    @Test fun fullScreenOverlaysUseTheWindowInsteadOfSafeAreaConstrainedAnchorBounds() {
        val source = File(
            "src/main/kotlin/despia/engine/render/elements/StackElements.kt",
        ).readText()
        val layer = source
            .substringAfter("internal fun FullScreenLayer")
            .substringBefore("// MARK: -")
        assertTrue(layer.contains("Dialog("))
        assertTrue(layer.contains("usePlatformDefaultWidth = false"))
        assertTrue(layer.contains("decorFitsSystemWindows = false"))
        assertFalse(layer.contains("Popup("))
    }

    @Test fun lightboxBackdropIsEdgeToEdgeButItsChromeHonorsTheTopSafeArea() {
        val source = File(
            "src/main/kotlin/despia/engine/render/elements/Lightbox.kt",
        ).readText()
        val chrome = source
            .substringAfter("if (!zoomed) {")
            .substringBefore("Spacer(Modifier.weight(1f))")
        assertTrue(chrome.contains("WindowInsets.safeDrawing.only("))
        assertTrue(chrome.contains("WindowInsetsSides.Top + WindowInsetsSides.Horizontal"))
    }

    @Test fun menuItemsPreferCanonicalTitleAndKeepTheLegacyLabelAlias() {
        assertEquals("Canonical", MenuItem(mapOf("title" to "Canonical", "label" to "Legacy")).title)
        assertEquals("Legacy", MenuItem(mapOf("label" to "Legacy")).title)
    }


    // ── registration: every element lands in the registry, idempotently ─────────────

    @Test fun registerPopulatesTheRegistry() {
        StackElements.register()
        StackElements.register()   // idempotent (defines replace; the flag short-circuits)
        val natives = listOf("sheet", "Drawer", "alert", "confirmDialog", "menu", "contextmenu",
                             "popover", "lightbox", "toolbar", "form", "field",
                             "searchbar", "Table", "Accordion", "Skeleton", "ChatBubble",
                             "ProgressRing", "SystemSettingsRow", "SystemFAB")
        for (tag in natives) assertNotNull("native $tag", ComposeStackComponents.nativeGlobal(tag))
        // `flow` moved native -> privileged on 2026-08-26 (runtime-pressure R29): `<flow bind>`
        // repeats, and the privileged tier is what exposes `bound()` and the per-row render.
        for (tag in listOf("scaffold", "carousel", "flow")) {
            assertNotNull("privileged $tag", ComposeStackComponents.privilegedGlobal(tag))
        }
    }

    // ── sheet detents (Sheet.swift detents/firstDetent) ──────────────────────────────

    @Test fun detentParsingFiltersAndFallsBack() {
        assertEquals(listOf("half", "full"), parseDetents(""))                      // empty → [.medium, .large]
        assertEquals(listOf("half", "full"), parseDetents("bogus,huge"))            // unknown-only → fallback
        assertEquals(listOf("content", "full"), parseDetents(" content , full "))   // trimmed
        assertEquals(listOf("half"), parseDetents("half"))
    }

    @Test fun firstDetentIsLargeOnlyWhenFullLeads() {
        assertEquals("full", firstDetent(listOf("full")))
        assertEquals("full", firstDetent(listOf("full", "half")))
        assertEquals("half", firstDetent(listOf("half", "full")))
        assertEquals("half", firstDetent(listOf("content")))                        // the medium stand-in
    }

    @Test fun modalDetentTokensAcceptBothSpellings() {
        assertEquals("half", modalDetentToken("medium"))
        assertEquals("half", modalDetentToken("half"))
        assertEquals("full", modalDetentToken("large"))
        assertEquals("full", modalDetentToken("full"))
        assertEquals("content", modalDetentToken("content"))
        assertNull(modalDetentToken("peek"))
    }

    // ── popover arrow (Popover.swift arrowEdge) ──────────────────────────────────────

    @Test fun popoverArrowDefaultsToTop() {
        assertEquals("top", popoverArrowEdge(""))
        assertEquals("top", popoverArrowEdge("weird"))
        assertEquals("bottom", popoverArrowEdge("bottom"))
        assertEquals("leading", popoverArrowEdge("leading"))
        assertEquals("trailing", popoverArrowEdge("trailing"))
    }

    // ── Table CSV + field defaults (Table.swift) ─────────────────────────────────────

    @Test fun tableCsvTrimsAndDropsEmpties() {
        assertEquals(listOf("Item", "Qty", "Total"), tableCsv(" Item , Qty ,, Total "))
        assertEquals(emptyList<String>(), tableCsv(""))
    }

    @Test fun tableFieldsDefaultToLowercasedColumns() {
        assertEquals(listOf("item", "qty"), tableFields(listOf("Item", "Qty"), emptyList()))
        assertEquals(listOf("name"), tableFields(listOf("Item"), listOf("name")))
    }

    // ── field validator messages (Field.swift message(_:_:)) ────────────────────────

    @Test fun fieldMessagesMatchTheSwiftTable() {
        assertEquals("Required", fieldMessage("required", ""))
        assertEquals("Enter a valid email", fieldMessage("email", ""))
        assertEquals("Enter a valid URL", fieldMessage("url", ""))
        assertEquals("Enter a valid phone number", fieldMessage("phone", ""))
        assertEquals("Must be at least 8 characters", fieldMessage("minLength", "8"))
        assertEquals("Must be at most 20 characters", fieldMessage("maxLength", "20"))
        assertEquals("Invalid format", fieldMessage("pattern", ""))
        assertEquals("Invalid", fieldMessage("somethingElse", ""))
    }

    // ── ProgressRing fraction guard (ProgressRing.swift) ─────────────────────────────

    @Test fun ringFractionClampsAndGuardsNaN() {
        assertEquals(0.7, ringFraction(0.7, 1.0), 1e-9)
        assertEquals(0.5, ringFraction(5.0, 10.0), 1e-9)
        assertEquals(1.0, ringFraction(2.0, 1.0), 1e-9)                             // clamped
        assertEquals(0.0, ringFraction(-1.0, 1.0), 1e-9)
        assertEquals(0.0, ringFraction(1.0, 0.0), 1e-9)                             // zero max → empty
        assertEquals(0.0, ringFraction(Double.NaN, 1.0), 1e-9)                      // NaN → empty ring
    }

    // ── ChatBubble tail (ChatBubble.swift bubbleFill) ────────────────────────────────

    @Test fun chatBubbleSquaresTheTailCorner() {
        val right = chatBubbleShape(isRight = true)
        val left = chatBubbleShape(isRight = false)
        // The `sheet` rung (20) everywhere except the 4dp tail on the bubble's own side (flips with `side`).
        assertEquals(androidx.compose.foundation.shape.CornerSize(4.dp), right.bottomEnd)
        assertEquals(androidx.compose.foundation.shape.CornerSize(20.dp), right.bottomStart)
        assertEquals(androidx.compose.foundation.shape.CornerSize(4.dp), left.bottomStart)
        assertEquals(androidx.compose.foundation.shape.CornerSize(20.dp), left.bottomEnd)
        assertEquals(androidx.compose.foundation.shape.CornerSize(20.dp), right.topStart)
    }
}
