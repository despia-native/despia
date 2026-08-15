//
//  DespiaAI.swift - the Swift face of the C ABI.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  Thin by design. Everything here is marshalling: JSON in, JSON out, and one
//  callback. The policy layer - catalog, fit, routing, the tool loop, approvals,
//  delivery - lives above this in Host.swift, and the conformance corpus is what
//  says the Swift host and the Kotlin and TypeScript hosts all agreed.
//
//  All eleven ABI entry points are bound here:
//
//    abi_version · capabilities · free · open · close · load_model ·
//    unload_model · request · sync · cancel · last_error
//
//  THE THREADING CONTRACT (despia_ai.h, and it is part of the ABI):
//
//    * Events for a context arrive on ONE engine-owned worker thread, which
//      Swift has never seen. Nothing in this file assumes otherwise: the
//      per-request sink is an immutable object whose only mutable state is the
//      caller's handler, and the registry that owns the sinks is guarded by an
//      NSLock that both the caller thread and the worker take.
//    * From inside the callback only `cancel` and `lastError` are legal on that
//      context. `stream`'s termination handler calls exactly `cancel`, and
//      nothing else re-enters.
//    * The callback must not block, so it does no work of its own beyond
//      parsing one envelope and handing it to the caller's closure.
//    * `close` joins the worker, so no callback can arrive after it returns.
//      That is what makes the sink teardown in `close()` safe: at that point
//      nothing can be mid-delivery.
//
//  OWNERSHIP. Two pointer kinds cross this seam and they are freed differently.
//  `capabilities()` returns a CALLER-OWNED string, released with
//  `despia_ai_free`. `lastError()` returns a CONTEXT-OWNED string valid only
//  until the next call on that context - it is copied immediately and never
//  freed. The per-request sink is retained on behalf of C and released exactly
//  once, either on the terminal event or in `close()`.
//
//  THIS FILE TYPE-CHECKS ON LINUX, and so does every other source in this target.
//  The claim that Swift cannot be checked in this tree was true of the MODULE's
//  Swift, which imports UIKit, and was then repeated about the PACKAGE's Swift,
//  which imports only Foundation and Dispatch. They are different questions.
//
//    swiftc -typecheck -swift-version 5 -I <dir with a modulemap for
//        engine/include/despia_ai.h> bindings/swift/Sources/DespiaAI/*.swift
//
//  A hand-written module map over the C header is all the C side needs, because
//  the header is plain C with no Apple dependency. Apple-only behaviour still
//  rides the mac lanes; what no longer rides them is "does this parse and type
//  check", which is where most mistakes live and which cost nothing to answer.
//  The C ABI itself is tested natively by engine/test/abi_test.cpp anywhere
//  clang runs.
//

import Dispatch
import Foundation

#if canImport(DespiaAICore)
import DespiaAICore
#endif

/// A typed error crossing the seam. Every failure has a code; `message` is for
/// humans and never for branching.
public struct DespiaAIError: Error, Sendable, Equatable {
    public let code: String
    public let message: String?

    public init(code: String, message: String? = nil) {
        self.code = code
        self.message = message
    }

    /// Builds an error from the ABI's `{ "code": …, "message": … }` document,
    /// falling back to a named code when the context had nothing to say.
    init(json: String?, fallbackCode: String, fallbackMessage: String? = nil) {
        guard let json, let parsed = JSON.parseOrNull(json) else {
            self.code = fallbackCode
            self.message = fallbackMessage ?? json
            return
        }
        self.code = parsed["code"].string(fallbackCode)
        self.message = parsed["message"].stringOrNull ?? fallbackMessage
    }
}

/// A typed output block. The vocabulary is OPEN: a block type this build has
/// never heard of is ignored with a notice rather than crashing the stream,
/// which is what lets a new model shape arrive as data.
public struct Block: Sendable, Equatable {
    public let type: String
    public let fields: JSON

    public init(_ fields: JSON) {
        self.type = fields["type"].string()
        self.fields = fields
    }

    public var text: String { fields["text"].string() }

    /// Binary NEVER rides JSON. An audio, image or file block carries a URL and
    /// the native side owns the bytes.
    public var url: URL? { fields["url"].stringOrNull.flatMap(URL.init(string:)) }
}

/// One event on a request's stream, rid-correlated by the envelope.
public enum Event: Sendable {
    case token(seq: Int, delta: Block)
    case sync(seq: Int, snapshot: [Block])
    case tool(id: String, name: String, arguments: JSON, status: String)
    case routing(task: String?, model: String?, reason: String)
    case complete(snapshot: [Block], usage: JSON, cancelled: Bool)
    case failed(DespiaAIError)
}

public struct Configuration: Sendable {
    /// Where the crash-quarantine marker lives. Without it a model that takes
    /// the process down cannot be detected on the next launch, so pass one.
    public var stateDir: URL?
    public var backends: [String]?

    /// The residency budget: a ceiling on the SUM of the loaded models'
    /// `runtime_mb`. When a load would exceed it the least recently used model
    /// is unloaded first.
    ///
    /// It counts what the PROCESS is charged - KV cache, compute buffers,
    /// runtime structures - and never the mmapped weights, which are clean
    /// file-backed pages the kernel reclaims by itself. Derive it from the same
    /// per-process limit you would compare a model's footprint against
    /// (`os_proc_available_memory()` on iOS); a budget in one quantity checked
    /// against a total in another evicts constantly or never, and both look
    /// like the feature working.
    ///
    /// `nil` and `0` both mean UNBOUNDED - nothing is evicted for memory. That
    /// is the right default for a desktop and the wrong one for a phone.
    public var maxRuntimeBytes: UInt64?

    public init(stateDir: URL? = nil, backends: [String]? = nil,
                maxRuntimeBytes: UInt64? = nil) {
        self.stateDir = stateDir
        self.backends = backends
        self.maxRuntimeBytes = maxRuntimeBytes
    }

    var json: JSON {
        var out = JSONObject()
        out.set("schema_version", .number(1))
        if let stateDir { out.set("state_dir", .string(stateDir.path)) }
        if let backends { out.set("backends", .of(backends)) }
        if let maxRuntimeBytes {
            var limits = JSONObject()
            limits.set("max_runtime_bytes", .number(Double(maxRuntimeBytes)))
            out.set("limits", .object(limits))
        }
        return .object(out)
    }
}

/// What THIS build carries. Ask it; never assume. A consumer that hardcodes an
/// engine id or a feature breaks on the first build that ships without it.
public struct Capabilities: Sendable, Equatable {
    public let abi: Int
    public let version: String
    public let engines: [String]
    public let formats: [String]
    public let modalities: [String]
    public let dialects: [String]
    public let features: [String]
    /// The whole manifest, including limits and anything a newer build added.
    /// Must-ignore cuts both ways: unknown keys survive here rather than being
    /// dropped by this struct's field list.
    public let raw: JSON

    init(_ raw: JSON) {
        self.abi = raw["abi"].int()
        self.version = raw["version"].string()
        self.engines = raw["engines"].strings
        self.formats = raw["formats"].strings
        self.modalities = raw["modalities"].strings
        self.dialects = raw["dialects"].strings
        self.features = raw["features"].strings
        self.raw = raw
    }
}

// MARK: - the per-request sink

/// Holds one request's live delivery closure. Created on the caller's thread,
/// used on the engine's worker thread, and released exactly once.
private final class RequestSink {
    let registry: SinkRegistry
    private let handler: (JSON) -> Void

    init(registry: SinkRegistry, handler: @escaping (JSON) -> Void) {
        self.registry = registry
        self.handler = handler
    }

    /// Returns true when the envelope was terminal, which is the ONLY signal
    /// that no further callback will arrive for this request.
    func receive(_ payload: UnsafePointer<CChar>?) -> Bool {
        guard let payload, let envelope = JSON.parseOrNull(cStringToSwift(payload)) else { return false }
        handler(envelope)
        return envelope["final"].bool()
    }
}

/// The set of sinks C currently owns a retain on. Separate from the context so a
/// sink can retire itself without reaching back into an object that may be
/// deinitialising.
private final class SinkRegistry {
    private let lock = NSLock()
    private var live: Set<UnsafeMutableRawPointer> = []

    func remember(_ token: UnsafeMutableRawPointer) {
        lock.lock(); defer { lock.unlock() }
        live.insert(token)
    }

    /// True when THIS call is the one that removed the token, so exactly one
    /// caller performs the matching release.
    func forget(_ token: UnsafeMutableRawPointer) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live.remove(token) != nil
    }

    func drain() -> [UnsafeMutableRawPointer] {
        lock.lock(); defer { lock.unlock() }
        let all = Array(live)
        live.removeAll()
        return all
    }
}

/// Copies a NUL-terminated C string. Deliberately not `String(cString:)`, which
/// is deprecated on current toolchains, and deliberately a COPY: `lastError`
/// hands back memory the context owns only until its next call.
private func cStringToSwift(_ raw: UnsafePointer<CChar>) -> String {
    let length = Int(strlen(raw))
    return raw.withMemoryRebound(to: UInt8.self, capacity: length) { bytes in
        String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
    }
}

/// The C entry point every request is submitted with. It is a top-level
/// `@convention(c)` value on purpose: a C function pointer can capture nothing,
/// so the request's identity travels in `user_data` and nowhere else.
private let despiaEventBridge: @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void = {
    payload, user in
    guard let user else { return }
    let handle = Unmanaged<RequestSink>.fromOpaque(user)
    // A retain for the duration of this call, balanced in the defer. Without it
    // a terminal event could drop the last reference while the object is still
    // being used by this very frame.
    _ = handle.retain()
    defer { handle.release() }
    let sink = handle.takeUnretainedValue()
    if sink.receive(payload), sink.registry.forget(user) {
        handle.release()   // the retain taken on C's behalf at submit time
    }
}

// MARK: - the context

/// An engine context. One context is driven by ONE caller thread, per the ABI;
/// open a second context rather than sharing one.
public final class DespiaAI: @unchecked Sendable {
    private let lock = NSLock()
    private var ctx: UnsafeMutableRawPointer?
    private let sinks = SinkRegistry()

    public init(config: Configuration = Configuration()) throws {
        guard let opened = despia_ai_open(config.json.render()) else {
            // There is no context to ask, so the failure is the GLOBAL error.
            throw DespiaAI.globalError(fallbackCode: "invalid_config",
                                       fallbackMessage: "the context could not be opened")
        }
        ctx = opened
    }

    deinit { close() }

    /// Idempotent. Joins the engine's worker, so no callback can arrive after
    /// this returns - which is what makes the sink teardown below safe.
    public func close() {
        lock.lock()
        let handle = ctx
        ctx = nil
        lock.unlock()
        guard let handle else { return }
        despia_ai_close(handle)
        // The worker is joined. Anything still registered belongs to a request
        // that was cancelled or dropped before it produced a terminal event.
        for token in sinks.drain() {
            Unmanaged<RequestSink>.fromOpaque(token).release()
        }
    }

    private func context() throws -> UnsafeMutableRawPointer {
        lock.lock(); defer { lock.unlock() }
        guard let ctx else {
            throw DespiaAIError(code: "closing", message: "this context is closed")
        }
        return ctx
    }

    // MARK: - self-description

    public static var abiVersion: UInt32 { despia_ai_abi_version() }

    /// The build manifest as the ABI reports it. The returned pointer is
    /// caller-owned, so it is freed here.
    public static func capabilitiesJSON() -> JSON {
        guard let raw = despia_ai_capabilities() else { return .null }
        defer { despia_ai_free(UnsafeMutableRawPointer(mutating: raw)) }
        return JSON.parseOrNull(cStringToSwift(raw)) ?? .null
    }

    public static func capabilities() -> Capabilities { Capabilities(capabilitiesJSON()) }

    // MARK: - models

    /// Loads a model from its CATALOG ENTRY, verbatim. The engine reads what it
    /// needs and ignores the rest, so a newer catalog does not need a newer
    /// binding to pass an entry through.
    public func load(entry: JSON) throws {
        let ctx = try context()
        if despia_ai_load_model(ctx, entry.render()) != 0 {
            throw lastError(fallbackCode: "load_failed", fallbackMessage: "the model was refused")
        }
    }

    public func unload(model id: String) throws {
        let ctx = try context()
        if despia_ai_unload_model(ctx, id) != 0 {
            throw lastError(fallbackCode: "unknown_model", fallbackMessage: "no such model is loaded")
        }
    }

    // MARK: - requests

    /// Submits a request and returns the ENGINE's id for it. Events reach
    /// `onEvent` on the engine's worker thread; it must not block.
    @discardableResult
    public func submit(_ payload: JSON, onEvent: @escaping (JSON) -> Void) throws -> Int32 {
        let ctx = try context()
        var request = payload.fields
        request.set("schema_version", .number(1))

        let sink = RequestSink(registry: sinks, handler: onEvent)
        let token = Unmanaged.passRetained(sink).toOpaque()
        sinks.remember(token)

        let rid = despia_ai_request(ctx, JSON.object(request).render(), despiaEventBridge, token)
        if rid < 0 {
            if sinks.forget(token) { Unmanaged<RequestSink>.fromOpaque(token).release() }
            throw lastError(fallbackCode: "invalid_request", fallbackMessage: "the request was refused")
        }
        return rid
    }

    /// Cancels a request. Idempotent, and legal from inside the event callback.
    @discardableResult
    public func cancel(request id: Int32) -> Bool {
        lock.lock(); let ctx = self.ctx; lock.unlock()
        guard let ctx else { return false }
        return despia_ai_cancel(ctx, id) == 0
    }

    /// Asks for a full-snapshot `sync` on a live request - how a surface that
    /// attached mid-stream catches up on the deltas it missed.
    @discardableResult
    public func sync(request id: Int32) -> Bool {
        lock.lock(); let ctx = self.ctx; lock.unlock()
        guard let ctx else { return false }
        return despia_ai_sync(ctx, id) == 0
    }

    /// Drives a request to its terminal event and returns every envelope in
    /// production order.
    ///
    /// A consumer WAITS for `final` rather than assuming timing. The timeout is
    /// a liveness backstop, not a schedule: a request that is deliberately
    /// suspended mid-stream (the corpus's `pause`) never settles, and the caller
    /// gets what arrived rather than a hang.
    @discardableResult
    public func drain(_ payload: JSON, timeoutMs: Int = 5_000,
                      onEvent: ((JSON) -> Void)? = nil) throws -> [JSON] {
        let collected = EnvelopeBuffer()
        let settled = DispatchSemaphore(value: 0)
        try submit(payload) { envelope in
            collected.append(envelope)
            onEvent?(envelope)
            if envelope["final"].bool() { settled.signal() }
        }
        _ = settled.wait(timeout: .now() + .milliseconds(timeoutMs))
        return collected.all()
    }

    /// Submits a request and streams its events. Cancelling the consuming task
    /// cancels the request, which is legal at any point including from inside
    /// delivery.
    public func stream(request payload: JSON) -> AsyncThrowingStream<Event, Error> {
        AsyncThrowingStream { continuation in
            let rid: Int32
            do {
                rid = try self.submit(payload) { envelope in
                    let data = envelope["data"]
                    switch envelope["event"].string() {
                    case "token":
                        continuation.yield(.token(seq: data["seq"].int(),
                                                  delta: Block(data["delta"])))
                    case "sync":
                        continuation.yield(.sync(seq: data["seq"].int(),
                                                 snapshot: data["snapshot"].items.map(Block.init)))
                    case "tool":
                        continuation.yield(.tool(id: data["id"].string(),
                                                 name: data["name"].string(),
                                                 arguments: data["arguments"],
                                                 status: data["status"].string()))
                    case "routing":
                        continuation.yield(.routing(task: data["task"].stringOrNull,
                                                    model: data["model"].stringOrNull,
                                                    reason: data["reason"].string()))
                    case "complete":
                        continuation.yield(.complete(snapshot: data["snapshot"].items.map(Block.init),
                                                     usage: data["usage"],
                                                     cancelled: data["cancelled"].bool()))
                    case "error":
                        continuation.yield(.failed(DespiaAIError(
                            code: data["code"].string("unknown"),
                            message: data["message"].stringOrNull)))
                    default:
                        // An event type this build has never heard of is
                        // IGNORED, not fatal: must-ignore applies to the stream
                        // exactly as it does to the envelope.
                        break
                    }
                    if envelope["final"].bool() { continuation.finish() }
                }
            } catch {
                continuation.finish(throwing: error)
                return
            }
            // Only `cancel` is legal here: termination can run on the engine's
            // worker (when `finish()` above is what triggered it), and cancel is
            // one of the two calls the ABI permits from that thread.
            continuation.onTermination = { [weak self] _ in
                self?.cancel(request: rid)
            }
        }
    }

    /// Text to phonemes, through a loaded G2P pack.
    ///
    /// `fallback` is what happens to a word the pack's dictionary does not hold:
    /// `lts` guesses with the pack's letter-to-sound rules, `spell` reads it out,
    /// `refuse` emits nothing for it and says so, and `defer` guesses AND marks
    /// the sentence so the caller can hand it to the platform synthesizer. There
    /// is no value that removes the word, and the engine rejects one by name.
    /// Every token that comes back says where its pronunciation came from.
    public func phonemize(model: String, text: String,
                          fallback: String = "lts") -> AsyncThrowingStream<Event, Error> {
        var options = JSONObject()
        options.set("text", .string(text))
        options.set("fallback", .string(fallback))
        var request = JSONObject()
        request.set("kind", .string("phonemize"))
        request.set("model", .string(model))
        request.set("options", .object(options))
        return stream(request: .object(request))
    }

    /// Convenience for the common shape.
    public func completion(model: String, messages: [JSON],
                           tools: [JSON]? = nil) -> AsyncThrowingStream<Event, Error> {
        var request = JSONObject()
        request.set("kind", .string("completion"))
        request.set("model", .string(model))
        request.set("messages", .array(messages))
        if let tools { request.set("tools", .array(tools)) }
        return stream(request: .object(request))
    }

    // MARK: - errors

    /// The context's last error, COPIED before anything else can invalidate it.
    private func lastError(fallbackCode: String, fallbackMessage: String) -> DespiaAIError {
        lock.lock(); let ctx = self.ctx; lock.unlock()
        guard let ctx, let raw = despia_ai_last_error(ctx) else {
            return DespiaAIError(code: fallbackCode, message: fallbackMessage)
        }
        return DespiaAIError(json: cStringToSwift(raw),
                             fallbackCode: fallbackCode, fallbackMessage: fallbackMessage)
    }

    private static func globalError(fallbackCode: String, fallbackMessage: String) -> DespiaAIError {
        guard let raw = despia_ai_last_error(nil) else {
            return DespiaAIError(code: fallbackCode, message: fallbackMessage)
        }
        return DespiaAIError(json: cStringToSwift(raw),
                             fallbackCode: fallbackCode, fallbackMessage: fallbackMessage)
    }
}

/// A lock-guarded accumulator: the worker appends, the caller reads.
private final class EnvelopeBuffer {
    private let lock = NSLock()
    private var envelopes: [JSON] = []

    func append(_ envelope: JSON) {
        lock.lock(); defer { lock.unlock() }
        envelopes.append(envelope)
    }

    func all() -> [JSON] {
        lock.lock(); defer { lock.unlock() }
        return envelopes
    }
}
