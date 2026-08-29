//
//  ControlsConformance.swift — the Swift runner for OpenSource/Conformance/controls/
//  {gradients,gauge,colorpicker,masked}.json (parity/U07-controls.md §6). The third of three:
//  TS runs it per-PR (packages/kernel/test/controls-core.test.ts), Kotlin runs it under gradle
//  (:core ControlsConformanceTest), and this runs it in the record lane.
//
//  It exists because a gradient angle is the classic silent divergence: CSS says 0deg points up
//  and increases clockwise, SwiftUI's UnitPoint model is unrelated, and Compose's Offset model
//  is a third thing. `gradientAngle="135deg"` pointing two different ways is not a crash, not a
//  log line, and not something a one-platform screenshot diff catches. Same file, three
//  runners, no drift — and the same argument holds for a <gauge> reporting a different meter
//  value to VoiceOver than to TalkBack.
//
//  Pure Foundation, no SwiftUI — the record lane runs headless.
//
import Foundation

enum ControlsConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static let epsilon = 1e-9

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(description: "controls/\(message)") }
    }

    private static func near(_ actual: Double, _ expected: Double, _ label: String) throws {
        try require(abs(actual - expected) < epsilon, "\(label): expected \(expected), got \(actual)")
    }

    private static func number(_ value: Any?) -> Double {
        (value as? NSNumber)?.doubleValue ?? 0
    }

    private static func point(_ value: Any?) -> (x: Double, y: Double) {
        let map = value as? [String: Any] ?? [:]
        return (number(map["x"]), number(map["y"]))
    }

    private static func doc(_ dir: URL, _ name: String) throws -> [String: Any] {
        let file = dir.appendingPathComponent("\(name).json")
        let data = try Data(contentsOf: file)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure(description: "controls/\(name).json: not a JSON object")
        }
        guard (root["version"] as? NSNumber)?.intValue == 1 else {
            throw Failure(description: "controls/\(name).json: unsupported version")
        }
        return root
    }

    private static func rows(_ root: [String: Any], _ name: String, _ section: String) throws -> [[String: Any]] {
        guard let list = root[section] as? [[String: Any]], !list.isEmpty else {
            throw Failure(description: "controls/\(name).json: no \(section)[]")
        }
        return list
    }

    /// Run every controls corpus file through the shared `ControlsCore`.
    static func verify(corpusDir: URL) throws -> Int {
        var count = 0
        count += try verifyGradients(corpusDir)
        count += try verifyGauge(corpusDir)
        count += try verifyColorPicker(corpusDir)
        count += try verifyMask(corpusDir)
        guard count > 0 else { throw Failure(description: "controls: no cases") }
        return count
    }

    // ── gradients.json ────────────────────────────────────────────────────────────────────

    private static func verifyGradients(_ dir: URL) throws -> Int {
        let root = try doc(dir, "gradients")

        let types = (root["types"] as? [String]) ?? []
        try require(types == ControlsCore.gradientTypes, "gradients/types: \(types) vs \(ControlsCore.gradientTypes)")

        let aliases = (root["directionAliases"] as? [String: Any]) ?? [:]
        try require(aliases.keys.sorted() == ControlsCore.gradientDirectionAliases.keys.sorted(),
                    "gradients/directionAliases: key set")
        for (token, angle) in aliases {
            guard let declared = ControlsCore.gradientDirectionAliases[token] else {
                throw Failure(description: "controls/gradients/alias \(token): missing")
            }
            try near(declared, number(angle), "gradients/alias \(token)")
            guard let parsed = ControlsCore.parseGradientAngle(token) else {
                throw Failure(description: "controls/gradients/alias \(token): did not parse")
            }
            try near(parsed, number(angle), "gradients/parse \(token)")
        }
        let defaults = (root["defaults"] as? [String: Any]) ?? [:]
        try near(ControlsCore.gradientAngleDefault, number(defaults["angle"]), "gradients/default angle")

        // 0deg points UP, and the angle increases CLOCKWISE — the whole reason this file exists.
        let up = ControlsCore.gradientUnitPoints(0)
        try near(up.start.y, 1, "gradients/0deg start y")
        try near(up.end.y, 0, "gradients/0deg end y")
        let right = ControlsCore.gradientUnitPoints(90)
        try near(right.start.x, 0, "gradients/90deg start x")
        try near(right.end.x, 1, "gradients/90deg end x")

        let cases = try rows(root, "gradients", "cases")
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let attrs = raw["attrs"] as? [String: Any] ?? [:]
            func text(_ key: String) -> String? {
                if let value = attrs[key] as? String { return value }
                if let value = attrs[key] as? NSNumber { return value.stringValue }
                return nil
            }
            let got = ControlsCore.resolveGradient(
                gradient: text("gradient"),
                gradientType: text("gradientType"),
                gradientStops: text("gradientStops"),
                gradientAngle: text("gradientAngle"),
                gradientDir: text("gradientDir"),
                gradientCenter: text("gradientCenter"),
                gradientRadius: text("gradientRadius"),
                gradientPoints: text("gradientPoints")
            )
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.type == expect["type"] as? String, "gradients/\(name): type \(got.type)")
            try require(got.colors == (expect["colors"] as? [String] ?? []), "gradients/\(name): colors \(got.colors)")
            let stops = (expect["stops"] as? [Any] ?? []).map { number($0) }
            try require(got.stops.count == stops.count, "gradients/\(name): stop count")
            for (index, value) in stops.enumerated() {
                try near(got.stops[index], value, "gradients/\(name): stop \(index)")
            }
            try near(got.angle, number(expect["angle"]), "gradients/\(name): angle")
            let start = point(expect["start"])
            try near(got.start.x, start.x, "gradients/\(name): start.x")
            try near(got.start.y, start.y, "gradients/\(name): start.y")
            let end = point(expect["end"])
            try near(got.end.x, end.x, "gradients/\(name): end.x")
            try near(got.end.y, end.y, "gradients/\(name): end.y")
            let center = point(expect["center"])
            try near(got.center.x, center.x, "gradients/\(name): center.x")
            try near(got.center.y, center.y, "gradients/\(name): center.y")
            try near(got.radius, number(expect["radius"]), "gradients/\(name): radius")
            try require(got.valid == (expect["valid"] as? Bool ?? false), "gradients/\(name): valid")

            guard let mesh = expect["mesh"] as? [String: Any] else {
                try require(got.mesh == nil, "gradients/\(name): mesh must be absent")
                try require(got.meshFallback == nil, "gradients/\(name): meshFallback must be absent")
                continue
            }
            guard let grid = got.mesh else {
                throw Failure(description: "controls/gradients/\(name): mesh missing")
            }
            try require(grid.columns == (mesh["columns"] as? NSNumber)?.intValue, "gradients/\(name): mesh columns")
            try require(grid.rows == (mesh["rows"] as? NSNumber)?.intValue, "gradients/\(name): mesh rows")
            let points = mesh["points"] as? [[String: Any]] ?? []
            try require(grid.points.count == points.count, "gradients/\(name): mesh point count")
            for (index, want) in points.enumerated() {
                try near(grid.points[index].x, number(want["x"]), "gradients/\(name): point \(index) x")
                try near(grid.points[index].y, number(want["y"]), "gradients/\(name): point \(index) y")
                try require(grid.points[index].color == want["color"] as? String,
                            "gradients/\(name): point \(index) color")
            }
            let fallback = expect["meshFallback"] as? [String: Any] ?? [:]
            guard let degradation = got.meshFallback else {
                throw Failure(description: "controls/gradients/\(name): meshFallback missing")
            }
            try require(degradation.base == fallback["base"] as? String, "gradients/\(name): fallback base")
            let layers = fallback["layers"] as? [[String: Any]] ?? []
            try require(degradation.layers.count == layers.count, "gradients/\(name): fallback layer count")
            for (index, want) in layers.enumerated() {
                let center = point(want["center"])
                try near(degradation.layers[index].center.x, center.x, "gradients/\(name): layer \(index) x")
                try near(degradation.layers[index].center.y, center.y, "gradients/\(name): layer \(index) y")
                try near(degradation.layers[index].radius, number(want["radius"]),
                         "gradients/\(name): layer \(index) radius")
                try require(degradation.layers[index].color == want["color"] as? String,
                            "gradients/\(name): layer \(index) color")
            }
        }

        // A ragged or one-dimensional grid is not a mesh, and degrades to linear rather than
        // painting a blank.
        try require(ControlsCore.parseMeshPoints("0 0 #F00, 1 0 #0F0; 0 1 #00F") == nil, "gradients/ragged grid")
        try require(ControlsCore.parseMeshPoints("0 0 #F00, 1 0 #0F0") == nil, "gradients/one row")
        try require(ControlsCore.parseMeshPoints("0 0 #F00; 0 1 #00F") == nil, "gradients/one column")
        try require(ControlsCore.parseMeshPoints("0 0; 0 1") == nil, "gradients/point without a colour")
        let degraded = ControlsCore.resolveGradient(gradient: "#F00|#00F", gradientType: "mesh",
                                                    gradientPoints: "0 0 #F00")
        try require(degraded.type == "linear", "gradients/degraded mesh is linear")
        try require(degraded.valid, "gradients/degraded mesh still paints")
        return cases.count
    }

    // ── gauge.json ────────────────────────────────────────────────────────────────────────

    private static func verifyGauge(_ dir: URL) throws -> Int {
        let root = try doc(dir, "gauge")
        let styles = (root["styles"] as? [String: Any]) ?? [:]
        try require(styles.keys.sorted() == ControlsCore.gaugeStyles.keys.sorted(), "gauge/styles: key set")
        for (name, raw) in styles {
            guard let expect = raw as? [String: Any], let metrics = ControlsCore.gaugeStyles[name] else {
                throw Failure(description: "controls/gauge/style \(name): missing")
            }
            try near(metrics.arcStart, number(expect["arcStart"]), "gauge/\(name): arcStart")
            try near(metrics.arcSweep, number(expect["arcSweep"]), "gauge/\(name): arcSweep")
            try near(metrics.thickness, number(expect["thickness"]), "gauge/\(name): thickness")
            try require(metrics.showsCurrentLabel == expect["showsCurrentLabel"] as? Bool,
                        "gauge/\(name): showsCurrentLabel")
            try require(metrics.showsBoundLabels == expect["showsBoundLabels"] as? Bool,
                        "gauge/\(name): showsBoundLabels")
        }

        let cases = try rows(root, "gauge", "cases")
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
            let got = ControlsCore.resolveGauge(
                value: number(raw["value"]), min: number(raw["min"]), max: number(raw["max"]),
                style: raw["style"] as? String, currentLabel: raw["currentLabel"] as? String
            )
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.style == expect["style"] as? String, "gauge/\(name): style")
            try near(got.fraction, number(expect["fraction"]), "gauge/\(name): fraction")
            try near(got.clampedValue, number(expect["clampedValue"]), "gauge/\(name): clampedValue")
            try near(got.arcStart, number(expect["arcStart"]), "gauge/\(name): arcStart")
            try near(got.arcSweep, number(expect["arcSweep"]), "gauge/\(name): arcSweep")
            try near(got.valueAngle, number(expect["valueAngle"]), "gauge/\(name): valueAngle")
            try near(got.thickness, number(expect["thickness"]), "gauge/\(name): thickness")
            try require(got.showsCurrentLabel == expect["showsCurrentLabel"] as? Bool,
                        "gauge/\(name): showsCurrentLabel")
            try require(got.showsBoundLabels == expect["showsBoundLabels"] as? Bool,
                        "gauge/\(name): showsBoundLabels")
            let a11y = expect["a11y"] as? [String: Any] ?? [:]
            try require(got.a11y.role == a11y["role"] as? String, "gauge/\(name): role")
            try near(got.a11y.min, number(a11y["min"]), "gauge/\(name): a11y min")
            try near(got.a11y.max, number(a11y["max"]), "gauge/\(name): a11y max")
            try near(got.a11y.now, number(a11y["now"]), "gauge/\(name): a11y now")
            try require(got.a11y.percent == (a11y["percent"] as? NSNumber)?.intValue,
                        "gauge/\(name): a11y percent \(got.a11y.percent)")
            try require(got.a11y.valueText == a11y["valueText"] as? String,
                        "gauge/\(name): a11y valueText \(got.a11y.valueText)")
        }

        for raw in try rows(root, "gauge", "tint") {
            let name = raw["name"] as? String ?? "?"
            let colors = ControlsCore.parseGradientColors(raw["tint"] as? String)
            let stops = ControlsCore.parseGradientStops(raw["stops"] as? String, colors.count)
            let got = ControlsCore.gaugeTintSegment(colors, stops, number(raw["fraction"]))
            guard let expect = raw["expect"] as? [String: Any] else {
                try require(got == nil, "gauge/tint \(name): expected no segment")
                continue
            }
            guard let segment = got else {
                throw Failure(description: "controls/gauge/tint \(name): resolved no segment")
            }
            try require(segment.fromIndex == (expect["fromIndex"] as? NSNumber)?.intValue,
                        "gauge/tint \(name): fromIndex")
            try require(segment.toIndex == (expect["toIndex"] as? NSNumber)?.intValue,
                        "gauge/tint \(name): toIndex")
            try near(segment.t, number(expect["t"]), "gauge/tint \(name): t")
        }
        try require(ControlsCore.gaugeTintSegment([], [], 0.5) == nil, "gauge/tint: no colours, no segment")

        // An empty or inverted range is fraction 0, never NaN.
        for (lo, hi) in [(10.0, 10.0), (10.0, 5.0), (0.0, 0.0)] {
            let got = ControlsCore.resolveGauge(value: 7, min: lo, max: hi, style: "circular")
            try near(got.fraction, 0, "gauge/degenerate range \(lo)…\(hi)")
            try require(got.valueAngle.isFinite, "gauge/degenerate range \(lo)…\(hi): finite angle")
        }
        return cases.count
    }

    // ── colorpicker.json ──────────────────────────────────────────────────────────────────

    private static func verifyColorPicker(_ dir: URL) throws -> Int {
        let root = try doc(dir, "colorpicker")
        let names = (root["names"] as? [[String: Any]]) ?? []
        try require(names.map { $0["name"] as? String ?? "" } == ControlsCore.colorNames.map { $0.name },
                    "colorpicker/names: order")
        try require(names.map { $0["hex"] as? String ?? "" } == ControlsCore.colorNames.map { $0.hex },
                    "colorpicker/names: hex")
        try require((root["modes"] as? [String] ?? []) == ControlsCore.colorPickerModes, "colorpicker/modes")

        let parse = try rows(root, "colorpicker", "parse")
        for raw in parse {
            let name = raw["name"] as? String ?? "?"
            let parsed = ControlsCore.parseHexColor(raw["input"] as? String)
            guard let expect = raw["expect"] as? [String: Any] else {
                try require(parsed == nil, "colorpicker/\(name): expected no colour")
                continue
            }
            guard let color = parsed else {
                throw Failure(description: "controls/colorpicker/\(name): did not parse")
            }
            let rgba = expect["rgba"] as? [String: Any] ?? [:]
            try require(color.r == (rgba["r"] as? NSNumber)?.intValue, "colorpicker/\(name): r")
            try require(color.g == (rgba["g"] as? NSNumber)?.intValue, "colorpicker/\(name): g")
            try require(color.b == (rgba["b"] as? NSNumber)?.intValue, "colorpicker/\(name): b")
            try require(color.a == (rgba["a"] as? NSNumber)?.intValue, "colorpicker/\(name): a")
            try require(ControlsCore.formatHexColor(color) == expect["hex"] as? String,
                        "colorpicker/\(name): hex")
            try require(ControlsCore.formatHexColor(color, alphaAllowed: true) == expect["hexWithAlpha"] as? String,
                        "colorpicker/\(name): hex+alpha")
            try require(ControlsCore.nearestColorName(color) == expect["name"] as? String,
                        "colorpicker/\(name): announced name")
            try require(ControlsCore.parseHexColor(ControlsCore.formatHexColor(color, alphaAllowed: true)) == color,
                        "colorpicker/\(name): round-trip")
        }

        for raw in try rows(root, "colorpicker", "nearestName") {
            let name = raw["name"] as? String ?? "?"
            guard let color = ControlsCore.parseHexColor(raw["input"] as? String) else {
                throw Failure(description: "controls/colorpicker/nearestName \(name): did not parse")
            }
            try require(ControlsCore.nearestColorName(color) == raw["expect"] as? String,
                        "colorpicker/nearestName \(name)")
        }

        for raw in try rows(root, "colorpicker", "swatches") {
            let name = raw["name"] as? String ?? "?"
            let got = ControlsCore.resolveSwatches(raw["swatches"] as? String,
                                                   alphaAllowed: raw["alpha"] as? Bool ?? false)
            try require(got == (raw["expect"] as? [String] ?? []), "colorpicker/swatches \(name): \(got)")
        }
        let many = (0..<40).map { String(format: "#%06x", $0) }.joined(separator: ",")
        try require(ControlsCore.resolveSwatches(many).count == 24, "colorpicker/swatches: the list caps at 24")

        for raw in try rows(root, "colorpicker", "mode") {
            let alpha = raw["alpha"] as? Bool ?? false
            let count = (raw["swatchCount"] as? NSNumber)?.intValue ?? 0
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(ControlsCore.resolveColorPickerMode(raw["mode"] as? String, alpha, count)
                            == expect["mode"] as? String,
                        "colorpicker/mode \(raw["mode"] ?? "-")")
            try require(ControlsCore.webNeedsCustomColorPanel(alpha, count)
                            == expect["webNeedsCustomPanel"] as? Bool,
                        "colorpicker/webNeedsCustomPanel \(alpha)/\(count)")
        }
        return parse.count
    }

    // ── masked.json ───────────────────────────────────────────────────────────────────────

    private static func verifyMask(_ dir: URL) throws -> Int {
        let root = try doc(dir, "masked")
        let cases = try rows(root, "masked", "cases")
        for raw in cases {
            let name = raw["name"] as? String ?? "?"
// `invert` arrives as a BOOL, a STRING or absent, because the corpus carries both
// the programmatic spelling and the ATTRIBUTE one an author writes in markup. This
// read was `as? Bool ?? false`, so the string case failed the cast and silently
// became false - the Swift column reported a disagreement the runtime never had
// (ControlsCore.resolveMaskAttributes handles the string form). The TS reference
// takes all three in one function; this mirrors it exactly.
let invertRaw = raw["invert"]
let inverted = (invertRaw as? Bool)
    ?? ((invertRaw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() == "true")
let got = ControlsCore.resolveMask(raw["mode"] as? String, inverted)
            let expect = raw["expect"] as? [String: Any] ?? [:]
            try require(got.mode == expect["mode"] as? String, "masked/\(name): mode")
            try require(got.invert == expect["invert"] as? Bool, "masked/\(name): invert")
            try require(got.blend == expect["blend"] as? String, "masked/\(name): blend")
            try require(got.cssMaskMode == expect["cssMaskMode"] as? String, "masked/\(name): cssMaskMode")
            try require(got.maskChildHidden == expect["maskChildHidden"] as? Bool,
                        "masked/\(name): maskChildHidden")
            try require(got.contentSemanticsPreserved == expect["contentSemanticsPreserved"] as? Bool,
                        "masked/\(name): contentSemanticsPreserved")
            let layers = expect["webLayers"] as? [[String: Any]] ?? []
            try require(got.webLayers.count == layers.count, "masked/\(name): layer count")
            for (index, want) in layers.enumerated() {
                try require(got.webLayers[index].image == want["image"] as? String,
                            "masked/\(name): layer \(index) image")
                try require(got.webLayers[index].composite == want["composite"] as? String,
                            "masked/\(name): layer \(index) composite")
            }
        }
        // The mask child is decorative BY CONSTRUCTION and the content keeps its own semantics —
        // there is no attribute spelling that turns either off.
        for mode in [nil, "alpha", "luminance", "bogus"] {
            for invert in [true, false] {
                let got = ControlsCore.resolveMask(mode, invert)
                try require(got.maskChildHidden, "masked/\(mode ?? "nil"): mask child must stay hidden")
                try require(got.contentSemanticsPreserved, "masked/\(mode ?? "nil"): content keeps semantics")
            }
        }
        return cases.count
    }
}
