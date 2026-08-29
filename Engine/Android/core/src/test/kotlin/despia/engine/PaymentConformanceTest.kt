package despia.engine

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The SHARED WALLET-PAYMENT corpus (OpenSource/Conformance/pay/request.json) through THIS
 * runtime's Payment core — the Kotlin leg of Core/Pay (F17.2). The TS reference
 * (packages/kernel/test/payment-conformance.test.ts) and the Swift twin
 * (Engine/iOS/Payment.swift) read the SAME file, so a cart cannot add up to three different
 * totals on three renderers.
 */
class PaymentConformanceTest {

    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/pay")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/pay not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun doc(): Map<String, Any?> =
        json(File(corpusDir(), "request.json").readText()).foundationValue as? Map<String, Any?>
            ?: error("request.json: not a JSON object")

    @Suppress("UNCHECKED_CAST")
    private fun rows(key: String, minimum: Int): List<Map<String, Any?>> {
        val list = doc()[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.size >= minimum, "pay/$key is suspiciously small (${list.size})")
        return list
    }

    private fun str(v: Any?): String = v as? String ?: ""
    private fun name(c: Map<String, Any?>): String = str(c["name"]).ifEmpty { "?" }

    @Suppress("UNCHECKED_CAST")
    private fun strings(v: Any?): List<String> = (v as? List<Any?> ?: emptyList()).map { str(it) }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun vocabularyAndCeiling() {
        val d = doc()
        val limits = d["limits"] as Map<String, Any?>
        assertEquals((limits["maxMinor"] as Number).toLong(), Payment.MAX_MINOR, "maxMinor")
        val vocab = d["vocabulary"] as Map<String, Any?>
        assertEquals(strings(vocab["networks"]), Payment.NETWORKS, "networks")
        assertEquals(strings(vocab["capabilities"]), Payment.CAPABILITIES, "capabilities")
        assertEquals(strings(vocab["fields"]), Payment.FIELDS, "fields")
        assertEquals(strings(vocab["statuses"]), Payment.STATUSES, "statuses")
    }

    @TestFactory
    fun exponent(): List<DynamicTest> = rows("exponent", 8).map { c ->
        DynamicTest.dynamicTest("pay/exponent — ${name(c)}") {
            assertEquals((c["expect"] as Number).toInt(), Payment.currencyExponent(c["code"]))
        }
    }

    @TestFactory
    fun amount(): List<DynamicTest> = rows("amount", 20).map { c ->
        DynamicTest.dynamicTest("pay/amount — ${name(c)}") {
            val got = Payment.parseAmountMinor(c["raw"], (c["exponent"] as Number).toInt())
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals((c["minor"] as Number).toLong(), got.getOrThrow(), "minor")
            } else {
                assertEquals(str(c["error"]), Payment.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @TestFactory
    fun format(): List<DynamicTest> = rows("format", 6).map { c ->
        DynamicTest.dynamicTest("pay/format — ${name(c)}") {
            assertEquals(
                str(c["expect"]),
                Payment.formatAmountMinor((c["minor"] as Number).toLong(), (c["exponent"] as Number).toInt()),
            )
        }
    }

    private fun listCases(key: String, minimum: Int, fold: (Any?) -> Result<List<String>>): List<DynamicTest> =
        rows(key, minimum).map { c ->
            DynamicTest.dynamicTest("pay/$key — ${name(c)}") {
                val got = fold(c["raw"])
                assertEquals(c["ok"] == true, got.isSuccess, "ok")
                if (c["ok"] == true) {
                    assertEquals(strings(c["expect"]), got.getOrThrow(), "expect")
                } else {
                    assertEquals(str(c["error"]), Payment.code(got.exceptionOrNull()!!), "error")
                }
            }
        }

    @TestFactory
    fun networks(): List<DynamicTest> = listCases("networks", 5) { Payment.foldNetworks(it) }

    @TestFactory
    fun capabilities(): List<DynamicTest> = listCases("capabilities", 4) { Payment.foldCapabilities(it) }

    @TestFactory
    fun fields(): List<DynamicTest> = listCases("fields", 3) { Payment.foldFields(it) }

    @TestFactory
    fun status(): List<DynamicTest> = rows("status", 6).map { c ->
        DynamicTest.dynamicTest("pay/status — ${name(c)}") {
            val got = Payment.foldStatus(c["raw"])
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                assertEquals(str(c["expect"]), got.getOrThrow(), "expect")
            } else {
                assertEquals(str(c["error"]), Payment.code(got.exceptionOrNull()!!), "error")
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun lineOf(v: Any?): Payment.Line {
        val m = v as Map<String, Any?>
        return Payment.Line(str(m["label"]), (m["amountMinor"] as Number).toLong(), str(m["kind"]))
    }

    @TestFactory
    @Suppress("UNCHECKED_CAST")
    fun request(): List<DynamicTest> = rows("request", 14).map { c ->
        DynamicTest.dynamicTest("pay/request — ${name(c)}") {
            val got = Payment.normalizeRequest(c["raw"] as Map<String, Any?>)
            assertEquals(c["ok"] == true, got.isSuccess, "ok")
            if (c["ok"] == true) {
                val want = c["plan"] as Map<String, Any?>
                val plan = got.getOrThrow()
                assertEquals(str(want["merchant"]), plan.merchant, "merchant")
                assertEquals(str(want["currency"]), plan.currency, "currency")
                assertEquals((want["exponent"] as Number).toInt(), plan.exponent, "exponent")
                assertEquals((want["items"] as List<Any?>).map { lineOf(it) }, plan.items, "items")
                assertEquals(lineOf(want["total"]), plan.total, "total")
                assertEquals(strings(want["networks"]), plan.networks, "networks")
                assertEquals(strings(want["capabilities"]), plan.capabilities, "capabilities")
                assertEquals(strings(want["shipping"]), plan.shipping, "shipping")
                assertEquals(strings(want["contact"]), plan.contact, "contact")
            } else {
                assertEquals(str(c["error"]), Payment.code(got.exceptionOrNull()!!), "error")
            }
        }
    }
}
