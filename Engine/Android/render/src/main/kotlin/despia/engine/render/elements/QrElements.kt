//
//  QrElements.kt — `<qrcode>` (Kotlin twin of QRCode.swift). A QR rendered ON-DEVICE from
//  `value` (interpolated — re-renders live when bound state changes); empty renders
//  nothing. iOS generates via CoreImage; Android has no platform generator, so the matrix
//  comes from ZXing-CORE (com.google.zxing:core — pure Java, no Android/Kotlin-metadata
//  exposure; pinned in this module's build.gradle.kts). Same attribute contract:
//
//    • value       the encoded string (required).
//    • size        point size of the square (default 200); `width`/`height` are aliases
//                  (the CSS spelling), exactly like iOS.
//    • color       module color token/hex (default black) — only the DARK modules tint.
//    • background  background token/hex (default white — scanners need contrast).
//    • correction  L | M | Q | H (default M).
//
//  Encoding is cached per (value, correction) — the encoder runs once per distinct
//  payload, not per render (the NSCache twin). Modules draw as filled rects inside a
//  quiet-zone inset of size × 0.06 (the iOS padding) — vector-crisp at any scale, the
//  nearest-neighbor contract by construction. Bad payloads fail open to an empty square.
//

package despia.engine.render.elements

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackStyle
import kotlin.math.ceil
import kotlin.math.floor

internal fun registerQrElements() {
    ComposeStackComponents.defineNative("qrcode") { ctx -> QrCodeView(ctx) }
}

/// Encoded matrices by "correction|value" — the QRCodeElement.cache twin. A pure-JVM
/// access-order LRU (NOT android.util.LruCache, which the plain-JVM units can't touch).
private val qrCacheLock = Any()
private val qrCache = object : LinkedHashMap<String, Array<BooleanArray>>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Array<BooleanArray>>) = size > 64
}

@Composable
private fun QrCodeView(ctx: ComposeStackComponentContext) {
    val value = ctx.str("value")
    if (value.isEmpty()) return                                    // iOS: zero-size, renders nothing
    val size = ctx.num("size") ?: ctx.num("width") ?: ctx.num("height") ?: ElementDefaults.QR_SIZE
    val correction = ctx.str("correction").takeIf { it in listOf("L", "M", "Q", "H") } ?: "M"
    val fg = StackStyle.color(ctx.str("color", ElementDefaults.QR_MODULES))
    val bg = StackStyle.color(ctx.str("background", ElementDefaults.QR_BACKGROUND))
    val matrix = remember(value, correction) { qrMatrix(value, correction) }

    Canvas(Modifier.elementModifier(ctx).then(Modifier.size(size.dp))) {
        drawRect(bg)                                               // background spans the square
        val m = matrix ?: return@Canvas                            // fail-open: empty square
        val count = m.size
        if (count == 0) return@Canvas
        val quiet = this.size.width * ElementDefaults.QR_QUIET_FRACTION.toFloat()   // quiet zone — iOS padding size*0.06
        val inner = this.size.width - quiet * 2
        val cell = inner / count
        for (row in 0 until count) {
            // Snap cell edges to pixels (floor/ceil) so adjacent modules never seam.
            val top = quiet + row * cell
            val bottom = quiet + (row + 1) * cell
            for (col in 0 until count) {
                if (!m[row][col]) continue
                val left = quiet + col * cell
                val right = quiet + (col + 1) * cell
                drawRect(fg, topLeft = Offset(floor(left), floor(top)),
                         size = Size(ceil(right) - floor(left), ceil(bottom) - floor(top)))
            }
        }
    }
}

/// Encode (or fetch from cache) the module matrix — ZXing's Encoder gives the raw QR
/// grid (no built-in quiet zone; ours is drawn). Null on any encode failure.
internal fun qrMatrix(value: String, correction: String): Array<BooleanArray>? {
    val key = "$correction|$value"
    synchronized(qrCacheLock) { qrCache[key] }?.let { return it }
    return runCatching {
        val level = when (correction) {
            "L" -> ErrorCorrectionLevel.L
            "Q" -> ErrorCorrectionLevel.Q
            "H" -> ErrorCorrectionLevel.H
            else -> ErrorCorrectionLevel.M
        }
        val qr = Encoder.encode(value, level).matrix ?: return null
        Array(qr.height) { y -> BooleanArray(qr.width) { x -> qr.get(x, y).toInt() == 1 } }
    }.getOrNull()?.also { synchronized(qrCacheLock) { qrCache[key] = it } }
}
