//
//  DSXShared.swift — the shared in-process context registry ("dsx.shared").
//
//  One node PUBLISHES a live handle under a key; any node CONSUMES it. The native
//  equivalent of a web Context Provider — and a GENERAL primitive, not a special
//  case: DSXWebView is merely the first user (it provides "web" = its WKWebView). Any
//  package may provide/consume the same way, so the engine never special-cases a
//  particular handle.
//
//  This is for LIVE, in-process OBJECT handles (a webview, an AVPlayer, a DB client).
//  It is deliberately distinct from the other sharing primitives:
//    • dsx.values (DSXValues)  — strong-ref in-process VALUE state (Bool/String/Dict): native
//                                package coordination while handling hooks/actions (NOT web-synced)
//    • global.*  (DSXState)    — reactive, serializable DATA (syncs to web)
//    • dsx.container           — PERSISTENT storage (App Group, cross-process)
//    • dsx.module            — cross-package ACTIONS (RPC)
//
//  Cross-runtime contract (mirrors 1:1 on Kotlin/Java): UNTYPED by design — `use`
//  returns an opaque handle the consumer casts, because Java has no reified
//  generics. Verbs: provide / use / on. String keys (the keys, e.g. "web", are part
//  of the cross-runtime contract). Main-thread delivery. Handles are held WEAKLY, so
//  an unmounted provider's handle auto-prunes (Kotlin/Java: WeakReference).
//

import Foundation

final class DSXSharedRegistry {
    static let shared = DSXSharedRegistry()
    private init() {}

    private final class WeakBox { weak var value: AnyObject?; init(_ v: AnyObject?) { value = v } }
    private let lock = NSLock()
    private var handles: [String: WeakBox] = [:]
    private var observers: [String: [UUID: (Any?) -> Void]] = [:]

    func provide(_ key: String, _ handle: AnyObject?) {
        lock.lock()
        handles[key] = WeakBox(handle)
        let obs = Array((observers[key] ?? [:]).values)
        lock.unlock()
        notify(obs, with: handle)
    }

    func use(_ key: String) -> Any? {
        lock.lock(); defer { lock.unlock() }
        return handles[key]?.value
    }

    func on(_ key: String, _ handler: @escaping (Any?) -> Void) -> UUID {
        let token = UUID()
        lock.lock()
        observers[key, default: [:]][token] = handler
        let current = handles[key]?.value
        lock.unlock()
        if current != nil { notify([handler], with: current as AnyObject?) }  // fire now if a provider is already up
        return token
    }

    func cancel(_ key: String, _ token: UUID) {
        lock.lock(); observers[key]?.removeValue(forKey: token); lock.unlock()
    }

    private func notify(_ handlers: [(Any?) -> Void], with handle: AnyObject?) {
        guard !handlers.isEmpty else { return }
        let value: Any? = handle
        if Thread.isMainThread { handlers.forEach { $0(value) } }
        else { DispatchQueue.main.async { handlers.forEach { $0(value) } } }
    }
}

/// `dsx.shared` — publish / consume / observe a shared live handle. Untyped by
/// contract (cast the result of `use`), so the same shape works on Swift/Kotlin/Java.
public struct DSXShared {
    public init() {}

    /// Publish a live handle under `key` (held weakly). Re-provide to replace it
    /// (notifies observers); pass `nil` to clear. DSXWebView: `dsx.shared.provide("web", webView)`.
    public func provide(_ key: String, _ handle: AnyObject?) { DSXSharedRegistry.shared.provide(key, handle) }

    /// Consume the current handle for `key`, or nil. Cast it:
    /// `dsx.shared.use("web") as? WKWebView`.
    public func use(_ key: String) -> Any? { DSXSharedRegistry.shared.use(key) }

    /// Observe (re)publishes of `key`; fires immediately with the current handle if a
    /// provider is already up. Returns a token; `cancel(key, token)` to stop.
    @discardableResult
    public func on(_ key: String, _ handler: @escaping (Any?) -> Void) -> UUID {
        DSXSharedRegistry.shared.on(key, handler)
    }

    public func cancel(_ key: String, _ token: UUID) { DSXSharedRegistry.shared.cancel(key, token) }
}

// MARK: - dsx.values (strong-ref VALUE state)

/// `dsx.values` backing store — strong-ref keyed VALUE state, the sibling of `DSXSharedRegistry`
/// (weak OBJECT handles). A value like `auth.inProgress` has no owning object to keep it alive, so
/// it can't go through the weak handle store; this holds it strongly until removed. `NSLock`-guarded
/// like the handle store. Cross-runtime: a plain string→value map (mirrors 1:1 on Kotlin/Java).
final class DSXValuesRegistry {
    static let shared = DSXValuesRegistry()
    private init() {}

    private let lock = NSLock()
    private var values: [String: Any] = [:]

    func set(_ key: String, _ value: Any?) {
        lock.lock(); defer { lock.unlock() }
        if let value = value { values[key] = value } else { values.removeValue(forKey: key) }
    }

    func get(_ key: String) -> Any? {
        lock.lock(); defer { lock.unlock() }
        return values[key]
    }
}

/// `dsx.values` — publish / read shared VALUE data (strong-ref): native package-coordination state
/// shared while handling hooks/actions (a Bool/String/Dict), e.g. `auth.inProgress`. Contrast
/// `dsx.shared` (weak OBJECT handles). NOT DSX `dsx.variable` / route / reactive UI state. Untyped
/// `get` plus typed `bool`/`string` (the JSON/args typing convention).
public struct DSXValues {
    public init() {}

    /// Publish a value under `key` (held strongly). Pass nil to remove.
    public func set(_ key: String, _ value: Any?) { DSXValuesRegistry.shared.set(key, value) }

    /// Read the raw value for `key`, or nil — cast it, or use a typed accessor below.
    public func get(_ key: String) -> Any? { DSXValuesRegistry.shared.get(key) }

    /// Typed read: Bool (NSNumber-tolerant), default false when unset.
    public func bool(_ key: String) -> Bool {
        let v = DSXValuesRegistry.shared.get(key)
        return (v as? Bool) ?? (v as? NSNumber)?.boolValue ?? false
    }

    /// Typed read: String, or nil.
    public func string(_ key: String) -> String? { DSXValuesRegistry.shared.get(key) as? String }

    /// Remove the value for `key`.
    public func remove(_ key: String) { DSXValuesRegistry.shared.set(key, nil) }
}
