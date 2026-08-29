# Offline, caching & UI state: best practices per surface

> Audience: app + module authors. The LAW lives in three architecture docs —
> [`content-plane.md`](../Documentation/architecture/content-plane.md) (the one store),
> [`bundled-floor.md`](../Documentation/architecture/proposals/bundled-floor.md) (what
> serves), [`source-plane.md`](../Documentation/architecture/proposals/source-plane.md)
> (what served). This skill is the PRACTICE: which primitive to reach for, per surface,
> and the UI patterns that make offline feel designed instead of broken.

## The model in three lines

```
1. Every surface boots from a versioned content folder.
2. "Bundled" is generation zero (a seed); "online" is newer generations arriving.
3. dsx.source.* tells you — reactively, in markup — which rung actually served.
```

The resolution ladder is the SAME everywhere: `newest synced generation → bundled seed →
legacy trees → network → the honest error`. Offline support = deciding which folders ship
a generation zero. Provenance = reading the slice, never guessing.

## Which primitive, when

| You want to… | Reach for | Never |
|---|---|---|
| cache host bytes (a folder of anything) | `dsx.content.prepare/folder` — declare, don't build | a bespoke disk cache (the Article-3 shim of caching) |
| ship content that must work on FIRST launch | a `content` SEED (`dsx.json`, folder in the package) | runtime "if offline load bundled X" branches |
| make the whole APP boot offline | the `"/"` seed (`mount: "/"` + your `asset_json_path`) | `file://` anything |
| a single remote file, cached | `dsx.content.cachedFile/freshFile` | URLSession + Documents by hand |
| show offline/floor/update UI states | `dsx.source.*` reads (reactive) | polling, reachability pings, hand-tracked flags |
| know if content is the shipped sample vs synced | `folder.servedFrom` / `source.content.serving` | comparing paths or timestamps |
| survive a cache purge for critical content | `pinned: true` on the declaration (or `prepare(pinned:)`) | copying files somewhere "safe" yourself |
| offline on the OPEN WEB | `registerOfflineFloor()` (`@despia/dom/offline`) | a hand-rolled service worker |

## DSXView (native screens)

**Floor.** `Config/routes.json` ships as the route-table floor automatically. Screen BYTES
need a carrier: list `routes.json` + your `despia/dsx/**` screens in the offline
manifest's `assets[]` (synced installs) and put the same files in the `"/"` seed (first
launch). The `asset.url` chain then serves them with the network off — `<DSXView/>` needs
zero code.

**Data.** `<api>` blocks and `await fetch` return ENVELOPES — render them, don't hide
them. The demo convention is the gold standard: a status line that walks
`'— tap to run' → '… calling x' → ok/error`:

```xml
<action as="load">
  const r = await fetch('https://api.example.com/feed');
  if (r.ok) { items = r.data; feedMsg = ''; }
  else { feedMsg = dsx.source.online ? ('error: ' + r.status) : 'offline — showing the last copy'; }
</action>
```

**Retry is the AUTHOR's, driven by state — never a queue.** Gate retries on the reactive
facts instead of timers:

```xml
<button label="Retry" visible-if="{{ !dsx.source.online }}" on:tap="load()"/>
```

**Cache host bytes through the store, always.** A screen that needs a content pack:
`dsx.content.folder("/pack")` on the render path (sync, last-known-good, NEVER a network
wait), `prepare` to warm, `refresh` ONLY for an update-before-proceed gate. Pin what must
survive an OS cache purge. Rich per-file provenance: `folder.servedFrom`.

## DSXWebView (the web surface inside the app)

**Floor.** Local-bundle apps get it from the sync + the `"/"` seed (first launch
included); remote-served apps get the mid-session offline floor the moment any `"/"`
folder exists (seed or synced) — a failed navigation serves it over the loopback
automatically. The legacy `local_html_switch` still works (it synthesizes the seed at
build time) — new apps declare a real static-export seed instead.

**The page's own state.** The web page reads the SAME provenance, no new channel:

```js
dsx.global.watch("source", (s) => {
  banner.hidden = s.online !== false;                    // the offline banner
  if (s.web && s.web.serving === "bundle") showFloorNote();
});
dsx.on("cdn", (e) => {
  if (e.name === "contentUpdated") promptReload();       // a fresh bundle is WAITING
});
```

**Update UX rule: the bell rings, YOU choose.** A new generation never swaps under the
running page — `contentUpdated` fires exactly once per pending generation; prompt a
reload (or reload silently at a safe moment). Don't poll `despia.content.status`.

**Don't double-cache.** The native store already holds the bundle verified and pinned; a
page-side service worker inside the app's web view adds a second source of truth that
fights the first. (On the OPEN web, the SW *is* the store — next section.)

## Despia Web (the browser renderer)

One call in the bootloader ships the whole floor:

```js
import { registerOfflineFloor } from "@despia/dom/offline";
void registerOfflineFloor();   // SW + manifest precache + dsx.source publishing; fail-open
```

The build emits `despia/local.json` (the same manifest dialect as every native seed) and
`dsx-sw.js` precaches it as one atomic, sha-verified, hash-named generation. Honest
semantics: the browser floor exists AFTER one online visit (the open web has no install
step) — design the first visit as online-required and everything after as guaranteed.
`{{ dsx.source.* }}` reads identically here; `content.updated` fires on the kernel bus
when the next generation is precached and waiting.

**SSR composes with the floor — export your routes.** Static routes exported as SSR
pages (`exportStatic` / the build's per-route export) ride the same generation, so an
offline navigation serves the ROUTE'S OWN server-painted page (correct markup + meta),
not the blank shell — and hydrates via deep-link boot. Choose the navigation strategy in
the MANIFEST, not in code:

```jsonc
// despia/local.json
{ "nav": "swr",        // precached SSR page serves instantly, revalidates behind
  "entry": "index.html", "assets": [ … ] }
// omit `nav` (or "network-first") when the origin must win whenever reachable —
// navigation preload keeps that path fast (the fetch races the worker's startup)
```

Rule of thumb: content sites and dashboards → `"swr"` (cache-speed paints, bell-driven
updates); apps where staleness is costly (pricing, auth walls) → default network-first.

**Dynamic routes (`/user/:id`) offline** — the document is free everywhere (native
mounts the component with extracted params; the watch now param-matches too; the web
serves the pattern's exported SKELETON page and hydrates the real URL). The DATA is the
author's design, and the portable recipe is derive-from-a-cached-collection:

```xml
<api as="users" url="/api/users"/>   <!-- the list, cached/last-known-good -->
<variable as="user" computed="true">
  return users.data ? users.data.find(u => u.id == route.params.id) : null
</variable>
<text visible-if="{{ !user && !dsx.source.online }}"
      value="This profile isn't available offline yet."/>
```

Design detail screens so their EMPTY state is presentable — on the web that exact state
IS the offline skeleton page. Declared per-call caching (`cache=` on `<api>`) is the
named next increment; don't hand-roll a store meanwhile.

## Watch + satellite nodes (Keyboard, Clip — anything with a `node` block)

**The bundled screens ARE the seed.** `BundledScreens/` + `routes.json` boot with no
phone and no network; OTA hydrates on top. Keep every bundled screen self-sufficient:
its head declares its variables, its actions guard their awaits.

**The offline contract is settle-now, never queue** (`watch-runtime.md`, adopted): a
cross-node call resolves capability table → link and returns a VALUE immediately —
`{ ok:false, error:"unreachable" }` (no phone) / `"unsupported_on_surface"` (not
declared). Render the envelope; retry off `dsx.link`:

```xml
<action as="ping">
  const r = await dsx.module.toast.show({ text: 'hi' });
  status = r.ok ? 'sent' : (r.error == 'unreachable' ? 'open your iPhone…' : '✗ ' + r.error);
</action>
<text size="10">{{ link.reachable ? '● iPhone linked' : '○ waiting for iPhone' }}</text>
```

- **Never hold an await open** waiting for connectivity, and never build a retry queue —
  state pushes are already queued last-write-wins by the transport; calls are the
  author's to re-issue when `link` says so.
- **Capability is declared, not probed**: a module opts in with `"reach": ["watch"]`;
  a bundled screen calling anything undeclared FAILS THE BUILD — trust the lint, skip
  runtime feature-detection.
- **UI that reaches the phone should say so** (the deferred-toast pattern: "sent — shows
  when the phone opens").

## UI-state recipes (all three renderers, same markup)

```xml
<!-- the offline banner — reactive, no polling -->
<stack visible-if="{{ !dsx.source.online }}" style="background: #3A2E00; padding: 0.5rem">
  <text value="You're offline — changes will sync when you're back." style="color: #FFD60A"/>
</stack>

<!-- the first-open floor notice: never reached the origin, showing the shipped version -->
<text visible-if="{{ dsx.source.web.state == 'never' && dsx.source.content.serving == 'bundle' }}"
      value="Showing the built-in version — connect once to get live content."/>

<!-- shipped sample vs synced content, per folder (rich UX without hand-tracking) -->
<text value="{{ dsx.source.content.serving == 'bundle' ? 'sample content' : 'synced' }}"/>
```

Prefer **skeletons over spinners** for content that has a last-known-good copy (the store
answers synchronously — there is almost always something to paint); reserve the spinner
for genuinely-first, genuinely-online moments (`<SyncProgress/>` is the shipped example).

## Anti-patterns (each has been deleted from this codebase — don't reintroduce them)

- A second byte-cache "for reliability" — ride `dsx.content`; provenance comes free.
- `file://` fallbacks — a different origin with no history routing and broken storage;
  the floor serves over the loopback (the retired `local_html_switch` branch).
- Polling `source.*` / reachability timers — it's reactive state; bind it.
- Queuing calls on a satellite — settle as values, retry off `dsx.link`/`source.online`.
- Hand-tracked "did I sync" flags — that's `source.<plane>.state` (persisted, per-origin).
- Hard-coding a surface fallback ("if web fails show native X") in code — declare it on
  the route (`offline` key, accepted design) or don't do it.

## The open primitives (the extensible declaration surface)

Every one of these is DYNAMIC: declared in a package's own `dsx.json`, typo-gated at
build, consumed by generic machinery — extending the system never edits a script or the
kernel. This is the constitution's add-the-primitive rule in practice.

| Primitive | Declares | Docs |
|---|---|---|
| `content` | a folder as a mount's generation zero (seed); `mount: "/"` = the app floor; manifest optional (auto-compiled) | [`module-content.md`](module-content.md) |
| `reach` | which satellite ROLES may invoke this module's actions (per-package or per-action) | [`manifest-dsl.md`](manifest-dsl.md) §Cross-node reach |
| `node` | "this package OWNS a satellite surface": role + bundled screens + capability-table paths | same section |
| `extensionTargets` | real Xcode targets (watch app, widgets, clips, keyboards) from a manifest | [`manifest-dsl.md`](manifest-dsl.md) §App extension targets |
| `build` | binary dependencies produced in CI from the module's own manifest | [`module-frameworks.md`](module-frameworks.md) |
| `weights` | hash-pinned model files fetched at build, never committed | [`module-weights.md`](module-weights.md) |
| `context` | typed cross-module state another module reads | [`module-state.md`](module-state.md) |
| `source.<plane>` | a provenance slice, published only by its owner via `dsx.source` | [`source-plane.md`](../Documentation/architecture/proposals/source-plane.md) |
| route `offline` | a DECLARED per-route offline alternative (accepted; parsing pending) | [`bundled-floor.md`](../Documentation/architecture/proposals/bundled-floor.md) §2b |

Rule of thumb: if you're about to write "if platform X do Y" in a script or the kernel,
stop — it wants to be a declaration in one of these (or a new primitive argued the same
way these were).
