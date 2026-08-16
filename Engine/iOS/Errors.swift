//
//  Errors.swift — the DSX error system's kernel core: the DSXError value, the error LEDGER,
//  and the AMBIENT fan-out (architecture/proposals/error-system.md, ACCEPTED v1).
//  The Kotlin twin is Engine/Android core Errors.kt; the web twin lives in bus.ts (DSXErrors).
//
//  Errors are VALUES on the bus: one shape, recorded in ONE ledger, whether they came from
//  a failed call (origin "call" — fed by Context.reportCallFailure / sendError's web-caller
//  path) or an ambient emission (origin "raised" — `dsx.error`/`dsx.fail` on the module
//  handle, where there is no call to settle). The ledger is a capped ring (the
//  KernelLogBuffer pattern with values instead of lines), ALWAYS on: appending is
//  nanoseconds, and programs — not just testers — read it (`dsx.errors`, the reactive
//  `global.dsx.*` keys, DevSettings). Names no package, imports no WebKit — a pure kernel
//  primitive per the constitution; nothing here ever throws or crashes (Article 7).
//

import Foundation

/// One recorded error — the wire shape plus ledger metadata.
public struct DSXError {
    public let code: String
    public let message: String?
    public let recoverable: Bool
    public let data: Any?
    /// the SOURCE scheme (whose error this is)
    public let scheme: String
    /// "raised" (ambient emission) | "call" (a failed bus call) | "uncaught" (a throw that
    /// unwound a markup action to the top with no catch)
    public let origin: String
    /// origin "call" only — false = fire-and-forget: the call site never saw the error
    public let delivered: Bool?
    public let at: Date

    init(code: String, message: String? = nil, recoverable: Bool = false, data: Any? = nil,
         scheme: String, origin: String, delivered: Bool? = nil) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.data = data
        self.scheme = scheme
        self.origin = origin
        self.delivered = delivered
        self.at = Date()
    }

    /// The wire form — hook payloads, the page channel, `global.dsx.lastError`. `data` and
    /// `delivered` ride only when present; `message` is an explicit null when absent (the
    /// conformance corpus pins the defaults).
    public func wire() -> [String: Any] {
        var out: [String: Any] = [
            "code": code, "message": message ?? NSNull(), "recoverable": recoverable,
            "scheme": scheme, "origin": origin,
        ]
        if let data { out["data"] = data }
        if let delivered { out["delivered"] = delivered }
        return out
    }
}

/// The error ledger: a capped structured ring, process-global like the registry.
public final class DSXErrorLedger {
    public static let shared = DSXErrorLedger()
    static let cap = 128
    private init() {}

    private let lock = NSLock()
    private var entries: [DSXError] = []
    private var total = 0

    /// Main-confined reentrancy flag for the ambient fan-out (see `reportAmbientError`) —
    /// hosted here so the free fan-out function has one obvious home for its state.
    static var ambientFanoutActive = false

    func append(_ e: DSXError) {
        lock.lock(); defer { lock.unlock() }
        entries.append(e)
        total += 1
        if entries.count > Self.cap { entries.removeFirst(entries.count - Self.cap) }
    }

    /// The retained tail, oldest → newest (snapshot).
    public func recent() -> [DSXError] { lock.lock(); defer { lock.unlock() }; return entries }

    /// Monotonic count of every error ever recorded (survives ring eviction) — the value
    /// `global.dsx.errorCount` publishes.
    public func count() -> Int { lock.lock(); defer { lock.unlock() }; return total }

    /// Dev tooling only — drops the retained tail (the monotonic count stays).
    public func clear() { lock.lock(); defer { lock.unlock() }; entries.removeAll() }
}

/// The AMBIENT fan-out (error-system.md §3.3) — `dsx.error`/`dsx.fail` on the module handle,
/// and the JSE builtin from markup actions, both land here: there is no call to settle, so
/// the error reports to the APP, deterministically and repeatably (no settle guard — the
/// property the old accidental registrar path fatally lacked):
///   1. the ledger (+ the reactive keys `global.dsx.lastError` / `global.dsx.errorCount` —
///      error state IS observable state),
///   2. `module.error` — the semantic hook sibling of the transport-level `module.callFailed`,
///   3. the page channel: `{scheme, event:"error", data:<wire>}` on the module's OWN scheme
///      plus the reserved `dsx` mirror (one global error listener per app).
/// A nested emission from inside a hook / page handler stays LOG-ONLY — hooks deliver
/// synchronously on main inside the block below, so the main-confined flag suppresses the
/// nested fan-out exactly (the same guard discipline as Context.reportCallFailure).
func reportAmbientError(scheme: String, code: String, message: String? = nil,
                        recoverable: Bool = false, data: Any? = nil,
                        origin: String = "raised") {
    var line = "[dsx.error] \(scheme) → \(code)"
    if origin == "uncaught" { line += " (uncaught)" }
    if let message { line += " — \(message)" }
    kernelLog(line)
    if Thread.isMainThread, DSXErrorLedger.ambientFanoutActive { return }   // nested → log-only
    DispatchQueue.main.async {
        DSXErrorLedger.ambientFanoutActive = true
        defer { DSXErrorLedger.ambientFanoutActive = false }
        let err = DSXError(
            code: code, message: message, recoverable: recoverable,
            data: data == nil ? nil : JSON.from(data).foundationValue,
            scheme: scheme, origin: origin)
        DSXErrorLedger.shared.append(err)
        let wire = err.wire()
        DSX.state.setPath("dsx.lastError", wire)
        DSX.state.setPath("dsx.errorCount", DSXErrorLedger.shared.count())
        ModuleRegistry.shared.dispatch("module.error", wire, .void)
        deliverErrorEnvelope(scheme: scheme, wire: wire)
        if scheme != "dsx" { deliverErrorEnvelope(scheme: "dsx", wire: wire) }
    }
}

/// One page-channel delivery — the standard out-of-band broadcast envelope (id null,
/// host ""), to every mounted surface (client-side scheme filter) AND the in-process
/// `dsx.events.on(scheme)` subscribers, exactly like Context.broadcast.
private func deliverErrorEnvelope(scheme: String, wire: [String: Any]) {
    let envelope: [String: Any] = [
        "id": NSNull(), "scheme": scheme, "host": "",
        "event": "error", "final": true, "data": wire,
    ]
    DSXMessenger().deliverBroadcast(
        DSXEgress(target: "*", scheme: scheme, rid: nil, payload: envelope))
    DSXEvents().publish(scheme, "error", wire)
}
