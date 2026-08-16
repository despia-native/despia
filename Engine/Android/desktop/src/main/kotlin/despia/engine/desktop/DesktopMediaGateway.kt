package despia.engine.desktop

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.runBlocking

internal const val DESKTOP_MEDIA_PLAYLIST_MAX_BYTES = 2 * 1024 * 1024
internal const val DESKTOP_MEDIA_PLAYLIST_MAX_REFERENCES = 20_000
internal const val DESKTOP_MEDIA_DEFAULT_SESSION_BYTES = 8L * 1024L * 1024L * 1024L
internal const val DESKTOP_MEDIA_MAX_RESPONSE_BYTES = 2L * 1024L * 1024L * 1024L

/** A loopback-only, opaque-token gateway between a native decoder and authored media.
 *
 * Native media stacks need seekable HTTP and HLS subrequests. Giving them an authored
 * URL directly would bypass DSX's credential-free client, redirect revalidation, request
 * deadlines and byte budgets. This gateway keeps every upstream hop in DesktopNetwork,
 * forwards only a single validated Range header, rewrites every HLS reference to another
 * opaque loopback token, and owns a finite aggregate budget for its whole mounted life.
 */
internal class DesktopMediaGateway private constructor(
    private val server: HttpServer,
    private val executor: java.util.concurrent.ExecutorService,
    private val rootToken: String,
    private val maximumSessionBytes: Long,
    private val maximumResponseBytes: Long,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val consumed = AtomicLong(0L)
    private val entries = ConcurrentHashMap<String, URI>()
    private val reverse = ConcurrentHashMap<URI, String>()
    private val active = ConcurrentHashMap.newKeySet<HttpExchange>()
    private lateinit var initialReference: String

    val url: String
        get() = localUrl(initialReference)

    val consumedBytes: Long get() = consumed.get()

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        active.forEach { exchange -> runCatching { exchange.close() } }
        active.clear()
        server.stop(0)
        executor.shutdownNow()
        entries.clear()
        reverse.clear()
    }

    private fun register(uri: URI): String {
        val validated = DesktopNetwork.validateAnonymousMediaUrl(uri.toASCIIString())
        reverse[validated]?.let { return it }
        synchronized(entries) {
            reverse[validated]?.let { return it }
            require(entries.size < DESKTOP_MEDIA_PLAYLIST_MAX_REFERENCES) {
                "media playlist reference limit exceeded"
            }
            val id = randomToken(18)
            entries[id] = validated
            reverse[validated] = id
            return id
        }
    }

    private fun localUrl(id: String): String = "http://127.0.0.1:${server.address.port}/$rootToken/$id"

    private fun handle(exchange: HttpExchange) {
        active += exchange
        var headersSent = false
        try {
            if (closed.get()) throw IOException("media gateway closed")
            val method = exchange.requestMethod.uppercase()
            require(method == "GET" || method == "HEAD") { "unsupported media gateway method" }
            require(exchange.requestURI.rawQuery == null && exchange.requestURI.rawFragment == null) {
                "media gateway request must not carry query or fragment data"
            }
            val parts = exchange.requestURI.rawPath.split('/').filter(String::isNotEmpty)
            require(parts.size == 2 && parts[0] == rootToken && parts[1].matches(Regex("[0-9a-f]{36}"))) {
                "unknown media gateway path"
            }
            val target = entries[parts[1]] ?: throw IllegalArgumentException("unknown media reference")
            val rangeValues = exchange.requestHeaders.entries.filter {
                it.key.equals("range", ignoreCase = true)
            }.flatMap { it.value }
            require(rangeValues.size <= 1) { "multiple media ranges are forbidden" }
            val range = rangeValues.singleOrNull()
            var capture: LimitedOutputStream? = null
            var metadata: DesktopNetwork.AnonymousMediaStreamMetadata? = null
            metadata = runBlocking {
                DesktopNetwork.streamAnonymousMedia(
                    url = target.toASCIIString(),
                    method = method,
                    range = range,
                    maxBytes = minOf(maximumResponseBytes, maximumSessionBytes),
                ) { response ->
                    metadata = response
                    val playlist = method == "GET" && response.status in 200..299 &&
                        isDesktopMediaPlaylist(response.contentType, response.effectiveUri)
                    if (playlist) {
                        val remaining = maximumSessionBytes - consumed.get()
                        response.contentLength?.let { require(it <= remaining) { "media session byte budget exceeded" } }
                        LimitedOutputStream(
                            maximum = DESKTOP_MEDIA_PLAYLIST_MAX_BYTES.toLong(),
                            consumed = consumed,
                            sessionMaximum = maximumSessionBytes,
                        ).also { capture = it }
                    } else {
                        val remaining = maximumSessionBytes - consumed.get()
                        response.contentLength?.let { require(it <= remaining) { "media session byte budget exceeded" } }
                        copySafeResponseHeaders(exchange, response, includeLength = method == "HEAD")
                        val length = if (method == "HEAD") -1L else response.contentLength ?: 0L
                        exchange.sendResponseHeaders(response.status, length)
                        headersSent = true
                        if (method == "HEAD") null else BudgetOutputStream(exchange.responseBody, consumed, maximumSessionBytes)
                    }
                }
            }
            val response = requireNotNull(metadata)
            capture?.let { playlistOutput ->
                val rewritten = rewriteDesktopHlsPlaylist(
                    playlistOutput.toByteArray(),
                    response.effectiveUri,
                ) { resolved -> localUrl(register(resolved)) }
                exchange.responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
                exchange.responseHeaders.set("Cache-Control", "no-store")
                exchange.responseHeaders.set("Content-Length", rewritten.size.toString())
                exchange.sendResponseHeaders(response.status, rewritten.size.toLong())
                headersSent = true
                exchange.responseBody.write(rewritten)
            }
        } catch (_: Throwable) {
            if (!headersSent) {
                runCatching {
                    val body = "DSX media request failed".toByteArray(Charsets.UTF_8)
                    exchange.responseHeaders.set("Content-Type", "text/plain; charset=utf-8")
                    exchange.responseHeaders.set("Cache-Control", "no-store")
                    exchange.sendResponseHeaders(502, body.size.toLong())
                    exchange.responseBody.write(body)
                }
            }
        } finally {
            active -= exchange
            runCatching { exchange.responseBody.close() }
            exchange.close()
        }
    }

    companion object {
        fun start(
            source: String,
            maximumSessionBytes: Long = configuredDesktopMediaSessionBytes(),
            maximumResponseBytes: Long = DESKTOP_MEDIA_MAX_RESPONSE_BYTES,
        ): DesktopMediaGateway {
            require(maximumSessionBytes in 1..64L * 1024L * 1024L * 1024L) {
                "media session byte limit must be between 1 byte and 64 GiB"
            }
            require(maximumResponseBytes in 1..maximumSessionBytes) { "invalid media response limit" }
            val initial = DesktopNetwork.validateAnonymousMediaUrl(source.trim())
            val root = randomToken(24)
            val executor = Executors.newFixedThreadPool(8) { task ->
                Thread(task, "dsx-media-gateway").apply { isDaemon = true }
            }
            val server = HttpServer.create(
                InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0),
                8,
            )
            val gateway = DesktopMediaGateway(server, executor, root, maximumSessionBytes, maximumResponseBytes)
            gateway.initialReference = gateway.register(initial)
            server.executor = executor
            server.createContext("/") { exchange -> gateway.handle(exchange) }
            server.start()
            return gateway
        }
    }
}

internal fun configuredDesktopMediaSessionBytes(): Long {
    val configured = System.getProperty("dsx.media.maxSessionBytes")?.toLongOrNull()
    return configured?.coerceIn(1L, 64L * 1024L * 1024L * 1024L)
        ?: DESKTOP_MEDIA_DEFAULT_SESSION_BYTES
}

internal fun isDesktopMediaPlaylist(contentType: String, uri: URI): Boolean {
    val normalized = contentType.substringBefore(';').trim().lowercase()
    return normalized in setOf(
        "application/vnd.apple.mpegurl",
        "application/x-mpegurl",
        "audio/mpegurl",
        "audio/x-mpegurl",
    ) || uri.path.orEmpty().lowercase().endsWith(".m3u8")
}

/** Rewrites both URI lines and URI="..." tag attributes. A malformed or unsupported
 * URI fails the whole playlist, preventing the native decoder from receiving an
 * unmediated fallback URL. */
internal fun rewriteDesktopHlsPlaylist(
    bytes: ByteArray,
    base: URI,
    map: (URI) -> String,
): ByteArray {
    require(bytes.size <= DESKTOP_MEDIA_PLAYLIST_MAX_BYTES) { "media playlist exceeds byte limit" }
    val text = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()
    val lines = text.split('\n')
    require(lines.size <= DESKTOP_MEDIA_PLAYLIST_MAX_REFERENCES) { "media playlist line limit exceeded" }
    require(lines.firstOrNull()?.trim()?.removePrefix("\uFEFF") == "#EXTM3U") { "invalid HLS playlist" }
    val rewritten = lines.joinToString("\n") { original ->
        val carriage = if (original.endsWith('\r')) "\r" else ""
        val line = original.removeSuffix("\r")
        require(!line.contains('\r')) { "invalid carriage return in HLS playlist" }
        when {
            line.isBlank() -> line + carriage
            line.startsWith('#') -> rewriteDesktopHlsTagLine(line, base, map) + carriage
            else -> map(safeDesktopHlsReference(base, line.trim())) + carriage
        }
    }
    return rewritten.toByteArray(Charsets.UTF_8)
}

/** Parses an HLS tag's comma-delimited attribute list with quote awareness. URI is
 * security-sensitive: exactly one canonical quoted URI attribute is accepted (the
 * attribute name itself is case-insensitive), and every other unquoted URI token is
 * rejected rather than being left for a permissive decoder to fetch directly. */
private fun rewriteDesktopHlsTagLine(line: String, base: URI, map: (URI) -> String): String {
    val colon = line.indexOf(':')
    if (colon < 0) return line
    val prefix = line.substring(0, colon + 1)
    val attributes = splitDesktopHlsAttributes(line.substring(colon + 1))
    val canonicalUri = Regex("""(?i)^URI="([^"\r\n]+)"$""")
    val unquotedUriToken = Regex("""(?i)(?<![A-Z0-9-])URI(?![A-Z0-9-])""")
    val uriIndexes = ArrayList<Int>(1)
    val uriValues = ArrayList<String>(1)

    attributes.forEachIndexed { index, attribute ->
        val match = canonicalUri.matchEntire(attribute)
        if (match != null) {
            uriIndexes += index
            uriValues += match.groupValues[1]
        } else {
            // Mask quoted data so a harmless NAME="contains URI text" is not treated
            // as an attribute, while malformed/unquoted URI syntax still fails closed.
            val outsideQuotes = buildString(attribute.length) {
                var quoted = false
                attribute.forEach { character ->
                    when (character) {
                        '"' -> {
                            quoted = !quoted
                            append(' ')
                        }
                        else -> append(if (quoted) ' ' else character)
                    }
                }
            }
            require(!unquotedUriToken.containsMatchIn(outsideQuotes)) {
                "HLS URI attributes must use canonical URI=\"...\" syntax"
            }
        }
    }
    require(uriIndexes.size <= 1) { "duplicate HLS URI attribute" }
    if (uriIndexes.isEmpty()) return line

    val index = uriIndexes.single()
    val resolved = safeDesktopHlsReference(base, uriValues.single())
    attributes[index] = "URI=\"${map(resolved)}\""
    return prefix + attributes.joinToString(",")
}

private fun splitDesktopHlsAttributes(raw: String): MutableList<String> {
    val attributes = ArrayList<String>()
    var quoted = false
    var start = 0
    raw.forEachIndexed { index, character ->
        require(character != '\r' && character != '\n' && character != '\u0000') {
            "invalid control character in HLS tag"
        }
        when (character) {
            '"' -> quoted = !quoted
            ',' -> if (!quoted) {
                attributes += raw.substring(start, index)
                start = index + 1
            }
        }
    }
    require(!quoted) { "unterminated quoted HLS attribute" }
    attributes += raw.substring(start)
    return attributes
}

private fun safeDesktopHlsReference(base: URI, raw: String): URI {
    require(raw.isNotBlank() && raw.length <= 16_384 && !raw.contains('\r') && !raw.contains('\n')) {
        "invalid HLS reference"
    }
    val resolved = base.resolve(URI(raw))
    return DesktopNetwork.validateAnonymousMediaUrl(resolved.toASCIIString())
}

private fun copySafeResponseHeaders(
    exchange: HttpExchange,
    metadata: DesktopNetwork.AnonymousMediaStreamMetadata,
    includeLength: Boolean,
) {
    val allowed = setOf("accept-ranges", "content-range", "content-type", "etag", "last-modified")
    metadata.headers.forEach { (name, value) ->
        if (name.lowercase() in allowed && value.length <= 16_384 && !value.contains('\r') && !value.contains('\n')) {
            exchange.responseHeaders.set(name, value)
        }
    }
    if (includeLength) metadata.contentLength?.let { exchange.responseHeaders.set("Content-Length", it.toString()) }
    exchange.responseHeaders.set("Cache-Control", "no-store")
}

private class LimitedOutputStream(
    private val maximum: Long,
    private val consumed: AtomicLong? = null,
    private val sessionMaximum: Long = Long.MAX_VALUE,
) : OutputStream() {
    private val buffer = ByteArrayOutputStream()
    private var count = 0L

    override fun write(value: Int) {
        reserve(1)
        buffer.write(value)
    }

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        require(offset >= 0 && length >= 0 && offset + length <= bytes.size)
        reserve(length)
        buffer.write(bytes, offset, length)
    }

    private fun reserve(length: Int) {
        count = Math.addExact(count, length.toLong())
        if (count > maximum) throw IOException("media playlist exceeds ${maximum}B limit")
        consumed?.let { reserveBytes(it, sessionMaximum, length) }
    }

    fun toByteArray(): ByteArray = buffer.toByteArray()
}

private class BudgetOutputStream(
    private val delegate: OutputStream,
    private val consumed: AtomicLong,
    private val maximum: Long,
) : OutputStream() {
    override fun write(value: Int) {
        reserveBytes(consumed, maximum, 1)
        delegate.write(value)
    }

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        require(offset >= 0 && length >= 0 && offset + length <= bytes.size)
        reserveBytes(consumed, maximum, length)
        delegate.write(bytes, offset, length)
    }

    override fun flush() = delegate.flush()
    override fun close() = delegate.close()
}

private fun reserveBytes(consumed: AtomicLong, maximum: Long, count: Int) {
    require(count >= 0)
    while (true) {
        val before = consumed.get()
        val after = Math.addExact(before, count.toLong())
        if (after > maximum) throw IOException("media session byte budget exceeded")
        if (consumed.compareAndSet(before, after)) return
    }
}

private fun randomToken(bytes: Int): String {
    val value = ByteArray(bytes)
    desktopMediaRandom.nextBytes(value)
    return value.joinToString("") { "%02x".format(it) }
}

private val desktopMediaRandom = SecureRandom()
