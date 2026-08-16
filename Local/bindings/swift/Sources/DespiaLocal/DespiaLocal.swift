//
//  DespiaLocal.swift - the Swift face of the C ABI.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  A MARSHALLER, not an implementation. This file used to be a SECOND store: it
//  imported SQLite3 and drove the platform's own libsqlite3 with its own SQL,
//  which meant Apple ran different code from every other lane, the 26 fixtures in
//  OpenSource/Conformance/local never touched it, and sqlite-vec - the reason the
//  vector actions exist at all - was simply absent, because the system SQLite
//  carries no vector extension. It now binds the SAME library Kotlin binds,
//  through the same eight symbols:
//
//    despia_local_abi_version · despia_local_capabilities · despia_local_free ·
//    despia_local_open · despia_local_close · despia_local_reopen ·
//    despia_local_call · despia_local_last_error
//
//  The twin of bindings/kotlin-jvm/.../Store.kt, call site for call site. Where
//  Kotlin reaches the library through JNI, this reaches it through the C target
//  DespiaLocalCore, which compiles engine/src plus the vendored SQLite and
//  sqlite-vec - so `vectors` is present in capabilities on this lane, not absent.
//
//  What this file DOES own is the shape of the call site, and that is where the
//  embedding provenance is enforced: `indexUpsert`, `indexSearch` and
//  `indexReindex` take an `Embedding` as a REQUIRED parameter carrying the
//  (model, dimension, revision) triple, so a caller cannot write or query a vector
//  without saying which embedder produced it. Omitting it is a compile error here
//  rather than a mystery ranking later.
//
//  OWNERSHIP, which the header states and this file obeys exactly:
//
//    * `despia_local_call` returns a CALLER-owned pointer. It is parsed and freed
//      with `despia_local_free` in the same scope, through a `defer`, so an early
//      return cannot leak it.
//    * `despia_local_capabilities` returns a CALLER-owned pointer, freed the same
//      way.
//    * `despia_local_last_error` returns a HANDLE-owned pointer valid only until
//      the next call on that handle. It is COPIED immediately and never freed;
//      freeing it would be a double free.
//
//  THE THREADING CONTRACT (despia_local.h, and it is part of the ABI): one handle
//  is driven by ONE caller thread at a time. Savepoints are per-CONNECTION state,
//  so two threads interleaving transactional scopes on one handle would unwind
//  each other's work. This type therefore makes no thread-safety claim - open two
//  stores instead, they are cheap, and WAL means a reader never blocks the writer.
//  The module layer above owns the queue that makes "one caller at a time" true.
//
//  Compile-pending in this tree: Swift does not build in the monorepo's linting
//  environment, so this rides the mac lanes. The C ABI it wraps is tested natively
//  by engine/test/abi_test.cpp on every platform that can run clang, and the
//  SEMANTICS are pinned by OpenSource/Conformance/local, which
//  Tests/DespiaLocalConformanceTests runs against this very file.
//

import Foundation

#if canImport(DespiaLocalCore)
import DespiaLocalCore
#endif

/// A typed failure from the store. `code` is what a caller branches on; `detail`
/// is for humans and `data` carries the specifics - for an `embedding_mismatch`,
/// the reason, the two sides and the index to reindex.
public struct LocalError: Error, Sendable, Equatable {
    public let code: String
    public let detail: String
    public let data: Json

    public init(_ code: String, _ detail: String = "", data: Json = .object(JsonObject())) {
        self.code = code
        self.detail = detail
        self.data = data
    }

    /// `nil` rather than an empty string when the store had nothing to add, so a
    /// caller forwarding this to a bus does not publish a blank message.
    public var message: String? { detail.isEmpty ? nil : detail }

    /// The wire form, which is what a fixture compares against.
    public var wire: Json {
        var fields = JsonObject()
        fields.set("code", .string(code))
        if !detail.isEmpty { fields.set("message", .string(detail)) }
        if !data.isNull, !data.fields.isEmpty { fields.set("data", data) }
        return .object(fields)
    }

    /// Builds an error from the ABI's `{ "code", "message", "data" }` document.
    /// A handle that failed without saying why still produces a typed error,
    /// because "it returned NULL and said nothing" is not something a caller can
    /// act on.
    static func from(_ raw: String?) -> LocalError {
        guard let raw, let parsed = Json.parseOrNull(raw) else {
            return LocalError("call_failed", "the store failed without reporting why")
        }
        return LocalError(parsed["code"].string("call_failed"),
                         parsed["message"].string(),
                         data: parsed["data"])
    }
}

/// The provenance of a vector: which embedder produced it, at what width, at
/// which revision.
///
/// A value type rather than three loose arguments because the three travel
/// together always - an index records them at creation and every later write and
/// query is checked against them. A vector written by one model and searched by
/// another returns plausible nonsense at full confidence, which is the single
/// worst failure mode a local RAG stack has; carrying the triple is what turns it
/// into a typed error with a named fix.
public struct Embedding: Sendable, Equatable {
    /// The ABI's declared ceiling; capabilities reports it under
    /// `limits.max_dimension` and a build that lowers it says so there.
    public static let maxDimension = 8192

    public let model: String
    public let dimension: Int
    public let revision: String?

    /// Throwing, not trapping. A nameless embedder or an impossible width is a
    /// caller's mistake, and the honest answer to it is the same typed
    /// `invalid_embedding` the store would give - not a crash.
    public init(model: String, dimension: Int, revision: String? = nil) throws {
        guard !model.isEmpty else {
            throw LocalError("invalid_embedding", "an embedding names its model")
        }
        guard dimension >= 1, dimension <= Embedding.maxDimension else {
            throw LocalError("invalid_embedding",
                            "a dimension is between 1 and \(Embedding.maxDimension)")
        }
        self.model = model
        self.dimension = dimension
        self.revision = revision
    }

    public var json: Json {
        var fields = JsonObject()
        fields.set("model", .string(model))
        fields.set("dimension", .number(Double(dimension)))
        if let revision { fields.set("revision", .string(revision)) }
        return .object(fields)
    }

    /// Reads the triple out of a JSON object. `nil` when the document does not
    /// carry one at all; throws when it carries one that cannot be true.
    public static func from(_ value: Json) throws -> Embedding? {
        guard let model = value["model"].stringOrNull, value["dimension"].isNumber else {
            return nil
        }
        return try Embedding(model: model,
                             dimension: value["dimension"].int(),
                             revision: value["revision"].stringOrNull)
    }
}

/// One open store: one file, one connection, one caller thread.
///
/// The Kotlin twin is `com.despia.local.Store`; the name differs because this type
/// is the Swift package's namesake and its callers say `DespiaLocal(directory:)`.
public final class DespiaLocal {

    /// The one thing this type owns. Nothing above it ever sees a raw pointer,
    /// which is what keeps "using a handle after closing it is undefined" a
    /// statement about C rather than a hazard for a Swift caller.
    private var handle: UnsafeMutableRawPointer?

    public init(directory: URL, readonly: Bool = false) throws {
        var config = JsonObject()
        config.set("schema_version", .number(1))
        config.set("directory", .string(directory.path))
        if readonly { config.set("readonly", .bool(true)) }
        guard let opened = despia_local_open(Json.object(config).render()) else {
            // There is no handle to ask, so the failure is the GLOBAL one.
            throw DespiaLocal.globalError()
        }
        handle = opened
    }

    deinit { close() }

    /// Idempotent. Any transaction still open is rolled back by SQLite, which is
    /// the honest outcome: an unreleased savepoint is an unfinished scope.
    public func close() {
        guard let open = handle else { return }
        handle = nil
        despia_local_close(open)
    }

    /// Closes and reopens the file WITHOUT the graceful path - what happens when
    /// the process dies. A real close-and-reopen, not a simulation, which is why
    /// the durability fixtures can be trusted: committed data comes back and an
    /// open savepoint's writes do not.
    public func crash() throws {
        let open = try alive()
        if despia_local_reopen(open) != 0 { throw lastError() }
    }

    /// The funnel. Every typed helper below is this call with its arguments
    /// spelled out; an action this build does not carry answers the typed
    /// `unknown_action` rather than undefined behaviour.
    @discardableResult
    public func call(_ action: String, _ args: Json = .object(JsonObject())) throws -> Json {
        let open = try alive()
        // NULL is failure and ONLY failure - a successful action with nothing to
        // say answers `{}`.
        guard let raw = despia_local_call(open, action, args.render()) else {
            throw lastError()
        }
        defer { despia_local_free(UnsafeMutableRawPointer(raw)) }
        guard let value = Json.parseOrNull(DespiaLocal.copy(raw)) else {
            throw LocalError("call_failed", "the store answered something that is not JSON")
        }
        return value
    }

    private func alive() throws -> UnsafeMutableRawPointer {
        guard let open = handle else {
            throw LocalError("closed", "this store was closed")
        }
        return open
    }

    // MARK: - stores

    @discardableResult
    public func declareStore(_ store: String) throws -> Json {
        try call("declare", .obj([("store", .string(store))]))
    }

    @discardableResult
    public func put(_ store: String, _ key: String, _ value: Json) throws -> Json {
        try call("put", .obj([("store", .string(store)), ("key", .string(key)), ("value", value)]))
    }

    public func get(_ store: String, _ key: String) throws -> Json {
        try call("get", .obj([("store", .string(store)), ("key", .string(key))]))
    }

    @discardableResult
    public func delete(_ store: String, _ key: String) throws -> Json {
        try call("delete", .obj([("store", .string(store)), ("key", .string(key))]))
    }

    public func query(_ store: String,
                      where filter: Json = .object(JsonObject()),
                      order: Json = .array([]),
                      limit: Int = 0) throws -> Json {
        var args = JsonObject()
        args.set("store", .string(store))
        args.set("where", filter)
        args.set("order", order)
        if limit > 0 { args.set("limit", .number(Double(limit))) }
        return try call("query", .object(args))
    }

    public func stats() throws -> Json { try call("stats") }

    // MARK: - transactional scopes

    @discardableResult
    public func savepoint(_ name: String) throws -> Json {
        try call("savepoint", .obj([("name", .string(name))]))
    }

    @discardableResult
    public func release(_ name: String) throws -> Json {
        try call("release", .obj([("name", .string(name))]))
    }

    @discardableResult
    public func rollback(_ name: String) throws -> Json {
        try call("rollback", .obj([("name", .string(name))]))
    }

    // MARK: - snapshots

    @discardableResult
    public func snapshot(_ label: String) throws -> Json {
        try call("snapshot", .obj([("label", .string(label))]))
    }

    public func snapshots() throws -> Json { try call("snapshots") }

    @discardableResult
    public func restore(_ label: String) throws -> Json {
        try call("restore", .obj([("label", .string(label))]))
    }

    public func export(_ label: String) throws -> Json {
        try call("export", .obj([("label", .string(label))]))
    }

    // MARK: - vectors
    //
    // The embedding is a required parameter on every one of these, which is the
    // enforcement point on this lane: there is no overload that lets a caller
    // write a vector anonymously and no default that guesses one for them.

    @discardableResult
    public func indexUpsert(_ index: String, _ key: String, vector: [Double],
                            embedding: Embedding,
                            value: Json = .object(JsonObject())) throws -> Json {
        // Checked here as well as in the store, because the local check can name
        // the caller's own mistake before it becomes a round trip: a vector whose
        // length disagrees with its OWN declared dimension is a bug in the code
        // that produced it, not a drift between two embedders.
        if vector.count != embedding.dimension {
            throw LocalError(
                "embedding_mismatch", "the vector does not match its declared dimension",
                data: .obj([
                    ("reason", .string("dimension")),
                    ("stored", .number(Double(embedding.dimension))),
                    ("query", .number(Double(vector.count))),
                    ("reindex", .string(index)),
                ]))
        }
        return try call("index.upsert", .obj([
            ("index", .string(index)),
            ("key", .string(key)),
            ("vector", .of(vector)),
            ("embedding", embedding.json),
            ("value", value),
        ]))
    }

    /// `count` plus the embedding this index was built with - the answer to
    /// "may I search this with what I have?" without guessing.
    public func indexInfo(_ index: String) throws -> Json {
        try call("index.info", .obj([("index", .string(index))]))
    }

    public func indexSearch(_ index: String, vector: [Double], embedding: Embedding,
                            k: Int = 10) throws -> Json {
        try call("index.search", .obj([
            ("index", .string(index)),
            ("vector", .of(vector)),
            ("embedding", embedding.json),
            ("k", .number(Double(k))),
        ]))
    }

    @discardableResult
    public func indexDelete(_ index: String, _ key: String) throws -> Json {
        try call("index.delete", .obj([("index", .string(index)), ("key", .string(key))]))
    }

    /// The escape hatch an `embedding_mismatch` points at. The index adopts the
    /// new provenance wholesale, because vectors from the old embedder are not
    /// convertible - they are stale.
    @discardableResult
    public func indexReindex(_ index: String, embedding: Embedding,
                             vectors: [Json]) throws -> Json {
        try call("index.reindex", .obj([
            ("index", .string(index)),
            ("embedding", embedding.json),
            ("vectors", .array(vectors)),
        ]))
    }

    // MARK: - self-description

    /// The ABI version this build implements.
    public static var abiVersion: UInt32 { despia_local_abi_version() }

    /// What THIS build carries. A consumer reading it ASKS; it never assumes.
    /// `vectors` is absent, not empty, in a build compiled without sqlite-vec -
    /// typed absence rather than a lie about a capability.
    ///
    /// It needs no handle, so it opens none: asking what a build carries must
    /// work before, and regardless of whether, a store was ever opened.
    public static func capabilities() throws -> Json {
        guard let raw = despia_local_capabilities() else {
            throw LocalError("call_failed", "the library reported no capabilities")
        }
        // Caller-owned, so it is freed here - the header says so, and the const
        // on the return type is about the CONTENT, not about the ownership.
        defer { despia_local_free(UnsafeMutableRawPointer(mutating: raw)) }
        guard let value = Json.parseOrNull(DespiaLocal.copy(raw)) else {
            throw LocalError("call_failed", "the library reported capabilities that are not JSON")
        }
        return value
    }

    // MARK: - errors

    /// The handle's last error, COPIED before anything else can invalidate it.
    private func lastError() -> LocalError {
        guard let open = handle, let raw = despia_local_last_error(open) else {
            return LocalError("call_failed", "the store failed without reporting why")
        }
        return LocalError.from(DespiaLocal.copy(raw))
    }

    /// The last GLOBAL (open-time) error. `nil` is what the header says to pass
    /// when there is no handle to ask.
    private static func globalError() -> LocalError {
        guard let raw = despia_local_last_error(nil) else {
            return LocalError("call_failed", "the store could not be opened and said nothing")
        }
        return LocalError.from(copy(raw))
    }

    /// Copies a NUL-terminated C string. Deliberately not `String(cString:)`,
    /// which is deprecated on current toolchains, and deliberately a COPY:
    /// `last_error` hands back memory the handle owns only until its next call.
    private static func copy(_ raw: UnsafePointer<CChar>) -> String {
        let length = Int(strlen(raw))
        return raw.withMemoryRebound(to: UInt8.self, capacity: length) { bytes in
            String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
        }
    }
}
