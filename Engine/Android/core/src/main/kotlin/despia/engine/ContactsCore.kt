//
//  ContactsCore.kt - the shared Core/Contacts core (:core, pure JVM): the permission surface,
//  the paging arithmetic, the read/write access decisions, the label vocabulary and the picker
//  fold. The law is the corpus, OpenSource/Conformance/contacts/{crud,pick}.json (parity F12).
//  The twin of Swift ContactsCore and the web @despia/kernel contacts-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: CNContactStore, ContactsContract and
//  navigator.contacts are per-renderer plumbing. What is pinned here is the part that must be
//  IDENTICAL on all three - how far a page reaches, what a grant permits, what a label is
//  called, and what the picker hands back.
//
package despia.engine

/** A refusal or a go-ahead, in the shape every action reports. */
data class ContactsDecision(
    val runs: Boolean,
    /** The access word to report alongside a successful read: "granted" or "limited". */
    val access: String?,
    val error: String?,
    val message: String?,
    val recoverable: Boolean,
    /** Always false: no action in this module prompts on the caller's behalf. */
    val prompted: Boolean = false,
)

/** What `pick` settles with. */
data class ContactPickOutcome(
    val contacts: List<Map<String, Any?>>,
    val cancelled: Boolean,
    /** Always false: the system picker needs no grant and must never raise one. */
    val prompted: Boolean,
    /** false when the caller asked for multi-select and the platform has none; null otherwise. */
    val multiple: Boolean?,
    val error: String?,
)

/** What one `list` page reports. */
data class ContactPage(val returned: Int, val hasNextPage: Boolean, val endCursor: String?)

object ContactsCore {

    /** The shared label vocabulary. A platform constant folds into one of these five. */
    val LABELS: List<String> = listOf("home", "work", "mobile", "main", "other")

    /** A contact with no name at all still needs something to render. */
    const val UNNAMED: String = "Unnamed Contact"

    /** One page may never fetch the world, and may never be unbounded. */
    const val MAX_PAGE: Int = 500

    /**
     * Which grant each action requires before it will run.
     *
     * `none` is the CONTRACT, not an implementation detail: an action listed as `none` that
     * starts prompting is a regression, and an action listed as read/write that stops refusing
     * is a privacy bug. `pick` is `none` on every renderer because the user hand-picks and the
     * OS returns only what was picked.
     */
    val PERMISSION_SURFACE: Map<String, String> = mapOf(
        "pick" to "none",
        "permission" to "none",
        "list" to "read",
        "get" to "read",
        "groups" to "read",
        "add" to "write",
        "update" to "write",
        "remove" to "write",
        "read" to "read",
    )

    /** The refusal messages. A caller that cannot find the fix retries the same call forever, so
     *  each one names the specific escalation that would work. */
    const val READ_REFUSAL: String =
        "Contacts access has not been granted. Call dsx.module.contacts.permission with level " +
            "\"read\" first, or use dsx.module.contacts.pick, which needs no permission."
    const val WRITE_REFUSAL: String =
        "Writing contacts has not been granted. Call dsx.module.contacts.permission with level " +
            "\"write\" first."
    const val RESTRICTED_MESSAGE: String = "Contacts access is restricted on this device."
    const val INVALID_MESSAGE: String =
        "A contact needs at least one of displayName, givenName, familyName, phones or emails."

    private fun allow(access: String) =
        ContactsDecision(runs = true, access = access, error = null, message = null, recoverable = true)

    private fun refuse(error: String, message: String, recoverable: Boolean) =
        ContactsDecision(runs = false, access = null, error = error, message = message,
                         recoverable = recoverable)

    /** A limit past the cap clamps rather than fetching the world; zero or negative clamps to 1,
     *  never to unbounded. */
    fun clampLimit(requested: Int?, fallback: Int): Int =
        (requested ?: fallback).coerceAtLeast(1).coerceAtMost(MAX_PAGE)

    /**
     * The paging arithmetic - the same on all three renderers even though the underlying cursor
     * is not (an enumeration offset on iOS, a SQL LIMIT/OFFSET on Android).
     *
     * `endCursor` is present only when there IS a next page, so a caller that loops until the
     * cursor is absent terminates instead of asking for an empty page forever.
     */
    fun page(total: Int, limit: Int?, offset: Int): ContactPage {
        val size = clampLimit(limit, MAX_PAGE)
        val start = offset.coerceAtLeast(0)
        val returned = (total - start).coerceAtMost(size).coerceAtLeast(0)
        return collectedPage(start, returned, start + returned < total)
    }

    /** The same page, reported by a store that ENUMERATED rather than counted: neither
     *  CNContactStore nor a content-provider query knows the total, but both learn whether one
     *  more row exists. [page] is defined in terms of this, so the corpus judges the code the
     *  modules call. */
    fun collectedPage(offset: Int, returned: Int, sawMore: Boolean): ContactPage {
        val start = offset.coerceAtLeast(0)
        val count = returned.coerceAtLeast(0)
        return ContactPage(count, sawMore, if (sawMore) (start + count).toString() else null)
    }

    /**
     * Can a read run, and what does it report?
     *
     * `limited` (iOS 17+ limited contact access) is a REAL GRANT over a shared subset, not a
     * soft denial: the read runs and reports access:"limited" rather than pretending it
     * enumerated the book. `restricted` is a device-policy denial and is NOT recoverable by
     * asking again.
     */
    fun readDecision(access: String?): ContactsDecision = when (access?.trim()) {
        "granted" -> allow("granted")
        "limited" -> allow("limited")
        "restricted" -> refuse("restricted", RESTRICTED_MESSAGE, false)
        else -> refuse("permission_denied", READ_REFUSAL, true)
    }

    /** How many rows a read may see: the whole book on a full grant, the shared subset on a
     *  limited one, and nothing at all when the read did not run. */
    fun readCount(access: String?, shared: Int, total: Int): Int {
        val decision = readDecision(access)
        if (!decision.runs) return 0
        return if (decision.access == "limited") shared.coerceAtLeast(0) else total.coerceAtLeast(0)
    }

    /** At least one of these makes a contact worth saving; an empty object is refused before any
     *  store call. */
    fun isMeaningful(contact: Map<String, Any?>?): Boolean {
        if (contact == null) return false
        for (key in listOf("displayName", "givenName", "familyName")) {
            val value = contact[key]
            if (value is String && value.trim().isNotEmpty()) return true
        }
        for (key in listOf("phones", "emails")) {
            val value = contact[key]
            if (value is List<*> && value.isNotEmpty()) return true
        }
        return false
    }

    /**
     * Can a write run?
     *
     * A limited read grant carries NO write right, and the refusal names the WRITE level
     * specifically - a caller told to ask for "read" again would loop. Validity is checked after
     * permission, so an unauthorised caller never learns whether its payload was well-formed.
     */
    fun writeDecision(access: String?, contact: Map<String, Any?>? = null,
                      validate: Boolean = contact != null): ContactsDecision {
        val word = access?.trim()
        if (word == "restricted") return refuse("restricted", RESTRICTED_MESSAGE, false)
        if (word != "granted") return refuse("permission_denied", WRITE_REFUSAL, true)
        if (validate && !isMeaningful(contact)) return refuse("invalid_contact", INVALID_MESSAGE, true)
        return allow("granted")
    }

    // A NORMAL string, not a raw one: Kotlin expands `$_` as a template even inside """…""",
    // so the raw spelling of this pattern does not compile. `\\\$` is one escaped regex dollar.
    private val APPLE_LABEL = Regex("^_\\\$!<(.+)>!\\\$_\$")

    /** A platform label to the shared vocabulary. Apple wraps its constants as `_$!<Word>!$_`;
     *  Android hands over its own word already. Anything unrecognised is `other`. */
    fun normalizeLabel(raw: String?): String {
        var text = raw?.trim().orEmpty()
        APPLE_LABEL.find(text)?.let { text = it.groupValues[1] }
        return when (text.lowercase()) {
            "home" -> "home"
            "work" -> "work"
            "mobile", "iphone", "cell" -> "mobile"
            "main" -> "main"
            else -> "other"
        }
    }

    /** A birthday is an ISO date, never a locale string. */
    fun birthday(year: Int?, month: Int?, day: Int?): String? {
        if (year == null || month == null || day == null) return null
        return "%04d-%02d-%02d".format(year, month, day)
    }

    /** A nameless contact still has a display name. [formatted] is the platform's own full-name
     *  rendering where it has one; the given/family join is the fallback. */
    fun displayName(givenName: String?, familyName: String?, formatted: String? = null): String {
        val platform = formatted?.trim().orEmpty()
        if (platform.isNotEmpty()) return platform
        val joined = "${givenName?.trim().orEmpty()} ${familyName?.trim().orEmpty()}".trim()
        return if (joined.isEmpty()) UNNAMED else joined
    }

    /** `fields` subsets the hydrated shape and drops nothing else in: `id` always survives, and
     *  the requested fields keep the order the caller asked for. */
    fun subset(contact: Map<String, Any?>, fields: List<String>?): Map<String, Any?> {
        if (fields.isNullOrEmpty()) return LinkedHashMap(contact)
        val out = LinkedHashMap<String, Any?>()
        if (contact.containsKey("id")) out["id"] = contact["id"]
        for (field in fields) {
            if (field != "id" && contact.containsKey(field)) out[field] = contact[field]
        }
        return out
    }

    /**
     * The picker fold.
     *
     * A dismissal RESOLVES cancelled - the user declining is an outcome the caller branches on,
     * not an error it should log. A platform with no multi-select SAYS SO (multiple:false)
     * rather than quietly returning a one-element array, and a browser with no Contact Picker
     * API refuses in type rather than resolving an empty list.
     */
    fun pickOutcome(
        multiple: Boolean = false,
        fields: List<String>? = null,
        picked: List<Map<String, Any?>>? = null,
        multiSelect: Boolean? = null,
        pickerAvailable: Boolean? = null,
    ): ContactPickOutcome {
        if (pickerAvailable == false) {
            return ContactPickOutcome(emptyList(), cancelled = false, prompted = false,
                                      multiple = null, error = "unsupported_platform")
        }
        val degraded = if (multiple && multiSelect == false) false else null
        if (picked == null) {
            return ContactPickOutcome(emptyList(), cancelled = true, prompted = false,
                                      multiple = degraded, error = null)
        }
        return ContactPickOutcome(picked.map { subset(it, fields) }, cancelled = false,
                                  prompted = false, multiple = degraded, error = null)
    }
}
