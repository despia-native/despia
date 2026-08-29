//
//  RecorderCore.swift
//  DespiaScript
//
//  The shared `recorder` module core: the metering curve and the state machine, including
//  how an interruption moves through it. The law is the corpus,
//  OpenSource/Conformance/recorder/ (parity/F14-recorder.md). The twin of :core
//  RecorderCore.kt and of the web @despia-native/kernel recorder-core.ts.
//
//  WHY THESE TWO PARTS AND NOT THE RECORDING. Capturing audio is entirely platform work
//  (AVAudioRecorder, AVAudioSession) and belongs in the module facet. What cannot live
//  there is the METER CURVE, because this platform reports average power in dBFS and
//  Android reports a 16-bit linear amplitude, so without one shared fold the same voice
//  fills the bar on one platform and barely moves it on the other. And the STATE MACHINE,
//  because interruption handling is where every naive recorder loses a take.
//

import Foundation

public enum RecorderCore {

    /// 0.0 on the meter. Quieter than this is silence as far as a level meter is concerned.
    public static let floorDb: Double = -60

    /// The meter tick. Ten a second looks continuous and costs nothing per event.
    public static let meterIntervalMs = 100

    /// `interrupted` is a STATE rather than an error because a phone call is a normal thing
    /// that happens during a recording.
    public static let states: [String] = ["idle", "recording", "paused", "interrupted"]

    /// m4a (AAC) is the default and the only one both mobile platforms encode natively.
    public static let formats: [String] = ["m4a", "wav", "opus"]

    /// Fold an author's format spelling; nil is `unsupported_format`.
    public static func foldFormat(_ name: String?) -> String? {
        var key = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if key.hasPrefix(".") { key.removeFirst() }
        if key.isEmpty { return "m4a" }
        switch key {
        case "mp4", "aac": return "m4a"
        case "wave": return "wav"
        case "ogg": return "opus"
        default: return formats.contains(key) ? key : nil
        }
    }

    /// Four decimals, half AWAY FROM ZERO. Spelled out rather than left to each language's
    /// default, because the JS and JVM rounding rules disagree on negatives and dB values
    /// are negative.
    private static func round4(_ value: Double) -> Double {
        let scaled = (abs(value) * 10000).rounded() / 10000
        return value < 0 ? -scaled : scaled
    }

    /// dBFS to a 0...1 meter level, LINEAR IN DECIBELS. -60 dBFS or quieter is 0, 0 dBFS is
    /// 1, and -30 dBFS sits at exactly half, which is what makes a bar look like the
    /// loudness a person hears rather than like the raw amplitude.
    public static func meterLevel(_ db: Double) -> Double {
        guard db.isFinite else { return 0 }
        if db <= floorDb { return 0 }
        if db >= 0 { return 1 }
        return round4((db - floorDb) / (0 - floorDb))
    }

    /// A linear amplitude reading to dBFS. Android's `getMaxAmplitude()` reports a 16-bit
    /// peak (full scale 32767) and the web's AnalyserNode reports a normalised float (full
    /// scale 1); one conversion serves both.
    public static func amplitudeDb(_ amplitude: Double, fullScale: Double) -> Double {
        guard amplitude.isFinite, fullScale.isFinite, fullScale > 0 else { return floorDb }
        let ratio = abs(amplitude) / fullScale
        guard ratio > 0 else { return floorDb }
        let db = 20 * log10(ratio)
        if db <= floorDb { return floorDb }
        return db >= 0 ? 0 : round4(db)
    }

    /// The amplitude path in one step: amplitude in, meter level out.
    public static func meterFromAmplitude(_ amplitude: Double, fullScale: Double) -> Double {
        meterLevel(amplitudeDb(amplitude, fullScale: fullScale))
    }

    /// What a transition produced: the new state, an optional broadcast the module must
    /// emit, and an optional refusal code.
    public struct Transition {
        public let state: String
        public let emit: String?
        public let error: String?
        public init(_ state: String, emit: String? = nil, error: String? = nil) {
            self.state = state
            self.emit = emit
            self.error = error
        }
    }

    /// The state machine. One table, three renderers, and the interruption path is in it
    /// rather than in each platform's notification handler, which is where it usually rots.
    ///
    /// Events: start, pause, resume, stop, cancel, interrupt, endInterruption, maxDuration.
    ///
    /// The two rules worth stating out loud: a second `start` is `busy`, never a second
    /// file; and a returning session moves to `paused`, never straight back to `recording`,
    /// because coming back from a phone call to find the app quietly recording again is
    /// worse than a take that needs one tap.
    public static func transition(_ state: String, _ event: String) -> Transition {
        let from = states.contains(state) ? state : "idle"
        switch event {
        case "start":
            return from == "idle" ? Transition("recording") : Transition(from, error: "busy")
        case "pause":
            if from == "recording" || from == "paused" { return Transition("paused") }
            return Transition(from, error: "not_recording")
        case "resume":
            if from == "paused" || from == "interrupted" || from == "recording" { return Transition("recording") }
            return Transition(from, error: "not_recording")
        case "stop", "cancel":
            return from == "idle" ? Transition("idle", error: "not_recording") : Transition("idle")
        case "interrupt":
            return from == "recording" ? Transition("interrupted", emit: "interrupted") : Transition(from)
        case "endInterruption":
            return from == "interrupted" ? Transition("paused", emit: "resumable") : Transition(from)
        case "maxDuration":
            return from == "recording" ? Transition("idle") : Transition(from)
        default:
            return Transition(from, error: "not_recording")
        }
    }
}
