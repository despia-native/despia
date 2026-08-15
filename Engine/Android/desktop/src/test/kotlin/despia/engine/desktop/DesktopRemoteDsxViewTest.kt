package despia.engine.desktop

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import despia.engine.ContentDisk
import despia.engine.Context
import despia.engine.DSXContent
import despia.engine.RemoteBundleGate
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.swing.SwingUtilities
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DesktopRemoteDsxViewTest {
    @TempDir
    lateinit var temporary: Path

    private var server: HttpServer? = null
    private val originalOrigin = DSXContent.resolvedOriginString
    private val originalGate = RemoteBundleGate._overrideConfig
    private val originalReleasePolicy = RemoteBundleGate._overrideReleaseOTARequired
    private val originalAssetClaim = desktopRemoteAssetClaim
    private val originalCacheRoot = ContentDisk.cacheRoot
    private val originalPinnedRoot = ContentDisk.pinnedRoot

    @BeforeEach
    fun isolateRemoteCache() {
        ContentDisk.cacheRoot = temporary.resolve("cache").toFile()
        ContentDisk.pinnedRoot = temporary.resolve("pinned").toFile()
    }

    @AfterEach
    fun restoreRuntime() {
        server?.stop(0)
        DSXContent.resolvedOriginString = originalOrigin
        RemoteBundleGate._overrideConfig = originalGate
        RemoteBundleGate._overrideReleaseOTARequired = originalReleasePolicy
        RemoteBundleGate.setAssetHashes(emptyMap())
        desktopRemoteAssetClaim = originalAssetClaim
        ContentDisk.cacheRoot = originalCacheRoot
        ContentDisk.pinnedRoot = originalPinnedRoot
    }

    @Test
    fun urlAdmissionRequiresAuthorityHttpsOrLoopbackAndNoCredentials() {
        DSXContent.resolvedOriginString = { null }

        assertNull(desktopRemoteDsxUrl("screen.dsx", ""))
        assertEquals(
            "https://example.test/native/screen.dsx",
            desktopRemoteDsxUrl("screen.dsx", "example.test/native"),
        )
        assertEquals(
            "http://127.0.0.1:8787/native/screen.dsx",
            desktopRemoteDsxUrl("native/screen.dsx", "http://127.0.0.1:8787"),
        )
        assertNull(desktopRemoteDsxUrl("http://example.test/screen.dsx", ""))
        assertNull(desktopRemoteDsxUrl("https://user:secret@example.test/screen.dsx", ""))
        assertNull(desktopRemoteDsxUrl("file:///tmp/screen.dsx", ""))
        assertNull(desktopRemoteDsxUrl("https://example.test/screen.dsx#alternate", ""))
    }

    @Test
    fun directRemoteDocumentUsesBoundedParserAndBundledDeclarationSemantics() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        val local = newServer()
        val markup = """
            <vstack>
              <head>
                <variable as="remoteTitle">return "Native remote"</variable>
                <component as="RemoteCard"><text value="Card loaded"/></component>
                <component as="DSXView"><text value="Must not replace the runtime"/></component>
              </head>
              <RemoteCard/>
            </vstack>
        """.trimIndent().toByteArray()
        local.createContext("/screen.dsx") { exchange -> exchange.respond(markup) }
        local.createContext("/screen-signed.dsx") { exchange -> exchange.respond(markup) }
        local.createContext("/invalid.dsx") { exchange -> exchange.respond(byteArrayOf(0xC3.toByte(), 0x28)) }
        local.start()

        val origin = "http://127.0.0.1:${local.address.port}"
        val loaded = loadDesktopRemoteDsx("$origin/screen.dsx", "")
        assertNull(loaded.failure)
        val document = assertNotNull(loaded.document)
        assertEquals("vstack", document.root.tag)
        assertEquals(DesktopRemoteDsxServing.ORIGIN, document.serving)

        val store = StackStore()
        val admitted = prepareDesktopRemoteComponents(document, store, emptyMap())
        assertEquals(setOf("RemoteCard"), admitted.keys)
        assertEquals("Native remote", store.getPath("remoteTitle"))

        val malformed = loadDesktopRemoteDsx("$origin/invalid.dsx", "")
        assertEquals(DesktopRemoteDsxFailure.INVALID_UTF8, malformed.failure)
        assertNull(malformed.document)

        RemoteBundleGate._overrideConfig = RemoteBundleGate.Config(true, emptyList(), 1)
        val unsigned = loadDesktopRemoteDsx("$origin/screen-signed.dsx", "")
        assertEquals(DesktopRemoteDsxFailure.INTEGRITY, unsigned.failure)
        assertNull(unsigned.document)
    }

    @Test
    fun offlineAssetClaimWinsWithoutOpeningTheNetwork() = runBlocking {
        admitUnsignedDevelopmentContent()
        val local = temporary.resolve("offline-screen.dsx")
        Files.writeString(local, "<text value=\"Offline native DSX\"/>")
        desktopRemoteAssetClaim = { key ->
            local.toUri().toString().takeIf { key == "/native/offline.dsx" }
        }

        val loaded = loadDesktopRemoteDsx("https://network-must-not-open.invalid/native/offline.dsx", "")
        assertNull(loaded.failure)
        val document = assertNotNull(loaded.document)
        assertEquals("text", document.root.tag)
        assertEquals(DesktopRemoteDsxServing.CACHE, document.serving)
    }

    @Test
    fun remoteTransportIsAnonymousAndRejectedFreshBytesCannotPoisonLastKnownGood() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        val seenCookie = AtomicReference<String?>()
        val responseBody = AtomicReference("<text value=\"Last known good\"/>".toByteArray())
        val responseStatus = AtomicInteger(200)
        val local = newServer()
        local.createContext("/session") { exchange ->
            exchange.responseHeaders.add("Set-Cookie", "dsx_session=private; Path=/; HttpOnly")
            exchange.sendResponseHeaders(204, -1)
            exchange.close()
        }
        local.createContext("/screen.dsx") { exchange ->
            seenCookie.set(exchange.requestHeaders.getFirst("Cookie"))
            exchange.respond(responseBody.get(), responseStatus.get())
        }
        local.start()
        val url = "http://127.0.0.1:${local.address.port}/screen.dsx"

        Context.fetchImpl!!.invoke(
            "http://127.0.0.1:${local.address.port}/session",
            "GET",
            emptyMap(),
            emptyMap(),
            null,
            5.0,
        )
        val first = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("Last known good", first.root.attrs["value"])
        assertEquals(DesktopRemoteDsxServing.ORIGIN, first.serving)
        assertNull(seenCookie.get(), "remote DSX must not inherit the API cookie jar")

        // Poison the old credentialed namespace and serve malformed fresh bytes.
        // Neither source is allowed to replace the separately namespaced admitted LKG.
        val credentialedPoison = "<text value=\"Credentialed poison\"/>".toByteArray()
        val poisonSha = ContentDisk.hashData(credentialedPoison)
        ContentDisk.ingest(credentialedPoison, poisonSha)
        ContentDisk.writeFilePointer(url, poisonSha)
        responseBody.set(byteArrayOf(0xC3.toByte(), 0x28))
        val second = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("Last known good", second.root.attrs["value"])
        assertEquals(DesktopRemoteDsxServing.CACHE, second.serving)
        assertNull(seenCookie.get())

        responseStatus.set(503)
        val offlineFallback = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("Last known good", offlineFallback.root.attrs["value"])
    }

    @Test
    fun rejectedFolderGenerationFallsBackWithoutPoisoningThePreviousAtomicSnapshot() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        fun response(status: Int, text: String) = status to text.toByteArray()
        val valid = mapOf(
            "/bundle/manifest.json" to response(
                200,
                """{"root":"index.dsx","files":["index.dsx","Card.dsx"]}""",
            ),
            "/bundle/index.dsx" to response(200, "<Card/>"),
            "/bundle/Card.dsx" to response(200, "<text value=\"generation one\"/>"),
        )
        val active = AtomicReference(valid)
        val local = newServer()
        local.createContext("/") { exchange ->
            val selected = active.get()[exchange.requestURI.path] ?: response(404, "")
            exchange.respond(selected.second, selected.first)
        }
        local.start()
        val url = "http://127.0.0.1:${local.address.port}/bundle/"

        val first = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("generation one", assertNotNull(first.components["Card"]).attrs["value"])

        active.set(
            mapOf(
                "/bundle/manifest.json" to response(
                    200,
                    """{"root":"index.dsx","files":["index.dsx","Card.dsx","Loop.dsx"]}""",
                ),
                "/bundle/index.dsx" to response(200, "<Card/>"),
                "/bundle/Card.dsx" to response(200, "<vstack><Loop/><Loop/></vstack>"),
                "/bundle/Loop.dsx" to response(200, "<vstack><Card/><Card/></vstack>"),
            ),
        )
        val rejected = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("generation one", assertNotNull(rejected.components["Card"]).attrs["value"])
        assertEquals(setOf("Card"), rejected.components.keys)

        active.set(valid.mapValues { response(503, "offline") })
        val offline = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("generation one", assertNotNull(offline.components["Card"]).attrs["value"])
        assertEquals(setOf("Card"), offline.components.keys)
    }

    @Test
    fun incompleteFreshFolderNeverRendersOrPublishesAMixedGeneration() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        fun response(status: Int, text: String) = status to text.toByteArray()
        val generationOne = mapOf(
            "/bundle/manifest.json" to response(
                200,
                """{"version":1,"root":"index.dsx","files":["index.dsx","Card.dsx","Badge.dsx"]}""",
            ),
            "/bundle/index.dsx" to response(
                200,
                "<vstack generation=\"one\"><Card/><Badge/></vstack>",
            ),
            "/bundle/Card.dsx" to response(200, "<text value=\"card one\"/>"),
            "/bundle/Badge.dsx" to response(200, "<text value=\"badge one\"/>"),
        )
        val active = AtomicReference(generationOne)
        val local = newServer()
        local.createContext("/") { exchange ->
            val selected = active.get()[exchange.requestURI.path] ?: response(404, "")
            exchange.respond(selected.second, selected.first)
        }
        local.start()
        val url = "http://127.0.0.1:${local.address.port}/bundle/"

        val first = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", first.root.attrs["generation"])
        assertEquals("card one", assertNotNull(first.components["Card"]).attrs["value"])
        assertEquals("badge one", assertNotNull(first.components["Badge"]).attrs["value"])

        active.set(
            mapOf(
                "/bundle/manifest.json" to response(
                    200,
                    """{"version":2,"root":"index.dsx","files":["index.dsx","Card.dsx","Badge.dsx"]}""",
                ),
                "/bundle/index.dsx" to response(
                    200,
                    "<vstack generation=\"two\"><Card/><Badge/></vstack>",
                ),
                "/bundle/Card.dsx" to response(200, "<text value=\"card two\"/>"),
                // A 2xx body which fails strict UTF-8 admission must invalidate the
                // complete fresh attempt, not silently splice in Badge from v1.
                "/bundle/Badge.dsx" to (200 to byteArrayOf(0xC3.toByte(), 0x28)),
            ),
        )

        val fallback = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", fallback.root.attrs["generation"])
        assertEquals("card one", assertNotNull(fallback.components["Card"]).attrs["value"])
        assertEquals("badge one", assertNotNull(fallback.components["Badge"]).attrs["value"])

        active.set(
            mapOf(
                "/bundle/manifest.json" to response(
                    200,
                    """{"version":3,"root":"index.dsx","files":["index.dsx","Card.dsx","Badge.dsx"]}""",
                ),
                "/bundle/index.dsx" to response(
                    200,
                    "<vstack generation=\"three\"><Card/><Badge/></vstack>",
                ),
                "/bundle/Card.dsx" to response(200, "<text value=\"card three\"/>"),
                "/bundle/Badge.dsx" to response(503, "temporarily unavailable"),
            ),
        )
        val unavailableFallback = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", unavailableFallback.root.attrs["generation"])
        assertEquals("card one", assertNotNull(unavailableFallback.components["Card"]).attrs["value"])
        assertEquals("badge one", assertNotNull(unavailableFallback.components["Badge"]).attrs["value"])

        active.set(
            mapOf(
                "/bundle/manifest.json" to response(
                    200,
                    """{"version":4,"root":"index.dsx","files":["index.dsx","Card.dsx","Badge.dsx","New.dsx"]}""",
                ),
                "/bundle/index.dsx" to response(
                    200,
                    "<vstack generation=\"four\"><Card/><Badge/><New/></vstack>",
                ),
                "/bundle/Card.dsx" to response(200, "<text value=\"card four\"/>"),
                "/bundle/Badge.dsx" to response(200, "<text value=\"badge four\"/>"),
                "/bundle/New.dsx" to response(503, "not deployed yet"),
            ),
        )
        val incompleteManifestFallback = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", incompleteManifestFallback.root.attrs["generation"])
        assertEquals(setOf("Card", "Badge"), incompleteManifestFallback.components.keys)

        // No rejected attempt may move the stable snapshot pointer.
        active.set(generationOne.mapValues { response(503, "offline") })
        val offline = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", offline.root.attrs["generation"])
        assertEquals("card one", assertNotNull(offline.components["Card"]).attrs["value"])
        assertEquals("badge one", assertNotNull(offline.components["Badge"]).attrs["value"])
    }

    @Test
    fun manifestDeclaredHashesBindAssetsWhileDeclaredSizeRemainsBoundedMetadata() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        fun response(status: Int, body: ByteArray) = status to body
        fun manifest(
            version: Int,
            root: ByteArray,
            cardSha: String,
            rootBytes: Long,
            cardBytes: Long,
        ): ByteArray = """
            {
              "version":$version,
              "root":"index.dsx",
              "files":[
                {"path":"index.dsx","sha256":"${sha256(root)}","bytes":$rootBytes},
                {"path":"Card.dsx","sha256":"$cardSha","bytes":$cardBytes}
              ]
            }
        """.trimIndent().toByteArray()

        val rootOne = "<vstack generation=\"one\"><Card/></vstack>".toByteArray()
        val cardOne = "<text value=\"card one\"/>".toByteArray()
        val generationOne = mapOf(
            "/hashed/manifest.json" to response(
                200,
                manifest(1, rootOne, sha256(cardOne), rootOne.size.toLong(), cardOne.size.toLong()),
            ),
            "/hashed/index.dsx" to response(200, rootOne),
            "/hashed/Card.dsx" to response(200, cardOne),
        )
        val active = AtomicReference(generationOne)
        val local = newServer()
        local.createContext("/") { exchange ->
            val selected = active.get()[exchange.requestURI.path] ?: response(404, ByteArray(0))
            exchange.respond(selected.second, selected.first)
        }
        local.start()
        val url = "http://127.0.0.1:${local.address.port}/hashed/"

        val first = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", first.root.attrs["generation"])
        assertEquals("card one", assertNotNull(first.components["Card"]).attrs["value"])

        val rootTwo = "<vstack generation=\"two\"><Card/></vstack>".toByteArray()
        val intendedCardTwo = "<text value=\"card two\"/>".toByteArray()
        val tamperedCardTwo = "<text value=\"tampered two\"/>".toByteArray()
        active.set(
            mapOf(
                "/hashed/manifest.json" to response(
                    200,
                    manifest(
                        2,
                        rootTwo,
                        sha256(intendedCardTwo),
                        rootTwo.size.toLong(),
                        tamperedCardTwo.size.toLong(),
                    ),
                ),
                "/hashed/index.dsx" to response(200, rootTwo),
                "/hashed/Card.dsx" to response(200, tamperedCardTwo),
            ),
        )
        val hashFallback = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", hashFallback.root.attrs["generation"])
        assertEquals("card one", assertNotNull(hashFallback.components["Card"]).attrs["value"])

        val rootThree = "<vstack generation=\"three\"><Card/></vstack>".toByteArray()
        val cardThree = "<text value=\"card three\"/>".toByteArray()
        active.set(
            mapOf(
                "/hashed/manifest.json" to response(
                    200,
                    manifest(3, rootThree, sha256(cardThree), rootThree.size.toLong(), 4_194_305L),
                ),
                "/hashed/index.dsx" to response(200, rootThree),
                "/hashed/Card.dsx" to response(200, cardThree),
            ),
        )
        val oversizedFallback = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", oversizedFallback.root.attrs["generation"])

        // ContentManifest.bytes is the cross-platform preflight/progress hint,
        // not an integrity field. An inaccurate in-range value cannot weaken the
        // SHA binding and therefore does not reject otherwise matching bytes.
        val rootFour = "<vstack generation=\"four\"><Card/></vstack>".toByteArray()
        val cardFour = "<text value=\"card four\"/>".toByteArray()
        active.set(
            mapOf(
                "/hashed/manifest.json" to response(
                    200,
                    manifest(4, rootFour, sha256(cardFour), 1L, 1L),
                ),
                "/hashed/index.dsx" to response(200, rootFour),
                "/hashed/Card.dsx" to response(200, cardFour),
            ),
        )
        val accepted = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("four", accepted.root.attrs["generation"])
        assertEquals("card four", assertNotNull(accepted.components["Card"]).attrs["value"])
    }

    @Test
    fun hashlessFolderRequiresTwoIdenticalObservationsAcrossADeployRace() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        val phase = AtomicInteger(0)
        val badgeFetches = AtomicInteger()
        val old = mapOf(
            "/race/manifest.json" to
                """{"version":1,"root":"index.dsx","files":["index.dsx","Card.dsx","Badge.dsx"]}"""
                    .toByteArray(),
            "/race/index.dsx" to "<vstack generation=\"one\"><Card/><Badge/></vstack>".toByteArray(),
            "/race/Card.dsx" to "<text value=\"card one\"/>".toByteArray(),
            "/race/Badge.dsx" to "<text value=\"badge one\"/>".toByteArray(),
        )
        val fresh = mapOf(
            "/race/manifest.json" to
                """{"version":2,"root":"index.dsx","files":["index.dsx","Card.dsx","Badge.dsx"]}"""
                    .toByteArray(),
            "/race/index.dsx" to "<vstack generation=\"two\"><Card/><Badge/></vstack>".toByteArray(),
            "/race/Card.dsx" to "<text value=\"card two\"/>".toByteArray(),
            "/race/Badge.dsx" to "<text value=\"badge two\"/>".toByteArray(),
        )
        val local = newServer()
        local.createContext("/") { exchange ->
            when (phase.get()) {
                0 -> exchange.respond(old[exchange.requestURI.path] ?: ByteArray(0),
                    if (exchange.requestURI.path in old) 200 else 404)
                1 -> {
                    val body = if (exchange.requestURI.path == "/race/Badge.dsx" &&
                        badgeFetches.incrementAndGet() == 1
                    ) old.getValue("/race/Badge.dsx")
                    else fresh[exchange.requestURI.path] ?: ByteArray(0)
                    exchange.respond(body, if (exchange.requestURI.path in fresh) 200 else 404)
                }
                else -> exchange.respond("offline".toByteArray(), 503)
            }
        }
        local.start()
        val url = "http://127.0.0.1:${local.address.port}/race/"

        val first = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", first.root.attrs["generation"])

        phase.set(1)
        badgeFetches.set(0)
        val raced = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals(2, badgeFetches.get())
        assertEquals("one", raced.root.attrs["generation"])
        assertEquals("card one", assertNotNull(raced.components["Card"]).attrs["value"])
        assertEquals("badge one", assertNotNull(raced.components["Badge"]).attrs["value"])

        phase.set(2)
        val offline = assertNotNull(loadDesktopRemoteDsx(url, "").document)
        assertEquals("one", offline.root.attrs["generation"])
        assertEquals("card one", assertNotNull(offline.components["Card"]).attrs["value"])
        assertEquals("badge one", assertNotNull(offline.components["Badge"]).attrs["value"])
    }

    @Test
    fun directDocumentIsCachedOnlyAfterTheTrustedComponentGraphPasses() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        val status = AtomicInteger(200)
        val body = AtomicReference("<text value=\"direct generation one\"/>".toByteArray())
        val local = newServer()
        local.createContext("/screen.dsx") { exchange -> exchange.respond(body.get(), status.get()) }
        local.start()
        val url = "http://127.0.0.1:${local.address.port}/screen.dsx"
        val trusted = mapOf(
            "TrustedWrapper" to StackNode("RemoteCard", emptyMap(), emptyList()),
        )

        val first = assertNotNull(loadDesktopRemoteDsx(url, "", trusted).document)
        assertEquals("direct generation one", first.root.attrs["value"])

        body.set(
            """
            <vstack>
              <head><component as="RemoteCard"><TrustedWrapper/></component></head>
              <RemoteCard/>
            </vstack>
            """.trimIndent().toByteArray(),
        )
        val rejected = loadDesktopRemoteDsx(url, "", trusted)
        assertEquals(DesktopRemoteDsxFailure.COMPONENT_GRAPH, rejected.failure)

        status.set(503)
        val offline = assertNotNull(loadDesktopRemoteDsx(url, "", trusted).document)
        assertEquals("direct generation one", offline.root.attrs["value"])
    }

    @Test
    fun mountedTreeBudgetIsAggregateAndReservationsReleaseExactlyOnce() {
        val budget = DesktopRemoteDsxBudget(
            maximumBytes = 10,
            maximumNodes = 10,
            maximumFiles = 2,
            concurrentLoads = 1,
        )
        val first = assertNotNull(budget.reserve(DesktopRemoteFootprint(6, 6, 1)))
        assertNull(budget.reserve(DesktopRemoteFootprint(5, 1, 1)))
        assertNull(budget.reserve(DesktopRemoteFootprint(1, 5, 1)))

        first.close()
        first.close()
        assertNotNull(budget.reserve(DesktopRemoteFootprint(10, 10, 2)))
    }

    @Test
    fun mountedTreeLoadSemaphoreBoundsWorkBeforeAggregateReservation() = runBlocking {
        val budget = DesktopRemoteDsxBudget(
            maximumBytes = 10,
            maximumNodes = 10,
            maximumFiles = 10,
            concurrentLoads = 1,
        )
        val active = AtomicInteger()
        val maximum = AtomicInteger()

        (0 until 8).map {
            async {
                budget.withLoadPermit {
                    val current = active.incrementAndGet()
                    maximum.accumulateAndGet(current, ::maxOf)
                    delay(5)
                    active.decrementAndGet()
                }
            }
        }.awaitAll()

        assertEquals(1, maximum.get())
        assertEquals(0, active.get())
    }

    @Test
    fun folderDocumentLoadsOnlySafeAdditiveComponents() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Windows 11")
        val local = newServer()
        val files = mapOf(
            "/bundle/manifest.json" to """
                {"root":"index.dsx","files":["index.dsx","RemoteCard.dsx","DSXView.dsx","Upper.DSX"]}
            """.trimIndent().toByteArray(),
            "/bundle/index.dsx" to "<vstack><RemoteCard/></vstack>".toByteArray(),
            "/bundle/RemoteCard.dsx" to "<text value=\"Folder component\"/>".toByteArray(),
            "/bundle/DSXView.dsx" to "<text value=\"Runtime replacement\"/>".toByteArray(),
            "/bundle/Upper.DSX" to "<text value=\"Non-canonical suffix\"/>".toByteArray(),
        )
        local.createContext("/bundle/") { exchange ->
            files[exchange.requestURI.path]?.let { body -> exchange.respond(body) }
                ?: exchange.respond(ByteArray(0), 404)
        }
        local.start()

        val loaded = loadDesktopRemoteDsx("http://127.0.0.1:${local.address.port}/bundle/", "")
        assertNull(loaded.failure)
        val document = assertNotNull(loaded.document)
        assertEquals(setOf("RemoteCard"), document.components.keys)
        val admitted = prepareDesktopRemoteComponents(document, StackStore(), emptyMap())
        assertEquals(setOf("RemoteCard"), admitted.keys)
        assertFalse("DSXView" in admitted)
        assertFalse("Upper" in admitted)

        RemoteBundleGate._overrideConfig = RemoteBundleGate.Config(true, emptyList(), 1)
        val signedFolder = loadDesktopRemoteDsx("http://127.0.0.1:${local.address.port}/bundle/", "")
        assertEquals(DesktopRemoteDsxFailure.INTEGRITY, signedFolder.failure)
        assertNull(signedFolder.document)

        RemoteBundleGate.setAssetHashes(
            mapOf(
                "bundle/manifest.json" to sha256(assertNotNull(files["/bundle/manifest.json"])),
                "bundle/index.dsx" to sha256(assertNotNull(files["/bundle/index.dsx"])),
                "bundle/RemoteCard.dsx" to sha256(assertNotNull(files["/bundle/RemoteCard.dsx"])),
            ),
        )
        assertEquals(
            RemoteBundleGate.AssetCheck.match,
            RemoteBundleGate.checkAsset(assertNotNull(files["/bundle/manifest.json"]), "/bundle/manifest.json"),
        )
        assertEquals(
            RemoteBundleGate.AssetCheck.match,
            RemoteBundleGate.checkAsset(assertNotNull(files["/bundle/index.dsx"]), "/bundle/index.dsx"),
        )
        assertEquals(
            RemoteBundleGate.AssetCheck.match,
            RemoteBundleGate.checkAsset(assertNotNull(files["/bundle/RemoteCard.dsx"]), "/bundle/RemoteCard.dsx"),
        )
        val verifiedFolder = loadDesktopRemoteDsx("http://127.0.0.1:${local.address.port}/bundle/", "")
        assertNull(verifiedFolder.failure)
        assertEquals(setOf("RemoteCard"), assertNotNull(verifiedFolder.document).components.keys)
    }

    @Test
    fun trustedAppComponentsCannotBeReplacedByRemoteNames() {
        val root = requireNotNull(
            DesktopHost.parseDocument(
                DesktopHost.Document(
                    "remote-component-boundary.dsx",
                    """
                        <vstack>
                          <head>
                            <component as="TrustedCard"><text value="Remote replacement"/></component>
                            <component as="RemoteCard"><text value="Remote card"/></component>
                          </head>
                        </vstack>
                    """.trimIndent(),
                ),
            ),
        )
        val trusted = mapOf("TrustedCard" to root)
        val admitted = prepareDesktopRemoteComponents(
            DesktopRemoteDsxDocument(root, emptyMap()),
            StackStore(),
            trusted,
        )

        assertEquals(setOf("RemoteCard"), admitted.keys)
        assertTrue("TrustedCard" in trusted)
    }

    @Test
    fun everyBinaryOwnedPrimitiveIsReservedFromRemoteComponentTables() {
        DesktopElements.register("PackageOwnedTestElement") { }
        val template = StackNode("text", mapOf("value" to "replacement"), emptyList())
        val declarations = desktopReservedRemoteComponentTags.sorted().map { tag ->
            StackNode("component", mapOf("as" to tag), listOf(template))
        } + listOf(
            StackNode("component", mapOf("as" to "PackageOwnedTestElement"), listOf(template)),
            StackNode("component", mapOf("as" to "RemoteCard"), listOf(template)),
        )
        val root = StackNode("vstack", emptyMap(), declarations)

        val admitted = desktopRemoteComponentTable(
            DesktopRemoteDsxDocument(root, emptyMap()),
            emptyMap(),
        )

        assertEquals(setOf("RemoteCard"), admitted.keys)
        assertTrue(
            setOf(
                "api", "html", "body", "page", "screen", "view", "template", "section",
                "group", "card", "overlay", "cover", "heading", "title", "subtitle",
                "paragraph", "code", "rangeSlider",
            ).all { it in desktopReservedRemoteComponentTags },
        )
    }

    @Test
    fun combinedRemoteAndTrustedComponentCycleFailsBeforeStoreSideEffects() {
        val remoteTemplate = StackNode("TrustedWrapper", emptyMap(), emptyList())
        val trustedTemplate = StackNode("RemoteCard", emptyMap(), emptyList())
        val root = StackNode(
            "vstack",
            emptyMap(),
            listOf(
                StackNode(
                    "variable",
                    mapOf("as" to "mustNotMutate"),
                    emptyList(),
                    "return \"poison\"",
                ),
                StackNode("RemoteCard", emptyMap(), emptyList()),
            ),
        )
        val document = DesktopRemoteDsxDocument(root, mapOf("RemoteCard" to remoteTemplate))
        val store = StackStore()

        val admitted = prepareDesktopRemoteComponents(
            document,
            store,
            mapOf("TrustedWrapper" to trustedTemplate),
        )

        assertTrue(admitted.isEmpty())
        assertNull(store.getPath("mustNotMutate"))
    }

    @Test
    fun folderRejectsCrossFileCyclesAndExponentialFanout() = runBlocking {
        admitUnsignedDevelopmentContent()
        DesktopHost.boot("Linux")
        val local = newServer()
        val files = LinkedHashMap<String, ByteArray>()
        files["/cycle/manifest.json"] =
            """{"root":"index.dsx","files":["index.dsx","A.dsx","B.dsx"]}""".toByteArray()
        files["/cycle/index.dsx"] = "<A/>".toByteArray()
        files["/cycle/A.dsx"] = "<vstack><B/><B/></vstack>".toByteArray()
        files["/cycle/B.dsx"] = "<vstack><A/><A/></vstack>".toByteArray()

        val fanoutNames = (0..16).map { "C$it.dsx" }
        files["/fanout/manifest.json"] =
            """{"root":"index.dsx","files":["index.dsx",${fanoutNames.joinToString(",") { "\"$it\"" }}]}"""
                .toByteArray()
        files["/fanout/index.dsx"] = "<C0/>".toByteArray()
        for (index in 0 until 16) {
            files["/fanout/C$index.dsx"] =
                "<vstack><C${index + 1}/><C${index + 1}/></vstack>".toByteArray()
        }
        files["/fanout/C16.dsx"] = "<text value=\"bounded leaf\"/>".toByteArray()
        local.createContext("/") { exchange ->
            files[exchange.requestURI.path]?.let { body -> exchange.respond(body) }
                ?: exchange.respond(ByteArray(0), 404)
        }
        local.start()
        val origin = "http://127.0.0.1:${local.address.port}"

        val cycle = loadDesktopRemoteDsx("$origin/cycle/", "")
        assertEquals(DesktopRemoteDsxFailure.COMPONENT_GRAPH, cycle.failure)
        assertNull(cycle.document)

        val fanout = loadDesktopRemoteDsx("$origin/fanout/", "")
        assertEquals(DesktopRemoteDsxFailure.COMPONENT_GRAPH, fanout.failure)
        assertNull(fanout.document)
    }

    @Test
    fun rawFolderRootCannotInjectTraversalQueryOrFragmentSyntax() = runBlocking {
        admitUnsignedDevelopmentContent()
        val local = newServer()
        val roots = listOf(
            "%2e%2e/secret.dsx",
            "screen?variant=.dsx",
            "screen#fragment=.dsx",
            "écran.dsx",
        )
        val unexpectedAssets = AtomicInteger()
        local.createContext("/") { exchange ->
            val index = Regex("/bad(\\d+)/manifest\\.json").matchEntire(exchange.requestURI.path)
                ?.groupValues?.get(1)?.toIntOrNull()
            if (index != null) {
                exchange.respond("""{"root":"${roots[index]}","files":[]}""".toByteArray())
            } else {
                unexpectedAssets.incrementAndGet()
                exchange.respond("<text value=\"must not load\"/>".toByteArray())
            }
        }
        local.start()
        val origin = "http://127.0.0.1:${local.address.port}"

        roots.indices.forEach { index ->
            val result = loadDesktopRemoteDsx("$origin/bad$index/", "")
            assertEquals(DesktopRemoteDsxFailure.MANIFEST, result.failure)
            assertNull(result.document)
        }
        assertEquals(0, unexpectedAssets.get())
    }

    private fun admitUnsignedDevelopmentContent() {
        RemoteBundleGate._overrideConfig = RemoteBundleGate.Config(
            enabled = false,
            anchors = emptyList(),
            declaredKeyCount = 0,
        )
        RemoteBundleGate._overrideReleaseOTARequired = false
        RemoteBundleGate.setAssetHashes(emptyMap())
    }

    // ── the deadlock guard ────────────────────────────────────────────────────────────────
    //
    // A remote <DSXView> load hung the whole desktop UI. The loader coroutine published its
    // lifecycle phase from inside Compose's FlushCoroutineDispatcher monitor; the broadcast
    // egressed through the registry's SYNCHRONOUS main funnel and parked waiting for the EDT;
    // and the EDT was itself blocked acquiring that very monitor to render. Permanent hang.
    //
    // Reproducing Compose's private monitor here would be fragile and would rot. The INVARIANT
    // that actually closes the deadlock is smaller and exact: publishing a lifecycle phase must
    // never park its caller, no matter what the EDT is doing. Occupy the EDT, publish off it, and
    // require the call to come straight back. Restore the inline broadcast and this times out.
    @Test
    fun publishingALifecyclePhaseNeverBlocksItsCallerWhileTheEventThreadIsBusy() {
        DesktopUiDispatcher.install().use {
            val edtOccupied = CountDownLatch(1)
            val releaseEdt = CountDownLatch(1)
            SwingUtilities.invokeLater {
                edtOccupied.countDown()
                releaseEdt.await(20, TimeUnit.SECONDS)
            }
            assertTrue(edtOccupied.await(20, TimeUnit.SECONDS), "the EDT never picked up the blocking task")

            val returned = CountDownLatch(1)
            val publisher = Thread({
                publishDesktopDsxViewLifecycle("ready", "remote.dsx", "https://fixture.test")
                returned.countDown()
            }, "lifecycle-publisher")
            publisher.start()
            try {
                assertTrue(
                    returned.await(5, TimeUnit.SECONDS),
                    "publishing a lifecycle phase parked its caller while the EDT was busy — the " +
                        "synchronous main funnel is back on this path and a remote <DSXView> load " +
                        "can deadlock the UI",
                )
            } finally {
                releaseEdt.countDown()
                publisher.join(5_000)
            }
        }
    }

    private fun newServer(): HttpServer =
        HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server = it }

    private fun HttpExchange.respond(body: ByteArray, status: Int = 200) {
        responseHeaders.add("Content-Type", "application/octet-stream")
        sendResponseHeaders(status, body.size.toLong())
        responseBody.use { it.write(body) }
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
