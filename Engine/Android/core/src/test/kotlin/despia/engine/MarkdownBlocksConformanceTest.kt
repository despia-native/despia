package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The markdown BLOCK corpus runner — executes OpenSource/Conformance/markdown/blocks.json
 * through THIS runtime's parser (the TS reference runs the SAME file, dom test
 * markdown-blocks.test.ts), so `<markdown>` can never mean a different tree on Android.
 * Every case is (source → the neutral block tree) with no host types; the serializer
 * below emits exactly the corpus shape (ordered lists carry `start`, items carry
 * `blocks` only when nested — the web tree's own key discipline).
 *
 * Alongside the corpus: pins for the INLINE vocabulary twin (markdown.ts semantics —
 * emphasis/code/links, the allowlist, escapes, unterminated runs render literally), the
 * tint tokenizer's byte-identity invariant (token texts always concatenate back to the
 * input), and the MarkdownProse design mapping (the prose sheet's scale/weights/tracking
 * and its scheme-table palette, SDK-free).
 */
class MarkdownBlocksConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/markdown/blocks.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/markdown/blocks.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(): Map<String, Any?> =
        json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("blocks.json: not a JSON object")

    /** Whole numbers as Long on both sides — json() boxes small integers narrower. */
    private fun canonical(value: Any?): Any? = when (value) {
        is Number -> value.toLong()
        is Map<*, *> -> value.entries.associate { it.key to canonical(it.value) }
        is List<*> -> value.map(::canonical)
        else -> value
    }

    /** The corpus's neutral shape, from this runtime's tree. */
    private fun neutral(block: MarkdownBlock): Map<String, Any?> = when (block) {
        is MarkdownBlock.Paragraph -> mapOf("type" to "paragraph", "inline" to block.inline)
        is MarkdownBlock.Heading -> mapOf("type" to "heading", "level" to block.level.toLong(), "inline" to block.inline)
        is MarkdownBlock.Code -> mapOf("type" to "code", "language" to block.language, "text" to block.text)
        is MarkdownBlock.Quote -> mapOf("type" to "quote", "blocks" to block.blocks.map(::neutral))
        MarkdownBlock.Rule -> mapOf("type" to "rule")
        is MarkdownBlock.Image -> mapOf("type" to "image", "src" to block.src, "alt" to block.alt)
        is MarkdownBlock.Listing -> buildMap {
            put("type", "list")
            put("ordered", block.ordered)
            if (block.ordered) put("start", block.start.toLong())
            put("items", block.items.map { item ->
                buildMap<String, Any?> {
                    put("inline", item.inline)
                    if (item.blocks.isNotEmpty()) put("blocks", item.blocks.map(::neutral))
                }
            })
        }
        is MarkdownBlock.Table -> mapOf("type" to "table", "header" to block.header, "rows" to block.rows)
    }

    @Suppress("UNCHECKED_CAST")
    @Test
    fun `every corpus case parses to its neutral tree`() {
        val cases = corpus()["cases"] as? List<Map<String, Any?>> ?: error("blocks.json: no cases[]")
        assertTrue(cases.isNotEmpty(), "corpus has cases")
        for (case in cases) {
            val name = case["name"] as? String ?: "?"
            val source = case["source"] as? String ?: error("$name: no source")
            val expected = case["blocks"] as? List<Any?> ?: error("$name: no blocks[]")
            assertEquals(canonical(expected), canonical(MarkdownBlocks.parse(source).map(::neutral)),
                "markdown/blocks/$name")
        }
    }

    @Test
    fun `corpus limits match the implementation`() {
        @Suppress("UNCHECKED_CAST")
        val limits = corpus()["limits"] as? Map<String, Any?> ?: error("blocks.json: no limits{}")
        assertEquals(canonical(limits["characters"]), MarkdownBlocks.LIMIT_CHARACTERS.toLong())
        assertEquals(canonical(limits["blocks"]), MarkdownBlocks.LIMIT_BLOCKS.toLong())
        assertEquals(canonical(limits["listDepth"]), MarkdownBlocks.LIMIT_LIST_DEPTH.toLong())
    }

    // ── the inline vocabulary (markdown.ts semantics) ──────────────────────────────────

    /** Assertion sink: events as strings, plus the concatenated visible text. */
    private class EventSink : MarkdownInlineSink {
        val events = ArrayList<String>()
        val visible = StringBuilder()
        override fun text(value: String) { events.add("text:$value"); visible.append(value) }
        override fun open(tag: String, href: String?) { events.add(if (href != null) "open:$tag:$href" else "open:$tag") }
        override fun close() { events.add("close") }
    }

    private fun inlineEvents(source: String): EventSink {
        val sink = EventSink()
        MarkdownBlocks.parseInline(source, sink)
        return sink
    }

    @Test
    fun `inline vocabulary emits the five web tags`() {
        val sink = inlineEvents("a **b** `c` ~~d~~ _e_ [f](https://x.test)")
        assertEquals(listOf(
            "text:a ", "open:strong", "text:b", "close",
            "text: ", "open:code", "text:c", "close",
            "text: ", "open:del", "text:d", "close",
            "text: ", "open:em", "text:e", "close",
            "text: ", "open:a:https://x.test", "text:f", "close",
        ), sink.events)
    }

    @Test
    fun `a refused link scheme renders as plain text`() {
        val source = "[x](javascript:alert(1))"
        val sink = inlineEvents(source)
        assertTrue(sink.events.none { it.startsWith("open:a") }, "no live link")
        assertEquals(source, sink.visible.toString(), "the author's label survives as prose")
    }

    @Test
    fun `an unterminated run renders its marker literally`() {
        assertEquals("**a", inlineEvents("**a").visible.toString())
        assertEquals(listOf("text:**a"), inlineEvents("**a").events)
        assertEquals(listOf("text:**"), inlineEvents("**").events)
    }

    @Test
    fun `a backslash escape makes the next character literal`() {
        assertEquals(listOf("text:*not*"), inlineEvents("\\*not\\*").events)
    }

    @Test
    fun `a code span never interprets its bytes`() {
        assertEquals(listOf("open:code", "text:a*b*", "close"), inlineEvents("`a*b*`").events)
    }

    @Test
    fun `the link allowlist is the web allowlist`() {
        assertEquals("https://x.test", MarkdownBlocks.safeMarkdownHref("https://x.test"))
        assertEquals("HTTPS://X.TEST", MarkdownBlocks.safeMarkdownHref("HTTPS://X.TEST"))
        assertEquals("mailto:a@b.c", MarkdownBlocks.safeMarkdownHref("mailto:a@b.c"))
        assertEquals("tel:+1", MarkdownBlocks.safeMarkdownHref("tel:+1"))
        assertEquals("./shot.png", MarkdownBlocks.safeMarkdownHref("./shot.png"))
        assertEquals("#anchor", MarkdownBlocks.safeMarkdownHref("#anchor"))
        assertNull(MarkdownBlocks.safeMarkdownHref("javascript:alert(1)"))
        assertNull(MarkdownBlocks.safeMarkdownHref("data:text/html;base64,x"))
        assertNull(MarkdownBlocks.safeMarkdownHref("vbscript:x"))
        assertNull(MarkdownBlocks.safeMarkdownHref("//evil.test/x"))
        assertNull(MarkdownBlocks.safeMarkdownHref("http\u0000s://x"))
        assertNull(MarkdownBlocks.safeMarkdownHref(""))
        assertNull(MarkdownBlocks.safeMarkdownHref("https://" + "a".repeat(2_048)))
    }

    // ── the tint tokenizer (prose.ts tokenizeCode twin) ────────────────────────────────

    private fun concatenated(language: String, text: String): String =
        MarkdownProse.tokenizeCode(language, text).joinToString("") { it.text }

    @Test
    fun `token texts always concatenate back to the input`() {
        val samples = mapOf(
            "ts" to "const a = \"s\"; // note\nclass Foo { n = 0x1F }",
            "swift" to "func f() -> Int { return 1 } /* c */",
            "kotlin" to "val x = \"y\" // k",
            "css" to ".a { width: 12px; color: #fa0; } @media (min-width: 10rem) {}",
            "bash" to "export A=\"\$HOME\" # env\necho \${A}",
            "html" to "<div class=\"x\">text</div><!-- c -->",
            "json" to "{ \"a\": true, \"n\": 1.5 }",
            "python" to "def f():\n    return None  # c",
            "nosuchlang" to "anything *at* all",
        )
        for ((language, text) in samples) {
            assertEquals(text, concatenated(language, text), "tint($language) is byte-preserving")
        }
    }

    @Test
    fun `an unknown language is one plain token`() {
        val tokens = MarkdownProse.tokenizeCode("nosuchlang", "a b c")
        assertEquals(listOf(CodeToken(CodeTokenKind.PLAIN, "a b c")), tokens)
        assertEquals(emptyList(), MarkdownProse.tokenizeCode("nosuchlang", ""))
    }

    @Test
    fun `the ts lexicon tints the five kinds`() {
        val kinds = MarkdownProse.tokenizeCode("ts", "const Foo = \"s\"; // c\nreturn 1.5")
            .associate { it.text.trim() to it.kind }
        assertEquals(CodeTokenKind.KW, kinds["const"])
        assertEquals(CodeTokenKind.TYP, kinds["Foo"])
        assertEquals(CodeTokenKind.STR, kinds["\"s\""])
        assertEquals(CodeTokenKind.COM, kinds["// c"])
        assertEquals(CodeTokenKind.NUM, kinds["1.5"])
        assertEquals(CodeTokenKind.KW, kinds["return"])
    }

    @Test
    fun `markup tints tag anatomy`() {
        val tokens = MarkdownProse.tokenizeCode("dsx", "<text value=\"hi\"/>")
        assertEquals(listOf(
            CodeToken(CodeTokenKind.PUN, "<"),
            CodeToken(CodeTokenKind.KW, "text"),
            CodeToken(CodeTokenKind.PLAIN, " "),
            CodeToken(CodeTokenKind.TYP, "value"),
            CodeToken(CodeTokenKind.PUN, "="),
            CodeToken(CodeTokenKind.STR, "\"hi\""),
            CodeToken(CodeTokenKind.PUN, "/>"),
        ), tokens)
    }

    @Test
    fun `past the tint ceiling the remainder is plain`() {
        val text = "x".repeat(MarkdownProse.TINT_LIMIT_CHARACTERS) + "const"
        val tokens = MarkdownProse.tokenizeCode("ts", text)
        assertEquals(text, tokens.joinToString("") { it.text })
        assertEquals(CodeTokenKind.PLAIN, tokens.last().kind, "the overflow never tints")
    }

    // ── the design-language mapping (the prose sheet's numbers) ────────────────────────

    @Test
    fun `the type scale descends with tightening weight and tracking`() {
        val sizes = (1..6).map { MarkdownProse.heading(it).size }
        assertEquals(sizes.sortedDescending(), sizes, "heading sizes descend")
        assertTrue(MarkdownProse.heading(1).weight > MarkdownProse.heading(2).weight, "h1 carries the top weight")
        for (level in 1..5) {
            assertTrue(MarkdownProse.heading(level).trackingEm <= MarkdownProse.heading(level + 1).trackingEm,
                "tracking tightens upward (h$level)")
        }
        assertTrue(MarkdownProse.heading(6).trackingEm < 0f && MarkdownProse.paragraph.trackingEm < 0f,
            "prose tracking is negative")
        assertTrue(MarkdownProse.BAND_TRACKING_EM > 0f, "the band caps are the one widening tracking")
        assertEquals("secondary", MarkdownProse.headingInk(6))
        assertEquals("label", MarkdownProse.headingInk(1))
    }

    @Test
    fun `the rhythm collapses and the subtitle rule closes up`() {
        val h1 = MarkdownBlock.Heading(1, "t")
        val h2 = MarkdownBlock.Heading(2, "s")
        val p = MarkdownBlock.Paragraph("x")
        assertEquals(0f, MarkdownProse.gap(null, h1), "the first block starts flush")
        assertEquals(0.35f * MarkdownProse.heading(2).size, MarkdownProse.gap(h1, h2), "subtitle closes up")
        assertEquals(maxOf(MarkdownProse.spaceBelow(p), MarkdownProse.spaceAbove(h2)),
            MarkdownProse.gap(p, h2), "meeting margins collapse to the larger edge")
        assertTrue(MarkdownProse.isLede(h1, p), "first paragraph after h1 is the lede")
        assertTrue(!MarkdownProse.isLede(h2, p) && !MarkdownProse.isLede(p, p), "only after h1")
    }

    @Test
    fun `surfaces and inks are system-defaults token words`() {
        val vocabulary = setOf("label", "secondary", "tertiary", "background", "groupedBackground",
            "secondaryGroupedBackground", "fill", "separator", "accent", "destructive")
        for (word in listOf(MarkdownProse.BODY_INK, MarkdownProse.LEDE_INK, MarkdownProse.LINK_INK,
            MarkdownProse.CHIP_SURFACE, MarkdownProse.CODE_SURFACE, MarkdownProse.CARD_SURFACE,
            MarkdownProse.BAND_SURFACE, MarkdownProse.BAND_INK, MarkdownProse.MARKER_INK,
            MarkdownProse.HAIRLINE_INK, MarkdownProse.headingInk(1), MarkdownProse.headingInk(6))) {
            assertTrue(word in vocabulary, "'$word' is a defaults-corpus token")
        }
    }

    @Test
    fun `the code surface mirrors the prose sheet`() {
        assertEquals(12f, MarkdownProse.CODE_RADIUS)
        assertEquals(16f, MarkdownProse.CODE_PAD_V)     // --dsx-space-4
        assertEquals(20f, MarkdownProse.CODE_PAD_H)     // --dsx-space-5
        assertEquals(14f, MarkdownProse.CODE_FONT_SIZE) // 0.875em of the 16pt body
        assertEquals(1.65f, MarkdownProse.CODE_LINE_HEIGHT)
        assertEquals(6f, MarkdownProse.CHIP_RADIUS)     // --dsx-radius-sm
        assertEquals(36f, MarkdownProse.BAND_HEIGHT)    // 2.25rem
    }

    @Test
    fun `the tint palette is the prose sheet's scheme tables`() {
        // prose.ts PROSE_LIGHT_PALETTE / PROSE_DARK_PALETTE, byte for byte.
        assertEquals(0xFF5A4FB5, MarkdownProse.tintLight(CodeTokenKind.KW))
        assertEquals(0xFF2F6D4F, MarkdownProse.tintLight(CodeTokenKind.STR))
        assertEquals(0xFF69707D, MarkdownProse.tintLight(CodeTokenKind.COM))
        assertEquals(0xFF8F5310, MarkdownProse.tintLight(CodeTokenKind.NUM))
        assertEquals(0xFF0E6A74, MarkdownProse.tintLight(CodeTokenKind.TYP))
        assertEquals(0xFF5F6068, MarkdownProse.tintLight(CodeTokenKind.PUN))
        assertEquals(0xFFAAB1F2, MarkdownProse.tintDark(CodeTokenKind.KW))
        assertEquals(0xFF84C8A2, MarkdownProse.tintDark(CodeTokenKind.STR))
        assertEquals(0xFF9094A0, MarkdownProse.tintDark(CodeTokenKind.COM))
        assertEquals(0xFFD3A878, MarkdownProse.tintDark(CodeTokenKind.NUM))
        assertEquals(0xFF72C6D4, MarkdownProse.tintDark(CodeTokenKind.TYP))
        assertEquals(0xFFA8A8B0, MarkdownProse.tintDark(CodeTokenKind.PUN))
        assertNull(MarkdownProse.tintLight(CodeTokenKind.PLAIN))
        assertNull(MarkdownProse.tintDark(CodeTokenKind.PLAIN))
    }
}
