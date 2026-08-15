package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/// Conformance tests for the Live-Activity document slicing — behavior pinned to
/// StackActivity.swift. Pure StackNode navigation over the one parser (StackXML),
/// so the only shared state is the parse-failure log seam, restored after each test.
class StackActivityTest {

    @AfterTest fun restoreLogSeam() {
        StackXML.kernelLog = { line -> println(line) }
    }

    private val doc = """
        <activity>
          <lockscreen><text id="ls">L</text></lockscreen>
          <island>
            <compact>
              <leading><text id="cl"/></leading>
              <trailing><text id="ct"/></trailing>
            </compact>
            <minimal><text id="m"/></minimal>
            <expanded>
              <leading><text id="el"/></leading>
              <trailing><text id="et"/></trailing>
              <center><text id="ec"/></center>
              <bottom><text id="eb"/></bottom>
            </expanded>
          </island>
        </activity>
    """.trimIndent()

    // -- the full slot taxonomy --

    @Test fun everySlotYieldsItsSingleVisualChild() {
        val a = StackActivity(doc)
        assertTrue(a.isDocument)
        assertEquals("ls", a.lockScreen?.id)           // the CHILD, not the slot element
        assertEquals("text", a.lockScreen?.tag)
        assertEquals("cl", a.compactLeading?.id)
        assertEquals("ct", a.compactTrailing?.id)
        assertEquals("m", a.minimal?.id)
        assertEquals("el", a.expandedLeading?.id)
        assertEquals("et", a.expandedTrailing?.id)
        assertEquals("ec", a.expandedCenter?.id)
        assertEquals("eb", a.expandedBottom?.id)
    }

    // -- bare layout: a plain layout string still works 1:1 --

    @Test fun bareLayoutIsTheLockScreen() {
        val a = StackActivity("""<stack id="r"><text id="t">hi</text></stack>""")
        assertFalse(a.isDocument)
        assertSame(a.root, a.lockScreen)               // the ROOT itself, unsliced
        assertEquals("r", a.lockScreen?.id)
        assertNull(a.compactLeading)                   // no island in a bare layout
        assertNull(a.compactTrailing)
        assertNull(a.minimal)
        assertNull(a.expandedLeading)
        assertNull(a.expandedTrailing)
        assertNull(a.expandedCenter)
        assertNull(a.expandedBottom)
    }

    // -- missing slots: fail-open, per slot --

    @Test fun missingSlotsAreNullPerSlot() {
        val a = StackActivity(
            """<activity><island><compact><leading><text id="cl"/></leading></compact></island></activity>"""
        )
        assertTrue(a.isDocument)
        assertEquals("cl", a.compactLeading?.id)       // the one provided slot works
        assertNull(a.lockScreen)                       // a DOCUMENT without <lockscreen> has none
        assertNull(a.compactTrailing)                  // sibling slot missing -> null
        assertNull(a.minimal)
        assertNull(a.expandedLeading)
        assertNull(a.expandedTrailing)
        assertNull(a.expandedCenter)
        assertNull(a.expandedBottom)
    }

    @Test fun emptySlotElementYieldsNull() {
        val a = StackActivity("""<activity><island><minimal/></island></activity>""")
        assertNull(a.minimal)                          // the slot exists but holds no child
    }

    // -- "first matching child at each step" / "exactly ONE visual element" --

    @Test fun slotTakesOnlyTheFirstChild() {
        val a = StackActivity(
            """<activity><island><minimal><text id="a"/><text id="b"/></minimal></island></activity>"""
        )
        assertEquals("a", a.minimal?.id)
    }

    @Test fun descendPicksTheFirstMatchingChildAtEachStep() {
        val a = StackActivity(
            """
            <activity>
              <island><minimal><text id="first"/></minimal></island>
              <island><minimal><text id="second"/></minimal></island>
            </activity>
            """.trimIndent()
        )
        assertEquals("first", a.minimal?.id)
    }

    // -- unparsable input --

    @Test fun unparsableDocumentIsEmptyEverywhere() {
        val logged = mutableListOf<String>()
        StackXML.kernelLog = { logged.add(it) }
        val a = StackActivity("<activity><lockscreen>")     // mismatched tags
        assertNull(a.root)
        assertFalse(a.isDocument)
        assertNull(a.lockScreen)
        assertNull(a.minimal)
        assertTrue(logged.single().startsWith("[Stack] XML parse failed"))
    }
}
