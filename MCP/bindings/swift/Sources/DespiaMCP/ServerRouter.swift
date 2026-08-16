import Foundation

public enum MCPPrincipal: Equatable, Sendable {
    case session
    case pairing
}

public struct MCPApprovalRequest: Equatable, Sendable {
    public let tool: String
    public let arguments: [String: JSONValue]
    public let mutates: String
    public let principal: MCPPrincipal
}

public enum MCPApprovalDecision: Equatable, Sendable {
    case approve
    case deny
}

public enum MCPCodes {
    public static let unknownTool = "unknown_tool"
    public static let unknownResource = "unknown_resource"
    public static let toolDenied = "tool_denied"
    public static let approvalUnavailable = "approval_unavailable"
    public static let snapshotUnavailable = "snapshot_unavailable"
    public static let snapshotFailed = "snapshot_failed"
    public static let invalidArguments = "invalid_arguments"
}

public typealias MCPDispatcher = (_ tool: String, _ arguments: [String: JSONValue]) throws -> JSONValue
public typealias MCPApprover = (_ request: MCPApprovalRequest) throws -> MCPApprovalDecision
public typealias MCPSnapshotter = (_ scope: String) throws -> Void

/// Protocol-complete in-process request router for a declared MCP server.
///
/// A host transport performs its origin/host/token checks first, then gives the
/// authenticated body to this router. Keeping parsing, validation and dispatch
/// together makes it impossible for a transport to bypass the declared row or
/// approval path.
public final class DespiaMCPServerRouter {
    private let rows: [ServedRow]
    private let resources: [MCPServedResource]
    private let dispatcher: MCPDispatcher
    private let approver: MCPApprover?
    private let snapshotter: MCPSnapshotter?
    private let serverName: String
    private let serverVersion: String

    public init(
        rows: [ServedRow],
        resources: [MCPServedResource] = [],
        dispatcher: @escaping MCPDispatcher,
        approver: MCPApprover? = nil,
        snapshotter: MCPSnapshotter? = nil,
        serverName: String = "despia-mcp",
        serverVersion: String = "0.1.0"
    ) {
        self.rows = rows
        self.resources = resources
        self.dispatcher = dispatcher
        self.approver = approver
        self.snapshotter = snapshotter
        self.serverName = serverName
        self.serverVersion = serverVersion
    }

    /// Returns nil for notifications; all requests receive a JSON-RPC envelope.
    public func handle(_ data: Data, principal: MCPPrincipal = .session) -> Data? {
        let request: MCPRequest
        do {
            request = try MCPRequestParser.parse(data)
        } catch let failure as MCPProtocolFailure {
            return encoded(MCPEnvelope.failure(failure))
        } catch {
            return encoded(MCPEnvelope.failure(.init(code: -32700, message: "the request body is not JSON")))
        }

        if request.isNotification { return nil }

        do {
            return encoded(MCPEnvelope.result(id: request.id, value: try dispatch(request, principal: principal)))
        } catch var failure as MCPProtocolFailure {
            if failure.id == nil {
                failure = MCPProtocolFailure(
                    code: failure.code,
                    message: failure.message,
                    id: request.id,
                    data: failure.data
                )
            }
            return encoded(MCPEnvelope.failure(failure))
        } catch {
            return encoded(MCPEnvelope.failure(.init(
                code: -32603,
                message: error.localizedDescription,
                id: request.id
            )))
        }
    }

    public func tools() -> [JSONValue] { ServedCatalog.toolList(rows) }
    public func resourceList() -> [JSONValue] { resources.map { $0.listed() } }

    private func dispatch(_ request: MCPRequest, principal: MCPPrincipal) throws -> JSONValue {
        switch request.method {
        case "initialize":
            return .object([
                "protocolVersion": .string(despiaMCPProtocolVersion),
                "capabilities": .object([
                    "tools": .object(["listChanged": false]),
                    "resources": .object(["listChanged": false, "subscribe": false]),
                ]),
                "serverInfo": .object(["name": .string(serverName), "version": .string(serverVersion)]),
            ])
        case "ping":
            return .object([:])
        case "tools/list":
            return .object(["tools": .array(tools())])
        case "tools/call":
            return try callTool(request, principal: principal)
        case "resources/list":
            return .object(["resources": .array(resourceList())])
        case "resources/read":
            return try readResource(request)
        default:
            throw MCPProtocolFailure(code: -32601, message: "unknown method \"\(request.method)\"", id: request.id)
        }
    }

    private func callTool(_ request: MCPRequest, principal: MCPPrincipal) throws -> JSONValue {
        guard let name = request.params["name"]?.stringValue else {
            throw MCPProtocolFailure(code: -32602, message: "tools/call needs a tool name", id: request.id)
        }
        let arguments: [String: JSONValue]
        if let raw = request.params["arguments"] {
            guard case let .object(value) = raw else {
                throw MCPProtocolFailure(code: -32602, message: "tool arguments must be an object", id: request.id)
            }
            arguments = value
        } else {
            arguments = [:]
        }

        guard let row = ServedCatalog.find(rows, name: name) else {
            throw codedFailure(-32602, "no such tool", MCPCodes.unknownTool, id: request.id)
        }
        do {
            try ServedCatalog.validate(arguments: arguments, for: row)
        } catch var failure as MCPProtocolFailure {
            failure = MCPProtocolFailure(code: failure.code, message: failure.message, id: request.id, data: failure.data)
            throw failure
        }

        if row.requiresApproval {
            let scope = row.mutates ?? ""
            guard let approver else {
                throw codedFailure(-32000, "this tool writes and nothing can approve it", MCPCodes.approvalUnavailable, id: request.id)
            }
            let requestToApprove = MCPApprovalRequest(
                tool: name,
                arguments: arguments,
                mutates: scope,
                principal: principal
            )
            let decision = (try? approver(requestToApprove)) ?? .deny
            guard decision == .approve else {
                throw codedFailure(-32000, "the write was not approved", MCPCodes.toolDenied, id: request.id)
            }
            guard let snapshotter else {
                throw codedFailure(-32000, "this tool writes and nothing can snapshot it", MCPCodes.snapshotUnavailable, id: request.id)
            }
            do {
                try snapshotter(scope)
            } catch {
                throw codedFailure(-32000, error.localizedDescription, MCPCodes.snapshotFailed, id: request.id)
            }
        }

        do {
            return try toolResult(dispatcher(name, arguments), isError: false)
        } catch {
            return try toolResult(.string(error.localizedDescription), isError: true)
        }
    }

    private func readResource(_ request: MCPRequest) throws -> JSONValue {
        guard let uri = request.params["uri"]?.stringValue else {
            throw MCPProtocolFailure(code: -32602, message: "resources/read needs a URI", id: request.id)
        }
        guard let resource = resources.first(where: { $0.uri == uri }) else {
            throw codedFailure(-32602, "no such resource", MCPCodes.unknownResource, id: request.id)
        }
        do {
            return .object(["contents": .array([resource.content(try resource.read())])])
        } catch {
            throw MCPProtocolFailure(code: -32603, message: error.localizedDescription, id: request.id)
        }
    }

    private func toolResult(_ produced: JSONValue, isError: Bool) throws -> JSONValue {
        let text: String
        if case let .string(value) = produced {
            text = value
        } else if produced == .null {
            text = ""
        } else {
            text = try produced.encodedString()
        }
        var result: [String: JSONValue] = [
            "content": .array([.object(["type": "text", "text": .string(text)])]),
        ]
        if case .object = produced { result["structuredContent"] = produced }
        if isError { result["isError"] = true }
        return .object(result)
    }

    private func codedFailure(_ rpcCode: Int, _ message: String, _ code: String, id: JSONValue?) -> MCPProtocolFailure {
        MCPProtocolFailure(
            code: rpcCode,
            message: message,
            id: id,
            data: .object(["code": .string(code)])
        )
    }

    private func encoded(_ value: JSONValue) -> Data {
        // Every value reaching this point has already been constrained to the
        // finite JSON vocabulary, so encoding failure is not recoverable state.
        (try? value.encodedData()) ?? Data("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"response encoding failed\"}}".utf8)
    }
}
