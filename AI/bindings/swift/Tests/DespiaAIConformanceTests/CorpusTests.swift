//
//  CorpusTests.swift - the Swift runner for the whole shared corpus.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The same files the TypeScript and Kotlin runners read, driven through the
//  Swift host over the REAL C++ MockEngine. Expectation semantics are identical
//  to CorpusTest.kt by design: subset matching everywhere, `events` as an ordered
//  SUBSEQUENCE, counts exact. If two runners ever disagree about what a case
//  means, that is the bug the corpus exists to surface.
//
//  Cases this lane cannot drive are SKIPPED BY NAME with a printed reason and a
//  count, never silently. Today that is the handful whose steps land mid-stream
//  (`cancel` and `resync` against a paused script): the native engine runs its
//  worker asynchronously while this runner drives steps synchronously, so those
//  are exercised by NativeSeamTests instead, where the threading is the point.
//
//  ONE DELIBERATE DIFFERENCE from the Kotlin runner: Kotlin wraps each case in
//  `catch (e: Throwable)` and records the throw as that case's failure. Swift has
//  no equivalent for a runtime trap, so a case that traps takes the suite down
//  rather than being reported as one red case. Nothing in Host.swift force-
//  unwraps or force-indexes, which is what keeps that a theoretical difference.
//

import XCTest

import DespiaAI

final class CorpusTests: XCTestCase {

    // MARK: - locating the corpus

    /// Walks up from this source file, then from the working directory, looking
    /// for the corpus. Two candidate names because the mirror publishes the
    /// package with the fixtures vendored at `conformance/ai`, while in the
    /// monorepo they live at `OpenSource/Conformance/ai`.
    private func corpusRoot() -> URL? {
        let starts = [
            URL(fileURLWithPath: #filePath).deletingLastPathComponent(),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        ]
        for start in starts {
            var dir = start.standardizedFileURL
            while true {
                for candidate in ["OpenSource/Conformance/ai", "conformance/ai"] {
                    let probe = dir.appendingPathComponent(candidate)
                    let values = try? probe.resourceValues(forKeys: [.isDirectoryKey])
                    if values?.isDirectory == true { return probe }
                }
                let parent = dir.deletingLastPathComponent().standardizedFileURL
                if parent.path == dir.path { break }
                dir = parent
            }
        }
        return nil
    }

    private func corpusFiles(_ root: URL) -> [URL] {
        guard let walker = FileManager.default.enumerator(atPath: root.path) else { return [] }
        var out: [URL] = []
        for case let relative as String in walker where relative.hasSuffix(".json") {
            // The G2P cases drive a C++ frontend with no Swift equivalent. They carry no
            // `steps` and none of the generic host's expectation keys, so walking them here
            // built a host, ran zero steps, recognised zero keys, and reported 63 passes —
            // a vacuously green gate, which is worse than an absent one. TS
            // (AI/conformance/run.ts) and Kotlin (CorpusTest.kt) already skip them for this
            // reason; the real runner is engine/test/g2p_corpus.cpp via
            // ClosedSource/scripts/check_g2p_corpus.rb, which is per-PR and serves all 63.
            if relative == "g2p" || relative.hasPrefix("g2p/") { continue }
            out.append(root.appendingPathComponent(relative))
        }
        return out.sorted { $0.path < $1.path }
    }

    // MARK: - expectation semantics (identical to CorpusTest.kt)

    private func subsetMatch(_ expected: JSON, _ actual: JSON) -> Bool {
        switch expected {
        case .object(let fields):
            for (key, value) in fields.pairs where !subsetMatch(value, actual[key]) { return false }
            return true
        case .array(let items):
            guard case .array(let got) = actual, got.count >= items.count else { return false }
            for (index, value) in items.enumerated() where !subsetMatch(value, got[index]) {
                return false
            }
            return true
        default:
            return expected.render() == actual.render()
        }
    }

    private func show(_ value: JSON) -> String {
        let text = value.render()
        return text.count > 300 ? String(text.prefix(300)) + "..." : text
    }

    /// A step that lands mid-stream needs the engine suspended while the driver
    /// keeps running. The native worker is asynchronous, so those cases belong to
    /// NativeSeamTests rather than to this runner.
    private func drivable(_ testCase: JSON) -> Bool {
        !testCase["steps"].items.contains { $0.has("cancel") || $0.has("resync") }
    }

    private func checkList(_ name: String, _ expected: [JSON], _ actual: [JSON],
                           _ fails: inout [String]) {
        if actual.count < expected.count {
            fails.append("\(name): expected at least \(expected.count), got \(actual.count): " +
                         show(.array(actual)))
            return
        }
        for (index, want) in expected.enumerated() where !subsetMatch(want, actual[index]) {
            fails.append("\(name)[\(index)]: expected \(show(want)), got \(show(actual[index]))")
        }
        if expected.isEmpty, !actual.isEmpty {
            fails.append("\(name): expected none, got " + show(.array(actual)))
        }
    }

    // MARK: - one case

    private func runCase(_ testCase: JSON, _ fails: inout [String]) {
        let expect = testCase["expect"]

        // A build-abort case asserts a PREPARE-time refusal, answered by the
        // derivation and never by a running request.
        if expect.has("buildAbort") {
            let host = Host(testCase)
            defer { host.close() }
            guard let abort = host.buildAbort else {
                fails.append("expected a build abort, the derivation produced none")
                return
            }
            if !subsetMatch(expect["buildAbort"], abort) {
                fails.append("buildAbort: expected \(show(expect["buildAbort"])), got \(show(abort))")
            }
            return
        }

        let host = Host(testCase)
        defer { host.close() }

        for step in testCase["steps"].items {
            if step.has("call") {
                host.call(step["call"])
            } else if step.has("approve") {
                host.approve(step["approve"]["id"].string(),
                             step["approve"]["decision"].string() == "deny" ? "deny" : "approve")
            } else if step.has("tick") {
                host.tick(Int(step["tick"]["ms"].number()))
            } else if step.has("serverRequest") {
                host.serverRequest(step["serverRequest"])
            } else {
                fails.append("unknown step: \(show(step))")
            }
        }

        // events: an ordered SUBSEQUENCE, same as the other two runners.
        var cursor = 0
        for want in expect["events"].items {
            var found = -1
            for index in cursor ..< max(cursor, host.events.count) {
                let got = host.events[index]
                if want.has("req"), got.req != want["req"].string() { continue }
                if want.has("event"), got.event != want["event"].string() { continue }
                if want.has("final"), got.isFinal != want["final"].bool() { continue }
                if want.has("data"), !subsetMatch(want["data"], got.data) { continue }
                found = index
                break
            }
            if found < 0 {
                let seen = host.events.map { "\($0.req):\($0.event)" }.joined(separator: ",")
                fails.append("expected event \(show(want)) after index \(cursor); got \(seen)")
                break
            }
            cursor = found + 1
        }

        for (name, want) in expect["eventCounts"].fields.pairs {
            let got = host.events.filter { $0.event == name }.count
            if got != want.int() { fails.append("eventCounts.\(name): expected \(want.int()), got \(got)") }
        }

        if expect.has("distinctRids") {
            let rids = expect["distinctRids"].strings.map { host.ridOf[$0] }
            if Set(rids).count != rids.count || rids.contains(where: { $0 == nil }) {
                fails.append("distinctRids: labels did not map to distinct request ids (\(rids))")
            }
        }

        for (label, want) in expect["results"].fields.pairs {
            guard let got = host.results[label] else {
                fails.append("results.\(label): no result was recorded")
                continue
            }
            if !subsetMatch(want, got) {
                fails.append("results.\(label): expected \(show(want)), got \(show(got))")
            }
        }

        if expect.has("errors") { checkList("errors", expect["errors"].items, host.errors, &fails) }
        if expect.has("absent") { checkList("absent", expect["absent"].items, host.absent, &fails) }
        if expect.has("notices") { checkList("notices", expect["notices"].items, host.notices, &fails) }
        if expect.has("catalogNotices") {
            checkList("catalogNotices", expect["catalogNotices"].items, host.catalogNotices, &fails)
        }
        if expect.has("dispatched") {
            checkList("dispatched", expect["dispatched"].items, host.dispatched, &fails)
        }
        if expect.has("engineRequests") {
            checkList("engineRequests", expect["engineRequests"].items, host.engineRequests, &fails)
        }
        if expect.has("remoteRequests") {
            checkList("remoteRequests", expect["remoteRequests"].items, host.remoteRequests, &fails)
        }
        if expect.has("rows") { checkList("rows", expect["rows"].items, host.rows, &fails) }
        if expect.has("providers") {
            checkList("providers", expect["providers"].items, host.providers, &fails)
        }
        if expect.has("transcript") {
            checkList("transcript", expect["transcript"].items, host.transcript, &fails)
        }
        if expect.has("serverResponses") {
            checkList("serverResponses", expect["serverResponses"].items, host.serverResponses, &fails)
        }
        if expect.has("resolveAttempts") {
            checkList("resolveAttempts", expect["resolveAttempts"].items, host.resolveAttempts, &fails)
        }
        if expect.has("downloadAttempts") {
            checkList("downloadAttempts", expect["downloadAttempts"].items, host.downloadAttempts, &fails)
        }
        if expect.has("downloaded") {
            checkList("downloaded", expect["downloaded"].items, host.downloaded, &fails)
        }

        if expect.has("deletedOnMismatch") {
            let want = expect["deletedOnMismatch"].strings
            if want != host.deletedOnMismatch {
                fails.append("deletedOnMismatch: expected \(want), got \(host.deletedOnMismatch)")
            }
        }
        for (model, want) in expect["pinnedDigests"].fields.pairs {
            if host.pinnedDigests[model] != want.string() {
                fails.append("pinnedDigests.\(model): expected \(want.string()), " +
                             "got \(String(describing: host.pinnedDigests[model]))")
            }
        }

        if expect.has("dispatchGroups") {
            let want = expect["dispatchGroups"].items.map { $0.strings }
            if want != host.dispatchGroups {
                fails.append("dispatchGroups: expected \(want), got \(host.dispatchGroups)")
            }
        }

        let counts: [(String, JSON, Int)] = [
            ("dispatchCount", expect["dispatchCount"], host.dispatched.count),
            ("engineRequestCount", expect["engineRequestCount"], host.engineRequests.count),
            ("remoteRequestCount", expect["remoteRequestCount"], host.remoteRequests.count),
            ("downloadCount", expect["downloadCount"], host.downloadCount),
            ("mcpConnectCount", expect["mcpConnectCount"], host.mcpConnectCount),
            ("engineLoadCount", expect["engineLoadCount"], host.engineLoadCount),
            ("downloadAttemptCount", expect["downloadAttemptCount"], host.downloadAttempts.count),
            ("resolveAttemptCount", expect["resolveAttemptCount"], host.resolveAttempts.count),
        ]
        for (name, want, got) in counts where !want.isNull {
            if want.int() != got { fails.append("\(name): expected \(want.int()), got \(got)") }
        }

        for (id, want) in expect["verdicts"].fields.pairs {
            guard let got = host.verdicts[id] else {
                fails.append("verdicts.\(id): no verdict was computed")
                continue
            }
            if !subsetMatch(want, got.toJSON()) {
                fails.append("verdicts.\(id): expected \(show(want)), got \(show(got.toJSON()))")
            }
        }

        if expect.has("maxEventBytes") {
            // The bound applies to INCREMENTAL events; sync and complete are
            // snapshots by design.
            let bound = expect["maxEventBytes"].int()
            for event in host.events where event.event != "sync" && event.event != "complete" {
                let size = event.data.render().count
                if size > bound {
                    fails.append("maxEventBytes: a \(event.event) event serialized to " +
                                 "\(size) bytes, over \(bound)")
                    break
                }
            }
        }

        if expect["noInlineBytes"].bool() {
            let text = host.events.map { $0.data.render() }.joined(separator: ",") +
                       host.engineRequests.map { $0.render() }.joined(separator: ",")
            if CorpusTests.looksLikeInlineBase64(text) {
                fails.append("noInlineBytes: a payload looks like inline base64")
            }
        }
        if expect["noErrors"].bool(), !host.errors.isEmpty {
            fails.append("noErrors: the case produced " + show(.array(host.errors)))
        }

        let flags: [(String, Bool)] = [
            ("dispatchedAfterApproval", host.dispatchedAfterApproval),
            ("snapshotBeforeWrite", host.snapshotBeforeWrite),
            ("snapshotBeforeFirstWrite", host.snapshotBeforeFirstWrite),
            ("boundLoopbackOnly", host.boundLoopbackOnly),
            ("transcriptTransmitted", host.transcriptTransmitted),
            ("tokenInUrl", host.tokenInUrl),
        ]
        for (name, got) in flags {
            let want = expect[name]
            if !want.isNull, want.bool() != got {
                fails.append("\(name): expected \(want.bool()), got \(got)")
            }
        }

        if expect.has("discoveryFile") {
            guard let got = host.discoveryFile else {
                fails.append("discoveryFile: none was written")
                return
            }
            if !subsetMatch(expect["discoveryFile"], got) {
                fails.append("discoveryFile: expected \(show(expect["discoveryFile"])), got \(show(got))")
            }
        }
    }

    /// The Kotlin runner's `"[A-Za-z0-9+/]{512,}={0,2}"` scan, hand-rolled so the
    /// check does not depend on a regex engine's behaviour differing per platform.
    private static func looksLikeInlineBase64(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        var index = 0
        while index < scalars.count {
            guard scalars[index] == "\"" else { index += 1; continue }
            var cursor = index + 1
            var run = 0
            while cursor < scalars.count, isBase64Scalar(scalars[cursor]) {
                run += 1
                cursor += 1
            }
            var padding = 0
            while cursor < scalars.count, scalars[cursor] == "=", padding < 2 {
                padding += 1
                cursor += 1
            }
            if run >= 512, cursor < scalars.count, scalars[cursor] == "\"" { return true }
            index = cursor > index ? cursor : index + 1
        }
        return false
    }

    private static func isBase64Scalar(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x30 ... 0x39, 0x41 ... 0x5A, 0x61 ... 0x7A: return true
        default: return s == "+" || s == "/"
        }
    }

    // MARK: - the suite

    func testTheSharedCorpusRunsOnTheSwiftHost() throws {
        guard let root = corpusRoot() else {
            XCTFail("the ai corpus was not found from \(#filePath) or " +
                    FileManager.default.currentDirectoryPath)
            return
        }
        var total = 0
        var ran = 0
        var skipped: [String] = []
        var failures: [String] = []
        var redCases = Set<String>()

        for file in corpusFiles(root) {
            let relative = file.path.replacingOccurrences(of: root.path + "/", with: "")
            let text = try String(contentsOf: file, encoding: .utf8)
            guard let document = JSON.parseOrNull(text) else {
                failures.append("\(relative) :: the file is not valid JSON")
                continue
            }
            for testCase in document["cases"].items {
                total += 1
                let name = testCase["name"].string()
                if !drivable(testCase) { skipped.append(name); continue }
                ran += 1
                var fails: [String] = []
                runCase(testCase, &fails)
                if !fails.isEmpty { redCases.insert("\(relative) :: \(name)") }
                failures.append(contentsOf: fails.map { "\(relative) :: \(name)\n      \($0)" })
            }
        }

        print("swift corpus: \(ran - redCases.count)/\(ran) drivable cases passed " +
              "(\(total) total, \(skipped.count) need a mid-stream step, which the " +
              "asynchronous native worker cannot serve from a synchronous driver: " +
              skipped.joined(separator: "; ") + ")")
        if !failures.isEmpty {
            XCTFail("swift corpus:\n  " + failures.joined(separator: "\n  "))
        }
    }
}
