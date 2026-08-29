package despia.engine.render

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.RadialGradientShader
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SweepGradientShader
import androidx.compose.ui.graphics.lerp
import despia.engine.ControlsCore

/**
 * The gradient LAYER on Compose - the Kotlin twin of `StackGradients.swift`, and for the same
 * reason that file exists: the six declared gradient properties (`gradientType` ·
 * `gradientStops` · `gradientAngle` · `gradientCenter` · `gradientRadius` · `gradientPoints`)
 * plus the three legacy `gradientDir` tokens are ONE decision, and that decision already lives
 * in [ControlsCore.resolveGradient] (corpus OpenSource/Conformance/controls/gradients.json,
 * three runtimes). This file is only the paint.
 *
 * Until now Compose read `gradient` and `gradientDir` and painted a linear brush along one of
 * three fixed axes, throwing the other six properties away after the shared core had already
 * resolved them. That is the Article 10 defect this closes: a style attribute the catalogue
 * advertises works on every renderer.
 *
 * TWO CONVENTION CONVERSIONS HAPPEN HERE, once, rather than at every call site:
 *
 *  1. The corpus axis is UNIT space (0..1 across the element) and Compose shaders take pixels,
 *     so every brush is a [ShaderBrush] that scales its geometry by the size it is handed. The
 *     `Offset(0f, POSITIVE_INFINITY)` idiom the old axis helper used cannot express an
 *     arbitrary angle, which is why it only ever had three.
 *  2. The corpus angle starts at twelve o'clock and increases clockwise (CSS). Compose's sweep
 *     starts at three o'clock and takes no rotation, so the rotation is folded into the stop
 *     ring by [rotatedRing] - exact, because rotating a sweep IS a cyclic shift of its stops.
 *
 * MESH DEGRADES HONESTLY. Compose has no mesh gradient at any API level, so the paint is the
 * corpus's DECLARED fallback: the base fill plus one soft radial per control point in row-major
 * order, which is the same picture iOS below 18 paints. It is a specification a screenshot can
 * be diffed against, not a blank and not a silently different look nobody wrote down.
 */
object StackGradients {

    /**
     * The brush stack for an element's gradient attributes, back to front, or empty when the
     * element declares no gradient (or fewer than two colours, which is a flat fill and not a
     * gradient - paint nothing rather than a band of one colour).
     *
     * A LIST rather than one brush because mesh degrades to layers; every other type returns
     * exactly one, so the caller's loop is the same shape in both cases.
     */
    fun layers(value: (String) -> String?): List<Brush> {
        if (value("gradient") == null && value("gradientPoints") == null) return emptyList()
        return layers(
            ControlsCore.resolveGradient(
                gradient = value("gradient"),
                gradientType = value("gradientType"),
                gradientStops = value("gradientStops"),
                gradientAngle = value("gradientAngle"),
                gradientDir = value("gradientDir"),
                gradientCenter = value("gradientCenter"),
                gradientRadius = value("gradientRadius"),
                gradientPoints = value("gradientPoints"),
            )
        )
    }

    /**
     * The paint for an already-resolved descriptor. Exposed so a component that resolves its own
     * gradient (a gauge ramp, a masked sweep) paints the identical thing.
     */
    fun layers(resolved: ControlsCore.Gradient): List<Brush> {
        if (!resolved.valid) return emptyList()
        val center = Offset(resolved.center.x.toFloat(), resolved.center.y.toFloat())
        return when (resolved.type) {
            "radial" -> listOf(
                UnitRadialGradient(ring(resolved), center, resolved.radius.toFloat())
            )
            "angular" -> listOf(
                UnitSweepGradient(rotatedRing(ring(resolved), resolved.angle - 90.0), center)
            )
            "mesh" -> meshLayers(resolved)
            else -> listOf(
                UnitLinearGradient(
                    ring(resolved),
                    Offset(resolved.start.x.toFloat(), resolved.start.y.toFloat()),
                    Offset(resolved.end.x.toFloat(), resolved.end.y.toFloat()),
                )
            )
        }
    }

    private fun ring(resolved: ControlsCore.Gradient): List<Pair<Float, Color>> =
        resolved.colors.mapIndexed { index, token ->
            val location = resolved.stops.getOrElse(index) { 0.0 }
            location.toFloat().coerceIn(0f, 1f) to StackStyle.color(token)
        }

    /**
     * One soft radial per control point over the base fill, painted row-major - the corpus's
     * pinned mesh degradation. The outer stop of each layer is the layer's own colour at zero
     * alpha, so the points blend into each other rather than stacking as hard discs.
     */
    private fun meshLayers(resolved: ControlsCore.Gradient): List<Brush> {
        val fallback = resolved.meshFallback ?: return emptyList()
        val out = ArrayList<Brush>(fallback.layers.size + 1)
        val base = StackStyle.color(fallback.base)
        out.add(SolidUnitBrush(base))
        fallback.layers.forEach { layer ->
            val color = StackStyle.color(layer.color)
            out.add(
                UnitRadialGradient(
                    listOf(0f to color, 1f to color.copy(alpha = 0f)),
                    Offset(layer.center.x.toFloat(), layer.center.y.toFloat()),
                    layer.radius.toFloat(),
                )
            )
        }
        return out
    }

    /**
     * A sweep rotated by [degrees], expressed as the cyclic shift of its stops that Compose can
     * actually paint. The ring is closed at both ends with the colour the wrap point interpolates
     * to, so the rotation shows no seam that the unrotated gradient did not already have.
     */
    internal fun rotatedRing(entries: List<Pair<Float, Color>>, degrees: Double): List<Pair<Float, Color>> {
        if (entries.isEmpty()) return entries
        val shift = (((degrees / 360.0) % 1.0) + 1.0) % 1.0
        if (shift == 0.0) return entries
        val moved = entries
            .map { (location, color) -> (((location + shift) % 1.0 + 1.0) % 1.0).toFloat() to color }
            .sortedBy { it.first }
        val first = moved.first()
        val last = moved.last()
        val span = (1f - last.first) + first.first
        val seam = if (span <= 0f) first.second else lerp(last.second, first.second, (1f - last.first) / span)
        val out = ArrayList<Pair<Float, Color>>(moved.size + 2)
        if (first.first > 0f) out.add(0f to seam)
        out.addAll(moved)
        if (last.first < 1f) out.add(1f to seam)
        return out
    }
}

/** Unit-space geometry, resolved against the size Compose hands the shader. */
private class UnitLinearGradient(
    private val ring: List<Pair<Float, Color>>,
    private val start: Offset,
    private val end: Offset,
) : ShaderBrush() {
    override fun createShader(size: Size): Shader = LinearGradientShader(
        from = Offset(start.x * size.width, start.y * size.height),
        to = Offset(end.x * size.width, end.y * size.height),
        colors = ring.map { it.second },
        colorStops = ring.map { it.first },
    )
}

/** `gradientRadius` is a fraction of the element's LONGER side, as the corpus defines it. */
private class UnitRadialGradient(
    private val ring: List<Pair<Float, Color>>,
    private val center: Offset,
    private val radius: Float,
) : ShaderBrush() {
    override fun createShader(size: Size): Shader = RadialGradientShader(
        center = Offset(center.x * size.width, center.y * size.height),
        radius = (maxOf(size.width, size.height) * radius).coerceAtLeast(0.01f),
        colors = ring.map { it.second },
        colorStops = ring.map { it.first },
    )
}

private class UnitSweepGradient(
    private val ring: List<Pair<Float, Color>>,
    private val center: Offset,
) : ShaderBrush() {
    override fun createShader(size: Size): Shader = SweepGradientShader(
        center = Offset(center.x * size.width, center.y * size.height),
        colors = ring.map { it.second },
        colorStops = ring.map { it.first },
    )
}

/** The mesh base fill, as a brush so the caller's layer loop stays one shape. */
private class SolidUnitBrush(private val color: Color) : ShaderBrush() {
    override fun createShader(size: Size): Shader = LinearGradientShader(
        from = Offset.Zero,
        to = Offset(size.width, size.height),
        colors = listOf(color, color),
    )
}
