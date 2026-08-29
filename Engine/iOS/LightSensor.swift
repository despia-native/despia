//
//  LightSensor.swift — the SHARED PURE CORE behind Core/LightSensor (F17.9), and the reference
//  renderer's leg of it. Twin of :core LightSensor.kt and the web kernel's lightsensor.ts.
//
//  WHY THIS EXISTS ON A PLATFORM WITH NO AMBIENT-LIGHT API. iOS has no public ambient-light
//  sensor, so the module resolves the typed absence there — but the CATEGORIES are still the
//  contract a cross-platform app branches on, and a developer reading `category === "dark"` in
//  markup needs that word to mean the same lux band wherever the reading came from. Pinning the
//  bands here also means a future Apple API, or a reading arriving from a paired Watch, folds
//  into the same vocabulary rather than inventing a second one.
//
//  Pure Foundation. Pinned by OpenSource/Conformance/light/ambient.json.
//
import Foundation

public enum LightSensorCore {

    /// Faster than this and the values are hardware jitter, not light.
    public static let minIntervalMs = 50
    public static let defaultIntervalMs = 1000

    /// Slower than a minute and the reading is stale enough to be misleading.
    public static let maxIntervalMs = 60000

    /// Below this absolute change, the difference is sensor noise on every device tested.
    public static let minAbsoluteChange = 1.0

    /// Above the noise floor, a reading must move by a tenth to be worth waking the bridge.
    public static let minRelativeChange = 0.1

    /// The categories, with the illuminance references they come from.
    ///
    ///   dark      < 10      a room with the lights off
    ///   dim       < 50      candlelight, a corridor at night, a cinema
    ///   indoor    < 1000    ordinary room and office lighting
    ///   overcast  < 10000   daylight through a window, or an overcast sky
    ///   daylight  < 30000   full daylight in shade
    ///   sunlight  >= 30000  direct sun, where a screen needs its brightest setting
    public static let categories = ["dark", "dim", "indoor", "overcast", "daylight", "sunlight"]

    public static let thresholds: [Double] = [10, 50, 1000, 10000, 30000]

    public struct Sample: Equatable {
        public let lux: Double
        public let category: String
    }

    private static func asDouble(_ raw: Any?) -> Double {
        switch raw {
        case let v as Double: return v
        case let v as Int: return Double(v)
        case let v as NSNumber: return v.doubleValue
        case let v as String: return Double(v.trimmingCharacters(in: .whitespaces)) ?? Double.nan
        default: return Double.nan
        }
    }

    /// Which category a lux reading falls in. A negative or non-finite reading is `dark`: a
    /// sensor reporting nonsense is reporting no light, and a separate "unknown" category would
    /// make every caller handle a case the hardware cannot distinguish anyway.
    public static func category(_ lux: Any?) -> String {
        let n = asDouble(lux)
        if !n.isFinite || n < 0 { return categories[0] }
        for i in thresholds.indices where n < thresholds[i] { return categories[i] }
        return categories[categories.count - 1]
    }

    /// Clamp an author-supplied interval into the band the sensor is honest at. Clamped rather
    /// than refused: a caller asking for 1 ms wants "as fast as you can", not an error.
    public static func clampInterval(_ raw: Any?) -> Int {
        let n = asDouble(raw)
        if !n.isFinite || n <= 0 { return defaultIntervalMs }
        if n < Double(minIntervalMs) { return minIntervalMs }
        if n > Double(maxIntervalMs) { return maxIntervalMs }
        return Int(n.rounded())
    }

    /// Should this reading be delivered? Yes when there is nothing to compare against, when the
    /// CATEGORY changed (which is what an app branches on, so it must never be filtered away),
    /// or when the value moved by more than the noise floor AND by more than a tenth of where it
    /// was. The relative test is what makes the filter work across four orders of magnitude.
    public static func shouldEmit(previous: Double?, next: Any?) -> Bool {
        let value = asDouble(next)
        if !value.isFinite { return false }
        guard let previous, previous.isFinite else { return true }
        if category(previous) != category(value) { return true }
        let delta = abs(value - previous)
        if delta < minAbsoluteChange { return false }
        return delta >= abs(previous) * minRelativeChange
    }

    /// The shape every renderer emits, so markup reads one thing. A negative hardware reading is
    /// clamped to zero rather than passed through: there is no such thing as negative light.
    public static func sample(_ lux: Any?) -> Sample {
        let n = asDouble(lux)
        let value = (n.isFinite && n > 0) ? n : 0
        return Sample(lux: value, category: category(value))
    }
}
