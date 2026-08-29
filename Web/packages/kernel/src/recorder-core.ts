//
//  recorder-core.ts - the shared `recorder` module core: the metering curve and the state
//  machine, including how an interruption moves through it. The law is the corpus,
//  OpenSource/Conformance/recorder/ (parity/F14-recorder.md); the Kotlin twin is :core
//  RecorderCore.kt and the Swift twin is Engine/iOS/RecorderCore.swift.
//
//  WHY THESE TWO PARTS AND NOT THE RECORDING. Capturing audio is entirely platform work
//  (AVAudioRecorder, MediaRecorder, the browser's MediaRecorder) and belongs in the facets.
//  What cannot live there is the METER CURVE, because iOS reports average power in dBFS and
//  Android reports a 16-bit linear amplitude, so without one shared fold the same voice
//  fills the bar on one platform and barely moves it on the other. And the STATE MACHINE,
//  because interruption handling is where every naive recorder loses a take: the transition
//  table below is the thing that has to be identical, not the audio code around it.
//

/** 0.0 on the meter. Quieter than this is silence as far as a level meter is concerned;
 *  -60 dBFS is roughly a quiet room and is the floor every DAW meter uses for the same
 *  reason. */
export const RECORDER_FLOOR_DB = -60;

/** The meter tick. Ten a second is fast enough to look continuous and slow enough that a
 *  bridged event per tick costs nothing. */
export const RECORDER_METER_INTERVAL_MS = 100;

/** The states a recorder can be in. `interrupted` is a state rather than an error because a
 *  phone call is a normal thing that happens during a recording. */
export const RECORDER_STATES: readonly string[] = ["idle", "recording", "paused", "interrupted"];

/** The formats. m4a (AAC) is the default and the only one both mobile platforms encode
 *  natively, which is why it is the default rather than the most open. */
export const RECORDER_FORMATS: readonly string[] = ["m4a", "wav", "opus"];

/** Fold an author's format spelling; null is `unsupported_format`. */
export function foldRecorderFormat(name: string | null | undefined): string | null {
  const key = String(name ?? "").trim().toLowerCase().replace(/^\./, "");
  if (key === "") return "m4a";
  if (key === "mp4" || key === "aac") return "m4a";
  if (key === "wave") return "wav";
  if (key === "ogg") return "opus";
  return RECORDER_FORMATS.includes(key) ? key : null;
}

/** Four decimals, half AWAY FROM ZERO. The rule is spelled out rather than left to each
 *  language's default because `Math.round` breaks ties toward positive infinity while
 *  Swift's `.rounded()` and Java's `Math.round` do not agree with it on negatives, and dB
 *  values are negative. */
function round4(value: number): number {
  const scaled = Math.round(Math.abs(value) * 10000) / 10000;
  return value < 0 ? -scaled : scaled;
}

/**
 * dBFS to a 0...1 meter level, LINEAR IN DECIBELS. -60 dBFS or quieter is 0, 0 dBFS is 1,
 * and -30 dBFS sits at exactly half, which is what makes a bar look like the loudness a
 * person hears rather than like the raw amplitude (a -20 dB signal is 0.1 in amplitude and
 * would barely register).
 *
 * Rounded to four decimals so three renderers computing the same input produce the same
 * bytes on the wire.
 */
export function recorderMeterLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db <= RECORDER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return round4((db - RECORDER_FLOOR_DB) / (0 - RECORDER_FLOOR_DB));
}

/**
 * A linear amplitude reading to dBFS. Android's `MediaRecorder.getMaxAmplitude()` reports a
 * 16-bit peak (full scale 32767) and the web's AnalyserNode reports a normalised float
 * (full scale 1); one conversion serves both, so the corpus can pin one curve for three
 * renderers.
 */
export function recorderAmplitudeDb(amplitude: number, fullScale: number): number {
  if (!Number.isFinite(amplitude) || !Number.isFinite(fullScale) || fullScale <= 0) return RECORDER_FLOOR_DB;
  const ratio = Math.abs(amplitude) / fullScale;
  if (ratio <= 0) return RECORDER_FLOOR_DB;
  const db = 20 * Math.log10(ratio);
  if (db <= RECORDER_FLOOR_DB) return RECORDER_FLOOR_DB;
  return db >= 0 ? 0 : round4(db);
}

/** The Android and web path in one step: amplitude in, meter level out. */
export function recorderMeterFromAmplitude(amplitude: number, fullScale: number): number {
  return recorderMeterLevel(recorderAmplitudeDb(amplitude, fullScale));
}

/** What a transition produced: the new state, an optional broadcast the module must emit,
 *  and an optional refusal code. Exactly one of `emit` and `error` may be present. */
export interface RecorderTransition {
  readonly state: string;
  readonly emit?: string;
  readonly error?: string;
}

/**
 * The state machine. One table, three renderers, and the interruption path is in it rather
 * than in each platform's notification handler, which is where it usually rots.
 *
 * Events: start, pause, resume, stop, cancel, interrupt, endInterruption, maxDuration.
 *
 * The two rules worth stating out loud:
 *  - a second `start` is `busy`, never a second file. One recording at a time is a
 *    deliberate limit, not an oversight.
 *  - `interrupt` moves a live recording to `interrupted` and emits, and the session
 *    returning moves it to `paused` and emits `resumable`. It never auto-resumes: coming
 *    back from a phone call to find the app quietly recording again is worse than a take
 *    that needs one tap.
 */
export function recorderTransition(state: string, event: string): RecorderTransition {
  const from = RECORDER_STATES.includes(state) ? state : "idle";
  switch (event) {
    case "start":
      return from === "idle" ? { state: "recording" } : { state: from, error: "busy" };
    case "pause":
      if (from === "recording") return { state: "paused" };
      if (from === "paused") return { state: "paused" };
      return { state: from, error: "not_recording" };
    case "resume":
      if (from === "paused" || from === "interrupted") return { state: "recording" };
      if (from === "recording") return { state: "recording" };
      return { state: from, error: "not_recording" };
    case "stop":
    case "cancel":
      return from === "idle" ? { state: "idle", error: "not_recording" } : { state: "idle" };
    case "interrupt":
      if (from === "recording") return { state: "interrupted", emit: "interrupted" };
      return { state: from };
    case "endInterruption":
      if (from === "interrupted") return { state: "paused", emit: "resumable" };
      return { state: from };
    case "maxDuration":
      return from === "recording" ? { state: "idle" } : { state: from };
    default:
      return { state: from, error: "not_recording" };
  }
}
