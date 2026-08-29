//
//  CryptoCore.swift
//  DespiaScript
//
//  The shared `crypto` module core: the digest-name fold, the UUID bit layouts and the
//  uniform-integer rejection bound. The law is the corpus, OpenSource/Conformance/crypto/
//  (parity/F15-crypto.md). The twin of :core CryptoCore.kt and of the web
//  @despia/kernel crypto-core.ts.
//
//  NOTHING here computes a hash, a MAC or a signature. Those are CryptoKit's job and the
//  module facet calls straight into them. What lives here is the part that has no platform
//  answer and would therefore drift between renderers: which spelling of "sha256" is
//  accepted, exactly which bits of a UUID carry the timestamp, and how many draws a uniform
//  integer costs.
//

import Foundation

public enum CryptoCore {

    /// One digest the module offers: its WebCrypto name (the cross-renderer register) and
    /// whether it is one of the two legacy algorithms a build may switch off.
    public struct Digest {
        public let web: String
        public let legacy: Bool
    }

    /// The digest vocabulary, keyed by the spelling authors write. sha1 and md5 are present
    /// because integrity checks against existing servers need them, and marked legacy so no
    /// code path can pick one as a default.
    public static let digests: [String: Digest] = [
        "sha256": Digest(web: "SHA-256", legacy: false),
        "sha384": Digest(web: "SHA-384", legacy: false),
        "sha512": Digest(web: "SHA-512", legacy: false),
        "sha1": Digest(web: "SHA-1", legacy: true),
        "md5": Digest(web: "MD5", legacy: true),
    ]

    /// The MAC vocabulary is the digest vocabulary minus md5: nothing needs HMAC-MD5 that
    /// HMAC-SHA1 does not serve, and WebCrypto refuses it, so offering it would be a lie on
    /// one of the three renderers.
    public static let macDigests: [String] = ["sha256", "sha384", "sha512", "sha1"]

    /// The largest `randomBytes` request. An unbounded allocation is reachable from markup.
    public static let maxRandomBytes = 1_048_576

    /// Fold an author's algorithm spelling. Case-insensitive after trimming, and the
    /// separator forms every other library accepts (`SHA-256`, `sha_256`) fold to the same
    /// id. Returns nil for an unknown name, or for a legacy name when the build switched
    /// legacy digests off.
    public static func foldDigest(_ name: String?, allowLegacy: Bool = true) -> String? {
        let key = (name ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .filter { $0 != "-" && $0 != "_" && !$0.isWhitespace }
        guard let entry = digests[key] else { return nil }
        if entry.legacy && !allowLegacy { return nil }
        return key
    }

    private static func format(_ bytes: [UInt8]) -> String {
        var out = ""
        out.reserveCapacity(36)
        for index in 0..<16 {
            if index == 4 || index == 6 || index == 8 || index == 10 { out.append("-") }
            out += String(format: "%02x", Int(bytes[index]))
        }
        return out
    }

    private static func take(_ random: [UInt8], _ count: Int) -> [UInt8] {
        (0..<count).map { $0 < random.count ? random[$0] : 0 }
    }

    /// RFC 9562 version 4: 16 random bytes with the version and variant nibbles stamped over
    /// them. Bytes past the sixteenth are ignored.
    public static func uuidV4(_ random: [UInt8]) -> String {
        var bytes = take(random, 16)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return format(bytes)
    }

    /// RFC 9562 version 7: 48 bits of Unix milliseconds big-endian, then the version nibble,
    /// then 74 bits of randomness (10 supplied bytes, two of them partially overwritten).
    ///
    /// The ordering property is the entire point: two v7 ids minted a millisecond apart
    /// compare in mint order as plain strings, so they index and paginate without a separate
    /// sort key.
    public static func uuidV7(_ unixMillis: Int64, _ random: [UInt8]) -> String {
        let millis = UInt64(max(0, unixMillis)) % 0x1000000000000
        var bytes = [UInt8](repeating: 0, count: 16)
        for index in 0..<6 { bytes[index] = UInt8((millis >> UInt64(8 * (5 - index))) & 0xff) }
        let tail = take(random, 10)
        for index in 0..<10 { bytes[6 + index] = tail[index] }
        bytes[6] = (bytes[6] & 0x0f) | 0x70
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return format(bytes)
    }

    /// The largest exact multiple of `range` that fits in 32 bits. A 32-bit draw at or above
    /// this is DISCARDED; below it, `draw % range` is exactly uniform. `range` is the count
    /// of distinct outcomes (max - min + 1) and must be 1...2^32. Zero means "not a range".
    public static func uniformBound(_ range: Int64) -> Int64 {
        guard range >= 1, range <= 0x1_0000_0000 else { return 0 }
        return 0x1_0000_0000 - (0x1_0000_0000 % range)
    }

    /// What `randomInt` does with a supplied sequence of 32-bit draws: skip every draw the
    /// bound rejects, fold the first survivor. Pure and deterministic, which is what lets the
    /// corpus pin the rejection behaviour rather than merely asserting the answer is in range.
    public struct Pick {
        public let value: Int64
        public let consumed: Int
    }

    public static func uniformPick(_ range: Int64, _ draws: [Int64]) -> Pick? {
        let bound = uniformBound(range)
        guard bound != 0 else { return nil }
        for (index, raw) in draws.enumerated() {
            let draw = raw & 0xFFFF_FFFF
            if draw < bound { return Pick(value: draw % range, consumed: index + 1) }
        }
        return nil
    }

    /// The full `randomInt` fold. `min`/`max` are inclusive; the stable machine ids are
    /// `invalid_range` and `exhausted`.
    public enum IntResult {
        case value(Int64, consumed: Int)
        case refused(String)
    }

    public static func uniformInt(_ min: Int64, _ max: Int64, _ draws: [Int64]) -> IntResult {
        guard max >= min else { return .refused("invalid_range") }
        let range = max - min + 1
        guard range <= 0x1_0000_0000 else { return .refused("invalid_range") }
        guard let picked = uniformPick(range, draws) else { return .refused("exhausted") }
        return .value(min + picked.value, consumed: picked.consumed)
    }
}
