//
//  CssIR.kt — the compiled DSX-CSS intermediate representation. Kotlin twin of
//  ClosedSource/Registry/DSXCSS/CSSIR.swift (same names, same shapes, kept in lockstep).
//
//  Decodes the JSON emitted by scripts/compile_dsx_css.rb (build-time) and by
//  CSSInline (runtime, inline style="" attributes only). Field names mirror the
//  Ruby parser's IR 1:1 (ClosedSource/scripts/dsxcss/parser.rb): a sheet is
//  { "rules": [...], "interpolations": [...] }; a rule is a qualified rule
//  ("type":"rule" + "selector") or an at-rule ("type":"at" + "name"/"prelude"),
//  each with "declarations" ({"property","value","custom"?,"important"?}) and
//  nested "children". Swift decodes via Codable; here the :core json() reader
//  (Json.kt) supplies the tree and the mappers below keep the same defaults
//  (missing field → the Swift decodeIfPresent fallback).
//

package despia.engine

class CSSSheet(
    val rules: List<CSSRule> = emptyList(),
    val interpolations: List<String> = emptyList(),
) {
    companion object {
        /// Twin of Swift `CSSSheet(json:)` — nil (null) on any decode failure.
        fun fromJson(jsonText: String): CSSSheet? {
            val root = json(jsonText).foundationValue as? Map<*, *> ?: return null
            val rules = (root["rules"] as? List<*>)?.mapNotNull { rule(it) } ?: emptyList()
            val interpolations = (root["interpolations"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
            return CSSSheet(rules, interpolations)
        }

        private fun rule(v: Any?): CSSRule? {
            val m = v as? Map<*, *> ?: return null
            return CSSRule(
                type = m["type"] as? String ?: "rule",
                selector = m["selector"] as? String,
                name = m["name"] as? String,
                prelude = m["prelude"] as? String,
                declarations = (m["declarations"] as? List<*>)?.mapNotNull { decl(it) } ?: emptyList(),
                children = (m["children"] as? List<*>)?.mapNotNull { rule(it) } ?: emptyList(),
            )
        }

        private fun decl(v: Any?): CSSDecl? {
            val m = v as? Map<*, *> ?: return null
            return CSSDecl(
                property = m["property"] as? String ?: "",
                value = m["value"] as? String ?: "",
                custom = m["custom"] as? Boolean ?: false,
                important = m["important"] as? Boolean ?: false,
            )
        }
    }
}

/// One rule: a qualified rule (`selector` set) or an at-rule (`name`/`prelude`).
class CSSRule(
    val type: String = "rule",
    val selector: String? = null,
    val name: String? = null,
    val prelude: String? = null,
    val declarations: List<CSSDecl> = emptyList(),
    val children: List<CSSRule> = emptyList(),
)

class CSSDecl(
    val property: String = "",
    val value: String = "",
    val custom: Boolean = property.startsWith("--"),
    val important: Boolean = false,
)
