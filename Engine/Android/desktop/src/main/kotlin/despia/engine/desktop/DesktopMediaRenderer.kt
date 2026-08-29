@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package despia.engine.desktop

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.JSE
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jetbrains.skia.Data
import org.jetbrains.skia.Image as SkiaImage
import org.jetbrains.skia.svg.SVGDOM
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

private const val MAX_RASTER_BYTES = 8L * 1024L * 1024L
private const val MAX_RASTER_DIMENSION = 8_192
private const val MAX_RASTER_PIXELS = 32L * 1024L * 1024L
private const val MAX_SVG_BYTES = 512 * 1024
private const val MAX_ASSET_NAME = 240

/** Native Compose entry for DSX's eight media/data tags. No branch embeds a browser. */
@Composable
@Suppress("UNUSED_PARAMETER")
internal fun DesktopMediaElement(context: DesktopElementContext, authoredModifier: Modifier, disabled: Boolean) {
    // on:tap/on:longpress are installed once by desktopUniversalModifier. Keeping
    // media rendering passive prevents one pointer event from reaching both a media
    // wrapper and the universal accessibility/keyboard interaction layer.
    val modifier = authoredModifier
    when (context.node.tag) {
        "image" -> DesktopImage(context, modifier)
        "svg" -> DesktopSvg(context, modifier)
        "qrcode" -> DesktopQrCode(context, modifier)
        "chart" -> DesktopChart(context, modifier)
        "map" -> DesktopMap(context, modifier)
        "audio" -> DesktopNativeAudio(context, modifier)
        "video" -> DesktopNativeVideo(context, modifier)
        "lottie" -> DesktopNativeLottie(context, modifier)
    }
}

internal data class DesktopMediaSourceStatus(
    val allowed: Boolean,
    val host: String?,
    val reason: String,
)

/** Returns display-safe metadata only: credentials, paths, query, and fragment never
 * leave the validator, so a diagnostic surface cannot echo a bearer URL. */
internal fun desktopMediaSourceStatus(raw: String?): DesktopMediaSourceStatus {
    if (raw.isNullOrBlank()) return DesktopMediaSourceStatus(false, null, "source_missing")
    return try {
        val uri = DesktopNetwork.validateAnonymousMediaUrl(raw.trim())
        DesktopMediaSourceStatus(true, displayHost(uri), "accepted")
    } catch (_: Throwable) {
        DesktopMediaSourceStatus(false, null, "source_blocked")
    }
}

private fun displayHost(uri: URI): String {
    val port = uri.port
    val defaultPort = uri.scheme.equals("https", true) && port == 443 || uri.scheme.equals("http", true) && port == 80
    return if (port < 0 || defaultPort) uri.host else "${uri.host}:$port"
}

private sealed interface DesktopImageState {
    data object Loading : DesktopImageState
    data class Ready(val image: ImageBitmap, val animatedFirstFrame: Boolean) : DesktopImageState
    data class Failure(val reason: String) : DesktopImageState
}

internal data class DesktopRaster(
    val image: ImageBitmap,
    val width: Int,
    val height: Int,
    val animatedFirstFrame: Boolean,
)

private object DesktopRasterCache {
    private const val MAX_COST = 64L * 1024L * 1024L
    private val entries = object : LinkedHashMap<String, DesktopRaster>(16, 0.75f, true) {}
    private var cost = 0L

    @Synchronized
    fun get(key: String): DesktopRaster? = entries[key]

    @Synchronized
    fun put(key: String, value: DesktopRaster) {
        entries.remove(key)?.let { cost -= it.width.toLong() * it.height * 4L }
        entries[key] = value
        cost += value.width.toLong() * value.height * 4L
        while (cost > MAX_COST || entries.size > 32) {
            val first = entries.entries.firstOrNull() ?: break
            cost -= first.value.width.toLong() * first.value.height * 4L
            entries.remove(first.key)
        }
    }
}

@Composable
private fun DesktopImage(context: DesktopElementContext, modifier: Modifier) {
    val attrs = context.attributes
    val asset = attrs["asset"]?.trim().orEmpty()
    val src = attrs["src"]?.trim().orEmpty()
    val icon = attrs["icon"] ?: attrs["systemImage"]
    if (asset.isEmpty() && src.isEmpty()) {
        val iconSize = safeNumber(attrs["iconSize"] ?: attrs["fontSize"], 24f).coerceIn(8f, 256f)
        if (!icon.isNullOrBlank()) {
            Box(
                modifier.then(Modifier.size(iconSize.dp)).semantics { contentDescription = attrs["a11yLabel"] ?: icon },
                contentAlignment = Alignment.Center,
            ) {
                Text(desktopIconGlyph(icon), color = desktopMediaColor(attrs["color"] ?: "label"), fontSize = iconSize.sp)
            }
        } else {
            DesktopMediaStateCard(modifier, attrs, "Image", "No image source", "Add asset= or an HTTPS src=", 120f)
        }
        return
    }

    val key = if (asset.isNotEmpty()) "asset:$asset" else "url:$src"
    val useCache = attrs["cache"] != "none"
    val state by produceState<DesktopImageState>(DesktopImageState.Loading, key, useCache) {
        val cached = if (useCache) DesktopRasterCache.get(key) else null
        if (cached != null) {
            value = DesktopImageState.Ready(cached.image, cached.animatedFirstFrame)
            return@produceState
        }
        value = try {
            val raster = if (asset.isNotEmpty()) {
                val (bytes, contentType) = withContext(Dispatchers.IO) {
                    val data = loadDesktopAsset(asset, listOf("", ".png", ".jpg", ".jpeg", ".webp", ".gif"), MAX_RASTER_BYTES)
                        ?: throw IllegalArgumentException("asset_missing")
                    data to guessedImageType(asset, data)
                }
                withContext(Dispatchers.Default) { decodeDesktopRaster(bytes, contentType) }
                    ?: throw IllegalArgumentException("decode_failed")
            } else {
                loadDesktopRemoteRaster(src, useCache) ?: throw IllegalArgumentException("decode_failed")
            }
            if (useCache) DesktopRasterCache.put(key, raster)
            DesktopImageState.Ready(raster.image, raster.animatedFirstFrame)
        } catch (failure: Throwable) {
            DesktopImageState.Failure(safeMediaFailure(failure))
        }
    }
    LaunchedEffect(key, state::class) {
        when (state) {
            is DesktopImageState.Ready -> attrs["on:load"]?.let { context.run(it) }
            is DesktopImageState.Failure -> attrs["on:error"]?.let { context.run(it, mapOf("error" to (state as DesktopImageState.Failure).reason)) }
            DesktopImageState.Loading -> Unit
        }
    }

    val sized = desktopMediaSize(modifier, attrs, 220f)
        .semantics { contentDescription = attrs["a11yLabel"] ?: "Image" }
    when (val current = state) {
        DesktopImageState.Loading -> Box(sized.background(MaterialTheme.colors.onSurface.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
        }
        is DesktopImageState.Ready -> Box(sized) {
            Image(
                bitmap = current.image,
                contentDescription = attrs["a11yLabel"],
                modifier = Modifier.fillMaxSize(),
                contentScale = when (attrs["contentMode"] ?: attrs["gravity"]) {
                    "fit", "contain" -> ContentScale.Fit
                    else -> if (asset.isNotEmpty()) ContentScale.Fit else ContentScale.Crop
                },
            )
            if (current.animatedFirstFrame) {
                Text(
                    "Static animation preview",
                    Modifier.align(Alignment.BottomStart).background(Color.Black.copy(alpha = 0.68f)).padding(6.dp),
                    color = Color.White,
                    fontSize = 10.sp,
                )
            }
        }
        is DesktopImageState.Failure -> DesktopMediaStateCard(sized, attrs, "Image unavailable", humanMediaFailure(current.reason), "The source was not rendered", 120f)
    }
}

internal fun decodeDesktopRaster(bytes: ByteArray, contentType: String = ""): DesktopRaster? = runCatching {
    if (bytes.isEmpty() || bytes.size.toLong() > MAX_RASTER_BYTES) return@runCatching null
    val encoded = SkiaImage.makeFromEncoded(bytes)
    try {
        val width = encoded.width
        val height = encoded.height
        if (width !in 1..MAX_RASTER_DIMENSION || height !in 1..MAX_RASTER_DIMENSION ||
            width.toLong() * height > MAX_RASTER_PIXELS) return@runCatching null
        DesktopRaster(
            image = encoded.toComposeImageBitmap(),
            width = width,
            height = height,
            animatedFirstFrame = contentType == "image/gif" || isAnimatedImage(bytes),
        )
    } finally {
        encoded.close()
    }
}.getOrNull()

/** Shared remote-raster primitive for native desktop elements such as lightbox.
 * It accepts only anonymous HTTPS/loopback traffic, enforces MIME/byte/pixel bounds,
 * follows the hardened redirect validator, and never exposes the source URL. */
internal suspend fun loadDesktopRemoteRaster(source: String, useCache: Boolean = true): DesktopRaster? {
    val key = "url:${source.trim()}"
    if (useCache) DesktopRasterCache.get(key)?.let { return it }
    val status = desktopMediaSourceStatus(source)
    if (!status.allowed) return null
    val response = runCatching { DesktopNetwork.fetchAnonymousMedia(source, MAX_RASTER_BYTES) }.getOrNull() ?: return null
    if (response.status !in 200..299 || !response.contentType.startsWith("image/") || response.contentType == "image/svg+xml") return null
    val decoded = withContext(Dispatchers.Default) { decodeDesktopRaster(response.body, response.contentType) } ?: return null
    if (useCache) DesktopRasterCache.put(key, decoded)
    return decoded
}

private fun isAnimatedImage(bytes: ByteArray): Boolean =
    bytes.size >= 6 && (bytes.copyOfRange(0, 6).toString(Charsets.US_ASCII) == "GIF87a" ||
        bytes.copyOfRange(0, 6).toString(Charsets.US_ASCII) == "GIF89a")

private fun guessedImageType(name: String, bytes: ByteArray): String = when {
    isAnimatedImage(bytes) -> "image/gif"
    name.lowercase(Locale.ROOT).endsWith(".webp") -> "image/webp"
    name.lowercase(Locale.ROOT).endsWith(".jpg") || name.lowercase(Locale.ROOT).endsWith(".jpeg") -> "image/jpeg"
    else -> "image/png"
}

@Composable
private fun DesktopSvg(context: DesktopElementContext, modifier: Modifier) {
    val attrs = context.attributes
    val markup = remember(attrs["asset"], attrs["src"], attrs["d"], attrs["viewBox"], attrs["fill"]) {
        resolveDesktopSvgMarkup(attrs)
    }
    val dom = remember(markup) { markup?.let(::parseDesktopSvg) }
    DisposableEffect(dom) { onDispose { dom?.close() } }
    if (dom == null) {
        DesktopMediaStateCard(modifier, attrs, "SVG unavailable", if (markup == null) "No safe SVG source" else "SVG decode failed", "Only native static SVG is accepted", 160f)
        return
    }
    val aspect = svgAspect(requireNotNull(markup)).coerceIn(0.1f, 10f)
    val defaultHeight = (220f / aspect).coerceIn(80f, 360f)
    Canvas(desktopMediaSize(modifier, attrs, defaultHeight).semantics { contentDescription = attrs["a11yLabel"] ?: "SVG image" }) {
        runCatching {
            dom.setContainerSize(size.width, size.height)
            dom.render(drawContext.canvas.nativeCanvas)
        }
    }
}

private fun parseDesktopSvg(markup: String): SVGDOM? = runCatching {
    val bytes = markup.toByteArray(Charsets.UTF_8)
    if (bytes.size > MAX_SVG_BYTES) return@runCatching null
    Data.makeFromBytes(bytes).use { SVGDOM(it) }
}.getOrNull()

internal fun resolveDesktopSvgMarkup(attrs: Map<String, String>): String? {
    val asset = attrs["asset"]?.trim().orEmpty()
    if (asset.isNotEmpty()) {
        val bytes = loadDesktopAsset(asset, listOf("", ".svg"), MAX_SVG_BYTES.toLong()) ?: return null
        return bytes.toString(Charsets.UTF_8).takeIf(::isSafeDesktopSvg)
    }
    val src = attrs["src"]?.trim().orEmpty()
    if (src.isNotEmpty()) {
        if (src.contains("<svg", ignoreCase = true) || src.contains("<path", ignoreCase = true)) {
            return src.takeIf(::isSafeDesktopSvg)
        }
        val bytes = loadDesktopAsset(src, listOf("", ".svg"), MAX_SVG_BYTES.toLong()) ?: return null
        return bytes.toString(Charsets.UTF_8).takeIf(::isSafeDesktopSvg)
    }
    val path = attrs["d"] ?: return null
    val viewBox = xmlAttribute(attrs["viewBox"] ?: "0 0 100 100")
    val fill = xmlAttribute(attrs["fill"] ?: "#000000")
    val generated = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"$viewBox\"><path d=\"${xmlAttribute(path)}\" fill=\"$fill\"/></svg>"
    return generated.takeIf(::isSafeDesktopSvg)
}

internal fun isSafeDesktopSvg(markup: String): Boolean {
    if (markup.toByteArray(Charsets.UTF_8).size > MAX_SVG_BYTES || !markup.contains("<svg", ignoreCase = true)) return false
    val lowered = markup.lowercase(Locale.ROOT)
    if (listOf("<!doctype", "<!entity", "<?xml-stylesheet", "javascript:").any(lowered::contains)) return false
    val activeOrExternal = listOf(
        Regex("""<\s*(?:[a-z_][a-z0-9_.-]*:)?(?:script|foreignobject|iframe|object|embed|image|use|feimage|style|animate|animatemotion|animatetransform|set)\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(?:xlink:)?href\s*=""", RegexOption.IGNORE_CASE),
        Regex("""\b(?:src|data)\s*=""", RegexOption.IGNORE_CASE),
        Regex("""\burl\s*\(""", RegexOption.IGNORE_CASE),
        Regex("""@import\b""", RegexOption.IGNORE_CASE),
        Regex("""\bon[a-z0-9_-]+\s*=""", RegexOption.IGNORE_CASE),
    )
    return activeOrExternal.none { it.containsMatchIn(markup) }
}

private fun svgAspect(markup: String): Float {
    val match = Regex("viewBox\\s*=\\s*['\"]\\s*([-+0-9.eE]+)[ ,]+([-+0-9.eE]+)[ ,]+([-+0-9.eE]+)[ ,]+([-+0-9.eE]+)", RegexOption.IGNORE_CASE).find(markup)
        ?: return 1f
    val width = match.groupValues[3].toFloatOrNull() ?: return 1f
    val height = match.groupValues[4].toFloatOrNull() ?: return 1f
    return if (width.isFinite() && height.isFinite() && width > 0f && height > 0f) width / height else 1f
}

private fun xmlAttribute(raw: String): String = raw.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")

internal const val DESKTOP_QR_QUIET_ZONE_MODULES = 4

internal data class DesktopQrGeometry(
    val cell: Float,
    val quiet: Float,
    val totalSpan: Float,
)

/** QR Code ISO/IEC 18004 requires a light quiet zone four modules wide on all
 * sides. Expressing the canvas in module units keeps that invariant true at every
 * symbol version and rendered size instead of approximating it with a percentage. */
internal fun desktopQrGeometry(side: Float, moduleCount: Int): DesktopQrGeometry {
    require(side.isFinite() && side > 0f) { "QR side must be positive and finite" }
    require(moduleCount > 0) { "QR matrix must contain modules" }
    val totalModules = moduleCount + DESKTOP_QR_QUIET_ZONE_MODULES * 2
    val cell = side / totalModules
    return DesktopQrGeometry(
        cell = cell,
        quiet = cell * DESKTOP_QR_QUIET_ZONE_MODULES,
        totalSpan = cell * totalModules,
    )
}

@Composable
private fun DesktopQrCode(context: DesktopElementContext, modifier: Modifier) {
    val attrs = context.attributes
    val value = attrs["value"].orEmpty()
    val matrix = remember(value, attrs["correction"]) { DesktopQrEncoder.encode(value, attrs["correction"]) }
    if (matrix == null) {
        DesktopMediaStateCard(modifier, attrs, "QR code unavailable", if (value.isEmpty()) "Value is missing" else "Payload is too large", "No invalid matrix was drawn", 160f)
        return
    }
    val side = safeNumber(attrs["size"] ?: attrs["width"] ?: attrs["height"], 200f).coerceIn(40f, 2_048f)
    val foreground = desktopMediaColor(attrs["color"] ?: "black")
    val background = desktopMediaColor(attrs["background"] ?: "white")
    Canvas(modifier.then(Modifier.size(side.dp)).semantics { contentDescription = attrs["a11yLabel"] ?: "QR code" }) {
        drawRect(background)
        val geometry = desktopQrGeometry(size.minDimension, matrix.size)
        val origin = Offset(
            x = (size.width - geometry.totalSpan) / 2f + geometry.quiet,
            y = (size.height - geometry.totalSpan) / 2f + geometry.quiet,
        )
        matrix.forEachIndexed { row, values ->
            values.forEachIndexed { column, dark ->
                if (dark) drawRect(
                    foreground,
                    topLeft = Offset(origin.x + column * geometry.cell, origin.y + row * geometry.cell),
                    size = Size(geometry.cell, geometry.cell),
                )
            }
        }
    }
}

internal data class DesktopChartPoint(val x: String, val y: Double)
internal data class DesktopChartSeries(val name: String, val points: List<DesktopChartPoint>)

internal fun desktopChartSeries(raw: Any?, attrs: Map<String, String>): List<DesktopChartSeries> {
    val rows = raw as? List<*> ?: return emptyList()
    val xKey = attrs["x"]?.takeIf(String::isNotBlank) ?: "x"
    val yKey = attrs["y"]?.takeIf(String::isNotBlank) ?: "y"
    val seriesKey = attrs["series"]?.takeIf(String::isNotBlank)
    val groups = LinkedHashMap<String, MutableList<DesktopChartPoint>>()
    rows.take(10_000).forEachIndexed { index, entry ->
        val row = entry as? Map<*, *> ?: return@forEachIndexed
        val y = JSE.number(row[yKey])?.takeIf(Double::isFinite) ?: return@forEachIndexed
        val x = row[xKey]?.let(JSE::string)?.take(128) ?: (index + 1).toString()
        val series = seriesKey?.let { row[it] }?.let(JSE::string)?.take(128).orEmpty().ifEmpty { "Series" }
        groups.getOrPut(series) { ArrayList() } += DesktopChartPoint(x, y)
    }
    return groups.entries.take(24).map { DesktopChartSeries(it.key, it.value) }
}

@Composable
private fun DesktopChart(context: DesktopElementContext, modifier: Modifier) {
    val attrs = context.attributes
    val expression = context.node.attrs["data"] ?: attrs["data"]
    val raw = expression?.let { JSE.eval(unwrappedExpression(it), context.store, context.item) }
    val series = remember(raw, attrs["x"], attrs["y"], attrs["series"]) { desktopChartSeries(raw, attrs) }
    if (series.isEmpty()) {
        DesktopMediaStateCard(modifier, attrs, "Chart", "No numeric data", "Set data= with x/y rows", 220f)
        return
    }
    val values = series.flatMap { it.points }.map { it.y }
    var minimum = values.minOrNull() ?: 0.0
    var maximum = values.maxOrNull() ?: 1.0
    if (minimum == maximum) {
        minimum -= max(1.0, abs(minimum) * 0.1)
        maximum += max(1.0, abs(maximum) * 0.1)
    }
    val paletteRaw = attrs["colors"]?.split(',')?.map(String::trim)?.filter(String::isNotEmpty).orEmpty()
    val palette = if (paletteRaw.isEmpty()) listOf(attrs["color"] ?: "accent", "#FF9500", "#34C759", "#AF52DE", "#FF3B30") else paletteRaw
    val colors = ArrayList<Color>(palette.size)
    for (rawColor in palette) colors += desktopMediaColor(rawColor)
    val type = attrs["type"]?.lowercase(Locale.ROOT).takeIf { it in setOf("line", "bar", "area", "point") } ?: "line"
    val lineWidth = safeNumber(attrs["lineWidth"], 2f).coerceIn(0.5f, 20f)
    val pointRadius = (safeNumber(attrs["pointSize"], 40f).coerceIn(4f, 256f) / 12f).coerceAtLeast(2f)
    val showPoints = attrs["showPoints"] == "true" || type == "point"
    val gridColor = MaterialTheme.colors.onSurface.copy(alpha = 0.12f)
    Box(desktopMediaSize(modifier, attrs, 240f).semantics { contentDescription = "${type.replaceFirstChar(Char::uppercase)} chart with ${values.size} points" }) {
        Canvas(Modifier.fillMaxSize()) {
            val left = 28f
            val top = 20f
            val right = size.width - 16f
            val bottom = size.height - 28f
            if (right <= left || bottom <= top) return@Canvas
            val width = right - left
            val height = bottom - top
            repeat(5) { index ->
                val y = top + height * index / 4f
                drawLine(gridColor, Offset(left, y), Offset(right, y), 1f)
            }
            val maxPoints = series.maxOf { it.points.size }.coerceAtLeast(1)
            fun x(index: Int): Float = if (maxPoints <= 1) left + width / 2f else left + width * index / (maxPoints - 1f)
            fun y(value: Double): Float = bottom - ((value - minimum) / (maximum - minimum)).toFloat() * height
            series.forEachIndexed { seriesIndex, current ->
                val tint = colors[seriesIndex % colors.size]
                if (type == "bar") {
                    val groupWidth = width / maxPoints
                    val barWidth = (groupWidth * 0.72f / series.size).coerceAtLeast(1f)
                    current.points.forEachIndexed { index, point ->
                        val zero = y(0.0.coerceIn(minimum, maximum))
                        val pointY = y(point.y)
                        val center = left + groupWidth * (index + 0.5f)
                        val start = center - groupWidth * 0.36f + seriesIndex * barWidth
                        drawRect(tint, Offset(start, min(zero, pointY)), Size(barWidth, abs(zero - pointY).coerceAtLeast(1f)))
                    }
                } else {
                    val path = Path()
                    current.points.forEachIndexed { index, point ->
                        val pointX = x(index)
                        val pointY = y(point.y)
                        if (index == 0) path.moveTo(pointX, pointY) else path.lineTo(pointX, pointY)
                    }
                    if (type == "area") {
                        path.lineTo(x(current.points.lastIndex), bottom)
                        path.lineTo(x(0), bottom)
                        path.close()
                        drawPath(path, tint.copy(alpha = safeNumber(attrs["areaOpacity"], 0.25f).coerceIn(0f, 1f)), style = Fill)
                    } else if (type != "point") {
                        drawPath(path, tint, style = Stroke(lineWidth, cap = StrokeCap.Round))
                    }
                    if (showPoints) current.points.forEachIndexed { index, point -> drawCircle(tint, pointRadius, Offset(x(index), y(point.y))) }
                }
            }
        }
        Text("${type.replaceFirstChar(Char::uppercase)} • ${values.size} points", Modifier.align(Alignment.TopStart).padding(6.dp), fontSize = 10.sp, color = MaterialTheme.colors.onSurface.copy(alpha = 0.66f))
    }
}

internal data class DesktopMapPin(val latitude: Double, val longitude: Double, val title: String)
internal data class DesktopMapModel(
    val latitude: Double,
    val longitude: Double,
    val zoom: Double,
    val pins: List<DesktopMapPin>,
)

internal fun desktopMapModel(attrs: Map<String, String>, rawPins: Any?): DesktopMapModel {
    val centerLat = attrs["lat"]?.toDoubleOrNull()?.takeIf(Double::isFinite)?.coerceIn(-85.0, 85.0) ?: 0.0
    val centerLon = attrs["lon"]?.toDoubleOrNull()?.takeIf(Double::isFinite)?.coerceIn(-180.0, 180.0) ?: 0.0
    val zoom = attrs["zoom"]?.toDoubleOrNull()?.takeIf(Double::isFinite)?.coerceIn(0.0, 22.0) ?: 12.0
    val latKey = attrs["pinLat"] ?: "lat"
    val lonKey = attrs["pinLon"] ?: "lng"
    val titleKey = attrs["pinTitle"] ?: "title"
    val pins = (rawPins as? List<*>)?.take(2_000)?.mapNotNull { entry ->
        val row = entry as? Map<*, *> ?: return@mapNotNull null
        val latitude = JSE.number(row[latKey])?.takeIf(Double::isFinite)?.coerceIn(-85.0, 85.0) ?: return@mapNotNull null
        val longitude = (JSE.number(row[lonKey]) ?: if (lonKey == "lng") JSE.number(row["lon"]) else null)
            ?.takeIf(Double::isFinite)?.coerceIn(-180.0, 180.0) ?: return@mapNotNull null
        DesktopMapPin(latitude, longitude, row[titleKey]?.let(JSE::string)?.take(128).orEmpty())
    }.orEmpty()
    return DesktopMapModel(centerLat, centerLon, zoom, pins)
}

@Composable
private fun DesktopMap(context: DesktopElementContext, modifier: Modifier) {
    val attrs = context.attributes
    val pinsExpression = context.node.attrs["pins"] ?: attrs["pins"]
    val rawPins = pinsExpression?.let { JSE.eval(unwrappedExpression(it), context.store, context.item) }
    val model = remember(attrs["lat"], attrs["lon"], attrs["zoom"], rawPins) { desktopMapModel(attrs, rawPins) }
    val pinColor = desktopMediaColor(attrs["pinColor"] ?: "accent")
    val routeColor = desktopMediaColor(attrs["routeColor"] ?: "accent").copy(alpha = safeNumber(attrs["routeOpacity"], 1f).coerceIn(0f, 1f))
    val routeWidth = safeNumber(attrs["routeWidth"], 4f).coerceIn(1f, 24f)
    val surface = MaterialTheme.colors.surface
    val ink = MaterialTheme.colors.onSurface
    Box(desktopMediaSize(modifier, attrs, 260f).background(surface).border(1.dp, ink.copy(alpha = 0.14f)).semantics {
        contentDescription = "Offline map centered at ${model.latitude}, ${model.longitude}; ${model.pins.size} pins; live tiles unavailable"
    }) {
        Canvas(Modifier.fillMaxSize()) {
            val tileSpan = 360.0 / 2.0.pow(model.zoom.coerceAtMost(18.0))
            val lonSpan = max(tileSpan * 4.0, 0.01)
            val latSpan = max(lonSpan * cos(Math.toRadians(model.latitude)).coerceAtLeast(0.2), 0.01)
            fun wrapDelta(value: Double): Double {
                var delta = value - model.longitude
                while (delta > 180.0) delta -= 360.0
                while (delta < -180.0) delta += 360.0
                return delta
            }
            fun project(pin: DesktopMapPin): Offset = Offset(
                (size.width / 2.0 + wrapDelta(pin.longitude) / lonSpan * size.width).toFloat(),
                (size.height / 2.0 - (pin.latitude - model.latitude) / latSpan * size.height).toFloat(),
            )
            repeat(9) { index ->
                val x = size.width * index / 8f
                val y = size.height * index / 8f
                drawLine(ink.copy(alpha = if (index == 4) 0.18f else 0.07f), Offset(x, 0f), Offset(x, size.height), 1f)
                drawLine(ink.copy(alpha = if (index == 4) 0.18f else 0.07f), Offset(0f, y), Offset(size.width, y), 1f)
            }
            val visible = model.pins.map(::project)
            if (visible.size > 1) {
                val path = Path().apply {
                    moveTo(visible.first().x, visible.first().y)
                    visible.drop(1).forEach { lineTo(it.x, it.y) }
                }
                drawPath(path, routeColor, style = Stroke(routeWidth, cap = StrokeCap.Round))
            }
            visible.forEach { point ->
                if (point.x in -12f..size.width + 12f && point.y in -12f..size.height + 12f) {
                    drawCircle(Color.White, 8f, point)
                    drawCircle(pinColor, 6f, point)
                }
            }
            val center = Offset(size.width / 2f, size.height / 2f)
            drawCircle(pinColor.copy(alpha = 0.25f), 11f, center)
            drawCircle(pinColor, 3.5f, center)
        }
        Text(
            "Native offline map • live tiles unavailable",
            Modifier.align(Alignment.BottomStart).background(surface.copy(alpha = 0.92f)).padding(7.dp),
            fontSize = 10.sp,
            color = ink.copy(alpha = 0.74f),
        )
    }
}

@Composable
internal fun DesktopMediaStateCard(
    modifier: Modifier,
    attrs: Map<String, String>,
    title: String,
    detail: String,
    footnote: String,
    defaultHeight: Float,
) {
    Column(
        desktopMediaSize(modifier, attrs, defaultHeight)
            .background(MaterialTheme.colors.surface, RoundedCornerShape(10.dp))
            .border(1.dp, MaterialTheme.colors.onSurface.copy(alpha = 0.15f), RoundedCornerShape(10.dp))
            .padding(14.dp)
            .semantics { contentDescription = "$title. $detail. $footnote" },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colors.onSurface)
        Text(detail, color = MaterialTheme.colors.onSurface.copy(alpha = 0.72f), fontSize = 12.sp)
        Text(footnote, color = MaterialTheme.colors.onSurface.copy(alpha = 0.52f), fontSize = 10.sp)
    }
}

internal fun desktopMediaSize(modifier: Modifier, attrs: Map<String, String>, defaultHeight: Float): Modifier {
    var result = modifier
    if (attrs["width"] == null && attrs["grow"] !in setOf("true", "both", "width")) result = result.fillMaxWidth()
    if (attrs["height"] == null && attrs["grow"] !in setOf("true", "both", "height")) result = result.height(defaultHeight.dp)
    return result
}

@Composable
private fun desktopMediaColor(raw: String): Color {
    val value = raw.trim().lowercase(Locale.ROOT)
    return when (value) {
        "accent", "tint" -> MaterialTheme.colors.primary
        "onaccent", "on-accent" -> MaterialTheme.colors.onPrimary
        "label", "primary" -> MaterialTheme.colors.onBackground
        "secondary" -> MaterialTheme.colors.secondary
        "tertiary" -> MaterialTheme.colors.onBackground.copy(alpha = 0.55f)
        "background", "systembackground" -> MaterialTheme.colors.background
        "surface", "fill", "fillfaint" -> MaterialTheme.colors.surface
        "outline", "separator" -> MaterialTheme.colors.onSurface.copy(alpha = 0.18f)
        "danger", "error", "red" -> MaterialTheme.colors.error
        "white" -> Color.White
        "black" -> Color.Black
        "clear", "transparent" -> Color.Transparent
        else -> parseDesktopColor(value) ?: MaterialTheme.colors.onBackground
    }
}

internal fun parseDesktopColor(raw: String): Color? {
    if (!raw.startsWith('#')) return null
    val value = raw.drop(1).toLongOrNull(16) ?: return null
    return when (raw.length) {
        4 -> {
            val r = (value shr 8 and 0xF) * 17
            val g = (value shr 4 and 0xF) * 17
            val b = (value and 0xF) * 17
            Color(r.toInt(), g.toInt(), b.toInt())
        }
        // The Long overload packs 0xAARRGGBB into sRGB. The ULong overload is the PACKED
        // representation (low 6 bits = colorspace id): feeding it raw ARGB made any hex
        // whose blue byte touches 0x3F (e.g. #FF3B30, id 48) throw at first draw.
        7 -> Color(0xFF000000L or value)
        9 -> Color(value)
        else -> null
    }
}

private fun desktopIconGlyph(name: String): String = when (name.lowercase(Locale.ROOT)) {
    "photo", "photo.fill", "image" -> "▧"
    "play", "play.fill" -> "▶"
    "pause", "pause.fill" -> "Ⅱ"
    "music.note", "music.note.list" -> "♪"
    "map", "map.fill", "mappin", "mappin.circle.fill" -> "⌖"
    "qrcode" -> "▦"
    else -> name.take(12)
}

private fun safeNumber(raw: String?, fallback: Float): Float = raw?.toFloatOrNull()?.takeIf(Float::isFinite) ?: fallback

private fun safeMediaFailure(failure: Throwable): String {
    val message = generateSequence(failure) { it.cause }.mapNotNull(Throwable::message).firstOrNull().orEmpty()
    return when {
        message.contains("source_missing") -> "source_missing"
        message.contains("source_blocked") || message.contains("InvalidURL") -> "source_blocked"
        message.contains("mime_blocked") -> "mime_blocked"
        message.contains("asset_missing") -> "asset_missing"
        message.contains("decode_failed") -> "decode_failed"
        message.startsWith("http_") -> "network_failed"
        message.contains("exceeds") -> "response_too_large"
        else -> "network_failed"
    }
}

private fun humanMediaFailure(reason: String): String = when (reason) {
    "source_missing" -> "Source is missing"
    "source_blocked" -> "Source was blocked by HTTPS policy"
    "mime_blocked" -> "Server did not return a raster image"
    "asset_missing" -> "Bundled asset was not found"
    "decode_failed" -> "Image bytes could not be decoded safely"
    "response_too_large" -> "Image exceeds the 8 MiB limit"
    else -> "Image request failed"
}

internal fun normalizedDesktopAssetName(raw: String): String? {
    val value = raw.trim().removePrefix("/")
    if (value.isEmpty() || value.length > MAX_ASSET_NAME || value.contains('\\') || value.contains('\u0000')) return null
    val segments = value.split('/')
    if (segments.any { it.isEmpty() || it == "." || it == ".." }) return null
    return value
}

internal fun loadDesktopAsset(raw: String, suffixes: List<String>, maximum: Long): ByteArray? {
    val normalized = normalizedDesktopAssetName(raw) ?: return null
    val candidates = suffixes.map { suffix -> if (suffix.isNotEmpty() && normalized.lowercase(Locale.ROOT).endsWith(suffix)) normalized else normalized + suffix }
        .distinct()
        .flatMap(::desktopBundledAssetCandidates)
    for (candidate in candidates) {
        val bytes = runCatching {
            DesktopHost::class.java.getResourceAsStream(candidate)?.use { input ->
                val out = ByteArrayOutputStream(minOf(maximum, 64L * 1024L).toInt())
                val buffer = ByteArray(16 * 1024)
                var total = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > maximum) throw IllegalArgumentException("asset_too_large")
                    out.write(buffer, 0, count)
                }
                out.toByteArray()
            }
        }.getOrNull()
        if (bytes != null) return bytes
    }
    return null
}

internal fun desktopBundledAssetCandidates(name: String): List<String> = listOf(
    "/dsx/app-assets/$name",
    "/$name",
    "/assets/$name",
    "/dsx/$name",
    "/dsx/assets/$name",
)

private fun unwrappedExpression(raw: String): String = raw.trim().removePrefix("{{").removeSuffix("}}").trim()
