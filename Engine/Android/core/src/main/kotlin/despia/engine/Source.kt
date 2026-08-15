//
//  Source.kt — the JVM kernel provenance primitive (`dsx.source`).
//
//  This is the Kotlin twin of Engine/iOS/Source.swift.  Owners publish one
//  independently keyed plane into the app-wide reactive store:
//
//    source.<plane> = { state: never|stale|live,
//                       serving: origin|cache|bundle,
//                       at: <ISO-8601 instant> }
//
//  Persistence is deliberately injected.  The pure kernel has no Android Context
//  and no desktop filesystem policy; each process host installs its durable stamp
//  store.  The in-memory default remains total for pure JVM/tests and honestly loses
//  "ever loaded" state at process exit rather than inventing persistence.
//
//  The KERNEL FACTS — `source.boot` (first|warm) and `source.online` — ride `seed`/
//  `setOnline` below.  Source.swift seeds both from `DSXBoot` and keeps `online` live
//  off an `NWPathMonitor` it owns; this kernel tier compiles SDK-free, so reachability
//  is INJECTED the same way persistence is: the process host seeds an initial value and
//  pushes every change (`:platform` SourceBackend.kt is the Android installer).  No
//  per-plane slice is written here — those stay OWNER-published (`track`/`publish`).
//

package despia.engine

import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap

/** Minimal persistence face for provenance's per-plane/per-origin first-load stamp. */
interface DSXSourceStampStore {
    fun read(key: String): String?
    fun write(key: String, value: String)
}

private class MemoryDSXSourceStampStore : DSXSourceStampStore {
    private val values = ConcurrentHashMap<String, String>()
    override fun read(key: String): String? = values[key]
    override fun write(key: String, value: String) { values[key] = value }
}

object DSXSource {
    const val never = "never"
    const val stale = "stale"
    const val live = "live"
    const val servingOrigin = "origin"
    const val servingCache = "cache"
    const val servingBundle = "bundle"

    private val lock = Any()
    private const val MAX_KEY_BYTES = 8 * 1_024
    @Volatile private var stamps: DSXSourceStampStore = MemoryDSXSourceStampStore()
    @Volatile internal var clock: Clock = Clock.systemUTC()

    /** The reserved stamp identity behind `source.boot` — the `dsx.source.booted` twin. */
    private const val BOOT_PLANE = "boot"
    private const val BOOT_KEY = "install"

    /** Install the host-owned durable store. Safe to call again during process boot. */
    fun installStampStore(store: DSXSourceStampStore?) {
        synchronized(lock) { stamps = store ?: MemoryDSXSourceStampStore() }
    }

    /**
     * Seed the KERNEL facts before any surface renders (Source.swift `seed()`): `source.boot`
     * = "first" until this install has booted once, "warm" forever after, and `source.online`
     * = the host's current reachability answer. Idempotent within a process; the boot stamp is
     * written on the FIRST call, so a second call in the same install already reads "warm".
     *
     * DIVERGENCE from Swift, by construction: Source.swift arms its own `NWPathMonitor` here.
     * This tier has no Android/JVM reachability API (it compiles SDK-free), so the host seeds
     * the value and pushes changes through `setOnline` — the same injection the stamp store
     * uses. Neither call writes a per-plane slice: those stay owner-published.
     *
     * `online = null` means the host CANNOT observe reachability (no permission, no service):
     * `source.online` is then left ABSENT rather than guessed, because a fact that lies is
     * worse than a fact that is missing (Article 7). `source.boot` still seeds.
     */
    fun seed(online: Boolean?) {
        val at = DateTimeFormatter.ISO_INSTANT.format(Instant.now(clock))
        val warm = synchronized(lock) {
            val had = readStampLocked(BOOT_PLANE, BOOT_KEY) != null
            if (!had) runCatching { stamps.write(stampKey(BOOT_PLANE, BOOT_KEY), at) }
            had
        }
        DSX.state.setPath("source.boot", if (warm) "warm" else "first")
        if (online != null) DSX.state.setPath("source.online", online)
    }

    /**
     * Reachability changed (the `pathUpdateHandler` twin). DEDUPED exactly like Swift: an
     * unchanged value neither re-publishes nor re-fires `source.changed`, so a flapping
     * transport can't spam every `visible-if` bound to the plane. Call on the main thread —
     * the installer hops for you.
     */
    fun setOnline(online: Boolean) {
        if ((DSX.state.getPath("source.online") as? Boolean) == online) return
        DSX.state.setPath("source.online", online)
        ModuleRegistry.shared.dispatch("source.changed", mapOf("plane" to "online", "state" to online), combine = ModuleRegistry.Combine.void)
    }

    /** Seed one owner plane before its first load this session. */
    fun track(plane: String, key: String) {
        val safePlane = validatedPlane(plane) ?: return
        val safeKey = validatedKey(key) ?: return
        val state = synchronized(lock) {
            if (readStampLocked(safePlane, safeKey) == null) never else stale
        }
        write(safePlane, mapOf("state" to state), fire = false)
    }

    /** Report bytes which are actually serving now. A fresh origin answer stamps the install. */
    fun publish(
        plane: String,
        serving: String,
        fresh: Boolean,
        key: String,
        meta: Map<String, Any?> = emptyMap(),
    ) {
        val safePlane = validatedPlane(plane) ?: return
        val safeKey = validatedKey(key) ?: return
        if (serving !in setOf(servingOrigin, servingCache, servingBundle)) return
        val at = DateTimeFormatter.ISO_INSTANT.format(Instant.now(clock))
        val state = synchronized(lock) {
            var stamp = readStampLocked(safePlane, safeKey)
            if (fresh && stamp == null) {
                runCatching { stamps.write(stampKey(safePlane, safeKey), at) }
                // Treat this successful origin serve as live even if durable storage is
                // unavailable. Persistence failure must not make current-screen truth lie.
                stamp = at
            }
            if (fresh) live else if (stamp == null) never else stale
        }
        val slice = LinkedHashMap<String, Any?>()
        slice["state"] = state
        slice["serving"] = serving
        slice["at"] = at
        meta.forEach { (name, value) ->
            if (name !in setOf("state", "serving", "at")) slice[name] = value
        }
        write(safePlane, slice, fire = true)
    }

    fun state(plane: String): String =
        ((DSX.state.getPath("source.$plane") as? Map<*, *>)?.get("state") as? String).orEmpty()

    private fun write(plane: String, slice: Map<String, Any?>, fire: Boolean) {
        DSX.state.setPath("source.$plane", slice)
        if (fire) ModuleRegistry.shared.dispatch(
            "source.changed",
            mapOf("plane" to plane, "state" to slice["state"]), combine = ModuleRegistry.Combine.void
        )
    }

    private fun validatedPlane(value: String): String? = value.trim().takeIf {
        it.matches(Regex("[A-Za-z][A-Za-z0-9_-]{0,63}"))
    }

    private fun validatedKey(value: String): String? = value.takeIf {
        it.toByteArray(Charsets.UTF_8).size <= MAX_KEY_BYTES
    }

    private fun readStampLocked(plane: String, key: String): String? =
        runCatching { stamps.read(stampKey(plane, key)) }.getOrNull()?.takeIf(String::isNotBlank)

    /** Fixed-size/non-secret persistence key; origins never become preference key material. */
    internal fun stampKey(plane: String, key: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$plane\u0000$key".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return "v1.$digest"
    }

    internal fun resetForTests() {
        synchronized(lock) {
            stamps = MemoryDSXSourceStampStore()
            clock = Clock.systemUTC()
        }
    }
}

/** The owner-facing Kotlin facade, matching Swift's `dsx.source`. */
class DSXSourceFace {
    fun track(plane: String, key: String) = DSXSource.track(plane, key)
    fun publish(
        plane: String,
        serving: String,
        fresh: Boolean,
        key: String,
        meta: Map<String, Any?> = emptyMap(),
    ) = DSXSource.publish(plane, serving, fresh, key, meta)

    fun state(plane: String): String = DSXSource.state(plane)
    val online: Boolean get() = (DSX.state.getPath("source.online") as? Boolean) ?: true
}
