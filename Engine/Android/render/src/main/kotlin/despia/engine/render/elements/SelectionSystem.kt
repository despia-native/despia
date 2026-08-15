//
//  SelectionSystem.kt — the SYSTEM-CONTROL gate for the SELECTION/CHOICE cluster's
//  M3-twin members (picker · combobox · datepicker · segmented · segmentedButton), the
//  StackSystemControls.kt sibling for this family (system-defaults.md; the StackButtons.kt
//  philosophy): a fully-UNSTYLED selection control renders the REAL Material 3 component,
//  and ANY authored styling keeps the LEGACY custom drawing (the iOS-faithful popups/pills
//  this wave inherited) byte-identical — the inert-landing invariant. Per element:
//
//    picker         → M3 DropdownMenu                    (iOS: SwiftUI .pickerStyle(.menu))
//    combobox       → M3 ExposedDropdownMenuBox          (iOS: the typeahead TextField + card)
//    datepicker     → M3 DatePickerDialog / TimePicker   (iOS: the compact UIDatePicker sheet)
//    segmented      → M3 SingleChoiceSegmentedButtonRow  (iOS: .pickerStyle(.segmented))
//    segmentedButton→ M3 Multi/SingleChoiceSegmentedButtonRow (iOS: the custom Material row)
//
//  wheelpicker and calendar are NOT gated here: Material 3 ships no wheel/drum picker and
//  no per-day-decorable calendar (the `marks` feature), so those two have no system twin
//  to switch into — they render their custom-but-M3-token-dressed view in every case, the
//  divergence pinned in PickerElements.kt / DateElements.kt headers.
//
//  THE SMALL VALUE-CONTROL FAMILY (M3-batch2b — the wave's completion) reuses this SAME
//  gate (the `rendersSystem` allowlist direction, not a fork). Per element:
//
//    checkbox       → M3 Checkbox                        (iOS: SF-glyph button, tinted)
//    radiogroup     → M3 RadioButton rows                (iOS: SF-glyph button rows)
//    stepper        → M3 FilledTonalIconButton ± + value (iOS: the system UIStepper)
//    rangeslider    → M3 RangeSlider                     (iOS: the custom dual-thumb track)
//    otp            → M3 outlined-token boxes            (iOS: the custom stroked boxes)
//
//  `color` rides ALL FIVE (it is in every allowlist): iOS keeps the authored tint ON the
//  control in each one — Checkbox checked tint, RadioGroup selected tint, Stepper `.tint`,
//  RangeSlider segment/thumb tint, OTP active-box highlight — so it is a system-safe word,
//  never a look-eject (the picker/segmentedButton precedent, NOT the toggle/slider one).
//  `stars` is DELIBERATELY absent: M3 ships no rating component AND the shipped Material
//  Symbols subset carries no outline-star glyph, so `stars` renders its custom drawn-star
//  row in every case (the wheelpicker/calendar precedent — divergence in RatingElements.kt).
//
//  THE TEXT-INPUT FAMILY (M3-text — the M3 wave's CLOSE) reuses this SAME gate. Per element:
//
//    textfield/input → M3 OutlinedTextField (singleLine)   (iOS: SwiftUI TextField/SecureField)
//    textarea        → M3 OutlinedTextField (min/maxLines)  (iOS: TextField(axis: .vertical))
//
//  `color` rides BOTH as the field's text + cursor color — iOS keeps `.foregroundColor(color)`
//  ON the native field (TextField.swift:41 / TextArea.swift:51), NOT an accent `.tint`, so it
//  never ejects (the picker/combobox precedent). B2's focus/IME event contract (commit
//  497aeb4d — on:focus/on:blur/on:submit + the keyboard→ImeAction map) is UNCHANGED: it stays
//  wired on the field MODIFIER in the M3 path exactly as on the legacy one. DIVERGENCE (M3
//  path, none silent): the M3 OutlinedTextField draws an OUTLINE BOX + M3 role colors where
//  iOS's unstyled field is BORDERLESS (each platform's own real component — the system-defaults
//  law), and the M3 metrics are the component's own (OUT of the parity spec — the fixture pins
//  the byte-identical LEGACY path, so no spec change; the combobox/checkbox precedent).
//
//  THE GATE is the pure, plain-JVM-tested allowlist (SelectionSystemTest) — the
//  SystemControl direction verbatim: an attribute passes only when it is a KNOWN look-free
//  word; every styling arm (the cascade folded classes/sheets/inline CSS into plain keys
//  before this point) and every unknown/future attribute ejects to the legacy view. The
//  safe direction is always "render exactly as before".
//
//  `color` — the tint asymmetry (each element keyed to what its iOS twin does):
//    • picker/combobox/datepicker/segmentedButton ADMIT `color`: iOS keeps the authored
//      tint ON the control — `.tint(color)` (Picker/Combobox/DatePicker.swift) resp. the
//      selected-segment fill (SegmentedButton.swift:29,76) — so it rides the M3 component,
//      never ejects (the spinner/progress precedent, StackSystemControls.kt).
//    • segmented EXCLUDES `color`: iOS `.pickerStyle(.segmented)` explicitly IGNORES it —
//      the tint is menu-only (Picker.swift:34) — so `color` is neither look-free content
//      nor a passthrough tint here. An authored `color=` therefore ejects to the legacy
//      pill (which also ignores it — byte-identical to the pre-M3 rendering).
//

package despia.engine.render.elements

/// The per-element system-path gate for the selection cluster — the SystemButton
/// allowlist direction (an attribute passes only when it is a KNOWN look-free word).
/// Pure; class-loaded and asserted by SelectionSystemTest.
internal object SelectionControl {

    // The always-safe base — identity, visibility/motion (they wrap OUTSIDE the element),
    // and accessibility. `class`/`css-owner` are safe BARE: their styling, if any, was
    // folded into plain keys by resolvedAttrs and ejects as those keys (the SystemButton
    // rule). Mirrors SystemControl.SAFE_BASE exactly.
    private val SAFE_BASE = setOf(
        "id", "key", "class", "css-owner",
        "visible-if", "keep", "enter", "anim", "animDuration", "transition",
        "a11yGroup", "a11yLabel", "a11yHint", "a11yValue", "a11yTrait", "a11yHidden",
    )
    private val COMPAT_PREFIXES = listOf("on:", "arg:", "aria-")

    // Each element's content words on top of the base — exactly the fixture's look-free
    // attribute set. `color` appears in all three: iOS keeps the authored tint ON the
    // control (`.tint`), so it rides the M3 component (see header), never a look-eject.
    val PICKER: Set<String> = setOf(
        "bind", "options", "optionsKey", "valueField", "labelField", "label", "color",
    )
    val COMBOBOX: Set<String> = setOf(
        "bind", "options", "optionsKey", "valueField", "labelField", "placeholder", "color",
    )
    val DATEPICKER: Set<String> = setOf("bind", "mode", "label", "color")

    // <segmented> (Picker.swift `.segmented`) — the single-value picker grammar, exactly the
    // fixture's attribute set. `color` is DELIBERATELY absent: iOS ignores it on .segmented
    // (Picker.swift:34), so an authored color ejects to the legacy pill (see header).
    val SEGMENTED: Set<String> = setOf(
        "bind", "options", "optionsKey", "valueField", "labelField", "label",
    )

    // <segmentedButton> (SegmentedButton.swift) — the Material-style multi-select grammar.
    // `color` rides as the active-segment tint (iOS's selected fill), so it is admitted.
    val SEGMENTED_BUTTON: Set<String> = setOf(
        "bind", "options", "icons", "multiple", "color",
    )

    // ── the small value-control family (M3-batch2b) — each element's look-free content
    //    words, exactly its fixture's attribute set. `color` is in EVERY one: iOS keeps the
    //    tint ON the control, so it rides the M3 component and never ejects (see header).
    val CHECKBOX: Set<String> = setOf("bind", "label", "color")
    val RADIOGROUP: Set<String> = setOf(
        "bind", "options", "optionsKey", "valueField", "labelField", "color",
    )
    val STEPPER: Set<String> = setOf("bind", "min", "max", "step", "label", "color")
    val RANGESLIDER: Set<String> = setOf("bindLow", "bindHigh", "min", "max", "step", "color")
    val OTP: Set<String> = setOf("bind", "length", "boxSize", "color")

    // ── the TEXT-INPUT family (M3-text — the M3 wave's CLOSE): textfield/textarea reuse the
    //    SAME gate. `color` rides the M3 field's TEXT + cursor color (iOS keeps
    //    `.foregroundColor(color)` ON the native field — TextField.swift:41 / TextArea.swift:51,
    //    NOT an accent `.tint`, so it never ejects — the picker/combobox precedent). `secure` /
    //    `keyboard` / `contentType` are look-free content (visual transformation / IME / autofill,
    //    never a style eject); `minLines` / `maxLines` are the textarea's line grammar (the slider
    //    min/max precedent). Every style attr / unknown word ejects to the byte-identical legacy
    //    BasicTextField (StackInputViews.kt / TextAreaElements.kt).
    val TEXTFIELD: Set<String> = setOf(
        "bind", "secure", "placeholder", "keyboard", "contentType", "color",
    )
    val TEXTAREA: Set<String> = setOf(
        "bind", "placeholder", "minLines", "maxLines", "color",
    )

    fun rendersSystem(attrs: Map<String, String>, allowed: Set<String>): Boolean =
        attrs.keys.all { k ->
            k in SAFE_BASE || k in allowed || COMPAT_PREFIXES.any { k.startsWith(it) }
        }
}
