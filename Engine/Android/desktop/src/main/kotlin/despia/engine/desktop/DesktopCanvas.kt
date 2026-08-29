//
//  DesktopCanvas.kt - `<canvas>` (U04) on Compose Desktop: the 2-D drawing surface, and with
//  it `<ink>`, so Windows and Linux draw the same picture as iOS, Android and the browser.
//
//  THIS FILE OWNS NO NUMBERS AND NO GEOMETRY. Every one lives in the platform-neutral kernel
//  (:core CanvasCore.kt and InkCore.kt, corpus OpenSource/Conformance/canvas/), which :desktop
//  already compiles verbatim - the reason this surface could be written at all is that the
//  display list, the tier-2 recorder, the ink capture folds and the a11y verdict were never
//  Android's. What is here is the Compose adapter and nothing else: a `Canvas` composable
//  whose DrawScope replays the kernel display list, the tier-2 replay, the withFrameNanos loop
//  under the kernel's 60/s budget, the pointer capture, and the declared semantic overlay.
//
//  WHY IT IS A NEAR-TWIN OF :render StackCanvas.kt AND NOT SHARED CODE. `:render` is an AGP
//  module that resolves the Android SDK; `:desktop` deliberately keeps a settings graph that
//  never configures AGP (desktop-platforms.md), so the two cannot share a source set today.
//  The adapter is ~200 lines of Compose calls over shared kernel types, and the alternative -
//  a common Compose module both depend on - is a build-graph change with its own risk. The
//  two files are kept structurally identical instead, and the corpus judges the KERNEL, which
//  is the part that could actually disagree.
//
//  THE ONE REAL DIVERGENCE FROM :render, stated rather than discovered: text. Android reaches
//  for `android.graphics.Paint` through `nativeCanvas`; here the multiplatform TextMeasurer
//  draws it, which is the portable spelling and needs no Skia import. Anchor handling is the
//  same three words, applied by measuring the run rather than by a platform Align enum.
//
//  NAMED GAPS, identical to the Android adapter (declared, never silently different):
//   - `<blur>` / `<shadow>` tier-1 wrappers are no-ops (Compose applies both as layer
//     modifiers, which a DrawScope cannot enter mid-list); `<blend>` IS applied.
//   - `<image>` / `drawImage`: the bytes ride the content plane, a composition-scoped fetch,
//     so the op is skipped rather than drawn from a blocking decode on the draw thread.
//
package despia.engine.desktop

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.TextUnitType
import androidx.compose.ui.unit.dp
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
import despia.engine.buildCanvasDisplayList
import despia.engine.canvasA11y
import despia.engine.runCanvasScript
import despia.engine.varsFlow
import despia.engine.writeBound

/**
 * One authored child, RESOLVED IN COMPOSITION. Everything a `{{ }}` hole can read is read here
 * rather than inside the DrawScope, which is what makes the surface reactive on this renderer:
 * a store write recomposes, the resolved list changes, and the draw repaints. `<ink>` is the one
 * child that cannot finish in composition - its committed strokes are normalized 0..1 and need
 * the surface's pixel size - so its STROKES are decoded here and folded to nodes in the draw.
 */
private class DesktopCanvasChild(
    val fixed: CanvasMarkupNode?,
    val inkStrokes: List<InkCore.Stroke>?,
    val inkPaint: String,
)

private fun desktopResolveCanvasChild(
    node: StackNode, context: DesktopElementContext,
): DesktopCanvasChild {
    if (node.tag == "ink") {
        return DesktopCanvasChild(
            fixed = null,
            inkStrokes = InkCore.decode(JSE.asRows(desktopInkBoundValue(node, context))),
            inkPaint = desktopInkStrokePaint(node, context),
        )
    }
    return DesktopCanvasChild(desktopResolveMarkup(node, context), null, "")
}

private fun desktopResolveMarkup(
    node: StackNode, context: DesktopElementContext,
): CanvasMarkupNode = CanvasMarkupNode(
    kind = node.tag,
    attrs = node.attrs.mapValues { (_, raw) -> JSE.interpolate(raw, context.store, context.item) },
    children = node.children.map { desktopResolveMarkup(it, context) },
)

private fun desktopInkBoundValue(node: StackNode, context: DesktopElementContext): Any? =
    node.attrs["bind"]?.let { JSE.eval(it, context.store, context.item) }

private fun desktopInkStrokePaint(node: StackNode, context: DesktopElementContext): String {
    val raw = node.attrs["stroke"] ?: return "label"
    val text = JSE.interpolate(raw, context.store, context.item).trim()
    return if (text.isEmpty()) "label" else text
}

/** The editable ink child, if the surface declares one. A read-only child still PAINTS; it
 *  just installs no capture. */
private fun desktopInkChild(node: StackNode): StackNode? =
    node.children.firstOrNull { it.tag == "ink" }

/** a tier-2 command list read off a bound expression: rows of [name, args...]. The shape is
 *  VERIFIED here, at the boundary, never asserted downstream. */
private fun desktopCanvasCommands(raw: Any?): List<List<Any?>> {
    val rows = raw as? List<*> ?: return emptyList()
    val out = ArrayList<List<Any?>>()
    for (row in rows) {
        val cells = row as? List<*> ?: continue
        if (cells.isEmpty() || cells[0] !is String) continue
        out.add(cells.toList())
    }
    return out
}

private fun desktopCanvasA11yChildren(raw: Any?): List<Map<String, Any?>> {
    val rows = raw as? List<*> ?: return emptyList()
    val out = ArrayList<Map<String, Any?>>()
    for (row in rows) {
        val record = row as? Map<*, *> ?: continue
        out.add(record.entries.associate { (k, v) -> k.toString() to v })
    }
    return out
}

@Composable
internal fun DesktopCanvasElement(context: DesktopElementContext, modifier: Modifier) {
    val node = context.node

    // the standalone-node subscription (the `<scene>` precedent): child-node holes resolve
    // OUTSIDE the root attr bundle, so this element observes the stores itself
    context.store.varsFlow.collectAsState().value
    DSX.state.varsFlow.collectAsState().value

    val attrs = context.attributes
    val commands = desktopCanvasCommands(
        attrs["commands"]?.let { JSE.eval(it, context.store, context.item) },
    )
    val overlay = desktopCanvasA11yChildren(
        attrs["a11yChildren"]?.let { JSE.eval(it, context.store, context.item) },
    )
    val resolved = attrs.mapValues { (_, raw) -> JSE.interpolate(raw, context.store, context.item) }
    val children = node.children.map { desktopResolveCanvasChild(it, context) }
    val verdict = canvasA11y(resolved, overlay)
    val measurer = rememberTextMeasurer()
    // the token vocabulary, captured out of composition: a DrawScope cannot read a theme
    val palette = rememberColorResolver()

    var onScreen by remember(node) { mutableStateOf(true) }
    val frameAction = attrs["on:frame"]?.takeIf { it.isNotBlank() }
    val drawAction = attrs["on:draw"]?.takeIf { it.isNotBlank() }
    val loop = remember(node) { CanvasFrameLoop(frameAction != null) }

    DisposableEffect(node) {
        loop.setMounted(true)
        onDispose { loop.setMounted(false) }
    }

    // The loop exists ONLY while a handler is authored AND the element is mounted AND it is on
    // screen. An always-running display link is a battery bug on a laptop exactly as it is on a
    // phone, and the corpus counts the installs; LaunchedEffect cancellation IS the unmount half.
    LaunchedEffect(node, frameAction, onScreen) {
        loop.setBound(frameAction != null)
        loop.setVisible(onScreen)
        while (loop.installed) {
            withFrameNanos { nanos ->
                loop.tick(nanos / 1_000_000.0)?.let { payload ->
                    frameAction?.let { action ->
                        context.run(
                            action,
                            mapOf(
                                "time" to payload.time, "delta" to payload.delta,
                                "frame" to payload.frame,
                            ),
                        )
                    }
                }
            }
        }
    }

    // `on:draw` is a NOTIFICATION, never a mutable graphics handle: it fires when the command
    // list changes so an author can refresh what the next frame replays.
    LaunchedEffect(node, drawAction, commands.size) {
        drawAction?.let { context.run(it, emptyMap()) }
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

    // THE IN-FLIGHT STROKE lives in view state and is painted on top of the display list. It is
    // never written to the store: that is the whole point of `<ink>` - a moved pointer must not
    // rebuild a display list. The store is written ONCE, on pointer-up.
    val ink = desktopInkChild(node)
    var live by remember(node) { mutableStateOf(emptyList<InkCore.Point>()) }
    val inkWidth = ink?.attrs?.get("strokeWidth")
        ?.let { JSE.number(JSE.eval(it, context.store, context.item)) } ?: InkCore.STROKE_WIDTH
    val inkReadOnly = ink?.attrs?.get("readOnly")
        ?.let { JSE.truthy(JSE.eval(it, context.store, context.item)) } ?: false
    val inkPaint = ink?.let { palette(desktopInkStrokePaint(it, context)) }

    val capture = if (ink == null || inkReadOnly) {
        Modifier
    } else {
        Modifier.pointerInput(node, inkWidth) {
            val minDistancePx = InkCore.MIN_POINT_DISTANCE.dp.toPx().toDouble()
            awaitEachGesture {
                val boxW = size.width.toDouble()
                val boxH = size.height.toDouble()
                val down = awaitFirstDown(requireUnconsumed = false)
                live = listOf(
                    InkCore.point(down.position.x.toDouble(), down.position.y.toDouble(), boxW, boxH),
                )
                desktopRaiseCanvasEvent(
                    context, "strokeStart",
                    mapOf("strokes" to InkCore.decode(JSE.asRows(desktopInkBoundValue(ink, context))).size),
                )
                var event = awaitPointerEvent()
                while (event.changes.any { it.pressed }) {
                    for (change in event.changes) {
                        if (!change.pressed) continue
                        val point = InkCore.point(
                            change.position.x.toDouble(), change.position.y.toDouble(), boxW, boxH,
                        )
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
                    val committed = InkCore.decode(JSE.asRows(desktopInkBoundValue(ink, context))) +
                        InkCore.Stroke(captured, inkWidth)
                    val bindKey = ink.attrs["bind"]
                    if (bindKey != null) context.store.writeBound(bindKey, InkCore.encode(committed))
                    desktopRaiseCanvasEvent(
                        context, "strokeEnd",
                        mapOf("strokes" to committed.size, "points" to captured.size),
                    )
                }
            }
        }
    }

    // The unstyled box is the web's `.dsx-canvas`: `inline-size: 100%; block-size: 100%`. Only
    // an UNAUTHORED axis fills, because `fillMaxSize()` pins min == max and would then clamp an
    // authored `height=` arriving on the style modifier - which is how two stacked canvases
    // ended up with the first one eating the whole column.
    var box: Modifier = Modifier
    if (!attrs.containsKey("width")) box = box.fillMaxWidth()
    if (!attrs.containsKey("height")) box = box.fillMaxHeight()
    Canvas(
        modifier = box
            .onGloballyPositioned { coords ->
                val bounds = coords.boundsInWindow()
                onScreen = bounds.width > 0f && bounds.height > 0f
            }
            .then(capture)
            .then(semantics)
            .then(modifier),
    ) {
        val list = buildCanvasDisplayList(
            children.flatMap { child ->
                val fixed = child.fixed
                if (fixed != null) {
                    listOf(fixed)
                } else {
                    InkCore.nodes(
                        child.inkStrokes.orEmpty(),
                        size.width.toDouble(), size.height.toDouble(), child.inkPaint,
                    )
                }
            },
        )
        for (op in list.ops) drawDesktopCanvasOp(op, list, measurer, palette)
        if (commands.isNotEmpty()) {
            for (entry in runCanvasScript(commands).log) drawDesktopCanvasEntry(entry, size, measurer, palette)
        }
        if (live.isNotEmpty() && inkPaint != null) {
            drawPath(
                desktopInkPath(live, size),
                color = inkPaint,
                style = Stroke(
                    width = inkWidth.dp.toPx(),
                    cap = desktopCanvasCap(InkCore.LINECAP),
                    join = desktopCanvasJoin(InkCore.LINEJOIN),
                ),
            )
        }
    }
}

/** The shared ops, replayed onto a Compose path - the curve itself lives in :core. The ONE
 *  copy on this renderer: `<Signature>`'s pad draws its committed strokes through it too. */
internal fun desktopInkPath(points: List<InkCore.Point>, size: Size): Path {
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

/** `on:strokeStart` / `on:strokeEnd` ride the CANVAS element, beside `on:draw` and `on:frame` -
 *  the surface owns its events; `<ink>` owns the value. */
private fun desktopRaiseCanvasEvent(
    context: DesktopElementContext, name: String, payload: Map<String, Any?>,
) {
    context.attributes["on:$name"]?.takeIf { it.isNotBlank() }?.let { context.run(it, payload) }
}

private fun desktopCanvasPath(segments: List<CanvasSegment>, rule: String): Path {
    val path = Path()
    path.fillType = if (rule == "evenodd") PathFillType.EvenOdd else PathFillType.NonZero
    for (seg in segments) {
        val v = seg.values
        when (seg.cmd) {
            "M" -> path.moveTo(v[0].toFloat(), v[1].toFloat())
            "L" -> path.lineTo(v[0].toFloat(), v[1].toFloat())
            "Q" -> path.quadraticTo(v[0].toFloat(), v[1].toFloat(), v[2].toFloat(), v[3].toFloat())
            "C" -> path.cubicTo(
                v[0].toFloat(), v[1].toFloat(), v[2].toFloat(), v[3].toFloat(),
                v[4].toFloat(), v[5].toFloat(),
            )
            else -> path.close()
        }
    }
    return path
}

private fun desktopCanvasMatrix(m: CanvasMatrix): Matrix {
    val out = Matrix()
    out.values[Matrix.ScaleX] = m.a.toFloat()
    out.values[Matrix.SkewY] = m.b.toFloat()
    out.values[Matrix.SkewX] = m.c.toFloat()
    out.values[Matrix.ScaleY] = m.d.toFloat()
    out.values[Matrix.TranslateX] = m.e.toFloat()
    out.values[Matrix.TranslateY] = m.f.toFloat()
    return out
}

/** a semantic token survives the kernel UNRESOLVED on purpose; the theme owns it, and on the
 *  desktop the theme is the renderer's own token table (`color`, the one vocabulary). */
private fun desktopCanvasColor(paint: CanvasPaint?, palette: (String) -> Color): Color? = when (paint) {
    null -> null
    is CanvasPaint.Rgba -> Color(
        paint.r.toFloat(), paint.g.toFloat(), paint.b.toFloat(), paint.a.toFloat(),
    )
    is CanvasPaint.Token -> palette(paint.token)
    is CanvasPaint.Gradient -> null
}

private fun desktopCanvasBrush(
    paint: CanvasPaint?, list: CanvasDisplayList, palette: (String) -> Color,
): Brush? {
    if (paint is CanvasPaint.Gradient) {
        val gradient = list.gradients[paint.id] ?: return null
        return desktopCanvasGradientBrush(gradient, palette)
    }
    return desktopCanvasColor(paint, palette)?.let { SolidColor(it) }
}

private fun desktopCanvasGradientBrush(
    gradient: CanvasGradient, palette: (String) -> Color,
): Brush? {
    if (gradient.stops.isEmpty()) return null
    val stops = gradient.stops.map { stop ->
        val rgba = stop.rgba
        val resolved = if (rgba != null) {
            Color(rgba.r.toFloat(), rgba.g.toFloat(), rgba.b.toFloat(), rgba.a.toFloat())
        } else {
            palette(stop.token ?: "label").copy(alpha = stop.opacity.toFloat())
        }
        stop.offset.toFloat().coerceIn(0f, 1f) to resolved
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
        // Compose ships a real sweep, so `angular` is not an approximation here either.
        else -> Brush.sweepGradient(colorStops = stops, center = Offset(geom(0), geom(1)))
    }
}

private fun desktopCanvasBlend(mode: String): BlendMode? = when (mode) {
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

private fun DrawScope.withDesktopCanvasEffects(
    effects: List<CanvasEffect>, body: DrawScope.() -> Unit,
) {
    val blend = effects.filterIsInstance<CanvasEffect.Blend>().lastOrNull()
    val mode = blend?.let { desktopCanvasBlend(it.mode) }
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

private fun DrawScope.withDesktopCanvasClip(clip: CanvasClip?, body: DrawScope.() -> Unit) {
    if (clip == null) {
        body()
        return
    }
    withTransform({ transform(desktopCanvasMatrix(clip.transform)) }) {
        clipPath(desktopCanvasPath(clip.path, "nonzero")) { body() }
    }
}

/** paint one display-list op */
private fun DrawScope.drawDesktopCanvasOp(
    op: CanvasOp, list: CanvasDisplayList, measurer: TextMeasurer, palette: (String) -> Color,
) {
    withDesktopCanvasClip(op.clip) {
        withDesktopCanvasEffects(op.effects) {
            withTransform({ transform(desktopCanvasMatrix(op.transform)) }) {
                when (op.kind) {
                    "text" -> desktopCanvasColor(op.fill, palette)?.let {
                        drawDesktopCanvasText(
                            measurer, op.text ?: "", op.x, op.y, op.fontSize, op.textAnchor,
                            it.copy(alpha = it.alpha * op.opacity.toFloat()),
                        )
                    }
                    "image" -> Unit   // the content plane owns the bytes; header gap note
                    else -> {
                        val path = desktopCanvasPath(op.path ?: emptyList(), op.fillRule)
                        desktopCanvasBrush(op.fill, list, palette)?.let {
                            drawPath(path, it, alpha = op.opacity.toFloat(), style = Fill)
                        }
                        desktopCanvasBrush(op.stroke, list, palette)?.let {
                            drawPath(
                                path, it, alpha = op.opacity.toFloat(),
                                style = Stroke(
                                    width = op.strokeWidth.toFloat(),
                                    cap = desktopCanvasCap(op.strokeLinecap),
                                    join = desktopCanvasJoin(op.strokeLinejoin),
                                ),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** replay one recorded tier-2 entry. The kernel recorder has already baked the CTM into every
 *  path point, so the surface stays in device space. */
private fun DrawScope.drawDesktopCanvasEntry(
    entry: CanvasDrawEntry, bounds: Size, measurer: TextMeasurer, palette: (String) -> Color,
) {
    val body: DrawScope.() -> Unit = {
        when (entry.op) {
            "fill" -> desktopCanvasColor(entry.style, palette)?.let {
                drawPath(
                    desktopCanvasPath(entry.path ?: emptyList(), entry.rule ?: "nonzero"), it,
                    alpha = entry.alpha.toFloat(), style = Fill,
                )
            }
            "stroke" -> desktopCanvasColor(entry.style, palette)?.let {
                drawPath(
                    desktopCanvasPath(entry.path ?: emptyList(), "nonzero"), it,
                    alpha = entry.alpha.toFloat(),
                    style = Stroke(
                        width = (entry.lineWidth ?: 1.0).toFloat(),
                        cap = desktopCanvasCap(entry.cap ?: "butt"),
                        join = desktopCanvasJoin(entry.join ?: "miter"),
                    ),
                )
            }
            "clear" -> {
                val rect = entry.rect
                val topLeft = if (rect == null) Offset.Zero else Offset(rect[0].toFloat(), rect[1].toFloat())
                val area = if (rect == null) bounds else Size(rect[2].toFloat(), rect[3].toFloat())
                drawRect(Color.Transparent, topLeft = topLeft, size = area, blendMode = BlendMode.Clear)
            }
            "fillText", "strokeText" -> desktopCanvasColor(entry.style, palette)?.let {
                drawDesktopCanvasText(
                    measurer, entry.text ?: "", entry.x ?: 0.0, entry.y ?: 0.0,
                    entry.fontSize ?: 10.0, "start",
                    it.copy(alpha = it.alpha * entry.alpha.toFloat()),
                )
            }
            else -> Unit   // drawImage rides the content plane; header gap note
        }
    }
    val clip = entry.clip
    if (clip == null) body() else clipPath(desktopCanvasPath(clip.path, clip.rule)) { body() }
}

/**
 * SVG text is positioned on its BASELINE and anchored horizontally; Compose lays a text run out
 * from its top-left. Measuring the run converts one to the other, which is also the only way to
 * honour `middle`/`end` without a platform Align enum.
 */
private fun DrawScope.drawDesktopCanvasText(
    measurer: TextMeasurer, value: String, x: Double, y: Double, fontSize: Double,
    anchor: String, paint: Color,
) {
    if (value.isEmpty()) return
    val style = TextStyle(color = paint, fontSize = TextUnit(fontSize.toFloat(), TextUnitType.Sp))
    val measured = measurer.measure(value, style)
    val dx = when (anchor) {
        "middle" -> measured.size.width / 2f
        "end" -> measured.size.width.toFloat()
        else -> 0f
    }
    drawText(
        measured,
        topLeft = Offset(x.toFloat() - dx, y.toFloat() - measured.firstBaseline),
    )
}

private fun desktopCanvasCap(word: String): StrokeCap = when (word) {
    "round" -> StrokeCap.Round
    "square" -> StrokeCap.Square
    else -> StrokeCap.Butt
}

private fun desktopCanvasJoin(word: String): StrokeJoin = when (word) {
    "round" -> StrokeJoin.Round
    "bevel" -> StrokeJoin.Bevel
    else -> StrokeJoin.Miter
}
