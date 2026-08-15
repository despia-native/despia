//
//  RangeSliderElements.kt — `<rangeslider>` (Kotlin twin of RangeSlider.swift). A
//  dual-thumb range with TWO bound number vars: `bindLow` + `bindHigh`; `min` (0) …
//  `max` (1); optional `step` snaps each thumb on a grid ANCHORED AT MIN; `color`
//  (default accent) tints the selected segment + the thumb rings.
//
//  UNSTYLED (M3-batch2b) → the REAL Material 3 `RangeSlider` over the SAME two bound vars
//  (the M3 range's `start`/`endInclusive` write bindLow/bindHigh through the seam); `step`
//  maps to the M3 `steps` count (accessibilityStepsForIncrement — the shared formula);
//  `color` (if authored) rides as the thumb + active-track tint, unauthored takes the M3
//  default primary (SelectionControl.RANGESLIDER). ANY authored look ejects to the LEGACY
//  custom track (below), byte-identical.
//
//  DIVERGENCES (M3 path, none silent): SwiftUI ships no range slider, so iOS draws its own
//  custom track (the legacy path here is its byte twin); Android's unstyled baseline IS the
//  platform's real M3 RangeSlider (the segmentedButton precedent — iOS custom Material row,
//  Android real M3 row). The M3 slider owns its OWN metrics/tick marks and writes per drag
//  frame (the iOS ~80 ms throttle is that platform's own control behavior — the M3SliderView
//  precedent). The fixture describes the LEGACY track, which stays byte-identical, so no
//  fixture/spec change.
//
//  LEGACY CHROME is internal, the iOS numbers verbatim: thumb 24 (white fill, 2dp tint
//  ring, black-18% shadow), track 4 capsule (label-color 18% inactive), control height 28,
//  track inset by the thumb radius so it meets the thumb centres. While a thumb is down it
//  rides LOCAL state and the bound write is THROTTLED (≥80 ms apart + a final commit on
//  release) — the same Low-Power-Mode fix as iOS. Each write goes through the bind seam, so
//  the owner's `on:change` fires from the engine, on an actual change only. Low is clamped
//  to [min, high], high to [low, max] — the thumbs never cross.
//

package despia.engine.render.elements

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.SliderDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackStyle
import despia.engine.render.accessibilityStepsForIncrement
import despia.engine.render.dsxAccessibleRange
import kotlin.math.roundToInt

internal fun registerRangeSliderElements() {
    ComposeStackComponents.defineNative("rangeslider") { ctx -> RangeSliderView(ctx) }
}

private const val THUMB = ElementDefaults.RANGE_THUMB    // thumb diameter (iOS)
private const val TRACK = ElementDefaults.RANGE_TRACK     // track thickness (iOS)
private const val HEIGHT = ElementDefaults.RANGE_HEIGHT   // control height (iOS)

@Composable
private fun RangeSliderView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.RANGESLIDER)) M3RangeSliderView(ctx)
    else LegacyRangeSliderView(ctx)
}

/// The unstyled range's system rendering: the REAL M3 `RangeSlider` over the SAME two bound
/// vars. `start`/`endInclusive` write bindLow/bindHigh through the seam; `step` → the M3
/// `steps` count (the shared accessibility formula); `color` (if authored) rides as the
/// thumb + active-track tint. Degenerate-range guard = the M3SliderView epsilon.
@Composable
private fun M3RangeSliderView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val lowKey = ctx.attrs["bindLow"] ?: ""
    val highKey = ctx.attrs["bindHigh"] ?: ""
    val min = ctx.num("min") ?: 0.0
    val max = ctx.num("max") ?: 1.0
    val lo = minOf(min, max)
    val hi = maxOf(maxOf(min, max), lo + 0.0001)               // degenerate-range guard (M3SliderView twin)
    val step = ctx.num("step")?.takeIf { it.isFinite() && it > 0 }   // null = continuous
    val steps = accessibilityStepsForIncrement(lo, hi, step)
    val lowVal = (JSE.number(ctl.boundValue(lowKey)) ?: lo).coerceIn(lo, hi)
    val highVal = (JSE.number(ctl.boundValue(highKey)) ?: hi).coerceIn(lowVal, hi)
    val authored = ctl.interp("color")
    val colors = if (authored.isNullOrEmpty()) SliderDefaults.colors()
                 else { val t = StackStyle.color(authored)
                        SliderDefaults.colors(thumbColor = t, activeTrackColor = t) }
    RangeSlider(
        value = lowVal.toFloat()..highVal.toFloat(),
        onValueChange = { r ->
            if (lowKey.isNotEmpty()) ctl.setBound(lowKey, r.start.toDouble())        // on:change from the seam
            if (highKey.isNotEmpty()) ctl.setBound(highKey, r.endInclusive.toDouble())
        },
        modifier = Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth()),
        valueRange = lo.toFloat()..hi.toFloat(),
        steps = steps,
        colors = colors,
    )
}

// MARK: - rangeslider (legacy — the byte-identical custom dual-thumb track, ElementSpec-pinned)

@Composable
private fun LegacyRangeSliderView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val lowKey = ctx.attrs["bindLow"] ?: ""
    val highKey = ctx.attrs["bindHigh"] ?: ""
    val min = ctx.num("min") ?: 0.0
    val max = ctx.num("max") ?: 1.0
    val lo = minOf(min, max)
    val hi = maxOf(min, max)
    val span = maxOf(hi - lo, 0.0001)                          // avoid /0 on a degenerate range
    val step = ctx.num("step")                                 // null = continuous
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.RANGE_TINT))

    var lowLocal by remember { mutableStateOf<Double?>(null) }   // non-nil = that thumb's drag in flight
    var highLocal by remember { mutableStateOf<Double?>(null) }
    var lastPush by remember { mutableLongStateOf(0L) }          // uptime of the last bound write
    var widthPx by remember { mutableFloatStateOf(0f) }

    // Current values: the in-flight drag when there is one, else the bound var — clamped
    // and ordered into [lo,hi] (the Swift expressions verbatim).
    val lowVal = minOf(maxOf(lowLocal ?: JSE.number(ctl.boundValue(lowKey)) ?: lo, lo), hi)
    val highVal = maxOf(minOf(highLocal ?: JSE.number(ctl.boundValue(highKey)) ?: hi, hi), lowVal)

    val density = LocalDensity.current
    val thumbPx = with(density) { THUMB.dp.toPx() }
    val usable = maxOf(widthPx - thumbPx, 1f)                  // travel for a thumb centre
    val lowX = ((lowVal - lo) / span).toFloat() * usable
    val highX = ((highVal - lo) / span).toFloat() * usable

    /// Map a drag x to a value (ElementMath.rangeValue = the Swift `value(at:)`), keep the
    /// thumb on LOCAL state every frame, and land the bound write throttled (≥80 ms) with
    /// a final commit on release — release/cancel always clears the local.
    fun Modifier.thumbDrag(clampLo: () -> Double, clampHi: () -> Double,
                           local: (Double?) -> Unit, write: (Double) -> Unit): Modifier =
        pointerInput(lowKey, highKey, lo, hi, step) {
            var x = 0f
            detectDragGestures(
                onDragStart = { offset -> x = offset.x },
                onDrag = { change, delta ->
                    change.consume()
                    x += delta.x
                    val v = ElementMath.rangeValue(((x - thumbPx / 2) / usable).toDouble(),
                                                   lo, span, step, clampLo(), clampHi())
                    local(v)
                    val now = System.nanoTime() / 1_000_000
                    if (now - lastPush >= 80) { lastPush = now; write(v) }
                },
                onDragEnd = {
                    write(ElementMath.rangeValue(((x - thumbPx / 2) / usable).toDouble(),
                                                 lo, span, step, clampLo(), clampHi()))
                    local(null)
                },
                onDragCancel = { local(null) },   // system cancellation — never freeze the thumb
            )
        }

    Box(Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth().height(HEIGHT.dp))
            .onSizeChanged { widthPx = it.width.toFloat() },
        contentAlignment = Alignment.CenterStart) {
        // Inactive track — full width, inset by the thumb radius so it meets the centres.
        Box(Modifier.fillMaxWidth().padding(horizontal = (THUMB / 2).dp).height(TRACK.dp)
                .background(StackStyle.color("label").copy(alpha = ElementDefaults.RANGE_TRACK_OPACITY.toFloat()), RoundedCornerShape((TRACK / 2).dp)))
        // Selected segment between the two thumb centres.
        Box(Modifier
                .offset { IntOffset((lowX + thumbPx / 2).roundToInt(), 0) }
                .width(with(density) { maxOf(highX - lowX, 0f).toDp() }).height(TRACK.dp)
                .background(tint, RoundedCornerShape((TRACK / 2).dp)))
        // Low thumb — clamped to [lo, highVal] so it never crosses the high thumb.
        ThumbView(tint, Modifier
            .offset { IntOffset(lowX.roundToInt(), 0) }
            .dsxAccessibleRange(
                value = lowVal.toFloat(),
                valueRange = lo.toFloat()..highVal.toFloat(),
                steps = accessibilityStepsForIncrement(lo, highVal, step),
                enabled = lowKey.isNotEmpty(),
                contentDescription = DSXStrings.localize("Minimum"),
                mergeDescendants = false,
                onSetProgress = { target ->
                    if (lowKey.isEmpty()) false
                    else {
                        val v = ElementMath.rangeValue(
                            ((target.toDouble() - lo) / span),
                            lo, span, step, lo, highVal,
                        )
                        ctl.setBound(lowKey, v)
                        true
                    }
                },
            )
            .thumbDrag({ lo }, { highVal }, { lowLocal = it }, { ctl.setBound(lowKey, it) }))
        // High thumb — clamped to [lowVal, hi] so it never crosses the low thumb.
        ThumbView(tint, Modifier
            .offset { IntOffset(highX.roundToInt(), 0) }
            .dsxAccessibleRange(
                value = highVal.toFloat(),
                valueRange = lowVal.toFloat()..hi.toFloat(),
                steps = accessibilityStepsForIncrement(lowVal, hi, step),
                enabled = highKey.isNotEmpty(),
                contentDescription = DSXStrings.localize("Maximum"),
                mergeDescendants = false,
                onSetProgress = { target ->
                    if (highKey.isEmpty()) false
                    else {
                        val v = ElementMath.rangeValue(
                            ((target.toDouble() - lo) / span),
                            lo, span, step, lowVal, hi,
                        )
                        ctl.setBound(highKey, v)
                        true
                    }
                },
            )
            .thumbDrag({ lowVal }, { hi }, { highLocal = it }, { ctl.setBound(highKey, it) }))
    }
}

@Composable
private fun ThumbView(tint: Color, modifier: Modifier) {
    Box(modifier
            .size(THUMB.dp)
            .shadow(2.dp, CircleShape, clip = false,
                    ambientColor = Color.Black.copy(alpha = 0.18f),
                    spotColor = Color.Black.copy(alpha = 0.18f))
            .background(Color.White, CircleShape)
            .border(2.dp, tint, CircleShape))
}
