//
//  CssInline.kt — the runtime parser for inline `style=""` attributes. Kotlin twin of
//  ClosedSource/Registry/DSXCSS/CSSInline.swift (same grammar, same cache policy,
//  kept in lockstep).
//
//  v1 grammar: a FLAT declaration list (`prop: value; prop: value`). Nested
//  blocks (`&.x { … }`, inline `@media`) are recognized and SKIPPED brace-
//  balanced (they land with the Taffy render phase; the build-time linter
//  already validates them). Custom properties take raw values. Comments and
//  arbitrary whitespace are legal (§4.10). Results are cached by exact string
//  — inline styles repeat heavily across list rows, so steady-state parses
//  are dictionary hits.
//
//  This is the ONE sanctioned runtime CSS parse: sheets always come compiled
//  from the Registry (spec §7); an inline attribute is tiny, per-element, and
//  cached. Missing-semicolon recovery is NOT replicated here — the build
//  linter guarantees committed markup is clean, and OTA-served markup was
//  linted by its own build.
//

package despia.engine

object CSSInline {
    private val cache = HashMap<String, List<CSSDecl>>()
    private val lock = Any()

    fun declarations(source: String): List<CSSDecl> {
        synchronized(lock) { cache[source] }?.let { return it }
        val parsed = parse(source)
        synchronized(lock) {
            // PARTIAL eviction: with 400+ distinct static styles app-wide plus
            // interpolated per-row values, a wholesale clear would thrash —
            // every insert past the cap re-parsing the entire steady-state set.
            if (cache.size > 512) {
                for (key in cache.keys.take(128).toList()) cache.remove(key)
            }
            cache[source] = parsed
        }
        return parsed
    }

    /// The custom properties (`--x: v`) declared in an inline style — the
    /// ELEMENT scope of the three-scope token model, handed to the sheet
    /// layer so sheet rules can consume element-defined tokens.
    fun customProperties(source: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (d in declarations(source)) if (d.custom) out[d.property] = d.value
        return out
    }

    private fun parse(src: String): List<CSSDecl> {
        val out = ArrayList<CSSDecl>()
        val chars = src.toCharArray()
        var i = 0
        val n = chars.size

        fun skipComment(): Boolean {
            if (!(i + 1 < n && chars[i] == '/' && chars[i + 1] == '*')) return false
            i += 2
            while (i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/')) i += 1
            i = minOf(i + 2, n)
            return true
        }

        fun skipString() {
            val q = chars[i]
            i += 1
            while (i < n && chars[i] != q) {
                i += if (chars[i] == '\\') 2 else 1
            }
            i = minOf(i + 1, n)
        }

        // Skip a brace-balanced block (nested rule / inline @media) verbatim.
        fun skipBlock() {
            var depth = 0
            while (i < n) {
                val c = chars[i]
                if (c == '"' || c == '\'') { skipString(); continue }
                if (skipComment()) continue
                if (c == '{') depth += 1
                if (c == '}') {
                    depth -= 1
                    if (depth <= 0) { i += 1; return }
                }
                i += 1
            }
        }

        while (i < n) {
            if (skipComment()) continue
            val c = chars[i]
            if (c == ' ' || c == '\n' || c == '\t' || c == '\r' || c == ';') {
                i += 1
                continue
            }
            // Read one segment up to ':', ';', or '{' at depth 0.
            val seg = StringBuilder()
            var stop = ';'
            segLoop@ while (i < n) {
                val ch = chars[i]
                if (skipComment()) continue
                when (ch) {
                    ':', ';', '{' -> {
                        stop = ch
                        break@segLoop
                    }
                    '"', '\'' -> {
                        val start = i
                        skipString()
                        seg.append(chars, start, i - start)
                    }
                    else -> {
                        seg.append(ch)
                        i += 1
                    }
                }
            }
            if (stop == '{') {
                skipBlock()   // nested block — deferred to the Taffy phase
                continue
            }
            if (stop == ';') {
                i += 1   // stray token without a value — build lint already flagged it
                continue
            }
            // stop == ':' — read the value to ';' or a top-level '{'-free end
            i += 1
            val value = StringBuilder()
            valLoop@ while (i < n) {
                val ch = chars[i]
                if (skipComment()) continue
                when (ch) {
                    ';' -> {
                        i += 1
                        break@valLoop
                    }
                    '{' -> {
                        // A selector snuck into a valueless read (e.g. `&.x{`):
                        // treat everything as a block and skip it.
                        skipBlock()
                        value.setLength(0)
                        break@valLoop
                    }
                    '"', '\'' -> {
                        val start = i
                        skipString()
                        value.append(chars, start, i - start)
                    }
                    '(' -> {
                        // String-aware paren balancing: a closing paren inside a
                        // quoted url string must not close the group — it corrupted
                        // the value and swallowed the following declarations.
                        var depth = 0
                        while (i < n) {
                            val p = chars[i]
                            if (p == '"' || p == '\'') {
                                val start = i
                                skipString()
                                value.append(chars, start, i - start)
                                continue
                            }
                            value.append(p)
                            if (p == '(') depth += 1
                            if (p == ')') depth -= 1
                            i += 1
                            if (depth == 0) break
                        }
                    }
                    else -> {
                        value.append(ch)
                        i += 1
                    }
                }
            }
            val prop = seg.toString().trim()
            val v = value.toString().trim()
            if (prop.isNotEmpty() && v.isNotEmpty()) {
                out.add(CSSDecl(property = if (prop.startsWith("--")) prop else prop.lowercase(), value = v))
            }
        }
        return out
    }
}
