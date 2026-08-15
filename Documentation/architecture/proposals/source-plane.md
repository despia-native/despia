# The source plane — `dsx.source` (ACCEPTED v1)

> Provenance as kernel state: has THIS INSTALL ever loaded each remote plane, what is on
> screen right now, and when — so "installed online, first opened offline" is a knowable,
> reactive condition instead of a guess. v1 wiring ships on iOS, Android and web; reader
> alias on all three renderers.

## The problem

An app has several independently-loaded remote artifacts — the **web surface** (the app's
origin in `<DSXWebView/>`), the OTA **route table**, remote **`.dsx` screens** (`<DSXView/>`),
and **content** folders (`dsx.content`). Each has its own offline fallback, so each can be
in a different state at the same moment. Nothing recorded whether an install had *ever*
reached the origin: a first-open-offline install rendered the bundled floor with no way to
say "connect once to finish setup", and no surface could distinguish *live* from *cached*
from *shipped*.

## The shape

One reserved namespace in the ONE reactive store — `source.*` — one slice per plane:

```
source.<plane> = { state:   never | stale | live      // ever loaded (persisted) / fresh this session
                   serving: origin | cache | bundle   // what is actually on screen right now
                   at:      ISO-8601 }                // last successful load/check
source.online  = true | false                          // kernel reachability, reactive
source.boot    = first | warm                          // first launch of this install
```

- **`never`** — this install has never successfully loaded the plane under the active
  origin. **`stale`** — loaded before, nothing fresh this session. **`live`** — the host
  answered this session. `state` is per-origin: the persisted first-load stamp is keyed by
  the active origin (the dev override's host during a switch), so a staging origin honestly
  starts at `never` — the same per-origin convention the content plane's keys use.
- Reads: markup `dsx.source.web.state` (JSE alias → `global.source.*`, all three renderers);
  page `despia.global.watch("source", …)` (a plain store slice — no new channel); native
  `dsx.source.state("web")` + the `source.changed` hook.

```xml
<Banner visible-if="dsx.source.web.state == 'never' && !dsx.source.online"
        text="Offline — showing the built-in experience. Connect once to finish setup."/>
```

## The ruling (why this shape is constitutional)

1. **Kernel vocabulary, not a module** (Article 1). `source.*` joins `nav`/`screen`/`dsx`
   as a reserved namespace: an alias for a state path that grants its maintainers nothing.
   The kernel primitive (`Engine/iOS/Source.swift`) is mechanism only — it names no module
   and no plane; "web"/"routes"/"content" are strings the owners bring.
2. **No aggregator module** (Article 3). The slices' natural owners already exist — Dom
   owns web-load truth, Routing owns OTA-table truth, the content plane owns byte truth —
   and each publishes ONLY its own slice through the `dsx.source` facade. A "Provenance"
   module collecting others' state would be the shim Article 3 bans; excludable ownership
   would let `never` lie on apps that load fine (Article 7 forbids a fail-open that lies).
3. **Caching stays ONE primitive.** `dsx.content` is the byte cache; this plane is the thin
   reporting face it feeds **automatically** (the store publishes at its cold-resolve,
   confirmed-fresh and generation-flip seams — including the previously-silent "checked the
   host, still current" moment). The rule for module authors: **cache host bytes through
   `dsx.content` and provenance is free**; a manual `dsx.source.publish` is only for planes
   that are deliberately not byte-caches — the live web surface (WebKit owns the load) and
   the trusted route table (state + signed sidecar behind `RemoteBundleGate`, a trust
   boundary that must not fold into the cache).
4. **The wire is names** (Article 8): `never|stale|live`, `origin|cache|bundle` — no
   platform type in the contract.
5. **Persistence**: first-load stamps live in `UserDefaults.standard` (durable without the
   App Group; Caches would purge and regress `stale` → `never`), keyed
   `dsx.source.<plane>.<originKey>`.

## v1 wiring (iOS)

| Plane | Owner | Seam |
|---|---|---|
| `web` | Dom | classify the finished main-frame URL in the existing `domFinish` hook — file:// = the LEGACY bundled-html floor (`bundle`; `local_html_switch` — the modern floor is a loopback-served seed, see §Composition), loopback = ContentServer serving locally (`cache` — deliberately coarse: synced generation OR the seed floor; the granular truth is `source.content`), the app's own host = `origin` → `live` + stamp; foreign hosts never touch the slice. Seeded `never|stale` at launch (`track`). |
| `routes` | kernel Router + Routing | Router publishes the PACKAGELESS bundled floor at boot (only while no OTA table is up); Routing publishes `cache` on a cached-table publish and `origin`/`live` when a fetch (plain or signature-verified) lands. |
| `view` | DSXView (Foundation) | at its E1 lifecycle seams: synced/offline copy = `cache`, a fresh integrity-passing fetch = `origin`/`live`. |
| `content` | the content plane itself | automatic at `resolveFresh` / confirmed-fresh revalidation / generation flip; `serving` = `bundle` for seed generations, else `cache`; network-sourced = `live`. `ContentFolder.servedFrom` exposes per-generation provenance to consumers. |
| `online`/`boot` | kernel (`DSXSource.seed`, from DSXBoot) | `NWPathMonitor` keeps `source.online` reactive; `boot` flips `first` → `warm` across launches. |

Android wires the SAME five rows to the same owners (`Dom.kt` · `Router.kt` · `ContentStore.kt`
· `DSXViewComponent.kt` · `:platform SourceBackend.kt`); see §Deferred for the two declared
divergences. Web wires `online`/`boot`/`web` through `@despia/dom/offline` + the service worker.

## Composition with the bundled floor (`bundled-floor.md`) — the two halves

The bundled floor decides **what serves** (the ladder: synced generation → bundled seed →
legacy → network → honest error); this plane reports **what served**. They meet with ZERO
glue code, by construction: a first-launch-offline boot resolves the web bundle's SEED —
a content generation — and the store's automatic `feedSource` seam publishes
`source.content = { state: "never", serving: "bundle" }` in the same motion. The moment
the first real sync lands, the same seam flips it to `live`/`cache`. Division of
granularity, on purpose:

- `source.web` (Dom) answers "did the ORIGIN serve this session?" — loopback is `cache`
  whether the local server is handing out a synced generation or the seed floor.
- `source.content` (automatic) + `ContentFolder.servedFrom` answer "is this the shipped
  floor or synced bytes?" — `serving: bundle` exactly when generation zero serves.

So "installed, first opened in airplane mode, showing the bundled site" reads as:
`source.boot == "first"` · `source.online == false` · `source.web.state == "never"` ·
`source.content.serving == "bundle"` — every clause from a different owner, no
aggregator, no polling. file:// as a web `bundle` classification survives only for the
legacy `local_html_switch` path until its prepare-time seed synthesis (bundled-floor C3)
retires it.

## Deferred (v2, documented)

- **Watch / widgets / keyboard**: the seams exist (`WatchStore.apply → .ready`, the App
  Group pushes) but the reactive store does not cross the process boundary yet — the plane
  extends there with the target-node work; until then a snapshot push can carry the flags
  in its vars.
- ~~**Android publishing twins**~~ — **LANDED 2026-07-29.** The READER alias always shipped
  on all three renderers (`dsx.source.*` → `global.source.*`, unit-pinned in the Kotlin
  `:core` suite); Android now publishes too, 1:1 with the iOS table above. Persistence +
  the kernel facts install from `:platform` `SourceBackend.install(context)` — ONE line in
  the bootloader's boot-bindings block, beside ContainerBackend/NetworkBackend: first-load
  stamps live in ONE app-private `dsx.source` SharedPreferences file (the
  `UserDefaults.standard` reading of rule 5 — neither the App Group container nor cacheDir,
  for exactly the reasons rule 5 gives), and a ConnectivityManager default-network callback
  keeps `source.online` reactive while `source.boot` flips `first` → `warm` off the same
  durable store. Publishers: `web` = Dom (`track` at `lifecycle.launch`, then the
  `surface.domFinish`
  classification), `routes` = the kernel Router's packageless bundled floor, `content` =
  ContentStore automatically at its four seams, `view` = DSXView cold-vs-warm on both the
  generation path and the per-file ladder. **Two declared divergences**, both recorded in
  `android-status.md`: (a) reachability is INJECTED, not kernel-owned — the Kotlin `:core`
  tier compiles SDK-free, so it holds no `NWPathMonitor` twin and instead takes
  `seed(online)` / `setOnline` from the host (a host that cannot observe reachability at all
  passes `null` and the fact stays ABSENT rather than guessed — Article 7); (b) the Routing
  module's Android facet does not yet publish, so `source.routes` reports the bundled floor
  and never upgrades to `cache`/`origin` on a phone. The JSE corpus entry rides the next
  `conformance-record` run (record-mode authors `expected`; hand-editing the corpus is banned
  by its README). **Web publishing LANDED** (`@despia/dom/offline`): `seedSource`
  publishes `source.online` (navigator + events) and `source.boot` (localStorage
  first|warm); the service-worker floor (`dsx-sw.js`, bundled-floor.md web wiring) feeds
  `source.web` per navigation (`origin`/`live` when the origin answered, `cache` +
  `stale|never` when the precached generation served) and rings `content.updated` on the
  kernel bus when a fresh generation is precached and waiting — the localStorage
  first-load stamps are the UserDefaults twin, per plane+host.
- **`theme` plane**: lands with the design-token proposal (runtime tenant re-skins publish
  `shipped | runtime` provenance).

## Anti-patterns

- Publishing another owner's plane (the namespace is reserved; write only yours).
- A second byte-cache "for provenance" — ride `dsx.content`.
- Polling `source.*` — it is reactive state; bind it (`visible-if`, `watch`, the
  `source.changed` hook).
