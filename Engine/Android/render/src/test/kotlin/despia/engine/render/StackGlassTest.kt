package despia.engine.render

import androidx.compose.ui.Modifier
import despia.engine.StackStore
import despia.engine.SurfaceMaterials
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `glassInteractive` on Compose. The press response itself is geometry the platform draws, so what
 * is decidable without a device is the DECISION: when the step joins the chain at all.
 *
 * It is opt-in on the exact word `"true"`, on every renderer, and that spelling is not an accident
 * of parsing. Stack.swift defaulted the press on for every tappable once (#1002) and a glass-dense
 * sheet leaked a stray platter over the Dynamic Island, so all four renderers read the attribute
 * the same strict way. A permissive read here would resurrect that bug on Android only.
 */
class StackGlassTest {

    private fun steps(attrs: Map<String, String>): Int =
        StackStyle.apply(attrs, StackStore(), null).foldIn(0) { n, _: Modifier.Element -> n + 1 }

    private val glass = mapOf("surface" to "glass")

    @Test
    fun thePressJoinsTheChainOnTrueAndOnNothingElse() {
        assertEquals(
            "an unasked-for press must cost nothing at all, not a step that animates to 1",
            steps(glass), steps(glass + ("glassInteractive" to "false")),
        )
        assertEquals(
            "only `true` opts in - a truthy-looking word must not, or the iOS reading and this " +
                "one disagree about the same markup",
            steps(glass), steps(glass + ("glassInteractive" to "yes")),
        )
        assertEquals(steps(glass) + 1, steps(glass + ("glassInteractive" to "true")))
    }

    @Test
    fun thereIsNothingToPressWithoutASurface() {
        val bare = mapOf("padding" to "8")
        assertEquals(
            "the press modulates the glass; with no surface declared there is no material and " +
                "the attribute is inert, exactly as it is on iOS",
            steps(bare), steps(bare + ("glassInteractive" to "true")),
        )
    }

    /** The one number. Both Compose lanes and the web renderer press to the same 0.97 the
     *  pressable surface cards already use - the two Compose lanes by reading :core rather than
     *  each keeping a copy, and the web spelling by check_renderer_constants.rb diffing it
     *  against this one. */
    @Test
    fun thePressGeometryIsTheSharedNumber() {
        assertEquals(0.97f, SurfaceMaterials.PRESS_SCALE, 0f)
        assertEquals(120, SurfaceMaterials.PRESS_IN_MS)
    }
}
