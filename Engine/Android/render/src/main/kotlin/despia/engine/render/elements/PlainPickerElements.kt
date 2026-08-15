//
//  PlainPickerElements.kt — the `<picker>` (menu) / `<segmented>` (segmented control)
//  tags, Kotlin twins of Foundation Basics/Picker/Picker.swift (ONE builder, a
//  `segmented:` flag — mirrored here as PickerTagView(ctx, segmented)). A two-way String
//  selection bound to a store var or row field; the bound var holds the selected VALUE.
//
//  RECONCILE (no duplication): the option grammar is the SHARED `resolveOptions()` seam
//  (Elements.kt) that wheelpicker/combobox/RadioGroup already ride — CSV `options=` or a
//  bound list via `optionsKey` + `valueField`/`labelField` (default id/label), including
//  the ROW-AWARE `optionsKey` read the iOS fix added (Picker.swift:17-22 —
//  `dsx.list("optionsKey")` evals with the current row item, so `optionsKey="item.options"`
//  inside a <list> row template resolves the ROW's list; resolveOptions → bindList carries
//  `item` the same way). The existing `wheelpicker`/`combobox` (PickerElements.kt) and
//  `segmentedButton` (ChoiceElements.kt — the Material-style MULTI-select with its own CSV
//  selection grammar) are DIFFERENT elements with their own iOS twins; nothing here
//  replaces or forwards to them. Selection writes ride the ONE bind seam (`setBound` —
//  on:change from the engine, on actual change only, Picker.swift:28).
//
//  <picker> — SwiftUI `.pickerStyle(.menu)` (Picker.swift:34), on the system-defaults
//  ladder (system-defaults.md; the StackSystemControls.kt philosophy). The closed trigger
//  shows the selected option's LABEL in `color` tint (default accent) + the
//  `chevron.up.chevron.down` glyph — the FieldPicker precedent (Forms.kt, Field.swift's
//  `type="picker"`); no matching option → an empty trigger, like SwiftUI. UNSTYLED → tap
//  opens the REAL Material 3 `DropdownMenu` (M3 surface/elevation/shape/ripple) of
//  `DropdownMenuItem`s, a trailing tint checkmark on the selection; a pick writes the
//  option VALUE through `bind`. `color` rides the trigger/check as the tint (the iOS
//  `.tint` contract). ANY authored look ejects to the LEGACY UIMenu-metric platter
//  (`SelectionControl.rendersSystem` — SelectionSystem.kt): width 250, radius 13, regular
//  material, 16×12 rows, 0.5 hairlines (the Menus.kt numbers), byte-identical to the
//  pre-M3 rendering.  (`<segmented>` is a DIFFERENT wave's element — unchanged here.)
//
//  <segmented> — `.pickerStyle(.segmented)` (Picker.swift:33): SINGLE-select (re-tapping
//  the selection is a no-op — the seam's actual-change guard; unlike segmentedButton's
//  clear-on-reselect). On the system-defaults ladder (system-defaults.md; the M3-identity
//  wave — SelectionSystem.kt). UNSTYLED → the REAL Material 3 `SingleChoiceSegmentedButtonRow`
//  of `SegmentedButton`s (M3 shape/elevation/ripple + its own selection checkmark, the
//  platform's own segmented look — iOS renders the native UISegmentedControl, this renders
//  Android's native segmented). A pick writes the option VALUE through `bind`. ANY authored
//  look — OR an authored `color=` (iOS ignores color on .segmented, Picker.swift:34, so it
//  is NOT a system-safe word: `SelectionControl.SEGMENTED`) — ejects to the LEGACY
//  UISegmentedControl-approximation pill (PlainWaveDefaults SEG_CONTROL_*): 32dp track,
//  radius 9, `fill` background, 2dp inset, equal-width segments, 13sp medium labels, #636366
//  selected platter — byte-identical to the pre-M3 rendering.
//
//  ── PINNED DIVERGENCES (none silent) ────────────────────────────────────────────────
//  • `label` is accepted but not displayed by either style — SwiftUI's own behavior for
//    .menu/.segmented pickers outside a Form (the wheelpicker precedent).
//  • The M3 path shows M3's own selection checkmark (SegmentedButtonDefaults.Icon) — the
//    honest Android segmented affordance; iOS's UISegmentedControl uses a selected platter
//    with no checkmark. Metrics/colors on the M3 path are the OS's own (out of the parity
//    spec — the segmented fixture pins no geometry/colors, ElementSpec rule 4). The legacy
//    pill keeps the pinned approximation (inter-segment separators still omitted there).
//  • FOOTPRINT: the M3 `SingleChoiceSegmentedButtonRow` is content-width (it forces
//    `width(IntrinsicSize.Min)` internally), where the legacy pill stretched full-width. An
//    author wanting full-width authors a width/grow attr — not a system-safe word, so it
//    ejects to the legacy full-width pill (the inert-landing invariant carries the intent).
//

package despia.engine.render.elements

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import despia.engine.JSE
import despia.engine.render.BoundControl
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.PlainWaveDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleActivation
import despia.engine.render.dsxAccessibleSelectable

internal fun registerPlainPickerElements() {
    ComposeStackComponents.defineNative("picker") { ctx -> PickerTagView(ctx, segmented = false) }
    ComposeStackComponents.defineNative("segmented") { ctx -> PickerTagView(ctx, segmented = true) }
}

/// The closed menu trigger's text: the selected option's LABEL, or "" when the bound
/// value matches no option (SwiftUI shows an empty .menu trigger — no placeholder attr).
internal fun pickerSelectedLabel(opts: List<Pair<String, String>>, selected: String): String =
    opts.firstOrNull { it.first == selected }?.second ?: ""

/// Picker.swift's `make(_:segmented:)` twin — one body, two styles.
@Composable
private fun PickerTagView(ctx: ComposeStackComponentContext, segmented: Boolean) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val opts = ctx.resolveOptions()   // the shared, row-aware Picker grammar (see header)
    val selected = JSE.string(ctl.boundValue(key))
    when {
        segmented && SelectionControl.rendersSystem(ctx.attrs, SelectionControl.SEGMENTED) ->
            M3SegmentedView(ctx, ctl, key, opts, selected)                 // unstyled → real M3 segmented row
        segmented -> SegmentedControlView(ctx, ctl, key, opts, selected)   // authored look / color → legacy pill
        SelectionControl.rendersSystem(ctx.attrs, SelectionControl.PICKER) ->
            M3PickerMenuView(ctx, ctl, key, opts, selected)                // unstyled → real M3 DropdownMenu
        else -> PickerMenuView(ctx, ctl, key, opts, selected)             // authored look → legacy platter
    }
}

// MARK: - <segmented> (system — the real M3 SingleChoiceSegmentedButtonRow)

/// The unstyled segmented control's system rendering: a real M3 `SingleChoiceSegmentedButtonRow`
/// of `SegmentedButton`s (M3 shape/ripple + its own selection checkmark). A pick writes the
/// option VALUE through the ONE bind seam; re-tapping the selection is the seam's no-op
/// (the actual-change guard), matching `.pickerStyle(.segmented)`. Colors/metrics are the
/// M3 component's own (the platform's segmented look — out of the parity spec, header rule).
@Composable
private fun M3SegmentedView(ctx: ComposeStackComponentContext, ctl: BoundControl,
                           key: String, opts: List<Pair<String, String>>, selected: String) {
    // No fillMaxWidth: `SingleChoiceSegmentedButtonRow` forces `width(IntrinsicSize.Min)`
    // internally, so the row is content-width — M3's own footprint (the header's pinned
    // divergence vs the legacy full-width pill; an authored width/grow ejects to legacy).
    SingleChoiceSegmentedButtonRow(Modifier.elementModifier(ctx)) {
        opts.forEachIndexed { i, (id, label) ->
            SegmentedButton(
                selected = id == selected,
                onClick = { if (key.isNotEmpty()) ctl.setBound(key, id) },   // write the VALUE; re-tap = seam no-op
                shape = SegmentedButtonDefaults.itemShape(index = i, count = opts.size),
            ) { Text(label) }
        }
    }
}

// MARK: - <segmented> (UISegmentedControl chrome — see header)

@Composable
private fun SegmentedControlView(ctx: ComposeStackComponentContext, ctl: BoundControl,
                                 key: String, opts: List<Pair<String, String>>, selected: String) {
    val d = PlainWaveDefaults
    Row(
        Modifier.elementModifier(ctx).then(
            Modifier.fillMaxWidth().height(d.SEG_CONTROL_HEIGHT.dp)
                .selectableGroup()
                .clip(RoundedCornerShape(d.SEG_CONTROL_RADIUS.dp))
                .background(StackStyle.color("fill"))
                .padding(d.SEG_CONTROL_PAD.dp)),
    ) {
        for ((id, label) in opts) {
            val isOn = id == selected
            val select = { if (key.isNotEmpty()) ctl.setBound(key, id) }
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .clip(RoundedCornerShape((d.SEG_CONTROL_RADIUS - d.SEG_CONTROL_PAD).dp))
                    .background(if (isOn) StackStyle.color(d.SEG_CONTROL_PLATTER) else Color.Transparent)
                    .dsxAccessibleSelectable(
                        selected = isOn,
                        enabled = key.isNotEmpty(),
                        role = Role.RadioButton,
                        onSelect = select,
                    )
                    .pointerInput(key, id) {
                        detectTapGestures { select() }               // seam no-ops a re-tap (actual-change guard)
                    },
                contentAlignment = Alignment.Center,
            ) {
                BasicText(label, style = TextStyle(color = StackStyle.color("label"),
                                                   fontSize = d.SEG_CONTROL_FONT.sp,
                                                   fontWeight = StackStyle.weight("medium")))
            }
        }
    }
}

// MARK: - <picker> (system — the real M3 DropdownMenu)

/// The unstyled picker's system rendering: the iOS-compact trigger (selected label + tint
/// chevron) opening a REAL M3 `DropdownMenu` of `DropdownMenuItem`s — M3 surface,
/// elevation, shape and ripple, a trailing tint checkmark on the selection. A pick writes
/// the option VALUE (never the label) through the ONE bind seam; `color` is the tint.
@Composable
private fun M3PickerMenuView(ctx: ComposeStackComponentContext, ctl: BoundControl,
                             key: String, opts: List<Pair<String, String>>, selected: String) {
    val d = PlainWaveDefaults
    val tint = StackStyle.color(ctx.str("color", d.PICKER_TINT))
    var open by remember { mutableStateOf(false) }
    Box(Modifier.elementModifier(ctx)) {
        Row(Modifier
            .dsxAccessibleActivation(role = Role.Button, onClick = { open = true })
            .pointerInput(Unit) { detectTapGestures { open = true } },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            BasicText(pickerSelectedLabel(opts, selected),
                      style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item, tint))
            StackIcon("chevron.up.chevron.down", d.PICKER_CHEVRON_SIZE, tint)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((id, label) in opts) {
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        if (key.isNotEmpty()) ctl.setBound(key, id)   // write the VALUE (not the label)
                        open = false
                    },
                    trailingIcon = if (id == selected) ({ StackIcon("checkmark", 14.0, tint) }) else null,
                )
            }
        }
    }
}

// MARK: - <picker> (.menu — the LEGACY UIMenu platter, FieldPicker/Menus.kt numbers)

@Composable
private fun PickerMenuView(ctx: ComposeStackComponentContext, ctl: BoundControl,
                           key: String, opts: List<Pair<String, String>>, selected: String) {
    val d = PlainWaveDefaults
    val tint = StackStyle.color(ctx.str("color", d.PICKER_TINT))   // menu tint (Picker.swift:31,34)
    var open by remember { mutableStateOf(false) }
    Box(Modifier.elementModifier(ctx)) {
        Row(Modifier
            .dsxAccessibleActivation(role = Role.Button, onClick = { open = true })
            .pointerInput(Unit) { detectTapGestures { open = true } },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            BasicText(pickerSelectedLabel(opts, selected),
                      style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item, tint))
            StackIcon("chevron.up.chevron.down", d.PICKER_CHEVRON_SIZE, tint)
        }
        if (open) {
            Popup(alignment = Alignment.TopStart, onDismissRequest = { open = false },
                  properties = PopupProperties(focusable = true)) {
                Column(Modifier.width(d.PICKER_MENU_WIDTH.dp)
                           .clip(RoundedCornerShape(d.PICKER_MENU_RADIUS.dp))
                           .background(StackStyle.material("regular"))
                           .selectableGroup()
                           .verticalScroll(rememberScrollState())) {
                    for ((i, opt) in opts.withIndex()) {
                        val (id, label) = opt
                        if (i > 0) Box(Modifier.fillMaxWidth().height(0.5.dp)
                                           .background(StackStyle.color("separator")))
                        val select = {
                            if (key.isNotEmpty()) ctl.setBound(key, id)   // write the VALUE (not the label)
                            open = false
                        }
                        Row(Modifier.fillMaxWidth()
                                .dsxAccessibleSelectable(
                                    selected = id == selected,
                                    enabled = key.isNotEmpty(),
                                    role = Role.RadioButton,
                                    onSelect = select,
                                )
                                .pointerInput(id) {
                                    detectTapGestures { select() }
                                }
                                .padding(horizontal = d.PICKER_ROW_PAD_H.dp, vertical = d.PICKER_ROW_PAD_V.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            BasicText(label, Modifier.weight(1f),
                                      style = TextStyle(color = StackStyle.color("label"), fontSize = 17.sp))
                            if (id == selected) StackIcon("checkmark", 14.0, tint)
                        }
                    }
                }
            }
        }
    }
}
