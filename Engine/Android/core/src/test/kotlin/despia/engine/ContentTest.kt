package despia.engine

import java.io.File
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.io.TempDir

/**
 * DSXContent — the facade's contract: the manifest ACCEPTANCE RULE (the SPA-poison guard),
 * `absolute()` (the one host authority), the sync `folder()` law, the single-URL plane's
 * fresh/cached composition, and the batch verbs' bounded windows (6 / 3). Facade calls ride
 * `ContentStore.shared`, so its `fetch` seam is installed per test and restored after.
 */
class ContentTest {

    @TempDir
    lateinit var tmp: File

    private lateinit var fetch: FakeFetch
    private val origin = "https://app.example"

    @BeforeTest fun setUp() {
        ContentDisk.cacheRoot = File(tmp, "cache")
        ContentDisk.pinnedRoot = File(tmp, "pinned")
        ContentDisk.clock = { System.currentTimeMillis() }
        ContentDisk.seedIndex = { emptyMap() }
        ContentDisk.seedResource = { null }
        ContentStore.claimResolver = null
        ContentStore.trustGate = null
        DSXContent.contentBudgetMB = { 300 }
        DSXContent.contentMaxBlobMB = { 240 }
        DSXContent.resolvedOriginString = { null }
        DSXContent.contentRoot = { "/dsx" }
        fetch = FakeFetch()
        ContentStore.shared.fetch = fetch
    }

    @AfterTest fun tearDown() {
        ContentStore.shared.fetch = null
        DSXContent.resolvedOriginString = { null }
        DSXContent.contentRoot = { "/dsx" }
        DSXContent.contentBudgetMB = { 300 }
        DSXContent.contentMaxBlobMB = { 240 }
    }

    // MARK: helpers

    private class FakeFetch : ContentFetch {
        val bodies = HashMap<String, ByteArray>()
        val statuses = HashMap<String, Int>()
        var delayMs = 0L
        val calls: MutableList<String> = Collections.synchronizedList(ArrayList())
        val concurrent = AtomicInteger(0)
        val maxConcurrent = AtomicInteger(0)

        override suspend fun data(url: String): ContentResponse? {
            calls.add(url)
            val c = concurrent.incrementAndGet()
            maxConcurrent.updateAndGet { maxOf(it, c) }
            try { if (delayMs > 0) delay(delayMs) } finally { concurrent.decrementAndGet() }
            val body = bodies[url] ?: return ContentResponse(statuses[url] ?: 404, ByteArray(0))
            return ContentResponse(statuses[url] ?: 200, body)
        }
    }

    private fun bytes(size: Int, seed: Int = 0): ByteArray = ByteArray(size) { ((it + seed) % 251).toByte() }

    private fun serve(path: String, files: Map<String, ByteArray>): String {
        val root = DSXContent.absolute(path, origin)
        val entries = files.entries.joinToString(",") { (p, b) ->
            """{"path":"$p","sha256":"${ContentDisk.hashData(b)}"}"""
        }
        fetch.bodies[root + "manifest.json"] = """{"files":[$entries]}""".toByteArray()
        for ((rel, b) in files) fetch.bodies[root + rel] = b
        return root
    }

    // MARK: the acceptance rule (SPA-poison guard, kernel law)

    @Test fun manifestParseAbsorbsEveryDeployedShape() {
        val digest = "ab".repeat(32)
        val m = ContentManifest.parse(
            """{"version":3,"deployed_at":"2026-07-01","meta":{"k":"v"},"scene":"main",
                "files":[{"path":"a.bin","sha256":"$digest","bytes":10},
                         {"path":"b.bin"}]}""")!!
        assertEquals(3L, m.version)
        assertEquals("2026-07-01", m.deployedAt)
        assertEquals("v", m.meta["k"])
        assertEquals("main", m.raw["scene"])                      // unknown keys ride in raw
        assertEquals(2, m.files.size)
        assertEquals(digest, m.files[0].sha256)
        assertEquals(10L, m.files[0].bytes)
        assertNull(m.files[1].sha256)                             // hash-less entry

        val godot = ContentManifest.parse(
            """{"bundles":[{"path":"p.pck","sha256":"${"aa".repeat(32)}","size":7}]}""",
        )!!
        assertEquals(7L, godot.files[0].bytes)                    // `size` is `bytes`

        val web = ContentManifest.parse("""{"assets":["app.js", "style.css"]}""")!!
        assertEquals(listOf("app.js", "style.css"), web.files.map { it.path })
        assertTrue(web.files.all { it.sha256 == null })

        val emptySha = ContentManifest.parse("""{"files":[{"path":"x","sha256":""}]}""")!!
        assertNull(emptySha.files[0].sha256)                      // exact empty = deployed hash-less shape
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","sha256":"  "}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","sha256":"${"AB".repeat(32)}"}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","sha256":"abcd"}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","sha256":"${"g".repeat(64)}"}]}"""))
        assertNull(ContentManifest.parse("""{"version":1.5,"files":[]}"""))
        assertNull(ContentManifest.parse("""{"version":1.0,"files":[]}"""))
        assertNull(ContentManifest.parse("""{"version":1e0,"files":[]}"""))
        assertNull(ContentManifest.parse("""{"version":-1,"files":[]}"""))
        assertNull(ContentManifest.parse("""{"version":9223372036854775808,"files":[]}"""))
        assertNull(ContentManifest.parse(mapOf("version" to Double.NaN, "files" to emptyList<Any>())))
        assertNull(ContentManifest.parse(mapOf("version" to Double.POSITIVE_INFINITY, "files" to emptyList<Any>())))
        assertNull(ContentManifest.parse(mapOf("version" to "1", "files" to emptyList<Any>())))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","bytes":1.5}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","bytes":-1}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","bytes":9223372036854775808}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"x","bytes":null}]}"""))
        assertEquals(
            Long.MAX_VALUE,
            ContentManifest.parse("""{"version":9223372036854775807,"files":[]}""")!!.version,
        )
    }

    @Test fun manifestParseRejectsEverythingThatIsNotAManifest() {
        assertNull(ContentManifest.parse(null))
        assertNull(ContentManifest.parse("<!doctype html><html>SPA catch-all</html>"))
        assertNull(ContentManifest.parse("not json at all"))
        assertNull(ContentManifest.parse("[1,2,3]"))              // array root: not an object
        assertNull(ContentManifest.parse("42"))                   // scalar fragment
        assertNull(ContentManifest.parse("{}"))                   // object with no file list
        assertNull(ContentManifest.parse("""{"files":{"not":"an array"}}"""))
        assertNull(ContentManifest.parse("""{"files":[null]}"""))
        assertNull(ContentManifest.parse("""{"files":[{}]}"""))
        assertNull(ContentManifest.parse("""{"files":[{"path":"/absolute"}]}"""))
        assertNull(ContentManifest.parse("""{"files":["a//b"]}"""))
        assertNull(ContentManifest.parse("""{"files":["a", "a"]}"""))
        assertNull(ContentManifest.parse("""{"assets":[""]}"""))
        assertNotNull(ContentManifest.parse("""{"files":[]}"""))  // a genuinely empty manifest IS valid
        val tooMany = List(ContentManifest.MAXIMUM_ENTRIES + 1) { "asset-$it" }
        assertNull(ContentManifest.parse(mapOf("files" to tooMany)))
        val longPath = "x".repeat(ContentManifest.MAXIMUM_PATH_UTF8_BYTES + 1)
        assertNull(ContentManifest.parse(mapOf("files" to listOf(longPath))))
    }

    @Test fun blobLookupRejectsEveryNonDigestPathBeforeFilesystemResolution() {
        assertNull(ContentDisk.blobURL("../" + "a".repeat(61)))
        assertNull(ContentDisk.blobURL("A".repeat(64)))
        assertNull(ContentDisk.blobURL("g".repeat(64)))
        assertFalse(ContentDisk.hasBlob("../" + "a".repeat(61)))
    }

    // MARK: absolute (the one host authority)

    @Test fun absoluteResolvesThroughHostAndContentRoot() {
        DSXContent.resolvedOriginString = { "example.com" }
        assertEquals("https://example.com/dsx/runner/", DSXContent.absolute("/runner"))
        assertEquals("https://example.com/dsx/runner/", DSXContent.absolute("runner"))
        assertEquals("https://example.com/dsx/", DSXContent.absolute(""))
        // An explicit origin is an explicit location — the content root does NOT apply.
        assertEquals("https://cdn.example/runner/", DSXContent.absolute("/runner", "https://cdn.example/"))
        assertEquals("https://cdn.example/runner/", DSXContent.absolute("/runner", "cdn.example"))
        // An absolute path is the exact location, unchanged (just "/"-terminated).
        assertEquals("https://x.example/y/", DSXContent.absolute("https://x.example/y"))
        assertEquals("http://x.example/y/", DSXContent.absolute("http://x.example/y/"))
        // A dev-origin override carries scheme+port through untouched.
        DSXContent.resolvedOriginString = { "http://localhost:3000" }
        assertEquals("http://localhost:3000/dsx/app/", DSXContent.absolute("/app"))
    }

    @Test fun absoluteWithNoHostAnywhereFailsCleanlyIntoTheOfflineChain() {
        assertEquals("https:/dsx/runner/", DSXContent.absolute("/runner"))   // authority-less by design
        // …and prepare on it degrades to NoManifest (fetch fails, no seed) — never a crash.
        val e = runCatching { runBlocking { DSXContent.prepare("/never-hosted") } }.exceptionOrNull()
        assertTrue(e is ContentError.NoManifest, "expected NoManifest, got $e")
        assertNull(DSXContent.folder("/never-hosted"))
    }

    // MARK: folder() — the never-block law

    @Test fun folderIsSynchronousServesLastKnownGoodAndNeverNetworks() = runBlocking {
        serve("/screen", mapOf("index.dsx" to bytes(120, 1)))
        assertNull(DSXContent.folder("/screen", origin))          // null until ever prepared
        val prepared = DSXContent.prepare("/screen", origin)
        val calls = fetch.calls.size
        val sync = DSXContent.folder("/screen", origin)
        assertNotNull(sync)
        assertEquals(prepared.generation, sync.generation)
        assertEquals(calls, fetch.calls.size)                     // zero network on the sync path
        // The manifest name is part of the folder's identity.
        assertNull(DSXContent.folder("/screen", origin, "godot-manifest.json"))
    }

    @Test fun folderHandleReadsUrlDataTextAndBatch() = runBlocking {
        val index = "screen".toByteArray()
        val meta = """{"ok":true}""".toByteArray()
        serve("/handle", mapOf("index.dsx" to index, "meta/info.json" to meta))
        val folder = DSXContent.prepare("/handle", origin)
        assertEquals("screen", folder.text("index.dsx"))
        assertTrue(folder.url("meta/info.json")!!.exists())
        val batch = folder.data(listOf("index.dsx", "meta/info.json", "missing.bin"))
        assertEquals(2, batch.size)                               // a missing rel is simply absent
        assertEquals(index.toList(), batch["index.dsx"]!!.toList())
        assertEquals(meta.toList(), batch["meta/info.json"]!!.toList())
    }

    // MARK: the single-URL plane

    @Test fun fileComposesFreshElseCached() = runBlocking {
        val url = "$origin/api/feed.json"
        val v1 = bytes(64, 1)
        fetch.bodies[url] = v1
        assertNull(DSXContent.cachedFile(url))                    // null until file() ever succeeded
        assertTrue(DSXContent.file(url)!!.contentEquals(v1))
        assertTrue(DSXContent.cachedFile(url)!!.contentEquals(v1))
        // The host breaks: freshFile fails, the cached copy keeps serving (the fetchText contract).
        fetch.statuses[url] = 503
        assertNull(DSXContent.freshFile(url))
        assertTrue(DSXContent.file(url)!!.contentEquals(v1))
        assertTrue(DSXContent.cachedFile(url)!!.contentEquals(v1))
    }

    // MARK: batch verbs (bounded windows — the cross-platform map contract)

    @Test fun filesFetchesConcurrentlyBoundedToSixAndSkipsFailures() = runBlocking {
        val urls = (1..8).map { "$origin/asset/$it.bin" }
        for ((i, u) in urls.withIndex()) if (i != 3) fetch.bodies[u] = bytes(32, i)  // one 404s
        fetch.delayMs = 60
        val out = DSXContent.files(urls)
        assertEquals(7, out.size)                                 // the failed URL is simply absent
        assertFalse(out.containsKey(urls[3]))
        assertTrue(fetch.maxConcurrent.get() <= 6, "window 6 exceeded: ${fetch.maxConcurrent.get()}")
        for ((i, u) in urls.withIndex()) if (i != 3) assertTrue(out[u]!!.contentEquals(bytes(32, i)))
    }

    @Test fun prepareAllResolvesConcurrentlyBoundedToThreeAndSkipsFailures() = runBlocking {
        serve("/m1", mapOf("a.bin" to bytes(50, 1)))
        serve("/m2", mapOf("b.bin" to bytes(50, 2)))
        serve("/m3", mapOf("c.bin" to bytes(50, 3)))
        fetch.delayMs = 60                                        // "/m4" has no manifest → absent
        val out = DSXContent.prepareAll(listOf("/m1", "/m2", "/m3", "/m4"), origin)
        assertEquals(setOf("/m1", "/m2", "/m3"), out.keys)
        assertNotNull(out["/m2"]!!.url("b.bin"))
        assertTrue(fetch.maxConcurrent.get() <= 3, "window 3 exceeded: ${fetch.maxConcurrent.get()}")
    }

    // MARK: stats

    @Test fun statsReportsBudgetSizesAndCounts() = runBlocking {
        serve("/stat", mapOf("s.bin" to bytes(2000, 4)))
        DSXContent.prepare("/stat", origin)
        DSXContent.contentBudgetMB = { 123 }
        val stats = DSXContent.stats()
        assertEquals(123, stats["budget_mb"])
        assertTrue((stats["cache_bytes"] as Long) >= 2000L)
        assertEquals(1, stats["folders"])
        assertEquals(1, stats["blobs"])
    }
}
