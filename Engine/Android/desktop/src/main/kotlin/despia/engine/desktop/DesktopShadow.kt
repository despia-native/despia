package despia.engine.desktop

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.dp
import org.jetbrains.skia.FilterTileMode
import org.jetbrains.skia.ImageFilter

/**
 * `shadowX` / `shadowY` on the desktop lane - the twin of `StackShadow.kt`, and the same trade:
 * `Modifier.shadow` is an ELEVATION shadow, the platform light sits at a fixed position, and an
 * elevation shadow has no offset to give. Both Compose lanes therefore stop asking the platform
 * to light the element and paint the shadow themselves, which is what makes the two offsets real
 * (constitution Article 10) and what lets `desktopStyleDeterministicDegradations` lose two rows.
 *
 * A separate file from the :render twin for the reason DesktopStyleRuntime is separate from
 * StackStyle: the two lanes resolve different Compose distributions, and the blur in particular is
 * a different API on each. Skia takes a SIGMA directly, so the CSS definition (a `box-shadow`
 * blur radius of b is a Gaussian of standard deviation b/2) lands here without the inversion the
 * Android `BlurMaskFilter` needs. Same authored number, same rendered weight, two spellings.
 *
 * Defaults are the shared ones - black at 25%, blur 8, x 0, y 2 - so an element that declares only
 * `shadow=` looks the same on all four renderers.
 */
internal fun Modifier.desktopShadow(
    blur: Float,
    color: Color,
    dx: Float,
    dy: Float,
    cornerRadius: Float,
): Modifier = drawBehind {
    val paint = Paint()
    paint.color = color
    val sigma = (blur.dp.toPx() / 2f).takeIf { it.isFinite() && it > 0f }
    if (sigma != null) {
        // DECAL rather than CLAMP: a clamped blur smears the shadow's colour to the edge of the
        // layer, which reads as a wash behind the whole element instead of a shadow under it.
        paint.asFrameworkPaint().imageFilter = ImageFilter.makeBlur(sigma, sigma, FilterTileMode.DECAL)
    }
    val offsetX = dx.dp.toPx()
    val offsetY = dy.dp.toPx()
    val corner = cornerRadius.dp.toPx()
    drawIntoCanvas { canvas ->
        canvas.nativeCanvas.drawRRect(
            org.jetbrains.skia.RRect.makeXYWH(
                offsetX, offsetY, size.width, size.height, corner,
            ),
            paint.asFrameworkPaint(),
        )
    }
}
