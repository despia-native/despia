//
//  Passkeys.swift — the SHARED PURE CORE behind Core/Passkeys (F17.3), and the reference
//  renderer's leg of it. Twin of :core Passkeys.kt and the web kernel's passkeys.ts.
//
//  WHY THIS IS A CORE AND NOT THREE ADAPTERS. WebAuthn's data model is binary, and the three
//  platforms disagree about how those bytes cross the language boundary — the browser wants
//  BufferSource, AuthenticationServices wants Data, Credential Manager wants base64url inside
//  a JSON document. If each facet did its own conversion, a challenge that round-trips on one
//  platform would be padded, truncated or re-encoded on another and the server would reject
//  the assertion with no clue why. Base64url is therefore the ONE wire form on the DSX bus,
//  its codec lives here, and the round trip is corpus-pinned
//  (OpenSource/Conformance/passkeys/ceremony.json).
//
//  NOT Data(base64Encoded:). Foundation's decoder rejects unpadded input outright, which is
//  exactly the form WebAuthn JSON uses, and its encoder emits the standard alphabet. The codec
//  is written out longhand so the three runtimes cannot drift.
//
//  Pure Foundation: no AuthenticationServices here, so the same decisions serve the Android
//  and web twins. The ceremony itself lives in the module's swift/ facet.
//
import Foundation

public enum PasskeysCore {

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    private static let alphabetIndex: [Character: Int] = {
        var map: [Character: Int] = [:]
        for (i, c) in alphabet.enumerated() { map[c] = i }
        return map
    }()

    /// 16 bytes is the floor every WebAuthn hardening guide names; a replayable 4-byte nonce
    /// defeats the whole ceremony.
    public static let minChallengeBytes = 16
    public static let maxChallengeBytes = 1024

    /// The spec's own ceiling on a user handle.
    public static let maxUserIdBytes = 64

    public static let minTimeoutMs = 15000
    public static let defaultTimeoutMs = 60000
    public static let maxTimeoutMs = 600000

    public static let attestations = ["none", "indirect", "direct", "enterprise"]
    public static let mediations = ["silent", "optional", "conditional", "required"]
    public static let verifications = ["required", "preferred", "discouraged"]
    public static let residentKeys = ["discouraged", "preferred", "required"]

    public static let messages: [String: String] = [
        "invalid_rp_id": "That is not a relying-party domain.",
        "invalid_challenge": "That is not a usable challenge.",
        "invalid_user": "That is not a usable user handle.",
        "invalid_credential": "That is not a base64url credential id.",
        "unknown_attestation": "That is not an attestation preference.",
        "unknown_mediation": "That is not a mediation mode.",
        "unknown_verification": "That is not a user-verification preference.",
        "unknown_resident_key": "That is not a resident-key preference.",
    ]

    public struct Refusal: Error, Equatable {
        public let code: String
        public let detail: String?
        public init(_ code: String, _ detail: String? = nil) {
            self.code = code
            self.detail = detail
        }
        /// The sentence to show, preferring the specific detail over the generic message.
        public var message: String {
            if let detail, !detail.isEmpty { return detail }
            return PasskeysCore.messages[code] ?? code
        }
    }

    public struct User: Equatable {
        public let id: String
        public let name: String
        public let displayName: String
    }

    public struct CreateOptions: Equatable {
        public let rpId: String
        public let user: User
        public let challenge: String
        public let attestation: String
        public let userVerification: String
        public let residentKey: String
        public let excludeCredentials: [String]
        public let timeoutMs: Int
    }

    public struct GetOptions: Equatable {
        public let rpId: String
        public let challenge: String
        public let mediation: String
        public let userVerification: String
        public let allowCredentials: [String]
        public let timeoutMs: Int
    }

    // MARK: - base64url, the one wire form

    /// Encode bytes as UNPADDED base64url. Unpadded because the WebAuthn JSON serialisations
    /// all are, and a stray `=` is the most common cause of a server rejecting a valid
    /// assertion.
    public static func base64UrlEncode(_ bytes: [Int]) -> String {
        var out = ""
        let n = bytes.count
        var i = 0
        while i < n {
            let b0 = bytes[i] & 0xff
            let b1 = i + 1 < n ? bytes[i + 1] & 0xff : 0
            let b2 = i + 2 < n ? bytes[i + 2] & 0xff : 0
            out.append(alphabet[b0 >> 2])
            out.append(alphabet[((b0 & 0x03) << 4) | (b1 >> 4)])
            if i + 1 < n { out.append(alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)]) }
            if i + 2 < n { out.append(alphabet[b2 & 0x3f]) }
            i += 3
        }
        return out
    }

    /// Encode raw `Data` the same way, for the platform facet handing back an assertion.
    public static func base64UrlEncode(_ data: Data) -> String {
        base64UrlEncode(data.map { Int($0) })
    }

    /// Decode base64url to bytes, or nil when the text is not base64url.
    ///
    /// TOLERANT ON INPUT, STRICT ON OUTPUT: standard base64's `+` and `/` are accepted and so
    /// is `=` padding, because half the world's servers emit them, but the encoder never
    /// produces either. One leftover character cannot be a base64 group, so it is nil rather
    /// than a silently truncated buffer.
    public static func base64UrlDecode(_ text: Any?) -> [Int]? {
        guard let input = text as? String else { return nil }
        var clean: [Character] = []
        for c in input {
            if c == "=" || c == "\n" || c == "\r" || c == " " { continue }
            if c == "+" { clean.append("-"); continue }
            if c == "/" { clean.append("_"); continue }
            guard alphabetIndex[c] != nil else { return nil }
            clean.append(c)
        }
        if clean.count % 4 == 1 { return nil }
        var out: [Int] = []
        var i = 0
        while i < clean.count {
            let end = min(i + 4, clean.count)
            let chunk = Array(clean[i..<end])
            let v0 = alphabetIndex[chunk[0]] ?? 0
            let v1 = chunk.count > 1 ? (alphabetIndex[chunk[1]] ?? 0) : 0
            let v2 = chunk.count > 2 ? (alphabetIndex[chunk[2]] ?? 0) : -1
            let v3 = chunk.count > 3 ? (alphabetIndex[chunk[3]] ?? 0) : -1
            out.append(((v0 << 2) | (v1 >> 4)) & 0xff)
            if v2 >= 0 { out.append(((v1 << 4) | (v2 >> 2)) & 0xff) }
            if v3 >= 0 { out.append(((v2 << 6) | v3) & 0xff) }
            i += 4
        }
        return out
    }

    /// The platform facet needs `Data`, not `[Int]`; same decision, one conversion.
    public static func base64UrlData(_ text: Any?) -> Data? {
        guard let bytes = base64UrlDecode(text) else { return nil }
        return Data(bytes.map { UInt8($0 & 0xff) })
    }

    /// How many bytes a base64url string carries, or -1 when it is not base64url.
    public static func base64UrlByteLength(_ text: Any?) -> Int {
        base64UrlDecode(text)?.count ?? -1
    }

    // MARK: - the relying party

    /// Normalize a relying-party id: a bare registrable domain, lowercase, no scheme, no port,
    /// no path. Every one of those is a real mistake, and each produces a ceremony that fails
    /// on device with an "origin mismatch" that names nothing useful. A single label
    /// (`localhost`) is allowed on purpose: it is the only rpId that works before deployment.
    public static func normalizeRpId(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return .failure(Refusal("invalid_rp_id", "an rpId is required")) }
        if text.contains("://") { return .failure(Refusal("invalid_rp_id", "an rpId is a domain, not a URL")) }
        if text.contains("/") || text.contains("?") || text.contains("#") {
            return .failure(Refusal("invalid_rp_id", "an rpId carries no path"))
        }
        if text.contains(":") { return .failure(Refusal("invalid_rp_id", "an rpId carries no port")) }
        if text.count > 253 { return .failure(Refusal("invalid_rp_id", "too long to be a domain")) }
        for label in text.components(separatedBy: ".") {
            if label.isEmpty || label.count > 63 {
                return .failure(Refusal("invalid_rp_id", "malformed domain label"))
            }
            if label.hasPrefix("-") || label.hasSuffix("-") {
                return .failure(Refusal("invalid_rp_id", "a domain label cannot start or end with a hyphen"))
            }
            for c in label {
                let ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-"
                if !ok {
                    return .failure(Refusal("invalid_rp_id", "a domain label is letters, digits and hyphens"))
                }
            }
        }
        return .success(text)
    }

    /// A challenge is base64url and long enough to be unguessable. Both halves matter: a
    /// hex-encoded challenge that happens to decode is still the wrong bytes on the wire.
    public static func normalizeChallenge(_ raw: Any?) -> Result<String, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Refusal("invalid_challenge", "a challenge is required")) }
        guard let bytes = base64UrlDecode(text) else {
            return .failure(Refusal("invalid_challenge", "a challenge is base64url"))
        }
        if bytes.count < minChallengeBytes {
            return .failure(Refusal("invalid_challenge", "a challenge is at least \(minChallengeBytes) bytes"))
        }
        if bytes.count > maxChallengeBytes {
            return .failure(Refusal("invalid_challenge", "a challenge is at most \(maxChallengeBytes) bytes"))
        }
        return .success(base64UrlEncode(bytes))
    }

    /// The user handle the authenticator stores. `id` is OPAQUE BYTES and must not be an email
    /// or a username: it is written into the authenticator, syncs to the user's other devices,
    /// and can never be changed. PII there is a privacy defect that outlives the account.
    public static func normalizeUser(_ raw: Any?) -> Result<User, Refusal> {
        guard let map = raw as? [String: Any] else {
            return .failure(Refusal("invalid_user", "a user object is required"))
        }
        let id = stringOf(map["id"]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let bytes = base64UrlDecode(id), !bytes.isEmpty else {
            return .failure(Refusal("invalid_user", "user.id is base64url bytes, not a username"))
        }
        if bytes.count > maxUserIdBytes {
            return .failure(Refusal("invalid_user", "user.id is at most \(maxUserIdBytes) bytes"))
        }
        let name = stringOf(map["name"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            return .failure(Refusal("invalid_user", "user.name is what the account picker shows"))
        }
        let display = stringOf(map["displayName"]).trimmingCharacters(in: .whitespacesAndNewlines)
        return .success(User(id: base64UrlEncode(bytes), name: name,
                             displayName: display.isEmpty ? name : display))
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }

    private static func foldWord(_ raw: Any?, _ vocabulary: [String], _ fallback: String,
                                 _ refusalCode: String) -> Result<String, Refusal> {
        let lowered = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let text = String(lowered.filter { !$0.isWhitespace && $0 != "-" && $0 != "_" })
        if text.isEmpty { return .success(fallback) }
        for word in vocabulary where word.lowercased() == text { return .success(word) }
        return .failure(Refusal(refusalCode, stringOf(raw)))
    }

    public static func foldAttestation(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, attestations, "none", "unknown_attestation")
    }

    public static func foldMediation(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, mediations, "optional", "unknown_mediation")
    }

    public static func foldUserVerification(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, verifications, "preferred", "unknown_verification")
    }

    public static func foldResidentKey(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, residentKeys, "preferred", "unknown_resident_key")
    }

    /// Clamp rather than refuse: a caller asking for an hour wants "as long as the platform
    /// will allow", and refusing that is a worse answer than honouring the ceiling.
    public static func clampTimeout(_ raw: Any?) -> Int {
        var n: Double
        switch raw {
        case let v as Double: n = v
        case let v as Int: n = Double(v)
        case let v as NSNumber: n = v.doubleValue
        case let v as String: n = Double(v.trimmingCharacters(in: .whitespaces)) ?? 0
        default: return defaultTimeoutMs
        }
        guard n.isFinite, n > 0 else { return defaultTimeoutMs }
        if n < Double(minTimeoutMs) { return minTimeoutMs }
        if n > Double(maxTimeoutMs) { return maxTimeoutMs }
        return Int(n.rounded())
    }

    /// Credential ids named in an allow or exclude list. An unparseable one is refused rather
    /// than dropped: a silently shortened allow list reads to the user as "this device has no
    /// passkey" and there is nothing to debug.
    public static func normalizeCredentialIds(_ raw: Any?) -> Result<[String], Refusal> {
        var list: [Any?] = []
        if let array = raw as? [Any] { list = array.map { $0 as Any? } }
        else if let text = raw as? String, !text.isEmpty { list = [text] }

        var out: [String] = []
        for entry in list {
            var text = ""
            if let s = entry as? String { text = s.trimmingCharacters(in: .whitespacesAndNewlines) }
            else if let map = entry as? [String: Any] {
                text = stringOf(map["id"]).trimmingCharacters(in: .whitespacesAndNewlines)
            } else { text = stringOf(entry).trimmingCharacters(in: .whitespacesAndNewlines) }

            guard let bytes = base64UrlDecode(text), !bytes.isEmpty else {
                return .failure(Refusal("invalid_credential", text))
            }
            let canonical = base64UrlEncode(bytes)
            if !out.contains(canonical) { out.append(canonical) }
        }
        return .success(out)
    }

    public static func normalizeCreateOptions(_ raw: [String: Any]) -> Result<CreateOptions, Refusal> {
        let rpId: String
        switch normalizeRpId(raw["rpId"]) {
        case .success(let v): rpId = v
        case .failure(let r): return .failure(r)
        }
        let user: User
        switch normalizeUser(raw["user"]) {
        case .success(let v): user = v
        case .failure(let r): return .failure(r)
        }
        let challenge: String
        switch normalizeChallenge(raw["challenge"]) {
        case .success(let v): challenge = v
        case .failure(let r): return .failure(r)
        }
        let attestation: String
        switch foldAttestation(raw["attestation"]) {
        case .success(let v): attestation = v
        case .failure(let r): return .failure(r)
        }
        let verification: String
        switch foldUserVerification(raw["userVerification"]) {
        case .success(let v): verification = v
        case .failure(let r): return .failure(r)
        }
        let residentKey: String
        switch foldResidentKey(raw["residentKey"]) {
        case .success(let v): residentKey = v
        case .failure(let r): return .failure(r)
        }
        let exclude: [String]
        switch normalizeCredentialIds(raw["exclude"] ?? raw["excludeCredentials"]) {
        case .success(let v): exclude = v
        case .failure(let r): return .failure(r)
        }
        return .success(CreateOptions(rpId: rpId, user: user, challenge: challenge,
                                      attestation: attestation, userVerification: verification,
                                      residentKey: residentKey, excludeCredentials: exclude,
                                      timeoutMs: clampTimeout(raw["timeout"])))
    }

    public static func normalizeGetOptions(_ raw: [String: Any]) -> Result<GetOptions, Refusal> {
        let rpId: String
        switch normalizeRpId(raw["rpId"]) {
        case .success(let v): rpId = v
        case .failure(let r): return .failure(r)
        }
        let challenge: String
        switch normalizeChallenge(raw["challenge"]) {
        case .success(let v): challenge = v
        case .failure(let r): return .failure(r)
        }
        let mediation: String
        switch foldMediation(raw["mediation"]) {
        case .success(let v): mediation = v
        case .failure(let r): return .failure(r)
        }
        let verification: String
        switch foldUserVerification(raw["userVerification"]) {
        case .success(let v): verification = v
        case .failure(let r): return .failure(r)
        }
        let allow: [String]
        switch normalizeCredentialIds(raw["allow"] ?? raw["allowCredentials"]) {
        case .success(let v): allow = v
        case .failure(let r): return .failure(r)
        }
        return .success(GetOptions(rpId: rpId, challenge: challenge, mediation: mediation,
                                   userVerification: verification, allowCredentials: allow,
                                   timeoutMs: clampTimeout(raw["timeout"])))
    }
}
