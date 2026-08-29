//
//  MarkdownBlocks.kt — BLOCK-level markdown (A4b): the `<markdown>` element's parser,
//  Kotlin twin of OpenSource/Web/packages/dom/src/markdown-blocks.ts. THE OUTPUT IS THE
//  NEUTRAL TREE the shared corpus defines (OpenSource/Conformance/markdown/blocks.json,
//  executed here by MarkdownBlocksConformanceTest — the SAME file the TS reference runs),
//  not a View and not HTML: the Compose renderer (:render MarkdownBlocksView.kt) is a
//  consumer of this tree, never the definition of it.
//
//  INLINE content is NOT re-parsed per block kind: each block carries its raw inline
//  source and `parseMarkdownInline` below — the Kotlin twin of dom/src/markdown.ts, the
//  sink-driven grammar behind `<text markdown="true">` on all three renderers. The
//  Compose consumer is markdownInlineAnnotated in MarkdownBlocksView.kt. This parser
//  also feeds the block tree, where the corpus already pins the vocabulary.
//
//  SAFETY (the corpus `_safety` pin): raw HTML in the source is TEXT, and link/image
//  targets ride the http/https/mailto/tel/relative allowlist — a refused target renders
//  as prose, never as a live element. Bounded (characters/blocks/listDepth) so hostile
//  input degrades to plain text instead of allocating without limit.
//
//  PURE JVM by construction (:core, no android.*, no Compose) — SDK-free, so the corpus
//  runs in the plain-JVM test lane exactly like chains/jse/api.
//

package despia.engine

// MARK: - the neutral block tree (despia-markdown-blocks-v1)

sealed interface MarkdownBlock {
    data class Paragraph(val inline: String) : MarkdownBlock
    data class Heading(val level: Int, val inline: String) : MarkdownBlock
    data class Code(val language: String, val text: String) : MarkdownBlock
    data class Quote(val blocks: List<MarkdownBlock>) : MarkdownBlock
    data object Rule : MarkdownBlock
    data class Image(val src: String, val alt: String) : MarkdownBlock
    data class Listing(
        val ordered: Boolean,
        val start: Int,
        val items: List<MarkdownListItem>,
    ) : MarkdownBlock
    data class Table(val header: List<String>, val rows: List<List<String>>) : MarkdownBlock
}

data class MarkdownListItem(val inline: String, val blocks: List<MarkdownBlock> = emptyList())

object MarkdownBlocks {

    /** Hostile-input ceilings — the corpus `limits` block, same numbers. */
    const val LIMIT_CHARACTERS = 65_536
    const val LIMIT_BLOCKS = 512
    const val LIMIT_LIST_DEPTH = 6

    private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
    private val FENCE = Regex("^(```|~~~)\\s*([A-Za-z0-9_+-]*)\\s*$")
    private val RULE = Regex("^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$")
    private val BULLET = Regex("^(\\s*)([-*+])\\s+(.*)$")
    private val ORDERED = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
    private val QUOTE = Regex("^\\s*>\\s?(.*)$")
    private val IMAGE_ONLY = Regex("^!\\[([^\\]]*)]\\(([^)\\s]+)\\)$")
    private val TABLE_DIVIDER = Regex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")

    private fun cells(line: String): List<String> {
        var row = line.trim()
        if (row.startsWith("|")) row = row.substring(1)
        if (row.endsWith("|")) row = row.dropLast(1)
        return row.split("|").map { it.trim() }
    }

    /** Indentation in spaces, tabs counted as two — the width lists are authored at. */
    private fun indentOf(raw: String): Int {
        var n = 0
        for (ch in raw) {
            when (ch) {
                ' ' -> n += 1
                '\t' -> n += 2
                else -> return n
            }
        }
        return n
    }

    /** Would this line open a NEW block in the main loop (rather than lazily continuing
     *  an open paragraph)? Branch order mirrors parseLines exactly, so laziness can
     *  never swallow a construct the outer loop would have taken. */
    private fun startsBlock(lines: List<String>, i: Int): Boolean {
        val line = lines[i]
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return true
        if (FENCE.find(trimmed) != null) return true
        if (RULE.matches(line) && !BULLET.matches(line)) return true
        if (HEADING.find(trimmed) != null) return true
        if (QUOTE.find(line) != null) return true
        if (trimmed.contains("|") && i + 1 < lines.size && TABLE_DIVIDER.matches(lines[i + 1])) return true
        if (BULLET.find(line) != null || ORDERED.find(line) != null) return true
        val image = IMAGE_ONLY.find(trimmed)
        return image != null && safeMarkdownHref(image.groupValues[2]) != null
    }

    /** Does `prev` (the last line inside an open container) leave a PARAGRAPH open?
     *  Lazy continuation is a paragraph law: only then may an unmarked line keep its
     *  container. */
    private fun leavesParagraphOpen(prev: String): Boolean {
        val trimmed = prev.trim()
        if (trimmed.isEmpty()) return false
        if (FENCE.find(trimmed) != null) return false
        if (RULE.matches(prev) && !BULLET.matches(prev)) return false
        if (HEADING.find(trimmed) != null) return false
        val image = IMAGE_ONLY.find(trimmed)
        return image == null || safeMarkdownHref(image.groupValues[2]) == null
    }

    /** Parse a markdown document into the neutral block tree the corpus defines. */
    fun parse(source: String): List<MarkdownBlock> {
        val text = if (source.length > LIMIT_CHARACTERS) source.substring(0, LIMIT_CHARACTERS) else source
        return parseLines(text.split(Regex("\r\n|\r|\n")), 0)
    }

    private fun parseLines(lines: List<String>, depth: Int): List<MarkdownBlock> {
        val blocks = ArrayList<MarkdownBlock>()
        val paragraph = ArrayList<String>()

        fun flush() {
            if (paragraph.isEmpty()) return
            val inline = paragraph.joinToString(" ").trim()
            paragraph.clear()
            if (inline.isNotEmpty() && blocks.size < LIMIT_BLOCKS) blocks.add(MarkdownBlock.Paragraph(inline))
        }
        fun push(block: MarkdownBlock) {
            if (blocks.size < LIMIT_BLOCKS) blocks.add(block)
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()

            if (trimmed.isEmpty()) { flush(); i += 1; continue }

            // A fence wins over everything: its contents are bytes, never markdown. An
            // unterminated fence closes at the end of the document rather than swallowing it.
            val fence = FENCE.find(trimmed)
            if (fence != null) {
                flush()
                val marker = fence.groupValues[1]
                val language = fence.groupValues[2]
                val body = ArrayList<String>()
                i += 1
                while (i < lines.size && lines[i].trim() != marker) { body.add(lines[i]); i += 1 }
                if (i < lines.size) i += 1
                push(MarkdownBlock.Code(language, body.joinToString("\n")))
                continue
            }

            if (RULE.matches(line) && !BULLET.matches(line)) { flush(); push(MarkdownBlock.Rule); i += 1; continue }

            val heading = HEADING.find(trimmed)
            if (heading != null) {
                flush()
                push(MarkdownBlock.Heading(heading.groupValues[1].length, heading.groupValues[2].trim()))
                i += 1
                continue
            }

            val quote = QUOTE.find(line)
            if (quote != null) {
                flush()
                val inner = ArrayList<String>()
                inner.add(quote.groupValues[1])
                i += 1
                while (i < lines.size) {
                    val next = QUOTE.find(lines[i])
                    if (next != null) {
                        inner.add(next.groupValues[1])
                        i += 1
                        continue
                    }
                    // CommonMark laziness: an unmarked paragraph line keeps the quote
                    // open, but only while its innermost open block is still a paragraph.
                    if (startsBlock(lines, i) || !leavesParagraphOpen(inner[inner.size - 1])) break
                    inner.add(lines[i])
                    i += 1
                }
                push(MarkdownBlock.Quote(if (depth >= LIMIT_LIST_DEPTH) emptyList() else parseLines(inner, depth + 1)))
                continue
            }

            // A table needs its divider on the NEXT line; without one these are ordinary
            // paragraph lines that happen to contain pipes.
            if (trimmed.contains("|") && i + 1 < lines.size && TABLE_DIVIDER.matches(lines[i + 1])) {
                flush()
                val header = cells(trimmed)
                i += 2
                val rows = ArrayList<List<String>>()
                while (i < lines.size && lines[i].trim().contains("|")) {
                    val row = ArrayList(cells(lines[i]))
                    // Padded rather than dropped: a short row is an authoring slip, and
                    // dropping it loses content the author wrote.
                    while (row.size < header.size) row.add("")
                    rows.add(row.subList(0, header.size).toList())
                    i += 1
                }
                push(MarkdownBlock.Table(header, rows))
                continue
            }

            if (BULLET.find(line) != null || ORDERED.find(line) != null) {
                flush()
                val consumed = parseList(lines, i, depth)
                push(consumed.first)
                i = consumed.second
                continue
            }

            val image = IMAGE_ONLY.find(trimmed)
            if (image != null) {
                val src = safeMarkdownHref(image.groupValues[2])
                if (src != null) {
                    flush()
                    push(MarkdownBlock.Image(src, image.groupValues[1]))
                    i += 1
                    continue
                }
                // A refused target falls through to prose: the label survives, nothing becomes live.
            }

            paragraph.add(trimmed)
            i += 1
        }
        flush()
        return blocks
    }

    /** One list, from `start`, including any nested lists its items carry. */
    private fun parseList(lines: List<String>, start: Int, depth: Int): Pair<MarkdownBlock, Int> {
        val first = lines[start]
        val firstOrdered = ORDERED.find(first)
        val ordered = firstOrdered != null
        val baseIndent = indentOf(first)
        val items = ArrayList<MarkdownListItem>()
        val startNumber = firstOrdered?.groupValues?.get(2)?.toInt() ?: 0

        var i = start
        while (i < lines.size) {
            val line = lines[i]
            if (line.trim().isEmpty()) break
            val match = if (ordered) ORDERED.find(line) else BULLET.find(line)
            if (match == null) {
                // No marker: CommonMark laziness — an unmarked line that opens no new
                // block is the previous item's paragraph continuing, at any indent.
                val ownerIndex = items.size - 1
                if (ownerIndex < 0 || startsBlock(lines, i)) break
                items[ownerIndex] = items[ownerIndex].copy(inline = items[ownerIndex].inline + " " + line.trim())
                i += 1
                continue
            }
            val indent = indentOf(line)
            if (indent < baseIndent) break
            if (indent > baseIndent) {
                // Deeper: belongs to the item just emitted, as a nested list.
                val nested = parseList(lines, i, depth + 1)
                val ownerIndex = items.size - 1
                if (ownerIndex >= 0 && depth + 1 < LIMIT_LIST_DEPTH) {
                    val owner = items[ownerIndex]
                    items[ownerIndex] = owner.copy(blocks = owner.blocks + nested.first)
                }
                i = nested.second
                continue
            }
            items.add(MarkdownListItem(match.groupValues[3].trim()))
            i += 1
        }

        return Pair(MarkdownBlock.Listing(ordered, startNumber, items), i)
    }

    // MARK: - the inline vocabulary (dom/src/markdown.ts twin)

    /** Inline hostile-input ceilings — MARKDOWN_LIMITS in markdown.ts, same numbers. */
    const val INLINE_LIMIT_CHARACTERS = 16_384
    const val INLINE_LIMIT_NODES = 512
    const val INLINE_LIMIT_DEPTH = 8

    private val SAFE_LINK_SCHEME = Regex("^(?:https?:|mailto:|tel:)", RegexOption.IGNORE_CASE)
    private val ANY_SCHEME = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)
    private val CONTROL_CHARS = Regex("[\\u0000-\\u001f\\u007f]")

    /** The link allowlist: absolute http(s)/mailto/tel, or a relative/same-document
     *  target. Anything else (javascript:, data:, an unknown scheme, a protocol-relative
     *  origin) is refused and the label renders as plain text. */
    fun safeMarkdownHref(raw: String): String? {
        val href = raw.trim()
        if (href.isEmpty() || href.length > 2_048) return null
        if (CONTROL_CHARS.containsMatchIn(href)) return null
        if (SAFE_LINK_SCHEME.containsMatchIn(href)) return href
        if (ANY_SCHEME.containsMatchIn(href)) return null
        if (href.startsWith("//")) return null   // protocol-relative — an absolute origin in disguise
        return href
    }

    private data class Marker(val token: String, val tag: String)

    // Longest-first so `**` wins over `*` and `~~` over a stray `~`.
    private val MARKERS = listOf(
        Marker("**", "strong"),
        Marker("__", "strong"),
        Marker("~~", "del"),
        Marker("*", "em"),
        Marker("_", "em"),
    )

    private class NodeBudget(var nodes: Int)

    private val NULL_SINK = object : MarkdownInlineSink {
        override fun text(value: String) {}
        override fun open(tag: String, href: String?) {}
        override fun close() {}
    }

    /** Drive `sink` over the inline markdown of `source` — tags are the web vocabulary
     *  (`strong` · `em` · `del` · `code` · `a`), exactly what SwiftUI's Text renders. */
    fun parseInline(source: String, sink: MarkdownInlineSink) {
        val bounded = if (source.length > INLINE_LIMIT_CHARACTERS)
            source.substring(0, INLINE_LIMIT_CHARACTERS) else source
        scanInline(bounded, 0, sink, null, 0, NodeBudget(INLINE_LIMIT_NODES))
        if (bounded.length < source.length) sink.text(source.substring(bounded.length))
    }

    /** Scan `source` from `start` into `sink` until `closer` (or the end). Returns the
     *  index just past the closer, or -1 when the closer was never found — the caller
     *  then emits its own opening marker literally, exactly like CommonMark. */
    private fun scanInline(
        source: String,
        start: Int,
        sink: MarkdownInlineSink,
        closer: String?,
        depth: Int,
        budget: NodeBudget,
    ): Int {
        var i = start
        val literal = StringBuilder()
        fun flush() {
            if (literal.isEmpty()) return
            sink.text(literal.toString())
            literal.setLength(0)
        }
        while (i < source.length) {
            val ch = source[i]

            if (ch == '\\' && i + 1 < source.length) {
                // A backslash escape makes the next character literal — the one way an
                // author writes a real asterisk or bracket inside markdown copy.
                literal.append(source[i + 1])
                i += 2
                continue
            }

            if (closer != null && source.startsWith(closer, i)) {
                flush()
                return i + closer.length
            }

            if (ch == '`' && budget.nodes > 0) {
                val end = source.indexOf('`', i + 1)
                if (end != -1) {
                    budget.nodes -= 1
                    flush()
                    sink.open("code")
                    sink.text(source.substring(i + 1, end))
                    sink.close()
                    i = end + 1
                    continue
                }
            }

            if (ch == '[' && budget.nodes > 0 && depth < INLINE_LIMIT_DEPTH) {
                val close = source.indexOf(']', i + 1)
                if (close != -1 && close + 1 < source.length && source[close + 1] == '(') {
                    val paren = source.indexOf(')', close + 2)
                    if (paren != -1) {
                        val href = safeMarkdownHref(source.substring(close + 2, paren))
                        if (href != null) {
                            budget.nodes -= 1
                            flush()
                            sink.open("a", href)
                            scanInline(source, i + 1, sink, "]", depth + 1, budget)
                            sink.close()
                            i = paren + 1
                            continue
                        }
                    }
                }
            }

            if (depth < INLINE_LIMIT_DEPTH && budget.nodes > 0) {
                val marker = MARKERS.firstOrNull { source.startsWith(it.token, i) }
                // An emphasis run needs content: a marker immediately followed by its own
                // closer is literal text, matching CommonMark over an empty tag.
                if (marker != null && !source.startsWith(marker.token, i + marker.token.length)) {
                    // Look ahead on a THROWAWAY sink first: an unterminated run must render
                    // as literal text, and nothing may have been emitted for it.
                    val spent = budget.nodes
                    val end = scanInline(source, i + marker.token.length, NULL_SINK, marker.token, depth + 1, NodeBudget(spent))
                    if (end != -1) {
                        budget.nodes = spent - 1
                        flush()
                        sink.open(marker.tag)
                        scanInline(source, i + marker.token.length, sink, marker.token, depth + 1, budget)
                        sink.close()
                        i = end
                        continue
                    }
                    literal.append(marker.token)
                    i += marker.token.length
                    continue
                }
            }

            literal.append(ch)
            i += 1
        }
        flush()
        return if (closer == null) i else -1
    }
}

/** The inline sink — one parser, N emitters (the AnnotatedString builder in :render,
 *  assertion sinks in tests), the same shape as the web's MarkdownSink. */
interface MarkdownInlineSink {
    fun text(value: String)
    /** `tag` is one of `strong` · `em` · `del` · `code` · `a` (href set for `a` only). */
    fun open(tag: String, href: String? = null)
    fun close()
}
