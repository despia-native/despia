//
//  DSXEvents.swift — the native event bus (the in-process mirror of window.despia.on).
//
//  A package's `dsx.broadcast(name, data)` fans out to EVERY consumer surface, not
//  just the web:
//    • web                : window.despia.on("<scheme>", handler)        (via dsx.module.dom.proxy)
//    • native, in-process : dsx.events.on("<scheme>") { event, data in } (THIS bus)
//    • targets, separate  : dsx.container.observe { }                    (App Group + Darwin)
//      process
//
//  A package broadcasts once; web subscribers AND in-process native subscribers both
//  receive it, and neither knows about the other or enumerates events — they subscribe
//  by SCHEME (or "*" for the firehose), exactly like the web. This is what makes native
//  routes / components first-class event consumers once the WebView is no longer the
//  core.
//
//  `dsx.events` is exposed identically on a package context (Context) AND a component
//  context (StackComponentContext), so a native SCREEN can subscribe the same way a
//  package can — `dsx.events` sits next to `dsx.global` / `dsx.shared` (façade struct +
//  internal singleton), and is deliberately distinct from a component's LOCAL
//  `dsx.on`/`dsx.event` (parent↔child within one surface).
//
//  In-process only (live closures). Cross-PROCESS delivery (widget / watch) is the
//  container's Darwin signal (dsx.container.observe), not this bus.
//
//  Cross-runtime: the same shape maps to Kotlin/Java — `publish(scheme,event,data)`,
//  `on(scheme){ event,data -> }`, `cancel()`; untyped `data` (cast).
//

import Foundation

/// The in-process broadcast registry (the actual store). Internal — packages and
/// components reach it through the `dsx.events` façade, never directly.
final class DSXEventBus {
    static let shared = DSXEventBus()
    private init() {}

    private let lock = NSLock()
    /// scheme -> token -> handler. "*" is the firehose (every scheme), like `window.despia.on("*")`.
    private var subscribers: [String: [UUID: (String, Any?) -> Void]] = [:]

    /// Deliver a broadcast to every native subscriber of `scheme` (plus "*"), on the
    /// main thread. Called by `dsx.broadcast` alongside the web delivery.
    func publish(_ scheme: String, _ event: String, _ data: Any?) {
        lock.lock()
        let handlers = Array((subscribers[scheme] ?? [:]).values) + Array((subscribers["*"] ?? [:]).values)
        lock.unlock()
        guard !handlers.isEmpty else { return }
        if Thread.isMainThread { handlers.forEach { $0(event, data) } }
        else { DispatchQueue.main.async { handlers.forEach { $0(event, data) } } }
    }

    /// Subscribe to `scheme`'s broadcasts (or "*"). Returns a handle; `cancel()` to stop.
    func subscribe(_ scheme: String, _ handler: @escaping (String, Any?) -> Void) -> DSXEventSubscription {
        let token = UUID()
        lock.lock(); subscribers[scheme, default: [:]][token] = handler; lock.unlock()
        return DSXEventSubscription(scheme: scheme, token: token)
    }

    func unsubscribe(_ scheme: String, _ token: UUID) {
        lock.lock(); subscribers[scheme]?.removeValue(forKey: token); lock.unlock()
    }
}

/// `dsx.events` — subscribe to out-of-band broadcasts (the native mirror of
/// `window.despia.on`). A façade over `DSXEventBus`, exposed identically on every dsx
/// so packages AND native screens subscribe the same way. Untyped payload by contract,
/// so the same shape works on Swift/Kotlin/Java.
public struct DSXEvents {
    public init() {}

    /// Subscribe to a scheme's broadcasts (or "*" for the firehose). The handler gets
    /// `(event, data)` on the main thread. Subscribe ONCE (in `setup` / a screen's
    /// lifecycle), KEEP the returned handle, and `cancel()` to stop — dropping the
    /// handle does NOT auto-unsubscribe. In-process only; a separate-process target
    /// (widget / watch) uses `dsx.container.observe` instead.
    @discardableResult
    public func on(_ scheme: String, _ handler: @escaping (String, Any?) -> Void) -> DSXEventSubscription {
        DSXEventBus.shared.subscribe(scheme, handler)
    }

    /// INTERNAL delivery seam — the publish mirror of `on`. The kernel's `dsx.broadcast` fan-out
    /// and the JSE→native bridge deliver here, so the `DSXEventBus` store is referenced ONLY through
    /// this façade (nothing else names the singleton). Modules and screens publish via
    /// `dsx.broadcast(name, payload)`, never this directly — it stays `internal` for exactly that.
    func publish(_ scheme: String, _ event: String, _ data: Any?) {
        DSXEventBus.shared.publish(scheme, event, data)
    }
}

/// A handle to a `dsx.events.on(scheme) { }` subscription; `cancel()` to stop. Keep it
/// for the subscription's lifetime (a screen's controller, a package); dropping the
/// handle does NOT auto-unsubscribe (the closure may still be live), so cancel explicitly.
public struct DSXEventSubscription {
    private let scheme: String
    private let token: UUID
    init(scheme: String, token: UUID) { self.scheme = scheme; self.token = token }
    public func cancel() { DSXEventBus.shared.unsubscribe(scheme, token) }
}
