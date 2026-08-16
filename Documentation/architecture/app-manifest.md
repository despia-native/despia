# App.json + the dissolution of the central config

> Status: **App.json implemented** (kernel `AppManifest`, explicit legacy origins remain compatible; blank projects stay local) · **config dissolution:
> EXECUTED (2026-06-11)** — 14 groups moved into Mandatory owners' own `config.json`
> (Dom: 41 keys — webview/loading/links/dialogs/behavior + server identity trio ·
> ContentServer: 27 — local-server/storage/offline/zip · Splash: 5 (incl. biometric) ·
> Security: 4 · Routing/MenuBar/PullToRefresh) with three CONFIG-FIRST Mandatory stubs
> born (MenuBar, PullToRefresh, Security — the module boundary lands first, the feature
> code follows per the dissolution queue). `Host/Config.swift` was **deleted** (#790) — every
> config key now reads from generated `CoreConfig` (`ModuleConfig.generated.swift`) or its owning
> module's `config.json`, and `host`/`webviewurl` resolve through `AppManifest`. The last host-state
> file, `HostGlobals.swift`, dissolved into its modules + kernel `dsx.global` (#794) and its residual `UIColor(hex:)` helper became a kernel primitive
> (`OpenSource/Engine/iOS/Color.swift`) before the file was deleted, so the host now owns no app state.
>
> **ROOT-PLAN CORRECTION (2026-07-28).** This doc previously documented `entry.fallback` and an
> `EngineConfig` `defaults.view` render floor as live. Both are RETIRED grammar
> (`proposals/root-plan.md`): `entry.surfaces` is the required, ordered root plan, `fallback`
> aborts in `root_plan_schema.rb`, `defaults.view` is errored by `check_module_rules` rule 18b,
> and `AppManifest.defaultView` exists in neither native kernel. The `entry` chapter, the five
> copy-paste setups, the view contract, and the `EngineConfig` section are corrected here to the
> shipped reality.

## The identity statement

This is not a webview template anymore. It is a **web-optional native runtime**: modules do
everything the hardcoded template used to do, the kernel provides the primitives they consume
(fire/claim/configure/boot, the web-delegate relay, the registry), and configuration follows
ownership — **a module's knobs live with the module**. What remains app-global is exactly
one thing: *who this app is*. That's `App.json`.

## App.json — the app-identity manifest

`App.json` ships in the app bundle (per-app pipeline; see `ClosedSource/App.example.json`). It is
deliberately tiny — **identity, not behavior**:

```json
{
  "name": "My App",
  "identifiers": { "ios": "com.example.myapp" },
  "host": "myapp.com",
  "hosts": { "de": "de.myapp.com", "fr-CA": "ca.myapp.fr", "JP": "jp.myapp.com" }
}
```

- **`name`** (optional): the in-app display name, read as `dsx.app.name`. Omit it and
  `dsx.app.name` falls back to the bundle's `CFBundleDisplayName` (the build-time `APP_NAME`),
  so existing apps are unaffected. It does **not** set the home-screen label (that's
  `CFBundleDisplayName`, baked at build) — keep the two in sync unless you mean them to differ.
- **`identifiers.ios`**: the iOS bundle id. The build reads it (`jq`) and stamps
  `PRODUCT_BUNDLE_IDENTIFIER`, replacing the retired `Deploy/config.json` `bundle_id`. (The other
  former deploy keys — `app_version`, `development_team`, `simulator_build`, `signing_url` — are
  now Codemagic build-trigger env vars, not identity; see `OpenSource/Documentation/guides/codemagic-build.md` §4.)
- Bare domains (no scheme, no `www.`) — same convention as `server.host` today.
- **Per-locale hosts**: resolution ladder, first match wins (keys matched
  case-insensitively) — device language tag (`fr-CA`) → bare language (`fr`) →
  device region (`JP`) → `host` → the legacy Dom config.
- **The resolved host drives what loads**: `AppManifest.startURL` is the single
  launch-URL authority — Dom's `webview_url` is the base (path/query preserved)
  and the resolved host is swapped in, so `host` and the loaded URL can never
  diverge. Empty/malformed config degrades to `https://<host>` when a host exists;
  if no source names any origin, the committed starter `App.json` routes to the
  code-signed `DSXStartup.dsx` component. That screen is rendered by the native
  DSX engine on both platforms; no WKWebView/WebView is constructed and no
  network request is made.
- **Dev-origin override (test installs only).** A second, sibling seam —
  `AppManifest.devOriginSource` (nil by default) — lets the optional `Core/DevSettings`
  package point the whole host plane (launch URL, deep-link mapping, content plane, route
  table) at a staging **origin** (scheme+host+port) on non-production installs. The kernel
  double-gates it on `AppEnvironment.isProduction` (fail-closed detection), so the seam is
  inert on an App Store install even if filled. Precedence: dev override → dynamic host
  source → App.json ladder → legacy Dom config. See
  `OpenSource/Documentation/guides/staging-and-testing.md`.
- **Runtime refresh — one manifest, one shape.** App.json itself optionally
  carries `refresh_url`: a URL serving the **same** `{ host, hosts }` shape as a
  live copy. There is no second config surface — the refresh source lives next
  to the hosts it refreshes. The kernel only *surfaces* it
  (`AppManifest.refreshURL`, app-provided data — no hardcoded URL) and exposes an
  EMPTY override seam, `dynamicHostSource: (() -> (hosts:, defaultHost:)?)?` (nil
  by default). `resolvedHost()` runs its SAME locale ladder over the dynamic
  source FIRST, then falls through to bundled App.json. The optional
  `Core/RemoteHosts` module reads `refresh_url`, fetches/caches, and fills the
  seam — so a client migrates domains without an App Store rebuild. No
  `refresh_url` (or module excluded) ⇒ seam stays nil ⇒ today's behavior exactly.
- **Backward-aware safe default**: no file / empty / malformed preserves an explicitly
  configured legacy Dom origin byte-for-byte. The committed legacy origin is empty, so a
  blank framework build stays on the bundled native DSX starter instead of silently contacting
  a vendor website. Existing clients with their own legacy origin remain unchanged.
- **Routing match semantics** live here too (`AppManifest.isHost(_:within:)`,
  `AppManifest.list(_:contains:)`): comparisons are case-insensitive with `www.`
  ignored; same-site accepts true subdomains on a dot boundary (`blog.myapp.com`
  yes, `evilmyapp.com` no); list entries take `*.domain` wildcards.
- Implementation: `OpenSource/Engine/iOS/AppManifest.swift` (kernel config plane); the `host`
  identity (formerly the `Config.swift` `host` global) resolves through it, so every consumer — boot, sync,
  deep-link mapping, DSXWebView's default origin — inherits locale-aware hosts with no call-site
  changes.
- Read accessors: modules read identity via **`dsx.app`** (`dsx.app.host` — the resolved
  per-locale host; `dsx.app.name` — the display name, from App.json `name` (else the bundle's `CFBundleDisplayName`)); DSX markup reads the **`dsx.app.*`** namespace
  (seeded into `global.app` at boot). The blessed read path — no module touches `AppManifest` /
  `Bundle` directly — and Android-portable by name.
- Layering rule (unchanged): **static identity lives in the config plane; dynamic URL
  decisions stay claims** (`web.startURL`, `web.mapURL`). Never mix the two.

## App.json `entry` — where the app starts (native routing + OTA)

`entry` declares the app's **root plan** and its route table. It is identity-adjacent (it
answers *where this app starts*), so it lives in App.json and is parsed by the kernel
(`AppManifest.entry`).

**`entry.surfaces` is REQUIRED and there is no engine default** (`proposals/root-plan.md`).
The kernel ships no web floor: omitting the plan is a prepare-time abort, not a silent boot
into `DSXWebView`. The repository's unstamped framework template declares
`"surfaces": ["DSXStartup"]`, so opening a fresh build shows a native DSX configuration
screen instead of creating an origin-less WebView; generated apps replace that plan with an
explicit `DSXWebView`, `DSXView`, or component plan.

```jsonc
"entry": {
  "root": "/",                       // launch path — resolved against the route table; default "/"
  "ota": "/manifest.json",                       // OTA route-table SOURCE (a manifest — see below). Omit → web-only
  "surfaces": ["DSXWebView", "DSXWebUnavailable"]    // THE ROOT PLAN — ordered candidates (root-plan.md)
}
```

- **`root`** (default `"/"`) — **the entry path: the page the app opens on.** At launch the
  Router seeds `route.path` from `root` (`Router.swift`), resolves it, and renders the result;
  for a web app that means `DSXWebView` loads `host + root` — so `"root": "/app"` opens at
  `https://<host>/app`. `"/"` is the one value that defers to the host's own configured start
  URL (`webview_url`).
- **`ota`** (optional) — the route-table source. **It points at a manifest, not the table
  itself** (see *The OTA two-file flow*).
- **`surfaces`** (REQUIRED) — **the ordered ROOT PLAN**
  (`architecture/proposals/root-plan.md`): array order is priority; a candidate is `"View"`
  shorthand or `{ view, config?, timeoutMs?, id? }` (`config` rides the mount verbatim as
  component attributes; `timeoutMs` defaults to 15000; ids derive from the view). Each
  candidate races frame settle vs a root-attributed error vs its deadline; **failure always
  advances** (there is deliberately no policy key) and an exhausted plan shows the kernel
  boot diagnostic. Any component in the build is a legal candidate — the prepare validator
  aborts unknown names with a closest-match fix-it. View-less route rows follow the plan's
  **boot winner**. `fallback` is RETIRED grammar and aborts at prepare.

> **The splash composes in FRONT of this.** The entry surface is the app's *start screen*; a launch
> **splash** is an optional lego ahead of it (and the Splash module's two-phase splash — instant
> UIKit frame, then a dynamic DSX `<Splash/>`). "splash → `DSXWebView`", "start → `DSXView`", "no splash →
> straight to the entry", and the two-phase splash + its knobs are documented in
> **`boot-tier.md` → "The entry-legos model"** and **"The two-phase splash"**. The splash is optional
> (`splash.present_splash = false` → this entry surface mounts directly, no splash).

### Common setups

A quick map, then copy-paste starting points (simplest first). `host` plus an
`entry.surfaces` plan is the required pair (the framework starter ships
`["DSXStartup"]`; the pipeline writes the web plan for a configured app).

| You want | Set |
|---|---|
| Web app, opens at the start URL | `entry.surfaces: ["DSXWebView"]` |
| Web app, opens at `host + /path` | `entry.root: "/path"` + the web plan |
| Web app on a different host | `surfaces: [{ "view": "DSXWebView", "config": { "origin": "…" } }]` |
| A native screen instead of the web view | `surfaces: [{ "view": "DSXView", "config": { "src": "…" } }]` |
| Web app with a native offline screen behind it | `surfaces: [{ "view": "DSXWebView", "timeoutMs": 15000 }, "DSXWebUnavailable"]` |
| Native for some paths, web for the rest | `entry.ota` (a route table) |

> **`fallback` is RETIRED grammar** — it aborts at prepare (`root_plan_schema.rb`). Read any
> old `"fallback": { "view": X, "src": S, "origin": O }` you meet in a legacy App.json as
> `"surfaces": [{ "view": X, "config": { "src": S, "origin": O } }]` (root-plan.md).

**1 · Plain web app — opens at the start URL:**

```json
{ "name": "My App", "identifiers": { "ios": "com.example.myapp" }, "host": "myapp.com",
  "entry": { "root": "/", "surfaces": ["DSXWebView"] } }
```

Boots the web view at `https://myapp.com` (host + the Dom `webview_url` base). `root` defaults
to `/`, and `/` is the value that defers to that configured start URL. The plan is not
optional — there is no engine default to fall back to.

**2 · Web app that starts at a specific path** — set `root`:

```json
{ "host": "myapp.com",
  "entry": { "root": "/app", "surfaces": ["DSXWebView"] } }
```

Boots the web view at **`https://myapp.com/app`** — a non-`/` `root` makes `DSXWebView` load
`host + root`.

**3 · Web app on a different host** — set the candidate's `config.origin`:

```json
{ "host": "myapp.com",
  "entry": { "root": "/",
             "surfaces": [{ "view": "DSXWebView", "config": { "origin": "https://shop.myapp.com" } }] } }
```

Boots at `https://shop.myapp.com`. Use `origin`, never `src` — `DSXWebView` ignores `src`.

**4 · A native screen as the entry** — make the candidate a `DSXView`:

```json
{ "host": "myapp.com",
  "entry": { "root": "/",
             "surfaces": [{ "view": "DSXView", "config": { "src": "/dsx/home/" } }] } }
```

Renders the native DSX screen at `/dsx/home/` instead of the web view — here `src` is the
template path (the one place `src` is read).

**5 · OTA routes — native for some paths, web for the rest** — add `ota`:

```json
{ "host": "myapp.com",
  "entry": { "root": "/", "ota": "/manifest.json", "surfaces": ["DSXWebView"] } }
```

The Routing module fetches the table (see *The OTA two-file flow*); a matched path renders its
`view`, everything else follows the plan's boot winner. Changing a route is a deploy, not a
rebuild.

### The view contract (the root plan *and* every route)

A resolved route — and every root-plan candidate — is a renderer **`view`** plus attributes.
The two built-in views read **different** fields:

| `view` | Renders | Uses `src`? | URL / source |
|---|---|---|---|
| `DSXWebView` | the app's one shared **web view** | **no** | `(origin ‖ host) + path`; bare `/` defers to the host's own start URL (`webview_url`) |
| `DSXView` | a **native DSX screen** | **yes** | `src` is the DSX template path (bundled or OTA), e.g. `/dsx/offline/` |
| *any component tag* | that component | per the component | — |

> **A `view`-less route row follows the plan's BOOT WINNER** — the root-plan candidate that
> actually settled at launch (root-plan.md). There is no engine-level default component and no
> `EngineConfig` render floor; the kernel names no surface. Because `DSXWebView` ignores `src`,
> a row that sets a `src` for a **native** screen must set `view: "DSXView"` explicitly.

The easy-to-miss rule: **`DSXWebView` ignores `src`.** The web view's page comes from the
**`path`** (the route you navigated to; `root` at boot) — *not* from a `src`, and a root-plan
candidate has **no `path` field** at all. So:

```jsonc
"surfaces": ["DSXWebView"]                                                   // web at your host's "/" — nothing else needed
"surfaces": [{ "view": "DSXWebView", "config": { "origin": "https://x.io" } }] // web pinned to a DIFFERENT host (origin, not src)
"surfaces": [{ "view": "DSXView", "config": { "src": "/dsx/offline/" } }]      // a native offline screen — here src IS the path
```

`{ "view": "DSXWebView", "config": { "src": "/" } }` is a no-op: `src` is unread for the web
view, and `/` is already the default `path`. The web app owns its own routing — there is
deliberately no way to pin the web surface to a fixed page.

### The OTA two-file flow

`entry.ota` is **not** the route table — it is the path to your deploy **manifest** (the same
offline-first asset manifest the content layer already syncs). The kernel finds the table
*inside* it:

1. `ota` → resolved to `https://<host> + ota` and fetched (offline-first via the asset cache).
2. That JSON is a **manifest** — an object with an **`assets`** array. The Routing module
   picks the asset whose path ends in **`routes.json`**.
3. *That* asset is fetched — the **route table** (a JSON array).

```jsonc
// 1. App.json
"entry": { "ota": "/manifest.json", … }

// 2. /manifest.json  — the deploy manifest (what `ota` points at)
{ "deployed_at": "2026-06-18T10:00:00Z",
  "assets": ["/routes.json", "/dsx/shop/index.dsx", "/dsx/offline/index.dsx"] }

// 3. /routes.json  — the route table (the `*routes.json` asset listed above)
[ { "path": "/",          "view": "DSXWebView" },
  { "path": "/shop/{id}", "view": "DSXView", "src": "/dsx/shop/", "requires": ["payments"] },
  { "path": "/offline",   "view": "DSXView", "src": "/dsx/offline/" } ]
```

> **Why two files** — the route table is just another asset on the deploy manifest, so a route
> change ships through the **same OTA pipeline as everything else** (cache-first, atomic
> deploy) — a deploy, not an App Store rebuild. Pointing `ota` straight at a route-table array
> does **not** work: the kernel reads `ota` as a manifest and looks for `assets[]`, finds none,
> and ends up with no table (silently falling back to the web view).

### The route table (`routes.json`)

A JSON **array** of route objects. First match wins; the query string round-trips.

| Field | Required | Meaning |
|---|---|---|
| `path` | ✓ | match pattern — exact, `{param}` / `:param` (named → `route.params.*` / `dsx.params.*`), `*`, `/*` (`DSXPathMatch`) |
| `view` | — | renderer tag; omitted ⇒ the root plan's **boot winner**. `DSXView` for a native screen, or any shipped component |
| `src` | — | for `DSXView`, the DSX template path; **ignored by `DSXWebView`** |
| `requires` | — | capability gate: a `[String]` of module schemes that must **all** ship in this binary |
| `origin` | — | per-route host override (web) |

- **Capability gate (`requires`)** — if a matched route needs a module the build excluded,
  the Router **skips it**, broadcasts `route_unavailable` (`{ path, missing, reason }` — web:
  `despia.on("route", e => e.event === "route_unavailable")`), and keeps resolving — ultimately
  landing on the root plan's boot winner. So an over-broad table degrades gracefully on a
  stripped-down build.
- **Query** — `?ref=x` on the requested path is parsed (percent-decoded strings) into
  `route.query.*` / `dsx.query.*`.
- **Offline-first** — on launch the cached table loads instantly and renders, then a network
  refresh replaces it (and re-resolves the live screen). `route://reload` forces a refetch.
  No `entry.ota` (or the Routing module excluded) ⇒ the whole mechanism is dormant.

Implementation: the kernel `Router` (`OpenSource/Engine/iOS/Router.swift` — resolution + the nav
stack) + the `Routing` Mandatory module (`ClosedSource/DSX/Modules/Mandatory/Routing/Routing.swift`
— the OTA fetch). The table lives in `global.routes`; `root`/`ota`/`surfaces` are
`AppManifest.entry`.

### There is no engine render floor (`EngineConfig.json`)

**The `EngineConfig` `defaults.view` key is RETIRED and the kernel names no surface**
(`proposals/root-plan.md`; constitution Article 1). The renderer for a screen that names no
`view` is the **root plan's boot winner** — the `entry.surfaces` candidate that actually
settled at launch — and nothing else. `AppManifest.defaultView` is gone from both native
kernels, `OpenSource/Engine/EngineConfig.json` carries no `defaults` block, and
`check_module_rules` rule 18b errors if the key regrows. There is no "irreducible web floor";
a build that ships no plan is a prepare-time abort, which is the point — a white-label build
declares its own `entry.surfaces` rather than inheriting a default nobody chose.

`EngineConfig.json` survives for genuinely kernel-level platform config only. Today that is
one block:

```jsonc
// OpenSource/Engine/EngineConfig.json — kept tiny; engine-level defaults only (nested to grow)
{ "content": { "budget_mb": 300, "max_blob_mb": 240 } }   // the dsx.content store's caps
```

> **Keep `EngineConfig.json` tiny.** Only irreducibly *engine-level* platform config belongs here —
> and a render floor is explicitly NOT one of them. Feature/behaviour config lives in each module's
> own `config.json`; surface selection lives in App.json's `entry.surfaces`. Don't let this file
> grow back into the central config the dissolution removed.

## The dissolution: every `Config/config.json` group → its owner

`prepare_config.rb` already scans **Mandatory** alongside Core/Custom, so any module can own
a `config.json` today (generated `<Package>Config` + the typed `config` accessor). The
central file shrinks to nothing as each group moves to the module that consumes it:

| Group (keys) | Owner |
|---|---|
| `server.host`, `webview_url` | **App.json** (identity) |
| `server.local_*`, `only_use_local_server` · `storage.*` · `offline.*` · `zip.*` | **ContentServer** |
| `server.runtime_identifier` · `webview.*` (18) · `loading.*` · `links.*` · `dialogs.*` · `behavior.auto_inject_variable` | **Dom** (the web surface + its `web.*` claimants) |
| `appearance.*` (status-bar colors) | **StatusBar** module |
| `navigation.*` (footer, sidebar) | **MenuBar** (queue row 7) |
| `splash.*` | **Splash** *(pilot)* |
| `routing.*` | **Routing** *(pilot)* |
| `pull_to_refresh.*` | **PullToRefresh** (queue row 3) |
| `first_run.*` | **LocalPush** (it owns the permission ask) |
| `rate_app.*` | a **RateApp** module |
| `image_downloader.*` | **FileSharing** |
| `security.*` | split by capability: biometric → Splash v2 · jailbreak → SecurityCheck · certs → the `web.authChallenge` claimant · capture → ScreenCapture · ATT → Tracking |
| `behavior.audio_mix_with_others` / `vision_kit_enable` | Audio / Vision modules |
| `app_icons.*` | an AppIcon module |
| `translation_language1/2.*` (2×18) | **not config at all** — these are the `dsx.global.strings` platform table (`white-label.md`); migrate to `global.strings` locale layers |
| `license.purchase_code` | **KEPT** (2026-06-23) — the constitutional `LicenseCheck` Mandatory module's config (fail-open kill-switch). `facebook_friends.*` was **removed** the same day (the Engagement follow-on-Facebook prompt). |

### Migration recipe (per group — each its own small PR)

1. Add the group's keys to the owning module's `config.json` (same `{ value, _note }` shape).
2. `prepare_config.rb` → the module gets a typed `config.<key>` accessor.
3. Move consumers: in-module reads use `config.<key>`; host reads disappear as the
   feature itself is extracted (the dissolution queue) — a group whose host consumer
   hasn't moved yet keeps a temporary `CoreConfig` mirror until its slice lands.
4. Delete the group from the central file. The central file's end state: **deleted**, with
   App.json as the only app-global input.

**Pilot (next PR):** `splash.*` → `Mandatory/Splash/config.json` and `routing.*` →
`Mandatory/Routing/config.json` — both consumers are already in-module, so no host
mirrors are needed and the recipe is exercised end-to-end.
