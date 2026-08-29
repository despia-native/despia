//
//  Context.kt
//  DespiaScript
//
//  The dsx surface handed to every package handler, plus the registration store behind it.
//  Kotlin twin of Engine/Context.swift — same names, same arguments, same behaviors.
//
//  ── WHAT RODE ALONG vs WHAT'S DEFERRED (pinned; PLAN.md ground rule 1) ──
//  Ported here (pure JVM): Registration + dispatch (prefilter → named → unknown_action,
//  the includeInternal trust gate, the declarative veto gate), the full emit surface
//  (resolve/ok · error/fail/reject · event · broadcast/broadcastNative — envelopes
//  delivered through dsx.messenger), per-call reads (args/file/list/command/id/stopped),
//  registration verbs (action/group/scheme/hydrate/ready/hook), the bus verbs
//  (fire/claim/fireAny/collect/handle/runHydrations/runReady), dsx.delegate (listen/
//  send/allows + the typed event fold), the dsx.module proxies (operator-get chain),
//  dsx.has, dsx.content (→ Content.kt), Container (KV-seamed), DSXCookies (seamed),
//  dsx.fetch (seamed), Flags, EmptyConfig, Once, HookProducer; Context implements
//  JSERunnerDsx (the author-logic runner's narrow emit view — JseRunner.kt).
//  Deferred to `:platform`/`:render` (per PLAN.md's exclusion list): `dsx.app` /
//  `dsx.env` (AppManifest/BuildConfig),
//  `lastMount: StackSurface` (Compose surface — `:render`), `URLSchemeResponder`
//  (URLRequest/HTTPURLResponse shapes — the Dom module's serve-scheme seam),
//  `Flags.bridgeVersion` (VirtualBridge — the web transport). Container's FILE half
//  (`url()`/`isAvailable`) and cross-process signal transport are seams the host fills.
//
//  ── SEAMS (settable, pure-JVM defaults; the Events.kt / Messenger.kt pattern) ──
//    • ModuleRegistry.shared.mainExecutor — the main-thread funnel for _dispatch/_call
//      (Swift: DispatchQueue.main.sync / .async). Default DIRECT; the installer must
//      preserve the synchronous contract (see Module.kt header).
//    • Context.fetchImpl        — dsx.fetch's HTTP backend. Default REJECTS with
//      FetchError.Transport ("no backend installed"); `:platform` installs OkHttp.
//    • Container.backend        — the App Group KV store. In-memory by default; null
//      ⇒ unprovisioned (reads default, writes dropped — Swift's `defaults == nil`).
//    • Container.filesRoot      — the shared file container (default null = absent).
//    • Container.observerMainExecutor / the internal ContainerObservers.transport —
//      main-thread callback delivery plus the cross-process (Darwin) signal. The
//      default transport fires in-process only (Darwin posts loop back locally too).
//    • DSXCookies.nativeStore / .mainExecutor — the native HTTP jar mirror (Swift:
//      HTTPCookieStorage.shared) and the jar-publish hop. Defaults: no-op / inline.
//
//  ── NOTES (pinned decisions) ──
//  • Emit payloads are `Any?` lowered via `JSON.from` — Kotlin can't retroactively
//    conform String/Map to JSONConvertible, so the parameter type is open; behavior
//    (scalars, maps, lists, JSON, null → JSON null) is identical.
//  • dsx.module leaf: Swift picks awaitable vs fire-and-forget by `await`. A Kotlin
//    suspend + non-suspend `invoke` pair with one signature is a CONFLICTING OVERLOAD
//    (probed, kotlinc 2.0.21), so the pin is: `operator fun invoke` IS the awaitable
//    (`dsx.module["x"]["y"](args)` suspending — the api-mapping/cross-module-calls
//    Kotlin row), and the fire-and-forget twin of Swift's bare call is the non-suspend
//    `.post(args)`. api-mapping.md's registration-table example
//    (`dsx.module["dom"]["inject"](mapOf(…))` inside setup()) therefore needs `.post`
//    on Android — flagged for the doc.
//  • `ModuleScheme.object(name)` keeps the 1:1 name; Kotlin call sites backtick it
//    (`dsx.module["cdn"].`object`("store")`) — flagged for the doc.
//  • Envelope maps carry NSNull → plain null with KEYS PRESENT (the Messenger.kt
//    precedent): `{id, scheme, host, event, final, data[, code, recoverable, message]}`.
//  • DSXCookies' reactive face (@Published jar) rides the Stack.kt port; the host binds
//    `JSE.cookieJar = { DSXCookies.shared.jar }` at boot (never from a type initializer
//    — the State.kt order-dependence rule). `expires` maps to HttpCookie.maxAge
//    (relative seconds) — the JVM cookie shape has no absolute-expiry slot.
//

@file:Suppress("UNCHECKED_CAST")

package despia.engine

import java.net.URI
import java.util.UUID
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/// What a *claim* hook returns when its answer is async: a producer the host
/// awaits. The sync part of the hook decides "is this mine?" (return null to pass);
/// the producer does the async work and returns the result. Runs on the main
/// thread, like every hook (Swift: @MainActor) — the executor seam owns the hop.
typealias HookProducer = suspend () -> Any?

/// One `dsx.delegate.listen` registration: its priority + handler.
internal class HookEntry(val priority: Int, val handler: (Any?) -> Any?)

/// The declarative action-gate registry (delegates.md §5) — on iOS a codegen'd static
/// enum from the manifests' `methods.<action>.gate`; here a registry the generated
/// Android boot code FILLS. Default empty ⇒ no gates (every action goes straight through).
object GeneratedActionGates {
    /// scheme → action(host) → gate event name.
    var byScheme: Map<String, Map<String, String>> = emptyMap()
    fun gate(scheme: String, action: String): String? = byScheme[scheme]?.get(action)
}

/// The declared-delegate registry behind `dsx.delegate` — on iOS a codegen'd static enum
/// from the manifests' `delegate` blocks; here a registry the generated Android boot
/// code FILLS. Default empty ⇒ every undeclared event folds as `claim`, no fallback.
object GeneratedDelegateRegistry {
    class Spec(val combine: String?, val fallback: JSON? = null)
    var byEvent: Map<String, Spec> = emptyMap()
}

class Registration internal constructor(
    /// The package's stable primary scheme (from dsx.json).
    internal val primaryScheme: String,
    aliases: List<String>,
) {

    /// Every URI scheme routed to this package: primary + manifest `aliases`
    /// (legacy / data-in-host schemes like `readhealthkit`).
    internal val schemes: MutableSet<String> = run {
        val set = LinkedHashSet<String>()
        if (primaryScheme.isNotEmpty()) set.add(primaryScheme)
        for (alias in aliases) if (alias.isNotEmpty()) set.add(alias)
        set
    }

    /// Pre-filter: runs first on every call. Handle the call, or `dsx.skip()`
    /// to defer to a named action. Set by `dsx.action { ... }`.
    internal var prefilter: ((Context) -> Unit)? = null

    /// Named action handlers keyed by URL host. Set by `dsx.action("name") { }`.
    internal val named = HashMap<String, (Context) -> Unit>()

    /// INTERNAL (not-exposed) action handlers — `dsx.action("name", exposed = false) { }`. Reachable
    /// ONLY by in-process `dsx.module` calls; the web/URL bus dispatches with
    /// `includeInternal: false`, so `window.despia.*` and deep-link URLs never reach them.
    internal val internalNamed = HashMap<String, (Context) -> Unit>()

    /// Registration-time prefix for nested action groups (`dsx.group("rag") { … }`), e.g. "rag.".
    internal var groupPrefix: String = ""

    /// Actions scoped to a SECONDARY scheme the package owns (`dsx.scheme("rag") { … }`), keyed by
    /// scheme then host. Each scoped scheme's action set is isolated from the primary.
    internal val schemeNamed = HashMap<String, HashMap<String, (Context) -> Unit>>()

    /// The scheme currently being populated by a `dsx.scheme(name) { … }` block (null = primary).
    internal var currentScheme: String? = null

    /// Blocks run once per page load (after the runtime is installed).
    internal val hydrations = ArrayList<(Context) -> Unit>()

    /// Blocks run once per page load, AFTER the page has finished loading
    /// (didFinish equivalent - `<body>` is parsed, the page is interactive).
    internal val readyBlocks = ArrayList<(Context) -> Unit>()

    /// Handlers for named host events (lifecycle, push, navigation, deep links),
    /// keyed by event name. Folded by the host via `ModuleRegistry.dispatch`.
    /// Set by `dsx.delegate.listen`.
    internal val hooks = HashMap<String, MutableList<HookEntry>>()

    /// Run the active call through pre-filter -> named dispatch. Returns `true`
    /// when this package handled the call (so the host stops its fall-through).
    ///
    /// Order:
    ///   1. pre-filter runs first. If it settles (resolve/error) -> handled.
    ///      If it does NOT call `skip()` -> it's the effective handler (handled),
    ///      even if it answers asynchronously.
    ///   2. otherwise route to the handler for `host` — from this `scheme`'s scoped table when the
    ///      package owns the scheme via `dsx.scheme` (isolated), else the primary `named` table.
    ///   3. pre-filter skipped (or a scoped scheme) + no match -> auto `error(unknown_action)`.
    ///   4. no pre-filter + no match -> not ours (`false`).
    /// `includeInternal` is the trust gate: the in-process `dsx.module` path passes `true`; the
    /// web/URL relay leaves it `false`, so internal actions are invisible to the untrusted bus.
    internal fun dispatch(scheme: String, host: String, url: URI,
                          params: Bridge.Params, includeInternal: Boolean = false): Boolean {
        val dsx = Context(store = this, scheme = scheme, host = host, url = url, params = params)
        prefilter?.let { prefilter ->
            prefilter(dsx)
            if (dsx.isSettled) return true
            if (!dsx.didSkip) return true
        }
        // A scheme with its own `dsx.scheme` table is isolated (no fallback to `named`); any other
        // scheme the package owns (primary, or a plain alias) uses the shared `named` table.
        val scoped = schemeNamed[scheme]
        val internalHandler = if (includeInternal) internalNamed[host] else null
        val handler = internalHandler ?: scoped?.get(host) ?: (if (scoped == null) named[host] else null)
        if (handler != null) {
            // Declarative veto GATE (delegates.md §5): when dsx.json declares `methods.<action>.gate`,
            // fold the named `<scheme>.<gate>` veto delegate BEFORE the handler. Any listener returning
            // false blocks the action — the call resolves { ok: false, blocked: <gate> } and the
            // handler never runs. No gate ⇒ a single dictionary miss, then straight through.
            val gate = GeneratedActionGates.gate(scheme = scheme, action = host)
            if (gate != null) {
                val allowed = (ModuleRegistry.shared.dispatch("$scheme.$gate", dsx.args(),
                                                              ModuleRegistry.Combine.veto) as? Boolean) ?: true
                if (!allowed) {
                    dsx.resolve(JSON(mapOf("ok" to false, "blocked" to gate)))
                    return true
                }
            }
            handler(dsx)
            return true
        }
        if (prefilter != null || scoped != null) {
            dsx.error("unknown_action", JSON.obj().put("action", host))
            return true
        }
        return false
    }
}

// MARK: - Context (the `dsx` handle)

class Context : JSERunnerDsx {

    internal val store: Registration

    // Per-call state. Inert for the registrar `dsx` (empty params, null url),
    // so registration-time and out-of-band use is always safe.
    private val callScheme: String
    private val callHost: String
    private val callURL: URI?
    private val callParams: Bridge.Params
    private val isCall: Boolean

    // Routing + settle state. One Context per dispatch, reused across the
    // pre-filter -> named handoff, so these flags track the whole call.
    internal var didSkip = false
    private val settleLock = Any()
    private var settled = false

    /// Registrar context: used in `setup()` to register, and anywhere in the
    /// package for out-of-band `broadcast`.
    internal constructor(store: Registration) {
        this.store = store
        this.callScheme = store.primaryScheme
        this.callHost = ""
        this.callURL = null
        this.callParams = Bridge.Params(dict = emptyMap(), requestID = null)
        this.isCall = false
    }

    /// Per-call context, built by the registry for each dispatched URL.
    internal constructor(store: Registration, scheme: String, host: String, url: URI,
                         params: Bridge.Params) {
        this.store = store
        this.callScheme = scheme
        this.callHost = host
        this.callURL = url
        this.callParams = params
        this.isCall = true
    }

    private val proxyScheme: String get() = if (isCall) callScheme else store.primaryScheme

    companion object {
        /// `dsx.fetch`'s HTTP backend seam — `:platform` installs the real (OkHttp) engine;
        /// the pure-JVM default REJECTS (FetchError.Transport), so a kernel-only build/test
        /// fails loudly instead of silently networking.
        @Volatile
        var fetchImpl: (suspend (url: String, method: String, headers: Map<String, String>,
                                 query: Map<String, String>, body: Any?, timeout: Double) -> FetchResponse)? = null

        /// Module-only control-plane twin of [fetchImpl]. The platform installs a transport with
        /// the 4MiB manifest/route ceiling; keeping a distinct seam preserves dsx.fetch's declared
        /// 16MiB API response contract. Pure-JVM hosts may omit it and fall back to [fetchImpl].
        @Volatile
        var controlFetchImpl: (suspend (url: String, method: String, headers: Map<String, String>,
                                        query: Map<String, String>, body: Any?, timeout: Double) -> FetchResponse)? = null

        /// The module-call diagnostics funnel's reentrancy guard: the thread currently
        /// delivering `module.callFailed` hooks (null = not delivering). Global — every
        /// per-call Context shares the one funnel. See `reportCallFailure`.
        @Volatile
        private var firingCallFailedOn: Thread? = null
    }

    // MARK: Registration (setup)

    /// Register actions, or read the active action name. `dsx.action { }`
    /// registers the pre-filter; `dsx.action("name") { }` a named handler;
    /// `dsx.action.name` reads which action fired inside a handler.
    val action: ActionAPI get() = ActionAPI(this)

    /// Group nested actions under a dotted namespace — the web calls them as
    /// `despia.<scheme>.<group>.<action>(…)`. `build` runs at registration with the group prefix
    /// active, so `dsx.action("add") { … }` inside it registers the host `<group>.add`. Nestable.
    fun group(name: String, build: () -> Unit) {
        val saved = store.groupPrefix
        store.groupPrefix = "$saved$name."
        build()
        store.groupPrefix = saved
    }

    /// Scope actions to one of the package's schemes — `despia.<scheme>.<action>(…)`. A package can
    /// front MORE THAN ONE scheme (its primary, plus extras declared in `dsx.json` `aliases`): wrap
    /// each extra scheme's actions in its own block, and they stay isolated from the primary.
    fun scheme(name: String, build: () -> Unit) {
        val saved = store.currentScheme
        store.currentScheme = name.lowercase()   // dispatch receives RFC-lowercased schemes — key alike
        build()
        store.currentScheme = saved
    }

    /// Register a block to run once per page load (after the runtime installs).
    fun hydrate(handler: (Context) -> Unit) {
        store.hydrations.add(handler)
    }

    /// Register a block to run once per page load, AFTER the page has finished
    /// loading. Sibling to `hydrate`, fired at didFinish instead of didCommit -
    /// `<body>` is parsed, the page is interactive.
    fun ready(handler: (Context) -> Unit) {
        store.readyBlocks.add(handler)
    }

    /// THE append — the register half of the delegate primitive (delegates.md §2 `register`).
    /// Kernel-internal by design: the ONE authoring spelling is `dsx.delegate.listen(event) { … }`,
    /// which forwards straight here in one hop. The former public `dsx.hook` verb was deleted by
    /// phase 4, the collapse — one idiom for attaching, not two. Untyped in/out so the same shape
    /// works on Swift/Kotlin; return non-null to answer a claim-style fold. Attach in `setup()`,
    /// like `dsx.action`. `priority` orders watchers of the same event: higher runs first (globally
    /// across packages), equal priority keeps registration order. Default 0 — behavior-neutral.
    internal fun register(event: String, priority: Int = 0, handler: (Any?) -> Any?) {
        store.hooks.getOrPut(event) { ArrayList() }.add(HookEntry(priority, handler))
    }

    class ActionAPI internal constructor(private val dsx: Context) {

        /// Inside a handler: the action name that fired (URL host). "" otherwise.
        val name: String get() = dsx.callHost

        /// Inside a handler: the ARRIVING scheme of this call — the spelling the caller
        /// used (the primary, or a manifest alias). "" otherwise. True on EVERY face:
        /// real URL navigations keep their scheme, and the STRUCTURED/string-tuple
        /// funnel passes the arriving spelling into the per-call context even though
        /// its `command()` is the synthesized `dsx-call` CARRIER url — so a pre-filter
        /// that disambiguates alias spellings matches THIS, never `command()?.scheme`
        /// (the carrier can never equal a module scheme). The web twin is the module
        /// ctx's `scheme` (bus.ts `ModuleCallCtx.scheme`).
        val scheme: String get() = if (dsx.isCall) dsx.callScheme else ""

        /// Register the pre-filter - runs first on every call; `dsx.skip()`
        /// to defer to the named handlers below.
        operator fun invoke(handler: (Context) -> Unit) {
            dsx.store.prefilter = handler
        }

        /// Register a named handler for the action `<name>` on the package's scheme — prefixed when
        /// inside `dsx.group`, and scoped to the current `dsx.scheme` (else the primary scheme).
        ///
        /// The key is stored LOWERCASED — action names are case-INSENSITIVE by construction. Every
        /// dispatch path lowercases the action segment before lookup (URL hosts are case-insensitive
        /// per RFC 3986), so a case-preserved camelCase registration would be unreachable from
        /// EVERY caller. Lowercasing here mirrors the scheme table.
        operator fun invoke(name: String, handler: (Context) -> Unit) {
            val key = (dsx.store.groupPrefix + name).lowercase()
            val scheme = dsx.store.currentScheme
            if (scheme != null) {
                dsx.store.schemeNamed.getOrPut(scheme) { HashMap() }[key] = handler
            } else {
                dsx.store.named[key] = handler
            }
        }

        /// Register an INTERNAL action — NOT exposed on the web/URL bus (`window.despia.<scheme>.<name>`
        /// and deep links never reach it). Reachable only by in-process `dsx.module` calls. Use for
        /// package-private helpers and privileged logic that must not be web-callable. `exposed = true`
        /// is the normal public registration.
        operator fun invoke(name: String, exposed: Boolean, handler: (Context) -> Unit) {
            if (exposed) return invoke(name, handler)
            dsx.store.internalNamed[(dsx.store.groupPrefix + name).lowercase()] = handler   // case-insensitive, like `named`
        }
    }

    // MARK: Per-call reads

    /// One input value, already smart-parsed to its native type at ingestion -
    /// String / number / Bool / array / object - so you use it directly, no
    /// coercion suffix. `null` for a missing key (or an explicit JSON null).
    /// Cast only when an SDK needs a concrete static type (`dsx.args("name") as? String`).
    fun args(key: String): Any? {
        val value = callParams.raw(key)
        return if (value === NSNull) null else value
    }

    /// The whole inbound payload as a native map - a forwarding escape hatch for
    /// subsystems that route their own way. Internal framing keys (`__rid`,
    /// `__stop`) are stripped; read those via `dsx.id()` / `dsx.stopped()`.
    fun args(): Map<String, Any?> =
        callParams.all.filterKeys { !it.startsWith("__") }

    /// A file param's local URL. A `File`/`Blob` passed from web is stream-uploaded to
    /// the local CDN by runtime.js and arrives here as a URL the handler can read or
    /// stream straight off disk. null if absent or unparseable.
    fun file(key: String): URI? = callParams.file(key)

    /// A list param as `List<String>`: a real array (a structured array, or a
    /// smart-parsed comma-list like `?types=a,b,c`) maps element-wise; a single
    /// scalar wraps to one element; a missing key yields `[]`.
    fun list(key: String): List<String> {
        val raw = callParams.raw(key)
        if (raw is List<*>) {
            // Swift: `$0 as? String ?? ($0 as? NSNumber)?.stringValue` — a Bool bridges
            // to NSNumber there, so booleans stringify "1"/"0" (pinned, byte-faithful).
            return raw.mapNotNull {
                when (it) {
                    is String -> it
                    is Boolean -> if (it) "1" else "0"
                    is Number -> Bridge.Params.numberString(it)
                    else -> null
                }
            }
        }
        if (raw is String) return if (raw.isEmpty()) emptyList() else listOf(raw)
        if (raw is Boolean) return listOf(if (raw) "1" else "0")
        if (raw is Number) return listOf(Bridge.Params.numberString(raw))
        return emptyList()
    }

    /// The raw URL that triggered this call. Use it when the host slot carries data
    /// (the legacy `readhealthkit` data-in-host form — see Documentation/legacy.md).
    fun command(): URI? = callURL

    /// The `__rid`. Rarely needed - `resolve` / `error` / `event` correlate it
    /// to the request for you. Reach for it only to key a stream subscription for
    /// stop-correlation, or to log.
    fun id(): String? = callParams.requestID

    /// `true` when the JS caller stopped a stream subscription (`.stop()`).
    fun stopped(): Boolean = callParams.isStop

    /// Capability flags (degrade gracefully on stripped builds).
    fun flags(): Flags = Flags()

    /// Handle to the app's shared **container** (the reserved App Group on iOS; the
    /// seam-backed KV store here). This is *your* subcontainer (named after the package
    /// scheme); read and write it directly. Reach another package's folder by name:
    /// `dsx.container["onesignal"]`. See containers.md.
    val container: Container get() = Container(store.primaryScheme, own = true)

    /// App-wide reactive store (`global.*` / DSXState) — the same store the web reads via
    /// `window.despia.global` and Stack views read as `{{ global.* }}`. Dot-paths:
    /// `dsx.global.set("session.credits", 200)` / `dsx.global.get("session")`. See State.kt.
    val global: DSXGlobal get() = DSXGlobal()

    /// `dsx.context` — THIS package's own data face: the variables it PUBLISHES to others
    /// (declared in its dsx.json `context` block). Read its own vars as
    /// `dsx.context["var"].bool`, PUBLISH a live one with `dsx.context.set("<var>", value)`.
    /// Consumers read it back via `dsx.module["<scheme>"].context["<var>"]`. See State.kt.
    val context: DSXStateProxy get() = DSXStateProxy(store.primaryScheme)

    // `dsx.app` / `dsx.env` are `:platform` (AppManifest/BuildConfig) — see the header.
    // `dsx.config` / `dsx.state` below read the generated registries.

    /// `dsx.content` — the kernel CONTENT primitive: folder-shaped, generation-versioned,
    /// offline-first app-authored content (Content.kt). `dsx.content.folder("/runner")` returns
    /// the last-known-good generation SYNCHRONOUSLY (render-safe, never network);
    /// `dsx.content.prepare("/runner")` resolves + freshens (stale-while-revalidate).
    val content: DSXContent get() = DSXContent

    /// `dsx.source` — owner-published provenance for remote-loaded planes. Reads stay
    /// ordinary `global.source.*` state; this face owns only track/publish verbs.
    val source: DSXSourceFace get() = DSXSourceFace()

    /// `dsx.config` — introspect THIS package's config by key: `dsx.config["usage_description"]`
    /// (resolved for the device), `.default`, `.isLocalized`, `.locales`, `.forLocale("de-DE")`,
    /// plus typed `.bool` / `.int` / … . Bound to the package's primary scheme; backed by
    /// generated data. See State.kt.
    val config: DSXConfigProxy get() = DSXConfigProxy(store.primaryScheme)

    /// `dsx.state` — transitional alias of `dsx.context` (a package's own data face). Prefer
    /// `dsx.context`; both bind to the primary scheme and return the same DSXStateProxy.
    val state: DSXStateProxy get() = DSXStateProxy(store.primaryScheme)

    /// Shared in-process context registry (live handles). One node provides a handle under a key,
    /// any node consumes it: `dsx.shared.provide("key", handle)` / `dsx.shared.use("key")`. For the
    /// web surface, packages go through its OWNER — `dsx.module["dom"].object("view")` — not this
    /// kernel-internal handle directly. See Shared.kt.
    val shared: DSXShared get() = DSXShared()

    /// EXPORT a live native object for other packages — owner-namespaced under THIS package's
    /// scheme. A consumer reads it with `dsx.module["<thisScheme>"].object("name")` and casts to
    /// the concrete type. The kernel stores it OPAQUELY and never names the type. Backed by the
    /// same in-process handle store as `dsx.shared` (weak ref).
    fun export(name: String, obj: Any?) {
        shared.provide("${store.primaryScheme}.$name", obj)
    }

    /// Shared in-process VALUE state (strong-ref). The native package-coordination store: a
    /// Bool/String/Map a package publishes for others to read synchronously while handling
    /// hooks/actions. Contrast `dsx.shared` (weak OBJECT handles). See Shared.kt.
    val values: DSXValues get() = DSXValues()

    /// Out-of-band event bus (the native mirror of `window.despia.on`). Subscribe to a
    /// scheme's broadcasts: `dsx.events.on("audio") { event, data -> … }` — keep the
    /// returned handle and `cancel()` it. The delivery side is `dsx.broadcast(...)`. See Events.kt.
    val events: DSXEvents get() = DSXEvents()

    /// `dsx.errors` — the error LEDGER read API (error-system.md): `recent()` (the retained
    /// ring, cap 128), `count()` (monotonic), `clear()` (dev tooling). Call failures and
    /// ambient `dsx.error` emissions both land here; the reactive twins are
    /// `global.dsx.lastError` / `global.dsx.errorCount`. See Errors.kt.
    val errors: DSXErrorLedger get() = DSXErrorLedger.shared

    /// `dsx.log(…)` — the unified console primitive (the logs corpus): console.log-shaped
    /// variadic formatting (JSE coercions + canonical JSON + credential masking), recorded
    /// in the log ring attributed to THIS module's scheme, mirrored to kernelLog (logcat /
    /// the armed diagnostics drawer). Never throws. See Logs.kt.
    fun log(vararg args: Any?) {
        reportLog(scheme = store.primaryScheme.ifEmpty { "app" }, level = "log",
                  message = formatLogArgs(args.toList()))
    }

    /// `dsx.logs` — the log ring read API: `recent()` (the retained ring, cap 500),
    /// `count()` (monotonic), `clear()` (dev tooling). `dsx.log`, the console.* builtin,
    /// and the page bridge (`despia.log`) all land here. See Logs.kt.
    val logs: DSXLogBuffer get() = DSXLogBuffer.shared

    /// `dsx.messenger` — mount a native surface onto the bus (the multi-surface bridge;
    /// Messenger.kt). A surface owner mounts ONE sink, feeds its content's calls in via
    /// `mount.receive`, and the kernel routes replies / streams / broadcasts back to it.
    val messenger: DSXMessenger get() = DSXMessenger()

    /// `dsx.on(name) { phase, payload -> }` — subscribe to a loose broadcast signal (the canonical
    /// name from the native-bus surface for `dsx.events.on`). Pairs with `dsx.broadcast(name, payload)`.
    fun on(scheme: String, handler: (String, Any?) -> Unit): DSXEventSubscription =
        events.on(scheme, handler)

    // MARK: Cross-package calls
    //
    // Three small primitives let a package depend on another at runtime
    // without importing its class (so the dependency is excludable):
    //   - `dsx.has("appsflyer")`                                     - is the package loaded?
    //   - `dsx.module["appsflyer"]["set_user_id"].post(mapOf(…))`    - fire-and-forget.
    //   - `dsx.module["appsflyer"]["get_uid"]()`                     - suspends; awaits resolve(...).
    //
    // All routes go through the same `ModuleRegistry` dispatch path the JS bridge uses,
    // so the target package's existing `dsx.action("name") { … }` handlers are reused
    // as-is. The handler's `dsx.resolve` / `dsx.error` settle the caller's continuation
    // instead of writing back to a JS promise.

    /// `true` if a Module claiming `scheme` is loaded in this build. Lets
    /// a caller branch before dispatching, e.g. to skip optional decoration
    /// rather than catching `ModuleCallError.NotLoaded`.
    fun has(scheme: String): Boolean = ModuleRegistry.shared.isAvailable(scheme)

    /// Subscript-chain root for calling another package — the native twin of DSX's
    /// `dsx.module.<scheme>.<method>(…)`. ONE root for both forms: the suspending
    /// `invoke` gets the result, `.post` is fire-and-forget (see header NOTES).
    ///
    ///     val res = dsx.module["revenuecat"]["purchase"](mapOf("product" to id))   // suspend
    ///     dsx.module["appsflyer"]["set_user_id"].post(mapOf("id" to userId))       // fire-and-forget
    val module: ModuleProxy get() = ModuleProxy(this)

    // MARK: Kernel bus (the delegate plane — `dsx.delegate`)
    //
    // The bus primitive is surfaced on `dsx` so an OS-delegate relay and other kernel-adjacent
    // code reach the bus THROUGH dsx — never `ModuleRegistry.shared` directly. There is exactly
    // ONE pair of verbs (delegates.md phase 4, the collapse): `dsx.delegate.listen(name) { … }`
    // attaches, `dsx.delegate.send(name, payload, combine)` folds. The four old emit spellings
    // (`dsx.fire` / `dsx.claim` / `dsx.fireAny` / `dsx.collect`) and the `dsx.hook` attach verb
    // are GONE — the combine policy carries what the verb name used to. To make a package you can
    // NAME do something, use `dsx.module["<scheme>"]["<action>"]` — `send` is never a disguised
    // point-to-point call (Skills/cross-module-calls.md).

    /// `dsx.delegate` — the declared, typed delegate primitive (one fold over the same hook
    /// pipeline). `dsx.delegate["<event>"] { input -> … }` ATTACHES a handler;
    /// `dsx.delegate["<event>"](payload)` INVOKES the fold, combining every attacher's answer per
    /// the owner's declared policy (claim/veto/any/collect/void) from its `dsx.json` `delegate`
    /// block (→ GeneratedDelegateRegistry). A module's own delegate points are reached
    /// scheme-namespaced via `dsx.module["<scheme>"].delegate["<event>"]`.
    val delegate: DSXDelegateProxy get() = DSXDelegateProxy(this, prefix = "")

    /// First-dibs custom-scheme dispatch for a raw URL (the navigation relay's pre-claim step):
    /// hands the URL to the package that owns its scheme. `true` if a package took it.
    fun handle(url: URI, params: Bridge.Params): Boolean =
        ModuleRegistry.shared.handle(url, params)

    /// Run every module's hydrate blocks for a freshly committed page (the dom relay's parity step).
    fun runHydrations() { ModuleRegistry.shared.runHydrations() }
    /// Run every module's ready blocks for a settled page (the dom relay's parity step).
    fun runReady() { ModuleRegistry.shared.runReady() }

    // MARK: Internal dispatch implementation

    internal fun _dispatch(scheme: String, action: String, args: Map<String, Any?>?) {
        requireScheme(scheme, action)
        // CHAIN ATTRIBUTION (the chains corpus law): resolve the callee's identity up front so
        // the diagnostics funnel and the unhandled answer name the RESOLVED chain — a call
        // into an excluded child reports against `off.grid`, never as a phantom action on its
        // parent. The ROUTE still ships the caller's verbatim pair: the fold that routes lives
        // at the ONE dispatch funnel (ModuleRegistry.handle), which must see the arriving
        // spelling. Nothing folded ⇒ both stay the originals (today's lines, bit for bit).
        // A reserved member can never dispatch as a call — the typed proxies answer members
        // before a call can form — so one arriving here is a caller bug, refused with the
        // cross-runtime code `reserved_member` (frozen in the chains corpus; Swift's
        // Context.foldRoute is the reference spelling).
        val res = ModuleRegistry.shared.resolveChain(scheme, action)
        res.member?.let { member ->
            reportCallFailure(res.chain, member, code = "reserved_member", data = null,
                              delivered = true, hint = "reserved members never dispatch — proxy plane only")
            throw ModuleCallError.ActionFailed(code = "reserved_member", data = null)
        }
        val atScheme = if (res.folded > 0) res.chain else scheme
        val atAction = if (res.folded > 0) res.rest else action
        // Fire-and-forget still OBSERVES the terminal outcome. By shape the caller never sees
        // it — so a handler's `dsx.error`/`dsx.fail` used to vanish into an empty lambda: the
        // "button does nothing, nothing anywhere says why" class of bug. Route error terminals
        // into the diagnostics funnel instead (success stays silent — not noise).
        val params = Bridge.Params(dict = args ?: emptyMap(), onTerminal = { outcome ->
            if (outcome is Bridge.Outcome.Error) {
                reportCallFailure(atScheme, atAction, outcome.code, outcome.data, delivered = false,
                                  message = outcome.message, recoverable = outcome.recoverable)
            }
        })
        // Action handlers render UI and touch the web view, so they must run on the
        // main thread — the web→bridge path always delivers there. A cross-package
        // `dispatch` can originate on a background thread, so hop explicitly (Swift:
        // main.SYNC — the executor seam must preserve the synchronous contract).
        var handled = false
        ModuleRegistry.shared.mainExecutor.execute {
            handled = ModuleRegistry.shared.handle(scheme = scheme, actionPath = action,
                                                   params = params, includeInternal = true)
        }
        if (handled) return
        // RUNG TWO before any absence answer (facet-contracts.md, corpus Conformance/facets):
        // this build may have no LOCAL implementation and still declare the action reachable
        // from here. Fire-and-forget by shape, so a reach failure surfaces through the funnel
        // exactly like a local one — the call site discarded its answer either way.
        val verdict = FacetLadder.resolve(facetFacts(atScheme, atAction, handled = false))
        if (verdict.rung == FacetLadder.Rung.REACH) {
            reachOverLink(atScheme, atAction, args, delivered = false) { outcome ->
                if (outcome is FacetOutcome.Failure) {
                    reportCallFailure(atScheme, atAction, outcome.code, outcome.data, delivered = false,
                                      message = outcome.message, recoverable = outcome.recoverable)
                }
            }
            return
        }
        throw unhandledCallError(atScheme, atAction, delivered = false, verdict = verdict)
    }

    internal suspend fun _call(scheme: String, action: String, args: Map<String, Any?>?): JSON {
        requireScheme(scheme, action)
        // CHAIN ATTRIBUTION + the reserved-member refusal — see `_dispatch`: the resolved
        // chain names the failure, a member route refuses before any dispatch (frozen code
        // `reserved_member`), and the verbatim pair rides to the funnel (the routing fold).
        val res = ModuleRegistry.shared.resolveChain(scheme, action)
        res.member?.let { member ->
            reportCallFailure(res.chain, member, code = "reserved_member", data = null,
                              delivered = true, hint = "reserved members never dispatch — proxy plane only")
            throw ModuleCallError.ActionFailed(code = "reserved_member", data = null)
        }
        val atScheme = if (res.folded > 0) res.chain else scheme
        val atAction = if (res.folded > 0) res.rest else action
        return suspendCancellableCoroutine { continuation ->
            // Wrap the continuation so a misbehaved handler firing both
            // resolve and error (or neither) can't crash.
            val once = Once()
            val params = Bridge.Params(dict = args ?: emptyMap(), onTerminal = { outcome ->
                if (once.claim()) when (outcome) {
                    is Bridge.Outcome.Resolve ->
                        continuation.resume(JSON.from(outcome.payload))
                    is Bridge.Outcome.Error -> {
                        // Delivered to the awaiting caller (typed throw) — but STILL funneled:
                        // a swallowing catch is silent, and the diagnostics drawer wants the
                        // trace either way. Observing never swallows; handling stays the caller's.
                        reportCallFailure(atScheme, atAction, outcome.code, outcome.data, delivered = true,
                                          message = outcome.message, recoverable = outcome.recoverable)
                        continuation.resumeWithException(
                            ModuleCallError.ActionFailed(code = outcome.code, data = outcome.data))
                    }
                }
            })
            // Action handlers render UI and touch the web view, so they must run on the
            // main thread — a cross-package `call` may be awaited from a background
            // coroutine, so invoke through the funnel seam (Swift: main.async).
            ModuleRegistry.shared.mainExecutor.execute {
                val handled = ModuleRegistry.shared.handle(scheme = scheme, actionPath = action,
                                                           params = params, includeInternal = true)
                if (handled) return@execute
                // RUNG TWO before any absence answer — see `_dispatch`. The transport settles
                // this same continuation, so an awaited call reaches a far node without the
                // caller ever spelling a route, and a link failure lands as the typed
                // `unreachable` rather than a hang.
                val verdict = FacetLadder.resolve(facetFacts(atScheme, atAction, handled = false))
                if (verdict.rung == FacetLadder.Rung.REACH) {
                    reachOverLink(atScheme, atAction, args, delivered = true) { outcome ->
                        if (!once.claim()) return@reachOverLink
                        when (outcome) {
                            is FacetOutcome.Resolve -> continuation.resume(JSON.from(outcome.payload))
                            is FacetOutcome.Failure -> {
                                reportCallFailure(atScheme, atAction, outcome.code, outcome.data,
                                                  delivered = true, message = outcome.message,
                                                  recoverable = outcome.recoverable)
                                continuation.resumeWithException(
                                    ModuleCallError.ActionFailed(code = outcome.code, data = outcome.data))
                            }
                        }
                    }
                    return@execute
                }
                if (once.claim()) {
                    continuation.resumeWithException(
                        unhandledCallError(atScheme, atAction, verdict = verdict))
                }
            }
        }
    }

    /// Cross-package calls route by the (scheme, action) STRING tuple — a scheme
    /// is a routing key, not URL grammar, so identifier names (`godot_test`) are
    /// legal. Only an empty scheme is unroutable.
    private fun requireScheme(scheme: String, action: String) {
        if (scheme.isEmpty()) {
            reportCallFailure(scheme = "", action = action, code = "invalid_uri", data = null,
                              delivered = true, hint = "empty scheme — caller bug")
            throw ModuleCallError.InvalidURI("://$action")
        }
    }

    /// The live FACTS for one call — the registry read once, so `FacetLadder.resolve` decides
    /// on exactly what ships and the conformance runner can state the same eight fields
    /// literally (`Facets.kt`, corpus `Conformance/facets`).
    private fun facetFacts(scheme: String, action: String, handled: Boolean): FacetFacts =
        FacetFacts(
            local = handled,
            module = ModuleRegistry.shared.isAvailable(scheme),
            facet = FacetSeam.facet,
            row = FacetSeam.row(scheme, action),
            transport = FacetSeam.invoke != null,
            linked = false,   // no Kotlin client link yet — see FacetFacts.linked
            excluded = ModuleRegistry.shared.excludedEntry(scheme) != null,
            offPlatform = ModuleRegistry.shared.unsupportedPlatforms(scheme) != null,
            offPlatformAction = ModuleRegistry.shared.unsupportedPlatforms(scheme) == null &&
                ModuleRegistry.shared.unsupportedPlatforms(scheme, action) != null,
        )

    /// Rung two: hand the call to the installed reach transport. The seam settles `outcome`;
    /// an absent transport can only arrive here when the ladder was resolved against a stale
    /// seam, and it answers the same typed `unreachable` the ladder would have.
    private fun reachOverLink(scheme: String, action: String, args: Map<String, Any?>?,
                              delivered: Boolean, settle: (FacetOutcome) -> Unit) {
        val invoke = FacetSeam.invoke
        val facet = FacetSeam.facet ?: ""
        if (invoke == null) {
            settle(FacetOutcome.Failure("unreachable", facetData(scheme, action),
                                        message = "$scheme.$action has no reach transport"))
            return
        }
        val call = FacetCall(chain = scheme, action = action, facet = facet)
        try {
            invoke(call, args ?: emptyMap(), settle)
        } catch (t: Throwable) {
            // A transport that throws SYNCHRONOUSLY must not unwind the funnel — that would be
            // exactly the hang/untyped-throw the ladder exists to forbid.
            settle(FacetOutcome.Failure("unreachable", facetData(scheme, action), message = t.message))
        }
    }

    /// The shared payload for the two facet-only codes: who was asked, for what, on which
    /// facet. (`unsupported_platform` from the platform CATALOG keeps its own shape below.)
    private fun facetData(scheme: String, action: String): Map<String, Any?> =
        mapOf("scheme" to scheme, "action" to action, "facet" to FacetSeam.facet)

    /// The unhandled answer for the native chain — the ladder's rung three, and NEVER silent
    /// (every branch reports to the diagnostics funnel before the caller's catch can swallow
    /// it). `FacetLadder` picks the code; this composes the envelope each code has always
    /// carried, so the shipped shapes are unchanged:
    ///   • scheme LOADED here but no handler took the action → the caller named a wrong or
    ///     unregistered action (the `injct` typo class) → `ActionFailed("unknown_action",
    ///     { action })` — the same code + data shape the prefilter path (Registration.dispatch)
    ///     and the web twin (bus.ts) already answer, so all three renderers agree and
    ///     `NotLoaded` stays honest: it means "the module is absent", never "the module
    ///     silently ignored you".
    ///   • catalog scheme with NO implementation on this OS → the STRUCTURED
    ///     `ActionFailed("unsupported_platform", { scheme, platform, supportedPlatforms })`
    ///     (the `ModuleRegistry.platformSupport` contract). A capability ROW that neither
    ///     provides nor reaches this facet answers the same code with the facet-shaped data —
    ///     one meaning, one spelling (durability P4 retired the draft `never_on_facet`).
    ///   • implemented here but EXCLUDED BY THIS APP → `excluded` (durability.md P4, typed
    ///     absence — the reason IS the code), the DespiaExcluded overlay entry riding
    ///     verbatim as data ({ reason, from?, aliases? }: the same fact `.excluded`
    ///     introspection answers — corpus errors/errors.json).
    ///   • the row PROMISES a local implementation on this facet and nothing stood it up →
    ///     `prerequisites_missing`; admitted by `reach` with no transport → `unreachable`.
    ///     An unknown scheme keeps throwing `NotLoaded`. `dsx.has` stays false for all of
    ///     these: feature detection remains the primary pattern; this is the honest answer
    ///     when someone calls anyway. `delivered` mirrors the call shape (the TS law: a post
    ///     caller discards the rejection by shape, so its funnel record says false).
    private fun unhandledCallError(scheme: String, action: String, delivered: Boolean = true,
                                   verdict: FacetLadder.Verdict? = null): ModuleCallError {
        // What dispatch actually looked up: the first path segment, lowercased (URL-host contract).
        val host = action.split("/").firstOrNull()?.lowercase() ?: action.lowercase()
        val code = (verdict ?: FacetLadder.resolve(facetFacts(scheme, action, handled = false))).code
        if (code == "unknown_action") {
            val known = ModuleRegistry.shared.actionNames(scheme)
            val hint = if (known.isEmpty())
                "module is loaded but registers no named actions on this platform"
            else
                "module is loaded — known actions: ${known.joinToString(", ")}"
            reportCallFailure(scheme, action, code = "unknown_action",
                              data = mapOf("action" to host), delivered = delivered, hint = hint)
            return ModuleCallError.ActionFailed(code = "unknown_action", data = mapOf("action" to host))
        }
        if (code == "unsupported_platform") {
            val supported = ModuleRegistry.shared.unsupportedPlatforms(scheme, action)
            val data = if (supported != null) ModuleRegistry.shared.unsupportedPlatformData(scheme, supported)
                       else facetData(scheme, action)
            val hint = if (supported != null) "implemented on: ${supported.joinToString(", ")}"
                       else "never on the \"${FacetSeam.facet}\" facet"
            reportCallFailure(scheme, action, code = code, data = data, delivered = delivered, hint = hint)
            return ModuleCallError.ActionFailed(code = code, data = data)
        }
        if (code == "excluded") {
            val entry = ModuleRegistry.shared.excludedEntry(scheme)
            reportCallFailure(scheme, action, code = code, data = entry, delivered = delivered,
                              hint = "excluded from this build (reason: ${entry?.get("reason") ?: "excluded"})")
            return ModuleCallError.ActionFailed(code = code, data = entry)
        }
        if (code == "prerequisites_missing" || code == "unreachable") {
            val data = facetData(scheme, action)
            val hint = if (code == "unreachable") "reach admits \"${FacetSeam.facet}\" but no transport is installed"
                       else "declared on the \"${FacetSeam.facet}\" facet but nothing implements it here"
            reportCallFailure(scheme, action, code = code, data = data, delivered = delivered, hint = hint)
            return ModuleCallError.ActionFailed(code = code, data = data)
        }
        reportCallFailure(scheme, action, code = "not_loaded", data = null, delivered = delivered,
                          hint = "module not in this build (expected when excluded — a caught call no-ops)")
        return ModuleCallError.NotLoaded(scheme)
    }

    // MARK: Module-call diagnostics (the ONE failure funnel)

    /// EVERY `dsx.module` call failure lands here, so nothing on the native chain fails
    /// invisibly anymore (Article 7 keeps *degrading* legal — invisible was never the point):
    ///   · `kernelLog` — the debug console + the on-device diagnostics ring buffer, so a
    ///     tester exports the exact `scheme.action → code` line instead of reporting
    ///     "the button does nothing".
    ///   · `module.callFailed` bus event — the global observer seam
    ///     (`dsx.delegate.listen("module.callFailed")`) for dev tooling / crash reporting; payload
    ///     `{ scheme, action, code, data?, delivered }`, fired through the main-executor seam.
    /// `delivered: false` marks a fire-and-forget terminal error — the call site has already
    /// returned, so this funnel is the ONLY place that failure can surface. Observing never
    /// swallows: handling stays the caller's job (catching the typed `ModuleCallError`).
    ///
    /// Reentrancy: a failure reported from INSIDE a `module.callFailed` hook stays log-only —
    /// re-firing would feed the hook its own output (fire → hook → failing call → fire → …),
    /// and with a POSTING main executor the re-fire would land after the guard reset and spin
    /// forever. The guard is the identity of the thread currently delivering hooks, so it is
    /// exact under both executor styles (inline in pure-JVM tests, posted on a device looper).
    private fun reportCallFailure(scheme: String, action: String, code: String,
                                  data: Any?, delivered: Boolean, hint: String? = null,
                                  message: String? = null, recoverable: Boolean = false) {
        var line = "[dsx.module] $scheme.$action → $code"
        if (!delivered) line += " (fire-and-forget — the error never reaches the call site)"
        if (hint != null) line += " — $hint"
        kernelLog(line)
        if (Thread.currentThread() === firingCallFailedOn) return
        ModuleRegistry.shared.mainExecutor.execute {
            firingCallFailedOn = Thread.currentThread()
            try {
                // The unified record (error-system.md §3.3a): every native/markup-caller
                // failure — handler-settled AND the thrown kernel errors — with the full
                // fidelity the widened internal Outcome now carries. `dsx.errorCount` tracks
                // the ledger's monotonic total from EVERY feeder (a stale counter between
                // ambient emissions would jump unpredictably); `dsx.lastError` stays
                // ambient-only (semantic errors, not transport noise like card_declined).
                DSXErrorLedger.shared.append(DSXError(
                    code = code, message = message, recoverable = recoverable, data = data,
                    scheme = scheme, origin = "call", delivered = delivered))
                DSX.state.setPath("dsx.errorCount", DSXErrorLedger.shared.count())
                val payload = mutableMapOf<String, Any?>(
                    "scheme" to scheme, "action" to action,
                    "code" to code, "delivered" to delivered)
                if (data != null) payload["data"] = data
                ModuleRegistry.shared.dispatch("module.callFailed", payload, combine = ModuleRegistry.Combine.void)
            } finally {
                firingCallFailedOn = null
            }
        }
    }

    // MARK: Routing outcome

    /// From the pre-filter: "not mine" - continue to the named handlers.
    fun skip() { didSkip = true }

    // MARK: Output (terminal; first call wins)

    /** Deliver a correlated envelope without ever retargeting a mounted call.
     * A mounted origin stays generation-scoped even if its weak token has cleared:
     * cleared/deactivated means drop. Only legacy callers resolve by public id. */
    private fun deliverToOrigin(egress: DSXEgress) {
        if (callParams.hasMessengerRegistration) {
            callParams.messengerRegistration?.let { generation ->
                messenger.deliver(generation, egress)
            }
            return
        }
        messenger.deliver(egress.target, egress)
    }

    /// Terminal success - resolves the JS `await despia(...)` for this call,
    /// or the awaiting `dsx.module(...)` continuation when this dispatch was
    /// initiated by another package.
    fun resolve(data: Any? = null) {
        if (!claimTerminal()) return
        val payload = if (data == null) null else JSON.from(data).foundationValue
        val onTerminal = callParams.onTerminal
        if (onTerminal != null) {
            onTerminal(Bridge.Outcome.Resolve(payload))
            return
        }
        val envelope: Map<String, Any?> = mapOf(
            "id" to callParams.requestID, "scheme" to proxyScheme, "host" to callHost,
            "event" to "result", "final" to true, "data" to payload,
        )
        // Deliver to the ORIGIN surface's mounted sink (dsx.messenger). Every surface
        // rides this one seam — the web included (the Dom module mounts "web", the
        // default target for calls with no surface origin). No sink mounted = silent
        // no-op (pure-native app / surface torn down) — the kernel names NO module here.
        val target = callParams.surfaceID ?: "web"
        deliverToOrigin(
            DSXEgress(target = target, scheme = proxyScheme, rid = callParams.requestID, payload = envelope),
        )
    }

    /// Terminal failure - rejects the JS `await window.despia(...)` (or the
    /// awaiting `dsx.module(...)` continuation). `code` is a stable,
    /// machine-readable identifier (e.g. "payment_failed"); `data` is
    /// optional free-form metadata the catch handler can read. Web sees a uniform
    /// `catch (e) { e.code; e.data }`; a Kotlin caller receives
    /// `ModuleCallError.ActionFailed(code, data)`.
    fun error(code: String = "error", data: Any? = null) {
        sendError(code, message = null, recoverable = false, data = data)
    }

    /// Canonical SUCCESS — the `{ ok, data }` half of the uniform package result contract:
    /// resolves the await with `data`. An alias of `resolve`, paired with `fail`.
    fun ok(data: Any? = null) { resolve(data) }

    /// Canonical FAILURE with the uniform error shape — the catch handler reads a stable,
    /// predictable object on EVERY package:
    ///   • `code`        — stable machine id to branch on (e.g. `"permission_denied"`)
    ///   • `message`     — human-readable, safe to show
    ///   • `recoverable` — whether a retry / alternate path is worth offering
    ///   • `data`        — optional extra metadata
    /// Web: `catch (e) { e.code; e.message; e.recoverable; e.data }`. Native callers receive
    /// `ModuleCallError.ActionFailed(code, data)` (message/recoverable ride the web envelope).
    fun fail(code: String, message: String? = null, recoverable: Boolean = false, data: Any? = null) {
        sendError(code, message = message, recoverable = recoverable, data = data)
    }

    /// `dsx.reject(code, message:, recoverable:, data:)` — the canonical native-bus name for the
    /// structured terminal error (`{code, message, recoverable, data}`); an alias of `fail`.
    fun reject(code: String, message: String? = null, recoverable: Boolean = false, data: Any? = null) {
        sendError(code, message = message, recoverable = recoverable, data = data)
    }

    /// Shared error delivery for `error` / `fail` / `reject` — the HAT decides
    /// (error-system.md §3.2):
    ///   · call hat (a handler's per-call dsx) — TERMINAL, first call wins, byte-identical
    ///     to before. The web envelope always carries `code` + `recoverable`; `message` only
    ///     when given; native `onTerminal` now ALSO carries message/recoverable (internal
    ///     widening — the funnel records full fidelity, callers see code+data unchanged).
    ///   · ambient hat (the module/registrar handle — no call to settle) — the SAME verb is
    ///     the out-of-band EMISSION: ledger + module.error + page channel + reactive keys,
    ///     REPEATABLE (never rides claimTerminal). Replaces the old accidental
    ///     one-shot-broadcast-then-dead registrar behavior outright.
    private fun sendError(code: String, message: String?, recoverable: Boolean, data: Any?) {
        if (!isCall) {
            reportAmbientError(store.primaryScheme.ifEmpty { "app" }, code, message, recoverable, data)
            return
        }
        if (!claimTerminal()) return
        val payload = if (data == null) null else JSON.from(data).foundationValue
        val onTerminal = callParams.onTerminal
        if (onTerminal != null) {
            onTerminal(Bridge.Outcome.Error(code = code, data = payload,
                                            message = message, recoverable = recoverable))
            return
        }
        val envelope = LinkedHashMap<String, Any?>()
        envelope["id"] = callParams.requestID; envelope["scheme"] = proxyScheme; envelope["host"] = callHost
        envelope["event"] = "error"; envelope["final"] = true; envelope["data"] = payload
        envelope["code"] = code; envelope["recoverable"] = recoverable
        if (message != null) envelope["message"] = message
        // WEB-caller terminal errors feed the ledger HERE — the one point that still holds
        // full fidelity; native/markup callers feed via reportCallFailure instead (the two
        // paths are disjoint, so no double entries — error-system.md §3.3a). The web caller
        // receives the rejection envelope, hence delivered = true. `dsx.errorCount` stays in
        // sync from every feeder; `dsx.lastError` stays ambient-only.
        DSXErrorLedger.shared.append(DSXError(
            code = code, message = message, recoverable = recoverable, data = payload,
            scheme = proxyScheme, origin = "call", delivered = true))
        DSX.state.setPath("dsx.errorCount", DSXErrorLedger.shared.count())
        // Deliver to the ORIGIN surface's mounted sink (dsx.messenger; "web" default).
        val target = callParams.surfaceID ?: "web"
        deliverToOrigin(
            DSXEgress(target = target, scheme = proxyScheme, rid = callParams.requestID, payload = envelope),
        )
    }

    // MARK: Events (non-terminal, repeatable - stream this call's rid)

    fun event(name: String, value: Any? = null) {
        if (isSettled) return
        // `final` follows the terminal rule, so an event named "error" still closes the stream.
        val envelope: Map<String, Any?> = mapOf(
            "id" to callParams.requestID, "scheme" to proxyScheme, "host" to callHost,
            "event" to name, "final" to (name == "error"),
            "data" to (if (value == null) null else JSON.from(value).foundationValue),
        )
        // Stream to the ORIGIN surface's mounted sink (dsx.messenger; "web" default).
        val target = callParams.surfaceID ?: "web"
        deliverToOrigin(
            DSXEgress(target = target, scheme = proxyScheme, rid = callParams.requestID, payload = envelope),
        )
    }

    // MARK: Broadcast (out-of-band, no rid - fans out to scheme subscribers)

    fun broadcast(name: String, value: Any? = null) {
        broadcast(proxyScheme, name, value)
    }

    /// Broadcast out-of-band on an EXPLICIT surface scheme rather than this Context's own scheme —
    /// for a bound coordinator that emits a named surface's events on that surface's behalf. The
    /// only difference from `broadcast(name, value)` is the `scheme` the envelope/native bus carry.
    /// (Swift spells this `broadcast(on:_:_:)`; Kotlin's no-defaults-preferred overload resolution
    /// keeps the 2-arg form on the primary spelling.)
    fun broadcast(on: String, name: String, value: Any? = null) {
        val payload = if (value == null) null else JSON.from(value).foundationValue
        // Primary plus aliases are one main-executor transaction. No second broadcast
        // can interleave its surface/native pair between this call's ordered fanout.
        ModuleRegistry.shared.mainExecutor.execute {
            fun fanOut(scheme: String) {
                val envelope: Map<String, Any?> = mapOf(
                    "id" to null, "scheme" to scheme, "host" to "",
                    "event" to name, "final" to true, "data" to payload,
                )
                // Every mounted surface precedes the native bus for this scheme.
                messenger.deliverBroadcast(
                    DSXEgress(target = "*", scheme = scheme, rid = null, payload = envelope))
                events.publish(scheme, name, payload)
            }

            fanOut(on)
            // ALIAS fan-out (the ModuleRegistry .void fold's broadcast twin): when the scheme is a
            // module chain with legacy aliases, every legacy channel follows the primary
            // inside the same executor task.
            for (alias in ModuleRegistry.shared.aliasesForChain(on)) {
                fanOut(alias)
            }
        }
    }

    /// NATIVE-ONLY broadcast — fans out to in-process `dsx.events.on(scheme)` subscribers WITHOUT
    /// the web round-trip. For a HIGH-FREQUENCY native stream (e.g. a 30–60 Hz playhead tick)
    /// where evaluating JS on the web view every frame would be wasteful. Same
    /// scheme/event/data contract, so a subscriber written for `broadcast` works unchanged.
    fun broadcastNative(name: String, value: Any? = null) {
        val payload = if (value == null) null else JSON.from(value).foundationValue
        ModuleRegistry.shared.mainExecutor.execute {
            events.publish(proxyScheme, name, payload)
        }
    }

    // MARK: JSERunnerDsx — the author-logic runner's narrow view of the owning call
    // (JseRunner.kt: `runner.dsx`). Bridging overloads only — each delegates straight to
    // the canonical emit above (the JSON-typed argument just picks these more-specific
    // overloads; behavior is byte-identical).

    override fun resolve(data: JSON?) { resolve(data as Any?) }
    override fun error(code: String, data: JSON?) { error(code, data as Any?) }
    override fun broadcast(name: String, data: JSON) { broadcast(name, data as Any?) }

    // MARK: Settle helpers

    private fun claimTerminal(): Boolean = synchronized(settleLock) {
        if (settled) return false
        settled = true
        true
    }

    internal val isSettled: Boolean get() = synchronized(settleLock) { settled }

    // MARK: - dsx.fetch (cross-platform HTTP; Swift: `extension Context`)

    /// Perform an HTTP request natively. `query` is appended to the URL; a non-null
    /// `body` is JSON-encoded (with `Content-Type: application/json` unless the
    /// caller set one). Throws `FetchError` on a bad URL or transport failure;
    /// a non-2xx status is returned normally (check `res.ok` / `res.status`).
    /// Pure JVM: the engine behind it is the `Context.fetchImpl` seam (default rejects).
    suspend fun fetch(url: String,
                      method: String = "GET",
                      headers: Map<String, String> = emptyMap(),
                      query: Map<String, String> = emptyMap(),
                      body: Any? = null,
                      timeout: Double = 30.0): FetchResponse {
        val impl = fetchImpl
            ?: throw FetchError.Transport(IllegalStateException(
                "dsx.fetch has no backend installed — the host (`:platform`) sets Context.fetchImpl at boot."))
        return impl(url, method, headers, query, body, timeout)
    }

    /// Bounded route/manifest request. Shipping hosts enforce the smaller control-plane byte
    /// ceiling while bytes stream; a pure-JVM custom host falls back to [fetchImpl], and callers
    /// still apply their own postcondition before parsing.
    suspend fun fetchControl(url: String,
                             method: String = "GET",
                             headers: Map<String, String> = emptyMap(),
                             query: Map<String, String> = emptyMap(),
                             body: Any? = null,
                             timeout: Double = 30.0): FetchResponse {
        val impl = controlFetchImpl ?: fetchImpl
            ?: throw FetchError.Transport(IllegalStateException(
                "dsx.fetchControl has no backend installed — the host (`:platform`) sets Context.controlFetchImpl at boot."))
        return impl(url, method, headers, query, body, timeout)
    }
}

// MARK: - Capability flags

class Flags {
    /// App loads only from the bundled local HTML (no remote origin). Read from the kernel's OWN
    /// store (constitution Art. 1 — the kernel names no ClosedSource symbol); the ContentServer
    /// package seeds `server.onlyLocal` at setup. Absent (package excluded) → false (remote), the
    /// fail-open default. (`bridgeVersion()` rides the web transport — `:platform`; see header.)
    fun onlyLocalServer(): Boolean = (DSX.state.getPath("server.onlyLocal") as? Boolean) ?: false
}

class EmptyConfig

// MARK: - Shared container (the one reserved App Group)

/// The KV store behind `dsx.container` — Swift's `UserDefaults(suiteName: groupID)`.
/// `:platform` installs a SharedPreferences-backed store; the pure-JVM default is
/// in-memory (tests, kernel-only builds). Set `Container.backend = null` to model an
/// UNPROVISIONED container (reads return defaults, writes are dropped — Swift's nil suite).
interface ContainerKV {
    fun get(key: String): Any?
    fun set(key: String, value: Any)
    fun remove(key: String)
}

internal class InMemoryContainerKV : ContainerKV {
    private val lock = Any()
    private val map = HashMap<String, Any>()
    override fun get(key: String): Any? = synchronized(lock) { map[key] }
    override fun set(key: String, value: Any) { synchronized(lock) { map[key] = value } }
    override fun remove(key: String) { synchronized(lock) { map.remove(key) } }
}

/// A view of the app's shared container - the single reserved
/// `group.<bundleid>.container` every package and the app's extensions share.
/// Inside that one group each package gets a **subcontainer**: a folder (for files)
/// and a key prefix (for values) named after the package scheme, so packages never
/// collide and no package hardcodes the group name.
///
/// `dsx.container` is *your* subcontainer; read and write it directly. Reach another
/// package's subcontainer by name - `dsx.container["onesignal"]` (the string form; the
/// Swift typed dot form is @dynamicMemberLookup, Swift-only). You write only your own
/// folder; to use another package's data, call its exposed feature
/// (`dsx.module["<scheme>"]…`) rather than reaching into its folder. Full security
/// model: OpenSource/Skills/containers.md.
class Container internal constructor(name: String, own: Boolean, autoPost: Boolean = true) {

    companion object {
        /// The bundle-id seam behind `groupID` — iOS derives it from `Bundle.main`;
        /// the host seeds the application id at boot. Empty by default (pure JVM).
        @Volatile
        var bundleIdentifier: String = ""

        /// The one reserved App Group id for this build, derived from the app's
        /// bundle id - matches the `group.${BUNDLE_ID}.container` the CI provisions.
        val groupID: String get() = "group.$bundleIdentifier.container"

        /// The KV seam (see `ContainerKV`). In-memory by default; null = unprovisioned.
        @Volatile
        var backend: ContainerKV? = InMemoryContainerKV()

        /// The shared FILE container seam (Swift: `FileManager.containerURL(for:)`).
        /// Default null = not provisioned (`isAvailable == false`, `url() == null`).
        @Volatile
        var filesRoot: () -> java.io.File? = { null }

        /** Host-owned main-thread executor for `observe` callbacks. The observer
         * registry stays kernel-internal; Android/Desktop bind this public host seam
         * at boot so an IPC/local signal can never call app UI on its transport thread. */
        var observerMainExecutor: Executor
            get() = ContainerObservers.shared.mainExecutor
            set(value) { ContainerObservers.shared.mainExecutor = value }

        /// Keep names safe for KV keys and folder paths: letters, digits,
        /// `.`, `_`, `-`; drop everything else. (URL schemes are already safe.)
        private fun sanitize(raw: String): String =
            raw.filter { it.isLetterOrDigit() && it.code < 128 || it == '.' || it == '_' || it == '-' }
    }

    /// The App Group id this container resolves to. Use it instead of hardcoding
    /// the string anywhere app-side, e.g. `dsx.container.group`.
    val group: String get() = groupID

    /// This subcontainer's name (a package scheme). "" addresses the shared root
    /// (unprefixed); prefer a named subcontainer and don't write to the root.
    val name: String = sanitize(name)
    /// `true` only for `dsx.container` (your own folder). A named view is `false`:
    /// read-only, so a package can't write, remove, or signal inside another
    /// package's folder through this API.
    private val isOwn: Boolean = own
    /// Whether a `set` / `remove` auto-signals observers. `true` by default;
    /// `batch { }` turns it off so a group of writes signals once.
    private val autoPost: Boolean = autoPost

    /// Blocks a write/signal aimed at another package's folder (`own == false`).
    /// An API guardrail and a clear nudge, not a process boundary (containers.md).
    private fun deniesForeign(op: String): Boolean {
        if (isOwn) return false
        if (KernelLog.enabled) {   // Swift: #if DEBUG — KernelLog.enabled is the port's DEBUG seam
            println("[container] '$op' is not allowed on another package's folder '$name'. Write your own via dsx.container, or use $name's exposed feature: dsx.module[\"$name\"]…")
        }
        return true
    }

    // MARK: Subcontainers (the folders inside the one shared group)

    /// A **read-only** view of another package's subcontainer, by name (both Swift
    /// subscripts — dynamic-member and string-keyed — collapse into this operator).
    /// Reads are an escape hatch; writes / posts are blocked - write only your own folder.
    operator fun get(name: String): Container = Container(name, own = false)

    /// Explicit read-only named-subcontainer accessor (same as the subscript).
    fun sub(name: String): Container = Container(name, own = false)

    // MARK: Key/value (scoped to this subcontainer)

    private fun scoped(key: String): String = if (name.isEmpty()) key else "$name.$key"

    /// `true` when the shared container is actually provisioned for this build.
    /// When `false`, file URLs are null, so a package degrades gracefully on a
    /// build that didn't ship the container.
    val isAvailable: Boolean get() = filesRoot() != null

    fun string(key: String): String? = when (val v = backend?.get(scoped(key))) {
        is String -> v
        // A stored Bool bridges to NSNumber on iOS, so UserDefaults.string(forKey:) reads it
        // as "1"/"0" — Kotlin's Boolean isn't a Number, so it needs its own arm (the dsx.list
        // boolean pin's twin; ContainerSeamTest pins this).
        is Boolean -> if (v) "1" else "0"
        is Number -> Bridge.Params.numberString(v)   // UserDefaults.string coerces numbers
        else -> null
    }
    fun bool(key: String): Boolean = when (val v = backend?.get(scoped(key))) {
        is Boolean -> v
        is Number -> v.toDouble() != 0.0
        is String -> v.lowercase().let { it == "true" || it == "yes" || it == "1" }
        else -> false
    }
    fun int(key: String): Int = when (val v = backend?.get(scoped(key))) {
        is Number -> v.toInt()
        is String -> v.toIntOrNull() ?: 0
        is Boolean -> if (v) 1 else 0
        else -> 0
    }
    fun double(key: String): Double = when (val v = backend?.get(scoped(key))) {
        is Number -> v.toDouble()
        is String -> v.toDoubleOrNull() ?: 0.0
        is Boolean -> if (v) 1.0 else 0.0
        else -> 0.0
    }
    fun data(key: String): ByteArray? = backend?.get(scoped(key)) as? ByteArray
    /// The raw stored value (any property-list type), or `null`.
    fun value(key: String): Any? = backend?.get(scoped(key))

    /// Store a value in *your own* folder **and signal observers** - one call,
    /// because the container is for shared data, so a write notifies. Passing
    /// `null` removes the key. Several writes at once: `batch { }` (signals once).
    /// Signal without writing: `post()`. A no-op on another package's folder.
    fun set(key: String, value: Any?) {
        if (deniesForeign("set")) return
        if (value != null) backend?.set(scoped(key), value)
        else backend?.remove(scoped(key))
        if (autoPost) ContainerObservers.shared.post(signalName)
    }

    /// Remove a value from *your own* folder (and signal observers, like `set`).
    /// A no-op on another package's folder.
    fun remove(key: String) {
        if (deniesForeign("remove")) return
        backend?.remove(scoped(key))
        if (autoPost) ContainerObservers.shared.post(signalName)
    }

    /// Group several writes into a single change signal: the writes inside don't
    /// each notify; observers are signalled once when the block returns. Own
    /// folder only.
    ///
    ///     dsx.container.batch { it.set("url", u); it.set("refresh", 15) }
    fun batch(body: (Container) -> Unit) {
        if (deniesForeign("batch")) return
        body(Container(name, own = true, autoPost = false))
        ContainerObservers.shared.post(signalName)
    }

    // MARK: Files (this subcontainer's folder in the shared container)

    /// This subcontainer's folder in the shared file container, created on
    /// demand. `null` when the container isn't provisioned (the `filesRoot` seam).
    fun url(): java.io.File? {
        val base = filesRoot() ?: return null
        if (name.isEmpty()) return base
        var dir = base
        for (seg in name.split(".")) dir = java.io.File(dir, seg)
        dir.mkdirs()
        return dir
    }

    // MARK: Observe (cross-process change signals)

    /// Change-signal name for this subcontainer (the Darwin notification name on iOS).
    private val signalName: String get() = "$groupID.changed.$name"

    /// Signal that this subcontainer changed - a name-only cross-process ping that
    /// observers in any *running* process pick up. Call it after writing. Rides the
    /// `ContainerObservers.transport` seam (in-process by default; `:platform` bridges).
    fun post() {
        if (deniesForeign("post")) return
        ContainerObservers.shared.post(signalName)
    }

    /// Observe cross-process changes to this subcontainer (writes signalled via
    /// `post()` from this app or an extension). The handler runs on the main
    /// thread while the app is alive - re-read the container inside it and deliver
    /// (e.g. `dsx.broadcast`). Returns a subscription; keep it to `cancel()`, or
    /// ignore it to observe for the app's lifetime.
    fun observe(handler: () -> Unit): ContainerSubscription {
        if (deniesForeign("observe")) return ContainerSubscription(name = "", token = UUID.randomUUID())
        val token = ContainerObservers.shared.add(signalName, handler)
        return ContainerSubscription(name = signalName, token = token)
    }
}

/// A handle to a `dsx.container.observe { }` registration; `cancel()` to stop.
class ContainerSubscription internal constructor(
    private val name: String,
    private val token: UUID,
) {
    fun cancel() { ContainerObservers.shared.remove(name, token) }
}

/// Cross-process change signals for the shared container. On iOS these ride Darwin
/// notifications; here the TRANSPORT is a seam (`:platform` bridges to a real IPC
/// signal and calls `fire` on receipt), defaulting to in-process delivery only —
/// which matches the local half of Darwin's behavior (a posted name also loops back
/// to the posting process). Handlers dispatch through the main-thread seam.
internal class ContainerObservers private constructor() {
    companion object {
        val shared = ContainerObservers()
    }

    /// The main-thread seam (the Events.kt pattern). Direct execution by default.
    @Volatile
    var mainExecutor: Executor = Executor { it.run() }

    /// The cross-process transport seam: called by `post(name)`. Default delivers
    /// in-process only; the installer must ALSO keep the local loop-back (fire).
    @Volatile
    var transport: (String) -> Unit = { name -> shared.fire(name) }

    private val lock = Any()
    private val handlers = HashMap<String, LinkedHashMap<UUID, ObserverRegistration>>()

    /** A queued main-executor task retains this lifecycle gate, not a bare handler. */
    private class ObserverRegistration(
        private val handler: () -> Unit,
    ) {
        private val lifecycleLock = Any()
        private var active = true

        fun deliverIfActive() {
            synchronized(lifecycleLock) {
                if (!active) return
            }
            // Never hold the lifecycle monitor across app code: concurrently running
            // observers may cancel one another without a lock-order deadlock.
            handler()
        }

        fun deactivate() {
            synchronized(lifecycleLock) { active = false }
        }
    }

    fun add(name: String, handler: () -> Unit): UUID {
        val token = UUID.randomUUID()
        val registration = ObserverRegistration(handler)
        synchronized(lock) {
            handlers.getOrPut(name) { LinkedHashMap() }[token] = registration
        }
        return token
    }

    fun remove(name: String, token: UUID) {
        val registration = synchronized(lock) {
            val namedHandlers = handlers[name]
            val removed = namedHandlers?.remove(token)
            if (namedHandlers?.isEmpty() == true) handlers.remove(name)
            removed
        }
        // Once this returns, a still-queued fire cannot be newly admitted. An
        // already-admitted callback is in flight and does not hold this monitor.
        registration?.deactivate()
    }

    fun post(name: String) { transport(name) }

    internal fun fire(name: String) {
        val registrations = synchronized(lock) {
            handlers[name]?.values?.toList() ?: emptyList()
        }
        if (registrations.isEmpty()) return
        mainExecutor.execute { registrations.forEach { it.deliverIfActive() } }
    }
}

// MARK: - Cookies — one jar across the web layer, native HTTP, and DSX

/// **DSXCookies** — bridges cookies between the three worlds, JS-style, the web layer as source
/// of truth. When the web surface sets a cookie, the Dom module's observer `ingest`s it here:
///   1. it is **mirrored to the native HTTP jar** (the `nativeStore` seam — Swift's
///      `HTTPCookieStorage.shared`; `:platform` installs the CookieManager bridge) so native
///      `fetch` sends it automatically: auth survives the web→native boundary; and
///   2. a snapshot is published as **`jar`** — the markup's `dsx.cookie.*` source (the reactive
///      face rides the Stack.kt port; the host binds `JSE.cookieJar` at boot).
/// Read-only from DSX in v1 (the web/native sets them).
class DSXCookies private constructor() {
    companion object {
        val shared = DSXCookies()
    }

    private val lock = Any()
    private val mutationLock = Any()
    private val mutableJarFlow = MutableStateFlow<Map<String, String>>(emptyMap())
    private val sinks = LinkedHashMap<UUID, SinkRegistration>()
    private val mutations = ArrayDeque<CookieMutation>()
    private var mutationDrainScheduled = false
    private var mutationOwner: Thread? = null
    private var activeMutationGroup: MutationGroup? = null
    private var mutationGeneration = 0L

    /** One synchronous public mutation. The executor accepts the serial drain before
     * any cookie plane is changed, so rejection is fail-closed: jar, native HTTP and
     * web storage all remain untouched. Concurrent callers wait for their own entry;
     * a callback re-entering on the active drain thread appends and returns so user
     * code can never deadlock the transaction that invoked it. */
    private class MutationGroup {
        private val done = java.util.concurrent.CountDownLatch(1)
        private val groupLock = Any()
        private var remaining = 1
        @Volatile private var failure: Throwable? = null

        fun addReentrantEntry() {
            synchronized(groupLock) {
                check(remaining > 0) { "Cannot append to a completed cookie mutation" }
                remaining += 1
            }
        }

        fun finish(error: Throwable?) {
            val complete = synchronized(groupLock) {
                if (failure == null && error != null) failure = error
                remaining -= 1
                check(remaining >= 0) { "Cookie mutation completed more than once" }
                remaining == 0
            }
            if (complete) done.countDown()
        }

        fun awaitResult() {
            var interrupted = false
            while (true) {
                try {
                    done.await()
                    break
                } catch (_: InterruptedException) {
                    // Once admitted, returning before completion would let a retry
                    // duplicate native/web effects. Finish the transaction, then
                    // restore the caller's interruption status.
                    interrupted = true
                }
            }
            if (interrupted) Thread.currentThread().interrupt()
            failure?.let { throw it }
        }
    }

    private class CookieMutation(
        val action: () -> Unit,
        val group: MutationGroup,
    ) {
        fun finish(error: Throwable?) = group.finish(error)
    }

    /**
     * Initial and update snapshots share a per-registration FIFO. Enqueue is the
     * cancellation boundary; after deactivation no future snapshot is admitted and
     * queued work is discarded. User code is never invoked under registry/lifecycle
     * locks, so cancellation and cookie writes may be re-entrant.
     */
    private class SinkRegistration(
        private val handler: (Map<String, String>) -> Unit,
    ) {
        private val lifecycleLock = Any()
        private var active = true
        private var draining = false
        private val pending = ArrayDeque<Map<String, String>>()

        fun enqueue(snapshot: Map<String, String>): Boolean = synchronized(lifecycleLock) {
            if (!active) return false
            pending.addLast(snapshot)
            if (draining) false else {
                draining = true
                true
            }
        }

        fun drain() {
            while (true) {
                val snapshot = synchronized(lifecycleLock) {
                    if (!active || pending.isEmpty()) {
                        pending.clear()
                        draining = false
                        return
                    }
                    pending.removeFirst()
                }
                try {
                    handler(snapshot)
                } catch (error: Throwable) {
                    synchronized(lifecycleLock) {
                        pending.clear()
                        draining = false
                    }
                    throw error
                }
            }
        }

        fun deactivate() {
            synchronized(lifecycleLock) {
                active = false
                pending.clear()
                draining = false
            }
        }
    }

    /// name → value, the snapshot DSX reads. (`dsx.cookie` = this map; `dsx.cookie.x` = `jar["x"]`.)
    /// Every published value is an immutable copy, so background CookieJar callbacks can
    /// never mutate a collection while JSE/Compose is reading it.
    @Volatile
    var jar: Map<String, String> = emptyMap()
        private set

    /** The Compose-observable face of [jar]. Cookie-bound UI and `<api>` declarations
     * re-materialize immediately after a WebView/native cookie transition. */
    val jarFlow: StateFlow<Map<String, String>> get() = mutableJarFlow
    private var domainHint: String? = null      // last-known web host (the `set` default)

    /// The native-jar mirror seam (see the class doc). No-op by default (pure JVM).
    @Volatile
    var nativeStore: (java.net.HttpCookie) -> Unit = {}

    /// The synchronous cookie-transaction funnel. Hosts install their main-thread
    /// executor; off-thread submissions must complete the command before returning.
    /// Direct by default for pure JVM consumers.
    @Volatile
    var mainExecutor: Executor = Executor { it.run() }

    private fun copyCookie(cookie: java.net.HttpCookie): java.net.HttpCookie =
        cookie.clone() as java.net.HttpCookie

    /** Admit a mutation to the one executor-backed FIFO. The executor is scheduled
     * before [CookieMutation.action] can run, so a rejected submission has no tentative
     * jar value for another thread to observe and no native/web side effect to undo. */
    private fun runMutation(action: () -> Unit) {
        val caller = Thread.currentThread()
        var schedule = false
        var reentrant = false
        var generation = 0L
        var executor: Executor? = null
        lateinit var mutation: CookieMutation
        synchronized(mutationLock) {
            reentrant = mutationOwner === caller
            val group = if (reentrant) {
                checkNotNull(activeMutationGroup) { "Cookie mutation owner has no active group" }
                    .also { it.addReentrantEntry() }
            } else MutationGroup()
            mutation = CookieMutation(action, group)
            mutations.addLast(mutation)
            if (!mutationDrainScheduled) {
                mutationDrainScheduled = true
                schedule = true
                generation = mutationGeneration
                executor = mainExecutor
            }
        }

        if (schedule) {
            try {
                executor!!.execute { drainMutations(generation) }
            } catch (error: Throwable) {
                // A conforming Executor either accepts or throws. Be defensive about an
                // exotic implementation that runs the command and then throws: only fail
                // entries while this exact generation is still awaiting a drain.
                val rejected = synchronized(mutationLock) {
                    if (mutationGeneration == generation &&
                        mutationDrainScheduled && mutationOwner == null &&
                        mutations.any { it === mutation }
                    ) {
                        val pending = mutations.toList()
                        mutations.clear()
                        mutationDrainScheduled = false
                        pending
                    } else emptyList()
                }
                rejected.forEach { it.finish(error) }
            }
        }

        // The active drain must be allowed to finish the callback that re-entered it;
        // it will process this entry before the outermost mutation returns.
        if (!reentrant) mutation.group.awaitResult()
    }

    private fun drainMutations(generation: Long) {
        synchronized(mutationLock) {
            if (mutationGeneration != generation) return
            mutationOwner = Thread.currentThread()
        }
        while (true) {
            val mutation = synchronized(mutationLock) {
                if (mutationGeneration != generation) {
                    mutationOwner = null
                    activeMutationGroup = null
                    return
                }
                if (mutations.isEmpty()) {
                    mutationOwner = null
                    activeMutationGroup = null
                    mutationDrainScheduled = false
                    return
                }
                mutations.removeFirst().also { activeMutationGroup = it.group }
            }
            var failure: Throwable? = null
            try {
                mutation.action()
            } catch (error: Throwable) {
                failure = error
            }
            // One bad observer/native seam must not strand later accepted mutations.
            mutation.finish(failure)
        }
    }

    /** Publish on the already-admitted mutation executor. Registry state is captured
     * under [lock], while StateFlow and user sinks run after it is released. The serial
     * mutation drain gives every plane the same total order without invoking user code
     * under either DSXCookies monitor. */
    private fun publish(snapshot: Map<String, String>): Throwable? {
        val next: Map<String, String> =
            java.util.Collections.unmodifiableMap(LinkedHashMap(snapshot))
        val registrations = synchronized(lock) {
            if (jar == next) return null
            jar = next
            sinks.values.toList()
        }
        var firstFailure: Throwable? = null
        try {
            mutableJarFlow.value = next
        } catch (error: Throwable) {
            firstFailure = error
        }
        registrations.forEach { registration ->
            try {
                if (registration.enqueue(next)) registration.drain()
            } catch (error: Throwable) {
                if (firstFailure == null) firstFailure = error
            }
        }
        return firstFailure
    }

    /** Lifecycle-scoped observer for non-Compose consumers such as a mounted `<api>`.
     * Like StackStore.sink, it receives the current snapshot once on subscription. */
    fun sink(handler: (Map<String, String>) -> Unit): AnyCancellable {
        val token = UUID.randomUUID()
        val registration = SinkRegistration(handler)
        synchronized(lock) {
            sinks[token] = registration
            check(registration.enqueue(jar)) { "A new cookie sink must own its initial drain" }
        }
        fun removeAndDeactivate() {
            val removed = synchronized(lock) {
                if (sinks[token] === registration) sinks.remove(token) else null
            }
            removed?.deactivate()
        }
        try {
            mainExecutor.execute {
                try {
                    registration.drain()
                } catch (error: Throwable) {
                    removeAndDeactivate()
                    throw error
                }
            }
        } catch (error: Throwable) {
            removeAndDeactivate()
            throw error
        }
        return AnyCancellable(::removeAndDeactivate)
    }

    /// The dom module's cookie observer reports the bound web view's host (the default write
    /// domain) — no WebView in the kernel.
    fun setDomainHint(host: String?) {
        if (!host.isNullOrEmpty()) runMutation {
            synchronized(lock) { domainHint = host }
        }
    }

    /// The dom module's cookie observer pushes the web cookie store's cookies here (web → native):
    /// mirror every cookie to the native jar (so native `fetch` sends HttpOnly credentials), but
    /// publish only script-readable cookies. This preserves the browser's `document.cookie`
    /// confidentiality boundary for declarative markup.
    fun ingest(cookies: List<java.net.HttpCookie>) {
        // HttpCookie is mutable; each transaction owns stable copies so a caller or
        // native seam cannot rewrite a later plane's payload mid-flight.
        val batch = cookies.map(::copyCookie)
        runMutation {
            val snap = LinkedHashMap<String, String>()
            for (cookie in batch) {
                if (!cookie.isHttpOnly) snap[cookie.name] = cookie.value
            }
            val inferredDomain = batch.firstOrNull()?.domain?.let { domain ->
                if (domain.startsWith(".")) domain.substring(1) else domain
            }
            synchronized(lock) {
                if (domainHint == null && !inferredDomain.isNullOrEmpty()) domainHint = inferredDomain
            }

            var firstFailure: Throwable? = null
            val mirror = nativeStore
            for (cookie in batch) {
                try {
                    mirror(copyCookie(cookie))                        // mirror → native fetch
                } catch (error: Throwable) {
                    if (firstFailure == null) firstFailure = error
                }
            }
            publish(snap)?.let { if (firstFailure == null) firstFailure = it }
            firstFailure?.let { throw it }
        }
    }

    /// **Set** a cookie — `dsx.cookie.name = "…"` from markup, or `DSXCookies.shared.set(…)`
    /// natively. Written to the native jar (the seam) + the snapshot, and fired as
    /// `cookie.webWrite` so the dom module mirrors it into the web cookie store.
    /// Domain defaults to the web app's host (Dom's reported hint). No host known yet →
    /// logs, no-ops. (`expires` maps to max-age — the JVM cookie shape; see header NOTES.)
    fun set(name: String, value: String, domain: String? = null, path: String = "/",
            expires: java.util.Date? = null) {
        runMutation {
            val host = domain ?: synchronized(lock) { domainHint }
            if (host.isNullOrEmpty()) {
                kernelLog("[DSXCookies] cannot set '$name': no web host known yet — set it after the web layer has loaded, or pass a domain.")
                return@runMutation
            }
            val cookie = try {
                java.net.HttpCookie(name, value).also {
                    it.domain = host
                    it.path = path
                    if (expires != null) {
                        it.maxAge = ((expires.time - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                    }
                }
            } catch (_: Exception) {
                return@runMutation                              // HTTPCookie(properties:) nil twin
            }
            val next = synchronized(lock) {
                when {
                    cookie.hasExpired() -> if (jar.containsKey(name)) jar - name else jar
                    jar[name] != value -> jar + (name to value)
                    else -> jar
                }
            }

            // The accepted FIFO defines one total order for every plane. All seams and
            // sinks run outside DSXCookies monitors; failures are remembered while the
            // remaining planes still receive the same winning mutation.
            var firstFailure: Throwable? = null
            try {
                nativeStore(copyCookie(cookie))                  // native fetch sends it
            } catch (error: Throwable) {
                firstFailure = error
            }
            publish(next)?.let { if (firstFailure == null) firstFailure = it }
            try {
                // The dom module hooks this event to write into the web cookie store.
                ModuleRegistry.shared.dispatch("cookie.webWrite", copyCookie(cookie), combine = ModuleRegistry.Combine.void)
            } catch (error: Throwable) {
                if (firstFailure == null) firstFailure = error
            }
            firstFailure?.let { throw it }
        }
    }

    /** Process-singleton isolation for the pure-JVM conformance suite. Advancing the
     * mailbox generation invalidates already-scheduled drains; deactivating registrations
     * prevents a leaked sink from observing a later test. Host seams are deliberately
     * left untouched so each test can save and restore the executor/native store. */
    internal fun resetForTests() {
        val abandoned = synchronized(mutationLock) {
            check(mutationOwner == null) { "Cannot reset DSXCookies during an active mutation" }
            mutationGeneration += 1
            val pending = mutations.toList()
            mutations.clear()
            mutationDrainScheduled = false
            pending
        }
        val resetError = IllegalStateException("DSXCookies reset while a mutation was queued")
        abandoned.forEach { it.finish(resetError) }
        val registrations = synchronized(lock) {
            jar = emptyMap()
            domainHint = null
            val current = sinks.values.toList()
            sinks.clear()
            current
        }
        registrations.forEach { it.deactivate() }
        mutableJarFlow.value = emptyMap()
    }
}

// MARK: - Cross-package call proxies (dsx.module subscript chains)
//
// Each chain step (`dsx.module` -> `["appsflyer"]` -> `["set_user_id"]` -> `(args)`)
// is a tiny stateless wrapper. `operator fun get` powers the chain step (Swift's
// @dynamicMemberLookup dot AND `[…]` forms collapse into it); the leaf's suspending
// `operator fun invoke` awaits the result, `.post` is the fire-and-forget twin of a
// bare Swift call (see the header NOTES for the pinned split).

/// `dsx.module` — the unified, DSX-aligned root.
class ModuleProxy internal constructor(internal val dsx: Context) {
    operator fun get(scheme: String): ModuleScheme = ModuleScheme(dsx, scheme)

    /// The canonical call contract — ONE JSON envelope: `{ scheme, method: […], args }`.
    /// `method` is an ARRAY path (never a dotted string — no separator can collide), lowered to
    /// the registry's `scheme://a/b/c` route. The subscript sugar (`dsx.module["x"]["a"]["b"](args)`)
    /// lowers to exactly this. Awaitable; returns the handler's `dsx.resolve(...)` payload,
    /// throws `ModuleCallError` like the chain form.
    ///
    ///     dsx.module(JSON.obj()
    ///         .put("scheme", "airbridge")
    ///         .put("method", JSON.arr("track", "event"))
    ///         .put("args",   JSON.obj().put("name", "purchase")))
    suspend operator fun invoke(envelope: JSON): JSON {
        val dict = envelope.foundationValue as? Map<String, Any?> ?: emptyMap()
        val scheme = dict["scheme"] as? String ?: ""
        val path = (dict["method"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
        val args = (dict["args"] as? Map<*, *>)?.let { m ->
            if (m.keys.all { it is String }) m as Map<String, Any?> else null
        }
        return dsx._call(scheme = scheme, action = path.joinToString("/"), args = args)
    }
}

class ModuleScheme internal constructor(
    private val dsx: Context,
    private val scheme: String,
) {
    operator fun get(action: String): ModuleAction = ModuleAction(dsx, scheme, action)

    /// The live native object this package EXPORTED under `name` (via `dsx.export`), or null —
    /// cast it to the concrete type (the caller names the type; the kernel never does). Owner-
    /// namespaced, so `dsx.module["dom"].object("view")` is unambiguously Dom's exported "view".
    /// (Kotlin call sites backtick the keyword: `` .`object`("view") `` — see header NOTES.)
    fun `object`(name: String): Any? = dsx.shared.use("$scheme.$name")

    /// `dsx.module["<scheme>"].context` — READ this package's published context (data), typed +
    /// exclusion-safe: `dsx.module["metaads"].context["facebookAds"].bool` (pull, nested via
    /// chained `[…]`) or `.context.on("facebookAds") { … }` (subscribe). An excluded owner has no
    /// registry entry, so every read is the declared default (fail-open). See DSXStateProxy.
    val context: DSXStateProxy get() = DSXStateProxy(scheme)
    /// Transitional alias of `.context` — kept so existing `.state` reads keep compiling.
    val state: DSXStateProxy get() = DSXStateProxy(scheme)

    /// `dsx.module["<scheme>"].delegate["<event>"]` — ATTACH to (or INVOKE) a delegate point this
    /// package owns, scheme-namespaced (`<scheme>.<event>`) so two packages' same-named points
    /// never collide. Mirrors `dsx.delegate` (host events) but scoped to a named package.
    val delegate: DSXDelegateProxy get() = DSXDelegateProxy(dsx, prefix = "$scheme.")

    /// The handle's spelling alias-normalized to its PRIMARY chain (`resolveChain` with an
    /// empty action path — the head step alone). The reserved members below all speak
    /// identity, and identity is always the primary chain: an alias handle must answer the
    /// same facts and hear the same channels as the primary spelling.
    private val primaryChain: String get() = ModuleRegistry.shared.resolveChain(scheme, "").chain

    /// `dsx.module["<chain>"].available` — TRUE when this identity is registered in THIS build
    /// and not under the excluded overlay. The generic pre-flight for optional modules; a
    /// never-existed name answers false here AND false at `.excluded` (the honest split).
    /// Reserved member (real — it shadows any same-named action, which the manifests gate
    /// bans anyway); non-throwing. Kotlin twin of Swift `ModuleScheme.available`.
    val available: Boolean
        get() = ModuleRegistry.shared.isAvailable(primaryChain) &&
            ModuleRegistry.shared.excludedEntry(primaryChain) == null

    /// `dsx.module["<chain>"].excluded` — the honest build fact: `false` when shipped (or when
    /// the name never existed), else the DespiaExcluded entry (`{ reason: "excluded" |
    /// "cascade", from? }`) — the 1:1 twin of Swift `ModuleScheme.excluded` and the page's
    /// `despia.excluded` entries.
    val excluded: JSON
        get() {
            val entry = ModuleRegistry.shared.excludedEntry(primaryChain) ?: return JSON.from(false)
            return JSON.from(entry)
        }

    /// `dsx.module["<chain>"].on("kind") { payload -> … }` — subscribe to this module's OWN
    /// events: the author's scoped emission rides the bus as `<chain>.<kind>`, so this is
    /// exact sugar over `dsx.delegate.listen`. The channel is the PRIMARY chain — modules emit under
    /// their `resolvedScheme`, so an alias handle alias-normalizes first and hears the same
    /// channel (the Swift twin does the same). When the owner registers LATER than this
    /// subscription the table can't normalize yet and the hook keys the verbatim spelling —
    /// the emission-side alias fan-out (ModuleRegistry.dispatch `.void` / dsx.broadcast) still delivers,
    /// so boot order never decides whether a hook hears. Reserved member (real — no action
    /// can ever be named `on`); non-throwing.
    fun on(kind: String, handler: (Any?) -> Any?) {
        dsx.register("$primaryChain.$kind", handler = handler)
    }
}

class ModuleAction internal constructor(
    private val dsx: Context,
    private val scheme: String,
    private val action: String,
) {
    /// N-level chaining — `dsx.module["store"]["products"]["subscriptions"]["buy"](args)`
    /// accumulates the path (`products/subscriptions/buy`), the array path of the envelope one
    /// segment per step, lowered to the registry route `store://products/subscriptions/buy`.
    operator fun get(segment: String): ModuleAction = ModuleAction(dsx, scheme, "$action/$segment")

    /// Awaitable — the native twin of `await dsx.module.scheme.action({…})` (suspends). Returns
    /// the handler's `dsx.resolve(...)` payload; throws `ModuleCallError` (`ActionFailed` on
    /// `dsx.error`, `NotLoaded` when no package owns the scheme).
    suspend operator fun invoke(args: Map<String, Any?>? = null): JSON =
        dsx._call(scheme = scheme, action = action, args = args)

    /// JSON-arg overload — the 1:1 cross-language register (`dsx.module["x"]["y"](JSON.obj().put(…))`),
    /// what the generated typed accessors lower into.
    suspend operator fun invoke(args: JSON): JSON =
        dsx._call(scheme = scheme, action = action, args = args.foundationValue as? Map<String, Any?>)

    /// Fire-and-forget — the native twin of a bare Swift `dsx.module.scheme.action({…})` (no
    /// await): routes the call, ignores the result. Throws the sync `ModuleCallError` cases
    /// (`NotLoaded` / `InvalidURI`) — catch-and-drop is the safe-fail idiom (Swift `try?`).
    /// (Named — a Kotlin suspend + non-suspend `invoke` pair is a conflicting overload; header NOTES.)
    fun post(args: Map<String, Any?>? = null) {
        dsx._dispatch(scheme = scheme, action = action, args = args)
    }
    fun post(args: JSON) {
        dsx._dispatch(scheme = scheme, action = action, args = args.foundationValue as? Map<String, Any?>)
    }
}

// MARK: - dsx.delegate (the declared, typed delegate primitive — one fold, five policies)

/// `dsx.delegate["<event>"]` / `dsx.module["<scheme>"].delegate["<event>"]`. The chain step;
/// `prefix` is empty for host events and `"<scheme>."` for a package's own declared delegate
/// points (so they namespace).
class DSXDelegateProxy internal constructor(
    private val dsx: Context,
    private val prefix: String,
) {
    operator fun get(event: String): DSXDelegateEvent = DSXDelegateEvent(dsx, prefix + event)

    // MARK: listen / send — the two-verb delegate primitive (delegates.md §2)
    //
    // `listen`/`send` are the ONLY primitives, and they lower STRAIGHT to the kernel fold — the
    // `hook`/`fire`/`fireAny`/`claim`/`collect` verbs that used to sit in between are DELETED
    // (delegates.md phase 4 — the combine policy IS what those verb names encoded).
    // `listen` is the consume side (no declaration — listening is reading the global event
    // namespace); `send` is the expose side (the emitter declares the point in its `dsx.json`
    // `delegate` block), with `allows` as its plain-Bool veto-gate form. ("listen"/"send"/
    // "allows" are therefore reserved event names — none exist.)

    /// LISTEN — attach a handler to a delegate event (the CONSUME side). THE one attach verb.
    /// Zero declaration. The handler IS the raw kernel watcher — return a value to answer (a
    /// `Boolean` to veto, a payload to claim/collect) or `null` to abstain; higher `priority`
    /// runs first. One hop to `Context.register`, so nothing sits between you and the fold.
    fun listen(event: String, priority: Int = 0, handler: (Any?) -> Any?) {
        dsx.register(prefix + event, priority, handler)
    }

    /// SEND — emit a delegate event and return the RAW folded answer (the EXPOSE side). The fold
    /// `combine` is resolved in this order: an explicit `combine` argument, else the emitter's
    /// declared `dsx.json` `delegate` policy (GeneratedDelegateRegistry), else `claim`. Returns
    /// the value straight from `dispatch` — `Boolean` for `any`/`veto`, `List<Any>` for
    /// `collect`, the claimant for `claim`, `null` for `void`.
    ///
    /// PASS `combine` EXPLICITLY when the fold must not depend on a declaration surviving into
    /// THIS build: an excluded owner contributes no `delegate` block and the silent fallback is
    /// `claim`, which SHORT-CIRCUITS. Every site the phase-4 collapse rewrote from a fire-verb
    /// therefore names its policy — the declaration then documents the contract and powers the
    /// `dsx.delegate["<event>"]()` sugar, but never silently decides a fan-out.
    fun send(event: String, payload: Any? = null, combine: ModuleRegistry.Combine? = null): Any? {
        val name = prefix + event
        val policy = combine
            ?: ModuleRegistry.Combine.declared(GeneratedDelegateRegistry.byEvent[name]?.combine)
            ?: ModuleRegistry.Combine.claim
        return ModuleRegistry.shared.dispatch(name, payload, policy)
    }

    /// ALLOWS — a veto gate read as a plain `Boolean`. Sends `event` with the `veto` fold:
    /// `false` only if some watcher vetoed (returned `false`), `true` when none did — including
    /// no watchers — so an ungated event always proceeds.
    ///
    ///     if (!dsx.delegate.allows("airbridge.willTrackEvent", mapOf("category" to cat))) return
    fun allows(event: String, payload: Any? = null): Boolean =
        (send(event, payload, ModuleRegistry.Combine.veto) as? Boolean) ?: true
}

/// One delegate point. ATTACH a handler (closure arg) or INVOKE the fold (payload arg); both flow
/// through the same kernel watcher pipeline, so any number of packages fold together. The combine
/// policy + default come from the owner's `dsx.json` `delegate` block (→ GeneratedDelegateRegistry);
/// an undeclared event folds as `claim` (first answer).
class DSXDelegateEvent internal constructor(
    private val dsx: Context,
    private val event: String,
) {
    /// ATTACH — `dsx.delegate["<event>"] { input -> … }`. `input` is the raw payload (cast it,
    /// like any `dsx.delegate.listen` watcher); return a `JSON` answer or `null` to abstain.
    operator fun invoke(handler: (Any?) -> JSON?) {
        dsx.register(event) { input -> handler(input)?.foundationValue }
    }

    /// INVOKE — `dsx.delegate["<event>"](payload)`. Runs every attacher and COMBINES per the
    /// declared policy: `claim` first answer · `any` Boolean (any answered) · `veto` Boolean
    /// (denied if any answers `false`) · `collect` array of answers · `void` broadcast (null).
    /// No handler → the declared default.
    @Suppress("UNCHECKED_CAST")
    operator fun invoke(payload: JSON = JSON.obj()): JSON? {
        val spec = GeneratedDelegateRegistry.byEvent[event]
        val input = payload.foundationValue
        val fold = { c: ModuleRegistry.Combine -> ModuleRegistry.shared.dispatch(event, input, c) }
        val gather = { (fold(ModuleRegistry.Combine.collect) as? List<Any>) ?: emptyList() }
        return when (spec?.combine ?: "claim") {
            "void" -> { fold(ModuleRegistry.Combine.void); null }
            "any" -> JSON.from((fold(ModuleRegistry.Combine.any) as? Boolean) ?: false)
            "collect" -> JSON.from(gather().map { JSON.from(it) })
            // `collect`, NOT `veto`: this sugar has always folded veto WITHOUT short-circuiting,
            // so every attacher runs even after a denial. Kept bit-for-bit by the collapse
            // (`dsx.delegate.allows` is the short-circuiting form, and it is unchanged).
            "veto" -> JSON.from(!gather().any { (it as? Boolean) == false })
            else -> fold(ModuleRegistry.Combine.claim)?.let { JSON.from(it) } ?: spec?.fallback
        }
    }
}

/// One-shot latch. Backs `dsx.module`'s "resolve OR error, never both, never twice"
/// guarantee in the face of misbehaving handlers.
internal class Once {
    private val lock = Any()
    private var claimed = false
    fun claim(): Boolean = synchronized(lock) {
        if (claimed) return false
        claimed = true
        true
    }
}

// MARK: - dsx.fetch (cross-platform HTTP)
//
// A single native HTTP surface every package shares instead of hand-rolling a client.
// Runs natively (works backgrounded, carries auth headers) and mirrors 1:1 to iOS:
//
//     val res = dsx.fetch("https://api…/x",
//                         method = "POST",
//                         headers = mapOf("Authorization" to "Bearer $token"),
//                         query = mapOf("current_show" to id),
//                         body = mapOf("balance" to 50))
//     if (res.ok) { val json = res.json() }

/// Result of `dsx.fetch`. Same field shape across iOS/Android.
class FetchResponse(
    /// HTTP status code (e.g. 200, 404). 0 only for non-HTTP responses.
    val status: Int,
    /// Response header fields (as returned by the server).
    val headers: Map<String, String>,
    /// Raw response body.
    val body: ByteArray,
    /** True only when the native transport already delivered SSE frames
     * incrementally; the terminal response does not retain a second body copy. */
    val streamed: Boolean = false,
) {
    /// 2xx convenience flag — mirrors the JS `Response.ok`.
    val ok: Boolean get() = status in 200..299

    /// Body decoded as UTF-8 text ("" if empty).
    fun text(): String = if (body.isEmpty()) "" else String(body, Charsets.UTF_8)

    /// Body parsed as JSON (the null case if the body isn't valid JSON).
    fun json(): JSON {
        if (body.isEmpty()) return JSON.from(null)
        return json(text())
    }

    /// Body parsed as a JSON object (empty map on failure) — the common case.
    val dictionary: Map<String, Any?>
        get() = (json().foundationValue as? Map<String, Any?>) ?: emptyMap()
}

/// Errors thrown by `dsx.fetch`. Codes match the iOS runtime so callers can
/// branch identically on both platforms.
sealed class FetchError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class InvalidURL(val url: String) : FetchError("invalid url: $url")            // "invalid_url"
    class Transport(cause: Throwable) : FetchError("network: ${cause.message}", cause)   // "network"
    class NoResponse : FetchError("no response")                                   // "no_response"

    val code: String
        get() = when (this) {
            is InvalidURL -> "invalid_url"
            is Transport -> "network"
            is NoResponse -> "no_response"
        }
}
