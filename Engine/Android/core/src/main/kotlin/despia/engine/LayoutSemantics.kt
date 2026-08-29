//
//  LayoutSemantics.kt — the shared CONTAINER-SEMANTICS decisions of the Kotlin lane,
//  held to the web renderer's CSS flex model (the parity contract's reference plane).
//  Corpus: OpenSource/Conformance/layout/flex-semantics.json (FlexSemanticsConformanceTest);
//  the same rows' geometry mirrors run in the browser leg (ClosedSource/scripts/dsxcss/
//  fixtures 08–17, `npm run layout-oracle`), so every decision here is pinned against a
//  real CSS engine, not against another Kotlin file.
//
//  The web truths these functions encode (packages/dom/src/theme.ts, the skin):
//    .dsx-stack  { flex-direction: column; align-items: start }   — children HUG by default
//    .dsx-hstack { flex-direction: row;    align-items: center }
//    .dsx-scroll { flex-direction: column }                       — no align-items ⇒ STRETCH
//    .dsx-spacer { flex: 1 1 0 }      — absorbs only when the container has extra main space
//    grow (width:100%) children stretch/fill and then clamp under their own max-width;
//    an authored `align-self` places the ELEMENT in its parent's cross axis.
//
//  Consumers: the Compose Desktop renderer (DesktopRenderer/DesktopStyleRuntime) and the
//  Android :render element layer. Decisions only — no Compose types, so :core stays pure.
//

package despia.engine

object LayoutSemantics {

    /** Head/declaration tags: they parse as children but render no box, so a structural
     * container (`<tabs>`, pane hosts) must never count one as a pane. Mirrors the web
     * pipeline, where `<head>` never reaches the DOM tree at all. `<slot>` is NOT here:
     * it renders slotted content. */
    val declarationTags: Set<String> = setOf(
        "head", "event", "expects", "action", "api", "variable", "var", "let",
        "component", "formula", "script", "functions", "style", "watch", "attribute",
    )

    /** `<tabs>` (and any indexed pane host): the panes are the children that paint. */
    fun paneChildren(children: List<StackNode>): List<StackNode> =
        children.filter { it.tag !in declarationTags }

    /** Authored `align-self` (CSS) → the canonical placement word, or null when absent
     * or unknown. `alignSelf` is the bridged attribute (CSSBridge maps `align-self`). */
    fun selfAlignment(attrs: Map<String, String>): String? =
        when (attrs["alignSelf"]?.trim()) {
            "start", "flex-start", "leading" -> "start"
            "center" -> "center"
            "end", "flex-end", "trailing" -> "end"
            "stretch" -> "stretch"
            else -> null
        }

    /** Does this container stretch its children on the cross axis? Only an authored
     * `align-items: stretch` (or the legacy `align="stretch"`) says yes for stack/hstack;
     * `<scroll>` declares no align-items on web, so flex's own default (stretch) applies
     * there — the caller passes `defaultStretch = true` for scroll. */
    fun crossStretch(attrs: Map<String, String>, defaultStretch: Boolean = false): Boolean =
        when (attrs["alignItems"] ?: attrs["align"]) {
            "stretch" -> true
            null -> defaultStretch
            else -> false
        }

    /** Does a child of a cross-stretching container fill that cross axis? CSS: stretch
     * applies only when the child's cross size is auto — an explicit size, a grow (it
     * fills by itself), or an authored non-stretch `align-self` opts out. */
    fun childFillsCross(parentStretch: Boolean, attrs: Map<String, String>, axis: String): Boolean {
        if (!parentStretch) return false
        val self = selfAlignment(attrs)
        if (self != null && self != "stretch") return false
        val grow = attrs["grow"]
        return when (axis) {
            "width" -> attrs["width"] == null && grow != "width" && grow != "true" && grow != "both"
            "height" -> attrs["height"] == null && grow != "height" && grow != "true" && grow != "both"
            else -> false
        }
    }

    /** The web skin's compact step (globals.ts THE WIDTH LAW: `max-width: 47.9375rem`). */
    const val COMPACT_BELOW = 768.0

    /** The skin's default-stretch laws for a child of a VERTICAL stack (globals.ts):
     * fields and pressable rows stretch at every width (THE HUG LAW's exceptions), and
     * the divider spans its container at every width (theme.ts `.dsx-divider`
     * `align-self: stretch` — content-free, so it contributes nothing to a hug);
     * buttons, forms and nested vertical stacks stretch below the compact step (THE
     * WIDTH LAW). An authored align-self, width or grow always wins — callers gate
     * with selfAlignment/childFillsCross. */
    fun defaultSelfStretch(tag: String, attrs: Map<String, String>, compactViewport: Boolean): Boolean =
        when (tag) {
            "field", "row", "pressable", "divider" -> true
            "button", "glassButton", "transport", "form" -> compactViewport
            "stack", "vstack", "card" -> compactViewport && attrs["flexDirection"]?.startsWith("row") != true
            else -> false
        }
}
