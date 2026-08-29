//
//  LightSensor.kt — the Kotlin twin of Engine/iOS/LightSensor.swift and the web kernel's
//  lightsensor.ts: the SHARED PURE CORE behind Core/LightSensor (F17.9).
//
//  WHY A SENSOR NEEDS A CORE AT ALL. A raw lux number is almost never what an app wants: it
//  wants "is this a dark room?" so it can dim a reader, or "is this direct sun?" so it can raise
//  the screen. Left to each caller that threshold is invented three times per app, so the
//  BUCKETS are pinned here with real illuminance references.
//
//  THE HYSTERESIS IS THE OTHER HALF, and it is not an optimisation. Android's TYPE_LIGHT fires
//  on every hardware sample and the values jitter by several lux with no change in the room; an
//  unfiltered stream wakes the JS bridge dozens of times a second to say nothing. The emit rule
//  is therefore part of the contract rather than a per-facet detail: same stream shape, same
//  battery cost, same test.
//
//  Pure JVM — no Android imports. Pinned by OpenSource/Conformance/light/ambient.json.
//
package despia.engine

object LightSensor {

    /** Faster than this and the values are hardware jitter, not light. */
    const val MIN_INTERVAL_MS = 50
    const val DEFAULT_INTERVAL_MS = 1000

    /** Slower than a minute and the reading is stale enough to be misleading. */
    const val MAX_INTERVAL_MS = 60000

    /** Below this absolute change, the difference is sensor noise on every device tested. */
    const val MIN_ABSOLUTE_CHANGE = 1.0

    /** Above the noise floor, a reading must move by a tenth to be worth waking the bridge. */
    const val MIN_RELATIVE_CHANGE = 0.1

    /**
     * The categories, with the illuminance references they come from.
     *
     *   dark      < 10      a room with the lights off
     *   dim       < 50      candlelight, a corridor at night, a cinema
     *   indoor    < 1000    ordinary room and office lighting
     *   overcast  < 10000   daylight through a window, or an overcast sky
     *   daylight  < 30000   full daylight in shade
     *   sunlight  >= 30000  direct sun, where a screen needs its brightest setting
     */
    val CATEGORIES: List<String> = listOf("dark", "dim", "indoor", "overcast", "daylight", "sunlight")

    val THRESHOLDS: List<Double> = listOf(10.0, 50.0, 1000.0, 10000.0, 30000.0)

    data class Sample(val lux: Double, val category: String)

    private fun asDouble(raw: Any?): Double = when (raw) {
        is Number -> raw.toDouble()
        is String -> raw.trim().toDoubleOrNull() ?: Double.NaN
        else -> Double.NaN
    }

    /** Which category a lux reading falls in. A negative or non-finite reading is `dark`: a
     *  sensor reporting nonsense is reporting no light, and a separate "unknown" category would
     *  make every caller handle a case the hardware cannot distinguish anyway. */
    fun category(lux: Any?): String {
        val n = asDouble(lux)
        if (!n.isFinite() || n < 0.0) return CATEGORIES[0]
        for (i in THRESHOLDS.indices) {
            if (n < THRESHOLDS[i]) return CATEGORIES[i]
        }
        return CATEGORIES[CATEGORIES.size - 1]
    }

    /** Clamp an author-supplied interval into the band the sensor is honest at. Clamped rather
     *  than refused: a caller asking for 1 ms wants "as fast as you can", not an error. */
    fun clampInterval(raw: Any?): Int {
        val n = asDouble(raw)
        if (!n.isFinite() || n <= 0.0) return DEFAULT_INTERVAL_MS
        if (n < MIN_INTERVAL_MS) return MIN_INTERVAL_MS
        if (n > MAX_INTERVAL_MS) return MAX_INTERVAL_MS
        return Math.round(n).toInt()
    }

    /**
     * Should this reading be delivered? Yes when there is nothing to compare against, when the
     * CATEGORY changed (which is what an app branches on, so it must never be filtered away), or
     * when the value moved by more than the noise floor AND by more than a tenth of where it
     * was. The relative test is what makes the filter work across four orders of magnitude: two
     * lux is everything in a dark room and nothing in direct sun.
     */
    fun shouldEmit(previous: Double?, next: Any?): Boolean {
        val value = asDouble(next)
        if (!value.isFinite()) return false
        if (previous == null || !previous.isFinite()) return true
        if (category(previous) != category(value)) return true
        val delta = Math.abs(value - previous)
        if (delta < MIN_ABSOLUTE_CHANGE) return false
        return delta >= Math.abs(previous) * MIN_RELATIVE_CHANGE
    }

    /** The shape every renderer emits, so markup reads one thing. A negative hardware reading is
     *  clamped to zero rather than passed through: there is no such thing as negative light. */
    fun sample(lux: Any?): Sample {
        val n = asDouble(lux)
        val value = if (n.isFinite() && n > 0.0) n else 0.0
        return Sample(value, category(value))
    }
}
