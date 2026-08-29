//
//  ControlsCore.swift
//  DespiaScript
//
//  THE U07 PURE CORE — the gradient resolver (linear · radial · angular · mesh, with the angle
//  convention pinned), the `<gauge>` value-to-arc solver, the `<colorpicker>` hex/swatch/name
//  folds, and the `<masked>` mode fold.
//
//  The law is the corpus: OpenSource/Conformance/controls/{gradients,gauge,colorpicker,masked}
//  .json (parity/U07-controls.md). The twin of :core ControlsCore.kt and of the web
//  @despia/kernel controls-core.ts; this leg runs in the record lane through
//  ControlsConformance.swift.
//
//  Everything platform-shaped lives OUTSIDE this file — LinearGradient/RadialGradient/
//  AngularGradient/MeshGradient, the system ColorPicker sheet, `.mask()` — because keeping the
//  DECISION separate from the PLUMBING is what lets one corpus judge three renderers.
//
//  THE ANGLE CONVENTION, stated once: 0deg points UP and increases CLOCKWISE. That is CSS's
//  convention; SwiftUI's UnitPoint model is unrelated and Compose's Offset model is a third
//  thing. Pinning one convention here and converting at each boundary is the only way
//  `gradientAngle="135deg"` looks the same on three renderers.
//

import Foundation

public enum ControlsCore {

    // ─────────────────────────────────────────────────────────────────────────────
    // GRADIENTS
    // ─────────────────────────────────────────────────────────────────────────────

    public static let gradientTypes: [String] = ["linear", "radial", "angular", "mesh"]

    /// The three legacy direction tokens, kept as EXACT aliases so no shipped app moves a pixel.
    public static let gradientDirectionAliases: [String: Double] = [
        "vertical": 180, "horizontal": 90, "diagonal": 135,
    ]

    /// Neither `gradientAngle` nor `gradientDir` declared = today's behaviour: top to bottom.
    public static let gradientAngleDefault: Double = 180

    public struct UnitPointValue: Equatable {
        public let x: Double
        public let y: Double
    }

    public struct MeshPoint: Equatable {
        public let x: Double
        public let y: Double
        public let color: String
    }

    public struct MeshGrid: Equatable {
        public let columns: Int
        public let rows: Int
        public let points: [MeshPoint]
    }

    public struct MeshLayer: Equatable {
        public let center: UnitPointValue
        public let radius: Double
        public let color: String
    }

    /// The DECLARED mesh degradation: a base fill plus one radial per control point, in
    /// row-major paint order. Pinned, so "mesh falls back" is a specification, not an accident.
    public struct MeshFallback: Equatable {
        public let base: String
        public let layers: [MeshLayer]
    }

    public struct Gradient: Equatable {
        public let type: String
        public let colors: [String]
        public let stops: [Double]
        public let angle: Double
        public let start: UnitPointValue
        public let end: UnitPointValue
        public let center: UnitPointValue
        public let radius: Double
        /// Fewer than two colours is not a gradient; the caller paints nothing rather than a
        /// flat band.
        public let valid: Bool
        public let mesh: MeshGrid?
        public let meshFallback: MeshFallback?
    }

    /// Six decimals: enough for sub-pixel placement, few enough that three languages agree.
    private static func round6(_ value: Double) -> Double {
        (value * 1e6 + 0.5).rounded(.down) / 1e6
    }

    private static func clamp01(_ value: Double) -> Double {
        value < 0 ? 0 : (value > 1 ? 1 : value)
    }

    private static func finiteDouble(_ text: String) -> Double? {
        guard let value = Double(text), value.isFinite else { return nil }
        return value
    }

    /// `135deg` · `135` · `0.25turn` · `1.57rad` · `150grad` · a legacy direction token.
    public static func parseGradientAngle(_ input: String?) -> Double? {
        guard let input else { return nil }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return nil }
        if let alias = gradientDirectionAliases[text] { return alias }
        var value: Double?
        if text.hasSuffix("grad") {
            value = finiteDouble(String(text.dropLast(4))).map { $0 * 0.9 }
        } else if text.hasSuffix("turn") {
            value = finiteDouble(String(text.dropLast(4))).map { $0 * 360 }
        } else if text.hasSuffix("deg") {
            value = finiteDouble(String(text.dropLast(3)))
        } else if text.hasSuffix("rad") {
            value = finiteDouble(String(text.dropLast(3))).map { $0 * 180 / Double.pi }
        } else {
            value = finiteDouble(text)
        }
        guard let resolved = value, resolved.isFinite else { return nil }
        return resolved.truncatingRemainder(dividingBy: 360).advanced(by: 360)
            .truncatingRemainder(dividingBy: 360)
    }

    /// The gradient axis as unit points, from the pinned angle convention.
    public static func gradientUnitPoints(_ angle: Double) -> (start: UnitPointValue, end: UnitPointValue) {
        let radians = angle * Double.pi / 180
        let sine = sin(radians)
        let cosine = cos(radians)
        return (
            UnitPointValue(x: round6(0.5 - sine / 2), y: round6(0.5 + cosine / 2)),
            UnitPointValue(x: round6(0.5 + sine / 2), y: round6(0.5 - cosine / 2))
        )
    }

    private static func unitScalar(_ token: String) -> Double? {
        let text = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        let value = text.hasSuffix("%")
            ? finiteDouble(String(text.dropLast())).map { $0 / 100 }
            : finiteDouble(text)
        guard let resolved = value else { return nil }
        return clamp01(resolved)
    }

    /// `gradientCenter="0.25 0.75"` / `"25% 75%"`. A single value means both axes.
    public static func parseUnitPoint(_ input: String?, _ fallback: UnitPointValue) -> UnitPointValue {
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ",", with: " ")
        let parts = text.split(separator: " ").map(String.init).filter { !$0.isEmpty }
        if parts.count >= 2 {
            if let x = unitScalar(parts[0]), let y = unitScalar(parts[1]) {
                return UnitPointValue(x: round6(x), y: round6(y))
            }
        } else if parts.count == 1 {
            if let only = unitScalar(parts[0]) {
                return UnitPointValue(x: round6(only), y: round6(only))
            }
        }
        return fallback
    }

    /// `gradientRadius` as a fraction of the box's larger side. Default 0.5, capped at 4.
    public static func parseGradientRadius(_ input: String?) -> Double {
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return 0.5 }
        let value = text.hasSuffix("%")
            ? finiteDouble(String(text.dropLast())).map { $0 / 100 }
            : finiteDouble(text)
        guard let resolved = value, resolved > 0 else { return 0.5 }
        return round6(min(4, resolved))
    }

    /// `gradient="c1|c2|…"` — the shorthand every existing app already writes.
    /// The colour bound. A gradient is a handful of stops; a list in the thousands is a bug or
    /// an attack, and every renderer turns each colour into shader geometry. The desktop lane
    /// already bounded this on its own, which made the bound a property of one renderer instead
    /// of the grammar - so it lives here now, where all four read it.
    ///
    /// TRUNCATION rather than rejection: a bounded gradient still paints, and past sixty-four
    /// stops no display can show the difference. Refusing to paint would turn a cosmetic excess
    /// into a blank element.
    public static let maxGradientColors = 64

    public static func parseGradientColors(_ input: String?) -> [String] {
        guard let input else { return [] }
        let parts = input.components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.count > maxGradientColors ? Array(parts.prefix(maxGradientColors)) : parts
    }

    /// `gradientStops` — positions matching the colour list. A COUNT MISMATCH FALLS BACK TO EVEN
    /// SPACING rather than guessing which colour lost its stop: a gradient that silently
    /// reorders itself when the author adds a colour is worse than one that ignores the
    /// attribute. Values are clamped to 0…1 and forced monotonically non-decreasing.
    public static func parseGradientStops(_ input: String?, _ count: Int) -> [Double] {
        if count == 0 { return [] }
        if count == 1 { return [0] }
        let even = (0..<count).map { round6(Double($0) / Double(count - 1)) }
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return even }
        let raw = text.replacingOccurrences(of: "|", with: ",")
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if raw.count != count { return even }
        var stops: [Double] = []
        var previous: Double = 0
        for token in raw {
            let value = token.hasSuffix("%")
                ? finiteDouble(String(token.dropLast())).map { $0 / 100 }
                : finiteDouble(token)
            guard let resolved = value else { return even }
            let monotonic = max(previous, clamp01(resolved))
            previous = monotonic
            stops.append(round6(monotonic))
        }
        return stops
    }

    /// `gradientPoints` — the mesh control grid. Rows are `;`-separated, points `,`-separated,
    /// and each point is `x y color`. The grid must be rectangular and at least 2x2; anything
    /// else returns nil and the caller degrades to a linear gradient rather than painting a
    /// blank.
    public static func parseMeshPoints(_ input: String?) -> MeshGrid? {
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        var grid: [[MeshPoint]] = []
        for rowText in text.components(separatedBy: ";") {
            if rowText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            var row: [MeshPoint] = []
            let cells = rowText.components(separatedBy: ",")
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            for cell in cells {
                let parts = cell.trimmingCharacters(in: .whitespacesAndNewlines)
                    .split(separator: " ").map(String.init).filter { !$0.isEmpty }
                if parts.count < 3 { return nil }
                guard let x = finiteDouble(parts[0]), let y = finiteDouble(parts[1]) else { return nil }
                let color = parts[2...].joined(separator: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                row.append(MeshPoint(x: round6(clamp01(x)), y: round6(clamp01(y)), color: color))
            }
            grid.append(row)
        }
        if grid.count < 2 { return nil }
        let columns = grid[0].count
        if columns < 2 { return nil }
        for row in grid where row.count != columns { return nil }
        return MeshGrid(columns: columns, rows: grid.count, points: grid.flatMap { $0 })
    }

    /// The declared mesh degradation, used by every target that cannot draw a real mesh
    /// (Android, the web, and iOS below 18): one radial per control point over a base fill,
    /// painted row-major. The base is the control point nearest the centre, chosen by index so
    /// it is deterministic.
    public static func meshFallbackLayers(_ mesh: MeshGrid) -> MeshFallback {
        let spread = max(1.0 / Double(mesh.columns - 1), 1.0 / Double(mesh.rows - 1))
        let radius = round6(0.75 * spread)
        let baseIndex = (mesh.rows / 2) * mesh.columns + (mesh.columns / 2)
        return MeshFallback(
            base: mesh.points[baseIndex].color,
            layers: mesh.points.map {
                MeshLayer(center: UnitPointValue(x: $0.x, y: $0.y), radius: radius, color: $0.color)
            }
        )
    }

    /// Fold every gradient attribute into the one descriptor each renderer paints from.
    public static func resolveGradient(
        gradient: String? = nil,
        gradientType: String? = nil,
        gradientStops: String? = nil,
        gradientAngle: String? = nil,
        gradientDir: String? = nil,
        gradientCenter: String? = nil,
        gradientRadius: String? = nil,
        gradientPoints: String? = nil
    ) -> Gradient {
        var colors = parseGradientColors(gradient)
        let typeWord = (gradientType ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var type = gradientTypes.contains(typeWord) ? typeWord : "linear"
        let angle = parseGradientAngle(gradientAngle)
            ?? parseGradientAngle(gradientDir)
            ?? gradientAngleDefault

        let mesh = type == "mesh" ? parseMeshPoints(gradientPoints) : nil
        if type == "mesh" && mesh == nil { type = "linear" }
        if type == "mesh", let grid = mesh { colors = grid.points.map { $0.color } }

        let stops = parseGradientStops(gradientStops, colors.count)
        let axis = gradientUnitPoints(angle)
        return Gradient(
            type: type,
            colors: colors,
            stops: stops,
            angle: round6(angle),
            start: axis.start,
            end: axis.end,
            center: parseUnitPoint(gradientCenter, UnitPointValue(x: 0.5, y: 0.5)),
            radius: parseGradientRadius(gradientRadius),
            valid: colors.count >= 2,
            mesh: mesh,
            meshFallback: mesh.map { meshFallbackLayers($0) }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // <gauge>
    // ─────────────────────────────────────────────────────────────────────────────

    public struct GaugeMetrics: Equatable {
        public let arcStart: Double
        public let arcSweep: Double
        public let thickness: Double
        public let showsCurrentLabel: Bool
        public let showsBoundLabels: Bool
    }

    /// The circular arc starts at 225 and sweeps 270, leaving the 90-degree gap at the bottom
    /// that makes a gauge read as a gauge and not as a progress ring.
    public static let gaugeStyles: [String: GaugeMetrics] = [
        "circular": GaugeMetrics(arcStart: 225, arcSweep: 270, thickness: 6,
                                 showsCurrentLabel: true, showsBoundLabels: true),
        "accessoryCircular": GaugeMetrics(arcStart: 225, arcSweep: 270, thickness: 4,
                                          showsCurrentLabel: true, showsBoundLabels: false),
        "linear": GaugeMetrics(arcStart: 0, arcSweep: 0, thickness: 6,
                               showsCurrentLabel: true, showsBoundLabels: true),
        "accessoryLinear": GaugeMetrics(arcStart: 0, arcSweep: 0, thickness: 4,
                                        showsCurrentLabel: false, showsBoundLabels: false),
    ]

    public struct GaugeAccessibility: Equatable {
        public let role: String
        public let min: Double
        public let max: Double
        public let now: Double
        public let percent: Int
        public let valueText: String
    }

    public struct Gauge: Equatable {
        public let style: String
        public let fraction: Double
        public let clampedValue: Double
        public let arcStart: Double
        public let arcSweep: Double
        public let valueAngle: Double
        public let thickness: Double
        public let showsCurrentLabel: Bool
        public let showsBoundLabels: Bool
        public let a11y: GaugeAccessibility
    }

    private static func finite(_ value: Double?, _ fallback: Double) -> Double {
        guard let value, value.isFinite else { return fallback }
        return value
    }

    /// How the raw value reads aloud when no `currentLabel` is given. Integers lose the `.0`.
    private static func defaultValueText(_ value: Double) -> String {
        if value.isFinite && value == value.rounded(.towardZero) {
            return String(Int(value))
        }
        return String(value)
    }

    /// `<gauge>` — value to arc, plus the meter semantics that are contract, not follow-up. An
    /// inverted or empty range resolves to fraction 0 rather than NaN, because a gauge that
    /// renders nothing is recoverable and one that renders garbage is not.
    public static func resolveGauge(
        value: Double?, min lo: Double? = 0, max hi: Double? = 1,
        style: String? = nil, currentLabel: String? = nil
    ) -> Gauge {
        let word = (style ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedStyle = gaugeStyles[word] != nil ? word : "circular"
        let metrics = gaugeStyles[resolvedStyle]!
        let v = finite(value, 0)
        let low = finite(lo, 0)
        let high = finite(hi, 1)
        let fraction = high <= low ? 0 : clamp01((v - low) / (high - low))
        let clamped = Swift.min(Swift.max(v, low), high)
        let angle = (metrics.arcStart + fraction * metrics.arcSweep)
            .truncatingRemainder(dividingBy: 360).advanced(by: 360)
            .truncatingRemainder(dividingBy: 360)
        let label = (currentLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return Gauge(
            style: resolvedStyle,
            fraction: round6(fraction),
            clampedValue: round6(clamped),
            arcStart: metrics.arcStart,
            arcSweep: metrics.arcSweep,
            valueAngle: round6(angle),
            thickness: metrics.thickness,
            showsCurrentLabel: metrics.showsCurrentLabel,
            showsBoundLabels: metrics.showsBoundLabels,
            a11y: GaugeAccessibility(
                role: "meter",
                min: round6(low),
                max: round6(high),
                now: round6(clamped),
                percent: Int((fraction * 100 + 0.5).rounded(.down)),
                valueText: label.isEmpty ? defaultValueText(v) : label
            )
        )
    }

    public struct GaugeTintSegment: Equatable {
        public let fromIndex: Int
        public let toIndex: Int
        public let t: Double
    }

    /// The value-following tint: which two colours of `tint="a|b|c"` the needle sits between,
    /// and how far. Colour RESOLUTION is per-renderer (tokens differ), so the core returns
    /// indices and an interpolation factor and lets each target mix in its own colour space.
    public static func gaugeTintSegment(
        _ colors: [String], _ stops: [Double], _ fraction: Double
    ) -> GaugeTintSegment? {
        if colors.isEmpty { return nil }
        if colors.count == 1 { return GaugeTintSegment(fromIndex: 0, toIndex: 0, t: 0) }
        let value = clamp01(fraction)
        if stops.count >= 2 {
            for index in 0..<(stops.count - 1) {
                let low = stops[index]
                let high = stops[index + 1]
                if value <= high || index == stops.count - 2 {
                    let span = high - low
                    return GaugeTintSegment(
                        fromIndex: index, toIndex: index + 1,
                        t: round6(clamp01(span <= 0 ? 0 : (value - low) / span))
                    )
                }
            }
        }
        return GaugeTintSegment(fromIndex: colors.count - 2, toIndex: colors.count - 1, t: 1)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // <colorpicker>
    // ─────────────────────────────────────────────────────────────────────────────

    public struct Rgba: Equatable {
        public let r: Int
        public let g: Int
        public let b: Int
        public let a: Int
    }

    /// The pinned name table the picker announces from. Small on purpose: a screen reader
    /// saying "cornflower blue" is not more useful than "blue", and a big table is a big
    /// disagreement.
    public static let colorNames: [(name: String, hex: String)] = [
        ("black", "#000000"), ("white", "#FFFFFF"), ("gray", "#808080"), ("silver", "#C0C0C0"),
        ("red", "#FF0000"), ("maroon", "#800000"), ("orange", "#FFA500"), ("brown", "#A52A2A"),
        ("yellow", "#FFFF00"), ("olive", "#808000"), ("lime", "#00FF00"), ("green", "#008000"),
        ("teal", "#008080"), ("cyan", "#00FFFF"), ("blue", "#0000FF"), ("navy", "#000080"),
        ("indigo", "#4B0082"), ("purple", "#800080"), ("magenta", "#FF00FF"), ("pink", "#FFC0CB"),
        ("tan", "#D2B48C"), ("gold", "#FFD700"), ("beige", "#F5F5DC"), ("turquoise", "#40E0D0"),
    ]

    private static let hexDigits = "0123456789abcdef"

    /// `#RGB` · `#RGBA` · `#RRGGBB` · `#RRGGBBAA` → channels, or nil. Nothing else is a colour
    /// here.
    public static func parseHexColor(_ input: String?) -> Rgba? {
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("#") else { return nil }
        var body = String(text.dropFirst()).lowercased()
        for character in body where !hexDigits.contains(character) { return nil }
        if body.count == 3 || body.count == 4 {
            body = body.map { "\($0)\($0)" }.joined()
        }
        if body.count == 6 { body += "ff" }
        guard body.count == 8 else { return nil }
        let chars = Array(body)
        func byte(_ at: Int) -> Int? { Int(String(chars[at..<(at + 2)]), radix: 16) }
        guard let r = byte(0), let g = byte(2), let b = byte(4), let a = byte(6) else { return nil }
        return Rgba(r: r, g: g, b: b, a: a)
    }

    /// Uppercase output, and the alpha pair only when it is both allowed and not opaque.
    public static func formatHexColor(_ color: Rgba, alphaAllowed: Bool = false) -> String {
        func pair(_ value: Int) -> String { String(format: "%02X", value) }
        let base = "#" + pair(color.r) + pair(color.g) + pair(color.b)
        return alphaAllowed && color.a != 255 ? base + pair(color.a) : base
    }

    /// Nearest name by squared sRGB distance, ties broken by table order. Deterministic on
    /// purpose.
    public static func nearestColorName(_ color: Rgba) -> String {
        var best = colorNames[0].name
        var bestDistance = Int.max
        for entry in colorNames {
            guard let target = parseHexColor(entry.hex) else { continue }
            let dr = color.r - target.r
            let dg = color.g - target.g
            let db = color.b - target.b
            let distance = dr * dr + dg * dg + db * db
            if distance < bestDistance {
                bestDistance = distance
                best = entry.name
            }
        }
        return best
    }

    /// Presets shown first. Invalid entries drop, duplicates collapse, and the list caps at 24.
    public static func resolveSwatches(_ input: String?, alphaAllowed: Bool = false) -> [String] {
        guard let input else { return [] }
        var out: [String] = []
        var seen = Set<String>()
        for token in input.replacingOccurrences(of: "|", with: ",").components(separatedBy: ",") {
            guard let parsed = parseHexColor(token) else { continue }
            let text = formatHexColor(parsed, alphaAllowed: alphaAllowed)
            if seen.contains(text) { continue }
            seen.insert(text)
            out.append(text)
            if out.count == 24 { break }
        }
        return out
    }

    public static let colorPickerModes: [String] = ["wheel", "sliders", "swatches"]

    /// Undeclared mode: swatches when presets exist (they are the fast path), otherwise the
    /// wheel.
    public static func resolveColorPickerMode(_ mode: String?, _ alpha: Bool, _ swatchCount: Int) -> String {
        let word = (mode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if colorPickerModes.contains(word) { return word }
        return swatchCount > 0 ? "swatches" : "wheel"
    }

    /// `<input type="color">` supports neither alpha nor presets, so the web ejects to its own
    /// panel.
    public static func webNeedsCustomColorPanel(_ alpha: Bool, _ swatchCount: Int) -> Bool {
        alpha || swatchCount > 0
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // <masked>
    // ─────────────────────────────────────────────────────────────────────────────

    public struct MaskWebLayer: Equatable {
        public let image: String
        public let composite: String
    }

    public struct Mask: Equatable {
        public let mode: String
        public let invert: Bool
        /// The Compose blend mode: DstIn keeps what the mask covers, DstOut keeps what it does
        /// not. On iOS the same decision picks `.mask()` against the child or its inverse.
        public let blend: String
        public let cssMaskMode: String
        public let webLayers: [MaskWebLayer]
        /// Always true: the mask child is decorative BY CONSTRUCTION.
        public let maskChildHidden: Bool
        /// Always true: `<masked>` changes appearance, not content.
        public let contentSemanticsPreserved: Bool
    }

    public static func resolveMask(_ mode: String?, _ invert: Bool) -> Mask {
        let word = (mode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolved = word == "luminance" ? "luminance" : "alpha"
        return Mask(
            mode: resolved,
            invert: invert,
            blend: invert ? "dstOut" : "dstIn",
            cssMaskMode: resolved,
            webLayers: invert
                ? [MaskWebLayer(image: "opaque", composite: "add"),
                   MaskWebLayer(image: "mask", composite: "subtract")]
                : [MaskWebLayer(image: "mask", composite: "add")],
            maskChildHidden: true,
            contentSemanticsPreserved: true
        )
    }

    /// The markup-facing twin, for the attribute path where `invert=` arrives as text. Kept a
    /// DISTINCT name rather than an overload: `resolveMask(mode, nil)` would otherwise be
    /// ambiguous at every call site that has not decided yet.
    public static func resolveMaskAttributes(_ mode: String?, _ invert: String?) -> Mask {
        resolveMask(mode, (invert ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "true")
    }
}
