//
//  StackFonts.kt - the shared font FACE-SELECTION core (:core, pure JVM). The law is the corpus:
//  OpenSource/Conformance/fonts/matching.json (parity/F01-fonts.md). The twin of Swift StackFonts
//  and the web @despia-native/kernel fonts.ts.
//
//  WHAT LIVES HERE: given a family's declared faces and a requested weight/italic, which face
//  renders - plus variable-axis clamping and the fontVariation/fontFeature string parsers. All
//  pure, all corpus-pinned, because a heading that comes out semibold on iOS and bold on Android
//  is precisely the drift one shared core exists to prevent.
//
//  WHAT LIVES OUTSIDE: loading the bytes, registering the face, and applying the result
//  (ResourcesCompat.getFont / Compose FontFamily). The build extracts each face's PostScript
//  name, which is the value the platform actually wants and almost never the family name.
//
package despia.engine

object StackFonts {

    /** One declared face of a family. */
    data class Face(
        val weight: Int,
        val italic: Boolean,
        val file: String? = null,
        val postscriptName: String? = null,
    )

    /** The face that will render, and whether the renderer must slant it itself. */
    data class Selection(val face: Face, val synthesized: Boolean)

    /**
     * The CSS Fonts 4 weight-matching algorithm, over the weights available in one slant set.
     *
     * Deliberately NOT "nearest weight". In the 400-500 band the search goes UP to 500 first,
     * which is why a family shipping 400 and 700 renders 400 for a requested 500 and 700 for a
     * requested 501. Implementing the intuitive nearest-neighbour rule instead is the single most
     * common way a type ramp comes out wrong.
     */
    fun matchWeight(available: List<Int>, desired: Int): Int? {
        if (available.isEmpty()) return null
        if (desired in available) return desired

        val lower = available.filter { it < desired }.maxOrNull()
        val higher = available.filter { it > desired }.minOrNull()

        if (desired in 400..500) {
            val inBand = available.filter { it in desired..500 }
            if (inBand.isNotEmpty()) return inBand.min()
            if (lower != null) return lower
            return available.filter { it > 500 }.minOrNull()
        }
        return if (desired < 400) lower ?: higher else higher ?: lower
    }

    /**
     * Pick the face for a requested weight + slant.
     *
     * An exact slant match always wins, and the weight search runs WITHIN that slant set rather
     * than across both. Italic asked for with no italic face falls back to the matched upright and
     * reports `synthesized`. Upright asked for with only italic available uses the italic face
     * rather than refusing: a rendered wrong slant beats no text at all.
     */
    fun selectFace(faces: List<Face>, weight: Int, italic: Boolean): Selection? {
        val preferred = faces.filter { it.italic == italic }
        val pool = if (preferred.isNotEmpty()) preferred else faces.filter { it.italic != italic }
        if (pool.isEmpty()) return null
        val matched = matchWeight(pool.map { it.weight }, weight) ?: return null
        val face = pool.firstOrNull { it.weight == matched } ?: return null
        return Selection(face, preferred.isEmpty() && italic)
    }

    /** The resolved axis set, plus what the family refused and why. Both reports are SORTED. */
    data class VariationResolution(
        val applied: Map<String, Double>,
        val clamped: List<String>,
        val dropped: List<String>,
    )

    /**
     * Parse a `fontVariation` string: `"wght 480, SOFT 40"`. Axis tags are case sensitive because
     * OpenType defines them that way. A malformed pair is dropped and the rest survive - one typo
     * should not silently discard a whole declaration.
     */
    fun parseVariation(input: String?): Map<String, Double> {
        val out = LinkedHashMap<String, Double>()
        for (chunk in (input ?: "").split(",")) {
            val parts = chunk.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (parts.size != 2) continue
            val value = parts[1].toDoubleOrNull() ?: continue
            if (!value.isFinite()) continue
            out[parts[0]] = value
        }
        return out
    }

    /** Clamp requested axes against what the family declares. A static family drops every axis. */
    fun resolveVariation(
        declared: Map<String, Pair<Double, Double>>?,
        requested: Map<String, Double>,
    ): VariationResolution {
        val applied = LinkedHashMap<String, Double>()
        val clamped = ArrayList<String>()
        val dropped = ArrayList<String>()
        for ((tag, value) in requested) {
            val range = declared?.get(tag)
            if (range == null) { dropped.add(tag); continue }
            when {
                value < range.first -> { applied[tag] = range.first; clamped.add(tag) }
                value > range.second -> { applied[tag] = range.second; clamped.add(tag) }
                else -> applied[tag] = value
            }
        }
        return VariationResolution(applied, clamped.sorted(), dropped.sorted())
    }

    /**
     * Parse a `fontFeature` string: `"tnum, ss01"`. An OpenType feature tag is exactly four
     * characters; anything else is a typo and is dropped rather than passed to the platform, which
     * would ignore it silently. Duplicates collapse and the first position wins.
     */
    fun parseFeatures(input: String?): List<String> {
        val out = ArrayList<String>()
        for (chunk in (input ?: "").split(",")) {
            val tag = chunk.trim()
            if (tag.length != 4) continue
            if (tag !in out) out.add(tag)
        }
        return out
    }
}
