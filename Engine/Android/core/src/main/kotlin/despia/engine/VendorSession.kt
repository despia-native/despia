//
//  VendorSession.kt - the inline-vendor-surface pure core (:core, pure JVM), Kotlin twin of
//  the web @despia/kernel vendor-session.ts and the Swift Engine/iOS/VendorSession.swift.
//  The law is the corpus: OpenSource/Conformance/inline-surfaces/stripe.json
//  (architecture/proposals/inline-native-surfaces.md, parity/V01-stripe-inline.md).
//
//  Four folds, one law each:
//    1. VendorSessionRef.resolve - THE SECRET BOUNDARY. A component attribute declared
//       role:"secret" carries a REFERENCE to a module-held session, never the session.
//       Markup travels over OTA into the content plane, so a literal here is a credential
//       on a CDN. The rule is an ALLOWLIST OF REFERENCE SHAPES, not a denylist of key
//       prefixes: a denylist is bypassed by whatever key format the vendor ships next
//       quarter, an allowlist fails closed. Credential detection only sharpens the
//       refusal MESSAGE; it never decides whether a value is accepted.
//    2. VendorSessionMachine - ONE SESSION, TWO VIEWS. The overlay face and the component
//       face are two views onto one state machine. Two machines that disagree is a DOUBLE
//       CHARGE, so a second attempt while one is in flight is refused, and every outcome
//       notifies both faces including one that already detached.
//    3. VendorCardField.fold - the vendor's per-part verdicts folded into ONE form field,
//       so a vendor input joins <form> validity through the same aggregation every other
//       field uses. It never carries card data - that is the PCI boundary.
//    4. VendorRetain - the keyed-identity law (SceneBind) applied to an expensive,
//       stateful vendor view: same key = same live view across any unrelated re-render.
//
//  PURE by construction: no Android, no Regex, no vendor SDK. Everything the Compose
//  renderer needs is a function of its arguments, which is what lets one corpus judge
//  three runtimes - and what lets the security rule be tested without a payment processor.
//
package despia.engine

// -----------------------------------------------------------------------------
// 1 - THE SECRET BOUNDARY
// -----------------------------------------------------------------------------

object VendorSessionRef {

    /** Which reference plane the attribute names. IMPLICIT = the attribute was omitted, so
     *  the component binds its owning module's CURRENT session (the canonical spelling). */
    enum class Kind { IMPLICIT, MODULE_CONTEXT, STORE_VAR, GLOBAL, CONFIG, ATTRIBUTE, SCOPE }

    /** Why a reference was refused. Every one is LOUD - a secret attribute that silently
     *  accepted a literal would ship the literal. */
    enum class Refusal { MISSING_REFERENCE, LITERAL_SECRET, LITERAL_VALUE, COMPOUND_TEMPLATE, UNKNOWN_REFERENCE }

    /** The credential family a refusal names, so the message can say WHICH secret leaked. */
    enum class Family { SECRET_KEY, RESTRICTED_KEY, CLIENT_SECRET, WEBHOOK_SECRET, EPHEMERAL_KEY, PUBLISHABLE_KEY, JWT }

    data class Ref(val kind: Kind, val path: String)

    /** The stable machine ids the corpus pins and the linter reports. */
    fun code(kind: Kind): String = when (kind) {
        Kind.IMPLICIT -> "implicit"
        Kind.MODULE_CONTEXT -> "module-context"
        Kind.STORE_VAR -> "store-var"
        Kind.GLOBAL -> "global"
        Kind.CONFIG -> "config"
        Kind.ATTRIBUTE -> "attribute"
        Kind.SCOPE -> "scope"
    }

    fun code(refusal: Refusal): String = when (refusal) {
        Refusal.MISSING_REFERENCE -> "missing_reference"
        Refusal.LITERAL_SECRET -> "literal_secret"
        Refusal.LITERAL_VALUE -> "literal_value"
        Refusal.COMPOUND_TEMPLATE -> "compound_template"
        Refusal.UNKNOWN_REFERENCE -> "unknown_reference"
    }

    fun code(family: Family): String = when (family) {
        Family.SECRET_KEY -> "secret_key"
        Family.RESTRICTED_KEY -> "restricted_key"
        Family.CLIENT_SECRET -> "client_secret"
        Family.WEBHOOK_SECRET -> "webhook_secret"
        Family.EPHEMERAL_KEY -> "ephemeral_key"
        Family.PUBLISHABLE_KEY -> "publishable_key"
        Family.JWT -> "jwt"
    }

    /** Carries a [Refusal] (and the family that sharpens its message) out of [resolve]. */
    class RefusalError(val refusal: Refusal, val family: Family? = null) : Exception(code(refusal)) {
        override fun fillInStackTrace(): Throwable = this
    }

    /** The transitional alias: `.state.` and `.context.` are ONE plane. */
    private val CONTEXT_PLANES = listOf("context", "state")

    private fun isWordChar(ch: Char): Boolean =
        (ch in '0'..'9') || (ch in 'A'..'Z') || (ch in 'a'..'z') || ch == '_'

    private fun isIdentStart(ch: Char): Boolean =
        (ch in 'A'..'Z') || (ch in 'a'..'z') || ch == '_' || ch == '$'

    private fun isIdentChar(ch: Char): Boolean = isIdentStart(ch) || (ch in '0'..'9')

    /** A token of [prefix] + at least [minTail] token characters, not glued to a word on
     *  the left. Hand-scanned rather than a Regex so all three runtimes agree character for
     *  character (a `\b` is not the same thing in three regex engines). */
    private fun hasKeyToken(text: String, prefix: String, minTail: Int): Boolean {
        var i = 0
        while (i + prefix.length <= text.length) {
            if (text.startsWith(prefix, i) && (i == 0 || !isWordChar(text[i - 1]))) {
                var j = i + prefix.length
                var tail = 0
                while (j < text.length && isWordChar(text[j])) { tail += 1; j += 1 }
                if (tail >= minTail) return true
            }
            i += 1
        }
        return false
    }

    /** `pi_..._secret_...` / `seti_..._secret_...` / `cs_..._secret_...` - the client
     *  secret, which is the one people paste into markup because it is "not the secret key". */
    private fun hasClientSecret(text: String): Boolean {
        val marker = "_secret_"
        var i = 0
        while (i + marker.length <= text.length) {
            if (text.startsWith(marker, i)) {
                val after = i + marker.length
                if (after < text.length && isWordChar(text[after])) {
                    var start = i
                    while (start > 0 && isWordChar(text[start - 1])) start -= 1
                    val head = text.substring(start, i)
                    if (head.startsWith("pi_") || head.startsWith("seti_") ||
                        head.startsWith("cs_") || head.startsWith("src_")
                    ) return true
                }
            }
            i += 1
        }
        return false
    }

    /** `eyJ...` with exactly two dots and three non-trivial segments: a JWT, which is what a
     *  Stream user token and a Clerk session token both are. Already REFUSED without this (it
     *  parses as a dotted path with an unpermitted root), so this only sharpens the message
     *  from "unknown_reference" to naming the credential the author pasted. */
    private fun hasJwt(text: String): Boolean {
        if (!text.startsWith("eyJ")) return false
        var dots = 0
        var run = 0
        for (ch in text) {
            if (ch == '.') {
                if (run < 8) return false
                dots += 1
                run = 0
                continue
            }
            if (!isWordChar(ch) && ch != '-') return false
            run += 1
        }
        return dots == 2 && run >= 8
    }

    /** The credential family in [text], MOST DANGEROUS FIRST - the order the message uses. */
    fun secretFamilyIn(text: String): Family? = when {
        hasKeyToken(text, "sk_", 8) -> Family.SECRET_KEY
        hasKeyToken(text, "rk_", 8) -> Family.RESTRICTED_KEY
        hasClientSecret(text) -> Family.CLIENT_SECRET
        hasKeyToken(text, "whsec_", 8) -> Family.WEBHOOK_SECRET
        hasKeyToken(text, "ek_", 8) -> Family.EPHEMERAL_KEY
        hasKeyToken(text, "pk_", 8) -> Family.PUBLISHABLE_KEY
        hasJwt(text) -> Family.JWT
        else -> null
    }

    private fun splitPath(expression: String): List<String>? {
        if (expression.isEmpty()) return null
        val parts = expression.split(".")
        for (part in parts) {
            if (part.isEmpty() || !isIdentStart(part[0])) return null
            for (ch in part) if (!isIdentChar(ch)) return null
        }
        return parts
    }

    /** The ALLOWLIST. A permitted reference is one of these shapes and nothing else. */
    private fun referenceKind(segments: List<String>): Ref? {
        if (segments.size >= 5 && segments[0] == "dsx" && segments[1] == "module") {
            for (i in 3..segments.size - 2) {
                if (segments[i] !in CONTEXT_PLANES) continue
                val chain = segments.subList(2, i).joinToString(".")
                val member = segments.subList(i + 1, segments.size).joinToString(".")
                return Ref(Kind.MODULE_CONTEXT, "dsx.module.$chain.context.$member")
            }
            return null
        }
        val path = segments.joinToString(".")
        if (segments[0] == "dsx" && segments.size >= 3) {
            when (segments[1]) {
                "variable" -> return Ref(Kind.STORE_VAR, path)
                "global" -> return Ref(Kind.GLOBAL, path)
                "config" -> return Ref(Kind.CONFIG, path)
                "attribute" -> return Ref(Kind.ATTRIBUTE, path)
                "this" -> return Ref(Kind.SCOPE, path)
            }
        }
        if (segments[0] == "item" && segments.size >= 2) return Ref(Kind.SCOPE, path)
        return null
    }

    /**
     * Resolve what a `role: "secret"` attribute carries.
     *
     * `null` (the attribute omitted) is the CANONICAL spelling: the component binds its
     * owning module's current session, so the markup names no session at all. A present
     * value must be exactly one reference - bare, or a single whole-value interpolation.
     */
    fun resolve(raw: String?): Result<Ref> {
        if (raw == null) return Result.success(Ref(Kind.IMPLICIT, ""))
        val text = raw.trim()
        if (text.isEmpty()) return Result.failure(RefusalError(Refusal.MISSING_REFERENCE))

        var expression = text
        val open = text.indexOf("{{")
        if (open >= 0) {
            val close = text.indexOf("}}")
            val single = open == 0 && close == text.length - 2 && close > open &&
                text.indexOf("{{", open + 2) < 0 && text.indexOf("}}", open + 2) == close
            if (!single) {
                val family = secretFamilyIn(text)
                return Result.failure(
                    if (family == null) RefusalError(Refusal.COMPOUND_TEMPLATE)
                    else RefusalError(Refusal.LITERAL_SECRET, family)
                )
            }
            expression = text.substring(2, close).trim()
            if (expression.isEmpty()) return Result.failure(RefusalError(Refusal.MISSING_REFERENCE))
        }

        val segments = splitPath(expression)
        if (segments != null) {
            val ref = referenceKind(segments)
            if (ref != null) return Result.success(ref)
        }

        val family = secretFamilyIn(expression)
        if (family != null) return Result.failure(RefusalError(Refusal.LITERAL_SECRET, family))
        return Result.failure(
            RefusalError(if (segments != null) Refusal.UNKNOWN_REFERENCE else Refusal.LITERAL_VALUE)
        )
    }
}

// -----------------------------------------------------------------------------
// 2 - ONE SESSION, TWO VIEWS
// -----------------------------------------------------------------------------

/** The two faces a capability with a UI exposes. Canonical order - every notify audience
 *  is emitted in it, so an audience cannot mean one thing on one renderer. */
val VENDOR_VIEWS: List<String> = listOf("overlay", "inline")

enum class VendorSessionState { IDLE, READY, CONFIRMING, SUCCEEDED, FAILED, CANCELED }

enum class VendorStepRefusal { ALREADY_OPEN, NOT_READY, BUSY, SETTLED, NOT_CONFIRMING, DETACHED_VIEW }

/**
 * The module's session, seen by both faces.
 *
 * The action face presents the vendor modal OVER this session; the component face renders
 * the vendor view INTO the layout for the same session. Starting with one and finishing
 * with the other is coherent because there is only this object.
 */
class VendorSessionMachine {

    data class Step(
        val op: String,
        val view: String? = null,
        val code: String? = null,
    )

    data class StepResult(
        val ok: Boolean,
        val state: String,
        val notify: List<String> = emptyList(),
        val attempts: Int = 0,
        val outcome: String? = null,
        val by: String? = null,
        val code: String? = null,
        val error: String? = null,
    )

    private var current: VendorSessionState = VendorSessionState.IDLE
    private val attachedViews = ArrayList<String>()
    private var confirmingBy: String? = null
    private var attemptCount = 0

    val state: String get() = stateCode(current)
    val attempts: Int get() = attemptCount
    val confirmingView: String? get() = confirmingBy
    val attached: List<String> get() = VENDOR_VIEWS.filter { it in attachedViews }

    /** Attached faces plus the in-flight originator, canonically ordered. A face that
     *  unmounted mid-confirm is STILL owed its outcome - dropping it is how an app charges
     *  a card and never tells the user. */
    private fun audience(): List<String> {
        val live = HashSet(attachedViews)
        confirmingBy?.let { live.add(it) }
        return VENDOR_VIEWS.filter { it in live }
    }

    private fun settled(): Boolean =
        current == VendorSessionState.SUCCEEDED || current == VendorSessionState.CANCELED

    private fun no(refusal: VendorStepRefusal) =
        StepResult(ok = false, state = stateCode(current), error = refusalCode(refusal))

    fun step(step: Step): StepResult = when (step.op) {
        "open" -> {
            if (current != VendorSessionState.IDLE) {
                no(if (settled()) VendorStepRefusal.SETTLED else VendorStepRefusal.ALREADY_OPEN)
            } else {
                current = VendorSessionState.READY
                StepResult(true, state, audience(), attemptCount)
            }
        }

        "attach" -> {
            val view = requireNotNull(step.view) { "attach names no view" }
            if (view !in attachedViews) attachedViews.add(view)
            StepResult(true, state, emptyList(), attemptCount)
        }

        // Detaching NEVER cancels. A vendor view that unmounts on an unrelated re-render
        // must not abandon an authorization in flight.
        "detach" -> {
            attachedViews.remove(requireNotNull(step.view) { "detach names no view" })
            StepResult(true, state, emptyList(), attemptCount)
        }

        "start" -> {
            val view = requireNotNull(step.view) { "start names no view" }
            when {
                current == VendorSessionState.IDLE -> no(VendorStepRefusal.NOT_READY)
                settled() -> no(VendorStepRefusal.SETTLED)
                current == VendorSessionState.CONFIRMING -> no(VendorStepRefusal.BUSY)
                view !in attachedViews -> no(VendorStepRefusal.DETACHED_VIEW)
                else -> {
                    current = VendorSessionState.CONFIRMING
                    confirmingBy = view
                    attemptCount += 1
                    StepResult(true, state, audience(), attemptCount, by = view)
                }
            }
        }

        "complete", "fail" -> {
            if (current != VendorSessionState.CONFIRMING) {
                no(if (settled()) VendorStepRefusal.SETTLED else VendorStepRefusal.NOT_CONFIRMING)
            } else {
                val by = confirmingBy
                val told = audience()
                confirmingBy = null
                val succeeded = step.op == "complete"
                current = if (succeeded) VendorSessionState.SUCCEEDED else VendorSessionState.FAILED
                StepResult(
                    true, state, told, attemptCount,
                    outcome = if (succeeded) "succeeded" else "failed",
                    by = by,
                    code = if (succeeded) null else (step.code ?: "card_declined"),
                )
            }
        }

        // Dismissing the sheet cancels the ATTEMPT, not the session: the intent stays
        // reusable, which is what the vendor SDK actually does. Cancelling with nothing in
        // flight abandons the session, and that IS terminal.
        "cancel" -> when {
            settled() -> no(VendorStepRefusal.SETTLED)
            current == VendorSessionState.IDLE -> no(VendorStepRefusal.NOT_READY)
            current == VendorSessionState.CONFIRMING -> {
                val by = confirmingBy
                val told = audience()
                confirmingBy = null
                current = VendorSessionState.READY
                StepResult(true, state, told, attemptCount, outcome = "canceled", by = by)
            }
            else -> {
                val told = audience()
                current = VendorSessionState.CANCELED
                StepResult(true, state, told, attemptCount, outcome = "canceled", by = step.view)
            }
        }

        else -> error("unknown vendor session op ${step.op}")
    }

    companion object {
        fun stateCode(state: VendorSessionState): String = when (state) {
            VendorSessionState.IDLE -> "idle"
            VendorSessionState.READY -> "ready"
            VendorSessionState.CONFIRMING -> "confirming"
            VendorSessionState.SUCCEEDED -> "succeeded"
            VendorSessionState.FAILED -> "failed"
            VendorSessionState.CANCELED -> "canceled"
        }

        fun refusalCode(refusal: VendorStepRefusal): String = when (refusal) {
            VendorStepRefusal.ALREADY_OPEN -> "already_open"
            VendorStepRefusal.NOT_READY -> "not_ready"
            VendorStepRefusal.BUSY -> "busy"
            VendorStepRefusal.SETTLED -> "settled"
            VendorStepRefusal.NOT_CONFIRMING -> "not_confirming"
            VendorStepRefusal.DETACHED_VIEW -> "detached_view"
        }
    }
}

// -----------------------------------------------------------------------------
// 3 - THE FIELD-VALIDITY FOLD
// -----------------------------------------------------------------------------

object VendorCardField {

    /** Canonical part order: the order the vendor's own field traverses, and the order the
     *  fold reports the FIRST offender in. */
    val PARTS: List<String> = listOf("number", "expiry", "cvc", "postalCode")

    /** The incomplete messages, one per part. Data, so three runtimes cannot word them
     *  differently; pinned in the corpus. */
    val INCOMPLETE_MESSAGES: Map<String, String> = linkedMapOf(
        "number" to "Your card number is incomplete.",
        "expiry" to "Your card's expiration date is incomplete.",
        "cvc" to "Your card's security code is incomplete.",
        "postalCode" to "Your postal code is incomplete.",
    )

    const val REQUIRED_MESSAGE: String = "Required"

    /** One part as the VENDOR reports it. [error] is the vendor's own message and is
     *  carried through verbatim - re-wording it is the text twin of relabelling its a11y
     *  tree. */
    data class PartState(
        val part: String,
        val empty: Boolean = true,
        val complete: Boolean = false,
        val error: String = "",
    )

    data class Fold(
        val complete: Boolean,
        val valid: Boolean,
        val pristine: Boolean,
        val error: String,
        val offender: String,
        /** what a form aggregates - never card data: "complete" or "". THE PCI BOUNDARY. */
        val value: String,
    )

    /** The forms core's FormFieldState, so a vendor input rides the SAME aggregation as
     *  `<field>` - one validity system, not two. */
    data class FormField(
        val name: String,
        val value: String,
        val initial: String,
        val validate: String,
        val message: String,
    )

    /**
     * Fold the vendor's per-part verdicts into ONE form field.
     *
     * Precedence: a vendor ERROR beats an incomplete part (the vendor knows "4242...4241
     * is not a card"; the fold only knows "not finished"), and within each tier the first
     * part in canonical order owns the message. A pristine, non-required field is valid
     * and silent - a card form that shouts before it is touched is the bug users report
     * as "broken".
     */
    fun fold(parts: List<PartState>, required: Boolean = true): Fold {
        val byName = parts.associateBy { it.part }
        val declared = PARTS.filter { byName.containsKey(it) }

        val pristine = declared.isNotEmpty() && declared.all { byName.getValue(it).empty }
        val complete = declared.isNotEmpty() && declared.all { byName.getValue(it).complete }

        for (part in declared) {
            val message = byName.getValue(part).error
            if (message.isNotEmpty()) {
                return Fold(complete, false, pristine, message, part, "")
            }
        }
        if (complete) return Fold(true, true, false, "", "", "complete")
        if (pristine) {
            return if (required) Fold(false, false, true, REQUIRED_MESSAGE, declared.firstOrNull() ?: "", "")
            else Fold(false, true, true, "", "", "")
        }
        for (part in declared) {
            if (!byName.getValue(part).complete) {
                return Fold(false, false, false, INCOMPLETE_MESSAGES[part] ?: REQUIRED_MESSAGE, part, "")
            }
        }
        return Fold(complete, false, pristine, REQUIRED_MESSAGE, declared.firstOrNull() ?: "", "")
    }

    fun formField(name: String, fold: Fold): FormField = FormField(
        name = name,
        value = fold.value,
        initial = "",
        validate = if (fold.error.isEmpty()) "" else "required",
        message = fold.error,
    )
}

// -----------------------------------------------------------------------------
// 4 - KEYED IDENTITY
// -----------------------------------------------------------------------------

object VendorRetain {

    data class Diff(val mounted: List<String>, val retained: List<String>, val released: List<String>)

    /**
     * The identity a vendor view is retained under.
     *
     * An explicit `key=` wins outright, so an author can keep one live field across a list
     * reorder. Without one the identity is tag + session + position: two
     * `<stripe.CardInput/>` on the same session are distinguishable, and the same one at
     * the same position across an unrelated re-render is the SAME view. The key is never
     * the session VALUE - that would put a secret in a diff log.
     */
    fun key(tag: String, key: String? = null, session: String? = null, index: Int = 0): String {
        val explicit = key?.trim().orEmpty()
        if (explicit.isNotEmpty()) return "$tag#$explicit"
        return "$tag@${session?.trim().orEmpty()}[$index]"
    }

    /** A key present on both sides keeps its live vendor view across ANY reorder; a new key
     *  mounts; a vanished key releases. Pure - the caller owns the actual views. This is
     *  deliberately the SceneBind verdict shape, because it is the same law. */
    fun reconcile(previous: List<String>, next: List<String>): Diff {
        val before = previous.toSet()
        val now = next.toSet()
        val mounted = ArrayList<String>()
        val retained = ArrayList<String>()
        val released = ArrayList<String>()
        val seen = HashSet<String>()
        for (key in next) {
            if (!seen.add(key)) continue
            if (key in before) retained.add(key) else mounted.add(key)
        }
        for (key in previous) if (key !in now && key !in released) released.add(key)
        return Diff(mounted, retained, released)
    }
}
