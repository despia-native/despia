//
//  StackSchemeDerivationTest.kt — plain-JVM units for the SUBTREE-SCHEME law's pure
//  halves (StackTheme.subtreePin / derivedIsDark — the Stack.swift theme=/derivedScheme
//  twins, ~5039-5069 / ~5131-5173): the literal-forms table (white/black words,
//  well-formed rgb()/rgba(), 6/8-digit hex), the alpha ≥ 0.5 gate, the 0.5 luminance
//  threshold on both sides, the suppression cases (semantic words / malformed calls /
//  unparseable tokens NEVER derive), the theme= precedence rule (explicit always wins —
//  a bad word included), and the pushForced/popForced identity-LIFO mechanics the
//  composable wrapper (ForcedSchemeSubtree) rides. The composable half is gated by
//  compilation + CI, the DefaultsTokensTest idioms (state restored in finally).
//
package despia.engine.render

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class StackSchemeDerivationTest {
    @Test
    fun nestedThemeRootsReuseTheResolvedSchemeUnlessTheyForceDark() {
        assertTrue(
            DespiaThemeNestingPolicy.reusesInheritedScheme(
                hasInheritedScheme = true,
                forcedDark = false,
            ),
        )
        assertFalse(
            DespiaThemeNestingPolicy.reusesInheritedScheme(
                hasInheritedScheme = false,
                forcedDark = false,
            ),
        )
        assertFalse(
            DespiaThemeNestingPolicy.reusesInheritedScheme(
                hasInheritedScheme = true,
                forcedDark = true,
            ),
        )
    }


    // ── the literal forms table (the Stack.swift literalRGBA spellings, to the digit) ──

    @Test fun namedLiteralWordsDerive() {
        assertEquals(false, StackTheme.derivedIsDark("white"))   // luminance 1 → light
        assertEquals(true, StackTheme.derivedIsDark("black"))    // luminance 0 → dark
    }

    @Test fun hexFormsDerive() {
        assertEquals(true, StackTheme.derivedIsDark("#0B0B0F"))    // the License/Home canvas
        assertEquals(true, StackTheme.derivedIsDark("#0b0b0f"))    // lowercase, like the funnel
        assertEquals(false, StackTheme.derivedIsDark("#FFFFFF"))
        assertEquals(true, StackTheme.derivedIsDark("0B0B0F"))     // bare 6-hex — the funnel accepts it, so it derives (iOS quirk mirrored)
        assertEquals(true, StackTheme.derivedIsDark("#FF0B0B0F"))  // 8-digit AARRGGBB, opaque
        assertNull(StackTheme.derivedIsDark("#F00"))               // 3-digit — not a funnel literal
        assertNull(StackTheme.derivedIsDark("#GGHHII"))            // non-hex
        assertNull(StackTheme.derivedIsDark("#12345"))             // wrong length
    }

    @Test fun rgbFormsDerive() {
        assertEquals(true, StackTheme.derivedIsDark("rgb(11,11,15)"))
        assertEquals(false, StackTheme.derivedIsDark("rgb(255,255,255)"))
        assertEquals(false, StackTheme.derivedIsDark("rgba(235,235,245,0.6)"))   // the old pin value — light, alpha passes
        assertEquals(true, StackTheme.derivedIsDark("rgba(11, 11, 15, 1)"))      // spaces trim like the funnel
    }

    @Test fun malformedCallsNeverDerive() {
        // WELL-FORMED is required here (leading call word + open, trailing close) — the
        // tolerant funnel still paints these; the derivation conservatively stands down.
        assertNull(StackTheme.derivedIsDark("rgb(1,2"))     // no trailing ")" — malformed by design
        assertNull(StackTheme.derivedIsDark("rgba(1,2,3"))  // no trailing ")" — malformed by design
        assertNull(StackTheme.derivedIsDark("rgb 1,2,3"))
        assertNull(StackTheme.derivedIsDark("rgb()"))          // under 3 components
        assertNull(StackTheme.derivedIsDark("rgb(1,2)"))
    }

    // ── the alpha gate: overlay-ish paints (alpha < 0.5) never derive ─────────────────

    @Test fun alphaGateAtHalf() {
        assertNull(StackTheme.derivedIsDark("rgba(0,0,0,0.4)"))
        assertEquals(true, StackTheme.derivedIsDark("rgba(0,0,0,0.5)"))     // ≥ 0.5 derives
        assertNull(StackTheme.derivedIsDark("rgba(255,255,255,0.06)"))      // the `card` wash
        assertNull(StackTheme.derivedIsDark("#400B0B0F"))                   // hex alpha 0x40 = 0.251
        assertEquals(true, StackTheme.derivedIsDark("#800B0B0F"))           // hex alpha 0x80 = 0.502
    }

    // ── the 0.5 luminance threshold, both sides (0.2126 R + 0.7152 G + 0.0722 B) ──────

    @Test fun luminanceThresholdBothSides() {
        assertEquals(true, StackTheme.derivedIsDark("#7F7F7F"))    // 127/255 = 0.498 → dark
        assertEquals(false, StackTheme.derivedIsDark("#808080"))   // 128/255 = 0.502 → light
        // Channel weights are the sRGB coefficients: pure green is light, pure blue dark.
        assertEquals(false, StackTheme.derivedIsDark("rgb(0,255,0)"))   // 0.7152 → light
        assertEquals(true, StackTheme.derivedIsDark("rgb(255,0,0)"))    // 0.2126 → dark
        assertEquals(true, StackTheme.derivedIsDark("rgb(0,0,255)"))    // 0.0722 → dark
    }

    // ── suppressions: semantic words / accent / clear / unparseable NEVER derive ──────

    @Test fun semanticWordsNeverDerive() {
        for (word in listOf("accent", "clear", "label", "text", "secondary", "secondaryLabel",
                            "tertiary", "tertiaryLabel", "background", "systemBackground",
                            "secondaryBackground", "tertiaryBackground", "groupedBackground",
                            "secondaryGroupedBackground", "fill", "fillFaint", "separator",
                            "destructive")) {
            assertNull("`$word` must never derive (it already follows the ambient scheme)",
                       StackTheme.derivedIsDark(word))
        }
    }

    @Test fun unparseableTokensNeverDerive() {
        // The funnel falls back to white for these — the derivation must NOT (never
        // derive from the fallback).
        assertNull(StackTheme.derivedIsDark("salmon"))
        assertNull(StackTheme.derivedIsDark(""))
        assertNull(StackTheme.derivedIsDark("linear-gradient(#000,#fff)"))
    }

    // ── theme= precedence: explicit always wins; any authored theme= suppresses ───────

    @Test fun themeAttributeAlwaysWins() {
        assertEquals(true, StackTheme.subtreePin("dark", "#FFFFFF"))    // pin beats a light canvas
        assertEquals(false, StackTheme.subtreePin("light", "#000000"))  // pin beats a dark canvas
        assertEquals(true, StackTheme.subtreePin("dark", null))
        assertEquals(false, StackTheme.subtreePin("light", null))
    }

    @Test fun anyAuthoredThemeSuppressesTheDerivation() {
        // The iOS if/else: val("theme") non-nil — even a non-scheme word — kills the
        // background derivation; only a MISSING theme= lets the canvas speak.
        assertNull(StackTheme.subtreePin("banana", "#000000"))
        assertNull(StackTheme.subtreePin("", "#000000"))
        assertEquals(true, StackTheme.subtreePin(null, "#000000"))
        assertNull(StackTheme.subtreePin(null, "accent"))
        assertNull(StackTheme.subtreePin(null, null))
    }

    // ── the identity LIFO the wrapper rides (pushForced/popForced — StackTheme.kt) ────

    @Test fun forcedLifoNestsAndUnwinds() {
        val a = darkColorScheme()
        val b = lightColorScheme()
        try {
            StackTheme.pushForced(a)
            assertSame(a, StackTheme.scheme)
            StackTheme.pushForced(b)                    // nested pin — last mounted wins
            assertSame(b, StackTheme.scheme)
            StackTheme.popForced(b)                     // LIFO unwind restores the outer pin
            assertSame(a, StackTheme.scheme)
            StackTheme.popForced(a)
            assertNull(StackTheme.scheme)
        } finally {
            StackTheme.popForced(a); StackTheme.popForced(b)
        }
    }

    @Test fun forcedLifoSurvivesOutOfOrderDisposal() {
        // Compose disposes in child-first order normally, but a moved/recycled node can
        // pop the OUTER pin first — identity removal keeps the inner pin current.
        val a = darkColorScheme()
        val b = lightColorScheme()
        try {
            StackTheme.pushForced(a)
            StackTheme.pushForced(b)
            StackTheme.popForced(a)                     // outer leaves first
            assertSame(b, StackTheme.scheme)
            StackTheme.popForced(b)
            assertNull(StackTheme.scheme)
        } finally {
            StackTheme.popForced(a); StackTheme.popForced(b)
        }
    }

    @Test fun forcedPushIsIdempotentPerInstance() {
        // Recomposition re-runs the forward write with the SAME remembered instance —
        // one stack entry, one pop clears it.
        val a = darkColorScheme()
        try {
            StackTheme.pushForced(a)
            StackTheme.pushForced(a)
            StackTheme.popForced(a)
            assertNull(StackTheme.scheme)
        } finally {
            StackTheme.popForced(a)
        }
    }

    @Test fun forcedPinWinsOverTheGlobalStampForResolution() {
        // The scheme getter consults the forced stack BEFORE the global stamp, so
        // StackStyle.color resolves a pinned subtree's semantics (first frame included —
        // the wrapper's forward write) — the whole point of the License/Home revert.
        val global = lightColorScheme()
        val pin = darkColorScheme()
        try {
            StackTheme.scheme = global
            StackTheme.pushForced(pin)
            assertSame(pin, StackTheme.scheme)
            assertEquals(pin.onSurfaceVariant.toArgb(), StackStyle.color("secondary").toArgb())
            StackTheme.popForced(pin)
            assertSame(global, StackTheme.scheme)
            assertEquals(global.onSurfaceVariant.toArgb(), StackStyle.color("secondary").toArgb())
        } finally {
            StackTheme.popForced(pin)
            StackTheme.scheme = null
        }
    }
}
