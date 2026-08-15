//
//  CssBridge.kt — resolved CSS declarations → the legacy attribute map. Kotlin twin of
//  ClosedSource/Registry/DSXCSS/CSSBridge.swift (same mapping table, same structural
//  translations, kept in lockstep).
//
//  Phase-1 rendering strategy (spec §10): CSS renders THROUGH the proven
//  StackStyle attribute pipeline — zero changes to paint code — while Taffy
//  waits as the Phase-2 layout seam. This file is the one mapping table; a
//  property absent here is accepted by the linter (catalog) but inert at
//  runtime v1, and the kernelLog below names it so device work extends the
//  table deliberately, not by surprise.
//
//  Structural translations worth knowing:
//    width/height: 100%  → grow="width"/"height"/"true"  (the legacy fill primitive)
//    width/height: fit-content → "fit"
//    gap/row-gap/column-gap → rowGap + columnGap — AXIS-CORRECT: the cascade
//        (StackNodeView resolvedAttrs) collapses the right one onto `spacing`
//        because only it knows the element's main axis; handled OUTSIDE the decls
//        loop so longhands deterministically beat the shorthand
//    padding shorthand   → padding / paddingH+paddingV / per-edge attributes
//    font-weight 100…900 → the pipeline's named weights
//    flex-direction / align-items / display → passed through for the generic
//        <stack> element (axis + cross alignment) and the display:none gate
//
//  ── DEVIATION from the Swift twin (pinned, not silent) ─────────────────────────
//  • `metrics` is an explicit parameter (rem base / vw / vh) — see CssValue.kt's
//    ENVIRONMENT IS EXPLICIT pin; iOS reads the same numbers off UIKit globals.
//

package despia.engine

object CSSBridge {
    /// Convert resolved declarations to StackStyle attributes. Later CSS
    /// declarations already won in the resolver; this is a pure rename/reshape.
    ///
    /// UNITS — px, rem and em are first-class and freely mixable per property:
    ///   px  = point/dp (fixed geometry)
    ///   rem = 16 × font scale (accessibility-scaling rhythm)
    ///   em  = the ELEMENT'S OWN font-size for every non-font property. `font-size`
    ///         in em resolves against the rem base in v1 — PARENT font inheritance
    ///         is a computed-style concern that lands with the Taffy phase.
    fun attributes(decls: Map<String, String>, metrics: CSSMetrics = CSSMetrics()): Map<String, String> {
        val a = LinkedHashMap<String, String>()
        var growW = false
        var growH = false

        // The element's own font-size FIRST — it is the em base for every
        // other length on this element.
        val ownFontSize = decls["font-size"]?.let {
            CSSValue.points(cssTrim(it), emBase = metrics.remBase, metrics = metrics)
        }
        val emBase = ownFontSize ?: metrics.remBase

        fun pts(v: String): String? =
            CSSValue.points(v, emBase = emBase, metrics = metrics)?.let { fmt(it) }

        for ((prop, raw) in decls) {
            val v = cssTrim(raw)
            when (prop) {
                "padding", "padding-top", "padding-right", "padding-bottom", "padding-left" ->
                    {} // padding family: resolved after the loop into ONE key per edge
                "padding-inline-start" -> pts(v)?.let { a["paddingLeading"] = it }
                "padding-inline-end" -> pts(v)?.let { a["paddingTrailing"] = it }

                "background", "background-color" ->
                    {} // background family: resolved after the loop (alias precedence)
                "color" -> a["color"] = if (v == "transparent") "clear" else v
                "opacity" -> a["opacity"] = v

                "border-radius" -> pts(v)?.let { a["radius"] = it }
                "width" ->
                    if (v == "100%") growW = true
                    else if (v == "fit-content") a["width"] = "fit"
                    else pts(v)?.let { a["width"] = it }
                "height" ->
                    if (v == "100%") growH = true
                    else if (v == "fit-content") a["height"] = "fit"
                    else pts(v)?.let { a["height"] = it }
                "min-width" -> pts(v)?.let { a["minWidth"] = it }
                "min-height" -> pts(v)?.let { a["minHeight"] = it }
                "max-width" -> pts(v)?.let { a["maxWidth"] = it }
                "max-height" -> pts(v)?.let { a["maxHeight"] = it }
                "aspect-ratio" ->
                    // CSS writes "16 / 9"; the pipeline's parser takes "16:9" or a
                    // bare number — normalize so the CSS spelling isn't inert.
                    a["aspectRatio"] = if (v.contains("/"))
                        v.split("/").joinToString(":") { cssTrim(it) }
                    else v

                "gap", "row-gap", "column-gap" ->
                    {} // gap family: resolved after the loop (deterministic precedence)

                "flex-direction" -> a["flexDirection"] = v
                "flex-wrap" -> a["flexWrap"] = v
                "align-items" -> a["alignItems"] = v
                "display" -> a["display"] = v

                "font-size" -> {
                    // Resolved once above (ownFontSize) against the rem base —
                    // NOT pts(), whose em base is this very value (circular).
                    ownFontSize?.let { a["fontSize"] = fmt(it) }
                }
                "font-weight" -> a["fontWeight"] = weightName(v)
                "letter-spacing" ->
                    // The text styler reads `tracking`.
                    pts(v)?.let { a["tracking"] = it }
                "z-index" -> a["zIndex"] = v

                // Liquid Glass family — the CSS spelling of the surface attributes, so a
                // class can add/remove the whole glass treatment (tint + bouncy press).
                "-dsx-surface" -> a["surface"] = v
                "-dsx-glass-tint" -> a["glassTint"] = v
                "-dsx-glass-interactive" -> a["glassInteractive"] = v

                else ->
                    kernelLog("[DSXCSS] v1 bridge: `$prop` accepted by the catalog but not yet mapped — inert until the Taffy phase")
            }
        }

        // Padding family, outside the loop and resolved to ONE attribute per
        // edge. Collapsing shorthand + longhand here keeps every native pipeline
        // on CSS replacement semantics (top=8, never 16+8), regardless of how
        // its modifier onion is assembled. Shorthand seeds the four edges,
        // longhands override deterministically, then the minimal legacy attribute
        // set is emitted.
        val edge = HashMap<String, Double>()
        decls["padding"]?.let { p ->
            val parts = p.split(" ").filter { it.isNotEmpty() }
            val vals = parts.mapNotNull { CSSValue.points(it, emBase = emBase, metrics = metrics) }
            if (vals.isNotEmpty() && vals.size == parts.size) {
                when (vals.size) {
                    1 -> { edge["top"] = vals[0]; edge["right"] = vals[0]; edge["bottom"] = vals[0]; edge["left"] = vals[0] }
                    2 -> { edge["top"] = vals[0]; edge["bottom"] = vals[0]; edge["right"] = vals[1]; edge["left"] = vals[1] }
                    3 -> { edge["top"] = vals[0]; edge["right"] = vals[1]; edge["left"] = vals[1]; edge["bottom"] = vals[2] }
                    else -> { edge["top"] = vals[0]; edge["right"] = vals[1]; edge["bottom"] = vals[2]; edge["left"] = vals[3] }
                }
            }
        }
        for ((prop, key) in listOf("padding-top" to "top", "padding-right" to "right",
                                   "padding-bottom" to "bottom", "padding-left" to "left")) {
            decls[prop]?.let { v ->
                CSSValue.points(v, emBase = emBase, metrics = metrics)?.let { edge[key] = it }
            }
        }
        if (edge.isNotEmpty()) {
            val top = edge["top"]
            if (edge.size == 4 && top != null && edge.values.all { it == top }) {
                a["padding"] = fmt(top)
            } else {
                val bottom = edge["bottom"]
                if (top != null && bottom != null && top == bottom) {
                    a["paddingV"] = fmt(top)
                } else {
                    top?.let { a["paddingTop"] = fmt(it) }
                    bottom?.let { a["paddingBottom"] = fmt(it) }
                }
                val left = edge["left"]
                val right = edge["right"]
                if (left != null && right != null && left == right) {
                    a["paddingH"] = fmt(left)
                } else {
                    left?.let { a["paddingLeft"] = fmt(it) }
                    right?.let { a["paddingRight"] = fmt(it) }
                }
            }
        }

        // Background family — deterministic alias precedence (both names write
        // ONE output key): the specific longhand beats the shorthand. CSS
        // `transparent` → the pipeline's `clear` token (the color parser's
        // terminal fallback is white — verbatim passthrough would paint an
        // OPAQUE WHITE box).
        (decls["background-color"] ?: decls["background"])?.let { bg ->
            val v = cssTrim(bg)
            a["background"] = if (v == "transparent") "clear" else v
        }

        // Gap family, outside the loop so precedence is deterministic:
        // shorthand first, longhands over it. `gap: <row> <column>?` per CSS —
        // one value sets both axes.
        decls["gap"]?.let { g ->
            val parts = g.split(" ").filter { it.isNotEmpty() }
            parts.firstOrNull()?.let { first ->
                pts(first)?.let { row ->
                    a["rowGap"] = row
                    a["columnGap"] = if (parts.size > 1) (pts(parts[1]) ?: row) else row
                }
            }
        }
        decls["row-gap"]?.let { rg -> pts(rg)?.let { a["rowGap"] = it } }
        decls["column-gap"]?.let { cg -> pts(cg)?.let { a["columnGap"] = it } }

        if (growW && growH) a["grow"] = "true" else if (growW) a["grow"] = "width" else if (growH) a["grow"] = "height"
        return a
    }

    private fun fmt(v: Double): String =
        if (v == Math.floor(v) && v.isFinite()) v.toLong().toString() else v.toString()

    private fun weightName(v: String): String = when (v) {
        "bold" -> "bold"
        "normal" -> "regular"
        else -> {
            val n = v.toIntOrNull() ?: 400
            when {
                n < 300 -> "light"
                n < 500 -> "regular"
                n < 600 -> "medium"
                n < 700 -> "semibold"
                n < 800 -> "bold"
                else -> "heavy"
            }
        }
    }
}
