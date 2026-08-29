//
//  GeoPolicy.swift - the shared Core/Geo pure core: the two-step permission ladder, the
//  escalation route, the precise-location decision, the region-limit accounting, the accuracy
//  vocabulary and the battery filter. The law is the corpus,
//  `OpenSource/Conformance/geo/*.json` (parity/F09-geo.md); the Kotlin twin is `:core`
//  GeoPolicy.kt and the web twin is @despia-native/kernel's geo.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: CLLocationManager,
//  FusedLocationProviderClient and navigator.geolocation all ask this core WHAT to do and then
//  do it. Keeping the DECISION separate from the PLUMBING is what makes "the ladder is
//  enforced, not documented" a testable claim rather than a paragraph in a README.
//
//  THE TWO RULES THIS FILE EXISTS FOR:
//
//  1. ASK FOR whenInUse FIRST. A cold `always` request is denied by most users and flagged in
//     App Store review, and on Android 11+ the system will not even show the dialog. So
//     `always` without a granted `whenInUse` refuses with escalation_required and never
//     reaches a prompt. The module makes the correct sequence the only sequence.
//
//  2. THE REGION CAP IS A TYPED ERROR. iOS monitors twenty CLCircularRegions per app, Android
//     starts dropping above a hundred, and every library silently loses the overflow. Here the
//     twenty-first region refuses with region_limit and names the limit and the count.
//
//  No CoreLocation import: this file is pure so the record lane can run it headless.
//
import Foundation

public enum GeoPolicy {

    // MARK: - the permission ladder

    /// The authorization statuses, as the module reports them (never a platform enum).
    public static let statuses: [String] = ["notDetermined", "denied", "restricted", "whenInUse", "always"]

    /// The two levels an app may ask for. There is no third.
    public static let levels: [String] = ["whenInUse", "always"]

    /// What the module knows about this app's grant right now.
    public struct PermissionState: Equatable {
        public let status: String
        /// True once the OS has shown the Always prompt. It shows it ONCE; after that a repeat
        /// request displays nothing, so the honest move is a Settings deep link.
        public let escalationOffered: Bool
        public let precise: Bool

        public init(status: String, escalationOffered: Bool = false, precise: Bool = false) {
            self.status = status
            self.escalationOffered = escalationOffered
            self.precise = precise
        }
    }

    /// What to do about a permission request: prompt, settle with what we already hold, or refuse.
    public struct Plan: Equatable {
        public let action: String
        public let prompt: String?
        public let status: String?
        public let prompted: Bool
        public let error: String?

        public init(action: String, prompt: String? = nil, status: String? = nil,
                    prompted: Bool = false, error: String? = nil) {
            self.action = action
            self.prompt = prompt
            self.status = status
            self.prompted = prompted
            self.error = error
        }
    }

    /// Decide what a `permission({ level })` call should do.
    ///
    /// The ladder in one function: `whenInUse` prompts once and then settles; `always` is legal
    /// ONLY on top of a granted `whenInUse`, and only once, because that is the only shape
    /// either platform actually supports.
    public static func permissionPlan(_ level: String?, state: PermissionState) -> Plan {
        let want = (level ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard levels.contains(want) else { return Plan(action: "refuse", error: "invalid_argument") }
        guard state.status != "restricted" else { return Plan(action: "refuse", error: "permission_denied") }

        if want == "whenInUse" {
            switch state.status {
            case "whenInUse", "always": return Plan(action: "settle", status: state.status, prompted: false)
            case "denied":              return Plan(action: "refuse", error: "permission_denied")
            default:                    return Plan(action: "prompt", prompt: "whenInUse")
            }
        }

        if state.status == "always" { return Plan(action: "settle", status: "always", prompted: false) }
        guard state.status == "whenInUse" else { return Plan(action: "refuse", error: "escalation_required") }
        if state.escalationOffered { return Plan(action: "settle", status: "whenInUse", prompted: false) }
        return Plan(action: "prompt", prompt: "always")
    }

    /// Fold the OS's answer to a prompt back into the state.
    ///
    /// A DECLINED ESCALATION IS NOT A LOST GRANT: the app still holds `whenInUse`, and the one
    /// available offer has been spent. Throwing the foreground grant away here (which is what a
    /// naive `granted ? always : denied` does) would break the app's working feature to record
    /// a refusal of a different one.
    public static func applyPermission(_ state: PermissionState, prompted: String,
                                       granted: Bool) -> PermissionState {
        if prompted == "always" {
            return PermissionState(status: granted ? "always" : state.status,
                                   escalationOffered: true, precise: state.precise)
        }
        return PermissionState(status: granted ? "whenInUse" : "denied",
                               escalationOffered: state.escalationOffered, precise: state.precise)
    }

    /// How the `always` escalation is actually obtained on this platform.
    ///
    /// THE ANDROID BACKGROUND SPLIT: `always` is ACCESS_BACKGROUND_LOCATION, and from Android 11
    /// (API 30) the system refuses to show it in a request dialog at all - the only path is the
    /// app settings screen. An app that calls requestPermissions and waits for a callback waits
    /// forever. Pinned here so both runtimes read one answer.
    public static func escalationRoute(platform: String, sdk: Int) -> String {
        switch platform {
        case "ios":     return "prompt"
        case "android": return sdk >= 30 ? "settings" : "prompt"
        default:        return "unsupported"
        }
    }

    /// Whether a reduced-accuracy grant satisfies what the caller asked for.
    public struct PreciseOutcome: Equatable {
        public let ok: Bool
        public let precise: Bool
        public let error: String?
    }

    /// iOS 14 and Android 12 both let a user grant APPROXIMATE location. An app that needs
    /// precision must be told, rather than left to wonder why every fix is kilometres wide.
    public static func preciseOutcome(requested: Bool, granted: Bool) -> PreciseOutcome {
        if requested && !granted { return PreciseOutcome(ok: false, precise: false, error: "precise_denied") }
        return PreciseOutcome(ok: true, precise: granted, error: nil)
    }

    // MARK: - region monitoring

    /// iOS 20 is a hard OS limit; Android starts dropping above 100.
    public static let regionCaps: [String: Int] = ["ios": 20, "android": 100, "web": 0]

    public static let radiusFloorMeters: Double = 100
    public static let radiusCeilingMeters: Double = 100_000

    public struct Radius: Equatable {
        public let radius: Double
        public let clamped: Bool
    }

    /// Correct a radius the platform will not honour, and SAY that it was corrected. A region
    /// that silently never fires is indistinguishable from a broken geofence implementation.
    public static func radius(_ requested: Double) -> Radius {
        guard requested.isFinite else { return Radius(radius: radiusFloorMeters, clamped: true) }
        if requested < radiusFloorMeters { return Radius(radius: radiusFloorMeters, clamped: true) }
        if requested > radiusCeilingMeters { return Radius(radius: radiusCeilingMeters, clamped: true) }
        return Radius(radius: requested, clamped: false)
    }

    public struct RegionResult: Equatable {
        public let ok: Bool
        public let id: String?
        public let count: Int
        public let removed: Bool?
        public let error: String?
        public let limit: Int?

        public init(ok: Bool, id: String? = nil, count: Int = 0, removed: Bool? = nil,
                    error: String? = nil, limit: Int? = nil) {
            self.ok = ok
            self.id = id
            self.count = count
            self.removed = removed
            self.error = error
            self.limit = limit
        }
    }

    /// The monitored-region set, with the cap accounted for rather than discovered.
    ///
    /// Re-adding a live id REPLACES it in place and consumes no slot, so a screen that
    /// re-declares its regions on every appear cannot exhaust the cap by itself - which is how
    /// apps hit the limit in the field.
    public final class RegionSet {
        public let cap: Int
        private var ids: [String] = []

        public init(cap: Int) { self.cap = cap }

        public var count: Int { ids.count }

        public func list() -> [String] { ids }

        @discardableResult
        public func add(_ id: String?) -> RegionResult {
            let key = (id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return RegionResult(ok: false, error: "invalid_argument") }
            if ids.contains(key) { return RegionResult(ok: true, id: key, count: ids.count) }
            guard ids.count < cap else {
                return RegionResult(ok: false, count: ids.count, error: "region_limit", limit: cap)
            }
            ids.append(key)
            return RegionResult(ok: true, id: key, count: ids.count)
        }

        @discardableResult
        public func remove(_ id: String?) -> RegionResult {
            let key = (id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return RegionResult(ok: false, error: "invalid_argument") }
            let before = ids.count
            ids.removeAll { $0 == key }
            return RegionResult(ok: true, id: key, count: ids.count, removed: ids.count != before)
        }
    }

    /// Where one crossing goes. A geofence wakes the app with NO UI, so a delivery path that
    /// only reaches a mounted screen is a feature that works in the simulator and never in
    /// production: a region may name a declared Core/Background task, and the crossing runs it.
    public struct DeliveryPlan: Equatable {
        public let broadcast: Bool
        public let background: Bool
        public let foreground: Bool
    }

    public static func deliveryPlan(task: String?, screenMounted: Bool) -> DeliveryPlan {
        let named = (task ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return DeliveryPlan(broadcast: true, background: !named.isEmpty, foreground: screenMounted)
    }

    // MARK: - the stream

    /// One accuracy word, and the real platform constant it names.
    public struct Accuracy: Equatable {
        public let word: String
        public let ios: String
        public let android: String
        public let web: String
        public let meters: Int
    }

    public static let accuracies: [Accuracy] = [
        Accuracy(word: "navigation", ios: "kCLLocationAccuracyBestForNavigation",
                 android: "PRIORITY_HIGH_ACCURACY", web: "high", meters: 0),
        Accuracy(word: "best", ios: "kCLLocationAccuracyBest",
                 android: "PRIORITY_HIGH_ACCURACY", web: "high", meters: 0),
        Accuracy(word: "balanced", ios: "kCLLocationAccuracyNearestTenMeters",
                 android: "PRIORITY_BALANCED_POWER_ACCURACY", web: "low", meters: 10),
        Accuracy(word: "low", ios: "kCLLocationAccuracyHundredMeters",
                 android: "PRIORITY_LOW_POWER", web: "low", meters: 100),
        Accuracy(word: "passive", ios: "kCLLocationAccuracyThreeKilometers",
                 android: "PRIORITY_PASSIVE", web: "low", meters: 3000),
    ]

    public static let defaultAccuracy = "balanced"

    /// Fold an accuracy word. Absent takes the balanced default; an unrecognised word returns
    /// nil (the module reports `invalid_argument`) rather than being silently downgraded,
    /// because a silent downgrade is a battery decision made on the author's behalf.
    public static func accuracy(_ word: String?) -> Accuracy? {
        let key = (word ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let wanted = key.isEmpty ? defaultAccuracy : key
        return accuracies.first { $0.word == wanted }
    }

    /// The IUGG mean Earth radius, in metres. Pinned so three runtimes agree on a distance.
    public static let earthRadiusMeters: Double = 6_371_008.8

    /// Great-circle distance between two fixes, in metres (haversine).
    public static func distanceMeters(fromLat: Double, fromLon: Double,
                                      toLat: Double, toLon: Double) -> Double {
        let rad = Double.pi / 180
        let phi1 = fromLat * rad
        let phi2 = toLat * rad
        let dPhi = (toLat - fromLat) * rad
        let dLambda = (toLon - fromLon) * rad
        let a = sin(dPhi / 2) * sin(dPhi / 2) + cos(phi1) * cos(phi2) * sin(dLambda / 2) * sin(dLambda / 2)
        return 2 * earthRadiusMeters * asin(min(1, sqrt(a)))
    }

    /// A delivered fix, reduced to what the filter needs.
    public struct Fix: Equatable {
        public let lat: Double
        public let lon: Double
        public let at: Int

        public init(lat: Double, lon: Double, at: Int) {
            self.lat = lat
            self.lon = lon
            self.at = at
        }
    }

    public struct FilterVerdict: Equatable {
        public let deliver: Bool
        /// Which filter suppressed it, for the honest reason a caller can log.
        public let reason: String?
    }

    /// Does this fix go to the caller.
    ///
    /// THE BATTERY BUG THIS PREVENTS: a module that accepts `distanceFilter` and delivers every
    /// fix anyway passes every test that only checks that positions arrive, and drains a phone
    /// in an afternoon. Both filters must pass when both are set; the first fix of a session
    /// always goes out, because a filter that swallows the opening position renders a map in
    /// the middle of the ocean.
    public static func shouldDeliver(last: Fix?, next: Fix,
                                     distanceFilter: Double, intervalMS: Int) -> FilterVerdict {
        guard let last else { return FilterVerdict(deliver: true, reason: nil) }
        if intervalMS > 0 {
            let elapsed = next.at - last.at
            // A clock change or a late-queued fix must not wedge the stream forever.
            if elapsed >= 0 && elapsed < intervalMS { return FilterVerdict(deliver: false, reason: "interval") }
        }
        if distanceFilter > 0 {
            let moved = distanceMeters(fromLat: last.lat, fromLon: last.lon, toLat: next.lat, toLon: next.lon)
            if moved < distanceFilter { return FilterVerdict(deliver: false, reason: "distance") }
        }
        return FilterVerdict(deliver: true, reason: nil)
    }

    /// Whether a cached fix is fresh enough to answer `last({ maxAge })` WITHOUT waking the
    /// radio, which is the whole point of the call. A stale cache is the typed absence, never a
    /// stale fix handed back as though it were current.
    public static func cacheServes(ageMS: Int, maxAgeMS: Int) -> Bool {
        maxAgeMS <= 0 || ageMS <= maxAgeMS
    }
}
