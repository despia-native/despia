package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Conformance tests for the snapshot render backend's kernel half — the element
/// table, per-element defaults and the uniform layout box, pinned to StackLive.swift.
class StackLiveTest {

    @AfterTest fun restoreLogSeam() {
        StackXML.kernelLog = { line -> println(line) }
    }

    private val none = StackScope(emptyMap())

    private fun resolve(xml: String, vars: Map<String, String> = emptyMap()): StackResolved =
        StackBackend.resolve(StackXML.parse(xml)!!, StackScope(vars))

    // -- entry point --

    @Test fun parsesGatesTheCaller() {
        assertTrue(StackLive.parses("<vstack><text>hi</text></vstack>"))
        assertFalse(StackLive.parses(""))
        StackXML.kernelLog = { }                        // silence the expected parse-fail log
        assertFalse(StackLive.parses("<vstack>"))
    }

    @Test fun initFromLayoutParsesOnce() {
        val live = StackLive("<vstack><text>hi</text></vstack>", mapOf("a" to "1"))
        assertEquals("vstack", live.root?.tag)
        assertEquals("1", live.scope.vars["a"])
        StackXML.kernelLog = { }
        assertNull(StackLive("<vstack>", emptyMap()).root)
    }

    @Test fun initFromNodeSkipsReparse() {
        val node = StackXML.parse("<text>hi</text>")
        val live = StackLive(node, emptyMap())
        assertEquals(node, live.root)
    }

    // -- the element table (the injectable contract) --

    @Test fun tableCarriesTheFullSnapshotVocabulary() {
        assertEquals(
            setOf("vstack", "hstack", "zstack", "stack", "text", "countdown", "button",
                  "image", "progress", "gauge", "spacer", "list", "scroll", "divider"),
            StackBackend.elements.keys)
        // No element owns its layout box in the base table (ownsLayoutBox defaults false).
        assertTrue(StackBackend.elements.values.none { it.ownsLayoutBox })
    }

    @Test fun countdownIsAnOsLiveToken() {
        // Epoch form rides through; ISO-8601 normalizes to epoch; garbage pins at 0
        // (already elapsed — renders 0:00, never a crash). Vars interpolate like text.
        val epoch = resolve("""<countdown until="1893456000" size="20"/>""").render
        assertIs<StackLiveRender.Countdown>(epoch)
        assertEquals(1893456000.0, epoch.untilEpochSeconds)
        assertEquals(20.0, epoch.size)
        val iso = resolve("""<countdown until="2030-01-01T00:00:00Z"/>""").render
        assertIs<StackLiveRender.Countdown>(iso)
        assertEquals(1893456000.0, iso.untilEpochSeconds)
        val bound = resolve("""<countdown until="{{ dsx.variable.ends }}"/>""", mapOf("ends" to "1893456000")).render
        assertIs<StackLiveRender.Countdown>(bound)
        assertEquals(1893456000.0, bound.untilEpochSeconds)
        val junk = resolve("""<countdown until="soon"/>""").render
        assertIs<StackLiveRender.Countdown>(junk)
        assertEquals(0.0, junk.untilEpochSeconds)
    }

    @Test fun snapshotButtonCompilesTheOneLiteralCallShapeOnly() {
        // The COMPILED-INTERACTION law: one literal dsx.module call, nothing else.
        assertEquals(StackNodeCalls.Call("toast", "show", "{}"),
                     StackNodeCalls.parse("dsx.module.toast.show()"))
        assertEquals(StackNodeCalls.Call("mic", "toggle", """{"on": true}"""),
                     StackNodeCalls.parse("""dsx.module.mic.toggle({'on': true})"""))
        // A NESTED chain spelling parses whole — scheme = head, action = the dotted
        // remainder — so the gate key "$scheme.$action" is the full authored spelling
        // the baked role tables carry (the Swift twin returns the same shape).
        assertEquals(StackNodeCalls.Call("watch", "health.workout", """{"on": true}"""),
                     StackNodeCalls.parse("""dsx.module.watch.health.workout({'on': true})"""))
        assertNull(StackNodeCalls.parse("bump()"))                       // bare action = JSE = never
        assertNull(StackNodeCalls.parse("dsx.module.toast.show(); x=1")) // statements = never
        assertNull(StackNodeCalls.parse("dsx.module.toast()"))           // no action segment
        assertNull(StackNodeCalls.parse("dsx.module.toast..show()"))     // empty segment = typo = inert (iOS twin law)
        assertNull(StackNodeCalls.parse("dsx.module.watch..health.workout()")) // empty MID-CHAIN segment too
        assertNull(StackNodeCalls.parse("dsx.module.mic.toggle({on: true})"))       // unquoted key: not literal JSON —
        assertNull(StackNodeCalls.parse("""dsx.module.mic.toggle({"on": true,})""")) // trailing comma — STRICT on both platforms
        // The element: parsed call rides the variant; anything else = inert label.
        val live = resolve("""<button label="Ping" on:tap="dsx.module.toast.show()"/>""").render
        assertIs<StackLiveRender.Button>(live)
        assertEquals("toast", live.scheme); assertEquals("show", live.action)
        val inert = resolve("""<button label="Plain" on:tap="count = count + 1"/>""").render
        assertIs<StackLiveRender.Button>(inert)
        assertEquals("", inert.scheme)
    }

    @Test fun unknownTagRendersNothingButKeepsItsBox() {
        val r = resolve("""<mystery bg="#FF0000" padding="4"/>""")
        assertIs<StackLiveRender.None>(r.render)
        assertNotNull(r.box)                             // Swift: EmptyView + StackLayoutBox
        assertEquals(0xFFFF0000L, r.box.bg)
        assertEquals(4.0, r.box.padH)
    }

    @Test fun aSupersetTableRendersExtraTagsThroughTheSameDispatch() {
        val gauge = object : StackElement {              // a surface registering <mystery>
            override val tag = "mystery"
            override val ownsLayoutBox = true
            override fun body(r: StackReader) = StackLiveRender.Text("x", 1.0,
                StackFontWeight.REGULAR, StackColor.PRIMARY, 1)
        }
        val table = StackBackend.elements + (gauge.tag to gauge)
        val r = StackBackend.resolve(StackXML.parse("<mystery/>")!!, none, table)
        assertIs<StackLiveRender.Text>(r.render)
        assertNull(r.box)                                // ownsLayoutBox → no shared box
    }

    // -- containers: axes, spacing defaults, alignment --

    @Test fun stackDefaults() {
        val v = resolve("<vstack/>").render as StackLiveRender.Stack
        assertEquals(StackAxis.VERTICAL, v.axis); assertEquals(4.0, v.spacing)
        val h = resolve("<hstack/>").render as StackLiveRender.Stack
        assertEquals(StackAxis.HORIZONTAL, h.axis); assertEquals(6.0, h.spacing)
        val z = resolve("""<zstack align="leading"/>""").render as StackLiveRender.Stack
        assertEquals(StackAxis.DEPTH, z.axis)
        assertEquals(StackHAlign.CENTER, z.frameAlign)   // ZStack ignores align (Swift verbatim)
        val l = resolve("<list/>").render as StackLiveRender.Stack
        assertEquals(StackAxis.VERTICAL, l.axis); assertEquals(6.0, l.spacing)
        val s = resolve("<scroll/>").render as StackLiveRender.Stack
        assertEquals(StackAxis.VERTICAL, s.axis); assertEquals(4.0, s.spacing)
    }

    @Test fun genericStackIsWebTrue() {
        val d = resolve("<stack/>").render as StackLiveRender.Stack
        assertEquals(StackAxis.VERTICAL, d.axis)
        assertEquals(0.0, d.spacing)                     // unset gap = 0, unlike the legacy stacks
        val row = resolve("""<stack flexDirection="row-reverse"/>""").render as StackLiveRender.Stack
        assertEquals(StackAxis.HORIZONTAL, row.axis)     // hasPrefix("row"), Swift verbatim
        val grid = resolve("""<stack display="grid" align="trailing"/>""").render as StackLiveRender.Stack
        assertEquals(StackAxis.DEPTH, grid.axis)
        assertEquals(StackHAlign.TRAILING, grid.frameAlign)
    }

    @Test fun containerAlignmentReadsTheAlignAttribute() {
        val v = resolve("""<vstack align="leading" spacing="12"/>""").render as StackLiveRender.Stack
        assertEquals(StackHAlign.LEADING, v.hAlign); assertEquals(12.0, v.spacing)
        val h = resolve("""<hstack align="top"/>""").render as StackLiveRender.Stack
        assertEquals(StackVAlign.TOP, h.vAlign)
    }

    // -- leaf elements: defaults pinned to the Swift source --

    @Test fun textDefaults() {
        val t = resolve("<text>hi</text>").render as StackLiveRender.Text
        assertEquals("hi", t.text)
        assertEquals(13.0, t.size)
        assertEquals(StackFontWeight.REGULAR, t.weight)
        assertEquals(StackColor.PRIMARY, t.color)
        assertEquals(1, t.lines)
        val s = resolve("""<text size="20" weight="bold" color="red" lines="3">x</text>""")
            .render as StackLiveRender.Text
        assertEquals(20.0, s.size); assertEquals(StackFontWeight.BOLD, s.weight)
        assertEquals(0xFFFF3B30L, s.color); assertEquals(3, s.lines)
    }

    @Test fun textInterpolates() {
        val t = resolve("<text>{{ dsx.variable.n }}%</text>", mapOf("n" to "40"))
            .render as StackLiveRender.Text
        assertEquals("40%", t.text)
    }

    @Test fun imageDefaults() {
        val i = resolve("<image/>").render as StackLiveRender.Image
        assertEquals("circle", i.symbol)                 // the Swift default symbol
        assertEquals(16.0, i.size)
        assertEquals(StackColor.ACCENT, i.color)
        val s = resolve("""<image symbol="bolt.fill" size="24" color="white"/>""")
            .render as StackLiveRender.Image
        assertEquals("bolt.fill", s.symbol); assertEquals(24.0, s.size)
    }

    @Test fun progressClampsItsValue() {
        val p = resolve("""<progress value="2.5"/>""").render as StackLiveRender.Progress
        assertEquals(1.0, p.value)
        assertEquals(StackColor.ACCENT, p.tint)
    }

    @Test fun gaugeDefaults() {
        val g = resolve("""<gauge value="0.4">40</gauge>""").render as StackLiveRender.Gauge
        assertEquals(0.4, g.value)
        assertEquals(38.0, g.diameter)                   // size2 → diameter → 38
        assertEquals(2.5, g.line)
        assertEquals(0x26007AFFL, g.track)               // accent @ 15% (Swift verbatim)
        assertEquals(StackColor.ACCENT, g.tint)
        assertEquals("40", g.label)
        assertEquals(9.0, g.labelSize)
        val sized = resolve("""<gauge size2="50" diameter="99"/>""").render as StackLiveRender.Gauge
        assertEquals(50.0, sized.diameter)               // size2 wins over diameter
    }

    @Test fun spacerAndDivider() {
        assertIs<StackLiveRender.Spacer>(resolve("<spacer/>").render)
        val d = resolve("<divider/>").render as StackLiveRender.Divider
        assertEquals(StackColor.DIVIDER, d.color)
    }

    // -- the uniform layout box --

    @Test fun layoutBoxReadsTheSharedAttributes() {
        val b = resolve("""<vstack padding="8" bg="black" radius="12" opacity="0.5" grow="width"/>""").box
        assertNotNull(b)
        assertEquals(8.0, b.padH); assertEquals(8.0, b.padV)
        assertEquals(0xFF000000L, b.bg)
        assertEquals(12.0, b.radius)
        assertEquals(0.5, b.opacity)
        assertTrue(b.growsWidth)
    }

    @Test fun axisPaddingOverridesUniformPadding() {
        val b = resolve("""<text padding="8" paddingh="2">x</text>""").box!!
        assertEquals(2.0, b.padH)
        assertEquals(8.0, b.padV)
    }

    @Test fun layoutBoxDefaults() {
        val b = resolve("<text>x</text>").box!!
        assertEquals(0.0, b.padH); assertEquals(0.0, b.padV)
        assertNull(b.bg)                                 // null = clear, backend paints nothing
        assertEquals(0.0, b.radius); assertEquals(1.0, b.opacity)
        assertFalse(b.growsWidth)
        assertEquals(StackHAlign.CENTER, b.frameAlignment)
    }
}
