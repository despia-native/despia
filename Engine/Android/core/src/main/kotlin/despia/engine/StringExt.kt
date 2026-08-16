//
//  StringExt.kt — string sugar helpers. Kotlin twin of Engine/String.swift —
//  same names, same arguments, same behaviors.
//
//  `length` needs no port: Kotlin's built-in `String.length` member already provides it
//  (an extension property of the same name would be permanently shadowed by the member,
//  so declaring one would be uncallable dead code). One cross-platform nuance: Swift's
//  `count` counts grapheme clusters while JVM `length` counts UTF-16 code units — they
//  agree on the ASCII keys, schemes, and URLs the kernel feeds these helpers.
//

package despia.engine

import java.net.URI
import java.net.URISyntaxException

/**
 * Strips leading/trailing whitespace and newlines (Swift `.whitespacesAndNewlines`).
 * Coincides with the stdlib `kotlin.text.trim()` on purpose — this declaration exists
 * for 1:1 surface parity with the Swift extension; same-package callers resolve to it,
 * everyone else gets the identically-behaved stdlib one.
 */
fun String.trim(): String {
    var start = 0
    var end = length
    while (start < end && this[start].isWhitespace()) start++
    while (end > start && this[end - 1].isWhitespace()) end--
    return substring(start, end)
}

/**
 * Percent-encodes the receiver with Foundation's `.urlQueryAllowed` set, then parses it —
 * or null if it doesn't parse (or is empty, which Foundation's `URL(string:)` rejects).
 *
 * Returns `java.net.URI`, not `java.net.URL`: Swift callers get a parsed value-type URL
 * handle, and URI is its JVM twin — `java.net.URL` would throw on custom schemes with no
 * registered stream handler (`despia://…`) and resolves DNS in `equals`, so it cannot
 * carry the kernel's scheme URLs.
 *
 * Faithful to the Swift original, an existing `%` is RE-encoded (`%20` → `%2520`) and a
 * `#` is encoded (`.urlQueryAllowed` contains neither) — this helper is for raw, not
 * pre-encoded, strings.
 */
fun String.makeURL(): URI? {
    if (isEmpty()) return null  // URL(string: "") is nil on Swift; URI("") would parse
    val encoded = percentEncodeURLQueryAllowed(this)
    return try { URI(encoded) } catch (_: URISyntaxException) { null }
}

// Foundation's CharacterSet.urlQueryAllowed — RFC 3986 query = *( pchar / "/" / "?" ):
// unreserved + sub-delims + ":" / "@" / "/" / "?". Note "%" and "#" are NOT allowed.
private val URL_QUERY_ALLOWED = BooleanArray(128).also { ok ->
    for (c in 'A'..'Z') ok[c.code] = true
    for (c in 'a'..'z') ok[c.code] = true
    for (c in '0'..'9') ok[c.code] = true
    for (c in "-._~!\$&'()*+,;=:@/?") ok[c.code] = true
}

private const val HEX = "0123456789ABCDEF"

// Swift `addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)`: UTF-8 bytes of
// every character outside the allowed set become %XX escapes.
private fun percentEncodeURLQueryAllowed(s: String): String {
    val out = StringBuilder(s.length)
    for (b in s.toByteArray(Charsets.UTF_8)) {
        val i = b.toInt() and 0xFF
        if (i < 128 && URL_QUERY_ALLOWED[i]) out.append(i.toChar())
        else out.append('%').append(HEX[i shr 4]).append(HEX[i and 0xF])
    }
    return out.toString()
}
