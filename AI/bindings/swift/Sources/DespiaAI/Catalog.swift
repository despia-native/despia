//
//  Catalog.swift - synthesising a catalog entry from a model registry's answer.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The Swift twin of bindings/ts/src/catalog.ts and Catalog.kt.
//  OpenSource/Conformance/ai/open-catalog is what says the three produce the
//  same entry from the same inputs.
//
//  THE REGISTRY DOCUMENT IS UNTRUSTED INPUT. It is a network document from a
//  host, not a fact:
//
//    - THE REGISTRY NEVER NAMES A HOST. Both URLs come from TEMPLATES the APP
//      declared (`catalog.sources`), and the only things interpolated into them
//      are the caller's repo, a validated 40-hex commit and a validated relative
//      path. A response cannot say where the next request goes.
//    - THE REVISION MUST BE AN IMMUTABLE COMMIT. `main` names different bytes on
//      different days and never reaches a stored entry.
//    - THE DIGEST IS A CLAIM. Well formed, it rides into the entry so the
//      download verifies against it before the engine sees the file; MALFORMED,
//      it is dropped and the device pins what it actually downloaded, because a
//      digest that can never match is worse than no digest.
//    - THE LICENCE IS THE REPO'S, and its absence is recorded rather than
//      invented. Engine is not weights.
//    - THE FILE OUTRANKS THE REGISTRY on anything the bytes can answer.
//

import Foundation

private let mib = 1024.0 * 1024.0

/// The context the engine SIZES ITS KV CACHE TO, not the model's maximum.
public let defaultServingContext = 4096

public struct SourceRef: Sendable, Equatable {
    public let scheme: String
    public let repo: String
    public let path: String?
}

/// Either a value or a typed refusal. Never a thrown error: an add that fails is
/// an answer, and a trap is not one.
public enum Synth<T> {
    case ok(T)
    case no(code: String, data: JSON?, message: String?)
}

public enum Catalog {

    // MARK: - the reference

    private static func isSegment(_ text: String) -> Bool {
        guard let first = text.first, first.isASCII, first.isLetter || first.isNumber else { return false }
        return text.allSatisfy { c in
            c.isASCII && (c.isLetter || c.isNumber || c == "." || c == "_" || c == "-")
        }
    }

    private static func isRelativePath(_ text: String) -> Bool {
        guard let first = text.first, first.isASCII, first.isLetter || first.isNumber else { return false }
        return text.allSatisfy { c in
            c.isASCII && (c.isLetter || c.isNumber || c == "." || c == "_" || c == "-" || c == "/")
        }
    }

    /// `hf:org/repo` or `hf:org/repo/some/file.gguf`. The reference is caller
    /// input and ends up inside a URL, so every segment is validated rather than
    /// trusted: no `..`, no scheme, no query, no absolute path.
    public static func parseSource(_ source: String) -> Synth<SourceRef> {
        let raw = source.trimmingCharacters(in: .whitespaces)
        guard let colon = raw.firstIndex(of: ":"), colon != raw.startIndex else {
            return .no(code: "source_malformed", data: .obj([("source", .string(raw))]),
                       message: "A model source looks like \"hf:org/repo/file.gguf\" or " +
                                "\"hf:org/repo\" with a prefer.")
        }
        let scheme = String(raw[raw.startIndex..<colon])
        let rest = String(raw[raw.index(after: colon)...])
        if !isSegment(scheme) || rest.contains("?") || rest.contains("#") || rest.contains("\\") {
            return .no(code: "source_malformed", data: .obj([("source", .string(raw))]),
                       message: "That source is not a registry reference.")
        }
        let parts = rest.split(separator: "/").map(String.init)
        if parts.count < 2 || parts.contains(where: { !isSegment($0) }) {
            return .no(code: "source_malformed", data: .obj([("source", .string(raw))]),
                       message: "A model source needs an owner and a repository, like \"hf:org/repo\".")
        }
        let path = parts.count > 2 ? parts.dropFirst(2).joined(separator: "/") : nil
        return .ok(SourceRef(scheme: scheme, repo: "\(parts[0])/\(parts[1])", path: path))
    }

    /// The template is the APP's; the values are validated before they arrive.
    public static func expand(_ template: String, _ values: [String: String]) -> String {
        var out = template
        for (key, value) in values.sorted(by: { $0.key < $1.key }) {
            out = out.replacingOccurrences(of: "{\(key)}", with: value)
        }
        return out
    }

    // MARK: - the file

    /// A file the engine cannot serve is refused when it is ADDED rather than at
    /// load time on someone's phone.
    public static func formatFor(_ filename: String) -> String? {
        filename.hasSuffix(".gguf") ? "gguf" : nil
    }

    /// `model-00001-of-00003.gguf`. A shard is not a model file: an entry names
    /// one file, and half a model that passes every lock is still half a model.
    private static func isShard(_ name: String) -> Bool {
        guard name.hasSuffix(".gguf") else { return false }
        let stem = String(name.dropLast(5))
        // "<anything>-NNNNN-of-NNNNN"
        let parts = stem.split(separator: "-").map(String.init)
        guard parts.count >= 3 else { return false }
        let total = parts[parts.count - 1]
        let of = parts[parts.count - 2]
        let index = parts[parts.count - 3]
        return of == "of" && total.count == 5 && index.count == 5 &&
               total.allSatisfy({ $0.isNumber }) && index.allSatisfy({ $0.isNumber })
    }

    private static func ggufNames(_ info: JSON) -> [JSON] {
        info["siblings"].items.filter { $0["rfilename"].string().hasSuffix(".gguf") }
    }

    /// Which file this add is about: named explicitly, or chosen by a quant
    /// preference. The choice is DETERMINISTIC - shortest matching name, then
    /// lexicographic - because "the first one the API listed" makes the entry a
    /// function of the response's ordering, and a repo that reorders its files
    /// would silently change which model an app installs.
    public static func pickFile(_ info: JSON, path: String?, prefer: String?) -> Synth<JSON> {
        let available = ggufNames(info)
        if let path {
            guard let named = info["siblings"].items.first(where: { $0["rfilename"].string() == path })
            else {
                return .no(code: "file_not_found",
                           data: .obj([("file", .string(path)),
                                       ("available", .of(available.map { $0["rfilename"].string() }))]),
                           message: "That repository has no file called \(path).")
            }
            if isShard(named["rfilename"].string()) {
                return .no(code: "unsupported",
                           data: .obj([("reason", .string("sharded_model")),
                                       ("file", named["rfilename"])]),
                           message: "That file is one shard of a split model, and an entry names " +
                                    "a single file.")
            }
            return .ok(named)
        }

        let whole = available.filter { !isShard($0["rfilename"].string()) }
        if let prefer {
            let token = prefer.lowercased()
            let matches = whole.filter { $0["rfilename"].string().lowercased().contains(token) }
            if matches.isEmpty {
                let shardedOnly = available.filter {
                    $0["rfilename"].string().lowercased().contains(token)
                }
                if !shardedOnly.isEmpty {
                    return .no(code: "unsupported",
                               data: .obj([("reason", .string("sharded_model")),
                                           ("prefer", .string(prefer))]),
                               message: "Every \(prefer) file in that repository is a split model.")
                }
                return .no(code: "no_matching_file",
                           data: .obj([("prefer", .string(prefer)),
                                       ("available", .of(whole.map { $0["rfilename"].string() }))]),
                           message: "No file in that repository matches \(prefer).")
            }
            let sorted = matches.sorted { a, b in
                let an = a["rfilename"].string(), bn = b["rfilename"].string()
                if an.count != bn.count { return an.count < bn.count }
                return an < bn
            }
            return .ok(sorted[0])
        }

        if whole.count == 1 { return .ok(whole[0]) }
        if whole.isEmpty {
            return .no(code: "no_matching_file", data: .obj([("available", .array([]))]),
                       message: "That repository publishes no GGUF file this build can serve.")
        }
        return .no(code: "ambiguous_file",
                   data: .obj([("available", .of(whole.map { $0["rfilename"].string() }))]),
                   message: "That repository publishes several GGUF files. Name one, or pass a " +
                            "prefer like \"Q4_K_M\".")
    }

    // MARK: - what the FILE says

    public struct GgufFacts: Sendable {
        public let architecture: String?
        public let parameters: Double?
        public let contextLength: Int?
        public let blockCount: Int?
        public let headCountKv: Int?
        public let headDim: Int?
        /// `<arch>.pooling_type`, when the file declares one ABOVE zero. Zero is
        /// the vocabulary's own "no pooling", so it is read as absence rather
        /// than as a value - which is why it rides through the same
        /// positive-only `positive` every other fact does.
        public let pooling: Double?

        public init(architecture: String?, parameters: Double?, contextLength: Int?,
                    blockCount: Int?, headCountKv: Int?, headDim: Int?, pooling: Double? = nil) {
            self.architecture = architecture
            self.parameters = parameters
            self.contextLength = contextLength
            self.blockCount = blockCount
            self.headCountKv = headCountKv
            self.headDim = headDim
            self.pooling = pooling
        }
    }

    private static func positive(_ value: JSON) -> Double? {
        guard case .number(let n) = value, n.isFinite, n > 0 else { return nil }
        return n
    }

    /// Normalises the raw header table. Everything except `general.*` is
    /// namespaced by the architecture the FILE declares, so the architecture is
    /// read first and the rest is read through it.
    public static func ggufFacts(_ header: JSON) -> GgufFacts? {
        guard header.isObject else { return nil }
        let arch = header["general.architecture"].stringOrNull
        func at(_ suffix: String) -> Double? {
            guard let arch else { return nil }
            return positive(header["\(arch).\(suffix)"])
        }
        let embedding = at("embedding_length")
        let heads = at("attention.head_count")
        var headDim = at("attention.key_length")
        if headDim == nil, let embedding, let heads, heads > 0 {
            headDim = (embedding / heads).rounded()
        }
        return GgufFacts(
            architecture: arch,
            parameters: positive(header["general.parameter_count"]),
            contextLength: at("context_length").map { Int($0) },
            blockCount: at("block_count").map { Int($0) },
            headCountKv: (at("attention.head_count_kv") ?? heads).map { Int($0) },
            headDim: headDim.map { Int($0) },
            pooling: at("pooling_type"))
    }

    // MARK: - what KIND of model this is

    /// Architecture -> category, and the table is EVIDENCE rather than
    /// recollection.
    ///
    /// It is exactly what the shipped catalog's eleven rows say, and nothing
    /// else: three `family: "gemma3"` rows and two `family: "qwen3"` rows carry
    /// `category: "text"`, four `family: "whisper"` rows carry `category: "asr"`.
    /// `family` is the architecture slot - synthesis fills it from
    /// `general.architecture` - so those rows ARE an architecture table somebody
    /// measured and shipped.
    ///
    /// The eleventh row is why this table is not the whole answer:
    /// `qwen3-embedding-0.6b-q8_0` is `family: "qwen3"` and
    /// `category: "embedding"`. One architecture, two categories.
    ///
    /// ANYTHING NOT LISTED IS `unknown`, deliberately. Adding `llama`, `phi3`,
    /// `bert` and friends from memory would be the same class of mistake as the
    /// footprint coefficient: a plausible value nobody measured, which the rest
    /// of the system then treats as a fact.
    public static let categoryByArchitecture: [String: String] = [
        "gemma3": "text",
        "qwen3": "text",
        "whisper": "asr",
    ]

    /// The category a build records when the evidence does not name one. A REAL
    /// value, not an absence: the fallback matcher declines to substitute across
    /// it rather than guessing.
    public static let categoryUnknown = "unknown"

    public struct CategoryVerdict: Sendable {
        public let category: String
        public let from: String
    }

    /// What kind of model this file is, from the header. Two signals, in order:
    ///
    ///   1. `<arch>.pooling_type` above zero -> `embedding`. A model that pools
    ///      its hidden states into one vector is an embedding model; that is
    ///      what the key means. FIRST, because it is the only thing that
    ///      separates the two kinds of `qwen3` - verified against the real
    ///      files: Qwen3-Embedding-0.6B-Q8_0 declares `qwen3.pooling_type = 3`
    ///      and Qwen3-0.6B-Q8_0 declares no pooling key at all, while
    ///      nomic-embed-text-v1.5 declares `nomic-bert.pooling_type = 1` and
    ///      neither gemma-3-1b, gemma-3-4b nor LFM2-350M declares one.
    ///   2. the architecture table above -> its category.
    ///
    /// Otherwise `unknown` - the correct answer to a question this build has no
    /// evidence about.
    public static func categoryFor(_ facts: GgufFacts?) -> CategoryVerdict {
        if facts?.pooling != nil { return CategoryVerdict(category: "embedding", from: "pooling") }
        if let arch = facts?.architecture, let known = categoryByArchitecture[arch] {
            return CategoryVerdict(category: known, from: "architecture")
        }
        return CategoryVerdict(category: categoryUnknown, from: "unknown")
    }

    /// What a category eats and what it produces, from the same eleven rows: the
    /// `embedding` row is `outputs: ["embedding"]`, the four `asr` rows are
    /// `inputs: ["audio"]`, and text is text. An entry whose declared `inputs`
    /// contradicted its category would be refused at the seam
    /// (`unsupported_input`) for a reason that is this file's fault.
    public static func modalityFor(_ category: String) -> (inputs: [String], outputs: [String]) {
        if category == "embedding" { return (["text"], ["embedding"]) }
        if category == "asr" { return (["audio"], ["text-stream"]) }
        return (["text"], ["text-stream"])
    }

    private static func roundUp32(_ mb: Double) -> Double { max(32.0, (mb / 32.0).rounded(.up) * 32.0) }

    /// `requirements`, derived from the real file size and the GGUF header.
    ///
    /// `disk_mb` IS the file size and `mapped_mb` is what the gguf loader mmaps,
    /// which is the same number; only `footprint_mb` is an estimate. The KV cache
    /// is computed exactly from the header; the compute buffers are not in the
    /// header at all, so they are allowed for as a fraction of the weights, and
    /// the whole thing carries the shipped catalog's own 1.5x margin rounded up
    /// to 32 MB.
    ///
    /// WITHOUT a header the cache is not computable, and pretending it is zero is
    /// the one error that gets a user killed by the OOM reaper - so the headerless
    /// estimate takes the TOP of the range the eleven measured rows show (0.7x the
    /// file). It refuses models that would in fact have run, which a `predicted`
    /// verdict lets a surface offer anyway, and never accepts one that would not.
    ///
    /// AND IT IS ONLY EVER THE FIRST ANSWER. Measured against the shipped
    /// catalog's rows this lands +45%, +25% and +92% high and 39% LOW for
    /// gemma-3-4b-it-Q4_K_M - and low is the direction that gets a process
    /// killed. No coefficient fixes that, so `Fit.calibrationFootprintMb`
    /// replaces this number with the resident cost of the FIRST SUCCESSFUL LOAD
    /// on this device, recorded beside `decode_tps` in the same per-model,
    /// per-device calibration store. What stays here is the number used once, on
    /// the launch before anybody has measured anything.
    public static func deriveRequirements(bytes: Double?, facts: GgufFacts?, context: Int) -> JSON {
        let diskMb = (bytes ?? 0) > 0 ? ((bytes ?? 0) / mib).rounded(.up) : 0
        var kvMb = 0.7 * diskMb
        if let facts, let blocks = facts.blockCount, let kvHeads = facts.headCountKv,
           let dim = facts.headDim {
            kvMb = (2.0 * Double(blocks) * Double(kvHeads) * Double(dim) * Double(context) * 2.0) / mib
        }
        return .obj([
            ("footprint_mb", .number(roundUp32(1.5 * (kvMb + 0.3 * diskMb)))),
            ("mapped_mb", .number(diskMb)),
            ("disk_mb", .number(diskMb)),
        ])
    }

    // MARK: - identity

    public static func slugFor(repo: String, file: String) -> String {
        var base = file
        if let dot = file.lastIndex(of: ".") { base = String(file[file.startIndex..<dot]) }
        let owner = repo.split(separator: "/").last.map(String.init) ?? repo
        let raw = "\(owner)-\(base)".lowercased()
        var out = ""
        var lastWasDash = false
        for c in raw {
            if (c.isASCII && (c.isLetter || c.isNumber)) || c == "." || c == "-" {
                out.append(c)
                lastWasDash = (c == "-")
            } else if !lastWasDash {
                out.append("-")
                lastWasDash = true
            }
        }
        return out
    }

    // MARK: - the synthesis

    /// LOWERCASE hex only, and the length is exact. Anything else is not a
    /// commit or a digest, whatever the registry called it.
    private static func isLowerHex(_ text: String, _ length: Int) -> Bool {
        text.count == length && text.allSatisfy { c in
            c.isASCII && c.isHexDigit && !c.isUppercase
        }
    }

    /// - Parameters:
    ///   - registry: the APP's declared templates
    ///   - info: the registry's answer, UNTRUSTED
    ///   - header: what the FILE said, when it could be read
    ///   - requireLicense: the authoring tool's stance; the runtime records
    ///     `unknown` instead and lets the surface refuse
    public static func synthesize(ref: SourceRef, registry: JSON, info: JSON, file: JSON,
                                  header: JSON = .null, id: String? = nil,
                                  requireLicense: Bool = false,
                                  servingContext: Int = defaultServingContext) -> Synth<JSON> {
        // 1. The revision must be an immutable commit.
        let commit = info["sha"].string().lowercased()
        if !isLowerHex(commit, 40) {
            return .no(code: "revision_not_immutable",
                       data: .obj([("repo", .string(ref.repo)), ("sha", info["sha"])]),
                       message: "That repository did not resolve to a commit, and a moving " +
                                "revision is never stored.")
        }

        let path = file["rfilename"].string()
        if !isRelativePath(path) || path.split(separator: "/").contains("..") {
            return .no(code: "source_malformed", data: .obj([("file", .string(path))]),
                       message: "That file path is not one this build will store.")
        }
        guard let format = formatFor(path) else {
            return .no(code: "unsupported",
                       data: .obj([("reason", .string("format_not_carried")), ("file", .string(path))]),
                       message: "\(path) is not a format this build carries (gguf).")
        }

        // 2. The licence is the repo's, not the adder's.
        let declaredLicense = info["cardData"]["license"].stringOrNull
        if declaredLicense == nil && requireLicense {
            return .no(code: "license_unknown", data: .obj([("repo", .string(ref.repo))]),
                       message: "\(ref.repo) declares no licence.")
        }

        // 3. A digest is a CLAIM; a malformed one is dropped.
        let claimed = file["lfs"]["sha256"].stringOrNull?.lowercased()
        let digest: String? = claimed.flatMap { isLowerHex($0, 64) ? $0 : nil }
        let bytes = positive(file["lfs"]["size"]) ?? positive(file["size"])

        // 4. The file outranks the registry on anything the bytes can answer.
        let facts = ggufFacts(header)
        let registryContext = positive(info["gguf"]["context_length"]).map { Int($0) }
        let trained = facts?.contextLength ?? registryContext
        let contextFrom = facts?.contextLength != nil ? "file"
            : (registryContext != nil ? "registry" : "default")
        let serving = trained.map { min(servingContext, $0) } ?? servingContext
        let registryFamily = info["gguf"]["architecture"].stringOrNull
            ?? info["config"]["model_type"].stringOrNull
        let family = facts?.architecture ?? registryFamily
        let familyFrom = facts?.architecture != nil ? "file"
            : (registryFamily != nil ? "registry" : "unknown")

        let name = path.split(separator: "/").last.map(String.init) ?? path
        let url = expand(registry["file"].string(),
                         ["repo": ref.repo, "commit": commit, "path": path])

        // WHAT KIND of model this is, from the same bytes. It used to be the
        // literal "text" on every entry, which made a Whisper GGUF or an
        // embedding model a chat model as far as everything downstream could
        // tell - and the fallback matcher, which offers "another model of the
        // same kind", would answer a refused speech model with something that
        // cannot hear.
        let kind = categoryFor(facts)
        let modality = modalityFor(kind.category)

        var provenance = JSONObject()
        provenance.set("revision", .string("registry"))
        provenance.set("bytes", .string(bytes == nil ? "unknown" : "registry"))
        provenance.set("sha256", .string(digest != nil ? "registry"
                                          : (claimed != nil ? "discarded_malformed" : "none")))
        provenance.set("license", .string(declaredLicense != nil ? "repo_card" : "unknown"))
        provenance.set("family", .string(familyFrom))
        provenance.set("category", .string(kind.from))
        provenance.set("context_length", .string(contextFrom))
        provenance.set("parameters", .string(facts?.parameters != nil ? "file" : "unknown"))
        provenance.set("requirements", .string(facts?.blockCount != nil ? "derived_from_header"
                                                                       : "estimated_from_size"))

        var fileFields = JSONObject()
        fileFields.set("name", .string(name))
        if let bytes { fileFields.set("bytes", .number(bytes)) }
        if let digest { fileFields.set("sha256", .string(digest)) }
        fileFields.set("urls", .array([.string(url)]))

        var license = JSONObject()
        license.set("id", .string(declaredLicense ?? "unknown"))
        if let page = registry["page"].stringOrNull {
            license.set("url", .string(expand(page, ["repo": ref.repo, "commit": commit])))
        }

        var origin = JSONObject()
        origin.set("added", .bool(true))
        origin.set("registry", .string(ref.scheme))
        origin.set("source", .string(ref.path != nil ? "\(ref.scheme):\(ref.repo)/\(ref.path!)"
                                                     : "\(ref.scheme):\(ref.repo)"))
        origin.set("repo", .string(ref.repo))
        origin.set("revision", .string(commit))
        origin.set("provenance", .object(provenance))

        var entry = JSONObject()
        entry.set("schema_version", .number(1))
        entry.set("id", .string(id ?? slugFor(repo: ref.repo, file: name)))
        let owner = ref.repo.split(separator: "/").last.map(String.init) ?? ref.repo
        entry.set("name", .string("\(owner) (\(name))"))
        if let family { entry.set("family", .string(family)) }
        entry.set("category", .string(kind.category))
        entry.set("engine", .string("gguf"))
        entry.set("format", .string(format))
        entry.set("status", .string("active"))
        entry.set("requires", .obj([("abi", .number(1))]))
        entry.set("files", .array([.object(fileFields)]))
        entry.set("license", .object(license))
        let languages = info["cardData"]["language"]
        if case .array = languages {
            entry.set("languages", languages)
        } else if let one = languages.stringOrNull {
            entry.set("languages", .array([.string(one)]))
        }
        entry.set("inputs", .of(modality.inputs))
        entry.set("outputs", .of(modality.outputs))
        entry.set("context_length", .number(Double(serving)))
        if let trained { entry.set("context_length_max", .number(Double(trained))) }
        if let parameters = facts?.parameters { entry.set("parameters", .number(parameters)) }
        entry.set("requirements", deriveRequirements(bytes: bytes, facts: facts, context: serving))
        entry.set("origin", .object(origin))
        if digest == nil {
            entry.set("_note", .string(
                "The registry published no usable digest for this file, so the device pins one on " +
                "first download and verifies against it forever after."))
        }
        return .ok(.object(entry))
    }
}

/// Collision-free public spellings for application targets that also import the `DespiaAI`
/// engine class. Swift can otherwise resolve `DespiaAI.Catalog` and `DespiaAI.SourceRef`
/// against that class instead of this package module.
public typealias DespiaAICatalog = Catalog
public typealias DespiaAISourceRef = SourceRef
