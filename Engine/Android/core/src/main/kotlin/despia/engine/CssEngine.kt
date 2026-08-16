//
//  CssEngine.kt — the DSX-CSS runtime facade. Kotlin twin of
//  ClosedSource/Registry/DSXCSS/CSSEngine.swift (same entry points, same
//  memoization policy, kept in lockstep).
//
//  Holds the compiled Registry (per-component sheets + the app theme), resolves
//  per-element styling on demand, and hands the Stack engine a legacy attribute
//  map (CSSBridge). Two entry points:
//
//    inlineAttributes(css, ctx, owner) — inline style="" CSS (the StackNodeView
//                                     integration; flat v1). `owner` brings the
//                                     component sheet's custom properties into
//                                     var() scope.
//    sheetAttributes(component, ctx, elementTokens) — compiled <style> sheets,
//                                     matched by the element's class set (ctx.classes).
//
//  Both RECOMPUTE on every call (no result cache in v1 — memoization is a
//  deliberate later optimization, never assume one exists). The environment is
//  an EXPLICIT input: callers pass a CSSResolver.Context built from Compose's
//  environment so resolution is a tracked dependency that re-renders on
//  appearance flips (the SwiftUI \.colorScheme twin).
//
//  ── DEVIATIONS from the Swift twin (pinned, not silent) ────────────────────────
//  • SHEET DELIVERY: iOS decodes the generated GeneratedDSXCSS registry LAZILY in
//    loadIfNeeded(); here delivery is PUSH-AT-BOOT through the public
//    register()/registerTheme() seam below, filled by the generated registry —
//    despia/registry/DSXCSSStyles.generated.kt (prepare_modules_android.rb §5f,
//    the compile_dsx_css.rb twin: same shared compiler, byte-identical IR JSON) —
//    called from GeneratedModules.register() before any surface composes. The
//    seam stays public so tests and the OPEN kernel (which builds without
//    ClosedSource) can register sheets directly with the same IR.
//  • isDark defaults are the CALLER's problem here (no UITraitCollection
//    fallback exists on the JVM) — Context carries every environment field.
//

package despia.engine

object CSSEngine {
    private val sheets = HashMap<String, CSSSheet>()
    private var theme: CSSSheet? = null
    private val lock = Any()
    // Token maps are pure in (sheet, ctx) and sheets are immutable after
    // registration — memoized here because the resolver walks the whole sheet
    // per call and the render path calls per attrs access.
    private val tokenCache = HashMap<String, Map<String, String>>()

    /// Register a component's compiled sheet IR (the GeneratedDSXCSS seam — see
    /// the DEVIATIONS pin). Idempotent: a same-component registration replaces.
    /// A decode failure logs and leaves that component unstyled, like iOS.
    fun register(component: String, ir: String) {
        val sheet = CSSSheet.fromJson(ir)
        if (sheet == null) {
            kernelLog("[DSXCSS] sheet '$component' failed to decode — that component renders unstyled (IR shape drift?)")
            return
        }
        synchronized(lock) {
            sheets[component] = sheet
            tokenCache.clear()
        }
    }

    /// Register the app theme sheet IR (DSX/Modules/Config/theme.css compiled).
    fun registerTheme(ir: String) {
        val sheet = CSSSheet.fromJson(ir)
        if (sheet == null) {
            kernelLog("[DSXCSS] theme IR failed to decode — app theme is OFF (IR shape drift?)")
            return
        }
        synchronized(lock) {
            theme = sheet
            tokenCache.clear()
        }
    }

    /// Test seam: clear every registration (the JVM twin of a fresh process).
    internal fun reset() {
        synchronized(lock) {
            sheets.clear()
            theme = null
            tokenCache.clear()
        }
    }

    /// Theme tokens for the current environment (dark mode etc.).
    fun themeTokens(ctx: CSSResolver.Context): Map<String, String> {
        val t = synchronized(lock) { theme } ?: return emptyMap()
        return cachedTokens(t, "theme", ctx)
    }

    /// Memoized CSSResolver.tokens — keyed by every input the resolver reads:
    /// sheet identity, dark mode, window width AND the element's class set
    /// (token rules can be class-gated: `.card { --tint: … }`).
    private fun cachedTokens(sheet: CSSSheet, name: String, ctx: CSSResolver.Context): Map<String, String> {
        val key = "$name|${ctx.isDark}|${ctx.windowWidth.toInt()}|${ctx.classes.sorted().joinToString(",")}"
        synchronized(lock) { tokenCache[key] }?.let { return it }
        val computed = CSSResolver.tokens(sheet, ctx)
        synchronized(lock) {
            if (tokenCache.size > 128) tokenCache.clear()
            tokenCache[key] = computed
        }
        return computed
    }

    /// Inline style="" CSS → legacy attributes. `ctx.classes` feeds &.class
    /// matching once the inline parser grows nested blocks. `owner` is the
    /// element's css-owner component: its sheet's custom properties join the
    /// var() table (theme < component sheet < element), so an inline
    /// `var(--card-pad)` sees the token its own sidecar defined.
    fun inlineAttributes(css: String, ctx: CSSResolver.Context, owner: String? = null): Map<String, String> {
        val tokens = LinkedHashMap(themeTokens(ctx))
        val ownerSheet = owner?.let { synchronized(lock) { sheets[it] } }
        if (owner != null && ownerSheet != null) {
            for ((name, value) in cachedTokens(ownerSheet, owner, ctx)) tokens[name] = value
        }
        // Element-level custom properties in the inline list join the table.
        val decls = CSSInline.declarations(css)
        for (d in decls) if (d.custom) tokens[d.property] = d.value
        val resolved = LinkedHashMap<String, String>()
        for (d in decls) {
            if (d.custom) continue
            val v = CSSValue.resolveVars(d.value, tokens)
            if (v.isNotEmpty()) resolved[d.property] = v
        }
        return CSSBridge.attributes(resolved, ctx.metrics)
    }

    /// Compiled component sheet → legacy attributes for an element carrying
    /// `ctx.classes`. Layer order: theme tokens feed var(); the component
    /// sheet's declarations apply on match. `elementTokens` are the element's
    /// own inline custom properties — the strongest token scope, so a sheet
    /// rule can consume `style="--card-pad: 20px"` (theme < sheet < element).
    fun sheetAttributes(component: String, ctx: CSSResolver.Context,
                        elementTokens: Map<String, String> = emptyMap()): Map<String, String> {
        val sheet = synchronized(lock) { sheets[component] } ?: return emptyMap()
        val tokens = LinkedHashMap(themeTokens(ctx))
        for ((name, value) in cachedTokens(sheet, component, ctx)) tokens[name] = value
        for ((name, value) in elementTokens) tokens[name] = value
        val resolved = CSSResolver.declarations(sheet, ctx, tokens)
        return CSSBridge.attributes(resolved, ctx.metrics)
    }
}
