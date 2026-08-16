//
//  CorpusTests.swift - the Swift runner for the Despia Local conformance corpus.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The same files OpenSource/Local/conformance/run.ts and the Kotlin CorpusTest
//  read, driven through the C ABI. That is the entire reason this exists. Until
//  the Swift binding was rewritten onto despia_local.h it was a SECOND
//  implementation of the store - its own SQL over the platform's libsqlite3 - and
//  a second implementation nobody runs against the same fixtures is a divergence
//  waiting to be discovered by an app. Two of the twenty-six cases would not even
//  have been expressible on it, because the system SQLite carries no sqlite-vec.
//
//  Expectation semantics are IDENTICAL to CorpusTest.kt by design: subset
//  matching for results and store rows, ordered subset for errors, exact row
//  counts, an expected `null` that requires the key to be PRESENT and null, and a
//  fresh temporary database per case so state never leaks and the `crash` step can
//  genuinely close and reopen a file. If the two runners ever disagree about what
//  a case means, that is the bug the corpus exists to surface.
//
//  SKIPS ARE NAMED AND PRINTED, NEVER SILENT, and they are decided by asking the
//  library what it carries rather than by a list kept here. A build compiled
//  without the vector backend (DESPIA_LOCAL_HAS_VEC=0) genuinely cannot run the
//  eight vector cases; on such a build this reports them as skipped with the
//  action that is missing, instead of eight failures that say nothing useful. On
//  the default build - the one Package.swift describes - nothing is skipped and
//  all twenty-six run.
//
//  TWO DELIBERATE DIFFERENCES from the Kotlin runner, both invisible to every
//  fixture and stated so nobody has to rediscover them:
//
//    1. Kotlin wraps each case in `catch (e: Throwable)`. Swift has no equivalent
//       for a runtime trap, so a case that traps takes the suite down rather than
//       being reported as one red case. Nothing in the binding force-unwraps or
//       force-indexes, which is what keeps that theoretical.
//    2. An embedding whose width is outside the ABI's declared range arrives here
//       as a typed `invalid_embedding` (the Swift `Embedding` initialiser throws
//       a LocalError where Kotlin's `require` throws IllegalArgumentException), so
//       it is RECORDED as an error rather than reported as a throw. No fixture
//       distinguishes the two.
//

import XCTest

import DespiaLocal

final class CorpusTests: XCTestCase {

    // MARK: - locating the corpus

    /// Walks up from this source file, then from the working directory. Two
    /// candidate names because the mirror publishes the package with the fixtures
    /// vendored at `conformance/local`, while in the monorepo they live at
    /// `OpenSource/Conformance/local`.
    private func corpusRoot() -> URL? {
        let starts = [
            URL(fileURLWithPath: #filePath).deletingLastPathComponent(),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        ]
        for start in starts {
            var dir = start.standardizedFileURL
            while true {
                for candidate in ["OpenSource/Conformance/local", "conformance/local"] {
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
            out.append(root.appendingPathComponent(relative))
        }
        return out.sorted { $0.path < $1.path }
    }

    // MARK: - expectation semantics (identical to CorpusTest.kt)

    /// Subset matching, with one strictness the shape makes possible: an expected
    /// `null` requires the key to be PRESENT and null, so "the store answered
    /// null" is not satisfied by "the store said nothing". The crud corpus
    /// asserts exactly that difference.
    private func subsetMatch(_ expected: Json, _ actual: Json) -> Bool {
        switch expected {
        case .object(let fields):
            for (key, value) in fields.pairs {
                if value.isNull {
                    if !(actual.has(key) && actual[key].isNull) { return false }
                } else if !subsetMatch(value, actual[key]) {
                    return false
                }
            }
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

    private func show(_ value: Json) -> String {
        let text = value.render()
        return text.count > 300 ? String(text.prefix(300)) + "..." : text
    }

    // MARK: - the harness

    private final class Harness {
        let store: DespiaLocal
        /// A JsonObject rather than a dictionary because it keeps insertion
        /// order, which is what makes `hitsCarryDistance` and friends pick the
        /// same result on every run.
        var results = JsonObject()
        var errors: [Json] = []
        var toolDispatched: [String] = []
        var snapshotBeforeFirstWrite = false

        init(_ store: DespiaLocal) { self.store = store }
    }

    /// The corpus action vocabulary, spelled through the typed face rather than
    /// through the raw funnel - so this runner exercises the call sites an app
    /// actually uses, including the embedding parameters vectors cannot omit.
    private func callBase(_ h: Harness, _ action: String, _ args: Json) throws -> Json {
        let store = h.store
        switch action {
        case "declare":
            return try store.declareStore(args["store"].string())
        case "put":
            return try store.put(args["store"].string(), args["key"].string(), args["value"])
        case "get":
            return try store.get(args["store"].string(), args["key"].string())
        case "delete":
            return try store.delete(args["store"].string(), args["key"].string())
        case "query":
            return try store.query(args["store"].string(), where: args["where"],
                                   order: args["order"], limit: args["limit"].int())
        case "stats":
            return try store.stats()
        case "savepoint":
            return try store.savepoint(args["name"].string())
        case "release":
            return try store.release(args["name"].string())
        case "rollback":
            return try store.rollback(args["name"].string())
        case "snapshot":
            return try store.snapshot(args["label"].string())
        case "snapshots":
            return try store.snapshots()
        case "restore":
            return try store.restore(args["label"].string())
        case "export":
            return try store.export(args["label"].string())
        case "index.upsert":
            return try store.indexUpsert(args["index"].string(), args["key"].string(),
                                         vector: args["vector"].numbers,
                                         embedding: try embeddingOf(args["embedding"]),
                                         value: args["value"])
        case "index.info":
            return try store.indexInfo(args["index"].string())
        case "index.search":
            return try store.indexSearch(args["index"].string(),
                                         vector: args["vector"].numbers,
                                         embedding: try embeddingOf(args["embedding"]),
                                         k: args.has("k") ? args["k"].int() : 10)
        case "index.delete":
            return try store.indexDelete(args["index"].string(), args["key"].string())
        case "index.reindex":
            return try store.indexReindex(args["index"].string(),
                                          embedding: try embeddingOf(args["embedding"]),
                                          vectors: args["vectors"].items)
        default:
            throw LocalError("unknown_action", "no base action named \(action)")
        }
    }

    /// A malformed embedding in a fixture is the store's typed refusal to answer,
    /// not the runner's crash - the ABI has an `invalid_embedding` code for
    /// exactly this and it must be reachable from here.
    private func embeddingOf(_ value: Json) throws -> Embedding {
        guard let embedding = try Embedding.from(value) else {
            throw LocalError("invalid_embedding",
                            "an embedding carries a model, a dimension and an optional revision")
        }
        return embedding
    }

    /// A case that reaches into the AI surface is exercising the agentic write
    /// guarantee, not the data plane's API. The runner takes the same
    /// snapshot-then-savepoint path the loop takes, so the ordering assertion is
    /// about behaviour and not about a flag someone set.
    private func runAgentTurn(_ h: Harness, _ testCase: Json) throws {
        let tools = testCase["tools"].items
        for (_, model) in testCase["mock"]["models"].fields.pairs {
            for turn in model["turns"].items {
                for step in turn.items {
                    guard step.has("tool") else { continue }
                    let call = step["tool"]
                    guard let spec = tools.first(where: {
                        $0["name"].string() == call["name"].string()
                    }) else { continue }
                    guard spec.has("mutates") else { continue }

                    if h.toolDispatched.isEmpty {
                        // BEFORE the first mutating dispatch, not after: a backup
                        // of a state the agent already touched would satisfy the
                        // word and break the promise.
                        try h.store.snapshot("agent")
                        h.snapshotBeforeFirstWrite = true
                    }
                    try h.store.savepoint("tool")
                    do {
                        if spec["fails"].bool() {
                            throw LocalError("tool_failed", "the tool failed mid-write")
                        }
                        let args = call["arguments"]
                        try h.store.put("notes", args["key"].string(), .obj([("v", args["v"])]))
                        try h.store.release("tool")
                    } catch is LocalError {
                        try h.store.rollback("tool")
                    }
                    h.toolDispatched.append(call["name"].string())
                }
            }
        }
    }

    // MARK: - one case

    private func runCase(_ testCase: Json, _ fails: inout [String]) throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("despia-local-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = try DespiaLocal(directory: dir)
        defer { store.close() }
        let h = Harness(store)

        // Seeding declares the stores and indexes a case uses. A row carrying a
        // `vector` seeds an index; anything else seeds a store.
        for (name, rows) in testCase["seed"].fields.pairs {
            let list = rows.items
            if !list.contains(where: { $0["vector"].isArray }) {
                try store.declareStore(name)
                for row in list { try store.put(name, row["key"].string(), row["value"]) }
            } else {
                for row in list {
                    try store.indexUpsert(name, row["key"].string(),
                                          vector: row["vector"].numbers,
                                          embedding: try embeddingOf(row["embedding"]),
                                          value: row["value"])
                }
            }
        }
        // Cases that drive the agentic loop write to `notes` through a tool.
        if testCase.has("tools"), !testCase["seed"].has("notes") {
            try store.declareStore("notes")
        }

        if testCase.has("mock") { try runAgentTurn(h, testCase) }

        for step in testCase["steps"].items {
            if step.has("crash") { try store.crash(); continue }
            if step.has("tick") { continue }
            guard step.has("call") else {
                fails.append("unknown step: \(show(step))")
                continue
            }
            let call = step["call"]
            // Handled by runAgentTurn: the intelligence surface is the ai
            // corpus's subject, and driving it twice would mean two places to
            // update when the envelope grows.
            if call["scheme"].string("base") == "intelligence" { continue }
            let label = call["as"].stringOrNull
            do {
                let result = try callBase(h, call["action"].string(), call["args"])
                if let label { h.results.set(label, result) }
            } catch let error as LocalError {
                var recorded = JsonObject()
                if let label { recorded.set("req", .string(label)) }
                for (key, value) in error.wire.fields.pairs { recorded.set(key, value) }
                h.errors.append(.object(recorded))
            }
        }

        try verify(testCase["expect"], h, store, &fails)
    }

    private func verify(_ expect: Json, _ h: Harness, _ store: DespiaLocal,
                        _ fails: inout [String]) throws {
        if expect.has("results") {
            for (label, want) in expect["results"].fields.pairs {
                guard let got = h.results[label] else {
                    fails.append("results.\(label): no result was recorded")
                    continue
                }
                if !subsetMatch(want, got) {
                    fails.append("results.\(label): expected \(show(want)), got \(show(got))")
                }
            }
        }

        if expect.has("errors") {
            let want = expect["errors"].items
            if want.isEmpty, !h.errors.isEmpty {
                fails.append("errors: expected none, got \(show(.array(h.errors)))")
            }
            for (index, wanted) in want.enumerated() {
                guard index < h.errors.count else {
                    fails.append("errors[\(index)]: expected \(show(wanted)), nothing was recorded")
                    continue
                }
                if !subsetMatch(wanted, h.errors[index]) {
                    fails.append("errors[\(index)]: expected \(show(wanted)), " +
                                 "got \(show(h.errors[index]))")
                }
            }
        }

        if expect.has("store") {
            for (name, rows) in expect["store"].fields.pairs {
                let actual = try store.query(name)["rows"].items
                let want = rows.items
                if actual.count != want.count {
                    fails.append("store.\(name): expected \(want.count) row(s), " +
                                 "got \(show(.array(actual)))")
                    continue
                }
                for (index, wanted) in want.enumerated() where !subsetMatch(wanted, actual[index]) {
                    fails.append("store.\(name)[\(index)]: expected \(show(wanted)), " +
                                 "got \(show(actual[index]))")
                }
            }
        }

        if expect["hitsCarryDistance"].bool() {
            let hits = h.results.pairs.first(where: { $0.1["hits"].isArray })?.1["hits"].items
            if hits == nil || hits?.contains(where: { !$0["distance"].isNumber }) == true {
                fails.append("hitsCarryDistance: a search hit arrived without its distance")
            }
        }
        if expect["snapshotsCarrySize"].bool() {
            let snaps = h.results.pairs.first(where: { $0.1["snapshots"].isArray })?
                .1["snapshots"].items
            if snaps == nil || snaps?.contains(where: { !$0["bytes"].isNumber }) == true {
                fails.append("snapshotsCarrySize: a listed snapshot arrived without its size")
            }
        }
        if expect["noInlineBytes"].bool() {
            // A snapshot is a FILE with a relative URL, never a base64 payload
            // riding the bus: an app's whole database inlined into a JSON result
            // is a memory spike and a leak of everything at once.
            let text = Json.object(h.results).render()
            if let regex = try? NSRegularExpression(pattern: "\"[A-Za-z0-9+/]{512,}={0,2}\""),
               regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil {
                fails.append("noInlineBytes: a payload looks like inline base64")
            }
        }
        if expect.has("snapshotBeforeFirstWrite"),
           expect["snapshotBeforeFirstWrite"].bool() != h.snapshotBeforeFirstWrite {
            fails.append("snapshotBeforeFirstWrite: expected " +
                         "\(expect["snapshotBeforeFirstWrite"].bool()), " +
                         "got \(h.snapshotBeforeFirstWrite)")
        }
        // expect.engineRequests asserts the AI wire envelope, which is the ai
        // corpus's subject. The base corpus asserts the TOOL's effect on the
        // store, and that is what `store` above checks.
    }

    // MARK: - self-description, applied to the runner

    /// Why a case cannot run on THIS build, or nil when it can. Derived from
    /// `despia_local_capabilities()` rather than from a list kept here, which is
    /// the engine constitution's first rule pointed at the runner: a build
    /// reports its own action surface and the runner adapts. On the default build
    /// this returns nil for all twenty-six.
    private func unsupported(_ testCase: Json, carried: Set<String>) -> String? {
        var required: Set<String> = []
        for step in testCase["steps"].items {
            guard step.has("call") else { continue }
            let call = step["call"]
            guard call["scheme"].string("base") != "intelligence" else { continue }
            required.insert(call["action"].string())
        }
        // A seeded index needs the vector surface even when no step names it.
        for (_, rows) in testCase["seed"].fields.pairs
        where rows.items.contains(where: { $0["vector"].isArray }) {
            required.insert("index.upsert")
        }
        let missing = required.subtracting(carried).sorted()
        return missing.isEmpty ? nil : "this build does not carry \(missing.joined(separator: ", "))"
    }

    // MARK: - the suite

    func testTheBaseCorpusPassesOnTheSwiftBinding() throws {
        guard let root = corpusRoot() else {
            XCTFail("the base corpus was not found — looked for OpenSource/Conformance/local " +
                    "and conformance/local above this file and above the working directory")
            return
        }

        let carried = Set(try DespiaLocal.capabilities()["actions"].strings)
        XCTAssertFalse(carried.isEmpty, "the library reported no actions at all")

        var total = 0
        var failedCases = 0
        var skipped: [String] = []
        var failures: [String] = []

        for file in corpusFiles(root) {
            guard let text = try? String(contentsOf: file, encoding: .utf8),
                  let doc = Json.parseOrNull(text) else {
                failures.append("could not read \(file.lastPathComponent) as JSON")
                continue
            }
            let prefix = root.path + "/"
            let rel = file.path.hasPrefix(prefix) ? String(file.path.dropFirst(prefix.count))
                                                  : file.lastPathComponent
            for testCase in doc["cases"].items {
                total += 1
                let name = testCase["name"].string()
                if let reason = unsupported(testCase, carried: carried) {
                    // Named and printed, at the skip AND in the summary. A skipped
                    // case is a fact about the build, and a fact nobody can see is
                    // indistinguishable from a pass.
                    skipped.append("\(name) (\(reason))")
                    print("SKIP \(rel) :: \(name) — \(reason)")
                    continue
                }
                var caseFails: [String] = []
                do {
                    try runCase(testCase, &caseFails)
                } catch {
                    caseFails.append("threw: \(error)")
                }
                if !caseFails.isEmpty {
                    failedCases += 1
                    failures.append("FAIL \(rel) :: \(name)")
                    for line in caseFails { failures.append("    \(line)") }
                }
            }
        }

        print("base conformance (swift): \(total - failedCases - skipped.count)/\(total) cases passed" +
              (skipped.isEmpty ? ", none skipped"
                               : ", \(skipped.count) skipped: " + skipped.joined(separator: "; ")))
        XCTAssertGreaterThan(total, 0,
                            "the corpus produced no cases — the runner found the wrong directory")
        if !failures.isEmpty { XCTFail(failures.joined(separator: "\n")) }
    }

    /// The seam itself, separate from the corpus: the eight symbols answer, the
    /// ownership rules hold, and this build reports the vector backend it was
    /// compiled with. It is the Swift analogue of engine/test/abi_test.cpp's first
    /// section, and it is what fails FIRST when the C target is misconfigured -
    /// so a wrong define set reads as "no vectors" rather than as eight confusing
    /// corpus failures.
    func testTheSeamReportsWhatThisBuildCarries() throws {
        XCTAssertEqual(DespiaLocal.abiVersion, 1)

        let caps = try DespiaLocal.capabilities()
        XCTAssertEqual(caps["abi"].int(), 1)
        XCTAssertFalse(caps["sqlite"]["version"].string().isEmpty,
                       "capabilities must name the SQLite underneath")

        // Typed absence, tested as typed absence: a build without the backend
        // OMITS `vectors`, so this asserts the two halves agree rather than
        // asserting one of them unconditionally.
        let hasVectors = caps.has("vectors")
        XCTAssertEqual(hasVectors, caps["features"].strings.contains("vectors"),
                       "`vectors` in capabilities and `vectors` in features must agree")
        if hasVectors {
            XCTAssertEqual(caps["vectors"]["backend"].string(), "sqlite-vec")
            XCTAssertTrue(caps["actions"].strings.contains("index.search"),
                          "a build carrying the vector backend serves index.search")
        }
    }

    /// A closed store answers `closed` rather than reaching a dangling handle.
    /// The ABI says using a handle after closing it is undefined; this is the
    /// binding making that impossible for a Swift caller to do.
    func testAClosedStoreRefusesRatherThanReachingADanglingHandle() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("despia-local-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = try DespiaLocal(directory: dir)
        try store.declareStore("notes")
        store.close()
        store.close()   // idempotent

        XCTAssertThrowsError(try store.stats()) { error in
            XCTAssertEqual((error as? LocalError)?.code, "closed")
        }
    }
}
