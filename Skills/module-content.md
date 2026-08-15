# `content` — bundled content folders (dsx.json) and the `dsx.content` primitive

The kernel owns ONE content plane: `dsx.content` (`OpenSource/Engine/iOS/Content.swift`).
App-authored content ships as **folders** — a manifest listing files (with optional
per-file `sha256`) plus the files — hosted on the app's own web host under the
**content root** (App.json `hosting.content_root`, default `/dsx`), and resolved by
the kernel into local, verified, deduplicated bytes:

```swift
let folder = try await dsx.content.prepare("/runner")     // resolve + freshen (SWR)
let live   = dsx.content.folder("/runner")                // SYNC last-known-good — render-safe
folder.data("index.dsx")     folder.url("game.pck")
try folder.materialize()                                   // real directory tree (APFS clones)
```

Freshness is **stale-while-revalidate at folder granularity**: an open is instant
from the last-known-good generation; a changed folder downloads in the background,
publishes atomically, applies on the NEXT open, and announces itself as the
`content.updated` kernel event. A declared `sha256` is both integrity and the
change detector; a hash-less file refreshes network-first during revalidation.
With App.json `bundle_signing`, hosted content manifests must carry a detached
signature (`X-DSX-Signature` header or `<manifest>.sig` sidecar) — an unverified
update is refused while the last good generation keeps serving.

## The `content` manifest key — seed a mount from the app bundle

A package can ship a content folder INSIDE the app so a mount works with zero
hosting (a demo, an offline floor):

```jsonc
// dsx.json
"content": [
  { "path": "Demo",                       // package-relative folder
    "mount": "/demo",                     // the content path it seeds
    "manifest": "godot-manifest.json",    // optional; default "manifest.json"
    "pinned": false }                     // optional: publish into the never-purged tier
]
```

What happens at build (prepare_modules, section 12):

- The folder's manifest is validated and **inlined** into the generated
  `Registry/DSXContentSeeds.json` (mount + manifest name → manifest text +
  pinned flag). The manifest file is build INPUT — it does not need to ship.
- The folder's other files ship as ordinary **flat** bundle resources through the
  synchronized group (the same way every package resource ships). The kernel's
  seed resolver finds them by **basename**, so basenames must be app-unique
  (prepare_modules warns on collisions) and must not match the build-input
  globs that are excluded from the bundle (`manifest.json`, `config.json`,
  `*.md`, `Components/**/*.dsx`, …) — name a shipping manifest something like
  `godot-manifest.json` if it must also ship.
- Mounts are unique across enabled packages (build error otherwise). Excluding
  the package removes its seeds — file-presence is the gate, as always.
- A folder missing on disk **soft-skips** with a warning: content produced later
  in CI (a `build`-block artifact like the Godot demo pack) still ships as a
  flat resource and resolves at runtime.
- **No manifest file? It is AUTO-COMPILED** (`bundled-floor.md`): the folder is
  walked and hashed (`sha256` per file; `entry` = `index.html` when present,
  else a single `.html`), deterministically — drop a static export in the
  folder and the declaration is complete. Author a manifest only when you need
  control (custom entry, excluding files). The Demo package's `/offline-demo`
  seed is the live example.
- **`mount: "/"` seeds the app's offline WEB BUNDLE** (the bundled floor): pair
  it with the app's `asset_json_path` manifest name and a first launch with no
  internet serves the bundled site — plus any `routes.json` / `.dsx` screens
  the folder carries — instead of holding the sync gate. Seeds resolve only on
  the app's OWN plane (content-root mounts + the app's own host origin); a
  foreign origin is never seedable.

At runtime, the kernel consults the seeds index whenever a folder is resolved
with **no explicit origin** (an explicit origin is an explicit location) and no
usable hosted manifest exists — the seed keys on "no USABLE manifest", never on
"no response", so an SPA catch-all's 200-with-HTML can never defeat it. A hosted
manifest that parses always wins on the next open. Seed files are referenced
**zero-copy** (the blobmap points at the app bundle), and their hashes are part
of the generation id — so a rebuilt app IS a new generation and an old build's
cache can never shadow new bundled content.

`pinned: true` publishes the folder into the never-purged tier (Application
Support, excluded from backup) — for offline-critical content that must survive
an OS cache purge.

## Update discipline (hosting a folder)

- Put the folder under `<content_root>` on the app host: `/dsx/runner/manifest.json`
  plus the files it lists.
- Pin a `sha256` per file in production: matching bytes are reused untouched
  (instant, offline); ship an update by changing the sha. Blob URLs may be served
  with `Cache-Control: max-age=31536000, immutable`; the manifest itself should
  revalidate (`max-age=0` + ETag).
- The worked example: the Godot package (`ClosedSource/DSX/Modules/Core/Godot` —
  `content` block + `GodotContent.swift`, a ~60-line consumer) and its hosted
  twin `ClosedSource/Codemagic/Example/Godot/demo/`.

Related: `module-weights.md` (hash-pinned BINARY blobs fetched at build time —
use `weights` for a model file a package bundles, `content` for a FOLDER the
content plane serves), `cross-module-calls.md`, `architecture/asset-plane.md`.
