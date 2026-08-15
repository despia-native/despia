//
//  StackButtonsTest.kt — plain-JVM units for the system-button PURE halves
//  (StackButtons.kt SystemButton — system-defaults.md): the BUTTON_ROLES pair mirrors
//  the web reference (packages/dom/src/elements.ts), the variant words select the M3
//  tier, and `rendersSystem` is the RECONCILED allowlist gate — without a variant/role
//  WORD only a fully-unstyled button renders system (color=/iconSize= eject with every
//  other styling attr, keeping the pre-law legacy box byte-identical); a word is the
//  author's explicit opt-in admitting color (the compatible tint), iconSize, and the
//  LAYOUT attrs, while any LOOK attr (from any cascade layer, already folded into plain
//  keys by resolvedAttrs) or any unknown attribute still ejects (the inert-landing
//  invariant). The composable half is gated by compilation + CI (:render:test).
//
package despia.engine.render

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StackButtonsTest {

    @Test fun systemButtonsDelegateTheirDefaultPalettesToMaterial3() {
        val source = File(
            "src/main/kotlin/despia/engine/render/StackButtons.kt",
        ).readText()
        assertTrue(source.contains("import androidx.compose.material3.ButtonDefaults"))
        assertTrue(source.contains("ButtonDefaults.textButtonColors()"))
        assertTrue(source.contains("ButtonDefaults.filledTonalButtonColors()"))
        assertTrue(source.contains("ButtonDefaults.buttonColors()"))
        assertFalse(Regex("""(?m)^\s*ButtonColors\(""").containsMatchIn(source))
        assertFalse(source.contains("disabledContainerColor ="))
        assertFalse(source.contains("disabledContentColor ="))
        assertEquals(3, Regex("""enabled = !disabled""").findAll(source).count())

        val dispatch = File(
            "src/main/kotlin/despia/engine/render/StackNodeView.kt",
        ).readText()
        assertTrue(dispatch.contains("disabled = interp(a[\"disabled\"]) == \"true\""))
    }

    // ── BUTTON_ROLES mirrors the web reference exactly ────────────────────────────────

    @Test fun buttonRoleWordsMirrorTheWeb() {
        assertEquals(setOf("destructive", "cancel"), SystemButton.BUTTON_ROLES)
    }

    // ── variant words → the M3 component tier ─────────────────────────────────────────

    @Test fun variantWordsSelectTheTier() {
        assertEquals(SystemButton.Variant.Tonal, SystemButton.variant("bordered"))
        assertEquals(SystemButton.Variant.Filled, SystemButton.variant("prominent"))
        assertEquals(SystemButton.Variant.Text, SystemButton.variant(null))       // the unstyled default = TextButton
        assertEquals(SystemButton.Variant.Text, SystemButton.variant(""))
        assertEquals(SystemButton.Variant.Text, SystemButton.variant("mystery")) // unknown word keeps the base look (web behavior)
        assertEquals(SystemButton.Variant.Tonal, SystemButton.variant(" bordered "))  // trimmed like the web stamp
    }

    // ── the system-path gate: compatible attributes stay, styling ejects ──────────────

    @Test fun unstyledButtonsStayOnTheSystemPath() {
        assertTrue(SystemButton.rendersSystem(emptyMap()))
        // The word-less base set — identity/content/nav/a11y/visibility, no color/iconSize.
        assertTrue(SystemButton.rendersSystem(mapOf(
            "id" to "cta", "label" to "Save", "icon" to "checkmark",
            "href" to "/next", "on:tap" to "save()", "on:tap.debounce" to "300",
            "disabled" to "false",
            "arg:kind" to "primary", "a11yLabel" to "Save", "aria-label" to "Save",
            "visible-if" to "ready", "keep" to "true", "enter" to "fade", "anim" to "easeOut",
            "animDuration" to "0.2", "transition" to "fade", "class" to "cta", "css-owner" to "Card",
        )))
        // A word admits the full compatible set: color tint, iconSize, layout.
        assertTrue(SystemButton.rendersSystem(mapOf(
            "id" to "cta", "label" to "Save", "icon" to "checkmark", "iconSize" to "20",
            "color" to "accent", "variant" to "prominent", "role" to "destructive",
            "padding" to "12", "grow" to "width",
            "href" to "/next", "on:tap" to "save()", "a11yLabel" to "Save",
        )))
    }

    @Test fun anyStylingAttributeEjects() {
        // one representative per style family — the chain the legacy path applies
        // (padding/frame/grow/fills/shape/effects/transforms/text styling/named styles);
        // a folded CSS decl (alignItems/display) ejects identically. Word-less, so the
        // layout family ejects here too.
        for (styled in listOf("background", "surface", "gradient", "padding", "paddingH",
                              "paddingTop", "width", "height", "minWidth", "maxHeight", "grow",
                              "radius", "aspectRatio", "ignoreSafeArea", "fullBleed", "opacity",
                              "rotation", "scale", "blur", "borderColor", "borderWidth", "shadow",
                              "shadowColor", "offset", "offsetX", "offsetY", "zIndex", "style",
                              "fontSize", "fontWeight", "fontDesign", "italic", "underline",
                              "strikethrough", "tracking", "textAlign", "alignItems", "display")) {
            assertFalse("`$styled` must eject to the legacy path",
                        SystemButton.rendersSystem(mapOf("label" to "Hi", styled to "x")))
        }
    }

    // ── the reconciled rule: color/iconSize eject WITHOUT a word (the hijack fix) ─────

    @Test fun colorAndIconSizeEjectWithoutAWord() {
        // Pre-law `color=`/`iconSize=` styled the legacy box — without an opt-in word
        // they must keep doing exactly that (byte-identical), never hijack into M3.
        assertFalse(SystemButton.rendersSystem(mapOf("label" to "Hi", "color" to "#BADA55")))
        assertFalse(SystemButton.rendersSystem(mapOf("icon" to "star", "iconSize" to "28")))
        // An a11y `role` (outside BUTTON_ROLES) is NOT an opt-in word.
        assertFalse(SystemButton.rendersSystem(mapOf("label" to "Hi", "role" to "button", "color" to "white")))
    }

    @Test fun wordsAdmitColorIconSizeAndLayout() {
        assertTrue(SystemButton.rendersSystem(mapOf("label" to "Hi", "variant" to "bordered", "color" to "#BADA55")))
        assertTrue(SystemButton.rendersSystem(mapOf("label" to "Hi", "role" to "destructive", "iconSize" to "28")))
        assertTrue(SystemButton.rendersSystem(mapOf("label" to "Hi", "role" to "cancel", "padding" to "16")))
        for (layout in listOf("padding", "paddingH", "paddingX", "paddingV", "paddingY",
                              "paddingTop", "paddingBottom", "paddingLeading", "paddingLeft",
                              "paddingTrailing", "paddingRight", "width", "height",
                              "minWidth", "maxWidth", "minHeight", "maxHeight", "grow")) {
            assertTrue("`$layout` must thread onto the system control under a word",
                       SystemButton.rendersSystem(mapOf("label" to "Hi", "variant" to "prominent", layout to "12")))
        }
    }

    @Test fun wordsPlusALookAttrStillEject() {
        // The pinned Android divergence (StackButtons.kt header): word + LOOK attr drops
        // the whole element to the legacy box pending the systemPath catalog wave.
        for (look in listOf("background", "radius", "fontSize", "shadow", "opacity", "style")) {
            assertFalse("word + `$look` must eject",
                        SystemButton.rendersSystem(mapOf("label" to "Hi", "variant" to "prominent", look to "x")))
        }
        assertFalse(SystemButton.rendersSystem(mapOf("label" to "Hi", "role" to "destructive", "background" to "#111")))
    }

    @Test fun a11yRolesAloneStayOnTheSystemPath() {
        // A pure accessibility role is SAFE_BASE (as ever) — it just opts into nothing.
        assertTrue(SystemButton.rendersSystem(mapOf("label" to "Hi", "role" to "header")))
        assertFalse(SystemButton.rendersSystem(mapOf("label" to "Hi", "role" to "header", "padding" to "8")))
    }

    @Test fun unknownAttributesEjectTooTheSafeDirection() {
        assertFalse(SystemButton.rendersSystem(mapOf("label" to "Hi", "someFutureStyleAttr" to "x")))
        assertFalse(SystemButton.rendersSystem(mapOf("label" to "Hi", "variant" to "prominent", "someFutureStyleAttr" to "x")))
    }
}
