// Json.kt - the binding's own JSON.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The C ABI speaks JSON, so this binding needs to read it. It ships its own for
// the same reason the C++ core does: a JSON library would need a pin, a NOTICE
// line, an SBOM component and a CVE watch, and what crosses this seam is one
// well-known document shape rather than arbitrary input from the world.
//
// Deliberately small: parse, render, and the typed accessors the host uses. It
// is bounded like the C++ one, because "the engine's own envelopes" is not the
// only thing that will ever reach it once a catalog is served over the network.

package com.despia.ai

sealed interface Json {
    data object Null : Json
    data class Bool(val value: Boolean) : Json
    data class Num(val value: Double) : Json
    data class Str(val value: String) : Json
    // The backing properties are named apart from the `items`/`fields`
    // accessors below so a caller reads one vocabulary whatever the shape is.
    data class Arr(val values: List<Json>) : Json
    data class Obj(val entries: Map<String, Json>) : Json

    companion object {
        const val MAX_DEPTH = 64

        fun parse(text: String): Json {
            val parser = Parser(text)
            val value = parser.value(0)
            parser.skipWhitespace()
            require(parser.atEnd) { "trailing content at offset ${parser.offset}" }
            return value
        }

        fun parseOrNull(text: String): Json? = runCatching { parse(text) }.getOrNull()
    }

    // --- accessors: a missing key reads as Null rather than throwing, because a
    // must-ignore consumer asks for fields it may not get, constantly.
    operator fun get(key: String): Json = (this as? Obj)?.entries?.get(key) ?: Null
    operator fun get(index: Int): Json = (this as? Arr)?.values?.getOrNull(index) ?: Null

    val items: List<Json> get() = (this as? Arr)?.values ?: emptyList()
    val fields: Map<String, Json> get() = (this as? Obj)?.entries ?: emptyMap()
    val isNull: Boolean get() = this is Null

    fun string(fallback: String = ""): String = (this as? Str)?.value ?: fallback
    fun stringOrNull(): String? = (this as? Str)?.value
    fun number(fallback: Double = 0.0): Double = (this as? Num)?.value ?: fallback
    fun int(fallback: Int = 0): Int = (this as? Num)?.value?.toInt() ?: fallback
    fun bool(fallback: Boolean = false): Boolean = (this as? Bool)?.value ?: fallback
    fun strings(): List<String> = items.mapNotNull { it.stringOrNull() }

    fun has(key: String): Boolean = (this as? Obj)?.entries?.containsKey(key) == true

    fun render(): String = when (this) {
        is Null -> "null"
        is Bool -> value.toString()
        is Num -> if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
        is Str -> escape(value)
        is Arr -> values.joinToString(",", "[", "]") { it.render() }
        // Keys are sorted so a rendered document is byte-stable: fixtures compare
        // payload sizes, and iteration order that varied between runs would make
        // that assertion flaky.
        is Obj -> entries.entries.sortedBy { it.key }
            .joinToString(",", "{", "}") { "${escape(it.key)}:${it.value.render()}" }
    }
}

private fun escape(text: String): String {
    val out = StringBuilder(text.length + 2).append('"')
    for (c in text) {
        when (c) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            else -> if (c < ' ') out.append("\\u%04x".format(c.code)) else out.append(c)
        }
    }
    return out.append('"').toString()
}

fun jsonOf(vararg pairs: Pair<String, Json>): Json = Json.Obj(pairs.toMap())
fun Json.Companion.of(value: String): Json = Json.Str(value)

private class Parser(private val text: String) {
    var offset = 0
        private set

    val atEnd: Boolean get() = offset >= text.length

    fun skipWhitespace() {
        while (offset < text.length && text[offset].isWhitespace()) offset++
    }

    fun value(depth: Int): Json {
        require(depth <= Json.MAX_DEPTH) { "nesting too deep at offset $offset" }
        skipWhitespace()
        require(!atEnd) { "unexpected end of input" }
        return when (text[offset]) {
            '{' -> obj(depth)
            '[' -> arr(depth)
            '"' -> Json.Str(str())
            't' -> literal("true", Json.Bool(true))
            'f' -> literal("false", Json.Bool(false))
            'n' -> literal("null", Json.Null)
            else -> num()
        }
    }

    private fun literal(word: String, value: Json): Json {
        require(text.startsWith(word, offset)) { "bad literal at offset $offset" }
        offset += word.length
        return value
    }

    private fun obj(depth: Int): Json {
        offset++   // '{'
        val fields = LinkedHashMap<String, Json>()
        skipWhitespace()
        if (!atEnd && text[offset] == '}') { offset++; return Json.Obj(fields) }
        while (true) {
            skipWhitespace()
            val key = str()
            skipWhitespace()
            require(!atEnd && text[offset] == ':') { "expected ':' at offset $offset" }
            offset++
            fields[key] = value(depth + 1)
            skipWhitespace()
            require(!atEnd) { "unterminated object" }
            when (text[offset]) {
                ',' -> offset++
                '}' -> { offset++; return Json.Obj(fields) }
                else -> throw IllegalArgumentException("expected ',' or '}' at offset $offset")
            }
        }
    }

    private fun arr(depth: Int): Json {
        offset++   // '['
        val items = ArrayList<Json>()
        skipWhitespace()
        if (!atEnd && text[offset] == ']') { offset++; return Json.Arr(items) }
        while (true) {
            items.add(value(depth + 1))
            skipWhitespace()
            require(!atEnd) { "unterminated array" }
            when (text[offset]) {
                ',' -> offset++
                ']' -> { offset++; return Json.Arr(items) }
                else -> throw IllegalArgumentException("expected ',' or ']' at offset $offset")
            }
        }
    }

    private fun str(): String {
        require(!atEnd && text[offset] == '"') { "expected a string at offset $offset" }
        offset++
        val out = StringBuilder()
        while (offset < text.length) {
            val c = text[offset++]
            if (c == '"') return out.toString()
            if (c != '\\') { out.append(c); continue }
            require(offset < text.length) { "truncated escape" }
            when (val e = text[offset++]) {
                '"' -> out.append('"')
                '\\' -> out.append('\\')
                '/' -> out.append('/')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'b' -> out.append('\b')
                'f' -> out.append('')
                'u' -> {
                    require(offset + 4 <= text.length) { "truncated \\u escape" }
                    out.append(text.substring(offset, offset + 4).toInt(16).toChar())
                    offset += 4
                }
                else -> throw IllegalArgumentException("unknown escape '\\$e'")
            }
        }
        throw IllegalArgumentException("unterminated string")
    }

    private fun num(): Json {
        val start = offset
        if (!atEnd && (text[offset] == '-' || text[offset] == '+')) offset++
        while (!atEnd && (text[offset].isDigit() || text[offset] in ".eE+-")) offset++
        val slice = text.substring(start, offset)
        return Json.Num(slice.toDoubleOrNull()
            ?: throw IllegalArgumentException("bad number ${slice.ifEmpty { "<empty>" }} at offset $start"))
    }
}
