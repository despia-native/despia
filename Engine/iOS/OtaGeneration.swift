//
//  OtaGeneration.swift — the two decisions a device makes about an OTA generation BEFORE it
//  applies one: is this device inside the staged rollout, and can the installed binary
//  actually run what the generation references. The law is the corpus,
//  OpenSource/Conformance/ota/rollout.json (parity/P05-ota.md 4b + 4c); the Kotlin twin is
//  :core OtaGeneration.kt and the web twin is @despia-native/kernel packages/kernel/src/ota.ts.
//
//  Everything platform-shaped lives OUTSIDE this file. Fetching, signing, the content store
//  and the anti-rollback high-water mark are RemoteBundleGate's business; this file is pure
//  arithmetic and comparison, which is exactly why one corpus can judge three renderers. A
//  device either takes an update or it does not, identically everywhere.
//
//  Two properties the design is built on:
//    • no coordination — the bucket is a hash of the device's own installation id, so a
//      staged rollout needs no server, no assignment call and no state anywhere;
//    • monotonic — the hash is stable, so raising the fraction only grows the population. A
//      device that took generation N at 10 percent still has it at 50 percent.
//
import Foundation

public enum OtaGeneration {

    /// FNV-1a 32-bit constants. Not a cryptographic hash and not pretending to be one: this is
    /// a bucketing function, and it is FNV rather than SHA-256 because the gate is synchronous
    /// at load time while the web twin's only hash (crypto.subtle) is async-only.
    private static let fnvOffsetBasis: UInt32 = 2166136261
    private static let fnvPrime: UInt32 = 16777619
    public static let bucketDivisor: Double = 4294967296   // 2^32

    /// The staged-rollout declaration a manifest carries:
    /// `{ "rollout": { "fraction": 0.1, "salt": "gen-8a3f" } }`.
    public struct Rollout: Equatable {
        public let fraction: Double
        public let salt: String
    }

    /// What the gate decided. Every case other than `.apply` means the device keeps the
    /// generation it already has, and says why. There is no silent bypass.
    public enum Verdict: String, Equatable {
        case apply
        case rolloutExcluded       = "rollout_excluded"
        case runtimeTooOld         = "runtime_too_old"
        case runtimeUnknown        = "runtime_unknown"
        case invalidRollout        = "invalid_rollout"
        case invalidRuntimeVersion = "invalid_runtime_version"
        case noInstallationID      = "no_installation_id"
    }

    /// The decision, plus the bucket when one was computed (for logging a held device honestly).
    public struct Decision: Equatable {
        public let verdict: Verdict
        public let bucket: Double?
        public init(_ verdict: Verdict, bucket: Double? = nil) {
            self.verdict = verdict
            self.bucket = bucket
        }
    }

    // MARK: - The bucket

    /// FNV-1a 32-bit over the UTF-8 bytes of `text`.
    public static func hash32(_ text: String) -> UInt32 {
        var hash = fnvOffsetBasis
        for byte in Array(text.utf8) {
            hash ^= UInt32(byte)
            hash = hash &* fnvPrime          // &* is the wrap the algorithm specifies, not an overflow bug
        }
        return hash
    }

    /// This device's stable position from 0 up to but not including 1, for one salt. The salt is per generation, so
    /// changing it deliberately reshuffles the whole population.
    public static func bucket(installationId: String, salt: String) -> Double {
        Double(hash32("\(installationId):\(salt)")) / bucketDivisor
    }

    /// Is this device inside the fraction? The edges are explicit rather than emergent: 1 takes
    /// every device including the highest bucket, 0 takes none including bucket zero.
    public static func rolloutApplies(installationId: String, salt: String, fraction: Double) -> Bool {
        if fraction >= 1 { return true }
        if fraction <= 0 { return false }
        return bucket(installationId: installationId, salt: salt) < fraction
    }

    // MARK: - runtimeVersion

    private struct Version {
        let core: [Int]
        let pre: [String]
    }

    /// Parse a `runtimeVersion`, or nil when it is not one. Semver 2.0.0 with the one
    /// concession every real version table needs: a missing minor or patch is zero, so "4" and
    /// "4.0.0" are the same contract. Nothing else is forgiven — no `v` prefix, no leading
    /// zeros, no fourth component — because a version this gate guesses at is a version that
    /// can let an OTA reach a binary missing the module it references.
    private static func parse(_ raw: String?) -> Version? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }

        if let plus = text.firstIndex(of: "+") {
            text = String(text[text.startIndex..<plus])   // build metadata takes no part in precedence
        }
        if text.isEmpty { return nil }

        var pre: [String] = []
        if let dash = text.firstIndex(of: "-") {
            let preText = String(text[text.index(after: dash)...])
            text = String(text[text.startIndex..<dash])
            if preText.isEmpty { return nil }
            pre = preText.components(separatedBy: ".")
            if pre.contains(where: { $0.isEmpty || !isPreIdentifier($0) }) { return nil }
        }

        let parts = text.components(separatedBy: ".")
        if parts.isEmpty || parts.count > 3 { return nil }
        if parts.contains(where: { !isCoreComponent($0) }) { return nil }
        let core = (0..<3).map { index -> Int in
            index < parts.count ? (Int(parts[index]) ?? 0) : 0
        }
        return Version(core: core, pre: pre)
    }

    /// A non-negative decimal with no leading zero.
    private static func isCoreComponent(_ text: String) -> Bool {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        return text == "0" || !text.hasPrefix("0")
    }

    /// Alphanumerics and hyphens, per the semver identifier grammar.
    private static func isPreIdentifier(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    private static func isNumericIdentifier(_ text: String) -> Bool { isCoreComponent(text) }

    /// True when `raw` is a version this gate will act on.
    public static func isParseableVersion(_ raw: String?) -> Bool { parse(raw) != nil }

    /// -1 / 0 / 1, or nil when either side is unparseable.
    public static func compareVersions(_ a: String?, _ b: String?) -> Int? {
        guard let left = parse(a), let right = parse(b) else { return nil }

        for index in 0..<3 where left.core[index] != right.core[index] {
            return left.core[index] < right.core[index] ? -1 : 1
        }
        // A pre-release ranks below the release it leads to; two releases are equal.
        if left.pre.isEmpty && right.pre.isEmpty { return 0 }
        if left.pre.isEmpty { return 1 }
        if right.pre.isEmpty { return -1 }

        let shared = min(left.pre.count, right.pre.count)
        for index in 0..<shared {
            let l = left.pre[index]
            let r = right.pre[index]
            if l == r { continue }
            let lNumeric = isNumericIdentifier(l)
            let rNumeric = isNumericIdentifier(r)
            if lNumeric && rNumeric {
                // Numeric identifiers compare NUMERICALLY. Compared by length then ascii rather
                // than by parsing: leading zeros are already rejected, so the longer decimal is
                // the larger one, and no runtime's integer width can round a 40-digit build
                // number into agreeing with a different one.
                if l.count != r.count { return l.count < r.count ? -1 : 1 }
                return l < r ? -1 : 1
            }
            if lNumeric != rNumeric { return lNumeric ? -1 : 1 }   // numeric ranks below alphanumeric
            return l < r ? -1 : 1                                  // ascii order
        }
        if left.pre.count == right.pre.count { return 0 }
        return left.pre.count < right.pre.count ? -1 : 1           // a prefix ranks below its extension
    }

    /// Does the installed binary meet what the generation declares? nil when either version is
    /// unparseable, so the caller reports `invalid_runtime_version` rather than deciding.
    public static func runtimeVersionSatisfied(required: String?, current: String?) -> Bool? {
        guard let order = compareVersions(current, required) else { return nil }
        return order >= 0
    }

    // MARK: - The gate

    /// Read a manifest's `rollout` block. `.absent` = no staging (everyone takes it),
    /// `.malformed` = present but unusable, refused rather than clamped: a fraction of 1.5 is
    /// an authoring mistake and shipping to everyone is the most expensive reading of it.
    private enum RolloutRead {
        case absent
        case malformed
        case declared(Rollout)
    }

    private static func readRollout(_ raw: Any?) -> RolloutRead {
        guard let raw = raw, !(raw is NSNull) else { return .absent }
        guard let map = raw as? [String: Any] else { return .malformed }
        guard let number = map["fraction"] as? NSNumber,
              String(cString: number.objCType) != "c",       // a JSON true/false is not a fraction
              number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= 1,
              let salt = map["salt"] as? String else { return .malformed }
        return .declared(Rollout(fraction: number.doubleValue, salt: salt))
    }

    /// The gate. `runtimeVersion` is checked FIRST: a generation the installed binary cannot
    /// run is refused whatever the rollout says, because that refusal is the one that stops an
    /// OTA referencing a module the binary does not contain, which is how OTA systems brick
    /// apps. A held or refused generation always leaves the last good one in place.
    ///
    /// `manifest` is the generation's declaration (`runtimeVersion`, `rollout`) as decoded
    /// JSON; the other two are what this install is.
    public static func evaluate(manifest: [String: Any],
                                installedRuntimeVersion: String?,
                                installationId: String?) -> Decision {
        if let declared = manifest["runtimeVersion"], !(declared is NSNull) {
            let declaredText = declared as? String
            guard parse(declaredText) != nil else { return Decision(.invalidRuntimeVersion) }
            guard let installed = installedRuntimeVersion, !installed.isEmpty else {
                return Decision(.runtimeUnknown)
            }
            guard let satisfied = runtimeVersionSatisfied(required: declaredText, current: installed) else {
                return Decision(.invalidRuntimeVersion)
            }
            if !satisfied { return Decision(.runtimeTooOld) }
        }

        switch readRollout(manifest["rollout"]) {
        case .absent:
            return Decision(.apply)
        case .malformed:
            return Decision(.invalidRollout)
        case .declared(let rollout):
            if rollout.fraction >= 1 { return Decision(.apply) }
            if rollout.fraction <= 0 { return Decision(.rolloutExcluded) }
            guard let id = installationId, !id.isEmpty else { return Decision(.noInstallationID) }
            let position = bucket(installationId: id, salt: rollout.salt)
            return Decision(position < rollout.fraction ? .apply : .rolloutExcluded, bucket: position)
        }
    }
}
