@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

//
//  DesktopStudioProbeUiTest.kt — the studio-element PAINT matrix inside sheet
//  presentation, distilled from the W18 Audio Studio render-oracle investigation.
//
//  Four placements of the SAME canvas components, one truth each: a studio canvas
//  must actually paint (a) in the base column, (b) in the base column under
//  `grow="true"`, (c) inside a presented sheet with an authored height, and
//  (d) Waveform inside the same sheet. Placement (e) — grow with no height inside
//  the sheet's content cell — is the PINNED OPEN DEFECT: the component composes
//  (semantics report its notes) but its draw never lands, leaving a blank hole
//  where iOS shows the pitch grid. It is asserted at its CURRENT broken truth so
//  the fix flips this test loudly; flip the assertion to `>= 4` when it lands.
//

package despia.engine.desktop

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import despia.engine.Platform
import despia.engine.StackStore
import despia.engine.setPath
import javax.swing.SwingUtilities
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class DesktopStudioProbeUiTest {
    @BeforeEach
    fun boot() {
        DesktopUiTestEnvironment.assumeRenderable()
        DesktopHost.boot("Linux")
    }

    @AfterEach
    fun restore() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    private fun androidx.compose.ui.test.ComposeUiTest.diversity(tag: String): Int {
        val image = onNodeWithTag(tag).captureToImage()
        val pixels = image.toPixelMap()
        val colors = linkedSetOf<Int>()
        for (y in 0 until image.height step (image.height / 40).coerceAtLeast(1)) {
            for (x in 0 until image.width step (image.width / 40).coerceAtLeast(1)) {
                colors += pixels[x, y].toArgb()
            }
        }
        return colors.size
    }

    @Test
    fun studioCanvasesPaintAcrossSheetPlacements() = runSkikoComposeUiTest(
        size = Size(780f, 1400f),
        density = Density(2f),
        testTimeout = 30.seconds,
    ) {
        val store = StackStore().also {
            it.setPath("open", true)
            it.setPath(
                "notes",
                listOf(
                    mapOf("id" to 1, "start" to 0.0, "duration" to 0.8, "detectedMidi" to 60.0, "targetMidi" to 62.0),
                    mapOf("id" to 2, "start" to 1.0, "duration" to 0.6, "detectedMidi" to 64.0, "targetMidi" to 64.0),
                ),
            )
        }
        val root = requireNotNull(
            DesktopHost.parseDocument(
                DesktopHost.Document(
                    "probe.dsx",
                    """
                    <stack grow="true">
                      <StudioPitchEditor id="base-pitch" notes="dsx.variable.notes"
                          musicKey="C" musicScale="major" snapToKey="true" height="260"/>
                      <StudioPitchEditor id="base-grow" grow="true" notes="dsx.variable.notes"
                          musicKey="C" musicScale="major" snapToKey="true"/>
                      <sheet present="dsx.variable.open" mode="sheet" detents="full">
                        <stack grow="true" style="display: grid">
                          <StudioPitchEditor id="sheet-grow" grow="true" notes="dsx.variable.notes"
                              musicKey="C" musicScale="major" snapToKey="true"/>
                          <Waveform id="sheet-wave" peaks="0.2,0.9,0.4,1.0,0.6,0.8" selected="true" height="56"/>
                          <StudioPitchEditor id="sheet-sized" notes="dsx.variable.notes"
                              musicKey="C" musicScale="major" snapToKey="true" height="260"/>
                        </stack>
                      </sheet>
                    </stack>
                    """.trimIndent(),
                ),
            ),
        )
        setContent { DesktopSurface(root, store) }
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        mainClock.advanceTimeByFrame()
        waitForIdle()
        mainClock.advanceTimeByFrame()
        waitForIdle()

        assertTrue(diversity("base-pitch") >= 4, "base pitch editor did not paint")
        assertTrue(diversity("base-grow") >= 4, "grown base pitch editor did not paint")
        assertTrue(diversity("sheet-sized") >= 4, "sized pitch editor inside the sheet did not paint")
        assertTrue(diversity("sheet-wave") >= 4, "waveform inside the sheet did not paint")
        // PINNED OPEN DEFECT (see header): composes with live semantics, draws nothing.
        val sheetGrow = diversity("sheet-grow")
        val semantics = onNodeWithTag("sheet-grow").fetchSemanticsNode().config.toString()
        assertTrue(semantics.contains("pitch notes"), "sheet-grow pitch editor lost its semantics: $semantics")
        assertTrue(
            sheetGrow <= 3,
            "sheet-grow pitch editor started painting ($sheetGrow colors) — the pinned defect is " +
                "fixed: flip this assertion to >= 4 and update the header note",
        )
    }
}
