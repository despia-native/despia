package despia.engine

import kotlin.math.max

/**
 * Pure renderer-neutral planner for `<split>` — the two/three-pane adaptive container
 * (component-library.md W9). Corpus: OpenSource/Conformance/split/split.json, the SAME file
 * the TS twin (packages/dom/src/split.ts) and the Swift twin (SplitPlan.swift, record lane)
 * execute. The Compose presentation half (:render SplitElement) consumes this plan; the
 * platform list-detail idiom owns the pixels, this object owns the decisions.
 */
object SplitPlan {
    private val DECIMAL_NUMBER =
        Regex("""^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$""")

    const val SIDEBAR = "sidebar"
    const val CONTENT = "content"
    const val DETAIL = "detail"
    val ROLE_ORDER = listOf(SIDEBAR, CONTENT, DETAIL)

    data class Widths(val min: Double, val ideal: Double, val max: Double)

    const val DEFAULT_COLLAPSE_AT = 760.0
    const val DEFAULT_EXPAND_AT = 1104.0
    val DEFAULT_SIDEBAR = Widths(220.0, 280.0, 360.0)
    val DEFAULT_CONTENT = Widths(280.0, 340.0, 480.0)
    const val DEFAULT_DETAIL_MIN = 360.0

    data class Plan(
        val panes: Int,
        val roles: List<String>,
        val presentation: String,   // "stack" | "columns"
        val columns: List<String>,
        val host: String,
        val overlay: Boolean,
        val detail: Boolean,
        val resizable: Boolean,
        val collapseAt: Double,
        val expandAt: Double,
        val sidebar: Widths,
        val content: Widths,
        val detailMin: Double,
    )

    /**
     * Per-child role resolution: an explicit, valid `paneRole` wins (first claimant keeps a
     * duplicated role); everything else fills positionally from the remaining canonical roles
     * for the pane count. Total by construction — corpus `cases[].roles`.
     */
    fun resolveRoles(childRoles: List<String?>): List<String> {
        val bounded = childRoles.take(3)
        val taken = mutableSetOf<String>()
        val kept = bounded.map { raw ->
            val word = raw?.trim()?.lowercase() ?: ""
            if (word in ROLE_ORDER && taken.add(word)) word else null
        }
        val order = when (bounded.size) {
            1 -> listOf(CONTENT)
            2 -> listOf(SIDEBAR, DETAIL)
            else -> ROLE_ORDER
        }
        val pool = ArrayDeque(order.filter { it !in taken })
        return kept.map { it ?: pool.removeFirstOrNull() ?: CONTENT }
    }

    /** The shared planner. Width is the split's own container (BoxWithConstraints), not the screen. */
    fun resolve(attrs: Map<String, String>, childRoles: List<String?>, widthDp: Double): Plan {
        val roles = resolveRoles(childRoles)
        val collapseAt = number(attrs["collapseAt"], DEFAULT_COLLAPSE_AT, 320.0, 4096.0)
        val expandAt = max(collapseAt, number(attrs["expandAt"], DEFAULT_EXPAND_AT, 320.0, 4096.0))
        val boundedWidth = if (widthDp.isFinite()) max(0.0, widthDp) else 0.0
        val hasSidebar = SIDEBAR in roles
        val hasContent = CONTENT in roles
        val hasDetail = DETAIL in roles
        val host = when {
            hasContent -> CONTENT
            hasSidebar -> SIDEBAR
            hasDetail -> DETAIL
            else -> CONTENT
        }
        val presentation = if (boundedWidth < collapseAt) "stack" else "columns"
        val columns = if (presentation == "stack") emptyList() else ROLE_ORDER.filter { role ->
            role in roles && !(role == SIDEBAR && roles.size == 3 && boundedWidth < expandAt)
        }
        val overlay = hasSidebar &&
            (if (presentation == "stack") host != SIDEBAR else SIDEBAR !in columns)
        val authoredResizable = (attrs["resizable"] ?: "true").trim().lowercase() != "false"
        return Plan(
            panes = roles.size,
            roles = roles,
            presentation = presentation,
            columns = columns,
            host = host,
            overlay = overlay,
            detail = hasDetail,
            resizable = authoredResizable && presentation == "columns" && columns.size >= 2,
            collapseAt = collapseAt,
            expandAt = expandAt,
            sidebar = widths(attrs, "sidebar", DEFAULT_SIDEBAR),
            content = widths(attrs, "content", DEFAULT_CONTENT),
            detailMin = number(attrs["detailMin"], DEFAULT_DETAIL_MIN, 120.0, 1024.0),
        )
    }

    /**
     * Selection routing: is a detail selected? null/false/blank = none; anything else
     * (stringified) is active, so numeric ids like 0 stay selectable — corpus `selection`.
     */
    fun selectionActive(value: Any?): Boolean = when (value) {
        null -> false
        is Boolean -> value
        is String -> value.trim().isNotEmpty()
        is Number -> true
        else -> value.toString().trim().isNotEmpty()
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
