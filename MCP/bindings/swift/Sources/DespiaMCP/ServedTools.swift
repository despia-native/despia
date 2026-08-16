import Foundation

public struct ArgSpec: Equatable, Sendable {
    public let type: String
    public let required: Bool

    public init(_ type: String, required: Bool = false) {
        self.type = type
        self.required = required
    }
}

public struct ServedRow: Equatable, Sendable {
    public let action: String
    public let description: String
    public let args: [String: ArgSpec]
    public let mutates: String?

    public init(
        action: String,
        description: String,
        args: [String: ArgSpec] = [:],
        mutates: String? = nil
    ) {
        self.action = action
        self.description = description
        self.args = args
        self.mutates = mutates
    }

    public var requiresApproval: Bool {
        guard let mutates else { return false }
        return !mutates.isEmpty
    }
}

public enum ServedCatalog {
    public static func deriveSchema(_ args: [String: ArgSpec]) -> JSONValue {
        var properties: [String: JSONValue] = [:]
        var required: [JSONValue] = []
        for (name, spec) in args {
            properties[name] = .object(["type": .string(spec.type)])
            if spec.required { required.append(.string(name)) }
        }
        var schema: [String: JSONValue] = [
            "type": "object",
            "properties": .object(properties),
        ]
        if !required.isEmpty { schema["required"] = .array(required) }
        return .object(schema)
    }

    public static func toolList(_ rows: [ServedRow]) -> [JSONValue] {
        rows.map { row in
            var entry: [String: JSONValue] = [
                "name": .string(row.action),
                "description": .string(row.description),
                "inputSchema": deriveSchema(row.args),
            ]
            if let mutates = row.mutates, !mutates.isEmpty {
                entry["mutates"] = .string(mutates)
            }
            return .object(entry)
        }
    }

    public static func find(_ rows: [ServedRow], name: String) -> ServedRow? {
        rows.first { $0.action == name }
    }

    public static func validate(arguments: [String: JSONValue], for row: ServedRow) throws {
        for (name, spec) in row.args where spec.required && arguments[name] == nil {
            throw MCPProtocolFailure(
                code: -32602,
                message: "missing required argument \"\(name)\"",
                data: .object(["code": "invalid_arguments", "argument": .string(name)])
            )
        }
        for (name, value) in arguments {
            guard let spec = row.args[name] else { continue }
            guard accepts(value, as: spec.type) else {
                throw MCPProtocolFailure(
                    code: -32602,
                    message: "argument \"\(name)\" must be \(spec.type)",
                    data: .object(["code": "invalid_arguments", "argument": .string(name)])
                )
            }
        }
    }

    private static func accepts(_ value: JSONValue, as type: String) -> Bool {
        switch (type, value) {
        case ("string", .string), ("integer", .integer), ("boolean", .bool),
             ("object", .object), ("array", .array), ("null", .null):
            return true
        case ("number", .integer), ("number", .number):
            return true
        default:
            // Unknown schema vocabulary is advertised verbatim and left to the
            // action implementation rather than falsely narrowed here.
            return !["string", "integer", "number", "boolean", "object", "array", "null"].contains(type)
        }
    }
}
