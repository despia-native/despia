//
//  StackSystemControls.kt — the SYSTEM CONTROL path for the input/readout/list elements
//  (system-defaults.md; the StackButtons.kt sibling, same philosophy): a fully-UNSTYLED
//  element renders the REAL Material 3 component, and ANY authored styling keeps the
//  legacy foundation-drawn view (StackInputViews.kt / the flat list) byte-identical —
//  the inert-landing invariant. Per element:
//
//    toggle/switch  → M3 `Switch`                    (iOS: the native UISwitch, always)
//    slider         → M3 `Slider`                    (iOS: the native UISlider, always)
//    spinner        → M3 `CircularProgressIndicator` (iOS: the native ProgressView, always)
//    progress       → M3 `LinearProgressIndicator`   (iOS: a custom capsule — Progress.swift)
//    list (vertical, scrolling) → real M3 `ListItem` rows (iOS: real SwiftUI `List`)
//
//  THE GATES are pure, plain-JVM-tested allowlists (StackSystemControlsTest):
//    • `SystemControl` — the shared SAFE base (identity/visibility/motion/a11y + the
//      on:/arg:/aria- prefixes) plus each element's own content words (bind/min/max/value).
//      `color=` is admitted ONLY where iOS keeps the authored tint ON the system control:
//      spinner (`ProgressView().tint(...)` — SpinnerElement.swift) and progress (the
//      capsule's tint — Progress.swift:15). THE TINT DECISION (stated, per the task):
//      an authored color on spinner/progress rides the M3 component as its indicator
//      color (progress keeps the fixture's tint@0.2 track relationship) — matching iOS,
//      where color never ejects those two off the system rendering. On toggle/slider the
//      authored color EJECTS to the legacy view instead (the SystemButton word-less rule:
//      pre-law color= styled the custom control and must keep doing exactly that;
//      cross-renderer divergence — iOS tints its native control — pinned here, the
//      StackButtons.kt precedent).
//    • `SystemList` — the List.swift allowlist COPIED TO THE WORD (List.swift ~230-264):
//      element attrs (post-cascade) AND the row template's root attrs (raw) must all be
//      known look-free words; horizontal / scroll="false" eject; at RENDER time a
//      scrolling/hugging ancestor (`LocalInScrollContainer` — the stackInScrollContainer
//      twin) keeps the flat pre-law path, exactly like iOS's ScrollAwareSystemList.
//
//  ── DEVIATIONS from the Swift twins (pinned, none silent) ────────────────────────────
//  • Metrics follow the CROSS-PLATFORM fixture contract where it conflicts with the M3
//    native metric (the StackButtons iconSize-20 precedent): the spinner renders the real
//    CircularProgressIndicator at the fixture's 20dp/2dp stroke (M3's native 40dp would
//    inflate every existing layout), progress at the fixture height 6 (M3's 4). The
//    Switch/Slider keep their own M3 metrics (Switch 52×32 vs the pinned UISwitch 51×31 —
//    the platform's own control at its own size, exactly like iOS renders UISwitch).
//  • Colors are passed EXPLICITLY from StackTheme's scheme (ambient MaterialTheme as the
//    fallback) so module surfaces that mount without the wrapper still resolve the
//    stamped roles — the StackButtons.kt rule. Track defaults the M3 component owns
//    (spinner/linear track) stay the component's, never re-specified.
//  • NO SIDEBAR-COLUMN ARM — the `<list>` context resolution has no Android twin, and the
//    absence is the honest answer, not a gap. iOS's baseline is `List` `.automatic`, ONE API
//    that resolves to two OS-drawn looks: `.sidebar` when the List is the content of a
//    NavigationSplitView sidebar column, `.insetGrouped` everywhere else — so List.swift reads
//    the `dsxInSidebarColumn` seam the Scaffold stamps and states that resolution explicitly.
//    Material 3 has no such fork to reproduce:
//      – Compose has NO list-style vocabulary at all. `LazyColumn`/`Column` are styleless, and
//        the M3 row components (`ListItem`, and 1.5's `InteractiveListItem`) each paint one
//        fixed identity chosen by the CALL SITE — there is no `.automatic` to context-resolve
//        and no M3 spec for "a list rendered differently because it sits in a side pane".
//        (Checked against the resolved artifact, material3-android 1.5.0-alpha08: the public
//        composable set carries no list-style/`Form`/section container of any kind.)
//      – The nearest M3 side-pane components — `PermanentDrawerSheet` + `NavigationDrawerItem`
//        (a 56dp full-round selection pill), `NavigationRail`, the `material3-adaptive`
//        `ListDetailPaneScaffold` — are NAVIGATION components with navigation semantics. A DSX
//        `<list>` in `pane="sidebar"` is arbitrary bound data, not a declared destination set,
//        so painting drawer-item chrome onto it would guess intent AND re-specify a look from
//        authored values — exactly the two things system-defaults.md forbids. (`material3-
//        adaptive` is not even on :render's dependency list; pulling an artifact in to fake a
//        look M3 does not define would be the faked twin twice over.)
//      – The scaffold's split here is a plain `Row` of `Column` panes (Containers.kt), not a
//        drawer sheet, so there is no M3 container context to INHERIT a look from either.
//    RESULT: an unstyled `<list>` renders the SAME M3 `ListItem` identity in every context on
//    Android — split sidebar pane, detail pane, or a plain page. That is the platform's one
//    list identity, faithfully; the iOS two-arm resolution is the DIVERGENCE, pinned here. The
//    consumer-side note and the re-entry point (if M3 ever defines an in-pane list rendering)
//    live in Containers.kt's header beside the pane helper.
//  • Material 3 defines a row component, not a list container. The renderer therefore keeps
//    the EXISTING keyed `LazyColumn` for virtualization and gives every system-path row to
//    the real M3 `ListItem`. It does not recreate iOS inset-grouped cards, corner radii,
//    separators, or row metrics from foundation primitives. ListItem owns its container,
//    typography slots, padding, and minimum height. The LIST-CONSTRUCT path (`group_by`
//    sections · swipe row actions · drag reorder — elements/ListElements.kt) calls the SAME
//    `SystemMaterialListItem`, including the sliding foreground of a swipe row. A vertical
//    scroll ancestor still ejects first because nesting a LazyColumn is a Compose error.
//

package despia.engine.render

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchColors
import androidx.compose.material3.SwitchDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.StackNode
import despia.engine.StackStore

// MARK: - the in-scroll signal (the Stack.swift StackInScrollContainerKey twin, ~4084-4099)

/// TRUE inside a scrolling / hugging container: the `<scroll>` branch stamps it around its
/// content, and the sheet's fit-content slot (`detents="content"`, Sheets.kt) stamps its
/// measured scroll. A descendant whose SYSTEM rendering would be its own lazy list (the
/// unstyled `<list>` default) reads it and keeps the flat pre-law path there — on iOS
/// because a greedy `List` collapses under the unbounded proposal (the collapsed-paywall
/// bug class), here additionally because a LazyColumn may never nest inside a vertical
/// scroll (a Compose measurement error). Same consumers, same stampers as iOS.
internal val LocalInScrollContainer = compositionLocalOf { false }

/// Marks the subtree hosted by the headline slot of a real Material `ListItem`. DSX text
/// normally keeps the framework's platform-neutral body default. Inside a Material row it must
/// instead use Material's headline/supporting type roles, otherwise `BasicText` bypasses the
/// `ListItem` slot's `LocalTextStyle` and every line renders with the same visual weight.
internal val LocalSystemMaterialListItem = compositionLocalOf { false }

// MARK: - the pure gates (plain-JVM tested — StackSystemControlsTest)

/// The per-element system-path gate for the bound controls/readouts — the SystemButton
/// allowlist direction: an attribute passes only when it is a KNOWN look-free word; every
/// styling arm (the cascade has already folded classes/sheets/inline CSS into plain keys)
/// and every unknown/future attribute ejects to the legacy view byte-identically.
object SystemControl {

    // The always-safe base — identity, visibility/motion (they wrap OUTSIDE raw()), and
    // accessibility. `class`/`css-owner` are safe BARE (their styling, if any, was folded
    // into plain keys by resolvedAttrs and ejects as those keys — the SystemButton rule).
    private val SAFE_BASE = setOf(
        "id", "key", "class", "css-owner",
        "visible-if", "keep", "enter", "anim", "animDuration", "transition",
        "a11yGroup", "a11yLabel", "a11yHint", "a11yValue", "a11yTrait", "a11yHidden",
    )
    private val COMPAT_PREFIXES = listOf("on:", "arg:", "aria-")

    /// Each element's own content words on top of the base (see header — `color` appears
    /// exactly where iOS keeps the authored tint on the system control).
    val TOGGLE: Set<String> = setOf("bind")
    val SLIDER: Set<String> = setOf("bind", "min", "max")
    val SPINNER: Set<String> = setOf("color")
    val PROGRESS: Set<String> = setOf("bind", "value", "color")

    fun rendersSystem(attrs: Map<String, String>, allowed: Set<String>): Boolean =
        attrs.keys.all { k ->
            k in SAFE_BASE || k in allowed || COMPAT_PREFIXES.any { k.startsWith(it) }
        }
}

/// The system-list gate — the List.swift allowlist copied to the word (List.swift
/// `systemSafeAttrs`/`systemSafePrefixes`/`unstyled`, ~230-264): TRUE only when the list
/// element AND its row template's root carry nothing but allowlisted look-free words and the
/// axis is vertical. `rendersSystem` additionally requires scrolling for the LazyColumn
/// container; `rendersSystemRows` preserves real Material ListItem identity in an eager
/// `scroll="false"` Column used by measured sheets. The list element's attrs arrive POST-cascade
/// (class/sheet styling already folded to plain keys); the row template's are RAW — which
/// is exactly why unknown words, `class`/`style` themselves included, must eject there.
/// The scroll-ancestor half of the gate is read at RENDER time (`LocalInScrollContainer`),
/// like iOS's ScrollAwareSystemList.
object SystemList {

    enum class TextRole { HEADLINE, SUPPORTING }

    val SYSTEM_SAFE_ATTRS: Set<String> = setOf(
        "bind", "key", "id",
        "axis", "direction", "scroll", "autoscroll",
        "group_by", "groupBy", "swipeLeading", "swipeTrailing",
        "swipeFullLeading", "swipeFullTrailing", "reorder",
        "visible-if", "role", "width", "height", "grow",
        "keep", "enter", "anim", "transition",
        // The auto-stamped component identity — allowed BY ITSELF because it is inert
        // without a class/style carrier (List.swift's own rationale, verbatim).
        "css-owner",
    )
    val SYSTEM_SAFE_PREFIXES: List<String> = listOf("on:", "arg:", "aria-", "a11y")

    fun systemSafe(key: String): Boolean =
        key in SYSTEM_SAFE_ATTRS || SYSTEM_SAFE_PREFIXES.any { key.startsWith(it) }

    fun rendersSystemRows(attrs: Map<String, String>, rowAttrs: Map<String, String>): Boolean {
        if (attrs["axis"] == "horizontal" || attrs["direction"] == "horizontal") return false
        if (!attrs.keys.all { systemSafe(it) }) return false
        if (!rowAttrs.keys.all { systemSafe(it) }) return false
        return true
    }

    fun rendersSystem(attrs: Map<String, String>, rowAttrs: Map<String, String>): Boolean =
        attrs["scroll"] != "false" && rendersSystemRows(attrs, rowAttrs)

    /// Semantic headings are the row's headline; ordinary copy is supporting content. This is
    /// deliberately driven by the existing cross-platform accessibility contract instead of
    /// guessing from child order or page-specific tags.
    fun textRole(attrs: Map<String, String>): TextRole {
        val traits = attrs["a11yTrait"].orEmpty().split(",").map { it.trim() }
        return if ("header" in traits) TextRole.HEADLINE else TextRole.SUPPORTING
    }
}

// MARK: - the real M3 controls (inputs arrive RESOLVED from the dispatch site; `m`
// carries decorate + StackStyle.apply — with no style attrs present, no visuals)

/// The M3 switch colors, explicit from the stamped scheme (the M3 SwitchTokens defaults —
/// selected onPrimary/primary, unselected outline/surfaceContainerHighest). Shared with
/// the `<field type="toggle">` row (Forms.kt) so form chrome and the element can't drift.
@Composable
internal fun systemSwitchColors(): SwitchColors {
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    return SwitchDefaults.colors(
        checkedThumbColor = cs.onPrimary,
        checkedTrackColor = cs.primary,
        uncheckedThumbColor = cs.outline,
        uncheckedTrackColor = cs.surfaceContainerHighest,
        uncheckedBorderColor = cs.outline,
    )
}

/// toggle/switch — the real M3 `Switch` over the same bind seam as the legacy capsule.
@Composable
internal fun M3ToggleView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val bindKey = a["bind"]
    val on = bindKey?.let { JSE.truthy(ctl.boundValue(it)) } ?: false
    Switch(checked = on,
           onCheckedChange = { if (bindKey != null) ctl.setBound(bindKey, it) },   // on:change rides the seam
           modifier = m,
           colors = systemSwitchColors())
}

/// slider — the real M3 `Slider`; bind/min/max wiring identical to the legacy track
/// (value clamped into the range; the degenerate hi==lo range gets the iOS BoundSlider
/// epsilon — `max(hi, lo + 0.0001)`, Slider.swift). Writes land per change like the
/// legacy drag (the iOS ~12/s throttle is that platform's own control behavior).
@Composable
internal fun M3SliderView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val bindKey = a["bind"]
    val min = ctl.num("min") ?: ElementDefaults.SLIDER_MIN
    val max = ctl.num("max") ?: ElementDefaults.SLIDER_MAX
    val lo = minOf(min, max)
    val hi = maxOf(max, lo + 0.0001)
    val value = (bindKey?.let { JSE.number(ctl.boundValue(it)) } ?: lo).coerceIn(lo, hi)
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    Slider(value = value.toFloat(),
           onValueChange = { if (bindKey != null) ctl.setBound(bindKey, it.toDouble()) },
           modifier = m,
           valueRange = lo.toFloat()..hi.toFloat(),
           colors = SliderDefaults.colors(
               thumbColor = cs.primary,
               activeTrackColor = cs.primary,
               inactiveTrackColor = cs.surfaceContainerHighest))
}

/// spinner — the real M3 `CircularProgressIndicator` at the FIXTURE metric (20dp, 2dp
/// stroke — the header's metric rule). Uncolored = the component's own theme color
/// (M3 primary — the platform's own choice; iOS's untinted ProgressView is ITS gray);
/// an authored color rides it as the indicator color — the compatible tint, the iOS
/// `ProgressView().tint(...)` twin (SpinnerElement.swift). The track keeps the
/// component's own default, never re-specified.
@Composable
internal fun M3SpinnerView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val author = ctl.interp("color")
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    CircularProgressIndicator(
        modifier = m.then(Modifier.size(ElementDefaults.SPINNER_SIZE.dp)),
        color = author?.let { StackStyle.color(it) } ?: cs.primary,
        strokeWidth = ElementDefaults.SPINNER_STROKE.dp)
}

/// progress — the real M3 `LinearProgressIndicator`, determinate from bind=/value=
/// (clamped 0…1 like both twins), at the fixture height 6. The tint rule matches the
/// spinner (the header's stated decision): an authored color is the indicator color and
/// keeps the fixture's tint@0.2 track relationship (Progress.swift:19); uncolored rides
/// the component's own colors (primary + its own track).
@Composable
internal fun M3ProgressView(a: Map<String, String>, modifier: Modifier, ctl: BoundControl) {
    val m = modifier
    val v = (a["bind"]?.let { JSE.number(ctl.boundValue(it)) } ?: ctl.num("value") ?: 0.0)
        .coerceIn(0.0, 1.0)
    val tint = ctl.interp("color")?.let { StackStyle.color(it) }
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    LinearProgressIndicator(
        progress = { v.toFloat() },
        modifier = m.then(Modifier.fillMaxWidth().height(ElementDefaults.PROGRESS_HEIGHT.dp)),
        color = tint ?: cs.primary,
        trackColor = tint?.copy(alpha = ElementDefaults.PROGRESS_TRACK_OPACITY.toFloat())
            ?: ProgressIndicatorDefaults.linearTrackColor)
}

// MARK: - the real Material 3 list row

/// The one system-list row primitive. Material 3 has no List container: `LazyColumn` owns
/// virtualization while the real `ListItem` owns row identity and metrics. Keeping this
/// function shared prevents ordinary, grouped, swipe, and reorder lists from drifting.
@Composable
internal fun SystemMaterialListItem(modifier: Modifier = Modifier,
                                    content: @Composable () -> Unit) =
    ListItem(
        headlineContent = {
            CompositionLocalProvider(LocalSystemMaterialListItem provides true) { content() }
        },
        modifier = modifier.fillMaxWidth(),
    )

/// The unstyled vertical list's SYSTEM rendering: the EXISTING keyed LazyColumn (same
/// keys and on:reachEnd decoration) containing genuine M3 ListItem rows. Row spacing is
/// structurally 0 — `spacing=` ejects before this path is reached.
@Composable
internal fun SystemMaterialList(b: Bound, modifier: Modifier, reachEnd: String?, template: StackNode,
                                store: StackStore, env: JSERunner) {
    val m = modifier
    LazyColumn(m.then(Modifier.fillMaxWidth())) {
        items(count = b.rows.size, key = { b.keys[it] }) { i ->
            val last = i == b.rows.size - 1
            SystemMaterialListItem {
                StackNodeView(template, store, env, b.item(i), b.writer(i))
            }
            if (reachEnd != null && last) {
                LaunchedEffect(b.keys[i]) { env.run(reachEnd, b.item(i)) }
            }
        }
    }
}
