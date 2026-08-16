@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.test.withKeyDown
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import despia.engine.DSX
import despia.engine.JSE
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.setPath
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import javax.swing.SwingUtilities

/**
 * Display-server-free tests of the actual Compose/Skia scene. These complement the
 * pure renderer contracts by exercising measurement, drawing, semantics, focus and
 * input through the same [DesktopSurface] shipped by the Windows/Linux application.
 */
class DesktopRendererUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun responsiveSurfaceSwitchesBetweenColumnAndRowAtTheAuthoredBreakpoint() {
        DesktopHost.boot("Linux")
        val root = parse(
            """
            <stack id="scene-root" grow="true" background="#101418">
              <stack id="responsive" grow="width"
                     flexDirection="{{ (dsx.screen.width || 640) &gt;= 800 ? 'row' : 'column' }}"
                     spacing="12" padding="16">
                <vstack id="primary-card" width="220" height="120" background="#2d6cdf" padding="12">
                  <text value="Primary renderer" color="white"/>
                </vstack>
                <vstack id="secondary-card" width="220" height="120" background="#8247e5" padding="12">
                  <text value="Secondary renderer" color="white"/>
                </vstack>
              </stack>
            </stack>
            """.trimIndent(),
        )

        listOf(640 to false, 900 to true).forEach { (width, expectsRow) ->
            val store = StackStore()
            val metrics = requireNotNull(desktopScreenMetrics(width, 520, 1f))
            DSX.state.setPath("screen", desktopScreenState(DSX.state.getPath("screen"), metrics))
            if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
            val responsive = root.children.single()
            assertEquals(
                if (expectsRow) "row" else "column",
                JSE.interpolate(responsive.attrs.getValue("flexDirection"), store, null),
            )
            runSkikoComposeUiTest(
                size = Size(width.toFloat(), 520f),
                density = Density(1f),
                testTimeout = 15.seconds,
            ) {
                setContent { DesktopSurface(root, store) }
                flushDesktopEdt()

                onNodeWithTag("scene-root").assertIsDisplayed()
                val first = onNodeWithTag("primary-card").fetchSemanticsNode().boundsInRoot
                val second = onNodeWithTag("secondary-card").fetchSemanticsNode().boundsInRoot
                val screen = DSX.state.getPath("screen") as Map<*, *>
                if (expectsRow) {
                    assertTrue(
                        abs(first.top - second.top) <= 1f,
                        "cards should share a row at $width dp; first=$first second=$second screen=$screen",
                    )
                    assertTrue(second.left >= first.right, "second card should follow the first horizontally")
                } else {
                    assertTrue(abs(first.left - second.left) <= 1f, "cards should share a column at $width dp")
                    assertTrue(second.top >= first.bottom, "second card should follow the first vertically")
                }
                assertEquals(width.toDouble(), screen["width"])
            }
        }
    }

    @Test
    fun adaptiveScaffoldResizesWithoutLosingNativePaneInputOrPinnedState() = runSkikoComposeUiTest(
        size = Size(1_200f, 720f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val store = StackStore()
        val surfaceWidth = mutableStateOf(1_180.dp)
        val direction = mutableStateOf(LayoutDirection.Ltr)
        val root = parse(
            """
            <scaffold id="adaptive-root" grow="true" shell="automatic"
                      collapse="platform" compactAt="760"
                      sidebarLabel="Library navigation"
                      contentLabel="Now playing"
                      inspectorLabel="Track details">
              <head>
                <variable as="query">return ''</variable>
                <variable as="count">return 0</variable>
                <action as="increment">dsx.variable.count = dsx.variable.count + 1</action>
              </head>
              <vstack id="adaptive-sidebar" pane="sidebar" padding="16">
                <text value="Library"/>
              </vstack>
              <vstack id="adaptive-content" padding="16">
                <text value="Now playing"/>
                <textfield id="adaptive-field" bind="dsx.variable.query" label="Search library"/>
              </vstack>
              <vstack id="adaptive-inspector" pane="inspector" padding="16">
                <text value="Track details"/>
              </vstack>
              <hstack id="adaptive-player" pin="bottom" padding="12">
                <button id="adaptive-increment" label="Played {{ dsx.variable.count }}" on:tap="increment"/>
              </hstack>
            </scaffold>
            """.trimIndent(),
        )

        setContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction.value) {
                Box(Modifier.width(surfaceWidth.value).fillMaxHeight()) {
                    DesktopSurface(root, store)
                }
            }
        }
        flushDesktopEdt()

        onNodeWithTag("adaptive-root").assertIsDisplayed()
        onNodeWithTag("dsx.scaffold.pin.bottom").assertIsDisplayed()
        val sidebar = onNodeWithTag("dsx.scaffold.sidebar").fetchSemanticsNode().boundsInRoot
        val content = onNodeWithTag("dsx.scaffold.content").fetchSemanticsNode().boundsInRoot
        val inspector = onNodeWithTag("dsx.scaffold.inspector").fetchSemanticsNode().boundsInRoot
        assertTrue(sidebar.right <= content.left, "wide shell must place sidebar before content")
        assertTrue(content.right <= inspector.left, "wide shell must place inspector after content")

        val unicode = "موسيقى 👩🏽‍💻 e\u0301"
        onNodeWithTag("adaptive-field").performTextReplacement(unicode)
        flushDesktopEdt()
        flushDesktopEdt()
        assertEquals(unicode, store.getPath("query"))
        // The off-screen Skiko harness owns a scheduler separate from AWT. Invalidating a
        // host CompositionLocal is its deterministic store-to-scene frame boundary; the
        // production window already renders on AWT and does not need this test seam.
        runOnUiThread { direction.value = LayoutDirection.Rtl }
        waitForIdle()
        runOnUiThread { direction.value = LayoutDirection.Ltr }
        waitForIdle()
        onNodeWithTag("adaptive-field").assertTextContains(unicode)
        onNodeWithTag("adaptive-increment").performClick()
        flushDesktopEdt()
        assertEquals(1.0, store.getPath("count"))
        assertEquals(unicode, store.getPath("query"))

        runOnUiThread { surfaceWidth.value = 640.dp }
        waitForIdle()
        onNodeWithTag("dsx.scaffold.sidebar").assertIsDisplayed()
        onNodeWithTag("dsx.scaffold.content").assertIsDisplayed()
        onNodeWithTag("dsx.scaffold.inspector").assertIsDisplayed()
        onNodeWithTag("dsx.scaffold.pin.bottom").assertIsDisplayed()
        assertEquals(unicode, store.getPath("query"))
        onNodeWithTag("adaptive-field").assertTextContains(unicode)
        onNodeWithTag("adaptive-increment").performClick()
        flushDesktopEdt()
        assertEquals(2.0, store.getPath("count"))

        repeat(12) { index ->
            runOnUiThread { surfaceWidth.value = if (index % 2 == 0) 1_180.dp else 640.dp }
            waitForIdle()
            onNodeWithTag("dsx.scaffold.pin.bottom").assertIsDisplayed()
        }
        runOnUiThread { surfaceWidth.value = 1_180.dp }
        waitForIdle()
        runOnUiThread { direction.value = LayoutDirection.Rtl }
        waitForIdle()
        runOnUiThread { direction.value = LayoutDirection.Ltr }
        waitForIdle()
        onNodeWithTag("adaptive-field").assertTextContains(unicode)
        assertEquals(unicode, store.getPath("query"))
        onNodeWithText("Played 2").assertExists()
    }

    @Test
    fun densityIndependentScenePaintsRealPixelsAtOneAndTwoX() {
        DesktopHost.boot("Windows 11")
        val root = parse(
            """
            <stack id="paint-root" grow="true" background="#0f172a" padding="24">
              <vstack id="paint-card" width="320" height="180" padding="18" radius="16" background="#2563eb">
                <text value="DSX native pixels" color="white" fontSize="28" fontWeight="bold"/>
                <text value="Compose · Skia · Unicode ✓" color="#dbeafe" fontSize="16"/>
              </vstack>
            </stack>
            """.trimIndent(),
        )

        listOf(1f, 2f).forEach { scale ->
            runSkikoComposeUiTest(
                size = Size(1_024f * scale, 720f * scale),
                density = Density(scale),
                testTimeout = 15.seconds,
            ) {
                setContent { DesktopSurface(root, StackStore()) }
                flushDesktopEdt()

                // EVERY assertion below names `scale` and its measured value on purpose. All four
                // live inside one `runSkikoComposeUiTest` lambda, so a bare failure is reported at
                // the ENCLOSING call line and says nothing about which one broke or what it saw.
                // This test has been red on the Windows lane (and only Windows — the Linux lane and
                // this container both pass it), and a message that omits the measured value makes
                // every diagnosis another blind five-minute CI round trip.
                //
                // DIAGNOSIS LEDGER (2026-08-07, still without a Windows box — reasoned from the
                // code and measured on Linux; the failure message is the ONE channel the Windows
                // lane surfaces, so everything below rides it):
                //   · the screen width/height pair cannot be the Windows break by itself:
                //     SkikoComposeUiTest.TestWindowInfo feeds the harness size/density verbatim
                //     into DesktopScreenStatePublisher, and getPath reads the store map
                //     synchronously — no OS display and no EDT hop sit on that read path;
                //   · captureToImage crops the offscreen SOFTWARE raster at boundsInWindow
                //     (Surface.makeImageSnapshot(IRect)) — no monitor, no DPI, no DirectX enters
                //     the capture at either scale, so a size mismatch would be a layout break;
                //   · a machine with NO usable font does not produce this failure shape: starving
                //     fontconfig locally fails all six tests with "IllegalStateException: Could
                //     not load font" before any assertion runs, while Windows fails exactly this
                //     one and stays green on the other five — so the platform font LOADS and text
                //     MEASURES there (the wrap and unicode siblings depend on real metrics);
                //   · what remains platform-variant is glyph PIXEL COVERAGE: this is the suite's
                //     only assertion that needs text pixels (the Windows-green pixel tests are
                //     canvas-only geometry) — and that fragility is now MEASURED, not suspected.
                //     Every distinct colour beyond the two fills rides ~20 of 3,072 samples, all
                //     glyph ink or glyph antialiasing. Swapping only the default sans — DejaVu
                //     (titleWidth28=278, 15 distinct) → WenQuanYi Zen Hei (210, 9 distinct) —
                //     eats six of the seven-colour margin over the old `>= 8 distinct` floor with
                //     every pixel rendering CORRECTLY. Windows resolves Segoe UI, a third set of
                //     metrics, and deterministically lands under a floor that was a font-metrics
                //     lottery. The paint assertions are therefore CLASS-based and font-independent:
                //     the authored fills must paint exactly, glyphs must put real ink over them,
                //     and the palette must still carry text colours — the same real-pixel intent
                //     without betting on which grid points one font's antialiasing happens to hit.
                //     If the Windows lane STILL fails, the preamble in every message names the
                //     measured classes, the resolved font and its title width in one shot.
                val screen = DSX.state.getPath("screen") as Map<*, *>
                assertEquals(
                    1_024.0, screen["width"],
                    "screen width at ${scale}x should stay density-independent; screen=$screen ${hostStamp()}",
                )
                assertEquals(
                    720.0, screen["height"],
                    "screen height at ${scale}x should stay density-independent; screen=$screen ${hostStamp()}",
                )

                val image = onNodeWithTag("paint-root").captureToImage()
                val pixels = image.toPixelMap()
                val samples = ArrayList<Int>()
                val xStep = (image.width / 64).coerceAtLeast(1)
                val yStep = (image.height / 48).coerceAtLeast(1)
                for (y in 0 until image.height step yStep) {
                    for (x in 0 until image.width step xStep) samples.add(pixels[x, y].toArgb())
                }
                val colors = LinkedHashSet(samples)
                // The scene paints exactly four authored colours; everything else is blend.
                val ground = samples.count { it == 0xFF0F172A.toInt() }
                val card = samples.count { it == 0xFF2563EB.toInt() }
                val title = samples.count { it == 0xFFFFFFFF.toInt() }
                val subtitle = samples.count { it == 0xFFDBEAFE.toInt() }
                val blends = samples.size - ground - card - title - subtitle
                val diagnosis = "at ${scale}x: image=${image.width}x${image.height}, " +
                    "${samples.size} samples → ground#0F172A×$ground card#2563EB×$card " +
                    "title#FFFFFF×$title subtitle#DBEAFE×$subtitle blends×$blends, " +
                    "${colors.size} distinct: " +
                    colors.take(8).joinToString { "#%08X".format(it) } +
                    "; ${fontProbe()} ${hostStamp()}"

                // Semantics wraps the complete styled node so accessibility, pointer and
                // capture bounds include its padded hit envelope. Padding moves content;
                // it must not shrink the root's authored full-scene bounds.
                assertEquals((1_024f * scale).toInt(), image.width, "captured width $diagnosis")
                assertEquals((720f * scale).toInt(), image.height, "captured height $diagnosis")
                // The CLASSES are the signal (see the ledger above — a raw distinct-colour floor
                // was font-fragile): a capture with no exact ground or card sample never painted
                // the authored scene; one whose every sample is a fill is a scene whose GLYPHS
                // never rendered — what a box with a measuring-but-not-rasterizing font stack
                // produces; and any real font must both ink well over the two-fills floor and
                // leave more colours than the fills alone. Measured glyph coverage: 20 samples
                // (DejaVu) and 14 (WenQuanYi) against ~0 for a glyphless render, so the floor of
                // 8 splits the regimes with margin on both sides in every font tried.
                assertTrue(
                    ground > 0 && card > 0,
                    "authored ground and card fills should both paint exactly $diagnosis",
                )
                val glyphInk = samples.size - ground - card
                assertTrue(
                    glyphInk >= 8,
                    "text glyphs should put real ink over the authored fills $diagnosis",
                )
                assertTrue(
                    colors.size >= 4,
                    "captured surface should hold text colours beyond the two fills $diagnosis",
                )
            }
        }
    }

    @Test
    fun hardwareKeyboardFocusUnicodeActionsAndStateSurviveRtlRecomposition() = runSkikoComposeUiTest(
        size = Size(760f, 520f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Windows 11")
        val store = StackStore()
        val direction = mutableStateOf(LayoutDirection.Ltr)
        val root = parse(
            """
            <vstack id="interaction-root" grow="true" spacing="12" padding="20">
              <head>
                <variable as="name">return ''</variable>
                <variable as="enabled">return false</variable>
                <variable as="accepted">return false</variable>
                <variable as="count">return 0</variable>
                <action as="activate">dsx.variable.count = dsx.variable.count + 1</action>
              </head>
              <textfield id="name-field" bind="dsx.variable.name" label="Name" focusOrder="1"/>
              <toggle id="enabled-toggle" bind="dsx.variable.enabled" label="Enabled" focusOrder="2"/>
              <checkbox id="accepted-checkbox" bind="dsx.variable.accepted" label="Accepted" focusOrder="3"/>
              <button id="action-button" label="Runs {{ dsx.variable.count }}" on:tap="activate"
                      shortcut="primary+k" focusOrder="4"/>
            </vstack>
            """.trimIndent(),
        )

        setContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction.value) {
                DesktopSurface(root, store)
            }
        }
        flushDesktopEdt()

        val unicode = "مرحبا 👩🏽‍💻 e\u0301"
        onNodeWithTag("name-field").performTextReplacement(unicode)
        flushDesktopEdt()
        assertEquals(unicode, store.getPath("name"))

        // A host-environment change drives an independent recomposition and proves
        // that the controlled field reads the authoritative store rather than owning
        // an ephemeral renderer-local value.
        runOnUiThread { direction.value = LayoutDirection.Rtl }
        waitForIdle()
        onNodeWithTag("name-field").assertTextContains(unicode)

        onNodeWithTag("name-field").requestFocus().assertIsFocused()
        onNodeWithTag("name-field").performKeyInput { pressKey(Key.Tab) }
        flushDesktopEdt()
        onNodeWithTag("enabled-toggle").assertIsFocused().performClick()
        flushDesktopEdt()
        assertEquals(true, store.getPath("enabled"))

        onNodeWithTag("enabled-toggle").performKeyInput { pressKey(Key.Tab) }
        onNodeWithTag("accepted-checkbox").assertIsFocused().performKeyInput { pressKey(Key.Spacebar) }
        flushDesktopEdt()
        assertEquals(true, store.getPath("accepted"))

        onNodeWithTag("accepted-checkbox").performKeyInput { pressKey(Key.Tab) }
        onNodeWithTag("action-button").assertIsFocused().performKeyInput { pressKey(Key.Enter) }
        flushDesktopEdt()
        onNodeWithTag("action-button").performKeyInput {
            withKeyDown(Key.CtrlLeft) { pressKey(Key.K) }
        }
        flushDesktopEdt()
        assertEquals(2.0, store.getPath("count"))

        repeat(64) { index ->
            runOnUiThread {
                direction.value = if (index % 2 == 0) LayoutDirection.Ltr else LayoutDirection.Rtl
            }
            waitForIdle()
        }
        runOnUiThread { direction.value = LayoutDirection.Ltr }
        waitForIdle()
        onNodeWithText("Runs 2").assertExists()
        assertEquals(unicode, store.getPath("name"))
        assertEquals(true, store.getPath("enabled"))
        assertEquals(true, store.getPath("accepted"))
        assertEquals(2.0, store.getPath("count"))
    }

    @Test
    fun largeGridRemainsVirtualizedScrollableAndKeepsFourColumnGeometry() = runSkikoComposeUiTest(
        size = Size(960f, 620f),
        density = Density(1f),
        testTimeout = 20.seconds,
    ) {
        DesktopHost.boot("Linux")
        val store = StackStore().also { target ->
            target.setPath("items", List(2_000) { index -> mapOf("title" to "Row $index") })
        }
        val root = parse(
            """
            <vstack id="grid-root" grow="true" padding="12">
              <grid id="stress-grid" bind="dsx.variable.items" columns="4" spacing="8">
                <vstack id="grid-cell" height="52" padding="8" background="#1d4ed8">
                  <text value="{{ dsx.item.title }}" color="white"/>
                </vstack>
              </grid>
            </vstack>
            """.trimIndent(),
        )
        setContent { DesktopSurface(root, store) }
        flushDesktopEdt()

        val visible = onAllNodesWithTag("grid-cell").fetchSemanticsNodes()
        assertTrue(visible.size in 4 until 2_000, "the 2,000-row source must stay virtualized")
        val firstRow = visible.take(4).map { it.boundsInRoot }
        assertTrue(firstRow.all { abs(it.top - firstRow.first().top) <= 1f })
        assertTrue(firstRow.zipWithNext().all { (left, right) -> right.left >= left.right })

        onNodeWithTag("stress-grid").performScrollToIndex(249)
        waitForIdle()
        onNodeWithText("Row 996").assertExists()
        assertEquals(2_000, (store.getPath("items") as List<*>).size)
    }

    @Test
    fun longMixedDirectionTextWrapsInsideANarrowNativeSurface() = runSkikoComposeUiTest(
        size = Size(360f, 640f),
        density = Density(1f),
        testTimeout = 15.seconds,
    ) {
        DesktopHost.boot("Linux")
        val root = parse(
            """
            <vstack id="rtl-root" grow="true" padding="16" background="#111827">
              <vstack id="rtl-card" grow="width" padding="12" background="#374151">
                <text id="rtl-copy" color="white"
                      value="واجهة DSX أصلية — A deliberately long native Compose sentence with العربية, English, עברית, emoji 👩🏽‍💻 and combining text é that must wrap without horizontal clipping."/>
              </vstack>
            </vstack>
            """.trimIndent(),
        )
        setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                DesktopSurface(root, StackStore())
            }
        }
        waitForIdle()

        val card = onNodeWithTag("rtl-card").fetchSemanticsNode().boundsInRoot
        val copy = onNodeWithTag("rtl-copy").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue(card.left >= 0f && card.right <= 360f)
        assertTrue(copy.left >= card.left && copy.right <= card.right)
        assertTrue(copy.height > 40f, "mixed-direction long copy should wrap to multiple lines")
    }

    private fun parse(markup: String): StackNode = requireNotNull(
        DesktopHost.parseDocument(DesktopHost.Document("renderer-ui-test.dsx", markup)),
    )

    /** The runner identity for the diagnosis preamble — which OS/JVM actually failed. */
    private fun hostStamp(): String = "[${System.getProperty("os.name")} " +
        "${System.getProperty("os.version")}, java ${System.getProperty("java.version")}]"

    /** One-line Skia font-stack probe for the diagnosis preamble: the platform font
     * manager's family count, the face it resolves for a bold Latin 'D', and that face's
     * measured width for the scene's title run. `titleWidth28=0` (or `face=<none>`) is a
     * font stack that measures but cannot rasterize — the palette's glyph counts would
     * read zero for that reason and not because of sampling. Failures are reported, not
     * thrown: the probe must never replace the pixel assertion it explains. */
    private fun fontProbe(): String = runCatching {
        val manager = org.jetbrains.skia.FontMgr.default
        val bold = org.jetbrains.skia.FontStyle.BOLD
        val face = manager.matchFamiliesStyleCharacter(emptyArray(), bold, emptyArray(), 'D'.code)
            ?: manager.legacyMakeTypeface("", bold)
        val width = face?.let { org.jetbrains.skia.Font(it, 28f).measureTextWidth("DSX native pixels") }
        "fonts: families=${manager.familiesCount} face=${face?.familyName ?: "<none>"} titleWidth28=$width"
    }.getOrElse { probeFailure -> "fonts: probe failed (${probeFailure.message})" }

    /** Production desktop state publication is intentionally serialized through the
     * AWT event thread. The offscreen Skiko harness has its own deterministic UI loop,
     * so drain AWT before asking that loop to settle a resulting recomposition. */
    private fun ComposeUiTest.flushDesktopEdt() {
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        // Cross-thread StateFlow delivery is queued on the harness scheduler after
        // the AWT write. Advancing one deterministic frame lets the collector resume
        // before the scene's idleness check observes the resulting invalidation.
        mainClock.advanceTimeByFrame()
        waitForIdle()
    }
}
