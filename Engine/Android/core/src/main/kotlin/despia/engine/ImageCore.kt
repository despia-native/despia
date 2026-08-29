//
//  ImageCore.kt - the <image> PURE CORE (U05; :core, pure JVM, no Android imports): the
//  contentFit x contentPosition geometry solver, the cache-policy ladder (with the legacy
//  binary `cache` folded in), the transition gate, the decode-at-display-size ladder,
//  placeholder classification, the recycling identity, and the blurhash / thumbhash decoders.
//
//  The law is the corpus: OpenSource/Conformance/image/resolution.json (parity/U05-image.md).
//  The twin of Swift Engine/iOS/ImageCore.swift and the web @despia-native/kernel image-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file - the network fetch, LruCache,
//  BitmapFactory, the Compose painter. Keeping the DECISION separate from the PLUMBING is what
//  lets one corpus judge three renderers.
//
//  THE TRANSCENDENTALS ARE StrictMath ON PURPOSE. The two hash decoders quantise a cosine sum
//  into 8-bit channels, so a 1-ULP difference in cos() could flip a pinned pixel. StrictMath is
//  specified as fdlibm and is therefore identical on every JVM, and matches the fdlibm-derived
//  implementations the other two runtimes use.
//
//  The decoders are re-implementations of the published BlurHash (Wolt, MIT) and ThumbHash
//  (Evan Wallace, MIT) formats. Nothing is vendored: this is original code reading the same
//  bytes, cross-checked against the reference algorithms and pinned to exact RGBA in the corpus,
//  because a placeholder that differs per platform is worse than no placeholder at all.
//
package despia.engine

object ImageCore {

    val CONTENT_FITS: List<String> = listOf("cover", "contain", "fill", "none", "scaleDown")
    val CACHE_POLICIES: List<String> = listOf("memory", "disk", "memoryDisk", "none")
    val PRIORITIES: List<String> = listOf("low", "normal", "high")
    val TRANSITION_EFFECTS: List<String> = listOf(
        "none", "crossDissolve", "flipFromLeft", "flipFromRight",
        "flipFromTop", "flipFromBottom", "curlUp", "curlDown",
    )

    const val CONTENT_FIT_DEFAULT = "cover"
    const val CONTENT_POSITION_DEFAULT = "center"
    const val CACHE_POLICY_DEFAULT = "memoryDisk"
    const val TRANSITION_DURATION_DEFAULT = 200

    data class Size(val width: Double, val height: Double)
    data class Anchor(val x: Double, val y: Double)
    data class Rect(val x: Double, val y: Double, val width: Double, val height: Double, val scale: Double)

    /** The named anchors, as fractions of the free space. Twin of the TS/Swift tables. */
    val POSITION_ANCHORS: Map<String, Anchor> = linkedMapOf(
        "center" to Anchor(0.5, 0.5),
        "top" to Anchor(0.5, 0.0),
        "bottom" to Anchor(0.5, 1.0),
        "leading" to Anchor(0.0, 0.5),
        "left" to Anchor(0.0, 0.5),
        "trailing" to Anchor(1.0, 0.5),
        "right" to Anchor(1.0, 0.5),
        "topLeading" to Anchor(0.0, 0.0),
        "topTrailing" to Anchor(1.0, 0.0),
        "bottomLeading" to Anchor(0.0, 1.0),
        "bottomTrailing" to Anchor(1.0, 1.0),
    )

    private fun clamp01(value: Double): Double = if (value < 0.0) 0.0 else if (value > 1.0) 1.0 else value

    /** Unknown word folds to `cover` - an image is never not drawn because a token was misspelled. */
    fun resolveContentFit(fit: String?): String {
        val word = fit?.trim().orEmpty()
        return if (word in CONTENT_FITS) word else CONTENT_FIT_DEFAULT
    }

    private fun positionScalar(token: String): Double? {
        val text = token.trim()
        if (text.isEmpty()) return null
        val value = if (text.endsWith("%")) text.dropLast(1).toDoubleOrNull()?.div(100.0)
                    else text.toDoubleOrNull()
        return if (value == null || !value.isFinite()) null else clamp01(value)
    }

    /**
     * `contentPosition` -> the anchor fractions the drawn rect is placed at. A named anchor, or
     * an `x y` pair in percentages or 0..1 fractions. Anything unparseable is `center`, because
     * an off-screen image is a worse failure than a mis-anchored one.
     */
    fun resolveContentPosition(position: String?): Anchor {
        val text = position?.trim().orEmpty()
        if (text.isEmpty()) return Anchor(0.5, 0.5)
        POSITION_ANCHORS[text]?.let { return it }
        val parts = text.replace(",", " ").split(" ").filter { it.isNotEmpty() }
        if (parts.size == 1) {
            val only = positionScalar(parts[0]) ?: return Anchor(0.5, 0.5)
            return Anchor(only, 0.5)
        }
        if (parts.size >= 2) {
            val x = positionScalar(parts[0]) ?: return Anchor(0.5, 0.5)
            val y = positionScalar(parts[1]) ?: return Anchor(0.5, 0.5)
            return Anchor(x, y)
        }
        return Anchor(0.5, 0.5)
    }

    /**
     * THE GEOMETRY SOLVER. Given the source and the container, what rect is drawn? A negative
     * x/y is the crop offset `cover` needs - the same sign convention CSS object-position uses.
     * Any non-positive dimension yields the empty rect rather than a NaN that propagates into a
     * layout pass.
     */
    fun solveImageRect(fit: String?, position: String?, source: Size, container: Size): Rect {
        val mode = resolveContentFit(fit)
        val sw = source.width; val sh = source.height
        val cw = container.width; val ch = container.height
        if (!(sw > 0.0) || !(sh > 0.0) || !(cw > 0.0) || !(ch > 0.0)) return Rect(0.0, 0.0, 0.0, 0.0, 0.0)
        val drawnWidth: Double
        val drawnHeight: Double
        if (mode == "fill") {
            drawnWidth = cw
            drawnHeight = ch
        } else {
            val factor = when (mode) {
                "cover" -> maxOf(cw / sw, ch / sh)
                "contain" -> minOf(cw / sw, ch / sh)
                "none" -> 1.0
                else -> minOf(1.0, minOf(cw / sw, ch / sh))
            }
            drawnWidth = sw * factor
            drawnHeight = sh * factor
        }
        val anchor = resolveContentPosition(position)
        // `fill` does not preserve aspect, so a single scale factor is meaningless: 0 says so.
        return Rect(
            x = (cw - drawnWidth) * anchor.x,
            y = (ch - drawnHeight) * anchor.y,
            width = drawnWidth,
            height = drawnHeight,
            scale = if (mode == "fill") 0.0 else drawnWidth / sw,
        )
    }

    data class CacheResolution(
        val policy: String,
        val memory: Boolean,
        val disk: Boolean,
        /** `none` means REVALIDATE - the bytes still ride the content plane, they are never read back. */
        val revalidate: Boolean,
    )

    /**
     * The cache-policy ladder. `cachePolicy` wins when it names one of the four words; otherwise
     * the legacy binary `cache` decides, so every app written against `cache="none"` keeps its
     * behaviour byte for byte. An unrecognised `cachePolicy` falls through to the legacy read
     * rather than disabling caching: a typo must never turn a feed into a download loop.
     */
    fun resolveCachePolicy(cachePolicy: String?, cache: String? = null): CacheResolution {
        val word = cachePolicy?.trim().orEmpty()
        val policy = if (word in CACHE_POLICIES) word
                     else if (cache?.trim() == "none") "none" else CACHE_POLICY_DEFAULT
        return CacheResolution(
            policy = policy,
            memory = policy == "memory" || policy == "memoryDisk",
            disk = policy == "disk" || policy == "memoryDisk",
            revalidate = policy == "none",
        )
    }

    /** What `on:load` reports, given where the bytes were actually found. */
    fun cacheTypeFor(policy: CacheResolution, inMemory: Boolean, onDisk: Boolean): String = when {
        policy.memory && inMemory -> "memory"
        policy.disk && onDisk -> "disk"
        else -> "none"
    }

    data class Transition(val duration: Int, val effect: String)

    /** Zero duration and `none` are the same statement; keep them from disagreeing. */
    private fun normalise(duration: Int, effect: String): Transition =
        if (duration == 0 || effect == "none") Transition(0, "none") else Transition(duration, effect)

    /** `transition` accepts a number of ms, a numeric string, an effect word, or {duration,effect}. */
    fun resolveTransition(spec: Any?): Transition {
        if (spec == null) return Transition(TRANSITION_DURATION_DEFAULT, "crossDissolve")
        if (spec is Number) {
            val value = spec.toDouble()
            if (!value.isFinite()) return Transition(TRANSITION_DURATION_DEFAULT, "crossDissolve")
            return normalise(maxOf(0, value.toInt()), "crossDissolve")
        }
        if (spec is Map<*, *>) {
            val rawDuration = spec["duration"]
            val duration = if (rawDuration is Number && rawDuration.toDouble().isFinite())
                maxOf(0, rawDuration.toDouble().toInt()) else TRANSITION_DURATION_DEFAULT
            val word = (spec["effect"] as? String)?.trim() ?: "crossDissolve"
            val effect = if (word in TRANSITION_EFFECTS) word else "crossDissolve"
            return normalise(duration, effect)
        }
        val text = spec.toString().trim()
        if (text.isEmpty()) return Transition(TRANSITION_DURATION_DEFAULT, "crossDissolve")
        if (text in TRANSITION_EFFECTS) {
            return normalise(if (text == "none") 0 else TRANSITION_DURATION_DEFAULT, text)
        }
        val numeric = text.toDoubleOrNull()
        if (numeric != null && numeric.isFinite()) return normalise(maxOf(0, numeric.toInt()), "crossDissolve")
        return Transition(TRANSITION_DURATION_DEFAULT, "crossDissolve")
    }

    /**
     * THE RULE THAT MAKES A FAST APP LOOK FAST: an image already decoded in memory appears in
     * the same frame, with no fade. Fading in something that was instantly available is the tell
     * that an app is doing theatre instead of work.
     */
    fun shouldTransition(transition: Transition, cacheType: String): Boolean =
        transition.duration > 0 && transition.effect != "none" && cacheType != "memory"

    data class DecodeSize(val width: Int, val height: Int, val downscaled: Boolean)

    /**
     * `allowDownscaling` - decode at display size, the single biggest memory win in list-heavy
     * apps. A 4000 px hero in a 48 pt avatar decodes at 96 px on a @2x screen: 64 KB instead of
     * 64 MB. Never upscales, and an unknown display size decodes at source rather than guessing.
     */
    fun resolveDecodeSize(
        fit: String?, source: Size, display: Size, scale: Double = 1.0, allowDownscaling: Boolean = true,
    ): DecodeSize {
        val sw = source.width; val sh = source.height
        if (!(sw > 0.0) || !(sh > 0.0)) return DecodeSize(0, 0, false)
        val sourceWidth = Math.round(sw).toInt()
        val sourceHeight = Math.round(sh).toInt()
        if (!allowDownscaling || !(display.width > 0.0) || !(display.height > 0.0) || !(scale > 0.0)) {
            return DecodeSize(sourceWidth, sourceHeight, false)
        }
        val targetWidth = display.width * scale
        val targetHeight = display.height * scale
        val required = when (resolveContentFit(fit)) {
            "cover", "fill" -> maxOf(targetWidth / sw, targetHeight / sh)
            "none" -> 1.0
            else -> minOf(targetWidth / sw, targetHeight / sh)
        }
        val factor = minOf(1.0, required)
        val width = maxOf(1, Math.round(sw * factor).toInt())
        val height = maxOf(1, Math.round(sh * factor).toInt())
        return DecodeSize(width, height, width < sourceWidth || height < sourceHeight)
    }

    private const val BASE83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#\$%*+,-.:;=?@[]^_{|}~"
    private const val BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    /** The semantic colour words `placeholder` may name. Hexes and rgb(a)() are read by shape. */
    val PLACEHOLDER_COLOR_TOKENS: List<String> = listOf(
        "accent", "label", "separator", "white", "black", "clear", "transparent",
        "background", "secondaryLabel", "tertiaryLabel", "systemFill",
    )

    /** A blurhash carries its own component count, so the length check is exact, not a heuristic. */
    fun isBlurhash(text: String): Boolean {
        if (text.length < 6) return false
        for (character in text) if (!BASE83.contains(character)) return false
        val flag = BASE83.indexOf(text[0])
        val numY = flag / 9 + 1
        val numX = flag % 9 + 1
        return text.length == 4 + 2 * numX * numY
    }

    /** Byte length of a well-formed base64 payload, or -1. Tells a thumbhash from an asset name. */
    fun base64ByteLength(text: String): Int {
        if (text.length < 8 || text.length % 4 != 0) return -1
        val body = text.trimEnd('=')
        if (text.length - body.length > 2) return -1
        for (character in body) if (!BASE64.contains(character)) return -1
        return body.length * 3 / 4
    }

    data class Placeholder(val kind: String, val value: String)

    /**
     * `placeholder` is one attribute carrying four different things, so the classification has
     * to be deterministic rather than clever: an explicit `blurhash:` / `thumbhash:` prefix
     * always wins, then colour by shape, then a blurhash by its self-describing length, then a
     * thumbhash by being well-formed base64 of at least the 5-byte header, then an asset name.
     */
    fun classifyPlaceholder(value: String?): Placeholder {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return Placeholder("none", "")
        if (text.startsWith("blurhash:")) return Placeholder("blurhash", text.substring(9))
        if (text.startsWith("thumbhash:")) return Placeholder("thumbhash", text.substring(10))
        if (text.startsWith("#") || text.startsWith("rgb(") || text.startsWith("rgba(")
            || text in PLACEHOLDER_COLOR_TOKENS
        ) return Placeholder("color", text)
        if (isBlurhash(text)) return Placeholder("blurhash", text)
        if (base64ByteLength(text) >= 5) return Placeholder("thumbhash", text)
        return Placeholder("asset", text)
    }

    data class Recycling(val key: String, val clear: Boolean)

    /**
     * `recyclingKey` - the fix for the bug every list in every app has: row A shows image 1, the
     * row is reused for item 47, and image 1 stays on screen under item 47's text until the new
     * bytes land. The identity ladder is author key -> the list's row key (set automatically, so
     * the correct behaviour is the default) -> src -> asset.
     */
    fun resolveRecycling(
        recyclingKey: String? = null, rowKey: String? = null,
        src: String? = null, asset: String? = null, previousKey: String? = null,
    ): Recycling {
        var key = ""
        for (candidate in listOf(recyclingKey, rowKey, src, asset)) {
            val text = candidate?.trim().orEmpty()
            if (text.isNotEmpty()) { key = text; break }
        }
        return Recycling(key, key != previousKey?.trim().orEmpty())
    }

    data class Pixels(val width: Int, val height: Int, val rgba: IntArray) {
        override fun equals(other: Any?): Boolean =
            other is Pixels && width == other.width && height == other.height && rgba.contentEquals(other.rgba)
        override fun hashCode(): Int = (width * 31 + height) * 31 + rgba.contentHashCode()
    }

    private fun srgbToLinear(component: Int): Double {
        val value = component / 255.0
        return if (value <= 0.04045) value / 12.92 else StrictMath.pow((value + 0.055) / 1.055, 2.4)
    }

    private fun linearToSrgb(value: Double): Int {
        val clamped = if (value < 0.0) 0.0 else if (value > 1.0) 1.0 else value
        return if (clamped <= 0.0031308) (clamped * 12.92 * 255 + 0.5).toInt()
               else (1.055 * StrictMath.pow(clamped, 1.0 / 2.4) - 0.055).let { (it * 255 + 0.5).toInt() }
    }

    private fun signedPow(value: Double, exponent: Double): Double =
        (if (value < 0) -1.0 else 1.0) * StrictMath.pow(StrictMath.abs(value), exponent)

    private fun decode83(text: String): Int {
        var value = 0
        for (character in text) {
            val digit = BASE83.indexOf(character)
            if (digit < 0) return -1
            value = value * 83 + digit
        }
        return value
    }

    /**
     * Decode a BlurHash to RGBA at an arbitrary size. Returns null for a malformed hash rather
     * than throwing: a bad placeholder must degrade to no placeholder, never to a crashed row.
     */
    fun decodeBlurhash(hash: String, width: Int, height: Int, punch: Double = 1.0): Pixels? {
        if (!isBlurhash(hash) || width <= 0 || height <= 0) return null
        val flag = decode83(hash.substring(0, 1))
        val numY = flag / 9 + 1
        val numX = flag % 9 + 1
        val maximum = (decode83(hash.substring(1, 2)) + 1) / 166.0 * punch

        val colors = Array(numX * numY) { DoubleArray(3) }
        val dc = decode83(hash.substring(2, 6))
        colors[0][0] = srgbToLinear(dc shr 16)
        colors[0][1] = srgbToLinear((dc shr 8) and 255)
        colors[0][2] = srgbToLinear(dc and 255)
        for (index in 1 until numX * numY) {
            val value = decode83(hash.substring(4 + index * 2, 6 + index * 2))
            val quantR = value / (19 * 19)
            val quantG = (value / 19) % 19
            val quantB = value % 19
            colors[index][0] = signedPow((quantR - 9) / 9.0, 2.0) * maximum
            colors[index][1] = signedPow((quantG - 9) / 9.0, 2.0) * maximum
            colors[index][2] = signedPow((quantB - 9) / 9.0, 2.0) * maximum
        }

        val rgba = IntArray(width * height * 4)
        val stride = width * 4
        for (y in 0 until height) {
            for (x in 0 until width) {
                var red = 0.0; var green = 0.0; var blue = 0.0
                for (j in 0 until numY) {
                    val basisY = StrictMath.cos(StrictMath.PI * y * j / height)
                    for (i in 0 until numX) {
                        val basis = StrictMath.cos(StrictMath.PI * x * i / width) * basisY
                        val color = colors[i + j * numX]
                        red += color[0] * basis
                        green += color[1] * basis
                        blue += color[2] * basis
                    }
                }
                val offset = y * stride + x * 4
                rgba[offset] = linearToSrgb(red)
                rgba[offset + 1] = linearToSrgb(green)
                rgba[offset + 2] = linearToSrgb(blue)
                rgba[offset + 3] = 255
            }
        }
        return Pixels(width, height, rgba)
    }

    /** Decode standard base64 without depending on a platform codec (:core is pure JVM). */
    private fun decodeBase64(text: String): IntArray? {
        if (base64ByteLength(text) < 0) return null
        val body = text.trimEnd('=')
        val bytes = IntArray(body.length * 3 / 4)
        var accumulator = 0
        var bits = 0
        var written = 0
        for (character in body) {
            accumulator = (accumulator shl 6) or BASE64.indexOf(character)
            bits += 6
            if (bits >= 8) {
                bits -= 8
                bytes[written++] = (accumulator shr bits) and 255
            }
        }
        return bytes
    }

    /**
     * Decode a ThumbHash to RGBA. Unlike a blurhash the size is not the caller's choice - the
     * hash carries its own aspect ratio and the decode is defined at <=32 px on the long edge,
     * which is exactly why it is worth the extra bytes: the placeholder has the right shape.
     * `hash` is the base64 transport form, with or without the `thumbhash:` prefix.
     */
    fun decodeThumbhash(hash: String): Pixels? {
        val text = (if (hash.startsWith("thumbhash:")) hash.substring(10) else hash).trim()
        val bytes = decodeBase64(text) ?: return null
        if (bytes.size < 5) return null

        val header24 = bytes[0] or (bytes[1] shl 8) or (bytes[2] shl 16)
        val header16 = bytes[3] or (bytes[4] shl 8)
        val lDc = (header24 and 63) / 63.0
        val pDc = ((header24 shr 6) and 63) / 31.5 - 1.0
        val qDc = ((header24 shr 12) and 63) / 31.5 - 1.0
        val lScale = ((header24 shr 18) and 31) / 31.0
        val hasAlpha = (header24 shr 23) != 0
        if (hasAlpha && bytes.size < 6) return null
        val pScale = ((header16 shr 3) and 63) / 63.0
        val qScale = ((header16 shr 9) and 63) / 63.0
        val isLandscape = (header16 shr 15) != 0
        val lx = maxOf(3, if (isLandscape) (if (hasAlpha) 5 else 7) else header16 and 7)
        val ly = maxOf(3, if (isLandscape) header16 and 7 else (if (hasAlpha) 5 else 7))
        val aDc = if (hasAlpha) (bytes[5] and 15) / 15.0 else 1.0
        val aScale = if (hasAlpha) (bytes[5] shr 4) / 15.0 else 0.0

        val acStart = if (hasAlpha) 6 else 5
        var acIndex = 0
        var overran = false
        fun channel(nx: Int, ny: Int, scale: Double): DoubleArray {
            val factors = ArrayList<Double>()
            for (cy in 0 until ny) {
                var cx = if (cy == 0) 1 else 0
                while (cx * ny < nx * (ny - cy)) {
                    val byteIndex = acStart + (acIndex shr 1)
                    if (byteIndex >= bytes.size) { overran = true; factors.add(0.0) }
                    else {
                        val nibble = (bytes[byteIndex] shr ((acIndex and 1) shl 2)) and 15
                        factors.add((nibble / 7.5 - 1.0) * scale)
                    }
                    acIndex++
                    cx++
                }
            }
            return factors.toDoubleArray()
        }
        val lAc = channel(lx, ly, lScale)
        val pAc = channel(3, 3, pScale * 1.25)
        val qAc = channel(3, 3, qScale * 1.25)
        val aAc = if (hasAlpha) channel(5, 5, aScale) else DoubleArray(0)
        if (overran) return null

        val ratio = lx.toDouble() / ly.toDouble()
        val width = Math.round(if (ratio > 1.0) 32.0 else 32.0 * ratio).toInt()
        val height = Math.round(if (ratio > 1.0) 32.0 / ratio else 32.0).toInt()
        val rgba = IntArray(width * height * 4)
        val coefficientsX = maxOf(lx, if (hasAlpha) 5 else 3)
        val coefficientsY = maxOf(ly, if (hasAlpha) 5 else 3)
        val fx = DoubleArray(coefficientsX)
        val fy = DoubleArray(coefficientsY)

        var offset = 0
        for (y in 0 until height) {
            for (cy in 0 until coefficientsY) fy[cy] = StrictMath.cos(StrictMath.PI / height * (y + 0.5) * cy)
            for (x in 0 until width) {
                for (cx in 0 until coefficientsX) fx[cx] = StrictMath.cos(StrictMath.PI / width * (x + 0.5) * cx)
                var luminance = lDc; var chromaP = pDc; var chromaQ = qDc; var alpha = aDc
                var j = 0
                for (cy in 0 until ly) {
                    val doubled = fy[cy] * 2
                    var cx = if (cy == 0) 1 else 0
                    while (cx * ly < lx * (ly - cy)) {
                        luminance += lAc[j] * fx[cx] * doubled
                        j++; cx++
                    }
                }
                j = 0
                for (cy in 0 until 3) {
                    val doubled = fy[cy] * 2
                    var cx = if (cy == 0) 1 else 0
                    while (cx < 3 - cy) {
                        val basis = fx[cx] * doubled
                        chromaP += pAc[j] * basis
                        chromaQ += qAc[j] * basis
                        j++; cx++
                    }
                }
                if (hasAlpha) {
                    j = 0
                    for (cy in 0 until 5) {
                        val doubled = fy[cy] * 2
                        var cx = if (cy == 0) 1 else 0
                        while (cx < 5 - cy) {
                            alpha += aAc[j] * fx[cx] * doubled
                            j++; cx++
                        }
                    }
                }
                val blue = luminance - 2.0 / 3.0 * chromaP
                val red = (3.0 * luminance - blue + chromaQ) / 2.0
                val green = red - chromaQ
                rgba[offset] = maxOf(0, (255.0 * minOf(1.0, red)).toInt())
                rgba[offset + 1] = maxOf(0, (255.0 * minOf(1.0, green)).toInt())
                rgba[offset + 2] = maxOf(0, (255.0 * minOf(1.0, blue)).toInt())
                rgba[offset + 3] = maxOf(0, (255.0 * minOf(1.0, alpha)).toInt())
                offset += 4
            }
        }
        return Pixels(width, height, rgba)
    }

    /** Decode whatever kind of hash `placeholder` turned out to be, at the size the caller wants. */
    fun decodePlaceholder(placeholder: Placeholder, width: Int = 32, height: Int = 32): Pixels? = when (placeholder.kind) {
        "blurhash" -> decodeBlurhash(placeholder.value, width, height)
        "thumbhash" -> decodeThumbhash(placeholder.value)
        else -> null
    }

    /** `priority` - unknown words are `normal`, never a silent demotion to `low`. */
    fun resolveImagePriority(priority: String?): String {
        val word = priority?.trim().orEmpty()
        return if (word in PRIORITIES) word else "normal"
    }

    private val MEDIA_TYPES: Map<String, String> = mapOf(
        "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png", "gif" to "image/gif",
        "webp" to "image/webp", "avif" to "image/avif", "heic" to "image/heic", "heif" to "image/heif",
        "svg" to "image/svg+xml", "bmp" to "image/bmp", "tif" to "image/tiff", "tiff" to "image/tiff",
    )

    /** Map the sniffed container to the media type `on:load` reports. Unknown bytes stay unknown. */
    fun imageMediaType(extensionOrType: String?): String {
        val text = extensionOrType?.trim()?.lowercase().orEmpty()
        if (text.isEmpty()) return "unknown"
        if (text.contains("/")) return text
        return MEDIA_TYPES[text.removePrefix(".")] ?: "unknown"
    }
}
