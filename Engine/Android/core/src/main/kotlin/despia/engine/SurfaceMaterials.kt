package despia.engine

/**
 * The `surface=` material ladder, shared by the two Compose lanes.
 *
 * iOS renders these tokens as REAL materials (Liquid Glass on 26+, the `.thinMaterial` family
 * below) and the web renders them as a frosted `backdrop-filter`. Neither Compose target has a
 * backdrop primitive - `Modifier.blur` blurs an element's OWN content, not what is behind it -
 * so on both of them a token degrades to a translucent fill, and the only thing that separates
 * `ultraThin` from `thick` is how much of the background it lets through.
 *
 * That number therefore IS the token's meaning here, and it lives in one place because
 * :render and :desktop paint the same word and were carrying two copies of the table. They had
 * already drifted in the way copies do: neither read the theme, so both painted a dark slab in
 * a light app.
 */
object SurfaceMaterials {

    /** The six tokens `surface=` accepts, in catalog order (thinnest to thickest, then sheet). */
    val TOKENS: List<String> = listOf("glass", "ultraThin", "thin", "regular", "thick", "sheet")

    /**
     * How opaque a token paints. An unknown token reads as `ultraThin`, which is what the Swift
     * `material(_:)` default does with it - including `sheet`, deliberately: a sheet is a
     * surface the platform draws chrome on, not a heavier scrim.
     */
    fun alpha(token: String): Float = when (token) {
        "thin" -> 0.70f
        "regular" -> 0.82f
        "thick" -> 0.90f
        else -> 0.55f
    }

    /**
     * The theme-less fallback fill, kept for hosts where no theme has composed (plain-JVM
     * tests, pre-theme boot). It is the pinned iOS-dark approximation this ladder used to be
     * unconditionally, so a themeless host degrades to exactly the previous behaviour rather
     * than to something new.
     */
    const val FALLBACK_BASE: Int = 0x252525

    /**
     * `glassInteractive` - how far the surface travels under a finger, and how fast it gets
     * there.
     *
     * iOS 26 stretches the real material; neither Compose lane has a material to stretch, so both
     * paint the observable half of the response instead - the geometry. The same 0.97 the web
     * renderer and the pressable surface cards already use, landing on a 120 ms tween and
     * springing back out, which is the asymmetry that reads as something physical rather than a
     * fade.
     *
     * HERE rather than in each lane for the reason the alpha ladder is here: :render and
     * :desktop paint the same word, and two copies of a design number are two chances to answer
     * an author differently. check_renderer_constants.rb diffs this against the web spelling.
     */
    const val PRESS_SCALE: Float = 0.97f

    const val PRESS_IN_MS: Int = 120
}
