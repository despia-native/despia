package despia.engine

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.Base64
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.io.TempDir

/**
 * ContentStore/ContentDisk — the store's disk format and mutation core against a REAL
 * filesystem (@TempDir): atomic generation flips, dedup, all-or-nothing publishes, LRU
 * eviction order, concurrent single-flight, purge healing, tiers, signing. Every seam is
 * re-pointed in setUp so tests are hermetic; the fetch seam is a fake (never a socket).
 */
class ContentStoreTest {

    @TempDir
    lateinit var tmp: File

    private lateinit var store: ContentStore
    private lateinit var fetch: FakeFetch
    private var now = 1_720_000_000_000L
    private val origin = "https://app.example"

    @BeforeTest fun setUp() {
        ContentDisk.cacheRoot = File(tmp, "cache")
        ContentDisk.pinnedRoot = File(tmp, "pinned")
        now = 1_720_000_000_000L
        ContentDisk.clock = { now }
        ContentDisk.seedIndex = { emptyMap() }
        ContentDisk.seedResource = { null }
        ContentDisk.ownOrigin = { DSXContent.resolvedOriginString() }
        ContentStore.claimResolver = null
        ContentStore.trustGate = null
        DSXContent.contentBudgetMB = { 300 }
        DSXContent.contentMaxBlobMB = { 240 }
        DSXContent.resolvedOriginString = { null }
        DSXContent.contentRoot = { "/dsx" }
        fetch = FakeFetch()
        store = ContentStore().also { it.fetch = fetch }
    }

    @AfterTest fun tearDown() {
        ContentDisk.clock = { System.currentTimeMillis() }
        ContentStore.claimResolver = null
        ContentStore.trustGate = null
        DSXContent.contentBudgetMB = { 300 }
        DSXContent.contentMaxBlobMB = { 240 }
    }

    // MARK: helpers

    private class FakeFetch : ContentFetch {
        val bodies = HashMap<String, ByteArray>()
        val statuses = HashMap<String, Int>()
        val headerMap = HashMap<String, Map<String, String>>()
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
            return ContentResponse(statuses[url] ?: 200, body, headerMap[url] ?: emptyMap())
        }

        fun count(url: String): Int = synchronized(calls) { calls.count { it == url } }
    }

    private class FakeGate(
        var on: Boolean = true,
        var bad: Boolean = false,
        var accept: (ByteArray, ByteArray) -> Boolean = { _, _ -> true },
    ) : ContentTrustGate {
        override val requiresVerification get() = on
        override val isMisconfigured get() = bad
        override fun verify(manifest: ByteArray, signature: ByteArray) = accept(manifest, signature)
    }

    private fun bytes(size: Int, seed: Int = 0): ByteArray = ByteArray(size) { ((it + seed) % 251).toByte() }

    private fun manifestText(files: Map<String, ByteArray>, hashless: Boolean = false,
                             extra: String = ""): String {
        val entries = files.entries.joinToString(",") { (p, b) ->
            if (hashless) """{"path":"$p"}"""
            else """{"path":"$p","sha256":"${ContentDisk.hashData(b)}"}"""
        }
        return """{"files":[$entries]$extra}"""
    }

    /// Host a folder on the fake network: manifest + files under the resolved root.
    private fun serve(path: String, files: Map<String, ByteArray>, hashless: Boolean = false,
                      extra: String = ""): String {
        val root = DSXContent.absolute(path, origin)
        fetch.bodies[root + "manifest.json"] = manifestText(files, hashless, extra).toByteArray()
        for ((rel, b) in files) fetch.bodies[root + rel] = b
        return root
    }

    private suspend fun prep(path: String, seed: ContentSeed? = null, pinned: Boolean = false,
                             s: ContentStore = store): ContentFolder =
        s.prepare(path, origin, "manifest.json", seed, pinned, null)

    private suspend fun refresh(path: String, s: ContentStore = store): ContentFolder? =
        s.refresh(path, origin, "manifest.json", null)

    private fun folderDirOf(path: String): File? =
        ContentDisk.existingFolderDir(
            ContentDisk.folderKey(DSXContent.absolute(path, origin), "manifest.json"))

    // MARK: cold resolve + read-back

    @Test fun coldPrepareResolvesPublishesAndReadsBack() = runBlocking {
        val a = bytes(1000, 1); val b = bytes(2000, 2)
        serve("/runner", mapOf("index.dsx" to a, "sub/pack.bin" to b))
        val folder = prep("/runner")
        assertEquals(a.toList(), folder.data("index.dsx")!!.toList())
        assertEquals(b.toList(), folder.data("sub/pack.bin")!!.toList())
        assertNull(folder.url("ghost.bin"))
        // The sync read path serves the same generation with ZERO network.
        val before = fetch.calls.size
        val sync = DSXContent.folder("/runner", origin)
        assertNotNull(sync)
        assertEquals(folder.generation, sync.generation)
        assertEquals(before, fetch.calls.size)
        // current pointer + both gens artifacts on disk
        val dir = folderDirOf("/runner")!!
        assertEquals(folder.generation, ContentDisk.readPointer(dir, "current"))
        assertTrue(File(File(dir, "gens"), folder.generation + ".json").exists())
        assertTrue(File(File(dir, "gens"), folder.generation + ".blobmap").exists())
    }

    // MARK: atomic flip + keep-two

    @Test fun publishFlipsCurrentAtomicallyAndKeepsPreviousForRollback() = runBlocking {
        serve("/app", mapOf("main.js" to bytes(500, 1)))
        val g1 = prep("/app").generation
        serve("/app", mapOf("main.js" to bytes(500, 9)))          // one changed file = a new generation
        val g2 = refresh("/app")!!.generation
        assertNotEquals(g1, g2)
        val dir = folderDirOf("/app")!!
        assertEquals(g2, ContentDisk.readPointer(dir, "current"))
        assertEquals(g1, ContentDisk.readPointer(dir, "previous"))  // rollback safety
        assertEquals(g2, DSXContent.folder("/app", origin)!!.generation)
        // A third deploy prunes to the keep-two rule: only current+previous artifacts remain.
        serve("/app", mapOf("main.js" to bytes(500, 33)))
        val g3 = refresh("/app")!!.generation
        val gens = File(dir, "gens").listFiles()!!.map { it.name }.sorted()
        assertEquals(listOf("$g2.blobmap", "$g2.json", "$g3.blobmap", "$g3.json").sorted(), gens)
    }

    // MARK: all-or-nothing

    @Test fun allOrNothingAbandonsTheGenerationWhenAFileFails() = runBlocking {
        val root = DSXContent.absolute("/broken", origin)
        val good = bytes(100, 1); val missing = bytes(100, 2)
        fetch.bodies[root + "manifest.json"] =
            manifestText(mapOf("ok.bin" to good, "gone.bin" to missing)).toByteArray()
        fetch.bodies[root + "ok.bin"] = good                       // gone.bin 404s
        val e = runCatching { prep("/broken") }.exceptionOrNull()
        assertTrue(e is ContentError.Missing, "expected Missing, got $e")
        assertNull(DSXContent.folder("/broken", origin))           // nothing published, not even partially
        assertNull(folderDirOf("/broken"))
    }

    @Test fun failedRevalidationKeepsTheLastKnownGoodGenerationWhole() = runBlocking {
        serve("/game", mapOf("pack.bin" to bytes(300, 1)))
        val g1 = prep("/game").generation
        // New deploy declares a second file the host then fails to serve.
        val root = DSXContent.absolute("/game", origin)
        val v2 = mapOf("pack.bin" to bytes(300, 5), "extra.bin" to bytes(50, 6))
        fetch.bodies[root + "manifest.json"] = manifestText(v2).toByteArray()
        fetch.bodies[root + "pack.bin"] = v2["pack.bin"]!!         // extra.bin 404s
        val after = refresh("/game")
        assertEquals(g1, after!!.generation)                       // last-good keeps serving
        assertEquals(g1, DSXContent.folder("/game", origin)!!.generation)
    }

    // MARK: dedup

    @Test fun identicalBytesAcrossFoldersAndPublishesStoreOneBlob() = runBlocking {
        val sharedBytes = bytes(4096, 7)
        serve("/f1", mapOf("a.bin" to sharedBytes))
        serve("/f2", mapOf("b.bin" to sharedBytes))
        val f1 = prep("/f1"); val f2 = prep("/f2")
        assertEquals(f1.url("a.bin")!!.path, f2.url("b.bin")!!.path)   // one blob, two folders
        val sha = ContentDisk.hashData(sharedBytes)
        val blobs = File(ContentDisk.cacheRoot, "blobs/sha256").listFiles()!!.filter { it.name == sha }
        assertEquals(1, blobs.size)
    }

    // MARK: single-flight

    @Test fun concurrentPreparesShareOneBlobTransfer() = runBlocking {
        val big = bytes(10_000, 3)
        val root = serve("/pack", mapOf("pack.bin" to big))
        fetch.delayMs = 120
        val results = listOf(
            async { prep("/pack") },
            async { prep("/pack") },
        ).awaitAll()
        assertEquals(results[0].generation, results[1].generation)
        assertEquals(1, fetch.count(root + "pack.bin"))            // the sha-keyed flight was shared
    }

    @Test fun concurrentFreshFilesShareOneConditionalGet() = runBlocking {
        val url = "$origin/api/config.json"
        fetch.bodies[url] = bytes(256, 4)
        fetch.delayMs = 120
        val results = listOf(
            async { store.freshFile(url) },
            async { store.freshFile(url) },
        ).awaitAll()
        assertEquals(1, fetch.count(url))
        assertTrue(results.all { it != null && it.contentEquals(fetch.bodies[url]!!) })
        // remembered for the sync plane
        assertTrue(ContentDisk.cachedFile(url)!!.contentEquals(fetch.bodies[url]!!))
    }

    // MARK: stale-while-revalidate

    @Test fun unchangedShaPinnedManifestShortCircuitsWithoutReacquire() = runBlocking {
        val root = serve("/site", mapOf("app.js" to bytes(800, 2)))
        val g1 = prep("/site").generation
        assertEquals(1, fetch.count(root + "app.js"))
        val g2 = refresh("/site")!!.generation                      // identical manifest bytes
        assertEquals(g1, g2)
        assertEquals(1, fetch.count(root + "app.js"))               // no re-download
        assertEquals(2, fetch.count(root + "manifest.json"))        // the manifest check itself ran
    }

    @Test fun hashlessManifestWithNoDeployStampRehashesOnRefresh() = runBlocking {
        val root = serve("/loose", mapOf("data.json" to bytes(64, 8)), hashless = true)
        val g1 = prep("/loose").generation
        val g2 = refresh("/loose")!!.generation                     // nothing but fresh bytes can detect change
        assertEquals(g1, g2)                                        // same bytes ⇒ same generation
        assertEquals(2, fetch.count(root + "data.json"))            // but the bytes WERE re-fetched
    }

    @Test fun contentUpdatedFiresExactlyOnceOnARealGenerationChange() = runBlocking {
        val events = ArrayList<Any?>()
        val sub = DSXEvents().on("content.updated") { _, data -> events.add(data) }
        try {
            serve("/news", mapOf("feed.json" to bytes(100, 1)))
            prep("/news")                                           // cold publish: no update bell
            assertEquals(0, events.size)
            serve("/news", mapOf("feed.json" to bytes(100, 2)))
            val g2 = refresh("/news")!!.generation
            assertEquals(1, events.size)                            // rings ONCE
            @Suppress("UNCHECKED_CAST")
            assertEquals(g2, (events[0] as Map<String, Any?>)["generation"])
            refresh("/news")                                        // unchanged: silent
            assertEquals(1, events.size)
        } finally {
            sub.cancel()
        }
    }

    // MARK: purge healing

    @Test fun prepareHealsPurgeHolesAgainstTheCurrentGeneration() = runBlocking {
        val body = bytes(2048, 5)
        val root = serve("/pinnedish", mapOf("model.bin" to body))
        val folder = prep("/pinnedish")
        val sha = ContentDisk.hashData(body)
        ContentDisk.blobPath(ContentDisk.cacheRoot, sha).delete()   // the OS purge
        assertNull(folder.url("model.bin"))                         // hole visible on the old handle
        val healed = prep("/pinnedish")                             // same generation, holes refilled
        assertEquals(folder.generation, healed.generation)
        assertNotNull(healed.url("model.bin"))
        assertEquals(2, fetch.count(root + "model.bin"))
        // Warm prepare intentionally starts SWR. The actual Deferred is registered before
        // prepare returns, so refresh joins that exact pass and leaves no disk writer racing
        // JUnit's @TempDir cleanup.
        assertEquals(folder.generation, refresh("/pinnedish")?.generation)
    }

    // MARK: LRU eviction

    @Test fun budgetEvictsLeastRecentlyTouchedNonSessionFolderFirst() = runBlocking<Unit> {
        DSXContent.contentBudgetMB = { 1 }                          // 1 MB hard cap
        serve("/a", mapOf("a.bin" to bytes(500_000, 1)))
        serve("/b", mapOf("b.bin" to bytes(500_000, 2)))
        serve("/c", mapOf("c.bin" to bytes(500_000, 3)))
        val s1 = ContentStore().also { it.fetch = fetch }
        prep("/a", s = s1)
        now += 10_000
        prep("/b", s = s1)
        now += 10_000
        val s2 = ContentStore().also { it.fetch = fetch }           // a NEW session: a/b are evictable
        prep("/c", s = s2)                                          // publish trips the budget sweep
        assertNull(folderDirOf("/a"))                               // LRU-first: /a went
        assertNotNull(folderDirOf("/b"))
        assertNotNull(folderDirOf("/c"))                            // the publishing folder is shielded
        assertNull(DSXContent.folder("/a", origin))
        assertNotNull(DSXContent.folder("/b", origin))
    }

    // MARK: blob GC grace

    @Test fun gcGraceKeepsFreshOrphansAndCollectsStaleOnes() {
        val orphan = bytes(128, 9)
        val sha = ContentDisk.hashData(orphan)
        ContentDisk.ingest(data = orphan, sha = sha)                // no generation references it
        ContentDisk.gcBlobs()
        assertTrue(ContentDisk.hasBlob(sha))                        // inside the one-hour ingest grace
        now += 3_700_000
        ContentDisk.gcBlobs()
        assertFalse(ContentDisk.hasBlob(sha))                       // grace over, orphan collected
    }

    // MARK: pin (tier moves)

    @Test fun pinMovesTheFolderAndMakesItSelfContained() = runBlocking {
        val body = bytes(1024, 6)
        serve("/offline", mapOf("app.bin" to body))
        val folder = prep("/offline")
        val sha = ContentDisk.hashData(body)
        store.pin("/offline", origin, "manifest.json", true)
        val dir = folderDirOf("/offline")!!
        assertTrue(dir.path.startsWith(ContentDisk.pinnedRoot.path))          // relocated
        assertTrue(ContentDisk.blobPath(ContentDisk.pinnedRoot, sha).exists())// blobs cloned FIRST
        assertEquals(folder.generation, DSXContent.folder("/offline", origin)!!.generation)
        // The cache-tier twin is collectible once the grace passes (tier-aware GC).
        now += 3_700_000
        ContentDisk.gcBlobs()
        assertFalse(ContentDisk.blobPath(ContentDisk.cacheRoot, sha).exists())
        assertTrue(ContentDisk.blobPath(ContentDisk.pinnedRoot, sha).exists())
        // Unpin returns it to the purgeable tier.
        store.pin("/offline", origin, "manifest.json", false)
        assertTrue(folderDirOf("/offline")!!.path.startsWith(ContentDisk.cacheRoot.path))
    }

    @Test fun pinnedPrepareLandsTheFirstPublishInTheNeverPurgedTier() = runBlocking {
        val body = bytes(512, 2)
        serve("/boot", mapOf("web.bin" to body))
        prep("/boot", pinned = true)
        assertTrue(folderDirOf("/boot")!!.path.startsWith(ContentDisk.pinnedRoot.path))
        assertTrue(ContentDisk.blobPath(ContentDisk.pinnedRoot, ContentDisk.hashData(body)).exists())
    }

    // MARK: evict

    @Test fun evictDropsBothTiersAndTheSyncHandle() = runBlocking {
        serve("/gone", mapOf("x.bin" to bytes(64, 1)))
        prep("/gone")
        assertNotNull(DSXContent.folder("/gone", origin))
        store.evict("/gone", origin, "manifest.json")
        assertNull(DSXContent.folder("/gone", origin))
        assertNull(folderDirOf("/gone"))
    }

    // MARK: seeds (never-network paths — fetch stays null)

    @Test fun bundledSeedResolvesWithZeroNetwork() = runBlocking<Unit> {
        val offline = ContentStore()                                 // fetch = null: NEVER network
        val packBytes = bytes(900, 4)
        val seedFile = File(tmp, "seed-pack.bin").apply { writeBytes(packBytes) }
        ContentDisk.seedResource = { name -> if (name == "seed-pack.bin") seedFile else null }
        val seed = ContentSeed(
            manifestText = { manifestText(mapOf("pack.bin" to packBytes)) },
            fileURL = { rel -> if (rel == "pack.bin") seedFile else null },
        )
        val folder = prep("/demo", seed = seed, s = offline)
        assertEquals(seedFile.path, folder.url("pack.bin")!!.path)   // zero-copy: the bundle IS the source
        assertFalse(ContentDisk.hasBlob(ContentDisk.hashData(packBytes)))  // nothing duplicated into the CAS
        assertNotNull(DSXContent.folder("/demo", origin))
    }

    @Test fun declaredSeedBacksItsMountAndPinnedSteersTheTier() = runBlocking {
        val offline = ContentStore()
        val fileBytes = bytes(256, 3)
        val seedFile = File(tmp, "demo.dsx").apply { writeBytes(fileBytes) }
        ContentDisk.seedResource = { name -> if (name == "demo.dsx") seedFile else null }
        ContentDisk.seedIndex = {
            mapOf("/demo" to mapOf("manifest.json" to mapOf(
                "manifest" to manifestText(mapOf("demo.dsx" to fileBytes)), "pinned" to true)))
        }
        val folder = offline.prepare("/demo", "", "manifest.json", null, false, null)
        assertEquals(fileBytes.toList(), folder.data("demo.dsx")!!.toList())
        assertTrue(folder.folderDir.path.startsWith(ContentDisk.pinnedRoot.path))  // `pinned: true` steered it
        // An explicit origin is an explicit location: the declared seed does NOT apply there.
        assertNull(ContentDisk.declaredSeed("/demo", "https://cdn.example", "manifest.json"))
    }

    @Test fun bootFolderSeedResolvesOnTheAppsOwnOriginOnly() = runBlocking {
        // The bundled floor (bundled-floor.md): the web-bundle boot folder resolves with the
        // app's OWN host as an EXPLICIT origin — its declared seed must be found there, and
        // ONLY there. First launch, airplane mode: prepare publishes generation zero.
        val offline = ContentStore()                                  // fetch = null: NEVER network
        val page = "<html>floor</html>".toByteArray()
        val seedFile = File(tmp, "index.html").apply { writeBytes(page) }
        ContentDisk.seedResource = { name -> if (name == "index.html") seedFile else null }
        ContentDisk.seedIndex = {
            mapOf("/" to mapOf("despia/local.json" to mapOf(
                "manifest" to manifestText(mapOf("index.html" to page)), "pinned" to true)))
        }
        ContentDisk.ownOrigin = { "https://app.example" }             // what ContentServer installs
        // The boot identity (scheme + host, trailing slash tolerated) finds the seed…
        assertNotNull(ContentDisk.declaredSeed("/", "https://app.example", "despia/local.json"))
        assertNotNull(ContentDisk.declaredSeed("/", "https://APP.example/", "despia/local.json"))
        // …a foreign host never does, and the wrong manifest name never does.
        assertNull(ContentDisk.declaredSeed("/", "https://evil.example", "despia/local.json"))
        assertNull(ContentDisk.declaredSeed("/", "https://app.example", "manifest.json"))
        // And the cold offline boot resolve itself: generation zero publishes and serves.
        val folder = offline.prepare("/", origin, "despia/local.json", null, true, null)
        assertEquals(page.toList(), folder.data("index.html")!!.toList())
        assertTrue(folder.folderDir.path.startsWith(ContentDisk.pinnedRoot.path))
    }

    @Test fun assetUrlClaimServesLocallySyncedBytes() = runBlocking {
        val offline = ContentStore()
        val body = bytes(700, 8)
        val localManifest = File(tmp, "m.json").apply { writeBytes(manifestText(mapOf("a.bin" to body)).toByteArray()) }
        val localFile = File(tmp, "a.bin").apply { writeBytes(body) }
        ContentStore.claimResolver = { key ->
            when (key) {
                "/sync/manifest.json" -> localManifest.toURI().toString()
                "/sync/a.bin" -> localFile.toURI().toString()
                else -> null
            }
        }
        val folder = prep("/sync", s = offline)
        assertEquals(body.toList(), folder.data("a.bin")!!.toList())
    }

    @Test fun localManifestClaimIsBoundedToFourMiB() = runBlocking {
        val offline = ContentStore()
        val localManifest = File(tmp, "oversized-manifest.json").apply {
            writeText(
                "{\"files\":[],\"meta\":{\"padding\":\"" +
                    "x".repeat(ContentStore.MAX_LOCAL_MANIFEST_BYTES.toInt()) +
                    "\"}}",
            )
        }
        ContentStore.claimResolver = { key ->
            if (key == "/oversized-manifest/manifest.json") localManifest.toURI().toString() else null
        }

        val failure = runCatching { prep("/oversized-manifest", s = offline) }.exceptionOrNull()
        assertTrue(failure is ContentError.NoManifest, "expected NoManifest, got $failure")
        assertNull(folderDirOf("/oversized-manifest"))
    }

    @Test fun localAssetClaimRejectsSymlinksAndLeavesNoBlob() = runBlocking {
        val offline = ContentStore()
        val body = bytes(512, 17)
        val sha = ContentDisk.hashData(body)
        val localManifest = File(tmp, "symlink-manifest.json").apply {
            writeText("""{"files":[{"path":"a.bin","sha256":"$sha"}]}""")
        }
        val target = File(tmp, "symlink-target.bin").apply { writeBytes(body) }
        val link = File(tmp, "symlink-claim.bin")
        java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
        ContentStore.claimResolver = { key ->
            when (key) {
                "/symlink/manifest.json" -> localManifest.toURI().toString()
                "/symlink/a.bin" -> link.toURI().toString()
                else -> null
            }
        }

        val failure = runCatching { prep("/symlink", s = offline) }.exceptionOrNull()
        assertTrue(failure is ContentError.Missing, "expected Missing, got $failure")
        assertFalse(ContentDisk.hasBlob(sha))
        assertNull(folderDirOf("/symlink"))
    }

    @Test fun localAssetClaimAndDownloadedBytesEnforceConfiguredCeiling() = runBlocking {
        DSXContent.contentMaxBlobMB = { 1 }
        val tooLarge = bytes(1_048_577, 23)
        val sha = ContentDisk.hashData(tooLarge)

        val offline = ContentStore()
        val localManifest = File(tmp, "large-claim-manifest.json").apply {
            writeText("""{"files":[{"path":"asset.bin","sha256":"$sha"}]}""")
        }
        val localAsset = File(tmp, "large-claim.bin").apply { writeBytes(tooLarge) }
        ContentStore.claimResolver = { key ->
            when (key) {
                "/large-claim/manifest.json" -> localManifest.toURI().toString()
                "/large-claim/asset.bin" -> localAsset.toURI().toString()
                else -> null
            }
        }
        val localFailure = runCatching { prep("/large-claim", s = offline) }.exceptionOrNull()
        assertTrue(localFailure is ContentError.Missing, "expected Missing, got $localFailure")
        assertFalse(ContentDisk.hasBlob(sha))

        ContentStore.claimResolver = null
        val root = DSXContent.absolute("/large-network", origin)
        fetch.bodies[root + "manifest.json"] = manifestText(mapOf("asset.bin" to tooLarge)).toByteArray()
        fetch.bodies[root + "asset.bin"] = tooLarge
        val networkFailure = runCatching { prep("/large-network") }.exceptionOrNull()
        assertTrue(networkFailure is ContentError.Missing, "expected Missing, got $networkFailure")
        assertFalse(ContentDisk.hasBlob(sha))
        assertTrue(ContentDisk.tmpDir().listFiles().orEmpty().isEmpty())
    }

    @Test fun oversizedDeclaredEntryIsRejectedBeforeAnyAssetTransport() = runBlocking {
        DSXContent.contentMaxBlobMB = { 1 }
        val root = DSXContent.absolute("/declared-too-large", origin)
        val body = bytes(32, 31)
        val sha = ContentDisk.hashData(body)
        val assetURL = root + "asset.bin"
        fetch.bodies[root + "manifest.json"] =
            """{"files":[{"path":"asset.bin","sha256":"$sha","bytes":1048577}]}""".toByteArray()
        fetch.bodies[assetURL] = body

        val failure = runCatching { prep("/declared-too-large") }.exceptionOrNull()
        assertTrue(failure is ContentError.Missing, "expected Missing, got $failure")
        assertEquals(0, fetch.count(assetURL))
        assertFalse(ContentDisk.hasBlob(sha))
        assertNull(folderDirOf("/declared-too-large"))
    }

    // MARK: signing gate

    @Test fun signingOnRefusesUnsignedAndHashlessManifests() = runBlocking {
        ContentStore.trustGate = FakeGate(accept = { _, sig -> sig.contentEquals("goodsig".toByteArray()) })
        val root = DSXContent.absolute("/signed", origin)
        val body = bytes(128, 5)
        val text = manifestText(mapOf("a.bin" to body), extra = ""","version":2""")
        fetch.bodies[root + "manifest.json"] = text.toByteArray()
        fetch.bodies[root + "a.bin"] = body
        // 1. no signature at all → refused, loudly distinct from "nothing there"
        assertTrue(runCatching { prep("/signed") }.exceptionOrNull() is ContentError.Refused)
        // 2. valid signature → publishes (and records the version high-water)
        fetch.headerMap[root + "manifest.json"] =
            mapOf("X-DSX-Signature" to Base64.getEncoder().encodeToString("goodsig".toByteArray()))
        val folder = prep("/signed")
        assertEquals(2L, ContentDisk.versionHighWater(folderDirOf("/signed")))
        // 3. a replayed OLDER signed manifest is refused; last-good keeps serving
        fetch.bodies[root + "manifest.json"] =
            manifestText(mapOf("a.bin" to bytes(128, 6)), extra = ""","version":1""").toByteArray()
        fetch.bodies[root + "a.bin"] = bytes(128, 6)
        assertEquals(folder.generation, refresh("/signed")!!.generation)
        // 4. signed but hash-less → refused (unverifiable bytes under a trusted deploy)
        fetch.bodies[root + "manifest.json"] =
            manifestText(mapOf("a.bin" to bytes(128, 7)), hashless = true, extra = ""","version":3""").toByteArray()
        assertEquals(folder.generation, refresh("/signed")!!.generation)
    }

    @Test fun versionHighWaterNeverRegresses() {
        val dir = File(tmp, "hw").apply { mkdirs() }
        ContentDisk.recordVersionHighWater(dir, 5L)
        ContentDisk.recordVersionHighWater(dir, 3L)
        assertEquals(5L, ContentDisk.versionHighWater(dir))
        ContentDisk.recordVersionHighWater(dir, 7L)
        assertEquals(7L, ContentDisk.versionHighWater(dir))
    }

    // MARK: disk format (pure)

    @Test fun normalizeRelRejectsEveryEscapeVector() {
        assertEquals("a/b", ContentDisk.normalizeRel("a/b"))
        assertEquals("", ContentDisk.normalizeRel("./a/b"))
        assertEquals("", ContentDisk.normalizeRel("/a/b"))
        assertEquals("", ContentDisk.normalizeRel("a//b"))
        assertEquals("", ContentDisk.normalizeRel("  a/b  "))
        assertEquals("", ContentDisk.normalizeRel("../evil"))
        assertEquals("", ContentDisk.normalizeRel("a/../b"))
        assertEquals("", ContentDisk.normalizeRel("a/./b"))
        assertEquals("", ContentDisk.normalizeRel("..\\escape"))
        assertEquals("", ContentDisk.normalizeRel("a\\..\\escape"))
        assertEquals("", ContentDisk.normalizeRel("C:escape"))
        assertEquals("", ContentDisk.normalizeRel("%2e%2e/escape"))
        assertEquals("", ContentDisk.normalizeRel("https://evil.example/x"))
        assertEquals("", ContentDisk.normalizeRel(".dsx-complete"))
        assertEquals("", ContentDisk.normalizeRel("a/.dsx-complete"))
        assertEquals("", ContentDisk.normalizeRel(""))
        assertEquals("", ContentDisk.normalizeRel("///"))
        assertEquals("", ContentDisk.normalizeRel("control\u0000name"))
        assertEquals("", ContentDisk.normalizeRel("x".repeat(ContentManifest.MAXIMUM_PATH_UTF8_BYTES + 1)))
    }

    @Test fun persistedControlReadsRejectCorruptOversizedAndSymlinkedState() {
        val dir = File(tmp, "corrupt-folder").apply { mkdirs() }
        val gens = File(dir, "gens").apply { mkdirs() }
        val generation = "a".repeat(64)
        val current = File(dir, "current")

        current.writeText("not-a-generation")
        assertNull(ContentDisk.readGenerationPointer(dir, "current"))
        RandomAccessFile(current, "rw").use { it.setLength(ContentDisk.MAXIMUM_POINTER_BYTES + 1L) }
        assertNull(ContentDisk.readPointer(dir, "current"))
        current.delete()
        val pointerTarget = File(tmp, "pointer-target").apply { writeText(generation) }
        Files.createSymbolicLink(current.toPath(), pointerTarget.toPath())
        assertNull(ContentDisk.readGenerationPointer(dir, "current"))
        current.delete()
        current.writeText(generation)

        val manifest = File(gens, "$generation.json")
        val blobmap = File(gens, "$generation.blobmap")
        val validManifest = """{"files":[]}"""
        val validBlobmap = """{"files":{},"source":"network"}"""
        blobmap.writeText(validBlobmap)
        RandomAccessFile(manifest, "rw").use {
            it.setLength(ContentDisk.MAXIMUM_CONTROL_BYTES + 1L)
        }
        assertNull(ContentDisk.manifestText(dir, generation))
        assertNull(ContentDisk.loadGeneration(dir, generation, origin))

        manifest.delete()
        val manifestTarget = File(tmp, "manifest-target").apply { writeText(validManifest) }
        Files.createSymbolicLink(manifest.toPath(), manifestTarget.toPath())
        assertNull(ContentDisk.loadGeneration(dir, generation, origin))
        manifest.delete()
        manifest.writeText(validManifest)

        RandomAccessFile(blobmap, "rw").use {
            it.setLength(ContentDisk.MAXIMUM_GENERATION_METADATA_BYTES + 1L)
        }
        assertNull(ContentDisk.loadGeneration(dir, generation, origin))
        assertTrue(ContentDisk.referencedShas(dir).isEmpty())

        blobmap.delete()
        val blobmapTarget = File(tmp, "blobmap-target").apply { writeText(validBlobmap) }
        Files.createSymbolicLink(blobmap.toPath(), blobmapTarget.toPath())
        assertNull(ContentDisk.loadGeneration(dir, generation, origin))
        assertTrue(ContentDisk.referencedShas(dir).isEmpty())

        blobmap.delete()
        blobmap.writeText("""{"files":{" ../escape":{"sha":"${"b".repeat(64)}"}}}""")
        assertNull(ContentDisk.loadGeneration(dir, generation, origin))
    }

    @Test fun api24LegacyBoundedReadPreservesBytesCeilingsAndSymlinkRejection() {
        val body = bytes(4_096, 29)
        val regular = File(tmp, "legacy-regular.bin").apply { writeBytes(body) }
        assertTrue(ContentDisk.boundedDataLegacy(regular, body.size.toLong())!!.contentEquals(body))
        assertNull(ContentDisk.boundedDataLegacy(regular, body.size.toLong() - 1L))

        val link = File(tmp, "legacy-link.bin")
        Files.createSymbolicLink(link.toPath(), regular.toPath())
        assertNull(ContentDisk.boundedDataLegacy(link, body.size.toLong()))
    }

    @Test fun cachedFileRejectsInvalidPointersAndBoundedOrSymlinkedBlobs() {
        val url = "$origin/single/cache.bin"
        val pointer = ContentDisk.filePointerURL(url).apply { parentFile!!.mkdirs() }
        val body = byteArrayOf(1, 2, 3, 4)
        val sha = ContentDisk.hashData(body)
        ContentDisk.ingest(body, sha)

        pointer.writeText(sha.uppercase())
        assertNull(ContentDisk.cachedFile(url))
        RandomAccessFile(pointer, "rw").use { it.setLength(ContentDisk.MAXIMUM_POINTER_BYTES + 1L) }
        assertNull(ContentDisk.cachedFile(url))
        pointer.delete()
        val pointerTarget = File(tmp, "single-pointer-target").apply { writeText(sha) }
        Files.createSymbolicLink(pointer.toPath(), pointerTarget.toPath())
        assertNull(ContentDisk.cachedFile(url))

        pointer.delete()
        ContentDisk.writeFilePointer(url, sha)
        assertTrue(ContentDisk.cachedFile(url)!!.contentEquals(body))
        val blob = ContentDisk.blobURL(sha)!!
        blob.delete()
        val blobTarget = File(tmp, "single-blob-target").apply { writeBytes(body) }
        Files.createSymbolicLink(blob.toPath(), blobTarget.toPath())
        assertNull(ContentDisk.cachedFile(url))

        blob.delete()
        val oversizedSha = "c".repeat(64)
        val oversizedBlob = ContentDisk.blobPath(ContentDisk.cacheRoot, oversizedSha)
        oversizedBlob.parentFile!!.mkdirs()
        RandomAccessFile(oversizedBlob, "rw").use {
            it.setLength(ContentDisk.MAXIMUM_CONTROL_BYTES + 1L)
        }
        ContentDisk.writeFilePointer(url, oversizedSha)
        assertNull(ContentDisk.cachedFile(url))
    }

    @Test fun singleUrlFreshFileRejectsBodiesBeyondItsHeapContract() = runBlocking {
        val url = "$origin/single/too-large.bin"
        fetch.bodies[url] = ByteArray(ContentDisk.MAXIMUM_CONTROL_BYTES.toInt() + 1)
        assertNull(store.freshFile(url))
        assertFalse(ContentDisk.filePointerURL(url).exists())
    }

    @Test fun prepareRejectsFilesystemAmbiguousDuplicatePathsBeforeDownloading() = runBlocking {
        val root = DSXContent.absolute("/ambiguous", origin)
        fetch.bodies[root + "manifest.json"] =
            """{"files":[{"path":"Assets/Café.bin"},{"path":"assets/café.bin"}]}""".toByteArray()

        assertTrue(runCatching { prep("/ambiguous") }.exceptionOrNull() is ContentError.NoManifest)
        assertEquals(listOf(root + "manifest.json"), fetch.calls)
    }

    @Test fun generationIDIsOrderIndependentAndChangeSensitive() {
        val m1 = linkedMapOf("a" to BlobRef("11", null), "b" to BlobRef("22", null))
        val m2 = linkedMapOf("b" to BlobRef("22", "seed.bin"), "a" to BlobRef("11", null))
        assertEquals(ContentDisk.generationID(m1), ContentDisk.generationID(m2))  // seed refs don't rename
        val m3 = linkedMapOf("a" to BlobRef("11", null), "b" to BlobRef("33", null))
        assertNotEquals(ContentDisk.generationID(m1), ContentDisk.generationID(m3))
    }

    @Test fun ingestIsIdempotentOnExistingBlobs() {
        val body = bytes(64, 1)
        val sha = ContentDisk.hashData(body)
        ContentDisk.ingest(data = body, sha = sha)
        ContentDisk.ingest(data = body, sha = sha)                  // EEXIST = an idempotent win
        assertTrue(ContentDisk.hasBlob(sha))
        assertEquals(body.toList(), ContentDisk.blobURL(sha)!!.readBytes().toList())
    }

    @Test fun materializeBuildsACompleteTreeOnceAndReusesIt() = runBlocking {
        serve("/tree", mapOf("index.html" to bytes(40, 1), "assets/app.js" to bytes(80, 2)))
        val folder = prep("/tree")
        val tree = folder.materialize()
        assertTrue(File(tree, "index.html").exists())
        assertTrue(File(tree, "assets/app.js").exists())
        assertTrue(File(tree, ContentDisk.treeMarkerName).exists())
        val sentinel = File(tree, "sentinel").apply { writeBytes(ByteArray(1)) }
        assertEquals(tree.path, folder.materialize().path)          // finished tree is reused, not rebuilt
        assertTrue(sentinel.exists())
    }

    @Test fun inMemoryReadsRejectLargeAndSymlinkFilesWithoutAllocation() {
        val sha = "a".repeat(64)
        val blob = ContentDisk.blobPath(ContentDisk.cacheRoot, sha)
        blob.parentFile!!.mkdirs()
        RandomAccessFile(blob, "rw").use {
            it.setLength(ContentFolder.MAX_IN_MEMORY_FILE_BYTES + 1L)
        }
        val folder = ContentFolder(
            root = "https://app.example/memory/",
            generation = "test",
            manifest = ContentManifest.parse("""{"files":[]}""")!!,
            source = "network",
            folderDir = File(tmp, "memory-folder"),
            blobmap = mapOf("large.bin" to BlobRef(sha, null)),
        )
        assertNull(folder.data("large.bin"))

        val target = File(tmp, "small-target").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        blob.delete()
        java.nio.file.Files.createSymbolicLink(blob.toPath(), target.toPath())
        assertNull(folder.data("large.bin"))
    }

    @Test fun inMemoryBatchCapsRequestedPathsAndAggregateBytes() = runBlocking {
        fun folderWithSparseBlobs(prefix: String, sizes: List<Long>): Pair<ContentFolder, List<String>> {
            val map = LinkedHashMap<String, BlobRef>()
            val paths = ArrayList<String>()
            sizes.forEachIndexed { index, size ->
                val sha = ContentDisk.hashData("$prefix-$index".toByteArray())
                val file = ContentDisk.blobPath(ContentDisk.cacheRoot, sha)
                file.parentFile!!.mkdirs()
                RandomAccessFile(file, "rw").use { it.setLength(size) }
                val rel = "$prefix-$index.bin"
                paths += rel
                map[rel] = BlobRef(sha, null)
            }
            return ContentFolder(
                root = "https://app.example/$prefix/",
                generation = prefix,
                manifest = ContentManifest.parse("""{"files":[]}""")!!,
                source = "network",
                folderDir = File(tmp, "$prefix-folder"),
                blobmap = map,
            ) to paths
        }

        val (many, manyPaths) = folderWithSparseBlobs("many", List(65) { 1L })
        val cappedPaths = many.data(manyPaths)
        assertEquals(ContentFolder.MAX_IN_MEMORY_BATCH_PATHS, cappedPaths.size)
        assertFalse(cappedPaths.containsKey(manyPaths.last()))

        val twentyFourMiB = 24L * 1024L * 1024L
        val (aggregate, aggregatePaths) = folderWithSparseBlobs(
            "aggregate",
            listOf(twentyFourMiB, twentyFourMiB, twentyFourMiB),
        )
        val cappedBytes = aggregate.data(aggregatePaths)
        assertEquals(setOf(aggregatePaths[0], aggregatePaths[1]), cappedBytes.keys)
        assertTrue(cappedBytes.values.sumOf { it.size.toLong() } <= ContentFolder.MAX_IN_MEMORY_BATCH_BYTES)
    }
}
