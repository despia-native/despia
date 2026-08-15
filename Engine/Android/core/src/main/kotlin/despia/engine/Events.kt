//
//  Events.kt — the native event bus (Kotlin twin of DSXEvents.swift; the in-process
//  mirror of window.despia.on).
//
//  A package's `dsx.broadcast(name, data)` fans out to EVERY consumer surface, not
//  just the web:
//    • web                : window.despia.on("<scheme>", handler)        (via dsx.module.dom.proxy)
//    • native, in-process : dsx.events.on("<scheme>") { event, data -> } (THIS bus)
//    • targets, separate  : dsx.container.observe { }                    (the container signal)
//      process
//
//  A package broadcasts once; web subscribers AND in-process native subscribers both
//  receive it, and neither knows about the other or enumerates events — they subscribe
//  by SCHEME (or "*" for the firehose), exactly like the web. This is what makes native
//  routes / components first-class event consumers once the WebView is no longer the
//  core.
//
//  `dsx.events` is exposed identically on a package context (Context) AND a component
//  context (StackComponentContext), so a native SCREEN can subscribe the same way a
//  package can — `dsx.events` sits next to `dsx.global` / `dsx.shared` (façade class +
//  internal singleton), and is deliberately distinct from a component's LOCAL
//  `dsx.on`/`dsx.event` (parent↔child within one surface).
//
//  In-process only (live lambdas). Cross-PROCESS delivery (widget / auxiliary target)
//  is the container's signal (dsx.container.observe), not this bus.
//
//  Main-thread hop: the Swift bus delivers on the main thread (inline when already
//  there). This pure-JVM twin must not name the Android Looper, so the hop sits behind
//  a swappable seam — `DSXEvents.mainExecutor` — defaulting to DIRECT
//  execution (deliver inline on the publishing thread, which is exactly Swift's
//  already-on-main behavior). The public host seam is installed with an asynchronous
//  UI executor by Android and Compose desktop, so worker-originated publications are
//  main-safe too. Pure-JVM callers retain the direct default.
//
//  Same shape as Swift by contract — `publish(scheme, event, data)`,
//  `on(scheme) { event, data -> }`, `cancel()`; untyped `data` (cast).
//

package despia.engine

import java.util.UUID
import java.util.concurrent.Executor

/// The in-process broadcast registry (the actual store). Internal — packages and
/// components reach it through the `dsx.events` façade, never directly.
internal class DSXEventBus private constructor() {
    companion object {
        val shared = DSXEventBus()
    }

    private val lock = Any()
    /// scheme -> token -> registration. "*" is the firehose (every scheme), like
    /// `window.despia.on("*")`.
    private val subscribers = HashMap<String, LinkedHashMap<UUID, SubscriberRegistration>>()

    /**
     * Executor tasks retain registrations instead of bare handlers. Cancellation
     * synchronizes with callback admission, so after cancel() returns a publish that
     * is still queued cannot be newly admitted to this stale handler. A callback
     * admitted before that boundary is already in flight.
     *
     * The handler itself never runs under a lifecycle or registry monitor. That lets
     * callbacks re-enter the bus and lets two callbacks cancel each other safely even
     * if a non-serial executor runs them concurrently.
     */
    private class SubscriberRegistration(
        private val handler: (String, Any?) -> Unit,
    ) {
        private val lifecycleLock = Any()
        private var active = true

        fun deliverIfActive(event: String, data: Any?) {
            synchronized(lifecycleLock) {
                if (!active) return
            }
            handler(event, data)
        }

        fun deactivate() {
            synchronized(lifecycleLock) { active = false }
        }
    }

    /// Deliver a broadcast to every native subscriber of `scheme` (plus "*"), through
    /// the main-thread seam. Called by `dsx.broadcast` alongside the web delivery.
    fun publish(scheme: String, event: String, data: Any?) {
        val registrations: List<SubscriberRegistration> = synchronized(lock) {
            (subscribers[scheme]?.values?.toList() ?: emptyList()) +
                (subscribers["*"]?.values?.toList() ?: emptyList())
        }
        if (registrations.isEmpty()) return
        DSXEvents.mainExecutor.execute {
            registrations.forEach { it.deliverIfActive(event, data) }
        }
    }

    /// Subscribe to `scheme`'s broadcasts (or "*"). Returns a handle; `cancel()` to stop.
    fun subscribe(scheme: String, handler: (String, Any?) -> Unit): DSXEventSubscription {
        val token = UUID.randomUUID()
        val registration = SubscriberRegistration(handler)
        synchronized(lock) {
            subscribers.getOrPut(scheme) { LinkedHashMap() }[token] = registration
        }
        return DSXEventSubscription(scheme, token)
    }

    fun unsubscribe(scheme: String, token: UUID) {
        val registration = synchronized(lock) {
            val schemeSubscribers = subscribers[scheme]
            val removed = schemeSubscribers?.remove(token)
            if (schemeSubscribers?.isEmpty() == true) subscribers.remove(scheme)
            removed
        }
        registration?.deactivate()
    }
}

/// `dsx.events` — subscribe to out-of-band broadcasts (the native mirror of
/// `window.despia.on`). A façade over `DSXEventBus`, exposed identically on every dsx
/// so packages AND native screens subscribe the same way. Untyped payload by contract,
/// so the same shape works on Swift/Kotlin/Java.
class DSXEvents {

    companion object {
        /** Host-owned asynchronous main-thread executor for native event observers.
         * Android and Desktop install their UI dispatchers at boot; pure JVM callers
         * retain direct execution. Volatile because boot/test ownership can change
         * while background publishers are alive. */
        @Volatile
        var mainExecutor: Executor = Executor { it.run() }
    }

    /// Subscribe to a scheme's broadcasts (or "*" for the firehose). The handler gets
    /// `(event, data)` through the main-thread seam. Subscribe ONCE (in `setup` / a
    /// screen's lifecycle), KEEP the returned handle, and `cancel()` to stop — dropping
    /// the handle does NOT auto-unsubscribe. In-process only; a separate-process target
    /// (widget / auxiliary) uses `dsx.container.observe` instead.
    fun on(scheme: String, handler: (String, Any?) -> Unit): DSXEventSubscription =
        DSXEventBus.shared.subscribe(scheme, handler)

    /// INTERNAL delivery seam — the publish mirror of `on`. The kernel's `dsx.broadcast` fan-out
    /// and the JSE→native bridge deliver here, so the `DSXEventBus` store is referenced ONLY through
    /// this façade (nothing else names the singleton). Modules and screens publish via
    /// `dsx.broadcast(name, payload)`, never this directly — it stays `internal` for exactly that.
    internal fun publish(scheme: String, event: String, data: Any?) {
        DSXEventBus.shared.publish(scheme, event, data)
    }
}

/**
 * Kernel-owned explicit-scheme broadcast for native surface components which do not
 * belong to a package [Context]. It is the same fan-out as `Context.broadcast(on:…)`:
 * mounted surfaces first, then in-process native subscribers, with module aliases.
 * DSXView uses this for its stable `dsx-view` lifecycle scheme.
 */
object DSXRuntimeSignals {
    fun broadcast(scheme: String, event: String, value: Any? = null) {
        val safeScheme = scheme.trim().takeIf {
            it.matches(Regex("[A-Za-z][A-Za-z0-9_.-]{0,127}"))
        } ?: return
        val safeEvent = event.trim().takeIf {
            it.matches(Regex("[A-Za-z][A-Za-z0-9_.-]{0,127}"))
        } ?: return
        val payload = if (value == null) null else JSON.from(value).foundationValue

        fun deliver(spelling: String) {
            val envelope: Map<String, Any?> = mapOf(
                "id" to null,
                "scheme" to spelling,
                "host" to "",
                "event" to safeEvent,
                "final" to true,
                "data" to payload,
            )
            DSXMessenger().deliverBroadcast(
                DSXEgress(target = "*", scheme = spelling, rid = null, payload = envelope),
            )
            DSXEvents().publish(spelling, safeEvent, payload)
        }

        // This API is public and native components may call it from a worker. Use the
        // registry's synchronous main-thread funnel once around the whole fan-out so
        // surface-before-native and primary-before-alias ordering stay atomic. Android
        // and desktop executors run inline when already on main; their installed
        // messenger/event executors therefore do not add another queue boundary.
        ModuleRegistry.shared.mainExecutor.execute {
            deliver(safeScheme)
            ModuleRegistry.shared.aliasesForChain(safeScheme).forEach(::deliver)
        }
    }
}

/// A handle to a `dsx.events.on(scheme) { }` subscription; `cancel()` to stop. Keep it
/// for the subscription's lifetime (a screen's controller, a package); dropping the
/// handle does NOT auto-unsubscribe (the lambda may still be live), so cancel explicitly.
class DSXEventSubscription internal constructor(
    private val scheme: String,
    private val token: UUID,
) {
    fun cancel() {
        DSXEventBus.shared.unsubscribe(scheme, token)
    }
}
