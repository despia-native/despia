//
//  CalendarCore.swift — the shared Core/Calendar core: the `futureEvents` span decision, the one
//  date grammar, the iOS 17 access split, the calendar-target refusals, the reminders absence,
//  the editor result-fidelity ladder and RFC 5545 recurrence. The law is the corpus,
//  `OpenSource/Conformance/calendar/{crud,present,recurrence}.json` (parity F12); the Kotlin twin
//  is `:core` CalendarCore.kt and the web twin is @despia/kernel's calendar-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: EventKit, CalendarContract and the .ics
//  handoff are per-renderer plumbing. Three different mechanisms have to agree on the same
//  strings and the same refusals, and this is where that agreement is written down once.
//
//  No EventKit import, and no DateFormatter: the civil-date arithmetic is spelled out so all
//  three renderers compute the same instant, and so the record lane can run this headless.
//
import Foundation

/// A refusal or a go-ahead, in the shape every calendar action reports.
public struct CalendarDecision: Equatable {
    public let runs: Bool
    public let error: String?
    public let message: String?
    public let recoverable: Bool
    /// Always false: no action in this module prompts on the caller's behalf.
    public let prompted: Bool
}

/// What the system editor settled as, plus what it is honest to say about it.
public struct CalendarPresentOutcome: Equatable {
    public let result: String?
    public let hasId: Bool
    /// The v3 wire spelling of the outcome, or nil when nothing is known to have happened.
    public let broadcast: String?
    public let error: String?
    public let presented: Bool
}

/// Whether this renderer has a system reminders store at all.
public struct CalendarRemindersSupport: Equatable {
    public let supported: Bool
    public let error: String?
    public let remindersAccess: String?
}

/// One BYDAY entry. `ordinal` 0 means "every such weekday"; -1 is "the last one in the period".
public struct RecurrenceDay: Equatable {
    public let day: String
    public let ordinal: Int
    public init(day: String, ordinal: Int) {
        self.day = day
        self.ordinal = ordinal
    }
}

/// A parsed RRULE. `until` is an ISO-8601 instant, never a wall-clock day: a renderer that stored
/// it as a day would end a DST-crossing series an hour early or late.
public struct RecurrenceRule: Equatable {
    public let freq: String
    public let interval: Int
    public let byDay: [RecurrenceDay]?
    public let byMonthDay: [Int]?
    public let byMonth: [Int]?
    public let bySetPos: [Int]?
    public let count: Int?
    public let until: String?

    public init(freq: String, interval: Int, byDay: [RecurrenceDay]? = nil,
                byMonthDay: [Int]? = nil, byMonth: [Int]? = nil, bySetPos: [Int]? = nil,
                count: Int? = nil, until: String? = nil) {
        self.freq = freq
        self.interval = interval
        self.byDay = byDay
        self.byMonthDay = byMonthDay
        self.byMonth = byMonth
        self.bySetPos = bySetPos
        self.count = count
        self.until = until
    }
}

public enum CalendarCore {

    // MARK: - the span decision

    public static let spanThisEvent = "thisEvent"
    public static let spanFutureEvents = "futureEvents"

    /// The dangerous default in every calendar API is the one where editing or deleting a single
    /// occurrence quietly takes the whole recurring series with it, and it is unrecoverable from
    /// inside the app. So `futureEvents` has NO series-wide default anywhere: omitted means this
    /// occurrence only, and only an explicit true widens the blast radius.
    public static func span(recurring: Bool, futureEvents: Bool?) -> String {
        recurring && futureEvents == true ? spanFutureEvents : spanThisEvent
    }

    // MARK: - the date grammar

    public static let invalidDate = "invalid_date"
    public static let invalidDateMessage =
        "start and end must be ISO-8601 strings or epoch seconds, and end must not precede start."

    /// Days since the epoch for a proleptic-Gregorian civil date. Pure arithmetic on purpose: a
    /// date library would be a fourth implementation to keep in step with three renderers.
    private static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = year - (month <= 2 ? 1 : 0)
        let era = y >= 0 ? y / 400 : (y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    private static func isNumericLiteral(_ text: String) -> Bool {
        var characters = Array(text)
        if characters.first == "+" || characters.first == "-" { characters.removeFirst() }
        guard !characters.isEmpty else { return false }
        var seenDot = false
        var before = 0
        var after = 0
        for character in characters {
            if character == "." {
                if seenDot { return false }
                seenDot = true
                continue
            }
            guard character.isASCII, character.isNumber else { return false }
            if seenDot { after += 1 } else { before += 1 }
        }
        return before > 0 && (!seenDot || after > 0)
    }

    /// The one date grammar on all three renderers: ISO-8601 (with or without fractional seconds
    /// and with an offset or Z) or epoch SECONDS, as a number or a numeric string. Anything else
    /// is refused before the store is touched, so prose never becomes a silently wrong event.
    ///
    /// Returns epoch SECONDS, or nil.
    public static func parseDate(_ raw: Any?) -> Double? {
        if let number = raw as? NSNumber, !(raw is NSNull) { return number.doubleValue }
        guard let spelled = raw as? String else { return nil }
        let text = spelled.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if isNumericLiteral(text) { return Double(text) }
        return isoSeconds(text)
    }

    private static func isoSeconds(_ text: String) -> Double? {
        let characters = Array(text)
        guard characters.count >= 10 else { return nil }

        func digits(_ from: Int, _ width: Int) -> Int? {
            guard from >= 0, from + width <= characters.count else { return nil }
            var value = 0
            for index in from..<(from + width) {
                let character = characters[index]
                guard character.isASCII, character.isNumber,
                      let digit = character.wholeNumberValue else { return nil }
                value = value * 10 + digit
            }
            return value
        }

        guard let year = digits(0, 4), characters[4] == "-",
              let month = digits(5, 2), characters[7] == "-",
              let day = digits(8, 2) else { return nil }

        var hour = 0
        var minute = 0
        var second = 0
        var index = 10
        if characters.count > 10 {
            guard characters[10] == "T" || characters[10] == " " else { return nil }
            guard let parsedHour = digits(11, 2), characters.count > 13, characters[13] == ":",
                  let parsedMinute = digits(14, 2) else { return nil }
            hour = parsedHour
            minute = parsedMinute
            index = 16
            if index < characters.count, characters[index] == ":" {
                guard let parsedSecond = digits(index + 1, 2) else { return nil }
                second = parsedSecond
                index += 3
                if index < characters.count, characters[index] == "." {
                    index += 1
                    var seen = 0
                    while index < characters.count, characters[index].isNumber {
                        index += 1
                        seen += 1
                    }
                    guard seen > 0 else { return nil }
                }
            }
        }

        var offset = 0
        if index < characters.count {
            let zone = String(characters[index...])
            if zone != "Z" {
                guard let sign = zone.first, sign == "+" || sign == "-" else { return nil }
                let body = zone.dropFirst().replacingOccurrences(of: ":", with: "")
                guard body.count == 4, let value = Int(body) else { return nil }
                offset = (sign == "-" ? -1 : 1) * ((value / 100) * 3600 + (value % 100) * 60)
            }
        }

        guard month >= 1, month <= 12, day >= 1, day <= 31,
              hour <= 23, minute <= 59, second <= 60 else { return nil }
        return Double(daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset)
    }

    /// A start/end pair. A zero-length event is LEGAL — it is a marker, not a mistake — but an
    /// end before its start is refused.
    public static func window(start: Any?, end: Any?) -> (start: Double, end: Double)? {
        guard let from = parseDate(start), let to = parseDate(end), to >= from else { return nil }
        return (from, to)
    }

    // MARK: - the access split

    /// Which grant each action requires. `present` with an `id` is the one asterisk: reading the
    /// event back to prefill the editor is a read, so THAT spelling needs a read grant while the
    /// prefill-a-new-event spelling needs none.
    public static let permissionSurface: [String: String] = [
        "present": "none",
        "present.withId": "read",
        "permission": "none",
        "calendars": "read",
        "events": "read",
        "create": "write",
        "update": "write",
        "remove": "write",
        "add": "none",
        "ics": "none",
    ]

    public static let readRefusal =
        "Calendar access has not been granted. Call dsx.module.calendar.permission with level "
        + "\"read\" first."
    public static let writeRefusal =
        "Writing to the calendar has not been granted. Call dsx.module.calendar.permission with "
        + "level \"write\" first, or use dsx.module.calendar.present, which needs no permission."
    public static let withIdRefusal =
        "Opening an existing event needs a read grant. Call dsx.module.calendar.permission with "
        + "level \"read\" first."
    public static let invalidRecurrence = "invalid_recurrence"
    public static let invalidRecurrenceMessage = "recurrence must be an RFC 5545 RRULE string."
    public static let remindersAbsentMessage =
        "Reminders are an iOS EventKit store. Neither Android nor the web has a system reminders provider."

    private static let allowed = CalendarDecision(runs: true, error: nil, message: nil,
                                                  recoverable: true, prompted: false)

    private static func deny(_ error: String, _ message: String, _ recoverable: Bool = true) -> CalendarDecision {
        CalendarDecision(runs: false, error: error, message: message,
                         recoverable: recoverable, prompted: false)
    }

    /// The iOS 17 split. `writeOnly` is a real grant that can create and change events but must
    /// NEVER satisfy a read: an app that got write-only access and then enumerated the diary
    /// would be defeating the point of the split.
    public static func accessDecision(_ access: String?, action: String) -> CalendarDecision {
        guard let needs = permissionSurface[action] else {
            return deny("permission_denied", readRefusal)
        }
        if needs == "none" { return allowed }
        let word = (access ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if word == "restricted" {
            return deny("permission_denied", needs == "read" ? readRefusal : writeRefusal, false)
        }
        if needs == "read" {
            if word == "granted" { return allowed }
            return deny("permission_denied", action == "present.withId" ? withIdRefusal : readRefusal)
        }
        if word == "granted" || word == "writeOnly" { return allowed }
        return deny("permission_denied", writeRefusal)
    }

    /// A subscribed or holiday calendar cannot take a write. Refusing is the contract; silently
    /// retargeting the default calendar would put the user's event somewhere they did not choose.
    public static func targetDecision(calendarId: String?,
                                      exists: Bool? = nil,
                                      writable: Bool? = nil,
                                      hasDefault: Bool? = nil) -> CalendarDecision {
        guard let calendarId, !calendarId.isEmpty else {
            return hasDefault == false
                ? deny("read_only_calendar", "That calendar does not accept new events.")
                : allowed
        }
        if exists == false {
            return deny("not_found", "No calendar with that id exists on this device.", false)
        }
        if writable == false {
            return deny("read_only_calendar", "That calendar does not accept new events.")
        }
        return allowed
    }

    /// Reminders exist on iOS only. Everywhere else the whole sub-namespace is the TYPED
    /// ABSENCE: never an empty list, which a caller would read as "no reminders".
    public static func remindersSupport(_ renderer: String) -> CalendarRemindersSupport {
        renderer == "ios"
            ? CalendarRemindersSupport(supported: true, error: nil, remindersAccess: nil)
            : CalendarRemindersSupport(supported: false, error: "unsupported_platform",
                                       remindersAccess: "unsupported")
    }

    // MARK: - the editor result-fidelity ladder

    /// renderer -> the results it can actually report. A renderer must never resolve a result
    /// outside its own list, and `unknown` is never upgraded to `saved` on a hope.
    public static let resultFidelity: [String: [String]] = [
        "ios": ["saved", "cancelled", "deleted"],
        "android": ["saved", "cancelled", "unknown"],
        "web": ["unknown"],
    ]

    /// The result-fidelity ladder: iOS knows exactly what the user did, Android knows only if a
    /// read grant lets it verify against the provider, and the web never knows. `unknown` is the
    /// honest answer at each rung where the platform does not report.
    ///
    /// Both refusals happen BEFORE anything is presented: an unparseable window and a
    /// `present({id})` with no read grant each cost the user nothing, and opening an empty editor
    /// first would.
    public static func presentOutcome(access: String? = nil,
                                      editorAction: String? = nil,
                                      eventFound: Bool? = nil,
                                      id: String? = nil,
                                      start: Any? = nil,
                                      end: Any? = nil,
                                      hasWindow: Bool? = nil) -> CalendarPresentOutcome {
        func refused(_ error: String) -> CalendarPresentOutcome {
            CalendarPresentOutcome(result: nil, hasId: false, broadcast: nil,
                                   error: error, presented: false)
        }

        if let id, !id.isEmpty {
            let decision = accessDecision(access, action: "present.withId")
            guard decision.runs else { return refused(decision.error ?? "permission_denied") }
        } else if hasWindow ?? (start != nil || end != nil) {
            guard window(start: start, end: end) != nil else { return refused(invalidDate) }
        }

        if let reported = editorAction {
            switch reported {
            case "saved":
                return CalendarPresentOutcome(result: "saved", hasId: true, broadcast: "saved",
                                              error: nil, presented: true)
            case "deleted":
                return CalendarPresentOutcome(result: "deleted", hasId: false, broadcast: "deleted",
                                              error: nil, presented: true)
            case "canceled", "cancelled":
                return CalendarPresentOutcome(result: "cancelled", hasId: false, broadcast: "canceled",
                                              error: nil, presented: true)
            default:
                return CalendarPresentOutcome(result: "unknown", hasId: false, broadcast: nil,
                                              error: nil, presented: true)
            }
        }

        // Nothing reported. A read grant is the only thing that makes verification possible;
        // without one, `unknown` is the honest answer and must never be upgraded.
        if let eventFound, accessDecision(access, action: "events").runs {
            return eventFound
                ? CalendarPresentOutcome(result: "saved", hasId: true, broadcast: "saved",
                                         error: nil, presented: true)
                : CalendarPresentOutcome(result: "cancelled", hasId: false, broadcast: "canceled",
                                         error: nil, presented: true)
        }
        return CalendarPresentOutcome(result: "unknown", hasId: false, broadcast: nil,
                                      error: nil, presented: true)
    }

    // MARK: - RFC 5545 recurrence

    public static let frequencies: [String] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
    public static let days: [String] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

    /// Strip the optional `RRULE:` prefix and the surrounding whitespace, nothing else.
    public static func normalizeRRule(_ raw: String?) -> String {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count >= 6 && text.prefix(6).uppercased() == "RRULE:"
            ? String(text.dropFirst(6))
            : text
    }

    private static func isUnsignedInteger(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
    }

    private static func isSignedInteger(_ text: String) -> Bool {
        var body = text
        if body.first == "+" || body.first == "-" { body.removeFirst() }
        return isUnsignedInteger(body)
    }

    /// An iCalendar DATE-TIME to an ISO-8601 instant, or nil. `20261231T235959Z` is an ABSOLUTE
    /// moment, which is exactly why a series ends when it was told to.
    public static func icsInstantToISO(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let characters = Array(text)
        guard characters.count == 15 || characters.count == 16 else { return nil }
        guard characters[8] == "T" else { return nil }
        if characters.count == 16, characters[15] != "Z" { return nil }
        for index in 0..<15 where index != 8 {
            guard characters[index].isASCII, characters[index].isNumber else { return nil }
        }
        let year = String(characters[0..<4])
        let month = String(characters[4..<6])
        let day = String(characters[6..<8])
        let hour = String(characters[9..<11])
        let minute = String(characters[11..<13])
        let second = String(characters[13..<15])
        guard let m = Int(month), m >= 1, m <= 12, let d = Int(day), d >= 1, d <= 31,
              let h = Int(hour), h <= 23, let mi = Int(minute), mi <= 59,
              let s = Int(second), s <= 60 else { return nil }
        let zulu = characters.count == 16 ? "Z" : ""
        return "\(year)-\(month)-\(day)T\(hour):\(minute):\(second)\(zulu)"
    }

    /// The inverse: an ISO instant back to the iCalendar spelling, exactly.
    public static func isoToICSInstant(_ iso: String) -> String {
        iso.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: ":", with: "")
    }

    private static func signedList(_ raw: String, low: Int, high: Int) -> [Int]? {
        var out: [Int] = []
        for token in raw.components(separatedBy: ",") {
            let text = token.trimmingCharacters(in: .whitespaces)
            guard isSignedInteger(text), let value = Int(text) else { return nil }
            guard value != 0, value >= low, value <= high else { return nil }
            out.append(value)
        }
        return out.isEmpty ? nil : out
    }

    /// Parse an RRULE. `recurrence` is an RRULE string and nothing else, because inventing a
    /// shape for recurrence is how you ship a calendar integration that cannot express "the last
    /// Friday of every month". A string that does not parse is a REFUSAL, never an event that
    /// quietly does not repeat.
    public static func parseRecurrence(_ raw: String?) -> RecurrenceRule? {
        let text = normalizeRRule(raw)
        guard !text.isEmpty else { return nil }

        var parts: [String: String] = [:]
        for pair in text.components(separatedBy: ";") where !pair.isEmpty {
            let kv = pair.components(separatedBy: "=")
            guard kv.count == 2, !kv[0].isEmpty, !kv[1].isEmpty else { return nil }
            parts[kv[0].uppercased()] = kv[1]
        }

        let freq = (parts["FREQ"] ?? "").uppercased()
        guard frequencies.contains(freq) else { return nil }

        var interval = 1
        if let raw = parts["INTERVAL"] {
            guard isUnsignedInteger(raw), let value = Int(raw), value >= 1 else { return nil }
            interval = value
        }

        var count: Int?
        var until: String?
        if let raw = parts["COUNT"] {
            guard isUnsignedInteger(raw), let value = Int(raw), value >= 1 else { return nil }
            count = value
        } else if let raw = parts["UNTIL"] {
            guard let iso = icsInstantToISO(raw) else { return nil }
            until = iso
        }

        var byDay: [RecurrenceDay]?
        if let raw = parts["BYDAY"] {
            var parsed: [RecurrenceDay] = []
            for token in raw.components(separatedBy: ",") {
                let entry = token.trimmingCharacters(in: .whitespaces).uppercased()
                guard entry.count >= 2 else { return nil }
                let day = String(entry.suffix(2))
                guard days.contains(day) else { return nil }
                let ordinalText = String(entry.dropLast(2))
                var ordinal = 0
                if !ordinalText.isEmpty {
                    guard isSignedInteger(ordinalText), let value = Int(ordinalText) else { return nil }
                    guard value != 0, abs(value) <= 53 else { return nil }
                    ordinal = value
                }
                parsed.append(RecurrenceDay(day: day, ordinal: ordinal))
            }
            guard !parsed.isEmpty else { return nil }
            byDay = parsed
        }

        var byMonthDay: [Int]?
        if let raw = parts["BYMONTHDAY"] {
            guard let parsed = signedList(raw, low: -31, high: 31) else { return nil }
            byMonthDay = parsed
        }
        var byMonth: [Int]?
        if let raw = parts["BYMONTH"] {
            guard let parsed = signedList(raw, low: 1, high: 12) else { return nil }
            byMonth = parsed
        }
        var bySetPos: [Int]?
        if let raw = parts["BYSETPOS"] {
            guard let parsed = signedList(raw, low: -366, high: 366) else { return nil }
            bySetPos = parsed
        }

        return RecurrenceRule(freq: freq, interval: interval, byDay: byDay,
                              byMonthDay: byMonthDay, byMonth: byMonth, bySetPos: bySetPos,
                              count: count, until: until)
    }

    /// Serialise back to the canonical form, which is NOT always the input: an explicit
    /// `INTERVAL=1` is dropped because it is the default, the `RRULE:` prefix is dropped, and the
    /// keys emit in one fixed order so a round-trip on three renderers produces one string.
    public static func formatRecurrence(_ rule: RecurrenceRule) -> String {
        var parts = ["FREQ=\(rule.freq)"]
        if rule.interval > 1 { parts.append("INTERVAL=\(rule.interval)") }
        if let byDay = rule.byDay, !byDay.isEmpty {
            parts.append("BYDAY=" + byDay
                .map { $0.ordinal == 0 ? $0.day : "\($0.ordinal)\($0.day)" }
                .joined(separator: ","))
        }
        if let byMonthDay = rule.byMonthDay, !byMonthDay.isEmpty {
            parts.append("BYMONTHDAY=" + byMonthDay.map { String($0) }.joined(separator: ","))
        }
        if let byMonth = rule.byMonth, !byMonth.isEmpty {
            parts.append("BYMONTH=" + byMonth.map { String($0) }.joined(separator: ","))
        }
        if let bySetPos = rule.bySetPos, !bySetPos.isEmpty {
            parts.append("BYSETPOS=" + bySetPos.map { String($0) }.joined(separator: ","))
        }
        if let count = rule.count {
            parts.append("COUNT=\(count)")
        } else if let until = rule.until {
            parts.append("UNTIL=\(isoToICSInstant(until))")
        }
        return parts.joined(separator: ";")
    }
}
