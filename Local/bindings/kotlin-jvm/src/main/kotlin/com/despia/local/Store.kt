// Store.kt - the typed Kotlin face over despia_local.h.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The twin of bindings/ts/src/store.ts, with one deliberate difference: the
// TypeScript face IS the store (it drives node:sqlite directly, because the web
// lane has no native toolchain), while this one is a thin marshaller over the
// C ABI. So where the TS file reimplements the semantics, this file must not -
// every rule about what an action means lives once, in engine/src/store.cpp, and
// the corpus is what proves both faces agree about it.
//
// What this file DOES own is the shape of the call site, and that is where the
// embedding provenance is enforced on this lane. `indexUpsert`, `indexSearch`
// and `indexReindex` take an `Embedding` as a REQUIRED parameter carrying the
// (model, dimension, revision) triple, so a caller cannot write or query a
// vector without saying which embedder produced it. Omitting it is a compile
// error here rather than a mystery ranking later; disagreeing about it is a
// typed `embedding_mismatch` from the store, carrying the reindex path.

package com.despia.local

import java.io.File

/** A typed failure from the store. `code` is what a caller branches on;
 *  `message` is for humans and `data` carries the specifics - for an
 *  `embedding_mismatch`, the reason, the two sides and the index to reindex. */
class LocalError(
    val code: String,
    val detail: String,
    val data: Json = Json.Obj(emptyMap()),
) : RuntimeException(if (detail.isEmpty()) code else "$code: $detail") {

    /** The wire form, which is what a fixture compares against. */
    val wire: Json
        get() {
            val fields = LinkedHashMap<String, Json>()
            fields["code"] = Json.Str(code)
            if (detail.isNotEmpty()) fields["message"] = Json.Str(detail)
            if (data !is Json.Null && data.fields.isNotEmpty()) fields["data"] = data
            return Json.Obj(fields)
        }

    internal companion object {
        fun from(raw: String?): LocalError {
            val parsed = raw?.let { Json.parseOrNull(it) }
                ?: return LocalError("call_failed", "the store failed without reporting why")
            return LocalError(
                parsed["code"].string("call_failed"),
                parsed["message"].string(),
                parsed["data"],
            )
        }
    }
}

/**
 * The provenance of a vector: which embedder produced it, at what width, at
 * which revision.
 *
 * It is a value type rather than three loose arguments because the three travel
 * together always - an index records them at creation and every later write and
 * query is checked against them. A vector written by one model and searched by
 * another returns plausible nonsense at full confidence, which is the single
 * worst failure mode a local RAG stack has; carrying the triple is what turns it
 * into a typed error with a named fix.
 */
data class Embedding(
    val model: String,
    val dimension: Int,
    val revision: String? = null,
) {
    init {
        require(model.isNotEmpty()) { "an embedding names its model" }
        require(dimension in 1..MAX_DIMENSION) { "a dimension is between 1 and $MAX_DIMENSION" }
    }

    fun toJson(): Json {
        val fields = LinkedHashMap<String, Json>()
        fields["model"] = Json.Str(model)
        fields["dimension"] = Json.Num(dimension.toDouble())
        revision?.let { fields["revision"] = Json.Str(it) }
        return Json.Obj(fields)
    }

    companion object {
        /** The ABI's declared ceiling; capabilities reports it under
         *  `limits.max_dimension` and a build that lowers it says so there. */
        const val MAX_DIMENSION = 8192

        fun from(v: Json): Embedding? {
            val model = v["model"].stringOrNull() ?: return null
            val dimension = (v["dimension"] as? Json.Num)?.value?.toInt() ?: return null
            return Embedding(model, dimension, v["revision"].stringOrNull())
        }
    }
}

/**
 * One open store: one file, one connection, one caller thread.
 *
 * The ABI's threading contract is not advice - savepoints are per-connection
 * state, so two threads interleaving transactional scopes on one handle unwind
 * each other's work. Open two Stores instead; they are cheap and WAL means a
 * reader never blocks the writer.
 */
class Store(directory: File, readonly: Boolean = false) : AutoCloseable {

    private var handle: Long

    init {
        val config = LinkedHashMap<String, Json>()
        config["schema_version"] = Json.Num(1.0)
        config["directory"] = Json.Str(directory.absolutePath)
        if (readonly) config["readonly"] = Json.Bool(true)
        handle = NativeStore.open(Json.Obj(config).render())
        if (handle == 0L) {
            // There is no handle to ask, so the failure is the GLOBAL one.
            throw LocalError.from(NativeStore.lastError(0L))
        }
    }

    override fun close() {
        if (handle != 0L) {
            NativeStore.close(handle)
            handle = 0L
        }
    }

    /**
     * Closes and reopens the file WITHOUT the graceful path - what happens when
     * the process dies. A real close-and-reopen, not a simulation, which is why
     * the durability fixtures can be trusted: committed data comes back and an
     * open savepoint's writes do not.
     */
    fun crash() {
        alive()
        if (NativeStore.reopen(handle) != 0) throw LocalError.from(NativeStore.lastError(handle))
    }

    /** The funnel. Every typed helper below is this call with its arguments
     *  spelled out; an action this build does not carry answers the typed
     *  `unknown_action` rather than undefined behaviour. */
    fun call(action: String, args: Json = Json.Obj(emptyMap())): Json {
        alive()
        val raw = NativeStore.call(handle, action, args.render())
            ?: throw LocalError.from(NativeStore.lastError(handle))
        return Json.parse(raw)
    }

    private fun alive() {
        if (handle == 0L) throw LocalError("closed", "this store was closed")
    }

    // --- stores ----------------------------------------------------------

    fun declareStore(store: String): Json = call("declare", jsonOf("store" to Json.Str(store)))

    fun put(store: String, key: String, value: Json): Json =
        call("put", jsonOf("store" to Json.Str(store), "key" to Json.Str(key), "value" to value))

    fun get(store: String, key: String): Json =
        call("get", jsonOf("store" to Json.Str(store), "key" to Json.Str(key)))

    fun delete(store: String, key: String): Json =
        call("delete", jsonOf("store" to Json.Str(store), "key" to Json.Str(key)))

    fun query(
        store: String,
        where: Json = Json.Obj(emptyMap()),
        order: Json = Json.Arr(emptyList()),
        limit: Int = 0,
    ): Json {
        val args = LinkedHashMap<String, Json>()
        args["store"] = Json.Str(store)
        args["where"] = where
        args["order"] = order
        if (limit > 0) args["limit"] = Json.Num(limit.toDouble())
        return call("query", Json.Obj(args))
    }

    fun stats(): Json = call("stats")

    // --- transactional scopes --------------------------------------------

    fun savepoint(name: String): Json = call("savepoint", jsonOf("name" to Json.Str(name)))
    fun release(name: String): Json = call("release", jsonOf("name" to Json.Str(name)))
    fun rollback(name: String): Json = call("rollback", jsonOf("name" to Json.Str(name)))

    // --- snapshots -------------------------------------------------------

    fun snapshot(label: String): Json = call("snapshot", jsonOf("label" to Json.Str(label)))
    fun snapshots(): Json = call("snapshots")
    fun restore(label: String): Json = call("restore", jsonOf("label" to Json.Str(label)))
    fun export(label: String): Json = call("export", jsonOf("label" to Json.Str(label)))

    // --- vectors ---------------------------------------------------------
    //
    // The embedding is a required parameter on every one of these, which is the
    // enforcement point on this lane: there is no overload that lets a caller
    // write a vector anonymously and no default that guesses one for them.

    fun indexUpsert(
        index: String,
        key: String,
        vector: List<Double>,
        embedding: Embedding,
        value: Json = Json.Obj(emptyMap()),
    ): Json {
        // Checked here as well as in the store, because the local check can name
        // the caller's own mistake before it becomes a round trip: a vector whose
        // length disagrees with its OWN declared dimension is a bug in the code
        // that produced it, not a drift between two embedders.
        if (vector.size != embedding.dimension) {
            throw LocalError(
                "embedding_mismatch", "the vector does not match its declared dimension",
                jsonOf(
                    "reason" to Json.Str("dimension"),
                    "stored" to Json.Num(embedding.dimension.toDouble()),
                    "query" to Json.Num(vector.size.toDouble()),
                    "reindex" to Json.Str(index),
                ),
            )
        }
        return call(
            "index.upsert",
            jsonOf(
                "index" to Json.Str(index),
                "key" to Json.Str(key),
                "vector" to Json.arrayOfNumbers(vector),
                "embedding" to embedding.toJson(),
                "value" to value,
            ),
        )
    }

    /** `count` plus the embedding this index was built with - the answer to
     *  "may I search this with what I have?" without guessing. */
    fun indexInfo(index: String): Json = call("index.info", jsonOf("index" to Json.Str(index)))

    fun indexSearch(index: String, vector: List<Double>, embedding: Embedding, k: Int = 10): Json =
        call(
            "index.search",
            jsonOf(
                "index" to Json.Str(index),
                "vector" to Json.arrayOfNumbers(vector),
                "embedding" to embedding.toJson(),
                "k" to Json.Num(k.toDouble()),
            ),
        )

    fun indexDelete(index: String, key: String): Json =
        call("index.delete", jsonOf("index" to Json.Str(index), "key" to Json.Str(key)))

    /** The escape hatch an `embedding_mismatch` points at. The index adopts the
     *  new provenance wholesale, because vectors from the old embedder are not
     *  convertible - they are stale. */
    fun indexReindex(index: String, embedding: Embedding, vectors: List<Json>): Json =
        call(
            "index.reindex",
            jsonOf(
                "index" to Json.Str(index),
                "embedding" to embedding.toJson(),
                "vectors" to Json.Arr(vectors),
            ),
        )

    companion object {
        /** The ABI version this build implements. */
        val abiVersion: Int get() = NativeStore.abiVersion()

        /**
         * What THIS build carries. A consumer reading it ASKS; it never assumes.
         * `vectors` is absent, not empty, in a build compiled without
         * sqlite-vec - typed absence rather than a lie about a capability.
         */
        val capabilities: Json
            get() = NativeStore.capabilities()?.let { Json.parse(it) }
                ?: throw LocalError("call_failed", "the library reported no capabilities")
    }
}
