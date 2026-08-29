//
//  StackScroll.kt — the `<scroll>` COMPOSE ADAPTER (U01). Every decision lives in the shared
//  core (:core `despia.engine.ScrollCore`, corpus OpenSource/Conformance/scroll/); this file is
//  the Compose plumbing and nothing else: the declarative attributes as modifiers, one
//  snapshot-driven observer, the `--scroll-*` publication, the coalesced dispatch, and the
//  imperative surface behind `ref=`.
//
//  WHY THIS IS ITS OWN FILE. StackNodeView.kt is shared by every UI workstream, so its "scroll"
//  branch keeps its shape and calls in here; the call site is two lines and the implementation
//  is here where one owner can move it.
//
//  THE PUBLICATION IS UNCONDITIONAL AND THE DISPATCH IS NOT. `--scroll-*` is written on every
//  sample; `on:scroll` is gated on a bound handler and coalesced to the frame budget. That split
//  is the performance contract, and it is why a page with no scroll handler pays a map write.
//
//  THE OBSERVER IS A SNAPSHOT FLOW, NOT A LISTENER. `ScrollState.value` is a Compose state, so
//  `snapshotFlow` is the platform's own coalescing: it emits at most once per composition frame
//  and stops entirely when nothing collects. A `NestedScrollConnection` would see raw deltas
//  every touch event, which is the per-pixel dispatch U01 exists to make impossible.
//
package despia.engine.render

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import despia.engine.CollapseState
import despia.engine.NamedScrollPlane
import despia.engine.ScrollChildFrame
import despia.engine.ScrollConfig
import despia.engine.ScrollCore
import despia.engine.ScrollLinkedAncestor
import despia.engine.ScrollMetrics
import despia.engine.ScrollSample
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

/**
 * The `--scroll-*` publication plane. A node publishes only its own axis (the core's rule), and
 * a consumer resolves the properties in scope by walking its scroll ancestors nearest-first.
 *
 * The web gets this from the browser's custom-property cascade; Compose has no cascade, so the
 * walk is explicit and `ScrollCore.resolveLinkedScope` is the thing that answers — the same
 * function, the same corpus, on all three renderers.
 */
object StackScrollPlane {

    private data class Published(
        val axis: String,
        val properties: Map<String, String>,
        /** The node's `ref`, empty when it has none. */
        val ref: String,
        /** The same plane under that name, and DOCUMENT-WIDE (R27): pinned chrome sits OVER a
         *  scroller and can never be a descendant, so no cascade will ever reach it. */
        val named: Map<String, String>,
    )

    /** Insertion-ordered ON PURPOSE. Two nodes may carry one `ref` (the recycled-row case) and
     *  the ref registry gives the name to the LAST provider; merging named planes in registration
     *  order is that same law rather than a second opinion about it. */
    private val planes = LinkedHashMap<String, Published>()
    /** Child node id -> its scroll ancestors, nearest FIRST. Written as the tree composes. */
    private val chains = HashMap<String, List<String>>()

    @Synchronized
    fun publish(
        nodeId: String,
        axis: String,
        properties: Map<String, String>,
        ref: String = "",
        named: Map<String, String> = emptyMap(),
    ) {
        planes[nodeId] = Published(axis, properties, ref, named)
    }

    @Synchronized
    fun withdraw(nodeId: String) {
        planes.remove(nodeId)
        chains.entries.removeAll { it.value.contains(nodeId) }
    }

    /** Record which scroll nodes enclose [nodeId], nearest first. */
    @Synchronized
    fun link(nodeId: String, ancestorsNearestFirst: List<String>) {
        chains[nodeId] = ancestorsNearestFirst
    }

    /**
     * The properties in scope for [nodeId]: its ancestor cascade, plus EVERY named plane in the
     * document. An element with no scroll ancestor at all still reads a named plane, which is the
     * whole point of naming one — the chain lookup therefore cannot short-circuit on a missing
     * chain the way it used to.
     */
    @Synchronized
    fun scope(nodeId: String): Map<String, String> {
        val ancestors = (chains[nodeId] ?: emptyList()).mapNotNull { id ->
            planes[id]?.let { ScrollLinkedAncestor(it.axis, it.properties) }
        }
        val named = planes.values
            .filter { it.named.isNotEmpty() }
            .map { NamedScrollPlane(it.ref, it.named) }
        return ScrollCore.resolveLinkedScope(ancestors, named)
    }

    /**
     * Fold one authored declaration against the plane in scope. Null means the value is invalid
     * at computed value, which is CSS's own answer and therefore ours: the declaration is
     * DROPPED rather than shipped half-typed.
     */
    @Synchronized
    fun resolve(nodeId: String, expression: String): String? =
        ScrollCore.evaluateLinked(expression, scope(nodeId))

    @Synchronized
    fun reset() {
        planes.clear()
        chains.clear()
    }
}

/**
 * One `<scroll>`'s presenter: samples in, publication and dispatch out.
 *
 * Deliberately free of Compose and Android types so it is JUnit-testable on the JVM alongside
 * the core it drives — the Compose half below is thirty lines of wiring, and thirty lines is
 * what should be left untested when a device is not available.
 */
class StackScrollObserver(
    val nodeId: String,
    val config: ScrollConfig,
    /** The node's `ref`. It names the plane this scroller publishes at document root, so anything
     *  in the tree can read it - including the pinned chrome that is not a descendant. */
    val ref: String = "",
    private val hasHandler: (String) -> Boolean,
    private val dispatch: (String, Map<String, Any?>) -> Unit,
    private val writeBind: ((String, Map<String, Any?>) -> Unit)? = null,
) {
    private var lastSample: ScrollSample? = null
    private var lastDirection: String? = null
    private var lastDispatchAt: Double? = null
    private var reachLatched = false
    private var anchorBefore: Double? = null

    /** One sample. Publication first and always; dispatch second and only under the budget. */
    fun sample(
        offset: Double,
        viewport: Double,
        content: Double,
        nowMs: Double,
        crossOffset: Double = 0.0,
        crossViewport: Double = 0.0,
        crossContent: Double = 0.0,
    ): ScrollMetrics {
        val horizontal = config.axis == "horizontal"
        val m = ScrollCore.metrics(
            x = if (horizontal) offset else crossOffset,
            y = if (horizontal) crossOffset else offset,
            viewportWidth = if (horizontal) viewport else crossViewport,
            viewportHeight = if (horizontal) crossViewport else viewport,
            contentWidth = if (horizontal) content else crossContent,
            contentHeight = if (horizontal) crossContent else content,
        )
        val next = ScrollSample(m.x, m.y, nowMs)
        val motion = lastSample?.let { ScrollCore.motion(it, next, lastDirection) }
        lastSample = next
        val velocity = motion?.velocity ?: 0.0
        lastDirection = motion?.direction ?: lastDirection

        StackScrollPlane.publish(
            nodeId, config.axis,
            ScrollCore.linkedProperties(config.axis, m, velocity),
            ref = ref,
            named = if (ref.isEmpty()) emptyMap()
                    else ScrollCore.namedLinkedProperties(ref, config.axis, m, velocity),
        )

        config.bind?.let { path -> writeBind?.invoke(path, mapOf("x" to m.x, "y" to m.y)) }

        if (ScrollCore.shouldDispatch(hasHandler("scroll"), lastDispatchAt, nowMs)) {
            lastDispatchAt = nowMs
            dispatch(
                "scroll",
                mapOf(
                    "x" to m.x, "y" to m.y,
                    "dx" to (motion?.dx ?: 0.0), "dy" to (motion?.dy ?: 0.0),
                    "width" to (if (horizontal) viewport else crossViewport),
                    "height" to (if (horizontal) crossViewport else viewport),
                    "contentWidth" to (if (horizontal) content else crossContent),
                    "contentHeight" to (if (horizontal) crossContent else content),
                    "atTop" to m.atTop, "atBottom" to m.atBottom,
                    "direction" to (lastDirection ?: "none"), "velocity" to velocity,
                ),
            )
        }

        val reach = ScrollCore.reachEnd(reachLatched, m, config.threshold, config.axis)
        reachLatched = reach.latched
        if (reach.fire && hasHandler("reachEnd")) {
            dispatch("reachEnd", mapOf("remaining" to reach.remaining))
        }
        return m
    }

    /**
     * Deceleration finished. Compose reports `isScrollInProgress`, which IS the real
     * end-of-scroll signal, so unlike the web this renderer never guesses at a settle window.
     */
    fun settle(
        offset: Double,
        viewport: Double,
        content: Double,
        children: List<ScrollChildFrame>,
    ): Double? {
        val m = ScrollCore.metrics(
            x = if (config.axis == "horizontal") offset else 0.0,
            y = if (config.axis == "horizontal") 0.0 else offset,
            viewportWidth = if (config.axis == "horizontal") viewport else 0.0,
            viewportHeight = if (config.axis == "horizontal") 0.0 else viewport,
            contentWidth = if (config.axis == "horizontal") content else 0.0,
            contentHeight = if (config.axis == "horizontal") 0.0 else content,
        )
        if (hasHandler("scrollEnd")) {
            dispatch(
                "scrollEnd",
                mapOf("x" to m.x, "y" to m.y, "atTop" to m.atTop, "atBottom" to m.atBottom),
            )
        }
        // At rest the snap decision is the AT-REST one; feeding the last velocity would re-apply
        // a fling Compose's own decay has already spent.
        return ScrollCore.resolveSnap(config.snap, offset, viewport, content, children, 0.0)
    }

    /**
     * `maintainPosition`. Call BEFORE the mutation with a still-visible child, and again after.
     * An anchor rather than a content-height delta is the whole design: a height diff cannot
     * tell a prepend from an append, so compensating on it makes an appending chat jump exactly
     * as badly as a prepending one failed to.
     */
    fun captureAnchor(anchorOffset: Double) {
        anchorBefore = anchorOffset
    }

    fun restoreAnchor(anchorOffset: Double, offset: Double, viewport: Double, content: Double): Double? {
        if (!config.maintainPosition) return null
        val before = anchorBefore ?: return null
        anchorBefore = null
        val result = ScrollCore.maintainPosition(offset, before, anchorOffset, viewport, content)
        return if (result.delta == 0.0) null else result.offset
    }

    /** The imperative surface: `dsx.scroll(ref).to / .toTop / .toBottom / .toElement`. */
    fun command(
        kind: String,
        offset: Double,
        viewport: Double,
        content: Double,
        toX: Double? = null,
        toY: Double? = null,
        child: ScrollChildFrame? = null,
        align: String = "nearest",
        animated: Boolean = true,
    ): Double? {
        val horizontal = config.axis == "horizontal"
        val m = ScrollCore.metrics(
            x = if (horizontal) offset else 0.0,
            y = if (horizontal) 0.0 else offset,
            viewportWidth = if (horizontal) viewport else 0.0,
            viewportHeight = if (horizontal) 0.0 else viewport,
            contentWidth = if (horizontal) content else 0.0,
            contentHeight = if (horizontal) 0.0 else content,
        )
        val target = ScrollCore.resolveCommand(
            kind = kind, m = m,
            viewportWidth = if (horizontal) viewport else 0.0,
            viewportHeight = if (horizontal) 0.0 else viewport,
            axis = config.axis, animated = animated,
            toX = toX, toY = toY, child = child, align = align,
        ) ?: return null
        return if (horizontal) target.x else target.y
    }
}

/**
 * The named-scroll table. The NAME comes from `ref=` and resolves through the ONE registry
 * `StackRef` publishes into — this map is keyed by the same node id, never by a second name
 * table of its own.
 */
object StackScroll {

    private val observers = HashMap<String, StackScrollObserver>()
    private val states = HashMap<String, ScrollState>()

    @Synchronized
    fun attach(nodeId: String, observer: StackScrollObserver, state: ScrollState) {
        observers[nodeId] = observer
        states[nodeId] = state
    }

    @Synchronized
    fun detach(nodeId: String) {
        observers.remove(nodeId)
        states.remove(nodeId)
        StackScrollPlane.withdraw(nodeId)
    }

    @Synchronized
    fun observer(nodeId: String): StackScrollObserver? = observers[nodeId]

    @Synchronized
    fun state(nodeId: String): ScrollState? = states[nodeId]

    @Synchronized
    fun reset() {
        observers.clear()
        states.clear()
    }
}

/**
 * THE CALL SITE. From StackNodeView.kt's "scroll" branch:
 *
 *   val scroll = rememberScrollState()
 *   val observer = rememberStackScroll(node.key, a, scroll, ...)
 *   Column(m.verticalScroll(scroll).stackScroll(observer)) { … }
 *
 * `rememberScrollState()` stays in the branch because the Column needs it; everything U01 adds
 * rides the two lines here.
 */
@Composable
fun rememberStackScroll(
    nodeId: String,
    attributes: Map<String, String?>,
    state: ScrollState,
    hasHandler: (String) -> Boolean,
    dispatch: (String, Map<String, Any?>) -> Unit,
    writeBind: ((String, Map<String, Any?>) -> Unit)? = null,
): StackScrollObserver {
    val config = remember(attributes) { ScrollCore.parseConfig(attributes) }
    val ref = remember(attributes) { attributes["ref"]?.trim().orEmpty() }
    val observer = remember(nodeId, config, ref) {
        StackScrollObserver(nodeId, config, ref, hasHandler, dispatch, writeBind)
    }
    val density = LocalDensity.current
    LaunchedEffect(observer, state) {
        StackScroll.attach(nodeId, observer, state)
        // snapshotFlow IS the coalescing: at most one emission per frame, and none at all when
        // nothing is scrolling. The core's own budget then decides whether a sample DISPATCHES.
        snapshotFlow { Triple(state.value, state.viewportSize, state.maxValue) }
            .onEach { sample ->
                val offset = with(density) { sample.first.toDp().value.toDouble() }
                val viewport = with(density) { sample.second.toDp().value.toDouble() }
                val content = with(density) { (sample.second + sample.third).toDp().value.toDouble() }
                observer.sample(offset, viewport, content, System.nanoTime() / 1_000_000.0)
            }
            .launchIn(this)
    }
    LaunchedEffect(observer, state.isScrollInProgress) {
        if (!state.isScrollInProgress && state.value > 0) {
            val viewport = with(density) { state.viewportSize.toDp().value.toDouble() }
            val offset = with(density) { state.value.toDp().value.toDouble() }
            val content = with(density) { (state.viewportSize + state.maxValue).toDp().value.toDouble() }
            val target = observer.settle(offset, viewport, content, emptyList())
            // `snap` to child boundaries needs real child frames, which the caller supplies from
            // its own layout pass; with none we announce the end and move nothing, which is the
            // honest answer rather than a snap to a guessed stride.
            if (target != null && config.snap == "page") {
                state.animateScrollTo(with(density) { Dp(target.toFloat()).roundToPx() })
            }
        }
    }
    return observer
}

/** `contentInset` — the one declarative attribute Compose expresses as a modifier rather than
 *  as a scroll-state property. Zero insets add no node at all. */
fun Modifier.stackScrollInsets(config: ScrollConfig): Modifier {
    val inset = config.contentInset
    if (inset.top == 0.0 && inset.right == 0.0 && inset.bottom == 0.0 && inset.left == 0.0) return this
    return this.padding(
        start = inset.left.dp,
        top = inset.top.dp,
        end = inset.right.dp,
        bottom = inset.bottom.dp,
    )
}

/**
 * `<CollapsingHeader>` (U10) reads the same plane. Exposed here rather than in the component so
 * the header and the scroll view cannot drift on which offset they mean.
 */
fun collapseFor(nodeId: String, scrollY: Double, height: Double, minHeight: Double): CollapseState =
    ScrollCore.collapse(scrollY = scrollY, height = height, minHeight = minHeight).also {
        StackScrollPlane.publish(
            nodeId, "vertical",
            mapOf("--collapse-fraction" to ScrollCore.formatNumber(it.fraction)),
        )
    }
