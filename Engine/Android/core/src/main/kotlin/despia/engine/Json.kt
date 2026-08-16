//
//  Json.kt
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  The JSON value packages hand back to the web. Build it with the fluent
//  JSON.obj()/.arr()/.put()/.add() chain (identical on Swift, Kotlin and Java),
//  or with the JSON(mapOf(...)) / JSON(listOf(...)) literal when you'd rather
//  use native map/list syntax. Pass null for null, nest a JSON, or hand over a
//  dsx.args(...) value as-is.
//

package despia.engine

import kotlin.math.floor

/**
 * The Kotlin twin of the Swift `JSON` enum (object / array / string / int /
 * double / bool / null). One immutable class whose private payload is the
 * normalized tree; every builder call returns a NEW value, exactly like the
 * Swift enum's value semantics — a `put`/`add` never mutates its receiver.
 */
class JSON : JSONConvertible {

    /** Normalized payload: `Map<String, JSON>` | `List<JSON>` | `String` | `Int`/`Long` | `Double` | `Boolean` | null. */
    private val value: Any?

    private constructor(normalized: Any?) {
        value = normalized
    }

    /**
     * Build a JSON object from a native map literal:
     * `JSON(mapOf("ok" to true, "count" to 2))`. Values are taken as-is - scalars,
     * nested `JSON`, lists, a `dsx.args(...)` result, or `null` (-> JSON null). The
     * dynamic, cross-runtime entry point (same `JSON(map)` shape on Swift/Java).
     */
    constructor(dictionary: Map<String, Any?>) {
        value = dictionary.mapValuesTo(LinkedHashMap()) { from(it.value) }
    }

    /** Build a JSON array from a native list literal: `JSON(listOf(1, 2, 3))`. */
    constructor(array: List<Any?>) {
        value = array.map { from(it) }
    }

    companion object {
        /** The shared JSON null (`.null` in Swift). */
        private val NULL = JSON(null)

        /** Wrap an already-normalized payload without re-converting it. */
        private fun wrap(normalized: Any?): JSON = JSON(normalized)

        /** An integral number: `Int` when it fits (the Kotlin `as? Int` register), `Long` above. */
        private fun integral(n: Long): JSON =
            wrap(if (n in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) n.toInt() else n)

        /** Whole, finite, and representable as a 64-bit integer (Swift: `d == d.rounded()`). */
        private fun isWhole(d: Double): Boolean =
            d == floor(d) && d >= Long.MIN_VALUE.toDouble() && d < Long.MAX_VALUE.toDouble()

        /** Start an empty object for the fluent builder: `JSON.obj().put(k, v)...`. */
        @JvmStatic
        fun obj(): JSON = wrap(LinkedHashMap<String, JSON>())

        /**
         * Build an array — `JSON.arr("track", "event")` for the method path in the call
         * envelope, or `JSON.arr()` empty for the fluent `.add(v)` builder. Each item becomes
         * JSON via [from] (scalars, nested JSON, lists, `null` -> null).
         */
        @JvmStatic
        fun arr(vararg items: Any?): JSON = wrap(items.map { from(it) })

        /**
         * Build JSON from a dynamic native value (`Map<String, Any?>`, `List<Any?>`,
         * or parser output). Non-JSON values fall back to their description
         * (`toString()`). Use it to forward native data through `resolve`/`event`.
         */
        @JvmStatic
        fun from(value: Any?): JSON = when (value) {
            null -> NULL
            is JSON -> value
            is String -> wrap(value)
            is Boolean -> wrap(value)
            is Int -> wrap(value)
            is Long -> integral(value)
            is Short, is Byte -> integral((value as Number).toLong())
            // NSNumber semantics: a whole double collapses to the int case.
            is Double -> if (isWhole(value)) integral(value.toLong()) else wrap(value)
            is Float -> from(value.toDouble())
            is List<*> -> wrap(value.map { from(it) })
            is Map<*, *> ->
                if (value.keys.all { it is String })
                    wrap(value.entries.associateTo(LinkedHashMap<String, JSON>()) { (it.key as String) to from(it.value) })
                else wrap(value.toString()) // non-String keys: not JSON — description fallback, like Swift's failed [String: Any] cast
            else -> wrap(value.toString())
        }
    }

    /**
     * Set a key on an object (chainable); starts an object if `this` isn't one.
     * The value is any native scalar, a nested `JSON`, a `dsx.args(...)` result,
     * or `null` (-> JSON null).
     */
    fun put(key: String, value: Any?): JSON {
        @Suppress("UNCHECKED_CAST")
        val d = if (this.value is Map<*, *>) LinkedHashMap(this.value as Map<String, JSON>)
                else LinkedHashMap<String, JSON>()
        d[key] = from(value)
        return wrap(d)
    }

    /** Append a value to an array (chainable); starts an array if `this` isn't one. */
    fun add(value: Any?): JSON {
        @Suppress("UNCHECKED_CAST")
        val a = if (this.value is List<*>) ArrayList(this.value as List<JSON>)
                else ArrayList<JSON>()
        a.add(from(value))
        return wrap(a)
    }

    /**
     * Native representation for the serializer / the bridge (Swift's `foundationValue`,
     * NSNull rendered as plain `null` — JVM collections hold nulls directly): nested
     * `Map<String, Any?>` / `List<Any?>` of `String` / `Int` / `Long` / `Double` /
     * `Boolean` / null.
     */
    val foundationValue: Any?
        get() = when (val v = value) {
            is Map<*, *> -> v.entries.associateTo(LinkedHashMap<String, Any?>()) {
                (it.key as String) to (it.value as JSON).foundationValue
            }
            is List<*> -> v.map { (it as JSON).foundationValue }
            else -> v
        }

    override val asJSON: JSON get() = this

    // JVM hygiene (not part of the Swift surface): structural value equality and a
    // compact JSON-text description for debugging/assertions.
    override fun equals(other: Any?): Boolean = other is JSON && other.value == value
    override fun hashCode(): Int = value?.hashCode() ?: 0
    override fun toString(): String = buildString { render(this@JSON, this) }

    private fun render(j: JSON, out: StringBuilder) {
        when (val v = j.value) {
            null -> out.append("null")
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, e) in v) {
                    if (!first) out.append(',')
                    first = false
                    renderString(k as String, out)
                    out.append(':')
                    render(e as JSON, out)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                var first = true
                for (e in v) {
                    if (!first) out.append(',')
                    first = false
                    render(e as JSON, out)
                }
                out.append(']')
            }
            is String -> renderString(v, out)
            else -> out.append(v.toString()) // Int, Long, Double, Boolean
        }
    }

    private fun renderString(s: String, out: StringBuilder) {
        out.append('"')
        for (c in s) when {
            c == '"' -> out.append("\\\"")
            c == '\\' -> out.append("\\\\")
            c == '\n' -> out.append("\\n")
            c == '\r' -> out.append("\\r")
            c == '\t' -> out.append("\\t")
            c < ' ' -> out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
            else -> out.append(c)
        }
        out.append('"')
    }
}

/**
 * Anything that can become JSON. `JSON` itself conforms; native scalars and lists
 * get the same `x.asJSON` spelling through the extension properties below (Kotlin
 * can't retroactively conform types, so extensions stand in for Swift's protocol
 * extensions — the builder still accepts natives directly, no manual wrapping).
 */
interface JSONConvertible {
    val asJSON: JSON
}

// Optionals carry through as JSON null - the nullable receivers fold Swift's
// `Optional: JSONConvertible` conformance into each extension, so
// `dsx.resolve(maybeValue)` and `JSON(mapOf("id" to maybeValue))` work without
// forcing the caller to coalesce.
val String?.asJSON: JSON get() = JSON.from(this)
val Int?.asJSON: JSON get() = JSON.from(this)
val Long?.asJSON: JSON get() = JSON.from(this)
val Double?.asJSON: JSON get() = JSON.from(this)
val Boolean?.asJSON: JSON get() = JSON.from(this)
val List<Any?>?.asJSON: JSON get() = JSON.from(this)
val JSON?.asJSON: JSON get() = this ?: JSON.from(null)

/**
 * `json("""{ "sku": "gold", "value": 9.99 }""")` — parse a STATIC JSON string into [JSON]. The
 * 1:1 cross-language register for static payloads: the same bytes everywhere, copy-pastes to a
 * `.json` file or curl. Invalid JSON → the null case. For DYNAMIC payloads use the `JSON.obj().put(…)`
 * builder, which inserts values as data — never string-interpolate into JSON text (injection risk).
 */
fun json(string: String): JSON = try {
    JSON.from(JSONParser(string).parse())
} catch (_: Exception) {
    JSON.from(null)
}

/**
 * Security-sensitive parsers may need the lexical number category retained: [JSON.from]
 * intentionally collapses `1.0` to integer 1 for ordinary runtime ergonomics. Content manifest
 * signatures require `1`, `1.0`, and `1e0` to stay distinguishable, so this internal seam exposes
 * the strict reader's native tree before JSON's NSNumber-style normalization.
 */
internal fun parseJSONFoundationPreservingNumbers(string: String): Any? = try {
    JSONParser(string).parse()
} catch (_: Exception) {
    null
}

/**
 * Minimal strict JSON reader — the pure-JVM stand-in for `JSONSerialization` with
 * `.allowFragments` (there is no org.json off-device): objects, arrays, strings with
 * escapes, numbers, `true`/`false`/`null`, top-level scalar fragments allowed. Any
 * syntax error throws; `json(...)` maps that to the null case.
 */
private class JSONParser(private val s: String) {
    private var i = 0
    private var depth = 0

    fun parse(): Any? {
        val v = readValue()
        skipWhitespace()
        require(i == s.length) { "trailing characters" }
        return v
    }

    private fun readValue(): Any? {
        require(++depth <= 512) { "nesting too deep" }
        skipWhitespace()
        val v = when (peek()) {
            '{' -> readObject()
            '[' -> readArray()
            '"' -> readString()
            't' -> readLiteral("true", true)
            'f' -> readLiteral("false", false)
            'n' -> readLiteral("null", null)
            else -> readNumber()
        }
        depth--
        return v
    }

    private fun readLiteral(text: String, value: Any?): Any? {
        require(s.startsWith(text, i)) { "invalid literal" }
        i += text.length
        return value
    }

    private fun readObject(): Map<String, Any?> {
        i++ // '{'
        val o = LinkedHashMap<String, Any?>()
        skipWhitespace()
        if (peek() == '}') { i++; return o }
        while (true) {
            skipWhitespace()
            require(peek() == '"') { "expected a key" }
            val key = readString()
            skipWhitespace()
            require(peek() == ':') { "expected ':'" }
            i++
            o[key] = readValue() // duplicate keys: last one wins
            skipWhitespace()
            when (peek()) {
                ',' -> i++
                '}' -> { i++; return o }
                else -> throw IllegalArgumentException("expected ',' or '}'")
            }
        }
    }

    private fun readArray(): List<Any?> {
        i++ // '['
        val a = ArrayList<Any?>()
        skipWhitespace()
        if (peek() == ']') { i++; return a }
        while (true) {
            a.add(readValue())
            skipWhitespace()
            when (peek()) {
                ',' -> i++
                ']' -> { i++; return a }
                else -> throw IllegalArgumentException("expected ',' or ']'")
            }
        }
    }

    private fun readString(): String {
        i++ // '"'
        val out = StringBuilder()
        while (true) {
            require(i < s.length) { "unterminated string" }
            when (val c = s[i++]) {
                '"' -> return out.toString()
                '\\' -> out.append(readEscape())
                else -> {
                    require(c >= ' ') { "unescaped control character" }
                    out.append(c)
                }
            }
        }
    }

    private fun readEscape(): Char {
        require(i < s.length) { "unterminated escape" }
        return when (s[i++]) {
            '"' -> '"'
            '\\' -> '\\'
            '/' -> '/'
            'b' -> '\b'
            'f' -> '\u000C' // form feed (Kotlin has no \f escape)
            'n' -> '\n'
            'r' -> '\r'
            't' -> '\t'
            'u' -> {
                require(i + 4 <= s.length) { "bad unicode escape" }
                val hex = s.substring(i, i + 4)
                require(hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) { "bad unicode escape" }
                i += 4
                hex.toInt(16).toChar() // surrogate pairs combine as consecutive UTF-16 units
            }
            else -> throw IllegalArgumentException("invalid escape")
        }
    }

    private fun readNumber(): Any {
        val start = i
        if (peek() == '-') i++
        require(i < s.length && s[i] in '0'..'9') { "invalid number" }
        if (s[i] == '0') i++ else while (i < s.length && s[i] in '0'..'9') i++ // no leading zeros
        var isDouble = false
        if (i < s.length && s[i] == '.') {
            isDouble = true; i++
            require(i < s.length && s[i] in '0'..'9') { "digits required after '.'" }
            while (i < s.length && s[i] in '0'..'9') i++
        }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            isDouble = true; i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            require(i < s.length && s[i] in '0'..'9') { "digits required in exponent" }
            while (i < s.length && s[i] in '0'..'9') i++
        }
        val text = s.substring(start, i)
        return if (isDouble) text.toDouble() else (text.toLongOrNull() ?: text.toDouble())
    }

    private fun peek(): Char {
        require(i < s.length) { "unexpected end of input" }
        return s[i]
    }

    private fun skipWhitespace() {
        while (i < s.length && s[i] in " \t\n\r") i++
    }
}
