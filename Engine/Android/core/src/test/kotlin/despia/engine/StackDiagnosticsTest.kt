package despia.engine

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

//
//  Pins the StackDiagnostics ledger — the Diagnostics.swift kernel half: a parse-failed
//  registration becomes a STRUCTURED issue (component · reason · source-true line:column ·
//  excerpt with the offending line marked · plain-language hint), the two card gates
//  (failedToParse / flagsUnresolved) answer true only on TEST channels, and the report
//  carries every issue in the exact plain-ASCII export shape.
//
class StackDiagnosticsTest {

    @BeforeEach
    fun arm() {
        KernelLog.enabled = true                    // the simulatedChannel seam requires it
        AppEnvironment.simulatedChannel = AppEnvironment.debug
        StackDiagnostics.resetForTest()
    }

    @AfterEach
    fun disarm() {
        AppEnvironment.simulatedChannel = null
        KernelLog.enabled = false
        StackDiagnostics.resetForTest()
    }

    private val badXml = "<stack>\n  <text value=\"ok\"/>\n  <button label=\"x\">\n</stack>"

    @Test
    fun aParseFailureRecordsAStructuredIssueWithSourceTruePosition() {
        assertNull(StackDiagnostics.parseComponent("Launcher", "demo", badXml))
        assertEquals(1, StackDiagnostics.issueCount)
        val issue = StackDiagnostics.issues.single()
        assertEquals("demo.Launcher", issue.component)
        assertEquals("demo.Launcher — failed to parse", issue.headline)
        assertTrue(issue.line > 0)                          // SAX reports the mismatch position
        assertTrue(issue.location.startsWith("line "))
        assertTrue(issue.reason.isNotEmpty())
        assertTrue(issue.excerpt.isNotEmpty())
        assertEquals(1, issue.excerpt.count { it.isError })
        assertTrue(issue.hint.isNotEmpty())
    }

    @Test
    fun aHealthyTemplateRecordsNothing() {
        assertNotNull(StackDiagnostics.parseComponent("Fine", null, "<stack><text value=\"ok\"/></stack>"))
        assertEquals(0, StackDiagnostics.issueCount)
    }

    @Test
    fun failedToParseMatchesTheBareNameTheScopedNameAndTheDotSuffix() {
        StackDiagnostics.recordParseFailure("Launcher", "demo", badXml)
        assertTrue(StackDiagnostics.failedToParse("Launcher"))
        assertTrue(StackDiagnostics.failedToParse("demo.Launcher"))
        assertTrue(StackDiagnostics.failedToParse("other.Launcher"))   // the dot-suffix arm
        assertFalse(StackDiagnostics.failedToParse("Other"))
    }

    @Test
    fun bothGatesFailClosedToProduction() {
        StackDiagnostics.recordParseFailure("Launcher", "demo", badXml)
        AppEnvironment.simulatedChannel = AppEnvironment.appstore
        assertFalse(StackDiagnostics.failedToParse("Launcher"))
        assertFalse(StackDiagnostics.flagsUnresolved("Launcher"))
        AppEnvironment.simulatedChannel = AppEnvironment.debug
        assertTrue(StackDiagnostics.failedToParse("Launcher"))
    }

    @Test
    fun flagsUnresolvedWantsCapitalizedOrDottedTagsOnly() {
        assertTrue(StackDiagnostics.flagsUnresolved("Launcher"))
        assertTrue(StackDiagnostics.flagsUnresolved("demo.launcher"))
        assertFalse(StackDiagnostics.flagsUnresolved("vstack"))        // a plain unknown tag stays
        assertFalse(StackDiagnostics.flagsUnresolved(""))              // Article-7 fail-open
    }

    @Test
    fun theExcerptMarksTheOffendingLinePlusMinusTwoClippedTo300() {
        val xml = (1..9).joinToString("\n") { "line $it ${"x".repeat(400)}" }
        val cut = StackDiagnostics.excerpt(xml, 5)
        assertEquals(listOf(3, 4, 5, 6, 7), cut.map { it.no })
        assertEquals(listOf(false, false, true, false, false), cut.map { it.isError })
        assertTrue(cut.all { it.text.length <= 300 })
        assertTrue(StackDiagnostics.excerpt(xml, 0).isEmpty())         // unknown location
    }

    @Test
    fun theIssueTextIsTheExactExportShape() {
        StackDiagnostics.recordParseFailure("Card", "", "<stack>\n<oops>\n</stack>")
        val text = StackDiagnostics.issues.single().text
        assertTrue(text.startsWith("[error] Card — failed to parse (line "))
        assertTrue(text.contains("\n  reason: "))
        assertTrue(text.contains("\n  hint: "))
        assertTrue(text.lines().any { it.startsWith("  > ") })         // the marked line
    }

    @Test
    fun hintsMapTheParserReasonFamilies() {
        assertTrue(StackDiagnostics.hint("The element type \"button\" must be terminated")
            .contains("Open and close tags"))
        assertTrue(StackDiagnostics.hint("Attribute name X must be followed by =")
            .contains("name=\"value\""))
        assertTrue(StackDiagnostics.hint("The entity \"nbsp\" was referenced")
            .contains("&amp;"))
        assertTrue(StackDiagnostics.hint("something else entirely")
            .contains("lint_dsx.rb"))
    }

    @Test
    fun lineStableLiftKeepsEveryLineNumber() {
        val xml = "<stack>\n<script>\nlet a = 1 < 2 && b;\n</script>\n<!-- a <action> word -->\n<text/>\n</stack>"
        val lifted = StackDiagnostics.lineStableLift(xml)
        assertEquals(xml.count { it == '\n' }, lifted.count { it == '\n' })
        assertFalse(lifted.contains("let a"))               // the body is blanked…
        assertFalse(lifted.contains("<action>"))            // …and so is the comment's inside
    }

    @Test
    fun theReportCarriesTheIssuesSection() {
        StackDiagnostics.recordParseFailure("Launcher", "demo", badXml)
        val report = StackDiagnostics.report()
        assertTrue(report.startsWith("DSX diagnostics — channel: debug"))
        assertTrue(report.contains("── issues (1) ──"))
        assertTrue(report.contains("demo.Launcher — failed to parse"))
        assertTrue(report.contains("── kernel log"))
    }
}
