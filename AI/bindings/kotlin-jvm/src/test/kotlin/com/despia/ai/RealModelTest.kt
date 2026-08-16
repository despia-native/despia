// RealModelTest.kt - the Kotlin binding against REAL WEIGHTS.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Everything else in this lane runs the MockEngine, which is the right backend
// for a corpus: deterministic, scripted, identical on three runners. What it
// cannot tell anybody is whether this BINDING survives a real generation - a
// stream of hundreds of small events arriving over minutes from a thread the JVM
// did not create, carrying whatever bytes a tokenizer felt like producing. The C
// ABI has been driven against real weights directly; this is the same claim for
// the path through JNI and Kotlin, which is a different path and can fail on its
// own: buffering, encoding, the thread hand-off.
//
// THE SKIP IS LOUD ON PURPOSE. A real model is hundreds of megabytes and CI has
// none, so this case is conditional - and a conditional case that vanishes
// quietly is worse than no case, because "green" then means two different
// things depending on the machine. Both reasons it can decline print a line
// naming exactly what was missing and where it was looked for.
//
//   · no model file      - point `despia.ai.model` (or DESPIA_AI_MODEL) at a
//                          .gguf, or drop one at the default path.
//   · no gguf engine     - the native under test is the mock-only build that
//                          `gradle test` links for speed. The `liveTest` task
//                          builds the full one; this case runs there.

package com.despia.ai

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.fail
import org.junit.jupiter.api.Assumptions.assumeTrue

class RealModelTest {

    private val defaultModel = "/tmp/models/gemma-3-1b-it-Q4_K_M.gguf"

    private fun modelFile(): File =
        File(System.getProperty("despia.ai.model") ?: System.getenv("DESPIA_AI_MODEL") ?: defaultModel)

    /** Prints the reason before declining, because a silent skip is the failure
     *  mode this whole file is written against. */
    private fun decline(reason: String) {
        println("[real model] SKIPPED: $reason")
        assumeTrue(false, reason)
    }

    @Test
    fun `a real model streams a completion through the binding`() {
        val model = modelFile()
        if (!model.isFile) {
            decline(
                "no model file at ${model.absolutePath} - set -Ddespia.ai.model=<path to a .gguf> " +
                    "or DESPIA_AI_MODEL to run this case",
            )
            return
        }

        val engines = Engine.capabilities()["engines"].strings()
        if ("gguf" !in engines) {
            decline(
                "this native carries no gguf engine (engines=$engines) - it is the mock-only build; " +
                    "run `gradle liveTest`, which links the full one",
            )
            return
        }

        println("[real model] loading ${model.absolutePath} (${model.length() / (1024 * 1024)} MB)")
        val started = System.nanoTime()

        Engine().use { engine ->
            engine.loadModel(
                jsonOf(
                    "schema_version" to Json.Num(1.0),
                    "id" to Json.Str("live"),
                    "engine" to Json.Str("gguf"),
                    "format" to Json.Str("gguf"),
                    "path" to Json.Str(model.absolutePath),
                    "context_length" to Json.Num(2048.0),
                ),
            )
            val loadedMs = (System.nanoTime() - started) / 1_000_000
            println("[real model] loaded in ${loadedMs}ms")

            val request = jsonOf(
                "schema_version" to Json.Num(1.0),
                "kind" to Json.Str("completion"),
                "model" to Json.Str("live"),
                "messages" to Json.Arr(
                    listOf(
                        jsonOf(
                            "role" to Json.Str("user"),
                            "content" to Json.Str("Reply with exactly: Despia AI works."),
                        ),
                    ),
                ),
                "options" to jsonOf(
                    "max_tokens" to Json.Num(48.0),
                    "temperature" to Json.Num(0.0),
                    "seed" to Json.Num(1.0),
                ),
            )

            // Collected by hand rather than with drain(), because the claims are
            // about HOW the events arrive - which thread, in what order, in how
            // many pieces - and drain() answers none of that.
            val events = java.util.Collections.synchronizedList(mutableListOf<Json>())
            val threads = java.util.Collections.synchronizedSet(mutableSetOf<String>())
            val deltas = StringBuilder()
            val settled = CountDownLatch(1)
            val callerThread = Thread.currentThread().name

            val id = engine.request(request) { payload ->
                threads.add(Thread.currentThread().name)
                val envelope = Json.parseOrNull(payload)
                if (envelope == null) {
                    println("[real model] an event did not parse: ${payload.take(200)}")
                    return@request
                }
                events.add(envelope)
                if (envelope["event"].string() == "token") {
                    synchronized(deltas) { deltas.append(envelope["data"]["delta"]["text"].string()) }
                }
                if (envelope["final"].bool()) settled.countDown()
            }
            if (id < 0) fail("the request was refused: $id")

            if (!settled.await(4, TimeUnit.MINUTES)) {
                engine.cancel(id)
                fail("no terminal event after four minutes; ${events.size} events arrived")
            }

            val terminal = events.last()
            val tokens = events.count { it["event"].string() == "token" }
            val text = deltas.toString()
            val snapshot = terminal["data"]["snapshot"][0]["text"].string()
            val usage = terminal["data"]["usage"]
            val elapsedMs = (System.nanoTime() - started) / 1_000_000

            println("[real model] ${terminal["event"].string()} after ${elapsedMs}ms: " +
                "$tokens token events, usage=${usage.render()}, threads=$threads (caller=$callerThread)")
            println("[real model] generated: ${text.take(400)}")

            if (terminal["event"].string() != "complete") {
                fail("the request ended with ${terminal["event"].string()}: ${terminal["data"].render().take(300)}")
            }
            if (tokens < 2) fail("a real generation arrived as $tokens token events - it is not streaming")
            if (text.isEmpty()) fail("the deltas carried no text")

            // The property that makes streaming worth anything: the pieces are
            // the whole, in order, exactly once. A binding that dropped, doubled
            // or reordered a chunk over the JNI hand-off fails here and nowhere
            // else - the mock's three-token scripts are too short to notice.
            if (text != snapshot) {
                fail(
                    "the deltas do not reconstruct the engine's snapshot\n" +
                        "  deltas   (${text.length}): ${text.take(200)}\n" +
                        "  snapshot (${snapshot.length}): ${snapshot.take(200)}",
                )
            }
            if (usage["out"].int() <= 0) fail("the terminal event reports no output tokens: ${usage.render()}")

            // The ABI's threading contract, on a real run rather than a scripted
            // one: one engine-owned worker, and never the caller's thread.
            if (threads.size != 1) fail("events arrived on ${threads.size} threads: $threads")
            if (threads.first() == callerThread) fail("events were delivered on the caller's own thread")

            // Not a failure: a token piece that splits a multi-byte character is
            // the ENGINE's business (the backend emits pieces as it gets them),
            // and this seam can only decline to make it worse. Loud, because a
            // reader of this output needs to know it happened.
            if (text.contains('\uFFFD')) {
                println("[real model] WARNING: the text contains U+FFFD - a token piece split a character")
            }
        }
    }
}
