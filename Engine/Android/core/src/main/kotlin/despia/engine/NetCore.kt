//
//  NetCore.kt - the shared Core/Net core (:core, pure JVM): the classification fold, the online
//  split, the radio-family map, the probe verdict and the transition debounce. The law is the
//  corpus, OpenSource/Conformance/net/{status,transitions}.json (parity/F05-net.md). The twin of
//  Swift NetCore and the web @despia-native/kernel net-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file. NWPathMonitor (iOS),
//  ConnectivityManager.registerDefaultNetworkCallback (Android) and navigator.connection (web)
//  each read their own platform and hand the neutral snapshot in; the module publishes the
//  context vars and fires the `change` broadcast on the way out. Keeping the DECISION separate
//  from the PLUMBING is what lets one corpus judge three renderers.
//
package despia.engine

/**
 * The five facts a settled path carries.
 *
 * [validated] is Android's own captive-portal verdict (NET_CAPABILITY_VALIDATED). It is true on
 * every other renderer, where only an explicit probe() can learn the same thing, so the field
 * costs nothing there and keeps `online` one expression everywhere.
 */
data class NetSnapshot(
    val reachable: Boolean,
    val type: String,
    val expensive: Boolean,
    val constrained: Boolean,
    val validated: Boolean = true,
)

/** One settled transition, as the debounce reports it. */
data class NetChange(
    val at: Long,
    val previous: String,
    val snapshot: NetSnapshot,
    val online: Boolean,
)

object NetCore {

    /** The reported link vocabulary. "unknown" is the pre-first-update value only. */
    val TYPES: List<String> = listOf("wifi", "cellular", "ethernet", "vpn", "other", "none", "unknown")

    /** Interface-name prefixes that mean "this is a tunnel". A VPN rides ON TOP of wifi or
     *  cellular, so reporting the transport underneath would hide what the app asked about. */
    val TUNNEL_PREFIXES: List<String> = listOf("utun", "ipsec", "ppp", "tap", "tun")

    /** What the module publishes before the first path update lands: optimistic, so a page never
     *  flashes an offline banner on the way to learning the truth. */
    val UNKNOWN = NetSnapshot(reachable = true, type = "unknown", expensive = false, constrained = false)

    /**
     * The classification fold: a raw path snapshot in, the reported link facts out.
     *
     *   1. VPN wins over the transport underneath (a tunnel rides on top of wifi or cellular).
     *   2. An unsatisfied path is `none` and nothing else is inspected - a metered flag on a
     *      link that is down is not a fact about anything.
     *   3. `expensive` is the METERED flag, never `type == "cellular"`: a personal hotspot over
     *      wifi is metered, and cellular on an unlimited plan is not.
     *   4. `constrained` is the user's data-saving setting, independent of everything else.
     */
    fun classify(
        satisfied: Boolean,
        interfaces: List<String> = emptyList(),
        transports: List<String> = emptyList(),
        metered: Boolean = false,
        dataSaver: Boolean = false,
    ): NetSnapshot {
        if (!satisfied) {
            return NetSnapshot(reachable = false, type = "none", expensive = false,
                               constrained = false, validated = false)
        }
        val links = transports.map { it.trim().lowercase() }
        val tunnelled = interfaces.any { name ->
            val lower = name.trim().lowercase()
            TUNNEL_PREFIXES.any { lower.startsWith(it) }
        }
        val type = when {
            tunnelled || "vpn" in links -> "vpn"
            "wifi" in links -> "wifi"
            "cellular" in links -> "cellular"
            "ethernet" in links -> "ethernet"
            else -> "other"
        }
        return NetSnapshot(reachable = true, type = type, expensive = metered, constrained = dataSaver)
    }

    /** `online` is `reachable` AND the last probe verdict - the entire reason the two fields
     *  exist separately. An interface can be up while a captive portal eats every request. */
    fun online(snapshot: NetSnapshot, probeFailed: Boolean): Boolean =
        snapshot.reachable && snapshot.validated && !probeFailed

    /** Radio family token -> reported generation. The module normalises its own platform
     *  constant (NETWORK_TYPE_LTE, CTRadioAccessTechnologyLTE, connection.effectiveType) down to
     *  one of these tokens; anything unrecognised reports empty rather than a guess. */
    private val RADIO_FAMILIES: Map<String, String> = mapOf(
        "gprs" to "2g", "edge" to "2g", "cdma" to "2g", "cdma1x" to "2g", "1xrtt" to "2g",
        "iden" to "2g", "gsm" to "2g",
        "wcdma" to "3g", "umts" to "3g", "hsdpa" to "3g", "hsupa" to "3g", "hspa" to "3g",
        "hspap" to "3g", "evdo0" to "3g", "evdoa" to "3g", "evdob" to "3g",
        "cdmaevdorev0" to "3g", "cdmaevdoreva" to "3g", "cdmaevdorevb" to "3g",
        "ehrpd" to "3g", "tdscdma" to "3g",
        "lte" to "4g", "iwlan" to "4g",
        "nr" to "5g", "nrnsa" to "5g",
    )

    /** Empty unless the link is cellular AND the platform volunteered the family without a
     *  permission prompt. A withheld family is empty, never a guess. */
    fun generation(type: String, radio: String?): String {
        if (type != "cellular") return ""
        val token = radio?.trim()?.lowercase().orEmpty()
        if (token.isEmpty()) return ""
        return RADIO_FAMILIES[token] ?: ""
    }

    /** The host a redirect points at, or null when the Location names none (which includes a
     *  relative Location, whose host is by definition the requested one). */
    private fun redirectHost(location: String): String? {
        val marker = location.indexOf("://")
        if (marker < 0) return null
        var rest = location.substring(marker + 3)
        val cut = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
        if (cut >= 0) rest = rest.substring(0, cut)
        val at = rest.lastIndexOf('@')
        if (at >= 0) rest = rest.substring(at + 1)
        // One colon is a port; several is an IPv6 literal, which keeps its colons.
        if (rest.count { it == ':' } == 1) {
            val colon = rest.lastIndexOf(':')
            val port = rest.substring(colon + 1)
            if (port.isNotEmpty() && port.all { it.isDigit() }) rest = rest.substring(0, colon)
        }
        return rest.lowercase()
    }

    /**
     * The reachability verdict from ONE completed request.
     *
     * Redirects are never followed, so the response IS the 3xx and its Location is readable: a
     * redirect to another host is the captive-portal signature, while a same-host redirect (an
     * http to https upgrade) is a normal, reachable answer. 4xx and 5xx mean a server answered
     * but the app is not served, and status 0 is a dead transport - an ANSWER, never a throw.
     */
    fun probeReachable(status: Int, requestHost: String?, location: String?): Boolean {
        if (status < 200 || status >= 400) return false
        if (status < 300) return true
        val target = location?.trim().orEmpty()
        if (target.isEmpty()) return false
        val host = redirectHost(target) ?: return true
        return host == requestHost?.trim()?.lowercase()
    }
}

/**
 * The transition debounce.
 *
 * Interfaces flap: a wifi to cellular handoff drops through `none` for a few hundred
 * milliseconds, and an undebounced stream turns that into three events and two banner flashes.
 *
 *   1. The FIRST update after launch is applied immediately and announces nothing - there was no
 *      earlier state to change from, and waiting half a second to learn the truth at launch
 *      would be its own bug.
 *   2. After that a candidate must hold for [debounceMs] before it is published.
 *   3. A candidate that returns to the settled value inside the window cancels it outright, so a
 *      flap produces no event at all.
 *   4. A settled transition emits exactly ONE change, carrying the new facts plus `previous`.
 *   5. A settled transition clears the probe verdict: a new link deserves a fresh one.
 *
 * The clock is the CALLER'S. The module drives it from a real timer, the corpus runner drives it
 * from a timeline, and the machine cannot tell the difference.
 */
class NetDebounce(debounceMs: Long, initial: NetSnapshot = NetCore.UNKNOWN) {

    val debounceMs: Long = if (debounceMs < 0) 0 else debounceMs

    private var current: NetSnapshot = initial
    private var hasSettled = false
    private var failedProbe = false
    private var pendingCandidate: NetSnapshot? = null
    private var pendingDeadlineMs: Long = 0
    private val changes = ArrayList<NetChange>()

    val settled: NetSnapshot get() = current
    val probeFailed: Boolean get() = failedProbe
    val online: Boolean get() = NetCore.online(current, failedProbe)

    /** When the pending candidate is due, or null when nothing is pending. The module arms one
     *  timer on this; nothing else needs to know the window exists. */
    val pendingDeadline: Long? get() = if (pendingCandidate == null) null else pendingDeadlineMs

    /** Commit a pending candidate whose window has closed. Idempotent. */
    fun advance(now: Long) {
        val candidate = pendingCandidate ?: return
        if (pendingDeadlineMs > now) return
        val deadline = pendingDeadlineMs
        pendingCandidate = null
        if (candidate == current) return
        val previous = current.type
        current = candidate
        failedProbe = false
        changes.add(NetChange(deadline, previous, candidate, NetCore.online(candidate, false)))
    }

    /** A path update from the platform. */
    fun path(now: Long, candidate: NetSnapshot) {
        advance(now)
        if (!hasSettled) {
            hasSettled = true
            current = candidate
            pendingCandidate = null
            return
        }
        pendingCandidate = null
        if (candidate == current) return
        pendingCandidate = candidate
        pendingDeadlineMs = now + debounceMs
        if (debounceMs == 0L) advance(now)
    }

    /** A completed probe's verdict. It moves `online` without touching the link facts, and
     *  without announcing a transition: the link did not change, only what it is worth. */
    fun probe(now: Long, failed: Boolean) {
        advance(now)
        failedProbe = failed
    }

    /** Take the transitions recorded since the last drain. */
    fun drain(): List<NetChange> {
        val out = ArrayList(changes)
        changes.clear()
        return out
    }
}
