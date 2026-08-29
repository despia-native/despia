@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.SurfaceMaterials
import despia.engine.getPath
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.awt.EventQueue
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

class DesktopUniversalStyleUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun componentAttributeObserversReceiveImmediateDefaultsAndLiveConsumerChanges() = runSkikoComposeUiTest(
        size = Size(720f, 480f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val store = StackStore()
        val direction = mutableStateOf(LayoutDirection.Ltr)
        val root = parse(
            """
            <vstack id="attribute-root" padding="20">
              <head>
                <variable as="input">return 'first'</variable>
                <variable as="seen">return ''</variable>
                <component as="AttributeProbe">
                  <vstack>
                    <attribute as="value" default="'fallback'" immediate="true"
                               on:change="dsx.event('seen', { value: dsx.this.value })"/>
                    <text id="attribute-value" value="{{ dsx.attribute.value }}"/>
                  </vstack>
                </component>
              </head>
              <AttributeProbe value="{{ dsx.variable.input }}" on:seen="dsx.variable.seen = value"/>
              <button id="attribute-change" label="Change"
                      on:tap="dsx.variable.input = 'second'"/>
            </vstack>
            """.trimIndent(),
        )
        setContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction.value) {
                DesktopSurface(root, store)
            }
        }
        flushDesktopQueue()
        flushDesktopQueue()

        onNodeWithText("first").assertIsDisplayed()
        assertEquals("first", store.getPath("seen"))
        onNodeWithTag("attribute-change").performClick()
        flushDesktopQueue()
        flushDesktopQueue()
        assertEquals("second", store.getPath("input"))
        // Skiko's headless test scheduler does not observe the AWT-owned store
        // dispatcher as a production desktop window does. Cross its deterministic
        // scene-frame seam after proving the authoritative store mutation landed.
        runOnUiThread { direction.value = LayoutDirection.Rtl }
        waitForIdle()
        runOnUiThread { direction.value = LayoutDirection.Ltr }
        waitForIdle()
        onNodeWithText("second").assertIsDisplayed()
        assertEquals("second", store.getPath("seen"))
    }

    @Test
    fun imperativeNodePatchChangesAndRestoresRealComposeGeometry() = runSkikoComposeUiTest(
        size = Size(640f, 420f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val store = StackStore()
        val root = parse(
            """
            <vstack id="patch-root" padding="20">
              <vstack id="patch-target" width="40" width:linux="64" height="32" background="#ef4444"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopQueue()

        val before = onNodeWithTag("patch-target").fetchSemanticsNode().boundsInRoot
        assertTrue(abs(before.width - 64f) <= 1f)
        store.desktopNode("#patch-target").set("width", "128").set("background", "#22c55e", animated = true)
        flushDesktopQueue()
        val patched = onNodeWithTag("patch-target").fetchSemanticsNode().boundsInRoot
        assertTrue(abs(patched.width - 128f) <= 1f, "live id patch must change actual layout: $patched")

        store.desktopNode("patch-target").clear("width").clear("background")
        flushDesktopQueue()
        val restored = onNodeWithTag("patch-target").fetchSemanticsNode().boundsInRoot
        assertTrue(abs(restored.width - 64f) <= 1f)
    }

    @Test
    fun universalTapPayloadAndLongPressWorkOnOrdinaryAndNativeControls() = runSkikoComposeUiTest(
        size = Size(720f, 480f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val store = StackStore()
        val root = parse(
            """
            <vstack id="gesture-root" padding="20" spacing="12">
              <head>
                <variable as="tapValue">return ''</variable>
                <variable as="ordinaryLong">return 0</variable>
                <variable as="buttonLong">return 0</variable>
                <variable as="buttonTap">return 0</variable>
              </head>
              <vstack id="ordinary-tap" width="160" height="48" background="#334155"
                      arg:value="42" arg:enabled="true"
                      on:tap="dsx.variable.tapValue = dsx.this.value"
                      on:longpress="dsx.variable.ordinaryLong = dsx.variable.ordinaryLong + 1"/>
              <button id="native-long" label="Native long press"
                      on:tap="dsx.variable.buttonTap = dsx.variable.buttonTap + 1"
                      on:longpress="dsx.variable.buttonLong = dsx.variable.buttonLong + 1"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopQueue()

        onNodeWithTag("ordinary-tap").assertHasClickAction().performClick()
        flushDesktopQueue()
        assertEquals(42.0, store.getPath("tapValue"))

        onNodeWithTag("ordinary-tap").performTouchInput { longClick() }
        flushDesktopQueue()
        assertEquals(1.0, store.getPath("ordinaryLong"))

        onNodeWithTag("native-long").performTouchInput { longClick() }
        flushDesktopQueue()
        assertEquals(1.0, store.getPath("buttonLong"))
        assertEquals(0.0, store.getPath("buttonTap"), "a recognized long press must suppress release-click")
    }

    @Test
    fun transitionedVisibilityRemountsWithBalancedLifecycleWhileKeepStaysMounted() = runSkikoComposeUiTest(
        size = Size(720f, 480f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val store = StackStore()
        val direction = mutableStateOf(LayoutDirection.Ltr)
        val root = parse(
            """
            <vstack id="visibility-root" padding="20" spacing="10">
              <head>
                <variable as="shown">return true</variable>
                <variable as="appeared">return 0</variable>
                <variable as="disappeared">return 0</variable>
                <variable as="keptShown">return true</variable>
                <variable as="keptAppeared">return 0</variable>
                <variable as="keptDisappeared">return 0</variable>
              </head>
              <vstack id="transient" width="100" height="30" background="#2563eb"
                      visible-if="dsx.variable.shown" transition="fade" animDuration="0.05"
                      on:appear="dsx.variable.appeared = dsx.variable.appeared + 1"
                      on:disappear="dsx.variable.disappeared = dsx.variable.disappeared + 1"/>
              <vstack id="kept" width="100" height="30" background="#16a34a" keep="true"
                      visible-if="dsx.variable.keptShown"
                      on:appear="dsx.variable.keptAppeared = dsx.variable.keptAppeared + 1"
                      on:disappear="dsx.variable.keptDisappeared = dsx.variable.keptDisappeared + 1"/>
              <button id="hide-transient" label="Hide" on:tap="dsx.variable.shown = false"/>
              <button id="show-transient" label="Show" on:tap="dsx.variable.shown = true"/>
              <button id="hide-kept" label="Hide kept" on:tap="dsx.variable.keptShown = false"/>
            </vstack>
            """.trimIndent(),
        )
        setContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction.value) {
                DesktopSurface(root, store)
            }
        }
        flushDesktopQueue()
        waitUntil("initial lifecycle actions", 5_000L) {
            store.getPath("appeared") == 1.0 && store.getPath("keptAppeared") == 1.0
        }

        onNodeWithTag("hide-transient").performClick()
        flushDesktopQueue()
        assertEquals(false, store.getPath("shown"))
        runOnUiThread { direction.value = LayoutDirection.Rtl }
        waitForIdle()
        waitUntil("transitioned node unmount", 5_000L) {
            store.getPath("disappeared") == 1.0 && onAllNodesWithTag("transient").fetchSemanticsNodes().isEmpty()
        }

        onNodeWithTag("show-transient").performClick()
        flushDesktopQueue()
        assertEquals(true, store.getPath("shown"))
        runOnUiThread { direction.value = LayoutDirection.Ltr }
        waitForIdle()
        waitUntil("transitioned node remount", 5_000L) {
            store.getPath("appeared") == 2.0 && onAllNodesWithTag("transient").fetchSemanticsNodes().size == 1
        }

        onNodeWithTag("hide-kept").performClick()
        flushDesktopQueue()
        assertEquals(false, store.getPath("keptShown"))
        runOnUiThread { direction.value = LayoutDirection.Rtl }
        waitForIdle()
        assertEquals(1, onAllNodesWithTag("kept", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(1.0, store.getPath("keptAppeared"))
        assertEquals(0.0, store.getPath("keptDisappeared"))
    }

    @Test
    // 800 sits ABOVE the compact step (THE WIDTH LAW, LayoutSemantics.COMPACT_BELOW):
    // this specimen pins the HUG-side padding/geometry math, and below 768 the skin's
    // own law stretches nested vertical stacks (corpus-pinned in fixture 08 and
    // flex-semantics.json), which would rewrite every width asserted here.
    fun legacyPresetInlineCssAndEffectsRenderThroughTheNativeStyleOnion() = runSkikoComposeUiTest(
        size = Size(800f, 720f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val root = parse(
            """
            <vstack id="style-root" padding="20" spacing="12" theme="dark">
              <vstack id="preset-card" style="card">
                <vstack width="20" height="16"/>
              </vstack>
              <vstack id="padding-cascade" padding="16" paddingTop="4">
                <vstack width="20" height="16"/>
              </vstack>
              <vstack id="css-card"
                      style="width: 80px; height: 40px; background-color: #2563eb; border-radius: 8px"/>
              <hstack id="css-gap" style="column-gap: 20px; align-items: center">
                <vstack width="20" height="12"/>
                <vstack width="20" height="28"/>
              </hstack>
              <vstack id="effect-card" width="120" height="60" radius="12"
                      gradient="#2563eb|#7c3aed" gradientDir="diagonal"
                      surface="thin" glassTint="rgba(255,255,255,0.10)"
                      borderColor="#ffffff" borderWidth="2" shadow="8"
                      shadowColor="rgba(0,0,0,0.4)" shadowX="4" shadowY="6"
                      aspectRatio="2:1" opacity="0.9" rotation="1" scale="0.98"
                      blur="0" offsetX="3" offsetY="2" zIndex="2"/>
              <button id="bordered-button" variant="bordered" label="Bordered"/>
              <button id="prominent-button" variant="prominent" label="Prominent"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, StackStore()) }
        flushDesktopQueue()

        val preset = onNodeWithTag("preset-card").fetchSemanticsNode().boundsInRoot
        assertTrue(preset.width >= 52f && preset.height >= 48f, "built-in card must contribute 16 dp padding: $preset")
        val padding = onNodeWithTag("padding-cascade").fetchSemanticsNode().boundsInRoot
        assertTrue(
            abs(padding.width - 52f) <= 1f && abs(padding.height - 36f) <= 1f,
            "edge padding must replace, not add to, the shorthand: $padding",
        )
        val css = onNodeWithTag("css-card").fetchSemanticsNode().boundsInRoot
        assertTrue(abs(css.width - 80f) <= 1f && abs(css.height - 40f) <= 1f, "inline DSX-CSS geometry: $css")
        val gap = onNodeWithTag("css-gap").fetchSemanticsNode().boundsInRoot
        assertTrue(abs(gap.width - 60f) <= 1f && abs(gap.height - 28f) <= 1f, "axis-correct DSX-CSS gap: $gap")
        onNodeWithTag("effect-card").assertIsDisplayed()
        onNodeWithTag("bordered-button").assertIsDisplayed()
        onNodeWithTag("prominent-button").assertIsDisplayed()
    }

    /**
     * `glassInteractive` - the press response, measured by pressing.
     *
     * This attribute sat in the parity register on three renderers at once, and on this lane it
     * sat in `desktopStyleDeterministicDegradations` too: the lane paints a translucent fill
     * rather than a material, so there was nothing for an "interactive material" to modulate.
     * The observable half of the iOS 26 response is geometry, and Compose hosts that natively.
     *
     * Asserted under a REAL held pointer rather than by looking for the modifier, for the same
     * reason the web twin grew a press mode in its style oracle: a marker proves somebody typed
     * the name. What has to be true is that the surface moves, that it moves by the shared
     * amount, and that a glass surface which did not ask for it stays exactly where it was.
     *
     * MEASURED ON A NESTED MARK, not on the surface node itself: a semantics node's boundsInRoot
     * does not carry its OWN graphicsLayer transform, so the surface reads 160 wide whether it is
     * pressed or not. Its child reads the transform of everything above it, which is also the
     * thing an author actually sees move.
     */
    @Test
    fun aGlassSurfaceThatAsksForThePressMovesUnderOneAndTheRestStayPut() = runSkikoComposeUiTest(
        size = Size(400f, 400f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val root = parse(
            """
            <vstack id="glass-root" padding="20" spacing="20" theme="dark">
              <vstack id="static-glass" width="160" height="60" surface="glass">
                <vstack id="static-mark" width="80" height="20"/>
              </vstack>
              <vstack id="press-glass" width="160" height="60" surface="glass" glassInteractive="true">
                <vstack id="press-mark" width="80" height="20"/>
              </vstack>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, StackStore()) }
        flushDesktopQueue()

        val restingStatic = onNodeWithTag("static-mark").fetchSemanticsNode().boundsInRoot
        val restingPress = onNodeWithTag("press-mark").fetchSemanticsNode().boundsInRoot
        assertTrue(
            abs(restingPress.width - restingStatic.width) <= 0.5f,
            "at rest the two glass surfaces are the same size: $restingPress vs $restingStatic",
        )

        onNodeWithTag("press-glass").performTouchInput { down(center) }
        // The press lands on a 120 ms tween; read it settled rather than mid-flight, since a
        // mid-flight value differs from the resting one and would pass for the wrong reason.
        mainClock.advanceTimeBy(400)
        flushDesktopQueue()

        val pressed = onNodeWithTag("press-mark").fetchSemanticsNode().boundsInRoot
        val untouched = onNodeWithTag("static-mark").fetchSemanticsNode().boundsInRoot
        assertEquals(
            (restingPress.width * SurfaceMaterials.PRESS_SCALE).toDouble(),
            pressed.width.toDouble(),
            1.0,
            "the pressed surface scales by the shared factor",
        )
        assertTrue(
            abs(untouched.width - restingStatic.width) <= 0.5f,
            "a glass surface that did not opt in must not move when its neighbour is pressed: " +
                "$untouched vs $restingStatic",
        )

        onNodeWithTag("press-glass").performTouchInput { up() }
        mainClock.advanceTimeBy(2_000)
        flushDesktopQueue()
        assertEquals(
            restingPress.width.toDouble(),
            onNodeWithTag("press-mark").fetchSemanticsNode().boundsInRoot.width.toDouble(),
            1.0,
            "the release springs back to where it started",
        )
    }

    /**
     * The mesh paints its LAYERS, not its base. layers() returns [base, radial..radialN]
     * back-to-front and wrap() prepends, so the call site must reverse the list exactly as the
     * :render twin does - without the reversal the opaque base painted OVER the radials and a
     * mesh rendered as one flat solid. The count assertions in DesktopUniversalStyleTest cannot
     * see that, which is how the defect passed; PIXELS can: a flat fill has one color, a mesh
     * with four distinct corner colors has many.
     */
    @Test
    fun aMeshGradientPaintsItsRadialLayersAboveTheBaseFill() = runSkikoComposeUiTest(
        size = Size(300f, 300f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val root = parse(
            """
            <vstack id="mesh-root" padding="10">
              <vstack id="mesh-card" width="200" height="200"
                      gradient="#ff0000|#00ff00" gradientType="mesh"
                      gradientPoints="0 0 #ff0000, 1 0 #00ff00; 0 1 #0000ff, 1 1 #ffff00"/>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, StackStore()) }
        flushDesktopQueue()

        val image = onNodeWithTag("mesh-card").captureToImage()
        val pixels = image.toPixelMap()
        val colors = linkedSetOf<Int>()
        for (y in 0 until image.height step (image.height / 20).coerceAtLeast(1)) {
            for (x in 0 until image.width step (image.width / 20).coerceAtLeast(1)) {
                colors += pixels[x, y].toArgb()
            }
        }
        assertTrue(
            colors.size > 8,
            "a four-color mesh sampled across its face must vary; ${colors.size} distinct " +
                "color(s) means the base fill painted over the radial layers again",
        )
    }

    private fun parse(markup: String): StackNode = requireNotNull(
        DesktopHost.parseDocument(DesktopHost.Document("desktop-universal-style-test.dsx", markup)),
    )

    private fun androidx.compose.ui.test.ComposeUiTest.flushDesktopQueue() {
        if (!EventQueue.isDispatchThread()) EventQueue.invokeAndWait { }
        waitForIdle()
    }
}
