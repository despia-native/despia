//
//  RemoteBundleGate.swift — the LOAD-GATE verifier for remote bundle manifests (signed manifests).
//
//  WHY THIS EXISTS (read OpenSource/Skills/security.md → "The load gate" first). Remote DSX is
//  trusted because its SOURCE is: routes/bundle manifests are app-authored, baked at build or served
//  by the app's OWN backend over HTTPS. The remote cache already content-addresses (a stable URL
//  hash keys the disk copy); signed manifests are the *missing half* — the piece that lets a manifest
//  be trusted by WHO AUTHORED IT, not merely by the transport it arrived on. HTTPS authenticates the
//  channel (a CDN, a cert), never the author. Once a source goes third-party (a CDN you don't fully
//  control, an edge cache, a partner host), channel auth is not enough: this gate binds the manifest
//  BYTES to the app author's signing key, verified against a PUBLIC key baked into the app at build —
//  the app-authored trust anchor (Article 5: App.json is the one input taken on faith).
//
//  THE MODEL, precisely:
//    • The app's build/backend signs the remote-bundle manifest (the route/bundle manifest — the
//      `{ assets:[…] }` deploy manifest the OTA layer fetches) with a PRIVATE key it holds.
//    • A PUBLIC key (+ algorithm) is baked into App.json (`bundle_signing`). The runtime NEVER sees
//      the private key; rotation is a new app build with a new public key (build-time anchor, like the
//      host). Multiple keys may be listed to overlap a rotation.
//    • At the LOAD GATE — before the engine trusts any remote bundle — the runtime verifies the
//      manifest's DETACHED signature against the baked key(s). PASS → the manifest (and the table /
//      assets derived from it) is trusted, exactly like bundled DSX. FAIL or MISSING (when signing is
//      enabled) → REJECT: never render unverified remote content; degrade to the configured fallback.
//
//  ENFORCEMENT IS THE ENGINE'S, NOT A PACKAGE'S (constitution Art.1/3 + locked-decision #3: the
//  engine consumes the verification; never special-case a node kind). This type is a pure kernel
//  AUTHORITY: it holds the trust anchor and the verify math, and it RECORDS the verdict for the
//  current manifest. The kernel's sole consumer of the remote route table — `Router.resolved()` —
//  asks this gate whether the active table may be trusted, ONCE for the table (not per route). A
//  package that fetches a manifest submits the bytes + signature here (`verifyManifest`); the engine
//  decides. No node-kind branching, no per-call allowlist (that would gate the wrong layer — see
//  security.md "The load gate").
//
//  FAIL-OPEN WHEN OFF, FAIL-CLOSED WHEN ON (Art.7). No `bundle_signing` in App.json (or no
//  `public_key`) ⇒ `isEnabled == false` ⇒ verification is a no-op PASS and every existing app is
//  byte-for-byte unaffected. Configured ⇒ unverified content is refused and the app degrades to its
//  fallback surface — it never bricks, and it never renders content the author didn't sign.
//
//  CRYPTO. Built directly on CryptoKit (already the engine's crypto surface — see JSECrypto in
//  Stack.swift, which uses these same types). Ed25519 (Curve25519.Signing) is the default; ECDSA
//  P-256 (P256.Signing, SPKI/X9.63 public key, raw r‖s IEEE-P1363 signature) is the alternative.
//  Both are standard, FIPS-friendly, and verifiable by any WebCrypto/OpenSSL signer on the build side.
//  This module deliberately re-implements the few lines of verify rather than reaching into
//  JSECrypto's `private` helpers: security-critical code a reviewer must audit reads best self-
//  contained, in one file, with no indirection.
//

import Foundation
import CryptoKit

/// The kernel's remote-bundle load gate. App-authored trust anchor (public key, baked in App.json)
/// + the verify math + the recorded verdict for the current manifest. The engine (Router) consumes
/// the verdict; packages submit material. Stateless math; the only state is the last verified digest.
public enum RemoteBundleGate {

    // MARK: - Configuration (the app-authored trust anchor)

    /// One trust anchor: an algorithm + a public key. Parsed from an App.json `bundle_signing.keys`
    /// entry (or the single-key shorthand). `kid` is an optional, opaque key id used only for logging
    /// / matching a signature's declared key — never trusted for anything security-relevant.
    public struct Anchor {
        public enum Algorithm: String { case ed25519 = "Ed25519", ecdsaP256 = "ECDSA-P256" }
        public let algorithm: Algorithm
        /// The raw public-key bytes, already base64-DECODED: 32 bytes for Ed25519; for ECDSA-P256
        /// either an X9.63 point (0x04‖X‖Y, 65 bytes) or a DER/SPKI SubjectPublicKeyInfo.
        public let keyData: Data
        public let kid: String?
    }

    /// The signing CONFIG resolved once from App.json. A `nil` raw block ⇒ no `bundle_signing` ⇒
    /// signing is OFF (fail-open). A present-but-empty/garbage block parses to `enabled:false,
    /// anchors:[]` so a MALFORMED config can never silently disable an app that meant to turn signing
    /// ON — see `isMisconfigured` (a present block with a non-false `enabled` and zero usable keys is
    /// a hard, loud fail-closed, not a silent "off").
    public struct Config {
        public let enabled: Bool          // App.json `bundle_signing.enabled` (defaults true when a block is present)
        public let anchors: [Anchor]      // usable trust anchors (unparsable keys dropped, logged)
        public let declaredKeyCount: Int  // how many keys the author DECLARED (to detect "all unparsable")
    }

    /// The resolved signing config, read once from App.json (kernel config plane — never a Swift
    /// literal, never a hardcoded key). Overridable in tests via `_overrideConfig`.
    public static var config: Config { _overrideConfig ?? cachedConfig }

    /// Test seam ONLY (no production writer). Lets a unit/integration test install a config without an
    /// App.json. Never set from package or host code.
    public static var _overrideConfig: Config?

    /// Test seam for the release-only OTA policy. Production code derives this from the compile
    /// configuration and App.json; tests may force either side without changing the process build.
    public static var _overrideReleaseOTARequired: Bool?

    private static let cachedConfig: Config = parse(AppManifest.bundleSigning)

    /// Signing is ON for this build. TRUE iff the author shipped a `bundle_signing` block that is not
    /// explicitly disabled AND declared at least one key. When ON, the engine REFUSES unverified
    /// remote content (`requiresVerification`).
    public static var isEnabled: Bool {
        let c = config
        return c.enabled && c.declaredKeyCount > 0
    }

    /// Release builds never accept unsigned OTA. A non-empty `entry.ota` therefore turns verification
    /// on even when bundle_signing is absent/disabled, causing a loud fail-closed misconfiguration.
    /// Explicit DEBUG builds retain the legacy unsigned path for local development only.
    private static var releaseOTARequiresSigning: Bool {
        if let forced = _overrideReleaseOTARequired { return forced }
        #if DEBUG
        return false
        #else
        return !(AppManifest.entry.ota?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        #endif
    }

    public static var requiresVerification: Bool { isEnabled || releaseOTARequiresSigning }

    /// A hard misconfiguration: the author turned signing ON (`enabled` not false, ≥1 key declared) but
    /// EVERY declared key failed to parse — so nothing could ever verify. This must fail CLOSED loudly,
    /// not silently behave like "off". The Router treats this exactly like "enabled but unverified":
    /// refuse remote content.
    public static var isMisconfigured: Bool {
        let c = config
        if releaseOTARequiresSigning && (!isEnabled || c.anchors.isEmpty) { return true }
        return c.enabled && c.declaredKeyCount > 0 && c.anchors.isEmpty
    }

    // MARK: - Verdict (the recorded state the engine consumes)

    /// The SHA-256 of the most recently VERIFIED manifest. The engine trusts the current table iff the
    /// manifest that produced it hashes to this. Set only by a passing `verifyManifest`; cleared on any
    /// failure. Guarded by a lock — the OTA fetch runs off-main, the Router reads on main.
    private static let lock = NSLock()
    private static var _verifiedDigest: Data?

    /// C1 ANTI-ROLLBACK — the highest manifest VERSION accepted so far in this trust epoch. The version
    /// is carried INSIDE the signed routes.json (so it is authenticated by the same table signature, no
    /// new key), and the table-source records it here ONLY after a `.verified` verdict. The gate is the
    /// authority for the monotonic compare; the table-source (Routing) is responsible for PERSISTING it
    /// across launches (next to the verified body/sig it already caches) and SEEDING it back on launch —
    /// exactly mirroring how `_verifiedDigest` is the gate's authority while Routing persists the body.
    /// `nil` ⇒ no version has been accepted yet (first ever signed manifest is always allowed). Guarded
    /// by the same `lock` as the digest. Untouched while signing is OFF (Routing never calls record).
    private static var _lastVerifiedVersion: Int?

    /// Has the manifest with this exact body been verified in THIS process? The Router calls this with
    /// the manifest bytes it (re)resolves against. Pure content check — no trust in any field, no
    /// ambient "a verify happened" flag that a second unsigned fetch could ride on.
    public static func isVerified(manifest: Data) -> Bool {
        let d = Data(SHA256.hash(data: manifest))
        lock.lock(); defer { lock.unlock() }
        return _verifiedDigest.map { constantTimeEqual($0, d) } ?? false
    }

    /// Convenience for callers holding the manifest as text.
    public static func isVerified(manifestText: String) -> Bool {
        isVerified(manifest: Data(manifestText.utf8))
    }

    // MARK: - Anti-rollback version (C1)

    /// Record the version of a manifest that JUST verified (`.verified`). MONOTONIC: a `nil` argument (a
    /// signed-but-unversioned manifest — the old bare-array form) never clears or lowers the recorded
    /// high-water mark, and a value lower than what's recorded is ignored (the caller is expected to
    /// have already REFUSED a regressing version via `lastVerifiedVersion()` — this is belt-and-braces).
    /// Only the table-source calls this, and only after a `.verified` verdict whose version it accepted.
    public static func recordVersion(_ version: Int?) {
        guard let version = version else { return }   // unversioned manifest ⇒ leave the high-water mark
        lock.lock(); defer { lock.unlock() }
        if let current = _lastVerifiedVersion, version < current { return }   // never regress the mark
        _lastVerifiedVersion = version
    }

    /// The highest manifest version accepted so far (`nil` until the first versioned manifest verifies).
    /// The table-source compares a freshly-verified manifest's version against this to refuse a rollback.
    public static func lastVerifiedVersion() -> Int? {
        lock.lock(); defer { lock.unlock() }
        return _lastVerifiedVersion
    }

    /// Revoke the recorded `.verified` digest for a manifest the table-source REFUSED on anti-rollback
    /// grounds (it cryptographically verified, so `verifyManifest` recorded its digest, but its version
    /// regressed). After this, `isVerified(manifest:)` is false for those bytes, so the Router will not
    /// treat the rolled-back table as trusted. The anti-rollback high-water mark is DELIBERATELY left
    /// intact (a rollback attempt must never lower it). Mirrors the internal failure-clear, exposed so
    /// the courier — which alone can read the version inside the signed bytes — can enforce the policy.
    public static func rejectForRollback() { clearVerified() }

    /// Revoke a signature verdict when authenticated bytes fail the signed-table policy (shape,
    /// version, or asset-hash metadata). Crypto validity alone never makes malformed policy trusted.
    public static func rejectVerifiedManifest() { clearVerified() }

    // MARK: - Per-asset hashes (C2)

    /// C2 PER-ASSET INTEGRITY — the `[host-relative-path: lowercase-hex-SHA256]` table the asset
    /// consumers check fetched bytes against. The hashes are listed INSIDE the signed routes.json
    /// (`routes[].assets[].sha256`), so they are authenticated by the same table signature — no second
    /// key. This map is engine TRUST STATE, exactly like `_verifiedDigest`: the kernel holds it; the
    /// table-source (Routing) is the COURIER that publishes it after a `.verified`-and-accepted manifest
    /// (and re-seeds it from cache offline), and the asset consumers READ it through the gate (a kernel
    /// authority) rather than reaching across to the package — keeping cross-package reads off a package
    /// singleton (monorepo working rules rule 1). Empty while signing is OFF or until a signed manifest is accepted.
    private static var _assetHashes: [String: String] = [:]

    /// Publish the per-asset hash table parsed from a just-accepted signed manifest (the courier's job).
    /// Replaces the table wholesale; pass `[:]` to clear it (a rejection / no declared hashes). The keys
    /// are normalized host-relative paths (see `normalizeAssetPath`); values are lowercase hex.
    public static func setAssetHashes(_ map: [String: String]) {
        lock.lock(); _assetHashes = map; lock.unlock()
    }

    /// The expected lowercase-hex SHA-256 for an asset path, or `nil` if none is declared (the optional
    /// field ⇒ the consumer skips the check, today's behavior). `path` is normalized the same way the
    /// keys are, so a leading `./` or `/` doesn't cause a miss.
    public static func expectedAssetHash(forPath path: String) -> String? {
        let key = normalizeAssetPath(path)
        lock.lock(); defer { lock.unlock() }
        return _assetHashes[key]
    }

    /// Does `data` match the declared SHA-256 for `path`? Returns `.skip` only when signing is OFF,
    /// `.missing` when a signed table omitted this fetched asset, `.match` on a verified match, and
    /// `.mismatch` on divergence. Missing and mismatched hashes both fail closed at the consumer.
    /// The compare is constant-time
    /// over the hex. Centralizing the hash math here keeps the one CryptoKit hash-compare in the kernel
    /// authority, beside the signature verify it chains from.
    public enum AssetCheck: Equatable { case skip, missing, match, mismatch }
    public static func checkAsset(_ data: Data, forPath path: String) -> AssetCheck {
        guard requiresVerification else { return .skip }                  // OFF ⇒ today's behavior
        guard let expected = expectedAssetHash(forPath: path) else { return .missing }
        let actual = hexSHA256(data)
        return constantTimeHexEqual(actual, expected) ? .match : .mismatch
    }

    // MARK: - Signed route-table policy

    /// Authenticated metadata extracted only from the strict signed-table object form.
    public struct SignedRouteMetadata: Equatable {
        public let version: Int
        public let assetHashes: [String: String]
    }

    /// Validate the policy carried by signed routes.json bytes. Signed OTA requires an OBJECT with a
    /// non-negative integer `version`, a route array, and valid SHA-256 metadata for every declared
    /// asset entry. Bare arrays and unversioned objects are deliberately rejected: they cannot provide
    /// durable replay protection. Conflicting duplicate paths are rejected as ambiguous.
    public static func signedRouteMetadata(_ text: String) -> SignedRouteMetadata? {
        guard let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let number = object["version"] as? NSNumber,
              String(cString: number.objCType) != "c",
              number.doubleValue.isFinite,
              number.doubleValue >= 0,
              number.doubleValue <= Double(Int.max),
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              let routes = object["routes"] as? [[String: Any]] else { return nil }

        var hashes: [String: String] = [:]
        for route in routes {
            guard let rawAssets = route["assets"] else { continue }
            guard let assets = rawAssets as? [[String: Any]] else { return nil }
            for asset in assets {
                guard let rawPath = asset["path"] as? String,
                      let rawHash = asset["sha256"] as? String else { return nil }
                let path = normalizeAssetPath(rawPath.trimmingCharacters(in: .whitespacesAndNewlines))
                let hash = rawHash.lowercased()
                guard !path.isEmpty,
                      hash.count == 64,
                      hash.unicodeScalars.allSatisfy({ (48...57).contains($0.value) || (97...102).contains($0.value) }) else {
                    return nil
                }
                if let existing = hashes[path], existing != hash { return nil }
                hashes[path] = hash
            }
        }
        return SignedRouteMetadata(version: number.intValue, assetHashes: hashes)
    }

    /// Stable anti-replay namespace: canonical network origin + the complete baked trust-anchor set.
    /// It intentionally excludes the attacker-controlled routes path inside the outer deploy manifest.
    public static func replayScopeIdentifier(originURL: String) -> String? {
        guard let components = URLComponents(string: originURL),
              let rawScheme = components.scheme?.lowercased(),
              rawScheme == "https" || rawScheme == "http",
              let rawHost = components.host?.lowercased(), !rawHost.isEmpty else { return nil }
        let defaultPort = rawScheme == "https" ? 443 : 80
        let port = components.port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
        let host = rawHost.contains(":") ? "[\(rawHost)]" : rawHost
        let anchors = config.anchors.map {
            "\($0.algorithm.rawValue):\($0.keyData.base64EncodedString())"
        }.sorted().joined(separator: "\n")
        return hexSHA256(Data("dsx-replay-v1\n\(rawScheme)://\(host)\(port)\n\(anchors)".utf8))
    }

    /// Lowercase-hex SHA-256 of bytes — the form C2 manifest hashes are written/compared in.
    static func hexSHA256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Normalize an asset path for hash-map keys/lookups: strip a leading `./` then a leading `/`, so the
    /// manifest's relative path and the consumer's resolved (host-relative) path agree.
    static func normalizeAssetPath(_ path: String) -> String {
        var p = path
        if p.hasPrefix("./") { p.removeFirst(2) }
        if p.hasPrefix("/") { p.removeFirst() }
        return p
    }

    /// Constant-time-ish compare of two hex digests (length first, then a difference-accumulating XOR),
    /// so the reject time doesn't leak where they diverge. Case-normalized to lowercase.
    private static func constantTimeHexEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.lowercased().utf8), y = Array(b.lowercased().utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }

    // MARK: - Verify (the load-gate decision a package submits to)

    /// Outcome of a verification attempt — a small typed result so a caller (and the test suite) can
    /// branch on WHY a manifest was accepted or rejected, and so logs are precise.
    public enum Verdict: Equatable {
        case verified                 // signature checks out against a baked anchor → trusted
        case disabled                 // signing is OFF for this build → caller may trust the source as before
        case rejectedNoSignature      // signing ON but no signature supplied → REFUSE
        case rejectedBadSignature     // signing ON, signature present, verification failed → REFUSE
        case rejectedMisconfigured    // signing ON but no usable key was baked in → REFUSE (fail closed)
        case rejectedRollback         // signing ON, signature VALID, but the manifest version regressed → REFUSE (C1 anti-rollback)

        /// May the engine trust the manifest given this verdict? Only `verified` and `disabled`.
        public var trusted: Bool { self == .verified || self == .disabled }
    }

    /// Verify a remote bundle manifest's DETACHED signature against the baked trust anchor(s). This is
    /// the load gate. A package fetching a manifest calls it with the EXACT bytes it received and the
    /// detached signature (from a sidecar file, an `X-DSX-Signature` header, or a `signature` envelope
    /// field). On `.verified` the digest is recorded so `isVerified(manifest:)` returns true for the
    /// SAME bytes; on any rejection the recorded digest is CLEARED (a failed refresh must not leave a
    /// stale "verified" verdict standing). Off ⇒ `.disabled` (no-op pass). Total: never throws.
    ///
    /// `keyId` is the OPTIONAL key id a signature declares (to pick among rotated keys); it only
    /// narrows which anchors are tried FIRST and is never itself trusted — every listed key is a valid
    /// signer, so an attacker naming a different `kid` gains nothing.
    @discardableResult
    public static func verifyManifest(_ manifest: Data, signature: Data?, keyId: String? = nil) -> Verdict {
        guard requiresVerification else { return .disabled }      // OFF ⇒ fail-open, today's behavior

        if isMisconfigured {                                       // ON but no usable key ⇒ fail CLOSED
            clearVerified()
            log("bundle-signing ENABLED but no usable public key parsed from App.json bundle_signing — refusing remote content (fail-closed). Fix the key or remove the block.")
            return .rejectedMisconfigured
        }
        guard let signature = signature, !signature.isEmpty else { // ON but unsigned ⇒ REFUSE
            clearVerified()
            log("remote manifest has no signature but bundle-signing is enabled — refusing.")
            return .rejectedNoSignature
        }

        let candidates = anchorsToTry(keyId: keyId)
        for anchor in candidates where verify(manifest: manifest, signature: signature, anchor: anchor) {
            recordVerified(manifest)
            return .verified
        }
        clearVerified()
        log("remote manifest signature did not verify against any baked key (\(candidates.count) tried) — refusing.")
        return .rejectedBadSignature
    }

    /// Text convenience (the OTA layer holds manifests as strings). UTF-8 bytes are what gets signed.
    @discardableResult
    public static func verifyManifest(text: String, signature: Data?, keyId: String? = nil) -> Verdict {
        verifyManifest(Data(text.utf8), signature: signature, keyId: keyId)
    }

    // MARK: - The math (one anchor, one signature — no ambient state)

    /// Raw signature verification for a single anchor. PURE — touches no recorded state, throws
    /// nothing (a malformed key/signature is `false`, never a crash; totality matches the rest of the
    /// engine's crypto). Ed25519: `isValidSignature` over the raw message. ECDSA-P256: raw r‖s
    /// (IEEE-P1363) over SHA-256 of the message, the WebCrypto/`crypto.subtle` ECDSA layout.
    static func verify(manifest: Data, signature: Data, anchor: Anchor) -> Bool {
        switch anchor.algorithm {
        case .ed25519:
            guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: anchor.keyData) else { return false }
            return key.isValidSignature(signature, for: manifest)
        case .ecdsaP256:
            guard let key = ecP256PublicKey(anchor.keyData),
                  let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
            return key.isValidSignature(sig, for: SHA256.hash(data: manifest))
        }
    }

    /// Accept a P-256 public key as either an X9.63 point (0x04‖X‖Y) or DER/SPKI — whichever the build
    /// side emits. Both map to the same CryptoKit key; trying X9.63 first (the compact form) then DER.
    private static func ecP256PublicKey(_ data: Data) -> P256.Signing.PublicKey? {
        if let k = try? P256.Signing.PublicKey(x963Representation: data) { return k }
        if #available(iOS 14.0, *), let k = try? P256.Signing.PublicKey(derRepresentation: data) { return k }
        return nil
    }

    // MARK: - Anchors

    /// The anchors to try for a given (optional) declared key id. A matching `kid` is tried FIRST as an
    /// optimization, but ALL anchors remain candidates — `kid` is an untrusted hint, so it can only
    /// reorder, never restrict away, the set of legitimate signers.
    private static func anchorsToTry(keyId: String?) -> [Anchor] {
        let all = config.anchors
        guard let keyId = keyId, !keyId.isEmpty else { return all }
        let matching = all.filter { $0.kid == keyId }
        let rest = all.filter { $0.kid != keyId }
        return matching + rest
    }

    // MARK: - Recorded-verdict plumbing

    private static func recordVerified(_ manifest: Data) {
        let d = Data(SHA256.hash(data: manifest))
        lock.lock(); _verifiedDigest = d; lock.unlock()
    }
    private static func clearVerified() {
        // Clears ONLY the verified-bytes digest (so the current table is refused). DELIBERATELY does NOT
        // clear `_lastVerifiedVersion`: a failed/rollback refresh must not lower the anti-rollback
        // high-water mark, or an attacker could induce a failure and then replay an older signed manifest.
        lock.lock(); _verifiedDigest = nil; lock.unlock()
    }
    /// ORIGIN-SCOPE reset — a dev-origin switch (guides/staging-and-testing.md) moves the app to a
    /// DIFFERENT origin whose signed tables have their own independent version line; carrying the
    /// old origin's in-memory high-water mark across would false-positive anti-rollback (prod v100
    /// → staging v5 reads as a replay). Clears the in-memory verdict + mark + asset hashes so the
    /// next refresh verifies fresh against the new origin. The PERSISTED marks are already
    /// per-routes-URL (per-origin) and stay intact — switching back re-seeds from that origin's
    /// own cache. Reachable only via the `dev.originChanged` event, whose only firer (DevSettings)
    /// is env-gated off production.
    public static func resetForOriginChange() { _resetVerifiedForTesting() }

    /// Test seam: drop any recorded verdict, the anti-rollback version, AND the per-asset hash table so
    /// cases don't bleed into one another.
    public static func _resetVerifiedForTesting() {
        lock.lock(); _verifiedDigest = nil; _lastVerifiedVersion = nil; _assetHashes = [:]; lock.unlock()
        _overrideReleaseOTARequired = nil
    }

    /// Constant-time digest compare (both are fixed 32-byte SHA-256s; still avoid an early-out compare).
    private static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[a.startIndex + i] ^ b[b.startIndex + i] }
        return diff == 0
    }

    private static func log(_ m: String) { NSLog("[RemoteBundleGate] %@", m) }

    // MARK: - Config parsing (App.json `bundle_signing`)

    /// Parse the App.json `bundle_signing` block. Shapes accepted (all keys base64; raw 32-byte for
    /// Ed25519, X9.63 or SPKI for ECDSA-P256):
    ///
    ///   "bundle_signing": { "algorithm": "Ed25519", "public_key": "BASE64" }          // single key
    ///   "bundle_signing": { "enabled": true, "keys": [                                  // rotation set
    ///       { "algorithm": "Ed25519",    "public_key": "BASE64", "kid": "2026-06" },
    ///       { "algorithm": "ECDSA-P256", "public_key": "BASE64", "kid": "2026-01" } ] }
    ///
    /// `enabled` defaults to TRUE when a block is present (declaring the block IS the opt-in); set it
    /// false to ship a key while leaving enforcement off (staging a rollout). Absent block ⇒ nil ⇒ off.
    static func parse(_ raw: [String: Any]?) -> Config {
        guard let raw = raw else { return Config(enabled: false, anchors: [], declaredKeyCount: 0) }

        let enabled = (raw["enabled"] as? Bool) ?? true           // present block defaults to ON
        var declared: [[String: Any]] = []
        if let keys = raw["keys"] as? [[String: Any]] {
            declared = keys
        } else if raw["public_key"] != nil {                       // single-key shorthand
            declared = [raw]
        }

        var anchors: [Anchor] = []
        for entry in declared {
            guard let anchor = parseAnchor(entry) else {
                log("dropping an unparsable bundle_signing key entry (bad algorithm or base64).")
                continue
            }
            anchors.append(anchor)
        }
        return Config(enabled: enabled, anchors: anchors, declaredKeyCount: declared.count)
    }

    private static func parseAnchor(_ entry: [String: Any]) -> Anchor? {
        let algRaw = (entry["algorithm"] as? String) ?? "Ed25519"  // Ed25519 is the default algorithm
        guard let algorithm = parseAlgorithm(algRaw),
              let b64 = entry["public_key"] as? String,
              let keyData = decodeBase64(b64), !keyData.isEmpty else { return nil }
        // Sanity-bound the raw form so a wrong-length blob is rejected at parse, not at first verify.
        switch algorithm {
        case .ed25519: guard keyData.count == 32 else { return nil }
        case .ecdsaP256: guard keyData.count >= 33 else { return nil }   // X9.63 point is 65; SPKI larger
        }
        let kid = (entry["kid"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Anchor(algorithm: algorithm, keyData: keyData, kid: kid)
    }

    /// Map the author's algorithm string to a supported anchor algorithm, tolerant of common spellings
    /// (case / separators), so "ed25519", "ECDSA_P256", "ecdsa-p256", "p256" all resolve. Unknown ⇒ nil.
    private static func parseAlgorithm(_ s: String) -> Anchor.Algorithm? {
        let n = s.lowercased().replacingOccurrences(of: "_", with: "-").replacingOccurrences(of: " ", with: "")
        switch n {
        case "ed25519", "ed-25519", "edwards25519": return .ed25519
        case "ecdsa-p256", "ecdsap256", "ecdsa-p-256", "p256", "p-256", "es256": return .ecdsaP256
        default: return nil
        }
    }

    /// Decode standard OR URL-safe base64 (with or without padding) — build pipelines emit both.
    private static func decodeBase64(_ s: String) -> Data? {
        if let d = Data(base64Encoded: s) { return d }
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}
