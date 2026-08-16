//
//  Router.kt — the KERNEL navigation runtime (the `route` scheme). Kotlin twin of
//  Engine/Router.swift — same names, same arguments, same behaviors.
//
//  Navigation is a KERNEL PRIMITIVE, not a removable capability. This runtime owns the nav
//  STATE (`global.nav.stack`, mirrored to `global.route`), the STACK verbs (push / pop /
//  replace / reset), the path → screen RESOLUTION (match the route table with a capability
//  gate, else the configured fallback — App.json `entry.fallback`), and the route.path
//  OBSERVER (a plain `route.path` write navigates). The kernel host (RouterHost on iOS;
//  Android: :render's RouterHost — push/pop transitions + predictive back — beside its
//  RouterModalHost and RouterChromeHost halves) RENDERS this stack; its CONTRACT with the
//  runtime is exactly the published state shapes, pinned in RouterTest:
//      global.nav = { stack: [frame…], canPop, depth, modal: [entry…], chrome: {frameId: spec} }
//      global.route = the top frame ({ path, view, src, params, query, (origin), id, … })
//
//  THE LOAD GATE: reading the remote route table goes through `trustedRoutes(forPath:)` →
//  `RemoteBundleGate`. Signing OFF (the default) ⇒ `global.routes` unchanged, byte-for-byte;
//  ON ⇒ the table is parsed from the VERIFIED signed bytes at `global.routes_signed`, and
//  missing/unverified/unparsable ⇒ EMPTY table (every path → the configured fallback) + a
//  `route_unavailable` broadcast. See Router.swift's header + remote-bundle-signing.md.
//
//  ── SEAMS (PLAN.md ground rule 3 — Module/Context/Stack are concurrent or later ports) ──
//  • THE BUS — Swift's Router is a `Module` reaching the bus via its bound `dsx`. Module.kt /
//    Context.kt are being ported concurrently, so the two bus edges are settable seams:
//      `fire`      — dsx.delegate.send("route.refresh", combine = ModuleRegistry.Combine.void) (the hook bus; default no-op until wired)
//      `broadcast` — dsx.broadcast(event, json); defaults to the native event bus
//                    (DSXEvents.publish, scheme "route") so in-process subscribers work today;
//                    `RouterActions.setup()` rebinds BOTH to its `dsx` (the full web+native
//                    fan-out); the settable defaults stand for a bare kernel and for tests.
//    The Swift action table maps 1:1 onto public methods — `RouterActions` (this file, below
//    the Router) carries it on the bus with Swift's exact names, arg defaults and order (read
//    the class: it IS the table, no prose copy to drift); the host registers it at boot
//    (DespiaApp), putting it behind `dsx.module.route.*` (and, once the Dom module mounts its
//    web bridge, `window.despia.route.*`). Without the action layer the public methods here
//    ARE the surface (Swift keeps the verbs `private` behind `dsx.action`).
//  • CAPABILITY GATE — Swift: `ModuleRegistry.shared.isAvailable(name) || StackComponents.has(name)`.
//    Neither registry lives in :core, so the two halves arrive on two seams and `available()`
//    unions them: `JSE.moduleAvailable` (packages — also the `has()` builtin, which answers
//    about packages only on BOTH runtimes, which is why the union is here and not in the seam)
//    and `JSE.componentAvailable` (the :render component table). Boot binds both (DespiaApp).
//  • SURFACES — `StackSurface` (Stack.swift) rides the :render port. Its frame stores +
//    release entry points are declared below as `object StackSurface` (it becomes the class's
//    companion when Stack.kt lands); surfaces are held as OPAQUE handles (`Any`). Construction
//    (`StackSurface(root:webView:scope:dsx:)` + `surface.store.set("vars", …)`) is the
//    `surfaceFactory` seam — the default returns the parsed root `StackNode` as the handle, so
//    the whole state machine runs and is testable without a render layer; a null from the
//    factory = failed build (logged no-op, like an unparsable tag).
//  • OBSERVER — Combine `DSX.state.$vars.receive(on: RunLoop.main).sink` → State.kt's
//    `DSX.state.sink` (through `StackStorePublisher.mainExecutor`). One divergence: iOS defers
//    the initial delivery to the next runloop pass; the inline default here fires it inside
//    `observe()`. Benign by design — `resolveIfPathChanged` is guarded + idempotent, and
//    `boot()` reseeds the root frame right after (same final shape, frame ids stay opaque).
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • `static weak var shared` → a plain nullable `var` (no weak semantics needed: the registry
//    owns the module for the process lifetime; tests null it in teardown).
//  • JVM has no deinit to auto-cancel the observer, so `shutdown()` (no Swift twin) cancels the
//    `route.path` sink explicitly — the deinit stand-in, same rationale as State.kt's
//    AnyCancellable note.
//  • `apply()` publishes SHALLOW COPIES of stack/modal/chrome. Swift's value-type collections
//    copy on write; publishing the live JVM references would make DSX.state's deep-equal write
//    elision compare a container against itself and swallow every update.
//  • `JSE.stateVars` stays UNWIRED by this file (the State.kt precedent) — a route `guard`
//    reads `global.*` only once boot binds `JSE.stateVars = { DSX.state.vars }`.
//  • Percent-decoding (`parseQuery`): invalid %-hex keeps the RAW string (Swift's
//    `removingPercentEncoding ?? raw`); invalid UTF-8 byte sequences decode to U+FFFD where
//    Swift would fall back to raw (unreachable from well-formed URLs; documented divergence).
//  • Strict-cast fidelity: `r["requires"] as? [String]` and `as? [[String: Any]]` fail WHOLE on
//    a heterogeneous value; the Kotlin helpers (`stringList`, `dictArray`) check every element
//    to match (erased generics would otherwise wave anything through).
//

package despia.engine

import java.io.ByteArrayOutputStream

/// Implements `JSERunnerRouter` (JseRunner.kt's seam for `dsx.component.push/present/dismiss`
/// in markup logic) — the signatures are 1:1 with the Swift verbs; boot wires
/// `JSERunner.router = Router.shared` alongside the launch hook.
class Router : JSERunnerRouter {

    companion object {
        /// A binding that resolves to a RETIRED boot. Never equals a live attempt index (those
        /// are >= 0 while the fold races), so `settle`/`rootError` always drop it.
        private const val STALE_ATTEMPT = -1

        /// The native-route-unavailable surface is a CLAIMED role (`route.nativeUnavailable` —
        /// the Routing module claims it with Foundation's compiled status screen), never a
        /// kernel-named component (root-plan.md rule 18; Swift twin: Router.nativeUnavailableView).
        /// Unclaimed ⇒ an empty view: the degrade stays native-shaped, just blank (Article 7).
        internal val nativeUnavailableView: String
            get() = (ModuleRegistry.shared.dispatch("route.nativeUnavailable", combine = ModuleRegistry.Combine.claim) as? String) ?: ""

        /// The kernel host (`RouterHost`) reaches the runtime through this to report a back-swipe
        /// pop — kernel-internal (the Router and its host are one subsystem, like `DSX.state`).
        /// Swift: `static weak var`, set in setup() (see NOTES).
        var shared: Router? = null

        // MARK: route_unavailable — the engine-owned broadcast (C1 rollback · C2 asset integrity)

        /// The Router OWNS the `route_unavailable` broadcast contract (the `route` scheme + the
        /// `{ path, reason }` envelope web reads via `despia.on("route", …)`). Table-source and
        /// asset consumers trigger the SAME broadcast through here rather than minting their own
        /// channel. No-op if the Router isn't booted (a pure web app without the route runtime).
        /// Reasons today: `missing_capability` · `component_unavailable` ·
        /// `component_unbuildable` · `unverified_manifest` · `signature_invalid` (in
        /// `trustedRoutes`), `rollback_detected` (C1) and `asset_integrity` (C2).
        fun reportRouteUnavailable(path: String, reason: String) {
            shared?.let { it.broadcast("route_unavailable", JSON.from(mapOf("path" to path, "reason" to reason))) }
        }

        /// Parse `?a=1&b=hi%20there` → `{"a": "1", "b": "hi there"}` (percent-decoded; string
        /// values, like the web — read as `route.query.x` / `dsx.query.x`). No query → `{}`.
        private fun parseQuery(path: String): Map<String, String> {
            val q = path.indexOf('?')
            if (q < 0) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (pair in path.substring(q + 1).split('&')) {
                if (pair.isEmpty()) continue                                  // Swift split drops empties
                val kv = pair.split('=', limit = 2).filter { it.isNotEmpty() } // Swift maxSplits:1, omit-empty
                val raw = kv.firstOrNull() ?: continue
                val v = if (kv.size > 1) kv[1] else ""
                out[percentDecoded(raw)] = percentDecoded(v)
            }
            return out
        }

        /// Swift `removingPercentEncoding ?? raw`: decode %XX byte sequences as UTF-8; any
        /// malformed escape keeps the raw string (see NOTES for the invalid-UTF-8 edge).
        private fun percentDecoded(raw: String): String {
            if ('%' !in raw) return raw
            val out = ByteArrayOutputStream()
            var i = 0
            while (i < raw.length) {
                if (raw[i] == '%') {
                    if (i + 3 > raw.length) return raw
                    val hi = Character.digit(raw[i + 1], 16)
                    val lo = Character.digit(raw[i + 2], 16)
                    if (hi < 0 || lo < 0) return raw
                    out.write((hi shl 4) or lo)
                    i += 3
                } else {
                    var j = i
                    while (j < raw.length && raw[j] != '%') j++
                    val chunk = raw.substring(i, j).toByteArray(Charsets.UTF_8)
                    out.write(chunk, 0, chunk.size)
                    i = j
                }
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }

        /// Parse the route table out of the signed routes.json text. Accepts BOTH manifest
        /// shapes (the signature covers the whole document either way):
        ///   • the OBJECT form `{ "version": <int>, "routes": [ … ] }` (C1/C2);
        ///   • the bare ARRAY form `[ … ]` — BACK-COMPAT, the route array directly.
        /// null on any malformed input (treated as "no trusted table" → fallback).
        private fun parseRouteTable(text: String): List<Map<String, Any?>>? {
            val top = json(text).foundationValue ?: return null
            dictArray(top)?.let { return it }                                 // bare array (old) — back-compat
            val obj = top as? Map<*, *> ?: return null
            return dictArray(obj["routes"])                                   // { version, routes:[…] } (new)
        }

        /// Swift `as? [[String: Any]]`: every element must be a string-keyed dictionary,
        /// else the whole cast fails (see NOTES on strict-cast fidelity).
        @Suppress("UNCHECKED_CAST")
        private fun dictArray(v: Any?): List<Map<String, Any?>>? {
            val list = v as? List<*> ?: return null
            if (!list.all { e -> e is Map<*, *> && e.keys.all { it is String } }) return null
            return list as List<Map<String, Any?>>
        }

        /// Swift `as? [String]` — whole-cast semantics (a mixed list yields `[]` via `?? []`).
        /// The strict cast itself is the file-level `strictStringList` (shared with RouterActions).
        private fun stringList(v: Any?): List<String> = strictStringList(v) ?: emptyList()

        /// Truthiness of a `global.*` state value for a route `guard` — null / NSNull / false /
        /// 0 / "" / "false" / "0" / empty collection are falsy; everything else is truthy.
        private fun truthy(v: Any?): Boolean = when (v) {
            null, NSNull -> false
            is Boolean -> v
            is Number -> v.toDouble() != 0.0
            is String -> v.isNotEmpty() && v != "false" && v != "0"
            is List<*> -> v.isNotEmpty()
            is Map<*, *> -> v.isNotEmpty()
            else -> true
        }

        /// A throwaway store for evaluating route `guard` predicates. JSE resolves `global.*` /
        /// `route.*` against `DSX.state` (NOT this store), and `JSE.eval` self-restores its depth
        /// budget, so ONE reused store is safe and allocation-free — a guard can only READ state.
        private val guardStore = StackStore()

        /// "In scope" = compiled into this binary AND not excluded: a package scheme OR a
        /// component tag — the capability floor, byte-for-byte Swift's
        /// `ModuleRegistry.shared.isAvailable(name) || StackComponents.has(name)`
        /// (Router.swift `available`). :core owns neither registry, so each half arrives on
        /// its own seam: `JSE.moduleAvailable` (packages, also the `has()` builtin — which on
        /// BOTH runtimes answers about packages ONLY, so the union must live here and not in
        /// that seam) and `JSE.componentAvailable` (the component table, filled by boot).
        /// An UNBOUND component seam contributes nothing — the honest answer for a runtime
        /// with no render layer, and the reason a `requires` naming a component still fails
        /// closed there. (The ROOT PLAN's `registered` reads the seam directly and fails OPEN
        /// instead: refusing to try is not the same question as "is this capability here".)
        private fun available(name: String): Boolean =
            JSE.moduleAvailable(name) || (JSE.componentAvailable?.invoke(name) ?: false)

        /// Swift `as? [String: Any]` — element-checked map cast (see NOTES).
        @Suppress("UNCHECKED_CAST")
        private fun anyDict(v: Any?): Map<String, Any?>? {
            val m = v as? Map<*, *> ?: return null
            if (!m.keys.all { it is String }) return null
            return m as Map<String, Any?>
        }

        /// `meta.title` → a chrome spec. null when the table declares none (or an empty one —
        /// the explicit opt-out is derivedChrome's business to honor).
        private fun metaChrome(meta: Map<String, Any?>?): Map<String, Any?>? {
            val t = meta?.get("title") as? String ?: return null
            if (t.isEmpty()) return null
            return mapOf("title" to t, "large" to false)
        }

        /// The DERIVED bar title for a pushed web frame with no declared `meta.title`: the
        /// path's last segment, prettified ("/help/faq-page" → "Faq page"), so a deep-linked or
        /// pushed web path always has a titled system bar + back affordance. An EXPLICIT empty
        /// `meta.title` ("") declares "no bar" → null; the bare root ("/") has no segment → null.
        private fun derivedChrome(path: String, meta: Map<String, Any?>?): Map<String, Any?>? {
            if ((meta?.get("title") as? String) == "") return null   // declared opt-out
            val clean = path.substringBefore('?').substringBefore('#')
            val seg = clean.split('/').lastOrNull { it.isNotEmpty() } ?: return null
            val words = seg.replace('-', ' ').replace('_', ' ').trim()
            if (words.isEmpty()) return null
            return mapOf("title" to words.replaceFirstChar { it.uppercaseChar() }, "large" to false)
        }
    }

    // MARK: bus seams (see SEAMS — Swift reaches these through its bound `dsx`)

    /// `dsx.delegate.send(name, combine = ModuleRegistry.Combine.void)` — the hook bus (`route.refresh` asks the table owner to refetch).
    var fire: (String) -> Unit = {}

    /// `dsx.broadcast(event, json)` under the `route` scheme. Default: the in-process native
    /// event bus (web fan-out attaches when the Context/Dom wiring lands).
    var broadcast: (String, JSON) -> Unit = { event, data -> DSXEvents().publish("route", event, data) }

    /// Surface construction seam (see SEAMS): `(parsed component root, caller scope, vars)` →
    /// the render-surface handle, or null for a failed build. Default: the root node itself.
    var surfaceFactory: (root: StackNode, scope: String?, vars: Map<String, Any?>?) -> Any? =
        { root, _, _ -> root }

    private var cancellable: AnyCancellable? = null
    /// Android may create the Application for a receiver, service, or instrumentation fixture
    /// without mounting the app's Activity. The host opts into this latch before dispatching
    /// `lifecycle.launch`: Router.boot() records the request, but the root-plan deadline cannot start
    /// until the real RouterHost surface exists. Other hosts/tests retain the eager default.
    private var waitingForSurfaceHost = false
    private var bootRequestedWhileWaitingForHost = false
    private var lastResolvedPath: String? = null
    private var publishing = false     // true while apply() is mid-publish — the path observer stands down (see resolveIfPathChanged)
    private var stack: MutableList<Map<String, Any?>> = ArrayList()  // the navigation back-stack (root … top); top == global.route
    private var modal: MutableList<Map<String, Any?>> = ArrayList()  // the presented-modal stack, published as global.nav.modal
    private var frameSeq = 0                                         // monotonic frame ids (stable render-surface store keys)
    private var chrome: MutableMap<String, Map<String, Any?>> = LinkedHashMap()  // frameId → system nav-bar spec (global.nav.chrome)

    /// Swift `setup()` sets `shared` and registers the action table — here the table lives on
    /// `RouterActions` (end of file), which the host registers beside this call; see SEAMS for
    /// the 1:1 action → method map (and hook("lifecycle.launch") → boot()).
    fun setup() {
        shared = this
    }

    /// Android host seam: arm before the process-wide `lifecycle.launch` dispatch. A background-only
    /// process may initialize every package, but it must not burn a UI candidate's timeout.
    fun deferBootUntilSurfaceHost() {
        waitingForSurfaceHost = true
    }

    /// Android host seam: the Activity has reached onCreate and will mount RouterHost.
    /// First delivery releases exactly one pending boot; repeats from recreation are inert.
    fun surfaceHostMounted() {
        if (!waitingForSurfaceHost) return
        waitingForSurfaceHost = false
        if (bootRequestedWhileWaitingForHost) {
            bootRequestedWhileWaitingForHost = false
            boot()
        }
    }

    /// The deinit stand-in (no Swift twin — see NOTES): cancel the route.path observer and
    /// release the host handle so a dropped Router stops reacting to state writes.
    fun shutdown() {
        cancellable?.cancel()
        cancellable = null
        waitingForSurfaceHost = false
        bootRequestedWhileWaitingForHost = false
        rootFold?.close()   // cancel the pending attempt timer — a torn-down Router leaves no live daemon timer
        rootFold = null
        if (shared === this) shared = null
    }

    // MARK: boot + observe

    /// Boot the nav runtime (Swift: the `lifecycle.launch` hook). Seeds nav.stack + observes route.path;
    /// harmless if the root renderer isn't the route surface. NOT gated on OTA: navigation works
    /// without a table (unmatched paths fall to the configured fallback).
    fun boot() {
        if (waitingForSurfaceHost) {
            bootRequestedWhileWaitingForHost = true
            return
        }
        bootRequestedWhileWaitingForHost = false
        if (DSX.state.getPath("route.path") == null) DSX.state.setPath("route.path", AppManifest.entry.root)
        // SEED BEFORE OBSERVING: the state sink replays the current value ON SUBSCRIBE (inline
        // here), so observing an unseeded runtime made that replay replace() into an empty
        // stack — a phantom root the seed below then overwrote (harmless churn before frames
        // held surfaces; a leaked mount after). Seeded + applied first, the replay sees
        // path == lastResolvedPath and no-ops. (Router.swift boots in this order too.)
        val path = (DSX.state.getPath("route.path") as? String) ?: "/"
        // THE ROOT PLAN (root-plan.md; corpus `Conformance/router/root-plan.json`) — the ordered
        // first-ready fold over `App.json entry.surfaces` that RETIRED the two-arm
        // `bootsToEntryFallback` rule: no source decision, no web floor — the app's candidates
        // own the root, in array order. Each candidate mounts as the root frame and races frame
        // settle (`screen.ready`) vs a root-attributed `dsx.error` vs its `timeoutMs`; failure
        // always advances; an exhausted plan fires `root.exhausted` and the host shows the boot
        // diagnostic. Route rows with no `view` follow the BOOT WINNER (resolved()).
        // NOT cleared on a re-boot: `frameSeq` is monotonic and never reused, so the PREVIOUS
        // plan's frames must stay bound. Clearing would downgrade them from "stale, drop" to
        // "unmapped, settle the live attempt" — and retryRootPlan() is reached only from the
        // exhaustion diagnostic, i.e. exactly when a failed run's frames are still registered and
        // can still fire a late deadline (root-plan.md §5). But the STORED value is an attempt
        // index, which is meaningful only inside ONE fold: a retry restarts `live` at 0, so a
        // dead run's frame bound to 0 would then EQUAL the live index and crown the retry's
        // candidate on a corpse's signal. Entries are therefore stamped with the boot generation
        // and a foreign generation resolves to STALE_ATTEMPT — kept and dropped, never aliased.
        rootBootGeneration += 1
        rootFramelessAttempt = null
        val fold = RootPlan.Fold(AppManifest.entry.surfaces, object : RootPlan.Host {
            override fun mount(candidate: AppManifest.Entry.Surface, index: Int) {
                // RETIRE THE PREVIOUS CANDIDATE'S READINESS *before* the new frame exists.
                // `screen.ready` is LEVEL-triggered state and this renderer's sink runs INLINE,
                // so a `true` left standing by the candidate that just failed would crown its
                // successor in the same sink pass, before that successor rendered a pixel (its
                // own timeoutMs never applying). The new frame republishes through
                // viewStart/viewFinish like any other. Ordered ahead of `apply()` so a
                // synchronous first render's real `true` lands after this, not under it.
                DSX.state.setPath("screen.ready", false)
                stack = mutableListOf(candidateEntry(path, candidate))
                apply()
                // The candidate's own timeoutMs is the bounded fail-open for the boot attempt —
                // suspend the frame's 10s readiness deadline or it would force a fail-open
                // "ready" and defeat any longer surface fallback (RootPlan.kt header).
                val frame = frameIdOf(stack.firstOrNull()?.get("id"))
                ScreenReadiness.suppressedDeadlineFrame = frame
                // BIND THE FRAME TO THE ATTEMPT. Readiness reports name their frame
                // (`screen.frame`), so the observe sink below can tell WHOSE settle it is
                // reading off the level. Frame ids are monotonic and never reused, so a report
                // from a retired candidate's frame resolves to ITS index and the fold drops it
                // as stale instead of crowning whoever is live now — retiring `screen.ready`
                // above closes the common race, this closes the rest.
                // ONLY the root frame: `stack` was replaced with exactly this candidate's entry
                // two statements above, and anything the candidate pushes LATER (an on:load
                // route.push, a presented sheet) allocates its id during composition, after
                // `mount` has returned — so no loop here can reach it. Those ids stay UNMAPPED
                // and take the fail-open branch, as they did before the binding existed.
                frame?.let { rootAttemptFrame[it] = rootBootGeneration to index }
                // THE FRAMELESS SURFACE. A web-surface candidate is never tracked by
                // ScreenReadiness (only a NATIVE frame is), so its readiness arrives through the
                // frameless relay with `screen.frame` absent — the binding above is written for
                // an id no report will ever carry, and an unmapped/frameless settle would crown
                // whoever is live. Record the attempt that owns the frameless plane so a late
                // report from a RETIRED web candidate resolves to its own index and drops. The
                // kernel names no module: membership is the registry the surface owner populates.
                if (candidate.view in ScreenReadiness.webSurfaceTags) {
                    rootFramelessAttempt = rootBootGeneration to index
                }
                // WHICH attempt is live, then THAT one is live — identity before level, the
                // same publish law as `screen.frame` before `screen.ready` (phase.json rule 5):
                // this renderer's sink runs INLINE, so flipping the level first would hand a
                // reader `root.live == true` still paired with the PREVIOUS attempt's index. A
                // surface stamps the failure it reports later with `data.attempt` read HERE,
                // and the fold drops it if the plan has moved on — `root.live` alone stays true
                // across every attempt, so it cannot distinguish a retired candidate's late
                // failure from the live one's (root-plan.md §failure attribution).
                DSX.state.setPath("root.attempt", index)
                // The LIVE-ATTEMPT flag, kernel-owned state: a surface module tags a terminal
                // failure origin "root" by READING this — it never infers its position.
                DSX.state.setPath("root.live", true)
            }
            override fun now(): Long = System.currentTimeMillis()
            override fun setTimer(ms: Long, fire: () -> Unit): () -> Unit =
                ScreenReadiness.scheduleDeadline(ms, fire)   // ONE clock — the readiness daemon
            override fun fire(event: String, payload: Map<String, Any?>) {
                ModuleRegistry.shared.dispatch(event, payload, combine = ModuleRegistry.Combine.void)
            }
            // Membership is guaranteed at BUILD time (root_plan_schema.rb V2 aborts on an
            // unregistered view per platform), but the runtime still consults the REAL
            // component table: a native frame settles on FIRST RENDER (the fail-open readiness
            // law), so an unregistered tag would otherwise mount BLANK and "settle" as the
            // winner instead of failing forward as root.component_missing (corpus F-10) —
            // reachable only in validator-bypassed dev trees, which is exactly who needs the
            // diagnostic. The table lives in :render (this module compiles SDK-free), so it
            // arrives through the `componentAvailable` seam; an UNBOUND seam means "no registry
            // here", not "no such component", and keeps the old fail-open (Jse.kt).
            override fun registered(view: String): Boolean =
                JSE.componentAvailable?.invoke(view) ?: true
            override fun diagnostic(ledger: List<RootPlan.Attempt>) {
                ScreenReadiness.suppressedDeadlineFrame = null
                DSX.state.setPath("root.live", false)
                DSX.state.setPath("root.exhausted", ledger.map { mapOf(
                    "index" to it.index, "id" to it.id, "view" to it.view,
                    "code" to it.code, "elapsedMs" to it.elapsedMs) })
            }
        }, target = "app")
        rootFold = fold
        fold.start()
        // The high-water mark is captured AFTER start(), not before: there is no sink yet during
        // start(), and the sink REPLAYS current state on subscribe — so an error raised while the
        // plan was folding synchronously (a `root.failed` hook tearing a candidate down) would be
        // replayed to whichever candidate ended up live and fail it at elapsedMs ~0, with the
        // dead one's code. An error nothing was listening for is not attributable to the
        // survivor. Pre-boot errors are excluded for the same reason they always were.
        lastSeenErrorCount = DSX.state.getPath("dsx.errorCount") as? Int ?: 0
        observe()   // the observe() sink also feeds frame settle to the fold (screen.ready state)
        // PROVENANCE floor — `dsx.source.routes` exists PACKAGELESS: with a bundled routes.json
        // the table serves from the binary (serving=bundle; never|stale per the persisted
        // per-origin stamp). Published only while no OTA table is up — the Routing package
        // overwrites with cache/origin at its own seams. No bundled table → no slice (honest
        // absence, Article 7). The kernel still names no module: this reports the kernel's OWN
        // floor, exactly like the fallback resolution above. Router.swift:281 reaches the
        // primitive through its `dsx` because Router IS a Module there; here the module face is
        // RouterActions and this class is plain kernel, so it calls the primitive directly —
        // the same shape as every DSX.state / broadcast line in this file.
        if (bundledTable.isNotEmpty() &&
            (dictArray(DSX.state.getPath("routes")) ?: emptyList()).isEmpty() &&
            (DSX.state.getPath("routes_signed") as? String) == null) {
            DSXSource.publish("routes", DSXSource.servingBundle, fresh = false,
                              key = (AppManifest.resolvedHost() ?: "").lowercase())
        }
    }

    /// The fold instance for THIS boot — `resolved()` reads the winner as the view-less route
    /// default, and the error plane forwards root-attributed failures here.
    internal var rootFold: RootPlan.Fold? = null

    /// Frame id → (boot generation, the root-plan attempt that mounted it). The stale-signal
    /// token made concrete: a readiness report carries its frame, this says which candidate owned
    /// that frame, and the fold drops a settle whose attempt is no longer live (root-plan.md §5).
    /// Bounded by the plan length (one root frame per attempt) times the number of boots this
    /// process has run; ids are monotonic, so entries stay valid across a retry and are never
    /// cleared — the GENERATION is what keeps a dead run's index from aliasing the new fold's.
    private val rootAttemptFrame = HashMap<Int, Pair<Int, Int>>()

    /// The attempt that owns the FRAMELESS readiness plane (a web-surface candidate — see
    /// `mount`), same (generation, index) shape. Null until such a candidate mounts, which is
    /// what keeps a pure-native plan on the legacy fail-open.
    private var rootFramelessAttempt: Pair<Int, Int>? = null

    /// Bumped once per `boot()`. Stamps every binding above so a retry cannot inherit them.
    private var rootBootGeneration = 0

    /// The attempt a report belongs to, or null when nothing binds it (fail-open: settle the live
    /// attempt). A binding from a PREVIOUS boot resolves to STALE_ATTEMPT, which is never a live
    /// index, so the fold drops it — retained-and-dropped, never aliased onto the current fold.
    private fun boundAttempt(frame: Int?): Int? {
        val record = if (frame != null) rootAttemptFrame[frame] else rootFramelessAttempt
        if (record == null) return null
        return if (record.first == rootBootGeneration) record.second else STALE_ATTEMPT
    }

    /// High-water mark of the error ledger the fold has already inspected (the observe sink).
    private var lastSeenErrorCount = 0

    /// Re-resolve `global.route` whenever `global.route.path` changes. Observing all of `$vars`
    /// is coarse but cheap (the resolve is guarded + idempotent), and it makes navigation a pure
    /// state write — no nav goes through a package.
    private fun observe() {
        cancellable?.cancel()   // a re-boot (retryRootPlan) must not leak the previous sink
        cancellable = DSX.state.sink {
            resolveIfPathChanged()
            // Frame settle reaches the ROOT-PLAN fold as STATE (`global.screen.ready`, written
            // by the lifecycle coordinator) — the kernel names no module and hooks no bus
            // (Article 1); after the winner settles, the fold drops every later flip itself.
            rootFold?.let { f ->
                // Root-attributed FAILURES first (`global.dsx.lastError` / `errorCount`):
                // checked BEFORE the settle plane because a failed web load also translates
                // into `screen.ready` — in a same-turn race the FAILURE must win or the dead
                // candidate would be crowned. Any other origin never touches the root.
                // NOT guarded by `f.active`: the mark must advance whenever the ledger grows, or
                // an error raised while the fold is between attempts is left UNCONSUMED and
                // re-read against the next candidate. `fail()` clears `live` BEFORE firing
                // `root.failed`, so that window is `!done && live < 0` — active is false there
                // while `root.live` is still true, which is exactly when a dying candidate's
                // teardown raises. `rootError` self-guards on `done`/`live`, so forwarding
                // unconditionally is safe and keeps consume-and-drop.
                val count = DSX.state.getPath("dsx.errorCount") as? Int ?: 0
                if (count > lastSeenErrorCount) {
                    lastSeenErrorCount = count
                    val e = DSX.state.getPath("dsx.lastError") as? Map<*, *>
                    if (e?.get("origin") == "root") {
                        // An attempt-BOUND failure (the surface stamped `data.attempt` from the
                        // kernel-owned `root.attempt`) is delivered only while that attempt is
                        // live; an unstamped one stays unbound and lands on the live attempt, as
                        // before. The kernel reads a value, never a module (root-plan.md §7.1).
                        val stamped = ((e["data"] as? Map<*, *>)?.get("attempt") as? Number)?.toInt()
                        f.rootError(e["code"] as? String ?: "error", "root", stamped)
                    }
                }
                if (f.active && DSX.state.getPath("screen.ready") == true) {
                    // FRAME-BOUND SETTLE: `screen.frame` is the identity of the report that
                    // produced this level (phase.json rule 5) — a native frame's id, or absent
                    // for a frameless one (the web relay names no frame). A frame THIS PLAN
                    // mounted resolves to its attempt; once the fold has moved on that index is
                    // stale and the signal is dropped. An unmapped/frameless report settles the
                    // live attempt, unchanged — a cold deep-link frame settling still proves the
                    // app interactive.
                    val reporting = frameIdOf(DSX.state.getPath("screen.frame"))
                    val bound = boundAttempt(reporting)
                    f.settle(bound)
                    if (f.winner != null) {
                        ScreenReadiness.suppressedDeadlineFrame = null
                        DSX.state.setPath("root.live", false)
                    } else if (bound != null) {
                        // REFUSED — the level belongs to a RETIRED candidate's frame. Retire the
                        // level with it, or the corpse's `true` stays standing: identity and level
                        // are separate keys and this sink runs INLINE on every write, so the very
                        // next report's `screen.frame` write would pair a FRESH frame with this
                        // dead `true` and crown a candidate that has not rendered a pixel (its own
                        // timeoutMs never applying). No write ORDER fixes that — frame-first pairs
                        // a new identity with a stale level, level-first pairs a new level with a
                        // stale identity — so the drop must not leave half a signal behind. Only
                        // a BOUND-but-stale frame retires it: an unmapped report already settled
                        // above, and `f.active` keeps an exhausted plan from fighting the level.
                        // The WHOLE triple, in the pinned order (identity → phase → level,
                        // phase.json rule 5): writing the level alone would leave `screen.phase`
                        // at "ready" and `screen.frame` naming the corpse, so markup reading
                        // `global.screen.ready` would flicker false against a phase of "ready" —
                        // and if the plan then exhausts, nothing republishes and that
                        // contradiction is permanent.
                        DSX.state.setPath("screen.frame", null)
                        DSX.state.setPath("screen.phase", "loading")
                        DSX.state.setPath("screen.ready", false)
                    }
                }
            }
        }
    }

    private fun resolveIfPathChanged() {
        // NEVER react mid-publish: apply() writes `nav` then `route`, and the bare-kernel state
        // sink runs INLINE (mainExecutor default), so this fires between the two writes — with
        // `lastResolvedPath` already advanced but `route.path` still stale — and a naive replace
        // here re-resolves (and, for a route-mounted native frame, RELEASES) the frame just
        // pushed. The observer is level-triggered (it compares state, not edges), so skipping
        // the in-publish invocations loses nothing: the next external write re-checks. (iOS
        // defers its sink to the next runloop turn, so its window never opens; the guard is
        // kept there too as the documented twin.)
        if (publishing) return
        if (stack.isEmpty()) return                                  // pre-boot: the seed owns the first frame, never the observer
        val path = (DSX.state.getPath("route.path") as? String) ?: "/"
        if (path == lastResolvedPath) return                         // ignore unrelated global writes
        // A MODULE-pushed native frame OWNS the screen — swallow the write (sync
        // lastResolvedPath so we don't re-fire); web navigation resumes once it's popped.
        // A TABLE-resolved native frame (`route: true`) is URL-addressed like any web frame —
        // a path write re-routes it.
        val top = stack.lastOrNull()
        if ((top?.get("native") as? Boolean) == true && (top["route"] as? Boolean) != true) {
            lastResolvedPath = path
            return
        }
        // An external path write navigates in place — REPLACE the top, preserving single-route
        // semantics. History is opt-in via route.push.
        replace(path)
    }

    // MARK: resolve (match the OTA table + capability gate + web fallback)

    /// Resolve a path to a route entry — match against `global.routes` with the capability gate
    /// (a route's `requires` must ALL be shipped), else the configured fallback. An unavailable
    /// match reports `route_unavailable` and falls through. A `guard` predicate (bounded JSE over
    /// `global.*`, fail-open, redirect depth-capped at 8) may redirect resolution.
    private fun resolved(path: String, depth: Int = 0): MutableMap<String, Any?> {
        val query = parseQuery(path)
        val routes = trustedRoutes(path)
        for (r in routes) {
            val pattern = r["path"] as? String ?: continue
            val params = DSXPathMatch.match(path, pattern) ?: continue        // named params → route.params.*
            val missing = stringList(r["requires"]).filter { !available(it) }
            if (missing.isNotEmpty()) {
                // Requested but unavailable in THIS binary → don't switch; report + fall through.
                broadcast("route_unavailable",
                          JSON.from(mapOf("path" to path, "missing" to missing, "reason" to "missing_capability")))
                continue
            }
            val g = r["guard"] as? String
            if (!g.isNullOrEmpty() && !truthy(JSE.eval(g, guardStore, null))) {
                val to = r["redirect"] as? String
                if (!to.isNullOrEmpty() && to != path && depth < 8) return resolved(to, depth + 1)
                continue                                                       // fail-open: no redirect ⇒ no match
            }
            // An UNCONDITIONAL redirect entry ({ "path": "/home", "redirect": "/" } — a PURE
            // redirect: no component, no guard, no view/src of its own) resolves through to its
            // target before matching completes — web resolveUrl parity (corpus-pinned:
            // Conformance/router/resolve.json). A guard-carrying entry keeps `redirect` as its
            // guard FALLBACK (handled above), and a view/src entry with a stray redirect stays
            // a renderable route (back-compat). Depth-capped like the guard form; at the cap it
            // simply doesn't match (fail-open).
            val uncond = r["redirect"] as? String
            if (!uncond.isNullOrEmpty() && r["component"] == null && r["guard"] == null &&
                r["view"] == null && r["src"] == null) {
                if (uncond != path && depth < 8) return resolved(uncond, depth + 1)
                continue
            }
            val route = LinkedHashMap<String, Any?>()
            route["path"] = path                       // keep the FULL path — query rides along + round-trips
            // A row with no `view` follows the BOOT WINNER — the root-plan candidate that
            // settled (root-plan.md; corpus case "route rows with no view follow the boot
            // winner"). Before a winner exists (cold resolve during boot) the plan's first
            // candidate stands in; the kernel names no surface either way.
            route["view"] = (r["view"] as? String)
                ?: rootFold?.winner?.view
                ?: AppManifest.entry.surfaces.firstOrNull()?.view
                ?: ""
            route["src"] = (r["src"] as? String) ?: ""
            route["params"] = params                   // named path segments → route.params.id
            route["query"] = query                     // parsed ?query string → route.query.ref
            (r["origin"] as? String)?.let { route["origin"] = it }
            // The UNIFIED grammar (the same keys the web renderer has always consumed):
            // `component` names the native screen this path mounts (materialize() builds it);
            // `meta` rides along — its `title` seeds the system bar for pushed frames.
            (r["component"] as? String)?.takeIf { it.isNotEmpty() }?.let { route["component"] = it }
            anyDict(r["meta"])?.takeIf { it.isNotEmpty() }?.let { route["meta"] = it }
            return route
        }
        // Nothing matched (or no table) → the CONFIGURED fallback (App.json `entry.fallback`).
        val fb = AppManifest.entry.fallback
        val route = linkedMapOf<String, Any?>(
            "path" to path, "view" to fb.view, "src" to fb.src,
            "params" to emptyMap<String, String>(), "query" to query)
        if (fb.origin.isNotEmpty()) route["origin"] = fb.origin
        return route
    }

    /// THE LOAD GATE for the remote route table (see the file header + Router.swift's full
    /// rationale). OFF ⇒ `global.routes` unchanged; ON ⇒ only the verified signed bytes at
    /// `global.routes_signed` are trusted — missing/unverified/unparsable ⇒ EMPTY table +
    /// a clear `route_unavailable` broadcast.
    private fun trustedRoutes(forPath: String): List<Map<String, Any?>> {
        if (!RemoteBundleGate.requiresVerification) {
            val published = dictArray(DSX.state.getPath("routes")) ?: emptyList()
            return if (published.isEmpty()) bundledTable else published      // a PUBLISHED table wins; bundled is the floor
        }
        // ON ⇒ trust ONLY the verified signed bytes, and derive the table from them.
        val signed = DSX.state.getPath("routes_signed") as? String
        if (signed != null && RemoteBundleGate.isVerified(manifestText = signed)) {
            val table = parseRouteTable(signed)
            if (table != null && table.isNotEmpty()) return table
        }
        // The BUNDLED table stays the floor under signing too: it is code-signed BINARY content,
        // not remote bytes — exactly as trusted as the bundled screens it names (the gate exists
        // for the REMOTE plane). An attacker can't downgrade INTO it — it's what shipped.
        if (bundledTable.isNotEmpty()) return bundledTable
        val hadSigned = (DSX.state.getPath("routes_signed") as? String) != null
        broadcast("route_unavailable",
                  JSON.from(mapOf("path" to forPath,
                                  "reason" to if (hadSigned) "signature_invalid" else "unverified_manifest")))
        return emptyList()
    }

    /// The BUNDLED route table — the app's own `routes.json` shipped in the binary
    /// (`AppManifest.bundledRoutesText`; the :app host installs an asset loader), parsed once
    /// with the same both-shapes grammar as the OTA bytes. The native OFFLINE FLOOR: with it,
    /// path routing — `component` mounts, `meta` bars, deep links — works with no network and
    /// no Routing package, matching the web build (which compiles this same file in). Swift
    /// caches type-statically; PER-INSTANCE lazy here so tests can vary the injected loader
    /// (one Router per process in the app — observable behavior identical). Empty ⇒ no floor.
    private val bundledTable: List<Map<String, Any?>> by lazy {
        AppManifest.bundledRoutesText?.let { parseRouteTable(it) } ?: emptyList()
    }

    /// A fresh stack entry for `path` — a resolved route stamped with a unique frame id (and,
    /// for a `component` route, its native mount + seeded bar — materialize()). `depth` is the
    /// frame's stack position (0 = root): pushed WEB frames (depth ≥ 1) claim the system bar,
    /// the root never does (the app's own web surface owns its chrome). `mount = false` (boot's
    /// seed) resolves WITHOUT mounting components — see materialize().
    private fun entry(path: String, depth: Int, mount: Boolean = true): MutableMap<String, Any?> =
        materialize(resolved(path), depth, mount)

    /// A fresh root frame built directly from the framework starter fallback. This deliberately
    /// bypasses route resolution only for that safe starter boot; client-authored entries and all
    /// push/replace/reset/path writes resolve the route table exactly as before (Swift parity).
    private fun fallbackEntry(path: String): MutableMap<String, Any?> {
        val fallback = AppManifest.entry.fallback
        val route = linkedMapOf<String, Any?>(
            "path" to path,
            "view" to fallback.view,
            "src" to fallback.src,
            "params" to emptyMap<String, String>(),
            "query" to parseQuery(path),
        )
        if (fallback.origin.isNotEmpty()) route["origin"] = fallback.origin
        return materialize(route, depth = 0, mount = false)
    }

    /// A fresh root frame for ONE root-plan candidate — the fold's mount. Bypasses route
    /// resolution exactly like fallbackEntry (the plan owns the root; the table owns
    /// navigation). `config` rides the route map verbatim as the surface's attributes —
    /// recognized keys (`src`, `origin`) land in their existing slots, everything else is
    /// component-owned.
    private fun candidateEntry(path: String, c: AppManifest.Entry.Surface): MutableMap<String, Any?> {
        val route = linkedMapOf<String, Any?>(
            "path" to path,
            "view" to c.view,
            "src" to ((c.config["src"] as? String) ?: ""),
            "params" to emptyMap<String, String>(),
            "query" to parseQuery(path),
        )
        (c.config["origin"] as? String)?.takeIf { it.isNotEmpty() }?.let { route["origin"] = it }
        for ((k, v) in c.config) if (k != "src" && k != "origin" && !route.containsKey(k)) route[k] = v
        return materialize(route, depth = 0, mount = false)
    }

    /// Give a RESOLVED route its frame identity — and its native mount + system bar
    /// (Router.swift materialize 1:1):
    ///   • a `component` route (the unified routes.json grammar the web renderer has always
    ///     consumed) mounts the NAMED component as a native frame: the kernel builds the
    ///     surface (global scope — table names are qualified), holds it exactly like a module
    ///     push, and seeds `vars` with the matched params + query (query wins on collision —
    ///     web parity). The frame is stamped `route: true` — URL-RESOLVABLE, unlike a module
    ///     push — so path writes and table refreshes may re-route it. Its bar seeds from the
    ///     component's own claim (chromeHint) with `meta.title` as the fallback. A route that
    ///     EXPLICITLY names a missing/unbuildable component resolves to compiled
    ///     DSXNativeUnavailable—never implicitly to DSXWebView. Routes without `component` keep
    ///     ordinary fallback semantics.
    ///   • a WEB route at PUSHED depth (≥ 1) claims the system bar: `meta.title` when the
    ///     table declares one, else a title derived from the path's last segment — a pushed
    ///     web path is never a bar-less trap. An EXPLICIT empty `meta.title` ("") opts the
    ///     route out. The ROOT frame (depth 0) never claims.
    /// `mount` gates the component branch: EXPLICIT NAVIGATION (push / replace / reset / a
    /// route.path write) mounts; boot's root seed passes false so the app's boot surface stays
    /// the App.json entry even when the table maps "/" to a component (Router.swift 1:1), and
    /// passive table refreshes never convert a live web frame (resolveCurrent).
    private fun materialize(route: MutableMap<String, Any?>, depth: Int, mount: Boolean = true): MutableMap<String, Any?> {
        val e = route
        frameSeq += 1
        val id = frameSeq
        e["id"] = id
        val meta = anyDict(route["meta"])
        val path = (route["path"] as? String) ?: "/"
        val comp = route["component"] as? String
        if (mount && !comp.isNullOrEmpty()) {
            val vars = LinkedHashMap<String, Any?>()
            (route["params"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String) vars[k] = v }
            (route["query"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String) vars[k] = v }   // query wins — web parity
            val registered = available(comp)
            val surface = if (registered) buildSurface(comp, null, vars.takeIf { it.isNotEmpty() }) else null
            if (surface != null) {
                StackSurface.pushedFrames[id] = surface
                (chromeHint(comp, null) ?: metaChrome(meta))?.let { chrome["$id"] = it }
                e["view"] = "__native"
                e["src"] = ""
                e["native"] = true
                e["route"] = true
                if (vars.isNotEmpty()) e["vars"] = vars
                return e
            }
            val reason = if (registered) "component_unbuildable" else "component_unavailable"
            kernelLog("[Router] route \"$path\" names component \"$comp\" — $reason; rendering native DSX status UI")
            broadcast("route_unavailable",
                      JSON.from(mapOf("path" to path, "component" to comp, "reason" to reason)))
            // A normal dynamic route-frame tag is still native DSX and needs no held surface.
            // It remains renderable even when the requested component's factory returned null.
            e.remove("component")
            e["requestedComponent"] = comp
            e["unavailableReason"] = reason
            e["view"] = nativeUnavailableView
            e["src"] = ""
        }
        if (depth >= 1) (metaChrome(meta) ?: derivedChrome(path, meta))?.let { chrome["$id"] = it }
        return e
    }

    /// Re-resolve the TOP on a routes-table refresh (the `sync` action). KEEPS the frame id when
    /// the mapping is unchanged; mints a new id only if the table remapped this path. Lower
    /// frames are left as-is. A MODULE-pushed native frame isn't URL-resolvable and is never
    /// touched; a TABLE-resolved native frame (`route: true`) IS — same component ⇒ the live
    /// screen stays (id + surface kept), remapped ⇒ swapped like any table change (the old
    /// surface released after the publish, like a pop).
    fun resolveCurrent() {
        val path = (stack.lastOrNull()?.get("path") as? String)
            ?: (DSX.state.getPath("route.path") as? String) ?: "/"
        val top = stack.lastOrNull() ?: run { stack = mutableListOf(entry(path, 0)); apply(); return }
        if ((top["native"] as? Boolean) == true) {
            if ((top["route"] as? Boolean) != true) return          // a module MOUNT owns its screen; leave it
            val re = resolved(path)
            if ((re["component"] as? String) == (top["component"] as? String)) return
            stack[stack.size - 1] = materialize(re, stack.size - 1)
            apply()
            releaseNative(listOf(top))
            return
        }
        // A WEB top on a table refresh keeps the OLD comparison — a PASSIVE refresh never
        // converts a live web frame to a native mount (only explicit navigation mounts);
        // the inert `component`/`meta` keys ride the frame dict, which readers ignore.
        val re = resolved(path)
        val same = listOf("view", "src", "origin").all { (re[it] as? String) == (top[it] as? String) }
        if (same) re["id"] = top["id"] else { frameSeq += 1; re["id"] = frameSeq }
        stack[stack.size - 1] = re
        apply()
    }

    /// The `reload` action — ask whoever owns the table to refetch (the OTA package hooks this).
    fun reload() {
        fire("route.refresh")
    }

    // MARK: navigation (the stack is state — push / pop / replace / reset)

    fun push(path: String) {
        stack.add(entry(path, stack.size))
        apply()
    }

    fun pop() {
        if (stack.size <= 1) return
        echoMemo = null
        val gone = listOf(stack.last())
        stack.removeAt(stack.size - 1)
        apply()
        releaseNative(gone)
    }

    fun replace(path: String) {
        echoMemo = null
        val gone = if (stack.isEmpty()) emptyList() else listOf(stack.last())
        if (stack.isEmpty()) stack = mutableListOf(entry(path, 0)) else stack[stack.size - 1] = entry(path, stack.size - 1)
        apply()
        releaseNative(gone)
    }

    fun reset(path: String) {
        echoMemo = null
        val gone = ArrayList(stack)
        stack = mutableListOf(entry(path, 0))
        apply()
        releaseNative(gone)
    }

    /// popTo — pop back to the DEEPEST frame whose path matches `path`: one state mutation, one
    /// host transition, instead of N chained pops (the React-Navigation `popTo` / Flutter
    /// `popUntil` / go_router-parity verb). Matching is CONCRETE and QUERY-INSENSITIVE ON BOTH
    /// SIDES — the frame's stored path and the target compare with their query strings stripped
    /// (frames store the full pushed path here; the web runtime stores it query-stripped, so
    /// stripping both sides is the only rule all three renderers can share) — never a
    /// route-table pattern. The rule is pinned by the SHARED corpus
    /// OpenSource/Conformance/router/popto.json (RouterTest runs it; the web dom test runs the
    /// SAME file; Router.swift is the reference). No match / already the top / empty path →
    /// no-op (fail-open, Article 7). Modals are NOT touched — `nav.modal` presentations survive
    /// stack verbs, exactly like pop/reset (RouterTest pins it).
    fun popTo(path: String) {
        val idx = deepestMatch(path)
        if (idx < 0) return
        truncate(toDepth = idx + 1)
    }

    /// popToRoot — clear back to the root frame (React Navigation's `popToTop`). At root → no-op.
    fun popToRoot() {
        truncate(toDepth = 1)
    }

    /// The deepest stack index whose frame path matches `path` (see popTo for the rule), -1 when
    /// nothing matches. Walks top-down so the nearest previous instance wins.
    private fun deepestMatch(path: String): Int {
        val want = path.substringBefore('?')
        if (want.isEmpty()) return -1
        for (i in stack.indices.reversed()) {
            val p = stack[i]["path"] as? String ?: continue
            if (p.substringBefore('?') == want) return i
        }
        return -1
    }

    /// The kernel host popped via back-swipe → truncate the live stack to `toDepth`
    /// (root … depth). Only ever a REDUCTION — every push originates in a verb — so it never grows.
    fun hostTruncate(toDepth: Int) = truncate(toDepth)

    /// Re-run the ROOT PLAN once — the boot diagnostic's Retry (root-plan.md §9). Clears the
    /// exhaustion state and folds the plan again from candidate 0; a second exhaustion simply
    /// republishes the diagnostic. Never invoked while a winner is live (§4.6 — the plan never
    /// re-runs after `root.ready`).
    fun retryRootPlan() {
        // Only from the EXHAUSTED state (the diagnostic's button) — never while a fold is
        // live (a double-tap must not race two concurrent folds over one stack).
        if (rootFold?.winner != null) return
        val exhausted = DSX.state.getPath("root.exhausted") as? List<*>
        if (exhausted.isNullOrEmpty()) return
        rootFold?.close()   // late timers/signals from the exhausted run are inert
        DSX.state.setPath("root.exhausted", null)
        boot()
    }

    /// The one truncation funnel (hostTruncate / popTo / popToRoot): slice, publish, release the
    /// popped tail's native surfaces. A no-op unless it strictly REDUCES depth (never below root).
    private fun truncate(toDepth: Int) {
        if (toDepth < 1 || toDepth >= stack.size) return
        echoMemo = null                   // a reduction re-arms the double-tap echo guard
        val gone = ArrayList(stack.subList(toDepth, stack.size))
        stack = ArrayList(stack.subList(0, toDepth))
        apply()
        releaseNative(gone)               // run onPop + free any held surfaces in the popped tail
    }

    // MARK: the double-tap echo guard (pushNative + presentModal — Router.swift 1:1)

    private var echoMemo: Pair<String, Long>? = null   // last NAMED push/present identity + when it landed

    /// True when a NAMED push/present with identity `key` is an ECHO of the one just before it
    /// (identical, inside 500ms). Two taps land faster than a push/present transition covers
    /// the screen, so one row tap can dispatch twice — pushing the same screen twice (a
    /// duplicate under Back) or stacking two copies of one sheet. An identical consecutive
    /// verb inside the window is that echo, not intent — dropped, logged by the caller. A
    /// non-echo arms the memo; every stack REDUCTION and modal removal clears it, so an
    /// intentional open → close → open replay is never eaten. UNNAMED frames (no component,
    /// no caller path — the corpus' pathless held-surface shape) bypass the guard at the call
    /// sites, and URL pushes (`route.push` — programmatic) are untouched.
    private fun isEcho(key: String): Boolean {
        val last = echoMemo
        if (last != null && last.first == key && System.currentTimeMillis() - last.second < 500) return true
        echoMemo = key to System.currentTimeMillis()
        return false
    }

    /// One stable identity for a named push/present: verb + component + caller path + the
    /// vars/attrs seeds (key-sorted). Both seeds participate so two same-component opens with
    /// DIFFERENT inputs both land — only a byte-identical repeat reads as a double-tap echo.
    private fun echoKey(verb: String, component: String?, path: String = "",
                        vars: Map<String, Any?>?, attrs: Map<String, Any?>?): String {
        fun digest(d: Map<String, Any?>?): String =
            if (d.isNullOrEmpty()) "" else d.keys.sorted().joinToString("&") { "$it=${d[it]}" }
        return "$verb:${component ?: ""}|$path|${digest(vars)}|${digest(attrs)}"
    }

    // MARK: system chrome (#1002 — the `chrome` action; spec rides global.nav.chrome by frame id)

    /// A screen claims the REAL navigation bar for its frame — navigation is state, so the
    /// spec rides `global.nav.chrome` keyed by frame id and is pruned with the stack (apply()).
    /// `show:"false"` releases the claim. `args` is the action payload (`{ title, large,
    /// show }`) — markup sends STRING values (the attribute wire shape), a JS caller naturally
    /// sends real booleans; both spellings are accepted on every runtime (the web facet always
    /// did), so `large: true` can never mean a small bar here.
    /// TARGETING (Router.swift 1:1): a claim names its OWN frame via the `__frame` framing key
    /// (the statement runner stamps every markup package call with the calling surface's
    /// frame id — StackStore.frameId). A re-fired `on:appear` from a resurfacing covered
    /// screen must never restyle whatever frame is top mid-transition. A stamped id that's
    /// not in the stack (a popped frame's late claim, a MODAL surface's NavBar) is DROPPED —
    /// modal chrome never restyles the app bar beneath it. No stamp → top-frame behavior.
    fun chrome(args: Map<String, Any?>) {
        val stamped = frameIdOf(args["__frame"])
        val frame = if (stamped == null) stack.lastOrNull()
                    else stack.firstOrNull { frameIdOf(it["id"]) == stamped }
        val id = frame?.get("id") ?: return
        applyChrome(id, args, frame["component"] as? String)
    }

    /// A frame id from a published/wire value — Int stays Int, a JSON round-trip's Double
    /// coerces (NavFrame.intId, RouterHost.swift). null for anything else.
    private fun frameIdOf(v: Any?): Int? = when (v) {
        is Int -> v
        is Double -> v.toInt()
        else -> null
    }

    private fun applyChrome(id: Any, args: Map<String, Any?>, component: String?) {
        val show = args["show"]
        if ((show as? String) == "false" || (show as? Boolean) == false) {
            chrome.remove("$id")
            if (component != null) chromeMemory.remove(component)
        } else {
            val large = args["large"]
            val spec = mapOf("title" to ((args["title"] as? String) ?: ""),
                             "large" to ((large as? String) == "true" || (large as? Boolean) == true))
            chrome["$id"] = spec
            // Remember the LIVE claim by component name — the next push of this component
            // seeds its bar from frame ONE (see pushNative), so even a dynamic title only
            // arrives late on the component's very first open (Router.swift chromeMemory 1:1).
            if (component != null) chromeMemory[component] = spec
        }
        apply()
    }

    // MARK: push-time chrome (the native-feel rule — the bar rides the push; Router.swift 1:1)

    private val chromeMemory: MutableMap<String, Map<String, Any?>> = HashMap()
    private val chromeGrace = HashSet<String>()

    /// Seam: the STATIC template hint — resolve a component's chrome claim from its registered
    /// template at push time (the iOS Router walks StackComponents for its own
    /// `dsx.module.route.chrome(` contract and evaluates the claiming child's usage attrs).
    /// The component registry lives in the :app layer on Android, so core exposes the seam;
    /// null (default) = live memory only, which still covers every reopen. Wire it where the
    /// registry lands (the RouterChromeHost wave).
    var chromeHintResolver: ((component: String, scope: String?) -> Map<String, Any?>?)? = null

    /// Seam: schedule a popped frame's chrome-spec drop AFTER the exit animation (the
    /// StackSurface.deferRemoval pattern — iOS hard-posts 0.6s). Default inline: a bare
    /// kernel shows no transitions, and RouterTest's immediate-prune assertions stay true;
    /// the render host wires a main-thread 0.6s post alongside deferRemoval.
    var deferChromePrune: (removal: () -> Unit) -> Unit = { it() }

    private fun chromeHint(component: String, scope: String?): Map<String, Any?>? =
        chromeMemory[component] ?: chromeHintResolver?.invoke(component, scope)

    // MARK: native frames (a module-pushed component surface — StackSurface.push)

    /// Push a module-owned surface as a NATIVE nav frame. The frame carries NO route-table
    /// resolution — it's marked `native`, and the host renders the held surface for it (looked
    /// up in `StackSurface.pushedFrames` by id). Grows history like `push`; a back-swipe /
    /// `route.pop` removes it and `releaseNative` runs the surface's onPop + frees it. The
    /// entry describes WHAT is on screen (component name + serializable `vars`) — testable
    /// without a host; extra keys are inert to the frame reader.
    fun pushNative(surface: Any, path: String, component: String? = null, vars: Map<String, Any?>? = null,
                   attrs: Map<String, Any?>? = null, scope: String? = null) {
        if ((!component.isNullOrEmpty() || path.isNotEmpty()) &&
            isEcho(echoKey("push", component, path, vars, attrs))) {
            kernelLog("[Router] pushNative(\"${component ?: path}\") dropped — identical to the push just before it (double-tap echo)")
            return
        }
        frameSeq += 1
        val id = frameSeq
        StackSurface.pushedFrames[id] = surface
        // PUSH-TIME CHROME SEED (chromeHint): the spec rides the SAME publish that adds the
        // frame — the destination renders its bar on frame one, native ordering. The live
        // on:appear claim still confirms, corrects, or releases (Router.swift 1:1).
        if (!component.isNullOrEmpty()) chromeHint(component, scope)?.let { chrome["$id"] = it }
        val p = if (path.isEmpty()) "/__native/$id" else path
        val frame = linkedMapOf<String, Any?>(
            "id" to id, "view" to "__native", "path" to p, "src" to "",
            "params" to emptyMap<String, Any?>(), "query" to emptyMap<String, Any?>(), "native" to true)
        if (!component.isNullOrEmpty()) frame["component"] = component
        if (!vars.isNullOrEmpty()) frame["vars"] = vars                 // LEGACY seed (documented)
        if (!attrs.isNullOrEmpty()) frame["attrs"] = attrs              // THE input contract (dsx.attribute.*)
        stack.add(frame)
        apply()
    }

    /// Release any NATIVE (held-surface) frames in `gone` — run each surface's onPop (the
    /// module's teardown) and free the held reference. Called AFTER the stack mutation +
    /// apply(), so the frame is already out of `nav.stack` before the surface is freed.
    /// A no-op for ordinary URL frames.
    private fun releaseNative(gone: List<Map<String, Any?>>) {
        for (f in gone) {
            if ((f["native"] as? Boolean) != true) continue
            (f["id"] as? Int)?.let { StackSurface.releasePushed(it) }
        }
    }

    // MARK: modals (a STATE-BACKED presented surface — the observable `global.nav.modal`)

    /// Present a module-owned surface as a MODAL: an entry appended to `global.nav.modal` that
    /// the kernel host renders — state, not a fire-and-forget present, so `dsx.resolve` can
    /// never claim "opened" while nothing is on screen. `mode`: `sheet` → a drawer; `cover` →
    /// full-screen; `overlay` → the state-backed overlay LAYER (no platform presentation, so it
    /// can never silently fail). An overlay carries `touch` — "passthrough" (default: only its
    /// DRAWN content is tappable, everything else reaches the screen beneath — the menu-bar-
    /// over-web shape) or "block" (the FULL overlay: every touch stops at the layer — the
    /// lock-screen shape). NORMALIZED AT THE RUNTIME so published state is the contract, pinned
    /// by OpenSource/Conformance/router/present.json: unknown `as` fails open to sheet, unknown
    /// touch to passthrough, chain entries never carry touch. PLANES (the host contract): the
    /// content stack renders under every overlay (presentation order), and the chain plane
    /// (sheet/cover) renders above every overlay — a drawer always covers a menu bar. The entry
    /// records the component tag + serializable `vars` (testable without a host); the surface is
    /// held by id in `StackSurface.modalFrames`, exactly like a pushed frame.
    fun presentModal(surface: Any, mode: String, component: String, vars: Map<String, Any?>?,
                     detents: List<String>?, touch: String? = null, attrs: Map<String, Any?>? = null) {
        if (component.isNotEmpty() &&
            isEcho(echoKey("present:$mode", component, vars = vars, attrs = attrs))) {
            kernelLog("[Router] presentModal(\"$component\") dropped — identical to the present just before it (double-tap echo)")
            return
        }
        frameSeq += 1
        val id = frameSeq
        StackSurface.modalFrames[id] = surface
        val kind = when (mode) { "cover", "overlay" -> mode; else -> "sheet" }
        val e = linkedMapOf<String, Any?>("id" to id, "as" to kind, "component" to component)
        if (kind == "overlay") e["touch"] = if (touch == "block") "block" else "passthrough"
        if (!vars.isNullOrEmpty()) e["vars"] = vars                     // LEGACY seed (documented)
        if (!attrs.isNullOrEmpty()) e["attrs"] = attrs                  // THE input contract (dsx.attribute.*)
        if (!detents.isNullOrEmpty()) e["detents"] = detents
        modal.add(e)
        apply()
    }

    /// updateComponent — LIVE attribute updates on an open frame/modal: the reactive half of
    /// the attribute contract. Merges `attrs` into the entry's published `attrs` (state stays
    /// the truth; present.json pins the merge) and the render host re-seeds the surface's
    /// `dsx.attribute` dict, so bindings recalc and `<attribute on:change>` fires exactly as
    /// if a hard-coding consumer changed the prop. Target matching = the dismiss rule
    /// (component tag or `as:` mode, deepest-last, modals first then stack frames); null →
    /// the top-most presented entry, else the top stack frame. Unmatched → documented no-op.
    override fun updateComponent(target: String?, attrs: Map<String, Any?>) {
        if (attrs.isEmpty()) return
        // REPLACE the entry (never mutate in place): the published state holds the old entry
        // reference, and the deep-equal write elision would swallow an in-place merge — the
        // same shallow-copy discipline apply() documents for the containers (NOTES).
        fun updated(e: Map<String, Any?>): Map<String, Any?> {
            val copy = LinkedHashMap(e)
            @Suppress("UNCHECKED_CAST")
            val merged = LinkedHashMap((e["attrs"] as? Map<String, Any?>) ?: emptyMap())
            merged.putAll(attrs)
            copy["attrs"] = merged
            return copy
        }
        val mIdx = if (target.isNullOrEmpty()) modal.size - 1
                   else modal.indexOfLast { (it["component"] as? String) == target || (it["as"] as? String) == target }
        if (mIdx >= 0) {
            modal[mIdx] = updated(modal[mIdx])
            apply()
            return
        }
        val sIdx = if (target.isNullOrEmpty()) stack.size - 1
                   else stack.indexOfLast { (it["component"] as? String) == target }
        if (sIdx >= 0) {
            stack[sIdx] = updated(stack[sIdx])
            apply()
        }
    }

    /// Dismiss a presented modal. Default (`target` null) pops the TOP of the presentation
    /// stack; a `target` matching a component tag or an `as:` mode removes that specific one.
    /// Dismiss-when-empty / unmatched-target is a documented no-op (never a crash).
    override fun dismissModal(target: String?) {
        if (modal.isEmpty()) return
        if (!target.isNullOrEmpty()) {
            val idx = modal.indexOfLast { (it["component"] as? String) == target || (it["as"] as? String) == target }
            if (idx < 0) return
            removeModal(idx)
        } else {
            removeModal(modal.size - 1)
        }
    }

    /// The kernel host reports an INTERACTIVE dismissal (swipe / tap-away) of the modal carrying
    /// `id`. Keyed by IDENTITY, not position, so the report is IDEMPOTENT — an id that's already
    /// gone is simply a no-op, never an over-pop of an unrelated modal. The modal twin of
    /// `hostTruncate`: `global.nav.modal` stays the single source of truth.
    fun hostDismissedModal(id: Int) {
        val idx = modal.indexOfFirst { (it["id"] as? Int) == id }
        if (idx < 0) return
        removeModal(idx)
    }

    /// Remove the modal at `idx` plus its presentation DESCENDANTS, honoring the topology the
    /// host renders: a CHAIN entry (sheet / cover) is the presentation parent of every LATER
    /// chain entry, so a child cannot outlive its parent. An OVERLAY is an independent,
    /// non-presenting layer: dismissing one removes just it, and a chain dismiss leaves later
    /// overlays alive. Each removed surface's onDismiss runs (parent-first) + it frees via
    /// `releaseModal`.
    private fun removeModal(idx: Int) {
        echoMemo = null                   // a modal removal re-arms the double-tap echo guard
        fun isOverlay(e: Map<String, Any?>): Boolean = (e["as"] as? String) == "overlay"
        val gone = ArrayList<Map<String, Any?>>()
        gone.add(modal[idx])
        if (!isOverlay(modal[idx]) && idx + 1 < modal.size) {
            gone.addAll(modal.subList(idx + 1, modal.size).filter { !isOverlay(it) })  // later chain entries = descendants
        }
        val goneIds = gone.mapNotNull { it["id"] as? Int }
        modal.removeAll { e -> (e["id"] as? Int)?.let { goneIds.contains(it) } ?: false }
        apply()
        for (id in goneIds) StackSurface.releaseModal(id)
    }

    // MARK: name-only entry (markup / web — the kernel builds the surface in the caller's scope)

    /// Build a surface for a component `tag`, scoped to `scope` (the caller's package; null →
    /// global / qualified). The kernel names nobody: the tag resolves against the component
    /// registry in that scope at render time. null for an empty / unparsable tag (fail-open —
    /// the verb no-ops). Construction goes through `surfaceFactory` (see SEAMS).
    private fun buildSurface(component: String, scope: String?, vars: Map<String, Any?>?): Any? {
        val tag = component.trim()
        if (tag.isEmpty()) return null
        val root = StackXML.parse("<$tag/>") ?: return null
        return surfaceFactory(root, scope, vars)
    }

    /// Push a component (by name, caller-scoped) as a native nav frame — the name-only twin of
    /// `StackSurface.push(from:)` behind the markup / web `dsx.component.push` verb.
    /// A failed surface build is LOGGED, never silent — the caller's resolve may already have
    /// fired, so this log is the only trace a screen never appeared.
    override fun pushComponent(name: String, scope: String?, path: String, vars: Map<String, Any?>?,
                               attrs: Map<String, Any?>?) {
        val surface = buildSurface(name, scope, vars) ?: run {
            kernelLog("[Router] pushComponent(\"$name\") no-op — empty or unparsable component tag; no frame was pushed")
            return
        }
        pushNative(surface, path = path, component = name, vars = vars, attrs = attrs, scope = scope)
    }

    /// Present a component (by name, caller-scoped) as a state-backed modal — the name-only twin
    /// of `presentModal` behind the markup / web `dsx.component.present` verb. Failed build →
    /// logged (see pushComponent).
    override fun presentComponent(name: String, scope: String?, mode: String, vars: Map<String, Any?>?,
                                  detents: List<String>?, touch: String?, attrs: Map<String, Any?>?) {
        val surface = buildSurface(name, scope, vars) ?: run {
            kernelLog("[Router] presentComponent(\"$name\") no-op — empty or unparsable component tag; nothing was presented")
            return
        }
        presentModal(surface, mode = mode, component = name, vars = vars, detents = detents,
                     touch = touch, attrs = attrs)
    }

    /// Publish the stack: `nav.stack` (frames) + `nav.canPop` / `nav.depth` (back affordances),
    /// and `route` = the top (so every `route.*` reader keeps working). `lastResolvedPath` is
    /// synced so the path observer doesn't re-fire on our own writes. Publishes COPIES (see NOTES).
    private fun apply() {
        val top = stack.lastOrNull()
            ?: mapOf("path" to "/", "view" to (rootFold?.winner?.view ?: AppManifest.entry.surfaces.firstOrNull()?.view ?: ""), "src" to "", "params" to emptyMap<String, Any?>())
        lastResolvedPath = top["path"] as? String
        // Chrome specs live and die with their frames — but a POPPED frame's spec gets a GRACE
        // through the exit animation (deferChromePrune; iOS hard-posts 0.6s): pruning at pop
        // start blanked the outgoing screen's bar while it was still sliding out. Frame ids are
        // monotonic (never reclaimed); the deferred drop re-runs apply(), so published state
        // still converges to pruned. The bare-kernel default runs inline (immediate prune —
        // exactly the previous behavior, and what RouterTest's prune assertions pin).
        val live = stack.mapNotNull { f -> f["id"]?.let { "$it" } }.toHashSet()
        for (key in chrome.keys.filter { it !in live && it !in chromeGrace }) {
            chromeGrace.add(key)
            deferChromePrune {
                chromeGrace.remove(key)
                if (chrome.remove(key) != null) apply()
            }
        }
        // The path observer stands down until BOTH writes land (see resolveIfPathChanged).
        // Saved/restored, not cleared: the inline chrome prune above re-enters apply(), and a
        // nested publish must never un-guard an outer one still writing.
        val wasPublishing = publishing
        publishing = true
        try {
            DSX.state.setPath("nav", mapOf("stack" to ArrayList(stack), "canPop" to (stack.size > 1),
                                           "depth" to stack.size, "modal" to ArrayList(modal),
                                           "chrome" to LinkedHashMap(chrome)))
            DSX.state.setPath("route", LinkedHashMap(top))
        } finally {
            publishing = wasPublishing
        }
    }
}

// MARK: - the route action table (Router.swift setup() twin — the bus-facing binder)

/// The `route` scheme's ACTION TABLE on the bus — the Kotlin twin of Router.swift's `setup()`
/// registrations. Swift's Router IS a Module; here the nav runtime stays a plain class (RouterTest
/// drives it headless), and this binder puts the SAME 1:1 table behind the scheme, so markup
/// `dsx.module.route.*` (NavBar's `claimChrome` → `route.chrome`), native `dsx.module` calls and
/// the web's `window.despia.route.*` all reach the runtime — and `hook("lifecycle.launch")` boots it exactly
/// like iOS. The host registers it at boot (`ModuleRegistry.shared.register { RouterActions() }`,
/// DespiaApp) — the SEAMS header's "action binder" wave, landed. (`window.despia.route.*`
/// additionally needs the Dom module's web bridge mounted — the table itself carries no web
/// surface.) `setup()` also rebinds the Router's two bus seams to this module's `dsx` (fire →
/// the hook bus, broadcast → the full native+web fan-out) and the launch hook rebinds them
/// again — idempotent — so a host that registered the binder BEFORE `Router().setup()` still
/// ends up bound; a bare kernel / a test that never registers the binder keeps the defaults.
/// Arg handling is byte-for-byte the Swift action layer: same defaults, and the strict whole-cast
/// semantics for `vars` / `detents` (a heterogeneous value reads as absent — see NOTES).
class RouterActions : Module() {
    override val scheme get() = "route"

    override fun setup() {
        bindSeams()

        dsx.action("push")    { c -> Router.shared?.push((c.args("path") as? String) ?: "/"); c.resolve() }
        dsx.action("pop")     { c -> Router.shared?.pop(); c.resolve() }
        dsx.action("popTo")   { c -> Router.shared?.popTo((c.args("path") as? String) ?: ""); c.resolve() }
        dsx.action("popToRoot") { c -> Router.shared?.popToRoot(); c.resolve() }
        dsx.action("replace") { c -> Router.shared?.replace((c.args("path") as? String) ?: "/"); c.resolve() }
        dsx.action("reset")   { c -> Router.shared?.reset((c.args("path") as? String) ?: "/"); c.resolve() }
        dsx.action("sync")    { c -> Router.shared?.resolveCurrent(); c.resolve() }
        dsx.action("reload")  { c -> Router.shared?.reload(); c.resolve() }

        dsx.action("pushComponent") { c ->
            Router.shared?.pushComponent((c.args("component") as? String) ?: "",
                                         scope = c.args("scope") as? String,
                                         path = (c.args("path") as? String) ?: "",
                                         vars = stringKeyed(c.args("vars")),
                                         attrs = stringKeyed(c.args("attrs")))
            c.resolve()
        }
        dsx.action("presentComponent") { c ->
            Router.shared?.presentComponent((c.args("component") as? String) ?: "",
                                            scope = c.args("scope") as? String,
                                            mode = (c.args("as") as? String) ?: "sheet",
                                            vars = stringKeyed(c.args("vars")),
                                            detents = strictStringList(c.args("detents")),
                                            touch = c.args("touch") as? String,
                                            attrs = stringKeyed(c.args("attrs")))
            c.resolve()
        }
        dsx.action("updateComponent") { c ->
            Router.shared?.updateComponent(c.args("target") as? String
                                               ?: c.args("component") as? String,
                                           attrs = stringKeyed(c.args("attrs")) ?: emptyMap())
            c.resolve()
        }
        dsx.action("dismiss") { c -> Router.shared?.dismissModal(c.args("target") as? String); c.resolve() }

        // SYSTEM CHROME — the claim targets the TOP frame; the runtime applies the Swift arg
        // defaults itself (`chrome(args:)` reads title/large/show off the wire shape).
        dsx.action("chrome") { c ->
            Router.shared?.chrome(mapOf("title" to c.args("title"), "large" to c.args("large"),
                                        "show" to c.args("show")))
            c.resolve()
        }

        // Boot AFTER the launch fan-out: the floor priority pins this hook to run LAST, so the
        // first resolution sees whatever the other launch hooks published synchronously —
        // notably the Routing module's cached OTA table. That is the ordering the bootloader's
        // retired direct `boot()` call (which ran after `fire("lifecycle.launch")` returned) always had;
        // without the floor, this hook registers first and would seed the root against an
        // EMPTY table, publish a fallback frame, and force a heal/remount when the table
        // lands a beat later. (Swift gets the same effect from registration order — the
        // Router instantiates alongside every other module in the bootstrap walk; the explicit
        // floor makes it deterministic here.) Re-binds the seams too (idempotent — see header).
        dsx.delegate.listen("lifecycle.launch", priority = Int.MIN_VALUE) { _ ->
            bindSeams()
            if (Router.shared == null) {
                kernelLog("[RouterActions] launch fired with no Router.shared — the nav runtime " +
                          "was never set up (host boot wiring must call Router().setup())")
            }
            Router.shared?.boot()
            null
        }
    }

    /// Idempotent seam rebinding (setup + the launch hook both call it — see the class header).
    private fun bindSeams() {
        Router.shared?.let { r ->
            r.fire = { name -> dsx.delegate.send(name, combine = ModuleRegistry.Combine.void) }
            r.broadcast = { event, data -> dsx.broadcast(event, data) }
        }
    }

    // The Swift strict-cast twin for a single string-keyed map (`as? [String: Any]` fails WHOLE
    // on a heterogeneous value — erased generics would otherwise wave anything through). The
    // list twin is the file-level `strictStringList` (shared with the Router companion).
    @Suppress("UNCHECKED_CAST")
    private fun stringKeyed(v: Any?): Map<String, Any?>? {
        val m = v as? Map<*, *> ?: return null
        if (!m.keys.all { it is String }) return null
        return m as Map<String, Any?>
    }
}

/// Swift `as? [String]` — whole-cast semantics (any non-String element fails the WHOLE cast to
/// null). Shared by the Router companion (`stringList`, which adds the `?? []` default) and
/// RouterActions (which needs the null-preserving form for `detents`).
internal fun strictStringList(v: Any?): List<String>? {
    val l = v as? List<*> ?: return null
    if (!l.all { it is String }) return null
    return l.filterIsInstance<String>()
}

// MARK: - StackSurface frame stores (Stack.swift §StackSurface statics — see the file header)

/// The held-surface stores the Router and the kernel host share (Swift: `static var` on
/// `class StackSurface`, Stack.swift). Declared here because Stack.kt rides the :render port;
/// this object becomes the class's companion when it lands. Surfaces are OPAQUE handles.
/// Pinned decisions:
///   • iOS removes a released surface from its map 0.6s AFTER the pop/dismiss transition starts
///     (the outgoing frame must render its real content the whole way out — Stack.swift
///     releasePushed's "white slash" rationale). Removal SCHEDULING is the `deferRemoval` seam:
///     a bare kernel has no transitions, so the DEFAULT removes inline (the old behavior,
///     byte-for-byte); the render host that animates dismissals wires the 0.6s main-thread
///     post (RouterModalHost).
///   • Teardown (`surface.onPop` / `surface.onModalDismiss`) is the settable `onPop`/`onDismiss`
///     seam and fires IMMEDIATELY on release (iOS order — stop playback before the way-out
///     render). Swift nils the surface's own callback to fire at most once; an opaque handle
///     can't carry one, so the pending-removal id set (`releasing`) gives the same
///     at-most-once guarantee while a deferred removal is in flight.
object StackSurface {
    val pushedFrames: MutableMap<Int, Any> = LinkedHashMap()
    val modalFrames: MutableMap<Int, Any> = LinkedHashMap()

    /// Seam: the popped surface's `onPop` teardown (stop playback, cancel timers) — :render wires it.
    var onPop: (id: Int, surface: Any) -> Unit = { _, _ -> }
    /// Seam: the dismissed surface's `onModalDismiss` — :render wires it.
    var onDismiss: (id: Int, surface: Any) -> Unit = { _, _ -> }

    /// Seam: schedule a released surface's MAP REMOVAL (teardown has already run). Default =
    /// inline (a bare kernel shows no exit transition, so nothing needs the handle); the render
    /// host swaps in a 0.6s main-thread post so the dismissing frame can render on the way out —
    /// Stack.swift's `DispatchQueue.main.asyncAfter(deadline: .now() + 0.6)`.
    var deferRemoval: (removal: () -> Unit) -> Unit = { it() }

    /// Ids whose teardown fired but whose deferred removal is still pending (see the header's
    /// at-most-once note). Internal so the kernel tests reset it alongside the frame maps.
    internal val releasing = HashSet<Int>()

    // MARK: the native-frame COVER seam (a module-presented full-screen surface)

    /// Host-installable presenter for a module's FULL-SCREEN NATIVE COVER — the AppLock lock
    /// screen / Store paywall / StudioEditor DAW shape: a module-built surface attached over
    /// the presenting screen, above every other surface, until the module dismisses it. Both
    /// handles are OPAQUE (the kernel names no android.* type): `host` is the presenting
    /// screen (an Activity), `view` the module-built surface (a ComposeView). An installed
    /// presenter attaches the view full-screen and returns an IDEMPOTENT dismiss closure —
    /// or null to DECLINE (nothing to attach onto), which sends the caller down its own path.
    /// Default NULL = not installed: `presentCover` answers null and each module keeps its
    /// hand-rolled content-frame attach (the pinned module-side default), so a bare kernel
    /// changes nothing — the deferRemoval seam's precedent.
    @Volatile
    var coverPresenter: ((host: Any, view: Any) -> (() -> Unit)?)? = null

    /// Present `view` full-screen over `host` through the installed cover presenter. Null when
    /// no presenter is installed (or it declined) — the caller falls back to its module-side
    /// attach. Modules call THIS, never the var, so install state stays a kernel concern.
    fun presentCover(host: Any, view: Any): (() -> Unit)? = coverPresenter?.invoke(host, view)

    /// Pop-time release for a pushed native frame: run onPop exactly once NOW, then drop the
    /// held reference via `deferRemoval` (inline by default; held past the exit transition when
    /// a render host wires the defer). Idempotent (an already-released id is a no-op).
    fun releasePushed(id: Int) {
        val surface = pushedFrames[id] ?: return
        if (!releasing.add(id)) return                       // teardown at most once per id
        onPop(id, surface)                                   // teardown NOW — before the way-out render
        deferRemoval { pushedFrames.remove(id); releasing.remove(id) }
    }

    /// Dismiss-time release for a presented modal (the Router calls this when the entry leaves
    /// `global.nav.modal`): run onDismiss exactly once NOW, then drop the held reference via
    /// `deferRemoval` (see `releasePushed`). Idempotent.
    fun releaseModal(id: Int) {
        val surface = modalFrames[id] ?: return
        if (!releasing.add(id)) return
        onDismiss(id, surface)
        deferRemoval { modalFrames.remove(id); releasing.remove(id) }
    }
}
