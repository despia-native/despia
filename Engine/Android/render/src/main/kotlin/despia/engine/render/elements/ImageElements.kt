//
//  ImageElements.kt — the REAL `<image>` (Kotlin twin of Image.swift + DSXImageCache.swift),
//  registered PRIVILEGED so it shadows the renderer's placeholder branch (the sanctioned
//  slot — StackNodeView.kt's own header). Source ladder, iOS order:
//
//    icon=/systemImage=  → the sf-map render ladder (StackIcons.kt) — iconSize/fontSize
//                          (default 24), color (default `label` — system-defaults base pass).
//    asset=              → a BUNDLED image (APK assets `<name>[.png/.jpg/.webp]`) —
//                          synchronous decode, no placeholder flash,
//                          fit (brand assets must never crop), exactly UIImage(named:).
//    src=                → a REMOTE image, cached BY DEFAULT through the tiers: memory
//                          (LruCache, 200 entries — the NSCache countLimit twin) → disk →
//                          network. DECISION (vs Coil): zero new dependency — the disk +
//                          single-flight download tiers ride the CONTENT PLANE's
//                          single-URL plane (`DSXContent.cachedFile`/`freshFile` — CAS
//                          blobs, OS-purgeable, deduped, one in-flight transfer per URL),
//                          which is the platform's own DSXImageCache successor. Decoded
//                          off-main; a cold load fades in over 0.15 s (easeIn), a warm
//                          mount renders on its first frame. Failure keeps the
//                          placeholder (fail-open). `cache="none"` skips the tiers and
//                          revalidates over the network every time (the AsyncImage twin).
//                          GIFs decode ANIMATED via ImageDecoder on API 28+ (looping,
//                          fit-center) — the SwiftyGif capability, now built in; API
//                          24-27 degrades to the static first frame (pinned, not silent).
//    (none)              → the iOS placeholder fill (white 6%).
//
//  Default sizing (the scaledToFill-under-a-proposal twin): unsized → fillMaxWidth at the
//  bitmap's aspect; one axis sized → the other follows the aspect; both sized (or an
//  explicit aspectRatio/grow) → the box rules and the content CROPS to fill, like iOS.
//
//  ACCESSIBILITY (Image.swift's own header): an image with no `a11yLabel` is DECORATIVE.
//  Bitmap paths pass `contentDescription = null` (the Compose convention iOS names); the
//  ICON path additionally clears the glyph's text semantics — the raw PUA char would read
//  as junk — while an authored `a11yLabel` still announces through the style chain's
//  semantics (step 18), which sit outside the clear. The placeholder is inert semantics-
//  free structure, iOS's `.accessibilityHidden(true)`.
//

package despia.engine.render.elements

import android.content.Context
import android.app.ActivityManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.util.LruCache
import android.widget.ImageView
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.graphics.drawable.toDrawable
import despia.engine.DSXContent
import despia.engine.kernelLog
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackMotion
import despia.engine.render.StackStyle
import java.util.Collections
import java.util.WeakHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal fun registerImageElements() {
    ComposeStackComponents.definePrivileged("image") { ctx -> ImageElementView(ctx) }
}

/// The cold-load fade curve — SwiftUI `.easeIn` EXACTLY (DSXImageCache.swift:228 fades a
/// landed image in with `.easeIn(duration: 0.15)`); bezier from StackMotion.EASE_IN.
private val imageFadeEasing = CubicBezierEasing(
    StackMotion.EASE_IN[0], StackMotion.EASE_IN[1], StackMotion.EASE_IN[2], StackMotion.EASE_IN[3])

/// The memory tier is byte-cost bounded, not just entry-count bounded: a few hostile
/// high-resolution images cannot pin hundreds of MiB. Lightbox shares this cache.
private const val IMAGE_MEMORY_KIB = 64 * 1_024
private val decodedCosts = Collections.synchronizedMap(WeakHashMap<Drawable, Int>())
internal val imageMemory = object : LruCache<String, Drawable>(IMAGE_MEMORY_KIB) {
    override fun sizeOf(key: String, value: Drawable): Int = decodedCosts[value] ?: 1
}

@Composable
private fun ImageElementView(ctx: ComposeStackComponentContext) {
    val styled = Modifier.elementModifier(ctx)

    // ── icon=/systemImage= — the sf-map ladder (byte-compatible with the old branch) ──
    val icon = ctx.interp("icon") ?: ctx.interp("systemImage")
    if (!icon.isNullOrEmpty()) {
        val iconSize = ctx.num("iconSize") ?: ctx.num("fontSize") ?: ElementDefaults.IMAGE_ICON_SIZE
        // Image.swift:28 `.accessibilityHidden(decorative)`: clear the glyph's OWN text
        // semantics (a raw PUA/fallback char reads as junk); an authored a11yLabel still
        // announces — the style chain's semantics (step 18) sit before this clear in the
        // chain and survive it (header, ACCESSIBILITY).
        StackIcon(icon, iconSize, StackStyle.color(ctx.str("color", ElementDefaults.IMAGE_COLOR)),
                  styled.clearAndSetSemantics { })
        return
    }

    val context = LocalContext.current

    // ── asset= — bundled, synchronous, FIT (brand assets never crop) ──
    val asset = ctx.interp("asset")
    if (!asset.isNullOrEmpty()) {
        val drawable = remember(asset) {
            imageMemory.get("asset:$asset") ?: loadAsset(context, asset)?.also {
                imageMemory.put("asset:$asset", it)
            }
        }
        if (drawable != null) {
            DrawableImage(drawable, styled.defaultSizing(ctx, drawable), ContentScale.Fit)
            return
        }
        Placeholder(styled)
        return
    }

    // ── src= — remote through the content-plane tiers (or cache="none" revalidate) ──
    val src = ctx.interp("src")
    if (!src.isNullOrEmpty()) {
        val cacheNone = ctx.interp("cache") == "none"   // the dsx.string twin — {{ }} resolves (Image.swift:42)
        var drawable by remember(src) { mutableStateOf(if (cacheNone) null else imageMemory.get(src)) }
        val warm = remember(src) { drawable != null }             // memory hit → first-frame render, no fade
        LaunchedEffect(src) {
            if (drawable == null) {
                val d = withContext(Dispatchers.IO) { loadRemote(context, src, cacheNone) }
                if (d != null) {
                    if (!cacheNone) imageMemory.put(src, d)
                    drawable = d
                }
            }
        }
        val d = drawable
        // Cold loads fade in over 0.15 s once the bytes land — the exact iOS curve
        // (imageFadeEasing above; was LinearEasing, a pinned-then-fixed drift).
        val alpha by animateFloatAsState(if (d != null) 1f else 0f,
                                         tween(150, easing = imageFadeEasing), label = "imageFade")
        if (d == null) { Placeholder(styled); return }
        DrawableImage(d, styled.defaultSizing(ctx, d).alpha(if (warm) 1f else alpha),
                      ContentScale.Crop)
        return
    }

    Placeholder(styled)
}

/// The iOS placeholder: a white-6% fill holding the element's styled slot.
@Composable
private fun Placeholder(modifier: Modifier) {
    Box(modifier.background(Color.White.copy(alpha = ElementDefaults.IMAGE_PLACEHOLDER_OPACITY.toFloat())))
}

/// Paint one decoded drawable — animated GIFs ride an ImageView (AnimatedImageDrawable
/// needs a callback host; fit-center letterbox, the SwiftyGif contract), everything else
/// a Compose Image at the given scale.
@Composable
private fun DrawableImage(d: Drawable, modifier: Modifier, scale: ContentScale) {
    // Keep every API-28-only symbol behind ImageApi28Impl. ART verifies this file's
    // class on API 24 during MainActivity startup, even before an <image> is mounted.
    // A guarded direct `is AnimatedImageDrawable` check is therefore not sufficient.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && ImageApi28Impl.isAnimated(d)) {
        AndroidView(
            modifier = modifier,
            factory = { c -> ImageView(c).apply { scaleType = ImageView.ScaleType.FIT_CENTER } },
            update = { iv ->
                ImageApi28Impl.installAndStart(iv, d)
            },
        )
        return
    }
    val bitmap = (d as? BitmapDrawable)?.bitmap
    if (bitmap != null) {
        Image(bitmap.asImageBitmap(), contentDescription = null, modifier = modifier, contentScale = scale)
    } else {
        Box(modifier)   // undecodable drawable type — keep the layout slot (fail-open)
    }
}

/// The default sizing contract (header): nothing when the author constrained both axes
/// (or set aspectRatio/grow); otherwise the drawable's aspect fills in the free axis.
private fun Modifier.defaultSizing(ctx: ComposeStackComponentContext, d: Drawable): Modifier {
    val a = ctx.attrs
    if (a["aspectRatio"] != null || a["grow"] != null) return this
    val hasW = a["width"] != null
    val hasH = a["height"] != null
    if (hasW && hasH) return this
    val iw = d.intrinsicWidth
    val ih = d.intrinsicHeight
    val aspect = if (iw > 0 && ih > 0) iw.toFloat() / ih.toFloat() else 1f
    return if (!hasW && !hasH) fillMaxWidth().aspectRatio(aspect)
           else aspectRatio(aspect)
}

// MARK: - the load half (IO thread; every failure returns null — the caller fails open)

/// asset= resolution: APK assets by name (bare, .png, .jpg, .webp). App/module build
/// tooling copies authored images into this namespace, so lookup stays deterministic and
/// shrinker-safe instead of reflecting over generated resource identifiers.
private fun loadAsset(context: Context, name: String): Drawable? = runCatching {
    val normalized = MediaInputPolicy.normalizedAssetPath(name) ?: return@runCatching null
    for (candidate in listOf(normalized, "$normalized.png", "$normalized.jpg", "$normalized.webp").distinct()) {
        val bytes = runCatching {
            context.assets.open(candidate).use {
                MediaInputPolicy.readBounded(it, MediaInputPolicy.MAXIMUM_ENCODED_IMAGE_BYTES)
            }
        }.getOrNull()
        if (bytes != null) return decodeImage(context, bytes)
    }
    // Cross-platform DSX components use the reserved AppLogo asset for the application brand.
    // Android already owns that value as the manifest's real launcher drawable; requiring a
    // second copied PNG makes the boot-sync screen silently lose its logo. Resolve this exact
    // platform adapter only after ordinary authored APK assets, so an explicit AppLogo file
    // still wins and every other missing asset keeps the normal placeholder behavior.
    if (ImageAssetPolicy.usesApplicationIconFallback(normalized)) {
        return applicationIconDrawable(context)
    }
    null
}.onFailure { kernelLog("[image] asset load failed for $name: $it") }.getOrNull()

internal object ImageAssetPolicy {
    fun usesApplicationIconFallback(name: String): Boolean = name == "AppLogo"
}

private fun applicationIconDrawable(context: Context): Drawable? = runCatching {
    val drawable = context.packageManager.getApplicationIcon(context.packageName)
    val launcherSide = context.getSystemService(ActivityManager::class.java)
        ?.launcherLargeIconSize
        ?: (192 * context.resources.displayMetrics.density).toInt()
    val side = maxOf(drawable.intrinsicWidth, drawable.intrinsicHeight, launcherSide, 1)
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    drawable.setBounds(0, 0, side, side)
    drawable.draw(Canvas(bitmap))
    bitmap.toDrawable(context.resources)
}.getOrNull()

/// src= resolution: http(s) rides the content plane's single-URL tiers (disk first,
/// network once, single-flight — `cache="none"` forces the network); anything else is an
/// APK asset, then a file path (the GIF loader's ladder). Internal: the Lightbox loads
/// its pages through the same path (see `imageMemory`).
internal suspend fun loadRemote(context: Context, src: String, cacheNone: Boolean): Drawable? = runCatching {
    val bytes: ByteArray? = when {
        MediaInputPolicy.validatedHttpURL(src) != null -> {
            val url = MediaInputPolicy.validatedHttpURL(src)!!
            (if (cacheNone) DSXContent.freshFile(url)
             else DSXContent.cachedFile(url) ?: DSXContent.freshFile(url))
                ?.takeIf { it.size <= MediaInputPolicy.MAXIMUM_ENCODED_IMAGE_BYTES }
        }
        else -> loadAssetBytes(context, src) ?: loadSandboxedFile(context, src)
    }
    bytes?.let { decodeImage(context, it) }
}.onFailure { kernelLog("[image] load failed for $src: $it") }.getOrNull()

/// Decode bytes: ImageDecoder on API 28+ (animated GIF/WebP come back as looping
/// AnimatedImageDrawable), BitmapFactory below (static first frame — pinned degradation).
private fun decodeImage(context: Context, bytes: ByteArray): Drawable? {
    if (bytes.isEmpty() || bytes.size > MediaInputPolicy.MAXIMUM_ENCODED_IMAGE_BYTES) return null
    val encodedFrames = MediaInputPolicy.encodedFrameCount(bytes) ?: return null
    if (encodedFrames !in 1..MediaInputPolicy.MAXIMUM_ANIMATION_FRAMES) return null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        ImageApi28Impl.decode(bytes, encodedFrames)?.let { decoded ->
            decodedCosts[decoded.drawable] =
                ((decoded.costBytes + 1_023L) / 1_024L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            return decoded.drawable
        }
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val target = MediaInputPolicy.targetDimensions(bounds.outWidth, bounds.outHeight, frames = 1) ?: return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= target.width &&
           bounds.outHeight / (sample * 2) >= target.height && sample <= Int.MAX_VALUE / 2) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
        inSampleSize = sample
    }) ?: return null
    val actual = MediaInputPolicy.targetDimensions(bmp.width, bmp.height, frames = 1)
    val cost = actual?.let(MediaInputPolicy::decodedCostBytes)
    if (actual == null || actual.width != bmp.width || actual.height != bmp.height || cost == null ||
        bmp.allocationByteCount.toLong() > MediaInputPolicy.MAXIMUM_DECODED_BYTES) {
        bmp.recycle()
        return null
    }
    return bmp.toDrawable(context.resources).also {
        decodedCosts[it] = ((cost + 1_023L) / 1_024L).toInt()
    }
}

private fun loadAssetBytes(context: Context, raw: String): ByteArray? {
    val name = MediaInputPolicy.normalizedAssetPath(raw) ?: return null
    return runCatching {
        context.assets.open(name).use {
            MediaInputPolicy.readBounded(it, MediaInputPolicy.MAXIMUM_ENCODED_IMAGE_BYTES)
        }
    }.getOrNull()
}

/// Local `src` is limited to regular, non-symlink files inside app-private data/cache roots.
/// Relative filesystem paths and every non-file URI scheme fail closed (APK assets are tried first).
private fun loadSandboxedFile(context: Context, raw: String): ByteArray? = runCatching {
    MediaInputPolicy.readSandboxedRegularFile(
        raw, MediaInputPolicy.appPrivateRoots(context), MediaInputPolicy.MAXIMUM_ENCODED_IMAGE_BYTES)
}.getOrNull()
