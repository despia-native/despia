//
//  RefreshableElements.kt — `<refreshable>` / `<refresh>`, the Kotlin twin of Foundation
//  Structure/Refreshable/Refreshable.swift: pull-to-refresh around the children. iOS wraps
//  the slot in `ScrollView(showsIndicators: false).refreshable { … }`; the twin PROVIDES
//  the vertical ScrollView the same way (put non-scrolling content inside, e.g.
//  `<list scroll="false">`) and, since Compose ships no Material-free refresh control,
//  implements the gesture itself on the nested-scroll seam (a NestedScrollConnection over
//  the content's `verticalScroll`) — no Material dependency, per the wave rule.
//
//  The iOS timing contract, 1:1 (PlainWaveDefaults — fixture-pinned):
//  • pull commits → run `on:refresh` (any action, usually a `fetch:`) (Refreshable.swift:27)
//  • `busy` (a bare expression, like `bind`) → hold the spinner until it turns falsy,
//    polling every 60ms after a 50ms settle that lets the action flip it true
//    (Refreshable.swift:31,34-36) — the spinner tracks the REAL load
//  • no `busy` → a 350ms grace (Refreshable.swift:32) — a sync/no-op action can't hang
//
//  ── Android chrome (internal, NOT spec'd — iOS shows the system spinner) ─────────────
//  Drag past the top reveals a spinner band: reveal = drag × 0.5 resistance; ≥ 70dp at
//  release arms the refresh (below → settles back); while busy the band holds at 56dp.
//  The indicator is the wave's spinner arc (ElementDefaults SPINNER_*): filling with pull
//  progress before arming, the rotating 270° arc while busy. All pull math is the pure
//  `RefreshMath` (plain-JVM tested — PlainElementsTest.kt).
//
//  ── PINNED DIVERGENCES (none silent) ────────────────────────────────────────────────
//  • The reveal geometry/resistance is Android chrome (UIRefreshControl-flavored numbers);
//    iOS delegates the whole gesture to SwiftUI `.refreshable`.
//  • A programmatic `busy` flip alone never shows the spinner (same as iOS — only a pull
//    arms it).
//

package despia.engine.render.elements

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.PlainWaveDefaults
import despia.engine.render.StackStyle
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

internal fun registerRefreshableElements() {
    ComposeStackComponents.defineNative("refreshable") { ctx -> RefreshableView(ctx) }
    ComposeStackComponents.defineNative("refresh") { ctx -> RefreshableView(ctx) }   // the iOS alias (Refreshable.swift:22)
}

// MARK: - the pure pull math (plain-JVM tested)

internal object RefreshMath {
    /// One drag frame's reveal update: resistance-damped, floored at rest (never negative).
    fun nextPull(current: Float, dy: Float,
                 resistance: Float = PlainWaveDefaults.REFRESH_RESISTANCE): Float =
        (current + dy * resistance).coerceAtLeast(0f)

    /// Released at/past the threshold → arm the refresh.
    fun shouldTrigger(pullPx: Float, thresholdPx: Float): Boolean =
        thresholdPx > 0f && pullPx >= thresholdPx

    /// The pre-arm indicator fill fraction (0…1 of the threshold).
    fun progress(pullPx: Float, thresholdPx: Float): Float =
        if (thresholdPx <= 0f) 0f else (pullPx / thresholdPx).coerceIn(0f, 1f)
}

// MARK: - <refreshable>

@Composable
private fun RefreshableView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val density = LocalDensity.current
    val thresholdPx = with(density) { PlainWaveDefaults.REFRESH_THRESHOLD.dp.toPx() }
    val holdPx = with(density) { PlainWaveDefaults.REFRESH_HOLD.dp.toPx() }
    var pullPx by remember { mutableFloatStateOf(0f) }
    var refreshing by remember { mutableStateOf(false) }

    val connection = remember(thresholdPx) {
        object : NestedScrollConnection {
            // Dragging back up while revealed: the reveal shrinks BEFORE the content scrolls.
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y < 0f && pullPx > 0f && !refreshing) {
                    val take = maxOf(available.y, -pullPx)
                    pullPx += take
                    return Offset(0f, take)
                }
                return Offset.Zero
            }
            // Dragging down past the content's top edge grows the reveal (resistance-damped).
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y > 0f && !refreshing) {
                    pullPx = RefreshMath.nextPull(pullPx, available.y)
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }
            // Release: at/past the threshold arms the refresh cycle; short pulls settle back.
            override suspend fun onPreFling(available: Velocity): Velocity {
                if (refreshing || pullPx <= 0f) return Velocity.Zero
                if (RefreshMath.shouldTrigger(pullPx, thresholdPx)) refreshing = true   // the cycle effect takes over
                else animate(pullPx, 0f) { v, _ -> pullPx = v }
                return available   // the revealed state owns the fling — content doesn't also fling
            }
        }
    }

    // The refresh cycle — the `.refreshable { }` body, 1:1 timing (see header).
    LaunchedEffect(refreshing) {
        if (!refreshing) return@LaunchedEffect
        ctl.fire("refresh")                                                 // Refreshable.swift:27
        animate(pullPx, holdPx) { v, _ -> pullPx = v }
        val busyExpr = ctx.attrs["busy"]
        if (busyExpr == null) {
            delay(PlainWaveDefaults.REFRESH_GRACE_MS)                       // no flag → grace (Refreshable.swift:32)
        } else {
            delay(PlainWaveDefaults.REFRESH_SETTLE_MS)                      // let the action flip busy → true (:34)
            while (JSE.truthy(ctl.boundValue(busyExpr))) {                  // dsx.json("busy") twin (:35)
                delay(PlainWaveDefaults.REFRESH_POLL_MS)                    // :36
            }
        }
        animate(pullPx, 0f) { v, _ -> pullPx = v }
        refreshing = false
    }

    Box(Modifier.elementModifier(ctx).then(Modifier.nestedScroll(connection)).clipToBounds()
            // The non-pointer refresh path (the iOS `.refreshable` exposes one automatically):
            // a TalkBack/Switch Access custom action arms the same refresh cycle the pull does.
            .semantics {
                customActions = listOf(
                    CustomAccessibilityAction(DSXStrings.localize("Refresh")) {
                        if (refreshing) false else { refreshing = true; true }
                    },
                )
            }) {
        // The revealed indicator band above the content.
        Box(Modifier.fillMaxWidth().height(with(density) { pullPx.toDp() }),
            contentAlignment = Alignment.Center) {
            if (pullPx > 0f) RefreshIndicator(refreshing, RefreshMath.progress(pullPx, thresholdPx))
        }
        // The provided ScrollView (indicator-free, like iOS) — the slot rides the
        // consumer's scope; flexible <spacer/>s take the column's weight scope.
        Column(Modifier.fillMaxWidth()
                   .offset { IntOffset(0, pullPx.roundToInt()) }
                   .verticalScroll(rememberScrollState())) {
            SlotColumnNodes(ctx, defaultSlot(ctx))
        }
    }
}

/// The indicator: pre-arm = the arc filling with pull progress (fading in); busy = the
/// wave's rotating spinner (ElementDefaults SPINNER_* — the shared chrome).
@Composable
private fun RefreshIndicator(refreshing: Boolean, progress: Float) {
    val tint = StackStyle.color(ElementDefaults.SPINNER_TINT)
    if (refreshing) {
        val transition = rememberInfiniteTransition(label = "refreshable")
        val angle by transition.animateFloat(
            initialValue = 0f, targetValue = 360f,
            animationSpec = infiniteRepeatable(tween(ElementDefaults.SPINNER_PERIOD_MS, easing = LinearEasing)),
            label = "refreshableAngle")
        RefreshArc(angle, ElementDefaults.SPINNER_SWEEP, tint)
    } else {
        RefreshArc(-90f, ElementDefaults.SPINNER_SWEEP * progress, tint.copy(alpha = tint.alpha * progress))
    }
}

@Composable
private fun RefreshArc(startAngle: Float, sweep: Float, color: Color) {
    Canvas(Modifier.size(ElementDefaults.SPINNER_SIZE.dp)) {
        drawArc(color = color, startAngle = startAngle, sweepAngle = sweep, useCenter = false,
                style = Stroke(width = ElementDefaults.SPINNER_STROKE.dp.toPx(), cap = StrokeCap.Round))
    }
}
