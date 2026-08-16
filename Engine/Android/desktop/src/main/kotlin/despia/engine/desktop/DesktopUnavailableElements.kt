package despia.engine.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal data class DesktopCapabilityFailure(
    val code: String,
    val capability: String,
    val message: String,
)

@Composable
internal fun DesktopUnavailableElement(context: DesktopElementContext, modifier: Modifier) {
    val failure = DesktopCapabilities.failure(context.node.tag)
    LaunchedEffect(context.node, failure.code) {
        context.attributes["on:fail"]?.takeIf(String::isNotBlank)?.let { action ->
            // Do not echo src/origin/path: authored URLs may contain credentials.
            context.run(
                action,
                mapOf(
                    "code" to failure.code,
                    "capability" to failure.capability,
                    "platform" to "desktop",
                    "recoverable" to false,
                ),
            )
        }
    }
    Column(
        modifier
            .fillMaxWidth()
            .heightIn(min = 132.dp)
            .background(color("fill").copy(alpha = 0.28f), RoundedCornerShape(14.dp))
            .border(1.dp, color("separator"), RoundedCornerShape(14.dp))
            .padding(18.dp)
            .semantics {
                role = Role.Image
                contentDescription = "DSX native capability unavailable. ${failure.message}"
            },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("DSX capability unavailable", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        Text(failure.message, color = color("secondary"), fontSize = 13.sp)
        Text(failure.code, color = color("tertiary"), fontFamily = FontFamily.Monospace, fontSize = 11.sp)
    }
}
