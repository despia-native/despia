package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED PASSKEY corpus (OpenSource/Conformance/passkeys/ceremony.json) through THIS
 * runtime's Passkeys core — the Kotlin leg of Core/Passkeys (F17.3). The TS reference
 * (packages/kernel/test/passkeys-conformance.test.ts) and the Swift twin
 * (Engine/iOS/Passkeys.swift) read the SAME file, so a challenge cannot be padded on one
 * renderer and unpadded on another.
 */
class PasskeysConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/passkeys")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/passkeys not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "ceremony.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("ceremony.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "passkeys/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Suppress("UNCHECKED_CAST")
    private fun ints(v: Any?): List<Int> = (v as? List<Any?> ?: emptyList()).map { (it as Number).toInt() }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun limitsAndVocabulary() {
        val d = doc()
        val limits = d["limits"] as Map<String, Any?>
        assertEquals((limits["minChallengeBytes"] as Number).toInt(), Passkeys.MIN_CHALLENGE_BYTES)
        assertEquals((limits["maxChallengeBytes"] as Number).toInt(), Passkeys.MAX_CHALLENGE_BYTES)
        assertEquals((limits["maxUserIdBytes"] as Number).toInt(), Passkeys.MAX_USER_ID_BYTES)
        assertEquals((limits["minTimeoutMs"] as Number).toInt(), Passkeys.MIN_TIMEOUT_MS)
        assertEquals((limits["defaultTimeoutMs"] as Number).toInt(), Passkeys.DEFAULT_TIMEOUT_MS)
        assertEquals((limits["maxTimeoutMs"] as Number).toInt(), Passkeys.MAX_TIMEOUT_MS)
        val vocab = d["vocabulary"] as Map<String, Any?>
        assertEquals(strings(vocab["attestations"]), Passkeys.ATTESTATIONS)
        assertEquals(strings(vocab["mediations"]), Passkeys.MEDIATIONS)
        assertEquals(strings(vocab["verifications"]), Passkeys.VERIFICATIONS)
        assertEquals(strings(vocab["residentKeys"]), Passkeys.RESIDENT_KEYS)
    }

    @TestFactory
    fun encode(): List<DynamicTest> = rows("encode", 8).map { c ->
        DynamicTest.dynamicTest("passkeys/encode — ${name(c)}") {
            val bytes = ints(c["bytes"])
            assertEquals(str(c["expect"]), Passkeys.base64UrlEncode(bytes))
            // Every encode case is also a round trip: the codec's only real contract.
            assertEquals(bytes, Passkeys.base64UrlDecode(str(c["expect"])))
        }
    }

    @TestFactory
    fun decode(): List<DynamicTest> = rows("decode", 8).map { c ->
        DynamicTest.dynamicTest("passkeys/decode — ${name(c)}") {
            val got = Passkeys.base64UrlDecode(c["text"])
            if (c["ok"] == true) assertEquals(ints(c["bytes"]), got) else assertNull(got)
        }
    }

    private fun <T> check(got: Result<T>, c: Map<String, Any?>, assertValue: (T) -> Unit) {
        assertEquals(c["ok"] == true, got.isSuccess, "ok")
        if (c["ok"] == true) {
            assertValue(got.getOrThrow())
        } else {
            assertEquals(str(c["error"]), Passkeys.code(got.exceptionOrNull()!!), "error")
        }
    }

    @TestFactory
    fun rpId(): List<DynamicTest> = rows("rpId", 12).map { c ->
        DynamicTest.dynamicTest("passkeys/rpId — ${name(c)}") {
            check(Passkeys.normalizeRpId(c["raw"]), c) { assertEquals(str(c["expect"]), it) }
        }
    }

    @TestFactory
    fun challenge(): List<DynamicTest> = rows("challenge", 6).map { c ->
        DynamicTest.dynamicTest("passkeys/challenge — ${name(c)}") {
            check(Passkeys.normalizeChallenge(c["raw"]), c) { assertEquals(str(c["expect"]), it) }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun userOf(v: Any?): Passkeys.User {
        val m = v as Map<String, Any?>
        return Passkeys.User(str(m["id"]), str(m["name"]), str(m["displayName"]))
    }

    @TestFactory
    fun user(): List<DynamicTest> = rows("user", 8).map { c ->
        DynamicTest.dynamicTest("passkeys/user — ${name(c)}") {
            check(Passkeys.normalizeUser(c["raw"]), c) { assertEquals(userOf(c["expect"]), it) }
        }
    }

    @TestFactory
    fun words(): List<DynamicTest> = rows("words", 10).map { c ->
        DynamicTest.dynamicTest("passkeys/words — ${name(c)}") {
            val got = when (str(c["kind"])) {
                "attestation" -> Passkeys.foldAttestation(c["raw"])
                "mediation" -> Passkeys.foldMediation(c["raw"])
                "verification" -> Passkeys.foldUserVerification(c["raw"])
                "residentKey" -> Passkeys.foldResidentKey(c["raw"])
                else -> error("no fold for ${str(c["kind"])}")
            }
            check(got, c) { assertEquals(str(c["expect"]), it) }
        }
    }

    @TestFactory
    fun timeout(): List<DynamicTest> = rows("timeout", 5).map { c ->
        DynamicTest.dynamicTest("passkeys/timeout — ${name(c)}") {
            assertEquals((c["expect"] as Number).toInt(), Passkeys.clampTimeout(c["raw"]))
        }
    }

    @TestFactory
    fun credentials(): List<DynamicTest> = rows("credentials", 6).map { c ->
        DynamicTest.dynamicTest("passkeys/credentials — ${name(c)}") {
            check(Passkeys.normalizeCredentialIds(c["raw"]), c) { assertEquals(strings(c["expect"]), it) }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun create(): List<DynamicTest> = rows("create", 5).map { c ->
        DynamicTest.dynamicTest("passkeys/create — ${name(c)}") {
            check(Passkeys.normalizeCreateOptions(c["raw"] as Map<String, Any?>), c) { got ->
                val want = c["expect"] as Map<String, Any?>
                assertEquals(str(want["rpId"]), got.rpId, "rpId")
                assertEquals(userOf(want["user"]), got.user, "user")
                assertEquals(str(want["challenge"]), got.challenge, "challenge")
                assertEquals(str(want["attestation"]), got.attestation, "attestation")
                assertEquals(str(want["userVerification"]), got.userVerification, "userVerification")
                assertEquals(str(want["residentKey"]), got.residentKey, "residentKey")
                assertEquals(strings(want["excludeCredentials"]), got.excludeCredentials, "exclude")
                assertEquals((want["timeoutMs"] as Number).toInt(), got.timeoutMs, "timeoutMs")
            }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun get(): List<DynamicTest> = rows("get", 4).map { c ->
        DynamicTest.dynamicTest("passkeys/get — ${name(c)}") {
            check(Passkeys.normalizeGetOptions(c["raw"] as Map<String, Any?>), c) { got ->
                val want = c["expect"] as Map<String, Any?>
                assertEquals(str(want["rpId"]), got.rpId, "rpId")
                assertEquals(str(want["challenge"]), got.challenge, "challenge")
                assertEquals(str(want["mediation"]), got.mediation, "mediation")
                assertEquals(str(want["userVerification"]), got.userVerification, "userVerification")
                assertEquals(strings(want["allowCredentials"]), got.allowCredentials, "allow")
                assertEquals((want["timeoutMs"] as Number).toInt(), got.timeoutMs, "timeoutMs")
            }
        }
    }
}
