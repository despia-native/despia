package despia.engine.render

import android.graphics.BlurMaskFilter
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp

/**
 * `shadowX` / `shadowY` on Compose - a DRAWN shadow, because the platform's is an ELEVATION
 * shadow and an elevation shadow has no offset to give.
 *
 * `Modifier.shadow` asks the platform to light the element, and the platform light sits at a fixed
 * position roughly above it. That is why the pair sat in the parity register: an author who leaned
 * a shadow to the right got one directly below, while iOS (`.shadow(color:radius:x:y:)`) and the
 * web (`box-shadow`) both honoured it. The catalogue advertises the attribute on every renderer,
 * so the answer is to stop asking the platform to light the element and paint the shadow
 * ourselves (constitution Article 10).
 *
 * WHAT IS PAINTED: the radius shape, filled in `shadowColor` (black at 25% by default, the iOS
 * value), offset by (shadowX, shadowY), blurred, behind the element. `shadowY` defaults to 2 and
 * `shadowX` to 0 - exactly the defaults `Stack.swift` and `cssmap.ts` already use - so an element
 * that declares only `shadow=` now looks the same on all four renderers instead of merely similar.
 *
 * SEAMS (pinned, none silent):
 *  - The BLUR NUMBER means what it means in CSS: a `box-shadow` blur radius of b is a Gaussian of
 *    standard deviation b/2. Skia and CoreGraphics both take a sigma; Android's `BlurMaskFilter`
 *    takes a radius on its own scale (sigma = 0.57735 * radius + 0.5), so [blurMaskRadius] inverts
 *    that rather than passing the authored number through and hoping. One authored number, one
 *    rendered blur, on every renderer.
 *  - The shadow paints OUTSIDE the element's bounds, which is what a shadow is. `drawBehind` does
 *    not clip on its own, so this step stays where the elevation shadow was in the onion - after
 *    the radius clip - and a `clip` an author adds still wins.
 *  - A blur of zero is a HARD-EDGED shadow, matching `box-shadow` with a zero blur radius, rather
 *    than no shadow at all. Asking the platform for a zero-radius blur is undefined, so it is
 *    skipped instead of requested.
 */
internal fun Modifier.dsxShadow(
    blur: Float,
    color: Color,
    dx: Float,
    dy: Float,
    cornerRadius: Float,
): Modifier = drawBehind {
    // Every argument arrives in the attribute's own dp, and a DrawScope is a Density - so the one
    // conversion to pixels happens here rather than at the call site, where the density is not in
    // scope during the modifier fold.
    val paint = Paint()
    val framework = paint.asFrameworkPaint()
    framework.color = color.toArgb()
    blurMaskRadius(blur.dp.toPx())?.let {
        framework.maskFilter = BlurMaskFilter(it, BlurMaskFilter.Blur.NORMAL)
    }
    val offsetX = dx.dp.toPx()
    val offsetY = dy.dp.toPx()
    val corner = cornerRadius.dp.toPx()
    drawIntoCanvas { canvas ->
        canvas.nativeCanvas.drawRoundRect(
            offsetX, offsetY, size.width + offsetX, size.height + offsetY,
            corner, corner,
            framework,
        )
    }
}

/**
 * The authored CSS blur radius as a `BlurMaskFilter` radius, or null when there is nothing to
 * blur. Android's mask filter documents sigma = 0.57735 * radius + 0.5; a CSS blur radius of b is
 * a sigma of b/2. Inverting the first with the second is what makes `shadow="8"` render the same
 * weight of blur here as it does on the other three renderers.
 */
internal fun blurMaskRadius(blur: Float): Float? {
    if (!blur.isFinite() || blur <= 0f) return null
    val sigma = blur / 2f
    val radius = (sigma - 0.5f) / 0.57735f
    return radius.takeIf { it > 0f }
}
