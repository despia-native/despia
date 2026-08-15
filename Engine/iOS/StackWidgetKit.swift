//
//  StackWidgetKit.swift — widget-safe Stack renderer (WidgetKit / Live Activities)
//
//  Renders a Stack XML template + a data dictionary into WidgetKit-SAFE SwiftUI
//  — the snapshot counterpart to the live `dsx.stack.render` app engine. Same XML
//  grammar (`{{ binding }}`, stacks, text, image, gauges), restricted to the
//  subset WidgetKit / ActivityKit allow (no scroll/list/video/representable; no
//  live store — a widget is a snapshot of already-resolved values).
//
//  USAGE (in a widget / Live Activity view, in the extension target):
//
//      // home-screen / lock-screen widget TimelineEntry → view
//      StackWidgetView(xml: entry.template, data: entry.data)
//
//      // Live Activity (ActivityKit)
//      StackWidgetView(xml: context.attributes.template,
//                    data: StackWidgetData.decode(context.state.data))
//
//  DATA gets there via the shared App Group (PR #492's `dsx.container`): the app
//  writes `widget.<id>.template` (XML) + `widget.<id>.data` (JSON), `post()`s, and
//  the extension reads it on timeline reload / Activity update. See WIDGETS.md.
//
//  This file is app-target-safe (pure SwiftUI). To RENDER inside the ImageWidget /
//  ActivityKit extensions, add it (or a copy) to those targets — see WIDGETS.md.
//  It leans on ONE StackLive.swift symbol — StackBackend.isColumn, the shared
//  column-axis predicate (primitives in, so this file's own StackWNode model passes
//  its raw attrs) — and every widget/activity target compiles StackLive.swift by its
//  runtime tier ('live'), so the pairing always travels together.
//

import SwiftUI
import Foundation

// MARK: - Public entry

/// A WidgetKit-safe view rendered from a Stack XML string + data dictionary.
public struct StackWidgetView: View {
    private let root: StackWNode?
    private let data: [String: Any]

    public init(xml: String, data: [String: Any] = [:]) {
        self.root = StackWXML.parse(xml)
        self.data = data
    }
    /// Convenience: read template + data straight from the shared App Group.
    /// App-side callers should pass `dsx.container.group` (dynamic). The literal
    /// default is the **extension** fallback: a widget/Live-Activity extension is a
    /// separate process with no `dsx`, and can't derive the *app's* App Group from
    /// its own bundle id — so it needs the reserved id (also in its entitlements).
    public init(widgetId: String, appGroup: String = "group.com.despia.despiaadmin.container") {
        let d = UserDefaults(suiteName: appGroup)
        self.root = (d?.string(forKey: "widget.\(widgetId).template")).flatMap(StackWXML.parse)
        self.data = (d?.string(forKey: "widget.\(widgetId).data")).flatMap(StackWidgetData.decode) ?? [:]
    }

    public var body: some View {
        if let root { StackWNodeView(node: root, data: data) }
        else { EmptyView() }
    }
}

/// JSON <-> dictionary helpers for the App Group / ActivityKit ContentState.
public enum StackWidgetData {
    public static func decode(_ json: String) -> [String: Any] {
        guard let d = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return obj
    }
    public static func encode(_ dict: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}

// MARK: - Node + parser (self-contained; same grammar as dsx.stack)

struct StackWNode {
    let tag: String
    let attrs: [String: String]
    let children: [StackWNode]
}

enum StackWXML {
    static func parse(_ xml: String) -> StackWNode? {
        let p = XMLParser(data: Data(xml.utf8)); let d = Delegate(); p.delegate = d
        return p.parse() ? d.root : nil
    }
    private final class Delegate: NSObject, XMLParserDelegate {
        var root: StackWNode?
        private var stack: [(String, [String: String], [StackWNode])] = []
        func parser(_ p: XMLParser, didStartElement el: String, namespaceURI: String?,
                    qualifiedName q: String?, attributes a: [String: String]) {
            stack.append((el, a, []))
        }
        func parser(_ p: XMLParser, didEndElement el: String, namespaceURI: String?, qualifiedName q: String?) {
            guard let (tag, attrs, kids) = stack.popLast() else { return }
            let node = StackWNode(tag: tag, attrs: attrs, children: kids)
            if stack.isEmpty { root = node } else { stack[stack.count - 1].2.append(node) }
        }
    }
}

// MARK: - Renderer (widget-safe subset)

struct StackWNodeView: View {
    let node: StackWNode
    let data: [String: Any]

    var body: some View {
        StackWStyle.apply(raw(), attrs: node.attrs)
    }

    private var childrenView: some View {
        ForEach(node.children.indices, id: \.self) { i in
            StackWNodeView(node: node.children[i], data: data)
        }
    }

    private func raw() -> AnyView {
        let a = node.attrs
        switch node.tag {
        case "vstack": return AnyView(VStack(alignment: .leading, spacing: num(a["spacing"])) { childrenView })
        case "hstack": return AnyView(HStack(alignment: .center, spacing: num(a["spacing"])) { childrenView })
        case "zstack": return AnyView(ZStack { childrenView })
        case "stack":
            // The generic container, ATTRIBUTE form only — snapshot surfaces
            // have no CSS engine (same contract as StackLive's element):
            // flexDirection picks the axis (column default — the SHARED predicate,
            // StackBackend.isColumn, over this node model's raw attrs), display="grid"
            // overlaps, gap must arrive as a plain `spacing`. Web default 0.
            if a["display"] == "grid" { return AnyView(ZStack { childrenView }) }
            if StackBackend.isColumn(tag: node.tag, display: a["display"],
                                     flexDirection: a["flexDirection"]) {
                return AnyView(VStack(alignment: .leading, spacing: num(a["spacing"]) ?? 0) { childrenView })
            }
            return AnyView(HStack(alignment: .center, spacing: num(a["spacing"]) ?? 0) { childrenView })
        case "spacer": return AnyView(Spacer())
        case "divider":
            let line = a["color"].map { StackWStyle.color(interp($0)) } ?? Color.secondary.opacity(0.25)
            return AnyView(
                Rectangle()
                    .fill(line)
                    .frame(height: 0.5)
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
            )
        case "text", "label":
            return AnyView(Text(interp(a["bind"].map { "{{\($0)}}" } ?? a["value"] ?? textOf(node)))
                .foregroundColor(StackWStyle.color(interp(a["color"] ?? "primary"))))
        case "image":
            return AnyView(imageView(a))
        case "gauge", "progress":
            return AnyView(progressView(a))
        case "capsuleProgress":
            return AnyView(capsuleProgress(a))
        default:
            return AnyView(childrenView)
        }
    }

    @ViewBuilder private func imageView(_ a: [String: String]) -> some View {
        if let icon = a["icon"].map(interp) {
            Image(systemName: icon).foregroundColor(StackWStyle.color(interp(a["color"] ?? "primary")))
        } else { Color.clear }
    }

    private func progressView(_ a: [String: String]) -> some View {
        let v = dnum(interp(a["bind"].map { "{{\($0)}}" } ?? a["value"] ?? "0")) ?? 0
        return ProgressView(value: max(0, min(1, v)))
            .tint(StackWStyle.color(interp(a["color"] ?? "accent")))
    }

    private func capsuleProgress(_ a: [String: String]) -> some View {
        let v = CGFloat(max(0, min(1, dnum(interp(a["bind"].map { "{{\($0)}}" } ?? a["value"] ?? "0")) ?? 0)))
        let tint = StackWStyle.color(interp(a["color"] ?? "accent"))
        return GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(tint.opacity(0.2))
                Capsule().fill(tint).frame(width: g.size.width * v)
            }
        }
        .frame(height: num(a["height"]) ?? 6)
    }

    // MARK: bindings

    private func textOf(_ n: StackWNode) -> String { "" }
    private func interp(_ s: String) -> String { StackWExpr.interpolate(s, data: data) }
    private func num(_ s: String?) -> CGFloat? { s.flatMap { Double($0) }.map { CGFloat($0) } }
    private func dnum(_ s: String) -> Double? { Double(s) }
}

// MARK: - Bindings (interpolation + ternary; no JS)

enum StackWExpr {
    static func interpolate(_ s: String, data: [String: Any]) -> String {
        guard s.contains("{{") else { return s }
        var out = ""; var rest = Substring(s)
        while let open = rest.range(of: "{{") {
            out += rest[..<open.lowerBound]
            guard let close = rest.range(of: "}}", range: open.upperBound..<rest.endIndex) else {
                return out + rest[open.lowerBound...]
            }
            out += string(eval(String(rest[open.upperBound..<close.lowerBound]), data: data))
            rest = rest[close.upperBound...]
        }
        return out + rest
    }
    static func eval(_ raw: String, data: [String: Any]) -> Any? {
        let e = raw.trimmingCharacters(in: .whitespaces)
        if let q = e.firstIndex(of: "?"), let c = e.firstIndex(of: ":"), q < c {
            return truthy(eval(String(e[..<q]), data: data))
                ? eval(String(e[e.index(after: q)..<c]), data: data)
                : eval(String(e[e.index(after: c)...]), data: data)
        }
        if (e.hasPrefix("'") && e.hasSuffix("'")) { return String(e.dropFirst().dropLast()) }
        if let n = Double(e) { return n }
        if e == "true" { return true }; if e == "false" { return false }
        var cur: Any? = data
        for p in e.split(separator: ".") {
            let seg = String(p)
            // Mirror Stack.swift's resolver: numeric segment → array index (bounds-checked).
            if let i = Int(seg), let arr = cur as? [Any] { cur = (i >= 0 && i < arr.count) ? arr[i] : nil }
            else { cur = (cur as? [String: Any])?[seg] }
        }
        return cur
    }
    static func truthy(_ v: Any?) -> Bool {
        switch v { case let b as Bool: return b; case let s as String: return !s.isEmpty
        case let n as NSNumber: return n.doubleValue != 0; case .some: return true; case .none: return false }
    }
    static func string(_ v: Any?) -> String {
        switch v {
        case let s as String: return s
        case let n as NSNumber: return n.doubleValue == n.doubleValue.rounded() ? String(Int(n.doubleValue)) : "\(n.doubleValue)"
        case .some(let x): return "\(x)"; case .none: return "" }
    }
}

// MARK: - Style (widget-safe)

enum StackWStyle {
    static func apply(_ view: AnyView, attrs a: [String: String]) -> AnyView {
        var v = view
        let num: (String?) -> CGFloat? = { $0.flatMap { Double($0) }.map { CGFloat($0) } }
        if let fs = num(a["fontSize"]) { v = AnyView(v.font(.system(size: fs, weight: weight(a["fontWeight"])))) }
        if let p = num(a["padding"]) { v = AnyView(v.padding(p)) }
        if let bg = a["background"] {
            let r = num(a["radius"]) ?? 0
            v = AnyView(v.background(RoundedRectangle(cornerRadius: r, style: .continuous).fill(color(bg))))
        }
        if let o = num(a["opacity"]) { v = AnyView(v.opacity(Double(o))) }
        if let h = num(a["height"]) { v = AnyView(v.frame(height: h)) }
        return v
    }
    static func weight(_ s: String?) -> Font.Weight {
        switch s { case "bold": return .bold; case "semibold": return .semibold
        case "medium": return .medium; case "heavy": return .heavy; default: return .regular }
    }
    static func color(_ s: String) -> Color {
        switch s {
        case "primary": return .primary; case "secondary": return .secondary
        case "white": return .white; case "black": return .black
        case "accent": return .accentColor; case "clear": return .clear
        default: break
        }
        if s.hasPrefix("rgba(") || s.hasPrefix("rgb(") {
            let n = s.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }
                .split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) ?? 0 }
            if n.count >= 3 { return Color(.sRGB, red: n[0]/255, green: n[1]/255, blue: n[2]/255, opacity: n.count > 3 ? n[3] : 1) }
        }
        var hex = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if hex.count == 6 { hex = "FF" + hex }
        if hex.count == 8, let v = UInt64(hex, radix: 16) {
            return Color(.sRGB, red: Double((v >> 16) & 0xFF)/255, green: Double((v >> 8) & 0xFF)/255,
                         blue: Double(v & 0xFF)/255, opacity: Double((v >> 24) & 0xFF)/255)
        }
        return .primary
    }
}
