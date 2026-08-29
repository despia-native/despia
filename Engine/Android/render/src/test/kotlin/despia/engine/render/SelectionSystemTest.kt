//
//  SelectionSystemTest.kt — plain-JVM units for the SELECTION/CHOICE cluster's M3 system-path
//  gate (SelectionSystem.kt — system-defaults.md, the StackSystemControlsTest sibling): the
//  picker/combobox/datepicker/segmented/segmentedButton allowlists PLUS the M3-batch2b small
//  value-control family (checkbox/radiogroup/stepper/rangeslider/otp) AND the M3-text
//  text-input family (textfield/textarea — the M3 wave's CLOSE). `color` is the
//  COMPATIBLE TINT for picker/combobox/datepicker/segmentedButton, for all five value
//  controls, AND for both text inputs (it rides the M3 control — the iOS `.tint`/selected-fill/
//  checked-tint/`.foregroundColor` contract — UNLIKE toggle/slider where it ejects), but EJECTS
//  on segmented (iOS `.segmented` ignores color — Picker.swift:34). Every look attribute /
//  unknown word ejects to the legacy path.
//  `stars` is intentionally UNGATED (M3 ships no rating component / no outline-star glyph —
//  RatingElements.kt), so it has no allowlist and no test here. The composable halves (the
//  real M3 DropdownMenu / ExposedDropdownMenuBox / DatePickerDialog / SegmentedButtonRow /
//  Checkbox / RadioButton / RangeSlider / icon-button stepper / outlined otp boxes) are
//  gated by compilation + CI (:render:test / :app:assembleDebug).
//
package despia.engine.render

import despia.engine.render.elements.SelectionControl
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SelectionSystemTest {

    @Test
    fun declaredDisabledReadsTheStrictComponentBooleanNeverJseTruthy() {
        // truthy("false") is true by the JSE string law, so the truthy read disabled a control
        // the author explicitly ENABLED. The declared word now shares the iOS dsx.bool
        // predicate (`s == "true" || Double(s) != 0`, web `declaredBool`); a bound
        // {{ locked }} arrives "1"/"" so the empty string stays enabled. disabled-if keeps
        // the truthy CONDITION read.
        assertFalse(SelectionControl.isDisabled("false", null))
        assertFalse(SelectionControl.isDisabled("0", null))
        assertFalse(SelectionControl.isDisabled("", null))
        assertFalse(SelectionControl.isDisabled(null, null))
        assertTrue(SelectionControl.isDisabled("true", null))
        assertTrue(SelectionControl.isDisabled("1", null))
        assertTrue(SelectionControl.isDisabled(null, "1"))
        assertFalse(SelectionControl.isDisabled(null, ""))
    }

    // one representative per style family — the chain the legacy path applies (the
    // StackSystemControlsTest ejection list): any of these on a control must eject.
    private val styled = listOf("background", "surface", "gradient", "padding", "paddingH",
                                "width", "height", "minWidth", "maxHeight", "grow", "radius",
                                "opacity", "rotation", "scale", "blur", "borderColor", "borderWidth",
                                "shadow", "offset", "zIndex", "style", "fontSize", "fontWeight")

    // ── picker: the .menu content words wire the system M3 DropdownMenu ────────────────

    @Test fun unstyledPickerRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(emptyMap(), SelectionControl.PICKER))
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "plan", "options" to "A,B", "optionsKey" to "rows", "valueField" to "id",
            "labelField" to "name", "label" to "Plan", "id" to "p1", "on:change" to "save()",
            "arg:k" to "v", "aria-label" to "Plan", "visible-if" to "ok", "keep" to "true",
            "transition" to "fade", "class" to "row", "css-owner" to "Card",
        ), SelectionControl.PICKER))
    }

    @Test fun pickerColorRidesTheControl() {
        // color is the tint on the M3 menu (iOS .tint) — it must NOT eject, unlike toggle.
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "p", "color" to "accent"), SelectionControl.PICKER))
    }

    @Test fun pickerStylingEjects() {
        for (k in styled) {
            assertFalse("picker `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "p", k to "x"), SelectionControl.PICKER))
        }
        assertFalse(SelectionControl.rendersSystem(mapOf("someFutureAttr" to "x"), SelectionControl.PICKER))
    }

    // ── combobox: the typeahead words wire the system ExposedDropdownMenuBox ───────────

    @Test fun unstyledComboboxRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "city", "options" to "Paris,Berlin", "placeholder" to "City",
            "color" to "accent", "on:select" to "pick()",
        ), SelectionControl.COMBOBOX))
    }

    @Test fun comboboxStylingEjects() {
        for (k in styled) {
            assertFalse("combobox `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "c", k to "x"), SelectionControl.COMBOBOX))
        }
    }

    // ── datepicker: bind/mode/label/color wire the system M3 dialogs ───────────────────

    @Test fun unstyledDatePickerRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "when", "mode" to "datetime", "label" to "Departure", "color" to "accent",
        ), SelectionControl.DATEPICKER))
    }

    @Test fun datePickerStylingEjects() {
        for (k in styled) {
            assertFalse("datepicker `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "d", k to "x"), SelectionControl.DATEPICKER))
        }
    }

    // ── segmented: the .segmented content words wire the M3 SingleChoiceSegmentedButtonRow ──

    @Test fun unstyledSegmentedRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(emptyMap(), SelectionControl.SEGMENTED))
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "plan", "options" to "A,B", "optionsKey" to "rows", "valueField" to "id",
            "labelField" to "name", "label" to "Plan", "id" to "s1", "on:change" to "save()",
            "arg:k" to "v", "aria-label" to "Plan", "visible-if" to "ok", "class" to "row", "css-owner" to "Card",
        ), SelectionControl.SEGMENTED))
    }

    @Test fun segmentedColorEjects() {
        // iOS `.segmented` IGNORES color (menu-only tint, Picker.swift:34) — so it is NOT a
        // system-safe word here: an authored color ejects to the legacy pill (the header
        // asymmetry vs picker/segmentedButton, where color rides the control).
        assertFalse(SelectionControl.rendersSystem(mapOf("bind" to "p", "color" to "accent"), SelectionControl.SEGMENTED))
    }

    @Test fun segmentedStylingEjects() {
        for (k in styled) {
            assertFalse("segmented `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "s", k to "x"), SelectionControl.SEGMENTED))
        }
        assertFalse(SelectionControl.rendersSystem(mapOf("someFutureAttr" to "x"), SelectionControl.SEGMENTED))
    }

    // ── segmentedButton: the multi-select words wire the M3 Multi/SingleChoiceSegmentedButtonRow ──

    @Test fun unstyledSegmentedButtonRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "filters", "options" to "Day,Week,Month", "icons" to "sun.max,calendar,clock",
            "multiple" to "false", "on:change" to "save()", "aria-label" to "Filters",
        ), SelectionControl.SEGMENTED_BUTTON))
    }

    @Test fun segmentedButtonColorRidesTheControl() {
        // color is the active-segment tint on the M3 row (iOS's selected fill) — must NOT eject.
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "f", "color" to "accent"), SelectionControl.SEGMENTED_BUTTON))
    }

    @Test fun segmentedButtonStylingEjects() {
        for (k in styled) {
            assertFalse("segmentedButton `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "f", k to "x"), SelectionControl.SEGMENTED_BUTTON))
        }
    }

    // ── the small value-control family (M3-batch2b) — checkbox/radiogroup/stepper/
    //    rangeslider/otp reuse the SAME gate; `color` rides EVERY one (never ejects) ───────

    @Test fun unstyledCheckboxRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(emptyMap(), SelectionControl.CHECKBOX))
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "agreed", "label" to "I accept", "color" to "accent", "id" to "c1",
            "on:change" to "save()", "visible-if" to "ok", "class" to "row", "css-owner" to "Card",
        ), SelectionControl.CHECKBOX))
    }

    @Test fun checkboxColorRidesTheControl() {
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "a", "color" to "green"), SelectionControl.CHECKBOX))
    }

    @Test fun checkboxStylingEjects() {
        for (k in styled) {
            assertFalse("checkbox `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "a", k to "x"), SelectionControl.CHECKBOX))
        }
        assertFalse(SelectionControl.rendersSystem(mapOf("someFutureAttr" to "x"), SelectionControl.CHECKBOX))
    }

    @Test fun unstyledRadioGroupRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "plan", "options" to "A,B", "optionsKey" to "rows", "valueField" to "id",
            "labelField" to "name", "color" to "accent", "on:change" to "save()", "aria-label" to "Plan",
        ), SelectionControl.RADIOGROUP))
    }

    @Test fun radioGroupColorRidesTheControl() {
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "p", "color" to "accent"), SelectionControl.RADIOGROUP))
    }

    @Test fun radioGroupStylingEjects() {
        for (k in styled) {
            assertFalse("radiogroup `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "p", k to "x"), SelectionControl.RADIOGROUP))
        }
    }

    @Test fun unstyledStepperRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "qty", "min" to "1", "max" to "9", "step" to "1", "label" to "Qty",
            "color" to "accent", "on:change" to "save()",
        ), SelectionControl.STEPPER))
    }

    @Test fun stepperColorRidesTheControl() {
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "q", "color" to "accent"), SelectionControl.STEPPER))
    }

    @Test fun stepperStylingEjects() {
        for (k in styled) {
            assertFalse("stepper `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "q", k to "x"), SelectionControl.STEPPER))
        }
    }

    @Test fun unstyledRangeSliderRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bindLow" to "from", "bindHigh" to "to", "min" to "0", "max" to "100",
            "step" to "5", "color" to "accent", "on:change" to "save()",
        ), SelectionControl.RANGESLIDER))
    }

    @Test fun rangeSliderColorRidesTheControl() {
        assertTrue(SelectionControl.rendersSystem(mapOf("bindLow" to "a", "bindHigh" to "b", "color" to "accent"), SelectionControl.RANGESLIDER))
    }

    @Test fun rangeSliderStylingEjects() {
        for (k in styled) {
            assertFalse("rangeslider `$k` must eject", SelectionControl.rendersSystem(mapOf("bindLow" to "a", k to "x"), SelectionControl.RANGESLIDER))
        }
    }

    @Test fun unstyledOtpRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "code", "length" to "6", "boxSize" to "48", "color" to "accent",
            "on:complete" to "verify()",
        ), SelectionControl.OTP))
    }

    @Test fun otpColorRidesTheControl() {
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "c", "color" to "accent"), SelectionControl.OTP))
    }

    @Test fun otpStylingEjects() {
        for (k in styled) {
            assertFalse("otp `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "c", k to "x"), SelectionControl.OTP))
        }
        // `secure` is NOT an OTP attribute (OTP.swift declares none) — it ejects, documenting
        // that no Android-only mask is invented (the unified-codebase law, header divergence).
        assertFalse(SelectionControl.rendersSystem(mapOf("bind" to "c", "secure" to "true"), SelectionControl.OTP))
    }

    // ── the text-input family (M3-text — the M3 wave's CLOSE) — textfield/textarea reuse the
    //    SAME gate; `color` rides BOTH (never ejects — the picker/combobox precedent) ─────────

    @Test fun unstyledTextFieldRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(emptyMap(), SelectionControl.TEXTFIELD))
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "email", "secure" to "true", "placeholder" to "Email",
            "keyboard" to "email", "contentType" to "emailAddress", "color" to "accent",
            "id" to "f1", "on:change" to "save()", "on:submit" to "go()",
            "on:focus" to "f()", "on:blur" to "b()", "visible-if" to "ok",
            "class" to "row", "css-owner" to "Card", "aria-label" to "Email",
        ), SelectionControl.TEXTFIELD))
    }

    @Test fun textFieldColorRidesTheControl() {
        // color is the M3 field's text + cursor color (iOS .foregroundColor) — it must NOT eject.
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "e", "color" to "accent"), SelectionControl.TEXTFIELD))
    }

    @Test fun textFieldSecureKeyboardContentTypeRideTheControl() {
        // secure / keyboard / contentType are look-free content (visual transformation / IME /
        // autofill), never a style eject — the field stays M3.
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "p", "secure" to "true"), SelectionControl.TEXTFIELD))
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "u", "keyboard" to "url"), SelectionControl.TEXTFIELD))
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "o", "contentType" to "oneTimeCode"), SelectionControl.TEXTFIELD))
    }

    @Test fun textFieldStylingEjects() {
        for (k in styled) {
            assertFalse("textfield `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "e", k to "x"), SelectionControl.TEXTFIELD))
        }
        assertFalse(SelectionControl.rendersSystem(mapOf("someFutureAttr" to "x"), SelectionControl.TEXTFIELD))
    }

    @Test fun unstyledTextAreaRendersSystem() {
        assertTrue(SelectionControl.rendersSystem(emptyMap(), SelectionControl.TEXTAREA))
        assertTrue(SelectionControl.rendersSystem(mapOf(
            "bind" to "bio", "placeholder" to "About you", "minLines" to "3", "maxLines" to "8",
            "color" to "accent", "on:focus" to "f()", "on:blur" to "b()", "aria-label" to "Bio",
        ), SelectionControl.TEXTAREA))
    }

    @Test fun textAreaColorRidesTheControl() {
        assertTrue(SelectionControl.rendersSystem(mapOf("bind" to "b", "color" to "accent"), SelectionControl.TEXTAREA))
    }

    @Test fun textAreaStylingEjects() {
        for (k in styled) {
            assertFalse("textarea `$k` must eject", SelectionControl.rendersSystem(mapOf("bind" to "b", k to "x"), SelectionControl.TEXTAREA))
        }
        // `secure` / `keyboard` are NOT textarea attributes (TextArea.swift declares neither — no
        // on:submit, no secure/keyboard for multiline) → they eject, pinning the parity.
        assertFalse(SelectionControl.rendersSystem(mapOf("bind" to "b", "secure" to "true"), SelectionControl.TEXTAREA))
        assertFalse(SelectionControl.rendersSystem(mapOf("bind" to "b", "keyboard" to "email"), SelectionControl.TEXTAREA))
    }
}
