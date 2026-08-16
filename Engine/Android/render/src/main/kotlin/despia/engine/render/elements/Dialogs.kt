//
//  Dialogs.kt — `<alert>` + `<confirmDialog>` (platform-native dialogs). Kotlin twins of
//  Foundation Structure/Alert/Alert.swift and
//  Structure/ConfirmDialog/ConfirmDialog.swift — same attribute contract:
//    present= (two-way Bool key) · title= · message= · buttons= (bound array of
//    { label|title, role: cancel|destructive, action, args }) · on:dismiss.
//  Every button dispatches its bus call (dsx.dispatch twin) then closes; an empty alert
//  `buttons` falls back to a single localized "OK"; confirmDialog auto-appends a
//  localized "Cancel" when the list has no cancel role. Titles/messages/labels localize
//  through DSXStrings (the iOS displayString choke point).
//
//  NATIVE IDENTITY — Android must not redraw iOS chrome. Both tags use Material 3's real
//  `AlertDialog`: Android's native confirmation pattern is a dialog, not an iOS action
//  sheet. Material owns shape, elevation, typography, scrim, system-bar contrast,
//  accessibility, motion, touch states and system BACK. The only DSX decisions are action
//  ordering and the semantic primary/error colors. `<sheet>` independently maps to M3's
//  real `ModalBottomSheet`.
//

package despia.engine.render.elements

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.render.ComposeStackComponentContext
import despia.engine.render.ComposeStackComponents

internal fun registerDialogElements() {
    ComposeStackComponents.defineNative("alert") { ctx -> AlertElement(ctx) }
    ComposeStackComponents.defineNative("confirmDialog") { ctx -> ConfirmDialogElement(ctx) }
}

/// One `buttons` item's face: label (localized, `title` accepted as alias), role, bus call.
internal class DialogButton(d: Map<String, Any?>) {
    val label: String = DSXStrings.localize(JSE.string(d["label"] ?: d["title"] ?: ""))
    val role: String = (d["role"] as? String) ?: ""
    val action: String = (d["action"] as? String) ?: ""
    @Suppress("UNCHECKED_CAST")
    val args: Map<String, Any?> = (d["args"] as? Map<String, Any?>) ?: emptyMap()
    fun fire() { if (action.isNotEmpty()) dispatchCall(action, args) }
}

// MARK: - <alert>

@Composable
private fun AlertElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["present"] ?: ""
    val present = el.presented(key)
    FireOnDismiss(present, el)
    if (!present) return                                                  // the inert zero-size anchor

    val title = DSXStrings.localize(el.str("title"))
    val message = DSXStrings.localize(el.str("message"))
    val buttons = el.list("buttons").map { DialogButton(it) }
        .ifEmpty { listOf(DialogButton(mapOf("label" to "OK"))) }         // the OK fallback (dismiss-only)
    val cancel = buttons.firstOrNull { it.role == "cancel" }
    val actions = buttons.filter { it !== cancel }
    fun close() = el.dismissBound()

    AlertDialog(
        onDismissRequest = { close() },
        title = title.takeIf { it.isNotEmpty() }?.let {
            { Text(it) }
        },
        text = message.takeIf { it.isNotEmpty() }?.let {
            { Text(it) }
        },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                val primary = actions.ifEmpty { listOfNotNull(cancel) }
                for (button in primary) {
                    MaterialDialogButton(button) { button.fire(); close() }
                }
            }
        },
        dismissButton = cancel?.takeIf { actions.isNotEmpty() }?.let { button ->
            { MaterialDialogButton(button) { button.fire(); close() } }
        },
    )
}

// MARK: - <confirmDialog>

@Composable
private fun ConfirmDialogElement(ctx: ComposeStackComponentContext) {
    val el = El(ctx)
    val key = ctx.attrs["present"] ?: ""
    val present = el.presented(key)
    FireOnDismiss(present, el)
    if (!present) return

    val title = DSXStrings.localize(el.str("title"))
    val message = DSXStrings.localize(el.str("message"))
    val all = el.list("buttons").map { DialogButton(it) }.toMutableList()
    if (all.none { it.role == "cancel" }) all.add(DialogButton(mapOf("label" to "Cancel", "role" to "cancel")))
    val actions = all.filter { it.role != "cancel" }
    val cancel = all.first { it.role == "cancel" }
    fun close() = el.dismissBound()

    AlertDialog(
        onDismissRequest = { close() },
        title = title.takeIf { it.isNotEmpty() }?.let {
            { Text(it) }
        },
        text = message.takeIf { it.isNotEmpty() }?.let {
            { Text(it) }
        },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                for (button in actions) {
                    MaterialDialogButton(button) {
                        button.fire()
                        close()
                    }
                }
            }
        },
        dismissButton = {
            MaterialDialogButton(cancel) {
                cancel.fire()
                close()
            }
        },
    )
}

@Composable
private fun MaterialDialogButton(
    button: DialogButton,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    TextButton(onClick = onClick, modifier = modifier) {
        Text(
            button.label,
            color = if (button.role == "destructive") {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.primary
            },
        )
    }
}
