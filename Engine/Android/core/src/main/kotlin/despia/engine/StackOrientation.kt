//
//  StackOrientation.kt - the shared lockOrientation= / orientation-module core (:core, pure
//  JVM): the vocabulary fold + the claim stack. The law is the corpus:
//  OpenSource/Conformance/input/orientation.json (parity/F07-orientation.md). The twin of
//  Swift StackOrientation and the web @despia-native/kernel resolveOrientation/OrientationClaimStack.
//
//  Everything platform-shaped lives OUTSIDE this file: the Orientation module applies the
//  resolved mask through Activity.requestedOrientation (Android) /
//  UIWindowScene.requestGeometryUpdate (iOS) / screen.orientation.lock (web), and the router
//  drives claim/release off surface appear/disappear. Keeping the DECISION separate from the
//  PLUMBING is what lets one corpus judge three renderers.
//
package despia.engine

object StackOrientation {

    /** The canonical order every resolved mask is emitted in, regardless of the order the
     *  app declared its supported orientations. Stable order = a stable `primary`. */
    val CANONICAL: List<String> = listOf("portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight")

    /** A resolved lock: the full mask the platform is asked to allow, and the orientation the
     *  device rotates TO (the first surviving entry in canonical order). */
    data class Resolved(val mask: List<String>, val primary: String)

    /** Why a fold refused. Both are LOUD - a lock that silently no-ops is the hardest
     *  orientation bug there is. */
    enum class Refusal { UNKNOWN_ORIENTATION, NOT_ALLOWED }

    /** The stable machine ids the module reports and the corpus pins. */
    fun code(refusal: Refusal): String = when (refusal) {
        Refusal.UNKNOWN_ORIENTATION -> "unknown_orientation"
        Refusal.NOT_ALLOWED -> "not_allowed"
    }

    /**
     * Fold one `to` word against the app's build-time allowed set.
     *
     * `to` is exact-case after trimming - `Portrait` is not `portrait`, because a
     * case-insensitive vocabulary is a vocabulary nobody can lint. `landscape` expands to both
     * landscape orientations, `all` to the whole allowed set, `current` to the live
     * orientation. The expansion is then intersected with `allowed` in CANONICAL order; an
     * empty intersection is NOT_ALLOWED rather than a silent no-op.
     */
    fun resolve(to: String?, allowed: List<String>, current: String? = null): Result<Resolved> {
        val word = to?.trim().orEmpty()
        val expanded: List<String> = when {
            word.isEmpty() -> return Result.failure(RefusalError(Refusal.UNKNOWN_ORIENTATION))
            word == "all" -> CANONICAL
            word == "landscape" -> listOf("landscapeLeft", "landscapeRight")
            word == "current" -> listOfNotNull(current?.trim()?.takeIf { it in CANONICAL })
            word in CANONICAL -> listOf(word)
            else -> return Result.failure(RefusalError(Refusal.UNKNOWN_ORIENTATION))
        }
        val permitted = allowed.mapNotNull { it.trim().takeIf { t -> t in CANONICAL } }.toSet()
        val mask = CANONICAL.filter { it in expanded && it in permitted }
        if (mask.isEmpty()) return Result.failure(RefusalError(Refusal.NOT_ALLOWED))
        return Result.success(Resolved(mask, mask.first()))
    }

    /** Carries a [Refusal] out of [resolve] without allocating a stack trace per call. */
    class RefusalError(val refusal: Refusal) : Exception(code(refusal)) {
        override fun fillInStackTrace(): Throwable = this
    }
}

/**
 * The claim stack - the actual feature behind `lockOrientation=`.
 *
 * A surface claims on appear and releases on disappear, so every dismissal path (button pop,
 * edge-swipe back, modal drag-dismiss, deep-link stack replacement, a backgrounded app
 * returning) reverts through ONE funnel instead of each screen remembering to undo itself.
 *
 * The effective lock is the LAST live entry, or null for the app default. A re-claim by a live
 * id replaces in place, so a screen re-declaring can never jump above a sheet it presented.
 * Releasing a mid-stack entry leaves the top standing.
 */
class OrientationClaimStack {

    private data class Claim(val id: String, var to: String)

    private val claims = ArrayList<Claim>()

    /** The `to` word currently in force, or null when nothing is claimed. */
    val effective: String? get() = claims.lastOrNull()?.to

    /** Claim (or re-claim, in place) for [id]. Returns the new [effective]. */
    fun claim(id: String, to: String): String? {
        val existing = claims.firstOrNull { it.id == id }
        if (existing != null) existing.to = to else claims.add(Claim(id, to))
        return effective
    }

    /** Release [id]. Unknown ids are a no-op - a surface may release without ever claiming. */
    fun release(id: String): String? {
        claims.removeAll { it.id == id }
        return effective
    }

    /** Drop every claim - the deep-link-replaces-the-stack path. */
    fun reset(): String? {
        claims.clear()
        return effective
    }

    /** The imperative `orientation.unlock()` slot, so the module and the attribute share one stack. */
    companion object { const val IMPERATIVE_ID: String = "imperative" }
}
