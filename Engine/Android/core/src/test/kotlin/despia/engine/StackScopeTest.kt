package despia.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Conformance tests for the snapshot-surface value resolution — behavior pinned to
/// StackScope.swift (substitution, typed reads, color literals, tapEvent extraction).
class StackScopeTest {

    private val scope = StackScope(mapOf("name" to "Ada", "t" to "42", "empty" to ""))

    private fun reader(xml: String): StackReader =
        StackReader(StackXML.parse(xml)!!, scope)

    // -- substitution: only the simple `dsx.variable.<key>` form resolves --

    @Test fun simpleReferenceResolves() {
        assertEquals("hi Ada!", scope.substitute("hi {{ dsx.variable.name }}!"))
        assertEquals("Ada", scope.substitute("{{dsx.variable.name}}"))       // no inner spaces needed
        assertEquals("AdaAda", scope.substitute("{{ dsx.variable.name }}{{ dsx.variable.name }}"))
    }

    @Test fun missingVariableRendersEmpty() {
        assertEquals("x  y", scope.substitute("x {{ dsx.variable.nope }} y"))
    }

    @Test fun richExpressionsFailOpenToEmpty() {
        // No JS in a snapshot process: operators, calls, other namespaces — all empty.
        assertEquals("", scope.substitute("{{ mmss(dsx.variable.t) }}"))
        assertEquals("", scope.substitute("{{ dsx.variable.t + 1 }}"))       // key charset check
        assertEquals("", scope.substitute("{{ item.title }}"))
        assertEquals("", scope.substitute("{{ dsx.variable. }}"))            // empty key
        assertEquals("", scope.substitute("{{ dsx.variable.a.b }}"))         // dotted key
    }

    @Test fun underscoredAndNumberedKeysAreLegal() {
        val s = StackScope(mapOf("a_1" to "ok"))
        assertEquals("ok", s.substitute("{{ dsx.variable.a_1 }}"))
    }

    @Test fun unterminatedSpanStaysLiteral() {
        assertEquals("a {{ dsx.variable.name", scope.substitute("a {{ dsx.variable.name"))
    }

    @Test fun noBracesIsPassthrough() {
        assertEquals("plain", scope.substitute("plain"))
    }

    // -- StackReader typed reads --

    @Test fun stringSubstitutesAttributes() {
        val r = reader("""<text label="hi {{ dsx.variable.name }}"/>""")
        assertEquals("hi Ada", r.string("label"))
        assertNull(r.string("missing"))
    }

    @Test fun textTrimsAndSubstitutes() {
        val r = reader("<text>  {{ dsx.variable.t }} s  </text>")
        assertEquals("42 s", r.text)
        assertEquals("", reader("<text/>").text)
        assertEquals("Value 42", reader("""<text value="Value {{ dsx.variable.t }}"/>""").text)
        assertEquals("Inner 42", reader("""<text value="ignored">Inner {{ dsx.variable.t }}</text>""").text)
        assertEquals("42", reader("""<text value="ignored" bind="dsx.variable.t"/>""").text)
    }

    @Test fun doubleFallsBackOnMissingOrUnparseable() {
        val r = reader("""<text size="13.5" bad="x"/>""")
        assertEquals(13.5, r.double("size", 0.0))
        assertEquals(7.0, r.double("missing", 7.0))
        assertEquals(7.0, r.double("bad", 7.0))
    }

    @Test fun unitClampsToZeroOne() {
        assertEquals(1.0, reader("""<progress value="1.7"/>""").unit("value"))
        assertEquals(0.0, reader("""<progress value="-3"/>""").unit("value"))
        assertEquals(0.25, reader("""<progress value="0.25"/>""").unit("value"))
        assertEquals(0.0, reader("<progress/>").unit("value"))               // missing → 0, clamped
    }

    @Test fun typedEnums() {
        val r = reader("""<text weight="semibold" align="leading" grow="width"/>""")
        assertEquals(StackFontWeight.SEMIBOLD, r.fontWeight)
        assertEquals(StackHAlign.LEADING, r.horizontalAlignment)
        assertEquals(StackVAlign.CENTER, r.verticalAlignment)                // "leading" is not vertical
        assertEquals(StackHAlign.LEADING, r.frameAlignment)
        assertTrue(r.growsWidth)

        val d = reader("<text/>")
        assertEquals(StackFontWeight.REGULAR, d.fontWeight)
        assertEquals(StackHAlign.CENTER, d.horizontalAlignment)
        assertEquals(StackVAlign.CENTER, d.verticalAlignment)
        assertFalse(d.growsWidth)

        val v = reader("""<text align="bottom" grow="height"/>""")
        assertEquals(StackVAlign.BOTTOM, v.verticalAlignment)
        assertFalse(v.growsWidth)                                            // height-only does not grow width
        assertTrue(reader("""<text grow="true"/>""").growsWidth)
        assertTrue(reader("""<text grow="both"/>""").growsWidth)
        assertTrue(reader("""<text grow="all"/>""").growsWidth)
    }

    // -- tapEvent: event= first, else the quoted name inside dsx.event(...) --

    @Test fun tapEventPrefersEventAttribute() {
        assertEquals("open", reader("""<text event="open" on:tap="dsx.event('other')"/>""").tapEvent)
    }

    @Test fun tapEventLiftsTheQuotedName() {
        assertEquals("open", reader("""<text on:tap="dsx.event('open')"/>""").tapEvent)
        assertEquals("open", reader("""<text on:tap='dsx.event("open")'/>""").tapEvent)
        assertEquals("open", reader("""<text on:press="dsx.event( 'open' )"/>""").tapEvent)
    }

    @Test fun tapEventFailsOpenToNull() {
        assertNull(reader("<text/>").tapEvent)
        assertNull(reader("""<text on:tap="doThing()"/>""").tapEvent)        // not dsx.event
        assertNull(reader("""<text on:tap="dsx.event(name)"/>""").tapEvent)  // unquoted → no JS
        assertNull(reader("""<text on:tap="dsx.event('')"/>""").tapEvent)    // empty name
        assertNull(reader("""<text event="" on:tap=""/>""").tapEvent)
    }

    // -- StackColor: named palette + hex, fail-open to primary --

    @Test fun namedColors() {
        assertEquals(StackColor.PRIMARY, StackColor.parse("primary"))
        assertEquals(StackColor.SECONDARY, StackColor.parse("secondary"))
        assertEquals(StackColor.DIVIDER, StackColor.parse("separator"))      // phone-vocabulary parity: the hairline, never full-alpha
        assertEquals(StackColor.ACCENT, StackColor.parse("accent"))
        assertEquals(StackColor.ACCENT, StackColor.parse("AccentColor"))     // case-insensitive
        assertEquals(0xFFFFFFFFL, StackColor.parse("white"))
        assertEquals(0x00000000L, StackColor.parse("clear"))
        assertEquals(0xFFFF3B30L, StackColor.parse("red"))
    }

    @Test fun hexColors() {
        assertEquals(0xFF112233L, StackColor.parse("#112233"))
        assertEquals(0xFF112233L, StackColor.parse("112233"))                // bare hex, Swift verbatim
        assertEquals(0x80112233L, StackColor.parse("#80112233"))             // AARRGGBB
        assertEquals(0xFFABCDEFL, StackColor.parse("#abcdef"))               // case-insensitive
        assertEquals(0xFF112233L, StackColor.parse(" #112233 "))             // trimmed
    }

    @Test fun invalidColorFailsOpenToPrimary() {
        assertEquals(StackColor.PRIMARY, StackColor.parse("nope"))
        assertEquals(StackColor.PRIMARY, StackColor.parse("#1234"))          // wrong length
        assertEquals(StackColor.PRIMARY, StackColor.parse("#11223G"))        // bad digit
        assertEquals(StackColor.PRIMARY, StackColor.parse(""))
    }

    @Test fun readerColorSubstitutesThenParses() {
        val r = StackReader(StackXML.parse("""<text color="{{ dsx.variable.c }}"/>""")!!,
                            StackScope(mapOf("c" to "#FF0000")))
        assertEquals(0xFFFF0000L, r.color("color", StackColor.PRIMARY))
        assertEquals(StackColor.ACCENT, r.color("missing", StackColor.ACCENT))
    }
}
