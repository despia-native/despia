//
//  ImageApi28Impl.kt — strict API-28 boundary for ImageDecoder and
//  AnimatedImageDrawable.
//
//  Android verifies ImageElementsKt while MainActivity starts on the minimum supported
//  API (24). Merely guarding an ImageDecoder call with SDK_INT is not sufficient: the
//  verifier can resolve the callback interface from that already-loaded class and fail
//  before the guard runs. All P-only symbols therefore live in this separately loaded
//  implementation class. The consumer rule also forbids R8 from inlining the boundary
//  back into ImageElementsKt in minified applications.
//

package despia.engine.render.elements

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.widget.ImageView
import androidx.annotation.DoNotInline
import androidx.annotation.RequiresApi
import java.nio.ByteBuffer

internal data class Api28DecodedImage(
    val drawable: Drawable,
    val costBytes: Long,
)

@RequiresApi(Build.VERSION_CODES.P)
internal object ImageApi28Impl {
    @JvmStatic
    @DoNotInline
    fun decode(bytes: ByteArray, encodedFrames: Int): Api28DecodedImage? = runCatching {
        val drawable = ImageDecoder.decodeDrawable(
            ImageDecoder.createSource(ByteBuffer.wrap(bytes)),
        ) { decoder, info, _ ->
            val bounded = MediaInputPolicy.targetDimensions(
                info.size.width,
                info.size.height,
                encodedFrames,
            ) ?: throw IllegalArgumentException("image dimensions exceed policy")
            decoder.setTargetSize(bounded.width, bounded.height)
            decoder.memorySizePolicy = ImageDecoder.MEMORY_POLICY_LOW_RAM
        }

        (drawable as? AnimatedImageDrawable)?.repeatCount =
            AnimatedImageDrawable.REPEAT_INFINITE
        if (drawable.intrinsicWidth <= 0 || drawable.intrinsicHeight <= 0 ||
            drawable.intrinsicWidth > MediaInputPolicy.MAXIMUM_PIXEL_DIMENSION ||
            drawable.intrinsicHeight > MediaInputPolicy.MAXIMUM_PIXEL_DIMENSION
        ) {
            (drawable as? BitmapDrawable)?.bitmap?.recycle()
            return@runCatching null
        }

        val dimensions = MediaInputPolicy.Dimensions(
            drawable.intrinsicWidth,
            drawable.intrinsicHeight,
            if (drawable is AnimatedImageDrawable) encodedFrames else 1,
        )
        val cost = MediaInputPolicy.decodedCostBytes(dimensions) ?: run {
            (drawable as? BitmapDrawable)?.bitmap?.recycle()
            return@runCatching null
        }
        if (drawable is BitmapDrawable &&
            drawable.bitmap.allocationByteCount.toLong() > MediaInputPolicy.MAXIMUM_DECODED_BYTES
        ) {
            drawable.bitmap.recycle()
            return@runCatching null
        }
        Api28DecodedImage(drawable, cost)
    }.getOrNull()

    @JvmStatic
    @DoNotInline
    fun isAnimated(drawable: Drawable): Boolean = drawable is AnimatedImageDrawable

    @JvmStatic
    @DoNotInline
    fun installAndStart(imageView: ImageView, drawable: Drawable) {
        val animated = drawable as? AnimatedImageDrawable ?: return
        if (imageView.drawable !== animated) imageView.setImageDrawable(animated)
        if (!animated.isRunning) animated.start()
    }
}
