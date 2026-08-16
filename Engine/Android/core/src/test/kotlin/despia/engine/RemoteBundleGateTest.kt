package despia.engine

import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Conformance tests for the remote-bundle load gate — behavior pinned to RemoteBundleGate.swift
/// and to the reference signer's wire contract (`ClosedSource/scripts/sign_manifest.rb`):
///   Ed25519  → raw 64-byte signature over the RAW manifest bytes; App.json key = raw 32 bytes b64.
///   P-256    → raw r‖s (IEEE-P1363, 64 bytes) over SHA-256(manifest) — NOT DER; key = X9.63 point
///              (0x04‖X‖Y) or DER/SPKI, b64.
/// Keypairs are generated in-test with java.security and manifests signed the way the signer signs
/// them (Java emits ECDSA DER, converted DER→P1363 exactly like the signer's `der_to_p1363`), so a
/// green suite means the verifier accepts the signer's exact output shapes. The gate is a process
/// singleton — every test installs its config via `_overrideConfig` (the Swift-sanctioned seam) and
/// all trust state is reset after each test.
class RemoteBundleGateTest {

    private val manifest = """{"version":7,"routes":[{"path":"/","dsx":"home.dsx"}]}"""
        .toByteArray(Charsets.UTF_8)

    @AfterTest fun reset() {
        RemoteBundleGate._resetVerifiedForTesting()
        RemoteBundleGate._overrideConfig = null
        RemoteBundleGate.versionStore = RemoteBundleGate.InMemoryVersionStore()
        RemoteBundleGate.bundleSigningSource = { null }
        RemoteBundleGate._overrideEd25519PlatformAvailable = null   // back to the real provider probe
        RemoteBundleGate.ed25519LegacyVerifier = null               // back to the EMPTY kernel seam
    }

    // ── Signer-side helpers (what sign_manifest.rb emits, rebuilt on java.security) ──────────────

    private fun ed25519Pair(): KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

    /// The RAW 32-byte Ed25519 public key — the SPKI tail, the same trick the signer's
    /// `public_key_bytes` uses (`der[-32, 32]`).
    private fun ed25519RawPublic(kp: KeyPair): ByteArray =
        kp.public.encoded.let { it.copyOfRange(it.size - 32, it.size) }

    /// Ed25519 signs the raw message (no pre-hash) — raw 64-byte signature, the wire form.
    private fun ed25519Sign(kp: KeyPair, data: ByteArray): ByteArray {
        val s = Signature.getInstance("Ed25519")
        s.initSign(kp.private)
        s.update(data)
        return s.sign().also { assertEquals(64, it.size) }
    }

    private fun p256Pair(): KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
            .generateKeyPair()

    private fun i2osp(n: BigInteger, len: Int): ByteArray {
        val raw = n.toByteArray()
        val out = ByteArray(len)
        val src = raw.copyOfRange(maxOf(0, raw.size - len), raw.size)
        System.arraycopy(src, 0, out, len - src.size, src.size)
        return out
    }

    /// X9.63 uncompressed point 0x04‖X‖Y (65 bytes) — the App.json P-256 key form the signer emits.
    private fun x963Public(kp: KeyPair): ByteArray {
        val w = (kp.public as ECPublicKey).w
        return byteArrayOf(0x04) + i2osp(w.affineX, 32) + i2osp(w.affineY, 32)
    }

    /// ECDSA over SHA-256(message) — Java emits DER `SEQUENCE { INTEGER r, INTEGER s }`.
    private fun p256SignDer(kp: KeyPair, data: ByteArray): ByteArray {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(kp.private)
        s.update(data)
        return s.sign()
    }

    /// DER → raw r‖s (the signer's `der_to_p1363`): the wire signature form the gate consumes.
    private fun derToP1363(der: ByteArray): ByteArray {
        var i = 0
        assertEquals(0x30, der[i].toInt() and 0xFF); i++
        if ((der[i].toInt() and 0xFF) == 0x81) i++          // long-form length (never hit for P-256)
        i++
        fun readInt(): ByteArray {
            assertEquals(0x02, der[i].toInt() and 0xFF); i++
            val len = der[i].toInt() and 0xFF; i++
            val v = der.copyOfRange(i, i + len); i += len
            var j = 0
            while (j < v.size - 1 && v[j] == 0.toByte()) j++
            val t = v.copyOfRange(j, v.size)
            val out = ByteArray(32)
            System.arraycopy(t, 0, out, 32 - t.size, t.size)
            return out
        }
        return readInt() + readInt()
    }

    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun edAnchor(kp: KeyPair, kid: String? = null) =
        RemoteBundleGate.Anchor(RemoteBundleGate.Anchor.Algorithm.ed25519, ed25519RawPublic(kp), kid)

    private fun p256Anchor(keyData: ByteArray, kid: String? = null) =
        RemoteBundleGate.Anchor(RemoteBundleGate.Anchor.Algorithm.ecdsaP256, keyData, kid)

    /// Install a signing-ON config (the `_overrideConfig` test seam, as in Swift).
    private fun install(vararg anchors: RemoteBundleGate.Anchor) {
        RemoteBundleGate._overrideConfig =
            RemoteBundleGate.Config(enabled = true, anchors = anchors.toList(), declaredKeyCount = anchors.size)
    }

    // ── Fail-open when OFF (Article 7) ────────────────────────────────────────────────────────────

    @Test fun absentConfigIsDisabledAndTrusted() {
        assertFalse(RemoteBundleGate.isEnabled)                    // default source ⇒ no block ⇒ OFF
        assertFalse(RemoteBundleGate.requiresVerification)
        assertFalse(RemoteBundleGate.isMisconfigured)
        val v = RemoteBundleGate.verifyManifest(manifest, signature = null)
        assertEquals(RemoteBundleGate.Verdict.disabled, v)
        assertTrue(v.trusted)                                      // unsigned content passes, today's behavior
    }

    @Test fun explicitEnabledFalseIsOffEvenWithKeys() {
        val kp = ed25519Pair()
        RemoteBundleGate._overrideConfig =
            RemoteBundleGate.Config(enabled = false, anchors = listOf(edAnchor(kp)), declaredKeyCount = 1)
        assertFalse(RemoteBundleGate.isEnabled)
        assertEquals(RemoteBundleGate.Verdict.disabled, RemoteBundleGate.verifyManifest(manifest, null))
    }

    @Test fun presentBlockWithZeroDeclaredKeysIsOffNotMisconfigured() {
        val c = RemoteBundleGate.parse(emptyMap())                 // "bundle_signing": {}
        assertTrue(c.enabled)                                      // present block defaults enabled
        assertEquals(0, c.declaredKeyCount)
        RemoteBundleGate._overrideConfig = c
        assertFalse(RemoteBundleGate.isEnabled)                    // no key declared ⇒ not the opt-in
        assertFalse(RemoteBundleGate.isMisconfigured)
        assertEquals(RemoteBundleGate.Verdict.disabled, RemoteBundleGate.verifyManifest(manifest, null))
    }

    // ── Fail-closed when ON ───────────────────────────────────────────────────────────────────────

    @Test fun missingOrEmptySignatureIsRefused() {
        install(edAnchor(ed25519Pair()))
        assertEquals(RemoteBundleGate.Verdict.rejectedNoSignature, RemoteBundleGate.verifyManifest(manifest, null))
        assertEquals(RemoteBundleGate.Verdict.rejectedNoSignature, RemoteBundleGate.verifyManifest(manifest, ByteArray(0)))
        assertFalse(RemoteBundleGate.isVerified(manifest))
    }

    @Test fun misconfiguredFailsClosedLoudlyNotSilentlyOff() {
        // ON (block present, 1 key declared) but the key is garbage ⇒ zero usable anchors.
        val c = RemoteBundleGate.parse(mapOf("public_key" to "!!!not-base64!!!"))
        assertTrue(c.enabled)
        assertEquals(1, c.declaredKeyCount)
        assertTrue(c.anchors.isEmpty())
        RemoteBundleGate._overrideConfig = c
        assertTrue(RemoteBundleGate.isEnabled)
        assertTrue(RemoteBundleGate.isMisconfigured)
        val v = RemoteBundleGate.verifyManifest(manifest, ByteArray(64))
        assertEquals(RemoteBundleGate.Verdict.rejectedMisconfigured, v)
        assertFalse(v.trusted)
    }

    @Test fun verdictTrustMatrix() {
        assertTrue(RemoteBundleGate.Verdict.verified.trusted)
        assertTrue(RemoteBundleGate.Verdict.disabled.trusted)
        assertFalse(RemoteBundleGate.Verdict.rejectedNoSignature.trusted)
        assertFalse(RemoteBundleGate.Verdict.rejectedBadSignature.trusted)
        assertFalse(RemoteBundleGate.Verdict.rejectedMisconfigured.trusted)
        assertFalse(RemoteBundleGate.Verdict.rejectedRollback.trusted)
    }

    // ── Ed25519 (the default scheme; signer contract: raw sig over raw bytes, raw-32 key) ─────────

    @Test fun ed25519AcceptsTheSignersOutput() {
        val kp = ed25519Pair()
        // Bake the key the way App.json does: base64 of the raw 32 bytes, through the REAL parser.
        RemoteBundleGate._overrideConfig = RemoteBundleGate.parse(
            mapOf("algorithm" to "Ed25519", "public_key" to b64(ed25519RawPublic(kp)))
        )
        assertTrue(RemoteBundleGate.isEnabled)
        val sig = ed25519Sign(kp, manifest)
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, sig))
        assertTrue(RemoteBundleGate.isVerified(manifest))
        assertTrue(RemoteBundleGate.isVerified(String(manifest, Charsets.UTF_8)))   // text convenience
        assertFalse(RemoteBundleGate.isVerified("""{"other":true}"""))              // pure content check
    }

    @Test fun ed25519RejectsTamperedBytesAndClearsTheStaleVerdict() {
        val kp = ed25519Pair()
        install(edAnchor(kp))
        val sig = ed25519Sign(kp, manifest)
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, sig))

        val tampered = manifest.copyOf().also { it[10] = (it[10] + 1).toByte() }
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(tampered, sig))
        // A failed refresh must not leave the previous "verified" verdict standing.
        assertFalse(RemoteBundleGate.isVerified(manifest))
    }

    @Test fun ed25519RejectsTamperedSignatureAndWrongKey() {
        val signer = ed25519Pair()
        val sig = ed25519Sign(signer, manifest)

        install(edAnchor(signer))
        val flipped = sig.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, flipped))

        install(edAnchor(ed25519Pair()))                           // a DIFFERENT baked key
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, sig))
    }

    @Test fun ed25519TextConvenienceSignsUtf8Bytes() {
        val kp = ed25519Pair()
        install(edAnchor(kp))
        val text = String(manifest, Charsets.UTF_8)
        val sig = ed25519Sign(kp, manifest)
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(text, sig))
    }

    // ── ECDSA-P256 (signer contract: raw r‖s over SHA-256, X9.63 or SPKI key) ─────────────────────

    @Test fun p256AcceptsTheSignersOutputWithAnX963Key() {
        val kp = p256Pair()
        RemoteBundleGate._overrideConfig = RemoteBundleGate.parse(
            mapOf("algorithm" to "ECDSA-P256", "public_key" to b64(x963Public(kp)))
        )
        val raw = derToP1363(p256SignDer(kp, manifest))            // the signer's exact conversion
        assertEquals(64, raw.size)
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, raw))
        assertTrue(RemoteBundleGate.isVerified(manifest))
    }

    @Test fun p256AcceptsADerSpkiKeyToo() {
        val kp = p256Pair()
        install(p256Anchor(kp.public.encoded))                     // SPKI SubjectPublicKeyInfo form
        val raw = derToP1363(p256SignDer(kp, manifest))
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, raw))
    }

    @Test fun p256RejectsADerShapedSignature() {
        // The wire format is raw r‖s ONLY (CryptoKit `rawRepresentation` parity) — a DER signature,
        // valid crypto but the wrong shape, must NOT verify.
        val kp = p256Pair()
        install(p256Anchor(x963Public(kp)))
        val der = p256SignDer(kp, manifest)
        assertTrue(der.size != 64)
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, der))
    }

    @Test fun p256RejectsTamperAndWrongKey() {
        val kp = p256Pair()
        install(p256Anchor(x963Public(kp)))
        val raw = derToP1363(p256SignDer(kp, manifest))

        val tampered = manifest.copyOf().also { it[3] = (it[3].toInt() xor 0x20).toByte() }
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(tampered, raw))

        install(p256Anchor(x963Public(p256Pair())))
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, raw))
    }

    // ── raw r‖s ⇄ DER conversion (the JVM-forced seam of this port) ───────────────────────────────

    @Test fun rawToDerRoundTripsAcrossManySignatures() {
        val kp = p256Pair()
        install(p256Anchor(x963Public(kp)))
        repeat(25) { i ->
            val body = "manifest-$i".toByteArray()
            val raw = derToP1363(p256SignDer(kp, body))            // random r/s: leading zeros + high bits vary
            // The port's raw→DER must produce a DER Java verifies…
            assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(body, raw))
            // …and structurally round-trip back to the identical raw form.
            assertContentEquals(raw, derToP1363(RemoteBundleGate.p1363ToDer(raw)!!))
        }
    }

    @Test fun rawToDerMinimalIntegerEdges() {
        // r = 1 (31 leading zero bytes → strip to one byte), s = all-0xFF (top bit set → 0x00 pad).
        val raw = ByteArray(64).also { it[31] = 1; for (i in 32 until 64) it[i] = 0xFF.toByte() }
        val der = RemoteBundleGate.p1363ToDer(raw)
        assertNotNull(der)
        assertContentEquals(byteArrayOf(0x30, 0x26, 0x02, 0x01, 0x01, 0x02, 0x21, 0x00), der.copyOfRange(0, 8))
        assertEquals(40, der.size)
        assertContentEquals(raw, derToP1363(der))
        // Non-64-byte input is not a wire signature at all.
        assertNull(RemoteBundleGate.p1363ToDer(ByteArray(63)))
        assertNull(RemoteBundleGate.p1363ToDer(ByteArray(70)))
    }

    // ── Key rotation + kid ordering ───────────────────────────────────────────────────────────────

    @Test fun kidReordersButNeverRestrictsTheAnchorSet() {
        val old = ed25519Pair()
        val new = ed25519Pair()
        install(edAnchor(old, kid = "2026-01"), edAnchor(new, kid = "2026-06"))
        val sig = ed25519Sign(new, manifest)
        // Declared kid matches the signer, a different key's kid, an unknown kid, none — all verify:
        // every baked key remains a legitimate signer (kid is an untrusted ordering hint).
        for (kid in listOf("2026-06", "2026-01", "who-knows", null)) {
            assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, sig, kid), "kid=$kid")
        }
    }

    @Test fun mixedAlgorithmRotationSetTriesEveryAnchor() {
        val ed = ed25519Pair()
        val ec = p256Pair()
        install(p256Anchor(x963Public(ec), kid = "ec"), edAnchor(ed, kid = "ed"))
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, ed25519Sign(ed, manifest)))
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, derToP1363(p256SignDer(ec, manifest))))
    }

    // ── C1 anti-rollback (monotonic mark + the store seam) ────────────────────────────────────────

    @Test fun recordVersionIsMonotonicAndNullNeverLowers() {
        assertNull(RemoteBundleGate.lastVerifiedVersion())         // fresh epoch: first manifest always allowed
        RemoteBundleGate.recordVersion(null)                       // unversioned (old bare-array form) ⇒ no mark
        assertNull(RemoteBundleGate.lastVerifiedVersion())
        RemoteBundleGate.recordVersion(5)
        assertEquals(5, RemoteBundleGate.lastVerifiedVersion())
        RemoteBundleGate.recordVersion(3)                          // regression ignored (belt-and-braces)
        assertEquals(5, RemoteBundleGate.lastVerifiedVersion())
        RemoteBundleGate.recordVersion(null)                       // null never clears the high-water mark
        assertEquals(5, RemoteBundleGate.lastVerifiedVersion())
        RemoteBundleGate.recordVersion(7)
        assertEquals(7, RemoteBundleGate.lastVerifiedVersion())
    }

    @Test fun rejectForRollbackRevokesTheVerdictButKeepsTheMark() {
        val kp = ed25519Pair()
        install(edAnchor(kp))
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, ed25519Sign(kp, manifest)))
        RemoteBundleGate.recordVersion(9)
        assertTrue(RemoteBundleGate.isVerified(manifest))

        // The courier detects a regressed version inside cryptographically-valid bytes and refuses.
        RemoteBundleGate.rejectForRollback()
        assertFalse(RemoteBundleGate.isVerified(manifest))         // the rolled-back table is untrusted…
        assertEquals(9, RemoteBundleGate.lastVerifiedVersion())    // …but the mark NEVER lowers (no replay window)
    }

    @Test fun versionStoreSeamCarriesPersistenceAndSeeding() {
        // A platform store pre-seeded from a previous launch: the gate reads through it.
        val store = RemoteBundleGate.InMemoryVersionStore()
        store.set("routes", 42)
        RemoteBundleGate.versionStore = store
        assertEquals(42, RemoteBundleGate.lastVerifiedVersion())
        RemoteBundleGate.recordVersion(41)                         // monotonic against the SEEDED mark
        assertEquals(42, store.get("routes"))
        RemoteBundleGate.recordVersion(50)
        assertEquals(50, store.get("routes"))                      // writes land in the injected store
    }

    @Test fun resetForOriginChangeClearsVerdictMarkAndHashes() {
        val kp = ed25519Pair()
        install(edAnchor(kp))
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, ed25519Sign(kp, manifest)))
        RemoteBundleGate.recordVersion(100)
        RemoteBundleGate.setAssetHashes(mapOf("a.dsx" to RemoteBundleGate.hexSHA256(byteArrayOf(1))))

        RemoteBundleGate.resetForOriginChange()                    // prod v100 → staging v5 must not read as replay
        assertFalse(RemoteBundleGate.isVerified(manifest))
        assertNull(RemoteBundleGate.lastVerifiedVersion())
        assertNull(RemoteBundleGate.expectedAssetHash("a.dsx"))
    }

    // ── C2 per-asset hashes ───────────────────────────────────────────────────────────────────────

    @Test fun assetPathNormalizationAgreesAcrossSpellings() {
        install(edAnchor(ed25519Pair()))
        val data = "asset-bytes".toByteArray()
        RemoteBundleGate.setAssetHashes(mapOf("app/home.dsx" to RemoteBundleGate.hexSHA256(data)))
        for (spelling in listOf("app/home.dsx", "/app/home.dsx", "./app/home.dsx")) {
            assertNotNull(RemoteBundleGate.expectedAssetHash(spelling), spelling)
            assertEquals(RemoteBundleGate.AssetCheck.match, RemoteBundleGate.checkAsset(data, spelling), spelling)
        }
        assertNull(RemoteBundleGate.expectedAssetHash("app/other.dsx"))
    }

    @Test fun checkAssetSkipMissingMatchMismatchMatrix() {
        val data = "asset-bytes".toByteArray()

        // Signing OFF ⇒ skip, even with a table published (today's behavior).
        RemoteBundleGate.setAssetHashes(mapOf("a" to RemoteBundleGate.hexSHA256(data)))
        assertEquals(RemoteBundleGate.AssetCheck.skip, RemoteBundleGate.checkAsset(data, "a"))

        install(edAnchor(ed25519Pair()))                           // ON from here
        assertEquals(RemoteBundleGate.AssetCheck.missing, RemoteBundleGate.checkAsset(data, "undeclared"))
        assertEquals(RemoteBundleGate.AssetCheck.match, RemoteBundleGate.checkAsset(data, "a"))
        assertEquals(RemoteBundleGate.AssetCheck.mismatch, RemoteBundleGate.checkAsset("evil".toByteArray(), "a"))

        // The hex compare is case-normalized (an uppercase pipeline digest still matches).
        RemoteBundleGate.setAssetHashes(mapOf("up" to RemoteBundleGate.hexSHA256(data).uppercase()))
        assertEquals(RemoteBundleGate.AssetCheck.match, RemoteBundleGate.checkAsset(data, "up"))
    }

    // ── Production policy + strict signed-table contract ─────────────────────────────────

    @Test fun releaseOtaRequiresAUsableEnabledTrustAnchor() {
        RemoteBundleGate._overrideReleaseOTARequired = true
        assertTrue(RemoteBundleGate.requiresVerification)
        assertTrue(RemoteBundleGate.isMisconfigured)
        assertEquals(RemoteBundleGate.Verdict.rejectedMisconfigured,
            RemoteBundleGate.verifyManifest(manifest, ByteArray(64)))

        install(edAnchor(ed25519Pair()))
        assertFalse(RemoteBundleGate.isMisconfigured)

        RemoteBundleGate._overrideConfig = RemoteBundleGate.Config(
            enabled = false, anchors = RemoteBundleGate.config.anchors, declaredKeyCount = 1)
        assertTrue(RemoteBundleGate.isMisconfigured)
    }

    @Test fun explicitDebugMayKeepUnsignedOtaDisabledGate() {
        RemoteBundleGate._overrideReleaseOTARequired = false
        assertFalse(RemoteBundleGate.requiresVerification)
        assertEquals(RemoteBundleGate.Verdict.disabled, RemoteBundleGate.verifyManifest(manifest, null))
    }

    @Test fun signedRouteMetadataRequiresVersionedObjectAndValidHashes() {
        val hash = "a".repeat(64)
        val good = """{"version":12,"routes":[{"path":"/","assets":[{"path":"/home.dsx","sha256":"$hash"}]}]}"""
        val metadata = RemoteBundleGate.signedRouteMetadata(good)
        assertNotNull(metadata)
        assertEquals(12, metadata.version)
        assertEquals(hash, metadata.assetHashes["home.dsx"])

        assertNull(RemoteBundleGate.signedRouteMetadata("[]"))
        assertNull(RemoteBundleGate.signedRouteMetadata("""{"routes":[]}"""))
        assertNull(RemoteBundleGate.signedRouteMetadata("""{"version":1.5,"routes":[]}"""))
        assertNull(RemoteBundleGate.signedRouteMetadata("""{"version":-1,"routes":[]}"""))
        assertNull(RemoteBundleGate.signedRouteMetadata(
            """{"version":1,"routes":[{"assets":[{"path":"x","sha256":"abc"}]}]}"""))
    }

    @Test fun replayScopeBindsAnchorsAndOriginNotRoutesPath() {
        val first = ed25519Pair()
        val second = ed25519Pair()
        install(edAnchor(first), edAnchor(second))
        val a = RemoteBundleGate.replayScopeIdentifier("https://EXAMPLE.com/deploy/manifest.json")
        val b = RemoteBundleGate.replayScopeIdentifier("https://example.com/other/routes.json")
        assertEquals(a, b)
        assertFalse(a == RemoteBundleGate.replayScopeIdentifier("https://other.example/manifest.json"))

        install(edAnchor(first))
        assertFalse(a == RemoteBundleGate.replayScopeIdentifier("https://example.com/manifest.json"))
    }

    // ── Config parsing (App.json `bundle_signing` shapes) ─────────────────────────────────────────

    @Test fun parseAcceptsBothDocumentedShapesAndTheSpellings() {
        val raw = ed25519RawPublic(ed25519Pair())

        val single = RemoteBundleGate.parse(mapOf("public_key" to b64(raw)))   // algorithm defaults Ed25519
        assertEquals(1, single.anchors.size)
        assertEquals(RemoteBundleGate.Anchor.Algorithm.ed25519, single.anchors[0].algorithm)
        assertNull(single.anchors[0].kid)
        assertContentEquals(raw, single.anchors[0].keyData)

        val ecPoint = x963Public(p256Pair())
        val rotation = RemoteBundleGate.parse(mapOf(
            "enabled" to true,
            "keys" to listOf(
                mapOf("algorithm" to "ed25519", "public_key" to b64(raw), "kid" to "2026-06"),
                mapOf("algorithm" to "ECDSA_P256", "public_key" to b64(ecPoint), "kid" to ""),   // empty kid ⇒ null
                mapOf("algorithm" to "es256", "public_key" to b64(ecPoint)),
            ),
        ))
        assertEquals(3, rotation.declaredKeyCount)
        assertEquals(3, rotation.anchors.size)
        assertEquals("2026-06", rotation.anchors[0].kid)
        assertNull(rotation.anchors[1].kid)
        assertEquals(RemoteBundleGate.Anchor.Algorithm.ecdsaP256, rotation.anchors[2].algorithm)
    }

    @Test fun parseDecodesUrlSafeUnpaddedBase64() {
        val raw = ed25519RawPublic(ed25519Pair())
        val urlSafe = Base64.getUrlEncoder().withoutPadding().encodeToString(raw)
        val c = RemoteBundleGate.parse(mapOf("public_key" to urlSafe))
        assertEquals(1, c.anchors.size)
        assertContentEquals(raw, c.anchors[0].keyData)
    }

    @Test fun parseDropsUnusableKeysButCountsThemAsDeclared() {
        val good = b64(ed25519RawPublic(ed25519Pair()))
        val c = RemoteBundleGate.parse(mapOf("keys" to listOf(
            mapOf("public_key" to good),
            mapOf("algorithm" to "rsa-4096", "public_key" to good),          // unknown algorithm ⇒ dropped
            mapOf("public_key" to b64(ByteArray(31))),                       // wrong-length Ed25519 key ⇒ dropped
            mapOf("algorithm" to "p256", "public_key" to b64(ByteArray(16))), // too short for any P-256 form ⇒ dropped
            mapOf("algorithm" to "Ed25519"),                                 // no key at all ⇒ dropped
        )))
        assertEquals(5, c.declaredKeyCount)                        // "all unparsable" stays detectable
        assertEquals(1, c.anchors.size)
    }

    @Test fun parseNonDictKeysArrayFallsBackToTheShorthand() {
        // Swift's `as? [[String: Any]]` is all-or-nothing: a malformed keys array falls through to
        // the single-key shorthand when a top-level public_key exists.
        val raw = ed25519RawPublic(ed25519Pair())
        val c = RemoteBundleGate.parse(mapOf("keys" to listOf("junk"), "public_key" to b64(raw)))
        assertEquals(1, c.declaredKeyCount)
        assertEquals(1, c.anchors.size)
    }

    @Test fun bundleSigningSourceSeamFeedsTheParser() {
        // The boot seam parses the exact same shapes (cached on first read — exercised via parse()
        // above; here just pin that the closure is the config's source of truth when unset).
        RemoteBundleGate.bundleSigningSource = { mapOf("public_key" to b64(ed25519RawPublic(ed25519Pair()))) }
        // NOTE: `config` may already be lazily cached from earlier tests (mirrors Swift's
        // process-lifetime `static let`), so assert through parse(), not the cached property.
        val c = RemoteBundleGate.parse(RemoteBundleGate.bundleSigningSource())
        assertTrue(c.enabled)
        assertEquals(1, c.anchors.size)
    }

    // ── Ed25519 on the Android platform floor (minSdk 24 — no provider before API 33) ─────────────
    //
    // THE BUG THESE PIN: Conscrypt gained `Ed25519` only at API 33, but every Android module targets
    // minSdk 24 — so on Android 7–12 `Signature.getInstance("Ed25519")` throws, the gate's totality
    // `catch` swallows it, and EVERY correctly signed remote bundle is refused (the documented
    // DEFAULT algorithm, silently frozen on the bundled floor). This suite is pure-JVM, where the
    // provider is ALWAYS present, so nothing above can ever see that path. `_overrideEd25519Platform
    // Available = false` is the seam that makes it reachable: it declares the provider absent.
    //
    // WHAT IS KERNEL, AND THEREFORE WHAT IS TESTED HERE. The kernel owns an EMPTY SEAM
    // (`ed25519LegacyVerifier`, null by default) and nothing else — no curve math, no RFC 8032. The
    // RFC 8032 verifier itself is BACKWARD-COMPAT for old Android and lives in the excludable facet
    // `ClosedSource/DSX/Modules/Core/LegacyCrypto`, together with its conformance suite (§7.1
    // vectors, the randomized differential cross-check against the JDK provider, the S+L
    // malleability forgery, the gate path with the facet installed) —
    // `Core/LegacyCrypto/shared/tests/LegacyEd25519Test.kt`, run in the `:app` JVM unit-test lane.
    // These cases pin the KERNEL half of the contract, and above all configuration (b) of the
    // quarantine: facet EXCLUDED + provider absent ⇒ REFUSED, never accepted.

    @Test fun theJvmHasAPlatformEd25519ProviderAndTheSeamCanDenyIt() {
        // Documents WHY the test seam exists: on this JVM (and on Android ≥ 33) the probe says yes,
        // so the legacy path would otherwise be unreachable — and untestable — forever.
        assertTrue(RemoteBundleGate.ed25519PlatformAvailable)
        RemoteBundleGate._overrideEd25519PlatformAvailable = false
        assertFalse(RemoteBundleGate.ed25519PlatformAvailable)
        RemoteBundleGate._overrideEd25519PlatformAvailable = null
        assertTrue(RemoteBundleGate.ed25519PlatformAvailable)
    }

    @Test fun theEd25519LegacySeamIsEmptyUntilSomethingFillsIt() {
        // The kernel ships the hook UNFILLED. If this ever starts out non-null, the kernel has
        // acquired a built-in crypto default again and the quarantine has silently regressed.
        assertNull(RemoteBundleGate.ed25519LegacyVerifier)
    }

    @Test fun emptyEd25519SeamRefusesACorrectlySignedManifest() {
        // CONFIGURATION (b) OF THE QUARANTINE — legacy facet EXCLUDED (the seam is null, which is
        // exactly what a build without Core/LegacyCrypto has) + platform provider absent. A
        // PERFECTLY GOOD signature must be REFUSED: fail-closed is the whole contract of an empty
        // seam. An unfilled seam may never accept anything.
        val kp = ed25519Pair()
        val sig = ed25519Sign(kp, manifest)
        install(edAnchor(kp))
        RemoteBundleGate._overrideEd25519PlatformAvailable = false
        assertNull(RemoteBundleGate.ed25519LegacyVerifier)

        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, sig))
        assertFalse(RemoteBundleGate.isVerified(manifest))
        assertFalse(RemoteBundleGate.verify(manifest, sig, edAnchor(kp)))

        // …and the SAME bytes verify the instant the platform provider is back — proving the refusal
        // was the empty seam and not a broken signature.
        RemoteBundleGate._overrideEd25519PlatformAvailable = null
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, sig))
    }

    @Test fun aFilledEd25519SeamIsConsultedOnlyWhenThePlatformCannot() {
        // CONFIGURATION (a), kernel half — with a STUB in the seam (the kernel names no facet and
        // knows no math). Two facts: the kernel delegates verbatim (raw key, exact message bytes,
        // raw signature) when the provider is absent, and it never asks when the provider is there.
        val kp = ed25519Pair()
        val sig = ed25519Sign(kp, manifest)
        val expectedKey = ed25519RawPublic(kp)
        var calls = 0
        RemoteBundleGate.ed25519LegacyVerifier = RemoteBundleGate.Ed25519Verifier { key, message, signature ->
            calls += 1
            assertContentEquals(expectedKey, key)
            assertContentEquals(manifest, message)
            assertContentEquals(sig, signature)
            true
        }
        install(edAnchor(kp))

        RemoteBundleGate._overrideEd25519PlatformAvailable = false
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, sig))
        assertEquals(1, calls)

        // Provider present ⇒ the seam is NOT consulted (API 33+, the JVM, CI — unchanged behavior).
        RemoteBundleGate._overrideEd25519PlatformAvailable = true
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, sig))
        assertEquals(1, calls)
    }

    @Test fun aFilledSeamThatRefusesStillFailsClosed() {
        // A facet is never trusted to be right: a seam answering `false` — or throwing — is a
        // rejection, not a crash and not an accept. Totality is the kernel's, not the facet's.
        val kp = ed25519Pair()
        val sig = ed25519Sign(kp, manifest)
        install(edAnchor(kp))
        RemoteBundleGate._overrideEd25519PlatformAvailable = false

        RemoteBundleGate.ed25519LegacyVerifier = RemoteBundleGate.Ed25519Verifier { _, _, _ -> false }
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, sig))

        RemoteBundleGate.ed25519LegacyVerifier = RemoteBundleGate.Ed25519Verifier { _, _, _ ->
            throw IllegalStateException("a facet blew up")
        }
        assertEquals(RemoteBundleGate.Verdict.rejectedBadSignature, RemoteBundleGate.verifyManifest(manifest, sig))
        assertFalse(RemoteBundleGate.isVerified(manifest))
    }

    @Test fun theSeamIsNeverConsultedForMalformedEd25519Material() {
        // The kernel's own length gate runs BEFORE the seam: a 31-byte key or a 63-byte signature is
        // not wire material, so no facet ever sees it (and an over-eager facet cannot widen it).
        val kp = ed25519Pair()
        var calls = 0
        RemoteBundleGate.ed25519LegacyVerifier = RemoteBundleGate.Ed25519Verifier { _, _, _ -> calls += 1; true }
        RemoteBundleGate._overrideEd25519PlatformAvailable = false

        val shortKey = RemoteBundleGate.Anchor(
            RemoteBundleGate.Anchor.Algorithm.ed25519, ByteArray(31), null)
        assertFalse(RemoteBundleGate.verify(manifest, ed25519Sign(kp, manifest), shortKey))
        assertFalse(RemoteBundleGate.verify(manifest, ByteArray(63), edAnchor(kp)))
        assertEquals(0, calls)
    }

    @Test fun p256IsUnaffectedByEd25519ProviderAbsence() {
        // ECDSA-P256 is the MODERN alternative below API 33: `SHA256withECDSA` + the `EC` KeyFactory
        // are platform-provided on every supported API level, so a P-256 anchor never consults the
        // legacy seam at all — an app can drop Core/LegacyCrypto and still serve Android 7–12 by
        // carrying a P-256 anchor in its rotation set.
        val kp = p256Pair()
        install(p256Anchor(x963Public(kp)))
        RemoteBundleGate._overrideEd25519PlatformAvailable = false
        val raw = derToP1363(p256SignDer(kp, manifest))
        assertEquals(RemoteBundleGate.Verdict.verified, RemoteBundleGate.verifyManifest(manifest, raw))
    }

    // ── hex digest primitive ──────────────────────────────────────────────────────────────────────

    @Test fun hexSHA256MatchesTheKnownVector() {
        // sha256("abc") — FIPS 180-2 test vector; lowercase hex is the manifest wire form.
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            RemoteBundleGate.hexSHA256("abc".toByteArray()),
        )
    }
}
