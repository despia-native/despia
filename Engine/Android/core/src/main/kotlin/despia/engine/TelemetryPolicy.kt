//
//  TelemetryPolicy.kt - the shared telemetry core (:core, pure JVM): the SCRUBBER and the QUEUE
//  POLICY. The law is the corpus: OpenSource/Conformance/telemetry/{scrub,queue}.json
//  (parity/F10-telemetry.md). The twin of Swift TelemetryPolicy and the web @despia-native/kernel
//  scrubText / TelemetryQueue.
//
//  Everything platform-shaped lives OUTSIDE this file - crash handlers, the ANR watchdog, the
//  on-disk queue, the transports. What is here is the half that decides WHAT LEAVES THE DEVICE,
//  which is exactly the half that must not drift between renderers: a redaction rule that fires on
//  iOS and not on Android is a privacy incident with a platform column.
//
//  This file records nothing and sends nothing. Core/Telemetry is a SINK ADAPTER over the kernel
//  error ledger (dsx.errors, error-system.md); it never becomes a second error system.
//
package despia.engine

object TelemetryScrub {

    /** The placeholder each rule leaves behind. Pinned by the corpus - a sink's grouping keys are
     *  built from scrubbed text, so changing one re-groups every historical issue. */
    val PLACEHOLDERS: Map<String, String> = linkedMapOf(
        "email" to "[email]",
        "bearer" to "Bearer [token]",
        "jwt" to "[jwt]",
        "phone" to "[phone]",
        "card" to "[card]",
        "home" to "[user]",
        "key" to "[redacted]",
    )

    /** One ordered redaction rule. `check` (card rules only) rejects a match the regex shape alone
     *  cannot judge, so a Luhn-failing 16-digit order number stays readable. */
    private class Rule(val id: String, val pattern: Regex, val replacement: String,
                       val check: ((String) -> Boolean)? = null)

    /**
     * ORDER IS CONTRACT (corpus `order`):
     *   bearer before jwt - an Authorization header collapses to ONE placeholder rather than
     *                       `Bearer [jwt]`, which reads like the header survived;
     *   card before phone - a card number is never reported as a phone number;
     *   home before phone - a path is redacted as a path.
     *
     * The `bearer` prefix is spelled as explicit character classes rather than a case-insensitive
     * flag: the three regex engines disagree about inline modifiers and agree about character
     * classes, and one scrubber that behaves differently per platform is worse than none.
     */
    private val RULES: List<Rule> = listOf(
        Rule("bearer", Regex("[Bb][Ee][Aa][Rr][Ee][Rr] [A-Za-z0-9._~+/=-]{8,}"), PLACEHOLDERS.getValue("bearer")),
        Rule("jwt", Regex("eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}(\\.[A-Za-z0-9_-]+)?"), PLACEHOLDERS.getValue("jwt")),
        Rule("email", Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), PLACEHOLDERS.getValue("email")),
        Rule("homeUnix", Regex("/Users/[^/\\s\"']+"), "/Users/" + PLACEHOLDERS.getValue("home")),
        Rule("homeLinux", Regex("/home/[^/\\s\"']+"), "/home/" + PLACEHOLDERS.getValue("home")),
        Rule("homeWindows", Regex("Users\\\\[^\\\\/\\s\"']+"), "Users\\" + PLACEHOLDERS.getValue("home")),
        Rule("cardAmex", Regex("[0-9]{4}[ -][0-9]{6}[ -][0-9]{5}"), PLACEHOLDERS.getValue("card"), ::cardShaped),
        Rule("cardGrouped", Regex("[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{1,7}"), PLACEHOLDERS.getValue("card"), ::cardShaped),
        // Greedy on purpose: a maximal digit run longer than 19 fails cardShaped and stays
        // readable, which is how a 23-digit reference number survives without a lookbehind
        // (three engines, one behavior).
        Rule("cardPlain", Regex("[0-9]{14,}"), PLACEHOLDERS.getValue("card"), ::cardShaped),
        Rule("phoneInternational", Regex("\\+[0-9][0-9 ().-]{6,18}[0-9]"), PLACEHOLDERS.getValue("phone")),
        Rule("phoneGrouped", Regex("\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4}"), PLACEHOLDERS.getValue("phone")),
    )

    /** The rule ids in application order - the corpus asserts this list, so a rule cannot be
     *  reordered on one renderer only. */
    val ORDER: List<String> = RULES.map { it.id }

    /**
     * Keys whose VALUE is dropped whole, whatever it looks like.
     *
     * Matching is on the normalized key (lowercased, non-alphanumerics removed) and is EXACT,
     * never a substring: `token` redacts, `tokenCount` does not, because a scrubber that eats
     * metric names gets switched off. `email` and `phone` are deliberately absent - their values
     * are still scrubbed by the text pass, and `identify` passes its explicit fields around the
     * scrubber entirely, which is what "opt-in per field" means.
     */
    private val SENSITIVE_KEYS: Set<String> = setOf(
        "password", "passwd", "secret", "token", "accesstoken", "refreshtoken", "idtoken", "apikey",
        "authorization", "cookie", "setcookie", "sessionid", "ssn", "creditcard", "cardnumber",
        "cvv", "cvc", "pin", "privatekey", "clientsecret",
    )

    /** The Luhn check every card rule gates on. Without it a 16-digit order number reads as a card
     *  and the developer loses the one field that would have identified the order. */
    fun luhn(digits: String): Boolean {
        if (digits.isEmpty()) return false
        var sum = 0
        var alternate = false
        for (index in digits.indices.reversed()) {
            var value = digits[index] - '0'
            if (alternate) {
                value *= 2
                if (value > 9) value -= 9
            }
            sum += value
            alternate = !alternate
        }
        return sum % 10 == 0
    }

    private fun cardShaped(match: String): Boolean {
        val digits = match.filter { it in '0'..'9' }
        return digits.length in 14..19 && luhn(digits)
    }

    private fun normalizeKey(key: String): String =
        key.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }

    /** Is this a key whose value never leaves the device? */
    fun isSensitiveKey(key: String): Boolean = normalizeKey(key) in SENSITIVE_KEYS

    /** Redact one string. Applied at ENQUEUE, never at send - a crash during flush must not be
     *  able to leak an unredacted buffer, so the buffer never holds one. */
    fun text(input: String): String {
        var out = input
        for (rule in RULES) {
            val check = rule.check
            out = rule.pattern.replace(out) { match ->
                val hit = match.value
                if (check != null && !check(hit)) hit else rule.replacement
            }
        }
        return out
    }

    /** Redact one key/value pair: a sensitive key drops the value whole, everything else is
     *  scrubbed as text. */
    fun value(key: String, value: String): String =
        if (isSensitiveKey(key)) PLACEHOLDERS.getValue("key") else text(value)

    /** The ARG SHAPE of a failed dsx.module call: keys and value TYPES, never values. What is
     *  diagnostic about a failed call is which fields were present, and that is exactly the part
     *  that carries no secrets. */
    fun argShape(args: Map<String, Any?>?): Map<String, String> {
        if (args == null) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (key in args.keys.sorted()) {
            out[key] = when (val v = args[key]) {
                null -> "null"
                is List<*>, is Array<*> -> "array"
                is Boolean -> "boolean"
                is Number -> "number"
                is String -> "string"
                else -> "object"
            }
        }
        return out
    }
}

object TelemetryQueuePolicy {

    private val HEX_RUN = Regex("0[xX][0-9a-fA-F]+")
    private val DIGIT_RUN = Regex("[0-9]+")
    private val WHITESPACE_RUN = Regex("\\s+")

    /** Collapse the varying parts of a message so a crash loop folds to one fingerprint:
     *  addresses become `<addr>`, digit runs become `#`, whitespace collapses, tail capped. */
    fun collapseMessage(message: String?): String {
        if (message.isNullOrEmpty()) return ""
        var folded = HEX_RUN.replace(message) { "<addr>" }
        folded = DIGIT_RUN.replace(folded) { "#" }
        folded = WHITESPACE_RUN.replace(folded) { " " }.trim()
        return if (folded.length > 200) folded.substring(0, 200) else folded
    }

    /** The dedupe/grouping key: source, code and the collapsed message. Two crashes at different
     *  addresses are ONE issue, which is the difference between a count and ten thousand events. */
    fun fingerprint(source: String, code: String, message: String? = null): String =
        source + "|" + code + "|" + collapseMessage(message)

    /** FNV-1a 32-bit over UTF-8 - the one hash all three renderers compute identically. */
    fun fnv1a32(input: String): Long {
        var hash = 0x811c9dc5.toInt()
        for (byte in input.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (byte.toInt() and 0xff)
            hash *= 0x01000193
        }
        return hash.toLong() and 0xffffffffL
    }

    /** Deterministic sampling: a pure function of the fingerprint, not a random draw, so one
     *  device's sample decision is every device's and a corpus can pin it. */
    fun sampled(fingerprint: String, rate: Double): Boolean {
        if (rate <= 0.0) return false
        if (rate >= 1.0) return true
        return (fnv1a32(fingerprint) % 10000L) < Math.round(rate * 10000.0)
    }

    /** Exponential backoff, capped at five minutes. No jitter: a corpus cannot pin a random
     *  number, and the platform half is free to add jitter where it schedules the retry. */
    fun backoffMs(attempt: Int): Long {
        if (attempt <= 0) return 0L
        var delay = 1000L
        var step = 1
        while (step < attempt && delay < 300000L) {
            delay *= 2L
            step += 1
        }
        return if (delay > 300000L) 300000L else delay
    }
}

/** What [TelemetryQueue.offer] decided. `EVICTED` means the event was accepted AND the oldest one
 *  fell out. */
enum class TelemetryOfferOutcome(val wire: String) {
    ACCEPTED("accepted"), DEDUPED("deduped"), EVICTED("evicted")
}

data class TelemetryOfferResult(
    val outcome: TelemetryOfferOutcome,
    val size: Int,
    val dropped: Int,
    val count: Int,
)

/**
 * The bounded, de-duplicating event ring - pure, so the corpus judges it on every renderer.
 *
 * The platform half persists it to disk and drives the flush timer; nothing here does IO. A repeat
 * of a live fingerprint inside the window increments a COUNT and slides the window, so a crash
 * loop reports "this happened 4,182 times" instead of filling the queue with itself. Overflow
 * drops the OLDEST and counts the drop, because the newest crash is the one being debugged and a
 * silent drop is a lie to the sink.
 */
class TelemetryQueue(val capacity: Int, val windowMs: Long, val maxBatch: Int) {

    private class Item(val fingerprint: String, var at: Long, var count: Int)

    private val items = ArrayList<Item>()
    private var droppedCount = 0

    val size: Int get() = items.size

    /** Events lost to the bound, ever. Reported to the sink so it sees its own blind spot. */
    val dropped: Int get() = droppedCount

    fun offer(fingerprint: String, at: Long): TelemetryOfferResult {
        for (item in items) {
            if (item.fingerprint == fingerprint && at - item.at < windowMs) {
                item.count += 1
                item.at = at
                return TelemetryOfferResult(TelemetryOfferOutcome.DEDUPED, items.size, droppedCount, item.count)
            }
        }
        items.add(Item(fingerprint, at, 1))
        var outcome = TelemetryOfferOutcome.ACCEPTED
        if (items.size > capacity) {
            items.removeAt(0)
            droppedCount += 1
            outcome = TelemetryOfferOutcome.EVICTED
        }
        return TelemetryOfferResult(outcome, items.size, droppedCount, 1)
    }

    /** The next batch's fingerprints, oldest first, capped at [maxBatch]. */
    fun batch(): List<String> = items.take(maxBatch).map { it.fingerprint }

    /** How many times a live fingerprint has been seen, or 0 when it is not queued. */
    fun countOf(fingerprint: String): Int = items.firstOrNull { it.fingerprint == fingerprint }?.count ?: 0

    /** Drop the first [n] events - called after the sink accepted them. Never underflows. */
    fun ack(n: Int): Int {
        val take = if (n > items.size) items.size else if (n < 0) 0 else n
        repeat(take) { items.removeAt(0) }
        return items.size
    }

    /** Revoked consent drops everything pending, and the drop is NOT counted: those events were
     *  never the sink's to know about. */
    fun clear() {
        items.clear()
    }
}
