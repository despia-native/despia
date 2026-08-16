import Foundation

public let despiaMCPProtocolVersion = "2025-06-18"

public enum MCPProtocolLimits {
    public static let maximumBodyBytes = 1_048_576
    public static let maximumJSONDepth = 64
}

public struct MCPRequest: Equatable, Sendable {
    public let id: JSONValue?
    public let method: String
    public let params: [String: JSONValue]

    public var isNotification: Bool {
        id == nil || id == .null
    }
}

public struct MCPProtocolFailure: Error, Equatable, Sendable {
    public let code: Int
    public let message: String
    public let id: JSONValue?
    public let data: JSONValue?

    public init(code: Int, message: String, id: JSONValue? = nil, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.id = id
        self.data = data
    }
}

/// Strict JSON-RPC request parsing with explicit size and nesting limits.
public enum MCPRequestParser {
    public static func parse(_ data: Data) throws -> MCPRequest {
        guard data.count <= MCPProtocolLimits.maximumBodyBytes else {
            throw MCPProtocolFailure(code: -32600, message: "request body exceeds the MCP limit")
        }
        try validateNesting(in: data)

        let decoded: JSONValue
        do {
            decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw MCPProtocolFailure(code: -32700, message: "the request body is not JSON")
        }

        guard case let .object(message) = decoded else {
            throw MCPProtocolFailure(code: -32600, message: "a JSON-RPC message is an object")
        }
        let id = message["id"]
        guard message["jsonrpc"] == .string("2.0") else {
            throw MCPProtocolFailure(code: -32600, message: "jsonrpc must be \"2.0\"", id: id)
        }
        guard let method = message["method"]?.stringValue, !method.isEmpty else {
            throw MCPProtocolFailure(code: -32600, message: "a JSON-RPC request names a method", id: id)
        }

        let params: [String: JSONValue]
        if let raw = message["params"] {
            guard case let .object(value) = raw else {
                throw MCPProtocolFailure(code: -32602, message: "params must be an object", id: id)
            }
            params = value
        } else {
            params = [:]
        }
        return MCPRequest(id: id, method: method, params: params)
    }

    /// Reject excessive structural depth before invoking Foundation's decoder.
    private static func validateNesting(in data: Data) throws {
        var depth = 0
        var inString = false
        var escaped = false
        for byte in data {
            if inString {
                if escaped {
                    escaped = false
                } else if byte == 0x5c {
                    escaped = true
                } else if byte == 0x22 {
                    inString = false
                }
                continue
            }
            if byte == 0x22 {
                inString = true
            } else if byte == 0x7b || byte == 0x5b {
                depth += 1
                if depth > MCPProtocolLimits.maximumJSONDepth {
                    throw MCPProtocolFailure(code: -32600, message: "request nests deeper than the MCP limit")
                }
            } else if byte == 0x7d || byte == 0x5d {
                depth -= 1
                if depth < 0 {
                    throw MCPProtocolFailure(code: -32700, message: "the request body is not JSON")
                }
            }
        }
    }
}

enum MCPEnvelope {
    static func result(id: JSONValue?, value: JSONValue) -> JSONValue {
        .object([
            "jsonrpc": "2.0",
            "id": id ?? .null,
            "result": value,
        ])
    }

    static func failure(_ failure: MCPProtocolFailure) -> JSONValue {
        var error: [String: JSONValue] = [
            "code": .integer(Int64(failure.code)),
            "message": .string(failure.message),
        ]
        if let data = failure.data { error["data"] = data }
        return .object([
            "jsonrpc": "2.0",
            "id": failure.id ?? .null,
            "error": .object(error),
        ])
    }
}
