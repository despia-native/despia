//
//  MediaCore.kt - the shared `media` module core (:core, pure JVM): the pick plan, EXIF
//  orientation normalisation, the manipulate op-chain resolver, the decode hint that keeps a
//  12 MP photo from ever being allocated whole, and the format/quality fold with its
//  per-platform support table. The law is the corpus, OpenSource/Conformance/media/
//  (parity/F04-media.md). The twin of the web @despia/kernel media-core.ts and of Swift
//  Engine/iOS/MediaCore.swift.
//
//  WHY THESE PARTS AND NOT THE PIXELS. Opening a picker, decoding a JPEG and running a
//  Bitmap chain are entirely platform work (PickVisualMedia, BitmapFactory, Canvas) and
//  belong in the module facet. What cannot live there is the ARITHMETIC AND THE ORDER:
//
//   * crop-then-resize is not resize-then-crop, and an avatar that comes out 401 px on one
//     platform and 400 on another is a bug the author cannot fix from markup;
//   * a phone photo carries its rotation in EXIF, so a crop rect computed against the
//     stored pixels lands somewhere else than the one the user drew on screen - the
//     "sideways on one platform" bug, which is an ORDERING law, not a decoder setting;
//   * the decode hint is the difference between an error and an OOM kill: decode at the size
//     you need, never full then downscale. `sampleSize` is handed straight to
//     BitmapFactory.Options.inSampleSize, which is why it is always a power of two.
//
//  Everything here is pure arithmetic over plain values. No I/O, no platform types.
//
package despia.engine

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

object MediaCore {

    /** The raster formats `manipulate` can be asked to write. */
    val FORMATS: List<String> = listOf("jpeg", "png", "webp", "heic")

    /** The resize fits. Deliberately three: the fourth spelling everyone invents ("inside",
     *  "outside", "scale-down") is `contain` with a clamp the caller can do itself. */
    val RESIZE_FITS: List<String> = listOf("contain", "cover", "fill")

    /** The pixel budget for one manipulation step, and the one number in this file that is a
     *  POLICY rather than arithmetic. It bounds what a caller may ASK FOR - a 20000x20000
     *  render is refused before anything is allocated - and deliberately does NOT bound what
     *  the camera produced: a 48 MP ProRAW photo is over the budget the moment it is opened,
     *  and a framework that refused to rotate it would be refusing the device's own output.
     *  So the check is on GROWTH: a step is `too_large` only when it pushes past the budget
     *  AND makes the image bigger than it already was. */
    const val MAX_PIXELS: Long = 40_000_000L

    /** The ceiling on one multi-pick. A picker that hands back 400 assets has handed back an
     *  out-of-memory bug; 0 from the caller means "the system's own maximum". */
    const val PICK_MAX: Int = 64

    val PICK_TYPES: List<String> = listOf("image", "video", "any")
    val PICK_SOURCES: List<String> = listOf("library", "camera")

    /** What each renderer can actually ENCODE. `true` is unconditional, `"device"` means the
     *  hardware decides at runtime (HEIC on an older iPhone, HEIC below API 30) and the facet
     *  must ask, `false` means never. A format that cannot be written falls back to jpeg and
     *  the resolve says so rather than lying about the file it produced. */
    val FORMAT_SUPPORT: Map<String, Map<String, Any>> = linkedMapOf(
        "ios" to linkedMapOf<String, Any>("jpeg" to true, "png" to true, "webp" to false, "heic" to "device"),
        "android" to linkedMapOf<String, Any>("jpeg" to true, "png" to true, "webp" to true, "heic" to "device"),
        "web" to linkedMapOf<String, Any>("jpeg" to true, "png" to true, "webp" to true, "heic" to false),
    )

    data class Box(val width: Int, val height: Int)
    data class Rect(val x: Int, val y: Int, val width: Int, val height: Int)

    /** One resolved step of an op chain: what the image measures after it, and - for the ops
     *  that select a region (crop, and the centre-crop half of `cover`) - the exact rect, in
     *  the coordinate space of the image AS IT WAS WHEN THE STEP RAN. */
    data class Step(val op: String, val width: Int, val height: Int, val rect: Rect? = null)

    sealed class OpsResult {
        data class Value(val width: Int, val height: Int, val steps: List<Step>) : OpsResult()
        /** `error` is `invalid_ops` or `too_large`; `at` is the index of the offending op, -1
         *  when the SOURCE itself was unusable. */
        data class Refused(val error: String, val at: Int) : OpsResult()
    }

    // -- small numeric helpers -------------------------------------------------------------

    /** Round half away from zero, then floor at one pixel. Every dimension in this file goes
     *  through it so three renderers cannot disagree about 400.5. */
    private fun px(value: Double): Int {
        val rounded = if (value < 0) -floor(-value + 0.5) else floor(value + 0.5)
        return max(1, rounded.toInt())
    }

    /** JS `Math.round` exactly - floor(x + 0.5), ties toward positive infinity. Distinct from
     *  [px] on purpose: crop origins may be negative and their tie direction is pinned. */
    private fun jsRound(value: Double): Double = floor(value + 0.5)

    private fun finite(value: Any?): Double? {
        if (value == null) return null
        val raw = when (value) {
            is Number -> value.toDouble()
            is String -> if (value.isEmpty()) return null else value.trim().toDoubleOrNull() ?: return null
            else -> return null
        }
        return if (raw.isFinite()) raw else null
    }

    private fun positive(value: Any?): Double? {
        val raw = finite(value)
        return if (raw != null && raw > 0) raw else null
    }

    // -- the format / quality fold ---------------------------------------------------------

    /** Fold an author's format spelling; null is `unsupported_format`. An omitted format means
     *  "keep whatever the source was", which the facet answers, so it folds to null too - the
     *  caller distinguishes the two by whether it passed anything. */
    fun foldFormat(name: String?): String? {
        val key = (name ?: "").trim().lowercase().removePrefix(".")
        if (key.isEmpty()) return null
        if (key == "jpg") return "jpeg"
        if (key == "heif") return "heic"
        return if (FORMATS.contains(key)) key else null
    }

    /** Clamp a quality argument into 0..1, reading a value above 1 as a percent because
     *  everyone confuses the two exactly once. Identical semantics to the capture fold. */
    fun quality(value: Any?, fallback: Double = 0.9): Double {
        if (value == null || value == "") return fallback
        val raw = when (value) {
            is Number -> value.toDouble()
            is String -> value.trim().toDoubleOrNull() ?: return fallback
            else -> return fallback
        }
        if (!raw.isFinite()) return fallback
        val unit = if (raw > 1.0 && raw <= 100.0) raw / 100.0 else raw
        return min(max(unit, 0.0), 1.0)
    }

    /** png is lossless, so a quality argument against it is meaningless and is dropped rather
     *  than silently changing nothing - a caller reading the resolve sees the truth. */
    fun formatLossless(format: String): Boolean = format == "png"

    data class FormatPlan(
        val format: String,
        val requested: String,
        val fellBack: Boolean,
        val lossless: Boolean,
    )

    sealed class FormatPlanResult {
        data class Value(val plan: FormatPlan) : FormatPlanResult()
        data class Refused(val error: String) : FormatPlanResult()
    }

    /**
     * Resolve the format a facet will actually write.
     *
     * `deviceCanEncode` answers the `"device"` rows: the facet asks its platform once (is this
     * API level 30?) and passes the answer in. An unknown platform is treated as the web row,
     * which is the conservative one.
     */
    fun formatPlan(
        requested: String?,
        platform: String,
        deviceCanEncode: Boolean = false,
        fallback: String = "jpeg",
    ): FormatPlanResult {
        val format = foldFormat(requested) ?: return FormatPlanResult.Refused("unsupported_format")
        val table = FORMAT_SUPPORT[platform] ?: FORMAT_SUPPORT.getValue("web")
        val support = table[format]
        val writable = support == true || (support == "device" && deviceCanEncode)
        return if (writable) {
            FormatPlanResult.Value(FormatPlan(format, format, false, formatLossless(format)))
        } else {
            FormatPlanResult.Value(FormatPlan(fallback, format, true, formatLossless(fallback)))
        }
    }

    // -- EXIF orientation ------------------------------------------------------------------

    /** The transform that turns STORED pixels into what the photographer saw. `rotate` is
     *  clockwise degrees; `mirrored` is a horizontal flip applied BEFORE the rotation; `swaps`
     *  says whether the two axes trade places, which is the whole reason a portrait photo
     *  reports 4032x3024. */
    data class ExifTransform(val rotate: Int, val mirrored: Boolean, val swaps: Boolean)

    /**
     * The eight EXIF orientation values.
     *
     * This table is the fix for the classic bug: one platform's decoder applies the tag and
     * another hands back raw pixels, so the same crop rect selects a different region. The law
     * that makes them agree is not "everyone applies the tag" - it is that the tag is applied
     * FIRST and the op chain then runs against normalised pixels on every renderer.
     */
    val EXIF_TRANSFORMS: Map<Int, ExifTransform> = linkedMapOf(
        1 to ExifTransform(0, false, false),
        2 to ExifTransform(0, true, false),
        3 to ExifTransform(180, false, false),
        4 to ExifTransform(180, true, false),
        5 to ExifTransform(90, true, true),
        6 to ExifTransform(90, false, true),
        7 to ExifTransform(270, true, true),
        8 to ExifTransform(270, false, true),
    )

    data class Orientation(
        val orientation: Int,
        val width: Int,
        val height: Int,
        val rotate: Int,
        val mirrored: Boolean,
        val swaps: Boolean,
    )

    /**
     * Normalise stored dimensions by an EXIF orientation tag. An absent, zero or out-of-range
     * tag is orientation 1 (the identity) rather than a refusal: a file with no EXIF block is
     * ordinary, not broken.
     */
    fun exifNormalise(width: Any?, height: Any?, orientation: Any?): Orientation {
        val w = positive(width) ?: 1.0
        val h = positive(height) ?: 1.0
        val raw = finite(orientation)
        val tag = if (raw != null && raw == floor(raw) && raw >= 1 && raw <= 8) raw.toInt() else 1
        val t = EXIF_TRANSFORMS.getValue(tag)
        return Orientation(
            orientation = tag,
            width = if (t.swaps) px(h) else px(w),
            height = if (t.swaps) px(w) else px(h),
            rotate = t.rotate,
            mirrored = t.mirrored,
            swaps = t.swaps,
        )
    }

    // -- the op chain ----------------------------------------------------------------------

    private class StepResult(val width: Int, val height: Int, val rect: Rect? = null)

    @Suppress("UNCHECKED_CAST")
    private fun opEntry(op: Any?): Pair<String, Any?>? {
        val map = op as? Map<String, Any?> ?: return null
        val keys = map.keys.filter { !it.startsWith("_") }
        // Exactly one verb per entry. Two keys is an ambiguity about ORDER, and order is the
        // one thing this resolver exists to make unambiguous.
        if (keys.size != 1) return null
        val name = keys[0]
        return name to map[name]
    }

    @Suppress("UNCHECKED_CAST")
    private fun resizeStep(box: Box, spec: Any?): StepResult? {
        val s = spec as? Map<String, Any?> ?: return null
        val tw = positive(s["width"])
        val th = positive(s["height"])
        if (tw == null && th == null) return null

        val fit = (s["fit"] as? String ?: "contain").trim().lowercase()
        if (!RESIZE_FITS.contains(fit)) return null

        // One dimension given: the aspect ratio decides the other, whatever `fit` says. There
        // is no box to fit inside, so `cover` and `contain` cannot differ.
        if (tw == null) {
            val height = th!!
            return StepResult(px(box.width * (height / box.height)), px(height))
        }
        if (th == null) return StepResult(px(tw), px(box.height * (tw / box.width)))

        if (fit == "fill") return StepResult(px(tw), px(th))

        val scale = if (fit == "cover") max(tw / box.width, th / box.height)
                    else min(tw / box.width, th / box.height)
        val scaledW = px(box.width * scale)
        val scaledH = px(box.height * scale)
        if (fit == "contain") return StepResult(scaledW, scaledH)

        // cover: fill the box, then take the CENTRE of the overflow. Floor the offsets so a one
        // pixel remainder always lands on the bottom/right, identically on three renderers.
        val outW = min(px(tw), scaledW)
        val outH = min(px(th), scaledH)
        return StepResult(outW, outH, Rect((scaledW - outW) / 2, (scaledH - outH) / 2, outW, outH))
    }

    @Suppress("UNCHECKED_CAST")
    private fun cropStep(box: Box, spec: Any?): StepResult? {
        val s = spec as? Map<String, Any?> ?: return null
        val w = positive(s["width"]) ?: return null
        val h = positive(s["height"]) ?: return null
        val x = finite(s["x"]) ?: 0.0
        val y = finite(s["y"]) ?: 0.0

        // A crop that hangs off the edge is INTERSECTED with the image, not refused: the caller
        // drew a rect on a screen, and a two pixel overhang from a rounding difference must not
        // lose the whole operation. A crop with no overlap at all IS refused - it selects
        // nothing, and silently handing back a 1x1 image is the worse answer.
        val x0 = min(max(jsRound(x), 0.0), box.width.toDouble()).toInt()
        val y0 = min(max(jsRound(y), 0.0), box.height.toDouble()).toInt()
        val x1 = min(max(jsRound(x + w), 0.0), box.width.toDouble()).toInt()
        val y1 = min(max(jsRound(y + h), 0.0), box.height.toDouble()).toInt()
        val cw = x1 - x0
        val ch = y1 - y0
        if (cw < 1 || ch < 1) return null
        return StepResult(cw, ch, Rect(x0, y0, cw, ch))
    }

    private fun rotateStep(box: Box, spec: Any?): StepResult? {
        val deg = finite(spec) ?: return null
        val normal = ((jsRound(deg).toLong() % 360) + 360) % 360
        // Only right angles. An arbitrary angle changes the canvas shape and needs a fill
        // colour and a resampling policy; refusing is honest, and `manipulate` is not an editor.
        if (normal % 90L != 0L) return null
        return if (normal == 90L || normal == 270L) StepResult(box.height, box.width)
               else StepResult(box.width, box.height)
    }

    private fun flipStep(box: Box, spec: Any?): StepResult? {
        val word = (spec as? String ?: "").trim().lowercase()
        val known = word == "h" || word == "v" || word == "horizontal" || word == "vertical"
        return if (known) StepResult(box.width, box.height) else null
    }

    private fun blurStep(box: Box, spec: Any?): StepResult? {
        val radius = finite(spec) ?: return null
        if (radius < 0 || radius > 100) return null
        return StepResult(box.width, box.height)
    }

    private fun runStep(name: String, box: Box, spec: Any?): StepResult? = when (name) {
        "resize" -> resizeStep(box, spec)
        "crop" -> cropStep(box, spec)
        "rotate" -> rotateStep(box, spec)
        "flip" -> flipStep(box, spec)
        "blur" -> blurStep(box, spec)
        else -> null
    }

    /**
     * Run an op list over a source box and report the geometry at every step.
     *
     * The ops are applied IN ORDER, which is the contract: `[crop, resize]` and
     * `[resize, crop]` are different pictures and both must be exact. The budget is checked
     * after each step, so a chain that would blow up in the middle is refused before the facet
     * allocates anything.
     */
    fun resolveOps(source: Box, ops: Any?, maxPixels: Long = MAX_PIXELS): OpsResult {
        val sw = positive(source.width) ?: return OpsResult.Refused("invalid_ops", -1)
        val sh = positive(source.height) ?: return OpsResult.Refused("invalid_ops", -1)

        val list = when (ops) {
            null -> emptyList<Any?>()
            is List<*> -> ops
            else -> return OpsResult.Refused("invalid_ops", -1)
        }

        var box = Box(px(sw), px(sh))
        val steps = ArrayList<Step>(list.size)

        for (i in list.indices) {
            val entry = opEntry(list[i]) ?: return OpsResult.Refused("invalid_ops", i)
            val next = runStep(entry.first, box, entry.second)
                ?: return OpsResult.Refused("invalid_ops", i)
            val after = next.width.toLong() * next.height.toLong()
            if (after > maxPixels && after > box.width.toLong() * box.height.toLong()) {
                return OpsResult.Refused("too_large", i)
            }
            box = Box(next.width, next.height)
            steps.add(Step(entry.first, box.width, box.height, next.rect))
        }

        return OpsResult.Value(box.width, box.height, steps)
    }

    // -- the decode hint ---------------------------------------------------------------------

    /** `sampleSize` is the power-of-two subsampling factor handed straight to
     *  BitmapFactory.Options.inSampleSize; 1 means "decode whole". `width`/`height` are what
     *  that decode produces, and are the downsample target iOS and the web use instead. */
    data class DecodeHint(val sampleSize: Int, val width: Int, val height: Int)

    /**
     * The largest the source needs to be decoded at for this chain to be exact.
     *
     * A 12 MP photo resized to 400 px wide never needs 12 MP in memory: decoding at sampleSize
     * 8 gives 500x375, which still has more pixels than the output asks for, and costs 0.2 MB
     * instead of 48 MB.
     *
     * The factor is taken at the FIRST resize, relative to the box that reaches it: a crop
     * before the resize means the resize sees fewer pixels, so MORE of the source is needed per
     * output pixel, and the hint gets conservatively larger. A chain with no resize needs the
     * source whole - unless the source alone breaks the budget, in which case the hint
     * subsamples until it fits, because refusing to open a photo the camera produced is not an
     * option a framework has.
     */
    fun decodeHint(source: Box, ops: Any?, maxPixels: Long = MAX_PIXELS): DecodeHint {
        val sw = px(positive(source.width) ?: 1.0)
        val sh = px(positive(source.height) ?: 1.0)
        val list = ops as? List<*> ?: emptyList<Any?>()

        var box = Box(sw, sh)
        var needed = 1.0
        for (op in list) {
            val entry = opEntry(op) ?: break
            if (entry.first == "resize") {
                val step = resizeStep(box, entry.second) ?: break
                // `cover` crops after scaling, so the SCALED box is what the decode must reach.
                val scaledW = if (step.rect == null) step.width else max(step.width, step.rect.width)
                val scaledH = if (step.rect == null) step.height else max(step.height, step.rect.height)
                needed = max(scaledW.toDouble() / box.width, scaledH.toDouble() / box.height)
                break
            }
            val step = runStep(entry.first, box, entry.second) ?: break
            box = Box(step.width, step.height)
        }

        var sampleSize = 1
        if (needed < 1.0) {
            val wantW = ceil(sw * needed).toInt()
            val wantH = ceil(sh * needed).toInt()
            while (sampleSize < 32 && sw / (sampleSize * 2) >= wantW && sh / (sampleSize * 2) >= wantH) {
                sampleSize *= 2
            }
        }
        // Whatever the chain asked for, never hand back a decode that breaks the budget.
        while (sampleSize < 32 &&
               ceilDiv(sw, sampleSize).toLong() * ceilDiv(sh, sampleSize).toLong() > maxPixels) {
            sampleSize *= 2
        }
        return DecodeHint(sampleSize, ceilDiv(sw, sampleSize), ceilDiv(sh, sampleSize))
    }

    private fun ceilDiv(value: Int, divisor: Int): Int = (value + divisor - 1) / divisor

    // -- the pick plan -------------------------------------------------------------------------

    data class PickPlan(
        val type: String,
        val source: String,
        val limit: Int,
        val multiple: Boolean,
        val ordered: Boolean,
        /** `true` when the plan can run on the PERMISSION-FREE system picker. This is the whole
         *  privacy posture in one boolean: library picks never ask, camera picks do. */
        val permissionFree: Boolean,
    )

    sealed class PickPlanResult {
        data class Value(val plan: PickPlan) : PickPlanResult()
        data class Refused(val error: String) : PickPlanResult()
    }

    /**
     * Fold pick arguments into the plan a facet executes.
     *
     * The rules exist because every one of them is a shape a caller gets wrong:
     *  - `multiple: false` pins the limit to 1 whatever `limit` says;
     *  - a `limit` above 1 IMPLIES multiple, because passing one without the other is what a
     *    caller means and refusing it teaches nothing;
     *  - `limit: 0` means "the system's own maximum", which is not the same as one;
     *  - the camera returns one shot per presentation, so `source: "camera"` is always limit 1;
     *  - `ordered` is only meaningful for a multi-pick and is folded off otherwise, so a facet
     *    never has to decide what an ordered single selection means.
     */
    fun pickPlan(args: Map<String, Any?>?): PickPlanResult {
        val a = args ?: emptyMap()
        val typeRaw = (a["type"] as? String ?: (a["type"]?.toString() ?: "any")).trim().lowercase()
        val typeFolded = if (typeRaw.isEmpty()) "any" else if (typeRaw == "photo") "image" else typeRaw
        if (!PICK_TYPES.contains(typeFolded)) return PickPlanResult.Refused("unsupported_format")

        val sourceRaw = (a["source"] as? String ?: (a["source"]?.toString() ?: "library")).trim().lowercase()
        val source = if (sourceRaw.isEmpty()) "library" else sourceRaw
        if (!PICK_SOURCES.contains(source)) return PickPlanResult.Refused("invalid_source")

        val askedLimit = finite(a["limit"])
        // An explicit `multiple: false` always wins: a caller who wrote it means it. A limit
        // above one with no `multiple` at all IMPLIES it, because that is what the caller means
        // and refusing the shorthand teaches nothing.
        val impliedMultiple = !a.containsKey("multiple") && askedLimit != null && askedLimit > 1
        var multiple = a["multiple"] == true || impliedMultiple
        var limit: Int
        if (!multiple) {
            limit = 1
        } else if (askedLimit == null || askedLimit <= 0) {
            limit = 0
        } else {
            limit = min(floor(askedLimit).toInt(), PICK_MAX)
            if (limit == 1) multiple = false
        }
        if (source == "camera") {
            multiple = false
            limit = 1
        }

        return PickPlanResult.Value(
            PickPlan(
                type = typeFolded,
                source = source,
                limit = limit,
                multiple = multiple,
                ordered = multiple && a["ordered"] == true,
                permissionFree = source == "library",
            )
        )
    }

    /** The MIME filter a facet hands its picker. `any` is an empty list, which every picker
     *  reads as "no filter" - a list of every type it might see would be wrong the first time a
     *  new codec shipped. */
    fun pickMimeTypes(type: String): List<String> = when (type) {
        "image" -> listOf("image/*")
        "video" -> listOf("video/*")
        else -> emptyList()
    }
}
