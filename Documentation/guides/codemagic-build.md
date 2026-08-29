# Building an iOS app: Codemagic & the `iOS/` assets folder

> **Scope.** This guide documents Despia's managed build pipeline, part of
> [Despia Cloud](https://despia.com), the commercial layer. It ships in the open tree for
> transparency: the contract is public even though running the pipeline is not. Building
> and shipping web apps, PWAs, backends, and CLI tools needs none of this; see the
> [quickstart](quickstart.md). Every `scripts/…` and `release/…` path below is a file in
> the pipeline's own private tree, named so the contract can be read — not something to
> run from this drop.

This repo is the **framework** (the native shell + the DSX engine + every module).
Your **app** is a small overlay folder — `iOS/` at the root of your assets zip —
that the build pipeline drops on top. You never edit Swift or the project: you ship
a folder, the pipeline produces a signed IPA. This guide is the complete contract
for that folder.

> One-line model: **the repo is the runtime; `iOS/` is your app.** Identity comes
> from `App.json` + Codemagic env vars; behavior comes from **modules** (`excluded.json` +
> `core_packages.json` + `Custom/`); content comes from the Dom module's `index.html` /
> `custom.js` (overridden under `Packages/Dom/`).

---

## 1. How a build runs (the Codemagic flow)

```
trigger ─▶ Codemagic checks out this repo (build branch)
        ─▶ HTTPS-downloads a bounded assets zip  ($CLIENT_ASSEST_URL)
        ─▶ verifies opt-in independent SHA-256 ($CLIENT_ASSETS_SHA256, when supplied)
        ─▶ validates every ZIP path/type/size, then privately stages only consumed assets
        ─▶ applies the staged iOS/ inputs (legacy wrapped ios_assets/ is auto-detected)
        ─▶ ruby scripts/prepare_modules.rb   (modules → pods/SPM/plist/targets + codegen)
        ─▶ pod install → xcodebuild → signed .ipa
        ─▶ verifies the exported IPA + writes private local status/attestation artifacts
        ─▶ stops before store publishing; an isolated release controller performs handoff
```

The pipeline is defined in [`codemagic.yaml`](../../../codemagic.yaml). It reads **two**
kinds of input:

1. **Build variables** — `settings.env` (below) plus signing secrets, either configured
   on the Codemagic side (`APP_STORE_CONNECT_*`, `CERTIFICATE_PRIVATE_KEY`) or fetched
   from your CDN at build time (`signing_url` + `SIGNING_TOKEN` — §4b). These name the
   app and sign it; they never name a *feature*.
2. **The `iOS/` overlay** — every file in §2. App content + per-app module config.

Nothing about *which features ship* lives in `codemagic.yaml` or `settings.env` — that is
entirely `excluded.json` + the module manifests. The pipeline is feature-agnostic.

---

## 2. The `iOS/` folder — the complete map

Your assets zip contains one folder at its root — `iOS/`:

```
<CLIENT_ASSETS_FOLDER>.zip
└── iOS/
    ├── App.json                       ← app identity + web host (REQUIRED)
    ├── excluded.json                  ← module on/off           (recommended)
    ├── core_packages.json             ← per-app module config   (recommended)
    ├── marketing.png                  ← the ONE app icon        (recommended)
    ├── launch.png                     ← the OS launch brand image (optional)
    │
    ├── Packages/                      ← per-app overrides for built-in modules (optional)
    │   ├── Firebase/GoogleService-Info.plist
    │   ├── Dom/index.html
    │   ├── Dom/custom.js
    │   ├── Splash/splash.gif
    │   └── Sounds/ios_sounds/*.wav
    │
    ├── Custom/<PackageName>/…         ← your own NEW modules     (optional)
    └── settings.env                   ← LEGACY identity         (legacy)
```

(The build auto-detects the assets root: `iOS/` at the zip root is canonical;
legacy zips with `<CLIENT_ASSETS_FOLDER>/ios_assets/` — or a bare `ios_assets/`
— keep building unchanged. A remote build may additionally supply
`CLIENT_ASSETS_SHA256`, independently of the signed URL, to pin the ZIP
byte-exactly (recommended; absent → the unpinned legacy intake, with a build-log
WARNING); the URL and redirects must remain HTTPS.)

Where each item lands and what it does:

| `iOS/…` | Req? | Purpose | Lands at |
|---|:---:|---|---|
| `App.json` | ✅ | App **identity**: display name (`name`), bundle id (`identifiers.ios`), web host (+ per-locale) — §4/§5 | repo root `App.json` (bundled) |
| `excluded.json` | ◻️ | Turn modules **on/off** — §6 | `DSX/Modules/Config/excluded.json` |
| `core_packages.json` | ◻️ | Per-app **config** for every built-in module — §6 | fanned into each module's `config.json` |
| `marketing.png` | ◻️ | One 1024² icon → **every** size generated — §7 | `Assets/Icons/marketing.png` |
| `launch.png` | ◻️ | Brand image for the **OS launch storyboard** (also `.jpg`/`.jpeg`/`.pdf`; iOS only — Android's boot frame is the Splash package: `Packages/Splash/splash.gif` + Splash config). Omit it and the launch ladder continues: Splash `logo` imageset → background-only | `Assets/Launch/launch.<ext>` (rung 2 of `generate_launch_screen.rb`) |
| `Packages/<Name>/…` | ◻️ | Per-app **file overrides** for a built-in module (the module owns it) — §6d | the named module's folder |
| `Custom/<Name>/` | ◻️ | Your **own new modules** (with their own UI) — §6 | `DSX/Modules/Custom/` |
| `settings.env` | 🕰 | Legacy identity/build fallback (kept working) | parsed as non-executable data; only `APP_NAME`, `APP_VERSION`, `BUNDLE_ID`, `DEVELOPMENT_TEAM`, and `SIMULATOR_BUILD` are exported |

The `Packages/<Name>/` overrides (and their committed defaults) — **Firebase**
`GoogleService-Info.plist`, **Dom** `index.html`/`custom.js`, **Splash**
`splash.gif`, **Sounds** `ios_sounds/*.wav`. Omit one and the module's
committed default ships. (Legacy bundles that drop these at the `ios_assets/`
root still work — see §6d.) Home-screen quick actions are **not** a file — they're
the `QuickActions.legacy_shortcuts` config value (`core_packages.json`).

✅ = required. ◻️ = optional; omit it and the committed default in the owning
module is kept (a one-file bundle still builds a working app). 🕰 = legacy —
old bundles keep building unchanged; new bundles shouldn't ship it.

> **There is no `iOS/Info.plist`.** The app's Info.plist is **generated
> from the modules** (identity skeleton + every enabled module's `infoPlist`,
> at `DSX/Modules/Mandatory/App/Info.plist`). Per-app plist values travel as
> module config — `core_packages.json` → `{ "App": { "url_schemes": ["myapp"] } }`,
> `{ "AdMob": { "gad_app_id": "…" } }`, `{ "Pushwoosh": { "api_token": "…" } }` —
> and any extra key (or a different usage string) is one `infoPlist` entry in a
> `Custom/` module, which overrides built-ins on conflict. A legacy bundle that
> still ships `Info.plist` is ignored, except its URL scheme, which is honored
> as a fallback when `App.url_schemes` isn't configured.

---

## 3. The minimal build

**One file.** Every other input has a committed default in its owning module:

```
iOS/
└── App.json               { "name": "My App", "identifiers": { "ios": "com.acme.myapp" } }
```

No folders, no nesting — one flat JSON at the bundle root is a complete build
input. That ships the full framework with its default modules, pointed at the
build-time default host. Everything below is how you make it *yours*.

---

## 4. Identity — `App.json` + Codemagic env vars

App identity splits cleanly in two. (`Deploy/config.json` is **retired** — its
keys moved here.)

**In `App.json` (ships in the zip)** — what the app *is*: display name, iOS
bundle id, web host(s). The build reads them with `jq` and stamps the bundle id /
`CFBundleDisplayName`; `name`/`host` also seed `dsx.app.*` at runtime.

```jsonc
// iOS/App.json — identity only
{
  "name": "My App",
  "version": "1.0.0",                     // marketing version (agvtool input)
  "identifiers": { "ios": "com.acme.myapp" },
  "host": "myapp.com",
  "hosts": { "de": "de.myapp.com" }       // optional per-locale, §5
}
```

**On the build trigger (Codemagic env vars)** — the trigger carries only what
identifies the BUILD REQUEST, never the app:

| env var | purpose |
|---|---|
| `SIMULATOR_BUILD` | `true` for a simulator build (default `false`) |
| `SIGNING_URL` (+ `SIGNING_TOKEN`) | CDN signing delivery (§4b) — carries the whole signing identity, incl. the Apple team (`team_id`) |
| `APP_VERSION` | 🕰 legacy fallback — `App.json` `version` wins when present |
| `DEVELOPMENT_TEAM` | 🕰 legacy fallback — the signing payload's `team_id` wins when present |

`APP_NAME` / `BUNDLE_ID` / the version are derived from `App.json`, and the team
from the signing payload — you don't set any of them on the trigger. The legacy
`settings.env` still works as a fallback for old bundles, but it is never sourced
or printed. The authenticated intake accepts only `APP_NAME`, `APP_VERSION`,
`BUNDLE_ID`, `DEVELOPMENT_TEAM`, and `SIMULATOR_BUILD` as `KEY="value"` data.
Signing URLs, tokens, credentials, and arbitrary environment keys are ignored;
`App.json` and the signing payload remain authoritative.

**Everything else is a module**, not an identity key:

- **iPad support** → enable the `TabletSupport` module (remove it from your
  `excluded.json`); it owns `TARGETED_DEVICE_FAMILY` and excluding it restores
  iPhone-only.
- **Universal links / web credentials** → `core_packages.json` →
  `{ "App": { "associated_domains": ["applinks:myapp.com", "webcredentials:myapp.com"] } }`.
- **App Clip / widget identity** → their modules:
  `{ "AppClip": { "url": "myapp.com" }, "Widgets": { "name": "My Widget", "description": "Today's picks" } }`.
- **Development language** defaults to `en`; per-app overrides will ship as a
  Language module. (The `settings.env` `ENABLE_IPAD`/`DEVELOPMENT_LANGUAGE`/
  `APPLINKS_URL`/`WEBCREDENTIALS_URL` keys are retired — nothing reads them;
  module config is the only route.)

### 4b. Signing material — secure CDN delivery (optional)

> This same channel also carries any opted-in module's OWN CI credentials — see
> "Other build secrets" below. Nothing about it is
> signing-specific; it's the one dynamic, per-client build-secrets fetch this
> repo uses so 50k+ apps never need a secret hand-configured in Codemagic's UI.

Signing secrets — `APP_STORE_CONNECT_KEY_IDENTIFIER`, `APP_STORE_CONNECT_ISSUER_ID`,
`APP_STORE_CONNECT_PRIVATE_KEY` (the `.p8`), `CERTIFICATE_PRIVATE_KEY` (the
distribution-cert PEM) — are **never files in the zip**. They reach the build one
of two ways:

1. **Application-scoped Codemagic Secret groups** (the current default) —
   `dsx_ios_release_credentials` for IPA qualification,
   `dsx_ios_profile_check_credentials` for the least-privilege profile audit, and
   `dsx_android_release_credentials` for Android qualification. Do not put durable
   credentials in API trigger variables.
2. **Fetched from your CDN at build time** — set the `SIGNING_URL` env var on the
   build trigger and pass a `SIGNING_TOKEN` variable alongside it.

The fetch path remains disabled until the trusted release branch pins the exact
broker and signed-object hosts in the pipeline's `release/signing-network-hosts.json`.
Wildcards and trigger-provided host allowlists are not accepted, so an API variable
cannot redirect the genuine Bearer token to an attacker-controlled HTTPS endpoint.

The CDN path splits the secret across two trigger fields, so neither alone is enough:
the trusted release controller supplies the endpoint URL separately from the
short-lived token (rotate or expire it per build on your edge). Neither value is
accepted from the client-assets zip. The
`Fetch Signing Material` step GETs the URL with the token in the
**`Authorization: Bearer` header only** — never in the URL/query, so it can
never land in your edge/CDN access logs. Your endpoint must read the header:

```
GET {signing_url}
Authorization: Bearer {SIGNING_TOKEN}
```

The response is one JSON object with **two keys** — `signing` (the purpose-scoped signing material) and
`secrets` (module secrets as **plain JSON**, no base64; next section) — **the only
accepted shape** (finalized in beta; the pre-envelope flat shape and its long aliases
are retired). Either key may be omitted (at least one non-empty), and within `signing`
complete purpose tuple works — partial, mixed-platform, duplicate-key, or unknown-field
payloads fail closed before any value reaches the environment:

```jsonc
{
  "signing": {
    "key_id":    "D9ABCD1234",                       // -> APP_STORE_CONNECT_KEY_IDENTIFIER
    "issuer_id": "57246542-96fe-1a63-…",             // -> APP_STORE_CONNECT_ISSUER_ID
    "team_id":   "U529RVRZ43",                       // -> DEVELOPMENT_TEAM (the Apple team rides the payload, not the trigger)
    "api_key":   "-----BEGIN PRIVATE KEY-----\nMIGT…\n-----END PRIVATE KEY-----",
                    // the ASC .p8 -> APP_STORE_CONNECT_PRIVATE_KEY. BOTH shapes accepted:
                    // the raw PEM STRING inline (what payloads carry today), or a signed
                    // https CDN URL to the file (the file rule — short-TTL hardening).
    "cert_key":  "-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----"
                    // -> CERTIFICATE_PRIVATE_KEY (the distribution cert's PRIVATE key — a
                    // secret). Same two shapes: inline PEM string or a signed https URL.
  },
  "secrets": {
    "acme.license_key": "…"                          // module secrets, plain JSON (see below)
  }
}
```

(Root-level fields outside `signing`/`secrets` are rejected; a payload with neither key
non-empty fails the build loudly. The read-only `ios-profile-check` purpose accepts the
four API/team fields and explicitly rejects `cert_key` and package secrets.)

**Android** (the `android-app` lane runs the same parser under a separate
`android-release` purpose; an Apple/Android mixed payload is rejected): `keystore`
(the release `.jks`/`.keystore` — an **https signed CDN URL** to the
raw binary, recommended; or inline base64 —
staged to a private 0600 temp file, **only the path** is exported as
`CM_KEYSTORE_PATH`), `keystore_password` → `CM_KEYSTORE_PASSWORD`, `key_alias` →
`CM_KEY_ALIAS`, `key_password` → `CM_KEY_PASSWORD` (omitted → the store password). These
are the env names `RuntimeAndroid/app/build.gradle.kts`'s release signingConfig reads; no
keystore delivered → the production workflow fails before producing artifacts. Same rules as the Apple fields: Bearer-only fetch, names-only
logging, and all four are stripped from the module-secrets payload.

Store publishing is intentionally outside these artifact-qualification workflows.
`play_credentials`, API-selected Play tracks, and automatic TestFlight uploads are
rejected/disabled here; an isolated release controller must bind the verified artifact
digest and signer to an approved app/track, expiry, and one-use nonce.

Step and final status are local-only: `run_step.sh` writes mode-`0600` `app_log.json`
and `event_log.json` with sanitized status fields. It never POSTs a webhook, embeds an
artifact URL, or copies raw command output into those JSON files. The read-only
`ios-app-check` lane exposes only `reformatted_profiles.json`; it does not send the
profile report to a callback.

**OTA route-manifest key:** when this opt-in feature is enabled, provide
`BUNDLE_SIGNING_PRIVATE_KEY` only as an inline Secret in the application-scoped
Codemagic credential group, with optional `BUNDLE_SIGNING_ALG` and
`BUNDLE_SIGNING_KID`. `BUNDLE_SIGNING_PRIVATE_KEY_URL` is rejected; the qualification
worker never retrieves this private key from a URL.

#### Other build secrets — any module's own CI credential (Mapbox, or anything else)

The payload's **`secrets` object** feeds `scripts/deliver_module_secrets.rb` (the
*Deliver Module Secrets* step, right after this one) — plain JSON, handed over verbatim. It's a fully generic,
manifest-driven extension: a package declares a `secrets` block in its OWN `dsx.json`
naming exactly which fields it needs and how to deliver them (a private per-package
`0600` file it reads itself, an env var, or a `~/.netrc` entry for an SDK that
authenticates installs via HTTP Basic Auth, e.g. Mapbox's private Podspec host). Nothing
here or in `fetch_signing_material.sh` names an SDK — the `signing` field names above
(`key_id`, `api_key`, …) are the only ones the script itself hardcodes; every field in
`secrets` is opaque to it and simply handed to whichever package's manifest
asked for it, under that package's own namespace.

Example: a package with scheme `acme` declares `acme.license_key` with `as: "file"`
(namespaced under its own scheme, so no OTHER package can claim it); the value lands
in a private `0600` JSON at `$DESPIA_SECRETS_ACME` its own build tooling reads and
deletes — the credential never touches the shared build env. Add the field to the
`secrets` object of the same endpoint your App Store signing keys already come from and
a client opts into that SDK — no separate secrets channel, nothing configured per-app in
Codemagic's dashboard. (No in-repo module currently needs one: the embedded engine is Godot,
MIT — no build credential at all.) Full contract, the three delivery shapes, and how
a module declares its own credential: `OpenSource/Skills/module-secrets.md`.

The two PEM fields (`api_key`, `cert_key`) and the Android `keystore` (fetched as raw binary) follow the rule
**a file-shaped value IS a signed URL**: these are the highest-value secrets in the
payload, so their recommended form is an `https` signed link — e.g. a short-lived signed
object-store URL (`api_key` as a 3600 s GCS signed URL); the inline forms (PEM text /
JSON / base64) are accepted too. The build downloads a URL with **no auth
header** (the link carries its own signature) and uses the response body as the PEM.
The TTL only has to outlive the few seconds between the endpoint's reply and this
download, so a short expiry is fine; the signed URL is itself a secret and is never
logged. Every endpoint must be a direct, publicly routed HTTPS URL: user-info,
fragments, private/literal loopback addresses, and redirects are refused. A
present-but-unfetchable URL **fails the attempt** (→ retry), never a silent skip.

**No key value ever appears in the build log.** The fetch atomically stages the
validated update into the builder-owned Codemagic environment file and prints
variable *names* only; on failure it reports the HTTP status without the endpoint,
token, URL, or response body. Responses and credentials are byte-bounded, private
keys/service-account documents are parsed before publication, and one-line fields
cannot inject new environment entries. Any failure (non-200, non-JSON, or a keyless payload)
is **retried after a 3-second wait, up to 3 attempts**, before the build fails;
credentials reach the environment only after a fully validated attempt, so a
retry can't double-write. A fetch that fails all three attempts **fails the
build loudly** rather than silently falling back to possibly-stale dashboard
keys. Empty `signing_url` = path 1, untouched.

### 4c. Extensions, App Groups & the capability-degrade rule

Modules that ship an **app-extension target** (the OneSignal notification
service, widgets, Live Activities, Watch, App Clip …) sign with their **own**
App IDs (`<your-bundle-id>.<suffix>`). The pipeline provisions them for you:
it registers any missing extension App ID, enables the App Groups capability
on it, and mints/downloads its App Store profile — all via the App Store
Connect API, twice per build so a first-time app converges in one run.

The **one thing Apple's API cannot do** is *associate* an App Group with an
App ID — that is portal-only, once per app per target:

> Apple Developer portal → Identifiers → `<your-bundle-id>.<suffix>` →
> App Groups → Configure → check `group.<your-bundle-id>.container` → Save.
> The next build picks it up automatically — no repo or config change.

Until that's done, **builds never fail over it** — the capability-degrade
rule: every target keeps its normal functionality for its bundle id (push
still arrives, the widget still renders), and only the shared-container App
Group is **omitted** from any target whose own profile can't sign it. Two
layers guarantee that: a per-target reconcile decides each entitlements file
from the *decoded* staged profiles (profile **names** are irrelevant — a
profile named "UNUSED - …" merely inherited its App ID's display name), and a
final *entitlements-vs-profile gate* right before the archive re-checks every
target against the actual `.mobileprovision` files, stripping anything they
can't sign and printing the exact portal step above. An archive can no longer
die with *"doesn't support the … App Group"*.

---

## 5. `App.json` — host identity

The **one** identity file an app sets: the web host, optionally per locale. Bare domains
— no `http(s)://`, no `www.`. See [`App.example.json`](../../../App.example.json).

```json
{
  "host": "myapp.com",
  "hosts": { "de": "de.myapp.com", "fr-CA": "ca.myapp.fr", "JP": "jp.myapp.com" }
}
```

Resolution per device (keys case-insensitive): language-tag (`fr-CA`) → bare language
(`fr`) → region (`JP`) → `host` → the build-time default. No file ⇒ the default host
(fail-open). **The resolved host drives the launch URL** — it's swapped into the
`Dom.webview_url` base (path/query kept), so one value steers a localized fleet.
Link routing matches hosts normalized (case-insensitive, `www.` ignored, subdomains
internal on a dot boundary), and the `Dom` routing lists (`safari_whitelist`,
`safari_blacklist`, `always/never_open_in_inapp_tab`) accept `*.domain` wildcards.
Everything that is *behavior* (status bar, pull-to-refresh, splash, links, push…)
is **module config**, not here.

---

## 6. Modules — the four levers

Everything the app *does* is modules. You have exactly four controls, all optional:

### a) `excluded.json` — turn built-ins on/off
A list of module names/schemes to **drop** (every module is on by default). Path globs
work; a required dependency overrides an exclusion. Mandatory modules can't be removed.

```json
{ "exclude": ["admob", "Core/Analytics/*"] }
```

### b) `core_packages.json` — configure built-ins
**One** file that sets per-app config for every built-in (Mandatory + Core) module,
keyed by module `id`, `name`, or `scheme`. It fans into each module's own `config.json`
(via `apply_core_config.rb`) — you don't ship 20 separate config files.

```json
{
  "App":          { "url_schemes": ["myapp", "myapp-link"] },
  "Dom":          { "webview_url": "https://myapp.com" },
  "Splash":       { "duration_ms": 1200 },
  "ContentServer":{ "cdn_base": "https://cdn.myapp.com" }
}
```

> **Keying — `id` is the canonical key.** Each module carries a stable UUID `id` in its `dsx.json`;
> `name`/`scheme` are the human label + the `dsx.module.<scheme>` API and may change, the `id` never
> does. A deployment platform should store config keyed by `id` (rename- and collision-proof); a
> hand-authored file can still use `name`/`scheme` (resolved as a fallback). The full machine-readable
> schema for every module — `id`, `name`, `scheme`, `icon`, `version`, and each config key's form
> metadata (`friendly_name`/`type`/`value`/…) — is generated into **`PackageCatalog.json`**
> (`scripts/generate_package_catalog.rb`): the source a config UI renders bulk-config forms from.

`App.url_schemes` is your deep-link scheme **list** (e.g. a `myapp` URL scheme): every entry
registers in the generated Info.plist, and the **first** is the primary scheme
wired into the native URL-scheme handlers. `App.associated_domains` does the
same for **universal links** — full entries like
`["applinks:myapp.com", "webcredentials:myapp.com"]` splice into the
associated-domains entitlement — this config is the only route (the `settings.env`
`APPLINKS_URL`/`WEBCREDENTIALS_URL` route is retired). Other plist-bound
values work the same way (`AdMob.gad_app_id`, `Pushwoosh.api_token`/`app_id`) —
including **every permission usage string**: each permission module exposes its
prompt text as config (e.g. `{ "Camera": { "usage_description": "…" } }`,
`{ "Location": { "usage_when_in_use": "…" } }`), so App Review wording is per-app
without shipping any plist.
Unknown module/key names are warned and skipped, so a stale entry can't corrupt a build.

### c) `Custom/` — your own modules
Per-app native features and bespoke screens. Each is a self-contained folder copied
wholesale into `DSX/Modules/Custom/`. A custom module carries its **own** `config.json`
(it is *not* configured via `core_packages.json`), and ships its UI in its **own**
`Components/` folder:

```
iOS/Custom/MyPlayer/               →  DSX/Modules/Custom/MyPlayer/
├── dsx.json            manifest: name, scheme, version, pods/spm, infoPlist, dependencies
├── MyPlayer.swift      Package subclass (optional — omit for a UI-only module)
├── config.json         this module's own typed config (optional)
└── Components/          its DSX UI (optional)
    └── Player.dsx
```

> **Components live only inside modules.** There is no `iOS/Components/` folder.
> Shared/global building blocks ship in the framework's `Foundation` module; your own
> components ride inside a `Custom/` module's `Components/` folder. A module needs no
> Swift — a folder with just `dsx.json` + `Components/` is a valid (UI-only) module.

### d) Module files — bundle files a module declares

Some files are read **from the app bundle by name** (Firebase's
`GoogleService-Info.plist`, the splash `splash.gif`). Those are owned by their
module, which declares them under `files` in its `dsx.json`.

A per-app override lives **inside the owning module's namespace** —
`iOS/Packages/<PackageName>/<file>` — so the module owns its override
and there are no special root files:

```
iOS/Packages/Firebase/GoogleService-Info.plist   →  the Firebase module's copy (bundled at the root)
iOS/Packages/Splash/splash.gif                   →  the Splash module's launch animation
iOS/Packages/Dom/index.html                      →  the Dom module's local fallback page
iOS/Packages/Dom/custom.js                       →  the Dom module's injected script
iOS/Packages/Sounds/ios_sounds/*.wav             →  the Sounds module (a declared FOLDER set)
```

> Legacy bundles that drop these at the `ios_assets/` root (`ios_assets/GoogleService-Info.plist`, …)
> still work — the root is read as a fallback — but new bundles should namespace
> them under `Packages/<Name>/`.

`files` is a general **source → destination** map — any file or folder, placed
either into the module (bundled at the root, the by-name contract) or at an
arbitrary project path (`"into": "project"`, structure preserved on disk; add
`"bundle": "folder"` to ship a folder *with its structure* in the app bundle). A
**folder set** (`{ "folder": …, "asset": …, "pattern": … }`) is the
arbitrary-collection form: every matching file in the named assets folder
is placed (notification sounds, fonts, certs, …). Full grammar:
[`manifest-dsl.md → files`](../../Skills/manifest-dsl.md).

A declared file may also be a **template** with `{{ config.key }}` placeholders (filled
from that module's config) and `{{ env.NAME }}` placeholders (filled from the build
environment) — so you can deliver just values via `core_packages.json` instead of a
whole file. And because the file belongs to its module, excluding the module
removes the file from the bundle too. The same works for your own `Custom/` modules:
declare `files` in your manifest and ship overrides under `iOS/Packages/<Name>/`.

Full anatomy + manifest reference:
[`../../Skills/writing-a-module.md`](../../Skills/writing-a-module.md) ·
[`manifest-dsl.md → files`](../../Skills/manifest-dsl.md).

---

## 7. Branding

- **App icon** — drop a single 1024×1024 `marketing.png` (or
  `AppIcon.appiconset/ios-marketing.png`). The build generates every required size for the
  app **and** every enabled module/extension catalog from it — you provide one image.
  Omit it and the committed template icon is used.
- **Splash** — `splash.gif`, shown at launch.

---

## 8. The rest

- `index.html` / `custom.js` — your local fallback page and an injected JS file
  (both are `Dom`-module declared files — §6d).
- `GoogleService-Info.plist` — Firebase config (push, analytics).
- Home-screen quick actions are a **config value**, not a file —
  `core_packages.json` → `{ "QuickActions": { "legacy_shortcuts":
  { "shortcuts": [ … ] } } }` (real JSON — config values take any JSON type).
- `ios_sounds/*.wav` — custom notification sound files.

---

## Full example folder

```
iOS/
├── App.json                      { "name": "My App", "identifiers": { "ios": "com.acme.myapp" },
│                                   "host": "myapp.com" }
├── excluded.json                 { "exclude": ["admob"] }
├── core_packages.json            { "App": { "url_schemes": ["myapp"] },
│                                   "Camera": { "usage_description": "Scan QR codes" } }
├── marketing.png                 # 1024×1024 — every icon size generated from it
├── Packages/                     # per-app overrides, namespaced by owning module
│   ├── Firebase/GoogleService-Info.plist
│   ├── Dom/index.html
│   ├── Dom/custom.js
│   ├── Splash/splash.gif
│   └── Sounds/ios_sounds/ding.wav
└── Custom/
    └── MyPlayer/
        ├── dsx.json
        ├── MyPlayer.swift
        ├── config.json
        └── Components/
            └── Player.dsx
```

(A legacy bundle — `settings.env` + the same files at the `ios_assets/` root —
still builds unchanged; the root is read as a fallback. New bundles should ship
the layout above.)

## See also

- [`getting-started.md`](getting-started.md) — building on the `window.dsx` API.
- [`../../Skills/writing-a-module.md`](../../Skills/writing-a-module.md) — authoring a module.
- [`../architecture/app-manifest.md`](../architecture/app-manifest.md) — the `App.json` host model in depth.
- [`codemagic.yaml`](../../../codemagic.yaml) — the pipeline itself.
