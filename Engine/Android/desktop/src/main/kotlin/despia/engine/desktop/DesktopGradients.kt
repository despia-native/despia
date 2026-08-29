package despia.engine.desktop

import androidx.compose.runtime.Composable
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
 * The gradient LAYER on the desktop lane - the twin of `StackGradients.kt` and of
 * `StackGradients.swift`, painting from the SAME [ControlsCore.resolveGradient] decision (corpus
 * OpenSource/Conformance/controls/gradients.json, three runtimes).
 *
 * It is a separate file from the :render twin for the same reason DesktopStyleRuntime is a
 * separate file from StackStyle: the two lanes resolve different Compose distributions and share
 * no Compose module. What they must not differ in is the DECISION, and they do not - the six
 * declared gradient properties are read, folded and rounded in :core, and only the paint is here.
 *
 * Before this the desktop lane read `gradient` and the three legacy `gradientDir` tokens and
 * painted a linear brush along one of three fixed axes. `gradientType`, `gradientStops`,
 * `gradientAngle`, `gradientCenter`, `gradientRadius` and `gradientPoints` were resolved by the
 * shared core and then thrown away, which is the Article 10 defect this closes.
 *
 * Conventions, converted here exactly once: the corpus axis is UNIT space and Compose shaders
 * take pixels (hence [ShaderBrush]); the corpus angle starts at twelve o'clock and Compose's
 * sweep starts at three with no rotation argument (hence [rotatedRing], which is exact - rotating
 * a sweep IS a cyclic shift of its stops). Mesh degrades to the corpus's declared fallback, the
 * base fill plus one soft radial per control point in row-major order.
 */
internal object DesktopGradients {

    /**
     * The brush stack for an element's gradient attributes, back to front, or empty when the
     * element declares no gradient or fewer than two colours. A LIST because mesh degrades to
     * layers; every other type returns exactly one.
     */
    @Composable
    fun layers(attrs: Map<String, String>, theme: String?): List<Brush> {
        if (attrs["gradient"] == null && attrs["gradientPoints"] == null) return emptyList()
        val resolved = ControlsCore.resolveGradient(
            gradient = attrs["gradient"],
            gradientType = attrs["gradientType"],
            gradientStops = attrs["gradientStops"],
            gradientAngle = attrs["gradientAngle"],
            gradientDir = attrs["gradientDir"],
            gradientCenter = attrs["gradientCenter"],
            gradientRadius = attrs["gradientRadius"],
            gradientPoints = attrs["gradientPoints"],
        )
        // `color()` resolves semantic tokens through the live theme, so it is @Composable and
        // cannot be handed to the paint as a callback. The palette is therefore resolved HERE,
        // once per token, and the paint stays a pure function of colours - which is also what
        // makes the second overload usable from a test.
        val palette = HashMap<String, Color>()
        for (token in gradientTokens(resolved)) palette[token] = color(token, theme)
        return layers(resolved) { token -> palette[token] ?: Color.Transparent }
    }

    /** Every colour token a resolved descriptor will ask for, mesh fallback layers included. */
    private fun gradientTokens(resolved: ControlsCore.Gradient): List<String> {
        val out = ArrayList<String>(resolved.colors)
        resolved.meshFallback?.let { fallback ->
            out.add(fallback.base)
            fallback.layers.forEach { out.add(it.color) }
        }
        return out.distinct()
    }

    fun layers(resolved: ControlsCore.Gradient, palette: (String) -> Color): List<Brush> {
        if (!resolved.valid) return emptyList()
        val center = Offset(resolved.center.x.toFloat(), resolved.center.y.toFloat())
        val ring = resolved.colors.mapIndexed { index, token ->
            resolved.stops.getOrElse(index) { 0.0 }.toFloat().coerceIn(0f, 1f) to palette(token)
        }
        return when (resolved.type) {
            "radial" -> listOf(DesktopUnitRadialGradient(ring, center, resolved.radius.toFloat()))
            "angular" -> listOf(DesktopUnitSweepGradient(rotatedRing(ring, resolved.angle - 90.0), center))
            "mesh" -> meshLayers(resolved, palette)
            else -> listOf(
                DesktopUnitLinearGradient(
                    ring,
                    Offset(resolved.start.x.toFloat(), resolved.start.y.toFloat()),
                    Offset(resolved.end.x.toFloat(), resolved.end.y.toFloat()),
                )
            )
        }
    }

    private fun meshLayers(resolved: ControlsCore.Gradient, palette: (String) -> Color): List<Brush> {
        val fallback = resolved.meshFallback ?: return emptyList()
        val out = ArrayList<Brush>(fallback.layers.size + 1)
        val base = palette(fallback.base)
        out.add(DesktopSolidUnitBrush(base))
        fallback.layers.forEach { layer ->
            val layerColor = palette(layer.color)
            out.add(
                DesktopUnitRadialGradient(
                    listOf(0f to layerColor, 1f to layerColor.copy(alpha = 0f)),
                    Offset(layer.center.x.toFloat(), layer.center.y.toFloat()),
                    layer.radius.toFloat(),
                )
            )
        }
        return out
    }

    /**
     * A sweep rotated by [degrees], as the cyclic stop shift Compose can paint. The ring is closed
     * at both ends with the colour the wrap point interpolates to, so rotating shows no seam the
     * unrotated gradient did not already have.
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

private class DesktopUnitLinearGradient(
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
private class DesktopUnitRadialGradient(
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

private class DesktopUnitSweepGradient(
    private val ring: List<Pair<Float, Color>>,
    private val center: Offset,
) : ShaderBrush() {
    override fun createShader(size: Size): Shader = SweepGradientShader(
        center = Offset(center.x * size.width, center.y * size.height),
        colors = ring.map { it.second },
        colorStops = ring.map { it.first },
    )
}

private class DesktopSolidUnitBrush(private val color: Color) : ShaderBrush() {
    override fun createShader(size: Size): Shader = LinearGradientShader(
        from = Offset.Zero,
        to = Offset(size.width, size.height),
        colors = listOf(color, color),
    )
}
