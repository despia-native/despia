//
//  DesktopParityCapture.kt — the DESKTOP CAPTURE seam of the parity contract
//  (OpenSource/Conformance/parity/README.md, "The native capture planes"). The harness
//  (DesktopParityCaptureTest) arms a Session around a fixture render; DesktopNode
//  consults it once per composed element, so every authored element that materializes
//  reports its settled geometry plus the style facts the resolver produced for it.
//  Disarmed (session == null — every production render), the cost is one @Volatile null
//  read per element and nothing composes.
//
//  This is the JVM/Compose-Multiplatform twin of :render's ParityCapture.kt, kept
//  file-local rather than shared because the two live in different Gradle projects
//  against different Compose artifacts (androidx android vs org.jetbrains.compose
//  desktop) with no common Compose-aware source set. The emitted node shape, the path
//  grammar and the ordering are deliberately identical, so one host-side differ
//  (ClosedSource/scripts/parity_native_diff.rb) reads either capture unchanged.
//
//  SCOPE, stated once and repeated in the README: this plane is Compose Desktop on the
//  JVM. It proves the Compose element layer and :core resolution. It is NOT an Android
//  device and NOT iOS, and it may never stand in for either.
//

package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import despia.engine.StackNode
import java.util.IdentityHashMap
import java.util.concurrent.ConcurrentHashMap

object DesktopParityCapture {

    /** Head/declaration tags: registered, never boxed — the web plane has no host node
     * for them either. */
    val declarationTags: Set<String> = setOf(
        "head", "event", "expects", "action", "api", "variable", "var", "let",
        "component", "formula", "script", "functions", "style", "watch", "attribute",
        "slot",
    )

    /** The armed session, set ONLY by the capture harness around a fixture render. */
    @Volatile var session: Session? = null

    /** One composed element's settled report. Geometry is scene px (translated to plane
     * CSS px at emit); style facts resolve at composition time under the pass's
     * committed scheme. */
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
                node.children.forEachIndexed { i, child -> index(child, "$path.$i") }
            }
            index(root, "0")
        }

        /** Keyed by SOURCE IDENTITY, so only the fixture's own authored nodes record:
         * component internals, chrome and synthetic nodes fall out naturally — they are
         * platform anatomy, out of the comparable set by the README's alignment rule. */
        internal fun capturesNode(node: StackNode): Boolean =
            node.tag !in declarationTags && paths.containsKey(node)

        internal fun store(slot: Any, record: Record) {
            records[slot] = record
        }

        /** Collapse the recorded elements into the ordered node list: source pre-order,
         * repeats ordered by (y, x) with a `~k` appearance suffix. `origin` and
         * `density` translate scene px into the plane's CSS-px coordinates. */
        fun measured(origin: Offset, density: Float): List<Measured> {
            fun cssPx(v: Float): Double = Math.round(v.toDouble() / density * 100.0) / 100.0
            // IDENTITY, not equality: StackNode is a data class, so two structurally
            // identical siblings (the same <image icon="chevron.right"/> in two rows) are
            // `equals`, and a hash map would fold their records into one bucket under
            // whichever instance the record map happened to yield first.
            val byNode = IdentityHashMap<StackNode, MutableList<Record>>()
            for (r in records.values) byNode.getOrPut(r.node) { mutableListOf() }.add(r)
            val out = ArrayList<Measured>()
            for ((node, list) in byNode) {
                val path = paths[node] ?: continue
                list.sortWith(compareBy({ it.y }, { it.x }))
                // An element composed twice reports one duplicate box — keep distinct
                // boxes only (real repeats occupy distinct positions).
                val distinct = list.distinctBy { listOf(it.x, it.y, it.w, it.h) }
                distinct.forEachIndexed { k, r ->
                    val text = if (node.tag == "text") TextMetrics(
                        r.fontSize?.let { formatPx(it) },
                        r.fontWeight,
                        r.lineHeight?.let { formatPx(it) },
                    ) else null
                    out.add(
                        Measured(
                            if (k == 0) path else "$path~$k",
                            node.tag,
                            doubleArrayOf(cssPx(r.x - origin.x), cssPx(r.y - origin.y), cssPx(r.w), cssPx(r.h)),
                            formatPx(r.radius),
                            r.color, r.background,
                            text,
                        ),
                    )
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

/** The capture arm of the desktop element chain — composed OUTERMOST in DesktopNode, so
 * the reported bounds are the element's full styled box (the web getBoundingClientRect
 * twin, modulo the gap-ledger rows). Colors resolve HERE, inside composition, so the
 * pass's committed scheme answers exactly what the style engine painted. `attrs` is the
 * RESOLVED map (the full DSX-CSS cascade already ran), so radius and font facts are the
 * resolver's own numbers. */
@Composable
internal fun desktopParityCaptureModifier(
    session: DesktopParityCapture.Session,
    node: StackNode,
    attrs: Map<String, String>,
    hidden: Boolean = false,
): Modifier {
    val slot = remember { Any() }
    val theme = attrs["theme"]
    val background = attrs["background"]?.let { color(it, theme) } ?: Color.Transparent
    val ink = color(attrs["color"] ?: "label", theme)
    val radius = attrs["radius"]?.toDoubleOrNull() ?: 0.0
    // Mirrors renderText's resolution exactly: body-token default size, lineSpacing
    // override, else the 1.5 line law — the capture reports what the renderer painted.
    val fontSize = if (node.tag == "text") {
        attrs["fontSize"]?.toDoubleOrNull() ?: DESKTOP_TEXT_BODY_SP.toDouble()
    } else null
    val fontWeight = if (node.tag == "text") attrs["fontWeight"] else null
    val lineHeight = fontSize?.let { size ->
        attrs["lineSpacing"]?.toDoubleOrNull()?.let { size + it }
            ?: (size * DESKTOP_TEXT_LINE_RATIO)
    }
    if (hidden) {
        // A node inside a hidden pane reports the web convention for display:none —
        // an all-zero rect (getBoundingClientRect of a [hidden] panel) with its
        // resolved style facts intact.
        androidx.compose.runtime.SideEffect {
            session.store(
                slot,
                DesktopParityCapture.Record(
                    node, 0f, 0f, 0f, 0f,
                    radius, ink, background, fontSize, fontWeight, lineHeight,
                ),
            )
        }
        return Modifier
    }
    return Modifier.onGloballyPositioned { coordinates ->
        val position = coordinates.positionInRoot()
        session.store(
            slot,
            DesktopParityCapture.Record(
                node, position.x, position.y,
                coordinates.size.width.toFloat(), coordinates.size.height.toFloat(),
                radius, ink, background, fontSize, fontWeight, lineHeight,
            ),
        )
    }
}
