//
//  DSXFilePaths.kt - the shared `files` core (:core, pure JVM): the root vocabulary, the
//  per-platform physical base each token maps to, path normalisation, and the containment
//  check that IS the sandbox. The law is the corpus,
//  OpenSource/Conformance/files/{paths,errors}.json (parity/F03-files.md). The twin of Swift
//  DSXFilePaths and the web @despia-native/kernel parseFilePath / filePathContains.
//
//  This is a SECURITY boundary, not a convenience. Markup never names an absolute path: it
//  names `root:relative`, and everything a facet may touch follows from what this file
//  returns. Two halves, and both matter:
//
//    * parse            - the TEXTUAL half. Trim, match the root EXACT CASE against the closed
//      five-word vocabulary, then normalise the relative part (`.` dropped, `..` popped, empty
//      segments collapsed) BEFORE testing for escape, because testing first is the classic
//      bypass. Percent escapes are never decoded into structure: a segment that decodes to a
//      dot segment or to a separator is refused outright.
//    * contains         - the PHYSICAL half, asked AFTER the OS has resolved symlinks on both
//      sides (File.canonicalFile). `/a/bc` is not inside `/a/b`; forgetting the separator
//      there is the bug every hand-rolled containment check ships at least once.
//
//  Everything platform-shaped lives OUTSIDE this file. The Files module turns a base token
//  into a real directory (filesDir / cacheDir / getExternalFilesDir / assets) and does the
//  I/O; keeping the DECISION separate from the PLUMBING is what lets one corpus judge three
//  renderers.
//
package despia.engine

object DSXFilePaths {

    /** The closed root vocabulary. A path is `root:relative`, and nothing else is addressable. */
    val ROOTS: List<String> = listOf("documents", "cache", "temp", "shared", "bundle")

    /** The action surface, shared so a fixture cannot name an action no renderer implements. */
    val ACTIONS: List<String> = listOf(
        "info", "read", "write", "delete", "move", "copy", "mkdir", "list",
        "download", "upload", "free", "hash", "zip", "unzip", "exclude",
    )

    /** The platforms the base table answers for. */
    val PLATFORMS: List<String> = listOf("ios", "android", "web")

    /** The physical base each root resolves to, as a platform TOKEN rather than a container
     *  path: the container path is a runtime value, the choice of directory is the decision,
     *  and the decision is what has to agree on three renderers. A null base is the typed
     *  absence - that platform has no such place, so the facet resolves `unsupported_platform`. */
    private val BASES: Map<String, Map<String, String?>> = mapOf(
        "documents" to mapOf("ios" to "Documents", "android" to "filesDir", "web" to "opfs"),
        "cache" to mapOf("ios" to "Caches", "android" to "cacheDir", "web" to "cacheStorage"),
        "temp" to mapOf("ios" to "tmp", "android" to "cacheDir/tmp", "web" to "memory"),
        "shared" to mapOf("ios" to "AppGroup", "android" to "externalFilesDir", "web" to null),
        "bundle" to mapOf("ios" to "Bundle", "android" to "assets", "web" to "origin"),
    )

    /** The read-only root. A write, mkdir, delete or move-to against it is `permission_denied`. */
    private val WRITABLE: Map<String, Boolean> = mapOf(
        "documents" to true, "cache" to true, "temp" to true, "shared" to true, "bundle" to false,
    )

    /** Every code the module settles with, and whether a retry is worth offering. Pinned by
     *  errors.json so `recoverable` cannot mean one thing on one renderer and another elsewhere. */
    val ERROR_RECOVERABLE: Map<String, Boolean> = mapOf(
        "not_found" to false,
        "permission_denied" to false,
        "no_space" to true,
        "is_directory" to false,
        "not_directory" to false,
        "exists" to true,
        "hash_mismatch" to true,
        "network_failed" to true,
        "http_error" to true,
        "unsupported_root" to false,
        "unsupported_platform" to false,
    )

    /** The typed-absence roster: capabilities a platform genuinely lacks, which resolve
     *  `unsupported_platform` with a real message rather than a silent no-op (durability P4). */
    val UNSUPPORTED: Map<String, List<String>> = mapOf(
        "ios" to emptyList(),
        "android" to listOf("exclude"),
        "web" to listOf("shared", "zip", "unzip", "exclude", "background"),
    )

    /** A path this module will not address - one condition with one code, whatever shape the
     *  attempt took, because a probing caller learns nothing from a finer distinction. */
    const val REFUSAL: String = "unsupported_root"

    /** A parsed document path: the root token, and the normalised relative path inside it
     *  (empty for the root itself). */
    data class Parsed(val root: String, val relative: String)

    /** Carries the refusal out of [parse] without allocating a stack trace per call. */
    class RefusalError : Exception(REFUSAL) {
        override fun fillInStackTrace(): Throwable = this
    }

    /**
     * Parse a `root:relative` document path.
     *
     * The root is matched exact-case against [ROOTS] - a case-insensitive vocabulary is a
     * vocabulary nobody can lint. The relative part is normalised, then tested for escape; a
     * `..` that stays inside the root is legal and folded away, a `..` that climbs out is
     * refused. A backslash, a colon, a control character, a `~` segment and any percent escape
     * that decodes to a dot segment or a separator are all refused: none of them can name
     * something inside the sandbox, and every one of them is somebody's traversal attempt.
     */
    fun parse(raw: String?): Result<Parsed> {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return Result.failure(RefusalError())

        val colon = text.indexOf(':')
        if (colon <= 0) return Result.failure(RefusalError())
        val root = text.substring(0, colon)
        if (root !in ROOTS) return Result.failure(RefusalError())

        val rest = text.substring(colon + 1)
        if (hasControlCharacter(rest)) return Result.failure(RefusalError())
        if (rest.contains('\\') || rest.contains(':')) return Result.failure(RefusalError())

        val stack = ArrayList<String>()
        for (segment in rest.split('/')) {
            if (segment.isEmpty() || segment == ".") continue
            if (segment == "..") {
                if (stack.isEmpty()) return Result.failure(RefusalError())
                stack.removeAt(stack.size - 1)
                continue
            }
            if (segment.startsWith("~")) return Result.failure(RefusalError())
            val decoded = decodeSegment(segment)
            if (decoded == "." || decoded == "..") return Result.failure(RefusalError())
            if (decoded.contains('/') || decoded.contains('\\')) return Result.failure(RefusalError())
            stack.add(segment)
        }
        return Result.success(Parsed(root, stack.joinToString("/")))
    }

    /** The physical base token for a root on a platform, or null when the platform has no such
     *  place (the typed absence). An unknown root or platform is also null. */
    fun base(root: String, platform: String): String? = BASES[root]?.get(platform)

    /** Whether a root accepts writes. An unknown root is not writable. */
    fun writable(root: String): Boolean = WRITABLE[root] == true

    /** Whether a platform lacks a capability outright (so it resolves `unsupported_platform`). */
    fun unsupported(platform: String, capability: String): Boolean =
        UNSUPPORTED[platform]?.contains(capability) == true

    /**
     * Is [candidate] inside [base]? Asked after the facet has canonicalised both sides, so a
     * symlink pointing out of the sandbox fails here instead of being followed.
     *
     * Both sides must be absolute. `/a/bc` is NOT inside `/a/b`: the separator is load-bearing,
     * and omitting it is the prefix bug. Comparison is byte-exact - on a case-insensitive
     * filesystem a mismatch means the OS resolved something we did not expect, which is
     * precisely when to refuse.
     */
    fun contains(base: String, candidate: String): Boolean {
        if (!base.startsWith("/") || !candidate.startsWith("/")) return false
        val root = normalizeAbsolute(base)
        val target = normalizeAbsolute(candidate)
        if (target == root) return true
        return if (root == "/") target.startsWith("/") else target.startsWith("$root/")
    }

    /** Collapse `.`, `..` and duplicate separators in an ABSOLUTE path. A `..` at the top stays
     *  at the top (POSIX `/..` is `/`). Keeps the leading `/`, drops any trailing one. */
    private fun normalizeAbsolute(path: String): String {
        val stack = ArrayList<String>()
        for (segment in path.split('/')) {
            if (segment.isEmpty() || segment == ".") continue
            if (segment == "..") {
                if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
                continue
            }
            stack.add(segment)
        }
        return "/" + stack.joinToString("/")
    }

    /** Percent-decode a single segment, tolerantly: a malformed escape stays literal. Used ONLY
     *  to ask whether a segment is hiding structure - the decoded form is never used as a name. */
    private fun decodeSegment(segment: String): String {
        if (!segment.contains('%')) return segment
        val out = StringBuilder(segment.length)
        var i = 0
        while (i < segment.length) {
            val ch = segment[i]
            if (ch == '%' && i + 2 < segment.length) {
                val hex = segment.substring(i + 1, i + 3)
                val value = hex.toIntOrNull(16)
                if (value != null && hex.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
                    out.append(value.toChar())
                    i += 3
                    continue
                }
            }
            out.append(ch)
            i += 1
        }
        return out.toString()
    }

    /**
     * `list`'s `glob` filter, matched against the path RELATIVE to the listed directory.
     *
     * A tiny, closed grammar on purpose: `*` matches any run of characters within one segment,
     * `?` matches one character within one segment, and a whole segment of `**` matches zero or
     * more segments. Brace expansion, character classes and negation are deliberately absent -
     * they are where every hand-rolled matcher starts disagreeing with every other, and a
     * listing filter needs none of them. Anchored (the whole relative path) and case-exact.
     */
    fun globMatch(pattern: String, path: String): Boolean =
        matchSegments(pattern.split('/'), path.split('/'), 0, 0)

    private fun matchSegments(pattern: List<String>, path: List<String>, p: Int, i: Int): Boolean {
        if (p == pattern.size) return i == path.size
        if (pattern[p] == "**") {
            for (skip in i..path.size) if (matchSegments(pattern, path, p + 1, skip)) return true
            return false
        }
        if (i == path.size) return false
        if (!matchSegment(pattern[p], path[i])) return false
        return matchSegments(pattern, path, p + 1, i + 1)
    }

    /** One segment against one segment: `*` is any run, `?` is one character, neither crosses `/`. */
    private fun matchSegment(pattern: String, segment: String): Boolean {
        var p = 0
        var s = 0
        var star = -1
        var mark = 0
        while (s < segment.length) {
            if (p < pattern.length && (pattern[p] == '?' || pattern[p] == segment[s])) {
                p += 1
                s += 1
            } else if (p < pattern.length && pattern[p] == '*') {
                star = p
                mark = s
                p += 1
            } else if (star >= 0) {
                p = star + 1
                mark += 1
                s = mark
            } else {
                return false
            }
        }
        while (p < pattern.length && pattern[p] == '*') p += 1
        return p == pattern.length
    }

    private fun hasControlCharacter(text: String): Boolean =
        text.any { it.code < 0x20 || it.code == 0x7f }
}
