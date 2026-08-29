//
//  ParityCapture.kt — the NATIVE CAPTURE seam of the parity contract
//  (OpenSource/Conformance/parity/README.md, "The native capture planes"). The
//  instrumentation harness (ParityCaptureInstrumentedTest) arms a Session around a
//  fixture render; `Modifier.decorate` consults it once per attached element chain, so
//  every authored element that materializes reports its settled geometry + the style
//  facts the resolver produced for it. Disarmed (session == null — every production
//  render), the cost is one @Volatile null read per element and nothing composes.
//
//  The capture is keyed by SOURCE IDENTITY: a Session indexes the parsed fixture tree
//  by object identity, so only the fixture's own authored nodes record (component
//  internals and synthetic nodes fall out naturally — they are platform anatomy, out of
//  the comparable set by the README's alignment rule). A node that renders more than
//  once (list/grid rows re-render one template per row) records one entry per attached
//  chain; the emitter orders repeats by position and suffixes the path (`0.3.0~1`).
//

package despia.engine.render

import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import despia.engine.StackNode
import java.util.IdentityHashMap
import java.util.concurrent.ConcurrentHashMap

object ParityCapture {

    /** Head/declaration tags: registered, never boxed — the web plane has no host node
     * for them either. */
    val declarationTags: Set<String> = setOf(
        "head", "event", "expects", "action", "api", "variable", "var", "let",
        "component", "formula", "script", "functions", "style", "watch", "attribute",
        "slot",
    )

    /** The armed session, set ONLY by the capture harness around a fixture render. */
    @Volatile var session: Session? = null

    /** One attached element chain's settled report. Geometry is window px (translated
     * to plane CSS px at emit); style facts resolved at composition time, under the
     * pass's committed scheme. */
    class Record(
        val node: StackNode,
        val x: Float, val y: Float, val w: Float, val h: Float,
        val radius: Double,
        val color: Color, val background: Color,
        val fontSize: Double?, val fontWeight: String?, val lineHeight: Double?,
    )

    /** One measured node of the emitted plane — the web NodeMetrics twin, colors kept
     * as resolved Compose colors so the harness can pair a light and a dark pass. */
    class Measured(
        val path: String,
        val tag: String,
        val box: DoubleArray,
        val radius: String,
        val color: Color,
        val background: Color,
        val text: TextMetrics?,
    )

    class TextMetrics(val size: String?, val weight: String?, val line: String?)

    class Session(root: StackNode) {
        private val paths = IdentityHashMap<StackNode, String>()
        private val records = ConcurrentHashMap<Any, Record>()

        init {
            fun index(node: StackNode, path: String) {
                paths[node] = path
                node.children.forEachIndexed { i, child ->
                    index(child, "$path.$i")
                }
            }
            index(root, "0")
        }

        internal fun capturesNode(node: StackNode): Boolean =
            node.tag !in declarationTags && paths.containsKey(node)

        /** The capture arm of the element chain — leftmost in decorate, so the reported
         * bounds are the element's full styled box (the web getBoundingClientRect twin,
         * modulo the gap-ledger rows). Colors resolve HERE, inside composition, so the
         * pass's committed scheme (StackTheme.WithCompositionScheme) answers exactly
         * what the style engine painted. `attrs` is the RESOLVED map (the full DSX-CSS
         * cascade already ran), so radius/font facts are the resolver's own numbers. */
        internal fun modifier(node: StackNode, attrs: Map<String, String>): Modifier =
            Modifier.composed {
                val slot = remember { Any() }
                val background = attrs["background"]?.let { StackStyle.color(it) } ?: Color.Transparent
                val color = attrs["color"]?.let { StackStyle.color(it) } ?: StackStyle.color("label")
                val radius = attrs["radius"]?.toDoubleOrNull() ?: 0.0
                val fontSize = if (node.tag == "text") attrs["fontSize"]?.toDoubleOrNull() else null
                val fontWeight = if (node.tag == "text") attrs["fontWeight"] else null
                val lineHeight = fontSize?.let { fs -> attrs["lineSpacing"]?.toDoubleOrNull()?.let { fs + it } }
                Modifier.onGloballyPositioned { coords ->
                    val p = coords.positionInRoot()
                    records[slot] = Record(
                        node, p.x, p.y,
                        coords.size.width.toFloat(), coords.size.height.toFloat(),
                        radius, color, background, fontSize, fontWeight, lineHeight,
                    )
                }
            }

        /** Collapse the recorded chains into the ordered node list: source pre-order,
         * repeats ordered by (y, x) with a `~k` appearance suffix. `origin` and
         * `density` translate window px into the plane's CSS-px coordinates. */
        fun measured(origin: Offset, density: Float): List<Measured> {
            fun cssPx(v: Float): Double = Math.round(v.toDouble() / density * 100.0) / 100.0
            val byNode = HashMap<StackNode, MutableList<Record>>()
            for (r in records.values) byNode.getOrPut(r.node) { mutableListOf() }.add(r)
            val out = ArrayList<Measured>()
            for ((node, list) in byNode) {
                val path = paths[node] ?: continue
                list.sortWith(compareBy({ it.y }, { it.x }))
                // An element whose chain attached twice reports one duplicate box —
                // keep distinct boxes only (real repeats occupy distinct positions).
                val distinct = list.distinctBy { listOf(it.x, it.y, it.w, it.h) }
                distinct.forEachIndexed { k, r ->
                    val text = if (node.tag == "text") TextMetrics(
                        r.fontSize?.let { formatPx(it) },
                        r.fontWeight,
                        r.lineHeight?.let { formatPx(it) },
                    ) else null
                    out.add(Measured(
                        if (k == 0) path else "$path~$k",
                        node.tag,
                        doubleArrayOf(cssPx(r.x - origin.x), cssPx(r.y - origin.y), cssPx(r.w), cssPx(r.h)),
                        formatPx(r.radius),
                        r.color, r.background,
                        text,
                    ))
                }
            }
            out.sortWith(compareBy(PATH_ORDER) { it.path })
            return out
        }
    }

    /** Numeric source-path order: `0.10` sorts after `0.2`, `~k` repeats after the base. */
    val PATH_ORDER: Comparator<String> = Comparator { a, b ->
        fun parts(p: String): Pair<List<Int>, Int> {
            val base = p.substringBefore('~')
            val repeat = p.substringAfter('~', "").toIntOrNull() ?: 0
            return base.split('.').map { it.toIntOrNull() ?: 0 } to repeat
        }
        val (pa, ka) = parts(a)
        val (pb, kb) = parts(b)
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val va = pa.getOrNull(i) ?: return@Comparator -1
            val vb = pb.getOrNull(i) ?: return@Comparator 1
            if (va != vb) return@Comparator va.compareTo(vb)
        }
        ka.compareTo(kb)
    }

    fun formatPx(v: Double): String {
        val rounded = Math.round(v * 100.0) / 100.0
        return if (rounded == Math.floor(rounded)) "${rounded.toLong()}px" else "${rounded}px"
    }

    fun cssColor(c: Color): String {
        fun ch(v: Float): Int = Math.round(v * 255f).coerceIn(0, 255)
        val r = ch(c.red); val g = ch(c.green); val b = ch(c.blue)
        return if (c.alpha >= 0.999f) "rgb($r, $g, $b)"
        else "rgba($r, $g, $b, ${Math.round(c.alpha * 100f) / 100f})"
    }
}
