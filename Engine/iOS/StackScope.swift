//
//  StackScope.swift - value resolution for the StackLive render backend.
//
//  Pure value-mapping, no view construction: it reads a StackNode's attributes
//  and text, resolving DSX `{{ … }}` interpolation, and interprets the result
//  as the typed values elements need (CGFloat, Color, Font.Weight, alignment).
//
//  Interpolation follows the DSX DSL: `{{ dsx.variable.<key> }}` (the live-surface
//  state - progress, name, … - is the reactive `dsx.variable` namespace, exactly
//  like the in-app engine). Only the SIMPLE reference form is evaluated here: a
//  widget / Live-Activity process cannot run JS, so a richer expression
//  (`{{ mmss(dsx.variable.t) }}`, operators, calls) fails open to empty. Keeping
//  resolution separate from the SwiftUI tree makes the renderer testable and the
//  elements purely declarative.
//

import SwiftUI

/// The variable scope a layout renders in: `{{ dsx.variable.name }}` resolves from
/// `vars` (the ContentState / widget state pushed across the process boundary).
struct StackScope {
    let vars: [String: String]

    /// Optional FULL-EXPRESSION evaluator, installed by runtime-capable surfaces: the
    /// watch injects JSE here (StackWatch.swift — its target compiles the `logic` tier),
    /// so `{{ pos * 100 }}`, ternaries and calls evaluate on the wrist. nil on SNAPSHOT
    /// surfaces (widget / Live Activity — no runtime by taxonomy, watch-runtime.md), which
    /// keep the simple-reference form below byte-for-byte. A plain closure so THIS file
    /// stays compilable in tiers that don't carry the logic engine.
    var expr: ((String) -> String)? = nil

    /// Optional CONDITION evaluator — the `visible-if` seam, installed beside `expr` by
    /// the same runtime-capable surfaces: the watch injects real-JSE truthiness
    /// (JSE.truthy over JSE.eval) so `visible-if="has('watch.face')"` gates elements on
    /// the wrist with the executors' VALUE truthiness (the string "0" is truthy, the
    /// number 0 is not — the `expr` string channel cannot carry that distinction). nil on
    /// snapshot surfaces: widgets / Live Activities render every node, fail-open,
    /// byte-identical to before. (The Kotlin :core scope carries neither seam — the wear
    /// painter's prepass evaluates both in-place; StackWear.kt header pins the plumbing.)
    var cond: ((String) -> Bool)? = nil

    /// Resolve every `{{ … }}` span. With `expr` installed → the full grammar; else
    /// `{{ dsx.variable.<key> }}` → `vars[key]` and anything richer fails open to empty.
    func substitute(_ s: String) -> String {
        guard s.contains("{{") else { return s }
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if chars[i] == "{", i + 1 < chars.count, chars[i + 1] == "{" {
                var j = i + 2
                while j + 1 < chars.count, !(chars[j] == "}" && chars[j + 1] == "}") { j += 1 }
                if j + 1 < chars.count {
                    out += resolve(String(chars[(i + 2)..<j]).trimmingCharacters(in: .whitespaces))
                    i = j + 2
                    continue
                }
            }
            out.append(chars[i]); i += 1
        }
        return out
    }

    private func resolve(_ e: String) -> String {
        if let expr { return expr(e) }
        let prefix = "dsx.variable."
        guard e.hasPrefix(prefix) else { return "" }
        let key = String(e.dropFirst(prefix.count))
        guard !key.isEmpty, key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return "" }
        return vars[key] ?? ""
    }
}

/// A `StackNode` bound to a `StackScope`: typed, substituted access to its
/// attributes and text. Elements read through this; they never touch raw attrs.
struct StackReader {
    let node: StackNode
    let scope: StackScope

    func string(_ key: String) -> String? { node.attrs[key].map(scope.substitute) }

    var text: String {
        // Match the full in-app text contract: bind (data) > inner text > value.
        // `scope.substitute` is full JSE on the watch and the bounded simple-reference
        // evaluator on snapshot surfaces, so the same precedence is safe in both tiers.
        if let bind = node.attrs["bind"] {
            return scope.substitute("{{ \(bind) }}")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let authored = node.text ?? node.attrs["value"] ?? ""
        return scope.substitute(authored)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cgFloat(_ key: String, _ fallback: CGFloat) -> CGFloat {
        string(key).flatMap { Double($0) }.map { CGFloat($0) } ?? fallback
    }
    func double(_ key: String, _ fallback: Double) -> Double {
        string(key).flatMap { Double($0) } ?? fallback
    }
    /// A 0...1 value (progress, gauge fill), clamped.
    func unit(_ key: String) -> Double { min(max(double(key, 0), 0), 1) }

    func color(_ key: String, _ fallback: Color) -> Color {
        string(key).map(StackColor.parse) ?? fallback
    }

    var fontWeight: Font.Weight {
        switch string("weight") ?? "" {
        case "bold":     return .bold
        case "semibold": return .semibold
        case "medium":   return .medium
        case "light":    return .light
        default:         return .regular
        }
    }
    var horizontalAlignment: HorizontalAlignment {
        switch string("align") ?? "" {
        case "leading", "left":   return .leading
        case "trailing", "right": return .trailing
        default:                  return .center
        }
    }
    var verticalAlignment: VerticalAlignment {
        switch string("align") ?? "" {
        case "top":    return .top
        case "bottom": return .bottom
        default:       return .center
        }
    }
    var frameAlignment: Alignment {
        switch string("align") ?? "" {
        case "leading", "left":   return .leading
        case "trailing", "right": return .trailing
        default:                  return .center
        }
    }
    var growsWidth: Bool {
        // The shared DSX fill contract: true/both fill both axes, so they necessarily
        // fill width too. Snapshot renderers do not model height here, but must not
        // collapse a grow="true" root to zero width on watchOS.
        let g = string("grow")
        return g == "true" || g == "both" || g == "width" || g == "all"
    }

    /// The event name a tap should emit on a snapshot surface (watch / extension):
    /// `event="open"` (surface-native), or the literal name lifted from the in-app form
    /// `on:tap="dsx.event('open')"` — so the SAME markup is 1:1 across iOS, watchOS and
    /// Android. No JS is evaluated: only the quoted name is read with a plain string scan
    /// (a snapshot process cannot run JSE — see this file's header).
    var tapEvent: String? {
        if let e = node.attrs["event"], !e.isEmpty { return e }
        let handler = node.attrs["on:tap"] ?? node.attrs["on:press"] ?? ""
        guard let call = handler.range(of: "dsx.event(") else { return nil }
        let afterParen = handler[call.upperBound...].drop { $0 == " " }
        guard let quote = afterParen.first, quote == "'" || quote == "\"" else { return nil }
        let body = afterParen.dropFirst()
        guard let end = body.firstIndex(of: quote) else { return nil }
        let name = String(body[body.startIndex..<end])
        return name.isEmpty ? nil : name
    }
}

/// DSX color literals the live surfaces need: a small named palette plus
/// `#RRGGBB` / `#AARRGGBB` hex. Unknown input fails open to `.primary`.
/// "separator" is EXISTING phone vocabulary (the divider element's pinned
/// default — Stack.swift resolves it to UIColor.separator); the live surfaces
/// have no UIKit dynamic color, so it maps to the same hairline the divider
/// default uses (StackLive LiveDividerElement / Kotlin StackColor.DIVIDER).
enum StackColor {
    static func parse(_ raw: String) -> Color {
        switch raw.lowercased() {
        case "primary":             return .primary
        case "secondary":           return .secondary
        case "separator":           return .secondary.opacity(0.25)
        case "accent", "accentcolor": return .accentColor
        case "white":               return .white
        case "black":               return .black
        case "clear":               return .clear
        case "red":                 return .red
        case "green":               return .green
        case "blue":                return .blue
        case "yellow":              return .yellow
        case "orange":              return .orange
        default:                    break
        }
        var hex = raw.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6 || hex.count == 8, let v = UInt64(hex, radix: 16) else { return .primary }
        let a = hex.count == 8 ? Double((v >> 24) & 0xFF) / 255.0 : 1.0
        return Color(red:     Double((v >> 16) & 0xFF) / 255.0,
                     green:   Double((v >> 8) & 0xFF) / 255.0,
                     blue:    Double(v & 0xFF) / 255.0,
                     opacity: a)
    }
}
