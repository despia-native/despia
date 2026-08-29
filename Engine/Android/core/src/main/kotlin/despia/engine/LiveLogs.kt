//
//  LiveLogs.kt - the LIVE LOGS wire core (:core, pure JVM): the pure half of dev.stream
//  (proposals/live-logs.md). The law is the corpus:
//  OpenSource/Conformance/livelogs/{wire,report}.json. The twin of the web @despia-native/kernel
//  livelogs.ts and Swift Engine/iOS/LiveLogs.swift.
//
//  Everything platform-shaped lives OUTSIDE this file - the flush timer, dsx.fetch, the drawer
//  consent UI, the relay's storage. What is here is the half both ends of the wire must agree on:
//  how a ring entry becomes a wire row (scrubbed AT the fold - the telemetry law: a buffer never
//  holds an unredacted byte), the batch body, the ack fold that paces a device (viewers watching ->
//  send; nobody watching -> pause the wire, keep recording; pairing expired -> stop), the bounded
//  device queue (drop-oldest, counted), the relay's cursor ring (monotonic seq, bounded replay,
//  the gap told to a lagging reader - the realtime.ts contract over live rows), and the
//  `.dsxreport` seal (canonical bytes + sha256) with its verifier verdicts.
//
//  CANONICAL BYTES, exactly: JSON with keys sorted by code point, no whitespace, minimal escaping
//  (`"` `\` \b \f \n \r \t, other controls as \u00xx), unicode raw, integers only - a non-integer
//  number has no canonical form and is refused, so a hash can never depend on float formatting.
//
//  This file records nothing and sends nothing.
//
package despia.engine

import java.security.MessageDigest
import kotlin.math.floor

object LiveLogs {

    const val WIRE_VERSION = 1
    const val MESSAGE_CAP = 2000
    const val BATCH_MAX_ROWS = 200
    const val QUEUE_CAP = 1000
    const val IDLE_ACK_PAUSE = 30
    const val RING_CAP = 2000

    /** Scrub first, then cap: redaction must see the whole text, and a clipped token must never be
     *  a leaked one. */
    private fun foldMessage(text: String): String {
        val scrubbed = TelemetryScrub.text(text)
        if (scrubbed.length <= MESSAGE_CAP) return scrubbed
        // UTF-16 code units on every renderer; a cut stranding a high surrogate retreats one -
        // a lone surrogate has no UTF-8 encoding and must never reach the wire.
        val cut = if (scrubbed[MESSAGE_CAP - 1].isHighSurrogate()) MESSAGE_CAP - 1 else MESSAGE_CAP
        return scrubbed.substring(0, cut)
    }

    /** One wire row - the fold of a log-ring entry. */
    fun rowFromLog(scheme: String, level: String, message: String, at: Long): Map<String, Any?> =
        linkedMapOf(
            "kind" to "log", "scheme" to scheme, "level" to level,
            "message" to foldMessage(message), "at" to at,
        )

    /** The fold of an error-ledger entry. An absent message OMITS the key rather than sending
     *  null - the wire never carries a key whose value says nothing. */
    fun rowFromError(
        scheme: String,
        code: String,
        message: String?,
        recoverable: Boolean,
        origin: String,
        at: Long,
    ): Map<String, Any?> {
        val row = linkedMapOf<String, Any?>(
            "kind" to "error", "scheme" to scheme, "code" to code,
            "recoverable" to recoverable, "origin" to origin, "at" to at,
        )
        if (message != null) row["message"] = foldMessage(message)
        return row
    }

    /** The fold of a kernel-tail line - stamp and all, scrubbed like everything else. */
    fun rowFromKernel(line: String, at: Long): Map<String, Any?> =
        linkedMapOf("kind" to "kernel", "message" to foldMessage(line), "at" to at)

    /** The batch body a device POSTs: `n` is the device's monotonic batch index, the relay's
     *  idempotency key - a retried batch can never double rows. */
    fun batchBody(sid: String, n: Long, rows: List<Map<String, Any?>>): Map<String, Any?> =
        linkedMapOf("v" to WIRE_VERSION, "sid" to sid, "n" to n, "rows" to rows)

    private fun escape(text: String): String {
        val out = StringBuilder("\"")
        for (ch in text) when {
            ch == '"' -> out.append("\\\"")
            ch == '\\' -> out.append("\\\\")
            ch == '\b' -> out.append("\\b")
            ch == '\u000C' -> out.append("\\f") // form feed (Kotlin has no \f escape)
            ch == '\n' -> out.append("\\n")
            ch == '\r' -> out.append("\\r")
            ch == '\t' -> out.append("\\t")
            ch < ' ' -> out.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
            else -> out.append(ch)
        }
        return out.append('"').toString()
    }

    /** The corpus loader may hand a whole count over as Double; it canonicalizes as the integer it
     *  is, never with a decimal point. Anything non-integral is refused. */
    private const val SAFE_INTEGER_MAX = 9007199254740991L

    private fun integerText(number: Double): String {
        // SAFE integers only (|n| <= 2^53-1): past that the three runtimes disagree - double
        // text turns exponential, Long refuses, Int64 wraps - and one seal with three
        // spellings is exactly the verdict drift the verifier exists to prevent.
        val integral = number == floor(number) &&
            number >= -SAFE_INTEGER_MAX.toDouble() && number <= SAFE_INTEGER_MAX.toDouble()
        require(integral) { "livelogs canonical: safe integers only" }
        return number.toLong().toString()
    }

    private fun integerText(number: Long): String {
        require(number in -SAFE_INTEGER_MAX..SAFE_INTEGER_MAX) { "livelogs canonical: safe integers only" }
        return number.toString()
    }

    /** The one canonical serialization. Refuses what has no canonical form (a non-integer number,
     *  a non-JSON value) rather than guessing one - a hash must never depend on float formatting. */
    fun canonical(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> if (value) "true" else "false"
        is Int -> value.toString()
        is Long -> integerText(value)
        is Double -> integerText(value)
        is Float -> integerText(value.toDouble())
        is String -> escape(value)
        is List<*> -> value.joinToString(",", "[", "]") { canonical(it) }
        is Map<*, *> -> {
            val keys = value.keys.map {
                it as? String ?: throw IllegalArgumentException("livelogs canonical: unsupported value")
            }.sorted()
            @Suppress("UNCHECKED_CAST")
            val record = value as Map<String, Any?>
            keys.joinToString(",", "{", "}") { key -> escape(key) + ":" + canonical(record[key]) }
        }
        else -> throw IllegalArgumentException("livelogs canonical: unsupported value")
    }

    /** Lowercase hex of SHA-256 over UTF-8 bytes. MessageDigest is this platform's twin of the web
     *  core's self-contained block function; report.json pins both against the standard vectors. */
    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    data class Seal(val hash: String, val text: String)

    /** Seal a report body: the hash covers the canonical bytes WITHOUT the receipt, the sealed
     *  text is the canonical bytes WITH it. A body arriving with a receipt is re-sealed, never
     *  trusted. */
    fun reportSeal(body: Map<String, Any?>): Seal {
        val bare = LinkedHashMap<String, Any?>()
        for ((key, value) in body) if (key != "receipt") bare[key] = value
        val hash = sha256Hex(canonical(bare))
        val sealed = LinkedHashMap<String, Any?>(bare)
        sealed["receipt"] = linkedMapOf("alg" to "sha256", "hash" to hash)
        return Seal(hash, canonical(sealed))
    }

    private val HASH_SHAPE = Regex("^[0-9a-f]{64}$")

    data class Verdict(val verdict: String, val assertion: Boolean)

    /**
     * The verifier - the support macro as a function. `not_report` is the verdict the motivating
     * incident dies at (an AI-fabricated state dump is not the envelope); `modified` means the
     * envelope shape is right and the bytes are not; `genuine` means the hash verifies. `assertion`
     * reports whether an integrity attestation rides a GENUINE seal - verifying that attestation
     * against Apple/Google is the relay/platform's job, never this core's.
     */
    fun reportVerdict(text: String): Verdict {
        val refused = Verdict("not_report", false)
        @Suppress("UNCHECKED_CAST")
        val doc = json(text).foundationValue as? Map<String, Any?> ?: return refused
        if (doc["kind"] != "dsxreport") return refused
        // json() folds the whole number 1 to Int; any other v is not this envelope.
        if ((doc["v"] as? Int) != 1) return refused
        @Suppress("UNCHECKED_CAST")
        val receipt = doc["receipt"] as? Map<String, Any?> ?: return refused
        if (receipt["alg"] != "sha256") return refused
        val hash = receipt["hash"] as? String ?: return refused
        if (!HASH_SHAPE.matches(hash)) return refused

        val body = LinkedHashMap<String, Any?>()
        for ((key, value) in doc) if (key != "receipt") body[key] = value
        val bytes = try {
            canonical(body)
        } catch (_: IllegalArgumentException) {
            return Verdict("modified", false)
        }
        if (sha256Hex(bytes) != hash) return Verdict("modified", false)
        return Verdict("genuine", receipt["integrity"] is Map<*, *>)
    }
}

/** What a device knows about its session, folded from relay acks. The fold never STOPS a
 *  session - pausing is reversible (a heartbeat still carries acks, so a returning viewer
 *  resumes the wire); only the deadline passing stops it, and only [expire] says so. */
data class AckState(
    val idle: Int,
    val paused: Boolean,
    val stopped: Boolean,
    val reason: String,
    val deadline: Long,
) {
    companion object {
        fun start(): AckState = AckState(0, false, false, "", 0L)

        fun fold(state: AckState, ok: Boolean, viewers: Int, ttlMs: Long, at: Long): AckState {
            if (!ok || state.stopped) return state
            val deadline = at + ttlMs
            if (viewers > 0) return AckState(0, false, false, "", deadline)
            val idle = state.idle + 1
            return AckState(idle, idle >= LiveLogs.IDLE_ACK_PAUSE, false, "", deadline)
        }

        fun expire(state: AckState, at: Long): AckState {
            if (state.stopped || state.deadline <= 0 || at <= state.deadline) return state
            return state.copy(stopped = true, reason = "expired")
        }
    }
}

/** The bounded outbound queue: drop-oldest with a counted drop (the relay is told what it did
 *  not receive), a batch PEEKS and only the ack removes - a refused POST loses nothing. */
class LiveQueue<T>(private val cap: Int) {

    data class Push(val size: Int, val dropped: Int)

    private val items = ArrayList<T>()
    private var droppedCount = 0
    // A PEEKED BATCH IS PINNED: the exact-retry law says attempt 2 carries the SAME rows as
    // attempt 1, so the cap evicts the oldest UNPINNED row - never the in-flight head - and a
    // fully-pinned queue drops the newcomer, counted. Corpus: livelogs/wire.json `queue`.
    private var pinned = 0

    val size: Int get() = items.size
    val dropped: Int get() = droppedCount

    fun push(item: T): Push {
        if (items.size >= cap) {
            droppedCount += 1
            if (pinned >= items.size) return Push(items.size, droppedCount)
            items.removeAt(pinned)
        }
        items.add(item)
        return Push(items.size, droppedCount)
    }

    /** The next batch, oldest first - a PEEK, never a removal; what it returns is pinned. */
    fun batch(max: Int): List<T> {
        val peeked = items.take(maxOf(0, max))
        pinned = peeked.size
        return peeked
    }

    /** Drop the first [count] items - called after the relay accepted them. Never underflows. */
    fun ack(count: Int): Int {
        val take = minOf(maxOf(0, count), items.size)
        repeat(take) { items.removeAt(0) }
        pinned = maxOf(0, pinned - take)
        return items.size
    }

    fun clear() {
        pinned = 0
        items.clear()
        droppedCount = 0
    }
}

/** The relay's replay ring - the durable-cursor-feed law (realtime.ts) over live rows: seq is
 *  assigned monotonically from 1, a read resumes after a cursor, the bound evicts oldest, and a
 *  reader whose cursor predates the ring is TOLD about the gap rather than silently spliced. */
class LiveRing<T>(private val cap: Int) {

    data class Append(val accepted: Boolean, val last: Long)
    data class Entry<R>(val seq: Long, val row: R)
    data class Read<R>(val rows: List<Entry<R>>, val gap: Boolean)

    private val entries = ArrayList<Entry<T>>()
    private var lastSeq = 0L
    private var lastBatch = 0L

    val last: Long get() = lastSeq

    /** A replayed or stale batch index is refused whole - the idempotency law: a retried POST can
     *  never duplicate rows, so seq stays a truth a cursor can rely on. */
    fun appendBatch(n: Long, rows: List<T>): Append {
        if (n <= lastBatch) return Append(false, lastSeq)
        lastBatch = n
        for (row in rows) {
            lastSeq += 1
            entries.add(Entry(lastSeq, row))
            if (entries.size > cap) entries.removeAt(0)
        }
        return Append(true, lastSeq)
    }

    fun read(after: Long, limit: Int): Read<T> {
        val oldest = if (entries.isEmpty()) 0L else entries[0].seq
        val gap = entries.isNotEmpty() && after < oldest - 1
        val rows = ArrayList<Entry<T>>()
        for (entry in entries) {
            if (entry.seq <= after) continue
            rows.add(entry)
            if (rows.size >= maxOf(0, limit)) break
        }
        return Read(rows, gap)
    }
}
