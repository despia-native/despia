@file:Suppress("UNCHECKED_CAST")

//
//  JseRunner.kt — the DSX statement runner (the LOGIC half; the expression half is Jse.kt).
//  Kotlin twin of Engine/Stack.swift §JSERunner (lines ~1581–3356) — same names, same
//  arguments, same observable behavior: the bounded statement interpreter (if / while / for /
//  for…of / switch / try-catch-finally / throw / break / continue / return), assignment +
//  compound ops (`x = e`, `x += e`, `i++`), the effect verbs (`fetch:` envelope, `remove:`,
//  `animate:`, `resolve:`, `error:`), keyed setTimeout / setInterval, the `.debounce` /
//  `.throttle` gate, the `await` continuations (fetch / fetch-effect / dsx.module / dsx.event /
//  crypto.subtle / Promise combinators), `run(action)` dispatch, and `<watch>` fire scheduling.
//
//  Pure JVM, android.*-free. Values ride Jse.kt's number/null model (Double numbers, NSNull
//  scope sentinel); state rides Jse.kt's StackStore + State.kt's setPath/DSX.state.
//
//  ── SEAMS (each settable; defaults are inert/inline so the pure-JVM runner is total) ──
//    • JSERunner.scheduler — ScheduledExecutorService behind DispatchQueue.main.asyncAfter
//      (keyed timers, debounce/throttle, intervals). Default: a lazy single daemon thread;
//      tests install a manual/virtual scheduler so time is deterministic.
//    • JSERunner.mainExecutor — DispatchQueue.main.async (timer fires + every async
//      completion hop). Default inline (the Events.kt / StackStorePublisher pattern).
//    • JSERunner.backgroundExecutor — DispatchQueue.global(qos:) (crypto work). Default inline.
//    • JSERunner.fetch — DSXRemoteCache.request/requestFull. Default: completes null inline
//      (→ the "network" error), so `fetch:` / `await fetch` settle without a network stack.
//    • JSERunner.withAnimation — SwiftUI's withAnimation. Default: run the body (no tween).
//    • JSERunner.moduleHandle — ModuleRegistry.shared.handle(url:params:includeInternal:) +
//      Bridge.Params.onTerminal. Default: false (→ "unavailable"; inside `try` that throws —
//      the universal feature-detection contract survives with no registry at all).
//    • JSERunner.router — Router.shared (dsx.component.push/present/dismiss). Default null
//      (Swift's Router.shared is optional too — a no-op, exactly iOS with no router mounted).
//    • JSERunner.socketFactory — JSESocket. Default: an inert handle (no connection); the
//      keyed replace/close bookkeeping still runs so markup stays total.
//    • JSERunner.cookieSet — DSXCookies.shared.set (`cookie.*` writes). Default no-op
//      (reads already ride JSE.cookieJar).
//    • runner.dsx — the owning call's Context (resolve/error/broadcast), as the narrow
//      JSERunnerDsx interface; the K2 Context implements it. Default null (no originating call).
//    • runner.webView — Swift's `weak var webView: UIView?`; an opaque inert handle here
//      (only ever passed through to the socket factory).
//    • JSETrace / JSERedact (iOS diagnostics) have no twin yet — their call sites are omitted.
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1 — bug-for-bug beats "obviously meant") ──
//  • STORE FIELDS SIDECAR: Swift adds the runner's ledgers (flowSignal, loopWork, timers,
//    actions, eventReplies, …) to StackStore itself; the Kotlin StackStore (Jse.kt) is the
//    evaluator-visible subset and stays untouched, so those members live in a WeakHashMap
//    sidecar exposed as `StackStore.<member>` extensions — byte-identical call sites
//    (`store.flowSignal`, `store.timers[key]`), the StackStorePublisher precedent.
//  • `x = e` in an action ALWAYS writes the store (never the block locals) — a local of the
//    same name shadows reads, so classic `for (let i = 0; …; i++)` spins to the loop budget
//    on iOS and here alike; store-var counters (`for (i = 0; …)`) are the working idiom.
//  • startOp's dsx.module slice starts at offset 12 — one PAST the 11-char "dsx.module."
//    prefix (Stack.swift:2476) — so a Promise-combinator dsx.module element loses its
//    scheme's first char and settles { ok:false, error:"unavailable" }. Parity-pinned quirk:
//    fix on iOS first, then mirror here. (The slice still carries the FULL dotted tail —
//    only the head's first char is eaten — so module-identity CHAINS deeper than
//    scheme.method pass through whole; the dispatch funnel folds them, ChainResolver.kt.)
//  • performFetch's `then=` / `catch=` run `run("do: <name>")` — dead since the legacy verb
//    aliases were removed (Stack.swift:3269/3276/3279): the statement parses as neither
//    assignment nor call and no-ops. Mirrored exactly (the envelope still settles).
//  • statusText derives from a standard reason-phrase table; iOS uses HTTPURLResponse
//    .localizedString (locale-dependent, descriptive — never asserted by fixtures).
//  • `remove: arr = value` matches rows via JSE.string on both sides. iOS compares "\(row[f])"
//    (NSNumber rows print integrally, agreeing; raw-Double rows print "2.0" and diverge on
//    iOS itself) — JSE.string is the stable cross-platform reading of the same intent.
//  • Double→Int conversions (splice indices, socket close codes) saturate via toInt() where
//    Swift's Int(_:) would trap on NaN/huge — the Jse.kt divergence rule (iOS crashes, so
//    there is no behavior to match).
//  • Timer/continuation bodies re-enter via runActionBody directly (not run()), so they draw
//    on the loop-budget ledger left by the last entry event — exactly the Swift flow.
//  • fireWatch is WatchView.fire (Stack.swift:3648): the <watch> budget + render-safe
//    dispatch, ported here because the Compose WatchView twin (K4) is markup, not logic.
//    Budget reset + fire both ride JSE.afterRender (DispatchQueue.main.async on iOS).
//

package despia.engine

import java.lang.ref.WeakReference
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

// MARK: - Environment (events + package dispatch)

/// Children passed into a component (`<Card> …children… </Card>`), rendered where
/// the component places `<slot/>`. Carries the CONSUMER's env + item so slotted content
/// binds in the caller's scope (React-style).
class SlotContent(
    val children: List<StackNode>,
    val env: JSERunner,
    val item: Map<String, Any?>?,
    val rowWrite: ((String, Any) -> Unit)? = null,   // row write-back, so inputs slotted into a
                                                     // component inside a list row still edit the row
)

/// One consumer-declared `on:<event>` handler, captured WITH the environment that declared it.
/// `dsx.event(name)` runs the matched handler in `env` — the DECLARING env, not the raiser's — so a
/// same-name relay resolves one level UP per hop and terminates at the native `ui.on`, instead of
/// re-triggering its own entry forever. Entries reference only ANCESTOR envs.
class OnHandler(
    val action: String,
    val env: JSERunner,
    /// Optional emitter-identity filter from a companion `from:<event>` attribute on the SAME
    /// binding — `on:select="…" from:select="action=checkout"`. The handler runs ONLY when the
    /// event's stamped `__from` matches. type is "action" | "component" | "" (bare = any type).
    val from: From? = null,
) {
    class From(val type: String, val name: String)

    /// True when this handler should run for `payload` — always, unless a `from:` filter is set
    /// and the payload's stamped `__from` doesn't match it. Total: a missing/`__from`-less payload
    /// fails a set filter.
    fun accepts(payload: Map<String, Any?>): Boolean {
        val f = from ?: return true
        val src = payload["__from"] as? Map<String, Any?> ?: return false
        val name = JSE.string(src["name"] ?: "")
        if (name != f.name) return false
        if (f.type.isEmpty()) return true                             // bare `from:x` — any source of that name
        return JSE.string(src["type"] ?: "") == f.type
    }

    companion object {
        /// Parse a `from:<event>` attribute value → (type, name). `action=checkout` /
        /// `component=Cart` → typed; a bare `checkout` → ("", "checkout"). Null for empty.
        fun parseFrom(raw: String): From? {
            val s = trimWhitespacesRunner(raw)
            if (s.isEmpty()) return null
            val eq = s.indexOf('=')
            if (eq >= 0) {
                val t = trimWhitespacesRunner(s.substring(0, eq))
                val n = trimWhitespacesRunner(s.substring(eq + 1))
                if (t == "action" || t == "component") return From(t, n)
            }
            return From("", s)
        }
    }
}

// MARK: - the runner's platform value types (Dispatch/Foundation twins + seam interfaces)

/// Dispatch's DispatchWorkItem, as far as the timer machinery uses it: a cancellable unit of
/// work. `cancel()` before the deadline and the scheduled fire is a no-op (the asyncAfter
/// contract — the only path the runner uses).
class DispatchWorkItem(private val block: () -> Unit) {
    @Volatile var isCancelled = false
        private set
    fun cancel() { isCancelled = true }
    fun perform() { if (!isCancelled) block() }
}

/// Swift: `StackStore.PendingEventReply` (nested; hoisted here — Kotlin can't extend the
/// Jse.kt class with a nested type). A suspended `await dsx.event` caller's continuation.
class PendingEventReply(
    val bind: String?,
    val rest: String,
    val locals: Map<String, Any?>,
    val args: Map<String, Any?>,
    val handlers: Map<String, String>,
)

/// The DSXRemoteCache seam's response (status + headers + raw body bytes).
class JSEFetchResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val data: ByteArray = ByteArray(0),
)

/// The DSXRemoteCache seam: ONE HTTP request as a completion-style op. The default stub
/// completes null inline (→ the "network" error envelope).
fun interface JSEFetch {
    fun request(url: String, method: String, headers: Map<String, String>, body: ByteArray?,
                completion: (JSEFetchResponse?) -> Unit)
}

/// Bridge.Params.onTerminal's outcome (the package's resolve/error), for the moduleHandle seam.
sealed class JSEModuleOutcome {
    class Resolve(val value: Any?) : JSEModuleOutcome()
    class Error(val code: String, val data: Any? = null) : JSEModuleOutcome()
}

/// Router.shared's presentation verbs (dsx.component.push/present/update/dismiss).
/// `attrs` is THE component input contract — the same attributes a hard-coded consumer would
/// write (`<Canvas id="42"/>`), seeded into the surface's reactive `dsx.attribute` dict;
/// `vars` stays as the LEGACY seed namespace (documented, no new callers). `touch` rides an
/// `as:"overlay"` present only — "passthrough" (default) or "block". The runtime normalizes;
/// see OpenSource/Conformance/router/present.json.
interface JSERunnerRouter {
    fun dismissModal(target: String?)
    fun presentComponent(name: String, scope: String?, mode: String, vars: Map<String, Any?>?,
                         detents: List<String>?, touch: String? = null,
                         attrs: Map<String, Any?>? = null)
    fun pushComponent(name: String, scope: String?, path: String, vars: Map<String, Any?>?,
                      attrs: Map<String, Any?>? = null)
    fun updateComponent(target: String?, attrs: Map<String, Any?>)
}

/// The owning call's Context, as far as the runner reaches it (resolve/error/broadcast).
/// The K2 Context implements this; a test installs a recorder.
interface JSERunnerDsx {
    fun resolve(data: JSON?)
    fun error(code: String, data: JSON?)
    fun broadcast(name: String, data: JSON)
}

/// JSESocket, as far as the statement grammar reaches it. The default factory's handle is
/// inert (no connection) — the keyed replace/close bookkeeping still runs.
interface JSESocketHandle {
    fun on(event: String, param: String, body: String, item: Map<String, Any?>?)
    fun send(value: Any?)
    fun close(code: Int = 1000, reason: String = "")
}

/// One mounted `<api>` declaration as seen by the statement runner. The renderer owns
/// lifecycle/networking; :core owns only the callable grammar.
interface StackApiHandle {
    fun refresh(completion: ((Map<String, Any?>?) -> Unit)? = null)
    fun send(args: Map<String, Any?>? = null, completion: ((Map<String, Any?>?) -> Unit)? = null)
    fun cancel()
}

private class InertSocket : JSESocketHandle {
    override fun on(event: String, param: String, body: String, item: Map<String, Any?>?) {}
    override fun send(value: Any?) {}
    override fun close(code: Int, reason: String) {}
}

// MARK: - the runner's StackStore members (Swift: fields ON StackStore; here the sidecar —
// see STORE FIELDS SIDECAR in the header. Same call sites: `store.flowSignal`, `store.timers`.)

internal class JSERunnerStoreFields {
    val handlers: MutableMap<String, (Map<String, Any?>) -> Unit> = HashMap()   // ui.on(event) { payload in … }
    val actions: MutableMap<String, StackFormula> = HashMap()                    // named actions: <action as="x">
    var actionDepth = 0                                                          // guards runaway action recursion
    var actionEvents: Map<String, String> = emptyMap()                           // the current action call's event callbacks
    val actionNameStack: MutableList<String> = ArrayList()                       // named <action>s executing (innermost = last)
    val timers: MutableMap<String, DispatchWorkItem> = HashMap()                 // keyed setTimeout/setInterval work items
    val anyHandlers: MutableList<(String, Map<String, Any?>) -> Unit> = ArrayList()   // ui.onAny wildcard taps
    var flowSignal: String? = null                                               // "break" | "continue" | "return" | "throw"
    var thrownValue: Any? = null                                                 // the `throw expr` payload
    var returnValue: Any? = null                                                 // RETURNING ACTIONS: the callee's `return <expr>` value (the action-call branch scopes it per call; an AWAITING `dsx.action` caller binds { ok:true, data } from it)
    var entryBody: String = ""                                                   // the entry/action body currently running — a throw keeps the THROWING body here (snippet in the uncaught report)
    var loopWork = 0                                                             // loop-iteration ledger per entry event
    var tryDepth = 0                                                             // > 0 while a `try` body runs
    val eventReplies: MutableMap<Int, PendingEventReply> = HashMap()             // await dsx.event token → continuation
    var nextEventReply = 0                                                       // monotonic token source
    val sockets: MutableMap<String, JSESocketHandle> = HashMap()                 // keyed WebSockets
    val apiHandles: MutableMap<String, StackApiHandle> = HashMap()               // `<api as>` handles
    var watchBudget = 0                                                          // <watch> loop backstop
    var watchResetScheduled = false                                              // one async reset per tick
}

private val runnerFieldsLock = Any()
private val runnerFieldsMap = WeakHashMap<StackStore, JSERunnerStoreFields>()

internal val StackStore.runnerFields: JSERunnerStoreFields
    get() = synchronized(runnerFieldsLock) { runnerFieldsMap.getOrPut(this) { JSERunnerStoreFields() } }

internal val StackStore.handlers get() = runnerFields.handlers
internal val StackStore.actions get() = runnerFields.actions

/// THE ONE PUBLIC SEAM into the actions sidecar — a renderer registers a named
/// `<action as="x" foo="…">body</action>` through this. Swift twin: raw()'s "action" case
/// writes `store.actions[name] = StackFormula(inputs:body:)` directly (Stack.swift:4034-4044)
/// because `actions` is a field ON StackStore there; here the sidecar is :core-internal, so
/// this function is that write's public face. `inputs` = the element's non-reserved attrs
/// (input name → expression, evaluated in the CALLER's scope when the action runs).
/// Idempotent — a same-name registration replaces, exactly the Swift re-render behavior.
fun StackStore.registerAction(name: String, inputs: Map<String, String>, body: String) {
    runnerFields.actions[name] = StackFormula(inputs, body)
}

/// The CLEAR half of that seam — drop every registered action, so the next document's head
/// starts from a FRESH map. A satellite runtime (the Wear runner, WearStore.mountHead) swaps
/// whole screens over ONE long-lived store, and without this it could only BLANK a departed
/// screen's names to empty bodies: a stale `dsx.action.x()` then silently no-opped instead of
/// answering `unavailable` the way the watch runtime's fresh map does. Registration order is
/// unchanged (head hoist re-registers everything it declares), and an app-side StackStore is
/// per-document anyway, so nothing on the phone path calls this.
fun StackStore.clearActions() {
    runnerFields.actions.clear()
}

/// Claim a mounted `<api as="name">` handle before its first auto-fetch starts.
/// First declaration wins (the head-hoist law); a duplicate returns null and never mounts.
fun StackStore.claimApiHandle(name: String, handle: StackApiHandle): AnyCancellable? {
    val fields = runnerFields
    val accepted = synchronized(fields) {
        if (fields.apiHandles.containsKey(name)) false
        else {
            fields.apiHandles[name] = handle
            true
        }
    }
    if (!accepted) return null
    return AnyCancellable {
        synchronized(fields) {
            if (fields.apiHandles[name] === handle) fields.apiHandles.remove(name)
        }
    }
}

/// Backward-compatible registration spelling for renderer/tests that know names are unique.
/// A duplicate receives an inert cancellable; the original remains the owner.
fun StackStore.registerApiHandle(name: String, handle: StackApiHandle): AnyCancellable =
    claimApiHandle(name, handle) ?: AnyCancellable {}

private fun StackStore.apiHandle(name: String): StackApiHandle? {
    val fields = runnerFields
    return synchronized(fields) { fields.apiHandles[name] }
}

/// The head seam for a `<functions>`/`<script>` block — routes on the `global` attribute
/// (PRESENCE is the switch; the canonical spelling is `global="true"` — strict-XML parsers
/// reject the bare form): a global block registers into the app-wide GLOBAL FUNCTION
/// LIBRARY (js-core.md "Shared logic" — ONE table shared by every surface, last write
/// wins, no scope capture), a plain block stays surface-local exactly as before. The
/// renderer's head dispatch calls this instead of naming the tables itself. Swift twin:
/// StackHead.register + raw()'s "script","functions" case (Stack.swift); web twin: the
/// compiler's head.globalScripts → JSE.registerGlobalFunctions in @despia/dom / @despia/server.
/// Corpus: OpenSource/Conformance/functions (FunctionConformanceTest here).
fun StackStore.registerHeadFunctions(attrs: Map<String, String>, body: String) {
    if (attrs.containsKey("global")) JSE.registerGlobalFunctions(body)
    else JSE.registerFunctions(body, this)
}

/// The SECOND public seam — the screen-swap teardown (the W3 promise: navigate away and
/// the runtime cancels a screen's effects; Swift twin: WatchRuntime.sync →
/// effects.clearAllTimers on every layout change). Cancels + drops this store's keyed
/// timers, closes + drops its sockets, and clears the ui.on/onAny handler ledgers — a
/// surface that RE-mounts a screen head over a SHARED store calls this beside its
/// declaration reset (the wear WearStore.mountHead; a per-surface phone store simply
/// dies with its surface). Values and declarations are untouched: this clears only the
/// runner's EFFECT ledgers.
fun StackStore.clearRunnerLedgers() {
    val f = runnerFields
    for ((_, work) in f.timers) work.cancel()
    f.timers.clear()
    for ((_, socket) in f.sockets) socket.close()
    f.sockets.clear()
    for ((_, api) in f.apiHandles) api.cancel()
    f.apiHandles.clear()
    f.handlers.clear()
    f.anyHandlers.clear()
}
internal var StackStore.actionDepth
    get() = runnerFields.actionDepth
    set(v) { runnerFields.actionDepth = v }
internal var StackStore.actionEvents
    get() = runnerFields.actionEvents
    set(v) { runnerFields.actionEvents = v }
internal val StackStore.actionNameStack get() = runnerFields.actionNameStack
internal val StackStore.timers get() = runnerFields.timers
internal val StackStore.anyHandlers get() = runnerFields.anyHandlers
internal var StackStore.flowSignal
    get() = runnerFields.flowSignal
    set(v) { runnerFields.flowSignal = v }
internal var StackStore.thrownValue
    get() = runnerFields.thrownValue
    set(v) { runnerFields.thrownValue = v }
internal var StackStore.returnValue
    get() = runnerFields.returnValue
    set(v) { runnerFields.returnValue = v }
internal var StackStore.entryBody
    get() = runnerFields.entryBody
    set(v) { runnerFields.entryBody = v }
internal var StackStore.loopWork
    get() = runnerFields.loopWork
    set(v) { runnerFields.loopWork = v }
internal var StackStore.tryDepth
    get() = runnerFields.tryDepth
    set(v) { runnerFields.tryDepth = v }
internal val StackStore.eventReplies get() = runnerFields.eventReplies
internal var StackStore.nextEventReply
    get() = runnerFields.nextEventReply
    set(v) { runnerFields.nextEventReply = v }
internal val StackStore.sockets get() = runnerFields.sockets
internal var StackStore.watchBudget
    get() = runnerFields.watchBudget
    set(v) { runnerFields.watchBudget = v }
internal var StackStore.watchResetScheduled
    get() = runnerFields.watchResetScheduled
    set(v) { runnerFields.watchResetScheduled = v }

// MARK: - JSECore's runner-facing hooks. On iOS these are `static` members of Stack.swift's
// JSECore (mutatingMethods / canMutate / mutate / resyncURL / aborted / applyHeaders /
// bodyData); here the implementations live in Globals.kt (JSECoreGlobals) and these
// extensions keep the exact Swift call shape (`JSECore.canMutate(...)`) so the runner's
// dispatch never drifts. (Swift's `inout` mutate/resync → returned copies, applied here.)

internal val JSECore.mutatingMethods: Set<String> get() = JSECoreGlobals.mutatingMethods

internal fun JSECore.canMutate(m: String, v: Any?): Boolean = JSECoreGlobals.canMutate(m, v)

internal fun JSECore.mutate(m: String, v: Any?, args: List<Any?>): Any? = JSECoreGlobals.mutate(m, v, args)

internal fun JSECore.resyncURL(d: MutableMap<String, Any?>) {
    val out = JSECoreGlobals.resyncURL(d)
    d.clear(); d.putAll(out)
}

internal fun JSECore.aborted(id: String): Boolean = JSECoreGlobals.aborted(id)

internal fun JSECore.applyHeaders(v: Any?, headers: MutableMap<String, String>) =
    JSECoreGlobals.applyHeaders(v, headers)

internal fun JSECore.bodyData(v: Any?, headers: MutableMap<String, String>): ByteArray? =
    JSECoreGlobals.bodyData(v, headers)

// MARK: - JSERunner

/// JSERunner — the LOGIC half: the action / statement runner (the expression half is `JSE`).
/// Runs JSE statements (assignment · if · const/let · array methods · await fetch ·
/// dsx.event / dsx.action / dsx.module calls) for on:* / <action> bodies.
/// (Swift JSERunner is a struct — value copies captured by continuations share the store class
/// reference, the identity that matters. This class is that shared-store identity directly;
/// locals/scopes are copied at every capture point exactly where Swift's value semantics do.)
class JSERunner(
    val store: StackStore,
    var webView: Any? = null,               // Swift: weak var webView: UIView? — inert seam here
    var scope: String? = null,              // rendering package (component resolution)
    var onHandlers: MutableMap<String, OnHandler> = HashMap(),   // consumer's on:<event> → handler + its DECLARING env
    var slot: SlotContent? = null,          // children handed to the current component
    var dsx: JSERunnerDsx? = null,          // the owning call's dsx (event/resolve/error)
    /// True only during the throwaway pass that measures a sheet's `.content` detent.
    var measuring: Boolean = false,
    /// Component-expansion depth, to stop a self-referencing component recursing forever.
    var depth: Int = 0,
) {

    companion object {
        // ── seams (see the header) ─────────────────────────────────────────────────────────
        private var schedulerBacking: ScheduledExecutorService? = null
        /** DispatchQueue.main.asyncAfter — the keyed-timer clock. Settable; tests install a
         *  virtual scheduler. Default: one lazy daemon thread. */
        var scheduler: ScheduledExecutorService
            get() = synchronized(runnerFieldsLock) {
                schedulerBacking ?: Executors.newSingleThreadScheduledExecutor { r ->
                    Thread(r, "dsx-timers").apply { isDaemon = true }
                }.also { schedulerBacking = it }
            }
            set(v) = synchronized(runnerFieldsLock) { schedulerBacking = v }
        /** DispatchQueue.main.async — timer fires + async completion hops. Default inline. */
        @Volatile var mainExecutor: Executor = Executor { it.run() }
        /** DispatchQueue.global(qos:) — the crypto work queue. Default inline. */
        @Volatile var backgroundExecutor: Executor = Executor { it.run() }
        /** DSXRemoteCache — the HTTP seam. Default: null inline (→ "network"). */
        @Volatile var fetch: JSEFetch = JSEFetch { _, _, _, _, completion -> completion(null) }
        /** SwiftUI withAnimation — the `animate:` wrapper. Default: run the body. */
        @Volatile var withAnimation: (body: () -> Unit) -> Unit = { it() }
        /** ModuleRegistry.shared.handle(url:params:includeInternal:) — package dispatch.
         *  Returns false when the scheme was never registered. Default: false (unavailable). */
        @Volatile var moduleHandle: (url: String, args: Map<String, Any?>, onTerminal: (JSEModuleOutcome) -> Unit) -> Boolean =
            { _, _, _ -> false }
        /** Router.shared — dsx.component.push/present/dismiss. Default null (no router → no-op). */
        @Volatile var router: JSERunnerRouter? = null
        /** JSESocket — `new WebSocket(…)`. Default: an inert handle. */
        @Volatile var socketFactory: (url: String, key: String, runner: JSERunner) -> JSESocketHandle =
            { _, _, _ -> InertSocket() }
        /** DSXCookies.shared.set — `dsx.cookie.name = "…"` writes. Default no-op. */
        @Volatile var cookieSet: (name: String, value: String) -> Unit = { _, _ -> }

        /// Total loop-iteration budget per entry event, shared by every loop in the action.
        const val loopCap = 100_000

        /// Read the `.debounce` / `.throttle` modifier (ms) for an `on:<event>` binding from an
        /// attr bag — `on:tap.debounce="300"`. Non-numeric / absent → null (no gating).
        fun gateMs(attrs: Map<String, String>, event: String, kind: String): Double? =
            attrs["on:$event.$kind"]?.let { swiftDouble(trimWhitespacesRunner(it)) }

        /// Bridge a DSX event onto the in-process native bus (`DSXEvents`), so ANY package can
        /// consume it with `dsx.events.on(scheme) { … }`. A namespaced name (`player:seeked`)
        /// maps to scheme `player`, event `seeked`; a bare name uses `source` else "dsx".
        fun publishNative(name: String, payload: Map<String, Any?>, source: String? = null) {
            val i = name.indexOf(':')
            if (i >= 0) DSXEvents().publish(name.substring(0, i), name.substring(i + 1), payload)
            else DSXEvents().publish(source ?: "dsx", name, payload)
        }

        /// Stamp the emitter's identity onto an event payload as `__from = { type, name }`. A
        /// nil/empty name leaves the payload untouched; never overwrites an inner emit's stamp.
        fun stampFrom(payload: Map<String, Any?>, type: String, name: String?): Map<String, Any?> {
            if (name.isNullOrEmpty() || payload["__from"] != null) return payload
            val out = LinkedHashMap(payload)
            out["__from"] = mapOf("type" to type, "name" to name)
            return out
        }

        /// Split an arrow handler's source into (param, body) — `e => { … }` / `() => expr`.
        fun parseArrow(raw: String): Pair<String, String> {
            val s = trimWhitespacesRunner(raw)
            val arrow = s.indexOf("=>")
            if (arrow < 0) return "e" to s
            var param = trimWhitespacesRunner(s.substring(0, arrow))
            param = trimWhitespacesRunner(param.trim { it == '(' || it == ')' || it == ' ' })
            var body = trimWhitespacesRunner(s.substring(arrow + 2))
            if (body.startsWith("{") && body.endsWith("}")) body = body.substring(1, body.length - 1)
            return (if (param.isEmpty()) "e" else param) to body
        }

        /// Strip JS comments from an action body — the shared JSE preprocessor pass
        /// (quote-, template- AND regex-literal-aware, `://` URL guard), so a
        /// `replace(/\//g, '-')` statement is never half-eaten as a comment. One
        /// implementation: JSE.stripComments (syntax wave 1); this forwarder keeps
        /// every existing call site source-compatible.
        fun stripJSComments(s: String): String = JSE.stripComments(s)

        /// Statement sugar: `i++` / `i--` / `++i` / `--i` → `i = i ± 1`, and compound
        /// assignment `x += e` (also `-=` `*=` `/=` `%=` `**=`) → `x = x op (e)`.
        /// Statement-level only; quote-/bracket-aware (backtick templates and escape
        /// pairs stay opaque).
        fun jsSugar(s: String): String {
            val t = trimWhitespacesRunner(s)
            if (t.endsWith("++") || t.endsWith("--")) {
                val name = trimWhitespacesRunner(t.dropLast(2))
                if (name.isNotEmpty() && name.all { it.isLetter() || it.isDigit() || it == '_' || it == '.' }) {
                    return "$name = $name ${if (t.endsWith("++")) "+" else "-"} 1"
                }
            }
            // prefix `++i` / `--i` — the same statement rewrite as the postfix form (wave 3)
            if (t.startsWith("++") || t.startsWith("--")) {
                val name = trimWhitespacesRunner(t.drop(2))
                if (name.isNotEmpty() && name.all { it.isLetter() || it.isDigit() || it == '_' || it == '.' }) {
                    return "$name = $name ${if (t.startsWith("++")) "+" else "-"} 1"
                }
            }
            val chars = t.toCharArray()
            var i = 0
            var q: Char? = null
            var depth = 0
            while (i + 1 < chars.size) {
                val ch = chars[i]
                if (q != null) {
                    if (ch == '\\' && i + 1 < chars.size) { i += 2; continue }   // escape pair stays opaque
                    if (ch == q) q = null
                    i += 1; continue
                }
                if (ch == '\'' || ch == '"' || ch == '`') { q = ch; i += 1; continue }
                if (ch == '(' || ch == '[' || ch == '{') depth += 1
                if (ch == ')' || ch == ']' || ch == '}') depth -= 1
                // logical assigns `x ??= e` / `x &&= e` / `x ||= e` — pair + '='
                if (depth == 0 && ch in "?&|" && i + 2 < chars.size && chars[i + 1] == ch && chars[i + 2] == '=') {
                    val key = trimWhitespacesRunner(String(chars, 0, i))
                    val expr = trimWhitespacesRunner(String(chars, i + 3, chars.size - i - 3))
                    if (key.isNotEmpty() && expr.isNotEmpty() && !key.contains("(") && !key.contains(" ")) {
                        return "$key = $key $ch$ch ($expr)"
                    }
                    return s
                }
                // `x **= e` — the 2-char op form, checked before the 1-char set
                if (depth == 0 && ch == '*' && i + 2 < chars.size && chars[i + 1] == '*' && chars[i + 2] == '=') {
                    val key = trimWhitespacesRunner(String(chars, 0, i))
                    val expr = trimWhitespacesRunner(String(chars, i + 3, chars.size - i - 3))
                    if (key.isNotEmpty() && expr.isNotEmpty() && !key.contains("(") && !key.contains(" ")) {
                        return "$key = $key ** ($expr)"
                    }
                    return s
                }
                if (depth == 0 && ch in "+-*/%" && chars[i + 1] == '=' && (i + 2 >= chars.size || chars[i + 2] != '=')) {
                    val key = trimWhitespacesRunner(String(chars, 0, i))
                    val expr = trimWhitespacesRunner(String(chars, i + 2, chars.size - i - 2))
                    if (key.isNotEmpty() && expr.isNotEmpty() && !key.contains("(") && !key.contains(" ")) {
                        return "$key = $key $ch ($expr)"
                    }
                    return s
                }
                i += 1
            }
            return s
        }

        /// Split `key = expr` on the assignment `=` (not `==`/`!=`/`<=`/`>=`, so RHS comparisons
        /// survive).
        fun splitOnAssign(s: String): Pair<String, String>? {
            val chars = s.toCharArray()
            var i = 0
            while (i < chars.size) {
                if (chars[i] == '=') {
                    val next = if (i + 1 < chars.size) chars[i + 1] else ' '
                    val prev = if (i > 0) chars[i - 1] else ' '
                    if (next == '=') { i += 2; continue }
                    if (prev != '!' && prev != '<' && prev != '>' && prev != '=') {
                        return trimWhitespacesRunner(String(chars, 0, i)) to
                            trimWhitespacesRunner(String(chars, i + 1, chars.size - i - 1))
                    }
                }
                i += 1
            }
            return null
        }

        /// Split a trailing numeric index off a path: `todos.2` → ("todos", 2); else (path, 0).
        fun splitTrailingIndex(s: String): Pair<String, Int> {
            val dot = s.lastIndexOf('.')
            if (dot < 0) return s to 0
            val idx = s.substring(dot + 1).toIntOrNull() ?: return s to 0
            return s.substring(0, dot) to idx
        }

        /// Quote-aware top-level split (action sequences: `a; b; c`) — backtick templates
        /// stay opaque too (escape pairs honored, like splitStatements).
        fun splitTopLevel(s: String, sep: Char): List<String> {
            val parts = ArrayList<String>()
            val cur = StringBuilder()
            var q: Char? = null
            var esc = false
            for (c in s) {
                if (q != null) { cur.append(c); if (esc) esc = false else if (c == '\\') esc = true else if (c == q) q = null }
                else if (c == '\'' || c == '"' || c == '`') { q = c; cur.append(c) }
                else if (c == sep) { parts.add(cur.toString()); cur.setLength(0) }
                else cur.append(c)
            }
            parts.add(cur.toString())
            return parts
        }

        /// Quote-aware split into statements on `;` AND newlines (backslash pairs and
        /// `` ` `` template spans stay opaque, so a multiline template never splits).
        fun splitStatements(s: String): List<String> {
            val parts = ArrayList<String>()
            val cur = StringBuilder()
            var q: Char? = null
            var esc = false
            for (c in s) {
                if (q != null) { cur.append(c); if (esc) esc = false else if (c == '\\') esc = true else if (c == q) q = null }
                else if (c == '\'' || c == '"' || c == '`') { q = c; cur.append(c) }
                else if (c == ';' || c == '\n') { parts.add(cur.toString()); cur.setLength(0) }
                else cur.append(c)
            }
            parts.add(cur.toString())
            return parts
        }

        /// JS array methods recognized as statements (`arr.push(x)` etc.) → the array verbs.
        val arrayMethods: Set<String> = setOf("push", "pop", "shift", "unshift", "splice", "sort")

        /// Quote- AND bracket-aware split on top-level commas.
        fun splitArgs(s: String): List<String> {
            val parts = ArrayList<String>()
            val cur = StringBuilder()
            var depth = 0
            var q: Char? = null
            for (c in s) {
                if (q != null) { cur.append(c); if (c == q) q = null }
                else if (c == '\'' || c == '"') { q = c; cur.append(c) }
                else if (c == '(' || c == '[' || c == '{') { depth += 1; cur.append(c) }
                else if (c == ')' || c == ']' || c == '}') { depth -= 1; cur.append(c) }
                else if (c == ',' && depth == 0) { parts.add(cur.toString()); cur.setLength(0) }
                else cur.append(c)
            }
            parts.add(cur.toString())
            return parts
        }

        /// Parse an action's handler object — `{ success: () => { … }, error: () => expr }` —
        /// into eventName → handler-body string.
        fun parseHandlers(s: String): Map<String, String> {
            val t = trimWhitespacesRunner(s)
            if (!t.startsWith("{") || !t.endsWith("}")) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (entry in splitArgs(t.substring(1, t.length - 1))) {
                val colon = entry.indexOf(':')
                if (colon < 0) continue
                val key = trimWhitespacesRunner(entry.substring(0, colon))
                var rhs = trimWhitespacesRunner(entry.substring(colon + 1))
                val arrow = rhs.indexOf("=>")
                if (arrow >= 0) rhs = trimWhitespacesRunner(rhs.substring(arrow + 2))
                if (rhs.startsWith("{") && rhs.endsWith("}")) rhs = rhs.substring(1, rhs.length - 1)
                if (key.isNotEmpty()) out[key] = rhs
            }
            return out
        }

        /// Normalize a call target to the internal scheme-host URL form (scheme + method + ?args),
        /// accepting the dot-API form (`scheme.method`, `scheme.method?args`, `scheme.method(a=b)`).
        /// A target already containing `"://"` is returned unchanged (legacy URL form).
        /// The split is FIRST-DOT = the arriving HEAD only (the alias plane); everything after
        /// it — including deeper dotted chains (`watch.health.heartRate` → `watch://health.heartRate`)
        /// and dotted group paths — rides in the action slot UNCUT. Identity is NOT decided
        /// here: the dispatch funnel folds chain segments out of the action path against the
        /// registry's identity set (ChainResolver — the chains corpus law).
        fun normalizeCall(raw: String): String {
            var s = trimWhitespacesRunner(raw)
            if (s.contains("://")) return s
            // method(a=b, c=d) → method?a=b&c=d   (dot-API call args)
            val lp = s.indexOf('(')
            if (lp >= 0 && s.endsWith(")")) {
                val head = s.substring(0, lp)
                val inner = s.substring(lp + 1, s.length - 1)
                val q = inner.split(",").map { arg ->
                    val eq = arg.indexOf('=')
                    if (eq >= 0) trimWhitespacesRunner(arg.substring(0, eq)) + "=" + trimWhitespacesRunner(arg.substring(eq + 1))
                    else trimWhitespacesRunner(arg)
                }.filter { it.isNotEmpty() }.joinToString("&")
                s = if (q.isEmpty()) head else "$head?$q"
            }
            // scheme.method[?args] → scheme + "://" + method[?args]
            val dot = s.indexOf('.')
            if (dot >= 0) {
                val head = s.substring(0, dot)
                if (head.isNotEmpty() && !head.contains("/") && !head.contains("?")) {
                    s = head + "://" + s.substring(dot + 1)
                }
            }
            return s
        }

        /// DispatchQueue.main.asyncAfter(deadline: .now() + ms/1000, execute: work) — the one
        /// scheduling funnel: the deadline rides the scheduler seam, the fire hops to main.
        private fun asyncAfter(ms: Double, work: DispatchWorkItem) {
            val delay = if (ms.isFinite()) maxOf(0.0, ms) else 0.0
            scheduler.schedule({ mainExecutor.execute { work.perform() } }, delay.toLong(), TimeUnit.MILLISECONDS)
        }
    }

    /// Run an `on:` action string — a JSE action body: `;`/newline-separated statements. State
    /// writes `x = e` (incl. `global.*` / `route.*` → DSXState), arrays `arr.push(x)` / `.pop()`,
    /// package calls `dsx.module.scheme.method({…})`, named actions `dsx.action.name()`, and the
    /// event primitive `dsx.event('name', {…})`.
    ///
    /// The only `verb:` forms that remain are EFFECT PRIMITIVES with no JSE-expression form:
    ///   "fetch: …" · "remove: arr where …" · "animate: key = expr" · "resolve: ?args" · "error: code?args"
    fun run(action: String, item: Map<String, Any?>?, args: Map<String, Any?> = emptyMap()) {
        val a = trimWhitespacesRunner(stripJSComments(action))
        // A fresh entry event gets the full bounded-execution ledgers: the loop budget and any
        // stray flow signal (an uncaught throw / a break that unwound to the top) reset here.
        if (store.actionDepth == 0) { store.loopWork = 0; store.flowSignal = null; store.thrownValue = null; store.returnValue = null; store.tryDepth = 0 }
        // Uncaught-throw context (reportUncaughtThrow's `snippet`): the body now entering.
        // Restored on a clean exit (run() re-enters for nested handlers via emitEventUp);
        // a throw skips the restore — like the flow signal — so the report attributes the
        // body that actually threw.
        val savedBody = store.entryBody
        store.entryBody = a
        // Anything past a single bare verb routes through the brace-JS interpreter.
        if (a.contains(";") || a.contains("\n") || a.contains("{") ||
            a.startsWith("if ") || a.startsWith("if(") || a.startsWith("const ") || a.startsWith("let ") ||
            a.startsWith("while ") || a.startsWith("while(") || a.startsWith("for ") || a.startsWith("for(") ||
            a.startsWith("switch ") || a.startsWith("switch(") || a.startsWith("try ")
        ) {
            runActionBody(a, item, args)
            if (store.flowSignal != "throw") store.entryBody = savedBody
            reportEntryUncaught()
            return
        }
        runVerb(a, item, args)
        if (store.flowSignal != "throw") store.entryBody = savedBody
        reportEntryUncaught()   // a bare action name is an entry too (`on:tap="doWork"`)
    }

    /// An uncaught `throw` that unwound the whole entry used to vanish as one log line —
    /// now it reports through the ambient fan-out with origin "uncaught" (errors corpus):
    /// ledger, module.error, page channel + dsx mirror, reactive keys. Control flow is
    /// already unwound; recording changes nothing. Runs on BOTH entry exits (the brace-JS
    /// body and the bare-verb form) at depth 0 only — a nested action's throw propagates
    /// to its caller and reports once, at the top.
    private fun reportEntryUncaught() {
        if (store.actionDepth != 0) return
        if (store.flowSignal == "throw") reportUncaughtThrow(store.thrownValue)
        store.flowSignal = null; store.thrownValue = null
    }

    /// Derive the canonical error fields from an uncaught thrown value (corpus-pinned): a
    /// dict with a string `code` keeps its code/message/recoverable/data; a codeless dict
    /// with a string `message` (a JSE `new Error("…")`, the browser-parity throw) keeps the
    /// message and rides whole as data; any other dict rides as data; anything else records
    /// code "uncaught" with the JSE string coercion as message. Source = the surface's
    /// owning scheme, "app" unscoped. RUNTIME ERROR CONTEXT: the data additionally carries
    /// `snippet` — the first 120 chars of the body that threw (store.entryBody) — so a
    /// ledger entry says WHAT threw (dict data gains the key unless the author set one;
    /// scalar data rides untouched; corpus expects stay green — subset-matched).
    private fun reportUncaughtThrow(value: Any?) {
        var code = "uncaught"
        var message: String? = null
        var recoverable = false
        var data: Any? = null
        val dict = value as? Map<String, Any?>
        val dictCode = dict?.get("code") as? String
        val dictMessage = dict?.get("message") as? String
        if (dict != null && !dictCode.isNullOrEmpty()) {
            code = dictCode
            message = dict["message"]?.takeIf { it != NSNull }?.let { JSE.string(it) }
            recoverable = JSE.truthy(dict["recoverable"])
            data = dict["data"]
        } else if (dict != null && !dictMessage.isNullOrEmpty()) {
            message = dictMessage
            data = dict
        } else if (dict != null) {
            data = dict
        } else {
            message = JSE.string(value ?: "")
        }
        val snippet = store.entryBody.take(120)
        val dataDict = data as? Map<String, Any?>
        data = when {
            dataDict != null -> if (dataDict.containsKey("snippet")) dataDict else dataDict + ("snippet" to snippet)
            data == null || data == NSNull -> mapOf<String, Any?>("snippet" to snippet)
            else -> data
        }
        reportAmbientError(scheme = (scope ?: "").ifEmpty { "app" }, code = code,
                           message = message, recoverable = recoverable, data = data,
                           origin = "uncaught")
    }

    /// Run an `on:<event>` action with optional declarative DEBOUNCE / THROTTLE:
    ///   • debounce(ms) — coalesce a burst: cancel the pending run and reschedule `ms` ahead.
    ///   • throttle(ms) — rate-limit: run the FIRST call immediately, then drop until `ms` passed.
    /// Both lean on the SAME keyed timer machinery as `setTimeout(…, key)` (`store.timers`).
    /// No modifier ⇒ a plain immediate `run`. `gateKey` distinguishes bindings.
    fun runGated(action: String, item: Map<String, Any?>?, args: Map<String, Any?> = emptyMap(),
                 debounceMs: Double?, throttleMs: Double?, gateKey: String) {
        if (debounceMs != null && debounceMs > 0) {
            val key = "__debounce:$gateKey:$action"
            val capItem = item?.let { HashMap(it) }                   // Swift value-copies the dict at capture
            val capArgs = args
            val weakStore = WeakReference(store)
            val work = DispatchWorkItem {
                val s = weakStore.get() ?: return@DispatchWorkItem
                if (s.timers[key] == null) return@DispatchWorkItem                // cancelled / surface gone
                s.timers.remove(key)
                run(action, capItem, capArgs)
            }
            store.timers[key]?.cancel(); store.timers[key] = work                 // same key → drop the pending run
            asyncAfter(debounceMs, work)
            return
        }
        if (throttleMs != null && throttleMs > 0) {
            val key = "__throttle:$gateKey:$action"
            if (store.timers[key] != null) return                                 // inside the window → drop
            run(action, item, args)                                               // leading edge fires now
            val weakStore = WeakReference(store)
            val close = DispatchWorkItem { weakStore.get()?.timers?.remove(key) }
            store.timers[key] = close                                             // window OPEN until it expires
            asyncAfter(throttleMs, close)
            return
        }
        run(action, item, args)
    }

    /// A SINGLE non-JSE EFFECT verb — the few primitives with no JSE-expression form — else hand
    /// to the JSE statement runner. (The legacy `verb:` ALIAS verbs were REMOVED.)
    private fun runVerb(a: String, item: Map<String, Any?>?, args: Map<String, Any?>) {
        if (a.startsWith("fetch:")) {                  // reactive {loading,data,error} envelope
            performFetch(a.drop(6), item)
        } else if (a.startsWith("remove:")) {          // filter-delete
            performRemove(a.drop(7), item)
        } else if (a.startsWith("animate:")) {         // withAnimation { … } wrapper
            JSERunner.withAnimation { assign(a.drop(8), item) }
        } else if (a.startsWith("resolve:")) {         // resolve the originating call — OR reply to an awaiting `dsx.event`
            val (head, data) = payload(a.drop(8), item)
            val token = replyToken(item, args)
            val pend = if (token != null) store.eventReplies.remove(token) else null
            if (pend != null) {
                resumeAwaitEvent(pend, data?.foundationValue ?: (if (head.isEmpty()) NSNull else coerce(head)))
            } else {
                dsx?.resolve(data)                     // else terminal success for the originating call
            }
        } else if (a.startsWith("error:")) {           // error the originating call — OR reject an awaiting `dsx.event`
            val (code, data) = payload(a.drop(6), item)
            val token = replyToken(item, args)
            val pend = if (token != null) store.eventReplies.remove(token) else null
            if (pend != null) {
                resumeAwaitEvent(pend, NSNull)         // a rejected request settles the awaiter falsy
            } else {
                dsx?.error(if (code.isEmpty()) "error" else code, data)
            }
        } else if (bareActionName.matches(a) && store.actions[a] != null) {
            // a bare registered-action name IS an invocation — `on:tap="copyDemo"` is the
            // author form (no parens). Runs the declared <action> with the entry's payload
            // as its args (the web runner resolves the same way). A no-op today for any
            // bare word that isn't an action, so this only ADDS the sugar.
            runJSStatement("$a()", item, args)
        } else {
            runJSStatement(a, item, args)              // JSE: x = e · arr.push(x) · dsx.module.s.m() · name()
        }
    }

    private val bareActionName = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    /// JS-syntax statements (no `verb:` prefix), mapped onto the same operations:
    ///   `x = expr` → set (store) · array verbs · `pkg.method(a=b)` → call dispatch · `name()` → a named <action>
    private fun runJSStatement(rawA: String, item: Map<String, Any?>?, args: Map<String, Any?>) {
        val a = jsSugar(rawA)   // `i++` / `x += e` → their `x = x op (e)` form
        // DESTRUCTURING ASSIGNMENT `[a, b] = [b, a]` (syntax-005) — the declaration-less
        // pattern write. Only the binder differs from a `const`: `write` routes each name
        // as an ordinary assignment (the store-always contract), so the statement writes
        // wherever `a = …` would have. RHS evaluates ONCE before any binding.
        if (a.startsWith("[")) {
            val eq = topLevelAssignIndex(a)
            if (eq > 0) {
                val v = JSE.eval(trimWhitespacesRunner(a.substring(eq + 1)), store, item)
                JSE.destructureBind(trimWhitespacesRunner(a.substring(0, eq)), v, store, item ?: emptyMap()) { n, value ->
                    write(n, value ?: NSNull)
                }
                return
            }
        }
        // indexed assignment — `name[expr] = rhs` (one index level): evaluate the index,
        // route the write through the dotted path (`arr.0` / `o.key`), same as `set:` paths
        if (runIndexedAssign(a, item)) return
        // assignment — `path = expr` (dotted path LHS, not a call/index)
        val assignSplit = splitOnAssign(a)
        if (assignSplit != null && assignSplit.first.isNotEmpty() &&
            !assignSplit.first.contains("(") && !assignSplit.first.contains("[")
        ) {
            val (lhs, rhs) = assignSplit
            // `ws.onmessage = e => { … }` — a socket HANDLER registration, not a state write.
            for (ev in listOf("onopen", "onmessage", "onerror", "onclose")) {
                if (!lhs.endsWith(".$ev")) continue
                val receiver = lhs.dropLast(ev.length + 1)
                val h = JSE.eval(receiver, store, item) as? Map<String, Any?>
                val skey = h?.get("__socket") as? String
                if (skey != null) {
                    val (param, body) = parseArrow(rhs)
                    store.sockets[skey]?.on(ev.drop(2), param, body, item)
                    return
                }
            }
            // `dsx.variable.ws = new WebSocket(…)` — the state-stored form of the const binding.
            val trimmedRHS = trimWhitespacesRunner(rhs)
            if (trimmedRHS.startsWith("new WebSocket(") && trimmedRHS.endsWith(")")) {
                val argStr = trimmedRHS.substring("new WebSocket(".length, trimmedRHS.length - 1)
                write(lhs, openWebSocket(argStr, item ?: emptyMap()))
                return
            }
            write(lhs, JSE.eval(rhs, store, item) ?: "")
            return
        }
        val lp = a.indexOf('(')
        if (lp < 0 || !a.endsWith(")")) return
        var callee = trimWhitespacesRunner(a.substring(0, lp))
        if (callee.startsWith("dsx.action.")) callee = callee.drop(11)   // dsx.action.name() → name()
        val argStr = a.substring(lp + 1, a.length - 1)
        if (callee.startsWith("dsx.module.")) {
            // Explicit package namespace: dsx.module.scheme.method({ … }) — FORCES dispatch.
            // The dotted callee rides through WHOLE (never a two-segment split): a chain
            // deeper than scheme.method (`watch.health.heartRate`) keeps its full tail, and
            // the registry funnel folds chain segments out of it (ChainResolver — the chains
            // corpus law). This parser only strips the marker.
            dispatch(callee.drop("dsx.module.".length) + "(" + argStr + ")", item)
            return
        }
        if (callee.startsWith("dsx.component.")) {
            // The markup presentation sugar — push / present / update / dismiss, routed via the
            // router seam. `attrs` is the component input contract (the hard-coded-markup twin).
            val verb = callee.drop("dsx.component.".length)
            if (verb != "push" && verb != "present" && verb != "dismiss" && verb != "update") {
                kernelLog("[Stack] dsx.component.$verb — unknown verb (markup has push / present / update / dismiss); ignored")
                return
            }
            val parts = splitArgs(argStr)
            if (verb == "dismiss") {
                val t = parts.firstOrNull()?.let { JSE.string(JSE.eval(it, store, item)) }
                JSERunner.router?.dismissModal(if (t.isNullOrEmpty()) null else t)
                return
            }
            val name = JSE.string(JSE.eval(parts.firstOrNull() ?: "", store, item))
            val opts = (if (parts.size > 1) JSE.eval(parts[1], store, item) else null) as? Map<String, Any?> ?: emptyMap()
            val vars = opts["vars"] as? Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val attrs = opts["attrs"] as? Map<String, Any?>
            if (verb == "update") {
                JSERunner.router?.updateComponent(if (name.isEmpty()) null else name, attrs ?: emptyMap())
                return
            }
            if (name.isEmpty()) return
            if (verb == "present") {
                JSERunner.router?.presentComponent(name, scope, (opts["as"] as? String) ?: "sheet",
                    vars, opts["detents"] as? List<String>, touch = opts["touch"] as? String, attrs = attrs)
            } else {   // push
                JSERunner.router?.pushComponent(name, scope, (opts["path"] as? String) ?: "", vars, attrs = attrs)
            }
            return
        }
        if (callee == "dsx.error") {
            // The AMBIENT error hat in markup (error-system.md §3.4) — a markup action never
            // holds a call to settle, so this is always the emission form: ledger +
            // module.error + page channel (+ dsx mirror) + global.dsx.* keys. NEVER unwinds
            // control flow — it is not a throw, it records; the next statement still runs.
            // Source = the surface's owning package scheme, "app" when unscoped.
            val parts = splitArgs(argStr)
            val code = JSE.string(JSE.eval(parts.firstOrNull() ?: "", store, item)).ifEmpty { "error" }
            val opts = (if (parts.size > 1) JSE.eval(parts[1], store, item) else null) as? Map<String, Any?> ?: emptyMap()
            reportAmbientError(
                scheme = (scope ?: "").ifEmpty { "app" },
                code = code,
                message = opts["message"] as? String,
                recoverable = JSE.truthy(opts["recoverable"]),
                data = opts["data"])
            return
        }
        if (callee == "dsx.log") {
            // The unified console primitive (logs corpus): console.log-shaped variadic args,
            // house formatting (JSE coercions + canonical JSON + credential masking), recorded
            // in the log ring attributed to the surface's owning scheme + one kernelLog mirror
            // line (logcat / the armed diagnostics drawer). Records, never unwinds, never throws.
            val parts = splitArgs(argStr)
            val values = parts.map { JSE.eval(it, store, item) }
            reportLog(scheme = (scope ?: "").ifEmpty { "app" }, level = "log",
                      message = formatLogArgs(values))
            return
        }
        if (callee == "dsx.screen.settled") {
            // "This screen has settled" — the native readiness REPORT (screen-lifecycle.md). A
            // kernel verb like dsx.log / dsx.error: zero-arg, records, never unwinds. Past tense
            // and only ever in CALL position, so it can never be confused with the read-only
            // reactive PROPERTIES `dsx.screen.ready` (Bool) / `dsx.screen.phase` (String) that
            // live in the same namespace. Off a nav frame (`frameId` null — a mounted overlay, a
            // bare surface) it is a silent no-op; on an `auto` screen it simply settles it a beat
            // early (corpus lifecycle/readiness.json). Swift twin: Stack.swift's dsx-statement arm.
            ScreenReadiness.settled(store.frameId)
            return
        }
        if (callee.startsWith("console.") && JSECore.handles(callee)) {
            // Statement-position console.* routes to the JSE globals sink (JSEConsole + the
            // unified log ring) exactly like expression position and the web runner — it
            // used to fall through to the legacy package dispatch below, where scheme
            // "console" answered not_loaded (caught by the logs corpus).
            JSECore.call(callee, splitArgs(argStr).map { JSE.eval(it, store, item) })
            return
        }
        if (callee == "dsx.event" || callee == "dsx.send" || callee == "dsx.broadcast") {
            // Author event primitive: dsx.event(name, {…}) sends an event UP to the consumer's
            // on:<name> (and to native subscribers) — the payload becomes dsx.this in the handler.
            val parts = splitArgs(argStr)
            val name = JSE.string(JSE.eval(parts.firstOrNull() ?: "", store, item))
            val rawPay = (if (parts.size > 1) JSE.eval(parts[1], store, item) else null) as? Map<String, Any?> ?: emptyMap()
            val pay = stampFrom(rawPay, "action", store.actionNameStack.lastOrNull())
            when (callee) {
                "dsx.send" -> store.handlers[name]?.invoke(pay)                  // → native ui.on handler
                "dsx.broadcast" -> dsx?.broadcast(name, JSON(pay))               // → cross-package bus (+ web)
                else -> emitEventUp(name, pay, item)                             // dsx.event → UP to the consumer's on:<name>
            }
            store.anyHandlers.forEach { it(name, pay) }                          // ui.onAny wildcard taps
            return
        }
        if (callee == "setTimeout") {
            // setTimeout(() => { … }, ms[, key]) — defer an action body. An optional string `key`
            // coalesces: scheduling another timer with the same key cancels the pending one.
            val parts = splitArgs(argStr)
            val fnArg = parts.firstOrNull() ?: return
            var body = trimWhitespacesRunner(fnArg)
            val arrow = body.indexOf("=>")
            if (arrow >= 0) body = trimWhitespacesRunner(body.substring(arrow + 2))
            if (body.startsWith("{") && body.endsWith("}")) body = body.substring(1, body.length - 1)
            val ms = if (parts.size > 1) (JSE.number(JSE.eval(parts[1], store, item)) ?: 0.0) else 0.0
            val key = if (parts.size > 2) JSE.string(JSE.eval(parts[2], store, item)) else ""
            val capItem = item?.let { HashMap(it) }                   // Swift value-copies the dict at capture
            val capArgs = args
            val capBody = body
            val work = DispatchWorkItem {
                if (key.isNotEmpty()) store.timers.remove(key)
                runActionBody(capBody, capItem, capArgs)
            }
            if (key.isNotEmpty()) { store.timers[key]?.cancel(); store.timers[key] = work }
            asyncAfter(maxOf(0.0, ms), work)
            return
        }
        if (callee == "setInterval") {
            // setInterval(() => { … }, ms[, key]) — a REPEATING timer, keyed like setTimeout.
            // Min period 250ms — an interval can't busy-spin the main thread.
            val parts = splitArgs(argStr)
            val fnArg = parts.firstOrNull() ?: return
            var body = trimWhitespacesRunner(fnArg)
            val arrow = body.indexOf("=>")
            if (arrow >= 0) body = trimWhitespacesRunner(body.substring(arrow + 2))
            if (body.startsWith("{") && body.endsWith("}")) body = body.substring(1, body.length - 1)
            val ms = maxOf(250.0, if (parts.size > 1) (JSE.number(JSE.eval(parts[1], store, item)) ?: 1000.0) else 1000.0)
            val key = if (parts.size > 2) JSE.string(JSE.eval(parts[2], store, item)) else UUID.randomUUID().toString()
            val capItem = item?.let { HashMap(it) }                   // Swift value-copies the dict at capture
            val capArgs = args
            val capBody = body
            val weakStore = WeakReference(store)
            fun schedule() {
                val work = DispatchWorkItem {
                    val s = weakStore.get() ?: return@DispatchWorkItem
                    if (s.timers[key] == null) return@DispatchWorkItem            // cleared / surface gone → stop
                    runActionBody(capBody, capItem, capArgs)
                    if (s.timers[key] != null) schedule()                         // re-arm unless the body cleared it
                }
                store.timers[key]?.cancel(); store.timers[key] = work
                asyncAfter(ms, work)
            }
            schedule()
            return
        }
        if (callee == "clearInterval" || callee == "clearTimeout") {
            // clearInterval(key) / clearTimeout(key) — cancel a keyed timer.
            val key = JSE.string(JSE.eval(argStr, store, item))
            if (key.isNotEmpty()) { store.timers[key]?.cancel(); store.timers.remove(key) }
            return
        }
        val dot = callee.lastIndexOf('.')
        if (dot >= 0) {
            val receiver = callee.substring(0, dot)
            val method = callee.substring(dot + 1)
            // Declared `<api>` handles: orders.refresh() / orders.send({...}) /
            // orders.cancel(). Claim only a registered handle + one of its three verbs,
            // so ordinary dotted calls retain their existing dispatch semantics.
            if (method == "refresh" || method == "send" || method == "cancel") {
                val api = store.apiHandle(receiver)
                if (api != null) {
                    when (method) {
                        "refresh" -> api.refresh()
                        "cancel" -> api.cancel()
                        else -> {
                            val raw = splitArgs(argStr).firstOrNull()
                            val body = raw?.takeIf { trimWhitespacesRunner(it).isNotEmpty() }
                                ?.let { JSE.eval(it, store, item) as? Map<String, Any?> }
                            api.send(body)
                        }
                    }
                    return
                }
            }
            // `ws.send(…)` / `ws.close([code, reason])` — effects on the keyed native socket.
            if (method == "send" || method == "close") {
                val h = JSE.eval(receiver, store, item) as? Map<String, Any?>
                val skey = h?.get("__socket") as? String
                if (skey != null) {
                    val parts = splitArgs(argStr).map { trimWhitespacesRunner(it) }.filter { it.isNotEmpty() }
                    if (method == "send") {
                        store.sockets[skey]?.send(parts.firstOrNull()?.let { JSE.eval(it, store, item) })
                    } else {
                        val code = parts.firstOrNull()?.let { JSE.number(JSE.eval(it, store, item)) }?.toInt() ?: 1000
                        val reason = if (parts.size > 1) JSE.string(JSE.eval(parts[1], store, item)) else ""
                        store.sockets[skey]?.close(code, reason)
                        store.sockets.remove(skey)
                    }
                    return
                }
            }
            // JS core object mutation as a STATEMENT — value semantics: read the receiver,
            // mutate, write back. Only OUR marked shapes are claimed.
            if (JSECore.mutatingMethods.contains(method)) {
                val recv = JSE.eval(receiver, store, item)
                if (JSECore.canMutate(method, recv)) {
                    val vals = splitArgs(argStr).map { trimWhitespacesRunner(it) }
                        .filter { it.isNotEmpty() }.map { JSE.eval(it, store, item) }
                    // Params attached to a URL: mutate through the PARENT so href/search resync.
                    if (receiver.endsWith(".searchParams")) {
                        val parent = receiver.dropLast(".searchParams".length)
                        val urlDict = JSE.eval(parent, store, item) as? Map<String, Any?>
                        if (urlDict != null && urlDict["__url"] != null) {
                            val mutable = LinkedHashMap(urlDict)
                            val params: Any = mutable["searchParams"] ?: LinkedHashMap<String, Any?>()
                            mutable["searchParams"] = JSECore.mutate(method, params, vals) ?: params
                            JSECore.resyncURL(mutable)
                            write(parent, mutable)
                            return
                        }
                    }
                    mutateValue(receiver, item) { v -> JSECore.mutate(method, v, vals) ?: v }
                    return
                }
            }
            if (arrayMethods.contains(method)) {
                val parts = splitArgs(argStr).map { trimWhitespacesRunner(it) }.filter { it.isNotEmpty() }
                fun v(s: String): Any = JSE.eval(s, store, item) ?: NSNull
                when (method) {
                    "push" -> mutateArray(receiver, item) { it.add(v(parts.firstOrNull() ?: "")) }
                    "unshift" -> mutateArray(receiver, item) { it.add(0, v(parts.firstOrNull() ?: "")) }
                    "pop" -> mutateArray(receiver, item) { if (it.isNotEmpty()) it.removeAt(it.size - 1) }
                    "shift" -> mutateArray(receiver, item) { if (it.isNotEmpty()) it.removeAt(0) }
                    "splice" -> performSplice(receiver + " = " + parts.joinToString(", "), item)
                    "sort" -> mutateArray(receiver, item) {
                        val sorted = JSE.sortedArray(it, v(parts.firstOrNull() ?: ""), store)
                        it.clear(); it.addAll(sorted)
                    }
                }
                return
            }
        }
        if (!callee.contains(".")) {
            val f = store.actions[callee]                              // action() / action(argsObj, { eventCallbacks })
            if (f != null) {
                val argList = splitArgs(argStr)
                val scope = HashMap<String, Any?>(item ?: emptyMap())
                for ((k, e) in f.inputs) scope[k] = JSE.eval(e, store, item) ?: NSNull   // declared inputs
                val first = argList.firstOrNull()
                if (first != null && trimWhitespacesRunner(first).isNotEmpty()) {
                    val obj = JSE.eval(first, store, item) as? Map<String, Any?>
                    if (obj != null) scope.putAll(obj)                 // 1st arg object → the action's input (overrides)
                }
                if (store.actionDepth < 32) {
                    store.actionDepth += 1
                    val saved = store.actionEvents
                    store.actionEvents = if (argList.size > 1) parseHandlers(argList[1]) else emptyMap()   // 2nd arg → event callbacks
                    store.actionNameStack.add(callee)                  // so a raised dsx.event stamps `__from`
                    // Isolate the callee's control flow: a `return`/`break`/`continue` is LOCAL to
                    // the called action (it ends its body, never the caller's loop/body). A `throw`
                    // still propagates (real exception → the caller's try/catch). Actions ARE
                    // workflows — one calling another must not inherit its terminator.
                    val savedFlow = store.flowSignal
                    val savedThrown = store.thrownValue
                    val savedBody = store.entryBody
                    store.flowSignal = null
                    store.entryBody = f.body                           // uncaught-throw context (snippet)
                    runActionBody(f.body, scope, args)
                    // RETURNING ACTIONS: surface the callee's OWN `return <expr>` value —
                    // visible only when ITS body ended via `return` (the flow signal), so a
                    // nested call's leftover can never masquerade as this callee's return.
                    // An AWAITING `dsx.action` caller (callActionForValue) binds it; every
                    // other call site leaves it for the next branch exit to overwrite.
                    val returned = if (store.flowSignal == "return") store.returnValue else null
                    if (store.flowSignal != "throw") { store.flowSignal = savedFlow; store.thrownValue = savedThrown; store.entryBody = savedBody }
                    store.returnValue = returned
                    store.actionNameStack.removeAt(store.actionNameStack.size - 1)
                    store.actionEvents = saved
                    store.actionDepth -= 1
                }
                return
            }
        }
        dispatch(a, item)                                              // package call: pkg.method(named args)
    }

    // ── the bounded-JS action body ─────────────────────────────────────────────────────────

    /// Run a bounded-JS action body — `if/else`, `while`/`for`/`for…of` (budgeted), `switch`
    /// (JS fallthrough + `break`), `try/catch/finally` + `throw`, `break`/`continue`/`return`,
    /// `const`/`let` locals, and leaf statements on `;` / newline. Still TOTAL: loops draw on
    /// `store.loopWork` (cap `loopCap` per entry event), recursion stays depth-capped. Control
    /// flow propagates via `store.flowSignal`: a block stops EXECUTING when a signal is in
    /// flight but keeps PARSING (so the walk stays aligned).
    private fun runActionBody(body: String, item: Map<String, Any?>?, args: Map<String, Any?>) {
        // /web/15: a body beyond the JSE subset ESCALATES to the engine seam instead of
        // mis-running through this interpreter. No engine bound (the JavaScriptSandbox/
        // QuickJS wave) → js_tier_unavailable through the ambient fan-out — VISIBLE,
        // fail-open, never the silent wrong path (Article 7).
        val verdict = TierClassifier.classify(body)
        if (verdict.tier == BodyTier.JS) {
            val engine = JsTier.engine
            if (engine == null) {
                reportAmbientError(scheme = "app", code = "js_tier_unavailable",
                                   message = "this body needs the JS tier (${verdict.reason}) — no escalation engine is bound on this build",
                                   recoverable = true, data = mapOf<String, Any?>("snippet" to body.take(120)),
                                   origin = "uncaught")
                return
            }
            engine.run(body, jsTierEnv(item, args)) {}
            return
        }
        val locals = HashMap<String, Any?>(item ?: emptyMap())
        val c = stripJSComments(body).toCharArray()   // idempotent — continuations may pass pre-stripped text
        val i = Ix(0)
        runActionBlock(c, i, locals, args, execute = true, topLevel = true)
    }

    /** The escalation env (/web/15 law 3) — the engine reaches THIS runner's store
     *  routing, its depth-guarded actions, the ONE module funnel, and the emitters;
     *  never live state, never a capability the JSE tier lacks. Module calls ride the
     *  SAME dispatch funnel authored statements use (JSON args are a valid JSE object
     *  literal); the engine wave upgrades completion to the settle envelope. */
    private fun jsTierEnv(item: Map<String, Any?>?, args: Map<String, Any?>): JsTierEnv = object : JsTierEnv {
        override fun read(path: String): Any? = JSE.eval(path, store, item)
        override fun write(path: String, value: Any?) { this@JSERunner.write(path, value ?: NSNull) }
        override fun callAction(name: String, args: Map<String, Any?>): Any? =
            callActionForValue(name, "", HashMap(item ?: emptyMap()), args)
        override fun callModule(chain: String, args: Map<String, Any?>, completion: (Any?) -> Unit) {
            dispatch("$chain(${jsonLiteral(args)})", item)
            completion(null)
        }
        override fun emitEvent(name: String, payload: Map<String, Any?>) { emitEventUp(name, payload, item) }
        override fun log(message: String) { kernelLog("[dsx.log]", message) }
        override fun error(code: String, message: String) {
            reportAmbientError(scheme = "app", code = code, message = message,
                               recoverable = true, data = null, origin = "call")
        }
    }

    /** args → a JSON object literal (valid JSE source — the seam's wire form). */
    private fun jsonLiteral(value: Any?): String = when (value) {
        null, NSNull -> "null"
        is Boolean -> value.toString()
        is Number -> JSE.string(value)
        is String -> "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
                                 .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\""
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { (k, v) -> "${jsonLiteral(k.toString())}:${jsonLiteral(v)}" }
        is List<*> -> value.joinToString(",", "[", "]") { jsonLiteral(it) }
        else -> jsonLiteral(value.toString())
    }

    private fun runActionBlock(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>,
                               execute: Boolean, topLevel: Boolean = false) {
        while (i.v < c.size) {
            jsSkipWs(c, i)
            if (i.v >= c.size) break
            if (c[i.v] == '}') return                                  // end of this { } block (caller consumes '}')
            if (c[i.v] == ';') { i.v += 1; continue }
            // A flow signal in flight stops EXECUTION for the rest of this block — parsing continues.
            val exec = execute && store.flowSignal == null
            if (c[i.v] == '{') {                                       // a bare `{ … }` scope block
                i.v += 1; runActionBlock(c, i, locals, args, exec)
                jsSkipWs(c, i); if (i.v < c.size && c[i.v] == '}') i.v += 1
                continue
            }
            if (topLevel && exec) {
                // `const r = await fetch(url, { … })` — suspends; the REST of the body runs as the continuation.
                val af = matchAwaitFetch(c, i.v)
                if (af != null) {
                    val j = Ix(af.after); jsSkipWs(c, j)
                    runAwaitFetch(af.bind, af.args, HashMap(locals), args, rest = tail(c, j.v))
                    return
                }
                // `const env = await fetch: dest = GET /url` — await the REACTIVE fetch EFFECT inline.
                val fe = matchAwaitFetchEffect(c, i.v)
                if (fe != null) {
                    val j = Ix(fe.after); jsSkipWs(c, j)
                    runAwaitFetchEffect(fe.bind, fe.spec, HashMap(locals), args, rest = tail(c, j.v))
                    return
                }
                // `const r = await orders.send({...})` / `await orders.refresh()` —
                // awaitable mounted `<api>` operations.
                val api = matchAwaitApi(c, i.v)
                if (api != null) {
                    val j = Ix(api.after); jsSkipWs(c, j)
                    runAwaitApi(api.bind, api.name, api.verb, api.args, HashMap(locals), args,
                                rest = tail(c, j.v))
                    return
                }
                // `const r = await dsx.module.scheme.method({ … })` — an AWAITABLE package call.
                val ap = matchAwaitPackage(c, i.v)
                if (ap != null) {
                    val j = Ix(ap.after); jsSkipWs(c, j)
                    runAwaitPackage(ap.bind, ap.callee, ap.args, HashMap(locals), args, rest = tail(c, j.v))
                    return
                }
                // `const ok = await dsx.event('confirm', { … })` — REQUEST/RESPONSE events.
                val ae = matchAwaitEvent(c, i.v)
                if (ae != null) {
                    val j = Ix(ae.after); jsSkipWs(c, j)
                    runAwaitEvent(ae.bind, ae.args, HashMap(locals), args, rest = tail(c, j.v))
                    return
                }
                // `const r = await crypto.subtle.<method>( … )` — Web Crypto, off-main, then continue.
                val ac = matchAwaitCrypto(c, i.v)
                if (ac != null) {
                    val j = Ix(ac.after); jsSkipWs(c, j)
                    runAwaitCrypto(ac.bind, ac.method, ac.args, HashMap(locals), args, rest = tail(c, j.v))
                    return
                }
                // `const [r] = await Promise.all([ … ])` — the JS combinators, concurrent elements.
                val pm = matchAwaitPromise(c, i.v)
                if (pm != null) {
                    val j = Ix(pm.after); jsSkipWs(c, j)
                    runAwaitPromise(pm.kind, pm.bind, pm.elements, HashMap(locals), args, rest = tail(c, j.v))
                    return
                }
            }
            // `const ws = new WebSocket(url[, { key }])` — KEYED + SURFACE-SCOPED; synchronous.
            if (exec) {
                val w = matchNewWebSocket(c, i.v)
                if (w != null) {
                    i.v = w.after
                    val handle = openWebSocket(w.args, locals)
                    if (w.bind != null) locals[w.bind] = handle
                    continue
                }
            }
            // `const r = await dsx.action.name({ … })` — a RETURNING action call (actions
            // corpus): actions run SYNCHRONOUSLY here (they only suspend at their OWN awaits,
            // which re-enter continuations), so this never suspends — run it via the existing
            // dispatch, read the return-value ledger, bind { ok: true, data } to the target,
            // and continue the walk INLINE (no continuation machinery). The assignment form
            // `r = await dsx.action.x()` writes the STORE (the pinned `x = e` rule). A `throw`
            // that unwinds the callee keeps propagating (no envelope, no bind) — the exec gate
            // stops the rest of this block and the enclosing try's catch sees it, exactly the
            // un-awaited contract. Matched at ANY nesting level (it is synchronous).
            if (exec) {
                val aa = matchAwaitAction(c, i.v)
                if (aa != null) {
                    i.v = aa.after
                    val envelope = callActionForValue(aa.name, aa.args, locals, args)
                    if (envelope != null && aa.bind != null) {
                        if (aa.decl) locals[aa.bind] = envelope else write(aa.bind, envelope)
                    }
                    continue
                }
            }
            if (jsWord(c, i.v, "if")) { runActionIf(c, i, locals, args, exec); continue }
            if (jsWord(c, i.v, "while")) { runActionWhile(c, i, locals, args, exec); continue }
            if (jsWord(c, i.v, "do")) { runActionDoWhile(c, i, locals, args, exec); continue }
            if (jsWord(c, i.v, "for")) { runActionFor(c, i, locals, args, exec); continue }
            if (jsWord(c, i.v, "switch")) { runActionSwitch(c, i, locals, args, exec); continue }
            if (jsWord(c, i.v, "try")) { runActionTry(c, i, locals, args, exec); continue }
            if (jsWord(c, i.v, "const") || jsWord(c, i.v, "let") || jsWord(c, i.v, "var")) {
                runActionDecl(c, i, locals, exec); continue
            }
            val before = i.v
            val stmt = trimWhitespacesRunner(jsLeaf(c, i))
            if (i.v == before) { i.v += 1; continue }                  // stray char — skip; never spin
            if (!exec || stmt.isEmpty()) continue
            if (flowLeaf(stmt, locals)) continue                       // break / continue / return [e] / throw e
            // `await` for the action-callback flow: when an action was called WITH event callbacks,
            // a top-level `fetch:` runs the rest of the body as its completion.
            if (topLevel && stmt.startsWith("fetch:") && store.actionEvents.isNotEmpty()) {
                val j = Ix(i.v); jsSkipWs(c, j)
                if (j.v < c.size) {
                    val rest = tail(c, j.v)
                    val handlers = store.actionEvents
                    val scope = HashMap<String, Any?>(locals)
                    performFetch(stmt.drop(6), scope) {
                        val saved = store.actionEvents
                        store.actionEvents = handlers
                        runActionBody(rest, scope, args)
                        store.actionEvents = saved
                    }
                    return
                }
            }
            runVerb(stmt, locals, args)
        }
    }

    // ── await matchers + runners ───────────────────────────────────────────────────────────

    private class AwaitMatch(val bind: String?, val args: String, val after: Int)
    private class AwaitEffectMatch(val bind: String?, val spec: String, val after: Int)
    private class AwaitCryptoMatch(val bind: String?, val method: String, val args: String, val after: Int)
    private class AwaitApiMatch(
        val bind: String?,
        val name: String,
        val verb: String,
        val args: String,
        val after: Int,
    )
    private class AwaitPackageMatch(val bind: String?, val callee: String, val args: String, val after: Int)
    private class AwaitPromiseMatch(val bind: String?, val kind: String, val elements: List<String>, val after: Int)
    private class AwaitActionMatch(val bind: String?, val decl: Boolean, val name: String, val args: String, val after: Int)
    private class WebSocketMatch(val bind: String?, val args: String, val after: Int)
    private class BindPrefix(val bind: String?, val p: Int)

    /// The shared `[const|let|var NAME =]` prefix of every await matcher. Null = a malformed
    /// declaration (the whole match must fail); otherwise the (possibly nil) bind + position.
    private fun matchBindPrefix(c: CharArray, start: Int): BindPrefix? {
        val p = Ix(start)
        var bind: String? = null
        for (kw in listOf("const", "let", "var")) {
            if (!jsWord(c, p.v, kw)) continue
            p.v += kw.length; jsSkipWs(c, p)
            val name = StringBuilder()
            while (p.v < c.size && jsIsWord(c[p.v])) { name.append(c[p.v]); p.v += 1 }
            jsSkipWs(c, p)
            if (p.v >= c.size || c[p.v] != '=') return null
            p.v += 1; jsSkipWs(c, p); bind = name.toString(); break
        }
        return BindPrefix(bind, p.v)
    }

    /// Match `[const|let|var NAME =] await fetch( … )` → bind, args, index past the statement.
    private fun matchAwaitFetch(c: CharArray, start: Int): AwaitMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        if (!jsWord(c, p.v, "fetch")) return null
        p.v += 5; jsSkipWs(c, p)
        if (p.v >= c.size || c[p.v] != '(') return null
        val args = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return AwaitMatch(bp.bind, args, q.v)
    }

    /// Run `await fetch(url, { method, body, headers, signal })`: the request runs off the action
    /// body, `bind` gets the Response-shaped result, then `rest` runs as the continuation.
    private fun runAwaitFetch(bind: String?, argsStr: String, locals: Map<String, Any?>,
                              args: Map<String, Any?>, rest: String) {
        val handlers = store.actionEvents
        fetchOp(argsStr, locals) { result ->
            val scope = HashMap(locals)
            if (bind != null) scope[bind] = result
            store.actionEvents = handlers
            runActionBody(rest, scope, args)
        }
    }

    /// Match `[const|let|var NAME =] await fetch: <spec>` — the reactive-effect form, selected
    /// by the `:` right after `fetch` (vs the open-paren of the JS API).
    private fun matchAwaitFetchEffect(c: CharArray, start: Int): AwaitEffectMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        if (!jsWord(c, p.v, "fetch")) return null
        p.v += 5; jsSkipWs(c, p)
        if (p.v >= c.size || c[p.v] != ':') return null
        p.v += 1
        val spec = jsLeaf(c, p)                                        // rest of the statement: `dest = GET /url …`
        return AwaitEffectMatch(bp.bind, spec, p.v)
    }

    /// Run `await fetch: dest = METHOD url …`: fire the reactive fetch EFFECT (it writes the
    /// envelope to `dest.*` as usual), and when it settles bind the settled envelope to `bind`,
    /// then run `rest` as the continuation.
    private fun runAwaitFetchEffect(bind: String?, spec: String, locals: Map<String, Any?>,
                                    args: Map<String, Any?>, rest: String) {
        val handlers = store.actionEvents
        val dest = spec.split("=").firstOrNull { it.isNotEmpty() }?.let { trimWhitespacesRunner(it) } ?: ""
        performFetch(spec, locals) {
            val scope = HashMap(locals)
            if (bind != null && dest.isNotEmpty()) scope[bind] = JSE.eval(dest, store, locals) ?: NSNull
            store.actionEvents = handlers
            runActionBody(rest, scope, args)
        }
    }

    /// Match `[const|let|var NAME =] await <api>.send( … )` or `.refresh()`.
    ///
    /// A syntactically similar object/socket call is not ours: only a name with a LIVE
    /// mounted `<api>` handle is claimed. That keeps `await socket.send(...)` available
    /// to the rest of the language instead of manufacturing an "unavailable" API error.
    private fun matchAwaitApi(c: CharArray, start: Int): AwaitApiMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        val name = StringBuilder()
        while (p.v < c.size && jsIsWord(c[p.v])) { name.append(c[p.v]); p.v += 1 }
        if (name.isEmpty() || p.v >= c.size || c[p.v] != '.') return null
        val apiName = name.toString()
        if (store.apiHandle(apiName) == null) return null
        p.v += 1
        val verb = when {
            jsWord(c, p.v, "send") -> "send".also { p.v += it.length }
            jsWord(c, p.v, "refresh") -> "refresh".also { p.v += it.length }
            else -> return null
        }
        jsSkipWs(c, p)
        if (p.v >= c.size || c[p.v] != '(') return null
        val callArgs = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return AwaitApiMatch(bp.bind, apiName, verb, callArgs, q.v)
    }

    /// Run one awaitable `<api>` operation: its transport result is already the shared
    /// `{ok,status,data|error}` envelope. Resume on the handle's completion executor.
    private fun runAwaitApi(
        bind: String?,
        name: String,
        verb: String,
        argStr: String,
        locals: Map<String, Any?>,
        args: Map<String, Any?>,
        rest: String,
    ) {
        val handle = store.apiHandle(name)
        val body = if (verb == "send") {
            val raw = splitArgs(argStr).firstOrNull()
            raw?.takeIf { trimWhitespacesRunner(it).isNotEmpty() }
                ?.let { JSE.eval(it, store, locals) as? Map<String, Any?> }
        } else null
        val handlers = store.actionEvents
        val resume: (Map<String, Any?>?) -> Unit = { result ->
            val scope = HashMap(locals)
            if (bind != null) scope[bind] = result ?: NSNull
            val saved = store.actionEvents
            store.actionEvents = handlers
            try {
                runActionBody(rest, scope, args)
            } finally {
                store.actionEvents = saved
            }
        }
        if (handle == null) {
            // A renderer teardown can race the already-validated match. Settle instead of
            // stranding the continuation.
            resume(mapOf("ok" to false, "error" to "unavailable", "call" to "$name.$verb"))
        } else if (verb == "refresh") {
            handle.refresh(resume)
        } else {
            handle.send(body, resume)
        }
    }

    /// ONE fetch as a completion-style op (completion on main) — shared by `await fetch` and the
    /// Promise combinators. The full web-fetch shape (URL / Request first arg; headers; body;
    /// signal from an AbortController — abort settles { ok:false, error:'aborted' }).
    private fun fetchOp(argsStr: String, locals: Map<String, Any?>, completion: (Any?) -> Unit) {
        val parts = splitArgs(argsStr)
        val first = JSE.eval(parts.firstOrNull() ?: "", store, locals)
        var url: String
        var method = "GET"
        var bodyData: ByteArray? = null
        val headers = HashMap<String, String>()
        var signalId: String? = null
        val req = first as? Map<String, Any?>
        if (req != null && req["__request"] != null) {                 // new Request(url, opts)
            url = JSE.string(req["url"])
            method = JSE.string(req["method"] ?: "GET")
            JSECore.applyHeaders(req["headers"], headers)
            bodyData = JSECore.bodyData(req["body"], headers)
            signalId = (req["signal"] as? Map<String, Any?>)?.get("__signal") as? String
        } else {
            url = JSE.string(first)                                    // string / new URL(…) → href
        }
        if (parts.size > 1) {
            val opts = JSE.eval(parts[1], store, locals) as? Map<String, Any?>
            if (opts != null) {
                opts["method"]?.let { method = JSE.string(it) }
                JSECore.applyHeaders(opts["headers"], headers)
                opts["body"]?.let { bodyData = JSECore.bodyData(it, headers) }
                ((opts["signal"] as? Map<String, Any?>)?.get("__signal") as? String)?.let { signalId = it }
            }
        }
        val sig = signalId
        if (sig != null && JSECore.aborted(sig)) {
            completion(mapOf<String, Any?>("__response" to true, "ok" to false, "error" to "aborted")); return
        }
        JSERunner.fetch.request(url, method, headers, bodyData) { res ->
            JSERunner.mainExecutor.execute {
                val result = LinkedHashMap<String, Any?>()
                result["__response"] = true
                if (res != null) {
                    if (sig != null && JSECore.aborted(sig)) {
                        result["ok"] = false; result["error"] = "aborted"
                    } else {
                        result["status"] = res.status.toDouble()
                        result["ok"] = res.status in 200..299
                        result["statusText"] = httpStatusText(res.status)
                        val hdrs = LinkedHashMap<String, Any?>()
                        for ((k, v) in res.headers) hdrs[k] = v
                        hdrs["__headers"] = true
                        result["headers"] = hdrs
                        val text = String(res.data, Charsets.UTF_8)
                        result["text"] = text
                        // Parsed body regardless of status (res.json() works on 4xx, like the web).
                        result["data"] = json(text).foundationValue ?: NSNull
                        if (res.status !in 200..299) result["error"] = "http ${res.status}"
                    }
                } else {
                    result["ok"] = false; result["error"] = "network"
                }
                completion(result)
            }
        }
    }

    /// Match `[const|let|var NAME =] await crypto.subtle.method( … )`.
    private fun matchAwaitCrypto(c: CharArray, start: Int): AwaitCryptoMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        for (ch in "crypto.subtle.") {
            if (p.v >= c.size || c[p.v] != ch) return null
            p.v += 1
        }
        val method = StringBuilder()
        while (p.v < c.size && jsIsWord(c[p.v])) { method.append(c[p.v]); p.v += 1 }
        jsSkipWs(c, p)
        if (method.isEmpty() || p.v >= c.size || c[p.v] != '(') return null
        val args = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return AwaitCryptoMatch(bp.bind, method.toString(), args, q.v)
    }

    /// Run `await crypto.subtle.<method>(…)`: args evaluate NOW, the work runs off-main, then
    /// `rest` continues with `bind` holding the result. Total: unsupported → binds null.
    private fun runAwaitCrypto(bind: String?, method: String, argStr: String,
                               locals: Map<String, Any?>, args: Map<String, Any?>, rest: String) {
        val handlers = store.actionEvents
        cryptoOp(method, argStr, locals) { result ->
            val scope = HashMap(locals)
            if (bind != null) scope[bind] = result
            store.actionEvents = handlers
            runActionBody(rest, scope, args)
        }
    }

    /// ONE crypto.subtle call as a completion-style op — shared by `await crypto.subtle.*` and Promise.
    private fun cryptoOp(method: String, argStr: String, locals: Map<String, Any?>, completion: (Any?) -> Unit) {
        val values = splitArgs(argStr).map { JSE.eval(it, store, locals) }
        JSERunner.backgroundExecutor.execute {
            val result = JSECrypto.call("crypto.subtle.$method", values)
            JSERunner.mainExecutor.execute { completion(result ?: NSNull) }
        }
    }

    /// Match `[const|let|var NAME =] new WebSocket( … )`.
    private fun matchNewWebSocket(c: CharArray, start: Int): WebSocketMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "new")) return null
        p.v += 3; jsSkipWs(c, p)
        if (!jsWord(c, p.v, "WebSocket")) return null
        p.v += 9; jsSkipWs(c, p)
        if (p.v >= c.size || c[p.v] != '(') return null
        val args = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return WebSocketMatch(bp.bind, args, q.v)
    }

    /// Open (or replace) a keyed socket on this surface's store and return its handle dict.
    private fun openWebSocket(argStr: String, locals: Map<String, Any?>): Map<String, Any?> {
        val parts = splitArgs(argStr)
        val url = JSE.string(JSE.eval(parts.firstOrNull() ?: "", store, locals))
        var key = url
        if (parts.size > 1) {
            val opts = JSE.eval(parts[1], store, locals) as? Map<String, Any?>
            val k = opts?.get("key")
            if (k != null) key = JSE.string(k)
        }
        store.sockets[key]?.close()                                    // same key → replace (no double-connect)
        store.sockets[key] = JSERunner.socketFactory(url, key, this)
        return mapOf("__socket" to key, "url" to url)
    }

    /// Run a socket handler body (already on main) — the registration-time scope plus the
    /// event payload under the arrow's parameter name.
    fun runSocketHandler(body: String, scope: Map<String, Any?>) {
        runActionBody(body, scope, emptyMap())
    }

    /// Match `[const|let|var NAME =] await Promise.all|race|any|allSettled([ … ])`.
    private fun matchAwaitPromise(c: CharArray, start: Int): AwaitPromiseMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        for (ch in "Promise.") {
            if (p.v >= c.size || c[p.v] != ch) return null
            p.v += 1
        }
        val kind = StringBuilder()
        while (p.v < c.size && jsIsWord(c[p.v])) { kind.append(c[p.v]); p.v += 1 }
        if (kind.toString() !in listOf("all", "race", "any", "allSettled")) return null
        jsSkipWs(c, p)
        if (p.v >= c.size || c[p.v] != '(') return null
        val inner = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        var body = inner.trim()
        if (!body.startsWith("[") || !body.endsWith("]")) return null
        body = body.substring(1, body.length - 1)
        val elements = splitArgs(body).map { it.trim() }.filter { it.isNotEmpty() }
        return AwaitPromiseMatch(bp.bind, kind.toString(), elements, q.v)
    }

    /// Run a Promise combinator: every element starts NOW (concurrent); `all` binds the results
    /// in order, `race`/`any` binds the first to settle, `allSettled` wraps each as
    /// { status: 'fulfilled', value } (JSE's async ops report errors AS values — nothing rejects).
    private fun runAwaitPromise(kind: String, bind: String?, elements: List<String>,
                                locals: Map<String, Any?>, args: Map<String, Any?>, rest: String) {
        val handlers = store.actionEvents
        val continueWith: (Any?) -> Unit = { value ->
            val scope = HashMap(locals)
            if (bind != null) scope[bind] = value
            store.actionEvents = handlers
            runActionBody(rest, scope, args)
        }
        val n = elements.size
        if (n == 0) { continueWith(if (kind == "race" || kind == "any") NSNull else ArrayList<Any?>()); return }
        val results = MutableList<Any?>(n) { NSNull }
        var remaining = n
        var settled = false
        for ((idx, el) in elements.withIndex()) {
            startOp(el, locals) { value ->
                if (kind == "race" || kind == "any") {
                    if (settled) return@startOp
                    settled = true
                    continueWith(value)
                    return@startOp
                }
                results[idx] = value
                remaining -= 1
                if (remaining == 0) {
                    if (kind == "allSettled") {
                        continueWith(results.map { mapOf<String, Any?>("status" to "fulfilled", "value" to it) })
                    } else {
                        continueWith(ArrayList(results))
                    }
                }
            }
        }
    }

    /// Start ONE element of a Promise combinator: fetch(…) / dsx.module.… / crypto.subtle.… run
    /// async; anything else evaluates synchronously and settles on the next main-thread tick.
    private fun startOp(raw: String, locals: Map<String, Any?>, completion: (Any?) -> Unit) {
        var el = raw
        if (el.startsWith("await ")) el = trimWhitespacesRunner(el.drop(6))
        if (el.startsWith("fetch(") && el.endsWith(")")) {
            fetchOp(el.substring(6, el.length - 1), locals, completion); return
        }
        if (el.startsWith("dsx.module.") && el.endsWith(")")) {
            val lp = el.indexOf('(')
            if (lp >= 0) {
                // PARITY-PINNED QUIRK (Stack.swift:2476): the callee slice starts at offset 12 —
                // one PAST the 11-char "dsx.module." prefix — so the scheme loses its first char
                // and the element settles { ok:false, error:"unavailable" }. Fix on iOS FIRST,
                // then mirror here and regenerate the conformance fixtures. The slice still
                // keeps the FULL dotted tail (only the head's first char is eaten), so chains
                // deeper than scheme.method pass through whole once the offset is fixed —
                // the funnel folds them; this site never counts segments.
                val callee = el.substring(12, lp)
                val argStr = el.substring(lp + 1, el.length - 1)
                packageOp(callee, argStr, locals, completion); return
            }
        }
        if (el.startsWith("crypto.subtle.") && el.endsWith(")")) {
            val lp = el.indexOf('(')
            if (lp >= 0) {
                val method = el.substring(14, lp)
                val argStr = el.substring(lp + 1, el.length - 1)
                cryptoOp(method, argStr, locals, completion); return
            }
        }
        val v = JSE.eval(el, store, locals) ?: NSNull
        JSERunner.mainExecutor.execute { completion(v) }
    }

    /// Match `[const|let|var NAME =] await dsx.module.scheme.method( … )`. The callee
    /// collector takes EVERY dotted segment up to the paren (word chars + '.'), so a chain
    /// deeper than scheme.method (`watch.health.heartRate`) is captured whole — resolution
    /// (the chain fold) is the dispatch funnel's job, never this matcher's.
    private fun matchAwaitPackage(c: CharArray, start: Int): AwaitPackageMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        val marker = "dsx.module."
        if (p.v + marker.length >= c.size) return null
        for ((k, ch) in marker.withIndex()) if (c[p.v + k] != ch) return null
        p.v += marker.length
        val callee = StringBuilder()
        while (p.v < c.size && (jsIsWord(c[p.v]) || c[p.v] == '.')) { callee.append(c[p.v]); p.v += 1 }
        jsSkipWs(c, p)
        if (callee.isEmpty() || p.v >= c.size || c[p.v] != '(') return null
        val args = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return AwaitPackageMatch(bp.bind, callee.toString(), args, q.v)
    }

    /// Run `await dsx.module.scheme.method({ … })`: the package's resolve/error lands in `bind`
    /// with the uniform contract `{ ok, data | error }`, then `rest` runs as the continuation.
    /// `self` resolves to the owning package; unregistered → { ok:false, error:"unavailable" }.
    private fun runAwaitPackage(bind: String?, rawCallee: String, argStr: String,
                                locals: Map<String, Any?>, args: Map<String, Any?>, rest: String) {
        val handlers = store.actionEvents
        packageOp(rawCallee, argStr, locals) { result ->
            store.actionEvents = handlers
            continueAwaitPackage(bind, (result as? Map<String, Any?>) ?: emptyMap(), locals, args, rest)
        }
    }

    /// ONE awaitable package call as a completion-style op (completion on main; `self.` resolves
    /// to the owning scheme) — shared by `await dsx.module.…` and the Promise combinators.
    private fun packageOp(rawCallee: String, argStr: String, locals: Map<String, Any?>, completion: (Any?) -> Unit) {
        var callee = rawCallee
        if (callee == "self" || callee.startsWith("self.")) {
            val me = scope
            if (me.isNullOrEmpty()) {
                completion(mapOf<String, Any?>("ok" to false, "error" to "unavailable", "call" to rawCallee)); return
            }
            callee = me + callee.drop(4)
        }
        var payload = (JSE.eval(if (argStr.isEmpty()) "{}" else argStr, store, locals) as? Map<String, Any?>) ?: emptyMap()
        store.frameId?.let { payload = payload + ("__frame" to it) }   // frame identity framing key — see StackStore.frameId
        val url = normalizeCall(callee)
        if (!isPlausibleURL(url)) {
            completion(mapOf<String, Any?>("ok" to false, "error" to "unavailable", "call" to callee)); return
        }
        var finished = false
        val handled = JSERunner.moduleHandle(url, payload) { outcome ->
            JSERunner.mainExecutor.execute {
                if (finished) return@execute
                finished = true
                val result: MutableMap<String, Any?> = when (outcome) {
                    is JSEModuleOutcome.Resolve -> {
                        val r = LinkedHashMap<String, Any?>()
                        r["ok"] = true
                        r["data"] = outcome.value ?: NSNull
                        r
                    }
                    is JSEModuleOutcome.Error -> {
                        val r = LinkedHashMap<String, Any?>()
                        r["ok"] = false
                        r["error"] = outcome.code
                        if (outcome.data != null) r["data"] = outcome.data
                        r
                    }
                }
                completion(result)
            }
        }
        if (!handled) {
            finished = true
            completion(mapOf<String, Any?>("ok" to false, "error" to "unavailable", "call" to callee))
        }
    }

    private fun continueAwaitPackage(bind: String?, result: Map<String, Any?>,
                                     locals: Map<String, Any?>, args: Map<String, Any?>, rest: String) {
        val scope = HashMap(locals)
        if (bind != null) scope[bind] = result
        runActionBody(rest, scope, args)
    }

    /// Match `[const|let|var NAME =] await dsx.action.name( … )` — the RETURNING action
    /// call — and its bare-assignment form `path = await dsx.action.name( … )` (no decl
    /// keyword; that bind writes the STORE, the pinned `x = e` rule). Sibling of
    /// matchAwaitPackage; the "dsx.action." marker keeps `dsx.module.…` on its own path.
    private fun matchAwaitAction(c: CharArray, start: Int): AwaitActionMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        var bind = bp.bind
        var decl = bind != null
        val p = Ix(bp.p)
        if (bind == null) {
            // bare-assignment form: `path = await …` (never `==`); claimed only when
            // `await dsx.action.` follows — anything else keeps its ordinary path.
            val q = Ix(start)
            val name = StringBuilder()
            while (q.v < c.size && (jsIsWord(c[q.v]) || c[q.v] == '.')) { name.append(c[q.v]); q.v += 1 }
            jsSkipWs(c, q)
            if (name.isNotEmpty() && q.v < c.size && c[q.v] == '=' &&
                (q.v + 1 >= c.size || c[q.v + 1] != '=')) {
                q.v += 1; jsSkipWs(c, q)
                if (jsWord(c, q.v, "await")) { bind = name.toString(); decl = false; p.v = q.v }
            }
        }
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        val marker = "dsx.action."
        if (p.v + marker.length >= c.size) return null
        for ((k, ch) in marker.withIndex()) if (c[p.v + k] != ch) return null
        p.v += marker.length
        val nm = StringBuilder()
        while (p.v < c.size && jsIsWord(c[p.v])) { nm.append(c[p.v]); p.v += 1 }
        jsSkipWs(c, p)
        if (nm.isEmpty() || p.v >= c.size || c[p.v] != '(') return null
        val args = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return AwaitActionMatch(bind, decl, nm.toString(), args, q.v)
    }

    /// Run `await dsx.action.<name>(argsObj)` SYNCHRONOUSLY (actions never suspend their
    /// caller here — their own awaits re-enter continuations) via the EXISTING dispatch
    /// (runJSStatement's action branch: declared inputs, args-object merge, event
    /// callbacks, the 32 depth cap, flow isolation), then produce the envelope
    /// `{ ok: true, data: <the action's `return <expr>` value, NSNull when it never
    /// returned> }` from the returnValue ledger the branch scoped to THIS callee. A
    /// `throw` that unwinds the callee yields NO envelope (flowSignal stays "throw") —
    /// the caller's try/catch sees the real exception; never enveloped.
    private fun callActionForValue(name: String, argStr: String, locals: Map<String, Any?>,
                                   args: Map<String, Any?>): Map<String, Any?>? {
        runJSStatement("dsx.action.$name($argStr)", locals, args)
        if (store.flowSignal == "throw") return null
        val v = store.returnValue
        store.returnValue = null
        return mapOf<String, Any?>("ok" to true, "data" to (v ?: NSNull))
    }

    /// Send a `dsx.event` UP to the consumer's `on:<name>` (else a native `ui.on` host), then to
    /// native packages — the shared dispatch for a bare `dsx.event(…)` AND the `await dsx.event(…)`
    /// request form. Both handler branches re-enter the statement runner, so they draw on the SAME
    /// bounded ledger as named actions (`store.actionDepth`, cap 32). Past the cap the hop DROPS.
    private fun emitEventUp(name: String, pay: Map<String, Any?>, item: Map<String, Any?>?) {
        val cb = store.actionEvents[name]
        if (cb != null) {                                              // an action callback; dsx.this = payload
            if (store.actionDepth < 32) {
                store.actionDepth += 1
                runActionBody(cb, pay, pay)
                store.actionDepth -= 1
            } else kernelLog("[Stack] dsx.event('$name') dropped — handler depth budget (32) exceeded: callback cycle?")
        } else {
            val e = onHandlers[name]
            if (e != null && e.accepts(pay)) {                         // a consumer's on:<name> — run it in the env that DECLARED it
                if (store.actionDepth < 32) {
                    store.actionDepth += 1
                    val merged = HashMap<String, Any?>(item ?: emptyMap())
                    merged.putAll(pay)                                 // payload rides `dsx.this` here too
                    e.env.run(e.action, merged, pay)
                    store.actionDepth -= 1
                } else kernelLog("[Stack] dsx.event('$name') dropped — handler depth budget (32) exceeded: relay cycle?")
            } else if (onHandlers[name] == null) {
                store.handlers[name]?.invoke(pay)                      // else a native ui.on host
            }
        }
        publishNative(name, pay)                                       // → native packages (dsx.events)
    }

    /// The `await dsx.event` correlation token in scope, if this `resolve:`/`error:` is running
    /// inside an `on:<event>` handler servicing an awaited request.
    private fun replyToken(item: Map<String, Any?>?, args: Map<String, Any?>): Int? =
        (args["__reply"] as? Int) ?: (item?.get("__reply") as? Int)

    /// Match `[const|let|var NAME =] await dsx.event( … )`. The marker is `dsx.event` then `(` —
    /// so `dsx.events.on(…)` (the bus) can't mis-match (the `s`).
    private fun matchAwaitEvent(c: CharArray, start: Int): AwaitMatch? {
        val bp = matchBindPrefix(c, start) ?: return null
        val p = Ix(bp.p)
        if (!jsWord(c, p.v, "await")) return null
        p.v += 5; jsSkipWs(c, p)
        val marker = "dsx.event"
        if (p.v + marker.length >= c.size) return null
        for ((k, ch) in marker.withIndex()) if (c[p.v + k] != ch) return null
        p.v += marker.length; jsSkipWs(c, p)
        if (p.v >= c.size || c[p.v] != '(') return null                // the call form — not `dsx.events.on(…)`
        val args = jsParens(c, p)
        val q = Ix(p.v); jsSkipWs(c, q); if (q.v < c.size && c[q.v] == ';') q.v += 1
        return AwaitMatch(bp.bind, args, q.v)
    }

    /// Run `await dsx.event(name, payload)` (request/response): mint a correlation token, register
    /// the suspended caller's continuation under it, stamp the token onto the payload, then send
    /// the event UP. If nothing ever replies the caller stays suspended — like an unresolved JS
    /// promise; bounded (the registry lives on the surface-scoped store).
    private fun runAwaitEvent(bind: String?, argStr: String, locals: Map<String, Any?>,
                              args: Map<String, Any?>, rest: String) {
        store.nextEventReply += 1
        val token = store.nextEventReply
        store.eventReplies[token] = PendingEventReply(bind, rest, locals, args, store.actionEvents)
        val parts = splitArgs(argStr)
        val name = JSE.string(JSE.eval(parts.firstOrNull() ?: "", store, locals))
        var pay = (if (parts.size > 1) JSE.eval(parts[1], store, locals) else null) as? Map<String, Any?> ?: emptyMap()
        pay = stampFrom(pay, "action", store.actionNameStack.lastOrNull())
        val stamped = LinkedHashMap(pay)
        stamped["__reply"] = token
        emitEventUp(name, stamped, locals)
        store.anyHandlers.forEach { it(name, stamped) }
    }

    /// Replay a suspended `await dsx.event` caller's continuation with `value` (the handler's
    /// `resolve:` value, NSNull for `error:`), its action callbacks restored across the suspension.
    private fun resumeAwaitEvent(pend: PendingEventReply, value: Any?) {
        val saved = store.actionEvents
        store.actionEvents = pend.handlers
        val scope = HashMap(pend.locals)
        if (pend.bind != null) scope[pend.bind] = value ?: NSNull
        runActionBody(pend.rest, scope, pend.args)
        store.actionEvents = saved
    }

    // ── control flow ───────────────────────────────────────────────────────────────────────

    private fun runActionIf(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        i.v += 2; jsSkipWs(c, i)                                       // 'if'
        val condStr = jsParens(c, i)
        val cond = execute && JSE.truthy(JSE.eval(condStr, store, locals))
        runActionBranch(c, i, locals, args, execute = execute && cond)
        jsSkipWs(c, i)
        if (jsWord(c, i.v, "else")) {
            i.v += 4; jsSkipWs(c, i)                                   // 'else'
            if (jsWord(c, i.v, "if")) runActionIf(c, i, locals, args, execute = execute && !cond)
            else runActionBranch(c, i, locals, args, execute = execute && !cond)
        }
    }

    private fun runActionBranch(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        jsSkipWs(c, i)
        if (i.v < c.size && c[i.v] == '{') {
            i.v += 1
            runActionBlock(c, i, locals, args, execute)
            jsSkipWs(c, i); if (i.v < c.size && c[i.v] == '}') i.v += 1
        } else if (jsWord(c, i.v, "if")) {
            runActionIf(c, i, locals, args, execute)
        } else if (jsWord(c, i.v, "while")) {
            runActionWhile(c, i, locals, args, execute)
        } else if (jsWord(c, i.v, "do")) {
            runActionDoWhile(c, i, locals, args, execute)
        } else if (jsWord(c, i.v, "for")) {
            runActionFor(c, i, locals, args, execute)
        } else if (jsWord(c, i.v, "switch")) {
            runActionSwitch(c, i, locals, args, execute)
        } else if (jsWord(c, i.v, "try")) {
            runActionTry(c, i, locals, args, execute)
        } else if (jsWord(c, i.v, "const") || jsWord(c, i.v, "let") || jsWord(c, i.v, "var")) {
            runActionDecl(c, i, locals, execute)
        } else {
            val stmt = trimWhitespacesRunner(jsLeaf(c, i))
            if (execute && stmt.isNotEmpty() && !flowLeaf(stmt, locals)) runVerb(stmt, locals, args)
        }
    }

    private fun runActionDecl(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, execute: Boolean) {
        while (i.v < c.size && jsIsWord(c[i.v])) i.v += 1              // skip const/let/var
        jsSkipWs(c, i)
        val declText = jsLeaf(c, i)                                    // "a = 1, b = 2" · "{x, y: r} = o" · "[p, q] = arr"
        if (!execute) return
        // multi-declarators split on top-level commas (patterns' inner commas are depth-protected)
        for (part in splitTopLevel(declText.toCharArray(), ',')) {
            val p = trimWhitespacesRunner(part)
            if (p.isEmpty()) continue
            val eq = topLevelAssignIndex(p)
            val patternText = trimWhitespacesRunner(if (eq >= 0) p.substring(0, eq) else p)
            val exprText = trimWhitespacesRunner(if (eq >= 0) p.substring(eq + 1) else "")
            val v = if (exprText.isEmpty()) null else JSE.eval(exprText, store, locals)
            bindDestructure(patternText, v, locals) { n, value -> locals[n] = value ?: NSNull }
        }
    }

    /// The `=` that splits pattern from initializer (never `==`/`<=`/`>=`/`!=`, depth-0 only).
    private fun topLevelAssignIndex(s: String): Int {
        val chars = s.toCharArray()
        var depth = 0
        var q: Char? = null
        var k = 0
        while (k < chars.size) {
            val ch = chars[k]
            if (q != null) { if (ch == '\\' && k + 1 < chars.size) { k += 2; continue }; if (ch == q) q = null; k += 1; continue }
            when (ch) {
                '\'', '"', '`' -> q = ch
                '(', '[', '{' -> depth += 1
                ')', ']', '}' -> depth -= 1
                '=' -> {
                    val prev = if (k > 0) chars[k - 1] else ' '
                    val next = if (k + 1 < chars.size) chars[k + 1] else ' '
                    if (depth == 0 && next != '=' && prev != '=' && prev != '!' && prev != '<' && prev != '>') return k
                }
            }
            k += 1
        }
        return -1
    }

    /// Bind a declaration/loop pattern from its SOURCE text — DELEGATING to the one
    /// token-level machinery (JSE.destructureBind). This used to be a second, text-level
    /// binder, and it stayed FLAT when patterns learned nesting, defaults and rest
    /// (syntax-004): `const { a: { b } } = row` bound nothing in an ACTION while binding
    /// fine in an expression block. A second binder is a place to fall behind; now there
    /// is one parser and one binder, and the runner cannot drift from the evaluator.
    private fun bindDestructure(patternText: String, value: Any?, locals: Map<String, Any?>, bind: (String, Any?) -> Unit) {
        JSE.destructureBind(patternText, value, store, locals, bind)
    }

    // ── Bounded statements: while / for / for…of / switch / try-catch / break / continue ──
    //
    // JSE stays TOTAL: every loop iteration anywhere in an action draws on one shared budget
    // (`store.loopWork`, reset per entry event, cap `loopCap`) — past the cap the loop aborts
    // with a log instead of hanging the main thread. Remote DSX can never freeze the app.

    private fun loopStep(): Boolean {
        store.loopWork += 1
        if (store.loopWork == loopCap + 1) {
            kernelLog("[Stack] loop budget exhausted ($loopCap iterations in one action) — aborting. JSE is bounded; restructure with map/filter/reduce or move the work to a package.")
        }
        return store.loopWork <= loopCap
    }

    /// After a loop-body run: `continue` is consumed (next iteration), `break` is consumed
    /// (stop), `return`/`throw` stay in flight (unwind through the enclosing blocks).
    private fun loopContinues(): Boolean = when (store.flowSignal) {
        "continue" -> { store.flowSignal = null; true }
        "break" -> { store.flowSignal = null; false }
        null -> true
        else -> false
    }

    /// `break` / `continue` / `return [e]` / `throw e` as a leaf statement → raise the signal.
    /// RETURNING ACTIONS: `return <expr>` also records its value in the returnValue ledger —
    /// an AWAITING `dsx.action` caller binds `{ ok:true, data: <it> }`; a bare `return`
    /// clears it (its value IS null, and a nested call's leftover must not leak through).
    /// `resolve:` remains how an action answers a bus CALL — unchanged.
    private fun flowLeaf(stmt: String, locals: Map<String, Any?>): Boolean {
        if (stmt == "break" || stmt == "continue") { store.flowSignal = stmt; return true }
        if (stmt == "return") { store.returnValue = null; store.flowSignal = "return"; return true }
        if (stmt.startsWith("return ")) {
            store.returnValue = JSE.eval(stmt.drop(7), store, locals)  // evaluated (JS order); the value an AWAITING dsx.action caller binds
            store.flowSignal = "return"; return true
        }
        if (stmt.startsWith("throw ")) {
            store.thrownValue = JSE.eval(stmt.drop(6), store, locals) ?: NSNull
            store.flowSignal = "throw"; return true
        }
        return false
    }

    /// Capture a construct's BODY as its own character slice — a `{ … }` block's inner text
    /// (quote-aware, to the matching brace) or a single statement — consuming it from the walk.
    private fun jsCaptureBranch(c: CharArray, i: Ix): CharArray {
        jsSkipWs(c, i)
        if (i.v >= c.size) return CharArray(0)
        if (c[i.v] != '{') return jsLeaf(c, i).toCharArray()
        i.v += 1
        var depth = 1
        val out = StringBuilder()
        var q: Char? = null
        while (i.v < c.size) {
            val ch = c[i.v]
            if (q != null) { out.append(ch); i.v += 1; if (ch == q) q = null; continue }
            if (ch == '\'' || ch == '"') { q = ch; out.append(ch); i.v += 1; continue }
            if (ch == '{') depth += 1
            else if (ch == '}') { depth -= 1; if (depth == 0) { i.v += 1; break } }
            out.append(ch); i.v += 1
        }
        return out.toString().toCharArray()
    }

    /// Split on a separator at depth 0 (quote- and bracket-aware) — `for (init; cond; step)`.
    private fun splitTopLevel(h: CharArray, sep: Char): List<String> {
        // quote-aware incl. backtick templates (escape pairs stay opaque, like splitStatements)
        val parts = ArrayList<String>()
        val cur = StringBuilder()
        var depth = 0
        var q: Char? = null
        var esc = false
        for (ch in h) {
            if (q != null) {
                cur.append(ch)
                if (esc) esc = false else if (ch == '\\') esc = true else if (ch == q) q = null
                continue
            }
            if (ch == '\'' || ch == '"' || ch == '`') { q = ch; cur.append(ch); continue }
            if (ch == '(' || ch == '[' || ch == '{') depth += 1
            if (ch == ')' || ch == ']' || ch == '}') depth -= 1
            if (depth == 0 && ch == sep) { parts.add(cur.toString()); cur.setLength(0); continue }
            cur.append(ch)
        }
        parts.add(cur.toString())
        return parts
    }

    /// Run a captured body (one loop iteration / case segment / try clause) against the live locals.
    private fun runCaptured(body: CharArray, locals: MutableMap<String, Any?>, args: Map<String, Any?>) {
        val j = Ix(0)
        runActionBlock(body, j, locals, args, execute = true)
    }

    /// `while (cond) { … }` — budgeted; `break`/`continue` honored.
    private fun runActionWhile(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        i.v += 5; jsSkipWs(c, i)                                       // 'while'
        val condStr = jsParens(c, i)
        val body = jsCaptureBranch(c, i)
        if (!execute) return
        while (JSE.truthy(JSE.eval(condStr, store, locals)) && loopStep()) {
            runCaptured(body, locals, args)
            if (!loopContinues()) break
        }
    }

    /// `do { … } while (cond)` — body-first, budgeted, `break`/`continue` honored.
    private fun runActionDoWhile(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        i.v += 2; jsSkipWs(c, i)                                       // 'do'
        val body = jsCaptureBranch(c, i)
        jsSkipWs(c, i)
        var condStr = ""
        if (jsWord(c, i.v, "while")) { i.v += 5; jsSkipWs(c, i); condStr = jsParens(c, i) }
        if (i.v < c.size && c[i.v] == ';') i.v += 1
        if (!execute) return
        do {
            if (!loopStep()) break
            runCaptured(body, locals, args)
            if (!loopContinues()) break
        } while (JSE.truthy(JSE.eval(condStr, store, locals)))
    }

    /// `for (const x of arr) { … }` and classic `for (init; cond; step) { … }` — budgeted.
    private fun runActionFor(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        i.v += 3; jsSkipWs(c, i)                                       // 'for'
        val head = jsParens(c, i).toCharArray()
        val body = jsCaptureBranch(c, i)
        if (!execute) return
        // for…of — `[const|let|var] pattern of expr` (arrays / strings / Set / Map; the loop
        // var is an ident or a flat `[a, b]` / `{a, b}` pattern)
        val fo = matchForOf(head)
        if (fo != null) {
            for (el in JSE.spreadValues(JSE.eval(fo.second, store, locals))) {
                if (!loopStep()) break
                bindDestructure(fo.first, el, locals) { n, value -> locals[n] = value ?: NSNull }
                runCaptured(body, locals, args)
                if (!loopContinues()) break
            }
            return
        }
        // for…in — dict OWN keys ("__"-internal skipped) / array indices 0..n-1; gated on a
        // header with NO top-level `;`, because a classic for's condition may contain the
        // `in` OPERATOR (`for (i = 0; 'a' in d; ++i)`).
        val parts = splitTopLevel(head, ';')
        if (parts.size == 1) {
            val fi = matchForIn(head)
            if (fi != null) {
                for (el in JSE.forInKeys(JSE.eval(fi.second, store, locals))) {
                    if (!loopStep()) break
                    bindDestructure(fi.first, el, locals) { n, value -> locals[n] = value ?: NSNull }
                    runCaptured(body, locals, args)
                    if (!loopContinues()) break
                }
                return
            }
        }
        // classic — init; cond; step (an empty cond loops until break / the budget)
        if (parts.size != 3) return
        val locals2 = HashMap(locals)
        runCaptured(parts[0].toCharArray(), locals2, args)             // init (a decl or statement)
        val cond = trimWhitespacesRunner(parts[1])
        while ((cond.isEmpty() || JSE.truthy(JSE.eval(cond, store, locals2))) && loopStep()) {
            runCaptured(body, locals2, args)
            if (!loopContinues()) break
            runCaptured(parts[2].toCharArray(), locals2, args)         // step (`i++` / `i += 1` sugar)
        }
        locals.clear(); locals.putAll(locals2)
    }

    private fun matchForOf(h: CharArray): Pair<String, String>? {
        val p = Ix(0)
        jsSkipWs(h, p)
        for (kw in listOf("const", "let", "var")) {
            if (jsWord(h, p.v, kw)) { p.v += kw.length; jsSkipWs(h, p); break }
        }
        val name = StringBuilder()
        if (p.v < h.size && (h[p.v] == '[' || h[p.v] == '{')) {        // a flat destructuring pattern
            val close = if (h[p.v] == '[') ']' else '}'
            var depth = 0
            while (p.v < h.size) {
                val ch = h[p.v]
                if (ch == '[' || ch == '{') depth += 1
                if (ch == ']' || ch == '}') depth -= 1
                name.append(ch); p.v += 1
                if (depth == 0 && ch == close) break
            }
        } else {
            while (p.v < h.size && jsIsWord(h[p.v])) { name.append(h[p.v]); p.v += 1 }
        }
        jsSkipWs(h, p)
        if (name.isEmpty() || !jsWord(h, p.v, "of")) return null
        p.v += 2; jsSkipWs(h, p)
        val expr = trimWhitespacesRunner(String(h, p.v, h.size - p.v))
        return if (expr.isEmpty()) null else name.toString() to expr
    }

    /// `[const|let|var] name in expr` — the for…in header (the loop var is an ident; the
    /// keys a dict yields are strings, so patterns stay out).
    private fun matchForIn(h: CharArray): Pair<String, String>? {
        val p = Ix(0)
        jsSkipWs(h, p)
        for (kw in listOf("const", "let", "var")) {
            if (jsWord(h, p.v, kw)) { p.v += kw.length; jsSkipWs(h, p); break }
        }
        val name = StringBuilder()
        while (p.v < h.size && jsIsWord(h[p.v])) { name.append(h[p.v]); p.v += 1 }
        jsSkipWs(h, p)
        if (name.isEmpty() || !jsWord(h, p.v, "in")) return null
        p.v += 2; jsSkipWs(h, p)
        val expr = trimWhitespacesRunner(String(h, p.v, h.size - p.v))
        return if (expr.isEmpty()) null else name.toString() to expr
    }

    /// `switch (subj) { case a: … case b: … default: … }` — JS semantics: first deep-equal case
    /// (else `default`) starts execution, fallthrough until `break` (consumed) / the end;
    /// `return`/`throw`/`continue` unwind to the enclosing construct.
    private fun runActionSwitch(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        i.v += 6; jsSkipWs(c, i)                                       // 'switch'
        val subjStr = jsParens(c, i)
        jsSkipWs(c, i)
        if (i.v >= c.size || c[i.v] != '{') return
        val body = jsCaptureBranch(c, i)
        if (!execute) return
        // Segment the body on `case <expr>:` / `default:` labels (depth-0, quote- and ternary-aware).
        class Segment(val label: String?, val body: CharArray)
        val segments = ArrayList<Segment>()
        var cur = StringBuilder()
        var curLabel: String? = null
        var inSegment = false
        fun flush() { if (inSegment) segments.add(Segment(curLabel, cur.toString().toCharArray())); cur = StringBuilder() }
        var k = 0
        var q: Char? = null
        var depth = 0
        while (k < body.size) {
            val ch = body[k]
            if (q != null) { cur.append(ch); k += 1; if (ch == q) q = null; continue }
            if (ch == '\'' || ch == '"') { q = ch; cur.append(ch); k += 1; continue }
            if (ch == '(' || ch == '[' || ch == '{') { depth += 1; cur.append(ch); k += 1; continue }
            if (ch == ')' || ch == ']' || ch == '}') { depth -= 1; cur.append(ch); k += 1; continue }
            if (depth == 0 && jsWord(body, k, "case")) {
                flush(); inSegment = true
                k += 4
                val kk = Ix(k); jsSkipWs(body, kk); k = kk.v
                val label = StringBuilder()
                var tern = 0
                var lq: Char? = null
                var ld = 0
                while (k < body.size) {
                    val lc = body[k]
                    if (lq != null) { label.append(lc); k += 1; if (lc == lq) lq = null; continue }
                    if (lc == '\'' || lc == '"') { lq = lc; label.append(lc); k += 1; continue }
                    if (lc == '(' || lc == '[' || lc == '{') ld += 1
                    if (lc == ')' || lc == ']' || lc == '}') ld -= 1
                    if (ld == 0 && lc == '?') tern += 1
                    if (ld == 0 && lc == ':') { if (tern > 0) tern -= 1 else { k += 1; break } }
                    label.append(lc); k += 1
                }
                curLabel = trimWhitespacesRunner(label.toString())
                continue
            }
            if (depth == 0 && jsWord(body, k, "default")) {
                flush(); inSegment = true
                k += 7
                val kk = Ix(k); jsSkipWs(body, kk); k = kk.v
                if (k < body.size && body[k] == ':') k += 1
                curLabel = null
                continue
            }
            cur.append(ch); k += 1
        }
        flush()
        val subjKey = JSE.watchKey(JSE.eval(subjStr, store, locals))
        var start = segments.indexOfFirst { seg ->
            val l = seg.label ?: return@indexOfFirst false
            JSE.watchKey(JSE.eval(l, store, locals)) == subjKey
        }
        if (start < 0) start = segments.indexOfFirst { it.label == null }
        if (start < 0) return
        for (s in start until segments.size) {
            runCaptured(segments[s].body, locals, args)
            if (store.flowSignal == "break") { store.flowSignal = null; return }
            if (store.flowSignal != null) return
        }
    }

    /// `try { … } catch (e) { … } finally { … }` — catches an in-flight `throw` (the thrown value
    /// binds to the catch parameter); `finally` always runs, then any pending signal resumes
    /// (a signal raised IN finally wins, like JS).
    private fun runActionTry(c: CharArray, i: Ix, locals: MutableMap<String, Any?>, args: Map<String, Any?>, execute: Boolean) {
        i.v += 3                                                       // 'try'
        val tryBody = jsCaptureBranch(c, i)
        var catchParam = ""
        var catchBody = CharArray(0)
        var hasCatch = false
        var finallyBody = CharArray(0)
        var hasFinally = false
        jsSkipWs(c, i)
        if (jsWord(c, i.v, "catch")) {
            hasCatch = true; i.v += 5; jsSkipWs(c, i)
            if (i.v < c.size && c[i.v] == '(') catchParam = trimWhitespacesRunner(jsParens(c, i))
            catchBody = jsCaptureBranch(c, i)
            jsSkipWs(c, i)
        }
        if (jsWord(c, i.v, "finally")) {
            hasFinally = true; i.v += 7
            finallyBody = jsCaptureBranch(c, i)
        }
        if (!execute) return
        store.tryDepth += 1                                            // inside try → unavailable package / undefined action throws
        runCaptured(tryBody, locals, args)
        store.tryDepth -= 1
        if (store.flowSignal == "throw" && hasCatch) {
            store.flowSignal = null
            if (catchParam.isNotEmpty()) locals[catchParam] = store.thrownValue ?: NSNull
            store.thrownValue = null
            runCaptured(catchBody, locals, args)
        }
        if (hasFinally) {
            val pending = store.flowSignal
            store.flowSignal = null
            runCaptured(finallyBody, locals, args)
            if (store.flowSignal == null) store.flowSignal = pending
        }
    }

    // ── the character walk (Swift [Character] + inout Int → CharArray + Ix) ────────────────

    private class Ix(var v: Int)

    private fun jsIsWord(ch: Char): Boolean = ch.isLetter() || ch.isDigit() || ch == '_'

    private fun jsSkipWs(c: CharArray, i: Ix) {
        while (i.v < c.size && (c[i.v] == ' ' || c[i.v] == '\t' || c[i.v] == '\n' || c[i.v] == '\r')) i.v += 1
    }

    private fun jsWord(c: CharArray, i: Int, w: String): Boolean {
        if (i + w.length > c.size) return false
        for (k in w.indices) if (c[i + k] != w[k]) return false
        val before = if (i > 0) c[i - 1] else ' '
        val after = if (i + w.length < c.size) c[i + w.length] else ' '
        return !jsIsWord(before) && !jsIsWord(after)
    }

    /// Read a `( … )` group's inner text (consumes both parens), quote- and depth-aware.
    private fun jsParens(c: CharArray, i: Ix): String {
        if (i.v >= c.size || c[i.v] != '(') return ""
        i.v += 1
        var depth = 1
        val out = StringBuilder()
        var q: Char? = null
        while (i.v < c.size) {
            val ch = c[i.v]
            if (q != null) { out.append(ch); i.v += 1; if (ch == q) q = null; continue }
            if (ch == '\'' || ch == '"') { q = ch; out.append(ch); i.v += 1; continue }
            if (ch == '(') depth += 1
            else if (ch == ')') { depth -= 1; if (depth == 0) { i.v += 1; break } }
            out.append(ch); i.v += 1
        }
        return out.toString()
    }

    /// Read one leaf statement up to a top-level `;` / newline / `}` (quote- and bracket-aware).
    /// Consumes a terminating `;`/newline, but NOT a closing bracket (that ends the block).
    private fun jsLeaf(c: CharArray, i: Ix): String {
        val out = StringBuilder()
        var depth = 0
        var q: Char? = null
        while (i.v < c.size) {
            val ch = c[i.v]
            if (q != null) {
                // backslash pairs stay opaque inside a quoted span (`'it\'s'`, `` `a\`b` ``)
                if (ch == '\\' && i.v + 1 < c.size) { out.append(ch); out.append(c[i.v + 1]); i.v += 2; continue }
                out.append(ch); i.v += 1; if (ch == q) q = null; continue
            }
            if (ch == '\'' || ch == '"' || ch == '`') { q = ch; out.append(ch); i.v += 1; continue }
            if (ch == '(' || ch == '[' || ch == '{') { depth += 1; out.append(ch); i.v += 1; continue }
            if (ch == ')' || ch == ']' || ch == '}') {
                if (depth == 0) break
                depth -= 1; out.append(ch); i.v += 1; continue
            }
            if (depth == 0 && ch == ';') { i.v += 1; break }
            if (depth == 0 && ch == '\n') {
                // Multiline statements (ASI): a newline ends the statement UNLESS the line is
                // clearly unfinished or the next line can only be a continuation.
                if (jsLineContinues(out.toString(), c, i.v)) { out.append(' '); i.v += 1; continue }
                i.v += 1; break
            }
            out.append(ch); i.v += 1
        }
        return out.toString()
    }

    /// Continuation test for a depth-0 newline inside a statement:
    ///  • look-BEHIND — the line ends in a binary operator / dot / comma (`x = a +` · `cond &&`
    ///    · `obj.`), but NOT `i++` / `i--` (those are complete);
    ///  • look-AHEAD — the next line starts with a token that cannot begin a statement:
    ///    a `.method()` chain, a formatted ternary's `?` / `:`, or `&&` / `||`.
    private fun jsLineContinues(out: String, c: CharArray, after: Int): Boolean {
        var t = out.length - 1
        while (t >= 0 && (out[t] == ' ' || out[t] == '\t' || out[t] == '\r')) t -= 1
        if (t >= 0) {
            val last = out[t]
            val isIncDec = (last == '+' || last == '-') && t >= 1 && out[t - 1] == last
            if (!isIncDec && "+-*/%&|<>=!?:,.".contains(last)) return true
        }
        var j = after + 1
        while (j < c.size && (c[j] == ' ' || c[j] == '\t' || c[j] == '\n' || c[j] == '\r')) j += 1
        if (j >= c.size) return false
        val ch = c[j]
        if (ch == '.' || ch == '?' || ch == ':') return true
        if ((ch == '&' || ch == '|') && j + 1 < c.size && c[j + 1] == ch) return true
        return false
    }

    // ── writes + effect verbs ──────────────────────────────────────────────────────────────

    /// `key = expr` → evaluate the expression against the store and write it back.
    private fun assign(s: String, item: Map<String, Any?>?) {
        val kv = splitOnAssign(s) ?: return
        if (kv.first.isEmpty()) return
        write(kv.first, JSE.eval(kv.second, store, item) ?: "")
    }

    /// Indexed assignment `name[expr] = rhs` (one index level; quote-aware bracket scan) —
    /// the index evaluates, an integral routes as the array segment (`arr.0`), anything
    /// else as the dict key (`o.key`). Returns false when the statement isn't this shape.
    private fun runIndexedAssign(a: String, item: Map<String, Any?>?): Boolean {
        val chars = a.toCharArray()
        var i = 0
        while (i < chars.size && (chars[i].isLetter() || chars[i].isDigit() || chars[i] == '_' || chars[i] == '.')) i += 1
        if (i == 0 || i >= chars.size || chars[i] != '[') return false
        val name = String(chars, 0, i)
        var depth = 0
        var q: Char? = null
        var j = i
        var close = -1
        while (j < chars.size) {
            val ch = chars[j]
            if (q != null) { if (ch == q) q = null }
            else if (ch == '\'' || ch == '"') q = ch
            else if (ch == '[') depth += 1
            else if (ch == ']') { depth -= 1; if (depth == 0) { close = j; break } }
            j += 1
        }
        if (close <= i + 1) return false
        var k = close + 1
        while (k < chars.size && (chars[k] == ' ' || chars[k] == '\t')) k += 1
        if (k >= chars.size || chars[k] != '=' || (k + 1 < chars.size && chars[k + 1] == '=')) return false
        val idx = JSE.eval(String(chars, i + 1, close - i - 1), store, item)
        val n = JSE.number(idx)
        val seg = if (n != null && n.isFinite() && n == Math.floor(n)) n.toLong().toString() else JSE.string(idx)
        write("$name.$seg", JSE.eval(String(chars, k + 1, chars.size - k - 1), store, item) ?: "")
        return true
    }

    /// Write a state path to the right store: `global.*` / `route.*` → the app-wide DSXState;
    /// `cookie.*` → the cookie seam; anything else → the surface store. Path-aware (nested +
    /// array index), so `set: feed.data.5.name = …` edits an item in place.
    private fun write(rawKey: String, value: Any) {
        val key = JSE.normalizeScope(rawKey)
        when {
            key.startsWith("global.") -> DSX.state.setPath(key.substring(7), value)
            key.startsWith("route.") -> DSX.state.setPath(key, value)      // route.* ⇄ global.route.*
            key.startsWith("cookie.") -> JSERunner.cookieSet(key.substring(7), JSE.string(value))
            else -> store.setPath(key, value)
        }
    }

    /// Read the array at a state path, apply `mutate`, write it back — the basis for the
    /// array-mutation verbs (push/pop/insert/…).
    private fun mutateArray(path: String, item: Map<String, Any?>?, mutate: (MutableList<Any?>) -> Unit) {
        val arr = ArrayList(JSE.asArray(JSE.eval(path, store, item)))
        mutate(arr)
        write(path, arr)
    }

    /// Read-modify-write for a non-array value at `path` (the JS-core object mutations).
    private fun mutateValue(path: String, item: Map<String, Any?>?, mutate: (Any) -> Any) {
        val v: Any = JSE.eval(path, store, item) ?: NSNull
        write(path, mutate(v))
    }

    /// `remove: arr where <pred>` — drop rows where the per-row predicate is truthy (`{{ }}`
    /// in the predicate resolves against the OUTER scope; bare names are row fields). Or
    /// `remove: arr = <value> [key=<field>]` — drop rows whose `field` equals the value.
    private fun performRemove(spec: String, item: Map<String, Any?>?) {
        val s = trimWhitespacesRunner(spec)
        val r = s.indexOf(" where ")
        if (r >= 0) {
            val path = trimWhitespacesRunner(s.substring(0, r))
            val pred = JSE.interpolate(s.substring(r + 7), store, item)
            mutateArray(path, item) { arr ->
                val kept = arr.filter { !JSE.truthy(JSE.eval(pred, store, it as? Map<String, Any?>)) }
                arr.clear(); arr.addAll(kept)
            }
            return
        }
        val sp = splitOnAssign(s) ?: return
        var field = "id"
        var valueExpr = sp.second
        val kr = sp.second.indexOf(" key=")
        if (kr >= 0) {
            field = trimWhitespacesRunner(sp.second.substring(kr + 5))
            valueExpr = sp.second.substring(0, kr)
        }
        val target = JSE.string(JSE.eval(valueExpr, store, item))
        mutateArray(sp.first, item) { arr ->
            val kept = arr.filter { row ->
                val d = row as? Map<String, Any?> ?: return@filter true
                JSE.string(d[field] ?: "") != target
            }
            arr.clear(); arr.addAll(kept)
        }
    }

    /// `splice: arr = start, deleteCount, ...items` — full JS `Array.splice`: remove
    /// `deleteCount` at `start`, then insert the (comma-separated) items there.
    private fun performSplice(spec: String, item: Map<String, Any?>?) {
        val sp = splitOnAssign(spec) ?: return
        val args = splitArgs(sp.second)
        fun n(i: Int): Int = if (i < args.size) (JSE.number(JSE.eval(args[i], store, item)) ?: 0.0).toInt() else 0
        val start = n(0)
        val del = n(1)
        val inserts = args.drop(2).map { JSE.eval(it, store, item) ?: NSNull }
        mutateArray(sp.first, item) { arr ->
            val s0 = minOf(maxOf(start, 0), arr.size)
            val e0 = minOf(s0 + maxOf(del, 0), arr.size)
            repeat(e0 - s0) { arr.removeAt(s0) }
            arr.addAll(s0, inserts)
        }
    }

    /// `fetch: dest = METHOD url [body=expr] [headers=expr]` — call any HTTP endpoint, parse the
    /// response, and write an envelope into state: `dest.loading` / `dest.error` / `dest.data`.
    private fun performFetch(spec: String, item: Map<String, Any?>?, continuation: (() -> Unit)? = null) {
        val s = trimWhitespacesRunner(spec)
        val eq = s.indexOf('=')
        if (eq < 0) return
        val dest = trimWhitespacesRunner(s.substring(0, eq))
        val tokens = ArrayDeque(s.substring(eq + 1).split(" ").filter { it.isNotEmpty() })
        if (dest.isEmpty() || tokens.size < 2) return
        val method = tokens.removeFirst()
        val url = JSE.interpolate(tokens.removeFirst(), store, item)
        val headers = HashMap<String, String>()
        var bodyData: ByteArray? = null
        var thenAction: String? = null
        var catchAction: String? = null                                // run a named <action> on success / error
        for (t in tokens) {
            if (t.startsWith("body=")) {
                val v = JSE.eval(t.drop(5), store, item)
                if (v is Map<*, *>) bodyData = JSON(v as Map<String, Any?>).toString().toByteArray(Charsets.UTF_8)
                else if (v is List<*>) bodyData = JSON(v).toString().toByteArray(Charsets.UTF_8)
            } else if (t.startsWith("headers=")) {
                val h = JSE.eval(t.drop(8), store, item) as? Map<String, Any?>
                if (h != null) for ((k, v) in h) headers[k] = JSE.string(v)
            } else if (t.startsWith("then=")) thenAction = t.drop(5)
            else if (t.startsWith("catch=")) catchAction = t.drop(6)
        }
        write("$dest.loading", true)
        write("$dest.error", "")
        JSERunner.fetch.request(url, method, headers, bodyData) { res ->
            JSERunner.mainExecutor.execute {
                if (res == null) {
                    write("$dest.loading", false); write("$dest.error", "network")
                    if (catchAction != null) run("do: $catchAction", item)
                    continuation?.invoke()                             // await: run the rest of the action body
                    return@execute
                }
                write("$dest.loading", false)
                if (res.status in 200..299) {
                    write("$dest.data", json(String(res.data, Charsets.UTF_8)).foundationValue ?: NSNull)
                    if (thenAction != null) run("do: $thenAction", item)   // success → sequence on
                } else {
                    write("$dest.error", "http ${res.status}")
                    if (catchAction != null) run("do: $catchAction", item)  // error → recovery
                }
                continuation?.invoke()                                 // await: the rest reads the envelope
            }
        }
    }

    // ── package dispatch ───────────────────────────────────────────────────────────────────

    private fun dispatch(target: String, item: Map<String, Any?>?) {
        // Interpolate {{...}} then dispatch. Accepts the dot-API form — `haptic.success`,
        // `store.checkout(id=42)` — converting it to the internal scheme + method URL.
        var t = trimWhitespacesRunner(target)
        // `dsx.module.self.method(…)` — `self` is the package THIS component lives in.
        if (t == "self" || t.startsWith("self.") || t.startsWith("self(")) {
            val me = scope
            if (me.isNullOrEmpty()) { unavailable(target); return }
            t = me + t.drop(4)
        }
        // Real JS: pkg.method({ a: b, c: d }) — an options object becomes the named args.
        val lp = t.indexOf('(')
        if (lp >= 0 && t.endsWith(")")) {
            val head = t.substring(0, lp)
            val argStr = trimWhitespacesRunner(t.substring(lp + 1, t.length - 1))
            if (head.contains(".") && argStr.startsWith("{")) {
                val evaluated = JSE.eval(argStr, store, item) as? Map<String, Any?>
                val url = normalizeCall(head)
                if (evaluated != null && isPlausibleURL(url)) {
                    val obj = store.frameId?.let { evaluated + ("__frame" to it) } ?: evaluated
                    if (!JSERunner.moduleHandle(url, obj) { }) unavailable(head)
                    return
                }
            }
        }
        val resolved = normalizeCall(JSE.interpolate(t, store, item))
        val comps = parseURLComponents(resolved) ?: run { unavailable(t); return }
        val args = LinkedHashMap<String, Any?>()
        for ((name, raw) in comps.second) {                            // a named arg's value is an expression — eval it, else keep the literal
            val v = JSE.eval(raw, store, item)
            args[name] = if (v != null) JSE.string(v) else raw
        }
        store.frameId?.let { args["__frame"] = it }                    // frame identity framing key — see StackStore.frameId
        if (!JSERunner.moduleHandle(comps.first, args) { }) unavailable(target)
    }

    /// A package call / action invocation routes through `dispatch`; the registry returns
    /// **false** when the scheme was never registered. **Inside a `try`** that becomes a
    /// `throw { code: "unavailable", call }` so `catch (e)` can react — universal feature
    /// detection. **Outside a try** it stays a silent no-op.
    private fun unavailable(call: String) {
        if (store.tryDepth <= 0 || store.flowSignal != null) return
        val name = trimWhitespacesRunner(
            (call.split("(").firstOrNull { it.isNotEmpty() } ?: call).replace("://", ".")
        )
        store.thrownValue = mapOf("code" to "unavailable", "call" to name)
        store.flowSignal = "throw"
    }

    /// Parse `head?k=v&k2=v2` into the head token and a JSON payload (null when no query).
    /// Values are interpolated and coerced to Bool / Double / String.
    private fun payload(raw: String, item: Map<String, Any?>?): Pair<String, JSON?> {
        val resolved = trimWhitespacesRunner(JSE.interpolate(raw, store, item))
        val parts = resolved.split("?", limit = 2)
        val head = trimWhitespacesRunner(parts.first())
        if (parts.size < 2 || parts[1].isEmpty()) return head to null
        val dict = LinkedHashMap<String, Any?>()
        for (pair in parts[1].split("&")) {
            if (pair.isEmpty()) continue                               // Swift split omits empties
            val kv = pair.split("=", limit = 2).filter { it.isNotEmpty() }
            val k = kv.firstOrNull() ?: continue
            dict[k] = coerce(if (kv.size > 1) kv[1] else "")
        }
        return head to JSON(dict)
    }

    private fun coerce(s: String): Any {
        if (s == "true") return true
        if (s == "false") return false
        val d = swiftDouble(s)
        if (d != null) return d
        return s
    }

    fun has(scheme: String): Boolean = JSE.moduleAvailable(scheme)

    // ── watch scheduling (WatchView.fire — the Compose WatchView twin rides K4) ─────────────

    /// `<watch>` fire: budget + render-safe dispatch. Fires are counted per runloop tick and
    /// the budget clears async after the cascade settles, so a watcher that rewrites its own
    /// dependency aborts (logged once) instead of hanging. `v` is the recomputed value; the
    /// payload becomes `dsx.this` (an object as-is, else { value: … }).
    fun fireWatch(v: Any?, change: String, valueExpr: String = "") {
        if (change.isEmpty()) return
        store.watchBudget += 1
        if (!store.watchResetScheduled) {                              // clear the budget once this tick's cascade drains
            store.watchResetScheduled = true
            JSE.afterRender { store.watchBudget = 0; store.watchResetScheduled = false }
        }
        if (store.watchBudget > 256) {
            if (store.watchBudget == 257) {
                kernelLog("[Stack] watch loop aborted near value=$valueExpr: a watcher keeps rewriting its own dependency. Use <variable computed> for derived values — a <watch> must not write what it observes.")
            }
            return
        }
        val payload: Map<String, Any?> = (v as? Map<String, Any?>) ?: mapOf("value" to v)
        // A `<watch>` fires inside the view-update pass; run its author JSE render-safe.
        JSE.afterRender { run(change, payload, payload) }
    }
}

// MARK: - file-local helpers

/// Swift `.whitespaces` (space separators + tab — NO newlines): the trim the runner uses
/// everywhere Swift writes `.trimmingCharacters(in: .whitespaces)`. (Jse.kt keeps its own
/// private copy — a file-local helper, not a shared type.)
private fun isWhitespaceOnlyRunner(c: Char): Boolean =
    c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

private fun trimWhitespacesRunner(s: String): String {
    var start = 0
    var end = s.length
    while (start < end && isWhitespaceOnlyRunner(s[start])) start += 1
    while (end > start && isWhitespaceOnlyRunner(s[end - 1])) end -= 1
    return s.substring(start, end)
}

/// Swift `Double(String)` grammar (gateMs + the payload coercion) — the Jse.kt rules: full-string
/// parse, no whitespace tolerance, no Java suffixes, "inf"/"nan", bare hex accepted.
private fun swiftDouble(s: String): Double? {
    if (s.isEmpty()) return null
    if (s.first().isWhitespace() || s.last().isWhitespace()) return null
    val neg = s.startsWith("-")
    val body = if (s.startsWith("+") || neg) s.substring(1) else s
    if (body.isEmpty()) return null
    val lower = body.lowercase()
    if (lower == "inf" || lower == "infinity") return if (neg) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
    if (lower == "nan") return Double.NaN
    if (lower.startsWith("0x")) {
        val hex = if (lower.contains('p')) s else s + "p0"
        return try { java.lang.Double.parseDouble(hex) } catch (_: NumberFormatException) { null }
    }
    val last = body.last().lowercaseChar()
    if (last == 'f' || last == 'd') return null
    return s.toDoubleOrNull()
}

/// The tail of a character walk as a String (Swift `String(c[j...])`).
private fun tail(c: CharArray, from: Int): String =
    if (from < c.size) String(c, from, c.size - from) else ""

/// HTTPURLResponse.localizedString's stand-in: the standard reason phrase (descriptive, never
/// asserted by fixtures — iOS's strings are locale-dependent).
private fun httpStatusText(status: Int): String = when (status) {
    200 -> "OK"; 201 -> "Created"; 202 -> "Accepted"; 204 -> "No Content"
    301 -> "Moved Permanently"; 302 -> "Found"; 304 -> "Not Modified"
    400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
    405 -> "Method Not Allowed"; 409 -> "Conflict"; 410 -> "Gone"; 418 -> "I'm a Teapot"
    422 -> "Unprocessable Entity"; 429 -> "Too Many Requests"
    500 -> "Internal Server Error"; 501 -> "Not Implemented"; 502 -> "Bad Gateway"
    503 -> "Service Unavailable"; 504 -> "Gateway Timeout"
    else -> if (status in 100..599) "HTTP $status" else ""
}

/// Swift `URL(string:)`'s pass/fail as far as dispatch needs it: non-empty, no whitespace.
private fun isPlausibleURL(s: String): Boolean =
    s.isNotEmpty() && s.none { it == ' ' || it == '\n' || it == '\t' || it == '\r' }

/// URLComponents(string:) + queryItems, as far as dispatch needs them: (url, [(name, value)])
/// with percent-decoding ('+' stays literal, like URLComponents; unlike URLDecoder).
private fun parseURLComponents(s: String): Pair<String, List<Pair<String, String>>>? {
    if (!isPlausibleURL(s)) return null
    val qm = s.indexOf('?')
    if (qm < 0) return s to emptyList()
    val items = ArrayList<Pair<String, String>>()
    val query = s.substring(qm + 1)
    if (query.isNotEmpty()) {
        for (pair in query.split("&")) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            if (eq < 0) items.add(percentDecode(pair) to "")
            else items.add(percentDecode(pair.substring(0, eq)) to percentDecode(pair.substring(eq + 1)))
        }
    }
    return s to items
}

private fun percentDecode(s: String): String {
    if (!s.contains('%')) return s
    val bytes = java.io.ByteArrayOutputStream()
    var i = 0
    while (i < s.length) {
        val ch = s[i]
        if (ch == '%' && i + 2 < s.length) {
            val hi = Character.digit(s[i + 1], 16)
            val lo = Character.digit(s[i + 2], 16)
            if (hi >= 0 && lo >= 0) {
                bytes.write((hi shl 4) or lo)
                i += 3
                continue
            }
        }
        for (b in ch.toString().toByteArray(Charsets.UTF_8)) bytes.write(b.toInt())
        i += 1
    }
    return String(bytes.toByteArray(), Charsets.UTF_8)
}
