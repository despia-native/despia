//
//  Forms.swift
//  DespiaScript
//
//  THE FORMS PURE CORE (U08) — the input MASK engine, E.164 parse/format/validate over the one
//  shared country table, the DATE-RANGE validity fold, form VALIDITY aggregation with the
//  submit gate, and the `<multiselect>` / `<tagsfield>` folds with the accessibility
//  announcements all three renderers must speak identically.
//
//  The law is the corpus: OpenSource/Conformance/forms/{mask,countries,phone,daterange,
//  validation,composites}.json (parity/U08-forms.md). The twin of :core Forms.kt and of the web
//  @despia/kernel forms.ts; this leg runs in the record lane through FormsConformance.swift.
//
//  WHY THESE PARTS AND NOT THE WIDGETS. Drawing a country sheet is platform work and belongs in
//  the element. What cannot live there is the ARITHMETIC: where the caret sits after an edit in
//  the middle of a masked value is the single most commonly broken behaviour in form libraries,
//  and three independent answers would be three different bugs a user finds before we do.
//
//  PURE by construction: Foundation only (NSRegularExpression for the declared validation
//  rules), no UIKit, no Calendar, no Locale. Date arithmetic is the proleptic-Gregorian day
//  count, so a DST transition day is exactly one day long here and the 23-hour bug cannot be
//  expressed.
//

import Foundation

public enum Forms {

    // ─────────────────────────────────────────────────────────────────────────────
    // MASK
    // ─────────────────────────────────────────────────────────────────────────────

    /// `#` a digit · `A` an ASCII letter · `*` an ASCII letter or digit · `lit` a literal.
    public struct MaskToken: Equatable {
        public let kind: String
        public let ch: Character
    }

    public struct MaskEdit: Equatable {
        /// The corrected display text.
        public let display: String
        /// Where the caret belongs in `display` (the part naive implementations get wrong).
        public let caret: Int
        /// The UNMASKED value — what `bind` receives.
        public let raw: String
        /// Every placeholder is filled.
        public let complete: Bool
    }

    private static func isDigit(_ ch: Character) -> Bool { ch >= "0" && ch <= "9" }

    private static func isLetter(_ ch: Character) -> Bool {
        (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")
    }

    public static func maskTokens(_ mask: String) -> [MaskToken] {
        var out: [MaskToken] = []
        let chars = Array(mask)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch == "\\", i + 1 < chars.count {
                out.append(MaskToken(kind: "lit", ch: chars[i + 1]))
                i += 2
                continue
            }
            if ch == "#" || ch == "A" || ch == "*" {
                out.append(MaskToken(kind: String(ch), ch: ch))
            } else {
                out.append(MaskToken(kind: "lit", ch: ch))
            }
            i += 1
        }
        return out
    }

    private static func slotAccepts(_ kind: String, _ ch: Character) -> Bool {
        switch kind {
        case "#": return isDigit(ch)
        case "A": return isLetter(ch)
        case "*": return isDigit(ch) || isLetter(ch)
        default: return false
        }
    }

    /// The number of placeholder slots — the mask's implicit maxLength.
    public static func maskCapacity(_ mask: String) -> Int {
        maskTokens(mask).filter { $0.kind != "lit" }.count
    }

    /// THE EXTRACTION LAW: significant iff SOME placeholder class in the mask accepts it.
    public static func maskSignificant(_ tokens: [MaskToken], _ ch: Character) -> Bool {
        for token in tokens where token.kind != "lit" && slotAccepts(token.kind, ch) { return true }
        return false
    }

    /// The UNMASKED value of arbitrary text — literals and rejected characters fall away.
    public static func maskExtract(_ mask: String, _ text: String) -> String {
        let tokens = maskTokens(mask)
        var out = ""
        for ch in text where maskSignificant(tokens, ch) { out.append(ch) }
        return out
    }

    private struct MaskPlacement {
        let display: String
        let sources: [Int]
    }

    /// THE LAZY-LITERAL FORMAT LAW: a literal is emitted only while raw characters remain, so
    /// `(415` never shows a dangling `) `. A raw character the slot rejects is skipped — and
    /// `sources` records WHICH raw index landed in each slot, which is what lets the edit law
    /// keep the value and the display one thing instead of two.
    private static func maskPlace(_ mask: String, _ raw: String) -> MaskPlacement {
        let tokens = maskTokens(mask)
        let chars = Array(raw)
        var out = ""
        var sources: [Int] = []
        var ri = 0
        for token in tokens {
            if ri >= chars.count { break }
            if token.kind == "lit" {
                out.append(token.ch)
                continue
            }
            while ri < chars.count && !slotAccepts(token.kind, chars[ri]) { ri += 1 }
            if ri >= chars.count { break }
            out.append(chars[ri])
            sources.append(ri)
            ri += 1
        }
        return MaskPlacement(display: out, sources: sources)
    }

    public static func maskFormat(_ mask: String, _ raw: String) -> String {
        maskPlace(mask, raw).display
    }

    private static func displayIndexAfter(_ tokens: [MaskToken], _ display: String, _ n: Int) -> Int {
        if n <= 0 { return 0 }
        var seen = 0
        let chars = Array(display)
        for i in 0..<chars.count where maskSignificant(tokens, chars[i]) {
            seen += 1
            if seen == n { return i + 1 }
        }
        return chars.count
    }

    /// THE EDIT LAW. `prev[selStart:selEnd]` is replaced by `insert` — the one primitive
    /// UIKit's `textField(_:shouldChangeCharactersIn:replacementString:)`, the web's
    /// `beforeinput` target range and Compose's `TextFieldValue` diff all reduce to.
    ///
    /// THE SEPARATOR SWALLOW LAW: a deletion whose removed span holds no significant character
    /// extends to swallow the nearest significant character to its LEFT, else the nearest to
    /// its RIGHT. Without it, backspacing over a pure-separator run is a no-op and the field
    /// feels broken.
    ///
    /// THE PLACEMENT LAW: `raw` is the significant characters the mask ACCEPTED. A character no
    /// remaining slot will take is dropped from the value as well as from the display, so
    /// `bind` never carries text the field does not show.
    public static func maskEdit(
        _ mask: String, _ prev: String, _ selStart: Int, _ selEnd: Int, _ insert: String
    ) -> MaskEdit {
        let tokens = maskTokens(mask)
        let prevChars = Array(prev)
        let n = prevChars.count
        var s = max(0, min(selStart, n))
        var e = max(s, min(selEnd, n))
        if insert.isEmpty, e > s, maskExtract(mask, String(prevChars[s..<e])).isEmpty {
            var i = s - 1
            while i >= 0 && !maskSignificant(tokens, prevChars[i]) { i -= 1 }
            if i >= 0 {
                s = i
            } else {
                var j = e
                while j < n && !maskSignificant(tokens, prevChars[j]) { j += 1 }
                if j < n { e = j + 1 }
            }
        }
        let cap = maskCapacity(mask)
        let head = maskExtract(mask, String(prevChars[0..<s])) + maskExtract(mask, insert)
        let candidate = head + maskExtract(mask, String(prevChars[e..<n]))
        let candidateChars = Array(candidate)
        let placement = maskPlace(mask, candidate)
        let headCount = head.count
        var raw = ""
        var headPlaced = 0
        for index in placement.sources {
            raw.append(candidateChars[index])
            if index < headCount { headPlaced += 1 }
        }
        return MaskEdit(
            display: placement.display,
            caret: displayIndexAfter(tokens, placement.display, headPlaced),
            raw: raw,
            complete: raw.count == cap
        )
    }

    private static let maskClassNames: [String: (one: String, many: String)] = [
        "#": ("digit", "digits"),
        "A": ("letter", "letters"),
        "*": ("letter or digit", "letters or digits"),
    ]

    /// A11Y: a masked field announces its EXPECTED FORMAT, not only its value.
    public static func maskDescription(_ mask: String) -> String {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for token in maskTokens(mask) {
            if token.kind == "lit" { continue }
            if counts[token.kind] == nil {
                order.append(token.kind)
                counts[token.kind] = 0
            }
            counts[token.kind] = (counts[token.kind] ?? 0) + 1
        }
        if order.isEmpty { return "Format \(mask)" }
        let parts: [String] = order.map { kind in
            let count = counts[kind] ?? 0
            let names = maskClassNames[kind] ?? ("character", "characters")
            return "\(count) \(count == 1 ? names.one : names.many)"
        }
        let phrase: String
        if parts.count == 1 {
            phrase = parts[0]
        } else {
            phrase = parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1]
        }
        return "Format \(mask), \(phrase)"
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // E.164 — the ONE country table
    // ─────────────────────────────────────────────────────────────────────────────

    public struct Country: Equatable {
        public let iso: String
        public let name: String
        public let dial: String
        public let trunk: String
        public let nsnMin: Int
        public let nsnMax: Int
        /// The national display mask, present ONLY where nsnMin == nsnMax == its capacity.
        public let format: String?
        /// Resolves a SHARED dial code (+1 → US, +7 → RU).
        public let primary: Bool
    }

    private static func c(
        _ iso: String, _ name: String, _ dial: String, _ trunk: String,
        _ nsnMin: Int, _ nsnMax: Int, _ format: String?, _ primary: Bool
    ) -> Country {
        Country(iso: iso, name: name, dial: dial, trunk: trunk,
                nsnMin: nsnMin, nsnMax: nsnMax, format: format, primary: primary)
    }

    /// The trimmed country / dial-code table. Identical to
    /// OpenSource/Conformance/forms/countries.json, which the runners assert.
    public static let countries: [Country] = [
        c("US", "United States", "1", "", 10, 10, "(###) ###-####", true),
        c("CA", "Canada", "1", "", 10, 10, "(###) ###-####", false),
        c("GB", "United Kingdom", "44", "0", 9, 10, nil, true),
        c("IE", "Ireland", "353", "0", 7, 9, nil, true),
        c("FR", "France", "33", "0", 9, 9, "# ## ## ## ##", true),
        c("DE", "Germany", "49", "0", 6, 11, nil, true),
        c("AT", "Austria", "43", "0", 4, 13, nil, true),
        c("CH", "Switzerland", "41", "0", 9, 9, "## ### ## ##", true),
        c("NL", "Netherlands", "31", "0", 9, 9, nil, true),
        c("BE", "Belgium", "32", "0", 8, 9, nil, true),
        c("LU", "Luxembourg", "352", "", 4, 11, nil, true),
        c("ES", "Spain", "34", "", 9, 9, "### ## ## ##", true),
        c("PT", "Portugal", "351", "", 9, 9, "### ### ###", true),
        c("IT", "Italy", "39", "", 6, 11, nil, true),
        c("GR", "Greece", "30", "", 10, 10, "### ### ####", true),
        c("SE", "Sweden", "46", "0", 7, 13, nil, true),
        c("NO", "Norway", "47", "", 8, 8, "### ## ###", true),
        c("DK", "Denmark", "45", "", 8, 8, "## ## ## ##", true),
        c("FI", "Finland", "358", "0", 5, 12, nil, true),
        c("IS", "Iceland", "354", "", 7, 9, nil, true),
        c("PL", "Poland", "48", "", 9, 9, "### ### ###", true),
        c("CZ", "Czechia", "420", "", 9, 9, "### ### ###", true),
        c("SK", "Slovakia", "421", "0", 9, 9, "### ### ###", true),
        c("HU", "Hungary", "36", "06", 8, 9, nil, true),
        c("RO", "Romania", "40", "0", 9, 9, "### ### ###", true),
        c("BG", "Bulgaria", "359", "0", 7, 9, nil, true),
        c("HR", "Croatia", "385", "0", 8, 9, nil, true),
        c("SI", "Slovenia", "386", "0", 8, 8, "## ### ###", true),
        c("RS", "Serbia", "381", "0", 8, 9, nil, true),
        c("UA", "Ukraine", "380", "0", 9, 9, "## ### ####", true),
        c("RU", "Russia", "7", "8", 10, 10, " ### ###-##-##", true),
        c("KZ", "Kazakhstan", "7", "8", 10, 10, " ### ###-##-##", false),
        c("TR", "Turkey", "90", "0", 10, 10, "### ### ## ##", true),
        c("IL", "Israel", "972", "0", 8, 9, nil, true),
        c("AE", "United Arab Emirates", "971", "0", 8, 9, nil, true),
        c("SA", "Saudi Arabia", "966", "0", 8, 9, nil, true),
        c("QA", "Qatar", "974", "", 8, 8, "#### ####", true),
        c("KW", "Kuwait", "965", "", 8, 8, "#### ####", true),
        c("EG", "Egypt", "20", "0", 9, 10, nil, true),
        c("ZA", "South Africa", "27", "0", 9, 9, "## ### ####", true),
        c("NG", "Nigeria", "234", "0", 7, 10, nil, true),
        c("KE", "Kenya", "254", "0", 9, 9, "### ######", true),
        c("GH", "Ghana", "233", "0", 9, 9, "## ### ####", true),
        c("MA", "Morocco", "212", "0", 9, 9, "### ######", true),
        c("IN", "India", "91", "0", 10, 10, "##### #####", true),
        c("PK", "Pakistan", "92", "0", 10, 10, "### #######", true),
        c("BD", "Bangladesh", "880", "0", 10, 10, nil, true),
        c("LK", "Sri Lanka", "94", "0", 9, 9, "## ### ####", true),
        c("CN", "China", "86", "0", 5, 12, nil, true),
        c("HK", "Hong Kong", "852", "", 8, 8, "#### ####", true),
        c("TW", "Taiwan", "886", "0", 8, 9, nil, true),
        c("JP", "Japan", "81", "0", 9, 10, nil, true),
        c("KR", "South Korea", "82", "0", 8, 10, nil, true),
        c("SG", "Singapore", "65", "", 8, 8, "#### ####", true),
        c("MY", "Malaysia", "60", "0", 8, 10, nil, true),
        c("TH", "Thailand", "66", "0", 9, 9, "## ### ####", true),
        c("VN", "Vietnam", "84", "0", 9, 10, nil, true),
        c("ID", "Indonesia", "62", "0", 9, 12, nil, true),
        c("PH", "Philippines", "63", "0", 10, 10, "### ### ####", true),
        c("AU", "Australia", "61", "0", 9, 9, "### ### ###", true),
        c("NZ", "New Zealand", "64", "0", 8, 10, nil, true),
        c("BR", "Brazil", "55", "0", 10, 11, nil, true),
        c("AR", "Argentina", "54", "0", 10, 11, nil, true),
        c("CL", "Chile", "56", "", 9, 9, "# #### ####", true),
        c("CO", "Colombia", "57", "", 10, 10, "### #######", true),
        c("PE", "Peru", "51", "0", 8, 9, nil, true),
        c("VE", "Venezuela", "58", "0", 10, 10, nil, true),
        c("MX", "Mexico", "52", "", 10, 10, "### ### ####", true),
        c("CR", "Costa Rica", "506", "", 8, 8, "#### ####", true),
        c("PA", "Panama", "507", "", 8, 8, "#### ####", true),
    ]

    public static let defaultCountry = "US"

    private static let byISO: [String: Country] = {
        var out: [String: Country] = [:]
        for entry in countries { out[entry.iso] = entry }
        return out
    }()

    public static func country(_ iso: String?) -> Country? {
        byISO[(iso ?? "").uppercased()]
    }

    /// A11Y + UI: the flag is a pure function of the ISO code, never table data.
    public static func flag(_ iso: String?) -> String {
        let code = Array((iso ?? "").uppercased())
        guard code.count == 2, isLetter(code[0]), isLetter(code[1]) else { return "" }
        guard let a = code[0].asciiValue, let b = code[1].asciiValue else { return "" }
        let base = UnicodeScalar(0x1F1E6)!.value
        guard let first = UnicodeScalar(base + UInt32(a - 65)),
              let second = UnicodeScalar(base + UInt32(b - 65)) else { return "" }
        return String(Character(first)) + String(Character(second))
    }

    /// Longest PRIMARY dial-code prefix. A shared code resolves to its primary; refining `+1`
    /// by area code is a named absence (forms/README.md).
    public static func countryForDial(_ digits: String) -> Country? {
        var best: Country?
        for entry in countries {
            if !entry.primary { continue }
            if !digits.hasPrefix(entry.dial) { continue }
            if best == nil || entry.dial.count > best!.dial.count { best = entry }
        }
        return best
    }

    public struct PhoneValue: Equatable {
        public let e164: String
        public let national: String
        public let country: String?
        public let dialCode: String
        public let nsn: String
        public let valid: Bool
    }

    private static func digitsOf(_ text: String) -> String {
        var out = ""
        for ch in text where isDigit(ch) { out.append(ch) }
        return out
    }

    /// THE PARSE LAW — forms/README.md. `bind` receives `e164`.
    public static func phoneParse(_ text: String?, _ defaultCountry: String?) -> PhoneValue {
        let source = text ?? ""
        let plus = source.drop(while: { $0 == " " || $0 == "\t" || $0 == "\n" }).hasPrefix("+")
        var digits = digitsOf(source)
        var intl = plus
        if !plus && digits.hasPrefix("00") {
            intl = true
            digits = String(digits.dropFirst(2))
        }

        let resolved: Country
        let nsn: String
        if intl {
            guard let found = countryForDial(digits) else {
                return PhoneValue(e164: "+\(digits)", national: digits, country: nil,
                                  dialCode: "", nsn: digits, valid: false)
            }
            resolved = found
            nsn = String(digits.dropFirst(found.dial.count))
        } else {
            guard let found = country(defaultCountry) else {
                return PhoneValue(e164: "", national: digits, country: nil,
                                  dialCode: "", nsn: digits, valid: false)
            }
            resolved = found
            let trunk = found.trunk
            let dial = found.dial
            if !trunk.isEmpty, digits.hasPrefix(trunk) {
                nsn = String(digits.dropFirst(trunk.count))
            } else if trunk.isEmpty, digits.hasPrefix(dial),
                      digits.count - dial.count >= found.nsnMin,
                      digits.count - dial.count <= found.nsnMax {
                nsn = String(digits.dropFirst(dial.count))
            } else {
                nsn = digits
            }
        }
        let national = resolved.trunk + (resolved.format.map { maskFormat($0, nsn) } ?? nsn)
        return PhoneValue(
            e164: "+" + resolved.dial + nsn,
            national: national,
            country: resolved.iso,
            dialCode: resolved.dial,
            nsn: nsn,
            valid: nsn.count >= resolved.nsnMin && nsn.count <= resolved.nsnMax && !nsn.hasPrefix("0")
        )
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // DATE RANGE — civil dates only, no timezone anywhere
    // ─────────────────────────────────────────────────────────────────────────────

    private static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let q = a / b
        return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
    }

    /// Howard Hinnant's days_from_civil: the proleptic-Gregorian day count from 1970-01-01.
    public static func daysFromCivil(_ y: Int, _ m: Int, _ d: Int) -> Int {
        let yy = y - (m <= 2 ? 1 : 0)
        let era = floorDiv(yy >= 0 ? yy : yy - 399, 400)
        let yoe = yy - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    public static func civilFromDays(_ z0: Int) -> (year: Int, month: Int, day: Int) {
        let z = z0 + 719468
        let era = floorDiv(z >= 0 ? z : z - 146096, 146097)
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp + (mp < 10 ? 3 : -9)
        return (y + (m <= 2 ? 1 : 0), m, d)
    }

    /// The day count of an ISO civil date, or nil when the date does not exist.
    public static func dayNumber(_ iso: String?) -> Int? {
        let chars = Array(iso ?? "")
        if chars.count < 10 { return nil }
        if chars[4] != "-" || chars[7] != "-" { return nil }
        for i in [0, 1, 2, 3, 5, 6, 8, 9] where !isDigit(chars[i]) { return nil }
        guard let y = Int(String(chars[0..<4])),
              let m = Int(String(chars[5..<7])),
              let d = Int(String(chars[8..<10])) else { return nil }
        if m < 1 || m > 12 || d < 1 || d > 31 { return nil }
        let n = daysFromCivil(y, m, d)
        let back = civilFromDays(n)
        return (back.year == y && back.month == m && back.day == d) ? n : nil
    }

    private static func pad(_ n: Int, _ width: Int) -> String {
        var s = String(abs(n))
        while s.count < width { s = "0" + s }
        return n < 0 ? "-" + s : s
    }

    public static func dateFromDay(_ day: Int) -> String {
        let civil = civilFromDays(day)
        return pad(civil.year, 4) + "-" + pad(civil.month, 2) + "-" + pad(civil.day, 2)
    }

    /// ISO weekday, 1 = Monday … 7 = Sunday. Day 0 (1970-01-01) was a Thursday.
    public static func weekday(_ day: Int) -> Int { ((day % 7) + 7 + 3) % 7 + 1 }

    public struct MonthGrid: Equatable {
        public let days: Int
        public let leading: Int
        public let weeks: Int
    }

    /// The calendar grid geometry. `firstWeekday` is ISO (1 = Monday … 7 = Sunday).
    public static func monthGrid(_ year: Int, _ month: Int, _ firstWeekday: Int) -> MonthGrid {
        let first = daysFromCivil(year, month, 1)
        let next = daysFromCivil(month == 12 ? year + 1 : year, month == 12 ? 1 : month + 1, 1)
        let days = next - first
        let leading = ((weekday(first) - firstWeekday) % 7 + 7) % 7
        return MonthGrid(days: days, leading: leading, weeks: (leading + days + 6) / 7)
    }

    public struct DateFoldConfig {
        public var range: Bool
        public var min: String?
        public var max: String?
        public var disabledDates: [String]
        public var start: String?
        public var end: String?
        public var month: String

        public init(range: Bool = false, min: String? = nil, max: String? = nil,
                    disabledDates: [String] = [], start: String? = nil, end: String? = nil,
                    month: String = "") {
            self.range = range
            self.min = min
            self.max = max
            self.disabledDates = disabledDates
            self.start = start
            self.end = end
            self.month = month
        }
    }

    public struct DateFoldEvent {
        public let kind: String
        public let date: String
        public let month: String

        public init(kind: String, date: String = "", month: String = "") {
            self.kind = kind
            self.date = date
            self.month = month
        }
    }

    public struct DateFoldStep: Equatable {
        public let start: String?
        public let end: String?
        public let month: String
        public let complete: Bool
        public let reason: String
        public let fired: [String]
    }

    public struct Selectability: Equatable {
        public let ok: Bool
        public let reason: String
    }

    public static func selectable(_ config: DateFoldConfig, _ iso: String) -> Selectability {
        guard let n = dayNumber(iso) else { return Selectability(ok: false, reason: "malformed") }
        if let lo = dayNumber(config.min), n < lo { return Selectability(ok: false, reason: "before-min") }
        if let hi = dayNumber(config.max), n > hi { return Selectability(ok: false, reason: "after-max") }
        if config.disabledDates.contains(iso) { return Selectability(ok: false, reason: "disabled") }
        return Selectability(ok: true, reason: "")
    }

    /// THE RANGE FOLD. A select before an open start RESTARTS the range (never a silent swap);
    /// a close whose span contains a disabled date is refused WHOLE, because a hotel cannot
    /// sell across a blackout night.
    public static func dateFold(_ config: DateFoldConfig, _ events: [DateFoldEvent]) -> [DateFoldStep] {
        let range = config.range
        let disabled = config.disabledDates
        var start = config.start
        var end = config.end
        var month = config.month
        var steps: [DateFoldStep] = []
        for event in events {
            var reason = ""
            var fired: [String] = []
            switch event.kind {
            case "select":
                let sel = selectable(config, event.date)
                if !sel.ok {
                    reason = sel.reason
                } else if !range {
                    start = event.date
                    end = event.date
                } else if start == nil || end != nil {
                    start = event.date
                    end = nil
                } else if (dayNumber(event.date) ?? 0) < (dayNumber(start) ?? 0) {
                    start = event.date
                    end = nil
                } else {
                    let from = dayNumber(start) ?? 0
                    let to = dayNumber(event.date) ?? 0
                    var blocked = false
                    var day = from
                    while day <= to {
                        if disabled.contains(dateFromDay(day)) { blocked = true; break }
                        day += 1
                    }
                    if blocked { reason = "range-contains-disabled" } else { end = event.date }
                }
            case "month":
                if event.month != month {
                    month = event.month
                    fired = ["month"]
                }
            default:
                start = nil
                end = nil
            }
            steps.append(DateFoldStep(
                start: start, end: end, month: month,
                complete: range ? (start != nil && end != nil) : start != nil,
                reason: reason, fired: fired
            ))
        }
        return steps
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // VALIDITY
    // ─────────────────────────────────────────────────────────────────────────────

    private static let emailPattern = "^[A-Z0-9._%+\\-]+@[A-Z0-9.\\-]+\\.[A-Z]{2,}$"
    private static let phonePattern = "^[+]?[0-9 ()\\-]{7,}$"
    /// The PORTABLE twin of the JSE `url()` rule (which uses the URL constructor); the two agree
    /// on every corpus case, and this one is expressible on all three runtimes.
    private static let urlPattern = "^[A-Za-z][A-Za-z0-9+.\\-]*://[^\\s/?#]+\\S*$"

    private static func matches(_ pattern: String, _ value: String, caseInsensitive: Bool = false) -> Bool {
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, options: [], range: range) != nil
    }

    private static func numberArg(_ arg: String) -> Int {
        Int(Double(arg.trimmingCharacters(in: .whitespaces)) ?? 0)
    }

    /// `required` is the ONLY rule an empty value can fail — every other rule passes on empty,
    /// so `validate="email"` alone never blocks an untouched optional field.
    public static func rule(_ name: String, _ arg: String, _ value: String, _ pattern: String) -> Bool {
        if name == "required" { return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if value.isEmpty { return true }
        switch name {
        case "email": return matches(emailPattern, value, caseInsensitive: true)
        case "phone": return matches(phonePattern, value)
        case "url": return matches(urlPattern, value)
        case "minLength": return value.count >= numberArg(arg)
        case "maxLength": return value.count <= numberArg(arg)
        case "pattern", "regex":
            let p = arg.isEmpty ? pattern : arg
            if p.isEmpty { return true }
            return matches(p, value)
        default: return true
        }
    }

    public struct FieldState {
        public let name: String
        public let value: String
        public let initial: String
        public let validate: String
        public let pattern: String
        public let message: String

        public init(name: String, value: String = "", initial: String = "",
                    validate: String = "", pattern: String = "", message: String = "") {
            self.name = name
            self.value = value
            self.initial = initial
            self.validate = validate
            self.pattern = pattern
            self.message = message
        }
    }

    private static let ruleMessages: [String: String] = [
        "required": "Required",
        "email": "Enter a valid email",
        "url": "Enter a valid URL",
        "phone": "Enter a valid phone number",
        "pattern": "Invalid format",
        "regex": "Invalid format",
    ]

    /// The FIRST failing rule owns the message; `message=` overrides it.
    public static func fieldError(_ field: FieldState) -> String {
        let specs = field.validate.split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        for spec in specs {
            let parts = spec.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            let name = String(parts[0])
            let arg = parts.count > 1 ? String(parts[1]) : ""
            if rule(name, arg, field.value, field.pattern) { continue }
            if !field.message.isEmpty { return field.message }
            if name == "minLength" { return "Must be at least \(arg) characters" }
            if name == "maxLength" { return "Must be at most \(arg) characters" }
            return ruleMessages[name] ?? "Invalid"
        }
        return ""
    }

    public struct FormAggregate {
        public let valid: Bool
        public let dirty: Bool
        public let errors: [String: String]
        /// The `on:invalid` payload: the offending names in REGISTRATION order.
        public let invalid: [String]
    }

    public static func aggregate(_ fields: [FieldState]) -> FormAggregate {
        var errors: [String: String] = [:]
        var invalid: [String] = []
        var dirty = false
        for field in fields {
            let error = fieldError(field)
            errors[field.name] = error
            if !error.isEmpty { invalid.append(field.name) }
            if field.value != field.initial { dirty = true }
        }
        return FormAggregate(valid: invalid.isEmpty, dirty: dirty, errors: errors, invalid: invalid)
    }

    public struct SubmitOutcome: Equatable {
        public let action: String
        public let reason: String
        public let fields: [String]
        public let submitting: Bool
        public let submitted: Bool
        public let touchedAll: Bool
        public let disabled: Bool
    }

    /// THE DOUBLE-SUBMIT LAW: a submit already in flight, or a disabled form, runs nothing.
    /// That is the framework-level answer to a double-tapped order button.
    public static func submit(submitting: Bool, disabled: Bool, fields: [FieldState]) -> SubmitOutcome {
        if disabled {
            return SubmitOutcome(action: "blocked", reason: "disabled", fields: [],
                                 submitting: submitting, submitted: false, touchedAll: false, disabled: true)
        }
        if submitting {
            return SubmitOutcome(action: "blocked", reason: "in-flight", fields: [],
                                 submitting: true, submitted: false, touchedAll: false, disabled: false)
        }
        let agg = aggregate(fields)
        if !agg.valid {
            return SubmitOutcome(action: "invalid", reason: "", fields: agg.invalid,
                                 submitting: false, submitted: true, touchedAll: true, disabled: false)
        }
        return SubmitOutcome(action: "submit", reason: "", fields: [],
                             submitting: true, submitted: true, touchedAll: false, disabled: false)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // <multiselect> / <tagsfield>
    // ─────────────────────────────────────────────────────────────────────────────

    public struct MultiSelectResult: Equatable {
        public let selected: [String]
        public let changed: Bool
        public let reason: String
    }

    /// Insertion-ordered. Adding at `max` is REFUSED, never a silent eviction.
    public static func multiSelectToggle(_ selected: [String], _ value: String, _ max: Int) -> MultiSelectResult {
        if selected.contains(value) {
            return MultiSelectResult(selected: selected.filter { $0 != value }, changed: true, reason: "")
        }
        if max > 0 && selected.count >= max {
            return MultiSelectResult(selected: selected, changed: false, reason: "max-reached")
        }
        return MultiSelectResult(selected: selected + [value], changed: true, reason: "")
    }

    /// A11Y: `<multiselect>` announces the running selection COUNT.
    public static func multiSelectAnnouncement(_ count: Int, _ max: Int) -> String {
        if count == 0 { return "None selected" }
        let noun = count == 1 ? "item" : "items"
        return max > 0 ? "\(count) of \(max) \(noun) selected" : "\(count) \(noun) selected"
    }

    public struct TagsConfig {
        public var separator: String
        public var max: Int
        public var validate: String

        public init(separator: String = "", max: Int = 0, validate: String = "") {
            self.separator = separator
            self.max = max
            self.validate = validate
        }
    }

    public struct TagRejection: Equatable {
        public let tag: String
        public let reason: String
    }

    public struct TagsResult: Equatable {
        public let tags: [String]
        public let added: [String]
        public let rejected: [TagRejection]
    }

    /// Split on every character of `separator`, trim, drop empties, refuse duplicates, pattern
    /// failures and anything past `max` — the refusals are RETURNED so `on:add` can report them,
    /// never swallowed.
    public static func tagsAdd(_ tags: [String], _ text: String, _ config: TagsConfig) -> TagsResult {
        let seps = config.separator.isEmpty ? "," : config.separator
        var out = tags
        var added: [String] = []
        var rejected: [TagRejection] = []
        var parts: [String] = []
        var buf = ""
        for ch in text {
            if seps.contains(ch) {
                parts.append(buf)
                buf = ""
            } else {
                buf.append(ch)
            }
        }
        parts.append(buf)
        let max = config.max
        for part in parts {
            let tag = part.trimmingCharacters(in: .whitespacesAndNewlines)
            if tag.isEmpty { continue }
            if out.contains(tag) {
                rejected.append(TagRejection(tag: tag, reason: "duplicate"))
                continue
            }
            if max > 0 && out.count >= max {
                rejected.append(TagRejection(tag: tag, reason: "max-reached"))
                continue
            }
            if !config.validate.isEmpty && !matches(config.validate, tag) {
                rejected.append(TagRejection(tag: tag, reason: "invalid"))
                continue
            }
            out.append(tag)
            added.append(tag)
        }
        return TagsResult(tags: out, added: added, rejected: rejected)
    }

    public struct TagsBackspace: Equatable {
        public let tags: [String]
        public let removed: String?
    }

    /// Backspace on an EMPTY query removes the last chip — the interaction everyone expects and
    /// nobody implements. With text in the query it removes nothing.
    public static func tagsBackspace(_ tags: [String], _ query: String) -> TagsBackspace {
        if !query.isEmpty || tags.isEmpty { return TagsBackspace(tags: tags, removed: nil) }
        return TagsBackspace(tags: Array(tags.dropLast()), removed: tags[tags.count - 1])
    }

    /// A11Y: `<tagsfield>` announces every add and every remove with the running count.
    public static func tagsAnnouncement(_ kind: String, _ tag: String, _ count: Int) -> String {
        "\(tag) \(kind == "add" ? "added" : "removed"), \(count) \(count == 1 ? "tag" : "tags")"
    }
}
