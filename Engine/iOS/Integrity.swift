//
//  Integrity.swift — the SHARED PURE CORE behind Core/Integrity (F17.4), and the reference
//  renderer's leg of it. Twin of :core Integrity.kt and the web kernel's integrity.ts.
//
//  WHAT THIS CAPABILITY ACTUALLY IS. Mandatory/Security answers "does this device look tampered
//  with?", which a determined attacker simply lies about, because the code asking the question
//  runs on the machine being questioned. App Attest and Play Integrity answer a DIFFERENT
//  question: they hand back a token the DEVELOPER'S BACKEND verifies with Apple or Google, so
//  the trust anchor is off-device. Those are not the same claim and this module never blurs
//  them.
//
//  THEREFORE THERE IS NO CLIENT-SIDE VERDICT, and this file contains no function that could be
//  mistaken for one. What it does contain is the ENVELOPE: the exact JSON shape a backend
//  receives, identical on both platforms, so a server is written once against a stable contract
//  instead of sniffing which mobile OS sent the request.
//
//  The base64url codec is shared with PasskeysCore rather than reimplemented: the kernel is one
//  unit, both capabilities put server-bound bytes on the same bus, and two codecs that agree
//  today are two codecs that drift.
//
//  Pure Foundation. Pinned by OpenSource/Conformance/integrity/attestation.json.
//
import Foundation

public enum IntegrityCore {

    /// Who can vouch for this app, per platform. `none` is a first-class answer, not an error.
    public static let providers = ["appattest", "playintegrity", "none"]

    /// The token formats a backend must be able to tell apart. The provider alone is not enough:
    /// App Attest issues two shapes for two ceremonies, and a server that treats an assertion as
    /// an attestation fails verification with an opaque error.
    public static let formats = ["apple.attest", "apple.assert", "google.playintegrity"]

    /// Play Integrity's nonce ceiling is the BINDING constraint across both platforms: Apple
    /// hashes the challenge so any length works there. One rule, so a challenge that works on
    /// one platform cannot fail on the other.
    public static let minChallengeBytes = 16
    public static let maxChallengeBytes = 500

    /// A key reference is an opaque platform handle; the cap is a sanity bound, not a spec value.
    public static let maxKeyRefChars = 512

    /// The sentence every caller gets back with a token. Enforcing an attestation result on the
    /// device that produced it is theatre, and a developer who believes otherwise ships an app a
    /// five-line patch defeats. Saying so in the payload is cheaper than saying it in
    /// documentation nobody reads.
    public static let advisory =
        "This token is only meaningful once your backend verifies it with Apple or Google. "
        + "Nothing decided on the device is a security decision."

    public static let messages: [String: String] = [
        "invalid_challenge": "That is not a usable attestation challenge.",
        "invalid_key_ref": "That is not a usable key reference.",
        "unknown_provider": "That is not an attestation provider this platform has.",
        "unknown_format": "That is not a ceremony this provider performs.",
    ]

    public struct Refusal: Error, Equatable {
        public let code: String
        public let detail: String?
        public init(_ code: String, _ detail: String? = nil) {
            self.code = code
            self.detail = detail
        }
        public var message: String {
            if let detail, !detail.isEmpty { return detail }
            return IntegrityCore.messages[code] ?? code
        }
    }

    public struct Envelope: Equatable {
        public let provider: String
        public let format: String
        public let token: String
        public let challenge: String
        public let keyRef: String
        public let advisory: String
    }

    /// Which attestation service, if any, can vouch for this app on a given platform.
    public static func provider(for platform: Any?) -> String {
        let name = stringOf(platform).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch name {
        case "ios", "ipados", "macos", "tvos", "watchos": return "appattest"
        case "android": return "playintegrity"
        default: return "none"
        }
    }

    /// The format word for a provider and a ceremony kind. Refuses rather than guessing: a
    /// backend that receives the wrong word fails verification with an opaque platform error.
    public static func format(_ provider: Any?, _ kind: Any?) -> Result<String, Refusal> {
        let p = stringOf(provider).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let k = stringOf(kind).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if p == "appattest" && k == "attest" { return .success("apple.attest") }
        if p == "appattest" && k == "assert" { return .success("apple.assert") }
        // Play Integrity draws no attest/assert distinction: one request, one token, every time.
        if p == "playintegrity" && (k == "attest" || k == "assert") {
            return .success("google.playintegrity")
        }
        if p != "appattest" && p != "playintegrity" { return .failure(Refusal("unknown_provider", p)) }
        return .failure(Refusal("unknown_format", "\(p)/\(k)"))
    }

    /// A challenge is base64url and long enough to be unguessable, with ONE length rule across
    /// both platforms. A challenge the client invented is worthless: it must come from the server
    /// that will later verify the token, which is why there is no "generate a challenge"
    /// function anywhere in this module.
    public static func normalizeChallenge(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Refusal("invalid_challenge", "a challenge is required")) }
        guard let bytes = PasskeysCore.base64UrlDecode(text) else {
            return .failure(Refusal("invalid_challenge", "a challenge is base64url"))
        }
        if bytes.count < minChallengeBytes {
            return .failure(Refusal("invalid_challenge", "a challenge is at least \(minChallengeBytes) bytes"))
        }
        if bytes.count > maxChallengeBytes {
            return .failure(Refusal("invalid_challenge", "a challenge is at most \(maxChallengeBytes) bytes"))
        }
        return .success(PasskeysCore.base64UrlEncode(bytes))
    }

    /// The handle `attest` produced and `assert` needs back. Opaque: its INTERNAL shape is
    /// Apple's business, so only emptiness and absurd length are refused.
    public static func normalizeKeyRef(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Refusal("invalid_key_ref", "a key reference is required")) }
        if text.count > maxKeyRefChars {
            return .failure(Refusal("invalid_key_ref",
                                    "a key reference is at most \(maxKeyRefChars) characters"))
        }
        for c in text {
            let ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
                || c == "-" || c == "_" || c == "+" || c == "/" || c == "="
            if !ok { return .failure(Refusal("invalid_key_ref", "a key reference is a base64 handle")) }
        }
        return .success(text)
    }

    /// Build the payload the backend receives. THE SHAPE IS THE PRODUCT: a server written
    /// against this envelope does not care which mobile OS sent the request, because `format`
    /// tells it which verification call to make and every field is present on both platforms
    /// (empty where a platform has no such thing, never absent). A sometimes-missing field is a
    /// server branch nobody remembers to write.
    public static func envelope(_ provider: Any?, _ kind: Any?, _ token: Any?,
                                _ challenge: String, _ keyRef: String) -> Result<Envelope, Refusal> {
        switch format(provider, kind) {
        case .failure(let refusal):
            return .failure(refusal)
        case .success(let resolved):
            return .success(Envelope(
                provider: stringOf(provider).trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                format: resolved,
                token: stringOf(token),
                challenge: challenge,
                keyRef: keyRef,
                advisory: advisory))
        }
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }
}
