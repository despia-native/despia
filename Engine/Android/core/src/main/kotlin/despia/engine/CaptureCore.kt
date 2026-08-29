//
//  CaptureCore.kt - the shared `capture` module core (:core, pure JVM): the format fold,
//  scale resolution, the pixel budget and the PDF page geometry. The law is the corpus,
//  OpenSource/Conformance/capture/ (parity/F11-capture.md). The twin of the web
//  @despia-native/kernel capture-core.ts and of Swift CaptureCore.
//
//  WHY THESE PARTS AND NOT THE RASTERISING. Turning a view into pixels is platform work
//  (View.draw, PixelCopy, PdfDocument) and belongs in the module facet. What cannot live
//  there is the ARITHMETIC: an OG card asked for at 1200x630 must come out at exactly
//  1200x630 on every renderer, and the guard that refuses a 20000x20000 request before the
//  device tries to allocate it has to trip at the same point everywhere.
//
package despia.engine

import kotlin.math.abs
import kotlin.math.roundToLong

object CaptureCore {

    /** The raster formats. webp is offered because it is half the bytes of a png for a share
     *  card, and refused honestly where a platform cannot write it. */
    val FORMATS: List<String> = listOf("png", "jpeg", "webp")

    /** The pixel budget for one capture: roughly a 6300x6300 square, or 8000x5000. Larger
     *  than any share card, poster or receipt, and far below where a phone dies allocating
     *  the bitmap. A request past it is `too_large` BEFORE any allocation, which is the
     *  difference between an error and a crash. */
    const val MAX_PIXELS: Long = 40_000_000L

    /** Named page boxes in PostScript points (72 per inch). */
    val PDF_PAGE_SIZES: Map<String, Pair<Double, Double>> = linkedMapOf(
        "a3" to (841.89 to 1190.55),
        "a4" to (595.28 to 841.89),
        "a5" to (419.53 to 595.28),
        "letter" to (612.0 to 792.0),
        "legal" to (612.0 to 1008.0),
        "tabloid" to (792.0 to 1224.0),
    )

    /** Fold an author's format spelling; null is `unsupported_format`. */
    fun foldFormat(name: String?): String? {
        val key = (name ?: "").trim().lowercase().removePrefix(".")
        if (key.isEmpty()) return "png"
        if (key == "jpg") return "jpeg"
        return if (FORMATS.contains(key)) key else null
    }

    /** Clamp a quality argument into 0..1, reading a value above 1 as a percent because
     *  everyone confuses the two exactly once. */
    fun quality(value: Any?, fallback: Double = 0.9): Double {
        if (value == null || value == "") return fallback
        val raw = when (value) {
            is Number -> value.toDouble()
            is String -> value.toDoubleOrNull() ?: return fallback
            else -> return fallback
        }
        if (raw.isNaN() || raw.isInfinite()) return fallback
        val unit = if (raw > 1.0 && raw <= 100.0) raw / 100.0 else raw
        return unit.coerceIn(0.0, 1.0)
    }

    sealed class ScaleResult {
        data class Value(val scale: Double) : ScaleResult()
        data class Refused(val code: String) : ScaleResult()
    }

    /** Resolve `scale`. A number is a multiplier; `device` (and an omitted value) is the
     *  surface's own pixel ratio. Zero, negative and non-numeric are refusals rather than a
     *  silent 1. */
    fun resolveScale(scale: Any?, deviceScale: Double): ScaleResult {
        val device = if (deviceScale.isFinite() && deviceScale > 0) deviceScale else 1.0
        if (scale == null || scale == "" || scale == "device") return ScaleResult.Value(device)
        val raw = when (scale) {
            is Number -> scale.toDouble()
            is String -> scale.toDoubleOrNull() ?: return ScaleResult.Refused("invalid_scale")
            else -> return ScaleResult.Refused("invalid_scale")
        }
        if (!raw.isFinite() || raw <= 0.0 || raw > 16.0) return ScaleResult.Refused("invalid_scale")
        return ScaleResult.Value(raw)
    }

    sealed class SizeResult {
        data class Value(val width: Int, val height: Int) : SizeResult()
        data class Refused(val code: String) : SizeResult()
    }

    private fun round(value: Double): Long {
        val scaled = abs(value).roundToLong()
        return if (value < 0) -scaled else scaled
    }

    /** Point size times scale, rounded to whole pixels per axis, checked against the budget. */
    fun pixelSize(pointWidth: Double, pointHeight: Double, scale: Double,
                  maxPixels: Long = MAX_PIXELS): SizeResult {
        if (!pointWidth.isFinite() || !pointHeight.isFinite() || !scale.isFinite()) {
            return SizeResult.Refused("invalid_size")
        }
        if (pointWidth <= 0.0 || pointHeight <= 0.0 || scale <= 0.0) return SizeResult.Refused("invalid_size")
        val width = round(pointWidth * scale)
        val height = round(pointHeight * scale)
        if (width < 1 || height < 1) return SizeResult.Refused("invalid_size")
        if (width * height > maxPixels) return SizeResult.Refused("too_large")
        return SizeResult.Value(width.toInt(), height.toInt())
    }

    sealed class PageResult {
        data class Value(val width: Double, val height: Double) : PageResult()
        data class Refused(val code: String) : PageResult()
    }

    /** A name from the table, `name/landscape` to swap the axes, or an explicit
     *  `{ width, height }` in points. An unknown name is a refusal, not a fallback to A4: a
     *  document silently printed at the wrong size is worse than one that did not print. */
    fun pageSize(spec: Any?): PageResult {
        if (spec == null || spec == "") {
            val (width, height) = PDF_PAGE_SIZES.getValue("a4")
            return PageResult.Value(width, height)
        }
        if (spec is Map<*, *>) {
            val width = (spec["width"] as? Number)?.toDouble() ?: return PageResult.Refused("invalid_page_size")
            val height = (spec["height"] as? Number)?.toDouble() ?: return PageResult.Refused("invalid_page_size")
            if (width <= 0.0 || height <= 0.0) return PageResult.Refused("invalid_page_size")
            return PageResult.Value(width, height)
        }
        val text = spec.toString().trim().lowercase()
        val landscape = text.endsWith("/landscape") || text.endsWith(" landscape")
        val name = text.removeSuffix("/landscape").removeSuffix(" landscape").trim()
        val found = PDF_PAGE_SIZES[name] ?: return PageResult.Refused("invalid_page_size")
        return if (landscape) PageResult.Value(found.second, found.first)
               else PageResult.Value(found.first, found.second)
    }

    data class Margins(val top: Double, val right: Double, val bottom: Double, val left: Double)

    /** A bare number is all four sides; an object fills the sides it names and defaults the
     *  rest to the same 36 points (half an inch) an omission gets. */
    fun margins(spec: Any?, fallback: Double = 36.0): Margins {
        fun of(value: Any?, or: Double): Double {
            val raw = when (value) {
                is Number -> value.toDouble()
                is String -> value.toDoubleOrNull() ?: return or
                else -> return or
            }
            return if (raw.isFinite() && raw >= 0.0) raw else or
        }
        if (spec is Number || spec is String) {
            val all = of(spec, fallback)
            return Margins(all, all, all, all)
        }
        if (spec is Map<*, *>) {
            return Margins(of(spec["top"], fallback), of(spec["right"], fallback),
                           of(spec["bottom"], fallback), of(spec["left"], fallback))
        }
        return Margins(fallback, fallback, fallback, fallback)
    }
}
