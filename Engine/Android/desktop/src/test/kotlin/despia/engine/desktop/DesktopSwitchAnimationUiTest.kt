@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.StackStore
import despia.engine.getPath
import despia.engine.varsFlow
import despia.engine.writeBound
import kotlinx.coroutines.runBlocking
import kotlin.math.abs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import javax.swing.SwingUtilities

/**
 * The switch MOTION oracle (owner report 2026-08-20: "the Android switch does not
 * animate"; the library-grade ruling's animated-system-control rule). No emulator runs on
 * this box, so the closest runnable twin carries the proof: the REAL Material 3 `Switch`
 * (test-only compose.material3 — the same component generation the Android :render system
 * path mounts) driven through the REAL DSX store round-trip (writeBound →
 * StackStorePublisher → varsFlow → collectAsState → recomposition, the M3ToggleView /
 * FieldToggleRow wiring transplanted verbatim) under a hand-stepped clock, with the thumb
 * position measured from pixels.
 *
 * THE MECHANISM these three tests pin (material3 SwitchImpl, 1.4.0 generation):
 * `offsetAnim.animateTo(target, if (isPressed) SnapSpec else motionSpec)` — a
 * checked-change measure that lands while the press interaction is STILL active takes
 * SnapSpec and the thumb JUMPS. A physical tap can order exactly that way (the
 * PressInteraction.Release collector races the write→publish→recompose hop), which is the
 * dead switch on device. :render's `SystemSwitch` (StackSystemControls.kt) therefore hands
 * the component its new `checked` one frame late; `mirroredWiringGlidesUnderThePressRace`
 * is that contract's oracle, and `pressHeldFlipSnapsOnTheRawComponent` keeps the DISEASE
 * visible — when a future material3 drops the pressed-snap fork, that test goes red and
 * the mirror can retire.
 *
 * The DesktopRendererUiTest lesson applies: every assertion names its measured value.
 */
class DesktopSwitchAnimationUiTest {
    @BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    /** The M3ToggleView/FieldToggleRow wiring: checked reads the store, the change writes it.
     *  `mirrored` adds the one-frame checked mirror — the :render SystemSwitch contract. */
    @Composable
    private fun StoreDrivenM3Switch(
        store: StackStore,
        interactionSource: MutableInteractionSource? = null,
        mirrored: Boolean = false,
    ) {
        store.varsFlow.collectAsState().value                     // the surface-root subscription
        val on = JSE.truthy(store.getPath("on"))
        var shown by remember { mutableStateOf(on) }
        LaunchedEffect(on) { shown = on }
        MaterialTheme {
            Box(Modifier.fillMaxSize().background(Color(0xFF202020)).padding(20.dp)) {
                Switch(
                    checked = if (mirrored) shown else on,
                    onCheckedChange = { store.writeBound("on", it) },
                    modifier = Modifier.testTag("sw"),
                    interactionSource = interactionSource,
                    // Explicit colors so the thumb is pixel-separable — red on a gray track.
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = Color.Red,
                        uncheckedThumbColor = Color.Red,
                        checkedTrackColor = Color(0xFF404040),
                        uncheckedTrackColor = Color(0xFF404040),
                        uncheckedBorderColor = Color(0xFF404040),
                    ),
                )
            }
        }
    }

    /** The thumb's horizontal center: the centroid of the red thumb pixels. */
    private fun ComposeUiTest.thumbCenterX(): Double {
        val px = onNodeWithTag("sw").captureToImage().toPixelMap()
        var sum = 0.0
        var n = 0
        for (y in 0 until px.height) for (x in 0 until px.width) {
            val c = px[x, y]
            if (c.red > 0.6f && c.green < 0.35f && c.blue < 0.35f) { sum += x; n += 1 }
        }
        require(n > 0) { "no red thumb pixels found in the ${px.width}x${px.height} capture" }
        return sum / n
    }

    @Test
    fun clickGlidesThroughTheStoreRoundTrip() {
        // The clean tap: click → store write → publish → recomposition → the thumb GLIDES
        // (t0 still at the start, a strictly-between mid frame, and the full M3 travel:
        // thumb centers 16dp → 36dp = 20dp = 40px at density 2).
        val store = StackStore()
        runSkikoComposeUiTest(size = Size(300f, 200f), density = Density(2f), testTimeout = 30.seconds) {
            mainClock.autoAdvance = false
            setContent { StoreDrivenM3Switch(store) }
            repeat(3) { flush() }
            val start = thumbCenterX()
            onNodeWithTag("sw").performClick()
            flush()
            val t0 = thumbCenterX()
            flush(); flush()
            val mid = thumbCenterX()
            repeat(40) { flush() }
            val end = thumbCenterX()
            val travel = end - start
            assertTrue(JSE.truthy(store.getPath("on")), "the click must have written the store")
            assertTrue(abs(t0 - start) < 3.0, "one frame after the click the thumb should still sit at the start (start=$start t0=$t0)")
            assertTrue(mid > start + 0.5 && mid < end - 0.5,
                "expected a strictly-between mid-flight frame — a snap has none (start=$start mid=$mid end=$end)")
            assertTrue(travel > 34 && travel < 46,
                "expected the full M3 thumb travel ~40px at density 2, measured $travel (start=$start end=$end)")
        }
    }

    @Test
    fun pressHeldFlipSnapsOnTheRawComponent() {
        // THE DISEASE, deterministically: while the press interaction is active, a checked
        // flip's measure takes material3's SnapSpec — the full travel lands in ONE frame.
        // Pinned so the SystemSwitch mirror's reason stays visible; if a future material3
        // drops the pressed-snap fork this goes red and the mirror can retire.
        val store = StackStore()
        val src = MutableInteractionSource()
        runSkikoComposeUiTest(size = Size(300f, 200f), density = Density(2f), testTimeout = 30.seconds) {
            mainClock.autoAdvance = false
            setContent { StoreDrivenM3Switch(store, interactionSource = src) }
            repeat(3) { flush() }
            val start = thumbCenterX()
            val press = PressInteraction.Press(Offset(10f, 10f))
            runBlocking { src.emit(press) }
            repeat(2) { flush() }
            SwingUtilities.invokeAndWait { store.writeBound("on", true) }   // the flip lands PRESSED
            flush()                                                          // publish + recompose
            flush()                                                          // the change-measure frame
            val afterFlip = thumbCenterX()
            runBlocking { src.emit(PressInteraction.Release(press)) }
            repeat(40) { flush() }
            val end = thumbCenterX()
            assertTrue(end > start + 20, "the switch must have ended checked (start=$start end=$end)")
            assertTrue(abs(afterFlip - end) < 6.0,
                "under a held press the raw component SNAPS — the thumb should already sit at the end " +
                    "one change-frame in (start=$start afterFlip=$afterFlip end=$end); if it glided, " +
                    "material3 dropped the pressed-snap fork and SystemSwitch's mirror can retire")
        }
    }

    @Test
    fun mirroredWiringGlidesUnderThePressRace() {
        // THE CURE (:render SystemSwitch): the same press-held flip, but checked reaches the
        // component one frame late — after the Release is collected — so the change-measure
        // runs unpressed and the thumb takes the ANIMATED branch.
        val store = StackStore()
        val src = MutableInteractionSource()
        runSkikoComposeUiTest(size = Size(300f, 200f), density = Density(2f), testTimeout = 30.seconds) {
            mainClock.autoAdvance = false
            setContent { StoreDrivenM3Switch(store, interactionSource = src, mirrored = true) }
            repeat(3) { flush() }
            val start = thumbCenterX()
            val press = PressInteraction.Press(Offset(10f, 10f))
            runBlocking { src.emit(press) }
            repeat(2) { flush() }
            SwingUtilities.invokeAndWait { store.writeBound("on", true) }
            runBlocking { src.emit(PressInteraction.Release(press)) }        // the finger lifts — the tap ordering
            flush()                                                          // publish + the mirror hop
            flush()                                                          // the change-measure frame
            val early = thumbCenterX()
            flush()
            val mid = thumbCenterX()
            repeat(40) { flush() }
            val end = thumbCenterX()
            val travel = end - start
            assertTrue(travel > 34 && travel < 46,
                "expected the full M3 thumb travel ~40px at density 2, measured $travel (start=$start end=$end)")
            assertTrue(early < end - 0.5 || mid < end - 0.5,
                "the mirrored wiring must GLIDE under the press race — some observed frame sits short " +
                    "of the end (start=$start early=$early mid=$mid end=$end); equal-to-end everywhere = it still snaps")
        }
    }

    private fun ComposeUiTest.flush() {
        if (!SwingUtilities.isEventDispatchThread()) SwingUtilities.invokeAndWait { }
        mainClock.advanceTimeByFrame()
        waitForIdle()
    }
}
