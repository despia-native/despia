//
//  StepperElements.kt — `<stepper bind="qty" min="1" max="9" step="1"/>` (Kotlin twin of
//  Stepper.swift). ± a bound number, clamped to `min` (0) … `max` (100) by `step` (1);
//  optional `label` on the leading side, control trailing (the SwiftUI Stepper layout).
//  Every write goes through the bind seam (`on:change` from the engine, actual change
//  only). Range guard mirrors Swift: the upper bound is `max(hi, lo + step)`.
//
//  UNSTYLED (M3-batch2b) → an M3 stepper: two `FilledTonalIconButton`s (Material `remove`
//  / `add` glyphs, real M3 tonal buttons) with the current VALUE between them, honoring
//  min/max/step (a button disables at its clamp edge). `color` (if authored) rides as the
//  button container tint; unauthored takes the M3 tonal default (SelectionControl.STEPPER).
//  ANY authored look ejects to the LEGACY chrome (below), byte-identical.
//
//  DIVERGENCES (M3 path, none silent): (1) Material 3 ships NO stepper component, so the
//  M3 path COMPOSES one from M3 icon buttons per the task — a declared build, not a
//  platform primitive. (2) The M3 stepper SHOWS the current value between the ± buttons (a
//  Material quantity-stepper affordance); iOS's UIStepper and the legacy chrome show only
//  ± . Both are out of the parity spec (empty `geometry` — the OS's own metrics); the
//  fixture describes the LEGACY path, which stays byte-identical, so no fixture/spec change.
//
//  LEGACY CHROME: SwiftUI renders the system UIStepper (a 94×32 two-segment rounded
//  control on the iOS `fill` tint). Compose has no system stepper — the legacy path draws
//  that exact chrome itself: 94×32, radius 8, `fill` background, a 1dp separator divider,
//  − / + glyphs (label color; dimmed 35% at the clamp edge). `color` (default accent) is
//  accepted like iOS's `.tint(...)` (which leaves the gray UIStepper look untouched) —
//  read but not painted, so both platforms show the same control.
//

package despia.engine.render.elements

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleActivation

internal fun registerStepperElements() {
    ComposeStackComponents.defineNative("stepper") { ctx -> StepperView(ctx) }
}

@Composable
private fun StepperView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.STEPPER)) M3StepperView(ctx)
    else LegacyStepperView(ctx)
}

/// The unstyled stepper's system rendering: two M3 `FilledTonalIconButton`s (Material
/// remove/add glyphs) with the current value between them, over the SAME bind seam and the
/// SAME clamp/range guard as the legacy chrome. `color` (if authored) rides as the button
/// container tint; unauthored takes the M3 tonal default. See header for the two pinned
/// divergences (M3 ships no stepper; the value is shown).
@Composable
private fun M3StepperView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val lo = ctx.num("min") ?: ElementDefaults.STEPPER_MIN
    val hi = ctx.num("max") ?: ElementDefaults.STEPPER_MAX
    val step = ctx.num("step") ?: ElementDefaults.STEPPER_STEP
    val upper = maxOf(hi, lo + step)                              // the Swift range guard
    val value = JSE.number(ctl.boundValue(key)) ?: lo
    val label = ctx.str("label")
    // disabled= / disabled-if= (W9): forces both halves beyond the clamp guard
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val authored = ctl.interp("color")
    val colors = if (authored.isNullOrEmpty()) IconButtonDefaults.filledTonalIconButtonColors()
                 else IconButtonDefaults.filledTonalIconButtonColors(
                     containerColor = StackStyle.color(authored), contentColor = Color.White)
    // Integer values read as `3`, not `3.0` (a Material quantity readout).
    val valueText = if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()

    Row(Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth()),
        verticalAlignment = Alignment.CenterVertically) {
        if (label.isNotEmpty()) {
            Text(label)
        }
        Spacer(Modifier.weight(1f))
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            FilledTonalIconButton(
                onClick = { ctl.setBound(key, (value - step).coerceIn(lo, upper)) },  // on:change from the seam
                enabled = !disabled && value - step >= lo - 1e-9,
                colors = colors,
            ) { StackIcon("minus", 20.0, LocalContentColor.current) }   // M3-path glyph size (out of parity spec)
            Box(Modifier.widthIn(min = 24.dp), contentAlignment = Alignment.Center) { Text(valueText) }
            FilledTonalIconButton(
                onClick = { ctl.setBound(key, (value + step).coerceIn(lo, upper)) },
                enabled = !disabled && value + step <= upper + 1e-9,
                colors = colors,
            ) { StackIcon("plus", 20.0, LocalContentColor.current) }   // M3-path glyph size (out of parity spec)
        }
    }
}

// MARK: - stepper (legacy — the byte-identical UIStepper chrome, ElementSpec-pinned)

@Composable
private fun LegacyStepperView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val lo = ctx.num("min") ?: ElementDefaults.STEPPER_MIN
    val hi = ctx.num("max") ?: ElementDefaults.STEPPER_MAX
    val step = ctx.num("step") ?: ElementDefaults.STEPPER_STEP
    val upper = maxOf(hi, lo + step)                              // the Swift range guard
    val value = JSE.number(ctl.boundValue(key)) ?: lo
    val label = ctx.str("label")
    // disabled= / disabled-if= (W9): forces both halves beyond the clamp guard
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    ctx.str("color", ElementDefaults.STEPPER_TINT)                // accepted like iOS .tint — see header

    Row(Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth()),
        verticalAlignment = Alignment.CenterVertically) {
        if (label.isNotEmpty()) {
            BasicText(label, style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item,
                                                          StackStyle.color("label")))
        }
        Spacer(Modifier.weight(1f))
        Row(Modifier.size(94.dp, 32.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(StackStyle.color("fill"))) {
            StepButton(
                "−",
                description = DSXStrings.localize("Decrease"),
                enabled = !disabled && value - step >= lo - 1e-9,
                modifier = Modifier.weight(1f),
            ) {
                ctl.setBound(key, (value - step).coerceIn(lo, upper))   // on:change from the write seam
            }
            Box(Modifier.width(1.dp).fillMaxHeight().padding(vertical = 6.dp)
                    .background(StackStyle.color("separator")))
            StepButton(
                "+",
                description = DSXStrings.localize("Increase"),
                enabled = !disabled && value + step <= upper + 1e-9,
                modifier = Modifier.weight(1f),
            ) {
                ctl.setBound(key, (value + step).coerceIn(lo, upper))
            }
        }
    }
}

@Composable
private fun StepButton(
    glyph: String,
    description: String,
    enabled: Boolean,
    modifier: Modifier,
    tap: () -> Unit,
) {
    Box(modifier.fillMaxHeight()
        .dsxAccessibleActivation(
            enabled = enabled,
            role = Role.Button,
            contentDescription = description,
            onClick = tap,
        )
        .pointerInput(enabled) { detectTapGestures { if (enabled) tap() } },
        contentAlignment = Alignment.Center) {
        BasicText(glyph, style = TextStyle(
            color = StackStyle.color("label").copy(alpha = if (enabled) 1f else 0.35f),
            fontSize = 17.sp, fontWeight = StackStyle.weight("medium")))
    }
}
