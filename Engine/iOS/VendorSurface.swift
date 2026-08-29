//
//  VendorSurface.swift — Swift twin of @despia/kernel vendor-surface.ts and
//  :core VendorSurface.kt: THE INLINE-VENDOR-SURFACE FAMILY FOLDS (V02..V06,
//  architecture/proposals/inline-native-surfaces.md).
//
//  The SECOND half of the pure core V01 started in VendorSession.swift, and deliberately a
//  sibling file rather than a fork: VendorSessionRef (the secret boundary),
//  VendorSessionMachine (one session, two views) and VendorRetain (keyed identity) are
//  SHARED, and every vendor in this family uses them unchanged. There is exactly one session
//  machine in this codebase and this file does not add a second.
//
//  What the family needed and V01 did not have is here: the permission ladder a live surface
//  renders through, the participant roster a call grid orders by, the ad slot geometry and
//  request gate, the paywall package ordering, the sign-in step ladder, and the scan dedupe a
//  camera preview needs to stop firing sixty times a second.
//
//  The law is the corpus: OpenSource/Conformance/inline-surfaces/{stream,clerk,admob,
//  revenuecat,scanner}.json, run on TS and Kotlin per-PR and here in the record lane.
//
//  PURE by construction: no UIKit, no NSRegularExpression, no vendor SDK. Everything is a
//  function of its arguments, which is what lets one corpus judge three runtimes and what
//  lets a camera permission ladder be tested without a camera.
//
import Foundation

// MARK: - 1 · The surface gate: what a live vendor surface renders, before it renders

/// Does this build have the hardware and the linked SDK the surface needs.
public enum SurfaceCapability: String, Equatable {
    case present
    case absent

    public static func fold(_ raw: String?) -> SurfaceCapability {
        (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == "absent" ? .absent : .present
    }
}

/// The platform's answer for the permission the surface needs. `unknown` is the honest word
/// for "not asked yet on a platform that does not distinguish", and it is treated as `prompt`
/// rather than as a denial: a surface that fails closed on a not-yet-asked permission never
/// gets asked.
public enum SurfacePermission: String, Equatable {
    case granted, prompt, denied, restricted, unknown

    public static func fold(_ raw: String?) -> SurfacePermission {
        SurfacePermission(rawValue: (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) ?? .unknown
    }
}

/// What the component puts on screen. `request` is the affordance that asks; `fallback` is the
/// author's slot children, or the typed-absence caption where there are none.
public enum SurfaceRender: String, Equatable {
    case surface, request, fallback
}

public enum VendorSurfaceGate {

    public static let subject = "This surface"

    /// One wording per code, so three renderers cannot say it differently. `{subject}` is the
    /// only substitution, and it names the capability ("Camera", "Microphone").
    public static let messages: [String: String] = [
        "unsupported_platform": "{subject} is not available on this device.",
        "permission_required": "{subject} access has not been granted yet.",
        "permission_denied": "{subject} access was denied. Enable it in Settings to continue.",
        "permission_restricted": "{subject} access is restricted on this device.",
    ]

    public struct Gate: Equatable {
        public let render: SurfaceRender
        public let code: String
        public let message: String
        /// Can the user do something about it. Denied is recoverable (Settings); restricted by
        /// policy and absent hardware are not.
        public let recoverable: Bool
    }

    /// The ladder a live vendor surface descends before it shows anything.
    ///
    /// ORDER IS THE LAW. Capability first: a device with no camera must not be asked for
    /// camera permission, and an SDK that is not linked in this build must answer
    /// `unsupported_platform` rather than a permission word it cannot know. Then the
    /// permission, where `prompt` and `unknown` both render the ASK rather than the refusal.
    public static func gate(capability: SurfaceCapability = .present,
                            permission: SurfacePermission = .unknown,
                            subject: String = "") -> Gate {
        let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = trimmed.isEmpty ? VendorSurfaceGate.subject : trimmed
        func say(_ code: String) -> String {
            code.isEmpty ? "" : (messages[code] ?? "").replacingOccurrences(of: "{subject}", with: named)
        }

        if capability == .absent {
            return Gate(render: .fallback, code: "unsupported_platform",
                        message: say("unsupported_platform"), recoverable: false)
        }
        switch permission {
        case .granted:
            return Gate(render: .surface, code: "", message: "", recoverable: false)
        case .denied:
            return Gate(render: .fallback, code: "permission_denied",
                        message: say("permission_denied"), recoverable: true)
        case .restricted:
            return Gate(render: .fallback, code: "permission_restricted",
                        message: say("permission_restricted"), recoverable: false)
        case .prompt, .unknown:
            return Gate(render: .request, code: "permission_required",
                        message: say("permission_required"), recoverable: true)
        }
    }
}

// MARK: - 2 · The call roster: who is on screen, in what order, in how many columns

public enum VendorRoster {

    public struct Participant: Equatable {
        public let id: String
        public let local: Bool
        public let pinned: Bool
        public let dominant: Bool
        public let screenShare: Bool
        public let joinedAt: Int

        public init(id: String, local: Bool = false, pinned: Bool = false,
                    dominant: Bool = false, screenShare: Bool = false, joinedAt: Int = 0) {
            self.id = id
            self.local = local
            self.pinned = pinned
            self.dominant = dominant
            self.screenShare = screenShare
            self.joinedAt = joinedAt
        }
    }

    /// A tier is a POSITION rule, never a visibility rule: everyone is in `order`, and only
    /// `max` decides who is visible.
    public static let tiers: [String] = ["pinned", "screenShare", "dominant", "remote", "local"]

    public struct Fold: Equatable {
        public let order: [String]
        public let visible: [String]
        public let overflow: Int
        /// The one tile a spotlight layout enlarges, or "".
        public let spotlight: String
        public let columns: Int
        public let rows: Int
    }

    /// Visible tiles to grid columns. Hardcoded on all three renderers on purpose, so a
    /// three-person call is never 2x2 on one platform and 3x1 on another.
    public static func columns(_ count: Int) -> Int {
        if count <= 0 { return 0 }
        if count == 1 { return 1 }
        if count <= 4 { return 2 }
        if count <= 9 { return 3 }
        return 4
    }

    private static func tier(_ p: Participant) -> Int {
        if p.pinned { return 0 }
        if p.screenShare { return 1 }
        if p.dominant { return 2 }
        if p.local { return 4 }
        return 3
    }

    /// Order a call's participants deterministically.
    ///
    /// The local participant sinks to the bottom unless something promotes it (a pin, a screen
    /// share, the floor), because a user looking at their own face instead of the person
    /// talking is the complaint every call app gets first. Ties break on join time and then on
    /// id, so the same roster produces the same grid on three renderers and a re-render does
    /// not shuffle tiles under a finger.
    public static func fold(_ participants: [Participant], max: Int = 0, layout: String = "") -> Fold {
        let people = participants.filter { !$0.id.isEmpty }
        let ranked = people.enumerated().sorted { lhs, rhs in
            let a = tier(lhs.element), b = tier(rhs.element)
            if a != b { return a < b }
            if lhs.element.joinedAt != rhs.element.joinedAt { return lhs.element.joinedAt < rhs.element.joinedAt }
            if lhs.element.id != rhs.element.id { return lhs.element.id < rhs.element.id }
            return lhs.offset < rhs.offset
        }
        let order = ranked.map { $0.element.id }
        let visible = max > 0 ? Array(order.prefix(max)) : order
        let cols = columns(visible.count)
        return Fold(order: order,
                    visible: visible,
                    overflow: order.count - visible.count,
                    spotlight: layout == "spotlight" ? (order.first ?? "") : "",
                    columns: cols,
                    rows: cols == 0 ? 0 : Int(ceil(Double(visible.count) / Double(cols))))
    }
}

// MARK: - 3 · The ad slot: geometry, and whether a request may be made at all

public enum VendorAdSlot {

    /// The IAB sizes the vendor SDKs name, in points. Data, not code, because these are the
    /// vendor's numbers and all three renderers hardcode the same ones.
    public static let sizes: [String: (width: Int, height: Int)] = [
        "banner": (320, 50),
        "largeBanner": (320, 100),
        "mediumRectangle": (300, 250),
        "fullBanner": (468, 60),
        "leaderboard": (728, 90),
        "skyscraper": (120, 600),
    ]

    public struct Slot: Equatable {
        public let width: Int
        public let height: Int
        /// The SDK measures this one. The fold refuses to invent an adaptive height: Google
        /// computes it from the device at request time, and a number guessed here would be a
        /// layout that jumps the first time a real ad lands.
        public let adaptive: Bool
        public let code: String
    }

    public static func slot(_ size: String?, width: Int = 0) -> Slot {
        let word = (size ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if word.isEmpty || word == "adaptive" {
            return width > 0
                ? Slot(width: width, height: 0, adaptive: true, code: "")
                : Slot(width: 0, height: 0, adaptive: true, code: "unknown_width")
        }
        guard let fixed = sizes[word] else {
            return Slot(width: 0, height: 0, adaptive: false, code: "unknown_size")
        }
        return Slot(width: fixed.width, height: fixed.height, adaptive: false, code: "")
    }

    /// What the consent platform answered. `not_required` is a real state (a user outside the
    /// regions that require a form), and it is not the same as `obtained`.
    public static let consentWords: [String] = ["obtained", "required", "not_required", "unknown"]

    /// The consent words, ordered from the least to the most that is known to be permitted.
    /// `required` (a form is outstanding) is more restrictive than `not_required` (this user is
    /// outside the regions that need one), and `unknown` is the floor because nothing has been
    /// asked yet. The order is what makes the fold below a minimum.
    public static let consentRank: [String: Int] = [
        "unknown": 0, "required": 1, "not_required": 2, "obtained": 3,
    ]

    /// The MODULE's consent answer folded with what a caller asserted. Minimum wins.
    ///
    /// The module holds the platform's answer (UMP's `canRequestAds` and `consentStatus`); a
    /// caller — a component attribute, a page, a markup `session()` arg — holds an assertion.
    /// An assertion may only NARROW: a caller that says `obtained` over an `unknown` module
    /// answer is asking the build to request an ad on a consent nobody gathered, which is the
    /// policy breach this fold exists to make unreachable.
    ///
    /// An assertion that is absent, empty, or not one of the four words is not a consent
    /// statement at all, so the module's answer stands rather than being dragged to the floor
    /// by a typo. An unrecognised MODULE answer is `unknown`, because the module's word is the
    /// authority and an authority that cannot be read has answered nothing.
    public static func consentFold(module: String?, asserted: String? = nil) -> String {
        let own = (module ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let mine = consentRank[own] == nil ? "unknown" : own
        let claim = (asserted ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let claimRank = consentRank[claim] else { return mine }
        return claimRank < (consentRank[mine] ?? 0) ? claim : mine
    }

    public struct RequestGate: Equatable {
        public let request: Bool
        public let code: String
        public let recoverable: Bool
    }

    /// Whether an ad request may leave the device.
    ///
    /// ORDER IS THE LAW, and the consent rows are the reason: a build that requests an ad while
    /// a consent form is outstanding is a policy violation, not a missed impression, so
    /// `consent_required` is answered before anything that could read as a reason to proceed. A
    /// missing unit id is checked first only because it is a build mistake, and saying "ads are
    /// disabled" to someone who forgot the id sends them to the wrong file.
    ///
    /// The consent the gate judges is `consentFold(module:asserted:)` — the module's answer
    /// narrowed by the caller's, never widened by it.
    public static func requestGate(unitId: String?, enabled: Bool = true,
                                   consent: String = "unknown",
                                   asserted: String? = nil) -> RequestGate {
        if (unitId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return RequestGate(request: false, code: "missing_ad_unit", recoverable: false)
        }
        if !enabled { return RequestGate(request: false, code: "ads_disabled", recoverable: false) }
        switch consentFold(module: consent, asserted: asserted) {
        case "required":
            return RequestGate(request: false, code: "consent_required", recoverable: true)
        case "obtained", "not_required":
            return RequestGate(request: true, code: "", recoverable: false)
        default:
            return RequestGate(request: false, code: "consent_pending", recoverable: true)
        }
    }
}

// MARK: - 4 · The paywall: the vendor's packages, in one order, with one default

public enum VendorPaywall {

    /// The vendor's own package-type vocabulary, in the order a paywall lists them.
    public static let packageOrder: [String] = [
        "lifetime", "annual", "six_month", "three_month", "two_month", "monthly", "weekly", "custom", "unknown",
    ]

    /// Months per package type, for the per-month comparison. A type absent from this table is
    /// NOT comparable, and the fold refuses to compare it rather than inventing a length:
    /// `lifetime` has no term and `weekly` is not a whole number of months.
    public static let packageMonths: [String: Int] = [
        "annual": 12, "six_month": 6, "three_month": 3, "two_month": 2, "monthly": 1,
    ]

    public struct Package: Equatable {
        public let id: String
        public let type: String
        public let price: Double

        public init(id: String, type: String = "unknown", price: Double = 0) {
            self.id = id
            self.type = type
            self.price = price
        }
    }

    public struct Fold: Equatable {
        public let order: [String]
        /// What is selected when the paywall opens.
        public let defaultId: String
        /// The package that carries the "best value" badge, or "".
        public let badgeId: String
        /// That package's whole-percent saving against the monthly price, or 0.
        public let savings: Int
    }

    private static func rank(_ type: String) -> Int {
        let trimmed = type.trimmingCharacters(in: .whitespacesAndNewlines)
        return packageOrder.firstIndex(of: trimmed) ?? packageOrder.count
    }

    /// Order a paywall's packages and pick its default and its badge.
    ///
    /// The saving is computed against the MONTHLY package because that is the comparison a
    /// buyer makes, and only where the term is a whole number of months. With no monthly
    /// package there is nothing honest to compare against, so there is no badge: a "save 40%"
    /// against a price the store does not offer is the dark pattern this fold exists to not
    /// ship.
    public static func fold(_ packages: [Package], selected: String? = nil) -> Fold {
        let rows = packages.filter { !$0.id.isEmpty }
        let ranked = rows.enumerated().sorted { lhs, rhs in
            let a = rank(lhs.element.type), b = rank(rhs.element.type)
            if a != b { return a < b }
            if lhs.element.id != rhs.element.id { return lhs.element.id < rhs.element.id }
            return lhs.offset < rhs.offset
        }.map { $0.element }
        let order = ranked.map { $0.id }

        let choice = (selected ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let annual = ranked.first { $0.type == "annual" }
        let defaultId: String
        if order.contains(choice) {
            defaultId = choice
        } else if let annual {
            defaultId = annual.id
        } else {
            defaultId = order.first ?? ""
        }

        let base = ranked.first { $0.type == "monthly" }?.price ?? 0
        var badgeId = ""
        var savings = 0
        if base > 0 {
            for row in ranked {
                guard let months = packageMonths[row.type.trimmingCharacters(in: .whitespacesAndNewlines)],
                      months > 1, row.price > 0 else { continue }
                // Half-up, matching Math.round and Kotlin's floor(x + 0.5): the three
                // renderers must print the same percentage, not three roundings of one.
                let percent = (1 - row.price / Double(months) / base) * 100
                let rounded = percent < 0 ? -Int((-percent) + 0.5) : Int(percent + 0.5)
                if rounded > savings {
                    savings = rounded
                    badgeId = row.id
                }
            }
        }
        return Fold(order: order, defaultId: defaultId, badgeId: badgeId, savings: savings)
    }
}

// MARK: - 5 · The sign-in ladder: one step of a vendor auth attempt, inline

public enum VendorSignIn {

    /// Strategy display order. A password field beats a code the user has to go and fetch, and
    /// a passkey beats both where the device has one, so the ladder puts the cheapest gesture
    /// first and leaves the rest as alternates.
    public static let strategyOrder: [String] = [
        "passkey", "password", "email_code", "phone_code", "email_link", "reset_password_email_code",
    ]

    public static let steps: [String] = [
        "identifier", "first_factor", "second_factor", "new_password", "requirements", "complete", "restart",
    ]

    public struct Ladder: Equatable {
        public let step: String
        /// What the inline form puts on screen for this step.
        public let fields: [String]
        /// The offered strategies, ordered, with unknown ones kept and sorted after.
        public let strategies: [String]
        /// No further step: the attempt is finished, one way or the other.
        public let terminal: Bool
        public let code: String
    }

    private static func ordered(_ raw: [String]) -> [String] {
        var seen: [String] = []
        for value in raw {
            let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty && !seen.contains(name) { seen.append(name) }
        }
        let known = seen.filter { strategyOrder.contains($0) }
            .sorted { (strategyOrder.firstIndex(of: $0) ?? 0) < (strategyOrder.firstIndex(of: $1) ?? 0) }
        let rest = seen.filter { !strategyOrder.contains($0) }.sorted()
        return known + rest
    }

    /// One rung of a vendor sign-in attempt, as an inline component renders it.
    ///
    /// The vendor owns the attempt; this decides only what is on screen for the status the
    /// vendor last reported. An UNKNOWN status is a restart with a code rather than a blank
    /// screen: a vendor that adds a status next quarter must degrade to "start again", which is
    /// recoverable, and never to a form with no fields, which is not.
    public static func ladder(status: String?, strategies: [String] = [],
                              missing: [String] = []) -> Ladder {
        let list = ordered(strategies)
        func done(_ step: String, _ fields: [String], terminal: Bool = false, code: String = "") -> Ladder {
            Ladder(step: step, fields: fields, strategies: list, terminal: terminal, code: code)
        }

        switch (status ?? "").trimmingCharacters(in: .whitespacesAndNewlines) {
        case "needs_identifier":
            return done("identifier", ["identifier"])
        case "needs_first_factor":
            return done("first_factor", list.contains("password") ? ["password"] : ["code"])
        case "needs_second_factor":
            return done("second_factor", ["code"])
        case "needs_new_password":
            return done("new_password", ["password", "confirmation"])
        case "missing_requirements":
            let fields = missing.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            return done("requirements", fields.isEmpty ? ["identifier"] : fields)
        case "complete":
            return done("complete", [], terminal: true)
        case "abandoned":
            return done("restart", [], terminal: true)
        default:
            return done("restart", [], terminal: false, code: "unknown_status")
        }
    }
}

// MARK: - 6 · The scan gate: a live camera emits the same code sixty times a second

public enum VendorScan {

    public static let defaultDebounceMs = 1500

    public static let reasons: [String] = [
        "empty", "format_filtered", "duplicate_settled", "first", "changed", "repeat_debounced", "repeat",
    ]

    public struct Gate: Equatable {
        public let emit: Bool
        public let reason: String
    }

    /// Whether a decoded frame becomes an event.
    ///
    /// A live preview hands the same payload to the analyzer on every frame. Without this an
    /// `on:scan` handler that pushes a route fires thirty times before the transition starts,
    /// which is the bug every camera integration ships once. The order below is the law: an
    /// unwanted FORMAT is filtered before the mode is consulted, so a barcode in a QR-only
    /// surface never settles a `once` scanner and leaves it deaf to the code it wanted.
    public static func gate(value: String, format: String = "", at: Int = 0,
                            formats: [String] = [], mode: String = "once",
                            debounceMs: Int = VendorScan.defaultDebounceMs,
                            lastValue: String = "", lastAt: Int = 0,
                            emitted: Bool = false) -> Gate {
        if value.isEmpty { return Gate(emit: false, reason: "empty") }
        let wanted = formats.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if !wanted.isEmpty && !wanted.contains(format.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return Gate(emit: false, reason: "format_filtered")
        }
        if mode == "once" && emitted { return Gate(emit: false, reason: "duplicate_settled") }
        if lastValue.isEmpty { return Gate(emit: true, reason: "first") }
        if value != lastValue { return Gate(emit: true, reason: "changed") }
        return (at - lastAt) < debounceMs
            ? Gate(emit: false, reason: "repeat_debounced")
            : Gate(emit: true, reason: "repeat")
    }
}
