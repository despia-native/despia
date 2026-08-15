//
//  DespiaAIVoice.swift - the speech product.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  A separate SPM product on purpose: the speech runtime is tens of megabytes,
//  and multi-product is how an SPM consumer gets the excludability a DSX app
//  gets from dropping a child module. An app that does not speak should not
//  pay for a synthesizer.
//
//  STATUS: the surface only. Synthesis has a hard ENTRY GATE that is not a
//  scheduling matter - the usual TTS build graph phonemizes through espeak-ng,
//  which is GPL-3.0, and copyleft can never ship inside a package whose whole
//  promise is unrestricted commercial use. A permissive phonemizer path has to
//  be proven by a transitive audit of the static-link graph before any
//  synthesis code lands here. Until then this product answers typed absence,
//  which is the honest answer and not a placeholder pretending otherwise.
//

import Foundation

#if canImport(DespiaAI)
import DespiaAI
#endif

public enum Voice {
    /// What this build can speak. Empty until the entry gate clears.
    public static var installedVoices: [String] { [] }

    /// Synthesis. Answers typed absence today; the shape is fixed now so the
    /// call site does not change when the gate clears.
    ///
    /// Audio comes back as REFERENCE blocks - a per-utterance URL the native
    /// side owns - because PCM never rides JSON.
    public static func synthesize(text: String, language: String) throws -> URL {
        throw DespiaAIError(
            code: "not_available",
            message: "speech synthesis is not in this build (see docs, W-VOICE entry gate)")
    }
}
