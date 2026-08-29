//
//  DesktopFlexLayout.kt — the CSS-faithful container measure policy of the desktop
//  renderer. The web renderer's flex model is the parity contract's reference plane
//  (OpenSource/Conformance/layout/flex-semantics.json + the browser-leg mirrors in
//  ClosedSource/scripts/dsxcss/fixtures 08–17); Compose's own Column/Row diverge from
//  it in exactly the ways the W17 capture measured: weighted children inflate hugging
//  containers, cross-stretch (`align-items: stretch` and the skin's stretch laws) is
//  inexpressible, percent/stretch controls force-fill instead of stretching to the
//  settled content size, and a grown child can never clamp under its own max-width.
//  This Layout implements the CSS algorithm directly:
//
//    hug     the container's cross size settles from plain children's measured sizes
//            plus stretch children's max-content contributions (intrinsics; the
//            element-law controls contribute their declared minimum, percent children
//            contribute nothing — fixtures 11/12 pin both)
//    stretch children then measure TIGHT at the settled cross size; grow children
//            measure loose against it so their own fill/clamp modifiers resolve
//    spacers (flex 1 1 0) absorb main-axis extra ONLY when the container's main size
//            is definite (tight constraints); otherwise they are zero
//    place   main axis stacks with the authored gap; cross placement is the
//            container's align-items word, overridden per child by its align-self
//
//  Child facts arrive as parent data (DesktopNode attaches them from its RESOLVED
//  attrs through :core LayoutSemantics — the corpus-gated decision table), so the
//  policy holds no per-tag knowledge.
//

package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import despia.engine.JSE

/** One flex child's authored facts, resolved by DesktopNode (LayoutSemantics decisions). */
internal class DsxFlexChildData(
    /** Canonical `align-self` word (start/center/end/stretch) or null. */
    val selfAlign: String?,
    /** Would this child stretch on that axis if its container stretches children?
     * False when the axis carries an explicit size or a grow. */
    val fillsWidthIfStretched: Boolean,
    val fillsHeightIfStretched: Boolean,
    /** The skin's element law (`.dsx-progress`/`.dsx-slider`): stretch the width in a
     * vertical stack, contributing only [minCrossDp] to a hugging container. */
    val elementStretchWidth: Boolean = false,
    val minCrossDp: Float = 0f,
    /** The skin's stack laws (globals.ts): fields and pressable rows stretch in a
     * vertical stack at every width; buttons, forms and nested vertical stacks join
     * below the 48rem compact step. These contribute their max-content to a hug. */
    val lawStretchWidth: Boolean = false,
    /** `.dsx-stack > .dsx-scroll:only-child { align-self: stretch }`. */
    val stretchWhenOnlyChild: Boolean = false,
    /** width:100% / height:100% — the child's own modifiers fill and clamp; the
     * container offers the settled content size and keeps the child out of the hug. */
    val growWidth: Boolean = false,
    val growHeight: Boolean = false,
    /** Bare `<spacer>` axes: flex 1 1 0 — absorbs extra main space, else zero. */
    val spacerAutoWidth: Boolean = false,
    val spacerAutoHeight: Boolean = false,
    /** `flex: N` — the child absorbs a share of the definite main axis (basis 0);
     * in a hugging container it sizes by content (fixture 14). */
    val flexGrow: Float = 0f,
    /** An authored explicit width/height. CSS gives such a child NO automatic
     * minimum beyond its content (an empty sized box shrinks to zero), while a
     * Compose size modifier reports its fixed size as the min intrinsic — the
     * shrink floor must ignore it (fixture 16). */
    val sizedWidth: Boolean = false,
    val sizedHeight: Boolean = false,
    /** CSS margins (dp; may be NEGATIVE — the list-row bleed). Space OUTSIDE the box:
     * the flow advances by them, a stretch child's tight cross excludes them, and the
     * reported box never includes them (fixture 13). */
    val marginLeftDp: Float = 0f,
    val marginTopDp: Float = 0f,
    val marginRightDp: Float = 0f,
    val marginBottomDp: Float = 0f,
)

private class DsxFlexChildElement(val data: DsxFlexChildData) : ParentDataModifier {
    override fun Density.modifyParentData(parentData: Any?): Any = data
}

internal fun Modifier.dsxFlexChild(data: DsxFlexChildData): Modifier =
    this.then(DsxFlexChildElement(data))

/** The container composable: `horizontal=false` is the stack/scroll column,
 * `horizontal=true` the hstack row. [crossAlign] is the container's resolved
 * align-items word; [crossStretch] its LayoutSemantics.crossStretch decision. */
@Composable
internal fun DsxFlex(
    modifier: Modifier,
    horizontal: Boolean,
    spacingDp: Float,
    crossAlign: String,
    crossStretch: Boolean,
    content: @Composable () -> Unit,
) {
    val policy = androidx.compose.runtime.remember(horizontal, spacingDp, crossAlign, crossStretch) {
        dsxFlexMeasurePolicy(horizontal, spacingDp, crossAlign, crossStretch)
    }
    Layout(content, modifier, policy)
}

private fun flexData(m: IntrinsicMeasurable): DsxFlexChildData? = m.parentData as? DsxFlexChildData

internal fun dsxFlexMeasurePolicy(
    horizontal: Boolean,
    spacingDp: Float,
    crossAlign: String,
    crossStretch: Boolean,
): MeasurePolicy = MeasurePolicy { measurables, constraints ->
    val spacing = spacingDp.dp.roundToPx().coerceAtLeast(0)
    val mainMax = if (horizontal) constraints.maxWidth else constraints.maxHeight
    val mainMin = if (horizontal) constraints.minWidth else constraints.minHeight
    val crossMax = if (horizontal) constraints.maxHeight else constraints.maxWidth
    val crossMin = if (horizontal) constraints.minHeight else constraints.minWidth
    val mainBounded = if (horizontal) constraints.hasBoundedWidth else constraints.hasBoundedHeight
    val crossBounded = if (horizontal) constraints.hasBoundedHeight else constraints.hasBoundedWidth
    val mainTight = mainBounded && mainMin == mainMax
    val crossTight = crossBounded && crossMin == crossMax

    fun isSpacer(d: DsxFlexChildData?): Boolean =
        d != null && (if (horizontal) d.spacerAutoWidth else d.spacerAutoHeight)
    fun isFlexMain(d: DsxFlexChildData?): Boolean = d != null && d.flexGrow > 0f && !isSpacer(d)
    fun isGrow(d: DsxFlexChildData?): Boolean =
        d != null && (if (horizontal) d.growWidth else d.growHeight)
    fun crossMarginStart(d: DsxFlexChildData?): Int =
        (if (horizontal) d?.marginTopDp else d?.marginLeftDp)?.dp?.roundToPx() ?: 0
    fun crossMarginEnd(d: DsxFlexChildData?): Int =
        (if (horizontal) d?.marginBottomDp else d?.marginRightDp)?.dp?.roundToPx() ?: 0
    fun mainMarginStart(d: DsxFlexChildData?): Int =
        (if (horizontal) d?.marginLeftDp else d?.marginTopDp)?.dp?.roundToPx() ?: 0
    fun mainMarginEnd(d: DsxFlexChildData?): Int =
        (if (horizontal) d?.marginRightDp else d?.marginBottomDp)?.dp?.roundToPx() ?: 0

    /** The child's cross-axis resolution. Precedence pins the skin's own ordering:
     * an explicit size or grow opts out, an authored align-self always wins, then
     * the element/stack laws (vertical stacks only), then the container default. */
    fun stretches(d: DsxFlexChildData?): Boolean {
        if (d == null) return crossStretch
        val auto = if (horizontal) d.fillsHeightIfStretched else d.fillsWidthIfStretched
        if (!auto) return false
        when (d.selfAlign) {
            "stretch" -> return true
            null -> {}
            else -> return false
        }
        if (isSpacer(d) || (if (horizontal) d.spacerAutoHeight else d.spacerAutoWidth)) return true
        if (!horizontal) {
            if (d.elementStretchWidth) return true
            if (d.lawStretchWidth) return true
            if (d.stretchWhenOnlyChild && measurables.size == 1) return true
        }
        return crossStretch
    }

    // flex-shrink (the CSS default 1 — fixture 16): when the children's flex bases
    // overflow a bounded main axis, each child gives up main space in proportion to
    // its base, floored at its min-content (CSS freezing). Bases are auto
    // (max-content, via intrinsics — every child is still MEASURED exactly once,
    // with its shrunk target as the loose main maximum); a grow (percent) child's
    // base is 100% of a DEFINITE main axis, which is how the web resolves a
    // width:100% row member down to the space its siblings leave. Spacers/flex:N
    // (weighted) children resolve against the settled axis and never shrink.
    val mainCaps = IntArray(measurables.size) { -1 }
    // A hugging container CLAMPED by its bound is definite at that bound (CSS
    // fit-content = min(max-content, available)) - its weighted children then absorb
    // the leftover exactly as under tight constraints (fixture 17), instead of
    // content-sizing as in a free hug (fixture 14).
    var definiteClamp = false
    if (mainBounded) {
        var total = (measurables.size - 1).coerceAtLeast(0) * spacing
        var weightedContent = 0
        val base = IntArray(measurables.size) { -1 }
        val floor = IntArray(measurables.size)
        measurables.forEachIndexed { i, m ->
            val d = flexData(m)
            total += mainMarginStart(d) + mainMarginEnd(d)
            if (isSpacer(d)) return@forEachIndexed
            if (isFlexMain(d)) {
                weightedContent += runCatching {
                    if (horizontal) m.maxIntrinsicWidth(crossMax) else m.maxIntrinsicHeight(crossMax)
                }.getOrDefault(0)
                return@forEachIndexed
            }
            if (isGrow(d)) {
                if (!mainTight) {
                    // Hug (fit-content) container: a grow child is flex-grow:1/basis
                    // auto on the web, so it contributes and settles at max-content —
                    // the cap keeps the fill modifier inside it from tiling the whole
                    // bound across every cell (fixture 18, the studio toolbar law).
                    mainCaps[i] = runCatching {
                        if (horizontal) m.maxIntrinsicWidth(crossMax) else m.maxIntrinsicHeight(crossMax)
                    }.getOrDefault(0)
                    return@forEachIndexed
                }
                base[i] = mainMax
            } else {
                base[i] = runCatching {
                    if (horizontal) m.maxIntrinsicWidth(crossMax) else m.maxIntrinsicHeight(crossMax)
                }.getOrDefault(0)
            }
            val sized = if (horizontal) d?.sizedWidth == true else d?.sizedHeight == true
            floor[i] = if (sized) 0 else runCatching {
                if (horizontal) m.minIntrinsicWidth(crossMax) else m.minIntrinsicHeight(crossMax)
            }.getOrDefault(0).coerceAtMost(base[i])
            total += base[i]
        }
        definiteClamp = !mainTight && total + weightedContent > mainMax
        var overflow = total - mainMax
        if (overflow > 0) {
            val active = base.indices.filter { base[it] > 0 }.toMutableList()
            var rounds = active.size + 1
            while (overflow > 0 && active.isNotEmpty() && rounds-- > 0) {
                val totalBasis = active.sumOf { base[it].toLong() }
                if (totalBasis <= 0L) break
                val frozen = active.filter { i ->
                    base[i] - overflow.toLong() * base[i] / totalBasis < floor[i]
                }
                if (frozen.isNotEmpty()) {
                    frozen.forEach { i ->
                        mainCaps[i] = floor[i]
                        overflow -= base[i] - floor[i]
                        active.remove(i)
                    }
                    continue
                }
                var distributed = 0
                active.forEachIndexed { k, i ->
                    val cut = if (k == active.size - 1) (overflow - distributed).coerceIn(0, base[i])
                    else (overflow.toLong() * base[i] / totalBasis).toInt()
                    distributed += cut
                    mainCaps[i] = base[i] - cut
                }
                break
            }
        }
    }
    fun mainCap(index: Int): Int = if (mainCaps[index] < 0) mainMax else minOf(mainCaps[index], mainMax)

    val placeables = arrayOfNulls<Placeable>(measurables.size)
    val passTwo = ArrayList<Int>()
    var contentCross = 0

    measurables.forEachIndexed { index, measurable ->
        val d = flexData(measurable)
        if (isSpacer(d) || isFlexMain(d) || isGrow(d) || stretches(d)) {
            passTwo.add(index)
            return@forEachIndexed
        }
        val crossMargins = crossMarginStart(d) + crossMarginEnd(d)
        val childCrossMax = if (crossBounded) (crossMax - crossMargins).coerceAtLeast(0) else crossMax
        val child = measurable.measure(
            if (horizontal) Constraints(0, mainCap(index), 0, childCrossMax)
            else Constraints(0, childCrossMax, 0, mainCap(index)),
        )
        placeables[index] = child
        contentCross = maxOf(contentCross, (if (horizontal) child.height else child.width) + crossMargins)
    }

    // A hugging container settles its cross size from stretch children's max-content
    // contributions too (fixture 12). The element-law controls contribute only their
    // declared minimum (fixture 11); percent (grow) children and spacers contribute
    // nothing. Lazy containers refuse intrinsic measurement by design — they fall
    // back to the declared minimum.
    if (!crossTight) {
        for (index in passTwo) {
            val measurable = measurables[index]
            val d = flexData(measurable)
            if (isSpacer(d)) continue
            val minPx = (d?.minCrossDp ?: 0f).dp.roundToPx()
            val contribution = if (d?.elementStretchWidth == true) minPx else {
                val intrinsic = runCatching {
                    if (horizontal) measurable.maxIntrinsicHeight(mainMax)
                    else measurable.maxIntrinsicWidth(mainMax)
                }.getOrDefault(0)
                maxOf(intrinsic, minPx) + crossMarginStart(d) + crossMarginEnd(d)
            }
            contentCross = maxOf(contentCross, contribution)
        }
    }

    val crossSize = (if (crossTight) crossMax else maxOf(contentCross, crossMin))
        .coerceAtMost(if (crossBounded) crossMax else Int.MAX_VALUE)

    // Pass 2a: stretch and grow children — tight (stretch, margins excluded) or
    // loose-to-content (grow) on the cross axis; main sizes join the content total.
    for (index in passTwo) {
        val measurable = measurables[index]
        val d = flexData(measurable)
        if (isSpacer(d) || isFlexMain(d)) continue
        val tightCross = !isGrow(d)
        val stretchCrossSize = (crossSize - crossMarginStart(d) - crossMarginEnd(d)).coerceAtLeast(0)
        val childConstraints = if (horizontal) {
            Constraints(0, mainCap(index), if (tightCross) stretchCrossSize else 0, if (tightCross) stretchCrossSize else crossSize)
        } else {
            Constraints(if (tightCross) stretchCrossSize else 0, if (tightCross) stretchCrossSize else crossSize, 0, mainCap(index))
        }
        placeables[index] = measurable.measure(childConstraints)
    }

    var contentMain = 0
    placeables.forEachIndexed { index, p ->
        if (p != null) {
            val d = flexData(measurables[index])
            contentMain += (if (horizontal) p.width else p.height) + mainMarginStart(d) + mainMarginEnd(d)
        }
    }
    val gaps = (measurables.size - 1).coerceAtLeast(0) * spacing
    contentMain += gaps

    // Pass 2b: spacers and flex:N children absorb extra main space only when the main
    // size is definite (basis 0); in a hugging container a flex child sizes by content
    // and a spacer is zero (fixture 14 / fixture 10).
    val weighted = passTwo.filter { isSpacer(flexData(measurables[it])) || isFlexMain(flexData(measurables[it])) }
    val totalWeight = weighted.sumOf { index ->
        val d = flexData(measurables[index])
        (if (isSpacer(d)) 1f else d?.flexGrow ?: 1f).toDouble()
    }.toFloat()
    val extra = if (mainTight || definiteClamp) (mainMax - contentMain).coerceAtLeast(0) else 0
    var distributed = 0
    weighted.forEachIndexed { k, index ->
        val d = flexData(measurables[index])
        val weight = if (isSpacer(d)) 1f else d?.flexGrow ?: 1f
        val share = if (totalWeight <= 0f) 0
        else if (k == weighted.size - 1) extra - distributed
        else (extra * (weight / totalWeight)).toInt()
        distributed += share
        val stretchesCross = stretches(d)
        val crossTightSize = (crossSize - crossMarginStart(d) - crossMarginEnd(d)).coerceAtLeast(0)
        val childConstraints = if (!mainTight && !definiteClamp && isFlexMain(d)) {
            // free hug container: flex children size by content on the main axis
            if (horizontal) Constraints(0, mainMax, if (stretchesCross) crossTightSize else 0, if (stretchesCross) crossTightSize else crossSize)
            else Constraints(if (stretchesCross) crossTightSize else 0, if (stretchesCross) crossTightSize else crossSize, 0, mainMax)
        } else if (horizontal) {
            Constraints(share, share, if (stretchesCross) crossTightSize else 0, if (stretchesCross) crossTightSize else crossSize)
        } else {
            Constraints(if (stretchesCross) crossTightSize else 0, if (stretchesCross) crossTightSize else crossSize, share, share)
        }
        val placed = measurables[index].measure(childConstraints)
        placeables[index] = placed
        contentMain += if (horizontal) placed.width else placed.height
    }

    val mainSize = if (mainTight) mainMax
    else contentMain.coerceIn(mainMin, if (mainBounded) mainMax else Int.MAX_VALUE)

    layout(
        if (horizontal) mainSize else crossSize,
        if (horizontal) crossSize else mainSize,
    ) {
        var cursor = 0
        placeables.forEachIndexed { index, placeable ->
            if (placeable == null) return@forEachIndexed
            val d = flexData(measurables[index])
            val childCross = if (horizontal) placeable.height else placeable.width
            val mStart = crossMarginStart(d)
            val mEnd = crossMarginEnd(d)
            val word = d?.selfAlign?.takeIf { it != "stretch" }
                ?: if (stretches(d)) "start" else crossAlign
            val crossOffset = when (word) {
                "center" -> mStart + ((crossSize - mStart - mEnd - childCross) / 2).coerceAtLeast(0)
                "end" -> crossSize - mEnd - childCross
                else -> mStart
            }
            cursor += mainMarginStart(d)
            if (horizontal) placeable.placeRelative(cursor, crossOffset)
            else placeable.placeRelative(crossOffset, cursor)
            cursor += (if (horizontal) placeable.width else placeable.height) + mainMarginEnd(d) + spacing
        }
    }
}

/**
 * `<flow>` on the desktop: the greedy wrap packer, and the repeater that drives it.
 *
 * TWO THINGS LANDED HERE ON 2026-08-26, and the first was a bug found by the second. The
 * desktop `<flow>` used to fall through to the `"hstack", "toolbar", "flow"` arm, which is a
 * plain horizontal flex: it did not WRAP, which is the element's entire definition and the one
 * thing the web (`flex-wrap: wrap`) and `:render` (the FlowLayout greedy packer) both do. The
 * math below is that packer, transcribed - ideal sizes first, break on overflow, place - so the
 * three renderers agree by construction rather than by intent.
 *
 * The second is `bind` (runtime-pressure R29): the wrap layout was the only layout with no
 * repeater. A bound flow repeats its single child template per row and an unbound one lays out
 * its authored children; the packer never learns which, because the rows ARE the measurables.
 */
@Composable
internal fun DesktopFlow(context: DesktopElementContext, modifier: Modifier) {
    val spacing = dimension(context.attributes["spacing"], 8f)
    val lineSpacing = dimension(context.attributes["lineSpacing"], 8f)
    val bindKey = context.attributes["bind"]
    val template = if (bindKey != null) context.node.children.firstOrNull() else null

    val content: @Composable () -> Unit = {
        if (bindKey != null && template != null) {
            for (row in desktopFlowRows(context, bindKey)) {
                DesktopNode(template, context.store, context.runner, row, context.components)
            }
        } else {
            context.Children()
        }
    }

    Layout(content, modifier) { measurables, constraints ->
        val gap = spacing * density
        val lineGap = lineSpacing * density
        val maxW = if (constraints.hasBoundedWidth) constraints.maxWidth else Int.MAX_VALUE
        val placeables = measurables.map { it.measure(Constraints(maxWidth = maxW)) }

        var rowW = 0f
        var rowH = 0f
        var totalW = 0f
        var totalH = 0f
        for (p in placeables) {
            if (rowW > 0f && rowW + gap + p.width > maxW) {
                totalW = maxOf(totalW, rowW); totalH += rowH + lineGap; rowW = 0f; rowH = 0f
            }
            rowW += (if (rowW > 0f) gap else 0f) + p.width
            rowH = maxOf(rowH, p.height.toFloat())
        }
        totalW = maxOf(totalW, rowW)
        totalH += rowH

        val width = totalW.toInt().coerceIn(
            constraints.minWidth,
            if (constraints.hasBoundedWidth) constraints.maxWidth else Int.MAX_VALUE,
        )
        val height = totalH.toInt().coerceAtLeast(constraints.minHeight)
        layout(width, height) {
            var x = 0f
            var y = 0f
            var lineH = 0f
            var rowStart = true
            for (p in placeables) {
                if (!rowStart && x + gap + p.width > maxW) {
                    x = 0f; y += lineH + lineGap; lineH = 0f; rowStart = true
                }
                if (!rowStart) x += gap
                p.placeRelative(x.toInt(), y.toInt())
                x += p.width
                lineH = maxOf(lineH, p.height.toFloat())
                rowStart = false
            }
        }
    }
}

/** The bound rows, capped the way every other desktop collection caps them. */
private fun desktopFlowRows(
    context: DesktopElementContext, bindKey: String,
): List<Map<String, Any?>> {
    val raw = JSE.eval(bindKey, context.store, context.item)
    val source = raw as? List<*> ?: return emptyList()
    val inspected = minOf(source.size, MAX_DESKTOP_BOUND_ROWS)
    val out = ArrayList<Map<String, Any?>>(inspected)
    for (index in 0 until inspected) {
        when (val value = source[index]) {
            is Map<*, *> -> out.add(
                value.entries.asSequence().filter { it.key is String }
                    .take(256).associate { it.key as String to it.value },
            )
            null -> Unit
            else -> out.add(mapOf("value" to value, "index" to index))
        }
    }
    return out
}
