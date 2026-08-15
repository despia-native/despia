//
//  Messenger.kt — dsx.messenger: the multi-surface bridge (Kotlin twin of
//  Messenger.swift; messenger.md, mechanism B).
//
//  ONE unified seam that works identically for EVERY surface — the web (<DSXWebView/>),
//  a game runtime (<Godot/>), any future native canvas. A surface OWNER mounts one
//  sink and its content becomes a first-class bus consumer:
//
//    val mount = dsx.messenger.mount("godot") { egress -> /* deliver to my surface */ }
//
//    • INBOUND  — `mount.receive(scheme, action, args, rid)` relays one of the
//      surface's CONTENT calls onto the bus at the UNTRUSTED tier
//      (`includeInternal: false` — the exact flag the web relay passes): internal
//      (`exposed: false`) actions stay invisible and declarative manifest gates
//      apply. Trust stays SOURCE-ANCHORED (gate the content at LOAD time —
//      Skills/security.md); no per-call allowlist, by doctrine.
//    • OUTBOUND — the kernel routes that call's resolve / error / per-call stream
//      events back to the ORIGIN surface's sink (Context routes by the call's
//      `surfaceID`), and fans every `dsx.broadcast` out to ALL mounted sinks
//      (rid == null; the surface filters client-side, exactly like the web's
//      `despia.on` listener map).
//
//  No kernel DEADLINE, on purpose: a handler that never settles never delivers.
//  Each surface owns its own timeout — the web's lives in runtime.js
//  (`despia.arm`), a game's in its SDK — mirroring where that policy always lived.
//
//  The WEB is mounted too: DSXWebView mounts "web" (its sink → window.despia.__proxy),
//  and "web" is the DEFAULT target for calls carrying no surface origin (the
//  legacy web transports don't stamp one) — so the kernel's reply switch is fully
//  surface-anonymous.
//
//  Kernel-clean by construction: this file names no surface and imports nothing
//  but the JDK — `dsx.messenger` sits next to `dsx.events` / `dsx.shared` (public
//  façade + internal singleton; the hub is referenced ONLY through the façade's
//  internal deliver seams, the DSXEvents.publish pattern).
//
//  Pure-JVM seams (PLAN.md ground rule 3 — this module never names the Android
//  Looper or the module registry):
//    • DSXMessenger.inboundMainExecutor / outboundMainExecutor — Swift's distinct
//      main.async receive hop and main.sync ordered egress hop. They default to DIRECT
//      execution for pure JVM use; Android/Desktop install their asynchronous and
//      synchronous UI executors explicitly at boot.
//    • DSXMessengerMount.dispatch — Swift calls ModuleRegistry.shared.handle(…)
//      directly; the registry is host-side (K2 `:platform`), so the call sits
//      behind this settable seam, defaulting INERT (`false` = unowned scheme),
//      which makes a pure-JVM `receive` settle with the same synthetic
//      `not_loaded` error. The installed dispatcher MUST pass
//      `includeInternal: false` — the untrusted tier is doctrine, part of this
//      seam's contract, never a per-mount option.
//    • NSNull → plain null: JVM maps hold nulls directly, so the synthetic
//      envelope keeps the `id` / `data` KEYS present with null values (Json.kt
//      renders that as JSON null — the same wire shape).
//    • ModuleRegistry.platformSupport — consulted (read-only) when a dispatch
//      comes back unhandled, to answer the graceful `unsupported_platform`
//      envelope for a catalog scheme with no implementation on this OS, distinct
//      from `not_loaded` (excluded by THIS app / unknown scheme). Pure JVM (the
//      registry lives in :core) and DEFAULT EMPTY, so a bare kernel keeps
//      synthesizing `not_loaded` exactly as before.
//

package despia.engine

import java.util.concurrent.Executor

/// One unit of surface-bound delivery — INTENT, never JS/engine specifics.
/// `payload` is the canonical reply envelope (the same shape `window.despia.__proxy`
/// consumes): `{ id, scheme, host, event, final, data, code?, recoverable?, message? }`.
class DSXEgress internal constructor(
    /// The surface this delivery targets ("*" for a broadcast fan-out).
    val target: String,
    /// The envelope's scheme (the called module for correlated replies; the
    /// broadcast channel for out-of-band events).
    val scheme: String,
    /// Non-null ⇒ correlated (the resolve/error/stream of ONE call, keyed to the
    /// surface SDK's pending map). Null ⇒ out-of-band broadcast.
    val rid: String?,
    val payload: Map<String, Any?>,
)

/** One mounted surface generation. The same lifecycle gate owns outbound delivery
 * and inbound receive admission, so an old handle cannot dispatch into its replacement. */
internal class DSXMessengerRegistration(
    private val sink: (DSXEgress) -> Unit,
) {
    private val lifecycleLock = Any()
    private var active = true

    fun isActive(): Boolean = synchronized(lifecycleLock) { active }

    fun runInboundIfActive(block: () -> Unit) {
        val admitted = synchronized(lifecycleLock) { active }
        if (admitted) block()
    }

    fun deliverIfActive(egress: DSXEgress) {
        val admitted = synchronized(lifecycleLock) { active }
        if (admitted) sink(egress)
    }

    fun deactivate() {
        synchronized(lifecycleLock) { active = false }
    }
}

/// The mounted-sink registry (the actual store). Internal — surfaces reach it
/// through the `dsx.messenger` façade, never directly (the DSXEventBus pattern).
internal class DSXMessengerHub private constructor() {
    companion object {
        val shared = DSXMessengerHub()
    }

    private val lock = Any()
    private val sinks = LinkedHashMap<String, DSXMessengerRegistration>()

    fun mount(id: String, sink: (DSXEgress) -> Unit): DSXMessengerRegistration {
        val registration = DSXMessengerRegistration(sink)
        synchronized(lock) {
            // Close the old generation before making the replacement discoverable.
            // This is the linearization point for both inbound admission and outbound
            // lookup: there is never a window where the new sink is public while an old
            // mount handle can still dispatch under the same id.
            sinks[id]?.deactivate()
            sinks[id] = registration
        }
        return registration
    }

    fun unmount(id: String, registration: DSXMessengerRegistration) {
        synchronized(lock) {
            // A stale mount handle must never detach a newer replacement.
            if (sinks[id] === registration) sinks.remove(id)
        }
        registration.deactivate()
    }

    /// Correlated delivery to ONE surface, on the main thread. `false` when no sink
    /// is mounted under `id` (a pure-native app's web target, a torn-down surface).
    /// Off-main callers hop with main.SYNC in Swift — the same discipline the
    /// pre-messenger web transport had — so an emitter's sequence of envelopes for
    /// one rid can never reorder (an async hop could let a later resolve overtake
    /// an earlier stream event emitted from a different thread). Here the hop is
    /// the `outboundMainExecutor` seam; its installer owns that ordering contract.
    fun deliver(id: String, egress: DSXEgress): Boolean {
        val registration = synchronized(lock) { sinks[id] } ?: return false
        DSXMessenger.outboundMainExecutor.execute { registration.deliverIfActive(egress) }
        return true
    }

    /** Deliver only to the originating mount generation. Synthetic receive errors use
     * this path so a replacement mounted under the same public id cannot inherit them. */
    fun deliver(registration: DSXMessengerRegistration, egress: DSXEgress) {
        DSXMessenger.outboundMainExecutor.execute { registration.deliverIfActive(egress) }
    }

    /// Broadcast fan-out to EVERY mounted sink, on the main thread (sync hop
    /// off-main, same ordering discipline as `deliver`). Surfaces filter
    /// client-side (their SDK's listener map), exactly like the web's `despia.on`.
    fun deliverBroadcast(egress: DSXEgress) {
        val all = synchronized(lock) { sinks.values.toList() }
        if (all.isEmpty()) return
        DSXMessenger.outboundMainExecutor.execute { all.forEach { it.deliverIfActive(egress) } }
    }
}

/// `dsx.messenger` — mount a surface onto the bus. A façade over the hub, exposed
/// identically on every dsx (like `dsx.events`).
class DSXMessenger {

    companion object {
        /** Surface calls enter the registry asynchronously on the host UI thread. */
        @Volatile
        var inboundMainExecutor: Executor = Executor { it.run() }

        /** Replies/events use an ordered synchronous UI hop so one rid cannot reorder. */
        @Volatile
        var outboundMainExecutor: Executor = Executor { it.run() }
    }

    /// INTERNAL delivery seams — the kernel's reply router (`Context.resolve` /
    /// `sendError` / `event` / `broadcast`) delivers through THESE, so the hub
    /// singleton is referenced only inside this file (the DSXEvents.publish
    /// pattern). Surfaces never call these — they mount and receive.
    internal fun deliver(id: String, egress: DSXEgress): Boolean =
        DSXMessengerHub.shared.deliver(id, egress)

    /** Route to the exact mounted generation captured at inbound admission. Context
     * uses this for correlated replies; replacement generations never inherit them. */
    internal fun deliver(registration: DSXMessengerRegistration, egress: DSXEgress) {
        DSXMessengerHub.shared.deliver(registration, egress)
    }

    internal fun deliverBroadcast(egress: DSXEgress) {
        DSXMessengerHub.shared.deliverBroadcast(egress)
    }

    /// Mount THIS surface's delivery sink under a unique id (the surface's own
    /// scheme by convention). Returns the mount handle used to feed the surface's
    /// inbound calls; keep it for the surface's lifetime, `unmount()` to detach.
    /// Mounting the same id again replaces the sink (a re-created surface rebinds).
    fun mount(id: String, sink: (DSXEgress) -> Unit): DSXMessengerMount {
        val registration = DSXMessengerHub.shared.mount(id, sink)
        return DSXMessengerMount(id, registration)
    }
}

/// A mounted surface's handle: the INBOUND half of the bridge.
class DSXMessengerMount internal constructor(
    val id: String,
    private val registration: DSXMessengerRegistration,
) {
    /**
     * Compatibility handle for embedders that inject a receive-only mount (the
     * attributed DOM bridge test/provider seam is one). It intentionally owns an
     * unregistered generation: it can dispatch inbound calls through [dispatch],
     * but it can neither receive another mount's replies nor detach a live sink
     * with the same public id.
     */
    internal constructor(id: String) : this(id, DSXMessengerRegistration { })

    companion object {
        /// The legacy bus-dispatch seam — Swift's `ModuleRegistry.shared.handle(scheme,
        /// actionPath, params, includeInternal: false)` with `Bridge.Params(dict:
        /// args, requestID: rid, surfaceID: surface)`. VirtualBridge uses this
        /// public rid-less path. Mounted surfaces use [mountedDispatch] below so
        /// their exact generation reaches Bridge.Params. Host-side (K2 `:platform`)
        /// installs both registry paths; the default is INERT (`false` = unowned
        /// scheme). The installer MUST dispatch at the untrusted tier
        /// (`includeInternal: false`) — doctrine, see header.
        @Volatile
        var dispatch: (
            scheme: String, action: String, args: Map<String, Any?>,
            rid: String?, surfaceID: String,
        ) -> Boolean = { _, _, _, _, _ -> false }
            set(value) {
                field = value
                // Replacing the public embedding seam transfers ownership of mounted
                // dispatch too. This makes test/host restoration complete and prevents
                // a stale token-aware registry closure leaking across owners.
                mountedDispatch = legacyMountedDispatch
            }

        private val legacyMountedDispatch: (
            scheme: String, action: String, args: Map<String, Any?>,
            rid: String?, surfaceID: String, registration: DSXMessengerRegistration,
        ) -> Boolean = { scheme, action, args, rid, surfaceID, _ ->
            dispatch(scheme, action, args, rid, surfaceID)
        }

        /** Mounted-surface dispatch carries the admission generation separately
         * from the stable public surface id. Its default dynamically delegates to
         * [dispatch], preserving pure-JVM tests and legacy embedding seams. */
        @Volatile
        internal var mountedDispatch: (
            scheme: String, action: String, args: Map<String, Any?>,
            rid: String?, surfaceID: String, registration: DSXMessengerRegistration,
        ) -> Boolean = legacyMountedDispatch

        /// THE K2 BUS BINDING — install the real registry dispatcher behind the seam.
        /// One documented line in the Android host's boot wiring
        /// (`DSXMessengerMount.bindRegistry()`) swaps the inert default for Swift's direct
        /// call: `ModuleRegistry.shared.handle(scheme, actionPath, params,
        /// includeInternal: false)`. It lives HERE (not in the host) because
        /// `Bridge.Params` construction is kernel-internal by design — the host installs
        /// the binding, the kernel owns the params AND the untrusted tier
        /// (`includeInternal: false` is hardcoded: doctrine, never an installer option).
        fun bindRegistry() {
            dispatch = { scheme, action, args, rid, surfaceID ->
                ModuleRegistry.shared.handle(
                    scheme = scheme, actionPath = action,
                    params = Bridge.Params(dict = args, requestID = rid, surfaceID = surfaceID),
                    includeInternal = false)
            }
            mountedDispatch = { scheme, action, args, rid, surfaceID, registration ->
                ModuleRegistry.shared.handle(
                    scheme = scheme,
                    actionPath = action,
                    params = Bridge.Params(
                        dict = args,
                        requestID = rid,
                        surfaceID = surfaceID,
                        messengerRegistration = registration,
                    ),
                    includeInternal = false,
                )
            }
        }

    }

    private fun syntheticError(
        surface: String, scheme: String, action: String,
        rid: String?, code: String, message: String? = null, data: Any? = null,
    ) {
        // NSNull → plain null (keys stay present — see header). Like Context.sendError,
        // `message` rides the envelope only when given (the structured-error contract).
        val envelope = LinkedHashMap<String, Any?>()
        envelope["id"] = rid; envelope["scheme"] = scheme; envelope["host"] = action
        envelope["event"] = "error"; envelope["final"] = true; envelope["data"] = data
        envelope["code"] = code; envelope["recoverable"] = false
        if (message != null) envelope["message"] = message
        DSXMessenger().deliver(
            registration,
            DSXEgress(target = surface, scheme = scheme, rid = rid, payload = envelope),
        )
    }

    /// Relay one of this surface's CONTENT calls onto the bus — the exact mirror of
    /// the web transport: dispatch at the untrusted tier, correlate by `rid`. The
    /// reply (and any per-call stream events) arrives at this mount's sink as a
    /// correlated `DSXEgress`; an unowned scheme / malformed target synthesizes an
    /// `error` envelope (`code: "not_loaded"` / `"invalid_uri"`) so the surface's
    /// pending call always settles the same way the web's would.
    fun receive(scheme: String, action: String, args: Map<String, Any?>? = null, rid: String? = null) {
        // Fast rejection prevents even an invalid-uri reply from an old handle reaching
        // a newer surface generation mounted under the same public id.
        if (!registration.isActive()) return
        val surface = id
        // A scheme is a routing KEY, not URL grammar — identifier names
        // (`godot_test`) dispatch by string, same as the web's object-body
        // transport. Only an EMPTY scheme is unroutable.
        val params = args ?: emptyMap()
        // Action handlers render UI, so they must run on the main thread — the
        // web→bridge path always delivers there; a surface relay may not. Swift
        // hops with main.async; admission is checked again after that queue boundary.
        DSXMessenger.inboundMainExecutor.execute {
            registration.runInboundIfActive {
                if (scheme.isEmpty()) {
                    syntheticError(surface, scheme, action, rid, "invalid_uri")
                    return@runInboundIfActive
                }
                if (mountedDispatch(
                        scheme, action, params, rid, surface, registration,
                    )) return@runInboundIfActive
                val supported = ModuleRegistry.shared.unsupportedPlatforms(scheme)
                if (supported != null) {
                    // In the catalog but NOT implemented on this OS: the graceful, structured
                    // `unsupported_platform` envelope (message + data pinned in
                    // api-mapping.md), distinct from `not_loaded` below (which stays the
                    // answer for excluded-by-this-app AND unknown schemes).
                    syntheticError(surface, scheme, action, rid, "unsupported_platform",
                                   message = ModuleRegistry.shared.unsupportedPlatformMessage(scheme),
                                   data = ModuleRegistry.shared.unsupportedPlatformData(scheme, supported))
                } else {
                    syntheticError(surface, scheme, action, rid, "not_loaded")
                }
            }
        }
    }

    fun unmount() {
        DSXMessengerHub.shared.unmount(id, registration)
    }
}

/// THE MARKUP PACKAGE-CALL BINDING — the `DSXMessengerMount.bindRegistry()` sibling for the
/// JSE runner's `JSERunner.moduleHandle` seam: markup `on:tap="dsx.module.<scheme>.<action>({…})"`,
/// the dev-center verbs (`dsx.module.self.*`) and `await dsx.module.…` all lower onto that seam,
/// which is INERT by default (a bare kernel dispatches nothing → the runner's `unavailable`
/// envelope). The host installs the real registry with ONE boot line
/// (`DSXModuleCallMount.bindRegistry()`). It lives HERE (not in the host) because
/// `Bridge.Params`'s dict/onTerminal constructor is kernel-internal by design — and the TRUST
/// TIER is kernel doctrine, never an installer option: markup runs IN-PROCESS, so the dispatch
/// is `includeInternal = true`, byte-for-byte the Swift runner's tier (Stack.swift's
/// `ModuleRegistry.shared.handle(url:params:includeInternal: true)` at every dispatch site).
object DSXModuleCallMount {
    fun bindRegistry() {
        JSERunner.moduleHandle = { url, args, onTerminal ->
            // The runner hands a normalized carrier ("scheme://action[/rest][?…]"). Split by
            // string — a scheme is a routing KEY, not URL grammar (`godot_test` is legal), so
            // java.net.URI must not adjudicate it. Query args (the dot-API `method(a=b)` form)
            // were already parsed into `args` by the runner; the query slot is dropped here.
            val sep = url.indexOf("://")
            if (sep <= 0) {
                false
            } else {
                val scheme = url.substring(0, sep)
                val actionPath = url.substring(sep + 3).substringBefore('?')
                val params = Bridge.Params(dict = args, onTerminal = { outcome ->
                    when (outcome) {
                        is Bridge.Outcome.Resolve -> onTerminal(JSEModuleOutcome.Resolve(outcome.payload))
                        is Bridge.Outcome.Error -> onTerminal(JSEModuleOutcome.Error(outcome.code, outcome.data))
                    }
                })
                val handled = ModuleRegistry.shared.handle(scheme = scheme, actionPath = actionPath,
                                                           params = params, includeInternal = true)
                if (handled) {
                    true
                } else {
                    // Unhandled: a catalog scheme with NO implementation on this OS SETTLES the
                    // runner's terminal with the structured error — markup's awaited form sees
                    // { ok:false, error:"unsupported_platform", data:{scheme, platform,
                    // supportedPlatforms} } instead of the generic `unavailable` throw (the
                    // fire-and-forget form ignores results by construction, same as a settled
                    // error). Everything else keeps returning false → the runner's
                    // `unavailable` path (excluded-by-this-app / unknown scheme, today's
                    // behavior — and the whole branch is inert while platformSupport is empty,
                    // so the parity-pinned conformance corpus is untouched).
                    val supported = ModuleRegistry.shared.unsupportedPlatforms(scheme)
                    if (supported != null) {
                        onTerminal(JSEModuleOutcome.Error("unsupported_platform",
                            ModuleRegistry.shared.unsupportedPlatformData(scheme, supported)))
                        true
                    } else {
                        false
                    }
                }
            }
        }
    }
}
