//
//  Lightbox.kt — `<lightbox>`: the full-screen photo viewer. Kotlin twin of Foundation
//  Structure/Lightbox/Lightbox.swift — same attribute contract:
//    present= (two-way Bool key) · images= (bound list) + srcField= (default "src") ·
//    urls= (CSV alternative) · index= (two-way Int page key) · color= (chrome tint,
//    default white) · on:dismiss.
//
//  Behavior/geometry pinned from the Swift source:
//    • black backdrop whose opacity fades with the vertical drag —
//      1 − min(|dragOffset| / 600, 0.6) (Lightbox.swift body).
//    • swipeable pages (paged TabView → HorizontalPager); un-zoomed vertical drag follows
//      the finger and DISMISSES past 120dp (spring back below it; iOS also honors a
//      predicted fling > 300 — deferred, threshold-only here).
//    • pinch-to-zoom 1×…4×, pan while zoomed, double-tap toggles 1× ↔ 2.5× (0.3s spring);
//      zoom locks paging + the dismiss drag; chrome hides while zoomed.
//    • chrome: counter "n / m" (15 semibold, tint — subheadline) when > 1 page; close =
//      xmark 16 on a 10dp-padded ultraThin-glass circle; row padding h16 / top8.
//    • a settled page swipe writes `index` back (the two-way Int key); the viewer OPENS
//      at the bound index (clamped), like the Swift init.
//
//  PAGE LOADING (DSXImageCache parity): pages load through the SHARED `<image>` path
//  (ImageElements.kt) — the 200-entry memory LruCache, then the content plane's
//  disk/single-flight tiers (`DSXContent.cachedFile`/`freshFile`) — one image cache for
//  the whole renderer, exactly like iOS pages riding DSXImageCache.
//
//  ── DEVIATIONS (pinned) ──────────────────────────────────────────────────────────────
//  • An animated source (API 28+ GIF/WebP decodes to AnimatedImageDrawable) shows its
//    FIRST frame in the viewer — the zoom/pan pipeline is bitmap-based (and matches the
//    old BitmapFactory behavior). A failed load keeps the shared 6%-white cache placeholder,
//    matching CachedRemoteImage instead of silently producing an all-black page.
//  • BACK dismisses (Android contract); pinch uses the multi-touch pointer events
//    directly so single-finger drags stay the pager's (the .simultaneousGesture split).
//

package despia.engine.render.elements

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.createBitmap
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleActivation
import despia.engine.render.dsxAccessibleDismiss
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt

internal fun registerLightboxElement() {
    ComposeStackComponents.defineNative("lightbox") { ctx -> LightboxElement(ctx) }
}

/// Sources: a bound list (`images` + `srcField`, default "src"), else the `urls` CSV —
/// Lightbox.swift's exact ladder.
internal fun lightboxUrls(el: El): List<String> {
    if (el.ctx.attrs.containsKey("images")) {
        val field = el.ctx.attrs["srcField"] ?: "src"
        return el.list("images").mapNotNull { r -> JSE.string(r[field] ?: "").ifEmpty { null } }
    }
    return el.str("urls").split(",").map { it.trim() }.filter { it.isNotEmpty() }
}

@Composable
private fun LightboxElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["present"] ?: ""
    val present = el.presented(key)
    FireOnDismiss(present, el)
    if (!present) return                                                    // the inert zero-size anchor

    val urls = lightboxUrls(el)
    val indexKey = ctx.attrs["index"] ?: ""
    val tint = el.color("color", "white")
    fun close() = el.dismissBound()

    FullScreenLayer(onDismissRequest = { close() }) {
        val start = (if (indexKey.isEmpty()) 0 else JSE.number(el.ctl.boundValue(indexKey))?.toInt() ?: 0)
            .coerceIn(0, maxOf(urls.size - 1, 0))
        val pager = rememberPagerState(initialPage = start) { urls.size }
        var dragOffset by remember { mutableFloatStateOf(0f) }               // the dismiss drag (px)
        var zoomed by remember { mutableStateOf(false) }
        val density = androidx.compose.ui.platform.LocalDensity.current

        // Backdrop fades as the photo slides (1 − min(|drag|/600, 0.6), points → dp).
        val dragDp = with(density) { dragOffset.toDp().value }
        Box(Modifier.fillMaxSize().background(
            Color.Black.copy(alpha = (1f - minOf(abs(dragDp) / 600f, 0.6f)).coerceIn(0f, 1f))))

        // A settled swipe writes the two-way index back (never for the opening page).
        if (indexKey.isNotEmpty()) {
            LaunchedEffect(pager.settledPage) {
                if (pager.settledPage != JSE.number(el.ctl.boundValue(indexKey))?.toInt()) {
                    el.ctl.setBound(indexKey, pager.settledPage.toDouble())
                }
            }
        }

        HorizontalPager(pager, Modifier.fillMaxSize()
            .offset { IntOffset(0, dragOffset.roundToInt()) }
            .dsxAccessibleDismiss { close() }
            .pointerInput(zoomed) {                                          // un-zoomed drag-down dismiss
                detectVerticalDragGestures(
                    onDragEnd = {
                        if (abs(dragOffset) > 120.dp.toPx()) close()
                        else dragOffset = 0f                                 // spring-back (snap — the spring is cosmetic)
                    },
                    onDragCancel = { dragOffset = 0f },
                ) { change, dy ->
                    if (!zoomed) { change.consume(); dragOffset += dy }
                }
            }
        ) { i ->
            ZoomablePhoto(urls[i], onZoom = { zoomed = it })
        }

        if (!zoomed) {
            Row(Modifier.align(Alignment.TopCenter).fillMaxWidth()
                    .windowInsetsPadding(
                        WindowInsets.safeDrawing.only(
                            WindowInsetsSides.Top + WindowInsetsSides.Horizontal,
                        ),
                    )
                    .padding(start = 16.dp, end = 16.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                if (urls.size > 1) {
                    BasicText("${pager.currentPage + 1} / ${urls.size}",
                              style = TextStyle(color = tint, fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                }
                Spacer(Modifier.weight(1f))
                Box(Modifier.background(StackStyle.material("glass"), CircleShape).padding(10.dp)
                        .dsxAccessibleActivation(
                            role = Role.Button,
                            contentDescription = DSXStrings.localize("Close"),
                            mergeDescendants = false,
                            onClick = { close() },
                        )
                        .pointerInput(Unit) { detectTapGestures { close() } },
                    contentAlignment = Alignment.Center) {
                    StackIcon("xmark", 16.0, tint)
                }
            }
        }
    }
}

/// One photo page: cached image, pinch 1×…4× + pan while zoomed (multi-touch only — a
/// 1× single-finger drag stays the pager's), double-tap 1× ↔ 2.5×.
@Composable
private fun ZoomablePhoto(url: String, onZoom: (Boolean) -> Unit) {
    var scale by remember(url) { mutableFloatStateOf(1f) }
    var offset by remember(url) { mutableStateOf(Offset.Zero) }
    fun setZoom(z: Boolean) = onZoom(z)
    fun toggleZoom() {
        val target = if (scale > 1.01f) 1f else 2.5f
        scale = target
        if (target == 1f) offset = Offset.Zero
        setZoom(target > 1f)
    }

    val bitmap = rememberLightboxImage(url)
    Box(
        Modifier.fillMaxSize()
            .dsxAccessibleActivation(
                role = Role.Button,
                contentDescription = DSXStrings.localize("Photo"),
                stateDescription = DSXStrings.localize(
                    if (scale > 1.01f) "Zoomed" else "Not zoomed",
                ),
                onClickLabel = DSXStrings.localize("Toggle zoom"),
                onClick = { toggleZoom() },
            )
            .pointerInput(url) {
                detectTapGestures(onDoubleTap = { toggleZoom() })
            }
            .pointerInput(url) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.count { it.pressed }
                        if (pressed >= 2) {                                   // the pinch (+ anchored pan)
                            scale = (scale * event.calculateZoom()).coerceIn(1f, 4f)
                            if (scale > 1.01f) offset += event.calculatePan()
                            setZoom(scale > 1.01f)
                            event.changes.forEach { it.consume() }
                        } else if (pressed == 1 && scale > 1.01f) {           // pan only while zoomed
                            offset += event.calculatePan()
                            event.changes.forEach { it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                    if (scale <= 1.01f) { scale = 1f; offset = Offset.Zero; setZoom(false) }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) {
            Image(bitmap, contentDescription = null,
                  modifier = Modifier.fillMaxSize().graphicsLayer {
                      scaleX = scale; scaleY = scale
                      translationX = offset.x; translationY = offset.y
                  },
                  contentScale = ContentScale.Fit)
        } else {
            // CachedRemoteImage's exact fail-open placeholder. This is deliberately neutral,
            // local, and stable: a missing fixture asset must still produce observable pixels.
            Box(
                Modifier.fillMaxSize().background(
                    Color.White.copy(alpha = LIGHTBOX_PLACEHOLDER_ALPHA)
                )
            )
        }
    }
}

internal const val LIGHTBOX_PLACEHOLDER_ALPHA = 0.06f

// MARK: - page loading (the SHARED `<image>` path — see the header's PAGE LOADING)

/// One page's bitmap: the shared memory tier first, then the shared loader (content-plane
/// disk → network, single-flight) — populating the memory tier for `<image>` and the next
/// opening alike. Null until loaded (a black page — fail-open).
@Composable
private fun rememberLightboxImage(url: String): ImageBitmap? {
    val context = LocalContext.current
    var drawable by remember(url) { mutableStateOf(imageMemory.get(url)) }
    if (drawable == null) {
        LaunchedEffect(url) {
            val d = withContext(Dispatchers.IO) { loadRemote(context, url, cacheNone = false) }
            if (d != null) { imageMemory.put(url, d); drawable = d }
        }
    }
    val d = drawable
    return remember(d) { d?.pageBitmap() }
}

/// The cached Drawable as a page bitmap: a BitmapDrawable directly; anything else (an
/// animated GIF/WebP) rasterizes its FIRST frame (header DEVIATIONS). Null = fail-open.
private fun Drawable.pageBitmap(): ImageBitmap? {
    (this as? BitmapDrawable)?.bitmap?.let { return it.asImageBitmap() }
    val w = intrinsicWidth; val h = intrinsicHeight
    if (w <= 0 || h <= 0) return null
    val bmp = createBitmap(w, h, Bitmap.Config.ARGB_8888)
    setBounds(0, 0, w, h)
    draw(Canvas(bmp))
    return bmp.asImageBitmap()
}
