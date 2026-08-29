//
//  Displays.kt — the data-display native globals: `<Table>`, `<Accordion>`, `<Skeleton>`,
//  `<ChatBubble>`, `<ProgressRing>`. Kotlin twins of Foundation Core/Table.swift,
//  Core/Accordion.swift, Core/Skeleton.swift, Core/ChatBubble.swift, Core/ProgressRing.swift
//  — geometry 1:1 from the Swift sources:
//
//  TABLE: header row 13 semibold secondary (v-padding 8, header semantics) · divider ·
//  data rows 15 (color default `label`), lineLimit 1, v-padding 9, equal flexible columns
//  (spacing 8), a half-opacity divider between rows (never after the last); `fields`
//  defaults to the lowercased `columns`; a row merges into ONE a11y utterance
//  (mergeDescendants — the Swift header names this exact Compose twin).
//
//  ACCORDION: tappable header (custom `header` slot replaces the default Text(title) +
//  spacer + chevron.right tinted `color` default accent, rotating 90° while open, easeInOut)
//  · the default slot as the collapsible body (open= initial state, default false) ·
//  raises `toggle` with { open } on every flip.
//
//  SKELETON: full row width × height (default 14), radius (default 8), fill primary 8%
//  (dark → white 8%) with a continuous shimmer sweep — a 60%-width [clear, primary 10%,
//  clear] gradient animating phase −0.6 → 1.0 of the width, 1.1s linear, repeating.
//
//  CHATBUBBLE: side= left(default)/right aligns + squares the bottom corner on its own
//  side (18 / tail 4); color default accent (right) / #2C2C2E (left); maxWidth default
//  280; content padding h14 / v10.
//
//  PROGRESSRING: track circle (trackColor default #2C2C2E) + a trimmed round-cap arc from
//  12 o'clock (−90°), fraction = clamp(value/max, 0…1) (NaN/±inf → empty); lineWidth
//  default 10; color default accent; size default 88; optional centered label (17, label).
//

package despia.engine.render.elements

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.snap
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.DSXStrings
import despia.engine.JSE
import androidx.compose.material3.minimumInteractiveComponentSize
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.StackIcon
import despia.engine.render.StackMotion
import despia.engine.render.StackStyle
import despia.engine.render.rememberAnimatorDurationScale
import despia.engine.render.dsxAccessibleActivation

internal fun registerDisplayElements() {
    ComposeStackComponents.defineNative("Table") { ctx -> TableElement(ctx) }
    ComposeStackComponents.defineNative("Accordion") { ctx -> AccordionElement(ctx) }
    ComposeStackComponents.defineNative("Skeleton") { ctx -> SkeletonElement(ctx) }
    ComposeStackComponents.defineNative("ChatBubble") { ctx -> ChatBubbleElement(ctx) }
    ComposeStackComponents.defineNative("ProgressRing") { ctx -> ProgressRingElement(ctx) }
}

// MARK: - <Table>

/// Table.swift csv(_:) — trimmed, empties dropped.
internal fun tableCsv(s: String): List<String> =
    s.split(",").map { it.trim() }.filter { it.isNotEmpty() }

/// `fields` defaults to the lowercased column labels (Table.swift).
internal fun tableFields(columns: List<String>, fields: List<String>): List<String> =
    fields.ifEmpty { columns.map { it.lowercase() } }

@Composable
private fun TableElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val columns = tableCsv(el.str("columns"))
    val fields = tableFields(columns, tableCsv(el.str("fields")))
    val rows = el.list("bind")
    val color = el.color("color", ElementDefaults.TABLE_TEXT)
    Column(Modifier.elementStyle(el).then(Modifier.fillMaxWidth())) {
        Row(Modifier.fillMaxWidth().padding(vertical = ElementDefaults.TABLE_HEADER_PAD_V.dp).semantics { heading() },
            horizontalArrangement = Arrangement.spacedBy(ElementDefaults.TABLE_CELL_SPACING.dp)) {
            for (c in columns) {
                BasicText(c, Modifier.weight(1f),
                          style = TextStyle(color = StackStyle.color(ElementDefaults.TABLE_HEADER),
                                            fontSize = ElementDefaults.TABLE_HEADER_FONT.sp,
                                            fontWeight = FontWeight.SemiBold))
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(StackStyle.color("separator")))
        for ((r, row) in rows.withIndex()) {
            Row(Modifier.fillMaxWidth().padding(vertical = ElementDefaults.TABLE_ROW_PAD_V.dp)
                    .semantics(mergeDescendants = true) { },            // a row reads as ONE element
                horizontalArrangement = Arrangement.spacedBy(ElementDefaults.TABLE_CELL_SPACING.dp)) {
                for (f in fields) {
                    BasicText(JSE.string(row[f] ?: ""), Modifier.weight(1f),
                              style = TextStyle(color = color, fontSize = ElementDefaults.TABLE_ROW_FONT.sp),
                              maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (r < rows.size - 1) {
                Box(Modifier.fillMaxWidth().height(1.dp)
                        .background(StackStyle.color("separator").copy(alpha = StackStyle.color("separator").alpha * 0.5f)))
            }
        }
    }
}

// MARK: - <Accordion>

@Composable
private fun AccordionElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    var isOpen by remember { mutableStateOf(el.bool("open")) }
    val header = namedSlot(ctx, "header")
    val reduceMotion = rememberAnimatorDurationScale() == 0f            // the Skeleton gate
    val chevron by animateFloatAsState(
        if (isOpen) ElementDefaults.ACCORDION_CHEVRON_OPEN.toFloat() else 0f,
        animationSpec = if (reduceMotion) snap() else spring(),
        label = "accordionChevron")
    val toggle = {
        isOpen = !isOpen
        raiseEvent(ctx, "toggle", mapOf("open" to isOpen))
    }
    Column(Modifier.elementStyle(el), horizontalAlignment = Alignment.Start) {
        Box(Modifier.fillMaxWidth()
            // The touch floor on the tappable header — the platform minimum (density-following:
            // the funnel's LocalMinimumInteractiveComponentSize pin re-derives it).
            .minimumInteractiveComponentSize()
            .dsxAccessibleActivation(
                role = Role.Button,
                stateDescription = DSXStrings.localize(
                    if (isOpen) "Expanded" else "Collapsed",
                ),
                onClick = toggle,
            )
            .pointerInput(Unit) { detectTapGestures { toggle() } }) {
            if (header.isNotEmpty()) {
                Column { SlotNodes(ctx, header) }                       // custom header replaces the default
            } else {
                Row(Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(ElementDefaults.ACCORDION_HEADER_SPACING.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    BasicText(el.str("title"),
                              style = TextStyle(color = StackStyle.color("label"), fontSize = 17.sp))
                    Spacer(Modifier.weight(1f))
                    Box(Modifier.graphicsLayer { rotationZ = chevron }) {
                        StackIcon("chevron.right", 14.0, el.color("color", ElementDefaults.ACCORDION_TINT))
                    }
                }
            }
        }
        // The collapsible body animates its toggle like the Swift twin (withAnimation
        // .easeInOut — the kernel default curve/duration) and snaps under reduced motion.
        if (reduceMotion) {
            if (isOpen) SlotNodes(ctx, defaultSlot(ctx))
        } else {
            val bodySpec = StackMotion.animation(null, null)            // kernel default: easeInOut 0.35s
            AnimatedVisibility(
                visible = isOpen,
                enter = expandVertically(StackMotion.spec(bodySpec)) + fadeIn(StackMotion.spec(bodySpec)),
                exit = shrinkVertically(StackMotion.spec(bodySpec)) + fadeOut(StackMotion.spec(bodySpec)),
            ) {
                Column(horizontalAlignment = Alignment.Start) { SlotNodes(ctx, defaultSlot(ctx)) }
            }
        }
    }
}

// MARK: - <Skeleton>

@Composable
private fun SkeletonElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val h = el.dbl("height", ElementDefaults.SKELETON_HEIGHT)
    val r = el.dbl("radius", ElementDefaults.SKELETON_RADIUS)
    val reduceMotion = rememberAnimatorDurationScale() == 0f
    val phase =
        if (reduceMotion) {
            0.2f
        } else {
            val transition = rememberInfiniteTransition(label = "skeleton")
            val animatedPhase by transition.animateFloat(
                initialValue = -0.6f, targetValue = 1.0f,
                animationSpec = infiniteRepeatable(tween((ElementDefaults.SKELETON_SHIMMER_DURATION * 1000).toInt(), easing = LinearEasing)),
                label = "skeletonPhase")
            animatedPhase
        }
    // iOS Skeleton rides SwiftUI's ADAPTIVE Color.primary; the white pin was its dark
    // resolution (pre-theme compromise). The semantic `label` is the primary twin, so the
    // shimmer stays visible on light schemes (system-defaults base pass). Opacities stay
    // the fixture-pinned constants.
    val bone = StackStyle.color("label")
    Box(Modifier.elementStyle(el)
        .then(Modifier.fillMaxWidth().height(h.dp))
        .clip(RoundedCornerShape(r.dp))
        .background(bone.copy(alpha = ElementDefaults.SKELETON_FILL_OPACITY.toFloat()))
        .drawBehind {
            val w = size.width
            val start = phase * w
            drawRect(Brush.horizontalGradient(
                colors = listOf(Color.Transparent,
                                bone.copy(alpha = ElementDefaults.SKELETON_SHIMMER_OPACITY.toFloat()),
                                Color.Transparent),
                startX = start, endX = start + ElementDefaults.SKELETON_SHIMMER_WIDTH.toFloat() * w))
        })
}

// MARK: - <ChatBubble>

/// The asymmetric tail — bottom corner on the bubble's own side squared to 4, the rest 18
/// (ChatBubble.swift bubbleFill).
internal fun chatBubbleShape(isRight: Boolean): RoundedCornerShape = RoundedCornerShape(
    topStart = ElementDefaults.CHAT_RADIUS.dp, topEnd = ElementDefaults.CHAT_RADIUS.dp,
    bottomEnd = (if (isRight) ElementDefaults.CHAT_TAIL_RADIUS else ElementDefaults.CHAT_RADIUS).dp,
    bottomStart = (if (isRight) ElementDefaults.CHAT_RADIUS else ElementDefaults.CHAT_TAIL_RADIUS).dp)

@Composable
private fun ChatBubbleElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val isRight = el.str("side", "left") == "right"
    val fill = StackStyle.color(el.str("color", if (isRight) ElementDefaults.CHAT_RIGHT else ElementDefaults.CHAT_LEFT))
    val maxWidth = el.dbl("maxWidth", ElementDefaults.CHAT_MAX_WIDTH)
    Row(Modifier.elementStyle(el).then(Modifier.fillMaxWidth())) {
        if (isRight) Spacer(Modifier.weight(1f))                        // push to the trailing edge
        Column(Modifier.widthIn(max = maxWidth.dp)
                   .background(fill, chatBubbleShape(isRight))
                   .padding(horizontal = ElementDefaults.CHAT_PADDING_H.dp,
                            vertical = ElementDefaults.CHAT_PADDING_V.dp)) {
            SlotColumnNodes(ctx, defaultSlot(ctx))
        }
        if (!isRight) Spacer(Modifier.weight(1f))                       // push to the leading edge
    }
}

// MARK: - <ProgressRing>

/// clamp(value/max, 0…1) with the NaN/±inf guard (ProgressRing.swift).
internal fun ringFraction(value: Double, maxValue: Double): Double {
    val ratio = if (maxValue == 0.0) 0.0 else value / maxValue
    return if (ratio.isFinite()) ratio.coerceIn(0.0, 1.0) else 0.0
}

@Composable
private fun ProgressRingElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val fraction = ringFraction(el.dbl("value", 0.0), el.dbl("max", 1.0))
    val lineWidth = el.dbl("lineWidth", ElementDefaults.RING_LINE)
    val color = el.color("color", ElementDefaults.RING_TINT)
    val track = el.color("trackColor", ElementDefaults.RING_TRACK)
    val diameter = el.dbl("size", ElementDefaults.RING_SIZE)
    val label = el.str("label")
    val animated by animateFloatAsState(fraction.toFloat(), label = "ringFraction")   // .easeInOut on change
    Box(Modifier.elementStyle(el).then(Modifier.size(diameter.dp))
            // One spoken progress element (the web twin's role=progressbar + aria-valuenow):
            // range info carries the fraction, the label (or "Progress") names it.
            .semantics {
                progressBarRangeInfo = ProgressBarRangeInfo(fraction.toFloat(), 0f..1f)
                contentDescription = label.ifEmpty { DSXStrings.localize("Progress") }
            },
        contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(diameter.dp)) {
            val stroke = lineWidth.dp.toPx()
            val inset = stroke / 2
            val arcSize = Size(size.width - stroke, size.height - stroke)
            drawArc(track, startAngle = 0f, sweepAngle = 360f, useCenter = false,
                    topLeft = Offset(inset, inset), size = arcSize, style = Stroke(stroke))
            if (animated > 0f) {
                drawArc(color, startAngle = -90f, sweepAngle = 360f * animated, useCenter = false,
                        topLeft = Offset(inset, inset), size = arcSize,
                        style = Stroke(stroke, cap = StrokeCap.Round))
            }
        }
        if (label.isNotEmpty()) {
            BasicText(label, style = TextStyle(color = StackStyle.color("label"), fontSize = 17.sp))
        }
    }
}
