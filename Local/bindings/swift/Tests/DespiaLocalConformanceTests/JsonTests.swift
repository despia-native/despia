//
//  JsonTests.swift - the binding's JSON, and the Foundation bridge over it.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  Small on purpose, and none of it is decorative. Every case here is a rule the
//  corpus depends on but does not itself state - the corpus asserts what the
//  STORE answers, and these assert that the answer survives the trip into a host
//  unchanged. Each one is a bug that has actually shipped in a JSON bridge
//  somewhere: a count that became `2.0`, a `true` that became `1`, a null that
//  vanished instead of arriving, an emoji that came back as two broken halves.
//

import XCTest

import DespiaLocal

final class JsonTests: XCTestCase {

    // MARK: - rendering

    func testRenderingIsByteStableAndKeySorted() {
        var out = JsonObject()
        out.set("zulu", .number(1))
        out.set("alpha", .string("a"))
        // Insertion order is zulu, alpha; the RENDERING sorts, which is what lets
        // two runners compare renderings instead of object identity.
        XCTAssertEqual(Json.object(out).render(), "{\"alpha\":\"a\",\"zulu\":1}")
        XCTAssertEqual(out.keys, ["zulu", "alpha"], "iteration keeps insertion order")
    }

    func testAnIntegralNumberRendersAsAnInteger() {
        XCTAssertEqual(Json.number(2).render(), "2")
        XCTAssertEqual(Json.number(-2).render(), "-2")
        XCTAssertEqual(Json.number(2.5).render(), "2.5")
        // Non-finite has no JSON spelling; null is the honest one.
        XCTAssertEqual(Json.number(Double.infinity).render(), "null")
    }

    // MARK: - parsing

    func testParseRoundTripsTheDocumentShapesTheStoreAnswers() throws {
        let text = "{\"hits\":[{\"distance\":0,\"key\":\"d1\"}],\"value\":null,\"ok\":true}"
        let parsed = try Json.parse(text)
        XCTAssertEqual(parsed["hits"][0]["key"].string(), "d1")
        XCTAssertTrue(parsed["ok"].bool())
        XCTAssertTrue(parsed.has("value"), "an explicit null keeps its key")
        XCTAssertTrue(parsed["value"].isNull)
        XCTAssertFalse(parsed.has("absent"))
        XCTAssertTrue(parsed["absent"].isNull, "a missing key reads as null rather than throwing")
    }

    func testASurrogatePairSurvivesTheEscapeForm() throws {
        // Two \u escapes, one scalar. Decoding each on its own would reject every
        // character outside the BMP - which is most emoji, and an app's data is
        // whatever the app put there.
        let parsed = try Json.parse("{\"t\":\"a\\ud83d\\ude00b\"}")
        XCTAssertEqual(parsed["t"].string(), "a\u{1F600}b")
    }

    func testTrailingContentIsARefusalRatherThanASilentTruncation() {
        XCTAssertNil(Json.parseOrNull("{\"a\":1} junk"))
        XCTAssertNil(Json.parseOrNull("{"))
        XCTAssertNil(Json.parseOrNull(""))
    }

    // MARK: - the Foundation bridge

    func testWholeNumbersCrossAsIntegersAndFractionsDoNot() {
        let bridged = Json.parseOrNull("{\"count\":2,\"score\":2.5}")?.foundationValue as? [String: Any?]
        XCTAssertEqual(bridged?["count"] as? Int, 2, "a count must not reach a page as 2.0")
        XCTAssertNil(bridged?["count"] as? Double, "and it must not still be a Double")
        XCTAssertEqual(bridged?["score"] as? Double, 2.5)
    }

    func testABooleanStaysABooleanInBothDirections() {
        XCTAssertEqual(Json(foundation: true), .bool(true))
        XCTAssertEqual(Json(foundation: 1), .number(1))
        // CFBoolean bridges to NSNumber, so this is the case a naive cast turns
        // into 1 and back into `true` only by luck.
        let back = Json.bool(true).foundationValue
        XCTAssertEqual(back as? Bool, true)
        XCTAssertNil(back as? Int)
    }

    func testANullKeepsItsKeyOnTheWayOut() {
        let bridged = Json.parseOrNull("{\"value\":null}")?.foundationValue as? [String: Any?]
        XCTAssertEqual(bridged?.count, 1, "assigning nil through a subscript would have removed it")
        XCTAssertTrue(bridged?.keys.contains("value") == true)
        // Present, and holding nothing: "the store answered null" is a different
        // answer from "the store said nothing", and the crud corpus asserts it.
        XCTAssertNotNil(bridged?["value"])
        XCTAssertNil(bridged?["value"] ?? nil)
    }

    func testAFoundationDocumentRoundTripsThroughJsonUnchanged() {
        let original: [String: Any] = [
            "title": "Invoice",
            "amount": 42,
            "paid": false,
            "tags": ["q3", "uae"],
        ]
        let back = Json(foundation: original).foundationValue as? [String: Any?]
        XCTAssertEqual(back?["title"] as? String, "Invoice")
        XCTAssertEqual(back?["amount"] as? Int, 42)
        XCTAssertEqual(back?["paid"] as? Bool, false)
        XCTAssertEqual((back?["tags"] as? [Any?])?.compactMap { $0 as? String }, ["q3", "uae"])
    }

    func testAnUnrecognisedValueIsCarriedRatherThanDropped() {
        // A host can hand across something this bridge has no JSON spelling for.
        // Losing it silently is the one unacceptable outcome.
        XCTAssertEqual(Json(foundation: URL(fileURLWithPath: "/tmp/x")).stringOrNull?.isEmpty, false)
    }

    // MARK: - the embedding value type

    func testAnEmbeddingRefusesWhatCannotBeTrue() {
        XCTAssertThrowsError(try Embedding(model: "", dimension: 4)) { error in
            XCTAssertEqual((error as? LocalError)?.code, "invalid_embedding")
        }
        XCTAssertThrowsError(try Embedding(model: "emb", dimension: 0))
        XCTAssertThrowsError(try Embedding(model: "emb", dimension: Embedding.maxDimension + 1))
    }

    func testAnEmbeddingRendersTheTripleTheIndexRecords() throws {
        let embedding = try Embedding(model: "emb", dimension: 4, revision: "r1")
        XCTAssertEqual(embedding.json.render(), "{\"dimension\":4,\"model\":\"emb\",\"revision\":\"r1\"}")
        // No revision is ABSENT, not empty: an index built without one must not
        // be told it was built with "".
        let bare = try Embedding(model: "emb", dimension: 4)
        XCTAssertEqual(bare.json.render(), "{\"dimension\":4,\"model\":\"emb\"}")
    }

    func testAnErrorsWireFormIsWhatAFixtureCompares() {
        let error = LocalError("embedding_mismatch", "the index was built by another embedder",
                              data: .obj([("reason", .string("model"))]))
        XCTAssertEqual(error.wire.render(),
                       "{\"code\":\"embedding_mismatch\"," +
                       "\"data\":{\"reason\":\"model\"}," +
                       "\"message\":\"the index was built by another embedder\"}")
        // No message and no data means neither key, so a fixture matching on
        // `code` alone is not defeated by an empty string it never asked for.
        XCTAssertEqual(LocalError("closed").wire.render(), "{\"code\":\"closed\"}")
    }
}
