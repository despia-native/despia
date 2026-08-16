//
//  TextAreaElements.kt — `<textarea>`, the Kotlin twin of Foundation Basics/TextArea/
//  TextArea.swift: a two-way MULTILINE text input bound to a store var or row field
//  (`bind="bio"` / `bind="item.notes"`). iOS uses the growing
//  `TextField(_, text:, axis: .vertical)` clamped `.lineLimit(min...max)`; the Compose
//  twin is a BasicTextField with `minLines`/`maxLines` — the same grow-then-scroll
//  behavior (reserves minLines, grows to maxLines, scrolls internally past that).
//  Attributes: `placeholder`, `color` (default "white", TextArea.swift:43), `minLines`
//  (default 3, :31), `maxLines` (default 8, :32); an inverted pair is normalized
//  min(min,max)...max(min,max) exactly like TextArea.swift:36 (`textAreaLineRange`).
//  Events: `on:change` per edit from the bind seam (setBound — never fired by hand),
//  `on:focus` / `on:blur` on editing began/ended (TextArea.swift:44-45 — the @FocusState
//  onChange twin: never fired for the initial unfocused attach). No `on:submit` for
//  multiline, exactly iOS.
//
//  SYSTEM-DEFAULTS GATE (M3-text — the M3 wave's CLOSE; system-defaults.md, the ChoiceElements
//  precedent): an UNSTYLED textarea renders the REAL Material 3 `OutlinedTextField` (multiline
//  via minLines/maxLines) — `M3TextAreaView`, gated by `SelectionControl.TEXTAREA` (the shared
//  allowlist, NOT a fork). It rides the SAME bind seam AND the SAME B2 focus event contract
//  (on:focus/on:blur wired on the field MODIFIER, CHANGE-only). `color` rides the M3 field's
//  text + cursor color (iOS `.foregroundColor` — shared `m3TextInputColors`). ANY authored look
//  ejects to `LegacyTextAreaView` (the BasicTextField below), byte-identical — the inert-landing
//  invariant. Fixtures/ElementSpec pin the LEGACY path, so no spec change (combobox/checkbox).
//
//  ── PINNED DIVERGENCES (none silent) ────────────────────────────────────────────────
//  • M3 path: the M3 `OutlinedTextField` draws an OUTLINE BOX + M3 role colors where iOS's
//    unstyled field is BORDERLESS (each platform's own real component — the system-defaults
//    law); the M3 metrics are the component's own (OUT of the parity spec). The field is
//    full-width (fillMaxWidth — the iOS greedy-width twin); a `width=` author ejects to legacy.
//  • Legacy path: placeholder rides `interp` (the render-wave convention — textfield/combobox
//    do the same); iOS TextArea reads it through `displayString` (the localization choke
//    point). The kernel localization seam for render-wave placeholders is a deferred follow-up
//    shared with textfield. Placeholder styling = color at 0.3 alpha (the textfield's Android
//    chrome constant); iOS shows the native prompt styling. The field fills the proposed width
//    (SwiftUI TextField's greedy width) — wrapping needs a width bound; authors size it down
//    with the style chain as on iOS.
//

package despia.engine.render.elements

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import despia.engine.JSE
import despia.engine.NSNull
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.PlainWaveDefaults
import despia.engine.render.StackStyle
import despia.engine.render.m3TextInputColors

internal fun registerTextAreaElements() {
    ComposeStackComponents.defineNative("textarea") { ctx -> TextAreaView(ctx) }
}

/// The lineLimit clamp (TextArea.swift:36): `min(minLines, maxLines)...max(minLines, maxLines)`
/// — an inverted author pair is normalized, never crashes the range.
internal fun textAreaLineRange(minLines: Int, maxLines: Int): Pair<Int, Int> =
    minOf(minLines, maxLines).coerceAtLeast(1) to maxOf(minLines, maxLines).coerceAtLeast(1)

@Composable
private fun TextAreaView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.TEXTAREA)) M3TextAreaView(ctx)
    else LegacyTextAreaView(ctx)
}

/// The unstyled textarea's SYSTEM rendering: a REAL M3 `OutlinedTextField` (multiline via
/// minLines/maxLines) over the SAME bind seam + the SAME B2 focus event contract (on:focus/
/// on:blur from onFocusChanged CHANGE — no on:submit for multiline, exactly iOS). `placeholder`
/// rides the M3 slot; `color` (if authored) the field's text + cursor color (iOS
/// `.foregroundColor` — SelectionControl.TEXTAREA), else the M3 role colors.
@Composable
private fun M3TextAreaView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val raw = if (key.isEmpty()) null else ctl.boundValue(key)
    val text = if (raw == null || raw == NSNull) "" else JSE.string(raw)
    val (minL, maxL) = textAreaLineRange(
        ctx.num("minLines")?.toInt() ?: PlainWaveDefaults.TEXTAREA_MIN_LINES,
        ctx.num("maxLines")?.toInt() ?: PlainWaveDefaults.TEXTAREA_MAX_LINES)
    var focused by remember { mutableStateOf(false) }   // the @FocusState twin — CHANGE only (B2), never the initial attach
    val placeholder = ctx.interp("placeholder")
    OutlinedTextField(
        value = text,
        onValueChange = { if (key.isNotEmpty()) ctl.setBound(key, it) },   // on:change from the write seam, on actual change only
        modifier = Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth().onFocusChanged { f ->
            if (f.isFocused != focused) {
                focused = f.isFocused
                ctl.fire(if (f.isFocused) "focus" else "blur")             // editing began / ended (TextArea.swift:44-45)
            }
        }),
        singleLine = false,
        minLines = minL,
        maxLines = maxL,
        placeholder = { if (placeholder != null) Text(placeholder) },
        colors = m3TextInputColors(ctx.interp("color")),
    )
}

/// The authored-look textarea — the byte-identical LEGACY path (the BasicTextField the
/// fixture/ElementSpec pin): grow-then-scroll (reserves minLines, grows to maxLines, scrolls
/// internally past that), text/cursor colored from `color`, placeholder at 0.3 alpha (header).
@Composable
private fun LegacyTextAreaView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val raw = if (key.isEmpty()) null else ctl.boundValue(key)
    val text = if (raw == null || raw == NSNull) "" else JSE.string(raw)
    val color = StackStyle.color(ctx.str("color", PlainWaveDefaults.TEXTAREA_COLOR))
    val style = StackStyle.styleText(ctx.attrs, ctx.store, ctx.item, color)
    val (minL, maxL) = textAreaLineRange(
        ctx.num("minLines")?.toInt() ?: PlainWaveDefaults.TEXTAREA_MIN_LINES,
        ctx.num("maxLines")?.toInt() ?: PlainWaveDefaults.TEXTAREA_MAX_LINES)
    var focused by remember { mutableStateOf(false) }   // the @FocusState twin — fires only on CHANGE, never the initial attach
    BasicTextField(
        value = text,
        onValueChange = { if (key.isNotEmpty()) ctl.setBound(key, it) },   // on:change from the write seam, on actual change only
        modifier = Modifier.elementModifier(ctx).then(Modifier.fillMaxWidth().onFocusChanged { f ->
            if (f.isFocused != focused) {
                focused = f.isFocused
                ctl.fire(if (f.isFocused) "focus" else "blur")             // editing began / ended (TextArea.swift:44-45)
            }
        }),
        textStyle = style,
        minLines = minL,
        maxLines = maxL,
        cursorBrush = SolidColor(color),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.TopStart) {
                if (text.isEmpty()) ctx.interp("placeholder")?.let {
                    BasicText(it, style = style.copy(color = color.copy(alpha = PlainWaveDefaults.TEXTAREA_PLACEHOLDER_ALPHA)))
                }
                inner()
            }
        },
    )
}
