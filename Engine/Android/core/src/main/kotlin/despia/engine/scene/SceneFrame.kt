//
//  SceneFrame.kt - the DSX Scene on:frame schedule law, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/frame.ts (dsx-scene.md P4), corpus
//  OpenSource/Conformance/scene/frame.json: raw platform ticks (withFrameNanos /
//  Choreographer timestamps converted to milliseconds) → the emitted
//  { dt, elapsed, frame } payloads under the 60/s budget. A tick arriving less than
//  1000/60 ms after the last EMITTED tick is coalesced. The LIFECYCLE half of the law
//  (loop only while a handler is authored and the element is mounted) belongs to each
//  surface — this file is pure schedule math.
//

package despia.engine.scene

class SceneFramePayload(val dt: Double, val elapsed: Double, val frame: Int)

/** the budget law: at most 60 emitted ticks per second */
const val SCENE_FRAME_MIN_INTERVAL_MS: Double = 1000.0 / 60.0

/** the stateful clock a live surface drives (one per mounted scene with on:frame) */
class SceneFrameClock {
    private var start: Double? = null
    private var lastEmitted = 0.0
    private var frame = 0

    /** feed one raw platform tick (ms); the emitted payload, or null when coalesced */
    fun tick(nowMs: Double): SceneFramePayload? {
        val startedAt = start
        if (startedAt == null) {
            start = nowMs
            lastEmitted = nowMs
            frame = 0
            return SceneFramePayload(0.0, 0.0, 0)
        }
        if (nowMs - lastEmitted < SCENE_FRAME_MIN_INTERVAL_MS) return null
        frame += 1
        val payload = SceneFramePayload(
            (nowMs - lastEmitted) / 1000.0,
            (nowMs - startedAt) / 1000.0,
            frame,
        )
        lastEmitted = nowMs
        return payload
    }
}

/** the pure fold the corpus pins: a full tick list → every emitted payload */
fun sceneFrameSchedule(ticksMs: List<Double>): List<SceneFramePayload> {
    val clock = SceneFrameClock()
    return ticksMs.mapNotNull { clock.tick(it) }
}
