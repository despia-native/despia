//
//  StackSystemControlsTest.kt — plain-JVM units for the M3 COMPONENT-IDENTITY gates
//  (StackSystemControls.kt — system-defaults.md, the StackButtonsTest sibling):
//  `SystemControl` (toggle/slider/spinner/progress — the per-element allowlists, the
//  stated spinner/progress tint compatibility, the toggle/slider color EJECT) and
//  `SystemList` (the List.swift allowlist copied to the word — element + row-template
//  halves, axis/scroll behavior, prefix families, drift-pinned against the Swift set).
//  The composable halves (the real M3 controls + the grouped-list chrome) are gated by
//  compilation + CI (:render:test / :app:assembleDebug).
//
package despia.engine.render

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StackSystemControlsTest {

    @Test fun systemListRowsAreTheRealMaterialComponent() {
        val controls = File("src/main/kotlin/despia/engine/render/StackSystemControls.kt").readText()
        val constructs = File(
            "src/main/kotlin/despia/engine/render/elements/ListElements.kt",
        ).readText()
        assertTrue(controls.contains("import androidx.compose.material3.ListItem"))
        assertTrue(controls.contains("ListItem("))
        assertTrue(controls.contains("headlineContent = {"))
        assertTrue(controls.contains("LocalSystemMaterialListItem provides true"))
        assertTrue(constructs.contains("SystemMaterialListItem(outer)"))
        assertTrue(constructs.contains("if (system) SystemMaterialListItem { content() }"))
        assertFalse(controls.contains("groupedCardShape"))
        assertFalse(controls.contains("SystemGroupedRowBody"))
    }

    @Test fun sharedSettingsRowDelegatesToNativePlatformComponents() {
        val android = File(
            "src/main/kotlin/despia/engine/render/elements/SettingsRowElements.kt",
        ).readText()
        val wrapper = File(
            "../../../../ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/SettingsRow.dsx",
        ).readText()
        val swift = File(
            "../../../../ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/swift/SystemSettingsRow.swift",
        ).readText()
        val launcher = File(
            "../../../../ClosedSource/DSX/Modules/Custom/Demo/Components/Launcher.dsx",
        ).readText()
        val launcherCss = File(
            "../../../../ClosedSource/DSX/Modules/Custom/Demo/Components/Launcher.css",
        ).readText()
        val nativeLauncher = launcher.substringAfter("<scroll visible-if=\"os != 'web'\"")

        assertTrue(android.contains("defineNative(\"SystemSettingsRow\")"))
        assertTrue(android.contains("ListItem("))
        assertFalse(android.contains("BasicText("))
        assertTrue(swift.contains("LabeledContent"))
        assertTrue(swift.contains("Button { dsx.run() }"))
        assertTrue(wrapper.contains("<SystemSettingsRow visible-if=\"os != 'web'\""))
        assertTrue(wrapper.contains("class=\"dsx-settings-row\" visible-if=\"os == 'web'\""))
        assertTrue(launcher.contains("<SettingsRow icon=\"{{ item.icon }}\""))
        assertFalse(launcher.contains("<stack class=\"launcher-native-row\""))
        assertTrue(nativeLauncher.contains("dsx.component.push('demo.{{ item.component }}')"))
        assertFalse(nativeLauncher.contains("dsx.component.push('demo.' + item.component)"))
        assertTrue(launcherCss.contains("@media (min-width: 600px)"))
        assertTrue(launcherCss.contains("padding: 16px 24px"))
        assertTrue(launcherCss.contains("@media (min-width: 840px)"))
        assertTrue(launcherCss.contains("padding: 16px 32px"))
    }

    // one representative per style family — the chain the legacy path applies (the
    // StackButtonsTest ejection list): any of these on a control must eject.
    private val styled = listOf("background", "surface", "gradient", "padding", "paddingH",
                                "paddingTop", "width", "height", "minWidth", "maxHeight", "grow",
                                "radius", "aspectRatio", "ignoreSafeArea", "fullBleed", "opacity",
                                "rotation", "scale", "blur", "borderColor", "borderWidth", "shadow",
                                "shadowColor", "offset", "offsetX", "offsetY", "zIndex", "style",
                                "fontSize", "fontWeight", "alignItems", "display")

    // ── toggle: unstyled = system; color= (and every look) ejects byte-identically ────

    @Test fun unstyledToggleRendersSystem() {
        assertTrue(SystemControl.rendersSystem(emptyMap(), SystemControl.TOGGLE))
        assertTrue(SystemControl.rendersSystem(mapOf(
            "bind" to "notify", "id" to "t1", "on:change" to "save()", "on:change.debounce" to "200",
            "arg:kind" to "x", "a11yLabel" to "Notifications", "aria-label" to "Notifications",
            "visible-if" to "ready", "keep" to "true", "enter" to "fade", "anim" to "easeOut",
            "animDuration" to "0.2", "transition" to "fade", "class" to "row", "css-owner" to "Card",
        ), SystemControl.TOGGLE))
    }

    @Test fun toggleColorEjects() {
        // Pre-law color= tinted the legacy capsule — it must keep doing exactly that
        // (the SystemButton word-less rule; iOS tints its native control — pinned
        // divergence, StackSystemControls.kt header).
        assertFalse(SystemControl.rendersSystem(mapOf("bind" to "on", "color" to "red"), SystemControl.TOGGLE))
    }

    @Test fun toggleStylingEjects() {
        for (k in styled) {
            assertFalse("toggle `$k` must eject", SystemControl.rendersSystem(mapOf("bind" to "on", k to "x"), SystemControl.TOGGLE))
        }
        assertFalse(SystemControl.rendersSystem(mapOf("someFutureAttr" to "x"), SystemControl.TOGGLE))
    }

    // ── slider: bind/min/max wire the system control; color= ejects ───────────────────

    @Test fun unstyledSliderRendersSystem() {
        assertTrue(SystemControl.rendersSystem(
            mapOf("bind" to "volume", "min" to "0", "max" to "100", "on:change" to "x()"),
            SystemControl.SLIDER))
    }

    @Test fun sliderColorAndStylingEject() {
        assertFalse(SystemControl.rendersSystem(mapOf("bind" to "v", "color" to "accent"), SystemControl.SLIDER))
        for (k in styled) {
            assertFalse("slider `$k` must eject", SystemControl.rendersSystem(mapOf("bind" to "v", k to "x"), SystemControl.SLIDER))
        }
    }

    // ── spinner: color= is the COMPATIBLE TINT (iOS ProgressView().tint twin) ─────────

    @Test fun spinnerColorIsTheCompatibleTint() {
        assertTrue(SystemControl.rendersSystem(emptyMap(), SystemControl.SPINNER))
        assertTrue(SystemControl.rendersSystem(mapOf("color" to "#FF9F0A"), SystemControl.SPINNER))
    }

    @Test fun spinnerStylingEjects() {
        // `scale` rides the style chain (StackStyle.apply step 12) — a styling attr, so
        // it ejects to the legacy arc (which the chain then scales, byte-identically).
        assertFalse(SystemControl.rendersSystem(mapOf("scale" to "2"), SystemControl.SPINNER))
        for (k in styled) {
            assertFalse("spinner `$k` must eject", SystemControl.rendersSystem(mapOf(k to "x"), SystemControl.SPINNER))
        }
    }

    // ── progress: bind/value + the same tint rule as spinner; height= ejects ──────────

    @Test fun progressTintRuleMatchesSpinner() {
        assertTrue(SystemControl.rendersSystem(mapOf("bind" to "p"), SystemControl.PROGRESS))
        assertTrue(SystemControl.rendersSystem(mapOf("value" to "0.4", "color" to "accent"), SystemControl.PROGRESS))
    }

    @Test fun progressHeightAndStylingEject() {
        // height= restyles the control's own geometry — the legacy capsule honors it
        // byte-identically; the M3 indicator owns its thickness (fixture height 6).
        assertFalse(SystemControl.rendersSystem(mapOf("bind" to "p", "height" to "10"), SystemControl.PROGRESS))
        for (k in styled) {
            assertFalse("progress `$k` must eject", SystemControl.rendersSystem(mapOf(k to "x"), SystemControl.PROGRESS))
        }
    }

    // ── the list gate: the List.swift allowlist, drift-pinned to the word ─────────────

    @Test fun listAllowlistMirrorsListSwiftExactly() {
        // List.swift `systemSafeAttrs` (~230-243) — a word added/removed on either
        // platform without the other is drift; this literal set is the pin.
        assertEquals(setOf(
            "bind", "key", "id",
            "axis", "direction", "scroll", "autoscroll",
            "group_by", "groupBy", "swipeLeading", "swipeTrailing",
            "swipeFullLeading", "swipeFullTrailing", "reorder",
            "visible-if", "role", "width", "height", "grow",
            "keep", "enter", "anim", "transition",
            "css-owner",
        ), SystemList.SYSTEM_SAFE_ATTRS)
        assertEquals(listOf("on:", "arg:", "aria-", "a11y"), SystemList.SYSTEM_SAFE_PREFIXES)
    }

    @Test fun unstyledVerticalListRendersSystem() {
        assertTrue(SystemList.rendersSystem(emptyMap(), emptyMap()))
        assertTrue(SystemList.rendersSystem(
            mapOf("bind" to "emails", "key" to "id", "on:reachEnd" to "more()",
                  "group_by" to "day", "swipeTrailing" to "acts", "reorder" to "true",
                  "visible-if" to "ready", "role" to "main", "width" to "300", "grow" to "true",
                  "a11yLabel" to "Inbox", "aria-label" to "Inbox", "arg:src" to "inbox"),
            mapOf("on:tap" to "open()", "key" to "id")))
    }

    @Test fun materialListTextRolesComeFromExistingAccessibilitySemantics() {
        assertEquals(SystemList.TextRole.HEADLINE,
                     SystemList.textRole(mapOf("a11yTrait" to "header")))
        assertEquals(SystemList.TextRole.HEADLINE,
                     SystemList.textRole(mapOf("a11yTrait" to "image, header, selected")))
        assertEquals(SystemList.TextRole.SUPPORTING, SystemList.textRole(emptyMap()))
        assertEquals(SystemList.TextRole.SUPPORTING,
                     SystemList.textRole(mapOf("role" to "status", "a11yTrait" to "static")))
    }

    @Test fun anyAuthoredLookEjectsTheList() {
        // spacing/align are NOT system-safe (the List container owns row layout — iOS),
        // and class/style are the styling carriers on BOTH halves.
        for (k in listOf("spacing", "align", "class", "style", "background", "padding",
                         "radius", "opacity", "blur", "zIndex", "aspectRatio", "background:ios")) {
            assertFalse("list `$k` must eject", SystemList.rendersSystem(mapOf(k to "x"), emptyMap()))
        }
    }

    @Test fun aStyledRowTemplateEjectsTheList() {
        // The row template's attrs arrive RAW (no cascade) — unknown words, class/style
        // included, must eject there (List.swift `unstyled`, the row half).
        assertFalse(SystemList.rendersSystem(emptyMap(), mapOf("padding" to "12")))
        assertFalse(SystemList.rendersSystem(emptyMap(), mapOf("class" to "card")))
        assertFalse(SystemList.rendersSystem(emptyMap(), mapOf("style" to "background: #111")))
        assertTrue(SystemList.rendersSystem(emptyMap(), mapOf("on:tap" to "open()", "css-owner" to "Feed")))
    }

    @Test fun horizontalListsStayFlatAndFitContentRowsKeepMaterialIdentity() {
        assertFalse(SystemList.rendersSystem(mapOf("axis" to "horizontal"), emptyMap()))
        assertFalse(SystemList.rendersSystem(mapOf("direction" to "horizontal"), emptyMap()))
        assertFalse(SystemList.rendersSystemRows(mapOf("axis" to "horizontal"), emptyMap()))
        assertFalse(SystemList.rendersSystemRows(mapOf("direction" to "horizontal"), emptyMap()))

        // `scroll=false` changes only the container from LazyColumn to eager Column. It must
        // not silently replace otherwise-unstyled Material 3 ListItem rows with raw children.
        assertTrue(SystemList.rendersSystemRows(mapOf("scroll" to "false"), emptyMap()))
        assertFalse(SystemList.rendersSystem(mapOf("scroll" to "false"), emptyMap()))
        assertTrue(SystemList.rendersSystem(mapOf("axis" to "vertical", "scroll" to "true"), emptyMap()))
    }
}
