//
//  CryptoCore.kt - the shared `crypto` module core (:core, pure JVM): the digest-name fold,
//  the UUID bit layouts and the uniform-integer rejection bound. The law is the corpus,
//  OpenSource/Conformance/crypto/ (parity/F15-crypto.md). The twin of the web
//  @despia/kernel crypto-core.ts and of Swift CryptoCore.
//
//  NOTHING here computes a hash, a MAC or a signature. Those are java.security and the
//  AndroidKeyStore's job and the module facet calls straight into them. What lives here is
//  the part that has no platform answer and would therefore drift between renderers: which
//  spelling of "sha256" is accepted, exactly which bits of a UUID carry the timestamp, and
//  how many draws a uniform integer costs.
//
package despia.engine

object CryptoCore {

    /** One digest the module offers: its JCA name, its WebCrypto name, and whether it is one
     *  of the two legacy algorithms a build may switch off. */
    data class Digest(val jca: String, val web: String, val legacy: Boolean)

    /** The digest vocabulary, keyed by the spelling authors write. sha1 and md5 are present
     *  because integrity checks against existing servers need them, and marked legacy so no
     *  code path can pick one as a default. */
    val DIGESTS: Map<String, Digest> = linkedMapOf(
        "sha256" to Digest("SHA-256", "SHA-256", false),
        "sha384" to Digest("SHA-384", "SHA-384", false),
        "sha512" to Digest("SHA-512", "SHA-512", false),
        "sha1" to Digest("SHA-1", "SHA-1", true),
        "md5" to Digest("MD5", "MD5", true),
    )

    /** The MAC vocabulary is the digest vocabulary minus md5: nothing needs HMAC-MD5 that
     *  HMAC-SHA1 does not serve, and WebCrypto refuses it, so offering it would be a lie on
     *  one of the three renderers. */
    val MAC_DIGESTS: List<String> = listOf("sha256", "sha384", "sha512", "sha1")

    /** The JCA Mac algorithm name for a folded digest id. */
    fun macName(id: String): String? = when (id) {
        "sha256" -> "HmacSHA256"
        "sha384" -> "HmacSHA384"
        "sha512" -> "HmacSHA512"
        "sha1" -> "HmacSHA1"
        else -> null
    }

    /** The largest `randomBytes` request. An unbounded allocation is reachable from markup. */
    const val MAX_RANDOM_BYTES: Int = 1048576

    /** Fold an author's algorithm spelling. Case-insensitive after trimming, and the
     *  separator forms every other library accepts (`SHA-256`, `sha_256`) fold to the same
     *  id. Returns null for an unknown name, or for a legacy name when the build switched
     *  legacy digests off. */
    fun foldDigest(name: String?, allowLegacy: Boolean = true): String? {
        val key = (name ?: "").trim().lowercase().filter { it != '-' && it != '_' && !it.isWhitespace() }
        val entry = DIGESTS[key] ?: return null
        if (entry.legacy && !allowLegacy) return null
        return key
    }

    private fun format(bytes: IntArray): String {
        val sb = StringBuilder(36)
        for (i in 0 until 16) {
            if (i == 4 || i == 6 || i == 8 || i == 10) sb.append('-')
            sb.append("%02x".format(bytes[i] and 0xff))
        }
        return sb.toString()
    }

    private fun take(random: ByteArray, count: Int): IntArray =
        IntArray(count) { if (it < random.size) random[it].toInt() and 0xff else 0 }

    /** RFC 9562 version 4: 16 random bytes with the version and variant nibbles stamped over
     *  them. Bytes past the sixteenth are ignored. */
    fun uuidV4(random: ByteArray): String {
        val b = IntArray(16)
        val src = take(random, 16)
        for (i in 0 until 16) b[i] = src[i]
        b[6] = (b[6] and 0x0f) or 0x40
        b[8] = (b[8] and 0x3f) or 0x80
        return format(b)
    }

    /** RFC 9562 version 7: 48 bits of Unix milliseconds big-endian, then the version nibble,
     *  then 74 bits of randomness (10 supplied bytes, two of them partially overwritten).
     *
     *  The ordering property is the entire point: two v7 ids minted a millisecond apart
     *  compare in mint order as plain strings, so they index and paginate without a separate
     *  sort key. */
    fun uuidV7(unixMillis: Long, random: ByteArray): String {
        val ms = (if (unixMillis < 0) 0L else unixMillis) % 0x1000000000000L
        val b = IntArray(16)
        for (i in 0 until 6) b[i] = ((ms shr (8 * (5 - i))) and 0xff).toInt()
        val src = take(random, 10)
        for (i in 0 until 10) b[6 + i] = src[i]
        b[6] = (b[6] and 0x0f) or 0x70
        b[8] = (b[8] and 0x3f) or 0x80
        return format(b)
    }

    /** The largest exact multiple of `range` that fits in 32 bits. A 32-bit draw at or above
     *  this is DISCARDED; below it, `draw % range` is exactly uniform. `range` is the count of
     *  distinct outcomes (max - min + 1) and must be 1..2^32. Zero means "not a range". */
    fun uniformBound(range: Long): Long {
        if (range < 1L || range > 0x100000000L) return 0L
        return 0x100000000L - (0x100000000L % range)
    }

    /** What `randomInt` does with a supplied sequence of 32-bit draws: skip every draw the
     *  bound rejects, fold the first survivor. Pure and deterministic, which is what lets the
     *  corpus pin the rejection behaviour rather than merely asserting the answer is in
     *  range. */
    data class Pick(val value: Long, val consumed: Int)

    fun uniformPick(range: Long, draws: LongArray): Pick? {
        val bound = uniformBound(range)
        if (bound == 0L) return null
        for (i in draws.indices) {
            val draw = draws[i] and 0xFFFFFFFFL
            if (draw < bound) return Pick(draw % range, i + 1)
        }
        return null
    }

    /** The full `randomInt` fold. `min`/`max` are inclusive; the stable machine ids are
     *  `invalid_range` and `exhausted`. */
    sealed class IntResult {
        data class Value(val value: Long, val consumed: Int) : IntResult()
        data class Refused(val code: String) : IntResult()
    }

    fun uniformInt(min: Long, max: Long, draws: LongArray): IntResult {
        if (max < min) return IntResult.Refused("invalid_range")
        val range = max - min + 1L
        if (range > 0x100000000L) return IntResult.Refused("invalid_range")
        val picked = uniformPick(range, draws) ?: return IntResult.Refused("exhausted")
        return IntResult.Value(min + picked.value, picked.consumed)
    }
}
