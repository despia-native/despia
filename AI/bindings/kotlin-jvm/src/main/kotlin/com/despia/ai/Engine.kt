// Engine.kt - the Kotlin face of the C ABI.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Thin by design, like the Swift one: JSON in, JSON out, a callback, and no
// policy. The catalog, fit, routing, the tool loop and approvals live above this
// in the host, because they are policy and policy in the engine is policy you
// cannot change without shipping a new binary.
//
// What this lane proves that no other lane can: the ABI's THREADING CONTRACT.
// Events arrive on the engine's own worker thread, which the JVM has never
// seen; the JNI layer attaches it. A violation here shows up as a hang or a
// crash rather than as a warning, which is exactly why the contract is tested
// where threads are real.

package com.despia.ai

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Called from the ENGINE's worker thread. Do not block it. */
fun interface EventListener {
    fun onEvent(eventJson: String)
}

internal object NativeEngine {

    /** Where the library comes from on desktop is its own problem, and it is
     *  Native.kt's: the classpath carries a per-OS classifier artifact, it is
     *  extracted into a version-keyed cache, and a platform this build has no
     *  native for answers a typed absence rather than an UnsatisfiedLinkError. */
    fun ensureLoaded() = Native.ensureLoaded()

    external fun abiVersion(): Int
    external fun capabilities(): String?
    external fun open(configJson: String): Long
    external fun close(handle: Long)
    external fun loadModel(handle: Long, modelJson: String): Int
    external fun request(handle: Long, requestJson: String, listener: EventListener): Int
    external fun sync(handle: Long, requestId: Int): Int
    external fun cancel(handle: Long, requestId: Int): Int
    external fun lastError(handle: Long): String?

    /** Sinks the JNI layer still owns, and listener refs it still holds.
     *
     *  A request needs a GLOBAL ref to its listener, because the engine calls
     *  back long after the frame that made it is gone, and a global ref that
     *  nobody releases is a per-request leak for the life of the process. The
     *  layer releases it on the request's terminal event, on a refusal, and on
     *  close for anything that never settled - and these two are how a test
     *  READS that back rather than trusting the comment. Both must return to
     *  zero once contexts are closed. */
    external fun liveSinks(): Int
    external fun liveListenerRefs(): Int
}

/** `data` carries the typed absence verbatim when the failure IS one, so a
 *  caller that catches this can render the same fields a bus absence carries
 *  rather than re-deriving them from a message string. */
class DespiaAiError(
    val code: String,
    override val message: String?,
    val data: Json = Json.Null,
) : Exception(message)

/**
 * An engine context. One context is driven by one caller thread, per the ABI;
 * open a second context rather than sharing one.
 */
class Engine(config: Json = Json.Obj(mapOf("schema_version" to Json.Num(1.0)))) : AutoCloseable {
    private val handle: Long

    init {
        NativeEngine.ensureLoaded()
        handle = NativeEngine.open(config.render())
        if (handle == 0L) throw failure(0L, "invalid_config", "the context could not be opened")
    }

    override fun close() {
        // Joins the engine's worker, so no callback arrives after this returns.
        if (handle != 0L) NativeEngine.close(handle)
    }

    fun loadModel(entry: Json) {
        val rc = NativeEngine.loadModel(handle, entry.render())
        if (rc != 0) throw failure(handle, "load_failed", "the model was refused")
    }

    fun cancel(requestId: Int): Boolean = NativeEngine.cancel(handle, requestId) == 0

    /** Asks for a full-snapshot `sync` on a live request. What a surface that
     *  attached mid-stream uses to catch up on the deltas it missed. */
    fun sync(requestId: Int): Boolean = NativeEngine.sync(handle, requestId) == 0

    /**
     * Submits a request and returns its id. Events reach `listener` on the
     * engine's worker thread.
     */
    fun request(request: Json, listener: EventListener): Int {
        val id = NativeEngine.request(handle, request.render(), listener)
        if (id < 0) throw failure(handle, "invalid_request", "the request was refused")
        return id
    }

    /**
     * Drives a request to its terminal event and returns every envelope in
     * production order.
     *
     * A consumer WAITS for `final` rather than assuming timing - close() cancels
     * what is still in flight, which is the documented behaviour and the reason
     * waiting is the caller's job.
     */
    fun drain(request: Json, timeoutMs: Long = 5_000, onEvent: ((Json) -> Unit)? = null): List<Json> {
        val events = java.util.Collections.synchronizedList(mutableListOf<Json>())
        val settled = CountDownLatch(1)
        request(request) { payload ->
            val envelope = Json.parseOrNull(payload)
            if (envelope != null) {
                events.add(envelope)
                onEvent?.invoke(envelope)
                if (envelope["final"].bool()) settled.countDown()
            }
        }
        settled.await(timeoutMs, TimeUnit.MILLISECONDS)
        return events.toList()
    }

    private fun failure(ctx: Long, fallbackCode: String, fallbackMessage: String): DespiaAiError {
        val raw = NativeEngine.lastError(ctx) ?: return DespiaAiError(fallbackCode, fallbackMessage)
        val parsed = Json.parseOrNull(raw) ?: return DespiaAiError(fallbackCode, raw)
        return DespiaAiError(parsed["code"].string(fallbackCode), parsed["message"].stringOrNull())
    }

    companion object {
        /**
         * Whether this build can run inference on THIS machine, as a value.
         *
         * A desktop app asks this before it offers the feature: a JAR whose
         * classifier natives do not cover the running platform is a normal,
         * shippable state, and the answer names which way it is absent. Nothing
         * is loaded by asking twice - the resolution is cached once it succeeds.
         */
        fun availability(): NativeResolution = Native.probe()

        /** What THIS build carries. Ask it; never assume. */
        fun capabilities(): Json {
            NativeEngine.ensureLoaded()
            return NativeEngine.capabilities()?.let { Json.parseOrNull(it) } ?: Json.Null
        }

        fun abiVersion(): Int {
            NativeEngine.ensureLoaded()
            return NativeEngine.abiVersion()
        }
    }
}
