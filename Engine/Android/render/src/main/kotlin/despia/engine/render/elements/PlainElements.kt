//
//  PlainElements.kt — the PLAIN element WAVE's registration aggregator, the exact sibling
//  shape of StackElements.register() / InputElements.register() (this folder). Registers
//  the remaining plain renderer tags into ComposeStackComponents:
//
//    textarea (TextArea.swift)                    — elements/TextAreaElements.kt
//    picker · segmented (Picker.swift)            — elements/PlainPickerElements.kt
//    refreshable/refresh (Refreshable.swift)      — elements/RefreshableElements.kt
//
//  Call sites: the host boot line (MainActivity — beside the other two waves, the iOS
//  launch class-walk twin) + the plain-JVM units (PlainElementsTest). Idempotent
//  (define* replace); a module setup() that defines the same tag later still wins,
//  exactly like iOS launch ordering. Parity specs for this wave live in
//  ElementSpecPlainWave.kt (registered from ElementSpec.kt — the JVM-visible registry).
//

package despia.engine.render.elements

object PlainElements {
    @Volatile private var registered = false

    /// Register every element of this wave. Idempotent (the registry's define* replace).
    fun register() {
        if (registered) return
        synchronized(this) {
            if (registered) return
            registerTextAreaElements()      // textarea
            registerPlainPickerElements()   // picker · segmented
            registerRefreshableElements()   // refreshable · refresh
            registered = true
        }
    }
}
