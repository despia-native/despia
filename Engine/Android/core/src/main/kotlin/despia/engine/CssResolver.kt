//
//  CssResolver.kt — cascade + matching for compiled DSX-CSS sheets. Kotlin twin of
//  ClosedSource/Registry/DSXCSS/CSSResolver.swift (same names, same layer order,
//  same v1 selector subset, kept in lockstep).
//
//  Layer order (spec §4.3d, implicit @layer): theme (global, weakest) →
//  component sheet → element inline (strongest). Within a layer, source order
//  wins on conflicts (later declaration overrides) — deterministic, never
//  specificity arithmetic.
//
//  v1 selector subset (documented; the build linter accepts the full grammar,
//  unmatched selectors are simply inert until the Taffy phase):
//    :root                      — token gathering only
//    .a / .a.b (class chains)   — matched against the element's class set
//    &.a / &.a.b                — element-owned classes (inline children)
//  Skipped v1: descendant/child combinators, tags, pseudo-classes (:pressed …).
//
//  @media evaluation: prefers-color-scheme, min-width, max-width (window
//  points), prefers-reduced-motion, composable with `and`. Other queries: rule
//  stays inert.
//
//  ── DEVIATION from the Swift twin (pinned, not silent) ─────────────────────────
//  • Context is FULLY explicit: the Swift Context.current() falls back to
//    UITraitCollection/UIScreen globals and reads UIAccessibility for reduced
//    motion; :core is pure JVM, so every environment input (isDark, window size,
//    font scale, reduce-motion) is a Context field the renderer supplies from
//    Compose (isSystemInDarkTheme/LocalConfiguration/LocalDensity — tracked
//    recomposition dependencies, the @Environment twin).
//

package despia.engine

object CSSResolver {
    data class Context(
        val isDark: Boolean = true,
        val windowWidth: Double = 0.0,
        val windowHeight: Double = 0.0,
        val fontScale: Double = 1.0,
        val reduceMotion: Boolean = false,
        val classes: Set<String> = emptySet(),
    ) {
        /// The value-conversion slice of the environment (rem/vw/vh — CSSValue/CSSBridge).
        val metrics: CSSMetrics get() = CSSMetrics(16.0 * fontScale, windowWidth, windowHeight)
    }

    /// Gather custom-property tokens (:root + matched rules) from a sheet.
    fun tokens(sheet: CSSSheet, ctx: Context): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        collectTokens(sheet.rules, ctx, out)
        return out
    }

    private fun collectTokens(rules: List<CSSRule>, ctx: Context, out: MutableMap<String, String>) {
        for (rule in rules) {
            if (rule.type == "at") {
                val applies = rule.name?.let { mediaApplies(it, rule.prelude ?: "", ctx) } ?: false
                if (!applies) continue
                for (d in rule.declarations) if (d.custom) out[d.property] = d.value
                collectTokens(rule.children, ctx, out)
                continue
            }
            if (!matches(rule.selector ?: "", ctx, forTokens = true)) continue
            for (d in rule.declarations) if (d.custom) out[d.property] = d.value
            // Nested at-rules inside a matched rule (e.g. :root { @media dark { … } })
            collectTokens(rule.children, ctx, out)
        }
    }

    /// Resolve a sheet to the final [property: value] map for an element with
    /// the given class set. Tokens are substituted; custom props excluded from
    /// the output (they are inputs, not paint).
    fun declarations(sheet: CSSSheet, ctx: Context, tokens: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        collectDeclarations(sheet.rules, ctx, tokens, out)
        return out
    }

    private fun collectDeclarations(
        rules: List<CSSRule>,
        ctx: Context,
        tokens: Map<String, String>,
        out: MutableMap<String, String>,
        insideMatchedRule: Boolean = false,
    ) {
        for (rule in rules) {
            if (rule.type == "at") {
                val applies = rule.name?.let { mediaApplies(it, rule.prelude ?: "", ctx) } ?: false
                if (!applies) continue
                // The at-node's OWN declarations — the parser puts
                // `.a { @media (…) { padding: 24px } }` declarations directly
                // ON the at-node — apply ONLY when the at-rule is nested
                // inside a rule this element matched. Bare declarations in a
                // TOP-LEVEL at block (`@media dark { color: #fff }`) are
                // invalid CSS and must stay inert, never element-global.
                if (insideMatchedRule) {
                    for (d in rule.declarations) {
                        if (d.custom) continue
                        val v = CSSValue.resolveVars(d.value, tokens)
                        if (v.isNotEmpty()) out[d.property] = v
                    }
                }
                collectDeclarations(rule.children, ctx, tokens, out, insideMatchedRule)
                continue
            }
            if (!matches(rule.selector ?: "", ctx, forTokens = false)) continue
            for (d in rule.declarations) {
                if (d.custom) continue
                val v = CSSValue.resolveVars(d.value, tokens)
                if (v.isNotEmpty()) out[d.property] = v   // empty = invalid-at-computed-value → dropped
            }
            collectDeclarations(rule.children, ctx, tokens, out, insideMatchedRule = true)
        }
    }

    /// v1 selector matching. `forTokens` admits :root (token gathering).
    fun matches(selector: String, ctx: Context, forTokens: Boolean): Boolean {
        for (group in selector.split(",")) {
            // trim(), not cssTrim(): a grouped selector is compiled as `.a,\n.b,\n.c`, so
            // every group past the first carries a leading newline. cssTrim mirrors Swift
            // `.whitespaces` (no newlines) for VALUE parsing; here the newline must go or
            // `.startsWith(".")` fails and all selectors but the first are dropped (the iOS
            // twin trims with .whitespacesAndNewlines for the same reason).
            val sel = group.trim()
            if (sel.isEmpty()) continue
            if (sel == ":root") { if (forTokens) return true else continue }
            // Skip v1: combinators, tags, pseudo-classes (except the bare forms above).
            if (sel.contains(" ") || sel.contains(">") || sel.contains("~") || sel.contains("+")) continue
            var body = sel
            if (body.startsWith("&")) body = body.substring(1)
            if (!body.startsWith(".")) continue
            if (body.contains(":")) continue   // states land with the Taffy phase
            val classes = body.split(".").filter { it.isNotEmpty() }
            if (classes.isNotEmpty() && ctx.classes.containsAll(classes)) return true
        }
        return false
    }

    /// @media / @supports evaluation (v1: media only; unknown queries = inert).
    fun mediaApplies(name: String, prelude: String, ctx: Context): Boolean {
        when (name) {
            "starting-style" -> return false   // entry transitions ride enter= / the animation phase
            "media" -> {}
            "container" ->
                // v1 has no container measurement; evaluating against the WINDOW
                // would be actively wrong — inert until Taffy, per the policy.
                return false
            else -> return false               // @supports/@layer/… handled at build or later phases
        }
        // Split on `and`; every clause must pass. `not` unsupported v1 → inert.
        if (prelude.contains(" not ") || prelude.startsWith("not ")) return false
        for (clause in prelude.split(" and ")) {
            val c = clause.trim { it == ' ' || it == '(' || it == ')' }
            if (c.isEmpty()) continue
            val parts = c.split(":", limit = 2).map { cssTrim(it) }
            if (parts.size == 1) {
                // A bare media TYPE: everything we render on is `screen`;
                // other types (`print`) make the query inert.
                if (parts[0] == "screen" || parts[0] == "all") continue
                return false
            }
            if (parts.size != 2) return false
            when (parts[0]) {
                "prefers-color-scheme" -> {
                    val want = parts[1] == "dark"
                    if (ctx.isDark != want) return false
                }
                "min-width" -> {
                    val v = CSSValue.points(parts[1], metrics = ctx.metrics) ?: return false
                    if (ctx.windowWidth < v) return false
                }
                "max-width" -> {
                    val v = CSSValue.points(parts[1], metrics = ctx.metrics) ?: return false
                    if (ctx.windowWidth > v) return false
                }
                "prefers-reduced-motion" -> {
                    val want = parts[1] == "reduce"
                    if (ctx.reduceMotion != want) return false
                }
                else -> return false   // unknown feature → rule inert (never wrongly applied)
            }
        }
        return true
    }
}
