//
//  StackNodeTest.kt - conformance tests for the DSX AST + parser (StackNode.kt),
//  asserting the SAME observable behaviors as the Swift reference
//  (OpenSource/Engine/iOS/StackNode.swift): tree shape, smart entities
//  (normalizeEntities, PR #1002), code lifting (liftCode), CDATA/comment
//  handling, failure behavior, and a real shipped component (Chip.dsx).
//

package despia.engine

import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StackNodeTest {

    /** Capture the kernelLog seam for a block, restoring the previous handler after. */
    private fun captureLog(block: () -> Unit): List<String> {
        val lines = mutableListOf<String>()
        val prev = StackXML.kernelLog
        StackXML.kernelLog = { lines.add(it) }
        try { block() } finally { StackXML.kernelLog = prev }
        return lines
    }

    /** Walk upward from the test working directory to find a repo-relative file. */
    private fun repoFile(rel: String): File? {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return f
            dir = dir.parentFile
        }
        return null
    }

    // MARK: - Tree shape

    @Test fun simpleTree() {
        val root = StackXML.parse(
            """
            <page id="home">
              <stack align="center"><text value="hi"/>tail</stack>
            </page>
            """.trimIndent()
        )
        assertNotNull(root)
        assertEquals("page", root.tag)
        assertEquals("home", root.id)
        assertNull(root.text)                              // pretty-print whitespace between children -> null
        assertEquals(listOf("stack"), root.children.map { it.tag })
        val stack = root.children[0]
        assertEquals("center", stack.attrs["align"])
        assertEquals(listOf("text"), stack.children.map { it.tag })
        assertEquals("hi", stack.children[0].attrs["value"])
        assertEquals("", stack.children[0].id)             // no id attr -> ""
        assertEquals("tail", stack.text)                   // mixed content accumulates on the element
    }

    @Test fun textAssembledAcrossEntityChunks() {
        // The foundCharacters regression: chunks split around entities must keep adjacent spaces.
        val n = StackXML.parse("<a>key &amp; tunes — note</a>")
        assertNotNull(n)
        assertEquals("key & tunes — note", n.text)
    }

    // MARK: - Attributes

    @Test fun attributeOrderAndEntities() {
        val n = StackXML.parse("""<a zeta="1" alpha="two words" mid="x &amp; y &lt;3" num="&#38;&#x26;"/>""")
        assertNotNull(n)
        // Document order preserved (LinkedHashMap; a superset of the Swift dictionary contract).
        assertEquals(listOf("zeta", "alpha", "mid", "num"), n.attrs.keys.toList())
        assertEquals("1", n.attrs["zeta"])
        assertEquals("two words", n.attrs["alpha"])
        assertEquals("x & y <3", n.attrs["mid"])           // real entities decode
        assertEquals("&&", n.attrs["num"])                 // numeric character references decode
    }

    // MARK: - normalizeEntities (PR #1002 - the HTML5 "ambiguous ampersand" rule)

    @Test fun normalizeAmbiguousAmpersandAndLtInsideAttr() {
        assertEquals(
            """<a visible-if="a &amp;&amp; b &lt; 3"/>""",
            StackXML.normalizeEntities("""<a visible-if="a && b < 3"/>""")
        )
    }

    @Test fun normalizeRealEntitiesPassThrough() {
        val s = """<a t="x &amp; &lt; &gt; &quot; &apos; &#38; &#x2F;">&amp; &#169;</a>"""
        assertEquals(s, StackXML.normalizeEntities(s))
    }

    @Test fun normalizeBareAmpersandInText() {
        assertEquals(
            "<a>fish &amp; chips &amp;&amp; more</a>",
            StackXML.normalizeEntities("<a>fish & chips && more</a>")
        )
    }

    @Test fun normalizeUnknownEntityLegalized() {
        // `&nbsp;` is not an XML entity - the ampersand reads as literal.
        assertEquals("<a>&amp;nbsp;</a>", StackXML.normalizeEntities("<a>&nbsp;</a>"))
    }

    @Test fun normalizeCommentAndCdataVerbatim() {
        val s = "<a><!-- a && b < 3 & <action> --><![CDATA[x < y && z & ]]></a>"
        assertEquals(s, StackXML.normalizeEntities(s))
    }

    @Test fun normalizeBareLtInTextOpensTag() {
        // Genuinely ambiguous - NOT escaped; the strict parser then rejects it (see parse test below).
        val s = "<a>1 < 2</a>"
        assertEquals(s, StackXML.normalizeEntities(s))
    }

    @Test fun parseAmbiguousAmpersandAsWritten() {
        // The #1002 headline: `visible-if="a && b < 3"` parses exactly as written.
        val n = StackXML.parse("""<stack><text visible-if="a && b < 3" value="A &amp; B"/></stack>""")
        assertNotNull(n)
        assertEquals("a && b < 3", n.children[0].attrs["visible-if"])
        assertEquals("A & B", n.children[0].attrs["value"])
    }

    @Test fun parseBareLtInTextFails() {
        val lines = captureLog {
            assertNull(StackXML.parse("<a>1 < 2</a>"))
        }
        assertEquals(1, lines.size)
        assertTrue(lines[0].startsWith("[Stack] XML parse failed at line "))
        assertTrue(lines[0].endsWith("Surface will be empty."))
    }

    // MARK: - liftCode (raw JS bodies, no CDATA needed)

    @Test fun liftScriptAndActionBodies() {
        val js = """if (a < b && c) { s = "]]>" + '&'; }"""
        val n = StackXML.parse(
            "<page><script>\n  $js\n</script><action name=\"go\" if=\"x && y\">emit('x')</action></page>"
        )
        assertNotNull(n)
        assertEquals(listOf("script", "action"), n.children.map { it.tag })
        assertEquals(js, n.children[0].text)               // 1:1, just trimmed - XML-hostile chars intact
        assertEquals("emit('x')", n.children[1].text)
        assertEquals("go", n.children[1].attrs["name"])
        assertEquals("x && y", n.children[1].attrs["if"])  // on-tag attrs are NOT lifted; normalized instead
    }

    @Test fun liftFunctionsBodyLikeEveryOtherJavaScriptHeadBlock() {
        val js = "function below(a, b) { return a < b && b > 0 }"
        val n = StackXML.parse("<page><head><functions>$js</functions></head></page>")
        assertNotNull(n)
        assertEquals("functions", n.children[0].children[0].tag)
        assertEquals(js, n.children[0].children[0].text)
    }

    @Test fun liftToleratesExplicitCdata() {
        val n = StackXML.parse("""<page><formula name="f"><![CDATA[ a < b && c ]]></formula></page>""")
        assertNotNull(n)
        assertEquals("a < b && c", n.children[0].text)
    }

    @Test fun commentMentioningCodeTagIsNotLifted() {
        // The regression guard: "<action>" inside a comment must not swallow the document.
        val n = StackXML.parse("""<!-- intro --><page><!-- use <action> like this --><text value="t"/></page>""")
        assertNotNull(n)
        assertEquals("page", n.tag)
        assertEquals(listOf("text"), n.children.map { it.tag })
        assertEquals("t", n.children[0].attrs["value"])
    }

    @Test fun selfClosingCodeTagHasNoBody() {
        val n = StackXML.parse("""<page><variable name="x" value="1"/></page>""")
        assertNotNull(n)
        assertEquals("variable", n.children[0].tag)
        assertNull(n.children[0].text)
    }

    @Test fun emptyCodeBodyIsEmptyString() {
        // Faithful Swift quirk: an empty code element reinject-s to "" (not null).
        val n = StackXML.parse("<page><script></script></page>")
        assertNotNull(n)
        assertEquals("", n.children[0].text)
    }

    // MARK: - CDATA in plain elements

    @Test fun cdataTrimmedPerBlock() {
        val n = StackXML.parse("<text><![CDATA[  a < b && c  ]]></text>")
        assertNotNull(n)
        assertEquals("a < b && c", n.text)
        // Per-block trim blends with surrounding text exactly like Foundation's foundCDATA:
        val m = StackXML.parse("<t>x<![CDATA[  y  ]]>z</t>")
        assertNotNull(m)
        assertEquals("xyz", m.text)
    }

    // MARK: - Malformed input

    @Test fun malformedInputReturnsNullAndReports() {
        val lines = captureLog {
            assertNull(StackXML.parse("<a><b></a>"))       // mismatched tags
            assertNull(StackXML.parse("<a t=\"1>x</a>"))   // stray quote
            assertNull(StackXML.parse(""))                 // empty document
            assertNull(StackXML.parse("<a/><b/>"))         // two roots - one-root expectation
        }
        assertEquals(4, lines.size)
        assertTrue(lines.all {
            it.startsWith("[Stack] XML parse failed") && it.endsWith("Surface will be empty.")
        })
    }

    // MARK: - A real shipped component

    @Test fun chipDsxParsedShape() {
        val f = repoFile("ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/Chip.dsx")
        assumeTrue(f != null, "Chip.dsx not present (open drop without ClosedSource) - skipping")
        val root = StackXML.parse(f!!.readText())
        assertNotNull(root)

        assertEquals("pressable", root.tag)
        assertEquals("dsx.event('tap')", root.attrs["on:tap"])
        assertNull(root.text)
        assertEquals(listOf("head", "stack"), root.children.map { it.tag })

        val head = root.children[0]
        assertEquals(
            listOf("attribute", "attribute", "attribute", "attribute", "event"),
            head.children.map { it.tag }
        )
        assertEquals(
            listOf("label", "icon", "selected", "color"),
            head.children.take(4).map { it.attrs["as"] }
        )
        assertEquals("'accent'", head.children[3].attrs["default"])
        assertEquals("tap", head.children[4].attrs["as"])

        val stack = root.children[1]
        assertEquals("center", stack.attrs["align"])
        assertEquals("true", stack.attrs["a11yGroup"])
        assertTrue(stack.attrs["background"]!!.contains("dsx.attribute.selected == 'true'"))
        assertNull(stack.text)
        assertEquals(listOf("image", "text"), stack.children.map { it.tag })
        assertEquals("dsx.attribute.icon", stack.children[0].attrs["visible-if"])
        assertEquals("13", stack.children[0].attrs["iconSize"])
        assertEquals("1", stack.children[1].attrs["lineLimit"])
        assertEquals("{{ dsx.attribute.label }}", stack.children[1].attrs["value"])
    }
}
