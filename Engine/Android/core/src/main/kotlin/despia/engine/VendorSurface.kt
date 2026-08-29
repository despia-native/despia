package despia.engine

import kotlin.math.ceil
import kotlin.math.floor

/*
 * VendorSurface.kt - Kotlin twin of @despia/kernel vendor-surface.ts and
 * Engine/iOS/VendorSurface.swift: THE INLINE-VENDOR-SURFACE FAMILY FOLDS (V02..V06,
 * architecture/proposals/inline-native-surfaces.md).
 *
 * The SECOND half of the pure core V01 started in VendorSession.kt, and deliberately a
 * sibling file rather than a fork: VendorSessionRef (the secret boundary),
 * VendorSessionMachine (one session, two views) and VendorRetain (keyed identity) are
 * SHARED and every vendor in this family uses them unchanged. There is exactly one session
 * machine in this codebase and this file does not add a second.
 *
 * What the family needed and V01 did not have is here: the permission ladder a live surface
 * renders through, the participant roster a call grid orders by, the ad slot geometry and
 * request gate, the paywall package ordering, the sign-in step ladder, and the scan dedupe
 * a camera preview needs to stop firing sixty times a second.
 *
 * The law is the corpus: OpenSource/Conformance/inline-surfaces/{stream,clerk,admob,
 * revenuecat,scanner}.json, run here by VendorSurfaceConformanceTest.
 *
 * PURE by construction: no Android, no Regex, no vendor SDK. Everything is a function of its
 * arguments, which is what lets one corpus judge three runtimes and what lets a camera
 * permission ladder be tested without a camera.
 */

// -- 1 - THE SURFACE GATE: what a live vendor surface renders, before it renders ----------

enum class SurfaceCapability { PRESENT, ABSENT }

/** `UNKNOWN` is the honest word for "not asked yet on a platform that does not distinguish",
 *  and it is treated as `PROMPT` rather than as a denial: a surface that fails closed on a
 *  not-yet-asked permission never gets asked. */
enum class SurfacePermission { GRANTED, PROMPT, DENIED, RESTRICTED, UNKNOWN }

/** `REQUEST` is the affordance that asks; `FALLBACK` is the author's slot children, or the
 *  typed-absence caption where there are none. */
enum class SurfaceRender { SURFACE, REQUEST, FALLBACK }

object VendorSurfaceGate {

    const val SUBJECT = "This surface"

    /** One wording per code, so three renderers cannot say it differently. */
    val MESSAGES: Map<String, String> = linkedMapOf(
        "unsupported_platform" to "{subject} is not available on this device.",
        "permission_required" to "{subject} access has not been granted yet.",
        "permission_denied" to "{subject} access was denied. Enable it in Settings to continue.",
        "permission_restricted" to "{subject} access is restricted on this device.",
    )

    data class Gate(
        val render: SurfaceRender,
        val code: String,
        val message: String,
        val recoverable: Boolean,
    ) {
        val renderCode: String get() = renderCode(render)
    }

    fun renderCode(render: SurfaceRender): String = when (render) {
        SurfaceRender.SURFACE -> "surface"
        SurfaceRender.REQUEST -> "request"
        SurfaceRender.FALLBACK -> "fallback"
    }

    fun capability(word: String?): SurfaceCapability =
        if (word?.trim() == "absent") SurfaceCapability.ABSENT else SurfaceCapability.PRESENT

    fun permission(word: String?): SurfacePermission = when (word?.trim()) {
        "granted" -> SurfacePermission.GRANTED
        "prompt" -> SurfacePermission.PROMPT
        "denied" -> SurfacePermission.DENIED
        "restricted" -> SurfacePermission.RESTRICTED
        else -> SurfacePermission.UNKNOWN
    }

    /**
     * The ladder a live vendor surface descends before it shows anything.
     *
     * ORDER IS THE LAW. Capability first: a device with no camera must not be asked for
     * camera permission, and an SDK that is not linked in this build must answer
     * `unsupported_platform` rather than a permission word it cannot know. Then the
     * permission, where PROMPT and UNKNOWN both render the ASK rather than the refusal.
     */
    fun gate(
        capability: SurfaceCapability = SurfaceCapability.PRESENT,
        permission: SurfacePermission = SurfacePermission.UNKNOWN,
        subject: String = "",
    ): Gate {
        val subj = subject.trim().ifEmpty { SUBJECT }
        fun say(code: String): String =
            if (code.isEmpty()) "" else (MESSAGES[code] ?: "").replace("{subject}", subj)

        if (capability == SurfaceCapability.ABSENT) {
            return Gate(SurfaceRender.FALLBACK, "unsupported_platform", say("unsupported_platform"), false)
        }
        return when (permission) {
            SurfacePermission.GRANTED -> Gate(SurfaceRender.SURFACE, "", "", false)
            SurfacePermission.DENIED -> Gate(SurfaceRender.FALLBACK, "permission_denied", say("permission_denied"), true)
            SurfacePermission.RESTRICTED ->
                Gate(SurfaceRender.FALLBACK, "permission_restricted", say("permission_restricted"), false)
            else -> Gate(SurfaceRender.REQUEST, "permission_required", say("permission_required"), true)
        }
    }
}

// -- 2 - THE CALL ROSTER: who is on screen, in what order, in how many columns ------------

object VendorRoster {

    data class Participant(
        val id: String,
        val local: Boolean = false,
        val pinned: Boolean = false,
        val dominant: Boolean = false,
        val screenShare: Boolean = false,
        val joinedAt: Long = 0,
    )

    /** A tier is a POSITION rule, never a visibility rule: everyone is in `order`, and only
     *  `max` decides who is visible. */
    val TIERS: List<String> = listOf("pinned", "screenShare", "dominant", "remote", "local")

    data class Fold(
        val order: List<String>,
        val visible: List<String>,
        val overflow: Int,
        val spotlight: String,
        val columns: Int,
        val rows: Int,
    )

    /** Visible tiles to grid columns. Hardcoded on all three renderers on purpose, so a
     *  three-person call is never 2x2 on one platform and 3x1 on another. */
    fun columns(count: Int): Int = when {
        count <= 0 -> 0
        count == 1 -> 1
        count <= 4 -> 2
        count <= 9 -> 3
        else -> 4
    }

    private fun tier(p: Participant): Int = when {
        p.pinned -> 0
        p.screenShare -> 1
        p.dominant -> 2
        p.local -> 4
        else -> 3
    }

    /**
     * Order a call's participants deterministically.
     *
     * The local participant sinks to the bottom unless something promotes it (a pin, a
     * screen share, the floor), because a user looking at their own face instead of the
     * person talking is the complaint every call app gets first. Ties break on join time and
     * then on id, so the same roster produces the same grid on three renderers and a
     * re-render does not shuffle tiles under a finger.
     */
    fun fold(participants: List<Participant>, max: Int = 0, layout: String = ""): Fold {
        val people = participants.filter { it.id.isNotEmpty() }
        val ranked = people.withIndex().sortedWith(
            compareBy({ tier(it.value) }, { it.value.joinedAt }, { it.value.id }, { it.index }),
        )
        val order = ranked.map { it.value.id }
        val visible = if (max > 0) order.take(max) else order
        val cols = columns(visible.size)
        return Fold(
            order = order,
            visible = visible,
            overflow = order.size - visible.size,
            spotlight = if (layout == "spotlight") order.firstOrNull().orEmpty() else "",
            columns = cols,
            rows = if (cols == 0) 0 else ceil(visible.size.toDouble() / cols).toInt(),
        )
    }
}

// -- 3 - THE AD SLOT: geometry, and whether a request may be made at all ------------------

object VendorAdSlot {

    /** The IAB sizes the vendor SDKs name, in density-independent pixels. Data, not code,
     *  because these are the vendor's numbers and all three renderers hardcode the same ones. */
    val SIZES: Map<String, Pair<Int, Int>> = linkedMapOf(
        "banner" to (320 to 50),
        "largeBanner" to (320 to 100),
        "mediumRectangle" to (300 to 250),
        "fullBanner" to (468 to 60),
        "leaderboard" to (728 to 90),
        "skyscraper" to (120 to 600),
    )

    /** `adaptive` means the SDK measures the height. The fold refuses to invent one: Google
     *  computes it from the device at request time, and a number guessed here is a layout
     *  that jumps the first time a real ad lands. */
    data class Slot(val width: Int, val height: Int, val adaptive: Boolean, val code: String)

    fun slot(size: String?, width: Int = 0): Slot {
        val word = size?.trim().orEmpty()
        if (word.isEmpty() || word == "adaptive") {
            return if (width > 0) Slot(width, 0, true, "") else Slot(0, 0, true, "unknown_width")
        }
        val fixed = SIZES[word] ?: return Slot(0, 0, false, "unknown_size")
        return Slot(fixed.first, fixed.second, false, "")
    }

    /** `not_required` is a real state (a user outside the regions that require a form), and
     *  it is not the same as `obtained`. */
    val CONSENT: List<String> = listOf("obtained", "required", "not_required", "unknown")

    /** The consent words, ordered from the least to the most that is known to be permitted.
     *  `required` (a form is outstanding) is more restrictive than `not_required` (this user
     *  is outside the regions that need one), and `unknown` is the floor because nothing has
     *  been asked yet. The order is what makes the fold below a minimum. */
    val CONSENT_RANK: Map<String, Int> = linkedMapOf(
        "unknown" to 0, "required" to 1, "not_required" to 2, "obtained" to 3,
    )

    /**
     * The MODULE's consent answer folded with what a caller asserted. Minimum wins.
     *
     * The module holds the platform's answer (UMP's canRequestAds and consentStatus); a
     * caller - a component attribute, a page, a markup `session()` arg - holds an assertion.
     * An assertion may only NARROW: a caller that says `obtained` over an `unknown` module
     * answer is asking the build to request an ad on a consent nobody gathered, which is the
     * policy breach this fold exists to make unreachable.
     *
     * An assertion that is absent, empty, or not one of the four words is not a consent
     * statement at all, so the module's answer stands rather than being dragged to the floor
     * by a typo. An unrecognised MODULE answer is `unknown`, because the module's word is the
     * authority and an authority that cannot be read has answered nothing.
     */
    fun consentFold(module: String?, asserted: String? = null): String {
        val own = module?.trim().orEmpty()
        val mine = if (CONSENT_RANK.containsKey(own)) own else "unknown"
        val claim = asserted?.trim().orEmpty()
        val claimRank = CONSENT_RANK[claim] ?: return mine
        return if (claimRank < (CONSENT_RANK[mine] ?: 0)) claim else mine
    }

    data class RequestGate(val request: Boolean, val code: String, val recoverable: Boolean)

    /**
     * Whether an ad request may leave the device.
     *
     * ORDER IS THE LAW, and the consent rows are the reason: a build that requests while a
     * consent form is outstanding is a policy violation, not a missed impression, so
     * `consent_required` is answered before anything that could read as a reason to proceed.
     * A missing unit id is checked first only because it is a build mistake, and saying "ads
     * are disabled" to someone who forgot the id sends them to the wrong file.
     *
     * The consent the gate judges is `consentFold(consent, asserted)` - the module's answer
     * narrowed by the caller's, never widened by it.
     */
    fun requestGate(
        unitId: String?,
        enabled: Boolean = true,
        consent: String = "unknown",
        asserted: String? = null,
    ): RequestGate {
        if (unitId?.trim().isNullOrEmpty()) return RequestGate(false, "missing_ad_unit", false)
        if (!enabled) return RequestGate(false, "ads_disabled", false)
        return when (consentFold(consent, asserted)) {
            "required" -> RequestGate(false, "consent_required", true)
            "obtained", "not_required" -> RequestGate(true, "", false)
            else -> RequestGate(false, "consent_pending", true)
        }
    }
}

// -- 4 - THE PAYWALL: the vendor's packages, in one order, with one default ---------------

object VendorPaywall {

    /** The vendor's own package-type vocabulary, in the order a paywall lists them. */
    val PACKAGE_ORDER: List<String> = listOf(
        "lifetime", "annual", "six_month", "three_month", "two_month", "monthly", "weekly", "custom", "unknown",
    )

    /** Months per package type. A type absent from this table is NOT comparable, and the fold
     *  refuses to compare it rather than inventing a length: `lifetime` has no term and
     *  `weekly` is not a whole number of months. */
    val PACKAGE_MONTHS: Map<String, Int> = linkedMapOf(
        "annual" to 12, "six_month" to 6, "three_month" to 3, "two_month" to 2, "monthly" to 1,
    )

    data class Package(val id: String, val type: String = "unknown", val price: Double = 0.0)

    data class Fold(val order: List<String>, val defaultId: String, val badgeId: String, val savings: Int)

    private fun rank(type: String): Int {
        val index = PACKAGE_ORDER.indexOf(type.trim())
        return if (index < 0) PACKAGE_ORDER.size else index
    }

    /**
     * Order a paywall's packages and pick its default and its badge.
     *
     * The saving is computed against the MONTHLY package because that is the comparison a
     * buyer makes, and only where the term is a whole number of months. With no monthly
     * package there is nothing honest to compare against, so there is no badge: a "save 40%"
     * against a price the store does not offer is the dark pattern this fold exists to not
     * ship.
     */
    fun fold(packages: List<Package>, selected: String? = null): Fold {
        val rows = packages.filter { it.id.isNotEmpty() }
        val ranked = rows.withIndex().sortedWith(
            compareBy({ rank(it.value.type) }, { it.value.id }, { it.index }),
        ).map { it.value }
        val order = ranked.map { it.id }

        val sel = selected?.trim().orEmpty()
        val annual = ranked.firstOrNull { it.type == "annual" }
        val defaultId = when {
            order.contains(sel) -> sel
            annual != null -> annual.id
            else -> order.firstOrNull().orEmpty()
        }

        val base = ranked.firstOrNull { it.type == "monthly" }?.price ?: 0.0
        var badgeId = ""
        var savings = 0
        if (base > 0.0) {
            for (row in ranked) {
                val months = PACKAGE_MONTHS[row.type.trim()] ?: continue
                if (months <= 1 || row.price <= 0.0) continue
                val saving = floor((1.0 - row.price / months / base) * 100.0 + 0.5).toInt()
                if (saving > savings) {
                    savings = saving
                    badgeId = row.id
                }
            }
        }
        return Fold(order, defaultId, badgeId, savings)
    }
}

// -- 5 - THE SIGN-IN LADDER: one step of a vendor auth attempt, inline --------------------

object VendorSignIn {

    /** Strategy display order. A password field beats a code the user has to go and fetch,
     *  and a passkey beats both where the device has one. */
    val STRATEGY_ORDER: List<String> = listOf(
        "passkey", "password", "email_code", "phone_code", "email_link", "reset_password_email_code",
    )

    val STEPS: List<String> = listOf(
        "identifier", "first_factor", "second_factor", "new_password", "requirements", "complete", "restart",
    )

    data class Ladder(
        val step: String,
        val fields: List<String>,
        val strategies: List<String>,
        val terminal: Boolean,
        val code: String,
    )

    private fun order(raw: List<String>): List<String> {
        val seen = ArrayList<String>()
        for (s in raw) {
            val name = s.trim()
            if (name.isNotEmpty() && !seen.contains(name)) seen.add(name)
        }
        val known = seen.filter { STRATEGY_ORDER.contains(it) }.sortedBy { STRATEGY_ORDER.indexOf(it) }
        val rest = seen.filter { !STRATEGY_ORDER.contains(it) }.sorted()
        return known + rest
    }

    /**
     * One rung of a vendor sign-in attempt, as an inline component renders it.
     *
     * The vendor owns the attempt; this decides only what is on screen for the status the
     * vendor last reported. An UNKNOWN status is a restart with a code rather than a blank
     * screen: a vendor that adds a status next quarter must degrade to "start again", which
     * is recoverable, and never to a form with no fields, which is not.
     */
    fun ladder(status: String?, strategies: List<String> = emptyList(), missing: List<String> = emptyList()): Ladder {
        val ordered = order(strategies)
        fun done(step: String, fields: List<String>, terminal: Boolean = false, code: String = "") =
            Ladder(step, fields, ordered, terminal, code)

        return when (status?.trim()) {
            "needs_identifier" -> done("identifier", listOf("identifier"))
            "needs_first_factor" -> done("first_factor", if (ordered.contains("password")) listOf("password") else listOf("code"))
            "needs_second_factor" -> done("second_factor", listOf("code"))
            "needs_new_password" -> done("new_password", listOf("password", "confirmation"))
            "missing_requirements" -> {
                val fields = missing.map { it.trim() }.filter { it.isNotEmpty() }
                done("requirements", fields.ifEmpty { listOf("identifier") })
            }
            "complete" -> done("complete", emptyList(), terminal = true)
            "abandoned" -> done("restart", emptyList(), terminal = true)
            else -> done("restart", emptyList(), terminal = false, code = "unknown_status")
        }
    }
}

// -- 6 - THE SCAN GATE: a live camera emits the same code sixty times a second ------------

object VendorScan {

    const val DEFAULT_DEBOUNCE_MS = 1500L

    val REASONS: List<String> = listOf(
        "empty", "format_filtered", "duplicate_settled", "first", "changed", "repeat_debounced", "repeat",
    )

    data class Gate(val emit: Boolean, val reason: String)

    /**
     * Whether a decoded frame becomes an event.
     *
     * A live preview hands the same payload to the analyzer on every frame. Without this an
     * `on:scan` handler that pushes a route fires thirty times before the transition starts,
     * which is the bug every camera integration ships once. The order below is the law: an
     * unwanted FORMAT is filtered before the mode is consulted, so a barcode in a QR-only
     * surface never settles a `once` scanner and leaves it deaf to the code it wanted.
     */
    fun gate(
        value: String,
        format: String = "",
        at: Long = 0,
        formats: List<String> = emptyList(),
        mode: String = "once",
        debounceMs: Long = DEFAULT_DEBOUNCE_MS,
        lastValue: String = "",
        lastAt: Long = 0,
        emitted: Boolean = false,
    ): Gate {
        if (value.isEmpty()) return Gate(false, "empty")
        val wanted = formats.map { it.trim() }.filter { it.isNotEmpty() }
        if (wanted.isNotEmpty() && !wanted.contains(format.trim())) return Gate(false, "format_filtered")
        if (mode == "once" && emitted) return Gate(false, "duplicate_settled")
        if (lastValue.isEmpty()) return Gate(true, "first")
        if (value != lastValue) return Gate(true, "changed")
        return if (at - lastAt < debounceMs) Gate(false, "repeat_debounced") else Gate(true, "repeat")
    }
}
