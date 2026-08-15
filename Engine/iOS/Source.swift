//
//  Source.swift — the kernel PROVENANCE primitive (`dsx.source`).
//
//  ONE reactive answer per remote-loaded plane: has THIS INSTALL ever loaded it, what is on
//  screen right now, and when — so "installed online, first opened offline" is knowable state,
//  not a guess. The slice shape, per plane (`source.<plane>` in the ONE reactive store):
//
//      { state:   "never" | "stale" | "live",     // ever loaded (persisted) / fresh this session
//        serving: "origin" | "cache" | "bundle",  // what is actually on screen right now
//        at:      "2026-07-17T09:41:00Z" }        // last successful load/check (ISO-8601)
//
//  plus the kernel-owned facts `source.online` (reactive reachability) and `source.boot`
//  ("first" | "warm" — first launch of this install). Markup reads `dsx.source.web.state`
//  (JSE alias → `global.source.*`), the page watches `despia.global.watch("source", …)`
//  (a plain store slice — no new bridge), native hooks `source.changed`.
//
//  ARCHITECTURE (the ruling, argued in architecture/proposals/source-plane.md):
//  • `source.*` is KERNEL VOCABULARY — a reserved namespace like `nav`/`screen`/`dsx`
//    (Article 1: an alias for a state path; grants its maintainers nothing). This file is
//    MECHANISM ONLY: it names no module and no plane — "web"/"routes"/"content" are strings
//    the OWNING modules bring (Dom, Routing, the content plane), each publishing ONLY its
//    own slice through the `dsx.source` facade. No aggregator module exists — that would be
//    the shim Article 3 bans — and an excluded owner simply leaves its slice absent
//    (Article 7: degrade, never lie).
//  • CACHING stays ONE primitive (`dsx.content`); this plane is the thin REPORTING face it
//    (and the non-byte planes) feed. Anything that caches host bytes should ride
//    `dsx.content` and gets its provenance published for free (ContentStore feeds
//    `source.content` at its publish/confirmed-fresh seams).
//  • "Ever loaded" persists in `UserDefaults.standard` keyed per plane+origin — deliberately
//    NOT the App Group container (writes drop on unprovisioned builds) and NOT Caches (the
//    OS may purge it, which would regress `stale` → `never`). An environment switch changes
//    the key, so a fresh origin honestly reads `never` (the content plane's own per-origin
//    convention).
//
import Foundation
import Network

public enum DSXSource {

    /// The wire states (Article 8 — names, not platform types).
    public static let never = "never", stale = "stale", live = "live"
    public static let servingOrigin = "origin", servingCache = "cache", servingBundle = "bundle"

    private static let monitor = NWPathMonitor()
    private static var monitoring = false
    private static let iso = ISO8601DateFormatter()   // thread-safe per docs

    // MARK: - boot seed (kernel facts only — called once from DSXBoot)

    /// Publish `source.online` + `source.boot` and arm the reachability observer. Kernel facts
    /// only; every per-plane slice is owner-published via `track`/`publish` below.
    public static func seed() {
        let booted = UserDefaults.standard.bool(forKey: "dsx.source.booted")
        DSX.state.setPath("source.boot", booted ? "warm" : "first")
        if !booted { UserDefaults.standard.set(true, forKey: "dsx.source.booted") }
        DSX.state.setPath("source.online", InternetConnectionManager.isConnectedToNetwork())
        guard !monitoring else { return }
        monitoring = true
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            DispatchQueue.main.async {
                guard (DSX.state.getPath("source.online") as? Bool) != online else { return }
                DSX.state.setPath("source.online", online)
                ModuleRegistry.shared.dispatch("source.changed", ["plane": "online", "state": online], .void)
            }
        }
        monitor.start(queue: DispatchQueue(label: "dsx.source.reachability"))
    }

    // MARK: - owner verbs (reached through the `dsx.source` facade)

    /// Seed a plane BEFORE its first load of the session: `never` (this install has never
    /// loaded it under `key`) or `stale` (loaded before; nothing fresh yet). Call at the
    /// owner's launch so the state exists the moment markup first reads it.
    public static func track(_ plane: String, key: String) {
        let state = stamp(plane, key) == nil ? never : stale
        write(plane, ["state": state], fire: false)
    }

    /// A serve/load happened. `fresh: true` = the ORIGIN answered this session → `live` +
    /// the persisted first-load stamp (what makes `never` truthful forever). `fresh: false`
    /// = serving a cache/bundle copy → `stale`/`never` derived from the stamp, `serving` +
    /// `at` still updated (the "what's on screen" half stays honest offline). Extra `meta`
    /// keys (e.g. the content plane's `path`) merge into the slice.
    public static func publish(_ plane: String, serving: String, fresh: Bool,
                               key: String, meta: [String: Any] = [:]) {
        if fresh, stamp(plane, key) == nil {
            UserDefaults.standard.set(iso.string(from: Date()), forKey: stampKey(plane, key))
        }
        var slice: [String: Any] = ["state": fresh ? live : (stamp(plane, key) == nil ? never : stale),
                                    "serving": serving,
                                    "at": iso.string(from: Date())]
        meta.forEach { slice[$0.key] = $0.value }
        write(plane, slice, fire: true)
    }

    // MARK: - plumbing

    private static func write(_ plane: String, _ slice: [String: Any], fire: Bool) {
        let apply = {
            DSX.state.setPath("source.\(plane)", slice)
            if fire { ModuleRegistry.shared.dispatch("source.changed", ["plane": plane, "state": slice["state"] ?? ""], .void) }
        }
        Thread.isMainThread ? apply() : DispatchQueue.main.async(execute: apply)
    }

    private static func stamp(_ plane: String, _ key: String) -> String? {
        UserDefaults.standard.string(forKey: stampKey(plane, key))
    }
    private static func stampKey(_ plane: String, _ key: String) -> String {
        "dsx.source.\(plane).\(key)"
    }
}

/// The `dsx.source` face on the bus handle — how MODULES reach the primitive (the binding
/// rule: only `dsx`, never a kernel singleton). Publishing is owner-only by convention —
/// `source.*` is a reserved namespace; write someone else's plane and the state inspector
/// will out you. Reads are ordinary reactive store reads (`dsx.global.source…` native,
/// `dsx.source.*` in markup, `despia.global.watch("source", …)` on the page).
public struct DSXSourceFace {
    public func track(_ plane: String, key: String) { DSXSource.track(plane, key: key) }
    public func publish(_ plane: String, serving: String, fresh: Bool,
                        key: String, meta: [String: Any] = [:]) {
        DSXSource.publish(plane, serving: serving, fresh: fresh, key: key, meta: meta)
    }
    /// Typed read of one plane's state ("never"/"stale"/"live"; "" = plane absent).
    public func state(_ plane: String) -> String {
        ((DSX.state.getPath("source.\(plane)") as? [String: Any])?["state"] as? String) ?? ""
    }
    /// The kernel reachability fact (`source.online`).
    public var online: Bool { (DSX.state.getPath("source.online") as? Bool) ?? true }
}
