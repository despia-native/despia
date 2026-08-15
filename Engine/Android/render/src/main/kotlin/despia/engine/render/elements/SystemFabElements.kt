//
//  SystemFabElements.kt — Android-native body behind Foundation's shared `<FAB>`.
//  The DSX wrapper keeps one cross-platform contract; Android delegates its visual,
//  interaction, elevation, ripple, focus, and Button semantics to Material 3.
//

package despia.engine.render.elements

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.FloatingActionButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick as semanticsOnClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import despia.engine.render.ComposeStackComponents
import despia.engine.render.StackIcon

internal fun registerSystemFabElement() {
    ComposeStackComponents.defineNative("SystemFAB") { ctx ->
        MaterialSystemFab(El(ctx))
    }
}

@Composable
private fun MaterialSystemFab(el: El) {
    val icon = el.str("icon", "plus")
    val label = el.str("a11yLabel").ifEmpty { icon }
    val size = el.dbl("size", 56.0).coerceAtLeast(48.0)
    val iconSize = el.dbl("iconSize", 22.0).coerceAtLeast(1.0)

    // StackIcon is font-backed, while Material's own Icon is painted. Without this outer
    // replacement Android exports a nameless clickable FAB plus a second raw PUA glyph.
    // Material still owns all pixels, ripple, elevation, pointer input, and hardware focus;
    // this wrapper owns only the single truthful accessibility node/action.
    Box(
        Modifier.clearAndSetSemantics {
            contentDescription = label
            role = Role.Button
            semanticsOnClick {
                el.run("tap")
                true
            }
        },
    ) {
        FloatingActionButton(
            onClick = { el.run("tap") },
            modifier = Modifier.size(size.dp),
            containerColor = el.color("color", "accent"),
        ) {
            StackIcon(icon, iconSize, androidx.compose.material3.LocalContentColor.current)
        }
    }
}
