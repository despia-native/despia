// AiConformanceTest.kt - the SECOND runner of the shared Despia AI corpus.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Runs OpenSource/Conformance/ai/** in VERIFY mode against this binding: the
// real C++ MockEngine over the real C ABI over JNI, plus the Kotlin
// implementations of the normative fit and routing functions.
//
// This file drives the NATIVE SEAM directly - the parts of the ABI that a
// corpus case cannot see from above. CorpusTest runs the shared fixtures through
// the Kotlin host; these are the claims underneath it: that the engine reports
// itself, that close() joins the worker so no event outlives it, that cancel and
// sync are legal from INSIDE the callback without deadlocking against a lock the
// callback path holds, and that a paused request stays genuinely in flight.
//
// They live in the JVM lane because this is where threads are real, and a
// violation shows up as a hang rather than as a warning.

package com.despia.ai

import java.io.File
import kotlin.test.Test
import kotlin.test.fail

class AiConformanceTest {

    // --- the ABI itself ---------------------------------------------------

    @Test
    fun `the native seam reports itself`() {
        val caps = Engine.capabilities()
        if (Engine.abiVersion() != 1) fail("abi version ${Engine.abiVersion()}, expected 1")
        if (caps["abi"].int() != 1) fail("capabilities do not report the abi: ${caps.render()}")
        if ("mock" !in caps["engines"].strings()) {
            fail("the mock backend is not registered: ${caps.render()}")
        }
        if (caps["version"].string().isEmpty()) fail("capabilities carry no package version")
    }

    @Test
    fun `close joins the worker so no event outlives it`() {
        // The ABI's teardown promise, exercised where threads are real. If the
        // worker were not joined this would race or crash rather than fail.
        val engine = Engine()
        engine.loadModel(Json.parse(
            """{"id":"m1","engine":"mock","format":"mock",
                "mock":{"script":[{"token":"a"},{"complete":{}}]}}"""))
        val events = engine.drain(Json.parse("""{"kind":"completion","model":"m1"}"""))
        engine.close()
        if (events.none { it["final"].bool() }) fail("the request never settled")
    }

    @Test
    fun `cancel is legal from inside the callback`() {
        // The reentrancy whitelist: the first thing every consumer does is
        // cancel on the first token, so it had better not deadlock against a
        // lock the callback path holds.
        Engine().use { engine ->
            engine.loadModel(Json.parse(
                """{"id":"m1","engine":"mock","format":"mock",
                    "mock":{"script":[{"token":"one"},{"token":"two"},{"token":"three"},{"complete":{}}]}}"""))
            var cancelled = false
            val events = engine.drain(Json.parse("""{"kind":"completion","model":"m1"}""")) { envelope ->
                if (!cancelled && envelope["event"].string() == "token") {
                    cancelled = true
                    engine.cancel(envelope["id"].int())
                }
            }
            val tokens = events.count { it["event"].string() == "token" }
            if (tokens != 1) fail("cancelling on the first token left $tokens token events")
            if (events.none { it["final"].bool() }) fail("a cancelled request must still settle")
        }
    }

    @Test
    fun `an on-demand resync answers with the accumulated snapshot`() {
        // The late-joiner path, and the reason the ABI grew `despia_ai_sync`:
        // the stream sends DELTAS, so a surface that attached mid-generation has
        // missed everything before it. The script pauses mid-flight so the
        // request is genuinely live when the resync is asked for.
        Engine().use { engine ->
            engine.loadModel(Json.parse(
                """{"id":"m1","engine":"mock","format":"mock","mock":{"script":[
                    {"token":"one "},{"token":"two"},{"pause":true},{"complete":{}}]}}"""))
            val events = java.util.Collections.synchronizedList(mutableListOf<Json>())
            val settled = java.util.concurrent.CountDownLatch(1)
            var seenTokens = 0
            var requestId = -1
            requestId = engine.request(Json.parse("""{"kind":"completion","model":"m1"}""")) { payload ->
                val envelope = Json.parseOrNull(payload) ?: return@request
                events.add(envelope)
                if (envelope["event"].string() == "token" && ++seenTokens == 2) {
                    // Legal from inside the callback, like cancel.
                    engine.sync(envelope["id"].int())
                }
                if (envelope["final"].bool()) settled.countDown()
            }
            // The pause holds the request open until it is cancelled.
            Thread.sleep(50)
            engine.cancel(requestId)
            settled.await(5, java.util.concurrent.TimeUnit.SECONDS)

            val sync = events.firstOrNull { it["event"].string() == "sync" }
                ?: fail("no sync event arrived; got " + events.joinToString(",") { it["event"].string() })
            val snapshot = sync["data"]["snapshot"]
            if (snapshot[0]["text"].string() != "one two") {
                fail("the resync snapshot was ${snapshot.render()}, expected the accumulated text")
            }
            if (sync["data"]["seq"].int() != 1) fail("the resync reported seq ${sync["data"]["seq"].int()}")
        }
    }

    @Test
    fun `a paused request stays live until it is cancelled`() {
        // `pause` used to END the turn, so a fixture that paused mid-stream to
        // cancel could not be expressed at all. It now suspends, which is what
        // "in flight" has to mean for those cases to be worth writing.
        Engine().use { engine ->
            engine.loadModel(Json.parse(
                """{"id":"m1","engine":"mock","format":"mock","mock":{"script":[
                    {"token":"one"},{"pause":true},{"token":"two"},{"complete":{}}]}}"""))
            val events = java.util.Collections.synchronizedList(mutableListOf<Json>())
            val settled = java.util.concurrent.CountDownLatch(1)
            val id = engine.request(Json.parse("""{"kind":"completion","model":"m1"}""")) { payload ->
                val envelope = Json.parseOrNull(payload) ?: return@request
                events.add(envelope)
                if (envelope["final"].bool()) settled.countDown()
            }
            Thread.sleep(50)
            if (settled.count == 0L) fail("the request settled while it should have been paused")
            engine.cancel(id)
            settled.await(5, java.util.concurrent.TimeUnit.SECONDS)

            val tokens = events.count { it["event"].string() == "token" }
            if (tokens != 1) fail("expected one token before the pause, got $tokens")
            val terminal = events.last()
            if (!terminal["data"]["cancelled"].bool()) fail("the terminal event does not report the cancel")
        }
    }

}
