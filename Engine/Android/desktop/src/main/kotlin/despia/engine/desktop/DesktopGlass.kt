package despia.engine.desktop

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import despia.engine.SurfaceMaterials

/**
 * `glassInteractive` on the desktop lane - the twin of `StackGlass.kt`, and a separate file for
 * the reason DesktopShadow is separate from StackShadow: the two lanes resolve different Compose
 * distributions. The DECISION is identical on purpose, down to the constant - which is
 * :core's (SurfaceMaterials.PRESS_*), not a second copy - so a press means the same thing on
 * Windows and Linux as it does on Android, on the web and under a finger on iOS.
 *
 * The lane paints a translucent fill rather than a material (see the `surface` row in the parity
 * register), so as on Android there is no material for an "interactive" variant to modulate. The
 * observable half of the iOS response is the geometry, and that is what this paints.
 */
internal fun Modifier.desktopGlassPress(): Modifier = composed {
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (pressed) SurfaceMaterials.PRESS_SCALE else 1f,
        animationSpec = if (pressed) tween(SurfaceMaterials.PRESS_IN_MS)
        else spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label = "desktopGlassPress",
    )
    Modifier
        // Watched on the Initial pass and never consumed: a glass panel is not necessarily a
        // control, so the press response must not become a competitor for the tap, the long press
        // or the scroll that the element already owns.
        .pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                pressed = true
                try {
                    var down = true
                    while (down) {
                        down = awaitPointerEvent(PointerEventPass.Initial).changes.any { it.pressed }
                    }
                } finally {
                    pressed = false
                }
            }
        }
        .graphicsLayer { scaleX = scale; scaleY = scale }
}
