package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The U08 forms conformance runner - executes
 * OpenSource/Conformance/forms/{mask,countries,phone,daterange,validation,composites}.json
 * through THIS runtime's Forms core (parity/U08-forms.md). The TS reference
 * (packages/kernel/test/forms-conformance.test.ts) and the Swift twin (record lane,
 * FormsConformance.swift) run the SAME files, so "where is the caret after an edit in the
 * middle of a masked value" cannot have three answers, a phone number cannot be E.164 on one
 * renderer and national on the next, and a double-tapped submit cannot be blocked on two
 * platforms and armed on the third.
 *
 * Missing corpus = loud failure: a silently-skipped conformance suite is how drift starts.
 */
class FormsConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/forms")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/forms not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(name: String): Map<String, Any?> {
        val file = File(corpusDir(), "$name.json")
        assertTrue(file.isFile, "$name.json missing")
        return json(file.readText()).foundationValue as? Map<String, Any?>
            ?: error("$name.json: not a JSON object")
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(name: String, section: String): List<Map<String, Any?>> {
        val list = doc(name)[section] as? List<Map<String, Any?>> ?: error("$name.json: no $section[]")
        assertTrue(list.isNotEmpty(), "$name.$section must not be empty")
        return list
    }

    private fun int(value: Any?): Int = (value as Number).toInt()

    private fun str(value: Any?): String = value as? String ?: ""

    @Suppress("UNCHECKED_CAST")
    private fun strings(value: Any?): List<String> =
        (value as? List<Any?> ?: emptyList()).map { it as String }

    // ── countries.json - ONE table, asserted row for row against the shipped literal ──────

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theKernelTableIsTheCorpusTable() {
        val root = doc("countries")
        assertEquals(root["default"], Forms.DEFAULT_COUNTRY, "default country")
        val wanted = root["countries"] as List<Map<String, Any?>>
        assertEquals(wanted.size, Forms.COUNTRIES.size, "country count")
        assertTrue(Forms.COUNTRIES.size >= 60, "the country table is suspiciously small")
        wanted.forEachIndexed { index, want ->
            val got = Forms.COUNTRIES[index]
            val label = "country row $index (${want["iso"]})"
            assertEquals(want["iso"], got.iso, "$label: iso")
            assertEquals(want["name"], got.name, "$label: name")
            assertEquals(want["dial"], got.dial, "$label: dial")
            assertEquals(want["trunk"], got.trunk, "$label: trunk")
            assertEquals(int(want["nsnMin"]), got.nsnMin, "$label: nsnMin")
            assertEquals(int(want["nsnMax"]), got.nsnMax, "$label: nsnMax")
            assertEquals(want["format"], got.format, "$label: format")
            assertEquals(want["primary"], got.primary, "$label: primary")
        }
    }

    @Test
    fun aNationalFormatNeverTruncatesALegalNumber() {
        for (row in Forms.COUNTRIES) {
            val format = row.format ?: continue
            assertEquals(row.nsnMin, row.nsnMax, "${row.iso}: a format needs a fixed NSN length")
            assertEquals(row.nsnMin, Forms.maskCapacity(format), "${row.iso}: format capacity != NSN length")
        }
    }

    @Test
    fun everyIsoIsUniqueAndResolvable() {
        val seen = HashSet<String>()
        for (row in Forms.COUNTRIES) {
            assertTrue(seen.add(row.iso), "duplicate ISO ${row.iso}")
            assertEquals(row.dial, Forms.country(row.iso)?.dial, "${row.iso}: uppercase lookup")
            assertEquals(row.dial, Forms.country(row.iso.lowercase())?.dial, "${row.iso}: lowercase lookup")
        }
    }

    // ── mask.json ─────────────────────────────────────────────────────────────────────────

    @Test
    fun maskCapacityAndDescriptionAgreeWithCorpus() {
        for (case in rows("mask", "capacity")) {
            val mask = str(case["mask"])
            assertEquals(int(case["capacity"]), Forms.maskCapacity(mask), "capacity of \"$mask\"")
            assertEquals(case["description"], Forms.maskDescription(mask), "description of \"$mask\"")
        }
    }

    @Test
    fun maskFormatAgreesWithCorpus() {
        for (case in rows("mask", "format")) {
            val mask = str(case["mask"])
            val raw = str(case["raw"])
            val display = Forms.maskFormat(mask, raw)
            assertEquals(case["display"], display, "format \"$mask\" <- \"$raw\"")
            assertEquals(case["extract"], Forms.maskExtract(mask, display), "extract of the display")
        }
    }

    @Test
    fun maskExtractAgreesWithCorpus() {
        for (case in rows("mask", "extract")) {
            val mask = str(case["mask"])
            val text = str(case["text"])
            assertEquals(case["raw"], Forms.maskExtract(mask, text), "extract \"$mask\" <- \"$text\"")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theCaretLawAgreesWithCorpus() {
        val cases = rows("mask", "edits")
        assertTrue(cases.size >= 20, "forms/mask edits corpus is suspiciously small")
        for (case in cases) {
            val name = str(case["name"])
            val mask = str(case["mask"])
            val got = Forms.maskEdit(
                mask, str(case["prev"]), int(case["selStart"]), int(case["selEnd"]), str(case["insert"]),
            )
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["display"], got.display, "$name: display")
            assertEquals(int(expect["caret"]), got.caret, "$name: caret")
            assertEquals(expect["raw"], got.raw, "$name: raw")
            assertEquals(expect["complete"], got.complete, "$name: complete")
            // THE PLACEMENT LAW: bind can never hold a character the field does not show.
            assertEquals(got.raw, Forms.maskExtract(mask, got.display), "$name: display and raw disagree")
        }
    }

    // ── phone.json ────────────────────────────────────────────────────────────────────────

    @Test
    fun theFlagIsAPureFunctionOfTheIsoCode() {
        for (case in rows("phone", "flags")) {
            val iso = str(case["iso"])
            assertEquals(case["flag"], Forms.flag(iso), "flag $iso")
        }
        assertEquals("", Forms.flag("USA"), "a three-letter code is not an ISO alpha-2")
        assertEquals("", Forms.flag(""), "the empty code has no flag")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun e164ParsingAgreesWithCorpus() {
        val cases = rows("phone", "parse")
        assertTrue(cases.size >= 30, "forms/phone parse corpus is suspiciously small")
        for (case in cases) {
            val input = str(case["input"])
            val label = "\"$input\" @ ${case["defaultCountry"] ?: "-"}"
            val got = Forms.phoneParse(input, case["defaultCountry"] as? String)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["e164"], got.e164, "$label: e164")
            assertEquals(expect["national"], got.national, "$label: national")
            assertEquals(expect["country"], got.country, "$label: country")
            assertEquals(expect["dialCode"], got.dialCode, "$label: dialCode")
            assertEquals(expect["nsn"], got.nsn, "$label: nsn")
            assertEquals(expect["valid"], got.valid, "$label: valid")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun aValidParseRoundTripsThroughItsOwnE164() {
        for (case in rows("phone", "parse")) {
            val expect = case["expect"] as Map<String, Any?>
            if (expect["valid"] != true) continue
            val e164 = str(expect["e164"])
            val again = Forms.phoneParse(e164, null)
            assertEquals(e164, again.e164, "${case["input"]} did not round-trip")
            assertTrue(again.valid, "${case["input"]} lost validity on round-trip")
        }
    }

    // ── daterange.json ────────────────────────────────────────────────────────────────────

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theMonthGridAgreesWithCorpus() {
        for (case in rows("daterange", "grid")) {
            val year = int(case["year"])
            val month = int(case["month"])
            val got = Forms.monthGrid(year, month, int(case["firstWeekday"]))
            val expect = case["expect"] as Map<String, Any?>
            val label = "$year-$month fw${case["firstWeekday"]}"
            assertEquals(int(expect["days"]), got.days, "$label: days")
            assertEquals(int(expect["leading"]), got.leading, "$label: leading")
            assertEquals(int(expect["weeks"]), got.weeks, "$label: weeks")
        }
    }

    @Test
    fun civilDayNumbersAgreeWithCorpusAndRoundTrip() {
        for (case in rows("daterange", "dayNumbers")) {
            val date = str(case["date"])
            val day = case["day"]
            if (day == null) {
                assertNull(Forms.dayNumber(date), "$date must not resolve")
                continue
            }
            assertEquals(int(day), Forms.dayNumber(date), "dayNumber $date")
            assertEquals(date, Forms.dateFromDay(int(day)), "dateFromDay ${int(day)}")
        }
    }

    @Test
    fun aDstTransitionDayIsExactlyOneDayLong() {
        for (case in rows("daterange", "dstAdjacency")) {
            val from = Forms.dayNumber(str(case["from"])) ?: error("bad from")
            val to = Forms.dayNumber(str(case["to"])) ?: error("bad to")
            assertEquals(int(case["delta"]), to - from, "${case["from"]} -> ${case["to"]}")
            assertEquals(case["next"], Forms.dateFromDay(from + 1), "the day after ${case["from"]}")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun selectabilityAgreesWithCorpus() {
        for (case in rows("daterange", "selectable")) {
            val config = foldConfig(case["config"] as? Map<String, Any?> ?: emptyMap())
            val date = str(case["date"])
            val got = Forms.selectable(config, date)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["ok"], got.ok, "selectable $date: ok")
            assertEquals(expect["reason"], got.reason, "selectable $date: reason")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun foldConfig(raw: Map<String, Any?>): Forms.DateFoldConfig = Forms.DateFoldConfig(
        range = raw["range"] == true,
        min = raw["min"] as? String,
        max = raw["max"] as? String,
        disabledDates = strings(raw["disabledDates"]),
        start = raw["start"] as? String,
        end = raw["end"] as? String,
        month = raw["month"] as? String ?: "",
    )

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theRangeFoldAgreesWithCorpus() {
        val folds = rows("daterange", "folds")
        assertTrue(folds.size >= 10, "forms/daterange fold corpus is suspiciously small")
        for (case in folds) {
            val name = str(case["name"])
            val config = foldConfig(case["config"] as? Map<String, Any?> ?: emptyMap())
            val events = (case["events"] as List<Map<String, Any?>>).map {
                Forms.DateFoldEvent(str(it["kind"]), str(it["date"]), str(it["month"]))
            }
            val steps = Forms.dateFold(config, events)
            val expect = case["expect"] as List<Map<String, Any?>>
            assertEquals(expect.size, steps.size, "$name: step count")
            expect.forEachIndexed { index, want ->
                val got = steps[index]
                assertEquals(want["start"], got.start, "$name step $index: start")
                assertEquals(want["end"], got.end, "$name step $index: end")
                assertEquals(want["month"], got.month, "$name step $index: month")
                assertEquals(want["complete"], got.complete, "$name step $index: complete")
                assertEquals(want["reason"], got.reason, "$name step $index: reason")
                assertEquals(strings(want["fired"]), got.fired, "$name step $index: fired")
            }
        }
    }

    // ── validation.json ───────────────────────────────────────────────────────────────────

    @Test
    fun theRuleVocabularyAgreesWithCorpus() {
        val cases = rows("validation", "rules")
        assertTrue(cases.size >= 15, "forms/validation rules corpus is suspiciously small")
        for (case in cases) {
            val rule = str(case["rule"])
            val got = Forms.rule(rule, str(case["arg"]), str(case["value"]), str(case["pattern"]))
            assertEquals(case["expect"], got, "$rule(${case["arg"]}) <- \"${case["value"]}\"")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun field(raw: Map<String, Any?>): Forms.FieldState = Forms.FieldState(
        name = str(raw["name"]),
        value = str(raw["value"]),
        initial = str(raw["initial"]),
        validate = str(raw["validate"]),
        pattern = str(raw["pattern"]),
        message = str(raw["message"]),
    )

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theFirstFailingRuleOwnsTheMessage() {
        rows("validation", "fieldErrors").forEachIndexed { index, case ->
            val got = Forms.fieldError(field(case["field"] as Map<String, Any?>))
            assertEquals(case["expect"], got, "fieldError $index")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun formAggregationAgreesWithCorpus() {
        for (case in rows("validation", "aggregate")) {
            val name = str(case["name"])
            val fields = (case["fields"] as List<Map<String, Any?>>).map { field(it) }
            val got = Forms.aggregate(fields)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["valid"], got.valid, "$name: valid")
            assertEquals(expect["dirty"], got.dirty, "$name: dirty")
            assertEquals(expect["errors"], got.errors, "$name: errors")
            assertEquals(strings(expect["invalid"]), got.invalid, "$name: invalid")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theDoubleSubmitLawAgreesWithCorpus() {
        for (case in rows("validation", "submit")) {
            val name = str(case["name"])
            val state = case["state"] as Map<String, Any?>
            val fields = (case["fields"] as List<Map<String, Any?>>).map { field(it) }
            val got = Forms.submit(state["submitting"] == true, state["disabled"] == true, fields)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(expect["action"], got.action, "$name: action")
            assertEquals(expect["reason"], got.reason, "$name: reason")
            assertEquals(expect["submitting"], got.submitting, "$name: submitting")
            assertEquals(expect["disabled"], got.disabled, "$name: disabled")
            if (expect.containsKey("fields")) {
                assertEquals(strings(expect["fields"]), got.fields, "$name: fields")
            }
            if (expect.containsKey("submitted")) {
                assertEquals(expect["submitted"], got.submitted, "$name: submitted")
            }
            if (expect.containsKey("touchedAll")) {
                assertEquals(expect["touchedAll"], got.touchedAll, "$name: touchedAll")
            }
        }
    }

    // ── composites.json ───────────────────────────────────────────────────────────────────

    @Test
    @Suppress("UNCHECKED_CAST")
    fun multiSelectTogglingAgreesWithCorpus() {
        rows("composites", "multiSelect").forEachIndexed { index, case ->
            val got = Forms.multiSelectToggle(strings(case["selected"]), str(case["value"]), int(case["max"]))
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(strings(expect["selected"]), got.selected, "multiSelect $index: selected")
            assertEquals(expect["changed"], got.changed, "multiSelect $index: changed")
            assertEquals(expect["reason"], got.reason, "multiSelect $index: reason")
        }
    }

    @Test
    fun theSelectionAnnouncementAgreesWithCorpus() {
        for (case in rows("composites", "multiSelectAnnouncement")) {
            val got = Forms.multiSelectAnnouncement(int(case["count"]), int(case["max"]))
            assertEquals(case["expect"], got, "announcement ${case["count"]}/${case["max"]}")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun tagAdditionAgreesWithCorpus() {
        rows("composites", "tagsAdd").forEachIndexed { index, case ->
            val raw = case["config"] as? Map<String, Any?> ?: emptyMap()
            val config = Forms.TagsConfig(
                separator = raw["separator"] as? String ?: "",
                max = (raw["max"] as? Number)?.toInt() ?: 0,
                validate = raw["validate"] as? String ?: "",
            )
            val got = Forms.tagsAdd(strings(case["tags"]), str(case["text"]), config)
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(strings(expect["tags"]), got.tags, "tagsAdd $index: tags")
            assertEquals(strings(expect["added"]), got.added, "tagsAdd $index: added")
            val rejected = expect["rejected"] as List<Map<String, Any?>>
            assertEquals(rejected.size, got.rejected.size, "tagsAdd $index: rejection count")
            rejected.forEachIndexed { at, want ->
                assertEquals(want["tag"], got.rejected[at].tag, "tagsAdd $index: rejection $at tag")
                assertEquals(want["reason"], got.rejected[at].reason, "tagsAdd $index: rejection $at reason")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun backspaceOnAnEmptyQueryRemovesTheLastChip() {
        rows("composites", "tagsBackspace").forEachIndexed { index, case ->
            val got = Forms.tagsBackspace(strings(case["tags"]), str(case["query"]))
            val expect = case["expect"] as Map<String, Any?>
            assertEquals(strings(expect["tags"]), got.tags, "tagsBackspace $index: tags")
            assertEquals(expect["removed"], got.removed, "tagsBackspace $index: removed")
        }
    }

    @Test
    fun theTagAnnouncementAgreesWithCorpus() {
        for (case in rows("composites", "tagsAnnouncement")) {
            val got = Forms.tagsAnnouncement(str(case["kind"]), str(case["tag"]), int(case["count"]))
            assertEquals(case["expect"], got, "tag announcement ${case["kind"]} ${case["tag"]}")
        }
    }

    // ── the laws that are not a corpus row but must never regress ─────────────────────────

    @Test
    fun aMaskedFieldNeverBindsWhatItDoesNotShow() {
        val got = Forms.maskEdit("AA-####", "", 0, 0, "12ab34")
        assertEquals("ab-34", got.display)
        assertEquals("ab34", got.raw)
        assertTrue(!got.complete, "four of six slots are filled")
        // and the field is still typable: the rejected digits did not eat its capacity
        val next = Forms.maskEdit("AA-####", got.display, got.caret, got.caret, "5")
        assertEquals("ab-345", next.display)
    }

    @Test
    fun anUnknownDialCodeIsATypedFailureNeverAGuess() {
        val got = Forms.phoneParse("+9991234567", null)
        assertNull(got.country, "no country")
        assertTrue(!got.valid, "not valid")
        assertEquals("+9991234567", got.e164, "the digits survive for the caller to show")
    }

    @Test
    fun requiredIsTheOnlyRuleAnEmptyValueCanFail() {
        assertTrue(!Forms.rule("required", "", "", ""))
        for (name in listOf("email", "url", "phone", "minLength", "maxLength", "pattern")) {
            assertTrue(Forms.rule(name, "8", "", "^x$"), "$name must pass on empty")
        }
    }

    @Test
    fun aRangeContainingADisabledDateIsRefusedWhole() {
        val config = Forms.DateFoldConfig(
            range = true, disabledDates = listOf("2026-03-11"), month = "2026-03",
        )
        val steps = Forms.dateFold(
            config,
            listOf(
                Forms.DateFoldEvent("select", "2026-03-09"),
                Forms.DateFoldEvent("select", "2026-03-13"),
            ),
        )
        assertEquals("range-contains-disabled", steps[1].reason)
        assertNull(steps[1].end, "the close was refused, not clipped")
    }

    @Test
    fun theSubmitGateBlocksTheSecondTapOfADoubleTap() {
        val fields = listOf(Forms.FieldState(name = "email", value = "ada@example.com", validate = "required,email"))
        val first = Forms.submit(false, false, fields)
        assertEquals("submit", first.action)
        assertTrue(first.submitting, "the first submit arms the flag")
        val second = Forms.submit(first.submitting, false, fields)
        assertEquals("blocked", second.action)
        assertEquals("in-flight", second.reason)
    }
}
