//
//  NotifyCore.kt - the shared Core/Notify pure core (:core, pure JVM): the permission ladder
//  (including iOS provisional authorization and the Settings-changed-while-backgrounded
//  transition), the TRIGGER RESOLVER, the Android channel-importance fold, the
//  foreground-presentation resolution and the tap-payload normalisation. The law is the corpus,
//  OpenSource/Conformance/notify/*.json (parity/F02-notifications.md); the web twin is
//  @despia-native/kernel notify.ts and the Swift twin is Engine/iOS NotifyCore.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: NotificationManagerCompat,
//  UNUserNotificationCenter and the browser Notification API all ask this core WHAT to do and
//  then do it. That split is what lets one corpus judge three renderers.
//
//  THE THREE RULES THIS FILE EXISTS FOR:
//
//  1. A REMINDER MUST FIRE AT THE SAME INSTANT ON EVERY PLATFORM. Scheduling is pure date math,
//     and it is where a notification stack is quietly wrong on exactly one platform: an hour
//     early in March, twice on the first Sunday in November, never on a leap day. So the
//     resolver takes ZONE RULES as data - a base offset plus the instants at which it changes -
//     and never asks java.time, Calendar or the device tzdata anything.
//
//  2. PROVISIONAL AUTHORIZATION IS ONE FLAG. Android has no twin for it, which is exactly why
//     it is decided here: the option is DROPPED and REPORTED rather than faked, and the iOS
//     escalation rule (a DECLINED escalation keeps the quiet grant) is pinned by the same
//     corpus both runtimes read.
//
//  3. AN UNDECLARED ANDROID CHANNEL IS A TYPED REFUSAL. Post to a channel that was never
//     created and the OS drops the notification with no exception and no log line. The refusal
//     names the id, because "channel not found" without it is the same afternoon.
//
//  NO ANDROID IMPORTS. This file is :core, so it runs SDK-free under `gradle test` and the
//  conformance corpus judges it without an emulator.
//
package despia.engine

object NotifyCore {

    // -----------------------------------------------------------------------------------
    // The permission ladder
    // -----------------------------------------------------------------------------------

    /** The authorization statuses, as the module reports them (never a platform enum). */
    val STATUSES: List<String> = listOf("undetermined", "denied", "provisional", "granted")

    /** The option vocabulary, exact case. `provisional` is an option like the rest so that
     *  quiet authorization is one flag rather than a second API. */
    val OPTIONS: List<String> =
        listOf("alert", "sound", "badge", "carPlay", "announcement", "critical", "provisional")

    /** What a request that names no option at all asks for. */
    val DEFAULT_OPTIONS: List<String> = listOf("alert", "badge", "sound")

    /** What each platform can actually honour. Anything else is dropped AND REPORTED - an app
     *  that asked for critical alerts and got ordinary ones has to be able to find that out. */
    val PLATFORM_OPTIONS: Map<String, List<String>> = mapOf(
        "ios" to listOf("alert", "sound", "badge", "carPlay", "announcement", "critical", "provisional"),
        "android" to listOf("alert", "sound", "badge"),
        "web" to listOf("alert", "sound", "badge"),
    )

    /** POST_NOTIFICATIONS became a runtime permission here. Below it there is nothing to ask. */
    const val ANDROID_RUNTIME_PERMISSION_SDK: Int = 33

    /** `provisional` and `critical` are MODIFIERS, not content: they say HOW the authorization
     *  is obtained and how loud it may be, not what the notification is allowed to do. So
     *  naming one does not suppress the default alert/badge/sound. */
    val MODIFIER_OPTIONS: List<String> = listOf("provisional", "critical")

    data class PermissionState(
        val status: String,
        /** True once the OS has shown the full-authorization dialog. It shows it once. */
        val promptShown: Boolean = false,
        /** Apple grants the critical-alerts entitlement by application; without it the option
         *  is accepted by the API and silently does nothing. Null = not known / not asked. */
        val criticalEntitled: Boolean? = null,
    )

    data class PermissionRequest(
        val provisional: Boolean = false,
        val critical: Boolean = false,
        val alert: Boolean = false,
        val sound: Boolean = false,
        val badge: Boolean = false,
        val carPlay: Boolean = false,
        val announcement: Boolean = false,
    ) {
        internal fun asked(word: String): Boolean = when (word) {
            "alert" -> alert
            "sound" -> sound
            "badge" -> badge
            "carPlay" -> carPlay
            "announcement" -> announcement
            "critical" -> critical
            "provisional" -> provisional
            else -> false
        }
    }

    /**
     * prompt = show the dialog · authorize = the QUIET provisional grant, no dialog ·
     * settle = answer with what is already held · refuse = a typed error.
     */
    data class PermissionPlan(
        val action: String,
        val prompted: Boolean,
        val quiet: Boolean,
        /** True when this prompt is the provisional -> full conversion. */
        val escalation: Boolean,
        val options: List<String>,
        val dropped: List<String>,
        val status: String? = null,
        val error: String? = null,
    )

    private fun requestedOptions(request: PermissionRequest): List<String> {
        val content = OPTIONS.filter { it !in MODIFIER_OPTIONS }.filter { request.asked(it) }
        val modifiers = MODIFIER_OPTIONS.filter { request.asked(it) }
        // A request that names no CONTENT option asks for the sensible default. A request that
        // names only options this platform cannot honour is NOT defaulted afterwards - it asked
        // for something specific, and the honest answer is an empty set plus the dropped list.
        val base = if (content.isEmpty()) DEFAULT_OPTIONS else content
        return base + modifiers
    }

    /**
     * Decide what a `permission(...)` call should do.
     *
     * The whole ladder in one function. `status` never reaches here: reading is a different verb
     * and it must never be able to prompt.
     */
    fun permissionPlan(
        request: PermissionRequest,
        state: PermissionState,
        platform: String,
        sdk: Int = 0,
    ): PermissionPlan {
        val supported = PLATFORM_OPTIONS[platform]
            ?: return PermissionPlan(
                action = "refuse", prompted = false, quiet = false, escalation = false,
                options = emptyList(), dropped = emptyList(), error = "unsupported_platform",
            )

        val dropped = ArrayList<String>()
        val options = ArrayList<String>()
        for (word in requestedOptions(request)) {
            if (word !in supported) { dropped.add(word); continue }
            // The entitlement is not a platform capability, it is a per-app grant, so it is
            // checked separately - and a missing one DROPS the option rather than refusing the
            // whole request, because that is exactly what the platform API does.
            if (word == "critical" && state.criticalEntitled != true) { dropped.add(word); continue }
            options.add(word)
        }
        options.sort()
        dropped.sort()

        val wantsProvisional = "provisional" in options

        fun settle(status: String) = PermissionPlan(
            action = "settle", status = status, prompted = false, quiet = false,
            escalation = false, options = options, dropped = dropped,
        )
        fun refuse(error: String) = PermissionPlan(
            action = "refuse", prompted = false, quiet = false, escalation = false,
            options = options, dropped = dropped, error = error,
        )

        if (platform == "android" && sdk < ANDROID_RUNTIME_PERMISSION_SDK) {
            // NOTHING TO ASK. A user who switched the app's notifications off in system settings
            // still reads denied, and no in-app dialog can undo that - so it is a refusal
            // pointing at Settings rather than a prompt that will never appear.
            if (state.status == "denied") return refuse("permission_denied")
            return settle("granted")
        }

        return when (state.status) {
            "granted" -> settle("granted")
            "denied" -> refuse("permission_denied")
            "provisional" ->
                // Asking for quiet again while already quiet changes nothing. Asking for FULL is
                // the conversion, and it is the one prompt iOS will still show from here.
                if (wantsProvisional) settle("provisional")
                else PermissionPlan(
                    action = "prompt", prompted = true, quiet = false, escalation = true,
                    options = options, dropped = dropped,
                )
            else ->
                if (wantsProvisional) PermissionPlan(
                    action = "authorize", prompted = false, quiet = true, escalation = false,
                    options = options, dropped = dropped,
                )
                else PermissionPlan(
                    action = "prompt", prompted = true, quiet = false, escalation = false,
                    options = options, dropped = dropped,
                )
        }
    }

    /**
     * Fold the OS's answer to a prompt back into the state.
     *
     * A DECLINED ESCALATION IS NOT A LOST GRANT: an app that was delivering quietly and asked for
     * more must still be delivering quietly afterwards. The naive `granted ? granted : denied`
     * throws away a working feature to record the refusal of a different one, and the user never
     * sees another notification.
     */
    fun applyPermission(
        state: PermissionState,
        action: String,
        escalation: Boolean,
        granted: Boolean,
    ): PermissionState = when {
        action == "authorize" ->
            state.copy(status = if (granted) "provisional" else "denied")
        action == "prompt" && escalation ->
            state.copy(status = if (granted) "granted" else "provisional", promptShown = true)
        action == "prompt" ->
            state.copy(status = if (granted) "granted" else "denied", promptShown = true)
        else -> state
    }

    data class Observed(
        val state: PermissionState,
        val changed: Boolean,
        /** True exactly when the status moved. A permission event on every foreground is noise. */
        val broadcast: Boolean,
    )

    /**
     * THE SETTINGS-CHANGED-WHILE-BACKGROUNDED TRANSITION.
     *
     * The user turns notifications off (or on) in Settings while the app is not running. A module
     * that trusts its cached status then prompts into a void forever, or tells a settings screen
     * that notifications are on when they are not. The OS reading always wins.
     *
     * `undetermined` from the OS means the app was reinstalled, so the spent-prompt memory resets
     * with it - otherwise the module would believe it had already burned a dialog it now has back.
     */
    fun observePermission(state: PermissionState, osStatus: String): Observed {
        val status = if (osStatus in STATUSES) osStatus else state.status
        val promptShown = if (status == "undetermined") false else state.promptShown
        return Observed(
            state = state.copy(status = status, promptShown = promptShown),
            changed = status != state.status || promptShown != state.promptShown,
            broadcast = status != state.status,
        )
    }

    // -----------------------------------------------------------------------------------
    // Time zones, as data
    // -----------------------------------------------------------------------------------

    data class ZoneTransition(val at: Long, val offset: Int)

    /** A zone is a base offset in MINUTES plus the instants at which it changes. Ordered by `at`. */
    data class ZoneRules(val base: Int, val transitions: List<ZoneTransition> = emptyList())

    val UTC: ZoneRules = ZoneRules(base = 0, transitions = emptyList())

    private const val MINUTE_MS = 60_000L
    private const val HOUR_MS = 3_600_000L
    private const val DAY_MS = 86_400_000L

    fun offsetAt(zone: ZoneRules, instant: Long): Int {
        var offset = zone.base
        for (transition in zone.transitions) {
            if (instant >= transition.at) offset = transition.offset else break
        }
        return offset
    }

    /** An instant, expressed as the epoch-ms value that PRINTS as local time when read as UTC. */
    fun toWall(zone: ZoneRules, instant: Long): Long =
        instant + offsetAt(zone, instant) * MINUTE_MS

    /**
     * A wall-clock value back to an instant.
     *
     * THE TWO CASES DATE MATH DIES ON:
     *   GAP (spring forward) - the wall time does not exist. Answer the first instant that does,
     *     i.e. the transition itself. A daily reminder that silently skips a day once a year is
     *     worse than one that runs half an hour late once a year.
     *   OVERLAP (fall back) - the wall time happens twice. Answer the EARLIER instant, once.
     *     Firing on both is a duplicate; firing on the second is an hour late.
     */
    fun fromWall(zone: ZoneRules, wall: Long): Long? {
        val offsets = LinkedHashSet<Int>()
        offsets.add(zone.base)
        for (transition in zone.transitions) offsets.add(transition.offset)
        var best: Long? = null
        for (offset in offsets.sorted()) {
            val instant = wall - offset * MINUTE_MS
            if (offsetAt(zone, instant) != offset) continue
            val current = best
            if (current == null || instant < current) best = instant
        }
        if (best != null) return best
        for (transition in zone.transitions) {
            val before = offsetAt(zone, transition.at - 1)
            val after = transition.offset
            if (after <= before) continue
            val low = transition.at + before * MINUTE_MS
            val high = transition.at + after * MINUTE_MS
            if (wall in low until high) return transition.at
        }
        return null
    }

    // -----------------------------------------------------------------------------------
    // Civil date arithmetic (no platform calendar, on any renderer)
    // -----------------------------------------------------------------------------------

    data class Civil(
        val year: Int,
        /** 1-12 */
        val month: Int,
        /** 1-31 */
        val day: Int,
        val hour: Int,
        val minute: Int,
    )

    private fun isLeap(year: Int): Boolean =
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0

    private val MONTH_LENGTHS = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

    fun daysInMonth(year: Int, month: Int): Int =
        if (month == 2 && isLeap(year)) 29 else MONTH_LENGTHS[month - 1]

    /** Days from 1970-01-01 to year-month-day, Howard Hinnant's civil_from_days inverted. */
    fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = (year - if (month <= 2) 1 else 0).toLong()
        val era = Math.floorDiv(y, 400L)
        val yoe = y - era * 400L
        val doy = Math.floorDiv(153L * (month + (if (month > 2) -3 else 9)) + 2L, 5L) + day - 1L
        val doe = yoe * 365L + Math.floorDiv(yoe, 4L) - Math.floorDiv(yoe, 100L) + doy
        return era * 146097L + doe - 719468L
    }

    /** The inverse: a day number back to a civil year/month/day. */
    fun civilFromDays(days: Long): Triple<Int, Int, Int> {
        val z = days + 719468L
        val era = Math.floorDiv(z, 146097L)
        val doe = z - era * 146097L
        val yoe = (doe - doe / 1460L + doe / 36524L - doe / 146096L) / 365L
        val y = yoe + era * 400L
        val doy = doe - (365L * yoe + yoe / 4L - yoe / 100L)
        val mp = (5L * doy + 2L) / 153L
        val day = doy - (153L * mp + 2L) / 5L + 1L
        val month = mp + (if (mp < 10L) 3L else -9L)
        val year = y + (if (month <= 2L) 1L else 0L)
        return Triple(year.toInt(), month.toInt(), day.toInt())
    }

    /** 0 = Sunday. 1970-01-01 was a Thursday. */
    fun weekday(days: Long): Int = (((days % 7L) + 11L) % 7L).toInt()

    fun wallOf(civil: Civil): Long =
        daysFromCivil(civil.year, civil.month, civil.day) * DAY_MS +
            civil.hour * HOUR_MS + civil.minute * MINUTE_MS

    fun civilOf(wall: Long): Civil {
        val days = Math.floorDiv(wall, DAY_MS)
        val rest = wall - days * DAY_MS
        val (year, month, day) = civilFromDays(days)
        return Civil(
            year = year, month = month, day = day,
            hour = (rest / HOUR_MS).toInt(),
            minute = ((rest % HOUR_MS) / MINUTE_MS).toInt(),
        )
    }

    // -----------------------------------------------------------------------------------
    // Cron
    // -----------------------------------------------------------------------------------

    /** The cron search is BOUNDED. A bound is what makes `0 12 30 2 *` answer "never" instead of
     *  hanging a scheduler on a date that does not exist. A shade over four years, so the
     *  leap-day case is inside it. */
    const val CRON_SEARCH_DAYS: Int = 1600

    data class CronSpec(
        val minutes: List<Int>,
        val hours: List<Int>,
        val daysOfMonth: List<Int>,
        val months: List<Int>,
        val daysOfWeek: List<Int>,
        val domRestricted: Boolean,
        val dowRestricted: Boolean,
    )

    private fun isDigits(text: String): Boolean =
        text.isNotEmpty() && text.all { it in '0'..'9' }

    private fun isSpace(c: Char): Boolean =
        c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u000B' || c == '\u000C'

    /** The `\s+` split, hand-rolled so all three runtimes agree on what a separator is. Only
     *  ever called with an already-trimmed string, so runs collapse and nothing empty survives -
     *  except the empty input itself, which stays ONE empty field, because a cron with no fields
     *  at all must fail the arity check rather than vanish into a zero-length list. */
    private fun splitOnSpaces(text: String): List<String> {
        if (text.isEmpty()) return listOf("")
        val out = ArrayList<String>()
        val current = StringBuilder()
        for (c in text) {
            if (isSpace(c)) {
                if (current.isNotEmpty()) { out.add(current.toString()); current.setLength(0) }
            } else {
                current.append(c)
            }
        }
        if (current.isNotEmpty()) out.add(current.toString())
        return out
    }

    private fun parseCronField(text: String, low: Int, high: Int): List<Int>? {
        val out = LinkedHashSet<Int>()
        for (part in text.split(",")) {
            if (part.isEmpty()) return null
            var body = part
            var step = 1
            val slash = body.indexOf('/')
            if (slash >= 0) {
                val stepText = body.substring(slash + 1)
                body = body.substring(0, slash)
                if (!isDigits(stepText)) return null
                step = stepText.toIntOrNull() ?: return null
                if (step <= 0) return null
            }
            val from: Int
            val to: Int
            if (body == "*") {
                from = low; to = high
            } else if (body.contains("-")) {
                val halves = body.split("-")
                val a = halves.getOrNull(0)
                val b = halves.getOrNull(1)
                if (a == null || b == null || !isDigits(a) || !isDigits(b)) return null
                from = a.toIntOrNull() ?: return null
                to = b.toIntOrNull() ?: return null
                if (from > to) return null
            } else {
                if (!isDigits(body)) return null
                from = body.toIntOrNull() ?: return null
                to = from
            }
            if (from < low || to > high) return null
            var value = from
            while (value <= to) { out.add(value); value += step }
        }
        return out.sorted()
    }

    fun parseCron(expression: String): CronSpec? {
        val fields = splitOnSpaces(expression.trim())
        if (fields.size != 5) return null
        val minutes = parseCronField(fields[0], 0, 59) ?: return null
        val hours = parseCronField(fields[1], 0, 23) ?: return null
        val daysOfMonth = parseCronField(fields[2], 1, 31) ?: return null
        val months = parseCronField(fields[3], 1, 12) ?: return null
        val rawDow = parseCronField(fields[4], 0, 7) ?: return null
        // 7 and 0 are both Sunday, everywhere cron is spoken.
        val daysOfWeek = rawDow.map { if (it == 7) 0 else it }.distinct().sorted()
        return CronSpec(
            minutes = minutes, hours = hours, daysOfMonth = daysOfMonth, months = months,
            daysOfWeek = daysOfWeek,
            domRestricted = fields[2] != "*",
            dowRestricted = fields[4] != "*",
        )
    }

    private fun cronDayMatches(spec: CronSpec, year: Int, month: Int, day: Int): Boolean {
        if (month !in spec.months) return false
        val dow = weekday(daysFromCivil(year, month, day))
        // Cron's classic OR: when BOTH day fields are restricted, either one matching is a match.
        if (spec.domRestricted && spec.dowRestricted) {
            return day in spec.daysOfMonth || dow in spec.daysOfWeek
        }
        if (spec.domRestricted) return day in spec.daysOfMonth
        if (spec.dowRestricted) return dow in spec.daysOfWeek
        return true
    }

    // -----------------------------------------------------------------------------------
    // The trigger resolver
    // -----------------------------------------------------------------------------------

    val REPEAT_UNITS: List<String> = listOf("hourly", "daily", "weekly", "monthly", "yearly")

    /** `inSeconds` is the corpus/TS `in` (a Kotlin hard keyword). */
    data class Trigger(
        val at: Any? = null,
        val inSeconds: Double? = null,
        val cron: String? = null,
        val repeats: String? = null,
    )

    data class FirePlan(
        val ok: Boolean,
        val kind: String? = null,
        val fires: List<Long> = emptyList(),
        val exhausted: Boolean = false,
        val error: String? = null,
    )

    private val INVALID_TRIGGER = FirePlan(ok = false, error = "invalid_trigger")

    /**
     * Only the shape the module accepts on the wire: an epoch-ms number, or an ISO-8601 instant
     * with an explicit zone. A bare "2026-06-01 12:00" is refused rather than guessed at, because
     * the guess is exactly the bug this whole file exists to prevent.
     */
    fun parseInstant(value: Any?): Long? {
        if (value is Number) {
            val d = value.toDouble()
            if (d.isNaN() || d.isInfinite()) return null
            return d.toLong()   // truncates toward zero, like Math.trunc
        }
        val text = (value as? String)?.trim() ?: return null
        // YYYY-MM-DD (T| ) HH:MM [:SS] [.mmm…] (Z|z|±HH:MM|±HHMM) — hand-rolled so the three
        // runtimes cannot disagree about what their regex engines accept.
        var i = 0
        fun digits(count: Int): Int? {
            if (i + count > text.length) return null
            var out = 0
            for (k in 0 until count) {
                val c = text[i + k]
                if (c !in '0'..'9') return null
                out = out * 10 + (c - '0')
            }
            i += count
            return out
        }
        fun literal(chars: String): Boolean {
            if (i >= text.length || text[i] !in chars) return false
            i += 1
            return true
        }
        val year = digits(4) ?: return null
        if (!literal("-")) return null
        val month = digits(2) ?: return null
        if (!literal("-")) return null
        val day = digits(2) ?: return null
        if (!literal("Tt ")) return null
        val hour = digits(2) ?: return null
        if (!literal(":")) return null
        val minute = digits(2) ?: return null
        var second = 0
        if (i < text.length && text[i] == ':') {
            i += 1
            second = digits(2) ?: return null
        }
        var milli = 0
        if (i < text.length && text[i] == '.') {
            i += 1
            val start = i
            while (i < text.length && text[i] in '0'..'9') i += 1
            if (i == start) return null
            val fraction = text.substring(start, minOf(start + 3, i)).padEnd(3, '0')
            milli = fraction.toIntOrNull() ?: return null
        }
        var offsetMinutes = 0
        if (i < text.length && (text[i] == 'Z' || text[i] == 'z')) {
            i += 1
        } else if (i < text.length && (text[i] == '+' || text[i] == '-')) {
            val sign = if (text[i] == '-') -1 else 1
            i += 1
            val zoneHour = digits(2) ?: return null
            if (i < text.length && text[i] == ':') i += 1
            val zoneMinute = digits(2) ?: return null
            offsetMinutes = sign * (zoneHour * 60 + zoneMinute)
        } else {
            return null
        }
        if (i != text.length) return null
        if (month < 1 || month > 12) return null
        if (day < 1 || day > daysInMonth(year, month)) return null
        if (hour > 23 || minute > 59 || second > 60) return null
        return daysFromCivil(year, month, day) * DAY_MS +
            hour * HOUR_MS + minute * MINUTE_MS + second * 1000L + milli -
            offsetMinutes * MINUTE_MS
    }

    private fun addMonths(year: Int, month: Int, count: Int): Pair<Int, Int> {
        val index = year.toLong() * 12L + (month - 1).toLong() + count.toLong()
        return Pair(Math.floorDiv(index, 12L).toInt(), (Math.floorMod(index, 12L) + 1L).toInt())
    }

    /**
     * Resolve a trigger to its next `count` fire instants.
     *
     * WALL CLOCK VERSUS INTERVAL, the distinction the corpus exists to pin: `hourly` is an
     * INTERVAL - exactly 3600000 ms apart, straight through a DST transition. Every other unit is
     * WALL CLOCK - a 09:00 daily reminder is still 09:00 the day the clocks move, so the gap
     * between those two fires is 23 or 25 hours. Both are correct; they are different.
     */
    fun fireTimes(trigger: Trigger, from: Long, zone: ZoneRules?, count: Int): FirePlan {
        val rules = zone ?: UTC
        val want = maxOf(0, count)

        val cron = trigger.cron?.trim()?.takeIf { it.isNotEmpty() }
        val repeats = trigger.repeats?.trim()?.takeIf { it.isNotEmpty() }
        val seconds = trigger.inSeconds

        val hasAt = trigger.at != null
        val anchors = (if (hasAt) 1 else 0) + (if (seconds != null) 1 else 0) + (if (cron != null) 1 else 0)
        if (anchors != 1) return INVALID_TRIGGER
        if (cron != null && repeats != null) return INVALID_TRIGGER   // a cron already repeats
        if (repeats != null && repeats !in REPEAT_UNITS) return INVALID_TRIGGER

        if (cron != null) {
            val spec = parseCron(cron) ?: return INVALID_TRIGGER
            return cronFires(spec, from, rules, want)
        }

        val anchor: Long
        if (hasAt) {
            anchor = parseInstant(trigger.at) ?: return INVALID_TRIGGER
        } else {
            val delay = seconds!!
            if (delay.isNaN() || delay.isInfinite() || delay <= 0.0) return INVALID_TRIGGER
            anchor = from + Math.floor(delay * 1000.0 + 0.5).toLong()
        }

        if (repeats == null) {
            // An `at` already in the past resolves to NOTHING rather than firing immediately. A
            // scheduler that fires a stale reminder the moment the app opens is how a user gets
            // yesterday's alarm at breakfast.
            return FirePlan(
                ok = true, kind = "once",
                fires = if (anchor > from) listOf(anchor) else emptyList(),
                exhausted = false,
            )
        }
        return repeatFires(anchor, repeats, from, rules, want)
    }

    private fun cronFires(spec: CronSpec, from: Long, zone: ZoneRules, count: Int): FirePlan {
        val fires = ArrayList<Long>()
        if (count == 0) return FirePlan(ok = true, kind = "repeating", fires = fires, exhausted = false)
        val startWall = toWall(zone, from)
        val startDay = Math.floorDiv(startWall, DAY_MS)
        for (offset in 0 until CRON_SEARCH_DAYS) {
            val (year, month, day) = civilFromDays(startDay + offset)
            if (!cronDayMatches(spec, year, month, day)) continue
            for (hour in spec.hours) {
                for (minute in spec.minutes) {
                    val wall = wallOf(Civil(year, month, day, hour, minute))
                    if (wall <= startWall) continue
                    val instant = fromWall(zone, wall) ?: continue
                    if (instant <= from) continue
                    // The gap rule can map two distinct wall times onto the same instant (02:00
                    // and 02:30 both become 03:00 on the spring-forward day). One fire, not two.
                    if (fires.isNotEmpty() && instant <= fires[fires.size - 1]) continue
                    fires.add(instant)
                    if (fires.size >= count) {
                        return FirePlan(ok = true, kind = "repeating", fires = fires, exhausted = false)
                    }
                }
            }
        }
        return FirePlan(ok = true, kind = "repeating", fires = fires, exhausted = true)
    }

    private fun repeatFires(
        anchor: Long,
        unit: String,
        from: Long,
        zone: ZoneRules,
        count: Int,
    ): FirePlan {
        val fires = ArrayList<Long>()
        if (count == 0) return FirePlan(ok = true, kind = "repeating", fires = fires, exhausted = false)

        if (unit == "hourly") {
            var instant = anchor
            // Skip forward in whole hours rather than looping one at a time from a distant anchor.
            if (instant <= from) {
                val steps = Math.floorDiv(from - instant, HOUR_MS) + 1L
                instant += steps * HOUR_MS
            }
            while (fires.size < count) { fires.add(instant); instant += HOUR_MS }
            return FirePlan(ok = true, kind = "repeating", fires = fires, exhausted = false)
        }

        val base = civilOf(toWall(zone, anchor))
        val baseDays = daysFromCivil(base.year, base.month, base.day)
        var step = 0
        var guard = 0
        val guardLimit = if (unit == "yearly" || unit == "monthly") 4000 else CRON_SEARCH_DAYS * 2
        while (fires.size < count && guard < guardLimit) {
            guard += 1
            var year = base.year
            var month = base.month
            var day = base.day
            if (unit == "daily" || unit == "weekly") {
                val days = baseDays + step.toLong() * (if (unit == "weekly") 7L else 1L)
                val ymd = civilFromDays(days)
                year = ymd.first; month = ymd.second; day = ymd.third
            } else if (unit == "monthly") {
                val ym = addMonths(base.year, base.month, step)
                year = ym.first; month = ym.second
                day = base.day
                // SKIP, never clamp: "the 31st" means the 31st. Clamping to the 30th silently
                // invents a fire the author never asked for, and it is indistinguishable from a
                // bug in February.
                if (day > daysInMonth(year, month)) { step += 1; continue }
            } else {
                year = base.year + step
                day = base.day
                if (day > daysInMonth(year, month)) { step += 1; continue }   // 29 February
            }
            step += 1
            val instant = fromWall(zone, wallOf(Civil(year, month, day, base.hour, base.minute)))
                ?: continue
            if (instant <= from) continue
            if (fires.isNotEmpty() && instant <= fires[fires.size - 1]) continue
            fires.add(instant)
        }
        return FirePlan(ok = true, kind = "repeating", fires = fires, exhausted = fires.size < count)
    }

    // -----------------------------------------------------------------------------------
    // Android channels
    // -----------------------------------------------------------------------------------

    data class Importance(
        val word: String,
        val android: Int,
        val ios: String,
        val headsUp: Boolean,
        val sound: Boolean,
    )

    /** Six words, exact case. `android` is the real NotificationManager constant; `ios` is the
     *  UNNotificationInterruptionLevel the same intent maps to. `critical` is deliberately absent
     *  from the iOS column: it needs an Apple entitlement, and a channel word must never be the
     *  thing that silently asks for one. */
    val IMPORTANCE: List<Importance> = listOf(
        Importance("none", 0, "passive", headsUp = false, sound = false),
        Importance("min", 1, "passive", headsUp = false, sound = false),
        Importance("low", 2, "passive", headsUp = false, sound = false),
        Importance("default", 3, "active", headsUp = false, sound = true),
        Importance("high", 4, "timeSensitive", headsUp = true, sound = true),
        Importance("max", 5, "timeSensitive", headsUp = true, sound = true),
    )

    const val DEFAULT_IMPORTANCE: String = "default"

    /** Channels arrived in Android 8. Below it a channel id is meaningless, not an error. */
    const val ANDROID_CHANNEL_SDK: Int = 26

    /** `null` is the typed refusal (`invalid_argument`): a word that is not an importance is
     *  never rounded to the nearest one. */
    fun importance(word: String?): Importance? {
        val trimmed = (word ?: "").trim()
        val wanted = if (trimmed.isEmpty()) DEFAULT_IMPORTANCE else trimmed
        return IMPORTANCE.firstOrNull { it.word == wanted }
    }

    data class ChannelState(
        val importance: String,
        /** The user changed this channel's importance themselves. Android then ignores the app. */
        val userSet: Boolean = false,
        val blocked: Boolean = false,
    )

    data class ChannelFold(
        val ok: Boolean,
        val importance: String? = null,
        val created: Boolean = false,
        val changed: Boolean = false,
        val lockedByUser: Boolean = false,
        val blocked: Boolean = false,
        val error: String? = null,
    )

    /**
     * What a `channels.set` will ACTUALLY produce.
     *
     * THE RULE EVERY LIBRARY GETS WRONG: once a channel exists, Android lets the app LOWER its
     * importance and silently ignores every attempt to raise it, and it remembers a user's own
     * choice forever - deleting and recreating the id does not reset it. So this is not an update,
     * it is a negotiation, and the answer says what the channel will be rather than what was asked
     * for. `lockedByUser` is what a settings screen needs in order to say "you turned this down"
     * instead of rendering a control that does nothing.
     */
    fun channelFold(existing: ChannelState?, requested: String?): ChannelFold {
        val wanted = importance(requested)
            ?: return ChannelFold(ok = false, error = "invalid_argument")
        if (existing == null) {
            return ChannelFold(
                ok = true, importance = wanted.word, created = true, changed = true,
                lockedByUser = false, blocked = false,
            )
        }
        val held = importance(existing.importance) ?: IMPORTANCE[3]
        val lockedByUser = existing.userSet
        val blocked = existing.blocked
        if (lockedByUser || wanted.android >= held.android) {
            return ChannelFold(
                ok = true, importance = held.word, created = false, changed = false,
                lockedByUser = lockedByUser, blocked = blocked,
            )
        }
        return ChannelFold(
            ok = true, importance = wanted.word, created = false, changed = true,
            lockedByUser = lockedByUser, blocked = blocked,
        )
    }

    data class ChannelRequirement(
        val ok: Boolean,
        val channel: String? = null,
        val error: String? = null,
    )

    /** The module's own channel, created at first use so that an app which never thinks about
     *  channels still works. */
    const val DEFAULT_CHANNEL: String = "default"

    /**
     * Can this notification be posted.
     *
     * On Android 8+ a post to a channel that was never created is DROPPED BY THE OS - no
     * exception, no log line, no callback. That is the number-one cause of "push does not
     * arrive". Refuse first, and NAME THE ID.
     */
    fun channelRequired(
        platform: String,
        sdk: Int,
        channel: String?,
        known: List<String>,
    ): ChannelRequirement {
        if (platform != "android" || sdk < ANDROID_CHANNEL_SDK) {
            return ChannelRequirement(ok = true, channel = null)
        }
        val id = (channel ?: "").trim()
        if (id.isEmpty()) return ChannelRequirement(ok = true, channel = DEFAULT_CHANNEL)
        if (id in known) return ChannelRequirement(ok = true, channel = id)
        return ChannelRequirement(ok = false, channel = id, error = "channel_required")
    }

    // -----------------------------------------------------------------------------------
    // Foreground presentation
    // -----------------------------------------------------------------------------------

    /** The four words, canonical order - which is the order they are reported in, never sorted. */
    val PRESENTATION_WORDS: List<String> = listOf("alert", "sound", "badge", "list")

    /** `banner` is what the platforms call it in their own settings UI. */
    val PRESENTATION_ALIASES: Map<String, String> = mapOf("banner" to "alert")

    data class Presentation(
        val ok: Boolean,
        val present: List<String> = emptyList(),
        val suppressed: Boolean = false,
        val headsUp: Boolean = false,
        val dropped: List<String> = emptyList(),
        val degraded: List<String> = emptyList(),
        val error: String? = null,
    )

    /**
     * What a notification does while the app is open.
     *
     * THE DEFAULT IS NOTHING, on every platform, and it surprises every author. iOS makes it a
     * delegate callback nobody implements; Android makes it a channel-importance question; the
     * browser shows the notification but the page usually never hears about it. One word decides
     * it everywhere.
     */
    fun presentation(
        configured: List<String>?,
        claimed: Boolean,
        platform: String,
        importanceWord: String? = null,
    ): Presentation {
        val words = ArrayList<String>()
        for (raw in configured ?: emptyList()) {
            val word = PRESENTATION_ALIASES[raw] ?: raw
            if (word !in PRESENTATION_WORDS) return Presentation(ok = false, error = "invalid_argument")
            if (word !in words) words.add(word)
        }

        // A CLAIMED notify.received suppresses the system presentation, whatever was configured -
        // that is the entire point of a claimable hook.
        if (claimed) return Presentation(ok = true, suppressed = true)

        if (platform == "android") {
            // The OS posts it regardless: `list` is implicit and cannot be configured away. A
            // heads-up needs BOTH the alert word and a high-importance channel, and the channel
            // wins.
            val present = PRESENTATION_WORDS.filter { it in words || it == "list" }
            val level = importance(importanceWord) ?: IMPORTANCE[3]
            val headsUp = "alert" in words && level.headsUp
            val degraded = if ("alert" in words && !level.headsUp) listOf("alert") else emptyList()
            return Presentation(
                ok = true, present = present, suppressed = false, headsUp = headsUp,
                dropped = emptyList(), degraded = degraded,
            )
        }

        if (platform == "web") {
            // There is no notification list to land in. Say so rather than accepting the word.
            val dropped = if ("list" in words) listOf("list") else emptyList()
            val present = PRESENTATION_WORDS.filter { it in words && it != "list" }
            return Presentation(
                ok = true, present = present, suppressed = false,
                headsUp = "alert" in present, dropped = dropped,
            )
        }

        val present = PRESENTATION_WORDS.filter { it in words }
        return Presentation(ok = true, present = present, suppressed = false, headsUp = "alert" in present)
    }

    // -----------------------------------------------------------------------------------
    // The host seam
    // -----------------------------------------------------------------------------------

    /**
     * THE FOREGROUND-PRESENTATION OVERRIDE the host answers a foreground delivery from.
     *
     * `null` means NOBODY CONFIGURED IT, and the host keeps its own pre-module answer - so a build
     * with Core/Notify excluded is byte-identical to before the module existed (Article 7). The
     * module writes it; the host reads it. Same shape, and the same reason, as
     * `StackOrientation.activeMask`.
     */
    @Volatile
    var activeForeground: List<String>? = null
        private set

    /** Publish (or clear, with null) the runtime override. Returns whether it changed. */
    fun setActiveForeground(words: List<String>?): Boolean {
        if (activeForeground == words) return false
        activeForeground = words
        return true
    }

    // -----------------------------------------------------------------------------------
    // Tap routing
    // -----------------------------------------------------------------------------------

    /** The platform constants for "the user tapped the notification body". Normalised AWAY, so
     *  that `if (payload.actionId != null)` means what it reads like. */
    val DEFAULT_ACTION_IDS: List<String> = listOf(
        "com.apple.UNNotificationDefaultActionIdentifier", "android.intent.action.MAIN", "default",
    )

    val DISMISS_ACTION_IDS: List<String> = listOf(
        "com.apple.UNNotificationDismissActionIdentifier",
    )

    data class RawOpen(
        val id: String? = null,
        val actionId: String? = null,
        val userText: String? = null,
        val data: Map<String, Any?>? = null,
    )

    data class OpenPayload(
        val kind: String,
        val id: String,
        val data: Map<String, Any?>,
        val coldStart: Boolean,
        val actionId: String? = null,
        val userText: String? = null,
    )

    /** One tap arrives in four envelope shapes - plain, action button, text-input action, and a
     *  COLD START where the app was not running. All four end up here, or an app routes three of
     *  them and loses the fourth. */
    fun openPayload(raw: RawOpen, coldStart: Boolean): OpenPayload {
        val id = raw.id ?: ""
        val actionId = raw.actionId ?: ""
        if (actionId in DISMISS_ACTION_IDS) {
            return OpenPayload(kind = "dismissed", id = id, data = emptyMap(), coldStart = coldStart)
        }
        val data = raw.data ?: emptyMap()
        val named = actionId.isNotEmpty() && actionId !in DEFAULT_ACTION_IDS
        // An EMPTY reply is still a reply, so `userText` rides whenever the platform gave us one.
        if (named && raw.userText != null) {
            return OpenPayload(
                kind = "opened", id = id, data = data, coldStart = coldStart,
                actionId = actionId, userText = raw.userText,
            )
        }
        if (named) {
            return OpenPayload(
                kind = "opened", id = id, data = data, coldStart = coldStart, actionId = actionId,
            )
        }
        return OpenPayload(kind = "opened", id = id, data = data, coldStart = coldStart)
    }

    const val PATH_BYTES: Int = 8192
    const val URL_BYTES: Int = 8192
    const val EVENT_BYTES: Int = 65536

    /** The UTF-8 length, counted the way the TS twin counts it (a lone surrogate is three bytes,
     *  which is what `String.codePointAt` reports and what a JVM UTF-8 encoder would not). */
    private fun utf8Length(text: String): Int {
        var total = 0
        var i = 0
        while (i < text.length) {
            val code = text.codePointAt(i)
            when {
                code > 0xffff -> { total += 4; i += 2 }
                code > 0x7ff -> { total += 3; i += 1 }
                code > 0x7f -> { total += 2; i += 1 }
                else -> { total += 1; i += 1 }
            }
        }
        return total
    }

    private fun hasControlCharacter(text: String): Boolean =
        text.any { it.code < 0x20 || it.code == 0x7f }

    data class RoutingRecord(val path: String?, val url: String?)

    /**
     * The record `Mandatory/PushRouting` already consumes for a VENDOR open, produced for a
     * first-party one.
     *
     * The bounds are restated rather than skipped: a first-party payload must not be the one that
     * gets to bypass the checks a Firebase payload goes through. A field that fails a bound is
     * dropped; the OPEN still happens, because losing the whole event over a bad deep link is a
     * worse failure than losing the deep link.
     */
    fun routingRecord(data: Map<String, Any?>?): RoutingRecord {
        val fields = data ?: emptyMap()
        val rawPath = fields["path"] as? String ?: ""
        val rawURL = fields["url"] as? String ?: ""

        var path: String? = null
        if (rawPath.startsWith("/") && !rawPath.startsWith("//") &&
            !hasControlCharacter(rawPath) && utf8Length(rawPath) <= PATH_BYTES
        ) {
            path = rawPath
        }

        var url: String? = null
        val lower = rawURL.lowercase()
        if ((lower.startsWith("http://") || lower.startsWith("https://")) &&
            !hasControlCharacter(rawURL) && utf8Length(rawURL) <= URL_BYTES
        ) {
            val authority = rawURL.substring(rawURL.indexOf("://") + 3).substringBefore("/")
            // Credentials in a notification URL are how a phishing payload borrows an app's trust.
            if (!authority.contains("@")) url = rawURL
        }

        return RoutingRecord(path = path, url = url)
    }
}
