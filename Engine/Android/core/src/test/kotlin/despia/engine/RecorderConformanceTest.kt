package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The recorder conformance runner - executes
 * OpenSource/Conformance/recorder/{lifecycle,interruption}.json through THIS runtime
 * (parity/F14-recorder.md). The TS twin is packages/kernel/test/recorder-conformance.test.ts
 * and the Swift reference is Engine/iOS/RecorderCore.swift.
 *
 * The two things that have to be identical across renderers are the metering curve (iOS
 * reports dBFS, this platform reports a 16-bit amplitude, and without one fold the same
 * voice fills the bar on one platform and not the other) and the state machine, including
 * the interruption path where every naive recorder loses a take.
 *
 * Missing corpus = loud failure.
 */
class RecorderConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/recorder/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/recorder/$name not found")
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

    @Test
    @Suppress("UNCHECKED_CAST")
    fun curveConstantsAgreeWithCorpus() {
        val doc = corpus("lifecycle.json")
        val curve = doc["curve"] as Map<String, Any?>
        assertEquals((curve["floorDb"] as Number).toDouble(), RecorderCore.FLOOR_DB)
        assertEquals((curve["meterIntervalMs"] as Number).toInt(), RecorderCore.METER_INTERVAL_MS)
        assertEquals(doc["states"] as List<String>, RecorderCore.STATES)
    }

    @Test
    fun decibelsFoldToThePinnedMeterLevel() {
        for (case in rows(corpus("lifecycle.json"), "meter")) {
            assertEquals((case["expect"] as Number).toDouble(),
                RecorderCore.meterLevel((case["db"] as Number).toDouble()), case["name"] as? String)
        }
    }

    @Test
    fun linearAmplitudeFoldsThroughTheSameCurve() {
        for (case in rows(corpus("lifecycle.json"), "amplitude")) {
            val amplitude = (case["amplitude"] as Number).toDouble()
            val fullScale = (case["fullScale"] as Number).toDouble()
            assertEquals((case["expectDb"] as Number).toDouble(),
                RecorderCore.amplitudeDb(amplitude, fullScale), "${case["name"]}: dB")
            assertEquals((case["expectLevel"] as Number).toDouble(),
                RecorderCore.meterFromAmplitude(amplitude, fullScale), "${case["name"]}: level")
        }
    }

    @Test
    fun formatFoldAgreesWithCorpus() {
        for (case in rows(corpus("lifecycle.json"), "formats")) {
            val expect = case["expect"] as? String
            val got = RecorderCore.foldFormat(case["input"] as? String)
            if (expect == null) assertNull(got, case["name"] as? String) else assertEquals(expect, got, case["name"] as? String)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun stateMachineAgreesWithCorpus() {
        for (case in rows(corpus("lifecycle.json"), "transitions")) {
            val expect = case["expect"] as Map<String, Any?>
            val got = RecorderCore.transition(case["from"] as String, case["event"] as String)
            assertEquals(expect["state"], got.state, "${case["name"]}: state")
            assertEquals(expect["error"] as? String, got.error, "${case["name"]}: error")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun everyInterruptionSequenceWalksThePinnedStates() {
        for (case in rows(corpus("interruption.json"), "sequences")) {
            val steps = case["steps"] as List<String>
            val states = case["expect"] as List<String>
            val emits = case["emits"] as List<String?>
            assertEquals(steps.size, states.size, "${case["name"]}: one expected state per step")
            assertEquals(steps.size, emits.size, "${case["name"]}: one expected emission per step")
            var state = "idle"
            for (i in steps.indices) {
                val got = RecorderCore.transition(state, steps[i])
                state = got.state
                assertEquals(states[i], state, "${case["name"]} step ${i + 1} (${steps[i]}): state")
                assertEquals(emits[i], got.emit, "${case["name"]} step ${i + 1} (${steps[i]}): emission")
            }
        }
    }

    @Test
    fun theTakeIsNeverLostToAnInterruption() {
        var state = RecorderCore.transition("idle", "start").state
        state = RecorderCore.transition(state, "interrupt").state
        assertEquals("interrupted", state)
        val stopped = RecorderCore.transition(state, "stop")
        assertEquals("idle", stopped.state)
        assertNull(stopped.error, "stopping an interrupted take must not be refused")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun declaredBroadcastsAreTheOnesTheMachineEmits() {
        val declared = (corpus("interruption.json")["broadcasts"] as Map<String, Any?>)
            .keys.filterNot { it.startsWith("_") }.sorted()
        val emitted = sortedSetOf<String>()
        for (from in RecorderCore.STATES) {
            for (event in listOf("start", "pause", "resume", "stop", "cancel",
                                 "interrupt", "endInterruption", "maxDuration")) {
                RecorderCore.transition(from, event).emit?.let { emitted.add(it) }
            }
        }
        assertEquals(declared, emitted.toList())
    }
}
