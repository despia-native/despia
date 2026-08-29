//
//  Handoff.kt — the Kotlin twin of Engine/iOS/Handoff.swift and the web kernel's handoff.ts:
//  the SHARED PURE CORE behind Core/Handoff (F17.8).
//
//  WHY A CORE FOR AN APPLE CAPABILITY. Handoff's real constraint is a SIZE LIMIT nobody
//  documents precisely: an oversized userInfo does not error, the activity simply stops
//  appearing on the other device. A limit that only one platform enforces, or that two measure
//  differently, is not a limit. The Android facet advertises nothing, but it still VALIDATES
//  against the same grammar and the same ceiling, so a payload a developer builds on Android is
//  one the iPhone will actually advertise.
//
//  THE CANONICAL FORM IS EXACT ON PURPOSE. Three languages must agree on the byte count to the
//  byte, so: keys are ASCII and sorted (three languages sort ASCII identically; Swift's default
//  String ordering is Unicode-canonical and would NOT match), numbers are integers only (a
//  binary float has no single decimal spelling), and the escapes are written out rather than
//  delegated to each platform's JSON encoder.
//
//  Pure JVM — no Android imports. Pinned by OpenSource/Conformance/handoff/activity.json.
//
package despia.engine

object Handoff {

    /** The practical ceiling on an NSUserActivity's userInfo before the OS quietly stops
     *  advertising it. Apple documents no number; this is the size below which continuity is
     *  reliable, and it is enforced on every platform. */
    const val MAX_PAYLOAD_BYTES = 3072

    const val MAX_TITLE_CHARS = 256

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_activity" to "That is not a reverse-DNS activity type.",
        "invalid_url" to "A handoff fallback is an http or https URL.",
        "invalid_payload" to "A handoff payload holds strings, whole numbers and booleans.",
        "payload_too_large" to
            "That payload is too large to advertise; hand over an identifier instead.",
    )

    class RefusalError(val code: String, val detail: String?) : Exception(code)

    private fun <T> refuse(code: String, detail: String? = null): Result<T> =
        Result.failure(RefusalError(code, detail))

    fun code(error: Throwable): String = (error as? RefusalError)?.code ?: "invalid_payload"

    fun detail(error: Throwable): String {
        val d = (error as? RefusalError)?.detail
        if (!d.isNullOrEmpty()) return d
        return MESSAGES[code(error)] ?: code(error)
    }

    data class Activity(
        val activity: String,
        val title: String,
        val url: String,
        val payload: Map<String, Any?>,
        /** the canonical serialisation's UTF-8 length, which is what the ceiling measures */
        val payloadBytes: Int,
    )

    /**
     * An activity type is reverse-DNS with at least two labels. Apple additionally requires it
     * to appear in NSUserActivityTypes, and one that is not listed is advertised to nobody,
     * silently; the module's manifest carries a config token for that list and this function
     * only guards the grammar.
     */
    fun normalizeActivityType(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return refuse("invalid_activity", "an activity type is required")
        if (text.length > 128) {
            return refuse("invalid_activity", "an activity type is at most 128 characters")
        }
        val labels = text.split(".")
        if (labels.size < 2) {
            return refuse("invalid_activity", "an activity type is reverse-DNS, e.g. com.example.viewing")
        }
        for (label in labels) {
            if (label.isEmpty()) return refuse("invalid_activity", "an empty label")
            for (c in label) {
                val ok = (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || c == '-'
                if (!ok) return refuse("invalid_activity", text)
            }
        }
        return Result.success(text)
    }

    /** The fallback a device without the app opens. http(s) only: a custom scheme on a Mac that
     *  never installed the app opens nothing, which is the same as having no fallback. */
    fun normalizeUrl(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return Result.success("")
        val lower = text.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return refuse("invalid_url", "a handoff fallback is an http or https URL")
        }
        if (text.any { it.isWhitespace() }) return refuse("invalid_url", text)
        return Result.success(text)
    }

    private fun canonicalString(value: String): String {
        val out = StringBuilder("\"")
        for (c in value) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else -> {
                    if (c.code < 0x20 || c.code == 0x7f) {
                        out.append("\\u").append(String.format("%04x", c.code))
                    } else {
                        out.append(c)
                    }
                }
            }
        }
        return out.append("\"").toString()
    }

    private fun isAsciiKey(key: String): Boolean {
        if (key.isEmpty()) return false
        return key.all {
            (it in 'a'..'z') || (it in 'A'..'Z') || (it in '0'..'9') ||
                it == '_' || it == '.' || it == '-'
        }
    }

    /**
     * Serialise a payload the same way in every language, so the byte count is the same number.
     * Refuses what cannot be spelled identically three times: a non-integer number, a non-ASCII
     * key, and anything nested more deeply than one array of scalars.
     */
    fun canonicalJson(value: Any?, depth: Int = 0): Result<String> {
        if (value == null) return Result.success("null")
        if (value is Boolean) return Result.success(if (value) "true" else "false")
        if (value is Number) {
            val d = value.toDouble()
            if (!d.isFinite() || d != Math.floor(d)) {
                return refuse(
                    "invalid_payload",
                    "a handoff payload carries whole numbers; quote anything else",
                )
            }
            return Result.success(d.toLong().toString())
        }
        if (value is String) return Result.success(canonicalString(value))
        if (value is List<*>) {
            // An array is a VALUE of the payload object, so exactly depth 1. A bare array
            // payload (depth 0) is not a payload, and an array inside an array is level two.
            if (depth != 1) {
                return refuse("invalid_payload", "a handoff payload nests one level, not two")
            }
            val parts = ArrayList<String>(value.size)
            for (entry in value) {
                parts.add(canonicalJson(entry, depth + 1).getOrElse { e -> return Result.failure(e) })
            }
            return Result.success("[" + parts.joinToString(",") + "]")
        }
        if (value is Map<*, *>) {
            // The payload itself is the ONLY object: a handoff payload is a pointer to state,
            // not the state, and a nested graph is what pushes it past the advertisable size.
            if (depth != 0) {
                return refuse("invalid_payload", "a handoff payload nests one level, not two")
            }
            val keys = ArrayList<String>(value.size)
            for (k in value.keys) {
                val key = k?.toString() ?: ""
                if (!isAsciiKey(key)) {
                    return refuse(
                        "invalid_payload",
                        "$key: a payload key is ASCII letters, digits, . _ or -",
                    )
                }
                keys.add(key)
            }
            keys.sort()
            val parts = ArrayList<String>(keys.size)
            for (key in keys) {
                val entry = canonicalJson(value[key], depth + 1)
                    .getOrElse { e -> return Result.failure(e) }
                parts.add(canonicalString(key) + ":" + entry)
            }
            return Result.success("{" + parts.joinToString(",") + "}")
        }
        return refuse("invalid_payload", "a handoff payload holds strings, whole numbers and booleans")
    }

    /** UTF-8 byte length, counted by hand so no platform's encoder can disagree. */
    fun utf8ByteLength(text: String): Int {
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val code = text.codePointAt(i)
            bytes += when {
                code < 0x80 -> 1
                code < 0x800 -> 2
                code < 0x10000 -> 3
                else -> 4
            }
            i += Character.charCount(code)
        }
        return bytes
    }

    /** What the ceiling measures: the canonical serialisation's UTF-8 length. */
    fun payloadBytes(payload: Any?): Result<Int> {
        val canonical = canonicalJson(payload ?: emptyMap<String, Any?>())
            .getOrElse { e -> return Result.failure(e) }
        return Result.success(utf8ByteLength(canonical))
    }

    /**
     * Validate an activity before it is advertised. THE SIZE CHECK IS THE POINT: an oversized
     * userInfo does not error on Apple's side, the activity simply stops appearing on the other
     * device and the developer has nothing to debug.
     */
    @Suppress("UNCHECKED_CAST")
    fun normalize(raw: Map<String, Any?>): Result<Activity> {
        val activity = normalizeActivityType(raw["activity"])
            .getOrElse { e -> return Result.failure(e) }
        val url = normalizeUrl(raw["url"]).getOrElse { e -> return Result.failure(e) }

        val rawPayload = raw["payload"]
        if (rawPayload != null && rawPayload !is Map<*, *>) {
            return refuse("invalid_payload", "a payload is an object")
        }
        val payload = (rawPayload as? Map<String, Any?>) ?: emptyMap()

        val bytes = payloadBytes(payload).getOrElse { e -> return Result.failure(e) }
        if (bytes > MAX_PAYLOAD_BYTES) {
            return refuse(
                "payload_too_large",
                "$bytes bytes; the ceiling is $MAX_PAYLOAD_BYTES. " +
                    "Hand over an identifier and fetch the rest.",
            )
        }

        val title = (raw["title"]?.toString() ?: "").trim().take(MAX_TITLE_CHARS)
        return Result.success(Activity(activity, title, url, payload, bytes))
    }

    /** What arrives on the receiving device, normalised into the same shape the sender
     *  advertised so an app writes one handler rather than one per platform. */
    @Suppress("UNCHECKED_CAST")
    fun parseContinuation(raw: Map<String, Any?>): Result<Activity> {
        val activity = normalizeActivityType(raw["activity"])
            .getOrElse { e -> return Result.failure(e) }
        // A malformed incoming URL is DROPPED rather than refused: the continuation still
        // carries a usable activity and payload, and losing the whole handoff over a bad
        // fallback would be a worse outcome than losing the fallback.
        val url = normalizeUrl(raw["url"]).getOrDefault("")
        val payload = (raw["payload"] as? Map<String, Any?>) ?: emptyMap()
        val bytes = payloadBytes(payload).getOrDefault(0)
        val title = (raw["title"]?.toString() ?: "").trim().take(MAX_TITLE_CHARS)
        return Result.success(Activity(activity, title, url, payload, bytes))
    }
}
