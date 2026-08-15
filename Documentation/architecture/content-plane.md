# The content plane — `dsx.content` (one store under every surface)

> Status: **landed (2026-07-04)** — the kernel content primitive
> (`OpenSource/Engine/iOS/Content.swift` + `ContentStore.swift`) plus its consumers: Godot
> (`Core/Godot/GodotContent.swift`), the text plane (`DSXRemoteCache` re-backed), the
> offline web bundle (ContentServer's boot gate + claims), and the `content` dsx.json
> capability (`prepare_modules` §12 → `Registry/DSXContentSeeds.json`). Completes the
> asset-plane directive (`asset-plane.md`): one plane, every surface resolves through
> the kernel — with the STORE now a kernel primitive rather than a module's private tree.

## The model in one page

App-authored content ships as **folders** on the app's own host under the **content root**
(App.json `hosting.content_root`, default **`/dsx`**): a manifest (`manifest.json`, or a
consumer-named one like `godot-manifest.json`) listing files with optional per-file
`sha256`, plus the files. The kernel resolves a folder to local verified bytes:

```swift
dsx.content.folder("/runner")                 // SYNC last-known-good — render-path-safe, never network
try await dsx.content.prepare("/runner")      // resolve + freshen (SWR); cold = foreground behind the caller's skeleton
await dsx.content.refresh("/runner")          // AWAITED revalidation — update-before-proceed (the boot-gate form)
folder.data("index.dsx")  ·  folder.url("game.pck")  ·  try folder.materialize()   // APFS-cloned real tree
dsx.content.cachedFile(url) / freshFile(url)  // the single-URL plane (DSXRemoteCache rides this)
dsx.content.pin("/runner", true)  ·  evict  ·  stats
```

**Batch verbs (concurrency without caller loops).** Ask for a *set*, await once, get a map — the
caller never writes a loop or manages threads. The map is the cross-platform contract
(`withTaskGroup` ⟷ `coroutineScope { … async … awaitAll() }`); the kernel picks the scheduling:

```swift
await dsx.content.files([a, b, c])            // single-URL plane, concurrent (window 6) → [url: Data]
await dsx.content.prepareAll(["/menu","/store"])  // folders concurrent (window 3) → [path: Folder]
await folder.data(["cover.png","meta.json"])  // batch-read one resolved generation → [rel: Data]
```

The two NETWORK verbs fan out through a **bounded sliding window** and the store's single-flight
(a URL already in flight shares one transfer); a folder's own files are acquired the same way
(window 6, not one-by-one), so a cold multi-file folder overlaps transfers without opening a
socket per file. The batch *read* (`folder.data([…])`) is different on purpose: its bytes are
already local and verified, so it memory-maps each file — near-instant, pages fault in on use —
instead of fanning out blocking reads.

**The store is content-addressed** (`Caches/dsx-content`): verified bytes live once in
`blobs/sha256/<hex>` — deduped across folders and publishes — and a *generation* is nothing
but a `path→sha` map + the accepted manifest bytes, flipped live by an atomic `current`
pointer (`previous` kept for rollback). The generation id is the hash of the map: same
files IS same generation; one changed file IS a new generation. `sha256` is therefore both
the integrity check and the change detector. Crash-safe by layout (temp → hash → rename;
artifacts before pointer), lock-free for readers, single-flight per blob.

**Freshness is stale-while-revalidate at folder granularity.** An open serves the
last-known-good generation instantly — never a manifest round-trip in a render path — and
revalidates in the background; a new generation publishes atomically, fires the
`content.updated` kernel event ONCE, and serves on the NEXT open (a visit pins one
generation for its lifetime — old and new files never mix mid-visit). A revalidation whose
fetched manifest bytes are identical to the current generation's short-circuits with no
re-download (the manifest fetch itself is a cheap ETag/304) — but only when that manifest
actually *detects* change (every file sha-pinned, or a `deployed_at` timestamp whose whole
purpose is to vary per deploy) and the current generation is whole: a hash-less manifest with
no `deployed_at` re-hashes as before (nothing but fresh bytes can detect its change — and
`version`, a common static schema marker, is deliberately NOT trusted as a change signal), and
a generation with purge holes falls through so the pass re-acquires and heals them (`refresh`
heals, not just `prepare`). Background and foreground (`refresh`) passes for the same
folder are coalesced into one. The one gating exception is `refresh()`: the offline-app boot
gate awaits it so a web deploy applies at launch, not one launch late.

**Generations are atomic — all-or-nothing.** A generation publishes only if EVERY file
resolved to its declared bytes; if any file can't be fetched, the publish is abandoned and
the last-known-good generation is kept whole. A published manifest and its blobmap can never
disagree (no torn generation, no old-file-under-new-manifest).

**Resolution chain per file** (sha declared ⇒ offline-first): CAS blob → bundled seed
(zero-copy `Bundle.main` reference) → the `asset.url` claim (locally-synced copy) → network
(download, verify, ingest) → else the whole generation is abandoned. Hash-less files invert
to network-first when the folder is hosted. **File source follows manifest source**: a
bundled (seed) manifest never fetches file bytes from a host that serves no usable manifest —
an SPA catch-all's 200-with-HTML can neither poison a manifest (the acceptance rule: JSON
object + file list, kernel law) nor become "pack bytes".

**Trust is the ONE gate, reused.** Signing OFF ⇒ source trust as ever. Signing ON (App.json
`bundle_signing`) ⇒ a network manifest must carry a valid detached signature
(`X-DSX-Signature` header or `.sig` sidecar) over its exact bytes — verified with
`RemoteBundleGate`'s *pure* per-anchor math, deliberately not `verifyManifest` (its recorded
digest is the route table's verdict; a content manifest must not evict it). Rejection
refuses only the NEW generation; the last good one keeps serving (Article 7: fail-closed on
new content, never brick current content). Per-folder anti-rollback rides a signed
`version` high-water file. When signing is ON, a manifest is trusted only from the verified
network — the unsigned `asset.url` local-claim shortcut is skipped for the manifest itself, and
a signed manifest is accepted only when EVERY file is sha-pinned (a hash-less file is acquired
with no byte check, so signing it would publish unverifiable content under a trusted deploy —
fail-closed, last-good keeps serving). A planted local file can't publish unsigned content.

**Manifest work bounds:** a manifest may declare at most 4,096 entries and each path is at
most 1,024 UTF-8 bytes. Control characters are rejected before filesystem use. Paths that
would alias on a normal Apple filesystem after case folding and Unicode normalization are
also rejected on every platform, so concurrent downloads cannot make a generation depend on
completion order. Acquisition uses at most six workers and creates no per-entry backlog of
tasks beyond that fixed pool.

**Storage policy**: the cache tier is OS-purgeable by design — a purged blob is a cache
miss healed on the next prepare, never fatal. `pin()` / `prepare(pinned: true)` (or
`pinned: true` on a `content` declaration) makes a folder SELF-CONTAINED in Application
Support — the folder AND its blobs are cloned there (never purged, excluded from backup), so
offline-critical content (the offline web bundle, which the boot gate pins) survives a cache
purge. Eviction is generation-granular LRU under `EngineConfig content.budget_mb`
(default 300), a HARD cap over the bytes eviction can actually reclaim (folders + the blobs
their live generations reference — orphan blobs inside the ingest grace window are a floor
no folder eviction can lower; they fall to a later GC instead of costing every folder its
life): non-session folders evict first, session folders only as a backstop, and never the
folder whose publish triggered the sweep (a folder heavier than the whole budget must not
self-evict into a re-download loop) or pinned content (other tier). A fast estimated pass
runs first; if the estimate fell short (a subtracted blob survived GC because another folder
shares it), an accurate re-measured pass with the same ordering finishes the job. Blob GC is
tier-aware: a cache-tier twin of a blob whose pinned copy exists is collectible (a pinned
folder's weight doesn't haunt the cache budget), with the one-hour ingest grace throughout.
The **single-URL plane** (`dsx.content.file`) is capped independently against the same budget
and reclaimed by its own least-recently-used *pointer* eviction (deleting a URL→sha pointer
orphans its blob for the next GC; a pointer whose blob a folder also references is never touched
— its bytes belong to the folder plane). The two planes are accounted and swept separately so a
shared blob never ping-pongs between them and over-evicts — which means the aggregate cache-tier
ceiling is up to *2× `content.budget_mb`* when an app leans on both planes at once (most lean on
one). The files-plane sweep runs on every folder publish and, for a fetch-only app that never
publishes, every 16th successful fetch. Because a pinned-only app never trips the cache budget,
blob GC also runs on any publish that prunes an old generation, so the never-purged tier doesn't
accrete dead blobs across deploys.

**Web control plane is origin-restricted.** `despia.content.prefetch/status/pin/evict` accept
only the app's OWN host — the check is on the *resolved root* (after `path`+`origin` join), so
neither a foreign `origin` nor an absolute-URL `path` can point the store at another host (that
would be a credentialed SSRF + disk-fill). The web may **unpin** and **evict** its own cached
content but may NOT **pin** into the never-purged tier — that tier is outside budget eviction, so
web-driven pinning would be an unbounded disk-fill; what is offline-critical is the app's own
decision (a `content` `pinned` declaration or a native caller). The app's own offline bundle
can't be evicted or unpinned from here — the guard compares the *normalized* folder identity
(resolved root + manifest name), so no alternate spelling slips past it.

## Why the mechanism is KERNEL, the policy modules (the constitutional split)

`folder()` must answer synchronously, pre-bootstrap, on render paths and in boot gates —
a module-owned store would force an async bus hop or an untyped exported-handle cast with
bootstrap ordering. And content resolution is on the boot path: an *excludable* store would
let exclusion brick offline boot (Article 7). So the store sits beside `AppManifest` and
`RemoteBundleGate` — a primitive with no exclusion switch, no WebKit, no UIKit. What IS
policy stays in modules and degrades correctly when excluded: **ContentServer** serves the
materialized web tree over its loopback + the `cdn:` responder, owns the offline-boot gate
(`refresh` + `<SyncProgress/>`), the `asset.url` claim, and rebroadcasts `content.updated`
to the web as the `contentUpdated` bell; **Godot** keeps only its meta/boot policy
(~60 lines); prefetch scheduling and diagnostics surfaces are module work, on `dsx.content`.

## The `content` capability (bundled seeds)

A module ships a folder as a mount's generation zero — `dsx.json`
`"content": [{ "path": "Demo", "mount": "/demo", "manifest": "godot-manifest.json" }]`.
`prepare_modules` inlines the folder's manifest into `Registry/DSXContentSeeds.json`
(mounts unique across enabled packages; missing folder soft-skips); files ship as flat
bundle resources and resolve by basename; seed file hashes are part of the generation id,
so a rebuilt app IS a new generation — an old build's cache can never shadow new bundled
content. Full authoring guide: `OpenSource/Skills/module-content.md`.

Two bundled-floor extensions (`proposals/bundled-floor.md`, ACCEPTED): **the manifest is
optional** — a declared folder with no manifest file is AUTO-COMPILED at prepare time
(walk + per-file `sha256` + `entry` when an `index.html`/single `.html` exists;
deterministic, timestamp-free), so a static export dropped in the folder is a complete
seed; and **seeds reach the app's own boot folders** — `declaredSeed` admits an explicit
origin when it IS the app's own (`ContentDisk.isOwnPlane`, the `ownOrigin` seam each
ContentServer installs with its exact boot origin), so `mount: "/"` + the app's
`asset_json_path` manifest name is generation zero of the offline WEB BUNDLE: first
launch with no internet serves the bundled site (and the native screens it carries)
instead of holding the sync gate. A FOREIGN origin stays unseedable — a bundle must
never shadow another host's content.

## What was consolidated (and what deliberately was not)

Absorbed: `GodotContentCache` (dissolved — its SPA-poison guard and hash-less semantics
became kernel law), `DSXRemoteCache`'s private `.cache` tree (re-backed; signatures and
`stableHash` untouched — Routing's signed store keys by it), `FileDownloadManager` (deleted;
the web bundle is a content folder at the configured `asset_json_path`, byte-compatible
URLs, with the legacy `Documents/app` tree kept as a read-only fallback for old installs),
host resolution (the app plane resolves via `AppManifest.host(fallback:)`, the content plane
via `DSXContent.absolute` + content root).

**Absorbed in the 2026-07-28 follow-up wave** (both were listed here as optional/deferred):

- **`DSXImageCache`'s disk tier** → the single-URL plane. The private `Caches/dsx-images`
  tree and its own `URLSession` are gone; `<image src=…>` now reads
  `DSXContent.cachedFile` → `DSXContent.freshFile` (`cache="none"` ⇒ `freshFile` only), with
  the decoded-`UIImage` `NSCache` staying module-side because the plane has no opinion about
  decoded objects. This is what the Android `<image>` twin already did, so both natives share
  ONE store, one ladder and one budget, and an image the offline bundle already carries costs
  zero extra bytes. Two consequences ride along, pinned in the file headers: there is **no
  disk TTL** any more (last-known-good serves until LRU eviction; `cache="none"` is the
  revalidate-always escape hatch), and the ceiling is the plane's **4 MiB**
  `maximumControlBytes`, not the 16 MiB image bound.
- **DSXView folder-screens** → generations. A `<DSXView src="…/player/"/>` folder is exactly
  a content folder, and the manifest parser already accepts its shape (`assets:[String]` is
  one of the three file-list spellings; `root` rides in `raw`), so a screen resolves as ONE
  atomic generation before the per-file ladder: a warm screen opens with no network and
  revalidates behind the render, and a deploy mid-visit can never mix an old root with new
  components. Both named blockers are closed rather than worked around — the C2 per-asset
  hash gate rides along (every document is still `passesIntegrity`-checked against the URL it
  would have been fetched from), and the `asset.url` claim rides along because the store's own
  per-file chain asks the same claim with the same host-relative `/despia/…` key. The
  per-file ladder is unchanged and remains the floor: a folder the plane cannot carry whole
  (no generation yet and offline, a hash-less manifest under `bundle_signing`, a `root` the
  manifest doesn't list) loads exactly as before — Article 7, a fast path and never a new
  failure mode.

**Still not absorbed, on purpose**: `LocalCDN` (Documents-tier USER data — mutable, named,
never evicted: a different durability contract). Out of scope by decision: delta patching,
chunking, hot-swap-by-default, TUF (see the plan's non-goals; the research brief has the
evidence).
