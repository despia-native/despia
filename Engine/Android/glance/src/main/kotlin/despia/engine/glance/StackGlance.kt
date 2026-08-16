//
//  StackGlance.kt — the Glance paint backend of the StackLive snapshot dialect (the
//  Android app-widget surface). The view half of OpenSource/Engine/iOS/StackLive.swift:
//  the kernel half — element table, per-element defaults, layout box, value
//  resolution — is `:core` (StackLive.kt / StackScope.kt); this file only PAINTS a
//  `StackBackend.resolve` result and recurses children. Hoisted out of the Widgets
//  module (ClosedSource/DSX/Modules/Core/Widgets/kotlin/ImageWidget.kt carried a
//  module-local twin until the W3 kernel wave — this is that wave).
//
//  ONE grammar, a table per surface: `Render` takes the element table as a parameter
//  (defaulting to the snapshot-safe `StackBackend.elements`) and passes it through the
//  child recursion — the Kotlin seam for Swift's environment-injected `stackTable`, so
//  a richer surface renders a SUPERSET of tags through the SAME recursion.
//
//  ── DEVIATIONS from the SwiftUI paint (each pinned, none silent — carried over from
//     the widget-local backend this hoists) ────────────────────────────────────────────
//  • `gauge` — Glance/RemoteViews cannot draw a trimmed circle; the gauge renders its
//    value label (the element stays in the table so the SAME markup parses everywhere).
//  • `opacity` — no Glance alpha modifier; the layout-box attribute is ignored (the box
//    is otherwise 1:1).
//  • `image symbol=` — SF Symbols are iOS-only; the element renders nothing here (the
//    snapshot dialect's documented cross-platform seam; sf-map glyphs are the in-app
//    renderer's story, not the RemoteViews surface's).
//  • Font weights — Glance ships Normal/Medium/Bold only: semibold folds to Medium,
//    light to Normal (the attribute contract is unchanged).
//  • Spacing — Glance rows/columns have no Arrangement.spacedBy; fixed gaps interleave
//    as sized spacers. A bare `<spacer/>` (no size=) becomes the flexible weight spacer
//    from the PARENT's scope (Glance weight is stack-scope-only); a sized spacer draws
//    at its size (default 8 — SwiftUI Spacer has no fixed default, pinned here).
//

package despia.engine.glance

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.cornerRadius
import androidx.glance.action.clickable
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import despia.engine.StackAxis
import despia.engine.StackBackend
import despia.engine.StackElement
import despia.engine.StackFontWeight
import despia.engine.StackHAlign
import despia.engine.StackLiveRender
import despia.engine.StackNode
import despia.engine.StackReader
import despia.engine.StackScope
import despia.engine.StackVAlign

object StackGlance {

    /// Paint one node and its subtree: resolve through the :core table, wrap the
    /// element in the uniform layout box, recurse. Unknown tag → nothing (fail-open).
    @Composable
    fun Render(node: StackNode, scope: StackScope,
               table: Map<String, StackElement> = StackBackend.elements) {
        val resolved = StackBackend.resolve(node, scope, table)
        var m: GlanceModifier = GlanceModifier
        resolved.box?.let { box ->
            if (box.padH > 0.0 || box.padV > 0.0)
                m = m.padding(horizontal = box.padH.dp, vertical = box.padV.dp)
            if (box.growsWidth) m = m.fillMaxWidth()
            box.bg?.let { m = m.background(color(it)) }
            if (box.radius > 0.0) m = m.cornerRadius(box.radius.dp)
            // box.opacity: no Glance alpha modifier (header deviation).
        }

        when (val r = resolved.render) {
            is StackLiveRender.Stack -> when (r.axis) {
                StackAxis.VERTICAL -> Column(m, horizontalAlignment = hAlign(r.hAlign)) {
                    ChildrenColumn(node, r.spacing, scope, table)
                }
                StackAxis.HORIZONTAL -> Row(m, verticalAlignment = vAlign(r.vAlign)) {
                    ChildrenRow(node, r.spacing, scope, table)
                }
                StackAxis.DEPTH -> Box(m, contentAlignment = boxAlign(r.frameAlign)) {
                    for (c in node.children) Render(c, scope, table)
                }
            }
            is StackLiveRender.Text -> Text(
                r.text,
                style = TextStyle(
                    color = ColorProvider(color(r.color)),
                    fontSize = r.size.sp,
                    fontWeight = weight(r.weight)),
                maxLines = r.lines.coerceAtLeast(1),
                modifier = m)
            is StackLiveRender.Countdown -> {
                // DEVIATION (pinned): Glance has no OS-ticked text (SwiftUI's
                // Text(timerInterval:) twin). Render the REMAINING time at paint —
                // re-painted on the widget's refresh cadence; the RemoteViews
                // Chronometer upgrade is the tracked follow-up. Past deadlines pin 0:00.
                val remaining = (r.untilEpochSeconds - System.currentTimeMillis() / 1000.0)
                    .toLong().coerceAtLeast(0)
                Text(despia.engine.JSE.clockFormat(remaining),   // the ONE duration formatter (the mmss builtin's)
                     style = TextStyle(
                         color = ColorProvider(color(r.color)),
                         fontSize = r.size.sp,
                         fontWeight = weight(r.weight)),
                     maxLines = 1,
                     modifier = m)
            }
            is StackLiveRender.Button -> {
                // COMPILED INTERACTION: interactive ONLY when the call parsed (:core) AND
                // the app-installed capability seam admits scheme.action — else the inert
                // label (fail-closed; the same law as the iOS LiveButtonElement).
                val style = TextStyle(
                    color = ColorProvider(color(r.color)),
                    fontSize = r.size.sp,
                    fontWeight = weight(r.weight))
                val mod = if (r.scheme.isNotEmpty() && DSXGlanceCalls.admitted(r.scheme, r.action))
                    m.clickable(
                        androidx.glance.appwidget.action.actionRunCallback<DSXNodeCallAction>(
                            androidx.glance.action.actionParametersOf(
                                DSXNodeCallAction.KEY_SCHEME to r.scheme,
                                DSXNodeCallAction.KEY_ACTION to r.action,
                                DSXNodeCallAction.KEY_ARGS to r.argsJSON)))
                else m
                Text(r.label, style = style, maxLines = 1, modifier = mod)
            }
            is StackLiveRender.Image -> {
                // symbol= is SF-Symbols (iOS-only) — renders nothing here (header note).
            }
            is StackLiveRender.Progress -> LinearProgressIndicator(
                progress = r.value.toFloat(),
                modifier = m.fillMaxWidth(),
                color = ColorProvider(color(r.tint)))
            is StackLiveRender.Gauge -> Box(m.size(r.diameter.dp), contentAlignment = Alignment.Center) {
                // The trimmed-ring draw is out of RemoteViews reach — the value label
                // carries the reading (header deviation).
                Text(r.label, style = TextStyle(
                    color = ColorProvider(color(r.tint)),
                    fontSize = r.labelSize.sp,
                    fontWeight = FontWeight.Bold))
            }
            is StackLiveRender.Spacer ->
                Spacer(m.size(StackReader(node, scope).double("size", 8.0).dp))
                // flexible (size-less) spacers ride the parent loop below
            is StackLiveRender.Divider ->
                Box(m.fillMaxWidth().height(1.dp).background(color(r.color))) {}
            is StackLiveRender.None -> { /* unknown tag renders nothing (fail-open) */ }
        }
    }

    /// Children in Column scope: a bare `<spacer/>` becomes the flexible weight spacer
    /// (Glance weight is stack-scope-only); `spacing` interleaves fixed gaps (header note).
    @Composable
    private fun ColumnScope.ChildrenColumn(node: StackNode, spacing: Double,
                                           scope: StackScope, table: Map<String, StackElement>) {
        var first = true
        for (c in node.children) {
            if (!first && spacing > 0.0) Spacer(GlanceModifier.height(spacing.dp))
            first = false
            if (c.tag == "spacer" && c.attrs["size"] == null) Spacer(GlanceModifier.defaultWeight())
            else Render(c, scope, table)
        }
    }

    @Composable
    private fun RowScope.ChildrenRow(node: StackNode, spacing: Double,
                                     scope: StackScope, table: Map<String, StackElement>) {
        var first = true
        for (c in node.children) {
            if (!first && spacing > 0.0) Spacer(GlanceModifier.size(spacing.dp))
            first = false
            if (c.tag == "spacer" && c.attrs["size"] == null) Spacer(GlanceModifier.defaultWeight())
            else Render(c, scope, table)
        }
    }

    // ── :core vocabulary → Glance types (the pinned mappings) ──

    private fun color(argb: Long): Color = Color(argb.toInt())

    private fun weight(w: StackFontWeight): FontWeight = when (w) {
        StackFontWeight.BOLD -> FontWeight.Bold
        StackFontWeight.SEMIBOLD, StackFontWeight.MEDIUM -> FontWeight.Medium
        else -> FontWeight.Normal                       // light folds to Normal (header note)
    }

    private fun hAlign(a: StackHAlign): Alignment.Horizontal = when (a) {
        StackHAlign.LEADING -> Alignment.Start
        StackHAlign.TRAILING -> Alignment.End
        StackHAlign.CENTER -> Alignment.CenterHorizontally
    }

    private fun vAlign(a: StackVAlign): Alignment.Vertical = when (a) {
        StackVAlign.TOP -> Alignment.Top
        StackVAlign.BOTTOM -> Alignment.Bottom
        StackVAlign.CENTER -> Alignment.CenterVertically
    }

    private fun boxAlign(a: StackHAlign): Alignment = when (a) {
        StackHAlign.LEADING -> Alignment.CenterStart
        StackHAlign.TRAILING -> Alignment.CenterEnd
        StackHAlign.CENTER -> Alignment.Center
    }
}

// ── COMPILED INTERACTIONS (watch-runtime.md §Snapshot nodes) — the app-side seam ─────────
//
// Glance action callbacks run IN THE APP PROCESS, so execution is a direct bus dispatch —
// no queue, no wake (the iOS widget's App-Group queue exists because its extension is a
// foreign process). The GATE is the same law as every node: the per-role capability table.
// FAIL-CLOSED: until the app installs `invoke` AND `table` (WidgetBridge, from its build's
// generated node registry — the `reach`-derived role row, the same tokens iOS bakes into
// the role's capabilities.json), buttons render INERT. Nothing executes that was not
// declared.
object DSXGlanceCalls {
    /// The bus dispatch, installed by the app (WidgetBridge): (scheme, action, argsJSON).
    @Volatile var invoke: ((String, String, String) -> Unit)? = null
    /// The role's relayable `scheme.action` set — empty = nothing interactive.
    @Volatile var table: Set<String> = emptySet()
    fun admitted(scheme: String, action: String): Boolean =
        invoke != null && table.contains("$scheme.$action")
}

/// The widget button's tap — parameters carry the statically-compiled call. Runs in the
/// app process; the seam re-checks the table (defense in depth with the painter's gate).
class DSXNodeCallAction : androidx.glance.appwidget.action.ActionCallback {
    override suspend fun onAction(
        context: android.content.Context,
        glanceId: androidx.glance.GlanceId,
        parameters: androidx.glance.action.ActionParameters,
    ) {
        val scheme = parameters[KEY_SCHEME] ?: return
        val action = parameters[KEY_ACTION] ?: return
        val args = parameters[KEY_ARGS] ?: "{}"
        if (DSXGlanceCalls.admitted(scheme, action)) DSXGlanceCalls.invoke?.invoke(scheme, action, args)
    }
    companion object {
        val KEY_SCHEME = androidx.glance.action.ActionParameters.Key<String>("dsx.scheme")
        val KEY_ACTION = androidx.glance.action.ActionParameters.Key<String>("dsx.action")
        val KEY_ARGS = androidx.glance.action.ActionParameters.Key<String>("dsx.args")
    }
}
