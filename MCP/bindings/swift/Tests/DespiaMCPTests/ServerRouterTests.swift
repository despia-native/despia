import Foundation
import XCTest
@testable import DespiaMCP

final class ServerRouterTests: XCTestCase {
    private var rows: [ServedRow] {
        [
            ServedRow(
                action: "notes.search",
                description: "Search notes.",
                args: ["q": ArgSpec("string", required: true)]
            ),
            ServedRow(
                action: "notes.add",
                description: "Add a note.",
                args: ["text": ArgSpec("string", required: true)],
                mutates: "base"
            ),
        ]
    }

    func testInitializeAdvertisesToolsAndResources() throws {
        let router = makeRouter()
        let result = try result(router, id: 1, method: "initialize")

        XCTAssertEqual(result["protocolVersion"], .string(despiaMCPProtocolVersion))
        XCTAssertNotNil(result["capabilities"]?.objectValue?["tools"])
        XCTAssertNotNil(result["capabilities"]?.objectValue?["resources"])
    }

    func testToolsListComesOnlyFromDeclaredRows() throws {
        let result = try result(makeRouter(), id: 2, method: "tools/list")
        let tools = result["tools"]?.arrayValue ?? []

        XCTAssertEqual(tools.map { $0.objectValue?["name"] }, ["notes.search", "notes.add"])
        XCTAssertNil(tools[0].objectValue?["mutates"])
        XCTAssertEqual(tools[1].objectValue?["mutates"], "base")
    }

    func testReadToolValidatesThenDispatchesStructuredContent() throws {
        var calls: [(String, [String: JSONValue])] = []
        let router = makeRouter(dispatcher: { name, arguments in
            calls.append((name, arguments))
            return ["ok": true, "tool": .string(name)]
        })
        let result = try result(
            router,
            id: 3,
            method: "tools/call",
            params: ["name": "notes.search", "arguments": ["q": "invoice"]]
        )

        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].0, "notes.search")
        XCTAssertEqual(calls[0].1, ["q": "invoice"])
        XCTAssertEqual(result["structuredContent"], ["ok": true, "tool": "notes.search"])
    }

    func testInvalidArgumentsNeverReachDispatcher() throws {
        var dispatched = false
        let router = makeRouter(dispatcher: { _, _ in dispatched = true; return .null })
        let error = try failure(
            router,
            id: 4,
            method: "tools/call",
            params: ["name": "notes.search", "arguments": ["q": 7]]
        )

        XCTAssertEqual(error["code"], -32602)
        XCTAssertEqual(error["data"]?.objectValue?["code"], "invalid_arguments")
        XCTAssertFalse(dispatched)
    }

    func testWriteIsApprovedSnapshottedAndDispatchedInOrder() throws {
        var order: [String] = []
        let router = makeRouter(
            dispatcher: { name, _ in order.append("dispatch:\(name)"); return "done" },
            approver: { request in order.append("approve:\(request.tool)"); return .approve },
            snapshotter: { scope in order.append("snapshot:\(scope)") }
        )
        _ = try result(
            router,
            id: 5,
            method: "tools/call",
            params: ["name": "notes.add", "arguments": ["text": "hello"]]
        )

        XCTAssertEqual(order, ["approve:notes.add", "snapshot:base", "dispatch:notes.add"])
    }

    func testWriteFailsClosedWithoutApprover() throws {
        var dispatched = false
        let router = makeRouter(dispatcher: { _, _ in dispatched = true; return .null })
        let error = try failure(
            router,
            id: 6,
            method: "tools/call",
            params: ["name": "notes.add", "arguments": ["text": "hello"]]
        )

        XCTAssertEqual(error["data"]?.objectValue?["code"], "approval_unavailable")
        XCTAssertFalse(dispatched)
    }

    func testDeniedWriteNeverSnapshotsOrDispatches() throws {
        var order: [String] = []
        let router = makeRouter(
            dispatcher: { _, _ in order.append("dispatch"); return .null },
            approver: { _ in order.append("approve"); return .deny },
            snapshotter: { _ in order.append("snapshot") }
        )
        let error = try failure(
            router,
            id: 7,
            method: "tools/call",
            params: ["name": "notes.add", "arguments": ["text": "hello"]]
        )

        XCTAssertEqual(error["data"]?.objectValue?["code"], "tool_denied")
        XCTAssertEqual(order, ["approve"])
    }

    func testSnapshotFailureStopsTheWrite() throws {
        var dispatched = false
        let router = makeRouter(
            dispatcher: { _, _ in dispatched = true; return .null },
            approver: { _ in .approve },
            snapshotter: { _ in throw TestFailure.broken }
        )
        let error = try failure(
            router,
            id: 8,
            method: "tools/call",
            params: ["name": "notes.add", "arguments": ["text": "hello"]]
        )

        XCTAssertEqual(error["data"]?.objectValue?["code"], "snapshot_failed")
        XCTAssertFalse(dispatched)
    }

    func testThrownToolBecomesToolErrorNotProtocolError() throws {
        let router = makeRouter(dispatcher: { _, _ in throw TestFailure.broken })
        let result = try result(
            router,
            id: 9,
            method: "tools/call",
            params: ["name": "notes.search", "arguments": ["q": "x"]]
        )
        XCTAssertEqual(result["isError"], true)
        XCTAssertNotNil(result["content"])
    }

    func testResourceListAndTextReadUseExactDeclaredURI() throws {
        let resource = MCPServedResource(
            uri: "despia://notes/guide",
            name: "Guide",
            description: "Notes guide",
            mimeType: "text/plain",
            load: { .text("hello") }
        )
        let router = makeRouter(resources: [resource])
        let listed = try result(router, id: 10, method: "resources/list")
        let read = try result(
            router,
            id: 11,
            method: "resources/read",
            params: ["uri": "despia://notes/guide"]
        )

        XCTAssertEqual(listed["resources"]?.arrayValue?.first?.objectValue?["name"], "Guide")
        XCTAssertEqual(read["contents"]?.arrayValue?.first?.objectValue?["text"], "hello")
        XCTAssertEqual(read["contents"]?.arrayValue?.first?.objectValue?["mimeType"], "text/plain")
    }

    func testBinaryResourceIsBase64Encoded() throws {
        let resource = MCPServedResource(uri: "despia://blob", name: "Blob", load: { .blob(Data([0, 1, 2])) })
        let read = try result(makeRouter(resources: [resource]), id: 12, method: "resources/read", params: ["uri": "despia://blob"])
        XCTAssertEqual(read["contents"]?.arrayValue?.first?.objectValue?["blob"], "AAEC")
    }

    func testUndeclaredResourceIsRefusedWithoutInvokingAnyLoader() throws {
        var loaded = false
        let resource = MCPServedResource(uri: "despia://known", name: "Known", load: { loaded = true; return .text("x") })
        let error = try failure(
            makeRouter(resources: [resource]),
            id: 13,
            method: "resources/read",
            params: ["uri": "file:///etc/passwd"]
        )

        XCTAssertEqual(error["data"]?.objectValue?["code"], "unknown_resource")
        XCTAssertFalse(loaded)
    }

    func testNotificationProducesNoResponseAndNoDispatch() {
        var dispatched = false
        let router = makeRouter(dispatcher: { _, _ in dispatched = true; return .null })
        let data = rpc(id: nil, method: "notifications/initialized")
        XCTAssertNil(router.handle(data))
        XCTAssertFalse(dispatched)
    }

    func testUnknownMethodIsMethodNotFound() throws {
        let error = try failure(makeRouter(), id: 14, method: "tools/subscribe")
        XCTAssertEqual(error["code"], -32601)
    }

    private func makeRouter(
        resources: [MCPServedResource] = [],
        dispatcher: @escaping MCPDispatcher = { name, _ in ["ok": true, "tool": .string(name)] },
        approver: MCPApprover? = nil,
        snapshotter: MCPSnapshotter? = nil
    ) -> DespiaMCPServerRouter {
        DespiaMCPServerRouter(
            rows: rows,
            resources: resources,
            dispatcher: dispatcher,
            approver: approver,
            snapshotter: snapshotter
        )
    }

    private func result(
        _ router: DespiaMCPServerRouter,
        id: Int64,
        method: String,
        params: [String: JSONValue] = [:]
    ) throws -> [String: JSONValue] {
        let envelope = try decode(XCTUnwrap(router.handle(rpc(id: id, method: method, params: params))))
        return try XCTUnwrap(envelope["result"]?.objectValue)
    }

    private func failure(
        _ router: DespiaMCPServerRouter,
        id: Int64,
        method: String,
        params: [String: JSONValue] = [:]
    ) throws -> [String: JSONValue] {
        let envelope = try decode(XCTUnwrap(router.handle(rpc(id: id, method: method, params: params))))
        return try XCTUnwrap(envelope["error"]?.objectValue)
    }

    private func rpc(id: Int64?, method: String, params: [String: JSONValue] = [:]) -> Data {
        var value: [String: JSONValue] = ["jsonrpc": "2.0", "method": .string(method)]
        if let id { value["id"] = .integer(id) }
        if !params.isEmpty { value["params"] = .object(params) }
        return try! JSONValue.object(value).encodedData()
    }

    private func decode(_ data: Data) throws -> [String: JSONValue] {
        try JSONDecoder().decode(JSONValue.self, from: data).objectValue ?? [:]
    }
}

private enum TestFailure: Error {
    case broken
}
