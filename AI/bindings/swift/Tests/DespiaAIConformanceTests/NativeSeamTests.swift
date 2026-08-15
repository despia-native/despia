//
//  NativeSeamTests.swift - the claims underneath the corpus.
//
//  Copyright Despia. Licensed under the Apache License, Version 2.0.
//
//  The Swift twin of AiConformanceTest.kt. CorpusTests runs the shared fixtures
//  through the Swift host; these are the claims underneath it, and they are the
//  parts of the ABI a corpus case cannot see from above: that the engine reports
//  itself, that `close` joins the worker so no event outlives it, that `cancel`
//  and `sync` are legal from INSIDE the event callback without deadlocking
//  against a lock the callback path holds, and that a paused request stays
//  genuinely in flight.
//
//  They exist because the three corpus cases whose steps land mid-stream are
//  skipped by the synchronous runner. The behaviour they assert is not skipped:
//  it is asserted here, where the threading is the point.
//

import Dispatch
import Foundation
import XCTest

import DespiaAI

/// The worker appends, the test reads. The ABI delivers on ONE engine-owned
/// thread, but that thread is not this one, so the handoff is locked.
private final class Collected {
    private let lock = NSLock()
    private var envelopes: [JSON] = []

    func append(_ envelope: JSON) {
        lock.lock(); defer { lock.unlock() }
        envelopes.append(envelope)
    }

    var all: [JSON] {
        lock.lock(); defer { lock.unlock() }
        return envelopes
    }
}

final class NativeSeamTests: XCTestCase {

    private func model(_ json: String) -> JSON {
        JSON.parseOrNull(json) ?? .null
    }

    // MARK: - the ABI itself

    func testTheNativeSeamReportsItself() {
        let caps = DespiaAI.capabilitiesJSON()
        XCTAssertEqual(DespiaAI.abiVersion, 1, "the build reports an unexpected ABI version")
        XCTAssertEqual(caps["abi"].int(), 1, "capabilities do not report the abi: \(caps.render())")
        XCTAssertTrue(caps["engines"].strings.contains("mock"),
                      "the mock backend is not registered: \(caps.render())")
        XCTAssertFalse(caps["version"].string().isEmpty, "capabilities carry no package version")
    }

    func testCloseJoinsTheWorkerSoNoEventOutlivesIt() throws {
        // The ABI's teardown promise, exercised where threads are real. If the
        // worker were not joined this would race or crash rather than fail.
        let engine = try DespiaAI()
        try engine.load(entry: model(
            "{\"id\":\"m1\",\"engine\":\"mock\",\"format\":\"mock\"," +
            "\"mock\":{\"script\":[{\"token\":\"a\"},{\"complete\":{}}]}}"))
        let events = try engine.drain(model("{\"kind\":\"completion\",\"model\":\"m1\"}"))
        engine.close()
        XCTAssertTrue(events.contains { $0["final"].bool() }, "the request never settled")
    }

    func testUnloadRemovesTheModel() throws {
        // `unload_model` is the eleventh entry point and the only one no corpus
        // case reaches, so it is asserted here or nowhere.
        let engine = try DespiaAI()
        defer { engine.close() }
        try engine.load(entry: model(
            "{\"id\":\"m1\",\"engine\":\"mock\",\"format\":\"mock\",\"mock\":{\"script\":[]}}"))
        try engine.unload(model: "m1")
        XCTAssertThrowsError(try engine.unload(model: "m1"),
                             "unloading a model that is gone must be a typed refusal") { error in
            XCTAssertTrue(error is DespiaAIError, "the refusal did not cross as a typed error")
        }
    }

    func testCancelIsLegalFromInsideTheCallback() throws {
        // The reentrancy whitelist: the first thing every consumer does is cancel
        // on the first token, so it had better not deadlock against a lock the
        // callback path holds.
        let engine = try DespiaAI()
        defer { engine.close() }
        try engine.load(entry: model(
            "{\"id\":\"m1\",\"engine\":\"mock\",\"format\":\"mock\",\"mock\":{\"script\":[" +
            "{\"token\":\"one\"},{\"token\":\"two\"},{\"token\":\"three\"},{\"complete\":{}}]}}"))
        let cancelled = NSLock()
        var didCancel = false
        let events = try engine.drain(model("{\"kind\":\"completion\",\"model\":\"m1\"}")) { envelope in
            cancelled.lock()
            let first = !didCancel && envelope["event"].string() == "token"
            if first { didCancel = true }
            cancelled.unlock()
            if first { engine.cancel(request: Int32(envelope["id"].int())) }
        }
        let tokens = events.filter { $0["event"].string() == "token" }.count
        XCTAssertEqual(tokens, 1, "cancelling on the first token left \(tokens) token events")
        XCTAssertTrue(events.contains { $0["final"].bool() }, "a cancelled request must still settle")
    }

    func testAnOnDemandResyncAnswersWithTheAccumulatedSnapshot() throws {
        // The late-joiner path, and the reason the ABI grew `despia_ai_sync`: the
        // stream sends DELTAS, so a surface that attached mid-generation has
        // missed everything before it. The script pauses mid-flight so the request
        // is genuinely live when the resync is asked for.
        let engine = try DespiaAI()
        defer { engine.close() }
        try engine.load(entry: model(
            "{\"id\":\"m1\",\"engine\":\"mock\",\"format\":\"mock\",\"mock\":{\"script\":[" +
            "{\"token\":\"one \"},{\"token\":\"two\"},{\"pause\":true},{\"complete\":{}}]}}"))

        let collected = Collected()
        let settled = DispatchSemaphore(value: 0)
        let counter = NSLock()
        var seenTokens = 0
        let rid = try engine.submit(model("{\"kind\":\"completion\",\"model\":\"m1\"}")) { envelope in
            collected.append(envelope)
            var shouldSync = false
            if envelope["event"].string() == "token" {
                counter.lock()
                seenTokens += 1
                shouldSync = seenTokens == 2
                counter.unlock()
            }
            // Legal from inside the callback, like cancel.
            if shouldSync { engine.sync(request: Int32(envelope["id"].int())) }
            if envelope["final"].bool() { settled.signal() }
        }
        // The pause holds the request open until it is cancelled.
        Thread.sleep(forTimeInterval: 0.05)
        engine.cancel(request: rid)
        _ = settled.wait(timeout: .now() + .seconds(5))

        let events = collected.all
        guard let sync = events.first(where: { $0["event"].string() == "sync" }) else {
            let seen = events.map { $0["event"].string() }.joined(separator: ",")
            XCTFail("no sync event arrived; got \(seen)")
            return
        }
        XCTAssertEqual(sync["data"]["snapshot"][0]["text"].string(), "one two",
                       "the resync snapshot was \(sync["data"]["snapshot"].render())")
        XCTAssertEqual(sync["data"]["seq"].int(), 1, "the resync reported the wrong sequence")
    }

    func testAPausedRequestStaysLiveUntilItIsCancelled() throws {
        // `pause` used to END the turn, so a fixture that paused mid-stream to
        // cancel could not be expressed at all. It now suspends, which is what
        // "in flight" has to mean for those cases to be worth writing.
        let engine = try DespiaAI()
        defer { engine.close() }
        try engine.load(entry: model(
            "{\"id\":\"m1\",\"engine\":\"mock\",\"format\":\"mock\",\"mock\":{\"script\":[" +
            "{\"token\":\"one\"},{\"pause\":true},{\"token\":\"two\"},{\"complete\":{}}]}}"))

        let collected = Collected()
        let settled = DispatchSemaphore(value: 0)
        let done = NSLock()
        var finished = false
        let rid = try engine.submit(model("{\"kind\":\"completion\",\"model\":\"m1\"}")) { envelope in
            collected.append(envelope)
            if envelope["final"].bool() {
                done.lock(); finished = true; done.unlock()
                settled.signal()
            }
        }
        Thread.sleep(forTimeInterval: 0.05)
        done.lock()
        let settledEarly = finished
        done.unlock()
        XCTAssertFalse(settledEarly, "the request settled while it should have been paused")

        engine.cancel(request: rid)
        _ = settled.wait(timeout: .now() + .seconds(5))

        let events = collected.all
        let tokens = events.filter { $0["event"].string() == "token" }.count
        XCTAssertEqual(tokens, 1, "expected one token before the pause, got \(tokens)")
        guard let terminal = events.last else {
            XCTFail("the request produced no events at all")
            return
        }
        XCTAssertTrue(terminal["data"]["cancelled"].bool(),
                      "the terminal event does not report the cancel")
    }
}
