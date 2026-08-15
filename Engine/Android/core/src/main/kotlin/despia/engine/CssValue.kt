//
//  CssValue.kt — value-level conversions for the DSX-CSS runtime. Kotlin twin of
//  ClosedSource/Registry/DSXCSS/CSSValue.swift (same names, same grammar, lockstep).
//
//  Lengths: px = pt/dp (never hardware pixels), rem = 16 × the user's font scale
//  (accessibility-responsive by construction, spec §4.4), em = relative to the
//  element's font size, vw/vh = window-relative. `%` has no universal point
//  conversion — callers map it structurally (the bridge turns `width: 100%` into
//  the legacy grow attribute).
//
//  var(--token[, fallback]) resolves against a token dictionary (theme :root +
//  matched rules). Colors pass through as strings — StackStyle.color already
//  handles hex/rgb/rgba/named tokens at apply time.
//
//  ── DEVIATION from the Swift twin (pinned, not silent) ─────────────────────────
//  • ENVIRONMENT IS EXPLICIT: iOS reads UIFontMetrics (rem) and UIScreen (vw/vh)
//    as ambient globals; :core is pure JVM, so the same three numbers travel as a
//    `CSSMetrics` value (built from the resolver Context — the renderer feeds it
//    from Compose's LocalDensity/LocalConfiguration, making font scale and window
//    size tracked recomposition dependencies exactly like the iOS environment).
//  • The DEBUG cyclic-var print rides `kernelLog` (the kernel's debug gate).
//

package despia.engine

/// The environment numbers CSSValue needs (iOS: UIKit globals; here explicit).
/// `remBase` = 16 × font scale — the rem promise from the spec.
data class CSSMetrics(
    val remBase: Double = 16.0,
    val windowWidth: Double = 0.0,
    val windowHeight: Double = 0.0,
)

/// Swift `.whitespaces` trim (space separators + tab, NO newlines) — the trim the
/// Swift DSXCSS files use; shared by the Css* twins (Jse.kt's own copy is private).
internal fun cssTrim(s: String): String {
    fun ws(c: Char) = c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()
    var start = 0
    var end = s.length
    while (start < end && ws(s[start])) start += 1
    while (end > start && ws(s[end - 1])) end -= 1
    return s.substring(start, end)
}

object CSSValue {

    /// Parse a CSS length into points (dp). Returns null for %, keywords, calc()
    /// (v1), and anything non-numeric — callers decide the structural meaning.
    /// `emBase` is the ELEMENT'S OWN font-size in points (the bridge computes it
    /// from the element's font-size declaration before resolving any other
    /// length) — px/rem/em are first-class and freely mixable per property.
    fun points(raw: String, emBase: Double = 16.0, metrics: CSSMetrics = CSSMetrics()): Double? {
        val s = cssTrim(raw).lowercase()
        if (s.isEmpty() || s == "auto" || s.endsWith("%") || s.startsWith("calc(")) return null
        // Non-finite parses (the Swift Double grammar accepts "nan"/"inf" — e.g. an
        // interpolated NaN from JSE) must drop the declaration, never feed layout a
        // non-finite dimension. JSE.number IS the Swift `Double(String)` grammar.
        fun num(suffix: String): Double? {
            if (!s.endsWith(suffix)) return null
            return JSE.number(cssTrim(s.dropLast(suffix.length)))?.takeIf { it.isFinite() }
        }
        num("px")?.let { return it }
        num("rem")?.let { return it * metrics.remBase }
        num("em")?.let { return it * emBase }
        num("vw")?.let { return it / 100.0 * metrics.windowWidth }
        num("vh")?.let { return it / 100.0 * metrics.windowHeight }
        JSE.number(s)?.takeIf { it.isFinite() }?.let { return it }   // bare number = px per the catalog
        return null
    }

    /// Substitute every var(--name[, fallback]) in a value string against the
    /// token table. Unknown var with no fallback resolves to "" (the CSS
    /// invalid-at-computed-value behavior, which drops the declaration later).
    ///
    /// `depth` threads the recursion budget THROUGH the nested-var passes — a
    /// cyclic definition (`--a: var(--b); --b: var(--a)`) rotates forever and
    /// every pass "makes progress", so a per-pass counter alone can never
    /// terminate it. After the budget, a value still holding var() is a cycle:
    /// per CSS it is invalid at computed value → "" (the declaration drops,
    /// loudly on debug installs).
    fun resolveVars(raw: String, tokens: Map<String, String>, depth: Int = 0): String {
        if (!raw.contains("var(")) return raw
        if (depth >= 8) {
            kernelLog("[DSXCSS] cyclic var() chain in `${raw.take(60)}` — declaration dropped (invalid at computed value)")
            return ""
        }
        val out = StringBuilder()
        var rest = raw
        var guardCount = 0
        while (guardCount < 16) {
            val at = rest.indexOf("var(")
            if (at < 0) break
            guardCount += 1
            out.append(rest, 0, at)
            var parens = 1
            val inner = StringBuilder()
            var idx = at + 4
            while (idx < rest.length && parens > 0) {
                val ch = rest[idx]
                if (ch == '(') parens += 1
                if (ch == ')') parens -= 1
                if (parens > 0) inner.append(ch)
                idx += 1
            }
            val parts = inner.toString().split(",", limit = 2)
            val name = cssTrim(parts.first())
            val fallback = if (parts.size > 1) cssTrim(parts[1]) else ""
            out.append(tokens[name] ?: fallback)
            rest = rest.substring(idx)
        }
        out.append(rest)
        val s = out.toString()
        // Nested var() in a substituted value: recurse with the budget threaded.
        return if (s.contains("var(")) resolveVars(s, tokens, depth + 1) else s
    }
}
