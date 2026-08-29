//
//  Sheets.kt — `<sheet>` (the declarative native modal) + `<Drawer>` (the swipe-to-dismiss
//  bottom panel). Kotlin twins of Foundation Structure/Sheet/Sheet.swift and Core/Drawer.swift.
//
//  SHEET — same attribute contract as iOS (StackReference "sheet"):
//    present= (two-way Bool key) · mode= sheet(default)/card/cover · detents= CSV of
//    content|half|full (default "half,full") · inset= (card gap, default 14) ·
//    background= (presentation background token, default "background"; "system" keeps the
//    platform stand-in, "clear" is transparent) · the #1002 STANDARD DRAWER CHROME
//    (title= / close= leading|trailing|none / action= + actionIcon= / actionSide=,
//    geometry 1:1 from SheetChromeBar) · on:dismiss · on:action.
//
//  Geometry pinned from the Swift source:
//    • chrome bar: title 17 semibold centered (h-padding 56 so it never collides with the
//      bar buttons); bar padding h16 / top16 / bottom6; buttons height 34; circular ✕
//      34×34 (xmark 14, secondaryLabel) on a glass circle; action = icon 13 + label 15
//      semibold, h-padding 14 when labeled (0 icon-only), minWidth 34, glass capsule.
//      Glass = the engine's surface fallback (StackStyle.material("glass") — iOS 26
//      Liquid Glass / .ultraThinMaterial degrade, the documented tier).
//    • `content` detent = the measured ideal content height, capped at 90% of the layer
//      (Sheet.swift contentDetent min(h, screen*0.9)); `half` = 50% (.medium);
//      `full` = layer − 10dp top gap (.large's small top gap). firstDetent: "full" only
//      when the FIRST token is full, else the half/medium stand-in — and a `content`
//      token HOPS onto the measured detent when the measurement lands (Sheet.swift
//      MeasuredSheetContent.measured), re-following async growth while parked on it.
//    • card mode floats on an all-round `inset` gap (transparent presentation — the
//      author's markup draws the card fill) and at the `full` detent SHEDS the gap and
//      becomes an opaque edge-to-edge drawer (CardSheetContent).
//    • cover = 100% edge-to-edge, no detents, no grabber.
//
//  PRESENT/DISMISS TRANSITION (SheetMotion — extracted from Stack.swift StackSurface):
//  the sheet/cover slides in with the present spring (0.4s, damping 0.88, velocity 0.4 —
//  Stack.swift present) and slides out with the dismiss curve (0.28s .curveEaseIn —
//  Stack.swift dismiss); the scrim dim rides the same transition. A caller that keeps
//  composing after its state closes (`open=false` + `onExited`) gets the exit played on
//  the way out — the `<sheet>` element holds itself, RouterModalHost holds nav.modal
//  entries (its release hold pairs with :core's `StackSurface.deferRemoval` seam).
//
//  DETENT SNAPPING (SheetMath — pure, JVM-tested): a slow release parks on the NEAREST
//  stop (dismiss below half the smallest); a FLING projects the release with UIKit's
//  `project(initialVelocity:)` deceleration (travel ≈ v·0.499) and parks on the stop
//  nearest the projection, restricted to stops AHEAD of the fling — so a hard fling
//  skips intermediate detents (full → smallest in one gesture) and a downward fling at
//  the smallest stop (or a projection past the dismiss line) dismisses. SCROLL-EXPANDS-
//  SHEET (presentationContentInteraction .resizes, Sheet.swift sheetExpandsOnScroll):
//  a nested-scroll seam grows the sheet BEFORE scrollable content scrolls (finger up),
//  pulls it down when content is back at its top (finger down), and hands the release
//  fling to the same detent settle while the sheet is mid-resize.
//
//  DRAWER (Drawer.swift, 1:1): grabber capsule 36×5 white 25% (v-padding 8); content
//  VStack spacing 12, h-padding 20, bottom 12; fill Color(white: 0.11); radius 24; drag
//  follows the finger (down only), > 120 raises `close` (→ consumer on:close), else
//  springs back.
//
//  ── DEVIATIONS (pinned, none silent) ─────────────────────────────────────────────────
//  • Android's standard half/full and full-only contracts use Material 3's real
//    ModalBottomSheet (including its system scrim, drag handle, accessibility semantics,
//    predictive/system BACK integration, and platform motion). DSX-specific `content`
//    detents and floating `card` mode use the custom compositor below because Material 3
//    has no public custom-detent API.
//  • Sheet corner radius pinned 24 (the engine's `surface="sheet"` tier); iOS uses the
//    device-concentric system radius, which has no Android twin.
//  • Grabber pinned 36×5 at 30% white (the system drag indicator look).
//  • The fling floor is pinned at 300 dp/s and the projection at v·0.499 (UIKit's `.normal`
//    deceleration): UISheetPresentationController's own constants are private — these are
//    the documented approximations (300 is the same figure Lightbox.swift's predicted-end
//    gate uses).
//  • Compose has no duration-parameterized spring: the present spring keeps iOS's damping
//    0.88 and pins stiffness 380 to land the ≈0.4s settle.
//  • cover has NO interactive dismissal on iOS; here the BACK key dismisses it (the
//    Android back contract) — documented divergence.
//

package despia.engine.render.elements

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.DSXStrings
import despia.engine.Motion
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents
import despia.engine.render.ElementDefaults
import despia.engine.render.LocalInScrollContainer
import despia.engine.render.StackIcon
import despia.engine.render.StackStyle
import despia.engine.render.dsxAccessibleActivation
import despia.engine.render.dsxAccessibleDismiss
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

internal fun registerSheetElements() {
    ComposeStackComponents.defineNative("sheet") { ctx -> SheetElement(ctx) }
    ComposeStackComponents.defineNative("Drawer") { ctx -> DrawerElement(ctx) }
}

// MARK: - detents (Sheet.swift SheetAnchor.detents/firstDetent/contentDetent)

/// CSV → the recognized stops; empty/unknown-only falls back to [half, full] (iOS: an
/// empty parse yields [.medium, .large]).
internal fun parseDetents(csv: String): List<String> {
    val toks = csv.split(",").map { it.trim() }.filter { it == "content" || it == "half" || it == "full" }
    return toks.ifEmpty { ElementDefaults.SHEET_DETENTS.split(",") }
}

/// The opening detent: `.large` only when the FIRST token is "full", else the medium/half
/// stand-in (a `content` token hops on once measured — Sheet.swift firstDetent).
internal fun firstDetent(tokens: List<String>): String = if (tokens.firstOrNull() == "full") "full" else "half"

/// Router modal `detents` entries use the iOS StackDetent spellings too — map both.
internal fun modalDetentToken(s: String): String? = when (s) {
    "medium", "half" -> "half"
    "large", "full" -> "full"
    "content" -> "content"
    else -> null
}

// MARK: - motion (Stack.swift StackSurface present/dismiss — the modal transition curves)

/// Present/dismiss transition constants, extracted from Stack.swift StackSurface:
///   • present — `UIView.animate(withDuration: 0.4, usingSpringWithDamping: 0.88,
///     initialSpringVelocity: 0.4, options: .curveEaseOut)`; Compose springs carry no
///     duration, so dampingRatio maps 1:1 and stiffness 380 lands the ≈0.4s settle
///     (ω = √k ≈ 19.5 rad/s ⇒ the 0.1% envelope at ≈ 6.9/(ζ·ω) ≈ 0.4s).
///   • dismiss — `UIView.animate(withDuration: 0.28, options: .curveEaseIn)`; the exit
///     easing is the exact UIKit .curveEaseIn bezier (0.42, 0, 1, 1).
internal object SheetMotion {
    fun enterSpring(): AnimationSpec<Float> = spring(dampingRatio = 0.88f, stiffness = 380f)
    fun exitTween(): AnimationSpec<Float> = tween(280, easing = CubicBezierEasing(0.42f, 0f, 1f, 1f))
}

// MARK: - snap math (pure — JVM-tested in SheetMathTest)

/// The drag-release detent decision. iOS gets this from UISheetPresentationController;
/// the distilled contract (see the file header):
///   • |velocity| under the fling floor → the stop NEAREST the released height
///     (dismiss when the release projects below half the smallest stop);
///   • a fling projects the release with UIKit's `project(initialVelocity:)` at the
///     `.normal` deceleration rate (travel ≈ v·0.499) and parks on the stop nearest the
///     PROJECTION among the stops AHEAD of the fling — a fling never snaps backwards,
///     always advances at least one stop, and a hard fling skips intermediate stops;
///   • a downward fling with no stop below dismisses; an upward fling past the top stop
///     parks on the top stop.
/// `velocity` is the HEIGHT velocity in px/s (positive = the sheet growing).
internal object SheetMath {
    /// UIScrollView `.normal` deceleration (0.998/ms): projected travel per px/s of
    /// velocity — τ, READ FROM THE SHARED MOTION KERNEL (`Motion.DECAY_TAU_MS`,
    /// corpus-pinned in OpenSource/Conformance/motion/physics.json; ui-motion.md). This
    /// used to be a rounded local copy (0.499); the sheet now shares the ONE decay law
    /// with every other surface that flings.
    val PROJECTION: Float = (Motion.DECAY_TAU_MS / 1000.0).toFloat()

    /// The fling floor in dp/s (pinned — see header DEVIATIONS).
    const val FLING_DP_PER_SEC = 300f

    /// Momentum projection: where a release at `position` moving at `velocity` px/s coasts
    /// to — the kernel's decay fold (velocity converted px/s → px/ms, its unit). A release
    /// at or under the kernel's terminal velocity does not travel at all.
    fun project(position: Float, velocity: Float): Float =
        Motion.decayTarget(position.toDouble(), velocity.toDouble() / 1000.0).toFloat()

    /// The resting stop for a release, or null to DISMISS. `stops` = token → height px.
    fun settleDetent(stops: List<Pair<String, Float>>, height: Float, velocity: Float, fling: Float): String? {
        if (stops.isEmpty()) return null
        val smallest = stops.minOf { it.second }
        val projected = project(height, velocity)
        if (projected < smallest * 0.5f) return null                         // coasts past the dismiss line
        if (abs(velocity) < fling) return stops.minByOrNull { abs(it.second - height) }!!.first
        val up = velocity > 0f
        val ahead = stops.filter { if (up) it.second > height + 1f else it.second < height - 1f }
        if (ahead.isEmpty()) {
            return if (up) stops.maxByOrNull { it.second }!!.first else null // down past the smallest stop → dismiss
        }
        return ahead.minByOrNull { abs(it.second - projected) }!!.first
    }
}

/// The live sheet height (px) the gesture paths mutate SYNCHRONOUSLY — nested-scroll must
/// return its consumed delta before the Animatable's snapTo coroutine lands.
private class SheetHeightShadow(var px: Float)

// MARK: - <sheet>

@Composable
private fun SheetElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["present"] ?: ""
    val present = el.presented(key)
    FireOnDismiss(present, el)

    // EXIT HOLD: keep composing after `present` flips false so the dismiss transition can
    // play (open=false); `onExited` drops the hold. Guarded write → converges in one pass.
    var shown by remember { mutableStateOf(false) }
    if (present && !shown) shown = true
    if (!present && !shown) return                             // the inert zero-size anchor

    val mode = el.str("mode")
    val tokens = parseDetents(el.str("detents", ElementDefaults.SHEET_DETENTS))
    // The PRESENTATION background (Sheet.swift bgToken): theme token by default;
    // "system" keeps the platform stand-in (the regular-material degrade); "clear" clear.
    val bgToken = el.str("background", "background")
    val bg: Color? = when (bgToken) {
        "system" -> null
        "clear" -> Color.Transparent
        else -> StackStyle.color(bgToken)
    }

    // #1002 standard drawer chrome — renders when any of title/close/action is declared.
    val title = el.str("title")
    val actionLabel = el.str("action")
    val actionIcon = el.str("actionIcon")
    val closeRaw = el.str("close")
    val hasChrome = title.isNotEmpty() || actionLabel.isNotEmpty() || actionIcon.isNotEmpty() ||
        (closeRaw.isNotEmpty() && closeRaw != "none")
    val chrome: (@Composable () -> Unit)? = if (hasChrome) {
        {
            SheetChromeBar(title = title,
                           closeSide = closeRaw.ifEmpty { "leading" },
                           actionLabel = actionLabel, actionIcon = actionIcon,
                           actionSide = el.str("actionSide", "trailing"),
                           onClose = { el.dismissBound() },
                           onAction = { el.run("action") })
        }
    } else null

    if (mode == "cover") {
        // 100% edge-to-edge — no detents, no grabber (fullScreenCover). BACK dismisses
        // (Android contract — see header); slides up/down with the StackSurface curves.
        CoverScaffold(onDismissRequest = { el.dismissBound() },
                      open = present, onExited = { shown = false }) {
            Column(Modifier.fillMaxSize().background(bg ?: StackStyle.material("regular"))) {
                chrome?.invoke()
                SlotNodes(ctx, defaultSlot(ctx))
            }
        }
        return
    }

    SheetScaffold(
        tokens = tokens,
        card = mode == "card",
        inset = el.dbl("inset", ElementDefaults.SHEET_CARD_INSET).dp,
        bg = bg,
        onInteractiveDismiss = { el.dismissBound() },
        open = present,
        onExited = { shown = false },
        header = chrome,
    ) { SlotNodes(ctx, defaultSlot(ctx)) }
}

// MARK: - the sheet container (shared with RouterModalHost's `as: sheet` entries)

/// Native-identity boundary. Material 3 publicly supports the standard partially-expanded
/// and expanded anchors; it does not expose arbitrary measured-content anchors or the
/// floating-card geometry in DSX's cross-platform contract.
internal object AndroidSheetPresentationPolicy {
    fun usesMaterialSheet(tokens: List<String>, card: Boolean): Boolean =
        !card && (tokens == listOf("half", "full") || tokens == listOf("full"))

    fun skipsPartiallyExpanded(tokens: List<String>): Boolean = tokens == listOf("full")
}

/// The public sheet seam. Ordinary DSX sheets and router sheets stay real Material 3
/// controls; only contracts Material cannot represent fall through to the custom detent
/// compositor.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SheetScaffold(
    tokens: List<String>,
    card: Boolean,
    inset: Dp,
    bg: Color?,
    onInteractiveDismiss: () -> Unit,
    open: Boolean = true,
    onExited: () -> Unit = {},
    header: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    if (!AndroidSheetPresentationPolicy.usesMaterialSheet(tokens, card)) {
        CustomDetentSheetScaffold(
            tokens = tokens,
            card = card,
            inset = inset,
            bg = bg,
            onInteractiveDismiss = onInteractiveDismiss,
            open = open,
            onExited = onExited,
            header = header,
            content = content,
        )
        return
    }

    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = AndroidSheetPresentationPolicy.skipsPartiallyExpanded(tokens),
    )
    LaunchedEffect(open) {
        if (!open) {
            sheetState.hide()
            onExited()
        }
    }
    ModalBottomSheet(
        onDismissRequest = onInteractiveDismiss,
        sheetState = sheetState,
        containerColor = bg ?: MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        // Material derives its anchors from measured sheet content. Without a full-height
        // content proposal, short content collapses both DSX `half` and `full` to the same
        // content-height panel. Reserve the available height and let the real Material
        // sheet own its partially-expanded/expanded anchors and motion.
        Column(Modifier.fillMaxWidth().fillMaxHeight()) {
            header?.invoke()
            content()
        }
    }
}

/// The detented bottom-sheet presentation: scrim, grabber, optional chrome header,
/// drag-to-resize between detents (velocity-aware — SheetMath), scroll-expands-sheet,
/// drag/tap-away/back to dismiss, and the present/dismiss slide (SheetMotion). Geometry
/// per header. `open=false` plays the exit and then calls `onExited` — the caller keeps
/// composing until then (the exit-hold contract).
@Composable
private fun CustomDetentSheetScaffold(
    tokens: List<String>,
    card: Boolean,
    inset: Dp,
    bg: Color?,
    onInteractiveDismiss: () -> Unit,
    open: Boolean = true,
    onExited: () -> Unit = {},
    header: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    FullScreenLayer(onDismissRequest = onInteractiveDismiss) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val density = LocalDensity.current
            val maxHpx = with(density) { maxHeight.toPx() }
            val insetPx = with(density) { inset.toPx() }
            val flingPx = with(density) { SheetMath.FLING_DP_PER_SEC.dp.toPx() }
            var measured by remember { mutableFloatStateOf(0f) }   // the content's ideal height (px)
            var current by remember { mutableStateOf(firstDetent(tokens)) }

            fun heightOf(token: String): Float = when (token) {
                "full" -> maxHpx - with(density) { 10.dp.toPx() }          // .large's small top gap
                "half" -> maxHpx * 0.5f                                     // .medium
                else -> if (measured > 1f) minOf(measured, maxHpx * 0.9f)   // measured, capped 90%
                        else maxHpx * 0.5f                                  // the medium stand-in, first frame
            }

            // The content-detent HOP: when the measurement lands, a sheet parked on the
            // half stand-in (or re-measuring on the content detent) follows it.
            LaunchedEffect(measured > 1f) {
                if (measured > 1f && "content" in tokens && (current == "half" || current == "content")) current = "content"
            }

            val scope = rememberCoroutineScope()
            val anim = remember { Animatable(heightOf(current)) }
            val live = remember { SheetHeightShadow(anim.value) }
            val target = heightOf(current)
            LaunchedEffect(target) {
                live.px = target
                anim.animateTo(target, spring(stiffness = Spring.StiffnessMediumLow))
            }

            // The present/dismiss slide (Stack.swift StackSurface curves — see SheetMotion):
            // the sheet's extra Y below its resting place. Enters from fully off-screen
            // (its own height + the card inset); the exit slides the same distance out,
            // then hands composition back through `onExited`.
            val slide = remember { Animatable(heightOf(current) + insetPx) }
            LaunchedEffect(open) {
                if (open) slide.animateTo(0f, SheetMotion.enterSpring())
                else {
                    slide.animateTo(anim.value + insetPx, SheetMotion.exitTween())
                    onExited()
                }
            }

            /// Release: pick the resting stop from the height + fling velocity (SheetMath);
            /// null = dismiss. `heightVelocity` px/s, positive = the sheet growing.
            fun settle(heightVelocity: Float) {
                val stops = tokens.map { it to heightOf(it) }
                val token = SheetMath.settleDetent(stops, live.px, heightVelocity, flingPx)
                if (token == null) { onInteractiveDismiss(); return }
                current = token
                live.px = heightOf(token)
                scope.launch {
                    anim.animateTo(live.px, spring(dampingRatio = 0.85f), initialVelocity = heightVelocity)
                }
            }

            // SCROLL-EXPANDS-SHEET (presentationContentInteraction .resizes): an upward
            // drag on scrollable content GROWS the sheet before the content scrolls; a
            // downward drag pulls the sheet down once the content is back at its top
            // (the unconsumed remainder); the release fling settles the detents while
            // the sheet is mid-resize (and stays the content's when it's parked).
            val resize = remember(tokens, maxHpx) {
                object : NestedScrollConnection {
                    private var resized = false
                    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                        val dy = available.y
                        if (source != NestedScrollSource.UserInput || dy >= 0f) return Offset.Zero
                        val maxPx = tokens.maxOf { heightOf(it) }
                        if (live.px >= maxPx - 0.5f) return Offset.Zero    // at the tallest stop — the scroll is the content's
                        val take = max(dy, live.px - maxPx)                // grow, never past the tallest stop
                        live.px -= take
                        resized = true
                        scope.launch { anim.snapTo(live.px) }
                        return Offset(0f, take)
                    }
                    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                        val dy = available.y
                        if (source != NestedScrollSource.UserInput || dy <= 0f || live.px <= 0f) return Offset.Zero
                        live.px = max(0f, live.px - dy)                    // content at its top — pull the sheet down
                        resized = true
                        scope.launch { anim.snapTo(live.px) }
                        return Offset(0f, dy)
                    }
                    override suspend fun onPreFling(available: Velocity): Velocity {
                        if (!resized) return Velocity.Zero
                        resized = false
                        if (tokens.any { abs(heightOf(it) - live.px) < 1f }) return Velocity.Zero   // parked — the fling is the content's
                        settle(-available.y)                               // mid-resize — the fling is the SHEET's
                        return available
                    }
                }
            }

            // Scrim — the UIKit dim, riding the present/dismiss transition; tap-away dismisses.
            val scrimAlpha = 0.4f * (1f - slide.value / (anim.value + insetPx).coerceAtLeast(1f)).coerceIn(0f, 1f)
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = scrimAlpha))
                .pointerInput(Unit) { detectTapGestures { onInteractiveDismiss() } })

            val drawer = !card || (current == "full" && "full" in tokens)   // card sheds its gap at full
            val shape = if (drawer) RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
                        else RoundedCornerShape(24.dp)
            val fill = when {
                !drawer -> Color.Transparent                                // floating card: markup draws the fill
                else -> bg ?: StackStyle.material("regular")                // theme bg / the system-material degrade
            }
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .offset { IntOffset(0, slide.value.roundToInt()) }      // the present/dismiss slide
                    .padding(if (drawer) 0.dp else inset)
                    .fillMaxWidth()
                    .height(with(density) { anim.value.toDp() })
                    .clip(shape)
                    .background(fill)
                    .dsxAccessibleDismiss(onInteractiveDismiss)
                    .nestedScroll(resize)
                    .draggable(
                        orientation = Orientation.Vertical,
                        enabled = open,
                        state = rememberDraggableState { dy ->
                            live.px = (live.px - dy).coerceIn(0f, tokens.maxOf { heightOf(it) })
                            scope.launch { anim.snapTo(live.px) }
                        },
                        onDragStopped = { velocity -> settle(-velocity) },  // px/s down → height velocity
                    )
            ) {
                if (drawer) SheetGrabber()
                val fit = "content" in tokens
                if (fit) {
                    // FIT-CONTENT (MeasuredSlot): the slot lays out at its IDEAL height
                    // inside a scroll (greedy children collapse); the measurement feeds
                    // the content detent; taller-than-cap content scrolls.
                    // Scroll-ancestor stamp (the iOS MeasuredSlot stamp, Sheet.swift:281):
                    // a nested unstyled `<list>`'s SYSTEM rendering stands down here —
                    // its own lazy list may never nest in this vertical scroll — and
                    // keeps the flat pre-law path (StackSystemControls.kt). The plain
                    // half/full branch below fills a bounded frame and needs no stamp.
                    CompositionLocalProvider(LocalInScrollContainer provides true) {
                        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                            Column(Modifier.fillMaxWidth().onSizeChanged {
                                measured = it.height + with(density) { 20.dp.toPx() }   // + grabber band (v-padding 8 + 5)
                            }) {
                                header?.invoke()
                                content()
                            }
                        }
                    }
                } else {
                    // TOP-ANCHOR + fill: overflow falls BELOW the sheet, never re-centers
                    // (the MeasuredSlot plain-mode contract).
                    Column(Modifier.fillMaxWidth().weight(1f)) {
                        header?.invoke()
                        content()
                    }
                }
            }
        }
    }
}

/// Full-screen modal container (`cover` — the .fullScreenCover twin, shared with
/// RouterModalHost's `as: cover` entries): slides up on present / down on dismiss with
/// the StackSurface curves (SheetMotion); no scrim, no detents. BACK dismisses (the
/// Android contract — see header). `open=false` plays the exit, then `onExited`.
@Composable
internal fun CoverScaffold(
    onDismissRequest: () -> Unit,
    open: Boolean = true,
    onExited: () -> Unit = {},
    content: @Composable () -> Unit,
) {
    FullScreenLayer(onDismissRequest = onDismissRequest) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val h = with(LocalDensity.current) { maxHeight.toPx() }
            val slide = remember { Animatable(h) }                          // starts fully below the screen
            LaunchedEffect(open) {
                if (open) slide.animateTo(0f, SheetMotion.enterSpring())
                else {
                    slide.animateTo(h, SheetMotion.exitTween())
                    onExited()
                }
            }
            Box(Modifier.fillMaxSize().offset { IntOffset(0, slide.value.roundToInt()) }) { content() }
        }
    }
}

/// The drag indicator — pinned 36×5 white 30% inside an 8dp vertical band (see header).
@Composable
private fun SheetGrabber() {
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(36.dp, 5.dp).background(Color.White.copy(alpha = 0.3f), CircleShape))
    }
}

// MARK: - #1002 standard drawer chrome (SheetChromeBar, geometry 1:1)

@Composable
internal fun SheetChromeBar(
    title: String, closeSide: String, actionLabel: String, actionIcon: String, actionSide: String,
    onClose: () -> Unit, onAction: () -> Unit,
) {
    val hasAction = actionLabel.isNotEmpty() || actionIcon.isNotEmpty()
    Box(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp)) {
        BasicText(
            title,
            Modifier.align(Alignment.Center).fillMaxWidth().padding(horizontal = 40.dp),   // 56 total with the bar's 16
            style = TextStyle(color = StackStyle.color("label"), fontSize = 17.sp,
                              fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center),
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (closeSide == "leading") ChromeCloseButton(onClose)
            if (hasAction && actionSide == "leading") ChromeActionButton(actionLabel, actionIcon, onAction)
            Spacer(Modifier.weight(1f))
            if (hasAction && actionSide != "leading") ChromeActionButton(actionLabel, actionIcon, onAction)
            if (closeSide == "trailing") ChromeCloseButton(onClose)
        }
    }
}

/// The circular glass ✕ — xmark 14 semibold, secondaryLabel, 34×34 glass circle. The
/// visual chrome keeps its pinned 34, but the interactive node rides the platform
/// minimum target (density-following via LocalMinimumInteractiveComponentSize) — the
/// web twin moved its sheet chrome onto the 48px overlay-control tokens the same way.
@Composable
private fun ChromeCloseButton(onClose: () -> Unit) {
    Box(
        Modifier.dsxAccessibleActivation(
            role = Role.Button,
            contentDescription = DSXStrings.localize("Close"),
            mergeDescendants = false,
            onClick = onClose,
        )
            .pointerInput(Unit) { detectTapGestures { onClose() } }
            .minimumInteractiveComponentSize(),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(34.dp).background(StackStyle.material("glass"), CircleShape),
            contentAlignment = Alignment.Center) {
            StackIcon("xmark", 14.0, StackStyle.color("secondaryLabel"))
        }
    }
}

/// The glass action capsule — icon 13 + label 15 semibold, label color, height 34,
/// h-padding 14 when labeled (0 icon-only), minWidth 34. Same target treatment as the
/// close button: pinned 34 visual chrome inside a platform-minimum interactive node.
@Composable
private fun ChromeActionButton(label: String, icon: String, onAction: () -> Unit) {
    Box(
        Modifier.dsxAccessibleActivation(
            role = Role.Button,
            contentDescription = label.ifEmpty { DSXStrings.localize("Action") },
            onClick = onAction,
        )
            .pointerInput(Unit) { detectTapGestures { onAction() } }
            .minimumInteractiveComponentSize(),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier.height(34.dp).widthIn(min = 34.dp)
                .background(StackStyle.material("glass"), RoundedCornerShape(17.dp))
                .padding(horizontal = if (label.isEmpty()) 0.dp else 14.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon.isNotEmpty()) StackIcon(icon, 13.0, StackStyle.color("label"))
            if (label.isNotEmpty()) BasicText(label, style = TextStyle(color = StackStyle.color("label"),
                                              fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
        }
    }
}

// MARK: - <Drawer> (Drawer.swift, 1:1 — grabber 36×5 white 25%, fill white-0.11, radius 24,
// drag > 120 raises `close`, else springs back)

@Composable
private fun DrawerElement(ctx: ComposeStackComponentContext) {
    val scope = rememberCoroutineScope()
    val dragY = remember { Animatable(0f) }
    Column(
        Modifier.elementStyle(El(ctx))
            .then(Modifier.fillMaxWidth())
            .offset { IntOffset(0, max(0f, dragY.value).roundToInt()) }
            .clip(RoundedCornerShape(ElementDefaults.DRAWER_RADIUS.dp))
            .background(StackStyle.color(ElementDefaults.DRAWER_PANEL))     // the elevated-surface slot (Drawer.swift twin)
            .dsxAccessibleDismiss { raiseEvent(ctx, "close") }
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = {
                        if (dragY.value > ElementDefaults.DRAWER_DISMISS.dp.toPx()) raiseEvent(ctx, "close")   // PointerInputScope IS a Density
                        else scope.launch { dragY.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow)) }
                    },
                    onDragCancel = { scope.launch { dragY.animateTo(0f) } },
                ) { change, dy ->
                    change.consume()
                    scope.launch { dragY.snapTo(dragY.value + dy) }
                }
            }
    ) {
        Box(Modifier.fillMaxWidth().padding(vertical = ElementDefaults.DRAWER_HANDLE_PAD_V.dp),
            contentAlignment = Alignment.Center) {
            Box(Modifier.size(ElementDefaults.DRAWER_HANDLE_W.dp, ElementDefaults.DRAWER_HANDLE_H.dp)
                .background(StackStyle.color(ElementDefaults.DRAWER_HANDLE), CircleShape))   // the semantic grabber slot (Drawer.swift twin)
        }
        Column(Modifier.fillMaxWidth().padding(start = ElementDefaults.DRAWER_CONTENT_PAD_H.dp,
                                               end = ElementDefaults.DRAWER_CONTENT_PAD_H.dp,
                                               bottom = ElementDefaults.DRAWER_CONTENT_PAD_B.dp),
               verticalArrangement = Arrangement.spacedBy(ElementDefaults.DRAWER_CONTENT_SPACING.dp)) {
            SlotColumnNodes(ctx, defaultSlot(ctx))
        }
    }
}
