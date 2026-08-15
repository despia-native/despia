//
//  Bridge.kt — the pure (WebKit-free) half of Engine/Bridge.swift: `ModuleCallError`
//  and `Bridge.Params`, the unified inbound-payload reader. Kotlin twin — same names,
//  same arguments, same behaviors.
//
//  DELIBERATELY NOT HERE (Article 1 / web-surface policy): `VirtualBridge` — the
//  window.virtual transport, its injected script, and `receive(_ body:)`'s
//  navigation fallback are the web relay, owned by the Dom module on Android too
//  (K2 `:platform` + the Dom module wire it; the kernel names no WebView). What
//  Context needs from Bridge.swift is exactly what is ported here: the error
//  model, the terminal `Outcome`, and the smart-typed `Params`.
//
//  Pure-JVM mappings (PLAN.md ground rule 3):
//    • Foundation `URL`      → `java.net.URI` (the StringExt.makeURL precedent —
//      java.net.URL can't carry custom schemes).
//    • `URLComponents.queryItems`'s one percent-decode pass → `percentDecode`
//      (conservative: a malformed escape leaves the text unchanged, which is also
//      what the smart `urlDecode` pass needs — "50% off" survives).
//    • `JSONSerialization(.fragmentsAllowed)` → the Json.kt `json(...)` reader.
//      A literal `null` value is represented as the JSE `NSNull` sentinel
//      (present-null), so `raw("x")` distinguishes "present but null" from
//      "absent" exactly like Swift; `Context.args` maps it back to plain null.
//    • `NSNumber.stringValue` → `numberString` (a whole Double renders integral:
//      NSNumber(2.0).stringValue == "2").
//

@file:Suppress("UNCHECKED_CAST")

package despia.engine

import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.net.URI
import kotlin.math.abs
import kotlin.math.floor

/// Error raised when a `dsx.module` call can't complete. The three cases of the
/// cross-runtime contract (cross-module-calls.md): a Swift enum, a Kotlin sealed class.
sealed class ModuleCallError(message: String) : Exception(message) {

    /// No package owns the URI's scheme (excluded from this build, or never
    /// existed). Matches a "skip if absent" idiom (Swift `try?`; Kotlin
    /// `runCatching` / a caught fire-and-forget).
    class NotLoaded(val scheme: String) :
        ModuleCallError("No module owns scheme '$scheme' in this build.")

    /// The URI was malformed (couldn't parse a scheme).
    class InvalidURI(val uri: String) :
        ModuleCallError("Malformed module call URI: '$uri'")

    /// The target package handled the call but settled with an error.
    /// `code` is the package-defined identifier (e.g. `"missing_param"`);
    /// `data` is whatever the handler passed to `dsx.error(_, _)`.
    class ActionFailed(val code: String, val data: Any?) :
        ModuleCallError("Module action failed: '$code'")
}

object Bridge {

    /// Terminal outcome of an internal (package-to-package) call. Mirrors
    /// the JS-side `await window.despia(...)` resolution but stays native-side.
    internal sealed class Outcome {
        class Resolve(val payload: Any?) : Outcome()
        /// `message`/`recoverable` widen the INTERNAL plumbing only (error-system.md §3.3a):
        /// the caller-facing `ModuleCallError` stays code+data (source-compat), but the
        /// call-failure funnel records the full fidelity the handler authored.
        class Error(val code: String, val data: Any?,
                    val message: String? = null, val recoverable: Boolean = false) : Outcome()
    }

    /// Unified reader for the inbound payload. Two construction paths:
    ///
    ///   - `Params(url:)` reads the URL query string. Values get one percent-decode
    ///     pass (the URLComponents twin); one additional smart pass handles
    ///     `+`-as-space (form encoding) and double-encoded values. Plain text with
    ///     stray `%` (`"50% off"`) is left alone. For the raw wire form, see `raw(_:)`.
    ///
    ///   - `Params(dict:requestID:)` takes a structured `Map<String, Any?>` from
    ///     `window.virtual.send({...})` / a surface mount. Real arrays, nested maps,
    ///     numbers, and bools survive intact; strings are passed through verbatim
    ///     (structured callers shouldn't be percent-encoding values).
    ///
    /// Handlers use the same typed accessors regardless of source.
    class Params private constructor(
        private val named: Map<String, Any?>,
        requestID: String?,
        ridFromQuery: Boolean,
        /// Set when this call originated from a `dsx.module` call (one package
        /// calling another). `resolve` / `error` invoke this instead of writing a
        /// JS-promise result. Side-effect deliveries (`broadcast`) still go through.
        internal val onTerminal: ((Outcome) -> Unit)?,
        /// The mounted SURFACE this call originated from (`dsx.messenger.mount` id),
        /// null for the legacy web path and native `dsx.module` callers. `Context`
        /// routes this call's resolve / error / stream events to that surface's
        /// mounted sink (Messenger.kt) instead of the web fallback.
        val surfaceID: String?,
        /// Exact mounted-surface generation for calls admitted through
        /// [DSXMessengerMount]. Context keeps the public [surfaceID] in wire
        /// envelopes, but generation-target delivery uses this token so a delayed
        /// reply can never be inherited by a replacement mounted under the same id.
        /// Null for legacy VirtualBridge, URL, and native package calls.
        messengerRegistration: DSXMessengerRegistration?,
    ) {

        // A delayed/never-settling handler may retain Params indefinitely. Keep only
        // a weak route back to the generation so unmounting releases its sink/surface.
        private val messengerRegistrationRef =
            messengerRegistration?.let { WeakReference(it) }
        /** True records mounted origin even after the weak generation token clears.
         * Context must drop that delivery rather than fall back to public-id lookup. */
        internal val hasMessengerRegistration: Boolean = messengerRegistration != null
        internal val messengerRegistration: DSXMessengerRegistration?
            get() = messengerRegistrationRef?.get()

        /// `__rid` echo; carried in the result envelope (built in `Context`) to
        /// correlate results to outbound requests. `null` for legacy callers.
        val requestID: String? = if (ridFromQuery) named["__rid"] as? String else requestID

        /// `true` when the call carries `__stop=true` - the signal a stream
        /// caller sends when terminating its subscription.
        val isStop: Boolean get() = bool("__stop")

        // PUBLIC on the JVM (the RemoteBundleGate.kt header's pinned decision): Swift's
        // access-modifier-free `init(url:)` spans the whole app target, and module code —
        // MultiApiCall's synthetic `name://` re-dispatch through `dsx.handle(url:params:)` —
        // constructs it there; on the JVM those consumers land in :app, a separate Gradle
        // module. The dict/onTerminal constructors stay internal (kernel-only paths).
        constructor(url: URI, surfaceID: String? = null) :
            this(parseQuery(url), null, true, null, surfaceID, null)

        internal constructor(dict: Map<String, Any?>, requestID: String?, surfaceID: String? = null) :
            this(dict, requestID, false, null, surfaceID, null)

        /** Generation-aware mounted-surface path. Kept distinct from the legacy
         * structured constructor so VirtualBridge's rid-less `"web"` dispatch does
         * not acquire a mount token accidentally. */
        internal constructor(
            dict: Map<String, Any?>,
            requestID: String?,
            surfaceID: String,
            messengerRegistration: DSXMessengerRegistration,
        ) : this(dict, requestID, false, null, surfaceID, messengerRegistration)

        /// Internal-call constructor: the caller is another package, not JS.
        /// Terminal outcomes route to `onTerminal` instead of the JS bridge.
        internal constructor(dict: Map<String, Any?>, onTerminal: (Outcome) -> Unit) :
            this(dict, null, false, onTerminal, null, null)

        // MARK: - Accessors

        /// All params, structured. Useful when forwarding wholesale.
        val all: Map<String, Any?> get() = named

        /// All params flattened to strings - the `Map<String, String>` view the
        /// legacy URL-style managers expect. Scalars stringify (bools as
        /// "true"/"false"); arrays join on "," (matching the legacy
        /// `services=180d,180f` convention); objects serialize to JSON.
        /// `__`-prefixed framing keys are dropped.
        val strings: Map<String, String>
            get() {
                val out = LinkedHashMap<String, String>()
                for ((key, value) in named) {
                    if (key.startsWith("__")) continue
                    flatten(value)?.let { out[key] = it }
                }
                return out
            }

        /// Raw underlying value (no coercion). Lets handlers distinguish
        /// "present but unparseable" from "absent". A URL-form literal `null`
        /// arrives as the `NSNull` sentinel (present-null), like Swift.
        fun raw(key: String): Any? = named[key]

        fun string(key: String): String? = when (val v = named[key]) {
            is String -> v
            is Boolean -> if (v) "true" else "false"
            is Number -> numberString(v)
            // A comma-list value parses to an array; rejoin it so callers reading
            // a single string (legacy URL handlers) still see "a,b,c".
            is List<*> -> v.mapNotNull { flatten(it) }.joinToString(",")
            else -> null
        }

        fun string(key: String, default: String): String = string(key) ?: default

        fun int(key: String): Int? = when (val v = named[key]) {
            is Int -> v
            is Number -> v.toInt()
            is String -> v.toIntOrNull()
            else -> null
        }

        fun double(key: String): Double? = when (val v = named[key]) {
            is Double -> v
            is Number -> v.toDouble()
            is String -> v.toDoubleOrNull()
            else -> null
        }

        fun bool(key: String, default: Boolean = false): Boolean = when (val v = named[key]) {
            is Boolean -> v
            is Number -> v.toDouble() != 0.0
            is String -> {
                val l = v.lowercase()
                l == "true" || l == "1" || l == "yes" || l == "on"
            }
            else -> default
        }

        /// Returns the value as an array. Structured callers pass real
        /// arrays (`["a","b","c"]`) - they flow through unchanged. URL-only
        /// callers send comma-separated strings (`tags=a,b,c`) - they're
        /// split and trimmed on read. Returns `null` only when the key is
        /// absent; an empty string yields `[]`.
        fun array(key: String): List<Any?>? = when (val v = named[key]) {
            is List<*> -> v
            is String ->
                if (v.isEmpty()) emptyList()
                else v.split(",").map { it.trim() }
            else -> null
        }

        /// Convenience for the common `List<String>` case.
        fun stringArray(key: String): List<String>? =
            array(key)?.mapNotNull { it as? String ?: (it as? Number)?.let(::numberString) }

        /// Convenience for the common `List<Map<String, Any?>>` case - a list of
        /// JSON objects. Structured callers send `[{...}, {...}]` directly;
        /// URL callers can send a JSON-encoded string of the same shape.
        fun objectArray(key: String): List<Map<String, Any?>>? {
            val v = named[key]
            if (v is List<*> && v.all { it is Map<*, *> }) return v.map { it as Map<String, Any?> }
            if (v is String) {
                val parsed = json(v).foundationValue
                if (parsed is List<*> && parsed.isNotEmpty() && parsed.all { it is Map<*, *> })
                    return parsed.map { it as Map<String, Any?> }
            }
            return null
        }

        /// Nested object. Structured callers pass real maps; URL-only
        /// callers can pass a JSON-encoded string.
        fun `object`(key: String): Map<String, Any?>? {
            val v = named[key]
            if (v is Map<*, *> && v.keys.all { it is String }) return v as Map<String, Any?>
            if (v is String) {
                (json(v).foundationValue as? Map<*, *>)?.let { m ->
                    if (m.keys.all { it is String }) return m as Map<String, Any?>
                }
            }
            return null
        }

        /// A `URI` value, intended for file references uploaded through
        /// `window.virtual.storage` (runtime.js replaces a web `File`/`Blob` with
        /// its local CDN URL). Returns `null` if the value isn't present or
        /// doesn't parse as a URL.
        fun file(key: String): URI? {
            val s = string(key) ?: return null
            if (s.isEmpty()) return null                     // URL(string: "") is nil on Swift
            return try { URI(s) } catch (_: Exception) { null }
        }

        internal companion object {

            /// The URLComponents.queryItems twin: split the RAW query, one
            /// percent-decode pass per name/value, then the smart passes exactly
            /// like the Swift init(url:) — framing keys (`__rid`, `__stop`) keep
            /// their literal string form; every other value is smart-parsed at
            /// ingestion so the legacy string entry points arrive typed.
            fun parseQuery(url: URI): Map<String, Any?> {
                val dict = LinkedHashMap<String, Any?>()
                val rawQuery = url.rawQuery ?: return dict
                for (pair in rawQuery.split("&")) {
                    if (pair.isEmpty()) continue
                    val eq = pair.indexOf('=')
                    val name = percentDecode(if (eq >= 0) pair.substring(0, eq) else pair)
                    val value = percentDecode(if (eq >= 0) pair.substring(eq + 1) else "")
                    dict[name] = if (name.startsWith("__")) urlDecode(value) else smartValue(value)
                }
                return dict
            }

            fun flatten(value: Any?): String? = when (value) {
                is String -> value
                is Boolean -> if (value) "true" else "false"
                is Number -> numberString(value)
                is List<*> -> value.mapNotNull { flatten(it) }.joinToString(",")
                NSNull, null -> null
                else -> JSON.from(value).toString()          // objects serialize to JSON text
            }

            /// NSNumber.stringValue twin: a whole Double renders integral ("2", not "2.0").
            fun numberString(n: Number): String = when (n) {
                is Double -> if (n == floor(n) && !n.isInfinite() && abs(n) < 9.007199254740992E15)
                    n.toLong().toString() else n.toString()
                is Float -> numberString(n.toDouble())
                else -> n.toString()
            }

            // MARK: - Smart URL decode

            /// One conservative decode pass for URL query values:
            ///   1. `+` -> space (form-encoding convention).
            ///   2. percent-decoding, but only if the result actually changes -
            ///      so plain text with stray `%` (`"50% off"`) is preserved.
            /// Structured (dict) callers bypass this entirely.
            fun urlDecode(raw: String): String {
                val spaced = raw.replace("+", " ")
                val decoded = percentDecode(spaced)
                return if (decoded != spaced) decoded else spaced
            }

            /// `removingPercentEncoding` twin: %XX bytes → UTF-8. Conservative — any
            /// malformed escape returns the input unchanged (Swift maps its nil back
            /// to the undecoded text at every call site here).
            fun percentDecode(s: String): String {
                if (!s.contains('%')) return s
                val bytes = ByteArrayOutputStream(s.length)
                var i = 0
                while (i < s.length) {
                    val c = s[i]
                    if (c == '%') {
                        if (i + 2 >= s.length) return s
                        val hi = Character.digit(s[i + 1], 16)
                        val lo = Character.digit(s[i + 2], 16)
                        if (hi < 0 || lo < 0) return s
                        bytes.write((hi shl 4) or lo)
                        i += 3
                    } else {
                        bytes.write(c.toString().toByteArray(Charsets.UTF_8))
                        i += 1
                    }
                }
                return try { String(bytes.toByteArray(), Charsets.UTF_8) } catch (_: Exception) { s }
            }

            // MARK: - Smart value parse (URL query -> typed payload)

            /// URL-decode, then promote to a typed value:
            ///   - clearly-JSON text (number, bool, null, `[...]`, `{...}`, quoted string)
            ///     is parsed: `?test=123` -> 123, `?on=true` -> true.
            ///   - a comma-list becomes an array, each element smart-parsed:
            ///     `?types=one,two` -> ["one","two"], `?ids=1,2` -> [1,2].
            ///   - anything else stays a string: `?name=Ada` -> "Ada"; leading-zero
            ///     ids ("01234", rejected by strict JSON) stay strings.
            fun smartValue(raw: String): Any {
                val decoded = urlDecode(raw)
                jsonParsed(decoded)?.let { return it }
                if (decoded.contains(",")) {
                    return decoded.split(",").map { part ->
                        val trimmed = part.trim()
                        jsonParsed(trimmed) ?: trimmed
                    }
                }
                return decoded
            }

            /// The `JSONSerialization(.fragmentsAllowed)` gate: only attempt a parse when
            /// the text opens like JSON. A literal `null` maps to the `NSNull` sentinel
            /// (Swift's NSNull — present-null); a failed parse returns Kotlin null
            /// ("not JSON", the caller falls through to the string).
            fun jsonParsed(s: String): Any? {
                val t = s.trim()
                val first = t.firstOrNull() ?: return null
                if (!"-0123456789tfn[{\"".contains(first)) return null
                if (t == "null") return NSNull
                val parsed = json(t)                          // Json.kt reader (invalid -> the null case)
                if (parsed == JSON.from(null)) return null    // parse failure (literal null handled above)
                return parsed.foundationValue
            }
        }
    }
}
