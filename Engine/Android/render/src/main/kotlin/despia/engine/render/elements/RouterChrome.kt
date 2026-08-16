//
//  RouterChrome.kt — the system-chrome half of RouterHost: render `global.nav.chrome` (the
//  Router's #1002 claim map — Router.kt chrome(), contract pinned in RouterTest) so a screen
//  that claims the REAL navigation bar (`<NavBar system="true">` → `dsx.module.route.chrome`)
//  gets one on Android too. The iOS twin is RouterHost.swift's FrameChrome (the SwiftUI
//  `.navigationTitle` + system back button); the web twin is the Routing module's web facet
//  (which IS the system bar there). On Android the platform bar is Material's top app bar —
//  drawn HERE by the real Material 3 `TopAppBar` / `LargeTopAppBar` components.
//
//  The host wraps its frame renderer ONCE — `RouterChromeHost { …frame… }` (the RouterModalHost
//  hookup precedent; MainActivity does) — and the bar lives ABOVE the frame in a column, so a
//  claimed screen's content starts below the bar exactly like iOS safe-area placement. Until
//  it's mounted, claims stay state-only (exactly the pre-#1002 behavior).
//
//  The contract (RouterHost.swift parity, all fail-open — Article 7):
//    • no claim for the TOP frame        → NO bar: the DSX screen owns its own chrome
//      (the default; the bar section composes to nothing and content is full-bleed);
//    • a claim with an EMPTY title       → treated as NO claim (RouterHost.swift's iOS 26
//      empty-platter rule — a claim without a title renders no bar);
//    • a claim with a title              → the bar: status-bar inset, title, and the back
//      affordance when `nav.canPop` — tap → `Router.pop()`;
//    • `large: true`                     → the expanded-title variant in regular-height
//      windows; a compact-height window uses the real small TopAppBar, and scrolling
//      collapses the large component through its Material nested-scroll contract.
//
//  SYSTEM BACK moved to the FRAME half (RouterHost.kt) with the full Compose RouterHost: the
//  predictive-back contract (gesture progress → the previous-screen peek) must drive frame
//  visuals, which this bar cannot — so the key/gesture ride RouterHost's PredictiveBackHandler
//  and this bar's back affordance calls the SAME one verb, `Router.pop()` (one behavior, two
//  entry points, both fed by the published `nav.canPop`). At root both stand down (BACK exits
//  the app — the OS default). Chain modals (sheet/cover) consume BACK first in their own
//  focusable popups (Sheets.kt). A passthrough OVERLAY deliberately does not consume BACK, but
//  a `touch: "block"` overlay consumes it in RouterModalHost because its contract is to block
//  every input path to the covered app (it registers after RouterHost, so its enabled handler
//  wins — the dispatcher order the host shell's mount order pins).
//
//  ── DEVIATIONS (pinned, none silent) ─────────────────────────────────────────────────
//  • Material's compact-height boundary is applied at 480dp, the Android adaptive window
//    height class. This selects TopAppBar vs LargeTopAppBar; both remain real M3 controls.
//    The host owns only the selection and nested-scroll connection, never their metrics.
//  • The back glyph is the platform's `arrow_back` (Material), named by its SF token
//    `arrow.backward` (sf-map.json row + the regenerated font subset ship with this file —
//    the "adding an icon" recipe in StackIcons.kt).
//  • The bar sits ABOVE the frame stack and swaps to the new top's claim at transition
//    START; iOS's real navigation bar animates with the push (RouterHost.kt DEVIATIONS).
//

package despia.engine.render.elements

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.TopAppBarScrollBehavior
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import despia.engine.DSX
import despia.engine.DSXStrings
import despia.engine.Router
import despia.engine.render.StackIcon
import despia.engine.sink

/// The pure half — derive the TOP frame's system-chrome claim from the published state shapes
/// (`global.nav.{stack,chrome,canPop}` — RouterTest pins them). Null = no bar (no claim, or an
/// empty-title claim: the RouterHost.swift fail-open rule). Plain-JVM testable (RouterChromeTest).
object RouterChromeSpec {
    const val COMPACT_HEIGHT_DP = 480.0

    data class Spec(val title: String, val large: Boolean, val canPop: Boolean)

    fun derive(vars: Map<String, Any?>): Spec? {
        val nav = vars["nav"] as? Map<*, *> ?: return null
        val top = (nav["stack"] as? List<*>)?.lastOrNull() as? Map<*, *> ?: return null
        val id = top["id"] ?: return null
        val spec = (nav["chrome"] as? Map<*, *>)?.get("$id") as? Map<*, *> ?: return null
        val title = (spec["title"] as? String).orEmpty()
        if (title.isEmpty()) return null              // empty-title claim = no claim (fail-open)
        return Spec(title = title,
                    large = (spec["large"] as? Boolean) == true,
                    canPop = (nav["canPop"] as? Boolean) == true)
    }

    /// The back-pop enable flag, claim or no claim — the pure `nav.canPop` derivation (the
    /// system BACK key pops bare DSX screens too; RouterHost gates its handler on the same
    /// published truth via its adopted stack). Fail-open to false.
    fun canPop(vars: Map<String, Any?>): Boolean =
        ((vars["nav"] as? Map<*, *>)?.get("canPop") as? Boolean) == true

    /// Android adaptive height classes: a requested large bar stays large only when the
    /// window has enough vertical room. Rotation/fold/window resizing therefore selects
    /// another genuine Material component instead of squeezing the expanded bar.
    fun usesLargeBar(requested: Boolean, windowHeightDp: Double): Boolean =
        requested && windowHeightDp >= COMPACT_HEIGHT_DP
}

internal object RouterChromeInsetsPolicy {
    fun frameOwnsTopInset(hasSystemBar: Boolean): Boolean = !hasSystemBar
}

/// Wrap the host's frame renderer: the claimed bar above, the frame below. One stable column —
/// the bar section composes in and out while the content slot keeps its composition identity,
/// so a claim arriving on `on:appear` never remounts (and never re-runs) the screen under it.
///
/// DERIVE-IN-THE-SINK: Compose state holds only the tiny derived results (`Spec?` + the back
/// flag), never the whole vars map — an unrelated `global.*` write (a download counter, a
/// timer) derives to an EQUAL value and is swallowed by the state's equality policy instead of
/// deep-comparing the full state map and recomposing this root wrapper on every write.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RouterChromeHost(content: @Composable () -> Unit) {
    var spec by remember { mutableStateOf(RouterChromeSpec.derive(DSX.state.vars)) }
    DisposableEffect(Unit) {
        val c = DSX.state.sink { spec = RouterChromeSpec.derive(it) }
        onDispose { c.cancel() }
    }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    LaunchedEffect(spec?.title, spec?.large) {
        // A newly claimed route starts at its authored presentation; retaining the prior
        // route's collapsed offset would make navigation history alter first-frame chrome.
        scrollBehavior.state.heightOffset = 0f
        scrollBehavior.state.contentOffset = 0f
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val useLarge = RouterChromeSpec.usesLargeBar(
            requested = spec?.large == true,
            windowHeightDp = maxHeight.value.toDouble(),
        )
        val frameSafeSides =
            if (RouterChromeInsetsPolicy.frameOwnsTopInset(spec != null)) {
                WindowInsetsSides.Top + WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom
            } else {
                WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom
            }
        // System BACK is the frame host's now (RouterHost.kt PredictiveBackHandler — the
        // peek needs the frames); this bar keeps only its tap affordance on the same verb.
        Column(
            Modifier
                .fillMaxSize()
                // Safe-area padding keeps content out of cutouts/navigation; this host
                // background continues the Material surface underneath those system areas.
                .background(MaterialTheme.colorScheme.background)
                .nestedScroll(scrollBehavior.nestedScrollConnection),
        ) {
            spec?.let { RouterChromeBar(it, useLarge, scrollBehavior) }
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    // TopAppBar consumes the top inset. The frame owns the remaining safe
                    // sides so scroll content never sits under gesture nav or a side cutout.
                    .windowInsetsPadding(
                        WindowInsets.safeDrawing.only(
                            frameSafeSides,
                        ),
                    ),
            ) { content() }
        }
    }
}

/// The real M3 bar. The component owns status-bar insets, container/color roles, typography,
/// sizes, touch targets, and the small/large visual identity.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RouterChromeBar(
    spec: RouterChromeSpec.Spec,
    useLarge: Boolean,
    scrollBehavior: TopAppBarScrollBehavior,
) {
    val title: @Composable () -> Unit = {
        Text(spec.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    val navigationIcon: @Composable () -> Unit = {
        if (spec.canPop) {
            IconButton(
                onClick = { Router.shared?.pop() },
                modifier = Modifier.semantics {
                    contentDescription = DSXStrings.localize("Back")
                },
            ) {
                StackIcon("arrow.backward", 24.0, MaterialTheme.colorScheme.onSurface)
            }
        }
    }
    if (useLarge) {
        LargeTopAppBar(
            title = title,
            navigationIcon = navigationIcon,
            scrollBehavior = scrollBehavior,
        )
    } else {
        TopAppBar(
            title = title,
            navigationIcon = navigationIcon,
            scrollBehavior = scrollBehavior,
        )
    }
}
