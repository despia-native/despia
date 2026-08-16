package despia.engine

//
//  StackDiagnostics.kt — the kernel's structured parse-issue ledger, the Diagnostics.swift
//  ledger half (Stack.swift's recordParseFailure sites → DSXIssue records → the render
//  layer's diagnostic cards + the dev drawer's report). The failure philosophy this kills
//  is "log it and render empty": a component whose markup fails to parse registers as
//  NOTHING, and every push of it renders a silent blank — on a side-loaded test build with
//  no logcat attached, QA then debugs a black rectangle.
//
//  What this file owns (pure JVM — the paint half is :render's StackDiagnosticCard):
//    · DsxIssue — the structured issue: component, the parser's reason, the exact
//      line:column, a source EXCERPT with the offending line marked, a plain-language hint.
//    · the ledger — recordParseFailure at the registration seam (the generated
//      StackComponents.register()), issues/issueCount, failedToParse/flagsUnresolved (the
//      two card gates, both fail-closed to production via AppEnvironment.isTest).
//    · report() — the copyable diagnostics dump (issues + error ledger + dsx.log ring +
//      kernel-log tail), the dev drawer's Copy-all body.
//
//  DIVERGENCES from the Swift twin (pinned, none silent):
//    · No AUTO-PRESENT arm: iOS pops its DevOverlay-window panel when an issue lands;
//      Android has no dev overlay window — the in-place card IS the surfacing (it renders
//      exactly where the dead component was used, tap → the issues panel dialog), and the
//      DevSettings drawer's Console already tails the kernelLog line this records.
//    · report() carries the channel but no app-identity header line (:core has no Bundle
//      access — DSXApp identity is a :platform concern on Android, State.kt header).
//

/// One line of a source excerpt (code-editor style: gutter number + text + error marker).
data class DsxIssueLine(val no: Int, val text: String, val isError: Boolean)

/// One recorded issue — everything a tester needs to fix the markup without a console.
data class DsxIssue(
    val id: Int,
    val component: String,       // "demo.Launcher"
    val reason: String,          // the parser's error, e.g. "not well-formed (invalid token)"
    val line: Int,               // 1-based; 0 = unknown
    val column: Int,
    val excerpt: List<DsxIssueLine>,
    val hint: String,
) {
    val headline: String get() = "$component — failed to parse"
    val location: String get() = if (line > 0) "line $line, column $column" else "location unknown"

    /// The plain-text form (the copy/share report's body). Plain ASCII markers so the
    /// export pastes cleanly anywhere (issue trackers, terminals, mail).
    val text: String
        get() {
            val out = mutableListOf("[error] $headline ($location)", "  reason: $reason")
            for (l in excerpt) out.add("  ${if (l.isError) ">" else " "} ${l.no} | ${l.text}")
            out.add("  hint: $hint")
            return out.joined()
        }
}

private fun List<String>.joined(): String = joinToString("\n")

object StackDiagnostics {

    private val lock = Any()
    private val issueList = mutableListOf<DsxIssue>()
    private val failedNames = mutableSetOf<String>()
    private var issueSeq = 0

    /// Parse a component template for registration, recording a failure as a structured
    /// issue — THE seam the generated StackComponents.register() calls in place of a bare
    /// StackXML.parse (module-internal inline parses keep the plain kernelLog line, like
    /// the Swift bootstrap sites).
    fun parseComponent(name: String, scope: String?, xml: String): StackNode? {
        val node = StackXML.parse(xml)
        if (node == null) recordParseFailure(name, scope ?: "", xml)
        return node
    }

    /// Record a template that FAILED TO PARSE (it registers as nothing — every use renders
    /// empty). Re-parses the LINE-STABLE lifted source to capture the exact line:column and
    /// reason (the runtime's own liftCode is placeholder-based — fine for rendering, wrong
    /// for locating errors), cuts the excerpt from the ORIGINAL source, maps a hint, and
    /// kernelLogs a summary. Recording is unconditional; VISIBILITY is what the test-channel
    /// gates below control (the Swift split exactly).
    fun recordParseFailure(name: String, scope: String, xml: String) {
        val component = if (scope.isEmpty()) name else "$scope.$name"
        val (line, column, reason) = parseError(lineStableLift(xml))
        val issue: DsxIssue
        synchronized(lock) {
            issueSeq += 1
            issue = DsxIssue(issueSeq, component, reason, line, column,
                             excerpt(xml, line), hint(reason))
            issueList.add(issue)
            failedNames.add(name)
            failedNames.add(component)
        }
        kernelLog("[Stack] $component FAILED TO PARSE at ${issue.location} — $reason; not registered, every <$name/> renders empty")
    }

    /// All recorded issues, oldest first.
    val issues: List<DsxIssue> get() = synchronized(lock) { ArrayList(issueList) }

    /// The recorded parse-issue count — the dev drawer's escalation banner reads this
    /// (public: dev tooling lives in a module, the ledger in the kernel).
    val issueCount: Int get() = issues.size

    /// Did THIS tag's template fail to parse? (Distinct from "never shipped" — the dynamic
    /// `<node tag=…/>` capability boundary is legitimate fail-open and must stay silent;
    /// only a KNOWN-dead registration earns the card there.)
    fun failedToParse(tag: String): Boolean {
        if (!AppEnvironment.current.isTest) return false
        synchronized(lock) {
            if (failedNames.contains(tag)) return true
            val dot = tag.lastIndexOf('.')
            return dot >= 0 && failedNames.contains(tag.substring(dot + 1))
        }
    }

    /// Should an unresolved LITERAL component reference show the card? Any Capitalized or
    /// dotted tag that resolved to nothing is an authoring error (typo / parse failure /
    /// missing registration) — on test channels that must be visible, never a silent blank.
    fun flagsUnresolved(tag: String): Boolean {
        if (!AppEnvironment.current.isTest) return false
        return tag.firstOrNull()?.isUpperCase() == true || tag.contains('.')
    }

    /// TEST SEAM: the ledger is process-global; suites that record issues reset it so
    /// ordering between tests cannot leak (the simulatedChannel reset precedent).
    fun resetForTest() {
        synchronized(lock) {
            issueList.clear()
            failedNames.clear()
            issueSeq = 0
        }
    }

    /// The full copyable report: channel + every issue (with excerpt + hint) + the error
    /// ledger + the dsx.log ring + the kernel-log tail — the dev drawer's Copy-all body.
    fun report(): String {
        val out = mutableListOf<String>()
        out.add("DSX diagnostics — channel: ${AppEnvironment.current.rawValue}")
        val list = issues
        out.add("")
        out.add("── issues (${list.size}) ──")
        out.add(if (list.isEmpty()) "none — every shipped template parsed and registered"
                else list.joinToString("\n\n") { it.text })
        out.add("")
        val errors = DSXErrorLedger.shared.recent()
        out.add("── recent errors (${errors.size} retained · ${DSXErrorLedger.shared.count()} total) ──")
        out.add(if (errors.isEmpty()) "none — the error ledger is empty"
                else errors.joinToString("\n") { e ->
                    buildString {
                        append("[${e.origin}] ${e.scheme} → ${e.code}")
                        e.message?.let { append(" — $it") }
                        if (e.recoverable) append(" (recoverable)")
                        if (e.delivered == false) append(" (fire-and-forget — never reached the call site)")
                    }
                })
        out.add("")
        val logLines = DSXLogBuffer.shared.recent()
        out.add("── dsx.log ring (${logLines.size} retained · ${DSXLogBuffer.shared.count()} total · newest last) ──")
        out.add(if (logLines.isEmpty()) "empty"
                else logLines.joinToString("\n") { "[${it.level}] ${it.scheme}: ${it.message}" })
        out.add("")
        out.add("── kernel log (newest last; includes [dsx.log] lines) ──")
        val tail = KernelLogBuffer.shared.snapshot()
        out.add(if (tail.isEmpty()) "empty" else tail.joined())
        return out.joined()
    }

    // MARK: parse-error introspection (code-editor context)

    /// Blank comments + code-element bodies LINE-STABLY (every non-newline char → space),
    /// so a strict re-parse reports SOURCE-TRUE line numbers (raw JS in <script>/<action>
    /// bodies never trips it, and the excerpt lines up with the file the author edits).
    /// Mirrors lint_dsx.rb's lift and the Swift lineStableLift byte-for-byte.
    internal fun lineStableLift(xml: String): String {
        var s = blank(xml, Regex("<!--[\\s\\S]*?-->"), 0)
        s = blank(s, Regex("<(script|action|formula|variable|var|let)\\b[^>]*?>([\\s\\S]*?)</\\1>"), 2)
        return s
    }

    private fun blank(s: String, re: Regex, group: Int): String {
        val out = StringBuilder(s)
        // Reversed, so earlier ranges stay valid as later ones are replaced (the Swift loop).
        for (m in re.findAll(s).toList().asReversed()) {
            val r = m.groups[group]?.range ?: continue
            if (r.isEmpty()) continue
            for (i in r) if (out[i] != '\n') out.setCharAt(i, ' ')
        }
        return out.toString()
    }

    /// Strict-parse and return (line, column, reason) of the first error. The JVM SAX
    /// parser reports positions directly (the Swift twin reads XMLParser.lineNumber).
    private fun parseError(lifted: String): Triple<Int, Int, String> {
        try {
            val f = javax.xml.parsers.SAXParserFactory.newInstance()
            f.isNamespaceAware = false
            runCatching { f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
            f.newSAXParser().parse(
                org.xml.sax.InputSource(java.io.StringReader(lifted)),
                org.xml.sax.helpers.DefaultHandler(),
            )
        } catch (e: org.xml.sax.SAXParseException) {
            return Triple(e.lineNumber, e.columnNumber, e.message ?: "malformed XML")
        } catch (e: Exception) {
            return Triple(0, 0, e.message ?: "malformed XML")
        }
        return Triple(0, 0, "malformed XML")
    }

    /// The offending line ± 2 from the ORIGINAL source, error line marked. Long lines are
    /// clipped (the panel shows the gutter number, so the author finds the exact spot).
    internal fun excerpt(xml: String, line: Int): List<DsxIssueLine> {
        if (line <= 0) return emptyList()
        val lines = xml.split("\n")
        if (lines.isEmpty()) return emptyList()
        val idx = (line - 1).coerceIn(0, lines.size - 1)
        val lo = (idx - 2).coerceAtLeast(0)
        val hi = (idx + 2).coerceAtMost(lines.size - 1)
        return (lo..hi).map { i -> DsxIssueLine(i + 1, lines[i].take(300), i == idx) }
    }

    /// The plain-language explanation for the parser's reason — the "what did I do wrong".
    internal fun hint(reason: String): String {
        val r = reason.lowercase()
        if (r.contains("not well-formed") || r.contains("invalid token") || r.contains("invalid character")) {
            return "Usually an unescaped character in an attribute or text: write &amp; for &, &lt; for <, and &quot; for a quote inside a double-quoted attribute (never a C-style \\\")."
        }
        if (r.contains("attribute")) {
            return "Attribute syntax is name=\"value\" — check for a missing =, an unescaped quote inside the value, or the same attribute written twice on one tag."
        }
        // "must be terminated" / "end-tag" are the JVM (Xerces) phrasings of Foundation's
        // "tag mismatch" — same family, same fix.
        if (r.contains("mismatch") || r.contains("tag") || r.contains("must be terminated")) {
            return "Open and close tags must match exactly — check for an unclosed element, a stray </…>, or a self-closing tag written without the trailing /."
        }
        if (r.contains("entit")) {
            return "Unknown entity — only &amp; &lt; &gt; &quot; &apos; are predefined; a bare & must be written &amp;."
        }
        return "Run the CI linter locally for the same verdict: ruby ClosedSource/scripts/lint_dsx.rb --strict"
    }
}
