//
//  Content.swift — `dsx.content`: the kernel CONTENT primitive.
//
//  Folder-shaped, generation-versioned, offline-first, app-authored content. An app hosts content
//  FOLDERS on its own web host under the content root (App.json `hosting.content_root`, default
//  `/dsx`): a folder is a manifest (`manifest.json` by default; a consumer may name its own, e.g.
//  Godot's `godot-manifest.json`) listing files with optional per-file SHA-256, plus the files.
//  The kernel resolves a folder to LOCAL VERIFIED bytes and keeps it fresh — every surface (a
//  native module loading a game pack, a DSX screen, the web-serving package) consumes the SAME
//  store, so bytes are downloaded once, verified once, and cached once (the "one asset plane").
//
//  THE TWO CALLS (mechanism only — serving, prefetch policy and sync UX are a module's):
//    • `dsx.content.folder(path)`   — SYNCHRONOUS, render-path-safe: the last-known-good
//      generation straight off disk. Never touches the network. nil until the folder has ever
//      been prepared (or seeded). This is the never-block law: a screen open never gates on a
//      manifest round-trip.
//    • `try await dsx.content.prepare(path)` — resolve + freshen. Warm: returns the CURRENT
//      generation immediately and revalidates in the background (stale-while-revalidate); a new
//      generation publishes ATOMICALLY, fires the `content.updated` kernel event, and is served
//      on the NEXT open — never swapped under a live consumer (a visit pins one generation for
//      its lifetime; mixing old and new files mid-visit is the classic OTA corruption). Cold
//      (first ever use): a foreground resolve behind the caller's own skeleton — the only time
//      the network is in the path, and only because there is nothing local yet.
//
//  THE STORE (ContentStore.swift) is content-addressed: verified bytes live ONCE in
//  `blobs/sha256/<hex>` (deduped across folders and publishes — an unchanged 30 MB pack across
//  ten releases is stored and downloaded once); a GENERATION is nothing but a `path → sha` map +
//  the accepted manifest bytes; `current`/`previous` are atomic pointers. A generation id is the
//  hash of its path→sha map, so "same files" IS "same generation" and a changed file IS a new
//  generation — sha256 is both the integrity check and the change detector.
//
//  RESOLUTION CHAIN, per file (offline-first when a sha is declared):
//      CAS blob (already verified, instant) → bundled SEED (a module-shipped copy, zero-copy)
//      → the `asset.url` kernel claim (a locally-synced copy, the offline plane) → network
//      (download → hash-verify → ingest) → missing (throws — the WHOLE generation is abandoned,
//      all-or-nothing, and the last-known-good one keeps serving).
//  A file with NO declared sha inverts to network-first when online (fresh bytes win — nothing
//  else can detect change), cached/seed as the offline fallback. A manifest is USABLE only if it
//  parses as a JSON object carrying a file list — a captive portal's or SPA catch-all's
//  200-with-HTML can never poison the store or defeat a bundled seed.
//
//  TRUST: reuses the ONE gate (RemoteBundleGate). Signing OFF (no App.json `bundle_signing`) ⇒
//  manifests are trusted by source exactly as before. Signing ON ⇒ a NETWORK manifest must carry
//  a valid detached signature (`X-DSX-Signature` header or `<manifest>.sig` sidecar) over its
//  exact bytes, verified against the baked anchors with the gate's PURE per-anchor math — never
//  `verifyManifest`, whose single recorded-digest slot belongs to the route table (recording a
//  content manifest there would evict the Router's routes verdict). Rejection refuses only the
//  NEW generation: the last-good one keeps serving (fail-closed on new content, never brick
//  current content — Article 7). Per-folder anti-rollback rides a signed `version` field.
//
//  STORAGE: `Library/Caches/dsx-content` (purgeable — correct semantics for re-downloadable
//  content; a purged blob is a cache miss that re-fetches, never a fatal error). `pin(path)`
//  promotes a folder to `Application Support` (never purged, excluded from backup). Eviction is
//  GENERATION-granular (keep current + previous per folder, drop LRU folders over budget —
//  EngineConfig `content.budget_mb`), then unreferenced blobs are GC'd; deleting individual live
//  blobs would silently corrupt a generation, so nothing ever does.
//
//  WHY KERNEL, NOT A MODULE: `folder()` must answer synchronously pre-bootstrap (boot gates and
//  render paths read it), and content resolution must survive every exclusion set — an excludable
//  store would let exclusion brick offline boot (Article 7). Same standing as `AppManifest` /
//  `RemoteBundleGate`: a primitive with no exclusion switch. Policy stays in modules: serving
//  `/dsx/*` to the web, prefetch scheduling, sync progress UX. Zero WebKit, zero UIKit here.
//

import Foundation

// MARK: - Errors

/// Content resolution failures. TOTAL surface: `prepare` throws only these; `folder()` never throws.
public enum ContentError: Error {
    case noManifest           // no usable manifest from any source (network / seed / cache)
    case refused              // signing ON and the network manifest failed verification, with nothing local to serve
    case integrity(String)    // a file's bytes failed its declared SHA-256 (never overwrites a good copy)
    case missing(String)      // a listed file could not be obtained from any source in the chain
}

// MARK: - Manifest

/// A parsed, TOLERANT content manifest. One parser absorbs every shape already deployed:
/// canonical `files:[{path, sha256, bytes}]`, Godot's `bundles:[{path, sha256, size}]`, and the
/// offline web bundle's `assets:[String]` / `assets:[{path, sha256}]`. Unknown top-level keys ride
/// in `raw` (Godot reads its `scene`/`ar` there); `meta` is the canonical consumer-passthrough.
public struct ContentManifest {
    /// A manifest is control data, not an unbounded job queue. The transport also caps its
    /// bytes, but a very compact array can otherwise manufacture tens of thousands of file
    /// acquisitions from a few megabytes of JSON.
    public static let maximumEntries = 4_096
    public static let maximumPathUTF8Bytes = 1_024

    public struct Entry {
        public let path: String        // folder-relative file path
        public let sha256: String?     // lowercase hex; nil = no change detector (network-first when online)
        public let bytes: Int?         // optional declared size (progress/UX only, never trusted)
    }

    public let version: Int?           // optional, monotonic per folder (enforced only when signed)
    public let deployedAt: String?
    public let files: [Entry]
    public let meta: [String: Any]     // the canonical opaque passthrough (`meta` key)
    public let raw: [String: Any]      // the whole accepted object — legacy consumers read their own fields

    /// The ACCEPTANCE RULE (the SPA-poison guard, kernel law): a manifest is usable iff it is a
    /// JSON OBJECT carrying a file list (`files` / `bundles` / `assets` as an array). Anything
    /// else — an SPA's index.html, a captive portal, an error page — is nil, so callers fall back
    /// instead of trusting garbage. Total: never throws.
    public static func parse(text: String?) -> ContentManifest? {
        guard let text, let data = text.data(using: .utf8),
              data.count <= DSXContentTransportPolicy.maximumControlBytes,
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return parse(raw: raw)
    }

    public static func parse(raw: [String: Any]) -> ContentManifest? {
        guard let list = (raw["files"] ?? raw["bundles"] ?? raw["assets"]) as? [Any],
              list.count <= maximumEntries else { return nil }
        let version: Int?
        if let rawVersion = raw["version"] {
            guard let parsed = DSXContentInputPolicy.strictNonnegativeInteger(rawVersion) else { return nil }
            version = parsed
        } else {
            version = nil
        }
        var files: [Entry] = []
        var acceptedPaths = Set<String>()
        for item in list {
            if let path = item as? String {                                  // assets:[String] (hash-less)
                let normalized = DSXContentInputPolicy.normalizeRelativePath(
                    path, maximumUTF8Bytes: maximumPathUTF8Bytes
                )
                guard !normalized.isEmpty, acceptedPaths.insert(normalized).inserted else { return nil }
                files.append(Entry(path: normalized, sha256: nil, bytes: nil))
                continue
            }
            guard let dict = item as? [String: Any],
                  let path = dict["path"] as? String else { return nil }
            let normalized = DSXContentInputPolicy.normalizeRelativePath(
                path, maximumUTF8Bytes: maximumPathUTF8Bytes
            )
            guard !normalized.isEmpty, acceptedPaths.insert(normalized).inserted else { return nil }

            let sha: String?
            if let rawSHA = dict["sha256"] {
                guard let value = rawSHA as? String,
                      value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
                if value.isEmpty {
                    sha = nil
                } else {
                    guard DSXContentInputPolicy.validSHA256(value) else { return nil }
                    sha = value
                }
            } else {
                sha = nil
            }

            let sizeValue = dict["bytes"] ?? dict["size"]
            let bytes: Int?
            if let sizeValue {
                guard let parsed = DSXContentInputPolicy.strictNonnegativeInteger(sizeValue) else { return nil }
                bytes = parsed
            } else {
                bytes = nil
            }
            files.append(Entry(path: normalized, sha256: sha, bytes: bytes))
        }
        return ContentManifest(
            version: version,
            deployedAt: raw["deployed_at"] as? String,
            files: files,
            meta: (raw["meta"] as? [String: Any]) ?? [:],
            raw: raw
        )
    }
}

// MARK: - Seed

/// A BUNDLED source for a folder — content that ships INSIDE the app (a module's demo pack, an
/// offline floor) and seeds the store's generation zero with no network. Zero-copy: seed files are
/// referenced in place (`Bundle.main`), never duplicated into the CAS. A hosted manifest that
/// PARSES always wins over a seed on the next open — the seed keys on "no USABLE manifest", never
/// on "no response".
///
/// PHASE-1 BRIDGE: consumers construct this by hand from their own bundle lookups (Godot's demo).
/// The `content` dsx.json capability (a declared module content folder + a generated seeds index)
/// replaces hand-built seeds; this type then becomes the internal carrier only.
public struct ContentSeed {
    public let manifestText: () -> String?      // the bundled manifest's JSON text (nil = no seed manifest)
    public let fileURL: (String) -> URL?        // bundled bytes for a listed path (nil = not shipped)
    public init(manifestText: @escaping () -> String?, fileURL: @escaping (String) -> URL?) {
        self.manifestText = manifestText
        self.fileURL = fileURL
    }
}

// MARK: - Folder handle

/// An IMMUTABLE handle on ONE generation of one content folder. A screen visit captures it once
/// and reads from it for its whole lifetime — the store never mutates a published generation, so
/// old and new files can never mix mid-visit. Everything here is pure disk reads (no actor, no
/// locks): instant loads stay lock-free by construction.
public struct ContentFolder {
    public let root: String                   // resolved absolute root URL (the folder's identity)
    public let generation: String             // hash of the path→sha map — "same files" IS "same generation"
    public let manifest: ContentManifest      // the accepted manifest (incl. raw passthrough)

    let source: String                        // where the manifest came from: network / claim / seed
    let folderDir: URL                        // folders/<key>/ in whichever tier holds this folder
    let blobmap: [String: BlobRef]            // normalized relPath → verified blob (+ optional seed fallback)

    /// A `file://` URL for a listed file — the verified CAS blob, else the bundled seed copy.
    /// nil when the file isn't in this generation or its bytes are gone from every local source
    /// (an OS purge with no seed — `prepare` heals that on the next call).
    public func url(_ relPath: String) -> URL? {
        guard let ref = blobmap[ContentDisk.normalizeRel(relPath)] else { return nil }
        if let blob = ContentDisk.blobURL(ref.sha) { return blob }
        if let seed = ref.seed { return ContentDisk.seedURL(seed) }
        return nil
    }

    public func data(_ relPath: String) -> Data? {
        url(relPath).flatMap {
            ContentDisk.boundedData(at: $0, maximumBytes: DSXContentMemoryPolicy.maximumSingleDataBytes)
        }
    }

    /// BATCH read many files of THIS (already-resolved) generation — one map back, no caller
    /// loop. The bytes are already local + verified, so each read is MEMORY-MAPPED (safe here:
    /// CAS blobs and bundle seeds are immutable and only ever unlinked, never truncated). A
    /// missing rel, an item above 32 MiB, or an item that would take the result above 64 MiB is
    /// simply absent; at most 64 requested paths are considered. Use `url(_:)` or `materialize()`
    /// for large assets so their bytes never need to be retained in process memory. The returned MAP is
    /// the cross-platform contract — the Kotlin twin may keep its
    /// `coroutineScope { rels.map { async { data(it) } } }` fan-out; scheduling is a detail.
    public func data(_ relPaths: [String]) async -> [String: Data] {
        var out: [String: Data] = [:]
        var totalBytes = 0
        var seen = Set<String>()
        for rel in relPaths.prefix(DSXContentMemoryPolicy.maximumBatchItems) {
            guard seen.insert(rel).inserted else { continue }
            let remaining = DSXContentMemoryPolicy.maximumAggregateDataBytes - totalBytes
            guard remaining >= 0, let u = url(rel),
                  let d = ContentDisk.boundedData(
                    at: u,
                    maximumBytes: min(DSXContentMemoryPolicy.maximumSingleDataBytes, remaining)
                  ),
                  DSXContentMemoryPolicy.permitsAppend(currentBytes: totalBytes, newBytes: d.count) else {
                continue
            }
            out[rel] = d
            totalBytes += d.count
        }
        return out
    }

    public func text(_ relPath: String) -> String? {
        data(relPath).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// A REAL directory tree of this generation, for consumers that need one on disk (Godot mounts
    /// a `.pck` beside its folder). Built once per generation under `trees/<generation>/` from APFS
    /// clones (`FileManager.copyItem` clones on APFS — metadata-only, no byte copy), then reused;
    /// built in staging and published by a single atomic move, so a half-built tree is never
    /// visible and concurrent callers converge on the same result. Throws `.missing` if a file's
    /// bytes are gone from every local source (purge with no seed).
    public func materialize() throws -> URL {
        try ContentDisk.materialize(folderDir: folderDir, generation: generation, blobmap: blobmap)
    }

    /// PROVENANCE of this generation's manifest — `"seed"` (the bundled sample) · `"network"`
    /// (fetched from the host) · `"claim"` (an offline-sync bundle). The per-consumer face of
    /// the `dsx.source.content` plane: branch your own UX on shipped-sample vs synced content
    /// without hand-tracking generations (ContentServer's lastKnownGeneration pattern).
    public var servedFrom: String { source }
}

/// One verified file of a generation: the content hash that names its CAS blob, plus an optional
/// bundled-seed fallback (`Bundle.main` resource basename) so seed generations are zero-copy and
/// purge-proof. Internal — consumers only ever see `ContentFolder`.
struct BlobRef {
    let sha: String
    let seed: String?
}

// MARK: - The primitive

/// The kernel content primitive — `dsx.content`. Mechanism only (store + resolution + freshness);
/// serving and scheduling policy live in modules. See the header above for the model.
public enum DSXContent {

    /// SYNCHRONOUS, render-path-safe: the last-known-good generation for a content path, straight
    /// off disk (`current` pointer → manifest + blobmap). Never touches the network; nil until the
    /// folder has ever been prepared or seeded. `manifestName` must match what the folder was
    /// prepared with (it is part of the folder's identity).
    public static func folder(_ path: String, origin: String = "",
                              manifestName: String = "manifest.json") -> ContentFolder? {
        let root = absolute(path, origin: origin)
        let key = ContentDisk.folderKey(root: root, manifestName: manifestName)
        let folder = ContentDisk.loadCurrent(key: key, root: root)
        if folder != nil { ContentDisk.touch(key) }     // LRU clock (fire-and-forget, off the render path)
        return folder
    }

    /// Resolve + freshen (see the header: warm = instant + background revalidate, new generation
    /// on NEXT open; cold = foreground behind the caller's skeleton). `seed` supplies a bundled
    /// fallback source (Phase-1 bridge — see `ContentSeed`). `onProgress` reports 0…1 across the
    /// files of a foreground resolve (background revalidation never reports).
    /// `pinned: true` steers the FIRST publish straight into the never-purged tier (Application
    /// Support) — for content that must survive an OS Caches purge, e.g. the offline web bundle
    /// (an unpinned bundle in purgeable Caches can be evicted and then brick an offline launch).
    public static func prepare(_ path: String, origin: String = "",
                               manifestName: String = "manifest.json",
                               seed: ContentSeed? = nil, pinned: Bool = false,
                               onProgress: ((Double) -> Void)? = nil) async throws -> ContentFolder {
        try await ContentStore.shared.prepare(path: path, origin: origin, manifestName: manifestName,
                                              seed: seed, pinned: pinned, onProgress: onProgress)
    }

    /// The single-URL plane (the text/asset-cache successor): last-known-good bytes for a URL,
    /// synchronously from the same store. nil until `file(_:)` has ever succeeded for it.
    public static func cachedFile(_ url: String) -> Data? {
        ContentDisk.cachedFile(url)
    }

    /// FOREGROUND revalidation — the awaited twin of the background stale-while-revalidate pass,
    /// for callers that must apply an update BEFORE proceeding (the offline-app boot gate: a
    /// deploy applies at launch, not one launch late). Fetches the manifest, acquires changed
    /// files (progress-reported), publishes atomically, and returns the folder that is CURRENT
    /// after the attempt — the fresh generation when one landed, the last-known-good when the
    /// network/signing refused, nil only when the folder has never resolved at all. Total.
    @discardableResult
    public static func refresh(_ path: String, origin: String = "",
                               manifestName: String = "manifest.json",
                               onProgress: ((Double) -> Void)? = nil) async -> ContentFolder? {
        await ContentStore.shared.refresh(path: path, origin: origin, manifestName: manifestName,
                                          onProgress: onProgress)
    }

    /// Network-only fetch of a single URL through the store (single-flight, ingested into the
    /// CAS, remembered for `cachedFile`). nil on ANY failure — and the previously cached copy is
    /// left untouched, so callers keep what they had (the fetchText contract).
    @discardableResult
    public static func freshFile(_ url: String) async -> Data? {
        await ContentStore.shared.freshFile(url)
    }

    /// Fetch with cached fallback — `freshFile` else `cachedFile`. Total, never throws. Compose
    /// the primitives for stale-while-revalidate: serve `cachedFile`, `Task { await freshFile(url) }`.
    public static func file(_ url: String) async -> Data? {
        if let fresh = await freshFile(url) { return fresh }
        return cachedFile(url)
    }

    /// BATCH the single-URL plane: fetch many URLs CONCURRENTLY and get one map back — the caller
    /// never writes a loop, never manages threads. Fan-out is BOUNDED (a sliding window of 6, the
    /// same cap as a folder's own acquires) and de-duplicated (a URL already in flight shares one
    /// transfer via the store's single-flight). Missing/failed URLs are simply absent from the
    /// result. Cross-platform: the Kotlin twin is
    /// `coroutineScope { urls.map { async { file(it) } }.awaitAll() }` over a limited dispatcher.
    public static func files(_ urls: [String]) async -> [String: Data] {
        var seen = Set<String>()
        let selected = urls.prefix(DSXContentMemoryPolicy.maximumBatchItems).filter {
            seen.insert($0).inserted
        }
        return await withTaskGroup(of: (String, Data?).self) { group in
            var out: [String: Data] = [:]
            var totalBytes = 0
            var next = 0
            func schedule() {
                guard next < selected.count else { return }
                let url = selected[next]; next += 1
                group.addTask { (url, await file(url)) }
            }
            for _ in 0..<min(6, selected.count) { schedule() }
            while let (url, data) = await group.next() {
                if let data,
                   DSXContentMemoryPolicy.permitsAppend(currentBytes: totalBytes, newBytes: data.count) {
                    out[url] = data
                    totalBytes += data.count
                }
                schedule()
            }
            return out
        }
    }

    /// BATCH folder resolution: `prepare` many folders CONCURRENTLY. One await, a map of the
    /// folders that resolved (a folder that throws is absent — the batch never fails as a whole).
    /// Use to warm a screen's whole content set at once instead of serial `prepare`s. Bounded to
    /// 3 folders in flight — each `prepare` already fans out its own window of 6 file acquires.
    public static func prepareAll(_ paths: [String], origin: String = "",
                                  manifestName: String = "manifest.json") async -> [String: ContentFolder] {
        await withTaskGroup(of: (String, ContentFolder?).self) { group in
            var out: [String: ContentFolder] = [:]
            var next = 0
            func schedule() {
                guard next < paths.count else { return }
                let path = paths[next]; next += 1
                group.addTask { (path, try? await prepare(path, origin: origin, manifestName: manifestName)) }
            }
            for _ in 0..<min(3, paths.count) { schedule() }
            while let (path, folder) = await group.next() {
                if let folder { out[path] = folder }
                schedule()
            }
            return out
        }
    }

    /// Pin a folder into the never-purged tier (Application Support, excluded from backup) — for
    /// offline-critical content. Unpinning returns it to the purgeable cache tier.
    public static func pin(_ path: String, origin: String = "",
                           manifestName: String = "manifest.json", _ pinned: Bool = true) {
        Task { await ContentStore.shared.pin(path: path, origin: origin, manifestName: manifestName, pinned: pinned) }
    }

    /// The AWAITABLE twin of `pin` — for callers that must ORDER the tier move against their next
    /// store operation (the boot gate promotes a migrated bundle BEFORE refreshing it, so the
    /// refresh publishes into — and hands out handles from — the folder's final home; the
    /// fire-and-forget `pin` racing that refresh could leave a stale-tier handle being served).
    public static func pinNow(_ path: String, origin: String = "",
                              manifestName: String = "manifest.json", _ pinned: Bool = true) async {
        await ContentStore.shared.pin(path: path, origin: origin, manifestName: manifestName, pinned: pinned)
    }

    /// Drop every generation of a folder (both tiers) and GC newly-unreferenced blobs.
    public static func evict(_ path: String, origin: String = "", manifestName: String = "manifest.json") {
        Task { await ContentStore.shared.evict(path: path, origin: origin, manifestName: manifestName) }
    }

    /// Store diagnostics (sizes, counts, budget) — for a storage-management surface.
    public static func stats() -> [String: Any] {
        ContentDisk.stats()
    }

    // MARK: - The one host authority

    /// Resolve a content path to its absolute HTTPS root URL (always "/"-terminated).
    ///   • absolute `http(s)` path → unchanged (the author named the exact location);
    ///   • explicit `origin`       → `<origin><path>/` — an explicit origin is an explicit
    ///     location, so the content root does NOT apply (the `<DSXView origin=…>` vocabulary);
    ///   • default                 → `https://<AppManifest.resolvedHost()><content_root><path>/`
    ///     — the app's own host under the `/dsx` content root (App.json `hosting.content_root`).
    /// With no host configured anywhere the result has no authority and every fetch fails cleanly
    /// into the offline chain (seed / cache) — same degrade as always.
    public static func absolute(_ path: String, origin: String = "") -> String {
        var p = path.trimmingCharacters(in: .whitespaces)
        if p.isEmpty { p = "/" }
        if p.hasPrefix("http://") || p.hasPrefix("https://") { return p.hasSuffix("/") ? p : p + "/" }
        let rel = p.hasPrefix("/") ? p : "/" + p
        let o = origin.trimmingCharacters(in: .whitespaces)
        let joined: String
        if o.isEmpty {
            // resolvedOriginString ≡ resolvedHost normally; when the dev-origin override is
            // active it carries scheme+port so content follows the SAME origin the web loads.
            joined = normalizedOrigin(AppManifest.resolvedOriginString() ?? "") + AppManifest.contentRoot + rel
        } else {
            joined = normalizedOrigin(o) + rel
        }
        return joined.hasSuffix("/") ? joined : joined + "/"
    }

    private static func normalizedOrigin(_ origin: String) -> String {
        var h = origin.trimmingCharacters(in: .whitespaces)
        if !h.isEmpty, !h.hasPrefix("http://"), !h.hasPrefix("https://") { h = "https://" + h }
        if h.isEmpty { h = "https://" }          // no host anywhere → an authority-less URL that fails cleanly
        while h.hasSuffix("/") { h.removeLast() }
        return h
    }
}
