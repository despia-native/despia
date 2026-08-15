//
//  StackStyleTest.kt — plain-JVM units for the renderer's pure halves (color grammar,
//  platform override resolution, named styles). Compose Color/TextStyle are pure Kotlin
//  value types, so no Robolectric is needed; the composables themselves are gated by
//  compilation this wave (see RenderSmoke.kt).
//

package despia.engine.render

import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StackStyleTest {

    private fun argb(c: Color): Int = c.toArgb()

    // ── color(): the Swift StackStyle.color grammar ───────────────────────────────────

    @Test fun colorNamed() {
        assertEquals(argb(Color.White), argb(StackStyle.color("white")))
        assertEquals(argb(Color.Black), argb(StackStyle.color("black")))
        assertEquals(argb(Color.Transparent), argb(StackStyle.color("clear")))
    }

    @Test fun colorHex6() {
        assertEquals(0xFF112233.toInt(), argb(StackStyle.color("#112233")))
        assertEquals(0xFF112233.toInt(), argb(StackStyle.color("112233")))   // bare hex, like iOS
    }

    @Test fun colorHex8IsAARRGGBB() {
        assertEquals(0x80FF0000.toInt(), argb(StackStyle.color("#80FF0000")))
    }

    @Test fun colorRgbAndRgba() {
        assertEquals(0xFF102030.toInt(), argb(StackStyle.color("rgb(16, 32, 48)")))
        assertEquals(0x80102030.toInt(), argb(StackStyle.color("rgba(16,32,48,0.5019608)")))
    }

    @Test fun colorUnknownFallsBackToWhite() {
        assertEquals(argb(Color.White), argb(StackStyle.color("not-a-color")))
        assertEquals(argb(Color.White), argb(StackStyle.color("#12")))
    }

    // The theme-aware semantic resolution (StackTheme + the defaults corpus) is gated by
    // DefaultsTokensTest; here only the NEW vocabulary word's theme-less pin is grammar.
    @Test fun colorDestructiveThemelessPin() {
        StackTheme.scheme = null   // this test asserts the FALLBACK pin — never a leaked scheme
        assertEquals(0xFFFF453A.toInt(), argb(StackStyle.color("destructive")))   // iOS systemRed (dark)
    }

    // ── resolvePlatform(): key:android wins here, key:ios drops ───────────────────────

    @Test fun platformAndroidWins() {
        val a = mapOf("icon" to "bell", "icon:android" to "notifications", "icon:ios" to "bell.fill")
        assertEquals(mapOf("icon" to "notifications"), resolvePlatform(a))
    }

    @Test fun platformUntaggedPassThrough() {
        val a = mapOf("on:tap" to "x = 1", "arg:rate" to "2")   // `:ios`/`:android` SUFFIX only
        assertEquals(a, resolvePlatform(a))
    }

    // ── namedStyle(): the legacy style table, later token wins ────────────────────────

    @Test fun namedStyleMerges() {
        val s = StackStyle.namedStyle("heading price")
        assertEquals("17", s["fontSize"])                       // price (later) wins
        assertEquals("bold", s["fontWeight"])
        assertEquals(emptyMap<String, String>(), StackStyle.namedStyle(null))
    }

    // ── weight()/design() token maps ──────────────────────────────────────────────────

    @Test fun fontTokenMaps() {
        assertEquals(androidx.compose.ui.text.font.FontWeight.SemiBold, StackStyle.weight("semibold"))
        assertEquals(androidx.compose.ui.text.font.FontWeight.Normal, StackStyle.weight(null))
        assertEquals(androidx.compose.ui.text.font.FontFamily.Monospace, StackStyle.design("mono"))
        assertNull(StackStyle.design(null))
    }

    @Test fun dynamicTypeMaximumCapsRenderedSize() {
        assertEquals(14f, StackStyle.cappedDynamicTypeSp(14.0, null, 3f), 0f)
        assertEquals(14f, StackStyle.cappedDynamicTypeSp(14.0, 24.0, 1f), 0f)
        assertEquals(8f, StackStyle.cappedDynamicTypeSp(14.0, 24.0, 3f), 0f)
        assertEquals(12f, StackStyle.cappedDynamicTypeSp(14.0, 12.0, 0f), 0f)
    }

    // ── aspect(): "W:H" or a bare number, Swift-grammar numbers ───────────────────────

    @Test fun aspectRatioGrammar() {
        assertEquals(16f / 9f, StackStyle.aspect("16:9")!!, 1e-6f)
        assertEquals(1.33f, StackStyle.aspect("1.33")!!, 1e-6f)
        assertNull(StackStyle.aspect("16:0"))      // zero denominator guards the divide
        assertNull(StackStyle.aspect("16:9:2"))    // exactly two parts
        assertNull(StackStyle.aspect("wide"))
        assertNull(StackStyle.aspect(null))
    }

    // ── gradientColors()/gradientAxis(): "c1|c2|…" stops + direction axis ─────────────

    @Test fun gradientStopsParse() {
        val cols = StackStyle.gradientColors("#FF0000|rgba(0,0,255,1)|white")!!
        assertEquals(3, cols.size)
        assertEquals(0xFFFF0000.toInt(), argb(cols[0]))
        assertEquals(0xFF0000FF.toInt(), argb(cols[1]))
        assertEquals(argb(Color.White), argb(cols[2]))
        assertNull(StackStyle.gradientColors("#FF0000"))   // 2+ stops required (Swift gate)
        assertNull(StackStyle.gradientColors(null))
    }

    @Test fun gradientDirAxes() {
        // vertical is the default (top → bottom); infinity = size-relative far edge
        assertEquals(Offset.Zero to Offset(0f, Float.POSITIVE_INFINITY), StackStyle.gradientAxis(null))
        assertEquals(Offset.Zero to Offset(Float.POSITIVE_INFINITY, 0f), StackStyle.gradientAxis("horizontal"))
        assertEquals(Offset.Zero to Offset.Infinite, StackStyle.gradientAxis("diagonal"))
        assertEquals(StackStyle.gradientAxis(null), StackStyle.gradientAxis("vertical"))
    }

    // ── material(): the pinned dim-translucent iOS-dark approximations ────────────────

    @Test fun materialFallbackFills() {
        assertEquals(0x8C252525.toInt(), argb(StackStyle.material("glass")))
        assertEquals(argb(StackStyle.material("glass")), argb(StackStyle.material("ultraThin"))) // alias
        assertEquals(0xB3252525.toInt(), argb(StackStyle.material("thin")))
        assertEquals(0xD1252525.toInt(), argb(StackStyle.material("regular")))
        assertEquals(0xE6252525.toInt(), argb(StackStyle.material("thick")))
        assertEquals(argb(StackStyle.material("glass")), argb(StackStyle.material("sheet")))     // Swift default arm
    }

    // ── safeSides(): ignoreSafeArea/fullBleed edge tokens ─────────────────────────────

    @Test fun safeAreaEdgeTokens() {
        assertEquals(WindowInsetsSides.Top, StackStyle.safeSides("top"))
        assertEquals(WindowInsetsSides.Bottom, StackStyle.safeSides("bottom"))
        assertEquals(WindowInsetsSides.Horizontal, StackStyle.safeSides("horizontal"))
        assertEquals(WindowInsetsSides.Horizontal, StackStyle.safeSides("sides"))     // alias
        assertEquals(WindowInsetsSides.Vertical, StackStyle.safeSides("vertical"))
        assertEquals(WindowInsetsSides.Horizontal + WindowInsetsSides.Vertical, StackStyle.safeSides("true"))
        assertEquals(StackStyle.safeSides("true"), StackStyle.safeSides("all"))       // "all" alias of "true"
    }

    // ── frameAnchor(): the flexible-frame content anchor (Swift flexFrame's Alignment) ──

    private fun anchor(vararg attrs: Pair<String, String>, tag: String? = null) =
        StackStyle.frameAnchor({ k -> attrs.toMap()[k] }, tag)

    @Test fun frameAnchorDefaultsToWebTrueTopLeading() {
        // The disease this kills: a grow="width" card centering its hugged children as a
        // group. CSS block flow pins them top-leading; SwiftUI's frame default would center.
        assertEquals(Alignment.TopStart, anchor())
        assertEquals(Alignment.TopStart, anchor(tag = "vstack"))
    }

    @Test fun frameAnchorButtonLikeTagsCenterWhenUnsteered() {
        // Every browser's UA sheet centers a <button> label — the buttonLike exception.
        assertEquals(Alignment.Center, anchor(tag = "button"))
        assertEquals(Alignment.Center, anchor(tag = "glassButton"))
        assertEquals(Alignment.Center, anchor(tag = "transport"))
        assertEquals(Alignment.TopStart, anchor(tag = "pressable"))   // NOT button-like on iOS
    }

    @Test fun frameAnchorLegacyAlignSteersBothAxes() {
        assertEquals(Alignment.TopStart, anchor("align" to "leading"))
        assertEquals(Alignment.TopEnd, anchor("align" to "trailing"))
        assertEquals(Alignment.Center, anchor("align" to "center"))   // "center this" = both axes
        assertEquals(Alignment.TopCenter, anchor("align" to "center", "alignY" to "top"))
        assertEquals(Alignment.BottomStart, anchor("align" to "bottom"))
        assertEquals(Alignment.TopStart, anchor("align" to "top"))
    }

    @Test fun frameAnchorAlignYWinsTheVerticalAxis() {
        assertEquals(Alignment.TopStart, anchor("alignY" to "top"))
        assertEquals(Alignment.BottomStart, anchor("alignY" to "bottom"))
        assertEquals(Alignment.BottomEnd, anchor("alignY" to "bottom", "align" to "trailing"))
        // alignY beats a legacy align=top/bottom (the Swift `alignY ?? …` order)
        assertEquals(Alignment.TopStart, anchor("alignY" to "top", "align" to "bottom"))
    }

    /// The retired bug-for-bug pin (R2.2): Swift's flexFrame once tested `vRaw` only
    /// against "top"/"bottom", so a LONE `alignY="center"` anchored TOP on both runtimes.
    /// Fixed iOS-first, then here in the same wave — a lone `alignY="center"` now anchors
    /// CENTER vertically (horizontal stays the unsteered default).
    @Test fun frameAnchorLoneAlignYCenterAnchorsCenter() {
        assertEquals(Alignment.CenterStart, anchor("alignY" to "center"))
        assertEquals(Alignment.Center, anchor("alignY" to "center", "align" to "center"))
    }

    @Test fun frameAnchorCssAlignItemsSteersTheCrossAxisOnly() {
        // column (default): align-items is HORIZONTAL
        assertEquals(Alignment.TopCenter, anchor("alignItems" to "center"))
        assertEquals(Alignment.TopEnd, anchor("alignItems" to "flex-end"))
        assertEquals(Alignment.TopStart, anchor("alignItems" to "flex-start"))
        // row: align-items is VERTICAL
        assertEquals(Alignment.CenterStart, anchor("flexDirection" to "row", "alignItems" to "center"))
        assertEquals(Alignment.BottomStart, anchor("flexDirection" to "row", "alignItems" to "end"))
        assertEquals(Alignment.BottomStart, anchor("flexDirection" to "row-reverse", "alignItems" to "flex-end"))
        // an explicit align= still beats CSS align-items
        assertEquals(Alignment.TopStart, anchor("align" to "leading", "alignItems" to "center"))
    }

    @Test fun frameAnchorSteeringBeatsTheButtonLikeException() {
        assertEquals(Alignment.CenterStart, anchor("align" to "leading", tag = "button"))
        assertEquals(Alignment.TopCenter, anchor("alignY" to "top", tag = "button"))
        assertEquals(Alignment.TopStart, anchor("alignItems" to "flex-start", "alignY" to "top", tag = "button"))
    }

    // ── textCase(): the string-side twin of SwiftUI's .textCase view modifier ──────────

    @Test fun textCaseUpperLowerAndNoOp() {
        assertEquals("HELLO", StackStyle.textCase(mapOf("textCase" to "upper"), "Hello"))
        assertEquals("hello", StackStyle.textCase(mapOf("textCase" to "lower"), "Hello"))
        assertEquals("Hello", StackStyle.textCase(emptyMap(), "Hello"))
        // any other value is the Swift ternary's nil arm — untouched, never an error
        assertEquals("Hello", StackStyle.textCase(mapOf("textCase" to "title"), "Hello"))
    }
}
