//
//  ListElements.kt — the registered `<list>` orchestrator (Kotlin twin of List.swift),
//  PRIVILEGED so the registration shadows the renderer's vertical-only raw() branch (the
//  sanctioned slot). The FLAT vertical list still DELEGATES to the existing BoundList —
//  byte-identical behavior, zero duplication; this file owns what BoundList does not:
//
//    axis="horizontal"                → a sideways rail: EAGER Row inside a horizontal
//                                       scroll (iOS: eager HStack in a ScrollView — a
//                                       rail's height stays intrinsic so sheets hug it);
//                                       `scroll="false"` → a bare Row.
//    axis="horizontal" autoscroll="N" → a continuous, looping MARQUEE at N points/sec
//                                       (StackMarquee): the rows are laid out TWICE
//                                       end-to-end and offset by a linear repeating
//                                       animation across one copy's width + spacing, so
//                                       the seam is invisible — the news-ticker, no
//                                       manual drag.
//    group_by / swipeLeading / swipeTrailing / reorder
//                                     → THE LIST-CONSTRUCT PATH (below).
//
//  Rows ride the SAME bound seam as the vertical list (`bound()` — keyed rows, per-row
//  `item` scope with write-back). `spacing` gaps rows (default 0, the Kotlin list
//  contract). on:reachEnd stays a vertical-list affair, like iOS.
//
//  ── THE LIST-CONSTRUCT PATH (List.swift:82-174, 1:1) ────────────────────────────────────
//  Sections, swipe actions and drag-reorder are List CONSTRUCTS on iOS: they render inside a
//  real SwiftUI `List` (`.plain`, upgraded to the system `.insetGrouped` by the same unstyled
//  gate). Here they render on ONE LazyColumn with real M3 `ListItem` rows through the shared
//  `SystemMaterialListItem` call when
//  `SystemList.rendersSystem` passes and no scroll ancestor stamped `LocalInScrollContainer`,
//  else flat. Entry is List.swift's exactly: vertical, `scroll != "false"` (fit-content WINS —
//  swipe/reorder need a scrolling list), and at least one of the three attrs present. Absent
//  all three the flat BoundList path is byte-for-byte unchanged.
//
//  • group_by="field" — partitions the bound rows by that field, FIRST-SEEN order for groups
//    AND rows (stable, no sort surprise), the stringified value as the section header. The
//    grouped arm's headers scroll with their section and the flat arm's PIN (`stickyHeader`)
//    — the exact iOS split: UIKit/SwiftUI pin `.plain` headers and never pin `.insetGrouped`
//    ones. A pinned header must be opaque, so the flat arm's fills with `groupedBackground`
//    (iOS's own plain-header canvas); the grouped arm needs no fill — the canvas is already
//    under it.
//  • swipeLeading / swipeTrailing — a bound LIST of button dicts, the iOS shape to the word:
//    `{ "label"|"title", "icon", "role": "destructive", "color": "#FF9F0A" }` plus ONE of the
//    two firing shapes — `"event": "delete"` fires the list's `on:<event>` with the ROW as the
//    scope, and/or `"action": "studio.deleteClip", "args": {…}` dispatches on the bus (both may
//    be present; event fires first). Full-swipe commits the FIRST button when
//    `swipeFullLeading`/`swipeFullTrailing` = "true" (opt-in). Reorder and swipe are exclusive
//    (List.swift: an OS edit-mode rule — pick one mode per list), and a GROUPED list ignores
//    reorder (moving across computed sections is ill-defined) — both gates are iOS's.
//  • reorder="true" — long-press a row, drag, drop: the row MOVES in the bound array (written
//    back through the same bind seam the rows were read from — `Bound.setAll`, so a nested
//    `item.*` collection edits its parent row in place) and `on:move` fires with { from, to },
//    both FINAL indices after the move. The drop index is read off the live layout (the row
//    slot whose bounds hold the dragged row's centre), so rows of differing heights land
//    right; nothing else moves in the data while the finger is down — the rows BETWEEN source
//    and target are translated to open the gap, which is layout-free and cannot churn keys.
//
//  ── DIVERGENCES from the Swift twin (pinned, none silent) ───────────────────────────────
//  • NO EDIT MODE / NO DRAG HANDLES. iOS turns on `editMode` and the OS draws a handle on
//    every row; Compose has no edit mode and Material specifies no reorder handle, so the
//    drag starts on a LONG PRESS anywhere on the row (`detectDragGesturesAfterLongPress` —
//    the Material drag-and-drop gesture). A `reorder` list therefore looks identical to a
//    plain one until it is pressed. Consequence of the same gap: iOS's edit mode also
//    SUPPRESSES swipe; here the suppression is explicit (`reorder` wins, above).
//  • FULL SWIPE performs the first action and springs the row CLOSED where iOS animates the
//    row out of the list — the row's disappearance is the handler's job on both (the action
//    edits the bound array), so only the transit differs.
//  • Swipe buttons size to their own content over a fixed 74dp minimum with M3 role fills
//    (`error` for `role:destructive`, `secondaryContainer` otherwise, an authored `color`
//    winning) — the platform's own action-rail metrics, deliberately OUT of the parity spec
//    (ElementSpec.kt rule 4: iOS's are the OS's and never re-specified).
//  • An open row closes on its own button tap or a swipe back, not on an unrelated scroll —
//    Compose exposes no list-wide "close the other row" seam and inventing one would mean a
//    cross-row channel this element has no business owning.
//  • NO `measuring` ARM: iOS also stands down during a sheet's `.content` measuring pass;
//    :render has no measuring pass — the sheet's fit-content slot stamps
//    `LocalInScrollContainer` instead, which this path reads for the same purpose.
//

package despia.engine.render.elements

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import despia.engine.JSE
import despia.engine.StackNode
import despia.engine.render.Bound
import despia.engine.render.BoundList
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.LocalInScrollContainer
import despia.engine.render.StackIcon
import despia.engine.render.StackNodeView
import despia.engine.render.StackStyle
import despia.engine.render.StackTheme
import despia.engine.render.SystemMaterialListItem
import despia.engine.render.SystemList
import despia.engine.render.bound
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

internal fun registerListElements() {
    ComposeStackComponents.definePrivileged("list") { ctx -> ListElementView(ctx) }
}

@Composable
private fun ListElementView(ctx: ComposeStackComponentContext) {
    val node = ctx.node ?: return
    val m = Modifier.elementModifier(ctx)
    if ((ctx.interp("axis") ?: ctx.interp("direction")) != "horizontal") {   // `direction` = the iOS alias (List.swift:44)
        val template = node.children.firstOrNull() ?: return
        // ── the List-construct features (List.swift:82-105): sections · swipe · reorder.
        //    A GROUPED list ignores reorder, and reorder suppresses swipe — both iOS rules.
        val groupField = (ctx.attrs["group_by"] ?: ctx.attrs["groupBy"])?.takeIf { it.isNotEmpty() }
        val reorder = ctx.bool("reorder") && groupField == null
        val leading = if (reorder) emptyList() else swipeActions(ctx, "swipeLeading")
        val trailing = if (reorder) emptyList() else swipeActions(ctx, "swipeTrailing")
        // Content sizing WINS over the constructs (List.swift:104) — a fit-content slot
        // can't host a scrolling list, which is what swipe/reorder need.
        if (ctx.attrs["scroll"] != "false" &&
            (groupField != null || leading.isNotEmpty() || trailing.isNotEmpty() || reorder)) {
            ConstructList(ctx, template, m, groupField, leading, trailing, reorder)
            return
        }
        // Vertical — the existing BoundList verbatim (keyed LazyColumn, scroll="false",
        // on:reachEnd); this wrapper only re-supplies the modifier the registered slot drops.
        BoundList(node, ctx.attrs, m, ctx.store, ctx.env, ctx.item, ctx.rowWrite)
        return
    }
    val template = node.children.firstOrNull() ?: return
    val b = bound(ctx.attrs, ctx.store, ctx.item, ctx.rowWrite)
    val spacing = ctx.num("spacing") ?: 0.0
    val rows: @Composable () -> Unit = {
        for (i in b.rows.indices) StackNodeView(template, ctx.store, ctx.env, b.item(i), b.writer(i))
    }
    val autoscroll = ctx.num("autoscroll") ?: 0.0
    when {
        autoscroll > 0 -> StackMarqueeRow(autoscroll, spacing, m, rows)
        ctx.attrs["scroll"] == "false" ->
            Row(m, horizontalArrangement = Arrangement.spacedBy(spacing.dp)) { rows() }
        else ->
            Row(m.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(spacing.dp)) { rows() }
    }
}

// MARK: - the swipe-action item model (List.swift SwipeButtons, the alert/menu item shape)

/// One swipe button: `label` (or the alert-style `title` alias) + optional `icon`,
/// `role:"destructive"` → the system red slot, `color` → an explicit token/hex tint; firing
/// shapes: `event` → the list's `on:<event>` with the ROW as scope, and/or `action`+`args`
/// → a bus dispatch. Both may be present; event fires first (List.swift:327-331).
private class SwipeAction(d: Map<String, Any?>) {
    val label: String = (d["label"] as? String) ?: (d["title"] as? String) ?: ""
    val icon: String = (d["icon"] as? String) ?: ""
    val destructive: Boolean = (d["role"] as? String) == "destructive"
    val color: String = (d["color"] as? String) ?: ""
    val event: String = (d["event"] as? String) ?: ""
    val call: String = (d["action"] as? String) ?: ""

    @Suppress("UNCHECKED_CAST")
    val args: Map<String, Any?> = (d["args"] as? Map<String, Any?>) ?: emptyMap()
}

private fun swipeActions(ctx: ComposeStackComponentContext, key: String): List<SwipeAction> =
    bindList(ctx.attrs[key], ctx.store, ctx.item).map { SwipeAction(it) }

/// Run a swipe button: the `on:<event>` handler sees the ROW as its scope AND its args (the
/// privileged `dsx.run(event, payload:)` twin — `on:delete="emails = emails.filter(…)"` reads
/// `id` top-level), then the bus call, if any.
private fun runSwipe(ctx: ComposeStackComponentContext, a: SwipeAction, row: Map<String, Any?>) {
    if (a.event.isNotEmpty()) ctx.attrs["on:${a.event}"]?.let { ctx.env.run(it, row, row) }
    if (a.call.isNotEmpty()) dispatchCall(a.call, a.args)
}

// MARK: - sections (List.swift:129-136 — first-seen order for groups AND rows)

private class ListSection(val header: String?, val rows: List<Int>)

/// Partition the bound row INDICES by the group field's stringified value, keeping the
/// first-seen order of both the groups and the rows inside them. No field = one headerless
/// section over every row (the swipe/reorder-only shape).
private fun sectionsOf(b: Bound, field: String?): List<ListSection> {
    if (field == null) return listOf(ListSection(null, b.rows.indices.toList()))
    val order = ArrayList<String>()
    val buckets = LinkedHashMap<String, ArrayList<Int>>()
    for (i in b.rows.indices) {
        val g = b.rows[i][field]?.let { JSE.string(it) } ?: ""
        val bucket = buckets[g]
        if (bucket == null) { order.add(g); buckets[g] = arrayListOf(i) } else bucket.add(i)
    }
    return order.map { ListSection(it, buckets[it] ?: emptyList()) }
}

// MARK: - reorder drag arithmetic (pure — reads only the live layout)

/// Where a dragged row would LAND and how tall it is: the drop slot is the visible item whose
/// bounds hold the dragged row's centre (heights may differ, so the offset can't be divided by
/// a row height). `to` IS the final index — removing the row then inserting it there puts it
/// exactly in that slot, which is why no ±1 normalization is needed (iOS has to normalize
/// SwiftUI's pre-removal insertion offset, List.swift:159-162).
private class DragPlan(val to: Int, val size: Float)

private fun dragPlan(state: LazyListState, from: Int, by: Float): DragPlan? {
    if (from < 0) return null
    val info = state.layoutInfo.visibleItemsInfo
    val src = info.firstOrNull { it.index == from } ?: return null
    val centre = src.offset + src.size / 2f + by
    val hit = info.firstOrNull { centre >= it.offset && centre <= it.offset + it.size }
    return DragPlan(hit?.index ?: from, src.size.toFloat())
}

/// The row's vertical translation while a drag is live: the dragged row follows the finger,
/// the rows it passes step aside by its height (layout untouched — no key churn), everything
/// else holds still.
private fun rowShift(i: Int, from: Int, by: Float, plan: DragPlan?): Float {
    if (from < 0) return 0f
    if (i == from) return by
    val to = plan?.to ?: return 0f
    return when {
        to == from -> 0f
        from < to && i > from && i <= to -> -plan.size
        to < from && i >= to && i < from -> plan.size
        else -> 0f
    }
}

// MARK: - the construct list

@Composable
private fun ConstructList(ctx: ComposeStackComponentContext, template: StackNode, modifier: Modifier,
                          groupField: String?, leading: List<SwipeAction>, trailing: List<SwipeAction>,
                          reorder: Boolean) {
    val b = bound(ctx.attrs, ctx.store, ctx.item, ctx.rowWrite)
    val reachEnd = ctx.attrs["on:reachEnd"]
    val fullLeading = ctx.bool("swipeFullLeading")
    val fullTrailing = ctx.bool("swipeFullTrailing")
    // The look: the same gate + the same scroll-ancestor read as the flat system list
    // (StackSystemControls.kt SystemList / LocalInScrollContainer, the iOS
    // ScrollAwareSystemList twin) — any authored look keeps the flat drawing.
    val system = SystemList.rendersSystem(ctx.attrs, template.attrs) && !LocalInScrollContainer.current
    val sections = sectionsOf(b, groupField)
    val listState = rememberLazyListState()
    var dragFrom by remember { mutableIntStateOf(-1) }
    var dragBy by remember { mutableFloatStateOf(0f) }
    val plan = if (dragFrom >= 0) dragPlan(listState, dragFrom, dragBy) else null
    // The drop commit reads the CURRENT rows, never the ones captured when the gesture
    // detector was built (rows change under a live list) — rememberUpdatedState is the seam.
    val commitMove by rememberUpdatedState<(Int, Int) -> Unit>({ from, to ->
        val rows = ArrayList<Any?>(b.rows)
        if (from in rows.indices && to in rows.indices) {
            rows.add(to, rows.removeAt(from))
            b.setAll(rows)
            ctx.attrs["on:move"]?.let { action ->
                val payload = mapOf("from" to from.toDouble(), "to" to to.toDouble())
                ctx.env.run(action, payload, payload)   // both FINAL indices (List.swift:162)
            }
        }
    })
    // The swipe payload is the RAW row (List.swift:107-111 hands `bound.rows`, not the row
    // scope) — the handler reads the row's fields top-level, with no synthetic `index`.
    val fireSwipe by rememberUpdatedState<(SwipeAction, Int) -> Unit>({ a, i ->
        if (i in b.rows.indices) runSwipe(ctx, a, b.rows[i])
    })
    val m = if (system) modifier.then(Modifier.fillMaxWidth()) else modifier
    LazyColumn(m, state = listState) {
        for (section in sections) {
            val header = section.header
            if (header != null) {
                if (system) item(key = "dsx.section:$header") { SectionHeader(header, true) }
                else stickyHeader(key = "dsx.section:$header") { SectionHeader(header, false) }
            }
            items(count = section.rows.size, key = { b.keys[section.rows[it]] }) { pos ->
                val i = section.rows[pos]
                val last = i == b.rows.size - 1
                ListRowCell(
                    system = system,
                    shift = rowShift(i, dragFrom, dragBy, plan),
                    lifted = dragFrom == i,
                    leading = leading, trailing = trailing,
                    fullLeading = fullLeading, fullTrailing = fullTrailing,
                    onAction = { a -> fireSwipe(a, i) },
                    dragModifier = if (!reorder) Modifier else Modifier.pointerInput(i) {
                        detectDragGesturesAfterLongPress(
                            onDragStart = { dragFrom = i; dragBy = 0f },
                            onDragEnd = {
                                val landed = dragPlan(listState, dragFrom, dragBy)
                                val src = dragFrom
                                dragFrom = -1; dragBy = 0f
                                if (landed != null && landed.to != src) commitMove(src, landed.to)
                            },
                            onDragCancel = { dragFrom = -1; dragBy = 0f },
                        ) { change, amount ->
                            change.consume()
                            dragBy += amount.y
                        }
                    },
                ) {
                    StackNodeView(template, ctx.store, ctx.env, b.item(i), b.writer(i))
                }
                // on:reachEnd rides the GLOBAL last row regardless of its section
                // (List.swift:73-77) — load-more keeps working under group_by.
                if (reachEnd != null && last) {
                    LaunchedEffect(b.keys[i]) { ctx.env.run(reachEnd, b.item(i)) }
                }
            }
        }
    }
}

/// One `group_by` section's header. The grouped arm scrolls it (`.insetGrouped` never pins);
/// the flat arm pins it (`.plain` always does) and therefore fills its own canvas.
@Composable
private fun SectionHeader(title: String, system: Boolean) {
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    val fill = if (system) Modifier else Modifier.background(StackStyle.color("groupedBackground"))
    Text(
        title,
        color = cs.onSurfaceVariant,
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.fillMaxWidth().then(fill)
            .padding(start = SECTION_PAD_H.dp, end = SECTION_PAD_H.dp,
                     top = SECTION_PAD_TOP.dp, bottom = SECTION_PAD_BOTTOM.dp),
    )
}

/// One row slot: the reorder translation + lift, then either the plain row, the M3 ListItem,
/// or — when the list carries swipe actions — the sliding row over its action rails.
@Composable
private fun ListRowCell(system: Boolean, shift: Float, lifted: Boolean,
                        leading: List<SwipeAction>, trailing: List<SwipeAction>,
                        fullLeading: Boolean, fullTrailing: Boolean,
                        onAction: (SwipeAction) -> Unit, dragModifier: Modifier,
                        content: @Composable () -> Unit) {
    val outer = Modifier.fillMaxWidth()
        .offset { IntOffset(0, shift.roundToInt()) }
        .zIndex(if (lifted) 1f else 0f)
        .then(dragModifier)
    if (leading.isEmpty() && trailing.isEmpty()) {
        if (system) {
            SystemMaterialListItem(outer) { content() }
        } else {
            Box(outer) { content() }
        }
        return
    }
    SwipeRow(outer, system, leading, trailing,
             fullLeading, fullTrailing, onAction, content)
}

// MARK: - the swipe drawer (the `.swipeActions` twin)

private const val SWIPE_BUTTON_MIN_W = 74.0    // dp — Android action-rail chrome (out of the spec)
private const val SWIPE_BUTTON_PAD_H = 12.0    // dp
private const val SWIPE_ICON_SIZE = 20.0       // dp — the M3 action glyph
private const val SWIPE_LABEL_GAP = 4.0        // dp — icon → label
private const val SECTION_PAD_H = 16.0         // dp — M3 section-label layout
private const val SECTION_PAD_TOP = 16.0       // dp — section header breathing room
private const val SECTION_PAD_BOTTOM = 6.0     // dp
private const val SWIPE_OPEN_FRACTION = 0.5f   // past half the rail → settle OPEN
private const val SWIPE_FULL_FRACTION = 0.5f   // past half the ROW → commit the first button

private val SWIPE_SPRING = spring<Float>(stiffness = Spring.StiffnessMediumLow)

/// Settle a released swipe: a full swipe (opt-in per edge) commits the FIRST button and
/// springs closed, half the rail holds it OPEN, anything shorter springs back. Returns true
/// when the row ends up closed.
private suspend fun settleSwipe(x: Animatable<Float, AnimationVector1D>, rowWidth: Int,
                                leadWidth: Int, trailWidth: Int,
                                fullLeading: Boolean, fullTrailing: Boolean,
                                leading: List<SwipeAction>, trailing: List<SwipeAction>,
                                fire: (SwipeAction) -> Unit): Boolean {
    val v = x.value
    val w = rowWidth.toFloat()
    if (v > 0f && leading.isNotEmpty()) {
        if (fullLeading && v >= w * SWIPE_FULL_FRACTION) {
            fire(leading.first()); x.animateTo(0f, SWIPE_SPRING); return true
        }
        if (leadWidth > 0 && v >= leadWidth * SWIPE_OPEN_FRACTION) {
            x.animateTo(leadWidth.toFloat(), SWIPE_SPRING); return false
        }
    }
    if (v < 0f && trailing.isNotEmpty()) {
        if (fullTrailing && -v >= w * SWIPE_FULL_FRACTION) {
            fire(trailing.first()); x.animateTo(0f, SWIPE_SPRING); return true
        }
        if (trailWidth > 0 && -v >= trailWidth * SWIPE_OPEN_FRACTION) {
            x.animateTo(-trailWidth.toFloat(), SWIPE_SPRING); return false
        }
    }
    x.animateTo(0f, SWIPE_SPRING)
    return true
}

/// The row over its two action rails: the rails are laid out behind it (so their measured
/// widths ARE the open anchors) and only painted while the row is off its resting place; the
/// row itself slides on a horizontal drag. In the system look the sliding foreground is the
/// real M3 ListItem, so the component owns its surface and row geometry.
@Composable
private fun SwipeRow(outer: Modifier, system: Boolean,
                     leading: List<SwipeAction>, trailing: List<SwipeAction>,
                     fullLeading: Boolean, fullTrailing: Boolean,
                     onAction: (SwipeAction) -> Unit, content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val x = remember { Animatable(0f) }
    var rowWidth by remember { mutableIntStateOf(0) }
    var leadWidth by remember { mutableIntStateOf(0) }
    var trailWidth by remember { mutableIntStateOf(0) }
    var railsOn by remember { mutableStateOf(false) }
    val fire by rememberUpdatedState(onAction)
    val frame = outer.then(Modifier.onSizeChanged { rowWidth = it.width })
    Box(frame) {
        Box(Modifier.matchParentSize().alpha(if (railsOn) 1f else 0f)) {
            // A button tap fires, then closes the row — the rail stays painted until the row
            // has covered it again (hiding it first would blink the rail away mid-slide).
            if (leading.isNotEmpty()) {
                SwipeRail(Modifier.align(Alignment.CenterStart)
                              .onSizeChanged { leadWidth = it.width }, leading) { a ->
                    fire(a); scope.launch { x.animateTo(0f, SWIPE_SPRING); railsOn = false }
                }
            }
            if (trailing.isNotEmpty()) {
                SwipeRail(Modifier.align(Alignment.CenterEnd)
                              .onSizeChanged { trailWidth = it.width }, trailing) { a ->
                    fire(a); scope.launch { x.animateTo(0f, SWIPE_SPRING); railsOn = false }
                }
            }
        }
        Box(Modifier.fillMaxWidth()
                .offset { IntOffset(x.value.roundToInt(), 0) }
                .pointerInput(rowWidth, leadWidth, trailWidth, fullLeading to fullTrailing) {
                    detectHorizontalDragGestures(
                        onDragStart = { railsOn = true },
                        onDragEnd = {
                            scope.launch {
                                val closed = settleSwipe(x, rowWidth, leadWidth, trailWidth,
                                                         fullLeading, fullTrailing,
                                                         leading, trailing) { a -> fire(a) }
                                if (closed) railsOn = false
                            }
                        },
                        onDragCancel = {
                            scope.launch { x.animateTo(0f, SWIPE_SPRING); railsOn = false }
                        },
                    ) { change, dx ->
                        change.consume()
                        // The reach: the rail's own width, or the whole row when that edge
                        // opted into full-swipe. An edge with no buttons doesn't move.
                        val hi = if (leading.isEmpty()) 0f
                                 else if (fullLeading) rowWidth.toFloat() else leadWidth.toFloat()
                        val lo = if (trailing.isEmpty()) 0f
                                 else -(if (fullTrailing) rowWidth.toFloat() else trailWidth.toFloat())
                        val next = (x.value + dx).coerceIn(minOf(lo, 0f), maxOf(hi, 0f))
                        scope.launch { x.snapTo(next) }
                    }
                }) {
            if (system) SystemMaterialListItem { content() }
            else content()
        }
    }
}

/// One edge's buttons, full row height, content-sized over a 74dp minimum. An authored
/// `color` wins; else `role:"destructive"` takes the M3 `error` role (iOS's system red) and
/// everything else the neutral `secondaryContainer` (iOS's neutral gray).
@Composable
private fun SwipeRail(modifier: Modifier, actions: List<SwipeAction>, onTap: (SwipeAction) -> Unit) {
    val cs = StackTheme.scheme ?: MaterialTheme.colorScheme
    Row(modifier.then(Modifier.fillMaxHeight())) {
        for (a in actions) {
            val fill = when {
                a.color.isNotEmpty() -> StackStyle.color(a.color)
                a.destructive -> cs.error
                else -> cs.secondaryContainer
            }
            val ink: Color = when {
                a.color.isNotEmpty() -> Color.White
                a.destructive -> cs.onError
                else -> cs.onSecondaryContainer
            }
            Column(Modifier.fillMaxHeight().widthIn(min = SWIPE_BUTTON_MIN_W.dp)
                       .background(fill)
                       .clickable { onTap(a) }
                       .padding(horizontal = SWIPE_BUTTON_PAD_H.dp),
                   verticalArrangement = Arrangement.spacedBy(SWIPE_LABEL_GAP.dp, Alignment.CenterVertically),
                   horizontalAlignment = Alignment.CenterHorizontally) {
                if (a.icon.isNotEmpty()) StackIcon(a.icon, SWIPE_ICON_SIZE, ink)
                if (a.label.isNotEmpty()) {
                    Text(a.label, color = ink, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

// MARK: - the horizontal marquee (StackMarquee)

/// The StackMarquee twin: content laid out twice end-to-end, offset by a linear repeating
/// animation across one copy's width + spacing (measured ONCE, then the loop starts) —
/// the seam is invisible. `speed` = points/sec, min 1 (the Swift `max(speed, 1)` guard).
@Composable
internal fun StackMarqueeRow(speed: Double, spacing: Double, modifier: Modifier,
                             content: @Composable () -> Unit) {
    var contentWidth by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val spacingPx = with(density) { spacing.dp.toPx() }
    val speedPx = with(density) { maxOf(speed, 1.0).dp.toPx() }
    val shift = if (contentWidth > 0) contentWidth + spacingPx else 0f
    val durationMs = if (shift > 0f) ((shift / speedPx) * 1000f).roundToInt().coerceAtLeast(16)
                     else 100_000
    val transition = rememberInfiniteTransition(label = "marquee")
    val offsetX by transition.animateFloat(
        initialValue = 0f, targetValue = -shift,
        animationSpec = infiniteRepeatable(tween(durationMs, easing = LinearEasing),
                                           RepeatMode.Restart),
        label = "marqueeOffset")
    Box(modifier.then(Modifier.fillMaxWidth()).clipToBounds(),
        contentAlignment = Alignment.CenterStart) {
        Row(Modifier
                .wrapContentWidth(Alignment.Start, unbounded = true)   // ideal width — never compressed
                .offset { IntOffset(offsetX.roundToInt(), 0) },
            horizontalArrangement = Arrangement.spacedBy(spacing.dp)) {
            Row(Modifier.onSizeChanged { if (contentWidth == 0) contentWidth = it.width },
                horizontalArrangement = Arrangement.spacedBy(spacing.dp)) { content() }
            Row(horizontalArrangement = Arrangement.spacedBy(spacing.dp)) { content() }
        }
    }
}
