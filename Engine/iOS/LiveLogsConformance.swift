//
//  LiveLogsConformance.swift — the Swift runner for OpenSource/Conformance/livelogs/, both files.
//
//  Same corpus the TS runner (packages/kernel/test/livelogs-conformance.test.ts) and the Kotlin
//  runner (:core LiveLogsConformanceTest) read; this column is COMPILED AND RUN on the box by
//  swift_conformance_run_test.rb rather than riding a record lane, because the wire core is a
//  bytes-and-hash contract with nothing to render: what it decides is what leaves a device and
//  whether both ends of the relay agree, so the Swift twin is judged wherever the other two are.
//
//  What it judges is the pure core (`LiveLogs.swift`, scrubbing through TelemetryPolicy.swift)
//  and nothing else: entries in, wire bytes out. The flush timer, the transport and the consent
//  UI live in the dev.stream module and are not conformance.
//
//  Row and batch expectations compare CANONICAL BYTES rather than field by field — one comparison
//  that also catches a key that should have been omitted. Sound because `canonical` itself is
//  judged against pinned strings in report.json before anything leans on it.
//
//  Pure Foundation, no UIKit — nothing here records or sends anything.
//
import Foundation

enum LiveLogsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static func fail(_ file: String, _ label: String, _ message: String) -> Failure {
        Failure(description: "livelogs/\(file) — \(label): \(message)")
    }

    // ---------------------------------------------------------------- corpus plumbing

    private static func document(_ dir: URL, _ file: String) throws -> [String: Any] {
        let data = try Data(contentsOf: dir.appendingPathComponent(file))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "livelogs/\(file): not an object")
        }
        return root
    }

    private static func section(_ root: [String: Any], _ file: String, _ key: String) throws -> [[String: Any]] {
        guard let list = root[key] as? [[String: Any]], !list.isEmpty else {
            throw Failure(description: "livelogs/\(file): no \(key)[] — a section that vanished is "
                + "a green run that judges nothing")
        }
        return list
    }

    private static func name(_ c: [String: Any]) -> String { c["name"] as? String ?? "(unnamed)" }

    /// JSON `null` arrives as `NSNull`, which is PRESENT to Swift's optional machinery and absent
    /// to the corpus author who wrote it — the error row's omitted-message case turns on exactly
    /// that distinction, so every optional read goes through here.
    private static func present(_ any: Any?) -> Any? {
        guard let any, !(any is NSNull) else { return nil }
        return any
    }

    private static func map(_ any: Any?) -> [String: Any] { any as? [String: Any] ?? [:] }
    private static func maps(_ any: Any?) -> [[String: Any]] { any as? [[String: Any]] ?? [] }
    private static func text(_ any: Any?) -> String { any as? String ?? "" }
    private static func texts(_ any: Any?) -> [String] { (any as? [Any] ?? []).compactMap { $0 as? String } }
    private static func ints(_ any: Any?) -> [Int] { (any as? [Any] ?? []).map { int($0) } }

    /// JSONSerialization hands numbers back as NSNumber on both Foundations; the discriminator is
    /// `objCType`, never `is Bool` (ScrollCore.finite carries the note). The native branches are
    /// belt-and-braces for values a runner builds itself.
    private static func int(_ any: Any?) -> Int {
        if let number = any as? NSNumber {
            if String(cString: number.objCType) == "c" { return 0 }
            return Int(number.int64Value)
        }
        if let value = any as? Int { return value }
        if let value = any as? Int64 { return Int(value) }
        if let value = any as? Double { return Int(value) }
        return 0
    }

    private static func bool(_ any: Any?) -> Bool {
        if let number = any as? NSNumber {
            return String(cString: number.objCType) == "c" && number.boolValue
        }
        return any as? Bool ?? false
    }

    /// Canonical-bytes equality for a produced dictionary against a corpus `expect` object.
    private static func same(_ got: [String: Any], _ expected: Any?, _ file: String, _ label: String) throws {
        let want = try LiveLogs.canonical(map(expected))
        let bytes = try LiveLogs.canonical(got)
        if bytes != want { throw fail(file, label, "\(bytes) (expected \(want))") }
    }

    // ---------------------------------------------------------------- the two files

    static func verify(corpusDir dir: URL) throws -> Int {
        var total = 0
        total += try verifyWire(dir)
        total += try verifyReport(dir)
        return total
    }

    private static func verifyWire(_ dir: URL) throws -> Int {
        let file = "wire.json"
        let root = try document(dir, file)
        var total = 0
        total += try verifyConstants(map(root["constants"]), file)
        total += try verifyRows(section(root, file, "rows"), file)
        total += try verifyBatch(section(root, file, "batch"), file)
        total += try verifyAck(section(root, file, "ack"), file)
        total += try verifyQueue(section(root, file, "queue"), file)
        total += try verifyRing(section(root, file, "ring"), file)
        return total
    }

    private static func verifyConstants(_ pinned: [String: Any], _ file: String) throws -> Int {
        let got: [String: Int] = [
            "wireVersion": LiveLogs.wireVersion, "messageCap": LiveLogs.messageCap,
            "batchMaxRows": LiveLogs.batchMaxRows, "queueCap": LiveLogs.queueCap,
            "idleAckPause": LiveLogs.idleAckPause, "ringCap": LiveLogs.ringCap,
        ]
        guard pinned.count == got.count else {
            throw fail(file, "constants", "\(pinned.count) pinned, \(got.count) implemented — a "
                + "constant landed on one side only")
        }
        for (key, value) in got where int(pinned[key]) != value {
            throw fail(file, "constants", "\(key) \(value) (expected \(int(pinned[key])))")
        }
        return got.count
    }

    private static func verifyRows(_ list: [[String: Any]], _ file: String) throws -> Int {
        for c in list {
            let label = name(c)
            let entry = map(c["entry"])
            let at = int(c["at"])
            let got: [String: Any]
            switch c["kind"] as? String {
            case "log":
                got = LiveLogs.rowFromLog(scheme: text(entry["scheme"]), level: text(entry["level"]),
                                          message: text(entry["message"]), at: at)
            case "error":
                got = LiveLogs.rowFromError(scheme: text(entry["scheme"]), code: text(entry["code"]),
                                            message: present(entry["message"]) as? String,
                                            recoverable: bool(entry["recoverable"]),
                                            origin: text(entry["origin"]), at: at)
            case "kernel":
                got = LiveLogs.rowFromKernel(line: text(entry["line"]), at: at)
            default:
                throw fail(file, label, "unknown row kind \(c["kind"] as? String ?? "(none)")")
            }
            try same(got, c["expect"], file, label)
        }
        return list.count
    }

    private static func verifyBatch(_ list: [[String: Any]], _ file: String) throws -> Int {
        for c in list {
            let label = name(c)
            let body = LiveLogs.batchBody(sid: text(c["sid"]), n: int(c["n"]), rows: maps(c["rows"]))
            if let expect = present(c["expect"]) {
                try same(body, expect, file, label)
            } else {
                let got = try LiveLogs.canonical(body)
                let want = text(c["canonical"])
                if got != want { throw fail(file, label, "\(got) (expected \(want))") }
            }
        }
        return list.count
    }

    private static func verifyAck(_ list: [[String: Any]], _ file: String) throws -> Int {
        for c in list {
            let label = name(c)
            let steps = maps(c["steps"])
            let expects = maps(c["expect"])
            guard !steps.isEmpty, steps.count == expects.count else {
                throw fail(file, label, "\(steps.count) step(s), \(expects.count) expectation(s)")
            }
            var state = LiveLogs.ackStart()
            for (index, step) in steps.enumerated() {
                let at = int(step["at"])
                if bool(step["expire"]) {
                    state = LiveLogs.ackExpire(state, at: at)
                } else {
                    let ack = map(step["ack"])
                    state = LiveLogs.ackFold(state, ok: bool(ack["ok"]), viewers: int(ack["viewers"]),
                                             ttlMs: int(ack["ttlMs"]), at: at)
                }
                let e = expects[index]
                let want = LiveLogs.AckState(idle: int(e["idle"]), paused: bool(e["paused"]),
                                             stopped: bool(e["stopped"]),
                                             reason: e["reason"] as? String ?? "",
                                             deadline: int(e["deadline"]))
                if state != want {
                    throw fail(file, label, "step \(index): \(state) (expected \(want))")
                }
            }
        }
        return list.count
    }

    private static func verifyQueue(_ list: [[String: Any]], _ file: String) throws -> Int {
        for c in list {
            let label = name(c)
            let queue = LiveQueue<String>(cap: int(c["cap"]))
            let steps = maps(c["steps"])
            let expects = maps(c["expect"])
            guard !steps.isEmpty, steps.count == expects.count else {
                throw fail(file, label, "\(steps.count) step(s), \(expects.count) expectation(s)")
            }
            for (index, step) in steps.enumerated() {
                let e = expects[index]
                if let item = step["push"] as? String {
                    let got = queue.push(item)
                    if got.size != int(e["size"]) || got.dropped != int(e["dropped"]) {
                        throw fail(file, label, "step \(index): size \(got.size) dropped \(got.dropped) "
                            + "(expected \(int(e["size"])) / \(int(e["dropped"])))")
                    }
                } else if present(step["batch"]) != nil {
                    let got = queue.batch(int(step["batch"]))
                    let want = texts(e["batch"])
                    if got != want {
                        throw fail(file, label, "step \(index): batch \(got) (expected \(want))")
                    }
                } else {
                    let size = queue.ack(int(step["ack"]))
                    if size != int(e["size"]) {
                        throw fail(file, label, "step \(index): size \(size) (expected \(int(e["size"])))")
                    }
                }
            }
        }
        return list.count
    }

    private static func verifyRing(_ list: [[String: Any]], _ file: String) throws -> Int {
        for c in list {
            let label = name(c)
            let ring = LiveRing<String>(cap: int(c["cap"]))
            let steps = maps(c["steps"])
            let expects = maps(c["expect"])
            guard !steps.isEmpty, steps.count == expects.count else {
                throw fail(file, label, "\(steps.count) step(s), \(expects.count) expectation(s)")
            }
            for (index, step) in steps.enumerated() {
                let e = expects[index]
                if let append = present(step["appendBatch"]) {
                    let batch = map(append)
                    let got = ring.appendBatch(int(batch["n"]), rows: texts(batch["rows"]))
                    if got.accepted != bool(e["accepted"]) || got.last != int(e["last"]) {
                        throw fail(file, label, "step \(index): accepted \(got.accepted) last \(got.last) "
                            + "(expected \(bool(e["accepted"])) / \(int(e["last"])))")
                    }
                } else {
                    let read = map(step["read"])
                    let got = ring.read(after: int(read["after"]), limit: int(read["limit"]))
                    let seqs = got.rows.map { $0.seq }
                    if seqs != ints(e["seqs"]) || got.gap != bool(e["gap"]) {
                        throw fail(file, label, "step \(index): seqs \(seqs) gap \(got.gap) "
                            + "(expected \(ints(e["seqs"])) / \(bool(e["gap"])))")
                    }
                }
            }
        }
        return list.count
    }

    private static func verifyReport(_ dir: URL) throws -> Int {
        let file = "report.json"
        let root = try document(dir, file)
        var total = 0

        let vectors = try section(root, file, "sha256")
        for c in vectors {
            let input = text(c["input"])
            let got = LiveLogs.sha256Hex(input)
            let want = text(c["expect"])
            if got != want {
                throw fail(file, "sha256 \"\(input.prefix(24))\"", "\(got) (expected \(want))")
            }
        }
        total += vectors.count

        let canonicals = try section(root, file, "canonical")
        for c in canonicals {
            let label = name(c)
            let got = try LiveLogs.canonical(c["value"])
            let want = text(c["expect"])
            if got != want { throw fail(file, label, "\(got) (expected \(want))") }
        }
        total += canonicals.count

        let rejects = try section(root, file, "canonicalRejects")
        for c in rejects {
            let label = name(c)
            if let bytes = try? LiveLogs.canonical(c["value"]) {
                throw fail(file, label, "expected a refusal, got \(bytes)")
            }
        }
        total += rejects.count

        let seals = try section(root, file, "seal")
        for c in seals {
            let label = name(c)
            let got = try LiveLogs.reportSeal(map(c["body"]))
            if got.hash != text(c["hash"]) {
                throw fail(file, label, "hash \(got.hash) (expected \(text(c["hash"])))")
            }
            if got.text != text(c["text"]) {
                throw fail(file, label, "sealed text diverged from the pin:\n\(got.text)")
            }
        }
        total += seals.count

        let verdicts = try section(root, file, "verdict")
        for c in verdicts {
            let label = name(c)
            let e = map(c["expect"])
            let got = LiveLogs.reportVerdict(text(c["text"]))
            if got.verdict != text(e["verdict"]) || got.assertion != bool(e["assertion"]) {
                throw fail(file, label, "\(got.verdict) / assertion \(got.assertion) "
                    + "(expected \(text(e["verdict"])) / \(bool(e["assertion"])))")
            }
        }
        total += verdicts.count

        return total
    }
}
