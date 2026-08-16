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
