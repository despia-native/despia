package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The calendar conformance runner - executes
 * OpenSource/Conformance/calendar/{crud,present,recurrence}.json through THIS runtime's
 * CalendarCore folds (parity F12). The TS twin (@despia/kernel calendar-core.ts,
 * calendar-conformance.test.ts) and the Swift reference (CalendarConformance) run the SAME
 * files, so the `futureEvents` blast radius, the iOS 17 writeOnly split, the editor
 * result-fidelity ladder and an RRULE round-trip cannot drift between renderers.
 *
 * Missing corpus = loud failure, and so is an empty section.
 */
class CalendarConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/calendar/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/calendar/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(root: Map<String, Any?>, name: String, file: String): List<Map<String, Any?>> {
        val raw = root[name]
        val rows = (raw as? List<Any?>) ?: ((raw as? Map<String, Any?>)?.get("cases") as? List<Any?>)
        val cases = rows?.map { it as Map<String, Any?> }
        assertTrue(cases != null && cases.isNotEmpty(), "$file: $name must be a non-empty case array")
        return cases!!
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun spanDecisionAgreesWithCorpus() {
        for (case in section(root("crud.json"), "span", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            assertEquals(
                (case["expect"] as Map<String, Any?>)["scope"],
                CalendarCore.span(given["recurring"] == true, given["futureEvents"] as? Boolean),
                "$name: scope",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun dateGrammarAgreesWithCorpus() {
        for (case in section(root("crud.json"), "dates", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val input = case["input"]
            val expect = case["expect"] as Map<String, Any?>

            if (input is Map<*, *>) {
                val window = CalendarCore.window(input["start"], input["end"])
                assertEquals(expect["error"] as String?, if (window == null) "invalid_date" else null,
                             "$name: window")
                continue
            }
            val epoch = CalendarCore.parseDate(input)
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertNull(epoch, "$name: expected $expectedError")
                continue
            }
            assertEquals((expect["epoch"] as Number).toDouble(), epoch, "$name: epoch")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun accessSplitAgreesWithCorpus() {
        for (case in section(root("crud.json"), "access", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val decision = CalendarCore.accessDecision(given["access"] as? String, given["action"] as String)

            assertEquals(expect["runs"], decision.runs, "$name: runs")
            if (expect.containsKey("prompted")) {
                assertEquals(expect["prompted"], decision.prompted, "$name: prompted")
            }
            assertEquals(expect["error"] as String?, decision.error, "$name: error")
            if (expect.containsKey("messageNames")) {
                val names = (expect["messageNames"] as String).lowercase()
                assertTrue(decision.message.orEmpty().lowercase().contains(names),
                           "$name: the refusal must name $names, got ${decision.message}")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun calendarTargetsAgreeWithCorpus() {
        for (case in section(root("crud.json"), "calendars", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val decision = CalendarCore.targetDecision(
                calendarId = given["calendarId"] as? String,
                exists = given["exists"] as? Boolean,
                writable = given["writable"] as? Boolean,
                hasDefault = given["hasDefault"] as? Boolean,
            )
            assertEquals(expect["runs"], decision.runs, "$name: runs")
            assertEquals(expect["error"] as String?, decision.error, "$name: error")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun remindersAbsenceAgreesWithCorpus() {
        for (case in section(root("crud.json"), "reminders", "crud.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>
            val support = CalendarCore.remindersSupport(given["renderer"] as String)
            assertEquals(expect["supported"], support.supported, "$name: supported")
            assertEquals(expect["error"] as String?, support.error, "$name: error")
            if (expect.containsKey("remindersAccess")) {
                assertEquals(expect["remindersAccess"] as String?, support.remindersAccess,
                             "$name: remindersAccess")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun presentPermissionSurfaceAgreesWithCorpus() {
        val surface = root("present.json")["permissionSurface"] as Map<String, Any?>
        val declared = surface.filterKeys { !it.startsWith("_") }
        assertTrue(declared.isNotEmpty(), "present.json: permissionSurface names no actions")
        for ((action, grant) in declared) {
            assertEquals(grant, CalendarCore.PERMISSION_SURFACE[action], "permissionSurface: $action")
        }
        for (action in CalendarCore.PERMISSION_SURFACE.keys) {
            assertTrue(surface.containsKey(action), "permissionSurface: the corpus does not pin $action")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun resultFidelityAgreesWithCorpus() {
        val fidelity = root("present.json")["resultFidelity"] as Map<String, Any?>
        val declared = fidelity.filterKeys { !it.startsWith("_") }
        assertTrue(declared.isNotEmpty(), "present.json: resultFidelity names no renderers")
        for ((renderer, results) in declared) {
            assertEquals((results as List<Any?>).map { it as String },
                         CalendarCore.RESULT_FIDELITY[renderer], "resultFidelity: $renderer")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun presentOutcomeAgreesWithCorpus() {
        val doc = root("present.json")
        val fidelity = doc["resultFidelity"] as Map<String, Any?>
        for (case in section(doc, "cases", "present.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val given = case["given"] as Map<String, Any?>
            val expect = case["expect"] as Map<String, Any?>

            val outcome = CalendarCore.presentOutcome(
                access = given["access"] as? String,
                editorAction = given["editorAction"] as? String,
                eventFound = given["eventFound"] as? Boolean,
                id = given["id"] as? String,
                start = given["start"],
                end = given["end"],
                hasWindow = given.containsKey("start") || given.containsKey("end"),
            )

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertEquals(expectedError, outcome.error, "$name: error")
                assertEquals(expect["presented"] ?: false, outcome.presented, "$name: presented")
                continue
            }
            assertNull(outcome.error, "$name: error")
            assertEquals(expect["result"], outcome.result, "$name: result")
            if (expect.containsKey("hasId")) assertEquals(expect["hasId"], outcome.hasId, "$name: hasId")
            if (expect.containsKey("broadcast")) {
                assertEquals(expect["broadcast"] as String?, outcome.broadcast, "$name: broadcast")
            }
            val allowed = (fidelity[given["renderer"] as String] as List<Any?>).map { it as String }
            assertTrue(outcome.result in allowed,
                       "$name: ${outcome.result} is outside ${given["renderer"]}'s fidelity list")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun recurrenceRoundTripAgreesWithCorpus() {
        for (case in section(root("recurrence.json"), "roundTrip", "recurrence.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val rule = CalendarCore.parseRecurrence(case["rrule"] as String)
            assertNotNull(rule, "$name: expected a parsed rule")

            val parsed = case["parsed"] as Map<String, Any?>
            assertEquals(parsed["freq"], rule.freq, "$name: freq")
            assertEquals((parsed["interval"] as Number).toInt(), rule.interval, "$name: interval")
            if (parsed.containsKey("count")) {
                assertEquals((parsed["count"] as Number).toInt(), rule.count, "$name: count")
            }
            if (parsed.containsKey("until")) {
                assertEquals(parsed["until"], rule.until, "$name: until")
            }
            if (parsed.containsKey("byDay")) {
                val expected = (parsed["byDay"] as List<Any?>).map {
                    val row = it as Map<String, Any?>
                    RecurrenceDay(row["day"] as String, (row["ordinal"] as Number).toInt())
                }
                assertEquals(expected, rule.byDay, "$name: byDay")
            }
            if (parsed.containsKey("byMonthDay")) {
                assertEquals((parsed["byMonthDay"] as List<Any?>).map { (it as Number).toInt() },
                             rule.byMonthDay, "$name: byMonthDay")
            }
            if (parsed.containsKey("byMonth")) {
                assertEquals((parsed["byMonth"] as List<Any?>).map { (it as Number).toInt() },
                             rule.byMonth, "$name: byMonth")
            }
            assertEquals(case["canonical"], CalendarCore.formatRecurrence(rule), "$name: canonical")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun rejectedRecurrenceIsRefusedLoudly() {
        for (case in section(root("recurrence.json"), "rejected", "recurrence.json")) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertNull(CalendarCore.parseRecurrence(case["rrule"] as String), "$name: must not parse")
            assertEquals("invalid_recurrence", case["error"], "$name: error code")
        }
    }
}
