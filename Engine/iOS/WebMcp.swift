//
//  WebMcp.swift - the platform-neutral half of WebMCP (proposals/webmcp.md), both directions.
//
//  Twin of `@despia/kernel/mcp` webmcp.ts and `:core WebMcp.kt`; all three run
//  OpenSource/Conformance/webmcp/{project,registry}.json, which is where the law actually
//  lives. Kernel-pure like JSE.swift and ApiBlock.swift: Foundation only, no UIKit, no
//  WebKit, no `document`. The `<tool>` row parses on every renderer and the page table's
//  law must be identical wherever a shell implements it, so the FOLD is shared and only the
//  browser-API spellings are per-platform.
//
//  OUTBOUND: a `<tool>` head row projected as a W3C WebMCP tool descriptor. The row names a
//  declared action and carries no schema of its own - the descriptor's `inputSchema` is
//  DERIVED from that action's declared inputs, exactly as `facets.mcp` derives from an
//  action's `args`. One contract, one place it can change.
//
//  INBOUND: the page tool table a shell keeps when a page registers through
//  `document.modelContext`. Policy-free: it records, validates and forgets.
//

import Foundation

public enum WebMcp {

    // MARK: - names

    /// The spec's tool-name grammar: 1...128 chars of ASCII alphanumeric plus `_`, `-`, `.`.
    public static func isValidToolName(_ name: String) -> Bool {
        guard !name.isEmpty, name.count <= 128 else { return false }
        for scalar in name.unicodeScalars {
            let ok = (scalar >= "a" && scalar <= "z")
                || (scalar >= "A" && scalar <= "Z")
                || (scalar >= "0" && scalar <= "9")
                || scalar == "_" || scalar == "-" || scalar == "."
            if !ok { return false }
        }
        return true
    }

    // MARK: - outbound: the projection

    /// One `<tool>` head row, verbatim. `as` is optional and defaults to `action`.
    public struct ToolRow {
        public let action: String
        public let description: String
        public let asName: String?
        public let mutates: String?

        public init(action: String, description: String, asName: String? = nil, mutates: String? = nil) {
            self.action = action
            self.description = description
            self.asName = asName
            self.mutates = mutates
        }
    }

    public struct Descriptor {
        public let name: String
        public let description: String
        /// Property names in declaration order; every property is the empty schema.
        public let inputs: [String]
        public let readOnlyHint: Bool

        /// The wire shape a browser adapter hands to `registerTool`.
        public func wire() -> [String: Any] {
            var properties: [String: Any] = [:]
            for input in inputs { properties[input] = [String: Any]() }
            var out: [String: Any] = [
                "name": name,
                "description": description,
                "inputSchema": ["type": "object", "properties": properties] as [String: Any],
            ]
            // A mutating tool emits NO annotations: the spec's default for readOnlyHint is
            // already false, and restating it is a second place for one fact to live.
            if readOnlyHint { out["annotations"] = ["readOnlyHint": true] as [String: Any] }
            return out
        }
    }

    public enum ProjectionErrorCode: String {
        case unknownAction = "unknown_action"
        case duplicateTool = "duplicate_tool"
        case invalidName = "invalid_name"
        case missingDescription = "missing_description"
    }

    public struct ProjectionError {
        public let code: ProjectionErrorCode
        public let name: String
        public let message: String
    }

    public struct Projection {
        public let descriptors: [Descriptor]
        public let errors: [ProjectionError]
    }

    /// The name a row projects under: `as` when given, the action name otherwise.
    public static func toolName(_ row: ToolRow) -> String {
        let given = (row.asName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return given.isEmpty ? row.action : given
    }

    /// Project a document's `<tool>` rows into WebMCP descriptors.
    ///
    /// `actionInputs` maps every action the document declares to its declared input names in
    /// declaration order. A row naming anything absent from that map is the stale-target
    /// class and comes back as an error the caller fails the build with.
    public static func project(rows: [ToolRow], actionInputs: [String: [String]]) -> Projection {
        var descriptors: [Descriptor] = []
        var errors: [ProjectionError] = []
        var seen = Set<String>()

        for row in rows {
            let name = toolName(row)
            if !isValidToolName(name) {
                errors.append(ProjectionError(
                    code: .invalidName, name: name,
                    message: "tool name \"\(name)\" must be 1 to 128 characters of ASCII letters, digits, \"_\", \"-\" or \".\""))
                continue
            }
            if seen.contains(name) {
                errors.append(ProjectionError(
                    code: .duplicateTool, name: name,
                    message: "tool \"\(name)\" is declared twice - the second registration would be refused by the browser and the tool would silently not exist"))
                continue
            }
            let description = row.description.trimmingCharacters(in: .whitespacesAndNewlines)
            if description.isEmpty {
                errors.append(ProjectionError(
                    code: .missingDescription, name: name,
                    message: "tool \"\(name)\" has an empty description - the description is the whole basis on which an agent chooses this tool"))
                continue
            }
            guard let inputs = actionInputs[row.action] else {
                errors.append(ProjectionError(
                    code: .unknownAction, name: row.action,
                    message: "tool \"\(name)\" names action \"\(row.action)\", which this document does not declare"))
                continue
            }
            seen.insert(name)
            let readOnly = (row.mutates ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            descriptors.append(Descriptor(name: name, description: description, inputs: inputs, readOnlyHint: readOnly))
        }
        return Projection(descriptors: descriptors, errors: errors)
    }

    // MARK: - inbound: the page tool table

    public struct PageTool {
        public let surface: String
        public let origin: String
        public let name: String
        public let description: String
        public let inputSchema: [String: Any]
        public let annotations: [String: Any]?

        /// DERIVED and always `required` in v1: a page vouching for its own tool is not
        /// evidence, so a recorded `readOnlyHint` never lowers the gate. The hint is kept
        /// because a consumer may weigh it; the decision is the consumer's.
        public var approval: String { "required" }
    }

    public enum RejectionReason: String {
        case invalidName = "invalid_name"
        case missingDescription = "missing_description"
        case duplicateName = "duplicate_name"
    }

    public struct Rejection {
        public let reason: RejectionReason
        public let name: String
    }

    /// The page tool table.
    ///
    /// Every mutation that changes the VISIBLE SET emits exactly one change for its surface;
    /// one that changes nothing emits none, because an event for an unchanged set is a lie a
    /// consumer acts on.
    public final class PageToolTable {
        private var rows: [PageTool] = []
        private let onChange: (String) -> Void

        public init(onChange: @escaping (String) -> Void = { _ in }) {
            self.onChange = onChange
        }

        /// Record one registration, or refuse it typed. Returns nil when it was recorded.
        @discardableResult
        public func register(
            surface: String,
            origin: String,
            name: String,
            description: String,
            inputSchema: [String: Any]? = nil,
            annotations: [String: Any]? = nil
        ) -> Rejection? {
            guard isValidToolName(name) else { return Rejection(reason: .invalidName, name: name) }
            guard !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return Rejection(reason: .missingDescription, name: name)
            }
            if rows.contains(where: { $0.surface == surface && $0.name == name }) {
                return Rejection(reason: .duplicateName, name: name)
            }
            rows.append(PageTool(
                surface: surface,
                origin: origin,
                name: name,
                description: description,
                // The page wrote the schema, so the page's schema is the contract and rides
                // through untouched. An ABSENT schema is normalized, which is a default
                // rather than a rewrite.
                inputSchema: inputSchema ?? ["type": "object", "properties": [String: Any]()],
                annotations: annotations
            ))
            onChange(surface)
            return nil
        }

        /// A navigation committed on this surface: every row the previous document
        /// registered is gone. A same-origin reload drops them too, because it is a NEW
        /// document whose callback registry the old rows named and no longer exists.
        @discardableResult
        public func commit(surface: String) -> Bool {
            drop(surface: surface) { $0.surface == surface }
        }

        /// The spec's unregister path: the AbortSignal passed at registration fired.
        @discardableResult
        public func abort(surface: String, name: String) -> Bool {
            drop(surface: surface) { $0.surface == surface && $0.name == name }
        }

        /// Every recorded row, in registration order; one surface's when named.
        public func tools(surface: String? = nil) -> [PageTool] {
            guard let surface else { return rows }
            return rows.filter { $0.surface == surface }
        }

        private func drop(surface: String, match: (PageTool) -> Bool) -> Bool {
            let before = rows.count
            rows.removeAll(where: match)
            let changed = rows.count != before
            if changed { onChange(surface) }
            return changed
        }
    }
}

/// The MCP result shaping a WebMCP tool call answers with - the Swift twin of the kernel's
/// `mcpToolResult` / `fallbackText` (packages/kernel/src/mcp/result.ts), pinned by
/// Conformance/webmcp/project.json.
///
/// A WebMCP agent and an MCP client must never be told different things about one call, so
/// the shape is the protocol's: a text `content` array that always carries something a model
/// can read, plus `structuredContent` for a host that wants the value itself.
public enum WebMcpResult {

    /// A resolved action value, MCP-shaped.
    public static func value(_ value: Any?) -> [String: Any] {
        shape(value: value, text: text(value), isError: false)
    }

    /// A thrown action is an error RESULT, never a transport failure: a rejection would tell
    /// the agent the call never happened. The text carries the id an operator can grep and
    /// never the exception, which may quote arguments the model supplied.
    public static func error(correlationId: String) -> [String: Any] {
        shape(value: nil, text: "tool failed (correlation \(correlationId))", isError: true)
    }

    private static func shape(value: Any?, text: String, isError: Bool) -> [String: Any] {
        var out: [String: Any] = [
            "content": [["type": "text", "text": text] as [String: Any]],
            "structuredContent": value ?? NSNull(),
        ]
        if isError { out["isError"] = true }
        return out
    }

    /// Deliberately plain and deterministic: a fallback, not a formatting engine.
    public static func text(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "(no result)" }
        if let s = value as? String { return s }
        if isBoolean(value) { return (value as? Bool) == true ? "true" : "false" }
        if let n = value as? NSNumber { return scalar(n) }
        if let list = value as? [Any] {
            if list.isEmpty { return "(no items)" }
            return list.enumerated().map { "\($0.offset + 1). \(text($0.element))" }.joined(separator: "\n")
        }
        if let map = value as? [String: Any] {
            if map.isEmpty { return "(empty)" }
            // Keys SORTED: a Swift dictionary has no order at all, so sorting is the only
            // ordering the three renderers can produce identically for one corpus.
            return map.sorted { $0.key < $1.key }
                .map { "\($0.key): \(scalarish($0.value))" }
                .joined(separator: "\n")
        }
        return "\(value)"
    }

    /// One level of nesting is summarized rather than exploded - a fallback stays readable.
    private static func scalarish(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "null" }
        if let list = value as? [Any] { return "[\(list.count) item\(list.count == 1 ? "" : "s")]" }
        if let map = value as? [String: Any] {
            let data = try? JSONSerialization.data(withJSONObject: map, options: [.sortedKeys])
            return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        }
        if isBoolean(value) { return (value as? Bool) == true ? "true" : "false" }
        if let n = value as? NSNumber { return scalar(n) }
        if let s = value as? String { return s }
        return "\(value)"
    }

    /// Is this value a genuine boolean?
    ///
    /// THE APPLE TRAP, pinned by Conformance/webmcp/project.json: an `NSNumber` holding 0 or
    /// 1 dynamic-casts to `Bool` on Darwin, so an ordinary `value as? Bool` renders the
    /// number 1 as "true" and a model reads a count as a flag. CoreFoundation's own type id
    /// is the only reliable discrimination there; on Linux, where nothing is toll-free
    /// bridged, `is Bool` already is one.
    private static func isBoolean(_ value: Any) -> Bool {
        #if canImport(Darwin)
        return CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
        #else
        return value is Bool
        #endif
    }

    /// JS `String(x)` for numbers: integral values carry no ".0".
    private static func scalar(_ n: NSNumber) -> String {
        let d = n.doubleValue
        if d.isNaN { return "NaN" }
        if d == Double.infinity { return "Infinity" }
        if d == -Double.infinity { return "-Infinity" }
        if d == d.rounded(.towardZero) && abs(d) < 1e21 { return String(Int64(d)) }
        return String(d)
    }
}
