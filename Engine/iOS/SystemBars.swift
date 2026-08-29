//
//  SystemBars.swift — the SHARED PURE CORE behind Core/SystemBars (F17.5), and the reference
//  renderer's leg of it. Twin of :core SystemBars.kt and the web kernel's systembars.ts.
//
//  WHY THIS NEEDS A CORE. Android 15 makes edge-to-edge mandatory, which changes what a colour
//  on the navigation bar even does: the bar becomes transparent and the app draws under it. iOS
//  has no navigation bar at all, but it has the home indicator, and hiding that is the same
//  author intent against different hardware. Left to each platform, `immersive` would mean
//  three things and every app would carry a platform fork.
//
//  THE LUMA FORMULA IS THE SIMPLE ONE, ON PURPOSE. WCAG relative luminance needs a per-channel
//  power function, and pow() is not guaranteed identical to the last bit across three
//  languages. A one-ULP difference at the threshold flips a bar's icons from black to white on
//  one platform only, which is exactly the drift this core exists to prevent. ITU-R BT.601 luma
//  is a weighted sum of integers, exact everywhere.
//
//  Pure Foundation, no UIKit: the same decisions serve the Android and web twins.
//  Pinned by OpenSource/Conformance/systembars/bars.json.
//
import Foundation

public enum SystemBarsCore {

    public static let styles = ["light", "dark", "auto"]
    public static let behaviors = ["default", "swipe"]
    public static let modes = ["none", "leanback", "sticky"]

    /// Above this luma the background is "light", so the bar's icons must be dark.
    public static let lumaThreshold = 0.5

    public static let messages: [String: String] = [
        "unknown_style": "That is not a system-bar style. Use light, dark or auto.",
        "unknown_behavior": "That is not a system-bar behavior. Use default or swipe.",
        "unknown_mode": "That is not an immersive mode. Use none, leanback or sticky.",
        "invalid_color": "That is not a colour. Use #RRGGBB, #RRGGBBAA, an R,G,B triple, or transparent.",
    ]

    public static let diagnostics: [String: String] = [
        "color_ignored_edge_to_edge":
            "Edge-to-edge makes the system bars transparent, so the colour was not applied. Draw the colour in your own layout instead.",
        "divider_ignored_edge_to_edge":
            "Edge-to-edge removes the navigation-bar divider, so the divider colour was not applied.",
        "visible_overridden_by_immersive":
            "An immersive mode hides the system bars, so `visible: true` was overridden.",
    ]

    public struct Refusal: Error, Equatable {
        public let code: String
        public let detail: String?
        public init(_ code: String, _ detail: String? = nil) {
            self.code = code
            self.detail = detail
        }
        public var message: String {
            if let detail, !detail.isEmpty { return detail }
            return SystemBarsCore.messages[code] ?? code
        }
    }

    /// 0..255 on every channel, so the whole colour is integers and no float crosses a boundary.
    public struct Color: Equatable {
        public let r: Int
        public let g: Int
        public let b: Int
        public let a: Int
    }

    public struct Plan: Equatable {
        public let visible: Bool
        public let style: String
        public let behavior: String
        public let immersive: String
        public let edgeToEdge: Bool
        public let color: Color
        public let dividerColor: Color
        public let iconsDark: Bool
        public let insetTop: Bool
        public let insetBottom: Bool
        public let hidesHomeIndicator: Bool
        public let diagnostics: [String]
    }

    private static func stringOf(_ raw: Any?) -> String {
        switch raw {
        case let v as String: return v
        case let v as NSNumber: return v.stringValue
        case .none: return ""
        case .some(let v): return "\(v)"
        }
    }

    private static func foldWord(_ raw: Any?, _ vocabulary: [String], _ fallback: String,
                                 _ refusalCode: String) -> Result<String, Refusal> {
        let lowered = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let text = String(lowered.filter { !$0.isWhitespace && $0 != "-" && $0 != "_" })
        if text.isEmpty { return .success(fallback) }
        for word in vocabulary where word == text { return .success(word) }
        return .failure(Refusal(refusalCode, stringOf(raw)))
    }

    public static func foldStyle(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, styles, "auto", "unknown_style")
    }

    public static func foldBehavior(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, behaviors, "default", "unknown_behavior")
    }

    public static func foldMode(_ raw: Any?) -> Result<String, Refusal> {
        foldWord(raw, modes, "none", "unknown_mode")
    }

    private static func hexDigit(_ c: Character) -> Int {
        if c >= "0" && c <= "9" { return Int(c.asciiValue! - 48) }
        if c >= "a" && c <= "f" { return Int(c.asciiValue! - 87) }
        if c >= "A" && c <= "F" { return Int(c.asciiValue! - 55) }
        return -1
    }

    /// Parse the colour spellings a Despia author already writes elsewhere: `#RGB`, `#RGBA`,
    /// `#RRGGBB`, `#RRGGBBAA`, the legacy `R,G,B` triple that `bottombarcolor://` carried, and
    /// the word `transparent`. Anything else is refused rather than silently becoming black: a
    /// bar that quietly turns black is the hardest styling bug to find, because it looks
    /// deliberate.
    public static func parseColor(_ raw: Any?) -> Result<Color, Refusal> {
        let text = stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(Refusal("invalid_color", "a colour is required")) }
        if text.lowercased() == "transparent" { return .success(Color(r: 0, g: 0, b: 0, a: 0)) }

        if text.hasPrefix("#") {
            var digits: [Int] = []
            for c in text.dropFirst() {
                guard c.isASCII else { return .failure(Refusal("invalid_color", text)) }
                let d = hexDigit(c)
                if d < 0 { return .failure(Refusal("invalid_color", text)) }
                digits.append(d)
            }
            if digits.count == 3 || digits.count == 4 {
                // Short form doubles each digit: #f0a is #ff00aa, the same rule CSS uses.
                return .success(Color(r: digits[0] * 17, g: digits[1] * 17, b: digits[2] * 17,
                                      a: digits.count == 4 ? digits[3] * 17 : 255))
            }
            if digits.count == 6 || digits.count == 8 {
                return .success(Color(r: digits[0] * 16 + digits[1],
                                      g: digits[2] * 16 + digits[3],
                                      b: digits[4] * 16 + digits[5],
                                      a: digits.count == 8 ? digits[6] * 16 + digits[7] : 255))
            }
            return .failure(Refusal("invalid_color", text))
        }

        if text.contains(",") {
            let parts = text.components(separatedBy: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            if parts.count != 3 && parts.count != 4 { return .failure(Refusal("invalid_color", text)) }
            var values: [Int] = []
            for part in parts {
                if part.isEmpty { return .failure(Refusal("invalid_color", text)) }
                if part.contains(where: { !$0.isASCII || !$0.isNumber }) {
                    return .failure(Refusal("invalid_color", text))
                }
                guard let n = Int(part), n <= 255 else { return .failure(Refusal("invalid_color", text)) }
                values.append(n)
            }
            return .success(Color(r: values[0], g: values[1], b: values[2],
                                  a: values.count == 4 ? values[3] : 255))
        }

        return .failure(Refusal("invalid_color", text))
    }

    /// ITU-R BT.601 luma, 0..1. Integer weights, so three languages cannot disagree.
    public static func luma(_ color: Color) -> Double {
        (299.0 * Double(color.r) + 587.0 * Double(color.g) + 114.0 * Double(color.b)) / 255000.0
    }

    /// Should the bar's icons be dark? A light background needs dark icons and vice versa.
    ///
    /// A TRANSPARENT bar is the interesting case: there is no background to read, so the icons
    /// must contrast with whatever the app draws underneath, which this core cannot see. The
    /// answer is therefore the app's own appearance, passed in by the caller, never a guess.
    public static func iconsDark(_ color: Color, appearanceIsDark: Bool) -> Bool {
        if color.a == 0 { return !appearanceIsDark }
        return luma(color) > lumaThreshold
    }

    private static func truthy(_ raw: Any?, _ fallback: Bool) -> Bool {
        guard let raw, !(raw is NSNull) else { return fallback }
        if let b = raw as? Bool { return b }
        switch stringOf(raw).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "true", "1", "yes": return true
        case "false", "0", "no": return false
        default: return fallback
        }
    }

    /// Resolve a request into the plan every platform applies.
    ///
    /// THE THREE INTERACTIONS THAT MAKE THIS WORTH SHARING:
    ///  1. Edge-to-edge WINS OVER COLOUR. Android 15 forces transparent system bars, so a
    ///     colour set alongside `edgeToEdge` paints nothing. The plan drops it and says
    ///     `color_ignored_edge_to_edge` rather than letting the author believe it worked.
    ///  2. An IMMERSIVE MODE IMPLIES the bars are gone. `leanback` plus `visible: true` is a
    ///     contradiction; the mode wins and `visible_overridden_by_immersive` is reported.
    ///  3. HIDDEN BARS NEED NO INSETS. `insetTop`/`insetBottom` come from the same place as the
    ///     visibility decision, which is what stops the classic "content under the notch after
    ///     going fullscreen" bug.
    public static func plan(_ raw: [String: Any]) -> Result<Plan, Refusal> {
        let styleWord: String
        switch foldStyle(raw["style"]) {
        case .success(let v): styleWord = v
        case .failure(let r): return .failure(r)
        }
        let behavior: String
        switch foldBehavior(raw["behavior"]) {
        case .success(let v): behavior = v
        case .failure(let r): return .failure(r)
        }
        let immersive: String
        switch foldMode(raw["immersive"]) {
        case .success(let v): immersive = v
        case .failure(let r): return .failure(r)
        }

        let edgeToEdge = truthy(raw["edgeToEdge"], false)
        let appearanceIsDark = truthy(raw["appearanceIsDark"], false)
        var diagnostics: [String] = []

        var color = Color(r: 0, g: 0, b: 0, a: 0)
        if let rawColor = raw["color"], !(rawColor is NSNull), !stringOf(rawColor).isEmpty {
            switch parseColor(rawColor) {
            case .failure(let r): return .failure(r)
            case .success(let parsed):
                if edgeToEdge { diagnostics.append("color_ignored_edge_to_edge") } else { color = parsed }
            }
        }

        var dividerColor = Color(r: 0, g: 0, b: 0, a: 0)
        if let rawDivider = raw["dividerColor"], !(rawDivider is NSNull), !stringOf(rawDivider).isEmpty {
            switch parseColor(rawDivider) {
            case .failure(let r): return .failure(r)
            case .success(let parsed):
                if edgeToEdge { diagnostics.append("divider_ignored_edge_to_edge") } else { dividerColor = parsed }
            }
        }

        let requestedVisible = truthy(raw["visible"], true)
        let immersiveHides = immersive != "none"
        var visible = requestedVisible
        let visibleWasStated = raw["visible"] != nil && !(raw["visible"] is NSNull)
        if immersiveHides && requestedVisible && visibleWasStated {
            diagnostics.append("visible_overridden_by_immersive")
        }
        if immersiveHides { visible = false }

        let dark = styleWord == "auto"
            ? iconsDark(color, appearanceIsDark: appearanceIsDark)
            : styleWord == "dark"
        let resolvedStyle = dark ? "dark" : "light"

        // Under edge-to-edge the app draws behind the bars, so it owns the insets even while
        // they are visible. Hidden bars consume nothing either way.
        let insets = visible && !edgeToEdge

        return .success(Plan(visible: visible, style: resolvedStyle, behavior: behavior,
                             immersive: immersive, edgeToEdge: edgeToEdge, color: color,
                             dividerColor: dividerColor, iconsDark: dark,
                             insetTop: insets, insetBottom: insets,
                             hidesHomeIndicator: immersiveHides, diagnostics: diagnostics))
    }
}
