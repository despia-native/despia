//
//  StackInputViews.kt — the two-way bound input elements (toggle/textfield/slider) and the
//  progress readouts (progress/spinner), plus the BIND SEAM they stand on. Kotlin twin of
//  Stack.swift's StackComponentContext bind helpers (`boundValue` / `setBound` / `rowKey`,
//  Stack.swift ~561-603) — same names, same routing: an `item.*` / `dsx.this.*` key edits
//  the current list/grid row through the owning collection's write-back; anything else is
//  path-aware into the surface store (`global.*`/`route.*` → the app store) via `writeBound`.
//
//  `setBound` is THE `on:change` seam (Swift's single source of truth): every two-way
//  element fires `on:change` through it when the bound value ACTUALLY changed, loop-guarded
//  by `store.changeDepth` (a write the change handler itself makes never re-enters).
//
//  The textfield rides the full TextField.swift event trio: `on:focus` / `on:blur` from
//  Compose focus state (the @FocusState twin — fires only on CHANGE, never the initial
//  unfocused attach; TextField.swift:51-53) and `on:submit` from the IME action — Done, or
//  Go/Search when `keyboard=` dictates (url→Go, websearch→Search; TextField.swift:50
//  `.onSubmit`). The IME action fires submit THEN ends editing (clearFocus → blur), the
//  SwiftUI return-key order: submit always precedes blur, and editing ends even with no
//  `on:submit` authored. Pinned divergences: twitter/websearch have no Compose keyboard
//  LAYOUT (KeyboardType.Text — websearch's search identity rides the IME ACTION instead);
//  `contentType` (semantic autofill) is deferred on Android.
//
//  The toggle/slider/spinner LEGACY controls carry NO Material dependency (DSX owns those
//  visuals): foundation-primitive builds — toggle a UISwitch-metric capsule (51×31, 27pt
//  thumb), slider a draggable track + thumb, spinner a rotating 270° arc. Sizes/colors mirror
//  the iOS defaults (StackReference: toggle/slider/progress tint `accent`).
//  Since the M3-identity wave these are the LEGACY (EJECTED) path: a fully-unstyled
//  element renders the REAL M3 component instead (StackSystemControls.kt — gate +
//  dispatch in StackNodeView.kt raw()); any authored styling keeps these views
//  byte-identical (the inert-landing invariant), so nothing there may change shape.
//
//  Material DOES enter this file for `M3TextFieldView` (the M3-text CLOSE of the M3 wave):
//  the unstyled `<textfield>`/`<input>` renders a REAL Material 3 FILLED `TextField` — the
//  library-grade default of the 2026-08-20 library-grade ruling (system-defaults.md
//  amendment): the container-fill + floating-label field every design library ships, not
//  the outline-only variant this path first landed with. (SelectionControl.TEXTFIELD gate —
//  the shared allowlist, NOT a fork — dispatched from raw(). Outlined is NOT reachable by a
//  word: the census has no `variant` on textfield, and minting one is new authoring surface
//  — corpus-first on three kernels — so filled ships as THE default, per the ruling.)
//  It preserves the FULL B2 event contract byte-for-byte: on:focus/on:blur from the
//  onFocusChanged CHANGE, on:submit from the IME action THEN clearFocus→blur, the same
//  keyboard→ImeAction map (textFieldKeyboard/textFieldImeAction below) — the events stay
//  wired on the FIELD MODIFIER exactly as on the legacy `TextFieldView`, which stays the
//  byte-identical authored-look path. `color` rides the M3 field's text + cursor color (iOS
//  `.foregroundColor`), shared with the textarea path via `m3TextInputColors`.
//

package despia.engine.render

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.animation.animateColorAsState
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.NSNull
import despia.engine.StackStore
import despia.engine.writeBound
import kotlin.math.roundToInt

// MARK: - the bind seam (twin of StackComponentContext's boundValue/setBound/rowKey/run)

/// One element's bound-control face: scope-aware reads, write-back + the `on:change` seam,
/// and `on:<event>` dispatch (arg:* payload, declarative debounce/throttle) — the exact
/// contract Swift's safe `dsx` context hands a control.
internal class BoundControl(
    private val tag: String,
    private val attrs: Map<String, String>,
    private val store: StackStore,
    private val env: JSERunner,
    private val item: Map<String, Any?>?,
    private val rowWrite: ((String, Any) -> Unit)?,
) {
    fun interp(key: String): String? = attrs[key]?.let { JSE.interpolate(it, store, item) }
    fun num(key: String): Double? = interp(key)?.let { JSE.number(it) }

    /// Read a bound value, ROW-LOCAL first: `bind="item.x"` / `dsx.this.x` reads the current
    /// row's `x`; otherwise PATH-AWARE, exactly like `{{ }}` (`user.email`, `global.x`, `x`).
    fun boundValue(key: String): Any? {
        val k = rowKey(key)
        if (k.startsWith("item.") && item != null) return item[k.substring(5)]
        return JSE.eval(key, store, item)
    }

    /// Write a bound value back where it came from: an `item.*` key edits the row in place
    /// (via the owning collection's write-back), else path-aware into the store — then fire
    /// this element's `on:change` iff the value ACTUALLY changed (JSE.equals), loop-guarded
    /// by `changeDepth` so a handler touching its own bound state can't ping-pong.
    fun setBound(key: String, value: Any) {
        val fireChange = attrs["on:change"] != null && store.changeDepth == 0
        val before: Any? = if (fireChange) boundValue(key) else null
        val k = rowKey(key)
        val rw = rowWrite
        if (k.startsWith("item.") && rw != null) rw(k.substring(5), value)
        else store.writeBound(k, value)
        if (!fireChange || JSE.equals(before, value)) return
        store.changeDepth += 1
        fire("change")
        store.changeDepth -= 1
    }

    /// Run this element's `on:<event>` (the markup verbs) with `arg:*` as payload —
    /// debounce/throttle from `on:<event>.debounce|throttle`, gateKey "<tag>.<event>".
    fun fire(event: String) {
        val action = attrs["on:$event"] ?: return
        env.runGated(action, item, eventArgs(attrs, store, item),
                     debounceMs = JSERunner.gateMs(attrs, event, "debounce"),
                     throttleMs = JSERunner.gateMs(attrs, event, "throttle"),
                     gateKey = "$tag.$event")
    }

    /// `on:change` for a bindless control (pager/tabs with local selection): the same
    /// changeDepth guard as setBound, without a store write.
    fun fireChangeGuarded() {
        if (store.changeDepth != 0) return
        store.changeDepth += 1
        fire("change")
        store.changeDepth -= 1
    }

    companion object {
        /// Normalize a bind key for ROW routing: `dsx.this.x` / `dsx.item.x` → `item.x`
        /// (the current list/grid row); other `dsx.`-aliases via normalizeScope.
        fun rowKey(key: String): String {
            if (key == "dsx.this") return "item"
            if (key.startsWith("dsx.this.")) return "item." + key.substring(9)
            return JSE.normalizeScope(key)
        }
    }
}

// MARK: - toggle / switch — bind= two-way Bool (UISwitch metrics: 51×31 capsule, 27pt thumb)

/// The switch travel/track-crossfade duration — the platform switch's own thumb motion
/// (material3 SwitchImpl's classic 100ms spec). iOS never reaches this path (it renders the
/// NATIVE UISwitch on styled toggles too, which always animates), so a SNAPPING ejected
/// capsule was an Android-only fidelity gap — the 2026-08-20 library-grade ruling's
/// animated-system-control rule closes it.
private const val TOGGLE_MOTION_MS = 100

@Composable
internal fun ToggleView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val bindKey = a["bind"]
    val on = bindKey?.let { JSE.truthy(ctl.boundValue(it)) } ?: false
    // disabled= / disabled-if= (W9): the capsule dims and its gestures gate
    val disabled = despia.engine.render.elements.SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val tint = StackStyle.color(ctl.interp("color") ?: ElementDefaults.TOGGLE_TINT)
    // Off-track rides the semantic `fill` (system-defaults base pass): iOS renders the
    // NATIVE UISwitch whose off-track is the adaptive systemFill — the pinned white
    // approximation was the pre-theme compromise and broke on light schemes.
    // Thumb travel + track color ANIMATE between the same two at-rest renderings (the
    // resting geometry/colors are byte-identical to the pre-motion capsule).
    val fraction by animateFloatAsState(if (on) 1f else 0f, tween(TOGGLE_MOTION_MS), label = "dsx-toggle")
    val track by animateColorAsState(if (on) tint else StackStyle.color("fill"),
                                     tween(TOGGLE_MOTION_MS), label = "dsx-toggle-track")
    Box(m.then(Modifier.size(ElementDefaults.TOGGLE_WIDTH.dp, ElementDefaults.TOGGLE_HEIGHT.dp))
         .background(track, RoundedCornerShape((ElementDefaults.TOGGLE_HEIGHT / 2).dp))
         .dsxAccessibleToggle(
             value = on,
             enabled = bindKey != null && !disabled,
             role = Role.Switch,
             onToggle = { value -> if (bindKey != null && !disabled) ctl.setBound(bindKey, value) },
         )
         .pointerInput(bindKey, on, disabled) {
             detectTapGestures { if (bindKey != null && !disabled) ctl.setBound(bindKey, !on) }
         }
         .alpha(if (disabled) 0.5f else 1f),
        contentAlignment = Alignment.CenterStart) {
        Box(Modifier
             .offset {
                 // full travel = the width not occupied by the thumb-square (width − height)
                 val travel = (ElementDefaults.TOGGLE_WIDTH - ElementDefaults.TOGGLE_HEIGHT).dp
                 IntOffset((travel.toPx() * fraction).roundToInt(), 0)
             }
             .padding(ElementDefaults.TOGGLE_THUMB_INSET.dp)
             .size(ElementDefaults.TOGGLE_THUMB.dp).background(Color.White, CircleShape))
    }
}

// MARK: - textfield / input — bind= two-way String, placeholder=, secure=, keyboard=,
//         on:submit (IME action) / on:focus / on:blur (the TextField.swift event trio)

@Composable
internal fun TextFieldView(a: Map<String, String>, modifier: Modifier, store: StackStore,
                           item: Map<String, Any?>?, ctl: BoundControl) {
    val m = modifier
    val bindKey = a["bind"]
    val raw = bindKey?.let { ctl.boundValue(it) }
    val text = if (raw == null || raw == NSNull) "" else JSE.string(raw)
    val color = StackStyle.color(ctl.interp("color") ?: ElementDefaults.TEXTFIELD_COLOR)
    val style = StackStyle.styleText(a, store, item, color)
    val focusManager = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }   // the @FocusState twin — fires only on CHANGE, never the initial attach
    // The return key on iOS (TextField.swift:50 `.onSubmit`) fires on:submit and SwiftUI
    // then ENDS EDITING (the system resigns focus → @FocusState false → on:blur). Replicated
    // exactly: fire submit, then clearFocus() — onFocusChanged delivers the blur AFTER the
    // submit, and editing always ends on the IME action even with no on:submit authored.
    val submit = { ctl.fire("submit"); focusManager.clearFocus() }
    val keyboard = ctl.interp("keyboard")
    // disabled= / disabled-if= (W9): the input's own enabled seam carries it
    val disabled = despia.engine.render.elements.SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    BasicTextField(
        value = text,
        onValueChange = { if (bindKey != null) ctl.setBound(bindKey, it) },
        enabled = !disabled,
        modifier = m.then(Modifier.onFocusChanged { f ->
            if (f.isFocused != focused) {
                focused = f.isFocused
                ctl.fire(if (f.isFocused) "focus" else "blur")   // editing began / ended (TextField.swift:51-53)
            }
        }),
        textStyle = style,
        singleLine = true,
        visualTransformation = if (a["secure"] == "true") PasswordVisualTransformation()
                               else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = textFieldKeyboard(keyboard),
                                          imeAction = textFieldImeAction(keyboard)),
        keyboardActions = KeyboardActions(onDone = { submit() }, onGo = { submit() },
                                          onSearch = { submit() }),
        cursorBrush = SolidColor(color),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) ctl.interp("placeholder")?.let {
                    BasicText(it, style = style.copy(color = color.copy(alpha = ElementDefaults.TEXTFIELD_PLACEHOLDER_ALPHA)))
                }
                inner()
            }
        },
    )
}

/// `keyboard` token → the soft-keyboard variant — TextField.swift:78-90 `keyboard(_:)`,
/// same tokens accepted. Compose has no twitter/webSearch LAYOUTS: both pin to Text
/// (webSearch's search identity rides the IME ACTION below — the visible half on Android).
internal fun textFieldKeyboard(token: String?): KeyboardType = when (token) {
    "email", "emailAddress" -> KeyboardType.Email
    "number", "numberPad"   -> KeyboardType.Number
    "decimal", "decimalPad" -> KeyboardType.Decimal
    "phone", "phonePad"     -> KeyboardType.Phone
    "url", "URL"            -> KeyboardType.Uri
    "ascii", "asciiCapable" -> KeyboardType.Ascii
    else                    -> KeyboardType.Text   // incl. "twitter"/"websearch" — no Compose layout (header)
}

/// The IME action the keyboard type dictates — the iOS return-key presentation for the
/// mapped UIKeyboardType (webSearch shows Search, URL shows Go, everything else the plain
/// return). All three settle through the SAME submit handler in TextFieldView, so the
/// label is presentation only, never a semantic fork.
internal fun textFieldImeAction(token: String?): ImeAction = when (token) {
    "websearch", "webSearch" -> ImeAction.Search
    "url", "URL"             -> ImeAction.Go
    else                     -> ImeAction.Done
}

// MARK: - textfield (M3 path) — the REAL Material 3 filled TextField (system-defaults gate:
//         unstyled → M3, any authored look → TextFieldView above, byte-identical)

/// The unstyled textfield's SYSTEM rendering: a REAL M3 FILLED `TextField` (singleLine) —
/// the container-fill + underline-indicator field, the library-grade default (the
/// 2026-08-20 ruling; the file header names why outlined has no word) — over
/// the SAME bind seam AND the SAME B2 focus/IME event contract as the legacy field — the
/// events stay wired on the FIELD MODIFIER: on:focus/on:blur fire from onFocusChanged on
/// CHANGE (never the initial attach), on:submit fires from the IME action THEN clearFocus()
/// ends editing → blur (the SwiftUI return-key order — submit precedes blur, editing ends even
/// with no on:submit authored), the keyboard→ImeAction map unchanged (textFieldKeyboard /
/// textFieldImeAction). `secure` rides PasswordVisualTransformation, `placeholder` the M3 slot,
/// `color` (if authored) the M3 field's text + cursor color (iOS `.foregroundColor` —
/// SelectionControl.TEXTFIELD; else the M3 role colors). The field is full-width (the iOS
/// greedy-width twin; a `width=` author ejects to the legacy path).
@Composable
internal fun M3TextFieldView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val bindKey = a["bind"]
    val raw = bindKey?.let { ctl.boundValue(it) }
    val text = if (raw == null || raw == NSNull) "" else JSE.string(raw)
    val focusManager = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }   // the @FocusState twin — CHANGE only (B2), never the initial attach
    val submit = { ctl.fire("submit"); focusManager.clearFocus() }   // submit THEN end editing → blur (B2 order)
    val keyboard = ctl.interp("keyboard")
    val placeholder = ctl.interp("placeholder")
    // disabled= / disabled-if= (W9): the M3 component's own enabled seam carries it
    val disabled = despia.engine.render.elements.SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    TextField(
        value = text,
        onValueChange = { if (bindKey != null) ctl.setBound(bindKey, it) },
        enabled = !disabled,
        modifier = m.then(Modifier.fillMaxWidth().onFocusChanged { f ->   // B2: the events ride the field modifier
            if (f.isFocused != focused) {
                focused = f.isFocused
                ctl.fire(if (f.isFocused) "focus" else "blur")   // editing began / ended (TextField.swift:51-53)
            }
        }),
        singleLine = true,
        visualTransformation = if (a["secure"] == "true") PasswordVisualTransformation()
                               else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = textFieldKeyboard(keyboard),
                                          imeAction = textFieldImeAction(keyboard)),
        keyboardActions = KeyboardActions(onDone = { submit() }, onGo = { submit() },
                                          onSearch = { submit() }),
        placeholder = { if (placeholder != null) Text(placeholder) },
        colors = m3TextInputColors(ctl.interp("color")),
    )
}

/// The M3 text-input colors SHARED by the textfield + textarea + `<field>` system paths
/// (TextAreaElements.kt / Forms.kt import this): the FILLED TextField's role defaults
/// (surface-container fill, primary focus indicator + floating label, onSurface text — the
/// platform's own library-grade field, never re-specified; the fill plane and accent land
/// through the stamped scheme exactly as the ruling's token mapping names them); an
/// authored `color` overrides the text + cursor color (iOS keeps `.foregroundColor(color)`
/// on the field), container/indicator/label staying M3's own.
@Composable
internal fun m3TextInputColors(authored: String?): TextFieldColors =
    if (authored.isNullOrEmpty()) TextFieldDefaults.colors()
    else StackStyle.color(authored).let { c ->
        TextFieldDefaults.colors(
            focusedTextColor = c, unfocusedTextColor = c, cursorColor = c)
    }

// MARK: - slider — bind= two-way Number over min=/max= (draggable track, no Material)

@Composable
internal fun SliderView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val bindKey = a["bind"]
    val min = ctl.num("min") ?: ElementDefaults.SLIDER_MIN
    val max = ctl.num("max") ?: ElementDefaults.SLIDER_MAX
    val lo = minOf(min, max); val hi = maxOf(min, max)
    val value = (bindKey?.let { JSE.number(ctl.boundValue(it)) } ?: lo).coerceIn(lo, hi)
    val fraction = if (hi > lo) ((value - lo) / (hi - lo)).toFloat() else 0f
    // disabled= / disabled-if= (W9): the track dims and its gestures gate
    val disabled = despia.engine.render.elements.SelectionControl.isDisabled(ctl.interp("disabled"), ctl.interp("disabled-if"))
    val tint = StackStyle.color(ctl.interp("color") ?: ElementDefaults.SLIDER_TINT)
    var widthPx by remember { mutableFloatStateOf(0f) }
    fun commit(x: Float) {
        if (disabled || bindKey == null || widthPx <= 0f) return
        val f = (x / widthPx).coerceIn(0f, 1f)
        ctl.setBound(bindKey, lo + f.toDouble() * (hi - lo))
    }
    val track = ElementDefaults.SLIDER_TRACK.dp
    val trackShape = RoundedCornerShape((ElementDefaults.SLIDER_TRACK / 2).dp)
    Box(m.then(Modifier.fillMaxWidth().height(ElementDefaults.SLIDER_HEIGHT.dp))
         .onSizeChanged { widthPx = it.width.toFloat() }
         .dsxAccessibleRange(
             value = value.toFloat(),
             valueRange = lo.toFloat()..hi.toFloat(),
             enabled = bindKey != null && hi > lo && !disabled,
             onSetProgress = { target ->
                 if (bindKey == null || disabled) false
                 else {
                     ctl.setBound(bindKey, target.toDouble())
                     true
                 }
             },
         )
         .pointerInput(bindKey, lo, hi, disabled) { detectTapGestures { off -> commit(off.x) } }
         .pointerInput(bindKey, lo, hi, disabled) {
             detectHorizontalDragGestures { change, _ -> change.consume(); commit(change.position.x) }
         }
         .alpha(if (disabled) 0.5f else 1f),
        contentAlignment = Alignment.CenterStart) {
        Box(Modifier.fillMaxWidth().height(track).background(tint.copy(alpha = ElementDefaults.SLIDER_TRACK_ALPHA), trackShape))
        Box(Modifier.fillMaxWidth(fraction).height(track).background(tint, trackShape))
        Box(Modifier
             .offset { IntOffset(((widthPx - ElementDefaults.SLIDER_THUMB.dp.toPx()) * fraction).roundToInt().coerceAtLeast(0), 0) }
             .size(ElementDefaults.SLIDER_THUMB.dp).background(Color.White, CircleShape))
    }
}

// MARK: - progress / capsuleProgress — determinate bar from bind= (expr) or value= (0…1)

@Composable
internal fun ProgressView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val v = (a["bind"]?.let { JSE.number(ctl.boundValue(it)) } ?: ctl.num("value") ?: 0.0)
        .coerceIn(0.0, 1.0)
    val tint = StackStyle.color(ctl.interp("color") ?: ElementDefaults.PROGRESS_TINT)
    val h = (ctl.num("height") ?: ElementDefaults.PROGRESS_HEIGHT).dp
    Box(m.then(Modifier.fillMaxWidth().height(h))
         .background(tint.copy(alpha = ElementDefaults.PROGRESS_TRACK_OPACITY.toFloat()), RoundedCornerShape(h / 2)),
        contentAlignment = Alignment.CenterStart) {
        Box(Modifier.fillMaxWidth(v.toFloat()).height(h).background(tint, RoundedCornerShape(h / 2)))
    }
}

// MARK: - spinner / activity — indeterminate: an infinitely rotating 270° arc

@Composable
internal fun SpinnerView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val tint = StackStyle.color(ctl.interp("color") ?: ElementDefaults.SPINNER_TINT)
    val transition = rememberInfiniteTransition(label = "spinner")
    val angle by transition.animateFloat(
        initialValue = 0f, targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(ElementDefaults.SPINNER_PERIOD_MS, easing = LinearEasing)),
        label = "spinnerAngle")
    Canvas(m.then(Modifier.size(ElementDefaults.SPINNER_SIZE.dp))) {
        drawArc(color = tint, startAngle = angle, sweepAngle = ElementDefaults.SPINNER_SWEEP, useCenter = false,
                style = Stroke(width = ElementDefaults.SPINNER_STROKE.dp.toPx(), cap = StrokeCap.Round))
    }
}
