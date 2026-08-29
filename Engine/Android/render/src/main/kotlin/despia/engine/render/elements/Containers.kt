//
//  Containers.kt — `<scaffold>` (sticky safe-area bars), `<toolbar>` (the standalone bar),
//  `<flow>` (flow-wrap layout) and `<carousel>` (paged cards + dots). Kotlin twins of
//  Foundation Structure/Scaffold/Scaffold.swift, Structure/Toolbar/Toolbar.swift,
//  Structure/Flow/Flow.swift and Structure/Carousel/Carousel.swift.
//
//  SCAFFOLD (privileged, like iOS): children marked pin="top"/pin="bottom" are pinned via
//  safe-area insets (`.safeAreaInset` → windowInsetsPadding on the bar) and the body is
//  inset by the bars (the Column split), so nothing hides behind them.
//
//  READABLE CONTENT INSETS (system-defaults.md; the Scaffold.swift `detailReadableInset` /
//  `detailReadableTopInset` twin): in a SPLIT layout the content/detail pane is inset from the
//  divider instead of sitting flush against it. Same intent as iOS, DIFFERENT number by law —
//  the Android row is Material 3, not a copy of SwiftUI, so the horizontal inset is M3's own
//  medium/expanded window-size-class margin (24dp) rather than iPad's 20pt readable margin.
//  Scope matches iOS exactly: SPLIT layouts only (`split2`/`split3` — what a regular-width
//  Android tablet resolves to, since `nativeAvailable` is always false here and the plan can
//  never be `native2`/`native3`). The compact single-pane (`content`), the stacked collapse
//  (`stack`) and the legacy `custom` body stay FULL-BLEED, byte-for-byte as before — a phone
//  never gains a margin. The inset is applied INSIDE the pane's testTag/semantics node, so the
//  pane still reports its whole column slot to the a11y tree and to the geometry assertions in
//  DsxAdaptiveScaffoldTabletUiTest / DesktopRendererUiTest; author padding stacks on top of it.
//
//  ── DIVERGENCE: no sidebar-column seam (system-defaults.md) ──────────────────────────────
//  iOS's Scaffold publishes `dsxInSidebarColumn` so a `<list>` in the split's sidebar column can
//  render SwiftUI's `.sidebar` list style — the context half of the iOS baseline `List`
//  `.automatic`. THAT SEAM IS DELIBERATELY ABSENT HERE, because the fact it carries has no
//  consumer on this platform: Compose has no list-style vocabulary at all (no `listStyle`, no
//  context-resolved `.automatic`), and M3's row components paint one identity chosen by the call
//  site — see StackSystemControls.kt's SystemMaterialList divergence block. Stamping a
//  CompositionLocal that nothing may legally read would be a faked twin, so the pane helper
//  below takes no `sidebarColumn` flag. If M3 ever defines a distinct in-drawer/in-pane list
//  rendering, the seam lands here (on the split branch's sidebar `Pane`) and `SystemList` reads
//  it, mirroring the iOS pair.
//
//  TOOLBAR (Toolbar.swift, 1:1): HStack(spacing default 12) of the slot; padding h16/v10;
//  full width; `.bar` material (degrades to the regular-material fill — the engine's
//  surface tier); ONE hairline (0.5dp, Color(white 0.5) 35%) on the edge facing the
//  content — top edge for position="bottom" (default), bottom edge for "top".
//
//  FLOW (Flow.swift FlowLayout, math 1:1): greedy row packing at ideal sizes — break when
//  the next item would overflow; spacing= (default 8) within a row, lineSpacing= (default
//  8) between rows. Total = widest row × (rows + gaps).
//
//  CAROUSEL (Carousel.swift): a paged HorizontalPager; value= optional two-way Int page
//  key (swipe ↔ state, writing flips the page); on:change only on a REAL change (never
//  the mount page); dots= (default true — 7dp dots, 9dp gaps, bottom 8, active = color
//  tint default accent, inactive white 30% — the UIPageControl metrics); peek= (default
//  0) + spacing= (default 12) inset each page horizontally by peek+spacing so neighbours
//  peek in (the cosmetic cards inset, applied exactly like the Swift `inset`).
//

package despia.engine.render.elements

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.AdaptiveShell
import despia.engine.SplitPlan
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.StackNode
import despia.engine.render.BoundControl
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.LocalInScrollContainer
import despia.engine.render.StackMotion
import despia.engine.render.StackNodeView
import despia.engine.render.bound
import despia.engine.render.StackStyle
import despia.engine.render.rememberAnimatorDurationScale
import kotlin.math.max
import kotlin.math.roundToInt

internal fun registerContainerElements() {
    ComposeStackComponents.definePrivileged("scaffold") { ctx -> ScaffoldElement(ctx) }
    ComposeStackComponents.definePrivileged("split") { ctx -> SplitElement(ctx) }
    ComposeStackComponents.definePrivileged("carousel") { ctx -> CarouselElement(ctx) }
    ComposeStackComponents.defineNative("toolbar") { ctx -> ToolbarElement(ctx) }
    // PRIVILEGED since 2026-08-26 (runtime-pressure R29): `<flow bind>` repeats. The tier is
    // what exposes `bound()` and the per-row `StackNodeView(item, rowWrite)`, and nothing else
    // about the element changed - a flow with no `bind` still renders its authored children.
    ComposeStackComponents.definePrivileged("flow") { ctx -> FlowElement(ctx) }
}

// MARK: - <scaffold> (privileged — reads each child's `pin` side attr)

@Composable
private fun ScaffoldElement(ctx: ComposeStackComponentContext) {
    val kids = ctx.node?.children ?: return
    val resolvedChildren = kids.map { PlatformAttrs.resolve(it.attrs, Platform.attributeTarget) }
    val partition = AdaptiveShell.partition(resolvedChildren)
    fun nodes(indexes: List<Int>) = indexes.map(kids::get)
    val top = nodes(partition.top)
    val bottom = nodes(partition.bottom)
    val body = nodes(partition.authored)
    val sidebar = nodes(partition.sidebar)
    val content = nodes(partition.content)
    val inspector = nodes(partition.inspector)
    val shellAttrs = ctx.attrs.mapValues { (_, value) -> JSE.interpolate(value, ctx.store, ctx.item) }
    // safeDrawing includes the IME. Applying it to a pinned bottom bar makes the
    // keyboard's full height part of that bar, which can collapse the scaffold body
    // (and every focused control in it) to zero height in landscape. Keyboard
    // avoidance belongs to scrollable/authored content; scaffold chrome only owns
    // the non-IME safe-area delta, matching the system-bar inset when the keyboard
    // is hidden and avoiding double-accounting while it is visible.
    val chromeSafeDrawing = WindowInsets.safeDrawing.exclude(WindowInsets.ime)
    Column(Modifier.elementStyle(El(ctx)).then(Modifier.fillMaxSize()).testTag("dsx.scaffold")) {
        if (top.isNotEmpty()) {
            Column(Modifier.fillMaxWidth()
                       .testTag("dsx.scaffold.pin.top")
                       .windowInsetsPadding(chromeSafeDrawing.only(WindowInsetsSides.Top))) {
                for (k in top) StackNodeView(k, ctx.store, ctx.env, ctx.item, ctx.rowWrite)
            }
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val plan = AdaptiveShell.resolve(
                attrs = shellAttrs,
                widthDp = maxWidth.value.toDouble(),
                nativeAvailable = false,
                hasSidebar = sidebar.isNotEmpty(),
                hasContent = content.isNotEmpty(),
                hasInspector = inspector.isNotEmpty(),
            )
            AdaptiveScaffoldBody(
                plan, body, sidebar, content, inspector, ctx,
                sidebarLabel = shellAttrs["sidebarLabel"] ?: ElementDefaults.SCAFFOLD_SIDEBAR_LABEL,
                contentLabel = shellAttrs["contentLabel"] ?: ElementDefaults.SCAFFOLD_CONTENT_LABEL,
                inspectorLabel = shellAttrs["inspectorLabel"] ?: ElementDefaults.SCAFFOLD_INSPECTOR_LABEL,
            )
        }
        if (bottom.isNotEmpty()) {
            Column(Modifier.fillMaxWidth()
                       .testTag("dsx.scaffold.pin.bottom")
                       .windowInsetsPadding(chromeSafeDrawing.only(WindowInsetsSides.Bottom))) {
                for (k in bottom) StackNodeView(k, ctx.store, ctx.env, ctx.item, ctx.rowWrite)
            }
        }
    }
}

@Composable
private fun AdaptiveScaffoldBody(
    plan: AdaptiveShell.Plan,
    authored: List<StackNode>,
    sidebar: List<StackNode>,
    content: List<StackNode>,
    inspector: List<StackNode>,
    ctx: ComposeStackComponentContext,
    sidebarLabel: String,
    contentLabel: String,
    inspectorLabel: String,
) {
    /// `contentInset` is the readable-margin half (see the file header): applied AFTER the
    /// testTag/semantics so the pane node still measures its whole column slot — the margin eats
    /// into the pane's own content, never into its reported bounds.
    @Composable fun Pane(
        nodes: List<StackNode>,
        modifier: Modifier = Modifier,
        role: String? = null,
        label: String? = null,
        contentInset: PaddingValues? = null,
    ) {
        val tagged = if (role == null || label == null) modifier else {
            modifier.testTag("dsx.scaffold.$role").semantics { contentDescription = label }
        }
        val paneModifier = if (contentInset == null) tagged else tagged.padding(contentInset)
        Column(paneModifier) {
            for (node in nodes) StackNodeView(node, ctx.store, ctx.env, ctx.item, ctx.rowWrite)
        }
    }
    when (plan.layout) {
        "custom" -> Pane(authored, Modifier.fillMaxSize())
        "content" -> Pane(content, Modifier.fillMaxSize(), "content", contentLabel)
        "stack" -> CompositionLocalProvider(LocalInScrollContainer provides true) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Pane(sidebar, Modifier.fillMaxWidth(), "sidebar", sidebarLabel)
                Pane(content, Modifier.fillMaxWidth(), "content", contentLabel)
                if (inspector.isNotEmpty()) {
                    Pane(inspector, Modifier.fillMaxWidth(), "inspector", inspectorLabel)
                }
            }
        }
        else -> Row(Modifier.fillMaxSize()) {
            Pane(
                sidebar,
                Modifier.fillMaxHeight()
                    .width(plan.sidebar.ideal.dp)
                    .widthIn(min = plan.sidebar.min.dp, max = plan.sidebar.max.dp),
                "sidebar",
                sidebarLabel,
            )
            AdaptivePaneDivider()
            // The readable margin (file header): a split detail pane sits inset from the divider,
            // like a real M3 expanded-window pane — never flush against it.
            Pane(
                content,
                Modifier.weight(1f).fillMaxHeight(),
                "content",
                contentLabel,
                SPLIT_CONTENT_INSET,
            )
            if (plan.layout.endsWith("3") && inspector.isNotEmpty()) {
                AdaptivePaneDivider()
                Pane(
                    inspector,
                    Modifier.fillMaxHeight()
                        .width(plan.inspector.ideal.dp)
                        .widthIn(min = plan.inspector.min.dp, max = plan.inspector.max.dp),
                    "inspector",
                    inspectorLabel,
                )
            }
        }
    }
}

/// The split detail pane's readable margins (the Scaffold.swift `detailReadableInset` /
/// `detailReadableTopInset` twin; file header). HORIZONTAL is M3's own medium/expanded
/// window-size-class margin (24dp) — the law's Android row is Material 3, so the number is M3's,
/// not iPad's 20pt readable inset. TOP is the same small 8dp iOS uses: neither renderer draws a
/// pane header above this content, so the full 24dp M3 top margin would only push it down.
/// Chrome metric, deliberately out of the parity spec (ElementSpec.kt header rule 4).
private val SPLIT_CONTENT_INSET = PaddingValues(start = 24.dp, end = 24.dp, top = 8.dp)

@Composable
private fun AdaptivePaneDivider() {
    Box(Modifier.fillMaxHeight().width(0.5.dp).background(Color(0.5f, 0.5f, 0.5f, 0.28f)))
}

// MARK: - <split> (privileged — reads each child's `paneRole` side attr)
//
//  The two/three-pane adaptive container (component-library.md W9). The DECISIONS are
//  :core SplitPlan (corpus OpenSource/Conformance/split/split.json — the TS and Swift
//  twins run the same file); this composable is the Material presentation of that plan,
//  the list-detail canonical layout built from the same primitives as the adaptive
//  scaffold: compact = the host pane with a selected detail COVERING it (the stack-push
//  idiom), medium = the pinned pane pair with the sidebar as a scrimmed overlay,
//  expanded = every pane pinned in a Row with hairline dividers and the M3 readable
//  margin on the detail (SPLIT_CONTENT_INSET — the 24dp divergence pinned above).
//  DIVERGENCES, header-pinned like the scaffold's: no draggable dividers (`resizable`
//  is the fine-pointer semantic renderers' half; M3 panes are fixed-width) and the
//  compact Back pop rides the app's own value= write this wave (no BackHandler
//  dependency in :render) — iOS bridges the platform Back via preferredCompactColumn.

@Composable
private fun SplitElement(ctx: ComposeStackComponentContext) {
    val kids = ctx.node?.children ?: return
    if (kids.isEmpty()) return
    val children = kids.take(3)
    val resolvedChildren = children.map { PlatformAttrs.resolve(it.attrs, Platform.attributeTarget) }
    val declaredRoles = resolvedChildren.map { it["paneRole"] }
    val el = El(ctx)
    val ctl = BoundControl(ctx.componentTag, ctx.attrs, ctx.store, ctx.env, ctx.item, ctx.rowWrite)
    val splitAttrs = ctx.attrs.mapValues { (_, value) -> JSE.interpolate(value, ctx.store, ctx.item) }
    val valueKey = ctx.attrs["value"] ?: ""
    var sidebarOpen by remember { mutableStateOf(false) }

    BoxWithConstraints(Modifier.elementStyle(el).then(Modifier.fillMaxSize()).testTag("dsx.split")) {
        val plan = SplitPlan.resolve(splitAttrs, declaredRoles, maxWidth.value.toDouble())
        val selected = plan.detail && valueKey.isNotEmpty() &&
            SplitPlan.selectionActive(ctl.boundValue(valueKey))
        val overlayOpen = plan.overlay && sidebarOpen

        @Composable fun Pane(role: String, modifier: Modifier, inset: PaddingValues? = null) {
            val index = plan.roles.indexOf(role)
            if (index < 0) return
            val tagged = modifier.testTag("dsx.split.$role")
                .semantics { contentDescription = role.replaceFirstChar { it.uppercase() } }
            Column(if (inset == null) tagged else tagged.padding(inset)) {
                StackNodeView(children[index], ctx.store, ctx.env, ctx.item, ctx.rowWrite)
            }
        }

        // Pane-presentation motion — the web dsx-split-push/overlay springs and the iOS
        // NavigationSplitView animation twin: the detail pushes in from the trailing edge,
        // the overlay sidebar slides from the leading edge under a fading scrim. The DSX
        // spring default (kernel Motion vocabulary) drives both; reduced motion (animator
        // duration scale 0) collapses every transition to an instant swap.
        val reduceMotion = rememberAnimatorDurationScale() == 0f
        val paneSpring = StackMotion.animation("spring", null)
        if (plan.presentation == "stack") {
            Pane(plan.host, Modifier.fillMaxSize())
            if (plan.host != "detail") {
                AnimatedVisibility(
                    visible = selected,
                    enter = if (reduceMotion) EnterTransition.None
                            else slideInHorizontally(StackMotion.spec(paneSpring, IntOffset.VisibilityThreshold)) { it } +
                                fadeIn(StackMotion.spec(paneSpring)),
                    exit = if (reduceMotion) ExitTransition.None
                           else slideOutHorizontally(StackMotion.spec(paneSpring, IntOffset.VisibilityThreshold)) { it } +
                               fadeOut(StackMotion.spec(paneSpring)),
                ) {
                    Pane("detail", Modifier.fillMaxSize().background(StackStyle.color("background")))
                }
            }
        } else {
            Row(Modifier.fillMaxSize()) {
                for ((position, role) in plan.columns.withIndex()) {
                    if (position > 0) AdaptivePaneDivider()
                    val last = position == plan.columns.size - 1
                    when {
                        last -> Pane(
                            role, Modifier.weight(1f).fillMaxHeight(),
                            if (plan.columns.size > 1) SPLIT_CONTENT_INSET else null,
                        )
                        role == "sidebar" -> Pane(
                            role,
                            Modifier.fillMaxHeight()
                                .width(plan.sidebar.ideal.dp)
                                .widthIn(min = plan.sidebar.min.dp, max = plan.sidebar.max.dp),
                        )
                        else -> Pane(
                            role,
                            Modifier.fillMaxHeight()
                                .width(plan.content.ideal.dp)
                                .widthIn(min = plan.content.min.dp, max = plan.content.max.dp),
                        )
                    }
                }
            }
        }

        if (plan.overlay) {
            AnimatedVisibility(
                visible = overlayOpen,
                enter = if (reduceMotion) EnterTransition.None else fadeIn(StackMotion.spec(paneSpring)),
                exit = if (reduceMotion) ExitTransition.None else fadeOut(StackMotion.spec(paneSpring)),
            ) {
                Box(Modifier.fillMaxSize().background(Color(0f, 0f, 0f, 0.32f))
                        .testTag("dsx.split.scrim")
                        .clickable { sidebarOpen = false })
            }
            AnimatedVisibility(
                visible = overlayOpen,
                enter = if (reduceMotion) EnterTransition.None
                        else slideInHorizontally(StackMotion.spec(paneSpring, IntOffset.VisibilityThreshold)) { -it } +
                            fadeIn(StackMotion.spec(paneSpring)),
                exit = if (reduceMotion) ExitTransition.None
                       else slideOutHorizontally(StackMotion.spec(paneSpring, IntOffset.VisibilityThreshold)) { -it } +
                           fadeOut(StackMotion.spec(paneSpring)),
            ) {
                Pane(
                    "sidebar",
                    Modifier.fillMaxHeight()
                        .width(plan.sidebar.ideal.dp)
                        .widthIn(min = plan.sidebar.min.dp, max = plan.sidebar.max.dp)
                        .background(StackStyle.color("secondaryBackground")),
                )
            }
            // the sidebar toggle: three drawn bars, 40dp target, top-leading like the web twin
            Column(
                Modifier.padding(8.dp).size(40.dp)
                    .testTag("dsx.split.toggle")
                    .semantics { contentDescription = if (overlayOpen) "Hide sidebar" else "Show sidebar" }
                    .clickable { sidebarOpen = !sidebarOpen }
                    .padding(11.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                repeat(3) {
                    Box(Modifier.fillMaxWidth().height(2.dp)
                            .background(StackStyle.color("secondaryLabel")))
                }
            }
        }
    }
}

// MARK: - <toolbar>

@Composable
private fun ToolbarElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val topEdge = el.str("position", "bottom") == "top"        // top bar → hairline on the BOTTOM edge
    val spacing = el.dbl("spacing", ElementDefaults.TOOLBAR_SPACING)
    Box(Modifier.elementStyle(el).then(Modifier.fillMaxWidth().background(StackStyle.material("regular")))) {
        Row(Modifier.fillMaxWidth().padding(horizontal = ElementDefaults.TOOLBAR_PAD_H.dp,
                                            vertical = ElementDefaults.TOOLBAR_PAD_V.dp),
            horizontalArrangement = if (spacing > 0) Arrangement.spacedBy(spacing.dp) else Arrangement.Start,
            verticalAlignment = Alignment.CenterVertically) {
            SlotRowNodes(ctx, defaultSlot(ctx))
        }
        Box(Modifier.align(if (topEdge) Alignment.BottomStart else Alignment.TopStart)
                .fillMaxWidth().height(ElementDefaults.TOOLBAR_HAIRLINE.dp)
                .background(Color(0.5f, 0.5f, 0.5f, 0.35f)))    // Color(white: 0.5).opacity(0.35)
    }
}

// MARK: - <flow> (the FlowLayout greedy packer, math 1:1)

@Composable
private fun FlowElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val h = el.dbl("spacing", ElementDefaults.FLOW_SPACING)
    val v = el.dbl("lineSpacing", ElementDefaults.FLOW_LINE_SPACING)
    // A BOUND flow repeats its single child template per row; an unbound one lays out the
    // children it was authored with. Same packer either way - the rows ARE the measurables, so
    // the wrap math below never learns that a repeater exists.
    val bindKey = ctx.attrs["bind"]
    val template = if (bindKey != null) ctx.node?.children?.firstOrNull() else null
    val content: @Composable () -> Unit = if (bindKey != null && template != null) {
        {
            val b = bound(ctx.attrs, ctx.store, ctx.item, ctx.rowWrite)
            val count = b.rows.size
            for (i in 0 until count) {
                StackNodeView(template, ctx.store, ctx.env, b.item(i), b.writer(i))
            }
        }
    } else {
        { SlotNodes(ctx, defaultSlot(ctx)) }
    }
    Layout(
        content = content,
        modifier = Modifier.elementStyle(el),
    ) { measurables, constraints ->
        val hPx = h.dp.toPx(); val vPx = v.dp.toPx()
        val maxW = if (constraints.hasBoundedWidth) constraints.maxWidth else Int.MAX_VALUE
        // Ideal sizes (sizeThatFits .unspecified): loose constraints bounded by the row width.
        val placeables = measurables.map { it.measure(Constraints(maxWidth = maxW)) }
        // Pass 1 — total size (sizeThatFits).
        var rowW = 0f; var rowH = 0f; var totalW = 0f; var totalH = 0f
        for (p in placeables) {
            if (rowW > 0f && rowW + hPx + p.width > maxW) {
                totalW = max(totalW, rowW); totalH += rowH + vPx; rowW = 0f; rowH = 0f
            }
            rowW += (if (rowW > 0f) hPx else 0f) + p.width
            rowH = max(rowH, p.height.toFloat())
        }
        totalW = max(totalW, rowW); totalH += rowH
        val width = totalW.roundToInt().coerceIn(constraints.minWidth,
            if (constraints.hasBoundedWidth) constraints.maxWidth else Int.MAX_VALUE)
        val height = totalH.roundToInt().coerceAtLeast(constraints.minHeight)
        // Pass 2 — placement (placeSubviews).
        layout(width, height) {
            var x = 0f; var y = 0f; var lineH = 0f; var rowStart = true
            for (p in placeables) {
                if (!rowStart && x + hPx + p.width > maxW) { x = 0f; y += lineH + vPx; lineH = 0f; rowStart = true }
                if (!rowStart) x += hPx
                p.placeRelative(x.roundToInt(), y.roundToInt())
                x += p.width
                lineH = max(lineH, p.height.toFloat())
                rowStart = false
            }
        }
    }
}

// MARK: - <carousel> (privileged — static children are the pages)

@Composable
private fun CarouselElement(ctx: ComposeStackComponentContext) {
    val pages: List<StackNode> = ctx.node?.children ?: return
    if (pages.isEmpty()) return
    val el = El(ctx)
    val ctl = BoundControl(ctx.componentTag, ctx.attrs, ctx.store, ctx.env, ctx.item, ctx.rowWrite)
    val tint = el.color("color", ElementDefaults.CAROUSEL_TINT)
    val dots = ctx.attrs["dots"] != "false"
    val peek = el.dbl("peek", ElementDefaults.CAROUSEL_PEEK)
    val spacing = el.dbl("spacing", ElementDefaults.CAROUSEL_SPACING)

    val valueKey = ctx.attrs["value"] ?: ""
    val boundIndex = (if (valueKey.isEmpty()) 0 else JSE.number(ctl.boundValue(valueKey))?.toInt() ?: 0)
        .coerceIn(0, pages.size - 1)
    val state = rememberPagerState(initialPage = boundIndex) { pages.size }
    var reported by remember { mutableIntStateOf(boundIndex) }        // the mount page never fires on:change
    LaunchedEffect(state.settledPage) {
        if (state.settledPage == reported) return@LaunchedEffect
        reported = state.settledPage
        if (valueKey.isNotEmpty()) ctl.setBound(valueKey, state.settledPage.toDouble())   // fires on:change via the seam
        else ctl.fireChangeGuarded()
    }
    if (valueKey.isNotEmpty()) {
        LaunchedEffect(boundIndex) {
            if (boundIndex != state.currentPage) {                     // a programmatic write flips the page
                reported = boundIndex
                state.scrollToPage(boundIndex)
                ctl.fireChangeGuarded()
            }
        }
    }

    Box(Modifier.elementStyle(el).then(Modifier.fillMaxWidth())) {
        HorizontalPager(state, Modifier.fillMaxWidth()) { p ->
            val page: @Composable () -> Unit = { StackNodeView(pages[p], ctx.store, ctx.env, ctx.item, ctx.rowWrite) }
            if (peek > 0) Box(Modifier.padding(horizontal = (peek + spacing).dp)) { page() }
            else page()
        }
        if (dots && pages.size > 1) {
            Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp)) {   // UIPageControl metrics: 7dp dots, 9dp gaps
                for (i in pages.indices) {                              // display-only, like .page's dots
                    Box(Modifier.size(7.dp).background(
                        if (i == state.currentPage) tint else Color.White.copy(alpha = 0.3f), CircleShape))
                }
            }
        }
    }
}
