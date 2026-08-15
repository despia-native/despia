// Despia MCP - the JSON codec the framing runs on.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This package has no third-party dependencies, and a JSON library would be the
// first one. It would also be the wrong first one: what this transport parses
// is untrusted input arriving from a co-resident process, so the properties
// that matter are the ones a general-purpose library gives away by default -
// a bounded nesting depth, no reflection, no type coercion, and no object graph
// larger than the bytes that produced it.
//
// The value vocabulary is deliberately the plain Kotlin one - `Map<String, Any?>`,
// `List<Any?>`, `String`, `Long`, `Double`, `Boolean`, `null` - because that is
// what `ServedRows.kt` already speaks. A second value type would mean a
// conversion at every seam, and conversions are where shapes drift.
//
// Not implemented, on purpose: comments, trailing commas, single quotes,
// unquoted keys, NaN and infinities. Every one of those is a place two parsers
// disagree, and disagreement between the sender's parser and ours is how a
// request means one thing to an approval prompt and another to a dispatcher.

package com.despia.mcp

/** Encoder and decoder for the strict JSON subset this transport accepts. */
public object Json {

    /**
     * The nesting cap. A recursive-descent parser without one turns
     * `[[[[[...]]]]]` into a stack overflow, which on a shared worker pool is a
     * denial of service rather than a parse error.
     */
    public const val MAXIMUM_DEPTH: Int = 64

    public class MalformedException(message: String) : Exception(message)

    // --- encoding --------------------------------------------------------

    public fun encode(value: Any?): String {
        val out = StringBuilder(128)
        write(value, out, 0)
        return out.toString()
    }

    private fun write(value: Any?, out: StringBuilder, depth: Int) {
        if (depth > MAXIMUM_DEPTH) throw MalformedException("value nests deeper than $MAXIMUM_DEPTH")
        when (value) {
            null -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is String -> writeString(value, out)
            is Int, is Long, is Short, is Byte -> out.append(value.toString())
            is Double -> writeDouble(value.toDouble(), out)
            is Float -> writeDouble(value.toDouble(), out)
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (!first) out.append(',')
                    first = false
                    writeString(key?.toString() ?: "null", out)
                    out.append(':')
                    write(item, out, depth + 1)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (item in value) {
                    if (!first) out.append(',')
                    first = false
                    write(item, out, depth + 1)
                }
                out.append(']')
            }
            else -> throw MalformedException("no JSON encoding for ${value::class.simpleName}")
        }
    }

    private fun writeDouble(value: Double, out: StringBuilder) {
        // NaN and the infinities have no JSON spelling. Emitting `null` for them
        // would be a silent lie about a number; refusing is the honest answer.
        if (value.isNaN() || value.isInfinite()) throw MalformedException("$value has no JSON form")
        if (value == Math.floor(value) && Math.abs(value) < 9.007199254740992E15) {
            out.append(value.toLong().toString())
        } else {
            out.append(value.toString())
        }
    }

    private fun writeString(value: String, out: StringBuilder) {
        out.append('"')
        for (ch in value) {
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch < ' ' -> out.append("\\u").append(String.format("%04x", ch.code))
                else -> out.append(ch)
            }
        }
        out.append('"')
    }

    // --- decoding --------------------------------------------------------

    public fun decode(text: String): Any? {
        val reader = Reader(text)
        reader.skipWhitespace()
        val value = reader.readValue(0)
        reader.skipWhitespace()
        if (!reader.atEnd()) throw MalformedException("trailing input at ${reader.index}")
        return value
    }

    /** The shape every JSON-RPC frame must have; anything else is malformed. */
    @Suppress("UNCHECKED_CAST")
    public fun decodeObject(text: String): Map<String, Any?> {
        val value = decode(text)
        if (value !is Map<*, *>) throw MalformedException("expected a JSON object")
        return value as Map<String, Any?>
    }

    private class Reader(val text: String) {
        var index: Int = 0

        fun atEnd(): Boolean = index >= text.length

        fun skipWhitespace() {
            while (index < text.length) {
                val ch = text[index]
                if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') index++ else break
            }
        }

        fun readValue(depth: Int): Any? {
            if (depth > MAXIMUM_DEPTH) throw MalformedException("input nests deeper than $MAXIMUM_DEPTH")
            if (atEnd()) throw MalformedException("input ended where a value was expected")
            return when (val ch = text[index]) {
                '{' -> readObject(depth)
                '[' -> readArray(depth)
                '"' -> readString()
                't' -> readLiteral("true", true)
                'f' -> readLiteral("false", false)
                'n' -> readLiteral("null", null)
                else -> if (ch == '-' || ch in '0'..'9') readNumber() else {
                    throw MalformedException("unexpected '$ch' at $index")
                }
            }
        }

        fun readObject(depth: Int): Map<String, Any?> {
            index++
            val out = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (!atEnd() && text[index] == '}') { index++; return out }
            while (true) {
                skipWhitespace()
                if (atEnd() || text[index] != '"') throw MalformedException("expected a key at $index")
                val key = readString()
                skipWhitespace()
                if (atEnd() || text[index] != ':') throw MalformedException("expected ':' at $index")
                index++
                skipWhitespace()
                // Last value wins for a duplicated key, and it is recorded once:
                // a parser that kept both would let a sender show one value to a
                // reader and another to a checker.
                out[key] = readValue(depth + 1)
                skipWhitespace()
                if (atEnd()) throw MalformedException("object was not closed")
                when (text[index]) {
                    ',' -> index++
                    '}' -> { index++; return out }
                    else -> throw MalformedException("expected ',' or '}' at $index")
                }
            }
        }

        fun readArray(depth: Int): List<Any?> {
            index++
            val out = ArrayList<Any?>()
            skipWhitespace()
            if (!atEnd() && text[index] == ']') { index++; return out }
            while (true) {
                skipWhitespace()
                out.add(readValue(depth + 1))
                skipWhitespace()
                if (atEnd()) throw MalformedException("array was not closed")
                when (text[index]) {
                    ',' -> index++
                    ']' -> { index++; return out }
                    else -> throw MalformedException("expected ',' or ']' at $index")
                }
            }
        }

        fun readString(): String {
            index++
            val out = StringBuilder()
            while (true) {
                if (atEnd()) throw MalformedException("string was not closed")
                when (val ch = text[index]) {
                    '"' -> { index++; return out.toString() }
                    '\\' -> {
                        index++
                        if (atEnd()) throw MalformedException("escape was not completed")
                        when (val escape = text[index]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (index + 4 >= text.length) throw MalformedException("truncated \\u escape")
                                val hex = text.substring(index + 1, index + 5)
                                val code = hex.toIntOrNull(16)
                                    ?: throw MalformedException("bad \\u escape '$hex'")
                                out.append(code.toChar())
                                index += 4
                            }
                            else -> throw MalformedException("unknown escape '\\$escape'")
                        }
                        index++
                    }
                    else -> {
                        // Raw control characters are illegal in a JSON string. A
                        // parser that accepted them would let a caller smuggle a
                        // newline into a value that later lands in a log line.
                        if (ch < ' ') throw MalformedException("raw control character in a string")
                        out.append(ch)
                        index++
                    }
                }
            }
        }

        fun readLiteral(literal: String, value: Any?): Any? {
            if (!text.startsWith(literal, index)) throw MalformedException("unexpected input at $index")
            index += literal.length
            return value
        }

        fun readNumber(): Any {
            val start = index
            if (!atEnd() && text[index] == '-') index++
            while (!atEnd() && text[index] in '0'..'9') index++
            var fractional = false
            if (!atEnd() && text[index] == '.') {
                fractional = true
                index++
                while (!atEnd() && text[index] in '0'..'9') index++
            }
            if (!atEnd() && (text[index] == 'e' || text[index] == 'E')) {
                fractional = true
                index++
                if (!atEnd() && (text[index] == '+' || text[index] == '-')) index++
                while (!atEnd() && text[index] in '0'..'9') index++
            }
            val raw = text.substring(start, index)
            if (raw.isEmpty() || raw == "-") throw MalformedException("malformed number at $start")
            // An integer stays an integer. Widening every number to Double would
            // silently round a 64-bit id, and ids are exactly what JSON-RPC puts
            // in this field.
            return if (fractional) {
                raw.toDoubleOrNull() ?: throw MalformedException("malformed number '$raw'")
            } else {
                raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: throw MalformedException("malformed number '$raw'")
            }
        }
    }
}
