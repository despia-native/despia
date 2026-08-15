package despia.engine.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.Button
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import despia.engine.ContentManifest
import despia.engine.ContentDisk
import despia.engine.AppManifest
import despia.engine.DSXContent
import despia.engine.DSXRuntimeSignals
import despia.engine.DSXSource
import despia.engine.ModuleRegistry
import despia.engine.RemoteBundleGate
import despia.engine.StackNode
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Paths
import java.nio.file.StandardOpenOption
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.SwingUtilities
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull

private const val MAX_REMOTE_DSX_BYTES = 4 * 1_024 * 1_024
private const val MAX_REMOTE_DSX_COMPONENTS = 32
private const val MAX_REMOTE_DSX_DEPTH = 8
private const val MAX_REMOTE_DSX_FOLDER_BYTES = 16 * 1_024 * 1_024
private const val MAX_REMOTE_DSX_FOLDER_NODES = 50_000
private const val MAX_REMOTE_DSX_TREE_BYTES = 32 * 1_024 * 1_024
private const val MAX_REMOTE_DSX_TREE_NODES = 80_000
private const val MAX_REMOTE_DSX_TREE_FILES = 64
private const val MAX_REMOTE_DSX_CONCURRENT_LOADS = 4
private const val MAX_REMOTE_DSX_URL_BYTES = 8 * 1_024
private const val MAX_REMOTE_DSX_FOLDER_LOAD_MILLIS = 60_000L
private const val ANONYMOUS_REMOTE_CACHE_NAMESPACE = "dsx-remote-anonymous-v1\n"
private const val ANONYMOUS_REMOTE_FOLDER_SNAPSHOT_NAMESPACE = "dsx-remote-folder-snapshot-v1\n"
private const val ANONYMOUS_REMOTE_FOLDER_ASSET_NAMESPACE = "dsx-remote-folder-asset-v1\n"
private val LocalRemoteDsxDepth = compositionLocalOf { 0 }
private val LocalRemoteDsxBudget = compositionLocalOf<DesktopRemoteDsxBudget?> { null }

@Volatile
internal var desktopRemoteAssetClaim: (String) -> String? = { key ->
    runCatching { ModuleRegistry.shared.dispatch("asset.url", key, combine = ModuleRegistry.Combine.claim) as? String }.getOrNull()
}

internal enum class DesktopRemoteDsxFailure(val code: String) {
    MISSING_SOURCE("remote_dsx_source_missing"),
    INVALID_URL("remote_dsx_url_invalid"),
    FETCH("remote_dsx_fetch_failed"),
    INTEGRITY("remote_dsx_integrity_failed"),
    INVALID_UTF8("remote_dsx_utf8_invalid"),
    PARSE("remote_dsx_parse_failed"),
    MANIFEST("remote_dsx_manifest_invalid"),
    GENERATION("remote_dsx_generation_unstable"),
    COMPONENT_GRAPH("remote_dsx_component_graph_invalid"),
    NESTING("remote_dsx_nesting_limit"),
    BUDGET("remote_dsx_budget_exceeded"),
}

internal data class DesktopRemoteFootprint(
    val sourceBytes: Int,
    val nodeCount: Int,
    val fileCount: Int,
) {
    init {
        require(sourceBytes >= 0 && nodeCount >= 0 && fileCount >= 0) { "negative remote footprint" }
    }

    operator fun plus(other: DesktopRemoteFootprint): DesktopRemoteFootprint? {
        val bytes = sourceBytes.toLong() + other.sourceBytes.toLong()
        val nodes = nodeCount.toLong() + other.nodeCount.toLong()
        val files = fileCount.toLong() + other.fileCount.toLong()
        if (bytes > Int.MAX_VALUE || nodes > Int.MAX_VALUE || files > Int.MAX_VALUE) return null
        return DesktopRemoteFootprint(bytes.toInt(), nodes.toInt(), files.toInt())
    }
}

private fun DesktopRemoteFootprint.withinFolderBudget(): Boolean =
    sourceBytes <= MAX_REMOTE_DSX_FOLDER_BYTES &&
        nodeCount <= MAX_REMOTE_DSX_FOLDER_NODES &&
        fileCount <= MAX_REMOTE_DSX_COMPONENTS + 2 // manifest + root + additive components

/** One mounted remote tree shares this budget across every nested DSXView. The
 * transfer semaphore prevents a wide malicious tree from allocating every child
 * response concurrently before the aggregate reservation can reject it. */
internal class DesktopRemoteDsxBudget(
    private val maximumBytes: Int = MAX_REMOTE_DSX_TREE_BYTES,
    private val maximumNodes: Int = MAX_REMOTE_DSX_TREE_NODES,
    private val maximumFiles: Int = MAX_REMOTE_DSX_TREE_FILES,
    concurrentLoads: Int = MAX_REMOTE_DSX_CONCURRENT_LOADS,
) {
    private val loadSlots = Semaphore(concurrentLoads)
    private var used = DesktopRemoteFootprint(0, 0, 0)

    init {
        require(maximumBytes > 0 && maximumNodes > 0 && maximumFiles > 0 && concurrentLoads > 0)
    }

    suspend fun <T> withLoadPermit(block: suspend () -> T): T = loadSlots.withPermit { block() }

    @Synchronized
    fun reserve(footprint: DesktopRemoteFootprint): Reservation? {
        val next = used + footprint ?: return null
        if (next.sourceBytes > maximumBytes || next.nodeCount > maximumNodes ||
            next.fileCount > maximumFiles
        ) return null
        used = next
        return Reservation(this, footprint)
    }

    @Synchronized
    private fun release(footprint: DesktopRemoteFootprint) {
        used = DesktopRemoteFootprint(
            (used.sourceBytes - footprint.sourceBytes).coerceAtLeast(0),
            (used.nodeCount - footprint.nodeCount).coerceAtLeast(0),
            (used.fileCount - footprint.fileCount).coerceAtLeast(0),
        )
    }

    internal class Reservation(
        private val owner: DesktopRemoteDsxBudget,
        private val footprint: DesktopRemoteFootprint,
    ) : AutoCloseable {
        private val closed = AtomicBoolean(false)
        override fun close() {
            if (closed.compareAndSet(false, true)) owner.release(footprint)
        }
    }
}

internal data class DesktopRemoteDsxDocument(
    val root: StackNode,
    val components: Map<String, StackNode>,
    val footprint: DesktopRemoteFootprint = DesktopRemoteFootprint(0, 0, 0),
    val serving: DesktopRemoteDsxServing = DesktopRemoteDsxServing.CACHE,
)

internal enum class DesktopRemoteDsxServing(val wire: String, val fresh: Boolean) {
    ORIGIN(DSXSource.servingOrigin, true),
    CACHE(DSXSource.servingCache, false),
}

internal data class DesktopRemoteDsxResult(
    val document: DesktopRemoteDsxDocument? = null,
    val failure: DesktopRemoteDsxFailure? = null,
) {
    init {
        require((document == null) != (failure == null)) { "remote DSX result must have one terminal" }
    }
}

/** Canonical tags and aliases are binary-owned. A remote folder may add component
 * names, never replace a renderer primitive or a shipped semantic alias. */
internal val desktopReservedRemoteComponentTags: Set<String> = setOf(
    "Accordion", "ChatBubble", "Checkbox", "DSXWebView", "DSXView", "Drawer", "Godot", "GodotView",
    "LevelMeter", "MenuBar", "Model3D", "Panorama", "ProgressRing", "RadioGroup", "Scene360",
    "Scene3D", "Scene3DView", "Skeleton", "StudioPitchEditor", "StudioShow", "StudioTimecode",
    "StudioTimeline", "StudioTrim", "Table", "Waveform", "WebView", "action", "activity", "alert",
    "attribute", "audio", "button", "calendar", "capsuleProgress", "carousel", "chart", "combobox",
    "component", "confirmDialog", "contextmenu", "date", "datepicker", "divider", "dynamic", "event",
    "expects", "field", "flow", "form", "formula", "functions", "glassButton", "grid", "head", "hstack",
    "image", "input", "label", "let", "lightbox", "list", "lottie", "map", "menu", "node", "otp",
    "pager", "picker", "popover", "pressable", "progress", "qrcode", "rangeslider", "refresh",
    "refreshable", "row", "scaffold", "script", "scroll", "searchbar", "segmented", "segmentedButton",
    "sheet", "slider", "slot", "spacer", "spinner", "stack", "stars", "stepper", "style", "svg",
    "switch", "tabs", "tabview", "text", "textarea", "textfield", "toggle", "toolbar", "transport",
    "var", "variable", "video", "vstack", "watch", "wheelpicker", "zstack",
) + desktopRendererOwnedTags

internal fun desktopRemoteDsxUrl(src: String, origin: String): String? {
    val path = src.trim()
    if (path.isEmpty()) return null
    val candidate = if (path.startsWith("https://") || path.startsWith("http://")) path else {
        var base = origin.trim().ifEmpty { DSXContent.resolvedOriginString().orEmpty().trim() }
        if (base.isEmpty()) return null
        if (!base.startsWith("https://") && !base.startsWith("http://")) base = "https://$base"
        base.trimEnd('/') + "/" + path.trimStart('/')
    }
    return runCatching {
        DesktopNetwork.validateAnonymousMediaUrl(candidate)
            .takeIf { it.fragment == null }
            ?.toASCIIString()
            ?.takeIf { it.toByteArray(StandardCharsets.US_ASCII).size <= MAX_REMOTE_DSX_URL_BYTES }
    }.getOrNull()
}

private fun remoteAssetPath(url: String): String = runCatching { URI(url).path.orEmpty() }.getOrDefault("")

private fun decodeRemoteDsx(bytes: ByteArray): String? {
    if (bytes.size > MAX_REMOTE_DSX_BYTES) return null
    return runCatching {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    }.getOrNull()
}

private data class DesktopRemoteCandidate<T>(
    val value: T? = null,
    val failure: DesktopRemoteDsxFailure? = null,
    val footprint: DesktopRemoteFootprint = DesktopRemoteFootprint(0, 0, 0),
    val admittedBytes: ByteArray? = null,
    val serving: DesktopRemoteDsxServing? = null,
) {
    init {
        require((value == null) != (failure == null)) { "remote candidate must have one terminal" }
        require(value != null || footprint == DesktopRemoteFootprint(0, 0, 0)) {
            "failed remote candidate cannot retain a footprint"
        }
        require(value != null || admittedBytes == null) { "failed remote candidate cannot retain bytes" }
    }
}

private fun remoteNodeCount(root: StackNode): Int {
    var count = 0
    val pending = ArrayDeque<StackNode>()
    pending.add(root)
    while (pending.isNotEmpty()) {
        val node = pending.removeLast()
        count += 1
        if (count > DesktopHost.MAX_EXPANDED_DSX_NODES) return count
        node.children.forEach(pending::addLast)
    }
    return count
}

private fun parseRemoteDsx(bytes: ByteArray, url: String): DesktopRemoteCandidate<StackNode> {
    when (RemoteBundleGate.checkAsset(bytes, forPath = remoteAssetPath(url))) {
        RemoteBundleGate.AssetCheck.missing,
        RemoteBundleGate.AssetCheck.mismatch ->
            return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.INTEGRITY)
        RemoteBundleGate.AssetCheck.skip,
        RemoteBundleGate.AssetCheck.match -> Unit
    }
    val text = decodeRemoteDsx(bytes)
        ?: return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.INVALID_UTF8)
    val root = DesktopHost.parseDocument(DesktopHost.Document("remote-screen.dsx", text))
        ?: return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.PARSE)
    return DesktopRemoteCandidate(
        value = root,
        footprint = DesktopRemoteFootprint(bytes.size, remoteNodeCount(root), 1),
    )
}

/** `asset.url` is a privileged binary-module claim. Accept only a bounded regular
 * file URL and reopen it with NOFOLLOW_LINKS; loopback/non-file answers fall through
 * to the ordinary cache and anonymous transport. */
private fun claimedRemoteDsxBytes(url: String): ByteArray? {
    val key = remoteAssetPath(url).ifEmpty { url }
    val claimed = runCatching { desktopRemoteAssetClaim(key) }.getOrNull() ?: return null
    val uri = runCatching { URI(claimed) }.getOrNull()
        ?.takeIf { it.scheme.equals("file", ignoreCase = true) && it.query == null && it.fragment == null }
        ?: return null
    val path = runCatching { Paths.get(uri) }.getOrNull() ?: return null
    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null
    val advertised = runCatching { Files.size(path) }.getOrNull()
        ?.takeIf { it in 0..MAX_REMOTE_DSX_BYTES.toLong() } ?: return null
    return runCatching {
        Files.newInputStream(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { input ->
            val output = ByteArrayOutputStream(advertised.toInt())
            val buffer = ByteArray(64 * 1_024)
            var count = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) continue
                if (count > MAX_REMOTE_DSX_BYTES.toLong() - read) return@runCatching null
                output.write(buffer, 0, read)
                count += read
            }
            output.toByteArray()
        }
    }.getOrNull()
}

private fun anonymousRemoteCacheKey(url: String): String = ANONYMOUS_REMOTE_CACHE_NAMESPACE + url
private fun anonymousRemoteFolderSnapshotKey(base: String): String =
    ANONYMOUS_REMOTE_FOLDER_SNAPSHOT_NAMESPACE + base
private fun anonymousRemoteFolderAssetKey(base: String, generation: String, url: String): String =
    ANONYMOUS_REMOTE_FOLDER_ASSET_NAMESPACE + base + "\n" + generation + "\n" + url

/** Publish only bytes which the caller already admitted through integrity, UTF-8,
 * and parser checks. The namespaced pointer can never collide with ContentStore's
 * credentialed single-URL plane, while the shared CAS safely deduplicates bytes. */
private fun publishAnonymousRemoteCacheBytes(cacheKey: String, bytes: ByteArray): Boolean {
    if (bytes.size > MAX_REMOTE_DSX_BYTES) return false
    val sha = ContentDisk.hashData(bytes)
    return runCatching {
        ContentDisk.ingest(data = bytes, sha = sha)
        ContentDisk.writeFilePointer(url = cacheKey, sha = sha)
        DSXContent.cachedFile(cacheKey)?.contentEquals(bytes) == true
    }.getOrDefault(false)
}

private fun activeAnonymousRemoteFolderGeneration(base: String): String? {
    val marker = DSXContent.cachedFile(anonymousRemoteFolderSnapshotKey(base)) ?: return null
    if (marker.size != 64) return null
    val generation = marker.toString(StandardCharsets.US_ASCII)
    return generation.takeIf { it.all { character -> character in '0'..'9' || character in 'a'..'f' } }
}

private fun anonymousRemoteFolderGeneration(files: Map<String, ByteArray>): String {
    val canonical = buildString {
        files.keys.sorted().forEach { url ->
            append(url.toByteArray(StandardCharsets.US_ASCII).size).append(':').append(url).append('\n')
            append(ContentDisk.hashData(files.getValue(url))).append('\n')
        }
    }
    return ContentDisk.hashData(canonical.toByteArray(StandardCharsets.US_ASCII))
}

/** A folder generation is immutable. All generation-scoped asset pointers are
 * installed first; the one stable snapshot pointer flips last. A rejected update
 * or crash before that flip leaves the previous complete generation untouched. */
private fun publishAnonymousRemoteFolder(base: String, files: Map<String, ByteArray>): Boolean {
    if (files.isEmpty()) return false
    val generation = anonymousRemoteFolderGeneration(files)
    for ((url, bytes) in files) {
        if (!publishAnonymousRemoteCacheBytes(
                anonymousRemoteFolderAssetKey(base, generation, url),
                bytes,
            )
        ) return false
    }
    return publishAnonymousRemoteCacheBytes(
        anonymousRemoteFolderSnapshotKey(base),
        generation.toByteArray(StandardCharsets.US_ASCII),
    )
}

private suspend fun fetchRemoteDsxBytes(url: String): DesktopNetwork.AnonymousMediaResponse? = try {
    DesktopNetwork.fetchAnonymousMedia(url, MAX_REMOTE_DSX_BYTES.toLong())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}

/** The current folder attempt intentionally has no per-file cache fallback. A
 * privileged local claim may replace its corresponding network file, but every
 * other byte must come from the same live attempt. If any file fails, the caller
 * discards the entire attempt and separately re-admits one immutable snapshot. */
private suspend fun <T> loadFreshRemoteCandidate(
    url: String,
    admit: (ByteArray, String) -> DesktopRemoteCandidate<T>,
): DesktopRemoteCandidate<T> {
    var terminalFailure: DesktopRemoteDsxFailure? = null
    claimedRemoteDsxBytes(url)?.let { local ->
        val result = admit(local, url)
        if (result.value != null) return result.copy(
            admittedBytes = local,
            serving = DesktopRemoteDsxServing.CACHE,
        )
        terminalFailure = result.failure
    }

    val response = fetchRemoteDsxBytes(url)
    if (response != null && response.status in 200..299) {
        val result = admit(response.body, url)
        return if (result.value != null) result.copy(
            admittedBytes = response.body,
            serving = DesktopRemoteDsxServing.ORIGIN,
        ) else result
    }
    return DesktopRemoteCandidate(failure = terminalFailure ?: DesktopRemoteDsxFailure.FETCH)
}

/** Read exactly one generation-scoped pointer. This path never consults local
 * claims, the network or the old per-URL cache namespace, so a fallback cannot
 * splice bytes from different deployments. */
private fun <T> loadSnapshotRemoteCandidate(
    url: String,
    cacheKey: String,
    admit: (ByteArray, String) -> DesktopRemoteCandidate<T>,
): DesktopRemoteCandidate<T> {
    val cached = DSXContent.cachedFile(cacheKey)
        ?: return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.FETCH)
    val result = admit(cached, url)
    return if (result.value != null) result.copy(
        admittedBytes = cached,
        serving = DesktopRemoteDsxServing.CACHE,
    ) else result
}

private suspend fun <T> loadRemoteCandidate(
    url: String,
    admit: (ByteArray, String) -> DesktopRemoteCandidate<T>,
    cacheKey: String = anonymousRemoteCacheKey(url),
): DesktopRemoteCandidate<T> {
    var terminalFailure: DesktopRemoteDsxFailure? = null
    claimedRemoteDsxBytes(url)?.let { local ->
        val result = admit(local, url)
        if (result.value != null) return result.copy(
            admittedBytes = local,
            serving = DesktopRemoteDsxServing.CACHE,
        )
        terminalFailure = result.failure
    }

    var accepted: DesktopRemoteCandidate<T>? = null
    DSXContent.cachedFile(cacheKey)?.let { cached ->
        val result = admit(cached, url)
        if (result.value != null) accepted = result.copy(
            admittedBytes = cached,
            serving = DesktopRemoteDsxServing.CACHE,
        )
        else terminalFailure = result.failure
    }
    val response = fetchRemoteDsxBytes(url)
    if (response != null && response.status in 200..299) {
        val result = admit(response.body, url)
        if (result.value != null) {
            // The caller publishes only after its complete document/folder graph
            // and aggregate budgets have passed. Per-file parse success is not a
            // sufficient last-known-good boundary for a multi-file native screen.
            accepted = result.copy(
                admittedBytes = response.body,
                serving = DesktopRemoteDsxServing.ORIGIN,
            )
        } else {
            terminalFailure = result.failure
        }
    }
    return accepted ?: DesktopRemoteCandidate(failure = terminalFailure ?: DesktopRemoteDsxFailure.FETCH)
}

private suspend fun loadRemoteDsxFile(
    url: String,
    trustedComponents: Map<String, StackNode> = emptyMap(),
): DesktopRemoteDsxResult {
    val loaded = loadRemoteCandidate(url, ::parseRemoteDsx)
    val root = loaded.value
        ?: return DesktopRemoteDsxResult(failure = requireNotNull(loaded.failure))
    val document = DesktopRemoteDsxDocument(
        root,
        emptyMap(),
        loaded.footprint,
        requireNotNull(loaded.serving),
    )
    val admitted = desktopRemoteComponentTable(document, trustedComponents)
    if (DesktopHost.componentExpansionRejection(document.root, trustedComponents + admitted) != null) {
        return DesktopRemoteDsxResult(failure = DesktopRemoteDsxFailure.COMPONENT_GRAPH)
    }
    publishAnonymousRemoteCacheBytes(
        anonymousRemoteCacheKey(url),
        requireNotNull(loaded.admittedBytes),
    )
    return DesktopRemoteDsxResult(document = document)
}

private fun safeRemoteAsset(raw: String): String? {
    // Canonical lowercase suffix keeps component naming deterministic on
    // case-sensitive and case-insensitive desktop file systems.
    if (raw.toByteArray(StandardCharsets.UTF_8).size !in 1..240 || !raw.endsWith(".dsx")) return null
    // `root` is a raw manifest field (not necessarily one of ContentManifest.files),
    // so apply the store's traversal/canonicalization law here as well. Query,
    // fragment and percent syntax must never be interpreted while concatenating a
    // folder-relative asset onto an already validated URL.
    if (ContentDisk.normalizeRel(raw) != raw ||
        !raw.matches(Regex("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*"))
    ) return null
    return raw
}

private fun folderAssetUrl(base: String, asset: String): String {
    val noFragment = base.substringBefore('#')
    val query = noFragment.substringAfter('?', missingDelimiterValue = "")
    val root = noFragment.substringBefore('?').trimEnd('/') + "/"
    return root + asset + if (query.isEmpty()) "" else "?$query"
}

private fun parseRemoteManifest(
    bytes: ByteArray,
    url: String,
): DesktopRemoteCandidate<ContentManifest> {
    when (RemoteBundleGate.checkAsset(bytes, forPath = remoteAssetPath(url))) {
        RemoteBundleGate.AssetCheck.missing,
        RemoteBundleGate.AssetCheck.mismatch ->
            return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.INTEGRITY)
        RemoteBundleGate.AssetCheck.skip,
        RemoteBundleGate.AssetCheck.match -> Unit
    }
    val text = decodeRemoteDsx(bytes)
        ?: return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.INVALID_UTF8)
    val manifest = ContentManifest.parse(text)
        ?: return DesktopRemoteCandidate(failure = DesktopRemoteDsxFailure.MANIFEST)
    return DesktopRemoteCandidate(
        value = manifest,
        footprint = DesktopRemoteFootprint(bytes.size, 0, 1),
    )
}

private data class DesktopRemoteFolderAttempt(
    val result: DesktopRemoteDsxResult,
    val admittedBytes: Map<String, ByteArray> = emptyMap(),
    val manifestUnavailable: Boolean = false,
)

private suspend fun loadRemoteDsxFolderAttempt(
    url: String,
    trustedComponents: Map<String, StackNode>,
    loadManifest: suspend (String) -> DesktopRemoteCandidate<ContentManifest>,
    loadFile: suspend (String) -> DesktopRemoteCandidate<StackNode>,
    confirmHashless: Boolean,
): DesktopRemoteFolderAttempt {
    fun rejected(
        failure: DesktopRemoteDsxFailure,
        manifestUnavailable: Boolean = false,
    ): DesktopRemoteFolderAttempt = DesktopRemoteFolderAttempt(
        result = DesktopRemoteDsxResult(failure = failure),
        manifestUnavailable = manifestUnavailable,
    )

    val acceptedBytes = LinkedHashMap<String, ByteArray>()
    val manifestUrl = folderAssetUrl(url, "manifest.json")
    val loadedManifest = loadManifest(manifestUrl)
    val manifest = loadedManifest.value
        ?: return rejected(
            requireNotNull(loadedManifest.failure),
            manifestUnavailable = loadedManifest.failure == DesktopRemoteDsxFailure.FETCH,
        )
    val manifestBytes = requireNotNull(loadedManifest.admittedBytes)
    acceptedBytes[manifestUrl] = manifestBytes
    var footprint = loadedManifest.footprint
    if (!footprint.withinFolderBudget()) {
        return rejected(DesktopRemoteDsxFailure.BUDGET)
    }
    val rawRoot = manifest.raw["root"]
    if (rawRoot != null && rawRoot !is String) {
        return rejected(DesktopRemoteDsxFailure.MANIFEST)
    }
    val rootPath = safeRemoteAsset(rawRoot ?: "index.dsx")
        ?: return rejected(DesktopRemoteDsxFailure.MANIFEST)
    val entriesByPath = manifest.files.associateBy { it.path }
    val hashlessBytes = LinkedHashMap<String, ByteArray>()

    fun preflight(entry: ContentManifest.Entry?): DesktopRemoteDsxFailure? {
        val declaredBytes = entry?.bytes
        return if (declaredBytes != null && declaredBytes > MAX_REMOTE_DSX_BYTES.toLong()) {
            DesktopRemoteDsxFailure.BUDGET
        } else null
    }

    fun bind(
        entry: ContentManifest.Entry?,
        assetUrl: String,
        bytes: ByteArray,
    ): DesktopRemoteDsxFailure? {
        val expected = entry?.sha256
        if (expected != null && ContentDisk.hashData(bytes) != expected) {
            return DesktopRemoteDsxFailure.INTEGRITY
        }
        // The signed route table authenticates each asset independently, but it is
        // mutable process state and is not this folder manifest's generation map.
        // A hash-less legacy entry therefore needs a second identical observation
        // even when signing is ON; only this manifest's own digest binds one pass.
        if (expected == null) hashlessBytes[assetUrl] = bytes
        return null
    }

    val components = LinkedHashMap<String, StackNode>()
    val dsxAssets = manifest.files.asSequence()
        .mapNotNull { entry -> safeRemoteAsset(entry.path)?.let { it to entry } }
        .filter { (path, _) -> path != rootPath }
        .take(MAX_REMOTE_DSX_COMPONENTS + 1)
        .toList()
    if (dsxAssets.size > MAX_REMOTE_DSX_COMPONENTS) {
        return rejected(DesktopRemoteDsxFailure.MANIFEST)
    }
    for ((asset, entry) in dsxAssets) {
        val name = asset.substringAfterLast('/').removeSuffix(".dsx")
        if (!name.matches(Regex("[A-Za-z][A-Za-z0-9_.-]{0,127}")) ||
            name in trustedComponents || name in desktopReservedRemoteComponentTags ||
            desktopRendererOwnsTag(name) || name in components
        ) continue
        preflight(entry)?.let { return rejected(it) }
        val assetUrl = folderAssetUrl(url, asset)
        val loaded = loadFile(assetUrl)
        val template = loaded.value
            ?: return rejected(requireNotNull(loaded.failure))
        val assetBytes = requireNotNull(loaded.admittedBytes)
        bind(entry, assetUrl, assetBytes)?.let { return rejected(it) }
        acceptedBytes[assetUrl] = assetBytes
        footprint = (footprint + loaded.footprint)
            ?.takeIf { it.withinFolderBudget() }
            ?: return rejected(DesktopRemoteDsxFailure.BUDGET)
        components[name] = template
    }
    val rootUrl = folderAssetUrl(url, rootPath)
    val rootEntry = entriesByPath[rootPath]
    preflight(rootEntry)?.let { return rejected(it) }
    val loadedRoot = loadFile(rootUrl)
    val root = loadedRoot.value
        ?: return rejected(requireNotNull(loadedRoot.failure))
    val rootBytes = requireNotNull(loadedRoot.admittedBytes)
    bind(rootEntry, rootUrl, rootBytes)?.let { return rejected(it) }
    acceptedBytes[rootUrl] = rootBytes
    footprint = (footprint + loadedRoot.footprint)
        ?.takeIf { it.withinFolderBudget() }
        ?: return rejected(DesktopRemoteDsxFailure.BUDGET)
    val document = DesktopRemoteDsxDocument(
        root,
        components,
        footprint,
        requireNotNull(loadedRoot.serving),
    )
    val admitted = desktopRemoteComponentTable(document, trustedComponents)
    if (DesktopHost.componentExpansionRejection(document.root, trustedComponents + admitted) != null) {
        return rejected(DesktopRemoteDsxFailure.COMPONENT_GRAPH)
    }
    if (confirmHashless && hashlessBytes.isNotEmpty()) {
        val confirmedManifest = loadManifest(manifestUrl)
        val confirmedManifestBytes = confirmedManifest.admittedBytes
            ?: return rejected(requireNotNull(confirmedManifest.failure))
        if (!confirmedManifestBytes.contentEquals(manifestBytes)) {
            return rejected(DesktopRemoteDsxFailure.GENERATION)
        }
        for ((assetUrl, firstBytes) in hashlessBytes) {
            val confirmed = loadFile(assetUrl)
            val confirmedBytes = confirmed.admittedBytes
                ?: return rejected(requireNotNull(confirmed.failure))
            if (!confirmedBytes.contentEquals(firstBytes)) {
                return rejected(DesktopRemoteDsxFailure.GENERATION)
            }
        }
    }
    return DesktopRemoteFolderAttempt(
        result = DesktopRemoteDsxResult(document = document),
        admittedBytes = acceptedBytes.toMap(),
    )
}

private suspend fun loadRemoteDsxFolder(
    url: String,
    trustedComponents: Map<String, StackNode>,
): DesktopRemoteDsxResult {
    val previousGeneration = activeAnonymousRemoteFolderGeneration(url)
    val fresh = loadRemoteDsxFolderAttempt(
        url = url,
        trustedComponents = trustedComponents,
        loadManifest = { assetUrl -> loadFreshRemoteCandidate(assetUrl, ::parseRemoteManifest) },
        loadFile = { assetUrl -> loadFreshRemoteCandidate(assetUrl, ::parseRemoteDsx) },
        confirmHashless = true,
    )
    if (fresh.result.document != null) {
        // Best effort persistence: a failed disk publication never blocks this
        // completely admitted in-memory generation. The stable marker flips only
        // after every generation-scoped asset pointer has been installed.
        publishAnonymousRemoteFolder(url, fresh.admittedBytes)
        return fresh.result
    }

    if (previousGeneration != null) {
        fun cacheKey(assetUrl: String): String =
            anonymousRemoteFolderAssetKey(url, previousGeneration, assetUrl)
        val previous = loadRemoteDsxFolderAttempt(
            url = url,
            trustedComponents = trustedComponents,
            loadManifest = { assetUrl ->
                loadSnapshotRemoteCandidate(assetUrl, cacheKey(assetUrl), ::parseRemoteManifest)
            },
            loadFile = { assetUrl ->
                loadSnapshotRemoteCandidate(assetUrl, cacheKey(assetUrl), ::parseRemoteDsx)
            },
            confirmHashless = false,
        )
        if (previous.result.document != null &&
            anonymousRemoteFolderGeneration(previous.admittedBytes) == previousGeneration
        ) return previous.result
    }

    if (fresh.manifestUnavailable && previousGeneration == null) {
        // A folder which has never published a manifest snapshot retains the
        // conventional single-file index.dsx behavior.
        return loadRemoteDsxFile(folderAssetUrl(url, "index.dsx"), trustedComponents)
    }
    return fresh.result
}

internal suspend fun loadDesktopRemoteDsx(
    src: String,
    origin: String,
    trustedComponents: Map<String, StackNode> = emptyMap(),
): DesktopRemoteDsxResult {
    if (src.isBlank()) return DesktopRemoteDsxResult(failure = DesktopRemoteDsxFailure.MISSING_SOURCE)
    val url = desktopRemoteDsxUrl(src, origin)
        ?: return DesktopRemoteDsxResult(failure = DesktopRemoteDsxFailure.INVALID_URL)
    val folder = runCatching { URI(url).rawPath.orEmpty().endsWith('/') }.getOrDefault(false)
    return if (folder) {
        withTimeoutOrNull(MAX_REMOTE_DSX_FOLDER_LOAD_MILLIS) {
            loadRemoteDsxFolder(url, trustedComponents)
        } ?: DesktopRemoteDsxResult(failure = DesktopRemoteDsxFailure.FETCH)
    } else {
        loadRemoteDsxFile(url, trustedComponents)
    }
}

/** Testable lifecycle seam; production always points at the hardened loader above. */
@Volatile
internal var desktopRemoteDsxLoader: suspend (
    src: String,
    origin: String,
    trustedComponents: Map<String, StackNode>,
) -> DesktopRemoteDsxResult = { src, origin, trusted ->
    loadDesktopRemoteDsx(src, origin, trusted)
}

/** Prepare declarations from a remote document while preserving the binary/app trust
 * boundary. This is intentionally pure with respect to the component table (the store
 * receives the same declaration side effects as a bundled document). */
internal fun prepareDesktopRemoteComponents(
    document: DesktopRemoteDsxDocument,
    store: despia.engine.StackStore,
    trustedComponents: Map<String, StackNode>,
): Map<String, StackNode> {
    val admitted = desktopRemoteComponentTable(document, trustedComponents)
    if (DesktopHost.componentExpansionRejection(document.root, trustedComponents + admitted) != null) {
        return emptyMap()
    }
    prepareDesktopRemoteDeclarations(document, store)
    return admitted
}

/** Build the exact additive component table without executing declarations. This
 * pure phase lets admission prove the final cross-file graph before remote actions,
 * variables or styles can mutate the shared surface store. */
internal fun desktopRemoteComponentTable(
    document: DesktopRemoteDsxDocument,
    trustedComponents: Map<String, StackNode>,
): Map<String, StackNode> {
    val admitted = LinkedHashMap<String, StackNode>()
    fun admit(name: String, template: StackNode) {
        if (name !in trustedComponents &&
            name !in desktopReservedRemoteComponentTags &&
            !desktopRendererOwnsTag(name) &&
            name.matches(Regex("[A-Za-z][A-Za-z0-9_.-]{0,127}"))
        ) admitted.putIfAbsent(name, template)
    }

    desktopDeclaredComponents(document.root).forEach(::admit)
    document.components.forEach { (name, template) ->
        admit(name, template)
        desktopDeclaredComponents(template).forEach(::admit)
    }
    return admitted
}

private fun prepareDesktopRemoteDeclarations(
    document: DesktopRemoteDsxDocument,
    store: despia.engine.StackStore,
) {
    prepareDesktopDocument(document.root, store)
    document.components.values.forEach { template -> prepareDesktopDocument(template, store) }
}

private sealed interface DesktopRemoteDsxUiState {
    data object Loading : DesktopRemoteDsxUiState
    data class Loaded(
        val document: DesktopRemoteDsxDocument,
        val components: Map<String, StackNode>,
    ) : DesktopRemoteDsxUiState
    data class Failed(val failure: DesktopRemoteDsxFailure) : DesktopRemoteDsxUiState
}

@Composable
internal fun DesktopRemoteDsxView(context: DesktopElementContext, modifier: Modifier) {
    val src = context.value("src").orEmpty()
    val origin = context.value("origin").orEmpty()
    val depth = LocalRemoteDsxDepth.current
    val inheritedBudget = LocalRemoteDsxBudget.current
    val budget = inheritedBudget ?: remember(src, origin) { DesktopRemoteDsxBudget() }
    var state by remember(src, origin, depth) { mutableStateOf<DesktopRemoteDsxUiState>(DesktopRemoteDsxUiState.Loading) }
    var retryNonce by remember(src, origin, depth) { mutableStateOf(0) }
    var reservation by remember(src, origin, depth, budget) {
        mutableStateOf<DesktopRemoteDsxBudget.Reservation?>(null)
    }
    DisposableEffect(src, origin, depth, budget) {
        onDispose { reservation?.close() }
    }
    // Route source changes restart the task but do not mean the mounted surface
    // disappeared. Only hierarchy disposal emits the canonical final phase.
    val lifecycleValues = rememberUpdatedState(src to origin)
    DisposableEffect(Unit) {
        onDispose {
            val (lastSrc, lastOrigin) = lifecycleValues.value
            publishDesktopDsxViewLifecycle("disappear", lastSrc, lastOrigin)
        }
    }
    LaunchedEffect(src, origin, depth, budget, context.components, retryNonce) {
        reservation?.close()
        reservation = null
        state = DesktopRemoteDsxUiState.Loading
        if (src.isNotBlank()) publishDesktopDsxViewLifecycle("loading", src, origin)
        if (depth >= MAX_REMOTE_DSX_DEPTH) {
            state = DesktopRemoteDsxUiState.Failed(DesktopRemoteDsxFailure.NESTING)
        } else {
            val result = try {
                budget.withLoadPermit {
                    desktopRemoteDsxLoader(src, origin, context.components)
                }
            } catch (cancelled: CancellationException) {
                // A route replacement owns this cancellation. It must not paint a
                // failure surface or emit a terminal phase for the superseded route.
                throw cancelled
            } catch (_: Exception) {
                // Transport/filesystem adapters are replaceable host seams. An
                // unexpected adapter failure still settles through the compiled
                // native failure floor instead of escaping the composition.
                DesktopRemoteDsxResult(failure = DesktopRemoteDsxFailure.FETCH)
            }
            val document = result.document
            if (document == null) {
                state = DesktopRemoteDsxUiState.Failed(requireNotNull(result.failure))
            } else {
                val remoteComponents = desktopRemoteComponentTable(document, context.components)
                if (DesktopHost.componentExpansionRejection(
                        document.root,
                        context.components + remoteComponents,
                    ) != null
                ) {
                    state = DesktopRemoteDsxUiState.Failed(DesktopRemoteDsxFailure.COMPONENT_GRAPH)
                } else {
                    val nextReservation = budget.reserve(document.footprint)
                    if (nextReservation == null) {
                        state = DesktopRemoteDsxUiState.Failed(DesktopRemoteDsxFailure.BUDGET)
                    } else {
                        reservation = nextReservation
                        state = DesktopRemoteDsxUiState.Loaded(document, remoteComponents)
                        publishDesktopDsxViewSource(document.serving, origin)
                    }
                }
            }
        }
        publishDesktopDsxViewLifecycle(
            if (state is DesktopRemoteDsxUiState.Loaded) "ready" else "failed",
            src,
            origin,
        )
    }
    when (val current = state) {
        DesktopRemoteDsxUiState.Loading -> Box(
            modifier.fillMaxWidth().heightIn(min = 96.dp),
            contentAlignment = Alignment.Center,
        ) { CircularProgressIndicator() }
        is DesktopRemoteDsxUiState.Loaded -> Box(modifier) {
            // Prepare the root and every folder component through the same declaration
            // path as a bundled screen. Remote names are additive only: they cannot
            // replace trusted app components or binary-owned canonical primitives.
            remember(current.document, context.store) {
                prepareDesktopRemoteDeclarations(current.document, context.store)
            }
            val components = context.components + current.components
            CompositionLocalProvider(
                LocalRemoteDsxDepth provides depth + 1,
                LocalRemoteDsxBudget provides budget,
            ) {
                DesktopNode(current.document.root, context.store, context.runner, context.item, components)
            }
        }
        is DesktopRemoteDsxUiState.Failed -> DesktopRemoteDsxFailureSurface(
            context,
            modifier,
            current.failure,
            onRetry = { retryNonce += 1 },
        )
    }
}

/**
 * NEVER broadcast inline from here — it deadlocks the UI.
 *
 * Callers are Compose effects. Compose resumes a `LaunchedEffect` continuation INSIDE
 * `FlushCoroutineDispatcher`'s monitor, and the EDT must take that same monitor to render.
 * `DSXRuntimeSignals.broadcast` egresses through the registry's SYNCHRONOUS main funnel
 * (`DesktopUiDispatcher.dispatchSynchronously`), which parks the caller until the EDT drains.
 * Holding the monitor while waiting on the thread that needs it is a lock-ordering inversion:
 * the loader thread parks on a FutureTask, the EDT blocks acquiring the monitor, and the app
 * hangs forever. It is a race, so it survived CI green.
 *
 * A lifecycle phase is a `fire` — 0..N listeners, no result read — so queueing it is the
 * correct shape regardless. `invokeLater` UNCONDITIONALLY, never `DesktopUiDispatcher.dispatch`:
 * that one runs inline when already on the EDT, which would let a "disappear" published during
 * disposal overtake a "ready" still sitting in the queue. One FIFO domain keeps phases ordered.
 */
internal fun publishDesktopDsxViewLifecycle(phase: String, src: String, origin: String) {
    SwingUtilities.invokeLater {
        DSXRuntimeSignals.broadcast(
            "dsx-view",
            phase,
            mapOf("src" to src, "origin" to origin),
        )
    }
}

private fun publishDesktopDsxViewSource(serving: DesktopRemoteDsxServing, origin: String) {
    val key = runCatching { URI(origin).host }.getOrNull()
        ?.lowercase()
        ?: AppManifest.resolvedHost().orEmpty().lowercase()
    DSXSource.publish("view", serving.wire, serving.fresh, key)
}

@Composable
private fun DesktopRemoteDsxFailureSurface(
    context: DesktopElementContext,
    modifier: Modifier,
    failure: DesktopRemoteDsxFailure,
    onRetry: () -> Unit,
) {
    LaunchedEffect(context.node, failure) {
        context.attributes["on:fail"]?.takeIf(String::isNotBlank)?.let { action ->
            context.run(
                action,
                mapOf(
                    "code" to failure.code,
                    "capability" to "remote-native-screen",
                    "platform" to "desktop",
                    "recoverable" to (failure != DesktopRemoteDsxFailure.NESTING &&
                        failure != DesktopRemoteDsxFailure.BUDGET),
                ),
            )
        }
    }
    Column(
        modifier.fillMaxWidth().heightIn(min = 132.dp)
            .background(color("fill").copy(alpha = 0.28f), RoundedCornerShape(14.dp))
            .border(1.dp, color("separator"), RoundedCornerShape(14.dp))
            .padding(18.dp)
            .semantics { contentDescription = "DSX native screen unavailable. ${failure.code}" },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("DSX native screen unavailable", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        Text("The remote native document could not be admitted safely.", color = color("secondary"), fontSize = 13.sp)
        Text(failure.code, color = color("tertiary"), fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Button(onClick = onRetry) { Text("Try again") }
    }
}
