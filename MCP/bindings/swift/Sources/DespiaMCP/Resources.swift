import Foundation

public enum MCPResourcePayload: Equatable, Sendable {
    case text(String)
    case blob(Data)
}

/// A resource declaration plus the read seam for that exact URI.
///
/// The declaration table is the allowlist. `resources/read` never turns an
/// arbitrary caller-provided URI into filesystem or network I/O.
public struct MCPServedResource {
    public let uri: String
    public let name: String
    public let description: String?
    public let mimeType: String?
    private let loader: () throws -> MCPResourcePayload

    public init(
        uri: String,
        name: String,
        description: String? = nil,
        mimeType: String? = nil,
        load: @escaping () throws -> MCPResourcePayload
    ) {
        self.uri = uri
        self.name = name
        self.description = description
        self.mimeType = mimeType
        self.loader = load
    }

    public func read() throws -> MCPResourcePayload {
        try loader()
    }

    func listed() -> JSONValue {
        var value: [String: JSONValue] = ["uri": .string(uri), "name": .string(name)]
        if let description { value["description"] = .string(description) }
        if let mimeType { value["mimeType"] = .string(mimeType) }
        return .object(value)
    }

    func content(_ payload: MCPResourcePayload) -> JSONValue {
        var value: [String: JSONValue] = ["uri": .string(uri)]
        if let mimeType { value["mimeType"] = .string(mimeType) }
        switch payload {
        case let .text(text):
            value["text"] = .string(text)
        case let .blob(data):
            value["blob"] = .string(data.base64EncodedString())
        }
        return .object(value)
    }
}
