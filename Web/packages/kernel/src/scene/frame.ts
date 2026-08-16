//
//  scene/frame.ts - the DSX Scene on:frame schedule law (dsx-scene.md P4), corpus
//  OpenSource/Conformance/scene/frame.json: raw platform ticks (requestAnimationFrame /
//  withFrameNanos / CADisplayLink timestamps, milliseconds) → the emitted
//  { dt, elapsed, frame } payloads under the 60/s budget. A tick arriving less than
//  1000/60 ms after the last EMITTED tick is coalesced. The LIFECYCLE half of the law
//  (loop only while a handler is authored and the element is mounted) belongs to each
//  surface — this module is pure schedule math. Kotlin twin: SceneFrame.kt.
//

export type SceneFramePayload = { dt: number; elapsed: number; frame: number };

/** the budget law: at most 60 emitted ticks per second */
export const SCENE_FRAME_MIN_INTERVAL_MS = 1000 / 60;

export type SceneFrameClock = {
  /** feed one raw platform tick (ms); the emitted payload, or null when coalesced */
  tick(nowMs: number): SceneFramePayload | null;
};

/** the stateful clock a live surface drives (one per mounted scene with on:frame) */
export function createSceneFrameClock(): SceneFrameClock {
  let start: number | null = null;
  let lastEmitted = 0;
  let frame = 0;
  return {
    tick(nowMs) {
      if (start === null) {
        start = nowMs;
        lastEmitted = nowMs;
        frame = 0;
        return { dt: 0, elapsed: 0, frame: 0 };
      }
      if (nowMs - lastEmitted < SCENE_FRAME_MIN_INTERVAL_MS) return null;
      const payload: SceneFramePayload = {
        dt: (nowMs - lastEmitted) / 1000,
        elapsed: (nowMs - start) / 1000,
        frame: frame + 1,
      };
      frame += 1;
      lastEmitted = nowMs;
      return payload;
    },
  };
}

/** the pure fold the corpus pins: a full tick list → every emitted payload */
export function sceneFrameSchedule(ticksMs: readonly number[]): SceneFramePayload[] {
  const clock = createSceneFrameClock();
  const out: SceneFramePayload[] = [];
  for (const tick of ticksMs) {
    const payload = clock.tick(tick);
    if (payload !== null) out.push(payload);
  }
  return out;
}
