package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import despia.engine.DSX
import despia.engine.getPath
import despia.engine.setPath

/** Renderer-neutral window state exposed to DSX markup as `dsx.screen.*`.
 * Width and height are density-independent pixels, matching iOS points and web CSS pixels. */
internal data class DesktopScreenMetrics(
    val width: Double,
    val height: Double,
    val sizeClass: String,
    val orientation: String,
    val breakpoint: String,
) {
    fun asMap(): Map<String, Any?> = linkedMapOf(
        "width" to width,
        "height" to height,
        "sizeClass" to sizeClass,
        "orientation" to orientation,
        "breakpoint" to breakpoint,
    )
}

/** Canonical DSX breakpoints: sm < 480 <= md < 768 <= lg < 1024 <= xl. */
internal fun desktopScreenMetrics(widthPx: Int, heightPx: Int, density: Float): DesktopScreenMetrics? {
    if (widthPx <= 0 || heightPx <= 0 || !density.isFinite() || density <= 0f) return null
    val width = widthPx.toDouble() / density.toDouble()
    val height = heightPx.toDouble() / density.toDouble()
    if (!width.isFinite() || !height.isFinite() || width <= 0.0 || height <= 0.0) return null
    val breakpoint = when {
        width < 480.0 -> "sm"
        width < 768.0 -> "md"
        width < 1024.0 -> "lg"
        else -> "xl"
    }
    return DesktopScreenMetrics(
        width = width,
        height = height,
        sizeClass = if (width < 768.0) "compact" else "regular",
        orientation = if (width >= height) "landscape" else "portrait",
        breakpoint = breakpoint,
    )
}

/** Preserve lifecycle-owned keys such as screen.ready while overlaying live metrics. */
internal fun desktopScreenState(previous: Any?, metrics: DesktopScreenMetrics): Map<String, Any?> {
    val merged = LinkedHashMap<String, Any?>()
    (previous as? Map<*, *>)?.forEach { (key, value) ->
        if (key is String) merged[key] = value
    }
    merged.putAll(metrics.asMap())
    return merged
}

/** Publishes the local native window, not the physical monitor, on every resize. */
@Composable
internal fun DesktopScreenStatePublisher() {
    val density = LocalDensity.current.density
    val size = LocalWindowInfo.current.containerSize
    val metrics = remember(size, density) { desktopScreenMetrics(size.width, size.height, density) }
    LaunchedEffect(metrics) {
        metrics ?: return@LaunchedEffect
        val next = desktopScreenState(DSX.state.getPath("screen"), metrics)
        DSX.state.setPath("screen", next)
    }
}
