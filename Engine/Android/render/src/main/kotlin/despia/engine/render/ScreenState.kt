//
//  ScreenState.kt — reactive window metrics → global.screen.* (read as dsx.screen.*),
//  the Android app renderer's twin of iOS DSXScreen.swift (RouterHost.swift attaches
//  `.modifier(DSXScreenMetrics())`) and the web's boot.ts seedScreen. Mounted once by
//  RouterHost, so responsive markup is just the expression layer — no new primitive:
//      visible-if="dsx.screen.width > 768"            visible-if="dsx.screen.sizeClass == 'regular'"
//      columns="{{ dsx.screen.width > 900 ? 3 : 1 }}" padding="{{ dsx.screen.breakpoint == 'sm' ? 8 : 24 }}"
//
//  LocalWindowInfo.containerSize is snapshot-state backed — rotation, a configuration
//  change, a foldable posture flip, and a multi-window / desktop-window resize all
//  invalidate this composition, so the publish is live for the window's whole life,
//  never a boot-time seed. The math + the lifecycle-preserving overlay (screen.phase /
//  screen.ready must survive a rotation — phase.json's mirror-image guard) are the
//  :core screen-plane table (despia.engine.ScreenMetrics), shared verbatim with the
//  desktop host's DesktopScreenStatePublisher.
//
//  Render-safe by construction: the write happens in LaunchedEffect (a post-composition
//  side effect), the Compose analogue of the JSE.afterRender hop DSXScreen.swift needs
//  on iOS — never a store mutation inside the pass that measured the window.
//

package despia.engine.render

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

/** Publishes the local app window (density-independent px — iOS points, web CSS px). */
@Composable
internal fun ScreenStatePublisher() {
    val density = LocalDensity.current.density
    val size = LocalWindowInfo.current.containerSize
    val metrics = remember(size, density) { screenMetrics(size.width, size.height, density) }
    LaunchedEffect(metrics) {
        metrics ?: return@LaunchedEffect
        DSX.state.setPath("screen", screenState(DSX.state.getPath("screen"), metrics))
    }
}
