//
//  SystemBars.kt — the Kotlin twin of Engine/iOS/SystemBars.swift and the web kernel's
//  systembars.ts: the SHARED PURE CORE behind Core/SystemBars (F17.5).
//
//  WHY THIS NEEDS A CORE. Android 15 makes edge-to-edge mandatory, which changes what a colour
//  on the navigation bar even does: the bar becomes transparent and the app draws under it, so
//  a `color` that used to paint a strip now paints nothing. iOS has no navigation bar at all,
//  but it has the home indicator, and hiding that is the same author intent against different
//  hardware. Left to each platform, `immersive` would mean three things.
//
//  THE LUMA FORMULA IS THE SIMPLE ONE, ON PURPOSE. WCAG relative luminance needs a per-channel
//  power function, and pow() is not guaranteed identical to the last bit across three
//  languages. A one-ULP difference at the threshold flips a bar's icons from black to white on
//  one platform only, which is exactly the drift this core exists to prevent. ITU-R BT.601 luma
//  is a weighted sum of integers, exact everywhere.
//
//  Pure JVM — no Android imports. Pinned by OpenSource/Conformance/systembars/bars.json.
//
package despia.engine

object SystemBars {

    val STYLES: List<String> = listOf("light", "dark", "auto")
    val BEHAVIORS: List<String> = listOf("default", "swipe")
    val MODES: List<String> = listOf("none", "leanback", "sticky")

    /** Above this luma the background is "light", so the bar's icons must be dark. */
    const val LUMA_THRESHOLD = 0.5

    val MESSAGES: Map<String, String> = mapOf(
        "unknown_style" to "That is not a system-bar style. Use light, dark or auto.",
        "unknown_behavior" to "That is not a system-bar behavior. Use default or swipe.",
        "unknown_mode" to "That is not an immersive mode. Use none, leanback or sticky.",
        "invalid_color" to
            "That is not a colour. Use #RRGGBB, #RRGGBBAA, an R,G,B triple, or transparent.",
    )

    val DIAGNOSTICS: Map<String, String> = mapOf(
        "color_ignored_edge_to_edge" to
            "Edge-to-edge makes the system bars transparent, so the colour was not applied. " +
                "Draw the colour in your own layout instead.",
        "divider_ignored_edge_to_edge" to
            "Edge-to-edge removes the navigation-bar divider, so the divider colour was not applied.",
        "visible_overridden_by_immersive" to
            "An immersive mode hides the system bars, so `visible: true` was overridden.",
    )

    class RefusalError(val code: String, val detail: String?) : Exception(code)

    private fun <T> refuse(code: String, detail: String? = null): Result<T> =
        Result.failure(RefusalError(code, detail))

    fun code(error: Throwable): String = (error as? RefusalError)?.code ?: "invalid_color"

    fun detail(error: Throwable): String {
        val d = (error as? RefusalError)?.detail
        if (!d.isNullOrEmpty()) return d
        return MESSAGES[code(error)] ?: code(error)
    }

    /** 0..255 on every channel, so the whole colour is integers and no float crosses a boundary. */
    data class Color(val r: Int, val g: Int, val b: Int, val a: Int)

    data class Plan(
        val visible: Boolean,
        val style: String,
        val behavior: String,
        val immersive: String,
        val edgeToEdge: Boolean,
        val color: Color,
        val dividerColor: Color,
        val iconsDark: Boolean,
        val insetTop: Boolean,
        val insetBottom: Boolean,
        val hidesHomeIndicator: Boolean,
        val diagnostics: List<String>,
    )

    private fun foldWord(
        raw: Any?, vocabulary: List<String>, fallback: String, refusalCode: String,
    ): Result<String> {
        val text = (raw?.toString() ?: "").trim().lowercase()
            .filter { !it.isWhitespace() && it != '-' && it != '_' }
        if (text.isEmpty()) return Result.success(fallback)
        for (word in vocabulary) {
            if (word == text) return Result.success(word)
        }
        return refuse(refusalCode, raw?.toString() ?: "")
    }

    fun foldStyle(raw: Any?): Result<String> = foldWord(raw, STYLES, "auto", "unknown_style")
    fun foldBehavior(raw: Any?): Result<String> = foldWord(raw, BEHAVIORS, "default", "unknown_behavior")
    fun foldMode(raw: Any?): Result<String> = foldWord(raw, MODES, "none", "unknown_mode")

    private fun hexDigit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    /**
     * Parse the colour spellings a Despia author already writes elsewhere: `#RGB`, `#RGBA`,
     * `#RRGGBB`, `#RRGGBBAA`, the legacy `R,G,B` triple that `bottombarcolor://` carried, and
     * the word `transparent`. Anything else is refused rather than silently becoming black: a
     * bar that quietly turns black is the hardest styling bug to find, because it looks
     * deliberate.
     */
    fun parseColor(raw: Any?): Result<Color> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return refuse("invalid_color", "a colour is required")
        if (text.lowercase() == "transparent") return Result.success(Color(0, 0, 0, 0))

        if (text.startsWith("#")) {
            val body = text.substring(1)
            val digits = ArrayList<Int>(body.length)
            for (c in body) {
                val d = hexDigit(c)
                if (d < 0) return refuse("invalid_color", text)
                digits.add(d)
            }
            if (digits.size == 3 || digits.size == 4) {
                // Short form doubles each digit: #f0a is #ff00aa, the same rule CSS uses.
                return Result.success(
                    Color(
                        digits[0] * 17, digits[1] * 17, digits[2] * 17,
                        if (digits.size == 4) digits[3] * 17 else 255,
                    ),
                )
            }
            if (digits.size == 6 || digits.size == 8) {
                return Result.success(
                    Color(
                        digits[0] * 16 + digits[1],
                        digits[2] * 16 + digits[3],
                        digits[4] * 16 + digits[5],
                        if (digits.size == 8) digits[6] * 16 + digits[7] else 255,
                    ),
                )
            }
            return refuse("invalid_color", text)
        }

        if (text.contains(",")) {
            val parts = text.split(",").map { it.trim() }
            if (parts.size != 3 && parts.size != 4) return refuse("invalid_color", text)
            val values = ArrayList<Int>(parts.size)
            for (part in parts) {
                if (part.isEmpty() || part.any { it !in '0'..'9' }) return refuse("invalid_color", text)
                val n = part.toIntOrNull() ?: return refuse("invalid_color", text)
                if (n > 255) return refuse("invalid_color", text)
                values.add(n)
            }
            return Result.success(
                Color(values[0], values[1], values[2], if (values.size == 4) values[3] else 255),
            )
        }

        return refuse("invalid_color", text)
    }

    /** ITU-R BT.601 luma, 0..1. Integer weights, so three languages cannot disagree. */
    fun luma(color: Color): Double =
        (299.0 * color.r + 587.0 * color.g + 114.0 * color.b) / 255000.0

    /**
     * Should the bar's icons be dark? A light background needs dark icons and vice versa.
     *
     * A TRANSPARENT bar is the interesting case: there is no background to read, so the icons
     * must contrast with whatever the app draws underneath, which this core cannot see. The
     * answer is therefore the app's own appearance, passed in by the caller, never a guess.
     */
    fun iconsDark(color: Color, appearanceIsDark: Boolean): Boolean {
        if (color.a == 0) return !appearanceIsDark
        return luma(color) > LUMA_THRESHOLD
    }

    private fun truthy(raw: Any?, fallback: Boolean): Boolean {
        if (raw == null) return fallback
        if (raw is Boolean) return raw
        return when (raw.toString().trim().lowercase()) {
            "true", "1", "yes" -> true
            "false", "0", "no" -> false
            else -> fallback
        }
    }

    /**
     * Resolve a request into the plan every platform applies.
     *
     * THE THREE INTERACTIONS THAT MAKE THIS WORTH SHARING:
     *  1. Edge-to-edge WINS OVER COLOUR. Android 15 forces transparent system bars, so a colour
     *     set alongside `edgeToEdge` paints nothing. The plan drops it and says
     *     `color_ignored_edge_to_edge` rather than letting the author believe it worked.
     *  2. An IMMERSIVE MODE IMPLIES the bars are gone. `leanback` plus `visible: true` is a
     *     contradiction; the mode wins and `visible_overridden_by_immersive` is reported.
     *  3. HIDDEN BARS NEED NO INSETS. `insetTop`/`insetBottom` come from the same place as the
     *     visibility decision, which is what stops the classic "content under the notch after
     *     going fullscreen" bug.
     */
    fun plan(raw: Map<String, Any?>): Result<Plan> {
        val styleWord = foldStyle(raw["style"]).getOrElse { e -> return Result.failure(e) }
        val behavior = foldBehavior(raw["behavior"]).getOrElse { e -> return Result.failure(e) }
        val immersive = foldMode(raw["immersive"]).getOrElse { e -> return Result.failure(e) }

        val edgeToEdge = truthy(raw["edgeToEdge"], false)
        val appearanceIsDark = truthy(raw["appearanceIsDark"], false)
        val diagnostics = ArrayList<String>()

        var color = Color(0, 0, 0, 0)
        val rawColor = raw["color"]
        if (rawColor != null && rawColor.toString().isNotEmpty()) {
            val parsed = parseColor(rawColor).getOrElse { e -> return Result.failure(e) }
            if (edgeToEdge) diagnostics.add("color_ignored_edge_to_edge") else color = parsed
        }

        var dividerColor = Color(0, 0, 0, 0)
        val rawDivider = raw["dividerColor"]
        if (rawDivider != null && rawDivider.toString().isNotEmpty()) {
            val parsed = parseColor(rawDivider).getOrElse { e -> return Result.failure(e) }
            if (edgeToEdge) diagnostics.add("divider_ignored_edge_to_edge") else dividerColor = parsed
        }

        val requestedVisible = truthy(raw["visible"], true)
        val immersiveHides = immersive != "none"
        var visible = requestedVisible
        if (immersiveHides && requestedVisible && raw["visible"] != null) {
            diagnostics.add("visible_overridden_by_immersive")
        }
        if (immersiveHides) visible = false

        val dark = if (styleWord == "auto") iconsDark(color, appearanceIsDark) else styleWord == "dark"
        val resolvedStyle = if (dark) "dark" else "light"

        // Under edge-to-edge the app draws behind the bars, so it owns the insets even while
        // they are visible. Hidden bars consume nothing either way.
        val insets = visible && !edgeToEdge

        return Result.success(
            Plan(
                visible, resolvedStyle, behavior, immersive, edgeToEdge, color, dividerColor,
                dark, insets, insets, immersiveHides, diagnostics,
            ),
        )
    }
}
