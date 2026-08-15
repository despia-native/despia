//
//  Host.swift - everything ABOVE the engine seam, in Swift.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The Swift twin of bindings/ts/src/host.ts and Host.kt. The engine streams
//  typed blocks and knows nothing else; policy lives here - the catalog, fit, the
//  router, the tool registry, the agentic loop, approvals, the transcript,
//  delivery and typed absence. That split is what makes swapping engines cheap,
//  and it is why this file exists three times rather than once inside the engine.
//
//  Like the Kotlin twin, it drives the REAL C++ MockEngine over the real C ABI.
//  Where the TypeScript host runs its own synchronous mock, this one blocks on
//  the native worker per turn, which is what a real consumer does. The two native
//  hosts therefore share one shape, and where this file departs from Host.kt the
//  departure is spelled out in a comment beside it.
//
//  The four normative contracts it implements are stated in
//  OpenSource/Conformance/ai/README.md: action-to-request, event normalization,
//  fit (Fit.swift) and routing (Router.swift). The corpus is what says the three
//  implementations agreed.
//

import Foundation

/// The catalog fields this build understands. Anything else is carried untouched
/// and reported once as an ignored-unknown notice: must-ignore with a receipt, so
/// a developer sees what a newer catalog brought.
private let knownEntryFields: Set<String> = [
    "schema_version", "id", "name", "family", "category", "engine", "format", "status", "requires",
    "files", "license", "languages", "inputs", "outputs", "context_length", "context_length_max",
    "parameters", "thinking", "tool_dialect", "template", "sampling", "requirements", "perf_priors",
    "mock", "origin",
]

/// Verdicts that mean "do not spend the bytes". A download is the most expensive
/// thing a user can be asked to wait for, so these are refused BEFORE the
/// transfer rather than discovered at load time.
private let refusesDownload: [String: String] = [
    "too_big": "model_too_big",
    "unsupported": "unsupported",
    "quarantined": "model_quarantined",
]

private let knownBlocks: Set<String> = [
    "text", "thinking", "tool", "json", "audio", "image", "file", "embedding",
]

public let toolDepthCap = 32

/// One normalized bus event. `isFinal` rather than `final`, which is a Swift
/// declaration modifier; the wire name in the envelope is unchanged.
public struct BusEvent: Sendable, Equatable {
    public let req: String
    public let event: String
    public let isFinal: Bool
    public let data: JSON
}

/// A tool waiting on a human or on a deadline. Nothing is held while it waits:
/// no engine request, no write lock.
private final class Parked {
    let id: String
    /// "approval" | "deadline"
    let kind: String
    let dueAt: Int
    let resume: (String) -> Void

    init(id: String, kind: String, dueAt: Int, resume: @escaping (String) -> Void) {
        self.id = id
        self.kind = kind
        self.dueAt = dueAt
        self.resume = resume
    }
}

/// One in-flight tool round: the groups still to run and the tool results
/// accumulated so far. A reference type on purpose - a group's completion
/// closures append to it from wherever the approval or the deadline resumed.
private final class ToolRound {
    let label: String?
    let key: String
    let model: String
    var messages: [JSON]
    let toolNames: [String]
    let args: JSON
    let kind: String
    let depth: Int
    let groups: [[JSON]]
    var results: [JSON] = []

    init(label: String?, key: String, model: String, messages: [JSON], toolNames: [String],
         args: JSON, kind: String, depth: Int, groups: [[JSON]]) {
        self.label = label
        self.key = key
        self.model = model
        self.messages = messages
        self.toolNames = toolNames
        self.args = args
        self.kind = kind
        self.depth = depth
        self.groups = groups
    }
}

/**
 * The reference host for one conformance case.
 *
 * Everything the corpus asserts is an observable on this object, which is the
 * same shape the TypeScript and Kotlin runners read - one grammar, three
 * implementations.
 */
public final class Host {
    private let spec: JSON
    private var engine: DespiaAI?

    public let caps: JSON
    private let enginePresent: Bool
    private let device: JSON
    private let policy: JSON
    private let table: JSON

    public private(set) var entries: [String: JSON] = [:]
    public private(set) var entryOrder: [String] = []
    /// The ids the USER added at runtime. This is the overlay a real device
    /// persists BESIDE the catalog rather than inside it: an OTA catalog
    /// replaces `entries` wholesale, and a model somebody chose must not
    /// disappear because the fleet's catalog was retuned.
    public private(set) var addedIds: [String] = []
    public var installed: [String] = []
    private var loadedModel: String?
    public private(set) var verdicts: [String: Verdict] = [:]
    private var quarantined: Set<String> = []

    // Observations.
    public private(set) var events: [BusEvent] = []
    public private(set) var errors: [JSON] = []
    public private(set) var absent: [JSON] = []
    public private(set) var results: [String: JSON] = [:]
    public private(set) var dispatched: [JSON] = []
    public private(set) var dispatchGroups: [[String]] = []
    public private(set) var remoteRequests: [JSON] = []
    public private(set) var notices: [JSON] = []
    public private(set) var catalogNotices: [JSON] = []
    public private(set) var transcript: [JSON] = []
    public private(set) var providers: [JSON] = []
    public private(set) var buildAbort: JSON?
    public private(set) var rows: [JSON] = []
    public private(set) var downloadCount = 0
    public private(set) var mcpConnectCount = 0
    public private(set) var downloadAttempts: [JSON] = []
    /// Every URL contacted while RESOLVING a source, in order. Zero is the whole
    /// assertion for a registry the app never allowed.
    public private(set) var resolveAttempts: [JSON] = []
    public private(set) var downloaded: [JSON] = []
    public private(set) var deletedOnMismatch: [String] = []
    public private(set) var pinnedDigests: [String: String] = [:]
    public private(set) var engineLoadCount = 0
    public private(set) var engineRequests: [JSON] = []
    public private(set) var serverResponses: [JSON] = []
    public private(set) var discoveryFile: JSON?
    public private(set) var boundLoopbackOnly = false
    public private(set) var tokenInUrl = false
    public private(set) var snapshotBeforeWrite = false
    public private(set) var snapshotBeforeFirstWrite = false
    public private(set) var dispatchedAfterApproval = false
    public private(set) var transcriptTransmitted = false
    public private(set) var ridOf: [String: Int] = [:]

    private var tools: [String: JSON] = [:]
    private var parked: [Parked] = []
    private var now = 0
    private var pinned: [String: String] = [:]
    private var store: [String: JSON] = [:]
    private let sessionToken = "session-token"
    private let discoveryToken = "pairing-token"
    private var externalConsent = false
    private var serverStarted = false
    private var writesSeen = 0
    private var approvalSeen = false
    private var ridSeq = 0

    public init(_ caseSpec: JSON) {
        spec = caseSpec
        enginePresent = !(caseSpec["engine"].has("present") && !caseSpec["engine"]["present"].bool())
        device = caseSpec["device"]
        policy = caseSpec["catalog"]["fit_policy"]
        table = caseSpec["router"]
        caps = Host.buildCaps(caseSpec)

        for (model, digest) in caseSpec["catalog"]["pinned"].fields.pairs {
            pinned[model] = digest.string()
        }
        for id in device["quarantined"].strings { quarantined.insert(id) }
        ingestCatalog()
        for tool in caseSpec["tools"].items { tools[tool["name"].string()] = tool }
        deriveProviders()
        rows = availableRows()
    }

    deinit { close() }

    /// Joins the engine's worker, so no callback arrives after this returns.
    public func close() {
        engine?.close()
        engine = nil
    }

    private static func buildCaps(_ spec: JSON) -> JSON {
        let defaults = JSON.parseOrNull(
            "{\"schema_version\":1,\"abi\":1,\"engines\":[\"gguf\",\"mock\"]," +
            "\"formats\":[\"gguf\",\"mock\"],\"modalities\":[\"text\",\"embedding\"]," +
            "\"dialects\":[\"hermes-json\"]," +
            "\"features\":[\"gbnf\",\"structured-output\",\"tools\"]}") ?? .null
        let declared = spec["engine"]["capabilities"]
        guard declared.isObject else { return defaults }
        var merged = defaults.fields
        if spec["engine"].has("abi") { merged.set("abi", spec["engine"]["abi"]) }
        for (key, value) in declared.fields.pairs { merged.set(key, value) }
        return .object(merged)
    }

    // MARK: - catalog

    private func ingestCatalog() {
        for entry in spec["catalog"]["entries"].items {
            // A malformed row is a ROW-level problem. One bad or too-new entry
            // must never blind an app to the rest of its models.
            guard let id = entry["id"].stringOrNull, entry["engine"].stringOrNull != nil else {
                catalogNotices.append(.obj([
                    ("code", .string("entry_skipped")),
                    ("reason", .string("missing_required_field")),
                ]))
                continue
            }
            let unknown = entry.fields.keys.filter { !knownEntryFields.contains($0) }
            if !unknown.isEmpty {
                catalogNotices.append(.obj([
                    ("code", .string("unknown_fields_ignored")),
                    ("entry", .string(id)),
                    ("fields", .of(unknown)),
                ]))
            }
            entries[id] = entry
            entryOrder.append(id)
        }
        // The RESTORED overlay: entries a previous launch added, read back
        // before anything else runs. A shipped row of the same id always wins -
        // the catalog is the fleet's document and a device-local addition may
        // never shadow it - and the collision is a notice rather than a silent
        // drop.
        for entry in spec["catalog"]["added"].items {
            guard let addedId = entry["id"].stringOrNull else { continue }
            if entries[addedId] != nil {
                catalogNotices.append(.obj([
                    ("code", .string("added_entry_skipped")),
                    ("reason", .string("id_shadows_catalog")),
                    ("entry", .string(addedId)),
                ]))
                continue
            }
            var fields = entry.fields
            var origin = entry["origin"].fields
            origin.set("added", .bool(true))
            fields.set("origin", .object(origin))
            entries[addedId] = .object(fields)
            entryOrder.append(addedId)
            addedIds.append(addedId)
        }

        installed = spec["catalog"]["installed"].strings
        // Installed ids the catalog never described still exist on disk; a bare
        // entry lets a case install a model without spelling out a whole row.
        for id in installed where entries[id] == nil {
            entries[id] = .obj([("id", .string(id)), ("engine", .string("mock")),
                                ("format", .string("mock"))])
            entryOrder.append(id)
        }
        if let loaded = spec["catalog"]["loaded"].stringOrNull { loadedModel = loaded }
        recomputeVerdicts()
    }

    private func recomputeVerdicts() {
        let dev = deviceWithQuarantine()
        for (id, entry) in entries {
            verdicts[id] = Fit.evaluate(entry: entry, device: dev, caps: caps, policy: policy)
        }
    }

    private func deviceWithQuarantine() -> JSON {
        var fields = device.fields
        fields.set("quarantined", .of(quarantined.sorted()))
        return .object(fields)
    }

    private func row(_ id: String) -> JSON {
        let verdict = verdicts[id]?.toJSON() ?? .obj([("verdict", .string("unsupported"))])
        var fields = verdict.fields
        fields.set("id", .string(id))
        if let status = entries[id]?["status"].stringOrNull { fields.set("status", .string(status)) }
        // A user-added model is never presented as a shipped one. The flag is on
        // the ROW because the row is what a surface renders.
        if entries[id]?["origin"]["added"].bool() == true { fields.set("added", .bool(true)) }
        return .object(fields)
    }

    private func installedRows() -> [JSON] {
        entryOrder.filter { installed.contains($0) }.map { row($0) }
    }

    /// Retirement stops NEW downloads only. An installed model keeps working
    /// forever - there is no remote kill switch.
    private func availableRows() -> [JSON] {
        entryOrder
            .filter { (entries[$0]?["status"].string("active") ?? "active") != "retired" }
            .map { row($0) }
    }

    // MARK: - tools

    private func deriveSchema(_ fromArgs: JSON) -> JSON {
        var properties = JSONObject()
        var required: [JSON] = []
        for (name, argSpec) in fromArgs.fields.pairs {
            properties.set(name, .obj([("type", .string(argSpec["type"].string()))]))
            if argSpec["required"].bool() { required.append(.string(name)) }
        }
        var out = JSONObject()
        out.set("type", .string("object"))
        out.set("properties", .object(properties))
        if !required.isEmpty { out.set("required", .array(required)) }
        return .object(out)
    }

    private func toolDefinition(_ name: String) -> JSON? {
        guard let tool = tools[name] else { return nil }
        // A module tool DERIVES its schema; a page or MCP tool carries its own
        // arbitrary JSON Schema through verbatim, never down-converted.
        let parameters: JSON
        if tool.has("fromArgs") {
            parameters = deriveSchema(tool["fromArgs"])
        } else if tool.has("schema") {
            parameters = tool["schema"]
        } else {
            parameters = .obj([("type", .string("object"))])
        }
        var def = JSONObject()
        def.set("name", .string(tool["name"].string(name)))
        def.set("parameters", parameters)
        if let description = tool["description"].stringOrNull {
            def.set("description", .string(description))
        }
        if let source = tool["source"].stringOrNull {
            def.set("source", .string(source))
            // Descriptions are UNTRUSTED input: tagged with where they came from,
            // and they change no policy.
            if source == "mcp" {
                def.set("provenance", .string("mcp:" + tool["server"].string("unknown")))
            }
            if source == "page" { def.set("provenance", .string("page")) }
        }
        return .object(def)
    }

    // MARK: - providers

    private func deriveProviders() {
        var order: [String] = []
        var claimants: [String: [JSON]] = [:]
        for providerRow in spec["providers"].items {
            // Exclusion is the resolution.
            if exclusionFor(providerRow["chain"].string()) != nil { continue }
            let modality = providerRow["modality"].string()
            if claimants[modality] == nil {
                claimants[modality] = []
                order.append(modality)
            }
            claimants[modality]?.append(providerRow)
        }
        for modality in order {
            let list = claimants[modality] ?? []
            if list.count > 1 {
                // Two ENABLED claimants of one modality is a BUILD abort, never a
                // runtime coin flip.
                buildAbort = .obj([
                    ("code", .string("facet_key_collision")),
                    ("word", .string("provider")),
                    ("key", .string(modality)),
                    ("claimants", .array(list.map { .string($0["chain"].string()) })),
                ])
                return
            }
        }
        for modality in order {
            guard let providerRow = claimants[modality]?.first else { continue }
            let engineId = providerRow["engine"].stringOrNull
            let carried = engineId == nil || caps["engines"].strings.contains(engineId!)
            var fields = JSONObject()
            fields.set("modality", .string(modality))
            fields.set("chain", .string(providerRow["chain"].string()))
            fields.set("available", .bool(carried))
            if !carried { fields.set("reason", .string("engine_not_carried")) }
            providers.append(.object(fields))
        }
    }

    private func providerFor(_ chain: String) -> (JSON, JSON)? {
        guard let providerRow = providers.first(where: { $0["chain"].string() == chain }),
              let declared = spec["providers"].items.first(where: { $0["chain"].string() == chain })
        else { return nil }
        return (providerRow, declared)
    }

    // MARK: - exclusion / absence

    private func exclusionFor(_ chain: String) -> JSON? {
        let overlay = spec["excludedOverlay"][chain]
        return overlay.isObject ? overlay : nil
    }

    @discardableResult
    private func absence(_ label: String?, _ action: String, _ code: String,
                         _ extra: [(String, JSON)] = []) -> JSON {
        var fields = JSONObject()
        fields.set("action", .string(action))
        fields.set("code", .string(code))
        for (key, value) in extra { fields.set(key, value) }
        let record = JSON.object(fields)
        absent.append(record)
        if let label { results[label] = .obj([("error", record)]) }
        return record
    }

    // MARK: - the bus

    public func call(_ step: JSON) {
        let scheme = step["scheme"].string("intelligence")
        let action = step["action"].string()
        let args = step["args"]
        let label = step["as"].stringOrNull

        if scheme == "base" { return baseCall(label, action, args) }
        if scheme == "mcp" { return mcpCall(label, action, args) }

        // Exclusion answers first and by name.
        if let excluded = exclusionFor(scheme) {
            var extra: [(String, JSON)] = [("reason", excluded["reason"])]
            if excluded.has("from") {
                extra.append(("from", excluded["from"]))
            } else if scheme.contains(".") {
                extra.append(("chain", .string(scheme)))
            }
            absence(label, action, "not_available", extra)
            return
        }
        if !enginePresent {
            absence(label, action, "not_available", [("reason", .string("engine_absent"))])
            return
        }

        if scheme != "intelligence" {
            if let provider = providerFor(scheme) {
                return providerCall(label, action, args, provider)
            }
            if scheme.hasPrefix("intelligence.") {
                // A child of the container with no declared row is still a chain
                // of this module: the residency law puts NEW actions on child
                // chains, so the call belongs here.
                let impliedRow = JSON.obj([("available", .bool(true)), ("chain", .string(scheme))])
                let impliedDeclared = JSON.obj([("chain", .string(scheme))])
                return providerCall(label, action, args, (impliedRow, impliedDeclared))
            }
            absence(label, action, "not_available", [("reason", .string("unknown_scheme"))])
            return
        }

        switch action {
        case "capabilities":
            if let label { results[label] = caps }
        case "models", "models.installed":
            rows = installedRows()
            if let label { results[label] = .obj([("rows", .array(rows))]) }
        case "models.available":
            rows = availableRows()
            if let label { results[label] = .obj([("rows", .array(rows))]) }
        case "models.fit":
            let id = args["model"].string()
            if let verdict = verdicts[id] {
                if let label { results[label] = verdict.toJSON() }
            } else {
                absence(label, action, "unknown_model",
                        [("data", .obj([("model", .string(id))]))])
            }
        case "models.add":
            modelsAdd(label, args)
        case "models.added":
            if let label { results[label] = .obj([("rows", .array(addedIds.map { row($0) }))]) }
        case "models.best":
            modelsBest(label, args)
        case "models.clearQuarantine":
            quarantined.remove(args["model"].string())
            recomputeVerdicts()
            if let label { results[label] = .obj([("ok", .bool(true))]) }
        case "download":
            download(label, args)
        case "completion", "embed":
            completion(label, action, args)
        default:
            absence(label, action, "unknown_action")
        }
    }

    // MARK: - open catalog: adding a model at runtime

    /// `models.add({ source, prefer?, revision?, id? })`.
    ///
    /// Turns a registry reference into a catalog entry at RUNTIME, so a
    /// developer who wants a model that is not in the shipped eleven writes one
    /// call instead of editing a JSON file and rebuilding. What comes out is an
    /// ordinary entry: download, the four locks, pre-flight, fit, the governor
    /// and load all apply to it unchanged, because it IS the same shape.
    ///
    /// THE REGISTRY'S ANSWER IS UNTRUSTED INPUT, and the sequence is what that
    /// means concretely: the app's declared registry says where to ask and the
    /// ANSWER never does; both legs are origin-checked before a byte is sent;
    /// nothing in a response may widen `allowed_model_hosts`; a revision that is
    /// not an immutable commit is refused; the FILE's own header outranks the
    /// registry; and the entry is marked `origin.added` forever.
    private func modelsAdd(_ label: String?, _ args: JSON) {
        func refuse(_ code: String, _ extra: [(String, JSON)]) {
            absence(label, "models.add", code, extra)
        }
        func refuseSynth(_ code: String, _ data: JSON?, _ message: String?) {
            var extra: [(String, JSON)] = []
            if let data { extra.append(("data", data)) }
            if let message { extra.append(("message", .string(message))) }
            refuse(code, extra)
        }

        let ref: SourceRef
        switch Catalog.parseSource(args["source"].string()) {
        case .no(let code, let data, let message): return refuseSynth(code, data, message)
        case .ok(let value): ref = value
        }

        let registry = spec["catalog"]["sources"][ref.scheme]
        guard registry.isObject else {
            // Fail closed, exactly like the origin allowlist: an app that has
            // not declared a registry has not opted into resolving against one.
            return refuse("source_unsupported", [
                ("reason", .string("registry_not_declared")),
                ("data", .obj([
                    ("registry", .string(ref.scheme)),
                    // `_`-prefixed keys are the document's own annotations,
                    // never registries.
                    ("declared", .of(spec["catalog"]["sources"].fields.keys
                        .filter { !$0.hasPrefix("_") })),
                ])),
                ("message", .string("This app does not resolve \"\(ref.scheme):\" sources.")),
            ])
        }

        let revision = args["revision"].stringOrNull ?? registry["default_revision"].string("main")
        let apiUrl = Catalog.expand(registry["api"].string(),
                                    ["repo": ref.repo, "revision": revision])
        let allowed = spec["delivery"]["allowed_model_hosts"].strings

        // The allowlist covers the METADATA leg as well as the bytes. A registry
        // the app never named is not contacted at all.
        if let refusal = Delivery.checkOrigin(apiUrl, allowed: allowed) {
            var data = refusal.data
            data.set("leg", .string("registry"))
            return refuse(refusal.code ?? "origin_not_allowed", [
                ("data", .object(data)),
                ("message", .string("This app is not allowed to talk to that model registry.")),
            ])
        }

        resolveAttempts.append(.obj([("url", .string(apiUrl)), ("leg", .string("registry"))]))
        let answer = spec["origins"][apiUrl]
        let info = answer["repo"]
        if answer.isNull || answer["unreachable"].bool() || !info.isObject {
            return refuse("resolve_failed", [
                ("data", .obj([("registry", .string(ref.scheme)), ("repo", .string(ref.repo))])),
                ("message", .string("That model registry did not answer.")),
            ])
        }

        let file: JSON
        switch Catalog.pickFile(info, path: ref.path, prefer: args["prefer"].stringOrNull) {
        case .no(let code, let data, let message): return refuseSynth(code, data, message)
        case .ok(let value): file = value
        }
        let wantedId = args["id"].stringOrNull

        // Phase one: synthesise WITHOUT the header, only to learn the URL the
        // app's own template resolves to. Nothing is stored from this pass.
        let probe: JSON
        switch Catalog.synthesize(ref: ref, registry: registry, info: info, file: file, id: wantedId) {
        case .no(let code, let data, let message): return refuseSynth(code, data, message)
        case .ok(let value): probe = value
        }
        let fileUrl = probe["files"][0]["urls"][0].string()

        if let refusal = Delivery.checkOrigin(fileUrl, allowed: allowed) {
            // The response resolved to a host this app never allowed. Nothing in
            // an API document may widen the allowlist, so this is where it
            // stops - and the error names the host, because "add a host" is a
            // decision a developer makes deliberately or not at all.
            var data = refusal.data
            data.set("leg", .string("file"))
            let host = refusal.data["host"]?.string() ?? "an origin"
            return refuse(refusal.code ?? "origin_not_allowed", [
                ("data", .object(data)),
                ("message", .string(
                    "That model is served from \(host), which this app does not allow.")),
            ])
        }

        // Phase two: read the header off the file itself and synthesise for
        // real. The bytes outrank the registry on everything they can answer.
        resolveAttempts.append(.obj([("url", .string(fileUrl)), ("leg", .string("file"))]))
        let header = spec["origins"][fileUrl]["header"]
        let entry: JSON
        switch Catalog.synthesize(ref: ref, registry: registry, info: info, file: file,
                                  header: header, id: wantedId) {
        case .no(let code, let data, let message): return refuseSynth(code, data, message)
        case .ok(let value): entry = value
        }
        let entryId = entry["id"].string()

        if let existing = entries[entryId], existing["origin"]["added"].bool() != true {
            // A shipped row is the fleet's document. A device-local addition may
            // never take its id and quietly change what a task routes to.
            return refuse("id_conflict", [
                ("data", .obj([("model", .string(entryId)), ("origin", .string("catalog"))])),
                ("message", .string("This app already ships a model called \(entryId). " +
                                    "Pass an id to add yours beside it.")),
            ])
        }

        entries[entryId] = entry
        if !entryOrder.contains(entryId) { entryOrder.append(entryId) }
        if !addedIds.contains(entryId) { addedIds.append(entryId) }
        verdicts[entryId] = Fit.evaluate(entry: entry, device: deviceWithQuarantine(),
                                         caps: caps, policy: policy)
        rows = availableRows()

        if entry["license"]["id"].string() == "unknown" {
            // Engine is not weights. A licence the repository did not state is
            // not a licence anybody may invent, so the entry records the absence
            // and the surface decides whether it will serve it.
            notices.append(.obj([
                ("code", .string("license_unknown")),
                ("data", .obj([("model", .string(entryId)), ("repo", .string(ref.repo))])),
            ]))
        }

        if let label {
            results[label] = .obj([
                ("entry", entry),
                ("verdict", verdicts[entryId]?.toJSON() ?? .null),
                ("added", .bool(true)),
            ])
        }
    }

    /// The downloadable catalog: everything not retired. Retirement stops NEW
    /// downloads only, which is exactly the right filter for a recommendation.
    private func downloadable() -> [String] {
        entryOrder.filter { (entries[$0]?["status"].string("active") ?? "active") != "retired" }
    }

    /// The best model of a kind that this device can actually run.
    ///
    /// ONE ranking, used by the refusal path as a fallback and by `models.best`
    /// where the router has no opinion. It reuses `Fit.meetsFloor` rather than
    /// restating a rank table: `runs_well` first, then `runs_slow`, and nothing
    /// else is a degree of "works". Among equals the LARGEST wins, because the
    /// biggest model that runs is the best quality this device can have.
    ///
    /// IT NEVER SUBSTITUTES ACROSS AN `unknown` CATEGORY, in either direction.
    /// The whole offer means "another model of the same kind", so it is only
    /// sound when the kind is known on both sides: a model this build could not
    /// classify gets no replacement suggested for it, and it is never suggested
    /// as a replacement for something else. Answering a refused speech model
    /// with a chat model is worse than answering with nothing, because nothing
    /// is obviously nothing and a chat model looks like an answer.
    private func bestAlternative(category: String?, exclude: String?,
                                 requireCaps: [String]) -> JSON {
        if category == Catalog.categoryUnknown {
            return .obj([("none", .bool(true)),
                         ("reason", .string("category_unknown")),
                         ("category", .string(Catalog.categoryUnknown))])
        }
        let features = caps["features"].strings
        let candidates = downloadable().filter { id in
            if id == exclude { return false }
            guard let entry = entries[id] else { return false }
            if entry["category"].stringOrNull == Catalog.categoryUnknown { return false }
            if let category, entry["category"].stringOrNull != category { return false }
            let declared = entry["requires"]["engine_caps"].strings
            if requireCaps.contains(where: { !features.contains($0) || !declared.contains($0) }) {
                return false
            }
            guard let verdict = verdicts[id] else { return false }
            return Fit.meetsFloor(verdict.verdict, nil)
        }
        if candidates.isEmpty {
            var fields = JSONObject()
            fields.set("none", .bool(true))
            fields.set("reason", .string("no_model_of_this_kind_runs_here"))
            if let category { fields.set("category", .string(category)) }
            return .object(fields)
        }
        func rank(_ id: String) -> Int {
            Fit.meetsFloor(verdicts[id]?.verdict ?? "", "runs_well") ? 1 : 0
        }
        func size(_ id: String) -> Double { entries[id]?["requirements"]["disk_mb"].number() ?? 0 }
        var best = candidates[0]
        for id in candidates.dropFirst() {
            if rank(id) > rank(best) || (rank(id) == rank(best) && size(id) > size(best)) {
                best = id      // ties keep catalog order
            }
        }
        return recommendation(best, "best-that-runs")
    }

    private func recommendation(_ id: String, _ reason: String) -> JSON {
        var fields = JSONObject()
        fields.set("model", .string(id))
        if let name = entries[id]?["name"].stringOrNull { fields.set("name", .string(name)) }
        fields.set("verdict", verdicts[id]?.toJSON() ?? .obj([("verdict", .string("unsupported"))]))
        fields.set("reason", .string(reason))
        fields.set("installed", .bool(installed.contains(id)))
        fields.set("download_mb", .number(entries[id]?["requirements"]["disk_mb"].number() ?? 0))
        return .object(fields)
    }

    /// `models.best({ task?, category? })` - what should this device DOWNLOAD.
    ///
    /// The router already answers "which of my INSTALLED models serves this
    /// task". This is the question a developer has first, and it is the same
    /// function over the whole catalog: `Router.route` with every downloadable
    /// id in the candidate set and no stickiness, since a resident model cannot
    /// be the answer to what to install.
    private func modelsBest(_ label: String?, _ args: JSON) {
        let task = args["task"].stringOrNull
        let category = args["category"].stringOrNull

        if task != nil, table["remote"]["policy"].string("local") == "remote-only" {
            absence(label, "models.best", "no_model_available", [
                ("reason", .string("policy-remote-only")),
                ("message", .string("This app is configured to run this task remotely, so there " +
                                    "is nothing to download.")),
            ])
            return
        }

        var requireCaps: [String] = []
        if let task {
            let taskSpec = table["tasks"].has(task) ? table["tasks"][task]
                                                    : table["tasks"][table["default"].string()]
            requireCaps = taskSpec["require_caps"].strings
            // The router's declared preference order IS the app's ranking. Where
            // it has one, it wins over any size heuristic.
            var local = table.fields
            local.remove("remote")
            let decision = Router.route(task: task, table: .object(local), installed: downloadable(),
                                        entries: entries, verdicts: verdicts, caps: caps, loaded: nil)
            if case .local(_, let model, let reason) = decision {
                if let label { results[label] = recommendation(model, reason) }
                return
            }
        }

        let best = bestAlternative(category: category, exclude: nil, requireCaps: requireCaps)
        if best["none"].bool() {
            var data = JSONObject()
            if let category { data.set("category", .string(category)) }
            if let task { data.set("task", .string(task)) }
            absence(label, "models.best", "no_model_available", [
                ("reason", best["reason"]),
                ("data", .object(data)),
                ("message", .string("No model in this catalog runs on this device.")),
            ])
            return
        }
        if let label { results[label] = best }
    }

    /// A refusal a person reads. It says what is wrong and what to do about it,
    /// because a download refusal is user-facing in effect whatever the code
    /// says.
    private func refusalSentence(_ id: String, _ verdict: Verdict, _ fallback: JSON) -> String {
        let offer: String
        if fallback["reason"].stringOrNull == "category_unknown" {
            // Saying nothing runs here would be a different, false claim. What
            // is true is narrower: this build could not tell what kind of model
            // it is, so it has nothing it is entitled to offer in its place.
            offer = " This build could not tell what kind of model that is, so it is not " +
                    "suggesting a replacement."
        } else if fallback["none"].bool() {
            offer = " No model in this catalog runs on this device."
        } else {
            let how = fallback["verdict"]["verdict"].string() == "runs_well" ? "runs well"
                                                                            : "runs, slowly"
            offer = " Try \(fallback["model"].string()) instead - it \(how) on this device."
        }
        if verdict.verdict == "too_big" && verdict.reason == "memory" {
            return "\(id) needs more memory than this device gives an app, so it would not run " +
                   "even once it downloaded.\(offer)"
        }
        if verdict.verdict == "too_big" { return "\(id) is too big for this device.\(offer)" }
        if verdict.verdict == "quarantined" {
            return "\(id) crashed this app the last time it loaded and is held back until you " +
                   "clear it.\(offer)"
        }
        return "This build cannot run \(id) (\(verdict.reason ?? "unsupported")).\(offer)"
    }

    private func download(_ label: String?, _ args: JSON) {
        let id = args["model"].string()
        guard let entry = entries[id] else {
            absence(label, "download", "unknown_model", [("data", .obj([("model", .string(id))]))])
            return
        }
        if entry["status"].string("active") == "retired" {
            absence(label, "download", "model_retired", [("data", .obj([("model", .string(id))]))])
            return
        }
        // Storage is accounted BEFORE the bytes move. This is the LIVE
        // free-space check and it stays ahead of the fit verdict below: it is
        // the more specific answer and it reads the device, not the catalog.
        let needed = entry["requirements"]["disk_mb"].number()
        let free = device.has("free_disk_mb") ? device["free_disk_mb"].number() : Double.greatestFiniteMagnitude
        let category = entry["category"].stringOrNull
        if needed > free {
            absence(label, "download", "insufficient_storage", [
                ("data", .obj([
                    ("needed_mb", .number(needed)),
                    ("free_mb", .number(free)),
                    ("fallback", bestAlternative(category: category, exclude: id, requireCaps: [])),
                ])),
                ("message", .string(
                    "\(id) needs \(Int(needed)) MB and this device has \(Int(free)) MB free. " +
                    "Free up space, or install a smaller model.")),
            ])
            return
        }

        // Lock 4, BEFORE the bytes move. It used to run only on the request
        // path, which meant a device with plenty of disk and no memory would
        // download gigabytes and discover at LOAD time that it could not run
        // them - the user paying the wait, the data and the battery for an
        // error. The refusal carries the verdict AND the reason, because "too
        // big for memory" and "too big for disk" send a person to two completely
        // different remedies.
        if let verdict = verdicts[id], let code = refusesDownload[verdict.verdict] {
            let fallback = bestAlternative(category: category, exclude: id, requireCaps: [])
            var extra: [(String, JSON)] = []
            if let reason = verdict.reason { extra.append(("reason", .string(reason))) }
            var data = JSONObject()
            data.set("model", .string(id))
            data.set("verdict", .string(verdict.verdict))
            if let reason = verdict.reason { data.set("reason", .string(reason)) }
            data.set("fallback", fallback)
            extra.append(("data", .object(data)))
            extra.append(("message", .string(refusalSentence(id, verdict, fallback))))
            absence(label, "download", code, extra)
            return
        }
        if !entry["files"].items.isEmpty {
            // `pinned` is copied out and back so the closures below, which capture
            // self, never overlap an inout access to a property of the same self.
            var pins = pinned
            let outcome = Delivery.deliver(
                entry: entry,
                allowed: spec["delivery"]["allowed_model_hosts"].strings,
                pinned: &pins,
                fetch: { url in
                    let response = self.spec["origins"][url]
                    return response.isNull ? nil : response
                },
                onAttempt: { url in self.downloadAttempts.append(.obj([("url", .string(url))])) },
                onDelete: { model in self.deletedOnMismatch.append(model) })
            pinned = pins
            for (model, digest) in pinned { pinnedDigests[model] = digest }
            if !outcome.ok {
                absence(label, "download", outcome.code ?? "download_failed",
                        [("data", .object(outcome.data))])
                return
            }
            downloaded.append(.obj([
                ("model", .string(id)),
                ("sha256", .string(outcome.sha256 ?? "")),
                ("url", .string(outcome.url ?? "")),
                ("verified", .bool(true)),
            ]))
        }
        downloadCount += 1
        if !installed.contains(id) { installed.append(id) }
        if let label { results[label] = .obj([("ok", .bool(true))]) }
    }

    // MARK: - completion + the agentic loop

    private func completion(_ label: String?, _ action: String, _ args: JSON) {
        if device.has("runs_inference"), !device["runs_inference"].bool() {
            // Reach-vs-run: every target REACHES the surface; running is a
            // per-target declaration, and reach without run answers typed.
            absence(label, action, "not_available", [
                ("reason", .string("run_not_declared")),
                ("data", .obj([("target", device["target"])])),
            ])
            return
        }

        var model = args["model"].stringOrNull
        let task = args["task"].stringOrNull
        let key = nextKey(label)

        if let named = model {
            if entries[named] == nil {
                absence(label, action, "unknown_model", [("data", .obj([("model", .string(named))]))])
                return
            }
            emit(key, "routing", .obj([("model", .string(named)), ("reason", .string("explicit"))]), false)
        } else if let task {
            if installed.isEmpty, table["remote"]["policy"].string("local") == "local" {
                absence(label, action, "no_model_available", [("reason", .string("none_installed"))])
                return
            }
            switch Router.route(task: task, table: table, installed: installed, entries: entries,
                                verdicts: verdicts, caps: caps, loaded: loadedModel) {
            case .unresolved(_, let reason):
                absence(label, action, "no_model_available", [("reason", .string(reason))])
                return
            case .remote(_, let reason):
                emit(key, "routing", .obj([
                    ("task", .string(task)),
                    ("engine", .string("remote")),
                    ("reason", .string(reason)),
                ]), false)
                return runRemote(label, key)
            case .local(_, let chosen, let reason):
                emit(key, "routing", .obj([
                    ("task", .string(task)),
                    ("model", .string(chosen)),
                    ("reason", .string(reason)),
                ]), false)
                model = chosen
            }
        } else {
            absence(label, action, "no_model_available", [("reason", .string("none_installed"))])
            return
        }

        // Kotlin writes `entries[model]!!` here because the branches above have
        // already established both. Swift has no equivalent worth having: a
        // force-unwrap in a corpus runner turns one wrong case into a dead suite.
        // Structurally unreachable, and typed rather than silent if it ever is.
        guard let resolved = model, let entry = entries[resolved],
              let verdict = verdicts[resolved] else {
            absence(label, action, "unknown_model",
                    [("data", .obj([("model", .string(model ?? ""))]))])
            return
        }
        if !caps["engines"].strings.contains(entry["engine"].string("mock")) {
            absence(label, action, "unsupported", [
                ("reason", .string("engine_not_carried")),
                ("data", .obj([("engine", entry["engine"])])),
            ])
            return
        }
        switch verdict.verdict {
        case "quarantined":
            absence(label, action, "model_quarantined",
                    [("data", .obj([("model", .string(resolved))]))])
            return
        case "too_big":
            absence(label, action, "model_too_big", [("data", .obj([
                ("verdict", .string(verdict.verdict)),
                ("reason", .string(verdict.reason ?? "")),
            ]))])
            return
        case "unsupported":
            absence(label, action, "unsupported", [("reason", .string(verdict.reason ?? ""))])
            return
        default:
            break
        }

        // A declared `inputs` list is a contract.
        if entry.has("inputs") {
            let declared = entry["inputs"].strings
            for message in args["messages"].items {
                for part in message["parts"].items {
                    guard let type = part["type"].stringOrNull else { continue }
                    if !declared.contains(type) {
                        absence(label, action, "unsupported_input", [("data", .obj([
                            ("type", .string(type)),
                            ("model", .string(resolved)),
                        ]))])
                        return
                    }
                }
            }
        }

        ensureLoaded(resolved, entry)
        turn(label: label, key: key, model: resolved, messages: args["messages"].items,
             toolNames: args["tools"].strings, args: args, kind: action, depth: 0)
    }

    private func ensureLoaded(_ model: String, _ entry: JSON) {
        if engine == nil { engine = try? DespiaAI() }
        var fields = entry.fields
        fields.set("engine", .string("mock"))
        fields.set("format", .string("mock"))
        let script = spec["mock"]["models"][model]
        if !script.isNull { fields.set("mock", script) }
        engineLoadCount += 1
        // A refused load is not swallowed: the model simply never becomes live,
        // and the turn below produces no events, which is what the fixture that
        // scripts `load.error` asserts.
        if let engine = engine { try? engine.load(entry: .object(fields)) }
        loadedModel = model
    }

    private func turn(label: String?, key: String, model: String, messages: [JSON],
                      toolNames: [String], args: JSON, kind: String, depth: Int) {
        var request = JSONObject()
        request.set("schema_version", .number(1))
        request.set("kind", .string(kind))
        request.set("model", .string(model))
        request.set("messages", .array(messages))
        let defs = toolNames.compactMap { toolDefinition($0) }
        if !defs.isEmpty { request.set("tools", .array(defs)) }
        if args.has("response_format") {
            request.set("response_format", args["response_format"])
            // Structured output is v1: the schema compiles to a grammar.
            if caps["features"].strings.contains("gbnf") { request.set("grammar", .string("gbnf")) }
        }
        engineRequests.append(.object(request))
        transcript.append(.obj([("kind", .string("request")), ("model", .string(model))]))

        var toolCalls: [JSON] = []
        var failure: JSON?
        var terminal: JSON?

        var envelopes: [JSON] = []
        if let engine = engine { envelopes = (try? engine.drain(.object(request))) ?? [] }
        ridOf[key] = envelopes.first?["id"].int() ?? 0
        for envelope in envelopes {
            switch envelope["event"].string() {
            case "token":
                let delta = envelope["data"]["delta"]
                let type = delta["type"].string()
                if type == "tool" {
                    toolCalls.append(delta)
                } else if !knownBlocks.contains(type) {
                    // Must-ignore with a receipt: an unknown block from a newer
                    // engine is dropped, recorded, and the request still completes.
                    notices.append(.obj([
                        ("code", .string("unknown_block_ignored")),
                        ("data", .obj([("type", delta["type"])])),
                    ]))
                } else {
                    emit(key, "token", envelope["data"], false)
                }
            case "sync":
                emit(key, "sync", envelope["data"], false)
            case "error":
                failure = envelope["data"]
            case "complete":
                terminal = envelope["data"]
            default:
                break
            }
        }

        if let failure {
            errors.append(.obj([
                ("req", .string(key)),
                ("code", failure["code"]),
                ("message", failure["message"]),
            ]))
            if let label { results[label] = .obj([("error", failure)]) }
            return
        }

        if !toolCalls.isEmpty {
            if depth >= toolDepthCap {
                errors.append(.obj([
                    ("req", .string(key)),
                    ("code", .string("tool_depth_exceeded")),
                    ("data", .obj([("depth", .number(Double(toolDepthCap)))])),
                ]))
                return
            }
            dispatchTools(label: label, key: key, model: model, messages: messages,
                          toolNames: toolNames, args: args, kind: kind, depth: depth + 1,
                          calls: toolCalls)
            return
        }

        var data = JSONObject()
        data.set("snapshot", .array(finalSnapshot(model, terminal?["snapshot"].items ?? [])))
        if let usage = terminal?["usage"], !usage.isNull { data.set("usage", usage) }
        if terminal?["cancelled"].bool() == true { data.set("cancelled", .bool(true)) }
        emit(key, "complete", .object(data), true)
        transcript.append(.obj([("kind", .string("complete"))]))
        if let label { results[label] = .object(data) }
    }

    /// Blocks this build understands, coalesced, with embeddings stamped.
    private func finalSnapshot(_ model: String, _ raw: [JSON]) -> [JSON] {
        var out: [JSON] = []
        for block in raw {
            let type = block["type"].string()
            if !knownBlocks.contains(type) { continue }
            if type == "embedding", !block.has("model") {
                var fields = block.fields
                fields.set("model", .string(model))
                out.append(.object(fields))
                continue
            }
            if type == "text" || type == "thinking",
               let last = out.last, last["type"].string() == type {
                var fields = last.fields
                fields.set("text", .string(last["text"].string() + block["text"].string()))
                out[out.count - 1] = .object(fields)
                continue
            }
            out.append(block)
        }
        return out
    }

    /// Consecutive read-only calls run together; a mutating call runs alone.
    private func groupsOf(_ calls: [JSON]) -> [[JSON]] {
        var groups: [[JSON]] = []
        var current: [JSON] = []
        for call in calls {
            if tools[call["name"].string()]?.has("mutates") == true {
                if !current.isEmpty { groups.append(current); current = [] }
                groups.append([call])
            } else {
                current.append(call)
            }
        }
        if !current.isEmpty { groups.append(current) }
        return groups
    }

    private func dispatchTools(label: String?, key: String, model: String, messages: [JSON],
                               toolNames: [String], args: JSON, kind: String, depth: Int,
                               calls: [JSON]) {
        let round = ToolRound(label: label, key: key, model: model, messages: messages,
                              toolNames: toolNames, args: args, kind: kind, depth: depth,
                              groups: groupsOf(calls))
        runGroup(round, 0)
    }

    private func runGroup(_ round: ToolRound, _ index: Int) {
        if index >= round.groups.count {
            round.messages.append(contentsOf: round.results)
            turn(label: round.label, key: round.key, model: round.model, messages: round.messages,
                 toolNames: round.toolNames, args: round.args, kind: round.kind, depth: round.depth)
            return
        }
        let group = round.groups[index]
        let names = group.map { $0["name"].string() }
        var pending = group.count
        let done: () -> Void = {
            pending -= 1
            if pending == 0 {
                self.dispatchGroups.append(names)
                self.runGroup(round, index + 1)
            }
        }
        for call in group { runTool(round, call, done) }
    }

    private func runTool(_ round: ToolRound, _ call: JSON, _ done: @escaping () -> Void) {
        let key = round.key
        let id = call["id"].string("call_0")
        let name = call["name"].string()
        let argsIn = call["arguments"]
        transcript.append(.obj([
            ("kind", .string("tool_call")),
            ("name", .string(name)),
            ("arguments", argsIn),
        ]))

        let answer: (JSON, String) -> Void = { content, status in
            self.emit(key, "tool", .obj([
                ("id", .string(id)),
                ("name", .string(name)),
                ("status", .string(status)),
            ]), false)
            self.transcript.append(.obj([("kind", .string("tool_result")), ("id", .string(id))]))
            round.results.append(.obj([
                ("role", .string("tool")),
                ("tool_call_id", .string(id)),
                ("content", content),
            ]))
            done()
        }

        // A tool may not call the model that is running it.
        if name == "intelligence" || name.hasPrefix("intelligence.") {
            return answer(.obj([("error", .string("tool_self_call"))]), "refused")
        }
        guard let toolSpec = tools[name] else {
            return answer(.obj([("error", .string("tool_unknown"))]), "unknown")
        }

        let dispatch: () -> Void = {
            if toolSpec["hangs"].bool() {
                // A hung page callback or MCP server must not stall the loop: the
                // deadline turns it into a typed answer the model can react to.
                self.emit(key, "tool", .obj([
                    ("id", .string(id)),
                    ("name", .string(name)),
                    ("arguments", argsIn),
                    ("status", .string("ready")),
                ]), false)
                let deadline = self.now + Int(toolSpec["deadline_ms"].number(30000))
                self.park(Parked(id: id, kind: "deadline", dueAt: deadline) { _ in
                    answer(.obj([("error", .string("tool_timeout"))]), "timeout")
                })
                return
            }
            self.emit(key, "tool", .obj([
                ("id", .string(id)),
                ("name", .string(name)),
                ("arguments", argsIn),
                ("status", .string("ready")),
            ]), false)
            if toolSpec.has("mutates") {
                // A pre-write snapshot, then a savepoint: a failure unwinds
                // atomically and the backup predates the agent.
                self.snapshotBeforeWrite = true
                if self.writesSeen == 0 { self.snapshotBeforeFirstWrite = true }
                self.writesSeen += 1
                if self.approvalSeen { self.dispatchedAfterApproval = true }
            }
            if toolSpec["fails"].bool() {
                return answer(.obj([("error", .string("tool_failed"))]), "failed")
            }
            var record = JSONObject()
            record.set("name", .string(name))
            record.set("arguments", argsIn)
            if let source = toolSpec["source"].stringOrNull { record.set("source", .string(source)) }
            self.dispatched.append(.object(record))
            answer(toolSpec.has("returns") ? toolSpec["returns"] : .obj([("ok", .bool(true))]), "done")
        }

        // A `mutates` tool is approval-gated regardless of which source offered
        // it, and a description saying otherwise changes nothing.
        if toolSpec.has("mutates"), toolSpec["approval"].string() == "prompt" {
            emit(key, "tool", .obj([
                ("id", .string(id)),
                ("name", .string(name)),
                ("arguments", argsIn),
                ("status", .string("awaiting_approval")),
            ]), false)
            let dueAt = toolSpec.has("approval_timeout_ms")
                ? now + Int(toolSpec["approval_timeout_ms"].number())
                : Int.max
            park(Parked(id: id, kind: "approval", dueAt: dueAt) { outcome in
                self.transcript.append(.obj([
                    ("kind", .string("approval")),
                    ("id", .string(id)),
                    ("decision", .string(outcome)),
                ]))
                switch outcome {
                case "approve":
                    self.approvalSeen = true
                    self.emit(key, "tool", .obj([
                        ("id", .string(id)),
                        ("status", .string("approved")),
                    ]), false)
                    dispatch()
                case "deny":
                    answer(.obj([("error", .string("tool_denied"))]), "denied")
                default:
                    answer(.obj([("error", .string("approval_timeout"))]), "timeout")
                }
            })
            return
        }
        dispatch()
    }

    // Nothing is held while a tool is parked: no engine request, no write lock.
    private func park(_ p: Parked) { parked.append(p) }

    public func approve(_ id: String, _ decision: String) {
        guard let index = parked.firstIndex(where: { $0.id == id && $0.kind == "approval" }) else {
            return
        }
        let p = parked.remove(at: index)
        p.resume(decision)
    }

    public func tick(_ ms: Int) {
        now += ms
        while true {
            guard let index = parked.firstIndex(where: { $0.dueAt <= now }) else { return }
            let p = parked.remove(at: index)
            p.resume("timeout")
        }
    }

    // MARK: - providers, remote, base, mcp

    private func providerCall(_ label: String?, _ action: String, _ args: JSON,
                              _ provider: (JSON, JSON)) {
        let (providerRow, declared) = provider
        if !providerRow["available"].bool() {
            absence(label, action, "not_available", [
                ("reason", .string("engine_not_carried")),
                ("data", .obj([("engine", declared["engine"])])),
            ])
            return
        }
        if let want = args["language"].stringOrNull {
            // A request no installed voice serves is a missing asset, not a
            // failure of speech.
            let serving = entryOrder.filter { (entries[$0]?["languages"].strings ?? []).contains(want) }
            if !serving.contains(where: { installed.contains($0) }) {
                absence(label, action, "no_voice_for_language", [("data", .obj([
                    ("language", .string(want)),
                    ("available", .of(serving)),
                ]))])
                return
            }
        }
        guard let model = args["model"].stringOrNull ?? installed.first else {
            absence(label, action, "no_model_available", [("reason", .string("none_installed"))])
            return
        }
        let key = nextKey(label)
        let entry = entries[model] ?? .obj([("id", .string(model)), ("engine", .string("mock"))])
        ensureLoaded(model, entry)
        turn(label: label, key: key, model: model, messages: [], toolNames: [], args: args,
             kind: action, depth: 0)
    }

    private func runRemote(_ label: String?, _ key: String) {
        let remote = table["remote"]
        // No credential ships in the app: the app's own backend holds the keys.
        remoteRequests.append(.obj([
            ("endpoint", remote["endpoint"]),
            ("dialect", remote["dialect"]),
            ("hasCredential", .bool(false)),
        ]))
        let mock = spec["remoteMock"]
        if mock.has("error") {
            errors.append(.obj([
                ("req", .string(key)),
                ("code", .string(mock["error"]["code"].string("remote_failed"))),
                ("message", mock["error"]["message"]),
            ]))
            if let label { results[label] = .obj([("error", mock["error"])]) }
            return
        }
        var snapshot: [JSON] = []
        var seq = 0
        var text = ""
        for step in mock["script"].items {
            guard step.has("token") else { continue }
            let delta = JSON.obj([("type", .string("text")), ("text", step["token"])])
            emit(key, "token", .obj([("seq", .number(Double(seq))), ("delta", delta)]), false)
            seq += 1
            text += step["token"].string()
        }
        if !text.isEmpty {
            snapshot.append(.obj([("type", .string("text")), ("text", .string(text))]))
        }
        let data = JSON.obj([("snapshot", .array(snapshot))])
        emit(key, "complete", data, true)
        if let label { results[label] = data }
    }

    /// The minimal store the ai corpus needs to prove that a pending approval
    /// holds no write lock. Despia Base proper is OpenSource/Base.
    private func baseCall(_ label: String?, _ action: String, _ args: JSON) {
        let path = args["store"].string() + "/" + args["key"].string()
        switch action {
        case "put":
            store[path] = args["value"]
            if let label { results[label] = .obj([("ok", .bool(true))]) }
        case "get":
            if let label { results[label] = .obj([("value", store[path] ?? .null)]) }
        default:
            if let label { results[label] = .obj([("ok", .bool(true))]) }
        }
    }

    private func mcpCall(_ label: String?, _ action: String, _ args: JSON) {
        let servers = spec["mcpServers"].items
        switch action {
        case "connect":
            let name = args["server"].string()
            guard let server = servers.first(where: { $0["name"].string() == name }) else {
                // The app's config is the allowlist: a model cannot talk the app
                // into a new network peer.
                absence(label, action, "server_not_declared",
                        [("data", .obj([("server", .string(name))]))])
                return
            }
            if server["unreachable"].bool() {
                // Degradation is per-server.
                errors.append(.obj([
                    ("req", .string(label ?? "")),
                    ("code", .string("server_unreachable")),
                    ("data", .obj([("server", .string(name))])),
                ]))
                return
            }
            mcpConnectCount += 1
            for tool in server["tools"].items {
                // Namespaced by server, so two servers offering `search` never
                // collide.
                let namespaced = "mcp." + name + "." + tool["name"].string()
                var fields = tool.fields
                fields.set("name", .string(namespaced))
                fields.set("source", .string("mcp"))
                fields.set("server", .string(name))
                tools[namespaced] = .object(fields)
            }
            if let label { results[label] = .obj([("ok", .bool(true))]) }
        case "server.tools":
            let served = spec["servedRows"].items.map { rowSpec -> JSON in
                var fields = JSONObject()
                fields.set("name", rowSpec["action"])
                fields.set("description", rowSpec["description"])
                fields.set("inputSchema", rowSpec.has("fromArgs")
                    ? deriveSchema(rowSpec["fromArgs"])
                    : .obj([("type", .string("object"))]))
                if rowSpec.has("mutates") { fields.set("mutates", rowSpec["mutates"]) }
                return .object(fields)
            }
            if let label { results[label] = .obj([("tools", .array(served))]) }
        case "server.start":
            serverStarted = true
            // Loopback only, and the token is the boundary rather than the
            // interface - it never rides in a URL.
            boundLoopbackOnly = true
            tokenInUrl = false
            if let label { results[label] = .obj([("ok", .bool(true)), ("port", .number(0))]) }
        case "server.consent":
            externalConsent = args["external"].bool()
            if externalConsent {
                discoveryFile = .obj([
                    ("mode", .string("0600")),
                    ("hasPort", .bool(true)),
                    ("tokenDistinctFromSession", .bool(discoveryToken != sessionToken)),
                    ("removedAfterWithdrawal", .bool(false)),
                ])
            } else {
                var fields = (discoveryFile ?? .object(JSONObject())).fields
                fields.set("removedAfterWithdrawal", .bool(true))
                discoveryFile = .object(fields)
            }
            if let label { results[label] = .obj([("ok", .bool(true))]) }
        default:
            if let label { results[label] = .obj([("ok", .bool(true))]) }
        }
    }

    public func serverRequest(_ step: JSON) {
        let label = step["as"].string()
        let raw = step["token"].stringOrNull
        let token: String?
        if raw == "$session.token" {
            token = sessionToken
        } else if raw == "$discovery.token" {
            token = externalConsent ? discoveryToken : "stale"
        } else {
            token = raw
        }
        let valid = token == sessionToken || (token == discoveryToken && externalConsent)
        if !serverStarted || !valid {
            serverResponses.append(.obj([("req", .string(label)), ("code", .string("unauthorized"))]))
            return
        }
        guard let servedRow = spec["servedRows"].items
            .first(where: { $0["action"].string() == step["tool"].string() })
        else {
            serverResponses.append(.obj([("req", .string(label)), ("code", .string("unknown_tool"))]))
            return
        }
        if servedRow.has("mutates"), servedRow["approval"].string() == "prompt" {
            // The protocol is not a bypass: a write requested over MCP waits for
            // approval and runs inside a snapshot, exactly like an in-app one.
            park(Parked(id: label, kind: "approval", dueAt: Int.max) { outcome in
                if outcome == "approve" {
                    self.snapshotBeforeWrite = true
                    self.approvalSeen = true
                    self.dispatchedAfterApproval = true
                    self.serverResponses.append(.obj([
                        ("req", .string(label)),
                        ("ok", .bool(true)),
                    ]))
                } else {
                    self.serverResponses.append(.obj([
                        ("req", .string(label)),
                        ("code", .string("tool_denied")),
                    ]))
                }
            })
            return
        }
        serverResponses.append(.obj([("req", .string(label)), ("ok", .bool(true))]))
    }

    /// A request's stream name. The `as` label when the case gave one, otherwise a
    /// counter - and the counter only advances when it is actually used, matching
    /// `label ?: "#${++ridSeq}"` in the Kotlin twin.
    private func nextKey(_ label: String?) -> String {
        if let label { return label }
        ridSeq += 1
        return "#\(ridSeq)"
    }

    private func emit(_ req: String, _ event: String, _ data: JSON, _ isFinal: Bool) {
        events.append(BusEvent(req: req, event: event, isFinal: isFinal, data: data))
    }
}
