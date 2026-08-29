//
//  RatingElements.kt — `<stars>` (Kotlin twin of Stars.swift). A star rating, display +
//  input: `bind` is a bound number; `count` (default 5, min 1) cells; each cell's fill
//  fraction is `clamp(value - index, 0, 1)`; `color` (default #FFCC00) tints the fill;
//  `size` (default 24) is the per-star point size; cell spacing = size * 0.18. Tapping
//  cell i (unless `readonly`) writes i+1 through the bind seam — `on:change` fires from
//  the write, never here. `allowHalf` stays reserved (display already renders halves),
//  exactly like iOS.
//
//  M3 IDENTITY (M3-batch2b — the wave's completion): `stars` is NOT gated to a two-path
//  (unlike checkbox/radiogroup/stepper/rangeslider/otp). Material 3 ships NO rating
//  component, AND the shipped Material Symbols subset carries no OUTLINE star glyph (only
//  the filled `star`/`star.fill` codepoint), so there is no distinct "M3 star row" to
//  switch into and no platform glyph to lean on. Following the wheelpicker/calendar
//  precedent (SelectionSystem.kt / PickerElements.kt / DateElements.kt), `stars` therefore
//  renders its custom-but-M3-token-dressed drawn-star row in EVERY case — `color` already
//  rides it as the fill tint (the token dressing), and the fraction/precision contract is
//  richer than a discrete filled/half/outline icon rating. Declared divergence, no gate.
//
//  PINNED DEVIATION: iOS overlays the SF `star.fill` glyph clipped to the fraction over
//  the SF `star` outline at 30% tint. The sf-map subset has no OUTLINE star glyph, so the
//  cell is DRAWN — the same five-point star as a stroked path (30% tint) with the filled
//  star clipped to the fraction (left-aligned) over it. Same geometry contract (fraction
//  of the cell width), same colors/sizes; the glyph is ours, not the platform's.
//

package despia.engine.render.elements

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleRange
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

internal fun registerRatingElements() {
    ComposeStackComponents.defineNative("stars") { ctx -> StarsView(ctx) }
}

@Composable
private fun StarsView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val value = JSE.number(ctl.boundValue(key)) ?: 0.0
    val count = maxOf(1, ctx.num("count")?.toInt() ?: ElementDefaults.STARS_COUNT)
    val size = ctx.num("size") ?: ElementDefaults.STARS_SIZE
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.STARS_TINT))
    val readonly = ctx.bool("readonly")
    // disabled= / disabled-if= (W9): folds with readonly — same inert row, dimmed
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val inert = readonly || disabled
    Row(
        Modifier.elementModifier(ctx)
            .alpha(if (disabled) 0.5f else 1f)
            .dsxAccessibleRange(
                value = value.toFloat().coerceIn(0f, count.toFloat()),
                valueRange = 0f..count.toFloat(),
                steps = (count - 1).coerceAtLeast(0),
                enabled = !inert && key.isNotEmpty(),
                stateDescription = "${value.coerceIn(0.0, count.toDouble())} / $count",
                onSetProgress = { target ->
                    if (inert || key.isEmpty()) false
                    else {
                        ctl.setBound(key, target.roundToInt().coerceIn(0, count).toDouble())
                        true
                    }
                },
            ),
        horizontalArrangement = Arrangement.spacedBy((size * ElementDefaults.STARS_SPACING_FRACTION).dp),
    ) {
        for (i in 0 until count) {
            val fraction = ElementMath.starFraction(value, i)
            val cell: @Composable (Modifier) -> Unit = { m ->
                Canvas(m.size(size.dp)) {
                    val star = starPath(this.size)
                    // Empty state: the outline star at 30% tint (the SF `star` stand-in).
                    drawPath(star, tint.copy(alpha = ElementDefaults.STARS_EMPTY_OPACITY.toFloat()), style = Stroke(width = this.size.width * 0.07f))
                    // Fill state: the filled star clipped to `fraction` of the width, left-aligned.
                    if (fraction > 0f) {
                        clipRect(right = this.size.width * fraction) { drawPath(star, tint) }
                    }
                }
            }
            if (readonly) {
                // Display-only: the bare glyph row (the iOS starRow twin — no hit boxes).
                cell(Modifier)
            } else {
                // Interactive: the authored glyph stays its size, the tap target rides the
                // platform minimum (density-following via the funnel's
                // LocalMinimumInteractiveComponentSize pin) — the iOS 44pt-frame /
                // web padded-hit-box twin. pointerInput sits OUTSIDE the floor modifier so
                // the whole floored box, not just the glyph, is tappable.
                Box(
                    Modifier.pointerInput(key, i, inert) {
                        detectTapGestures {
                            if (!inert) ctl.setBound(key, (i + 1).toDouble())   // whole-star tap → bound write → on:change
                        }
                    }.minimumInteractiveComponentSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    cell(Modifier)
                }
            }
        }
    }
}

/// A classic five-point star inscribed in the cell (outer radius = cell/2, inner = 0.4×),
/// top point up — the drawn stand-in for the SF star glyph (see header).
private fun starPath(size: Size): Path {
    val cx = size.width / 2f
    val cy = size.height / 2f
    val outer = size.minDimension / 2f
    val inner = outer * 0.4f
    val path = Path()
    for (k in 0 until 10) {
        val r = if (k % 2 == 0) outer else inner
        val angle = Math.PI / 2 + k * Math.PI / 5     // start at the TOP point, step 36°
        val x = cx + (r * cos(angle)).toFloat()
        val y = cy - (r * sin(angle)).toFloat()
        if (k == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
    return path
}
