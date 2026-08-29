package despia.engine.render

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import despia.engine.SurfaceMaterials
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `surface=` is a MATERIAL on iOS and a frost on the web; on Compose it degrades to a
 * translucent fill, which is legal. What is not legal is degrading to the wrong COLOUR.
 *
 * This table was a pinned dark constant (#252525) regardless of theme, so a light app that
 * wrote `surface="regular"` got a dark slab under its content. Nothing failed - it built,
 * rendered and passed every test, and simply looked like a different design. That is exactly
 * the class of defect a screenshot catches and a unit test usually does not, so these are the
 * assertions that make it catchable without one.
 */
class SurfaceMaterialTest {

    @After
    fun reset() {
        StackTheme.scheme = null
    }

    private fun luminance(c: Color): Float = 0.2126f * c.red + 0.7152f * c.green + 0.0722f * c.blue

    /** One 8-bit channel step. A Color round-trips its components through bytes, so 0.55f comes
     *  back as 0.5490196 - a difference that is invisible and is not drift. */
    private val channel = 1.0 / 255.0

    @Test
    fun aLightThemeGetsALightMaterialAndADarkThemeADarkOne() {
        StackTheme.scheme = lightColorScheme()
        val light = SurfaceMaterials.TOKENS.associateWith { StackStyle.material(it) }
        StackTheme.scheme = darkColorScheme()
        val dark = SurfaceMaterials.TOKENS.associateWith { StackStyle.material(it) }

        for (token in SurfaceMaterials.TOKENS) {
            assertTrue(
                "`$token` is no lighter on a light theme than on a dark one - the ladder is " +
                    "ignoring the theme, which is how a light app ends up with a dark slab",
                luminance(light.getValue(token)) > luminance(dark.getValue(token)),
            )
        }
    }

    @Test
    fun thicknessIsOpacityAndTheLadderIsMonotonic() {
        StackTheme.scheme = lightColorScheme()
        val ultraThin = StackStyle.material("ultraThin").alpha
        val thin = StackStyle.material("thin").alpha
        val regular = StackStyle.material("regular").alpha
        val thick = StackStyle.material("thick").alpha
        assertTrue(
            "thickness IS opacity here: $ultraThin, $thin, $regular, $thick",
            ultraThin < thin && thin < regular && regular < thick,
        )
        // `glass` and `ultraThin` are one material, and `sheet` rides them - the Swift
        // `material(_:)` default does the same with all three.
        assertEquals(ultraThin.toDouble(), StackStyle.material("glass").alpha.toDouble(), channel)
        assertEquals(ultraThin.toDouble(), StackStyle.material("sheet").alpha.toDouble(), channel)
        assertEquals(ultraThin.toDouble(), StackStyle.material("not-a-token").alpha.toDouble(), channel)
    }

    @Test
    fun aThemelessHostKeepsThePinnedFallbackRatherThanInventingOne() {
        // Plain-JVM tests and pre-theme boot have no scheme. Degrading to the OLD pinned table
        // is deliberate: a host that never had a theme should look exactly as it did, not
        // slightly different. `color()` keeps its own iOS-dark fallback for the same reason.
        StackTheme.scheme = null
        val glass = StackStyle.material("glass")
        val expected = Color(SurfaceMaterials.FALLBACK_BASE)
        assertEquals(expected.red.toDouble(), glass.red.toDouble(), channel)
        assertEquals(expected.green.toDouble(), glass.green.toDouble(), channel)
        assertEquals(expected.blue.toDouble(), glass.blue.toDouble(), channel)
        assertEquals(SurfaceMaterials.alpha("glass").toDouble(), glass.alpha.toDouble(), channel)
    }

    @Test
    fun everyTokenIsTranslucentBecauseThatIsWhatMakesItAMaterial() {
        StackTheme.scheme = lightColorScheme()
        for (token in SurfaceMaterials.TOKENS) {
            val alpha = StackStyle.material(token).alpha
            assertTrue(
                "`$token` at alpha $alpha is an opaque rectangle, not a material - a surface " +
                    "that lets nothing through is a background colour with extra steps",
                alpha > 0f && alpha < 1f,
            )
        }
    }
}
