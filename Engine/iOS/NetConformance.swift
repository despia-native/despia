//
//  NetConformance.swift - VERIFY MODE for the F05 connectivity corpus.
//
//  Runs OpenSource/Conformance/net/{status,transitions}.json through the REAL Swift pure core
//  (NetCore + NetDebounce) and throws on the first disagreement, so the reference renderer
//  executes the same files as the TS runner (@despia-native/kernel net-conformance.test.ts) and the
//  Kotlin twin (:core NetConformanceTest). The classification fold, the online split, the radio
//  family map, the captive-portal probe verdict and the debounce therefore cannot drift.
//
//  Like ConformanceHosts.swift / GesturesConformance.swift: NOT part of any app or extension
//  target - it compiles only in the Codemagic `conformance-record` lane, alongside the rest of
//  OpenSource/Engine, via RecordMain.swift. Foundation-only, pure computation plus one file read.
//
import Foundation

enum NetConformance {
    struct Failure: Error, CustomStringConvertible { let description: String }

    /// Execute every section of both files. Returns the number of cases verified; an empty
    /// section is a failure, never a silent skip.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        let status = try object(corpusDir.appendingPathComponent("status.json"), "status.json")
        count += try verifyClassify(try cases(status, "classify", "status.json"))
        count += try verifyOnline(try cases(status, "online", "status.json"))
        count += try verifyGeneration(try cases(status, "generation", "status.json"))
        count += try verifyProbe(try cases(status, "probe", "status.json"))

        let transitions = try object(corpusDir.appendingPathComponent("transitions.json"), "transitions.json")
        count += try verifyTimelines(transitions)
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

    /// A section is either a bare array of cases or an object with a `cases` array. Either way
    /// it must be non-empty: a runner that silently reads nothing is the defect this file exists
    /// to close.
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

    private static func strings(_ raw: Any?) -> [String] { (raw as? [String]) ?? [] }

    private static func flag(_ raw: Any?) -> Bool { (raw as? NSNumber)?.boolValue == true }

    // MARK: - sections

    private static func verifyClassify(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "classify/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let actual = NetCore.classify(satisfied: flag(given["satisfied"]),
                                          interfaces: strings(given["interfaces"]),
                                          transports: strings(given["transports"]),
                                          metered: flag(given["metered"]),
                                          dataSaver: flag(given["dataSaver"]))
            try same(actual.reachable, (expect["reachable"] as? NSNumber)?.boolValue, "\(label): reachable")
            try same(actual.type, expect["type"], "\(label): type")
            try same(actual.expensive, (expect["expensive"] as? NSNumber)?.boolValue, "\(label): expensive")
            try same(actual.constrained, (expect["constrained"] as? NSNumber)?.boolValue, "\(label): constrained")
        }
        return rows.count
    }

    private static func verifyOnline(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "online/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            let reachable = flag(given["reachable"])
            let snapshot = NetSnapshot(reachable: reachable, type: reachable ? "wifi" : "none",
                                       expensive: false, constrained: false)
            try same(NetCore.online(snapshot, probeFailed: flag(given["probeFailed"])),
                     (expect["online"] as? NSNumber)?.boolValue, "\(label): online")
        }
        return rows.count
    }

    private static func verifyGeneration(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "generation/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            try same(NetCore.generation(type: (given["type"] as? String) ?? "",
                                        radio: given["radio"] as? String),
                     expect["generation"], "\(label): generation")
        }
        return rows.count
    }

    private static func verifyProbe(_ rows: [[String: Any]]) throws -> Int {
        for row in rows {
            let label = "probe/\(name(row))"
            let given = try dictionary(row, "given", label)
            let expect = try dictionary(row, "expect", label)
            try same(NetCore.probeReachable(status: (given["status"] as? NSNumber)?.intValue ?? -1,
                                            requestHost: given["requestHost"] as? String,
                                            location: given["location"] as? String),
                     (expect["reachable"] as? NSNumber)?.boolValue, "\(label): reachable")
        }
        return rows.count
    }

    private static func verifyTimelines(_ root: [String: Any]) throws -> Int {
        guard let debounceMs = (root["debounceMs"] as? NSNumber)?.intValue else {
            throw Failure(description: "transitions.json: no debounceMs")
        }
        let timelines = try cases(root, "timelines", "transitions.json")
        for timeline in timelines {
            let label = "timelines/\(name(timeline))"
            guard let steps = timeline["steps"] as? [[String: Any]], !steps.isEmpty else {
                throw Failure(description: "\(label): no steps")
            }
            let machine = NetDebounce(debounceMs: debounceMs)
            var emitted: [NetChange] = []

            for step in steps {
                let at = (step["at"] as? NSNumber)?.intValue ?? 0
                machine.advance(at)
                if let path = step["path"] as? [String: Any] {
                    machine.path(at, NetSnapshot(reachable: flag(path["reachable"]),
                                                 type: (path["type"] as? String) ?? "",
                                                 expensive: flag(path["expensive"]),
                                                 constrained: flag(path["constrained"])))
                } else if step["probeFailed"] != nil {
                    machine.probe(at, failed: flag(step["probeFailed"]))
                }
                emitted.append(contentsOf: machine.drain())
            }

            let expect = try dictionary(timeline, "expect", label)
            let expectedEvents = (expect["events"] as? [[String: Any]]) ?? []
            guard emitted.count == expectedEvents.count else {
                throw Failure(description: "\(label): \(emitted.count) events != \(expectedEvents.count)")
            }
            for (index, expected) in expectedEvents.enumerated() {
                let change = emitted[index]
                let row = "\(label): event \(index)"
                try same(change.at, (expected["at"] as? NSNumber)?.intValue, "\(row): at")
                try same("change", expected["event"], "\(row): event")
                let data = try dictionary(expected, "data", row)
                try same(change.online, (data["online"] as? NSNumber)?.boolValue, "\(row): online")
                try same(change.snapshot.reachable, (data["reachable"] as? NSNumber)?.boolValue, "\(row): reachable")
                try same(change.snapshot.type, data["type"], "\(row): type")
                try same(change.snapshot.expensive, (data["expensive"] as? NSNumber)?.boolValue, "\(row): expensive")
                try same(change.snapshot.constrained, (data["constrained"] as? NSNumber)?.boolValue, "\(row): constrained")
                try same(change.previous, data["previous"], "\(row): previous")
            }

            let context = try dictionary(expect, "context", label)
            try same(machine.online, (context["online"] as? NSNumber)?.boolValue, "\(label): context.online")
            try same(machine.settled.type, context["type"], "\(label): context.type")
            try same(machine.settled.expensive, (context["expensive"] as? NSNumber)?.boolValue, "\(label): context.expensive")
            try same(machine.settled.constrained, (context["constrained"] as? NSNumber)?.boolValue, "\(label): context.constrained")
        }
        return timelines.count
    }
}
