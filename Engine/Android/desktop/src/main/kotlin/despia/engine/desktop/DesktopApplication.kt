package despia.engine.desktop

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.Colors
import androidx.compose.material.MaterialTheme
import androidx.compose.material.darkColors
import androidx.compose.material.lightColors
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowState
import androidx.compose.ui.window.application
import despia.engine.StackStore
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.setPath
import kotlinx.coroutines.delay

object DesktopApplication {
    fun launch(title: String, document: DesktopHost.Document, uiSmoke: Boolean = false) = application {
        val root = remember(document.markup) { DesktopHost.parseDocument(document) }
        val store = remember(document.source) {
            StackStore().also { target ->
                document.initialVariables.forEach { (key, value) -> target.setPath(key, value) }
            }
        }
        val rootAttrs = root?.let { PlatformAttrs.resolve(it.attrs, Platform.attributeTarget) }.orEmpty()
        val exitPlan = desktopRootExitPlan(rootAttrs)
        val exitDuration = if (desktopReduceMotionEnabled()) 0 else exitPlan?.durationMillis ?: 0
        var closing by remember(document.source) { mutableStateOf(false) }
        Window(
            onCloseRequest = {
                if (exitPlan != null && exitDuration > 0 && !closing) closing = true else exitApplication()
            },
            title = title,
            state = WindowState(size = DpSize(1024.dp, 720.dp)),
        ) {
            LaunchedEffect(closing, exitDuration) {
                if (closing) {
                    delay(exitDuration.toLong())
                    exitApplication()
                }
            }
            val dark = isSystemInDarkTheme()
            MaterialTheme(colors = desktopPalette(dark)) {
                if (uiSmoke) DesktopUiSmokeStateProbe(store)
                if (root == null) {
                    val fallback = remember { DesktopHost.loadBundled("/dsx/DesktopFailure.dsx") }
                    val fallbackRoot = remember { DesktopHost.parseDocument(fallback) }
                    store.setPath("diagnostic", "The selected DSX document is malformed.")
                    store.setPath("source", document.source)
                    fallbackRoot?.let { DesktopSurface(it, store) }
                } else {
                    // Window-close is the root-only `exit=` contract. Keep the
                    // real surface alive/inert for the bounded animation, then let
                    // the application owner terminate it exactly once.
                    val exitAttrs = rootAttrs.filterKeys { it in setOf("exit", "anim", "animDuration") }
                    Box(
                        desktopVisibilityModifier(
                            Modifier.fillMaxSize(),
                            root,
                            exitAttrs,
                            visible = !closing,
                            keepAlive = true,
                        ),
                    ) { DesktopSurface(root, store) }
                }
            }
        }
    }
}

/** The shipped Windows/Linux window palette. Named because the parity capture harness
 * must measure the SAME MaterialTheme the application stamps: `color()` resolves the DSX
 * semantic words off these slots, so a capture under a different palette would report
 * colors no user ever sees. */
internal fun desktopPalette(dark: Boolean): Colors = if (dark) {
    darkColors(
        primary = Color(0xFF8EAAFF),
        secondary = Color(0xFFAAB3CB),
        background = Color(0xFF111318),
        surface = Color(0xFF1A1D24),
        error = Color(0xFFFFB4AB),
    )
} else {
    lightColors(
        primary = Color(0xFF315BE8),
        secondary = Color(0xFF5B6478),
        background = Color(0xFFF5F7FB),
        surface = Color.White,
        error = Color(0xFFBA1A1A),
    )
}

internal data class DesktopRootExitPlan(val motion: String, val durationMillis: Int)

internal fun desktopRootExitPlan(attrs: Map<String, String>): DesktopRootExitPlan? {
    val motion = attrs["exit"]?.takeIf {
        it in setOf("fade", "scale", "slide-top", "slide-bottom", "slide-left", "slide-right")
    } ?: return null
    return DesktopRootExitPlan(motion, desktopMotionDurationMillis(attrs))
}
