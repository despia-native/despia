//
//  StackCascadeActionTest.kt — plain-JVM units for the renderer's two new pure seams:
//
//  • the FOUR-LAYER attrs cascade (resolvedAttrs — the Stack.swift `attrs` twin):
//    legacy classes → compiled DSX-CSS sheet (css-owner) → inline DSX-CSS → element
//    attrs/overrides, plus the structural translations (axis-correct gap → spacing,
//    explicit align beats align-items, display:none → css-hidden) and the state flips
//    (dark media, class-set match) — conformance-shaped against the iOS reference.
//
//  • `<action as=…>` registration (registerHeadAction — the raw() "action" case twin):
//    declaration through :core's registerAction seam, the caller-scope inputs, the
//    args-object override, and the same-name replace rule — invoked through the REAL
//    JSERunner statement dispatch, so what's asserted is the end-to-end call shape.
//

package despia.engine.render

import despia.engine.CSSEngine
import despia.engine.CSSResolver
import despia.engine.JSERunner
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.StackXML
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StackCascadeActionTest {

    private fun ctx(isDark: Boolean = true, classes: Set<String> = emptySet()) =
        CSSResolver.Context(isDark = isDark, windowWidth = 390.0, windowHeight = 844.0, classes = classes)

    private fun node(tag: String, vararg attrs: Pair<String, String>) =
        StackNode(tag, mapOf(*attrs), emptyList())

    // ── layer 3: inline DSX-CSS (the ':' migration heuristic) ─────────────────────────

    @Test fun inlineCssResolvesIntoLegacyAttributes() {
        val store = StackStore()
        val n = node("vstack", "style" to "padding: 1rem; background: #111113; border-radius: 14px")
        val a = resolvedAttrs(n, store, null, ctx())
        assertEquals("16", a["padding"])
        assertEquals("#111113", a["background"])
        assertEquals("14", a["radius"])
        assertNull(a["style"])                     // consumed as CSS, not a legacy named style
    }

    @Test fun bareStyleTokenStaysALegacyNamedStyle() {
        val store = StackStore()
        val a = resolvedAttrs(node("text", "style" to "card"), store, null, ctx())
        assertEquals("card", a["style"])           // no ':' — the legacy path untouched
        // A formula style that interpolates to a bare token also stays legacy.
        store.vars["sel"] = true
        val b = resolvedAttrs(node("text", "style" to "{{ sel ? 'card' : 'sheet' }}"), store, null, ctx())
        assertEquals("card", b["style"])
    }

    @Test fun elementAttributesAlwaysWinOverCss() {
        val store = StackStore()
        val n = node("vstack", "style" to "padding: 16px", "padding" to "4")
        assertEquals("4", resolvedAttrs(n, store, null, ctx())["padding"])
    }

    // ── layer 2: the component sheet, scoped by css-owner + class set ──────────────────

    @Test fun sheetLayerAppliesByCssOwnerAndClasses() {
        CSSEngine.register("CardA", """{"rules":[{"type":"rule","selector":".hero",
            "declarations":[{"property":"padding","value":"24px"},{"property":"opacity","value":"0.9"}]}]}""")
        val store = StackStore()
        val n = node("vstack", "css-owner" to "CardA", "class" to "hero")
        val a = resolvedAttrs(n, store, null, ctx())
        assertEquals("24", a["padding"])
        assertEquals("0.9", a["opacity"])
        // No class match → the sheet stays silent.
        val miss = resolvedAttrs(node("vstack", "css-owner" to "CardA", "class" to "other"), store, null, ctx())
        assertNull(miss["padding"])
    }

    @Test fun inlineBeatsSheetBeatsLegacyClass() {
        CSSEngine.register("CardB", """{"rules":[{"type":"rule","selector":".hero",
            "declarations":[{"property":"padding","value":"24px"}]}]}""")
        val store = StackStore()
        store.classes["hero"] = mapOf("padding" to "1", "color" to "white")   // layer 1
        val n = node("vstack", "css-owner" to "CardB", "class" to "hero", "style" to "padding: 32px")
        val a = resolvedAttrs(n, store, null, ctx())
        assertEquals("32", a["padding"])           // inline (3) beats sheet (2) beats class (1)
        assertEquals("white", a["color"])          // untouched keys survive from the weaker layer
    }

    @Test fun elementCustomPropertyFeedsSheetVars() {
        CSSEngine.register("CardC", """{"rules":[{"type":"rule","selector":".hero",
            "declarations":[{"property":"padding","value":"var(--pad, 8px)"}]}]}""")
        val store = StackStore()
        val n = node("vstack", "css-owner" to "CardC", "class" to "hero", "style" to "--pad: 20px")
        assertEquals("20", resolvedAttrs(n, store, null, ctx())["padding"])
    }

    @Test fun darkFlipReresolvesTheSheet() {
        CSSEngine.register("Panel", """{"rules":[
            {"type":"rule","selector":".p","declarations":[{"property":"color","value":"#000"}],
             "children":[{"type":"at","name":"media","prelude":"(prefers-color-scheme: dark)",
                          "declarations":[{"property":"color","value":"#fff"}],"children":[]}]}]}""")
        val store = StackStore()
        val n = node("text", "css-owner" to "Panel", "class" to "p")
        assertEquals("#fff", resolvedAttrs(n, store, null, ctx(isDark = true))["color"])
        assertEquals("#000", resolvedAttrs(n, store, null, ctx(isDark = false))["color"])
    }

    // ── structural translations (need the node's tag/axis) ─────────────────────────────

    @Test fun gapCollapsesOntoSpacingAxisCorrectly() {
        val store = StackStore()
        val v = resolvedAttrs(node("vstack", "style" to "gap: 8px 12px"), store, null, ctx())
        assertEquals("8", v["spacing"])            // column consumes the ROW gap
        val h = resolvedAttrs(node("hstack", "style" to "gap: 8px 12px"), store, null, ctx())
        assertEquals("12", h["spacing"])           // row consumes the COLUMN gap
        val row = resolvedAttrs(node("stack", "style" to "flex-direction: row; gap: 8px 12px"), store, null, ctx())
        assertEquals("12", row["spacing"])         // generic stack resolves its axis from flex-direction
        val col = resolvedAttrs(node("stack", "style" to "gap: 8px 12px"), store, null, ctx())
        assertEquals("8", col["spacing"])          // column when unset
        // An explicit spacing attribute still wins (it lives in layer 4).
        val explicit = resolvedAttrs(node("vstack", "style" to "gap: 8px", "spacing" to "2"), store, null, ctx())
        assertEquals("2", explicit["spacing"])
    }

    @Test fun explicitAlignBeatsCssAlignItems() {
        val store = StackStore()
        val n = node("stack", "style" to "align-items: center", "align" to "leading")
        val a = resolvedAttrs(n, store, null, ctx())
        assertNull(a["alignItems"])                // the element's own align wins outright
        assertEquals("leading", a["align"])
        val css = resolvedAttrs(node("stack", "style" to "align-items: center"), store, null, ctx())
        assertEquals("center", css["alignItems"])  // CSS steers when the element doesn't
    }

    @Test fun displayNoneRidesTheCssHiddenChannel() {
        val store = StackStore()
        val a = resolvedAttrs(node("vstack", "style" to "display: none"), store, null, ctx())
        assertEquals("true", a["css-hidden"])
        assertEquals("none", a["display"])
    }

    // ── the cross-axis maps the generic <stack> consumes (StackContainerElement twins) ──

    @Test fun cssAlignWordsNormalizeOntoTheLegacyAnchors() {
        assertEquals(androidx.compose.ui.Alignment.Start, crossHAlign("flex-start"))
        assertEquals(androidx.compose.ui.Alignment.CenterHorizontally, crossHAlign("center"))
        assertEquals(androidx.compose.ui.Alignment.End, crossHAlign("flex-end"))
        assertEquals(androidx.compose.ui.Alignment.Start, crossHAlign("stretch"))       // v1 fallback
        assertEquals(androidx.compose.ui.Alignment.Top, crossVAlign("flex-start"))
        assertEquals(androidx.compose.ui.Alignment.CenterVertically, crossVAlign(""))   // row default = center
        assertEquals(androidx.compose.ui.Alignment.Bottom, crossVAlign("bottom"))
        assertEquals(androidx.compose.ui.Alignment.Center, overlayAlign("stretch"))
        assertEquals(androidx.compose.ui.Alignment.TopStart, overlayAlign("topLeading"))
    }

    // ── <action as=…> — declaration, inputs, override rules, invocation ────────────────

    @Test fun headActionRegistersAndRunsThroughTheRunner() {
        val store = StackStore()
        val env = JSERunner(store)
        val n = StackXML.parse("""<action as="bump" step="1">count = (count || 0) + step</action>""")!!
        registerHeadAction(n, n.attrs, store)
        env.run("bump()", null)                        // declared input evaluates in the caller's scope
        assertEquals(1.0, store.vars["count"])
        env.run("bump({ step: 5 })", null)             // 1st-arg object overrides the declared input
        assertEquals(6.0, store.vars["count"])
    }

    @Test fun actionInputsExcludeReservedAsAndId() {
        val store = StackStore()
        val env = JSERunner(store)
        val n = StackNode("action", mapOf("as" to "echo", "id" to "x1", "what" to "'hi'"), emptyList(), "out = what; idv = id")
        registerHeadAction(n, n.attrs, store)
        env.run("echo()", null)
        assertEquals("hi", store.vars["out"])
        assertNotEquals("x1", store.vars["idv"])       // `id` is identity, never an input (unknown name → empty)
    }

    @Test fun sameNameReRegistrationReplaces() {
        val store = StackStore()
        val env = JSERunner(store)
        registerHeadAction(StackNode("action", mapOf("as" to "go"), emptyList(), "v = 1"), mapOf("as" to "go"), store)
        registerHeadAction(StackNode("action", mapOf("as" to "go"), emptyList(), "v = 2"), mapOf("as" to "go"), store)
        env.run("go()", null)
        assertEquals(2.0, store.vars["v"])             // idempotent re-render: the LAST definition owns the name
    }

    @Test fun inlineFunctionBodiesRegisterToo() {
        val store = StackStore()
        val env = JSERunner(store)
        val n = StackNode("action", mapOf("as" to "calc"), emptyList(),
                          "function twice(n) { return n * 2 }\nr = twice(4)")
        registerHeadAction(n, n.attrs, store)
        env.run("calc()", null)
        assertEquals(8.0, store.vars["r"])
    }

    @Test fun anonymousActionRegistersOnlyFunctions() {
        val store = StackStore()
        val env = JSERunner(store)
        val n = StackNode("action", emptyMap(), emptyList(), "function three() { return 3 }")
        registerHeadAction(n, n.attrs, store)          // no `as` → nothing named registers, no throw
        env.run("t = three()", null)
        assertEquals(3.0, store.vars["t"])
    }
}
