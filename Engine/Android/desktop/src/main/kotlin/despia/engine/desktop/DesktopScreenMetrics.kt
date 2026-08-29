package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import despia.engine.DSX
import despia.engine.getPath
import despia.engine.screenMetrics
import despia.engine.screenState
import despia.engine.setPath

/** Publishes the local native window, not the physical monitor, on every resize.
 *  The math (breakpoints, sizeClass, the lifecycle-preserving overlay) is the :core
 *  screen-plane table (despia.engine.ScreenMetrics) — one copy for this host and the
 *  Android app renderer's ScreenStatePublisher (:render RouterHost). */
@Composable
internal fun DesktopScreenStatePublisher() {
    val density = LocalDensity.current.density
    val size = LocalWindowInfo.current.containerSize
    val metrics = remember(size, density) { screenMetrics(size.width, size.height, density) }
    LaunchedEffect(metrics) {
        metrics ?: return@LaunchedEffect
        DSX.state.setPath("screen", screenState(DSX.state.getPath("screen"), metrics))
    }
}
