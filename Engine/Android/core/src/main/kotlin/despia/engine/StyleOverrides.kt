package despia.engine

//
//  StyleOverrides.kt - the style-override plane's pure core (the component STYLE
//  contract, beside the attribute DATA contract). Three laws live here, shared by
//  every renderer and pinned by OpenSource/Conformance/overrides/style-overrides.json:
//  the usage-site SPLIT (`override:<identifier>` leaves the props plane), the typed
//  fail-open RESOLVE (raw value -> coerced value -> declaration default -> null), and
//  the READ chain (item __overrides -> store dsx.override var -> default) that
//  Jse.kt's lookup rides for `dsx.override.<name>`.
//
//  Twins: OpenSource/Web/packages/kernel/src/style-overrides.ts, Engine/iOS
//  StyleOverrides.swift. Divergences here are corpus-visible, never silent.
//

/** A declared override - `<override as= type= default= options= min= max=/>` carried
 *  verbatim from markup (everything is a string at the declaration site; min/max also
 *  accept numbers when built programmatically). */
data class OverrideDecl(
    val name: String,
    val type: String? = null,
    val default: String? = null,
    val options: String? = null,
    val min: Any? = null,
    val max: Any? = null,
)

object StyleOverrides {

    const val PREFIX = "override:"

    /** An override name must be a legal member read (`dsx.override.<name>`) - identifier
     *  only, no dots, no colons. The platform-suffix words can never appear here: the
     *  platform fold consumes them before any split runs (corpus `reserved`). */
    private val NAME = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    /** `override:radius` -> `radius`; anything that is not an override -> null. The ONE
     *  membership test every renderer's usage-site split calls. */
    fun overrideAttrName(attr: String): String? {
        if (!attr.startsWith(PREFIX)) return null
        val name = attr.substring(PREFIX.length)
        return if (NAME.matches(name)) name else null
    }

    /** The split law as one fold (the corpus `split` section runs this): overrides out
     *  of the attribute map, `on:` handlers dropped (they are the event plane),
     *  everything else left as props - including a malformed `override:` spelling,
     *  which stays a visible (and lint-flagged) ordinary attribute. */
    fun split(attrs: Map<String, String>): Pair<Map<String, String>, Map<String, String>> {
        val overrides = LinkedHashMap<String, String>()
        val props = LinkedHashMap<String, String>()
        for ((name, value) in attrs) {
            if (name.startsWith("on:")) continue
            val override = overrideAttrName(name)
            if (override != null) overrides[override] = value else props[name] = value
        }
        return Pair(overrides, props)
    }

    private val NUMERIC = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)$")
    private val HEX_COLOR = Regex("^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
    // prefix semantics like the TS/Swift twins (a multi-line functional value stays a
    // functional value; whole-string `.*` would refuse the newline the others accept)
    private val FUNCTIONAL_COLOR = Regex("^(rgb|rgba|hsl|hsla)\\(")
    private val COLOR_TOKEN = Regex("^[A-Za-z]+$")

    private fun strictNumber(value: Any?): Double? = when (value) {
        is Number -> value.toDouble().takeIf { it.isFinite() }
        is String -> if (NUMERIC.matches(value)) value.toDoubleOrNull() else null
        else -> null
    }

    private fun clamp(value: Double, decl: OverrideDecl): Double {
        var out = value
        strictNumber(decl.min)?.let { if (out < it) out = it }
        strictNumber(decl.max)?.let { if (out > it) out = it }
        return out
    }

    /** One scalar in, trimmed string out - or null for anything that is not a scalar.
     *  Booleans keep their word form so `text` coercion mirrors JSE string coercion. */
    private fun scalarText(raw: Any?): String? = when (raw) {
        is String -> raw.trim()
        is Number -> if (raw.toDouble().isFinite()) JSE.string(raw) else null
        is Boolean -> if (raw) "true" else "false"
        else -> null
    }

    private fun balancedFunctional(value: String): Boolean {
        if (!value.endsWith(")")) return false
        var depth = 0
        for (ch in value) {
            if (ch == '(') depth += 1
            else if (ch == ')') { depth -= 1; if (depth < 0) return false }
        }
        return depth == 0
    }

    private fun optionsOf(decl: OverrideDecl): List<String> =
        (decl.options ?: "").split(Regex("\\s+")).filter { it.isNotEmpty() }

    /** Coerce one raw value by the declaration's type. null = unset-or-invalid (the
     *  caller falls back to the default). The style-plane trim rule applies first: outer
     *  whitespace never carries meaning, and an empty value means unset. */
    private fun coerce(decl: OverrideDecl, raw: Any?): Any? {
        if (raw == null) return null
        return when (decl.type ?: "text") {
            "number" -> {
                if (raw is Boolean) return null
                val n = strictNumber(if (raw is String) raw.trim() else raw) ?: return null
                clamp(n, decl)
            }
            "length" -> {
                if (raw is Boolean) return null
                val text = scalarText(raw) ?: return null
                if (text.isEmpty()) return null
                val n = strictNumber(text)
                if (n != null) return clamp(n, decl)
                if (text.contains(';') || text.contains('{') || text.contains('}')) return null
                text
            }
            "boolean" -> when (raw) {
                is Boolean -> raw
                "true" -> true
                "false" -> false
                else -> null
            }
            "enum" -> {
                val text = scalarText(raw) ?: return null
                if (text.isEmpty()) return null
                if (optionsOf(decl).contains(text)) text else null
            }
            "multiEnum" -> {
                val text = scalarText(raw) ?: return null
                if (text.isEmpty()) return null
                val options = optionsOf(decl)
                val tokens = text.split(Regex("\\s+")).filter { it.isNotEmpty() }
                if (tokens.isEmpty()) return null
                if (tokens.any { !options.contains(it) }) return null
                tokens.joinToString(" ")
            }
            "color" -> {
                val text = scalarText(raw) ?: return null
                if (text.isEmpty()) return null
                when {
                    text.startsWith("#") -> if (HEX_COLOR.matches(text)) text else null
                    FUNCTIONAL_COLOR.containsMatchIn(text) -> if (balancedFunctional(text)) text else null
                    else -> if (COLOR_TOKEN.matches(text)) text else null
                }
            }
            "gradient", "ratio" -> {
                val text = scalarText(raw) ?: return null
                if (text.isEmpty()) return null
                if (text.contains(';') || text.contains('{') || text.contains('}')) return null
                text
            }
            "css" -> {
                val text = scalarText(raw) ?: return null
                if (text.isEmpty()) return null
                if (text.contains('{') || text.contains('}')) return null
                text
            }
            // text, and any unknown declared type (lint owns rejecting the declaration)
            else -> {
                val text = scalarText(raw) ?: return null
                text.ifEmpty { null }
            }
        }
    }

    /** The resolve law: coerced raw -> coerced default -> null. Never throws - an
     *  invalid live value degrades to the declared look instead of poisoning the pixels. */
    fun resolve(decl: OverrideDecl, raw: Any?): Any? {
        val value = coerce(decl, raw)
        if (value != null) return value
        if (decl.default != null) return coerce(decl, decl.default)
        return null
    }

    /** The whole-plane read (`dsx.override`): the DECLARED contract resolved - undeclared
     *  raw keys never appear, every declared knob answers. Raw chain per name: the item
     *  scope's dict (the tag door) beats the store var (the mount/update door). */
    fun resolvePlane(
        decls: Collection<OverrideDecl>,
        itemOverrides: Map<String, Any?>?,
        storeOverrides: Map<String, Any?>?,
    ): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        for (decl in decls) {
            val raw = itemOverrides?.get(decl.name) ?: storeOverrides?.get(decl.name)
            out[decl.name] = resolve(decl, raw)
        }
        return out
    }
}
