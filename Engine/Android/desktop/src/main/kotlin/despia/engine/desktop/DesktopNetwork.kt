package despia.engine.desktop

import despia.engine.ContentFetch
import despia.engine.ContentResponse
import despia.engine.ContentStore
import despia.engine.Context
import despia.engine.DSXContent
import despia.engine.ApiBlock
import despia.engine.ApiBlockAsyncFetch
import despia.engine.ApiBlockFetchCall
import despia.engine.DSXCookies
import despia.engine.FetchError
import despia.engine.FetchResponse
import despia.engine.JSEFetch
import despia.engine.JSEFetchResponse
import despia.engine.JSERunner
import despia.engine.JSON
import despia.engine.JSE
import despia.engine.json
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.CookieManager
import java.net.CookiePolicy
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.Locale
import java.util.Base64
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/** JDK-native HTTP plane for the open desktop targets. It deliberately has no
 * browser dependency: DSX API calls work in a pure native app and share one bounded,
 * TLS-first client. */
object DesktopNetwork {
    private const val MAX_REQUEST_BYTES = 4L * 1024L * 1024L
    private const val MAX_RESPONSE_BYTES = 16L * 1024L * 1024L
    private const val MAX_CONTENT_BYTES = 64L * 1024L * 1024L
    private const val MAX_SSE_EVENTS = 10_000
    private const val MAX_SSE_EVENT_BYTES = 64L * 1024L
    private const val MAX_SSE_DATA_BYTES = 1L * 1024L * 1024L
    private const val MAX_JSON_NODES = 50_000
    private const val MAX_JSON_DEPTH = 256
    private const val DEFAULT_TIMEOUT_SECONDS = 30.0
    private const val MAX_REDIRECTS = 8
    private const val MAX_IN_FLIGHT_REQUESTS = 128
    private val CROSS_ORIGIN_REDIRECT_HEADERS = setOf(
        "accept",
        "accept-language",
        "content-language",
        "content-type",
        "range",
    )

    private val executor: ExecutorService = ThreadPoolExecutor(
        4,
        4,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(256),
        { task -> Thread(task, "dsx-desktop-http").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )
    // Body streams can block after the response headers have arrived. They must not
    // consume the HttpClient executor: doing so lets four slow peers prevent every
    // other request (including cancellation/redirect continuations) from progressing.
    // This pool is deliberately bounded; the request-start deadline below also closes
    // streams while work is queued, so saturation is finite rather than an unbounded
    // thread/memory commitment.
    private val bodyExecutor: ExecutorService = ThreadPoolExecutor(
        8,
        8,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(64),
        { task -> Thread(task, "dsx-desktop-http-body").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )
    private val deadlineExecutor = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "dsx-desktop-http-deadline").apply { isDaemon = true }
    }.apply {
        removeOnCancelPolicy = true
        setExecuteExistingDelayedTasksAfterShutdownPolicy(false)
    }
    private val inFlightRequests = AtomicInteger()

    /** One request deadline which becomes an inactivity deadline after successful SSE
     * headers arrive. A heartbeat extends the deadline without creating one scheduled
     * task per network chunk; the current task wakes and reschedules against the latest
     * timestamp. Closing the request cancels the sole outstanding task. */
    private class ResponseDeadline(
        timeoutMillis: Long,
        private val onTimeout: () -> Unit,
    ) {
        private val lock = Any()
        private val timeoutNanos = TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        @Volatile private var deadlineNanos = System.nanoTime() + timeoutNanos
        @Volatile private var idleMode = false
        private var closed = false
        private var task: ScheduledFuture<*>? = null

        init {
            synchronized(lock) { scheduleLocked() }
        }

        fun currentNanos(): Long = deadlineNanos

        fun remainingNanos(): Long = (deadlineNanos - System.nanoTime()).coerceAtLeast(0L)

        fun check() {
            if (System.nanoTime() >= deadlineNanos) {
                throw HttpTimeoutException(if (idleMode) "SSE stream idle timeout" else "request timed out")
            }
        }

        fun enterIdleMode() {
            synchronized(lock) {
                if (closed) return
                idleMode = true
                deadlineNanos = System.nanoTime() + timeoutNanos
            }
        }

        fun touchIdle() {
            if (!idleMode) return
            synchronized(lock) {
                if (!closed && idleMode) deadlineNanos = System.nanoTime() + timeoutNanos
            }
        }

        fun close() {
            val pending = synchronized(lock) {
                if (closed) return
                closed = true
                task.also { task = null }
            }
            pending?.cancel(false)
        }

        private fun scheduleLocked() {
            val delay = (deadlineNanos - System.nanoTime()).coerceAtLeast(1L)
            task = deadlineExecutor.schedule(
                {
                    var expired = false
                    synchronized(lock) {
                        if (!closed) {
                            if (System.nanoTime() >= deadlineNanos) {
                                closed = true
                                task = null
                                expired = true
                            } else {
                                scheduleLocked()
                            }
                        }
                    }
                    if (expired) onTimeout()
                },
                delay,
                TimeUnit.NANOSECONDS,
            )
        }
    }
    private val cookies = CookieManager(null, CookiePolicy.ACCEPT_ORIGINAL_SERVER)
    private val client: HttpClient = HttpClient.newBuilder()
        .executor(executor)
        .cookieHandler(cookies)
        .connectTimeout(Duration.ofSeconds(15))
        // Redirects are followed manually so every target is subjected to the same
        // HTTPS/loopback-cleartext policy as the original request.
        .followRedirects(HttpClient.Redirect.NEVER)
        .version(HttpClient.Version.HTTP_2)
        .build()
    // Media declared by authored DSX is deliberately anonymous. Reusing the API
    // client's CookieManager here would silently attach application credentials to
    // an image CDN (and again after redirects). The transport and redirect policy are
    // shared; only the credential store is absent.
    private val anonymousClient: HttpClient = HttpClient.newBuilder()
        .executor(executor)
        .connectTimeout(Duration.ofSeconds(15))
        .followRedirects(HttpClient.Redirect.NEVER)
        .version(HttpClient.Version.HTTP_2)
        .build()

    internal data class AnonymousMediaResponse(
        val status: Int,
        val contentType: String,
        val body: ByteArray,
    )

    internal data class AnonymousMediaStreamMetadata(
        val status: Int,
        val contentType: String,
        val contentLength: Long?,
        val headers: Map<String, String>,
        val effectiveUri: URI,
    )

    /** Bounded, cancellation-aware, credential-free media fetch. It intentionally
     * enters the same URI and per-hop redirect validator as API traffic. */
    internal suspend fun fetchAnonymousMedia(
        url: String,
        maxBytes: Long,
        timeoutSeconds: Double = 20.0,
    ): AnonymousMediaResponse {
        require(maxBytes in 1..MAX_CONTENT_BYTES) { "invalid media response limit" }
        val response = request(
            url = url,
            method = "GET",
            headers = emptyMap(),
            query = emptyMap(),
            body = null,
            timeoutSeconds = timeoutSeconds,
            maxResponseBytes = maxBytes,
            transport = anonymousClient,
        )
        return AnonymousMediaResponse(
            status = response.status,
            contentType = response.headers.entries.firstOrNull {
                it.key.equals("content-type", ignoreCase = true)
            }?.value.orEmpty().substringBefore(';').trim().lowercase(Locale.ROOT),
            body = response.body,
        )
    }

    /** Streams a remote media response without buffering it in the JVM heap. Only a
     * single RFC 7233 byte range may be forwarded, and the anonymous client plus the
     * per-hop transport validator remain mandatory. The consumer chooses the output
     * after seeing sanitized metadata; returning null drains no body (used for HEAD).
     *
     * The byte ceiling is per response. Callers must enforce their own aggregate
     * session budget as bytes are written. A successful header response switches the
     * request deadline to an inactivity deadline, so long media can play while a peer
     * that stops sending is still terminated deterministically. */
    internal suspend fun streamAnonymousMedia(
        url: String,
        method: String,
        range: String?,
        maxBytes: Long,
        timeoutSeconds: Double = 30.0,
        output: (AnonymousMediaStreamMetadata) -> OutputStream?,
    ): AnonymousMediaStreamMetadata = suspendCancellableCoroutine { continuation ->
        require(maxBytes in 1..8L * 1024L * 1024L * 1024L) { "invalid media stream limit" }
        val normalizedMethod = method.trim().uppercase(Locale.ROOT)
        require(normalizedMethod == "GET" || normalizedMethod == "HEAD") { "media proxy accepts GET or HEAD" }
        val normalizedRange = range?.trim()?.takeIf(String::isNotEmpty)
        require(
            normalizedRange == null || normalizedRange.length <= 128 &&
                normalizedRange.matches(Regex("bytes=(?:[0-9]+-[0-9]*|-[0-9]+)"))
        ) { "invalid media byte range" }
        val headers = normalizedRange?.let { mapOf("Range" to it) }.orEmpty()
        val future = try {
            requestAsyncBody(
                rawUrl = url,
                rawMethod = normalizedMethod,
                headers = headers,
                query = emptyMap(),
                body = null,
                timeoutSeconds = timeoutSeconds,
                maxResponseBytes = maxBytes,
                transport = anonymousClient,
            ) { response, input, deadline, terminal ->
                val visible = visibleResponseHeaders(response)
                val contentType = visible.entries.firstOrNull {
                    it.key.equals("content-type", ignoreCase = true)
                }?.value.orEmpty().substringBefore(';').trim().lowercase(Locale.ROOT)
                val advertised = response.headers().firstValueAsLong("Content-Length").orElse(-1L)
                val metadata = AnonymousMediaStreamMetadata(
                    status = response.statusCode(),
                    contentType = contentType,
                    contentLength = advertised.takeIf { it >= 0L },
                    headers = visible,
                    effectiveUri = response.uri(),
                )
                val sink = output(metadata)
                if (sink != null && normalizedMethod != "HEAD") {
                    deadline.enterIdleMode()
                    streamMediaBounded(input, sink, maxBytes, deadline, terminal)
                }
                metadata
            }
        } catch (failure: Throwable) {
            continuation.resumeWithException(asFetchError(url, failure))
            return@suspendCancellableCoroutine
        }
        future.whenComplete { metadata, failure ->
            if (!continuation.isActive) return@whenComplete
            if (failure != null) continuation.resumeWithException(asFetchError(url, unwrap(failure)))
            else continuation.resume(metadata)
        }
        continuation.invokeOnCancellation { future.cancel(true) }
    }

    /** Validation-only form used before an authored media URI is registered with the
     * native decoder gateway. No credentials or API-cookie state participate. */
    internal fun validateAnonymousMediaUrl(url: String): URI = validatedUri(url, emptyMap())

    @Synchronized
    fun install() {
        Context.fetchImpl = { url, method, headers, query, body, timeout ->
            request(url, method, headers, query, encodeBody(body), timeout, MAX_RESPONSE_BYTES)
        }
        Context.controlFetchImpl = { url, method, headers, query, body, timeout ->
            request(url, method, headers, query, encodeBody(body), timeout, 4L * 1024L * 1024L)
        }
        JSERunner.fetch = JSEFetch { url, method, headers, body, completion ->
            requestAsync(url, method, headers, emptyMap(), body, DEFAULT_TIMEOUT_SECONDS, MAX_RESPONSE_BYTES)
                .whenComplete { response, failure ->
                    completion(if (failure == null) JSEFetchResponse(response.status, response.headers, response.body) else null)
                }
        }
        ContentStore.shared.fetch = object : ContentFetch {
            override suspend fun data(url: String): ContentResponse? = try {
                val response = request(url, "GET", emptyMap(), emptyMap(), null, DEFAULT_TIMEOUT_SECONDS, 4L * 1024L * 1024L)
                ContentResponse(response.status, response.body, response.headers)
            } catch (_: Exception) {
                null
            }

            override suspend fun download(url: String, dest: java.io.File): Int? = try {
                downloadToFile(url, dest, configuredContentLimitBytes())
            } catch (_: Exception) {
                null
            }
        }
        DSXCookies.shared.nativeStore = { cookie ->
            val domain = cookie.domain?.trim()?.removePrefix(".")?.takeIf(String::isNotEmpty)
            if (domain != null) runCatching {
                cookies.cookieStore.add(URI("https", domain, cookie.path ?: "/", null), cookie)
            }
        }
        ApiBlock.cachePartition = { "desktop-cookie:${JSE.watchKey(DSXCookies.shared.jar)}" }
        ApiBlock.requestCachePartition = { request ->
            val uri = runCatching { validatedUri(JSE.string(request["url"]), emptyMap()) }.getOrNull()
            if (uri == null) "invalid-url" else {
                val partition = cookies.cookieStore.get(uri)
                    .filterNot(java.net.HttpCookie::hasExpired)
                    .sortedWith(compareBy({ it.name }, { it.domain.orEmpty() }, { it.path.orEmpty() }))
                    .map { linkedMapOf("name" to it.name, "value" to it.value) }
                "desktop-cookie:${JSE.watchKey(partition)}"
            }
        }
        JSE.cookieJar = { DSXCookies.shared.jar }
        JSERunner.cookieSet = { name, value -> DSXCookies.shared.set(name, value) }
    }

    /** Completion transport used by native desktop `<api>` declarations. The JDK
     * future is the cancellation token; every terminal completion rejoins the DSX UI
     * executor installed by [DesktopUiDispatcher]. */
    val apiFetch: ApiBlockAsyncFetch = ApiBlockAsyncFetch { rawUrl, request, completion ->
        val deliveryLock = Any()
        var terminalDelivered = false
        fun dispatch(envelope: Map<String, Any?>, terminal: Boolean) {
            JSERunner.mainExecutor.execute {
                val accepted = synchronized(deliveryLock) {
                    if (terminalDelivered) false
                    else {
                        if (terminal) terminalDelivered = true
                        true
                    }
                }
                if (accepted) completion(envelope)
            }
        }
        val method = JSE.string(request["method"]).ifEmpty { "GET" }
        val headers = LinkedHashMap<String, String>()
        @Suppress("UNCHECKED_CAST")
        for ((key, value) in (request["headers"] as? Map<String, Any?>) ?: emptyMap()) {
            headers[key] = JSE.string(value)
        }
        val timeout = JSE.number(request["timeout"]) ?: DEFAULT_TIMEOUT_SECONDS
        val future = try {
            requestApiAsync(
                rawUrl = rawUrl,
                rawMethod = method,
                headers = headers,
                query = emptyMap(),
                body = encodeBody(request["body"]),
                timeoutSeconds = timeout,
                maxResponseBytes = MAX_RESPONSE_BYTES,
                onSseMessage = { message ->
                    dispatch(
                        linkedMapOf(
                            "partial" to true,
                            "message" to message,
                        ),
                        terminal = false,
                    )
                },
            )
        } catch (failure: Throwable) {
            dispatch(failureEnvelope(failure), terminal = true)
            return@ApiBlockAsyncFetch ApiBlockFetchCall {}
        }
        future.whenComplete { response, failure ->
            val envelope = when {
                failure == null -> apiEnvelope(response, request["expect"])
                future.isCancelled -> linkedMapOf(
                    "ok" to false, "status" to -1.0, "data" to null, "aborted" to true,
                )
                else -> failureEnvelope(unwrap(failure))
            }
            dispatch(envelope, terminal = true)
        }
        ApiBlockFetchCall { future.cancel(true) }
    }

    private suspend fun request(
        url: String,
        method: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: ByteArray?,
        timeoutSeconds: Double,
        maxResponseBytes: Long,
        transport: HttpClient = client,
    ): FetchResponse = suspendCancellableCoroutine { continuation ->
        val future = try {
            requestAsync(url, method, headers, query, body, timeoutSeconds, maxResponseBytes, transport)
        } catch (failure: Throwable) {
            continuation.resumeWithException(asFetchError(url, failure))
            return@suspendCancellableCoroutine
        }
        future.whenComplete { response, failure ->
            if (!continuation.isActive) return@whenComplete
            if (failure != null) continuation.resumeWithException(asFetchError(url, unwrap(failure)))
            else continuation.resume(response)
        }
        continuation.invokeOnCancellation { future.cancel(true) }
    }

    private fun requestAsync(
        rawUrl: String,
        rawMethod: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: ByteArray?,
        timeoutSeconds: Double,
        maxResponseBytes: Long,
        transport: HttpClient = client,
    ): CompletableFuture<FetchResponse> = requestAsyncBody(
        rawUrl = rawUrl,
        rawMethod = rawMethod,
        headers = headers,
        query = query,
        body = body,
        timeoutSeconds = timeoutSeconds,
        maxResponseBytes = maxResponseBytes,
        transport = transport,
    ) { response, input, deadline, terminal ->
        val bytes = readBounded(input, maxResponseBytes, deadline.currentNanos(), terminal)
        FetchResponse(response.statusCode(), visibleResponseHeaders(response), bytes)
    }

    private fun requestApiAsync(
        rawUrl: String,
        rawMethod: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: ByteArray?,
        timeoutSeconds: Double,
        maxResponseBytes: Long,
        onSseMessage: (Any?) -> Unit,
    ): CompletableFuture<FetchResponse> = requestAsyncBody(
        rawUrl = rawUrl,
        rawMethod = rawMethod,
        headers = headers,
        query = query,
        body = body,
        timeoutSeconds = timeoutSeconds,
        maxResponseBytes = maxResponseBytes,
        transport = client,
    ) { response, input, deadline, terminal ->
        val responseHeaders = visibleResponseHeaders(response)
        val contentType = responseHeaders.entries.firstOrNull {
            it.key.equals("content-type", ignoreCase = true)
        }?.value.orEmpty()
        if (response.statusCode() in 200..299 && isEventStreamContentType(contentType)) {
            deadline.enterIdleMode()
            readServerSentEvents(input, maxResponseBytes, deadline, terminal, onSseMessage)
            FetchResponse(
                status = response.statusCode(),
                headers = responseHeaders,
                body = ByteArray(0),
                streamed = true,
            )
        } else {
            val bytes = readBounded(input, maxResponseBytes, deadline.currentNanos(), terminal)
            FetchResponse(response.statusCode(), responseHeaders, bytes)
        }
    }

    private fun <T> requestAsyncBody(
        rawUrl: String,
        rawMethod: String,
        headers: Map<String, String>,
        query: Map<String, String>,
        body: ByteArray?,
        timeoutSeconds: Double,
        maxResponseBytes: Long,
        transport: HttpClient = client,
        bodyReader: (HttpResponse<InputStream>, InputStream, ResponseDeadline, () -> Boolean) -> T,
    ): CompletableFuture<T> {
        require(body == null || body.size.toLong() <= MAX_REQUEST_BYTES) { "request body exceeds ${MAX_REQUEST_BYTES}B limit" }
        require(headers.size <= 128) { "too many request headers" }
        val uri = validatedUri(rawUrl, query)
        val method = rawMethod.trim().uppercase(Locale.ROOT).ifEmpty { "GET" }
        require(method.matches(Regex("[A-Z]{1,16}"))) { "invalid HTTP method" }
        val timeout = timeoutSeconds.takeIf { it.isFinite() && it > 0.0 }
            ?.coerceIn(0.001, 600.0) ?: DEFAULT_TIMEOUT_SECONDS
        headers.forEach { (name, value) ->
            require(name.matches(Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}"))) { "invalid HTTP header name" }
            require(!value.contains('\r') && !value.contains('\n') && value.length <= 16_384) { "invalid HTTP header value" }
        }

        val timeoutMillis = (timeout * 1000.0).toLong().coerceAtLeast(1L)
        if (inFlightRequests.incrementAndGet() > MAX_IN_FLIGHT_REQUESTS) {
            inFlightRequests.decrementAndGet()
            throw RejectedExecutionException("too many concurrent desktop HTTP requests")
        }
        val result = CompletableFuture<T>()
        val activeRequest = AtomicReference<CompletableFuture<HttpResponse<InputStream>>?>()
        val activeBody = AtomicReference<InputStream?>()

        fun cancelTransport() {
            runCatching { activeBody.getAndSet(null)?.close() }
            activeRequest.getAndSet(null)?.cancel(true)
        }
        val deadline = try {
            ResponseDeadline(timeoutMillis) {
                if (result.completeExceptionally(HttpTimeoutException("request timed out"))) {
                    cancelTransport()
                }
            }
        } catch (failure: Throwable) {
            inFlightRequests.decrementAndGet()
            throw failure
        }
        result.whenComplete { _, _ ->
            deadline.close()
            // Every terminal path owns no live transport. In particular this closes a
            // blocking body read for both explicit cancellation and the hard deadline.
            cancelTransport()
            inFlightRequests.decrementAndGet()
        }

        lateinit var sendHop: (URI, String, Map<String, String>, ByteArray?, Int) -> Unit
        sendHop = send@{ target, hopMethod, hopHeaders, hopBody, redirects ->
            if (result.isDone) return@send
            val remainingNanos = deadline.remainingNanos()
            if (remainingNanos <= 0L) {
                result.completeExceptionally(HttpTimeoutException("request timed out"))
                return@send
            }

            val request = try {
                buildRequest(target, hopMethod, hopHeaders, hopBody, Duration.ofNanos(remainingNanos))
            } catch (failure: Throwable) {
                result.completeExceptionally(failure)
                return@send
            }
            val upstream = try {
                transport.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream())
            } catch (failure: Throwable) {
                result.completeExceptionally(failure)
                return@send
            }
            check(activeRequest.compareAndSet(null, upstream)) { "concurrent desktop HTTP hop" }
            if (result.isDone && activeRequest.compareAndSet(upstream, null)) {
                upstream.cancel(true)
                return@send
            }

            upstream.whenComplete { response, failure ->
                activeRequest.compareAndSet(upstream, null)
                if (failure != null) {
                    if (!result.isDone) result.completeExceptionally(unwrap(failure))
                    return@whenComplete
                }

                val input = response.body()
                activeBody.set(input)
                if (result.isDone) {
                    if (activeBody.compareAndSet(input, null)) runCatching { input.close() }
                    return@whenComplete
                }

                val location = response.headers().firstValue("Location").orElse(null)
                if (location != null && isRedirect(response.statusCode())) {
                    if (activeBody.compareAndSet(input, null)) runCatching { input.close() }
                    if (redirects >= MAX_REDIRECTS) {
                        result.completeExceptionally(IOException("too many HTTP redirects"))
                        return@whenComplete
                    }
                    val next = try {
                        validatedRedirectUri(target, location)
                    } catch (redirectFailure: Throwable) {
                        result.completeExceptionally(redirectFailure)
                        return@whenComplete
                    }
                    val rewriteToGet = response.statusCode() == 303 && hopMethod != "HEAD" ||
                        response.statusCode() in 301..302 && hopMethod == "POST"
                    val nextMethod = if (rewriteToGet) "GET" else hopMethod
                    val nextBody = if (rewriteToGet) null else hopBody
                    if (!sameOrigin(target, next) && nextBody != null) {
                        result.completeExceptionally(IOException("cross-origin redirect with request body is forbidden"))
                        return@whenComplete
                    }
                    val nextHeaders = redirectedHeaders(hopHeaders, target, next, rewriteToGet)
                    sendHop(next, nextMethod, nextHeaders, nextBody, redirects + 1)
                    return@whenComplete
                }

                try {
                    bodyExecutor.execute {
                        try {
                            if (result.isDone) return@execute
                            val advertised = response.headers().firstValueAsLong("Content-Length").orElse(-1L)
                            if (advertised > maxResponseBytes) {
                                throw IOException("response body exceeds ${maxResponseBytes}B limit")
                            }
                            val decoded = bodyReader(response, input, deadline) { result.isDone }
                            if (result.isDone) return@execute
                            result.complete(decoded)
                        } catch (readFailure: Throwable) {
                            if (!result.isDone) result.completeExceptionally(readFailure)
                        } finally {
                            activeBody.compareAndSet(input, null)
                            runCatching { input.close() }
                        }
                    }
                } catch (dispatchFailure: Throwable) {
                    if (activeBody.compareAndSet(input, null)) runCatching { input.close() }
                    if (!result.isDone) result.completeExceptionally(dispatchFailure)
                }
            }
        }

        sendHop(uri, method, LinkedHashMap(headers), body, 0)
        return result
    }

    private suspend fun downloadToFile(
        rawUrl: String,
        destination: java.io.File,
        maxBytes: Long,
    ): Int? = suspendCancellableCoroutine { continuation ->
        val future = try {
            requestAsyncBody<Int?>(
                rawUrl = rawUrl,
                rawMethod = "GET",
                headers = emptyMap(),
                query = emptyMap(),
                body = null,
                timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
                maxResponseBytes = maxBytes,
            ) bodyReader@{ response, input, deadline, terminal ->
                if (response.statusCode() !in 200..299) return@bodyReader null
                val target = destination.toPath().toAbsolutePath().normalize()
                val parent = target.parent ?: throw IOException("download destination needs a parent")
                java.nio.file.Files.createDirectories(parent)
                val temporary = java.nio.file.Files.createTempFile(parent, ".dsx-download-", ".tmp")
                try {
                    java.nio.file.Files.newOutputStream(
                        temporary,
                        java.nio.file.StandardOpenOption.WRITE,
                        java.nio.file.StandardOpenOption.TRUNCATE_EXISTING,
                        java.nio.file.LinkOption.NOFOLLOW_LINKS,
                    ).use { output ->
                        streamBounded(input, output, maxBytes, deadline.currentNanos(), terminal)
                    }
                    try {
                        java.nio.file.Files.move(
                            temporary,
                            target,
                            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        )
                    } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                        java.nio.file.Files.move(
                            temporary,
                            target,
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        )
                    }
                } finally {
                    java.nio.file.Files.deleteIfExists(temporary)
                }
                response.statusCode()
            }
        } catch (failure: Throwable) {
            continuation.resumeWithException(asFetchError(rawUrl, failure))
            return@suspendCancellableCoroutine
        }
        future.whenComplete { status, failure ->
            if (!continuation.isActive) return@whenComplete
            if (failure != null) continuation.resumeWithException(asFetchError(rawUrl, unwrap(failure)))
            else continuation.resume(status)
        }
        continuation.invokeOnCancellation { future.cancel(true) }
    }

    private fun configuredContentLimitBytes(): Long = Math.multiplyExact(
        DSXContent.contentMaxBlobMB().coerceIn(1, 2_048).toLong(),
        1_048_576L,
    )

    private fun visibleResponseHeaders(response: HttpResponse<*>): Map<String, String> {
        val flattened = LinkedHashMap<String, String>()
        response.headers().map().toSortedMap(String.CASE_INSENSITIVE_ORDER).forEach { (name, values) ->
            // Fetch forbids exposing these credential-bearing response headers to
            // scripts. HttpClient's CookieManager has already consumed them here.
            if (!name.equals("set-cookie", ignoreCase = true) &&
                !name.equals("set-cookie2", ignoreCase = true)
            ) {
                flattened[name] = values.joinToString(", ")
            }
        }
        return flattened
    }

    private fun buildRequest(
        uri: URI,
        method: String,
        headers: Map<String, String>,
        body: ByteArray?,
        timeout: Duration,
    ): HttpRequest {
        val publisher = if (body == null) {
            HttpRequest.BodyPublishers.noBody()
        } else {
            HttpRequest.BodyPublishers.ofByteArray(body)
        }
        val builder = HttpRequest.newBuilder(uri).timeout(timeout).method(method, publisher)
        headers.forEach { (name, value) -> builder.header(name, value) }
        if (body != null && headers.keys.none { it.equals("content-type", ignoreCase = true) }) {
            builder.header("Content-Type", "application/json; charset=utf-8")
        }
        return builder.build()
    }

    private fun isRedirect(status: Int): Boolean =
        status == 301 || status == 302 || status == 303 || status == 307 || status == 308

    private fun validatedRedirectUri(base: URI, location: String): URI {
        val reference = try { URI(location) } catch (_: Exception) { throw FetchError.InvalidURL(location) }
        return validateTransportUri(base.resolve(reference), location)
    }

    private fun redirectedHeaders(
        headers: Map<String, String>,
        from: URI,
        to: URI,
        bodyDropped: Boolean,
    ): Map<String, String> {
        val stripped = HashSet<String>()
        val crossOrigin = !sameOrigin(from, to)
        if (bodyDropped) {
            stripped += setOf("content-length", "content-type", "transfer-encoding")
        }
        return headers.filterKeys { name ->
            val normalized = name.lowercase(Locale.ROOT)
            normalized !in stripped && (!crossOrigin || normalized in CROSS_ORIGIN_REDIRECT_HEADERS)
        }
    }

    private fun sameOrigin(left: URI, right: URI): Boolean =
        left.scheme.equals(right.scheme, ignoreCase = true) &&
            left.host.equals(right.host, ignoreCase = true) &&
            effectivePort(left) == effectivePort(right)

    private fun effectivePort(uri: URI): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        else -> 80
    }

    private fun validatedUri(raw: String, query: Map<String, String>): URI {
        val original = try { URI(raw) } catch (failure: Exception) { throw FetchError.InvalidURL(raw) }
        validateTransportUri(original, raw)
        val encoded = query.entries.joinToString("&") { (key, value) ->
            "${encodeQuery(key)}=${encodeQuery(value)}"
        }
        if (encoded.isEmpty()) return original
        val combined = listOfNotNull(original.rawQuery?.takeIf(String::isNotEmpty), encoded).joinToString("&")
        // The multi-argument URI constructor accepts decoded components, so feeding
        // it our encoded query would escape `%` again. Rebuild from validated raw
        // components to encode each query key/value exactly once.
        val rebuilt = buildString {
            append(original.scheme).append("://").append(original.rawAuthority)
            append(original.rawPath.orEmpty())
            append('?').append(combined)
            original.rawFragment?.let { append('#').append(it) }
        }
        return validateTransportUri(
            URI(rebuilt),
            raw,
        )
    }

    private fun validateTransportUri(original: URI, raw: String): URI {
        val scheme = original.scheme?.lowercase(Locale.ROOT) ?: throw FetchError.InvalidURL(raw)
        val host = original.host ?: throw FetchError.InvalidURL(raw)
        require(original.userInfo == null) { "credentials in request URLs are forbidden" }
        require(scheme == "https" || scheme == "http" && isLoopback(host)) { "desktop HTTP requires HTTPS (HTTP is loopback-only)" }
        return original
    }

    private fun isLoopback(host: String): Boolean {
        val value = host.lowercase(Locale.ROOT).removePrefix("[").removeSuffix("]")
        return value == "localhost" || value == "127.0.0.1" || value == "::1"
    }

    private fun encodeQuery(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")

    private fun encodeBody(value: Any?): ByteArray? = when (value) {
        null -> null
        is ByteArray -> value
        is String -> value.toByteArray(StandardCharsets.UTF_8)
        else -> JSON.from(value).toString().toByteArray(StandardCharsets.UTF_8)
    }.also { bytes -> require(bytes == null || bytes.size.toLong() <= MAX_REQUEST_BYTES) { "request body exceeds ${MAX_REQUEST_BYTES}B limit" } }

    private fun readBounded(
        input: java.io.InputStream,
        limit: Long,
        deadlineNanos: Long,
        terminal: () -> Boolean,
    ): ByteArray {
        val out = ByteArrayOutputStream(minOf(limit, 64L * 1024L).toInt())
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        while (true) {
            if (terminal()) throw java.util.concurrent.CancellationException("request ended during response read")
            if (System.nanoTime() >= deadlineNanos) throw HttpTimeoutException("request timed out")
            val count = input.read(buffer)
            if (count < 0) break
            if (terminal()) throw java.util.concurrent.CancellationException("request ended during response read")
            if (System.nanoTime() >= deadlineNanos) throw HttpTimeoutException("request timed out")
            total += count
            if (total > limit) throw IOException("response body exceeds ${limit}B limit")
            out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }

    internal fun streamBounded(
        input: InputStream,
        output: OutputStream,
        limit: Long,
        deadlineNanos: Long,
        terminal: () -> Boolean,
    ): Long {
        require(limit > 0L) { "response limit must be positive" }
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            if (terminal()) throw java.util.concurrent.CancellationException("request ended during response read")
            if (System.nanoTime() >= deadlineNanos) throw HttpTimeoutException("request timed out")
            val count = input.read(buffer)
            if (count < 0) break
            if (terminal()) throw java.util.concurrent.CancellationException("request ended during response read")
            if (System.nanoTime() >= deadlineNanos) throw HttpTimeoutException("request timed out")
            total = Math.addExact(total, count.toLong())
            if (total > limit) throw IOException("response body exceeds ${limit}B limit")
            output.write(buffer, 0, count)
        }
        return total
    }

    private fun streamMediaBounded(
        input: InputStream,
        output: OutputStream,
        limit: Long,
        deadline: ResponseDeadline,
        terminal: () -> Boolean,
    ): Long {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            if (terminal()) throw java.util.concurrent.CancellationException("media request ended during response read")
            deadline.check()
            val count = input.read(buffer)
            if (count < 0) break
            if (terminal()) throw java.util.concurrent.CancellationException("media request ended during response read")
            deadline.touchIdle()
            total = Math.addExact(total, count.toLong())
            if (total > limit) throw IOException("response body exceeds ${limit}B limit")
            output.write(buffer, 0, count)
        }
        return total
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
                // ApiBlock owns the incrementally accumulated list. This marker
                // finalizes it without retaining or replaying a second body copy.
                "streamed" to true,
            )
        }
        val expect = JSE.string(rawExpect).ifEmpty { "json" }.lowercase(Locale.ROOT)
        val text = response.text()
        val data: Any? = try {
            when {
                expect == "blob" -> linkedMapOf<String, Any?>(
                    "__blob" to Base64.getEncoder().encodeToString(response.body),
                    "type" to contentType.substringBefore(';').trim(),
                    "size" to response.body.size.toDouble(),
                )
                expect == "text" -> text
                isEventStreamContentType(contentType) ->
                    decodeServerSentEvents(text)
                expect == "json" -> {
                    require(isJsonContentType(contentType)) { "expected a JSON Content-Type" }
                    if (text.isEmpty()) null else decodeJsonStrict(text)
                }
                else -> text
            }
        } catch (_: Exception) {
            return linkedMapOf(
                "ok" to false, "status" to -2.0, "data" to null,
                "error" to "invalid_response", "headers" to response.headers,
            )
        }
        val out = linkedMapOf<String, Any?>(
            "ok" to response.ok,
            "status" to response.status.toDouble(),
            "data" to data,
            "headers" to response.headers,
        )
        if (isEventStreamContentType(contentType) && data is List<*>) {
            out["stream"] = data
        }
        if (!response.ok) out["error"] = "http ${response.status}"
        return out
    }

    private fun isJsonContentType(contentType: String): Boolean {
        val mediaType = contentType.substringBefore(';').trim().lowercase(Locale.ROOT)
        return mediaType == "application/json" || mediaType.endsWith("+json")
    }

    private fun isEventStreamContentType(contentType: String): Boolean =
        contentType.substringBefore(';').trim().equals("text/event-stream", ignoreCase = true)

    private fun decodeJsonStrict(text: String): Any? {
        validateJsonComplexity(text)
        val decoded = json(text).foundationValue
        if (decoded == null && text.trim() != "null") throw IllegalArgumentException("invalid JSON response")
        return decoded
    }

    private fun decodeJsonOrText(text: String): Any? =
        runCatching { decodeJsonStrict(text) }.getOrElse { text }

    private fun readServerSentEvents(
        input: InputStream,
        responseLimit: Long,
        deadline: ResponseDeadline,
        terminal: () -> Boolean,
        onMessage: (Any?) -> Unit,
    ) {
        val parser = SseParser(onMessage)
        val buffer = ByteArray(8 * 1024)
        var total = 0L
        while (true) {
            if (terminal()) throw java.util.concurrent.CancellationException("request ended during response read")
            deadline.check()
            val count = input.read(buffer)
            if (count < 0) break
            if (terminal()) throw java.util.concurrent.CancellationException("request ended during response read")
            deadline.touchIdle()
            deadline.check()
            total = Math.addExact(total, count.toLong())
            if (total > responseLimit) {
                throw IOException("response body exceeds ${responseLimit}B limit")
            }
            parser.consume(buffer, count)
        }
        parser.finish()
    }

    /** Incremental SSE framing shared by the live transport and deterministic unit
     * decoder. It follows LF, CRLF and CR line endings, ignores comments/unknown fields,
     * removes only the optional single space after `data:`, and joins a frame's data
     * fields with a newline before decoding it once. */
    private class SseParser(private val emit: (Any?) -> Unit) {
        private val line = ByteArrayOutputStream()
        private val dataLines = ArrayList<String>()
        private var frameBytes = 0L
        private var aggregateDataBytes = 0L
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
                        if (frameBytes + line.size().toLong() > MAX_SSE_EVENT_BYTES) {
                            throw IOException("SSE event exceeds the ${MAX_SSE_EVENT_BYTES}B limit")
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
            frameBytes = Math.addExact(frameBytes, line.size().toLong() + 1L)
            if (frameBytes > MAX_SSE_EVENT_BYTES) {
                throw IOException("SSE event exceeds the ${MAX_SSE_EVENT_BYTES}B limit")
            }
            var text = String(line.toByteArray(), StandardCharsets.UTF_8)
            line.reset()
            if (firstLine) {
                firstLine = false
                if (text.startsWith('\uFEFF')) text = text.drop(1)
            }
            if (text.isEmpty()) {
                dispatch()
                return
            }
            if (text.startsWith(':')) return
            val colon = text.indexOf(':')
            val field = if (colon < 0) text else text.substring(0, colon)
            if (field != "data") return
            var value = if (colon < 0) "" else text.substring(colon + 1)
            if (value.startsWith(' ')) value = value.drop(1)
            dataLines += value
        }

        private fun dispatch() {
            if (dataLines.isEmpty()) {
                frameBytes = 0L
                return
            }
            if (events >= MAX_SSE_EVENTS) {
                throw IOException("SSE response exceeds the $MAX_SSE_EVENTS-event limit")
            }
            val payload = dataLines.joinToString("\n")
            val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8).size.toLong()
            aggregateDataBytes = Math.addExact(aggregateDataBytes, payloadBytes)
            if (aggregateDataBytes > MAX_SSE_DATA_BYTES) {
                throw IOException("SSE data exceeds the ${MAX_SSE_DATA_BYTES}B aggregate limit")
            }
            events += 1
            dataLines.clear()
            frameBytes = 0L
            emit(decodeJsonOrText(payload))
        }
    }

    internal fun decodeServerSentEvents(text: String): List<Any?> {
        val events = ArrayList<Any?>(minOf(MAX_SSE_EVENTS, 64))
        val parser = SseParser(events::add)
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        parser.consume(bytes, bytes.size)
        parser.finish()
        return events
    }

    internal fun validateJsonComplexity(
        text: String,
        maximumNodes: Int = MAX_JSON_NODES,
        maximumDepth: Int = MAX_JSON_DEPTH,
    ) {
        require(maximumNodes > 0 && maximumDepth > 0) { "JSON limits must be positive" }
        var nodes = 1
        var depth = 0
        var inString = false
        var escaped = false
        for (character in text) {
            if (inString) {
                when {
                    escaped -> escaped = false
                    character == '\\' -> escaped = true
                    character == '"' -> inString = false
                }
                continue
            }
            when (character) {
                '"' -> inString = true
                '{', '[' -> {
                    depth += 1
                    if (depth > maximumDepth) throw IllegalArgumentException("JSON nesting exceeds $maximumDepth")
                    nodes += 1
                }
                '}', ']' -> depth -= 1
                ',', ':' -> nodes += 1
            }
            if (nodes > maximumNodes) throw IllegalArgumentException("JSON structure exceeds $maximumNodes nodes")
        }
    }

    private fun failureEnvelope(failure: Throwable): Map<String, Any?> = when {
        failure is java.util.concurrent.CancellationException -> linkedMapOf(
            "ok" to false, "status" to -1.0, "data" to null, "aborted" to true,
        )
        failure is IOException && failure.message?.contains("exceeds") == true -> linkedMapOf(
            "ok" to false, "status" to -2.0, "data" to null, "error" to "response_too_large",
        )
        failure is IllegalArgumentException && failure.message?.contains("request body exceeds") == true -> linkedMapOf(
            "ok" to false, "status" to -2.0, "data" to null, "error" to "request_too_large",
        )
        else -> linkedMapOf(
            "ok" to false, "status" to 0.0, "data" to null, "error" to "network",
        )
    }

    private fun unwrap(failure: Throwable): Throwable =
        (failure as? java.util.concurrent.CompletionException)?.cause ?: failure

    private fun asFetchError(url: String, failure: Throwable): Throwable = when (failure) {
        is FetchError -> failure
        is IllegalArgumentException -> FetchError.InvalidURL(url)
        else -> FetchError.Transport(failure)
    }
}
