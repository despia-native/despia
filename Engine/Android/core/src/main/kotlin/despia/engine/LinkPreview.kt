//
//  LinkPreview.kt — the Kotlin twin of Engine/iOS/LinkPreview.swift and the web kernel's
//  linkpreview.ts: the SHARED PURE CORE behind Core/Preview (F17.1).
//
//  Four decisions live here because every hand-written OG scraper answers them differently:
//  which URLs are fetchable, how a reference resolves against the document that carried it,
//  which tag wins per field, and the fetch budget. The law is the corpus
//  (OpenSource/Conformance/preview/metadata.json, run here by LinkPreviewConformanceTest).
//
//  NO java.net.URI. It disagrees with Foundation.URL and the WHATWG parser on empty paths,
//  uppercase hosts, backslashes and userinfo. A preview that resolves to a different origin
//  on one renderer is the exact bug this core exists to prevent, so the parser is longhand.
//
//  Pure JVM — no Android imports, so it runs in :core's SDK-free test lane. The fetch itself
//  is platform plumbing and lives in the module's kotlin/ facet.
//
package despia.engine

object LinkPreview {

    /** A single response ceiling. An unbounded read of an attacker-chosen URL is a
     *  memory-exhaustion primitive, and the head is all a preview ever needs. */
    const val MAX_BYTES = 262144

    const val MAX_REDIRECTS = 5
    const val DEFAULT_TIMEOUT_MS = 8000
    const val MIN_TIMEOUT_MS = 1000
    const val MAX_TIMEOUT_MS = 30000

    /** Why a URL was refused before a single byte moved. */
    enum class Refusal(val code: String) {
        INVALID_URL("invalid_url"),
        UNSUPPORTED_SCHEME("unsupported_scheme"),
        CREDENTIALS_IN_URL("credentials_in_url"),
    }

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_url" to "That is not a URL a preview can be fetched from.",
        "unsupported_scheme" to "Link previews are only fetched over http and https.",
        "credentials_in_url" to "A URL carrying a username or password is never fetched.",
    )

    /** A validated fetch target, split the way every renderer needs it. */
    data class Target(
        val url: String,
        val origin: String,
        val host: String,
        val scheme: String,
        val path: String,
    )

    data class Preview(
        val title: String,
        val description: String,
        val image: String,
        val siteName: String,
        val favicon: String,
        val type: String,
        val canonical: String,
    )

    /** What a scan of a document head found, before precedence is applied. */
    data class Tags(
        val meta: Map<String, String>,
        val links: Map<String, String>,
        val documentTitle: String,
    )

    /** Clamp an author-supplied timeout into the band the module honours. Outside the band is
     *  clamped, never refused: a caller asking for five minutes wants "as long as you can". */
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

    private fun defaultPortFor(scheme: String): String = if (scheme == "https") "443" else "80"

    private fun isSchemeToken(s: String): Boolean {
        if (s.isEmpty()) return false
        if (!(s[0] in 'a'..'z' || s[0] in 'A'..'Z')) return false
        return s.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '+' || it == '.' || it == '-' }
    }

    /**
     * Parse and normalize an absolute http(s) URL.
     *
     * Refuses before the network: anything that is not http/https (`file:` and `data:` are how
     * a preview scraper becomes a local-file exfiltration gadget), and userinfo (the credential
     * would be logged, cached and handed to a redirect target).
     */
    fun resolveTarget(raw: Any?): Result<Target> {
        val input = (raw as? String)?.trim() ?: ""
        if (input.isEmpty()) return refuse(Refusal.INVALID_URL)

        val colon = input.indexOf(':')
        if (colon <= 0) return refuse(Refusal.INVALID_URL)
        val scheme = input.substring(0, colon).lowercase()
        if (!isSchemeToken(scheme)) return refuse(Refusal.INVALID_URL)
        if (scheme != "http" && scheme != "https") return refuse(Refusal.UNSUPPORTED_SCHEME)
        if (input.length < colon + 3 || input.substring(colon + 1, colon + 3) != "//") return refuse(Refusal.INVALID_URL)

        val rest = input.substring(colon + 3)
        var cut = rest.length
        for (i in rest.indices) {
            val c = rest[i]
            if (c == '/' || c == '?' || c == '#' || c == '\\') { cut = i; break }
        }
        var authority = rest.substring(0, cut)
        val tail = rest.substring(cut)

        if (authority.contains('@')) return refuse(Refusal.CREDENTIALS_IN_URL)
        if (authority.isEmpty()) return refuse(Refusal.INVALID_URL)

        var port = ""
        val portCut = authority.lastIndexOf(':')
        val bracketEnd = authority.lastIndexOf(']')
        if (portCut >= 0 && portCut > bracketEnd) {
            port = authority.substring(portCut + 1)
            authority = authority.substring(0, portCut)
            if (port.isNotEmpty() && !port.all { it in '0'..'9' }) return refuse(Refusal.INVALID_URL)
        }
        val host = authority.lowercase()
        if (host.isEmpty()) return refuse(Refusal.INVALID_URL)
        if (host.any { it.isWhitespace() || it in "<>\"{}|^`" }) return refuse(Refusal.INVALID_URL)
        if (port == defaultPortFor(scheme)) port = ""

        val hostPort = if (port.isNotEmpty()) "$host:$port" else host
        val origin = "$scheme://$hostPort"

        var pathAndTail = tail.replace('\\', '/')
        if (pathAndTail.isEmpty() || (pathAndTail[0] != '/' && pathAndTail[0] != '?' && pathAndTail[0] != '#')) {
            pathAndTail = "/$pathAndTail"
        }
        if (pathAndTail[0] == '?' || pathAndTail[0] == '#') pathAndTail = "/$pathAndTail"

        val qCut = pathAndTail.indexOfFirst { it == '?' || it == '#' }
        var path = if (qCut >= 0) pathAndTail.substring(0, qCut) else pathAndTail
        if (path.isEmpty()) path = "/"
        path = normalizePath(path)
        val suffix = if (qCut >= 0) pathAndTail.substring(qCut) else ""

        return Result.success(Target("$origin$path$suffix", origin, hostPort, scheme, path))
    }

    private fun <T> refuse(r: Refusal): Result<T> = Result.failure(RefusalError(r))

    class RefusalError(val refusal: Refusal) : Exception(refusal.code)

    /** The refusal code behind a failed [resolveTarget], or `invalid_url` for anything else. */
    fun code(error: Throwable): String = (error as? RefusalError)?.refusal?.code ?: Refusal.INVALID_URL.code

    /** RFC 3986 §5.2.4 remove_dot_segments, restricted to the absolute-path case we ever hold. */
    fun normalizePath(path: String): String {
        val out = ArrayList<String>()
        val trailing = path.endsWith("/") || path.endsWith("/.") || path.endsWith("/..")
        for (segment in path.split("/")) {
            if (segment.isEmpty() || segment == ".") continue
            if (segment == "..") { if (out.isNotEmpty()) out.removeAt(out.size - 1); continue }
            out.add(segment)
        }
        var result = "/" + out.joinToString("/")
        if (trailing && result != "/") result += "/"
        return result
    }

    /**
     * Resolve a reference found in a document against the document's own URL. Returns "" for
     * anything that cannot become an absolute http(s) URL, so a hostile page cannot smuggle a
     * `javascript:` or `data:` scheme through the image or favicon slot.
     */
    fun resolveReference(base: Target, ref: Any?): String {
        val value = (ref as? String)?.trim() ?: ""
        if (value.isEmpty()) return ""

        if (value.startsWith("//")) {
            return resolveTarget("${base.scheme}:$value").getOrNull()?.url ?: ""
        }
        val schemeCut = value.indexOf(':')
        if (schemeCut > 0 && isSchemeToken(value.substring(0, schemeCut))) {
            return resolveTarget(value).getOrNull()?.url ?: ""
        }
        if (value.startsWith("#") || value.startsWith("?")) return "${base.origin}${base.path}$value"
        if (value.startsWith("/")) {
            val cut = value.indexOfFirst { it == '?' || it == '#' }
            val rawPath = if (cut >= 0) value.substring(0, cut) else value
            val suffix = if (cut >= 0) value.substring(cut) else ""
            return "${base.origin}${normalizePath(rawPath)}$suffix"
        }

        val cut = value.indexOfFirst { it == '?' || it == '#' }
        val rawPath = if (cut >= 0) value.substring(0, cut) else value
        val suffix = if (cut >= 0) value.substring(cut) else ""
        val dir = base.path.substring(0, base.path.lastIndexOf('/') + 1)
        return "${base.origin}${normalizePath(dir + rawPath)}$suffix"
    }

    // ── the document scan ────────────────────────────────────────────────────────────

    private val NAMED_ENTITIES: Map<String, String> = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'",
        "nbsp" to "\u00A0", "hellip" to "\u2026", "mdash" to "\u2014", "ndash" to "\u2013",
        "rsquo" to "\u2019", "lsquo" to "\u2018", "ldquo" to "\u201C", "rdquo" to "\u201D",
        "copy" to "\u00A9", "reg" to "\u00AE", "trade" to "\u2122",
    )

    /** Decode the entity set a real page uses in a title. An unknown entity is left verbatim
     *  rather than dropped: `AT&T` written badly must not become `ATT`. */
    fun decodeEntities(input: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < input.length) {
            val amp = input.indexOf('&', i)
            if (amp < 0) { out.append(input, i, input.length); break }
            out.append(input, i, amp)
            val semi = input.indexOf(';', amp)
            if (semi < 0 || semi - amp > 10) { out.append('&'); i = amp + 1; continue }
            val body = input.substring(amp + 1, semi)
            var decoded: String? = null
            if (body.startsWith("#x") || body.startsWith("#X")) {
                val code = body.substring(2).toIntOrNull(16)
                if (code != null && code > 0 && code <= 0x10ffff) decoded = String(Character.toChars(code))
            } else if (body.startsWith("#")) {
                val code = body.substring(1).toIntOrNull()
                if (code != null && code > 0 && code <= 0x10ffff) decoded = String(Character.toChars(code))
            } else {
                decoded = NAMED_ENTITIES[body.lowercase()]
            }
            if (decoded == null) { out.append('&'); i = amp + 1; continue }
            out.append(decoded)
            i = semi + 1
        }
        return out.toString()
    }

    /** Collapse the whitespace a hand-written `<title>` carries across three source lines. */
    fun collapseText(input: String): String {
        val out = StringBuilder()
        var pendingSpace = false
        for (c in input) {
            if (c.isWhitespace() || c == '\u00A0') { pendingSpace = out.isNotEmpty(); continue }
            if (pendingSpace) { out.append(' '); pendingSpace = false }
            out.append(c)
        }
        return out.toString()
    }

    private fun isSpaceChar(c: Char): Boolean =
        c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u000C'

    /**
     * Scan a document for its preview tags. Deliberately NOT a DOM parse: this runs over the
     * first 256 KB of an untrusted response on three runtimes, so it is a forward character
     * scan that never backtracks, executes nothing, and stops at `<body>` or `</head>`.
     *
     * FIRST OCCURRENCE WINS for every key — the alternative lets an injected comment thread
     * override the publisher's own og:image.
     */
    fun scanTags(html: String): Tags {
        val meta = LinkedHashMap<String, String>()
        val links = LinkedHashMap<String, String>()
        var documentTitle = ""

        var i = 0
        val n = html.length
        while (i < n) {
            val lt = html.indexOf('<', i)
            if (lt < 0) break
            i = lt + 1

            if (html.startsWith("!--", i)) {
                val end = html.indexOf("-->", i + 3)
                i = if (end < 0) n else end + 3
                continue
            }
            var closing = false
            if (i < n && html[i] == '/') { closing = true; i += 1 }

            var nameEnd = i
            while (nameEnd < n && !isSpaceChar(html[nameEnd]) && html[nameEnd] != '>' && html[nameEnd] != '/') nameEnd += 1
            val tag = html.substring(i, nameEnd).lowercase()
            i = nameEnd

            if (closing) {
                if (tag == "head") break
                val gt = html.indexOf('>', i)
                i = if (gt < 0) n else gt + 1
                continue
            }

            val attrs = LinkedHashMap<String, String>()
            while (i < n) {
                while (i < n && isSpaceChar(html[i])) i += 1
                if (i >= n) break
                if (html[i] == '>') { i += 1; break }
                if (html[i] == '/' && i + 1 < n && html[i + 1] == '>') { i += 2; break }
                var keyEnd = i
                while (keyEnd < n && !isSpaceChar(html[keyEnd]) && html[keyEnd] != '=' && html[keyEnd] != '>') keyEnd += 1
                val key = html.substring(i, keyEnd).lowercase()
                i = keyEnd
                while (i < n && isSpaceChar(html[i])) i += 1
                var value = ""
                if (i < n && html[i] == '=') {
                    i += 1
                    while (i < n && isSpaceChar(html[i])) i += 1
                    val quote = if (i < n) html[i] else ' '
                    if (quote == '"' || quote == '\'') {
                        i += 1
                        val end = html.indexOf(quote, i)
                        value = if (end < 0) html.substring(i) else html.substring(i, end)
                        i = if (end < 0) n else end + 1
                    } else {
                        var end = i
                        while (end < n && !isSpaceChar(html[end]) && html[end] != '>') end += 1
                        value = html.substring(i, end)
                        i = end
                    }
                }
                if (key.isNotEmpty() && !attrs.containsKey(key)) attrs[key] = decodeEntities(value)
            }

            if (tag == "body") break

            when (tag) {
                "title" -> {
                    val close = html.indexOf("</title", i, ignoreCase = true)
                    val text = if (close < 0) html.substring(i) else html.substring(i, close)
                    if (documentTitle.isEmpty()) documentTitle = collapseText(decodeEntities(text))
                    i = if (close < 0) n else close
                }
                "script", "style" -> {
                    val close = html.indexOf("</$tag", i, ignoreCase = true)
                    i = if (close < 0) n else close
                }
                "meta" -> {
                    val key = (attrs["property"] ?: attrs["name"] ?: attrs["itemprop"] ?: "").trim().lowercase()
                    val content = attrs["content"]
                    if (key.isNotEmpty() && content != null && !meta.containsKey(key)) {
                        meta[key] = collapseText(content)
                    }
                }
                "link" -> {
                    val href = attrs["href"]
                    val rel = (attrs["rel"] ?: "").trim().lowercase()
                    if (href != null && rel.isNotEmpty()) {
                        for (token in rel.split(Regex("\\s+"))) {
                            if (token.isNotEmpty() && !links.containsKey(token)) links[token] = href.trim()
                        }
                    }
                }
            }
        }

        return Tags(meta, links, documentTitle)
    }

    private fun firstMeta(tags: Tags, keys: List<String>): String {
        for (key in keys) {
            val v = tags.meta[key]
            if (v != null && v.isNotEmpty()) return v
        }
        return ""
    }

    private fun firstLink(tags: Tags, keys: List<String>): String {
        for (key in keys) {
            val v = tags.links[key]
            if (v != null && v.isNotEmpty()) return v
        }
        return ""
    }

    /** The site-name fallback. `www.` is dropped because no publisher calls itself that. */
    fun siteFallback(host: String): String {
        val bare = host.substringBefore(':')
        return if (bare.startsWith("www.")) bare.substring(4) else bare
    }

    /**
     * Fold a scanned document into the preview a caller receives. THE PRECEDENCE IS THE
     * PRODUCT and every row is pinned in the corpus:
     *
     *   title        og:title → twitter:title → <title>            → ""
     *   description  og:description → twitter:description → description → ""
     *   image        og:image → og:image:url → og:image:secure_url → twitter:image
     *                → twitter:image:src → link[rel=image_src]     → ""    (resolved absolute)
     *   siteName     og:site_name → application-name → host without `www.`
     *   favicon      link[rel=icon|shortcut|apple-touch-icon|mask-icon] → <origin>/favicon.ico
     *   type         og:type → "website"
     *   canonical    link[rel=canonical] → og:url → the request URL         (resolved absolute)
     *
     * Absence is "" everywhere, never null: a preview card renders the same on three renderers
     * only if "no image" has one spelling.
     */
    fun fold(tags: Tags, target: Target): Preview {
        val title = firstMeta(tags, listOf("og:title", "twitter:title")).ifEmpty { tags.documentTitle }
        val description = firstMeta(tags, listOf("og:description", "twitter:description", "description"))
        val rawImage = firstMeta(
            tags,
            listOf("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"),
        ).ifEmpty { firstLink(tags, listOf("image_src")) }
        val rawCanonical = firstLink(tags, listOf("canonical")).ifEmpty { firstMeta(tags, listOf("og:url")) }
        val rawFavicon = firstLink(tags, listOf("icon", "shortcut", "apple-touch-icon", "mask-icon"))

        val canonical = resolveReference(target, rawCanonical).ifEmpty { target.url }
        val image = resolveReference(target, rawImage)
        val favicon = resolveReference(target, rawFavicon).ifEmpty { "${target.origin}/favicon.ico" }
        val siteName = firstMeta(tags, listOf("og:site_name", "application-name"))
            .ifEmpty { siteFallback(target.host) }
        val type = firstMeta(tags, listOf("og:type")).ifEmpty { "website" }

        return Preview(title, description, image, siteName, favicon, type, canonical)
    }

    /** The whole read, once the bytes are in hand. */
    fun parse(html: String, target: Target): Preview = fold(scanTags(html), target)
}
