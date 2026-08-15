package despia.engine.render

import androidx.compose.foundation.focusable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.onClick as semanticsOnClick
import androidx.compose.ui.semantics.onLongClick as semanticsOnLongClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Accessibility activation layered beside a custom pointer recognizer.
 *
 * DSX's painted controls deliberately retain their raw gesture detector so nested scroll,
 * pager, long-press, and drag arbitration do not change. This modifier supplies the
 * non-pointer half that a raw detector lacks: one merged semantics node, switch-access
 * actions, focus traversal, and Enter/Space/D-pad activation.
 */
internal fun Modifier.dsxAccessibleActivation(
    enabled: Boolean = true,
    role: Role? = Role.Button,
    contentDescription: String? = null,
    stateDescription: String? = null,
    onClickLabel: String? = null,
    onLongClickLabel: String? = null,
    mergeDescendants: Boolean = true,
    clearDescendants: Boolean = false,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
): Modifier {
    val activate = onClick ?: onLongClick
    val properties: SemanticsPropertyReceiver.() -> Unit = {
        if (role != null) this.role = role
        if (!contentDescription.isNullOrEmpty()) this.contentDescription = contentDescription
        if (!stateDescription.isNullOrEmpty()) this.stateDescription = stateDescription
        if (!enabled) disabled()
        if (onClick != null) {
            semanticsOnClick(label = onClickLabel) {
                if (!enabled) false else {
                    onClick()
                    true
                }
            }
        }
        if (onLongClick != null) {
            semanticsOnLongClick(label = onLongClickLabel) {
                if (!enabled) false else {
                    onLongClick()
                    true
                }
            }
        }
    }
    var out =
        if (clearDescendants) clearAndSetSemantics(properties)
        else semantics(mergeDescendants = mergeDescendants, properties = properties)
    if (enabled && activate != null) {
        out = out
            .onKeyEvent { event ->
                if (!event.isActivationKey()) return@onKeyEvent false
                when (event.type) {
                    KeyEventType.KeyDown -> true
                    KeyEventType.KeyUp -> {
                        activate()
                        true
                    }
                    else -> false
                }
            }
            .focusable()
    }
    return out
}

/** A Bool control with native checkbox/switch state plus the activation contract above. */
internal fun Modifier.dsxAccessibleToggle(
    value: Boolean,
    enabled: Boolean = true,
    role: Role,
    contentDescription: String? = null,
    mergeDescendants: Boolean = true,
    onToggle: (Boolean) -> Unit,
): Modifier {
    var out = semantics(mergeDescendants = mergeDescendants) {
        this.role = role
        toggleableState = if (value) ToggleableState.On else ToggleableState.Off
        if (!contentDescription.isNullOrEmpty()) this.contentDescription = contentDescription
        if (!enabled) disabled()
        semanticsOnClick {
            if (!enabled) false else {
                onToggle(!value)
                true
            }
        }
    }
    if (enabled) {
        out = out
            .onKeyEvent { event ->
                if (!event.isActivationKey()) return@onKeyEvent false
                when (event.type) {
                    KeyEventType.KeyDown -> true
                    KeyEventType.KeyUp -> {
                        onToggle(!value)
                        true
                    }
                    else -> false
                }
            }
            .focusable()
    }
    return out
}

/** A member of a single-selection set (radio option, tab, calendar day, picker row). */
internal fun Modifier.dsxAccessibleSelectable(
    selected: Boolean,
    enabled: Boolean = true,
    role: Role,
    contentDescription: String? = null,
    mergeDescendants: Boolean = true,
    onSelect: () -> Unit,
): Modifier {
    var out = semantics(mergeDescendants = mergeDescendants) {
        this.role = role
        this.selected = selected
        if (!contentDescription.isNullOrEmpty()) this.contentDescription = contentDescription
        if (!enabled) disabled()
        semanticsOnClick {
            if (!enabled) false else {
                onSelect()
                true
            }
        }
    }
    if (enabled) {
        out = out
            .onKeyEvent { event ->
                if (!event.isActivationKey()) return@onKeyEvent false
                when (event.type) {
                    KeyEventType.KeyDown -> true
                    KeyEventType.KeyUp -> {
                        onSelect()
                        true
                    }
                    else -> false
                }
            }
            .focusable()
    }
    return out
}

/**
 * An adjustable painted control. SetProgress is the TalkBack/Switch Access contract;
 * arrow keys supply the hardware-keyboard/TV contract without adding a second pointer
 * recognizer.
 */
internal fun Modifier.dsxAccessibleRange(
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    steps: Int = 0,
    enabled: Boolean = true,
    contentDescription: String? = null,
    stateDescription: String? = null,
    mergeDescendants: Boolean = true,
    onSetProgress: (Float) -> Boolean,
): Modifier {
    val normalizedSteps = max(0, steps)
    val clampedValue = value.coerceIn(valueRange.start, valueRange.endInclusive)
    var out = semantics(mergeDescendants = mergeDescendants) {
        progressBarRangeInfo = ProgressBarRangeInfo(clampedValue, valueRange, normalizedSteps)
        if (!contentDescription.isNullOrEmpty()) this.contentDescription = contentDescription
        if (!stateDescription.isNullOrEmpty()) this.stateDescription = stateDescription
        if (!enabled) disabled()
        if (enabled) {
            setProgress { target ->
                onSetProgress(target.coerceIn(valueRange.start, valueRange.endInclusive))
            }
        }
    }
    if (enabled) {
        out = out
            .onKeyEvent { event ->
                val direction = event.adjustmentDirection() ?: return@onKeyEvent false
                if (event.type == KeyEventType.KeyDown) {
                    onSetProgress(
                        accessibilityAdjustedValue(
                            current = clampedValue,
                            range = valueRange,
                            steps = normalizedSteps,
                            direction = direction,
                        ),
                    )
                }
                true
            }
            .focusable()
    }
    return out
}

/** Standard accessibility dismiss action for a gesture-dismissable surface. */
internal fun Modifier.dsxAccessibleDismiss(onDismiss: () -> Unit): Modifier =
    semantics {
        dismiss {
            onDismiss()
            true
        }
    }

internal fun accessibilityAdjustedValue(
    current: Float,
    range: ClosedFloatingPointRange<Float>,
    steps: Int,
    direction: Int,
): Float {
    val start = range.start
    val end = range.endInclusive
    val span = end - start
    if (span <= 0f || !span.isFinite() || direction == 0) return current.coerceIn(start, end)
    val increment = if (steps > 0) span / (steps + 1) else span / 20f
    return (current + increment * direction.coerceIn(-1, 1)).coerceIn(start, end)
}

/** Compose counts only the discrete values between the two endpoints. */
internal fun accessibilityStepsForIncrement(start: Double, end: Double, increment: Double?): Int {
    val span = end - start
    if (increment == null || !increment.isFinite() || increment <= 0.0 ||
        !span.isFinite() || span <= 0.0
    ) return 0
    return ((span / increment).roundToInt() - 1).coerceAtLeast(0)
}

private fun KeyEvent.isActivationKey(): Boolean =
    key == Key.Enter || key == Key.NumPadEnter || key == Key.Spacebar || key == Key.DirectionCenter

private fun KeyEvent.adjustmentDirection(): Int? = when (key) {
    Key.DirectionRight, Key.DirectionUp -> 1
    Key.DirectionLeft, Key.DirectionDown -> -1
    else -> null
}
