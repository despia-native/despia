//
//  Spotlight.kt — the Kotlin twin of Engine/iOS/Spotlight.swift and the web kernel's
//  spotlight.ts: the SHARED PURE CORE behind Core/Spotlight (F17.7).
//
//  THE ROUND TRIP IS THE PRODUCT. Indexing content into the system search field is only half
//  the feature; the half that matters is the TAP, which arrives as an opaque identifier the app
//  must turn back into a route. Core Spotlight calls that `uniqueIdentifier`, AppSearch calls it
//  a namespaced document id, and if each platform invented its own encoding then a deep link
//  that worked on iOS would 404 on Android. So the encoding lives here and `Mandatory/PushRouting`
//  receives the same route either way.
//
//  THE BATCH SIZE IS ALSO SHARED, not a platform detail: both indexers degrade badly on a
//  single huge transaction (Core Spotlight silently drops the tail, AppSearch throws), so an app
//  indexing 5,000 notes at first launch must chunk — identically, for one progress bar and one
//  resumable cursor.
//
//  Pure JVM — no Android imports. Pinned by OpenSource/Conformance/spotlight/index.json.
//
package despia.engine

object Spotlight {

    /** Both indexers degrade on a single huge transaction. 100 is the chunk both handle. */
    const val BATCH_MAX = 100

    const val MAX_ID_CHARS = 256
    const val MAX_TITLE_CHARS = 256
    const val MAX_DESCRIPTION_CHARS = 2000

    /** Beyond this, keyword matching gets worse rather than better on both platforms. */
    const val MAX_KEYWORDS = 32

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_id" to "That is not a usable item id.",
        "invalid_title" to "Every indexed item needs a title the OS can show.",
        "invalid_route" to "Every indexed item needs the absolute route its tap opens.",
        "invalid_domain" to "That is not a usable index domain.",
        "too_many_items" to "That is more items than one call can index.",
    )

    class RefusalError(val code: String, val detail: String?) : Exception(code)

    private fun <T> refuse(code: String, detail: String? = null): Result<T> =
        Result.failure(RefusalError(code, detail))

    fun code(error: Throwable): String = (error as? RefusalError)?.code ?: "invalid_id"

    fun detail(error: Throwable): String {
        val d = (error as? RefusalError)?.detail
        if (!d.isNullOrEmpty()) return d
        return MESSAGES[code(error)] ?: code(error)
    }

    data class Item(
        val id: String,
        val title: String,
        val description: String,
        val keywords: List<String>,
        val image: String,
        val route: String,
        val domain: String,
        val expires: Long,
    )

    private fun hasControlCharacter(text: String): Boolean =
        text.any { it.code < 0x20 || it.code == 0x7f }

    /**
     * A domain groups items so `clear({ domain })` removes a whole feature's index at once.
     * It may not contain a colon, and that is load-bearing: the unique identifier is
     * `<domain>:<id>` split at the FIRST colon, which is what lets an id contain colons freely
     * (a URL, a compound key) while the round trip stays exact.
     */
    fun normalizeDomain(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return Result.success("default")
        if (text.contains(":")) {
            return refuse("invalid_domain", "a domain cannot contain a colon; it is the separator")
        }
        if (text.length > 64) return refuse("invalid_domain", "a domain is at most 64 characters")
        if (hasControlCharacter(text)) {
            return refuse("invalid_domain", "a domain holds no control characters")
        }
        return Result.success(text)
    }

    /** `<domain>:<id>`. The one encoding both platforms use, so a tap resolves the same route. */
    fun uniqueId(domain: String, id: String): String = "$domain:$id"

    /** The inverse. Split at the FIRST colon, so an id containing colons round-trips exactly. */
    fun parseUniqueId(raw: Any?): Pair<String, String>? {
        val text = (raw?.toString() ?: "").trim()
        val colon = text.indexOf(':')
        if (colon <= 0 || colon == text.length - 1) return null
        return Pair(text.substring(0, colon), text.substring(colon + 1))
    }

    /** Trimmed, lowercased, deduped and capped. Case folding matters: both indexers match
     *  case-insensitively, so keeping "Recipe" and "recipe" spends the cap on nothing. */
    fun normalizeKeywords(raw: Any?): List<String> {
        val list: List<Any?> = when {
            raw is List<*> -> raw
            raw is String && raw.isNotEmpty() -> raw.split(",")
            else -> emptyList()
        }
        val out = ArrayList<String>()
        for (entry in list) {
            val word = (entry?.toString() ?: "").trim().lowercase()
            if (word.isEmpty() || out.contains(word)) continue
            out.add(word)
            if (out.size >= MAX_KEYWORDS) break
        }
        return out
    }

    /**
     * Validate and normalize one indexable item.
     *
     * THE ROUTE IS REQUIRED AND MUST BE ABSOLUTE. An indexed item with no route is worse than no
     * item at all: it appears in the OS search field, the user taps it, and the app opens on its
     * home screen with no explanation. Refusing at index time is the only place that failure can
     * still be fixed.
     */
    fun normalizeItem(raw: Map<String, Any?>): Result<Item> {
        val id = (raw["id"]?.toString() ?: "").trim()
        if (id.isEmpty()) return refuse("invalid_id", "an item needs an id")
        if (id.length > MAX_ID_CHARS) {
            return refuse("invalid_id", "an id is at most $MAX_ID_CHARS characters")
        }
        if (hasControlCharacter(id)) return refuse("invalid_id", "an id holds no control characters")

        val title = (raw["title"]?.toString() ?: "").trim()
        if (title.isEmpty()) return refuse("invalid_title", "an item needs a title to show")
        if (title.length > MAX_TITLE_CHARS) {
            return refuse("invalid_title", "a title is at most $MAX_TITLE_CHARS characters")
        }

        val domain = normalizeDomain(raw["domain"]).getOrElse { e -> return Result.failure(e) }

        val route = (raw["route"]?.toString() ?: "").trim()
        if (route.isEmpty()) {
            return refuse("invalid_route", "an indexed item needs the route its tap opens")
        }
        if (!route.startsWith("/")) return refuse("invalid_route", "a route is absolute, starting with /")
        if (hasControlCharacter(route)) {
            return refuse("invalid_route", "a route holds no control characters")
        }

        val description = (raw["description"]?.toString() ?: "").trim().take(MAX_DESCRIPTION_CHARS)
        val image = (raw["image"]?.toString() ?: "").trim()

        // A malformed or negative expiry means "no expiry" rather than an error: an item that
        // refuses to index because a timestamp was malformed is a worse outcome than one that
        // simply never expires.
        var expires = 0L
        val rawExpires = raw["expires"]
        if (rawExpires != null) {
            val n = when (rawExpires) {
                is Number -> rawExpires.toDouble()
                is String -> rawExpires.trim().toDoubleOrNull() ?: 0.0
                else -> 0.0
            }
            if (n.isFinite() && n > 0.0) expires = Math.floor(n).toLong()
        }

        return Result.success(
            Item(id, title, description, normalizeKeywords(raw["keywords"]), image, route, domain, expires),
        )
    }

    /** Validate a whole batch, refusing on the FIRST bad item with its index in the detail: a
     *  partial index is the hardest state to reason about, so the batch is all-or-nothing. */
    @Suppress("UNCHECKED_CAST")
    fun normalizeItems(raw: Any?): Result<List<Item>> {
        val list = raw as? List<Any?> ?: emptyList<Any?>()
        val out = ArrayList<Item>(list.size)
        for (i in list.indices) {
            val row = list[i] as? Map<String, Any?> ?: emptyMap()
            val one = normalizeItem(row)
            val item = one.getOrElse { e ->
                return refuse(code(e), "item $i: ${detail(e)}")
            }
            out.add(item)
        }
        return Result.success(out)
    }

    /** Split a batch into transactions both indexers handle reliably. */
    fun <T> chunk(items: List<T>, max: Int = BATCH_MAX): List<List<T>> {
        val size = if (max > 0) max else BATCH_MAX
        val out = ArrayList<List<T>>()
        var i = 0
        while (i < items.size) {
            out.add(items.subList(i, minOf(i + size, items.size)))
            i += size
        }
        return out
    }
}
