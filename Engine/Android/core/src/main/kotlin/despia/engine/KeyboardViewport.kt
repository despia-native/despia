package despia.engine

/**
 * KeyboardViewport.kt — the soft-keyboard viewport contract, Kotlin twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/keyboard/README.md; the cases live in
 * viewport.json and run against THIS file (:core KeyboardViewportConformanceTest), against the TS
 * twin (packages/kernel/src/keyboard.ts) and against the Swift twin.
 *
 * Everything here is pure: geometry in, published values out. The surface work — observing the
 * IME, resizing the web view, writing the CSS property — belongs to the Core/Basics/Viewport
 * module's kotlin facet. Keeping the decision separate from the plumbing is what lets one corpus
 * judge three runtimes, and is why this lives in :core and runs without an Android SDK.
 */

/** How the soft keyboard is allowed to affect the layout viewport. */
enum class KeyboardMode(val word: String) {
    LEGACY("legacy"),
    RESIZE("resize"),
    OVERLAY("overlay"),
}

data class KeyboardRect(val x: Int, val y: Int, val width: Int, val height: Int)

data class KeyboardViewportState(
    /** The mode actually in force, after capability gating. */
    val mode: KeyboardMode,
    /** True when the declared mode could not be honoured and fell back to LEGACY. */
    val degraded: Boolean,
    /** How much of the LAYOUT VIEWPORT the keyboard still obscures — `--keyboard-inset-height`. */
    val insetHeight: Int,
    /** The same fact as a boolean: `navigator.virtualKeyboard.overlaysContent`. */
    val overlaysContent: Boolean,
    /** Where the keyboard is, clamped to the viewport: `navigator.virtualKeyboard.boundingRect`. */
    val boundingRect: KeyboardRect,
)

object KeyboardViewport {

    /** Android's floor for reliable IME geometry: WindowInsets.Type.ime, API 30 (R). */
    const val IME_INSETS_API_FLOOR: Int = 30

    private val EMPTY_RECT = KeyboardRect(0, 0, 0, 0)

    /**
     * The declared mode word, normalized. Anything unrecognized is LEGACY: this value comes from a
     * dashboard field, and a typo must not fail a build or produce half-applied behavior.
     */
    fun parseMode(declared: String?): KeyboardMode =
        when (declared?.trim()?.lowercase()) {
            "resize" -> KeyboardMode.RESIZE
            "overlay" -> KeyboardMode.OVERLAY
            else -> KeyboardMode.LEGACY
        }

    /**
     * The mode a runtime `navigator.virtualKeyboard.overlaysContent` assignment asks for.
     *
     * The page has exactly two things to say — overlay the content, or take the space out of the
     * layout viewport — so the standard boolean covers the whole runtime vocabulary. LEGACY is
     * deliberately unreachable from here: it is the frozen BUILD default, not something a page can
     * ask to return to.
     */
    fun modeForOverlaysContent(requested: Boolean): KeyboardMode =
        if (requested) KeyboardMode.OVERLAY else KeyboardMode.RESIZE

    /**
     * Can this platform honour a non-legacy mode?
     *
     * Android only has reliable IME geometry from API 30; below that the signal is inconsistent
     * enough that a half-working `resize` is worse than none, and an UNKNOWN level fails closed
     * for the same reason. iOS and web are always capable.
     */
    fun supportsViewportModes(platform: String, api: Int?): Boolean {
        if (!platform.equals("android", ignoreCase = true)) return true
        return api != null && api >= IME_INSETS_API_FLOOR
    }

    /**
     * The whole contract, in one function.
     *
     * The subtle part is [KeyboardViewportState.insetHeight], and it is the reason a page can be
     * written once and work in every mode: it reports what the keyboard obscures OF THE LAYOUT
     * VIEWPORT, not how tall the keyboard is. Under RESIZE the viewport has already shrunk, so the
     * answer is 0 — publishing the raw height there would double-count and push content off
     * screen. [KeyboardViewportState.boundingRect] answers the different question of WHERE the
     * keyboard is, so it stays real in every mode.
     *
     * TWO PLANES FEED ONE ANSWER. [declared] is the build's word and never moves; [requested] is
     * the page's live `overlaysContent` assignment and wins while it is set. Capability gating
     * applies to whichever won, which is why [KeyboardViewportState.overlaysContent] is the
     * READ-BACK CONTRACT rather than an echo: a request the platform cannot honour degrades, and
     * the page must be told what is in force instead of being left believing it got what it asked
     * for.
     */
    fun resolve(
        declared: String?,
        platform: String,
        api: Int? = null,
        keyboardVisible: Boolean,
        keyboardHeight: Int,
        viewportWidth: Int,
        viewportHeight: Int,
        requested: Boolean? = null,
    ): KeyboardViewportState {
        val declaredMode = if (requested != null) modeForOverlaysContent(requested) else parseMode(declared)
        val capable = supportsViewportModes(platform, api)
        val mode = if (declaredMode == KeyboardMode.LEGACY || capable) declaredMode else KeyboardMode.LEGACY
        // Declaring LEGACY on an incapable platform is not degradation — it got what it asked for.
        val degraded = declaredMode != KeyboardMode.LEGACY && !capable

        // A keyboard cannot obscure more than the viewport, and a negative height is nonsense that
        // reads as dismissed. Both guards matter: without them a rotation race or a bad platform
        // report becomes a negative CSS length or a rect taller than the screen.
        val height = if (keyboardVisible) keyboardHeight.coerceIn(0, maxOf(0, viewportHeight)) else 0

        val rect = if (height > 0) {
            KeyboardRect(x = 0, y = viewportHeight - height, width = viewportWidth, height = height)
        } else {
            EMPTY_RECT
        }

        val overlays = mode != KeyboardMode.RESIZE
        return KeyboardViewportState(
            mode = mode,
            degraded = degraded,
            insetHeight = if (overlays) height else 0,
            overlaysContent = overlays,
            boundingRect = rect,
        )
    }
}
