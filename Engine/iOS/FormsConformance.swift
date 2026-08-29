//
//  FormsConformance.swift — the Swift runner for OpenSource/Conformance/forms/
//  {mask,countries,phone,daterange,validation,composites}.json (parity/U08-forms.md §9). The
//  third of three: TS runs it per-PR (packages/kernel/test/forms-conformance.test.ts), Kotlin
//  runs it under gradle (:core FormsConformanceTest), and this runs it in the record lane.
//
//  It exists because every law in the forms core is one a naive implementation gets ALMOST
//  right, and "almost" is invisible until a customer's thumb finds it: the caret jumping to the
//  end of a masked field on a mid-value edit, a phone number stored national instead of E.164,
//  a booking range that quietly clips a blackout night, an order submitted twice by one
//  double-tap. Same file, three runners, no drift.
//
//  Pure Foundation, no UIKit — the record lane runs headless.
//
import Foundation

enum FormsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(description: "forms/\(message)") }
    }

    private static func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }

    private static func str(_ value: Any?) -> String { value as? String ?? "" }

    private static func strings(_ value: Any?) -> [String] { (value as? [String]) ?? [] }

    private static func doc(_ dir: URL, _ name: String) throws -> [String: Any] {
        let file = dir.appendingPathComponent("\(name).json")
        let data = try Data(contentsOf: file)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "forms/\(name).json: not a JSON object")
        }
        return root
    }

    private static func rows(_ root: [String: Any], _ name: String, _ section: String) throws -> [[String: Any]] {
        guard let list = root[section] as? [[String: Any]], !list.isEmpty else {
            throw Failure(description: "forms/\(name).json: no \(section)[]")
        }
        return list
    }

    /// Run every forms corpus file through the shared `Forms` core.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        count += try verifyCountries(corpusDir)
        count += try verifyMask(corpusDir)
        count += try verifyPhone(corpusDir)
        count += try verifyDateRange(corpusDir)
        count += try verifyValidation(corpusDir)
        count += try verifyComposites(corpusDir)
        guard count > 0 else { throw Failure(description: "forms: no cases") }
        return count
    }

    // ── countries.json — ONE table, asserted row for row against the shipped literal ──────

    private static func verifyCountries(_ dir: URL) throws -> Int {
        let root = try doc(dir, "countries")
        try require(str(root["default"]) == Forms.defaultCountry, "countries: default country")
        guard let wanted = root["countries"] as? [[String: Any]] else {
            throw Failure(description: "forms/countries.json: no countries[]")
        }
        try require(wanted.count == Forms.countries.count,
                    "countries: count \(Forms.countries.count) vs \(wanted.count)")
        try require(Forms.countries.count >= 60, "countries: the table is suspiciously small")
        for (index, want) in wanted.enumerated() {
            let got = Forms.countries[index]
            let label = "countries: row \(index) (\(str(want["iso"])))"
            try require(got.iso == str(want["iso"]), "\(label) iso")
            try require(got.name == str(want["name"]), "\(label) name")
            try require(got.dial == str(want["dial"]), "\(label) dial")
            try require(got.trunk == str(want["trunk"]), "\(label) trunk")
            try require(got.nsnMin == int(want["nsnMin"]), "\(label) nsnMin")
            try require(got.nsnMax == int(want["nsnMax"]), "\(label) nsnMax")
            try require(got.format == want["format"] as? String, "\(label) format")
            try require(got.primary == (want["primary"] as? Bool ?? false), "\(label) primary")
        }

        var seen = Set<String>()
        for row in Forms.countries {
            try require(!seen.contains(row.iso), "countries: duplicate ISO \(row.iso)")
            seen.insert(row.iso)
            try require(Forms.country(row.iso)?.dial == row.dial, "countries: \(row.iso) uppercase lookup")
            try require(Forms.country(row.iso.lowercased())?.dial == row.dial,
                        "countries: \(row.iso) lowercase lookup")
            guard let format = row.format else { continue }
            try require(row.nsnMin == row.nsnMax, "countries: \(row.iso) format needs a fixed NSN length")
            try require(Forms.maskCapacity(format) == row.nsnMin,
                        "countries: \(row.iso) format capacity != NSN length")
        }
        return wanted.count
    }

    // ── mask.json ─────────────────────────────────────────────────────────────────────────

    private static func verifyMask(_ dir: URL) throws -> Int {
        let root = try doc(dir, "mask")
        for raw in try rows(root, "mask", "capacity") {
            let mask = str(raw["mask"])
            try require(Forms.maskCapacity(mask) == int(raw["capacity"]), "mask: capacity of \"\(mask)\"")
            try require(Forms.maskDescription(mask) == str(raw["description"]),
                        "mask: description of \"\(mask)\" is \"\(Forms.maskDescription(mask))\"")
        }
        for raw in try rows(root, "mask", "format") {
            let mask = str(raw["mask"])
            let display = Forms.maskFormat(mask, str(raw["raw"]))
            try require(display == str(raw["display"]),
                        "mask: format \"\(mask)\" <- \"\(str(raw["raw"]))\" gave \"\(display)\"")
            try require(Forms.maskExtract(mask, display) == str(raw["extract"]),
                        "mask: extract of the display of \"\(mask)\"")
        }
        for raw in try rows(root, "mask", "extract") {
            let mask = str(raw["mask"])
            try require(Forms.maskExtract(mask, str(raw["text"])) == str(raw["raw"]),
                        "mask: extract \"\(mask)\" <- \"\(str(raw["text"]))\"")
        }
        let edits = try rows(root, "mask", "edits")
        try require(edits.count >= 20, "mask: the edits corpus is suspiciously small")
        for raw in edits {
            let name = str(raw["name"])
            let mask = str(raw["mask"])
            let got = Forms.maskEdit(mask, str(raw["prev"]), int(raw["selStart"]),
                                     int(raw["selEnd"]), str(raw["insert"]))
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.display == str(expect["display"]), "mask/\(name): display \"\(got.display)\"")
            try require(got.caret == int(expect["caret"]), "mask/\(name): caret \(got.caret)")
            try require(got.raw == str(expect["raw"]), "mask/\(name): raw \"\(got.raw)\"")
            try require(got.complete == (expect["complete"] as? Bool ?? false), "mask/\(name): complete")
            // THE PLACEMENT LAW: bind can never hold a character the field does not show.
            try require(Forms.maskExtract(mask, got.display) == got.raw,
                        "mask/\(name): display and raw disagree")
        }
        return edits.count
    }

    // ── phone.json ────────────────────────────────────────────────────────────────────────

    private static func verifyPhone(_ dir: URL) throws -> Int {
        let root = try doc(dir, "phone")
        for raw in try rows(root, "phone", "flags") {
            let iso = str(raw["iso"])
            try require(Forms.flag(iso) == str(raw["flag"]), "phone: flag \(iso)")
        }
        try require(Forms.flag("USA").isEmpty, "phone: a three-letter code is not an ISO alpha-2")
        try require(Forms.flag("").isEmpty, "phone: the empty code has no flag")

        let parse = try rows(root, "phone", "parse")
        try require(parse.count >= 30, "phone: the parse corpus is suspiciously small")
        for raw in parse {
            let input = str(raw["input"])
            let label = "phone/\"\(input)\" @ \(raw["defaultCountry"] as? String ?? "-")"
            let got = Forms.phoneParse(input, raw["defaultCountry"] as? String)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.e164 == str(expect["e164"]), "\(label): e164 \"\(got.e164)\"")
            try require(got.national == str(expect["national"]), "\(label): national \"\(got.national)\"")
            try require(got.country == expect["country"] as? String, "\(label): country")
            try require(got.dialCode == str(expect["dialCode"]), "\(label): dialCode")
            try require(got.nsn == str(expect["nsn"]), "\(label): nsn")
            try require(got.valid == (expect["valid"] as? Bool ?? false), "\(label): valid")

            guard expect["valid"] as? Bool == true else { continue }
            let again = Forms.phoneParse(got.e164, nil)
            try require(again.e164 == got.e164, "\(label): did not round-trip")
            try require(again.valid, "\(label): lost validity on round-trip")
        }

        // An unknown dial code is a TYPED failure, never a guess.
        let unknown = Forms.phoneParse("+9991234567", nil)
        try require(unknown.country == nil, "phone: an unknown dial code resolves no country")
        try require(!unknown.valid, "phone: an unknown dial code is not valid")
        return parse.count
    }

    // ── daterange.json ────────────────────────────────────────────────────────────────────

    private static func foldConfig(_ raw: [String: Any]) -> Forms.DateFoldConfig {
        Forms.DateFoldConfig(
            range: raw["range"] as? Bool ?? false,
            min: raw["min"] as? String,
            max: raw["max"] as? String,
            disabledDates: strings(raw["disabledDates"]),
            start: raw["start"] as? String,
            end: raw["end"] as? String,
            month: raw["month"] as? String ?? ""
        )
    }

    private static func verifyDateRange(_ dir: URL) throws -> Int {
        let root = try doc(dir, "daterange")
        for raw in try rows(root, "daterange", "grid") {
            let year = int(raw["year"])
            let month = int(raw["month"])
            let got = Forms.monthGrid(year, month, int(raw["firstWeekday"]))
            let expect = raw["expect"] as? [String: Any] ?? [:]
            let label = "daterange/grid \(year)-\(month) fw\(int(raw["firstWeekday"]))"
            try require(got.days == int(expect["days"]), "\(label): days \(got.days)")
            try require(got.leading == int(expect["leading"]), "\(label): leading \(got.leading)")
            try require(got.weeks == int(expect["weeks"]), "\(label): weeks \(got.weeks)")
        }
        for raw in try rows(root, "daterange", "dayNumbers") {
            let date = str(raw["date"])
            guard raw["day"] is NSNumber else {
                try require(Forms.dayNumber(date) == nil, "daterange: \(date) must not resolve")
                continue
            }
            let day = int(raw["day"])
            try require(Forms.dayNumber(date) == day, "daterange: dayNumber \(date)")
            try require(Forms.dateFromDay(day) == date, "daterange: dateFromDay \(day)")
        }
        for raw in try rows(root, "daterange", "dstAdjacency") {
            guard let from = Forms.dayNumber(str(raw["from"])), let to = Forms.dayNumber(str(raw["to"])) else {
                throw Failure(description: "forms/daterange: a DST row carries a malformed date")
            }
            try require(to - from == int(raw["delta"]), "daterange: \(str(raw["from"])) -> \(str(raw["to"]))")
            try require(Forms.dateFromDay(from + 1) == str(raw["next"]),
                        "daterange: the day after \(str(raw["from"]))")
        }
        for raw in try rows(root, "daterange", "selectable") {
            let config = foldConfig(raw["config"] as? [String: Any] ?? [:])
            let date = str(raw["date"])
            let got = Forms.selectable(config, date)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.ok == (expect["ok"] as? Bool ?? false), "daterange: selectable \(date) ok")
            try require(got.reason == str(expect["reason"]), "daterange: selectable \(date) reason")
        }
        let folds = try rows(root, "daterange", "folds")
        try require(folds.count >= 10, "daterange: the fold corpus is suspiciously small")
        for raw in folds {
            let name = str(raw["name"])
            let config = foldConfig(raw["config"] as? [String: Any] ?? [:])
            let events = (raw["events"] as? [[String: Any]] ?? []).map {
                Forms.DateFoldEvent(kind: str($0["kind"]), date: str($0["date"]), month: str($0["month"]))
            }
            let steps = Forms.dateFold(config, events)
            let expect = raw["expect"] as? [[String: Any]] ?? []
            try require(steps.count == expect.count, "daterange/\(name): step count")
            for (index, want) in expect.enumerated() {
                let got = steps[index]
                let label = "daterange/\(name) step \(index)"
                try require(got.start == want["start"] as? String, "\(label): start")
                try require(got.end == want["end"] as? String, "\(label): end")
                try require(got.month == str(want["month"]), "\(label): month")
                try require(got.complete == (want["complete"] as? Bool ?? false), "\(label): complete")
                try require(got.reason == str(want["reason"]), "\(label): reason \"\(got.reason)\"")
                try require(got.fired == strings(want["fired"]), "\(label): fired")
            }
        }
        return folds.count
    }

    // ── validation.json ───────────────────────────────────────────────────────────────────

    private static func field(_ raw: [String: Any]) -> Forms.FieldState {
        Forms.FieldState(
            name: str(raw["name"]), value: str(raw["value"]), initial: str(raw["initial"]),
            validate: str(raw["validate"]), pattern: str(raw["pattern"]), message: str(raw["message"])
        )
    }

    private static func verifyValidation(_ dir: URL) throws -> Int {
        let root = try doc(dir, "validation")
        let rules = try rows(root, "validation", "rules")
        try require(rules.count >= 15, "validation: the rules corpus is suspiciously small")
        for raw in rules {
            let name = str(raw["rule"])
            let got = Forms.rule(name, str(raw["arg"]), str(raw["value"]), str(raw["pattern"]))
            try require(got == (raw["expect"] as? Bool ?? false),
                        "validation: \(name)(\(str(raw["arg"]))) <- \"\(str(raw["value"]))\"")
        }
        for (index, raw) in try rows(root, "validation", "fieldErrors").enumerated() {
            let got = Forms.fieldError(field(raw["field"] as? [String: Any] ?? [:]))
            try require(got == str(raw["expect"]), "validation: fieldError \(index) gave \"\(got)\"")
        }
        for raw in try rows(root, "validation", "aggregate") {
            let name = str(raw["name"])
            let fields = (raw["fields"] as? [[String: Any]] ?? []).map { field($0) }
            let got = Forms.aggregate(fields)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.valid == (expect["valid"] as? Bool ?? false), "validation/\(name): valid")
            try require(got.dirty == (expect["dirty"] as? Bool ?? false), "validation/\(name): dirty")
            try require(got.invalid == strings(expect["invalid"]), "validation/\(name): invalid \(got.invalid)")
            let errors = expect["errors"] as? [String: String] ?? [:]
            try require(got.errors == errors, "validation/\(name): errors \(got.errors)")
        }
        let submits = try rows(root, "validation", "submit")
        for raw in submits {
            let name = str(raw["name"])
            let state = raw["state"] as? [String: Any] ?? [:]
            let fields = (raw["fields"] as? [[String: Any]] ?? []).map { field($0) }
            let got = Forms.submit(submitting: state["submitting"] as? Bool ?? false,
                                   disabled: state["disabled"] as? Bool ?? false,
                                   fields: fields)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.action == str(expect["action"]), "validation/\(name): action \(got.action)")
            try require(got.reason == str(expect["reason"]), "validation/\(name): reason \(got.reason)")
            try require(got.submitting == (expect["submitting"] as? Bool ?? false),
                        "validation/\(name): submitting")
            try require(got.disabled == (expect["disabled"] as? Bool ?? false), "validation/\(name): disabled")
            if expect["fields"] != nil {
                try require(got.fields == strings(expect["fields"]), "validation/\(name): fields \(got.fields)")
            }
            if let submitted = expect["submitted"] as? Bool {
                try require(got.submitted == submitted, "validation/\(name): submitted")
            }
            if let touchedAll = expect["touchedAll"] as? Bool {
                try require(got.touchedAll == touchedAll, "validation/\(name): touchedAll")
            }
        }

        // `required` is the ONLY rule an empty value can fail.
        try require(!Forms.rule("required", "", "", ""), "validation: required fails on empty")
        for name in ["email", "url", "phone", "minLength", "maxLength", "pattern"] {
            try require(Forms.rule(name, "8", "", "^x$"), "validation: \(name) must pass on empty")
        }
        return rules.count + submits.count
    }

    // ── composites.json ───────────────────────────────────────────────────────────────────

    private static func verifyComposites(_ dir: URL) throws -> Int {
        let root = try doc(dir, "composites")
        var count = 0
        for (index, raw) in try rows(root, "composites", "multiSelect").enumerated() {
            let got = Forms.multiSelectToggle(strings(raw["selected"]), str(raw["value"]), int(raw["max"]))
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.selected == strings(expect["selected"]),
                        "composites: multiSelect \(index) selected \(got.selected)")
            try require(got.changed == (expect["changed"] as? Bool ?? false),
                        "composites: multiSelect \(index) changed")
            try require(got.reason == str(expect["reason"]), "composites: multiSelect \(index) reason")
            count += 1
        }
        for raw in try rows(root, "composites", "multiSelectAnnouncement") {
            let got = Forms.multiSelectAnnouncement(int(raw["count"]), int(raw["max"]))
            try require(got == str(raw["expect"]), "composites: announcement gave \"\(got)\"")
            count += 1
        }
        for (index, raw) in try rows(root, "composites", "tagsAdd").enumerated() {
            let config = raw["config"] as? [String: Any] ?? [:]
            let got = Forms.tagsAdd(
                strings(raw["tags"]), str(raw["text"]),
                Forms.TagsConfig(separator: config["separator"] as? String ?? "",
                                 max: int(config["max"]),
                                 validate: config["validate"] as? String ?? "")
            )
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.tags == strings(expect["tags"]), "composites: tagsAdd \(index) tags \(got.tags)")
            try require(got.added == strings(expect["added"]), "composites: tagsAdd \(index) added \(got.added)")
            let rejected = expect["rejected"] as? [[String: Any]] ?? []
            try require(got.rejected.count == rejected.count, "composites: tagsAdd \(index) rejection count")
            for (at, want) in rejected.enumerated() {
                try require(got.rejected[at].tag == str(want["tag"]),
                            "composites: tagsAdd \(index) rejection \(at) tag")
                try require(got.rejected[at].reason == str(want["reason"]),
                            "composites: tagsAdd \(index) rejection \(at) reason")
            }
            count += 1
        }
        for (index, raw) in try rows(root, "composites", "tagsBackspace").enumerated() {
            let got = Forms.tagsBackspace(strings(raw["tags"]), str(raw["query"]))
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.tags == strings(expect["tags"]), "composites: tagsBackspace \(index) tags")
            try require(got.removed == expect["removed"] as? String,
                        "composites: tagsBackspace \(index) removed")
            count += 1
        }
        for raw in try rows(root, "composites", "tagsAnnouncement") {
            let got = Forms.tagsAnnouncement(str(raw["kind"]), str(raw["tag"]), int(raw["count"]))
            try require(got == str(raw["expect"]), "composites: tag announcement gave \"\(got)\"")
            count += 1
        }
        return count
    }
}
