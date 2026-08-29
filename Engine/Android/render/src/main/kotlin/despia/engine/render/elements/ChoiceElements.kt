//
//  ChoiceElements.kt — the tap-to-choose family, three Kotlin twins:
//
//  `<Checkbox/>` (Checkbox.swift — Capitalized native global, EXACTLY the iOS tag; the
//  Android-only lowercase `checkbox` alias was DROPPED for 1:1 parity — Checkbox.swift
//  declares no aliases, so neither does Android): a labeled checkbox bound to a Bool.
//  UNSTYLED (M3-batch2b) → the REAL Material 3 `Checkbox` in a `toggleable` row with the
//  label; `color` rides as `CheckboxDefaults.checkedColor` (iOS keeps the checked tint ON
//  the control — SelectionControl.CHECKBOX). ANY authored look ejects to the LEGACY custom
//  drawing (below), byte-identical: SF `checkmark.square.fill` / `square` through the
//  sf-map ladder, checked tint `color` (default accent), unchecked `secondary`; HStack
//  spacing 8; tapping toggles through the bind seam (`on:change` from the engine, never here).
//
//  `<RadioGroup/>` (RadioGroup.swift): a vertical single-select list bound to one String.
//  Options = the Picker grammar (CSV or optionsKey + valueField/labelField). UNSTYLED
//  (M3-batch2b) → REAL Material 3 `RadioButton` rows in a `selectableGroup` column, each a
//  `selectable` row of the M3 radio + its label; `color` rides as
//  `RadioButtonDefaults.selectedColor` (SelectionControl.RADIOGROUP). ANY authored look
//  ejects to the LEGACY drawing (below), byte-identical: VStack leading spacing 12; each
//  row HStack spacing 10 of SF `largecircle.fill.circle`/`circle` (selected tint `color`
//  default accent, else secondary) + the label (primary) + Spacer; tapping a row writes
//  the option's VALUE through the seam.
//
//  DIVERGENCE (M3 path, none silent): the M3 Checkbox/RadioButton own their platform
//  metrics/tick-glyphs and default (unauthored) M3 primary tint where iOS uses the SF glyph
//  at the `accent` default — the "unstyled baseline IS the platform" law. The fixture
//  describes the LEGACY path, which stays byte-identical, so no fixture/spec change (the
//  segmentedButton/combobox precedent).
//
//  `<segmentedButton>` (SegmentedButton.swift): Material-style connected MULTI-select, on
//  the system-defaults ladder (system-defaults.md; the M3-identity wave — SelectionSystem.kt).
//  `options` CSV (+ optional parallel `icons` CSV of SF names); the selection is a CSV in
//  the bound var; `multiple` default true (`"false"` = single-select, tapping the current
//  selection clears). UNSTYLED → the REAL Material 3 `MultiChoiceSegmentedButtonRow`
//  (`multiple`) / `SingleChoiceSegmentedButtonRow` (`multiple="false"`) of `SegmentedButton`s;
//  `color` rides as the active-segment tint (iOS's selected fill — SegmentedButton.swift:29,76,
//  so it is system-safe, `SelectionControl.SEGMENTED_BUTTON`), white content on the fill;
//  an authored `icons[i]` fills the M3 icon slot, else the M3 selection checkmark shows.
//  ANY authored look ejects to the LEGACY custom row (below), byte-identical: font 15 medium,
//  equal widths, vertical padding 9, selected = white on `color` (default accent) else
//  label-on-clear; 1dp separator dividers; the whole control clipped radius 10 with a 1dp
//  separator stroke — the geometry/colors the parity fixture pins (ElementSpec segmentedButton).
//
//  DIVERGENCES (M3 path, none silent): the M3 row is content-width (it forces
//  `width(IntrinsicSize.Min)`) where the legacy row stretched full-width; the M3 selection
//  checkmark shows on icon-less segments (the platform multi-select affordance) where iOS
//  relies on the fill alone. M3-path metrics/colors are the OS's own (out of the parity spec;
//  the fixture describes the LEGACY row, which stays byte-identical — the combobox precedent).
//

package despia.engine.render.elements

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MultiChoiceSegmentedButtonRow
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonColors
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleSelectable
import despia.engine.render.dsxAccessibleToggle

internal fun registerChoiceElements() {
    ComposeStackComponents.defineNative("Checkbox") { ctx -> CheckboxView(ctx) }
    ComposeStackComponents.defineNative("RadioGroup") { ctx -> RadioGroupView(ctx) }
    ComposeStackComponents.defineNative("segmentedButton") { ctx -> SegmentedButtonView(ctx) }
}

// MARK: - Checkbox (system-defaults gate: unstyled → M3, authored look → legacy)

@Composable
private fun CheckboxView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.CHECKBOX)) M3CheckboxView(ctx)
    else LegacyCheckboxView(ctx)
}

/// The unstyled checkbox's system rendering: the REAL M3 `Checkbox` in a `toggleable` row
/// over the SAME bind seam. `color` (if authored) rides as the checked tint; unauthored
/// takes the M3 default (primary). One merged toggle semantics node (M3 labeled-checkbox).
@Composable
private fun M3CheckboxView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val current = JSE.truthy(ctl.boundValue(key))                 // reactive read → re-renders on flip
    val label = ctx.str("label")
    // disabled= / disabled-if= (W9): the M3 component's own enabled seam carries it
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val authored = ctl.interp("color")
    val colors = if (authored.isNullOrEmpty()) CheckboxDefaults.colors()
                 else CheckboxDefaults.colors(checkedColor = StackStyle.color(authored))
    Row(
        Modifier.elementModifier(ctx).then(
            if (key.isEmpty()) Modifier
            else Modifier.toggleable(value = current, enabled = !disabled, role = Role.Checkbox,
                                     onValueChange = { ctl.setBound(key, it) }),  // on:change from the write seam
        ),
        horizontalArrangement = Arrangement.spacedBy(ElementDefaults.CHECKBOX_SPACING.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = current, onCheckedChange = null, enabled = !disabled, colors = colors)  // row owns the click
        if (label.isNotEmpty()) Text(label)
    }
}

// MARK: - Checkbox (legacy — the byte-identical custom drawing, ElementSpec-pinned)

@Composable
private fun LegacyCheckboxView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val current = JSE.truthy(ctl.boundValue(key))                 // reactive read → re-renders on flip
    val accent = StackStyle.color(ctx.str("color", ElementDefaults.CHECKBOX_CHECKED))
    val label = ctx.str("label")
    val toggle = { value: Boolean -> ctl.setBound(key, value) }
    Row(
        Modifier.elementModifier(ctx).then(
            Modifier
                .dsxAccessibleToggle(
                    value = current,
                    enabled = key.isNotEmpty(),
                    role = Role.Checkbox,
                    onToggle = toggle,
                )
                .pointerInput(key, current) {
                    detectTapGestures { toggle(!current) }        // on:change from the write seam
                },
        ),
        horizontalArrangement = Arrangement.spacedBy(ElementDefaults.CHECKBOX_SPACING.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StackIcon(if (current) "checkmark.square.fill" else "square", 20.0,
                  if (current) accent else StackStyle.color(ElementDefaults.CHECKBOX_UNCHECKED))
        if (label.isNotEmpty()) {
            BasicText(label, style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item,
                                                          StackStyle.color("label")))
        }
    }
}

// MARK: - RadioGroup (system-defaults gate: unstyled → M3, authored look → legacy)

@Composable
private fun RadioGroupView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.RADIOGROUP)) M3RadioGroupView(ctx)
    else LegacyRadioGroupView(ctx)
}

/// The unstyled radio group's system rendering: REAL M3 `RadioButton` rows in a
/// `selectableGroup` column, each a `selectable` row over the SAME options grammar + bind
/// seam. `color` (if authored) rides as the selected tint; unauthored takes the M3 default.
@Composable
private fun M3RadioGroupView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val opts = ctx.resolveOptions()
    val selected = JSE.string(ctl.boundValue(key))
    // disabled= / disabled-if= (W9): the M3 component's own enabled seam carries it
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val authored = ctl.interp("color")
    val colors = if (authored.isNullOrEmpty()) RadioButtonDefaults.colors()
                 else RadioButtonDefaults.colors(selectedColor = StackStyle.color(authored))
    Column(Modifier.elementModifier(ctx).selectableGroup(),
           verticalArrangement = Arrangement.spacedBy(ElementDefaults.RADIO_ROW_SPACING.dp),
           horizontalAlignment = Alignment.Start) {
        for ((id, label) in opts) {
            val isOn = selected == id
            Row(
                Modifier.fillMaxWidth().then(
                    if (key.isEmpty()) Modifier
                    else Modifier.selectable(selected = isOn, enabled = !disabled, role = Role.RadioButton,
                                             onClick = { ctl.setBound(key, id) }),  // on:change from the write seam
                ),
                horizontalArrangement = Arrangement.spacedBy(ElementDefaults.RADIO_MARK_SPACING.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = isOn, onClick = null, enabled = !disabled, colors = colors)  // row owns the click
                if (label.isNotEmpty()) Text(label)
            }
        }
    }
}

// MARK: - RadioGroup (legacy — the byte-identical custom drawing, ElementSpec-pinned)

@Composable
private fun LegacyRadioGroupView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val opts = ctx.resolveOptions()
    val selected = JSE.string(ctl.boundValue(key))
    val accent = StackStyle.color(ctx.str("color", ElementDefaults.RADIO_SELECTED))
    Column(Modifier.elementModifier(ctx).selectableGroup(),
           verticalArrangement = Arrangement.spacedBy(ElementDefaults.RADIO_ROW_SPACING.dp),
           horizontalAlignment = Alignment.Start) {
        for ((id, label) in opts) {
            val isOn = selected == id
            val select = { ctl.setBound(key, id) }
            Row(
                Modifier.fillMaxWidth()
                    .dsxAccessibleSelectable(
                        selected = isOn,
                        enabled = key.isNotEmpty(),
                        role = Role.RadioButton,
                        onSelect = select,
                    )
                    .pointerInput(key, id) {
                        detectTapGestures { select() }            // on:change from the write seam
                    },
                horizontalArrangement = Arrangement.spacedBy(ElementDefaults.RADIO_MARK_SPACING.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StackIcon(if (isOn) "largecircle.fill.circle" else "circle", 20.0,
                          if (isOn) accent else StackStyle.color(ElementDefaults.RADIO_UNSELECTED))
                BasicText(label, style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item,
                                                              StackStyle.color("label")))
                Spacer(Modifier.weight(1f))
            }
        }
    }
}

// MARK: - segmentedButton (system-defaults gate: unstyled → M3, authored look → legacy)

@Composable
private fun SegmentedButtonView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.SEGMENTED_BUTTON))
        M3SegmentedButtonView(ctx)          // unstyled → real M3 segmented row (color rides as tint)
    else
        LegacySegmentedButtonView(ctx)      // authored look → the byte-identical custom row
}

// MARK: - segmentedButton (system — the real M3 Multi/SingleChoiceSegmentedButtonRow)

/// The unstyled multi-select's system rendering: a real M3 segmented row over the SAME CSV
/// bind seam as the legacy row (ElementMath.segmentedToggle — multi flips within the CSV,
/// single replaces). `color` rides as the active-container/border tint with white content
/// (the iOS selected-fill contract, SegmentedButton.swift); an authored `icons[i]` fills the
/// M3 icon slot, else M3's selection checkmark. Metrics/colors are the M3 component's own.
@Composable
private fun M3SegmentedButtonView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val multiple = (ctx.attrs["multiple"] ?: "true") != "false"
    val ids = ElementMath.csv(ctx.str("options"))
    val icons = ctx.str("icons").split(",").map { it.trim() }         // parallel — may carry blanks
    val selected = ElementMath.csv(JSE.string(ctl.boundValue(key))).toSet()
    // disabled= / disabled-if= (W9): the M3 component's own enabled seam carries it
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val colors = m3SegmentedButtonColors(ctl.interp("color"))         // authored color rides as the active tint
    val toggle = { id: String ->
        if (key.isNotEmpty())
            ctl.setBound(key, ElementMath.segmentedToggle(JSE.string(ctl.boundValue(key)), id, ids, multiple))
    }
    // No fillMaxWidth: the M3 rows force `width(IntrinsicSize.Min)` — content-width (header
    // divergence). The icon slot: an authored SF symbol, else M3's own selection checkmark.
    if (multiple) {
        MultiChoiceSegmentedButtonRow(Modifier.elementModifier(ctx)) {
            ids.forEachIndexed { i, id ->
                SegmentedButton(
                    checked = id in selected,
                    onCheckedChange = { toggle(id) },
                    enabled = !disabled,
                    shape = SegmentedButtonDefaults.itemShape(index = i, count = ids.size),
                    colors = colors,
                    icon = { SegmentIcon(icons.getOrNull(i), id in selected) },
                ) { Text(id) }
            }
        }
    } else {
        SingleChoiceSegmentedButtonRow(Modifier.elementModifier(ctx)) {
            ids.forEachIndexed { i, id ->
                SegmentedButton(
                    selected = id in selected,
                    onClick = { toggle(id) },
                    enabled = !disabled,
                    shape = SegmentedButtonDefaults.itemShape(index = i, count = ids.size),
                    colors = colors,
                    icon = { SegmentIcon(icons.getOrNull(i), id in selected) },
                ) { Text(id) }
            }
        }
    }
}

/// The M3 segmented-button colors: uncolored rides the M3 defaults (the ambient
/// MaterialTheme stamped by DespiaSystemTheme — the picker DropdownMenu precedent); an
/// authored `color` tints the active container + border with white content (iOS's
/// selected-fill / white-text contract, SegmentedButton.swift:73,76).
@Composable
private fun m3SegmentedButtonColors(authored: String?): SegmentedButtonColors {
    if (authored.isNullOrEmpty()) return SegmentedButtonDefaults.colors()
    val tint = StackStyle.color(authored)
    return SegmentedButtonDefaults.colors(
        activeContainerColor = tint,
        activeContentColor = Color.White,
        activeBorderColor = tint,
    )
}

/// One segment's icon slot: an authored SF symbol (StackIcon at the current content color)
/// when present, else M3's own selection checkmark (SegmentedButtonDefaults.Icon).
@Composable
private fun SegmentIcon(icon: String?, active: Boolean) {
    if (!icon.isNullOrEmpty()) StackIcon(icon, ElementDefaults.SEG_FONT, LocalContentColor.current)
    else SegmentedButtonDefaults.Icon(active)
}

// MARK: - segmentedButton (legacy — the byte-identical custom row, ElementSpec-pinned)

/// The control-state crossfade — the iOS twin's `.easeInOut(duration: 0.15)` MotionGate
/// convention (SegmentedButton.swift selection, OTP.swift active box; the real `.segmented`
/// picker's platter animates too). Shared by the segmented arms (this row +
/// PlainPickerElements' pill) and the OTP boxes so the motion cannot drift — the
/// animated-system-control rule (system-defaults.md 2026-08-20).
internal const val CONTROL_SELECTION_MOTION_MS = 150

@Composable
private fun LegacySegmentedButtonView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val multiple = (ctx.attrs["multiple"] ?: "true") != "false"
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.SEG_TINT))
    val ids = ElementMath.csv(ctx.str("options"))
    val icons = ctx.str("icons").split(",").map { it.trim() }     // parallel — may carry blanks
    val selected = ElementMath.csv(JSE.string(ctl.boundValue(key))).toSet()
    // disabled= / disabled-if= (W9): the segments' activation seams gate
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val separator = StackStyle.color(ElementDefaults.SEG_BORDER_COLOR)

    Row(
        Modifier.elementModifier(ctx)
            .then(Modifier.height(IntrinsicSize.Min)
                .selectableGroup()
                .clip(RoundedCornerShape(ElementDefaults.SEG_RADIUS.dp))
                .border(ElementDefaults.SEG_BORDER.dp, separator, RoundedCornerShape(ElementDefaults.SEG_RADIUS.dp))),
    ) {
        for ((i, id) in ids.withIndex()) {
            val isOn = id in selected
            if (i > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(separator))
            val choose = {
                if (!disabled) ctl.setBound(key, ElementMath.segmentedToggle(
                    JSE.string(ctl.boundValue(key)), id, ids, multiple))
            }
            // The active fill crossfades — the iOS twin's MotionGate 0.15 (SEG_SELECTION_MOTION_MS).
            val fill by animateColorAsState(if (isOn) tint else Color.Transparent,
                                            tween(CONTROL_SELECTION_MOTION_MS), label = "dsx-seg-fill")
            var segmentModifier = Modifier.weight(1f)
                .background(fill)
            segmentModifier = if (multiple) {
                segmentModifier.dsxAccessibleToggle(
                    value = isOn,
                    enabled = key.isNotEmpty() && !disabled,
                    role = Role.Checkbox,
                    onToggle = { choose() },
                )
            } else {
                segmentModifier.dsxAccessibleSelectable(
                    selected = isOn,
                    enabled = key.isNotEmpty() && !disabled,
                    role = Role.RadioButton,
                    onSelect = choose,
                )
            }
            Row(
                segmentModifier
                    .pointerInput(key, id, multiple, selected) {
                        detectTapGestures { choose() }
                    }
                    .padding(vertical = ElementDefaults.SEG_PAD_V.dp),
                horizontalArrangement = Arrangement.spacedBy(ElementDefaults.SEG_ICON_SPACING.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val textColor = if (isOn) StackStyle.color(ElementDefaults.SEG_SELECTED_TEXT)
                                else StackStyle.color(ElementDefaults.SEG_UNSELECTED_TEXT)
                if (i < icons.size && icons[i].isNotEmpty()) StackIcon(icons[i], ElementDefaults.SEG_FONT, textColor)
                BasicText(id, style = TextStyle(color = textColor, fontSize = ElementDefaults.SEG_FONT.sp,
                                                fontWeight = StackStyle.weight("medium")))
            }
        }
    }
}
