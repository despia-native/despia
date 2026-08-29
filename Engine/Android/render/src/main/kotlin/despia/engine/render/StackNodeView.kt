//
//  StackNodeView.kt — the recursive DSX node renderer in Jetpack Compose. Kotlin twin of
//  Stack.swift's renderer section (`StackRootView` / `StackNodeView` / `raw()` / `decorate()`,
//  OpenSource/Engine/iOS/Stack.swift ~3389-4280); same names, same dispatch order, same attribute
//  contract (StackReference.md). The kernel AST/JSE halves are :core (`despia.engine`).
//
//  REACTIVITY — the @ObservedObject twin: each node collects its surface store AND the
//  app-wide `DSX.state` directly from State.kt's `varsFlow`. Reading each collected State in
//  composition creates a real Compose invalidation edge, so a `dsx.variable` write re-renders
//  exactly like iOS. Do not hide the reads behind an empty helper: release optimization can
//  erase that apparent dependency and leave rendered bindings stale after healthy writes.
//
//  THIS WAVE (K4 core set): structural/declaration tags register-and-skip; components resolve
//  through ComposeStackComponents (the :render twin of Stack.swift's StackComponents registry);
//  rendered elements are vstack/hstack/zstack/stack, text/label, image (icon fallback here —
//  the REAL element, src=/asset= + content-plane cache, is elements/ImageElements.kt's
//  privileged registration), button/
//  glassButton/transport/pressable/row, spacer, divider, scroll — plus visible-if, {{ }}
//  interpolation, on:tap (debounce/throttle-gated), on:appear/on:disappear/on:longpress.
//  PLUS the data plane: the bound containers list/grid/pager/tabs (keyed rows, per-row `item`
//  scope with write-back — the Bound twin of PrivilegedStackComponentContext.bound()), the
//  `<watch>` observer, and the two-way inputs toggle/textfield/slider (+ progress/spinner)
//  in StackInputViews.kt, all riding the one bind seam (BoundControl.boundValue/setBound).
//
//  ── DEVIATIONS from the Swift twin (each pinned, none silent) ───────────────────────────
//  • `<action as=…>` (parameterized head actions) registers through :core's public seam
//    `StackStore.registerAction` (JseRunner.kt — the public face of Swift's direct
//    `store.actions[name] =` write); inputs/override/invocation semantics are byte-identical
//    (registerHeadAction below). `function name(){…}` bodies register via JSE.registerFunctions.
//  • `store.classes` / `store.overrides` (legacy style classes, dsx.node overrides) don't
//    exist on the Kotlin StackStore — they live in a :render sidecar here (RenderStoreFields,
//    the same WeakHashMap pattern as JseRunner's runnerFields), call-site-identical
//    (`store.classes[name]`).
//  • The attrs cascade now implements ALL FOUR layers (Stack.swift `attrs`, ~3885-3973):
//    1 legacy classes → 2 the component's compiled DSX-CSS sheet (css-owner stamp, class
//    match) → 3 inline DSX-CSS (a style value containing ':') → 4 element attrs + dsx.node
//    overrides — plus the structural translations (axis-correct gap → spacing, explicit
//    `align` beats CSS align-items, display:none → the css-hidden channel). The engine is
//    the :core CSSEngine/CSSResolver/CSSBridge/CSSInline/CSSValue twins; the environment
//    (dark / window dp / font scale / reduce motion) is read from the Compose environment
//    here (cssEnvironment() — the tracked-dependency twin of iOS's @Environment reads).
//    Sheet/theme DELIVERY is the generated registry (prepare_modules_android.rb §5f →
//    despia/registry/DSXCSSStyles.generated.kt — the iOS GeneratedDSXCSS twin, same
//    compiler, byte-identical IR): GeneratedModules.register() fills the :core
//    CSSEngine.register/registerTheme seam at boot, so layer 2 resolves the compiled
//    component sheets + theme var() table. Inline CSS (layer 3) is fully live.
//  • resolvePlatform: `key:android` wins HERE (Swift keeps `key:ios`) — that is the Swift
//    header's own documented contract for this renderer.
//  • enter=/transition=/anim=/keep fades are LIVE (StackMotion.kt — the StackEntry /
//    StackStyle.animation/transition twins; per-property divergences pinned in ITS header):
//    transition=/anim= ride AnimatedVisibility on the visible-if flip (kept composed while
//    the exit runs, dropped once settled — no phantom gap in spaced stacks), keep="true"
//    animates opacity (anim= override, default easeOut 0.18 s) + blocks touches while
//    hidden (elements/Elements.kt `blockHits`), enter= is the one-shot graphicsLayer entry.
//    keep=/enter= ride a hugging wrapper Box (NodeContent) — iOS wraps OUTSIDE raw(), and
//    the registered-element dispatch drops `m`, so the wrapper is what reaches every tag.
//    List rows animate exactly like iOS: a row template carries its own enter=/transition=
//    and each row is a full StackNodeView — no separate list-item system on either OS.
//  • `<attribute on:change>` observers LANDED: an `<attribute as=x on:change=…>` mounts the
//    same WatchView over `dsx.attribute.x` that Swift returns (Stack.swift ~5467-5476), so a
//    LIVE re-seed (Router.pushNative/presentModal attrs, `route.updateComponent`) fires the
//    observer exactly like a store write — the former deferral is closed.
//  • DRAG/MEASURE/ADJUST decorations LANDED (the custom-control triad — build a slider / seek
//    bar / knob out of markup, with no system control): `on:drag`/`on:dragStart`/`on:dragEnd`
//    (the StackDrag twin, incl. SwiftUI's minimumDistance-0 press-fires-too contract, which
//    Compose's slop-gated detectDragGestures cannot express — the raw awaitEachGesture+drag
//    pair does), `measure=` (onSizeChanged → an elided state write), `on:adjust` (TalkBack
//    custom actions where iOS gets the .adjustable trait). Per-decoration divergences are
//    pinned at each implementation below. STILL DEFERRED: element-level
//    `on:swipeLeading/Trailing` (iOS's `.swipeActions` is a List-row modifier; the `<list>`
//    construct's rails already landed — elements/ListElements.kt), `container`
//    (`dsx.element.*` — a descendant SCOPE injection, not a modifier) and `passthrough="true"`.
//  • Containers/inputs land as `raw()` BRANCHES (not registered privileged components) —
//    the dispatch slot for registered orchestrators stays first, so a future registration
//    simply shadows the branch. `<node tag="list">` (a data-driven container) is TODO with
//    that registration. The `<list>` CONSTRUCT features (group_by sections · swipe row
//    actions · drag reorder + on:move) LANDED on the registered orchestrator
//    (elements/ListElements.kt — divergences pinned in its header); `<grid>` swipe/reorder,
//    pager dots and tabIcon glyphs are still
//    TODO (`on:submit`/`on:focus`/`on:blur` on textfield LANDED — StackInputViews.kt, the
//    focus/IME pass: submit on the IME action, then end-editing → blur). Grid default columns = 3
//    (StackReference; the sketch said 2 — the reference wins). Pager: `bind=` OR `value=`
//    is the two-way page index (StackReference names it `value`; `bind` accepted as the
//    task's spelling); data-bound pages (`bind` + `key` rows) ride the list registration.
//  • spacer: Compose weight() is stack-scope-only, so flexible spacers are emitted by the
//    parent stack loop (Children in Column/Row scope); a sized spacer renders normally.
//  • vstack/hstack default spacing: SwiftUI "system" spacing ≈ 8pt — pinned to 8dp
//    (the generic `<stack>` is web-true: unset gap = 0).
//  • Buttons: the StackButtonStyle press-scale (0.92 on easeOut 0.12 s — StackMotion.PRESS_SNAP)
//    LANDED on the LEGACY/authored path, which is exactly where iOS applies StackButtonStyle;
//    an UNSTYLED button takes the M3 branch and wears the platform state layer instead
//    (system-defaults.md). Two narrow divergences pinned at the implementation (the M3 ripple
//    stays; the scale is the box's innermost arm, so padding/frame don't travel with it). Tap
//    dispatch and gating are 1:1 (`runGated`, gateKey "<tag>.tap"). The `<pressable>`
//    multi-gesture pair (on:doubleTap / on:longPress / on:longPressEnd) LANDED — the
//    hand-rolled recognizer (StackPressable.kt: instant tap on every tap-up, additional
//    double, the 0.4 s balanced long lifecycle; machine JVM-pinned in
//    PressableGestureMachineTest, spec keys enforced by ElementParityTest).
//  • DIAGNOSTIC CARDS (unresolved literal tags, parse-failed `<node tag=…>` templates on test
//    channels — Stack.swift:5514,5527) have NO Android twin and are not a decoration wave:
//    they need the whole Diagnostics.swift kernel port (issue ledger + parse-failure recording
//    + the card + the drawer). The silent capability-boundary arm — the one that must stay
//    silent — is implemented and correct.
//  • SUBTREE SCHEME (this wave): `theme="dark|light"` + the authored-canvas luminance
//    derivation pin a node's subtree scheme (NodeContent → StackTheme.ForcedSchemeSubtree
//    — the Stack.swift theme=/derivedScheme twins); the SYSTEM CONTROL path renders real
//    M3 components for unstyled toggle/slider/spinner/progress and real M3 `ListItem`
//    rows for the unstyled vertical list (StackSystemControls.kt — gates, tint decision, and
//    the LocalInScrollContainer scroll-ancestor signal stamped by `scroll` + the sheet's
//    fit-content slot).
//

package despia.engine.render

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.Badge
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView
import despia.engine.RefRegistry
import despia.engine.TypeRamp
import despia.engine.StackRef
import despia.engine.input.DsxInputRuntime
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import despia.engine.ApiGraph
import despia.engine.CSSEngine
import despia.engine.CSSInline
import despia.engine.CSSResolver
import despia.engine.DSX
import despia.engine.DSXCookies
import despia.engine.DSXStrings
import despia.engine.DSXBusDispatch
import despia.engine.DSXDispatchVerdict
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.LayoutSemantics
import despia.engine.StackDensity
import despia.engine.OnHandler
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.ScreenReadiness
import despia.engine.OverrideDecl
import despia.engine.SlotContent
import despia.engine.StackDiagnostics
import despia.engine.StackFormula
import despia.engine.StyleOverrides
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.StackTooltip
import despia.engine.StackTooltipLifecycle
import despia.engine.registerAction
import despia.engine.render.elements.SelectionControl
import despia.engine.render.elements.blockHits
import despia.engine.varsFlow
import despia.engine.writeBound
import java.util.WeakHashMap
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// MARK: - ComposeStackComponents — the :render twin of Stack.swift's StackComponents
// (XML-template components + native globals + the runtime registry + privileged
// orchestrators). Only the registration/resolution core lands this wave; the privileged
// orchestrators (list/grid/pager/tabs/scaffold) and native globals register into it as
// they are ported.

/// The context handed to a registered NATIVE component — twin of StackComponentContext
/// (Swift keeps a separate PrivilegedStackComponentContext; here `node` is carried on the
/// one type and privileged builders read it — collapse documented, split when the
/// orchestrators land).
class ComposeStackComponentContext(
    val node: StackNode?,
    val attrs: Map<String, String>,
    val store: StackStore,
    val env: JSERunner,
    val item: Map<String, Any?>?,
    val slot: SlotContent?,
    val nodeText: String?,
    val rowWrite: ((String, Any) -> Unit)?,
    val componentTag: String,
) {
    /// Call a module action over the bus — the twin of markup's `dsx.module.scheme.method(args)`
    /// and of Swift's `StackComponentContext.dispatch`. Read `.succeeded` to gate anything
    /// ([DSXDispatchVerdict]); `then` reports a settle that only arrives after a round trip.
    fun dispatch(call: String, args: Map<String, Any?> = emptyMap(),
                 then: ((DSXDispatchVerdict) -> Unit)? = null): DSXDispatchVerdict =
        DSXBusDispatch.run(call, args, then)

    /// Fire a haptic through the `haptic` module — the single owner, never a private vibrator.
    fun haptic(style: String): DSXDispatchVerdict = dispatch("haptic.$style")
}

object ComposeStackComponents {
    private class NodeDef(val template: StackNode, val scope: String?)

    private val lock = Any()
    private val nodeDefs = HashMap<String, NodeDef>()
    private val privileged = HashMap<String, @Composable (ComposeStackComponentContext) -> Unit>()
    private val natives = HashMap<String, @Composable (ComposeStackComponentContext) -> Unit>()

    /// Package-registered runtime surfaces (`dsx.stack.register`) — lowest precedence.
    val registry = HashMap<String, @Composable (Map<String, String>) -> Unit>()

    /// Register an XML-template component (a Components/Name.dsx file or an inline
    /// `<component as=…>`). `scope` = owning package; null = global. Idempotent (replaces).
    /// Every node is stamped with its owning component (`css-owner`) at registration,
    /// exactly like iOS StackComponents.append — the node→component identity the DSX-CSS
    /// sheet layer resolves against.
    fun defineNode(name: String, template: StackNode, scope: String?) {
        synchronized(lock) { nodeDefs["${scope ?: ""}::$name"] = NodeDef(stampCSSOwner(template, name), scope) }
    }

    /// Twin of Swift `StackComponents.stampCSSOwner` — a value-copied walk (the Kotlin
    /// node is a reference type, so the original parse tree stays untouched, matching
    /// Swift's value semantics). An explicit css-owner (nested component templates
    /// re-registered under a new name) is never overwritten.
    private fun stampCSSOwner(node: StackNode, name: String): StackNode {
        val attrs = if (node.attrs["css-owner"] == null) node.attrs + ("css-owner" to name) else node.attrs
        return StackNode(node.tag, attrs, node.children.map { stampCSSOwner(it, name) }, node.text)
    }

    /// Resolve a tag for a consumer in `pkg` — package-scoped first, then global.
    /// Returns (template, owningScope) like Swift's `StackComponents.resolve(_:pkg:)`.
    /// A QUALIFIED reference `<namespace.Name/>` addresses ONE scope explicitly, bypassing
    /// local-first resolution (Stack.swift resolve, the dot branch): `<shared.Name/>` /
    /// `<global.Name/>` → the universal pool (scope null); any other prefix → that package's
    /// component (scope = its scheme). This is what lets an UNSCOPED env — a Router-presented
    /// modal / pushed frame (RouterModalEntry / RouterHost build scope-less JSERunners) —
    /// reach a packaged component by name (`menubar.Bar`, `demo.Launcher`, the
    /// presentComponent/pushComponent verbs' wire form).
    fun resolve(tag: String, pkg: String?): Pair<StackNode, String?>? = synchronized(lock) {
        resolveLocked(tag, pkg)
    }

    private fun resolveLocked(tag: String, pkg: String?): Pair<StackNode, String?>? {
        val dot = tag.indexOf('.')
        if (dot > 0) {
            val ns = tag.substring(0, dot)
            val name = tag.substring(dot + 1)
            val scope = if (ns == "shared" || ns == "global") null else ns
            return nodeDefs["${scope ?: ""}::$name"]?.let { it.template to it.scope }
        }
        return (nodeDefs["${pkg ?: ""}::$tag"] ?: nodeDefs["::$tag"])
            ?.let { it.template to it.scope }
    }

    /**
     * Derive the first-frame system navigation claim from a compiled component template.
     *
     * The live `<NavBar system="true">` claim still runs on appearance and confirms/corrects
     * this value. This static seed only prevents Android's real Material app bar from popping
     * in after the destination transition. It is component-agnostic: any resolved child
     * template containing the route.chrome contract participates, not a hard-coded NavBar tag.
     * Dynamic titles deliberately return null and stay on the truthful live-claim path.
     */
    fun systemChromeHint(component: String, pkg: String?): Map<String, Any?>? =
        synchronized(lock) {
            val (template, owningScope) =
                resolveLocked(component, pkg) ?: return@synchronized null
            val queue = ArrayDeque<StackNode>()
            queue.addAll(template.children)
            var visited = 0
            while (queue.isNotEmpty() && visited < 64) {
                val node = queue.removeFirst()
                visited += 1
                queue.addAll(node.children)
                val (childTemplate, _) =
                    resolveLocked(node.tag, owningScope ?: pkg) ?: continue
                if (!containsSystemChromeClaim(childTemplate)) continue
                if (node.attrs["system"] == "false") return@synchronized null
                val title = node.attrs["title"]?.trim().orEmpty()
                if (title.isEmpty() || title.contains("{{")) return@synchronized null
                if (node.attrs.values.any { it.contains("{{") }) return@synchronized null
                return@synchronized mapOf(
                    "title" to title,
                    "large" to (node.attrs["large"] == "true"),
                )
            }
            null
        }

    private fun containsSystemChromeClaim(template: StackNode): Boolean {
        val queue = ArrayDeque<StackNode>()
        queue.add(template)
        var visited = 0
        while (queue.isNotEmpty() && visited < 64) {
            val node = queue.removeFirst()
            visited += 1
            if (node.text?.contains("dsx.module.route.chrome(") == true ||
                node.attrs.values.any { it.contains("dsx.module.route.chrome(") }
            ) return true
            queue.addAll(node.children)
        }
        return false
    }

    /// A privileged structural orchestrator (list/grid/pager/tabs/scaffold) — engine powers.
    fun definePrivileged(tag: String, build: @Composable (ComposeStackComponentContext) -> Unit) {
        synchronized(lock) { privileged[tag] = build }
    }
    fun privilegedGlobal(tag: String): (@Composable (ComposeStackComponentContext) -> Unit)? =
        synchronized(lock) { privileged[tag] }

    /// A native (Compose-backed) global component. Resolved AFTER XML — an XML component
    /// of the same name wins, exactly like iOS.
    fun defineNative(tag: String, build: @Composable (ComposeStackComponentContext) -> Unit) {
        synchronized(lock) { natives[tag] = build }
    }
    fun nativeGlobal(tag: String): (@Composable (ComposeStackComponentContext) -> Unit)? =
        synchronized(lock) { natives[tag] }

    /// Is a tag shipped in THIS binary — an XML component (under ANY scope) or a native /
    /// privileged / package-registered global? The Kotlin twin of Swift
    /// `StackComponents.has(_:)`, and the component half of the capability boundary that a
    /// remote route's `requires`, the dynamic `<node>` resolver and the ROOT PLAN's
    /// `registered` all consult.
    ///
    /// Bare names are deliberately SCOPE-BLIND: this is the coarse "is it compiled in"
    /// question, not scoped render resolution (`resolve` answers that). A qualified wire name
    /// is different: `demo.Launcher` explicitly addresses only demo's Launcher, just as
    /// `resolve` does. Spelling the union out at the call site drifted twice on iOS — natives
    /// live outside the XML table, and privileged orchestrators (scaffold, list, tabs, grid,
    /// scroll, pager, carousel) outside both — so the union lives HERE, once, beside the
    /// tables it reads.
    fun has(tag: String): Boolean = synchronized(lock) {
        if (registry.containsKey(tag)) return true
        val dot = tag.indexOf('.')
        if (dot > 0) {
            val ns = tag.substring(0, dot)
            val name = tag.substring(dot + 1)
            val scope = if (ns == "shared" || ns == "global") null else ns
            if (nodeDefs.containsKey("${scope ?: ""}::$name")) return true
            return (ns == "shared" || ns == "global") && natives.containsKey(name)
        }
        if (privileged.containsKey(tag) || natives.containsKey(tag)) return true
        val suffix = "::$tag"
        nodeDefs.keys.any { it.endsWith(suffix) }
    }
}

// MARK: - render-side StackStore sidecar (Swift: stored fields ON StackStore; the Kotlin
// StackStore lives in :core/Jse.kt, so the renderer's members ride a WeakHashMap sidecar —
// the JSERunnerStoreFields precedent, call-site-identical `store.classes` / `store.overrides`).

internal class RenderStoreFields {
    val classes = HashMap<String, Map<String, String>>()     // <style as=…> named classes
    val overrides = HashMap<String, Map<String, String>>()   // imperative dsx.node overrides, by element id
    var changeDepth = 0                                      // setBound's on:change re-entry guard (Swift: a field on StackStore)
    // /web/11: the surface root's `<api>` DAG — the packages/dom/src/mount.ts + Swift
    // StackStore.apiGraph twin. Built by StackRootView from the ROOT HEAD's declarations
    // (that set IS the scope, exactly like `ir.head.apis`), attached by StackApiView,
    // released by the start effect that composes after the whole subtree.
    var apiGraph: ApiGraph? = null
    var apiGraphNames: Set<String> = emptySet()
    /// Owned HERE rather than read off ApiGraph so the kernel needs no new accessor: once
    /// the graph has started, a LATE-mounting block (a head behind visible-if, a frame
    /// recomposed after the start effect) takes the graph-LESS path — which is today's
    /// behavior — instead of attaching to a started graph that would never release it.
    var apiGraphStarted = false
}

private val renderFieldsMap = WeakHashMap<StackStore, RenderStoreFields>()
private val renderFieldsLock = Any()

internal val StackStore.renderFields: RenderStoreFields
    get() = synchronized(renderFieldsLock) { renderFieldsMap.getOrPut(this) { RenderStoreFields() } }
internal val StackStore.classes get() = renderFields.classes
internal val StackStore.overrides get() = renderFields.overrides
internal var StackStore.changeDepth
    get() = renderFields.changeDepth
    set(v) { renderFields.changeDepth = v }

// One reactive subscription bundle per surface root. Previously every StackNodeView installed
// three flow collectors (surface/global/cookies), so a large route built hundreds of collectors
// before its first frame. CompositionLocal reads retain the same invalidation semantics while
// the root owns subscription lifecycle once. Standalone nodes safely keep the old collector path.
private class RenderSnapshots(
    val store: StackStore,
    val surface: Map<String, Any?>,
    val global: Map<String, Any?>,
    val cookies: Map<String, String>,
)

private val LocalRenderSnapshots = staticCompositionLocalOf<RenderSnapshots?> { null }
private val LocalCSSContext = staticCompositionLocalOf<CSSResolver.Context?> { null }

internal object RenderSubscriptionPolicy {
    fun usesRootSubscription(inherited: StackStore?, current: StackStore): Boolean =
        inherited === current
}

internal object RenderEnvironmentPolicy {
    fun usesRootEnvironment(inherited: CSSResolver.Context?): Boolean = inherited != null
}

/**
 * A main-axis `grow` is flex participation, not an instruction for the first child to
 * consume the parent's entire proposal. The parent stack therefore owns the weight while
 * the child still owns its fill modifier inside that lane. This is the Compose equivalent
 * of SwiftUI's competing flexible frames and CSS flex-grow.
 */
internal object FlexChildPolicy {
    fun growsOnMainAxis(grow: String?, horizontal: Boolean): Boolean = when (grow) {
        "true", "both" -> true
        "width" -> horizontal
        "height" -> !horizontal
        else -> false
    }
}

internal object FlexWrapPolicy {
    fun wrapsRows(direction: String, flexWrap: String?): Boolean =
        direction.startsWith("row") && flexWrap == "wrap"
}

/**
 * Compose forbids a vertical scrolling container from receiving the unbounded
 * height proposal of another vertical scrolling container. The outer viewport
 * therefore owns scrolling and a nested DSX `<scroll>` becomes an eager column.
 * This also matches the fit-content behavior used by the SwiftUI renderer.
 */
internal object ScrollNestingPolicy {
    fun ownsVerticalViewport(inVerticalScrollContainer: Boolean): Boolean =
        !inVerticalScrollContainer
}

/**
 * A scrolling grid cannot receive the unbounded height proposal of an ancestor vertical
 * scroll. In that context the ancestor owns scrolling and the grid uses its existing eager
 * chunked-row layout. Root grids remain virtualized unless the author explicitly asks for
 * `scroll="false"`.
 */
/// A lazy scroller may never nest inside a vertical scroll: Compose measures the inner
/// LazyColumn/LazyVerticalGrid with an infinite maximum height and throws. `<list>` and
/// `<grid>` therefore share ONE rule — render rows eagerly when the author said
/// `scroll="false"` OR when a scrolling / hugging ancestor stamped LocalInScrollContainer
/// (`<scroll>`, the sheet's fit-content slot). The iOS twin is the same law from the other
/// side: a greedy List collapses under a ScrollView, so ScrollAwareSystemList drops it.
internal object LazyScrollPolicy {
    fun usesEagerRows(scroll: String?, inVerticalScrollContainer: Boolean): Boolean =
        scroll == "false" || inVerticalScrollContainer
}

/**
 * A vertical scroll whose only child is a plain vertical stack can use one
 * LazyColumn without changing its visible layout. Keep the gate deliberately
 * narrow: declarations must mount eagerly, flexible spacers need ColumnScope
 * weight, and authored container lifecycle/motion/theme semantics keep the
 * original eager hierarchy.
 */
internal object ScrollVirtualizationPolicy {
    private val DECLARATIONS = despia.engine.LayoutSemantics.declarationTags
    private val CONTAINER_DYNAMIC_ATTRS = setOf(
        "visible-if", "keep", "transition", "anim", "enter", "theme",
        "on:appear", "on:disappear",
    )

    fun outerOwnsHeight(attrs: Map<String, String>): Boolean =
        attrs["grow"] in setOf("true", "both", "height", "all")

    fun canVirtualize(inner: StackNode, attrs: Map<String, String>): Boolean {
        if (inner.tag != "stack" && inner.tag != "vstack") return false
        if (attrs.keys.any { it in CONTAINER_DYNAMIC_ATTRS }) return false
        if (attrs["css-hidden"] == "true" || attrs["display"] == "grid") return false
        if (inner.tag == "stack" && (attrs["flexDirection"] ?: "column").startsWith("row")) {
            return false
        }
        if (StackTheme.subtreePin(attrs["theme"], attrs["background"]) != null) return false
        if (inner.children.any {
                it.tag == "spacer" &&
                    it.attrs["height"] == null &&
                    it.attrs["width"] == null
            }) return false

        val queue = ArrayDeque<StackNode>()
        queue.addAll(inner.children)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.tag in DECLARATIONS) return false
            queue.addAll(node.children)
        }
        return true
    }
}

/**
 * Native lazy implementation for the narrow [ScrollVirtualizationPolicy] shape.
 * The outer scroll and inner stack modifiers stay in their original outside→inside
 * order on the one LazyColumn; only off-viewport child composition is deferred.
 */
@Composable
private fun LazyVerticalScrollStack(
    scroll: StackNode,
    outerModifier: Modifier,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
): Boolean {
    val inner = scroll.children.singleOrNull() ?: return false
    val inheritedCSS = LocalCSSContext.current
    val css = if (RenderEnvironmentPolicy.usesRootEnvironment(inheritedCSS)) {
        inheritedCSS!!
    } else {
        cssEnvironment()
    }
    val attrs = resolvedAttrs(inner, store, item, css)
    if (!ScrollVirtualizationPolicy.canVirtualize(inner, attrs)) return false

    val innerModifier = Modifier
        .decorate(inner, attrs, store, env, item)
        .then(StackStyle.apply(attrs, store, item, inner.tag))
    val spacing = attrs["spacing"]?.let { JSE.number(JSE.interpolate(it, store, item)) }
        ?: if (inner.tag == "vstack") ElementDefaults.STACK_SPACING
        else ElementDefaults.GENERIC_STACK_GAP
    val alignment = if (inner.tag == "vstack") {
        hAlign(attrs["align"]?.let { JSE.interpolate(it, store, item) })
    } else {
        val word = attrs["alignItems"] ?: attrs["align"] ?: ""
        crossHAlign(JSE.interpolate(word, store, item))
    }

    LazyColumn(
        modifier = outerModifier.then(innerModifier),
        verticalArrangement =
            if (spacing > 0) Arrangement.spacedBy(spacing.dp) else Arrangement.Top,
        horizontalAlignment = alignment,
    ) {
        items(count = inner.children.size, key = { it }) { index ->
            StackNodeView(inner.children[index], store, env, item, rowWrite)
        }
    }
    return true
}

// MARK: - Renderer

/// Twin of Swift `StackRootView`: the surface root — fills width; screens fill height,
/// sheets hug (`fillHeight = false`) so content height stays measurable. Self-wraps in
/// the system theme (StackTheme.kt — system-defaults.md) so EVERY surface that mounts a
/// root (module hosts included) resolves the M3 roles; nesting under an outer
/// DespiaSystemTheme (MainActivity) is a VALUE-idempotent restamp — the StackTheme.scheme
/// setter compares the ten corpus roles and skips equal-valued writes, so a nested mount
/// never re-waves the global scheme state.
@Composable
fun StackRootView(root: StackNode, store: StackStore, env: JSERunner, fillHeight: Boolean = true) {
    // NATIVE READINESS — the frame-render seam's two RENDER-SIDE inputs (Conformance/
    // lifecycle/readiness.json; Swift twin: StackHead.hoist + ScreenFrame's main-queue hop).
    //
    //  • `settle="manual"` is a ROOT-ONLY universal attribute, so it is known the instant the
    //    root node is read — recorded on the STORE here, during the FIRST composition, because
    //    the frame's `mount` runs in the host's effect (after composition) and a `manual` that
    //    arrived before its record existed would be a silent no-op. The host reads the flag at
    //    its mount seam, exactly like iOS `ScreenFrame.declaresManualSettle`.
    //  • `rendered` is reported from a LaunchedEffect keyed on the frame id: Compose runs
    //    effects strictly AFTER the composition that set the flag, which is the one ordering
    //    obligation the corpus cannot express (lifecycle/README.md). Off a nav frame
    //    (`frameId` null — a modal, a bare mounted surface) both inputs are inert.
    if (declaresManualSettle(root, null)) store.settleManual = true
    val frameId = store.frameId
    LaunchedEffect(frameId) { ScreenReadiness.rendered(frameId) }
    // /web/11: ONE `<api>` graph per surface scope. The root HEAD's declarations are the
    // scope (the `ir.head.apis` twin), so the DAG is known before anything mounts; each
    // `<api>` attaches during its own DisposableEffect, and the effect below — emitted
    // AFTER the subtree, so Compose applies it after every effect inside it — releases the
    // runnable set. Recomputed only when the ROOT NODE identity changes, which is what a
    // new document is.
    // A root that declares NO `<api>` never touches the sidecar — a module host can mount a
    // second root over a shared store, and an empty walk must not clobber (or prematurely
    // release) the graph the first one installed.
    val apiSpecs = remember(root) { rootHeadApiSpecs(root) }
    if (apiSpecs.isNotEmpty()) {
        remember(store, apiSpecs) {
            val fields = store.renderFields
            fields.apiGraphStarted = false
            fields.apiGraph = ApiGraph(apiSpecs)
            fields.apiGraphNames = apiSpecs.mapNotNull { it["as"]?.trim()?.ifEmpty { null } }.toSet()
            apiSpecs.size
        }
    }
    val renderSnapshots = RenderSnapshots(
        store = store,
        surface = store.varsFlow.collectAsState().value,
        global = DSX.state.varsFlow.collectAsState().value,
        cookies = DSXCookies.shared.jarFlow.collectAsState().value,
    )
    // Density, viewport, appearance, font scale, and reduce-motion are surface facts.
    // Computing them in every StackNodeView repeated the Settings/WindowInfo work
    // hundreds of times before a large route's first frame.
    val cssContext = cssEnvironment()
    CompositionLocalProvider(
        LocalRenderSnapshots provides renderSnapshots,
        LocalCSSContext provides cssContext,
    ) {
        DespiaSystemTheme {
            Box(Modifier.fillMaxWidth().then(if (fillHeight) Modifier.fillMaxHeight() else Modifier)) {
                StackNodeView(node = root, store = store, env = env, item = null)
            }
        }
    }
    if (apiSpecs.isNotEmpty()) {
        DisposableEffect(store, apiSpecs) {
            val fields = store.renderFields
            fields.apiGraph?.start()
            fields.apiGraphStarted = true
            onDispose { fields.apiGraphStarted = false }
        }
    }
}

/// The root `<head>`'s `<api>` declarations, in document order — the scope /web/11's graph
/// is built from. Deliberately NOT a deep walk: a component's own head is its OWN scope
/// (the iOS `apiDeclarations` rule), and inventing edges across scopes would gate blocks
/// the compiler never linked. A root that carries `<api>` outside a `<head>` is included
/// too, because the head is transparent in this renderer and both positions are hoisted
/// by the same first-declaration-wins claim.
private fun rootHeadApiSpecs(root: StackNode): List<Map<String, String>> {
    val out = ArrayList<Map<String, String>>()
    fun collect(node: StackNode) {
        for (child in node.children) {
            when (child.tag) {
                "api" -> if (!child.attrs["as"].isNullOrBlank()) out.add(child.attrs)
                "head" -> collect(child)
                else -> {}
            }
        }
    }
    collect(root)
    return out
}

/// Does this surface root opt OUT of settling on its first render — `settle="manual"`?
///
/// `settle` is a ROOT-ONLY universal attribute (enum `auto` | `manual`, `auto` never written).
/// The PAGE ROOT is the surface root resolved THROUGH component references (a pushed frame's root
/// is the reference `<Name/>`; the page root is that template's root), so a screen authored as a
/// component declares `settle` on its OWN root, not on every call site. Bounded walk (8 hops),
/// byte-for-byte the Swift `StackHead.declaresManualSettle` contract.
fun declaresManualSettle(root: StackNode, scope: String?): Boolean {
    var node = root
    var pkg = scope
    var hops = 0
    if (node.attrs["settle"] == "manual") return true
    while (hops < 8) {
        val (template, owningScope) = ComposeStackComponents.resolve(node.tag, pkg) ?: return false
        if (template.attrs["settle"] == "manual") return true
        node = template
        pkg = owningScope ?: pkg
        hops += 1
    }
    return false
}

/// Tags whose `on:tap` is wired by their own control in `raw` (skip in decorate — no double fire).
private val tapControls = setOf("button", "glassButton", "transport", "pressable", "row")

@Composable
fun StackNodeView(
    node: StackNode,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>? = null,
    rowWrite: ((String, Any) -> Unit)? = null,
    parentLayoutModifier: Modifier? = null,
) {
    // `dsx.element.*` — the nearest container's live metrics join THIS node's eval scope as
    // `item.__element` (the Stack.swift eval-scope merge, ~5086-5092; web childCtx). The
    // container element itself resolved its own attrs one level up, so — like both twins —
    // it never sees its own metrics; descendants do, row scopes included.
    @Suppress("NAME_SHADOWING")
    val item = LocalDsxContainer.current?.let { scope ->
        (item ?: emptyMap()) + mapOf<String, Any?>("__element" to scope)
    } ?: item
    // The @ObservedObject twin. Normal surfaces inherit the root's single subscription bundle;
    // a standalone node (or one rendered with a different store) retains the safe local path.
    val inheritedSnapshots = LocalRenderSnapshots.current
    val usesRootSubscription = RenderSubscriptionPolicy.usesRootSubscription(
        inheritedSnapshots?.store, store
    )
    val surfaceSnapshot =
        if (usesRootSubscription) inheritedSnapshots!!.surface
        else store.varsFlow.collectAsState().value
    val globalSnapshot =
        if (usesRootSubscription) inheritedSnapshots!!.global
        else DSX.state.varsFlow.collectAsState().value
    val cookieSnapshot =
        if (usesRootSubscription) inheritedSnapshots!!.cookies
        else DSXCookies.shared.jarFlow.collectAsState().value
    // The snapshot objects are threaded through every private restart boundary below.
    // Reading them only in THIS scope invalidates StackNodeView, but Compose may still
    // skip NodeContent / NodeBody / Raw when their ordinary inputs retain identity —
    // which would leave interpolation and styles stale after a healthy store publish.
    // They are invalidation tokens only; evaluation keeps reading the authoritative stores.

    val inheritedCSS = LocalCSSContext.current
    val css = if (RenderEnvironmentPolicy.usesRootEnvironment(inheritedCSS)) {
        inheritedCSS!!
    } else {
        // Standalone StackNodeView callers retain the safe pre-root path.
        cssEnvironment()
    }
    // `@keyframes` is driven HERE rather than inside resolvedAttrs: sampling needs a frame loop
    // and resolvedAttrs is a pure fold called from non-composable callers too (R28).
    val attrs = animatedAttrs(node, resolvedAttrs(node, store, item, css), css)

    // Two visibility modes (Swift visibilityBody): default inserts/removes — with
    // transition=/anim= the flip animates (AnimatedVisibility, Swift's `.transition` +
    // `.animation(_, value: visible)`); keep="true" stays mounted and fades opacity.
    val isVisible = visible(attrs, store, env, item)
    val keepAlive = attrs["keep"] == "true"
    val hasMotion = !keepAlive && (attrs["transition"] != null || attrs["anim"] != null)
    if (!isVisible && !keepAlive && !hasMotion) return

    if (hasMotion) {
        // Swift declaredAnimation: transition= OR anim= arms the animated flip; a bare
        // anim= uses SwiftUI's default insertion transition — the fade (StackMotion.enter).
        val spec = StackMotion.animation(attrs["anim"], attrs["animDuration"])
        val state = remember(node) { MutableTransitionState(isVisible) }   // initial state never animates, like iOS
        state.targetState = isVisible
        // Compose only while visible or still animating out — a settled-hidden element
        // leaves the tree entirely (no phantom spacing gap; the iOS empty Group).
        if (isVisible || state.currentState || !state.isIdle) {
            AnimatedVisibility(
                               modifier = parentLayoutModifier ?: Modifier,
                               visibleState = state,
                               enter = StackMotion.enter(attrs["transition"], spec),
                               exit = StackMotion.exit(attrs["transition"], spec)) {
                NodeContent(
                    node, attrs, store, env, item, rowWrite,
                    surfaceSnapshot, globalSnapshot, cookieSnapshot,
                    keepAlive = false, isVisible = true,
                )
            }
        }
        return
    }
    if (parentLayoutModifier != null) {
        Box(parentLayoutModifier) {
            NodeContent(
                node, attrs, store, env, item, rowWrite,
                surfaceSnapshot, globalSnapshot, cookieSnapshot,
                keepAlive = keepAlive, isVisible = isVisible,
            )
        }
    } else {
        NodeContent(
            node, attrs, store, env, item, rowWrite,
            surfaceSnapshot, globalSnapshot, cookieSnapshot,
            keepAlive = keepAlive, isVisible = isVisible,
        )
    }
}

/// The node's visible content — lifecycle hooks + the styled element. Factored out so
/// the three visibility vehicles (plain, keep-fade, AnimatedVisibility) share one body:
/// hooks fire on insertion/removal of THIS content, matching the iOS onAppear placement
/// (inside the transitioned Group, mounted-but-hidden for keep).
@Composable
private fun NodeContent(
    node: StackNode,
    attrs: Map<String, String>,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
    surfaceSnapshot: Map<String, Any?>,
    globalSnapshot: Map<String, Any?>,
    cookieSnapshot: Map<String, String>,
    keepAlive: Boolean,
    isVisible: Boolean,
) {
    // Lifecycle hooks (Swift decorate's onAppear/onDisappear).
    attrs["on:appear"]?.let { a -> LaunchedEffect(node) { env.run(a, item) } }
    attrs["on:disappear"]?.let { a ->
        DisposableEffect(node) { onDispose { env.run(a, item) } }
    }

    // ── the SEMANTIC THEME pin + the authored-canvas derivation (twin of the Stack.swift
    // theme= arm + derivedScheme, ~5039-5069 / ~5131-5173): `theme="dark|light"` fixes the
    // scheme for THIS subtree — semantic colors, real M3 components, nested roots — and,
    // with NO authored theme= (explicit always wins, a bad word included), an authored
    // LITERAL background (white/black words · well-formed rgb()/rgba() · 6/8-digit hex;
    // alpha ≥ 0.5) derives the same subtree pin from its relative luminance, so
    // `<vstack background="#0B0B0F"><text color="secondary">` resolves dark-scheme
    // exactly like iOS (no more near-black-on-black in light mode). The read is
    // attrs ∪ legacy named style, interpolated — the iOS `val()` closure — and the wrap
    // covers the element's own style resolution (pushForced runs before apply() below).
    // Pinned micro-deviation: iOS applies its environment BETWEEN the style arms
    // (border/shadow colors resolve ambient there); here the whole chain resolves pinned.
    val pinnedDark = if (attrs["theme"] != null || attrs["background"] != null || attrs["style"] != null) {
        val named = StackStyle.namedStyle(attrs["style"])
        fun themed(k: String): String? = (attrs[k] ?: named[k])?.let { JSE.interpolate(it, store, item) }
        StackTheme.subtreePin(themed("theme"), themed("background"))
    } else null
    val themedBody: @Composable () -> Unit = {
        if (pinnedDark != null) {
            ForcedSchemeSubtree(pinnedDark) {
                NodeBody(
                    node, attrs, store, env, item, rowWrite,
                    surfaceSnapshot, globalSnapshot, cookieSnapshot, keepAlive, isVisible,
                )
            }
        } else {
            NodeBody(
                node, attrs, store, env, item, rowWrite,
                surfaceSnapshot, globalSnapshot, cookieSnapshot, keepAlive, isVisible,
            )
        }
    }
    // DENSITY pin (`density="comfortable|compact"` — the W9 subtree knob; shared law:
    // OpenSource/Conformance/input/density.json, StackDensity — the Stack.swift ~6037
    // `.environment(\.controlSize)` twin). Compose M3 ships no control-size system, so the
    // platform's own size knob here is the M3 minimum interactive component size: compact
    // pins this subtree onto the 40dp desktop-density floor (the split-toggle target
    // precedent), comfortable restores the platform 48dp — every M3 control and every
    // `minimumInteractiveComponentSize()`-floored DSX metric re-derives its target from it.
    // Nearest pin wins by provider nesting; no authored pin composes byte-identically.
    val densityPin = StackDensity.resolve(attrs["density"]?.let { JSE.interpolate(it, store, item) })
    if (densityPin != null) {
        CompositionLocalProvider(
            LocalMinimumInteractiveComponentSize provides
                (if (densityPin == StackDensity.COMPACT) 40.dp else 48.dp),
            content = themedBody,
        )
    } else {
        themedBody()
    }
}

/// The styled element half of NodeContent, factored so the subtree scheme pin above can
/// wrap it (the modifier chain must be BUILT inside the pin — StackStyle.apply resolves
/// semantic colors eagerly at build time, and the forced stack is forward-written first).
@Composable
private fun NodeBody(
    node: StackNode,
    attrs: Map<String, String>,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
    surfaceSnapshot: Map<String, Any?>,
    globalSnapshot: Map<String, Any?>,
    cookieSnapshot: Map<String, String>,
    keepAlive: Boolean,
    isVisible: Boolean,
) {
    // content = decorate(StackStyle.apply(raw(attrs))) — decorate outermost, style inside,
    // element innermost (the Swift onion; Modifier left = outermost).
    var m = Modifier.decorate(node, attrs, store, env, item).then(StackStyle.apply(attrs, store, item, node.tag))

    // `container` — measure this element's FULL styled box and publish it to descendants
    // (the StackContainer background-GeometryReader twin; dp like the drag payload, writes
    // elided on equality like the web's ResizeObserver arm). The provider wraps Raw below,
    // so descendants — and only descendants — read it through LocalDsxContainer.
    val containerState = if (attrs["container"] != null) {
        // Keyed by composition slot, like every other remember here — NOT by `node`
        // (StackNode is a data class; keying on it would deep-compare the subtree).
        remember { mutableStateOf<Map<String, Any?>?>(null) }
    } else null
    if (containerState != null) {
        val density = LocalDensity.current
        m = Modifier.onSizeChanged { size ->
            val metrics: Map<String, Any?> = with(density) {
                mapOf("width" to size.width.toDp().value.toDouble(),
                      "height" to size.height.toDp().value.toDouble())
            }
            if (containerState.value != metrics) containerState.value = metrics
        }.then(m)
    }
    val passthroughSubtree = attrs["passthrough"] == "true"

    // keep=/enter= wrap OUTSIDE raw()'s result on iOS (opacity/StackEntry around the
    // styled content), so they must also cover REGISTERED elements — whose dispatch
    // drops `m` and re-applies decorate+style via elementModifier (Elements.kt). They
    // therefore ride a hugging wrapper Box, never `m`.
    var motion: Modifier = Modifier
    if (keepAlive) {
        // keep="true": mounted, opacity animates (Swift: `.opacity(visible ? 1 : 0)` +
        // `.animation(anim= ?: .easeOut(0.18), value: visible)`); hidden ⇒ inert
        // (`.allowsHitTesting(false)` — blockHits, which on the wrapper cancels the
        // whole subtree's gestures).
        val spec = if (attrs["anim"] != null) StackMotion.animation(attrs["anim"], attrs["animDuration"])
                   else StackMotion.KEEP_FADE
        val alpha by animateFloatAsState(if (isVisible) 1f else 0f, StackMotion.spec(spec), label = "dsx-keep")
        motion = Modifier.graphicsLayer { this.alpha = alpha }
        if (!isVisible) motion = motion.blockHits()
    }
    // enter= — the one-shot entry animation, OUTERMOST like iOS (StackEntry wraps the
    // visibility body); shares the anim=/animDuration= vocabulary.
    attrs["enter"]?.let { e ->
        motion = StackMotion.run {
            Modifier.entry(e, animation(attrs["anim"], attrs["animDuration"]))
        }.then(motion)
    }
    // The wrapper decision keys on the ATTRS (stable per composition), never the animated
    // value — a settled entry must not change composition structure (a remount would
    // refire on:appear and reset child state).
    val rawContent: @Composable () -> Unit = {
        Raw(
            node, attrs, m, store, env, item, rowWrite,
            surfaceSnapshot, globalSnapshot, cookieSnapshot,
        )
    }
    // tooltip= — the universal element hint's render adapter (StackTooltipHost below).
    // Same structure rule: the wrapper keys on the ATTR's presence, never the (reactive)
    // resolved value, so a bound tooltip going empty mid-flight can never remount Raw.
    // Inside the motion Box, like iOS (keep-hidden blocks hits, so a hidden element can
    // never reveal); inside the passthrough/container providers below, so the reveal
    // wiring sees LocalDsxPassthrough exactly like decorate's interactive arms.
    val hinted: @Composable () -> Unit =
        if (attrs["tooltip"] != null) ({ StackTooltipHost(attrs, store, item, rawContent) })
        else rawContent
    val body: @Composable () -> Unit = {
        if (keepAlive || attrs["enter"] != null) {
            Box(motion) { hinted() }
        } else {
            hinted()
        }
    }
    // container/passthrough scope providers — around Raw, so the element's own modifier
    // chain (built above, materialized inside) and every descendant see them; absent both,
    // the composition structure is byte-identical to before.
    when {
        containerState != null && passthroughSubtree -> CompositionLocalProvider(
            LocalDsxContainer provides containerState.value,
            LocalDsxPassthrough provides true, content = body)
        containerState != null -> CompositionLocalProvider(
            LocalDsxContainer provides containerState.value, content = body)
        passthroughSubtree -> CompositionLocalProvider(
            LocalDsxPassthrough provides true, content = body)
        else -> body()
    }
}

/// Hover-intent delay before a tooltip shows — the web twin's TOOLTIP_INTENT_DELAY_MS
/// (mount.ts); keyboard focus shows immediately, exactly like the web adapter.
private const val TOOLTIP_INTENT_DELAY_MS = 300L

/// `tooltipSide=` word → the M3 anchor-position solver's slot (pure; plain-JVM tested —
/// StackTooltipAdapterTest). Start/End follow layout direction (leading/trailing under
/// RTL) and the M3 provider collision-flips at the window edge — the web placeFloating
/// behavior. The resolve() fold has already normalized unknowns to "top".
@OptIn(ExperimentalMaterial3Api::class)
internal fun tooltipAnchorPosition(side: String): TooltipAnchorPosition = when (side) {
    "bottom" -> TooltipAnchorPosition.Below
    "leading" -> TooltipAnchorPosition.Start
    "trailing" -> TooltipAnchorPosition.End
    else -> TooltipAnchorPosition.Above
}

/// tooltip= / tooltipSide= — the universal element hint (design-system.md Wave 3 (c)1; the
/// shared law: OpenSource/Conformance/input/tooltip.json; twins: web mount.ts wireTooltip,
/// Stack.swift decorate's UIToolTipInteraction arm). The RENDER adapter drives the REAL M3
/// plain tooltip surface (system-defaults.md: the unstyled baseline IS the platform) from
/// the corpus-pinned StackTooltipLifecycle — TooltipBox's own gestures stay OFF
/// (enableUserInput = false) because M3's long-press reveal would break the law's touch
/// gate: only a hover-capable pointer (mouse/stylus Enter, the on:hover arm's kind gate)
/// after the shared hover-intent delay, or KEYBOARD focus (InputMode.Keyboard — the
/// :focus-visible analogue; hasFocus covers the merged control inside), ever reveals.
/// Touch and TalkBack focus never do (Article 7) and lose nothing — the resolved text
/// always doubles as the element's description (StackStyle's a11y arm, the hint slot).
/// Escape dismisses through the machine; DECLARED (the on:adjust trade): a hardware
/// Escape reaches this node only while focus sits within, so a hover-only show dismisses
/// by pointer-out instead. Text and side interpolate per recomposition (the reactive
/// twin of the web's bindText); text resolving empty mid-flight unmounts the machine (the
/// web sync()); a passthrough subtree wires no reveal (the interactive-arms gate) while
/// the composition structure stays byte-stable either way.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StackTooltipHost(
    attrs: Map<String, String>,
    store: StackStore,
    item: Map<String, Any?>?,
    content: @Composable () -> Unit,
) {
    val resolved = StackTooltip.resolve(
        attrs["tooltip"]?.let { JSE.interpolate(it, store, item) },
        attrs["tooltipSide"]?.let { JSE.interpolate(it, store, item) },
    )
    // rememberUpdatedState so the pointerInput(Unit) loop below reads the LIVE resolution
    // (and the passthrough gate) without restarting — hover state must survive a text edit.
    val current by rememberUpdatedState(if (LocalDsxPassthrough.current) null else resolved)
    val machine = remember { StackTooltipLifecycle() }
    var revealed by remember { mutableStateOf(false) }
    fun dispatch(actions: List<String>) {
        for (action in actions) revealed = action == "show"
    }
    val tooltipState = rememberTooltipState(isPersistent = true)   // OUR machine owns hide — never the M3 auto-timeout
    LaunchedEffect(revealed) {
        if (revealed) tooltipState.show() else tooltipState.dismiss()
    }
    val gone = current == null
    LaunchedEffect(gone) { if (gone) dispatch(machine.unmount()) }
    val inputModeManager = LocalInputModeManager.current
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(
            tooltipAnchorPosition(resolved?.side ?: "top")),
        tooltip = { PlainTooltip { Text(current?.text ?: "") } },
        state = tooltipState,
        focusable = false,        // the bubble must never steal focus (stealing would blur-hide it)
        enableUserInput = false,  // reveal is the machine's alone — see the header
        modifier = Modifier
            .pointerInput(Unit) {
                coroutineScope {
                    var intent: Job? = null
                    try {
                        awaitPointerEventScope {
                            while (true) {
                                val event = awaitPointerEvent()
                                when (event.type) {
                                    PointerEventType.Enter -> {
                                        val capable = event.changes.any { hoverPointerKind(it.type) != "touch" }
                                        if (capable && current != null && intent == null) {
                                            intent = launch {
                                                delay(TOOLTIP_INTENT_DELAY_MS)
                                                intent = null
                                                if (current != null) dispatch(machine.hoverStart(true))
                                            }
                                        }
                                    }
                                    PointerEventType.Exit -> {
                                        intent?.cancel(); intent = null
                                        dispatch(machine.hoverEnd())
                                    }
                                    // a press is activation, not hover intent (the web pointerdown)
                                    PointerEventType.Press -> { intent?.cancel(); intent = null }
                                    else -> {}
                                }
                            }
                        }
                    } finally {
                        // cancelled at unmount — an accepted show still receives its hide
                        // (the on:hover arm's finally).
                        intent?.cancel()
                        dispatch(machine.unmount())
                    }
                }
            }
            .onFocusChanged { state ->
                if (state.hasFocus) {
                    if (current != null) {
                        dispatch(machine.focus(inputModeManager.inputMode == InputMode.Keyboard))
                    }
                } else {
                    dispatch(machine.blur())
                }
            }
            .onPreviewKeyEvent { event ->
                if (event.key == Key.Escape && event.type == KeyEventType.KeyDown && revealed) {
                    dispatch(machine.escape())
                    true
                } else {
                    false
                }
            },
    ) { content() }
}

/// The DSX-CSS environment, read from Compose so every input is a TRACKED recomposition
/// dependency — the twin of iOS's @Environment(\.colorScheme) read in StackNodeView plus
/// the UIScreen/UIFontMetrics/UIAccessibility globals CSSValue/CSSResolver consume
/// (window dp, font scale, reduce motion). `classes` stays empty here; resolvedAttrs
/// fills it per element.
@Composable
internal fun cssEnvironment(): CSSResolver.Context {
    val dark = isSystemInDarkTheme()
    val density = LocalDensity.current
    val containerSize = LocalWindowInfo.current.containerSize
    val fontScale = density.fontScale
    val reduceMotion = rememberAnimatorDurationScale() == 0f
    return CSSResolver.Context(isDark = dark,
                               windowWidth = with(density) { containerSize.width.toDp().value.toDouble() },
                               windowHeight = with(density) { containerSize.height.toDp().value.toDouble() },
                               fontScale = fontScale.toDouble(),
                               reduceMotion = reduceMotion)
}

/// Android can change "Remove animations" while the Activity remains alive. Reading the
/// setting once with `remember(context)` left both DSX-CSS media queries and router motion
/// stale until process restart. Observe the one system URI instead: this is the Android twin
/// of SwiftUI's live accessibilityReduceMotion environment value.
@Composable
internal fun rememberAnimatorDurationScale(): Float {
    val context = LocalContext.current
    fun read(): Float = try {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
    } catch (_: Exception) {
        1f
    }

    var scale by remember(context) { mutableStateOf(read()) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                scale = read()
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        context.contentResolver.registerContentObserver(uri, false, observer)
        scale = read()
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
    return scale
}

// MARK: - attrs cascade / platform overrides / visibility

/// Attributes resolved through the FULL four-layer cascade — twin of Stack.swift's
/// `attrs` (~3885-3973):
///   1. legacy named-style classes (`<style as=…>`, later class wins in-layer)
///   2. the component's compiled DSX-CSS sheet (sidecar Component.css, scoped by the
///      css-owner stamp; matched by the element's class set)
///   3. inline DSX-CSS (a style value containing ':' — the migration heuristic; bare
///      tokens like style="card" stay legacy named styles)
///   4. the element's own explicit attributes + dsx.node overrides
/// `css` is the environment context (dark/window/font scale) — null skips layers 2-3
/// (environment-less callers; the composable path always passes cssEnvironment()).
internal fun resolvedAttrs(node: StackNode, store: StackStore, item: Map<String, Any?>?,
                           css: CSSResolver.Context? = null): Map<String, String> {
    var a: Map<String, String> = node.attrs
    if (node.id.isNotEmpty()) store.overrides[node.id]?.let { o -> a = a + o }
    // Platform-tagged style/class must reach the CSS branches below — probe the six
    // exact keys (O(1); this runs many times per render), like iOS. The final
    // resolvePlatform at the end covers `key:android` entries carried by class defs.
    // (:native joined the fold with the desktop targets — desktop-platforms.md.)
    if (a["style:ios"] != null || a["style:android"] != null || a["style:native"] != null ||
        a["class:ios"] != null || a["class:android"] != null || a["class:native"] != null) {
        a = resolvePlatform(a)
    }

    // Reactive class formulas interpolate BEFORE matching (class="pet {{ petMood }}") —
    // a formula token could never match a sheet rule.
    val clsRaw = a["class"] ?: ""
    val cls = if (clsRaw.contains("{{") && clsRaw.contains("}}")) JSE.interpolate(clsRaw, store, item) else clsRaw
    val classSet = cls.split(" ").filter { it.isNotEmpty() }.toSet()
    val base = HashMap<String, String>()

    // 1 — legacy classes (later class wins within the layer)
    if (cls.isNotEmpty() && store.classes.isNotEmpty()) {
        for (name in cls.split(" ")) store.classes[name]?.let { base.putAll(it) }
    }
    // Inline CSS is interpolated + parsed BEFORE the sheet layer so the element's own
    // custom properties (`--card-pad: 20px`) are in scope for sheet declarations — the
    // three-scope token model: theme < component sheet < element.
    var inlineCSS: String? = null
    val rawStyle = a["style"]
    if (css != null && rawStyle != null && rawStyle.contains(":")) {   // no environment → style stays put (never swallowed unresolved)
        val cssText = JSE.interpolate(rawStyle, store, item)
        if (cssText.contains(":")) {
            a = a - "style"
            inlineCSS = cssText
        } else {
            // The ':' lived inside {{ }} (style="{{ sel ? 'card' : 'sheet' }}") and
            // interpolation yielded a bare token — that is a legacy NAMED style; hand it
            // onward instead of swallowing it as empty CSS.
            a = a + ("style" to cssText)
        }
    }
    if (css != null) {
        val elementTokens = inlineCSS?.let { CSSInline.customProperties(it) } ?: emptyMap()
        // 2 — the component sheet (theme + element tokens feed var())
        val owner = a["css-owner"]
        if (owner != null && classSet.isNotEmpty()) {
            base.putAll(CSSEngine.sheetAttributes(owner, css.copy(classes = classSet), elementTokens))
        }
        // 3 — inline CSS (cached parse)
        inlineCSS?.let { base.putAll(CSSEngine.inlineAttributes(it, css.copy(classes = classSet), a["css-owner"])) }
    }
    // 4 — the element itself always wins
    if (base.isNotEmpty()) {
        // Structural CSS translations that need the NODE (the bridge is tag-blind).
        // Axis-correct gap: hstack consumes the COLUMN gap (horizontal main axis),
        // vstack/list/grid the ROW gap; the generic <stack> resolves its axis from
        // flex-direction (column when unset; a formula direction interpolates first).
        // Web-true: ONLY the main axis's gap becomes spacing. Sitting in `base` keeps
        // precedence exact: an explicit spacing attribute still wins.
        if (base["rowGap"] != null || base["columnGap"] != null) {
            var dir = a["flexDirection"] ?: base["flexDirection"] ?: "column"
            if (dir.contains("{{") && dir.contains("}}")) dir = JSE.interpolate(dir, store, item)
            val horizontal = node.tag == "hstack" || (node.tag == "stack" && dir.startsWith("row"))
            (if (horizontal) base["columnGap"] else base["rowGap"])?.let { base["spacing"] = it }
        }
        // Element attributes always win: an explicit legacy `align` on the element beats
        // CSS align-items from classes/sheets/inline (different keys — merge can't arbitrate).
        if (a["align"] != null) base.remove("alignItems")
        // display:none rides its own channel so it ANDs with the element's own visible-if.
        if (base["display"] == "none") base["css-hidden"] = "true"
        base.putAll(a)
        a = base
    }
    return resolvePlatform(a)
}

/// Per-attribute platform override — the full ladder now lives in :core
/// (PlatformAttrs.resolve, pinned by the platform corpus): exact target > :desktop >
/// :native > bare; `key:android` wins HERE because Platform.os == "android" (the
/// desktop host boots its own value — desktop-platforms.md). Only a recognized suffix
/// is a platform tag, so `on:tap` / `arg:rate` pass through untouched.
internal fun resolvePlatform(a: Map<String, String>): Map<String, String> =
    PlatformAttrs.resolve(a, Platform.attributeTarget)

private fun visible(a: Map<String, String>, store: StackStore, env: JSERunner, item: Map<String, Any?>?): Boolean {
    if (a["css-hidden"] == "true") return false                    // CSS display:none — ANDs with visible-if
    val cond = a["visible-if"] ?: return true
    if (cond.startsWith("has:")) return env.has(cond.substring(4).trim())
    return JSE.truthy(JSE.eval(cond, store, item))
}

/// `arg:*` attributes → the event payload (interpolated + coerced bool/number/string).
internal fun eventArgs(a: Map<String, String>, store: StackStore, item: Map<String, Any?>?): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    for ((k, v) in a) {
        if (!k.startsWith("arg:")) continue
        val s = JSE.interpolate(v, store, item)
        out[k.substring(4)] = when {
            s == "true" -> true
            s == "false" -> false
            else -> JSE.number(s) ?: s     // Swift Double(String) grammar via JSE
        }
    }
    return out
}

// MARK: - decorate (gesture/lifecycle hooks any element can carry)

/** The platform-neutral authored hover-pair state machine. Compose supplies pointer
 * identity and device kind; this class owns deduplication and balance. The same cases
 * execute in Web and Swift from OpenSource/Conformance/input/hover.json. */
internal enum class HoverLifecycleAction(val wireName: String) { Start("start"), End("end") }

internal class HoverLifecycle {
    private val active = LinkedHashSet<String>()
    internal val activePointers: Set<String> get() = active

    fun enter(pointerId: String, pointerKind: String, hoverCapable: Boolean): List<HoverLifecycleAction> {
        if (!hoverCapable || pointerKind == "touch" || !active.add(pointerId)) return emptyList()
        return if (active.size == 1) listOf(HoverLifecycleAction.Start) else emptyList()
    }

    fun leave(pointerId: String): List<HoverLifecycleAction> {
        if (!active.remove(pointerId) || active.isNotEmpty()) return emptyList()
        return listOf(HoverLifecycleAction.End)
    }

    fun cancel(pointerId: String): List<HoverLifecycleAction> = leave(pointerId)

    fun unmount(): List<HoverLifecycleAction> {
        if (active.isEmpty()) return emptyList()
        active.clear()
        return listOf(HoverLifecycleAction.End)
    }
}

private fun hoverPointerKind(type: PointerType): String = when (type) {
    PointerType.Touch -> "touch"
    PointerType.Mouse -> "mouse"
    PointerType.Stylus, PointerType.Eraser -> "stylus"
    else -> "unknown"
}

/// `container` — the nearest container-marked ancestor's live { width, height } in dp,
/// read by descendants as `dsx.element.*` (both JSE runners join it to `item.__element` —
/// Jse.kt:2240 / JSE.swift:2111). The Stack.swift DSXContainerKey environment / web
/// mount.ts `__container_N` childCtx twin: null outside any container, so the item merge
/// is a no-op and non-container screens are byte-identical.
internal val LocalDsxContainer = compositionLocalOf<Map<String, Any?>?> { null }

/// `passthrough="true"` — the Stack.swift `allowsHitTesting(false)` twin. Compose has no
/// subtree hit-test opt-out (and `blockHits()` OCCLUDES — the keep-hidden shape, wrong
/// here: a passthrough scrim must let touches reach what's BEHIND it), so the twin is
/// WITHHOLDING the gesture arms across the subtree: decorate's interactive arms and the
/// control branches consult this local and wire nothing, leaving the subtree out of hit
/// testing entirely — a touch lands on whatever is underneath, exactly the iOS outcome.
/// PINNED DIVERGENCE: a real SYSTEM control authored inside a passthrough subtree (an M3
/// Button/Switch — a degenerate authoring: the attribute is for decorative scrims) keeps
/// its component-internal hit-testing here, where iOS kills it.
internal val LocalDsxPassthrough = compositionLocalOf { false }

/// on:tap on a non-control element (+ on:longpress), dispatched exactly like iOS:
/// `runGated` with `arg:*` payload, debounce/throttle from `on:tap.debounce|throttle`,
/// gateKey "<tag>.tap". Controls wire their own tap in `Raw` (tapControls skip).
/// The INTERACTIVE arms ride ONE `composed {}` block — materialized at the layout node's
/// composition site, which is inside NodeBody's passthrough provider, so every caller
/// (elementModifier's registered slots included) inherits the passthrough gate for free.
internal fun Modifier.decorate(node: StackNode, a: Map<String, String>, store: StackStore, env: JSERunner, item: Map<String, Any?>?): Modifier {   // internal: the elements/ wave re-applies it (elementModifier — Elements.kt)
    var out: Modifier = this
    // The parity-capture seam (ParityCapture.kt): armed only by the capture harness,
    // one @Volatile null read per element otherwise. Leftmost, so the reported bounds
    // are the element's full styled box.
    ParityCapture.session?.let { s ->
        if (s.capturesNode(node)) out = s.modifier(node, a).then(out)
    }
    val isControl = node.tag in tapControls
    val tapAction = if (isControl) null else a["on:tap"]
    // `href=` alone makes any non-control element a link (tap → route.push, /web/04)
    val href = if (isControl) null else a["href"]
    val longAction = a["on:longpress"]
    if (tapAction != null || href != null || longAction != null) {
        out = out.then(Modifier.composed {
            if (LocalDsxPassthrough.current) return@composed Modifier
            val click: (() -> Unit)? = if (tapAction != null || href != null) {
                {
                    if (tapAction != null) runTap(node, tapAction, a, store, env, item)
                    followHref(a, store, env, item)
                }
            } else null
            val longClick: (() -> Unit)? = longAction?.let { act ->
                { env.run(act, item) }
            }
            // Keep the authored raw recognizer for touch gesture arbitration. Semantics and
            // hardware activation ride beside it on the same LayoutNode, yielding one merged
            // accessibility node rather than a second clickable wrapper.
            Modifier
                .dsxAccessibleActivation(
                    role = Role.Button,
                    onClick = click,
                    onLongClick = longClick,
                )
                .pointerInput(tapAction, href, longAction) {
                    detectTapGestures(
                        onTap = click?.let { action -> { _ -> action() } },
                        onLongPress = longClick?.let { action -> { _ -> action() } },
                    )
                }
        })
    }
    // on:hoverStart / on:hoverEnd — the pointer-hover lifecycle on ANY element
    // (desktop-platforms.md input grammar; the platform corpus pins the names).
    // Compose hover = Enter/Exit pointer events, which Android emits only for a
    // REAL pointer (mouse / stylus); finger touch never synthesizes them —
    // Article-7 degradation, identical to the web twin's `(hover: hover)` gate and
    // SwiftUI `.onHover` (Stack.swift decorate). The Compose-desktop renderer (D1)
    // inherits this wiring unchanged.
    val hoverStart = a["on:hoverStart"]
    val hoverEnd = a["on:hoverEnd"]
    if (hoverStart != null || hoverEnd != null) {
        out = out.then(Modifier.composed {
            if (LocalDsxPassthrough.current) return@composed Modifier
            Modifier.pointerInput(hoverStart, hoverEnd) {
            val hover = HoverLifecycle()
            fun dispatch(actions: List<HoverLifecycleAction>) {
                for (action in actions) when (action) {
                    HoverLifecycleAction.Start -> hoverStart?.let { env.run(it, item) }
                    HoverLifecycleAction.End -> hoverEnd?.let { env.run(it, item) }
                }
            }
            try {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        when (event.type) {
                            PointerEventType.Enter -> for (change in event.changes) {
                                val kind = hoverPointerKind(change.type)
                                dispatch(hover.enter(change.id.value.toString(), kind, kind != "touch"))
                            }
                            PointerEventType.Exit -> for (change in event.changes) {
                                dispatch(hover.leave(change.id.value.toString()))
                            }
                            else -> {}
                        }
                    }
                }
            } finally {
                // pointerInput is cancelled when the element unmounts or its handler keys
                // change. An accepted enter must still receive exactly one authored end.
                dispatch(hover.unmount())
            }
            }
        })
    }
    // The pointer lifecycle on ANY element (your "div") — `on:dragStart` (press / grab),
    // `on:drag` (move, continuous), `on:dragEnd` (release). The StackDrag twin
    // (Stack.swift ~4584-4626) + the web mount.ts twin: compose your OWN slider / seek bar /
    // knob / swipe-to-dismiss, no system control involved.
    if (a["on:drag"] != null || a["on:dragStart"] != null || a["on:dragEnd"] != null) {
        out = out.then(Modifier.composed {
            if (LocalDsxPassthrough.current) Modifier
            else Modifier.dsxDrag(a["on:dragStart"], a["on:drag"], a["on:dragEnd"], env, item)
        })
    }
    // `measure="dsx.variable.k"` — write the element's live { width, height } to a state path,
    // so a custom fill/thumb can be sized against it (StackMeasure, Stack.swift ~4629-4650).
    // NOT gated by passthrough: measurement is observation, not interaction (iOS's
    // allowsHitTesting leaves GeometryReader running too).
    a["measure"]?.takeIf { it.isNotEmpty() }?.let { out = out.then(Modifier.dsxMeasure(it, store, item)) }
    // `ref="name"` — publish this element's backing view so a MODULE can reach it
    // (capture.element, scroll.toElement, Spotlight). The kernel names no consumer: it
    // publishes under StackRef.key and the module resolves over the bus. Law:
    // Conformance/input/ref.json; the recycling rule lives in RefRegistry, not here.
    a["ref"]?.takeIf { StackRef.key(it) != null }?.let { out = out.then(Modifier.dsxRef(it)) }
    // U03 `shared=` — measure into the flight registry and pose while the pair flies. The
    // DESTINATION declares mode/anim/order, the source is the fallback, the frame's own `anim`
    // is the floor (Conformance/router/shared.json). A node without the attribute pays one
    // map lookup and composes identically.
    if (a["shared"] != null) out = out.then(Modifier.sharedElement(store.frameId, a))
    // `on:adjust` — the assistive adjustable action that makes an `on:drag` control operable
    // WITHOUT sight (Stack.swift decorate's accessibilityAdjustableAction). iOS gets a first-
    // class .adjustable trait (a VoiceOver swipe up/down); Compose has no adjustable trait for
    // a non-Slider node, so the twin is the pair of CUSTOM ACTIONS TalkBack offers in its
    // actions menu — the same named event, the same `dsx.this`. DECLARED: two menu entries
    // instead of one swipe axis (the DesktopStyleRuntime.kt twin makes the same trade).
    a["on:adjust"]?.takeIf { it.isNotEmpty() }?.let { action ->
        out = out.then(Modifier.composed {
            if (LocalDsxPassthrough.current) return@composed Modifier
            Modifier.semantics {
                customActions = listOf(
                    CustomAccessibilityAction("Increment") { fireAdjust(env, action, "increment"); true },
                    CustomAccessibilityAction("Decrement") { fireAdjust(env, action, "decrement"); true },
                )
            }
        })
    }
    // RATIFIED demand-driven absence (rendering-1.0-finalization.md §4, the Godot/AR
    // precedent): on:swipeLeading / on:swipeTrailing on an ARBITRARY element exists only in
    // Stack.swift (grep-verified: no web implementation, no StackReference row, zero `.dsx`
    // corpus uses — and iOS's `.swipeActions` only functions inside a system List row). It
    // lands on all three renderers, fixtures-first, with the first customer demand.
    return out
}

/// `on:adjust` payload — `dsx.this` = { direction, phase }, dispatched exactly like iOS
/// (`env.run(action, item: p, args: p)`), so the handler reads `dsx.this.direction`.
private fun fireAdjust(env: JSERunner, action: String, direction: String) {
    val p: Map<String, Any?> = mapOf("direction" to direction, "phase" to "adjust")
    env.run(action, p, p)
}

/// The StackDrag twin (Stack.swift ~4589-4626). `minimumDistance: 0` is the load-bearing
/// detail — SwiftUI's DragGesture(minimumDistance: 0) fires on the PRESS, so a tap seeks a
/// custom scrubber. Compose's `detectDragGestures` waits for touch slop, so the twin is the
/// raw `awaitEachGesture` + `drag()` pair: down → `on:dragStart` (phase "start") then
/// `on:drag` (phase "move"); every move → `on:drag` (phase "move"); release → `on:dragEnd`,
/// falling back to `on:drag`, with phase "end" — the same order and the same fallback the
/// Swift `onEnded` and the web `mount.ts` pointerup take.
///
/// Payload (`dsx.this` AND the arg scope, like iOS): x · y (local point) · width · height
/// (the element's size) · fraction (x/width, clamped 0-1) · fractionY · dx · dy (translation
/// from the press) · phase. UNITS: dp, the density-independent twin of iOS points (Compose
/// hands out raw px) — so `{{ dsx.this.fraction }}` and every geometry read agree across the
/// two renderers. DECLARED: a CANCELLED gesture (an ancestor stealing the pointer) still
/// delivers phase "end" — Compose surfaces no separate cancel to the author, and the web twin
/// maps pointercancel to the same "end"; SwiftUI simply drops it.
private fun Modifier.dsxDrag(
    onStart: String?,
    onDrag: String?,
    onEnd: String?,
    env: JSERunner,
    item: Map<String, Any?>?,
): Modifier = composed {
    // Keyed by composition slot, like every other remember here — NOT by `node`: StackNode is
    // a data class, so keying on it would deep-compare the whole subtree on every recomposition.
    var size by remember { mutableStateOf(IntSize.Zero) }
    val density = LocalDensity.current
    fun fire(action: String?, position: Offset, translation: Offset, phase: String) {
        if (action.isNullOrEmpty()) return
        with(density) {
            val w = size.width.toDp().value.toDouble().coerceAtLeast(1.0)
            val h = size.height.toDp().value.toDouble().coerceAtLeast(1.0)
            val x = position.x.toDp().value.toDouble()
            val y = position.y.toDp().value.toDouble()
            val p: Map<String, Any?> = mapOf(
                "x" to x, "y" to y, "width" to w, "height" to h,
                "fraction" to (x / w).coerceIn(0.0, 1.0),
                "fractionY" to (y / h).coerceIn(0.0, 1.0),
                "dx" to translation.x.toDp().value.toDouble(),
                "dy" to translation.y.toDp().value.toDouble(),
                "phase" to phase,
            )
            env.run(action, p, p)
        }
    }
    Modifier
        .onSizeChanged { size = it }
        .pointerInput(onStart, onDrag, onEnd) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val start = down.position
                var position = start
                fire(onStart, position, Offset.Zero, "start")   // press / grab
                fire(onDrag, position, Offset.Zero, "move")     // minimumDistance 0: the press IS a move
                drag(down.id) { change ->
                    position = change.position
                    fire(onDrag, position, position - start, "move")
                    change.consume()                            // the element owns its pointer, like the Swift gesture
                }
                fire(onEnd ?: onDrag, position, position - start, "end")
            }
        }
}

/// `measure="dsx.variable.k"` — the StackMeasure twin (Stack.swift ~4629-4650): publish the
/// element's live { width, height } to a state path so markup can size a custom fill/thumb
/// against it (`width="{{ dsx.variable.pos * dsx.variable.k.width }}"`). Cheap by construction:
/// `onSizeChanged` only fires on a real size change, and the write is elided when the stored
/// value already agrees (the Swift `guard s != last`). dp, like the drag payload.
private fun Modifier.dsxMeasure(key: String, store: StackStore, item: Map<String, Any?>?): Modifier = composed {
    val density = LocalDensity.current
    Modifier.onSizeChanged { size ->
        val value: Map<String, Any?> = with(density) {
            mapOf("width" to size.width.toDp().value.toDouble(),
                  "height" to size.height.toDp().value.toDouble())
        }
        if (!JSE.equals(JSE.eval(key, store, item), value)) store.writeBound(key, value)
    }
}

/// `ref=` — publish the element's backing view into the shared-handle registry while it is on
/// screen, and withdraw on dispose. The registry is process-wide and its recycling rule (only the
/// CURRENT provider may clear) lives in the shared RefRegistry core, so a recycled row that
/// unmounts AFTER the incoming row claimed the name cannot kill the visible one.
private fun Modifier.dsxRef(name: String): Modifier = composed {
    val view = LocalView.current
    DisposableEffect(name, view) {
        DSXRefs.registry.provide(name, view)
        onDispose { DSXRefs.registry.clear(name, view) }
    }
    this@dsxRef
}

/// The ONE process-wide ref table for this renderer, so every surface resolves the same names.
private object DSXRefs {
    val registry = RefRegistry<android.view.View>()
}

private fun runTap(node: StackNode, action: String, a: Map<String, String>, store: StackStore, env: JSERunner, item: Map<String, Any?>?) {
    env.runGated(action, item, eventArgs(a, store, item),
                 debounceMs = JSERunner.gateMs(a, "tap", "debounce"),
                 throttleMs = JSERunner.gateMs(a, "tap", "throttle"),
                 gateKey = node.tag + ".tap")
}

/// `href=` — the ANCHOR attribute (/web/04): after `on:tap` (if any), a tap on an element
/// carrying `href` navigates the route table — the declarative twin of
/// `dsx.module.route.push({ path: <href> })`, identical on every renderer (the web renders
/// a REAL crawlable `<a>`). `{{ }}` interpolates; an empty resolve is a no-op.
private fun followHref(a: Map<String, String>, store: StackStore, env: JSERunner, item: Map<String, Any?>?) {
    val raw = a["href"] ?: return
    val path = JSE.interpolate(raw, store, item)
    if (path.isEmpty()) return
    env.run("dsx.module.route.push({ path: __href })", item, mapOf("__href" to path))
}

// MARK: - <action as=…> registration (twin of Swift raw()'s "action" case, Stack.swift ~4058)

/// A named, reusable action — optionally PARAMETERIZED like `<formula>`: the identifier
/// is `as`, and every OTHER attr is an input (an expression bound, in the CALLER's scope,
/// when the action runs). The body registers any inline `function name(){…}` too. Writes
/// through :core's public seam (`StackStore.registerAction` — Swift assigns
/// `store.actions[name]` directly); idempotent, a same-name re-registration replaces
/// (the re-render override rule). Invocation is untouched here — the runner's statement
/// dispatch (`action()` / `action(argsObj, { eventCallbacks })`, JseRunner.kt ~891)
/// already twins Stack.swift ~1958.
internal fun registerHeadAction(node: StackNode, a: Map<String, String>, store: StackStore) {
    JSE.registerFunctions(node.text ?: "", store)
    val name = a["as"] ?: return
    val inputs = HashMap(a)
    inputs.remove("as")
    inputs.remove("id")
    store.registerAction(name, inputs, node.text ?: "")
}

// MARK: - alignment maps (twin of Swift StackNodeView.hAlign/vAlign/zAlign)

internal fun hAlign(s: String?): Alignment.Horizontal = when (s) {
    "center" -> Alignment.CenterHorizontally
    "trailing" -> Alignment.End
    else -> Alignment.Start
}
internal fun vAlign(s: String?): Alignment.Vertical = when (s) {
    "top" -> Alignment.Top
    "bottom" -> Alignment.Bottom
    else -> Alignment.CenterVertically
}
internal fun zAlign(s: String?): Alignment = when (s) {
    "top" -> Alignment.TopCenter
    "bottom" -> Alignment.BottomCenter
    "leading" -> Alignment.CenterStart
    "trailing" -> Alignment.CenterEnd
    "topLeading" -> Alignment.TopStart
    "topTrailing" -> Alignment.TopEnd
    "bottomLeading" -> Alignment.BottomStart
    "bottomTrailing" -> Alignment.BottomEnd
    else -> Alignment.Center
}

// CSS align-items → the cross-axis alignment for the generic <stack> — twin of
// StackContainerElement.swift's crossHAlign/crossVAlign/overlayAlign. CSS words
// normalize onto the legacy tokens so `align` keeps working unchanged; `stretch`
// (the CSS initial) needs real flex layout and lands with Taffy — v1 falls back
// to each axis's legacy default. (`baseline` has no Row alignment-line twin in
// this wave — pinned: it falls to the vertical default like stretch.)
internal fun crossHAlign(s: String): Alignment.Horizontal = when (s) {
    "center" -> Alignment.CenterHorizontally
    "flex-end", "end", "trailing" -> Alignment.End
    else -> Alignment.Start   // flex-start/start/leading/stretch(v1)/unset
}
internal fun crossVAlign(s: String): Alignment.Vertical = when (s) {
    "flex-start", "start", "top" -> Alignment.Top
    "flex-end", "end", "bottom" -> Alignment.Bottom
    else -> Alignment.CenterVertically   // center/baseline(v1)/stretch(v1)/unset
}
internal fun overlayAlign(s: String): Alignment = when (s) {
    "flex-start", "start", "top" -> Alignment.TopCenter
    "flex-end", "end", "bottom" -> Alignment.BottomCenter
    "leading" -> Alignment.CenterStart
    "trailing" -> Alignment.CenterEnd
    "topLeading" -> Alignment.TopStart
    "topTrailing" -> Alignment.TopEnd
    "bottomLeading" -> Alignment.BottomStart
    "bottomTrailing" -> Alignment.BottomEnd
    else -> Alignment.Center
}

// MARK: - raw() — the tag dispatch

@Composable
private fun Raw(
    node: StackNode,
    a: Map<String, String>,
    modifier: Modifier,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
    surfaceSnapshot: Map<String, Any?>,
    globalSnapshot: Map<String, Any?>,
    cookieSnapshot: Map<String, String>,
) {
    val m = modifier
    // Keep all invalidation-token parameters live in this final restart scope. Their
    // changed identities force Raw to re-run the bindings below without remounting it.
    surfaceSnapshot.size
    globalSnapshot.size
    cookieSnapshot.size

    // Privileged components first (list/grid/pager/tabs/scaffold) — none registered this
    // wave; the dispatch slot matches Swift so they drop in without reordering.
    ComposeStackComponents.privilegedGlobal(node.tag)?.let { build ->
        build(componentContext(node, a, store, env, item, rowWrite))
        return
    }
    fun interp(s: String?): String? = s?.let { JSE.interpolate(it, store, item) }
    when (node.tag) {
        // ── declaration/structural tags: register + render nothing (or children) ──
        // transparent — declarations register as children render. G4 unified input
        // (dsx-game.md §2): a `<input>` CHILD OF THE HEAD is a device-binding declaration,
        // and the body tag of the same name stays the `textfield` alias — POSITION is the
        // whole disambiguation, so the head inputs register here and never reach the tag
        // dispatch below.
        "head" -> {
            val declared = node.children.filter { it.tag == "input" }
            if (declared.isNotEmpty()) {
                DisposableEffect(node) {
                    DsxInputRuntime.register(node, declared.map { child -> child.attrs.mapValues { it.value } })
                    onDispose { DsxInputRuntime.unregister(node) }
                }
                Children(StackNode(node.tag, node.attrs, node.children.filter { it.tag != "input" }, node.text),
                         store, env, item, rowWrite)
            } else {
                Children(node, store, env, item, rowWrite)
            }
        }
        // <tool> is the AGENT interface row (proposals/webmcp.md): it names a declared
        // action and renders nothing. Inert on this renderer by nature, not by omission -
        // there is no `document.modelContext` outside a browser, so the row is validated by
        // the shared WebMcp fold and waits for its consumer.
        "event", "expects", "tool" -> {}                        // purely declarative contracts
        "action" -> registerHeadAction(node, a, store)
        "api" -> StackApiView(a, store, env, item)
        "variable", "var", "let" -> {
            JSE.registerFunctions(node.text ?: "", store)
            val name = a["as"]
            if (name != null) {
                if (a["computed"] == "true") store.computed[name] = node.text ?: ""
                else if (store.initials[name] == null) store.initials[name] = JSE.evalBlock(node.text ?: "", store, item) ?: ""
            }
        }
        "component" -> {
            val name = a["as"]
            if (!name.isNullOrEmpty()) {
                val template = if (node.children.size == 1) node.children[0]
                               else StackNode("vstack", emptyMap(), node.children)
                ComposeStackComponents.defineNode(name, template, env.scope)
            }
        }
        "formula" -> {
            JSE.registerFunctions(node.text ?: "", store)
            a["as"]?.let { name ->
                val inputs = HashMap(a); inputs.remove("as"); inputs.remove("id")
                store.formulas[name] = StackFormula(inputs, node.text ?: "")
            }
        }
        "script", "functions" -> JSE.registerFunctions(node.text ?: "", store)
        "watch" -> WatchView(a, store, env, item)
        "attribute" -> {
            // <attribute as="x" default="<expr>" on:change="<action>"/> — DECLARES a component
            // attribute: its default (used when the consumer omits `x`) and an optional change
            // watcher, i.e. "dsx.attribute.x with a default, optionally watched". The watcher IS
            // a <watch> over `dsx.attribute.x` — the same construction Swift returns
            // (Stack.swift ~5467-5476), so a live re-seed of `dsx.attribute` (Router.pushNative /
            // presentModal attrs, `route.updateComponent`) fires it exactly like a store write.
            val name = a["as"]
            val def = a["default"]
            if (name != null && def != null && store.attrDefaults[name] == null) store.attrDefaults[name] = def
            val change = a["on:change"]
            if (name != null && change != null) {
                WatchView(mapOf("value" to "dsx.attribute.$name",
                                "on:change" to change,
                                "immediate" to (a["immediate"] ?: "false")),
                          store, env, item)
            }
        }
        "override" -> {
            // <override as="radius" type="length" default="12"/> — DECLARES a style knob
            // (the component STYLE contract beside the attribute DATA contract). The raw
            // values arrive through the item scope's __overrides dict (the tag door) or
            // the store's dsx.override var (the mount/update door); Jse.kt's lookup
            // resolves reads through StyleOverrides.resolve. Corpus:
            // OpenSource/Conformance/overrides/style-overrides.json.
            val name = a["as"]
            if (!name.isNullOrEmpty() && store.overrideDecls[name] == null) {
                store.overrideDecls[name] = OverrideDecl(
                    name = name, type = a["type"], default = a["default"],
                    options = a["options"], min = a["min"], max = a["max"],
                )
            }
        }
        "style" -> {
            a["as"]?.let { name ->
                val def = HashMap(a); def.remove("as"); def.remove("id")
                store.classes[name] = def
            }
        }
        "slot" -> {
            val slot = env.slot
            if (slot != null) {
                val name = a["name"]
                for (kid in slot.children.filter { it.attrs["slot"] == name }) {
                    // Rendered in the CONSUMER's scope AND store (slot.env carries the
                    // caller's store - the instance-store law), like iOS and the web.
                    StackNodeView(kid, slot.env.store, slot.env, slot.item, slot.rowWrite)
                }
            }
        }
        "node", "dynamic" -> {
            // Data-driven tag, restricted to what THIS binary ships (the capability
            // boundary): unknown tags render nothing — the SILENT arm is correct and final
            // (an unshipped/excluded tag must fail open, Stack.swift ~5505-5513). But a tag
            // whose template FAILED TO PARSE is a real error: on test channels render the
            // diagnostic card instead of blank (Stack.swift:5514 — failedToParse gates on
            // isTest, so production renders exactly what it rendered before).
            val dynamicTag = interp(a["tag"] ?: "") ?: ""
            when {
                dynamicTag.isEmpty() -> Children(node, store, env, item, rowWrite)
                else -> {
                    val priv = ComposeStackComponents.privilegedGlobal(dynamicTag)
                    if (priv != null) priv(componentContext(node, a, store, env, item, rowWrite))
                    else if (!component(dynamicTag, node, a, store, env, item, rowWrite) &&
                             StackDiagnostics.failedToParse(dynamicTag)) {
                        StackDiagnosticCard(dynamicTag)   // known-dead registration, never silent
                    }
                }
            }
        }

        // ── the K4 core render set ──
        "vstack" -> {
            val spacing = interp(a["spacing"])?.let { JSE.number(it) } ?: ElementDefaults.STACK_SPACING   // SwiftUI system spacing ≈ 8
            Column(modifier = m,
                   verticalArrangement = if (spacing > 0) Arrangement.spacedBy(spacing.dp) else Arrangement.Top,
                   horizontalAlignment = hAlign(interp(a["align"]))) {
                FlexColumnChildren(node, store, env, item, rowWrite)
            }
        }
        "hstack" -> {
            val spacing = interp(a["spacing"])?.let { JSE.number(it) } ?: ElementDefaults.STACK_SPACING
            Row(modifier = m,
                horizontalArrangement = if (spacing > 0) Arrangement.spacedBy(spacing.dp) else Arrangement.Start,
                verticalAlignment = vAlign(interp(a["align"]))) {
                FlexRowChildren(node, store, env, item, rowWrite)
            }
        }
        "zstack" -> {
            Box(modifier = m, contentAlignment = zAlign(interp(a["align"]))) {
                Children(node, store, env, item, rowWrite)
            }
        }
        "stack" -> {
            // The generic CSS-driven container (StackContainerElement.swift): flexbox
            // decides the concrete layout — `flex-direction: column` (the default when
            // unset) is a vertical stack, `row` horizontal, and `display: grid` (v1,
            // before Taffy tracks) is the single-cell overlap idiom (the web's "grid
            // stack": every child in the same cell), i.e. a depth stack. Web-true and
            // only on this element: unset gap = 0, cross-axis alignment reads CSS
            // `align-items` with the legacy `align` tokens as fallback. The cascade has
            // already collapsed row/column-gap onto `spacing` by THIS element's axis and
            // translated display:none into the css-hidden gate.
            val items = if (a["alignItems"] != null) interp(a["alignItems"]) ?: "" else interp(a["align"]) ?: ""
            if (interp(a["display"]) == "grid") {
                Box(modifier = m, contentAlignment = overlayAlign(items)) { Children(node, store, env, item, rowWrite) }
            } else {
                val dir = interp(a["flexDirection"]) ?: "column"
                val gap = interp(a["spacing"])?.let { JSE.number(it) } ?: ElementDefaults.GENERIC_STACK_GAP
                if (dir.startsWith("row")) {
                    if (FlexWrapPolicy.wrapsRows(dir, interp(a["flexWrap"]))) {
                        WrappedRow(
                            modifier = m,
                            gap = gap,
                            alignment = crossVAlign(items),
                        ) {
                            Children(node, store, env, item, rowWrite)
                        }
                    } else {
                        Row(modifier = m,
                            horizontalArrangement = if (gap > 0) Arrangement.spacedBy(gap.dp) else Arrangement.Start,
                            verticalAlignment = crossVAlign(items)) {
                            FlexRowChildren(node, store, env, item, rowWrite)
                        }
                    }
                } else {
                    Column(modifier = m,
                           verticalArrangement = if (gap > 0) Arrangement.spacedBy(gap.dp) else Arrangement.Top,
                           horizontalAlignment = crossHAlign(items)) {
                        FlexColumnChildren(node, store, env, item, rowWrite)
                    }
                }
            }
        }
        "text", "label" -> {
            // bind= takes precedence over value= over text content (StackReference).
            // Bound content is app/user DATA and must stay byte-identical. Authored `value` or
            // inner text is UI copy, so it goes through the same DSXStrings choke point as iOS.
            val bound = a["bind"]?.let { JSE.eval(it, store, item) }
            // `textCase` cases the STRING here — SwiftUI's `.textCase()` is a view modifier
            // with no Compose twin (StackStyle header). Applied AFTER localization, exactly
            // where iOS applies it: to the resolved Text, whatever produced its content.
            val content = StackStyle.textCase(a, when {
                bound != null -> JSE.string(bound)
                a["value"] != null -> DSXStrings.localize(interp(a["value"]) ?: "")
                else -> DSXStrings.localize(interp(node.text ?: "") ?: "")
            })
            val systemListRole = if (LocalSystemMaterialListItem.current) SystemList.textRole(a) else null
            val color = when {
                a["color"] != null -> StackStyle.color(interp(a["color"]) ?: ElementDefaults.TEXT_COLOR)
                systemListRole == SystemList.TextRole.HEADLINE -> MaterialTheme.colorScheme.onSurface
                systemListRole == SystemList.TextRole.SUPPORTING -> MaterialTheme.colorScheme.onSurfaceVariant
                else -> StackStyle.color(ElementDefaults.TEXT_COLOR)
            }
            val lineLimit = a["lineLimit"]?.toIntOrNull()
            val authoredStyle = StackStyle.styleText(a, store, item, color)
            // `type=` names a rung of the ratified ramp (Conformance/defaults/type.json), and
            // the Android column of that file is a Material ROLE, never a number - so the rung
            // tracks the Material scale and the reader's font-size setting. It sits UNDER the
            // authored style, exactly where the system-list role sits: naming a rung is picking
            // a starting point, and an explicit fontSize= still wins.
            val ramp = TypeRamp.material(interp(a["type"]))?.let { materialTypography(it) }
            val textStyle = when {
                systemListRole == SystemList.TextRole.HEADLINE -> MaterialTheme.typography.bodyLarge.merge(authoredStyle)
                systemListRole == SystemList.TextRole.SUPPORTING -> MaterialTheme.typography.bodyMedium.merge(authoredStyle)
                ramp != null -> ramp.merge(authoredStyle)
                else -> authoredStyle
            }
            val markdownOn = interp(a["markdown"]) == "true" || interp(a["markdown"]) == "1"
            if (markdownOn) {
                val bodySize = textStyle.fontSize.value.takeIf { it > 0f } ?: 17f
                BasicText(text = markdownInlineAnnotated(content, bodySize),
                          modifier = m,
                          style = textStyle,
                          maxLines = lineLimit ?: Int.MAX_VALUE,
                          overflow = if (lineLimit != null) TextOverflow.Ellipsis else TextOverflow.Clip)
            } else {
                BasicText(text = content,
                          modifier = m,
                          style = textStyle,
                          maxLines = lineLimit ?: Int.MAX_VALUE,
                          overflow = if (lineLimit != null) TextOverflow.Ellipsis else TextOverflow.Clip)
            }
        }
        "image" -> {
            // The UNREGISTERED fallback only: the REAL `<image>` — src=/asset= through the
            // content-plane cache tiers + GIF decode, the Image.swift + DSXImageCache.swift
            // twin — is elements/ImageElements.kt, registered PRIVILEGED by
            // InputElements.register() (production boots do), which shadows this branch.
            // Here: icon=/systemImage= through the sf-map render ladder (StackIcons.kt);
            // defaults per StackReference (iconSize 24, color `label`); src=/asset= hold a
            // sized transparent layout slot so surrounding markup still renders true.
            val iconSize = (interp(a["iconSize"]) ?: interp(a["fontSize"]))?.let { JSE.number(it) } ?: ElementDefaults.IMAGE_ICON_SIZE
            val icon = interp(a["icon"] ?: a["systemImage"])
            if (!icon.isNullOrEmpty()) {
                StackIcon(icon, iconSize, StackStyle.color(interp(a["color"]) ?: ElementDefaults.IMAGE_COLOR), m)
            } else {
                Box(m.then(Modifier.size(iconSize.dp)))
            }
        }
        "button", "glassButton", "transport", "pressable", "row" -> {
            // Controls wire their own tap (Swift: their Button) — decorate skipped them.
            // `href=` navigates after on:tap (the /web/04 link contract).
            // Inside a passthrough subtree the wiring is withheld entirely (the
            // LocalDsxPassthrough contract above) — the control renders, inert.
            val passthroughHit = LocalDsxPassthrough.current
            val tap = if (passthroughHit) null else a["on:tap"]
            val href = if (passthroughHit) null else a["href"]
            // ── the SYSTEM path (system-defaults.md; StackButtons.kt): the RECONCILED
            //    gate — a fully-UNSTYLED button-family element renders the REAL M3
            //    control (TextButton; FilledTonalButton for variant="bordered", filled
            //    Button for "prominent", the error emphasis for role="destructive", the
            //    semibold weight for role="cancel"), and a variant/role WORD is the
            //    author's explicit opt-in that additionally admits color= (the compatible
            //    tint), iconSize=, and the LAYOUT attrs (threaded INSIDE the tap target —
            //    the iOS controlBox twin). Everything else — color= without a word
            //    included — keeps the legacy box below byte-identical (the inert-landing
            //    invariant). pressable/row stay bare containers; children stay the
            //    composed custom path. ──
            if ((node.tag == "button" || node.tag == "glassButton" || node.tag == "transport") &&
                node.children.isEmpty() && SystemButton.rendersSystem(a)) {
                // remember keys compare with equals — Map equality is structural, so the
                // per-recomposition rebuilt-but-equal attrs map hits the cache and
                // M3ButtonView sees ONE stable onTap instance instead of closure churn.
                val onTap: (() -> Unit)? = if (tap != null || href != null) remember(tap, href, a, item) {
                    {
                        if (tap != null) runTap(node, tap, a, store, env, item)
                        followHref(a, store, env, item)
                    }
                } else null
                // LAYOUT attrs (words path only — the gate ejects them otherwise) thread
                // onto the M3 control INSIDE its tappable core, the controlBox twin: the
                // padded/grown box IS the button, so a tap in the padding registers. The
                // gesture/a11y remainder of the chain stays on the control itself.
                val hasLayout = a.keys.any { it in SystemButton.LAYOUT }
                val outer = if (hasLayout) Modifier.decorate(node, a, store, env, item)
                    .then(StackStyle.apply(a - SystemButton.LAYOUT, store, item, node.tag)) else m
                val box = if (hasLayout)
                    StackStyle.apply(a.filterKeys { it in SystemButton.LAYOUT }, store, item, node.tag) else Modifier
                M3ButtonView(
                    modifier = outer,
                    box = box,
                    label = (interp(a["label"]) ?: node.text?.let { interp(it) })
                        ?.let(DSXStrings::localize),
                    icon = interp(a["icon"]),
                    iconSize = interp(a["iconSize"])?.let { JSE.number(it) } ?: ElementDefaults.BUTTON_ICON_SIZE,
                    authorTint = interp(a["color"])?.let { StackStyle.color(it) },   // the compatible tint tweak
                    variantWord = interp(a["variant"]),
                    roleWord = interp(a["role"]),
                    disabled = JSE.truthy(interp(a["disabled"])) || JSE.truthy(interp(a["disabled-if"])),
                    onTap = onTap)
                return
            }
            var bm = m
            // ── the MULTI-GESTURE surface (pressable/row only — Pressable.swift's branch):
            //    on:doubleTap and/or on:longPress(+End) turn the wrapper into the TikTok
            //    contract (StackPressable.kt header). The Button/clickable path drops out
            //    entirely, exactly like iOS (no StackButtonStyle → no press scale, no
            //    indication); one hand-rolled recognizer owns physical arbitration, and
            //    dsxAccessibleActivation + the named custom actions supply the non-pointer
            //    half (the PressableNativeActivation twin). ──
            val hasDouble = !passthroughHit &&
                (node.tag == "pressable" || node.tag == "row") && a["on:doubleTap"] != null
            val hasLong = !passthroughHit &&
                (node.tag == "pressable" || node.tag == "row") &&
                (a["on:longPress"] != null || a["on:longPressEnd"] != null)
            if (hasDouble || hasLong) {
                val gestureDisabled = JSE.truthy(interp(a["disabled"])) || JSE.truthy(interp(a["disabled-if"]))
                val hasPrimary = tap != null || href != null
                val primaryAction: (() -> Unit)? = if (hasPrimary) {
                    { if (tap != null) runTap(node, tap, a, store, env, item)
                      followHref(a, store, env, item) }
                } else null
                val doubleAction: (() -> Unit)? = a["on:doubleTap"]?.takeIf { hasDouble }?.let { act ->
                    { env.run(act, item) }
                }
                val longBeginAction: (() -> Unit)? = a["on:longPress"]?.let { act ->
                    { env.run(act, item) }
                }
                val longEndAction: (() -> Unit)? = a["on:longPressEnd"]?.let { act ->
                    { env.run(act, item) }
                }
                // Long-press-only surfaces expose their lifecycle as one atomic activation so
                // a held visual state cannot get stranded; a double-tap-only surface still
                // needs one keyboard/assistive primary (Pressable.swift's activate chain).
                val longAtomic: (() -> Unit)? = if (hasLong) {
                    { longBeginAction?.invoke(); longEndAction?.invoke() }
                } else null
                val activate: () -> Unit = primaryAction ?: doubleAction ?: { longAtomic?.invoke() }
                var gm: Modifier = Modifier.dsxAccessibleActivation(
                    enabled = !gestureDisabled,
                    onClick = activate,
                    onLongClick = longAtomic,
                )
                // The custom-actions rotor must reach the double too (the on:adjust precedent:
                // TalkBack's actions menu is the named-accessibility-action twin).
                if (doubleAction != null && !gestureDisabled) {
                    val doubleLabel = interp(a["a11yDoubleTapLabel"])?.let(DSXStrings::localize)
                        ?: "Double tap action"
                    gm = gm.then(Modifier.semantics {
                        customActions = listOf(CustomAccessibilityAction(doubleLabel) {
                            doubleAction(); true
                        })
                    })
                }
                // The recognizer PRECEDES the style chain (the clickable-path rule): the hit
                // region is the element's FULL styled box.
                bm = gm.then(Modifier.dsxPressableGestures(
                    enabled = !gestureDisabled,
                    onPrimary = primaryAction,
                    onDouble = doubleAction,
                    onLongBegin = longBeginAction,
                    onLongEnd = longEndAction,
                )).then(m)
                Box(modifier = bm, contentAlignment = Alignment.Center) {
                    val label = interp(a["label"])?.let(DSXStrings::localize)?.let { StackStyle.textCase(a, it) }
                    when {
                        node.children.isNotEmpty() -> Children(node, store, env, item, rowWrite)
                        label != null -> BasicText(label, style = StackStyle.styleText(a, store, item,
                                                   StackStyle.color(interp(a["color"]) ?: ElementDefaults.BUTTON_COLOR)))
                        a["icon"] != null -> StackIcon(interp(a["icon"]) ?: "",
                            (interp(a["iconSize"]))?.let { JSE.number(it) } ?: ElementDefaults.BUTTON_ICON_SIZE,
                            StackStyle.color(interp(a["color"]) ?: ElementDefaults.BUTTON_COLOR))
                        node.text != null -> BasicText(StackStyle.textCase(a, DSXStrings.localize(interp(node.text) ?: "")),
                                                       style = StackStyle.styleText(a, store, item,
                                                       StackStyle.color(interp(a["color"]) ?: ElementDefaults.BUTTON_COLOR)))
                    }
                }
                return
            }
            // PRESS SCALE — the StackButtonStyle twin (Stack.swift ~4486-4499): a pressed
            // control snaps to 0.92 on `.easeOut(duration: 0.12)` and back on release. Scope
            // is exactly iOS's: the LEGACY (authored/ejected) path, which is where iOS applies
            // StackButtonStyle; an UNSTYLED button took the M3 branch above and wears the
            // platform's own state layer instead (system-defaults.md — the unstyled baseline IS
            // the platform, and M3 ships no scale). Only a control that actually activates gets
            // it, like iOS's Button.
            // DECLARED (two, both narrow): (1) the M3 ripple stays — it is Android's platform
            // press feedback and has no iOS twin, so this is additive, never a substitution;
            // (2) iOS scales the Button's LABEL + its controlBox (the padding/frame arms ride
            // inside the Button), leaving the fill layers unscaled — here the scale is the
            // INNERMOST arm of the box, so the content scales and the padding/frame stay put.
            // The 0.92 snap reads identically; the difference is a padding-width of travel.
            val pressSource = remember { MutableInteractionSource() }
            val pressed by pressSource.collectIsPressedAsState()
            val pressScale by animateFloatAsState(
                targetValue = if (pressed) ElementDefaults.BUTTON_PRESS_SCALE.toFloat() else 1f,
                animationSpec = StackMotion.spec(StackMotion.PRESS_SNAP),
                label = "dsx.button.press",
            )
            if (tap != null || href != null) {
                // The tap PRECEDES the style chain (pointerInput outermost), so the hit
                // region is the element's FULL styled box — appended after `m` it sat
                // inside the chain's padding, and taps on a button's padded, label-less
                // sides fell dead (the iOS twin carries the same rule: box geometry rides
                // inside the Button's label — Stack.swift `controlBox`). CSS button
                // semantics: a click in the padding is a click on the button.
                // A control is a semantic click target, not just a raw pointer listener.
                // Besides keyboard/switch-access parity with M3ButtonView, Foundation's
                // clickable path survives real-device input routing and gives
                // instrumentation/UiAutomator one actionable node. Keep it OUTSIDE the
                // style chain so the whole padded/background box remains the hit target.
                bm = Modifier.clickable(interactionSource = pressSource,
                                        indication = LocalIndication.current) {
                    if (tap != null) runTap(node, tap, a, store, env, item)
                    followHref(a, store, env, item)
                }.then(m)
                    .then(Modifier.graphicsLayer { scaleX = pressScale; scaleY = pressScale })
            }
            Box(modifier = bm, contentAlignment = Alignment.Center) {
                // textCase rides the label string here too — iOS cases the Button's label
                // through the same styleText pass (StackStyle header).
                val label = interp(a["label"])?.let(DSXStrings::localize)?.let { StackStyle.textCase(a, it) }
                when {
                    node.children.isNotEmpty() -> Children(node, store, env, item, rowWrite)
                    label != null -> BasicText(label, style = StackStyle.styleText(a, store, item,
                                               StackStyle.color(interp(a["color"]) ?: ElementDefaults.BUTTON_COLOR)))
                    a["icon"] != null -> StackIcon(interp(a["icon"]) ?: "",           // sf-map ladder (StackIcons.kt);
                        (interp(a["iconSize"]))?.let { JSE.number(it) } ?: ElementDefaults.BUTTON_ICON_SIZE,   // button iconSize default 20
                        StackStyle.color(interp(a["color"]) ?: ElementDefaults.BUTTON_COLOR))                  // (StackReference)
                    node.text != null -> BasicText(StackStyle.textCase(a, DSXStrings.localize(interp(node.text) ?: "")),
                                                   style = StackStyle.styleText(a, store, item,
                                                   StackStyle.color(interp(a["color"]) ?: ElementDefaults.BUTTON_COLOR)))
                }
            }
        }
        "spacer" -> {
            // Flexible spacers are emitted by the parent stack (weight needs its scope —
            // see header); reaching here means a SIZED spacer (width=/height= applied by
            // the style chain) or one outside a stack.
            Spacer(m)
        }
        "divider" -> {
            // Hairline rule — SwiftUI Divider ≈ a 1pt separator-colored line.
            Box(m.then(Modifier.fillMaxWidth().height(ElementDefaults.DIVIDER_THICKNESS.dp)
                .background(StackStyle.color(interp(a["color"]) ?: ElementDefaults.DIVIDER_COLOR))))
        }
        "markdown" -> {
            // The BLOCK markdown vocabulary (A4b) in the prose plane's design language —
            // MarkdownBlocksView.kt renders the neutral tree :core parses (corpus
            // OpenSource/Conformance/markdown/blocks.json, the SAME file the web and
            // Swift twins answer). `<text markdown>` uses the same inline parser.
            MarkdownBlocksElement(node, a, m, store, env, item, rowWrite)
        }
        "scroll" -> {
            // Both scrolling forms stamp the scroll-ancestor signal (the iOS
            // stackInScrollContainer twin — Scroll.swift stamps both its returns): a
            // descendant's SYSTEM list rendering stands down inside a scroll container
            // (StackSystemControls.kt LocalInScrollContainer — the flat pre-law path).
            val inVerticalScrollContainer = LocalInScrollContainer.current
            CompositionLocalProvider(LocalInScrollContainer provides true) {
                if (interp(a["axis"]) == "horizontal") {
                    Row(m.horizontalScroll(rememberScrollState())) { Children(node, store, env, item, rowWrite) }
                } else if (!ScrollNestingPolicy.ownsVerticalViewport(inVerticalScrollContainer)) {
                    Column(m) { Children(node, store, env, item, rowWrite) }
                } else {
                    val virtualized = if (ScrollVirtualizationPolicy.outerOwnsHeight(a)) {
                        LazyVerticalScrollStack(
                            scroll = node,
                            outerModifier = m,
                            store = store,
                            env = env,
                            item = item,
                            rowWrite = rowWrite,
                        )
                    } else false
                    if (!virtualized) {
                        Column(m.verticalScroll(rememberScrollState())) {
                            Children(node, store, env, item, rowWrite)
                        }
                    }
                }
            }
        }

        // ── data-bound containers + two-way inputs (the bind seam: StackInputViews.kt) ──
        "list" -> BoundList(node, a, m, store, env, item, rowWrite)
        "grid" -> BoundGrid(
            node, a, m, store, env, item, rowWrite,
            surfaceSnapshot, globalSnapshot,
        )
        "pager" -> Pager(
            node, a, m, store, env, item, rowWrite,
            surfaceSnapshot, globalSnapshot,
        )
        "tabs", "tabview" -> Tabs(
            node, a, m, store, env, item, rowWrite,
            surfaceSnapshot, globalSnapshot,
        )
        // ── the SYSTEM CONTROL path (system-defaults.md; StackSystemControls.kt — the
        //    StackButtons gate philosophy): fully-unstyled renders the REAL M3 component
        //    (Switch / Slider / CircularProgressIndicator / LinearProgressIndicator);
        //    any styling attr — and, for toggle/slider, color= — ejects to the legacy
        //    foundation-drawn view below byte-identically. spinner/progress admit color=
        //    as the compatible tint ON the M3 component (the iOS ProgressView().tint
        //    twin — the stated tint decision, StackSystemControls.kt header). Children
        //    (a composite the M3 form can't host) keep the legacy path too. ──
        "toggle", "switch" ->
            if (node.children.isEmpty() && SystemControl.rendersSystem(a, SystemControl.TOGGLE))
                M3ToggleView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
            else ToggleView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
        // textfield/input: unstyled → the REAL M3 filled TextField (SelectionControl.TEXTFIELD
        // — the shared allowlist, NOT a fork); any authored look / children eject to the legacy
        // BasicTextField byte-identically. B2's focus/IME event contract rides BOTH paths (wired
        // on the field modifier — M3TextFieldView / TextFieldView, StackInputViews.kt).
        "textfield", "input" ->
            if (node.children.isEmpty() && SelectionControl.rendersSystem(a, SelectionControl.TEXTFIELD))
                M3TextFieldView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
            else TextFieldView(a, m, store, item, BoundControl(node.tag, a, store, env, item, rowWrite))
        "slider" ->
            if (node.children.isEmpty() && SystemControl.rendersSystem(a, SystemControl.SLIDER))
                M3SliderView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
            else SliderView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
        "progress", "capsuleProgress" ->
            if (node.children.isEmpty() && SystemControl.rendersSystem(a, SystemControl.PROGRESS))
                M3ProgressView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
            else ProgressView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
        "spinner", "activity" ->
            if (node.children.isEmpty() && SystemControl.rendersSystem(a, SystemControl.SPINNER))
                M3SpinnerView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
            else SpinnerView(a, m, BoundControl(node.tag, a, store, env, item, rowWrite))
        else -> {
            // A Capitalized tag → an XML component, a native global, or a runtime
            // registration — else fall through to children (same order as iOS).
            if (!component(node.tag, node, a, store, env, item, rowWrite)) {
                // TEST CHANNELS: an unresolved LITERAL component reference with no children
                // to fall back on renders the kernel DIAGNOSTIC CARD instead of a silent
                // blank (Stack.swift:5527) — how a dead template surfaces on a side-loaded
                // build with no logcat attached. Production (and any tag with slot
                // children) renders exactly as before.
                if (node.children.isEmpty() && StackDiagnostics.flagsUnresolved(node.tag)) {
                    StackDiagnosticCard(node.tag)
                } else {
                    Children(node, store, env, item, rowWrite)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WrappedRow(
    modifier: Modifier,
    gap: Double,
    alignment: Alignment.Vertical,
    content: @Composable FlowRowScope.() -> Unit,
) {
    val horizontalArrangement =
        if (gap > 0) Arrangement.spacedBy(gap.dp) else Arrangement.Start
    val verticalArrangement =
        if (gap > 0) Arrangement.spacedBy(gap.dp) else Arrangement.Top
    FlowRow(
        modifier = modifier,
        horizontalArrangement = horizontalArrangement,
        verticalArrangement = verticalArrangement,
        itemVerticalAlignment = alignment,
        content = content,
    )
}

@Composable
private fun Children(node: StackNode, store: StackStore, env: JSERunner, item: Map<String, Any?>?, rowWrite: ((String, Any) -> Unit)?) {
    for (child in node.children) StackNodeView(child, store, env, item, rowWrite)
}

@Composable
private fun RowScope.FlexRowChildren(
    node: StackNode,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
) {
    val css = LocalCSSContext.current
    for (child in node.children) {
        if (child.tag == "spacer" &&
            child.attrs["height"] == null &&
            child.attrs["width"] == null
        ) {
            Spacer(Modifier.weight(1f))
            continue
        }
        val grow = resolvedAttrs(child, store, item, css)["grow"]?.let {
            JSE.interpolate(it, store, item)
        }
        StackNodeView(
            child, store, env, item, rowWrite,
            parentLayoutModifier =
                if (FlexChildPolicy.growsOnMainAxis(grow, horizontal = true)) {
                    Modifier.weight(1f)
                } else {
                    null
                },
        )
    }
}

@Composable
private fun ColumnScope.FlexColumnChildren(
    node: StackNode,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
) {
    val css = LocalCSSContext.current
    for (child in node.children) {
        if (child.tag == "spacer" &&
            child.attrs["height"] == null &&
            child.attrs["width"] == null
        ) {
            Spacer(Modifier.weight(1f))
            continue
        }
        val grow = resolvedAttrs(child, store, item, css)["grow"]?.let {
            JSE.interpolate(it, store, item)
        }
        StackNodeView(
            child, store, env, item, rowWrite,
            parentLayoutModifier =
                if (FlexChildPolicy.growsOnMainAxis(grow, horizontal = false)) {
                    Modifier.weight(1f)
                } else {
                    null
                },
        )
    }
}

// MARK: - data-bound collections — the Bound twin of PrivilegedStackComponentContext.bound()
// (Stack.swift ~851-907): keyed rows + a per-row `item` scope whose `item.*` edits write back
// into the bound array element (nested collections nest through the parent's rowWrite).

internal class Bound(   // internal: ListElements.kt (the registered list orchestrator) rides the same bound seam
    val rows: List<Map<String, Any?>>,
    val keys: List<String>,
    private val field: String,
    private val positional: Boolean,
    private val ownerSet: (List<Any?>) -> Unit,
) {
    /// Republish the WHOLE collection through the owner it was READ from — the twin of the
    /// privileged Swift context's `dsx.setBound(bind, rows)` (List.swift's reorder drop).
    /// Riding `ownerSet` keeps read and write symmetric: a nested `item.*` collection edits
    /// its parent row in place instead of minting a phantom surface var named "item.…".
    fun setAll(rows: List<Any?>) = ownerSet(rows)

    /// The row's data scope: the row dict + `index` (dsx.this.index / item.index).
    fun item(i: Int): Map<String, Any?> {
        val row = HashMap<String, Any?>(rows[i]); row["index"] = i.toDouble(); return row
    }
    /// The row's write-back: `item.f = v` rebuilds the array with that element's `f` set and
    /// republishes it onto the bind key. Keyed rows re-find their element by identity at
    /// write time (rows may have moved); positional/keyless rows write by index.
    fun writer(i: Int): (String, Any) -> Unit {
        if (positional || rows[i][field] == null) {
            val source = rows
            return { f, v ->
                val arr = source.mapTo(ArrayList<HashMap<String, Any?>>(source.size)) { HashMap(it) }
                if (i < arr.size) { arr[i][f] = v; ownerSet(arr) }
            }
        }
        val id = keys[i]
        val source = rows
        return { f, v ->
            val at = source.indexOfFirst { JSE.string(it[field] ?: "") == id }
            if (at >= 0) {
                val arr = source.mapTo(ArrayList<HashMap<String, Any?>>(source.size)) { HashMap(it) }
                arr[at][f] = v
                ownerSet(arr)
            }
        }
    }
}

/// Resolve `bind=` to its rows + owner write-back: `item.*` (a NESTED collection — a list
/// bound to a parent row's field) reads the row and writes back through the parent's
/// rowWrite; anything else evaluates path-aware and republishes via `writeBound`. Keys:
/// `key=` field (default `id`), `key="index"` = positional, and a row MISSING its key
/// field falls back to its position (never "").
internal fun bound(a: Map<String, String>, store: StackStore, item: Map<String, Any?>?,
                   rowWrite: ((String, Any) -> Unit)?): Bound {
    val bindKey = a["bind"] ?: ""
    val field = a["key"] ?: "id"
    val positional = field == "index"
    val key = JSE.normalizeScope(bindKey)
    val rows: List<Map<String, Any?>>
    val ownerSet: (List<Any?>) -> Unit
    if (key.startsWith("item.") && item != null) {
        val lk = key.substring(5)
        rows = JSE.asRows(item[lk])
        ownerSet = { new -> rowWrite?.invoke(lk, new) }
    } else {
        rows = JSE.asRows(JSE.eval(bindKey, store, item))
        ownerSet = { new -> store.writeBound(key, new) }
    }
    val keys = rows.mapIndexed { i, r ->
        if (positional) i.toString()
        else {
            val v = r[field]?.let { JSE.string(it) } ?: ""
            if (v.isEmpty()) i.toString() else v
        }
    }
    return Bound(rows, keys, field, positional, ownerSet)
}

/// `<list bind=… key=…>` — LazyColumn over the bound rows; the single child is the row
/// template, rendered once per row in its own `item` scope with write-back. `spacing=`
/// gaps rows; `align=` sets the row cross-axis alignment (leading default / center /
/// trailing — the flat-list `hAlign` twin); `scroll="false"` renders eagerly (no own
/// scroll — compose inside `<scroll>` / measured sheets), as does a list under a scrolling
/// ancestor (LazyScrollPolicy — a LazyColumn may not nest in a vertical scroll), while
/// otherwise-unstyled rows remain real Material 3 ListItems; `on:reachEnd` fires when the
/// last row appears (pagination).
@Composable
internal fun BoundList(node: StackNode, a: Map<String, String>, modifier: Modifier, store: StackStore,
                       env: JSERunner, item: Map<String, Any?>?, rowWrite: ((String, Any) -> Unit)?) {
    val m = modifier
    val template = node.children.firstOrNull() ?: return
    val b = bound(a, store, item, rowWrite)
    val spacing = a["spacing"]?.let { JSE.number(JSE.interpolate(it, store, item)) } ?: ElementDefaults.LIST_SPACING
    val arrange = if (spacing > 0) Arrangement.spacedBy(spacing.dp) else Arrangement.Top
    // `align` = the row cross-axis alignment (leading default / center / trailing) — the
    // List.swift:217-227 `hAlign(align)` twin, applied to the flat VStack/LazyVStack. It only
    // reaches these flat arms: `align` is NOT a system-safe word (the SystemList allowlist — the
    // List container owns row layout on both platforms, StackSystemControlsTest), so a list that
    // sets it has already ejected the M3 ListItem path below, exactly as iOS's `unstyled` gate
    // drops the system List when `align` is present.
    val align = hAlign(a["align"]?.let { JSE.interpolate(it, store, item) })
    val reachEnd = a["on:reachEnd"]
    if (LazyScrollPolicy.usesEagerRows(a["scroll"], LocalInScrollContainer.current)) {
        if (SystemList.rendersSystemRows(a, template.attrs)) {
            Column(m.then(Modifier.fillMaxWidth())) {
                for (i in b.rows.indices) {
                    SystemMaterialListItem {
                        StackNodeView(template, store, env, b.item(i), b.writer(i))
                    }
                }
            }
        } else {
            Column(m, verticalArrangement = arrange, horizontalAlignment = align) {
                for (i in b.rows.indices) {
                    StackNodeView(template, store, env, b.item(i), b.writer(i))
                }
            }
        }
        return
    }
    // ── THE SYSTEM DEFAULT (system-defaults.md; List.swift:79-183): a fully UNSTYLED
    //    vertical scrolling list — the gate is the
    //    List.swift allowlist copied to the word, over the element's POST-cascade attrs
    //    AND the row template's RAW root attrs (StackSystemControls.kt SystemList) —
    //    renders real M3 ListItem rows on this SAME keyed LazyColumn. A scrolling /
    //    hugging ancestor never reaches here: LazyScrollPolicy already took the eager arm
    //    above, which keeps the M3 rows without the lazy container. Any authored look on
    //    either half keeps the pre-law path byte-for-byte — designed lists untouched. ──
    if (SystemList.rendersSystem(a, template.attrs)) {
        SystemMaterialList(b, m, reachEnd, template, store, env)
        return
    }
    LazyColumn(m, verticalArrangement = arrange, horizontalAlignment = align) {
        items(count = b.rows.size, key = { b.keys[it] }) { i ->
            StackNodeView(template, store, env, b.item(i), b.writer(i))
            if (reachEnd != null && i == b.rows.size - 1) {
                LaunchedEffect(b.keys[i]) { env.run(reachEnd, b.item(i)) }
            }
        }
    }
}

/// `<grid bind=… columns=…>` — the same keyed per-row data model as `<list>`, flowing into
/// N flexible columns (default 3, StackReference). `scroll="false"` = eager chunked rows
/// (sizes to content); else LazyVerticalGrid. `spacing=` gaps both axes (default 10).
///
/// NO list-constructs — DECLARED PARITY, not a gap. The iOS `<grid>` twin (Grid.swift) is
/// deliberately construct-free (bind/key/columns/spacing/scroll/on:reachEnd ONLY), so `<grid>`
/// carries no `group_by` / `swipeLeading` / `swipeTrailing` / `reorder`: those are List-only on
/// every renderer, the `grid.json` fixture pins none, and matching the twin bug-for-bug means
/// there is nothing to implement — an Android-only construct would be renderer-only behavior
/// barred by the unified-codebase law (monorepo working rules). Swipe-to-dismiss has no honest grid analogue
/// anyway (cells share a row). Ratified in android-status.md (the `:render` row) + grid.json notes.
@Composable
private fun BoundGrid(node: StackNode, a: Map<String, String>, modifier: Modifier, store: StackStore,
                      env: JSERunner, item: Map<String, Any?>?, rowWrite: ((String, Any) -> Unit)?,
                      surfaceSnapshot: Map<String, Any?>, globalSnapshot: Map<String, Any?>) {
    // The container resolves rows AND its bound `columns=` internally, so without the live
    // snapshots Compose can skip this restart scope after a store publish — a reactive
    // column count (`columns="{{ dsx.screen.width > 900 ? 3 : 1 }}"`) would freeze at its
    // mount value. Thread both scopes exactly as Raw/Pager/Tabs do; values, not map size,
    // participate in the parameter equality check that decides skipping.
    surfaceSnapshot.size
    globalSnapshot.size
    val m = modifier
    val template = node.children.firstOrNull() ?: return
    val b = bound(a, store, item, rowWrite)
    val cols = maxOf(1, a["columns"]?.let { JSE.number(JSE.interpolate(it, store, item))?.toInt() } ?: ElementDefaults.GRID_COLUMNS)
    val gap = (a["spacing"]?.let { JSE.number(JSE.interpolate(it, store, item)) } ?: ElementDefaults.GRID_SPACING).dp
    val reachEnd = a["on:reachEnd"]
    if (LazyScrollPolicy.usesEagerRows(a["scroll"], LocalInScrollContainer.current)) {
        Column(m, verticalArrangement = Arrangement.spacedBy(gap)) {
            for (base in b.rows.indices step cols) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    for (j in 0 until cols) {
                        val i = base + j
                        Box(Modifier.weight(1f)) {
                            if (i < b.rows.size) StackNodeView(template, store, env, b.item(i), b.writer(i))
                        }
                    }
                }
            }
        }
        return
    }
    LazyVerticalGrid(columns = GridCells.Fixed(cols), modifier = m,
                     verticalArrangement = Arrangement.spacedBy(gap),
                     horizontalArrangement = Arrangement.spacedBy(gap)) {
        items(count = b.rows.size, key = { b.keys[it] }) { i ->
            StackNodeView(template, store, env, b.item(i), b.writer(i))
            if (reachEnd != null && i == b.rows.size - 1) {
                LaunchedEffect(b.keys[i]) { env.run(reachEnd, b.item(i)) }
            }
        }
    }
}

/// `<pager>` — swipeable full-bleed pages (foundation Pager; `axis="vertical"` = the
/// TikTok-style vertical pager). Static children are the pages. Two-way current page via
/// `bind=` (or the StackReference `value=`): a settled swipe writes it (+ fires `on:change`
/// through the setBound seam — never for the page the pager opened on); writing it jumps,
/// commits once, immediately. Page dots + data-bound rows: TODO (see header).
@Composable
private fun Pager(node: StackNode, a: Map<String, String>, modifier: Modifier, store: StackStore,
                  env: JSERunner, item: Map<String, Any?>?, rowWrite: ((String, Any) -> Unit)?,
                  surfaceSnapshot: Map<String, Any?>, globalSnapshot: Map<String, Any?>) {
    // These containers construct their BoundControl internally, so without the live
    // snapshots Compose can skip this restart scope after a programmatic bound write.
    // Thread both scopes exactly as Raw does; values, not map size, participate in the
    // parameter equality check that decides whether this function may be skipped.
    surfaceSnapshot.size
    globalSnapshot.size
    val m = modifier
    val pages = node.children
    if (pages.isEmpty()) return
    val ctl = BoundControl(node.tag, a, store, env, item, rowWrite)
    val bindKey = a["bind"] ?: a["value"]
    val boundIndex = (bindKey?.let { JSE.number(ctl.boundValue(it))?.toInt() } ?: 0)
        .coerceIn(0, pages.size - 1)
    val state = rememberPagerState(initialPage = boundIndex) { pages.size }
    var reported by remember { mutableIntStateOf(boundIndex) }   // the page last committed (opening page never fires)
    val settled = state.settledPage
    LaunchedEffect(settled) {
        if (settled == reported) return@LaunchedEffect
        reported = settled
        if (bindKey != null) ctl.setBound(bindKey, settled.toDouble())   // fires on:change via the seam
        else ctl.fireChangeGuarded()
    }
    if (bindKey != null) {
        LaunchedEffect(boundIndex) {
            if (boundIndex != state.currentPage) {                       // a programmatic jump commits once, immediately
                reported = boundIndex
                state.scrollToPage(boundIndex)
                ctl.fireChangeGuarded()
            }
        }
    }
    val axis = JSE.interpolate(a["axis"] ?: "", store, item)
    if (PagerLayoutPolicy.requiresViewportHeight(axis)) {
        // Foundation Pager's vertical contract is full-viewport pages (the Swift twin frames
        // every page to GeometryReader.size). A vertical pager may legitimately sit below a
        // DSX <scroll>; Compose then supplies an unbounded main-axis constraint and its native
        // VerticalPager rejects the measurement. Cap only that main axis at the live window
        // height. Appending the cap keeps authored fixed/min/max sizing outside it, so explicit
        // dimensions still win while an otherwise unbounded pager receives a finite viewport.
        val windowHeightPx = LocalWindowInfo.current.containerSize.height
        val viewportModifier = PagerLayoutPolicy.viewportHeightDp(
            windowHeightPx = windowHeightPx,
            density = LocalDensity.current.density,
        )?.let { Modifier.heightIn(max = it.dp) } ?: Modifier
        VerticalPager(state, m.then(viewportModifier)) { p ->
            StackNodeView(pages[p], store, env, item, rowWrite)
        }
    } else {
        HorizontalPager(state, m) { p -> StackNodeView(pages[p], store, env, item, rowWrite) }
    }
}

/**
 * Pure half of the native pager constraint bridge. Keeping the policy outside Compose lets the
 * renderer unit suite pin the exact vertical-only, positive-viewport behavior.
 */
internal object PagerLayoutPolicy {
    fun requiresViewportHeight(axis: String): Boolean = axis == "vertical"

    fun viewportHeightDp(windowHeightPx: Int, density: Float): Float? =
        if (windowHeightPx > 0 && density.isFinite() && density > 0f) {
            windowHeightPx / density
        } else {
            null
        }
}

/// `<tabs>` — the M3 ADAPTIVE navigation suite + indexed content switch (the desktop-class
/// wave: Tabs.swift's `.sidebarAdaptable` twin). NavigationSuiteScaffold delegates the
/// presentation to the platform's own WindowSizeClass — compact width renders the bottom
/// NavigationBar, medium/expanded the NavigationRail — exactly system-defaults.md ("the
/// unstyled baseline IS the platform"); web's `>= 69rem` sidebar rail is the same shape at
/// its own breakpoint (a pinned divergence: native delegates to the OS, web to a width).
/// Each child pane carries its side attrs `tabTitle` / `tabIcon` (sf-map ladder,
/// StackIcons.kt) / `tabBadge` — all presentation-independent, fed to bar and rail alike.
/// `value=` is the two-way selected index, exactly iOS (Tabs.swift:39) — `bind=` is
/// accepted as a documented Android-only ALIAS (the pre-convergence wave read it; value=
/// wins when both are set; the alias stays out of the ElementSpec — fixtures know value=
/// only). No key → local selection; `color=` tints the selection (default `accent`) via
/// the suite's item colors, the iOS `.tint` twin. Item typography/spacing are M3-owned
/// (iOS never styled its tabItems either); a title-less pane labels "Tab N", an icon-less
/// pane renders label-only.
@Composable
private fun Tabs(node: StackNode, a: Map<String, String>, modifier: Modifier, store: StackStore,
                 env: JSERunner, item: Map<String, Any?>?, rowWrite: ((String, Any) -> Unit)?,
                 surfaceSnapshot: Map<String, Any?>, globalSnapshot: Map<String, Any?>) {
    surfaceSnapshot.size
    globalSnapshot.size
    val m = modifier
    // Head/declaration children are never panes (LayoutSemantics.paneChildren, the
    // flex-semantics corpus): counting `<head>` made pane 0 an empty declaration and
    // collapsed the shell (W17 defect D6). Declarations still compose for lifecycle.
    val panes = LayoutSemantics.paneChildren(node.children)
    node.children.forEach { child ->
        if (child.tag in LayoutSemantics.declarationTags) StackNodeView(child, store, env, item, rowWrite)
    }
    if (panes.isEmpty()) return
    val ctl = BoundControl(node.tag, a, store, env, item, rowWrite)
    val bindKey = a["value"] ?: a["bind"]   // value= (Tabs.swift:39) · bind= = the pinned legacy alias
    var local by remember { mutableIntStateOf(0) }
    val index = (bindKey?.let { JSE.number(ctl.boundValue(it))?.toInt() } ?: local)
        .coerceIn(0, panes.size - 1)
    val tint = StackStyle.color(JSE.interpolate(a["color"] ?: ElementDefaults.TABS_TINT, store, item))
    // Selected icon/label carry the authored tint; every other role stays the M3 default
    // (system space — unselected color, indicator, container are the platform's own).
    val itemColors = NavigationSuiteDefaults.itemColors(
        navigationBarItemColors = NavigationBarItemDefaults.colors(
            selectedIconColor = tint, selectedTextColor = tint),
        navigationRailItemColors = NavigationRailItemDefaults.colors(
            selectedIconColor = tint, selectedTextColor = tint),
        navigationDrawerItemColors = NavigationDrawerItemDefaults.colors(
            selectedIconColor = tint, selectedTextColor = tint),
    )
    NavigationSuiteScaffold(
        navigationSuiteItems = {
            for ((i, pane) in panes.withIndex()) {
                val title = JSE.interpolate(pane.attrs["tabTitle"] ?: "Tab ${i + 1}", store, item)
                val icon = pane.attrs["tabIcon"]?.let { JSE.interpolate(it, store, item) }
                val badge = pane.attrs["tabBadge"]?.let { JSE.interpolate(it, store, item) } ?: ""
                item(
                    selected = i == index,
                    onClick = {
                        if (bindKey != null) ctl.setBound(bindKey, i.toDouble())   // fires on:change via the seam
                        else { local = i; ctl.fireChangeGuarded() }
                    },
                    icon = {
                        // The item owns its content color (selected = tint above); an
                        // icon-less pane renders label-only, like a title-only TabView.
                        if (!icon.isNullOrEmpty()) {
                            StackIcon(icon, ElementDefaults.TABS_ITEM_ICON_SIZE, LocalContentColor.current)
                        }
                    },
                    label = { Text(title) },
                    badge = if (badge.isEmpty()) null else ({ Badge { Text(badge) } }),
                    colors = itemColors,
                )
            }
        },
        modifier = m,
        // Transparent, so authored/inherited screen backgrounds keep painting the content
        // area exactly as the pre-suite strip did; the bar/rail draw their own system
        // containers on top.
        containerColor = Color.Transparent,
        contentColor = LocalContentColor.current,
    ) {
        StackNodeView(panes[index], store, env, item, rowWrite)
    }
}

/// `<watch value=… on:change=…/>` — renders nothing; re-evaluates `value` (in the watch's
/// own scope: a row-scoped watch observes its row) on every recomposition and fires
/// `on:change` through the runner's budgeted, render-safe WatchView.fire twin whenever
/// JSE.watchKey says the value MEANINGFULLY changed. `immediate="true"` also fires on mount.
@Composable
private fun WatchView(a: Map<String, String>, store: StackStore, env: JSERunner, item: Map<String, Any?>?) {
    val valueExpr = a["value"] ?: ""
    val v = JSE.eval(valueExpr, store, item)
    val key = JSE.watchKey(v)
    val last = remember { mutableStateOf<String?>(null) }
    SideEffect {
        val prev = last.value
        last.value = key
        val fire = if (prev == null) a["immediate"] == "true" else prev != key
        if (fire) env.fireWatch(v, a["on:change"] ?: "", valueExpr)
    }
}

private fun componentContext(node: StackNode, a: Map<String, String>, store: StackStore, env: JSERunner, item: Map<String, Any?>?, rowWrite: ((String, Any) -> Unit)?) =
    ComposeStackComponentContext(node, a, store, env, item,
        if (node.children.isEmpty()) null else SlotContent(node.children, env, item, rowWrite),
        node.text, rowWrite, node.tag)

/// Swift value-copies the JSERunner struct at every capture point; the Kotlin twin copies
/// explicitly (the class IS the shared-store identity — see JseRunner.kt header).
private fun copyEnv(env: JSERunner) = JSERunner(
    store = env.store, webView = env.webView, scope = env.scope,
    onHandlers = env.onHandlers, slot = env.slot, dsx = env.dsx,
    measuring = env.measuring, depth = env.depth,
)

/// Resolve a (possibly data-derived) tag to a component — XML template first, then a
/// native global, then the runtime registry — wiring attributes + on:<event> + slot
/// exactly like a literal tag. Returns false when the tag isn't shipped in THIS binary
/// (the capability boundary). Twin of Swift `StackNodeView.component(_:_:)`.
@Composable
private fun component(
    tag: String,
    node: StackNode,
    a: Map<String, String>,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
): Boolean {
    val resolved = ComposeStackComponents.resolve(tag, env.scope)
    if (resolved != null) {
        if (env.depth >= JSE.COMPONENT_DEPTH_CAP) return true  // corrupt-data floor, see the constant
        val (template, owningScope) = resolved
        val attributes = HashMap<String, Any?>()
        val overrides = HashMap<String, Any?>()
        val onHandlers = HashMap<String, OnHandler>()
        for ((k, v) in a) {
            if (k == "tag" || k == "id") continue             // selector / identity
            if (k.startsWith("from:")) continue               // emitter filter — paired below
            if (k.startsWith("on:")) {
                // Captured WITH the consumer's env — bubbling, not a self-loop.
                val ev = k.substring(3)
                onHandlers[ev] = OnHandler(JSE.interpolate(v, store, item), env,
                                           a["from:$ev"]?.let { OnHandler.parseFrom(it) })
                continue
            }
            // The style-override split (corpus Conformance/overrides): `override:<name>`
            // leaves the props plane and rides the item scope's __overrides dict — the same
            // per-recomposition delivery attributes get, so a bound override is live.
            val override = StyleOverrides.overrideAttrName(k)
            if (override != null) { overrides[override] = JSE.bindAttribute(v, store, item); continue }
            // A sole `{{ ... }}` hands the child the VALUE, so a component can be given
            // structure - the whole reason a component may render itself. Mixed templates
            // stay sentences. Corpus: Conformance/composition/attribute-binding.json.
            attributes[k] = JSE.bindAttribute(v, store, item)
        }
        // The VERB door (dsx.component.push/present/update { overrides } → the frame/modal
        // store's reactive dsx.override dict): fold it under the tag spellings at the
        // component boundary, so a pushed root delivers into the same item __overrides
        // vehicle a hard-coded consumer's tag does — and a live re-seed recomposes this
        // split via the store publish. Only verb-seeded surface stores carry the var, so
        // ordinary nested components merge nothing. Tag spellings win (the read chain's
        // item-beats-store law, corpus Conformance/overrides).
        (store.vars["dsx.override"] as? Map<*, *>)?.forEach { (k, v) ->
            val name = k as? String ?: return@forEach
            if (!overrides.containsKey(name)) overrides[name] = v
        }
        if (overrides.isNotEmpty()) attributes["__overrides"] = overrides
        // A component body recomposes whenever its Store publishes. Recreating the runner on
        // every publication changes the identity observed by lifecycle effects inside the
        // component (notably <api>), disposing and remounting them into an endless loading /
        // refetch loop. Keep one runner per invocation and refresh its mutable capture fields
        // below so actions and slots still see the latest consumer context.
        //
        // THE INSTANCE STORE (composition law; the web renderer is the reference): a
        // component instance OWNS its state. Its head declarations - variables, computed,
        // formulas, actions, <api> handles, attribute defaults, classes - register in a
        // store born with the instance, so two instances hold independent state and a
        // sibling's <api as=> cannot be swallowed by first-declaration-wins. Attributes
        // ride the item scope as before (live per recomposition), on:<event> handlers keep
        // the CONSUMER's env, slot content renders in the consumer's scope AND store
        // (SlotContent captures env, whose store is the caller's), and cross-surface state
        // stays global.* / route.*.
        val instanceStore = remember(env, node, owningScope) { StackStore() }
        val childEnv = remember(env, node, owningScope) {
            JSERunner(store = instanceStore, webView = env.webView, scope = env.scope,
                      onHandlers = env.onHandlers, slot = env.slot, dsx = env.dsx,
                      measuring = env.measuring, depth = env.depth)
        }
        childEnv.depth = env.depth + 1
        childEnv.scope = owningScope ?: env.scope             // packaged component runs under ITS scheme
        childEnv.onHandlers = HashMap(env.onHandlers).apply { putAll(onHandlers) }   // inherit; own wins
        childEnv.slot = if (node.children.isEmpty()) null else SlotContent(node.children, env, item, rowWrite)
        StackNodeView(template, instanceStore, childEnv, attributes)
        return true
    }
    if (env.depth < JSE.COMPONENT_DEPTH_CAP) {
        val build = ComposeStackComponents.nativeGlobal(tag)
        if (build != null) {
            val onHandlers = HashMap<String, OnHandler>()
            for ((k, v) in a) {
                if (!k.startsWith("on:")) continue
                val ev = k.substring(3)
                onHandlers[ev] = OnHandler(JSE.interpolate(v, store, item), env,
                                           a["from:$ev"]?.let { OnHandler.parseFrom(it) })
            }
            // Native globals can own lifecycle effects too; give the invocation the same
            // stable-runner contract as XML component bodies.
            val childEnv = remember(env, node, tag) { copyEnv(env) }
            childEnv.depth = env.depth + 1
            childEnv.onHandlers = HashMap(env.onHandlers).apply { putAll(onHandlers) }
            val slot = if (node.children.isEmpty()) null else SlotContent(node.children, env, item, rowWrite)
            build(ComposeStackComponentContext(node, a, store, childEnv, item, slot, node.text, rowWrite, tag))
            return true
        }
    }
    val plain = ComposeStackComponents.registry[tag]
    if (plain != null) { plain(a); return true }
    return false
}
