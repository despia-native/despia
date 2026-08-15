//
//  Messenger.swift — dsx.messenger: the multi-surface bridge (messenger.md, mechanism B).
//
//  ONE unified seam that works identically for EVERY surface — the web (<DSXWebView/>),
//  a game runtime (<Godot/>), any future native canvas. A surface OWNER mounts one
//  sink and its content becomes a first-class bus consumer:
//
//    let mount = dsx.messenger.mount("godot") { egress in /* deliver to my surface */ }
//
//    • INBOUND  — `mount.receive(scheme:action:args:rid:)` relays one of the
//      surface's CONTENT calls onto the bus at the UNTRUSTED tier
//      (`includeInternal: false` — the exact flag the web relay passes): internal
//      (`exposed: false`) actions stay invisible and declarative manifest gates
//      apply. Trust stays SOURCE-ANCHORED (gate the content at LOAD time —
//      Skills/security.md); no per-call allowlist, by doctrine.
//    • OUTBOUND — the kernel routes that call's resolve / error / per-call stream
//      events back to the ORIGIN surface's sink (Context routes by the call's
//      `surfaceID`), and fans every `dsx.broadcast` out to ALL mounted sinks
//      (rid == nil; the surface filters client-side, exactly like the web's
//      `despia.on` listener map).
//
//  No kernel DEADLINE, on purpose: a handler that never settles never delivers.
//  Each surface owns its own timeout — the web's lives in runtime.js
//  (`despia.arm`), a game's in its SDK — mirroring where that policy always lived.
//
//  The WEB is mounted too: DSXWebView mounts "web" (its sink → window.despia.__proxy),
//  and "web" is the DEFAULT target for calls carrying no surface origin (the
//  legacy web transports don't stamp one) — so the kernel's reply switch is fully
//  surface-anonymous. DEVICE-GATED per messenger.md: the correlated promise path
//  rides this; smoke checks #1–5 there before merging changes here.
//
//  Kernel-clean by construction: this file names no surface and imports nothing
//  but Foundation — `dsx.messenger` sits next to `dsx.events` / `dsx.shared`
//  (public façade + internal singleton; the hub is referenced ONLY through the
//  façade's internal deliver seams, the DSXEvents.publish pattern).
//
//  ModuleRegistry.platformSupport is consulted (read-only) when a dispatch comes
//  back unhandled, to answer the graceful `unsupported_platform` envelope for a
//  catalog scheme with no implementation on this OS, distinct from `not_loaded`
//  (excluded by THIS app / unknown scheme). DEFAULT EMPTY, so a bare kernel keeps
//  synthesizing `not_loaded` exactly as before.
//

import Foundation

/// One unit of surface-bound delivery — INTENT, never JS/engine specifics.
/// `payload` is the canonical reply envelope (the same shape `window.despia.__proxy`
/// consumes): `{ id, scheme, host, event, final, data, code?, recoverable?, message? }`.
public struct DSXEgress {
    /// The surface this delivery targets ("*" for a broadcast fan-out).
    public let target: String
    /// The envelope's scheme (the called module for correlated replies; the
    /// broadcast channel for out-of-band events).
    public let scheme: String
    /// Non-nil ⇒ correlated (the resolve/error/stream of ONE call, keyed to the
    /// surface SDK's pending map). Nil ⇒ out-of-band broadcast.
    public let rid: String?
    public let payload: [String: Any]
}

/// The mounted-sink registry (the actual store). Internal — surfaces reach it
/// through the `dsx.messenger` façade, never directly (the DSXEventBus pattern).
final class DSXMessengerHub {
    static let shared = DSXMessengerHub()
    private init() {}

    private let lock = NSLock()
    private var sinks: [String: (DSXEgress) -> Void] = [:]

    func mount(_ id: String, _ sink: @escaping (DSXEgress) -> Void) {
        lock.lock(); sinks[id] = sink; lock.unlock()
    }

    func unmount(_ id: String) {
        lock.lock(); sinks.removeValue(forKey: id); lock.unlock()
    }

    /// Correlated delivery to ONE surface, on the main thread. `false` when no sink
    /// is mounted under `id` (a pure-native app's web target, a torn-down surface).
    /// Off-main callers hop with main.SYNC — the same discipline the pre-messenger
    /// web transport had — so an emitter's sequence of envelopes for one rid can
    /// never reorder (an async hop could let a later resolve overtake an earlier
    /// stream event emitted from a different thread).
    @discardableResult
    func deliver(to id: String, _ egress: DSXEgress) -> Bool {
        lock.lock(); let sink = sinks[id]; lock.unlock()
        guard let sink else { return false }
        if Thread.isMainThread { sink(egress) } else { DispatchQueue.main.sync { sink(egress) } }
        return true
    }

    /// Broadcast fan-out to EVERY mounted sink, on the main thread (sync hop
    /// off-main, same ordering discipline as `deliver`). Surfaces filter
    /// client-side (their SDK's listener map), exactly like the web's `despia.on`.
    func deliverBroadcast(_ egress: DSXEgress) {
        lock.lock(); let all = Array(sinks.values); lock.unlock()
        guard !all.isEmpty else { return }
        if Thread.isMainThread { all.forEach { $0(egress) } }
        else { DispatchQueue.main.sync { all.forEach { $0(egress) } } }
    }
}

/// `dsx.messenger` — mount a surface onto the bus. A façade over the hub, exposed
/// identically on every dsx (like `dsx.events`).
public struct DSXMessenger {
    public init() {}

    /// INTERNAL delivery seams — the kernel's reply router (`Context.resolve` /
    /// `sendError` / `event` / `broadcast`) delivers through THESE, so the hub
    /// singleton is referenced only inside this file (the DSXEvents.publish
    /// pattern). Surfaces never call these — they mount and receive.
    @discardableResult
    func deliver(to id: String, _ egress: DSXEgress) -> Bool {
        DSXMessengerHub.shared.deliver(to: id, egress)
    }

    func deliverBroadcast(_ egress: DSXEgress) {
        DSXMessengerHub.shared.deliverBroadcast(egress)
    }

    /// Mount THIS surface's delivery sink under a unique id (the surface's own
    /// scheme by convention). Returns the mount handle used to feed the surface's
    /// inbound calls; keep it for the surface's lifetime, `unmount()` to detach.
    /// Mounting the same id again replaces the sink (a re-created surface rebinds).
    @discardableResult
    public func mount(_ id: String, _ sink: @escaping (DSXEgress) -> Void) -> DSXMessengerMount {
        DSXMessengerHub.shared.mount(id, sink)
        return DSXMessengerMount(id: id)
    }
}

/// A mounted surface's handle: the INBOUND half of the bridge.
public struct DSXMessengerMount {
    public let id: String
    init(id: String) { self.id = id }

    /// Relay one of this surface's CONTENT calls onto the bus — the exact mirror of
    /// the web transport: dispatch at the untrusted tier, correlate by `rid`. The
    /// reply (and any per-call stream events) arrives at this mount's sink as a
    /// correlated `DSXEgress`; an unowned scheme / malformed target synthesizes an
    /// `error` envelope (`code: "not_loaded"` / `"invalid_uri"`) so the surface's
    /// pending call always settles the same way the web's would.
    public func receive(scheme: String, action: String, args: [String: Any]? = nil, rid: String? = nil) {
        let surface = id
        // A scheme is a routing KEY, not URL grammar — identifier names
        // (`godot_test`) dispatch by string, same as the web's object-body
        // transport. Only an EMPTY scheme is unroutable.
        guard !scheme.isEmpty else {
            Self.syntheticError(to: surface, scheme: scheme, action: action, rid: rid, code: "invalid_uri")
            return
        }
        let params = Bridge.Params(dict: args ?? [:], requestID: rid, surfaceID: surface)
        // Action handlers render UI, so they must run on the main thread — the
        // web→bridge path always delivers there; a surface relay may not.
        let invoke = {
            if !ModuleRegistry.shared.handle(scheme: scheme, actionPath: action,
                                             params: params, includeInternal: false) {
                if let supported = ModuleRegistry.shared.unsupportedPlatforms(scheme) {
                    // In the catalog but NOT implemented on this OS: the graceful, structured
                    // `unsupported_platform` envelope (message + data pinned in
                    // OpenSource/Skills/android/api-mapping.md "Unsupported platform"), distinct
                    // from `not_loaded` below (which stays the answer for excluded-by-this-app
                    // AND unknown schemes). Inert while platformSupport is empty.
                    Self.syntheticError(to: surface, scheme: scheme, action: action, rid: rid,
                                        code: "unsupported_platform",
                                        message: ModuleRegistry.shared.unsupportedPlatformMessage(scheme),
                                        data: ModuleRegistry.shared.unsupportedPlatformData(scheme, supported))
                } else {
                    Self.syntheticError(to: surface, scheme: scheme, action: action, rid: rid, code: "not_loaded")
                }
            }
        }
        if Thread.isMainThread { invoke() } else { DispatchQueue.main.async(execute: invoke) }
    }

    public func unmount() { DSXMessengerHub.shared.unmount(id) }

    private static func syntheticError(to surface: String, scheme: String, action: String,
                                       rid: String?, code: String,
                                       message: String? = nil, data: Any? = nil) {
        // Like Context.sendError, `message` rides the envelope only when given (the
        // structured-error contract); `data` stays a present-but-null key otherwise.
        var envelope: [String: Any] = [
            "id": rid ?? NSNull(), "scheme": scheme, "host": action,
            "event": "error", "final": true, "data": data ?? NSNull(),
            "code": code, "recoverable": false
        ]
        if let message { envelope["message"] = message }
        DSXMessengerHub.shared.deliver(
            to: surface,
            DSXEgress(target: surface, scheme: scheme, rid: rid, payload: envelope)
        )
    }
}
