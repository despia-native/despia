package despia.engine

import kotlin.math.max

/** Pure renderer-neutral planner for the opt-in adaptive `<scaffold>` shell. */
object AdaptiveShell {
    private val DECIMAL_NUMBER =
        Regex("""^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$""")

    data class Widths(val min: Double, val ideal: Double, val max: Double)

    const val DEFAULT_MODE = "custom"
    const val DEFAULT_COLLAPSE = "platform"
    const val DEFAULT_COMPACT_AT = 760.0
    val DEFAULT_SIDEBAR = Widths(220.0, 280.0, 360.0)
    val DEFAULT_INSPECTOR = Widths(240.0, 320.0, 420.0)

    data class Plan(
        val layout: String,
        val mode: String,
        val collapse: String,
        val compact: Boolean,
        val compactAt: Double,
        val sidebar: Widths,
        val inspector: Widths,
    )

    /** Child indexes after any pinned child is removed. An untagged body child is content. */
    data class Partition(
        val top: List<Int>,
        val bottom: List<Int>,
        val authored: List<Int>,
        val sidebar: List<Int>,
        val content: List<Int>,
        val inspector: List<Int>,
    )

    fun partition(children: List<Map<String, String>>): Partition {
        val top = children.indices.filter { children[it]["pin"] == "top" }
        val bottom = children.indices.filter { children[it]["pin"] == "bottom" }
        // Legacy scaffold semantics: only a child with no pin attribute belongs to the body.
        // Unknown pin values do not silently migrate into adaptive content.
        val authored = children.indices.filter { children[it]["pin"] == null }
        return Partition(
            top = top,
            bottom = bottom,
            authored = authored,
            sidebar = authored.filter { children[it]["pane"] == "sidebar" },
            content = authored.filter {
                children[it]["pane"] == null || children[it]["pane"] == "content"
            },
            inspector = authored.filter { children[it]["pane"] == "inspector" },
        )
    }

    fun resolve(
        attrs: Map<String, String>,
        widthDp: Double,
        nativeAvailable: Boolean,
        hasSidebar: Boolean,
        hasContent: Boolean,
        hasInspector: Boolean,
    ): Plan {
        val requestedMode = attrs["shell"]?.trim()?.lowercase() ?: DEFAULT_MODE
        val mode = requestedMode.takeIf { it in setOf("automatic", "native", "custom") }
            ?: DEFAULT_MODE
        val requestedCollapse = attrs["collapse"]?.trim()?.lowercase() ?: DEFAULT_COLLAPSE
        val collapse = requestedCollapse.takeIf {
            it in setOf("platform", "stack", "content", "none")
        } ?: DEFAULT_COLLAPSE
        val compactAt = number(attrs["compactAt"], DEFAULT_COMPACT_AT, 320.0, 4096.0)
        val compact = (if (widthDp.isFinite()) widthDp else 0.0) < compactAt
        val sidebar = widths(attrs, "sidebar", DEFAULT_SIDEBAR)
        val inspector = widths(attrs, "inspector", DEFAULT_INSPECTOR)
        val eligible = mode != "custom" && hasSidebar && hasContent

        val layout = when {
            !eligible -> "custom"
            compact && collapse == "content" -> "content"
            compact && collapse == "stack" -> "stack"
            // `none` is an explicit non-collapsing policy. A native split host is
            // allowed to choose a compact single-column presentation, so use the
            // deterministic semantic split below the authored breakpoint instead.
            compact && collapse == "none" -> if (hasInspector) "split3" else "split2"
            compact && collapse == "platform" && !nativeAvailable -> "stack"
            nativeAvailable -> if (hasInspector) "native3" else "native2"
            else -> if (hasInspector) "split3" else "split2"
        }
        return Plan(layout, mode, collapse, compact, compactAt, sidebar, inspector)
    }

    private fun widths(attrs: Map<String, String>, prefix: String, defaults: Widths): Widths {
        val minimum = number(attrs["${prefix}Min"], defaults.min, 120.0, 1024.0)
        val ideal = max(minimum, number(attrs["${prefix}Ideal"], defaults.ideal, 120.0, 1600.0))
        val maximum = max(ideal, number(attrs["${prefix}Max"], defaults.max, 120.0, 1600.0))
        return Widths(minimum, ideal, maximum)
    }

    private fun number(raw: String?, fallback: Double, lower: Double, upper: Double): Double {
        val text = raw?.trim()
        val value = text?.takeIf { DECIMAL_NUMBER.matches(it) }
            ?.toDoubleOrNull()?.takeIf { it.isFinite() } ?: fallback
        return value.coerceIn(lower, upper)
    }
}
