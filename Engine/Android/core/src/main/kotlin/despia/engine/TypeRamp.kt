package despia.engine

/**
 * THE TYPE RAMP'S ANDROID COLUMN.
 *
 * `Conformance/defaults/type.json` ratifies twelve roles and fills in one column per target.
 * The Android column holds Material 3 typography ROLE NAMES, not numbers, and that is the
 * whole point: a role tracks the Material scale and the user's font-size setting, where a
 * frozen sp value would not. `<text type="label">` therefore resolves to `labelLarge` here
 * and to `--dsx-type-label-*` on web, and neither renderer is copying the other's value.
 *
 * This lives in :core rather than beside the composable so the mapping is testable without
 * an Android SDK: `TypeRampConformanceTest` reads the corpus and fails on any disagreement,
 * which is the only thing keeping the three columns one ramp.
 */
object TypeRamp {
    /** Corpus role -> Material 3 typography role, the `android` column of type.json. */
    val MATERIAL: Map<String, String> = linkedMapOf(
        "display" to "displaySmall",
        "title1" to "headlineMedium",
        "title2" to "headlineSmall",
        "title3" to "titleLarge",
        "headline" to "titleMedium",
        "body" to "bodyLarge",
        "reading" to "bodyLarge",
        "callout" to "bodyMedium",
        "footnote" to "bodySmall",
        "label" to "labelLarge",
        "caption" to "labelSmall",
        "caption2" to "labelSmall",
    )

    /** The Material role for an authored word, or null when the word is not a rung. An
     *  unknown word resolves to nothing rather than to a guess: the element then keeps the
     *  body default, which is what a typo should look like. */
    fun material(role: String?): String? = MATERIAL[role?.trim()]
}
