//
//  RouterModals.kt — the modal half of RouterHost: render `global.nav.modal` (the Router's
//  state-backed presentation stack — Router.kt presentModal/dismissModal, contract pinned
//  in RouterTest) so `dsx.component.present` / `dsx.stack.present` put real UI on screen.
//
//  The host mounts `RouterModalHost()` ONCE, above its frame renderer (:render's RouterHost —
//  RouterHost.kt) — a one-line hookup, deliberately not applied to the host here (hosts
//  are bootloaders; the sibling shell owns its own file). Until it's mounted, presented
//  modals stay state-only (exactly today's behavior).
//
//  Per entry (`{ id, as, component, vars?, detents? }`):
//    • as: "sheet"  → the detented drawer (the shared SheetScaffold — Sheet.swift geometry;
//      detents accept BOTH spellings: half/medium, full/large, content).
//    • as: "cover"  → full-screen, theme `background` fill (the shared CoverScaffold).
//    • as: "overlay"→ the passthrough LAYER over the current screen — rendered inline
//      (no window, no scrim): Compose only hit-tests drawn content, so empty regions pass
//      touches through by construction (the PassthroughView twin). A `touch: "block"`
//      overlay also consumes system Back: it is the lock-screen/permanent-gate shape, so
//      keyboard and gesture navigation cannot escape around its full-area input barrier.
//  An interactive close (swipe below the smallest detent / scrim tap / BACK) reports
//  `Router.hostDismissedModal(id)` — identity-keyed, so the Router stays the single
//  source of truth and `on:dismiss`/releases run through `StackSurface.releaseModal`.
//
//  The surface handle is the parsed component root (`Router.surfaceFactory` default — a
//  StackNode); each modal gets its OWN StackStore/JSERunner keyed by frame id (the
//  frame-scoped state contract), seeded with the entry's `vars` under the "vars" key
//  (StackSurface.presentModal: `store.set("vars", vars)`).
//
//  DISMISS TRANSITION (Stack.swift 1:1 — closes the former pinned deviation): iOS holds a
//  released surface 0.6s past the dismiss transition so the modal renders on the way out
//  (Stack.swift releaseModal). The same shape here, in two halves:
//    • the RELEASE HOLD — this host wires :core's `StackSurface.deferRemoval` seam to a
//      0.6s main-thread post at mount (a bare kernel keeps the immediate default), so the
//      held surface stays renderable while the exit plays;
//    • the EXIT HOLD — a chain entry (sheet/cover) that leaves `global.nav.modal` keeps
//      composing (`exiting`, open=false) while SheetScaffold/CoverScaffold play the iOS
//      dismiss curve (0.28s easeIn — SheetMotion), then drops on `onExited`. The unified
//      render loop keys by id, so the SAME composition group (its live Animatables) plays
//      the exit. Overlays are never held — iOS overlays are pure state, no exit transition.
//

package despia.engine.render.elements

import android.os.Handler
import android.os.Looper
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import despia.engine.DSX
import despia.engine.JSERunner
import despia.engine.Router
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.StackSurface
import despia.engine.render.StackRootView
import despia.engine.render.StackStyle
import despia.engine.set
import despia.engine.setPath
import despia.engine.sink

/// iOS keeps a released surface renderable 0.6s past the dismiss/pop transition
/// (Stack.swift releasePushed/releaseModal `asyncAfter(.now() + 0.6)`).
private const val SURFACE_RELEASE_HOLD_MS = 600L

/// Wire :core's `StackSurface.deferRemoval` seam to the 0.6s main-thread post — :render owns
/// transitions, so a released pushed/modal surface stays renderable while its exit plays. ONE
/// wiring shared by both kernel-host halves that animate exits (RouterModalHost here, the frame
/// RouterHost for pop transitions); idempotent — the assignment is the same closure shape.
internal fun wireSurfaceReleaseHold() {
    val main = Handler(Looper.getMainLooper())
    StackSurface.deferRemoval = { removal -> main.postDelayed(removal, SURFACE_RELEASE_HOLD_MS) }
}

/// Back is blocked only by the same normalized ledger shape that blocks pointer input.
/// Kept pure so malformed/restored modal state and mixed presentation stacks stay testable.
internal object RouterModalBackPolicy {
    fun blocks(entries: List<Map<*, *>>): Boolean = entries.any {
        (it["as"] as? String) == "overlay" && (it["touch"] as? String) == "block"
    }
}

/// Render the presented-modal stack. Mount once above the frame renderer.
@Composable
fun RouterModalHost() {
    StackElements.register()                                        // the elements ride the same wave
    // :render owns transitions → reinstate the iOS release hold on :core's seam (the
    // default stays immediate for a bare kernel). Wired once, at host mount.
    remember { wireSurfaceReleaseHold(); true }
    var vars by remember { mutableStateOf<Map<String, Any?>>(DSX.state.vars.toMap()) }
    DisposableEffect(Unit) {
        val c = DSX.state.sink { vars = it }
        onDispose { c.cancel() }
    }
    val modal = ((vars["nav"] as? Map<*, *>)?.get("modal") as? List<*>)
        ?.filterIsInstance<Map<*, *>>() ?: emptyList()
    // The ledger, not a successfully built child surface, owns the lock. That keeps Back
    // blocked for the entire lifetime of any full input-blocking overlay, including the
    // frame before its component mounts.
    val blocksBack = RouterModalBackPolicy.blocks(modal)
    BackHandler(enabled = blocksBack) { }

    // EXIT HOLD (see header): adopt departed chain entries BEFORE this pass renders, so
    // the same key(id) group keeps composing and its live Animatables play the exit.
    // Guarded writes → the composition converges; ids are monotonic (never resurrected).
    val liveIds = modal.mapNotNull { it["id"] as? Int }.toHashSet()
    val exiting = remember { mutableStateMapOf<Int, Map<*, *>>() }
    val prev = remember { HashMap<Int, Map<*, *>>() }
    for ((id, e) in prev) {
        if (id !in liveIds && id !in exiting && (e["as"] as? String) != "overlay") exiting[id] = e
    }
    prev.clear()
    for (e in modal) (e["id"] as? Int)?.let { prev[it] = e }

    // Live entries first, then exiting ones in presentation order (dismissals remove tops/
    // descendants, so the held entries sat ABOVE the survivors — z-order is preserved).
    val rendered = modal.map { it to true } +
        exiting.entries.sortedBy { it.key }.map { it.value to false }
    for ((entry, open) in rendered) {
        key(entry["id"]) {
            RouterModalEntry(entry, open = open,
                             onExited = { (entry["id"] as? Int)?.let { exiting.remove(it) } })
        }
    }
}

@Composable
private fun RouterModalEntry(entry: Map<*, *>, open: Boolean, onExited: () -> Unit) {
    val id = entry["id"] as? Int ?: return
    val root = StackSurface.modalFrames[id] as? StackNode             // opaque handle → the parsed root
    if (root == null) {
        // The release hold expired (or was never wired) before the exit finished — drop the hold.
        if (!open) LaunchedEffect(id) { onExited() }
        return
    }
    @Suppress("UNCHECKED_CAST")
    val attrs = entry["attrs"] as? Map<String, Any?>
    @Suppress("UNCHECKED_CAST")
    val overrides = entry["overrides"] as? Map<String, Any?>
    val store = remember {
        StackStore().also { s ->
            s.frameId = id   // frame-scoped package calls: a modal's chrome claim carries ITS id (never in nav.stack) → dropped, not the app bar's
            @Suppress("UNCHECKED_CAST")
            (entry["vars"] as? Map<String, Any?>)?.let { if (it.isNotEmpty()) s.setPath("vars", it) }   // LEGACY seed
            // THE input contract: attrs seed the reactive `dsx.attribute` dict — the exact store
            // Jse.kt consults first for `dsx.attribute.x` (runtime values win over defaults),
            // identical to a hard-coding consumer's props.
            attrs?.let { if (it.isNotEmpty()) s.set("dsx.attribute", it) }
            // the STYLE contract's verb door: overrides seed the reactive `dsx.override` dict
            // (typed reads resolve through the head's <override> declarations — Conformance/overrides)
            overrides?.let { if (it.isNotEmpty()) s.set("dsx.override", it) }
        }
    }
    // LIVE updates (route.updateComponent): the entry's published attrs changed → re-seed the
    // reactive dict; bindings recalc via the store publish. (`<attribute on:change>` handlers
    // stay the documented :render deferral — the existing pin.)
    LaunchedEffect(attrs) { attrs?.let { store.set("dsx.attribute", it) } }
    LaunchedEffect(overrides) { overrides?.let { store.set("dsx.override", it) } }
    val env = remember { JSERunner(store) }
    fun dismiss() { Router.shared?.hostDismissedModal(id) }           // identity-keyed — idempotent

    when (entry["as"] as? String) {
        "cover" -> CoverScaffold(onDismissRequest = { dismiss() }, open = open, onExited = onExited) {
            Box(Modifier.fillMaxSize().background(StackStyle.color("background"))) {
                StackRootView(root, store, env)
            }
        }
        "overlay" -> {
            val blocksInput = (entry["touch"] as? String) == "block"
            Box(Modifier.fillMaxSize()) {
                // touch: "block" (the FULL overlay — lock screen, blocking HUD): a full-size
                // pointer-input catcher UNDER the surface consumes every touch the surface's own
                // content doesn't, so nothing reaches the screen beneath. "passthrough" (default —
                // the menu-bar-over-web shape): no catcher; Compose only hit-tests DRAWN content,
                // so empty regions stay live by construction (present.json pins the normalization).
                if (blocksInput) {
                    Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { } })
                }
                StackRootView(root, store, env)
            }
        }
        else -> {                                                     // "sheet" (the default mode)
            val tokens = ((entry["detents"] as? List<*>) ?: emptyList<Any?>())
                .mapNotNull { (it as? String)?.let(::modalDetentToken) }
                .ifEmpty { listOf("half", "full") }
            SheetScaffold(tokens = tokens, card = false, inset = 0.dp,
                          bg = StackStyle.color("background"),
                          onInteractiveDismiss = { dismiss() },
                          open = open, onExited = onExited) {
                StackRootView(root, store, env, fillHeight = false)   // sheets hug — height stays measurable
            }
        }
    }
}
