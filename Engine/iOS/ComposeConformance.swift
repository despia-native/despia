//
//  ComposeConformance.swift - VERIFY MODE for the F13 composer corpus.
//
//  Runs OpenSource/Conformance/compose/result.json through the REAL Swift pure core
//  (ComposeCore) and throws on the first disagreement, so the reference renderer executes the
//  same file as the TS runner (@despia/kernel compose-conformance.test.ts) and the Kotlin twin
//  (:core ComposeConformanceTest). The result ladder, the empty permission surface, the
//  capability disclosure, the recipient cap and the attachment rule therefore cannot drift.
//
//  Like ConformanceHosts.swift: NOT part of any app or extension target - it compiles only in
//  the Codemagic `conformance-record` lane via RecordMain.swift. Foundation-only.
//
import Foundation

enum ComposeConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute every section. Returns the number of cases verified; an empty section is a
    /// failure, never a silent skip.
    static func verify(corpusFile: URL) throws -> Int {
        let root = try object(corpusFile)
        try verifyVocabulary(root)
        try verifyResultFidelity(root)
        try verifyPermissionSurface(root)
        var count = 0
        count += try verifyResults(root)
        count += try verifyCapabilities(try cases(root, "capabilities"))
        count += try verifyRecipients(try cases(root, "recipients"))
        count += try verifyAttachments(try cases(root, "attachments"))
        return count
    }

    // MARK: - helpers

    private static func object(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "result.json: not a JSON object")
        }
        guard (root["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "result.json: unsupported version")
        }
        return root
    }

    private static func cases(_ root: [String: Any], _ name: String) throws -> [[String: Any]] {
        let rows = (root[name] as? [[String: Any]])
            ?? ((root[name] as? [String: Any])?["cases"] as? [[String: Any]])
        guard let rows, !rows.isEmpty else {
            throw Failure(description: "result.json: \(name) must be a non-empty case array")
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

    private static func int(_ raw: Any?) -> Int { (raw as? NSNumber)?.intValue ?? 0 }

    // MARK: - sections

    private static func verifyVocabulary(_ root: [String: Any]) throws {
        try same(ComposeCore.results, root["vocabulary"] as? [String], "vocabulary")
    }

    private static func verifyResultFidelity(_ root: [String: Any]) throws {
        guard let fidelity = root["resultFidelity"] as? [String: Any] else {
            throw Failure(description: "result.json: no resultFidelity")
        }
        let declared = fidelity.filter { !$0.key.hasPrefix("_") }
        guard !declared.isEmpty else {
            throw Failure(description: "result.json: resultFidelity names no renderers")
        }
        for (renderer, actions) in declared {
            guard let actions = actions as? [String: Any] else {
                throw Failure(description: "resultFidelity: \(renderer) is not an object")
            }
            for (action, results) in actions {
                try same(ComposeCore.resultFidelity[renderer]?[action] ?? [], results as? [String],
                         "resultFidelity: \(renderer).\(action)")
            }
        }
    }

    private static func verifyPermissionSurface(_ root: [String: Any]) throws {
        guard let surface = root["permissionSurface"] as? [String: Any] else {
            throw Failure(description: "result.json: no permissionSurface")
        }
        let declared = surface.filter { !$0.key.hasPrefix("_") && $0.value is String }
        guard !declared.isEmpty else {
            throw Failure(description: "result.json: permissionSurface names no actions")
        }
        for (action, grant) in declared {
            try same("none", grant, "permissionSurface: \(action) must need no grant")
            try same(ComposeCore.permissionSurface[action] ?? "", "none", "permissionSurface: \(action)")
        }
        try same(ComposeCore.forbiddenPermissions, surface["forbiddenPermissions"] as? [String],
                 "forbiddenPermissions")
        for permission in ComposeCore.forbiddenPermissions
        where ComposeCore.permissionSurface.values.contains(permission) {
            throw Failure(description: "\(permission) must never appear in the permission surface")
        }
    }

    private static func verifyResults(_ root: [String: Any]) throws -> Int {
        let fidelity = (root["resultFidelity"] as? [String: Any]) ?? [:]
        let rows = try cases(root, "cases")
        for row in rows {
            let label = "cases/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let renderer = (given["renderer"] as? String) ?? ""
            let action = (given["action"] as? String) ?? ""
            let outcome = ComposeCore.outcome(renderer: renderer,
                                              composerResult: given["composerResult"] as? String,
                                              launched: (given["launched"] as? NSNumber)?.boolValue ?? true,
                                              isHtml: (given["isHtml"] as? NSNumber)?.boolValue == true)

            if let expected = expect["error"] as? String {
                try matches(outcome.error, expected, "\(label): error")
                continue
            }
            guard outcome.error == nil else {
                throw Failure(description: "\(label): unexpected error \(outcome.error ?? "")")
            }
            try matches(outcome.result, expect["result"], "\(label): result")
            if expect.index(forKey: "isHtml") != nil {
                let expected = (expect["isHtml"] as? NSNumber)?.boolValue
                guard outcome.isHtml == expected else {
                    throw Failure(description: "\(label): isHtml")
                }
            }
            let allowed = ((fidelity[renderer] as? [String: Any])?[action] as? [String]) ?? []
            guard let result = outcome.result, allowed.contains(result) else {
                throw Failure(description: "\(label): result is outside \(renderer).\(action)'s fidelity list")
            }
        }
        return rows.count
    }

    private static func verifyCapabilities(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "capabilities/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let capabilities = ComposeCore.capabilities(
                renderer: (given["renderer"] as? String) ?? "",
                canText: (given["canText"] as? NSNumber)?.boolValue == true,
                canMail: (given["canMail"] as? NSNumber)?.boolValue == true,
                smsResolver: given["smsResolver"] as? String,
                mailResolver: given["mailResolver"] as? String)
            try same(capabilities.sms, (expect["sms"] as? NSNumber)?.boolValue, "\(label): sms")
            try same(capabilities.mail, (expect["mail"] as? NSNumber)?.boolValue, "\(label): mail")
            if expect.index(forKey: "defaultMailClient") != nil {
                try matches(capabilities.defaultMailClient, expect["defaultMailClient"],
                            "\(label): defaultMailClient")
            }
        }
        return rows.count
    }

    private static func verifyRecipients(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "recipients/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let count = given.index(forKey: "count") != nil
                ? int(given["count"])
                : int(given["to"]) + int(given["cc"]) + int(given["bcc"])
            let decision = ComposeCore.recipientDecision(count: count, cap: int(given["cap"]))
            try same(decision.runs, (expect["runs"] as? NSNumber)?.boolValue, "\(label): runs")
            try matches(decision.error, expect["error"], "\(label): error")
        }
        return rows.count
    }

    private static func verifyAttachments(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "attachments/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let decision = ComposeCore.attachmentDecision(
                renderer: (given["renderer"] as? String) ?? "",
                path: given["path"] as? String,
                insideRoots: (given["insideRoots"] as? NSNumber)?.boolValue,
                exists: (given["exists"] as? NSNumber)?.boolValue)
            try same(decision.runs, (expect["runs"] as? NSNumber)?.boolValue, "\(label): runs")
            try matches(decision.error, expect["error"], "\(label): error")
        }
        return rows.count
    }
}
