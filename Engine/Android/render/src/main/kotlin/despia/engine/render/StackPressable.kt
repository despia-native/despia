package despia.engine.render

//
//  StackPressable — the `<pressable>` / `<row>` multi-gesture surface (tap + double-tap +
//  long-press), the PressableTouchView twin (Pressable.swift:204-392). Compose's
//  detectTapGestures DELAYS onTap until the double-tap timeout when onDoubleTap is supplied —
//  the "exclusive single" the Swift contract rejects by name — so the recognizer is
//  hand-rolled: one awaitEachGesture loop owns the physical arbitration, and the pure
//  state machine below (JVM-pinned in PressableGestureMachineTest) decides what fires.
//
//  GESTURE CONTRACT (the TikTok model, Pressable.swift header): `on:tap` fires INSTANTLY on
//  every tap-up — including each tap of a double — and `on:doubleTap` fires ADDITIONALLY on
//  the second. LONG-PRESS is a LIFECYCLE: `on:longPress` at recognition (0.4 s hold within
//  the 12 dp slop), `on:longPressEnd` at lift/cancel AFTER a recognized hold; a recognized
//  hold suppresses the tap, and a plain tap (released before 0.4 s) fires neither. A hold
//  with NO long handler declared stays a tap on release (the disabled-recognizer arm —
//  a slow tap is still a tap). Movement past the slop before recognition kills the gesture.
//
//  DIVERGENCES (pinned, none silent):
//  • The double-tap window is the PLATFORM's (viewConfiguration.doubleTapTimeoutMillis,
//    measured first-tap-up → second-tap-down, Compose's own awaitSecondDown convention)
//    where iOS rides UITapGestureRecognizer's undocumented internal window — each platform's
//    real arbitration, the keyboard→ImeAction precedent.
//  • A change CONSUMED by an ancestor recognizer (scroll/pager taking over) is the cancel
//    signal (Compose's waitForUpOrCancellation convention) — the touchesCancelled twin; a
//    recognized hold still balances its end on that path, exactly like iOS.
//

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

/// What the machine decided a physical event means. The wiring maps events to the declared
/// actions; the machine itself never sees an action string (pure, JVM-testable).
internal enum class PressableEvent { Primary, Double, LongBegin, LongEnd }

/// The pure recognizer state machine — the PressableTouchView tracking fields
/// (touchEligible/touchMoved/longRecognized/longActive) as one testable object. The Compose
/// side reports raw facts (down/moved/hold-timeout/up/cancel); the machine answers with the
/// events that fire. Double-chain state (`lastTapUpMillis`) lives ACROSS gestures, exactly
/// like the UIKit recognizer's tap-count window.
internal class PressableGestureMachine(
    private val hasPrimary: Boolean,
    private val hasDouble: Boolean,
    private val hasLong: Boolean,
    private val doubleTapWindowMillis: Long,
) {
    private var moved = false
    private var longRecognized = false
    private var secondOfDouble = false
    private var lastTapUpMillis: Long? = null

    /// A finger went down. Decides up-front whether this gesture is the second tap of a
    /// double (down within the window of the previous tap-up — awaitSecondDown's measure).
    fun down(timeMillis: Long) {
        moved = false
        longRecognized = false
        secondOfDouble = hasDouble && lastTapUpMillis?.let { timeMillis - it <= doubleTapWindowMillis } == true
    }

    /// The finger travelled past the movement slop BEFORE recognition — the gesture is dead
    /// (no tap on release, no long recognition; Pressable.swift touchMoved). Movement AFTER
    /// a recognized hold is legal and changes nothing (UILongPressGestureRecognizer .changed).
    fun moved() {
        if (!longRecognized) moved = true
    }

    /// The 0.4 s hold elapsed with the finger still down. Recognizes the long press when one
    /// is armed and the gesture is still alive (the handleLong .began guards).
    fun holdElapsed(): List<PressableEvent> {
        if (!hasLong || moved || longRecognized) return emptyList()
        longRecognized = true
        return listOf(PressableEvent.LongBegin)
    }

    /// The finger lifted. A recognized hold balances its end (and is never a tap); a moved
    /// gesture fires nothing; otherwise the tap-up fires primary INSTANTLY and — on the
    /// second tap of a chain — Double additionally. A consumed chain resets (the third tap
    /// starts fresh, UIKit tap-count semantics).
    fun up(timeMillis: Long): List<PressableEvent> {
        if (longRecognized) {
            longRecognized = false
            lastTapUpMillis = null
            return listOf(PressableEvent.LongEnd)
        }
        if (moved) {
            lastTapUpMillis = null
            return emptyList()
        }
        val out = ArrayList<PressableEvent>(2)
        if (hasPrimary) out.add(PressableEvent.Primary)
        if (secondOfDouble) {
            out.add(PressableEvent.Double)
            lastTapUpMillis = null
        } else {
            lastTapUpMillis = timeMillis
        }
        return out
    }

    /// The system took the pointer (ancestor consumed / composition left). A recognized hold
    /// must still balance its end — the finishLongIfNeeded twin; everything else resets.
    fun cancel(): List<PressableEvent> {
        val out = if (longRecognized) listOf(PressableEvent.LongEnd) else emptyList()
        longRecognized = false
        lastTapUpMillis = null
        return out
    }
}

/// Pressable.swift movementSlop:12 — points there, dp here (the drag-payload unit rule).
private const val PRESSABLE_MOVEMENT_SLOP_DP = 12.0

/// The physical recognizer. Applied OUTSIDE the style chain (the clickable-path rule: the
/// hit region is the element's FULL styled box). Deliberately indication-free — the iOS
/// touch host is a transparent overlay with no press feedback, and the multi-gesture branch
/// never wears StackButtonStyle's press scale (Pressable.swift drops the Button entirely).
internal fun Modifier.dsxPressableGestures(
    enabled: Boolean,
    onPrimary: (() -> Unit)?,
    onDouble: (() -> Unit)?,
    onLongBegin: (() -> Unit)?,
    onLongEnd: (() -> Unit)?,
): Modifier = composed {
    val slopPx = with(LocalDensity.current) { PRESSABLE_MOVEMENT_SLOP_DP.dp.toPx() }
    val longPressMillis = (ElementDefaults.PRESSABLE_LONG_PRESS_SECONDS * 1000).toLong()
    Modifier.pointerInput(enabled, onPrimary != null, onDouble != null,
                          onLongBegin != null, onLongEnd != null) {
        if (!enabled || (onPrimary == null && onDouble == null &&
                         onLongBegin == null && onLongEnd == null)) return@pointerInput
        val hasLong = onLongBegin != null || onLongEnd != null
        val machine = PressableGestureMachine(
            hasPrimary = onPrimary != null,
            hasDouble = onDouble != null,
            hasLong = hasLong,
            doubleTapWindowMillis = viewConfiguration.doubleTapTimeoutMillis,
        )
        fun dispatch(events: List<PressableEvent>) {
            for (event in events) when (event) {
                PressableEvent.Primary -> onPrimary?.invoke()
                PressableEvent.Double -> onDouble?.invoke()
                PressableEvent.LongBegin -> onLongBegin?.invoke()
                PressableEvent.LongEnd -> onLongEnd?.invoke()
            }
        }
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            machine.down(down.uptimeMillis)
            // Phase 1 — bounded by the hold window ONLY when a long handler armed the
            // recognizer; otherwise the wait is unbounded and a slow release stays a tap.
            var outcome = if (hasLong) {
                withTimeoutOrNull(longPressMillis) {
                    trackToUpOrCancel(machine, down.id, down.position, slopPx)
                }
            } else {
                trackToUpOrCancel(machine, down.id, down.position, slopPx)
            }
            if (outcome == null) {
                // Still held at 0.4 s — recognition, then an unbounded wait for the lift.
                dispatch(machine.holdElapsed())
                outcome = trackToUpOrCancel(machine, down.id, down.position, slopPx)
            }
            when (outcome) {
                is PressableOutcome.Up -> dispatch(machine.up(outcome.timeMillis))
                is PressableOutcome.Cancelled, null -> dispatch(machine.cancel())
            }
        }
    }
}

private sealed interface PressableOutcome {
    class Up(val timeMillis: Long) : PressableOutcome
    object Cancelled : PressableOutcome
}

/// Follow the tracked pointer until it lifts or the system takes it. Reports slop breaches
/// to the machine as they happen; consumption by another recognizer is the cancel signal
/// (the waitForUpOrCancellation convention).
private suspend fun AwaitPointerEventScope.trackToUpOrCancel(
    machine: PressableGestureMachine,
    pointerId: PointerId,
    start: Offset,
    slopPx: Float,
): PressableOutcome {
    while (true) {
        val event = awaitPointerEvent()
        val change: PointerInputChange = event.changes.firstOrNull { it.id == pointerId }
            ?: continue
        if (change.changedToUpIgnoreConsumed()) return PressableOutcome.Up(change.uptimeMillis)
        if (change.isConsumed) return PressableOutcome.Cancelled
        if ((change.position - start).getDistance() > slopPx) machine.moved()
    }
}
