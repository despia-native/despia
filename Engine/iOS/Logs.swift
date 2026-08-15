//
//  Logs.swift — the DSX log system's kernel core: the structured LOG RING behind `dsx.log`
//  (OpenSource/Conformance/logs/logs.json — the unified console primitive). The Kotlin twin
//  is Engine/Android core Logs.kt; the web twin is the kernel's logs.ts.
//
//  `dsx.log` is `console.log` with a home: one formatted line per call, attributed to its
//  source scheme, recorded here (ring, cap 500, always on — appending is nanoseconds and
//  programs, not just testers, read it via `dsx.logs`), and mirrored to `kernelLog` (the
//  Xcode console on DEBUG builds; the armed diagnostics ring on test installs — the drawer
//  + Copy-all see it). Logs are NOT errors: nothing here touches the error ledger, the
//  hooks, or the reactive `global.dsx.*` keys. Names no package, imports no WebKit — a pure
//  kernel primitive per the constitution; nothing here ever throws (Article 7).
//

import Foundation

/// One recorded log line — source scheme + console level + the formatted message.
/// scheme: a package scheme, "app" (unscoped markup), "console" (the console.* builtin),
/// or "page" (the DSXWebView page / the kernel `dsx.log` bus verb).
public struct DSXLogEntry {
    public let scheme: String
    /// "log" for dsx.log; the console.* builtin records its own level
    public let level: String
    public let message: String
    public let at: Date

    init(scheme: String, level: String, message: String) {
        self.scheme = scheme
        self.level = level
        self.message = message
        self.at = Date()
    }

    /// The read form (dev tooling, the conformance hosts) — mirrors DSXError.wire().
    public func wire() -> [String: Any] {
        ["scheme": scheme, "level": level, "message": message]
    }
}

/// The log ring: a capped structured ring, process-global like the registry.
public final class DSXLogBuffer {
    public static let shared = DSXLogBuffer()
    static let cap = 500
    private init() {}

    private let lock = NSLock()
    private var entries: [DSXLogEntry] = []
    private var total = 0

    func append(_ e: DSXLogEntry) {
        lock.lock(); defer { lock.unlock() }
        entries.append(e)
        total += 1
        if entries.count > Self.cap { entries.removeFirst(entries.count - Self.cap) }
    }

    /// The retained tail, oldest → newest (snapshot).
    public func recent() -> [DSXLogEntry] { lock.lock(); defer { lock.unlock() }; return entries }

    /// Monotonic count of every line ever recorded (survives ring eviction).
    public func count() -> Int { lock.lock(); defer { lock.unlock() }; return total }

    /// Dev tooling only — drops the retained tail (the monotonic count stays).
    public func clear() { lock.lock(); defer { lock.unlock() }; entries.removeAll() }
}

/// Record one log line: the ring + one `[dsx.log] scheme: message` kernelLog line (the
/// Xcode console on DEBUG builds, the armed diagnostics ring on test installs). Message
/// arrives pre-formatted (the house coercions — JSERunner.formatLogArgs). Never throws.
func reportLog(scheme: String, level: String, message: String) {
    DSXLogBuffer.shared.append(DSXLogEntry(scheme: scheme, level: level, message: message))
    kernelLog("[dsx.log] \(scheme): \(message)")
}
