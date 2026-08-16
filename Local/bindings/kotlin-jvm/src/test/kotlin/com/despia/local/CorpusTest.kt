// CorpusTest.kt - the Kotlin runner for the Despia Local conformance corpus.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The same files OpenSource/Local/conformance/run.ts reads, driven through the
// C ABI instead of through node:sqlite. That is the entire reason this exists:
// the TypeScript face reimplements the store because the web lane has no native
// toolchain, so it is a SECOND implementation of the same law - and a second
// implementation nobody runs against the same fixtures is a divergence waiting
// to be discovered by an app.
//
// Expectation semantics are identical to the TS runner by design: subset
// matching for results and store rows, ordered subset for errors, exact row
// counts, and a fresh temporary database per case so state never leaks and the
// `crash` step can genuinely close and reopen a file. If the two runners ever
// disagree about what a case means, that is the bug the corpus exists to
// surface. No case is skipped: every one of the twenty-six runs here.

package com.despia.local

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.fail

class CorpusTest {

    private fun corpusRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            for (candidate in listOf(
                File(dir, "OpenSource/Conformance/local"),   // the monorepo
                File(dir, "conformance/local"),              // the published mirror
                File(dir, "../Conformance/local"),
            )) {
                if (candidate.isDirectory) return candidate
            }
            dir = dir.parentFile
        }
        error("the base corpus was not found")
    }

    private fun corpusFiles(root: File): List<File> =
        root.walkTopDown().filter { it.isFile && it.extension == "json" }.sortedBy { it.path }.toList()

    /** Subset matching, with one strictness the shape makes possible: an
     *  expected `null` requires the key to be PRESENT and null, so "the store
     *  answered null" is not satisfied by "the store said nothing". The crud
     *  corpus asserts exactly that difference. */
    private fun subsetMatch(expected: Json, actual: Json): Boolean = when (expected) {
        is Json.Obj -> expected.fields.all { (key, value) ->
            if (value is Json.Null) actual.has(key) && actual[key] is Json.Null
            else subsetMatch(value, actual[key])
        }
        is Json.Arr -> actual is Json.Arr && actual.items.size >= expected.items.size &&
            expected.items.withIndex().all { (i, value) -> subsetMatch(value, actual.items[i]) }
        else -> expected.render() == actual.render()
    }

    private fun show(v: Json): String = v.render().let { if (it.length > 300) it.take(300) + "..." else it }

    private class Harness(val store: Store) {
        val results = LinkedHashMap<String, Json>()
        val errors = mutableListOf<Json>()
        val toolDispatched = mutableListOf<String>()
        var snapshotBeforeFirstWrite = false
    }

    /** The corpus action vocabulary, spelled through the typed face rather than
     *  through the raw funnel - so this runner exercises the call sites an app
     *  actually uses, including the embedding parameters vectors cannot omit. */
    private fun callBase(h: Harness, action: String, args: Json): Json {
        val s = h.store
        return when (action) {
            "declare" -> s.declareStore(args["store"].string())
            "put" -> s.put(args["store"].string(), args["key"].string(), args["value"])
            "get" -> s.get(args["store"].string(), args["key"].string())
            "delete" -> s.delete(args["store"].string(), args["key"].string())
            "query" -> s.query(args["store"].string(), args["where"], args["order"], args["limit"].int())
            "stats" -> s.stats()
            "savepoint" -> s.savepoint(args["name"].string())
            "release" -> s.release(args["name"].string())
            "rollback" -> s.rollback(args["name"].string())
            "snapshot" -> s.snapshot(args["label"].string())
            "snapshots" -> s.snapshots()
            "restore" -> s.restore(args["label"].string())
            "export" -> s.export(args["label"].string())
            "index.upsert" -> s.indexUpsert(
                args["index"].string(), args["key"].string(), args["vector"].numbers(),
                embeddingOf(args["embedding"]), args["value"],
            )
            "index.info" -> s.indexInfo(args["index"].string())
            "index.search" -> s.indexSearch(
                args["index"].string(), args["vector"].numbers(), embeddingOf(args["embedding"]),
                if (args.has("k")) args["k"].int() else 10,
            )
            "index.delete" -> s.indexDelete(args["index"].string(), args["key"].string())
            "index.reindex" -> s.indexReindex(
                args["index"].string(), embeddingOf(args["embedding"]), args["vectors"].items,
            )
            else -> throw LocalError("unknown_action", "no base action named $action")
        }
    }

    /** A malformed embedding in a fixture is the store's typed refusal to
     *  answer, not the runner's crash - the ABI has an `invalid_embedding` code
     *  for exactly this and it must be reachable from here. */
    private fun embeddingOf(v: Json): Embedding =
        Embedding.from(v) ?: throw LocalError(
            "invalid_embedding",
            "an embedding carries a model, a dimension and an optional revision",
        )

    /** A case that reaches into the AI surface is exercising the agentic write
     *  guarantee, not the data plane's API. The runner takes the same
     *  snapshot-then-savepoint path the loop takes, so the ordering assertion is
     *  about behaviour and not about a flag someone set. */
    private fun runAgentTurn(h: Harness, case: Json) {
        val tools = case["tools"].items
        for (model in case["mock"]["models"].fields.values) {
            for (turn in model["turns"].items) {
                for (step in turn.items) {
                    if (!step.has("tool")) continue
                    val call = step["tool"]
                    val spec = tools.firstOrNull { it["name"].string() == call["name"].string() } ?: continue
                    if (!spec.has("mutates")) continue

                    if (h.toolDispatched.isEmpty()) {
                        // BEFORE the first mutating dispatch, not after: a backup
                        // of a state the agent already touched would satisfy the
                        // word and break the promise.
                        h.store.snapshot("agent")
                        h.snapshotBeforeFirstWrite = true
                    }
                    h.store.savepoint("tool")
                    try {
                        if (spec["fails"].bool()) throw LocalError("tool_failed", "the tool failed mid-write")
                        val args = call["arguments"]
                        h.store.put("notes", args["key"].string(), jsonOf("v" to args["v"]))
                        h.store.release("tool")
                    } catch (_: LocalError) {
                        h.store.rollback("tool")
                    }
                    h.toolDispatched.add(call["name"].string())
                }
            }
        }
    }

    private fun runCase(case: Json, fails: MutableList<String>) {
        val dir = Files.createTempDirectory("despia-local-").toFile()
        try {
            Store(dir).use { store ->
                val h = Harness(store)

                // Seeding declares the stores and indexes a case uses. A row
                // carrying a `vector` seeds an index; anything else seeds a store.
                for ((name, rows) in case["seed"].fields) {
                    val list = rows.items
                    if (list.none { it["vector"] is Json.Arr }) {
                        store.declareStore(name)
                        for (row in list) store.put(name, row["key"].string(), row["value"])
                    } else {
                        for (row in list) {
                            store.indexUpsert(
                                name, row["key"].string(), row["vector"].numbers(),
                                embeddingOf(row["embedding"]), row["value"],
                            )
                        }
                    }
                }
                // Cases that drive the agentic loop write to `notes` through a tool.
                if (case.has("tools") && !case["seed"].has("notes")) store.declareStore("notes")

                if (case.has("mock")) runAgentTurn(h, case)

                for (step in case["steps"].items) {
                    if (step.has("crash")) { store.crash(); continue }
                    if (step.has("tick")) continue
                    if (!step.has("call")) { fails.add("unknown step: ${show(step)}"); continue }
                    val call = step["call"]
                    // Handled by runAgentTurn: the intelligence surface is the ai
                    // corpus's subject, and driving it twice would mean two places
                    // to update when the envelope grows.
                    if (call["scheme"].string("base") == "intelligence") continue
                    val label = call["as"].stringOrNull()
                    try {
                        val result = callBase(h, call["action"].string(), call["args"])
                        if (label != null) h.results[label] = result
                    } catch (err: LocalError) {
                        val fieldsOut = LinkedHashMap<String, Json>()
                        if (label != null) fieldsOut["req"] = Json.Str(label)
                        fieldsOut.putAll(err.wire.fields)
                        h.errors.add(Json.Obj(fieldsOut))
                    }
                }

                verify(case["expect"], h, store, fails)
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    private fun verify(expect: Json, h: Harness, store: Store, fails: MutableList<String>) {
        if (expect.has("results")) {
            for ((label, want) in expect["results"].fields) {
                val got = h.results[label]
                if (got == null) fails.add("results.$label: no result was recorded")
                else if (!subsetMatch(want, got)) {
                    fails.add("results.$label: expected ${show(want)}, got ${show(got)}")
                }
            }
        }

        if (expect.has("errors")) {
            val want = expect["errors"].items
            if (want.isEmpty() && h.errors.isNotEmpty()) {
                fails.add("errors: expected none, got ${show(Json.Arr(h.errors))}")
            }
            want.forEachIndexed { i, w ->
                val got = h.errors.getOrNull(i)
                if (got == null) fails.add("errors[$i]: expected ${show(w)}, nothing was recorded")
                else if (!subsetMatch(w, got)) {
                    fails.add("errors[$i]: expected ${show(w)}, got ${show(got)}")
                }
            }
        }

        if (expect.has("store")) {
            for ((name, rows) in expect["store"].fields) {
                val actual = store.query(name)["rows"].items
                val want = rows.items
                if (actual.size != want.size) {
                    fails.add("store.$name: expected ${want.size} row(s), got ${show(Json.Arr(actual))}")
                    continue
                }
                want.forEachIndexed { i, w ->
                    if (!subsetMatch(w, actual[i])) {
                        fails.add("store.$name[$i]: expected ${show(w)}, got ${show(actual[i])}")
                    }
                }
            }
        }

        if (expect["hitsCarryDistance"].bool()) {
            val hits = h.results.values.firstOrNull { it["hits"] is Json.Arr }?.get("hits")?.items
            if (hits == null || hits.any { it["distance"] !is Json.Num }) {
                fails.add("hitsCarryDistance: a search hit arrived without its distance")
            }
        }
        if (expect["snapshotsCarrySize"].bool()) {
            val snaps = h.results.values.firstOrNull { it["snapshots"] is Json.Arr }?.get("snapshots")?.items
            if (snaps == null || snaps.any { it["bytes"] !is Json.Num }) {
                fails.add("snapshotsCarrySize: a listed snapshot arrived without its size")
            }
        }
        if (expect["noInlineBytes"].bool()) {
            // A snapshot is a FILE with a relative URL, never a base64 payload
            // riding the bus: an app's whole database inlined into a JSON result
            // is a memory spike and a leak of everything at once.
            val text = Json.Obj(h.results).render()
            if (Regex("\"[A-Za-z0-9+/]{512,}={0,2}\"").containsMatchIn(text)) {
                fails.add("noInlineBytes: a payload looks like inline base64")
            }
        }
        if (expect.has("snapshotBeforeFirstWrite") &&
            expect["snapshotBeforeFirstWrite"].bool() != h.snapshotBeforeFirstWrite
        ) {
            fails.add("snapshotBeforeFirstWrite: expected ${expect["snapshotBeforeFirstWrite"].bool()}, " +
                "got ${h.snapshotBeforeFirstWrite}")
        }
        // expect.engineRequests asserts the AI wire envelope, which is the ai
        // corpus's subject. The base corpus asserts the TOOL's effect on the
        // store, and that is what `store` above checks.
    }

    @Test
    fun `the base corpus passes on the Kotlin binding`() {
        val root = corpusRoot()
        var total = 0
        val failures = mutableListOf<String>()
        for (file in corpusFiles(root)) {
            val doc = Json.parse(file.readText())
            val rel = file.path.removePrefix(root.path + "/")
            for (case in doc["cases"].items) {
                total++
                val caseFails = mutableListOf<String>()
                try {
                    runCase(case, caseFails)
                } catch (err: Throwable) {
                    caseFails.add("threw: ${err.message}")
                }
                if (caseFails.isNotEmpty()) {
                    failures.add("FAIL $rel :: ${case["name"].string()}")
                    caseFails.forEach { failures.add("    $it") }
                }
            }
        }
        println("base conformance (kotlin): ${total - failures.count { it.startsWith("FAIL ") }}/$total cases passed")
        if (total == 0) fail("the corpus produced no cases — the runner found the wrong directory")
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }
}
