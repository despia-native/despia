//
//  StackNode.kt - the DSX AST + parser: the ONE grammar of the Stack engine.
//  Kotlin twin of OpenSource/Engine/iOS/StackNode.swift (the Swift file is the
//  reference implementation - same names, same behaviors, kept in lockstep;
//  conformance fixtures decide parity, not eyeballs).
//
//  Pure JVM (no android.*, no WebView), so the SAME parser compiles into the full
//  in-app engine (the Compose renderer) AND the widget snapshot profile (the
//  Glance backend). One grammar, one node model - only the render BACKEND differs
//  per surface (full SwiftUI in-app on iOS, the WidgetKit-safe subset in an
//  extension, Compose/Glance here). The kernel keeps a single source of truth for
//  what DSX means.
//

package despia.engine

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.SAXException
import org.xml.sax.SAXParseException
import org.xml.sax.ext.DefaultHandler2
import java.io.StringReader
import javax.xml.parsers.SAXParserFactory

// MARK: - Node + XML parser

data class StackNode(
    val tag: String,
    var attrs: Map<String, String>,
    var children: List<StackNode>,
    var text: String? = null,
) {
    val id: String get() = attrs["id"] ?: ""
}

object StackXML {

    /** Optional host-owned structural admission limits. The shared mobile parser
     * keeps its existing behavior when limits are omitted; untrusted entry hosts
     * can fail closed before recursive consumers ever see an adversarial tree. */
    data class ParseLimits(
        val maximumDepth: Int,
        val maximumNodes: Int,
    ) {
        init {
            require(maximumDepth > 0) { "maximumDepth must be positive" }
            require(maximumNodes > 0) { "maximumNodes must be positive" }
        }
    }

    /**
     * The parse-failure seam. The Swift twin reports through the kernel's free function
     * `kernelLog` (KernelLog.swift: DEBUG print + KernelLogBuffer capture on armed installs).
     * Until that primitive is ported, this settable handler IS the seam: it defaults to
     * stdout, the host rebinds it to the KernelLog twin at boot
     * (`StackXML.kernelLog = ::kernelLog`), and tests capture it to assert failure behavior.
     * The message shape matches the Swift log line byte-for-byte where the platform allows.
     */
    var kernelLog: (String) -> Unit = { line -> println(line) }

    // Keep the original one-argument JVM method for binary/source compatibility
    // with package code compiled against earlier DSX core releases.
    fun parse(xml: String): StackNode? = parse(xml, null)

    fun parse(xml: String, limits: ParseLimits?): StackNode? {
        val bodies = mutableListOf<String>()            // code-element bodies, lifted out 1:1 before parse
        val d = Delegate(limits)
        var at = ""                                     // " at line L:C" when the parser reports a position
        var reason: String? = null
        try {
            val f = SAXParserFactory.newInstance()
            f.isNamespaceAware = false                  // names stay as written (`on:tap` is a literal
                                                        // attribute name), matching Foundation's default
            // DSX never declares a DOCTYPE; refuse one outright (JVM-side XXE hardening -
            // Foundation never resolves external entities either, and `normalizeEntities`
            // already neutralizes any custom entity reference before the parser sees it).
            runCatching { f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
            val p = f.newSAXParser()
            // CDATA boundaries arrive via the lexical handler (Foundation's foundCDATA analog).
            runCatching { p.setProperty("http://xml.org/sax/properties/lexical-handler", d) }
            p.parse(InputSource(StringReader(normalizeEntities(liftCode(xml, bodies)))), d)
        } catch (e: SAXParseException) {
            at = " at line ${e.lineNumber}:${e.columnNumber}"
            reason = e.message ?: "malformed XML"
        } catch (e: Exception) {
            reason = e.message ?: "malformed XML"
        }
        val root = d.root
        if (reason != null || root == null) {
            // Surface the failure instead of silently rendering an empty surface. Bare `&` (both
            // contexts) and `<` INSIDE attribute values are auto-normalized above, so the classic
            // `&&`-in-`visible-if` trap is gone - what still voids a template is structural:
            // mismatched tags, a stray quote, or a bare `<` in TEXT content (it reads as a tag).
            kernelLog("[Stack] XML parse failed$at — ${reason ?: "malformed XML"}. Check tag pairing/quotes; a bare < in text content must be &lt;. Surface will be empty.")
            return null
        }
        if (bodies.isNotEmpty()) reinject(root, bodies)
        return root
    }

    /**
     * SMART ENTITIES - the HTML5 "ambiguous ampersand" rule, applied to the LIFTED doc before
     * the strict XML parser: a bare `&` that does not begin a real entity reads as a literal
     * ampersand (so `visible-if="a && b"` needs no escaping), and `<` INSIDE a quoted
     * attribute value reads as a literal less-than (`visible-if="n < 3"`). Real entities
     * (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#…;` `&#x…;`) pass through untouched, comments
     * and CDATA are copied verbatim, and a bare `<` in TEXT still needs `&lt;` (it opens a tag -
     * genuinely ambiguous). The linter runs the SAME rule (lint_dsx `normalize_entities`), so
     * what lints is exactly what parses.
     */
    fun normalizeEntities(s: String): String {
        val out = StringBuilder(s.length + 16)
        var i = 0
        var quote: Char? = null     // inside an attribute value, holding its quote char
        var inTag = false           // between an unquoted `<` and its `>`
        // Swift Character.isHexDigit: 0-9 a-f A-F plus the fullwidth compatibility forms.
        fun isHexDigit(ch: Char) = ch in '0'..'9' || ch in 'a'..'f' || ch in 'A'..'F' ||
            ch in '０'..'９' || ch in 'Ａ'..'Ｆ' || ch in 'ａ'..'ｆ'
        fun entityAhead(j: Int): Boolean {              // s[j] == '&' - does a real entity start here?
            var k = j + 1
            val name = StringBuilder()
            while (k < s.length && name.length <= 8 && s[k] != ';') { name.append(s[k]); k += 1 }
            if (k >= s.length || s[k] != ';' || name.isEmpty()) return false
            val n = name.toString()
            if (n in listOf("amp", "lt", "gt", "quot", "apos")) return true
            if (n.startsWith("#x") || n.startsWith("#X")) {
                val digits = n.drop(2)
                return digits.isNotEmpty() && digits.all { isHexDigit(it) }
            }
            if (n.startsWith("#")) {
                val digits = n.drop(1)
                return digits.isNotEmpty() && digits.all { it.isDigit() }
            }
            return false
        }
        while (i < s.length) {
            if (quote == null && s[i] == '<') {         // comments/CDATA verbatim (same guard as liftCode)
                var skipped = false
                for ((open, close) in listOf("<!--" to "-->", "<![CDATA[" to "]]>")) {
                    if (!s.startsWith(open, i)) continue
                    var k = i + open.length
                    while (k + close.length <= s.length && !s.startsWith(close, k)) k += 1
                    val end = if (k + close.length <= s.length) k + close.length else s.length
                    out.append(s, i, end); i = end; skipped = true; break
                }
                if (skipped) continue
            }
            val ch = s[i]
            if (quote != null) {
                if (ch == quote) { quote = null; out.append(ch) }
                else if (ch == '&' && !entityAhead(i)) out.append("&amp;")
                else if (ch == '<') out.append("&lt;")
                else out.append(ch)
            } else if (inTag) {
                if (ch == '"' || ch == '\'') quote = ch
                else if (ch == '>') inTag = false
                out.append(ch)
            } else {
                if (ch == '<') { inTag = true; out.append(ch) }
                else if (ch == '&' && !entityAhead(i)) out.append("&amp;")
                else out.append(ch)
            }
            i += 1
        }
        return out.toString()
    }

    /**
     * Code elements (`<script>`/`<functions>`/`<action>`/`<formula>`/`<variable>`/`<var>`/`<let>`)
     * hold RAW JS. Their bodies are read **1:1** - never interpreted as XML - so `<` / `&&` / `&`
     * (and even a literal `]]>`) need NO escaping and the author never writes `<![CDATA[ … ]]>`.
     * `liftCode` pulls each body out (trimmed) and leaves an XML-safe placeholder, so the XML
     * parser only sees the structure; `reinject` re-attaches the raw bodies to their nodes
     * afterwards. (Inline `on:` ATTRIBUTES are NOT lifted - they don't need to be:
     * `normalizeEntities` makes bare `&`/`&&` and `<` inside attribute values legal as-written.)
     */
    val codeTags: Set<String> = setOf("script", "functions", "action", "formula", "variable", "var", "let")

    private fun liftCode(xml: String, bodies: MutableList<String>): String {
        val out = StringBuilder()
        var i = 0
        fun boundary(ch: Char) = ch == '>' || ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '/'
        while (i < xml.length) {
            if (xml[i] != '<') { out.append(xml[i]); i += 1; continue }
            // XML comments + CDATA are OPAQUE to code-lifting - copy them VERBATIM. A code-tag NAME
            // mentioned inside one (e.g. the literal text "<action>" in a `<!-- … -->` comment) must
            // NOT be lifted: doing so swallows the comment up to the next real `</action>`, voids the
            // whole template's XML, and the surface renders EMPTY (a black screen). The scan below is
            // not XML-aware, so guard these regions here. (Regression: a `<!-- … <action> … -->`
            // comment silently broke a component's parse - lint missed it because it strips comments.)
            var skipped = false
            for ((open, close) in listOf("<!--" to "-->", "<![CDATA[" to "]]>")) {
                if (!xml.startsWith(open, i)) continue
                var k = i + open.length
                while (k + close.length <= xml.length && !xml.startsWith(close, k)) k += 1
                val end = if (k + close.length <= xml.length) k + close.length else xml.length   // unterminated -> copy to end
                out.append(xml, i, end); i = end; skipped = true; break
            }
            if (skipped) continue
            var match: String? = null
            for (t in codeTags) {
                val o = "<$t"
                if (i + o.length < xml.length && xml.startsWith(o, i) && boundary(xml[i + o.length])) { match = t; break }
            }
            if (match == null) { out.append(xml[i]); i += 1; continue }
            var q: Char? = null                                    // copy the open tag through its '>' (quote-aware)
            while (i < xml.length) {
                val ch = xml[i]; out.append(ch); i += 1
                if (q != null) { if (ch == q) q = null }
                else if (ch == '"' || ch == '\'') q = ch
                else if (ch == '>') break
            }
            if (out.endsWith("/>")) continue                       // self-closing - no body
            val close = "</$match>"                                // raw body up to the matching close tag
            var k = i
            var end = xml.length
            while (k + close.length <= xml.length) {
                if (xml.startsWith(close, k)) { end = k; break }
                k += 1
            }
            var body = xml.substring(i, end).trim()                                  // 1:1, just trimmed
            if (body.startsWith("<![CDATA[") && body.endsWith("]]>")) {              // tolerate explicit CDATA
                body = body.substring(9, body.length - 3).trim()
            }
            out.append('\uE000').append(bodies.size).append('\uE000')                // XML-safe placeholder where the body was
            bodies.add(body)
            if (end < xml.length) out.append(xml, end, minOf(end + close.length, xml.length))   // copy the close tag
            i = end + close.length
        }
        return out.toString()
    }

    /**
     * Re-attach each lifted code body to its node (placeholder `\uE000N\uE000` -> `bodies[N]`),
     * walking the parsed tree. (Kotlin nodes are references, so the walk mutates in place -
     * the twin of the Swift `inout` walk over value-type nodes.)
     */
    private fun reinject(node: StackNode, bodies: List<String>) {
        val t = node.text
        if (t != null && t.length > 2 && t.startsWith('\uE000') && t.endsWith('\uE000')) {
            val n = t.substring(1, t.length - 1).toIntOrNull()
            if (n != null && n >= 0 && n < bodies.size) node.text = bodies[n]
        }
        for (child in node.children) reinject(child, bodies)
    }

    private class Delegate(private val limits: ParseLimits?) : DefaultHandler2() {
        var root: StackNode? = null

        // Children/text accumulate on a mutable frame while the element is open; the immutable-ish
        // StackNode is built bottom-up in endElement (Swift mutates value-type nodes on its stack
        // directly - same tree, same order).
        private class Frame(val tag: String, val attrs: Map<String, String>) {
            val children = mutableListOf<StackNode>()
            var text: StringBuilder? = null
            fun append(s: CharSequence) { (text ?: StringBuilder().also { text = it }).append(s) }
        }

        private val stack = mutableListOf<Frame>()
        private var cdata: StringBuilder? = null
        private var nodeCount = 0

        override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes?) {
            val configured = limits
            if (configured != null) {
                if (stack.size + 1 > configured.maximumDepth) {
                    throw SAXException("DSX document exceeds the ${configured.maximumDepth}-level depth limit")
                }
                nodeCount += 1
                if (nodeCount > configured.maximumNodes) {
                    throw SAXException("DSX document exceeds the ${configured.maximumNodes}-node limit")
                }
            }
            val attrs = LinkedHashMap<String, String>()            // document order preserved (a superset
            if (attributes != null) {                              // of the Swift dictionary's contract)
                for (i in 0 until attributes.length) attrs[attributes.getQName(i)] = attributes.getValue(i)
            }
            stack.add(Frame(if (qName.isNullOrEmpty()) localName ?: "" else qName, attrs))
        }

        override fun characters(ch: CharArray, start: Int, length: Int) {
            // Accumulate RAW - do NOT trim per chunk. SAX delivers a text node in MULTIPLE
            // characters() calls, split around entities (`&amp;` -> a separate "&" chunk) and at
            // arbitrary buffer boundaries. Trimming each chunk ate the space adjacent to the split -
            // "key &amp; tunes" rendered "key&tunes", "note — naturally" rendered "note— naturally".
            // We assemble the whole node here and trim leading/trailing ONCE in endElement (which
            // still drops the pretty-print indentation between child elements, but keeps inner spaces).
            val cd = cdata
            if (cd != null) { cd.append(ch, start, length); return }   // CDATA content routes to its block buffer
            if (stack.isEmpty()) return
            stack[stack.size - 1].append(String(ch, start, length))
        }

        // CDATA - raw text the XML parser does NOT interpret. The clean way to embed code
        // (`<script>`, `<formula>`, `<action>`) so JS `<` / `&&` / `&` need no XML escaping:
        // `<script><![CDATA[ if (a < b && c) … ]]></script>`. (Only `]]>` can't appear inside.)
        // Foundation delivers the whole block in one foundCDATA callback; SAX streams its content
        // through characters() BETWEEN startCDATA/endCDATA, so buffer here and apply the SAME
        // per-block trim on endCDATA. Without this the block would blend into surrounding text
        // with different whitespace than the Swift parser produces.
        override fun startCDATA() { cdata = StringBuilder() }
        override fun endCDATA() {
            val t = cdata?.toString()?.trim() ?: ""
            cdata = null
            if (t.isEmpty() || stack.isEmpty()) return
            stack[stack.size - 1].append(t)
        }

        override fun endElement(uri: String?, localName: String?, qName: String?) {
            if (stack.isEmpty()) return
            val f = stack.removeAt(stack.size - 1)
            // Trim the assembled text ONCE: drops the pretty-print indentation a container collects
            // between its children (whitespace-only -> null), while preserving every inner space of a
            // real text node (including those next to `&amp;` / em-dashes split across chunks above).
            val trimmed = f.text?.toString()?.trim()
            val node = StackNode(f.tag, f.attrs, f.children, if (trimmed.isNullOrEmpty()) null else trimmed)
            if (stack.isEmpty()) root = node else stack[stack.size - 1].children.add(node)
        }
    }
}
