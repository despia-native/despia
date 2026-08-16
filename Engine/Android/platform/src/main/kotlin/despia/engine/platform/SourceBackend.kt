//
//  SourceBackend.kt — :platform
//
//  The Android half of the PROVENANCE plane (`dsx.source`) — the installer that turns the
//  SDK-free `:core` mechanism (Source.kt) into real state on a phone/wear process. Twin of
//  the two halves Source.swift keeps inline (it may: `UserDefaults.standard` and
//  `NWPathMonitor` are Foundation), split here exactly like every other kernel seam:
//
//    • PERSISTENCE — a `DSXSourceStampStore` over ONE app-private SharedPreferences file
//      (`dsx.source`). The Swift comment is the spec: the stamp lives in
//      `UserDefaults.standard`, deliberately NOT the App Group container (writes drop on
//      unprovisioned builds) and NOT Caches (the OS may purge it, which would regress
//      `stale` → `never`). Its Android reading is a MODE_PRIVATE prefs file that is neither
//      `Container.groupID` (the group twin) nor cacheDir. The desktop precedent is
//      DesktopSource.kt — same interface, `java.util.prefs` instead.
//    • REACHABILITY — a ConnectivityManager default-network callback pushed into
//      `DSXSource.setOnline`, which dedupes and fires `source.changed` exactly like the
//      iOS `pathUpdateHandler`. Registered once per process; a denied/absent service leaves
//      the seeded value standing (Article 7: degrade, never lie).
//
//  ONE line in the bootloader's documented boot-bindings block installs it (the
//  ContainerBackend/NetworkBackend pattern) — and it must run BEFORE modules boot, so
//  `dsx.source.track("web", …)` at the `lifecycle.launch` hook already reads durable stamps and
//  markup can branch on `dsx.source.boot == 'first'` on the very first frame.
//
//  WHAT THIS FILE DOES NOT DO: publish a per-plane slice. `source.web` is Dom's,
//  `source.routes` the Router's/Routing's, `source.content` the content store's,
//  `source.view` DSXView's — one owner per plane, no aggregator (source-plane.md §2).
//

package despia.engine.platform

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import despia.engine.DSXSource
import despia.engine.DSXSourceStampStore
import despia.engine.kernelLog
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/// The boot installer — ONE line in DespiaApp.onCreate, beside ContainerBackend/NetworkBackend.
object SourceBackend {

    /// The stamp file. FOREVER-stable (renaming it later regresses every install to `never`).
    private const val PREFS = "dsx.source"

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var monitoring = false

    /// Install durable provenance stamps + reactive reachability, then seed the kernel facts
    /// (`source.boot` first|warm, `source.online`). Idempotent; call once at boot.
    fun install(context: Context) {
        val app = context.applicationContext
        runCatching { app.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
            .onSuccess { DSXSource.installStampStore(SharedPreferencesSourceStampStore(it)) }
            .onFailure { kernelLog("[source] no durable stamp store ($it) — provenance is process-local") }
        // ACCESS_NETWORK_STATE ships in THIS module's library manifest, so a normal build always
        // has it. A profile that strips it (or a device that denies the service) leaves
        // `source.online` ABSENT — markup reading it gets nothing instead of a confident lie.
        val granted = runCatching {
            app.checkPermission(android.Manifest.permission.ACCESS_NETWORK_STATE,
                                android.os.Process.myPid(), android.os.Process.myUid()) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }.getOrDefault(false)
        val manager = if (granted) {
            app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        } else {
            kernelLog("[source] ACCESS_NETWORK_STATE not granted — source.online stays absent")
            null
        }
        DSXSource.seed(online = manager?.let { isOnline(it) })
        monitor(manager)
    }

    /// The `NWPathMonitor.currentPath.status == .satisfied` twin: a default network that
    /// actually validated. No network ⇒ offline, never an optimistic guess.
    private fun isOnline(manager: ConnectivityManager): Boolean {
        val caps = runCatching { manager.getNetworkCapabilities(manager.activeNetwork) }.getOrNull()
            ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /// Keep `source.online` reactive. Every edge hops to the main thread (the Swift monitor's
    /// `DispatchQueue.main.async` twin) so the reactive store publishes on one thread; the
    /// kernel dedupes, so a flapping transport can't spam bound markup.
    private fun monitor(manager: ConnectivityManager?) {
        if (manager == null || monitoring) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = push(manager)
            override fun onLost(network: Network) = push(manager)
            override fun onUnavailable() = push(manager)
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = push(manager)
        }
        // registerDefaultNetworkCallback(callback) is API 24 — the module's minSdk floor —
        // so no availability branch is needed. A SecurityException (no ACCESS_NETWORK_STATE
        // on a stripped profile) leaves the seeded value standing rather than crashing boot.
        runCatching { manager.registerDefaultNetworkCallback(callback) }
            .onSuccess { monitoring = true }
            .onFailure { kernelLog("[source] reachability unmonitored ($it) — source.online stays seeded") }
    }

    private fun push(manager: ConnectivityManager) {
        val online = isOnline(manager)
        main.post { DSXSource.setOnline(online) }
    }
}

/// Provenance stamps over ONE prefs file. Public so the unit rig can drive it with a fake
/// SharedPreferences (the SharedPreferencesContainerKV precedent — pure interface, no SDK).
/// The desktop twin's validation is kept verbatim: only the kernel's own `v1.<sha256>` key
/// shape is readable/writable and only a parseable instant counts, so one corrupt preference
/// can never pin an install to `never` forever, and no origin string becomes key material.
class SharedPreferencesSourceStampStore(
    private val prefs: SharedPreferences,
) : DSXSourceStampStore {

    private val keyShape = Regex("v1\\.[0-9a-f]{64}")

    override fun read(key: String): String? {
        if (!key.matches(keyShape)) return null
        return runCatching { prefs.getString(key, null) }.getOrNull()
            ?.takeIf { it.length <= 64 && isParseableSourceInstant(it) }
    }

    override fun write(key: String, value: String) {
        if (!key.matches(keyShape) || value.length > 64) return
        if (!isParseableSourceInstant(value)) return
        // apply(): the in-memory commit is synchronous (a same-frame read sees the stamp),
        // the disk flush asynchronous — the ContainerBackend write policy, unchanged.
        runCatching { prefs.edit().putString(key, value).apply() }
    }
}

// java.time.Instant.parse is API 26 unless a consuming app enables core-library desugaring.
// :platform promises minSdk 24 as a standalone library, so provenance validation cannot make
// that an undocumented consumer requirement. SimpleDateFormat and ParsePosition are API 1;
// the regex keeps their deliberately broad grammar pinned to ISO-8601 instants only.
private val sourceInstantShape = Regex(
    """(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})""",
)

internal fun isParseableSourceInstant(value: String): Boolean {
    val match = sourceInstantShape.matchEntire(value) ?: return false
    val zone = match.groupValues[3]
    if (zone != "Z") {
        val hours = zone.substring(1, 3).toInt()
        val minutes = zone.substring(4, 6).toInt()
        if (hours > 18 || minutes > 59 || (hours == 18 && minutes != 0)) return false
    }
    val normalized = match.groupValues[1] + "Z"
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT).apply {
        isLenient = false
        timeZone = TimeZone.getTimeZone("UTC")
    }
    val position = ParsePosition(0)
    return parser.parse(normalized, position) != null && position.index == normalized.length
}
