@file:Suppress("UNCHECKED_CAST")

//
//  State.kt — the one app-level reactive store ("global.*"). Kotlin twin of
//  Engine/DSXState.swift — same names, same arguments, same behaviors.
//
//  When DSX is the root app runtime (not the WebView), state cannot live inside a
//  single StackSurface or inside the WebView: auth / entitlements / credits / theme
//  / route / feature flags are shared by the App.dsx router, native routes, DSXWebView
//  (the web route), packages, global components and (later) widget/watch targets.
//  This is that shared source of truth.
//
//  State layers — do NOT make everything global:
//    • global.*        → DSX.state (this file)        app-wide, cross-route, cross-target
//    • bare names      → the surface's StackStore      per screen / surface
//    • Compose state   → a native component            per view
//    • web framework   → inside a DSXWebView               per web route
//
//  Read in any Stack expression as `global.<path>`:
//      <text>{{ global.session.credits }}</text>
//      <route path="/premium" visible-if="global.session.premium"/>
//  Write declaratively (`set: global.session.premium = true`) or natively:
//      dsx.global.set("session.credits", 200)
//
//  ── REACTIVITY (Combine `@Published var vars` → coroutines StateFlow; the port's seam) ──
//  Swift's StackStore publishes `vars` via @Published; the Kotlin StackStore (Jse.kt) is the
//  evaluator-visible subset — plain fields, no publisher. The reactive face lives HERE, in a
//  per-store sidecar (`StackStorePublisher`, WeakHashMap-keyed so surface stores get the same
//  treatment when Stack.kt lands):
//    • `store.varsFlow`  — StateFlow<Map<String, Any?>> — the `$vars` twin. `.value` is the
//      current snapshot; collectors see every published write. StateFlow conflates deep-equal
//      snapshots, which only ever REINFORCES the write-elision below (never hides a change).
//    • `store.sink { vars -> }` — the `$vars.sink` twin: a synchronous callback seam that,
//      like a @Published sink, fires ONCE with the current snapshot on subscribe, then on
//      every published write. Returns an `AnyCancellable` (redeclared below, the Jse.kt
//      NSNull precedent) — cancel() explicitly; unlike Combine, dropping the handle does
//      NOT auto-cancel (the JVM has no deinit).
//    • Writes PUBLISH only through `set` / `setPath` / `writeBound` — Kotlin cannot observe
//      a direct `vars[k] = v` mutation the way @Published does. Every kernel write path
//      already funnels through these.
//
//  ── MAIN-THREAD FUNNEL (Swift: Thread.isMainThread guard + DispatchQueue.main.async) ──
//  `StackStorePublisher.mainExecutor` — an injectable Executor defaulting to INLINE (the
//  Events.kt pattern: inline = Swift's already-on-main path). The Android host installs a
//  Looper-backed executor at boot (inline when on main, post otherwise); tests and any other
//  JVM run with the direct default. Because the default is inline-on-any-thread, the sidecar
//  guards `vars` with a lock (Swift gets the same serialization from the main thread); the
//  whole `setPath` read-modify-write is atomic under it (Swift reads `vars[head]` on the
//  caller's thread — identical single-threaded, strictly safer concurrent).
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • DSXGlobal: Swift has BOTH `get(path) -> Any?` and `subscript -> DSXValue`; Kotlin cannot
//    declare `operator fun get(String): DSXValue` next to `fun get(String): Any?` (conflicting
//    overloads). `get` keeps the byte-identical raw-value contract (module code does
//    `dsx.global.get("x") as? Bool`); the dot-notation entry is `value(path): DSXValue`
//    (`dsx.global.value("session")["credits"].int ?: 0`). api-mapping.md's
//    `dsx.global["session"]` line is unimplementable verbatim — flagged for the doc.
//  • DSXApp is NOT here: Bundle/AppManifest/AppEnvironment are `:platform` per PLAN.md's
//    exclusion list; DSXBoot seeds `global.app.*` there, and `dsx.app.*` markup reads the
//    seeded store (JSE.normalizeScope maps `dsx.app` → `global.app` already).
//  • GeneratedConfigRaw / GeneratedStateRegistry are codegen'd static enums on iOS; here they
//    are settable registries the generated Android boot code fills. Default empty ⇒ every
//    read is exclusion-safe (`exists == false`), exactly the Swift absent-module behavior.
//  • Write elision uses Kotlin structural `==` for NSObject.isEqual — deep over the JSON-ish
//    types, but 200 (Int) vs 200.0 (Double) elides on iOS (NSNumber) and publishes here.
//  • JSE.stateVars stays UNWIRED by this file (the host binds `{ DSX.state.vars }` at boot);
//    wiring it from a type initializer would make test behavior order-dependent.
//  • getPath hands back LIVE references (Swift's value-type dictionaries hand back COW
//    copies) — treat results as read-only; writers rebuild containers, never mutate in place.
//  • Swift's `#if DEBUG print` (the static-var write footgun) is gated by `KernelLog.enabled`,
//    the port's DEBUG seam. The iOS-only JSETrace hook has no twin here yet (rides Stack.kt).
//

package despia.engine

import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/// The DSX namespace root (Swift: `public enum DSX {}` in Module.swift, extended per file).
/// Kotlin objects can't be extended with stored members later, so the namespace is declared
/// here with its first member; later ports add theirs to this object.
object DSX {
    /// The app-wide reactive store. A `StackStore` so it shares the engine's reactivity
    /// and the exact dictionary shape the `global.` expression namespace reads. The public
    /// surface is `dsx.global` / the `global.` namespace.
    val state = StackStore()
}

/// Combine's AnyCancellable, redeclared for the JVM (the NSNull precedent): a handle to a
/// `sink` / `on` subscription. `cancel()` to stop — explicitly; unlike Combine, dropping the
/// handle does NOT auto-cancel (no deinit on the JVM), so keep it and cancel when done.
class AnyCancellable internal constructor(private val onCancel: () -> Unit) {
    private val cancelled = AtomicBoolean(false)
    fun cancel() {
        if (cancelled.compareAndSet(false, true)) onCancel()
    }
}

/// The @Published sidecar (see REACTIVITY in the header): per-store flows + synchronous
/// sinks + the main-thread write funnel. WeakHashMap-keyed so a dismissed surface store's
/// reactivity is collected with it; `DSX.state` lives for the process.
object StackStorePublisher {
    /// The main-thread seam. Direct execution by default (= Swift's already-on-main path);
    /// the Android host swaps in a Looper-backed executor that mirrors Swift's "inline when
    /// already on main, hop otherwise". Never Android-typed — this module stays pure JVM.
    @Volatile
    var mainExecutor: Executor = Executor { it.run() }

    private val lock = Any()
    private val flows = WeakHashMap<StackStore, MutableStateFlow<Map<String, Any?>>>()
    private val sinks = WeakHashMap<StackStore, LinkedHashMap<UUID, SinkRegistration>>()
    private val publicationMailboxes = WeakHashMap<StackStore, StorePublicationMailbox>()

    private data class StorePublication(
        val snapshot: Map<String, Any?>,
        val flow: MutableStateFlow<Map<String, Any?>>?,
        val registrations: List<SinkRegistration>,
    )

    /** One drain per store serializes StateFlow and sink publication outside [lock]. */
    private class StorePublicationMailbox {
        val pending = ArrayDeque<StorePublication>()
        var draining = false
    }

    /**
     * Initial and update snapshots enter one per-registration FIFO. Enqueue is the
     * cancellation linearization point: after [deactivate] returns no future delivery is
     * admitted, and queued-but-not-running work is discarded. App code runs after the
     * lifecycle monitor is released, so callbacks may cancel or write re-entrantly.
     */
    private class SinkRegistration(
        private val handler: (Map<String, Any?>) -> Unit,
    ) {
        private val lifecycleLock = Any()
        private var active = true
        private var draining = false
        private val pending = ArrayDeque<Map<String, Any?>>()

        /** Returns true only to the caller that owns the FIFO drain. */
        fun enqueue(snapshot: Map<String, Any?>): Boolean = synchronized(lifecycleLock) {
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

    /** A published snapshot is a value, never a writable view of the backing store.
     * Keep this shallow to preserve the existing `Any?` value contract, but freeze the
     * top-level dictionary so a collector/sink cannot mutate StateFlow behind the
     * publisher's equality and ordering machinery. Call only while holding [lock]. */
    private fun frozenSnapshot(store: StackStore): Map<String, Any?> =
        java.util.Collections.unmodifiableMap(LinkedHashMap(store.vars))

    internal fun flow(store: StackStore): MutableStateFlow<Map<String, Any?>> =
        synchronized(lock) { flows.getOrPut(store) { MutableStateFlow(frozenSnapshot(store)) } }

    internal fun sink(store: StackStore, handler: (Map<String, Any?>) -> Unit): AnyCancellable {
        val token = UUID.randomUUID()
        val registration = SinkRegistration(handler)
        val current: Map<String, Any?>
        synchronized(lock) {
            sinks.getOrPut(store) { LinkedHashMap() }[token] = registration
            current = frozenSnapshot(store)
            check(registration.enqueue(current)) { "A new StackStore sink must own its initial drain" }
        }
        // A @Published sink receives the CURRENT value on subscribe; same here, through the seam.
        fun removeAndDeactivate() {
            val removed = synchronized(lock) {
                val storeSinks = sinks[store]
                val removedRegistration = if (storeSinks?.get(token) === registration) {
                    storeSinks.remove(token)
                } else null
                if (storeSinks?.isEmpty() == true) sinks.remove(store)
                removedRegistration
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

    /// The one write funnel: hop through the main-thread seam, mutate under the lock,
    /// publish the new snapshot. `mutate` returns false for an elided (no-op) write —
    /// nothing is published, exactly Swift's early return.
    internal fun write(store: StackStore, mutate: (MutableMap<String, Any?>) -> Boolean) {
        mainExecutor.execute {
            lateinit var mailbox: StorePublicationMailbox
            var ownsDrain = false
            synchronized(lock) {
                if (!mutate(store.vars)) return@execute
                val snapshot = frozenSnapshot(store)
                mailbox = publicationMailboxes.getOrPut(store) { StorePublicationMailbox() }
                mailbox.pending.addLast(
                    StorePublication(
                        snapshot = snapshot,
                        flow = flows[store],
                        registrations = sinks[store]?.values?.toList() ?: emptyList(),
                    )
                )
                if (!mailbox.draining) {
                    mailbox.draining = true
                    ownsDrain = true
                }
            }
            if (ownsDrain) drainPublications(mailbox)
        }
    }

    /** Drain every accepted snapshot in commit order. No publisher or lifecycle lock is
     * held while StateFlow or app callbacks execute. A bad callback is reported only
     * after the remaining registrations/publications have been given their turn. */
    private fun drainPublications(mailbox: StorePublicationMailbox) {
        var firstFailure: Throwable? = null
        while (true) {
            val publication = synchronized(lock) {
                if (mailbox.pending.isEmpty()) {
                    mailbox.draining = false
                    null
                } else mailbox.pending.removeFirst()
            }
            if (publication == null) {
                firstFailure?.let { throw it }
                return
            }
            try {
                publication.flow?.value = publication.snapshot
            } catch (error: Throwable) {
                if (firstFailure == null) firstFailure = error
            }
            publication.registrations.forEach { registration ->
                try {
                    if (registration.enqueue(publication.snapshot)) registration.drain()
                } catch (error: Throwable) {
                    if (firstFailure == null) firstFailure = error
                }
            }
        }
    }

    /// Read-side lock share, so `getPath` traversals never race a concurrent `write`.
    internal fun <T> reading(block: () -> T): T = synchronized(lock) { block() }
}

/// The `$vars` twin: this store's reactive snapshot stream. `.value` is the current
/// snapshot; a published write emits the next one. One stable instance per store.
val StackStore.varsFlow: StateFlow<Map<String, Any?>>
    get() = StackStorePublisher.flow(this)

/// The `$vars.sink` twin (see REACTIVITY in the header): fires now with the current
/// snapshot, then on every published write, through the main-thread seam.
fun StackStore.sink(handler: (Map<String, Any?>) -> Unit): AnyCancellable =
    StackStorePublisher.sink(this, handler)

/// Publish one top-level key (Stack.swift's `StackStore.set`, carried here because the
/// Kotlin StackStore's reactive face lives in this file — the full surface store rides the
/// Stack.kt port). No-op writes don't re-render: EVERY published mutation of `vars`
/// re-renders the whole surface, and hot paths re-write unchanged values constantly, so
/// deep-equal writes return early (Kotlin `==` is deep over the JSON-ish types, the
/// NSObject.isEqual twin).
fun StackStore.set(key: String, value: Any?) {
    StackStorePublisher.write(this) { vars ->
        val old = vars[key]
        if (vars.containsKey(key) && old == value) return@write false
        vars[key] = value
        true
    }
}

/// Native read/write API for the global store, reached as `dsx.global` — the SAME store DSX/JSE
/// read as `dsx.global.x.y` (≡ `global.x.y`); this is just its Kotlin face (XML can't call
/// Kotlin, so both spellings exist for the one store). Two ways to read:
///   • DOT NOTATION: `dsx.global.value("session")["credits"].int`, `dsx.global.value("strings.save").string`
///     — the typed chain, no casts (Swift spells the entry `dsx.global.session`; see the
///     header NOTES for why Kotlin needs the named `value` entry).
///   • DOT-PATH STRINGS: `dsx.global.get("session.credits")` / `set("session.credits", 200)` —
///     byte-identical across platforms, for writes and dynamic paths.
/// (A global key literally named `get`/`set`/`state` needs no escape hatch here — reach it
/// with `dsx.global.value("get")`, the string-subscript twin.)
class DSXGlobal {
    /// Read a dot-path (`get("session.credits")`), or null if absent.
    fun get(path: String): Any? = DSX.state.getPath(path)

    /// Write a dot-path (`set("session.credits", 200)`), creating intermediate
    /// dictionaries as needed. `null` writes an EXPLICIT absence rather than being
    /// dropped — a coordinator publishing "no value here" (e.g. `screen.frame` for a
    /// frameless report) must be able to say so. (Swift twin: nil → NSNull, the same
    /// JSON-null every reader already treats as absent.)
    fun set(path: String, value: Any?) {
        DSX.state.setPath(path, value)
    }

    /// Seed / replace a whole top-level key: `state("session", mapOf("userId" to "1"))`.
    fun state(key: String, value: Map<String, Any?>) {
        DSX.state.set(key, value)
    }

    /// Dot-notation READ entry: `dsx.global.value("session")` → a `DSXValue` you keep
    /// chaining (`["credits"].int`). The Kotlin twin of `dsx.global.session` in Swift and
    /// `dsx.global.session.credits` in markup. Accepts a dotted path, like both Swift
    /// subscripts (they call getPath too).
    fun value(path: String): DSXValue = DSXValue(DSX.state.getPath(path))
}

/// A node in the global store reached by dot notation — chain deeper with another `["key"]`,
/// or read the leaf typed. Getters are NULLABLE on purpose (absent is normal in a shared
/// bag), so the override idiom is a clean elvis: `dsx.global.value("strings.save").string ?: "Save"`.
/// The exact value DSX reads as `{{ dsx.global.strings.save }}`. Cross-platform: plain
/// dictionaries the iOS twin fills.
class DSXValue(val raw: Any?) {

    /// Descend: `value("a")["b"]["c"]`. A missing/non-dict node yields an empty `DSXValue` (no crash).
    operator fun get(key: String): DSXValue = DSXValue((raw as? Map<String, Any?>)?.get(key))

    /// Is anything present at this path?
    val exists: Boolean get() = raw != null

    /// Typed leaf reads — null when absent / wrong type, so `?: default` falls through cleanly.
    val string: String? get() = raw as? String
    val int: Int?
        get() = when (raw) {
            is Int -> raw
            is Long -> raw.toInt()
            is Double -> raw.toInt()
            else -> null
        }
    val double: Double?
        get() = when (raw) {
            is Double -> raw
            is Int -> raw.toDouble()
            is Long -> raw.toDouble()
            else -> null
        }
    val bool: Boolean? get() = raw as? Boolean
    val list: List<Any?>? get() = raw as? List<Any?>
    val dict: Map<String, Any?>? get() = raw as? Map<String, Any?>

    /// The raw value, untyped (escape hatch).
    val any: Any? get() = raw
}

/// `DSXLocale.pick` — resolve a localized config map `["default": …, "<locale>": …]` to the best
/// string for THIS device: walk the user's preferred languages, matching the exact tag (`de-DE`)
/// then its language (`de`), case-insensitively; else `default` (or "" if absent). Mirrors
/// AppManifest's locale ladder. The generated `config` accessor calls this for a localized value;
/// the iOS twin resolves the same map shape, so the contract is the data, not the platform.
object DSXLocale {
    /// Seam: iOS reads `Locale.preferredLanguages` (an ordered BCP-47 list); the JDK exposes
    /// one default locale, so the seam defaults to that single tag and the Android host (or a
    /// test) installs the real ordered list (`LocaleList` lives in `:platform`).
    var preferredLanguages: () -> List<String> = { listOf(java.util.Locale.getDefault().toLanguageTag()) }

    fun pick(map: Map<String, String>): String {
        val lower = LinkedHashMap<String, String>()
        for ((k, v) in map) lower.putIfAbsent(k.lowercase(), v)   // first wins, like Swift's uniquingKeysWith
        for (tag in preferredLanguages()) {
            val t = tag.lowercase()
            lower[t]?.let { return it }
            val lang = t.takeWhile { it != '-' && it != '_' }
            lower[lang]?.let { return it }
        }
        return map["default"] ?: ""
    }
}

/// One config value seen through `dsx.config["key"]` — the introspection wrapper over a package's
/// raw config entry. The entry is EITHER a scalar (a plain `"string"`, `true`, `42`, `[…]`) OR a
/// localized map `{ "default": …, "<locale>": … }`. `config.<key>` stays the typed, already-
/// resolved accessor for the common path; THIS is the "I also need the default / the locale list /
/// a specific locale / to know if it's localized" view — and it works for ANY key, localized or a
/// plain string, so `dsx.config["any_value"]` is always valid (an undefined key reads as
/// `.exists == false`).
///
/// Cross-platform by construction: the backing data (`GeneratedConfigRaw`) is plain dictionaries
/// the iOS twin fills identically, so the same `dsx.config` semantics port.
class DSXConfigValue(
    /// The raw entry exactly as codegen emitted it: a scalar, or a `[locale: String]` map
    /// (localized). `null` when the key is not defined for this package.
    val raw: Any?,
) {

    /// The localized map IFF this value is localized — a `Map<String, String>` carrying a
    /// `"default"` key. `null` for a scalar (a non-string / structured dict is NOT considered
    /// localized). The element-type check is explicit because Kotlin's generic casts are erased
    /// (Swift's `as? [String: String]` verifies at runtime).
    private val map: Map<String, String>?
        get() {
            val m = raw as? Map<*, *> ?: return null
            if (m["default"] == null) return null
            if (!m.keys.all { it is String } || !m.values.all { it is String }) return null
            return m as Map<String, String>
        }

    /// Is the key defined at all for this package? (`false` for an unknown `dsx.config["typo"]`.)
    val exists: Boolean get() = raw != null

    /// Does this value carry per-locale variants? `false` for a plain scalar.
    val isLocalized: Boolean get() = map != null

    /// The locale tags present, EXCLUDING `"default"` (e.g. `["de-DE", "fr"]`); `[]` for a scalar.
    val locales: List<String> get() = map?.keys?.filter { it != "default" }?.sorted() ?: emptyList()

    /// The full per-locale map INCLUDING `"default"`. For a plain string scalar this is
    /// `["default": value]` (so callers can treat every string value uniformly); for a non-string
    /// scalar it is empty. Handy to enumerate or forward a whole table at once.
    val byLocale: Map<String, String>
        get() {
            map?.let { return it }
            (raw as? String)?.let { return mapOf("default" to it) }
            return emptyMap()
        }

    /// The development-language / fallback value — the `"default"` key of a localized map, or the
    /// scalar itself. UNIFORM by design: `.default` is valid whether the value is localized or
    /// a plain string, and an empty string stays `""`. `null` only when the key is absent or a
    /// non-string scalar (a Bool/Int has no string default — read `.bool` / `.int` instead).
    val default: String? get() = map?.get("default") ?: raw as? String

    /// The value resolved for THIS device: the best locale match for a localized value
    /// (`DSXLocale.pick`), otherwise the scalar as a string. This equals what `config.<key>`
    /// returns for a localized String key — the same resolution, just reachable generically.
    val value: String get() = map?.let(DSXLocale::pick) ?: (raw as? String ?: "")

    /// The exact value for a SPECIFIC locale (BCP-47, e.g. `"de-DE"`): exact tag, then its bare
    /// language (`"de"`), then `"default"`. For a scalar, always the scalar. `null` if nothing matches.
    fun forLocale(tag: String): String? {
        val m = map ?: return raw as? String
        m[tag]?.let { return it }
        val lang = tag.takeWhile { it != '-' && it != '_' }
        return m[lang] ?: m["default"]
    }

    // Typed reads for NON-string scalars — localization only applies to strings, so these simply
    // surface the underlying scalar (`dsx.config["enabled"].bool`, `dsx.config["max"].int`, …).
    val string: String get() = value
    val bool: Boolean get() = raw as? Boolean ?: false
    val int: Int
        get() = when (raw) {
            is Int -> raw
            is Long -> raw.toInt()
            is Double -> raw.toInt()
            else -> 0
        }
    val double: Double
        get() = when (raw) {
            is Double -> raw
            is Int -> raw.toDouble()
            is Long -> raw.toDouble()
            else -> 0.0
        }
    val list: List<Any?> get() = raw as? List<Any?> ?: emptyList()

    /// A string list — config/state list values are emitted as `[String]`; falls back to filtering
    /// a heterogeneous list (both Swift branches collapse to the same filter here). `[]` when
    /// absent/wrong type. (`dsx.module["appsflyer"].context["domains"].strings`.)
    val strings: List<String> get() = (raw as? List<*>)?.filterIsInstance<String>() ?: emptyList()
}

/// The raw config data behind `dsx.config` — on iOS a codegen'd static enum
/// (prepare_config.rb); here a registry the generated Android boot code FILLS (see the
/// header NOTES). scheme → key → raw entry (scalar or locale map). Default empty ⇒
/// every read is exclusion-safe.
object GeneratedConfigRaw {
    var byScheme: Map<String, Map<String, Any?>> = emptyMap()
}

/// The declared-state registry behind `dsx.module.<scheme>.context.<var>` — on iOS a
/// codegen'd static enum; here a registry the generated Android boot code FILLS. scheme →
/// var → field descriptor (`{"source": "<configKey>"}` static | `{"default": …}` live).
object GeneratedStateRegistry {
    var byScheme: Map<String, Map<String, Map<String, Any?>>> = emptyMap()
}

/// `dsx.config` — read THIS package's config by key as `DSXConfigValue`s, with indexed
/// lookup so `dsx.config["foo"]` needs no generated-per-key boilerplate (an unknown key
/// yields an empty value, never a crash). Bound to the package's PRIMARY scheme, so it
/// always reads this package's own config no matter which action/alias is dispatching. The
/// data comes from the generated `GeneratedConfigRaw` — the SAME source `config` is
/// generated from, so the typed path and this introspection path can never drift.
class DSXConfigProxy(
    /// The owning package's primary scheme (the registry key).
    val scheme: String,
) {
    /// Both Swift subscripts (dynamic-member + string-keyed) collapse into this one operator.
    operator fun get(key: String): DSXConfigValue =
        DSXConfigValue(GeneratedConfigRaw.byScheme[scheme]?.get(key))
}

/// A package's STATE — the typed, declared variables it PUBLISHES for other packages (and can
/// update live). `dsx.module.<scheme>.context["var"]` reads another package's; `dsx.context["var"]`
/// is the owner's own. Declared in the owner's `dsx.json` `context` block (so it's discoverable +
/// typed), replacing stringly-typed `dsx.values("a.b")` cross-package coordination.
///
/// Reads like `dsx.config`, writes/subscribes like `dsx.global` — the same two dsx idioms, aligned:
///   • READ      — `dsx.module.x.context["flag"].bool`   (typed access, like `dsx.config`; nested `["a"]["b"]`)
///   • PUBLISH   — `dsx.context.set("flag", true)`         (string-keyed verb, like `dsx.global.set`; nested key "a.b")
///   • SUBSCRIBE — `dsx.module.x.context.on("flag") { v -> v.bool }`   (string-keyed verb, like `dsx.shared.on`)
///
/// Where it sits: `dsx.config` is a package's PRIVATE, static, read-only values; `dsx.global` is the
/// raw, un-namespaced, untyped reactive store. `state` is the middle — config's CROSS-PACKAGE,
/// can-be-live sibling. A var is STATIC (mirrors one of the owner's config values —
/// `GeneratedConfigRaw`) or LIVE (a runtime value the owner publishes via `set` — stored in the
/// reactive `DSX.state` at `"<scheme>.<var>"`, the declared default until set; nested vars live
/// nested there). Exclusion-safe: an absent/excluded owner has no `GeneratedStateRegistry` entry,
/// so every read is the declared default (`.exists == false`) — never a crash. Leaf reads delegate
/// to `DSXConfigValue`, so typing + locale resolution never drift from `dsx.config` — and, like
/// `dsx.config`, an absent value reads as the typed default (`false`/`""`), NOT a nullable (that's
/// `dsx.global`'s shape, for its "absent is normal" bag). A var named like a leaf member
/// (bool/string/…) is no hazard here — `["bool"]` (drill) and `.bool` (leaf) are distinct spellings.
class DSXStateProxy(
    /// The owning/target package's primary scheme (the registry key).
    val scheme: String,
    /// The accumulated dot-path being addressed ("" at the root `dsx.context` / `….context`).
    val path: String = "",
) {

    // Callback values are bound to the exact StackStore snapshot that triggered them.
    // Keep the public two-argument constructor intact; this private constructor is only
    // used by `on`, so ordinary proxies continue to resolve live state on every read.
    private var capturedSnapshot: Map<String, Any?> = emptyMap()
    private var isSnapshotBound = false

    private constructor(
        scheme: String,
        path: String,
        snapshot: Map<String, Any?>,
    ) : this(scheme, path) {
        capturedSnapshot = snapshot
        isSnapshotBound = true
    }

    /// Drill one level deeper (`["foo"]` ⇒ path "foo", then `["bar"]` ⇒ "foo.bar") — the Swift
    /// dynamic-member and string subscripts, collapsed into one operator.
    operator fun get(key: String): DSXStateProxy = descend(key)

    private fun descend(key: String): DSXStateProxy {
        val nextPath = if (path.isEmpty()) key else "$path.$key"
        return if (isSnapshotBound) {
            DSXStateProxy(scheme, nextPath, capturedSnapshot)
        } else {
            DSXStateProxy(scheme, nextPath)
        }
    }

    /// The raw value at (scheme, path). The TOP segment selects the var: STATIC ⇒ its config value
    /// (a leaf — config-backed vars don't nest); LIVE ⇒ the reactive store at the full path (nested-
    /// capable), falling back to the declared default at the leaf. Unknown/excluded var ⇒ null.
    val raw: Any?
        get() {
            if (path.isEmpty()) return null
            val top = path.takeWhile { it != '.' }
            val field = GeneratedStateRegistry.byScheme[scheme]?.get(top) ?: return null
            val source = field["source"] as? String
            if (source != null) {                                             // static: mirrors a config key
                return if (path == top) GeneratedConfigRaw.byScheme[scheme]?.get(source) else null
            }
            val live = if (isSnapshotBound) {
                valueAtPath(capturedSnapshot, "$scheme.$path")
            } else {
                DSX.state.getPath("$scheme.$path")
            }
            return live
                ?: (if (path == top) field["default"] else null)              // live (+ default)
        }

    /// Typed leaf reads — delegate to `DSXConfigValue` so typing + locale resolution match `dsx.config`.
    private val leaf: DSXConfigValue get() = DSXConfigValue(raw)
    val exists: Boolean get() = leaf.exists
    val bool: Boolean get() = leaf.bool
    val string: String get() = leaf.value   // device-locale resolved, like config.<key>
    val int: Int get() = leaf.int
    val double: Double get() = leaf.double
    val list: List<Any?> get() = leaf.list
    val strings: List<String> get() = leaf.strings

    /// PUBLISH a LIVE var (the `setState` of the model) — `dsx.context.set("flag", true)`, nested via
    /// a dot-path key `set("a.b", v)`. String-keyed to match `dsx.global.set` / `dsx.values.set` and
    /// the event verbs. Writes the reactive `DSX.state`, so consumers — and `dsx.global` / the web
    /// layer — see it. Owner-only; a static (config-sourced) var has no live slot, so a write there
    /// is inert.
    fun set(key: String, value: Any) {
        val p = if (path.isEmpty()) key else "$path.$key"
        if (KernelLog.enabled) {   // Swift: #if DEBUG — KernelLog.enabled is the port's DEBUG seam
            // Catch the footgun: writing a STATIC var (config-mirror) is inert — reads come from
            // config, not the live store. Either declare it live (drop the config source) or stop
            // writing it.
            val top = p.takeWhile { it != '.' }
            val src = GeneratedStateRegistry.byScheme[scheme]?.get(top)?.get("source") as? String
            if (src != null) {
                println("[dsx.context] ⚠️ set(\"$p\") on '$scheme': '$top' is STATIC (mirrors config '$src') — this write is inert; reads resolve from config. Make it a live var to publish at runtime.")
            }
        }
        DSX.state.setPath("$scheme.$p", value)
    }

    /// SUBSCRIBE to a var — `dsx.module.x.context.on("flag") { v -> v.bool }`. String-keyed to match
    /// the event verbs (`dsx.delegate.listen`). Fires NOW with the current value (like `useEffect`'s first
    /// run), then on every change. Returns an `AnyCancellable` — keep it to stay subscribed,
    /// `cancel()` to stop (no deinit auto-cancel on the JVM; see the header). A static var fires
    /// once (never changes); a live var re-fires when the owner publishes a new value.
    fun on(key: String, handler: (DSXStateProxy) -> Unit): AnyCancellable {
        val target = descend(key)
        val s = target.scheme
        val p = target.path
        var initialized = false
        var last: Any? = null
        return DSX.state.sink { snapshot ->
            val now = DSXStateProxy(s, p, snapshot)
            val nowRaw = now.raw
            if (initialized && sameRaw(last, nowRaw)) return@sink
            // Advance the dedupe cursor before app code runs: a handler may publish a
            // re-entrant update, which joins this registration's FIFO behind the current
            // delivery and must not be absorbed as the baseline after the callback.
            last = nowRaw
            initialized = true
            handler(now)
        }
    }

    private companion object {
        fun valueAtPath(root: Map<String, Any?>, path: String): Any? {
            val parts = DsxStatePathPolicy.segments(path, allowEmpty = true) ?: return null
            var current: Any? = root
            for (segment in parts) {
                val index = DsxStatePathPolicy.arrayIndex(segment)
                current = if (index != null && current is List<*>) {
                    if (index in current.indices) current[index] else null
                } else {
                    (current as? Map<String, Any?>)?.get(segment)
                }
            }
            return current
        }

        /// Dedupe successive resolves so `on` only fires on a real change (Kotlin structural `==`
        /// is the NSObject.isEqual bridge — deep over scalars/strings/lists/maps).
        fun sameRaw(a: Any?, b: Any?): Boolean = when {
            a == null && b == null -> true
            a != null && b != null -> a == b
            else -> false
        }
    }
}

/// Resolves `{{ dsx.* }}` references embedded in a config STRING value at READ time, against the
/// live store — the SAME `dsx.` root markup uses. So `webview_url: "https://{{ dsx.app.host }}/app"`
/// yields the per-locale host on this device, exactly as `{{ dsx.app.host }}` would in a `.dsx`.
/// Runtime-only by design: `dsx.app.host` is per-locale, so it can't bake at build time the way the
/// pipeline's `{{ env.* }}` plist substitution does (that's a separate plane, untouched here). The
/// generated config accessor calls this when a string carries `{{ dsx.… }}`; see prepare_config.rb.
///
/// A config read is ONE stage of a token's pipeline, and it consumes ONLY the tokens addressed to
/// it: the app-store scopes (`dsx.app.*` / `dsx.global.*` / `dsx.screen.*` — whatever normalizes to
/// `global.*`). Every other `{{ … }}` span is PRESERVED verbatim, because it belongs to a LATER
/// stage — a Live-Activity / widget layout sourced into config carries `{{ dsx.variable.* }}`
/// bindings that only the EXTENSION's renderer can resolve (StackScope, against the snapshot
/// vars). Eating those here shipped layouts whose every binding was already blanked.
object DSXConfigTemplate {
    private val token = Regex("""\{\{\s*([^}]+?)\s*\}\}""")

    /// Substitute every STORE-scoped `{{ dsx.<scope>.<path> }}` span (absent path → empty, the
    /// markup semantics); any other span — `{{ dsx.variable.x }}`, `{{ env.X }}` — passes through
    /// untouched for its own stage. A string with no "{{" is returned as-is (the cheap common case).
    fun resolve(s: String): String {
        if (!s.contains("{{")) return s
        val out = StringBuilder()
        var cursor = 0
        for (m in token.findAll(s)) {
            out.append(s, cursor, m.range.first)
            out.append(lookup(m.groupValues[1]) ?: m.value)
            cursor = m.range.last + 1
        }
        out.append(s, cursor, s.length)
        return out.toString()
    }

    /// The store value for an addressed token, or null for a token this stage must not consume.
    private fun lookup(tok: String): String? {
        // Reuse the engine's own scope mapping so a config token resolves identically to the same
        // read in markup: dsx.app.host -> global.app.host -> DSX.state. Non-store scopes are NOT
        // ours (dsx.variable.* is the surface/extension namespace) -> preserve the span.
        if (!tok.startsWith("dsx.")) return null
        val norm = JSE.normalizeScope(tok)
        if (!norm.startsWith("global.")) return null
        val v = DSX.state.getPath(norm.removePrefix("global."))
        return (v as? String) ?: (v?.toString() ?: "")
    }
}

// MARK: - StackStore dot-paths (Swift: `extension StackStore`)

/** One bounded dot-path contract shared by app state and `<api>` envelope writes.
 * Authored/remote paths are rejected before copy-on-write allocates containers. */
internal object DsxStatePathPolicy {
    const val maxPathBytes = 4_096
    const val maxSegments = 64
    const val maxSegmentBytes = 256
    const val maxArrayIndex = 9_999
    const val maxArrayGrowth = 1_024
    const val maxContainerEntries = 10_000
    const val maxIdentifierBytes = 128

    private val unsafeKeys = setOf("__proto__", "constructor", "prototype")

    data class WriteResult(val accepted: Boolean, val value: Any?)

    private fun isWithinUtf8Limit(value: String, limit: Int): Boolean {
        // Every UTF-16 code unit consumes at least one UTF-8 byte. Bound length first
        // so checking an attacker-sized String never allocates another attacker-sized buffer.
        return value.length <= limit && value.toByteArray(Charsets.UTF_8).size <= limit
    }

    private fun isAsciiDigits(value: String): Boolean =
        value.isNotEmpty() && value.all { it in '0'..'9' }

    fun arrayIndex(value: String): Int? {
        if (!isAsciiDigits(value)) return null
        return value.toIntOrNull()?.takeIf { it <= maxArrayIndex }
    }

    fun segments(path: String, allowEmpty: Boolean = false): List<String>? {
        if (path.isEmpty()) return if (allowEmpty) emptyList() else null
        if (!isWithinUtf8Limit(path, maxPathBytes)) return null
        if (path.first() == '.' || path.last() == '.' || ".." in path) return null
        val parts = path.split('.')
        if (parts.size > maxSegments) return null
        for (part in parts) {
            if (!isWithinUtf8Limit(part, maxSegmentBytes) || part in unsafeKeys) return null
            val digits = isAsciiDigits(part)
            val signedDigits = part.length > 1 && (part[0] == '-' || part[0] == '+') &&
                part.substring(1).all { it in '0'..'9' }
            if (signedDigits) return null
            if (digits && arrayIndex(part) == null) return null
        }
        return parts
    }

    fun isIdentifier(value: String): Boolean {
        if (value.isEmpty() || !isWithinUtf8Limit(value, maxIdentifierBytes)) return false
        fun first(c: Char): Boolean = c == '_' || c in 'A'..'Z' || c in 'a'..'z'
        fun rest(c: Char): Boolean = first(c) || c in '0'..'9'
        return first(value[0]) && value.drop(1).all(::rest)
    }

    fun rebuild(container: Any?, parts: List<String>, value: Any?): WriteResult {
        val head = parts.firstOrNull() ?: return WriteResult(true, value)
        val rest = parts.drop(1)
        val index = arrayIndex(head)
        if (index != null) {
            val array = ArrayList<Any?>((container as? List<Any?>) ?: emptyList())
            val growth = if (index >= array.size) index - array.size + 1 else 0
            if (growth > maxArrayGrowth) return WriteResult(false, container)
            while (array.size <= index) array.add(LinkedHashMap<String, Any?>())
            val child = rebuild(array[index], rest, value)
            if (!child.accepted) return child
            array[index] = child.value
            return WriteResult(true, array)
        }

        val dictionary = LinkedHashMap<String, Any?>((container as? Map<String, Any?>) ?: emptyMap())
        if (!dictionary.containsKey(head) && dictionary.size >= maxContainerEntries) {
            return WriteResult(false, container)
        }
        val child = rebuild(dictionary[head], rest, value)
        if (!child.accepted) return child
        dictionary[head] = child.value
        return WriteResult(true, dictionary)
    }
}

/// Read a dot-path against the surface store — walks nested dictionaries AND arrays (a
/// numeric segment indexes an array, bounds-checked), mirroring the expression resolver.
/// A `<variable>` default lives in `initials` until the first live write; direct native
/// controls must observe that default just like JSE does. A live top-level value wins,
/// including an explicit present-null marker.
fun StackStore.getPath(path: String): Any? = StackStorePublisher.reading {
    val parts = DsxStatePathPolicy.segments(path, allowEmpty = true) ?: return@reading null
    if (parts.isEmpty()) return@reading vars
    val head = parts.first()
    var cur: Any? = if (vars.containsKey(head)) vars[head] else initials[head]
    for (seg in parts.drop(1)) {
        val i = DsxStatePathPolicy.arrayIndex(seg)
        cur = if (i != null && cur is List<*>) {
            if (i >= 0 && i < cur.size) cur[i] else null
        } else {
            (cur as? Map<String, Any?>)?.get(seg)
        }
    }
    cur
}

/// Write a dot-path into `vars`, creating intermediate dictionaries/arrays. Numeric
/// segments index arrays (`feed.data.5.name`), growing with empty dicts as needed —
/// the write counterpart to getPath, so state is editable wherever it's readable.
/// Re-publishes the affected TOP-LEVEL key (coarse but glitch-free for UI).
fun StackStore.setPath(path: String, value: Any?) {
    val parts = DsxStatePathPolicy.segments(path) ?: return
    val head = parts.firstOrNull() ?: return
    StackStorePublisher.write(this) { vars ->                          // re-publishes vars[head]
        if (!vars.containsKey(head) && vars.size >= DsxStatePathPolicy.maxContainerEntries) {
            return@write false
        }
        val result = if (parts.size == 1) {
            DsxStatePathPolicy.WriteResult(true, value)
        } else {
            // Promote the declared object/list default on the first nested edit. Rebuilding
            // from null would drop every untouched sibling (for example form.focus and
            // form.values when fieldOrder registers), making dynamic default objects unusable.
            val base = if (vars.containsKey(head)) vars[head] else initials[head]
            DsxStatePathPolicy.rebuild(base, parts.drop(1), value)
        }
        if (!result.accepted) return@write false
        val rebuilt = result.value
        val old = vars[head]
        if (vars.containsKey(head) && old == rebuilt) return@write false // the set() elision, same law
        vars[head] = rebuilt
        true
    }
}

/// Write a BOUND value to the right scope, PATH-AWARE: `global.*` / `route.*` → the app
/// store (DSXState), else this (surface) store — nested + array-index, so `bind="user.email"`
/// edits the `email` key of the `user` object var in place (`bind="x"` stays a flat var).
/// `$`-namespaces normalize first. Mirrors `set:` / expression writes, so bindings, verbs and
/// `{{ }}` reads all agree on where a path lives.
fun StackStore.writeBound(rawKey: String, value: Any) {
    val key = JSE.normalizeScope(rawKey)
    when {
        key.startsWith("global.") -> DSX.state.setPath(key.substring(7), value)
        key.startsWith("route.") -> DSX.state.setPath(key, value)
        else -> setPath(key, value)
    }
}
