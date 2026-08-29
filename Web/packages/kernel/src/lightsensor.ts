//
//  lightsensor.ts — the SHARED PURE CORE behind Core/LightSensor (F17.9): what an ambient-light
//  reading MEANS, decided once and run identically by all three renderers.
//
//  WHY A SENSOR NEEDS A CORE AT ALL. A raw lux number is almost never what an app wants: it wants
//  "is this a dark room?" so it can dim a reader, or "is this direct sun?" so it can raise the
//  screen. Left to each caller, that threshold is invented three times per app and differs across
//  platforms, so the BUCKETS are pinned here with real illuminance references.
//
//  THE HYSTERESIS IS THE OTHER HALF, and it is not an optimisation. Android's TYPE_LIGHT fires
//  on every hardware sample and the values jitter by several lux with no change in the room; an
//  unfiltered stream wakes the JS bridge dozens of times a second to say nothing. The emit rule
//  is therefore part of the contract rather than a per-facet detail: same stream shape, same
//  battery cost, same test.
//
//  Pinned by OpenSource/Conformance/light/ambient.json.
//

/** Faster than this and the values are hardware jitter, not light. */
export const LIGHT_MIN_INTERVAL_MS = 50;
export const LIGHT_DEFAULT_INTERVAL_MS = 1000;
/** Slower than a minute and the reading is stale enough to be misleading. */
export const LIGHT_MAX_INTERVAL_MS = 60000;

/** Below this absolute change, the difference is sensor noise on every device tested. */
export const LIGHT_MIN_ABSOLUTE_CHANGE = 1;
/** Above the noise floor, a reading must move by a tenth to be worth waking the bridge for. */
export const LIGHT_MIN_RELATIVE_CHANGE = 0.1;

/**
 * The categories, with the illuminance references they come from. These are the numbers an app
 * actually branches on, so they are pinned rather than left to each caller's guess.
 *
 *   dark      < 10      a room with the lights off; a phone screen is the brightest thing in it
 *   dim       < 50      candlelight, a corridor at night, a cinema
 *   indoor    < 1000    ordinary room and office lighting
 *   overcast  < 10000   daylight through a window, or an overcast sky
 *   daylight  < 30000   full daylight in shade
 *   sunlight  >= 30000  direct sun, where a screen needs its brightest setting to be readable
 */
export const LIGHT_CATEGORIES: readonly string[] = [
  "dark", "dim", "indoor", "overcast", "daylight", "sunlight",
];

export const LIGHT_THRESHOLDS: readonly number[] = [10, 50, 1000, 10000, 30000];

/** Which category a lux reading falls in. A negative or non-finite reading is `dark`: a sensor
 *  that reports nonsense is reporting no light, and inventing a separate "unknown" category
 *  would make every caller handle a case the hardware cannot distinguish anyway. */
export function luxCategory(lux: unknown): string {
  const n = typeof lux === "number" ? lux : Number(lux);
  if (!Number.isFinite(n) || n < 0) return LIGHT_CATEGORIES[0]!;
  for (let i = 0; i < LIGHT_THRESHOLDS.length; i += 1) {
    if (n < LIGHT_THRESHOLDS[i]!) return LIGHT_CATEGORIES[i]!;
  }
  return LIGHT_CATEGORIES[LIGHT_CATEGORIES.length - 1]!;
}

/** Clamp an author-supplied interval into the band the sensor is honest at. Clamped rather than
 *  refused: a caller asking for 1 ms wants "as fast as you can", not an error. */
export function clampLightInterval(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return LIGHT_DEFAULT_INTERVAL_MS;
  if (n < LIGHT_MIN_INTERVAL_MS) return LIGHT_MIN_INTERVAL_MS;
  if (n > LIGHT_MAX_INTERVAL_MS) return LIGHT_MAX_INTERVAL_MS;
  return Math.round(n);
}

/**
 * Should this reading be delivered?
 *
 * Yes when there is nothing to compare against, when the CATEGORY changed (which is what an app
 * branches on, so it must never be filtered away), or when the value moved by more than the
 * noise floor AND by more than a tenth of where it was. The relative test is what makes the
 * filter work across four orders of magnitude: two lux of movement is everything in a dark room
 * and nothing in direct sun.
 */
export function shouldEmitLux(previous: number | null | undefined, next: unknown): boolean {
  const value = typeof next === "number" ? next : Number(next);
  if (!Number.isFinite(value)) return false;
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return true;
  if (luxCategory(previous) !== luxCategory(value)) return true;
  const delta = Math.abs(value - previous);
  if (delta < LIGHT_MIN_ABSOLUTE_CHANGE) return false;
  return delta >= Math.abs(previous) * LIGHT_MIN_RELATIVE_CHANGE;
}

export interface LightSample {
  readonly lux: number;
  readonly category: string;
}

/** The shape every renderer emits, so markup reads one thing. A negative hardware reading is
 *  clamped to zero rather than passed through: there is no such thing as negative light, and a
 *  caller charting the value should not have to guard against it. */
export function lightSample(lux: unknown): LightSample {
  const n = typeof lux === "number" ? lux : Number(lux);
  const value = Number.isFinite(n) && n > 0 ? n : 0;
  return { lux: value, category: luxCategory(value) };
}
