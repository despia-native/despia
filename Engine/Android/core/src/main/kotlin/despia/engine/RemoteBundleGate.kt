//
//  RemoteBundleGate.kt — the LOAD-GATE verifier for remote bundle manifests (signed manifests).
//  Kotlin twin of Engine/RemoteBundleGate.swift — same names, same arguments, same verdicts.
//
//  WHY THIS EXISTS (the Swift header is the full argument — OpenSource/Skills/security.md → "The
//  load gate"): HTTPS authenticates the CHANNEL, never the AUTHOR. This gate binds the manifest
//  BYTES to the app author's signing key, verified against PUBLIC key(s) baked into App.json
//  (`bundle_signing` — Article 5: the one input taken on faith). FAIL-OPEN WHEN OFF (no block ⇒
//  every existing app byte-for-byte unaffected), FAIL-CLOSED WHEN ON (unverified remote content is
//  refused; the app degrades, never bricks). The engine consumes the verdict; packages submit
//  material. Verdict semantics, anchor parsing, kid ordering, the monotonic anti-rollback mark and
//  the per-asset hash table are all behavior-pinned to the Swift source by RemoteBundleGateTest.
//
//  THE WIRE CONTRACT (what a signature IS — produced by `ClosedSource/scripts/sign_manifest.rb`,
//  the reference signer; this verifier accepts its exact output):
//    • Ed25519 (default) — signature = raw 64 bytes over the RAW manifest bytes (no pre-hash).
//      Public key = the RAW 32-byte key, base64 in App.json.
//    • ECDSA-P256 — signature = raw r‖s (IEEE-P1363, exactly 64 bytes) over SHA-256(manifest) —
//      NOT DER (the signer converts openssl's DER → P1363; a DER-shaped signature is REJECTED
//      here too, matching CryptoKit's `ECDSASignature(rawRepresentation:)`). Public key = X9.63
//      uncompressed point (0x04‖X‖Y, 65 bytes) or a DER/SPKI SubjectPublicKeyInfo, base64.
//    • The BYTES VERIFIED ARE THE FETCHED BYTES, VERBATIM — no re-serialization, no trimming.
//      The detached signature travels base64 (header/sidecar); callers pass DECODED bytes here.
//
//  CRYPTO MAPPING (CryptoKit → java.security, pure JVM, JDK 21; Ed25519 needs JDK ≥ 15):
//    • Curve25519.Signing.PublicKey(rawRepresentation:) → KeyFactory "Ed25519" over a hand-built
//      X.509/SPKI wrapper: java.security has no raw-key entry point, so the fixed 12-byte ASN.1
//      prefix 302a300506032b6570032100 is prepended to the 32 raw bytes. Decoded:
//        30 2a           SEQUENCE (42 bytes)            — SubjectPublicKeyInfo
//          30 05         SEQUENCE (5 bytes)             — AlgorithmIdentifier
//            06 03 2b 65 70   OID 1.3.101.112           — id-Ed25519 (RFC 8410)
//          03 21 00      BIT STRING (33 bytes, 0 unused) — the raw 32-byte key follows
//    • P256.Signing.PublicKey(x963Representation:) → the analogous SPKI wrapper around the 65-byte
//      uncompressed point (prefix decoded in `p256SpkiFromX963`); (derRepresentation:) → the SPKI
//      bytes straight into X509EncodedKeySpec.
//    • key.isValidSignature(sig, for: SHA256.hash(...)) → Signature "SHA256withECDSA" — but Java
//      verifies DER-encoded ECDSA signatures ONLY, so the wire's raw r‖s is converted raw → DER
//      (`p1363ToDer`, minimal-form INTEGERs) before verify. Tests round-trip both shapes.
//    • Any malformed key/signature is `false`, never a throw — totality matches the Swift verify.
//
//  PURE-JVM SEAMS (PLAN.md ground rule 3 — the Swift file's two platform touches):
//    • bundleSigningSource — Swift reads `AppManifest.bundleSigning` (the App.json block) once
//      into a `static let`. Here the block arrives through this settable closure, default null
//      (signing OFF), and is parsed ONCE on first `config` read — set it at boot, before any
//      verify. Tests use `_overrideConfig` (the Swift-sanctioned test seam), never this.
//    • versionStore — the C1 anti-rollback high-water mark. In Swift the gate holds it in memory
//      and the table-source (Routing) persists/seeds it per-routes-URL. Here the mark lives
//      behind an injectable keyed store (default: in-memory map — process-lifetime, byte-for-byte
//      the Swift behavior); :platform may install a persistent store so persistence needs no
//      courier. PINNED: the gate's own mark uses one key ("routes"); a persistent store should
//      namespace per origin (Swift's persisted marks are per-routes-URL) — `resetForOriginChange`
//      clears the gate's slot, so a non-namespaced persistent store would lose the old origin's
//      mark across a dev-origin switch (in-memory default matches Swift exactly). Reads/writes
//      happen under the gate's lock; a store implementation needs no synchronization of its own.
//      ContentStore's PER-FOLDER anti-rollback marks (wave 4) reuse this same store, one key per
//      folder — the reason the seam is keyed.
//
//  ANDROID PLATFORM FLOOR — THE ONE DELIBERATE DIVERGENCE FROM THE SWIFT TWIN (Ed25519):
//    Apple ships Ed25519 in CryptoKit from iOS 13, so Swift can lean on the platform unconditionally.
//    ANDROID CANNOT: Conscrypt gained `Ed25519` only at API 33 (Android 13), while every Android
//    module here targets `minSdk = 24` (Android 7). On API 24–32 both `KeyFactory.getInstance
//    ("Ed25519")` and `Signature.getInstance("Ed25519")` throw NoSuchAlgorithmException. Because
//    Ed25519 is the DOCUMENTED DEFAULT signing algorithm, a naive port would swallow that throw in
//    the totality `catch` and return `false` — i.e. on Android 7–12 EVERY correctly signed remote
//    bundle would be refused, the device would be frozen on the bundled floor, and OTA would
//    silently never apply. That is an availability bug, not a bypass (it fails CLOSED), and the
//    pure-JVM test suite can never see it because JDK 21 always has the provider.
//    THE SHAPE OF THE FIX — AN EMPTY SEAM, NOT KERNEL CRYPTO. `ed25519PlatformAvailable` probes the
//    provider ONCE; when it is present the platform verify runs verbatim (unchanged behavior on
//    API 33+, on the JVM, and in CI). When it is ABSENT the kernel consults ONE nullable hook,
//    `ed25519LegacyVerifier` — NULL BY DEFAULT (the AppManifest.dynamicHostSource / RunnerScreenSeam
//    precedent: the kernel knows nothing about curve math, encodings or verification strategy; that
//    is wholly the optional, EXCLUDABLE package's concern). An UNFILLED seam REJECTS — byte-for-byte
//    the pre-fix verdict, fail-closed, never fail-open.
//    WHO FILLS IT: `ClosedSource/DSX/Modules/Core/LegacyCrypto`. It ships included by default and is
//    excluded like any other module (file-presence is the gate).
//    THE FACET IS NOT ONLY FOR OLD ANDROID, and the header used to say it was. MEASURED on
//    google/sdk_gphone64_arm64 API 36 (Android 16, Google APIs) by RemoteBundleSigningDeviceTest:
//    AndroidKeyStore is the ONLY provider on the device publishing an `Ed25519` KeyFactory, and it
//    throws on import; Conscrypt publishes X25519 HPKE and no Ed25519 KeyFactory; BC 1.77 publishes
//    none. So `ed25519PlatformAvailable` is FALSE on Android 16 and the seam is what verifies every
//    signed OTA there. Excluding the facet on a `minSdk >= 33` app therefore refuses every
//    correctly signed manifest -- fail-closed and silent. Exclude it only for an ECDSA-P256 rotation
//    set, or after enumerating providers on the devices you actually ship to.
//    NOT covered by the seam: ECDSA-P256 (`SHA256withECDSA` + `EC` KeyFactory are present on every
//    supported API level, so that anchor never needs one — a rotation set carrying a P-256 anchor
//    is the other way to serve Android 7–12) and every signing/keygen path (the private key never
//    touches the device — see remote-bundle-signing.md, "Key management").
//
//  PINNED DECISIONS (Swift-ambiguous or JVM-forced, per PLAN.md ground rule 1):
//    • Swift's access-modifier-free (internal) members — `verify`, `hexSHA256`,
//      `normalizeAssetPath`, `parse` — are PUBLIC here: Swift "internal" spans the whole app
//      target (Routing/ContentStore call them); on the JVM those consumers land in other Gradle
//      modules. Genuinely private helpers stay private.
//    • `NSLog` → `kernelLog` (the kernel's one logging seam); tags mirror the Swift text.
//    • base64: java.util.Base64's standard decoder also accepts UNPADDED standard input (Swift's
//      first try requires padding, then the URL-safe+re-pad fallback accepts unpadded anyway) —
//      the accepted set is identical, reached in one try instead of two.
//    • Verdict/AssetCheck enum entries keep the Swift case names (lowerCamelCase) per the 1:1 law.
//

package despia.engine

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.net.URI

/**
 * The kernel's remote-bundle load gate. App-authored trust anchor (public key, baked in App.json)
 * + the verify math + the recorded verdict for the current manifest. The engine (Router) consumes
 * the verdict; packages submit material. Stateless math; the only state is the last verified digest.
 */
object RemoteBundleGate {

    // MARK: - Configuration (the app-authored trust anchor)

    /**
     * One trust anchor: an algorithm + a public key. Parsed from an App.json `bundle_signing.keys`
     * entry (or the single-key shorthand). `kid` is an optional, opaque key id used only for logging
     * / matching a signature's declared key — never trusted for anything security-relevant.
     */
    class Anchor(
        val algorithm: Algorithm,
        /**
         * The raw public-key bytes, already base64-DECODED: 32 bytes for Ed25519; for ECDSA-P256
         * either an X9.63 point (0x04‖X‖Y, 65 bytes) or a DER/SPKI SubjectPublicKeyInfo.
         */
        val keyData: ByteArray,
        val kid: String?,
    ) {
        enum class Algorithm(val raw: String) { ed25519("Ed25519"), ecdsaP256("ECDSA-P256") }
    }

    /**
     * The signing CONFIG resolved once from App.json. A `null` raw block ⇒ no `bundle_signing` ⇒
     * signing is OFF (fail-open). A present-but-empty/garbage block parses to `enabled:false,
     * anchors:[]` so a MALFORMED config can never silently disable an app that meant to turn signing
     * ON — see `isMisconfigured` (a present block with a non-false `enabled` and zero usable keys is
     * a hard, loud fail-closed, not a silent "off").
     */
    data class Config(
        val enabled: Boolean,          // App.json `bundle_signing.enabled` (defaults true when a block is present)
        val anchors: List<Anchor>,     // usable trust anchors (unparsable keys dropped, logged)
        val declaredKeyCount: Int,     // how many keys the author DECLARED (to detect "all unparsable")
    )

    /**
     * Seam: the App.json `bundle_signing` block (Swift reads `AppManifest.bundleSigning`; App.json
     * is `:platform`'s to load — Article 5). Default null ⇒ signing OFF. Set at boot, BEFORE the
     * first `config` read — the parse is cached once, exactly like Swift's `static let`.
     */
    var bundleSigningSource: () -> Map<String, Any?>? = { null }

    /**
     * The resolved signing config, read once from App.json (kernel config plane — never a code
     * literal, never a hardcoded key). Overridable in tests via `_overrideConfig`.
     */
    val config: Config get() = _overrideConfig ?: cachedConfig

    /**
     * Test seam ONLY (no production writer). Lets a unit/integration test install a config without an
     * App.json. Never set from package or host code.
     */
    var _overrideConfig: Config? = null

    /** Test seam for the production-only OTA policy. No production writer. */
    var _overrideReleaseOTARequired: Boolean? = null

    private val cachedConfig: Config by lazy { parse(bundleSigningSource()) }

    /**
     * Signing is ON for this build. TRUE iff the author shipped a `bundle_signing` block that is not
     * explicitly disabled AND declared at least one key. When ON, the engine REFUSES unverified
     * remote content (`requiresVerification`).
     */
    val isEnabled: Boolean
        get() {
            val c = config
            return c.enabled && c.declaredKeyCount > 0
        }

    /** Release builds never accept unsigned OTA; explicit debug builds retain the legacy dev path. */
    private val releaseOTARequiresSigning: Boolean
        get() = _overrideReleaseOTARequired
            ?: (DSXEnv().isProduction && !AppManifest.entry.ota.isNullOrBlank())

    val requiresVerification: Boolean get() = isEnabled || releaseOTARequiresSigning

    /**
     * A hard misconfiguration: the author turned signing ON (`enabled` not false, ≥1 key declared) but
     * EVERY declared key failed to parse — so nothing could ever verify. This must fail CLOSED loudly,
     * not silently behave like "off". The Router treats this exactly like "enabled but unverified":
     * refuse remote content.
     */
    val isMisconfigured: Boolean
        get() {
            val c = config
            if (releaseOTARequiresSigning && (!isEnabled || c.anchors.isEmpty())) return true
            return c.enabled && c.declaredKeyCount > 0 && c.anchors.isEmpty()
        }

    // MARK: - Verdict (the recorded state the engine consumes)

    /**
     * The SHA-256 of the most recently VERIFIED manifest. The engine trusts the current table iff the
     * manifest that produced it hashes to this. Set only by a passing `verifyManifest`; cleared on any
     * failure. Guarded by a lock — the OTA fetch runs off-main, the Router reads on main.
     */
    private val lock = Any()
    private var _verifiedDigest: ByteArray? = null

    /**
     * C1 ANTI-ROLLBACK — the highest manifest VERSION accepted so far in this trust epoch. The version
     * is carried INSIDE the signed routes.json (so it is authenticated by the same table signature, no
     * new key), and the table-source records it here ONLY after a `.verified` verdict. The gate is the
     * authority for the monotonic compare; storage sits behind the `versionStore` seam (header) —
     * the in-memory default mirrors Swift, where the gate's mark is process-lifetime and the
     * table-source persists/seeds it. `null` ⇒ no version has been accepted yet (first ever signed
     * manifest is always allowed). Store access is guarded by the same `lock` as the digest.
     * Untouched while signing is OFF (the table-source never calls record).
     */
    interface VersionStore {
        fun get(key: String): Int?
        fun set(key: String, version: Int)
        fun remove(key: String)
    }

    /** The default store: an in-memory map — process-lifetime marks, exactly the Swift behavior. */
    class InMemoryVersionStore : VersionStore {
        private val map = HashMap<String, Int>()
        override fun get(key: String): Int? = map[key]
        override fun set(key: String, version: Int) { map[key] = version }
        override fun remove(key: String) { map.remove(key) }
    }

    /** Seam: anti-rollback mark storage (see header). All access happens under the gate's lock. */
    var versionStore: VersionStore = InMemoryVersionStore()

    /** The gate's own slot in `versionStore` — the ROUTE TABLE's high-water mark. */
    private const val routesVersionKey = "routes"

    /**
     * Has the manifest with this exact body been verified in THIS process? The Router calls this with
     * the manifest bytes it (re)resolves against. Pure content check — no trust in any field, no
     * ambient "a verify happened" flag that a second unsigned fetch could ride on.
     */
    fun isVerified(manifest: ByteArray): Boolean {
        val d = sha256(manifest)
        synchronized(lock) {
            val v = _verifiedDigest ?: return false
            return constantTimeEqual(v, d)
        }
    }

    /** Convenience for callers holding the manifest as text. */
    fun isVerified(manifestText: String): Boolean =
        isVerified(manifestText.toByteArray(Charsets.UTF_8))

    // MARK: - Anti-rollback version (C1)

    /**
     * Record the version of a manifest that JUST verified (`.verified`). MONOTONIC: a `null` argument
     * (a signed-but-unversioned manifest — the old bare-array form) never clears or lowers the recorded
     * high-water mark, and a value lower than what's recorded is ignored (the caller is expected to
     * have already REFUSED a regressing version via `lastVerifiedVersion()` — this is belt-and-braces).
     * Only the table-source calls this, and only after a `.verified` verdict whose version it accepted.
     */
    fun recordVersion(version: Int?) {
        if (version == null) return                    // unversioned manifest ⇒ leave the high-water mark
        synchronized(lock) {
            val current = versionStore.get(routesVersionKey)
            if (current != null && version < current) return   // never regress the mark
            versionStore.set(routesVersionKey, version)
        }
    }

    /**
     * The highest manifest version accepted so far (`null` until the first versioned manifest verifies).
     * The table-source compares a freshly-verified manifest's version against this to refuse a rollback.
     */
    fun lastVerifiedVersion(): Int? = synchronized(lock) { versionStore.get(routesVersionKey) }

    /**
     * Revoke the recorded `.verified` digest for a manifest the table-source REFUSED on anti-rollback
     * grounds (it cryptographically verified, so `verifyManifest` recorded its digest, but its version
     * regressed). After this, `isVerified(manifest)` is false for those bytes, so the Router will not
     * treat the rolled-back table as trusted. The anti-rollback high-water mark is DELIBERATELY left
     * intact (a rollback attempt must never lower it). Mirrors the internal failure-clear, exposed so
     * the courier — which alone can read the version inside the signed bytes — can enforce the policy.
     */
    fun rejectForRollback() = clearVerified()

    /** Revoke crypto-valid bytes that fail the authenticated signed-table policy. */
    fun rejectVerifiedManifest() = clearVerified()

    // MARK: - Per-asset hashes (C2)

    /**
     * C2 PER-ASSET INTEGRITY — the `[host-relative-path: lowercase-hex-SHA256]` table the asset
     * consumers check fetched bytes against. The hashes are listed INSIDE the signed routes.json
     * (`routes[].assets[].sha256`), so they are authenticated by the same table signature — no second
     * key. This map is engine TRUST STATE, exactly like `_verifiedDigest`: the kernel holds it; the
     * table-source (Routing) is the COURIER that publishes it after a `.verified`-and-accepted manifest
     * (and re-seeds it from cache offline), and the asset consumers READ it through the gate (a kernel
     * authority) rather than reaching across to the package — keeping cross-package reads off a package
     * singleton (monorepo working rules rule 1). Empty while signing is OFF or until a signed manifest is accepted.
     */
    private var _assetHashes: Map<String, String> = emptyMap()

    /**
     * Publish the per-asset hash table parsed from a just-accepted signed manifest (the courier's job).
     * Replaces the table wholesale; pass an empty map to clear it (a rejection / no declared hashes).
     * The keys are normalized host-relative paths (see `normalizeAssetPath`); values are lowercase hex.
     */
    fun setAssetHashes(map: Map<String, String>) {
        synchronized(lock) { _assetHashes = map }
    }

    /**
     * The expected lowercase-hex SHA-256 for an asset path, or `null` if none is declared (the optional
     * field ⇒ the consumer skips the check, today's behavior). `path` is normalized the same way the
     * keys are, so a leading `./` or `/` doesn't cause a miss.
     */
    fun expectedAssetHash(forPath: String): String? {
        val key = normalizeAssetPath(forPath)
        synchronized(lock) { return _assetHashes[key] }
    }

    /** Signing OFF skips; signing ON rejects both omitted and mismatched asset hashes. */
    enum class AssetCheck { skip, missing, match, mismatch }

    fun checkAsset(data: ByteArray, forPath: String): AssetCheck {
        if (!requiresVerification) return AssetCheck.skip                       // OFF ⇒ today's behavior
        val expected = expectedAssetHash(forPath) ?: return AssetCheck.missing
        val actual = hexSHA256(data)
        return if (constantTimeHexEqual(actual, expected)) AssetCheck.match else AssetCheck.mismatch
    }

    // MARK: - Signed route-table policy

    data class SignedRouteMetadata(val version: Int, val assetHashes: Map<String, String>)

    /**
     * Signed OTA accepts only `{ "version": <non-negative integer>, "routes": [...] }`.
     * Every declared asset entry must have a non-empty path and exactly 64 hexadecimal SHA-256
     * characters. Conflicting duplicate paths are rejected as ambiguous.
     */
    fun signedRouteMetadata(text: String): SignedRouteMetadata? {
        val rootObject = json(text).foundationValue as? Map<*, *> ?: return null
        if (!rootObject.keys.all { it is String }) return null
        val number = rootObject["version"] as? Number ?: return null
        val value = number.toDouble()
        if (!value.isFinite() || value < 0.0 || value > Int.MAX_VALUE.toDouble() || value % 1.0 != 0.0) return null
        val rawRoutes = rootObject["routes"] as? List<*> ?: return null
        if (!rawRoutes.all { it is Map<*, *> && it.keys.all { key -> key is String } }) return null

        val hashes = LinkedHashMap<String, String>()
        for (rawRoute in rawRoutes) {
            val route = rawRoute as Map<*, *>
            if (!route.containsKey("assets")) continue
            val assets = route["assets"] as? List<*> ?: return null
            for (rawAsset in assets) {
                val asset = rawAsset as? Map<*, *> ?: return null
                if (!asset.keys.all { it is String }) return null
                val rawPath = asset["path"] as? String ?: return null
                val rawHash = asset["sha256"] as? String ?: return null
                val path = normalizeAssetPath(rawPath.trim())
                val hash = rawHash.lowercase()
                if (path.isEmpty() || !hash.matches(Regex("^[0-9a-f]{64}$"))) return null
                val existing = hashes[path]
                if (existing != null && existing != hash) return null
                hashes[path] = hash
            }
        }
        return SignedRouteMetadata(value.toInt(), hashes)
    }

    /**
     * Stable anti-replay namespace: canonical network origin + the complete baked trust-anchor set.
     * The attacker-controlled routes path inside the deploy manifest is deliberately excluded.
     */
    fun replayScopeIdentifier(originURL: String): String? = try {
        val uri = URI(originURL)
        val scheme = uri.scheme?.lowercase()?.takeIf { it == "https" || it == "http" } ?: return null
        val rawHost = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port < 0 || uri.port == defaultPort) "" else ":${uri.port}"
        val host = if (rawHost.contains(':')) "[$rawHost]" else rawHost
        val anchors = config.anchors.map {
            "${it.algorithm.raw}:${Base64.getEncoder().encodeToString(it.keyData)}"
        }.sorted().joinToString("\n")
        hexSHA256("dsx-replay-v1\n$scheme://$host$port\n$anchors".toByteArray(Charsets.UTF_8))
    } catch (_: Exception) { null }

    /** Lowercase-hex SHA-256 of bytes — the form C2 manifest hashes are written/compared in. */
    fun hexSHA256(data: ByteArray): String =
        sha256(data).joinToString("") { "%02x".format(it) }

    /**
     * Normalize an asset path for hash-map keys/lookups: strip a leading `./` then a leading `/`, so the
     * manifest's relative path and the consumer's resolved (host-relative) path agree.
     */
    fun normalizeAssetPath(path: String): String {
        var p = path
        if (p.startsWith("./")) p = p.substring(2)
        if (p.startsWith("/")) p = p.substring(1)
        return p
    }

    /**
     * Constant-time-ish compare of two hex digests (length first, then a difference-accumulating XOR),
     * so the reject time doesn't leak where they diverge. Case-normalized to lowercase.
     */
    private fun constantTimeHexEqual(a: String, b: String): Boolean {
        val x = a.lowercase().toByteArray(Charsets.UTF_8)
        val y = b.lowercase().toByteArray(Charsets.UTF_8)
        if (x.size != y.size) return false
        var diff = 0
        for (i in x.indices) diff = diff or ((x[i].toInt() xor y[i].toInt()) and 0xFF)
        return diff == 0
    }

    // MARK: - Verify (the load-gate decision a package submits to)

    /**
     * Outcome of a verification attempt — a small typed result so a caller (and the test suite) can
     * branch on WHY a manifest was accepted or rejected, and so logs are precise.
     */
    enum class Verdict {
        verified,                 // signature checks out against a baked anchor → trusted
        disabled,                 // signing is OFF for this build → caller may trust the source as before
        rejectedNoSignature,      // signing ON but no signature supplied → REFUSE
        rejectedBadSignature,     // signing ON, signature present, verification failed → REFUSE
        rejectedMisconfigured,    // signing ON but no usable key was baked in → REFUSE (fail closed)
        rejectedRollback;         // signing ON, signature VALID, but the manifest version regressed → REFUSE (C1 anti-rollback)

        /** May the engine trust the manifest given this verdict? Only `verified` and `disabled`. */
        val trusted: Boolean get() = this == verified || this == disabled
    }

    /**
     * Verify a remote bundle manifest's DETACHED signature against the baked trust anchor(s). This is
     * the load gate. A package fetching a manifest calls it with the EXACT bytes it received and the
     * detached signature (from a sidecar file, an `X-DSX-Signature` header, or a `signature` envelope
     * field). On `verified` the digest is recorded so `isVerified(manifest)` returns true for the
     * SAME bytes; on any rejection the recorded digest is CLEARED (a failed refresh must not leave a
     * stale "verified" verdict standing). Off ⇒ `disabled` (no-op pass). Total: never throws.
     *
     * `keyId` is the OPTIONAL key id a signature declares (to pick among rotated keys); it only
     * narrows which anchors are tried FIRST and is never itself trusted — every listed key is a valid
     * signer, so an attacker naming a different `kid` gains nothing.
     */
    fun verifyManifest(manifest: ByteArray, signature: ByteArray?, keyId: String? = null): Verdict {
        if (!requiresVerification) return Verdict.disabled        // OFF ⇒ fail-open, today's behavior

        if (isMisconfigured) {                                    // ON but no usable key ⇒ fail CLOSED
            clearVerified()
            log("bundle-signing ENABLED but no usable public key parsed from App.json bundle_signing — refusing remote content (fail-closed). Fix the key or remove the block.")
            return Verdict.rejectedMisconfigured
        }
        if (signature == null || signature.isEmpty()) {           // ON but unsigned ⇒ REFUSE
            clearVerified()
            log("remote manifest has no signature but bundle-signing is enabled — refusing.")
            return Verdict.rejectedNoSignature
        }

        val candidates = anchorsToTry(keyId)
        for (anchor in candidates) {
            if (verify(manifest, signature, anchor)) {
                recordVerified(manifest)
                return Verdict.verified
            }
        }
        clearVerified()
        log("remote manifest signature did not verify against any baked key (${candidates.size} tried) — refusing.")
        return Verdict.rejectedBadSignature
    }

    /** Text convenience (the OTA layer holds manifests as strings). UTF-8 bytes are what gets signed. */
    fun verifyManifest(text: String, signature: ByteArray?, keyId: String? = null): Verdict =
        verifyManifest(text.toByteArray(Charsets.UTF_8), signature, keyId)

    // MARK: - The math (one anchor, one signature — no ambient state)

    /**
     * Raw signature verification for a single anchor. PURE — touches no recorded state, throws
     * nothing (a malformed key/signature is `false`, never a crash; totality matches the rest of the
     * engine's crypto). Ed25519: raw 64-byte signature over the raw message — via the platform
     * provider where it exists, else via the `ed25519LegacyVerifier` SEAM (empty by default ⇒ the
     * anchor cannot verify ⇒ `false`; the Android platform floor is the file header's one
     * documented divergence from Swift).
     * ECDSA-P256: raw r‖s (IEEE-P1363) over SHA-256 of the message, the WebCrypto/`crypto.subtle`
     * ECDSA layout — Java wants the key SPKI-wrapped and the signature DER-encoded, so both are
     * converted here (header).
     */
    fun verify(manifest: ByteArray, signature: ByteArray, anchor: Anchor): Boolean = try {
        when (anchor.algorithm) {
            Anchor.Algorithm.ed25519 -> {
                if (anchor.keyData.size != 32 || signature.size != 64) false
                else if (ed25519PlatformAvailable) {
                    val key = (ed25519Factory() ?: KeyFactory.getInstance("Ed25519"))
                        .generatePublic(X509EncodedKeySpec(ed25519SpkiPrefix + anchor.keyData))
                    val v = Signature.getInstance("Ed25519")
                    v.initVerify(key)
                    v.update(manifest)
                    v.verify(signature)
                } else {
                    // No platform provider (Android 24–32). Ask the seam; an EMPTY seam is a reject.
                    val legacy = ed25519LegacyVerifier
                    noteEd25519PlatformFloor(legacy != null)
                    legacy != null && legacy.verify(anchor.keyData, manifest, signature)
                }
            }
            Anchor.Algorithm.ecdsaP256 -> {
                val key = ecP256PublicKey(anchor.keyData)
                val der = p1363ToDer(signature)                   // raw r‖s ONLY — DER input fails, like CryptoKit
                if (key == null || der == null) false
                else {
                    val v = Signature.getInstance("SHA256withECDSA")
                    v.initVerify(key)
                    v.update(manifest)
                    v.verify(der)
                }
            }
        }
    } catch (_: Exception) { false }                              // total: malformed material is a reject, never a crash

    // MARK: - Ed25519 backend selection (the Android platform floor — file header)

    /**
     * Does THIS runtime ship an Ed25519 JCA provider? Probed ONCE (both entry points the verify path
     * needs), because the answer is a property of the platform, not of a call. TRUE on the JVM (JDK
     * ≥ 15) and on Android ≥ 33 (Conscrypt); FALSE on Android 24–32, where the `ed25519LegacyVerifier`
     * seam takes over (or, unfilled, refuses). Public because it is the honest answer to "which
     * backend verified this?" — diagnostics and tests read it; nothing writes it outside the test
     * seam below.
     */
    val ed25519PlatformAvailable: Boolean
        get() = _overrideEd25519PlatformAvailable ?: platformEd25519Probe

    private val platformEd25519Probe: Boolean get() = ed25519Factory() != null

    /**
     * A KeyFactory that can actually IMPORT a raw Ed25519 public key, or null.
     *
     * ANDROIDKEYSTORE REGISTERS "Ed25519" AND CANNOT IMPORT ONE. `KeyFactory.getInstance("Ed25519")`
     * on Android 33+ resolves to AndroidKeyStore, which only ever hands back keys IT generated:
     * `generatePublic(X509EncodedKeySpec(...))` throws
     *
     *     InvalidKeySpecException: To generate a key pair in Android Keystore, use
     *     KeyPairGenerator initialized with android.security.keystore.KeyGenParameterSpec
     *
     * The old probe asked only whether the algorithm could be INSTANTIATED, which AndroidKeyStore
     * answers yes to, so the gate believed the platform path worked and every verification failed
     * inside the catch-all below as `false`. Measured 2026-08-22 on an API 36 emulator: a signature
     * this same key verified in Ruby and on the JVM was refused on device, and the verdict read
     * "the entitlement was altered or signed by another key". That wording is what a leaked key
     * looks like, so the failure mode was not just wrong, it was wrong in an alarming direction.
     * The reach is every Ed25519 verification the gate does, remote-bundle signatures included:
     * a signed OTA would have been refused on every Android 13+ device.
     *
     * So the provider is CHOSEN rather than defaulted: the first one that survives an actual
     * import of a real 32-byte key, skipping AndroidKeyStore by name. Probed once.
     */
    private fun ed25519Factory(): KeyFactory? {
        cachedEd25519Factory?.let { return it }
        val chosen = probeEd25519Factory()
        cachedEd25519Factory = chosen
        return chosen
    }

    /// The provider that actually verifies, or null when none can. Diagnostics and tests read
    /// it; it is the honest answer to "which backend verified this", and on Android it is the
    /// difference between Conscrypt and the AndroidKeyStore stub that cannot import a key.
    val ed25519ProviderName: String?
        get() = ed25519Factory()?.provider?.name

    private var cachedEd25519Factory: KeyFactory? = null

    /// Test seam ONLY, paired with `_overrideEd25519PlatformAvailable` above: the choice is
    /// memoized for the process, so a suite that installs a provider has to be able to make the
    /// gate look again. Never called from package or host code.
    fun _resetEd25519ProviderProbe() {
        cachedEd25519Factory = null
    }

    private fun probeEd25519Factory(): KeyFactory? {
        // A valid Ed25519 public key: the RFC 8032 test vector, so the probe imports something
        // real rather than 32 zero bytes, which some providers reject as a small-order point.
        val sample = byteArrayOf(
            0xd7.toByte(), 0x5a.toByte(), 0x98.toByte(), 0x01.toByte(), 0x82.toByte(), 0xb1.toByte(),
            0x0a.toByte(), 0xb7.toByte(), 0xd5.toByte(), 0x4b.toByte(), 0xfe.toByte(), 0xd3.toByte(),
            0xc9.toByte(), 0x64.toByte(), 0x07.toByte(), 0x3a.toByte(), 0x0e.toByte(), 0xe1.toByte(),
            0x72.toByte(), 0xf3.toByte(), 0xda.toByte(), 0xa6.toByte(), 0x23.toByte(), 0x25.toByte(),
            0xaf.toByte(), 0x02.toByte(), 0x1a.toByte(), 0x68.toByte(), 0xf7.toByte(), 0x07.toByte(),
            0x51.toByte(), 0x1a.toByte(),
        )
        val candidates: List<KeyFactory> = buildList {
            java.security.Security.getProviders()
                .filter { it.name != "AndroidKeyStore" }
                .forEach { provider ->
                    runCatching { add(KeyFactory.getInstance("Ed25519", provider)) }
                }
            runCatching { add(KeyFactory.getInstance("Ed25519")) }
        }
        return candidates.firstOrNull { factory ->
            runCatching {
                factory.generatePublic(X509EncodedKeySpec(ed25519SpkiPrefix + sample))
                Signature.getInstance("Ed25519")
                true
            }.getOrDefault(false)
        }
    }

    /**
     * Test seam ONLY (no production writer). Forces the answer of the provider probe so the suite can
     * exercise BOTH backends on a JVM that always has the provider — the ONLY way a regression in the
     * Android-24-32 path can fail a test here. `false` simulates Android 7–12; `null` restores the
     * real probe. Never set from package or host code.
     */
    var _overrideEd25519PlatformAvailable: Boolean? = null

    // MARK: - The LEGACY Ed25519 seam (EMPTY by default — an excludable facet fills it)

    /**
     * The one thing the kernel asks of a legacy verifier: does this RAW 32-byte public key, over
     * these exact message bytes, validate this raw 64-byte detached signature? Same inputs, same
     * totality contract and the same accept-set as the platform path — a `fun interface` so the
     * filler is a lambda, exactly like `AppManifest.dynamicHostSource`.
     */
    fun interface Ed25519Verifier {
        fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
    }

    /**
     * EMPTY SEAM by default — no kernel hardcoding. The kernel knows nothing about curve math, point
     * encodings, or how an Ed25519 signature is checked; it knows only "the platform has no Ed25519
     * provider on this runtime, so ask the seam". Filled at setup/boot by the OPTIONAL, EXCLUDABLE
     * backward-compat facet `ClosedSource/DSX/Modules/Core/LegacyCrypto` (through the ordinary module
     * mechanism — never a registry singleton), whose whole reason to exist is Android < 33.
     *
     * FAIL-CLOSED WHEN EMPTY: `null` here means an Ed25519 anchor simply cannot verify on this
     * runtime, so `verify` returns false and `verifyManifest` answers `rejectedBadSignature` —
     * byte-for-byte the behavior before any fallback existed. An unfilled seam can never widen what
     * the gate accepts; it can only refuse. (Unreachable on API 33+, on the JVM and in CI, where the
     * platform provider is present and the seam is never consulted.)
     */
    var ed25519LegacyVerifier: Ed25519Verifier? = null

    /** One-shot per outcome: the platform floor announces itself once per process, not per manifest. */
    private var ed25519FloorServedAnnounced = false
    private var ed25519FloorUnservedAnnounced = false

    /**
     * Name the platform floor in the log the FIRST time it is reached, so "which code verified my
     * bundle?" — or "why did nothing verify it?" — is answerable from logcat instead of inferred.
     * The two cases are DIFFERENT facts and get different lines:
     *   • `served` — the legacy facet is installed and answered; a missing provider is no longer a
     *     failure, so this is deliberately not `dsx.error` (an error-ledger entry on every
     *     Android-12-and-below OTA would be noise that trains people to ignore the ledger).
     *   • `!served` — no provider AND no legacy facet in this build: every Ed25519 anchor is
     *     un-verifiable here, which is a real, actionable misconfiguration for an app that still
     *     supports API < 33, so it names the remedy.
     */
    private fun noteEd25519PlatformFloor(served: Boolean) {
        val announce = synchronized(lock) {
            if (served) {
                if (ed25519FloorServedAnnounced) false else { ed25519FloorServedAnnounced = true; true }
            } else {
                if (ed25519FloorUnservedAnnounced) false else { ed25519FloorUnservedAnnounced = true; true }
            }
        }
        if (!announce) return
        if (served) log(
            "no platform Ed25519 provider on this runtime (Android gained it in Conscrypt at API 33; " +
                "this build's floor is minSdk 24) — verifying through the installed legacy Ed25519 " +
                "facet (Core/LegacyCrypto). ECDSA-P256 anchors always use the platform provider."
        ) else log(
            "no platform Ed25519 provider on this runtime (Android gained it in Conscrypt at API 33; " +
                "this build's floor is minSdk 24) AND no legacy Ed25519 facet is installed — every " +
                "Ed25519 anchor is REFUSED on this device (fail-closed). Include Core/LegacyCrypto to " +
                "support API < 33, raise minSdk to 33, or add an ECDSA-P256 anchor to the rotation set."
        )
    }

    /**
     * Accept a P-256 public key as either an X9.63 point (0x04‖X‖Y) or DER/SPKI — whichever the build
     * side emits. Both map to the same Java key; trying X9.63 first (the compact form) then DER.
     */
    private fun ecP256PublicKey(data: ByteArray): PublicKey? {
        val spki = if (data.size == 65 && data[0] == 0x04.toByte()) p256SpkiFromX963(data) else data
        return try {
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
            // Light curve sanity (CryptoKit's P256 types reject foreign curves at parse): a 256-bit
            // field. A same-size foreign curve would merely fail verify — same observable, false.
            val ec = key as? java.security.interfaces.ECPublicKey ?: return null
            if (ec.params.curve.field.fieldSize != 256) null else key
        } catch (_: Exception) { null }
    }

    // MARK: - Anchors

    /**
     * The anchors to try for a given (optional) declared key id. A matching `kid` is tried FIRST as an
     * optimization, but ALL anchors remain candidates — `kid` is an untrusted hint, so it can only
     * reorder, never restrict away, the set of legitimate signers.
     */
    private fun anchorsToTry(keyId: String?): List<Anchor> {
        val all = config.anchors
        if (keyId == null || keyId.isEmpty()) return all
        val matching = all.filter { it.kid == keyId }
        val rest = all.filter { it.kid != keyId }
        return matching + rest
    }

    // MARK: - Recorded-verdict plumbing

    private fun recordVerified(manifest: ByteArray) {
        val d = sha256(manifest)
        synchronized(lock) { _verifiedDigest = d }
    }

    private fun clearVerified() {
        // Clears ONLY the verified-bytes digest (so the current table is refused). DELIBERATELY does NOT
        // clear the anti-rollback high-water mark: a failed/rollback refresh must not lower it, or an
        // attacker could induce a failure and then replay an older signed manifest.
        synchronized(lock) { _verifiedDigest = null }
    }

    /**
     * ORIGIN-SCOPE reset — a dev-origin switch (guides/staging-and-testing.md) moves the app to a
     * DIFFERENT origin whose signed tables have their own independent version line; carrying the
     * old origin's high-water mark across would false-positive anti-rollback (prod v100 → staging
     * v5 reads as a replay). Clears the verdict + the gate's mark slot + asset hashes so the next
     * refresh verifies fresh against the new origin. With the in-memory default store this is
     * byte-for-byte the Swift behavior (persisted per-origin marks live with the courier and stay
     * intact); a PERSISTENT `versionStore` should namespace per origin (header). Reachable only via
     * the `dev.originChanged` event, whose only firer (DevSettings) is env-gated off production.
     */
    fun resetForOriginChange() = _resetVerifiedForTesting()

    /**
     * Test seam: drop any recorded verdict, the anti-rollback version, AND the per-asset hash table so
     * cases don't bleed into one another.
     */
    fun _resetVerifiedForTesting() {
        synchronized(lock) {
            _verifiedDigest = null
            versionStore.remove(routesVersionKey)
            _assetHashes = emptyMap()
        }
        _overrideReleaseOTARequired = null
    }

    /** Constant-time digest compare (both are fixed 32-byte SHA-256s; still avoid an early-out compare). */
    private fun constantTimeEqual(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or ((a[i].toInt() xor b[i].toInt()) and 0xFF)
        return diff == 0
    }

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    private fun log(m: String) = kernelLog("[RemoteBundleGate] $m")

    // MARK: - Config parsing (App.json `bundle_signing`)

    /**
     * Parse the App.json `bundle_signing` block. Shapes accepted (all keys base64; raw 32-byte for
     * Ed25519, X9.63 or SPKI for ECDSA-P256):
     *
     *   "bundle_signing": { "algorithm": "Ed25519", "public_key": "BASE64" }          // single key
     *   "bundle_signing": { "enabled": true, "keys": [                                  // rotation set
     *       { "algorithm": "Ed25519",    "public_key": "BASE64", "kid": "2026-06" },
     *       { "algorithm": "ECDSA-P256", "public_key": "BASE64", "kid": "2026-01" } ] }
     *
     * `enabled` defaults to TRUE when a block is present (declaring the block IS the opt-in); set it
     * false to ship a key while leaving enforcement off (staging a rollout). Absent block ⇒ null ⇒ off.
     */
    fun parse(raw: Map<String, Any?>?): Config {
        if (raw == null) return Config(enabled = false, anchors = emptyList(), declaredKeyCount = 0)

        val enabled = (raw["enabled"] as? Boolean) ?: true         // present block defaults to ON
        var declared: List<Map<*, *>> = emptyList()
        val keys = raw["keys"] as? List<*>
        if (keys != null && keys.all { it is Map<*, *> }) {        // Swift's all-or-nothing [[String: Any]] cast
            declared = keys.map { it as Map<*, *> }
        } else if (raw["public_key"] != null) {                    // single-key shorthand
            declared = listOf(raw)
        }

        val anchors = ArrayList<Anchor>()
        for (entry in declared) {
            val anchor = parseAnchor(entry)
            if (anchor == null) {
                log("dropping an unparsable bundle_signing key entry (bad algorithm or base64).")
                continue
            }
            anchors.add(anchor)
        }
        return Config(enabled = enabled, anchors = anchors, declaredKeyCount = declared.size)
    }

    private fun parseAnchor(entry: Map<*, *>): Anchor? {
        val algRaw = (entry["algorithm"] as? String) ?: "Ed25519"  // Ed25519 is the default algorithm
        val algorithm = parseAlgorithm(algRaw) ?: return null
        val b64 = entry["public_key"] as? String ?: return null
        val keyData = decodeBase64(b64) ?: return null
        if (keyData.isEmpty()) return null
        // Sanity-bound the raw form so a wrong-length blob is rejected at parse, not at first verify.
        when (algorithm) {
            Anchor.Algorithm.ed25519 -> if (keyData.size != 32) return null
            Anchor.Algorithm.ecdsaP256 -> if (keyData.size < 33) return null   // X9.63 point is 65; SPKI larger
        }
        val kid = (entry["kid"] as? String)?.takeIf { it.isNotEmpty() }
        return Anchor(algorithm, keyData, kid)
    }

    /**
     * Map the author's algorithm string to a supported anchor algorithm, tolerant of common spellings
     * (case / separators), so "ed25519", "ECDSA_P256", "ecdsa-p256", "p256" all resolve. Unknown ⇒ null.
     */
    private fun parseAlgorithm(s: String): Anchor.Algorithm? {
        val n = s.lowercase().replace("_", "-").replace(" ", "")
        return when (n) {
            "ed25519", "ed-25519", "edwards25519" -> Anchor.Algorithm.ed25519
            "ecdsa-p256", "ecdsap256", "ecdsa-p-256", "p256", "p-256", "es256" -> Anchor.Algorithm.ecdsaP256
            else -> null
        }
    }

    /** Decode standard OR URL-safe base64 (with or without padding) — build pipelines emit both. */
    private fun decodeBase64(s: String): ByteArray? {
        try { return Base64.getDecoder().decode(s) } catch (_: IllegalArgumentException) {}
        var b = s.replace('-', '+').replace('_', '/')
        while (b.length % 4 != 0) b += "="
        return try { Base64.getDecoder().decode(b) } catch (_: IllegalArgumentException) { null }
    }

    // MARK: - ASN.1 plumbing (java.security has no raw-key / raw-signature entry points)

    /** The fixed SPKI prefix for a raw 32-byte Ed25519 key (ASN.1 decoded in the file header). */
    private val ed25519SpkiPrefix = byteArrayOf(
        0x30, 0x2a,                                  // SEQUENCE (42)          SubjectPublicKeyInfo
        0x30, 0x05,                                  //   SEQUENCE (5)         AlgorithmIdentifier
        0x06, 0x03, 0x2b, 0x65, 0x70,                //     OID 1.3.101.112    id-Ed25519
        0x03, 0x21, 0x00,                            //   BIT STRING (33, 0 unused) ‖ raw key
    )

    /** Wrap an X9.63 uncompressed P-256 point (0x04‖X‖Y, 65 bytes) into a DER SubjectPublicKeyInfo. */
    private fun p256SpkiFromX963(point: ByteArray): ByteArray = byteArrayOf(
        0x30, 0x59,                                  // SEQUENCE (89)          SubjectPublicKeyInfo
        0x30, 0x13,                                  //   SEQUENCE (19)        AlgorithmIdentifier
        0x06, 0x07, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x02, 0x01,   // OID 1.2.840.10045.2.1  id-ecPublicKey
        0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07,   // OID 1.2.840.10045.3.1.7  prime256v1
        0x03, 0x42, 0x00,                            //   BIT STRING (66, 0 unused) ‖ point
    ) + point

    /**
     * IEEE-P1363 raw `r‖s` (exactly 64 bytes for P-256) → DER `SEQUENCE { INTEGER r, INTEGER s }`,
     * the shape Java's `SHA256withECDSA` verifies. Minimal-form INTEGERs: leading zero bytes are
     * stripped, then a 0x00 pad is re-added iff the top bit is set (DER integers are signed). Any
     * other input length is `null` — the wire format is raw-only (CryptoKit parity; a DER-shaped
     * signature must NOT verify). Total body ≤ 70 bytes, so single-byte DER lengths always suffice.
     */
    fun p1363ToDer(signature: ByteArray): ByteArray? {
        if (signature.size != 64) return null
        fun derInt(v: ByteArray): ByteArray {
            var i = 0
            while (i < v.size - 1 && v[i] == 0.toByte()) i++     // strip leading zeros (keep one for 0)
            var t = v.copyOfRange(i, v.size)
            if (t[0] < 0) t = byteArrayOf(0) + t                  // top bit set ⇒ 0x00 pad (positive INTEGER)
            return byteArrayOf(0x02, t.size.toByte()) + t
        }
        val body = derInt(signature.copyOfRange(0, 32)) + derInt(signature.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}
