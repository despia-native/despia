//
//  StackOrientation.swift — the shared `lockOrientation=` / orientation-module core: the
//  vocabulary fold + the claim stack. The law is the corpus,
//  `OpenSource/Conformance/input/orientation.json` (parity/F07-orientation.md); the Kotlin
//  twin is `:core` StackOrientation.kt and the web twin is @despia-native/kernel's
//  resolveOrientation / OrientationClaimStack.
//
//  Everything platform-shaped lives OUTSIDE this file. The Orientation module applies a
//  resolved mask through `UIWindowScene.requestGeometryUpdate` (and the hosting controller's
//  `supportedInterfaceOrientations` override, which is what makes it stick); the router drives
//  claim/release off surface appear/disappear. Keeping the DECISION separate from the PLUMBING
//  is what lets one corpus judge three renderers.
//
//  No UIKit import: this file is pure so the record lane can run it headless.
//
import Foundation

public enum StackOrientation {

    /// The canonical order every resolved mask is emitted in, regardless of the order the app
    /// declared its supported orientations. A stable order is what makes `primary` stable.
    public static let canonical: [String] = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"]

    /// A resolved lock: the full mask the platform is asked to allow, and the orientation the
    /// device rotates TO (the first surviving entry in canonical order).
    public struct Resolved: Equatable {
        public let mask: [String]
        public let primary: String
        public init(mask: [String], primary: String) {
            self.mask = mask
            self.primary = primary
        }
    }

    /// Why a fold refused. Both are LOUD — a lock that silently no-ops is the hardest
    /// orientation bug there is, and it is exactly what the third-party libraries do.
    public enum Refusal: String, Error, Equatable {
        case unknownOrientation = "unknown_orientation"
        case notAllowed = "not_allowed"

        /// The stable machine id the module reports and the corpus pins.
        public var code: String { rawValue }
    }

    /// The RUNTIME override the Orientation module publishes, as a canonical-order mask.
    ///
    /// The host asks the OS question (`supportedInterfaceOrientationsFor`) and answers it from
    /// here FIRST, falling back to its build-time config when this is nil — so the host stays a
    /// bootloader that delegates the decision, and the module owns the policy. With the module
    /// excluded this is never written, the fallback is the only path, and behaviour is
    /// byte-identical to before the module existed (Article 7).
    ///
    /// Main-actor by convention: only the module writes it, and only from the main queue where
    /// the geometry request is made.
    public private(set) static var activeMask: [String]?

    /// Publish (or clear, with nil) the runtime override. Returns whether it changed.
    @discardableResult
    public static func setActiveMask(_ mask: [String]?) -> Bool {
        guard activeMask != mask else { return false }
        activeMask = mask
        return true
    }

    /// Fold one `to` word against the app's build-time allowed set.
    ///
    /// `to` is exact-case after trimming — `Portrait` is not `portrait`, because a
    /// case-insensitive vocabulary is a vocabulary nobody can lint. `landscape` expands to both
    /// landscape orientations, `all` to the whole allowed set, `current` to the live
    /// orientation. The expansion is intersected with `allowed` in canonical order; an empty
    /// intersection throws `.notAllowed` rather than quietly doing nothing.
    public static func resolve(_ to: String?, allowed: [String], current: String? = nil) throws -> Resolved {
        let word = (to ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let expanded: [String]
        switch word {
        case "":           throw Refusal.unknownOrientation
        case "all":        expanded = canonical
        case "landscape":  expanded = ["landscapeLeft", "landscapeRight"]
        case "current":
            let live = (current ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            expanded = canonical.contains(live) ? [live] : []
        default:
            guard canonical.contains(word) else { throw Refusal.unknownOrientation }
            expanded = [word]
        }
        let permitted = Set(allowed
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { canonical.contains($0) })
        let mask = canonical.filter { expanded.contains($0) && permitted.contains($0) }
        guard let primary = mask.first else { throw Refusal.notAllowed }
        return Resolved(mask: mask, primary: primary)
    }
}

/// The claim stack — the actual feature behind `lockOrientation=`.
///
/// A surface claims on appear and releases on disappear, so every dismissal path (button pop,
/// edge-swipe back, modal drag-dismiss, deep-link stack replacement, a backgrounded app
/// returning) reverts through ONE funnel instead of each screen remembering to undo itself.
///
/// The effective lock is the LAST live entry, or nil for the app default. A re-claim by a live
/// id replaces in place, so a screen re-declaring can never jump above a sheet it presented.
/// Releasing a mid-stack entry leaves the top standing.
public final class OrientationClaimStack {

    /// The imperative `orientation.unlock()` slot, so the module and the attribute share one stack.
    public static let imperativeID = "imperative"

    private struct Claim {
        let id: String
        var to: String
    }

    private var claims: [Claim] = []

    public init() {}

    /// The `to` word currently in force, or nil when nothing is claimed.
    public var effective: String? { claims.last?.to }

    /// Claim (or re-claim, in place) for `id`. Returns the new `effective`.
    @discardableResult
    public func claim(_ id: String, to: String) -> String? {
        if let index = claims.firstIndex(where: { $0.id == id }) {
            claims[index].to = to
        } else {
            claims.append(Claim(id: id, to: to))
        }
        return effective
    }

    /// Release `id`. Unknown ids are a no-op — a surface may release without ever claiming.
    @discardableResult
    public func release(_ id: String) -> String? {
        claims.removeAll { $0.id == id }
        return effective
    }

    /// Drop every claim — the deep-link-replaces-the-stack path.
    @discardableResult
    public func reset() -> String? {
        claims.removeAll()
        return effective
    }
}
