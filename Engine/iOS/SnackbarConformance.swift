//
//  SnackbarConformance.swift — the Swift runner for OpenSource/Conformance/overlays/snackbar.json
//  (parity/U06-overlays.md §1). The third of three: TS runs it per-PR
//  (packages/kernel/test/snackbar-conformance.test.ts), Kotlin runs it under gradle
//  (:core SnackbarConformanceTest), and this runs it in the record lane (RecordMain.swift).
//
//  It drives SnackbarQueue — the pure reducer — through the corpus's three sections, and then
//  adds the two PROPERTY checks the twins carry, because a table of examples cannot state an
//  invariant: (1) the bottom inset is never less than the safe area plus the gap, whatever
//  geometry a rotation race reports, so the card can never sit on the home indicator; and
//  (2) every card settles EXACTLY ONCE — a card that never settles is a leaked promise and one
//  that settles twice is a double undo, which is the price of `show` resolving on outcome.
//
//  Pure Foundation, no UIKit — the record lane runs headless.
//
import Foundation

enum SnackbarConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    static func verify(corpusFile: URL) throws -> Int {
        let data = try Data(contentsOf: corpusFile)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "\(corpusFile.lastPathComponent): not a JSON object")
        }
        var count = try verifyDurations(root["durationCases"] as? [[String: Any]] ?? [])
        count += try verifyQueue(root["queueCases"] as? [[String: Any]] ?? [])
        count += try verifyLift(root["liftCases"] as? [[String: Any]] ?? [])
        count += try verifyDurationIsTotal()
        count += try verifyNeverCoversTheHomeIndicator()
        count += try verifyEveryCardSettlesExactlyOnce()
        count += try verifyAnActionWithNoLabelIsNotAnAction()
        guard count > 0 else { throw Failure(description: "\(corpusFile.lastPathComponent): no cases") }
        return count
    }

    private static func same<T: Equatable>(_ actual: T, _ expected: T, _ what: String) throws {
        guard actual == expected else {
            throw Failure(description: "\(what): expected \(expected), got \(actual)")
        }
    }

    private static func int(_ any: Any?) -> Int {
        (any as? NSNumber)?.intValue ?? 0
    }

    // MARK: - durationCases → resolveDuration

    private static func verifyDurations(_ cases: [[String: Any]]) throws -> Int {
        guard !cases.isEmpty else { throw Failure(description: "durationCases is empty") }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let hasAction = raw["hasAction"] as? Bool ?? false
            // A JSON null arrives as NSNull; the reducer's "no duration" is a real nil.
            let duration: Any? = raw["duration"] is NSNull ? nil : raw["duration"]
            try same(SnackbarQueue.resolveDuration(duration, hasAction: hasAction),
                     int(raw["expect"]), "duration: \(name)")
        }
        return cases.count
    }

    // MARK: - queueCases → the reducer

    private static func request(_ raw: [String: Any]) -> SnackbarRequest {
        let id = raw["id"] as? String ?? ""
        var action: SnackbarAction?
        if let a = raw["action"] as? [String: Any] {
            action = SnackbarAction(label: a["label"] as? String ?? "", id: a["id"] as? String ?? "")
        }
        // The corpus omits `message` where it does not matter; the reducer treats an empty
        // message as a no-op, so the runner supplies the id as the text unless a case is
        // deliberately testing emptiness.
        return SnackbarRequest(
            id: id,
            message: raw["message"] as? String ?? (id.isEmpty ? "x" : id),
            action: action,
            duration: raw["duration"] is NSNull ? nil : raw["duration"],
            tone: raw["tone"] as? String,
            icon: raw["icon"] as? String,
            position: raw["position"] as? String,
            dismissible: raw["dismissible"] as? Bool,
            replace: raw["replace"] as? Bool ?? false
        )
    }

    private static func op(_ raw: [String: Any]) throws -> SnackbarOp {
        switch raw["op"] as? String {
        case "show": return .show(request(raw))
        case "elapse": return .elapse
        case "action": return .action
        case "dismiss": return .dismiss
        case "hide": return .hide(raw["id"] as? String)
        default: throw Failure(description: "unknown op \(raw["op"] ?? "nil")")
        }
    }

    private static func verifyQueue(_ cases: [[String: Any]]) throws -> Int {
        guard !cases.isEmpty else { throw Failure(description: "queueCases is empty") }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            var state = SnackbarState()
            for step in raw["ops"] as? [[String: Any]] ?? [] {
                let next = try op(step)
                state = SnackbarQueue.apply(state, next)
            }
            let expect = raw["expect"] as? [String: Any] ?? [:]
            let wantedCurrent = expect["current"] as? String
            try same(state.current?.id, wantedCurrent, "\(name) — current")
            try same(state.queue.map { $0.id }, (expect["pending"] as? [String]) ?? [],
                     "\(name) — pending")
            let wantedSettled = (expect["settled"] as? [[String: Any]] ?? []).map {
                "\($0["id"] as? String ?? "")=\($0["result"] as? String ?? "")"
            }
            try same(state.settled.map { "\($0.id)=\($0.result.rawValue)" }, wantedSettled,
                     "\(name) — settled")
            try same(state.pending, state.queue.count, "\(name) — pending count")
        }
        return cases.count
    }

    // MARK: - liftCases → resolveLift

    private static func verifyLift(_ cases: [[String: Any]]) throws -> Int {
        guard !cases.isEmpty else { throw Failure(description: "liftCases is empty") }
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let lift = raw["lift"] as? [String: Any] ?? [:]
            let expect = raw["expect"] as? [String: Any] ?? [:]
            let got = SnackbarQueue.resolveLift(SnackbarQueue.Chrome(
                position: lift["position"] as? String,
                safeAreaTop: int(lift["safeAreaTop"]),
                safeAreaBottom: int(lift["safeAreaBottom"]),
                bottomBar: int(lift["bottomBar"]),
                fab: int(lift["fab"]),
                keyboard: int(lift["keyboard"])
            ))
            try same(got.edge.rawValue, expect["edge"] as? String ?? "", "\(name) — edge")
            try same(got.inset, int(expect["inset"]), "\(name) — inset")
            try same(got.clearsHomeIndicator, expect["clearsHomeIndicator"] as? Bool ?? false,
                     "\(name) — clearsHomeIndicator")
        }
        return cases.count
    }

    // MARK: - the properties a table of examples cannot state

    /// Duration parsing is TOTAL: no input fails a build, and none of them pins a card forever.
    private static func verifyDurationIsTotal() throws -> Int {
        let junk: [Any?] = [nil, "", "   ", "soon", "NaN", true, [String]()]
        for value in junk {
            try same(SnackbarQueue.resolveDuration(value), SnackbarQueue.defaultMs, "junk \(value ?? "nil")")
            try same(SnackbarQueue.resolveDuration(value, hasAction: true), SnackbarQueue.shortMs,
                     "junk with action \(value ?? "nil")")
        }
        for bad in [Double.nan, Double.infinity, -Double.infinity] {
            try same(SnackbarQueue.resolveDuration(bad), SnackbarQueue.defaultMs, "bad \(bad)")
        }
        try same(SnackbarQueue.resolveDuration(-1_000_000), SnackbarQueue.minMs, "a huge negative clamps")
        try same(SnackbarQueue.resolveDuration(10_000_000), SnackbarQueue.maxMs, "a huge positive clamps")
        return 1
    }

    /// THE INVARIANT: whatever geometry the platform reports — including negatives from a
    /// rotation race — the card sits at least one gap above the safe area.
    private static func verifyNeverCoversTheHomeIndicator() throws -> Int {
        let values = [-10_000, -1, 0, 12, 34, 400, 10_000]
        for safeBottom in values {
            for keyboard in values {
                for bar in [0, 49, -49] {
                    let got = SnackbarQueue.resolveLift(SnackbarQueue.Chrome(
                        position: "bottom", safeAreaTop: 47, safeAreaBottom: safeBottom,
                        bottomBar: bar, fab: 0, keyboard: keyboard))
                    let safe = safeBottom > 0 ? safeBottom : 0
                    guard got.inset >= safe + SnackbarQueue.gap, got.clearsHomeIndicator else {
                        throw Failure(description: "lift \(got.inset) sits on the home indicator "
                                      + "(safeBottom \(safeBottom), keyboard \(keyboard), bar \(bar))")
                    }
                }
            }
        }
        return 1
    }

    /// `show` resolves on OUTCOME, so a card that settles twice is a double undo.
    private static func verifyEveryCardSettlesExactlyOnce() throws -> Int {
        var state = SnackbarState()
        state = SnackbarQueue.apply(state, .show(SnackbarRequest(
            id: "a", message: "a", action: SnackbarAction(label: "Undo", id: "u"))))
        state = SnackbarQueue.apply(state, .show(SnackbarRequest(id: "b", message: "b")))
        let endings: [SnackbarOp] = [.action, .action, .dismiss, .elapse, .hide(nil)]
        for step in endings { state = SnackbarQueue.apply(state, step) }
        var counts: [String: Int] = [:]
        for settlement in state.settled { counts[settlement.id, default: 0] += 1 }
        try same(counts, ["a": 1, "b": 1], "settlement counts")

        // …and the queue drains FIFO, one card at a time, all the way down.
        var drain = SnackbarState()
        let ids = ["a", "b", "c", "d", "e"]
        for id in ids { drain = SnackbarQueue.apply(drain, .show(SnackbarRequest(id: id, message: id))) }
        try same(drain.current?.id, "a", "one at a time")
        try same(drain.pending, 4, "the rest wait")
        var seen: [String] = []
        for _ in ids {
            seen.append(drain.current?.id ?? "")
            drain = SnackbarQueue.apply(drain, .elapse)
        }
        try same(seen, ids, "FIFO order")
        try same(drain.current?.id, nil, "the queue empties")
        return 1
    }

    /// A button with no label is not a button — and without one, the wordless default stays 2s.
    private static func verifyAnActionWithNoLabelIsNotAnAction() throws -> Int {
        let entry = SnackbarQueue.normalize(SnackbarRequest(
            id: "a", message: "m", action: SnackbarAction(label: "", id: "u")))
        guard entry.action == nil else {
            throw Failure(description: "an action button with no label survived normalization")
        }
        try same(entry.durationMs, SnackbarQueue.defaultMs, "no action keeps the 2s default")
        return 1
    }
}
