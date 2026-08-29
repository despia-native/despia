//
//  SignatureElement.kt — the Kotlin twin of `<Signature/>` (Foundation Core/Signature.swift).
//  Real Compose ink: a Canvas + a raw pointer stream, no web view and no per-point store write.
//
//  Geometry 1:1 from the Swift source (ElementDefaults.SIGNATURE_*): pad 180 high, radius 12,
//  1dp separator border, the signing rule inset 24 from each edge and 36 above the bottom,
//  15sp placeholder in `secondaryLabel`, ink `label` at strokeWidth 3.
//
//  THE VALUE IS THE API — `bind` holds `[{ points: [[x, y], …], width }]`, x/y normalized
//  0…1 against the pad box and rounded to four decimals AT CAPTURE, so the stored value and
//  the drawn ink are the same numbers on every renderer. The write happens once per stroke,
//  on pointer-up (`on:change` then rides BoundControl.setBound's seam, like every two-way
//  element); clearing is `sig = []` and undo is `sig.slice(0, sig.length - 1)`, so the pad
//  needs no control channel of its own.
//

package despia.engine.render.elements

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.InkCore
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackStyle

internal fun registerSignatureElement() {
    ComposeStackComponents.defineNative("Signature") { ctx -> SignatureElement(ctx) }
}

@Composable
private fun SignatureElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["bind"] ?: ""
    val strokes = InkCore.decode(el.list("bind"))
    val width = el.dbl("strokeWidth", ElementDefaults.SIGNATURE_STROKE)
    val ink = el.color("color", ElementDefaults.SIGNATURE_INK)
    val rule = StackStyle.color(ElementDefaults.SIGNATURE_RULE)
    val radius = el.dbl("radius", ElementDefaults.SIGNATURE_RADIUS)
    val placeholder = el.str("placeholder")
    val readOnly = el.bool("readOnly") || el.bool("disabled") || el.bool("disabled-if")
    val drawBaseline = el.bool("baseline", true)
    var live by remember { mutableStateOf(emptyList<InkCore.Point>()) }
    val empty = strokes.isEmpty() && live.isEmpty()
    val shape = RoundedCornerShape(radius.dp)
    val label = el.str("a11yLabel", placeholder.ifEmpty { "Signature" })

    Box(
        Modifier.elementStyle(el)
            .fillMaxWidth()
            .height(el.dbl("height", ElementDefaults.SIGNATURE_HEIGHT).dp)
            .clip(shape)
            .border(ElementDefaults.SIGNATURE_BORDER.dp, rule, shape)
            .pointerInput(readOnly, width, key) {
                if (readOnly) return@pointerInput
                // The coalescing floor is stated in pad POINTS, so it converts once, here.
                val minDistancePx = InkCore.MIN_POINT_DISTANCE.dp.toPx().toDouble()
                awaitEachGesture {
                    val boxW = size.width.toDouble()
                    val boxH = size.height.toDouble()
                    val down = awaitFirstDown(requireUnconsumed = false)
                    live = listOf(capture(down.position, boxW, boxH))
                    raiseEvent(ctx, "begin", mapOf("strokes" to strokes.size))
                    var event = awaitPointerEvent()
                    while (event.changes.any { it.pressed }) {
                        for (change in event.changes) {
                            if (!change.pressed) continue
                            val point = capture(change.position, boxW, boxH)
                            if (farEnoughPx(live.last(), point, boxW, boxH, minDistancePx)) {
                                live = live + point
                            }
                            change.consume()
                        }
                        event = awaitPointerEvent()
                    }
                    val stroke = InkCore.Stroke(live, width)
                    live = emptyList()
                    if (stroke.points.isNotEmpty()) {
                        // on:change rides the write seam (BoundControl.setBound), like every two-way element
                        el.ctl.setBound(key, InkCore.encode(strokes + stroke))
                        raiseEvent(ctx, "end", mapOf("strokes" to strokes.size + 1,
                                                     "points" to stroke.points.size))
                    }
                }
            }
            .semantics(mergeDescendants = true) {
                contentDescription = label
                stateDescription = if (empty) "Empty" else "Signed"
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            if (drawBaseline) {
                val inset = ElementDefaults.SIGNATURE_BASELINE_INSET.dp.toPx()
                val y = size.height - ElementDefaults.SIGNATURE_BASELINE_BOTTOM.dp.toPx()
                drawLine(rule, Offset(inset, y), Offset(size.width - inset, y),
                         strokeWidth = ElementDefaults.SIGNATURE_BORDER.dp.toPx())
            }
            for (stroke in strokes) {
                drawPath(inkPath(stroke.points, size), color = ink,
                         style = Stroke(width = stroke.width.dp.toPx(),
                                        cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            if (live.isNotEmpty()) {
                drawPath(inkPath(live, size), color = ink,
                         style = Stroke(width = width.dp.toPx(),
                                        cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
        if (empty && placeholder.isNotEmpty()) {
            BasicText(placeholder,
                      style = TextStyle(color = StackStyle.color(ElementDefaults.SIGNATURE_PLACEHOLDER),
                                        fontSize = ElementDefaults.SIGNATURE_PLACEHOLDER_FONT.sp))
        }
    }
}

/** Compose's pointer positions are px; the law is stated in the normalized 0…1 pad box. */
private fun capture(position: Offset, width: Double, height: Double): InkCore.Point =
    InkCore.point(position.x.toDouble(), position.y.toDouble(), width, height)

/** InkCore.farEnough in px: the floor arrives already converted from dp. */
private fun farEnoughPx(last: InkCore.Point, next: InkCore.Point,
                        width: Double, height: Double, minDistancePx: Double): Boolean {
    val dx = (next.x - last.x) * width
    val dy = (next.y - last.y) * height
    return dx * dx + dy * dy >= minDistancePx * minDistancePx
}

/** The shared ops, replayed onto a Compose path — the curve itself lives in :core. */
private fun inkPath(points: List<InkCore.Point>, size: Size): Path {
    val path = Path()
    for (op in InkCore.ops(points, size.width.toDouble(), size.height.toDouble())) {
        when (op.verb) {
            InkCore.Verb.MOVE -> path.moveTo(op.x.toFloat(), op.y.toFloat())
            InkCore.Verb.LINE -> path.lineTo(op.x.toFloat(), op.y.toFloat())
            InkCore.Verb.QUAD ->
                path.quadraticTo(op.cx.toFloat(), op.cy.toFloat(), op.x.toFloat(), op.y.toFloat())
        }
    }
    return path
}
