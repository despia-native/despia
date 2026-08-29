//
//  StackDesktopInput.kt - the shared desktop input grammar (:core, pure JVM): shortcut=
//  accelerator matching + focusOrder= traversal resolution. The law is the corpus:
//  OpenSource/Conformance/input/{shortcut,focusOrder}.json (desktop-platforms.md). The twin
//  of Swift StackDesktopInput and the web @despia/dom matchShortcut/resolveFocusOrder — the
//  Compose Desktop renderer binds its raw key events to matchesShortcut so it can never
//  drift from the web/native accelerators.
//
package despia.engine

object StackDesktopInput {

    /** Parse a `shortcut=` declaration into (key, modifiers): lowercased, split on '+',
     *  trimmed, empties dropped; the LAST token is the key and the rest are modifiers. */
    fun parseShortcut(shortcut: String): Pair<String, Set<String>> {
        val parts = shortcut.lowercase().split("+").map { it.trim() }.filter { it.isNotEmpty() }
        val key = parts.lastOrNull() ?: return "" to emptySet()
        return key to parts.dropLast(1).toSet()
    }

    /** Does this key event fire the accelerator? `cmd` is the primary modifier (matches meta
     *  OR ctrl); `ctrl`/`alt`/`shift` are literal; the key compares case-insensitively; an
     *  UNMODIFIED shortcut is suppressed while an editable target holds focus. */
    fun matchesShortcut(
        shortcut: String,
        key: String,
        meta: Boolean,
        ctrl: Boolean,
        alt: Boolean,
        shift: Boolean,
        editable: Boolean,
    ): Boolean {
        val (want, mods) = parseShortcut(shortcut)
        if (want.isEmpty() || key.lowercase() != want) return false
        if (mods.contains("cmd") && !(meta || ctrl)) return false
        if (mods.contains("ctrl") && !ctrl) return false
        if (mods.contains("alt") && !alt) return false
        if (mods.contains("shift") && !shift) return false
        if (editable && !(mods.contains("cmd") || mods.contains("ctrl"))) return false
        return true
    }

    /** The Return-key spellings the toolkits use. Compose reports `Enter`, the DOM reports
     *  `Enter` and `NumpadEnter`, AppKit reports `Return`. */
    val RETURN_KEYS: Set<String> = setOf("enter", "return", "numpadenter")

    /** What Return should do in a MULTILINE field. See the corpus for the full reasoning
     *  (OpenSource/Conformance/input/multiline-submit.json); the short version is that Return
     *  already means "newline" in a multiline field and must keep meaning it on a soft
     *  keyboard, so this grammar decides HARDWARE key events only.
     *
     *  Returns `submit`, `newline`, or `ignore` - and the last two are different answers.
     *  `ignore` means this grammar has no opinion and the caller must NOT consume the event;
     *  `newline` means Return was handled and resolved to a break. A caller that collapses the
     *  two eats keystrokes it was never asked about. */
    fun multilineReturn(
        key: String,
        shift: Boolean,
        meta: Boolean,
        ctrl: Boolean,
        alt: Boolean,
        submitOnEnter: Boolean,
        hasSubmit: Boolean,
    ): String {
        if (key.lowercase() !in RETURN_KEYS) return "ignore"
        // The explicit line-break chords win over everything, including an authored
        // submitOnEnter: turning Enter-to-send on must not take away the way out of it.
        if (shift || alt) return "newline"
        if (meta || ctrl) return if (hasSubmit) "submit" else "ignore"
        if (submitOnEnter && hasSubmit) return "submit"
        return "newline"
    }

    /** Resolve `focusOrder=` to a traversal index. A disabled control is ALWAYS out of
     *  traversal (-1); otherwise a decimal-integer order is the explicit index, and
     *  absent/non-finite/empty leaves the toolkit default (null). */
    fun resolveFocusOrder(focusOrder: String?, disabled: Boolean): Int? {
        if (disabled) return -1
        val trimmed = focusOrder?.trim() ?: return null
        if (!Regex("^-?\\d+$").matches(trimmed)) return null
        return trimmed.toInt()
    }
}
