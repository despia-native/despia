import Foundation
import XCTest
@testable import DespiaMCP

final class ProtocolTests: XCTestCase {
    func testParsesRequestWithoutCoercingItsIdentifier() throws {
        let request = try MCPRequestParser.parse(Data(#"{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"notes.search"}}"#.utf8))

        XCTAssertEqual(request.id, .integer(9_007_199_254_740_993))
        XCTAssertEqual(request.method, "tools/call")
        XCTAssertEqual(request.params["name"], "notes.search")
        XCTAssertFalse(request.isNotification)
    }

    func testNotificationHasNoIdentifier() throws {
        let request = try MCPRequestParser.parse(Data(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.utf8))
        XCTAssertTrue(request.isNotification)
    }

    func testMalformedJSONIsAParseError() {
        assertFailure(Data("{not json".utf8), code: -32700)
    }

    func testBatchIsAnInvalidRequest() {
        assertFailure(Data(#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#.utf8), code: -32600)
    }

    func testWrongProtocolVersionIsRefused() {
        assertFailure(Data(#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#.utf8), code: -32600)
    }

    func testParamsMustBeAnObject() {
        assertFailure(Data(#"{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}"#.utf8), code: -32602)
    }

    func testExcessiveNestingIsRefusedBeforeDecode() {
        let open = String(repeating: "[", count: MCPProtocolLimits.maximumJSONDepth + 1)
        let close = String(repeating: "]", count: MCPProtocolLimits.maximumJSONDepth + 1)
        assertFailure(Data((open + close).utf8), code: -32600)
    }

    func testOversizedBodyIsRefused() {
        let data = Data(repeating: 0x20, count: MCPProtocolLimits.maximumBodyBytes + 1)
        assertFailure(data, code: -32600)
    }

    func testJSONValueRejectsNonFiniteOutput() {
        XCTAssertThrowsError(try JSONValue.number(.infinity).encodedData())
    }

    private func assertFailure(_ data: Data, code: Int, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try MCPRequestParser.parse(data), file: file, line: line) { error in
            XCTAssertEqual((error as? MCPProtocolFailure)?.code, code, file: file, line: line)
        }
    }
}

final class CatalogAndRegistryTests: XCTestCase {
    private let search = ServedRow(
        action: "notes.search",
        description: "Search notes.",
        args: ["q": ArgSpec("string", required: true)]
    )

    func testToolSchemaIsDerivedFromTheRow() {
        let listed = ServedCatalog.toolList([search])
        let schema = listed[0].objectValue?["inputSchema"]?.objectValue

        XCTAssertEqual(schema?["type"], "object")
        XCTAssertEqual(schema?["properties"]?.objectValue?["q"]?.objectValue?["type"], "string")
        XCTAssertEqual(schema?["required"], .array(["q"]))
    }

    func testRequiredIsAbsentWhenNoArgumentIsRequired() {
        let schema = ServedCatalog.deriveSchema(["q": ArgSpec("string")]).objectValue
        XCTAssertNil(schema?["required"])
    }

    func testArgumentValidationPinsRequiredAndType() {
        XCTAssertThrowsError(try ServedCatalog.validate(arguments: [:], for: search))
        XCTAssertThrowsError(try ServedCatalog.validate(arguments: ["q": 4], for: search))
        XCTAssertNoThrow(try ServedCatalog.validate(arguments: ["q": "invoice"], for: search))
    }

    func testRegistryNamespacingPreservesBothServersAndSchemas() {
        let registry = MCPToolRegistry()
        let schema: JSONValue = ["type": "object", "oneOf": [["required": ["q"]]]]
        registry.register(server: "notes", tools: [.init(name: "search", description: "Notes", inputSchema: schema)])
        registry.register(server: "docs", tools: [.init(name: "search", description: "Docs", inputSchema: ["type": "object"])])

        XCTAssertEqual(registry.names(), ["mcp.notes.search", "mcp.docs.search"])
        XCTAssertEqual(registry.definition("mcp.notes.search")?.parameters, schema)
        XCTAssertEqual(registry.definition("mcp.notes.search")?.provenance, "mcp:notes")
    }

    func testRegistryReplacementAndPerServerRemovalLeaveNoGhosts() {
        let registry = MCPToolRegistry()
        registry.register(server: "notes", tools: [
            .init(name: "search", inputSchema: [:]),
            .init(name: "add", inputSchema: [:]),
        ])
        registry.register(server: "docs", tools: [.init(name: "fetch", inputSchema: [:])])
        registry.register(server: "notes", tools: [.init(name: "search", inputSchema: [:])])

        XCTAssertEqual(registry.names(), ["mcp.docs.fetch", "mcp.notes.search"])
        XCTAssertNil(registry.definition("mcp.notes.add"))
        registry.remove(server: "docs")
        XCTAssertEqual(registry.names(), ["mcp.notes.search"])
    }

    func testNamespacedNameSplitsOnlyAtTheServerBoundary() {
        let registry = MCPToolRegistry()
        let split = registry.split("mcp.notes.a.b")
        XCTAssertEqual(split?.server, "notes")
        XCTAssertEqual(split?.tool, "a.b")
        XCTAssertNil(registry.split("mcp.notes"))
        XCTAssertNil(registry.split("mcp..search"))
    }
}
