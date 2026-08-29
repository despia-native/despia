//
//  GeoPolicy.kt - the shared Core/Geo pure core (:core, pure JVM): the two-step permission
//  ladder, the escalation route, the precise-location decision, the region-limit accounting,
//  the accuracy vocabulary and the battery filter. The law is the corpus:
//  OpenSource/Conformance/geo/*.json (parity/F09-geo.md). The twin of the web @despia/kernel
//  geo.ts and Swift Engine/iOS GeoPolicy.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: FusedLocationProviderClient,
//  CLLocationManager and navigator.geolocation all ask this core WHAT to do and then do it.
//  Keeping the DECISION separate from the PLUMBING is what makes "the ladder is enforced, not
//  documented" a testable claim rather than a paragraph in a README.
//
//  THE TWO RULES THIS FILE EXISTS FOR:
//
//  1. ASK FOR whenInUse FIRST. A cold `always` request is denied by most users and flagged in
//     store review, and from Android 11 the system will not show the background-location
//     dialog at all - the only path is the settings screen. So `always` without a granted
//     `whenInUse` refuses with escalation_required and never reaches a prompt.
//
//  2. THE REGION CAP IS A TYPED ERROR. iOS monitors twenty regions per app, Android starts
//     dropping above a hundred, and every library silently loses the overflow.
//
package despia.engine

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

object GeoPolicy {

    // ---------------------------------------------------------------------------------
    // The permission ladder
    // ---------------------------------------------------------------------------------

    /** The authorization statuses, as the module reports them (never a platform enum). */
    val STATUSES: List<String> = listOf("notDetermined", "denied", "restricted", "whenInUse", "always")

    /** The two levels an app may ask for. There is no third. */
    val LEVELS: List<String> = listOf("whenInUse", "always")

    /** What the module knows about this app's grant right now. */
    data class PermissionState(
        val status: String,
        /** True once the OS has shown the background prompt. It shows it once; after that a
         *  repeat request displays nothing, so the honest move is a Settings deep link. */
        val escalationOffered: Boolean = false,
        val precise: Boolean = false,
    )

    /** What to do about a permission request. */
    data class Plan(
        val action: String,
        val prompt: String? = null,
        val status: String? = null,
        val prompted: Boolean = false,
        val error: String? = null,
    )

    /**
     * Decide what a `permission({ level })` call should do. The ladder in one function:
     * `whenInUse` prompts once and then settles; `always` is legal ONLY on top of a granted
     * `whenInUse`, and only once, because that is the only shape either platform supports.
     */
    fun permissionPlan(level: String?, state: PermissionState): Plan {
        val want = level?.trim().orEmpty()
        if (want !in LEVELS) return Plan(action = "refuse", error = "invalid_argument")
        if (state.status == "restricted") return Plan(action = "refuse", error = "permission_denied")

        if (want == "whenInUse") {
            return when (state.status) {
                "whenInUse", "always" -> Plan(action = "settle", status = state.status, prompted = false)
                "denied" -> Plan(action = "refuse", error = "permission_denied")
                else -> Plan(action = "prompt", prompt = "whenInUse")
            }
        }

        if (state.status == "always") return Plan(action = "settle", status = "always", prompted = false)
        if (state.status != "whenInUse") return Plan(action = "refuse", error = "escalation_required")
        if (state.escalationOffered) return Plan(action = "settle", status = "whenInUse", prompted = false)
        return Plan(action = "prompt", prompt = "always")
    }

    /**
     * Fold the OS's answer to a prompt back into the state.
     *
     * A DECLINED ESCALATION IS NOT A LOST GRANT: the app still holds `whenInUse` and the one
     * available offer has been spent. Throwing the foreground grant away here would break the
     * app's working feature to record the refusal of a different one.
     */
    fun applyPermission(state: PermissionState, prompted: String, granted: Boolean): PermissionState =
        if (prompted == "always") {
            state.copy(status = if (granted) "always" else state.status, escalationOffered = true)
        } else {
            state.copy(status = if (granted) "whenInUse" else "denied")
        }

    /**
     * How the `always` escalation is actually obtained on this platform.
     *
     * THE ANDROID BACKGROUND SPLIT: `always` is ACCESS_BACKGROUND_LOCATION, and from API 30 the
     * system refuses to show it in a request dialog - the only path is the app settings screen.
     * An app that calls requestPermissions and waits for a callback waits forever.
     */
    fun escalationRoute(platform: String, sdk: Int): String = when (platform) {
        "ios" -> "prompt"
        "android" -> if (sdk >= 30) "settings" else "prompt"
        else -> "unsupported"
    }

    /** Whether a reduced-accuracy grant satisfies what the caller asked for. */
    data class PreciseOutcome(val ok: Boolean, val precise: Boolean = false, val error: String? = null)

    /** iOS 14 and Android 12 both let a user grant APPROXIMATE location. An app that needs
     *  precision must be told, rather than left to wonder why every fix is kilometres wide. */
    fun preciseOutcome(requested: Boolean, granted: Boolean): PreciseOutcome =
        if (requested && !granted) PreciseOutcome(ok = false, error = "precise_denied")
        else PreciseOutcome(ok = true, precise = granted)

    // ---------------------------------------------------------------------------------
    // Region monitoring
    // ---------------------------------------------------------------------------------

    /** iOS 20 is a hard OS limit; Android starts dropping above 100. */
    val REGION_CAPS: Map<String, Int> = mapOf("ios" to 20, "android" to 100, "web" to 0)

    const val RADIUS_FLOOR_METERS: Double = 100.0
    const val RADIUS_CEILING_METERS: Double = 100_000.0

    data class Radius(val radius: Double, val clamped: Boolean)

    /** Correct a radius the platform will not honour, and SAY that it was corrected. A region
     *  that silently never fires is indistinguishable from a broken geofence implementation. */
    fun radius(requested: Double): Radius = when {
        !requested.isFinite() || requested < RADIUS_FLOOR_METERS -> Radius(RADIUS_FLOOR_METERS, true)
        requested > RADIUS_CEILING_METERS -> Radius(RADIUS_CEILING_METERS, true)
        else -> Radius(requested, false)
    }

    data class RegionResult(
        val ok: Boolean,
        val id: String? = null,
        val count: Int = 0,
        val removed: Boolean? = null,
        val error: String? = null,
        val limit: Int? = null,
    )

    /**
     * The monitored-region set, with the cap accounted for rather than discovered.
     *
     * Re-adding a live id REPLACES it in place and consumes no slot, so a screen that
     * re-declares its regions on every appear cannot exhaust the cap by itself - which is how
     * apps hit the limit in the field.
     */
    class RegionSet(val cap: Int) {
        private val ids = ArrayList<String>()

        val count: Int get() = ids.size

        fun list(): List<String> = ids.toList()

        fun add(id: String?): RegionResult {
            val key = id?.trim().orEmpty()
            if (key.isEmpty()) return RegionResult(ok = false, error = "invalid_argument")
            if (ids.contains(key)) return RegionResult(ok = true, id = key, count = ids.size)
            if (ids.size >= cap) {
                return RegionResult(ok = false, error = "region_limit", limit = cap, count = ids.size)
            }
            ids.add(key)
            return RegionResult(ok = true, id = key, count = ids.size)
        }

        fun remove(id: String?): RegionResult {
            val key = id?.trim().orEmpty()
            if (key.isEmpty()) return RegionResult(ok = false, error = "invalid_argument")
            val removed = ids.remove(key)
            return RegionResult(ok = true, id = key, count = ids.size, removed = removed)
        }
    }

    /** Where one crossing goes. A geofence wakes the app with NO UI, so a delivery path that
     *  only reaches a mounted screen is a feature that works in the emulator and never in
     *  production: a region may name a declared Core/Background task, and the crossing runs it. */
    data class DeliveryPlan(val broadcast: Boolean, val background: Boolean, val foreground: Boolean)

    fun deliveryPlan(task: String?, screenMounted: Boolean): DeliveryPlan =
        DeliveryPlan(
            broadcast = true,
            background = task?.trim().orEmpty().isNotEmpty(),
            foreground = screenMounted,
        )

    // ---------------------------------------------------------------------------------
    // The stream
    // ---------------------------------------------------------------------------------

    /** One accuracy word, and the real platform constant it names. */
    data class Accuracy(
        val word: String,
        val ios: String,
        val android: String,
        val web: String,
        val meters: Int,
    )

    val ACCURACIES: List<Accuracy> = listOf(
        Accuracy("navigation", "kCLLocationAccuracyBestForNavigation", "PRIORITY_HIGH_ACCURACY", "high", 0),
        Accuracy("best", "kCLLocationAccuracyBest", "PRIORITY_HIGH_ACCURACY", "high", 0),
        Accuracy("balanced", "kCLLocationAccuracyNearestTenMeters", "PRIORITY_BALANCED_POWER_ACCURACY", "low", 10),
        Accuracy("low", "kCLLocationAccuracyHundredMeters", "PRIORITY_LOW_POWER", "low", 100),
        Accuracy("passive", "kCLLocationAccuracyThreeKilometers", "PRIORITY_PASSIVE", "low", 3000),
    )

    const val DEFAULT_ACCURACY: String = "balanced"

    /** Fold an accuracy word. Absent takes the balanced default; an unrecognised word is
     *  refused rather than silently downgraded, because a silent downgrade is a battery
     *  decision made on the author's behalf. Null when refused. */
    fun accuracy(word: String?): Accuracy? {
        val key = word?.trim().orEmpty()
        val wanted = if (key.isEmpty()) DEFAULT_ACCURACY else key
        return ACCURACIES.firstOrNull { it.word == wanted }
    }

    /** The IUGG mean Earth radius, in metres. Pinned so three runtimes agree on a distance. */
    const val EARTH_RADIUS_METERS: Double = 6_371_008.8

    /** Great-circle distance between two fixes, in metres (haversine). */
    fun distanceMeters(fromLat: Double, fromLon: Double, toLat: Double, toLon: Double): Double {
        val rad = PI / 180.0
        val phi1 = fromLat * rad
        val phi2 = toLat * rad
        val dPhi = (toLat - fromLat) * rad
        val dLambda = (toLon - fromLon) * rad
        val a = sin(dPhi / 2) * sin(dPhi / 2) +
            cos(phi1) * cos(phi2) * sin(dLambda / 2) * sin(dLambda / 2)
        return 2 * EARTH_RADIUS_METERS * asin(min(1.0, sqrt(a)))
    }

    /** A delivered fix, reduced to what the filter needs. */
    data class Fix(val lat: Double, val lon: Double, val at: Long)

    data class FilterVerdict(val deliver: Boolean, val reason: String? = null)

    /**
     * Does this fix go to the caller.
     *
     * THE BATTERY BUG THIS PREVENTS: a module that accepts `distanceFilter` and delivers every
     * fix anyway passes every test that only checks that positions arrive, and drains a phone
     * in an afternoon. Both filters must pass when both are set; the first fix of a session
     * always goes out, because a filter that swallows the opening position renders a map in
     * the ocean.
     */
    fun shouldDeliver(last: Fix?, next: Fix, distanceFilter: Double, intervalMs: Long): FilterVerdict {
        if (last == null) return FilterVerdict(true)
        if (intervalMs > 0) {
            val elapsed = next.at - last.at
            // A clock change or a late-queued fix must not wedge the stream forever.
            if (elapsed in 0 until intervalMs) return FilterVerdict(false, "interval")
        }
        if (distanceFilter > 0) {
            val moved = distanceMeters(last.lat, last.lon, next.lat, next.lon)
            if (moved < distanceFilter) return FilterVerdict(false, "distance")
        }
        return FilterVerdict(true)
    }

    /** Whether a cached fix is fresh enough to answer `last({ maxAge })` WITHOUT waking the
     *  radio, which is the whole point of the call. A stale cache is the typed absence, never a
     *  stale fix handed back as though it were current. */
    fun cacheServes(ageMs: Long, maxAgeMs: Long): Boolean = maxAgeMs <= 0 || ageMs <= maxAgeMs

    /** Kept for the conformance runner's float comparison: three languages will not agree on
     *  the last bit of a haversine, and pretending otherwise makes a green suite that fails on
     *  a device. */
    fun withinTolerance(actual: Double, expected: Double, tolerance: Double): Boolean =
        abs(actual - expected) <= tolerance
}
