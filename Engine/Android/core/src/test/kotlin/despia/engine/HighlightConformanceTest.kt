package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The `<code>` highlighter against OpenSource/Conformance/code/tokens.json - the same file
 * the TS runner and the Swift reference execute. The expectation is a MASK, one letter per
 * character, so a failure prints the source and the two masks aligned under each other.
 */
class HighlightConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/code/tokens.json")
            if (candidate.exists()) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/code/tokens.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(): List<Map<String, Any?>> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("corpus is not an object")
        return (root["cases"] as? List<*> ?: emptyList<Any?>()).map { it as Map<String, Any?> }
    }

    @Test
    fun `the highlighter matches the shared corpus`() {
        val rows = cases()
        assertTrue(rows.size >= 30, "the corpus should not shrink silently")
        for (row in rows) {
            val name = row["name"] as String
            val source = row["source"] as String
            val want = row["mask"] as String
            val got = Highlight.mask(source)
            assertEquals(want, got, "$name\n  src  $source\n  want $want\n  got  $got")
        }
    }

    @Test
    fun `the letter table matches the corpus`() {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("corpus is not an object")
        @Suppress("UNCHECKED_CAST")
        val letters = root["_letters"] as Map<String, String>
        for (kind in HiKind.values()) {
            assertEquals(letters[kind.word], kind.letter.toString(), "letter for ${kind.word}")
        }
        assertEquals(HiKind.values().size, letters.size, "the corpus knows every kind and no more")
    }

    @Test
    fun `the spans tile the source`() {
        val inputs = cases().map { it["source"] as String } + listOf(
            " ", "a".repeat(5000), "`\${`\${`\${x}`}`}`", "/*".repeat(400), "'".repeat(300),
        )
        for (src in inputs) {
            var at = 0
            for (tok in Highlight.scan(src)) {
                assertEquals(at, tok.start, "gap or overlap in ${src.take(40)}")
                assertTrue(tok.end > tok.start, "an empty span is not a token")
                at = tok.end
            }
            assertEquals(src.length, at, "did not reach the end of ${src.take(40)}")
        }
    }

    @Test
    fun `adjacent spans never share a kind`() {
        for (row in cases()) {
            val toks = Highlight.scan(row["source"] as String)
            for (i in 1 until toks.size) {
                assertTrue(toks[i].kind != toks[i - 1].kind, "${row["name"]}: split run at ${toks[i].start}")
            }
        }
    }

    @Test
    fun `fuzz - any input scans, tiles and terminates`() {
        val alphabet = "abz09 \n\t'\"`/*\\\${}()[].,;:?!+-=<>&|~^_#@"
        var seed = 20260824L
        fun rand(): Double {
            seed = (seed * 1103515245L + 12345L) and 0x7fffffffL
            return seed.toDouble() / 0x7fffffff.toDouble()
        }
        repeat(4000) {
            val len = (rand() * 60).toInt()
            val sb = StringBuilder()
            repeat(len) { sb.append(alphabet[(rand() * alphabet.length).toInt()]) }
            val src = sb.toString()
            var at = 0
            for (tok in Highlight.scan(src)) {
                assertEquals(at, tok.start, src)
                at = tok.end
            }
            assertEquals(src.length, at, src)
        }
    }

    @Test
    fun `the markup shape splits on line breaks and never straddles one`() {
        val src = "const a = 1 // why\nreturn a"
        val rows = Highlight.lines(src)
        assertEquals(2, rows.size)
        assertEquals(src.split("\n")[0], rows[0].spans.joinToString("") { it.text })
        assertEquals(src.split("\n")[1], rows[1].spans.joinToString("") { it.text })
        assertTrue(rows.all { row -> row.spans.none { it.text.contains("\n") } })
    }
}
