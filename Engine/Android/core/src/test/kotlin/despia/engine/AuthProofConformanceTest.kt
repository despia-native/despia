package despia.engine

import java.io.File
import java.security.MessageDigest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The authentication-proof conformance runner - executes
 * OpenSource/Conformance/auth/{trigger,pkce}.json through THIS runtime's AuthProof folds
 * (completeness/A1-auth-hardening.md). The TS twin (@despia/kernel auth-proof.ts) and the Swift
 * reference (Engine/iOS/AuthProof.swift via AuthProofConformance.swift) run the SAME files, so a
 * login trigger cannot pin an origin on one renderer and accept a lookalike host on another, and
 * a callback cannot be refused on one and resolved on another.
 *
 * Missing corpus = loud failure. A silently-skipped conformance suite is how drift starts, and
 * the drift here is an account takeover.
 *
 * The S256 rows are checked TWICE: this runner hashes the corpus verifier with MessageDigest and
 * asserts it reproduces the recorded digest before encoding it, so the corpus cannot quietly
 * carry a wrong hash and have all three runners agree with it.
 */
class AuthProofConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/auth/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/auth/$name not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String, key: String): Map<String, Any?> =
        root(name)[key] as? Map<String, Any?> ?: error("$name: no $key section")

    @Suppress("UNCHECKED_CAST")
    private fun cases(section: Map<String, Any?>): List<Map<String, Any?>> {
        val rows = section["cases"] as? List<Map<String, Any?>> ?: error("no cases[]")
        assertTrue(rows.isNotEmpty(), "a corpus section must not be empty")
        return rows
    }

    private fun ints(any: Any?): IntArray {
        @Suppress("UNCHECKED_CAST")
        val list = any as? List<Any?> ?: error("expected a byte list")
        return IntArray(list.size) { (list[it] as Number).toInt() }
    }

    private fun strings(any: Any?): List<String> {
        @Suppress("UNCHECKED_CAST")
        val list = any as? List<Any?> ?: return emptyList()
        return list.map { it as String }
    }

    // -- 1 - the trigger fold ------------------------------------------------------------

    @Test
    fun configuredLoginTriggerPinsItsOrigin() {
        for (row in cases(section("trigger.json", "matchesConfiguredTrigger"))) {
            val name = row["name"] as? String ?: "<unnamed>"
            assertEquals(
                row["expect"] as Boolean,
                AuthProof.matchesConfiguredTrigger(row["candidate"] as? String, row["prefix"] as? String),
                name,
            )
        }
    }

    @Test
    fun onlyHttpsAuthorizationStartsReachABrowser() {
        for (row in cases(section("trigger.json", "isAllowedAuthorizationUrl"))) {
            val name = row["name"] as? String ?: "<unnamed>"
            assertEquals(
                row["expect"] as Boolean,
                AuthProof.isAllowedAuthorizationUrl(row["url"] as? String),
                name,
            )
        }
    }

    @Test
    fun theSubdomainHazardIsRefusedForEveryProviderSpelling() {
        // The whole point of the fold, asserted independently of the corpus rows so a corpus
        // edit cannot delete the hazard it exists for.
        for (origin in listOf("https://accounts.google.com", "https://login.microsoftonline.com")) {
            for (prefix in listOf(origin, "$origin/oauth2/authorize")) {
                assertFalse(AuthProof.matchesConfiguredTrigger("$origin.attacker.invalid/login", prefix),
                            "$prefix: lookalike host")
                assertFalse(AuthProof.matchesConfiguredTrigger("$origin@evil.tld/login", prefix),
                            "$prefix: userinfo")
            }
            assertFalse(AuthProof.matchesConfiguredTrigger("$origin:8443/login", origin), "$origin: port")
        }
    }

    // -- 2 - the verifier ABNF, the alphabet, the entropy floors -------------------------

    @Test
    fun codeVerifierAbnfIsRfc7636Verbatim() {
        val section = section("pkce.json", "verifier")
        assertEquals(AuthProof.PKCE_VERIFIER_MIN_LENGTH, (section["minLength"] as Number).toInt())
        assertEquals(AuthProof.PKCE_VERIFIER_MAX_LENGTH, (section["maxLength"] as Number).toInt())
        for (ch in section["unreserved"] as String) {
            assertTrue(AuthProof.isCodeVerifier(ch.toString().repeat(AuthProof.PKCE_VERIFIER_MIN_LENGTH)),
                       "unreserved $ch")
        }
        for (row in cases(section)) {
            assertEquals(row["expect"] as Boolean, AuthProof.isCodeVerifier(row["value"] as? String),
                         row["name"] as? String ?: "<unnamed>")
        }
    }

    @Test
    fun base64UrlDropsItsPadding() {
        for (row in cases(section("pkce.json", "base64url"))) {
            assertEquals(row["expect"] as String, AuthProof.base64UrlNoPad(ints(row["bytes"])),
                         row["name"] as? String ?: "<unnamed>")
        }
    }

    @Test
    fun entropyFloorsAreRefusalsNotSilentShortValues() {
        val section = section("pkce.json", "mint")
        assertEquals(AuthProof.PKCE_VERIFIER_ENTROPY_BYTES, (section["verifierEntropyBytes"] as Number).toInt())
        assertEquals(AuthProof.AUTH_PROOF_ENTROPY_BYTES, (section["proofEntropyBytes"] as Number).toInt())
        for (row in cases(section)) {
            val bytes = ints(row["bytes"])
            val got = if (row["fold"] == "codeVerifierFromEntropy") AuthProof.codeVerifierFromEntropy(bytes)
                      else AuthProof.opaqueProof(bytes)
            assertEquals(row["expect"] as? String, got, row["name"] as? String ?: "<unnamed>")
        }
        val minted = AuthProof.codeVerifierFromEntropy(IntArray(AuthProof.PKCE_VERIFIER_ENTROPY_BYTES) { 0xff })
        assertNotNull(minted)
        assertTrue(AuthProof.isCodeVerifier(minted))
    }

    // -- 3 - the S256 challenge, checked against a real hash -----------------------------

    @Test
    fun codeChallengeIsBase64UrlOfTheSha256OfTheVerifier() {
        val section = section("pkce.json", "challenge")
        assertEquals("S256", section["method"])
        for (row in cases(section)) {
            val name = row["name"] as? String ?: "<unnamed>"
            val verifier = row["verifier"] as String
            val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
            assertEquals(row["sha256Hex"] as String, digest.joinToString("") { "%02x".format(it) },
                         "$name: the corpus digest is not SHA-256 of the verifier")
            assertEquals(row["expect"] as String, AuthProof.codeChallengeS256(digest), name)
            assertFalse((row["expect"] as String).contains("="), "a challenge never carries padding")
        }
        @Suppress("UNCHECKED_CAST")
        val refusals = section["lengthRefusals"] as List<Map<String, Any?>>
        for (row in refusals) {
            val length = (row["length"] as Number).toInt()
            assertEquals(null, AuthProof.codeChallengeS256(IntArray(length)),
                         row["name"] as? String ?: "<unnamed>")
        }
    }

    // -- 4 - the proof plan and the URL it builds ----------------------------------------

    @Test
    fun proofPlanAdoptsWhatTheCallerWroteAndMintsWhatIsMissing() {
        val section = section("pkce.json", "plan")
        val declared = strings(section["refusals"]).toSet()
        for (row in cases(section)) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val plan = AuthProof.planAuthorizeProofs(row["url"] as? String, row["wantsPkce"] as Boolean)
            if (expect.containsKey("refusal")) {
                val refusal = expect["refusal"] as String
                assertTrue(declared.contains(refusal), "undeclared refusal $refusal")
                assertEquals(refusal, plan.refusal, "$name: refusal")
                assertFalse(plan.mintPkce, "$name: a refused plan mints nothing")
                assertFalse(plan.mintState, "$name: a refused plan mints nothing")
                continue
            }
            assertEquals(null, plan.refusal, "$name: refusal")
            assertEquals(expect["mintState"] as Boolean, plan.mintState, "$name: mintState")
            assertEquals(expect["adoptedState"] as? String, plan.adoptedState, "$name: adoptedState")
            assertEquals(expect["mintNonce"] as Boolean, plan.mintNonce, "$name: mintNonce")
            assertEquals(expect["mintPkce"] as Boolean, plan.mintPkce, "$name: mintPkce")
            if (expect.containsKey("adoptedNonce")) {
                assertEquals(expect["adoptedNonce"] as? String, plan.adoptedNonce, "$name: adoptedNonce")
            }
        }
    }

    @Test
    fun mintedProofsAreAppendedNeverRewritten() {
        for (row in cases(section("pkce.json", "apply"))) {
            @Suppress("UNCHECKED_CAST")
            val minted = row["minted"] as Map<String, Any?>
            assertEquals(
                row["expect"] as String,
                AuthProof.applyAuthorizeProofs(
                    row["url"] as? String,
                    minted["state"] as? String,
                    minted["nonce"] as? String,
                    minted["challenge"] as? String,
                ),
                row["name"] as? String ?: "<unnamed>",
            )
        }
    }

    @Test
    fun anAppliedPlanCarriesS256AndLeavesAnAdoptedStateAlone() {
        // The two halves of DONE-WHEN 6, asserted end to end rather than through a corpus row.
        val url = "https://idp.example/authorize?response_type=code&scope=openid&client_id=abc"
        val plan = AuthProof.planAuthorizeProofs(url, true)
        assertEquals(null, plan.refusal)
        val final = AuthProof.applyAuthorizeProofs(
            url,
            if (plan.mintState) "STATE" else null,
            if (plan.mintNonce) "NONCE" else null,
            if (plan.mintPkce) "CHAL" else null,
        )
        assertTrue(final.contains("code_challenge=CHAL"))
        assertTrue(final.contains("code_challenge_method=S256"))
        assertTrue(final.contains("state=STATE"))
        assertTrue(final.contains("nonce=NONCE"))

        val adopted = AuthProof.planAuthorizeProofs("$url&state=mine", false)
        assertEquals("mine", adopted.adoptedState)
        assertEquals("$url&state=mine", AuthProof.applyAuthorizeProofs("$url&state=mine"))
    }

    // -- 5 - the callback verdict --------------------------------------------------------

    @Test
    fun aCallbackIsDeliveredOnlyOnAVerdictThatPermitsIt() {
        val section = section("pkce.json", "verify")
        val declared = strings(section["verdicts"]).toSet()
        for (row in cases(section)) {
            val name = row["name"] as? String ?: "<unnamed>"
            val verdict = AuthProof.verifyCallbackProofs(
                row["expected"] as? String,
                strings(row["consumed"]),
                row["received"] as? String,
                row["expectedNonce"] as? String,
                row["idTokenNonce"] as? String,
            )
            val expect = row["expect"] as String
            assertTrue(declared.contains(expect), "undeclared verdict $expect")
            assertEquals(expect, verdict.id, name)
        }
    }

    @Test
    fun constantTimeEqualityAnswersTheCorpus() {
        for (row in cases(section("pkce.json", "constantTime"))) {
            assertEquals(row["expect"] as Boolean,
                         AuthProof.constantTimeEquals(row["a"] as? String, row["b"] as? String),
                         row["name"] as? String ?: "<unnamed>")
        }
    }

    @Test
    fun idTokenPayloadReadStopsAtTheDecodedString() {
        for (row in cases(section("pkce.json", "idToken"))) {
            assertEquals(row["expect"] as? String, AuthProof.idTokenPayload(row["jwt"] as? String),
                         row["name"] as? String ?: "<unnamed>")
        }
    }

    @Test
    fun aVerifierIsReleasedOnlyToADeclaredHttpsTokenEndpoint() {
        for (row in cases(section("pkce.json", "tokenEndpoint"))) {
            assertEquals(row["expect"] as Boolean,
                         AuthProof.tokenEndpointAllowed(row["url"] as? String, strings(row["declared"])),
                         row["name"] as? String ?: "<unnamed>")
        }
    }
}
