//
//  ControlsCore.kt - the U07 PURE CORE (:core, pure JVM): the gradient resolver (linear ·
//  radial · angular · mesh, with the angle convention pinned), the <gauge> value-to-arc solver,
//  the <colorpicker> hex/swatch/name folds, and the <masked> mode fold.
//
//  The law is the corpus: OpenSource/Conformance/controls/{gradients,gauge,colorpicker,masked}.json
//  (parity/U07-controls.md). The twin of Swift Engine/iOS/ControlsCore.swift and the web
//  @despia-native/kernel controls-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file - Brush/LinearGradient/CSS, the system
//  colour sheet, BlendMode/.mask()/mask-image.
//
//  THE ANGLE CONVENTION, stated once: 0deg points UP and increases CLOCKWISE. That is CSS's
//  convention; SwiftUI's UnitPoint model is unrelated and Compose's Offset model is a third
//  thing. Pinning one convention here and converting at each boundary is the only way
//  gradientAngle="135deg" looks the same on three renderers.
//
package despia.engine

object ControlsCore {

    val GRADIENT_TYPES: List<String> = listOf("linear", "radial", "angular", "mesh")

    /** The three legacy direction tokens, kept as EXACT aliases so no shipped app moves a pixel. */
    val GRADIENT_DIRECTION_ALIASES: Map<String, Double> =
        linkedMapOf("vertical" to 180.0, "horizontal" to 90.0, "diagonal" to 135.0)

    /** Neither gradientAngle nor gradientDir declared = today's behaviour: top to bottom. */
    const val GRADIENT_ANGLE_DEFAULT = 180.0

    /**
     * The colour bound. A gradient is a handful of stops; a list in the thousands is a bug or an
     * attack, and every renderer turns each colour into shader geometry. The desktop lane already
     * bounded this on its own, which made the bound a property of one renderer instead of the
     * grammar - so it lives here now, where all four read it.
     *
     * TRUNCATION rather than rejection: a bounded gradient still paints, and past sixty-four
     * stops no display can show the difference. Refusing to paint would turn a cosmetic excess
     * into a blank element.
     */
    const val MAX_GRADIENT_COLORS = 64

    data class UnitPoint(val x: Double, val y: Double)
    data class MeshPoint(val x: Double, val y: Double, val color: String)
    data class MeshGrid(val columns: Int, val rows: Int, val points: List<MeshPoint>)
    data class MeshLayer(val center: UnitPoint, val radius: Double, val color: String)

    /** The DECLARED mesh degradation: a base fill plus one radial per control point, row-major. */
    data class MeshFallback(val base: String, val layers: List<MeshLayer>)

    data class Gradient(
        val type: String,
        val colors: List<String>,
        val stops: List<Double>,
        val angle: Double,
        val start: UnitPoint,
        val end: UnitPoint,
        val center: UnitPoint,
        val radius: Double,
        /** Fewer than two colours is not a gradient; paint nothing rather than a flat band. */
        val valid: Boolean,
        val mesh: MeshGrid?,
        val meshFallback: MeshFallback?,
    )

    /** Six decimals: enough for sub-pixel placement, few enough that three languages agree. */
    private fun round6(value: Double): Double = Math.round(value * 1e6) / 1e6

    private fun clamp01(value: Double): Double = if (value < 0.0) 0.0 else if (value > 1.0) 1.0 else value

    /** `135deg` · `135` · `0.25turn` · `1.57rad` · `150grad` · a legacy direction token. */
    fun parseGradientAngle(input: Any?): Double? {
        if (input == null) return null
        val text = input.toString().trim().lowercase()
        if (text.isEmpty()) return null
        GRADIENT_DIRECTION_ALIASES[text]?.let { return it }
        val value = when {
            text.endsWith("grad") -> text.dropLast(4).toDoubleOrNull()?.times(0.9)
            text.endsWith("turn") -> text.dropLast(4).toDoubleOrNull()?.times(360.0)
            text.endsWith("deg") -> text.dropLast(3).toDoubleOrNull()
            text.endsWith("rad") -> text.dropLast(3).toDoubleOrNull()?.times(180.0)?.div(Math.PI)
            else -> text.toDoubleOrNull()
        }
        if (value == null || !value.isFinite()) return null
        return ((value % 360.0) + 360.0) % 360.0
    }

    /** The gradient axis as unit points, from the pinned angle convention. */
    fun gradientUnitPoints(angle: Double): Pair<UnitPoint, UnitPoint> {
        val radians = angle * Math.PI / 180.0
        val sine = Math.sin(radians)
        val cosine = Math.cos(radians)
        return UnitPoint(round6(0.5 - sine / 2), round6(0.5 + cosine / 2)) to
            UnitPoint(round6(0.5 + sine / 2), round6(0.5 - cosine / 2))
    }

    private fun unitScalar(token: String): Double? {
        val text = token.trim()
        if (text.isEmpty()) return null
        val value = if (text.endsWith("%")) text.dropLast(1).toDoubleOrNull()?.div(100.0)
                    else text.toDoubleOrNull()
        return if (value == null || !value.isFinite()) null else clamp01(value)
    }

    /** `gradientCenter="0.25 0.75"` / `"25% 75%"`. A single value means both axes. */
    fun parseUnitPoint(input: String?, fallback: UnitPoint): UnitPoint {
        val parts = input?.trim()?.replace(",", " ")?.split(" ")?.filter { it.isNotEmpty() } ?: emptyList()
        if (parts.size >= 2) {
            val x = unitScalar(parts[0])
            val y = unitScalar(parts[1])
            if (x != null && y != null) return UnitPoint(round6(x), round6(y))
        } else if (parts.size == 1) {
            val only = unitScalar(parts[0])
            if (only != null) return UnitPoint(round6(only), round6(only))
        }
        return fallback
    }

    /** `gradientRadius` as a fraction of the box's larger side. Default 0.5, capped at 4. */
    fun parseGradientRadius(input: Any?): Double {
        val text = (input?.toString() ?: "").trim()
        if (text.isEmpty()) return 0.5
        val value = if (text.endsWith("%")) text.dropLast(1).toDoubleOrNull()?.div(100.0)
                    else text.toDoubleOrNull()
        if (value == null || !value.isFinite() || value <= 0.0) return 0.5
        return round6(minOf(4.0, value))
    }

    /** `gradient="c1|c2|..."` - the shorthand every existing app already writes. */
    fun parseGradientColors(input: String?): List<String> {
        if (input == null) return emptyList()
        val parts = input.split("|").map { it.trim() }.filter { it.isNotEmpty() }
        return if (parts.size > MAX_GRADIENT_COLORS) parts.take(MAX_GRADIENT_COLORS) else parts
    }

    /**
     * `gradientStops` - positions matching the colour list. A COUNT MISMATCH FALLS BACK TO EVEN
     * SPACING rather than guessing which colour lost its stop: a gradient that silently reorders
     * itself when the author adds a colour is worse than one that ignores the attribute.
     * Values are clamped to 0..1 and forced monotonically non-decreasing.
     */
    fun parseGradientStops(input: String?, count: Int): List<Double> {
        if (count == 0) return emptyList()
        if (count == 1) return listOf(0.0)
        val even = (0 until count).map { round6(it.toDouble() / (count - 1)) }
        val text = input?.trim().orEmpty()
        if (text.isEmpty()) return even
        val raw = text.replace("|", ",").split(",").map { it.trim() }.filter { it.isNotEmpty() }
        if (raw.size != count) return even
        val stops = ArrayList<Double>(count)
        var previous = 0.0
        for (token in raw) {
            val value = if (token.endsWith("%")) token.dropLast(1).toDoubleOrNull()?.div(100.0)
                        else token.toDoubleOrNull()
            if (value == null || !value.isFinite()) return even
            val monotonic = maxOf(previous, clamp01(value))
            previous = monotonic
            stops.add(round6(monotonic))
        }
        return stops
    }

    /**
     * `gradientPoints` - the mesh control grid. Rows are `;`-separated, points `,`-separated,
     * each point `x y color`. The grid must be rectangular and at least 2x2; anything else
     * returns null and the caller degrades to a linear gradient rather than painting a blank.
     */
    fun parseMeshPoints(input: String?): MeshGrid? {
        val text = input?.trim().orEmpty()
        if (text.isEmpty()) return null
        val grid = ArrayList<List<MeshPoint>>()
        for (rowText in text.split(";")) {
            if (rowText.trim().isEmpty()) continue
            val row = ArrayList<MeshPoint>()
            for (cell in rowText.split(",").filter { it.trim().isNotEmpty() }) {
                val parts = cell.trim().split(" ").filter { it.isNotEmpty() }
                if (parts.size < 3) return null
                val x = parts[0].toDoubleOrNull() ?: return null
                val y = parts[1].toDoubleOrNull() ?: return null
                if (!x.isFinite() || !y.isFinite()) return null
                row.add(MeshPoint(round6(clamp01(x)), round6(clamp01(y)),
                    parts.subList(2, parts.size).joinToString(" ").trim()))
            }
            grid.add(row)
        }
        if (grid.size < 2) return null
        val columns = grid[0].size
        if (columns < 2) return null
        for (row in grid) if (row.size != columns) return null
        return MeshGrid(columns, grid.size, grid.flatten())
    }

    /**
     * The declared mesh degradation, used by every target that cannot draw a real mesh (Android,
     * the web, and iOS below 18): one radial per control point over a base fill, painted
     * row-major. The base is the control point nearest the centre, chosen by index so it is
     * deterministic.
     */
    fun meshFallbackLayers(mesh: MeshGrid): MeshFallback {
        val spread = maxOf(1.0 / (mesh.columns - 1), 1.0 / (mesh.rows - 1))
        val radius = round6(0.75 * spread)
        val baseIndex = (mesh.rows / 2) * mesh.columns + (mesh.columns / 2)
        return MeshFallback(
            base = mesh.points[baseIndex].color,
            layers = mesh.points.map { MeshLayer(UnitPoint(it.x, it.y), radius, it.color) },
        )
    }

    /** Fold every gradient attribute into the one descriptor each renderer paints from. */
    fun resolveGradient(
        gradient: String? = null,
        gradientType: String? = null,
        gradientStops: String? = null,
        gradientAngle: Any? = null,
        gradientDir: String? = null,
        gradientCenter: String? = null,
        gradientRadius: Any? = null,
        gradientPoints: String? = null,
    ): Gradient {
        var colors = parseGradientColors(gradient)
        val typeWord = gradientType?.trim().orEmpty()
        var type = if (typeWord in GRADIENT_TYPES) typeWord else "linear"
        val angle = parseGradientAngle(gradientAngle) ?: parseGradientAngle(gradientDir) ?: GRADIENT_ANGLE_DEFAULT

        val mesh = if (type == "mesh") parseMeshPoints(gradientPoints) else null
        if (type == "mesh" && mesh == null) type = "linear"
        if (type == "mesh" && mesh != null) colors = mesh.points.map { it.color }

        val stops = parseGradientStops(gradientStops, colors.size)
        val axis = gradientUnitPoints(angle)
        return Gradient(
            type = type,
            colors = colors,
            stops = stops,
            angle = round6(angle),
            start = axis.first,
            end = axis.second,
            center = parseUnitPoint(gradientCenter, UnitPoint(0.5, 0.5)),
            radius = parseGradientRadius(gradientRadius),
            valid = colors.size >= 2,
            mesh = mesh,
            meshFallback = mesh?.let { meshFallbackLayers(it) },
        )
    }

    data class GaugeMetrics(
        val arcStart: Double,
        val arcSweep: Double,
        val thickness: Double,
        val showsCurrentLabel: Boolean,
        val showsBoundLabels: Boolean,
    )

    /** The circular arc starts at 225 and sweeps 270, leaving the 90-degree gap at the bottom
     *  that makes a gauge read as a gauge and not as a progress ring. */
    val GAUGE_STYLES: Map<String, GaugeMetrics> = linkedMapOf(
        "circular" to GaugeMetrics(225.0, 270.0, 6.0, true, true),
        "accessoryCircular" to GaugeMetrics(225.0, 270.0, 4.0, true, false),
        "linear" to GaugeMetrics(0.0, 0.0, 6.0, true, true),
        "accessoryLinear" to GaugeMetrics(0.0, 0.0, 4.0, false, false),
    )

    data class GaugeAccessibility(
        val role: String, val min: Double, val max: Double,
        val now: Double, val percent: Int, val valueText: String,
    )

    data class Gauge(
        val style: String,
        val fraction: Double,
        val clampedValue: Double,
        val arcStart: Double,
        val arcSweep: Double,
        val valueAngle: Double,
        val thickness: Double,
        val showsCurrentLabel: Boolean,
        val showsBoundLabels: Boolean,
        val a11y: GaugeAccessibility,
    )

    private fun finite(value: Double?, fallback: Double): Double =
        if (value != null && value.isFinite()) value else fallback

    /** How the raw value reads aloud when no currentLabel is given. Integers lose the `.0`. */
    private fun defaultValueText(value: Double): String =
        if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()

    /**
     * <gauge> - value to arc, plus the meter semantics that are contract, not follow-up. An
     * inverted or empty range resolves to fraction 0 rather than NaN, because a gauge that
     * renders nothing is recoverable and one that renders garbage is not.
     */
    fun resolveGauge(
        value: Double?, min: Double? = 0.0, max: Double? = 1.0,
        style: String? = null, currentLabel: String? = null,
    ): Gauge {
        val word = style?.trim().orEmpty()
        val resolvedStyle = if (GAUGE_STYLES.containsKey(word)) word else "circular"
        val metrics = GAUGE_STYLES.getValue(resolvedStyle)
        val v = finite(value, 0.0)
        val lo = finite(min, 0.0)
        val hi = finite(max, 1.0)
        val fraction = if (hi <= lo) 0.0 else clamp01((v - lo) / (hi - lo))
        val clamped = minOf(maxOf(v, lo), hi)
        val valueAngle = (((metrics.arcStart + fraction * metrics.arcSweep) % 360.0) + 360.0) % 360.0
        val label = currentLabel?.trim().orEmpty()
        return Gauge(
            style = resolvedStyle,
            fraction = round6(fraction),
            clampedValue = round6(clamped),
            arcStart = metrics.arcStart,
            arcSweep = metrics.arcSweep,
            valueAngle = round6(valueAngle),
            thickness = metrics.thickness,
            showsCurrentLabel = metrics.showsCurrentLabel,
            showsBoundLabels = metrics.showsBoundLabels,
            a11y = GaugeAccessibility(
                role = "meter", min = round6(lo), max = round6(hi), now = round6(clamped),
                percent = Math.round(fraction * 100).toInt(),
                valueText = if (label.isEmpty()) defaultValueText(v) else label,
            ),
        )
    }

    data class GaugeTintSegment(val fromIndex: Int, val toIndex: Int, val t: Double)

    /**
     * The value-following tint: which two colours of tint="a|b|c" the needle sits between, and
     * how far. Colour RESOLUTION is per-renderer (tokens differ), so the core returns indices and
     * an interpolation factor and lets each target mix in its own colour space.
     */
    fun gaugeTintSegment(colors: List<String>, stops: List<Double>, fraction: Double): GaugeTintSegment? {
        if (colors.isEmpty()) return null
        if (colors.size == 1) return GaugeTintSegment(0, 0, 0.0)
        val value = clamp01(fraction)
        for (index in 0 until stops.size - 1) {
            val low = stops[index]
            val high = stops[index + 1]
            if (value <= high || index == stops.size - 2) {
                val span = high - low
                return GaugeTintSegment(index, index + 1,
                    round6(clamp01(if (span <= 0.0) 0.0 else (value - low) / span)))
            }
        }
        return GaugeTintSegment(colors.size - 2, colors.size - 1, 1.0)
    }

    data class Rgba(val r: Int, val g: Int, val b: Int, val a: Int)

    /** The pinned name table the picker announces from. Small on purpose: a screen reader saying
     *  "cornflower blue" is not more useful than "blue", and a big table is a big disagreement. */
    val COLOR_NAMES: List<Pair<String, String>> = listOf(
        "black" to "#000000", "white" to "#FFFFFF", "gray" to "#808080", "silver" to "#C0C0C0",
        "red" to "#FF0000", "maroon" to "#800000", "orange" to "#FFA500", "brown" to "#A52A2A",
        "yellow" to "#FFFF00", "olive" to "#808000", "lime" to "#00FF00", "green" to "#008000",
        "teal" to "#008080", "cyan" to "#00FFFF", "blue" to "#0000FF", "navy" to "#000080",
        "indigo" to "#4B0082", "purple" to "#800080", "magenta" to "#FF00FF", "pink" to "#FFC0CB",
        "tan" to "#D2B48C", "gold" to "#FFD700", "beige" to "#F5F5DC", "turquoise" to "#40E0D0",
    )

    private const val HEX_DIGITS = "0123456789abcdef"

    /** `#RGB` · `#RGBA` · `#RRGGBB` · `#RRGGBBAA` -> channels, or null. Nothing else is a colour. */
    fun parseHexColor(input: String?): Rgba? {
        val text = input?.trim().orEmpty()
        if (!text.startsWith("#")) return null
        var body = text.substring(1).lowercase()
        for (character in body) if (!HEX_DIGITS.contains(character)) return null
        if (body.length == 3 || body.length == 4) {
            body = body.map { "$it$it" }.joinToString("")
        }
        if (body.length == 6) body += "ff"
        if (body.length != 8) return null
        return Rgba(
            body.substring(0, 2).toInt(16), body.substring(2, 4).toInt(16),
            body.substring(4, 6).toInt(16), body.substring(6, 8).toInt(16),
        )
    }

    /** Uppercase output, and the alpha pair only when it is both allowed and not opaque. */
    fun formatHexColor(color: Rgba, alphaAllowed: Boolean = false): String {
        fun pair(value: Int): String = String.format(java.util.Locale.ROOT, "%02X", value)
        val base = "#" + pair(color.r) + pair(color.g) + pair(color.b)
        return if (alphaAllowed && color.a != 255) base + pair(color.a) else base
    }

    /** Nearest name by squared sRGB distance, ties broken by table order. Deterministic on purpose. */
    fun nearestColorName(color: Rgba): String {
        var best = COLOR_NAMES[0].first
        var bestDistance = Long.MAX_VALUE
        for ((name, hex) in COLOR_NAMES) {
            val target = parseHexColor(hex)!!
            val dr = (color.r - target.r).toLong()
            val dg = (color.g - target.g).toLong()
            val db = (color.b - target.b).toLong()
            val distance = dr * dr + dg * dg + db * db
            if (distance < bestDistance) { bestDistance = distance; best = name }
        }
        return best
    }

    /** Presets shown first. Invalid entries drop, duplicates collapse, and the list caps at 24. */
    fun resolveSwatches(input: String?, alphaAllowed: Boolean = false): List<String> {
        if (input == null) return emptyList()
        val out = ArrayList<String>()
        val seen = HashSet<String>()
        for (token in input.replace("|", ",").split(",")) {
            val parsed = parseHexColor(token) ?: continue
            val text = formatHexColor(parsed, alphaAllowed)
            if (!seen.add(text)) continue
            out.add(text)
            if (out.size == 24) break
        }
        return out
    }

    val COLOR_PICKER_MODES: List<String> = listOf("wheel", "sliders", "swatches")

    /** Undeclared mode: swatches when presets exist (they are the fast path), else the wheel. */
    fun resolveColorPickerMode(mode: String?, alpha: Boolean, swatchCount: Int): String {
        val word = mode?.trim().orEmpty()
        if (word in COLOR_PICKER_MODES) return word
        return if (swatchCount > 0) "swatches" else "wheel"
    }

    /** <input type="color"> supports neither alpha nor presets, so the web ejects to its own panel. */
    fun webNeedsCustomColorPanel(alpha: Boolean, swatchCount: Int): Boolean = alpha || swatchCount > 0

    data class MaskWebLayer(val image: String, val composite: String)

    data class Mask(
        val mode: String,
        val invert: Boolean,
        /** The Compose blend mode: DstIn keeps what the mask covers, DstOut keeps what it does not. */
        val blend: String,
        val cssMaskMode: String,
        val webLayers: List<MaskWebLayer>,
        /** Always true: the mask child is decorative BY CONSTRUCTION. */
        val maskChildHidden: Boolean,
        /** Always true: <masked> changes appearance, not content. */
        val contentSemanticsPreserved: Boolean,
    )

    fun resolveMask(mode: String?, invert: Any?): Mask {
        val word = mode?.trim().orEmpty()
        val resolved = if (word == "luminance") "luminance" else "alpha"
        val inverted = invert == true || (invert?.toString()?.trim()?.lowercase() == "true")
        return Mask(
            mode = resolved,
            invert = inverted,
            blend = if (inverted) "dstOut" else "dstIn",
            cssMaskMode = resolved,
            webLayers = if (inverted)
                listOf(MaskWebLayer("opaque", "add"), MaskWebLayer("mask", "subtract"))
            else listOf(MaskWebLayer("mask", "add")),
            maskChildHidden = true,
            contentSemanticsPreserved = true,
        )
    }
}
