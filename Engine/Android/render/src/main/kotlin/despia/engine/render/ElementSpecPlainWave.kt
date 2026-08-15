//
//  ElementSpecPlainWave.kt — the PLAIN element wave's parity specs (textarea · picker ·
//  segmented · refreshable) + their single-sourced constants. Registered from
//  ElementSpec.kt's registerBuiltins() via ONE call line (`registerPlainWaveSpecs()`),
//  so the plain-JVM ElementParityTest class-loads these specs exactly like the built-ins
//  (ElementSpec.kt header rule 2). Constants live in `PlainWaveDefaults` and are
//  referenced by BOTH the specs below and the implementations
//  (elements/TextAreaElements.kt · PlainPickerElements.kt · RefreshableElements.kt),
//  so spec and code cannot drift apart (header rule 3).
//
//  Only the cross-platform contract is declared (header rule 4): attribute defaults and
//  geometry the fixtures pin. Android-only chrome (the segmented control's UISegmentedControl
//  metric approximations, the pull-to-refresh reveal geometry) stays OUT of the specs —
//  it is pinned here as constants and in each element file's header instead.
//

package despia.engine.render

/// The plain wave's constants — iOS sources cited per line (the fixtures cite the same).
internal object PlainWaveDefaults {
    // ── <textarea> (TextArea.swift) ──
    const val TEXTAREA_MIN_LINES = 3                  // TextArea.swift:31
    const val TEXTAREA_MAX_LINES = 8                  // TextArea.swift:32
    const val TEXTAREA_COLOR = "label"                // TextArea.swift color default — system-defaults base pass
    const val TEXTAREA_PLACEHOLDER_ALPHA = 0.3f       // Android chrome (iOS native prompt styling — the textfield precedent)

    // ── <picker> / <segmented> (Picker.swift) ──
    const val PICKER_TINT = "accent"                  // Picker.swift:31 (menu style only)
    // Android chrome — UISegmentedControl approximations (iOS renders the native control;
    // internal, NOT spec'd — the segmented fixture pins no geometry/colors):
    const val SEG_CONTROL_HEIGHT = 32.0               // UISegmentedControl default height
    const val SEG_CONTROL_RADIUS = 9.0                // the iOS 13+ rounded track
    const val SEG_CONTROL_PAD = 2.0                   // track inset around the selected platter
    const val SEG_CONTROL_FONT = 13.0                 // 13pt medium segment titles
    const val SEG_CONTROL_PLATTER = "#636366"         // dark-mode selected-segment platter
    // Menu platter chrome for <picker> — the UIMenu numbers already pinned by Menus.kt /
    // Forms.kt FieldPicker (width 250, radius 13, regular material, 16×12 rows, hairlines).
    const val PICKER_MENU_WIDTH = 250.0
    const val PICKER_MENU_RADIUS = 13.0
    const val PICKER_ROW_PAD_H = 16.0
    const val PICKER_ROW_PAD_V = 12.0
    const val PICKER_CHEVRON_SIZE = 12.0              // chevron.up.chevron.down (FieldPicker precedent)

    // ── <refreshable> / <refresh> (Refreshable.swift) ──
    const val REFRESH_GRACE_MS = 350L                 // Refreshable.swift:32 (no busy flag → grace)
    const val REFRESH_SETTLE_MS = 50L                 // Refreshable.swift:34 (let the action flip busy → true)
    const val REFRESH_POLL_MS = 60L                   // Refreshable.swift:36 (busy poll cadence)
    // Android chrome — the pull reveal (iOS: the system `.refreshable` spinner; internal):
    const val REFRESH_THRESHOLD = 70.0                // dp pulled (post-resistance) that arms a refresh
    const val REFRESH_HOLD = 56.0                     // dp the spinner band holds at while busy
    const val REFRESH_RESISTANCE = 0.5f               // drag → reveal damping
}

/// The plain wave's parity specs — called ONCE from ElementSpecs.registerBuiltins()
/// (right after registerInputWave()); alphabetical, exactly the fixture keys.
internal fun registerPlainWaveSpecs() {
    val d = PlainWaveDefaults
    ElementSpecs.register(ElementSpec("picker",
        attributes = mapOf("bind" to null, "options" to null, "optionsKey" to null,
                           "valueField" to "id", "labelField" to "label",
                           "label" to null, "color" to d.PICKER_TINT),
        colors = mapOf("tint" to d.PICKER_TINT)))
    ElementSpecs.register(ElementSpec("refreshable", aliases = listOf("refresh"),
        attributes = mapOf("on:refresh" to null, "busy" to null),
        geometry = mapOf("graceMs" to d.REFRESH_GRACE_MS.toDouble(),
                         "pollMs" to d.REFRESH_POLL_MS.toDouble())))
    ElementSpecs.register(ElementSpec("segmented",
        attributes = mapOf("bind" to null, "options" to null, "optionsKey" to null,
                           "valueField" to "id", "labelField" to "label",
                           "label" to null)))
    ElementSpecs.register(ElementSpec("textarea",
        attributes = mapOf("bind" to null, "placeholder" to null,
                           "color" to d.TEXTAREA_COLOR,
                           "minLines" to ElementSpecs.canon(d.TEXTAREA_MIN_LINES.toDouble()),
                           "maxLines" to ElementSpecs.canon(d.TEXTAREA_MAX_LINES.toDouble()),
                           "on:focus" to null, "on:blur" to null),
        geometry = mapOf("minLines" to d.TEXTAREA_MIN_LINES.toDouble(),
                         "maxLines" to d.TEXTAREA_MAX_LINES.toDouble()),
        colors = mapOf("text" to d.TEXTAREA_COLOR)))
}
