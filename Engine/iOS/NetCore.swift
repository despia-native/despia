//
//  NetCore.swift — the shared Core/Net core: the classification fold, the online split, the
//  radio-family map, the probe verdict and the transition debounce. The law is the corpus,
//  `OpenSource/Conformance/net/{status,transitions}.json` (parity/F05-net.md); the Kotlin twin
//  is `:core` NetCore.kt and the web twin is @despia/kernel's net-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file. NWPathMonitor (iOS),
//  ConnectivityManager.registerDefaultNetworkCallback (Android) and navigator.connection (web)
//  each read their own platform and hand the neutral snapshot in; the module publishes the
//  context vars and fires the `change` broadcast on the way out. Keeping the DECISION separate
//  from the PLUMBING is what lets one corpus judge three renderers.
//
//  No Network import: this file is pure so the record lane can run it headless.
//
import Foundation

/// The five facts a settled path carries.
///
/// `validated` is Android's own captive-portal verdict (NET_CAPABILITY_VALIDATED). It is true on
/// every other renderer, where only an explicit `probe()` can learn the same thing, so the field
/// costs nothing here and keeps `online` one expression everywhere.
public struct NetSnapshot: Equatable {
    public var reachable: Bool
    public var type: String
    public var expensive: Bool
    public var constrained: Bool
    public var validated: Bool

    public init(reachable: Bool, type: String, expensive: Bool, constrained: Bool, validated: Bool = true) {
        self.reachable = reachable
        self.type = type
        self.expensive = expensive
        self.constrained = constrained
        self.validated = validated
    }
}

/// One settled transition, as the debounce reports it.
public struct NetChange: Equatable {
    public let at: Int
    public let previous: String
    public let snapshot: NetSnapshot
    public let online: Bool
}

public enum NetCore {

    /// The reported link vocabulary. `unknown` is the pre-first-update value only.
    public static let types: [String] = ["wifi", "cellular", "ethernet", "vpn", "other", "none", "unknown"]

    /// Interface-name prefixes that mean "this is a tunnel". A VPN rides ON TOP of wifi or
    /// cellular, so reporting the transport underneath would hide what the app asked about.
    public static let tunnelPrefixes: [String] = ["utun", "ipsec", "ppp", "tap", "tun"]

    /// What the module publishes before the first path update lands: optimistic, so a page never
    /// flashes an offline banner on the way to learning the truth.
    public static let unknown = NetSnapshot(reachable: true, type: "unknown", expensive: false, constrained: false)

    /// The classification fold: a raw path snapshot in, the reported link facts out.
    ///
    ///   1. VPN wins over the transport underneath (a tunnel rides on top of wifi or cellular).
    ///   2. An unsatisfied path is `none` and nothing else is inspected — a metered flag on a
    ///      link that is down is not a fact about anything.
    ///   3. `expensive` is the METERED flag, never `type == "cellular"`: a personal hotspot over
    ///      wifi is metered, and cellular on an unlimited plan is not.
    ///   4. `constrained` is the user's data-saving setting, independent of everything else.
    public static func classify(satisfied: Bool,
                                interfaces: [String] = [],
                                transports: [String] = [],
                                metered: Bool = false,
                                dataSaver: Bool = false) -> NetSnapshot {
        guard satisfied else {
            return NetSnapshot(reachable: false, type: "none", expensive: false,
                               constrained: false, validated: false)
        }
        let links = transports.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        let tunnelled = interfaces.contains { name in
            let lower = name.trimmingCharacters(in: .whitespaces).lowercased()
            return tunnelPrefixes.contains { lower.hasPrefix($0) }
        }
        let type: String
        if tunnelled || links.contains("vpn") { type = "vpn" }
        else if links.contains("wifi") { type = "wifi" }
        else if links.contains("cellular") { type = "cellular" }
        else if links.contains("ethernet") { type = "ethernet" }
        else { type = "other" }
        return NetSnapshot(reachable: true, type: type, expensive: metered, constrained: dataSaver)
    }

    /// `online` is `reachable` AND the last probe verdict — the entire reason the two fields
    /// exist separately. An interface can be up while a captive portal eats every request.
    public static func online(_ snapshot: NetSnapshot, probeFailed: Bool) -> Bool {
        snapshot.reachable && snapshot.validated && !probeFailed
    }

    /// Radio family token -> reported generation. The module normalises its own platform
    /// constant (CTRadioAccessTechnologyLTE, NETWORK_TYPE_LTE, connection.effectiveType) down to
    /// one of these tokens; anything unrecognised reports empty rather than a guess.
    private static let radioFamilies: [String: String] = [
        "gprs": "2g", "edge": "2g", "cdma": "2g", "cdma1x": "2g", "1xrtt": "2g",
        "iden": "2g", "gsm": "2g",
        "wcdma": "3g", "umts": "3g", "hsdpa": "3g", "hsupa": "3g", "hspa": "3g",
        "hspap": "3g", "evdo0": "3g", "evdoa": "3g", "evdob": "3g",
        "cdmaevdorev0": "3g", "cdmaevdoreva": "3g", "cdmaevdorevb": "3g",
        "ehrpd": "3g", "tdscdma": "3g",
        "lte": "4g", "iwlan": "4g",
        "nr": "5g", "nrnsa": "5g",
    ]

    /// Empty unless the link is cellular AND the platform volunteered the family without a
    /// permission prompt. A withheld family is empty, never a guess.
    public static func generation(type: String, radio: String?) -> String {
        guard type == "cellular" else { return "" }
        let token = (radio ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !token.isEmpty else { return "" }
        return radioFamilies[token] ?? ""
    }

    /// The host a redirect points at, or nil when the Location names none (which includes a
    /// relative Location, whose host is by definition the requested one).
    private static func redirectHost(_ location: String) -> String? {
        guard let marker = location.range(of: "://") else { return nil }
        var rest = String(location[marker.upperBound...])
        if let cut = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
            rest = String(rest[rest.startIndex..<cut])
        }
        if let at = rest.lastIndex(of: "@") { rest = String(rest[rest.index(after: at)...]) }
        // One colon is a port; several is an IPv6 literal, which keeps its colons.
        if rest.filter({ $0 == ":" }).count == 1, let colon = rest.lastIndex(of: ":") {
            let port = rest[rest.index(after: colon)...]
            if !port.isEmpty, port.allSatisfy({ $0.isNumber }) {
                rest = String(rest[rest.startIndex..<colon])
            }
        }
        return rest.lowercased()
    }

    /// The reachability verdict from ONE completed request.
    ///
    /// Redirects are never followed, so the response IS the 3xx and its Location is readable: a
    /// redirect to another host is the captive-portal signature, while a same-host redirect (an
    /// http to https upgrade) is a normal, reachable answer. 4xx and 5xx mean a server answered
    /// but the app is not served, and status 0 is a dead transport — an ANSWER, never a throw.
    public static func probeReachable(status: Int, requestHost: String?, location: String?) -> Bool {
        guard status >= 200, status < 400 else { return false }
        guard status >= 300 else { return true }
        let target = (location ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return false }
        guard let host = redirectHost(target) else { return true }
        return host == (requestHost ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// The transition debounce.
///
/// Interfaces flap: a wifi to cellular handoff drops through `none` for a few hundred
/// milliseconds, and an undebounced stream turns that into three events and two banner flashes.
///
///   1. The FIRST update after launch is applied immediately and announces nothing — there was
///      no earlier state to change from, and waiting half a second to learn the truth at launch
///      would be its own bug.
///   2. After that a candidate must hold for `debounceMs` before it is published.
///   3. A candidate that returns to the settled value inside the window cancels it outright, so
///      a flap produces no event at all.
///   4. A settled transition emits exactly ONE change, carrying the new facts plus `previous`.
///   5. A settled transition clears the probe verdict: a new link deserves a fresh one.
///
/// The clock is the CALLER'S. The module drives it from a real timer, the corpus runner drives
/// it from a timeline, and the machine cannot tell the difference.
public final class NetDebounce {

    public let debounceMs: Int

    private var current: NetSnapshot
    private var hasSettled = false
    private var failedProbe = false
    private var pendingCandidate: NetSnapshot?
    private var pendingDeadlineMs = 0
    private var changes: [NetChange] = []

    public init(debounceMs: Int, initial: NetSnapshot = NetCore.unknown) {
        self.debounceMs = max(0, debounceMs)
        self.current = initial
    }

    public var settled: NetSnapshot { current }
    public var probeFailed: Bool { failedProbe }
    public var online: Bool { NetCore.online(current, probeFailed: failedProbe) }

    /// When the pending candidate is due, or nil when nothing is pending. The module arms one
    /// timer on this; nothing else needs to know the window exists.
    public var pendingDeadline: Int? { pendingCandidate == nil ? nil : pendingDeadlineMs }

    /// Commit a pending candidate whose window has closed. Idempotent.
    public func advance(_ now: Int) {
        guard let candidate = pendingCandidate, pendingDeadlineMs <= now else { return }
        let deadline = pendingDeadlineMs
        pendingCandidate = nil
        guard candidate != current else { return }
        let previous = current.type
        current = candidate
        failedProbe = false
        changes.append(NetChange(at: deadline, previous: previous, snapshot: candidate,
                                 online: NetCore.online(candidate, probeFailed: false)))
    }

    /// A path update from the platform.
    public func path(_ now: Int, _ candidate: NetSnapshot) {
        advance(now)
        guard hasSettled else {
            hasSettled = true
            current = candidate
            pendingCandidate = nil
            return
        }
        pendingCandidate = nil
        guard candidate != current else { return }
        pendingCandidate = candidate
        pendingDeadlineMs = now + debounceMs
        if debounceMs == 0 { advance(now) }
    }

    /// A completed probe's verdict. It moves `online` without touching the link facts, and
    /// without announcing a transition: the link did not change, only what it is worth.
    public func probe(_ now: Int, failed: Bool) {
        advance(now)
        failedProbe = failed
    }

    /// Take the transitions recorded since the last drain.
    @discardableResult
    public func drain() -> [NetChange] {
        let out = changes
        changes.removeAll()
        return out
    }
}
