//
//  StackImage.kt — the `<image>` COMPOSE ADAPTER (U05). Every decision lives in the shared core
//  (:core `despia.engine.ImageCore`, corpus OpenSource/Conformance/image/resolution.json); this
//  file is the Android plumbing: decode-at-display-size, the placeholder bitmap, the ContentScale
//  mapping, the transition gate and the recycling identity.
//
//  WHY THIS IS ITS OWN FILE. elements/ImageElements.kt is the existing `<image>` and is shared;
//  its branches call in here rather than growing fourteen attributes in place.
//
//  THE ONE THING WORTH THE WHOLE PLAN IS `allowDownscaling`. `BitmapFactory.Options.inSampleSize`
//  computed from the target size decodes the pixels that will be PAINTED rather than the pixels
//  the file happens to contain: a 4000 px hero in a 48 dp avatar at xhdpi is 96 px, which is
//  64 KB instead of 64 MB. In a list of forty avatars that is the difference between a feed that
//  scrolls and one the low-memory killer takes.
//
//  inSampleSize IS POWER-OF-TWO ONLY, and that is a real divergence from iOS's ImageIO
//  thumbnailer, which hits the exact size. The core computes the exact target on both; this file
//  then rounds DOWN to the power of two that is still at least the target, so Android decodes at
//  most 2x the ideal and never below it. Under-decoding would be visible; over-decoding by up to
//  one octave is not, and it is the platform's own ceiling rather than a choice.
//
//  NO COIL. The existing cache is the one the lightbox and the content plane already share, and
//  adopting Coil would fragment it and add weight to every app.
//
package despia.engine.render

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.Alignment
import despia.engine.ImageCore

object StackImage {

    // ------------------------------------------------------------------ content mode

    /** `contentFit` → the Compose scale. `scaleDown` is `Inside`, which is exactly "contain but
     *  never upscale" — the one mapping where Compose's word and ours already agree in meaning. */
    fun contentScale(contentFit: String?): ContentScale = when (ImageCore.resolveContentFit(contentFit)) {
        "contain" -> ContentScale.Fit
        "fill" -> ContentScale.FillBounds
        "none" -> ContentScale.None
        "scaleDown" -> ContentScale.Inside
        else -> ContentScale.Crop
    }

    /**
     * `contentPosition` → the Compose alignment the drawn rect is anchored at.
     *
     * The core answers in 0…1 fractions, which is strictly richer than the nine named
     * `Alignment`s, so an off-grid pair snaps to the nearest named anchor here. A caller that
     * needs the exact rect (a crop overlay, a shared transition) reads `ImageCore.solveImageRect`
     * instead, which is why the solver returns a rect and not an alignment.
     */
    fun alignment(contentPosition: String?): Alignment {
        val anchor = ImageCore.resolveContentPosition(contentPosition)
        val horizontal = if (anchor.x < 0.34) -1 else if (anchor.x > 0.66) 1 else 0
        val vertical = if (anchor.y < 0.34) -1 else if (anchor.y > 0.66) 1 else 0
        return when {
            vertical < 0 && horizontal < 0 -> Alignment.TopStart
            vertical < 0 && horizontal == 0 -> Alignment.TopCenter
            vertical < 0 -> Alignment.TopEnd
            vertical == 0 && horizontal < 0 -> Alignment.CenterStart
            vertical == 0 && horizontal == 0 -> Alignment.Center
            vertical == 0 -> Alignment.CenterEnd
            horizontal < 0 -> Alignment.BottomStart
            horizontal == 0 -> Alignment.BottomCenter
            else -> Alignment.BottomEnd
        }
    }

    // ------------------------------------------------------------------ decode at size

    /**
     * The `inSampleSize` for a decode at display size, always a power of two and never below 1.
     *
     * Rounds DOWN to the octave that still covers the target: over-decoding by up to one octave
     * is invisible, under-decoding is a blurry avatar, and the asymmetry decides the rounding.
     */
    fun sampleSize(
        contentFit: String?,
        sourceWidth: Int,
        sourceHeight: Int,
        displayWidth: Double,
        displayHeight: Double,
        density: Double,
        allowDownscaling: Boolean = true,
    ): Int {
        val plan = ImageCore.resolveDecodeSize(
            fit = contentFit,
            source = ImageCore.Size(sourceWidth.toDouble(), sourceHeight.toDouble()),
            display = ImageCore.Size(displayWidth, displayHeight),
            scale = density,
            allowDownscaling = allowDownscaling,
        )
        if (!plan.downscaled || plan.width <= 0) return 1
        var sample = 1
        while (sourceWidth / (sample * 2) >= plan.width && sourceHeight / (sample * 2) >= plan.height) {
            sample *= 2
        }
        return sample
    }

    /**
     * Decode `bytes` at the size they will be painted. Two passes, which is the platform's own
     * shape: `inJustDecodeBounds` reads the header only, the core decides the target from real
     * source dimensions, and the second pass allocates once at that size.
     *
     * Returns null for bytes this device cannot decode — never a 1x1 that would read as success.
     */
    fun decode(
        bytes: ByteArray,
        contentFit: String?,
        displayWidth: Double,
        displayHeight: Double,
        density: Double,
        allowDownscaling: Boolean = true,
    ): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(
                contentFit, bounds.outWidth, bounds.outHeight,
                displayWidth, displayHeight, density, allowDownscaling,
            )
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    /** The media type `on:load` reports, sniffed from the container rather than the URL, because
     *  a CDN serving WebP from a `.jpg` path is common and the URL would lie. */
    fun mediaType(bytes: ByteArray): String {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        return ImageCore.imageMediaType(bounds.outMimeType)
    }

    // ------------------------------------------------------------------ placeholder

    /**
     * A decoded blurhash/thumbhash as a real Bitmap. Built straight from the core's RGBA rather
     * than through a RenderScript blur, so the placeholder this device paints is byte-identical
     * to the one the corpus pins and the one the other two renderers paint.
     */
    fun placeholderBitmap(placeholder: String?, width: Int = 32, height: Int = 32): Bitmap? {
        val resolved = ImageCore.classifyPlaceholder(placeholder)
        if (resolved.kind != "blurhash" && resolved.kind != "thumbhash") return null
        val pixels = ImageCore.decodePlaceholder(resolved, width, height) ?: return null
        val argb = IntArray(pixels.width * pixels.height)
        for (index in argb.indices) {
            val offset = index * 4
            argb[index] = AndroidColor.argb(
                pixels.rgba[offset + 3], pixels.rgba[offset], pixels.rgba[offset + 1], pixels.rgba[offset + 2],
            )
        }
        return Bitmap.createBitmap(argb, pixels.width, pixels.height, Bitmap.Config.ARGB_8888)
    }

    /** The colour a `placeholder="#rrggbb"` / semantic word resolves to, or null when the
     *  placeholder is not a colour at all. */
    fun placeholderColor(placeholder: String?): Color? {
        val resolved = ImageCore.classifyPlaceholder(placeholder)
        if (resolved.kind != "color") return null
        return StackStyle.color(resolved.value)
    }

    // ------------------------------------------------------------------ the fold

    /**
     * The whole `<image>` attribute table, resolved once. The fields are the corpus's own
     * vocabulary so a reader can check the renderer against the fixture line by line.
     */
    data class Plan(
        val contentFit: String,
        val scale: ContentScale,
        val alignment: Alignment,
        val cache: ImageCore.CacheResolution,
        val transition: ImageCore.Transition,
        val priority: String,
        val allowDownscaling: Boolean,
        val placeholder: ImageCore.Placeholder,
        val recyclingKey: String,
        val recycled: Boolean,
        val blurRadius: Float,
        val tint: Color?,
        val fallback: String?,
        val decorative: Boolean,
    )

    fun plan(
        attributes: Map<String, String?>,
        rowKey: String? = null,
        previousKey: String? = null,
    ): Plan {
        val contentFit = ImageCore.resolveContentFit(attributes["contentFit"])
        val recycling = ImageCore.resolveRecycling(
            recyclingKey = attributes["recyclingKey"],
            rowKey = rowKey,
            src = attributes["src"],
            asset = attributes["asset"],
            previousKey = previousKey,
        )
        val blur = attributes["blurRadius"]?.toDoubleOrNull() ?: 0.0
        val tint = attributes["tint"]
        return Plan(
            contentFit = contentFit,
            scale = contentScale(contentFit),
            alignment = alignment(attributes["contentPosition"]),
            cache = ImageCore.resolveCachePolicy(attributes["cachePolicy"], attributes["cache"]),
            transition = ImageCore.resolveTransition(attributes["transition"]),
            priority = ImageCore.resolveImagePriority(attributes["priority"]),
            // Absent is TRUE: decoding at display size is what an author should have to opt OUT
            // of, because the opt-in version is the one nobody remembers to write.
            allowDownscaling = (attributes["allowDownscaling"] ?: "true") != "false",
            placeholder = ImageCore.classifyPlaceholder(attributes["placeholder"]),
            recyclingKey = recycling.key,
            // THE BUG THIS FIXES: the row was reused and the OLD image is still painted under
            // the new row's text. `recycled` is the caller's signal to drop the displayed bitmap
            // in the SAME composition, not when the new bytes land.
            recycled = recycling.clear && previousKey != null,
            blurRadius = if (blur.isFinite() && blur > 0) blur.toFloat() else 0f,
            tint = if (tint.isNullOrEmpty()) null else StackStyle.color(tint),
            fallback = attributes["fallback"],
            decorative = attributes["a11yLabel"] == null,
        )
    }

    /**
     * THE RULE THAT MAKES A FAST APP LOOK FAST, as the fade duration a view should actually run.
     * 0 means "appear in this frame" — an image already decoded in memory must not fade, and
     * fading it is the tell that an app is doing theatre instead of work.
     */
    fun fadeMillis(plan: Plan, cacheType: String): Int =
        if (ImageCore.shouldTransition(plan.transition, cacheType)) plan.transition.duration else 0

    /** Where the bytes were found, in the vocabulary `on:load` reports. */
    fun cacheType(plan: Plan, inMemory: Boolean, onDisk: Boolean): String =
        ImageCore.cacheTypeFor(plan.cache, inMemory, onDisk)

    /** `on:load`'s payload, assembled by the core so all three renderers report one shape. */
    fun loadPayload(bitmap: Bitmap, mediaType: String, cacheType: String): Map<String, Any?> = mapOf(
        "width" to bitmap.width.toDouble(),
        "height" to bitmap.height.toDouble(),
        "mediaType" to ImageCore.imageMediaType(mediaType),
        "cacheType" to cacheType,
    )
}
