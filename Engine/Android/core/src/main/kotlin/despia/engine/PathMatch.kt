//
//  PathMatch.kt - the one DSX route-path matcher (Kotlin twin of DSXPathMatch.swift).
//
//  Pure JVM (no android.*), so it is SURFACE-SAFE: the same matcher compiles into any
//  process that needs routing — a widget / auxiliary `RouteResolver` uses THIS, instead
//  of reimplementing route matching. Shared by the `matches()` expression helper, the
//  kernel `Router`, and the Routing package's resolver. Patterns: literal segments,
//  `{name}`/`:name` (one segment → param), `*` (one segment), trailing `/*` or `*`
//  (catch-all). Query/hash stripped. Pure and allocation-light — safe to call from the
//  non-blocking expression evaluator.
//

package despia.engine

object DSXPathMatch {
    /// Match a concrete path against a route pattern. Returns the extracted params
    /// (empty map when there are none) on a match, or `null` on no match.
    fun match(path: String, pattern: String): Map<String, String>? {
        val p = normalize(path)
        val pat = normalize(pattern)
        if (pat == "*" || pat == "/*" || pat.isEmpty()) return emptyMap()   // catch-all / empty pattern
        val ps = segments(p)
        val pats = segments(pat)
        val params = mutableMapOf<String, String>()
        var i = 0
        while (i < pats.size) {
            val seg = pats[i]
            if (seg == "*") {
                // A trailing '*' soaks up the rest; a mid-path '*' matches one segment.
                if (i == pats.size - 1) return params
                if (i >= ps.size) return null
                i += 1; continue
            }
            if (i >= ps.size) return null
            if (seg.length >= 2 && seg.startsWith("{") && seg.endsWith("}")) {
                params[seg.substring(1, seg.length - 1)] = ps[i]
            } else if (seg.startsWith(":")) {
                params[seg.substring(1)] = ps[i]
            } else if (seg != ps[i]) {
                return null
            }
            i += 1
        }
        return if (ps.size == pats.size) params else null
    }

    /// Boolean convenience — backs the `matches(path, pattern)` expression helper.
    fun matches(path: String, pattern: String): Boolean = match(path, pattern) != null

    private fun normalize(s: String): String {
        val cut = s.indexOfFirst { it == '?' || it == '#' }
        return if (cut >= 0) s.substring(0, cut) else s
    }

    private fun segments(s: String): List<String> =
        s.split('/').filter { it.isNotEmpty() }
}
