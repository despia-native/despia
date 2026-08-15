//
//  OtpElements.kt — `<otp>` (Kotlin twin of OTP.swift). One-time-code entry: N single-char
//  boxes all bound to ONE string (`bind="code"`), `length` boxes (default 6, min 1). A
//  nearly-transparent number-pad text field sits UNDER the box row and owns every
//  keystroke; tapping the boxes focuses it. The bind setter clamps to `length` digits
//  (filter digits, prefix length) and writes through the seam so `on:change` fires;
//  reaching `length` raises `on:complete`.
//
//  UNSTYLED (M3-batch2b) → the SAME hidden-input model with the visible boxes dressed in
//  Material 3 tokens: idle border = `colorScheme.outline`, active (next-to-fill, focused) =
//  `color` (authored) else `colorScheme.primary`, digit = `colorScheme.onSurface`, box
//  shape = `shapes.small` — the M3 outlined-field identity. `color` rides as the active
//  outline (SelectionControl.OTP). ANY authored look ejects to the LEGACY boxes (below),
//  byte-identical.
//
//  DIVERGENCES (M3 path, none silent): (1) Material 3 ships NO OTP/PIN component, so the M3
//  path COMPOSES the boxes from M3 outlined-field tokens (outline/primary/onSurface +
//  shapes.small) — a declared build, not a platform primitive. (2) There is NO `secure`
//  attribute: OTP.swift declares only bind/length/boxSize/color and always shows the digit,
//  so an Android-only mask would be an unshared authoring surface (the unified-codebase
//  law) — the digit is shown on both paths, exactly like iOS. The fixture describes the
//  LEGACY boxes, which stay byte-identical, so no fixture/spec change.
//
//  LEGACY BOX: `boxSize` (default 48) square, radius 10, border = active box `color`
//  (default accent) at 2dp else the semantic `separator` at 1dp (system-defaults base pass —
//  the old white-20% pin was invisible on light); the char rides the semantic `label`,
//  semibold, boxSize * 0.42; box spacing 8. Active box = the next-to-fill one while focused
//  (i == min(digits, length-1) && digits < length), exactly the Swift predicate.
//
//  PINNED DEVIATION (both paths): iOS `.textContentType(.oneTimeCode)` (SMS autofill) has no
//  direct BasicTextField twin — Android SMS autofill rides the platform SMS
//  Retriever/autofill services, a :platform concern later. Keyboard is the number pad, like iOS.
//

package despia.engine.render.elements

import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackStyle
import despia.engine.render.StackTheme

internal fun registerOtpElements() {
    ComposeStackComponents.defineNative("otp") { ctx -> OtpView(ctx) }
}

@Composable
private fun OtpView(ctx: ComposeStackComponentContext) {
    if (SelectionControl.rendersSystem(ctx.attrs, SelectionControl.OTP)) M3OtpView(ctx)
    else LegacyOtpView(ctx)
}

/// The unstyled OTP's system rendering: the SAME hidden-input model as the legacy path
/// (one nearly-transparent number-pad field owns every keystroke; the boxes are a read-out)
/// with the visible boxes dressed in M3 tokens — outline idle border, primary/authored
/// active border, onSurface digit, `shapes.small` box. Colors resolve from the stamped
/// scheme (ambient M3 fallback — the StackButtons rule).
@Composable
private fun M3OtpView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val length = maxOf(1, ctx.num("length")?.toInt() ?: ElementDefaults.OTP_LENGTH)
    val boxSize = ctx.num("boxSize") ?: ElementDefaults.OTP_BOX
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    val authored = ctl.interp("color")
    val active = if (authored.isNullOrEmpty()) cs.primary else StackStyle.color(authored)
    val idle = cs.outline
    val digitColor = cs.onSurface
    val shape = MaterialTheme.shapes.small

    val bound = JSE.string(ctl.boundValue(key))
    // Display sanitized: ignore non-digits / overflow from an external seed (iOS `digits`).
    val digits = ElementMath.otpClamp(bound, length)

    val focusRequester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }

    Box(Modifier.elementModifier(ctx)) {
        // The real input: nearly transparent, captures all keystrokes (iOS opacity 0.02).
        BasicTextField(
            value = bound,
            onValueChange = { raw ->
                val clamped = ElementMath.otpClamp(raw, length)
                ctl.setBound(key, clamped)                       // on:change from the write seam, actual change only
                if (clamped.length == length) ctl.fire("complete")
            },
            modifier = Modifier.matchParentSize().alpha(0.02f)
                .focusRequester(focusRequester)
                .onFocusChanged { focused = it.isFocused },
            textStyle = TextStyle(color = Color.Transparent),
            cursorBrush = SolidColor(Color.Transparent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            singleLine = true,
        )
        Row(
            Modifier
                .clearAndSetSemantics { }
                .pointerInput(Unit) {
                    detectTapGestures { focusRequester.requestFocus() }   // tapping the boxes raises the keyboard
                },
            horizontalArrangement = Arrangement.spacedBy(ElementDefaults.OTP_BOX_SPACING.dp),
        ) {
            for (i in 0 until length) {
                val isActive = focused && i == minOf(digits.length, length - 1) && digits.length < length
                Box(
                    Modifier.size(boxSize.dp)
                        .border(if (isActive) ElementDefaults.OTP_ACTIVE_BORDER.dp else ElementDefaults.OTP_IDLE_BORDER.dp,
                                if (isActive) active else idle, shape),
                    contentAlignment = Alignment.Center,
                ) {
                    BasicText(
                        if (i < digits.length) digits[i].toString() else "",
                        style = TextStyle(color = digitColor,
                                          fontSize = (boxSize * ElementDefaults.OTP_FONT_FRACTION).sp,
                                          fontWeight = StackStyle.weight("semibold"),
                                          fontFamily = StackStyle.design("rounded"),
                                          textAlign = TextAlign.Center),
                    )
                }
            }
        }
    }
}

// MARK: - otp (legacy — the byte-identical stroked boxes, ElementSpec-pinned)

@Composable
private fun LegacyOtpView(ctx: ComposeStackComponentContext) {
    val ctl = ctx.control()
    val key = ctx.attrs["bind"] ?: ""
    val length = maxOf(1, ctx.num("length")?.toInt() ?: ElementDefaults.OTP_LENGTH)
    val boxSize = ctx.num("boxSize") ?: ElementDefaults.OTP_BOX
    val accent = StackStyle.color(ctx.str("color", ElementDefaults.OTP_TINT))

    val bound = JSE.string(ctl.boundValue(key))
    // Display sanitized: ignore non-digits / overflow from an external seed (iOS `digits`).
    val digits = ElementMath.otpClamp(bound, length)

    val focusRequester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }

    Box(Modifier.elementModifier(ctx)) {
        // The real input: nearly transparent, captures all keystrokes (iOS opacity 0.02).
        BasicTextField(
            value = bound,
            onValueChange = { raw ->
                val clamped = ElementMath.otpClamp(raw, length)
                ctl.setBound(key, clamped)                       // on:change from the write seam, actual change only
                if (clamped.length == length) ctl.fire("complete")
            },
            modifier = Modifier.matchParentSize().alpha(0.02f)
                .focusRequester(focusRequester)
                .onFocusChanged { focused = it.isFocused },
            textStyle = TextStyle(color = Color.Transparent),
            cursorBrush = SolidColor(Color.Transparent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            singleLine = true,
        )
        // The visible boxes: i-th char or empty, active box border-highlighted.
        Row(
            Modifier
                // The transparent BasicTextField above is the one editable semantics
                // node. Suppress the painted digit copies so TalkBack never reads the
                // same code twice; pointer taps still transfer focus to that real input.
                .clearAndSetSemantics { }
                .pointerInput(Unit) {
                    detectTapGestures { focusRequester.requestFocus() }   // tapping the boxes raises the keyboard
                },
            horizontalArrangement = Arrangement.spacedBy(ElementDefaults.OTP_BOX_SPACING.dp),
        ) {
            for (i in 0 until length) {
                val isActive = focused && i == minOf(digits.length, length - 1) && digits.length < length
                Box(
                    Modifier.size(boxSize.dp)
                        .border(if (isActive) ElementDefaults.OTP_ACTIVE_BORDER.dp else ElementDefaults.OTP_IDLE_BORDER.dp,
                                if (isActive) accent else StackStyle.color(ElementDefaults.OTP_IDLE_BORDER_COLOR),
                                RoundedCornerShape(ElementDefaults.OTP_RADIUS.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    BasicText(
                        if (i < digits.length) digits[i].toString() else "",
                        style = TextStyle(color = StackStyle.color(ElementDefaults.OTP_DIGIT),
                                          fontSize = (boxSize * ElementDefaults.OTP_FONT_FRACTION).sp,
                                          fontWeight = StackStyle.weight("semibold"),
                                          fontFamily = StackStyle.design("rounded"),
                                          textAlign = TextAlign.Center),
                    )
                }
            }
        }
    }
}
