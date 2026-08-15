//
//  PlainElementsTest.kt — plain-JVM units for the PLAIN element wave's pure halves
//  (elements/TextAreaElements.kt · PlainPickerElements.kt · RefreshableElements.kt):
//  the registration surface, the textarea lineLimit clamp (TextArea.swift:36), the
//  picker trigger label, the pull-to-refresh math (RefreshMath), the fixture-pinned
//  timing constants, and the two CONVERGENCE fixes this wave lands (tabs value= /
//  Checkbox alias drop). The composables themselves are gated by compilation
//  (:render:assembleDebug) and the spec↔fixture diff by ElementParityTest.
//

package despia.engine.render

import despia.engine.render.elements.InputElements
import despia.engine.render.elements.PlainElements
import despia.engine.render.elements.RefreshMath
import despia.engine.render.elements.pickerSelectedLabel
import despia.engine.render.elements.textAreaLineRange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlainElementsTest {

    // ── registration: every tag of the wave lands, idempotently ─────────────────────

    @Test fun registerPopulatesTheRegistry() {
        PlainElements.register()
        PlainElements.register()   // idempotent (defines replace; the flag short-circuits)
        for (tag in listOf("textarea", "picker", "segmented", "refreshable", "refresh")) {
            assertNotNull("native $tag", ComposeStackComponents.nativeGlobal(tag))
        }
    }

    // ── CONVERGENCE: Checkbox = the Capitalized iOS tag only (Checkbox.swift, no aliases) ──

    @Test fun checkboxLowercaseAliasIsDropped() {
        InputElements.register()
        assertNotNull(ComposeStackComponents.nativeGlobal("Checkbox"))
        assertNull("the Android-only lowercase alias must stay dropped",
                   ComposeStackComponents.nativeGlobal("checkbox"))
        assertTrue(ElementSpecs.spec("Checkbox")!!.aliases.isEmpty())
    }

    // ── CONVERGENCE: tabs reads value= (Tabs.swift:30); bind= stays a doc'd alias, out of the spec ──

    @Test fun tabsSpecConvergesOnValue() {
        val tabs = ElementSpecs.spec("tabs")!!
        assertTrue(tabs.attributes.containsKey("value"))
        assertFalse("bind= is the legacy Android alias — never spec'd", tabs.attributes.containsKey("bind"))
    }

    // ── specs: the wave registers all four, with the fixture-pinned constants ───────

    @Test fun plainWaveSpecsAreRegistered() {
        val specs = ElementSpecs.all()
        for (tag in listOf("textarea", "picker", "segmented", "refreshable")) {
            assertTrue("spec $tag", tag in specs)
        }
        assertEquals(listOf("refresh"), specs["refreshable"]!!.aliases)
        assertEquals("3", specs["textarea"]!!.attributes["minLines"])
        assertEquals("8", specs["textarea"]!!.attributes["maxLines"])
        assertEquals("label", specs["textarea"]!!.attributes["color"])   // system-defaults base pass: the semantic token, not pinned white
        assertEquals("accent", specs["picker"]!!.attributes["color"])
        assertFalse("segmented ignores color (menu-only tint, Picker.swift:31,34)",
                    specs["segmented"]!!.attributes.containsKey("color"))
        assertEquals(350.0, specs["refreshable"]!!.geometry["graceMs"]!!, 1e-9)
        assertEquals(60.0, specs["refreshable"]!!.geometry["pollMs"]!!, 1e-9)
    }

    // ── textarea lineLimit clamp (TextArea.swift:36) ─────────────────────────────────

    @Test fun textAreaLineRangeNormalizesInversions() {
        assertEquals(3 to 8, textAreaLineRange(3, 8))
        assertEquals(2 to 5, textAreaLineRange(5, 2))    // min(min,max)...max(min,max)
        assertEquals(4 to 4, textAreaLineRange(4, 4))
        assertEquals(1 to 1, textAreaLineRange(0, -2))   // floored at one line (a valid Compose range)
    }

    // ── picker trigger label (SwiftUI .menu: selected label, else empty) ─────────────

    @Test fun pickerSelectedLabelResolvesValueToLabel() {
        val opts = listOf("w" to "Weekly", "m" to "Monthly")
        assertEquals("Monthly", pickerSelectedLabel(opts, "m"))
        assertEquals("", pickerSelectedLabel(opts, "yearly"))   // no match → empty trigger
        assertEquals("", pickerSelectedLabel(emptyList(), ""))
    }

    // ── pull-to-refresh math (RefreshMath — the Android chrome's pure half) ──────────

    @Test fun refreshPullIsResistanceDampedAndFloored() {
        assertEquals(35f, RefreshMath.nextPull(0f, 70f), 1e-6f)          // default 0.5 resistance
        assertEquals(20f, RefreshMath.nextPull(10f, 10f, 1f), 1e-6f)
        assertEquals(0f, RefreshMath.nextPull(10f, -30f, 1f), 1e-6f)     // floored at rest
    }

    @Test fun refreshTriggersAtThresholdOnly() {
        assertTrue(RefreshMath.shouldTrigger(70f, 70f))
        assertTrue(RefreshMath.shouldTrigger(120f, 70f))
        assertFalse(RefreshMath.shouldTrigger(69.9f, 70f))
        assertFalse("a zero threshold never arms", RefreshMath.shouldTrigger(10f, 0f))
    }

    @Test fun refreshProgressClamps() {
        assertEquals(0.5f, RefreshMath.progress(35f, 70f), 1e-6f)
        assertEquals(1f, RefreshMath.progress(200f, 70f), 1e-6f)
        assertEquals(0f, RefreshMath.progress(-5f, 70f), 1e-6f)
        assertEquals(0f, RefreshMath.progress(10f, 0f), 1e-6f)
    }

    // ── the fixture-pinned timing constants (Refreshable.swift:32,34,36) ─────────────

    @Test fun refreshTimingMatchesTheSwiftSource() {
        assertEquals(350L, PlainWaveDefaults.REFRESH_GRACE_MS)
        assertEquals(50L, PlainWaveDefaults.REFRESH_SETTLE_MS)
        assertEquals(60L, PlainWaveDefaults.REFRESH_POLL_MS)
    }
}
