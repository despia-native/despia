//
//  SettingsRowElements.kt — the Android-native body behind Foundation's shared
//  `<SettingsRow>` wrapper. Web keeps the DSX/CSS composition; Android delegates the same
//  title/subtitle/value/icon/slot contract to a real Material 3 `ListItem`.
//
//  Native identity matters here: ListItem owns its typography, content insets, minimum
//  height, colors, and slot placement; clickable rows use Compose's native ripple and
//  accessibility Button role. The only Row below is the required Material trailing slot,
//  where value + a consumer control + disclosure icon may coexist.
//

package despia.engine.render.elements

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import despia.engine.render.ComposeStackComponents
import despia.engine.render.StackIcon

internal fun registerSettingsRowElement() {
    ComposeStackComponents.defineNative("SystemSettingsRow") { ctx ->
        MaterialSettingsRow(El(ctx))
    }
}

@Composable
private fun MaterialSettingsRow(el: El) {
    val title = el.str("title")
    val subtitle = el.str("subtitle")
    val value = el.str("value")
    val icon = el.str("icon")
    val chevron = el.bool("chevron")
    val tappable = chevron || el.bool("tappable")
    val slot = defaultSlot(el.ctx)
    val colors = MaterialTheme.colorScheme
    val interaction = if (tappable) {
        Modifier.clickable(role = Role.Button) { el.run("tap") }
    } else {
        Modifier
    }
    val trailing: (@Composable () -> Unit)? =
        if (value.isEmpty() && slot.isEmpty() && !chevron) null else {
            {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (value.isNotEmpty()) {
                        Text(
                            value,
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.onSurfaceVariant,
                        )
                    }
                    SlotRowNodes(el.ctx, slot)
                    if (chevron) {
                        StackIcon("chevron.right", 20.0, colors.onSurfaceVariant)
                    }
                }
            }
        }

    ListItem(
        headlineContent = { Text(title) },
        modifier = Modifier.fillMaxWidth().then(interaction),
        supportingContent = subtitle.takeIf { it.isNotEmpty() }?.let { text ->
            { Text(text) }
        },
        leadingContent = icon.takeIf { it.isNotEmpty() }?.let { name ->
            { StackIcon(name, 24.0, colors.onSurfaceVariant) }
        },
        trailingContent = trailing,
    )
}
