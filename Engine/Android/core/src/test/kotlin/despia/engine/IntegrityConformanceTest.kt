package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED ATTESTATION corpus (OpenSource/Conformance/integrity/attestation.json) through
 * THIS runtime's Integrity core — the Kotlin leg of Core/Integrity (F17.4). The TS reference
 * (packages/kernel/test/integrity-conformance.test.ts) and the Swift twin
 * (Engine/iOS/Integrity.swift) read the SAME file, so one backend contract serves both
 * platforms.
 */
class IntegrityConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/integrity")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/integrity not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "attestation.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("attestation.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "integrity/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun limitsVocabularyAndAdvisory() {
        val d = doc()
        val limits = d["limits"] as Map<String, Any?>
        assertEquals((limits["minChallengeBytes"] as Number).toInt(), Integrity.MIN_CHALLENGE_BYTES)
        assertEquals((limits["maxChallengeBytes"] as Number).toInt(), Integrity.MAX_CHALLENGE_BYTES)
        assertEquals((limits["maxKeyRefChars"] as Number).toInt(), Integrity.MAX_KEY_REF_CHARS)
        val vocab = d["vocabulary"] as Map<String, Any?>
        assertEquals(strings(vocab["providers"]), Integrity.PROVIDERS)
        assertEquals(strings(vocab["formats"]), Integrity.FORMATS)
        assertEquals(str(d["advisory"]), Integrity.ADVISORY)
    }

    @TestFactory
    fun provider(): List<DynamicTest> = rows("provider", 6).map { c ->
        DynamicTest.dynamicTest("integrity/provider — ${name(c)}") {
            assertEquals(str(c["expect"]), Integrity.providerFor(c["platform"]))
        }
    }

    private fun <T> check(got: Result<T>, c: Map<String, Any?>, assertValue: (T) -> Unit) {
        assertEquals(c["ok"] == true, got.isSuccess, "ok")
        if (c["ok"] == true) {
            assertValue(got.getOrThrow())
        } else {
            assertEquals(str(c["error"]), Integrity.code(got.exceptionOrNull()!!), "error")
        }
    }

    @TestFactory
    fun format(): List<DynamicTest> = rows("format", 6).map { c ->
        DynamicTest.dynamicTest("integrity/format — ${name(c)}") {
            check(Integrity.format(c["provider"], c["kind"]), c) { assertEquals(str(c["expect"]), it) }
        }
    }

    @TestFactory
    fun challenge(): List<DynamicTest> = rows("challenge", 5).map { c ->
        DynamicTest.dynamicTest("integrity/challenge — ${name(c)}") {
            check(Integrity.normalizeChallenge(c["raw"]), c) { assertEquals(str(c["expect"]), it) }
        }
    }

    @TestFactory
    fun keyRef(): List<DynamicTest> = rows("keyRef", 4).map { c ->
        DynamicTest.dynamicTest("integrity/keyRef — ${name(c)}") {
            check(Integrity.normalizeKeyRef(c["raw"]), c) { assertEquals(str(c["expect"]), it) }
        }
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun envelope(): List<DynamicTest> = rows("envelope", 4).map { c ->
        DynamicTest.dynamicTest("integrity/envelope — ${name(c)}") {
            val got = Integrity.envelope(
                c["provider"], c["kind"], c["token"], str(c["challenge"]), str(c["keyRef"]),
            )
            check(got, c) { value ->
                val want = c["expect"] as Map<String, Any?>
                assertEquals(str(want["provider"]), value.provider, "provider")
                assertEquals(str(want["format"]), value.format, "format")
                assertEquals(str(want["token"]), value.token, "token")
                assertEquals(str(want["challenge"]), value.challenge, "challenge")
                assertEquals(str(want["keyRef"]), value.keyRef, "keyRef")
                assertEquals(str(want["advisory"]), value.advisory, "advisory")
            }
        }
    }
}
