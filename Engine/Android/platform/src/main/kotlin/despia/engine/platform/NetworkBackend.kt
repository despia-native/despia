//
//  NetworkBackend.kt — the production Android HTTP plane.
//
//  One OkHttpClient and one CookieJar back every kernel network face:
//    • Context.fetchImpl (`dsx.fetch`)
//    • JSERunner.fetch (`fetch()` / `fetch:` author logic)
//    • mounted `<api>` declarations
//    • ContentStore.shared.fetch
//
//  Requests are always enqueued: no DNS, TLS, socket, response decoding, or retry work
//  can run on the main thread. The app-store channel rejects cleartext URLs before a
//  socket is opened; debug/test may opt in through Android's debug network policy.
//

package despia.engine.platform

import android.content.Context as AndroidContext
import android.webkit.CookieManager as WebCookieManager
import despia.engine.ApiBlockAsyncFetch
import despia.engine.ApiBlockFetchCall
import despia.engine.ApiBlock
import despia.engine.AppEnvironment
import despia.engine.AppManifest
import despia.engine.ContentFetch
import despia.engine.ContentResponse
import despia.engine.ContentStore
import despia.engine.Context as DsxContext
import despia.engine.DSXContent
import despia.engine.DSXCookies
import despia.engine.FetchError
import despia.engine.FetchResponse
import despia.engine.JSE
import despia.engine.JSEFetch
import despia.engine.JSEFetchResponse
import despia.engine.JSERunner
import despia.engine.JSON
import despia.engine.NSNull
import despia.engine.json
import java.io.File
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpCookie
import java.net.URI
import java.util.Locale
import java.util.concurrent.CancellationException
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Cache
import okhttp3.CacheControl
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.ByteString.Companion.toByteString

internal fun interface WebCookieBridge {
    fun cookies(url: String): String?

    fun save(url: String, cookies: List<Cookie>) {}
}

private object NoWebCookies : WebCookieBridge {
    override fun cookies(url: String): String? = null
}

private class ResponseBodyTooLarge(limit: Long) :
    IOException("response body exceeds ${limit}B limit")

private class RequestBodyTooLarge :
    IOException("request body exceeds the 4MiB complexity/byte limit")

private fun interface PendingCall {
    fun cancel()
}

private class AndroidWebCookies : WebCookieBridge {
    private val manager: WebCookieManager = WebCookieManager.getInstance().also {
        it.setAcceptCookie(true)
    }

    override fun cookies(url: String): String? = runCatching { manager.getCookie(url) }.getOrNull()

    override fun save(url: String, cookies: List<Cookie>) {
        for (cookie in cookies) runCatching { manager.setCookie(url, cookie.toString()) }
        runCatching { manager.flush() }
    }
}

/**
 * Thread-safe in-memory CookieJar shared by every native HTTP surface. OkHttp's
 * [Cookie.matches] is the single domain/path/secure/expiry policy, preventing a cookie
 * imported from DSX/WebView from leaking to a sibling or lookalike host.
 */
internal class DsxCookieJar(
    private val web: WebCookieBridge = NoWebCookies,
    private val onChanged: (List<HttpCookie>) -> Unit = {},
) : CookieJar {
    private data class Key(val name: String, val domain: String, val path: String)
    private data class SemanticCookie(
        val name: String,
        val value: String,
        val domain: String,
        val path: String,
        val secure: Boolean,
        val httpOnly: Boolean,
        val hostOnly: Boolean,
    )
    private val lock = Any()
    private val cookies = ArrayList<Cookie>()
    private val webKeysByHost = HashMap<String, Set<Key>>()
    private val revision = AtomicLong(0)

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        val changed = synchronized(lock) {
            val before = semantic(this.cookies)
            val now = System.currentTimeMillis()
            this.cookies.removeAll { it.expiresAt <= now }
            for (cookie in cookies) {
                this.cookies.removeAll {
                    it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path
                }
                if (cookie.expiresAt > now) this.cookies += cookie
            }
            before != semantic(this.cookies)
        }
        if (changed) revision.incrementAndGet()
        web.save(url.toString(), cookies)
        onChanged(snapshot().map { it.toHttpCookie() })
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        // CookieManager's header is URL-specific. Parse it outside our lock (the WebView
        // provider may block), then reconcile AND copy this request's matching cookies in
        // one critical section. Otherwise concurrent /admin and /public requests on the
        // same host can overwrite the synthetic path="/" value between reconciliation
        // and filtering, sending the other request's auth cookie.
        val parsed = parseWebCookies(url)
        val outcome = synchronized(lock) {
            val before = semantic(cookies)
            val now = System.currentTimeMillis()
            cookies.removeAll { it.expiresAt <= now }
            val previous = webKeysByHost[url.host].orEmpty()
            val current = parsed.mapTo(LinkedHashSet()) { Key(it.name, it.domain, it.path) }
            cookies.removeAll {
                val key = Key(it.name, it.domain, it.path)
                key in previous && key !in current
            }
            for (cookie in parsed) {
                cookies.removeAll {
                    it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path
                }
                cookies += cookie
            }
            if (current.isEmpty()) webKeysByHost.remove(url.host)
            else webKeysByHost[url.host] = current
            val live = if (before == semantic(cookies)) null else cookies.toList()
            cookies.filter { it.matches(url) } to live
        }
        outcome.second?.let { live ->
            revision.incrementAndGet()
            onChanged(live.map { it.toHttpCookie() })
        }
        return outcome.first
    }

    /** Import one cookie written through `DSXCookies.nativeStore`. */
    fun store(cookie: HttpCookie) {
        val converted = cookie.toOkHttpCookie() ?: return
        val changed = synchronized(lock) {
            val before = semantic(cookies)
            cookies.removeAll {
                it.name == converted.name && it.domain == converted.domain && it.path == converted.path
            }
            if (!cookie.hasExpired() && converted.expiresAt > System.currentTimeMillis()) {
                cookies += converted
            }
            before != semantic(cookies)
        }
        if (changed) revision.incrementAndGet()
    }

    internal fun revision(): Long {
        pruneExpired()
        return revision.get()
    }

    internal fun snapshot(): List<Cookie> {
        pruneExpired()
        return synchronized(lock) { cookies.toList() }
    }

    /** Effective request identity, excluding expiry timestamps. Reissuing the same
     * Set-Cookie to renew its lifetime does not churn a declarative request/cache key. */
    internal fun partition(url: HttpUrl): String {
        val effective = loadForRequest(url)
            .map { cookie ->
                linkedMapOf<String, Any?>(
                    "name" to cookie.name,
                    "value" to cookie.value,
                    "domain" to cookie.domain,
                    "path" to cookie.path,
                    "secure" to cookie.secure,
                    "httpOnly" to cookie.httpOnly,
                    "hostOnly" to cookie.hostOnly,
                )
            }
            .sortedWith(compareBy({ JSE.string(it["domain"]) }, { JSE.string(it["path"]) }, { JSE.string(it["name"]) }))
        return JSE.watchKey(effective)
    }

    private fun pruneExpired() {
        val now = System.currentTimeMillis()
        val live = synchronized(lock) {
            if (!cookies.removeAll { it.expiresAt <= now }) null else cookies.toList()
        }
        if (live != null) {
            revision.incrementAndGet()
            onChanged(live.map { it.toHttpCookie() })
        }
    }

    private fun parseWebCookies(url: HttpUrl): List<Cookie> {
        val parsed = ArrayList<Cookie>()
        for (part in web.cookies(url.toString()).orEmpty().split(';')) {
            val pair = part.trim()
            val eq = pair.indexOf('=')
            if (eq <= 0) continue
            val name = pair.substring(0, eq).trim()
            val value = pair.substring(eq + 1).trim()
            val cookie = runCatching {
                Cookie.Builder()
                    .name(name)
                    .value(value)
                    .hostOnlyDomain(url.host)
                    .path("/")
                    .build()
            }.getOrNull() ?: continue
            parsed += cookie
        }
        return parsed
    }

    private fun semantic(values: List<Cookie>): Set<SemanticCookie> =
        values.mapTo(LinkedHashSet()) {
            SemanticCookie(
                it.name, it.value, it.domain, it.path,
                it.secure, it.httpOnly, it.hostOnly,
            )
        }

    private fun HttpCookie.toOkHttpCookie(): Cookie? {
        val host = domain?.trim()?.trimStart('.')?.takeIf { it.isNotEmpty() } ?: return null
        return runCatching {
            val b = Cookie.Builder()
                .name(name)
                .value(value)
                .domain(host)
                .path(path?.takeIf { it.startsWith("/") } ?: "/")
            if (secure) b.secure()
            if (isHttpOnly) b.httpOnly()
            if (maxAge >= 0) {
                val expires = if (maxAge == 0L) 0L else {
                    val delta = maxAge.coerceAtMost(Long.MAX_VALUE / 1000L) * 1000L
                    (System.currentTimeMillis() + delta).coerceAtLeast(0L)
                }
                b.expiresAt(expires)
            }
            b.build()
        }.getOrNull()
    }

    private fun Cookie.toHttpCookie(): HttpCookie = HttpCookie(name, value).also {
        it.domain = domain
        it.path = path
        it.secure = secure
        it.isHttpOnly = httpOnly
        it.maxAge = if (persistent) {
            ((expiresAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L)
        } else {
            -1L
        }
    }
}

object NetworkBackend {
    private const val DEFAULT_TIMEOUT_SECONDS = 30.0
    private const val MAX_API_REQUEST_BODY_BYTES = 4L * 1024L * 1024L
    private const val MAX_API_RESPONSE_BYTES = 16L * 1024L * 1024L
    private const val MAX_SSE_EVENT_BYTES = 1L * 1024L * 1024L
    private const val MAX_SSE_EVENTS = 10_000
    private const val MAX_MANIFEST_RESPONSE_BYTES = 4L * 1024L * 1024L
    // Keep the native content-store plane aligned with ContentServer's published-file ceiling.
    // Both the advertised length and the bytes actually streamed are enforced so a missing or
    // dishonest Content-Length cannot fill app storage. Tests may lower this through the installer.
    internal const val MAX_BLOB_RESPONSE_BYTES = 240L * 1024L * 1024L
    private const val MANIFEST_CACHE_BYTES = 32L * 1024L * 1024L
    private const val MAX_REQUEST_BODY_DEPTH = 64
    private const val MAX_REQUEST_BODY_NODES = 100_000
    internal const val MAX_REQUEST_URL_BYTES = 64L * 1_024L
    internal const val MAX_REQUEST_QUERY_ITEMS = 1_024
    internal const val MAX_REQUEST_HEADER_COUNT = 256
    internal const val MAX_REQUEST_HEADER_BYTES = 256L * 1_024L
    internal const val MAX_REQUEST_HEADER_NAME_BYTES = 256L
    internal const val MAX_REQUEST_METHOD_BYTES = 32L
    private val noCall = ApiBlockFetchCall {}
    private val requestExecutor = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "dsx-http-request").apply { isDaemon = true }
    }

    @Volatile private var originProvider: () -> String? = { AppManifest.resolvedOriginString() }
    @Volatile private var allowCleartext: Boolean = false
    @Volatile private var completionExecutor: Executor = Executor { it.run() }
    @Volatile private var cookieJar: DsxCookieJar = DsxCookieJar()
    @Volatile private var client: OkHttpClient = buildClient(cookieJar)
    @Volatile private var manifestClient: OkHttpClient = buildClient(cookieJar)
    @Volatile private var blobClient: OkHttpClient = buildClient(cookieJar)
    @Volatile private var blobResponseBytesLimit: Long = MAX_BLOB_RESPONSE_BYTES

    /**
     * Install every production network/cookie seam. Call once at app boot after the main
     * executor and [AppEnvironment.detector] are installed.
     */
    fun install(context: AndroidContext, mainExecutor: Executor) {
        val app = context.applicationContext
        DSXContent.contentMaxBlobMB = { AppManifest.contentMaxBlobMB }
        // CookieManager is process/WebView-provider state and is allowed to throw (for
        // example in a secondary process with a broken provider). Native networking must
        // remain available and Application.onCreate must never be bricked by that bridge.
        val web = runCatching<WebCookieBridge> { AndroidWebCookies() }.getOrElse {
            NoWebCookies
        }
        installInternal(
            origin = { AppManifest.resolvedOriginString() },
            mainExecutor = mainExecutor,
            cleartext = !AppEnvironment.current.isProduction,
            web = web,
            manifestCacheDirectory = File(app.cacheDir, "despia-http-manifests"),
            maxBlobResponseBytes = AppManifest.contentMaxBlobMB.toLong() * 1024L * 1024L,
        )
        // Give DSX-authored cookie writes a stable default even before the first WebView load.
        DSXCookies.shared.setDomainHint(AppManifest.resolvedHost())
    }

    /** Test installer: identical seams/client, no Android WebView dependency. */
    internal fun installForTests(
        origin: () -> String? = { null },
        mainExecutor: Executor = Executor { it.run() },
        cleartext: Boolean = true,
        manifestCacheDirectory: File? = null,
        web: WebCookieBridge = NoWebCookies,
        maxBlobResponseBytes: Long = MAX_BLOB_RESPONSE_BYTES,
    ) {
        require(maxBlobResponseBytes > 0L)
        installInternal(
            origin,
            mainExecutor,
            cleartext,
            web,
            manifestCacheDirectory,
            maxBlobResponseBytes,
        )
    }

    private fun installInternal(
        origin: () -> String?,
        mainExecutor: Executor,
        cleartext: Boolean,
        web: WebCookieBridge,
        manifestCacheDirectory: File?,
        maxBlobResponseBytes: Long,
    ) {
        completionExecutor = mainExecutor
        originProvider = origin
        allowCleartext = cleartext
        blobResponseBytesLimit = maxBlobResponseBytes
        lateinit var jar: DsxCookieJar
        jar = DsxCookieJar(web) { _ ->
            // Publish the complete current jar (not just the last response), preserving
            // unrelated cookie names in DSX's reactive snapshot.
            DSXCookies.shared.ingest(jar.snapshot().map { cookie ->
                HttpCookie(cookie.name, cookie.value).also {
                    it.domain = cookie.domain
                    it.path = cookie.path
                    it.secure = cookie.secure
                    it.isHttpOnly = cookie.httpOnly
                    it.maxAge = if (cookie.persistent) {
                        ((cookie.expiresAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L)
                    } else -1L
                }
            })
        }
        cookieJar = jar
        runCatching { manifestClient.cache?.close() }
        client = buildClient(jar)
        // A corrupt/unwritable cache directory degrades to normal HTTP rather than
        // crashing every app at Application.onCreate.
        val protocolCache = manifestCacheDirectory?.let { directory ->
            runCatching {
                if (directory.exists() && !directory.isDirectory) {
                    throw IOException("manifest cache path is not a directory")
                }
                if (!directory.exists() && !directory.mkdirs()) {
                    throw IOException("cannot create manifest cache directory")
                }
                Cache(directory, MANIFEST_CACHE_BYTES)
            }.getOrNull()
        }
        manifestClient = buildClient(jar, protocolCache)
        // Blobs are content-addressed by ContentStore itself. A protocol cache would
        // double-store them, so this client deliberately has no OkHttp Cache.
        blobClient = buildClient(jar)

        DsxContext.fetchImpl = { url, method, headers, query, body, timeout ->
            await(url, method, headers, query, body, timeout)
        }
        DsxContext.controlFetchImpl = { url, method, headers, query, body, timeout ->
            await(
                url = url,
                method = method,
                headers = headers,
                query = query,
                body = body,
                timeout = timeout,
                httpClient = manifestClient,
                maxResponseBytes = MAX_MANIFEST_RESPONSE_BYTES,
            )
        }
        JSERunner.fetch = JSEFetch { url, method, headers, body, completion ->
            enqueue(url, method, headers, emptyMap(), body, DEFAULT_TIMEOUT_SECONDS) { result ->
                completionExecutor.execute {
                    completion(result.getOrNull()?.let {
                        JSEFetchResponse(it.status, it.headers, it.body)
                    })
                }
            }
        }
        ContentStore.shared.fetch = object : ContentFetch {
            override suspend fun data(url: String): ContentResponse? = try {
                val response = await(
                    url = url,
                    method = "GET",
                    headers = emptyMap(),
                    query = emptyMap(),
                    body = null,
                    timeout = DEFAULT_TIMEOUT_SECONDS,
                    httpClient = manifestClient,
                    maxResponseBytes = MAX_MANIFEST_RESPONSE_BYTES,
                )
                ContentResponse(response.status, response.body, response.headers)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }

            override suspend fun download(url: String, dest: File): Int? =
                downloadBlob(url, dest)
        }
        DSXContent.resolvedOriginString = origin
        DSXContent.contentRoot = { AppManifest.contentRoot }
        DSXCookies.shared.nativeStore = { cookie -> jar.store(cookie) }
        DSXCookies.shared.mainExecutor = mainExecutor
        // install() is process boot; tests may reinstall. Never carry the previous
        // backend's snapshot into a fresh jar/client identity.
        DSXCookies.shared.ingest(emptyList())
        ApiBlock.cachePartition = {
            "cookie-revision:${jar.revision()}:${JSE.watchKey(DSXCookies.shared.jar)}"
        }
        ApiBlock.requestCachePartition = { request ->
            resolve(JSE.string(request["url"]))?.let { jar.partition(it) }
                ?: "invalid-url"
        }
        JSE.cookieJar = { DSXCookies.shared.jar }
        JSERunner.cookieSet = { name, value -> DSXCookies.shared.set(name, value) }
    }

    /** Completion transport used by the Compose `<api>` mount. */
    val apiFetch: ApiBlockAsyncFetch
        get() = ApiBlockAsyncFetch { rawUrl, request, completion ->
            val method = JSE.string(request["method"]).ifEmpty { "GET" }
            val headers = LinkedHashMap<String, String>()
            @Suppress("UNCHECKED_CAST")
            for ((key, value) in (request["headers"] as? Map<String, Any?>) ?: emptyMap()) {
                headers[key] = JSE.string(value)
            }
            val timeout = JSE.number(request["timeout"]) ?: DEFAULT_TIMEOUT_SECONDS
            val call = enqueue(
                rawUrl, method, headers, emptyMap(), request["body"], timeout,
                onSseMessage = { message ->
                    completionExecutor.execute {
                        completion(
                            linkedMapOf(
                                "partial" to true,
                                "message" to message,
                            ),
                        )
                    }
                },
            ) { result ->
                val envelope = result.fold(
                    onSuccess = { response -> apiEnvelope(response, request["expect"]) },
                    onFailure = { failure ->
                        if (failure is CancellationException) {
                            linkedMapOf(
                                "ok" to false, "status" to -1.0, "data" to null,
                                "aborted" to true,
                            )
                        } else if (
                            failure is ResponseBodyTooLarge ||
                            failure.cause is ResponseBodyTooLarge
                        ) {
                            linkedMapOf(
                                "ok" to false, "status" to -2.0, "data" to null,
                                "error" to "response_too_large",
                            )
                        } else if (
                            failure is RequestBodyTooLarge ||
                            failure.cause is RequestBodyTooLarge
                        ) {
                            linkedMapOf(
                                "ok" to false, "status" to -2.0, "data" to null,
                                "error" to "request_too_large",
                            )
                        } else {
                            linkedMapOf(
                                "ok" to false, "status" to 0.0, "data" to null,
                                "error" to "network",
                            )
                        }
                    },
                )
                completionExecutor.execute { completion(envelope) }
            } ?: return@ApiBlockAsyncFetch noCall
            ApiBlockFetchCall { call.cancel() }
        }

    private fun buildClient(jar: CookieJar, cache: Cache? = null): OkHttpClient = OkHttpClient.Builder()
        .cookieJar(jar)
        .cache(cache)
        .followRedirects(true)
        // Production accepts HTTPS only. Keep same-scheme redirects, but never let an
        // HTTPS response downgrade the client to HTTP even if a consuming manifest
        // accidentally opts Android's platform cleartext policy back in.
        .followSslRedirects(allowCleartext)
        .retryOnConnectionFailure(true)
        .connectTimeout(DEFAULT_TIMEOUT_SECONDS.toLong(), TimeUnit.SECONDS)
        .readTimeout(DEFAULT_TIMEOUT_SECONDS.toLong(), TimeUnit.SECONDS)
        .writeTimeout(DEFAULT_TIMEOUT_SECONDS.toLong(), TimeUnit.SECONDS)
        .build()

    private suspend fun await(
        url: String,
        method: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: Any?,
        timeout: Double,
        httpClient: OkHttpClient = client,
        maxResponseBytes: Long = MAX_API_RESPONSE_BYTES,
    ): FetchResponse = suspendCancellableCoroutine { continuation ->
        val call = try {
            enqueue(
                rawUrl = url,
                method = method,
                headers = headers,
                query = query,
                body = body,
                timeoutSeconds = timeout,
                httpClient = httpClient,
                maxResponseBytes = maxResponseBytes,
            ) { result ->
                if (!continuation.isActive) return@enqueue
                result.fold(
                    onSuccess = { continuation.resume(it) },
                    onFailure = {
                        continuation.resumeWithException(
                            if (it is FetchError) it else FetchError.Transport(it))
                    },
                )
            }
        } catch (error: Exception) {
            continuation.resumeWithException(
                if (error is FetchError) error else FetchError.Transport(error))
            null
        }
        continuation.invokeOnCancellation { call?.cancel() }
    }

    /** Build and enqueue one request off-caller-thread. Every failure and cancellation is
     * delivered exactly once through [completion]; null only means executor submission failed. */
    private fun enqueue(
        rawUrl: String,
        method: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: Any?,
        timeoutSeconds: Double,
        httpClient: OkHttpClient = client,
        maxResponseBytes: Long = MAX_API_RESPONSE_BYTES,
        onSseMessage: ((Any?) -> Unit)? = null,
        completion: (Result<FetchResponse>) -> Unit,
    ): PendingCall? {
        val completed = AtomicBoolean(false)
        val cancelled = AtomicBoolean(false)
        val callRef = AtomicReference<Call?>(null)
        fun finish(result: Result<FetchResponse>) {
            if (completed.compareAndSet(false, true)) completion(result)
        }
        val pending = PendingCall {
            if (cancelled.compareAndSet(false, true)) {
                callRef.get()?.cancel()
                finish(Result.failure(CancellationException("cancelled")))
            }
        }
        try {
            // URL resolution, request-body traversal/serialization, and Request creation
            // are deliberately off the caller/Compose thread. Large authored objects
            // therefore fail terminally without freezing UI before OkHttp.enqueue.
            requestExecutor.execute {
                if (cancelled.get()) return@execute
                val request = try {
                    buildRequest(rawUrl, method, headers, query, body)
                } catch (error: Exception) {
                    finish(Result.failure(
                        if (error is FetchError) error else FetchError.Transport(error)))
                    return@execute
                }
                if (cancelled.get()) return@execute
                val call = httpClient.newCall(request)
                callRef.set(call)
                if (cancelled.get()) {
                    call.cancel()
                    return@execute
                }
                val safeSeconds = timeoutSeconds.takeIf { it.isFinite() && it > 0.0 }
                    ?: DEFAULT_TIMEOUT_SECONDS
                val timeoutMillis = (safeSeconds * 1000.0)
                    .coerceIn(1.0, TimeUnit.MINUTES.toMillis(10).toDouble()).toLong()
                call.timeout().timeout(timeoutMillis, TimeUnit.MILLISECONDS)
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        finish(Result.failure(
                            if (call.isCanceled()) CancellationException("cancelled")
                            else FetchError.Transport(e)))
                    }

                    override fun onResponse(call: Call, response: Response) {
                        try {
                            response.use {
                                val contentType = it.header("Content-Type").orEmpty()
                                val streamSink = onSseMessage
                                if (streamSink != null && it.isSuccessful &&
                                    contentType.contains("text/event-stream", ignoreCase = true)
                                ) {
                                    // Persistent SSE calls intentionally have no total
                                    // deadline. Connect/read/write timeouts still bound
                                    // setup and silent connections.
                                    call.timeout().clearTimeout()
                                    readSse(it, maxResponseBytes) { message ->
                                        if (!completed.get() && !cancelled.get()) {
                                            streamSink(message)
                                        }
                                    }
                                    finish(
                                        Result.success(
                                            FetchResponse(
                                                status = it.code,
                                                headers = flattenHeaders(it.headers),
                                                body = ByteArray(0),
                                                streamed = true,
                                            ),
                                        ),
                                    )
                                    return
                                }
                                finish(Result.success(FetchResponse(
                                    status = it.code,
                                    headers = flattenHeaders(it.headers),
                                    body = readBounded(it, maxResponseBytes),
                                )))
                            }
                        } catch (error: Exception) {
                            finish(Result.failure(FetchError.Transport(error)))
                        }
                    }
                })
            }
        } catch (error: Exception) {
            finish(Result.failure(FetchError.Transport(error)))
            return null
        }
        return pending
    }

    /** Incremental SSE parser. It retains one frame plus the bounded decoded aggregate
     * owned by ApiBlock, never the whole response body. LF/CRLF/CR and multi-line data
     * fields follow the event-stream wire format. */
    private fun readSse(
        response: Response,
        limit: Long,
        onMessage: (Any?) -> Unit,
    ) {
        val body = response.body
        val advertised = body.contentLength()
        if (advertised > limit) throw ResponseBodyTooLarge(limit)
        val parser = SseParser(
            decode = { decodeJsonOrText(it) },
            emit = onMessage,
        )
        body.byteStream().use { input ->
            val buffer = ByteArray(8192)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > limit) throw ResponseBodyTooLarge(limit)
                parser.consume(buffer, count)
            }
        }
        parser.finish()
    }

    private class SseParser(
        private val decode: (String) -> Any?,
        private val emit: (Any?) -> Unit,
    ) {
        private val line = ByteArrayOutputStream()
        private val dataLines = ArrayList<String>()
        private var eventBytes = 0L
        private var events = 0
        private var skipLineFeed = false
        private var firstLine = true

        fun consume(bytes: ByteArray, count: Int) {
            for (index in 0 until count) {
                val value = bytes[index].toInt() and 0xFF
                if (skipLineFeed) {
                    skipLineFeed = false
                    if (value == 0x0A) continue
                }
                when (value) {
                    0x0D -> {
                        acceptLine()
                        skipLineFeed = true
                    }
                    0x0A -> acceptLine()
                    else -> {
                        line.write(value)
                        if (line.size().toLong() > MAX_SSE_EVENT_BYTES) {
                            throw ResponseBodyTooLarge(MAX_API_RESPONSE_BYTES)
                        }
                    }
                }
            }
        }

        fun finish() {
            if (line.size() > 0) acceptLine()
            dispatch()
        }

        private fun acceptLine() {
            eventBytes += line.size().toLong() + 1L
            if (eventBytes > MAX_SSE_EVENT_BYTES) {
                throw ResponseBodyTooLarge(MAX_API_RESPONSE_BYTES)
            }
            var text = String(line.toByteArray(), Charsets.UTF_8)
            line.reset()
            if (firstLine) {
                firstLine = false
                if (text.startsWith('\uFEFF')) text = text.drop(1)
            }
            if (text.isEmpty()) {
                dispatch()
                return
            }
            if (text.startsWith(":")) return
            val colon = text.indexOf(':')
            val field = if (colon < 0) text else text.substring(0, colon)
            if (field != "data") return
            var value = if (colon < 0) "" else text.substring(colon + 1)
            if (value.startsWith(" ")) value = value.drop(1)
            dataLines += value
        }

        private fun dispatch() {
            if (dataLines.isEmpty()) {
                eventBytes = 0L
                return
            }
            events += 1
            if (events > MAX_SSE_EVENTS) {
                throw ResponseBodyTooLarge(MAX_API_RESPONSE_BYTES)
            }
            val payload = dataLines.joinToString("\n")
            dataLines.clear()
            eventBytes = 0L
            emit(decode(payload))
        }
    }

    /** Read an in-memory response with both advertised and actual-byte limits. */
    private fun readBounded(response: Response, limit: Long): ByteArray {
        val body = response.body
        val advertised = body.contentLength()
        if (advertised > limit) {
            throw ResponseBodyTooLarge(limit)
        }
        val initial = when {
            advertised in 1..Int.MAX_VALUE.toLong() -> advertised.toInt()
            else -> 8192
        }
        val out = ByteArrayOutputStream(initial.coerceAtMost(64 * 1024))
        body.byteStream().use { input ->
            val buffer = ByteArray(8192)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > limit) throw ResponseBodyTooLarge(limit)
                out.write(buffer, 0, count)
            }
        }
        return out.toByteArray()
    }

    /**
     * Stream a content-addressed blob to a sibling temporary file with the no-cache
     * client, then atomically rename only after a complete 2xx response. A timeout,
     * cancellation, short read, or disk error leaves the previous destination untouched.
     */
    private suspend fun downloadBlob(rawUrl: String, dest: File): Int? =
        suspendCancellableCoroutine { continuation ->
            val request = try {
                buildRequest(rawUrl, "GET", emptyMap(), emptyMap(), null)
                    .newBuilder()
                    .cacheControl(CacheControl.FORCE_NETWORK)
                    .build()
            } catch (_: Exception) {
                continuation.resume(null)
                return@suspendCancellableCoroutine
            }
            val parent = dest.absoluteFile.parentFile
            if (parent == null || (!parent.isDirectory && !parent.mkdirs())) {
                continuation.resume(null)
                return@suspendCancellableCoroutine
            }
            val call = blobClient.newCall(request)
            // Blob downloads may be large; keep bounded connection/read inactivity from the
            // client and a generous total cap instead of the API plane's 30-second cap.
            call.timeout().timeout(10, TimeUnit.MINUTES)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resume(null)
                }

                override fun onResponse(call: Call, response: Response) {
                    var temp: File? = null
                    try {
                        response.use {
                            if (it.code !in 200..299) {
                                if (continuation.isActive) continuation.resume(it.code)
                                return
                            }
                            val body = it.body
                            val limit = blobResponseBytesLimit
                            val advertised = body.contentLength()
                            if (advertised > limit) throw ResponseBodyTooLarge(limit)
                            temp = File.createTempFile(".${dest.name}.", ".part", parent)
                            body.byteStream().use { input ->
                                FileOutputStream(temp!!).use { output ->
                                    val buffer = ByteArray(32 * 1024)
                                    var total = 0L
                                    while (true) {
                                        val count = input.read(buffer)
                                        if (count < 0) break
                                        total += count
                                        if (total > limit) throw ResponseBodyTooLarge(limit)
                                        output.write(buffer, 0, count)
                                    }
                                    output.flush()
                                    output.fd.sync()
                                }
                            }
                            if (!temp!!.renameTo(dest)) {
                                throw IOException("atomic blob publish failed")
                            }
                            temp = null
                            if (continuation.isActive) continuation.resume(it.code)
                        }
                    } catch (_: Exception) {
                        if (continuation.isActive) continuation.resume(null)
                    } finally {
                        temp?.delete()
                    }
                }
            })
        }

    private fun buildRequest(
        rawUrl: String,
        rawMethod: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: Any?,
    ): Request {
        if (!validBoundedText(rawUrl, MAX_REQUEST_URL_BYTES, rejectControls = true)) {
            throw FetchError.InvalidURL(rawUrl)
        }
        val url = resolve(rawUrl) ?: throw FetchError.InvalidURL(rawUrl)
        if (url.scheme != "https" && !allowCleartext) throw FetchError.InvalidURL(rawUrl)
        if (query.size > MAX_REQUEST_QUERY_ITEMS) throw FetchError.InvalidURL(rawUrl)

        // Preflight raw query storage before percent-encoding/OkHttp builder allocation. Include
        // the resolved URL and separator overhead; the encoded final URL gets an exact second cap.
        var queryBudget = utf8SizeAtMost(url.toString(), MAX_REQUEST_URL_BYTES)
        if (queryBudget > MAX_REQUEST_URL_BYTES) throw FetchError.InvalidURL(rawUrl)
        for ((key, value) in query) {
            for (item in listOf(key, value)) {
                val count = utf8SizeAtMost(item, MAX_REQUEST_URL_BYTES - queryBudget)
                if (!hasValidUnicode(item) || count > MAX_REQUEST_URL_BYTES - queryBudget) {
                    throw FetchError.InvalidURL(rawUrl)
                }
                queryBudget += count
            }
            if (queryBudget > MAX_REQUEST_URL_BYTES - 2L) throw FetchError.InvalidURL(rawUrl)
            queryBudget += 2L
        }
        val urlBuilder = url.newBuilder()
        for ((key, value) in query.entries.sortedBy { it.key }) {
            urlBuilder.addQueryParameter(key, value)
        }
        val finalUrl = urlBuilder.build()
        if (!validBoundedText(finalUrl.toString(), MAX_REQUEST_URL_BYTES, rejectControls = true) ||
            URI(finalUrl.toString()).rawUserInfo != null) {
            throw FetchError.InvalidURL(rawUrl)
        }

        val trimmedMethod = rawMethod.trim()
        if (!validBoundedText(trimmedMethod, MAX_REQUEST_METHOD_BYTES, rejectControls = false)) {
            throw FetchError.Transport(IllegalArgumentException("invalid HTTP method"))
        }
        val method = trimmedMethod.uppercase(Locale.ROOT).ifEmpty { "GET" }
        if (utf8SizeAtMost(method, MAX_REQUEST_METHOD_BYTES) > MAX_REQUEST_METHOD_BYTES ||
            method.any { !isHTTPToken(it) }) {
            throw FetchError.Transport(IllegalArgumentException("invalid HTTP method"))
        }
        if (!headersAreValid(headers)) {
            throw FetchError.Transport(IllegalArgumentException("invalid HTTP headers"))
        }
        val headerBuilder = Headers.Builder()
        for ((key, value) in headers) headerBuilder.add(key, value)
        val contentType = headers.entries.firstOrNull {
            it.key.equals("content-type", ignoreCase = true)
        }?.value?.toMediaTypeOrNull()
        val requestBody = bodyBytes(body)?.let { bytes ->
            val mediaType = contentType ?: when (body) {
                is ByteArray, is String -> null
                else -> "application/json; charset=utf-8".toMediaTypeOrNull()
            }
            bytes.toRequestBody(mediaType)
        } ?: if (method in setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")) {
            ByteArray(0).toRequestBody(contentType)
        } else {
            null
        }
        return Request.Builder()
            .url(finalUrl)
            .headers(headerBuilder.build())
            .method(method, requestBody)
            .build()
    }

    private fun resolve(raw: String): HttpUrl? {
        val value = raw.trim()
        if (!validBoundedText(value, MAX_REQUEST_URL_BYTES, rejectControls = true)) return null
        // Never let an authored relative request replace the manifest origin. Backslashes are
        // included because URL parsers and intermediaries do not agree on whether they are path
        // separators; rejecting every two-separator variant keeps that ambiguity fail-closed.
        if (isNetworkPathReference(value)) return null
        value.toHttpUrlOrNull()?.let { return validateResolvedURL(it) }
        val origin = originProvider()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (!validBoundedText(origin, MAX_REQUEST_URL_BYTES, rejectControls = true)) return null
        // AppManifest returns a bare production host and a full scheme+port only for
        // non-production overrides. Preserve the latter; HTTPS-prefix the former.
        val normalized = if (origin.contains("://")) origin else "https://$origin"
        val base = normalized.toHttpUrlOrNull() ?: return null
        return base.resolve(value)?.let(::validateResolvedURL)
    }

    private fun isNetworkPathReference(value: String): Boolean =
        value.length >= 2 &&
            (value[0] == '/' || value[0] == '\\') &&
            (value[1] == '/' || value[1] == '\\')

    private fun validateResolvedURL(url: HttpUrl): HttpUrl? {
        if (url.scheme != "http" && url.scheme != "https") return null
        if (url.host.isEmpty() || URI(url.toString()).rawUserInfo != null) return null
        return url.takeIf {
            validBoundedText(it.toString(), MAX_REQUEST_URL_BYTES, rejectControls = true)
        }
    }

    private fun headersAreValid(headers: Map<String, String>): Boolean {
        if (headers.size > MAX_REQUEST_HEADER_COUNT) return false
        var total = 0L
        for ((name, value) in headers) {
            val nameBytes = utf8SizeAtMost(name, MAX_REQUEST_HEADER_NAME_BYTES)
            if (nameBytes <= 0L || nameBytes > MAX_REQUEST_HEADER_NAME_BYTES ||
                name.any { !isHTTPToken(it) } || !hasValidUnicode(name) ||
                nameBytes > MAX_REQUEST_HEADER_BYTES - total) return false
            total += nameBytes
            val valueBytes = utf8SizeAtMost(value, MAX_REQUEST_HEADER_BYTES - total)
            if (!hasValidUnicode(value) || value.any(Character::isISOControl) ||
                valueBytes > MAX_REQUEST_HEADER_BYTES - total) return false
            total += valueBytes
        }
        return true
    }

    private fun isHTTPToken(value: Char): Boolean = when (value.code) {
        in 0x30..0x39, in 0x41..0x5A, in 0x61..0x7A,
        0x21, in 0x23..0x27, 0x2A, 0x2B, 0x2D, 0x2E,
        0x5E, 0x5F, 0x60, 0x7C, 0x7E -> true
        else -> false
    }

    private fun validBoundedText(value: String, maximumBytes: Long, rejectControls: Boolean): Boolean =
        hasValidUnicode(value) &&
            (!rejectControls || value.none(Character::isISOControl)) &&
            utf8SizeAtMost(value, maximumBytes) <= maximumBytes

    private fun hasValidUnicode(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val code = value[index].code
            if (code in 0xD800..0xDBFF) {
                if (index + 1 >= value.length || value[index + 1].code !in 0xDC00..0xDFFF) return false
                index += 2
                continue
            }
            if (code in 0xDC00..0xDFFF) return false
            index += 1
        }
        return true
    }

    internal fun resolvedUrlForTests(raw: String): String? = resolve(raw)?.toString()
    internal fun followsCrossSchemeRedirectsForTests(): Boolean = client.followSslRedirects

    private fun bodyBytes(body: Any?): ByteArray? {
        if (body == null || body === NSNull) return null
        preflightBody(body)
        val bytes = when (body) {
            is ByteArray -> body
            is String -> body.toByteArray(Charsets.UTF_8)
            is JSON -> body.toString().toByteArray(Charsets.UTF_8)
            else -> JSON.from(body).toString().toByteArray(Charsets.UTF_8)
        }
        if (bytes.size.toLong() > MAX_API_REQUEST_BODY_BYTES) throw RequestBodyTooLarge()
        return bytes
    }

    /** Bound hostile/deep authored request objects before recursive JSON conversion.
     * The exact serialized-byte check follows this structural pass. */
    private fun preflightBody(root: Any?) {
        if (root is ByteArray) {
            if (root.size.toLong() > MAX_API_REQUEST_BODY_BYTES) throw RequestBodyTooLarge()
            return
        }
        if (root is String) {
            if (utf8SizeAtMost(root, MAX_API_REQUEST_BODY_BYTES) > MAX_API_REQUEST_BODY_BYTES) {
                throw RequestBodyTooLarge()
            }
            return
        }
        val pending = ArrayDeque<Pair<Any?, Int>>()
        pending.add(root to 0)
        var nodes = 0
        var stringBytes = 0L
        while (pending.isNotEmpty()) {
            val (value, depth) = pending.removeLast()
            nodes += 1
            if (nodes > MAX_REQUEST_BODY_NODES || depth > MAX_REQUEST_BODY_DEPTH) {
                throw RequestBodyTooLarge()
            }
            when (value) {
                null, NSNull, is Number, is Boolean, is JSON -> Unit
                is String -> {
                    stringBytes += utf8SizeAtMost(
                        value,
                        MAX_API_REQUEST_BODY_BYTES - stringBytes,
                    )
                    if (stringBytes > MAX_API_REQUEST_BODY_BYTES) throw RequestBodyTooLarge()
                }
                is ByteArray -> {
                    stringBytes += value.size
                    if (stringBytes > MAX_API_REQUEST_BODY_BYTES) throw RequestBodyTooLarge()
                }
                is Map<*, *> -> {
                    for ((key, child) in value) {
                        pending.add(key to depth + 1)
                        pending.add(child to depth + 1)
                    }
                }
                is Iterable<*> -> value.forEach { pending.add(it to depth + 1) }
                is Array<*> -> value.forEach { pending.add(it to depth + 1) }
                else -> pending.add(value.toString() to depth + 1)
            }
        }
    }

    /** UTF-8 length without allocating the encoded byte array. Stops once [limit] is
     * exceeded; lone surrogates are conservatively charged as three bytes. */
    private fun utf8SizeAtMost(value: String, limit: Long): Long {
        var bytes = 0L
        var index = 0
        while (index < value.length && bytes <= limit) {
            val code = value[index].code
            bytes += when {
                code < 0x80 -> 1
                code < 0x800 -> 2
                code in 0xD800..0xDBFF &&
                    index + 1 < value.length &&
                    value[index + 1].code in 0xDC00..0xDFFF -> {
                    index += 1
                    4
                }
                else -> 3
            }
            index += 1
        }
        return bytes
    }

    private fun flattenHeaders(headers: Headers): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (name in headers.names()) out[name] = headers.values(name).joinToString(", ")
        return out
    }

    private fun apiEnvelope(response: FetchResponse, rawExpect: Any?): Map<String, Any?> {
        val contentType = response.headers.entries.firstOrNull {
            it.key.equals("content-type", ignoreCase = true)
        }?.value.orEmpty()
        if (response.streamed) {
            return linkedMapOf(
                "ok" to response.ok,
                "status" to response.status.toDouble(),
                "data" to null,
                "headers" to response.headers,
                // ApiBlock already owns the incrementally accumulated list. This marker
                // finalizes it without replaying buffered `stream` messages at EOF.
                "streamed" to true,
            )
        }
        val expect = JSE.string(rawExpect).ifEmpty { "json" }.lowercase()
        val text = response.text()
        val data: Any? = try {
            when {
                expect == "blob" -> linkedMapOf<String, Any?>(
                    "__blob" to response.body.toByteString().base64(),
                    "type" to contentType.substringBefore(";").trim(),
                    "size" to response.body.size.toDouble(),
                )
                expect == "text" -> text
                contentType.contains("text/event-stream", ignoreCase = true) -> {
                    text.lineSequence()
                        .map { it.trimEnd() }
                        .filter { it.startsWith("data:") }
                        .map { line ->
                            val payload = line.substringAfter("data:").trim()
                            decodeJsonOrText(payload)
                        }
                        .toList()
                }
                // Match browser/Foundation fetch semantics deliberately: the default
                // decode mode respects MIME. `expect=json` is the default but does not
                // reinterpret a text/plain payload as JSON.
                contentType.contains("json", ignoreCase = true) ->
                    if (text.isEmpty()) null else decodeJsonStrict(text)
                else -> text
            }
        } catch (_: Exception) {
            return linkedMapOf(
                "ok" to false,
                "status" to -2.0,
                "data" to null,
                "error" to "invalid_response",
                "headers" to response.headers,
            )
        }
        val out = linkedMapOf<String, Any?>(
            "ok" to response.ok,
            "status" to response.status.toDouble(),
            "data" to data,
            "headers" to response.headers,
        )
        if (contentType.contains("text/event-stream", ignoreCase = true) && data is List<*>) {
            out["stream"] = data
        }
        if (!response.ok) out["error"] = "http ${response.status}"
        return out
    }

    private fun decodeJsonStrict(text: String): Any? {
        val decoded = json(text).foundationValue
        if (decoded == null && text.trim() != "null") {
            throw IllegalArgumentException("invalid JSON response")
        }
        return decoded
    }

    private fun decodeJsonOrText(text: String): Any? =
        runCatching { decodeJsonStrict(text) }.getOrElse { text }
}
