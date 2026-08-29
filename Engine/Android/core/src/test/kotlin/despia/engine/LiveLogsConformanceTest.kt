package despia.engine

import java.io.File
import kotlin.math.floor
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The live-logs conformance runner - executes OpenSource/Conformance/livelogs/{wire,report}.json
 * through THIS runtime's LiveLogs / AckState / LiveQueue / LiveRing (proposals/live-logs.md). The
 * TS twin (@despia/kernel livelogs.ts, livelogs-conformance.test.ts) and the Swift reference
 * (LiveLogs.swift) run the SAME files, so what leaves a device, how the relay paces it, and what
 * a `.dsxreport` seal verifies as cannot drift between renderers - a scrubber that fires on one
 * platform and not another is a privacy incident with a platform column, and two ends of one wire
 * that disagree about an idempotency key double every retried row.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class LiveLogsConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/livelogs/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/livelogs/$name not found")
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

    /** Map equality must not hinge on which integer type a number happened to parse or fold as -
     *  Int, Long and a whole Double all normalize to Long, on both sides of every comparison. */
    private fun normalized(value: Any?): Any? = when (value) {
        is Int -> value.toLong()
        is Double -> if (value == floor(value)) value.toLong() else value
        is Map<*, *> -> value.entries.associate { (key, entry) -> key as String to normalized(entry) }
        is List<*> -> value.map { normalized(it) }
        else -> value
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun wireConstantsAgreeWithCorpus() {
        val constants = root("wire.json")["constants"] as? Map<String, Any?> ?: error("wire.json: no constants")
        assertEquals((constants["wireVersion"] as Number).toInt(), LiveLogs.WIRE_VERSION, "wireVersion")
        assertEquals((constants["messageCap"] as Number).toInt(), LiveLogs.MESSAGE_CAP, "messageCap")
        assertEquals((constants["batchMaxRows"] as Number).toInt(), LiveLogs.BATCH_MAX_ROWS, "batchMaxRows")
        assertEquals((constants["queueCap"] as Number).toInt(), LiveLogs.QUEUE_CAP, "queueCap")
        assertEquals((constants["idleAckPause"] as Number).toInt(), LiveLogs.IDLE_ACK_PAUSE, "idleAckPause")
        assertEquals((constants["ringCap"] as Number).toInt(), LiveLogs.RING_CAP, "ringCap")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun rowFoldsAgreeWithCorpus() {
        for (case in cases("wire.json", "rows")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val entry = case["entry"] as? Map<String, Any?> ?: error("$name: no entry")
            val at = (case["at"] as Number).toLong()
            val row = when (case["kind"]) {
                "log" -> LiveLogs.rowFromLog(
                    entry["scheme"] as String, entry["level"] as String, entry["message"] as String, at,
                )
                "error" -> LiveLogs.rowFromError(
                    entry["scheme"] as String, entry["code"] as String, entry["message"] as String?,
                    entry["recoverable"] as Boolean, entry["origin"] as String, at,
                )
                "kernel" -> LiveLogs.rowFromKernel(entry["line"] as String, at)
                else -> error("$name: unknown kind ${case["kind"]}")
            }
            assertEquals(normalized(case["expect"]), normalized(row), name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun batchBodyAgreesWithCorpus() {
        for (case in cases("wire.json", "batch")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val body = LiveLogs.batchBody(
                case["sid"] as String,
                (case["n"] as Number).toLong(),
                case["rows"] as List<Map<String, Any?>>,
            )
            if (case["expect"] != null) assertEquals(normalized(case["expect"]), normalized(body), name)
            (case["canonical"] as? String)?.let {
                assertEquals(it, LiveLogs.canonical(body), "$name: canonical")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun ackFoldAgreesWithCorpus() {
        for (case in cases("wire.json", "ack")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val steps = case["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps")
            val expect = case["expect"] as? List<Map<String, Any?>> ?: error("$name: no expect")
            assertEquals(steps.size, expect.size, "$name: one expectation per step")

            var state = AckState.start()
            steps.forEachIndexed { index, step ->
                val where = "$name: step $index"
                val at = (step["at"] as Number).toLong()
                val ack = step["ack"] as? Map<String, Any?>
                state = when {
                    ack != null -> AckState.fold(
                        state,
                        ack["ok"] as Boolean,
                        (ack["viewers"] as Number).toInt(),
                        (ack["ttlMs"] as Number).toLong(),
                        at,
                    )
                    step["expire"] == true -> AckState.expire(state, at)
                    else -> error("$where names no operation")
                }
                for ((key, want) in expect[index]) when (key) {
                    "idle" -> assertEquals((want as Number).toInt(), state.idle, "$where: idle")
                    "paused" -> assertEquals(want as Boolean, state.paused, "$where: paused")
                    "stopped" -> assertEquals(want as Boolean, state.stopped, "$where: stopped")
                    "reason" -> assertEquals(want as String, state.reason, "$where: reason")
                    "deadline" -> assertEquals((want as Number).toLong(), state.deadline, "$where: deadline")
                    else -> error("$where: unknown expectation key $key")
                }
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun deviceQueueAgreesWithCorpus() {
        for (case in cases("wire.json", "queue")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val steps = case["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps")
            val expect = case["expect"] as? List<Map<String, Any?>> ?: error("$name: no expect")
            assertEquals(steps.size, expect.size, "$name: one expectation per step")

            val queue = LiveQueue<Any?>((case["cap"] as Number).toInt())
            steps.forEachIndexed { index, step ->
                val want = expect[index]
                val where = "$name: step $index"
                when {
                    step.containsKey("push") -> {
                        val result = queue.push(step["push"])
                        assertEquals((want["size"] as Number).toInt(), result.size, "$where: size")
                        assertEquals((want["dropped"] as Number).toInt(), result.dropped, "$where: dropped")
                    }
                    step["batch"] != null -> assertEquals(
                        want["batch"] as List<Any?>,
                        queue.batch((step["batch"] as Number).toInt()),
                        "$where: batch",
                    )
                    step["ack"] != null -> assertEquals(
                        (want["size"] as Number).toInt(),
                        queue.ack((step["ack"] as Number).toInt()),
                        "$where: size after ack",
                    )
                    else -> error("$where names no operation")
                }
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun relayRingAgreesWithCorpus() {
        for (case in cases("wire.json", "ring")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val steps = case["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps")
            val expect = case["expect"] as? List<Map<String, Any?>> ?: error("$name: no expect")
            assertEquals(steps.size, expect.size, "$name: one expectation per step")

            val ring = LiveRing<Any?>((case["cap"] as Number).toInt())
            steps.forEachIndexed { index, step ->
                val want = expect[index]
                val where = "$name: step $index"
                when {
                    step["appendBatch"] != null -> {
                        val append = step["appendBatch"] as Map<String, Any?>
                        val result = ring.appendBatch((append["n"] as Number).toLong(), append["rows"] as List<Any?>)
                        assertEquals(want["accepted"] as Boolean, result.accepted, "$where: accepted")
                        assertEquals((want["last"] as Number).toLong(), result.last, "$where: last")
                        assertEquals(result.last, ring.last, "$where: last is the ring's cursor")
                    }
                    step["read"] != null -> {
                        val read = step["read"] as Map<String, Any?>
                        val result = ring.read((read["after"] as Number).toLong(), (read["limit"] as Number).toInt())
                        assertEquals(
                            (want["seqs"] as List<Any?>).map { (it as Number).toLong() },
                            result.rows.map { it.seq },
                            "$where: seqs",
                        )
                        assertEquals(want["gap"] as Boolean, result.gap, "$where: gap")
                    }
                    else -> error("$where names no operation")
                }
            }
        }
    }

    @Test
    fun sha256AgreesWithTheStandardVectors() {
        for (case in cases("report.json", "sha256")) {
            val input = case["input"] as String
            assertEquals(case["expect"] as String, LiveLogs.sha256Hex(input), "sha256(${input.take(32)})")
        }
    }

    @Test
    fun canonicalBytesAgreeWithCorpus() {
        for (case in cases("report.json", "canonical")) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertEquals(case["expect"] as String, LiveLogs.canonical(case["value"]), name)
        }
    }

    @Test
    fun whatHasNoCanonicalFormIsRefused() {
        for (case in cases("report.json", "canonicalRejects")) {
            val name = case["name"] as? String ?: "<unnamed>"
            assertFailsWith<IllegalArgumentException>(name) { LiveLogs.canonical(case["value"]) }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theReferenceReportSealsToThePins() {
        for (case in cases("report.json", "seal")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val body = case["body"] as? Map<String, Any?> ?: error("$name: no body")
            val seal = LiveLogs.reportSeal(body)
            assertEquals(case["hash"] as String, seal.hash, "$name: hash")
            assertEquals(case["text"] as String, seal.text, "$name: text")
            val roundTrip = LiveLogs.reportVerdict(seal.text)
            assertEquals("genuine", roundTrip.verdict, "$name: a fresh seal must verify")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun verifierVerdictsAgreeWithCorpus() {
        for (case in cases("report.json", "verdict")) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val verdict = LiveLogs.reportVerdict(case["text"] as String)
            assertEquals(expect["verdict"] as String, verdict.verdict, "$name: verdict")
            assertEquals(expect["assertion"] as Boolean, verdict.assertion, "$name: assertion")
        }
    }
}
