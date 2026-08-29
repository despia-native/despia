//
//  StackTooltip.kt - the shared tooltip= / tooltipSide= grammar (:core, pure JVM): the
//  attribute fold + the show/dismiss lifecycle. The law is the corpus:
//  OpenSource/Conformance/input/tooltip.json (design-system.md Wave 3 (c)1). The twin of
//  Swift StackTooltip/StackTooltipLifecycle and the web @despia/dom resolveTooltip/
//  TooltipLifecycle. A resolved tooltip always doubles as the element's accessibility
//  description (the platform hint slot - TooltipCompat/tooltipText on Android renderers);
//  the visual reveal shows ONLY from a hover-capable fine-pointer source, so a touch
//  surface never fires it and its content is never gated behind hover (Article 7).
//
package despia.engine

object StackTooltip {

    data class Resolved(val text: String, val side: String)

    private val SIDES = setOf("top", "bottom", "leading", "trailing")

    /** Resolve tooltip= / tooltipSide=: whitespace-only text drops the tooltip; the side
     *  vocabulary is the floating-preference set, exact lowercase after trim, with `top`
     *  the default AND the fallback for anything unrecognized. */
    fun resolve(tooltip: String?, side: String?): Resolved? {
        val text = tooltip?.trim() ?: return null
        if (text.isEmpty()) return null
        val trimmed = side?.trim() ?: ""
        return Resolved(text, if (trimmed in SIDES) trimmed else "top")
    }
}

/**
 * Renderer-neutral show/dismiss state machine for the resolved tooltip. Events are
 * INTENT-qualified - the UI adapter owns its hover-intent delay and pointer identity, then
 * reports each source with its own hover capability: a non-capable source (touch) is never
 * even tracked. visible = (hovered || focused) && !dismissed; Escape dismisses and
 * suppresses re-show until hover and focus have BOTH cleared. No authored events exist.
 */
class StackTooltipLifecycle {
    private var hovered = false
    private var focused = false
    private var dismissed = false

    val visible: Boolean get() = (hovered || focused) && !dismissed

    fun hoverStart(hoverCapable: Boolean): List<String> = transition { if (hoverCapable) hovered = true }

    fun hoverEnd(): List<String> = transition { hovered = false }

    fun focus(hoverCapable: Boolean): List<String> = transition { if (hoverCapable) focused = true }

    fun blur(): List<String> = transition { focused = false }

    fun escape(): List<String> = transition { if (visible) dismissed = true }

    fun unmount(): List<String> = transition {
        hovered = false
        focused = false
    }

    private inline fun transition(mutate: () -> Unit): List<String> {
        val before = visible
        mutate()
        if (!hovered && !focused) dismissed = false
        val after = visible
        return if (before == after) emptyList() else listOf(if (after) "show" else "hide")
    }
}
