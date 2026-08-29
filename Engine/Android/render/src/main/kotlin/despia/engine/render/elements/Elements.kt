//
//  Elements.kt — the INPUT/DISPLAY element WAVE: registration + the shared seams every
//  family file rides. Each family lives in ONE file under elements/ and registers its
//  tags into ComposeStackComponents (`defineNative` for tags the raw() switch does not
//  claim; `definePrivileged` where a raw() branch must be SHADOWED — the sanctioned slot,
//  see StackNodeView.kt's own header: "a future registration simply shadows the branch").
//
//  REGISTRATION — `InputElements.register()` (idempotent), the exact sibling shape of
//  StackElements.register() (the structure/overlay wave in this folder). Call sites
//  today: RenderSmokeInputs (the compile gate) + the plain-JVM units. The production
//  boot hookup is the SAME one-line follow-up as StackElements' (hosts are bootloaders;
//  the generated registry is owned by prepare_modules_android.rb) — wire both waves in
//  one place. A module setup() that defines the same tag later still wins (define*
//  replaces), exactly like iOS launch ordering.
//
//  THE ONE CONTRACT every family follows (the Charts/Maps/SwiftyGif precedent): the
//  registered slot bypasses the renderer's private decorate()/style pass, so each element
//  re-applies the public halves itself via `elementModifier()` below — decorate (on:tap /
//  on:longpress, runGated + arg:* payload) + the universal style chain (StackStyle.apply).
//  Two-way state rides the ONE bind seam (BoundControl.boundValue/setBound — Swift's
//  `dsx.boundValue`/`dsx.setBound`), so `on:change` fires from the write seam only, on an
//  actual change, loop-guarded — never raised by an element by hand.
//
//  Kotlin twins in this wave (iOS source of truth in parentheses — the Swift numbers are
//  replicated literally, see each family header):
//    stars (Stars.swift) · otp (OTP.swift) · rangeslider (RangeSlider.swift) ·
//    Checkbox/checkbox (Checkbox.swift) · RadioGroup (RadioGroup.swift) ·
//    segmentedButton (SegmentedButton.swift) · stepper (Stepper.swift) ·
//    wheelpicker (WheelPicker.swift) · combobox (Combobox.swift) ·
//    datepicker/date (DatePicker.swift) · calendar (Calendar.swift) ·
//    image (Image.swift + DSXImageCache.swift — REAL src=/asset= loading) ·
//    svg (SVG.swift — the zero-dep native parser) · qrcode (QRCode.swift, ZXing-core) ·
//    list horizontal rail + autoscroll marquee (List.swift + Stack.swift StackMarquee).
//
//  Files live under elements/ but stay in package despia.engine.render — same module,
//  same internal seams (BoundControl, StackIcon, decorate, StackStyle), no new API.
//

package despia.engine.render.elements

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import despia.engine.JSE
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.render.BoundControl
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.StackStyle
import despia.engine.render.decorate
import despia.engine.render.registerCanvasElement

// MARK: - registration (the StackElements.register() sibling — see header)

object InputElements {
    @Volatile private var registered = false

    /// Register every input/display element of this wave. Idempotent (define* replace).
    fun register() {
        if (registered) return
        synchronized(this) {
            if (registered) return
            registerRatingElements()        // stars
            registerOtpElements()           // otp
            registerRangeSliderElements()   // rangeslider
            registerChoiceElements()        // Checkbox/checkbox · RadioGroup · segmentedButton
            registerStepperElements()       // stepper
            registerPickerElements()        // wheelpicker · combobox
            registerDateElements()          // datepicker/date · calendar
            registerImageElements()         // image (privileged — shadows the placeholder branch)
            registerSvgElements()           // svg
            registerQrElements()            // qrcode
            registerSceneElements()         // scene (dsx-scene.md P2 — the shared software rasterizer)
            registerCanvasElement()         // canvas (parity/U04 — the 2-D drawing surface)
            registerListElements()          // list (privileged — adds horizontal rail + marquee)
            registered = true
        }
    }
}

// MARK: - the shared context face (what Swift's StackComponentContext hands a component)

/// This element's bound-control face (boundValue/setBound/fire — the ONE bind seam).
internal fun ComposeStackComponentContext.control(): BoundControl =
    BoundControl(componentTag, attrs, store, env, item, rowWrite)

/// Interpolated attribute read — Swift `dsx.string(key)` (`{{ }}` resolves live).
internal fun ComposeStackComponentContext.interp(key: String): String? =
    attrs[key]?.let { JSE.interpolate(it, store, item) }

internal fun ComposeStackComponentContext.str(key: String, default: String = ""): String =
    interp(key)?.takeIf { it.isNotEmpty() } ?: default

internal fun ComposeStackComponentContext.num(key: String): Double? =
    interp(key)?.let { JSE.number(it) }

internal fun ComposeStackComponentContext.bool(key: String, default: Boolean = false): Boolean =
    interp(key)?.let { it == "true" } ?: default

/// The public halves the registered slot bypasses (see header): decorate (on:tap /
/// on:longpress with gating + arg:* payload — reused from the renderer, identical
/// dispatch) + the universal style chain. Every element attaches this OUTERMOST.
internal fun Modifier.elementModifier(ctx: ComposeStackComponentContext): Modifier {
    val n = ctx.node ?: StackNode(ctx.componentTag, ctx.attrs, emptyList())
    return decorate(n, ctx.attrs, ctx.store, ctx.env, ctx.item)
        .then(StackStyle.apply(ctx.attrs, ctx.store, ctx.item, ctx.componentTag))
}

/// Resolve a bound LIST key exactly like the collections' bind (`dsx.bind.list` twin):
/// row-local `item.*` / `dsx.this.*` first, else path-aware into the store.
internal fun bindList(key: String?, store: StackStore, item: Map<String, Any?>?): List<Map<String, Any?>> {
    if (key.isNullOrEmpty()) return emptyList()
    val k = BoundControl.rowKey(key)
    if (k.startsWith("item.") && item != null) return JSE.asRows(item[k.substring(5)])
    return JSE.asRows(JSE.eval(key, store, item))
}

/// Options resolution shared by wheelpicker/combobox/RadioGroup — EXACTLY the iOS Picker
/// grammar: a bound list via `optionsKey` (`valueField`/`labelField`, default id/label)
/// or a static/interpolated CSV in `options` (value == label, cells trimmed).
internal fun ComposeStackComponentContext.resolveOptions(): List<Pair<String, String>> {
    val lk = attrs["optionsKey"]
    if (lk != null) {
        val vf = attrs["valueField"] ?: "id"
        val lf = attrs["labelField"] ?: "label"
        return bindList(lk, store, item).map { JSE.string(it[vf] ?: "") to JSE.string(it[lf] ?: "") }
    }
    return ElementMath.csv(str("options")).map { it to it }
}

// MARK: - keep="true" hit-blocking (the visibilityBody twin's missing half)

/// Swift: `content.opacity(0).allowsHitTesting(false)` while keep-hidden. Compose has no
/// hit-test opt-out, so the twin CONSUMES every pointer event in the Initial pass (parents
/// see Initial before children), which cancels the subtree's gesture detectors — the
/// hidden element and everything inside it go inert. PINNED DIVERGENCE: iOS lets the
/// touch fall THROUGH to whatever is behind; here the dead element still occludes
/// (Compose dispatches to the front-most hit path only) — inert either way, pass-through
/// behind a keep-hidden overlay is the remaining delta.
internal fun Modifier.blockHits(): Modifier = this.pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            event.changes.forEach { it.consume() }
        }
    }
}

// MARK: - the pure math half (plain-JVM tested — ElementsLogicTest.kt)

internal object ElementMath {

    /// Swift `split(separator: ",").map { trim }` — CSV cells, blanks dropped.
    fun csv(s: String): List<String> = s.split(",").map { it.trim() }.filter { it.isNotEmpty() }

    /// One star cell's fill fraction: `clamp(value - index, 0, 1)` (Stars.swift).
    fun starFraction(value: Double, index: Int): Float =
        (value - index).coerceIn(0.0, 1.0).toFloat()

    /// OTP bind clamp: digits only, at most `length` (OTP.swift's setter).
    fun otpClamp(raw: String, length: Int): String =
        raw.filter { it.isDigit() }.take(length)

    /// segmentedButton toggle (SegmentedButton.swift): multi flips `id` inside the CSV
    /// (re-joined in OPTION order so the stored CSV is stable); single replaces (tapping
    /// the current selection clears).
    fun segmentedToggle(selectedCsv: String, id: String, options: List<String>, multiple: Boolean): String {
        val selected = selectedCsv.split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        val next: List<String> = if (multiple) {
            val s = selected.toMutableSet()
            if (!s.remove(id)) s.add(id)
            options.filter { it in s }
        } else {
            if (id in selected) emptyList() else listOf(id)
        }
        return next.joinToString(",")
    }

    /// RangeSlider value-at-x (RangeSlider.swift `value(at:)`): fraction across the FULL
    /// range, snapped on a grid anchored at `min` (never 0), clamped to the thumb's
    /// sub-window that keeps low ≤ high.
    fun rangeValue(fraction: Double, rangeMin: Double, span: Double, step: Double?,
                   clampLo: Double, clampHi: Double): Double {
        var v = rangeMin + fraction.coerceIn(0.0, 1.0) * span
        if (step != null && step > 0) v = rangeMin + Math.round((v - rangeMin) / step) * step
        return v.coerceIn(clampLo, clampHi)
    }
}
