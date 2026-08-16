//
//  RouterHost.kt — the FRAME half of the kernel host: render `global.nav.stack` (the Router's
//  observable back-stack — Router.kt push/pop/truncate, contract pinned in RouterTest) as a
//  Compose screen stack WITH the screen-presentation motion. Kotlin twin of RouterHost.swift's
//  NavigationStack half (ScreenFrame / FrameSurface / pathBinding / BootDiagnostic), which gets
//  push/pop transitions and the interactive back-swipe from the OS; here the same three behaviors
//  are drawn by hand, because Compose ships no navigation container in this dependency set:
//
//    • PUSH — the incoming screen slides in from the TRAILING edge over the covered one; the
//      covered screen recedes to a −20% parallax rest under a dim that peaks at 0.1 (the
//      repo-pinned iOS-family figures — router-motion-and-chrome-items.md Part A / web
//      motion.ts IOS_PARALLAX · IOS_DIM_PEAK). POP is the exact reverse.
//    • CURVES — derived from the DECLARED StackMotion vocabulary, never invented figures:
//      the SwiftUI default curve+duration (`StackMotion.animation(null, null)` → easeInOut
//      0.35 s — the same default Stack.swift's `StackStyle.animation` pins). iOS itself rides
//      the SYSTEM NavigationStack transition, which declares no public curve; this is the
//      closest declared token, pinned as such (see DEVIATIONS).
//    • PREDICTIVE BACK — the Android 14+ contract via `OnBackPressedCallback`: while the
//      system back gesture is in flight the PREVIOUS screen renders beneath the outgoing one
//      (the peek), gesture progress drives the pop pose directly, cancel animates back to
//      rest, and commit adopts the destination immediately because Android has already run
//      the gesture's platform-owned completion phase before `handleOnBackPressed`. Replaying
//      another DSX settle after that callback double-animates Back and leaves input blocked.
//      The Router is then popped with the visual already played (the web swipe-back precedent:
//      the state change must not replay the animation). On
//      pre-predictive API levels (24–33) — or without gesture events — the same handler
//      receives only the commit, so BACK commits immediately and the published stack diff
//      plays the ordinary pop transition. This keeps the callback free for a second rapid
//      Back instead of holding it through a synthetic 0.35 s gesture finish. System BACK
//      ownership moved HERE from RouterChromeHost (the gesture must drive frame visuals, which the
//      chrome bar cannot); the bar's back affordance still calls the same one verb,
//      `Router.pop()`. A `touch:"block"` overlay still consumes BACK first (RouterModalHost
//      registers later, so its enabled handler wins — unchanged ordering).
//
//  NAVIGATION IS STATE, unchanged: this host mutates NOTHING but its own render bookkeeping —
//  every push originates in the Router, and the only verbs called here are `Router.pop()`
//  (commit) and `Router.retryRootPlan()` (the diagnostic), exactly the set the previous
//  minimal host called. The stack diff → transition classification is pure
//  (`RouterStackDiff`, JVM-tested in RouterHostTest) and the published state stays the single
//  source of truth.
//
//  PER-FRAME STATE — the Swift `FrameSurface` contract, now true on Android: each frame id
//  gets ONE retained store+env (`RouterFrameSurface`), alive exactly while the id is in
//  `nav.stack` (+ the exit hold), so a COVERED screen keeps its local state and frees only
//  when permanently popped. `ScreenReadiness.release` moved with it: covering a screen no
//  longer releases its record (the phantom `screen.loading`-on-every-pop iOS deliberately
//  avoids — RouterHost.swift FrameSurface.deinit); the resurface re-`mount` is idempotent by
//  the corpus (readiness.json rule 2). Composition is LAZY like the NavigationStack's view
//  hierarchy: only the top (and, mid-transition/gesture, the one beneath) composes;
//  on:appear/on:disappear refire on cover/resurface exactly as SwiftUI refires them.
//
//  ── DEVIATIONS from the Swift twin (each pinned, none silent) ────────────────────────────
//  • Motion figures: iOS = the system NavigationStack transition (private curve); here the
//    declared StackMotion default (easeInOut 0.35 s) + the pinned iOS-family under-screen
//    figures (−20% / 0.1). Close, not byte-identical — there is nothing declared to copy.
//  • replace / reset / root-heal / any non-prefix stack change swaps INSTANTLY (the web
//    silence-rule shape); iOS rides whatever NavigationStack does for a swapped path element.
//    Boot mounts are always silent (the first adopted stack never animates).
//  • Gesture activation is the SYSTEM back gesture (both edges, OS-owned arming, API 34+ with
//    the manifest's enableOnBackInvokedCallback); iOS arms its own 30-ish-pt LEADING-edge pan
//    and refuses to arm mid-transition. Here a BACK during a live transition simply commits a
//    plain pop (no second peek), and there is no `DSXNavGestures.suppressInteractivePop` twin —
//    a full-screen game surface cannot suppress the system gesture (OS-owned).
//  • A transition replaced mid-flight (e.g. pop-pop faster than 0.35 s) drops the first exit
//    instantly and plays the new one; UIKit's nav controller queues them.
//  • ONE app WebView exists (Dom). When BOTH layers of a transition are web-surface frames the
//    view composes only in the layer that should own it (incoming top on push, destination
//    under on pop) — the other renders the theme backdrop for the duration. Same singleton
//    reality as iOS; surfaced here because two layers compose at once.
//  • The chrome bar (RouterChromeHost) sits ABOVE the frame stack and swaps to the new top's
//    claim at transition START; iOS's real navigation bar animates with the push. The Router's
//    `deferChromePrune` grace stays at its inline default — this bar derives from the LIVE top
//    frame only, so the grace map has no reader here (RouterTest pins the inline default).
//  • Reduce-motion (animator duration scale 0 — the prefers-reduced-motion signal) disables
//    transitions AND the peek: BACK commits an instant pop (the web kill-rule twin).
//

package despia.engine.render

import android.os.SystemClock
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.AppEnvironment
import despia.engine.DSX
import despia.engine.JSERunner
import despia.engine.Router
import despia.engine.ScreenReadiness
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.StackSurface
import despia.engine.getPath
import despia.engine.render.elements.blockHits
import despia.engine.render.elements.wireSurfaceReleaseHold
import despia.engine.set
import despia.engine.setPath
import despia.engine.sink
import kotlinx.coroutines.Job
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

// MARK: - RouterMotion — the screen-presentation motion policy (pure, JVM-tested)

/// The push/pop pose math on ONE parameter — `coverage` ∈ [0, 1]: how far the TOP screen covers
/// the one beneath (1 = at rest on screen, 0 = fully off the trailing edge). A push animates
/// 0 → 1 (top = the incoming screen), a pop 1 → 0 (top = the outgoing screen), and the
/// predictive-back gesture drives it directly (`gestureCoverage`). Every figure is a DECLARED
/// token: the spec is StackMotion's default (the SwiftUI easeInOut 0.35 s Stack.swift pins),
/// the parallax/dim are the repo-pinned iOS-family constants (web motion.ts IOS_PARALLAX −20% /
/// IOS_DIM_PEAK 0.1 — router-motion-and-chrome-items.md Part A).
internal object RouterMotion {
    /// The nav-transition spec — `StackMotion.animation(null, null)`: the declared default
    /// (easeInOut, 0.35 s). Derived, never invented (see the file header).
    val NAV: MotionSpec = StackMotion.animation(null, null)

    /// The covered screen's rest offset, as a fraction of width (the iOS-family −20%).
    const val PARALLAX = 0.2f

    /// The covered screen's dim overlay at full cover (the iOS-family 0.1 peak).
    const val DIM_PEAK = 0.1f

    /// The TOP screen's X offset (unsigned — the host applies the trailing sign for RTL).
    fun topX(width: Float, coverage: Float): Float = width * (1f - coverage.coerceIn(0f, 1f))

    /// The UNDER screen's X offset: rests at −PARALLAX·width when fully covered, 0 when revealed.
    fun underX(width: Float, coverage: Float): Float = -PARALLAX * width * coverage.coerceIn(0f, 1f)

    /// The UNDER screen's dim alpha for a coverage value.
    fun underDim(coverage: Float): Float = DIM_PEAK * coverage.coerceIn(0f, 1f)

    /// Map the system back-gesture progress (0 at start → 1 at full swipe) onto pop coverage.
    fun gestureCoverage(progress: Float): Float = 1f - progress.coerceIn(0f, 1f)

    /**
     * Preserve the declared navigation curve while scaling its duration to the
     * distance left after an interactive gesture. Replaying the full 350 ms
     * duration for a nearly completed swipe stacked DSX motion after Android's
     * predictive-back gesture and could miss the 800 ms interaction deadline.
     */
    fun settleSpec(fromCoverage: Float, toCoverage: Float): MotionSpec {
        val distance = abs(
            fromCoverage.coerceIn(0f, 1f) - toCoverage.coerceIn(0f, 1f),
        )
        return when (val nav = NAV) {
            is MotionSpec.Curve -> nav.copy(
                durationMs = (nav.durationMs * distance).roundToInt(),
            )
            is MotionSpec.Spring -> nav
        }
    }
}

// MARK: - RouterStackDiff — classify a published stack change (pure, JVM-tested)

/// The id-sequence diff that picks the transition for a `nav.stack` publish. PUSH/POP require the
/// common prefix to MATCH (a multi-push / multi-pop is still ONE transition — the popTo contract:
/// "one state mutation, one host transition"); anything else — boot seed, replace, reset, a root
/// heal — is SWAP: adopt instantly, no motion (the silence rule).
internal object RouterStackDiff {
    enum class Kind { NONE, PUSH, POP, SWAP }

    fun classify(old: List<Int>, new: List<Int>): Kind = when {
        old == new -> Kind.NONE
        old.isEmpty() || new.isEmpty() -> Kind.SWAP
        new.size > old.size && new.subList(0, old.size) == old -> Kind.PUSH
        new.size < old.size && old.subList(0, new.size) == new -> Kind.POP
        else -> Kind.SWAP
    }

    /// A frame id from a published/wire value — Int stays Int, a JSON round-trip's Double
    /// coerces (NavFrame.intId / Router.frameIdOf, 1:1). null for anything else.
    fun frameId(v: Any?): Int? = when (v) {
        is Int -> v
        is Double -> v.toInt()
        else -> null
    }
}

/// One callback owns both predictive progress and ordinary system/key Back. A regular press
/// commits synchronously; routing it through a coroutine/Flow kept Activity Compose's callback
/// occupied long enough for a second 75 ms Back to queue behind a full transition on tablets.
internal object RouterBackDispatch {
    // Same ceiling as the qualification interaction contract: a second committed Back
    // arriving inside this window must not enqueue motion that pushes it past the ceiling.
    const val RAPID_POP_WINDOW_MS = 800L

    fun canPop(stackDepth: Int): Boolean = stackDepth > 1

    /// Repeated Back while a pop is already settling interrupts that visual transition.
    /// Serializing another full NAV curve makes two 75 ms presses take platform-back time
    /// plus 700 ms of DSX motion; native navigation instead adopts the newer destination.
    fun coalescesRapidPop(inFlightIsPop: Boolean, stackDepth: Int): Boolean =
        inFlightIsPop && canPop(stackDepth)

    fun followsRecentPop(lastCommitAtMs: Long, nowMs: Long): Boolean =
        lastCommitAtMs >= 0L &&
            nowMs >= lastCommitAtMs &&
            nowMs - lastCommitAtMs <= RAPID_POP_WINDOW_MS
}

private class RouterOnBackPressedCallback(
    enabled: Boolean,
) : OnBackPressedCallback(enabled) {
    var onStarted: (BackEventCompat) -> Unit = {}
    var onProgressed: (BackEventCompat) -> Unit = {}
    var onCompleted: () -> Boolean = { false }
    var onCancelled: () -> Unit = {}

    override fun handleOnBackStarted(backEvent: BackEventCompat) {
        onStarted(backEvent)
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
        onProgressed(backEvent)
    }

    override fun handleOnBackPressed() {
        isEnabled = onCompleted()
    }

    override fun handleOnBackCancelled() {
        onCancelled()
    }
}

/// Stable lifecycle-aware registration using Android's supported back dispatcher. Keeping the
/// callback instance mounted preserves system precedence; SideEffect only refreshes its live
/// closures and enabled state.
@Composable
private fun RouterSystemBackHandler(
    enabled: Boolean,
    onStarted: (BackEventCompat) -> Unit,
    onProgressed: (BackEventCompat) -> Unit,
    onCompleted: () -> Boolean,
    onCancelled: () -> Unit,
) {
    val currentOnStarted by rememberUpdatedState(onStarted)
    val currentOnProgressed by rememberUpdatedState(onProgressed)
    val currentOnCompleted by rememberUpdatedState(onCompleted)
    val currentOnCancelled by rememberUpdatedState(onCancelled)
    val callback = remember { RouterOnBackPressedCallback(enabled) }
    SideEffect {
        callback.onStarted = currentOnStarted
        callback.onProgressed = currentOnProgressed
        callback.onCompleted = currentOnCompleted
        callback.onCancelled = currentOnCancelled
        callback.isEnabled = enabled
    }
    val dispatcher = checkNotNull(LocalOnBackPressedDispatcherOwner.current) {
        "No OnBackPressedDispatcherOwner was provided"
    }.onBackPressedDispatcher
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, dispatcher, callback) {
        dispatcher.addCallback(lifecycleOwner, callback)
        onDispose { callback.remove() }
    }
}

/// Build the route-frame node without resolving or mounting its component — the renderer stays
/// data-driven: the registered tag decides whether the frame is native DSX or an explicit web
/// surface. Native held frames return null because `StackSurface.pushedFrames` owns them.
/// (The canonical copy — the host shell's `routeFrameRoot` delegates here; RouteFrameRootTest
/// pins the contract through the delegate, RouterHostTest pins it here.)
fun routeFrameRoot(frame: Map<*, *>?): StackNode? {
    if ((frame?.get("native") as? Boolean) == true) return null
    val view = (frame?.get("view") as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val attrs = linkedMapOf(
        "src" to ((frame["src"] as? String) ?: ""),
        "path" to ((frame["path"] as? String) ?: "/"),
        "origin" to ((frame["origin"] as? String) ?: ""),
    )
    return StackNode(view, attrs, emptyList())
}

// MARK: - the retained per-frame surface (Swift FrameSurface — store+env live while the frame does)

/// One screen's isolated DSX surface: its own store + env, seeded once from the entry's `vars`
/// (LEGACY) and `attrs` (THE input contract). Held by the host in a frame-id map so a covered
/// screen keeps its state; freed only when the id permanently leaves `nav.stack` (the Swift
/// `@StateObject` contract — RouterHost.swift FrameSurface).
private class RouterFrameSurface(id: Int?, vars: Map<String, Any?>?, attrs: Map<String, Any?>?) {
    val store = StackStore().also { s ->
        s.frameId = id                      // frame-scoped verbs + dsx.screen.settled() target THIS screen
        if (!vars.isNullOrEmpty()) s.setPath("vars", vars)          // LEGACY seed (documented)
        if (!attrs.isNullOrEmpty()) s.set("dsx.attribute", attrs)   // THE input contract
    }
    val env = JSERunner(store)
}

// MARK: - the in-flight transition

/// One push/pop in flight. `top` is the screen ABOVE (incoming on push, outgoing/held on pop),
/// `under` the one beneath (covered on push, destination on pop). `gesture` marks a
/// predictive-back drive — the gesture coroutine owns `coverage`; otherwise the host's
/// LaunchedEffect plays the NAV spec. A replaced transition's effect cancels with it.
private class NavTransition(
    val push: Boolean,
    val gesture: Boolean,
    val top: Map<*, *>,
    val under: Map<*, *>,
    start: Float,
) {
    val coverage = Animatable(start)
}

// MARK: - the host

/// The kernel navigable surface: observe `DSX.state`, render the `nav.stack` frames as a screen
/// stack with the screen-presentation motion, host the boot diagnostic, and own system BACK
/// (predictive peek included). `fallback` is the configured entry floor (AppManifest
/// entryFloorNode) — rendered only while no valid frame exists, exactly like the previous
/// minimal host. Mount ONCE, inside RouterChromeHost's content slot (the host shell does).
@Composable
fun RouterHost(fallback: StackNode? = null) {
    var vars by remember { mutableStateOf<Map<String, Any?>>(DSX.state.vars.toMap()) }
    DisposableEffect(Unit) {
        val c = DSX.state.sink { vars = it }
        onDispose { c.cancel() }
    }
    // :render owns transitions → the popped/dismissed surface release hold (0.6s — Stack.swift's
    // asyncAfter) must be wired even when RouterModalHost isn't mounted: the outgoing NATIVE
    // frame renders its held surface the whole way out. Idempotent with RouterModalHost's wiring.
    remember { wireSurfaceReleaseHold(); true }

    // THE BOOT DIAGNOSTIC (root-plan.md §9) — kernel-owned pixels, deliberately NOT a
    // component: renders only when the root plan is EXHAUSTED (`global.root.exhausted`,
    // published by the fold). Test channels see the attempt ledger; production a neutral
    // line + Retry (re-runs the plan once per tap via the kernel Router).
    val exhausted = ((vars["root"] as? Map<*, *>)?.get("exhausted") as? List<*>)
        ?.filterIsInstance<Map<*, *>>()
    if (!exhausted.isNullOrEmpty()) {
        BootDiagnostic(exhausted)
        return
    }

    val navStack: List<Map<*, *>> = ((vars["nav"] as? Map<*, *>)?.get("stack") as? List<*>)
        ?.filterIsInstance<Map<*, *>>() ?: emptyList()
    val reduceMotion = rememberAnimatorDurationScale() == 0f

    // ── the reconcile (the RouterModals adopt-before-render precedent: guarded composition
    // writes that converge in one pass). `displayed` mirrors the last adopted publish;
    // an id-sequence change classifies the ONE transition; a same-ids content refresh
    // (route.updateComponent) adopts silently so LaunchedEffect(attrs) re-seeds live.
    var displayed by remember { mutableStateOf<List<Map<*, *>>>(emptyList()) }
    var transition by remember { mutableStateOf<NavTransition?>(null) }
    val ids = navStack.mapNotNull { RouterStackDiff.frameId(it["id"]) }
    if (navStack != displayed) {
        val displayedIds = displayed.mapNotNull { RouterStackDiff.frameId(it["id"]) }
        if (ids != displayedIds) {
            transition = if (reduceMotion) null else when (RouterStackDiff.classify(displayedIds, ids)) {
                RouterStackDiff.Kind.PUSH -> NavTransition(push = true, gesture = false,
                                                           top = navStack.last(), under = displayed.last(),
                                                           start = 0f)
                RouterStackDiff.Kind.POP -> NavTransition(push = false, gesture = false,
                                                          top = displayed.last(), under = navStack.last(),
                                                          start = 1f)
                else -> null    // SWAP (boot seed / replace / reset / root heal) — instant, the silence rule
            }
        }
        displayed = navStack
    }

    // ── system BACK + the predictive peek. One handler covers both worlds: with gesture
    // events (API 34+, manifest opt-in) progress drives the pop pose and the previous screen
    // peeks beneath; without them the flow completes straight to the commit — a plain pop
    // with the pop transition (the state diff plays it). The commit that DID play the gesture
    // adopts the popped stack BEFORE calling the verb, so the publish arrives id-identical
    // and never replays the exit (the web swipe-back skip-flag precedent).
    val canPop = RouterBackDispatch.canPop(displayed.size)
    val backScope = rememberCoroutineScope()
    var gestureTransition by remember { mutableStateOf<NavTransition?>(null) }
    var gestureProgressJob by remember { mutableStateOf<Job?>(null) }
    val lastPopCommitAt = remember { longArrayOf(-1L) }
    val platformBackSequenceStarted = remember { booleanArrayOf(false) }
    RouterSystemBackHandler(
        enabled = canPop,
        onStarted = {
            platformBackSequenceStarted[0] = true
            gestureProgressJob?.cancel()
            val stackNow = displayed
            val peek = transition == null &&
                RouterBackDispatch.canPop(stackNow.size) &&
                !reduceMotion
            val t = if (peek) {
                NavTransition(
                    push = false,
                    gesture = true,
                    top = stackNow.last(),
                    under = stackNow[stackNow.size - 2],
                    start = 1f,
                )
            } else {
                null
            }
            gestureTransition = t
            if (t != null) transition = t
        },
        onProgressed = { event ->
            val t = gestureTransition
            if (t != null && transition === t) {
                gestureProgressJob?.cancel()
                // Back progress is already delivered on the main dispatcher. Starting
                // undispatched applies snapTo before this callback returns; dispatching one
                // coroutine per sample lets cancelled jobs queue ahead of the release commit.
                gestureProgressJob = backScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    t.coverage.snapTo(RouterMotion.gestureCoverage(event.progress))
                }
            }
        },
        onCompleted = {
            gestureProgressJob?.cancel()
            val t = gestureTransition
            gestureTransition = null
            val platformAlreadyAnimated = platformBackSequenceStarted[0]
            platformBackSequenceStarted[0] = false
            if (t == null) {
                // A key/button Back has no gesture start/progress. Commit on this dispatcher
                // callback before it returns so another rapid press can pop the new top. If
                // that press arrives while a previous pop is still settling, interrupt the
                // old pixels and adopt the newer destination instead of queueing 350 ms again.
                val commitAt = SystemClock.uptimeMillis()
                if (platformAlreadyAnimated || RouterBackDispatch.coalescesRapidPop(
                        inFlightIsPop = transition?.push == false,
                        stackDepth = displayed.size,
                    ) || RouterBackDispatch.followsRecentPop(
                        lastCommitAtMs = lastPopCommitAt[0],
                        nowMs = commitAt,
                    )
                ) {
                    val committed = displayed.dropLast(1)
                    displayed = committed
                    transition = null
                    Router.shared?.pop()
                    lastPopCommitAt[0] = commitAt
                    return@RouterSystemBackHandler RouterBackDispatch.canPop(committed.size)
                }
                Router.shared?.pop()
                lastPopCommitAt[0] = commitAt
                val depth = ((DSX.state.getPath("nav.stack") as? List<*>)?.size ?: 0)
                RouterBackDispatch.canPop(depth)
            } else {
                // Commit the model and optimistically adopt its destination BEFORE returning
                // from the dispatcher. API 34+ also sends start/completed around hardware Back:
                // deferring Router.pop() until the 350 ms settle made a second rapid press pop
                // the same old top again, serializing two transitions past the 800 ms contract.
                // Android invokes completion after its gesture-owned completion phase, so a
                // second DSX settle here is a duplicate animation. Drop the held pixels and
                // snap the existing draw layer to its terminal pose before Compose retires it:
                // recomposition may trail the callback on a loaded emulator, but the destination
                // must not remain visually covered during that bookkeeping. Then pre-adopt the
                // ids before the synchronous publish so the exit is not replayed.
                val committed = displayed.dropLast(1)
                backScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    t.coverage.snapTo(0f)
                }
                displayed = committed
                transition = null
                Router.shared?.pop()
                lastPopCommitAt[0] = SystemClock.uptimeMillis()
                RouterBackDispatch.canPop(committed.size)
            }
        },
        onCancelled = {
            platformBackSequenceStarted[0] = false
            gestureProgressJob?.cancel()
            val t = gestureTransition
            gestureTransition = null
            if (t != null && transition === t) {
                backScope.launch {
                    t.coverage.animateTo(
                        1f,
                        StackMotion.spec(RouterMotion.settleSpec(t.coverage.value, 1f)),
                    )
                    if (transition === t) transition = null
                }
            }
        },
    )

    // A programmatic transition plays the NAV spec once, then settles; a gesture transition
    // is driven by its own coroutine above. Replacing `transition` cancels this effect (and
    // the Animatable in flight) — the "replaced mid-flight drops the first exit" pin.
    val t = transition
    LaunchedEffect(t) {
        if (t == null || t.gesture) return@LaunchedEffect
        t.coverage.animateTo(if (t.push) 1f else 0f, StackMotion.spec(RouterMotion.NAV))
        if (transition === t) transition = null
    }

    // ── render: bottom → top in ONE keyed loop, so a frame moving between the under and top
    // slots keeps its composition (the RouterModals key(id) precedent). At rest only the top
    // composes (the NavigationStack laziness twin).
    val topEntry: Map<*, *>? = t?.top ?: displayed.lastOrNull()
    val underEntry: Map<*, *>? = t?.under
    // ONE app WebView exists (Dom): when BOTH layers are web-surface frames, the layer that
    // should own it wins (incoming top on push, destination under on pop) — see DEVIATIONS.
    val topView = topEntry?.get("view") as? String
    val underView = underEntry?.get("view") as? String
    val bothWeb = topView != null && underView != null &&
        topView in ScreenReadiness.webSurfaceTags && underView in ScreenReadiness.webSurfaceTags
    val webOwnerIsTop = t?.push == true

    val surfaces = remember { HashMap<Int, RouterFrameSurface>() }
    // A covered frame leaves the lazy composition after its transition, but its native
    // rememberSaveable state must remain attached to the route id. Without a holder here,
    // API 24 could dispose a scrolled frame before Back recomposed it and silently reset the
    // destination to the top. NavigationStack/Fragment state ownership is the native model:
    // retain while the route is live, remove only when the Router permanently drops the id.
    val frameState = rememberSaveableStateHolder()
    val trailing = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1f else 1f
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = constraints.maxWidth.toFloat()
        val layers: List<Pair<Map<*, *>?, Boolean>> =
            if (t != null && underEntry != null) listOf(underEntry to false, topEntry to true)
            else listOf(topEntry to true)
        for ((entry, isTop) in layers) {
            val frameKey = RouterStackDiff.frameId(entry?.get("id")) ?: "fallback"
            key(frameKey) {
                frameState.SaveableStateProvider(frameKey) {
                    val pose = if (t == null) Modifier else Modifier.graphicsLayer {
                        // Animatable.value read at DRAW time — per-frame updates, no recomposition.
                        translationX = trailing * (if (isTop) RouterMotion.topX(widthPx, t.coverage.value)
                                                   else RouterMotion.underX(widthPx, t.coverage.value))
                    }
                    Box(Modifier.fillMaxSize().then(pose)) {
                        RouterScreenFrame(
                            frame = entry,
                            fallback = if (entry == null) fallback else null,
                            surfaces = surfaces,
                            webStandIn = bothWeb && (isTop != webOwnerIsTop),
                        )
                        if (!isTop && t != null) {
                            // The covered screen's dim (draw-phase read) + input shield: mid-peek
                            // the exposed destination must not take taps (iOS disables interaction
                            // under a running transition).
                            Box(Modifier.fillMaxSize()
                                .drawBehind { drawRect(Color.Black.copy(alpha = RouterMotion.underDim(t.coverage.value))) }
                                .blockHits())
                        }
                    }
                }
            }
        }
    }

    // ── permanent-removal release (the Swift FrameSurface.deinit seam): a surface frees when
    // its id is out of `nav.stack` AND not held by the in-flight transition's exit — never on
    // mere cover. `ScreenReadiness.release` of an untracked id is a silent no-op (rule 8).
    val liveIds = HashSet(ids)
    t?.let { tr ->
        RouterStackDiff.frameId(tr.top["id"])?.let(liveIds::add)
        RouterStackDiff.frameId(tr.under["id"])?.let(liveIds::add)
    }
    SideEffect {
        val iter = surfaces.keys.iterator()
        while (iter.hasNext()) {
            val id = iter.next()
            if (id !in liveIds) {
                ScreenReadiness.release(id)
                frameState.removeState(id)
                iter.remove()
            }
        }
    }
}

// MARK: - one screen

/// Render one frame's surface — the ScreenFrame twin. A module-pushed NATIVE frame renders the
/// held surface registered for its id (`StackSurface.pushedFrames`); a route frame renders the
/// dynamic `<{{ view }} src=… path=… origin=…/>` node; `fallback` (the configured entry floor)
/// only ever arrives for the synthetic pre-boot frame. A native frame whose held surface is
/// already freed renders NOTHING — transparent, never the theme backdrop, so mid-pop it reveals
/// the destination (RouterHost.swift ScreenFrame's Color.clear rule). `webStandIn` renders the
/// theme backdrop instead of the frame (the one-WebView transition guard — see the host).
@Composable
private fun RouterScreenFrame(
    frame: Map<*, *>?,
    fallback: StackNode?,
    surfaces: MutableMap<Int, RouterFrameSurface>,
    webStandIn: Boolean,
) {
    val id = RouterStackDiff.frameId(frame?.get("id"))
    val native = (frame?.get("native") as? Boolean) == true
    val heldRoot = if (native && id != null) StackSurface.pushedFrames[id] as? StackNode else null
    val root = heldRoot ?: routeFrameRoot(frame) ?: fallback ?: return
    if (webStandIn) {
        Box(Modifier.fillMaxSize().background(StackStyle.color("background")))
        return
    }
    @Suppress("UNCHECKED_CAST")
    val attrs = frame?.get("attrs") as? Map<String, Any?>
    @Suppress("UNCHECKED_CAST")
    val vars = frame?.get("vars") as? Map<String, Any?>
    // The retained surface: get-or-create in the host's frame-id map (state survives cover);
    // the id-less synthetic fallback frame gets a local, unretained one (exactly the old host).
    val surface = remember {
        if (id != null) surfaces.getOrPut(id) { RouterFrameSurface(id, vars, attrs) }
        else RouterFrameSurface(null, vars, attrs)
    }
    // LIVE updates (route.updateComponent) — re-seed the reactive dict on entry change, and on
    // a resurface remount (idempotent set; bindings recalc via the store publish).
    LaunchedEffect(attrs) { attrs?.let { if (it.isNotEmpty()) surface.store.set("dsx.attribute", it) } }
    // NATIVE READINESS — the frame-render seam (Conformance/lifecycle/readiness.json; Swift:
    // ScreenFrame.onAppear). `mount` is idempotent while the record lives, so the re-run when a
    // covered screen resurfaces mid-back changes nothing (rule 2); `settleManual`/`hostsWebSurface`
    // were recorded on the store during the composition this effect follows. RELEASE deliberately
    // does NOT live in onDispose — a covered screen's composition is disposed while its frame is
    // alive; the host's permanent-removal diff owns release (FrameSurface.deinit, not onDisappear).
    val framePath = frame?.get("path") as? String
    val frameView = frame?.get("view") as? String
    DisposableEffect(id) {
        if (id != null) {
            // Surface kind by REGISTRATION, never by name (root-plan.md §capability).
            ScreenReadiness.mount(id, framePath,
                                  if (frameView in ScreenReadiness.webSurfaceTags) "web" else "native")
            if (surface.store.settleManual) ScreenReadiness.manual(id)
            // HYBRID ORDERING (readiness.json rule 9): a NATIVE frame that composed a
            // <DSXWebView/> child gates its settle on that page.
            if (surface.store.hostsWebSurface) ScreenReadiness.hostsWeb(id)
        }
        onDispose { }
    }
    // The frame backdrop rides the semantic `background` (theme surface — the ratified
    // system-defaults decision; iOS paints clear over its system background). Opaque by
    // design: transition layers must not bleed through each other.
    Box(Modifier.fillMaxSize().background(StackStyle.color("background"))) {
        StackRootView(root, surface.store, surface.env)
    }
}

// MARK: - the boot diagnostic (root-plan.md §9)

/// The root-plan EXHAUSTION diagnostic — the floor beneath the plan. Kernel-owned pixels, never
/// a component and never a surface: rendering it must not re-privilege any renderer, and it must
/// survive a broken component system. Test channels (`AppEnvironment.isTest`) show the full
/// attempt ledger; production shows a neutral line. Retry re-runs the plan once per tap through
/// the kernel Router. (Moved here from the host shell — RouterHost.swift keeps its twin in the
/// same file; the bootloader stays wiring-only.)
@Composable
private fun BootDiagnostic(ledger: List<Map<*, *>>) {
    val mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp)
    Column(
        modifier = Modifier.fillMaxSize().background(Color.White).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (AppEnvironment.current.isTest) {
            BasicText("Root plan exhausted", style = mono)
            Spacer(Modifier.height(8.dp))
            for (row in ledger) {
                BasicText(
                    "${row["index"]}  ${row["id"]}  ${row["code"]}  ${((row["elapsedMs"] as? Number)?.toLong() ?: 0L) / 1000.0}s",
                    style = mono,
                )
            }
            Spacer(Modifier.height(8.dp))
            BasicText("Plan: App.json entry.surfaces · details in dsx.errors",
                      style = TextStyle(fontSize = 11.sp))
        } else {
            BasicText("Something went wrong")
        }
        Spacer(Modifier.height(12.dp))
        BasicText("Retry", modifier = Modifier.clickable { Router.shared?.retryRootPlan() }.padding(12.dp), style = mono)
    }
}
