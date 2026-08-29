//
//  Integrity.kt — the Kotlin twin of Engine/iOS/Integrity.swift and the web kernel's
//  integrity.ts: the SHARED PURE CORE behind Core/Integrity (F17.4).
//
//  WHAT THIS CAPABILITY ACTUALLY IS. Mandatory/Security answers "does this device look tampered
//  with?", which a determined attacker simply lies about, because the code asking the question
//  runs on the machine being questioned. Play Integrity and App Attest answer a DIFFERENT
//  question: they hand back a token the DEVELOPER'S BACKEND verifies with Google or Apple, so
//  the trust anchor is off-device. Those are not the same claim and this module never blurs
//  them.
//
//  THEREFORE THERE IS NO CLIENT-SIDE VERDICT, and this file contains no function that could be
//  mistaken for one. What it does contain is the ENVELOPE: the exact JSON shape a backend
//  receives, identical on both platforms, so a server is written once against a stable contract
//  instead of sniffing which mobile OS sent the request.
//
//  The base64url codec is shared with Passkeys rather than reimplemented: the kernel is one
//  unit, both capabilities put server-bound bytes on the same bus, and two codecs that agree
//  today are two codecs that drift.
//
//  Pure JVM — no Android imports. Pinned by OpenSource/Conformance/integrity/attestation.json.
//
package despia.engine

object Integrity {

    /** Who can vouch for this app, per platform. `none` is a first-class answer, not an error. */
    val PROVIDERS: List<String> = listOf("appattest", "playintegrity", "none")

    /** The token formats a backend must be able to tell apart. The provider alone is not enough:
     *  App Attest issues two shapes for two ceremonies, and a server that treats an assertion as
     *  an attestation fails verification with an opaque error. */
    val FORMATS: List<String> = listOf("apple.attest", "apple.assert", "google.playintegrity")

    /** Play Integrity's nonce ceiling is the BINDING constraint across both platforms: Apple
     *  hashes the challenge so any length works there. One rule, so a challenge that works on
     *  one platform cannot fail on the other. */
    const val MIN_CHALLENGE_BYTES = 16
    const val MAX_CHALLENGE_BYTES = 500

    /** A key reference is an opaque platform handle; the cap is a sanity bound, not a spec value. */
    const val MAX_KEY_REF_CHARS = 512

    /**
     * The sentence every caller gets back with a token. Enforcing an attestation result on the
     * device that produced it is theatre, and a developer who believes otherwise ships an app a
     * five-line patch defeats. Saying so in the payload is cheaper than saying it in
     * documentation nobody reads.
     */
    const val ADVISORY =
        "This token is only meaningful once your backend verifies it with Apple or Google. " +
            "Nothing decided on the device is a security decision."

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_challenge" to "That is not a usable attestation challenge.",
        "invalid_key_ref" to "That is not a usable key reference.",
        "unknown_provider" to "That is not an attestation provider this platform has.",
        "unknown_format" to "That is not a ceremony this provider performs.",
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

    data class Envelope(
        val provider: String,
        val format: String,
        val token: String,
        val challenge: String,
        val keyRef: String,
        val advisory: String,
    )

    /** Which attestation service, if any, can vouch for this app on a given platform. */
    fun providerFor(platform: Any?): String {
        return when ((platform?.toString() ?: "").trim().lowercase()) {
            "ios", "ipados", "macos", "tvos", "watchos" -> "appattest"
            "android" -> "playintegrity"
            else -> "none"
        }
    }

    /** The format word for a provider and a ceremony kind. Refuses rather than guessing: a
     *  backend that receives the wrong word fails verification with an opaque platform error. */
    fun format(provider: Any?, kind: Any?): Result<String> {
        val p = (provider?.toString() ?: "").trim().lowercase()
        val k = (kind?.toString() ?: "").trim().lowercase()
        if (p == "appattest" && k == "attest") return Result.success("apple.attest")
        if (p == "appattest" && k == "assert") return Result.success("apple.assert")
        // Play Integrity draws no attest/assert distinction: one request, one token, every time.
        if (p == "playintegrity" && (k == "attest" || k == "assert")) {
            return Result.success("google.playintegrity")
        }
        if (p != "appattest" && p != "playintegrity") return refuse("unknown_provider", p)
        return refuse("unknown_format", "$p/$k")
    }

    /**
     * A challenge is base64url and long enough to be unguessable, with ONE length rule across
     * both platforms. A challenge the client invented is worthless: it must come from the server
     * that will later verify the token, which is why there is no "generate a challenge"
     * function anywhere in this module.
     */
    fun normalizeChallenge(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return refuse("invalid_challenge", "a challenge is required")
        val bytes = Passkeys.base64UrlDecode(text)
            ?: return refuse("invalid_challenge", "a challenge is base64url")
        if (bytes.size < MIN_CHALLENGE_BYTES) {
            return refuse("invalid_challenge", "a challenge is at least $MIN_CHALLENGE_BYTES bytes")
        }
        if (bytes.size > MAX_CHALLENGE_BYTES) {
            return refuse("invalid_challenge", "a challenge is at most $MAX_CHALLENGE_BYTES bytes")
        }
        return Result.success(Passkeys.base64UrlEncode(bytes))
    }

    /** The handle `attest` produced and `assert` needs back. Opaque: its INTERNAL shape is the
     *  platform's business, so only emptiness and absurd length are refused. */
    fun normalizeKeyRef(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return refuse("invalid_key_ref", "a key reference is required")
        if (text.length > MAX_KEY_REF_CHARS) {
            return refuse("invalid_key_ref", "a key reference is at most $MAX_KEY_REF_CHARS characters")
        }
        for (c in text) {
            val ok = (c in 'A'..'Z') || (c in 'a'..'z') || (c in '0'..'9') ||
                c == '-' || c == '_' || c == '+' || c == '/' || c == '='
            if (!ok) return refuse("invalid_key_ref", "a key reference is a base64 handle")
        }
        return Result.success(text)
    }

    /**
     * Build the payload the backend receives. THE SHAPE IS THE PRODUCT: a server written against
     * this envelope does not care which mobile OS sent the request, because `format` tells it
     * which verification call to make and every field is present on both platforms (empty where
     * a platform has no such thing, never absent). A sometimes-missing field is a server branch
     * nobody remembers to write.
     */
    fun envelope(
        provider: Any?, kind: Any?, token: Any?, challenge: String, keyRef: String,
    ): Result<Envelope> {
        val fmt = format(provider, kind).getOrElse { e -> return Result.failure(e) }
        return Result.success(
            Envelope(
                (provider?.toString() ?: "").trim().lowercase(),
                fmt,
                token?.toString() ?: "",
                challenge,
                keyRef,
                ADVISORY,
            ),
        )
    }
}
