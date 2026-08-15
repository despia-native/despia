public let mcpToolNamespace = "mcp"

public struct MCPDiscoveredTool: Equatable, Sendable {
    public let name: String
    public let description: String?
    public let inputSchema: JSONValue

    public init(name: String, description: String? = nil, inputSchema: JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
    }
}

public struct MCPToolDefinition: Equatable, Sendable {
    public let name: String
    public let description: String?
    public let parameters: JSONValue
    public let source: String
    public let server: String?

    public var provenance: String {
        source == "mcp" ? "\(mcpToolNamespace):\(server ?? "unknown")" : source
    }
}

/// The shared, insertion-ordered registry for tools discovered from peers.
public final class MCPToolRegistry {
    private var order: [String] = []
    private var entries: [String: MCPToolDefinition] = [:]
    private var serverOrder: [String] = []
    private var byServer: [String: [String]] = [:]

    public init() {}

    public func namespaced(server: String, tool: String) -> String {
        "\(mcpToolNamespace).\(server).\(tool)"
    }

    @discardableResult
    public func register(server: String, tools: [MCPDiscoveredTool]) -> [String] {
        remove(server: server)
        let names = tools.map { tool in
            let name = namespaced(server: server, tool: tool.name)
            order.append(name)
            entries[name] = MCPToolDefinition(
                name: name,
                description: tool.description,
                parameters: tool.inputSchema,
                source: "mcp",
                server: server
            )
            return name
        }
        if !names.isEmpty {
            byServer[server] = names
            serverOrder.append(server)
        }
        return names
    }

    public func remove(server: String) {
        let owned = Set(byServer.removeValue(forKey: server) ?? [])
        guard !owned.isEmpty else { return }
        serverOrder.removeAll { $0 == server }
        order.removeAll { owned.contains($0) }
        for name in owned { entries.removeValue(forKey: name) }
    }

    public func definition(_ name: String) -> MCPToolDefinition? { entries[name] }
    public func definitions() -> [MCPToolDefinition] { order.compactMap { entries[$0] } }
    public func names() -> [String] { order }
    public func serversWithTools() -> [String] { serverOrder }

    public func split(_ name: String) -> (server: String, tool: String)? {
        let prefix = "\(mcpToolNamespace)."
        guard name.hasPrefix(prefix) else { return nil }
        let rest = name.dropFirst(prefix.count)
        guard let cut = rest.firstIndex(of: "."), cut != rest.startIndex else { return nil }
        let toolStart = rest.index(after: cut)
        guard toolStart != rest.endIndex else { return nil }
        return (String(rest[..<cut]), String(rest[toolStart...]))
    }

    public func clear() {
        order.removeAll()
        serverOrder.removeAll()
        entries.removeAll()
        byServer.removeAll()
    }
}
