//
//  CalendarCore.kt - the shared Core/Calendar core (:core, pure JVM): the `futureEvents` span
//  decision, the one date grammar, the iOS 17 access split, the calendar-target refusals, the
//  reminders absence, the editor result-fidelity ladder and RFC 5545 recurrence. The law is the
//  corpus, OpenSource/Conformance/calendar/{crud,present,recurrence}.json (parity F12). The twin
//  of Swift CalendarCore and the web @despia/kernel calendar-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: EventKit, CalendarContract and the .ics
//  handoff are per-renderer plumbing. Three different mechanisms have to agree on the same
//  strings and the same refusals, and this is where that agreement is written down once.
//
package despia.engine

/** A refusal or a go-ahead, in the shape every calendar action reports. */
data class CalendarDecision(
    val runs: Boolean,
    val error: String?,
    val message: String?,
    val recoverable: Boolean = true,
    /** Always false: no action in this module prompts on the caller's behalf. */
    val prompted: Boolean = false,
)

/** What the system editor settled as, plus what it is honest to say about it. */
data class CalendarPresentOutcome(
    val result: String?,
    val hasId: Boolean,
    /** The v3 wire spelling of the outcome, or null when nothing is known to have happened. */
    val broadcast: String?,
    val error: String?,
    val presented: Boolean,
)

/** Whether this renderer has a system reminders store at all. */
data class CalendarRemindersSupport(
    val supported: Boolean,
    val error: String?,
    val remindersAccess: String?,
)

/** One BYDAY entry. [ordinal] 0 means "every such weekday"; -1 is "the last one in the period". */
data class RecurrenceDay(val day: String, val ordinal: Int)

/** A parsed RRULE. [until] is an ISO-8601 instant, never a wall-clock day: a renderer that
 *  stored it as a day would end a DST-crossing series an hour early or late. */
data class RecurrenceRule(
    val freq: String,
    val interval: Int,
    val byDay: List<RecurrenceDay>? = null,
    val byMonthDay: List<Int>? = null,
    val byMonth: List<Int>? = null,
    val bySetPos: List<Int>? = null,
    val count: Int? = null,
    val until: String? = null,
)

object CalendarCore {

    // ---- the span decision --------------------------------------------------------------

    const val SPAN_THIS_EVENT: String = "thisEvent"
    const val SPAN_FUTURE_EVENTS: String = "futureEvents"

    /**
     * The dangerous default in every calendar API is the one where editing or deleting a single
     * occurrence quietly takes the whole recurring series with it, and it is unrecoverable from
     * inside the app. So `futureEvents` has NO series-wide default anywhere: omitted means this
     * occurrence only, and only an explicit true widens the blast radius.
     */
    fun span(recurring: Boolean, futureEvents: Boolean?): String =
        if (recurring && futureEvents == true) SPAN_FUTURE_EVENTS else SPAN_THIS_EVENT

    // ---- the date grammar ---------------------------------------------------------------

    const val INVALID_DATE: String = "invalid_date"
    const val INVALID_DATE_MESSAGE: String =
        "start and end must be ISO-8601 strings or epoch seconds, and end must not precede start."

    /** Days since the epoch for a proleptic-Gregorian civil date. Pure arithmetic on purpose: a
     *  date library would be a fourth implementation to keep in step with three renderers. */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = year - if (month <= 2) 1 else 0
        val era = Math.floorDiv(y, 400).toLong()
        val yoe = y - era * 400
        val doy = (153 * (month + if (month > 2) -3 else 9) + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    private val NUMERIC = Regex("""^[+-]?\d+(\.\d+)?$""")
    private val ISO_DATE_TIME = Regex(
        """^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$""")

    /**
     * The one date grammar on all three renderers: ISO-8601 (with or without fractional seconds
     * and with an offset or Z) or epoch SECONDS, as a number or a numeric string. Anything else
     * is refused before the store is touched, so prose never becomes a silently wrong event.
     *
     * Returns epoch SECONDS, or null.
     */
    fun parseDate(raw: Any?): Double? {
        if (raw is Number) return raw.toDouble()
        val text = (raw as? String)?.trim() ?: return null
        if (text.isEmpty()) return null
        if (NUMERIC.matches(text)) return text.toDoubleOrNull()

        val match = ISO_DATE_TIME.matchEntire(text) ?: return null
        val g = match.groupValues
        val year = g[1].toInt()
        val month = g[2].toInt()
        val day = g[3].toInt()
        val hour = if (g[4].isEmpty()) 0 else g[4].toInt()
        val minute = if (g[5].isEmpty()) 0 else g[5].toInt()
        val second = if (g[6].isEmpty()) 0 else g[6].toInt()
        if (month < 1 || month > 12 || day < 1 || day > 31) return null
        if (hour > 23 || minute > 59 || second > 60) return null

        var offset = 0L
        val zone = g[7]
        if (zone.isNotEmpty() && zone != "Z") {
            val sign = if (zone.startsWith("-")) -1 else 1
            val digits = zone.substring(1).replace(":", "")
            offset = sign * (digits.substring(0, 2).toLong() * 3600 + digits.substring(2, 4).toLong() * 60)
        }
        return (daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset).toDouble()
    }

    /** A start/end pair. A zero-length event is LEGAL - it is a marker, not a mistake - but an
     *  end before its start is refused. */
    fun window(start: Any?, end: Any?): Pair<Double, Double>? {
        val from = parseDate(start) ?: return null
        val to = parseDate(end) ?: return null
        if (to < from) return null
        return from to to
    }

    // ---- the access split ---------------------------------------------------------------

    /**
     * Which grant each action requires. `present` with an `id` is the one asterisk: reading the
     * event back to prefill the editor is a read, so THAT spelling needs a read grant while the
     * prefill-a-new-event spelling needs none.
     */
    val PERMISSION_SURFACE: Map<String, String> = mapOf(
        "present" to "none",
        "present.withId" to "read",
        "permission" to "none",
        "calendars" to "read",
        "events" to "read",
        "create" to "write",
        "update" to "write",
        "remove" to "write",
        "add" to "none",
        "ics" to "none",
    )

    const val READ_REFUSAL: String =
        "Calendar access has not been granted. Call dsx.module.calendar.permission with level " +
            "\"read\" first."
    const val WRITE_REFUSAL: String =
        "Writing to the calendar has not been granted. Call dsx.module.calendar.permission with " +
            "level \"write\" first, or use dsx.module.calendar.present, which needs no permission."
    const val WITH_ID_REFUSAL: String =
        "Opening an existing event needs a read grant. Call dsx.module.calendar.permission with " +
            "level \"read\" first."
    const val INVALID_RECURRENCE: String = "invalid_recurrence"
    const val INVALID_RECURRENCE_MESSAGE: String = "recurrence must be an RFC 5545 RRULE string."

    private val ALLOWED = CalendarDecision(runs = true, error = null, message = null)

    private fun deny(error: String, message: String, recoverable: Boolean = true) =
        CalendarDecision(runs = false, error = error, message = message, recoverable = recoverable)

    /**
     * The iOS 17 split. `writeOnly` is a real grant that can create and change events but must
     * NEVER satisfy a read: an app that got write-only access and then enumerated the diary
     * would be defeating the point of the split.
     */
    fun accessDecision(access: String?, action: String): CalendarDecision {
        val needs = PERMISSION_SURFACE[action] ?: return deny("permission_denied", READ_REFUSAL)
        if (needs == "none") return ALLOWED
        val word = access?.trim().orEmpty()
        if (word == "restricted") {
            return deny("permission_denied", if (needs == "read") READ_REFUSAL else WRITE_REFUSAL, false)
        }
        if (needs == "read") {
            if (word == "granted") return ALLOWED
            return deny("permission_denied",
                        if (action == "present.withId") WITH_ID_REFUSAL else READ_REFUSAL)
        }
        if (word == "granted" || word == "writeOnly") return ALLOWED
        return deny("permission_denied", WRITE_REFUSAL)
    }

    /**
     * A subscribed or holiday calendar cannot take a write. Refusing is the contract; silently
     * retargeting the default calendar would put the user's event somewhere they did not choose.
     */
    fun targetDecision(
        calendarId: String?,
        exists: Boolean? = null,
        writable: Boolean? = null,
        hasDefault: Boolean? = null,
    ): CalendarDecision {
        if (calendarId.isNullOrEmpty()) {
            return if (hasDefault == false) {
                deny("read_only_calendar", "That calendar does not accept new events.")
            } else {
                ALLOWED
            }
        }
        if (exists == false) {
            return deny("not_found", "No calendar with that id exists on this device.", false)
        }
        if (writable == false) {
            return deny("read_only_calendar", "That calendar does not accept new events.")
        }
        return ALLOWED
    }

    /** Reminders exist on iOS only. Everywhere else the whole sub-namespace is the TYPED
     *  ABSENCE: never an empty list, which a caller would read as "no reminders". */
    fun remindersSupport(renderer: String): CalendarRemindersSupport =
        if (renderer == "ios") CalendarRemindersSupport(true, null, null)
        else CalendarRemindersSupport(false, "unsupported_platform", "unsupported")

    const val REMINDERS_ABSENT_MESSAGE: String =
        "Reminders are an iOS EventKit store. Neither Android nor the web has a system " +
            "reminders provider."

    // ---- the editor result-fidelity ladder -----------------------------------------------

    /** renderer -> the results it can actually report. A renderer must never resolve a result
     *  outside its own list, and `unknown` is never upgraded to `saved` on a hope. */
    val RESULT_FIDELITY: Map<String, List<String>> = mapOf(
        "ios" to listOf("saved", "cancelled", "deleted"),
        "android" to listOf("saved", "cancelled", "unknown"),
        "web" to listOf("unknown"),
    )

    /**
     * The result-fidelity ladder: iOS knows exactly what the user did, Android knows only if a
     * read grant lets it verify against the provider, and the web never knows. `unknown` is the
     * honest answer at each rung where the platform does not report.
     *
     * Both refusals happen BEFORE anything is presented: an unparseable window and a
     * present({id}) with no read grant each cost the user nothing, and opening an empty editor
     * first would.
     */
    fun presentOutcome(
        access: String? = null,
        editorAction: String? = null,
        eventFound: Boolean? = null,
        id: String? = null,
        start: Any? = null,
        end: Any? = null,
        hasWindow: Boolean = start != null || end != null,
    ): CalendarPresentOutcome {
        fun refused(error: String) =
            CalendarPresentOutcome(null, hasId = false, broadcast = null, error = error, presented = false)

        if (!id.isNullOrEmpty()) {
            val decision = accessDecision(access, "present.withId")
            if (!decision.runs) return refused(decision.error ?: "permission_denied")
        } else if (hasWindow) {
            if (window(start, end) == null) return refused(INVALID_DATE)
        }

        if (editorAction != null) {
            return when (editorAction) {
                "saved" -> CalendarPresentOutcome("saved", true, "saved", null, true)
                "deleted" -> CalendarPresentOutcome("deleted", false, "deleted", null, true)
                "canceled", "cancelled" -> CalendarPresentOutcome("cancelled", false, "canceled", null, true)
                else -> CalendarPresentOutcome("unknown", false, null, null, true)
            }
        }

        // Nothing reported. A read grant is the only thing that makes verification possible;
        // without one, `unknown` is the honest answer and must never be upgraded.
        if (eventFound != null && accessDecision(access, "events").runs) {
            return if (eventFound) CalendarPresentOutcome("saved", true, "saved", null, true)
                   else CalendarPresentOutcome("cancelled", false, "canceled", null, true)
        }
        return CalendarPresentOutcome("unknown", false, null, null, true)
    }

    // ---- RFC 5545 recurrence --------------------------------------------------------------

    val FREQUENCIES: List<String> = listOf("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
    val DAYS: List<String> = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")

    /** Strip the optional `RRULE:` prefix and the surrounding whitespace, nothing else. */
    fun normalizeRRule(raw: String?): String {
        val text = raw?.trim().orEmpty()
        return if (text.length >= 6 && text.substring(0, 6).equals("RRULE:", true)) text.substring(6) else text
    }

    private val ICS_INSTANT = Regex("""^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$""")
    private val INTEGER = Regex("""^\d+$""")
    private val SIGNED_INTEGER = Regex("""^[+-]?\d+$""")

    /** An iCalendar DATE-TIME to an ISO-8601 instant, or null. `20261231T235959Z` is an ABSOLUTE
     *  moment, which is exactly why a series ends when it was told to. */
    fun icsInstantToISO(raw: String): String? {
        val g = ICS_INSTANT.matchEntire(raw.trim())?.groupValues ?: return null
        if (g[2].toInt() < 1 || g[2].toInt() > 12 || g[3].toInt() < 1 || g[3].toInt() > 31) return null
        if (g[4].toInt() > 23 || g[5].toInt() > 59 || g[6].toInt() > 60) return null
        return "${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:${g[6]}${g[7]}"
    }

    /** The inverse: an ISO instant back to the iCalendar spelling, exactly. */
    fun isoToICSInstant(iso: String): String = iso.replace("-", "").replace(":", "")

    private fun signedList(raw: String, low: Int, high: Int): List<Int>? {
        val out = ArrayList<Int>()
        for (token in raw.split(",")) {
            val text = token.trim()
            if (!SIGNED_INTEGER.matches(text)) return null
            val value = text.toIntOrNull() ?: return null
            if (value == 0 || value < low || value > high) return null
            out.add(value)
        }
        return if (out.isEmpty()) null else out
    }

    /**
     * Parse an RRULE. `recurrence` is an RRULE string and nothing else, because inventing a
     * shape for recurrence is how you ship a calendar integration that cannot express "the last
     * Friday of every month". A string that does not parse is a REFUSAL, never an event that
     * quietly does not repeat.
     */
    fun parseRecurrence(raw: String?): RecurrenceRule? {
        val text = normalizeRRule(raw)
        if (text.isEmpty()) return null

        val parts = HashMap<String, String>()
        for (pair in text.split(";")) {
            if (pair.isEmpty()) continue
            val kv = pair.split("=")
            if (kv.size != 2 || kv[0].isEmpty() || kv[1].isEmpty()) return null
            parts[kv[0].uppercase()] = kv[1]
        }

        val freq = parts["FREQ"]?.uppercase().orEmpty()
        if (freq !in FREQUENCIES) return null

        var interval = 1
        val rawInterval = parts["INTERVAL"]
        if (rawInterval != null) {
            if (!INTEGER.matches(rawInterval)) return null
            interval = rawInterval.toIntOrNull() ?: return null
            if (interval < 1) return null
        }

        var count: Int? = null
        var until: String? = null
        val rawCount = parts["COUNT"]
        val rawUntil = parts["UNTIL"]
        if (rawCount != null) {
            if (!INTEGER.matches(rawCount)) return null
            val parsedCount = rawCount.toIntOrNull() ?: return null
            if (parsedCount < 1) return null
            count = parsedCount
        } else if (rawUntil != null) {
            until = icsInstantToISO(rawUntil) ?: return null
        }

        var byDay: List<RecurrenceDay>? = null
        val rawByDay = parts["BYDAY"]
        if (rawByDay != null) {
            val parsed = ArrayList<RecurrenceDay>()
            for (token in rawByDay.split(",")) {
                val text2 = token.trim().uppercase()
                if (text2.length < 2) return null
                val day = text2.takeLast(2)
                if (day !in DAYS) return null
                val ordinalText = text2.dropLast(2)
                var ordinal = 0
                if (ordinalText.isNotEmpty()) {
                    if (!SIGNED_INTEGER.matches(ordinalText)) return null
                    ordinal = ordinalText.toIntOrNull() ?: return null
                    if (ordinal == 0 || ordinal < -53 || ordinal > 53) return null
                }
                parsed.add(RecurrenceDay(day, ordinal))
            }
            if (parsed.isEmpty()) return null
            byDay = parsed
        }

        val rawByMonthDay = parts["BYMONTHDAY"]
        val byMonthDay = if (rawByMonthDay == null) null else signedList(rawByMonthDay, -31, 31) ?: return null
        val rawByMonth = parts["BYMONTH"]
        val byMonth = if (rawByMonth == null) null else signedList(rawByMonth, 1, 12) ?: return null
        val rawBySetPos = parts["BYSETPOS"]
        val bySetPos = if (rawBySetPos == null) null else signedList(rawBySetPos, -366, 366) ?: return null

        return RecurrenceRule(freq, interval, byDay, byMonthDay, byMonth, bySetPos, count, until)
    }

    /**
     * Serialise back to the canonical form, which is NOT always the input: an explicit
     * INTERVAL=1 is dropped because it is the default, the RRULE: prefix is dropped, and the
     * keys emit in one fixed order so a round-trip on three renderers produces one string.
     */
    fun formatRecurrence(rule: RecurrenceRule): String {
        val parts = ArrayList<String>()
        parts.add("FREQ=${rule.freq}")
        if (rule.interval > 1) parts.add("INTERVAL=${rule.interval}")
        rule.byDay?.takeIf { it.isNotEmpty() }?.let { days ->
            parts.add("BYDAY=" + days.joinToString(",") {
                if (it.ordinal == 0) it.day else "${it.ordinal}${it.day}"
            })
        }
        rule.byMonthDay?.takeIf { it.isNotEmpty() }?.let { parts.add("BYMONTHDAY=" + it.joinToString(",")) }
        rule.byMonth?.takeIf { it.isNotEmpty() }?.let { parts.add("BYMONTH=" + it.joinToString(",")) }
        rule.bySetPos?.takeIf { it.isNotEmpty() }?.let { parts.add("BYSETPOS=" + it.joinToString(",")) }
        val count = rule.count
        val until = rule.until
        if (count != null) parts.add("COUNT=$count") else if (until != null) parts.add("UNTIL=${isoToICSInstant(until)}")
        return parts.joinToString(";")
    }
}
