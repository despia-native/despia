@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import despia.engine.DSX
import despia.engine.DSXEvents
import despia.engine.DSXSource
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.setPath
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

class DesktopRemoteDsxLifecycleUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    private val productionLoader = desktopRemoteDsxLoader

    @AfterEach
    fun restoreLoader() {
        desktopRemoteDsxLoader = productionLoader
        DSXSource.installStampStore(null)
    }

    @Test
    fun sourceChangeCancelsOldLoadAndLifecycleProvenanceFollowTheMountedNativeScreen() =
        runSkikoComposeUiTest(
            size = Size(640f, 360f),
            density = Density(1f),
            testTimeout = 20.seconds,
        ) {
            DesktopHost.boot("Linux")
            DSXSource.installStampStore(null)
            val slowStarted = CompletableDeferred<Unit>()
            val slowCancelled = CompletableDeferred<Unit>()
            val readyRoot = requireNotNull(
                DesktopHost.parseDocument(
                    DesktopHost.Document("ready.dsx", "<text value=\"Replacement ready\"/>"),
                ),
            )
            desktopRemoteDsxLoader = { src, _, _ ->
                if (src == "slow.dsx") {
                    slowStarted.complete(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        slowCancelled.complete(Unit)
                    }
                }
                DesktopRemoteDsxResult(
                    document = DesktopRemoteDsxDocument(
                        readyRoot,
                        emptyMap(),
                        DesktopRemoteFootprint(128, 1, 1),
                        DesktopRemoteDsxServing.CACHE,
                    ),
                )
            }
            val phases = Collections.synchronizedList(mutableListOf<Pair<String, Map<*, *>>>())
            val subscription = DSXEvents().on("dsx-view") { phase, payload ->
                phases += phase to ((payload as? Map<*, *>) ?: emptyMap<Any?, Any?>())
            }
            val store = StackStore()
            var source by mutableStateOf("slow.dsx")
            var mounted by mutableStateOf(true)
            try {
                setContent {
                    if (mounted) DesktopSurface(
                        despia.engine.StackNode(
                            "DSXView",
                            mapOf("src" to source, "origin" to "https://example.test"),
                            emptyList(),
                        ),
                        store,
                    )
                }
                waitUntil(timeoutMillis = 5_000) { slowStarted.isCompleted }
                runOnUiThread { source = "ready.dsx" }
                waitUntil(timeoutMillis = 5_000) { slowCancelled.isCompleted }
                waitUntil(timeoutMillis = 5_000) {
                    runCatching { onNodeWithText("Replacement ready").fetchSemanticsNode() }.isSuccess
                }

                val snapshot = phases.toList()
                assertTrue(snapshot.any { it.first == "loading" && it.second["src"] == "slow.dsx" })
                assertTrue(snapshot.any { it.first == "loading" && it.second["src"] == "ready.dsx" })
                assertTrue(snapshot.any { it.first == "ready" && it.second["src"] == "ready.dsx" })
                assertFalse(snapshot.any { it.first == "ready" && it.second["src"] == "slow.dsx" })
                val source = DSX.state.getPath("source.view") as Map<*, *>
                assertEquals("cache", source["serving"])
                assertEquals("never", source["state"])

                runOnUiThread { mounted = false }
                waitForIdle()
                waitUntil(timeoutMillis = 5_000) {
                    phases.any { it.first == "disappear" && it.second["src"] == "ready.dsx" }
                }
                assertEquals(
                    1,
                    phases.count { it.first == "disappear" && it.second["src"] == "ready.dsx" },
                )
            } finally {
                subscription.cancel()
            }
        }

    @Test
    fun missingSourceEmitsFailedWithoutInventingALoadingOrReadyPhase() = runSkikoComposeUiTest(
        size = Size(520f, 260f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        desktopRemoteDsxLoader = productionLoader
        val phases = Collections.synchronizedList(mutableListOf<String>())
        val subscription = DSXEvents().on("dsx-view") { phase, _ -> phases += phase }
        try {
            val root = requireNotNull(
                DesktopHost.parseDocument(
                    DesktopHost.Document("missing-source.dsx", "<DSXView src=\"\"/>"),
                ),
            )
            setContent { DesktopSurface(root, StackStore()) }
            waitUntil(timeoutMillis = 5_000) {
                runCatching { onNodeWithText("DSX native screen unavailable").fetchSemanticsNode() }.isSuccess
            }
            assertEquals(listOf("failed"), phases.toList())
        } finally {
            subscription.cancel()
        }
    }

    @Test
    fun retryStartsANewLifecycleAndPublishesOriginOnlyAfterAdmission() = runSkikoComposeUiTest(
        size = Size(560f, 300f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        DSXSource.installStampStore(null)
        DSX.state.setPath("source.view", null)
        val attempts = AtomicInteger()
        val readyRoot = requireNotNull(
            DesktopHost.parseDocument(
                DesktopHost.Document("retry-ready.dsx", "<text value=\"Retry ready\"/>"),
            ),
        )
        desktopRemoteDsxLoader = { _, _, _ ->
            if (attempts.incrementAndGet() == 1) {
                throw IllegalStateException("synthetic adapter failure")
            } else {
                DesktopRemoteDsxResult(
                    document = DesktopRemoteDsxDocument(
                        readyRoot,
                        emptyMap(),
                        DesktopRemoteFootprint(96, 1, 1),
                        DesktopRemoteDsxServing.ORIGIN,
                    ),
                )
            }
        }
        val phases = Collections.synchronizedList(mutableListOf<String>())
        val subscription = DSXEvents().on("dsx-view") { phase, _ -> phases += phase }
        try {
            val root = requireNotNull(
                DesktopHost.parseDocument(
                    DesktopHost.Document(
                        "retry-host.dsx",
                        "<DSXView src=\"screen.dsx\" origin=\"https://example.test\"/>",
                    ),
                ),
            )
            setContent { DesktopSurface(root, StackStore()) }
            waitUntil(timeoutMillis = 5_000) {
                runCatching { onNodeWithText("Try again").fetchSemanticsNode() }.isSuccess
            }
            assertEquals(listOf("loading", "failed"), phases.toList())
            assertEquals(null, DSX.state.getPath("source.view"))

            onNodeWithText("Try again").performClick()
            waitUntil(timeoutMillis = 5_000) {
                runCatching { onNodeWithText("Retry ready").fetchSemanticsNode() }.isSuccess
            }
            assertEquals(listOf("loading", "failed", "loading", "ready"), phases.toList())
            assertEquals(2, attempts.get())
            val source = DSX.state.getPath("source.view") as Map<*, *>
            assertEquals("origin", source["serving"])
            assertEquals("live", source["state"])
        } finally {
            subscription.cancel()
        }
    }
}
