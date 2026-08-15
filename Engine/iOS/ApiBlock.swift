//
//  ApiBlock.swift - the `<api>` block, iOS half (/web/05). Swift twin of the web
//  kernel's api.ts and Android's ApiBlock.kt — ONE law, encoded in
//  OpenSource/Conformance/api/api-blocks.json; all three runtimes run the same
//  fixtures (fixtures first — the W5 gate).
//
//    • reserved paths <as>.data/.loading/.refreshing/.error{status,message,body}/.fetchedAt
//      (plain store entries — normal JSE path reads resolve them)
//    • a block refetches when its MATERIALIZED request (url+method+headers+body,
//      watchKey-compared) changes: `storeChanged()` is called per store publish (the
//      watch machinery) and compares — the same observable law as the web's read
//      tracking.
//    • auto defaults true for GET and is a formula; network errors (status 0) retry
//      per `retry`, http errors do not; stale data survives a failed refetch
//    • cache: no-store (default) · max-age(d) · swr(fresh, stale) — a bounded,
//      surface-scoped LRU keyed by method+url+expect+headers+body+cookie partition;
//      send() always hits the network, refresh() revalidates
//    • events: success / error / message (a {stream:[…]} response appends each chunk
//      to <as>.data and fires message per chunk, then success)
//
//  SEAMS: the synchronous `fetch` initializer exists for the deterministic shared
//  corpus. Shipping surfaces use `fetchAsync`: it never blocks SwiftUI's main thread,
//  returns a real cancellation hook, and delivers its result back through the block's
//  generation guard. `now` is injectable (the corpus drives time). Kernel-pure: no
//  UIKit/WebKit — extension-safe like JSE.swift.
//

import Foundation

// ── the dependency graph (/web/11) ───────────────────────────────────────────────────
//
//  Swift twin of the web kernel's ApiGraph and Android's ApiGraph — ONE law, encoded in
//  OpenSource/Conformance/api/api-blocks.json:
//
//    • an edge exists when a block's url/headers/body expression names another block's
//      `as` as its PATH ROOT, plus the explicit `needs="a, b"` (invisible deps)
//    • an auto block is GATED while an upstream is unresolved / in error, or while an
//      interpolation landing in url/headers/body evaluates to null (`missing-value`)
//    • ambient planes (dsx.const/env/global/route/…) are TYPED-ABSENT by law, never holes
//    • a cycle, or a `needs=` naming an unknown block, is a DECLARED error
//

/// Text analysis shared by the graph and the gate. Deliberately conservative: the result
/// is only ever intersected with the sibling `as` names, or asked whether every path is
/// ambient. Mirrors api.ts `expressionPaths` / ApiGraphText.kt exactly.
enum ApiGraphText {
    private static let keywords: Set<String> = [
        "true", "false", "null", "undefined", "new", "typeof", "in", "of", "return",
        "if", "else", "function", "await", "void", "delete", "instanceof", "this",
    ]
    private static let ambientRoots: Set<String> = [
        "global", "route", "cookie", "platform", "os", "env", "screen", "source", "app",
        "query", "params", "path", "const",
    ]
    private static let dsxScopeHeads: Set<String> = ["variable", "formula", "item", "attribute", "element", "event", "action"]

    private static func isStart(_ c: Character) -> Bool {
        (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c == "_" || c == "$"
    }
    private static func isPart(_ c: Character) -> Bool { isStart(c) || (c >= "0" && c <= "9") }

    /// Every `{{ … }}` hole of an interpolation template, in source order.
    static func holes(_ template: String) -> [String] {
        guard template.contains("{{") else { return [] }
        var out: [String] = []
        var rest = Substring(template)
        while let open = rest.range(of: "{{") {
            guard let close = rest.range(of: "}}", range: open.upperBound..<rest.endIndex) else { break }
            out.append(String(rest[open.upperBound..<close.lowerBound]))
            rest = rest[close.upperBound...]
        }
        return out
    }

    /// The dotted PATHS an expression reads. String literals are skipped; `{ key: v }`
    /// keys are not paths; an identifier after `.` is a member, not a root.
    static func paths(_ expr: String) -> [String] {
        let chars = Array(expr)
        let n = chars.count
        var out: [String] = []
        var i = 0
        while i < n {
            let c = chars[i]
            if c == "\"" || c == "'" || c == "`" {
                i += 1
                while i < n && chars[i] != c {
                    if chars[i] == "\\" { i += 1 }
                    i += 1
                }
                i += 1
                continue
            }
            if !isStart(c) { i += 1; continue }
            var j = i
            while j < n && isPart(chars[j]) { j += 1 }
            var before = i - 1
            while before >= 0 && (chars[before] == " " || chars[before] == "\t" || chars[before] == "\n") { before -= 1 }
            var after = j
            while after < n && (chars[after] == " " || chars[after] == "\t") { after += 1 }
            let isMember = before >= 0 && chars[before] == "."
            let isObjectKey = after < n && chars[after] == ":" && (after + 1 >= n || chars[after + 1] != ":")
            if isMember || isObjectKey || keywords.contains(String(chars[i..<j])) { i = j; continue }
            var path = String(chars[i..<j])
            var cursor = j
            while true {
                var dot = cursor
                while dot < n && (chars[dot] == " " || chars[dot] == "\t") { dot += 1 }
                guard dot < n, chars[dot] == ".", dot + 1 < n, isStart(chars[dot + 1]) else { break }
                var end = dot + 1
                while end < n && isPart(chars[end]) { end += 1 }
                path += "." + String(chars[(dot + 1)..<end])
                cursor = end
            }
            out.append(path)
            i = cursor
        }
        return out
    }

    /// The scope name a dotted path reads — the edge candidate and the `blockedBy` name.
    static func scopeName(_ path: String) -> String {
        let parts = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.first == "dsx" else { return parts.first ?? path }
        if parts.count > 2, parts[1] == "variable" || parts[1] == "formula" { return parts[2] }
        return ""
    }

    static func isAmbient(_ path: String) -> Bool {
        let parts = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let head = parts.first ?? ""
        if head == "dsx" { return !dsxScopeHeads.contains(parts.count > 1 ? parts[1] : "") }
        return ambientRoots.contains(head)
    }

    /// A hole reading ONLY ambient planes is never a gate (typed absence, durability P4).
    static func holeIsAmbient(_ hole: String) -> Bool {
        let p = paths(hole)
        return p.isEmpty || p.allSatisfy { isAmbient($0) }
    }

    /// The name reported for a `missing-value` hole: its first non-ambient scope name.
    static func holeName(_ hole: String) -> String {
        for path in paths(hole) where !isAmbient(path) {
            let name = scopeName(path)
            if !name.isEmpty { return name }
        }
        return hole.trimmingCharacters(in: .whitespaces)
    }

    /// The upstream `<api>` names one spec reads: `needs=` first, then expression edges.
    static func upstreams(_ spec: [String: String], siblings: Set<String>) -> [String] {
        let selfName = spec["as"] ?? ""
        var out: [String] = []
        for raw in (spec["needs"] ?? "").split(separator: ",", omittingEmptySubsequences: false) {
            let name = raw.trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, name != selfName, !out.contains(name) { out.append(name) }
        }
        func push(_ name: String) {
            if !name.isEmpty, name != selfName, siblings.contains(name), !out.contains(name) { out.append(name) }
        }
        for hole in holes(spec["url"] ?? "") {
            for path in paths(hole) { push(scopeName(path)) }
        }
        for expr in [spec["headers"], spec["body"]].compactMap({ $0 }) {
            for path in paths(expr) { push(scopeName(path)) }
        }
        return out
    }

    static func unknownNeeds(_ spec: [String: String], siblings: Set<String>) -> [String] {
        var out: [String] = []
        for raw in (spec["needs"] ?? "").split(separator: ",", omittingEmptySubsequences: false) {
            let name = raw.trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, !siblings.contains(name), !out.contains(name) { out.append(name) }
        }
        return out
    }
}

/// The `<api>` dependency graph of ONE scope (/web/11). Every block mounts before any
/// fires; a settled block re-evaluates its dependents, so deep chains waterfall along
/// their own edges while everything else stays concurrent.
final class ApiGraph {
    private var names: [String] = []
    private var upstream: [String: [String]] = [:]
    private var unknown: [String: [String]] = [:]
    private var blocks: [String: ApiBlock] = [:]
    private var started = false

    /// the cycle path when the declared graph is not a DAG (a DECLARED error)
    private(set) var cycle: [String]?

    init(specs: [[String: String]]) {
        let siblings = Set(specs.compactMap { $0["as"] })
        for spec in specs {
            guard let name = spec["as"] else { continue }
            names.append(name)
            upstream[name] = ApiGraphText.upstreams(spec, siblings: siblings)
            let missing = ApiGraphText.unknownNeeds(spec, siblings: siblings)
            if !missing.isEmpty { unknown[name] = missing }
        }
        cycle = findCycle()
    }

    /// DFS with an explicit colour map — the first cycle found, walked in declaration
    /// order so every runtime reports the same one.
    private func findCycle() -> [String]? {
        var state: [String: Int] = [:] // 0 unvisited · 1 on-stack · 2 done
        var stack: [String] = []
        func walk(_ name: String) -> [String]? {
            if state[name] == 1 {
                let from = stack.firstIndex(of: name) ?? 0
                return Array(stack[from...]) + [name]
            }
            if state[name] == 2 { return nil }
            state[name] = 1
            stack.append(name)
            for up in upstream[name] ?? [] {
                guard upstream[up] != nil else { continue }
                if let found = walk(up) { return found }
            }
            stack.removeLast()
            state[name] = 2
            return nil
        }
        for name in names {
            if let found = walk(name) { return found }
        }
        return nil
    }

    func upstreamsOf(_ name: String) -> [String] { upstream[name] ?? [] }

    func unknownNeedsOf(_ name: String) -> [String] { unknown[name] ?? [] }

    func attach(_ block: ApiBlock, name: String) { blocks[name] = block }

    func detach(_ name: String) { blocks.removeValue(forKey: name) }

    /// Mount is over — every block is registered, so the runnable ones may start. The
    /// two phases matter on a SYNCHRONOUS transport: priming every gate first means a
    /// cascade cannot fire a block the start loop is about to reach.
    func start() {
        if started { return }
        started = true
        for name in names { blocks[name]?.graphPrime() }
        for name in names { blocks[name]?.graphStart() }
    }

    /// An upstream settled: its dependents fire the moment THEIR inputs are whole.
    func notifySettled(_ settled: String) {
        guard started else { return }
        for name in names where name != settled { blocks[name]?.storeChanged() }
    }
}

/// Dot-path reads/writes over a StackStore's vars — the block's envelope writer.
/// Copy-on-write upward rebuilds; numeric segments grow arrays (the shared shape).
enum DsxPaths {
    static func get(_ store: any JSEState, _ path: String) -> Any? {
        guard let parts = DsxStatePathPolicy.segments(path) else { return nil }
        guard let first = parts.first else { return nil }
        var cur: Any? = store.vars[first]
        for p in parts.dropFirst() {
            if p == "length", !(cur is [String: Any]) {
                if let arr = cur as? [Any] { cur = Double(arr.count); continue }
                if let s = cur as? String { cur = Double(s.count); continue }
                cur = nil
                continue
            }
            if let i = DsxStatePathPolicy.arrayIndex(p), let arr = cur as? [Any] {
                cur = i < arr.count ? arr[i] : nil
            } else {
                cur = (cur as? [String: Any])?[p]
            }
        }
        return cur
    }

    static func set(_ store: any JSEState, _ path: String, _ value: Any?) {
        guard let parts = DsxStatePathPolicy.segments(path) else { return }
        guard let first = parts.first else { return }
        guard store.vars[first] != nil || store.vars.count < DsxStatePathPolicy.maxContainerEntries else { return }
        let stored = value ?? NSNull()
        if parts.count == 1 {
            store.vars[first] = stored
            return
        }
        guard let rebuilt = DsxStatePathPolicy.rebuild(store.vars[first], parts.dropFirst(), stored) else { return }
        store.vars[first] = rebuilt
    }
}

final class ApiBlock {
    typealias FetchResult = [String: Any]
    typealias FetchRequest = [String: Any]
    typealias FetchCancellation = () -> Void
    typealias AsyncFetch = (
        _ url: String,
        _ request: FetchRequest,
        _ completion: @escaping (FetchResult) -> Void
    ) -> FetchCancellation?

    private let spec: [String: String]
    private let store: any JSEState
    private let item: [String: Any]?
    /// BLOCKING fetch seam: (url, request{method,headers,body,expect}) → envelope
    /// {ok, status, data[, stream]} — the host wraps URLSession + its queue.
    private let fetchSeam: ((String, FetchRequest) -> FetchResult)?
    private let asyncFetchSeam: AsyncFetch?
    private let now: () -> Double
    private let onEvent: (String, [String: Any]) -> Void
    private let cache: Cache
    private let cachePartition: (FetchRequest) -> String
    /// /web/11: the scope's `<api>` DAG. With a graph the block does NOT start on
    /// construction — every sibling mounts first, then `graph.start()` runs the
    /// runnable ones. Without one, the block is its own scope (unchanged).
    private let graph: ApiGraph?
    private var everFired = false
    private var declaredError: String?

    private let asName: String
    private let isAsNameValid: Bool
    private var lastRequestKey: String? = nil
    private var generation = 0
    private var disposed = false
    private var debounceWork: DispatchWorkItem?
    private var activeCancel: FetchCancellation?
    private var streamChunks: [Any]?
    /// At most one network request owns the block. Replacing/cancelling it settles an
    /// awaiting `send()` with nil immediately, even if a custom transport's cancel
    /// closure does not call its completion (URLSession does, test seams need not).
    private var pendingCompletion: ((FetchResult?) -> Void)?

    /// Async transports are external seams; defend against a buggy adapter invoking
    /// one completion twice (or two delegate paths racing). Claim is lock-backed
    /// because URLSession/custom callbacks may arrive on arbitrary queues.
    private final class ResponseGate {
        private let lock = NSLock()
        private var terminalClaimed = false

        /// Streaming transports may deliver any number of partial messages, then
        /// exactly one terminal envelope. Nothing is accepted after terminal.
        func claim(partial: Bool) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !terminalClaimed else { return false }
            if !partial { terminalClaimed = true }
            return true
        }
    }

    // ── bounded cache ────────────────────────────────────────────────────────────────
    fileprivate struct Entry { let data: Any?; let at: Double }

    /// A small lock-protected LRU. Shipping StackSurface instances own one cache,
    /// which prevents one signed-in surface/session from serving another's data.
    /// The shared instance remains only as a compatibility default for direct
    /// ApiBlock/conformance construction.
    final class Cache {
        private let capacity: Int
        private let lock = NSLock()
        private var entries: [String: Entry] = [:]
        /// Least-recently-used first. Capacity is deliberately small, so the
        /// straightforward O(n) touch is simpler and less failure-prone than a
        /// hand-rolled linked list.
        private var recency: [String] = []

        init(capacity: Int = 256) {
            self.capacity = max(0, capacity)
        }

        fileprivate func get(_ key: String) -> Entry? {
            lock.lock()
            defer { lock.unlock() }
            guard let entry = entries[key] else { return nil }
            recency.removeAll { $0 == key }
            recency.append(key)
            return entry
        }

        fileprivate func put(_ key: String, _ entry: Entry) {
            guard capacity > 0 else { return }
            lock.lock()
            defer { lock.unlock() }
            entries[key] = entry
            recency.removeAll { $0 == key }
            recency.append(key)
            while entries.count > capacity, let evicted = recency.first {
                recency.removeFirst()
                entries.removeValue(forKey: evicted)
            }
        }

        func clear() {
            lock.lock()
            entries.removeAll(keepingCapacity: true)
            recency.removeAll(keepingCapacity: true)
            lock.unlock()
        }
    }

    private static let sharedCache = Cache()

    static func clearCache() {
        sharedCache.clear()
    }

    /// "60" / "60s" / "10m" / "2h" → ms (bare numbers are seconds). Validated against the SAME
    /// anchored grammar as the TS/Kotlin twins (`^\d+(\.\d+)?\s*(ms|s|m|h)?$`), so a bad unit,
    /// a sign, or an exponent ("60x", "-5s", "6e2") is NOT a duration → 0, matching them.
    static func parseDuration(_ s: String) -> Double {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.range(of: #"^[0-9]+(\.[0-9]+)?\s*(ms|s|m|h)?$"#, options: .regularExpression) != nil else { return 0 }
        var digits = ""
        for ch in t { if ch.isNumber || ch == "." { digits.append(ch) } else { break } }
        let n = Double(digits) ?? 0
        switch t.dropFirst(digits.count).trimmingCharacters(in: .whitespaces) {
        case "ms": return n
        case "m": return n * 60_000
        case "h": return n * 3_600_000
        default: return n * 1000  // "s" or empty — the grammar admits nothing else
        }
    }

    private enum Policy {
        case noStore
        case maxAge(Double)
        case swr(Double, Double)
    }

    private let policy: Policy

    /// "max-age(60)" / "swr(10, 300)" / anything else → no-store. Hand-parsed.
    private static func parsePolicy(_ raw: String?) -> Policy {
        guard let raw = raw else { return .noStore }
        let t = raw.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("max-age(") && t.hasSuffix(")") {
            let inner = String(t.dropFirst(8).dropLast(1))
            return .maxAge(parseDuration(inner))
        }
        if t.hasPrefix("swr(") && t.hasSuffix(")") {
            let inner = String(t.dropFirst(4).dropLast(1))
            // split on the FIRST comma only — the TS/Kotlin regex captures a fresh group with no
            // comma, then a stale group that greedily takes the rest up to the close paren. So
            // `swr(10, 300, 60)` yields "10" and " 300, 60" — the malformed stale parses to 0,
            // NOT a 3-part reject.
            let parts = inner.split(separator: ",", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                return .swr(parseDuration(parts[0]), parseDuration(parts[1]))
            }
        }
        return .noStore
    }

    convenience init(
        spec: [String: String],
        store: any JSEState,
        item: [String: Any]? = nil,
        fetch: @escaping (String, [String: Any]) -> [String: Any],
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
        cache: Cache? = nil,
        cachePartition: @escaping (FetchRequest) -> String = { _ in "" },
        onEvent: @escaping (String, [String: Any]) -> Void = { _, _ in },
        graph: ApiGraph? = nil
    ) {
        self.init(
            spec: spec,
            store: store,
            item: item,
            syncFetch: fetch,
            asyncFetch: nil,
            now: now,
            cache: cache ?? ApiBlock.sharedCache,
            cachePartition: cachePartition,
            onEvent: onEvent,
            graph: graph
        )
    }

    /// Production initializer. The transport starts work and returns a cancellation
    /// closure; it may complete on any queue. ApiBlock serializes every state/event
    /// delivery onto the main queue before touching the SwiftUI-backed store.
    convenience init(
        spec: [String: String],
        store: any JSEState,
        item: [String: Any]? = nil,
        fetchAsync: @escaping AsyncFetch,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
        cache: Cache? = nil,
        cachePartition: @escaping (FetchRequest) -> String = { _ in "" },
        onEvent: @escaping (String, [String: Any]) -> Void = { _, _ in },
        graph: ApiGraph? = nil
    ) {
        self.init(
            spec: spec,
            store: store,
            item: item,
            syncFetch: nil,
            asyncFetch: fetchAsync,
            now: now,
            cache: cache ?? ApiBlock.sharedCache,
            cachePartition: cachePartition,
            onEvent: onEvent,
            graph: graph
        )
    }

    private init(
        spec: [String: String],
        store: any JSEState,
        item: [String: Any]?,
        syncFetch: ((String, FetchRequest) -> FetchResult)?,
        asyncFetch: AsyncFetch?,
        now: @escaping () -> Double,
        cache: Cache,
        cachePartition: @escaping (FetchRequest) -> String,
        onEvent: @escaping (String, [String: Any]) -> Void,
        graph: ApiGraph? = nil
    ) {
        self.graph = graph
        self.spec = spec
        self.store = store
        self.item = item
        self.fetchSeam = syncFetch
        self.asyncFetchSeam = asyncFetch
        self.now = now
        self.cache = cache
        self.cachePartition = cachePartition
        self.onEvent = onEvent
        let resolvedAsName = spec["as"] ?? "api"
        self.asName = resolvedAsName
        self.isAsNameValid = DsxStatePathPolicy.isIdentifier(resolvedAsName)
            && (store.vars[resolvedAsName] != nil || store.vars.count < DsxStatePathPolicy.maxContainerEntries)
        self.policy = ApiBlock.parsePolicy(spec["cache"])
        // seed the reserved paths — data null until first resolve (doc 05). `status`,
        // `blockedBy` and `progress` are /web/11 + networking.md N2 additions to the
        // SAME reserved envelope.
        if isAsNameValid, store.vars[asName] == nil {
            store.vars[asName] = [
                "data": NSNull(), "loading": false, "refreshing": false,
                "error": NSNull(), "fetchedAt": NSNull(),
                "status": "ready", "blockedBy": [Any](), "progress": NSNull(),
            ] as [String: Any]
        }
        if let graph = graph {
            if graph.cycle?.contains(resolvedAsName) == true { declaredError = "cycle" }
            else if !graph.unknownNeedsOf(resolvedAsName).isEmpty { declaredError = "unknown-needs" }
        }
        if isAsNameValid {
            if let graph = graph { graph.attach(self, name: asName) } else { mountFire() }
        }
    }

    /// /web/11 phase 1: publish this block's gate BEFORE any sibling fires, so a
    /// synchronous cascade cannot double-fire a block the start loop has yet to reach.
    func graphPrime() {
        guard !disposed, isAsNameValid else { return }
        if let declaredError = declaredError { publishDeclaredError(declaredError); return }
        let req = materialize()
        lastRequestKey = requestKey(req)
        publishGate(gateOf(req))
    }

    /// /web/11 phase 2: fire this block if it is runnable and a cascade has not already.
    func graphStart() {
        guard !disposed, isAsNameValid, declaredError == nil, !everFired else { return }
        let req = materialize()
        lastRequestKey = requestKey(req)
        let blocked = gateOf(req)
        publishGate(blocked)
        guard blocked.isEmpty, JSE.truthy(req["auto"]) else { return }
        everFired = true
        _ = fire(req, allowCache: true, refreshing: false, forceNetwork: false)
    }

    // ── materialize (the request from the live scope) ────────────────────────────────

    /// Absent and explicit-null both count as a HOLE (/web/11 rule 2): a value that is
    /// not there cannot be interpolated into a request the author meant to be whole.
    private static func isNullish(_ value: Any?) -> Bool {
        value == nil || value is NSNull
    }

    private func materialize() -> [String: Any] {
        let method = (spec["method"] ?? "GET").uppercased()
        let auto: Bool
        if let autoExpr = spec["auto"] {
            auto = JSE.truthy(JSE.eval(autoExpr, store: store, item: item))
        } else {
            auto = method == "GET"
        }
        // /web/11 value-presence gating rides the SAME pass that interpolates, so a gated
        // block costs no extra evaluation: each `{{ … }}` hole is checked as it is written.
        var missing: [String] = []
        var req: [String: Any] = [
            "url": interpolateGated(spec["url"] ?? "", missing: &missing),
            "method": method,
            "expect": spec["expect"] ?? "json",
            "auto": auto,
        ]
        if let headersExpr = spec["headers"] {
            let raw = JSE.eval(headersExpr, store: store, item: item)
            if let dict = raw as? [String: Any] {
                for key in dict.keys.sorted() where Self.isNullish(dict[key]) {
                    if !missing.contains(key) { missing.append(key) }
                }
            }
            let headers = Self.normalizedHeaders(raw)
            if !headers.isEmpty { req["headers"] = headers }
        }
        if let bodyExpr = spec["body"] {
            let body = JSE.eval(bodyExpr, store: store, item: item)
            if let body = body, !(body is NSNull) {
                req["body"] = body
            } else {
                for path in ApiGraphText.paths(bodyExpr) where !ApiGraphText.isAmbient(path) {
                    let name = ApiGraphText.scopeName(path)
                    if !name.isEmpty, !missing.contains(name) { missing.append(name) }
                    break
                }
            }
        }
        req["_missing"] = missing
        applyTransportControls(&req)
        // Capture the implicit credential identity once for this materialization.
        // Request observation must notice cookie login/logout transitions, while
        // cache lookup and response storage must agree on the same preflight identity
        // even when the response itself mutates Set-Cookie.
        req["_cachePartition"] = cachePartition(req)
        return req
    }

    /// `JSE.interpolate` with the /web/11 hole ledger: a `{{ … }}` that evaluates to
    /// null and reads at least one non-ambient path records its scope name.
    private func interpolateGated(_ template: String, missing: inout [String]) -> String {
        guard template.contains("{{") else { return template }
        var out = ""
        var rest = Substring(template)
        while let open = rest.range(of: "{{") {
            out += rest[..<open.lowerBound]
            guard let close = rest.range(of: "}}", range: open.upperBound..<rest.endIndex) else {
                out += rest[open.lowerBound...]
                return out
            }
            let hole = String(rest[open.upperBound..<close.lowerBound])
            let value = JSE.eval(hole, store: store, item: item)
            if Self.isNullish(value), !ApiGraphText.holeIsAmbient(hole) {
                let name = ApiGraphText.holeName(hole)
                if !missing.contains(name) { missing.append(name) }
            }
            out += JSE.string(value)
            rest = rest[close.upperBound...]
        }
        out += rest
        return out
    }

    /// networking.md N2 + doc 05's secrets story: the DECLARED transport controls.
    private func applyTransportControls(_ req: inout [String: Any]) {
        func flag(_ raw: String?) -> Bool? {
            guard let raw = raw?.trimmingCharacters(in: .whitespaces).lowercased() else { return nil }
            if raw.isEmpty || raw == "true" || raw == "1" { return true }
            if raw == "false" || raw == "0" { return false }
            return nil
        }
        if let stream = flag(spec["stream"]) { req["stream"] = stream }
        if let timeout = Double(spec["timeout"]?.trimmingCharacters(in: .whitespaces) ?? ""),
           timeout.isFinite, timeout > 0 {
            req["timeout"] = timeout
        }
        let redirect = (spec["redirect"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if redirect == "error" || redirect == "follow" { req["redirect"] = redirect }
        let encode = (spec["encode"] ?? "json").trimmingCharacters(in: .whitespaces).lowercased()
        if encode == "text" || encode == "form" || encode == "multipart" {
            req["encode"] = encode
            var headers = (req["headers"] as? [String: String]) ?? [:]
            if encode == "multipart" {
                req["parts"] = Self.multipartParts(req["body"])
            } else {
                req["wire"] = encode == "form"
                    ? Self.encodeFormBody(req["body"])
                    : JSE.string(req["body"])
                if headers["content-type"] == nil {
                    headers["content-type"] = encode == "form"
                        ? "application/x-www-form-urlencoded;charset=UTF-8"
                        : "text/plain;charset=UTF-8"
                }
            }
            req["headers"] = headers
        }
        if (spec["via"] ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "server" {
            // The CLIENT half calls the generated internal route; the SERVER half performs
            // the real request with server-held headers. No secret is ever in the bundle.
            let target = JSE.string(req["url"])
            req["via"] = "server"
            req["target"] = target
            req["url"] = ApiBlock.serverOrigin + "/dsx/api/" + (spec["as"] ?? "api")
                + "?u=" + Self.percentEncode(target)
        }
    }

    /// doc 05 `via="server"` / doc 13 "the embed knows its home origin": the absolute
    /// base the proxy route resolves against. "" = same origin; the host sets its
    /// configured web origin here.
    nonisolated(unsafe) static var serverOrigin: String = ""

    /// `encodeURIComponent` semantics, spelled out so all three runtimes put the same
    /// bytes on the wire (unreserved: A-Z a-z 0-9 - _ . ! ~ * ' ( )).
    static func percentEncode(_ value: String) -> String {
        let unreserved = Set("-_.!~*'()")
        var out = ""
        for byte in Array(value.utf8) {
            let scalar = Character(UnicodeScalar(byte))
            if (scalar >= "A" && scalar <= "Z") || (scalar >= "a" && scalar <= "z")
                || (scalar >= "0" && scalar <= "9") || unreserved.contains(scalar) {
                out.append(scalar)
            } else {
                let hex = "0123456789ABCDEF"
                let high = hex[hex.index(hex.startIndex, offsetBy: Int(byte >> 4))]
                let low = hex[hex.index(hex.startIndex, offsetBy: Int(byte & 0xF))]
                out.append("%")
                out.append(high)
                out.append(low)
            }
        }
        return out
    }

    /// networking.md N2 — the declared REQUEST encodings the kernel materializes.
    static func encodeFormBody(_ body: Any?) -> String {
        guard let dict = body as? [String: Any] else { return JSE.string(body) }
        return dict.keys.sorted()
            .map { percentEncode($0) + "=" + percentEncode(JSE.string(dict[$0])) }
            .joined(separator: "&")
    }

    /// multipart/form-data parts, SORTED BY FIELD NAME so the corpus is
    /// order-deterministic on runtimes whose native dictionaries are unordered.
    static func multipartParts(_ body: Any?) -> [[String: Any]] {
        guard let dict = body as? [String: Any] else { return [] }
        var out: [[String: Any]] = []
        for key in dict.keys.sorted() {
            let value = dict[key]
            if let shape = value as? [String: Any], let blob = shape["__blob"] as? String {
                var part: [String: Any] = ["name": key, "blob": blob]
                if let filename = shape["name"] as? String { part["filename"] = filename }
                if let contentType = shape["type"] as? String { part["contentType"] = contentType }
                out.append(part)
            } else {
                out.append(["name": key, "value": JSE.string(value)])
            }
        }
        return out
    }

    private func requestKey(_ req: [String: Any]) -> String {
        let parts: [Any?] = [
            req["url"], req["method"], req["headers"], req["body"], req["expect"],
            req["auto"], req["_cachePartition"],
            // /web/11: the GATE is part of the tracked identity, so an upstream that
            // resolves (or fails) is a request change exactly like a url change.
            gateOf(req).map { "\($0["name"] ?? ""):\($0["reason"] ?? "")" }.joined(separator: ","),
        ]
        return JSE.watchKey(parts)
    }

    /// /web/11's four gate rules, in a deterministic order: `needs=` and expression edges
    /// first (an upstream that has not resolved, or one carrying an error), then the
    /// value-presence holes the materialization already recorded.
    private func gateOf(_ req: [String: Any]) -> [[String: Any]] {
        guard JSE.truthy(req["auto"]) else { return [] }
        var out: [[String: Any]] = []
        var seen = Set<String>()
        func add(_ name: String, _ reason: String) {
            guard !name.isEmpty, seen.insert(name).inserted else { return }
            out.append(["name": name, "reason": reason])
        }
        for name in graph?.upstreamsOf(asName) ?? [] {
            if !Self.isNullish(JSE.eval("\(name).error", store: store, item: nil)) {
                add(name, "upstream-error")
                continue
            }
            if Self.isNullish(JSE.eval("\(name).fetchedAt", store: store, item: nil)) {
                add(name, "unresolved")
            }
        }
        for name in (req["_missing"] as? [String]) ?? [] { add(name, "missing-value") }
        return out
    }

    /// `<as>.status` / `<as>.blockedBy` (/web/11). `loading` stays TRUE while waiting,
    /// because from the user's seat a gated block IS loading.
    private func publishGate(_ blocked: [[String: Any]]) {
        guard isAsNameValid else { return }
        DsxPaths.set(store, "\(asName).blockedBy", blocked)
        if !blocked.isEmpty {
            DsxPaths.set(store, "\(asName).status", "waiting")
            DsxPaths.set(store, "\(asName).loading", true)
            DsxPaths.set(store, "\(asName).refreshing", false)
        } else if JSE.string(DsxPaths.get(store, "\(asName).status")) == "waiting" {
            DsxPaths.set(store, "\(asName).status", "ready")
            DsxPaths.set(store, "\(asName).loading", false)
        }
    }

    /// /web/11: a cycle, or a `needs=` naming a block that is not in this scope. A silent
    /// forever-wait is the worse failure mode, so the block declares it and never fires.
    private func publishDeclaredError(_ message: String) {
        let error: [String: Any] = ["status": -3.0, "message": message, "body": NSNull()]
        DsxPaths.set(store, "\(asName).loading", false)
        DsxPaths.set(store, "\(asName).refreshing", false)
        DsxPaths.set(store, "\(asName).status", "error")
        DsxPaths.set(store, "\(asName).blockedBy", [Any]())
        DsxPaths.set(store, "\(asName).error", error)
        onEvent("error", ["error": error])
    }

    /// networking.md N2 "Progress": each entry publishes `<as>.progress` and fires
    /// `on:progress` BEFORE the terminal settle.
    private func publishProgress(_ entries: Any?) {
        guard let list = entries as? [Any] else { return }
        for raw in list {
            guard let entry = raw as? [String: Any] else { continue }
            let loaded = JSE.number(entry["loaded"]) ?? 0
            let total = JSE.number(entry["total"]) ?? 0
            let progress: [String: Any] = [
                "direction": JSE.string(entry["direction"] ?? "down"),
                "loaded": loaded,
                "total": total,
                "fraction": total > 0 ? loaded / total : 0,
            ]
            DsxPaths.set(store, "\(asName).progress", progress)
            onEvent("progress", ["progress": progress])
        }
    }

    private func cacheKey(_ req: [String: Any]) -> String {
        [
            JSE.string(req["method"]),
            JSE.string(req["url"]),
            JSE.string(req["expect"]).lowercased(),
            JSE.watchKey(req["headers"]),
            JSE.watchKey(req["body"]),
            JSE.string(req["_cachePartition"]),
        ].joined(separator: "\u{1}")
    }

    /// HTTP field names are case-insensitive. Canonicalizing before both transport
    /// and keying prevents `Authorization`/`authorization` from becoming different
    /// cache identities (or nondeterministically overwriting each other).
    private static func normalizedHeaders(_ value: Any?) -> [String: String] {
        guard let raw = value as? [String: Any] else { return [:] }
        var normalized: [String: String] = [:]
        for key in raw.keys.sorted() {
            let field = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !field.isEmpty else { continue }
            normalized[field] = JSE.string(raw[key])
        }
        return normalized
    }

    private func mountFire() {
        if let declaredError = declaredError { publishDeclaredError(declaredError); return }
        let req = materialize()
        lastRequestKey = requestKey(req)
        let blocked = gateOf(req)
        publishGate(blocked)
        guard blocked.isEmpty else { return }
        if JSE.truthy(req["auto"]) {
            everFired = true
            _ = fire(req, allowCache: true, refreshing: false, forceNetwork: false)
        }
    }

    /// The host calls this per store publish (the watch machinery). Re-materializes and
    /// refires ONLY when the materialized request changed — the cross-platform law.
    func storeChanged() {
        if disposed || !isAsNameValid || declaredError != nil { return }
        let req = materialize()
        let key = requestKey(req)
        if key == lastRequestKey { return }
        lastRequestKey = key
        // /web/11: a gated block publishes its gate and never fires. It fires the moment
        // ITS inputs are whole — no wave barrier, no ceremony.
        let blocked = gateOf(req)
        publishGate(blocked)
        guard blocked.isEmpty else { return }
        if JSE.truthy(req["auto"]) {
            everFired = true
            debounceWork?.cancel()
            let delay = max(0, Double(spec["debounce"] ?? "") ?? 0)
            guard delay > 0 else {
                _ = fire(req, allowCache: true, refreshing: false, forceNetwork: false)
                return
            }
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.disposed else { return }
                self.debounceWork = nil
                _ = self.fire(req, allowCache: true, refreshing: false, forceNetwork: false)
            }
            debounceWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay / 1000, execute: work)
        }
    }

    // ── firing ─────────────────────────────────────────────────────────────────────────

    /// A fresh cache hit is a winning request result, not a passive read. It must
    /// supersede any older network request just like a newer transport would;
    /// otherwise late A can overwrite cached B after navigation/auth changes.
    private func adoptCacheOnlyWin() {
        let orphaned = pendingCompletion
        pendingCompletion = nil
        activeCancel?()
        activeCancel = nil
        generation += 1
        streamChunks = nil
        DsxPaths.set(store, "\(asName).loading", false)
        DsxPaths.set(store, "\(asName).refreshing", false)
        orphaned?(nil)
    }

    private func serveCached(_ data: Any?, at: Double) {
        DsxPaths.set(store, "\(asName).loading", false)
        DsxPaths.set(store, "\(asName).refreshing", false)
        DsxPaths.set(store, "\(asName).data", data)
        DsxPaths.set(store, "\(asName).error", nil)
        DsxPaths.set(store, "\(asName).fetchedAt", at)
        DsxPaths.set(store, "\(asName).status", "ready")
        onEvent("success", ["data": data ?? NSNull(), "status": 200.0, "cached": true])
        graph?.notifySettled(asName)
    }

    @discardableResult
    private func fire(
        _ req: [String: Any],
        allowCache: Bool,
        refreshing: Bool,
        forceNetwork: Bool,
        completion: ((FetchResult?) -> Void)? = nil
    ) -> FetchResult? {
        guard isAsNameValid, !disposed else {
            completion?(nil)
            return nil
        }
        if allowCache && !forceNetwork {
            switch policy {
            case .noStore:
                break
            case .maxAge(let age):
                if let entry = cache.get(cacheKey(req)), now() - entry.at < age {
                    adoptCacheOnlyWin()
                    serveCached(entry.data, at: entry.at)
                    let cached: FetchResult = ["ok": true, "status": 200.0, "data": entry.data ?? NSNull(), "cached": true]
                    completion?(cached)
                    return cached
                }
            case .swr(let fresh, let stale):
                if let entry = cache.get(cacheKey(req)) {
                    let entryAge = now() - entry.at
                    if entryAge < fresh {
                        adoptCacheOnlyWin()
                        serveCached(entry.data, at: entry.at)
                        let cached: FetchResult = ["ok": true, "status": 200.0, "data": entry.data ?? NSNull(), "cached": true]
                        completion?(cached)
                        return cached
                    }
                    if entryAge < fresh + stale {
                        serveCached(entry.data, at: entry.at)          // serve stale NOW …
                        return network(req, refreshing: true, completion: completion) // … revalidate behind it
                    }
                }
            }
        }
        return network(req, refreshing: refreshing, completion: completion)
    }

    private func network(
        _ req: FetchRequest,
        refreshing: Bool,
        completion: ((FetchResult?) -> Void)?
    ) -> FetchResult? {
        if asyncFetchSeam != nil {
            networkAsync(req, refreshing: refreshing, completion: completion)
            return nil
        }

        generation += 1
        let gen = generation
        let responseCacheKey = cacheKey(req)
        DsxPaths.set(store, "\(asName).\(refreshing ? "refreshing" : "loading")", true)
        DsxPaths.set(store, "\(asName).status", refreshing ? "refreshing" : "loading")
        let retries = max(0, Int(spec["retry"] ?? "") ?? 0)
        var res: FetchResult = ["ok": false, "status": 0.0, "data": NSNull()]
        var attempt = 0
        while attempt <= retries {
            guard let fetchSeam else { break }
            res = fetchSeam(JSE.string(req["url"]), req)
            if JSE.truthy(res["aborted"]) {
                completion?(nil)
                return nil
            } // superseded — the newer request owns the store
            let status = JSE.number(res["status"]) ?? 0
            if JSE.truthy(res["ok"]) || status != 0 { break } // only network errors retry
            attempt += 1
        }
        guard gen == generation else {
            completion?(nil)
            return nil
        } // superseded (cancel/newer request)
        apply(res, request: req, responseCacheKey: responseCacheKey)
        completion?(res)
        return res
    }

    /// The non-blocking shipping path. A newer request aborts and settles the old
    /// one before claiming the generation, matching AbortController on web.
    private func networkAsync(
        _ req: FetchRequest,
        refreshing: Bool,
        completion: ((FetchResult?) -> Void)?
    ) {
        let orphaned = pendingCompletion
        pendingCompletion = nil
        activeCancel?()
        activeCancel = nil
        orphaned?(nil)

        generation += 1
        let gen = generation
        let responseCacheKey = cacheKey(req)
        streamChunks = nil
        pendingCompletion = completion
        DsxPaths.set(store, "\(asName).\(refreshing ? "refreshing" : "loading")", true)
        DsxPaths.set(store, "\(asName).status", refreshing ? "refreshing" : "loading")
        let retries = max(0, Int(spec["retry"] ?? "") ?? 0)
        networkAsyncAttempt(
            req,
            responseCacheKey: responseCacheKey,
            generation: gen,
            attempt: 0,
            retries: retries
        )
    }

    private func networkAsyncAttempt(
        _ req: FetchRequest,
        responseCacheKey: String,
        generation gen: Int,
        attempt: Int,
        retries: Int
    ) {
        guard !disposed, gen == generation, let asyncFetchSeam else { return }
        let delivery = ResponseGate()
        activeCancel = asyncFetchSeam(JSE.string(req["url"]), req) { [weak self] res in
            // A transport completion can arrive on a URLSession delegate queue. The
            // store is SwiftUI state, so state, events and action continuations all
            // re-enter on main.
            let partial = JSE.truthy(res["partial"])
            guard delivery.claim(partial: partial) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                guard !self.disposed, gen == self.generation else { return }
                if partial {
                    self.applyStreamMessage(res["message"] ?? res["data"], request: req)
                    return
                }
                self.activeCancel = nil
                if JSE.truthy(res["aborted"]) {
                    let done = self.pendingCompletion
                    self.pendingCompletion = nil
                    done?(nil)
                    return
                }
                let status = JSE.number(res["status"]) ?? 0
                if !JSE.truthy(res["ok"]), status == 0, attempt < retries {
                    self.networkAsyncAttempt(
                        req,
                        responseCacheKey: responseCacheKey,
                        generation: gen,
                        attempt: attempt + 1,
                        retries: retries
                    )
                    return
                }
                self.apply(res, request: req, responseCacheKey: responseCacheKey)
                let done = self.pendingCompletion
                self.pendingCompletion = nil
                done?(res)
            }
        }
    }

    /// Apply one terminal response. Shared by the deterministic sync corpus and
    /// the non-blocking shipping transport so their state/event law cannot drift.
    private func apply(
        _ res: FetchResult,
        request req: FetchRequest,
        responseCacheKey: String
    ) {
        // networking.md N2: progress entries publish + fire BEFORE the terminal settle
        publishProgress(res["progress"])
        let ok = JSE.truthy(res["ok"])
        if ok, JSE.truthy(res["streamed"]) {
            let chunks = (res["data"] as? [Any]) ?? streamChunks ?? []
            streamChunks = nil
            DsxPaths.set(store, "\(asName).data", chunks)
            DsxPaths.set(store, "\(asName).loading", false)
            DsxPaths.set(store, "\(asName).refreshing", false)
            DsxPaths.set(store, "\(asName).error", nil)
            DsxPaths.set(store, "\(asName).fetchedAt", now())
            DsxPaths.set(store, "\(asName).status", "ready")
            cacheSuccessfulResponse(chunks, request: req, responseCacheKey: responseCacheKey)
            onEvent("success", ["data": chunks, "status": JSE.number(res["status"]) ?? 200.0])
            graph?.notifySettled(asName)
            return
        }
        if ok, let stream = res["stream"] as? [Any] {
            var chunks: [Any] = []
            for chunk in stream {
                chunks.append(chunk)
                DsxPaths.set(store, "\(asName).data", chunks)
                onEvent("message", ["data": chunk])
            }
            DsxPaths.set(store, "\(asName).loading", false)
            DsxPaths.set(store, "\(asName).refreshing", false)
            DsxPaths.set(store, "\(asName).error", nil)
            DsxPaths.set(store, "\(asName).fetchedAt", now())
            DsxPaths.set(store, "\(asName).status", "ready")
            cacheSuccessfulResponse(chunks, request: req, responseCacheKey: responseCacheKey)
            onEvent("success", ["data": chunks, "status": JSE.number(res["status"]) ?? 200.0])
            graph?.notifySettled(asName)
            return
        }
        streamChunks = nil
        DsxPaths.set(store, "\(asName).loading", false)
        DsxPaths.set(store, "\(asName).refreshing", false)
        DsxPaths.set(store, "\(asName).fetchedAt", now())
        DsxPaths.set(store, "\(asName).status", ok ? "ready" : "error")
        if ok {
            DsxPaths.set(store, "\(asName).data", res["data"])
            DsxPaths.set(store, "\(asName).error", nil)
            cacheSuccessfulResponse(res["data"], request: req, responseCacheKey: responseCacheKey)
            onEvent("success", ["data": res["data"] ?? NSNull(), "status": JSE.number(res["status"]) ?? 200.0])
        } else {
            var message = "http " + JSE.string(res["status"])
            if let err = res["error"] { message = JSE.string(err) }
            let error: [String: Any] = [
                "status": JSE.number(res["status"]) ?? 0.0,
                "message": message,
                "body": res["data"] ?? NSNull(),
            ]
            DsxPaths.set(store, "\(asName).error", error)
            onEvent("error", ["error": error])
        }
        // /web/11: this block settled — its dependents fire the moment THEIR inputs are whole.
        graph?.notifySettled(asName)
    }

    private func applyStreamMessage(_ value: Any?, request: FetchRequest) {
        var chunks = streamChunks ?? []
        let message = value ?? NSNull()
        chunks.append(message)
        streamChunks = chunks
        DsxPaths.set(store, "\(asName).data", chunks)
        // A persistent SSE connection may never reach EOF. The first event is a
        // resolved stream value, so it leaves the initial loading posture now.
        DsxPaths.set(store, "\(asName).loading", false)
        DsxPaths.set(store, "\(asName).refreshing", false)
        DsxPaths.set(store, "\(asName).error", nil)
        DsxPaths.set(store, "\(asName).fetchedAt", now())
        let method = JSE.string(request["method"]).uppercased()
        if method != "GET" && method != "HEAD" { cache.clear() }
        onEvent("message", ["data": message])
    }

    /// `no-store` responses must never seed an entry that a cache-enabled block
    /// can consume later. Successful non-GET mutations invalidate the surface
    /// cache and never seed it. `responseCacheKey` was captured before transport
    /// start, so a Set-Cookie/auth transition cannot file an old response under
    /// the new identity.
    private func cacheSuccessfulResponse(
        _ data: Any?,
        request: FetchRequest,
        responseCacheKey: String
    ) {
        let method = JSE.string(request["method"]).uppercased()
        guard method == "GET" || method == "HEAD" else {
            cache.clear()
            return
        }
        switch policy {
        case .noStore:
            return
        case .maxAge, .swr:
            cache.put(responseCacheKey, Entry(data: data, at: now()))
        }
    }

    // ── the handle (refresh / send / cancel — callable from the action runner) ────────

    /// revalidate now — bypasses freshness, rewrites the cache; data stays until resolve
    func refresh(completion: ((FetchResult?) -> Void)? = nil) {
        _ = fire(
            materialize(),
            allowCache: false,
            refreshing: true,
            forceNetwork: true,
            completion: completion
        )
    }

    /// fire with a body override; mutations always hit the network
    /// /web/11: a manual send IGNORES gating but not HOLES — sending with a hole in the
    /// inputs returns an `incomplete-input` envelope instead of a malformed request.
    @discardableResult
    func send(
        _ args: [String: Any]? = nil,
        completion: ((FetchResult?) -> Void)? = nil
    ) -> FetchResult? {
        var req = materialize()
        if let args = args { req["body"] = args }
        let missing = (req["_missing"] as? [String]) ?? []
        if !missing.isEmpty {
            let envelope: FetchResult = [
                "ok": false, "status": -3.0, "data": NSNull(),
                "error": ["kind": "incomplete-input", "missing": missing] as [String: Any],
            ]
            completion?(envelope)
            return envelope
        }
        return fire(
            req,
            allowCache: false,
            refreshing: false,
            forceNetwork: true,
            completion: completion
        )
    }

    func cancel() {
        debounceWork?.cancel()
        debounceWork = nil
        let orphaned = pendingCompletion
        pendingCompletion = nil
        activeCancel?()
        activeCancel = nil
        generation += 1 // orphan anything in flight (host-side async wrapper honors it)
        streamChunks = nil
        if isAsNameValid {
            DsxPaths.set(store, "\(asName).loading", false)
            DsxPaths.set(store, "\(asName).refreshing", false)
            if JSE.string(DsxPaths.get(store, "\(asName).status")) != "error" {
                DsxPaths.set(store, "\(asName).status", "ready")
            }
        }
        orphaned?(nil)
    }

    func dispose() {
        cancel()
        disposed = true
        graph?.detach(asName)
    }

    // MARK: - URLSession shipping transport

    private static let maxRequestBytes = 4 * 1024 * 1024
    private static let maxResponseBytes = 16 * 1024 * 1024
    private static let maxJSONDepth = 64
    private static let maxJSONNodes = 100_000
    private static let requestPreparationQueue = DispatchQueue(
        label: "dev.despia.api.request-preparation",
        qos: .utility,
        attributes: .concurrent
    )

    /// Cancellation must remain effective while a large request body is still
    /// being validated/encoded and before URLSession has produced a task.
    private final class PendingTransport: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false
        private var task: URLSessionTask?

        var isCancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelled
        }

        func install(_ task: URLSessionTask) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelled else { return false }
            self.task = task
            return true
        }

        func cancel() {
            lock.lock()
            if cancelled {
                lock.unlock()
                return
            }
            cancelled = true
            let task = self.task
            lock.unlock()
            task?.cancel()
        }
    }

    /// Preflight JSON without recursive Swift calls. Besides bounding depth and
    /// node count, estimate encoded bytes before asking JSONSerialization to
    /// allocate its output so one huge leaf string cannot create an oversized
    /// temporary buffer on a developer's main thread.
    static func jsonBodyFitsLimits(_ root: Any) -> Bool {
        var stack: [(value: Any, depth: Int)] = [(root, 0)]
        var nodes = 0
        var estimatedBytes = 0

        func addBytes(_ count: Int) -> Bool {
            guard count >= 0, count <= maxRequestBytes - estimatedBytes else { return false }
            estimatedBytes += count
            return true
        }

        func addJSONString(_ string: String) -> Bool {
            guard addBytes(2) else { return false } // surrounding quotes
            // UTF-8 length is a lower bound for the encoded JSON string. Reject
            // bodies that cannot possibly fit before walking individual bytes for
            // quote/control-character expansion. This keeps an oversized plain
            // string from turning local rejection into a multi-second cold-start
            // CPU scan in an unoptimized simulator build.
            let rawBytes = string.lengthOfBytes(using: .utf8)
            guard addBytes(rawBytes) else { return false }
            for byte in string.utf8 {
                let expansion: Int
                switch byte {
                case 0x22, 0x5C:
                    expansion = 1 // raw byte already counted; JSON needs two
                case 0x00...0x1F:
                    expansion = 5 // raw byte already counted; `\u00XX` needs six
                default:
                    expansion = 0
                }
                guard expansion == 0 || addBytes(expansion) else { return false }
            }
            return true
        }

        func canAppend(_ childCount: Int) -> Bool {
            childCount >= 0 && childCount <= maxJSONNodes - nodes - stack.count
        }

        while let next = stack.popLast() {
            nodes += 1
            guard nodes <= maxJSONNodes, next.depth <= maxJSONDepth else { return false }

            if let dictionary = next.value as? [String: Any] {
                guard canAppend(dictionary.count),
                      addBytes(2 + (dictionary.count * 2)) else { return false }
                if next.depth == maxJSONDepth, !dictionary.isEmpty { return false }
                for (key, value) in dictionary {
                    guard addJSONString(key) else { return false }
                    stack.append((value, next.depth + 1))
                }
            } else if let array = next.value as? [Any] {
                guard canAppend(array.count),
                      addBytes(2 + array.count) else { return false }
                if next.depth == maxJSONDepth, !array.isEmpty { return false }
                for value in array {
                    stack.append((value, next.depth + 1))
                }
            } else if let dictionary = next.value as? NSDictionary {
                guard canAppend(dictionary.count),
                      addBytes(2 + (dictionary.count * 2)) else { return false }
                if next.depth == maxJSONDepth, dictionary.count > 0 { return false }
                for (rawKey, value) in dictionary {
                    if let key = rawKey as? String, !addJSONString(key) { return false }
                    stack.append((value, next.depth + 1))
                }
            } else if let array = next.value as? NSArray {
                guard canAppend(array.count),
                      addBytes(2 + array.count) else { return false }
                if next.depth == maxJSONDepth, array.count > 0 { return false }
                for value in array {
                    stack.append((value, next.depth + 1))
                }
            } else if let string = next.value as? String {
                guard addJSONString(string) else { return false }
            } else if next.value is NSNull {
                guard addBytes(4) else { return false }
            } else {
                // Booleans and all Foundation/Swift numeric representations fit
                // comfortably inside this conservative per-scalar allowance.
                guard addBytes(32) else { return false }
            }
        }
        return true
    }

    private static func prepareRequestBody(
        _ body: Any?
    ) -> (data: Data?, setJSONContentType: Bool, error: String?) {
        guard let body, !(body is NSNull) else { return (nil, false, nil) }
        if let data = body as? Data {
            guard data.count <= maxRequestBytes else {
                return (nil, false, "request_too_large")
            }
            return (data, false, nil)
        }
        if let string = body as? String {
            guard string.lengthOfBytes(using: .utf8) <= maxRequestBytes else {
                return (nil, false, "request_too_large")
            }
            return (Data(string.utf8), false, nil)
        }
        guard jsonBodyFitsLimits(body) else {
            return (nil, false, "request_too_large")
        }
        do {
            let data = try JSONSerialization.data(
                withJSONObject: body,
                options: [.fragmentsAllowed]
            )
            guard data.count <= maxRequestBytes else {
                return (nil, false, "request_too_large")
            }
            return (data, true, nil)
        } catch {
            return (nil, false, "invalid_request_body")
        }
    }

    /// Per-task URLSession delegate. Completion-handler data tasks cannot surface
    /// bytes until EOF, which makes a persistent SSE connection permanently
    /// silent. This delegate emits `{partial,message}` envelopes as complete SSE
    /// events arrive, then one terminal envelope when the stream eventually ends.
    private final class StreamingSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        private let expected: String
        private let deliver: (FetchResult) -> Void
        private var response: HTTPURLResponse?
        private var body = Data()
        private var sseBytes: [UInt8] = []
        private var chunks: [Any] = []
        private var receivedBytes = 0
        private var streaming = false
        private var firstEvent = true
        private var finished = false
        var owningSession: URLSession?

        init(expected: String, deliver: @escaping (FetchResult) -> Void) {
            self.expected = expected.lowercased()
            self.deliver = deliver
        }

        func urlSession(
            _ session: URLSession,
            dataTask: URLSessionDataTask,
            didReceive response: URLResponse,
            completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
        ) {
            guard let http = response as? HTTPURLResponse else {
                completionHandler(.cancel)
                finish([
                    "ok": false, "status": 0.0,
                    "data": NSNull(), "error": "no_response",
                ])
                return
            }
            self.response = http
            let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
            streaming = contentType.contains("text/event-stream")
                && (200..<300).contains(http.statusCode)
            if response.expectedContentLength > Int64(ApiBlock.maxResponseBytes) {
                completionHandler(.cancel)
                finish(responseFailure("response_too_large"))
                return
            }
            completionHandler(.allow)
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            guard ApiBlock.allowsRedirect(from: response.url, to: request.url) else {
                // Never follow a secure request onto plaintext transport. Returning
                // nil rejects the redirect; finishing here also gives ApiBlock one
                // deterministic, non-retryable terminal envelope instead of exposing
                // Foundation's redirect response as an application success.
                completionHandler(nil)
                finish(responseFailure("insecure_redirect"))
                return
            }
            completionHandler(request)
        }

        func urlSession(
            _ session: URLSession,
            dataTask: URLSessionDataTask,
            didReceive data: Data
        ) {
            guard !finished else { return }
            receivedBytes += data.count
            guard receivedBytes <= ApiBlock.maxResponseBytes else {
                dataTask.cancel()
                finish(responseFailure("response_too_large"))
                return
            }
            if streaming {
                sseBytes.append(contentsOf: data)
                drainSSE(flush: false)
            } else {
                body.append(data)
            }
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            didCompleteWithError error: Error?
        ) {
            guard !finished else { return }
            if let urlError = error as? URLError, urlError.code == .cancelled {
                finish(["ok": false, "status": -1.0, "aborted": true, "data": NSNull()])
                return
            }
            guard error == nil else {
                finish([
                    "ok": false, "status": 0.0,
                    "data": NSNull(), "error": "network",
                ])
                return
            }
            guard let response else {
                finish([
                    "ok": false, "status": 0.0,
                    "data": NSNull(), "error": "no_response",
                ])
                return
            }

            let ok = (200..<300).contains(response.statusCode)
            let headers = responseHeaders(response)
            if streaming {
                drainSSE(flush: true)
                finish([
                    "ok": ok,
                    "status": Double(response.statusCode),
                    "data": chunks,
                    "headers": headers,
                    "streamed": ok,
                ])
                return
            }

            let contentType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
            let decoded: Any
            if expected == "blob" {
                decoded = [
                    "__blob": body.base64EncodedString(),
                    "type": contentType.split(separator: ";", maxSplits: 1).first
                        .map { String($0).trimmingCharacters(in: .whitespaces) } ?? "",
                    "size": Double(body.count),
                ] as [String: Any]
            } else if expected == "text" {
                decoded = String(decoding: body, as: UTF8.self)
            } else if contentType.contains("json") {
                if body.isEmpty {
                    decoded = NSNull()
                } else {
                    do {
                        decoded = try JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])
                    } catch {
                        finish(responseFailure("invalid_response"))
                        return
                    }
                }
            } else {
                decoded = String(decoding: body, as: UTF8.self)
            }
            finish([
                "ok": ok,
                "status": Double(response.statusCode),
                "data": decoded,
                "headers": headers,
            ])
        }

        private func finish(_ result: FetchResult) {
            guard !finished else { return }
            finished = true
            deliver(result)
            let session = owningSession
            owningSession = nil
            session?.finishTasksAndInvalidate()
        }

        private func responseFailure(_ code: String) -> FetchResult {
            [
                "ok": false,
                // Decode/size failures are terminal response errors, not transport
                // failures; -2 prevents retry amplification.
                "status": -2.0,
                "data": NSNull(),
                "error": code,
            ]
        }

        private func responseHeaders(_ response: HTTPURLResponse) -> [String: String] {
            var headers: [String: String] = [:]
            for (rawKey, rawValue) in response.allHeaderFields {
                headers[JSE.string(rawKey).lowercased()] = JSE.string(rawValue)
            }
            return headers
        }

        /// Find two consecutive SSE line endings. Handles LF, CRLF and CR, plus
        /// mixed pairs, while retaining incomplete UTF-8 bytes across callbacks.
        private func eventBoundary() -> (frameEnd: Int, consumed: Int)? {
            func lineEndingLength(at index: Int) -> Int? {
                guard index < sseBytes.count else { return nil }
                if sseBytes[index] == 0x0A { return 1 }
                if sseBytes[index] == 0x0D {
                    return index + 1 < sseBytes.count && sseBytes[index + 1] == 0x0A ? 2 : 1
                }
                return nil
            }
            var index = 0
            while index < sseBytes.count {
                guard let first = lineEndingLength(at: index) else {
                    index += 1
                    continue
                }
                let next = index + first
                if let second = lineEndingLength(at: next) {
                    return (index, next + second)
                }
                index = next
            }
            return nil
        }

        private func drainSSE(flush: Bool) {
            while let boundary = eventBoundary() {
                let frame = Array(sseBytes[..<boundary.frameEnd])
                sseBytes.removeFirst(boundary.consumed)
                emitSSEFrame(frame)
            }
            if flush, !sseBytes.isEmpty {
                let frame = sseBytes
                sseBytes.removeAll(keepingCapacity: true)
                emitSSEFrame(frame)
            }
        }

        private func emitSSEFrame(_ bytes: [UInt8]) {
            var text = String(decoding: bytes, as: UTF8.self)
            if firstEvent {
                firstEvent = false
                if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
            }
            text = text.replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\r", with: "\n")
            var dataLines: [String] = []
            for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
                if line.hasPrefix(":") { continue }
                guard let colon = line.firstIndex(of: ":") else {
                    if line == "data" { dataLines.append("") }
                    continue
                }
                guard line[..<colon] == "data" else { continue }
                var value = String(line[line.index(after: colon)...])
                if value.hasPrefix(" ") { value.removeFirst() }
                dataLines.append(value)
            }
            guard !dataLines.isEmpty else { return }
            let payload = dataLines.joined(separator: "\n")
            let decoded: Any
            if let bytes = payload.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) {
                decoded = json
            } else {
                decoded = payload
            }
            chunks.append(decoded)
            deliver(["partial": true, "message": decoded])
        }
    }

    /// Foundation-only live transport. Relative URLs resolve against `baseURL`
    /// (the Stack host supplies AppManifest's resolved web origin), non-string
    /// bodies JSON-encode like browser fetch, cookies use the shared native jar,
    /// blob responses use the cross-platform base64 envelope, SSE is delivered
    /// incrementally before EOF, and cancellation is a real URLSessionTask.cancel.
    /// Request-body validation/encoding runs on a utility queue, is capped at 4 MiB,
    /// and has finite JSON depth/node budgets.
    static func urlSessionTransport(
        baseURL: URL?,
        session: URLSession = .shared
    ) -> AsyncFetch {
        return { rawURL, request, completion in
            let parsed = URL(string: rawURL, relativeTo: baseURL)?.absoluteURL
            guard let url = parsed,
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else {
                DispatchQueue.main.async {
                    completion([
                        "ok": false,
                        "status": -2.0,
                        "data": NSNull(),
                        "error": "invalid_url",
                    ])
                }
                return nil
            }

            let pending = PendingTransport()
            requestPreparationQueue.async {
                guard !pending.isCancelled else { return }

                var urlRequest = URLRequest(url: url)
                urlRequest.httpMethod = (request["method"] as? String ?? "GET").uppercased()
                if let headers = request["headers"] as? [String: Any] {
                    for (key, value) in headers {
                        urlRequest.setValue(JSE.string(value), forHTTPHeaderField: key)
                    }
                }

                let prepared = prepareRequestBody(request["body"])
                if let error = prepared.error {
                    guard !pending.isCancelled else { return }
                    completion([
                        "ok": false,
                        // Request construction failures are terminal and must never
                        // consume retry budget or amplify local memory pressure.
                        "status": -2.0,
                        "data": NSNull(),
                        "error": error,
                    ])
                    return
                }
                if let data = prepared.data {
                    urlRequest.httpBody = data
                    if prepared.setJSONContentType,
                       urlRequest.value(forHTTPHeaderField: "Content-Type") == nil {
                        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    }
                }

                guard !pending.isCancelled else { return }
                let delegate = StreamingSessionDelegate(
                    expected: JSE.string(request["expect"] ?? "json"),
                    deliver: completion
                )
                let queue = OperationQueue()
                queue.maxConcurrentOperationCount = 1
                queue.qualityOfService = .utility
                let taskSession = URLSession(
                    configuration: session.configuration,
                    delegate: delegate,
                    delegateQueue: queue
                )
                delegate.owningSession = taskSession
                let task = taskSession.dataTask(with: urlRequest)
                guard pending.install(task) else {
                    delegate.owningSession = nil
                    taskSession.invalidateAndCancel()
                    return
                }
                task.resume()
            }
            return { pending.cancel() }
        }
    }

    /// Redirects stay within the URL schemes accepted by the transport, and a
    /// request that is already protected by TLS may never be downgraded. Kept
    /// internal so the deterministic conformance host can verify the exact policy
    /// without making a real network request.
    static func allowsRedirect(from sourceURL: URL?, to destinationURL: URL?) -> Bool {
        guard let sourceScheme = sourceURL?.scheme?.lowercased(),
              let destinationScheme = destinationURL?.scheme?.lowercased(),
              (sourceScheme == "http" || sourceScheme == "https"),
              (destinationScheme == "http" || destinationScheme == "https") else {
            return false
        }
        return sourceScheme != "https" || destinationScheme == "https"
    }

    /// Cache identity for implicit native cookies, including HttpOnly cookies.
    /// StackSurface combines this with a per-surface Cache, so both explicit auth
    /// headers and cookie-jar changes partition otherwise identical requests.
    static func cookieCachePartition(
        baseURL: URL?,
        storage: HTTPCookieStorage = .shared
    ) -> (FetchRequest) -> String {
        return { request in
            let rawURL = JSE.string(request["url"])
            guard let url = URL(string: rawURL, relativeTo: baseURL)?.absoluteURL else {
                return "invalid-url"
            }
            let cookies = (storage.cookies(for: url) ?? []).sorted {
                ($0.domain, $0.path, $0.name, $0.value)
                    < ($1.domain, $1.path, $1.name, $1.value)
            }
            let identity: [[String: Any]] = cookies.map {
                [
                    "domain": $0.domain.lowercased(),
                    "path": $0.path,
                    "name": $0.name,
                    "value": $0.value,
                    "secure": $0.isSecure,
                    "httpOnly": $0.isHTTPOnly,
                ]
            }
            return JSE.watchKey(identity)
        }
    }
}
