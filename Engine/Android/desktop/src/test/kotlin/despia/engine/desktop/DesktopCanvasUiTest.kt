@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.Density
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.setPath
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import javax.swing.SwingUtilities

/**
 * Display-server-free pixel tests of the desktop `<canvas>` (U04) and its `<ink>` child.
 *
 * The corpus (CanvasConformanceTest / the ink cases in :core) pins the LAW, and it already ran
 * green on this renderer before a single pixel could be drawn - which is precisely the failure
 * this file exists to prevent being repeated. What is unproven by a corpus is the SURFACE:
 * that tier 1 paints, that a tier-2 command list replays, that committed ink comes back as
 * ordinary geometry, that a drag paints under the pointer WITHOUT writing the store, that
 * pointer-up writes exactly once in the wire shape, and that a declared a11y overlay is
 * readable. Those are the same seven things the browser oracle asserts on the web, so the two
 * renderers are held to one description of the element rather than two.
 *
 * The DesktopRendererUiTest lesson applies verbatim: EVERY assertion names its measured value.
 */
class DesktopCanvasUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun tierOneChildrenAndTierTwoCommandsBothPaint() {
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath(
            "ops",
            listOf(
                listOf("setFillStyle", "#00FF00"),
                listOf("beginPath"),
                listOf("rect", 10.0, 10.0, 60.0, 60.0),
                listOf("fill"),
            ),
        )
        val root = parse(
            """
            <stack id="canvas-page" grow="true" background="#101418" padding="0">
              <canvas id="tier1" height="120" a11yLabel="Declared">
                <rect x="10" y="10" width="100" height="80" fill="#FF0000"/>
              </canvas>
              <canvas id="tier2" height="120" a11yLabel="Replayed" commands="dsx.variable.ops"/>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(size = Size(320f, 400f), density = Density(1f), testTimeout = 20.seconds) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            onNodeWithTag("tier1").assertIsDisplayed()
            val declared = sampledPixels("tier1")
            assertTrue(
                declared.any { it == RED },
                "the tier-1 <rect fill=\"#FF0000\"> must reach the surface; sampled " +
                    "${declared.size} points and saw ${declared.toSet().size} distinct colour(s): " +
                    declared.toSet().take(6).joinToString { "#%08X".format(it) },
            )

            val replayed = sampledPixels("tier2")
            assertTrue(
                replayed.any { it == GREEN },
                "the tier-2 command list must replay through the kernel recorder; sampled " +
                    "${replayed.size} points and saw ${replayed.toSet().size} distinct colour(s): " +
                    replayed.toSet().take(6).joinToString { "#%08X".format(it) },
            )
        }
    }

    @Test
    fun committedInkPaintsAsOrdinaryGeometryAndClearsOnAStateWrite() {
        DesktopHost.boot("Linux")
        val store = StackStore()
        // the wire shape the corpus pins: normalized pairs plus a point width
        store.setPath(
            "sig",
            listOf(
                mapOf(
                    "points" to listOf(
                        listOf(0.1, 0.5), listOf(0.3, 0.2), listOf(0.6, 0.8), listOf(0.9, 0.4),
                    ),
                    "width" to 6.0,
                ),
            ),
        )
        val root = parse(
            """
            <stack id="canvas-page" grow="true" background="#FFFFFF" padding="0">
              <canvas id="pad" height="200" a11yLabel="Sketch">
                <ink bind="dsx.variable.sig" stroke="#0000FF" strokeWidth="6"/>
              </canvas>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(size = Size(320f, 400f), density = Density(1f), testTimeout = 20.seconds) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            val inked = sampledPixels("pad")
            assertTrue(
                inked.any { it == BLUE },
                "the committed strokes must fold into tier-1 stroked paths and paint; sampled " +
                    "${inked.size} points and saw ${inked.toSet().size} distinct colour(s): " +
                    inked.toSet().take(6).joinToString { "#%08X".format(it) },
            )

            // clearing is a STATE WRITE - there is no control channel on any renderer
            SwingUtilities.invokeAndWait { store.setPath("sig", emptyList<Any?>()) }
            flushDesktopEdt()
            val cleared = sampledPixels("pad")
            assertTrue(
                cleared.none { it == BLUE },
                "`sig = []` must empty the surface; ${cleared.count { it == BLUE }} blue sample(s) " +
                    "survived the write",
            )
        }
    }

    @Test
    fun aDragPaintsWithoutWritingTheStoreAndPointerUpCommitsOnce() {
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath("sig", emptyList<Any?>())
        store.setPath("started", 0.0)
        store.setPath("ended", 0.0)
        val root = parse(
            """
            <stack id="canvas-page" grow="true" background="#FFFFFF" padding="0">
              <canvas id="pad" height="200" a11yLabel="Sketch"
                      on:strokeStart="dsx.variable.started = dsx.variable.started + 1"
                      on:strokeEnd="dsx.variable.ended = dsx.variable.ended + 1">
                <ink bind="dsx.variable.sig" stroke="#0000FF" strokeWidth="5"/>
              </canvas>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(size = Size(320f, 400f), density = Density(1f), testTimeout = 20.seconds) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            val blank = sampledPixels("pad")
            assertTrue(
                blank.none { it == BLUE },
                "an empty drawing paints nothing; ${blank.count { it == BLUE }} blue sample(s) before " +
                    "any stroke",
            )

            var midStrokeRows: Int = -1
            var midStrokePainted = false
            onNodeWithTag("pad").performTouchInput {
                down(Offset(20f, 150f))
                moveTo(Offset(80f, 60f))
                moveTo(Offset(160f, 140f))
                moveTo(Offset(240f, 40f))
            }
            flushDesktopEdt()
            midStrokeRows = (store.getPath("sig") as? List<*>)?.size ?: -1
            midStrokePainted = sampledPixels("pad").any { it == BLUE }

            assertTrue(
                midStrokePainted,
                "the in-flight stroke must paint under the pointer before it is committed " +
                    "(no blue sample while the pointer was down)",
            )
            assertEquals(
                0, midStrokeRows,
                "a moved pointer must NEVER write the store - that is the whole point of <ink>; " +
                    "the bound value already held $midStrokeRows stroke(s) mid-gesture",
            )

            onNodeWithTag("pad").performTouchInput { up() }
            flushDesktopEdt()

            val committed = store.getPath("sig") as? List<*>
            assertNotNull(committed, "pointer-up must write the bound value")
            assertEquals(
                1, committed.size,
                "pointer-up writes the store exactly once; ${committed.size} stroke(s) after one gesture",
            )
            assertEquals(
                1.0, store.getPath("started"),
                "the surface raises strokeStart once (saw ${store.getPath("started")})",
            )
            assertEquals(
                1.0, store.getPath("ended"),
                "the surface raises strokeEnd once (saw ${store.getPath("ended")})",
            )

            @Suppress("UNCHECKED_CAST")
            val stroke = committed[0] as Map<String, Any?>
            val points = stroke["points"] as? List<*>
            assertNotNull(points, "the committed stroke must carry its points: $stroke")
            assertTrue(
                points.size > 1,
                "a four-sample drag keeps more than one point; kept ${points.size}",
            )
            assertTrue(
                points.all { pair ->
                    val xy = pair as? List<*> ?: return@all false
                    xy.size == 2 && xy.all { n ->
                        val v = (n as? Number)?.toDouble() ?: return@all false
                        v >= 0.0 && v <= 1.0 && kotlin.math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-9
                    }
                },
                "the value is the wire shape: normalized pairs rounded at capture; saw " +
                    points.take(3).joinToString(),
            )
            assertEquals(
                5.0, (stroke["width"] as? Number)?.toDouble(),
                "the authored strokeWidth rides the stroke; saw ${stroke["width"]}",
            )
        }
    }

    @Test
    fun aDeclaredOverlayIsReadableAndABareSurfaceIsDecorative() {
        DesktopHost.boot("Linux")
        val store = StackStore()
        store.setPath(
            "rows",
            listOf(
                mapOf("role" to "text", "label" to "Rent", "value" to "1200"),
                mapOf("role" to "text", "label" to "Food", "value" to "640"),
            ),
        )
        val root = parse(
            """
            <stack id="canvas-page" grow="true" background="#FFFFFF" padding="0">
              <canvas id="plot" height="120" a11yLabel="Spending" a11yChildren="dsx.variable.rows">
                <rect x="0" y="0" width="40" height="40" fill="#FF0000"/>
              </canvas>
              <canvas id="flourish" height="60">
                <rect x="0" y="0" width="40" height="40" fill="#00FF00"/>
              </canvas>
            </stack>
            """.trimIndent(),
        )

        runSkikoComposeUiTest(size = Size(320f, 400f), density = Density(1f), testTimeout = 20.seconds) {
            setContent { DesktopSurface(root, store) }
            flushDesktopEdt()

            val described = onNodeWithTag("plot").fetchSemanticsNode()
            val state = described.config.getOrNull(SemanticsProperties.StateDescription)
            assertEquals(
                "Rent: 1200, Food: 640", state,
                "the declared overlay is what makes a drawn chart readable; saw ${state ?: "nothing"}",
            )

            // A canvas with no label and no overlay is DECORATIVE, which is the correct default
            // and is enforced by clearing the node's semantics outright - so it is not reachable
            // by ANY matcher, its own test tag included. That unreachability IS the assertion.
            val decorative = onAllNodesWithTag("flourish").fetchSemanticsNodes()
            assertEquals(
                0, decorative.size,
                "an unlabelled canvas stays out of the accessibility tree entirely; found " +
                    "${decorative.size} semantics node(s) for it",
            )
        }
    }

    private val RED = 0xFFFF0000.toInt()
    private val GREEN = 0xFF00FF00.toInt()
    private val BLUE = 0xFF0000FF.toInt()

    private fun parse(markup: String): StackNode = requireNotNull(
        DesktopHost.parseDocument(DesktopHost.Document("canvas-ui-test.dsx", markup)),
    )

    private fun ComposeUiTest.sampledPixels(tag: String): List<Int> {
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

    /** the DesktopRendererUiTest seam, verbatim: drain AWT, advance one deterministic frame,
     * settle - production publishes store state through the AWT event thread */
    private fun ComposeUiTest.flushDesktopEdt() {
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        mainClock.advanceTimeByFrame()
        waitForIdle()
    }
}

private fun <T> androidx.compose.ui.semantics.SemanticsConfiguration.getOrNull(
    key: androidx.compose.ui.semantics.SemanticsPropertyKey<T>,
): T? = if (contains(key)) this[key] else null
