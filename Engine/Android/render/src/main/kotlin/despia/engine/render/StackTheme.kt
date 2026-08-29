//
//  StackTheme.kt — the SYSTEM-DEFAULTS theme root (system-defaults.md, ratified): the
//  unstyled baseline IS the platform, and on Android the platform is Material 3 under
//  dynamicColorScheme(). This file owns:
//
//    • `DespiaSystemTheme` — the ONE theme wrapper for a composed DSX tree: dynamic
//      color on API 31+ (dynamicLight/DarkColorScheme per the system dark-mode setting),
//      the static M3 lightColorScheme()/darkColorScheme() below 31. It stamps the scheme
//      into `StackTheme` and provides MaterialTheme so real M3 components (the system
//      button path, StackButtons.kt) inherit the roles.
//    • `StackTheme` — the snapshot-state scheme holder that lets NON-composable
//      resolution (`StackStyle.color`, called from every element) reach the live scheme.
//      Reading it during composition subscribes the reader, so a dark-mode flip
//      re-resolves every semantic color exactly like iOS's dynamic UIColor providers.
//      The `scheme` setter VALUE-COMPARES the ten corpus roles before writing (M3's
//      ColorScheme has no value equals), so same-valued restamps never wave.
//    • `LocalForcedScheme` + `DespiaSystemTheme(forcedDark = true)` — the per-SURFACE
//      dark commitment (the iOS ui.forcedStyle twin): a cover pins its own scheme,
//      consulted before the global stamp, popped deterministically on dispose.
//    • `ForcedSchemeSubtree` + `subtreePin`/`derivedIsDark` — the per-SUBTREE scheme pin
//      riding the same seam (the Stack.swift theme=/derivedScheme twins, ~5039-5069 /
//      ~5131-5173): markup `theme="dark|light"` pins a subtree, and an authored LITERAL
//      canvas (white/black words, well-formed rgb()/rgba(), 6/8-digit hex; alpha ≥ 0.5)
//      derives it from relative luminance — explicit theme= always wins, semantic words
//      and unparseable tokens never derive. StackNodeView wraps the pinned node.
//    • `M3_ROLES` — the semantic-token vocabulary → M3 color-role NAME map, the android
//      column of the SHARED corpus OpenSource/Conformance/defaults/tokens.json. The
//      corpus is the truth: DefaultsTokensTest diffs this map against it, so a mapping
//      edited here without the corpus (or vice versa) fails the suite (the
//      theme.test.ts drift-gate twin).
//
//  THE LAW (system-defaults.md): role names, never values — the OS owns the values via
//  dynamic color, so inherited looks self-update with the OS (the iOS-26 lesson: a
//  re-specified look rots). Only the theme-LESS fallback path (StackStyle.color's pinned
//  iOS-dark table) carries literals, and only until a theme root has composed.
//
//  ── DEVIATIONS from the Swift twin (pinned, none silent) ────────────────────────────
//  • iOS resolves semantic slots through UIColor's trait system with no explicit theme
//    root; Compose has no ambient system palette, so the scheme is COMPUTED here and
//    published two ways: MaterialTheme (composable consumers) + StackTheme (the
//    StackStyle.color seam). Both hosts wrap (MainActivity's setContent and
//    StackRootView), so module surfaces that mount StackNodeView directly still resolve
//    through the stamped scheme.
//  • Legacy vocabulary rides the corpus words it aliases (the web cssmap.ts precedent):
//    `secondaryBackground`→groupedBackground, `tertiaryBackground`→
//    secondaryGroupedBackground, `fillFaint`→the surfaceContainerHigh step below `fill`.
//

package despia.engine.render

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import despia.engine.JSE

object StackTheme {

    /// The semantic-token vocabulary → M3 color-role NAME (the android column of
    /// OpenSource/Conformance/defaults/tokens.json — DefaultsTokensTest is the drift gate).
    val M3_ROLES: Map<String, String> = mapOf(
        "label" to "onSurface",
        "secondary" to "onSurfaceVariant",
        "tertiary" to "outline",
        "background" to "surface",
        "groupedBackground" to "surfaceContainer",
        "secondaryGroupedBackground" to "surfaceContainerHigh",
        "fill" to "surfaceContainerHighest",
        "separator" to "outlineVariant",
        "accent" to "primary",
        "destructive" to "error",
    )

    /// Legacy StackStyle.color spellings → the corpus word each aliases (see header).
    private val ALIASES: Map<String, String> = mapOf(
        "text" to "label",
        "secondaryLabel" to "secondary",
        "tertiaryLabel" to "tertiary",
        "systemBackground" to "background",
        "secondaryBackground" to "groupedBackground",
        "tertiaryBackground" to "secondaryGroupedBackground",
    )

    // Snapshot-state so a composition-time read (StackStyle.color runs inside element
    // composables) registers an invalidation dependency — the @Environment twin.
    private val schemeState = mutableStateOf<ColorScheme?>(null)

    // The per-SURFACE forced-scheme override (the LocalForcedScheme seam below): a
    // dark-committed cover (StudioEditor, DevOverlay) pins its own scheme here for its
    // lifetime, consulted BEFORE the global stamp — never written through `scheme`, so
    // the ambient app's stamp survives the cover untouched and dispose restores it
    // deterministically. A tiny identity LIFO so overlapping full-surface covers (dev
    // drawer over the editor) unwind correctly. Written only by DespiaSystemTheme's
    // forcedDark SURFACE path; subtree pins must never publish here because sibling
    // subtrees can coexist.
    private val forcedState = mutableStateOf<ColorScheme?>(null)
    private val forcedStack = ArrayList<ColorScheme>()

    // Composition must never write snapshot/global state while it is still speculative:
    // Compose can abandon that pass without committing its DisposableEffect, which used
    // to strand a forced scheme in forcedStack. This thread-local scope gives semantic()
    // the correct first-composition scheme synchronously. Committed draw callbacks keep
    // using forcedState/schemeState, which are changed only from Compose apply effects.
    private val composingSchemes = ThreadLocal<ArrayList<ColorScheme>>()

    @Composable
    internal fun WithCompositionScheme(scheme: ColorScheme, content: @Composable () -> Unit) {
        val stack = composingSchemes.get() ?: ArrayList<ColorScheme>().also(composingSchemes::set)
        stack.add(scheme)
        // Compose forbids try/finally around a composable invocation. A thrown child
        // composition is therefore intentionally fatal to its host (the qualification
        // runner reports that process crash); every successful or abandoned pass returns
        // through this deterministic pop without publishing global snapshot state.
        content()
        stack.removeAt(stack.lastIndex)
        if (stack.isEmpty()) composingSchemes.remove()
    }

    internal fun pushForced(s: ColorScheme) {
        if (forcedStack.none { it === s }) forcedStack.add(s)
        forcedState.value = forcedStack.last()
    }
    internal fun popForced(s: ColorScheme) {
        forcedStack.removeAll { it === s }
        forcedState.value = forcedStack.lastOrNull()
    }

    /// The live M3 scheme — a mounted FORCED surface wins while it is up (the iOS
    /// ui.forcedStyle twin), else the DespiaSystemTheme stamp; null until a theme root
    /// has composed (plain-JVM tests, pre-theme hosts) — resolution then falls back to
    /// StackStyle.color's pinned iOS-dark table, byte-identical to the pre-theme wave.
    var scheme: ColorScheme?
        get() = composingSchemes.get()?.lastOrNull() ?: forcedState.value ?: schemeState.value
        set(v) {
            // VALUE-COMPARE before writing: M3's ColorScheme has no value equals
            // (verified against material3 1.3.1), so every same-valued restamp — each
            // mounting root, each dark-flip echo, a disposed host's lingering instance —
            // was a real global write, a full invalidation wave over every semantic()
            // scope. Compare the ten corpus roles (the only slots semantic() serves;
            // fillFaint rides surfaceContainerHigh, in the ten) and skip equal-valued
            // stamps — a wallpaper change producing genuinely new colors still lands.
            val old = schemeState.value
            if (old === v) return
            if (old != null && v != null &&
                M3_ROLES.values.all { roleColor(old, it) == roleColor(v, it) }) return
            schemeState.value = v
        }

    /// A role NAME (corpus android column) → the scheme's color; null for unknown names.
    fun roleColor(scheme: ColorScheme, role: String): Color? = when (role) {
        "onSurface" -> scheme.onSurface
        "onSurfaceVariant" -> scheme.onSurfaceVariant
        "outline" -> scheme.outline
        "surface" -> scheme.surface
        "surfaceContainer" -> scheme.surfaceContainer
        "surfaceContainerHigh" -> scheme.surfaceContainerHigh
        "surfaceContainerHighest" -> scheme.surfaceContainerHighest
        "outlineVariant" -> scheme.outlineVariant
        "primary" -> scheme.primary
        "error" -> scheme.error
        else -> null
    }

    /// A semantic color WORD (corpus vocabulary + the legacy aliases) → the themed color,
    /// or null when the word is not semantic OR no theme root has stamped a scheme yet
    /// (the caller then falls through to its pinned table / literal grammar).
    /// Vocabulary membership is tested BEFORE the snapshot read: a hex/rgb literal must
    /// answer null without touching schemeState, or every literal-colored scope would
    /// subscribe itself to every restamp wave. The state read stays for genuine semantic
    /// words — that reactivity (re-resolve on stamp/dark flip) is the design.
    fun semantic(word: String): Color? {
        if (word != "fillFaint" && !M3_ROLES.containsKey(ALIASES[word] ?: word)) return null
        val s = scheme ?: return null   // forced surface first, then the global stamp
        if (word == "fillFaint") return s.surfaceContainerHigh   // the step below `fill` (header)
        val role = M3_ROLES[ALIASES[word] ?: word] ?: return null
        return roleColor(s, role)
    }

    // ── the SUBTREE-SCHEME law (the Stack.swift theme=/derivedScheme twins) ────────────

    /// The one subtree-pin DECISION — twin of the Stack.swift `apply` theme arm
    /// (Stack.swift ~5039-5069): an authored `theme="dark|light"` pins the subtree scheme
    /// (true = dark, false = light); ANY authored theme= — a bad word included — SUPPRESSES
    /// the derivation (explicit always wins, the iOS if/else); only with NO theme= does an
    /// authored LITERAL background derive the scheme from its luminance (`derivedIsDark`).
    /// null = no pin — the ambient scheme stays.
    fun subtreePin(theme: String?, background: String?): Boolean? = when {
        theme == "dark" -> true
        theme == "light" -> false
        theme != null -> null                               // authored but not a scheme word — no pin, no derivation
        else -> background?.let { derivedIsDark(it) }
    }

    /// The derived-scheme half of the authored-canvas law — twin of Stack.swift
    /// `derivedScheme(_:)` (~5131-5141), the SAME rule to the digit: an authored
    /// background that parses to a LITERAL, opaque-ish color yields the subtree scheme its
    /// luminance implies — relative luminance 0.2126 R + 0.7152 G + 0.0722 B < 0.5 → dark
    /// (true), else light (false). null (no derivation) for anything non-literal and for
    /// overlay paints (alpha < 0.5) — deriving a scheme from a translucent wash over an
    /// unknown canvas would be a guess.
    fun derivedIsDark(background: String): Boolean? {
        val c = literalRGBA(background) ?: return null
        if (c[3] < 0.5) return null
        val luminance = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        return luminance < 0.5
    }

    /// The literal-color reader behind `derivedIsDark` — twin of Stack.swift
    /// `literalRGBA(_:)` (~5149-5173), EXACTLY the spellings `StackStyle.color` paints
    /// literally, in its order: the white/black named literals ARE literal; every other
    /// WORD (accent, clear, the semantic slots — they already follow the ambient scheme)
    /// is NOT; then WELL-FORMED rgb()/rgba() (leading call word + open, trailing close —
    /// a malformed call the tolerant funnel still paints simply never derives) and
    /// 6/8-digit hex with the funnel's own normalization. An unparseable token returns
    /// null (never derive from the funnel's white fallback). [r, g, b, a] as 0…1 sRGB.
    private fun literalRGBA(s: String): DoubleArray? {
        when (s) {
            "white" -> return doubleArrayOf(1.0, 1.0, 1.0, 1.0)
            "black" -> return doubleArrayOf(0.0, 0.0, 0.0, 1.0)
            "accent", "clear", "label", "text", "secondary", "secondaryLabel",
            "tertiary", "tertiaryLabel", "background", "systemBackground",
            "secondaryBackground", "tertiaryBackground", "groupedBackground",
            "secondaryGroupedBackground", "fill", "fillFaint", "separator", "destructive",
            -> return null
        }
        if (s.endsWith(")") && (s.startsWith("rgb(") || s.startsWith("rgba("))) {
            // Component grammar mirrors the funnel/iOS: JSE.number (the Swift
            // Double(String) grammar) with unparseable cells becoming 0 — bug-for-bug.
            // Raw-count note: the call-spelling literals above carry one unmatched open — ")" evens the file.
            val n = s.substringAfter("(").substringBefore(")")
                .split(",").map { JSE.number(it.trim()) ?: 0.0 }
            return if (n.size >= 3) doubleArrayOf(n[0] / 255, n[1] / 255, n[2] / 255,
                                                  if (n.size > 3) n[3] else 1.0)
            else null
        }
        var hex = if (s.startsWith("#")) s.substring(1) else s
        if (hex.length == 6) hex = "FF$hex"
        if (hex.length != 8) return null
        val u = hex.toLongOrNull(16) ?: return null
        return doubleArrayOf(((u shr 16) and 0xFF) / 255.0, ((u shr 8) and 0xFF) / 255.0,
                             (u and 0xFF) / 255.0, ((u shr 24) and 0xFF) / 255.0)
    }
}

/// The per-surface scheme override (system-defaults.md; the iOS ui.forcedStyle twin —
/// forcedStyle pins .dark when the ambient is unspecified): `DespiaSystemTheme(forcedDark
/// = true)` provides the committed dark scheme under this local, and every nested
/// self-wrapping root (StackRootView) adopts it instead of computing the ambient scheme.
/// `StackTheme.semantic` consults the forced scheme BEFORE the global schemeState via the
/// paired snapshot state (semantic/Pal reads are non-composable — draw lambdas included —
/// so the local itself can't reach them; the forced stack carries it there).
val LocalForcedScheme = compositionLocalOf<ColorScheme?> { null }

// A normal StackRootView lives below the Activity's DespiaSystemTheme. Mark that
// ancestry explicitly so nested roots can reuse the already-resolved dynamic M3
// scheme instead of querying Android's wallpaper resources again for every route.
// Forced surfaces/subtrees still use LocalForcedScheme and therefore keep their
// independent dark/light identity.
private val LocalDespiaScheme = compositionLocalOf<ColorScheme?> { null }

internal object DespiaThemeNestingPolicy {
    fun reusesInheritedScheme(hasInheritedScheme: Boolean, forcedDark: Boolean): Boolean =
        hasInheritedScheme && !forcedDark
}

/// The system theme root — wrap a composed tree ONCE (MainActivity does; StackRootView
/// self-wraps so every module surface inherits it). Dynamic color on API 31+, static M3
/// below; light/dark follows the system setting (isSystemInDarkTheme).
/// `forcedDark = true` commits THIS surface to the dark scheme (dynamic dark on 31+,
/// static dark below) for its lifetime — a per-surface override that never touches the
/// global stamp, so the ambient app keeps its own scheme and teardown restores it
/// deterministically (the iOS ui.forcedStyle twin; StudioEditor is the consumer).
@Composable
fun DespiaSystemTheme(forcedDark: Boolean = false, content: @Composable () -> Unit) {
    val outerForced = LocalForcedScheme.current
    val inheritedScheme = LocalDespiaScheme.current
    if (DespiaThemeNestingPolicy.reusesInheritedScheme(
            hasInheritedScheme = inheritedScheme != null,
            forcedDark = forcedDark,
        )) {
        // MaterialTheme, LocalForcedScheme, and the DSX scheme marker are all
        // inherited CompositionLocals. Re-providing their identical values for
        // every route adds a full provider layer without changing one pixel.
        content()
        return
    }
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val scheme: ColorScheme
    when {
        outerForced != null -> {
            // Nested under a forced surface (StackRootView's self-wrap inside the
            // editor cover): adopt the surface's committed scheme — no ambient compute,
            // no stamp of any kind (the outer root owns the forced stack entry).
            scheme = outerForced
        }
        forcedDark -> {
            scheme = remember(context) {
                if (Build.VERSION.SDK_INT >= 31) dynamicDarkColorScheme(context) else darkColorScheme()
            }
            // Commit the non-composable/draw-time override only in the apply phase. A
            // speculative composition can be abandoned, but an effect that never commits
            // cannot leak a forced stack entry.
            DisposableEffect(scheme) {
                StackTheme.pushForced(scheme)
                onDispose { StackTheme.popForced(scheme) }
            }
        }
        else -> {
            scheme = remember(dark, context) {
                if (Build.VERSION.SDK_INT >= 31) {
                    if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
                } else {
                    if (dark) darkColorScheme() else lightColorScheme()
                }
            }
            // Publish the global draw-time stamp only after a successful composition.
            // WithCompositionScheme below supplies the same scheme synchronously to
            // children during their first composition.
            SideEffect { StackTheme.scheme = scheme }
        }
    }
    StackTheme.WithCompositionScheme(scheme) {
        CompositionLocalProvider(
            LocalForcedScheme provides (if (forcedDark) scheme else outerForced),
            LocalDespiaScheme provides scheme,
        ) {
            MaterialTheme(colorScheme = scheme, content = content)
        }
    }
}

/// The SUBTREE scheme pin — the markup-level rider on the forced-scheme seam above, twin
/// of the Stack.swift theme= arm (`.environment(\.colorScheme, s)`, ~5039-5069): a node
/// carrying `theme="dark|light"` (or deriving its scheme from an authored literal canvas —
/// `StackTheme.subtreePin`) wraps its subtree here. Three channels, all per-subtree:
///   • MaterialTheme — real M3 components (StackButtons/StackSystemControls) read the
///     pinned roles ambiently;
///   • LocalForcedScheme — nested self-wrapping roots (StackRootView inside the subtree)
///     ADOPT the pin instead of computing the ambient scheme (DespiaSystemTheme's
///     outerForced branch), and nested pins nest naturally (the inner provider wins);
///   • a synchronous composition scope — `StackStyle.color` resolves eagerly while each
///     composable builds its modifiers/colors, and draw lambdas capture those resolved
///     colors. The pin therefore never enters the global full-SURFACE override stack.
///     Sibling dark/light subtrees remain exact through recomposition and disposal rather
///     than inheriting whichever sibling happened to mount last.
/// Dynamic color rides the pin on 31+ exactly like `forcedDark` (static M3 below).
@Composable
fun ForcedSchemeSubtree(dark: Boolean, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val scheme = remember(dark, context) {
        if (Build.VERSION.SDK_INT >= 31) {
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        } else {
            if (dark) darkColorScheme() else lightColorScheme()
        }
    }
    StackTheme.WithCompositionScheme(scheme) {
        CompositionLocalProvider(LocalForcedScheme provides scheme) {
            MaterialTheme(colorScheme = scheme, content = content)
        }
    }
}

/**
 * A Material typography role BY NAME, because `Conformance/defaults/type.json`'s Android
 * column is a name. Resolving through the composition-local theme rather than a captured
 * `Typography` instance is the point: an app that supplies its own typography restyles every
 * `<text type=...>` in one move, which is the same customization ladder the token sheet gives
 * the web. Nothing here decides a size; it only reads the one Material already decided.
 */
@Composable
internal fun materialTypography(role: String): TextStyle? = when (role) {
    "displayLarge" -> MaterialTheme.typography.displayLarge
    "displayMedium" -> MaterialTheme.typography.displayMedium
    "displaySmall" -> MaterialTheme.typography.displaySmall
    "headlineLarge" -> MaterialTheme.typography.headlineLarge
    "headlineMedium" -> MaterialTheme.typography.headlineMedium
    "headlineSmall" -> MaterialTheme.typography.headlineSmall
    "titleLarge" -> MaterialTheme.typography.titleLarge
    "titleMedium" -> MaterialTheme.typography.titleMedium
    "titleSmall" -> MaterialTheme.typography.titleSmall
    "bodyLarge" -> MaterialTheme.typography.bodyLarge
    "bodyMedium" -> MaterialTheme.typography.bodyMedium
    "bodySmall" -> MaterialTheme.typography.bodySmall
    "labelLarge" -> MaterialTheme.typography.labelLarge
    "labelMedium" -> MaterialTheme.typography.labelMedium
    "labelSmall" -> MaterialTheme.typography.labelSmall
    else -> null
}
