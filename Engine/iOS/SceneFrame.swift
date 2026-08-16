//
//  SceneFrame.swift - the DSX Scene on:frame schedule law, the Swift twin of the web
//  kernel's scene/frame.ts and Android's SceneFrame.kt (dsx-scene.md P4), corpus
//  OpenSource/Conformance/scene/frame.json: raw platform ticks (CADisplayLink /
//  requestAnimationFrame / withFrameNanos timestamps, milliseconds) → the emitted
//  { dt, elapsed, frame } payloads under the 60/s budget. A tick arriving less than
//  1000/60 ms after the last EMITTED tick is coalesced. The LIFECYCLE half of the law
//  (loop only while a handler is authored and the element is mounted) belongs to each
//  surface — this file is pure schedule math. The record-lane leg is
//  ConformanceHosts.SceneConformance (frame.json).
//

import Foundation

/// one emitted tick: seconds since the last emit / since the first tick / the counter
struct SceneFramePayload {
    let dt: Double
    let elapsed: Double
    let frame: Int
}

/// the stateful clock a live surface drives (one per mounted scene with on:frame)
final class SceneFrameClock {

    /// the budget law: at most 60 emitted ticks per second
    static let minIntervalMs = 1000.0 / 60.0

    private var start: Double?
    private var lastEmitted = 0.0
    private var frame = 0

    /// feed one raw platform tick (ms); the emitted payload, or nil when coalesced
    func tick(_ nowMs: Double) -> SceneFramePayload? {
        guard let startedAt = start else {
            start = nowMs
            lastEmitted = nowMs
            frame = 0
            return SceneFramePayload(dt: 0, elapsed: 0, frame: 0)
        }
        if nowMs - lastEmitted < Self.minIntervalMs { return nil }
        frame += 1
        let payload = SceneFramePayload(dt: (nowMs - lastEmitted) / 1000,
                                        elapsed: (nowMs - startedAt) / 1000, frame: frame)
        lastEmitted = nowMs
        return payload
    }

    /// the pure fold the corpus pins: a full tick list → every emitted payload
    static func schedule(_ ticksMs: [Double]) -> [SceneFramePayload] {
        let clock = SceneFrameClock()
        return ticksMs.compactMap { clock.tick($0) }
    }
}
