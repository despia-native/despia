//
//  Forms.kt - THE FORMS PURE CORE (U08), the Kotlin twin of @despia/kernel forms.ts and of
//  Engine/iOS/Forms.swift. The input MASK engine, E.164 parse/format/validate over the one
//  shared country table, the DATE-RANGE validity fold, form VALIDITY aggregation with the
//  submit gate, and the <multiselect> / <tagsfield> folds with the accessibility
//  announcements all three renderers must speak identically.
//
//  The law is the corpus: OpenSource/Conformance/forms/{mask,countries,phone,daterange,
//  validation,composites}.json (parity/U08-forms.md), executed here by :core
//  FormsConformanceTest, on the web by packages/kernel/test/forms-conformance.test.ts, and on
//  iOS by the record lane (FormsConformance.swift). Three implementations of "where is the
//  caret after an edit in the middle of a masked value" would be three different bugs; there
//  is one answer and it is data.
//
//  PURE by construction: pure JVM, no Android import, no java.time, no locale - everything a
//  renderer needs is a function of its arguments, which is what lets one corpus judge three
//  runtimes. Date arithmetic is the proleptic-Gregorian day count, so a DST transition day is
//  exactly one day long here and the 23-hour bug cannot be expressed.
//
package despia.engine

object Forms {

    // ─────────────────────────────────────────────────────────────────────────────
    // MASK
    // ─────────────────────────────────────────────────────────────────────────────

    /** `#` a digit · `A` an ASCII letter · `*` an ASCII letter or digit · `lit` a literal. */
    data class MaskToken(val kind: String, val ch: Char)

    data class MaskEdit(
        /** The corrected display text. */
        val display: String,
        /** Where the caret belongs in [display] (the part naive implementations get wrong). */
        val caret: Int,
        /** The UNMASKED value - what `bind` receives. */
        val raw: String,
        /** Every placeholder is filled. */
        val complete: Boolean,
    )

    private fun isDigit(ch: Char): Boolean = ch in '0'..'9'

    private fun isLetter(ch: Char): Boolean = ch in 'A'..'Z' || ch in 'a'..'z'

    fun maskTokens(mask: String): List<MaskToken> {
        val out = ArrayList<MaskToken>(mask.length)
        var i = 0
        while (i < mask.length) {
            val ch = mask[i]
            if (ch == '\\' && i + 1 < mask.length) {
                out.add(MaskToken("lit", mask[i + 1])); i += 2; continue
            }
            if (ch == '#' || ch == 'A' || ch == '*') out.add(MaskToken(ch.toString(), ch))
            else out.add(MaskToken("lit", ch))
            i += 1
        }
        return out
    }

    private fun slotAccepts(kind: String, ch: Char): Boolean = when (kind) {
        "#" -> isDigit(ch)
        "A" -> isLetter(ch)
        "*" -> isDigit(ch) || isLetter(ch)
        else -> false
    }

    /** The number of placeholder slots - the mask's implicit maxLength. */
    fun maskCapacity(mask: String): Int = maskTokens(mask).count { it.kind != "lit" }

    /** THE EXTRACTION LAW: significant iff SOME placeholder class in the mask accepts it. */
    fun maskSignificant(tokens: List<MaskToken>, ch: Char): Boolean =
        tokens.any { it.kind != "lit" && slotAccepts(it.kind, ch) }

    /** The UNMASKED value of arbitrary text - literals and rejected characters fall away. */
    fun maskExtract(mask: String, text: String): String {
        val tokens = maskTokens(mask)
        val out = StringBuilder()
        for (ch in text) if (maskSignificant(tokens, ch)) out.append(ch)
        return out.toString()
    }

    private data class MaskPlacement(val display: String, val sources: List<Int>)

    /**
     * THE LAZY-LITERAL FORMAT LAW: a literal is emitted only while raw characters remain, so
     * `(415` never shows a dangling `) `. A raw character the slot rejects is skipped - and
     * `sources` records WHICH raw index landed in each slot, which is what lets the edit law
     * keep the value and the display one thing instead of two.
     */
    private fun maskPlace(mask: String, raw: String): MaskPlacement {
        val tokens = maskTokens(mask)
        val out = StringBuilder()
        val sources = ArrayList<Int>()
        var ri = 0
        for (token in tokens) {
            if (ri >= raw.length) break
            if (token.kind == "lit") { out.append(token.ch); continue }
            while (ri < raw.length && !slotAccepts(token.kind, raw[ri])) ri += 1
            if (ri >= raw.length) break
            out.append(raw[ri])
            sources.add(ri)
            ri += 1
        }
        return MaskPlacement(out.toString(), sources)
    }

    fun maskFormat(mask: String, raw: String): String = maskPlace(mask, raw).display

    private fun displayIndexAfter(tokens: List<MaskToken>, display: String, n: Int): Int {
        if (n <= 0) return 0
        var seen = 0
        for (i in display.indices) {
            if (maskSignificant(tokens, display[i])) {
                seen += 1
                if (seen == n) return i + 1
            }
        }
        return display.length
    }

    /**
     * THE EDIT LAW. `prev[selStart:selEnd]` is replaced by [insert] - the one primitive
     * UIKit's `shouldChangeCharactersIn`, the web's `beforeinput` target range and Compose's
     * `TextFieldValue` diff all reduce to.
     *
     * THE SEPARATOR SWALLOW LAW: a deletion whose removed span holds no significant character
     * extends to swallow the nearest significant character to its LEFT, else the nearest to
     * its RIGHT. Without it, backspacing over `) ` is a no-op and the field feels broken.
     *
     * THE PLACEMENT LAW: `raw` is the significant characters the mask ACCEPTED. A character
     * no remaining slot will take is dropped from the value as well as from the display, so
     * `bind` never carries text the field does not show.
     */
    fun maskEdit(mask: String, prev: String, selStart: Int, selEnd: Int, insert: String): MaskEdit {
        val tokens = maskTokens(mask)
        val n = prev.length
        var s = maxOf(0, minOf(selStart, n))
        var e = maxOf(s, minOf(selEnd, n))
        if (insert.isEmpty() && e > s && maskExtract(mask, prev.substring(s, e)).isEmpty()) {
            var i = s - 1
            while (i >= 0 && !maskSignificant(tokens, prev[i])) i -= 1
            if (i >= 0) {
                s = i
            } else {
                var j = e
                while (j < n && !maskSignificant(tokens, prev[j])) j += 1
                if (j < n) e = j + 1
            }
        }
        val cap = maskCapacity(mask)
        val head = maskExtract(mask, prev.substring(0, s)) + maskExtract(mask, insert)
        val candidate = head + maskExtract(mask, prev.substring(e))
        val placement = maskPlace(mask, candidate)
        val raw = StringBuilder()
        var headPlaced = 0
        for (index in placement.sources) {
            raw.append(candidate[index])
            if (index < head.length) headPlaced += 1
        }
        return MaskEdit(
            display = placement.display,
            caret = displayIndexAfter(tokens, placement.display, headPlaced),
            raw = raw.toString(),
            complete = raw.length == cap,
        )
    }

    private val MASK_CLASS_NAMES: Map<String, Pair<String, String>> = mapOf(
        "#" to ("digit" to "digits"),
        "A" to ("letter" to "letters"),
        "*" to ("letter or digit" to "letters or digits"),
    )

    /** A11Y: a masked field announces its EXPECTED FORMAT, not only its value. */
    fun maskDescription(mask: String): String {
        val order = ArrayList<String>()
        val counts = HashMap<String, Int>()
        for (token in maskTokens(mask)) {
            if (token.kind == "lit") continue
            if (!counts.containsKey(token.kind)) { order.add(token.kind); counts[token.kind] = 0 }
            counts[token.kind] = (counts[token.kind] ?: 0) + 1
        }
        if (order.isEmpty()) return "Format $mask"
        val parts = order.map { kind ->
            val count = counts[kind] ?: 0
            val names = MASK_CLASS_NAMES[kind] ?: ("character" to "characters")
            "$count " + if (count == 1) names.first else names.second
        }
        val phrase = if (parts.size == 1) parts[0]
        else parts.subList(0, parts.size - 1).joinToString(", ") + " and " + parts[parts.size - 1]
        return "Format $mask, $phrase"
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // E.164 - the ONE country table
    // ─────────────────────────────────────────────────────────────────────────────

    data class Country(
        val iso: String,
        val name: String,
        val dial: String,
        val trunk: String,
        val nsnMin: Int,
        val nsnMax: Int,
        /** The national display mask, present ONLY where nsnMin == nsnMax == its capacity. */
        val format: String?,
        /** Resolves a SHARED dial code (+1 -> US, +7 -> RU). */
        val primary: Boolean,
    )

    private fun c(
        iso: String, name: String, dial: String, trunk: String,
        nsnMin: Int, nsnMax: Int, format: String?, primary: Boolean,
    ): Country = Country(iso, name, dial, trunk, nsnMin, nsnMax, format, primary)

    /** The trimmed country / dial-code table. Identical to
     *  OpenSource/Conformance/forms/countries.json, which the runners assert. */
    val COUNTRIES: List<Country> = listOf(
        c("US", "United States", "1", "", 10, 10, "(###) ###-####", true),
        c("CA", "Canada", "1", "", 10, 10, "(###) ###-####", false),
        c("GB", "United Kingdom", "44", "0", 9, 10, null, true),
        c("IE", "Ireland", "353", "0", 7, 9, null, true),
        c("FR", "France", "33", "0", 9, 9, "# ## ## ## ##", true),
        c("DE", "Germany", "49", "0", 6, 11, null, true),
        c("AT", "Austria", "43", "0", 4, 13, null, true),
        c("CH", "Switzerland", "41", "0", 9, 9, "## ### ## ##", true),
        c("NL", "Netherlands", "31", "0", 9, 9, null, true),
        c("BE", "Belgium", "32", "0", 8, 9, null, true),
        c("LU", "Luxembourg", "352", "", 4, 11, null, true),
        c("ES", "Spain", "34", "", 9, 9, "### ## ## ##", true),
        c("PT", "Portugal", "351", "", 9, 9, "### ### ###", true),
        c("IT", "Italy", "39", "", 6, 11, null, true),
        c("GR", "Greece", "30", "", 10, 10, "### ### ####", true),
        c("SE", "Sweden", "46", "0", 7, 13, null, true),
        c("NO", "Norway", "47", "", 8, 8, "### ## ###", true),
        c("DK", "Denmark", "45", "", 8, 8, "## ## ## ##", true),
        c("FI", "Finland", "358", "0", 5, 12, null, true),
        c("IS", "Iceland", "354", "", 7, 9, null, true),
        c("PL", "Poland", "48", "", 9, 9, "### ### ###", true),
        c("CZ", "Czechia", "420", "", 9, 9, "### ### ###", true),
        c("SK", "Slovakia", "421", "0", 9, 9, "### ### ###", true),
        c("HU", "Hungary", "36", "06", 8, 9, null, true),
        c("RO", "Romania", "40", "0", 9, 9, "### ### ###", true),
        c("BG", "Bulgaria", "359", "0", 7, 9, null, true),
        c("HR", "Croatia", "385", "0", 8, 9, null, true),
        c("SI", "Slovenia", "386", "0", 8, 8, "## ### ###", true),
        c("RS", "Serbia", "381", "0", 8, 9, null, true),
        c("UA", "Ukraine", "380", "0", 9, 9, "## ### ####", true),
        c("RU", "Russia", "7", "8", 10, 10, " ### ###-##-##", true),
        c("KZ", "Kazakhstan", "7", "8", 10, 10, " ### ###-##-##", false),
        c("TR", "Turkey", "90", "0", 10, 10, "### ### ## ##", true),
        c("IL", "Israel", "972", "0", 8, 9, null, true),
        c("AE", "United Arab Emirates", "971", "0", 8, 9, null, true),
        c("SA", "Saudi Arabia", "966", "0", 8, 9, null, true),
        c("QA", "Qatar", "974", "", 8, 8, "#### ####", true),
        c("KW", "Kuwait", "965", "", 8, 8, "#### ####", true),
        c("EG", "Egypt", "20", "0", 9, 10, null, true),
        c("ZA", "South Africa", "27", "0", 9, 9, "## ### ####", true),
        c("NG", "Nigeria", "234", "0", 7, 10, null, true),
        c("KE", "Kenya", "254", "0", 9, 9, "### ######", true),
        c("GH", "Ghana", "233", "0", 9, 9, "## ### ####", true),
        c("MA", "Morocco", "212", "0", 9, 9, "### ######", true),
        c("IN", "India", "91", "0", 10, 10, "##### #####", true),
        c("PK", "Pakistan", "92", "0", 10, 10, "### #######", true),
        c("BD", "Bangladesh", "880", "0", 10, 10, null, true),
        c("LK", "Sri Lanka", "94", "0", 9, 9, "## ### ####", true),
        c("CN", "China", "86", "0", 5, 12, null, true),
        c("HK", "Hong Kong", "852", "", 8, 8, "#### ####", true),
        c("TW", "Taiwan", "886", "0", 8, 9, null, true),
        c("JP", "Japan", "81", "0", 9, 10, null, true),
        c("KR", "South Korea", "82", "0", 8, 10, null, true),
        c("SG", "Singapore", "65", "", 8, 8, "#### ####", true),
        c("MY", "Malaysia", "60", "0", 8, 10, null, true),
        c("TH", "Thailand", "66", "0", 9, 9, "## ### ####", true),
        c("VN", "Vietnam", "84", "0", 9, 10, null, true),
        c("ID", "Indonesia", "62", "0", 9, 12, null, true),
        c("PH", "Philippines", "63", "0", 10, 10, "### ### ####", true),
        c("AU", "Australia", "61", "0", 9, 9, "### ### ###", true),
        c("NZ", "New Zealand", "64", "0", 8, 10, null, true),
        c("BR", "Brazil", "55", "0", 10, 11, null, true),
        c("AR", "Argentina", "54", "0", 10, 11, null, true),
        c("CL", "Chile", "56", "", 9, 9, "# #### ####", true),
        c("CO", "Colombia", "57", "", 10, 10, "### #######", true),
        c("PE", "Peru", "51", "0", 8, 9, null, true),
        c("VE", "Venezuela", "58", "0", 10, 10, null, true),
        c("MX", "Mexico", "52", "", 10, 10, "### ### ####", true),
        c("CR", "Costa Rica", "506", "", 8, 8, "#### ####", true),
        c("PA", "Panama", "507", "", 8, 8, "#### ####", true),
    )

    const val DEFAULT_COUNTRY = "US"

    private val BY_ISO: Map<String, Country> = COUNTRIES.associateBy { it.iso }

    fun country(iso: String?): Country? = BY_ISO[(iso ?: "").uppercase()]

    /** A11Y + UI: the flag is a pure function of the ISO code, never table data. */
    fun flag(iso: String?): String {
        val code = (iso ?: "").uppercase()
        if (code.length != 2 || !isLetter(code[0]) || !isLetter(code[1])) return ""
        val first = 0x1F1E6 + (code[0].code - 'A'.code)
        val second = 0x1F1E6 + (code[1].code - 'A'.code)
        return String(Character.toChars(first)) + String(Character.toChars(second))
    }

    /** Longest PRIMARY dial-code prefix. A shared code resolves to its primary; refining
     *  +1 by area code is a named absence (forms/README.md). */
    fun countryForDial(digits: String): Country? {
        var best: Country? = null
        for (entry in COUNTRIES) {
            if (!entry.primary) continue
            if (!digits.startsWith(entry.dial)) continue
            val current = best
            if (current == null || entry.dial.length > current.dial.length) best = entry
        }
        return best
    }

    data class PhoneValue(
        val e164: String,
        val national: String,
        val country: String?,
        val dialCode: String,
        val nsn: String,
        val valid: Boolean,
    )

    private fun digitsOf(text: String): String {
        val out = StringBuilder()
        for (ch in text) if (isDigit(ch)) out.append(ch)
        return out.toString()
    }

    /** THE PARSE LAW - forms/README.md. `bind` receives `e164`. */
    fun phoneParse(text: String?, defaultCountry: String?): PhoneValue {
        val source = text ?: ""
        val plus = source.trimStart().startsWith("+")
        var digits = digitsOf(source)
        var intl = plus
        if (!plus && digits.startsWith("00")) { intl = true; digits = digits.substring(2) }

        val resolved: Country
        val nsn: String
        if (intl) {
            val found = countryForDial(digits)
                ?: return PhoneValue("+$digits", digits, null, "", digits, false)
            resolved = found
            nsn = digits.substring(found.dial.length)
        } else {
            val found = country(defaultCountry)
                ?: return PhoneValue("", digits, null, "", digits, false)
            resolved = found
            val trunk = found.trunk
            val dial = found.dial
            nsn = when {
                trunk.isNotEmpty() && digits.startsWith(trunk) -> digits.substring(trunk.length)
                trunk.isEmpty() && digits.startsWith(dial) &&
                    digits.length - dial.length >= found.nsnMin &&
                    digits.length - dial.length <= found.nsnMax -> digits.substring(dial.length)
                else -> digits
            }
        }
        val format = resolved.format
        val national = resolved.trunk + if (format != null) maskFormat(format, nsn) else nsn
        return PhoneValue(
            e164 = "+" + resolved.dial + nsn,
            national = national,
            country = resolved.iso,
            dialCode = resolved.dial,
            nsn = nsn,
            valid = nsn.length >= resolved.nsnMin && nsn.length <= resolved.nsnMax && !nsn.startsWith("0"),
        )
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // DATE RANGE - civil dates only, no timezone anywhere
    // ─────────────────────────────────────────────────────────────────────────────

    /** Howard Hinnant's days_from_civil: the proleptic-Gregorian day count from 1970-01-01. */
    fun daysFromCivil(y: Int, m: Int, d: Int): Int {
        val yy = y - if (m <= 2) 1 else 0
        val era = Math.floorDiv(if (yy >= 0) yy else yy - 399, 400)
        val yoe = yy - era * 400
        val doy = (153 * (m + (if (m > 2) -3 else 9)) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    fun civilFromDays(z0: Int): Triple<Int, Int, Int> {
        val z = z0 + 719468
        val era = Math.floorDiv(if (z >= 0) z else z - 146096, 146097)
        val doe = z - era * 146097
        val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        val y = yoe + era * 400
        val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        val mp = (5 * doy + 2) / 153
        val d = doy - (153 * mp + 2) / 5 + 1
        val m = mp + if (mp < 10) 3 else -9
        return Triple(y + if (m <= 2) 1 else 0, m, d)
    }

    /** The day count of an ISO civil date, or null when the date does not exist. */
    fun dayNumber(iso: String?): Int? {
        val s = iso ?: ""
        if (s.length < 10) return null
        if (s[4] != '-' || s[7] != '-') return null
        for (i in intArrayOf(0, 1, 2, 3, 5, 6, 8, 9)) if (!isDigit(s[i])) return null
        val y = s.substring(0, 4).toInt()
        val m = s.substring(5, 7).toInt()
        val d = s.substring(8, 10).toInt()
        if (m < 1 || m > 12 || d < 1 || d > 31) return null
        val n = daysFromCivil(y, m, d)
        val (ry, rm, rd) = civilFromDays(n)
        return if (ry == y && rm == m && rd == d) n else null
    }

    private fun pad(n: Int, width: Int): String {
        var s = Math.abs(n).toString()
        while (s.length < width) s = "0$s"
        return if (n < 0) "-$s" else s
    }

    fun dateFromDay(day: Int): String {
        val (y, m, d) = civilFromDays(day)
        return pad(y, 4) + "-" + pad(m, 2) + "-" + pad(d, 2)
    }

    /** ISO weekday, 1 = Monday ... 7 = Sunday. Day 0 (1970-01-01) was a Thursday. */
    fun weekday(day: Int): Int = ((day % 7) + 7 + 3) % 7 + 1

    data class MonthGrid(val days: Int, val leading: Int, val weeks: Int)

    /** The calendar grid geometry. [firstWeekday] is ISO (1 = Monday ... 7 = Sunday). */
    fun monthGrid(year: Int, month: Int, firstWeekday: Int): MonthGrid {
        val first = daysFromCivil(year, month, 1)
        val next = daysFromCivil(if (month == 12) year + 1 else year, if (month == 12) 1 else month + 1, 1)
        val days = next - first
        val leading = ((weekday(first) - firstWeekday) % 7 + 7) % 7
        return MonthGrid(days, leading, (leading + days + 6) / 7)
    }

    data class DateFoldConfig(
        val range: Boolean = false,
        val min: String? = null,
        val max: String? = null,
        val disabledDates: List<String> = emptyList(),
        val start: String? = null,
        val end: String? = null,
        val month: String = "",
    )

    data class DateFoldEvent(val kind: String, val date: String = "", val month: String = "")

    data class DateFoldStep(
        val start: String?,
        val end: String?,
        val month: String,
        val complete: Boolean,
        val reason: String,
        val fired: List<String>,
    )

    data class Selectability(val ok: Boolean, val reason: String)

    fun selectable(config: DateFoldConfig, iso: String): Selectability {
        val n = dayNumber(iso) ?: return Selectability(false, "malformed")
        val lo = dayNumber(config.min)
        val hi = dayNumber(config.max)
        if (lo != null && n < lo) return Selectability(false, "before-min")
        if (hi != null && n > hi) return Selectability(false, "after-max")
        if (config.disabledDates.contains(iso)) return Selectability(false, "disabled")
        return Selectability(true, "")
    }

    /** THE RANGE FOLD. A select before an open start RESTARTS the range (never a silent
     *  swap); a close whose span contains a disabled date is refused WHOLE. */
    fun dateFold(config: DateFoldConfig, events: List<DateFoldEvent>): List<DateFoldStep> {
        val range = config.range
        val disabled = config.disabledDates
        var start: String? = config.start
        var end: String? = config.end
        var month = config.month
        val steps = ArrayList<DateFoldStep>(events.size)
        for (event in events) {
            var reason = ""
            var fired: List<String> = emptyList()
            when (event.kind) {
                "select" -> {
                    val sel = selectable(config, event.date)
                    if (!sel.ok) {
                        reason = sel.reason
                    } else if (!range) {
                        start = event.date; end = event.date
                    } else if (start == null || end != null) {
                        start = event.date; end = null
                    } else if ((dayNumber(event.date) ?: 0) < (dayNumber(start) ?: 0)) {
                        start = event.date; end = null
                    } else {
                        val from = dayNumber(start) ?: 0
                        val to = dayNumber(event.date) ?: 0
                        var blocked = false
                        var day = from
                        while (day <= to) {
                            if (disabled.contains(dateFromDay(day))) { blocked = true; break }
                            day += 1
                        }
                        if (blocked) reason = "range-contains-disabled" else end = event.date
                    }
                }
                "month" -> {
                    if (event.month != month) { month = event.month; fired = listOf("month") }
                }
                else -> { start = null; end = null }
            }
            steps.add(
                DateFoldStep(
                    start = start, end = end, month = month,
                    complete = if (range) start != null && end != null else start != null,
                    reason = reason, fired = fired,
                )
            )
        }
        return steps
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // VALIDITY
    // ─────────────────────────────────────────────────────────────────────────────

    private val EMAIL_RE = Regex("^[A-Z0-9._%+\\-]+@[A-Z0-9.\\-]+\\.[A-Z]{2,}$", RegexOption.IGNORE_CASE)
    private val PHONE_RE = Regex("^[+]?[0-9 ()\\-]{7,}$")

    /** The PORTABLE twin of the JSE `url()` rule (which uses the URL constructor); the two
     *  agree on every corpus case, and this one is expressible on all three runtimes. */
    private val URL_RE = Regex("^[A-Za-z][A-Za-z0-9+.\\-]*://[^\\s/?#]+\\S*$")

    private fun numberArg(arg: String): Int {
        val value = arg.trim().toDoubleOrNull() ?: return 0
        if (value.isNaN()) return 0
        return value.toInt()
    }

    /** `required` is the ONLY rule an empty value can fail. */
    fun rule(name: String, arg: String, value: String, pattern: String): Boolean {
        val v = value
        if (name == "required") return v.trim().isNotEmpty()
        if (v.isEmpty()) return true
        return when (name) {
            "email" -> EMAIL_RE.containsMatchIn(v)
            "phone" -> PHONE_RE.containsMatchIn(v)
            "url" -> URL_RE.containsMatchIn(v)
            "minLength" -> v.length >= numberArg(arg)
            "maxLength" -> v.length <= numberArg(arg)
            "pattern", "regex" -> {
                val p = if (arg.isNotEmpty()) arg else pattern
                if (p.isEmpty()) true
                else try { Regex(p).containsMatchIn(v) } catch (_: Throwable) { false }
            }
            else -> true
        }
    }

    data class FieldState(
        val name: String,
        val value: String = "",
        val initial: String = "",
        val validate: String = "",
        val pattern: String = "",
        val message: String = "",
    )

    private val RULE_MESSAGES: Map<String, String> = mapOf(
        "required" to "Required",
        "email" to "Enter a valid email",
        "url" to "Enter a valid URL",
        "phone" to "Enter a valid phone number",
        "pattern" to "Invalid format",
        "regex" to "Invalid format",
    )

    /** The FIRST failing rule owns the message; `message=` overrides it. */
    fun fieldError(field: FieldState): String {
        val specs = field.validate.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        for (spec in specs) {
            val colon = spec.indexOf(':')
            val name = if (colon < 0) spec else spec.substring(0, colon)
            val arg = if (colon < 0) "" else spec.substring(colon + 1)
            if (rule(name, arg, field.value, field.pattern)) continue
            if (field.message.isNotEmpty()) return field.message
            if (name == "minLength") return "Must be at least $arg characters"
            if (name == "maxLength") return "Must be at most $arg characters"
            return RULE_MESSAGES[name] ?: "Invalid"
        }
        return ""
    }

    data class FormAggregate(
        val valid: Boolean,
        val dirty: Boolean,
        val errors: Map<String, String>,
        /** The `on:invalid` payload: the offending names in REGISTRATION order. */
        val invalid: List<String>,
    )

    fun aggregate(fields: List<FieldState>): FormAggregate {
        val errors = LinkedHashMap<String, String>()
        val invalid = ArrayList<String>()
        var dirty = false
        for (field in fields) {
            val error = fieldError(field)
            errors[field.name] = error
            if (error.isNotEmpty()) invalid.add(field.name)
            if (field.value != field.initial) dirty = true
        }
        return FormAggregate(invalid.isEmpty(), dirty, errors, invalid)
    }

    data class SubmitOutcome(
        val action: String,
        val reason: String,
        val fields: List<String>,
        val submitting: Boolean,
        val submitted: Boolean,
        val touchedAll: Boolean,
        val disabled: Boolean,
    )

    /** THE DOUBLE-SUBMIT LAW: a submit already in flight, or a disabled form, runs nothing. */
    fun submit(submitting: Boolean, disabled: Boolean, fields: List<FieldState>): SubmitOutcome {
        if (disabled) {
            return SubmitOutcome("blocked", "disabled", emptyList(), submitting, false, false, true)
        }
        if (submitting) {
            return SubmitOutcome("blocked", "in-flight", emptyList(), true, false, false, false)
        }
        val agg = aggregate(fields)
        if (!agg.valid) {
            return SubmitOutcome("invalid", "", agg.invalid, false, true, true, false)
        }
        return SubmitOutcome("submit", "", emptyList(), true, true, false, false)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // <multiselect> / <tagsfield>
    // ─────────────────────────────────────────────────────────────────────────────

    data class MultiSelectResult(val selected: List<String>, val changed: Boolean, val reason: String)

    /** Insertion-ordered. Adding at `max` is REFUSED, never a silent eviction. */
    fun multiSelectToggle(selected: List<String>, value: String, max: Int): MultiSelectResult {
        if (selected.contains(value)) {
            return MultiSelectResult(selected.filter { it != value }, true, "")
        }
        if (max > 0 && selected.size >= max) {
            return MultiSelectResult(selected.toList(), false, "max-reached")
        }
        return MultiSelectResult(selected + value, true, "")
    }

    /** A11Y: `<multiselect>` announces the running selection COUNT. */
    fun multiSelectAnnouncement(count: Int, max: Int): String {
        if (count == 0) return "None selected"
        val noun = if (count == 1) "item" else "items"
        return if (max > 0) "$count of $max $noun selected" else "$count $noun selected"
    }

    data class TagsConfig(val separator: String = "", val max: Int = 0, val validate: String = "")

    data class TagRejection(val tag: String, val reason: String)

    data class TagsResult(
        val tags: List<String>,
        val added: List<String>,
        val rejected: List<TagRejection>,
    )

    /** Split on every character of `separator`, trim, drop empties, refuse duplicates,
     *  pattern failures and anything past `max` - the refusals are RETURNED so `on:add`
     *  can report them, never swallowed. */
    fun tagsAdd(tags: List<String>, text: String, config: TagsConfig): TagsResult {
        val seps = if (config.separator.isNotEmpty()) config.separator else ","
        val out = ArrayList(tags)
        val added = ArrayList<String>()
        val rejected = ArrayList<TagRejection>()
        val parts = ArrayList<String>()
        val buf = StringBuilder()
        for (ch in text) {
            if (seps.contains(ch)) { parts.add(buf.toString()); buf.setLength(0) } else buf.append(ch)
        }
        parts.add(buf.toString())
        val max = config.max
        val re: Regex? =
            if (config.validate.isNotEmpty()) try { Regex(config.validate) } catch (_: Throwable) { null }
            else null
        for (part in parts) {
            val tag = part.trim()
            if (tag.isEmpty()) continue
            if (out.contains(tag)) { rejected.add(TagRejection(tag, "duplicate")); continue }
            if (max > 0 && out.size >= max) { rejected.add(TagRejection(tag, "max-reached")); continue }
            if (config.validate.isNotEmpty() && (re == null || !re.containsMatchIn(tag))) {
                rejected.add(TagRejection(tag, "invalid")); continue
            }
            out.add(tag)
            added.add(tag)
        }
        return TagsResult(out, added, rejected)
    }

    data class TagsBackspace(val tags: List<String>, val removed: String?)

    /** Backspace on an EMPTY query removes the last chip - the interaction everyone expects
     *  and nobody implements. With text in the query it removes nothing. */
    fun tagsBackspace(tags: List<String>, query: String): TagsBackspace {
        if (query.isNotEmpty() || tags.isEmpty()) return TagsBackspace(tags.toList(), null)
        return TagsBackspace(tags.subList(0, tags.size - 1).toList(), tags[tags.size - 1])
    }

    /** A11Y: `<tagsfield>` announces every add and every remove with the running count. */
    fun tagsAnnouncement(kind: String, tag: String, count: Int): String {
        val verb = if (kind == "add") "added" else "removed"
        val noun = if (count == 1) "tag" else "tags"
        return "$tag $verb, $count $noun"
    }
}
