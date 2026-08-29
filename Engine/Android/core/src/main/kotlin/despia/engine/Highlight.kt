package despia.engine

//
//  Highlight.kt - source spans for the `<code>` surface. Kotlin twin of
//  packages/kernel/src/jse/highlight.ts and Highlight.swift; the shared corpus is
//  OpenSource/Conformance/code/tokens.json.
//
//  THIS IS NOT `Jse.tokenize`. The evaluator's lexer strips comments, runs ASI and hands
//  back values with no idea where they came from - correct for running code, useless for
//  drawing it. A highlighter needs the opposite: every character accounted for, comments and
//  whitespace included, in source order, with offsets. So it is its own scanner, and it
//  shares the ONE rule that must not drift - whether a `/` opens a regex or divides.
//
//  The output TILES the source: contiguous, non-overlapping, index 0 to length. That is what
//  lets the corpus be a MASK of one letter per character, readable against the source by eye.
//

enum class HiKind(val letter: Char, val word: String) {
    PLAIN('.', "plain"),
    COMMENT('c', "comment"),
    STRING('s', "string"),
    NUMBER('n', "number"),
    REGEX('r', "regex"),
    KEYWORD('k', "keyword"),
    LITERAL('l', "literal"),
    CALL('f', "call"),
    PROPERTY('p', "property"),
    IDENT('i', "ident"),
    OPERATOR('o', "operator"),
    PUNCT('x', "punct"),
}

data class HiToken(val start: Int, val end: Int, val kind: HiKind)

data class HiSpan(val text: String, val kind: HiKind)

data class HiLine(val line: Int, val spans: List<HiSpan>)

object Highlight {

    private val KEYWORDS = setOf(
        "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
        "break", "continue", "switch", "case", "default", "try", "catch", "finally", "throw",
        "new", "typeof", "instanceof", "in", "of", "delete", "void", "await", "async", "yield",
        "this",
    )
    private val LITERALS = setOf("true", "false", "null", "undefined")
    private val PUNCT = "()[]{},;".toSet()
    private val OPERATOR = "+-*/%=<>!&|^~?:.".toSet()

    private fun isDigit(c: Char): Boolean = c in '0'..'9'
    private fun isWordStart(c: Char): Boolean = c.isLetter() || c == '_' || c == '$'
    private fun isWordChar(c: Char): Boolean = c.isLetterOrDigit() || c == '_' || c == '$'

    /** The regex-vs-division rule, identical to the evaluator's: a `/` is a regex when
     *  nothing valued precedes it, and a keyword does not count as a value. */
    private fun opensRegex(src: String, at: Int): Boolean {
        var i = at - 1
        while (i >= 0 && src[i].isWhitespace()) i--
        if (i < 0) return true
        val prev = src[i]
        if (prev == ')' || prev == ']' || prev == '\'' || prev == '"' || prev == '`') return false
        if (!isWordChar(prev)) return true
        var j = i
        while (j >= 0 && isWordChar(src[j])) j--
        val word = src.substring(j + 1, i + 1)
        return KEYWORDS.contains(word) && word != "this"
    }

    private fun endOfRegex(src: String, at: Int): Int {
        var i = at + 1
        var inClass = false
        while (i < src.length) {
            val c = src[i]
            if (c == '\\') { i = minOf(i + 2, src.length); continue }
            if (c == '\n') return i
            if (c == '[') { inClass = true; i++; continue }
            if (c == ']') { inClass = false; i++; continue }
            if (c == '/' && !inClass) { i++; break }
            i++
        }
        while (i < src.length && src[i] in 'a'..'z') i++
        return i
    }

    private fun endOfNumber(src: String, at: Int): Int {
        var i = at
        if (src[i] == '0' && i + 1 < src.length && src[i + 1] in "xXbBoO") {
            i += 2
            while (i < src.length && (isDigit(src[i]) || src[i] in "abcdefABCDEF_")) i++
            return i
        }
        while (i < src.length && (isDigit(src[i]) || src[i] == '_')) i++
        if (i < src.length && src[i] == '.' && i + 1 < src.length && isDigit(src[i + 1])) {
            i++
            while (i < src.length && (isDigit(src[i]) || src[i] == '_')) i++
        }
        if (i < src.length && (src[i] == 'e' || src[i] == 'E')) {
            var k = i + 1
            if (k < src.length && (src[k] == '+' || src[k] == '-')) k++
            if (k < src.length && isDigit(src[k])) {
                k++
                while (k < src.length && isDigit(src[k])) k++
                i = k
            }
        }
        return i
    }

    /** Spans covering every character of `source`, in order, with no gaps and no overlap. */
    fun scan(source: String): List<HiToken> {
        val out = ArrayList<HiToken>()
        fun push(start: Int, end: Int, kind: HiKind) {
            if (end <= start) return
            val last = out.lastOrNull()
            if (last != null && last.kind == kind && last.end == start) {
                out[out.size - 1] = last.copy(end = end)
                return
            }
            out.add(HiToken(start, end, kind))
        }

        val holes = ArrayDeque<Int>()
        var depth = 0
        var i = 0

        while (i < source.length) {
            val c = source[i]

            if (c.isWhitespace()) {
                val s = i
                while (i < source.length && source[i].isWhitespace()) i++
                push(s, i, HiKind.PLAIN)
                continue
            }

            if (c == '/' && i + 1 < source.length && source[i + 1] == '/') {
                val s = i
                while (i < source.length && source[i] != '\n') i++
                push(s, i, HiKind.COMMENT)
                continue
            }
            if (c == '/' && i + 1 < source.length && source[i + 1] == '*') {
                val s = i
                val close = source.indexOf("*/", i + 2)
                i = if (close < 0) source.length else close + 2
                push(s, i, HiKind.COMMENT)
                continue
            }
            if (c == '/' && opensRegex(source, i)) {
                val s = i
                i = endOfRegex(source, i)
                push(s, i, HiKind.REGEX)
                continue
            }

            if (c == '\'' || c == '"') {
                val s = i
                i++
                while (i < source.length) {
                    if (source[i] == '\\') { i = minOf(i + 2, source.length); continue }
                    if (source[i] == c) { i++; break }
                    if (source[i] == '\n') break
                    i++
                }
                push(s, i, HiKind.STRING)
                continue
            }

            if (c == '`') {
                val s = i
                i++
                while (i < source.length) {
                    if (source[i] == '\\') { i = minOf(i + 2, source.length); continue }
                    if (source[i] == '`') { i++; break }
                    if (source[i] == '$' && i + 1 < source.length && source[i + 1] == '{') break
                    i++
                }
                push(s, i, HiKind.STRING)
                if (i + 1 < source.length && source[i] == '$' && source[i + 1] == '{') {
                    push(i, i + 2, HiKind.OPERATOR)
                    i += 2
                    holes.addLast(depth)
                    depth = 0
                }
                continue
            }

            if (isDigit(c) || (c == '.' && i + 1 < source.length && isDigit(source[i + 1]))) {
                val s = i
                i = endOfNumber(source, i)
                push(s, i, HiKind.NUMBER)
                continue
            }

            if (isWordStart(c)) {
                val s = i
                while (i < source.length && isWordChar(source[i])) i++
                val word = source.substring(s, i)
                var j = i
                while (j < source.length && (source[j] == ' ' || source[j] == '\t')) j++
                var k = s - 1
                while (k >= 0 && (source[k] == ' ' || source[k] == '\t')) k--
                val kind = when {
                    KEYWORDS.contains(word) -> HiKind.KEYWORD
                    LITERALS.contains(word) -> HiKind.LITERAL
                    j < source.length && source[j] == '(' -> HiKind.CALL
                    k >= 0 && source[k] == '.' && (k == 0 || source[k - 1] != '.') -> HiKind.PROPERTY
                    else -> HiKind.IDENT
                }
                push(s, i, kind)
                continue
            }

            if (c == '}' && holes.isNotEmpty() && depth == 0) {
                push(i, i + 1, HiKind.OPERATOR)
                i++
                depth = holes.removeLast()
                val s = i
                while (i < source.length) {
                    if (source[i] == '\\') { i = minOf(i + 2, source.length); continue }
                    if (source[i] == '`') { i++; break }
                    if (source[i] == '$' && i + 1 < source.length && source[i + 1] == '{') break
                    i++
                }
                push(s, i, HiKind.STRING)
                if (i + 1 < source.length && source[i] == '$' && source[i + 1] == '{') {
                    push(i, i + 2, HiKind.OPERATOR)
                    i += 2
                    holes.addLast(depth)
                    depth = 0
                }
                continue
            }

            if (PUNCT.contains(c)) {
                if (c == '{' || c == '[' || c == '(') depth++
                else if (c == '}' || c == ']' || c == ')') depth = maxOf(0, depth - 1)
                push(i, i + 1, HiKind.PUNCT)
                i++
                continue
            }
            if (OPERATOR.contains(c)) {
                val s = i
                while (i < source.length && OPERATOR.contains(source[i])) i++
                push(s, i, HiKind.OPERATOR)
                continue
            }

            push(i, i + 1, HiKind.PLAIN)
            i++
        }
        return out
    }

    /** The corpus form: one letter per character. A wrong length fails before a wrong colour. */
    fun mask(source: String): String {
        val sb = StringBuilder(source.length)
        for (tok in scan(source)) repeat(tok.end - tok.start) { sb.append(tok.kind.letter) }
        return sb.toString()
    }

    /**
     * The markup-facing shape: one row per source line, each a run of `{ text, kind }`.
     * A code editor draws line by line, so the builtin hands back exactly that rather than
     * offsets a page would have to slice.
     */
    fun lines(source: String): List<HiLine> {
        val out = ArrayList<ArrayList<HiSpan>>()
        out.add(ArrayList())
        for (tok in scan(source)) {
            val parts = source.substring(tok.start, tok.end).split("\n")
            for ((index, part) in parts.withIndex()) {
                if (index > 0) out.add(ArrayList())
                if (part.isEmpty()) continue
                val row = out.last()
                val last = row.lastOrNull()
                if (last != null && last.kind == tok.kind) {
                    row[row.size - 1] = last.copy(text = last.text + part)
                    continue
                }
                row.add(HiSpan(part, tok.kind))
            }
        }
        return out.mapIndexed { index, spans -> HiLine(index + 1, spans) }
    }

    /** The JSE `highlight(source)` value: plain maps and lists the store can render. */
    fun jseValue(source: String): List<Map<String, Any?>> =
        lines(source).map { row ->
            mapOf(
                "line" to row.line,
                "spans" to row.spans.map { mapOf("text" to it.text, "kind" to it.kind.word) },
            )
        }
}
