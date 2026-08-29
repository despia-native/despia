package despia.engine

//
//  ScreenMetrics.kt — the pure half of the reactive screen plane (`dsx.screen.*`), the
//  renderer-neutral twin of iOS DSXScreen.swift's publish math and the web's
//  `screenMetrics(width, height)` (packages/dom/src/boot.ts). Both Kotlin surfaces —
//  the Android app renderer (:render RouterHost's ScreenStatePublisher) and the desktop
//  host (:desktop DesktopScreenStatePublisher) — measure their local window in pixels
//  and publish through THIS one table, so `visible-if="dsx.screen.width > 768"` /
//  `columns="{{ dsx.screen.breakpoint == 'xl' ? 4 : 2 }}"` resolve identically on every
//  renderer. Kept in :core (the AdaptiveShell precedent) so the boundary math is
//  plain-JVM testable without a Compose host.
//
//  Width and height are density-independent pixels — iOS points, web CSS pixels.
//

/** Renderer-neutral window state exposed to DSX markup as `dsx.screen.*`. */
data class ScreenMetrics(
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

/** Canonical DSX breakpoints: sm < 480 <= md < 768 <= lg < 1024 <= xl; sizeClass flips
 *  regular at 768 (the web contract; iOS reads the OS size class — a pinned divergence,
 *  DSXScreen.swift header). Invalid window/density input publishes nothing (null). */
fun screenMetrics(widthPx: Int, heightPx: Int, density: Float): ScreenMetrics? {
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
    return ScreenMetrics(
        width = width,
        height = height,
        sizeClass = if (width < 768.0) "compact" else "regular",
        orientation = if (width >= height) "landscape" else "portrait",
        breakpoint = breakpoint,
    )
}

/** OVERLAY the metric keys, never replace the object: `screen.*` also carries the
 *  lifecycle keys `phase` / `ready` (ScreenReadiness), so a whole-object write would
 *  wipe the screen phase on every rotation and resize — the same merge law as iOS
 *  DSXScreen.swift and web seedScreen; phase.json's last row is the mirror-image guard. */
fun screenState(previous: Any?, metrics: ScreenMetrics): Map<String, Any?> {
    val merged = LinkedHashMap<String, Any?>()
    (previous as? Map<*, *>)?.forEach { (key, value) ->
        if (key is String) merged[key] = value
    }
    merged.putAll(metrics.asMap())
    return merged
}
