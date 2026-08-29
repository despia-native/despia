//
//  SplitPlan.swift — the `<split>` planning contract, Swift twin (component-library.md W9).
//
//  The law and the reasoning live in OpenSource/Conformance/split/README.md; the cases live in
//  split.json and run against THIS file (SplitConformance, record lane), against the TS twin
//  (packages/dom/src/split.ts) and against the Kotlin twin (:core SplitPlan.kt).
//
//  Everything here is pure: attributes + per-child pane roles + the container width in, the
//  resolved plan out. The presentation work — NavigationSplitView, the pushed detail, the
//  overlay sidebar — belongs to the Foundation Structure/Split component; the platform host
//  owns the visual collapse and this plan is its semantic twin, which is what lets one corpus
//  judge three runtimes. Foundation-only by contract.
//

import Foundation

public enum SplitPlan {
    public enum Role: String {
        case sidebar
        case content
        case detail
    }

    public struct Widths: Equatable {
        public let min: Double
        public let ideal: Double
        public let max: Double

        public init(_ min: Double, _ ideal: Double, _ max: Double) {
            self.min = min
            self.ideal = ideal
            self.max = max
        }
    }

    public struct Plan: Equatable {
        public let panes: Int
        public let roles: [Role]
        public let presentation: String   // "stack" | "columns"
        public let columns: [Role]
        public let host: Role
        public let overlay: Bool
        public let detail: Bool
        public let resizable: Bool
        public let collapseAt: Double
        public let expandAt: Double
        public let sidebar: Widths
        public let content: Widths
        public let detailMin: Double
    }

    public static let defaultCollapseAt = 760.0
    public static let defaultExpandAt = 1104.0
    public static let defaultSidebar = Widths(220, 280, 360)
    public static let defaultContent = Widths(280, 340, 480)
    public static let defaultDetailMin = 360.0
    static let roleOrder: [Role] = [.sidebar, .content, .detail]

    /// Per-child role resolution: an explicit, valid `paneRole` wins (first claimant keeps a
    /// duplicated role); everything else fills positionally from the remaining canonical roles
    /// for the pane count. Total by construction — corpus `cases[].roles`.
    public static func resolveRoles(_ childRoles: [String?]) -> [Role] {
        let bounded = childRoles.prefix(3)
        var taken = Set<Role>()
        let kept: [Role?] = bounded.map { raw in
            let word = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            guard let role = Role(rawValue: word), !taken.contains(role) else { return nil }
            taken.insert(role)
            return role
        }
        let order: [Role] = bounded.count == 1 ? [.content]
            : bounded.count == 2 ? [.sidebar, .detail]
            : roleOrder
        var pool = order.filter { !taken.contains($0) }
        return kept.map { role in
            if let role { return role }
            return pool.isEmpty ? .content : pool.removeFirst()
        }
    }

    /// The shared planner — the fixture is OpenSource/Conformance/split/split.json (the TS and
    /// Kotlin twins run the same file). Width is the split's own container, not the screen.
    public static func resolve(attrs: [String: String], childRoles: [String?], width: Double) -> Plan {
        let roles = resolveRoles(childRoles)
        let collapseAt = number(attrs["collapseAt"], defaultCollapseAt, 320, 4096)
        let expandAt = max(collapseAt, number(attrs["expandAt"], defaultExpandAt, 320, 4096))
        let boundedWidth = width.isFinite ? max(0, width) : 0
        let hasSidebar = roles.contains(.sidebar)
        let hasContent = roles.contains(.content)
        let hasDetail = roles.contains(.detail)
        let host: Role = hasContent ? .content : hasSidebar ? .sidebar : hasDetail ? .detail : .content
        let presentation = boundedWidth < collapseAt ? "stack" : "columns"
        let columns: [Role] = presentation == "stack" ? [] : roleOrder.filter { role in
            guard roles.contains(role) else { return false }
            return !(role == .sidebar && roles.count == 3 && boundedWidth < expandAt)
        }
        let overlay = hasSidebar
            && (presentation == "stack" ? host != .sidebar : !columns.contains(.sidebar))
        let authoredResizable = (attrs["resizable"] ?? "true")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "false"
        return Plan(
            panes: roles.count,
            roles: roles,
            presentation: presentation,
            columns: columns,
            host: host,
            overlay: overlay,
            detail: hasDetail,
            resizable: authoredResizable && presentation == "columns" && columns.count >= 2,
            collapseAt: collapseAt,
            expandAt: expandAt,
            sidebar: widths(attrs, "sidebar", defaultSidebar),
            content: widths(attrs, "content", defaultContent),
            detailMin: number(attrs["detailMin"], defaultDetailMin, 120, 1024))
    }

    /// Selection routing: is a detail selected? nil/false/blank = none; anything else
    /// (stringified) is active, so numeric ids like 0 stay selectable — corpus `selection`.
    /// A REAL boolean is only the CFBoolean singleton (the JSE.swift rule): a bare `as? Bool`
    /// on Darwin would also match NSNumber 0/1 and drop the selectable id 0.
    public static func selectionActive(_ value: Any?) -> Bool {
        guard let value, !(value is NSNull) else { return false }
        if let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
        let text: String
        if let s = value as? String { text = s }
        else if let n = value as? NSNumber { text = n.stringValue }
        else { text = String(describing: value) }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func widths(_ attrs: [String: String], _ prefix: String, _ defaults: Widths) -> Widths {
        let minimum = number(attrs["\(prefix)Min"], defaults.min, 120, 1024)
        let ideal = max(minimum, number(attrs["\(prefix)Ideal"], defaults.ideal, 120, 1600))
        let maximum = max(ideal, number(attrs["\(prefix)Max"], defaults.max, 120, 1600))
        return Widths(minimum, ideal, maximum)
    }

    /// The adaptive-scaffold number grammar: trimmed decimal literal, else the fallback;
    /// clamped into the shared bounds. NaN/Infinity spellings are not decimal literals.
    private static func number(_ raw: String?, _ fallback: Double, _ lower: Double, _ upper: Double) -> Double {
        var value = fallback
        if let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
           text.range(of: #"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"#,
                      options: .regularExpression) != nil,
           let parsed = Double(text), parsed.isFinite {
            value = parsed
        }
        return Swift.min(upper, Swift.max(lower, value))
    }
}
