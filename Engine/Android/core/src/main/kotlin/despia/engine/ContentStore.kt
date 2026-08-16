//
//  ContentStore.kt — the content-addressed store behind `dsx.content`. Kotlin twin of
//  Engine/ContentStore.swift — same layout, same invariants, same observable behavior
//  (see Content.kt for the model; this file is the disk format + the one mutation core).
//
//  LAYOUT (two tiers, same shape):
//
//    <cacheRoot>/                               ← default tier (OS-purgeable = cache semantics)
//      blobs/sha256/<64-hex>                    ← verified bytes, immutable, deduped (name IS the hash)
//      folders/<folder-key>/                    ← folder-key = sha256(rootURL + "\n" + manifestName)
//         current                               ← the live generation id (atomic replace)
//         previous                              ← kept for rollback safety (keep-two rule)
//         gens/<generation>.json                ← the manifest bytes exactly as accepted
//         gens/<generation>.blobmap             ← { source, files: { relPath: {sha, seed?} } }
//         trees/<generation>/                   ← materialized directory view (plain copies), on demand
//         touched                               ← mtime = the LRU clock
//         version                               ← per-folder anti-rollback high-water (signed manifests)
//      files/<sha256(url)>                      ← single-URL plane: pointer file → blob sha
//      tmp/                                     ← staging; swept on first touch each process
//
//    <pinnedRoot>/                              ← pinned tier: same layout, never purged,
//                                                 backup exclusion re-applied on every write
//
//  INVARIANTS the layout enforces (identical to Swift):
//    • A blob is COMPLETE-OR-ABSENT: downloads stage elsewhere, hash-verify, then rename in.
//    • A generation is IMMUTABLE once its two `gens/` files exist; `current` flips AFTER they
//      are durable — a crash leaves the old generation fully live or the new fully published.
//    • READERS never lock: resolving a published generation is pure immutable reads. Only
//      mutation serializes (the store's one lock — the actor's twin).
//    • Eviction is GENERATION-granular, THEN unreferenced blobs are GC'd — with a one-hour
//      mtime grace so a just-ingested blob whose generation hasn't published yet is never
//      collected.
//
//  ── SEAMS (PLAN.md ground rule 3; every platform touch injectable, Android wiring in :platform) ──
//    • Disk roots: `ContentDisk.cacheRoot` / `pinnedRoot` (Library/Caches / Application Support
//      → context.cacheDir / context.filesDir); defaults under java.io.tmpdir so a bare JVM works.
//    • `ContentDisk.backupExclusion` — isExcludedFromBackup has no JVM twin; default no-op.
//    • `ContentDisk.clock` — LRU stamps + the GC grace cutoff; defaults to
//      System.currentTimeMillis. Ingest and touch stamp files via this clock so tests drive time.
//    • `ContentDisk.utilityExecutor` — the off-render-path hop (Swift DispatchQueue.global);
//      defaults to INLINE (the Events.kt precedent: deterministic tests, :platform installs a
//      background executor).
//    • `ContentDisk.seedResource` — Bundle.main.url(forResource:) twin: bundled seed bytes by
//      flat resource basename. Default `{ null }`.
//    • `ContentDisk.seedIndex` — the generated DSXContentSeeds.json (dsx.json `content` →
//      mount → manifest-name → { module, pinned, manifest }); an injectable provider, default
//      empty = fail-open, exactly the Swift absent-resource behavior.
//    • `ContentStore.shared.fetch` — the network (`ContentFetch`), installed by `:platform`
//      (OkHttp). Default null ⇒ NEVER-NETWORK: every offline path (CAS, seed, claim) fully
//      works and network legs report "nothing there", the Swift no-connectivity degrade.
//      The manifest/text plane must ride a protocol cache (ETag/304); the blob plane must not.
//    • `ContentStore.claimResolver` — the `asset.url` kernel claim (ModuleRegistry is K2);
//      default null = no module claims the role, same as an exclusion set without ContentServer.
//    • `ContentStore.trustGate` — RemoteBundleGate's signing verdicts (`ContentTrustGate`);
//      default null = signing OFF ⇒ source trust, byte-identical to Swift with no
//      `bundle_signing`. RemoteBundleGate.kt (wave 4) installs the real per-anchor math.
//    • `content.updated` fires through the DSXEvents façade (scheme `content.updated`) — the
//      in-process twin of the ModuleRegistry .void fold until the registry lands in `:platform`; the bus's
//      own mainExecutor seam is the DispatchQueue.main hop.
//
//  ── NOTES (pinned decisions; PLAN.md ground rule 1) ──
//  • The Swift mutation ACTOR becomes ONE reentrant monitor (`lock`) held only across
//    non-suspending critical sections (publish/evict/pin/budget + the in-flight maps). Swift's
//    actor releases isolation at every await — so did the original critical sections; no lock
//    here is ever held across a suspension point.
//  • Single-flight cancellation: a Kotlin waiter cancelled mid-await unwinds IMMEDIATELY
//    (Swift's rides until the transfer lands). The bookkeeping decrements both counters on the
//    cancelled waiter's exit, so the invariant is preserved exactly: the shared transfer is
//    cancelled only when the cancelling waiter is the LAST live one.
//  • A shared revalidation pass cancelled by `evict` yields null to its un-cancelled awaiters
//    (Swift returns the pre-evict stale handle) — the folder is being destroyed either way;
//    pinned as the honest JVM behavior (a cancelled Deferred cannot complete with a value).
//  • `hexSHA256` lives here (MessageDigest) until RemoteBundleGate.kt (wave 4) lands; the
//    gate's twin should reuse it.
//  • `ingest`/`touch` stamp mtimes from `ContentDisk.clock` so the LRU order and the GC grace
//    are test-drivable; Swift reads the filesystem's own clock — same semantics, seam-driven.
//  • Sizes are Long (JVM); Swift used Int. Identical below 2^63.
//

package despia.engine

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive

// MARK: - The network seam

/// One network response for the content plane (the URLSession twin's carrier).
class ContentResponse(
    val status: Int,
    val body: ByteArray,
    val headers: Map<String, String> = emptyMap(),
)

/// The content plane's network. `:platform` installs an OkHttp implementation on
/// `ContentStore.shared.fetch`; null (the default) = never-network — every offline
/// resolution path still fully works.
interface ContentFetch {
    /// The manifest/text plane (Swift's `manifestSession`): MUST ride a protocol cache so
    /// ETag/If-None-Match revalidation works (an unchanged resource is a cheap 304).
    /// null = transport failure (offline, DNS, TLS).
    suspend fun data(url: String): ContentResponse?

    /// The blob plane (Swift's `blobSession`): stream the body to `dest` with NO cache — the
    /// CAS is the cache, never double-buffer blobs. Returns the HTTP status, or null on a
    /// transport failure. Default implementation rides [data] (fine for tests and small blobs).
    suspend fun download(url: String, dest: File): Int? {
        val resp = data(url) ?: return null
        if (resp.status in 200..299) dest.writeBytes(resp.body)
        return resp.status
    }
}

/// RemoteBundleGate's signing verdicts, as a seam (the gate itself is wave 4). null on
/// `ContentStore.trustGate` = signing OFF ⇒ source trust, exactly Swift with no
/// App.json `bundle_signing`. `verify` folds Swift's per-anchor loop
/// (`config.anchors.contains(where: verify(anchor:))`) into the gate.
interface ContentTrustGate {
    val requiresVerification: Boolean
    val isMisconfigured: Boolean
    fun verify(manifest: ByteArray, signature: ByteArray): Boolean
}

// MARK: - Disk format (pure, lock-free — shared by the sync read path and the mutation core)

object ContentDisk {

    /** Bounded persisted-control contracts, kept in lockstep with the Apple store. */
    internal const val MAXIMUM_POINTER_BYTES = 128L
    internal const val MAXIMUM_CONTROL_BYTES = 4L * 1_024L * 1_024L
    internal const val MAXIMUM_GENERATION_METADATA_BYTES = 8L * 1_024L * 1_024L

    // MARK: tiers (seams — :platform installs context.cacheDir / context.filesDir at boot)

    /// The purgeable cache tier (Library/Caches twin). Setting creates the directory.
    @Volatile var cacheRoot: File = File(System.getProperty("java.io.tmpdir"), "dsx-content")
        set(value) { field = value.absoluteFile; field.mkdirs() }

    /// The never-purged pinned tier (Application Support twin). Setting creates the directory
    /// and applies the backup-exclusion seam.
    @Volatile var pinnedRoot: File = File(System.getProperty("java.io.tmpdir"), "dsx-content-pinned")
        set(value) { field = value.absoluteFile; field.mkdirs(); backupExclusion(field) }

    /// isExcludedFromBackup's seam — no JVM twin; Android's is Auto-Backup rules, so the
    /// default is a no-op and :platform may install a real one.
    @Volatile var backupExclusion: (File) -> Unit = {}

    /// The LRU/GC clock seam — `touched` stamps, blob-ingest stamps, the one-hour GC grace.
    @Volatile var clock: () -> Long = { System.currentTimeMillis() }

    /// The off-render-path hop (Swift DispatchQueue.global(qos: .utility)). INLINE by default
    /// (deterministic tests — the Events.kt precedent); :platform installs a background executor.
    @Volatile var utilityExecutor: Executor = Executor { it.run() }

    /// Bundle.main.url(forResource:) twin: bundled seed bytes by flat resource basename.
    @Volatile var seedResource: (String) -> File? = { null }

    /// Staging space. Swept once per process per root (orphans of a crashed run), so a crash
    /// mid-download can never leak unbounded temp files.
    private val sweptTmp = HashSet<String>()
    fun tmpDir(): File {
        val d = File(cacheRoot, "tmp")
        synchronized(sweptTmp) { if (sweptTmp.add(d.path)) d.deleteRecursively() }
        d.mkdirs()
        return d
    }

    fun applyBackupExclusion(to: File = pinnedRoot) { backupExclusion(to) }

    // MARK: keys + paths

    fun folderKey(root: String, manifestName: String): String =
        hexSHA256((root + "\n" + manifestName).toByteArray(Charsets.UTF_8))

    fun folderDir(key: String, tier: File): File = File(File(tier, "folders"), key)

    /// The tier that HOLDS this folder (pinned wins), or null when the folder has never published.
    fun existingFolderDir(key: String): File? {
        val p = folderDir(key, pinnedRoot)
        if (p.exists()) return p
        val c = folderDir(key, cacheRoot)
        if (c.exists()) return c
        return null
    }

    fun ensureFolderDir(key: String, preferPinned: Boolean = false): File {
        existingFolderDir(key)?.let { return it }
        val d = folderDir(key, if (preferPinned) pinnedRoot else cacheRoot)
        if (!d.mkdirs() && !d.isDirectory) throw java.io.IOException("cannot create $d")
        if (preferPinned) applyBackupExclusion()
        return d
    }

    fun blobPath(tier: File, sha: String): File = File(File(tier, "blobs/sha256"), sha)

    /// A verified blob's location from EITHER tier (pinned first), or null — a purged blob is a
    /// cache miss by design, never an error at this layer.
    fun blobURL(sha: String): File? {
        // Defense in depth for persisted blobmaps and direct callers: a CAS name is exactly one
        // lowercase hex digest component. Never let slashes, drive syntax, or dot segments reach
        // File(parent, child), even if a corrupted on-disk manifest bypasses the parser.
        if (sha.length != 64 || !sha.all { it in '0'..'9' || it in 'a'..'f' }) return null
        val p = blobPath(pinnedRoot, sha)
        if (p.exists()) return p
        val c = blobPath(cacheRoot, sha)
        if (c.exists()) return c
        return null
    }

    fun hasBlob(sha: String): Boolean = blobURL(sha) != null

    /// A bundled seed file, matched by its resource basename (bundle resources ship flat).
    /// Zero-copy: seed generations reference the bundle in place.
    fun seedURL(name: String): File? = seedResource(name)

    // MARK: declared seeds (dsx.json `content` → Registry/DSXContentSeeds.json)

    /// The generated seeds index: mount → manifest-name → { module, pinned, manifest (inlined
    /// text) }. An injectable provider (the generated Android boot code installs the parsed
    /// registry); absent (default) ⇒ empty, fail-open — the Swift missing-resource behavior.
    @Volatile var seedIndex: () -> Map<String, Any?> = { emptyMap() }

    /// The app's OWN origin, for the seed guard (bundled-floor.md): the boot folders (the
    /// offline web bundle) resolve with the app's host as an EXPLICIT origin, and their seeds
    /// must still be found. A seam in the Swift twin's exact shape — the module that owns the
    /// boot resolve (ContentServer) installs the EXACT origin string it resolves with; the
    /// default covers App.json-hosted apps via the resolvedOriginString seam.
    @Volatile var ownOrigin: () -> String? = { DSXContent.resolvedOriginString() }

    /// Is this origin the app's own plane? Empty = the content-root mounts (always own).
    /// Otherwise normalize both sides (scheme off, trailing slashes off, lowercased) and
    /// require equality with `ownOrigin` — a FOREIGN origin is an explicit location and is
    /// never seedable (a bundled seed must not shadow another host's content).
    fun isOwnPlane(origin: String): Boolean {
        val o = origin.trim()
        if (o.isEmpty()) return true
        val own = ownOrigin() ?: return false
        if (own.isEmpty()) return false
        fun norm(s: String): String {
            var v = s.lowercase()
            for (p in listOf("https://", "http://")) if (v.startsWith(p)) v = v.removePrefix(p)
            while (v.endsWith("/")) v = v.dropLast(1)
            return v
        }
        return norm(o) == norm(own)
    }

    /// The declared bundled seed for a content path, if a package ships one. Only for the app's
    /// OWN plane — a content-root mount (no origin) or a boot folder on the app's own host
    /// (`isOwnPlane`) — and only for the exact manifest name the consumer resolves with
    /// (mount + manifest name is the seed's identity). Files resolve by flat bundle-resource
    /// basename.
    fun declaredSeed(path: String, origin: String, manifestName: String): Pair<ContentSeed, Boolean>? {
        if (!isOwnPlane(origin)) return null
        var mount = path.trim()
        if (!mount.startsWith("/")) mount = "/$mount"
        while (mount.length > 1 && mount.endsWith("/")) mount = mount.dropLast(1)
        val byManifest = seedIndex()[mount] as? Map<*, *> ?: return null
        val entry = byManifest[manifestName] as? Map<*, *> ?: return null
        val text = entry["manifest"] as? String ?: return null
        if (text.isEmpty()) return null
        val seed = ContentSeed(
            manifestText = { text },
            fileURL = { p -> seedURL(p.substringAfterLast('/')) },
        )
        return seed to ((entry["pinned"] as? Boolean) ?: false)
    }

    /// The reserved in-tree completion marker (`materialize`). A manifest file with this name is
    /// rejected by `normalizeRel` so it can never clobber the marker (or be clobbered by it).
    const val treeMarkerName = ".dsx-complete"

    /// Normalize a manifest-listed path into a safe folder-relative key. A hostile manifest must
    /// not escape the folder (`materialize` writes these paths), so a `..`/`.` component, an
    /// absolute URL, or the reserved tree marker reject the entry outright ("" = skipped by
    /// every caller).
    fun normalizeRel(path: String): String {
        val p = path
        if (p != p.trim()) return ""
        if (p.toByteArray(Charsets.UTF_8).size > ContentManifest.MAXIMUM_PATH_UTF8_BYTES ||
            p.startsWith('/') || p.contains('%') || p.contains("://") ||
            p.contains('\\') || p.contains(':') ||
            p.any { it.code == 0 || it.code < 0x20 || it.code == 0x7f }) return ""
        val parts = p.split("/")
        if (parts.isEmpty() || parts.any { it.isEmpty() } || parts.contains("..") || parts.contains(".") ||
            parts.contains(treeMarkerName)) return ""
        return parts.joinToString("/")
    }

    internal fun validSHA256(value: String): Boolean =
        value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }

    /**
     * Read a regular, non-symlink local file with advertised and observed byte ceilings.
     * NOFOLLOW_LINKS closes the checked-path symlink swap; the streaming count closes growth
     * races after metadata inspection. This is the sole heap read for persisted store state.
     */
    internal fun boundedData(file: File, maximumBytes: Long): ByteArray? {
        if (maximumBytes < 0L || maximumBytes > Int.MAX_VALUE.toLong()) return null
        return try {
            boundedDataNio(file, maximumBytes)
        } catch (_: LinkageError) {
            // java.nio.file is API 26. Core-library desugaring covers Files on most
            // toolchains, but API 24/25 still dispatch File.toPath() to java.io.File
            // on some D8 graphs. Keep those supported devices on a java.io path whose
            // opened descriptor is identity-checked before any bytes are accepted.
            boundedDataLegacy(file, maximumBytes)
        }
    }

    private fun boundedDataNio(file: File, maximumBytes: Long): ByteArray? {
        val path = file.toPath()
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null
        val advertised = runCatching { Files.size(path) }.getOrNull() ?: return null
        if (advertised < 0L || advertised > maximumBytes) return null
        return runCatching {
            Files.newInputStream(
                path,
                StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS,
            ).use { input ->
                val output = ByteArrayOutputStream(minOf(advertised, 64L * 1_024L).toInt())
                val buffer = ByteArray(64 * 1_024)
                var count = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    if (count > maximumBytes - read.toLong()) return@runCatching null
                    output.write(buffer, 0, read)
                    count += read
                }
                output.toByteArray()
            }
        }.getOrNull()
    }

    /**
     * API 24/25 fallback for [boundedDataNio].
     *
     * Android's lstat/fstat identity check rejects a final-component symlink and
     * closes the check/open race: the descriptor is opened first, then accepted
     * only when it is the same inode currently named by the path. Pure-JVM tests
     * have no android.system.Os, so they use the canonical-parent equivalent.
     * The streaming ceiling remains authoritative even if metadata changes.
     */
    internal fun boundedDataLegacy(file: File, maximumBytes: Long): ByteArray? {
        if (maximumBytes < 0L || maximumBytes > Int.MAX_VALUE.toLong()) return null
        return runCatching {
            FileInputStream(file).use { input ->
                if (!openedRegularFileMatchesPath(file, input)) return@runCatching null
                val advertised = file.length()
                if (advertised < 0L || advertised > maximumBytes) return@runCatching null
                val output = ByteArrayOutputStream(minOf(advertised, 64L * 1_024L).toInt())
                val buffer = ByteArray(64 * 1_024)
                var count = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    if (count > maximumBytes - read.toLong()) return@runCatching null
                    output.write(buffer, 0, read)
                    count += read
                }
                output.toByteArray()
            }
        }.getOrNull()
    }

    private fun openedRegularFileMatchesPath(file: File, input: FileInputStream): Boolean {
        if (!file.isFile) return false
        val androidIdentity = runCatching {
            val os = Class.forName("android.system.Os")
            val lstat = os.getMethod("lstat", String::class.java)
                .invoke(null, file.absolutePath)
            val fstat = os.getMethod("fstat", java.io.FileDescriptor::class.java)
                .invoke(null, input.fd)
            fun number(value: Any, name: String): Long =
                value.javaClass.getField(name).get(value).let { it as Number }.toLong()
            number(lstat, "st_dev") == number(fstat, "st_dev") &&
                number(lstat, "st_ino") == number(fstat, "st_ino")
        }.getOrNull()
        if (androidIdentity != null) return androidIdentity

        val absolute = file.absoluteFile
        val parent = absolute.parentFile?.canonicalFile ?: return false
        val expected = File(parent, absolute.name)
        return absolute.canonicalFile == expected
    }

    /** Decode persisted text strictly; malformed UTF-8 is corrupt state, not replacement text. */
    internal fun boundedText(file: File, maximumBytes: Long): String? {
        val data = boundedData(file, maximumBytes) ?: return null
        return runCatching {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(data))
                .toString()
        }.getOrNull()
    }

    private fun readSHAFile(file: File): String? =
        boundedText(file, MAXIMUM_POINTER_BYTES)?.trim()?.takeIf(::validSHA256)

    // MARK: hashing (MessageDigest — RemoteBundleGate.hexSHA256's stand-in until wave 4)

    fun hexSHA256(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

    fun hashData(data: ByteArray): String = hexSHA256(data)

    /// Streaming SHA-256 of a file (1 MiB chunks) — packs never load whole into memory here.
    fun hashFile(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // MARK: blob ingest (complete-or-absent)

    /// Move verified bytes into the CAS. The name is the hash the CALLER just computed/checked,
    /// so an existing destination means the same bytes are already verified — an existing-target
    /// collision (or a race to it) is an idempotent win, never an error.
    fun ingest(tmp: File, sha: String) {
        require(validSHA256(sha)) { "invalid CAS digest" }
        val dest = blobPath(cacheRoot, sha)
        dest.parentFile?.mkdirs()
        if (dest.exists()) { tmp.delete(); return }
        try {
            Files.move(tmp.toPath(), dest.toPath(), StandardCopyOption.ATOMIC_MOVE)
        } catch (e: Exception) {
            if (dest.exists()) { tmp.delete(); return }
            throw e
        }
        dest.setLastModified(clock())     // the GC-grace stamp rides the clock seam
    }

    fun ingest(data: ByteArray, sha: String) {
        val staging = File(tmpDir(), UUID.randomUUID().toString())
        staging.writeBytes(data)
        ingest(tmp = staging, sha = sha)
    }

    // MARK: generations

    /// The generation id IS the hash of the path→sha map: "same files" = "same generation",
    /// independent of manifest formatting; one changed file = a new generation.
    internal fun generationID(map: Map<String, BlobRef>): String {
        val canon = map.keys.sorted().joinToString("\n") { "$it\n${map[it]?.sha ?: ""}" }
        return hexSHA256(canon.toByteArray(Charsets.UTF_8))
    }

    internal fun blobmapData(map: Map<String, BlobRef>, source: String): ByteArray {
        // JSONSerialization .sortedKeys twin: build every level in sorted key order and ride
        // the JSON renderer's insertion order.
        val files = LinkedHashMap<String, Any?>()
        for (rel in map.keys.sorted()) {
            val ref = map.getValue(rel)
            val entry = LinkedHashMap<String, Any?>()
            if (ref.seed != null) entry["seed"] = ref.seed
            entry["sha"] = ref.sha
            files[rel] = entry
        }
        val top = LinkedHashMap<String, Any?>()
        top["files"] = files
        top["source"] = source
        return JSON(top).toString().toByteArray(Charsets.UTF_8)
    }

    internal fun parseBlobmap(data: ByteArray): Pair<Map<String, BlobRef>, String>? {
        if (data.size.toLong() > MAXIMUM_GENERATION_METADATA_BYTES) return null
        val obj = json(data.toString(Charsets.UTF_8)).foundationValue as? Map<*, *> ?: return null
        val files = obj["files"] as? Map<*, *> ?: return null
        if (files.size > ContentManifest.MAXIMUM_ENTRIES) return null
        val out = HashMap<String, BlobRef>()
        val identities = HashSet<String>()
        for ((rel, entry) in files) {
            val path = rel as? String ?: return null
            if (normalizeRel(path) != path) return null
            val identity = Normalizer.normalize(path, Normalizer.Form.NFC).lowercase(Locale.ROOT)
            if (!identities.add(identity)) return null
            val dict = entry as? Map<*, *> ?: return null
            val sha = dict["sha"] as? String ?: return null
            if (!validSHA256(sha)) return null
            out[path] = BlobRef(sha = sha, seed = dict["seed"] as? String)
        }
        return out to ((obj["source"] as? String) ?: "network")
    }

    fun readPointer(dir: File, name: String): String? {
        val s = boundedText(File(dir, name), MAXIMUM_POINTER_BYTES)?.trim()
        return if (s.isNullOrEmpty()) null else s
    }

    fun readGenerationPointer(dir: File, name: String): String? =
        readPointer(dir, name)?.takeIf(::validSHA256)

    /// A tiny memo of the parsed current generation per folder key, so the SYNC render path
    /// skips re-reading + re-parsing two JSON files on every call. The cheap `current` pointer
    /// read STILL runs, so a publish or an evict is picked up immediately. SELF-VERIFYING on
    /// the folder dir: a tier move (`pin`) relocates the dir WITHOUT changing the pointer, so
    /// the hit is gated on `dir.path` too — a stale entry mismatches the freshly-resolved dir
    /// and is reloaded. Root is part of the key, so it needs no separate compare.
    private val genCacheLock = Any()
    private val genCache = HashMap<String, Triple<String, String, ContentFolder>>()

    /// The last-known-good generation, straight off disk — the sync read path (`dsx.content.folder`).
    fun loadCurrent(key: String, root: String): ContentFolder? {
        val dir = existingFolderDir(key) ?: return null
        val gen = readGenerationPointer(dir, "current") ?: return null
        synchronized(genCacheLock) {
            val hit = genCache[key]
            if (hit != null && hit.first == gen && hit.second == dir.path) return hit.third
        }
        val folder = loadGeneration(dir = dir, generation = gen, root = root) ?: return null
        synchronized(genCacheLock) { genCache[key] = Triple(gen, dir.path, folder) }
        return folder
    }

    /// The exact manifest BYTES of a generation (as text) — for the SWR short-circuit: an
    /// unchanged manifest means no re-acquire. null if the generation's artifact is gone.
    fun manifestText(dir: File, generation: String): String? {
        if (!validSHA256(generation)) return null
        return boundedText(File(File(dir, "gens"), "$generation.json"), MAXIMUM_CONTROL_BYTES)
    }

    /// Drop a folder's memoized generation — after any operation that moves or removes its dir
    /// (a tier change via `pin`, an evict/remove), so `loadCurrent` re-reads from the new location.
    fun invalidateGenCache(key: String) {
        synchronized(genCacheLock) { genCache.remove(key) }
    }

    fun loadGeneration(dir: File, generation: String, root: String): ContentFolder? {
        if (!validSHA256(generation)) return null
        val gens = File(dir, "gens")
        val mText = boundedText(File(gens, "$generation.json"), MAXIMUM_CONTROL_BYTES) ?: return null
        val manifest = ContentManifest.parse(text = mText) ?: return null
        val bData = boundedData(
            File(gens, "$generation.blobmap"),
            MAXIMUM_GENERATION_METADATA_BYTES,
        ) ?: return null
        val parsed = parseBlobmap(bData) ?: return null
        return ContentFolder(root = root, generation = generation, manifest = manifest,
                             source = parsed.second, folderDir = dir, blobmap = parsed.first)
    }

    /// Files of a generation whose bytes are gone from EVERY local source (an OS purge) — the
    /// holes `prepare` heals in the foreground before handing the generation out.
    fun unresolvedFiles(folder: ContentFolder): List<String> =
        folder.blobmap.mapNotNull { (rel, ref) ->
            if (blobURL(ref.sha) != null) return@mapNotNull null
            if (ref.seed != null && seedURL(ref.seed) != null) return@mapNotNull null
            rel
        }

    /// Drop every generation artifact except current + previous (the keep-two rule: instant
    /// rollback safety without unbounded growth). Trees are re-clonable, so stale ones go too.
    /// Returns true when it removed a `gens/` artifact — the signal `publish` uses to GC the
    /// blobs that generation orphaned.
    fun pruneGenerations(dir: File): Boolean {
        val keep = HashSet<String>()
        readGenerationPointer(dir, "current")?.let { keep.add(it) }
        readGenerationPointer(dir, "previous")?.let { keep.add(it) }
        var removedGen = false
        for (f in File(dir, "gens").listFiles() ?: emptyArray()) {
            if (keep.contains(f.name.substringBeforeLast('.'))) continue
            f.delete()
            removedGen = true
        }
        for (t in File(dir, "trees").listFiles() ?: emptyArray()) {
            if (keep.contains(t.name)) continue
            t.deleteRecursively()
        }
        return removedGen
    }

    /// Every blob sha referenced by a folder's live (current/previous) generations.
    fun referencedShas(dir: File): Set<String> {
        val out = HashSet<String>()
        val gens = File(dir, "gens")
        for (name in listOf("current", "previous")) {
            val gen = readGenerationPointer(dir, name) ?: continue
            val data = boundedData(
                File(gens, "$gen.blobmap"),
                MAXIMUM_GENERATION_METADATA_BYTES,
            ) ?: continue
            val parsed = parseBlobmap(data) ?: continue
            out.addAll(parsed.first.values.map { it.sha })
        }
        return out
    }

    /// Copy the given blobs INTO a tier if absent (APFS clone → plain copy). Used to make a
    /// PINNED folder self-contained: `ingest` always writes blobs to the purgeable cache tier,
    /// so a pinned folder whose blobs live only in cache would still lose them to an OS purge.
    /// Seed files (no CAS blob — referenced zero-copy from the bundle) are skipped automatically.
    fun cloneBlobs(shas: Set<String>, toTier: File) {
        for (sha in shas) {
            val dst = blobPath(toTier, sha)
            if (dst.exists()) continue
            val src = blobURL(sha) ?: continue
            dst.parentFile?.mkdirs()
            runCatching { Files.copy(src.toPath(), dst.toPath()) }
        }
    }

    /// Delete blobs no live generation (and no single-URL pointer) references — with a one-hour
    /// mtime grace so a blob ingested for a not-yet-published generation is never collected out
    /// from under its publish. TIER-AWARE: a blob referenced only by the OTHER tier's folders is
    /// kept in this tier ONLY while the other tier's own copy is missing (the clone-failed
    /// safety net) — so the cache-tier twins that `cloneBlobs` leaves behind when a folder is
    /// pinned are collectible instead of counting against the cache budget forever.
    fun gcBlobs() {
        fun references(tier: File): Set<String> {
            val out = HashSet<String>()
            for (dir in File(tier, "folders").listFiles() ?: emptyArray()) {
                out.addAll(referencedShas(dir))
            }
            for (f in File(tier, "files").listFiles() ?: emptyArray()) {
                readSHAFile(f)?.let(out::add)
            }
            return out
        }
        val pinnedRefs = references(pinnedRoot)
        val cacheRefs = references(cacheRoot)
        val cutoff = clock() - 3_600_000L
        fun sweep(tier: File, own: Set<String>, other: Set<String>, otherTier: File) {
            for (b in File(tier, "blobs/sha256").listFiles() ?: emptyArray()) {
                val sha = b.name
                if (own.contains(sha)) continue
                if (other.contains(sha) && !blobPath(otherTier, sha).exists()) continue
                if (b.lastModified() > cutoff) continue
                b.delete()
            }
        }
        sweep(pinnedRoot, pinnedRefs, cacheRefs, cacheRoot)
        sweep(cacheRoot, cacheRefs, pinnedRefs, pinnedRoot)
    }

    fun removeFolder(key: String, tier: File) {
        folderDir(key, tier).deleteRecursively()
        invalidateGenCache(key)
    }

    // MARK: LRU clock + budget accounting

    /// Bump the folder's LRU clock. Fire-and-forget off the calling thread — the render path
    /// never waits on a disk write (inline by default; :platform installs a background executor).
    fun touch(key: String) {
        utilityExecutor.execute {
            val dir = existingFolderDir(key) ?: return@execute
            val f = File(dir, "touched")
            runCatching { f.writeBytes(ByteArray(0)); f.setLastModified(clock()) }
        }
    }

    /// Cache-tier folder keys, least-recently-touched first (the eviction order).
    fun lruFolderKeys(): List<String> {
        val kids = File(cacheRoot, "folders").listFiles() ?: emptyArray()
        fun stamp(dir: File): Long = File(dir, "touched").lastModified()   // 0 = distantPast
        return kids.sortedBy { stamp(it) }.map { it.name }
    }

    fun directorySize(root: File): Long {
        var total = 0L
        fun walk(f: File) {
            if (f.isDirectory) (f.listFiles() ?: emptyArray()).forEach { walk(it) }
            else if (f.isFile) total += f.length()
        }
        walk(root)
        return total
    }

    /// Total bytes of the given blobs in a tier — the reclaimable weight of a folder's blobs, so
    /// eviction can drop its running size estimate WITHOUT a full-tree rewalk. Over-counts a
    /// blob shared by two folders (subtracted twice), which only makes eviction stop EARLIER —
    /// it never over-evicts.
    fun blobBytes(shas: Set<String>, tier: File): Long {
        var total = 0L
        for (sha in shas) {
            val p = blobPath(tier, sha)
            if (p.isFile) total += p.length()
        }
        return total
    }

    /// Every blob sha referenced by ANY folder's live generations in a tier.
    fun allFolderRefs(tier: File): Set<String> {
        val refs = HashSet<String>()
        for (dir in File(tier, "folders").listFiles() ?: emptyArray()) {
            refs.addAll(referencedShas(dir))
        }
        return refs
    }

    /// The tier bytes folder eviction can actually RECLAIM: every folder dir plus the blobs
    /// their live generations reference. Deliberately excludes the floor no folder eviction can
    /// lower — orphan blobs inside gcBlobs' grace window and staging. The single-URL plane is
    /// accounted SEPARATELY (filesPlaneBytes) and reclaimed by pointer eviction.
    fun folderAccountedBytes(tier: File): Long =
        directorySize(File(tier, "folders")) + blobBytes(allFolderRefs(tier), tier)

    /// A single-URL-plane pointer and the blob it names — oldest-touched first (a read/write
    /// stamps the pointer's mtime), so pointer eviction reclaims the least-recently-used URLs.
    fun lruFilePointers(tier: File): List<Pair<File, String>> {
        val files = File(tier, "files").listFiles() ?: emptyArray()
        return files.sortedBy { it.lastModified() }.mapNotNull { f ->
            readSHAFile(f)?.let { f to it }
        }
    }

    /// The bytes the single-URL plane can RECLAIM in a tier: each pointer's blob whose sha no
    /// FOLDER generation also references (a folder-shared blob is folder-accounted and survives
    /// pointer deletion). `folderRefs` is passed in so callers don't re-walk the folders tree.
    fun filesPlaneBytes(tier: File, folderRefs: Set<String>): Long {
        val exclusive = HashSet<String>()
        for ((_, sha) in lruFilePointers(tier)) if (!folderRefs.contains(sha)) exclusive.add(sha)
        return blobBytes(exclusive, tier)
    }

    fun stats(): Map<String, Any> {
        fun count(dir: File): Int = dir.list()?.size ?: 0
        return mapOf(
            "budget_mb" to DSXContent.contentBudgetMB(),
            "cache_bytes" to directorySize(cacheRoot),
            "pinned_bytes" to directorySize(pinnedRoot),
            "folders" to (count(File(cacheRoot, "folders")) + count(File(pinnedRoot, "folders"))),
            "blobs" to (count(File(cacheRoot, "blobs/sha256")) + count(File(pinnedRoot, "blobs/sha256"))),
        )
    }

    // MARK: anti-rollback high-water (per folder, signed manifests only)

    fun versionHighWater(dir: File?): Long? {
        if (dir == null) return null
        return readPointer(dir, "version")?.toLongOrNull()?.takeIf { it >= 0L }
    }

    fun recordVersionHighWater(dir: File, version: Long) {
        val mark = versionHighWater(dir)
        if (mark != null && version < mark) return          // never regress the mark
        runCatching { writeAtomic(File(dir, "version"), version.toString().toByteArray(Charsets.UTF_8)) }
    }

    // MARK: single-URL plane (pointer files → blobs)

    fun filePointerURL(url: String): File =
        File(File(cacheRoot, "files"), hexSHA256(url.toByteArray(Charsets.UTF_8)))

    fun cachedFile(url: String): ByteArray? {
        val pointer = filePointerURL(url)
        val sha = readSHAFile(pointer) ?: return null
        val blob = blobURL(sha) ?: return null
        // Bump the pointer's LRU clock off the render path — a frequently-served offline URL
        // must not read as least-recently-used to pointer eviction just because it never re-fetches.
        utilityExecutor.execute { pointer.setLastModified(clock()) }
        return boundedData(blob, MAXIMUM_CONTROL_BYTES)
    }

    fun writeFilePointer(url: String, sha: String) {
        if (!validSHA256(sha)) return
        val f = filePointerURL(url)
        f.parentFile?.mkdirs()
        runCatching {
            writeAtomic(f, sha.toByteArray(Charsets.UTF_8))
            f.setLastModified(clock())
        }
    }

    // MARK: materialize (a real directory view of one generation)

    /// Build `trees/<generation>/` from copies (APFS clones on iOS), staged then published by
    /// ONE atomic move — a half-built tree is never visible, concurrent builders converge (the
    /// loser's move fails against the winner's completed tree and returns it). `treeMarkerName`
    /// marks a finished tree.
    internal fun materialize(folderDir: File, generation: String, blobmap: Map<String, BlobRef>): File {
        val tree = File(File(folderDir, "trees"), generation)
        val marker = File(tree, treeMarkerName)
        if (marker.exists()) return tree
        val staging = File(tmpDir(), "tree-" + UUID.randomUUID())
        staging.mkdirs()
        try {
            for ((rel, ref) in blobmap) {
                val src = blobURL(ref.sha) ?: ref.seed?.let { seedURL(it) } ?: throw ContentError.Missing(rel)
                val dst = File(staging, rel)
                dst.parentFile?.mkdirs()
                Files.copy(src.toPath(), dst.toPath())      // clonefile on APFS — a plain copy here
            }
            File(staging, treeMarkerName).writeBytes(ByteArray(0))
            tree.parentFile?.mkdirs()
            try {
                Files.move(staging.toPath(), tree.toPath(), StandardCopyOption.ATOMIC_MOVE)
            } catch (e: Exception) {
                if (marker.exists()) return tree
                throw e
            }
            return tree
        } finally {
            staging.deleteRecursively()                     // no-op after a successful move
        }
    }

    /// Atomic replace (Swift `Data.write(options: .atomic)`): stage a sibling, rename over.
    internal fun writeAtomic(file: File, bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp-" + UUID.randomUUID())
        tmp.writeBytes(bytes)
        try {
            Files.move(tmp.toPath(), file.toPath(),
                       StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

// MARK: - The mutation core

/// ONE lock owns every store mutation (the Swift actor's twin): manifest resolve, blob download
/// (single-flight), publish, heal, eviction, pinning. Readers (Content.kt) never enter it.
/// Crash-safety comes from the disk format (see the header), not from the lock — the lock only
/// serializes writers, and is never held across a suspension point.
class ContentStore internal constructor() {

    companion object {
        val shared = ContentStore()

        internal const val MAX_LOCAL_MANIFEST_BYTES = 4L * 1024L * 1024L

        /// The `asset.url` kernel claim seam (Swift: ModuleRegistry.shared.dispatch("asset.url", key, combine = ModuleRegistry.Combine.claim);
        /// the registry is K2 `:platform`). Fed the URL's PATH (host-relative); returns a `file:`
        /// URL string (or a plain absolute path) to locally-synced bytes, or null.
        @Volatile var claimResolver: ((String) -> String?)? = null

        /// RemoteBundleGate's signing verdicts (see [ContentTrustGate]). null = signing OFF.
        @Volatile var trustGate: ContentTrustGate? = null

        /// Resolve a URL to a regular, non-symlink LOCAL file via the `asset.url` claim. The
        /// returned path is only an identity; callers reopen it with NOFOLLOW_LINKS immediately
        /// before use so a claim cannot swap a checked symlink into place.
        private fun claimLocalPath(urlString: String): java.nio.file.Path? {
            val resolver = claimResolver ?: return null
            val key = runCatching { URI(urlString).path }.getOrNull()
                .let { if (it.isNullOrEmpty()) urlString else it }
            val resolved = resolver(key) ?: return null
            val local = if (resolved.startsWith("file:")) {
                runCatching { File(URI(resolved)) }.getOrNull() ?: return null
            } else File(resolved)
            val path = local.toPath()
            return path.takeIf { Files.isRegularFile(it, LinkOption.NOFOLLOW_LINKS) }
        }

        /** Read bounded control data without `File.readBytes()` or a trusted length race. */
        internal fun claimLocalData(
            urlString: String,
            maximumBytes: Long = MAX_LOCAL_MANIFEST_BYTES,
        ): ByteArray? {
            if (maximumBytes < 0L) return null
            val path = claimLocalPath(urlString) ?: return null
            val advertised = runCatching { Files.size(path) }.getOrNull() ?: return null
            if (advertised < 0L || advertised > maximumBytes) return null
            return runCatching {
                Files.newInputStream(
                    path,
                    StandardOpenOption.READ,
                    LinkOption.NOFOLLOW_LINKS,
                ).use { input ->
                    val output = ByteArrayOutputStream(minOf(advertised, 64L * 1024L).toInt())
                    val buffer = ByteArray(64 * 1024)
                    var count = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (read == 0) continue
                        if (count > maximumBytes - read.toLong()) return@runCatching null
                        output.write(buffer, 0, read)
                        count += read
                    }
                    output.toByteArray()
                }
            }.getOrNull()
        }

        /// Standard OR url-safe base64 (with or without padding) — build pipelines emit both.
        internal fun decodeBase64(s: String): ByteArray? {
            val t = s.trim()
            runCatching { return Base64.getDecoder().decode(t) }
            var b = t.replace('-', '+').replace('_', '/')
            while (b.length % 4 != 0) b += "="
            return runCatching { Base64.getDecoder().decode(b) }.getOrNull()
        }
    }

    /// The network seam — `:platform` installs OkHttp here; null = never-network (see header).
    @Volatile var fetch: ContentFetch? = null

    /// Unstructured background work (SWR passes, shared flights, fire-and-forget pin/evict) —
    /// the Swift `Task { }` twin. Supervisor: one failed flight never poisons the store.
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val lock = Any()

    /// Where a generation's manifest came from — file resolution FOLLOWS the manifest's source
    /// (a bundled manifest never fetches file bytes from a host that serves no usable manifest:
    /// an SPA catch-all's 200-with-HTML must not become "pack bytes").
    private enum class ManifestSource(val raw: String) {
        NETWORK("network"),   // fetched + (when signing is ON) verified from the resolved root
        CLAIM("claim"),       // a locally-synced copy answered the `asset.url` claim
        SEED("seed"),         // the bundled ContentSeed — zero hosting required
    }

    private class Candidate(
        val text: String,
        val manifest: ContentManifest,
        val source: ManifestSource,
        val signedVersion: Long?,  // recorded as the folder's high-water only after a successful publish
    )

    /// Single-flight: concurrent requests for the same blob (by sha, or URL for hash-less) share
    /// one download. The bookkeeping rides the FLIGHT, so every check compares task identity —
    /// a stale cancellation can never touch a successor flight that reuses the same key.
    private class Flight(val task: Deferred<String>) {
        var waiters = 0      // callers currently awaiting this transfer
        var cancelled = 0    // how many of them were cancelled mid-await (see NOTES)
    }
    private val inflight = HashMap<String, Flight>()

    /// Single-flight for the single-URL text plane (`freshFile`) — a burst of the same URL
    /// shares one conditional GET.
    private val inflightText = HashMap<String, Deferred<ByteArray?>>()

    /// Successful single-URL fetches since the last files-plane sweep (every 16th sweeps).
    private var filesPlaneWrites = 0

    /// The in-flight revalidation task per folder key — the coalescer (`revalidateShared`) that
    /// makes a background SWR pass and a foreground `refresh` share ONE pass.
    private val revalidateTasks = HashMap<String, Deferred<ContentFolder?>>()

    /// Folders resolved THIS session — spared by eviction pass 0; only the pass-1 hard-cap
    /// backstop may evict one.
    private val sessionTouched = HashSet<String>()

    /// Folder keys with a resolve IN FLIGHT right now (refcounted for concurrent same-folder
    /// calls). A publish's `enforceBudget` protects this whole set, not just its own key.
    private val inflightPrepares = HashMap<String, Int>()

    /// Folder keys whose `content` declaration says `pinned` — a first publish creates them
    /// straight in the pinned tier.
    private val pinnedDeclared = HashSet<String>()

    private val requiresVerification: Boolean
        get() = trustGate?.requiresVerification == true

    private fun maximumBlobBytes(): Long =
        DSXContent.contentMaxBlobMB().coerceIn(1, 2_048).toLong() * 1_048_576L

    /**
     * Stream one claimed local asset into CAS staging while hashing. Both the metadata length
     * and bytes actually observed are capped; the source is reopened with NOFOLLOW_LINKS.
     */
    private fun ingestClaimedLocal(
        urlString: String,
        expectedSha: String?,
        maximumBytes: Long = maximumBlobBytes(),
    ): String? {
        val path = claimLocalPath(urlString) ?: return null
        val advertised = runCatching { Files.size(path) }.getOrNull() ?: return null
        if (advertised < 0L || advertised > maximumBytes) return null
        val staging = File(ContentDisk.tmpDir(), UUID.randomUUID().toString())
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            var count = 0L
            Files.newInputStream(
                path,
                StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS,
            ).use { input ->
                FileOutputStream(staging).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (read == 0) continue
                        if (count > maximumBytes - read.toLong()) return null
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        count += read
                    }
                    output.fd.sync()
                }
            }
            val sha = digest.digest().joinToString("") { "%02x".format(it) }
            if (expectedSha != null && sha != expectedSha) return null
            ContentDisk.ingest(tmp = staging, sha = sha)
            sha
        } catch (_: Exception) {
            null
        } finally {
            staging.delete()
        }
    }

    /** Hash a bundled seed only when it is a regular non-symlink file within the blob ceiling. */
    private fun boundedSeedHash(file: File): String? {
        val path = file.toPath()
        val maximumBytes = maximumBlobBytes()
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null
        val size = runCatching { Files.size(path) }.getOrNull() ?: return null
        if (size < 0L || size > maximumBytes) return null
        return runCatching { ContentDisk.hashFile(file) }.getOrNull()
    }

    // MARK: resolve + freshen (the dsx.content.prepare entry)

    suspend fun prepare(path: String, origin: String, manifestName: String, seed: ContentSeed?,
                        pinned: Boolean, onProgress: ((Double) -> Unit)?): ContentFolder {
        val root = DSXContent.absolute(path, origin)
        val key = ContentDisk.folderKey(root = root, manifestName = manifestName)
        synchronized(lock) {
            sessionTouched.add(key)
            inflightPrepares[key] = (inflightPrepares[key] ?: 0) + 1
        }
        try {
            // A module-declared bundled seed backs this mount unless the caller supplied its own.
            // A `pinned` declaration — or a caller asking for it — steers a first publish straight
            // into the never-purged tier, and promotes an existing cache-tier folder.
            val declared = if (seed == null) ContentDisk.declaredSeed(path, origin, manifestName) else null
            val effectiveSeed = seed ?: declared?.first
            if (pinned || declared?.second == true) {
                synchronized(lock) { pinnedDeclared.add(key) }
                val dir = ContentDisk.existingFolderDir(key)
                if (dir != null && dir.path.startsWith(ContentDisk.cacheRoot.path)) {
                    pin(path = path, origin = origin, manifestName = manifestName, pinned = true)
                }
            }

            val current = ContentDisk.loadCurrent(key = key, root = root)
            if (current != null) {
                ContentDisk.touch(key)
                if (ContentDisk.unresolvedFiles(current).isNotEmpty()) {
                    heal(current)                            // OS purge holes: best-effort foreground refill
                }
                revalidateSoon(key = key, path = path, origin = origin, root = root,
                               manifestName = manifestName, seed = effectiveSeed)
                return current                               // last-known-good, instantly — never gate on the network
            }
            return resolveFresh(key = key, root = root, manifestName = manifestName,
                                seed = effectiveSeed, onProgress = onProgress)
        } finally {
            synchronized(lock) {
                val n = (inflightPrepares[key] ?: 1) - 1
                if (n > 0) inflightPrepares[key] = n else inflightPrepares.remove(key)
            }
        }
    }

    /// Cold path (first ever use, or an unreadable current): the only foreground resolve.
    private suspend fun resolveFresh(key: String, root: String, manifestName: String,
                                     seed: ContentSeed?, onProgress: ((Double) -> Unit)?): ContentFolder {
        val (net, refused) = networkCandidate(key = key, root = root, manifestName = manifestName)
        val candidate = net ?: seedCandidate(seed)
            ?: throw if (refused) ContentError.Refused() else ContentError.NoManifest()
        // ALL-OR-NOTHING: a generation publishes only if EVERY file resolved to its declared bytes
        // (acquire throws otherwise). A partial generation is never written, so the manifest text
        // and the blobmap can never disagree.
        val blobmap = acquireAll(entries = candidate.manifest.files, root = root,
                                 source = candidate.source, seed = seed, onProgress = onProgress)
        val published = publish(key = key, root = root, candidate = candidate, blobmap = blobmap)
        feedSource(root = root, source = candidate.source)   // cold resolve — the folder's first provenance
        return published
    }

    /// Feed the kernel PROVENANCE plane (`dsx.source.content`) — ContentStore.swift's
    /// `feedSource`, at the same four seams (cold resolve · confirmed-fresh revalidation ·
    /// re-hashed equal · generation flip). This is the automatic half of the ONE-cache-primitive
    /// rule: every consumer that caches host bytes through `dsx.content` gets its source state
    /// published for free. A network-sourced manifest means the HOST answered this session →
    /// `live` + the persisted first-load stamp (keyed by the folder root, which already folds the
    /// origin in); a `.claim` resolve is the OFFLINE plane (a locally-synced copy) and a seed is
    /// the shipped floor, so both keep never|stale honest. Bytes always serve from local CAS,
    /// hence `cache` for fetched folders and `bundle` only for a seed generation.
    private fun feedSource(root: String, source: ManifestSource) {
        DSXSource.publish(
            "content",
            if (source == ManifestSource.SEED) DSXSource.servingBundle else DSXSource.servingCache,
            fresh = source == ManifestSource.NETWORK,
            key = root,
            meta = mapOf("root" to root),
        )
    }

    /// Stale-while-revalidate: refresh in the background; a NEW generation publishes atomically,
    /// fires `content.updated`, and serves on the folder's next open. Goes through the SHARED
    /// coalescer, so a background pass and a concurrent foreground `refresh` are the same pass.
    private fun revalidateSoon(key: String, path: String, origin: String, root: String,
                               manifestName: String, seed: ContentSeed?) {
        getOrStartRevalidation(
            key = key,
            path = path,
            origin = origin,
            root = root,
            manifestName = manifestName,
            seed = seed,
            onProgress = null,
        )
    }

    /** Atomically register the actual revalidation task before starting it. The old
     * launch-then-register shape left an untracked scheduling window after [prepare]
     * returned: teardown/eviction could observe no task while the queued coroutine later
     * recreated or wrote the cache. A lazy Deferred closes that window and also lets a
     * foreground [refresh] deterministically join the exact background pass. */
    private fun getOrStartRevalidation(
        key: String,
        path: String,
        origin: String,
        root: String,
        manifestName: String,
        seed: ContentSeed?,
        onProgress: ((Double) -> Unit)?,
    ): Deferred<ContentFolder?> {
        var shouldStart = false
        val task = synchronized(lock) {
            revalidateTasks[key] ?: scope.async(start = CoroutineStart.LAZY) {
                revalidateNow(
                    key = key,
                    path = path,
                    origin = origin,
                    root = root,
                    manifestName = manifestName,
                    seed = seed,
                    onProgress = onProgress,
                )
            }.also { created ->
                revalidateTasks[key] = created
                created.invokeOnCompletion {
                    synchronized(lock) {
                        if (revalidateTasks[key] === created) revalidateTasks.remove(key)
                    }
                }
                shouldStart = true
            }
        }
        // Starting outside the mutation monitor preserves the actor law: task code and
        // suspension points never execute while the store lock is held. Awaiting a lazy
        // task in the tiny unlock/start window is also safe; await starts it idempotently.
        if (shouldStart) task.start()
        return task
    }

    /// COALESCED revalidation: at most ONE `revalidateNow` per folder key at a time. A background
    /// SWR pass and a foreground `refresh` for the same key share the one task — never two
    /// concurrent passes (which would double-fetch, double-publish, and double-ring the update
    /// bell). Check-and-insert is atomic under the lock (the actor's guarantee).
    private suspend fun revalidateShared(key: String, path: String, origin: String, root: String,
                                         manifestName: String, seed: ContentSeed?,
                                         onProgress: ((Double) -> Unit)?): ContentFolder? {
        val task = getOrStartRevalidation(
            key = key,
            path = path,
            origin = origin,
            root = root,
            manifestName = manifestName,
            seed = seed,
            onProgress = onProgress,
        )
        val result = try {
            task.await()
        } catch (e: CancellationException) {
            // The SHARED pass was cancelled (evict) while WE weren't: the folder is being
            // destroyed — abandon with null (pinned deviation, see NOTES). Our own cancellation
            // propagates as ever.
            if (currentCoroutineContext().isActive) null else throw e
        }
        return result
    }

    /// FOREGROUND revalidation (the dsx.content.refresh entry) — same core as the background
    /// pass, awaited, for callers that must apply an update BEFORE proceeding (the offline-app
    /// boot gate). Returns the folder current AFTER the attempt; null only if never resolved.
    suspend fun refresh(path: String, origin: String, manifestName: String,
                        onProgress: ((Double) -> Unit)?): ContentFolder? {
        val root = DSXContent.absolute(path, origin)
        val key = ContentDisk.folderKey(root = root, manifestName = manifestName)
        synchronized(lock) { sessionTouched.add(key) }
        val declared = ContentDisk.declaredSeed(path, origin, manifestName)
        return revalidateShared(key = key, path = path, origin = origin, root = root,
                                manifestName = manifestName, seed = declared?.first,
                                onProgress = onProgress)
    }

    /// The shared revalidation core. Fetch the manifest, acquire what changed, publish
    /// atomically, announce `content.updated` — only on a REAL generation change; any failure
    /// leaves the last-known-good serving. Returns the folder current after the attempt.
    private suspend fun revalidateNow(key: String, path: String, origin: String, root: String,
                                      manifestName: String, seed: ContentSeed?,
                                      onProgress: ((Double) -> Unit)?): ContentFolder? {
        val current = ContentDisk.loadCurrent(key = key, root = root) ?: return null
        val (net, _) = networkCandidate(key = key, root = root, manifestName = manifestName)
        // The seed refreshes only a SEED-SOURCED folder (a rebuilt app ships a rebuilt seed — the
        // old build's cached pack must not shadow it). A network-sourced folder never falls back
        // to the seed here: a connectivity blip must not replace hosted content with the sample.
        val candidate = net
            ?: (if (current.source == ManifestSource.SEED.raw) seedCandidate(seed) else null)
            ?: return current
        // SHORT-CIRCUIT on an UNCHANGED manifest (see the Swift source for the three gates):
        //   • never a .seed source — a seed's manifest text is static but its files are rebuilt
        //     per app BUILD, so a seed folder must re-hash;
        //   • only when the unchanged manifest actually DETECTS change — every file sha-pinned,
        //     or a `deployed_at` timestamp (NOT `version`: commonly a static schema marker);
        //   • only while the current generation is WHOLE — with purge holes the pass must fall
        //     through so acquireAll re-downloads the missing blobs (refresh heals, not just prepare).
        if (candidate.source != ManifestSource.SEED &&
            (current.manifest.files.all { it.sha256 != null } || current.manifest.deployedAt != null) &&
            ContentDisk.unresolvedFiles(current).isEmpty()) {
            val dir = ContentDisk.existingFolderDir(key)
            if (dir != null && ContentDisk.manifestText(dir, current.generation) == candidate.text) {
                feedSource(root = root, source = candidate.source)   // the host CONFIRMED current — the previously-silent "still fresh" signal
                return current
            }
        }
        // ALL-OR-NOTHING (see resolveFresh): if any file can't be freshly resolved, acquireAll
        // throws and we keep the last-known-good generation intact — never a torn publish.
        val blobmap = try {
            acquireAll(entries = candidate.manifest.files, root = root,
                       source = candidate.source, seed = seed, onProgress = onProgress)
        } catch (_: Exception) { return current }             // incl. cancellation — the isActive check below decides
        // `evict` cancels this task then deletes the folder dirs. If the resolve finished from
        // CAS with no cancellable download, cancellation didn't unwind it — so re-check here
        // before publish(), whose ensureFolderDir would otherwise RECREATE the just-evicted
        // folder (a resurrect). A cancelled pass abandons its result, last-good stays.
        if (!currentCoroutineContext().isActive) return current
        if (ContentDisk.generationID(blobmap) == current.generation) {
            // Fresh already — but a HEAL pass lands its re-downloaded blobs in the CACHE tier and
            // no publish will run to clone them: re-clone into the pinned tier when this folder
            // lives there, so a healed pinned folder is purge-proof again (a no-op otherwise).
            if (ContentDisk.existingFolderDir(key)?.path?.startsWith(ContentDisk.pinnedRoot.path) == true) {
                ContentDisk.cloneBlobs(blobmap.values.map { it.sha }.toSet(), toTier = ContentDisk.pinnedRoot)
            }
            feedSource(root = root, source = candidate.source)   // re-hashed equal — fresh confirm (or a seed re-serve)
            return current
        }
        val published = try {
            publish(key = key, root = root, candidate = candidate, blobmap = blobmap)
        } catch (_: Exception) { return current }
        feedSource(root = root, source = candidate.source)       // a NEW generation went live
        // The `content.updated` kernel event — through the DSXEvents façade (its mainExecutor
        // seam is the DispatchQueue.main hop); the .void fold's twin rides `:platform`.
        DSXEvents().publish("content.updated", "content.updated", mapOf(
            "path" to path, "origin" to origin, "root" to root,
            "manifest" to manifestName, "generation" to published.generation))
        return published
    }

    /// Refill purge holes against the CURRENT generation's own hashes (no generation change).
    /// Best-effort: offline holes stay holes until the next online prepare.
    private suspend fun heal(folder: ContentFolder) {
        for (rel in ContentDisk.unresolvedFiles(folder)) {
            val ref = folder.blobmap[rel] ?: continue
            val urlString = folder.root + rel
            if (ingestClaimedLocal(urlString, expectedSha = ref.sha) != null) {
                continue
            }
            try { download(urlString = urlString, expectSha = ref.sha, key = ref.sha) }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { }
        }
        // Healed bytes land in the cache tier (ingest) — re-clone into the pinned tier when this
        // folder lives there, so a heal restores purge-proofness, not just readability.
        if (folder.folderDir.path.startsWith(ContentDisk.pinnedRoot.path)) {
            ContentDisk.cloneBlobs(folder.blobmap.values.map { it.sha }.toSet(),
                                   toTier = ContentDisk.pinnedRoot)
        }
    }

    // MARK: manifest candidates

    /// Fetch + vet the hosted manifest. Returns (candidate, refusedBySigning) — refused means a
    /// manifest PARSED but failed the signing gate, which callers surface differently from
    /// "nothing there".
    private suspend fun networkCandidate(key: String, root: String,
                                         manifestName: String): Pair<Candidate?, Boolean> {
        val fetched = fetchManifest(root = root, manifestName = manifestName)
        val text = fetched.text ?: return null to false
        val manifest = ContentManifest.parse(text = text) ?: return null to false
        if (fetched.fromNetwork) {
            if (!trustNetworkManifest(text = text, signature = fetched.signature,
                                      folderKey = key, version = manifest.version)) {
                kernelLog("[DSXContent] refusing unverified manifest at $root$manifestName (signing is ON) — last-good keeps serving")
                return null to true
            }
            // A verified SIGNATURE covers the manifest bytes — but a file with NO declared sha256
            // is acquired with no byte check, so signing a hash-less manifest would publish
            // unverifiable content under a trusted deployment: with signing ON a network manifest
            // is trusted only when EVERY file is sha-pinned (Article 7).
            if (requiresVerification && !manifest.files.all { it.sha256 != null }) {
                kernelLog("[DSXContent] refusing signed manifest at $root$manifestName with hash-less files (signing is ON) — every file must be sha-pinned")
                return null to true
            }
            val signedVersion = if (requiresVerification) manifest.version else null
            return Candidate(text, manifest, ManifestSource.NETWORK, signedVersion) to false
        }
        return Candidate(text, manifest, ManifestSource.CLAIM, null) to false
    }

    private fun seedCandidate(seed: ContentSeed?): Candidate? {
        val text = seed?.manifestText?.invoke() ?: return null
        val manifest = ContentManifest.parse(text = text) ?: return null
        return Candidate(text, manifest, ManifestSource.SEED, null)
    }

    private class FetchedManifest(val text: String?, val signature: ByteArray?, val fromNetwork: Boolean)

    /// Manifest transport: a locally-synced copy (the `asset.url` claim — the offline plane)
    /// wins, else the network. The ACCEPTANCE RULE (parse as object + file list) is applied by
    /// the caller either way, so no source can poison the store with a 200-that-isn't-a-manifest.
    private suspend fun fetchManifest(root: String, manifestName: String): FetchedManifest {
        val urlString = root + manifestName
        // The local claim shortcut is UNVERIFIED (there's no signature to check), so it is
        // trusted ONLY when signing is off. With signing ON the manifest must come from the
        // network and pass the gate. Per-FILE claim resolution stays safe because those files
        // are sha-checked against the (now verified) manifest.
        if (!requiresVerification) {
            claimLocalData(urlString, MAX_LOCAL_MANIFEST_BYTES)?.let {
                return FetchedManifest(it.toString(Charsets.UTF_8), null, false)
            }
        }
        val f = fetch ?: return FetchedManifest(null, null, false)
        val resp = try { f.data(urlString) }
                   catch (e: CancellationException) { throw e }
                   catch (_: Exception) { null }
        if (resp == null || resp.status !in 200..299) return FetchedManifest(null, null, false)
        var signature: ByteArray? = null
        if (requiresVerification) {
            resp.headers.entries.firstOrNull { it.key.equals("X-DSX-Signature", ignoreCase = true) }
                ?.let { signature = decodeBase64(it.value) }
            if (signature == null) {
                val sig = try { f.data("$urlString.sig") }
                          catch (e: CancellationException) { throw e }
                          catch (_: Exception) { null }
                if (sig != null && sig.status in 200..299) {
                    signature = decodeBase64(sig.body.toString(Charsets.UTF_8)) ?: sig.body
                }
            }
        }
        return FetchedManifest(resp.body.toString(Charsets.UTF_8), signature, true)
    }

    /// The signing gate for a NETWORK manifest — the gate's PURE per-anchor math (via the
    /// [ContentTrustGate] seam), deliberately NOT a recorded-digest verify (that slot is the
    /// route table's verdict). Anti-rollback is per-folder (high-water file): the version rides
    /// inside the signed bytes, and the mark never regresses.
    private fun trustNetworkManifest(text: String, signature: ByteArray?,
                                     folderKey: String, version: Long?): Boolean {
        val gate = trustGate ?: return true                        // signing OFF ⇒ source trust, as ever
        if (!gate.requiresVerification) return true
        if (gate.isMisconfigured) return false                     // ON with no usable key ⇒ fail closed
        if (signature == null || signature.isEmpty()) return false
        if (!gate.verify(text.toByteArray(Charsets.UTF_8), signature)) return false
        if (version != null) {
            val mark = ContentDisk.versionHighWater(ContentDisk.existingFolderDir(folderKey))
            if (mark != null && version < mark) return false       // a replayed older manifest is refused
        }
        return true
    }

    // MARK: per-file acquisition (the resolution chain)

    private suspend fun acquireAll(entries: List<ContentManifest.Entry>, root: String,
                                   source: ManifestSource, seed: ContentSeed?,
                                   onProgress: ((Double) -> Unit)?): Map<String, BlobRef> {
        // Files with a safe relative path (normalizeRel drops "."/".."/absolute-URL entries →
        // empty, which is skipped). A manifest that lists files but whose entries ALL normalize
        // away must NOT publish a zero-file generation over a good one — reject it.
        val jobs = entries.mapNotNull { entry ->
            val rel = ContentDisk.normalizeRel(entry.path)
            if (rel.isEmpty()) null else rel to entry
        }
        if (jobs.isEmpty()) {
            if (entries.isEmpty()) return emptyMap()          // a genuinely empty manifest is a valid empty generation
            throw ContentError.NoManifest()                   // every listed entry was rejected ⇒ not a usable generation
        }

        // iOS's destination filesystem is normally case-insensitive and Unicode-normalizing.
        // Reject ambiguous aliases on every platform so a generation never depends on which
        // concurrent transfer finishes last.
        val identities = HashSet<String>()
        for ((rel, _) in jobs) {
            val identity = Normalizer.normalize(rel, Normalizer.Form.NFC).lowercase(Locale.ROOT)
            if (!identities.add(identity)) throw ContentError.NoManifest()
        }

        // BOUNDED fan-out: a fixed worker pool (`withTaskGroup`'s sliding-window twin). Up to six
        // downloads overlap, and even a maximal manifest creates only six coroutines rather than
        // one suspended coroutine per file. The store's
        // single-flight dedups identical blobs; a throwing acquire cancels the rest and
        // propagates, exactly as the sequential `try await` did.
        val workerCount = minOf(6, jobs.size)
        val next = AtomicInteger(0)
        val out = HashMap<String, BlobRef>()
        var done = 0
        val progressLock = Any()
        coroutineScope {
            List(workerCount) {
                async {
                    while (true) {
                        val index = next.getAndIncrement()
                        if (index >= jobs.size) break
                        val (rel, entry) = jobs[index]
                        val ref = acquire(entry = entry, rel = rel, root = root,
                                          source = source, seed = seed)
                        synchronized(progressLock) {
                            out[rel] = ref
                            done += 1
                            onProgress?.invoke(done.toDouble() / jobs.size)
                        }
                    }
                }
            }.awaitAll()
        }
        return out
    }

    /// Resolve ONE file to a verified blob, or THROW. There is deliberately no "stale previous
    /// generation" fallback: a folder either produces a COMPLETE new generation or `acquireAll`
    /// throws and the caller keeps the last-known-good one whole (atomic generations).
    private suspend fun acquire(entry: ContentManifest.Entry, rel: String, root: String,
                                source: ManifestSource, seed: ContentSeed?): BlobRef {
        val urlString = root + rel
        val maximumBytes = maximumBlobBytes()
        entry.bytes?.let { declared ->
            // Declared bytes are only a preflight hint. Reject impossible/oversized entries,
            // then still enforce the actual streamed bytes on every source below.
            if (declared < 0L || declared > maximumBytes) throw ContentError.Missing(rel)
        }

        val sha = entry.sha256
        if (sha != null) {
            // A declared sha ⇒ offline-first: the hash is integrity AND the change detector.
            if (ContentDisk.hasBlob(sha)) return BlobRef(sha, null)                     // 1. CAS (verified, instant)
            val seedFile = seed?.fileURL?.invoke(rel)                                   // 2. bundled seed (zero-copy)
            if (seedFile != null && boundedSeedHash(seedFile) == sha) {
                return BlobRef(sha, seedFile.name)
            }
            if (ingestClaimedLocal(urlString, expectedSha = sha, maximumBytes = maximumBytes) != null) {
                return BlobRef(sha, null)
            }
            if (source != ManifestSource.SEED) {                                        // 4. network (verified)
                try {
                    return BlobRef(download(urlString = urlString, expectSha = sha, key = sha), null)
                } catch (e: ContentError.Integrity) {
                    throw ContentError.Integrity(rel)                                   // bad bytes: loud, never silent
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) { }
            }
            throw ContentError.Missing(rel)                                             // incomplete → abandon the whole generation
        }

        // No declared sha ⇒ nothing but fresh bytes can detect change.
        when (source) {
            ManifestSource.SEED -> {
                // The manifest itself is bundled: the host serves no usable manifest for this
                // folder, so its file URLs are not trusted either. The bundle is the truth;
                // hashing it names the generation, so a rebuilt bundled file IS a new generation.
                val u = seed?.fileURL?.invoke(rel)
                if (u != null) {
                    boundedSeedHash(u)?.let { return BlobRef(it, u.name) }
                }
                throw ContentError.Missing(rel)
            }
            ManifestSource.NETWORK, ManifestSource.CLAIM -> {
                // A hosted manifest ⇒ network-first (fresh bytes win); seed / synced are the
                // offline fallbacks. No previous-generation substitution — see the method note.
                try {
                    return BlobRef(download(urlString = urlString, expectSha = null,
                                            key = "url:$urlString"), null)
                } catch (e: CancellationException) { throw e } catch (_: Exception) { }
                val u = seed?.fileURL?.invoke(rel)
                if (u != null) {
                    boundedSeedHash(u)?.let { return BlobRef(it, u.name) }
                }
                val h = ingestClaimedLocal(
                    urlString,
                    expectedSha = null,
                    maximumBytes = maximumBytes,
                )
                if (h != null) {
                    return BlobRef(h, null)
                }
                throw ContentError.Missing(rel)
            }
        }
    }

    // MARK: download (single-flight, verify, ingest)

    /// Download → streaming hash → (optional) verify → atomic rename into the CAS. Returns the
    /// blob's sha. Single-flight per `key`: concurrent callers share one transfer. Total mapping:
    /// transport/HTTP failures are `Missing`, a hash mismatch is `Integrity` (and NEVER
    /// overwrites an existing good blob — the mismatched bytes are discarded in staging).
    /// CANCELLATION-RESPONSIVE: a cancelled waiter that is the LAST live one cancels the shared
    /// transfer, and every remaining waiter resumes promptly with `Missing` (see NOTES for the
    /// counter bookkeeping — same invariant as Swift, adapted to Kotlin's immediate unwind).
    private suspend fun download(urlString: String, expectSha: String?, key: String): String {
        val flight = synchronized(lock) {
            val running = inflight[key]
            val f = if (running != null && !running.task.isCancelled) {
                running
            } else {
                // No flight, or the previous one was just cancelled — a fresh caller must never
                // join a poisoned task, so REPLACE the entry; the old flight's waiters hold their
                // own reference and their identity-checked cleanup skips the new entry.
                Flight(scope.async { performDownload(urlString, expectSha) }).also { inflight[key] = it }
            }
            f.waiters += 1
            f
        }
        var wasCancelled = false
        try {
            return flight.task.await()
        } catch (e: CancellationException) {
            if (currentCoroutineContext().isActive) {
                // WE are alive; the SHARED transfer was cancelled (its last live waiter gave up
                // before we joined completion) — resume promptly with `.missing`, as Swift does.
                throw ContentError.Missing(urlString)
            }
            wasCancelled = true
            abandonDownload(key, flight)
            throw e
        } finally {
            synchronized(lock) {
                val cur = inflight[key]
                if (cur === flight) {
                    cur.waiters -= 1
                    if (wasCancelled) cur.cancelled -= 1          // keep the "only live waiters count" invariant
                    if (cur.waiters <= 0) inflight.remove(key)
                }
            }
        }
    }

    private suspend fun performDownload(urlString: String, expectSha: String?): String {
        val f = fetch ?: throw ContentError.Missing(urlString)
        val tmp = File(ContentDisk.tmpDir(), UUID.randomUUID().toString())
        val status = try { f.download(urlString, tmp) }
                     catch (e: CancellationException) { tmp.delete(); throw e }
                     catch (_: Exception) { null }
        if (status == null || status !in 200..299) {
            tmp.delete()
            throw ContentError.Missing(urlString)
        }
        if (!tmp.isFile || tmp.length() < 0L || tmp.length() > maximumBlobBytes()) {
            tmp.delete()
            throw ContentError.Missing(urlString)
        }
        val sha = runCatching { ContentDisk.hashFile(tmp) }.getOrNull()
        if (sha == null) {
            tmp.delete()
            throw ContentError.Missing(urlString)
        }
        if (expectSha != null && sha != expectSha) {
            tmp.delete()
            kernelLog("[DSXContent] integrity mismatch for $urlString (declared $expectSha, got $sha) — bytes discarded")
            throw ContentError.Integrity(urlString)
        }
        ContentDisk.ingest(tmp = tmp, sha = sha)
        return sha
    }

    /// A `download` waiter was cancelled mid-await. Cancel the shared transfer only once EVERY
    /// live waiter is cancelled (an un-cancelled waiter still wants the bytes — the transfer
    /// runs on for it). Identity-checked: a cancellation raised against an earlier flight never
    /// touches the one now under the key.
    private fun abandonDownload(key: String, flight: Flight) {
        synchronized(lock) {
            val cur = inflight[key]
            if (cur !== flight) return
            cur.cancelled += 1
            if (cur.cancelled >= cur.waiters) cur.task.cancel()
        }
    }

    // MARK: publish (atomic generation flip)

    /// Write the generation's two artifacts, THEN flip `current` (old current → `previous`).
    /// Crash anywhere = old fully live or new fully published, never torn. Prunes to the
    /// keep-two rule and enforces the budget after every publish. Serialized under the store
    /// lock (the actor's no-await section).
    private fun publish(key: String, root: String, candidate: Candidate,
                        blobmap: Map<String, BlobRef>): ContentFolder = synchronized(lock) {
        val dir = ContentDisk.ensureFolderDir(key, preferPinned = pinnedDeclared.contains(key))
        val gen = ContentDisk.generationID(blobmap)
        val gens = File(dir, "gens")
        gens.mkdirs()
        ContentDisk.writeAtomic(File(gens, "$gen.json"), candidate.text.toByteArray(Charsets.UTF_8))
        ContentDisk.writeAtomic(File(gens, "$gen.blobmap"),
                                ContentDisk.blobmapData(blobmap, source = candidate.source.raw))
        val old = ContentDisk.readGenerationPointer(dir, "current")
        if (old != null && old != gen) {
            runCatching { ContentDisk.writeAtomic(File(dir, "previous"), old.toByteArray(Charsets.UTF_8)) }
        }
        ContentDisk.writeAtomic(File(dir, "current"), gen.toByteArray(Charsets.UTF_8))
        candidate.signedVersion?.let { ContentDisk.recordVersionHighWater(dir, it) }
        val prunedAGeneration = ContentDisk.pruneGenerations(dir)
        ContentDisk.touch(key)
        // A pinned folder must be SELF-CONTAINED in the never-purged tier — clone its blobs there
        // (ingest writes them to cache), so a cache purge can't strip an offline-critical bundle
        // out from under a pinned folder pointer.
        if (dir.path.startsWith(ContentDisk.pinnedRoot.path)) {
            ContentDisk.cloneBlobs(blobmap.values.map { it.sha }.toSet(), toTier = ContentDisk.pinnedRoot)
            ContentDisk.applyBackupExclusion()
        }
        // Collect the blobs the pruned N-2 generation orphaned. enforceBudget's own gcBlobs only
        // runs when the CACHE budget trips — a pinned-only app would otherwise never GC, growing
        // the never-purged tier with every deploy. The ingest grace protects this publish's blobs.
        if (prunedAGeneration) ContentDisk.gcBlobs()
        enforceBudget(protecting = key)
        return ContentDisk.loadCurrent(key = key, root = root) ?: throw ContentError.NoManifest()
    }

    // MARK: eviction (generation-granular, LRU, never a live/in-flight folder)

    /// The two cache planes are capped INDEPENDENTLY against `content.budget_mb`: the folder
    /// plane and the single-URL plane. Keeping them separate avoids a coupling trap — a blob
    /// shared by a folder and a pointer would otherwise just move between the two accountings
    /// as a folder is evicted, making the folder sweep over-evict.
    private fun enforceBudget(protecting: String? = null) {
        val budgetBytes = DSXContent.contentBudgetMB() * 1_048_576L
        if (budgetBytes <= 0) return
        evictFolders(budgetBytes = budgetBytes, protecting = protecting)
        evictFilePointers(budgetBytes = budgetBytes)
    }

    private fun evictFolders(budgetBytes: Long, protecting: String?) {
        val cache = ContentDisk.cacheRoot
        // Reclaimable folder bytes: folder dirs + their referenced blobs. Graced orphans of an
        // aborted publish and staging are excluded — folder eviction can't claw those back.
        var size = ContentDisk.folderAccountedBytes(cache)
        if (size <= budgetBytes) return

        // NEVER evict `protecting` (the folder whose publish invoked this: its `touch` stamp may
        // not have landed, sorting it LRU-FIRST — evicting it would fail the publish it rode in
        // on and re-download forever) nor any folder with a resolve IN FLIGHT (a `prepareAll`
        // batch must not cannibalize a sibling handle it's about to return). Pinned content
        // lives in the never-purged tier and is never seen here.
        val shielded = HashSet(inflightPrepares.keys)
        if (protecting != null) shielded.add(protecting)

        // Pass 0 evicts folders NOT touched this session; pass 1 (backstop) may evict a session
        // folder too — EXCEPT one heavier than the whole budget, since evicting a >budget live
        // folder can never end the overage and only buys a re-download loop. `estimate` drops
        // `size` by each folder's weight so the loop stops as soon as it's under budget; the
        // accurate re-measured pass below corrects any optimism.
        fun sweep(estimate: Boolean) {
            for (pass in 0 until 2) {
                if (size <= budgetBytes) break
                for (key in ContentDisk.lruFolderKeys()) {
                    if (size <= budgetBytes) break
                    if (shielded.contains(key)) continue
                    val dir = ContentDisk.folderDir(key, cache)
                    if (!dir.exists()) continue
                    val weight = ContentDisk.directorySize(dir) +
                        ContentDisk.blobBytes(ContentDisk.referencedShas(dir), cache)
                    if (sessionTouched.contains(key) && (pass == 0 || weight > budgetBytes)) continue
                    ContentDisk.removeFolder(key, cache)
                    if (estimate) {
                        size -= weight
                    } else {
                        ContentDisk.gcBlobs()
                        size = ContentDisk.folderAccountedBytes(cache)
                    }
                }
            }
        }
        sweep(estimate = true)
        ContentDisk.gcBlobs()
        // The estimate is OPTIMISTIC (a subtracted blob survives GC when another folder shares
        // it), so re-measure and, only if it fell short, run the accurate per-eviction sweep.
        size = ContentDisk.folderAccountedBytes(cache)
        sweep(estimate = false)
    }

    /// Cap the single-URL plane: if its exclusive blob bytes exceed the budget, evict its
    /// least-recently-used pointers (each deletes a URL→sha pointer; its now-orphaned blob is
    /// collected by the trailing gcBlobs). Folder-shared blobs are never counted or freed here.
    /// Refcounts pointers to a shared sha so bytes are credited only when the LAST pointer goes.
    private fun evictFilePointers(budgetBytes: Long) {
        val cache = ContentDisk.cacheRoot
        val folderRefs = ContentDisk.allFolderRefs(cache)
        var size = ContentDisk.filesPlaneBytes(cache, folderRefs = folderRefs)
        if (size <= budgetBytes) return
        val pointers = ContentDisk.lruFilePointers(cache)
        val refCount = HashMap<String, Int>()
        for ((_, sha) in pointers) if (!folderRefs.contains(sha)) refCount[sha] = (refCount[sha] ?: 0) + 1
        var evicted = false
        for ((pointer, sha) in pointers) {
            if (size <= budgetBytes) break
            // Skip a folder-shared pointer BEFORE deleting it: its blob survives via the folder
            // plane, so deletion frees zero bytes AND loses a still-valid offline cache entry.
            if (folderRefs.contains(sha)) continue
            pointer.delete()
            evicted = true
            val remaining = (refCount[sha] ?: 1) - 1
            refCount[sha] = remaining
            if (remaining <= 0) size -= ContentDisk.blobBytes(setOf(sha), cache)
        }
        if (evicted) ContentDisk.gcBlobs()
    }

    // MARK: pin / evict / single-URL

    /// Move a folder between tiers. Bytes first: referenced blobs are CLONED into the destination
    /// tier before the folder moves, so a pinned folder never depends on purgeable bytes.
    fun pin(path: String, origin: String, manifestName: String, pinned: Boolean): Unit = synchronized(lock) {
        val root = DSXContent.absolute(path, origin)
        val key = ContentDisk.folderKey(root = root, manifestName = manifestName)
        // Keep the steer-first-publish flag in lockstep with the tier: pinning marks the folder
        // so a later cold re-resolve republishes into the pinned tier; unpinning clears it so
        // the next prepare doesn't silently re-promote content the caller just demoted.
        if (pinned) pinnedDeclared.add(key) else pinnedDeclared.remove(key)
        val srcTier = if (pinned) ContentDisk.cacheRoot else ContentDisk.pinnedRoot
        val dstTier = if (pinned) ContentDisk.pinnedRoot else ContentDisk.cacheRoot
        val srcDir = ContentDisk.folderDir(key, srcTier)
        val dstDir = ContentDisk.folderDir(key, dstTier)
        if (!srcDir.exists()) {
            if (pinned) ContentDisk.applyBackupExclusion()
            return                                            // already in the target tier (or never resolved)
        }
        ContentDisk.cloneBlobs(ContentDisk.referencedShas(srcDir), toTier = dstTier)
        if (dstDir.exists()) {
            srcDir.deleteRecursively()
        } else {
            dstDir.parentFile?.mkdirs()
            runCatching { Files.move(srcDir.toPath(), dstDir.toPath()) }
        }
        ContentDisk.invalidateGenCache(key)   // the folderDir moved tiers — a memoized handle is now stale
        ContentDisk.gcBlobs()
        if (pinned) ContentDisk.applyBackupExclusion()
    }

    fun evict(path: String, origin: String, manifestName: String) {
        val root = DSXContent.absolute(path, origin)
        val key = ContentDisk.folderKey(root = root, manifestName = manifestName)
        synchronized(lock) {
            // Cancel an in-flight coalesced revalidation FIRST — otherwise its acquireAll
            // finishes and publish() re-creates gens/current right after we delete them (the
            // folder resurrects and the disk isn't freed). The cancellation-responsive download
            // unwinds it; the running pass's own cleanup nils the map entry.
            revalidateTasks[key]?.cancel()
            ContentDisk.removeFolder(key, ContentDisk.cacheRoot)
            ContentDisk.removeFolder(key, ContentDisk.pinnedRoot)
            sessionTouched.remove(key)
            pinnedDeclared.remove(key)      // a re-resolve shouldn't be steered pinned by a stale flag
            ContentDisk.gcBlobs()
        }
    }

    /// The single-URL plane's network fetch: through the same single-flight + CAS, remembered
    /// for `cachedFile`. null on any failure — the previously cached copy is never touched (the
    /// facade's `file()` composes the cached fallback).
    suspend fun freshFile(url: String): ByteArray? {
        val task: Deferred<ByteArray?>
        var mine = false
        synchronized(lock) {
            val running = inflightText[url]
            if (running != null) {
                task = running
            } else {
                task = scope.async { performFreshFile(url) }
                inflightText[url] = task
                mine = true
            }
        }
        val result = try { task.await() }
                     catch (e: CancellationException) {
                         if (currentCoroutineContext().isActive) null else throw e
                     }
        if (!mine) return result
        synchronized(lock) { if (inflightText[url] === task) inflightText.remove(url) }
        // Bound the single-URL plane for a workload that only fetches (never publishes a folder,
        // so publish()'s enforceBudget never runs): sweep every 16th successful fetch. Cheap
        // amortized — a full pointer walk once per 16 fetches, only evicts when over budget.
        if (result != null) {
            synchronized(lock) {
                filesPlaneWrites += 1
                if (filesPlaneWrites % 16 == 0) {
                    val budgetBytes = DSXContent.contentBudgetMB() * 1_048_576L
                    if (budgetBytes > 0) evictFilePointers(budgetBytes = budgetBytes)
                }
            }
        }
        return result
    }

    private suspend fun performFreshFile(url: String): ByteArray? {
        // The single-URL plane fetches through the MANIFEST leg of the seam (protocol cache ON)
        // — so ETag/If-None-Match revalidation works and an unchanged resource returns 304 with
        // no body transfer. Bytes still land in the CAS; the URL→sha pointer is remembered for
        // `cachedFile`.
        val f = fetch ?: return null
        val resp = try { f.data(url) }
                   catch (e: CancellationException) { throw e }
                   catch (_: Exception) { null } ?: return null
        if (resp.status !in 200..299) return null
        // The single-URL API returns a ByteArray, so it has the control/heap ceiling rather than
        // the configurable streaming folder-blob ceiling (which may be as high as 2 GiB).
        if (resp.body.size.toLong() > ContentDisk.MAXIMUM_CONTROL_BYTES) return null
        val sha = ContentDisk.hashData(resp.body)
        // Only remember the URL→sha pointer if the blob actually landed — an ingest failure
        // (disk full) would otherwise leave a pointer naming a missing blob, so `cachedFile`
        // returns null forever for a URL whose fresh bytes we're holding right here.
        runCatching {
            ContentDisk.ingest(data = resp.body, sha = sha)
            ContentDisk.writeFilePointer(url = url, sha = sha)
        }
        return resp.body
    }
}
