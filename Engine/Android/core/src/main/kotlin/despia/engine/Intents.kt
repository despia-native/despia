//
//  Intents.kt — the Kotlin twin of Engine/iOS/Intents.swift and the web kernel's intents.ts:
//  the SHARED PURE CORE behind Core/Intents (F17.6).
//
//  WHY A CORE FOR AN ANDROID-ONLY CAPABILITY. Two reasons. First, the OTHER TWO RENDERERS HAVE
//  TO REFUSE PRECISELY: a caller writing one code path needs `launch({ action: "nonsense" })`
//  to fail the same way everywhere. Second, and more important, the `<queries>` GENERATOR is
//  build-time logic: Android 11 package visibility means an intent for a component the manifest
//  never declared resolves to nothing, and computing that block from the module's own
//  declarations is the difference between the feature working and it appearing to work in
//  development and failing on every real device.
//
//  THE FLAG NUMBERS ARE PINNED HERE, not read from android.content.Intent, so :core's SDK-free
//  test lane can assert them. They are ABI-frozen constants: changing one would break every APK
//  ever shipped, so hardcoding is safe the way hardcoding a Unicode code point is safe.
//
//  Pure JVM — no Android imports. Pinned by OpenSource/Conformance/intents/launch.json.
//
package despia.engine

object Intents {

    /** Word -> the ABI-frozen `Intent` flag bit. */
    val FLAGS: Map<String, Int> = mapOf(
        "newTask" to 0x10000000,
        "singleTop" to 0x20000000,
        "clearTop" to 0x04000000,
        "clearTask" to 0x00008000,
        "newDocument" to 0x00080000,
        "noHistory" to 0x40000000,
        "excludeFromRecents" to 0x00800000,
        "grantReadUri" to 0x00000001,
        "grantWriteUri" to 0x00000002,
    )

    /** The canonical order a resolved flag list comes back in, so two equal requests compare equal. */
    val FLAG_ORDER: List<String> = listOf(
        "newTask", "singleTop", "clearTop", "clearTask", "newDocument",
        "noHistory", "excludeFromRecents", "grantReadUri", "grantWriteUri",
    )

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_action" to
            "That is not an intent action. Use a dotted constant like android.intent.action.VIEW.",
        "invalid_data" to "That is not a URI an intent can carry.",
        "invalid_type" to "That is not a MIME type.",
        "invalid_extras" to "Intent extras are scalars or arrays of scalars.",
        "invalid_package" to "That is not an Android package name.",
        "unknown_flag" to "That is not an intent flag this module knows.",
    )

    class RefusalError(val code: String, val detail: String?) : Exception(code)

    private fun <T> refuse(code: String, detail: String? = null): Result<T> =
        Result.failure(RefusalError(code, detail))

    fun code(error: Throwable): String = (error as? RefusalError)?.code ?: "invalid_action"

    fun detail(error: Throwable): String {
        val d = (error as? RefusalError)?.detail
        if (!d.isNullOrEmpty()) return d
        return MESSAGES[code(error)] ?: code(error)
    }

    data class Flags(val mask: Int, val words: List<String>)

    data class Spec(
        val action: String,
        val pkg: String,
        val data: String,
        val type: String,
        val categories: List<String>,
        val extras: Map<String, Any?>,
        val flags: Flags,
    )

    /** One row of the `<queries>` block a module's manifest facet must declare. */
    data class Query(
        val kind: String,
        val action: String,
        val scheme: String,
        val mimeType: String,
        val name: String,
    )

    private fun foldKey(raw: Any?): String =
        (raw?.toString() ?: "").lowercase().filter { !it.isWhitespace() && it != '-' && it != '_' }

    private fun isIdentChar(c: Char): Boolean =
        (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || c == '.' || c == '_'

    /**
     * An intent action is a dotted constant name. A BARE WORD IS REFUSED even though
     * `Intent("VIEW")` compiles: it resolves to nothing at runtime and the developer sees an
     * empty chooser with no error, which is the most common way an intent launcher wastes an
     * afternoon.
     */
    fun normalizeAction(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return refuse("invalid_action", "an action is required")
        if (!text.contains(".")) {
            return refuse("invalid_action", "an action is a dotted constant, e.g. android.intent.action.VIEW")
        }
        if (text.any { !isIdentChar(it) }) return refuse("invalid_action", text)
        if (text.startsWith(".") || text.endsWith(".")) return refuse("invalid_action", text)
        return Result.success(text)
    }

    /** A package name is a dotted identifier chain. A wrong one produces an empty result rather
     *  than an error, so it is checked here. */
    fun normalizePackage(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return Result.success("")
        if (!text.contains(".")) return refuse("invalid_package", "a package name is dotted")
        if (text.any { !isIdentChar(it) }) return refuse("invalid_package", text)
        if (text.startsWith(".") || text.endsWith(".")) return refuse("invalid_package", text)
        return Result.success(text)
    }

    /** The URI an intent carries. Only the SCHEME is validated: `package:`, `content:`, `tel:`
     *  and a vendor's own are all legitimate, and a stricter rule would refuse working intents. */
    fun normalizeData(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim()
        if (text.isEmpty()) return Result.success("")
        val colon = text.indexOf(':')
        if (colon <= 0) return refuse("invalid_data", "intent data is a URI")
        val scheme = text.substring(0, colon)
        val first = scheme[0]
        if (!((first in 'a'..'z') || (first in 'A'..'Z'))) return refuse("invalid_data", text)
        for (c in scheme) {
            val ok = (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') ||
                c == '+' || c == '.' || c == '-'
            if (!ok) return refuse("invalid_data", text)
        }
        if (text.any { it.isWhitespace() }) return refuse("invalid_data", text)
        return Result.success(text)
    }

    /** A MIME type, lowercased. `*` is legal on either half. */
    fun normalizeType(raw: Any?): Result<String> {
        val text = (raw?.toString() ?: "").trim().lowercase()
        if (text.isEmpty()) return Result.success("")
        val slash = text.indexOf('/')
        if (slash <= 0 || slash == text.length - 1) {
            return refuse("invalid_type", "a MIME type is type/subtype")
        }
        if (text.indexOf('/', slash + 1) >= 0) return refuse("invalid_type", text)
        for (c in text) {
            val ok = (c in 'a'..'z') || (c in '0'..'9') ||
                c == '/' || c == '*' || c == '.' || c == '-' || c == '+'
            if (!ok) return refuse("invalid_type", text)
        }
        return Result.success(text)
    }

    /**
     * Extras are SCALARS or homogeneous scalar arrays, and nothing else. Android's Bundle can
     * carry a Parcelable graph; the DSX bus cannot, and a nested object would have to be
     * serialised by a rule each renderer invented. Refusing is the honest answer.
     */
    fun normalizeExtras(raw: Any?): Result<Map<String, Any?>> {
        if (raw == null) return Result.success(emptyMap())
        val map = raw as? Map<*, *> ?: return refuse("invalid_extras", "extras is an object of scalars")
        val out = LinkedHashMap<String, Any?>()
        for ((rawKey, value) in map) {
            val key = rawKey?.toString() ?: ""
            if (key.trim().isEmpty()) return refuse("invalid_extras", "an extra needs a name")
            if (value == null) continue
            if (value is List<*>) {
                for (entry in value) {
                    if (!(entry is String || entry is Number || entry is Boolean)) {
                        return refuse("invalid_extras", "$key: an array extra holds scalars")
                    }
                }
                out[key] = value
                continue
            }
            if (!(value is String || value is Number || value is Boolean)) {
                return refuse("invalid_extras", "$key: encode a structured extra as a string yourself")
            }
            out[key] = value
        }
        return Result.success(out)
    }

    /** Fold flag words into the bitmask and canonical word list. An unknown flag is refused
     *  rather than dropped: a dropped `newTask` fails only when launched from a service. */
    fun foldFlags(raw: Any?): Result<Flags> {
        val list: List<Any?> = when {
            raw is List<*> -> raw
            raw is String && raw.isNotEmpty() -> raw.split(",")
            else -> emptyList()
        }
        val seen = HashSet<String>()
        for (entry in list) {
            val key = foldKey(entry)
            val match = FLAG_ORDER.firstOrNull { foldKey(it) == key }
                ?: return refuse("unknown_flag", entry?.toString() ?: "")
            seen.add(match)
        }
        val words = FLAG_ORDER.filter { seen.contains(it) }
        var mask = 0
        for (word in words) mask = mask or (FLAGS[word] ?: 0)
        return Result.success(Flags(mask, words))
    }

    fun normalize(raw: Map<String, Any?>): Result<Spec> {
        val action = normalizeAction(raw["action"]).getOrElse { e -> return Result.failure(e) }
        val pkg = normalizePackage(raw["package"]).getOrElse { e -> return Result.failure(e) }
        val data = normalizeData(raw["data"]).getOrElse { e -> return Result.failure(e) }
        val type = normalizeType(raw["type"]).getOrElse { e -> return Result.failure(e) }
        val extras = normalizeExtras(raw["extras"]).getOrElse { e -> return Result.failure(e) }
        val flags = foldFlags(raw["flags"]).getOrElse { e -> return Result.failure(e) }

        val rawCategories: List<Any?> = when (val c = raw["categories"]) {
            is List<*> -> c
            is String -> if (c.isEmpty()) emptyList() else c.split(",")
            else -> emptyList()
        }
        val categories = ArrayList<String>(rawCategories.size)
        for (entry in rawCategories) {
            // Same grammar as an action: a dotted constant name.
            val one = normalizeAction(entry).getOrElse { return refuse("invalid_action", entry?.toString() ?: "") }
            if (!categories.contains(one)) categories.add(one)
        }

        return Result.success(Spec(action, pkg, data, type, categories, extras, flags))
    }

    /**
     * Derive the `<queries>` rows a set of declared intents needs.
     *
     * ANDROID 11 PACKAGE VISIBILITY is the reason this exists. An app can no longer see which
     * other apps are installed unless its manifest says which it is looking for, and an intent
     * for an undeclared component does not error: resolveActivity returns null and
     * startActivity throws ActivityNotFound. The failure looks exactly like "no app can handle
     * this", so a developer spends an afternoon before discovering it is a manifest problem.
     */
    fun queries(specs: List<Spec>): List<Query> {
        val rows = ArrayList<Query>()
        val seen = HashSet<String>()
        fun add(row: Query) {
            val key = "${row.kind}|${row.action}|${row.scheme}|${row.mimeType}|${row.name}"
            if (seen.contains(key)) return
            seen.add(key)
            rows.add(row)
        }

        for (spec in specs) {
            if (spec.pkg.isNotEmpty()) {
                add(Query("package", "", "", "", spec.pkg))
                continue
            }
            var scheme = ""
            if (spec.data.isNotEmpty()) {
                val colon = spec.data.indexOf(':')
                if (colon > 0) scheme = spec.data.substring(0, colon).lowercase()
            }
            add(Query("intent", spec.action, scheme, spec.type, ""))
        }

        // Sorted so the emitted manifest fragment is byte-stable across runs: a generator whose
        // output depends on declaration order makes every unrelated diff noisy.
        return rows.sortedBy { "${it.kind}|${it.name}|${it.action}|${it.scheme}|${it.mimeType}" }
    }
}
