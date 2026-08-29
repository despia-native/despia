//
//  ComposeCore.kt - the shared Core/Compose core (:core, pure JVM): the composer result
//  vocabulary and its fidelity ladder, the (empty) permission surface, the capability
//  disclosure, the recipient cap and the attachment rule. The law is the corpus,
//  OpenSource/Conformance/compose/result.json (parity F13). The twin of Swift ComposeCore and
//  the web @despia/kernel compose-core.ts.
//
//  dsx.module.compose.{sms,mail} PRESENT the system composer prefilled and NEVER SEND: the user
//  reads the message in their own messaging or mail app and taps send there. That is why no
//  permission is involved on any renderer, and why no SEND_SMS row exists anywhere.
//
package despia.engine

/** What a composer settled as, plus what it is honest to say about the body it rendered. */
data class ComposeOutcome(
    val result: String?,
    /** false when HTML was asked for and the composer degraded it; null when nothing degraded. */
    val isHtml: Boolean?,
    val error: String?,
)

/** What `capabilities` discloses. */
data class ComposeCapabilities(
    val sms: Boolean,
    val mail: Boolean,
    /** Present only where the platform discloses it: Android names the resolving package, iOS
     *  never does, and a browser cannot observe whether a handler exists at all. */
    val defaultMailClient: String?,
)

/** A refusal or a go-ahead, in the shape every compose action reports. */
data class ComposeDecision(val runs: Boolean, val error: String?, val message: String?)

object ComposeCore {

    /** Everything a composer may settle as. `saved` is a mail-draft outcome only. */
    val RESULTS: List<String> = listOf("sent", "cancelled", "saved", "failed", "unknown")

    /**
     * renderer -> action -> the results it can actually report.
     *
     * iOS MessageUI reports exactly what the user did; Android's ACTION_SENDTO has no result
     * callback at all and a browser's mailto: link has none either. `unknown` must never be
     * upgraded to `sent` because the intent launched: a caller that cannot trust `sent` has no
     * reason to read the field.
     */
    val RESULT_FIDELITY: Map<String, Map<String, List<String>>> = mapOf(
        "ios" to mapOf(
            "sms" to listOf("sent", "cancelled", "failed"),
            "mail" to listOf("sent", "saved", "cancelled", "failed"),
        ),
        "android" to mapOf("sms" to listOf("unknown"), "mail" to listOf("unknown")),
        "web" to mapOf("sms" to listOf("unknown"), "mail" to listOf("unknown")),
    )

    /** Every action on every renderer: none. This table is the contract. */
    val PERMISSION_SURFACE: Map<String, String> = mapOf(
        "sms" to "none",
        "mail" to "none",
        "capabilities" to "none",
    )

    /** An SMS permission appearing in the merged manifest is a build regression, not a feature. */
    val FORBIDDEN_PERMISSIONS: List<String> = listOf(
        "android.permission.SEND_SMS",
        "android.permission.READ_SMS",
        "android.permission.RECEIVE_SMS",
    )

    /** Renderers whose composer can render an HTML mail body. Everywhere else an `isHtml`
     *  request is served as plain text and SAYS SO, the `applied: false` convention rather than
     *  shipping markup as text. */
    private val HTML_CAPABLE: List<String> = listOf("ios")

    const val TOO_MANY_RECIPIENTS_MESSAGE: String = "Too many recipients for one message."
    const val ATTACHMENT_FAILED_MESSAGE: String =
        "An attachment could not be prepared for the composer."

    private val ALLOWED = ComposeDecision(runs = true, error = null, message = null)

    /**
     * The result ladder. A composer that reports gets its word through verbatim; one that cannot
     * report says `unknown`, which is a different answer from `no_composer` - the first means
     * the composer opened and this app will never learn what happened, the second means it
     * never opened.
     */
    fun outcome(
        renderer: String,
        composerResult: String? = null,
        launched: Boolean = true,
        isHtml: Boolean = false,
    ): ComposeOutcome {
        if (!launched) return ComposeOutcome(null, null, "no_composer")
        val degraded = if (isHtml && renderer !in HTML_CAPABLE) false else null
        return ComposeOutcome(composerResult ?: "unknown", degraded, null)
    }

    /** The Android resolver disambiguation activity resolves as the package `android`, which is
     *  not a real client: offering the button on the strength of it is the bug this filters. */
    fun resolverPackage(name: String?): String? {
        val text = name?.trim().orEmpty()
        return if (text.isEmpty() || text == "android") null else text
    }

    /** Ask before offering the button. A page can only promise that a composer may be
     *  ATTEMPTED. */
    fun capabilities(
        renderer: String,
        canText: Boolean = false,
        canMail: Boolean = false,
        smsResolver: String? = null,
        mailResolver: String? = null,
    ): ComposeCapabilities = when (renderer) {
        "web" -> ComposeCapabilities(sms = true, mail = true, defaultMailClient = null)
        "android" -> {
            val mail = resolverPackage(mailResolver)
            ComposeCapabilities(sms = resolverPackage(smsResolver) != null, mail = mail != null,
                                defaultMailClient = mail)
        }
        else -> ComposeCapabilities(sms = canText, mail = canMail, defaultMailClient = null)
    }

    /**
     * The recipient cap is config (`max_recipients`, default 100), because no platform constant
     * exists and clients truncate silently somewhere past a few dozen. A composer that opens
     * with half the list is worse than one that refuses. Mail counts to + cc + bcc together.
     */
    fun recipientDecision(count: Int, cap: Int): ComposeDecision =
        if (count > cap) ComposeDecision(false, "too_many_recipients", TOO_MANY_RECIPIENTS_MESSAGE)
        else ALLOWED

    /**
     * Local files only. A remote URL is not fetched on the caller's behalf and the web cannot
     * attach at all - a composer that opens quietly missing what the caller attached is worse
     * than one that refuses, so every failure is `attachment_failed`.
     */
    fun attachmentDecision(
        renderer: String,
        path: String?,
        insideRoots: Boolean? = null,
        exists: Boolean? = null,
    ): ComposeDecision {
        val refused = ComposeDecision(false, "attachment_failed", ATTACHMENT_FAILED_MESSAGE)
        if (renderer == "web") return refused
        val text = path?.trim().orEmpty()
        if (text.isEmpty()) return refused
        if (!text.startsWith("/") && !text.startsWith("file://")) return refused
        if (exists == false) return refused
        if (insideRoots == false) return refused
        return ALLOWED
    }
}
