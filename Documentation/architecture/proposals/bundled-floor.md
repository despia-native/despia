# The bundled floor — first launch, zero internet, every surface renders

> Status: **ACCEPTED v1 — core LANDED** (2026-07-17). Companion to `content-plane.md`
> (landed) and `watch-runtime.md` (adopted). Nothing here invents a new offline system —
> the whole design is: **the boot source of every surface becomes a seeded content
> folder**, the primitive the content plane already ships. One principle, three wirings,
> one legacy mapping. No new runtime machinery on the happy path.
>
> **The naming decision (review):** there is NO new namespace (`dsx.offline` /
> `dsx.cache`) and NO per-node "offline packages" — a second name for the same store is
> exactly the fourteen-year debt this replaces. The `content` capability IS the offline
> primitive; a node's `screens` folder IS its seed; every extension is a declaration, not
> a kernel edit.
>
> **The other half:** `source-plane.md` (`dsx.source`, ACCEPTED v1 — landed in the same
> tree). The floor decides WHAT serves; the source plane reports WHAT SERVED — and they
> compose with zero glue: a seed-served boot publishes
> `source.content = { state: "never", serving: "bundle" }` automatically through the
> store's own `feedSource` seam, so "first open, offline, on the floor" is readable
> state (`dsx.source.*` in markup, all three renderers). See that doc's §Composition.
>
> **Landed (v1):** the own-plane seed guard on BOTH kernels (`ContentDisk.isOwnPlane` +
> the `ownOrigin` seam Swift/Kotlin, installed by each ContentServer with the exact boot
> origin — a declared seed for `/` + the app's manifest name now resolves on a cold
> offline first launch, and `prepare`'s existing `network ?? seed` order publishes
> generation zero, so the gate advances with no boot-gate edits); mount `/` made
> declarable in both prepare scripts; AUTO-COMPILED seed manifests in both prepare
> scripts (folder with no manifest → walk + sha256 + entry, deterministic); the
> `/offline-demo` live proof (an auto-compiled seed in the Demo package); the Kotlin
> `:core` test `bootFolderSeedResolvesOnTheAppsOwnOriginOnly` (own origin admits, foreign
> origin refused, cold offline prepare publishes gen zero — 765/765 green).
> **C3 LANDED — the legacy switch retired onto the floor:** the runtime `file://` /
> asset-space branches are GONE (both platforms). `local_html_switch` is now a BUILD-time
> input only: prepare synthesizes a hash-less `"/"` seed (`entry: index.html`) when no
> explicit one is declared, and the offline-navigation path is declaration-driven — a
> failed mid-session navigation ON THE APP'S OWN PLANE (its host or the loopback)
> resolves the web-bundle folder (newest synced generation, else the seed) and serves it
> over the LOOPBACK; a FOREIGN origin failing (an in-surface SSO/payment page) keeps the
> old stay-put + localized-alert contract — the floor never re-navigates the live page
> over another origin's failure; no folder at all → the alert, unchanged. Same UX, one
> ladder, one origin. **Remaining:** the route-table `offline` key — declared, not yet
> parsed.

## The scenario this closes

The App Store (or the Watch app gallery) downloads the app. The user opens it for the
first time **with no internet — ever**. Nothing was cached, no sync ran, no OTA arrived.

Today, per surface:

| Surface | First-launch-offline today | Why |
|---|---|---|
| **Watch app** | ✅ renders — bundled screens | `BundledScreens/` + `routes.json` are the floor; OTA hydrates later |
| **Native routes** (`<DSXView/>`) | ⚠️ route table resolves, **screen bytes don't** | `Config/routes.json` ships as the route floor (`AppManifest.bundledRoutesText`), but the `.dsx` documents come from the offline bundle / network — neither exists yet |
| **Web surface** (`<DSXWebView/>`, local-bundle apps) | ❌ **the gate holds** | ContentServer's boot gate: *"a cold start with no network and no prior sync shows the error + Retry and does NOT resolve"* |
| **Web surface** (remote-served apps) | ❌ error page → legacy patch | `local_html_switch` ("fall back to bundled HTML when offline") — the 14-year-old patch, a parallel path outside the content plane |

The watch got this right by construction. This proposal makes its shape the LAW for the
other surfaces — using the mechanism that already exists.

## The principle (one sentence)

**Every surface boots from a content folder; "bundled" is generation ZERO of that same
folder; hydration is generations advancing.** There is no "bundled mode" vs "cached mode"
vs "online mode" — there is one resolution ladder, and the bundle is simply its floor:

```
current generation (CAS, verified)      ← what a synced install serves
  → bundled SEED (generation zero)      ← what a first-launch-offline install serves
    → legacy trees (read-only)          ← pre-kernel installs (Documents/app, local html)
      → network (fetch, verify, ingest) ← cold + online: sync behind the skeleton
        → the honest unavailable state  ← only when ALL of the above are absent
```

This ladder is not new — it is the content plane's **existing** per-file resolution chain
("CAS blob → bundled seed → `asset.url` claim → network") read at boot-folder granularity.
The seed primitive is not new either — the `content` capability ships module folders as
generation zero today (Demo's `/scene3d-demo` is live). What is missing is exactly one
thing: **the three BOOT folders don't declare seeds yet.**

## The three wirings

### 1. The app web bundle — a seed for `/`

The offline web bundle already IS a kernel content folder (path `/` on the app host,
manifest = the configured `asset_json_path`). The wiring: let the app declare a **static
export of the site as that folder's seed**, via the SAME `content` capability — the app
plane (Config / `Mandatory/App`) rather than a feature module:

```jsonc
// the app plane (per-app Config, same place the web host lives)
"content": [{
  "path": "Config/Offline",            // a folder in the app package: index.html, app.js, …
  "mount": "/",                        // the web-bundle folder identity
  "manifest": "despia/local.json"      // = asset_json_path (identity must match the boot gate's)
}]
```

Boot-gate change (the ONE behavioral edit): on a cold start, `folder("/")` resolves
generation zero from the seed **before** the gate decides to hold. Seed present → the gate
advances, the loopback serves the bundled site, `<SyncProgress/>` never appears; the first
online launch revalidates and publishes generation 1 **atomically over it** (SWR — the
mid-session `contentUpdated` bell already handles "a fresh bundle is waiting"). Seed absent
→ today's behavior, unchanged (error + Retry is CORRECT when there is truly nothing).

Because the seed rides the same folder identity, everything downstream is inherited free:
pinning, signing (a seed is bundle-trusted by definition — same trust tier as the binary),
generation ids (seed hashes are part of the id, so a rebuilt app IS a new generation and an
old install's cache can never shadow new bundled content), eviction protection, the
`despia.content.*` guard rails.

**Served over the loopback, NEVER `file://`** (review decision). The seed generation is
materialized and handed to the SAME local server every synced generation uses
(`ServerManager.baseURL` = `http://localhost:<port>`), so the page gets a real HTTP
origin: history/SPA routing, `fetch`, storage, and cookies behave, and the origin is
STABLE across seed → synced generations (no storage/session cliff when the first sync
lands). `file://` is ruled out by law — no history routing, broken storage semantics,
crippled fetch. (Service-worker caches, where an app uses them, sit a layer above this
ladder and are never required for the floor to work — the floor is the content store.)

**The seed folder is compiled, not hand-bookkept** (review decision). The `manifest` key
becomes OPTIONAL for seeds: when absent, `prepare_modules` GENERATES the manifest from the
folder — walks it, hashes every file (`sha256`), sets `entry` to `index.html` (or the one
`.html` present), and inlines the result into `DSXContentSeeds.json` exactly as a
hand-written one. Authors drop a static export in the folder and are done; any exporter
works (the Despia web compiler's static build, Vite/Next export, plain files). A
hand-written manifest stays supported for the cases that need control (custom entry,
excluding files).

### 2. Native routes — the seed carries the screens

No new mechanism at all. The route TABLE floor already ships (`Config/routes.json` →
`AppManifest.bundledRoutesText`). The screen BYTES ride the same seed as §1: the offline
manifest's `assets[]` already documents including `routes.json` + `despia/dsx/**.dsx` — put
those files in the seed folder and the existing `asset.url` claim + per-file chain
("CAS → **bundled seed** → …") serves native screens with the network off, first launch
included. `<DSXView/>` needs zero changes; ContentServer's claim needs zero changes.

### 2b. Which surface owns a route — no races, no framework opinion

The question "the user has the static web app AND wants an offline native route — who
wins?" has no race, because surface selection and source resolution are TWO separate,
deterministic steps that already exist:

1. **The route table is the ONE authority for the surface.** `routes.json` (bundled floor
   → OTA table wins when published): an entry with `component` mounts the named NATIVE
   screen; an entry without is a WEB path served by the web bundle. This is today's law —
   the seed adds nothing and changes nothing here.
2. **The chosen surface resolves its SOURCE through its own ladder.** Web path → the web
   bundle's ladder (synced generation → seed → legacy → unavailable). Native component →
   the screen-bytes ladder (same folder, same generations).
3. **No mixing mid-flight**: the route table, the site, and the native screens ride the
   SAME folder, and a visit pins ONE generation for its lifetime (content-plane law) — so
   a half-updated install can never serve a new table against old screens or vice versa.

**There is NO implicit cross-surface fallback** — the framework never silently swaps a
web route for a native screen (or back) because content is missing; that would be an
opinion. If an author WANTS a per-route offline alternative, they DECLARE it on the route:

```jsonc
{ "path": "/checkout",                       // normally the web app
  "offline": { "component": "shop.OfflineCheckout" } }   // used ONLY when the web
                                             // source ladder bottoms out at unavailable
```

`offline` is a route-table key like `guard`/`redirect`/`meta` — declared, corpus-pinnable,
surface-symmetric (a native route may declare an `offline` web path just the same). No
declaration = the surface's honest unavailable state, exactly as today.

### 2c. The web renderer — the same floor via a service worker (LANDED)

Despia Web has no app binary, so its "bundle" is the ORIGIN itself — the floor is the
service worker's precache, built from the SAME manifest dialect as every native seed:

- **One dialect everywhere**: the build emits `despia/local.json` (`{ entry,
  assets:[{path, sha256}] }`) via `offlineManifestText` (`@despia-native/server`) — the ruby
  auto-compiler's TS twin, deterministic, timestamp-free. The same file that would drive
  a native install's offline sync drives the browser's floor.
- **`dsx-sw.js`** precaches it as ONE atomic generation (cache name = the manifest
  bytes' hash — same manifest IS same generation): every asset fetched and sha-verified
  before the generation exists; any failure abandons the partial cache (all-or-nothing,
  the store's law). Assets serve cache-first (sha-pinned = immutable, the CAS rule);
  navigations go network-first and fall back to the cached entry offline; after a served
  navigation the manifest revalidates in the background and a changed one precaches the
  NEXT generation + rings `content.updated` — served on the next visit, never swapped
  under the running page.
- **`@despia-native/dom/offline`** is the page half: `registerOfflineFloor()` (one call in the
  bootloader, fail-open without SW support), `seedSource` (`source.online`/`source.boot`),
  and the worker's provenance messages feeding `source.web` — so `{{ dsx.source.* }}`
  reads identically on all three renderers.

**The SSR composition (LANDED).** SSR and the floor are one system, not two features:
the build exports every STATIC route as a full SSR'd page (`<path>/index.html`, the
`exportStatic` convention — server paint with the route's own markup + meta, hydrated by
the same bootloader via deep-link boot), and those pages ride the SAME offline
generation. The worker then serves navigations smartly:

- **Per-route offline first paint**: an offline navigation matches the route's own
  cached SSR page (`path/index.html` → `path.html` → the entry, in that order) — the
  user gets the real screen, not the blank shell.
- **Navigation preload** is enabled: network-first navigations run the fetch WHILE the
  worker boots (no SW-startup tax on the fresh path).
- **The strategy is a DECLARATION, not code** — the manifest's `nav` key:
  `"network-first"` (default: the origin is truth when reachable) or `"swr"` (the
  precached SSR page serves instantly — repeat visits paint at cache speed online and
  offline alike — while the manifest revalidates behind it and a changed generation
  rings `content.updated`). Native manifest parsers ignore the key; one dialect holds.

**Renewal-while-online is guaranteed, four ways (the aggressive-SW antidotes).** A user
who is online can never be stuck on a stale generation: (1) the worker SCRIPT never
rides the HTTP cache (`updateViaCache: "none"` + `registration.update()` on load and on
every `online` event — the classic stuck-worker failure is structurally closed); (2)
every full navigation revalidates the manifest (`cache: "no-cache"`, so the origin is
consulted) and precaches a changed generation as pending; (3) a LONG-LIVED SPA SESSION —
no full navigations — still renews: the page half pings the worker (`revalidate`) after
registration and on every `online` event, and the `content.updated` bell tells the app a
new generation is waiting; (4) API responses are never runtime-cached by the worker AT
ALL — a generation contains only manifest-listed assets, so "stale API data stuck in the
SW" cannot exist by construction (api caching is the kernel's declared `cache=`
increment, with its own revalidation, never the worker's).

The NATIVE twins were reviewed against the same bar and were already clean: the web
bundle applies waiting deploys BEFORE boot (`refresh`, update-before-boot), revalidates
mid-session on a throttled `web.didLoad` pass, rings the same bell, and heals purge
holes; native `<api>` blocks fetch live when online (no cache today — nothing to go
stale); the content plane is SWR + atomic by construction.

Semantic difference, stated honestly: a BROWSER floor exists only after one online visit
(the web has no install step to bake bytes into) — "first visit ever, offline" remains
impossible on the open web; what the floor guarantees is every visit after the first.
Inside the native app the same site gets the true first-launch floor from the §1 seed —
the two compose: same manifest, two carriers.

### 2d. Dynamic routes (`/user/:id`) — the param floor (LANDED)

A dynamic route can't be exported per value — `/user/321` and `/user/321000` are the same
DOCUMENT with different DATA. The two halves separate cleanly, and the framework's
existing split (route table → surface → bytes → data) already carries them:

**The DOCUMENT half — per platform:**

- **Native (iOS/Android)**: already complete, by construction. The route table (bundled
  floor + OTA) declares `/user/:id`; the kernel Router matches with `DSXPathMatch`
  (corpus-pinned), extracts `id`, mounts the `component` with params → vars. The
  component's `.dsx` bytes ride the ordinary ladder. There is no per-value document on
  native — the component IS the document.
- **Watch**: `WatchRouter` now matches through the SAME `DSXPathMatch` (it was always in
  the target via the `logic` tier) — exact match wins, then fewest-params, then `*` —
  and merges extracted params INTO THE SCREEN VARS. `/user/321` on the wrist, offline,
  renders the declared `/user/:id` screen with `id == "321"`.
- **Web**: one SSR SKELETON PAGE per declared pattern. The build exports the route's
  component with EMPTY params (its own loading/empty state — UI every screen needs
  anyway) at a deterministic path (`/user/:id` → `user/__param__/index.html`) and
  DECLARES the mapping in the offline manifest:

  ```jsonc
  "routes": [{ "pattern": "/user/:id", "page": "user/__param__/index.html" }]
  ```

  The worker — which must stay route-table-blind — matches an offline navigation against
  the DECLARED patterns (a `DSXPathMatch` twin: literals · `:name`/`{name}` · trailing
  `*`; most-specific wins) and serves the pattern's page before falling back to the
  shell. Hydration deep-link-boots the REAL URL, the client router extracts params, and
  the screen fills. Catch-alls export no skeleton (no meaningful one exists).

  **Skeletons are OFFLINE-ONLY, by law.** Online, a dynamic page must reach the ORIGIN —
  only the server can render its DATA. The worker enforces this structurally: the `swr`
  fast path serves FULL cached pages only (a static route's own export); the
  pattern-skeleton and shell rungs exist solely on the network-failure path. A skeleton
  can never shadow a live server render.

  **The SEO truth (reviewed, honest).** Crawlers do not run service workers — SEO is
  decided by WHAT THE ORIGIN SERVES, and nothing in the floor changes it in either
  direction. Static routes: the exported pages ARE full SSR documents (title, meta, og:,
  body markup) — real SEO today. Dynamic routes: SSR v0 deliberately renders `<api>`
  envelopes in their seeded state (`render.ts`: "ssr-aware `<api>` is W6"), so a
  dynamic page's DATA reaches crawlers only once **live SSR (W6)** lands — the async
  render pass that executes the page's api blocks server-side (the kernel api runner is
  DOM-free and Node-clean; the seam is an awaited resolve of `ir.head.apis` before
  paint) and streams the resolved document. Until W6, dynamic routes are client-rendered
  for crawlers — a pre-existing v0 boundary this floor neither caused nor hides.

**The DATA half — the same answer on every platform:**

1. **Works today**: derive the record from a CACHED COLLECTION. A list endpoint cached
   through the content plane (or held in state) + a computed variable keyed by the param:

   ```xml
   <api as="users" url="/api/users"/>
   <variable as="user" computed="true">
     return users.data ? users.data.find(u => u.id == route.params.id) : null
   </variable>
   ```

   Offline, `users` serves from its last-known-good copy and the detail page derives.
2. **The named next increment — `cache` on `<api>` blocks** (corpus-gated, all three
   renderers + the watch fetch seam, per the unified-codebase law): a DECLARED
   cacheability — `<api as="user" url="/api/users/{{ route.params.id }}" cache="swr"/>`
   — serving last-known-good per resolved URL through the ONE store (iOS/Android: the
   `dsx.content` single-URL plane, which already exists; web: the kernel api runner over
   Cache Storage; watch: a small last-known-good file cache behind the effects seam),
   revalidating behind, envelope gaining `source: "cache"|"origin"`. Declared, not
   hand-rolled — the caching anti-pattern rule stands.

### 3. The watch — already the law; name it

`BundledScreens/` + `routes.json` + the OTA manifest is exactly seed + SWR, wrist-side.
No behavior change. Alignment (later, optional): the wrist's screen cache becomes a small
twin of the store so its resolution ladder is spelled identically (`cache → bundled →
link`), and the `node` block's `screens` folder is documented as *the node's seed*. A
keyboard/clip node inherits the same answer by declaration.

## The legacy mapping (compat kept, paths deleted)

The precedent is `FileDownloadManager`: delete the mechanism, keep the contract,
byte-compatible behavior.

- **`local_html_switch`** ("fall back to bundled HTML when offline") — DONE (C3): the
  runtime branches are deleted on both platforms (iOS loaded bundle `index.html` over
  `file://`; Android loaded it from the asset space). The switch is a BUILD-time input
  now: both prepare scripts synthesize a hash-less `"/"` seed (`{ entry: "index.html",
  assets: ["index.html"] }`) when it is on and no explicit `"/"` seed exists; the
  offline-navigation path resolves the folder like any other floor and serves it over
  the loopback. SCOPE, honestly: the synthesized seed serves the html DOCUMENT — the
  common self-contained page is 1:1. The old `file://` load also granted read access to
  the html's whole containing directory, so a page with sibling files (`offline.css`,
  `logo.png`) rendered them; the loopback serves only the generation, so a MULTI-FILE
  offline page migrates to the modern path: declare a real `"/"` content seed folder
  (auto-manifested — drop the files in, prepare walks + hashes them), which always wins
  over the synthesis. The key stays valid forever; new apps declare a full
  static-export seed.
- **`Documents/app`** (retired download manager's tree) — stays the read-only fallback it
  already is, one rung below the seed. Pre-kernel installs keep booting.
- **`onlyUseLocalServer`** apps — unchanged flow, minus the brick: the gate consults the
  seed before holding.

Result: the legacy contracts survive on the one ladder (one documented scope note:
multi-file offline pages migrate to a declared seed folder), zero parallel runtime
paths added; the patches become *inputs* to the one primitive instead of siblings of it.

## What this is NOT (non-goals)

- Not a second offline system — no new store, no new manifest dialect, no new config
  concept beyond "the boot folders may declare the seed every other folder already can".
- Not hot-swap or delta patching (content-plane non-goals stand).
- Not a change to trust: seeds are bundle-tier (they shipped inside the signed binary);
  network generations keep the existing signing gate.
- Not a guarantee that every app HAS a floor — an app that declares no seed and has never
  synced still gets the honest error + Retry. The floor is opt-in authoring, like the
  watch's bundled screens.

## Implementation increments

- **C1** — seed registry accepts app-plane declarations for the web-bundle identity
  (mount `/` + configured manifest name); `generate` step validates the identity matches
  `asset_json_path`. (prepare_modules + DSXContentSeeds.json; no kernel change if the
  store's seed lookup already keys mount+manifest — audit says it does.)
- **C2** — boot gate: consult the resolved folder (which now finds gen zero) before
  holding; pin on first publish as today. (~15 lines in ContentServer's `runFirstSync`.)
- **C3** — `local_html_switch` → synthesized seed at prepare time; mark the runtime
  branch legacy-dormant.
- **C4** — docs: content-plane.md gains §The bundled floor; manifest-dsl.md cross-links;
  the demo ships a tiny seed so the scenario is walkable in TestFlight (airplane mode,
  fresh install).

Each increment is independently shippable; C1+C2 alone close the headline scenario.
