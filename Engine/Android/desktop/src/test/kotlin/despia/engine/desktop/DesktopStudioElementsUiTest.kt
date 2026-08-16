@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.Density
import despia.engine.Platform
import despia.engine.JSERunner
import despia.engine.RemoteBundleGate
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.setPath
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import javax.swing.SwingUtilities
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

class DesktopStudioElementsUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    private var remoteServer: HttpServer? = null
    private val originalGate = RemoteBundleGate._overrideConfig
    private val originalReleasePolicy = RemoteBundleGate._overrideReleaseOTARequired

    @AfterEach
    fun restorePlatform() {
        remoteServer?.stop(0)
        remoteServer = null
        RemoteBundleGate._overrideConfig = originalGate
        RemoteBundleGate._overrideReleaseOTARequired = originalReleasePolicy
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun studioWaveTimelineAndTimecodePaintNativePixelsFromBoundData() = runSkikoComposeUiTest(
        size = Size(900f, 620f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val store = StackStore().also {
            it.setPath("tracks", listOf(mapOf("id" to 1, "name" to "Lead"), mapOf("id" to 2, "name" to "Harmony")))
            it.setPath(
                "clips",
                listOf(
                    mapOf(
                        "id" to 11, "track" to 1, "start" to 0.5, "duration" to 2.0,
                        "sourceStart" to 0.0, "sourceDuration" to 3.0,
                        "peaks" to List(96) { index -> absWave(index) },
                    ),
                    mapOf(
                        "id" to 12, "track" to 2, "start" to 3.0, "duration" to 2.5,
                        "sourceStart" to 0.2, "sourceDuration" to 4.0,
                        "peaks" to List(120) { index -> absWave(index + 9) },
                    ),
                ),
            )
        }
        val root = parse(
            """
            <vstack id="studio-root" grow="true" spacing="10" padding="12">
              <StudioTimecode id="studio-timecode" fontSize="30"/>
              <Waveform id="studio-wave" peaks="0.1,0.8,0.3,1.0,0.5" selected="true" height="56"/>
              <StudioTimeline id="studio-timeline" tracks="dsx.variable.tracks" clips="dsx.variable.clips"
                              duration="8" pxPerSecond="100" tempo="120" height="360"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopEdt()
        JSERunner.publishNative(
            "studio:tick",
            mapOf("playhead" to 65.29, "recording" to false, "playing" to true),
        )
        flushDesktopEdt()

        onNodeWithText("1:05.2").assertIsDisplayed()
        onNodeWithTag("studio-wave").assertIsDisplayed()
        onNodeWithTag("studio-timeline").assertIsDisplayed()
        assertPainted(onNodeWithTag("studio-wave").captureToImage(), 4)
        assertPainted(onNodeWithTag("studio-timeline").captureToImage(), 5)
    }

    @Test
    fun timelineRulerAndPitchDragDispatchCanonicalStudioCalls() = runSkikoComposeUiTest(
        size = Size(800f, 520f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val previous = JSERunner.moduleHandle
        val calls = java.util.Collections.synchronizedList(mutableListOf<Pair<String, Map<String, Any?>>>() )
        JSERunner.moduleHandle = { url, args, _ -> calls += url to args; true }
        try {
            val store = StackStore().also {
                it.setPath("tracks", listOf(mapOf("id" to 1, "name" to "Lead", "armed" to true)))
                it.setPath(
                    "clips",
                    listOf(
                        mapOf(
                            "id" to 11, "track" to 1, "start" to 3.0, "duration" to 1.0,
                            "sourceStart" to 0.0, "sourceDuration" to 2.0,
                            "peaks" to List(32) { index -> absWave(index) },
                        ),
                    ),
                )
                it.setPath(
                    "notes",
                    listOf(
                        mapOf(
                            "id" to 4, "start" to 0.0, "duration" to 1.0,
                            "detectedMidi" to 60.0, "targetMidi" to 60.0,
                        ),
                    ),
                )
            }
            val root = parse(
                """
                <vstack grow="true" spacing="8">
                  <StudioTimeline id="control-timeline" tracks="dsx.variable.tracks"
                    clips="dsx.variable.clips" duration="8" pxPerSecond="100" tempo="120" height="240"/>
                  <StudioPitchEditor id="control-pitch" notes="dsx.variable.notes" trackId="9"
                    musicKey="C" musicScale="major" snapToKey="true" height="260"/>
                </vstack>
                """.trimIndent(),
            )
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            // Header is 190 px at this width; x=340 is t=1.5 s on the ruler.
            onNodeWithTag("control-timeline").performTouchInput {
                click(Offset(340f, 10f))
            }
            flushDesktopEdt()
            assertTrue(calls.any { (url, args) ->
                url == "studio://seek" && (args["to"] as? Number)?.toDouble() == 1.5
            })

            // One visible note centered near x=230/y=101; an upward drag retunes C4 to D4.
            onNodeWithTag("control-pitch").performTouchInput {
                swipe(Offset(230f, 101f), Offset(230f, 41f), durationMillis = 300)
            }
            flushDesktopEdt()
            assertTrue(calls.any { (url, args) ->
                url == "studio://setNoteTarget" && args["id"] == 9 && args["noteId"] == 4 &&
                    (args["targetMidi"] as? Number)?.toDouble() == 62.0
            })
        } finally {
            JSERunner.moduleHandle = previous
        }
    }

    @Test
    fun timelinePanRemainsLiveAcrossMultipleDragSamplesAndUpdatesHitTesting() = runSkikoComposeUiTest(
        size = Size(800f, 280f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val store = StackStore().also {
            it.setPath("tracks", listOf(mapOf("id" to 1, "name" to "Lead")))
            it.setPath(
                "clips",
                listOf(
                    mapOf(
                        "id" to 11, "track" to 1, "start" to 6.0, "duration" to 3.0,
                        "sourceStart" to 0.0, "sourceDuration" to 3.0,
                    ),
                ),
            )
        }
        val root = parse(
            """
            <vstack grow="true">
              <StudioTimeline id="pannable-timeline" tracks="dsx.variable.tracks"
                clips="dsx.variable.clips" duration="20" pxPerSecond="100" height="260"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopEdt()

        // Drag empty timeline space left by roughly four seconds. The target clip
        // starts off-screen at x=790; a detector which restarts on its own scroll
        // mutation only processes the first sample and leaves x=500 empty.
        onNodeWithTag("pannable-timeline").performTouchInput {
            swipe(Offset(700f, 100f), Offset(300f, 100f), durationMillis = 500)
        }
        flushDesktopEdt()
        onNodeWithTag("pannable-timeline").performTouchInput {
            click(Offset(500f, 225f))
        }
        flushDesktopEdt()

        val semantics = onNodeWithTag("pannable-timeline").fetchSemanticsNode().config.toString()
        assertTrue(semantics.contains("Selected clip 11"), semantics)
    }

    @Test
    fun trimHandleDispatchesBoundedNonDestructiveWindow() = runSkikoComposeUiTest(
        size = Size(640f, 340f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val previous = JSERunner.moduleHandle
        val calls = java.util.Collections.synchronizedList(mutableListOf<Pair<String, Map<String, Any?>>>() )
        JSERunner.moduleHandle = { url, args, _ -> calls += url to args; true }
        try {
            val store = StackStore().also {
                it.setPath(
                    "clips",
                    listOf(
                        mapOf(
                            "id" to 7, "track" to 1, "start" to 1.0, "duration" to 3.0,
                            "sourceStart" to 0.5, "sourceDuration" to 5.0,
                            "peaks" to List(160) { index -> absWave(index) },
                        ),
                    ),
                )
            }
            val root = parse(
                "<StudioTrim id=\"control-trim\" clips=\"dsx.variable.clips\" clip=\"7\" height=\"300\"/>",
            )
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            // The overview is inset 16 px. Its right handle starts at 70% of 608 px.
            onNodeWithTag("control-trim").performTouchInput {
                swipe(Offset(442f, 178f), Offset(503f, 178f), durationMillis = 300)
            }
            flushDesktopEdt()
            val trim = calls.lastOrNull { it.first == "studio://trimClip" }?.second
            assertTrue(trim != null)
            assertEquals(7, trim["id"])
            assertEquals(0.5, (trim["sourceStart"] as Number).toDouble())
            // Compose removes touch slop before handing drag deltas to the control.
            // The pure trim-math test pins exact arithmetic; this real gesture proves
            // the right handle extends (and remains bounded by the source window).
            assertTrue((trim["duration"] as Number).toDouble() in 3.1..3.5)
            assertEquals(1.0, (trim["start"] as Number).toDouble())
        } finally {
            JSERunner.moduleHandle = previous
        }
    }

    @Test
    fun pitchTrimAndShowHaveRealNativeSurfacesAndBoundSemantics() = runSkikoComposeUiTest(
        size = Size(920f, 700f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val store = StackStore().also {
            it.setPath(
                "clips",
                listOf(
                    mapOf(
                        "id" to 7, "track" to 1, "start" to 0.0, "duration" to 3.0,
                        "sourceStart" to 0.5, "sourceDuration" to 5.0,
                        "peaks" to List(160) { index -> absWave(index) },
                    ),
                ),
            )
            it.setPath(
                "notes",
                listOf(
                    mapOf("id" to 1, "start" to 0.0, "duration" to 1.0, "detectedMidi" to 60.0, "targetMidi" to 62.0),
                    mapOf("id" to 2, "start" to 1.2, "duration" to 0.8, "detectedMidi" to 64.0, "targetMidi" to 64.0),
                ),
            )
        }
        val root = parse(
            """
            <vstack id="studio-editors" grow="true" spacing="10" padding="10">
              <StudioShow id="studio-show" kind="tune" track="1" clips="dsx.variable.clips" height="58"/>
              <StudioPitchEditor id="studio-pitch" notes="dsx.variable.notes" musicKey="D" musicScale="major" height="280"/>
              <StudioTrim id="studio-trim" clips="dsx.variable.clips" clip="7" height="300"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopEdt()

        onNodeWithText("TUNE").assertIsDisplayed()
        val pitch = onNodeWithTag("studio-pitch").assertIsDisplayed().fetchSemanticsNode().config.toString()
        assertTrue(pitch.contains("2 pitch notes"))
        onNodeWithTag("studio-trim").assertIsDisplayed()
        onNodeWithText("3.0 s of 5.0 s kept").assertIsDisplayed()
        assertPainted(onNodeWithTag("studio-pitch").captureToImage(), 5)
        assertPainted(onNodeWithTag("studio-trim").captureToImage(), 5)
    }

    @Test
    fun containerDimensionsShadowByNearestAncestorAndUnavailableRuntimeFailsNatively() = runSkikoComposeUiTest(
        size = Size(760f, 520f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val store = StackStore()
        val root = parse(
            """
            <vstack id="contract-root" grow="true" padding="16">
              <head>
                <variable as="failed">return 0</variable>
                <action as="markFailed">dsx.variable.failed = dsx.variable.failed + 1</action>
              </head>
              <vstack id="outer-container" width="320" height="160" container="true">
                <vstack id="inner-container" width="140" height="80" container="true">
                  <text id="container-readout" value="{{ dsx.element.width }}x{{ dsx.element.height }}"/>
                </vstack>
              </vstack>
              <DSXView id="unavailable-view" src="https://user:secret@example.test/private.dsx"
                       on:fail="markFailed"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopEdt()
        flushDesktopEdt()

        onNodeWithText("140x80").assertIsDisplayed()
        onNodeWithText("DSX native screen unavailable").assertIsDisplayed()
        onNodeWithText("remote_dsx_url_invalid").assertIsDisplayed()
        onNodeWithText("Try again").assertIsDisplayed()
        assertEquals(1.0, store.getPath("failed"))
        val surfaceText = onNodeWithTag("unavailable-view").fetchSemanticsNode().config.toString()
        assertTrue(!surfaceText.contains("secret") && !surfaceText.contains("private.dsx"))
    }

    @Test
    fun remoteDsxViewRendersThroughTheNativeComposeTree() = runSkikoComposeUiTest(
        size = Size(640f, 360f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        RemoteBundleGate._overrideConfig = RemoteBundleGate.Config(false, emptyList(), 0)
        RemoteBundleGate._overrideReleaseOTARequired = false
        DesktopHost.boot("Linux")
        val local = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { remoteServer = it }
        val body = """
            <vstack padding="16">
              <head>
                <variable as="remoteTitle">return "Remote DSX native"</variable>
                <component as="RemoteCard"><text value="{{ dsx.variable.remoteTitle }}"/></component>
              </head>
              <RemoteCard/>
            </vstack>
        """.trimIndent().toByteArray()
        local.createContext("/screen.dsx") { exchange ->
            exchange.responseHeaders.add("Content-Type", "application/xml; charset=utf-8")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        local.start()
        val root = parse(
            """
            <vstack grow="true"><DSXView id="remote-native-view"
              src="http://127.0.0.1:${local.address.port}/screen.dsx"/></vstack>
            """.trimIndent(),
        )

        setContent { DesktopSurface(root, StackStore()) }
        waitUntil(timeoutMillis = 5_000) {
            runCatching { onNodeWithText("Remote DSX native").fetchSemanticsNode() }.isSuccess
        }

        onNodeWithText("Remote DSX native").assertIsDisplayed()
        onNodeWithTag("remote-native-view").assertIsDisplayed()
    }

    private fun parse(markup: String): StackNode = requireNotNull(
        DesktopHost.parseDocument(DesktopHost.Document("desktop-studio-ui-test.dsx", markup)),
    )

    private fun androidx.compose.ui.test.ComposeUiTest.flushDesktopEdt() {
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        mainClock.advanceTimeByFrame()
        waitForIdle()
    }

    private fun assertPainted(image: androidx.compose.ui.graphics.ImageBitmap, minimumColors: Int) {
        val pixels = image.toPixelMap()
        val colors = linkedSetOf<Int>()
        val xStep = (image.width / 48).coerceAtLeast(1)
        val yStep = (image.height / 32).coerceAtLeast(1)
        for (y in 0 until image.height step yStep) {
            for (x in 0 until image.width step xStep) colors += pixels[x, y].toArgb()
        }
        assertTrue(colors.size >= minimumColors, "expected native paint diversity, got ${colors.size} colors")
    }

    private fun absWave(index: Int): Double = kotlin.math.abs(kotlin.math.sin(index * 0.31))
}
