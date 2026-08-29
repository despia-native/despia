//
//  StyleOverrides.swift - the style-override plane's pure core (the component STYLE
//  contract, beside the attribute DATA contract). Three laws live here, shared by
//  every renderer and pinned by OpenSource/Conformance/overrides/style-overrides.json:
//  the usage-site SPLIT (`override:<identifier>` leaves the props plane), the typed
//  fail-open RESOLVE (raw value -> coerced value -> declaration default -> null), and
//  the READ chain (item __overrides -> store dsx.override var -> default) that
//  JSE.swift's lookup rides for `dsx.override.<name>`.
//
//  Twins: OpenSource/Web/packages/kernel/src/style-overrides.ts, Engine/Android core
//  StyleOverrides.kt. Divergences here are corpus-visible, never silent.
//
//  FOUNDATION-ONLY AND APPLE-FREE ON PURPOSE: this file is a member of the Apple-free
//  conformance island (swift_conformance_run_test.rb runs it per-PR on the Linux lane),
//  so it may not reference JSE.swift or any Apple framework. The tiny number-to-text
//  rule below therefore lives here rather than borrowing JSE's.
//

import Foundation

/// A declared override - `<override as= type= default= options= min= max=/>` carried
/// verbatim from markup (everything is a string at the declaration site; min/max also
/// accept numbers when built programmatically).
public struct OverrideDecl {
    public let name: String
    public let type: String?
    public let `default`: String?
    public let options: String?
    public let min: Any?
    public let max: Any?

    public init(name: String, type: String? = nil, default def: String? = nil,
                options: String? = nil, min: Any? = nil, max: Any? = nil) {
        self.name = name
        self.type = type
        self.default = def
        self.options = options
        self.min = min
        self.max = max
    }
}

public enum StyleOverrides {

    public static let prefix = "override:"

    /// An override name must be a legal member read (`dsx.override.<name>`) - identifier
    /// only, no dots, no colons. The platform-suffix words can never appear here: the
    /// platform fold consumes them before any split runs (corpus `reserved`).
    private static func isName(_ s: String) -> Bool {
        guard let first = s.unicodeScalars.first else { return false }
        let head = (first >= "A" && first <= "Z") || (first >= "a" && first <= "z") || first == "_"
        guard head else { return false }
        for c in s.unicodeScalars.dropFirst() {
            let ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_"
            if !ok { return false }
        }
        return true
    }

    /// `override:radius` -> `radius`; anything that is not an override -> nil. The ONE
    /// membership test every renderer's usage-site split calls.
    public static func overrideAttrName(_ attr: String) -> String? {
        guard attr.hasPrefix(prefix) else { return nil }
        let name = String(attr.dropFirst(prefix.count))
        return isName(name) ? name : nil
    }

    /// The split law as one fold (the corpus `split` section runs this): overrides out
    /// of the attribute map, `on:` handlers dropped (they are the event plane),
    /// everything else left as props - including a malformed `override:` spelling,
    /// which stays a visible (and lint-flagged) ordinary attribute.
    public static func split(_ attrs: [String: String]) -> (overrides: [String: String], props: [String: String]) {
        var overrides: [String: String] = [:]
        var props: [String: String] = [:]
        for (name, value) in attrs {
            if name.hasPrefix("on:") { continue }
            if let override = overrideAttrName(name) { overrides[override] = value }
            else { props[name] = value }
        }
        return (overrides, props)
    }

    // MARK: - The typed fail-open resolve

    /// TRUE booleans only. `v is Bool` is unusable here: Linux corelibs-foundation lets a
    /// JSON `0`/`1` NSNumber answer `as? Bool`, so a numeric zero would read as a boolean
    /// on one platform and a number on the other — the exact cross-runtime split the
    /// corpus exists to prevent. The type identity is the discriminator that holds on
    /// both: a Swift Bool, or the boxed boolean class the JSON parsers mint.
    private static func isBooleanValue(_ v: Any) -> Bool {
        if type(of: v) == Bool.self { return true }
        let t = String(describing: type(of: v))
        return t == "__NSCFBoolean" || t == "NSCFBoolean" || t == "Boolean"
    }

    private static func boolValue(_ v: Any) -> Bool? {
        isBooleanValue(v) ? (v as? Bool) : nil
    }

    private static func strictNumber(_ value: Any?) -> Double? {
        guard let value = value, !isBooleanValue(value) else { return nil }
        if let d = value as? Double { return d.isFinite ? d : nil }
        if let i = value as? Int { return Double(i) }
        if let n = value as? NSNumber { let d = n.doubleValue; return d.isFinite ? d : nil }
        if let s = value as? String {
            var digits = 0
            var dots = 0
            var index = s.startIndex
            if index < s.endIndex, s[index] == "+" || s[index] == "-" { index = s.index(after: index) }
            var i = index
            while i < s.endIndex {
                let c = s[i]
                if c == "." { dots += 1 }
                else if c.isASCII && c.isNumber { digits += 1 }
                else { return nil }
                i = s.index(after: i)
            }
            guard digits > 0, dots <= 1 else { return nil }
            return Double(s)
        }
        return nil
    }

    private static func clamp(_ value: Double, _ decl: OverrideDecl) -> Double {
        var out = value
        if let min = strictNumber(decl.min), out < min { out = min }
        if let max = strictNumber(decl.max), out > max { out = max }
        return out
    }

    /// The cross-runtime number-to-text rule (an integral double prints without ".0",
    /// mirroring JS String(5) and Kotlin JSE.string) - local so the file stays free of
    /// JSE.swift for the Apple-free island.
    private static func numberText(_ d: Double) -> String {
        if d.rounded() == d && abs(d) < 1e15 { return String(Int64(d)) }
        return String(d)
    }

    /// One scalar in, trimmed string out - or nil for anything that is not a scalar.
    /// Booleans keep their word form so `text` coercion mirrors JSE string coercion.
    private static func scalarText(_ raw: Any?) -> String? {
        if let raw = raw, let b = boolValue(raw) { return b ? "true" : "false" }
        if let s = raw as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let d = strictNumber(raw) { return numberText(d) }
        return nil
    }

    private static func balancedFunctional(_ value: String) -> Bool {
        guard value.hasSuffix(")") else { return false }
        var depth = 0
        for ch in value {
            if ch == "(" { depth += 1 }
            else if ch == ")" { depth -= 1; if depth < 0 { return false } }
        }
        return depth == 0
    }

    private static func optionList(_ decl: OverrideDecl) -> [String] {
        (decl.options ?? "").split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }).map(String.init)
    }

    private static func isHexColor(_ s: String) -> Bool {
        guard s.hasPrefix("#") else { return false }
        let body = s.dropFirst()
        let lengths: Set<Int> = [3, 4, 6, 8]
        guard lengths.contains(body.count) else { return false }
        return body.allSatisfy { $0.isHexDigit }
    }

    private static func isColorToken(_ s: String) -> Bool {
        !s.isEmpty && s.allSatisfy { ($0 >= "A" && $0 <= "Z") || ($0 >= "a" && $0 <= "z") }
    }

    private static func isFunctionalColor(_ s: String) -> Bool {
        for head in ["rgb(", "rgba(", "hsl(", "hsla("] where s.hasPrefix(head) { return true }
        return false
    }

    /// Coerce one raw value by the declaration's type. nil = unset-or-invalid (the
    /// caller falls back to the default). The style-plane trim rule applies first: outer
    /// whitespace never carries meaning, and an empty value means unset.
    private static func coerce(_ decl: OverrideDecl, _ raw: Any?) -> Any? {
        guard let raw = raw, !(raw is NSNull) else { return nil }
        switch decl.type ?? "text" {
        case "number":
            if isBooleanValue(raw) { return nil }
            let candidate: Any? = (raw as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? raw
            guard let n = strictNumber(candidate) else { return nil }
            return clamp(n, decl)
        case "length":
            if isBooleanValue(raw) { return nil }
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            if let n = strictNumber(text) { return clamp(n, decl) }
            if text.contains(";") || text.contains("{") || text.contains("}") { return nil }
            return text
        case "boolean":
            if let b = boolValue(raw) { return b }
            if let s = raw as? String {
                if s == "true" { return true }
                if s == "false" { return false }
            }
            return nil
        case "enum":
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            return optionList(decl).contains(text) ? text : nil
        case "multiEnum":
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            let options = optionList(decl)
            let tokens = text.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }).map(String.init)
            guard !tokens.isEmpty, tokens.allSatisfy({ options.contains($0) }) else { return nil }
            return tokens.joined(separator: " ")
        case "color":
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            if text.hasPrefix("#") { return isHexColor(text) ? text : nil }
            if isFunctionalColor(text) { return balancedFunctional(text) ? text : nil }
            return isColorToken(text) ? text : nil
        case "gradient", "ratio":
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            if text.contains(";") || text.contains("{") || text.contains("}") { return nil }
            return text
        case "css":
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            if text.contains("{") || text.contains("}") { return nil }
            return text
        default:
            // text, and any unknown declared type (lint owns rejecting the declaration)
            guard let text = scalarText(raw), !text.isEmpty else { return nil }
            return text
        }
    }

    /// The resolve law: coerced raw -> coerced default -> nil. Never throws - an
    /// invalid live value degrades to the declared look instead of poisoning the pixels.
    public static func resolve(_ decl: OverrideDecl, _ raw: Any?) -> Any? {
        if let value = coerce(decl, raw) { return value }
        if let def = decl.default { return coerce(decl, def) }
        return nil
    }

    /// The whole-plane read (`dsx.override`): the DECLARED contract resolved - undeclared
    /// raw keys never appear, every declared knob answers. Raw chain per name: the item
    /// scope's dict (the tag door) beats the store var (the mount/update door).
    public static func resolvePlane(
        _ decls: [OverrideDecl],
        _ itemOverrides: [String: Any]?,
        _ storeOverrides: [String: Any]?,
    ) -> [String: Any] {
        var out: [String: Any] = [:]
        for decl in decls {
            let fromItem = itemOverrides?[decl.name]
            let raw = (fromItem != nil && !(fromItem is NSNull)) ? fromItem : storeOverrides?[decl.name]
            out[decl.name] = resolve(decl, raw) ?? NSNull()
        }
        return out
    }
}
