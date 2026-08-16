//
//  Shared.kt — the shared in-process context registry ("dsx.shared").
//  Kotlin twin of Engine/DSXShared.swift — same names, same arguments, same behaviors.
//
//  One node PUBLISHES a live handle under a key; any node CONSUMES it. The native
//  equivalent of a web Context Provider — and a GENERAL primitive, not a special
//  case: DSXWebView is merely the first user (it provides "web" = its WebView). Any
//  package may provide/consume the same way, so the engine never special-cases a
//  particular handle.
//
//  This is for LIVE, in-process OBJECT handles (a webview, a player, a DB client).
//  It is deliberately distinct from the other sharing primitives:
//    • dsx.values (DSXValues)  — strong-ref in-process VALUE state (Bool/String/Map): native
//                                package coordination while handling hooks/actions (NOT web-synced)
//    • global.*  (DSXState)    — reactive, serializable DATA (syncs to web)
//    • dsx.container           — PERSISTENT storage (cross-process)
//    • dsx.module              — cross-package ACTIONS (RPC)
//
//  Cross-runtime contract (mirrors 1:1 with Swift): UNTYPED by design — `use`
//  returns an opaque handle the consumer casts, because Java has no reified
//  generics. Verbs: provide / use / on. String keys (the keys, e.g. "web", are part
//  of the cross-runtime contract). Main-thread delivery. Handles are held WEAKLY
//  (java.lang.ref.WeakReference — the mapping the Swift file names), so an
//  unmounted provider's handle auto-prunes.
//

package despia.engine

import java.lang.ref.WeakReference
import java.util.UUID
import java.util.TreeMap
import java.util.concurrent.Executor

internal class DSXSharedRegistry private constructor() {
    internal companion object { internal val shared = DSXSharedRegistry() }

    // Swift's `WeakBox { weak var value }`. A null handle is a box with no referent,
    // so provide(key, null) stores (and reads back as) absent — exactly like Swift.
    private class WeakBox(v: Any?, val revision: Long) {
        private val ref: WeakReference<Any>? = v?.let { WeakReference(it) }
        val value: Any? get() = ref?.get()
    }

    private val lock = Any()
    private val handles = HashMap<String, WeakBox>()
    private val observers = HashMap<String, LinkedHashMap<UUID, ObserverRegistration>>()

    /** Per-observer ordered mailbox. Publication revisions are assigned under [lock],
     * but concurrent publishers can reach this object out of order after releasing it.
     * The mailbox waits for gaps and uses one drain at a time, while invoking app code
     * outside its monitor. A delayed initial snapshot is skipped when a newer publication
     * is already pending. */
    private class ObserverRegistration(
        private val handler: (Any?) -> Unit,
        firstRevision: Long,
        private val onInitialFailure: (ObserverRegistration) -> Unit,
    ) {
        private data class Delivery(val handle: Any?, val initial: Boolean)

        private val lifecycleLock = Any()
        private var active = true
        private var nextRevision = firstRevision
        private var draining = false
        private var hasDeliveredSuccessfully = false
        private val pending = TreeMap<Long, Delivery>()

        fun enqueue(handle: Any?, revision: Long, initial: Boolean) {
            val schedule = synchronized(lifecycleLock) {
                if (!active || revision < nextRevision) return
                pending.putIfAbsent(revision, Delivery(handle, initial))
                if (draining) false else {
                    draining = true
                    true
                }
            }
            if (!schedule) return
            try {
                DSXShared.mainExecutor.execute { drain() }
            } catch (failure: Throwable) {
                synchronized(lifecycleLock) { draining = false }
                throw failure
            }
        }

        private fun drain() {
            while (true) {
                val delivery = synchronized(lifecycleLock) {
                    if (!active) {
                        pending.clear()
                        draining = false
                        return
                    }
                    val next = pending[nextRevision]
                    if (next == null) {
                        draining = false
                        return
                    }
                    // The initial value is a snapshot, not a publication. If a newer
                    // publication won the queue race, start at that publication instead.
                    if (next.initial && pending.higherKey(nextRevision) != null) {
                        pending.remove(nextRevision)
                        nextRevision += 1L
                        null
                    } else {
                        pending.remove(nextRevision)
                        nextRevision += 1L
                        next
                    }
                }
                if (delivery == null) continue
                val firstActualDelivery = synchronized(lifecycleLock) {
                    !hasDeliveredSuccessfully
                }
                try {
                    handler(delivery.handle)
                    synchronized(lifecycleLock) { hasDeliveredSuccessfully = true }
                } catch (failure: Throwable) {
                    // `on()` may already have returned when the host executor is
                    // asynchronous. Roll back failure of the first actual callback
                    // (including a newer publication when a stale initial snapshot was
                    // skipped) before rethrowing, so executor uncaught/error handling
                    // still sees it and later publications cannot re-invoke it.
                    if (firstActualDelivery) onInitialFailure(this)
                    synchronized(lifecycleLock) { draining = false }
                    throw failure
                }
            }
        }

        fun deactivate() {
            synchronized(lifecycleLock) {
                active = false
                pending.clear()
            }
        }
    }

    fun provide(key: String, handle: Any?) {
        val obs: List<ObserverRegistration>
        val revision: Long
        synchronized(lock) {
            revision = (handles[key]?.revision ?: 0L) + 1L
            handles[key] = WeakBox(handle, revision)
            obs = observers[key]?.values?.toList() ?: emptyList()
        }
        notify(obs, handle, revision, initial = false)
    }

    fun use(key: String): Any? = synchronized(lock) { handles[key]?.value }

    fun on(key: String, handler: (Any?) -> Unit): UUID {
        val token = UUID.randomUUID()
        val current: Any?
        val revision: Long
        lateinit var registration: ObserverRegistration
        synchronized(lock) {
            val box = handles[key]
            current = box?.value
            revision = box?.revision ?: 0L
            registration = ObserverRegistration(
                handler = handler,
                firstRevision = if (current == null) revision + 1L else revision,
                onInitialFailure = { failed -> remove(key, token, failed) },
            )
            observers.getOrPut(key) { LinkedHashMap() }[token] = registration
        }
        try {
            if (current != null) {
                notify(listOf(registration), current, revision, initial = true)
            }
        } catch (failure: Throwable) {
            remove(key, token, registration)
            throw failure
        }
        return token
    }

    fun cancel(key: String, token: UUID) {
        remove(key, token, expected = null)
    }

    private fun remove(
        key: String,
        token: UUID,
        expected: ObserverRegistration?,
    ): ObserverRegistration? = synchronized(lock) {
        val keyObservers = observers[key]
        val current = keyObservers?.get(token)
        if (current == null || (expected != null && current !== expected)) return@synchronized null
        keyObservers.remove(token)
        if (keyObservers.isEmpty()) observers.remove(key)
        current
    }.also { it?.deactivate() }

    private fun notify(
        registrations: List<ObserverRegistration>,
        handle: Any?,
        revision: Long,
        initial: Boolean,
    ) {
        if (registrations.isEmpty()) return
        var firstFailure: Throwable? = null
        registrations.forEach { registration ->
            try {
                registration.enqueue(handle, revision, initial)
            } catch (failure: Throwable) {
                if (firstFailure == null) firstFailure = failure
            }
        }
        firstFailure?.let { throw it }
    }
}

/**
 * `dsx.shared` — publish / consume / observe a shared live handle. Untyped by
 * contract (cast the result of `use`), so the same shape works on Swift/Kotlin/Java.
 */
class DSXShared {

    companion object {
        /** Host-owned asynchronous main-thread executor for shared-handle observers. */
        @Volatile
        var mainExecutor: Executor = Executor { it.run() }
    }

    /**
     * Publish a live handle under `key` (held weakly). Re-provide to replace it
     * (notifies observers); pass `null` to clear. DSXWebView: `dsx.shared.provide("web", webView)`.
     */
    fun provide(key: String, handle: Any?) { DSXSharedRegistry.shared.provide(key, handle) }

    /**
     * Consume the current handle for `key`, or null. Cast it:
     * `dsx.shared.use("web") as? WebView`.
     */
    fun use(key: String): Any? = DSXSharedRegistry.shared.use(key)

    /**
     * Observe (re)publishes of `key`; fires immediately with the current handle if a
     * provider is already up. Returns a token; `cancel(key, token)` to stop.
     * (Swift marks this `@discardableResult`; Kotlin results are discardable by default.)
     */
    fun on(key: String, handler: (Any?) -> Unit): UUID = DSXSharedRegistry.shared.on(key, handler)

    fun cancel(key: String, token: UUID) { DSXSharedRegistry.shared.cancel(key, token) }
}

// MARK: - dsx.values (strong-ref VALUE state)

/**
 * `dsx.values` backing store — strong-ref keyed VALUE state, the sibling of `DSXSharedRegistry`
 * (weak OBJECT handles). A value like `auth.inProgress` has no owning object to keep it alive, so
 * it can't go through the weak handle store; this holds it strongly until removed. Lock-guarded
 * like the handle store. Cross-runtime: a plain string→value map (mirrors 1:1 with Swift).
 */
internal class DSXValuesRegistry private constructor() {
    internal companion object { internal val shared = DSXValuesRegistry() }

    private val lock = Any()
    private val values = HashMap<String, Any>()

    fun set(key: String, value: Any?) {
        synchronized(lock) {
            if (value != null) values[key] = value else values.remove(key)
        }
    }

    fun get(key: String): Any? = synchronized(lock) { values[key] }
}

/**
 * `dsx.values` — publish / read shared VALUE data (strong-ref): native package-coordination state
 * shared while handling hooks/actions (a Bool/String/Map), e.g. `auth.inProgress`. Contrast
 * `dsx.shared` (weak OBJECT handles). NOT DSX `dsx.variable` / route / reactive UI state. Untyped
 * `get` plus typed `bool`/`string` (the JSON/args typing convention).
 */
class DSXValues {

    /** Publish a value under `key` (held strongly). Pass null to remove. */
    fun set(key: String, value: Any?) { DSXValuesRegistry.shared.set(key, value) }

    /** Read the raw value for `key`, or null — cast it, or use a typed accessor below. */
    fun get(key: String): Any? = DSXValuesRegistry.shared.get(key)

    /** Typed read: Bool (number-tolerant, Swift's NSNumber tolerance), default false when unset. */
    fun bool(key: String): Boolean = when (val v = DSXValuesRegistry.shared.get(key)) {
        is Boolean -> v
        is Number -> v.toDouble() != 0.0
        else -> false
    }

    /** Typed read: String, or null. */
    fun string(key: String): String? = DSXValuesRegistry.shared.get(key) as? String

    /** Remove the value for `key`. */
    fun remove(key: String) { DSXValuesRegistry.shared.set(key, null) }
}
