//
//  AuthProof.kt — Kotlin twin of ../../../../../../../Web/packages/kernel/src/auth-proof.ts and
//  ../../../../../../iOS/AuthProof.swift: THE AUTHENTICATION PROOF PURE CORE (A1,
//  ClosedSource/Documentation/v4-launch/completeness/A1-auth-hardening.md). Two folds, and a
//  login is the one flow where a fail-open default is a compromise:
//
//    1. THE TRIGGER FOLD — matchesConfiguredTrigger / isAllowedAuthorizationUrl. LoginHelper
//       decides on every main-frame navigation whether the URL about to load is a configured
//       identity provider; a match takes the navigation away from the app surface and hands it
//       to a browser (Android) or to a provider-user-agent web view sharing the app's cookie
//       jar (iOS). A raw string prefix therefore gives anyone who controls
//       `idp.example.attacker.invalid` a login surface wearing the IdP's clothes.
//
//    2. THE PROOF FOLD — PKCE (RFC 7636), `state` (RFC 6749 §10.12, RFC 9700 §2.1) and OIDC
//       `nonce`: which proofs a module owns for a given authorize URL, the exact URL it builds,
//       and the verdict a returning callback earns.
//
//  The law is the corpus, OpenSource/Conformance/auth/{trigger,pkce}.json, executed here by
//  :core AuthProofConformanceTest.
//
//  NOTHING here hashes and nothing here draws entropy: RFC 7636's S256 is
//  BASE64URL-ENCODE(SHA256(ASCII(verifier))) and the SHA-256 half is MessageDigest's job,
//  exactly as CryptoCore.kt says; the CSPRNG behind a minted value is SecureRandom's. What
//  lives here is the half that has no platform answer and would otherwise drift.
//
//  PURE by construction: no android.*, no java.net.URI, no Regex on any security decision. The
//  URL splitter is hand-rolled precisely BECAUSE java.net.URI, Uri and NSURL disagree about
//  userinfo, backslashes and percent-escaped hosts, and a security fold cannot be the union of
//  three parsers' bugs.
//

package despia.engine

/** An absolute URL's origin parts. `port` is -1 when none was written; `hasUserInfo` is kept
 *  rather than the userinfo itself, because nothing here has any business reading it. */
data class UrlOrigin(
    val scheme: String,
    val host: String,
    val port: Int,
    val hasUserInfo: Boolean,
)

/** The verdict a returning callback earns — see [AuthProof.verifyCallbackProofs]. */
enum class CallbackVerdict(val id: String) {
    OK("ok"),
    UNPROVEN("unproven"),
    MISSING_STATE("missing_state"),
    STATE_MISMATCH("state_mismatch"),
    REPLAYED("replayed"),
    NONCE_MISMATCH("nonce_mismatch"),
}

/** What [AuthProof.planAuthorizeProofs] decided. `refusal` is a DECLARED module error code or
 *  null; when it is set, nothing is minted. */
data class AuthorizeProofPlan(
    val refusal: String?,
    val mintState: Boolean,
    val adoptedState: String?,
    val mintNonce: Boolean,
    val adoptedNonce: String?,
    val mintPkce: Boolean,
)

object AuthProof {

    // ── 0 · the hand-rolled absolute-URL split — one parser, three runtimes ──────────────

    private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    /** RFC 7636 §4.1: code-verifier = 43*128unreserved. */
    const val PKCE_VERIFIER_MIN_LENGTH = 43
    const val PKCE_VERIFIER_MAX_LENGTH = 128

    /** RFC 7636 §7.1: "a minimum of 256 bits of entropy… a 32-octet sequence". 32 octets
     *  base64url-encode to exactly 43 characters, which is also the ABNF floor — the two
     *  constraints meet, which is why 32 is the number and not a taste. */
    const val PKCE_VERIFIER_ENTROPY_BYTES = 32

    /** `state` and `nonce` are unguessability tokens, not key material; 128 bits is the floor. */
    const val AUTH_PROOF_ENTROPY_BYTES = 16

    /** The only challenge method this core will build. RFC 7636 §4.2 makes S256 mandatory to
     *  implement on the server, and `plain` exists for clients that cannot hash — which
     *  describes no platform this runs on. */
    const val PKCE_CHALLENGE_METHOD = "S256"

    /** The refusal [planAuthorizeProofs] can return; declared in Core/Auth/OAuth/dsx.json. */
    const val REFUSAL_PKCE_UNSUPPORTED = "pkce_unsupported"

    private fun isDigit(ch: Char) = ch in '0'..'9'
    private fun isAlpha(ch: Char) = ch in 'a'..'z' || ch in 'A'..'Z'

    /** Characters that must never appear inside an authority. A backslash is the whole reason
     *  this list exists: some parsers normalize `\` to `/`, some do not, and
     *  `https://idp.example\@evil` therefore means two different hosts on two renderers.
     *  Anything ambiguous is refused, never guessed — the cost of a false refusal is a
     *  navigation that is not intercepted, which is the behaviour it already had. */
    private fun authorityIsClean(authority: String): Boolean {
        for (ch in authority) {
            if (ch.code <= 0x20 || ch.code == 0x7f) return false
            if (ch == '\\' || ch == '<' || ch == '>' || ch == '"' || ch == '^' ||
                ch == '{' || ch == '}' || ch == '|' || ch == '`'
            ) return false
        }
        return true
    }

    /** Split an absolute `scheme://authority…` URL into its origin, or null when it is not one
     *  or is not unambiguous. A percent escape in the host is refused rather than decoded:
     *  `%2e` is a dot to some parsers and a literal to others, and either answer is a lookalike
     *  host. */
    fun splitOrigin(raw: String?): UrlOrigin? {
        val text = raw ?: return null
        if (text.isEmpty() || !isAlpha(text[0])) return null

        var i = 0
        while (i < text.length) {
            val ch = text[i]
            if (ch == ':') break
            if (!isAlpha(ch) && !isDigit(ch) && ch != '+' && ch != '-' && ch != '.') return null
            i += 1
        }
        if (i >= text.length || text[i] != ':') return null
        val scheme = text.substring(0, i).lowercase()
        if (!text.startsWith("://", i)) return null

        var end = i + 3
        while (end < text.length) {
            val ch = text[end]
            if (ch == '/' || ch == '?' || ch == '#') break
            end += 1
        }
        val authority = text.substring(i + 3, end)
        if (!authorityIsClean(authority)) return null

        val at = authority.lastIndexOf('@')
        val hasUserInfo = at >= 0
        val hostPort = if (hasUserInfo) authority.substring(at + 1) else authority

        var host = hostPort
        var port = -1
        if (hostPort.startsWith("[")) {
            val close = hostPort.indexOf(']')
            if (close < 0) return null
            host = hostPort.substring(0, close + 1)
            val rest = hostPort.substring(close + 1)
            if (rest.isNotEmpty()) {
                if (rest[0] != ':') return null
                val digits = rest.substring(1)
                if (digits.isEmpty() || digits.any { !isDigit(it) }) return null
                port = digits.toIntOrNull() ?: return null
            }
        } else {
            val colon = hostPort.indexOf(':')
            if (colon >= 0) {
                host = hostPort.substring(0, colon)
                val digits = hostPort.substring(colon + 1)
                if (digits.isEmpty() || digits.any { !isDigit(it) }) return null
                port = digits.toIntOrNull() ?: return null
            }
        }
        if (host.isEmpty()) return null
        if (host.any { it == '%' || it == ':' || it == '@' }) return null

        return UrlOrigin(scheme, host.lowercase(), port, hasUserInfo)
    }

    /** Does this text CLAIM a URI scheme, whether or not it parses into an origin? The
     *  distinction matters exactly once, and it is a security decision: `https://` and
     *  `javascript:alert` both claim a scheme and neither yields an origin, so treating either
     *  as a legacy raw prefix would make the first match every https URL there is and the
     *  second hand a script URL to a login surface. A claim that does not parse is refused;
     *  only text that never claimed is legacy. */
    fun claimsUriScheme(raw: String?): Boolean {
        val text = raw ?: return false
        if (text.isEmpty() || !isAlpha(text[0])) return false
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            if (ch == ':') return true
            if (!isAlpha(ch) && !isDigit(ch) && ch != '+' && ch != '-' && ch != '.') return false
            i += 1
        }
        return false
    }

    /** The port an origin comparison uses: the written one, else the scheme's default, else -1
     *  so two custom-scheme origins still compare equal to each other. */
    fun normalizedPort(origin: UrlOrigin): Int = when {
        origin.port >= 0 -> origin.port
        origin.scheme == "https" -> 443
        origin.scheme == "http" -> 80
        else -> -1
    }

    // ── 1 · the trigger fold — a configured login trigger is an origin, not a prefix ─────

    /** Does `candidate` belong to the identity provider configured as `configuredPrefix`?
     *
     *  The raw prefix is NECESSARY, never sufficient: it runs first so nothing that already
     *  failed the legacy test starts matching, and an absolute prefix then additionally pins
     *  scheme, host and port and refuses userinfo. Case is deliberately not folded on the
     *  prefix test — an uppercase host that fails the byte prefix simply is not intercepted,
     *  which is the direction that costs nothing. */
    fun matchesConfiguredTrigger(candidate: String?, configuredPrefix: String?): Boolean {
        val prefix = configuredPrefix ?: return false
        val target = candidate ?: return false
        if (prefix.isEmpty() || !target.startsWith(prefix)) return false

        val trigger = splitOrigin(prefix) ?: return !claimsUriScheme(prefix)
        val actual = splitOrigin(target) ?: return false

        return actual.scheme == trigger.scheme &&
            actual.host == trigger.host &&
            normalizedPort(actual) == normalizedPort(trigger) &&
            !actual.hasUserInfo
    }

    /** May this URL be handed to a browser as an authorization START? Confidential transport, a
     *  real host, and no URL credentials: a `javascript:` / `intent:` / `file:` authorization
     *  start is not an authorization start, and userinfo in an authorization URL is a phishing
     *  primitive some browsers still render. */
    fun isAllowedAuthorizationUrl(raw: String?): Boolean {
        val origin = splitOrigin(raw) ?: return false
        return origin.scheme == "https" && origin.host.isNotEmpty() && !origin.hasUserInfo
    }

    // ── 2 · base64url, the verifier ABNF, the S256 challenge ────────────────────────────

    /** RFC 4648 §5 with "all trailing '=' characters omitted" (RFC 7636 §A). One encoder serves
     *  the verifier, the challenge, `state` and `nonce`, so a padding character can never
     *  appear in any of them. Octets are read unsigned so no runtime has to agree about signed
     *  bytes first. */
    fun base64UrlNoPad(bytes: IntArray): String {
        val out = StringBuilder()
        var i = 0
        val n = bytes.size
        while (i + 2 < n) {
            val a = bytes[i] and 0xff
            val b = bytes[i + 1] and 0xff
            val c = bytes[i + 2] and 0xff
            out.append(B64URL[a ushr 2])
            out.append(B64URL[((a and 0x03) shl 4) or (b ushr 4)])
            out.append(B64URL[((b and 0x0f) shl 2) or (c ushr 6)])
            out.append(B64URL[c and 0x3f])
            i += 3
        }
        when (n - i) {
            1 -> {
                val a = bytes[i] and 0xff
                out.append(B64URL[a ushr 2])
                out.append(B64URL[(a and 0x03) shl 4])
            }
            2 -> {
                val a = bytes[i] and 0xff
                val b = bytes[i + 1] and 0xff
                out.append(B64URL[a ushr 2])
                out.append(B64URL[((a and 0x03) shl 4) or (b ushr 4)])
                out.append(B64URL[(b and 0x0f) shl 2])
            }
        }
        return out.toString()
    }

    /** The ByteArray door onto the same encoder — what MessageDigest and SecureRandom hand
     *  back. Signed JVM bytes are widened unsigned exactly once, here. */
    fun base64UrlNoPad(bytes: ByteArray): String =
        base64UrlNoPad(IntArray(bytes.size) { bytes[it].toInt() and 0xff })

    /** RFC 4648 §5 the other way, to UTF-8 text. Refuses padding, refuses an alphabet outside
     *  base64url, refuses the impossible residue of one, and refuses bytes that are not UTF-8 —
     *  every one of those is a malformed token rather than something to salvage. */
    fun base64UrlDecodeUtf8(segment: String?): String? {
        val text = segment ?: return null
        if (text.isEmpty() || text.length % 4 == 1) return null
        val bytes = ArrayList<Int>(text.length)
        var acc = 0
        var bits = 0
        for (ch in text) {
            val v = B64URL.indexOf(ch)
            if (v < 0) return null
            acc = (acc shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                bytes.add((acc ushr bits) and 0xff)
            }
        }
        return utf8Decode(bytes)
    }

    /** A hand-rolled UTF-8 decode: String(bytes, UTF_8) substitutes U+FFFD for malformed input
     *  and TextDecoder does something else again, so a shared fold cannot delegate. Overlong
     *  forms, surrogates and out-of-range scalars are refusals, not replacements. */
    private fun utf8Decode(bytes: List<Int>): String? {
        val out = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i]
            var cp: Int
            val extra: Int
            val min: Int
            when {
                b0 < 0x80 -> { cp = b0; extra = 0; min = 0 }
                b0 in 0xc2..0xdf -> { cp = b0 and 0x1f; extra = 1; min = 0x80 }
                b0 in 0xe0..0xef -> { cp = b0 and 0x0f; extra = 2; min = 0x800 }
                b0 in 0xf0..0xf4 -> { cp = b0 and 0x07; extra = 3; min = 0x10000 }
                else -> return null
            }
            if (i + extra >= bytes.size) return null
            for (k in 1..extra) {
                val b = bytes[i + k]
                if (b < 0x80 || b > 0xbf) return null
                cp = (cp shl 6) or (b and 0x3f)
            }
            if (cp < min || cp > 0x10ffff) return null
            if (cp in 0xd800..0xdfff) return null
            out.appendCodePoint(cp)
            i += extra + 1
        }
        return out.toString()
    }

    /** RFC 7636 §4.1 verbatim: 43*128 of ALPHA / DIGIT / "-" / "." / "_" / "~". No trimming, no
     *  case folding — a verifier is compared byte for byte at the token endpoint, so a fold
     *  that accepts what the server will not is a login that dies there with a useless
     *  message. */
    fun isCodeVerifier(value: String?): Boolean {
        val text = value ?: return false
        if (text.length < PKCE_VERIFIER_MIN_LENGTH || text.length > PKCE_VERIFIER_MAX_LENGTH) return false
        for (ch in text) {
            if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9') continue
            if (ch == '-' || ch == '.' || ch == '_' || ch == '~') continue
            return false
        }
        return true
    }

    /** A verifier from platform entropy, or null when there is not enough of it. Expressed as a
     *  refusal rather than a short value on purpose: a silently-padded verifier is a weak one
     *  that still works, which is the failure nobody finds. */
    fun codeVerifierFromEntropy(bytes: IntArray): String? =
        if (bytes.size < PKCE_VERIFIER_ENTROPY_BYTES) null else base64UrlNoPad(bytes)

    fun codeVerifierFromEntropy(bytes: ByteArray): String? =
        if (bytes.size < PKCE_VERIFIER_ENTROPY_BYTES) null else base64UrlNoPad(bytes)

    /** A `state` or `nonce` from platform entropy, or null when there is not enough of it. */
    fun opaqueProof(bytes: IntArray): String? =
        if (bytes.size < AUTH_PROOF_ENTROPY_BYTES) null else base64UrlNoPad(bytes)

    fun opaqueProof(bytes: ByteArray): String? =
        if (bytes.size < AUTH_PROOF_ENTROPY_BYTES) null else base64UrlNoPad(bytes)

    /** RFC 7636 §4.2: code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))). The
     *  digest arrives already computed, because hashing is the platform's. A digest of any
     *  other length is refused rather than encoded: a short one produces a challenge the server
     *  accepts and no verifier can ever satisfy, which strands every login on that build. */
    fun codeChallengeS256(digest: IntArray): String? =
        if (digest.size != 32) null else base64UrlNoPad(digest)

    fun codeChallengeS256(digest: ByteArray): String? =
        if (digest.size != 32) null else base64UrlNoPad(digest)

    /** Every proof comparison runs through here. No early return on the first differing byte
     *  and none on a length difference: both lengths and every position fold into one
     *  accumulator, so a wrong `state` costs the same time as a right one. */
    fun constantTimeEquals(a: String?, b: String?): Boolean {
        val left = a ?: ""
        val right = b ?: ""
        var diff = left.length xor right.length
        val span = if (left.length > right.length) left.length else right.length
        for (i in 0 until span) {
            val l = if (i < left.length) left[i].code else 0
            val r = if (i < right.length) right[i].code else 0
            diff = diff or (l xor r)
        }
        return diff == 0
    }

    // ── 3 · the proof plan — adopt what the caller wrote, mint what is missing ───────────

    private fun hexValue(ch: Char): Int = when (ch) {
        in '0'..'9' -> ch.code - 48
        in 'a'..'f' -> ch.code - 87
        in 'A'..'F' -> ch.code - 55
        else -> -1
    }

    private fun utf8Encode(text: String): List<Int> {
        val out = ArrayList<Int>(text.length)
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            when {
                cp < 0x80 -> out.add(cp)
                cp < 0x800 -> { out.add(0xc0 or (cp ushr 6)); out.add(0x80 or (cp and 0x3f)) }
                cp < 0x10000 -> {
                    out.add(0xe0 or (cp ushr 12)); out.add(0x80 or ((cp ushr 6) and 0x3f))
                    out.add(0x80 or (cp and 0x3f))
                }
                else -> {
                    out.add(0xf0 or (cp ushr 18)); out.add(0x80 or ((cp ushr 12) and 0x3f))
                    out.add(0x80 or ((cp ushr 6) and 0x3f)); out.add(0x80 or (cp and 0x3f))
                }
            }
            i += Character.charCount(cp)
        }
        return out
    }

    /** Percent-decode a query value the way a form-encoded query is read: `+` is a space, `%XX`
     *  is a byte, an incomplete escape is left literal rather than dropped. The authorization
     *  server echoes `state` back through this same encoding, so adopting it decoded is what
     *  makes the later comparison compare the same two things. */
    private fun decodeQueryValue(raw: String): String {
        val bytes = ArrayList<Int>(raw.length)
        var i = 0
        while (i < raw.length) {
            val ch = raw[i]
            if (ch == '+') { bytes.add(0x20); i += 1; continue }
            if (ch == '%' && i + 2 < raw.length) {
                val hi = hexValue(raw[i + 1])
                val lo = hexValue(raw[i + 2])
                if (hi >= 0 && lo >= 0) { bytes.add((hi shl 4) or lo); i += 3; continue }
            }
            val cp = raw.codePointAt(i)
            bytes.addAll(utf8Encode(String(Character.toChars(cp))))
            i += Character.charCount(cp)
        }
        return utf8Decode(bytes) ?: ""
    }

    /** The query string of a URL: everything between the first `?` and the first `#` after it. */
    private fun queryOf(url: String): String {
        val hash = url.indexOf('#')
        val stop = if (hash < 0) url.length else hash
        val q = url.indexOf('?')
        if (q < 0 || q > stop) return ""
        return url.substring(q + 1, stop)
    }

    /** The first value of `name` in a form-encoded query, decoded, or null. An empty value is
     *  null: `state=` is not a state, it is a caller who built the parameter and forgot the
     *  value. */
    private fun queryValue(query: String, name: String): String? {
        var i = 0
        while (i <= query.length) {
            var end = query.indexOf('&', i)
            if (end < 0) end = query.length
            val pair = query.substring(i, end)
            i = end + 1
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val key = decodeQueryValue(if (eq < 0) pair else pair.substring(0, eq))
            if (key != name) continue
            if (eq < 0) return null
            val value = decodeQueryValue(pair.substring(eq + 1))
            return value.ifEmpty { null }
        }
        return null
    }

    /** Does a space-separated `response_type` carry `token` as a whole token? */
    private fun responseTypeHas(responseType: String?, token: String): Boolean {
        if (responseType == null) return false
        return responseType.split(" ").any { it.lowercase() == token }
    }

    /** Which proofs this module owns for `authorizeUrl`.
     *
     *  A parameter already in the URL is ADOPTED — the caller built it, the module verifies
     *  what comes back — and one that is absent is MINTED. That is what makes this
     *  non-breaking: every integration shipped against the old contract keeps the exact
     *  authorize URL it built, plus a `state` it did not have to write.
     *
     *  `nonce` is owned only for an OIDC request (`scope` contains `openid`, or `response_type`
     *  contains `id_token`): minting one onto a plain OAuth request is noise, and RFC 9700 §2.1
     *  says PKCE carries the same protection.
     *
     *  PKCE is OPT-IN, and that is the load-bearing decision. A module-minted verifier is one
     *  the module must also redeem, so appending `code_challenge` to a flow whose token
     *  exchange the CALLER performs breaks that exchange at the authorization server — a worse
     *  failure than the one being fixed, and one that would land on every shipped integration
     *  at once. */
    fun planAuthorizeProofs(authorizeUrl: String?, wantsPkce: Boolean): AuthorizeProofPlan {
        val query = queryOf(authorizeUrl ?: "")
        val state = queryValue(query, "state")
        val nonce = queryValue(query, "nonce")
        val challenge = queryValue(query, "code_challenge")
        val responseType = queryValue(query, "response_type")
        val scope = queryValue(query, "scope")

        val isCodeFlow = responseTypeHas(responseType, "code")
        if (wantsPkce && (challenge != null || !isCodeFlow)) {
            return AuthorizeProofPlan(REFUSAL_PKCE_UNSUPPORTED, false, null, false, null, false)
        }

        val oidc = responseTypeHas(responseType, "id_token") ||
            (scope != null && scope.split(" ").any { it.lowercase() == "openid" })

        return AuthorizeProofPlan(
            refusal = null,
            mintState = state == null,
            adoptedState = state,
            mintNonce = oidc && nonce == null,
            adoptedNonce = nonce,
            mintPkce = wantsPkce,
        )
    }

    /** Percent-escape everything outside RFC 3986's unreserved set. Minted values are base64url
     *  and pass through untouched; the escaping exists so a value that came from somewhere else
     *  can never break out of its parameter. */
    private fun encodeQueryValue(value: String): String {
        val out = StringBuilder()
        for (b in utf8Encode(value)) {
            val ch = b.toChar()
            if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' ||
                ch == '-' || ch == '.' || ch == '_' || ch == '~'
            ) {
                out.append(ch)
            } else {
                out.append('%').append(b.toString(16).uppercase().padStart(2, '0'))
            }
        }
        return out.toString()
    }

    /** The authorize URL with the minted parameters appended, in a fixed order so three
     *  runtimes build the same string. Appending, never rewriting: the caller's URL is
     *  reproduced byte for byte. A fragment stays last, because a query appended after a
     *  fragment is not a query. */
    fun applyAuthorizeProofs(
        authorizeUrl: String?,
        state: String? = null,
        nonce: String? = null,
        challenge: String? = null,
    ): String {
        val url = authorizeUrl ?: ""
        val pairs = ArrayList<String>(4)
        if (!state.isNullOrEmpty()) pairs.add("state=" + encodeQueryValue(state))
        if (!nonce.isNullOrEmpty()) pairs.add("nonce=" + encodeQueryValue(nonce))
        if (!challenge.isNullOrEmpty()) {
            pairs.add("code_challenge=" + encodeQueryValue(challenge))
            pairs.add("code_challenge_method=$PKCE_CHALLENGE_METHOD")
        }
        if (pairs.isEmpty()) return url

        val hash = url.indexOf('#')
        val head = if (hash < 0) url else url.substring(0, hash)
        val tail = if (hash < 0) "" else url.substring(hash)
        val q = head.indexOf('?')
        val joiner = when {
            q < 0 -> "?"
            head.endsWith("?") || head.endsWith("&") -> ""
            else -> "&"
        }
        return head + joiner + pairs.joinToString("&") + tail
    }

    // ── 4 · the callback verdict — the only place a callback becomes deliverable ─────────

    /** The verdict a returning callback earns.
     *
     *  UNPROVEN is the compatibility floor and is deliberately permissive: a cold start after
     *  the process died behind the browser, or a deep link that is not a callback at all, has
     *  no armed expectation, and refusing there would break working logins to fix nothing.
     *
     *  REPLAYED exists because clearing the expectation on success is not enough. A one-shot
     *  authorization code replayed a second later would otherwise land in the UNPROVEN arm and
     *  be delivered, which is the exact attack `state` is there to stop. */
    fun verifyCallbackProofs(
        expectedState: String?,
        consumedStates: List<String>,
        receivedState: String?,
        expectedNonce: String? = null,
        idTokenNonce: String? = null,
    ): CallbackVerdict {
        val expected = expectedState?.takeIf { it.isNotEmpty() }
        val received = receivedState?.takeIf { it.isNotEmpty() }

        if (expected == null) {
            if (received != null) {
                for (seen in consumedStates) {
                    if (constantTimeEquals(seen, received)) return CallbackVerdict.REPLAYED
                }
            }
            return CallbackVerdict.UNPROVEN
        }
        if (received == null) return CallbackVerdict.MISSING_STATE
        if (!constantTimeEquals(expected, received)) return CallbackVerdict.STATE_MISMATCH

        val wantNonce = expectedNonce?.takeIf { it.isNotEmpty() } ?: return CallbackVerdict.OK
        // No id_token in this callback means the nonce rides the token exchange instead; an
        // id_token that carries no nonce claim at all, against an armed nonce, is the injection
        // this refuses.
        if (idTokenNonce == null) return CallbackVerdict.OK
        return if (constantTimeEquals(wantNonce, idTokenNonce)) CallbackVerdict.OK
        else CallbackVerdict.NONCE_MISMATCH
    }

    /** A JWT's middle segment, base64url-decoded to UTF-8, and nothing else. The signature is
     *  NOT checked and the result has exactly one use: REFUSING a callback whose nonce does not
     *  match. It never makes a token valid, and reading the claim out of the returned JSON is
     *  each renderer's own parser — which is why this stops at the decoded string. */
    fun idTokenPayload(jwt: String?): String? {
        val text = jwt ?: return null
        val first = text.indexOf('.')
        if (first < 0) return null
        val second = text.indexOf('.', first + 1)
        if (second < 0) return null
        if (text.indexOf('.', second + 1) >= 0) return null
        return base64UrlDecodeUtf8(text.substring(first + 1, second))
    }

    // ── 5 · the verifier release boundary ───────────────────────────────────────────────

    /** May a module-minted verifier be sent to this token endpoint?
     *
     *  The verifier is the one secret this core's consumer holds, and the token exchange is the
     *  only path that sends it anywhere. The destination is therefore not the caller's to
     *  choose freely: it must be an https origin the APP declared in config. An empty
     *  declaration allows nothing, so a build that never opted in cannot leak a verifier at
     *  all — the fail-closed direction, and the reason this is an allowlist rather than a shape
     *  check. */
    fun tokenEndpointAllowed(tokenUrl: String?, declaredOrigins: List<String>): Boolean {
        val target = splitOrigin(tokenUrl) ?: return false
        if (target.scheme != "https" || target.hasUserInfo) return false
        for (declared in declaredOrigins) {
            val origin = splitOrigin(declared) ?: continue
            if (origin.scheme != "https") continue
            if (origin.host == target.host && normalizedPort(origin) == normalizedPort(target)) return true
        }
        return false
    }
}
