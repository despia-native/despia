//
//  ContactsConformance.swift - VERIFY MODE for the F12 contacts corpus.
//
//  Runs OpenSource/Conformance/contacts/{crud,pick}.json through the REAL Swift pure core
//  (ContactsCore) and throws on the first disagreement, so the reference renderer executes the
//  same files as the TS runner (@despia/kernel contacts-conformance.test.ts) and the Kotlin twin
//  (:core ContactsConformanceTest). Paging arithmetic, the limited-access grant, the write
//  refusal and the picker fold therefore cannot drift between renderers.
//
//  Like ConformanceHosts.swift: NOT part of any app or extension target - it compiles only in
//  the Codemagic `conformance-record` lane via RecordMain.swift. Foundation-only.
//
import Foundation

enum ContactsConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute every section of both files. Returns the number of cases verified; an empty
    /// section is a failure, never a silent skip.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        let crud = try object(corpusDir.appendingPathComponent("crud.json"), "crud.json")
        count += try verifyPaging(try cases(crud, "paging", "crud.json"))
        count += try verifyAccess(try cases(crud, "access", "crud.json"))
        count += try verifyWrite(try cases(crud, "write", "crud.json"))
        count += try verifyShape(try cases(crud, "shape", "crud.json"))

        let pick = try object(corpusDir.appendingPathComponent("pick.json"), "pick.json")
        try verifyPermissionSurface(pick)
        count += try verifyPick(try cases(pick, "cases", "pick.json"))
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

    /// An expectation that is absent from the case is not checked; one that is present as JSON
    /// null must match nil.
    private static func optionalString(_ raw: Any?) -> String? { raw as? String }

    private static func int(_ raw: Any?) -> Int { (raw as? NSNumber)?.intValue ?? 0 }

    private static func names(_ message: String?, _ needle: Any?, _ label: String) throws {
        guard let needle = needle as? String else { return }
        guard (message ?? "").lowercased().contains(needle.lowercased()) else {
            throw Failure(description: "\(label): the refusal must name \(needle), got \(message ?? "nil")")
        }
    }

    // MARK: - sections

    private static func verifyPaging(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "paging/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let page = ContactsCore.page(total: int(given["total"]),
                                         limit: int(given["limit"]),
                                         offset: int(given["offset"]))
            try same(page.returned, (expect["returned"] as? NSNumber)?.intValue, "\(label): returned")
            try same(page.hasNextPage, (expect["hasNextPage"] as? NSNumber)?.boolValue, "\(label): hasNextPage")
            guard page.endCursor == optionalString(expect["endCursor"]) else {
                throw Failure(description: "\(label): endCursor \(page.endCursor ?? "nil")")
            }
        }
        return rows.count
    }

    private static func verifyAccess(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "access/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let decision = ContactsCore.readDecision(given["access"] as? String)

            try same(decision.runs, (expect["runs"] as? NSNumber)?.boolValue, "\(label): runs")
            if let prompted = (expect["prompted"] as? NSNumber)?.boolValue {
                try same(decision.prompted, prompted, "\(label): prompted")
            }
            guard decision.error == optionalString(expect["error"]) else {
                throw Failure(description: "\(label): error \(decision.error ?? "nil")")
            }
            if let access = optionalString(expect["access"]) {
                try same(decision.access ?? "", access, "\(label): access")
            }
            if let returned = (expect["returned"] as? NSNumber)?.intValue {
                try same(ContactsCore.readCount(access: given["access"] as? String,
                                                shared: int(given["shared"]),
                                                total: int(given["total"])),
                         returned, "\(label): returned")
            }
            try names(decision.message, expect["messageNames"], label)
            if let recoverable = (expect["recoverable"] as? NSNumber)?.boolValue {
                try same(decision.recoverable, recoverable, "\(label): recoverable")
            }
        }
        return rows.count
    }

    private static func verifyWrite(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "write/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let contact = given["contact"] as? [String: Any]
            let decision = ContactsCore.writeDecision(given["access"] as? String,
                                                      contact: contact,
                                                      validate: given.index(forKey: "contact") != nil)
            try same(decision.runs, (expect["runs"] as? NSNumber)?.boolValue, "\(label): runs")
            guard decision.error == optionalString(expect["error"]) else {
                throw Failure(description: "\(label): error \(decision.error ?? "nil")")
            }
            try names(decision.message, expect["messageNames"], label)
        }
        return rows.count
    }

    private static func verifyShape(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "shape/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            var asserted = false

            if let expected = optionalString(expect["label"]) {
                try same(ContactsCore.normalizeLabel(given["platformLabel"] as? String), expected,
                         "\(label): label")
                asserted = true
            }
            if let expected = optionalString(expect["birthday"]) {
                let actual = ContactsCore.birthday(year: (given["year"] as? NSNumber)?.intValue,
                                                   month: (given["month"] as? NSNumber)?.intValue,
                                                   day: (given["day"] as? NSNumber)?.intValue)
                try same(actual ?? "", expected, "\(label): birthday")
                asserted = true
            }
            if let expected = optionalString(expect["displayName"]) {
                try same(ContactsCore.displayName(givenName: given["givenName"] as? String,
                                                  familyName: given["familyName"] as? String),
                         expected, "\(label): displayName")
                asserted = true
            }
            guard asserted else {
                throw Failure(description: "\(label): the runner asserted nothing - an unknown expectation")
            }
        }
        return rows.count
    }

    private static func verifyPermissionSurface(_ root: [String: Any]) throws {
        guard let surface = root["permissionSurface"] as? [String: Any] else {
            throw Failure(description: "pick.json: no permissionSurface")
        }
        let declared = surface.filter { !$0.key.hasPrefix("_") }
        guard !declared.isEmpty else {
            throw Failure(description: "pick.json: permissionSurface names no actions")
        }
        for (action, grant) in declared {
            try same(ContactsCore.permissionSurface[action] ?? "", grant, "permissionSurface: \(action)")
        }
        for action in ContactsCore.permissionSurface.keys where surface[action] == nil {
            throw Failure(description: "permissionSurface: the corpus does not pin \(action)")
        }
    }

    private static func verifyPick(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "pick/\(name(row))"
            let args = (row["args"] as? [String: Any]) ?? [:]
            let given = (row["given"] as? [String: Any]) ?? [:]
            let expect = try dictionary(row, "expect", label)

            let fields = args["fields"] as? [String]
            let picked = given["picked"] as? [[String: Any]]
            let outcome = ContactsCore.pickOutcome(
                multiple: (args["multiple"] as? NSNumber)?.boolValue == true,
                fields: fields,
                picked: picked,
                multiSelect: (given["multiSelect"] as? NSNumber)?.boolValue,
                pickerAvailable: (given["pickerAvailable"] as? NSNumber)?.boolValue)

            if let expected = optionalString(expect["error"]) {
                try same(outcome.error ?? "", expected, "\(label): error")
                continue
            }
            guard outcome.error == nil else {
                throw Failure(description: "\(label): unexpected error \(outcome.error ?? "")")
            }
            try same(outcome.contacts.count, (expect["contacts"] as? NSNumber)?.intValue, "\(label): contacts")
            if let cancelled = (expect["cancelled"] as? NSNumber)?.boolValue {
                try same(outcome.cancelled, cancelled, "\(label): cancelled")
            }
            if let prompted = (expect["prompted"] as? NSNumber)?.boolValue {
                try same(outcome.prompted, prompted, "\(label): prompted")
            }
            if expect.index(forKey: "multiple") != nil {
                let expected = (expect["multiple"] as? NSNumber)?.boolValue
                guard outcome.multiple == expected else {
                    throw Failure(description: "\(label): multiple")
                }
            }
            if let keys = expect["keys"] as? [String] {
                guard let first = picked?.first else {
                    throw Failure(description: "\(label): keys expected but nothing was picked")
                }
                try same(ContactsCore.subsetKeys(first, fields: fields), keys, "\(label): keys")
            }
        }
        return rows.count
    }
}
