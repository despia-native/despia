@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.setPath
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import javax.swing.SwingUtilities

/**
 * Display-server-free pixel tests of the desktop `<scene>` element (dsx-scene.md P2):
 * the :core software rasterizer painted through the real Compose/Skia scene the
 * Windows/Linux application ships. The corpus (SceneConformanceTest, :core) pins the
 * MATH; these tests pin the desktop surface: non-blank pixels, a store write changing
 * them, and tap picking firing the authored handler.
 *
 * The DesktopRendererUiTest lesson applies verbatim: EVERY assertion names its measured
 * value — a bare failure inside one runSkikoComposeUiTest lambda reports at the
 * enclosing call line and says nothing about which assertion broke or what it saw.
 */
class DesktopSceneUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun scenePaintsNonBlankAndAStoreWriteChangesThePixels() {
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath("spin", 0.0)
        val root = parse(
            """
            <stack id="scene-page" grow="true" background="#101418" padding="16">
              <scene id="scene-view" width="320" height="180" background="#0b1020">
                <camera position="0 1.2 4" look-at="0 0 0" fov="60"/>
                <light kind="ambient" intensity="0.4"/>
                <light kind="directional" position="3 5 2" intensity="0.8"/>
                <box id="cube" rotation="0 {{ dsx.variable.spin }} 0" size="1 1 1" color="#2563eb"
                     on:tap="dsx.variable.picked = 'cube'"/>
                <sphere position="1.6 0 0" radius="0.4" color="#f59e0b"/>
                <plane position="0 -0.5 0" size="10 10" rotation="-90 0 0" color="#1e293b"/>
              </scene>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(
            size = Size(640f, 400f),
            density = Density(1f),
            testTimeout = 20.seconds,
        ) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            onNodeWithTag("scene-view").assertIsDisplayed()
            val before = sampledPixels()
            val distinct = before.toSet()
            // background + lit ground plane + box faces + many sphere facets: a capture
            // with one colour never rasterized, two-three colours lost the geometry
            assertTrue(
                distinct.size >= 8,
                "scene capture should hold rasterized geometry, saw ${distinct.size} distinct " +
                    "colour(s) across ${before.size} samples: " +
                    distinct.take(8).joinToString { "#%08X".format(it) },
            )

            // the reactive contract: writing the bound store value re-rasterizes
            SwingUtilities.invokeAndWait { store.setPath("spin", 55.0) }
            flushDesktopEdt()
            val after = sampledPixels()
            assertEquals(55.0, store.getPath("spin"), "the spin write must have landed in the store")
            assertTrue(
                before != after,
                "spin 0 → 55 must change the captured scene pixels (sampled ${before.size} points; " +
                    "first differing sample not found — the framebuffer did not re-rasterize)",
            )

            // tap picking v0: a click lands at the semantics-node center, which this scene
            // aims at the box — the kernel pickRay/raySphere walk must fire its handler
            onNodeWithTag("scene-view").performClick()
            flushDesktopEdt()
            assertEquals(
                "cube", store.getPath("picked"),
                "the center tap must pick the box and run its on:tap through the runner " +
                    "(spin=${store.getPath("spin")})",
            )
        }
    }

    @Test
    fun onFrameTicksMutateTheStoreAndText3dPaintsGlyphs() {
        // P4: an on:frame handler mutates spin every emitted tick (the :core frame
        // clock's 60/s budget — a 16 ms test frame coalesces every other tick), and a
        // <text3d> billboard paints UNLIT WHITE glyphs the sample grid must find.
        // autoAdvance stays OFF: a frame loop never idles under an auto-advancing
        // clock, so this test drives every frame by hand.
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath("spin", 0.0)
        val root = parse(
            """
            <stack id="scene-page" grow="true" background="#101418" padding="16">
              <scene id="scene-view" width="320" height="180" background="#0b1020"
                     on:frame="dsx.variable.spin = dsx.variable.spin + 10">
                <camera position="0 1.2 4" look-at="0 0 0" fov="60"/>
                <light kind="ambient" intensity="0.4"/>
                <light kind="directional" position="3 5 2" intensity="0.8"/>
                <box rotation="0 {{ dsx.variable.spin }} 0" size="1 1 1" color="#2563eb"/>
                <text3d value="DSX" size="0.8" position="0 1.1 0" color="#ffffff"/>
              </scene>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(
            size = Size(640f, 400f),
            density = Density(1f),
            testTimeout = 30.seconds,
        ) {
            mainClock.autoAdvance = false
            setContent { DesktopSurface(root, store) }
            // settle the initial composition/layout/raster with hand-driven frames
            repeat(3) {
                if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
                mainClock.advanceTimeByFrame()
                waitForIdle()
            }
            onNodeWithTag("scene-view").assertIsDisplayed()
            val before = sampledPixels()
            assertTrue(
                before.toSet().size >= 4,
                "the scene should have rasterized before the frame assertions, saw " +
                    "${before.toSet().size} distinct colour(s)",
            )
            // text3d glyph evidence: unlit white strokes against the dark rig — some
            // sample must be near-white (no other scene element is)
            val whiteish = before.count { argb ->
                (argb shr 16 and 0xFF) >= 200 && (argb shr 8 and 0xFF) >= 200 && (argb and 0xFF) >= 200
            }
            assertTrue(
                whiteish > 0,
                "text3d should paint near-white glyph pixels inside its quad; " +
                    "0 of ${before.size} samples were ≥ #C8C8C8",
            )
            val spinBefore = (store.getPath("spin") as? Number)?.toDouble() ?: 0.0

            // drive frames: 16 ms apart → the 60/s budget emits every other tick
            repeat(8) {
                if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
                mainClock.advanceTimeByFrame()
                waitForIdle()
            }
            val spinAfter = (store.getPath("spin") as? Number)?.toDouble() ?: 0.0
            assertTrue(
                spinAfter > spinBefore,
                "on:frame must have run through the runner and advanced spin " +
                    "(before=$spinBefore after=$spinAfter)",
            )
            val after = sampledPixels()
            assertTrue(
                before != after,
                "the on:frame spin writes (spin=$spinAfter) must change the captured " +
                    "framebuffer (${before.size} samples, none differed)",
            )
        }
    }

    @Test
    fun transitionGlidesUnderAHandDrivenClock() {
        // P5: `transition="position 400ms linear"` — a store write RETARGETS the box
        // from its current rendered value toward the new base (the CSS interrupt
        // model). Under the hand-driven mainClock, a mid-flight capture must differ
        // from BOTH endpoints: equal-to-start means the loop never ran, equal-to-end
        // means the value snapped.
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath("x", -1.5)
        val root = parse(
            """
            <stack id="scene-page" grow="true" background="#101418" padding="16">
              <scene id="scene-view" width="320" height="180" background="#0b1020">
                <camera position="0 0 5" look-at="0 0 0" fov="60"/>
                <box position="{{ dsx.variable.x }} 0 0" transition="position 400ms linear"
                     size="1 1 1" color="#2563eb"/>
              </scene>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(
            size = Size(640f, 400f),
            density = Density(1f),
            testTimeout = 30.seconds,
        ) {
            mainClock.autoAdvance = false
            setContent { DesktopSurface(root, store) }
            repeat(3) { flushDesktopEdt() }
            onNodeWithTag("scene-view").assertIsDisplayed()
            val start = sampledPixels()
            assertTrue(
                start.toSet().size >= 2,
                "the box should have rasterized before the glide, saw ${start.toSet().size} distinct colour(s)",
            )

            // the retargeting write: base −1.5 → +1.5 glides over 400ms
            SwingUtilities.invokeAndWait { store.setPath("x", 1.5) }
            // ~8 hand-driven 16ms frames ≈ 128ms into the 400ms glide — mid-flight
            repeat(8) { flushDesktopEdt() }
            val mid = sampledPixels()
            assertTrue(
                start != mid,
                "128ms into the glide the capture must differ from the start " +
                    "(the transition loop never advanced the override)",
            )

            // ride past the 400ms clip (plus margin) — the glide completes at base
            repeat(40) { flushDesktopEdt() }
            val end = sampledPixels()
            assertTrue(
                mid != end,
                "the mid-flight capture must differ from the settled end " +
                    "(a snap would jump straight to the new base)",
            )
            assertTrue(
                start != end,
                "the settled capture must differ from the start (the box moved ${
                    store.getPath("x")})",
            )
        }
    }

    @Test
    fun boundRowSpawnAppearsOnAStoreWrite() {
        // P5: `<group bind key>` — an empty array draws nothing; writing one row
        // instantiates the keyed template and its exact ambient-lit red pixels appear.
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath("enemies", emptyList<Any?>())
        val root = parse(
            """
            <stack id="scene-page" grow="true" background="#101418" padding="16">
              <scene id="scene-view" width="320" height="180" background="#000000">
                <camera position="0 0 5" look-at="0 0 0" fov="60"/>
                <group bind="dsx.variable.enemies" key="id">
                  <box position="{{ item.x }} 0 0" size="1 1 1" color="#ff0000"/>
                </group>
              </scene>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(
            size = Size(640f, 400f),
            density = Density(1f),
            testTimeout = 20.seconds,
        ) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()
            onNodeWithTag("scene-view").assertIsDisplayed()
            fun reddish(argb: Int): Boolean =
                (argb shr 16 and 0xFF) >= 200 && (argb shr 8 and 0xFF) <= 80 && (argb and 0xFF) <= 80
            val before = sampledPixels()
            assertEquals(
                0, before.count { reddish(it) },
                "an empty bound array must draw no red row pixels",
            )

            SwingUtilities.invokeAndWait {
                store.setPath("enemies", listOf(mapOf("id" to "e1", "x" to 0.0)))
            }
            flushDesktopEdt()
            flushDesktopEdt()
            val after = sampledPixels()
            assertTrue(
                after.count { reddish(it) } > 0,
                "the spawned bound row must paint red pixels " +
                    "(0 of ${after.size} samples were red after the write)",
            )
        }
    }

    /** a deterministic 64×48 sample grid over the scene node's capture */
    private fun ComposeUiTest.sampledPixels(tag: String = "scene-view"): List<Int> {
        val image = onNodeWithTag(tag).captureToImage()
        val pixels = image.toPixelMap()
        val out = ArrayList<Int>()
        val xStep = (image.width / 64).coerceAtLeast(1)
        val yStep = (image.height / 48).coerceAtLeast(1)
        for (y in 0 until image.height step yStep) {
            for (x in 0 until image.width step xStep) out.add(pixels[x, y].toArgb())
        }
        return out
    }

    @Test
    fun sceneBusHandleDrivesTheMountedSceneAndCapturesPng() {
        // G5 (dsx-game.md §2): the mounted element registers a SceneBusHandle into the
        // :core SceneRegistry seam — the door the Core/Scene module drives it through.
        // This test IS the module call path minus the bus envelope: resolve the handle
        // by the scene's id, set/pick/stats/capture, and decode the capture PNG back
        // to the framebuffer's exact dimensions (javax.imageio both ways).
        DesktopHost.boot("Linux")
        despia.engine.scene.SceneRegistry.clearForTest()
        val store = StackStore()
        val root = parse(
            """
            <stack id="bus-page" grow="true" background="#101418" padding="16">
              <scene id="bus-scene" width="320" height="180" background="#0b1020">
                <camera position="0 0 5" look-at="0 0 0"/>
                <light kind="ambient" intensity="0.6"/>
                <box id="crate" position="0 0 0" size="1 1 1" color="#2563eb"/>
              </scene>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(
            size = Size(640f, 400f),
            density = Density(1f),
            testTimeout = 20.seconds,
        ) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()
            onNodeWithTag("bus-scene").assertIsDisplayed()

            val handle = requireNotNull(despia.engine.scene.SceneRegistry.resolve("bus-scene")) {
                "the mounted scene must register under its id attr " +
                    "(registered keys: ${despia.engine.scene.SceneRegistry.keys()})"
            }
            assertEquals(handle, despia.engine.scene.SceneRegistry.resolve(null),
                "the only mounted scene is the default target")

            // stats + nodes answer the corpus folds
            val stats = handle.stats()
            assertEquals(3, stats.nodes, "camera + light + box")
            val crate = handle.nodes().first { it.id == "crate" }
            assertEquals("#2563eb", crate.props["color"], "the resolved color rides the bus tree")

            // pick: dead center hits the origin crate, without firing any handler
            val hit = requireNotNull(handle.pick(0.5, 0.5)) { "a center pick must hit the crate" }
            assertEquals("crate", hit.id)

            // capture: framebuffer → PNG bytes → base64; decodes to the raster dims
            val captured = requireNotNull(handle.capture()) { "a live desktop scene must capture" }
            val png = java.util.Base64.getDecoder().decode(captured.image)
            assertTrue(png.isNotEmpty(), "capture must carry PNG bytes")
            val decoded = requireNotNull(
                javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(png)),
            ) { "the capture must decode as a PNG image" }
            assertEquals(captured.width, decoded.width,
                "the decoded PNG width must match the reported framebuffer width")
            assertEquals(captured.height, decoded.height,
                "the decoded PNG height must match the reported framebuffer height")
            assertEquals(320, decoded.width, "the composed 320x180 scene rasters 1:1 under the 640 cap")
            assertEquals(180, decoded.height, "the composed 320x180 scene rasters 1:1 under the 640 cap")

            // set: a bus write rides the base plane and changes the rendered pixels
            val before = sampledPixels("bus-scene")
            assertEquals("ok", handle.set("crate", "color", "#f59e0b"))
            flushDesktopEdt()
            val after = sampledPixels("bus-scene")
            assertTrue(before != after,
                "a bus set (color #2563eb → #f59e0b) must change the captured pixels " +
                    "(sampled ${before.size} points)")
            assertEquals("#f59e0b", handle.nodes().first { it.id == "crate" }.props["color"],
                "the write reads back on the resolved plane")
        }
        despia.engine.scene.SceneRegistry.clearForTest()
    }

    @Test
    fun physicsBallRestsTicksStopAsleepAndABusVelocityWriteRelaunches() {
        // G2 (dsx-game.md §2): the fixed-tick solver on the desktop surface under the
        // hand-driven mainClock — the DesktopSceneUiTest twin of the :render physics
        // fold tests. Corpus sim/sleep rig verbatim (ground half 10 0.5 10, ball r 0.5
        // dropped from y=1): the ball RESTS at the corpus height (center y = 0.494319,
        // asserted as the red centroid at its projected screen row), on:tick counts the
        // fixed steps and STOPS once the world sleeps (the loop-existence law), and a
        // bus `set velocity` (the impulse verb — jump() is exactly this) relaunches it.
        DesktopHost.boot("Linux")
        despia.engine.scene.SceneRegistry.clearForTest()
        val store = StackStore()
        store.setPath("ticks", 0.0)
        val root = parse(
            """
            <stack id="scene-page" grow="true" background="#101418" padding="16">
              <scene id="physics-scene" width="320" height="180" background="#0b1020"
                     on:tick="dsx.variable.ticks = dsx.variable.ticks + 1">
                <camera position="0 1 6" look-at="0 0.5 0" fov="60"/>
                <box physics="static" position="0 -0.5 0" size="20 1 20" color="#1e293b"/>
                <sphere id="ball" physics="dynamic" position="0 1 0" radius="0.5" color="#ff0000"/>
              </scene>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(
            size = Size(640f, 400f),
            density = Density(1f),
            testTimeout = 90.seconds,
        ) {
            mainClock.autoAdvance = false
            setContent { DesktopSurface(root, store) }
            repeat(3) { flushDesktopEdt() }
            onNodeWithTag("physics-scene").assertIsDisplayed()
            val handle = requireNotNull(despia.engine.scene.SceneRegistry.resolve("physics-scene")) {
                "the mounted physics scene must register " +
                    "(keys: ${despia.engine.scene.SceneRegistry.keys()})"
            }
            fun ballProps(): Map<String, String> = handle.nodes().first { it.id == "ball" }.props

            // drive the hand clock until the ball sleeps (corpus sim/sleep: awake at
            // tick 76, sleeping at 77 — 16 ms test frames emit every other tick)
            var settleFlushes = 0
            while (settleFlushes < 300 && ballProps()["sleeping"] != "true") {
                flushDesktopEdt()
                settleFlushes += 1
            }
            assertEquals(
                "true", ballProps()["sleeping"],
                "the dropped ball must reach sleep under the hand-driven clock " +
                    "($settleFlushes flushes, ticks=${store.getPath("ticks")})",
            )
            val ticksAsleep = (store.getPath("ticks") as? Number)?.toDouble() ?: -1.0
            assertTrue(
                ticksAsleep >= 78.0,
                "on:tick must have counted the fixed steps to sleep — the corpus pins " +
                    "sleep AFTER tick 77's step (saw $ticksAsleep)",
            )

            // the loop-existence law: a fully-asleep world stops the loop — on:tick too
            repeat(10) { flushDesktopEdt() }
            assertEquals(
                ticksAsleep, (store.getPath("ticks") as? Number)?.toDouble() ?: -1.0,
                "an asleep world must dispatch no further on:tick (the loop stopped)",
            )

            // the pixel half: the resting ball's red centroid sits at the PROJECTED
            // corpus rest height (center y = 0.494319 — the :render regional check's twin)
            val image = onNodeWithTag("physics-scene").captureToImage()
            val map = image.toPixelMap()
            var count = 0
            var sumY = 0.0
            for (y in 0 until image.height) {
                for (x in 0 until image.width) {
                    val argb = map[x, y].toArgb()
                    if ((argb shr 16 and 0xFF) >= 200 && (argb shr 8 and 0xFF) <= 80 && (argb and 0xFF) <= 80) {
                        count += 1
                        sumY += y
                    }
                }
            }
            assertTrue(
                count > 0,
                "the resting ball must paint red pixels (none in ${image.width}x${image.height})",
            )
            val view = despia.engine.scene.mat4LookAt(
                doubleArrayOf(0.0, 1.0, 6.0), doubleArrayOf(0.0, 0.5, 0.0),
            )
            val proj = despia.engine.scene.mat4Perspective(
                60.0, image.width.toDouble() / image.height, 0.1, 1000.0,
            )
            val ndc = despia.engine.scene.projectToNdc(proj, view, doubleArrayOf(0.0, 0.494319, 0.0))
            val expectedY = (1.0 - (ndc[1] + 1.0) / 2.0) * image.height
            val centroidY = sumY / count
            assertTrue(
                kotlin.math.abs(centroidY - expectedY) <= 12.0,
                "the red centroid row must sit at the projected corpus rest height " +
                    "(centroid $centroidY vs projected $expectedY, $count red pixels)",
            )

            // the impulse verb: a bus velocity write wakes the body, on:tick restarts,
            // and the ball re-settles to sleep again
            assertEquals("ok", handle.set("ball", "velocity", "0 3 0"), "the bus write lands")
            repeat(6) { flushDesktopEdt() }
            val ticksAfterWrite = (store.getPath("ticks") as? Number)?.toDouble() ?: -1.0
            assertTrue(
                ticksAfterWrite > ticksAsleep,
                "the bus velocity write must wake the body and restart on:tick " +
                    "(asleep=$ticksAsleep after=$ticksAfterWrite)",
            )
            var resettleFlushes = 0
            while (resettleFlushes < 400 && ballProps()["sleeping"] != "true") {
                flushDesktopEdt()
                resettleFlushes += 1
            }
            assertEquals(
                "true", ballProps()["sleeping"],
                "the launched ball must re-settle and sleep again ($resettleFlushes flushes)",
            )
        }
        despia.engine.scene.SceneRegistry.clearForTest()
    }

    private fun parse(markup: String): StackNode = requireNotNull(
        DesktopHost.parseDocument(DesktopHost.Document("scene-ui-test.dsx", markup)),
    )

    /** the DesktopRendererUiTest seam, verbatim: drain AWT, advance one deterministic
     * frame, settle — production publishes store state through the AWT event thread */
    private fun ComposeUiTest.flushDesktopEdt() {
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        mainClock.advanceTimeByFrame()
        waitForIdle()
    }
}
