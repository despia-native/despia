//
//  StackStyle.kt — the DSX style engine for the Compose renderer. Kotlin twin of
//  Stack.swift's `enum StackStyle` (OpenSource/Engine/iOS/Stack.swift ~4329-4700); same
//  attribute names, same value grammar, same APPLICATION ORDER — the 18-step
//  `applicationOrder` of OpenSource/Documentation/reference/stack-style-properties.json:
//
//    padding → frame(width/height) → font → min/max-frame(grow) → background → surface
//    → gradient → radius/clip → aspectRatio → ignoreSafeArea → opacity → rotation
//    → scale → blur → border → shadow → offset → zIndex
//
//  ALL 18 STEPS are implemented (padding, frame, font, grow, background, surface,
//  gradient, radius/clip, aspectRatio, ignoreSafeArea, opacity, rotation, scale, blur,
//  border, shadow, offset, zIndex) — INCLUDING the a11y block (K4, LANDED: the
//  cross-platform accessibility contract via Modifier.semantics, both the a11y* and the
//  web-standard aria-* spellings).
//
//  ── DEVIATIONS from the Swift twin (each pinned here, none silent) ──────────────────
//  • Shape: SwiftUI wraps a view (`AnyView` in → `AnyView` out); Compose styles ride a
//    `Modifier`, so `apply` RETURNS the modifier and each element attaches it. Same
//    dispatch site (StackNodeView `content`), same read order.
//  • Wrap order: SwiftUI's `.modifier()` wraps everything BEFORE it (inner→outer);
//    Compose's `Modifier.a().b()` puts `a` OUTERMOST. `apply` therefore PREPENDS each
//    step (`step.then(m)`), so padding lands innermost and zIndex outermost — the same
//    onion as iOS, byte-for-byte the same visual contract (background paints behind the
//    padded box, clip wraps the background, opacity fades the styled whole).
//  • font: a Compose font is `TextStyle` data on the text node, not a modifier — the
//    step is exposed as `styleText(...)` (also the twin of Swift's `styleText`) and
//    consumed by the text-rendering elements; the modifier chain keeps the slot as a
//    documented no-op so the order stays literal.
//  • `width="fit"` (fit-content / SwiftUI fixedSize): implemented via IntrinsicSize —
//    width(IntrinsicSize.Max) / height(IntrinsicSize.Min), the ideal-size twin (step 2).
//  • grow anchoring (`alignY` / `align` / CSS align-items inside a grown frame — the
//    web-true TOP-LEADING default): LANDED. SwiftUI expresses it as the `alignment:`
//    argument of the same `.frame(...)` call (Stack.swift `flexFrame`); Compose has no
//    alignment argument on fillMax*/widthIn/heightIn, so the twin is the standard
//    `Modifier.wrapContentSize(anchor)` layout wrapper appended INSIDE the flexible frame:
//    it relaxes the child's MINIMUM constraints (so short content keeps its ideal size)
//    while still reporting the grown size to whatever wraps it — the fill layers
//    (background/surface/radius/border/shadow, steps 5-15) therefore still paint the whole
//    grown box, exactly like iOS. Steering order is byte-identical to `flexFrame`:
//    `alignY` (vertical) > legacy `align` > CSS `align-items` (cross-axis only, per
//    `flexDirection`), with the button-like UA exception (button/glassButton/transport
//    center on both axes when unsteered) — hence the optional `tag` argument on `apply`.
//    `Alignment.Start/End` are layout-direction-aware, like SwiftUI's leading/trailing.
//  • textCase (`upper` / `lower`): SwiftUI has a `.textCase()` VIEW modifier, so iOS can
//    case a `Text` from the style pass (Stack.swift `styleText`). Compose has no such
//    modifier and `TextStyle` carries no case field — the case therefore rides the STRING,
//    applied by the text-rendering elements through `StackStyle.textCase(attrs, s)` (the
//    same seam the desktop renderer uses). Locale: Kotlin's `uppercase()`/`lowercase()` are
//    root-locale (Swift's `.textCase` is locale-aware) — the Turkish dotted-i class of
//    difference is pinned here, not silent.
//  • lineSpacing: SwiftUI `.lineSpacing(x)` ADDS x points of leading between lines; Compose
//    has no additive leading — only `TextStyle.lineHeight`, which REPLACES the metric line
//    height. The twin is `lineHeight = fontSize + lineSpacing` (the DesktopRenderer.kt
//    precedent), which is exact when the author declares `fontSize` and unavailable
//    otherwise — so lineSpacing WITHOUT a fontSize is a documented no-op here.
//  • `dynamicType` (@ScaledMetric): Compose `.sp` is ALREADY font-scale-aware, so the
//    a11y behavior is native. `dynamicTypeMax` divides the point/dp cap by the live
//    font scale before producing `sp`, matching iOS's cap on the rendered size.
//  • color(): the THEME PASS (system-defaults.md) — semantic words (label/background/
//    fill/separator/accent/destructive…) resolve through the live M3 scheme
//    (StackTheme.semantic, roles per the Conformance/defaults/tokens.json android
//    column), the twin of UIKit's dynamic providers. The pinned iOS-DARK table below
//    is the theme-LESS fallback only (plain-JVM tests, pre-theme hosts) — byte-
//    identical to the pre-theme wave, so a missing theme root degrades, never diverges.
//    Numeric parsing rides JSE.number (the Swift `Double(String)` grammar) so "1f"-
//    style Java-isms are rejected exactly like iOS.
//  • `fontFamily=` (the `fonts` facet): faces load from ASSETS via the generated
//    DSXFontRegistry.json, not from `res/font` — Android resource names are lowercase-
//    underscore only, so a res/font family would mean copying every binary under a mangled
//    name, while the module's own file loads in place and leaves with the module. Face
//    SELECTION for a requested weight is Compose's own FontMatcher, which implements the same
//    CSS Fonts 4 algorithm the shared :core `StackFonts` pins — so the two agree by
//    construction; the kernel core is what iOS resolves through and what the corpus runs.
//    Variable axes ride `FontVariation.Settings` (API 26+; below that the static instance
//    renders and the divergence is logged once per family, never per frame).
//  • `fontDesign="rounded"`: PERMANENT DIVERGENCE, not a deferral. Apple ships SF Rounded
//    as a system face; Android's platform font set (sans-serif / serif / monospace) has no
//    rounded member, and no `FontFamily` token can conjure one — the only closure would be
//    BUNDLING a rounded face, which is a licensing + APK-size decision for the app, not a
//    kernel primitive (a module that ships a font can register it). `rounded` therefore
//    resolves to SansSerif, the honest platform default (system-defaults.md: degradation is
//    legal, divergence is not — this one is DECLARED).
//  • surface: iOS renders real materials (Liquid Glass on 26+, .ultraThinMaterial
//    below); Material 3 has no frosted material and no BACKDROP blur — Modifier.blur
//    blurs an element's own content, not what is behind it, and there is no Compose
//    primitive that captures a backdrop. Per the STRUCTURE.md fidelity rule
//    (degradation is legal, divergence is not) every material token DEGRADES to a
//    TRANSLUCENT FILL over M3's own surface-container ladder, at the alpha its
//    thickness names (`material()` below); `glassTint` falls back to a solid fill of
//    the tint, exactly the iOS <26 fallback. The ladder is M3's rather than a
//    fake-Cupertino frost because system-defaults.md makes the platform the baseline.
//    Before this the fills were a pinned DARK table whatever the theme, so a light app
//    got a dark slab; the dark table now stands only where no theme has composed.
//  • surface/gradient layer order: the catalog names the steps "…background → surface
//    → gradient…", but the Swift CODE (the reference) applies gradient BEFORE surface
//    so the material lands FURTHEST BACK (its own comment: surface frosts what's
//    behind, the gradient reads as a sheen over it). Mirrored by wrap order below —
//    the painted stack is byte-identical: surface backmost, gradient, solid fill, content.
//  • border: Compose `Modifier.border` strokes INSIDE the bounds; SwiftUI's `.overlay
//    (stroke)` centers the line on the edge (half in, half out). A 1-2pt border reads
//    the same; the half-pixel geometry difference is pinned here.
//  • shadow: elevation-style `Modifier.shadow` on the radius shape (clip=false), iOS
//    defaults mapped (black 25%, radius 8 → elevation dp). `shadowColor` rides
//    ambientColor/spotColor — honored on API 28+, default black below; `shadowX`/
//    `shadowY` have NO elevation twin (the platform light is fixed, roughly +y) —
//    both pinned here, not silent. A drawBehind/BlurMaskFilter twin with true x/y
//    offsets is a later wave. An elevation shadow also follows the SHAPE, not rotated/
//    scaled inner content (transforms ride graphicsLayer inside it).
//  • blur: `Modifier.blur` rides RenderEffect — API 31+; below 31 the platform ignores
//    it (a documented no-op, matching the surface note: degradation, not divergence).
//  • ignoreSafeArea: implemented as the standard Compose "negative padding" layout —
//    the element measures WIDER by the safe-drawing insets on the chosen edges and
//    bleeds outside its reported bounds (then consumes those insets for its subtree).
//    This matches SwiftUI when an ancestor insets content; with no ancestor insets it
//    is a no-op, exactly like iOS.
//

package despia.engine.render

import androidx.compose.runtime.Composable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import android.content.Context
import android.os.Build
import despia.engine.JSE
import despia.engine.kernelLog
import despia.engine.StackFonts
import despia.engine.StackStore
import despia.engine.SurfaceMaterials
import despia.engine.StackTooltip

object StackStyle {

    /// The style chain for one element. Twin of Swift `StackStyle.apply(view:attrs:store:item:)`.
    /// Steps are PREPENDED (see header) so the Swift application order — inner→outer — maps to
    /// Compose's outer→inner modifier chain exactly.
    ///
    /// `tag` is the element's tag, used by ONE arm: the flexible frame's content anchor, whose
    /// unsteered default is web-true top-leading EXCEPT on the button-like tags, which the web's
    /// UA sheet centers (Stack.swift `flexFrame`'s `buttonLike`). It is optional so every existing
    /// call site — including module `kotlin/` facets outside this repo slice — stays source-
    /// compatible; omitting it simply keeps the top-leading default.
    fun apply(attrs: Map<String, String>, store: StackStore, item: Map<String, Any?>?, tag: String? = null): Modifier {
        var m: Modifier = Modifier
        fun wrap(step: Modifier) { m = step.then(m) }
        val style = namedStyle(attrs["style"])
        // Style values interpolate `{{ … }}`, so any style can bind to the store
        // (e.g. opacity="{{ faded ? 0.4 : 1 }}") — the Swift `val()` closure.
        fun value(k: String): String? =
            (attrs[k] ?: style[k])?.let { JSE.interpolate(it, store, item) }
        fun num(s: String?): Float? = s?.let { JSE.number(it)?.toFloat() }

        // 1 — padding: all-sides `padding`, and/or per-axis (paddingH/paddingV) and
        //     per-edge (paddingTop/Bottom/Leading/Trailing, …Left/Right aliases).
        num(value("padding"))?.let { wrap(Modifier.padding(it.dp)) }
        (num(value("paddingH")) ?: num(value("paddingX")))?.let { wrap(Modifier.padding(horizontal = it.dp)) }
        (num(value("paddingV")) ?: num(value("paddingY")))?.let { wrap(Modifier.padding(vertical = it.dp)) }
        num(value("paddingTop"))?.let { wrap(Modifier.padding(top = it.dp)) }
        num(value("paddingBottom"))?.let { wrap(Modifier.padding(bottom = it.dp)) }
        (num(value("paddingLeading")) ?: num(value("paddingLeft")))?.let { wrap(Modifier.padding(start = it.dp)) }
        (num(value("paddingTrailing")) ?: num(value("paddingRight")))?.let { wrap(Modifier.padding(end = it.dp)) }

        // 2 — frame(width/height): fixed frame BEFORE the fills so a sized element gets a
        //     background that spans the whole frame. `width="fit"` / `height="fit"` (alias
        //     `fit-content`) = FIT-CONTENT, the hug primitive (SwiftUI .fixedSize): the
        //     element takes its content's IDEAL size on that axis — greedy descendants
        //     (scrolls, spacers, `grow`) collapse to content. Compose twin: IntrinsicSize —
        //     Max on width (a text's ideal width is its unwrapped width), Min on height
        //     (the natural wrap height at the resolved width).
        val wTok = value("width"); val hTok = value("height")
        num(wTok)?.let { wrap(Modifier.width(it.dp)) }
        num(hTok)?.let { wrap(Modifier.height(it.dp)) }
        val isFit: (String?) -> Boolean = { it == "fit" || it == "fit-content" }
        if (isFit(wTok)) wrap(Modifier.width(IntrinsicSize.Max))
        if (isFit(hTok)) wrap(Modifier.height(IntrinsicSize.Min))

        // 3 — font: rides TextStyle in Compose, not the modifier chain — see `styleText`
        //     below (the slot is kept here so the 18-step order stays literal).

        // 4 — min/max-frame(grow): `grow="true|both"` fills both axes, `grow="width"`/
        //     `grow="height"` one; min/max clamp.
        val minW = num(value("minWidth")); val maxW = num(value("maxWidth"))
        val minH = num(value("minHeight")); val maxH = num(value("maxHeight"))
        val grow = value("grow")
        val growW = grow == "true" || grow == "both" || grow == "width"
        val growH = grow == "true" || grow == "both" || grow == "height"
        if (minW != null || maxW != null || minH != null || maxH != null || growW || growH) {
            var f: Modifier = Modifier
            if (growW) f = f.fillMaxWidth()
            if (growH) f = f.fillMaxHeight()
            if (minW != null || maxW != null) {
                f = f.widthIn(min = minW?.dp ?: Dp.Unspecified,
                              max = if (growW) Dp.Unspecified else maxW?.dp ?: Dp.Unspecified)
            }
            if (minH != null || maxH != null) {
                f = f.heightIn(min = minH?.dp ?: Dp.Unspecified,
                               max = if (growH) Dp.Unspecified else maxH?.dp ?: Dp.Unspecified)
            }
            // Content anchoring inside the flexible frame — the `alignment:` argument of the
            // Swift `.frame(...)` (flexFrame), expressed as Compose's wrapContentSize wrapper
            // (see header). Appended LAST inside `f`, so it is the innermost arm of this step:
            // it relaxes the child's minimum constraints and places it at the anchor, while the
            // frame itself still reports the grown size outward.
            f = f.wrapContentSize(frameAnchor({ k -> value(k) }, tag), unbounded = false)
            wrap(f)
        }

        // 5 — background: solid fill spanning the final frame; carries the radius as its
        //     shape (Swift: RoundedRectangle(cornerRadius:).fill).
        value("background")?.let { bg ->
            val r = num(value("radius")) ?: 0f
            wrap(Modifier.background(color(bg), if (r > 0f) RoundedCornerShape(r.dp) else RectangleShape))
        }
        // 6b — gradient FIRST in code, like the Swift reference (see DEVIATIONS: prepending
        //      lands the LATER wrap outermost = painted first, so the stack comes out
        //      surface backmost → gradient → solid fill → content, same as iOS).
        //      The whole declared surface — linear · radial · angular · mesh, with stops,
        //      angle, centre and radius — is StackGradients.kt, over the SAME
        //      ControlsCore.resolveGradient decision the Swift renderer paints from;
        //      `gradientDir` stays an exact alias. Mesh degrades to layers, so this is a
        //      list. No shape — the radius clip (step 7) wraps it.
        StackGradients.layers { k -> value(k) }.asReversed().forEach { wrap(Modifier.background(it)) }
        // 6 — surface: every material token (glass/ultraThin/thin/regular/thick/sheet)
        //     degrades to the pinned dim translucent fill (`material()` — see DEVIATIONS);
        //     `glassTint` falls back to a solid fill of the tint (the iOS <26 fallback).
        //     Radius defaults like Swift: 24 for sheet, else 16. `glassInteractive` is the
        //     press response (StackGlass.kt) — the geometry of the iOS 26 press-stretch, since
        //     Material 3 has no material to stretch. Wrapped AFTER the fill so it lands outside
        //     it: the glass and its content move together instead of the content sliding under
        //     a static pane.
        value("surface")?.let { tok ->
            val r = num(value("radius")) ?: (if (tok == "sheet") 24f else 16f)
            val fill = value("glassTint")?.let { color(it) } ?: material(tok)
            wrap(Modifier.background(fill, RoundedCornerShape(r.dp)))
            if (value("glassInteractive") == "true") wrap(Modifier.glassPress())
        }
        // 7 — radius/clip: clip wraps the background (Swift .clipShape AFTER .background).
        num(value("radius"))?.let { wrap(Modifier.clip(RoundedCornerShape(it.dp))) }
        // 8 — aspectRatio: "W:H" | bare number → Modifier.aspectRatio (fit). Compose
        //     throws on a non-positive ratio, so those parses drop — the same net no-op
        //     as the Swift zero-denominator guard.
        aspect(value("aspectRatio"))?.takeIf { it > 0f && it.isFinite() }
            ?.let { wrap(Modifier.aspectRatio(it)) }
        // 9 — ignoreSafeArea/fullBleed: edges = true|all / top / bottom / horizontal|sides /
        //     vertical — the negative-padding layout + WindowInsets consumption (see
        //     DEVIATIONS + `bleedSafeArea`).
        (value("ignoreSafeArea") ?: value("fullBleed"))?.let { wrap(Modifier.bleedSafeArea(it)) }
        // 10 — opacity
        num(value("opacity"))?.let { wrap(Modifier.alpha(it)) }
        // 11 — rotation: degrees → graphicsLayer rotationZ (the .rotationEffect twin).
        num(value("rotation"))?.let { deg -> wrap(Modifier.graphicsLayer { rotationZ = deg }) }
        // 12 — scale: uniform → graphicsLayer scaleX/scaleY (the .scaleEffect twin).
        num(value("scale"))?.let { sc -> wrap(Modifier.graphicsLayer { scaleX = sc; scaleY = sc }) }
        // 13 — blur: Gaussian radius → Modifier.blur (RenderEffect; see DEVIATIONS: API 31+,
        //      a platform no-op below — degradation, not divergence).
        num(value("blur"))?.let { wrap(Modifier.blur(it.dp)) }
        // 14 — border: borderColor gates (like Swift); borderWidth defaults 1, stroked on
        //      the radius shape. Compose strokes INSIDE the bounds — pinned in DEVIATIONS.
        value("borderColor")?.let { bc ->
            val r = num(value("radius")) ?: 0f
            wrap(Modifier.border((num(value("borderWidth")) ?: 1f).dp, color(bc),
                                 if (r > 0f) RoundedCornerShape(r.dp) else RectangleShape))
        }
        // 15 — shadow: a DRAWN shadow on the radius shape (StackShadow.kt), iOS defaults
        //      (black 25%, blur 8, x 0, y 2). This used to be an elevation Modifier.shadow,
        //      which asks the PLATFORM to light the element from a fixed position — so
        //      shadowX/shadowY had nowhere to go and an author who leaned a shadow sideways
        //      got one straight down. Painting it here is what makes the offsets real and the
        //      blur weight match CSS and SwiftUI (Article 10).
        value("shadow")?.let { sh ->
            val r = num(value("radius")) ?: 0f
            val c = value("shadowColor")?.let { color(it) } ?: Color.Black.copy(alpha = 0.25f)
            wrap(
                Modifier.dsxShadow(
                    blur = num(sh) ?: 8f,
                    color = c,
                    dx = num(value("shadowX")) ?: 0f,
                    dy = num(value("shadowY")) ?: 2f,
                    cornerRadius = r,
                )
            )
        }
        // 16 — offset: LAST positional adjustment of the FULLY-styled element (CSS-transform
        //      semantics — frame, background, border and shadow all ride along). `offset`
        //      aliases offsetY, like iOS; kept present whenever declared (stable identity)
        //      so a bound value tweens.
        if (value("offset") != null || value("offsetX") != null || value("offsetY") != null) {
            val ox = num(value("offsetX")) ?: 0f
            val oy = num(value("offsetY")) ?: num(value("offset")) ?: 0f
            wrap(Modifier.offset(x = ox.dp, y = oy.dp))
        }
        // 17 — zIndex: draw order within the parent stack.
        num(value("zIndex"))?.let { wrap(Modifier.zIndex(it)) }
        // 18 — ACCESSIBILITY (K4, LANDED): the cross-platform contract (StackReference →
        //      Accessibility), the Swift arm's Compose twin. TWO equal spellings per key —
        //      the DSX one and the web-standard aria one (first present wins):
        //        a11yGroup="true" · role="group"     → semantics(mergeDescendants = true)
        //        a11yLabel        · aria-label       → contentDescription
        //        a11yHint         · aria-description → appended to the description (documented)
        //          (a resolved `tooltip=` fills this slot when neither is authored — the
        //           `described` duty of input/tooltip.json; a11yHintSlot below)
        //        a11yValue        · aria-valuetext   → stateDescription
        //        a11yTrait        · role             → heading()/Role.Button/Role.Image/selected
        //        a11yHidden       · aria-hidden      → clearAndSetSemantics (outermost — wins)
        //      Free default: any element carrying on:tap announces as a button. Wrapped LAST
        //      (= OUTERMOST under the prepend rule), matching the Swift application point.
        run {
            fun both(a: String, b: String): String? = value(a) ?: value(b)
            // The BUTTON role words (`destructive`/`cancel` — system-defaults.md variant
            // grammar, StackButtons.kt) are never a11y traits, mirroring the web (mount.ts
            // keeps exactly these two off the ARIA role); every other value stays the
            // verbatim accessibility pass-through.
            val roleAttr = value("role")?.takeIf { it !in SystemButton.BUTTON_ROLES }
            val label = both("a11yLabel", "aria-label")
            val hint = a11yHintSlot { value(it) }
            val stateValue = both("a11yValue", "aria-valuetext")
            val traits = value("a11yTrait") ?: roleAttr?.takeIf { it != "group" }
            val grouped = attrs["a11yGroup"] == "true" || roleAttr == "group"
            val tappable = attrs.containsKey("on:tap")
            val hasAny = grouped || label != null || hint != null || stateValue != null ||
                traits != null || tappable
            if (hasAny) {
                wrap(Modifier.semantics(mergeDescendants = grouped) {
                    val spoken = when {
                        label != null && !hint.isNullOrEmpty() -> "$label. $hint"
                        label != null -> label
                        !hint.isNullOrEmpty() -> hint
                        else -> null
                    }
                    if (spoken != null && spoken.isNotEmpty()) contentDescription = spoken
                    if (!stateValue.isNullOrEmpty()) stateDescription = stateValue
                    val parts = (traits ?: "").split(",").map { it.trim() }
                    when {
                        parts.contains("header") -> heading()
                        parts.contains("button") || parts.contains("link") -> role = Role.Button
                        parts.contains("image") -> role = Role.Image
                        traits == null && tappable -> role = Role.Button
                    }
                    if (parts.contains("selected")) selected = true
                })
            }
            if (both("a11yHidden", "aria-hidden") == "true") {
                wrap(Modifier.clearAndSetSemantics { })
            }
        }
        return m
    }

    /// The a11y HINT slot for the arm above (pure; plain-JVM tested — StackTooltipAdapterTest):
    /// the two equal authored spellings first — either PRESENT key wins, even one resolving
    /// empty (the Swift `attrs[...] == nil` gate agrees) — then the resolved `tooltip=` text,
    /// the `described` duty of OpenSource/Conformance/input/tooltip.json: a tooltip's content
    /// is never gated behind hover, so on a touch surface (which never reveals the bubble —
    /// Article 7) assistive tech still reads it. iOS twin: decorate's accessibilityHint arm.
    internal fun a11yHintSlot(value: (String) -> String?): String? =
        value("a11yHint") ?: value("aria-description") ?: StackTooltip.resolve(value("tooltip"), null)?.text

    /// The content anchor for a flexible frame — the pure twin of Swift `flexFrame`'s
    /// `Alignment(horizontal:vertical:)` computation (Stack.swift ~6009-6036), extracted so it
    /// can be reasoned about (and unit-tested) without a composition. Steering order, per axis:
    ///   horizontal — `align=leading|trailing` > `align=center` / `align-items: center` >
    ///                `align-items: flex-end|end` > `align-items: flex-start|start` > default
    ///   vertical   — `alignY=top|bottom` (or `align=top|bottom`) > `align-items: flex-end|end`
    ///                > `align=center` / `align-items: center` > `align-items: flex-start|start`
    ///                > default
    /// CSS `align-items` steers the CROSS axis only — horizontal for a column, vertical for a
    /// row (`flexDirection`). The unsteered default is web-true TOP-LEADING, except on the
    /// button-like tags, which every browser's UA sheet centers.
    internal fun frameAnchor(value: (String) -> String?, tag: String?): Alignment {
        val alignY = value("alignY")
        val align = value("align")
        val isRow = (value("flexDirection") ?: "").startsWith("row")
        val items = value("alignItems")
        val itemsH = if (isRow) null else items
        val itemsV = if (isRow) items else null
        val buttonLike = tag == "button" || tag == "glassButton" || tag == "transport"
        val horizontal = when {
            align == "leading" -> 0
            align == "trailing" -> 2
            align == "center" || itemsH == "center" -> 1
            itemsH == "flex-end" || itemsH == "end" -> 2
            itemsH == "flex-start" || itemsH == "start" -> 0
            buttonLike -> 1
            else -> 0
        }
        val vRaw = alignY ?: (if (align == "top" || align == "bottom") align else null)
        // A LONE alignY="center" anchors CENTER — the former top fall-through was a pinned
        // bug-for-bug Swift reproduction, fixed iOS-first and retired together (R2.2).
        val vertical = when {
            vRaw == "top" -> 0
            vRaw == "bottom" -> 2
            vRaw == "center" -> 1
            itemsV == "flex-end" || itemsV == "end" -> 2
            align == "center" || itemsV == "center" -> 1
            itemsV == "flex-start" || itemsV == "start" -> 0
            buttonLike -> 1
            else -> 0
        }
        return when (vertical * 3 + horizontal) {
            0 -> Alignment.TopStart
            1 -> Alignment.TopCenter
            2 -> Alignment.TopEnd
            3 -> Alignment.CenterStart
            4 -> Alignment.Center
            5 -> Alignment.CenterEnd
            6 -> Alignment.BottomStart
            7 -> Alignment.BottomCenter
            else -> Alignment.BottomEnd
        }
    }

    /// `textCase="upper|lower"` — SwiftUI cases the VIEW (`Text.textCase`); Compose has no such
    /// modifier and no TextStyle field, so the case rides the STRING here and the text-rendering
    /// elements pipe their resolved content through this (see header). Any other value is a
    /// no-op, exactly like the Swift ternary's `nil` arm.
    fun textCase(attrs: Map<String, String>, s: String): String = when (attrs["textCase"]) {
        "upper" -> s.uppercase()
        "lower" -> s.lowercase()
        else -> s
    }

    /// `fontFamily=` — the build's FONT REGISTRY (assets/DSXFontRegistry.json, generated by
    /// prepare_modules from every enabled module's `fonts` block), resolved to a Compose
    /// `FontFamily`. Twin of Swift `DSXFontBook`.
    ///
    /// WHY THE REGISTRY. iOS needs each face's PostScript name; Android needs the asset path and
    /// the weight/slant each file actually carries. Both are read out of the fonts at build time
    /// and written to one file, so neither renderer guesses — guessing is how an app silently
    /// renders the system face.
    ///
    /// The SELECTION law (which face answers a requested weight, when italic synthesises, how a
    /// variable axis clamps) is the shared pure core :core `StackFonts`, pinned by
    /// OpenSource/Conformance/fonts/matching.json. Nothing here reimplements it.
    ///
    /// ANDROID SEAMS (pinned, none silent):
    ///  • Faces load from ASSETS (`Typeface.createFromAsset`), not `res/font`: Android resource
    ///    names are lowercase-underscore only, so a res/font family means COPYING every binary
    ///    under a mangled name, while the module's own file loads in place and leaves with the
    ///    module (file-presence law).
    ///  • Variable axes are `FontVariationSettings`, API 26+. Below that the face renders at its
    ///    static instance and the divergence is logged ONCE per family — a per-frame log on a
    ///    scrolling list is worse than the divergence it reports.
    object StackFontBook {

        data class Family(
            val faces: List<StackFonts.Face>,
            val variable: Boolean,
            val axes: Map<String, Pair<Double, Double>>,
            val defaults: Map<String, Double>,
            val fallback: List<String>,
        )

        private const val REGISTRY_ASSET = "DSXFontRegistry.json"

        @Volatile private var loaded = false
        @Volatile private var families: Map<String, Family> = emptyMap()
        private val typefaces = java.util.concurrent.ConcurrentHashMap<String, FontFamily>()
        private val axisWarned = java.util.Collections.synchronizedSet(mutableSetOf<String>())

        val declaredNames: List<String> get() = families.keys.sorted()

        fun family(name: String?): Family? = name?.let { families[it] }

        /** True when the family ships a REAL italic face — the signal `styleText` uses to skip
         *  Compose's synthetic slant so a declared italic is not obliqued on top of being one. */
        fun hasItalicFace(name: String?): Boolean = family(name)?.faces?.any { it.italic } == true

        /** The CSS numeric weight behind a `fontWeight=` word. A bare number passes through. */
        fun cssWeight(s: String?): Int {
            val n = s?.toIntOrNull()
            if (n != null && n in 1..1000) return n
            return when (s) {
                "bold" -> 700
                "semibold" -> 600
                "medium" -> 500
                "heavy" -> 800
                else -> 400
            }
        }

        /** Fail-open (Article 7): no registry asset ⇒ no families ⇒ every `fontFamily` resolves
         *  null and the caller keeps the platform font, exactly the pre-facet behavior. */
        fun load(context: Context) {
            if (loaded) return
            synchronized(this) {
                if (loaded) return
                families = runCatching {
                    context.assets.open(REGISTRY_ASSET).use { parse(it.readBytes().toString(Charsets.UTF_8)) }
                }.getOrDefault(emptyMap())
                loaded = true
            }
        }

        internal fun parse(text: String): Map<String, Family> {
            val root = org.json.JSONObject(text).optJSONObject("families") ?: return emptyMap()
            val out = LinkedHashMap<String, Family>()
            for (name in root.keys()) {
                val row = root.optJSONObject(name) ?: continue
                val faceArray = row.optJSONArray("faces") ?: continue
                val faces = ArrayList<StackFonts.Face>(faceArray.length())
                for (i in 0 until faceArray.length()) {
                    val face = faceArray.optJSONObject(i) ?: continue
                    if (!face.has("weight")) continue
                    faces.add(
                        StackFonts.Face(
                            weight = face.optInt("weight"),
                            italic = face.optBoolean("italic", false),
                            file = face.optString("file").takeIf { it.isNotEmpty() },
                            postscriptName = face.optString("postscriptName").takeIf { it.isNotEmpty() },
                        )
                    )
                }
                if (faces.isEmpty()) continue
                val axes = LinkedHashMap<String, Pair<Double, Double>>()
                row.optJSONObject("axes")?.let { declared ->
                    for (tag in declared.keys()) {
                        val range = declared.optJSONArray(tag) ?: continue
                        if (range.length() == 2) axes[tag] = range.optDouble(0) to range.optDouble(1)
                    }
                }
                val defaults = LinkedHashMap<String, Double>()
                row.optJSONObject("defaults")?.let { declared ->
                    for (tag in declared.keys()) defaults[tag] = declared.optDouble(tag)
                }
                val fallback = ArrayList<String>()
                row.optJSONArray("fallback")?.let { chain ->
                    for (i in 0 until chain.length()) fallback.add(chain.optString(i))
                }
                out[name] = Family(
                    faces = faces,
                    variable = row.optBoolean("variable", false),
                    axes = axes,
                    defaults = defaults,
                    fallback = fallback.ifEmpty { listOf("system") },
                )
            }
            return out
        }

        /**
         * Resolve a declared family to a Compose `FontFamily`. null ⇒ the caller keeps the
         * platform font, which is the last rung of the declared fallback chain.
         *
         * One `FontFamily` per (family, axes) key, cached: `createFromAsset` reads and parses the
         * file, and doing that inside composition would re-read the face on every recomposition.
         */
        fun resolve(context: Context, name: String, variation: String?): FontFamily? {
            load(context)
            val family = families[name] ?: return null
            val requested = StackFonts.parseVariation(variation)
            val axes = LinkedHashMap<String, Double>(family.defaults)
            if (requested.isNotEmpty()) axes.putAll(StackFonts.resolveVariation(family.axes, requested).applied)
            val key = "$name|" + axes.entries.sortedBy { it.key }.joinToString(",") { "${it.key} ${it.value}" }
            typefaces[key]?.let { return it }

            val settings = axes.entries.sortedBy { it.key }
                .map { FontVariation.Setting(it.key, it.value.toFloat()) }
            if (settings.isNotEmpty() && Build.VERSION.SDK_INT < Build.VERSION_CODES.O &&
                axisWarned.add(name)
            ) {
                kernelLog("[dsx.fonts] '$name': variable axes need API 26+ (this device is API " +
                          "${Build.VERSION.SDK_INT}) — rendering the static instance.")
            }

            val variationSettings = if (settings.isEmpty()) FontVariation.Settings()
                                    else FontVariation.Settings(*settings.toTypedArray())
            val fonts = family.faces.mapNotNull { face ->
                val asset = face.file ?: return@mapNotNull null
                runCatching {
                    Font(
                        path = asset,
                        assetManager = context.assets,
                        weight = FontWeight(face.weight),
                        style = if (face.italic) FontStyle.Italic else FontStyle.Normal,
                        variationSettings = variationSettings,
                    )
                }.getOrNull()
            }
            if (fonts.isEmpty()) return null
            val resolved = FontFamily(fonts)
            typefaces[key] = resolved
            return resolved
        }
    }

    /// Text styling for `<text>`-family elements — the font slot of step 3 plus Swift's
    /// `styleText` extras (italic / underline / strikethrough / tracking / textAlign /
    /// lineSpacing are read from the same attribute names). lineLimit is layout-side and
    /// handled by the text element (maxLines); `textCase` cases the string, not the style
    /// (see `textCase` above + the header).
    @Composable
    fun styleText(attrs: Map<String, String>, store: StackStore, item: Map<String, Any?>?, color: Color): TextStyle {
        val style = namedStyle(attrs["style"])
        fun value(k: String): String? =
            (attrs[k] ?: style[k])?.let { JSE.interpolate(it, store, item) }
        var t = TextStyle(color = color)
        val fs = value("fontSize")?.let { JSE.number(it) }
        // A DECLARED family (a `fonts` block on some enabled module) beats the system design
        // axis; `fontDesign` keeps its meaning on the system fallback, which is what
        // `design(...)` still paints when the family does not resolve.
        val declaredFamily = value("fontFamily")
        val custom = declaredFamily?.let {
            StackFontBook.resolve(LocalContext.current.applicationContext, it, value("fontVariation"))
        }
        if (fs != null) {
            // Compose .sp is font-scale-aware natively. When an explicitly dynamic
            // font also declares a maximum, convert that rendered-size cap back to sp
            // with the live scale so the cap is honored at accessibility sizes too.
            val cap = if (value("dynamicType") == "true")
                value("dynamicTypeMax")?.let { JSE.number(it) }
            else null
            val cappedSp = cappedDynamicTypeSp(fs, cap, LocalDensity.current.fontScale)
            t = t.copy(fontSize = cappedSp.sp,
                       fontWeight = weight(value("fontWeight")),
                       fontFamily = custom ?: design(value("fontDesign")))
        } else if (custom != null) {
            // No `fontSize`: the family still applies, at the inherited (scale-aware) size —
            // a custom family must never cost the accessibility text setting.
            t = t.copy(fontWeight = weight(value("fontWeight")), fontFamily = custom)
        }
        // OpenType features: Compose exposes them as the platform `fontFeatureSettings` string,
        // which takes the same four-character tags the shared parser validates.
        val features = StackFonts.parseFeatures(value("fontFeature"))
        if (features.isNotEmpty()) t = t.copy(fontFeatureSettings = features.joinToString(", "))
        // A declared family shipping a REAL italic face already selected it above; asking
        // Compose to slant it again obliques an italic.
        if (attrs["italic"] == "true" && !(custom != null && StackFontBook.hasItalicFace(declaredFamily))) {
            t = t.copy(fontStyle = FontStyle.Italic)
        }
        val decos = mutableListOf<TextDecoration>()
        if (attrs["underline"] == "true") decos.add(TextDecoration.Underline)
        if (attrs["strikethrough"] == "true") decos.add(TextDecoration.LineThrough)
        if (decos.isNotEmpty()) t = t.copy(textDecoration = TextDecoration.combine(decos))
        attrs["tracking"]?.let { JSE.number(it) }?.let { t = t.copy(letterSpacing = it.sp) }
        attrs["textAlign"]?.let { t = t.copy(textAlign = textAlign(it)) }
        // lineSpacing: SwiftUI ADDS leading between lines; Compose only replaces the whole
        // line height, so the twin is fontSize + lineSpacing (see header — exact when the
        // author declared a fontSize, a documented no-op without one).
        val ls = attrs["lineSpacing"]?.let { JSE.number(it) }
        if (ls != null && fs != null) {
            t = t.copy(lineHeight = (t.fontSize.value + ls.toFloat()).coerceAtLeast(0.5f).sp)
        }
        return t
    }

    internal fun cappedDynamicTypeSp(size: Double, cap: Double?, fontScale: Float): Float {
        val base = size.toFloat()
        if (cap == null) return base
        val scale = fontScale.takeIf { it.isFinite() && it > 0f } ?: 1f
        return minOf(base, cap.toFloat() / scale)
    }

    private fun textAlign(s: String): TextAlign = when (s) {
        "center" -> TextAlign.Center
        "trailing", "right" -> TextAlign.End
        else -> TextAlign.Start
    }

    /// `fontWeight` — same tokens as Swift `weight(_:)`. SwiftUI `.heavy` ≈ W800.
    fun weight(s: String?): FontWeight = when (s) {
        "bold" -> FontWeight.Bold
        "semibold" -> FontWeight.SemiBold
        "medium" -> FontWeight.Medium
        "heavy" -> FontWeight.ExtraBold
        else -> FontWeight.Normal
    }

    /// `fontDesign` = default / rounded / serif / monospaced. DECLARED DIVERGENCE (permanent,
    /// not a deferral — see header): Android's platform font set has no rounded member and no
    /// `FontFamily` token can conjure one, so `rounded` resolves to the honest platform sans.
    /// Closing it would mean BUNDLING a rounded face, which is an app-level licensing/size
    /// decision (a module that ships a font registers it), never a kernel primitive.
    fun design(s: String?): FontFamily? = when (s) {
        "rounded" -> FontFamily.SansSerif   // no system rounded face on Android — declared, above
        "serif" -> FontFamily.Serif
        "monospaced", "mono" -> FontFamily.Monospace
        else -> null
    }

    /// The legacy named styles (`style="card"`) — byte-identical to the Swift table.
    private val styles: Map<String, Map<String, String>> = mapOf(
        "sheet" to mapOf("padding" to "20", "background" to "#121212", "radius" to "24", "surface" to "sheet"),
        "card" to mapOf("padding" to "16", "background" to "rgba(255,255,255,0.06)", "radius" to "16"),
        "heading" to mapOf("fontSize" to "24", "fontWeight" to "bold"),
        "subheading" to mapOf("fontSize" to "15"),
        "rowTitle" to mapOf("fontSize" to "17", "fontWeight" to "semibold"),
        "price" to mapOf("fontSize" to "17", "fontWeight" to "bold"),
    )

    fun namedStyle(name: String?): Map<String, String> {
        if (name == null) return emptyMap()
        val out = HashMap<String, String>()
        for (n in name.split(" ")) styles[n]?.let { out.putAll(it) }
        return out
    }

    /// `aspectRatio` as "W:H" (e.g. 16:9) or a bare number — twin of Swift `aspect(_:)`
    /// (exactly two numeric parts, non-zero denominator; numbers ride the Swift grammar).
    fun aspect(s: String?): Float? {
        if (s == null) return null
        if (s.contains(":")) {
            val p = s.split(":").mapNotNull { JSE.number(it) }
            return if (p.size == 2 && p[1] != 0.0) (p[0] / p[1]).toFloat() else null
        }
        return JSE.number(s)?.toFloat()
    }

    /// `surface` material — the Compose degradation of the iOS materials (see DEVIATIONS).
    ///
    /// Material 3 has no frosted material and no backdrop blur (`Modifier.blur` blurs an
    /// element's OWN content, not what is behind it), so a token here is a translucent fill and
    /// [SurfaceMaterials.alpha] carries what separates one token from another.
    ///
    /// What it must not be is a fill of the WRONG COLOUR: this used to be a pinned dark table
    /// (base #252525) regardless of theme, so on a light app `surface="regular"` painted a dark
    /// slab under the content. That is not degradation, it is a different design - and
    /// system-defaults.md makes the platform the baseline, so the ladder is M3's own surface
    /// containers, which is Material's answer to "a layered surface".
    ///
    /// [StackTheme.scheme] is null before any theme root has composed (plain-JVM tests,
    /// pre-theme hosts). There the pinned dark base stands, byte-identical to the pre-theme
    /// wave, for the same reason `color()` keeps its own iOS-dark fallback.
    fun material(name: String): Color {
        // Named `opacity`, not `alpha`: `androidx.compose.ui.draw.alpha` is imported here as a
        // Modifier extension and a local of that name resolves to it at the call site below.
        val opacity = SurfaceMaterials.alpha(name)
        val scheme = StackTheme.scheme
            ?: return Color(SurfaceMaterials.FALLBACK_BASE).copy(alpha = opacity)
        val base = when (name) {
            "thin" -> scheme.surfaceContainer
            "regular" -> scheme.surfaceContainerHigh
            "thick" -> scheme.surfaceContainerHighest
            else -> scheme.surfaceContainerLow
        }
        return base.copy(alpha = opacity)
    }

    /// `ignoreSafeArea` / `fullBleed` edge tokens → the insets sides — twin of Swift
    /// `safeEdges(_:)`: "true"/"all" (default) · top · bottom · horizontal|sides · vertical.
    fun safeSides(s: String): WindowInsetsSides = when (s) {
        "top"                  -> WindowInsetsSides.Top
        "bottom"               -> WindowInsetsSides.Bottom
        "horizontal", "sides"  -> WindowInsetsSides.Horizontal
        "vertical"             -> WindowInsetsSides.Vertical
        else                   -> WindowInsetsSides.Horizontal + WindowInsetsSides.Vertical
    }

    /// The ignoreSafeArea layout (see DEVIATIONS): measure the element WIDER by the
    /// safe-drawing insets on the chosen edges, bleed it outside its reported bounds
    /// (place at -inset), then CONSUME those insets for the subtree so children don't
    /// re-inset. With no ancestor insets the insets are zero — a no-op, exactly like iOS.
    private fun Modifier.bleedSafeArea(edges: String): Modifier = composed {
        val insets = WindowInsets.safeDrawing.only(safeSides(edges))
        Modifier
            .layout { measurable, constraints ->
                val l = insets.getLeft(this, layoutDirection)
                val t = insets.getTop(this)
                val r = insets.getRight(this, layoutDirection)
                val b = insets.getBottom(this)
                val placeable = measurable.measure(constraints.copy(
                    maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth + l + r
                               else constraints.maxWidth,
                    maxHeight = if (constraints.hasBoundedHeight) constraints.maxHeight + t + b
                                else constraints.maxHeight))
                layout((placeable.width - l - r).coerceAtLeast(0),
                       (placeable.height - t - b).coerceAtLeast(0)) {
                    placeable.place(-l, -t)
                }
            }
            .consumeWindowInsets(insets)
    }

    /// Color grammar — twin of Swift `StackStyle.color(_:)`: named / semantic / rgb(a) /
    /// #RRGGBB / #AARRGGBB, unknown → white. Semantic words resolve through the LIVE M3
    /// scheme first (StackTheme.semantic — the theme pass, system-defaults.md); the
    /// pinned iOS-dark table below is the theme-less fallback (see DEVIATIONS).
    fun color(s: String): Color {
        when (s) {
            "white" -> return Color.White
            "black" -> return Color.Black
            "clear" -> return Color.Transparent
        }
        StackTheme.semantic(s)?.let { return it }
        when (s) {
            "accent" -> return Color(red = 1f, green = 0.18f, blue = 0.33f)
            "label", "text" -> return Color.White
            "secondary", "secondaryLabel" -> return Color(0x99EBEBF5)
            "tertiary", "tertiaryLabel" -> return Color(0x4DEBEBF5)
            "background", "systemBackground" -> return Color.Black
            "secondaryBackground" -> return Color(0xFF1C1C1E)
            "tertiaryBackground" -> return Color(0xFF2C2C2E)
            "groupedBackground" -> return Color.Black
            "secondaryGroupedBackground" -> return Color(0xFF1C1C1E)
            "fill" -> return Color(0x5C787880)   // iOS systemFill (dark) — the corpus `fill` slot (tokens.json; was the old secondarySystemFill 0x52 value)
            "fillFaint" -> return Color(0x2E787880)
            "separator" -> return Color(0xA6545458)
            "destructive" -> return Color(0xFFFF453A)   // iOS systemRed (dark) — the pre-theme pin
        }
        if (s.startsWith("rgba(") || s.startsWith("rgb(")) {
            val n = s.substringAfter("(").substringBefore(")")
                .split(",").map { JSE.number(it.trim()) ?: 0.0 }
            if (n.size >= 3) {
                return Color(red = (n[0] / 255).toFloat().coerceIn(0f, 1f),
                             green = (n[1] / 255).toFloat().coerceIn(0f, 1f),
                             blue = (n[2] / 255).toFloat().coerceIn(0f, 1f),
                             alpha = if (n.size > 3) n[3].toFloat().coerceIn(0f, 1f) else 1f)
            }
        }
        var hex = if (s.startsWith("#")) s.substring(1) else s
        if (hex.length == 6) hex = "FF$hex"
        if (hex.length == 8) {
            hex.toLongOrNull(16)?.let { v ->
                return Color(red = ((v shr 16) and 0xFF).toFloat() / 255f,
                             green = ((v shr 8) and 0xFF).toFloat() / 255f,
                             blue = (v and 0xFF).toFloat() / 255f,
                             alpha = ((v shr 24) and 0xFF).toFloat() / 255f)
            }
        }
        return Color.White
    }
}
