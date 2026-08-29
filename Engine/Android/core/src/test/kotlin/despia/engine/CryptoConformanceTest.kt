package despia.engine

import java.io.File
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import java.util.Base64
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The crypto conformance runner - executes OpenSource/Conformance/crypto/{vectors,uniformity}.json
 * through THIS runtime (parity/F15-crypto.md). The TS twin is
 * packages/kernel/test/crypto-conformance.test.ts and the Swift reference is
 * Engine/iOS/CryptoCore.swift; all three run the same files, so a v7 id minted on Android
 * sorts against one minted in a browser and `randomInt` is uniform everywhere or nowhere.
 *
 * The digest and MAC vectors run against the PLATFORM implementation (java.security), not
 * against anything in this repo. That is the point: the corpus proves the vectors and the
 * algorithm-name fold, the platform proves the cryptography, and nothing here rolls a
 * primitive.
 *
 * The keyref half of the corpus is a manifest contract check and lives on the TS runner only
 * (it reads Core/Crypto's dsx.json, which is not on the Android test classpath).
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class CryptoConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/crypto/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/crypto/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpus(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(doc: Map<String, Any?>, key: String): List<Map<String, Any?>> {
        val list = doc[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.isNotEmpty(), "$key must not be empty")
        return list
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    // ── vectors.json ─────────────────────────────────────────────────────────────────────

    @Test
    fun digestNameFoldAgreesWithCorpus() {
        for (case in rows(corpus("vectors.json"), "spellings")) {
            val allowLegacy = case["allowLegacy"] as? Boolean ?: true
            val expect = case["expect"] as? String
            val got = CryptoCore.foldDigest(case["input"] as? String, allowLegacy)
            if (expect == null) assertNull(got, case["name"] as? String) else assertEquals(expect, got, case["name"] as? String)
        }
        for ((id, digest) in CryptoCore.DIGESTS) {
            assertTrue(digest.jca.isNotEmpty(), "$id has a JCA name")
            assertTrue(digest.web.isNotEmpty(), "$id has a WebCrypto name")
        }
    }

    @Test
    fun digestVectorsMatchThePlatformImplementation() {
        for (case in rows(corpus("vectors.json"), "digest")) {
            val id = CryptoCore.foldDigest(case["algorithm"] as? String) ?: error("${case["name"]}: unknown algorithm")
            val jca = CryptoCore.DIGESTS.getValue(id).jca
            val out = MessageDigest.getInstance(jca).digest((case["data"] as String).toByteArray(Charsets.UTF_8))
            val encoded = when (case["output"] as? String ?: "hex") {
                "base64" -> Base64.getEncoder().encodeToString(out)
                else -> hex(out)
            }
            assertEquals(case["expect"], encoded, case["name"] as? String)
        }
    }

    @Test
    fun hmacVectorsMatchThePlatformImplementation() {
        for (case in rows(corpus("vectors.json"), "hmac")) {
            val id = CryptoCore.foldDigest(case["algorithm"] as? String) ?: error("${case["name"]}: unknown algorithm")
            assertTrue(CryptoCore.MAC_DIGESTS.contains(id), "${case["name"]}: not a MAC algorithm")
            val keyBytes = when (case["keyEncoding"] as? String ?: "utf8") {
                "base64" -> Base64.getDecoder().decode(case["key"] as String)
                else -> (case["key"] as String).toByteArray(Charsets.UTF_8)
            }
            val mac = Mac.getInstance(CryptoCore.macName(id)!!)
            mac.init(SecretKeySpec(keyBytes, mac.algorithm))
            val out = mac.doFinal((case["data"] as String).toByteArray(Charsets.UTF_8))
            assertEquals(case["expect"], hex(out), case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun macVocabularyExcludesMd5() {
        val vocab = corpus("vectors.json")["macVocabulary"] as Map<String, Any?>
        assertEquals(vocab["allowed"] as List<Any?>, CryptoCore.MAC_DIGESTS)
        for (refused in vocab["refused"] as List<String>) {
            assertNull(CryptoCore.macName(refused), "$refused must not be a MAC algorithm")
        }
    }

    // ── uniformity.json ──────────────────────────────────────────────────────────────────

    @Test
    fun rejectionBoundAgreesWithCorpus() {
        for (case in rows(corpus("uniformity.json"), "bounds")) {
            val range = (case["range"] as Number).toLong()
            assertEquals((case["expect"] as Number).toLong(), CryptoCore.uniformBound(range), case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun drawsAtOrAboveTheBoundAreDiscarded() {
        for (case in rows(corpus("uniformity.json"), "picks")) {
            val name = case["name"] as? String
            val draws = (case["draws"] as List<Number>).map { it.toLong() }.toLongArray()
            val expect = case["expect"] as Map<String, Any?>
            val got = CryptoCore.uniformInt((case["min"] as Number).toLong(), (case["max"] as Number).toLong(), draws)
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(got is CryptoCore.IntResult.Refused, "$name: expected a refusal, got $got")
                assertEquals(expectedError, (got as CryptoCore.IntResult.Refused).code, name)
                continue
            }
            assertTrue(got is CryptoCore.IntResult.Value, "$name: expected a value, got $got")
            val value = got as CryptoCore.IntResult.Value
            assertEquals((expect["value"] as Number).toLong(), value.value, "$name: value")
            assertEquals((expect["consumed"] as Number).toInt(), value.consumed, "$name: draws consumed")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun sampledDistributionStaysInsideTheBound() {
        val spec = corpus("uniformity.json")["distribution"] as Map<String, Any?>
        val min = (spec["min"] as Number).toLong()
        val max = (spec["max"] as Number).toLong()
        val samples = (spec["samples"] as Number).toInt()
        val tolerance = (spec["tolerance"] as Number).toDouble()
        val range = (max - min + 1).toInt()
        val buckets = IntArray(range)
        val random = java.security.SecureRandom()
        val word = ByteArray(4)

        repeat(samples) {
            while (true) {
                random.nextBytes(word)
                var draw = 0L
                for (b in word) draw = (draw shl 8) or (b.toLong() and 0xff)
                val picked = CryptoCore.uniformInt(min, max, longArrayOf(draw))
                if (picked is CryptoCore.IntResult.Value) {
                    buckets[(picked.value - min).toInt()] += 1
                    break
                }
            }
        }

        val expected = samples.toDouble() / range
        for (i in 0 until range) {
            val drift = Math.abs(buckets[i] - expected) / expected
            assertTrue(drift <= tolerance, "bucket ${min + i} drifted $drift (count ${buckets[i]}, expected $expected)")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun uuidV4LayoutAgreesWithCorpus() {
        for (case in rows(corpus("uniformity.json"), "uuidV4")) {
            val bytes = (case["random"] as List<Number>).map { it.toInt().toByte() }.toByteArray()
            assertEquals(case["expect"], CryptoCore.uuidV4(bytes), case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun uuidV7LayoutAgreesWithCorpus() {
        for (case in rows(corpus("uniformity.json"), "uuidV7")) {
            val bytes = (case["random"] as List<Number>).map { it.toInt().toByte() }.toByteArray()
            assertEquals(case["expect"], CryptoCore.uuidV7((case["millis"] as Number).toLong(), bytes), case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun v7IdsSortInMintOrder() {
        val spec = corpus("uniformity.json")["monotonic"] as Map<String, Any?>
        val bytes = (spec["random"] as List<Number>).map { it.toInt().toByte() }.toByteArray()
        val minted = (spec["millis"] as List<Number>).map { CryptoCore.uuidV7(it.toLong(), bytes) }
        assertEquals(spec["expect"] as List<String>, minted)
        assertEquals(minted.sorted(), minted, "v7 ids must sort chronologically as plain strings")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun randomBytesIsBounded() {
        val limits = corpus("uniformity.json")["limits"] as Map<String, Any?>
        assertEquals((limits["maxRandomBytes"] as Number).toInt(), CryptoCore.MAX_RANDOM_BYTES)
    }
}
