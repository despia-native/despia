//
//  VendorSession.swift — the inline-vendor-surface pure core, Swift twin of the Kotlin
//  `:core` VendorSession.kt and the web @despia-native/kernel vendor-session.ts. The law is the
//  corpus, `OpenSource/Conformance/inline-surfaces/stripe.json`
//  (architecture/proposals/inline-native-surfaces.md, parity/V01-stripe-inline.md).
//
//  Four folds, one law each:
//    1. VendorSessionRef.resolve — THE SECRET BOUNDARY. A component attribute declared
//       `role: "secret"` carries a REFERENCE to a module-held session, never the session.
//       Markup travels over OTA into the content plane, so a literal here is a credential
//       on a CDN. The rule is an ALLOWLIST OF REFERENCE SHAPES, not a denylist of key
//       prefixes: a denylist is bypassed by whatever key format the vendor ships next
//       quarter, an allowlist fails closed. Credential detection only sharpens the refusal
//       MESSAGE; it never decides whether a value is accepted.
//    2. VendorSessionMachine — ONE SESSION, TWO VIEWS. The overlay face (the vendor's
//       presented sheet) and the component face (the vendor's view inline) are two views
//       onto one state machine. Two machines that disagree is a DOUBLE CHARGE, so a second
//       attempt while one is in flight is refused, and every outcome notifies both faces
//       including one that already detached.
//    3. VendorCardField.fold — the vendor's per-part verdicts folded into ONE form field,
//       so a vendor input joins `<form>` validity through the same aggregation every other
//       field uses. It never carries card data — that is the PCI boundary.
//    4. VendorRetain — the keyed-identity law (SceneBind: "keys keeping their instantiated
//       subtree — identity survives reorder") applied to an expensive, stateful vendor
//       view: same key = same live view across any unrelated re-render.
//
//  No UIKit, no Stripe, no NSRegularExpression: this file is pure so the record lane can
//  run it headless and so the security rule is testable without a payment processor.
//
import Foundation

// MARK: - 1 · The secret boundary

public enum VendorSessionRef {

    /// Which reference plane the attribute names. `implicit` = the attribute was omitted,
    /// so the component binds its owning module's CURRENT session (the canonical spelling).
    public enum Kind: String, Equatable {
        case implicit = "implicit"
        case moduleContext = "module-context"
        case storeVar = "store-var"
        case global = "global"
        case config = "config"
        case attribute = "attribute"
        case scope = "scope"

        public var code: String { rawValue }
    }

    /// Why a reference was refused. Every one is LOUD — a secret attribute that silently
    /// accepted a literal would ship the literal.
    public enum Refusal: String, Error, Equatable {
        case missingReference = "missing_reference"
        case literalSecret = "literal_secret"
        case literalValue = "literal_value"
        case compoundTemplate = "compound_template"
        case unknownReference = "unknown_reference"

        public var code: String { rawValue }
    }

    /// The credential family a refusal names, so the message can say WHICH secret leaked.
    public enum Family: String, Equatable {
        case secretKey = "secret_key"
        case restrictedKey = "restricted_key"
        case clientSecret = "client_secret"
        case webhookSecret = "webhook_secret"
        case ephemeralKey = "ephemeral_key"
        case publishableKey = "publishable_key"
        case jwt = "jwt"

        public var code: String { rawValue }
    }

    public struct Ref: Equatable {
        public let kind: Kind
        public let path: String
        public init(kind: Kind, path: String) {
            self.kind = kind
            self.path = path
        }
    }

    /// A refusal plus the family that sharpens its message.
    public struct Rejection: Error, Equatable {
        public let refusal: Refusal
        public let family: Family?
        public init(_ refusal: Refusal, _ family: Family? = nil) {
            self.refusal = refusal
            self.family = family
        }
    }

    /// The transitional alias: `.state.` and `.context.` are ONE plane.
    private static let contextPlanes: Set<String> = ["context", "state"]

    private static func isWordChar(_ ch: Character) -> Bool {
        ch.isASCII && (ch.isNumber || (ch.isLetter && ch.isASCII) || ch == "_")
    }
    private static func isIdentStart(_ ch: Character) -> Bool {
        ch.isASCII && ((ch.isLetter && ch.isASCII) || ch == "_" || ch == "$")
    }
    private static func isIdentChar(_ ch: Character) -> Bool {
        isIdentStart(ch) || (ch.isASCII && ch.isNumber)
    }

    /// A token of `prefix` + at least `minTail` token characters, not glued to a word on
    /// the left. Hand-scanned rather than a regular expression so all three runtimes agree
    /// character for character (a `\b` is not the same thing in three regex engines).
    private static func hasKeyToken(_ text: [Character], _ prefix: [Character], _ minTail: Int) -> Bool {
        guard text.count >= prefix.count else { return false }
        var i = 0
        while i + prefix.count <= text.count {
            if Array(text[i..<(i + prefix.count)]) == prefix, i == 0 || !isWordChar(text[i - 1]) {
                var j = i + prefix.count
                var tail = 0
                while j < text.count, isWordChar(text[j]) { tail += 1; j += 1 }
                if tail >= minTail { return true }
            }
            i += 1
        }
        return false
    }

    /// `pi_..._secret_...` / `seti_..._secret_...` / `cs_..._secret_...` — the client
    /// secret, which is the one people paste into markup because it is "not the secret key".
    private static func hasClientSecret(_ text: [Character]) -> Bool {
        let marker = Array("_secret_")
        guard text.count > marker.count else { return false }
        var i = 0
        while i + marker.count <= text.count {
            if Array(text[i..<(i + marker.count)]) == marker {
                let after = i + marker.count
                if after < text.count, isWordChar(text[after]) {
                    var start = i
                    while start > 0, isWordChar(text[start - 1]) { start -= 1 }
                    let head = String(text[start..<i])
                    if head.hasPrefix("pi_") || head.hasPrefix("seti_")
                        || head.hasPrefix("cs_") || head.hasPrefix("src_") { return true }
                }
            }
            i += 1
        }
        return false
    }

    /// The credential family in `text`, MOST DANGEROUS FIRST — the order the message uses.
    public static func secretFamily(in text: String) -> Family? {
        let chars = Array(text)
        if hasKeyToken(chars, Array("sk_"), 8) { return .secretKey }
        if hasKeyToken(chars, Array("rk_"), 8) { return .restrictedKey }
        if hasClientSecret(chars) { return .clientSecret }
        if hasKeyToken(chars, Array("whsec_"), 8) { return .webhookSecret }
        if hasKeyToken(chars, Array("ek_"), 8) { return .ephemeralKey }
        if hasKeyToken(chars, Array("pk_"), 8) { return .publishableKey }
        if hasJwt(chars) { return .jwt }
        return nil
    }

    /// `eyJ...` with exactly two dots and three non-trivial segments: a JWT, which is what a
    /// Stream user token and a Clerk session token both are. Already REFUSED without this (it
    /// parses as a dotted path with an unpermitted root), so this only sharpens the message from
    /// `unknown_reference` to naming the credential the author pasted.
    private static func hasJwt(_ chars: [Character]) -> Bool {
        guard chars.count > 3, chars[0] == "e", chars[1] == "y", chars[2] == "J" else { return false }
        var dots = 0
        var run = 0
        for ch in chars {
            if ch == "." {
                if run < 8 { return false }
                dots += 1
                run = 0
                continue
            }
            if !isWordChar(ch) && ch != "-" { return false }
            run += 1
        }
        return dots == 2 && run >= 8
    }

    private static func splitPath(_ expression: String) -> [String]? {
        guard !expression.isEmpty else { return nil }
        let parts = expression.components(separatedBy: ".")
        for part in parts {
            guard let first = part.first, isIdentStart(first) else { return nil }
            for ch in part where !isIdentChar(ch) { return nil }
        }
        return parts
    }

    /// The ALLOWLIST. A permitted reference is one of these shapes and nothing else.
    private static func referenceKind(_ segments: [String]) -> Ref? {
        if segments.count >= 5, segments[0] == "dsx", segments[1] == "module" {
            var i = 3
            while i <= segments.count - 2 {
                if contextPlanes.contains(segments[i]) {
                    let chain = segments[2..<i].joined(separator: ".")
                    let member = segments[(i + 1)...].joined(separator: ".")
                    return Ref(kind: .moduleContext, path: "dsx.module.\(chain).context.\(member)")
                }
                i += 1
            }
            return nil
        }
        let path = segments.joined(separator: ".")
        if segments[0] == "dsx", segments.count >= 3 {
            switch segments[1] {
            case "variable":  return Ref(kind: .storeVar, path: path)
            case "global":    return Ref(kind: .global, path: path)
            case "config":    return Ref(kind: .config, path: path)
            case "attribute": return Ref(kind: .attribute, path: path)
            case "this":      return Ref(kind: .scope, path: path)
            default: break
            }
        }
        if segments[0] == "item", segments.count >= 2 { return Ref(kind: .scope, path: path) }
        return nil
    }

    /// Resolve what a `role: "secret"` attribute carries.
    ///
    /// `nil` (the attribute omitted) is the CANONICAL spelling: the component binds its
    /// owning module's current session, so the markup names no session at all. A present
    /// value must be exactly one reference — bare, or a single whole-value interpolation.
    public static func resolve(_ raw: String?) -> Result<Ref, Rejection> {
        guard let raw else { return .success(Ref(kind: .implicit, path: "")) }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Rejection(.missingReference)) }

        var expression = text
        if let open = text.range(of: "{{") {
            let close = text.range(of: "}}")
            let single = open.lowerBound == text.startIndex
                && close != nil
                && close!.upperBound == text.endIndex
                && close!.lowerBound > open.upperBound
                && text.range(of: "{{", range: open.upperBound..<text.endIndex) == nil
                && text.range(of: "}}", range: open.upperBound..<text.endIndex)?.lowerBound == close!.lowerBound
            if !single {
                guard let family = secretFamily(in: text) else { return .failure(Rejection(.compoundTemplate)) }
                return .failure(Rejection(.literalSecret, family))
            }
            expression = String(text[open.upperBound..<close!.lowerBound])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if expression.isEmpty { return .failure(Rejection(.missingReference)) }
        }

        let segments = splitPath(expression)
        if let segments, let ref = referenceKind(segments) { return .success(ref) }
        if let family = secretFamily(in: expression) { return .failure(Rejection(.literalSecret, family)) }
        return .failure(Rejection(segments == nil ? .literalValue : .unknownReference))
    }
}

// MARK: - 2 · One session, two views

/// The two faces a capability with a UI exposes. Canonical order — every notify audience
/// is emitted in it, so an audience cannot mean one thing on one renderer.
public let vendorViews: [String] = ["overlay", "inline"]

public enum VendorSessionState: String, Equatable {
    case idle, ready, confirming, succeeded, failed, canceled
    public var code: String { rawValue }
}

public enum VendorStepRefusal: String, Equatable {
    case alreadyOpen = "already_open"
    case notReady = "not_ready"
    case busy = "busy"
    case settled = "settled"
    case notConfirming = "not_confirming"
    case detachedView = "detached_view"

    public var code: String { rawValue }
}

/// The module's session, seen by both faces.
///
/// The action face presents the vendor modal OVER this session; the component face renders
/// the vendor view INTO the layout for the same session. Starting with one and finishing
/// with the other is coherent because there is only this object.
public final class VendorSessionMachine {

    public struct Step: Equatable {
        public let op: String
        public let view: String?
        public let code: String?
        public init(_ op: String, view: String? = nil, code: String? = nil) {
            self.op = op
            self.view = view
            self.code = code
        }
    }

    public struct StepResult: Equatable {
        public let ok: Bool
        public let state: String
        public let notify: [String]
        public let attempts: Int
        public let outcome: String?
        public let by: String?
        public let code: String?
        public let error: String?

        init(ok: Bool, state: String, notify: [String] = [], attempts: Int = 0,
             outcome: String? = nil, by: String? = nil, code: String? = nil, error: String? = nil) {
            self.ok = ok
            self.state = state
            self.notify = notify
            self.attempts = attempts
            self.outcome = outcome
            self.by = by
            self.code = code
            self.error = error
        }
    }

    private var current: VendorSessionState = .idle
    private var attachedViews: [String] = []
    private var confirmingBy: String?
    private var attemptCount = 0

    public init() {}

    public var state: String { current.code }
    public var attempts: Int { attemptCount }
    public var confirmingView: String? { confirmingBy }
    public var attached: [String] { vendorViews.filter { attachedViews.contains($0) } }

    /// Attached faces plus the in-flight originator, canonically ordered. A face that
    /// unmounted mid-confirm is STILL owed its outcome — dropping it is how an app charges
    /// a card and never tells the user.
    private func audience() -> [String] {
        var live = Set(attachedViews)
        if let confirmingBy { live.insert(confirmingBy) }
        return vendorViews.filter { live.contains($0) }
    }

    private var isSettled: Bool { current == .succeeded || current == .canceled }

    private func refuse(_ refusal: VendorStepRefusal) -> StepResult {
        StepResult(ok: false, state: current.code, error: refusal.code)
    }

    @discardableResult
    public func step(_ step: Step) -> StepResult {
        switch step.op {
        case "open":
            guard current == .idle else { return refuse(isSettled ? .settled : .alreadyOpen) }
            current = .ready
            return StepResult(ok: true, state: current.code, notify: audience(), attempts: attemptCount)

        case "attach":
            guard let view = step.view else { return refuse(.detachedView) }
            if !attachedViews.contains(view) { attachedViews.append(view) }
            return StepResult(ok: true, state: current.code, attempts: attemptCount)

        // Detaching NEVER cancels. A vendor view that unmounts on an unrelated re-render
        // must not abandon an authorization in flight.
        case "detach":
            guard let view = step.view else { return refuse(.detachedView) }
            attachedViews.removeAll { $0 == view }
            return StepResult(ok: true, state: current.code, attempts: attemptCount)

        case "start":
            guard let view = step.view else { return refuse(.detachedView) }
            if current == .idle { return refuse(.notReady) }
            if isSettled { return refuse(.settled) }
            if current == .confirming { return refuse(.busy) }
            guard attachedViews.contains(view) else { return refuse(.detachedView) }
            current = .confirming
            confirmingBy = view
            attemptCount += 1
            return StepResult(ok: true, state: current.code, notify: audience(),
                              attempts: attemptCount, by: view)

        case "complete", "fail":
            guard current == .confirming else { return refuse(isSettled ? .settled : .notConfirming) }
            let by = confirmingBy
            let told = audience()
            confirmingBy = nil
            let succeeded = step.op == "complete"
            current = succeeded ? .succeeded : .failed
            return StepResult(ok: true, state: current.code, notify: told, attempts: attemptCount,
                              outcome: succeeded ? "succeeded" : "failed", by: by,
                              code: succeeded ? nil : (step.code ?? "card_declined"))

        // Dismissing the sheet cancels the ATTEMPT, not the session: the intent stays
        // reusable, which is what the vendor SDK actually does. Cancelling with nothing in
        // flight abandons the session, and that IS terminal.
        case "cancel":
            if isSettled { return refuse(.settled) }
            if current == .idle { return refuse(.notReady) }
            if current == .confirming {
                let by = confirmingBy
                let told = audience()
                confirmingBy = nil
                current = .ready
                return StepResult(ok: true, state: current.code, notify: told,
                                  attempts: attemptCount, outcome: "canceled", by: by)
            }
            let told = audience()
            current = .canceled
            return StepResult(ok: true, state: current.code, notify: told,
                              attempts: attemptCount, outcome: "canceled", by: step.view)

        default:
            return refuse(.notConfirming)
        }
    }
}

// MARK: - 3 · The field-validity fold

public enum VendorCardField {

    /// Canonical part order: the order the vendor's own field traverses, and the order the
    /// fold reports the FIRST offender in.
    public static let parts: [String] = ["number", "expiry", "cvc", "postalCode"]

    /// The incomplete messages, one per part. Data, so three runtimes cannot word them
    /// differently; pinned in the corpus.
    public static let incompleteMessages: [String: String] = [
        "number": "Your card number is incomplete.",
        "expiry": "Your card's expiration date is incomplete.",
        "cvc": "Your card's security code is incomplete.",
        "postalCode": "Your postal code is incomplete.",
    ]

    public static let requiredMessage = "Required"

    /// One part as the VENDOR reports it. `error` is the vendor's own message and is
    /// carried through verbatim — re-wording it is the text twin of relabelling its
    /// accessibility tree.
    public struct PartState: Equatable {
        public let part: String
        public let empty: Bool
        public let complete: Bool
        public let error: String
        public init(part: String, empty: Bool = true, complete: Bool = false, error: String = "") {
            self.part = part
            self.empty = empty
            self.complete = complete
            self.error = error
        }
    }

    public struct Fold: Equatable {
        public let complete: Bool
        public let valid: Bool
        public let pristine: Bool
        public let error: String
        public let offender: String
        /// what a form aggregates — never card data: "complete" or "". THE PCI BOUNDARY.
        public let value: String
    }

    /// The forms core's field state, so a vendor input rides the SAME aggregation as
    /// `<field>` — one validity system, not two.
    public struct FormField: Equatable {
        public let name: String
        public let value: String
        public let initial: String
        public let validate: String
        public let message: String
    }

    /// Fold the vendor's per-part verdicts into ONE form field.
    ///
    /// Precedence: a vendor ERROR beats an incomplete part (the vendor knows "4242…4241 is
    /// not a card"; the fold only knows "not finished"), and within each tier the first
    /// part in canonical order owns the message. A pristine, non-required field is valid
    /// and silent — a card form that shouts before it is touched is the bug users report
    /// as "broken".
    public static func fold(_ states: [PartState], required: Bool = true) -> Fold {
        var byName: [String: PartState] = [:]
        for state in states where byName[state.part] == nil { byName[state.part] = state }
        let declared = parts.filter { byName[$0] != nil }

        let pristine = !declared.isEmpty && declared.allSatisfy { byName[$0]!.empty }
        let complete = !declared.isEmpty && declared.allSatisfy { byName[$0]!.complete }

        for part in declared where !byName[part]!.error.isEmpty {
            return Fold(complete: complete, valid: false, pristine: pristine,
                        error: byName[part]!.error, offender: part, value: "")
        }
        if complete {
            return Fold(complete: true, valid: true, pristine: false, error: "", offender: "", value: "complete")
        }
        if pristine {
            return required
                ? Fold(complete: false, valid: false, pristine: true,
                       error: requiredMessage, offender: declared.first ?? "", value: "")
                : Fold(complete: false, valid: true, pristine: true, error: "", offender: "", value: "")
        }
        for part in declared where !byName[part]!.complete {
            return Fold(complete: false, valid: false, pristine: false,
                        error: incompleteMessages[part] ?? requiredMessage, offender: part, value: "")
        }
        return Fold(complete: complete, valid: false, pristine: pristine,
                    error: requiredMessage, offender: declared.first ?? "", value: "")
    }

    public static func formField(_ name: String, _ fold: Fold) -> FormField {
        FormField(name: name, value: fold.value, initial: "",
                  validate: fold.error.isEmpty ? "" : "required", message: fold.error)
    }
}

// MARK: - 4 · Keyed identity

public enum VendorRetain {

    /// The reconcile verdict — deliberately the `SceneBind` shape, because it is the same law.
    public struct Diff: Equatable {
        public let mounted: [String]
        public let retained: [String]
        public let released: [String]
    }

    /// The identity a vendor view is retained under.
    ///
    /// An explicit `key=` wins outright, so an author can keep one live field across a list
    /// reorder. Without one the identity is tag + session + position: two
    /// `<stripe.CardInput/>` on the same session are distinguishable, and the same one at
    /// the same position across an unrelated re-render is the SAME view. The key is never
    /// the session VALUE — that would put a secret in a diff log.
    public static func key(tag: String, key: String? = nil,
                           session: String? = nil, index: Int = 0) -> String {
        let explicit = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !explicit.isEmpty { return "\(tag)#\(explicit)" }
        let reference = (session ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(tag)@\(reference)[\(index)]"
    }

    /// A key present on both sides keeps its live vendor view across ANY reorder; a new key
    /// mounts; a vanished key releases. Pure — the caller owns the actual views.
    public static func reconcile(previous: [String], next: [String]) -> Diff {
        let before = Set(previous)
        let now = Set(next)
        var mounted: [String] = []
        var retained: [String] = []
        var released: [String] = []
        var seen = Set<String>()
        for key in next {
            guard seen.insert(key).inserted else { continue }
            if before.contains(key) { retained.append(key) } else { mounted.append(key) }
        }
        for key in previous where !now.contains(key) && !released.contains(key) { released.append(key) }
        return Diff(mounted: mounted, retained: retained, released: released)
    }
}
