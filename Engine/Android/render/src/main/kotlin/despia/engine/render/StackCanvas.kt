//
//  StackCanvas.kt - the Android `<canvas>` element (parity/U04-canvas.md): the 2-D drawing
//  surface. Every NUMBER lives in the platform-neutral kernel (:core CanvasCore.kt - corpus
//  OpenSource/Conformance/canvas/); this file only owns the Compose adapter: a `Canvas`
//  composable whose DrawScope replays the kernel display list, the tier-2 command replay, the
//  withFrameNanos loop under the kernel's 60/s budget, and the declared accessibility
//  overlay. No Skia dependency: Compose's own rasteriser IS the platform answer, which is the
//  deliberate paragraph-3d decision.
//
//  TIER 1 is RETAINED: the child tree folds to a display list and the matrix rides beside each
//  path, so a transform animation repaints the same geometry under a new CTM instead of
//  rebuilding it. TIER 2 is IMMEDIATE: a `commands` list is replayed over the whole surface,
//  tier 1 painting first (the corpus pins the ordering).
//
//  TIER 2 IS A COMMAND LIST, NOT A LIVE `ctx` OBJECT. The corpus models it that way
//  (`tier2.json` `script` is an array of arrays) and the handler payload seam carries DATA,
//  not live handles - so the author builds commands and the renderer replays them through the
//  SAME kernel recorder all three renderers run. `on:draw` fires when the list changes so an
//  author can refresh it; it is a notification, never a mutable graphics handle.
//
//  NAMED GAPS on this renderer (declared, never silently different):
//   - `<blur>` and `<shadow>` tier-1 wrappers: Compose applies a blur as a LAYER modifier and
//     a drop shadow as a paint shadow layer, neither of which a DrawScope can enter mid-list.
//     `<blend>` IS applied (saveLayer + BlendMode). The other two are no-ops here and are
//     tracked in ClosedSource/Documentation/android-status.md.
//   - `<image>` / `drawImage`: the bytes ride the content plane, which is a composition-scoped
//     fetch; the op is skipped rather than drawn from a blocking decode on the draw thread.
//
package despia.engine.render

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import despia.engine.CanvasClip
import despia.engine.CanvasDisplayList
import despia.engine.CanvasDrawEntry
import despia.engine.CanvasEffect
import despia.engine.CanvasFrameLoop
import despia.engine.CanvasGradient
import despia.engine.CanvasMarkupNode
import despia.engine.CanvasMatrix
import despia.engine.CanvasOp
import despia.engine.CanvasPaint
import despia.engine.CanvasSegment
import despia.engine.DSX
import despia.engine.InkCore
import despia.engine.JSE
import despia.engine.StackNode
import despia.engine.writeBound
import despia.engine.buildCanvasDisplayList
import despia.engine.canvasA11y
import despia.engine.runCanvasScript
import despia.engine.render.elements.elementModifier
import despia.engine.varsFlow

internal fun registerCanvasElement() {
    ComposeStackComponents.defineNative("canvas") { ctx -> CanvasView(ctx) }
}

/** the authored subtree with every `{{ }}` hole resolved against the live store. Unknown tags
 *  ride through untouched so the KERNEL emits the one Article-7 diagnostic, on every renderer
 *  at the same point. */
private fun canvasMarkup(
    node: StackNode, ctx: ComposeStackComponentContext,
): CanvasMarkupNode = CanvasMarkupNode(
    kind = node.tag,
    attrs = node.attrs.mapValues { (_, raw) -> JSE.interpolate(raw, ctx.store, ctx.item) },
    children = node.children.flatMap { canvasExpand(it, ctx, 0.0, 0.0) },
)

/** A child becomes ONE markup node, except `<ink>`, whose COMMITTED strokes become one stroked
 *  path each (canvas/ink.json) — in the surface's own pixel space, which is why the size is
 *  passed in. Only the in-flight stroke is transient paint; everything stored is tier 1. */
private fun canvasExpand(
    node: StackNode, ctx: ComposeStackComponentContext, width: Double, height: Double,
): List<CanvasMarkupNode> {
    if (node.tag == "ink") {
        val strokes = InkCore.decode(JSE.asRows(inkBoundValue(node, ctx)))
        return InkCore.nodes(strokes, width, height, inkStrokePaint(node, ctx))
    }
    return listOf(CanvasMarkupNode(
        kind = node.tag,
        attrs = node.attrs.mapValues { (_, raw) -> JSE.interpolate(raw, ctx.store, ctx.item) },
        children = node.children.flatMap { canvasExpand(it, ctx, width, height) },
    ))
}

private fun inkBoundValue(node: StackNode, ctx: ComposeStackComponentContext): Any? =
    node.attrs["bind"]?.let { JSE.eval(it, ctx.store, ctx.item) }

private fun inkStrokePaint(node: StackNode, ctx: ComposeStackComponentContext): String {
    val raw = node.attrs["stroke"] ?: return "label"
    val text = JSE.interpolate(raw, ctx.store, ctx.item).trim()
    return if (text.isEmpty()) "label" else text
}

/** The editable ink child, if the surface declares one. A read-only child still PAINTS; it
 *  just installs no capture. */
private fun inkChild(node: StackNode): StackNode? = node.children.firstOrNull { it.tag == "ink" }

/** a tier-2 command list read off a bound expression: rows of [name, args...]. The shape is
 *  VERIFIED here, at the boundary, never asserted downstream. */
private fun canvasCommands(raw: Any?): List<List<Any?>> {
    val rows = raw as? List<*> ?: return emptyList()
    val out = ArrayList<List<Any?>>()
    for (row in rows) {
        val cells = row as? List<*> ?: continue
        if (cells.isEmpty() || cells[0] !is String) continue
        out.add(cells.toList())
    }
    return out
}

private fun canvasA11yChildren(raw: Any?): List<Map<String, Any?>> {
    val rows = raw as? List<*> ?: return emptyList()
    val out = ArrayList<Map<String, Any?>>()
    for (row in rows) {
        val record = row as? Map<*, *> ?: continue
        out.add(record.entries.associate { (k, v) -> k.toString() to v })
    }
    return out
}

@Composable
private fun CanvasView(ctx: ComposeStackComponentContext) {
    val node: StackNode = ctx.node ?: return

    // the standalone-node subscription (the <scene> precedent): child-node holes resolve
    // OUTSIDE the root attr bundle, so this element observes the stores itself
    ctx.store.varsFlow.collectAsState().value
    DSX.state.varsFlow.collectAsState().value

    val commands = canvasCommands(ctx.attrs["commands"]?.let { JSE.eval(it, ctx.store, ctx.item) })
    val overlay = canvasA11yChildren(ctx.attrs["a11yChildren"]?.let { JSE.eval(it, ctx.store, ctx.item) })
    val resolved = ctx.attrs.mapValues { (_, raw) -> JSE.interpolate(raw, ctx.store, ctx.item) }
    val verdict = canvasA11y(resolved, overlay)

    var onScreen by remember(node) { mutableStateOf(true) }
    val frameAction = ctx.attrs["on:frame"]?.takeIf { it.isNotBlank() }
    val drawAction = ctx.attrs["on:draw"]?.takeIf { it.isNotBlank() }
    val loop = remember(node) { CanvasFrameLoop(frameAction != null) }

    DisposableEffect(node) {
        loop.setMounted(true)
        onDispose { loop.setMounted(false) }
    }

    // The loop exists ONLY while a handler is authored AND the element is mounted AND it is on
    // screen. An always-running display link is a battery bug and the corpus counts the
    // installs; LaunchedEffect cancellation IS the unmount half of the law.
    LaunchedEffect(node, frameAction, onScreen) {
        loop.setBound(frameAction != null)
        loop.setVisible(onScreen)
        while (loop.installed) {
            withFrameNanos { nanos ->
                loop.tick(nanos / 1_000_000.0)?.let { payload ->
                    frameAction?.let { action ->
                        ctx.env.run(action, ctx.item, mapOf(
                            "time" to payload.time, "delta" to payload.delta,
                            "frame" to payload.frame,
                        ))
                    }
                }
            }
        }
    }

    // `on:draw` is a NOTIFICATION, never a mutable graphics handle: it fires when the command
    // list changes so an author can refresh what the next frame replays.
    LaunchedEffect(node, drawAction, commands.size) {
        drawAction?.let { ctx.env.run(it, ctx.item, emptyMap()) }
    }

    val semantics =
        if (verdict.hidden) {
            // a decorative flourish is HIDDEN from assistive tech - the correct default, and
            // the reason the lint rule can afford to be an error where it does apply
            Modifier.clearAndSetSemantics { }
        } else {
            Modifier.semantics {
                verdict.label?.let { contentDescription = it }
                when (verdict.role) {
                    "button" -> role = Role.Button
                    "image" -> role = Role.Image
                    else -> Unit
                }
                // The declared overlay is the accessible bar-chart pattern: a canvas has no
                // view tree, so the author's rows become one readable description in the order
                // they were declared rather than silence.
                if (verdict.children.isNotEmpty()) {
                    stateDescription = verdict.children.joinToString(", ") { child ->
                        if (child.value == null) child.label else child.label + ": " + child.value
                    }
                }
            }
        }

    // THE IN-FLIGHT STROKE lives in view state and is painted on top of the display list. It
    // is never written to the store: that is the whole point of `<ink>` — a moved finger must
    // not rebuild a display list. The store is written ONCE, on pointer-up.
    val ink = inkChild(node)
    var live by remember(node) { mutableStateOf(emptyList<InkCore.Point>()) }
    val inkWidth = ink?.attrs?.get("strokeWidth")
        ?.let { JSE.number(JSE.eval(it, ctx.store, ctx.item)) } ?: InkCore.STROKE_WIDTH
    val inkReadOnly = ink?.attrs?.get("readOnly")
        ?.let { JSE.truthy(JSE.eval(it, ctx.store, ctx.item)) } ?: false
    val inkPaint = ink?.let { StackStyle.color(inkStrokePaint(it, ctx)) }

    val capture = if (ink == null || inkReadOnly) Modifier else Modifier.pointerInput(node, inkWidth) {
        val minDistancePx = InkCore.MIN_POINT_DISTANCE.dp.toPx().toDouble()
        awaitEachGesture {
            val boxW = size.width.toDouble()
            val boxH = size.height.toDouble()
            val down = awaitFirstDown(requireUnconsumed = false)
            live = listOf(InkCore.point(down.position.x.toDouble(), down.position.y.toDouble(), boxW, boxH))
            raiseCanvasEvent(ctx, "strokeStart",
                             mapOf("strokes" to InkCore.decode(JSE.asRows(inkBoundValue(ink, ctx))).size))
            var event = awaitPointerEvent()
            while (event.changes.any { it.pressed }) {
                for (change in event.changes) {
                    if (!change.pressed) continue
                    val point = InkCore.point(change.position.x.toDouble(), change.position.y.toDouble(), boxW, boxH)
                    val last = live.last()
                    val dx = (point.x - last.x) * boxW
                    val dy = (point.y - last.y) * boxH
                    if (dx * dx + dy * dy >= minDistancePx * minDistancePx) live = live + point
                    change.consume()
                }
                event = awaitPointerEvent()
            }
            val captured = live
            live = emptyList()
            if (captured.isNotEmpty()) {
                val committed = InkCore.decode(JSE.asRows(inkBoundValue(ink, ctx))) +
                    InkCore.Stroke(captured, inkWidth)
                val bindKey = ink.attrs["bind"]
                if (bindKey != null) ctx.store.writeBound(bindKey, InkCore.encode(committed))
                raiseCanvasEvent(ctx, "strokeEnd", mapOf("strokes" to committed.size,
                                                         "points" to captured.size))
            }
        }
    }

    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .onGloballyPositioned { coords ->
                val bounds = coords.boundsInWindow()
                onScreen = bounds.width > 0f && bounds.height > 0f
            }
            .then(capture)
            .then(semantics)
            .elementModifier(ctx)
    ) {
        val list = buildCanvasDisplayList(
            node.children.flatMap { canvasExpand(it, ctx, size.width.toDouble(), size.height.toDouble()) },
        )
        for (op in list.ops) drawCanvasOp(op, list)
        if (commands.isNotEmpty()) {
            for (entry in runCanvasScript(commands).log) drawCanvasEntry(entry, size)
        }
        if (live.isNotEmpty() && inkPaint != null) {
            drawPath(
                inkLivePath(live, size),
                color = inkPaint,
                style = Stroke(width = inkWidth.dp.toPx(),
                               cap = canvasCap(InkCore.LINECAP), join = canvasJoin(InkCore.LINEJOIN)),
            )
        }
    }
}

/** The shared ops, replayed onto a Compose path — the curve itself lives in :core. */
private fun inkLivePath(points: List<InkCore.Point>, size: Size): Path {
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

/** `on:strokeStart` / `on:strokeEnd` ride the CANVAS element, beside `on:draw` and
 *  `on:frame` — the surface owns its events; `<ink>` owns the value. */
private fun raiseCanvasEvent(
    ctx: ComposeStackComponentContext, name: String, payload: Map<String, Any?>,
) {
    ctx.attrs["on:$name"]?.takeIf { it.isNotBlank() }?.let { ctx.env.run(it, ctx.item, payload) }
}

private fun canvasPath(segments: List<CanvasSegment>, rule: String): Path {
    val path = Path()
    path.fillType = if (rule == "evenodd") PathFillType.EvenOdd else PathFillType.NonZero
    for (seg in segments) {
        val v = seg.values
        when (seg.cmd) {
            "M" -> path.moveTo(v[0].toFloat(), v[1].toFloat())
            "L" -> path.lineTo(v[0].toFloat(), v[1].toFloat())
            "Q" -> path.quadraticTo(v[0].toFloat(), v[1].toFloat(), v[2].toFloat(), v[3].toFloat())
            "C" -> path.cubicTo(v[0].toFloat(), v[1].toFloat(), v[2].toFloat(), v[3].toFloat(),
                                v[4].toFloat(), v[5].toFloat())
            else -> path.close()
        }
    }
    return path
}

private fun canvasMatrix(m: CanvasMatrix): Matrix {
    val out = Matrix()
    out.values[Matrix.ScaleX] = m.a.toFloat()
    out.values[Matrix.SkewY] = m.b.toFloat()
    out.values[Matrix.SkewX] = m.c.toFloat()
    out.values[Matrix.ScaleY] = m.d.toFloat()
    out.values[Matrix.TranslateX] = m.e.toFloat()
    out.values[Matrix.TranslateY] = m.f.toFloat()
    return out
}

/** a semantic token survives the kernel UNRESOLVED on purpose; the theme owns it, and on
 *  Android the theme is the live Material scheme (StackStyle.color, the one vocabulary) */
private fun canvasColor(paint: CanvasPaint?): Color? = when (paint) {
    null -> null
    is CanvasPaint.Rgba -> Color(
        paint.r.toFloat(), paint.g.toFloat(), paint.b.toFloat(), paint.a.toFloat(),
    )
    is CanvasPaint.Token -> StackStyle.color(paint.token)
    is CanvasPaint.Gradient -> null
}

private fun canvasBrush(paint: CanvasPaint?, list: CanvasDisplayList): Brush? {
    if (paint is CanvasPaint.Gradient) {
        val gradient = list.gradients[paint.id] ?: return null
        return canvasGradientBrush(gradient)
    }
    return canvasColor(paint)?.let { SolidColor(it) }
}

private fun canvasGradientBrush(gradient: CanvasGradient): Brush? {
    if (gradient.stops.isEmpty()) return null
    val stops = gradient.stops.map { stop ->
        val rgba = stop.rgba
        val color = if (rgba != null) {
            Color(rgba.r.toFloat(), rgba.g.toFloat(), rgba.b.toFloat(), rgba.a.toFloat())
        } else {
            StackStyle.color(stop.token ?: "label").copy(alpha = stop.opacity.toFloat())
        }
        stop.offset.toFloat().coerceIn(0f, 1f) to color
    }.toTypedArray()
    fun geom(i: Int): Float = if (i < gradient.geom.size) gradient.geom[i].toFloat() else 0f
    return when (gradient.kind) {
        "linear" -> Brush.linearGradient(
            colorStops = stops, start = Offset(geom(0), geom(1)), end = Offset(geom(2), geom(3)),
        )
        "radial" -> Brush.radialGradient(
            colorStops = stops, center = Offset(geom(0), geom(1)),
            radius = geom(2).coerceAtLeast(0.01f),
        )
        // Compose ships a real sweep, so `angular` is not an approximation here.
        else -> Brush.sweepGradient(colorStops = stops, center = Offset(geom(0), geom(1)))
    }
}

private fun canvasBlend(mode: String): BlendMode? = when (mode) {
    "multiply" -> BlendMode.Multiply
    "screen" -> BlendMode.Screen
    "overlay" -> BlendMode.Overlay
    "darken" -> BlendMode.Darken
    "lighten" -> BlendMode.Lighten
    "difference" -> BlendMode.Difference
    "exclusion" -> BlendMode.Exclusion
    "hue" -> BlendMode.Hue
    "saturation" -> BlendMode.Saturation
    "color" -> BlendMode.Color
    "luminosity" -> BlendMode.Luminosity
    else -> null
}

private fun DrawScope.withCanvasEffects(effects: List<CanvasEffect>, body: DrawScope.() -> Unit) {
    val blend = effects.filterIsInstance<CanvasEffect.Blend>().lastOrNull()
    val mode = blend?.let { canvasBlend(it.mode) }
    if (mode == null) {
        body()
        return
    }
    val paint = androidx.compose.ui.graphics.Paint()
    paint.blendMode = mode
    drawContext.canvas.saveLayer(Rect(Offset.Zero, size), paint)
    body()
    drawContext.canvas.restore()
}

private fun DrawScope.withCanvasClip(clip: CanvasClip?, body: DrawScope.() -> Unit) {
    if (clip == null) {
        body()
        return
    }
    withTransform({ transform(canvasMatrix(clip.transform)) }) {
        clipPath(canvasPath(clip.path, "nonzero")) { body() }
    }
}

/** paint one display-list op */
private fun DrawScope.drawCanvasOp(op: CanvasOp, list: CanvasDisplayList) {
    withCanvasClip(op.clip) {
        withCanvasEffects(op.effects) {
            withTransform({ transform(canvasMatrix(op.transform)) }) {
                when (op.kind) {
                    "text" -> canvasColor(op.fill)?.let {
                        drawCanvasText(op.text ?: "", op.x, op.y, op.fontSize, op.textAnchor,
                                       it.copy(alpha = it.alpha * op.opacity.toFloat()))
                    }
                    "image" -> Unit   // the content plane owns the bytes; header gap note
                    else -> {
                        val path = canvasPath(op.path ?: emptyList(), op.fillRule)
                        canvasBrush(op.fill, list)?.let {
                            drawPath(path, it, alpha = op.opacity.toFloat(), style = Fill)
                        }
                        canvasBrush(op.stroke, list)?.let {
                            drawPath(path, it, alpha = op.opacity.toFloat(), style = Stroke(
                                width = op.strokeWidth.toFloat(),
                                cap = canvasCap(op.strokeLinecap),
                                join = canvasJoin(op.strokeLinejoin),
                            ))
                        }
                    }
                }
            }
        }
    }
}

/** replay one recorded tier-2 entry. The kernel recorder has already baked the CTM into every
 *  path point, so the surface stays in device space. */
private fun DrawScope.drawCanvasEntry(entry: CanvasDrawEntry, bounds: Size) {
    val body: DrawScope.() -> Unit = {
        when (entry.op) {
            "fill" -> canvasColor(entry.style)?.let {
                drawPath(canvasPath(entry.path ?: emptyList(), entry.rule ?: "nonzero"), it,
                         alpha = entry.alpha.toFloat(), style = Fill)
            }
            "stroke" -> canvasColor(entry.style)?.let {
                drawPath(canvasPath(entry.path ?: emptyList(), "nonzero"), it,
                         alpha = entry.alpha.toFloat(), style = Stroke(
                             width = (entry.lineWidth ?: 1.0).toFloat(),
                             cap = canvasCap(entry.cap ?: "butt"),
                             join = canvasJoin(entry.join ?: "miter"),
                         ))
            }
            "clear" -> {
                val rect = entry.rect
                val topLeft = if (rect == null) Offset.Zero else Offset(rect[0].toFloat(), rect[1].toFloat())
                val area = if (rect == null) bounds else Size(rect[2].toFloat(), rect[3].toFloat())
                drawRect(Color.Transparent, topLeft = topLeft, size = area, blendMode = BlendMode.Clear)
            }
            "fillText", "strokeText" -> canvasColor(entry.style)?.let {
                drawCanvasText(entry.text ?: "", entry.x ?: 0.0, entry.y ?: 0.0,
                               entry.fontSize ?: 10.0, "start",
                               it.copy(alpha = it.alpha * entry.alpha.toFloat()))
            }
            else -> Unit   // drawImage rides the content plane; header gap note
        }
    }
    val clip = entry.clip
    if (clip == null) body() else clipPath(canvasPath(clip.path, clip.rule)) { body() }
}

private fun DrawScope.drawCanvasText(
    value: String, x: Double, y: Double, fontSize: Double, anchor: String, color: Color,
) {
    if (value.isEmpty()) return
    val paint = android.graphics.Paint()
    paint.isAntiAlias = true
    paint.color = color.toArgb()
    paint.textSize = fontSize.toFloat()
    paint.textAlign = when (anchor) {
        "middle" -> android.graphics.Paint.Align.CENTER
        "end" -> android.graphics.Paint.Align.RIGHT
        else -> android.graphics.Paint.Align.LEFT
    }
    drawContext.canvas.nativeCanvas.drawText(value, x.toFloat(), y.toFloat(), paint)
}

private fun canvasCap(word: String): StrokeCap = when (word) {
    "round" -> StrokeCap.Round
    "square" -> StrokeCap.Square
    else -> StrokeCap.Butt
}

private fun canvasJoin(word: String): StrokeJoin = when (word) {
    "round" -> StrokeJoin.Round
    "bevel" -> StrokeJoin.Bevel
    else -> StrokeJoin.Miter
}
