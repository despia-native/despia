//
//  Content.kt — `dsx.content`: the kernel CONTENT primitive. Kotlin twin of
//  Engine/Content.swift — same names, same arguments, same behaviors.
//
//  Folder-shaped, generation-versioned, offline-first, app-authored content. An app hosts content
//  FOLDERS on its own web host under the content root (App.json `hosting.content_root`, default
//  `/dsx`): a folder is a manifest (`manifest.json` by default) listing files with optional
//  per-file SHA-256, plus the files. The kernel resolves a folder to LOCAL VERIFIED bytes and
//  keeps it fresh — every surface consumes the SAME store (the "one asset plane").
//
//  THE TWO CALLS (mechanism only — serving, prefetch policy and sync UX are a module's):
//    • `dsx.content.folder(path)`  — SYNCHRONOUS, render-path-safe: the last-known-good
//      generation straight off disk. Never touches the network (the never-block law).
//    • `dsx.content.prepare(path)` — resolve + freshen. Warm: returns the CURRENT generation
//      immediately and revalidates in the background (stale-while-revalidate); a new generation
//      publishes ATOMICALLY, fires the `content.updated` kernel event, and is served on the NEXT
//      open. Cold (first ever use): a foreground resolve behind the caller's own skeleton.
//
//  RESOLUTION CHAIN, per file (offline-first when a sha is declared):
//      CAS blob → bundled SEED (zero-copy) → the `asset.url` claim (locally-synced copy) →
//      network (download → hash-verify → ingest) → missing (throws — the WHOLE generation is
//      abandoned, all-or-nothing, and the last-known-good one keeps serving).
//  A file with NO declared sha inverts to network-first when online. A manifest is USABLE only
//  if it parses as a JSON object carrying a file list — an SPA catch-all's 200-with-HTML can
//  never poison the store or defeat a bundled seed.
//
//  ── SEAMS (PLAN.md ground rule 3 — every platform touch injectable; ContentStore.kt holds the
//  store-side seams: network fetch, trust gate, asset.url claim; ContentDisk holds the disk-side
//  ones: roots, clock, seed loading) ──
//    • `DSXContent.resolvedOriginString` — AppManifest.resolvedOriginString() is `:platform`
//      (App.json + BuildConfig); default `{ null }` ⇒ authority-less URLs that fail cleanly
//      into the offline chain (seed / cache), byte-identical to Swift's no-host degrade.
//    • `DSXContent.contentRoot` — App.json `hosting.content_root`; default `/dsx`.
//    • `DSXContent.contentBudgetMB` — EngineConfig `content.budget_mb`; default 300.
//    • `DSXContent.contentMaxBlobMB` — EngineConfig `content.max_blob_mb`; default 240.
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • `ContentError` is a sealed Exception hierarchy (Swift: enum ContentError: Error); cases are
//    classes, not objects, so each throw carries a real stack trace.
//  • Swift's `URL` becomes `java.io.File` everywhere a local location is meant (`folder.url()`,
//    `ContentSeed.fileURL`, `materialize()`); the name `url` is kept for the 1:1 law.
//  • `folder.data([…])` reads sequentially (Swift memory-maps): its bytes are local + verified,
//    and the Swift header pins the returned MAP as the contract — scheduling is a detail.
//  • `files`/`prepareAll` fan out through `coroutineScope { async }` under a Semaphore — the
//    documented `withTaskGroup ⟷ coroutineScope` twin; windows exactly 6 / 3.
//  • `pin`/`evict` are fire-and-forget onto the store's scope (Swift `Task { … }`); `pinNow`
//    is the awaited twin — same ordering contract.
//  • Byte counts are Long (JVM file sizes), where Swift used Int — identical below 2^63.
//

package despia.engine

import java.io.File
import java.math.BigInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

// MARK: - Errors

/// Content resolution failures. TOTAL surface: `prepare` throws only these; `folder()` never throws.
sealed class ContentError(message: String) : Exception(message) {
    /** No usable manifest from any source (network / seed / cache). */
    class NoManifest : ContentError("noManifest")
    /** Signing ON and the network manifest failed verification, with nothing local to serve. */
    class Refused : ContentError("refused")
    /** A file's bytes failed its declared SHA-256 (never overwrites a good copy). */
    class Integrity(val path: String) : ContentError("integrity: $path")
    /** A listed file could not be obtained from any source in the chain. */
    class Missing(val path: String) : ContentError("missing: $path")
}

// MARK: - Manifest

/// A parsed, TOLERANT content manifest. One parser absorbs every shape already deployed:
/// canonical `files:[{path, sha256, bytes}]`, Godot's `bundles:[{path, sha256, size}]`, and the
/// offline web bundle's `assets:[String]` / `assets:[{path, sha256}]`. Unknown top-level keys ride
/// in `raw`; `meta` is the canonical consumer-passthrough.
class ContentManifest(
    val version: Long?,                // optional Int64, monotonic per folder (enforced only when signed)
    val deployedAt: String?,
    val files: List<Entry>,
    val meta: Map<String, Any?>,       // the canonical opaque passthrough (`meta` key)
    val raw: Map<String, Any?>,        // the whole accepted object — legacy consumers read their own fields
) {
    class Entry(
        val path: String,              // folder-relative file path
        val sha256: String?,           // lowercase hex; null = no change detector (network-first when online)
        val bytes: Long?,              // optional declared size; preflight only, actual bytes are still bounded
    )

    companion object {
        /** A manifest is bounded control data, not an unbounded coroutine/job queue. */
        const val MAXIMUM_ENTRIES = 4_096
        const val MAXIMUM_PATH_UTF8_BYTES = 1_024
        private val MAXIMUM_INT64 = BigInteger.valueOf(Long.MAX_VALUE)

        /** JSON integer fields are exact nonnegative Int64 values; no truncation or saturation. */
        private fun strictNonnegativeInt64(value: Any?): Long? {
            val number = value as? Number ?: return null
            // Json.kt preserves lexical integer tokens as Int/Long. Float/Double therefore means
            // the source used a decimal or exponent token (or overflowed Int64); reject it even
            // when mathematically whole so Apple/Android signed bytes have one interpretation.
            val integer = when (number) {
                is Byte, is Short, is Int, is Long -> BigInteger.valueOf(number.toLong())
                is BigInteger -> number
                else -> return null
            }
            if (integer.signum() < 0 || integer > MAXIMUM_INT64) return null
            return integer.toLong()
        }

        /// The ACCEPTANCE RULE (the SPA-poison guard, kernel law): a manifest is usable iff it is
        /// a JSON OBJECT carrying a file list (`files` / `bundles` / `assets` as an array).
        /// Anything else — an SPA's index.html, a captive portal, an error page — is null, so
        /// callers fall back instead of trusting garbage. Total: never throws.
        fun parse(text: String?): ContentManifest? {
            if (text == null) return null
            @Suppress("UNCHECKED_CAST")
            val raw = parseJSONFoundationPreservingNumbers(text) as? Map<String, Any?> ?: return null
            return parse(raw)
        }

        fun parse(raw: Map<String, Any?>): ContentManifest? {
            val list = (raw["files"] ?: raw["bundles"] ?: raw["assets"]) as? List<*> ?: return null
            if (list.size > MAXIMUM_ENTRIES) return null
            val version = if (raw.containsKey("version")) {
                strictNonnegativeInt64(raw["version"]) ?: return null
            } else null
            val files = ArrayList<Entry>()
            val normalizedPaths = HashSet<String>()
            for (item in list) {
                if (item is String) {                                            // assets:[String] (hash-less)
                    if (item.toByteArray(Charsets.UTF_8).size > MAXIMUM_PATH_UTF8_BYTES) return null
                    val path = ContentDisk.normalizeRel(item)
                    if (path.isEmpty() || !normalizedPaths.add(path)) return null
                    files.add(Entry(path, null, null))
                    continue
                }
                val dict = item as? Map<*, *> ?: return null
                val rawPath = dict["path"] as? String ?: return null
                if (rawPath.toByteArray(Charsets.UTF_8).size > MAXIMUM_PATH_UTF8_BYTES) return null
                val path = ContentDisk.normalizeRel(rawPath)
                if (path.isEmpty() || !normalizedPaths.add(path)) return null
                val sha = if (dict.containsKey("sha256")) {
                    val rawSha = dict["sha256"] as? String ?: return null
                    if (rawSha.isEmpty()) null else rawSha
                } else null
                // A present digest is an authority-bearing CAS path, not a best-effort hint.
                // Reject the entire manifest instead of silently degrading malformed hashes to
                // hash-less network content.
                if (!sha.isNullOrEmpty() &&
                    (sha.length != 64 || !sha.all { it in '0'..'9' || it in 'a'..'f' })) return null
                val sizeKey = when {
                    dict.containsKey("bytes") -> "bytes"
                    dict.containsKey("size") -> "size"
                    else -> null
                }
                val bytes = sizeKey?.let { strictNonnegativeInt64(dict[it]) ?: return null }
                files.add(Entry(path, sha, bytes))
            }
            @Suppress("UNCHECKED_CAST")
            return ContentManifest(
                version = version,
                deployedAt = raw["deployed_at"] as? String,
                files = files,
                meta = (raw["meta"] as? Map<String, Any?>) ?: emptyMap(),
                raw = raw,
            )
        }
    }
}

// MARK: - Seed

/// A BUNDLED source for a folder — content that ships INSIDE the app (a module's demo pack, an
/// offline floor) and seeds the store's generation zero with no network. Zero-copy: seed files
/// are referenced in place (the `ContentDisk.seedResource` seam — Bundle.main's twin), never
/// duplicated into the CAS. A hosted manifest that PARSES always wins over a seed on the next
/// open — the seed keys on "no USABLE manifest", never on "no response".
class ContentSeed(
    val manifestText: () -> String?,   // the bundled manifest's JSON text (null = no seed manifest)
    val fileURL: (String) -> File?,    // bundled bytes for a listed path (null = not shipped)
)

// MARK: - Folder handle

/// An IMMUTABLE handle on ONE generation of one content folder. A screen visit captures it once
/// and reads from it for its whole lifetime — the store never mutates a published generation, so
/// old and new files can never mix mid-visit. Everything here is pure disk reads (no lock):
/// instant loads stay lock-free by construction.
class ContentFolder internal constructor(
    val root: String,                          // resolved absolute root URL (the folder's identity)
    val generation: String,                    // hash of the path→sha map — "same files" IS "same generation"
    val manifest: ContentManifest,             // the accepted manifest (incl. raw passthrough)
    internal val source: String,               // where the manifest came from: network / claim / seed
    internal val folderDir: File,              // folders/<key>/ in whichever tier holds this folder
    internal val blobmap: Map<String, BlobRef>, // normalized relPath → verified blob (+ optional seed fallback)
) {
    companion object {
        /** Heap APIs are deliberately much smaller than the on-disk blob transport ceiling. */
        internal const val MAX_IN_MEMORY_FILE_BYTES = 32L * 1024L * 1024L
        internal const val MAX_IN_MEMORY_BATCH_BYTES = 64L * 1024L * 1024L
        internal const val MAX_IN_MEMORY_BATCH_PATHS = 64
    }

    /// A local File for a listed file — the verified CAS blob, else the bundled seed copy.
    /// null when the file isn't in this generation or its bytes are gone from every local source
    /// (an OS purge with no seed — `prepare` heals that on the next call).
    ///
    /// This is the preferred zero-copy API for blobs larger than [MAX_IN_MEMORY_FILE_BYTES].
    /// Consumers can stream the returned file; [data] intentionally returns null for large files.
    fun url(relPath: String): File? {
        val ref = blobmap[ContentDisk.normalizeRel(relPath)] ?: return null
        ContentDisk.blobURL(ref.sha)?.let { return it }
        ref.seed?.let { return ContentDisk.seedURL(it) }
        return null
    }

    /// Read one small verified file into memory. Regular-file, no-follow, advertised-size, and
    /// actual-byte checks cap the allocation at 32 MiB. Use [url] to stream larger blobs.
    fun data(relPath: String): ByteArray? =
        url(relPath)?.let { readBounded(it, MAX_IN_MEMORY_FILE_BYTES) }

    /// BATCH read many files of THIS (already-resolved) generation — one map back, no caller
    /// loop. The bytes are already local + verified (Swift memory-maps; here a plain read — the
    /// returned MAP is the cross-platform contract, scheduling is a detail). A missing rel is
    /// simply absent. At most 64 requested paths and 64 MiB total are returned; individual files
    /// remain subject to the 32 MiB limit. This keeps a maximal 4,096-entry manifest from becoming
    /// a multi-gigabyte heap allocation. Use [url] or [materialize] for large/bulk consumers.
    suspend fun data(relPaths: List<String>): Map<String, ByteArray> {
        val out = LinkedHashMap<String, ByteArray>()
        var remaining = MAX_IN_MEMORY_BATCH_BYTES
        for (rel in relPaths.take(MAX_IN_MEMORY_BATCH_PATHS)) {
            if (out.containsKey(rel)) continue
            val u = url(rel) ?: continue
            val d = readBounded(u, minOf(MAX_IN_MEMORY_FILE_BYTES, remaining)) ?: continue
            out[rel] = d
            remaining -= d.size.toLong()
            if (remaining <= 0L) break
        }
        return out
    }

    fun text(relPath: String): String? = data(relPath)?.toString(Charsets.UTF_8)

    /// A REAL directory tree of this generation, for consumers that need one on disk. Built once
    /// per generation under `trees/<generation>/` (APFS clonefile → a plain `Files.copy` here),
    /// then reused; built in staging and published by a single atomic move, so a half-built tree
    /// is never visible and concurrent callers converge. Throws `ContentError.Missing` if a
    /// file's bytes are gone from every local source (purge with no seed). This on-disk API is
    /// appropriate for large packs that intentionally exceed the in-memory [data] ceiling.
    fun materialize(): File =
        ContentDisk.materialize(folderDir = folderDir, generation = generation, blobmap = blobmap)

    private fun readBounded(file: File, maximumBytes: Long): ByteArray? {
        return ContentDisk.boundedData(file, maximumBytes)
    }
}

/// One verified file of a generation: the content hash that names its CAS blob, plus an optional
/// bundled-seed fallback (bundle resource basename) so seed generations are zero-copy and
/// purge-proof. Internal — consumers only ever see `ContentFolder`.
internal class BlobRef(val sha: String, val seed: String?)

// MARK: - The primitive

/// The kernel content primitive — `dsx.content`. Mechanism only (store + resolution + freshness);
/// serving and scheduling policy live in modules. See the header above for the model.
object DSXContent {

    /// AppManifest.resolvedOriginString() seam (`:platform` installs the real one at boot).
    /// Default `{ null }` ⇒ every default-origin URL is authority-less and fails cleanly into
    /// the offline chain — the Swift no-host degrade, byte-identical.
    @Volatile var resolvedOriginString: () -> String? = { null }

    /// App.json `hosting.content_root` seam. Default `/dsx`.
    @Volatile var contentRoot: () -> String = { "/dsx" }

    /// EngineConfig `content.budget_mb` seam (AppManifest.contentBudgetMB). Default 300;
    /// 0 disables eviction.
    @Volatile var contentBudgetMB: () -> Int = { 300 }

    /// EngineConfig `content.max_blob_mb` seam (AppManifest.contentMaxBlobMB). Every local,
    /// bundled, and downloaded asset is bounded independently of the transport implementation.
    @Volatile var contentMaxBlobMB: () -> Int = { 240 }

    /// SYNCHRONOUS, render-path-safe: the last-known-good generation for a content path, straight
    /// off disk (`current` pointer → manifest + blobmap). Never touches the network; null until
    /// the folder has ever been prepared or seeded. `manifestName` must match what the folder was
    /// prepared with (it is part of the folder's identity).
    fun folder(path: String, origin: String = "", manifestName: String = "manifest.json"): ContentFolder? {
        val root = absolute(path, origin)
        val key = ContentDisk.folderKey(root = root, manifestName = manifestName)
        val folder = ContentDisk.loadCurrent(key = key, root = root)
        if (folder != null) ContentDisk.touch(key)      // LRU clock (fire-and-forget, off the render path)
        return folder
    }

    /// Resolve + freshen (see the header: warm = instant + background revalidate, new generation
    /// on NEXT open; cold = foreground behind the caller's skeleton). `seed` supplies a bundled
    /// fallback source. `onProgress` reports 0…1 across the files of a foreground resolve.
    /// `pinned = true` steers the FIRST publish straight into the never-purged tier — for content
    /// that must survive an OS cache purge, e.g. the offline web bundle.
    suspend fun prepare(
        path: String, origin: String = "", manifestName: String = "manifest.json",
        seed: ContentSeed? = null, pinned: Boolean = false,
        onProgress: ((Double) -> Unit)? = null,
    ): ContentFolder =
        ContentStore.shared.prepare(path = path, origin = origin, manifestName = manifestName,
                                    seed = seed, pinned = pinned, onProgress = onProgress)

    /// The single-URL plane (the text/asset-cache successor): last-known-good bytes for a URL,
    /// synchronously from the same store. null until `file()` has ever succeeded for it.
    fun cachedFile(url: String): ByteArray? = ContentDisk.cachedFile(url)

    /// FOREGROUND revalidation — the awaited twin of the background stale-while-revalidate pass,
    /// for callers that must apply an update BEFORE proceeding (the offline-app boot gate).
    /// Returns the folder that is CURRENT after the attempt — the fresh generation when one
    /// landed, the last-known-good when the network/signing refused, null only when the folder
    /// has never resolved at all. Total.
    suspend fun refresh(
        path: String, origin: String = "", manifestName: String = "manifest.json",
        onProgress: ((Double) -> Unit)? = null,
    ): ContentFolder? =
        ContentStore.shared.refresh(path = path, origin = origin, manifestName = manifestName,
                                    onProgress = onProgress)

    /// Network-only fetch of a single URL through the store (single-flight, ingested into the
    /// CAS, remembered for `cachedFile`). null on ANY failure — and the previously cached copy is
    /// left untouched, so callers keep what they had (the fetchText contract).
    suspend fun freshFile(url: String): ByteArray? = ContentStore.shared.freshFile(url)

    /// Fetch with cached fallback — `freshFile` else `cachedFile`. Total, never throws.
    suspend fun file(url: String): ByteArray? = freshFile(url) ?: cachedFile(url)

    /// BATCH the single-URL plane: fetch many URLs CONCURRENTLY and get one map back. Fan-out is
    /// BOUNDED (a sliding window of 6, the same cap as a folder's own acquires) and de-duplicated
    /// (a URL already in flight shares one transfer via the store's single-flight).
    /// Missing/failed URLs are simply absent from the result.
    suspend fun files(urls: List<String>): Map<String, ByteArray> {
        if (urls.isEmpty()) return emptyMap()
        val window = Semaphore(minOf(6, urls.size))
        val fetched = coroutineScope {
            urls.map { url -> async { window.withPermit { url to file(url) } } }.awaitAll()
        }
        val out = LinkedHashMap<String, ByteArray>()
        for ((url, data) in fetched) if (data != null) out[url] = data
        return out
    }

    /// BATCH folder resolution: `prepare` many folders CONCURRENTLY. One await, a map of the
    /// folders that resolved (a folder that throws is absent — the batch never fails as a whole).
    /// Bounded to 3 folders in flight — each `prepare` already fans out its own window of 6.
    suspend fun prepareAll(
        paths: List<String>, origin: String = "", manifestName: String = "manifest.json",
    ): Map<String, ContentFolder> {
        if (paths.isEmpty()) return emptyMap()
        val window = Semaphore(minOf(3, paths.size))
        val resolved = coroutineScope {
            paths.map { path ->
                async {
                    window.withPermit {
                        path to try { prepare(path, origin = origin, manifestName = manifestName) }
                        catch (e: kotlinx.coroutines.CancellationException) { throw e }
                        catch (_: Exception) { null }
                    }
                }
            }.awaitAll()
        }
        val out = LinkedHashMap<String, ContentFolder>()
        for ((path, folder) in resolved) if (folder != null) out[path] = folder
        return out
    }

    /// Pin a folder into the never-purged tier (excluded from backup) — for offline-critical
    /// content. Unpinning returns it to the purgeable cache tier. Fire-and-forget (Swift `Task`).
    fun pin(path: String, origin: String = "", manifestName: String = "manifest.json",
            pinned: Boolean = true) {
        ContentStore.shared.scope.launch {
            ContentStore.shared.pin(path = path, origin = origin, manifestName = manifestName, pinned = pinned)
        }
    }

    /// The AWAITABLE twin of `pin` — for callers that must ORDER the tier move against their next
    /// store operation (the boot gate promotes a migrated bundle BEFORE refreshing it).
    suspend fun pinNow(path: String, origin: String = "", manifestName: String = "manifest.json",
                       pinned: Boolean = true) {
        ContentStore.shared.pin(path = path, origin = origin, manifestName = manifestName, pinned = pinned)
    }

    /// Drop every generation of a folder (both tiers) and GC newly-unreferenced blobs.
    fun evict(path: String, origin: String = "", manifestName: String = "manifest.json") {
        ContentStore.shared.scope.launch {
            ContentStore.shared.evict(path = path, origin = origin, manifestName = manifestName)
        }
    }

    /// Store diagnostics (sizes, counts, budget) — for a storage-management surface.
    fun stats(): Map<String, Any> = ContentDisk.stats()

    // MARK: - The one host authority

    /// Resolve a content path to its absolute HTTPS root URL (always "/"-terminated).
    ///   • absolute `http(s)` path → unchanged (the author named the exact location);
    ///   • explicit `origin`       → `<origin><path>/` — an explicit origin is an explicit
    ///     location, so the content root does NOT apply;
    ///   • default                 → `https://<resolved origin><content_root><path>/`.
    /// With no host configured anywhere the result has no authority and every fetch fails cleanly
    /// into the offline chain (seed / cache) — same degrade as always.
    fun absolute(path: String, origin: String = ""): String {
        var p = path.trim()
        if (p.isEmpty()) p = "/"
        if (p.startsWith("http://") || p.startsWith("https://")) return if (p.endsWith("/")) p else "$p/"
        val rel = if (p.startsWith("/")) p else "/$p"
        val o = origin.trim()
        val joined = if (o.isEmpty()) {
            // resolvedOriginString ≡ resolvedHost normally; when the dev-origin override is
            // active it carries scheme+port so content follows the SAME origin the web loads.
            normalizedOrigin(resolvedOriginString() ?: "") + contentRoot() + rel
        } else {
            normalizedOrigin(o) + rel
        }
        return if (joined.endsWith("/")) joined else "$joined/"
    }

    private fun normalizedOrigin(origin: String): String {
        var h = origin.trim()
        if (h.isNotEmpty() && !h.startsWith("http://") && !h.startsWith("https://")) h = "https://$h"
        if (h.isEmpty()) h = "https://"          // no host anywhere → an authority-less URL that fails cleanly
        while (h.endsWith("/")) h = h.dropLast(1)
        return h
    }
}
