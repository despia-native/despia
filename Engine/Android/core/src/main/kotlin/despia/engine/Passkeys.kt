//
//  Passkeys.kt — the Kotlin twin of Engine/iOS/Passkeys.swift and the web kernel's
//  passkeys.ts: the SHARED PURE CORE behind Core/Passkeys (F17.3).
//
//  WHY THIS IS A CORE AND NOT THREE ADAPTERS. WebAuthn's data model is binary, and the three
//  platforms disagree about how those bytes cross the language boundary — the browser wants
//  BufferSource, Apple wants Data, Credential Manager wants base64url inside a JSON document.
//  If each facet did its own conversion, a challenge that round-trips on one platform would be
//  padded, truncated or re-encoded on another and the server would reject the assertion with
//  no clue why. Base64url is therefore the ONE wire form on the DSX bus, its codec lives here,
//  and the round trip is corpus-pinned (OpenSource/Conformance/passkeys/ceremony.json).
//
//  NO android.util.Base64. It is unavailable off-device (so :core's SDK-free lane could not run
//  this), and its URL_SAFE|NO_WRAP flags still differ from the browser's on padding. The codec
//  is written out longhand so the three runtimes cannot drift.
//
//  Pure JVM — no Android imports. The ceremony itself lives in the module's kotlin/ facet.
//
package despia.engine

object Passkeys {

    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    /** 16 bytes is the floor every WebAuthn hardening guide names; a replayable 4-byte nonce
     *  defeats the whole ceremony. */
    const val MIN_CHALLENGE_BYTES = 16
    const val MAX_CHALLENGE_BYTES = 1024

    /** The spec's own ceiling on a user handle. */
    const val MAX_USER_ID_BYTES = 64

    const val MIN_TIMEOUT_MS = 15000
    const val DEFAULT_TIMEOUT_MS = 60000
    const val MAX_TIMEOUT_MS = 600000

    val ATTESTATIONS: List<String> = listOf("none", "indirect", "direct", "enterprise")
    val MEDIATIONS: List<String> = listOf("silent", "optional", "conditional", "required")
    val VERIFICATIONS: List<String> = listOf("required", "preferred", "discouraged")
    val RESIDENT_KEYS: List<String> = listOf("discouraged", "preferred", "required")

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_rp_id" to "That is not a relying-party domain.",
        "invalid_challenge" to "That is not a usable challenge.",
        "invalid_user" to "That is not a usable user handle.",
        "invalid_credential" to "That is not a base64url credential id.",
        "unknown_attestation" to "That is not an attestation preference.",
        "unknown_mediation" to "That is not a mediation mode.",
        "unknown_verification" to "That is not a user-verification preference.",
        "unknown_resident_key" to "That is not a resident-key preference.",
    )

    class RefusalError(val code: String, val detail: String?) : Exception(code)

    private fun <T> refuse(code: String, detail: String? = null): Result<T> =
        Result.failure(RefusalError(code, detail))

    fun code(error: Throwable): String = (error as? RefusalError)?.code ?: "invalid_challenge"

    fun detail(error: Throwable): String {
        val d = (error as? RefusalError)?.detail
        if (!d.isNullOrEmpty()) return d
        return MESSAGES[code(error)] ?: code(error)
    }

    data class User(val id: String, val name: String, val displayName: String)

    data class CreateOptions(
        val rpId: String,
        val user: User,
        val challenge: String,
        val attestation: String,
        val userVerification: String,
        val residentKey: String,
        val excludeCredentials: List<String>,
        val timeoutMs: Int,
    )

    data class GetOptions(
        val rpId: String,
        val challenge: String,
        val mediation: String,
        val userVerification: String,
        val allowCredentials: List<String>,
        val timeoutMs: Int,
    )

    // ── base64url, the one wire form ──────────────────────────────────────────────

    /** Encode bytes as UNPADDED base64url. Unpadded because the WebAuthn JSON serialisations
     *  all are, and a stray `=` is the most common cause of a server rejecting a valid
     *  assertion. */
    fun base64UrlEncode(bytes: List<Int>): String {
        val out = StringBuilder()
        val n = bytes.size
        var i = 0
        while (i < n) {
            val b0 = bytes[i] and 0xff
            val b1 = if (i + 1 < n) bytes[i + 1] and 0xff else 0
            val b2 = if (i + 2 < n) bytes[i + 2] and 0xff else 0
            out.append(ALPHABET[b0 shr 2])
            out.append(ALPHABET[((b0 and 0x03) shl 4) or (b1 shr 4)])
            if (i + 1 < n) out.append(ALPHABET[((b1 and 0x0f) shl 2) or (b2 shr 6)])
            if (i + 2 < n) out.append(ALPHABET[b2 and 0x3f])
            i += 3
        }
        return out.toString()
    }

    /**
     * Decode base64url to bytes, or null when the text is not base64url.
     *
     * TOLERANT ON INPUT, STRICT ON OUTPUT: standard base64's `+` and `/` are accepted and so is
     * `=` padding, because half the world's servers emit them, but the encoder never produces
     * either. One leftover character cannot be a base64 group, so it is null rather than a
     * silently truncated buffer.
     */
    fun base64UrlDecode(text: Any?): List<Int>? {
        val input = text as? String ?: return null
        val clean = StringBuilder()
        for (c in input) {
            if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue
            if (c == '+') { clean.append('-'); continue }
            if (c == '/') { clean.append('_'); continue }
            if (ALPHABET.indexOf(c) < 0) return null
            clean.append(c)
        }
        if (clean.length % 4 == 1) return null
        val out = ArrayList<Int>(clean.length / 4 * 3)
        var i = 0
        while (i < clean.length) {
            val chunk = clean.substring(i, minOf(i + 4, clean.length))
            val v0 = ALPHABET.indexOf(chunk[0])
            val v1 = if (chunk.length > 1) ALPHABET.indexOf(chunk[1]) else 0
            val v2 = if (chunk.length > 2) ALPHABET.indexOf(chunk[2]) else -1
            val v3 = if (chunk.length > 3) ALPHABET.indexOf(chunk[3]) else -1
            out.add(((v0 shl 2) or (v1 shr 4)) and 0xff)
            if (v2 >= 0) out.add(((v1 shl 4) or (v2 shr 2)) and 0xff)
            if (v3 >= 0) out.add(((v2 shl 6) or v3) and 0xff)
            i += 4
        }
        return out
    }

    /** How many bytes a base64url string carries, or -1 when it is not base64url. */
    fun base64UrlByteLength(text: Any?): Int = base64UrlDecode(text)?.size ?: -1

    // ── the relying party ─────────────────────────────────────────────────────────

    /**
     * Normalize a relying-party id: a bare registrable domain, lowercase, no scheme, no port,
     * no path. Every one of those is a real mistake, and each produces a ceremony that fails on
     * device with an "origin mismatch" that names nothing useful. A single label (`localhost`)
     * is allowed on purpose: it is the only rpId that works before deployment.
     */
    fun normalizeRpId(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim().lowercase()
        if (text.isEmpty()) return refuse("invalid_rp_id", "an rpId is required")
        if (text.contains("://")) return refuse("invalid_rp_id", "an rpId is a domain, not a URL")
        if (text.contains('/') || text.contains('?') || text.contains('#')) {
            return refuse("invalid_rp_id", "an rpId carries no path")
        }
        if (text.contains(':')) return refuse("invalid_rp_id", "an rpId carries no port")
        if (text.length > 253) return refuse("invalid_rp_id", "too long to be a domain")
        for (label in text.split(".")) {
            if (label.isEmpty() || label.length > 63) {
                return refuse("invalid_rp_id", "malformed domain label")
            }
            if (label.startsWith("-") || label.endsWith("-")) {
                return refuse("invalid_rp_id", "a domain label cannot start or end with a hyphen")
            }
            for (c in label) {
                val ok = (c in 'a'..'z') || (c in '0'..'9') || c == '-'
                if (!ok) return refuse("invalid_rp_id", "a domain label is letters, digits and hyphens")
            }
        }
        return Result.success(text)
    }

    /** A challenge is base64url and long enough to be unguessable. Both halves matter: a
     *  hex-encoded challenge that happens to decode is still the wrong bytes on the wire. */
    fun normalizeChallenge(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return refuse("invalid_challenge", "a challenge is required")
        val bytes = base64UrlDecode(text) ?: return refuse("invalid_challenge", "a challenge is base64url")
        if (bytes.size < MIN_CHALLENGE_BYTES) {
            return refuse("invalid_challenge", "a challenge is at least $MIN_CHALLENGE_BYTES bytes")
        }
        if (bytes.size > MAX_CHALLENGE_BYTES) {
            return refuse("invalid_challenge", "a challenge is at most $MAX_CHALLENGE_BYTES bytes")
        }
        return Result.success(base64UrlEncode(bytes))
    }

    /** The user handle the authenticator stores. `id` is OPAQUE BYTES and must not be an email
     *  or a username: it is written into the authenticator, syncs to the user's other devices,
     *  and can never be changed. PII there is a privacy defect that outlives the account. */
    fun normalizeUser(raw: Any?): Result<User> {
        val map = raw as? Map<*, *> ?: return refuse("invalid_user", "a user object is required")
        val id = (map["id"]?.toString() ?: "").trim()
        val bytes = base64UrlDecode(id)
        if (bytes == null || bytes.isEmpty()) {
            return refuse("invalid_user", "user.id is base64url bytes, not a username")
        }
        if (bytes.size > MAX_USER_ID_BYTES) {
            return refuse("invalid_user", "user.id is at most $MAX_USER_ID_BYTES bytes")
        }
        val name = (map["name"]?.toString() ?: "").trim()
        if (name.isEmpty()) return refuse("invalid_user", "user.name is what the account picker shows")
        val display = (map["displayName"]?.toString() ?: "").trim()
        return Result.success(User(base64UrlEncode(bytes), name, if (display.isEmpty()) name else display))
    }

    private fun foldWord(
        raw: Any?, vocabulary: List<String>, fallback: String, refusalCode: String,
    ): Result<String> {
        val text = (raw?.toString() ?: "").trim().lowercase()
            .filter { !it.isWhitespace() && it != '-' && it != '_' }
        if (text.isEmpty()) return Result.success(fallback)
        for (word in vocabulary) {
            if (word.lowercase() == text) return Result.success(word)
        }
        return refuse(refusalCode, raw?.toString() ?: "")
    }

    fun foldAttestation(raw: Any?): Result<String> =
        foldWord(raw, ATTESTATIONS, "none", "unknown_attestation")

    fun foldMediation(raw: Any?): Result<String> =
        foldWord(raw, MEDIATIONS, "optional", "unknown_mediation")

    fun foldUserVerification(raw: Any?): Result<String> =
        foldWord(raw, VERIFICATIONS, "preferred", "unknown_verification")

    fun foldResidentKey(raw: Any?): Result<String> =
        foldWord(raw, RESIDENT_KEYS, "preferred", "unknown_resident_key")

    /** Clamp rather than refuse: a caller asking for an hour wants "as long as the platform
     *  will allow", and refusing that is a worse answer than honouring the ceiling. */
    fun clampTimeout(raw: Any?): Int {
        val n = when (raw) {
            null -> return DEFAULT_TIMEOUT_MS
            is Number -> raw.toDouble()
            is String -> raw.trim().toDoubleOrNull() ?: return DEFAULT_TIMEOUT_MS
            else -> return DEFAULT_TIMEOUT_MS
        }
        if (!n.isFinite() || n <= 0.0) return DEFAULT_TIMEOUT_MS
        if (n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS
        if (n > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS
        return Math.round(n).toInt()
    }

    /** Credential ids named in an allow or exclude list. An unparseable one is refused rather
     *  than dropped: a silently shortened allow list reads to the user as "this device has no
     *  passkey" and there is nothing to debug. */
    fun normalizeCredentialIds(raw: Any?): Result<List<String>> {
        val list: List<Any?> = when {
            raw is List<*> -> raw
            raw is String && raw.isNotEmpty() -> listOf(raw)
            else -> emptyList()
        }
        val out = ArrayList<String>(list.size)
        for (entry in list) {
            val text = when (entry) {
                is String -> entry.trim()
                is Map<*, *> -> (entry["id"]?.toString() ?: "").trim()
                else -> (entry?.toString() ?: "").trim()
            }
            val bytes = base64UrlDecode(text)
            if (bytes == null || bytes.isEmpty()) return refuse("invalid_credential", text)
            val canonical = base64UrlEncode(bytes)
            if (!out.contains(canonical)) out.add(canonical)
        }
        return Result.success(out)
    }

    fun normalizeCreateOptions(raw: Map<String, Any?>): Result<CreateOptions> {
        val rpId = normalizeRpId(raw["rpId"]).getOrElse { e -> return Result.failure(e) }
        val user = normalizeUser(raw["user"]).getOrElse { e -> return Result.failure(e) }
        val challenge = normalizeChallenge(raw["challenge"]).getOrElse { e -> return Result.failure(e) }
        val attestation = foldAttestation(raw["attestation"]).getOrElse { e -> return Result.failure(e) }
        val verification = foldUserVerification(raw["userVerification"]).getOrElse { e -> return Result.failure(e) }
        val residentKey = foldResidentKey(raw["residentKey"]).getOrElse { e -> return Result.failure(e) }
        val exclude = normalizeCredentialIds(raw["exclude"] ?: raw["excludeCredentials"])
            .getOrElse { e -> return Result.failure(e) }
        return Result.success(
            CreateOptions(rpId, user, challenge, attestation, verification, residentKey, exclude,
                          clampTimeout(raw["timeout"])),
        )
    }

    fun normalizeGetOptions(raw: Map<String, Any?>): Result<GetOptions> {
        val rpId = normalizeRpId(raw["rpId"]).getOrElse { e -> return Result.failure(e) }
        val challenge = normalizeChallenge(raw["challenge"]).getOrElse { e -> return Result.failure(e) }
        val mediation = foldMediation(raw["mediation"]).getOrElse { e -> return Result.failure(e) }
        val verification = foldUserVerification(raw["userVerification"]).getOrElse { e -> return Result.failure(e) }
        val allow = normalizeCredentialIds(raw["allow"] ?: raw["allowCredentials"])
            .getOrElse { e -> return Result.failure(e) }
        return Result.success(
            GetOptions(rpId, challenge, mediation, verification, allow, clampTimeout(raw["timeout"])),
        )
    }
}
