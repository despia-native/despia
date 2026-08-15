//
//  StackElements.kt — the STRUCTURE/OVERLAY element wave for the Compose renderer: the
//  registration aggregator + the small shared helpers every element file in this folder
//  stands on. Kotlin twins of the iOS Foundation Structure/Core/Forms components
//  (ClosedSource/DSX/Modules/Mandatory/Foundation/Components/**) — geometry/behavior are
//  extracted 1:1 from the Swift sources; each element file pins its own numbers.
//
//  REGISTRATION — `StackElements.register()` (idempotent) registers every element into
//  ComposeStackComponents (natives after XML, exactly like the iOS launch class-walk;
//  scaffold/carousel are PRIVILEGED like their iOS PrivilegedStackComponent twins).
//  Call sites today: RenderSmokeOverlays (the compile gate) + RouterModalHost. The
//  production boot hookup (GeneratedModules.register / a Foundation android facet) is a
//  ONE-LINE follow-up — deliberately not wired here (hosts are bootloaders; the generated
//  registry is owned by prepare_modules_android.rb).
//
//  ── DEVIATIONS shared by every element here (pinned, none silent) ────────────────────
//  • Registered components BYPASS StackNodeView's style-chain modifier (the dispatch
//    hands privileged/native builders the context, not the composed Modifier — the
//    registry contract). iOS applies StackStyle around every component, so each INLINE
//    element here re-applies `StackStyle.apply(attrs)` at its own root
//    (`Modifier.elementStyle(el)`);
//    overlay elements (zero-size anchors) don't need it.
//  • `dsx.event(name)` twin (`raiseEvent`): runs the consumer's captured `on:<name>`
//    handler in its DECLARING env + publishes onto the native bus (JSERunner.publishNative)
//    — the two reachable branches of :core's private emitEventUp. The `ui.on` host-handler
//    and `<action on:x>` callback sidecars are :core-INTERNAL (JSERunnerStoreFields) and
//    not reachable from :render — those two branches are deferred to a :core seam.
//  • `dsx.dispatch(call, args)` twin (`dispatchCall`): the ModuleRegistry seam
//    (JSERunner.moduleHandle) + normalizeCall — an unregistered scheme is a silent no-op,
//    exactly like iOS's `dsx.dispatch` outside a `try`.
//  • Overlays present through a focusable edge-to-edge Dialog (`FullScreenLayer`) — the
//    Compose stand-in for a UIKit presentation. The Android BACK key routes to the
//    layer's dismiss (the platform back contract; iOS has no back key).
//

package despia.engine.render.elements

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.StackNode
import despia.engine.render.BoundControl
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.StackNodeView
import despia.engine.render.StackStyle

// MARK: - registration

object StackElements {
    @Volatile private var registered = false

    /// Register every element of this wave. Idempotent (the registry's define* replace).
    fun register() {
        if (registered) return
        synchronized(this) {
            if (registered) return
            registerSheetElements()
            registerDialogElements()
            registerMenuElements()
            registerLightboxElement()
            registerContainerElements()
            registerFormElements()
            registerDisplayElements()
            registerSettingsRowElement()
            registerSystemFabElement()
            registered = true
        }
    }
}

// MARK: - the element-side attr reader (twin of StackComponentContext's typed readers)

/// One element's context face: interpolated attr reads (`dsx.string/double/bool`), color
/// tokens, bound lists (`dsx.list`), the bind seam (BoundControl) and `on:<event>` dispatch.
internal class El(val ctx: ComposeStackComponentContext) {
    val ctl = BoundControl(ctx.componentTag, ctx.attrs, ctx.store, ctx.env, ctx.item, ctx.rowWrite)

    fun str(k: String, d: String = ""): String = ctl.interp(k) ?: d
    fun dbl(k: String, d: Double): Double = ctl.num(k) ?: d
    fun bool(k: String, d: Boolean = false): Boolean = (ctl.interp(k) ?: return d) == "true"
    fun has(k: String): Boolean = ctx.attrs.containsKey(k)
    fun color(k: String, d: String): Color = StackStyle.color(str(k, d))

    /// `dsx.list(key)` — the attr value is a bound-rows expression (`dsx.variable.menu`).
    fun list(k: String): List<Map<String, Any?>> =
        JSE.asRows(JSE.eval(ctx.attrs[k] ?: "", ctx.store, ctx.item))

    /// `dsx.run(event)` — run this element's `on:<event>` attr (arg:* payload, gate keys).
    fun run(event: String) = ctl.fire(event)

    /// A two-way Bool `present` key: read (path-aware, row-aware) …
    fun presented(key: String): Boolean = key.isNotEmpty() && JSE.truthy(ctl.boundValue(key))

    /// … and write false on an interactive close (swipe / tap-away / ✕ / back).
    fun dismissBound() { ctx.attrs["present"]?.let { if (it.isNotEmpty()) ctl.setBound(it, false) } }
}

/// The universal style chain, re-applied at the element root (see header DEVIATIONS).
internal fun Modifier.elementStyle(el: El): Modifier =
    then(StackStyle.apply(el.ctx.attrs, el.ctx.store, el.ctx.item, el.ctx.componentTag))

// MARK: - dsx.event / dsx.dispatch twins (see header DEVIATIONS)

/// Raise a component event UP to the consumer's `on:<name>` (its declaring env) + the
/// native bus. Twin of `dsx.event(name, payload)` for a native component.
internal fun raiseEvent(ctx: ComposeStackComponentContext, name: String, payload: Map<String, Any?> = emptyMap()) {
    val stamped = JSERunner.stampFrom(payload, "component", ctx.componentTag)
    val e = ctx.env.onHandlers[name]
    if (e != null && e.accepts(stamped)) {
        val merged = HashMap<String, Any?>(ctx.item ?: emptyMap())
        merged.putAll(stamped)
        e.env.run(e.action, merged, stamped)
    }
    JSERunner.publishNative(name, stamped)
}

/// Fire a point-to-point bus call from a menu/alert item dict — twin of `dsx.dispatch`.
/// Accepts the dot-API form (`studio.deleteClip`); an unshipped scheme is a silent no-op.
internal fun dispatchCall(call: String, args: Map<String, Any?>) {
    if (call.isEmpty()) return
    JSERunner.moduleHandle(JSERunner.normalizeCall(call), args) { }
}

// MARK: - slots (default = un-named children; `slot="name"` = named — the iOS slot contract)

internal fun defaultSlot(ctx: ComposeStackComponentContext): List<StackNode> =
    ctx.slot?.children?.filter { it.attrs["slot"] == null } ?: emptyList()

internal fun namedSlot(ctx: ComposeStackComponentContext, name: String): List<StackNode> =
    ctx.slot?.children?.filter { it.attrs["slot"] == name } ?: emptyList()

/// Render slot nodes in the CONSUMER's scope (slot.env / slot.item), like iOS `dsx.slot()`.
@Composable
internal fun SlotNodes(ctx: ComposeStackComponentContext, nodes: List<StackNode>) {
    val slot = ctx.slot ?: return
    for (n in nodes) StackNodeView(n, ctx.store, slot.env, slot.item, slot.rowWrite)
}

/// Slot nodes inside an element-owned Column — flexible `<spacer/>`s take the stack's
/// weight scope (the StackNodeView vstack rule, replicated for element-owned stacks).
@Composable
internal fun ColumnScope.SlotColumnNodes(ctx: ComposeStackComponentContext, nodes: List<StackNode>) {
    val slot = ctx.slot ?: return
    for (n in nodes) {
        if (n.tag == "spacer" && n.attrs["height"] == null && n.attrs["width"] == null) Spacer(Modifier.weight(1f))
        else StackNodeView(n, ctx.store, slot.env, slot.item, slot.rowWrite)
    }
}

/// The Row twin (toolbars compose `<spacer/>` between button groups).
@Composable
internal fun RowScope.SlotRowNodes(ctx: ComposeStackComponentContext, nodes: List<StackNode>) {
    val slot = ctx.slot ?: return
    for (n in nodes) {
        if (n.tag == "spacer" && n.attrs["height"] == null && n.attrs["width"] == null) Spacer(Modifier.weight(1f))
        else StackNodeView(n, ctx.store, slot.env, slot.item, slot.rowWrite)
    }
}

// MARK: - the presented-modal plumbing shared by sheet/alert/confirmDialog/lightbox/popover

/// Fire `on:dismiss` exactly once whenever `present` transitions true→false (interactive
/// closes write the binding false first, so BOTH paths funnel here — the SwiftUI
/// `.sheet(isPresented:onDismiss:)` contract). Runs the author's action on the next tick
/// (JSE.afterRender — the render-safe invariant).
@Composable
internal fun FireOnDismiss(present: Boolean, el: El) {
    val was = remember { mutableStateOf(present) }
    SideEffect {
        if (was.value && !present) JSE.afterRender { el.run("dismiss") }
        was.value = present
    }
}

/// A full-window layer for presented content (scrim + sheet/alert/viewer). Focusable so
/// the BACK key routes to `onDismissRequest` (the Android back contract — see header).
@Composable
internal fun FullScreenLayer(onDismissRequest: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    Dialog(
        onDismissRequest = onDismissRequest,
        properties = DialogProperties(
            dismissOnBackPress = true,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        // A Popup inherits its safe-area-constrained anchor window on API 24 and leaves an
        // uncovered band above navigation chrome. The edge-to-edge Dialog owns a real
        // full-window surface while keeping platform back dismissal and focus trapping.
        Box(Modifier.fillMaxSize()) { content() }
    }
}
