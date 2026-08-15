//
//  ContentStore.swift — the content-addressed store behind `dsx.content` (see Content.swift for
//  the model; this file is the disk format + the one mutation actor).
//
//  LAYOUT (two tiers, same shape):
//
//    Library/Caches/dsx-content/                ← default tier (OS-purgeable = cache semantics)
//      blobs/sha256/<64-hex>                    ← verified bytes, immutable, deduped (name IS the hash)
//      folders/<folder-key>/                    ← folder-key = sha256(rootURL + "\n" + manifestName)
//         current                               ← the live generation id (atomic replace)
//         previous                              ← kept for rollback safety (keep-two rule)
//         gens/<generation>.json                ← the manifest bytes exactly as accepted
//         gens/<generation>.blobmap             ← { source, files: { relPath: {sha, seed?} } }
//         trees/<generation>/                   ← materialized directory view (APFS clones), on demand
//         touched                               ← mtime = the LRU clock
//         version                               ← per-folder anti-rollback high-water (signed manifests)
//      files/<sha256(url)>                      ← single-URL plane: pointer file → blob sha
//      tmp/                                     ← staging; swept on first touch each process
//
//    Library/Application Support/dsx-content/   ← pinned tier: same layout, never purged,
//                                                 isExcludedFromBackup re-applied on every write
//
//  INVARIANTS the layout enforces:
//    • A blob is COMPLETE-OR-ABSENT: downloads stage elsewhere, hash-verify, then rename in —
//      a name-matches-content file can never be half-written (rename is atomic on APFS), and a
//      concurrent identical ingest is an idempotent win (EEXIST = someone else already verified
//      the same bytes).
//    • A generation is IMMUTABLE once its two `gens/` files exist; `current` flips AFTER they are
//      durable, so a crash leaves the old generation fully live or the new one fully published —
//      never a torn state.
//    • READERS never lock: resolving a published generation is pure immutable reads (Content.swift
//      does it without touching this actor). Only mutation serializes here.
//    • Eviction is GENERATION-granular (a folder's non-current/previous generations first, then
//      whole LRU folders over budget), THEN unreferenced blobs are GC'd — with a one-hour mtime
//      grace so a just-ingested blob whose generation hasn't published yet is never collected.
//

import Foundation
import CryptoKit

// MARK: - Disk format (pure, lock-free — shared by the sync read path and the actor)

enum ContentDisk {
    static let maximumGenerationMetadataBytes = 8 * 1_024 * 1_024

    // MARK: tiers

    static let cacheRoot: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let d = base.appendingPathComponent("dsx-content", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    static let pinnedRoot: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let d = base.appendingPathComponent("dsx-content", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        applyBackupExclusion(to: d)
        return d
    }()

    /// Staging space. Swept once per process on first touch (orphans of a crashed run), so a
    /// crash mid-download can never leak unbounded temp files.
    static let tmpDir: URL = {
        let d = cacheRoot.appendingPathComponent("tmp", isDirectory: true)
        try? FileManager.default.removeItem(at: d)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    /// Re-downloadable content must never ride an iCloud backup (App Review guideline), and the
    /// flag is not durable across file operations — so it is re-applied after every pinned write.
    static func applyBackupExclusion(to url: URL? = nil) {
        var u = url ?? pinnedRoot
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        try? u.setResourceValues(rv)
    }

    // MARK: keys + paths

    static func folderKey(root: String, manifestName: String) -> String {
        RemoteBundleGate.hexSHA256(Data((root + "\n" + manifestName).utf8))
    }

    static func folderDir(_ key: String, tier: URL) -> URL {
        tier.appendingPathComponent("folders", isDirectory: true).appendingPathComponent(key, isDirectory: true)
    }

    /// The tier that HOLDS this folder (pinned wins), or nil when the folder has never published.
    static func existingFolderDir(_ key: String) -> URL? {
        let p = folderDir(key, tier: pinnedRoot)
        if FileManager.default.fileExists(atPath: p.path) { return p }
        let c = folderDir(key, tier: cacheRoot)
        if FileManager.default.fileExists(atPath: c.path) { return c }
        return nil
    }

    static func ensureFolderDir(_ key: String, preferPinned: Bool = false) throws -> URL {
        if let d = existingFolderDir(key) { return d }
        let d = folderDir(key, tier: preferPinned ? pinnedRoot : cacheRoot)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        if preferPinned { applyBackupExclusion() }
        return d
    }

    static func blobPath(_ tier: URL, _ sha: String) -> URL {
        tier.appendingPathComponent("blobs/sha256", isDirectory: true).appendingPathComponent(sha)
    }

    /// A verified blob's URL from EITHER tier (pinned first), or nil — a purged blob is a cache
    /// miss by design, never an error at this layer.
    static func blobURL(_ sha: String) -> URL? {
        guard DSXContentInputPolicy.validSHA256(sha) else { return nil }
        let p = blobPath(pinnedRoot, sha)
        if FileManager.default.fileExists(atPath: p.path) { return p }
        let c = blobPath(cacheRoot, sha)
        if FileManager.default.fileExists(atPath: c.path) { return c }
        return nil
    }

    static func hasBlob(_ sha: String) -> Bool { blobURL(sha) != nil }

    /// A bundled seed file, matched by its resource basename (`Bundle.main` flattens resource
    /// folders). Zero-copy: seed generations reference the app bundle in place.
    static func seedURL(_ name: String) -> URL? {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        return Bundle.main.url(forResource: base, withExtension: ext.isEmpty ? nil : ext)
    }

    // MARK: declared seeds (dsx.json `content` → Registry/DSXContentSeeds.json)

    /// The generated seeds index: mount → manifest-name → { module, pinned, manifest (inlined
    /// text) }. Built by prepare_modules from every enabled package's `content` declarations;
    /// absent (older build / no declarations) ⇒ empty, fail-open.
    static let seedIndex: [String: Any] = {
        guard let url = Bundle.main.url(forResource: "DSXContentSeeds", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return obj
    }()

    /// The app's OWN origin, for the seed guard (bundled-floor.md): the boot folders (the
    /// offline web bundle) resolve with the app's host as an EXPLICIT origin, and their seeds
    /// must still be found. A seam, not a lookup — the module that owns the boot resolve
    /// (ContentServer) installs the EXACT origin string it resolves with (incl. its legacy
    /// config fallback the kernel can't see); the default covers App.json-hosted apps.
    static var ownOrigin: () -> String? = { AppManifest.resolvedOriginString() }

    /// Is this origin the app's own plane? Empty = the content-root mounts (always own).
    /// Otherwise normalize both sides (scheme off, trailing slashes off, lowercased) and
    /// require equality with `ownOrigin` — a FOREIGN origin is an explicit location and is
    /// never seedable (a bundled seed must not shadow another host's content).
    static func isOwnPlane(_ origin: String) -> Bool {
        let o = origin.trimmingCharacters(in: .whitespaces)
        if o.isEmpty { return true }
        guard let own = ownOrigin(), !own.isEmpty else { return false }
        func norm(_ s: String) -> String {
            var v = s.lowercased()
            for p in ["https://", "http://"] where v.hasPrefix(p) { v.removeFirst(p.count) }
            while v.hasSuffix("/") { v.removeLast() }
            return v
        }
        return norm(o) == norm(own)
    }

    /// The declared bundled seed for a content path, if a package ships one. Only for the app's
    /// OWN plane — a content-root mount (no origin) or a boot folder on the app's own host
    /// (`isOwnPlane`) — and only for the exact manifest name the consumer resolves with
    /// (mount + manifest name is the seed's identity). Files resolve by flat bundle-resource
    /// basename — the same mechanism the folder ships by.
    static func declaredSeed(path: String, origin: String, manifestName: String) -> (seed: ContentSeed, pinned: Bool)? {
        guard isOwnPlane(origin) else { return nil }
        var mount = path.trimmingCharacters(in: .whitespaces)
        if !mount.hasPrefix("/") { mount = "/" + mount }
        while mount.count > 1, mount.hasSuffix("/") { mount.removeLast() }
        guard let byManifest = seedIndex[mount] as? [String: Any],
              let entry = byManifest[manifestName] as? [String: Any],
              let text = entry["manifest"] as? String, !text.isEmpty else { return nil }
        let seed = ContentSeed(
            manifestText: { text },
            fileURL: { p in seedURL((p as NSString).lastPathComponent) }
        )
        return (seed, (entry["pinned"] as? Bool) ?? false)
    }

    /// The reserved in-tree completion marker (`materialize`). A manifest file with this name is
    /// rejected by `normalizeRel` so it can never clobber the marker (or be clobbered by it).
    static let treeMarkerName = ".dsx-complete"

    /// Normalize a manifest-listed path into a safe folder-relative key. A hostile manifest must
    /// not escape the folder (`materialize` writes these paths), so a `..`/`.` component, an
    /// absolute URL (a rel file path is never one — this also stops `split` collapsing `scheme://`
    /// into a bogus nested path), or the reserved tree marker reject the entry outright ("" =
    /// skipped by every caller).
    static func normalizeRel(_ path: String) -> String {
        DSXContentInputPolicy.normalizeRelativePath(
            path, maximumUTF8Bytes: ContentManifest.maximumPathUTF8Bytes,
            reservedComponent: treeMarkerName)
    }

    // MARK: hashing (CryptoKit — hardware-accelerated; a 30 MB pack hashes in tens of ms)

    static func hashData(_ data: Data) -> String { RemoteBundleGate.hexSHA256(data) }

    /// Streaming SHA-256 of a file (1 MiB chunks) — packs never load whole into memory here.
    static func hashFile(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: blob ingest (complete-or-absent)

    /// Move verified bytes into the CAS. The name is the hash the CALLER just computed/checked, so
    /// an existing destination means the same bytes are already verified — EEXIST (or a race to
    /// it) is an idempotent win, never an error.
    static func ingest(tmp: URL, sha: String) throws {
        let dest = blobPath(cacheRoot, sha)
        try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: dest.path) { try? FileManager.default.removeItem(at: tmp); return }
        do { try FileManager.default.moveItem(at: tmp, to: dest) }
        catch {
            if FileManager.default.fileExists(atPath: dest.path) { try? FileManager.default.removeItem(at: tmp); return }
            throw error
        }
    }

    static func ingest(data: Data, sha: String) throws {
        let staging = tmpDir.appendingPathComponent(UUID().uuidString)
        try data.write(to: staging)
        try ingest(tmp: staging, sha: sha)
    }

    /// Copy a claimed local file into the CAS without ever retaining the blob in one `Data`.
    /// Hashing and the actual byte ceiling happen in the same streaming pass; only the verified
    /// staging file is atomically published. This also means an ingest failure can never return a
    /// BlobRef that names absent bytes.
    static func ingestLocalFile(_ source: URL, maximumBytes: Int64, expectedSHA: String?) throws -> String {
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        let staging = tmpDir.appendingPathComponent("claim-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: staging) }
        guard let sha = DSXBoundedLocalFile.copyAndSHA256(
            from: source, to: staging, maximumBytes: maximumBytes
        ) else { throw ContentError.missing(source.path) }
        if let expectedSHA, sha != expectedSHA { throw ContentError.integrity(source.path) }
        try ingest(tmp: staging, sha: sha)
        return sha
    }

    // MARK: generations

    /// The generation id IS the hash of the path→sha map: "same files" = "same generation",
    /// independent of manifest formatting; one changed file = a new generation.
    static func generationID(_ map: [String: BlobRef]) -> String {
        let canon = map.keys.sorted().map { "\($0)\n\(map[$0]?.sha ?? "")" }.joined(separator: "\n")
        return RemoteBundleGate.hexSHA256(Data(canon.utf8))
    }

    static func blobmapData(_ map: [String: BlobRef], source: String) throws -> Data {
        var files: [String: [String: String]] = [:]
        for (rel, ref) in map {
            var entry = ["sha": ref.sha]
            if let seed = ref.seed { entry["seed"] = seed }
            files[rel] = entry
        }
        return try JSONSerialization.data(withJSONObject: ["source": source, "files": files], options: [.sortedKeys])
    }

    static func parseBlobmap(_ data: Data) -> (files: [String: BlobRef], source: String)? {
        guard data.count <= maximumGenerationMetadataBytes else { return nil }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let files = obj["files"] as? [String: [String: Any]],
              files.count <= ContentManifest.maximumEntries else { return nil }
        var out: [String: BlobRef] = [:]
        var identities = Set<String>()
        for (rel, entry) in files {
            let normalized = normalizeRel(rel)
            guard normalized == rel,
                  identities.insert(rel.precomposedStringWithCanonicalMapping.lowercased()).inserted,
                  let sha = entry["sha"] as? String,
                  DSXContentInputPolicy.validSHA256(sha) else { return nil }
            out[rel] = BlobRef(sha: sha, seed: entry["seed"] as? String)
        }
        return (out, (obj["source"] as? String) ?? "network")
    }

    static func readPointer(_ dir: URL, _ name: String) -> String? {
        guard let d = boundedData(at: dir.appendingPathComponent(name), maximumBytes: 128),
              let s = String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty else { return nil }
        return s
    }

    static func readGenerationPointer(_ dir: URL, _ name: String) -> String? {
        guard let value = readPointer(dir, name), DSXContentInputPolicy.validSHA256(value) else { return nil }
        return value
    }

    /// A tiny memo of the parsed current generation per folder key, so the SYNC render path
    /// (`folder()` / an `asset.url` claim per asset) skips re-reading + re-parsing two JSON files
    /// on every call. The cheap `current` pointer read STILL runs, so a publish (which flips the
    /// pointer) or an evict (which clears the entry) is picked up immediately — the memo only
    /// elides the parse when the pointer is unchanged. Locked for the nonisolated readers.
    /// SELF-VERIFYING on the folder dir: a tier move (`pin`) relocates the dir WITHOUT changing
    /// the pointer, so the hit is gated on `dir.path` too — a reader that raced the move and would
    /// otherwise re-insert a handle pointing at the deleted old-tier dir can never be served (the
    /// stale entry mismatches the freshly-resolved dir and is reloaded). Root is part of the key
    /// (`folderKey` = sha256(root + manifestName)), so it needs no separate compare.
    private static let genCacheLock = NSLock()
    private static var genCache: [String: (pointer: String, dir: String, folder: ContentFolder)] = [:]

    /// The last-known-good generation, straight off disk — the sync read path (`dsx.content.folder`).
    static func loadCurrent(key: String, root: String) -> ContentFolder? {
        guard let dir = existingFolderDir(key), let gen = readGenerationPointer(dir, "current") else { return nil }
        genCacheLock.lock()
        if let hit = genCache[key], hit.pointer == gen, hit.dir == dir.path {
            genCacheLock.unlock(); return hit.folder
        }
        genCacheLock.unlock()
        guard let folder = loadGeneration(dir: dir, generation: gen, root: root) else { return nil }
        genCacheLock.lock(); genCache[key] = (gen, dir.path, folder); genCacheLock.unlock()
        return folder
    }

    /// The exact manifest BYTES of a generation (as text) — for the SWR short-circuit: an
    /// unchanged manifest means no re-acquire. nil if the generation's artifact is gone.
    static func manifestText(dir: URL, generation: String) -> String? {
        let f = dir.appendingPathComponent("gens", isDirectory: true).appendingPathComponent(generation + ".json")
        return boundedData(at: f, maximumBytes: DSXContentTransportPolicy.maximumControlBytes)
            .flatMap { String(data: $0, encoding: .utf8) }
    }

    /// Drop a folder's memoized generation — after any operation that moves or removes its dir
    /// (a tier change via `pin`, an evict/remove), so `loadCurrent` re-reads from the new location.
    static func invalidateGenCache(_ key: String) {
        genCacheLock.lock(); genCache.removeValue(forKey: key); genCacheLock.unlock()
    }

    static func loadGeneration(dir: URL, generation: String, root: String) -> ContentFolder? {
        let gens = dir.appendingPathComponent("gens", isDirectory: true)
        guard let mData = boundedData(at: gens.appendingPathComponent(generation + ".json"),
                                      maximumBytes: DSXContentTransportPolicy.maximumControlBytes),
              let mText = String(data: mData, encoding: .utf8),
              let manifest = ContentManifest.parse(text: mText),
              let bData = boundedData(at: gens.appendingPathComponent(generation + ".blobmap"),
                                      maximumBytes: maximumGenerationMetadataBytes),
              let parsed = parseBlobmap(bData) else { return nil }
        return ContentFolder(root: root, generation: generation, manifest: manifest,
                             source: parsed.source, folderDir: dir, blobmap: parsed.files)
    }

    /// Files of a generation whose bytes are gone from EVERY local source (an OS purge) — the
    /// holes `prepare` heals in the foreground before handing the generation out.
    static func unresolvedFiles(_ folder: ContentFolder) -> [String] {
        folder.blobmap.compactMap { rel, ref in
            if blobURL(ref.sha) != nil { return nil }
            if let seed = ref.seed, seedURL(seed) != nil { return nil }
            return rel
        }
    }

    /// Drop every generation artifact except current + previous (Expo's keep-two rule: instant
    /// rollback safety without unbounded growth). Trees are re-clonable, so stale ones go too.
    /// Returns true when it removed a `gens/` artifact — the signal `publish` uses to GC the blobs
    /// that generation orphaned (so a pinned-only app, whose cache budget never trips eviction,
    /// still collects dead blobs on every deploy instead of growing Application Support forever).
    @discardableResult
    static func pruneGenerations(_ dir: URL) -> Bool {
        var keep = Set<String>()
        if let c = readGenerationPointer(dir, "current") { keep.insert(c) }
        if let p = readGenerationPointer(dir, "previous") { keep.insert(p) }
        var removedGen = false
        let gens = dir.appendingPathComponent("gens", isDirectory: true)
        for f in (try? FileManager.default.contentsOfDirectory(at: gens, includingPropertiesForKeys: nil)) ?? []
        where !keep.contains(f.deletingPathExtension().lastPathComponent) {
            try? FileManager.default.removeItem(at: f)
            removedGen = true
        }
        let trees = dir.appendingPathComponent("trees", isDirectory: true)
        for t in (try? FileManager.default.contentsOfDirectory(at: trees, includingPropertiesForKeys: nil)) ?? []
        where !keep.contains(t.lastPathComponent) {
            try? FileManager.default.removeItem(at: t)
        }
        return removedGen
    }

    /// Every blob sha referenced by a folder's live (current/previous) generations.
    static func referencedShas(inFolderDir dir: URL) -> Set<String> {
        var out = Set<String>()
        let gens = dir.appendingPathComponent("gens", isDirectory: true)
        for name in ["current", "previous"] {
            guard let gen = readGenerationPointer(dir, name),
                  let data = boundedData(at: gens.appendingPathComponent(gen + ".blobmap"),
                                         maximumBytes: maximumGenerationMetadataBytes),
                  let parsed = parseBlobmap(data) else { continue }
            out.formUnion(parsed.files.values.map(\.sha))
        }
        return out
    }

    /// Clone the given blobs INTO a tier if absent (APFS copy = metadata-only). Used to make a
    /// PINNED folder self-contained: `ingest` always writes blobs to the purgeable cache tier, so
    /// a pinned folder whose blobs live only in cache would still lose them to an OS purge. Seed
    /// files (no CAS blob — referenced zero-copy from the app bundle) are skipped automatically.
    static func cloneBlobs(_ shas: Set<String>, toTier tier: URL) {
        for sha in shas {
            let dst = blobPath(tier, sha)
            guard !FileManager.default.fileExists(atPath: dst.path), let src = blobURL(sha) else { continue }
            try? FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.copyItem(at: src, to: dst)
        }
    }

    /// Delete blobs no live generation (and no single-URL pointer) references — with a one-hour
    /// mtime grace so a blob ingested for a not-yet-published generation is never collected out
    /// from under its publish. TIER-AWARE: a blob referenced only by the OTHER tier's folders is
    /// kept in this tier ONLY while the other tier's own copy is missing (the clone-failed safety
    /// net) — so the purgeable cache-tier twins that `cloneBlobs` leaves behind when a folder is
    /// pinned are collectible instead of counting against the cache budget forever.
    static func gcBlobs() {
        func references(in tier: URL) -> Set<String> {
            var out = Set<String>()
            let folders = tier.appendingPathComponent("folders", isDirectory: true)
            for dir in (try? FileManager.default.contentsOfDirectory(at: folders, includingPropertiesForKeys: nil)) ?? [] {
                out.formUnion(referencedShas(inFolderDir: dir))
            }
            let files = tier.appendingPathComponent("files", isDirectory: true)
            for f in (try? FileManager.default.contentsOfDirectory(at: files, includingPropertiesForKeys: nil)) ?? [] {
                if let s = boundedData(at: f, maximumBytes: 128)
                    .flatMap({ String(data: $0, encoding: .utf8) })?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                   DSXContentInputPolicy.validSHA256(s) {
                    out.insert(s)
                }
            }
            return out
        }
        let pinnedRefs = references(in: pinnedRoot)
        let cacheRefs = references(in: cacheRoot)
        let cutoff = Date().addingTimeInterval(-3600)
        for (tier, own, other, otherTier) in [(pinnedRoot, pinnedRefs, cacheRefs, cacheRoot),
                                              (cacheRoot, cacheRefs, pinnedRefs, pinnedRoot)] {
            let blobs = tier.appendingPathComponent("blobs/sha256", isDirectory: true)
            for b in (try? FileManager.default.contentsOfDirectory(at: blobs, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
                let sha = b.lastPathComponent
                guard !own.contains(sha) else { continue }
                if other.contains(sha),
                   !FileManager.default.fileExists(atPath: blobPath(otherTier, sha).path) { continue }
                if let mtime = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
                   mtime > cutoff { continue }
                try? FileManager.default.removeItem(at: b)
            }
        }
    }

    static func removeFolder(key: String, tier: URL) {
        try? FileManager.default.removeItem(at: folderDir(key, tier: tier))
        invalidateGenCache(key)
    }

    // MARK: LRU clock + budget accounting

    /// Bump the folder's LRU clock. Fire-and-forget off the calling thread — the render path
    /// never waits on a disk write.
    static func touch(_ key: String) {
        DispatchQueue.global(qos: .utility).async {
            guard let dir = existingFolderDir(key) else { return }
            try? Data().write(to: dir.appendingPathComponent("touched"))
        }
    }

    /// Cache-tier folder keys, least-recently-touched first (the eviction order).
    static func lruFolderKeys() -> [String] {
        let base = cacheRoot.appendingPathComponent("folders", isDirectory: true)
        let kids = (try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? []
        func stamp(_ dir: URL) -> Date {
            (try? dir.appendingPathComponent("touched").resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
        }
        return kids.sorted { stamp($0) < stamp($1) }.map { $0.lastPathComponent }
    }

    static func directorySize(_ root: URL) -> Int {
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
        var total = 0
        for case let f as URL in e {
            guard let rv = try? f.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                  rv.isRegularFile == true else { continue }
            total += rv.fileSize ?? 0
        }
        return total
    }

    /// Total bytes of the given blobs in a tier — the reclaimable weight of a folder's blobs, so
    /// eviction can drop its running size estimate WITHOUT a full-tree rewalk or a per-iteration
    /// GC. Over-counts a blob shared by two folders (subtracted twice), which only makes eviction
    /// stop EARLIER — it never over-evicts, so a session-live folder stays protected.
    static func blobBytes(_ shas: Set<String>, tier: URL) -> Int {
        var total = 0
        for sha in shas {
            let p = blobPath(tier, sha)
            if let sz = (try? p.resourceValues(forKeys: [.fileSizeKey]))?.fileSize { total += sz }
        }
        return total
    }

    /// Every blob sha referenced by ANY folder's live generations in a tier.
    static func allFolderRefs(tier: URL) -> Set<String> {
        let foldersDir = tier.appendingPathComponent("folders", isDirectory: true)
        var refs = Set<String>()
        for dir in (try? FileManager.default.contentsOfDirectory(at: foldersDir, includingPropertiesForKeys: nil)) ?? [] {
            refs.formUnion(referencedShas(inFolderDir: dir))
        }
        return refs
    }

    /// The tier bytes folder eviction can actually RECLAIM: every folder dir plus the blobs their
    /// live generations reference. Deliberately excludes the floor no folder eviction can lower —
    /// orphan blobs inside gcBlobs' one-hour ingest grace (an aborted publish's leftovers, freed
    /// by a later GC) and staging. The single-URL plane is accounted SEPARATELY (filesPlaneBytes)
    /// and reclaimed by pointer eviction, not folder eviction. Budget enforcement targets these
    /// two numbers: chasing the raw tree size would strip every folder and still finish over budget
    /// whenever the overage is un-reclaimable-by-folder-eviction.
    static func folderAccountedBytes(tier: URL) -> Int {
        directorySize(tier.appendingPathComponent("folders", isDirectory: true))
            + blobBytes(allFolderRefs(tier: tier), tier: tier)
    }

    /// A single-URL-plane pointer and the blob it names — oldest-touched first (a read/write
    /// stamps the pointer's mtime), so pointer eviction reclaims the least-recently-used URLs.
    static func lruFilePointers(tier: URL) -> [(pointer: URL, sha: String)] {
        let dir = tier.appendingPathComponent("files", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        func stamp(_ u: URL) -> Date {
            (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        }
        return files.sorted { stamp($0) < stamp($1) }.compactMap { u in
            guard let sha = boundedData(at: u, maximumBytes: 128)
                .flatMap({ String(data: $0, encoding: .utf8) })?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  DSXContentInputPolicy.validSHA256(sha) else { return nil }
            return (u, sha)
        }
    }

    /// The bytes the single-URL plane can RECLAIM in a tier: each pointer's blob whose sha no
    /// FOLDER generation also references (a folder-shared blob is folder-accounted and survives
    /// pointer deletion). `folderRefs` is passed in so callers don't re-walk the folders tree.
    static func filesPlaneBytes(tier: URL, folderRefs: Set<String>) -> Int {
        var exclusive = Set<String>()
        for (_, sha) in lruFilePointers(tier: tier) where !folderRefs.contains(sha) { exclusive.insert(sha) }
        return blobBytes(exclusive, tier: tier)
    }

    static func stats() -> [String: Any] {
        func count(_ dir: URL) -> Int { (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.count ?? 0 }
        return [
            "budget_mb": AppManifest.contentBudgetMB,
            "cache_bytes": directorySize(cacheRoot),
            "pinned_bytes": directorySize(pinnedRoot),
            "folders": count(cacheRoot.appendingPathComponent("folders")) + count(pinnedRoot.appendingPathComponent("folders")),
            "blobs": count(cacheRoot.appendingPathComponent("blobs/sha256")) + count(pinnedRoot.appendingPathComponent("blobs/sha256"))
        ]
    }

    // MARK: anti-rollback high-water (per folder, signed manifests only)

    static func versionHighWater(_ dir: URL?) -> Int? {
        guard let dir, let s = readPointer(dir, "version") else { return nil }
        return Int(s)
    }

    static func recordVersionHighWater(_ dir: URL, _ version: Int) {
        if let mark = versionHighWater(dir), version < mark { return }   // never regress the mark
        try? Data(String(version).utf8).write(to: dir.appendingPathComponent("version"), options: .atomic)
    }

    // MARK: single-URL plane (pointer files → blobs)

    static func filePointerURL(_ url: String) -> URL {
        cacheRoot.appendingPathComponent("files", isDirectory: true)
            .appendingPathComponent(RemoteBundleGate.hexSHA256(Data(url.utf8)))
    }

    static func cachedFile(_ url: String) -> Data? {
        let pointer = filePointerURL(url)
        guard let sha = boundedData(at: pointer, maximumBytes: 128)
                .flatMap({ String(data: $0, encoding: .utf8) })?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              DSXContentInputPolicy.validSHA256(sha), let blob = blobURL(sha) else { return nil }
        // Bump the pointer's LRU clock off the render path — a frequently-served offline URL
        // must not read as least-recently-used to pointer eviction just because it never re-fetches.
        DispatchQueue.global(qos: .utility).async {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: pointer.path)
        }
        return boundedData(at: blob, maximumBytes: DSXContentTransportPolicy.maximumControlBytes)
    }

    /// Read a regular, non-symlink file with both advertised-size preflight and an actual byte
    /// ceiling. The chunk loop closes the TOCTOU hole left by `Data(contentsOf:)`: a file that is
    /// replaced or grows after metadata inspection can consume at most `maximumBytes + 1` before
    /// the read is rejected.
    static func boundedData(at url: URL, maximumBytes: Int) -> Data? {
        DSXContentMemoryPolicy.readFile(at: url, maximumBytes: maximumBytes)
    }

    static func writeFilePointer(url: String, sha: String) {
        let f = filePointerURL(url)
        try? FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(sha.utf8).write(to: f, options: .atomic)
    }

    // MARK: materialize (a real directory view of one generation)

    /// Build `trees/<generation>/` from APFS clones, staged then published by ONE atomic move —
    /// a half-built tree is never visible, concurrent builders converge (the loser's move fails
    /// against the winner's completed tree and returns it). `treeMarkerName` marks a finished tree.
    static func materialize(folderDir: URL, generation: String, blobmap: [String: BlobRef]) throws -> URL {
        let tree = folderDir.appendingPathComponent("trees", isDirectory: true)
            .appendingPathComponent(generation, isDirectory: true)
        let marker = tree.appendingPathComponent(treeMarkerName)
        if FileManager.default.fileExists(atPath: marker.path) { return tree }
        let staging = tmpDir.appendingPathComponent("tree-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }   // no-op after a successful move
        for (rel, ref) in blobmap {
            guard let src = blobURL(ref.sha) ?? ref.seed.flatMap(seedURL) else { throw ContentError.missing(rel) }
            let dst = staging.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: src, to: dst)       // clones on APFS — metadata only
        }
        try Data().write(to: staging.appendingPathComponent(treeMarkerName))
        try FileManager.default.createDirectory(at: tree.deletingLastPathComponent(), withIntermediateDirectories: true)
        do { try FileManager.default.moveItem(at: staging, to: tree) }
        catch {
            if FileManager.default.fileExists(atPath: marker.path) { return tree }
            throw error
        }
        return tree
    }
}

// MARK: - The mutation actor

/// ONE actor owns every store mutation: manifest resolve, blob download (single-flight), publish,
/// heal, eviction, pinning. Readers (Content.swift) never enter it. Crash-safety comes from the
/// disk format (see the header), not from the actor — the actor only serializes writers.
actor ContentStore {

    static let shared = ContentStore()
    private static var maximumBlobBytes: Int64 {
        DSXContentTransportPolicy.blobBytes(AppManifest.contentMaxBlobMB)
    }

    /// Where a generation's manifest came from — file resolution FOLLOWS the manifest's source
    /// (a bundled manifest never fetches file bytes from a host that serves no usable manifest:
    /// an SPA catch-all's 200-with-HTML must not become "pack bytes").
    private enum ManifestSource: String {
        case network   // fetched + (when signing is ON) verified from the resolved root
        case claim     // a locally-synced copy answered the `asset.url` claim (the offline plane)
        case seed      // the bundled ContentSeed — zero hosting required
    }

    private struct Candidate {
        let text: String
        let manifest: ContentManifest
        let source: ManifestSource
        let signedVersion: Int?     // recorded as the folder's high-water only after a successful publish
    }

    /// Single-flight: concurrent requests for the same blob (by sha, or URL for hash-less) share
    /// one download. The bookkeeping rides the FLIGHT (task + its waiter/cancelled counts as one
    /// value), so every check compares task identity — a stale cancellation can never touch a
    /// successor flight that reuses the same key.
    private struct Flight {
        let task: Task<String, Error>
        var waiters = 0      // callers currently awaiting this transfer
        var cancelled = 0    // how many of them were cancelled mid-await
    }
    private var inflight: [String: Flight] = [:]

    /// Single-flight for the single-URL text plane (`freshFile`) — a burst of the same URL (the
    /// `files([…])` batch, or two SWR warms) shares one conditional GET.
    private var inflightText: [String: Task<Data?, Never>] = [:]

    /// Successful single-URL fetches since the last files-plane sweep. The files-plane budget is
    /// enforced on folder publish AND, for file-only workloads that never publish (a remote app
    /// driving DSXRemoteCache), every Nth fetch here — so the plane is bounded either way without
    /// paying a full pointer walk on every fetch.
    private var filesPlaneWrites = 0

    /// The in-flight revalidation task per folder key — the coalescer (`revalidateShared`) that
    /// makes a background SWR pass and a foreground `refresh` share ONE pass.
    private var revalidateTasks: [String: Task<ContentFolder?, Never>] = [:]

    /// Folders resolved THIS session — spared by eviction pass 0; only the pass-1 hard-cap
    /// backstop may evict one (`pin` content that must never vanish mid-session).
    private var sessionTouched: Set<String> = []

    /// Folder keys with a resolve IN FLIGHT right now (refcounted for concurrent same-folder
    /// calls). A publish's `enforceBudget` protects this whole set, not just its own key — so a
    /// `prepareAll` batch whose folders jointly exceed the budget can't evict a sibling out from
    /// under the handle the batch is about to return (a rotating re-download loop otherwise).
    private var inflightPrepares: [String: Int] = [:]

    /// Folder keys whose dsx.json `content` declaration says `pinned` — a first publish creates
    /// them straight in the pinned tier.
    private var pinnedDeclared: Set<String> = []

    private let controlTransport: DSXBoundedDataTransport
    private let blobConfiguration: URLSessionConfiguration

    init() {
        let m = URLSessionConfiguration.default
        m.waitsForConnectivity = false
        m.requestCachePolicy = .useProtocolCachePolicy      // ETag/304 revalidation rides the protocol cache
        m.timeoutIntervalForRequest = 30
        m.timeoutIntervalForResource = 60
        controlTransport = DSXBoundedDataTransport(configuration: m)
        let b = URLSessionConfiguration.default
        b.waitsForConnectivity = false
        b.urlCache = nil                                    // the CAS is the cache — never double-buffer blobs
        b.timeoutIntervalForRequest = 60
        b.timeoutIntervalForResource = 600
        blobConfiguration = b
    }

    // MARK: resolve + freshen (the dsx.content.prepare entry)

    func prepare(path: String, origin: String, manifestName: String, seed: ContentSeed?,
                 pinned: Bool, onProgress: ((Double) -> Void)?) async throws -> ContentFolder {
        let root = DSXContent.absolute(path, origin: origin)
        let key = ContentDisk.folderKey(root: root, manifestName: manifestName)
        sessionTouched.insert(key)
        inflightPrepares[key, default: 0] += 1
        defer { let n = (inflightPrepares[key] ?? 1) - 1; inflightPrepares[key] = n > 0 ? n : nil }

        // A module-declared bundled seed (dsx.json `content` → the generated seeds index) backs
        // this mount unless the caller supplied its own. A `pinned` declaration — or a caller
        // asking for it (the offline web bundle MUST survive an OS Caches purge) — steers a first
        // publish straight into the never-purged tier, and promotes an existing cache-tier folder.
        let declared = (seed == nil) ? ContentDisk.declaredSeed(path: path, origin: origin, manifestName: manifestName) : nil
        let effectiveSeed = seed ?? declared?.seed
        if pinned || declared?.pinned == true {
            pinnedDeclared.insert(key)
            if let dir = ContentDisk.existingFolderDir(key), dir.path.hasPrefix(ContentDisk.cacheRoot.path) {
                pin(path: path, origin: origin, manifestName: manifestName, pinned: true)
            }
        }

        if let current = ContentDisk.loadCurrent(key: key, root: root) {
            ContentDisk.touch(key)
            if !ContentDisk.unresolvedFiles(current).isEmpty {
                await heal(current)                          // OS purge holes: best-effort foreground refill
            }
            revalidateSoon(key: key, path: path, origin: origin, root: root,
                           manifestName: manifestName, seed: effectiveSeed)
            return current                                   // last-known-good, instantly — never gate on the network
        }
        return try await resolveFresh(key: key, root: root, manifestName: manifestName,
                                      seed: effectiveSeed, onProgress: onProgress)
    }

    /// Cold path (first ever use, or an unreadable current): the only foreground resolve.
    private func resolveFresh(key: String, root: String, manifestName: String,
                              seed: ContentSeed?, onProgress: ((Double) -> Void)?) async throws -> ContentFolder {
        let (net, refused) = await networkCandidate(key: key, root: root, manifestName: manifestName)
        guard let candidate = net ?? seedCandidate(seed) else {
            throw refused ? ContentError.refused : ContentError.noManifest
        }
        // ALL-OR-NOTHING: a generation publishes only if EVERY file resolved to its declared bytes
        // (acquire throws otherwise). A partial generation is never written, so the manifest text
        // and the blobmap can never disagree.
        let blobmap = try await acquireAll(entries: candidate.manifest.files, root: root,
                                           source: candidate.source, seed: seed, onProgress: onProgress)
        let published = try publish(key: key, root: root, candidate: candidate, blobmap: blobmap)
        feedSource(root: root, source: candidate.source)   // cold resolve — the folder's first provenance
        return published
    }

    /// Feed the kernel PROVENANCE plane (`dsx.source.content`) — the automatic half of the
    /// one-cache-primitive rule: every consumer that caches host bytes through `dsx.content`
    /// gets its source state published for free, at the store's own seams (cold resolve,
    /// confirmed-fresh revalidation, generation flip). A network-sourced manifest means the
    /// HOST answered this session → `live` + the persisted first-load stamp (keyed by the
    /// folder root, which already folds the origin in); a seed serve keeps never|stale honest
    /// (`serving: bundle`). Bytes always serve from local CAS, hence `cache` for fetched folders.
    private func feedSource(root: String, source: ManifestSource) {
        // fresh == the HOST answered — a `.claim` resolve is the offline plane (a locally-synced
        // copy), so it must keep never|stale honest, never write the permanent first-load stamp.
        DSXSource.publish("content",
                          serving: source == .seed ? DSXSource.servingBundle : DSXSource.servingCache,
                          fresh: source == .network, key: root, meta: ["root": root])
    }

    /// Stale-while-revalidate: refresh in the background; a NEW generation publishes atomically,
    /// fires `content.updated`, and serves on the folder's next open. Goes through the SHARED
    /// coalescer, so a background pass and a concurrent foreground `refresh` are the same pass.
    private func revalidateSoon(key: String, path: String, origin: String, root: String,
                                manifestName: String, seed: ContentSeed?) {
        guard revalidateTasks[key] == nil else { return }
        Task(priority: .utility) {
            _ = await self.revalidateShared(key: key, path: path, origin: origin, root: root,
                                            manifestName: manifestName, seed: seed, onProgress: nil)
        }
    }

    /// COALESCED revalidation: at most ONE `revalidateNow` per folder key at a time. A background
    /// SWR pass and a foreground `refresh` for the same key share the one task — never two
    /// concurrent passes (which would double-fetch, double-publish, and double-ring the update
    /// bell). The check-and-insert below has no `await` between them, so the actor makes it atomic.
    private func revalidateShared(key: String, path: String, origin: String, root: String,
                                  manifestName: String, seed: ContentSeed?,
                                  onProgress: ((Double) -> Void)?) async -> ContentFolder? {
        if let running = revalidateTasks[key] { return await running.value }
        let task = Task { () -> ContentFolder? in
            await self.revalidateNow(key: key, path: path, origin: origin, root: root,
                                     manifestName: manifestName, seed: seed, onProgress: onProgress)
        }
        revalidateTasks[key] = task
        let result = await task.value
        revalidateTasks[key] = nil
        return result
    }

    /// FOREGROUND revalidation (the dsx.content.refresh entry) — same core as the background
    /// pass, awaited, for callers that must apply an update BEFORE proceeding (the offline-app
    /// boot gate). Returns the folder current AFTER the attempt; nil only if never resolved.
    func refresh(path: String, origin: String, manifestName: String,
                 onProgress: ((Double) -> Void)?) async -> ContentFolder? {
        let root = DSXContent.absolute(path, origin: origin)
        let key = ContentDisk.folderKey(root: root, manifestName: manifestName)
        sessionTouched.insert(key)
        let declared = ContentDisk.declaredSeed(path: path, origin: origin, manifestName: manifestName)
        return await revalidateShared(key: key, path: path, origin: origin, root: root,
                                      manifestName: manifestName, seed: declared?.seed, onProgress: onProgress)
    }

    /// The shared revalidation core. Fetch the manifest, acquire what changed, publish
    /// atomically, announce `content.updated` — only on a REAL generation change; any failure
    /// leaves the last-known-good serving. Returns the folder current after the attempt.
    private func revalidateNow(key: String, path: String, origin: String, root: String,
                               manifestName: String, seed: ContentSeed?,
                               onProgress: ((Double) -> Void)?) async -> ContentFolder? {
        guard let current = ContentDisk.loadCurrent(key: key, root: root) else { return nil }
        let (net, _) = await networkCandidate(key: key, root: root, manifestName: manifestName)
        // The seed refreshes only a SEED-SOURCED folder (a rebuilt app ships a rebuilt seed — the
        // old build's cached pack must not shadow it). A network-sourced folder never falls back
        // to the seed here: a connectivity blip must not replace hosted content with the sample.
        let candidate = net ?? (current.source == ManifestSource.seed.rawValue ? seedCandidate(seed) : nil)
        guard let candidate else { return current }
        // SHORT-CIRCUIT on an UNCHANGED manifest: if the fetched bytes are identical to the current
        // generation's stored manifest, nothing changed — return WITHOUT re-acquiring. Decisive for
        // hosted bundles, which would otherwise re-download the whole app on every SWR pass just to
        // recompute the generation id; the manifest fetch itself is already a cheap ETag/304.
        // THREE gates keep the shortcut honest:
        //   • never a .seed source — a bundled seed's manifest text is static but its files are
        //     rebuilt per app BUILD (the Godot demo pack), so a seed folder must re-hash;
        //   • only when the unchanged manifest actually DETECTS change — every file sha-pinned
        //     (unchanged shas ⇒ unchanged bytes), or a `deployed_at` timestamp whose whole PURPOSE
        //     is to vary per deploy (so a redeploy changes the manifest text and this compare
        //     fails). NOT `version`: it is commonly a static schema/format marker, so a constant
        //     version over changed hash-less bytes would permanently hide the update. A manifest
        //     with hash-less files and no `deployed_at` falls through and re-hashes as before —
        //     nothing but fresh bytes can detect its change;
        //   • only while the current generation is WHOLE — with purge holes the pass must fall
        //     through so acquireAll re-downloads the missing blobs (refresh heals, not just prepare).
        if candidate.source != .seed,
           current.manifest.files.allSatisfy({ $0.sha256 != nil }) || current.manifest.deployedAt != nil,
           ContentDisk.unresolvedFiles(current).isEmpty,
           let dir = ContentDisk.existingFolderDir(key),
           ContentDisk.manifestText(dir: dir, generation: current.generation) == candidate.text {
            feedSource(root: root, source: candidate.source)   // the host CONFIRMED current — the previously-silent "still fresh" signal
            return current
        }
        // ALL-OR-NOTHING (see resolveFresh): if any file can't be freshly resolved, acquireAll
        // throws and we keep the last-known-good generation intact — never a torn publish.
        guard let blobmap = try? await acquireAll(entries: candidate.manifest.files, root: root,
                                                  source: candidate.source, seed: seed,
                                                  onProgress: onProgress) else { return current }
        // `evict` cancels this task (revalidateTasks[key]) then deletes the folder dirs. If the
        // resolve finished from CAS with no cancellable download, cancellation didn't unwind it —
        // so re-check here before publish(), whose ensureFolderDir would otherwise RECREATE the
        // just-evicted folder (a resurrect). A cancelled pass abandons its result, last-good stays.
        if Task.isCancelled { return current }
        if ContentDisk.generationID(blobmap) == current.generation {
            // Fresh already — but a HEAL pass lands its re-downloaded blobs in the CACHE tier
            // (ingest always writes there) and no publish will run to clone them: re-clone into
            // the pinned tier when this folder lives there, so a healed pinned folder is
            // purge-proof again (cloneBlobs skips blobs already present — a no-op otherwise).
            if let dir = ContentDisk.existingFolderDir(key), dir.path.hasPrefix(ContentDisk.pinnedRoot.path) {
                ContentDisk.cloneBlobs(Set(blobmap.values.map(\.sha)), toTier: ContentDisk.pinnedRoot)
            }
            feedSource(root: root, source: candidate.source)   // re-hashed equal — fresh confirm (or a seed re-serve)
            return current
        }
        guard let published = try? publish(key: key, root: root, candidate: candidate, blobmap: blobmap) else { return current }
        feedSource(root: root, source: candidate.source)       // a NEW generation went live
        let generation = published.generation                 // immutable Sendable snapshot for the main-queue hop
        DispatchQueue.main.async {
            ModuleRegistry.shared.dispatch("content.updated",
                                       ["path": path, "origin": origin, "root": root,
                                        "manifest": manifestName,
                                        "generation": generation], .void)
        }
        return published
    }

    /// Refill purge holes against the CURRENT generation's own hashes (no generation change).
    /// Best-effort: offline holes stay holes until the next online prepare.
    private func heal(_ folder: ContentFolder) async {
        for rel in ContentDisk.unresolvedFiles(folder) {
            guard let ref = folder.blobmap[rel] else { continue }
            let urlString = folder.root + rel
            if let local = Self.claimLocalFile(urlString, maximumBytes: Self.maximumBlobBytes),
               (try? ContentDisk.ingestLocalFile(
                local, maximumBytes: Self.maximumBlobBytes, expectedSHA: ref.sha
               )) == ref.sha {
                continue
            }
            _ = try? await download(urlString: urlString, expectSha: ref.sha, key: ref.sha)
        }
        // Healed bytes land in the cache tier (ingest) — re-clone into the pinned tier when this
        // folder lives there, so a heal restores purge-proofness, not just readability.
        if folder.folderDir.path.hasPrefix(ContentDisk.pinnedRoot.path) {
            ContentDisk.cloneBlobs(Set(folder.blobmap.values.map(\.sha)), toTier: ContentDisk.pinnedRoot)
        }
    }

    // MARK: manifest candidates

    /// Fetch + vet the hosted manifest. Returns (candidate, refusedBySigning) — refused means a
    /// manifest PARSED but failed the signing gate, which callers surface differently from
    /// "nothing there".
    private func networkCandidate(key: String, root: String,
                                  manifestName: String) async -> (Candidate?, Bool) {
        let fetched = await fetchManifest(root: root, manifestName: manifestName)
        guard let text = fetched.text, let manifest = ContentManifest.parse(text: text) else { return (nil, false) }
        if fetched.fromNetwork {
            guard trustNetworkManifest(text: text, signature: fetched.signature,
                                       folderKey: key, version: manifest.version) else {
                NSLog("[DSXContent] refusing unverified manifest at %@%@ (signing is ON) — last-good keeps serving", root, manifestName)
                return (nil, true)
            }
            // A verified SIGNATURE covers the manifest bytes — but a file with NO declared sha256
            // is acquired network-first with `expectSha: nil` (or from the unsigned `asset.url`
            // claim), i.e. its BYTES are never checked against anything. Signing a hash-less
            // manifest would therefore publish unverifiable content under a trusted deployment,
            // so with signing ON a network manifest is trusted only when EVERY file is sha-pinned
            // — otherwise refuse the new generation and keep last-known-good (Article 7).
            if RemoteBundleGate.requiresVerification,
               !manifest.files.allSatisfy({ $0.sha256 != nil }) {
                NSLog("[DSXContent] refusing signed manifest at %@%@ with hash-less files (signing is ON) — every file must be sha-pinned", root, manifestName)
                return (nil, true)
            }
            let signedVersion = RemoteBundleGate.requiresVerification ? manifest.version : nil
            return (Candidate(text: text, manifest: manifest, source: .network, signedVersion: signedVersion), false)
        }
        return (Candidate(text: text, manifest: manifest, source: .claim, signedVersion: nil), false)
    }

    private func seedCandidate(_ seed: ContentSeed?) -> Candidate? {
        guard let seed, let text = seed.manifestText(),
              text.utf8.count <= DSXContentTransportPolicy.maximumControlBytes,
              let manifest = ContentManifest.parse(text: text) else { return nil }
        return Candidate(text: text, manifest: manifest, source: .seed, signedVersion: nil)
    }

    /// Manifest transport: a locally-synced copy (the `asset.url` claim — the offline plane) wins,
    /// else the network. The ACCEPTANCE RULE (parse as object + file list) is applied by the
    /// caller either way, so no source can poison the store with a 200-that-isn't-a-manifest.
    private func fetchManifest(root: String, manifestName: String) async -> (text: String?, signature: Data?, fromNetwork: Bool) {
        let urlString = root + manifestName
        // The local `asset.url` claim shortcut is UNVERIFIED (there's no signature to check), so it
        // is trusted ONLY when signing is off. With signing ON the manifest must come from the
        // network and pass the gate — otherwise a local file an attacker can plant (a cdn.upload
        // blob mapping to the manifest path) would be published unsigned. Per-FILE claim resolution
        // stays safe because those files are sha-checked against the (now verified) manifest.
        if !RemoteBundleGate.requiresVerification,
           let local = Self.claimLocalData(urlString, maximumBytes: Int64(DSXContentTransportPolicy.maximumControlBytes)) {
            return (String(data: local, encoding: .utf8), nil, false)
        }
        guard let u = URL(string: urlString),
              let (data, resp) = try? await controlTransport.data(
                from: u, maximumBytes: DSXContentTransportPolicy.maximumControlBytes),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return (nil, nil, false)
        }
        var signature: Data? = nil
        if RemoteBundleGate.requiresVerification {
            if let header = http.value(forHTTPHeaderField: "X-DSX-Signature"),
               header.utf8.count <= DSXContentTransportPolicy.maximumControlBytes {
                signature = Self.decodeBase64(header)
            }
            if signature == nil, let sigURL = URL(string: urlString + ".sig"),
               let (sd, sr) = try? await controlTransport.data(
                from: sigURL, maximumBytes: DSXContentTransportPolicy.maximumControlBytes),
               let sh = sr as? HTTPURLResponse, (200..<300).contains(sh.statusCode) {
                signature = Self.decodeBase64(String(data: sd, encoding: .utf8) ?? "") ?? sd
            }
        }
        return (String(data: data, encoding: .utf8), signature, true)
    }

    /// The signing gate for a NETWORK manifest — the gate's PURE per-anchor math, deliberately
    /// NOT `RemoteBundleGate.verifyManifest`: its recorded-digest slot is the ROUTE TABLE's
    /// verdict (`Router.resolved` consumes it), and recording a content manifest there would
    /// evict the routes verdict. Anti-rollback is per-folder (high-water file), same principle
    /// as C1: the version rides inside the signed bytes, and the mark never regresses.
    private func trustNetworkManifest(text: String, signature: Data?, folderKey: String, version: Int?) -> Bool {
        guard RemoteBundleGate.requiresVerification else { return true }   // signing OFF ⇒ source trust, as ever
        guard !RemoteBundleGate.isMisconfigured else { return false }      // ON with no usable key ⇒ fail closed
        guard let signature, !signature.isEmpty else { return false }
        let bytes = Data(text.utf8)
        guard RemoteBundleGate.config.anchors.contains(where: {
            RemoteBundleGate.verify(manifest: bytes, signature: signature, anchor: $0)
        }) else { return false }
        if let version, let mark = ContentDisk.versionHighWater(ContentDisk.existingFolderDir(folderKey)),
           version < mark { return false }                                 // a replayed older manifest is refused
        return true
    }

    // MARK: per-file acquisition (the resolution chain)

    private func acquireAll(entries: [ContentManifest.Entry], root: String, source: ManifestSource,
                            seed: ContentSeed?,
                            onProgress: ((Double) -> Void)?) async throws -> [String: BlobRef] {
        // Files with a safe relative path (normalizeRel drops "."/".."/absolute-URL entries → empty,
        // which is skipped). A manifest that lists files but whose entries ALL normalize away (e.g.
        // every path is an absolute URL) must NOT publish a zero-file generation over a good one —
        // that would supersede real content with an empty tree, breaking all-or-nothing. Reject it.
        let jobs: [(rel: String, entry: ContentManifest.Entry)] = entries.compactMap { entry in
            let rel = ContentDisk.normalizeRel(entry.path)
            return rel.isEmpty ? nil : (rel, entry)
        }
        if jobs.isEmpty {
            if entries.isEmpty { return [:] }                 // a genuinely empty manifest is a valid empty generation
            throw ContentError.noManifest                     // every listed entry was rejected ⇒ not a usable generation
        }
        // APFS is normally case-insensitive and Unicode-normalizing. Two spellings that map to
        // the same on-disk file would otherwise race and make the published generation depend on
        // network completion order. Reject the entire manifest deterministically.
        var identities = Set<String>()
        for job in jobs {
            let identity = job.rel.precomposedStringWithCanonicalMapping.lowercased()
            guard identities.insert(identity).inserted else { throw ContentError.noManifest }
        }

        // BOUNDED fan-out: a sliding window of in-flight acquires. Each acquire suspends the actor
        // during its network transfer, so up to `window` downloads overlap — but a huge folder never
        // opens a socket per file. The store's single-flight dedups identical blobs; a throwing
        // acquire (integrity mismatch) cancels the rest and propagates, exactly as the old
        // sequential `try await` did. The group body is actor-isolated, so `out`/`done`/`next` are
        // race-free; the @Sendable child tasks only re-enter the actor via `self.acquire`.
        let window = min(6, jobs.count)
        var out: [String: BlobRef] = [:]
        var done = 0
        var next = 0
        try await withThrowingTaskGroup(of: (String, BlobRef).self) { group in
            func schedule() {
                guard next < jobs.count else { return }
                let job = jobs[next]; next += 1
                group.addTask {
                    (job.rel, try await self.acquire(entry: job.entry, rel: job.rel, root: root,
                                                     source: source, seed: seed))
                }
            }
            for _ in 0..<window { schedule() }
            while let (rel, ref) = try await group.next() {
                out[rel] = ref
                done += 1
                onProgress?(Double(done) / Double(jobs.count))
                schedule()
            }
        }
        return out
    }

    /// Resolve ONE file to a verified blob, or THROW. There is deliberately no "stale previous
    /// generation" fallback: a folder either produces a COMPLETE new generation or `acquireAll`
    /// throws and the caller keeps the last-known-good one whole (atomic generations — a published
    /// manifest and its blobmap can never disagree).
    private func acquire(entry: ContentManifest.Entry, rel: String, root: String, source: ManifestSource,
                         seed: ContentSeed?) async throws -> BlobRef {
        let urlString = root + rel
        let maximumBlobBytes = Self.maximumBlobBytes
        if let declared = entry.bytes, declared < 0 || Int64(declared) > maximumBlobBytes {
            throw ContentError.missing(rel)
        }

        if let sha = entry.sha256 {
            // A declared sha ⇒ offline-first: the hash is integrity AND the change detector.
            if ContentDisk.hasBlob(sha) { return BlobRef(sha: sha, seed: nil) }              // 1. CAS (verified, instant)
            if let seed, let u = seed.fileURL(rel), (try? ContentDisk.hashFile(u)) == sha {  // 2. bundled seed (zero-copy)
                return BlobRef(sha: sha, seed: u.lastPathComponent)
            }
            if let local = Self.claimLocalFile(urlString, maximumBytes: maximumBlobBytes),
               (try? ContentDisk.ingestLocalFile(
                local, maximumBytes: maximumBlobBytes, expectedSHA: sha
               )) == sha {  // 3. locally synced
                return BlobRef(sha: sha, seed: nil)
            }
            if source != .seed {                                                             // 4. network (verified)
                do {
                    return BlobRef(sha: try await download(urlString: urlString, expectSha: sha, key: sha), seed: nil)
                } catch let e as ContentError {
                    if case .integrity = e { throw ContentError.integrity(rel) }             // bad bytes: loud, never silent
                } catch { }
            }
            throw ContentError.missing(rel)                                                  // incomplete → abandon the whole generation
        }

        // No declared sha ⇒ nothing but fresh bytes can detect change.
        switch source {
        case .seed:
            // The manifest itself is bundled: the host serves no usable manifest for this folder,
            // so its file URLs are not trusted either (an SPA catch-all's 200-with-HTML must never
            // become "pack bytes"). The bundle is the truth; hashing it names the generation, so a
            // rebuilt bundled file IS a new generation — no build-scoped cache dance needed.
            if let seed, let u = seed.fileURL(rel), let sha = try? ContentDisk.hashFile(u) {
                return BlobRef(sha: sha, seed: u.lastPathComponent)
            }
            throw ContentError.missing(rel)
        case .network, .claim:
            // A hosted manifest ⇒ network-first (fresh bytes win); seed / synced are the offline
            // fallbacks. No previous-generation substitution — see the method note.
            if let sha = try? await download(urlString: urlString, expectSha: nil, key: "url:" + urlString) {
                return BlobRef(sha: sha, seed: nil)
            }
            if let seed, let u = seed.fileURL(rel), let sha = try? ContentDisk.hashFile(u) {
                return BlobRef(sha: sha, seed: u.lastPathComponent)
            }
            if let local = Self.claimLocalFile(urlString, maximumBytes: maximumBlobBytes),
               let sha = try? ContentDisk.ingestLocalFile(
                local, maximumBytes: maximumBlobBytes, expectedSHA: nil
               ) {
                return BlobRef(sha: sha, seed: nil)
            }
            throw ContentError.missing(rel)
        }
    }

    // MARK: download (single-flight, verify, ingest)

    /// Download → streaming hash → (optional) verify → atomic rename into the CAS. Returns the
    /// blob's sha. Single-flight per `key`: concurrent callers share one transfer. Total mapping:
    /// transport/HTTP failures are `.missing`, a hash mismatch is `.integrity` (and NEVER
    /// overwrites an existing good blob — the mismatched bytes are discarded in staging).
    /// CANCELLATION-RESPONSIVE: `Task.value` alone would pin an aborting caller (a failed
    /// `acquireAll` group cancelling its children) to the full transfer time — so a cancelled
    /// waiter that is the LAST live one cancels the shared task (URLSession's async download
    /// honors it), and every waiter resumes promptly with `.missing`.
    private func download(urlString: String, expectSha: String?, key: String) async throws -> String {
        let task: Task<String, Error>
        if let running = inflight[key], !running.task.isCancelled {
            task = running.task
        } else {
            // No flight, or the previous one was just cancelled (its waiters are unwinding but
            // its Task hasn't finished clearing yet) — a fresh caller must never join a poisoned
            // task, so REPLACE the entry; the old flight's waiters hold their own task reference
            // and their identity-checked cleanup below skips the new entry.
            let configuration = blobConfiguration
            let maximumBytes = Self.maximumBlobBytes
            task = Task { () throws -> String in
                guard let u = URL(string: urlString) else { throw ContentError.missing(urlString) }
                let downloaded: (URL, URLResponse)
                do {
                    downloaded = try await DSXBoundedContentTransport.download(
                        configuration: configuration, from: u,
                        maximumBytes: maximumBytes, stagingDirectory: ContentDisk.tmpDir)
                }
                catch { throw ContentError.missing(urlString) }
                let tmp = downloaded.0
                defer { try? FileManager.default.removeItem(at: tmp) }
                guard let http = downloaded.1 as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw ContentError.missing(urlString)
                }
                guard let sha = try? ContentDisk.hashFile(tmp) else {
                    throw ContentError.missing(urlString)
                }
                if let expectSha, sha != expectSha {
                    NSLog("[DSXContent] integrity mismatch for %@ (declared %@, got %@) — bytes discarded", urlString, expectSha, sha)
                    throw ContentError.integrity(urlString)
                }
                try ContentDisk.ingest(tmp: tmp, sha: sha)
                return sha
            }
            inflight[key] = Flight(task: task)
        }
        inflight[key]?.waiters += 1
        defer {
            if var flight = inflight[key], flight.task == task {
                flight.waiters -= 1
                inflight[key] = flight.waiters <= 0 ? nil : flight
            }
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            Task { await self.abandonDownload(key: key, task: task) }
        }
    }

    /// A `download` waiter was cancelled mid-await. Cancel the shared transfer only once EVERY
    /// waiter is (an un-cancelled waiter still wants the bytes — the transfer runs on for it,
    /// and the cancelled caller simply rides until it lands, same as before). Identity-checked:
    /// a cancellation raised against an earlier flight never touches the one now under the key.
    private func abandonDownload(key: String, task: Task<String, Error>) {
        guard var flight = inflight[key], flight.task == task else { return }
        flight.cancelled += 1
        inflight[key] = flight
        if flight.cancelled >= flight.waiters { task.cancel() }
    }

    // MARK: publish (atomic generation flip)

    /// Write the generation's two artifacts, THEN flip `current` (old current → `previous`).
    /// Crash anywhere = old fully live or new fully published, never torn. Prunes to the keep-two
    /// rule and enforces the budget after every publish.
    private func publish(key: String, root: String, candidate: Candidate,
                         blobmap: [String: BlobRef]) throws -> ContentFolder {
        let dir = try ContentDisk.ensureFolderDir(key, preferPinned: pinnedDeclared.contains(key))
        let gen = ContentDisk.generationID(blobmap)
        let gens = dir.appendingPathComponent("gens", isDirectory: true)
        try FileManager.default.createDirectory(at: gens, withIntermediateDirectories: true)
        try Data(candidate.text.utf8).write(to: gens.appendingPathComponent(gen + ".json"), options: .atomic)
        try ContentDisk.blobmapData(blobmap, source: candidate.source.rawValue)
            .write(to: gens.appendingPathComponent(gen + ".blobmap"), options: .atomic)
        if let old = ContentDisk.readGenerationPointer(dir, "current"), old != gen {
            try? Data(old.utf8).write(to: dir.appendingPathComponent("previous"), options: .atomic)
        }
        try Data(gen.utf8).write(to: dir.appendingPathComponent("current"), options: .atomic)
        if let version = candidate.signedVersion { ContentDisk.recordVersionHighWater(dir, version) }
        let prunedAGeneration = ContentDisk.pruneGenerations(dir)
        ContentDisk.touch(key)
        // A pinned folder must be SELF-CONTAINED in the never-purged tier — clone its blobs there
        // (ingest writes them to cache), so an OS Caches purge can't strip an offline-critical
        // bundle out from under a pinned folder pointer.
        if dir.path.hasPrefix(ContentDisk.pinnedRoot.path) {
            ContentDisk.cloneBlobs(Set(blobmap.values.map(\.sha)), toTier: ContentDisk.pinnedRoot)
            ContentDisk.applyBackupExclusion()
        }
        // Collect the blobs the pruned N-2 generation orphaned. enforceBudget's own gcBlobs only
        // runs when the CACHE budget trips — a pinned-only app (web bundle in Application Support,
        // cache ≈ empty) would otherwise never GC, growing the never-purged tier with every deploy.
        // The one-hour ingest grace protects this publish's just-written blobs.
        if prunedAGeneration { ContentDisk.gcBlobs() }
        enforceBudget(protecting: key)
        guard let folder = ContentDisk.loadCurrent(key: key, root: root) else { throw ContentError.noManifest }
        return folder
    }

    // MARK: eviction (generation-granular, LRU, never a live/in-flight folder)

    /// The two cache planes are capped INDEPENDENTLY against `content.budget_mb`: the folder plane
    /// (packs, the web bundle's cache-tier copy) and the single-URL plane (`dsx.content.file`,
    /// DSXRemoteCache). Keeping them separate avoids a coupling trap — a blob shared by a folder
    /// and a pointer would otherwise just move between the two accountings as a folder is evicted,
    /// making the folder sweep over-evict to chase bytes only pointer eviction can free.
    private func enforceBudget(protecting protected: String? = nil) {
        let budgetBytes = AppManifest.contentBudgetMB * 1_048_576
        guard budgetBytes > 0 else { return }
        evictFolders(budgetBytes: budgetBytes, protecting: protected)
        evictFilePointers(budgetBytes: budgetBytes)
    }

    private func evictFolders(budgetBytes: Int, protecting protected: String?) {
        let cache = ContentDisk.cacheRoot
        // Reclaimable folder bytes: folder dirs + their referenced blobs. Graced orphans of an
        // aborted publish and staging are excluded — folder eviction can't claw those back, so
        // counting them would strip every folder and still finish over budget.
        var size = ContentDisk.folderAccountedBytes(tier: cache)
        guard size > budgetBytes else { return }

        // NEVER evict `protected` (the folder whose publish invoked this: its async `touch` stamp
        // may not have landed, sorting it LRU-FIRST — evicting it would fail the publish it rode in
        // on and re-download forever) nor any folder with a resolve IN FLIGHT (a `prepareAll` batch
        // must not cannibalize a sibling handle it's about to return). Pinned content lives in the
        // never-purged tier and is never seen here.
        var shielded = Set(inflightPrepares.keys)
        if let protected { shielded.insert(protected) }

        // Pass 0 evicts folders NOT touched this session; pass 1 (backstop) may evict a session
        // folder too — EXCEPT one heavier than the whole budget, since evicting a >budget live
        // folder can never end the overage and only buys a re-download loop (same rationale as the
        // `protected` carve-out). `estimate` drops `size` by each folder's weight so the loop stops
        // as soon as it's under budget; the accurate re-measured pass below corrects any optimism.
        func sweep(estimate: Bool) {
            for pass in 0..<2 where size > budgetBytes {
                for key in ContentDisk.lruFolderKeys() where size > budgetBytes {
                    if shielded.contains(key) { continue }
                    let dir = ContentDisk.folderDir(key, tier: cache)
                    guard FileManager.default.fileExists(atPath: dir.path) else { continue }
                    let weight = ContentDisk.directorySize(dir)
                        + ContentDisk.blobBytes(ContentDisk.referencedShas(inFolderDir: dir), tier: cache)
                    if sessionTouched.contains(key) && (pass == 0 || weight > budgetBytes) { continue }
                    ContentDisk.removeFolder(key: key, tier: cache)
                    if estimate {
                        size -= weight
                    } else {
                        ContentDisk.gcBlobs()
                        size = ContentDisk.folderAccountedBytes(tier: cache)
                    }
                }
            }
        }
        sweep(estimate: true)
        ContentDisk.gcBlobs()
        // The estimate is OPTIMISTIC (a subtracted blob survives GC when another folder shares it),
        // so re-measure and, only if it fell short, run the accurate per-eviction sweep.
        size = ContentDisk.folderAccountedBytes(tier: cache)
        sweep(estimate: false)
    }

    /// Cap the single-URL plane: if its exclusive blob bytes exceed the budget, evict its
    /// least-recently-used pointers (each deletes a URL→sha pointer; its now-orphaned blob is
    /// collected by the trailing gcBlobs). Folder-shared blobs are never counted or freed here —
    /// they belong to the folder plane. Refcounts pointers to a shared sha so bytes are credited
    /// only when the LAST pointer to a blob goes (no per-pointer full re-measure).
    private func evictFilePointers(budgetBytes: Int) {
        let cache = ContentDisk.cacheRoot
        let folderRefs = ContentDisk.allFolderRefs(tier: cache)
        var size = ContentDisk.filesPlaneBytes(tier: cache, folderRefs: folderRefs)
        guard size > budgetBytes else { return }
        let pointers = ContentDisk.lruFilePointers(tier: cache)
        var refCount: [String: Int] = [:]
        for (_, sha) in pointers where !folderRefs.contains(sha) { refCount[sha, default: 0] += 1 }
        var evicted = false
        for (pointer, sha) in pointers where size > budgetBytes {
            // Skip a folder-shared pointer BEFORE deleting it: its blob survives via the folder
            // plane, so deletion frees zero bytes AND loses a still-valid offline cache entry (a
            // needless re-fetch). Only exclusive pointers — the ones whose removal can actually
            // advance the budget — are evicted.
            guard !folderRefs.contains(sha) else { continue }
            try? FileManager.default.removeItem(at: pointer)
            evicted = true
            let remaining = (refCount[sha] ?? 1) - 1
            refCount[sha] = remaining
            if remaining <= 0 { size -= ContentDisk.blobBytes([sha], tier: cache) }
        }
        if evicted { ContentDisk.gcBlobs() }
    }

    // MARK: pin / evict / single-URL

    /// Move a folder between tiers. Bytes first: referenced blobs are CLONED into the destination
    /// tier before the folder moves, so a pinned folder never depends on purgeable bytes.
    func pin(path: String, origin: String, manifestName: String, pinned: Bool) {
        let root = DSXContent.absolute(path, origin: origin)
        let key = ContentDisk.folderKey(root: root, manifestName: manifestName)
        // Keep the steer-first-publish flag in lockstep with the tier: pinning marks the folder so
        // a later cold re-resolve republishes into the pinned tier; unpinning clears it so the next
        // prepare doesn't silently re-promote content the caller just demoted.
        if pinned { pinnedDeclared.insert(key) } else { pinnedDeclared.remove(key) }
        let srcTier = pinned ? ContentDisk.cacheRoot : ContentDisk.pinnedRoot
        let dstTier = pinned ? ContentDisk.pinnedRoot : ContentDisk.cacheRoot
        let srcDir = ContentDisk.folderDir(key, tier: srcTier)
        let dstDir = ContentDisk.folderDir(key, tier: dstTier)
        guard FileManager.default.fileExists(atPath: srcDir.path) else {
            if pinned { ContentDisk.applyBackupExclusion() }
            return                                            // already in the target tier (or never resolved)
        }
        ContentDisk.cloneBlobs(ContentDisk.referencedShas(inFolderDir: srcDir), toTier: dstTier)
        if FileManager.default.fileExists(atPath: dstDir.path) {
            try? FileManager.default.removeItem(at: srcDir)
        } else {
            try? FileManager.default.createDirectory(at: dstDir.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.moveItem(at: srcDir, to: dstDir)
        }
        ContentDisk.invalidateGenCache(key)   // the folderDir moved tiers — a memoized handle is now stale
        ContentDisk.gcBlobs()
        if pinned { ContentDisk.applyBackupExclusion() }
    }

    func evict(path: String, origin: String, manifestName: String) {
        let root = DSXContent.absolute(path, origin: origin)
        let key = ContentDisk.folderKey(root: root, manifestName: manifestName)
        // Cancel an in-flight coalesced revalidation FIRST — otherwise its acquireAll finishes and
        // publish() re-creates gens/current right after we delete them (the folder resurrects and
        // the disk isn't freed). The PR's cancellation-responsive download unwinds it; the running
        // task's own defer nils the map entry.
        revalidateTasks[key]?.cancel()
        ContentDisk.removeFolder(key: key, tier: ContentDisk.cacheRoot)
        ContentDisk.removeFolder(key: key, tier: ContentDisk.pinnedRoot)
        sessionTouched.remove(key)
        pinnedDeclared.remove(key)          // a re-resolve shouldn't be steered pinned by a stale flag
        ContentDisk.gcBlobs()
    }

    /// The single-URL plane's network fetch: through the same single-flight + CAS, remembered
    /// for `cachedFile`. nil on any failure — the previously cached copy is never touched (the
    /// facade's `file()` composes the cached fallback).
    func freshFile(_ url: String) async -> Data? {
        if let running = inflightText[url] { return await running.value }
        // The single-URL plane fetches through the MANIFEST session (protocol cache ON) via a
        // DATA task — so ETag/If-None-Match revalidation works and an unchanged resource returns
        // 304 with no body transfer. (The blob session's download tasks bypass URLCache, which is
        // right for content-addressed blobs but would defeat 304 for the mutable text plane.)
        // Bytes still land in the CAS; the URL→sha pointer is remembered for `cachedFile`.
        let transport = controlTransport
        let task = Task { () -> Data? in
            guard let u = URL(string: url),
                  let (data, resp) = try? await transport.data(
                    from: u, maximumBytes: DSXContentTransportPolicy.maximumControlBytes),
                  let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            let sha = ContentDisk.hashData(data)
            // Only remember the URL→sha pointer if the blob actually landed — an ingest failure
            // (disk full) would otherwise leave a pointer naming a missing blob, so `cachedFile`
            // returns nil forever for a URL whose fresh bytes we're holding right here.
            do { try ContentDisk.ingest(data: data, sha: sha); ContentDisk.writeFilePointer(url: url, sha: sha) }
            catch { }
            return data
        }
        inflightText[url] = task
        defer { inflightText[url] = nil }
        let result = await task.value
        // Bound the single-URL plane for a workload that only fetches (never publishes a folder, so
        // publish()'s enforceBudget never runs): sweep every 16th successful fetch. Cheap amortized —
        // a full pointer walk once per 16 fetches, and only actually evicts when over budget.
        if result != nil {
            filesPlaneWrites += 1
            if filesPlaneWrites % 16 == 0 {
                let budgetBytes = AppManifest.contentBudgetMB * 1_048_576
                if budgetBytes > 0 { evictFilePointers(budgetBytes: budgetBytes) }
            }
        }
        return result
    }

    // MARK: shared helpers

    /// Resolve a URL to LOCAL bytes via the `asset.url` kernel claim (the offline plane a module
    /// fills). Kernel-side registry access — engine code, same standing as the Router's claims.
    /// Feeds the claim the URL's path (host-relative), reads a file URL only.
    static func claimLocalFile(_ urlString: String, maximumBytes: Int64) -> URL? {
        let key = URL(string: urlString).map { $0.path.isEmpty ? urlString : $0.path } ?? urlString
        guard let resolved = ModuleRegistry.shared.dispatch("asset.url", key, .claim) as? String,
              let local = URL(string: resolved), local.isFileURL,
              local.host == nil || local.host?.isEmpty == true,
              let values = try? local.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let advertised = values.fileSize, advertised >= 0,
              Int64(advertised) <= maximumBytes else { return nil }
        return local
    }

    static func claimLocalData(_ urlString: String, maximumBytes: Int64) -> Data? {
        guard maximumBytes >= 0, maximumBytes <= Int64(Int.max),
              let local = claimLocalFile(urlString, maximumBytes: maximumBytes) else { return nil }
        return ContentDisk.boundedData(at: local, maximumBytes: Int(maximumBytes))
    }

    /// Standard OR url-safe base64 (with or without padding) — build pipelines emit both.
    private static func decodeBase64(_ s: String) -> Data? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let d = Data(base64Encoded: t) { return d }
        var b = t.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}
