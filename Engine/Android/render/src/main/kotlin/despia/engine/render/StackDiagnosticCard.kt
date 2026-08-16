package despia.engine.render

//
//  StackDiagnosticCard.kt — the paint half of the diagnostics port (Diagnostics.swift's
//  StackDiagnosticCard + DSXDiagnosticsView, :core's StackDiagnostics is the ledger half):
//  the red in-place placeholder rendered WHERE a component failed to resolve, instead of a
//  silent blank — TEST channels only (the caller gates on flagsUnresolved/failedToParse,
//  both fail-closed to production). Tap → the issues panel: issue cards with code-editor
//  excerpts + the plain-language hint, and Copy all (the full StackDiagnostics.report()
//  via the clipboard) so a tester exports the whole state into a bug report. No console,
//  no logcat, no setup.
//
//  DIVERGENCES from the Swift twin (pinned in StackDiagnostics.kt's header): no dev
//  overlay WINDOW and no auto-present — the card IS the surfacing (it renders exactly
//  where the dead component was used; a bootstrap-failed root renders it at the root), and
//  the panel is a Compose Dialog from the card. Share-as-.txt rides Copy all (the clipboard
//  is the export seam; Android has no UIActivityViewController twin in the kernel).
//

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import despia.engine.StackDiagnostics

// The dev center's palette (Diagnostics.swift DiagTheme — Panel.dsx's dark glass language).
private val DIAG_BACKDROP = Color(0xFF0B0B0D)
private val DIAG_CARD = Color(0xFF131316)
private val DIAG_CODE = Color(0xFF0A0A0C)
private val DIAG_RED = Color(0xFFFF453A)
private val DIAG_SECONDARY = Color(0xB8FFFFFF)
private val DIAG_TERTIARY = Color(0x59FFFFFF)

/// The in-place placeholder where a component failed to render — deliberately visible,
/// quietly styled: a tinted card with the failure named, tappable to the issues panel.
@Composable
internal fun StackDiagnosticCard(tag: String) {
    var showPanel by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(8.dp)
            .background(DIAG_RED.copy(alpha = 0.12f), RoundedCornerShape(10.dp))
            .clickable { showPanel = true }
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(30.dp).background(DIAG_RED.copy(alpha = 0.16f), RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.Center,
        ) {
            StackIcon("exclamationmark.triangle.fill", 14.0, DIAG_RED)
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("<$tag/> failed to render",
                 color = DIAG_RED, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text("Malformed markup or a missing component — tap for the exact error. Test builds only.",
                 color = DIAG_SECONDARY, fontSize = 11.sp)
        }
    }
    if (showPanel) DsxDiagnosticsPanel(onDismiss = { showPanel = false })
}

/// The issues panel: issue cards + excerpts + hints, and Copy all (the full report through
/// the clipboard — the DSXDiagnosticsView export seam).
@Composable
internal fun DsxDiagnosticsPanel(onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .background(DIAG_BACKDROP, RoundedCornerShape(16.dp))
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Diagnostics", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                Text("Copy all",
                     color = DIAG_RED, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                     modifier = Modifier
                         .clickable { clipboard.setText(AnnotatedString(StackDiagnostics.report())) }
                         .padding(4.dp))
            }
            val issues = StackDiagnostics.issues
            if (issues.isEmpty()) {
                Text("No parse issues — every shipped template parsed and registered.",
                     color = DIAG_SECONDARY, fontSize = 12.sp)
            }
            for (issue in issues) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(DIAG_CARD, RoundedCornerShape(12.dp))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(issue.headline, color = DIAG_RED, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("${issue.location} — ${issue.reason}", color = DIAG_SECONDARY, fontSize = 11.sp)
                    if (issue.excerpt.isNotEmpty()) {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .background(DIAG_CODE, RoundedCornerShape(8.dp))
                                .padding(8.dp)
                                .horizontalScroll(rememberScrollState()),
                        ) {
                            for (l in issue.excerpt) {
                                Text("${if (l.isError) "›" else " "} ${l.no} │ ${l.text}",
                                     color = if (l.isError) DIAG_RED else DIAG_TERTIARY,
                                     fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                                     maxLines = 1)
                            }
                        }
                    }
                    Text(issue.hint, color = DIAG_SECONDARY, fontSize = 11.sp)
                }
            }
        }
    }
}
