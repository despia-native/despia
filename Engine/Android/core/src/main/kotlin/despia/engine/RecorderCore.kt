//
//  RecorderCore.kt - the shared `recorder` module core (:core, pure JVM): the metering
//  curve and the state machine, including how an interruption moves through it. The law is
//  the corpus, OpenSource/Conformance/recorder/ (parity/F14-recorder.md). The twin of the
//  web @despia-native/kernel recorder-core.ts and of Swift RecorderCore.
//
//  WHY THESE TWO PARTS AND NOT THE RECORDING. Capturing audio is entirely platform work
//  (MediaRecorder, AudioRecord, MediaCodec) and belongs in the module facet. What cannot
//  live there is the METER CURVE, because iOS reports average power in dBFS and Android
//  reports a 16-bit linear amplitude, so without one shared fold the same voice fills the
//  bar on one platform and barely moves it on the other. And the STATE MACHINE, because
//  interruption handling is where every naive recorder loses a take.
//
package despia.engine

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.roundToLong

object RecorderCore {

    /** 0.0 on the meter. Quieter than this is silence as far as a level meter is concerned. */
    const val FLOOR_DB: Double = -60.0

    /** The meter tick. Ten a second looks continuous and costs nothing per event. */
    const val METER_INTERVAL_MS: Int = 100

    /** `interrupted` is a STATE rather than an error because a phone call is a normal thing
     *  that happens during a recording. */
    val STATES: List<String> = listOf("idle", "recording", "paused", "interrupted")

    /** m4a (AAC) is the default and the only one both mobile platforms encode natively. */
    val FORMATS: List<String> = listOf("m4a", "wav", "opus")

    /** Fold an author's format spelling; null is `unsupported_format`. */
    fun foldFormat(name: String?): String? {
        val key = (name ?: "").trim().lowercase().removePrefix(".")
        if (key.isEmpty()) return "m4a"
        return when (key) {
            "mp4", "aac" -> "m4a"
            "wave" -> "wav"
            "ogg" -> "opus"
            else -> if (FORMATS.contains(key)) key else null
        }
    }

    /** Four decimals, half AWAY FROM ZERO. Spelled out rather than left to each language's
     *  default, because the JS and JVM rounding rules disagree on negatives and dB values
     *  are negative. */
    private fun round4(value: Double): Double {
        val scaled = (abs(value) * 10000).roundToLong() / 10000.0
        return if (value < 0) -scaled else scaled
    }

    /**
     * dBFS to a 0..1 meter level, LINEAR IN DECIBELS. -60 dBFS or quieter is 0, 0 dBFS is 1,
     * and -30 dBFS sits at exactly half, which is what makes a bar look like the loudness a
     * person hears rather than like the raw amplitude.
     */
    fun meterLevel(db: Double): Double {
        if (db.isNaN() || db.isInfinite()) return 0.0
        if (db <= FLOOR_DB) return 0.0
        if (db >= 0.0) return 1.0
        return round4((db - FLOOR_DB) / (0.0 - FLOOR_DB))
    }

    /**
     * A linear amplitude reading to dBFS. `MediaRecorder.getMaxAmplitude()` reports a 16-bit
     * peak (full scale 32767) and the web's AnalyserNode reports a normalised float (full
     * scale 1); one conversion serves both.
     */
    fun amplitudeDb(amplitude: Double, fullScale: Double): Double {
        if (amplitude.isNaN() || fullScale.isNaN() || fullScale <= 0.0) return FLOOR_DB
        val ratio = abs(amplitude) / fullScale
        if (ratio <= 0.0) return FLOOR_DB
        val db = 20.0 * log10(ratio)
        if (db <= FLOOR_DB) return FLOOR_DB
        return if (db >= 0.0) 0.0 else round4(db)
    }

    /** The Android path in one step: amplitude in, meter level out. */
    fun meterFromAmplitude(amplitude: Double, fullScale: Double): Double =
        meterLevel(amplitudeDb(amplitude, fullScale))

    /** What a transition produced: the new state, an optional broadcast the module must
     *  emit, and an optional refusal code. */
    data class Transition(val state: String, val emit: String? = null, val error: String? = null)

    /**
     * The state machine. One table, three renderers, and the interruption path is in it
     * rather than in each platform's focus-change callback, which is where it usually rots.
     *
     * Events: start, pause, resume, stop, cancel, interrupt, endInterruption, maxDuration.
     *
     * The two rules worth stating out loud: a second `start` is `busy`, never a second file;
     * and a returning session moves to `paused`, never straight back to `recording`, because
     * coming back from a phone call to find the app quietly recording again is worse than a
     * take that needs one tap.
     */
    fun transition(state: String, event: String): Transition {
        val from = if (STATES.contains(state)) state else "idle"
        return when (event) {
            "start" -> if (from == "idle") Transition("recording") else Transition(from, error = "busy")
            "pause" -> when (from) {
                "recording", "paused" -> Transition("paused")
                else -> Transition(from, error = "not_recording")
            }
            "resume" -> when (from) {
                "paused", "interrupted", "recording" -> Transition("recording")
                else -> Transition(from, error = "not_recording")
            }
            "stop", "cancel" ->
                if (from == "idle") Transition("idle", error = "not_recording") else Transition("idle")
            "interrupt" ->
                if (from == "recording") Transition("interrupted", emit = "interrupted") else Transition(from)
            "endInterruption" ->
                if (from == "interrupted") Transition("paused", emit = "resumable") else Transition(from)
            "maxDuration" -> if (from == "recording") Transition("idle") else Transition(from)
            else -> Transition(from, error = "not_recording")
        }
    }
}
