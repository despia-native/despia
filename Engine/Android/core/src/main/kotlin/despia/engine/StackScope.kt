//
//  StackScope.kt - value resolution for the StackLive render backend. Kotlin twin of
//  OpenSource/Engine/iOS/StackScope.swift (the Swift file is the reference implementation -
//  same names, same behaviors, kept in lockstep).
//
//  Pure value-mapping, no view construction: it reads a StackNode's attributes and text,
//  resolving DSX `{{ … }}` interpolation, and interprets the result as the typed values
//  elements need. Interpolation follows the DSX DSL: `{{ dsx.variable.<key> }}` only -
//  a snapshot process (widget / Live Activity / Glance) cannot run JS, so any richer
//  expression fails open to empty (StackScope.swift verbatim).
//
//  ── PINNED PLATFORM-TYPE MAPPINGS (PLAN.md ground rule 1: where Swift names a platform
//     type, the decision is pinned here + in tests) ─────────────────────────────────────
//  • CGFloat → Double: Swift's `cgFloat(_:_:)` accessor folds into `double(_:_:)` (one
//    numeric read; backends convert to dp/sp at the paint site).
//  • SwiftUI `Color` → ARGB `Long` (0xAARRGGBB). The named palette resolves to FIXED
//    values: a snapshot surface has no dynamic-color channel, so `primary`/`secondary`/
//    `accent` pin to the light-surface constants the shipped Glance widget already used
//    (primary 0xFF111111, secondary 0xFF6E6E73, accent 0xFF007AFF) - documented
//    approximation of iOS's dynamic colors, unknown input fails open to primary.
//  • `Font.Weight` → StackFontWeight, `HorizontalAlignment`/`VerticalAlignment`/
//    `Alignment` → StackHAlign/StackVAlign (the frame alignment reuses StackHAlign -
//    Swift's `Alignment` cases used here are the horizontal three).
//

package despia.engine

/// The variable scope a layout renders in: `{{ dsx.variable.name }}` resolves from
/// `vars` (the ContentState / widget state pushed across the process boundary).
class StackScope(val vars: Map<String, String>) {

    /// Resolve every `{{ … }}` span. `{{ dsx.variable.<key> }}` → `vars[key]`;
    /// anything else (no JS in-process) → empty. An unterminated `{{` stays literal.
    fun substitute(s: String): String {
        if (!s.contains("{{")) return s
        val out = StringBuilder()
        var i = 0
        while (true) {
            val open = s.indexOf("{{", i)
            if (open < 0) break
            out.append(s, i, open)
            val close = s.indexOf("}}", open + 2)
            if (close < 0) { out.append(s, open, s.length); return out.toString() }
            out.append(resolve(s.substring(open + 2, close).trim()))
            i = close + 2
        }
        out.append(s, i, s.length)
        return out.toString()
    }

    private fun resolve(expr: String): String {
        val prefix = "dsx.variable."
        if (!expr.startsWith(prefix)) return ""
        val key = expr.substring(prefix.length)
        if (key.isEmpty() || !key.all { it.isLetterOrDigit() || it == '_' }) return ""
        return vars[key] ?: ""
    }
}

// MARK: - Typed attribute vocabulary (the pinned platform-type mappings above)

enum class StackFontWeight { REGULAR, MEDIUM, SEMIBOLD, BOLD, LIGHT }
enum class StackHAlign { LEADING, CENTER, TRAILING }
enum class StackVAlign { TOP, CENTER, BOTTOM }

/// A `StackNode` bound to a `StackScope`: typed, substituted access to its
/// attributes and text. Elements read through this; they never touch raw attrs.
class StackReader(val node: StackNode, val scope: StackScope) {

    fun string(key: String): String? = node.attrs[key]?.let { scope.substitute(it) }

    /** Full-renderer precedence: bind (data) > inner text > value. */
    val text: String
        get() {
            node.attrs["bind"]?.let { return scope.substitute("{{ $it }}").trim() }
            return scope.substitute(node.text ?: node.attrs["value"] ?: "").trim()
        }

    /// One numeric read (the Swift twin's `cgFloat` + `double`, folded - header note).
    fun double(key: String, fallback: Double): Double = string(key)?.toDoubleOrNull() ?: fallback

    /// A 0...1 value (progress, gauge fill), clamped.
    fun unit(key: String): Double = double(key, 0.0).coerceIn(0.0, 1.0)

    fun color(key: String, fallback: Long): Long = string(key)?.let { StackColor.parse(it) } ?: fallback

    val fontWeight: StackFontWeight
        get() = when (string("weight") ?: "") {
            "bold" -> StackFontWeight.BOLD
            "semibold" -> StackFontWeight.SEMIBOLD
            "medium" -> StackFontWeight.MEDIUM
            "light" -> StackFontWeight.LIGHT
            else -> StackFontWeight.REGULAR
        }
    val horizontalAlignment: StackHAlign
        get() = when (string("align") ?: "") {
            "leading", "left" -> StackHAlign.LEADING
            "trailing", "right" -> StackHAlign.TRAILING
            else -> StackHAlign.CENTER
        }
    val verticalAlignment: StackVAlign
        get() = when (string("align") ?: "") {
            "top" -> StackVAlign.TOP
            "bottom" -> StackVAlign.BOTTOM
            else -> StackVAlign.CENTER
        }
    /// Swift's `Alignment` cases used by the layout box / grid are the horizontal three.
    val frameAlignment: StackHAlign
        get() = when (string("align") ?: "") {
            "leading", "left" -> StackHAlign.LEADING
            "trailing", "right" -> StackHAlign.TRAILING
            else -> StackHAlign.CENTER
        }
    val growsWidth: Boolean
        // true/both are the cross-runtime both-axis fill words, so the snapshot/wrist
        // renderers must include them in their width projection.
        get() = string("grow").let {
            it == "true" || it == "both" || it == "width" || it == "all"
        }

    /// The event name a tap should emit on a snapshot surface (watch / extension):
    /// `event="open"` (surface-native), or the literal name lifted from the in-app form
    /// `on:tap="dsx.event('open')"` — so the SAME markup is 1:1 across iOS, watchOS and
    /// Android. No JS is evaluated: only the quoted name is read with a plain string scan
    /// (a snapshot process cannot run JSE — see this file's header).
    val tapEvent: String?
        get() {
            node.attrs["event"]?.let { if (it.isNotEmpty()) return it }
            val handler = node.attrs["on:tap"] ?: node.attrs["on:press"] ?: ""
            val call = handler.indexOf("dsx.event(")
            if (call < 0) return null
            var i = call + "dsx.event(".length
            while (i < handler.length && handler[i] == ' ') i += 1
            if (i >= handler.length) return null
            val quote = handler[i]
            if (quote != '\'' && quote != '"') return null
            val end = handler.indexOf(quote, i + 1)
            if (end < 0) return null
            val name = handler.substring(i + 1, end)
            return name.ifEmpty { null }
        }
}

/// DSX color literals the live surfaces need: a small named palette plus
/// `#RRGGBB` / `#AARRGGBB` hex, as ARGB Longs (0xAARRGGBB - the pinned mapping,
/// header note). Unknown input fails open to `primary`.
object StackColor {
    const val PRIMARY = 0xFF111111L
    const val SECONDARY = 0xFF6E6E73L
    const val ACCENT = 0xFF007AFFL
    // The divider DEFAULT — secondary at 25% alpha (0x40): a faint hairline, the
    // snapshot twin of the phone renderer's system-separator choice. Full-alpha
    // SECONDARY read as a harsh white bar on the watch's OLED black. Also the
    // "separator" parse word below — that token is EXISTING phone vocabulary
    // (ElementSpec DIVIDER_COLOR / conformance elements/divider.json pin it as
    // the divider default; Stack.swift + StackNodeView.kt resolve it), so the
    // live twins parsing it is parity, not new authoring surface. iOS twin:
    // StackScope.swift StackColor.parse / StackLive.swift LiveDividerElement
    // (Color.secondary.opacity(0.25)).
    const val DIVIDER = 0x406E6E73L

    fun parse(raw: String): Long {
        when (raw.lowercase()) {
            "primary" -> return PRIMARY
            "secondary" -> return SECONDARY
            "separator" -> return DIVIDER
            "accent", "accentcolor" -> return ACCENT
            "white" -> return 0xFFFFFFFFL
            "black" -> return 0xFF000000L
            "clear" -> return 0x00000000L
            "red" -> return 0xFFFF3B30L
            "green" -> return 0xFF34C759L
            "blue" -> return 0xFF007AFFL
            "yellow" -> return 0xFFFFCC00L
            "orange" -> return 0xFFFF9500L
        }
        val hex = raw.trim().removePrefix("#")
        if (hex.length != 6 && hex.length != 8) return PRIMARY
        val v = hex.toLongOrNull(16) ?: return PRIMARY
        return if (hex.length == 8) v else 0xFF000000L or v
    }
}
