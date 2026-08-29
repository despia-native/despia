//
//  PickerElements.kt — the option-driven pickers, two Kotlin twins, each on the
//  system-defaults ladder (system-defaults.md; the StackSystemControls.kt philosophy):
//
//  `<combobox>` (Combobox.swift): a typeahead bound to a store var or row field (the query
//  IS the bound var). UNSTYLED → the REAL Material 3 `ExposedDropdownMenuBox`: an editable
//  M3 `TextField` anchor + a filtered `ExposedDropdownMenu`; each keystroke writes the
//  query through `bind` (on:change from the write seam), a row tap writes the option's
//  VALUE and fires `on:select`. `color` rides the field as its cursor/indicator tint (the
//  iOS `.tint` contract, the spinner/progress precedent). ANY authored look ejects to the
//  LEGACY card (`SelectionControl.rendersSystem` — SelectionSystem.kt), which stays
//  byte-identical to the pre-M3 rendering: a custom text field + a floating results card
//  (rows padded 12x10, hairline dividers at 50%, capped to 6 visible rows of 41,
//  regular-material background radius 12, black-18% shadow). The fixture/ElementSpec pin
//  the LEGACY card metrics — the M3 dropdown owns its own metrics (the M3 divergence).
//
//  `<wheelpicker>` (WheelPicker.swift): a two-way String selection rendered as a spinning
//  drum. DIVERGENCE (pinned, none silent): Material 3 ships NO wheel/drum picker — the
//  material3-android public composable set carries no rotary/wheel selector — so this tag
//  has NO M3 twin to switch into. The snapping LazyColumn drum is retained as the faithful
//  custom wheel, dressed in M3 TOKENS (the selection band rides the `fill` role →
//  surfaceContainerHighest, rows the `label` role → onSurface), and renders in every case
//  (styled or not — no gate). Chrome: the UIPickerView metrics — 216dp drum, 32dp rows, a
//  selection band (radius 8) behind the centre row; off-centre rows dim (the
//  wheel-curvature stand-in). A settled snap writes through the bind seam (`on:change`
//  from the engine); writing the bound var scrolls the drum. Like SwiftUI's `.wheel`,
//  `label` is accepted but not displayed and `color` has no prominent drum surface.
//
//  RECONCILE (no duplication): no Android module registers either tag (the iOS elements
//  live in the Foundation module's Components; Foundation has no android/ facet), so the
//  render-side twins OWN the tags — checked against every ComposeStackComponents.define*
//  call site, no duplicate.
//

package despia.engine.render.elements

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.NSNull
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleRange
import despia.engine.render.dsxAccessibleSelectable
import kotlin.math.abs
import kotlin.math.roundToInt

internal fun registerPickerElements() {
    ComposeStackComponents.defineNative("wheelpicker") { ctx -> WheelPickerView(ctx) }
    ComposeStackComponents.defineNative("combobox") { ctx -> ComboboxView(ctx) }
}

// MARK: - wheelpicker

private const val DRUM_HEIGHT = 216.0   // UIPickerView height — internal chrome
private const val ROW_HEIGHT = 32.0     // UIPickerView row height — internal chrome

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)   // rememberSnapFlingBehavior (stable-in-practice snap seam)
@Composable
private fun WheelPickerView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val opts = ctx.resolveOptions()
    if (opts.isEmpty()) return
    val selectedValue = JSE.string(ctl.boundValue(key))
    val boundIndex = opts.indexOfFirst { it.first == selectedValue }.coerceAtLeast(0)
    // disabled= / disabled-if= (W9): a disabled drum neither scrolls nor commits
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))

    val state = rememberLazyListState(initialFirstVisibleItemIndex = boundIndex)
    var interacted by remember { mutableStateOf(false) }
    // The row whose centre sits nearest the drum centre — the wheel's live selection.
    val centered by remember {
        derivedStateOf {
            val info = state.layoutInfo
            val center = (info.viewportStartOffset + info.viewportEndOffset) / 2
            info.visibleItemsInfo.minByOrNull { abs((it.offset + it.size / 2) - center) }?.index ?: 0
        }
    }
    // A settled user snap commits through the bind seam (never the resting initial row).
    LaunchedEffect(state.isScrollInProgress) {
        if (state.isScrollInProgress) { interacted = true; return@LaunchedEffect }
        if (interacted && key.isNotEmpty()) {
            val id = opts[centered.coerceIn(0, opts.size - 1)].first
            if (id != JSE.string(ctl.boundValue(key))) ctl.setBound(key, id)
        }
    }
    // Writing the bound var spins the drum (programmatic selection).
    LaunchedEffect(boundIndex, opts.size) {
        if (!state.isScrollInProgress && centered != boundIndex) state.scrollToItem(boundIndex)
    }

    // The drum, operable without the wheel gesture: TalkBack/Switch Access adjust it as a
    // range (setProgress → bind write → the drum spins via the boundIndex effect), arrow
    // keys ride the same seam; the spoken state is the selected option's label.
    val a11y = Modifier.dsxAccessibleRange(
        value = centered.coerceIn(0, opts.size - 1).toFloat(),
        valueRange = 0f..(opts.size - 1).toFloat(),
        steps = (opts.size - 2).coerceAtLeast(0),
        enabled = !disabled && key.isNotEmpty(),
        stateDescription = opts[centered.coerceIn(0, opts.size - 1)].second,
        onSetProgress = { target ->
            val id = opts[target.roundToInt().coerceIn(0, opts.size - 1)].first
            if (id == JSE.string(ctl.boundValue(key))) false else { ctl.setBound(key, id); true }
        },
    )
    Box(Modifier.elementModifier(ctx).then(a11y).then(Modifier.fillMaxWidth().height(DRUM_HEIGHT.dp))) {
        // The selection band behind the centre row (the UIPickerView highlight).
        Box(Modifier.fillMaxWidth().height(ROW_HEIGHT.dp).align(Alignment.Center)
                .padding(horizontal = 8.dp)
                .background(StackStyle.color("fill"), RoundedCornerShape(8.dp)))
        LazyColumn(
            state = state,
            flingBehavior = rememberSnapFlingBehavior(state),
            contentPadding = PaddingValues(vertical = ((DRUM_HEIGHT - ROW_HEIGHT) / 2).dp),
            modifier = Modifier.fillMaxWidth(),
            userScrollEnabled = !disabled,
        ) {
            items(count = opts.size, key = { it }) { i ->
                Box(Modifier.fillMaxWidth().height(ROW_HEIGHT.dp)
                        .alpha(if (i == centered) 1f else 0.4f),   // wheel-curvature dimming stand-in
                    contentAlignment = Alignment.Center) {
                    BasicText(opts[i].second,
                              style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item,
                                                           StackStyle.color("label")))
                }
            }
        }
    }
}

// MARK: - combobox (system: M3 ExposedDropdownMenuBox · legacy: the custom card)

private const val MAX_ROWS = ElementDefaults.COMBO_MAX_ROWS   // visible rows before the card scrolls (iOS)
private const val ROW_PX = ElementDefaults.COMBO_ROW_HEIGHT   // one result row's height (iOS maxHeight math)

/// Unstyled → the real M3 combobox; any authored look ejects to the legacy card (header).
@Composable
private fun ComboboxView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.COMBOBOX)) M3ComboboxView(ctx)
    else LegacyComboboxView(ctx)
}

/// combobox — the REAL Material 3 `ExposedDropdownMenuBox`: an editable field anchor + a
/// filtered dropdown. `bind` carries the query (write seam = on:change per edit); a pick
/// writes the option VALUE and fires on:select. `color` tints the field (the iOS `.tint`).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun M3ComboboxView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val opts = ctx.resolveOptions()
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.COMBO_TINT))
    val raw = ctl.boundValue(key)
    val needle = if (raw == null || raw == NSNull) "" else JSE.string(raw)
    val matches = if (needle.isEmpty()) emptyList()
                  else opts.filter { it.second.contains(needle, ignoreCase = true) }
    val ph = ctx.interp("placeholder")
    // disabled= / disabled-if= (W9): the M3 field's own enabled seam carries it
    val disabled = SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    var expanded by remember { mutableStateOf(false) }
    val open = expanded && !disabled && needle.isNotEmpty() && matches.isNotEmpty()

    ExposedDropdownMenuBox(
        expanded = open,
        onExpandedChange = { expanded = it },
        modifier = Modifier.elementModifier(ctx),
    ) {
        TextField(
            value = needle,
            onValueChange = {
                ctl.setBound(key, it)    // on:change from the write seam (each edit)
                expanded = true          // typing reopens a card a pick closed
            },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryEditable).fillMaxWidth(),
            enabled = !disabled,
            singleLine = true,
            placeholder = { if (ph != null) Text(ph) },
            colors = TextFieldDefaults.colors(cursorColor = tint, focusedIndicatorColor = tint),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { expanded = false }) {
            for ((id, label) in matches) {
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        ctl.setBound(key, id)   // write the VALUE (not the label)
                        ctl.fire("select")      // → on:select
                        expanded = false
                    },
                )
            }
        }
    }
}

// MARK: - combobox (legacy — the custom typeahead card, the styled-eject path)

/// The pre-M3 rendering, retained byte-identical for any authored-styling combobox
/// (Combobox.swift's card metrics — the fixture/ElementSpec pin these).
@Composable
private fun LegacyComboboxView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val opts = ctx.resolveOptions()
    val tint = StackStyle.color(ctx.str("color", ElementDefaults.COMBO_TINT))
    val raw = ctl.boundValue(key)
    val needle = if (raw == null || raw == NSNull) "" else JSE.string(raw)
    val matches = if (needle.isEmpty()) emptyList()
                  else opts.filter { it.second.contains(needle, ignoreCase = true) }

    var focused by remember { mutableStateOf(false) }
    var showResults by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val open = focused && showResults && needle.isNotEmpty() && matches.isNotEmpty()
    val textStyle = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item, StackStyle.color("label"))

    Column(Modifier.elementModifier(ctx), verticalArrangement = Arrangement.spacedBy(6.dp),
           horizontalAlignment = Alignment.Start) {
        BasicTextField(
            value = needle,
            onValueChange = {
                ctl.setBound(key, it)          // on:change from the write seam (each edit)
                showResults = true             // typing reopens a card that a pick closed
            },
            modifier = Modifier.fillMaxWidth().onFocusChanged {
                focused = it.isFocused
                if (!it.isFocused) showResults = false
            },
            enabled = !SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if")),   // W9
            textStyle = textStyle,
            singleLine = true,
            cursorBrush = SolidColor(tint),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (needle.isEmpty()) ctx.interp("placeholder")?.let {
                        BasicText(it, style = textStyle.copy(color = textStyle.color.copy(alpha = 0.3f)))
                    }
                    inner()
                }
            },
        )
        if (open) {
            Column(
                Modifier.fillMaxWidth()
                    .heightIn(max = (minOf(matches.size, MAX_ROWS) * ROW_PX).dp)
                    .shadow(10.dp, RoundedCornerShape(ElementDefaults.COMBO_RADIUS.dp), clip = false,
                            ambientColor = Color.Black.copy(alpha = 0.18f),
                            spotColor = Color.Black.copy(alpha = 0.18f))
                    .background(StackStyle.material("regular"), RoundedCornerShape(ElementDefaults.COMBO_RADIUS.dp))
                    .clip(RoundedCornerShape(ElementDefaults.COMBO_RADIUS.dp))
                    .selectableGroup()
                    .verticalScroll(rememberScrollState()),
            ) {
                for ((i, match) in matches.withIndex()) {
                    val (id, label) = match
                    val select = {
                        ctl.setBound(key, id)      // write the VALUE (not the label)
                        ctl.fire("select")         // → on:select
                        showResults = false
                        focusManager.clearFocus()  // resign → dismiss keyboard + card
                    }
                    Box(Modifier.fillMaxWidth()
                            .dsxAccessibleSelectable(
                                selected = id == needle,
                                enabled = key.isNotEmpty(),
                                role = Role.RadioButton,
                                onSelect = select,
                            )
                            .pointerInput(id) {
                                detectTapGestures { select() }
                            }
                            // The per-row coarse-pointer floor (Combobox.swift rows, 1:1) —
                            // inside pointerInput so the whole floored row stays tappable.
                            .heightIn(min = ElementDefaults.COMBO_ROW_HEIGHT.dp)
                            .padding(horizontal = ElementDefaults.COMBO_ROW_PAD_H.dp, vertical = ElementDefaults.COMBO_ROW_PAD_V.dp),
                        contentAlignment = Alignment.CenterStart) {
                        BasicText(label, style = textStyle)
                    }
                    if (i != matches.lastIndex) {
                        Box(Modifier.fillMaxWidth().height(1.dp)
                                .background(StackStyle.color("separator").copy(alpha = 0.5f)))
                    }
                }
            }
        }
    }
}
