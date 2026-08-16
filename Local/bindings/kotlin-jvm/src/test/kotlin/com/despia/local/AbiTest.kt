// AbiTest.kt - the parts of despia_local.h the corpus does not reach.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The corpus is about what an ACTION means, and it is platform-neutral on
// purpose. The three rules at the top of despia_local.h are about the SEAM -
// self-description, additive evolution, and the threading contract - and a
// platform-neutral fixture cannot assert them because they are statements about
// a loaded library. This file is where they are checked, on the one lane in this
// repository where the real library actually loads.

package com.despia.local

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AbiTest {

    private fun tempStore(): Pair<Store, java.io.File> {
        val dir = Files.createTempDirectory("despia-local-abi-").toFile()
        return Store(dir) to dir
    }

    // --- rule 1: self-description ----------------------------------------

    @Test
    fun `capabilities describes this build rather than a compiled-in assumption`() {
        val caps = Store.capabilities
        assertEquals(1, caps["schema_version"].int(), "the envelope carries its schema version")
        assertEquals(Store.abiVersion, caps["abi"].int(), "capabilities and the ABI symbol agree")
        assertTrue(caps["version"].string().isNotEmpty(), "the build reports its package version")
        assertTrue(caps["sqlite"]["version"].string().isNotEmpty(), "the SQLite underneath is named")

        val actions = caps["actions"].strings()
        // The action list is DATA, not an export table: adding one is an
        // implementation detail precisely because it is reported here.
        assertTrue(actions.containsAll(listOf("put", "get", "delete", "query", "stats")))
        assertTrue(actions.containsAll(listOf("savepoint", "release", "rollback")))
        assertTrue(actions.containsAll(listOf("snapshot", "snapshots", "restore", "export")))
        assertTrue(caps["limits"]["max_dimension"].int() > 0, "a limit a caller must respect is stated")
    }

    @Test
    fun `a caller adapts to the reported vector backend instead of assuming one`() {
        val caps = Store.capabilities
        val (store, dir) = tempStore()
        try {
            val embedding = Embedding("emb", 2, "r1")
            if (caps.has("vectors")) {
                // Present because this build carries it - so the vector actions
                // must be there too, and the capabilities row must not be empty.
                assertTrue(caps["vectors"]["backend"].string().isNotEmpty())
                assertTrue(caps["vectors"]["metrics"].strings().isNotEmpty())
                assertTrue(caps["actions"].strings().contains("index.search"))
                store.indexUpsert("docs", "d1", listOf(1.0, 0.0), embedding)
                assertEquals(1, store.indexInfo("docs")["count"].int())
            } else {
                // ABSENT, not empty: the build says so and the call answers typed
                // absence rather than crashing on the first search.
                val failure = assertFailsWith<LocalError> {
                    store.indexSearch("docs", listOf(1.0, 0.0), embedding, 1)
                }
                assertEquals("vectors_unavailable", failure.code)
            }
        } finally {
            store.close()
            dir.deleteRecursively()
        }
    }

    // --- rule 2: additive evolution --------------------------------------

    @Test
    fun `an unknown action is a typed answer, not undefined behaviour`() {
        val (store, dir) = tempStore()
        try {
            // A caller compiled against a newer manifest running on an older
            // library gets something it can branch on.
            val plain = assertFailsWith<LocalError> { store.call("vacuum") }
            assertEquals("unknown_action", plain.code)
            assertEquals("vacuum", plain.data["action"].string())

            // Including inside an action FAMILY: `index.` is a prefix this build
            // knows, which must not turn a name it does not know into something
            // else. NOTE the argument: today the index family validates its
            // `index` argument BEFORE resolving the action name, so the same call
            // without one answers `invalid_index` instead - a caller told "your
            // argument is wrong" when the truth is "this library is older than
            // you are". That ordering is reported in the S2 findings; this test
            // pins the behaviour the header promises, on the path that reaches it.
            val family = assertFailsWith<LocalError> {
                store.call("index.rebuild", jsonOf("index" to Json.Str("docs")))
            }
            assertEquals("unknown_action", family.code)
            assertEquals("index.rebuild", family.data["action"].string())
        } finally {
            store.close()
            dir.deleteRecursively()
        }
    }

    @Test
    fun `an unknown config field is ignored and a wrongly typed one is refused`() {
        val dir = Files.createTempDirectory("despia-local-cfg-").toFile()
        try {
            // Must-ignore on the way in: a newer host's extra field does not stop
            // an older library from opening the file.
            val ok = NativeStore.open(
                jsonOf(
                    "schema_version" to Json.Num(1.0),
                    "directory" to Json.Str(dir.absolutePath),
                    "not_a_real_field" to Json.Str("ignored"),
                ).render()
            )
            assertTrue(ok != 0L, "an unknown config field must be ignored, not fatal")
            NativeStore.close(ok)

            // A known field of the wrong type is a refusal, and the failure is
            // readable from the GLOBAL error because there is no handle to ask.
            val bad = NativeStore.open(
                jsonOf("schema_version" to Json.Num(1.0), "directory" to Json.Num(5.0)).render()
            )
            assertEquals(0L, bad, "a wrongly-typed known field must refuse to open")
            val raw = NativeStore.lastError(0L)
            assertNotNull(raw, "a refusal with no handle still reports why")
            assertTrue(Json.parse(raw)["code"].string().isNotEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }

    // --- rule 3: the threading contract ----------------------------------

    @Test
    fun `two handles on one directory see each other's committed writes`() {
        val dir = Files.createTempDirectory("despia-local-wal-").toFile()
        val writer = Store(dir)
        val reader = Store(dir)
        try {
            // The ABI's advice for concurrency is "open two handles", so the
            // advice has to actually work: savepoints are per-connection, and WAL
            // is what keeps the reader from blocking on the writer.
            writer.declareStore("notes")
            writer.put("notes", "n1", jsonOf("v" to Json.Num(1.0)))
            assertEquals(1, reader.get("notes", "n1")["value"]["v"].int())
        } finally {
            writer.close()
            reader.close()
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a closed store refuses further calls instead of using a dangling handle`() {
        val (store, dir) = tempStore()
        try {
            store.close()
            val failure = assertFailsWith<LocalError> { store.stats() }
            assertEquals("closed", failure.code)
            store.close()   // final AND idempotent: a double close is not a crash
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a path the ABI hands back names a file relatively, never absolutely`() {
        val (store, dir) = tempStore()
        try {
            store.declareStore("notes")
            store.put("notes", "n1", jsonOf("v" to Json.Num(1.0)))
            val url = store.snapshot("pre")["url"].string()
            // An absolute path would leak the app container's layout to whatever
            // asked, including the page surface, for no benefit to the caller.
            assertTrue(url.startsWith("file:///snapshots/"), "unexpected snapshot url: $url")
            assertTrue(!url.contains(dir.absolutePath), "the container path leaked into $url")
        } finally {
            store.close()
            dir.deleteRecursively()
        }
    }

    // --- W-VEC: provenance at the call site ------------------------------

    @Test
    fun `an embedding cannot be built without the provenance triple`() {
        // The typed value is the enforcement: there is no way to name an
        // embedding without a model, and a dimension outside the ABI's declared
        // range is refused before it can reach the store.
        assertFailsWith<IllegalArgumentException> { Embedding("", 4) }
        assertFailsWith<IllegalArgumentException> { Embedding("emb", 0) }
        assertFailsWith<IllegalArgumentException> { Embedding("emb", Embedding.MAX_DIMENSION + 1) }
        assertNull(Embedding.from(Json.parse("""{"dimension":4}""")), "a nameless embedder is not one")
        assertNull(Embedding.from(Json.parse("""{"model":"emb"}""")), "a widthless embedding is not one")
        assertEquals(Embedding("emb", 4, "r1"), Embedding.from(Json.parse("""{"model":"emb","dimension":4,"revision":"r1"}""")))
    }

    @Test
    fun `a vector that disagrees with its own declared width is refused before the round trip`() {
        val (store, dir) = tempStore()
        try {
            val failure = assertFailsWith<LocalError> {
                store.indexUpsert("docs", "d1", listOf(1.0, 0.0, 0.0), Embedding("emb", 4, "r1"))
            }
            assertEquals("embedding_mismatch", failure.code)
            assertEquals("dimension", failure.data["reason"].string())
            // The error names the fix, not just the fault.
            assertEquals("docs", failure.data["reindex"].string())
            assertEquals(0, store.indexInfo("docs")["count"].int(), "nothing was written")
        } finally {
            store.close()
            dir.deleteRecursively()
        }
    }

    @Test
    fun `the three drift reasons stay distinct because the fix differs for each`() {
        val caps = Store.capabilities
        if (!caps.has("vectors")) return   // typed absence: nothing to assert here
        val (store, dir) = tempStore()
        try {
            store.indexUpsert("docs", "d1", listOf(1.0, 0.0, 0.0, 0.0), Embedding("emb", 4, "r1"))

            val widened = assertFailsWith<LocalError> {
                store.indexSearch("docs", listOf(1.0, 0.0), Embedding("emb", 2, "r1"), 1)
            }
            assertEquals("dimension", widened.data["reason"].string())

            // The dangerous one: same width, different meaning. Without the model
            // id this search would return confident nonsense.
            val swapped = assertFailsWith<LocalError> {
                store.indexSearch("docs", listOf(1.0, 0.0, 0.0, 0.0), Embedding("other", 4, "r1"), 1)
            }
            assertEquals("model", swapped.data["reason"].string())
            assertEquals("emb", swapped.data["stored"].string())
            assertEquals("other", swapped.data["query"].string())

            val bumped = assertFailsWith<LocalError> {
                store.indexSearch("docs", listOf(1.0, 0.0, 0.0, 0.0), Embedding("emb", 4, "r2"), 1)
            }
            assertEquals("revision", bumped.data["reason"].string())

            // A revision that is absent on one side is still a difference: an
            // unversioned index and a versioned query are not the same embedder.
            val unversioned = assertFailsWith<LocalError> {
                store.indexSearch("docs", listOf(1.0, 0.0, 0.0, 0.0), Embedding("emb", 4), 1)
            }
            assertEquals("revision", unversioned.data["reason"].string())

            // And the escape hatch the errors point at actually works.
            store.indexReindex(
                "docs", Embedding("other", 4, "r1"),
                listOf(jsonOf("key" to Json.Str("d1"), "vector" to Json.arrayOfNumbers(listOf(1.0, 0.0, 0.0, 0.0)))),
            )
            assertEquals("other", store.indexInfo("docs")["embedding"]["model"].string())
            assertEquals(
                1,
                store.indexSearch("docs", listOf(1.0, 0.0, 0.0, 0.0), Embedding("other", 4, "r1"), 1)["hits"].items.size,
            )
        } finally {
            store.close()
            dir.deleteRecursively()
        }
    }
}
