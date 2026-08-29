package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The telemetry conformance runner - executes OpenSource/Conformance/telemetry/{scrub,queue}.json
 * through THIS runtime's TelemetryScrub / TelemetryQueuePolicy / TelemetryQueue
 * (parity/F10-telemetry.md). The TS twin (@despia/kernel telemetry.ts,
 * telemetry-conformance.test.ts) and the Swift reference (TelemetryPolicy) run the SAME files, so
 * a redaction rule cannot fire on one renderer and not another - which would be a privacy incident
 * with a platform column - and a crash loop cannot send a count on one platform and ten thousand
 * events on the next.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class TelemetryConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/telemetry/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/telemetry/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(name: String, key: String): List<Map<String, Any?>> {
        val list = root(name)[key] as? List<Map<String, Any?>> ?: error("$name: no $key[]")
        assertTrue(list.isNotEmpty(), "$name $key corpus must not be empty")
        return list
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun placeholdersAndOrderAgreeWithCorpus() {
        val doc = root("scrub.json")
        val placeholders = doc["placeholders"] as? Map<String, Any?> ?: error("scrub.json: no placeholders")
        assertEquals(placeholders.mapValues { it.value as String }, TelemetryScrub.PLACEHOLDERS, "placeholders")
        val order = (doc["order"] as? List<Any?>)?.map { it as String } ?: error("scrub.json: no order")
        assertEquals(order, TelemetryScrub.ORDER, "rule order")
    }

    @Test
    fun redactionAgreesWithCorpus() {
        for (case in cases("scrub.json", "text")) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertEquals(case["expect"] as String, TelemetryScrub.text(case["input"] as String), name)
        }
    }

    @Test
    fun nonMatchesSurviveUntouched() {
        for (case in cases("scrub.json", "survives")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val input = case["input"] as String
            assertEquals(input, case["expect"] as String, "$name: a survivor's expect IS its input")
            assertEquals(input, TelemetryScrub.text(input), name)
        }
    }

    @Test
    fun scrubbingIsIdempotent() {
        for (key in listOf("text", "survives")) {
            for (case in cases("scrub.json", key)) {
                val expect = case["expect"] as String
                assertEquals(expect, TelemetryScrub.text(expect), case["name"] as? String ?: "<unnamed>")
            }
        }
    }

    @Test
    fun sensitiveKeysAgreeWithCorpus() {
        for (case in cases("scrub.json", "keys")) {
            val key = case["key"] as String
            assertEquals(case["sensitive"] as Boolean, TelemetryScrub.isSensitiveKey(key), key)
        }
    }

    @Test
    fun keyValueRedactionAgreesWithCorpus() {
        for (case in cases("scrub.json", "values")) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertEquals(
                case["expect"] as String,
                TelemetryScrub.value(case["key"] as String, case["value"] as String),
                name,
            )
        }
    }

    @Test
    fun argShapeCarriesTypesNeverValues() {
        val shape = TelemetryScrub.argShape(
            mapOf("amount" to 9.99, "token" to "sk_live_abc", "ok" to true, "items" to listOf(1, 2), "note" to null),
        )
        assertEquals(
            mapOf("amount" to "number", "items" to "array", "note" to "null", "ok" to "boolean", "token" to "string"),
            shape,
        )
        assertFalse(shape.toString().contains("sk_live_abc"), "no value may survive into the shape")
        assertEquals(emptyMap<String, String>(), TelemetryScrub.argShape(null))
    }

    @Test
    fun fingerprintFoldAgreesWithCorpus() {
        for (case in cases("queue.json", "fingerprint")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val actual = TelemetryQueuePolicy.fingerprint(
                case["source"] as String, case["code"] as String, case["message"] as? String,
            )
            assertEquals(case["expect"] as String, actual, name)
        }
        assertEquals("", TelemetryQueuePolicy.collapseMessage(null), "an absent message is an empty tail")
    }

    @Test
    fun samplingIsDeterministicAndAgreesWithCorpus() {
        for (case in cases("queue.json", "sampling")) {
            val fingerprint = case["fingerprint"] as String
            val rate = (case["rate"] as Number).toDouble()
            val expect = case["expect"] as Boolean
            assertEquals(expect, TelemetryQueuePolicy.sampled(fingerprint, rate), "$fingerprint @ $rate")
            assertEquals(expect, TelemetryQueuePolicy.sampled(fingerprint, rate), "and again, identically")
        }
    }

    @Test
    fun backoffScheduleAgreesWithCorpus() {
        for (case in cases("queue.json", "backoff")) {
            val attempt = (case["attempt"] as Number).toInt()
            assertEquals((case["expect"] as Number).toLong(), TelemetryQueuePolicy.backoffMs(attempt), "attempt $attempt")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun boundedDedupeQueueAgreesWithCorpus() {
        for (case in cases("queue.json", "queue")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val steps = case["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps")
            val expect = case["expect"] as? List<Map<String, Any?>> ?: error("$name: no expect")
            assertEquals(steps.size, expect.size, "$name: one expectation per step")

            val queue = TelemetryQueue(
                (case["capacity"] as Number).toInt(),
                (case["windowMs"] as Number).toLong(),
                (case["maxBatch"] as Number).toInt(),
            )
            steps.forEachIndexed { index, step ->
                val want = expect[index]
                val where = "$name: step $index"
                when {
                    step["offer"] != null -> {
                        val actual = queue.offer(step["offer"] as String, (step["at"] as Number).toLong())
                        assertEquals(want["outcome"] as String, actual.outcome.wire, "$where: outcome")
                        assertEquals((want["size"] as Number).toInt(), actual.size, "$where: size")
                        assertEquals((want["dropped"] as Number).toInt(), actual.dropped, "$where: dropped")
                        assertEquals((want["count"] as Number).toInt(), actual.count, "$where: count")
                    }
                    step["batch"] == true -> {
                        val wanted = (want["batch"] as List<Any?>).map { it as String }
                        assertEquals(wanted, queue.batch(), "$where: batch")
                    }
                    step["ack"] != null -> {
                        val size = queue.ack((step["ack"] as Number).toInt())
                        assertEquals((want["size"] as Number).toInt(), size, "$where: size after ack")
                    }
                    else -> error("$where names no operation")
                }
            }
        }
    }

    @Test
    fun revokedConsentClearsTheQueueWithoutCountingTheDrop() {
        val queue = TelemetryQueue(8, 1000L, 4)
        queue.offer("a", 0L)
        queue.offer("b", 10L)
        queue.clear()
        assertEquals(0, queue.size)
        assertEquals(0, queue.dropped, "consent revocation is not a delivery failure")
    }
}
