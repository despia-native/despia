//
//  CssEngineTest.kt — conformance-shaped units for the DSX-CSS runtime twins
//  (CssIR / CssValue / CssResolver / CssBridge / CssInline / CssEngine). Each
//  block pins a behavior of the iOS reference (ClosedSource/Registry/DSXCSS/*)
//  — selector matching, layer/source order, @media state flips, var() scopes,
//  unit conversion, and the bridge's structural translations.
//

package despia.engine

import kotlin.test.*

class CssEngineTest {

    private fun ctx(
        isDark: Boolean = true,
        width: Double = 390.0,
        height: Double = 844.0,
        fontScale: Double = 1.0,
        reduceMotion: Boolean = false,
        classes: Set<String> = emptySet(),
    ) = CSSResolver.Context(isDark, width, height, fontScale, reduceMotion, classes)

    private fun sheet(vararg rules: CSSRule) = CSSSheet(rules.toList())
    private fun rule(selector: String, vararg decls: CSSDecl, children: List<CSSRule> = emptyList()) =
        CSSRule(type = "rule", selector = selector, declarations = decls.toList(), children = children)
    private fun at(name: String, prelude: String, vararg decls: CSSDecl, children: List<CSSRule> = emptyList()) =
        CSSRule(type = "at", name = name, prelude = prelude, declarations = decls.toList(), children = children)
    private fun d(p: String, v: String) = CSSDecl(property = p, value = v)

    @AfterTest fun tearDown() = CSSEngine.reset()

    // MARK: - CSSSheet IR decode (the parser.rb output contract)

    @Test fun sheetDecodesTheCompiledIR() {
        val ir = """
            {"rules":[
              {"type":"rule","selector":".card","declarations":[
                 {"property":"padding","value":"16px"},
                 {"property":"--tint","value":"#FF2D55","custom":true}],
               "children":[{"type":"at","name":"media","prelude":"(prefers-color-scheme: dark)",
                            "declarations":[{"property":"color","value":"#fff"}],"children":[]}]},
              {"type":"at","name":"media","prelude":"(min-width: 600px)","declarations":[],"children":[]}],
             "interpolations":["mood"]}
        """.trimIndent()
        val s = CSSSheet.fromJson(ir)
        assertNotNull(s)
        assertEquals(2, s.rules.size)
        assertEquals(".card", s.rules[0].selector)
        assertEquals(2, s.rules[0].declarations.size)
        assertTrue(s.rules[0].declarations[1].custom)
        assertEquals("media", s.rules[0].children[0].name)
        assertEquals(listOf("mood"), s.interpolations)
        assertNull(CSSSheet.fromJson("not json"))
    }

    // MARK: - CSSResolver.matches (the v1 selector subset)

    @Test fun selectorMatchesClassChainsAgainstTheClassSet() {
        val c = ctx(classes = setOf("card", "wide"))
        assertTrue(CSSResolver.matches(".card", c, forTokens = false))
        assertTrue(CSSResolver.matches(".card.wide", c, forTokens = false))       // chain = subset
        assertFalse(CSSResolver.matches(".card.tall", c, forTokens = false))      // missing class
        assertTrue(CSSResolver.matches("&.card", c, forTokens = false))           // element-owned form
        assertTrue(CSSResolver.matches(".tall, .card", c, forTokens = false))     // group: any arm
        // The compiled sheet formats a grouped selector with newlines: `.a,\n.b`. Every arm
        // past the first must still match — a whitespace-only (no-newline) trim dropped them,
        // so grouped rules (e.g. a shared `flex-direction: row`) applied to their FIRST class
        // only on native (the iPad sidebar/chip-row collapse). Both arms below must match.
        assertTrue(CSSResolver.matches(".tall,\n.card", c, forTokens = false))    // trailing arm after ,\n
        assertTrue(CSSResolver.matches(".card,\n.tall", c, forTokens = false))    // leading arm, ,\n before .tall
        assertFalse(CSSResolver.matches(".tall", c, forTokens = false))
    }

    @Test fun rootIsTokenGatheringOnly() {
        val c = ctx(classes = setOf("card"))
        assertTrue(CSSResolver.matches(":root", c, forTokens = true))
        assertFalse(CSSResolver.matches(":root", c, forTokens = false))
    }

    @Test fun v1SkipsCombinatorsTagsAndStates() {
        val c = ctx(classes = setOf("a", "b"))
        assertFalse(CSSResolver.matches(".a .b", c, forTokens = false))    // descendant
        assertFalse(CSSResolver.matches(".a > .b", c, forTokens = false))  // child
        assertFalse(CSSResolver.matches("button", c, forTokens = false))   // tag
        assertFalse(CSSResolver.matches(".a:pressed", c, forTokens = false)) // pseudo-class (Taffy phase)
    }

    // MARK: - @media evaluation (the state flips)

    @Test fun mediaColorSchemeFlipsWithTheContext() {
        assertTrue(CSSResolver.mediaApplies("media", "(prefers-color-scheme: dark)", ctx(isDark = true)))
        assertFalse(CSSResolver.mediaApplies("media", "(prefers-color-scheme: dark)", ctx(isDark = false)))
        assertTrue(CSSResolver.mediaApplies("media", "(prefers-color-scheme: light)", ctx(isDark = false)))
    }

    @Test fun mediaWidthBoundsUseWindowPoints() {
        assertTrue(CSSResolver.mediaApplies("media", "(min-width: 600px)", ctx(width = 800.0)))
        assertFalse(CSSResolver.mediaApplies("media", "(min-width: 600px)", ctx(width = 390.0)))
        assertTrue(CSSResolver.mediaApplies("media", "(max-width: 600px)", ctx(width = 390.0)))
        assertFalse(CSSResolver.mediaApplies("media", "(max-width: 600px)", ctx(width = 800.0)))
    }

    @Test fun mediaClausesComposeWithAnd() {
        val c = ctx(isDark = true, width = 800.0)
        assertTrue(CSSResolver.mediaApplies("media", "(prefers-color-scheme: dark) and (min-width: 600px)", c))
        assertFalse(CSSResolver.mediaApplies("media", "(prefers-color-scheme: light) and (min-width: 600px)", c))
    }

    @Test fun mediaTypesReduceMotionAndUnknowns() {
        assertTrue(CSSResolver.mediaApplies("media", "screen and (min-width: 100px)", ctx(width = 200.0)))
        assertFalse(CSSResolver.mediaApplies("media", "print", ctx()))
        assertTrue(CSSResolver.mediaApplies("media", "(prefers-reduced-motion: reduce)", ctx(reduceMotion = true)))
        assertFalse(CSSResolver.mediaApplies("media", "(prefers-reduced-motion: reduce)", ctx(reduceMotion = false)))
        assertFalse(CSSResolver.mediaApplies("media", "not (min-width: 100px)", ctx(width = 50.0)))  // `not` inert v1
        assertFalse(CSSResolver.mediaApplies("media", "(orientation: landscape)", ctx()))            // unknown feature inert
        assertFalse(CSSResolver.mediaApplies("container", "(min-width: 100px)", ctx(width = 200.0))) // window ≠ container
        assertFalse(CSSResolver.mediaApplies("starting-style", "", ctx()))                            // rides enter=
        assertFalse(CSSResolver.mediaApplies("supports", "(display: grid)", ctx()))                   // build/later phase
    }

    // MARK: - tokens + declarations (layer order, source order, nesting)

    @Test fun tokensGatherFromRootAndMatchedRulesOnly() {
        val s = sheet(
            rule(":root", d("--pad", "16px"), d("color", "#fff")),
            rule(".card", d("--pad", "20px")),
            rule(".other", d("--pad", "99px")),
        )
        val t = CSSResolver.tokens(s, ctx(classes = setOf("card")))
        assertEquals("20px", t["--pad"])          // matched rule overrides :root (source order)
        assertNull(t["color"])                    // non-custom never a token
    }

    @Test fun darkTokensRideMatchedMediaBlocks() {
        val s = sheet(
            rule(":root", d("--bg", "#fff")),
            at("media", "(prefers-color-scheme: dark)",
               children = listOf(rule(":root", d("--bg", "#000")))),
        )
        assertEquals("#000", CSSResolver.tokens(s, ctx(isDark = true))["--bg"])
        assertEquals("#fff", CSSResolver.tokens(s, ctx(isDark = false))["--bg"])
    }

    @Test fun laterDeclarationWinsWithinALayer() {
        val s = sheet(
            rule(".card", d("padding", "10px")),
            rule(".card", d("padding", "24px")),
        )
        val c = ctx(classes = setOf("card"))
        val out = CSSResolver.declarations(s, c, emptyMap())
        assertEquals("24px", out["padding"])      // source order, never specificity arithmetic
    }

    @Test fun nestedMediaDeclarationsApplyOnlyInsideAMatchedRule() {
        val s = sheet(
            rule(".card", d("padding", "10px"),
                 children = listOf(at("media", "(prefers-color-scheme: dark)", d("padding", "24px")))),
            at("media", "(prefers-color-scheme: dark)", d("color", "#fff")),   // TOP-LEVEL bare decls = invalid CSS → inert
        )
        val out = CSSResolver.declarations(s, ctx(isDark = true, classes = setOf("card")), emptyMap())
        assertEquals("24px", out["padding"])      // the nested dark override lands
        assertNull(out["color"])                  // the top-level bare declaration never leaks
        val light = CSSResolver.declarations(s, ctx(isDark = false, classes = setOf("card")), emptyMap())
        assertEquals("10px", light["padding"])    // state flip back
    }

    @Test fun varSubstitutionAndInvalidAtComputedValue() {
        val s = sheet(rule(".card", d("padding", "var(--pad)"), d("color", "var(--missing)")))
        val out = CSSResolver.declarations(s, ctx(classes = setOf("card")), mapOf("--pad" to "16px"))
        assertEquals("16px", out["padding"])
        assertNull(out["color"])                  // unknown var, no fallback → declaration drops
    }

    // MARK: - CSSValue (units + var machinery)

    @Test fun pointsParsesTheUnitGrammar() {
        val m = CSSMetrics(remBase = 16.0, windowWidth = 400.0, windowHeight = 800.0)
        assertEquals(12.0, CSSValue.points("12px", metrics = m))
        assertEquals(24.0, CSSValue.points("1.5rem", metrics = m))
        assertEquals(20.0, CSSValue.points("2em", emBase = 10.0, metrics = m))
        assertEquals(40.0, CSSValue.points("10vw", metrics = m))
        assertEquals(80.0, CSSValue.points("10vh", metrics = m))
        assertEquals(14.0, CSSValue.points("14", metrics = m))       // bare number = px per the catalog
        assertNull(CSSValue.points("100%", metrics = m))             // structural, caller's problem
        assertNull(CSSValue.points("auto", metrics = m))
        assertNull(CSSValue.points("calc(100% - 8px)", metrics = m))
        assertNull(CSSValue.points("nanpx", metrics = m))            // non-finite parse drops
        assertNull(CSSValue.points("bogus", metrics = m))
    }

    @Test fun remScalesWithFontScale() {
        val c = ctx(fontScale = 1.5)
        assertEquals(24.0, CSSValue.points("1rem", metrics = c.metrics))   // 16 × 1.5
    }

    @Test fun varResolvesFallbacksAndCycles() {
        val t = mapOf("--a" to "1px", "--b" to "var(--a)")
        assertEquals("1px", CSSValue.resolveVars("var(--a)", t))
        assertEquals("1px", CSSValue.resolveVars("var(--b)", t))                    // nested var
        assertEquals("9px", CSSValue.resolveVars("var(--zzz, 9px)", t))             // fallback
        assertEquals("", CSSValue.resolveVars("var(--zzz)", t))                     // unknown, no fallback → invalid
        val cyc = mapOf("--x" to "var(--y)", "--y" to "var(--x)")
        assertEquals("", CSSValue.resolveVars("var(--x)", cyc))                     // budget kills the rotation
        assertEquals("0 1px", CSSValue.resolveVars("0 var(--a", t))                 // unterminated: substitutes, never hangs (iOS scan)
    }

    // MARK: - CSSInline (the one sanctioned runtime parse)

    @Test fun inlineParsesFlatDeclarations() {
        val decls = CSSInline.declarations("padding: 16px; COLOR: white /* c */; --tint: #f00")
        assertEquals(3, decls.size)
        assertEquals("padding", decls[0].property)
        assertEquals("color", decls[1].property)          // properties lowercase; custom props stay as-written
        assertEquals("white", decls[1].value)
        assertTrue(decls[2].custom)
    }

    @Test fun inlineSkipsNestedBlocksBraceBalanced() {
        val decls = CSSInline.declarations("padding: 8px; &.on { color: red; @media (x) { a: b } } opacity: 0.5")
        assertEquals(listOf("padding", "opacity"), decls.map { it.property })
    }

    @Test fun inlineKeepsParenValuesAndStrings() {
        val decls = CSSInline.declarations("background: url(\"a)b.png\"); gap: var(--g, 4px)")
        assertEquals("url(\"a)b.png\")", decls[0].value)   // ')' inside the string must not close the group
        assertEquals("var(--g, 4px)", decls[1].value)
    }

    @Test fun inlineCustomPropertiesSurface() {
        assertEquals(mapOf("--pad" to "20px"), CSSInline.customProperties("--pad: 20px; color: white"))
    }

    // MARK: - CSSBridge (declarations → legacy attributes)

    @Test fun bridgePaddingShorthandAndLonghands() {
        val m = CSSMetrics()
        assertEquals("16", CSSBridge.attributes(mapOf("padding" to "16px"), m)["padding"])
        val two = CSSBridge.attributes(mapOf("padding" to "8px 12px"), m)
        assertEquals("8", two["paddingV"]); assertEquals("12", two["paddingH"]); assertNull(two["padding"])
        val four = CSSBridge.attributes(mapOf("padding" to "1px 2px 3px 4px"), m)
        assertEquals("1", four["paddingTop"]); assertEquals("2", four["paddingRight"])
        assertEquals("3", four["paddingBottom"]); assertEquals("4", four["paddingLeft"])
        // Longhand OVERRIDES the shorthand edge (CSS override, never the legacy additive stack).
        val mixed = CSSBridge.attributes(mapOf("padding" to "8px", "padding-top" to "20px"), m)
        assertEquals("20", mixed["paddingTop"]); assertEquals("8", mixed["paddingBottom"])
        assertEquals("8", mixed["paddingH"]); assertNull(mixed["padding"])
    }

    @Test fun bridgeBackgroundAliasPrecedenceAndTransparent() {
        val m = CSSMetrics()
        val a = CSSBridge.attributes(mapOf("background" to "#111", "background-color" to "#222"), m)
        assertEquals("#222", a["background"])                                   // longhand beats shorthand
        assertEquals("clear", CSSBridge.attributes(mapOf("background" to "transparent"), m)["background"])
        assertEquals("clear", CSSBridge.attributes(mapOf("color" to "transparent"), m)["color"])
    }

    @Test fun bridgeStructuralWidthHeightAndGrow() {
        val m = CSSMetrics()
        assertEquals("width", CSSBridge.attributes(mapOf("width" to "100%"), m)["grow"])
        assertEquals("true", CSSBridge.attributes(mapOf("width" to "100%", "height" to "100%"), m)["grow"])
        assertEquals("fit", CSSBridge.attributes(mapOf("width" to "fit-content"), m)["width"])
        assertEquals("120", CSSBridge.attributes(mapOf("width" to "120px"), m)["width"])
        assertEquals("40", CSSBridge.attributes(mapOf("min-height" to "40px"), m)["minHeight"])
    }

    @Test fun bridgeGapFamilyIsAxisLonghandCorrect() {
        val m = CSSMetrics()
        val g = CSSBridge.attributes(mapOf("gap" to "8px 12px"), m)
        assertEquals("8", g["rowGap"]); assertEquals("12", g["columnGap"])
        val one = CSSBridge.attributes(mapOf("gap" to "0.5rem"), m)
        assertEquals("8", one["rowGap"]); assertEquals("8", one["columnGap"])
        val long = CSSBridge.attributes(mapOf("gap" to "8px", "column-gap" to "20px"), m)
        assertEquals("20", long["columnGap"]); assertEquals("8", long["rowGap"])   // longhand beats shorthand
    }

    @Test fun bridgeFontWeightAndSizes() {
        val m = CSSMetrics()
        assertEquals("semibold", CSSBridge.attributes(mapOf("font-weight" to "600"), m)["fontWeight"])
        assertEquals("bold", CSSBridge.attributes(mapOf("font-weight" to "bold"), m)["fontWeight"])
        assertEquals("regular", CSSBridge.attributes(mapOf("font-weight" to "normal"), m)["fontWeight"])
        assertEquals("heavy", CSSBridge.attributes(mapOf("font-weight" to "800"), m)["fontWeight"])
        assertEquals("22", CSSBridge.attributes(mapOf("font-size" to "1.375rem"), m)["fontSize"])
        // em resolves against the element's OWN font-size (the em base), not the rem base.
        val em = CSSBridge.attributes(mapOf("font-size" to "20px", "padding" to "0.5em"), m)
        assertEquals("10", em["padding"])
    }

    @Test fun bridgePassthroughsAndTranslations() {
        val m = CSSMetrics()
        val a = CSSBridge.attributes(mapOf(
            "flex-direction" to "row", "flex-wrap" to "wrap",
            "align-items" to "center", "display" to "none",
            "aspect-ratio" to "16 / 9", "letter-spacing" to "1px", "z-index" to "3",
            "border-radius" to "14px", "opacity" to "0.5",
            "-dsx-surface" to "glass", "-dsx-glass-tint" to "#f00", "-dsx-glass-interactive" to "false"), m)
        assertEquals("row", a["flexDirection"]); assertEquals("wrap", a["flexWrap"])
        assertEquals("center", a["alignItems"])
        assertEquals("none", a["display"]); assertEquals("16:9", a["aspectRatio"])
        assertEquals("1", a["tracking"]); assertEquals("3", a["zIndex"])
        assertEquals("14", a["radius"]); assertEquals("0.5", a["opacity"])
        assertEquals("glass", a["surface"]); assertEquals("#f00", a["glassTint"])
        assertEquals("false", a["glassInteractive"])
    }

    // MARK: - CSSEngine (the facade: registration + the two entry points)

    @Test fun sheetAttributesResolveThroughThemeSheetAndElementTokens() {
        CSSEngine.registerTheme("""{"rules":[{"type":"rule","selector":":root",
            "declarations":[{"property":"--pad","value":"10px","custom":true},
                            {"property":"--tint","value":"#abc","custom":true}]}]}""")
        CSSEngine.register("Card", """{"rules":[
            {"type":"rule","selector":".card","declarations":[
               {"property":"--pad","value":"16px","custom":true},
               {"property":"padding","value":"var(--pad)"},
               {"property":"color","value":"var(--tint)"}]}]}""")
        val out = CSSEngine.sheetAttributes("Card", ctx(classes = setOf("card")))
        assertEquals("16", out["padding"])        // sheet token beats theme token
        assertEquals("#abc", out["color"])        // theme token feeds var()
        // Element tokens are the strongest scope (style="--pad: 24px").
        val strong = CSSEngine.sheetAttributes("Card", ctx(classes = setOf("card")),
                                               elementTokens = mapOf("--pad" to "24px"))
        assertEquals("24", strong["padding"])
        // No class match → nothing.
        assertTrue(CSSEngine.sheetAttributes("Card", ctx(classes = setOf("other"))).isEmpty())
        // Unregistered component → nothing (the pre-codegen Android state).
        assertTrue(CSSEngine.sheetAttributes("Nope", ctx(classes = setOf("card"))).isEmpty())
    }

    @Test fun inlineAttributesResolveWithOwnerAndThemeTokens() {
        CSSEngine.registerTheme("""{"rules":[{"type":"rule","selector":":root",
            "declarations":[{"property":"--fg","value":"#eee","custom":true}]}]}""")
        CSSEngine.register("Card", """{"rules":[{"type":"rule","selector":".card",
            "declarations":[{"property":"--pad","value":"12px","custom":true}]}]}""")
        val out = CSSEngine.inlineAttributes("padding: var(--pad); color: var(--fg); --own: 2px; gap: var(--own)",
                                             ctx(classes = setOf("card")), owner = "Card")
        assertEquals("12", out["padding"])        // the owner sheet's token is in var() scope
        assertEquals("#eee", out["color"])        // theme scope
        assertEquals("2", out["rowGap"])          // the element's own custom property
        assertEquals("2", out["columnGap"])
    }

    @Test fun engineStateFlipsResolveDifferently() {
        CSSEngine.register("Panel", """{"rules":[
            {"type":"rule","selector":".panel","declarations":[{"property":"color","value":"#000"}],
             "children":[{"type":"at","name":"media","prelude":"(prefers-color-scheme: dark)",
                          "declarations":[{"property":"color","value":"#fff"}],"children":[]}]}]}""")
        assertEquals("#fff", CSSEngine.sheetAttributes("Panel", ctx(isDark = true, classes = setOf("panel")))["color"])
        assertEquals("#000", CSSEngine.sheetAttributes("Panel", ctx(isDark = false, classes = setOf("panel")))["color"])
    }

    @Test fun registrationIsIdempotentAndReplaces() {
        CSSEngine.register("X", """{"rules":[{"type":"rule","selector":".x","declarations":[{"property":"opacity","value":"0.1"}]}]}""")
        CSSEngine.register("X", """{"rules":[{"type":"rule","selector":".x","declarations":[{"property":"opacity","value":"0.9"}]}]}""")
        assertEquals("0.9", CSSEngine.sheetAttributes("X", ctx(classes = setOf("x")))["opacity"])
        CSSEngine.register("Bad", "{{{")   // decode failure: logged, component stays unstyled, never throws
        assertTrue(CSSEngine.sheetAttributes("Bad", ctx(classes = setOf("x"))).isEmpty())
    }
}
