//
//  AuthProof.swift — Swift twin of ../../Web/packages/kernel/src/auth-proof.ts and
//  ../Android/core/src/main/kotlin/despia/engine/AuthProof.kt: THE AUTHENTICATION PROOF PURE
//  CORE (A1, ClosedSource/Documentation/v4-launch/completeness/A1-auth-hardening.md). Two folds,
//  and a login is the one flow where a fail-open default is a compromise:
//
//    1. THE TRIGGER FOLD — matchesConfiguredTrigger / isAllowedAuthorizationUrl. LoginHelper
//       decides on every main-frame navigation whether the URL about to load is a configured
//       identity provider; a match cancels the app's own navigation and hands the URL to a web
//       view that carries a provider-accepted user agent and SHARES the app's cookie jar. A raw
//       `hasPrefix` therefore gives anyone who controls `idp.example.attacker.invalid` a login
//       surface wearing the IdP's clothes.
//
//    2. THE PROOF FOLD — PKCE (RFC 7636), `state` (RFC 6749 §10.12, RFC 9700 §2.1) and OIDC
//       `nonce`: which proofs a module owns for a given authorize URL, the exact URL it builds,
//       and the verdict a returning callback earns.
//
//  The law is the corpus, OpenSource/Conformance/auth/{trigger,pkce}.json, executed on this
//  runtime by AuthProofConformance.swift in the Codemagic `conformance-record` lane.
//
//  NOTHING here hashes and nothing here draws entropy: RFC 7636's S256 is
//  BASE64URL-ENCODE(SHA256(ASCII(verifier))) and the SHA-256 half is CryptoKit's job, exactly as
//  CryptoCore.swift says; the CSPRNG behind a minted value is SecRandomCopyBytes'. What lives
//  here is the half that has no platform answer and would otherwise drift.
//
//  PURE by construction: Foundation only for String bridging, no URL/URLComponents, no
//  NSRegularExpression. The URL splitter is hand-rolled precisely BECAUSE NSURL, java.net.URI
//  and the WHATWG parser disagree about userinfo, backslashes and percent-escaped hosts, and a
//  security fold cannot be the union of three parsers' bugs. Scanning runs over UTF-16 code
//  units so string length and iteration mean the same thing here as in the other two twins.
//

import Foundation

/// An absolute URL's origin parts. `port` is -1 when none was written; `hasUserInfo` is kept
/// rather than the userinfo itself, because nothing here has any business reading it.
struct UrlOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int
    let hasUserInfo: Bool
}

/// The verdict a returning callback earns — see `AuthProof.verifyCallbackProofs`.
enum CallbackVerdict: String {
    case ok
    case unproven
    case missingState = "missing_state"
    case stateMismatch = "state_mismatch"
    case replayed
    case nonceMismatch = "nonce_mismatch"
}

/// What `AuthProof.planAuthorizeProofs` decided. `refusal` is a DECLARED module error code or
/// nil; when it is set, nothing is minted.
struct AuthorizeProofPlan {
    let refusal: String?
    let mintState: Bool
    let adoptedState: String?
    let mintNonce: Bool
    let adoptedNonce: String?
    let mintPkce: Bool
}

enum AuthProof {

    private static let b64url = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    /// RFC 7636 §4.1: code-verifier = 43*128unreserved.
    static let pkceVerifierMinLength = 43
    static let pkceVerifierMaxLength = 128

    /// RFC 7636 §7.1: "a minimum of 256 bits of entropy… a 32-octet sequence". 32 octets
    /// base64url-encode to exactly 43 characters, which is also the ABNF floor — the two
    /// constraints meet, which is why 32 is the number and not a taste.
    static let pkceVerifierEntropyBytes = 32

    /// `state` and `nonce` are unguessability tokens, not key material; 128 bits is the floor.
    static let authProofEntropyBytes = 16

    /// The only challenge method this core will build. RFC 7636 §4.2 makes S256 mandatory to
    /// implement on the server, and `plain` exists for clients that cannot hash — which
    /// describes no platform this runs on.
    static let pkceChallengeMethod = "S256"

    /// The refusal `planAuthorizeProofs` can return; declared in Core/Auth/OAuth/dsx.json.
    static let refusalPkceUnsupported = "pkce_unsupported"

    // MARK: - 0 · the hand-rolled absolute-URL split — one parser, three runtimes

    private static func isDigit(_ u: UInt16) -> Bool { u >= 48 && u <= 57 }
    private static func isAlpha(_ u: UInt16) -> Bool { (u >= 97 && u <= 122) || (u >= 65 && u <= 90) }
    private static func units(_ text: String) -> [UInt16] { Array(text.utf16) }
    private static func text(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: Array(units), as: UTF16.self)
    }

    /// Characters that must never appear inside an authority. A backslash is the whole reason
    /// this list exists: some parsers normalize `\` to `/`, some do not, and
    /// `https://idp.example\@evil` therefore means two different hosts on two renderers.
    /// Anything ambiguous is refused, never guessed — the cost of a false refusal is a
    /// navigation that is not intercepted, which is the behaviour it already had.
    private static func authorityIsClean(_ authority: [UInt16]) -> Bool {
        for u in authority {
            if u <= 0x20 || u == 0x7f { return false }
            // \ < > " ^ { } | `
            if u == 92 || u == 60 || u == 62 || u == 34 || u == 94 ||
                u == 123 || u == 125 || u == 124 || u == 96 { return false }
        }
        return true
    }

    /// Split an absolute `scheme://authority…` URL into its origin, or nil when it is not one or
    /// is not unambiguous. A percent escape in the host is refused rather than decoded: `%2e` is
    /// a dot to some parsers and a literal to others, and either answer is a lookalike host.
    static func splitOrigin(_ raw: String?) -> UrlOrigin? {
        guard let raw = raw, !raw.isEmpty else { return nil }
        let u = units(raw)
        guard isAlpha(u[0]) else { return nil }

        var i = 0
        while i < u.count {
            let c = u[i]
            if c == 58 { break }                       // ':'
            if !isAlpha(c) && !isDigit(c) && c != 43 && c != 45 && c != 46 { return nil }
            i += 1
        }
        guard i < u.count, u[i] == 58 else { return nil }
        let scheme = text(u[0..<i]).lowercased()
        guard i + 2 < u.count, u[i + 1] == 47, u[i + 2] == 47 else { return nil }   // "//"

        var end = i + 3
        while end < u.count {
            let c = u[end]
            if c == 47 || c == 63 || c == 35 { break }   // '/', '?', '#'
            end += 1
        }
        let authority = Array(u[(i + 3)..<end])
        guard authorityIsClean(authority) else { return nil }

        var at = -1
        for (index, c) in authority.enumerated() where c == 64 { at = index }   // '@'
        let hasUserInfo = at >= 0
        let hostPort = hasUserInfo ? Array(authority[(at + 1)...]) : authority

        var hostUnits = hostPort
        var port = -1
        if let first = hostPort.first, first == 91 {                            // '['
            guard let close = hostPort.firstIndex(of: 93) else { return nil }   // ']'
            hostUnits = Array(hostPort[0...close])
            let rest = Array(hostPort[(close + 1)...])
            if !rest.isEmpty {
                guard rest[0] == 58 else { return nil }
                let digits = Array(rest[1...])
                guard !digits.isEmpty, digits.allSatisfy({ isDigit($0) }),
                      let value = Int(text(digits[...])) else { return nil }
                port = value
            }
        } else if let colon = hostPort.firstIndex(of: 58) {
            hostUnits = Array(hostPort[0..<colon])
            let digits = Array(hostPort[(colon + 1)...])
            guard !digits.isEmpty, digits.allSatisfy({ isDigit($0) }),
                  let value = Int(text(digits[...])) else { return nil }
            port = value
        }
        guard !hostUnits.isEmpty else { return nil }
        for c in hostUnits where c == 37 || c == 58 || c == 64 { return nil }   // '%', ':', '@'

        return UrlOrigin(scheme: scheme, host: text(hostUnits[...]).lowercased(),
                         port: port, hasUserInfo: hasUserInfo)
    }

    /// Does this text CLAIM a URI scheme, whether or not it parses into an origin? The
    /// distinction matters exactly once, and it is a security decision: `https://` and
    /// `javascript:alert` both claim a scheme and neither yields an origin, so treating either
    /// as a legacy raw prefix would make the first match every https URL there is and the second
    /// hand a script URL to a login surface. A claim that does not parse is refused; only text
    /// that never claimed is legacy.
    static func claimsUriScheme(_ raw: String?) -> Bool {
        guard let raw = raw, !raw.isEmpty else { return false }
        let u = units(raw)
        guard isAlpha(u[0]) else { return false }
        var i = 0
        while i < u.count {
            let c = u[i]
            if c == 58 { return true }
            if !isAlpha(c) && !isDigit(c) && c != 43 && c != 45 && c != 46 { return false }
            i += 1
        }
        return false
    }

    /// The port an origin comparison uses: the written one, else the scheme's default, else -1
    /// so two custom-scheme origins still compare equal to each other.
    static func normalizedPort(_ origin: UrlOrigin) -> Int {
        if origin.port >= 0 { return origin.port }
        if origin.scheme == "https" { return 443 }
        if origin.scheme == "http" { return 80 }
        return -1
    }

    // MARK: - 1 · the trigger fold — a configured login trigger is an origin, not a prefix

    /// Does `candidate` belong to the identity provider configured as `configuredPrefix`?
    ///
    /// The raw prefix is NECESSARY, never sufficient: it runs first so nothing that already
    /// failed the legacy test starts matching, and an absolute prefix then additionally pins
    /// scheme, host and port and refuses userinfo. Case is deliberately not folded on the prefix
    /// test — an uppercase host that fails the byte prefix simply is not intercepted, which is
    /// the direction that costs nothing.
    static func matchesConfiguredTrigger(_ candidate: String?, _ configuredPrefix: String?) -> Bool {
        guard let prefix = configuredPrefix, !prefix.isEmpty,
              let target = candidate, target.hasPrefix(prefix) else { return false }

        guard let trigger = splitOrigin(prefix) else { return !claimsUriScheme(prefix) }
        guard let actual = splitOrigin(target) else { return false }

        return actual.scheme == trigger.scheme &&
            actual.host == trigger.host &&
            normalizedPort(actual) == normalizedPort(trigger) &&
            !actual.hasUserInfo
    }

    /// May this URL be handed to a browser as an authorization START? Confidential transport, a
    /// real host, and no URL credentials: a `javascript:` / `intent:` / `file:` authorization
    /// start is not an authorization start, and userinfo in an authorization URL is a phishing
    /// primitive some browsers still render.
    static func isAllowedAuthorizationUrl(_ raw: String?) -> Bool {
        guard let origin = splitOrigin(raw) else { return false }
        return origin.scheme == "https" && !origin.host.isEmpty && !origin.hasUserInfo
    }

    // MARK: - 2 · base64url, the verifier ABNF, the S256 challenge

    /// RFC 4648 §5 with "all trailing '=' characters omitted" (RFC 7636 §A). One encoder serves
    /// the verifier, the challenge, `state` and `nonce`, so a padding character can never appear
    /// in any of them. Octets are read unsigned so no runtime has to agree about signed bytes
    /// first.
    static func base64UrlNoPad(_ bytes: [Int]) -> String {
        var out = ""
        var i = 0
        let n = bytes.count
        while i + 2 < n {
            let a = bytes[i] & 0xff, b = bytes[i + 1] & 0xff, c = bytes[i + 2] & 0xff
            out.append(b64url[a >> 2])
            out.append(b64url[((a & 0x03) << 4) | (b >> 4)])
            out.append(b64url[((b & 0x0f) << 2) | (c >> 6)])
            out.append(b64url[c & 0x3f])
            i += 3
        }
        let left = n - i
        if left == 1 {
            let a = bytes[i] & 0xff
            out.append(b64url[a >> 2])
            out.append(b64url[(a & 0x03) << 4])
        } else if left == 2 {
            let a = bytes[i] & 0xff, b = bytes[i + 1] & 0xff
            out.append(b64url[a >> 2])
            out.append(b64url[((a & 0x03) << 4) | (b >> 4)])
            out.append(b64url[(b & 0x0f) << 2])
        }
        return out
    }

    /// The `Data` door onto the same encoder — what `SHA256.hash` and `SecRandomCopyBytes` hand
    /// back. Unsigned widening happens exactly once, here.
    static func base64UrlNoPad(_ data: Data) -> String { base64UrlNoPad(data.map { Int($0) }) }

    /// RFC 4648 §5 the other way, to UTF-8 text. Refuses padding, refuses an alphabet outside
    /// base64url, refuses the impossible residue of one, and refuses bytes that are not UTF-8 —
    /// every one of those is a malformed token rather than something to salvage.
    static func base64UrlDecodeUtf8(_ segment: String?) -> String? {
        guard let segment = segment, !segment.isEmpty else { return nil }
        let chars = Array(segment)
        if chars.count % 4 == 1 { return nil }
        var bytes: [Int] = []
        var acc = 0
        var bits = 0
        for ch in chars {
            guard let v = b64url.firstIndex(of: ch) else { return nil }
            acc = (acc << 6) | v
            bits += 6
            if bits >= 8 {
                bits -= 8
                bytes.append((acc >> bits) & 0xff)
            }
        }
        return utf8Decode(bytes)
    }

    /// A hand-rolled UTF-8 decode: `String(decoding:as:)` substitutes U+FFFD for malformed input
    /// and `TextDecoder` does something else again, so a shared fold cannot delegate. Overlong
    /// forms, surrogates and out-of-range scalars are refusals, not replacements.
    private static func utf8Decode(_ bytes: [Int]) -> String? {
        var out = ""
        var i = 0
        while i < bytes.count {
            let b0 = bytes[i]
            var cp = 0
            let extra: Int
            let minimum: Int
            if b0 < 0x80 { cp = b0; extra = 0; minimum = 0 }
            else if b0 >= 0xc2 && b0 <= 0xdf { cp = b0 & 0x1f; extra = 1; minimum = 0x80 }
            else if b0 >= 0xe0 && b0 <= 0xef { cp = b0 & 0x0f; extra = 2; minimum = 0x800 }
            else if b0 >= 0xf0 && b0 <= 0xf4 { cp = b0 & 0x07; extra = 3; minimum = 0x10000 }
            else { return nil }
            if i + extra >= bytes.count { return nil }
            var k = 1
            while k <= extra {
                let b = bytes[i + k]
                if b < 0x80 || b > 0xbf { return nil }
                cp = (cp << 6) | (b & 0x3f)
                k += 1
            }
            if cp < minimum || cp > 0x10ffff { return nil }
            if cp >= 0xd800 && cp <= 0xdfff { return nil }
            guard let scalar = Unicode.Scalar(UInt32(cp)) else { return nil }
            out.append(Character(scalar))
            i += extra + 1
        }
        return out
    }

    private static func utf8Encode(_ value: String) -> [Int] {
        Array(value.utf8).map { Int($0) }
    }

    /// RFC 7636 §4.1 verbatim: 43*128 of ALPHA / DIGIT / "-" / "." / "_" / "~". No trimming, no
    /// case folding — a verifier is compared byte for byte at the token endpoint, so a fold that
    /// accepts what the server will not is a login that dies there with a useless message.
    static func isCodeVerifier(_ value: String?) -> Bool {
        guard let value = value else { return false }
        let u = units(value)
        if u.count < pkceVerifierMinLength || u.count > pkceVerifierMaxLength { return false }
        for c in u {
            if (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) { continue }
            if c == 45 || c == 46 || c == 95 || c == 126 { continue }   // - . _ ~
            return false
        }
        return true
    }

    /// A verifier from platform entropy, or nil when there is not enough of it. Expressed as a
    /// refusal rather than a short value on purpose: a silently-padded verifier is a weak one
    /// that still works, which is the failure nobody finds.
    static func codeVerifierFromEntropy(_ bytes: [Int]) -> String? {
        bytes.count < pkceVerifierEntropyBytes ? nil : base64UrlNoPad(bytes)
    }

    static func codeVerifierFromEntropy(_ data: Data) -> String? {
        data.count < pkceVerifierEntropyBytes ? nil : base64UrlNoPad(data)
    }

    /// A `state` or `nonce` from platform entropy, or nil when there is not enough of it.
    static func opaqueProof(_ bytes: [Int]) -> String? {
        bytes.count < authProofEntropyBytes ? nil : base64UrlNoPad(bytes)
    }

    static func opaqueProof(_ data: Data) -> String? {
        data.count < authProofEntropyBytes ? nil : base64UrlNoPad(data)
    }

    /// RFC 7636 §4.2: code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))). The
    /// digest arrives already computed, because hashing is the platform's. A digest of any other
    /// length is refused rather than encoded: a short one produces a challenge the server
    /// accepts and no verifier can ever satisfy, which strands every login on that build.
    static func codeChallengeS256(_ digest: [Int]) -> String? {
        digest.count != 32 ? nil : base64UrlNoPad(digest)
    }

    static func codeChallengeS256(_ digest: Data) -> String? {
        digest.count != 32 ? nil : base64UrlNoPad(digest)
    }

    /// Every proof comparison runs through here. No early return on the first differing byte and
    /// none on a length difference: both lengths and every position fold into one accumulator,
    /// so a wrong `state` costs the same time as a right one.
    static func constantTimeEquals(_ a: String?, _ b: String?) -> Bool {
        let left = units(a ?? "")
        let right = units(b ?? "")
        var diff = left.count ^ right.count
        let span = left.count > right.count ? left.count : right.count
        var i = 0
        while i < span {
            let l = i < left.count ? Int(left[i]) : 0
            let r = i < right.count ? Int(right[i]) : 0
            diff |= l ^ r
            i += 1
        }
        return diff == 0
    }

    // MARK: - 3 · the proof plan — adopt what the caller wrote, mint what is missing

    private static func hexValue(_ u: UInt16) -> Int {
        if u >= 48 && u <= 57 { return Int(u) - 48 }
        if u >= 97 && u <= 102 { return Int(u) - 87 }
        if u >= 65 && u <= 70 { return Int(u) - 55 }
        return -1
    }

    /// Percent-decode a query value the way a form-encoded query is read: `+` is a space, `%XX`
    /// is a byte, an incomplete escape is left literal rather than dropped. The authorization
    /// server echoes `state` back through this same encoding, so adopting it decoded is what
    /// makes the later comparison compare the same two things.
    private static func decodeQueryValue(_ raw: String) -> String {
        let u = units(raw)
        var bytes: [Int] = []
        var i = 0
        while i < u.count {
            let c = u[i]
            if c == 43 { bytes.append(0x20); i += 1; continue }         // '+'
            if c == 37 && i + 2 < u.count {                              // '%'
                let hi = hexValue(u[i + 1])
                let lo = hexValue(u[i + 2])
                if hi >= 0 && lo >= 0 { bytes.append((hi << 4) | lo); i += 3; continue }
            }
            // A lone unit here is either ASCII or one half of a surrogate pair; taking the pair
            // together keeps the UTF-8 encoding identical to the other two twins.
            if c >= 0xd800 && c <= 0xdbff && i + 1 < u.count {
                bytes.append(contentsOf: utf8Encode(text(u[i...(i + 1)])))
                i += 2
                continue
            }
            bytes.append(contentsOf: utf8Encode(text(u[i...i])))
            i += 1
        }
        return utf8Decode(bytes) ?? ""
    }

    /// The query string of a URL: everything between the first `?` and the first `#` after it.
    private static func queryOf(_ url: String) -> String {
        let u = units(url)
        var hash = -1
        for (index, c) in u.enumerated() where c == 35 { hash = index; break }
        let stop = hash < 0 ? u.count : hash
        var q = -1
        for (index, c) in u.enumerated() where c == 63 { q = index; break }
        if q < 0 || q > stop { return "" }
        return text(u[(q + 1)..<stop])
    }

    /// The first value of `name` in a form-encoded query, decoded, or nil. An empty value is
    /// nil: `state=` is not a state, it is a caller who built the parameter and forgot the
    /// value.
    private static func queryValue(_ query: String, _ name: String) -> String? {
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            let piece = String(pair)
            guard let eq = piece.firstIndex(of: "=") else {
                if decodeQueryValue(piece) == name { return nil }
                continue
            }
            let key = decodeQueryValue(String(piece[piece.startIndex..<eq]))
            if key != name { continue }
            let value = decodeQueryValue(String(piece[piece.index(after: eq)...]))
            return value.isEmpty ? nil : value
        }
        return nil
    }

    /// Does a space-separated `response_type` carry `token` as a whole token?
    private static func responseTypeHas(_ responseType: String?, _ token: String) -> Bool {
        guard let responseType = responseType else { return false }
        for part in responseType.split(separator: " ", omittingEmptySubsequences: false) {
            if String(part).lowercased() == token { return true }
        }
        return false
    }

    /// Which proofs this module owns for `authorizeUrl`.
    ///
    /// A parameter already in the URL is ADOPTED — the caller built it, the module verifies what
    /// comes back — and one that is absent is MINTED. That is what makes this non-breaking:
    /// every integration shipped against the old contract keeps the exact authorize URL it
    /// built, plus a `state` it did not have to write.
    ///
    /// `nonce` is owned only for an OIDC request (`scope` contains `openid`, or `response_type`
    /// contains `id_token`): minting one onto a plain OAuth request is noise, and RFC 9700 §2.1
    /// says PKCE carries the same protection.
    ///
    /// PKCE is OPT-IN, and that is the load-bearing decision. A module-minted verifier is one
    /// the module must also redeem, so appending `code_challenge` to a flow whose token exchange
    /// the CALLER performs breaks that exchange at the authorization server — a worse failure
    /// than the one being fixed, and one that would land on every shipped integration at once.
    static func planAuthorizeProofs(_ authorizeUrl: String?, wantsPkce: Bool) -> AuthorizeProofPlan {
        let query = queryOf(authorizeUrl ?? "")
        let state = queryValue(query, "state")
        let nonce = queryValue(query, "nonce")
        let challenge = queryValue(query, "code_challenge")
        let responseType = queryValue(query, "response_type")
        let scope = queryValue(query, "scope")

        let isCodeFlow = responseTypeHas(responseType, "code")
        if wantsPkce && (challenge != nil || !isCodeFlow) {
            return AuthorizeProofPlan(refusal: refusalPkceUnsupported, mintState: false,
                                      adoptedState: nil, mintNonce: false, adoptedNonce: nil,
                                      mintPkce: false)
        }

        var oidc = responseTypeHas(responseType, "id_token")
        if !oidc, let scope = scope {
            for part in scope.split(separator: " ", omittingEmptySubsequences: false)
            where String(part).lowercased() == "openid" { oidc = true }
        }

        return AuthorizeProofPlan(refusal: nil,
                                  mintState: state == nil,
                                  adoptedState: state,
                                  mintNonce: oidc && nonce == nil,
                                  adoptedNonce: nonce,
                                  mintPkce: wantsPkce)
    }

    /// Percent-escape everything outside RFC 3986's unreserved set. Minted values are base64url
    /// and pass through untouched; the escaping exists so a value that came from somewhere else
    /// can never break out of its parameter.
    private static func encodeQueryValue(_ value: String) -> String {
        var out = ""
        for b in utf8Encode(value) {
            let u = UInt16(b)
            if (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) ||
                u == 45 || u == 46 || u == 95 || u == 126 {
                out.append(Character(Unicode.Scalar(UInt8(b))))
            } else {
                out.append("%")
                out.append(String(format: "%02X", b))
            }
        }
        return out
    }

    /// The authorize URL with the minted parameters appended, in a fixed order so three runtimes
    /// build the same string. Appending, never rewriting: the caller's URL is reproduced byte
    /// for byte. A fragment stays last, because a query appended after a fragment is not a
    /// query.
    static func applyAuthorizeProofs(_ authorizeUrl: String?,
                                     state: String? = nil,
                                     nonce: String? = nil,
                                     challenge: String? = nil) -> String {
        let url = authorizeUrl ?? ""
        var pairs: [String] = []
        if let state = state, !state.isEmpty { pairs.append("state=" + encodeQueryValue(state)) }
        if let nonce = nonce, !nonce.isEmpty { pairs.append("nonce=" + encodeQueryValue(nonce)) }
        if let challenge = challenge, !challenge.isEmpty {
            pairs.append("code_challenge=" + encodeQueryValue(challenge))
            pairs.append("code_challenge_method=" + pkceChallengeMethod)
        }
        if pairs.isEmpty { return url }

        let u = units(url)
        var hash = -1
        for (index, c) in u.enumerated() where c == 35 { hash = index; break }
        let head = hash < 0 ? url : text(u[0..<hash])
        let tail = hash < 0 ? "" : text(u[hash...])
        let headUnits = units(head)
        var q = -1
        for (index, c) in headUnits.enumerated() where c == 63 { q = index; break }
        let joiner: String
        if q < 0 { joiner = "?" }
        else if head.hasSuffix("?") || head.hasSuffix("&") { joiner = "" }
        else { joiner = "&" }
        return head + joiner + pairs.joined(separator: "&") + tail
    }

    // MARK: - 4 · the callback verdict — the only place a callback becomes deliverable

    /// The verdict a returning callback earns.
    ///
    /// `.unproven` is the compatibility floor and is deliberately permissive: a cold start after
    /// the process died behind the browser, or a deep link that is not a callback at all, has no
    /// armed expectation, and refusing there would break working logins to fix nothing.
    ///
    /// `.replayed` exists because clearing the expectation on success is not enough. A one-shot
    /// authorization code replayed a second later would otherwise land in the `.unproven` arm
    /// and be delivered, which is the exact attack `state` is there to stop.
    static func verifyCallbackProofs(expectedState: String?,
                                     consumedStates: [String],
                                     receivedState: String?,
                                     expectedNonce: String? = nil,
                                     idTokenNonce: String? = nil) -> CallbackVerdict {
        let expected = (expectedState?.isEmpty ?? true) ? nil : expectedState
        let received = (receivedState?.isEmpty ?? true) ? nil : receivedState

        guard let expected = expected else {
            if let received = received {
                for seen in consumedStates where constantTimeEquals(seen, received) { return .replayed }
            }
            return .unproven
        }
        guard let received = received else { return .missingState }
        if !constantTimeEquals(expected, received) { return .stateMismatch }

        guard let wantNonce = (expectedNonce?.isEmpty ?? true) ? nil : expectedNonce else { return .ok }
        // No id_token in this callback means the nonce rides the token exchange instead; an
        // id_token that carries no nonce claim at all, against an armed nonce, is the injection
        // this refuses.
        guard let idTokenNonce = idTokenNonce else { return .ok }
        return constantTimeEquals(wantNonce, idTokenNonce) ? .ok : .nonceMismatch
    }

    /// A JWT's middle segment, base64url-decoded to UTF-8, and nothing else. The signature is
    /// NOT checked and the result has exactly one use: REFUSING a callback whose nonce does not
    /// match. It never makes a token valid, and reading the claim out of the returned JSON is
    /// each renderer's own parser — which is why this stops at the decoded string.
    static func idTokenPayload(_ jwt: String?) -> String? {
        guard let jwt = jwt else { return nil }
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        return base64UrlDecodeUtf8(String(parts[1]))
    }

    // MARK: - 5 · the verifier release boundary

    /// May a module-minted verifier be sent to this token endpoint?
    ///
    /// The verifier is the one secret this core's consumer holds, and the token exchange is the
    /// only path that sends it anywhere. The destination is therefore not the caller's to choose
    /// freely: it must be an https origin the APP declared in config. An empty declaration
    /// allows nothing, so a build that never opted in cannot leak a verifier at all — the
    /// fail-closed direction, and the reason this is an allowlist rather than a shape check.
    static func tokenEndpointAllowed(_ tokenUrl: String?, declaredOrigins: [String]) -> Bool {
        guard let target = splitOrigin(tokenUrl),
              target.scheme == "https", !target.hasUserInfo else { return false }
        for declared in declaredOrigins {
            guard let origin = splitOrigin(declared), origin.scheme == "https" else { continue }
            if origin.host == target.host && normalizedPort(origin) == normalizedPort(target) { return true }
        }
        return false
    }
}
