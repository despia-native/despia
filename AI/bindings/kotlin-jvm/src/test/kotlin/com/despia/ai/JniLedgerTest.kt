// JniLedgerTest.kt - the JNI layer gives back everything it takes.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// A request's listener has to be held as a GLOBAL ref, because the engine calls
// back long after the JNI frame that made it has returned. A global ref nothing
// releases is a leak that accumulates for the life of the process, and on a
// phone that is a process measured in days - so "it only leaks a little per
// request" is the same statement as "it fails eventually".
//
// The layer therefore claims three release paths, and a claim about a leak is
// worth nothing unless a test can read the count back, so all three are driven
// here against the real native:
//
//   · the TERMINAL event - the ordinary settle. Driven while the context is
//     still OPEN, because otherwise close would be doing the work and the
//     ordinary path would be untested.
//   · a REFUSED request - despia_ai_request returns negative before anything is
//     queued, so no event will ever arrive to trigger the first path.
//   · CLOSE - the sweep, for work that was still queued when the context went
//     away and therefore never settled at all.
//
// And one more thing that leaks per CONTEXT rather than per request: the engine
// worker is a native thread this layer attaches to the JVM, and a native thread
// that exits while still attached leaks its JavaThread. An attached thread is a
// live Java thread, so the JVM's own thread list is the instrument.

package com.despia.ai

import kotlin.test.Test
import kotlin.test.fail

class JniLedgerTest {

    private fun ledger(): Pair<Int, Int> {
        Native.ensureLoaded()
        return NativeEngine.liveSinks() to NativeEngine.liveListenerRefs()
    }

    /** The counters settle on the engine's worker, which is not this thread. */
    private fun awaitLedger(target: Pair<Int, Int>, timeoutMs: Long = 5_000): Pair<Int, Int> {
        val deadline = System.currentTimeMillis() + timeoutMs
        var seen = ledger()
        while (seen != target && System.currentTimeMillis() < deadline) {
            Thread.sleep(2)
            seen = ledger()
        }
        return seen
    }

    private val script =
        """{"id":"m1","engine":"mock","format":"mock",
            "mock":{"script":[{"token":"one "},{"token":"two"},{"complete":{}}]}}"""

    @Test
    fun `a settled request hands its listener back`() {
        val requests = 500
        val baseline = ledger()

        val engine = Engine()
        engine.loadModel(Json.parse(script))
        var tokens = 0
        repeat(requests) {
            val events = engine.drain(Json.parse("""{"kind":"completion","model":"m1"}"""))
            if (events.none { event -> event["final"].bool() }) fail("request $it never settled")
            tokens += events.count { event -> event["event"].string() == "token" }
        }

        // Still OPEN. This is the terminal-event path being tested, not close.
        val open = awaitLedger(baseline)
        println(
            "[jni ledger] $requests requests, $tokens token events | " +
                "baseline sinks=${baseline.first} refs=${baseline.second} -> " +
                "open sinks=${open.first} refs=${open.second}"
        )
        if (open != baseline) {
            fail("after $requests settled requests the ledger reads $open, expected $baseline")
        }

        engine.close()
        val closed = ledger()
        println("[jni ledger] after close: sinks=${closed.first} refs=${closed.second}")
        if (closed != baseline) fail("close moved the ledger to $closed, expected $baseline")
        if (baseline != 0 to 0) {
            fail("the ledger was not empty before this test: $baseline")
        }
    }

    @Test
    fun `a refused request hands its listener back`() {
        // Refused BEFORE it is queued - no callback will ever arrive, so the
        // terminal path cannot be the one that frees this.
        val refusals = 200
        val baseline = ledger()

        Engine().use { engine ->
            engine.loadModel(Json.parse(script))
            var refused = 0
            repeat(refusals) {
                try {
                    engine.request(Json.parse("""{"kind":"completion","model":"absent"}""")) {}
                } catch (e: DespiaAiError) {
                    refused++
                }
            }
            if (refused != refusals) fail("only $refused of $refusals requests were refused")

            val after = ledger()
            println("[jni ledger] $refusals refusals -> sinks=${after.first} refs=${after.second}")
            if (after != baseline) fail("after $refusals refusals the ledger reads $after, expected $baseline")
        }
    }

    @Test
    fun `close sweeps work that never settled`() {
        // A paused request holds the worker, so the second one is still in the
        // QUEUE when the context goes away - and queued work is dropped without
        // a terminal event, which is precisely the case the sweep exists for.
        val baseline = ledger()
        val engine = Engine()
        engine.loadModel(Json.parse(
            """{"id":"held","engine":"mock","format":"mock",
                "mock":{"script":[{"token":"one"},{"pause":true},{"complete":{}}]}}"""))

        engine.request(Json.parse("""{"kind":"completion","model":"held"}""")) {}
        engine.request(Json.parse("""{"kind":"completion","model":"held"}""")) {}

        val held = ledger()
        println("[jni ledger] two in flight (one paused, one queued): sinks=${held.first} refs=${held.second}")
        if (held != (baseline.first + 2) to (baseline.second + 2)) {
            fail("expected two live sinks, the ledger reads $held against a baseline of $baseline")
        }

        engine.close()   // cancels, joins, then sweeps
        val closed = ledger()
        println("[jni ledger] after close: sinks=${closed.first} refs=${closed.second}")
        if (closed != baseline) fail("close left $closed behind, expected $baseline")
    }

    @Test
    fun `the worker attachment does not accumulate across contexts`() {
        // An attached native thread IS a live Java thread, so it is visible
        // here. If the layer never detached, every context would leave one
        // behind and this would grow by the cycle count.
        val cycles = 40
        val before = Thread.getAllStackTraces().keys.size

        repeat(cycles) {
            Engine().use { engine ->
                engine.loadModel(Json.parse(script))
                val events = engine.drain(Json.parse("""{"kind":"completion","model":"m1"}"""))
                if (events.none { event -> event["final"].bool() }) fail("cycle $it never settled")
            }
        }

        // The JVM's own threads come and go, so this is a growth bound rather
        // than an equality - but a leaked attachment per context would be +40.
        val after = Thread.getAllStackTraces().keys.size
        println("[jni ledger] $cycles open/request/close cycles: java threads $before -> $after")
        if (after > before + 4) {
            fail("$cycles contexts left ${after - before} extra live threads (before=$before after=$after)")
        }
    }
}
