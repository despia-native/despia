//
//  CalendarConformance.swift - VERIFY MODE for the F12 calendar corpus.
//
//  Runs OpenSource/Conformance/calendar/{crud,present,recurrence}.json through the REAL Swift
//  pure core (CalendarCore) and throws on the first disagreement, so the reference renderer
//  executes the same files as the TS runner (@despia/kernel calendar-conformance.test.ts) and
//  the Kotlin twin (:core CalendarConformanceTest). The `futureEvents` blast radius, the date
//  grammar, the iOS 17 writeOnly split, the editor fidelity ladder and the RRULE round-trip
//  therefore cannot drift between renderers.
//
//  Like ConformanceHosts.swift: NOT part of any app or extension target - it compiles only in
//  the Codemagic `conformance-record` lane via RecordMain.swift. Foundation-only.
//
import Foundation

enum CalendarConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute every section of all three files. Returns the number of cases verified; an empty
    /// section is a failure, never a silent skip.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        let crud = try object(corpusDir.appendingPathComponent("crud.json"), "crud.json")
        count += try verifySpan(try cases(crud, "span", "crud.json"))
        count += try verifyDates(try cases(crud, "dates", "crud.json"))
        count += try verifyAccess(try cases(crud, "access", "crud.json"))
        count += try verifyCalendars(try cases(crud, "calendars", "crud.json"))
        count += try verifyReminders(try cases(crud, "reminders", "crud.json"))

        let present = try object(corpusDir.appendingPathComponent("present.json"), "present.json")
        try verifyPermissionSurface(present)
        try verifyResultFidelity(present)
        count += try verifyPresent(present)

        let recurrence = try object(corpusDir.appendingPathComponent("recurrence.json"), "recurrence.json")
        count += try verifyRoundTrip(try cases(recurrence, "roundTrip", "recurrence.json"))
        count += try verifyRejected(try cases(recurrence, "rejected", "recurrence.json"))
        return count
    }

    // MARK: - helpers

    private static func object(_ url: URL, _ label: String) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "\(label): not a JSON object")
        }
        guard (root["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "\(label): unsupported version")
        }
        return root
    }

    private static func cases(_ root: [String: Any], _ name: String, _ label: String) throws -> [[String: Any]] {
        let rows = (root[name] as? [[String: Any]])
            ?? ((root[name] as? [String: Any])?["cases"] as? [[String: Any]])
        guard let rows, !rows.isEmpty else {
            throw Failure(description: "\(label): \(name) must be a non-empty case array")
        }
        return rows
    }

    private static func name(_ row: [String: Any]) -> String { (row["name"] as? String) ?? "<unnamed>" }

    private static func dictionary(_ row: [String: Any], _ key: String, _ label: String) throws -> [String: Any] {
        guard let value = row[key] as? [String: Any] else {
            throw Failure(description: "\(label): no \(key){}")
        }
        return value
    }

    private static func same<T: Equatable>(_ actual: T, _ expected: Any?, _ label: String) throws {
        guard let expected = expected as? T else {
            throw Failure(description: "\(label): expectation is not the right type")
        }
        guard actual == expected else {
            throw Failure(description: "\(label): \(actual) != \(expected)")
        }
    }

    private static func matches(_ actual: String?, _ expected: Any?, _ label: String) throws {
        let want = expected as? String
        guard actual == want else {
            throw Failure(description: "\(label): \(actual ?? "nil") != \(want ?? "nil")")
        }
    }

    private static func names(_ message: String?, _ needle: Any?, _ label: String) throws {
        guard let needle = needle as? String else { return }
        guard (message ?? "").lowercased().contains(needle.lowercased()) else {
            throw Failure(description: "\(label): the refusal must name \(needle), got \(message ?? "nil")")
        }
    }

    // MARK: - crud

    private static func verifySpan(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "span/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            try same(CalendarCore.span(recurring: (given["recurring"] as? NSNumber)?.boolValue == true,
                                       futureEvents: (given["futureEvents"] as? NSNumber)?.boolValue),
                     expect["scope"], "\(label): scope")
        }
        return rows.count
    }

    private static func verifyDates(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "dates/\(name(row))"
            let expect = try dictionary(row, "expect", label)
            if let window = row["input"] as? [String: Any] {
                let parsed = CalendarCore.window(start: window["start"], end: window["end"])
                try matches(parsed == nil ? "invalid_date" : nil, expect["error"], "\(label): window")
                continue
            }
            let epoch = CalendarCore.parseDate(row["input"])
            if (expect["error"] as? String) != nil {
                guard epoch == nil else { throw Failure(description: "\(label): expected a refusal") }
                continue
            }
            guard let epoch, let want = (expect["epoch"] as? NSNumber)?.doubleValue, epoch == want else {
                throw Failure(description: "\(label): epoch \(String(describing: epoch))")
            }
        }
        return rows.count
    }

    private static func verifyAccess(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "access/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let decision = CalendarCore.accessDecision(given["access"] as? String,
                                                       action: (given["action"] as? String) ?? "")
            try same(decision.runs, (expect["runs"] as? NSNumber)?.boolValue, "\(label): runs")
            if let prompted = (expect["prompted"] as? NSNumber)?.boolValue {
                try same(decision.prompted, prompted, "\(label): prompted")
            }
            try matches(decision.error, expect["error"], "\(label): error")
            try names(decision.message, expect["messageNames"], label)
        }
        return rows.count
    }

    private static func verifyCalendars(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "calendars/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let decision = CalendarCore.targetDecision(calendarId: given["calendarId"] as? String,
                                                       exists: (given["exists"] as? NSNumber)?.boolValue,
                                                       writable: (given["writable"] as? NSNumber)?.boolValue,
                                                       hasDefault: (given["hasDefault"] as? NSNumber)?.boolValue)
            try same(decision.runs, (expect["runs"] as? NSNumber)?.boolValue, "\(label): runs")
            try matches(decision.error, expect["error"], "\(label): error")
        }
        return rows.count
    }

    private static func verifyReminders(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "reminders/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let support = CalendarCore.remindersSupport((given["renderer"] as? String) ?? "")
            try same(support.supported, (expect["supported"] as? NSNumber)?.boolValue, "\(label): supported")
            try matches(support.error, expect["error"], "\(label): error")
            if expect.index(forKey: "remindersAccess") != nil {
                try matches(support.remindersAccess, expect["remindersAccess"], "\(label): remindersAccess")
            }
        }
        return rows.count
    }

    // MARK: - present

    private static func verifyPermissionSurface(_ root: [String: Any]) throws {
        guard let surface = root["permissionSurface"] as? [String: Any] else {
            throw Failure(description: "present.json: no permissionSurface")
        }
        let declared = surface.filter { !$0.key.hasPrefix("_") }
        guard !declared.isEmpty else {
            throw Failure(description: "present.json: permissionSurface names no actions")
        }
        for (action, grant) in declared {
            try same(CalendarCore.permissionSurface[action] ?? "", grant, "permissionSurface: \(action)")
        }
        for action in CalendarCore.permissionSurface.keys where surface[action] == nil {
            throw Failure(description: "permissionSurface: the corpus does not pin \(action)")
        }
    }

    private static func verifyResultFidelity(_ root: [String: Any]) throws {
        guard let fidelity = root["resultFidelity"] as? [String: Any] else {
            throw Failure(description: "present.json: no resultFidelity")
        }
        let declared = fidelity.filter { !$0.key.hasPrefix("_") }
        guard !declared.isEmpty else {
            throw Failure(description: "present.json: resultFidelity names no renderers")
        }
        for (renderer, results) in declared {
            try same(CalendarCore.resultFidelity[renderer] ?? [], results as? [String],
                     "resultFidelity: \(renderer)")
        }
    }

    private static func verifyPresent(_ root: [String: Any]) throws -> Int {
        let fidelity = (root["resultFidelity"] as? [String: Any]) ?? [:]
        let rows = try cases(root, "cases", "present.json")
        for row in rows {
            let label = "present/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let outcome = CalendarCore.presentOutcome(
                access: given["access"] as? String,
                editorAction: given["editorAction"] as? String,
                eventFound: (given["eventFound"] as? NSNumber)?.boolValue,
                id: given["id"] as? String,
                start: given["start"],
                end: given["end"],
                hasWindow: given.index(forKey: "start") != nil || given.index(forKey: "end") != nil)

            if let expected = expect["error"] as? String {
                try matches(outcome.error, expected, "\(label): error")
                try same(outcome.presented, (expect["presented"] as? NSNumber)?.boolValue ?? false,
                         "\(label): presented")
                continue
            }
            guard outcome.error == nil else {
                throw Failure(description: "\(label): unexpected error \(outcome.error ?? "")")
            }
            try matches(outcome.result, expect["result"], "\(label): result")
            if let hasId = (expect["hasId"] as? NSNumber)?.boolValue {
                try same(outcome.hasId, hasId, "\(label): hasId")
            }
            if expect.index(forKey: "broadcast") != nil {
                try matches(outcome.broadcast, expect["broadcast"], "\(label): broadcast")
            }
            let renderer = (given["renderer"] as? String) ?? ""
            let allowed = (fidelity[renderer] as? [String]) ?? []
            guard let result = outcome.result, allowed.contains(result) else {
                throw Failure(description: "\(label): result is outside \(renderer)'s fidelity list")
            }
        }
        return rows.count
    }

    // MARK: - recurrence

    private static func verifyRoundTrip(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "roundTrip/\(name(row))"
            guard let rule = CalendarCore.parseRecurrence(row["rrule"] as? String) else {
                throw Failure(description: "\(label): expected a parsed rule")
            }
            let parsed = try dictionary(row, "parsed", label)
            try same(rule.freq, parsed["freq"], "\(label): freq")
            try same(rule.interval, (parsed["interval"] as? NSNumber)?.intValue, "\(label): interval")
            if let count = (parsed["count"] as? NSNumber)?.intValue {
                try same(rule.count ?? -1, count, "\(label): count")
            }
            if let until = parsed["until"] as? String {
                try matches(rule.until, until, "\(label): until")
            }
            if let byDay = parsed["byDay"] as? [[String: Any]] {
                let expected = byDay.map {
                    RecurrenceDay(day: ($0["day"] as? String) ?? "",
                                  ordinal: ($0["ordinal"] as? NSNumber)?.intValue ?? 0)
                }
                try same(rule.byDay ?? [], expected, "\(label): byDay")
            }
            if let byMonthDay = parsed["byMonthDay"] as? [NSNumber] {
                try same(rule.byMonthDay ?? [], byMonthDay.map { $0.intValue }, "\(label): byMonthDay")
            }
            if let byMonth = parsed["byMonth"] as? [NSNumber] {
                try same(rule.byMonth ?? [], byMonth.map { $0.intValue }, "\(label): byMonth")
            }
            try same(CalendarCore.formatRecurrence(rule), row["canonical"], "\(label): canonical")
        }
        return rows.count
    }

    private static func verifyRejected(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "rejected/\(name(row))"
            guard CalendarCore.parseRecurrence(row["rrule"] as? String) == nil else {
                throw Failure(description: "\(label): must not parse")
            }
            try same("invalid_recurrence", row["error"], "\(label): error code")
        }
        return rows.count
    }
}
