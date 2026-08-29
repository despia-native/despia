package despia.engine.render

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
 * `glassInteractive` on Compose - the press response, and the reason it is GEOMETRY rather than
 * material.
 *
 * iOS 26 stretches the real Liquid Glass material under the finger. Material 3 has no frosted
 * material at all (`surface` already degrades to a translucent fill - SurfaceMaterials), so there
 * is nothing here for an "interactive material" to modulate, and that is what kept the attribute
 * in the parity register on both Compose lanes. The observable half of the iOS response is a
 * press-driven scale, and Compose hosts that natively, so the twin is the same 0.97 the web
 * renderer and the pressable surface cards already use: fast in, springing back out.
 *
 * The two numbers are :core's (SurfaceMaterials.PRESS_*), shared with the desktop lane: two
 * copies of a design number are two chances to answer an author differently.
 *
 * SEAMS (pinned, none silent):
 *  - NOTHING IS CONSUMED. The tracker watches the Initial pass and never marks a change handled,
 *    so a tap, a long press and a scroll all still reach whatever owns them - the press response
 *    is decoration over the gesture, never a competitor for it. That is why this is a bare
 *    pointerInput rather than a clickable or an InteractionSource: a glass panel is not
 *    necessarily a control, and giving it one would change what the element IS.
 *  - OPT-IN, matching iOS. Stack.swift defaulted the press on for every tappable once (#1002) and
 *    a glass-dense sheet leaked a stray platter, so all four renderers now read `="true"` alone.
 *  - The scale lands OUTSIDE the surface fill in the modifier fold, so the material and the
 *    content move together - a press that scaled only the content would slide it under a static
 *    pane of glass.
 */
internal fun Modifier.glassPress(): Modifier = composed {
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (pressed) SurfaceMaterials.PRESS_SCALE else 1f,
        animationSpec = if (pressed) tween(SurfaceMaterials.PRESS_IN_MS)
        else spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label = "glassPress",
    )
    Modifier
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
