//
//  Forms.kt — `<form>` (the thin coordinator), `<field>` (label · input · touched-gated
//  error) and `<searchbar>` (the rounded search capsule). Kotlin twins of Foundation
//  Forms/Form/Form.swift, Forms/Field/Field.swift and Basics/SearchBar/SearchBar.swift.
//
//  FORM (Form.swift, 1:1): a leading VStack (spacing default 12) over the slot; `as=`
//  (default "form") is the state namespace, INJECTED down the tree (SwiftUI Environment →
//  CompositionLocal) so nested <field>s auto-namespace; `submit="Label"` renders a submit
//  button that dims to 50% while `form.valid` is falsy (still tappable — an invalid
//  submit marks EVERY registered field touched + sets `form.submitted`, revealing all
//  errors); a valid submit blurs (`form.focus = ""`) then runs on:submit; `scroll` wraps
//  in a vertical scroll.
//
//  FIELD (Field.swift): a 4-spaced leading VStack — optional label (footnote 13,
//  secondary) · the input · the first failing validator's message (13, #FF453A) shown
//  once TOUCHED (focused-then-blurred) or after a form submit. State it maintains
//  (dot-accessible, byte-identical paths): form.values.<name> · form.fields.<name>.
//  {touched,dirty,error} · form.valid · form.fieldOrder / form.focus (Return advances).
//  Text entry is the real Material 3 `OutlinedTextField`: the label and placeholder use its
//  native slots, focus/IME behavior stays on the existing form namespace, and a revealed
//  validation error sets the control's native error state. `validate="required,email,minLength:8"` runs the ENGINE validator builtins through
//  JSE.eval exactly like iOS (`required(path)` / `minLength(path, n)`); regex/pattern
//  matches natively against `pattern=`; `message=` overrides. `type` picks the input:
//  text/email/number/phone/url (keyboard) · secure · toggle (the real M3 Switch — the
//  Field.swift native-Toggle twin; StackSystemControls.kt systemSwitchColors) ·
//  picker (options CSV / optionsKey + valueField/labelField, default id/label — a menu).
//
//  SEARCHBAR (SearchBar.swift, 1:1): HStack(spacing 6) — magnifyingglass (secondary) ·
//  the bound TextField (placeholder default localized "Search"; on:change rides the
//  setBound seam; Return = on:submit) · a trailing xmark.circle.fill clear button while
//  non-empty (clears + on:clear). Chrome: padding h12/v8 on a secondarySystemFill capsule
//  over a regular-material capsule (the engine `fill` token + material degrade).
//
//  KEYBOARD ACCESSORY BAR (Field.swift `.toolbar(placement: .keyboard)` — ▲ ▼ / Done):
//  the FOCUSED field owns the bar (exactly like iOS attaching the toolbar to each input);
//  ▲ ▼ walk `form.fieldOrder` through the existing `form.focus` machinery (disabled at the
//  ends), Done writes `form.focus = ""` — which now also BLURS the field (the Field.swift
//  `.onChange(of: focusReq)` else-branch: `""` names no successor, so nobody steals focus;
//  a named successor blurs implicitly via its own focus request). DSX-owned visuals over
//  an above-IME row: a NON-focusable Popup (taps on it never steal IME focus) positioned
//  at (window height − `WindowInsets.ime` bottom − bar height).
//  Pinned geometry (the system keyboard toolbar): bar height 44, h-padding 16, chevron
//  spacing 20, chevrons 17dp accent-tinted 2.2dp round-cap strokes (chevron.up/down have
//  no sf-map glyph — the bar draws its own), 35% alpha disabled, Done 17 semibold accent,
//  regular-material bar over a 0.5dp separator hairline.
//
//  ── DIVERGENCE: no M3 grouped-form container (system-defaults.md) ────────────────────
//  iOS's `<form>` now has a SYSTEM path: an unstyled `scroll` form renders the REAL SwiftUI
//  `Form`, which owns inset-grouped row insets, section separators and keyboard avoidance
//  (Form.swift, "THE SYSTEM DEFAULT"). THE ANDROID TWIN KEEPS THE COLUMN, because Material 3
//  has no component to host it and the law's Android row is M3, not a copy of SwiftUI:
//    – `androidx.compose.material3` ships NO form/section/grouped container. There is no
//      `Form`, no `FormSection`, no M3 settings-group composable to hand the rows to —
//      verified against the resolved artifact (material3-android 1.5.0-alpha08): the public
//      composable set runs ListItem/InteractiveListItem · TextField · Card · Surface · the
//      navigation and dialog families, and stops there.
//    – Android's platform grouped-settings look is `androidx.preference` — a VIEW-system
//      library with no Compose surface, built for a `Preference` tree (typed, XML/`Preference`
//      objects), not for arbitrary `<field>`/`<button>`/stack children. Hosting DSX rows in it
//      is not possible, and hand-drawing its chrome would re-specify a look from authored
//      values — the thing the law forbids. (The unstyled `<list>` earns grouped chrome because
//      the law's Android row NAMES `ListItem`; it names nothing for forms.)
//    – M3's actual form guidance IS a column of full-width text fields separated by standard
//      spacing, which is what this element renders: text entry uses the real
//      `OutlinedTextField`, and `type="toggle"` uses the real `Switch`. So the M3-correct
//      rendering needs no new container.
//  RESULT: no attribute allowlist / `unstyled` gate exists in this file, deliberately — with
//  no system container to switch INTO, a gate would guard nothing. If M3 ever ships a grouped
//  form/section container, the FormElement below grows the Form.swift `systemSafeAttrs` gate
//  (the `SystemList` precedent in StackSystemControls.kt) and this note retires.
//  The two Form.swift divergences that are CONDITIONS rather than looks land here for free:
//  a styled form and a non-`scroll` form keep the Column on both runtimes.
//
//  ── DEVIATIONS (pinned) ──────────────────────────────────────────────────────────────
//  • The submit button is SwiftUI's plain Button — pinned here as 17pt accent text.
//  • The accessory bar shows only while the field's WINDOW reports an IME inset
//    (edge-to-edge/adjustResize hosts — the Despia shell). A window that reports none
//    (some Popup-presented surfaces) shows no bar — fail-open, never mispositioned.
//

package despia.engine.render.elements

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
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
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.getPath
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleActivation
import despia.engine.render.dsxAccessibleSelectable
import despia.engine.render.m3TextInputColors
import despia.engine.render.systemSwitchColors
import despia.engine.setPath

internal fun registerFormElements() {
    ComposeStackComponents.defineNative("form") { ctx -> FormElement(ctx) }
    ComposeStackComponents.defineNative("field") { ctx -> FieldElement(ctx) }
    ComposeStackComponents.defineNative("searchbar") { ctx -> SearchBarElement(ctx) }
}

/// The enclosing form's namespace — the SwiftUI `\.dsxForm` EnvironmentKey twin.
internal val LocalDSXFormNamespace = compositionLocalOf { "form" }

// MARK: - <form>

@Composable
private fun FormElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val ns = el.str("as", "form")
    val valid = JSE.truthy(ctx.store.getPath("$ns.valid"))

    fun markAllTouched() {
        @Suppress("UNCHECKED_CAST")
        val fields = (ctx.store.getPath("$ns.fields") as? Map<String, Any?>) ?: emptyMap()
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in fields) {
            @Suppress("UNCHECKED_CAST")
            val meta = LinkedHashMap((v as? Map<String, Any?>) ?: emptyMap())
            meta["touched"] = true
            out[k] = meta
        }
        ctx.store.setPath("$ns.fields", out)
        ctx.store.setPath("$ns.submitted", true)
    }
    fun submit() {
        if (JSE.truthy(ctx.store.getPath("$ns.valid"))) {
            ctx.store.setPath("$ns.focus", "")                       // dismiss the keyboard
            el.run("submit")
        } else markAllTouched()                                      // reveal every error at once
    }

    val body: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth(),
               verticalArrangement = Arrangement.spacedBy(el.dbl("spacing", ElementDefaults.FORM_SPACING).dp),
               horizontalAlignment = Alignment.Start) {
            SlotColumnNodes(ctx, defaultSlot(ctx))
            if (el.has("submit")) {
                BasicText(el.str("submit"),
                          Modifier.alpha(if (valid) 1f else ElementDefaults.FORM_INVALID_OPACITY.toFloat())   // dim while invalid, still tappable
                              .dsxAccessibleActivation(role = Role.Button, onClick = { submit() })
                              .pointerInput(ns) { detectTapGestures { submit() } },
                          style = TextStyle(color = StackStyle.color("accent"), fontSize = 17.sp))
            }
        }
    }
    CompositionLocalProvider(LocalDSXFormNamespace provides ns) {
        if (el.bool("scroll")) Column(Modifier.elementStyle(el).then(Modifier.verticalScroll(rememberScrollState()))) { body() }
        else Box(Modifier.elementStyle(el)) { body() }
    }
}

// MARK: - <field>

/// The built-in validators' default messages — Field.swift `message(_:_:)`, 1:1.
internal fun fieldMessage(fn: String, arg: String): String = when (fn) {
    "required" -> "Required"
    "email" -> "Enter a valid email"
    "url" -> "Enter a valid URL"
    "phone" -> "Enter a valid phone number"
    "minLength" -> "Must be at least $arg characters"
    "maxLength" -> "Must be at most $arg characters"
    "regex", "pattern" -> "Invalid format"
    else -> "Invalid"
}

/// `type` → the soft keyboard — Field.swift `keyboard(_:)`.
internal fun fieldKeyboard(type: String): KeyboardType = when (type) {
    "email" -> KeyboardType.Email
    "number" -> KeyboardType.Number
    "phone" -> KeyboardType.Phone
    "url" -> KeyboardType.Uri
    else -> KeyboardType.Text
}

/// The ▲▼/Return neighbors in `form.fieldOrder` — Field.swift `prevField`/`nextField`
/// (pure — JVM-tested in FormsAccessoryTest). An unregistered name (or no form scope at
/// all) has no neighbors — the bar degrades to Done-only.
internal fun fieldNeighbors(order: List<String>, name: String): Pair<String?, String?> {
    val i = order.indexOf(name)
    if (i < 0) return null to null
    return (if (i > 0) order[i - 1] else null) to (if (i < order.size - 1) order[i + 1] else null)
}

@Composable
private fun FieldElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val store = ctx.store
    val envForm = LocalDSXFormNamespace.current
    val ns = if (el.has("form")) el.str("form") else envForm         // explicit form= wins
    val name = el.str("name")
    val valuePath = "$ns.values.$name"
    val metaPath = "$ns.fields.$name"
    val type = el.str("type")

    // Field order = registration order (Return→next + the accessory ▲▼); form.focus
    // coordinates cross-field focus.
    @Suppress("UNCHECKED_CAST")
    fun order(): List<String> = (store.getPath("$ns.fieldOrder") as? List<String>) ?: emptyList()

    /// Run `validate=` — the first failing rule's message lands at `<meta>.error`, then
    /// `form.valid` recomputes (no registered field has an error). Field.swift validate().
    fun validate() {
        val value = JSE.string(store.getPath(valuePath) ?: "")
        var msg = ""
        for (rule in el.str("validate").split(",").map { it.trim() }.filter { it.isNotEmpty() }) {
            val kv = rule.split(":", limit = 2)
            val fn = kv[0]; val arg = if (kv.size > 1) kv[1] else ""
            val pass = when (fn) {
                "regex", "pattern" -> {
                    // The raw pattern rides `pattern=` (a `,` in `{2,4}` never collides);
                    // matched natively, partial like Swift's .regularExpression range.
                    val pattern = arg.ifEmpty { el.str("pattern") }
                    value.isEmpty() || pattern.isEmpty() ||
                        runCatching { Regex(pattern).containsMatchIn(value) }.getOrDefault(true)
                }
                "minLength", "maxLength" ->
                    JSE.truthy(JSE.eval("$fn($valuePath, ${arg.toIntOrNull() ?: 0})", store, ctx.item))
                else ->                                             // required / email / url / phone — the engine fns
                    JSE.truthy(JSE.eval("$fn($valuePath)", store, ctx.item))
            }
            if (!pass) {
                val override = el.str("message")
                msg = override.ifEmpty { fieldMessage(fn, arg) }
                break
            }
        }
        store.setPath("$metaPath.error", msg)
        val fields = (store.getPath("$ns.fields") as? Map<*, *>) ?: emptyMap<Any?, Any?>()
        val ok = fields.values.all { ((it as? Map<*, *>)?.get("error") as? String ?: "").isEmpty() }
        store.setPath("$ns.valid", ok)
    }
    fun write(v: Any) {
        store.setPath(valuePath, v)
        store.setPath("$metaPath.dirty", true)
        validate()
    }

    LaunchedEffect(name) {                                          // seed order + initial validity
        val o = order()
        if (name.isNotEmpty() && name !in o) store.setPath("$ns.fieldOrder", o + name)
        validate()
    }

    val touched = JSE.truthy(store.getPath("$metaPath.touched"))
    val submitted = JSE.truthy(store.getPath("$ns.submitted"))
    val error = JSE.string(store.getPath("$metaPath.error") ?: "")
    val showError = (touched || submitted) && error.isNotEmpty()
    Column(Modifier.elementStyle(el), verticalArrangement = Arrangement.spacedBy(ElementDefaults.FIELD_STACK_SPACING.dp),
           horizontalAlignment = Alignment.Start) {
        when (type) {
            "toggle" -> FieldToggleRow(el.str("label"), JSE.truthy(store.getPath(valuePath))) { on ->
                write(on); store.setPath("$metaPath.touched", true)  // flipped = touched
            }
            "picker" -> FieldPicker(el, sel = JSE.string(store.getPath(valuePath) ?: "")) { v ->
                write(v); store.setPath("$metaPath.touched", true)   // selecting is a "touch"
            }
            else -> {
                val (prevField, nextField) = fieldNeighbors(order(), name)
                FieldTextInput(el, ns, name, type,
                               value = JSE.string(store.getPath(valuePath) ?: ""),
                               prevField = prevField,
                               nextField = nextField,
                               isError = showError,
                               onWrite = { write(it) },
                               onBlur = { store.setPath("$metaPath.touched", true) })
            }
        }
        if (showError) {
            BasicText(error, style = TextStyle(color = StackStyle.color(ElementDefaults.FIELD_ERROR), fontSize = 13.sp))
        }
    }
}

/// text / secure input + Return→next through `form.focus` (the shared-store focus
/// coordination — fields are independently-rendered components, Field.swift's rationale)
/// + the keyboard accessory bar while focused (the `.toolbar(placement: .keyboard)` twin).
@Composable
private fun FieldTextInput(el: El, ns: String, name: String, type: String, value: String,
                           prevField: String?, nextField: String?,
                           isError: Boolean,
                           onWrite: (String) -> Unit, onBlur: () -> Unit) {
    val store = el.ctx.store
    val secure = el.bool("secure") || type == "secure"
    val requester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }
    val focusReq = JSE.string(store.getPath("$ns.focus") ?: "")
    LaunchedEffect(focusReq) {
        // Field.swift `.onChange(of: focusReq)`: a request naming THIS field focuses it; an
        // EMPTY request (Done / a valid submit) blurs — nothing else will steal focus. A
        // request naming another field blurs implicitly via that field's own requestFocus.
        if (name.isNotEmpty() && focusReq == name && !focused) runCatching { requester.requestFocus() }
        else if (focusReq.isEmpty() && focused) focusManager.clearFocus()
    }
    val label = el.ctl.interp("label")
    val placeholder = el.ctl.interp("placeholder")
    OutlinedTextField(
        value = value,
        onValueChange = onWrite,
        modifier = Modifier.fillMaxWidth().focusRequester(requester).onFocusChanged { f ->
            if (f.isFocused && !focused) { focused = true; store.setPath("$ns.focus", name) }
            else if (!f.isFocused && focused) { focused = false; onBlur() }
        },
        singleLine = true,
        visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = fieldKeyboard(type),
                                          imeAction = if (nextField == null) ImeAction.Done else ImeAction.Next),
        keyboardActions = KeyboardActions(
            onNext = { nextField?.let { store.setPath("$ns.focus", it) } },
            onDone = { store.setPath("$ns.focus", "") },
        ),
        label = { if (label != null) Text(label) },
        placeholder = { if (placeholder != null) Text(placeholder) },
        isError = isError,
        colors = m3TextInputColors(el.ctl.interp("color")),
    )
    // Keep the focus-owning node first and slot-stable. Inserting the conditional Popup
    // before OutlinedTextField disposes/recreates the field when `focused` flips true,
    // immediately losing the focus we just requested and incorrectly marking it touched.
    if (focused) {
        KeyboardAccessoryBar(prevField = prevField, nextField = nextField,
                             onFocus = { store.setPath("$ns.focus", it) },
                             onDone = { store.setPath("$ns.focus", "") })
    }
}

// MARK: - the keyboard accessory bar (Field.swift `.toolbar(placement: .keyboard)`)

/// Pinned geometry — the system keyboard toolbar (see the file header).
private const val ACCESSORY_BAR_HEIGHT = 44.0        // dp — the toolbar band
private const val ACCESSORY_BAR_PAD_H = 16.0         // dp
private const val ACCESSORY_CHEVRON_SPACING = 20.0   // dp — between ▲ and ▼
private const val ACCESSORY_CHEVRON_SIZE = 17.0      // dp — the glyph box
private const val ACCESSORY_CHEVRON_STROKE = 2.2     // dp — round-cap stroke width
private const val ACCESSORY_DISABLED_ALPHA = 0.35f   // an end-of-form chevron
private const val ACCESSORY_HAIRLINE = 0.5           // dp — the separator over the bar

/// The ▲ ▼ / Done row over the keyboard, owned by the FOCUSED field (exactly like iOS
/// attaching the toolbar to each input). A NON-focusable Popup — taps on it never steal
/// IME focus — pinned at (window height − `WindowInsets.ime` bottom − bar height); no
/// reported IME inset (see header DEVIATIONS) = no bar, never a mispositioned one.
@Composable
private fun KeyboardAccessoryBar(prevField: String?, nextField: String?,
                                 onFocus: (String) -> Unit, onDone: () -> Unit) {
    val density = LocalDensity.current
    val root = LocalView.current.rootView
    val imeBottom = WindowInsets.ime.getBottom(density)                 // animates with the IME
    if (imeBottom <= 0) return                                          // fail-open — header DEVIATIONS
    val barPx = with(density) { (ACCESSORY_BAR_HEIGHT + ACCESSORY_HAIRLINE).dp.roundToPx() }
    val y = root.height - imeBottom - barPx
    if (y < 0) return                                                   // a resized window already sits above the IME
    val position = remember(y) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize,
                                           layoutDirection: LayoutDirection,
                                           popupContentSize: IntSize): IntOffset = IntOffset(0, y)
        }
    }
    Popup(popupPositionProvider = position,
          properties = PopupProperties(focusable = false, clippingEnabled = false)) {
        Column(Modifier.width(with(density) { root.width.toDp() })) {
            Box(Modifier.fillMaxWidth().height(ACCESSORY_HAIRLINE.dp)
                    .background(StackStyle.color("separator")))         // the toolbar hairline
            Row(Modifier.fillMaxWidth().height(ACCESSORY_BAR_HEIGHT.dp)
                    .background(StackStyle.material("regular"))
                    .padding(horizontal = ACCESSORY_BAR_PAD_H.dp),
                horizontalArrangement = Arrangement.spacedBy(ACCESSORY_CHEVRON_SPACING.dp),
                verticalAlignment = Alignment.CenterVertically) {
                AccessoryChevron(
                    up = true,
                    enabled = prevField != null,
                    description = DSXStrings.localize("Previous field"),
                ) { prevField?.let(onFocus) }
                AccessoryChevron(
                    up = false,
                    enabled = nextField != null,
                    description = DSXStrings.localize("Next field"),
                ) { nextField?.let(onFocus) }
                Spacer(Modifier.weight(1f))
                BasicText(DSXStrings.localize("Done"),
                          Modifier
                              .dsxAccessibleActivation(role = Role.Button, onClick = onDone)
                              .pointerInput(Unit) { detectTapGestures { onDone() } },
                          style = TextStyle(color = StackStyle.color("accent"), fontSize = 17.sp,
                                            fontWeight = FontWeight.SemiBold))
            }
        }
    }
}

/// One accent chevron — drawn (chevron.up/down have no sf-map glyph): a 17dp box, 2.2dp
/// round-cap/round-join stroke, 35% alpha when there is no field in that direction.
@Composable
private fun AccessoryChevron(
    up: Boolean,
    enabled: Boolean,
    description: String,
    onTap: () -> Unit,
) {
    val tint = StackStyle.color("accent")
    Canvas(Modifier.size(ACCESSORY_CHEVRON_SIZE.dp)
               .alpha(if (enabled) 1f else ACCESSORY_DISABLED_ALPHA)
               .dsxAccessibleActivation(
                   enabled = enabled,
                   role = Role.Button,
                   contentDescription = description,
                   mergeDescendants = false,
                   onClick = onTap,
               )
               .pointerInput(enabled) { detectTapGestures { if (enabled) onTap() } }) {
        val w = size.width; val h = size.height
        val apexY = if (up) h * 0.36f else h * 0.64f
        val wingY = if (up) h * 0.64f else h * 0.36f
        drawPath(Path().apply {
                     moveTo(w * 0.16f, wingY)
                     lineTo(w * 0.5f, apexY)
                     lineTo(w * 0.84f, wingY)
                 },
                 color = tint,
                 style = Stroke(width = ACCESSORY_CHEVRON_STROKE.dp.toPx(),
                                cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/// The inline-labelled switch row — label + the REAL M3 `Switch` (the iOS Field.swift
/// toggleRow renders the native SwiftUI Toggle; the M3-identity wave makes this row the
/// Android twin). The switch half is form chrome the author never styles, so it follows
/// the unstyled-toggle system rule unconditionally — same explicit role colors as the
/// `<toggle>` element (StackSystemControls.kt systemSwitchColors — one source, no drift).
@Composable
private fun FieldToggleRow(label: String, on: Boolean, onFlip: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        BasicText(label, Modifier.weight(1f), style = TextStyle(color = StackStyle.color("label"), fontSize = 17.sp))
        Switch(checked = on, onCheckedChange = onFlip, colors = systemSwitchColors())
    }
}

/// `type="picker"` — a menu of options (CSV `options=` / bound `optionsKey` with
/// `valueField`/`labelField`, default id/label — Field.swift pickerOptions, 1:1). The
/// closed row shows the selected label (else the placeholder) + up/down chevrons, accent.
@Composable
private fun FieldPicker(el: El, sel: String, onSelect: (String) -> Unit) {
    val opts: List<Pair<String, String>> =
        if (el.ctx.attrs.containsKey("optionsKey")) {
            val vf = el.ctx.attrs["valueField"] ?: "id"; val lf = el.ctx.attrs["labelField"] ?: "label"
            el.list("optionsKey").map { JSE.string(it[vf] ?: "") to JSE.string(it[lf] ?: "") }
        } else el.str("options").split(",").map { it.trim() }.filter { it.isNotEmpty() }.map { it to it }
    val tint = el.color("color", "accent")
    var open by remember { mutableStateOf(false) }
    Box {
        Row(Modifier
            .dsxAccessibleActivation(role = Role.Button, onClick = { open = true })
            .pointerInput(Unit) { detectTapGestures { open = true } }
            .padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            val current = opts.firstOrNull { it.first == sel }?.second ?: el.str("placeholder")
            BasicText(current, style = TextStyle(color = tint, fontSize = 17.sp))
            StackIcon("chevron.up.chevron.down", 12.0, tint)
        }
        if (open) {
            Popup(alignment = Alignment.TopStart, onDismissRequest = { open = false },
                  properties = PopupProperties(focusable = true)) {
                Column(Modifier.width(250.dp)
                           .background(StackStyle.material("regular"), RoundedCornerShape(13.dp))
                           .selectableGroup()) {
                    for ((i, o) in opts.withIndex()) {
                        if (i > 0) Box(Modifier.fillMaxWidth().height(0.5.dp)
                            .background(StackStyle.color("separator")))
                        Row(Modifier.fillMaxWidth()
                                .dsxAccessibleSelectable(
                                    selected = o.first == sel,
                                    role = Role.RadioButton,
                                    onSelect = { onSelect(o.first); open = false },
                                )
                                .padding(horizontal = 16.dp, vertical = 12.dp)
                                .pointerInput(o.first) { detectTapGestures { onSelect(o.first); open = false } },
                            verticalAlignment = Alignment.CenterVertically) {
                            BasicText(o.second, Modifier.weight(1f),
                                      style = TextStyle(color = StackStyle.color("label"), fontSize = 17.sp))
                            if (o.first == sel) StackIcon("checkmark", 14.0, tint)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - <searchbar> (SearchBar.swift, 1:1)

@Composable
private fun SearchBarElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["bind"] ?: ""
    val raw = if (key.isEmpty()) null else el.ctl.boundValue(key)
    val text = if (raw == null) "" else JSE.string(raw)
    val tint = el.color("color", ElementDefaults.SEARCHBAR_TINT)
    val style = TextStyle(color = tint, fontSize = 17.sp)
    Row(
        Modifier.elementStyle(el).then(Modifier.fillMaxWidth())
            .background(StackStyle.material("regular"), RoundedCornerShape(50))    // the material capsule …
            .background(StackStyle.color("fill"), RoundedCornerShape(50))          // … under secondarySystemFill
            .padding(horizontal = ElementDefaults.SEARCHBAR_PAD_H.dp, vertical = ElementDefaults.SEARCHBAR_PAD_V.dp),
        horizontalArrangement = Arrangement.spacedBy(ElementDefaults.SEARCHBAR_SPACING.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StackIcon("magnifyingglass", 17.0, StackStyle.color("secondary"))
        BasicTextField(
            value = text,
            onValueChange = { if (key.isNotEmpty()) el.ctl.setBound(key, it) },    // on:change via the setBound seam
            modifier = Modifier.weight(1f),
            textStyle = style,
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { el.run("submit") }),    // return key → on:submit
            cursorBrush = SolidColor(tint),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) {
                        BasicText(DSXStrings.localize(el.str("placeholder", "Search")),
                                  style = style.copy(color = StackStyle.color("secondary")))
                    }
                    inner()
                }
            },
        )
        if (text.isNotEmpty()) {
            val clear = {
                if (key.isNotEmpty()) el.ctl.setBound(key, "")                     // → on:change to empty
                el.run("clear")                                                    // → on:clear
            }
            Box(Modifier
                .dsxAccessibleActivation(
                    role = Role.Button,
                    contentDescription = DSXStrings.localize("Clear"),
                    mergeDescendants = false,
                    onClick = clear,
                )
                .pointerInput(Unit) { detectTapGestures { clear() } }) {
                StackIcon("xmark.circle.fill", 17.0, StackStyle.color("secondary"))
            }
        }
    }
}
