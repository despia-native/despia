//
//  MarkdownProse.kt — the PROSE PLANE for rendered markdown, Kotlin twin of
//  OpenSource/Web/packages/dom/src/prose.ts: the syntax-tint tokenizer plus the design
//  language (type scale with tightening weight/tracking, elevated code surfaces, inline
//  chips, the accent quote rail, band-header tables, muted list markers, hairline rules)
//  expressed as PURE DATA so the Compose renderer (:render MarkdownBlocksView.kt) maps
//  it to its own primitives and a plain-JVM test can pin the mapping SDK-free.
//
//  The tint is render-time presentation, not grammar: the neutral block tree and the
//  markdown corpus are untouched. Scanning is single-pass and regex-free — every branch
//  advances the cursor, so hostile input degrades to plain tokens instead of
//  pathological time. Token texts ALWAYS concatenate back to the input — tint never
//  rewrites, drops or reorders a byte (pinned by MarkdownProseTest).
//
//  COLORS: every surface/ink below is a semantic-token WORD from the system-defaults
//  corpus (OpenSource/Conformance/defaults/tokens.json), resolved by the renderer's own
//  StackStyle.color funnel — adaptive per scheme, never a pinned value. The ONE
//  exception is the tint palette, which prose.ts also carries as its own scheme tables
//  inside the sheet (the palette is part of the prose plane, not the token vocabulary):
//  the same light/dark pairs ride here, picked by the renderer's live scheme.
//
//  PURE JVM by construction (:core, no android.*, no Compose).
//

package despia.engine

// MARK: - the syntax tint (prose.ts tokenizeCode twin)

enum class CodeTokenKind { KW, STR, COM, NUM, TYP, PUN, PLAIN }

data class CodeToken(val kind: CodeTokenKind, val text: String)

object MarkdownProse {

    /** Tint ceiling — past it the remainder is one plain token (CODE_TINT_LIMITS). */
    const val TINT_LIMIT_CHARACTERS = 65_536

    private class Lexicon(
        val keywords: Set<String>,
        val capitalTypes: Boolean,
        val lineComments: List<String>,
        val blockComment: Pair<String, String>? = null,
        val quotes: List<Char> = emptyList(),
        val sigils: List<Char> = emptyList(),
        val unitNumbers: Boolean = false,
    )

    private val TS_KEYWORDS = setOf(
        "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
        "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
        "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
        "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new", "null",
        "number", "object", "of", "private", "protected", "public", "readonly", "return", "satisfies",
        "set", "static", "string", "super", "switch", "this", "throw", "true", "try", "type",
        "typeof", "undefined", "unknown", "var", "void", "while", "yield",
    )
    private val SWIFT_KEYWORDS = setOf(
        "actor", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
        "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
        "false", "fileprivate", "final", "for", "func", "guard", "if", "import", "in", "init",
        "inout", "internal", "is", "lazy", "let", "mutating", "nil", "open", "operator", "override",
        "private", "protocol", "public", "repeat", "required", "rethrows", "return", "self", "some",
        "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try",
        "typealias", "var", "weak", "where", "while",
    )
    private val KOTLIN_KEYWORDS = setOf(
        "abstract", "as", "break", "by", "catch", "class", "companion", "const", "continue",
        "data", "do", "else", "enum", "false", "final", "finally", "for", "fun", "if", "import",
        "in", "init", "inline", "interface", "internal", "is", "lateinit", "null", "object",
        "open", "operator", "out", "override", "package", "private", "protected", "public",
        "return", "sealed", "super", "suspend", "this", "throw", "true", "try", "typealias",
        "val", "var", "when", "while",
    )
    private val JAVA_KEYWORDS = setOf(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
        "const", "continue", "default", "do", "double", "else", "enum", "extends", "false",
        "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int",
        "interface", "long", "native", "new", "null", "package", "private", "protected",
        "public", "record", "return", "short", "static", "super", "switch", "synchronized",
        "this", "throw", "throws", "transient", "true", "try", "var", "void", "volatile", "while",
    )
    private val RUBY_KEYWORDS = setOf(
        "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else",
        "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not",
        "or", "raise", "redo", "require", "require_relative", "rescue", "retry", "return",
        "self", "super", "then", "true", "undef", "unless", "until", "when", "while", "yield",
    )
    private val BASH_KEYWORDS = setOf(
        "case", "do", "done", "elif", "else", "esac", "exit", "export", "fi", "for", "function",
        "if", "in", "local", "return", "select", "set", "shift", "then", "until", "while",
    )
    private val PYTHON_KEYWORDS = setOf(
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
        "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
        "with", "yield", "False", "None", "True",
    )

    private val LEXICONS: Map<String, Lexicon> = buildMap {
        fun add(names: List<String>, lexicon: Lexicon) { for (name in names) put(name, lexicon) }
        add(listOf("ts", "tsx", "typescript", "js", "jsx", "javascript"), Lexicon(
            TS_KEYWORDS, capitalTypes = true, lineComments = listOf("//"),
            blockComment = "/*" to "*/", quotes = listOf('"', '\'', '`')))
        add(listOf("swift"), Lexicon(
            SWIFT_KEYWORDS, capitalTypes = true, lineComments = listOf("//"),
            blockComment = "/*" to "*/", quotes = listOf('"')))
        add(listOf("kotlin", "kt", "kts"), Lexicon(
            KOTLIN_KEYWORDS, capitalTypes = true, lineComments = listOf("//"),
            blockComment = "/*" to "*/", quotes = listOf('"')))
        add(listOf("java"), Lexicon(
            JAVA_KEYWORDS, capitalTypes = true, lineComments = listOf("//"),
            blockComment = "/*" to "*/", quotes = listOf('"')))
        add(listOf("json", "jsonc"), Lexicon(
            setOf("true", "false", "null"), capitalTypes = false, lineComments = listOf("//"),
            quotes = listOf('"')))
        add(listOf("css"), Lexicon(
            setOf("important"), capitalTypes = false, lineComments = emptyList(),
            blockComment = "/*" to "*/", quotes = listOf('"', '\''), unitNumbers = true))
        add(listOf("bash", "sh", "shell", "zsh", "console"), Lexicon(
            BASH_KEYWORDS, capitalTypes = false, lineComments = listOf("#"),
            quotes = listOf('"', '\''), sigils = listOf('$')))
        add(listOf("ruby", "rb"), Lexicon(
            RUBY_KEYWORDS, capitalTypes = true, lineComments = listOf("#"),
            quotes = listOf('"', '\''), sigils = listOf('@', '$')))
        add(listOf("yaml", "yml"), Lexicon(
            setOf("true", "false", "null", "yes", "no"), capitalTypes = false,
            lineComments = listOf("#"), quotes = listOf('"', '\'')))
        add(listOf("python", "py"), Lexicon(
            PYTHON_KEYWORDS, capitalTypes = true, lineComments = listOf("#"), quotes = listOf('"', '\'')))
    }

    private val MARKUP_LANGUAGES = setOf("dsx", "xml", "html", "svg")

    private fun isIdentStart(ch: Char): Boolean =
        ch in 'a'..'z' || ch in 'A'..'Z' || ch == '_' || ch == '$'
    private fun isIdentPart(ch: Char): Boolean =
        isIdentStart(ch) || ch in '0'..'9' || ch == '-' || ch == '?'
    private fun isDigit(ch: Char): Boolean = ch in '0'..'9'
    private fun isPunct(ch: Char): Boolean = ch in "()[]{}<>,;:.=+-*/%&|!?~^#@\\"

    /** Token sink with same-kind coalescing — adjacent runs become ONE token, so the
     *  Compose spans and the web's DOM/SSR runs stay congruent. */
    private class Tokens {
        val out = ArrayList<CodeToken>()
        fun push(kind: CodeTokenKind, text: String) {
            if (text.isEmpty()) return
            val last = out.lastOrNull()
            if (last != null && last.kind == kind) out[out.size - 1] = CodeToken(kind, last.text + text)
            else out.add(CodeToken(kind, text))
        }
    }

    private fun tokenizeMarkup(text: String): List<CodeToken> {
        val tokens = Tokens()
        var i = 0
        while (i < text.length) {
            if (text.startsWith("<!--", i)) {
                val end = text.indexOf("-->", i + 4)
                val stop = if (end == -1) text.length else end + 3
                tokens.push(CodeTokenKind.COM, text.substring(i, stop))
                i = stop
                continue
            }
            if (text[i] == '<') {
                // the tag: "<" or "</" dimmed, the name accented, then the attribute run
                var j = i + 1
                if (j < text.length && (text[j] == '/' || text[j] == '!' || text[j] == '?')) j += 1
                tokens.push(CodeTokenKind.PUN, text.substring(i, j))
                i = j
                while (i < text.length && isIdentPart(text[i])) i += 1
                tokens.push(CodeTokenKind.KW, text.substring(j, i))
                // inside the tag until ">": attr names, "=", quoted values
                while (i < text.length && text[i] != '>') {
                    val ch = text[i]
                    if (ch == '"' || ch == '\'') {
                        var k = i + 1
                        while (k < text.length && text[k] != ch) k += 1
                        if (k < text.length) k += 1
                        tokens.push(CodeTokenKind.STR, text.substring(i, k))
                        i = k
                    } else if (isIdentStart(ch)) {
                        var k = i + 1
                        while (k < text.length && (isIdentPart(text[k]) || text[k] == ':' || text[k] == '.')) k += 1
                        tokens.push(CodeTokenKind.TYP, text.substring(i, k))
                        i = k
                    } else if (ch == '=' || ch == '/') {
                        tokens.push(CodeTokenKind.PUN, ch.toString())
                        i += 1
                    } else {
                        tokens.push(CodeTokenKind.PLAIN, ch.toString())
                        i += 1
                    }
                }
                if (i < text.length) { tokens.push(CodeTokenKind.PUN, ">"); i += 1 }
                continue
            }
            val next = text.indexOf('<', i)
            val stop = if (next == -1) text.length else next
            tokens.push(CodeTokenKind.PLAIN, text.substring(i, stop))
            i = stop
        }
        return tokens.out
    }

    private fun tokenizeWithLexicon(text: String, lexicon: Lexicon): List<CodeToken> {
        val tokens = Tokens()
        var i = 0
        outer@ while (i < text.length) {
            val ch = text[i]
            for (opener in lexicon.lineComments) {
                if (text.startsWith(opener, i)) {
                    val end = text.indexOf('\n', i)
                    val stop = if (end == -1) text.length else end
                    tokens.push(CodeTokenKind.COM, text.substring(i, stop))
                    i = stop
                    continue@outer
                }
            }
            val block = lexicon.blockComment
            if (block != null && text.startsWith(block.first, i)) {
                val end = text.indexOf(block.second, i + block.first.length)
                val stop = if (end == -1) text.length else end + block.second.length
                tokens.push(CodeTokenKind.COM, text.substring(i, stop))
                i = stop
                continue
            }
            if (ch in lexicon.quotes) {
                var j = i + 1
                while (j < text.length && text[j] != ch) {
                    // a backslash escape keeps an embedded quote inside the string run
                    j += if (text[j] == '\\' && j + 1 < text.length) 2 else 1
                    // plain quotes never span lines; template literals do
                    if (ch != '`' && j - 1 < text.length && text[j - 1] == '\n') { j -= 1; break }
                }
                if (j < text.length && text[j] == ch) j += 1
                tokens.push(CodeTokenKind.STR, text.substring(i, j))
                i = j
                continue
            }
            if (ch in lexicon.sigils && i + 1 < text.length
                && (isIdentStart(text[i + 1]) || text[i + 1] == '{')) {
                var j = i + 1
                if (text[j] == '{') {
                    val end = text.indexOf('}', j)
                    j = if (end == -1) text.length else end + 1
                } else {
                    while (j < text.length && isIdentPart(text[j])) j += 1
                }
                tokens.push(CodeTokenKind.TYP, text.substring(i, j))
                i = j
                continue
            }
            val hexColor = ch == '#' && lexicon.unitNumbers && i + 1 < text.length
                && (isDigit(text[i + 1]) || text[i + 1] in 'a'..'f' || text[i + 1] in 'A'..'F')
            if (isDigit(ch) || hexColor) {
                var j = i + (if (hexColor) 1 else 0)
                while (j < text.length && (isDigit(text[j]) || text[j] == '.' || text[j] == '_'
                        || text[j] in 'a'..'f' || text[j] in 'A'..'F'
                        || text[j] == 'x' || text[j] == 'X')) j += 1
                if (lexicon.unitNumbers) {
                    while (j < text.length && (isIdentStart(text[j]) || text[j] == '%')) j += 1
                }
                tokens.push(CodeTokenKind.NUM, text.substring(i, j))
                i = j
                continue
            }
            if (isIdentStart(ch) || (ch == '@' && lexicon.blockComment != null && lexicon.lineComments.isEmpty())) {
                // css at-rules keep their "@" with the word so `@media` tints as one keyword
                var j = i + (if (ch == '@') 1 else 0)
                while (j < text.length && isIdentPart(text[j])) j += 1
                val word = text.substring(i, j)
                val bare = if (ch == '@') word.substring(1) else word
                if (ch == '@' || lexicon.keywords.contains(bare)) tokens.push(CodeTokenKind.KW, word)
                else if (lexicon.capitalTypes && bare.isNotEmpty() && bare[0] in 'A'..'Z') tokens.push(CodeTokenKind.TYP, word)
                else tokens.push(CodeTokenKind.PLAIN, word)
                i = j
                continue
            }
            if (isPunct(ch)) {
                tokens.push(CodeTokenKind.PUN, ch.toString())
                i += 1
                continue
            }
            tokens.push(CodeTokenKind.PLAIN, ch.toString())
            i += 1
        }
        return tokens.out
    }

    /** Tint `text` for `language`. Unknown languages (and anything past the ceiling)
     *  come back as plain tokens, so the consumer's fallback is the exact pre-tint
     *  output. The concatenated token text is ALWAYS the input. */
    fun tokenizeCode(language: String, text: String): List<CodeToken> {
        val id = language.trim().lowercase()
        val capped = if (text.length > TINT_LIMIT_CHARACTERS) text.substring(0, TINT_LIMIT_CHARACTERS) else text
        val rest = text.substring(capped.length)
        val out: MutableList<CodeToken> = when {
            MARKUP_LANGUAGES.contains(id) -> tokenizeMarkup(capped).toMutableList()
            else -> {
                val lexicon = LEXICONS[id]
                if (lexicon == null) {
                    if (capped.isNotEmpty()) mutableListOf(CodeToken(CodeTokenKind.PLAIN, capped)) else mutableListOf()
                } else tokenizeWithLexicon(capped, lexicon).toMutableList()
            }
        }
        if (rest.isNotEmpty()) {
            val last = out.lastOrNull()
            if (last != null && last.kind == CodeTokenKind.PLAIN) {
                out[out.size - 1] = CodeToken(CodeTokenKind.PLAIN, last.text + rest)
            } else out.add(CodeToken(CodeTokenKind.PLAIN, rest))
        }
        return out
    }

    // MARK: - the design language (the prose sheet's numbers, at native scale)

    /** One text role: size/lineHeight in display points (the sheet's rem values at the
     *  16pt body, fluid clamps taken at their phone-width minimum), tracking in em,
     *  weight as its CSS number (renderers map 400/600/700 to their own weight types). */
    data class TypeSpec(
        val size: Float,
        val weight: Int,
        val trackingEm: Float,
        val lineHeight: Float,
    )

    const val BODY_SIZE = 16f

    /** Body flow — 1rem / 1.7 / -0.009em over the `label` token. */
    val paragraph = TypeSpec(size = 16f, weight = 400, trackingEm = -0.009f, lineHeight = 1.7f)

    /** The lede convention: the first paragraph after the page h1 reads as a deck
     *  (1.125em / 1.6 / -0.011em, `tertiary` ink). */
    val lede = TypeSpec(size = 18f, weight = 400, trackingEm = -0.011f, lineHeight = 1.6f)

    /** The type scale: tracking tightens and weight rises as the level climbs. Levels
     *  clamp into 1…6; h6 additionally drops to the `secondary` ink (headingInk). */
    fun heading(level: Int): TypeSpec = when (level.coerceIn(1, 6)) {
        1 -> TypeSpec(size = 28f, weight = 700, trackingEm = -0.022f, lineHeight = 1.15f)
        2 -> TypeSpec(size = 22f, weight = 600, trackingEm = -0.018f, lineHeight = 1.25f)
        3 -> TypeSpec(size = 18f, weight = 600, trackingEm = -0.014f, lineHeight = 1.3f)
        4 -> TypeSpec(size = 17f, weight = 600, trackingEm = -0.01f, lineHeight = 1.4f)
        else -> TypeSpec(size = 15f, weight = 600, trackingEm = -0.006f, lineHeight = 1.4f)
    }

    /** Heading ink — `label`, except h6 which drops to `secondary` (the sheet's h6). */
    fun headingInk(level: Int): String = if (level >= 6) "secondary" else "label"

    // Surfaces + inks as semantic-token WORDS (StackStyle.color vocabulary) — the
    // system-defaults corpus resolves each to the platform's own adaptive slot.
    const val BODY_INK = "label"
    const val LEDE_INK = "tertiary"
    const val LINK_INK = "accent"
    const val CHIP_SURFACE = "fill"                       // inline code chip — --dsx-fill
    const val CODE_SURFACE = "groupedBackground"          // fenced code — --dsx-secondary-background
    const val CARD_SURFACE = "secondaryGroupedBackground" // table card — --dsx-surface-raised
    const val BAND_SURFACE = "fill"                       // table header band — --dsx-fill
    const val BAND_INK = "secondary"
    const val MARKER_INK = "tertiary"                     // list markers — muted, tabular
    const val HAIRLINE_INK = "separator"

    /** Soft hairlines (code ring, table row rules, image outline) ride the separator
     *  token at reduced alpha — the --dsx-outline-soft stand-in the Table element
     *  already established (Displays.kt's half-opacity divider). */
    const val SOFT_HAIRLINE_ALPHA = 0.5f

    /** The quote rail is the accent at 55%, its wash the accent at 12% — the sheet's
     *  color-mix(accent 55%) rail over --dsx-accent-muted, but off the app's own
     *  accent token so a white-label tint carries into its prose. */
    const val QUOTE_RAIL_ALPHA = 0.55f
    const val QUOTE_WASH_ALPHA = 0.12f
    const val QUOTE_RAIL_WIDTH = 3f

    // Metrics, in display points (the sheet's px values).
    const val CODE_RADIUS = 12f          // fenced code + images — the sheet's radius 12
    const val CARD_RADIUS = 14f          // table card — --dsx-radius-card
    const val CHIP_RADIUS = 6f           // inline chip + band caps — --dsx-radius-sm
    const val CODE_PAD_V = 16f           // --dsx-space-4
    const val CODE_PAD_H = 20f           // --dsx-space-5
    const val CODE_FONT_SIZE = 14f       // 0.875em
    const val CODE_LINE_HEIGHT = 1.65f
    const val CHIP_FONT_SCALE = 0.9f     // inline code — 0.9em of its run
    const val CARD_PAD = 8f              // --dsx-space-2
    const val BAND_HEIGHT = 36f          // 2.25rem
    const val BAND_FONT_SIZE = 12f
    const val BAND_TRACKING_EM = 0.02f   // the one tracking that WIDENS — band caps
    const val BAND_GAP = 5f              // the spacer between band and rows
    const val TABLE_FONT_SIZE = 15f      // 0.9375em
    const val TABLE_CELL_PAD_V = 8f      // --dsx-space-2
    const val TABLE_CELL_PAD_H = 12f     // --dsx-space-3
    const val QUOTE_PAD_V = 12f          // --dsx-space-3
    const val QUOTE_PAD_H = 20f          // --dsx-space-5
    const val LIST_INDENT = 24f          // 1.5em
    const val LIST_ITEM_GAP = 6f         // 0.375em
    const val IMAGE_RADIUS = 12f

    /** Vertical rhythm: the sheet's per-block margins (em of the block's own size,
     *  precomputed to points). Adjacent blocks collapse to the larger edge (gap). */
    fun spaceAbove(block: MarkdownBlock): Float = when (block) {
        is MarkdownBlock.Heading -> when (block.level.coerceIn(1, 6)) {
            1 -> 0f
            2 -> 1.9f * 22f
            3 -> 1.7f * 18f
            4 -> 1.6f * 17f
            else -> 1.5f * 15f
        }
        is MarkdownBlock.Paragraph, is MarkdownBlock.Listing -> 1.1f * BODY_SIZE
        is MarkdownBlock.Rule -> 2.5f * BODY_SIZE
        else -> 1.5f * BODY_SIZE
    }

    fun spaceBelow(block: MarkdownBlock): Float = when (block) {
        is MarkdownBlock.Heading -> when (block.level.coerceIn(1, 6)) {
            1 -> 0.6f * 28f
            2 -> 0.65f * 22f
            3 -> 0.6f * 18f
            4 -> 0.5f * 17f
            else -> 0.5f * 15f
        }
        is MarkdownBlock.Paragraph, is MarkdownBlock.Listing -> 1.1f * BODY_SIZE
        is MarkdownBlock.Rule -> 2.5f * BODY_SIZE
        else -> 1.5f * BODY_SIZE
    }

    /** The gap between two adjacent blocks: CSS-collapse (the larger of the meeting
     *  margins), zero before the first block, and the subtitle rule — a heading
     *  directly after a heading closes up to 0.35em of its own size. */
    fun gap(previous: MarkdownBlock?, current: MarkdownBlock): Float {
        if (previous == null) return 0f
        if (previous is MarkdownBlock.Heading && previous.level <= 4 && current is MarkdownBlock.Heading) {
            return 0.35f * heading(current.level).size
        }
        return maxOf(spaceBelow(previous), spaceAbove(current))
    }

    /** Is this paragraph the lede — the first paragraph, directly after the page h1? */
    fun isLede(previous: MarkdownBlock?, current: MarkdownBlock): Boolean =
        current is MarkdownBlock.Paragraph && previous is MarkdownBlock.Heading && previous.level == 1

    // The tint palette — the prose sheet's own scheme tables (--dsx-code-*), ARGB.
    // Values clear WCAG AA against both the code surface and the page background in
    // their scheme; comments additionally italicize.
    fun tintLight(kind: CodeTokenKind): Long? = when (kind) {
        CodeTokenKind.KW -> 0xFF5A4FB5
        CodeTokenKind.STR -> 0xFF2F6D4F
        CodeTokenKind.COM -> 0xFF69707D
        CodeTokenKind.NUM -> 0xFF8F5310
        CodeTokenKind.TYP -> 0xFF0E6A74
        CodeTokenKind.PUN -> 0xFF5F6068
        CodeTokenKind.PLAIN -> null
    }

    fun tintDark(kind: CodeTokenKind): Long? = when (kind) {
        CodeTokenKind.KW -> 0xFFAAB1F2
        CodeTokenKind.STR -> 0xFF84C8A2
        CodeTokenKind.COM -> 0xFF9094A0
        CodeTokenKind.NUM -> 0xFFD3A878
        CodeTokenKind.TYP -> 0xFF72C6D4
        CodeTokenKind.PUN -> 0xFFA8A8B0
        CodeTokenKind.PLAIN -> null
    }
}
