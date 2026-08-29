# dsx.json - the property DSL

One `dsx.json` per module folder declares everything the build needs. All
keys are optional except `name`. `prepare_modules.rb` reads them; nothing here is
hand-wired into the Xcode project.

> The file is **`dsx.json`** — the exact and only module-manifest name
> (`manifest.json` is RETIRED; check_module_rules errors on the old name).

## `{{ … }}` value references — the one rule

Any value that should come from *elsewhere* uses a single **`{{ … }}` reference** — there is **no
bespoke per-feature syntax**. Two resolution planes, both written the same way:

| reference | resolves to | when | written in |
|---|---|---|---|
| `{{ config.<key> }}` (bare `{{ key }}` = shorthand) | this module's own `config.json` value (per-app via `core_packages.json`) | **build time** (`prepare_modules`) | `infoPlist`, `entitlements`, `buildSettings`, `projectAttributes`, `files`, `set`, **`state` static vars** |
| `{{ env.<NAME> }}` | the build environment (`settings.env` / CI vars) | **build time** | the same keys as above |
| `{{ dsx.<scope>.<path> }}` | the live runtime store (`dsx.app.*`, `dsx.global.*`) | **read time, per device** | a module `config.json` **string** value (e.g. `"webview_url": "https://{{ dsx.app.host }}/app"`) |
| `$(BUILD_SETTING)` | an Xcode build setting (e.g. `$(PRODUCT_BUNDLE_IDENTIFIER)`) | **every Xcode build** | `infoPlist` / `entitlements` (bundle-id-derived) |

**Typed adoption is the same everywhere:** a value that is **wholly** one `{{ token }}` adopts the
referenced value's *type* — a config **list** splices into the surrounding array, a bool/number/string
lands typed. A token **embedded** in a larger string interpolates as text. An unresolved `{{ }}` warns and
ships as-is.

So `"facebookAds": "{{ config.use_facebook_ads }}"` in a `state` block is the **same rule** as
`"NSCameraUsageDescription": "{{ config.usage_description }}"` in `infoPlist` — one schema convention, not
two. (`state`: a **string** value is `{{ config.<key> }}` (a typed mirror), an **object** value is a live
var — see [module-state.md](module-state.md). The runtime `{{ dsx.* }}` plane — config string templates
resolved per device — is in [global-state.md](global-state.md).) Per-key details follow under each section
below.

### Hardcoded vs config-fed — the manifest-value LAW (both platforms; IMPORTANT)

Every value in `infoPlist` / `entitlements` / `androidManifest` is one of exactly two kinds, and
reviewers hold every module to this (catalog audited + brought into full compliance 2026-07-11):

1. **Truly constant → inline.** Class names, storyboard/resource names (`LaunchScreen`,
   `@xml/despia_file_paths`), SDK protocol constants and toggles (`com.onesignal.suppressLaunchURLs`),
   `configChanges` sets. These can never differ per app — a config key would be noise.
2. **App/account/environment-shaped → MUST be a `{{ config.<key> }}` token.** API keys, application
   ids, usage-prompt strings, copyright lines, trigger URLs — anything a customer app would ever set.
   The key lives in the module's own `config.json` with `friendly_name`/`friendly_description`/
   `type`/`editable` so the dashboard can surface it, and per-app stamping rides
   `core_packages.json -> { "<Module>": { "<key>": … } }` — **one key stamps BOTH platforms'
   manifests**. Precedents: every `NS*UsageDescription`, AdMob `gad_app_id`
   (→ `GADApplicationIdentifier` *and* `com.google.android.gms.ads.APPLICATION_ID`), Maps
   `maps_api_key`, App `copyright`.
3. **Committed defaults must be SAFE TO SHIP** — a published sample/test value (Google's test ad
   ids), a harmless placeholder (Maps' dead-tiles key), or the house default (usage strings).
   Never a real app's credential: the codemagic invariant — nothing committed names a real app.
4. **Same knob, different per-OS default → entry-level platform sub-keys** (real committed case:
   `gad_app_id` — Google publishes *different* sample app ids per OS):

```jsonc
// Core/AdMob/config.json — ONE shared knob whose committed default differs per platform:
"gad_app_id": {
  "friendly_name": "App ID", "type": "string", "editable": true,
  "value": "ca-app-pub-3940256099942544~1458002511",    // iOS resolves value (no "ios" key)
  "android": "ca-app-pub-3940256099942544~3347511713"   // Android resolves this
}
```

5. **A manifest value that exists on ONE platform only → a sub-key-only entry** (no `"value"`):
   Maps' `maps_api_key` carries only `"android"` — Android resolves it into
   `com.google.android.geo.API_KEY`, while iOS (MapKit, no key) generates **no property at all**
   (no value + no key for the running platform = exactly an absent entry).

Full schema + `core_packages.json`'s per-platform merge: [dynamic-modules.md](dynamic-modules.md) §2.
A key that only *exists* on one platform as a genuinely different concept stays a separate
per-platform **key** (Firebase `android_*`, RevenueCat `androidApiKey`) — don't restate those as
overrides.

## Identity & gating

```jsonc
{
  "name": "HealthKit",          // required. Folder identity; shows in DespiaPackages.
  "icon": "heart",              // the module's identity glyph: an https://iconoir.com
                                // icon name (kebab-case). Iconoir is the ONLY icon set
                                // we use. Surfaced in window.dsx.packages (legacy
                                // window.despia.runtime.packages) + the build reporting.
  "scheme": "healthkit",        // URI scheme this module claims (code-bearing modules).
  "version": "1.0.0",           // surfaced to web via window.dsx.packages (legacy window.despia.runtime.packages).
  "aliases": ["readhealthkit"]  // extra schemes routed to this module (see below).
}
```

> `aliases` are **extra schemes the module owns**, used two ways:
> - **Legacy compat** — flat `scheme://token` entry points that map onto the module's existing
>   actions (e.g. `readhealthkit`, `getclipboard`, `lighthaptic`). The norm today.
> - **A second first-class scheme** — pair it with `dsx.scheme("name") { … }` in `setup()` to give
>   the scheme its OWN isolated actions, exposed as `despia.<alias>.<action>(…)`. Use when a
>   distinct sub-capability deserves its own brand but must live in the same module (e.g. LocalAI
>   owns `intelligence` + `rag`). See *Namespacing actions* in `writing-a-module.md`.

> `icon` (singular) is the **identity glyph**; the `icons` key (plural, below)
> is the unrelated image-set *generation* recipe.

## Native dependencies

### `pods` - CocoaPods

Each entry is a string, or an object for versions/sources/options:

```jsonc
"pods": [
  "SwiftyGif",                                   // simplest
  { "name": "Google-Mobile-Ads-SDK", "version": "11.4.0" },
  { "name": "PostHog", "version": "~> 3.0" },
  { "name": "SwiftQRScanner", "git": "https://github.com/vinodiOS/SwiftQRScanner" }
]
```
Object options: `name`, `version`, `git` + (`branch`|`tag`|`commit`), `path`,
`modular_headers` (bool), `configurations` (array, e.g. `["Debug"]`).

### `spm` - Swift Package Manager

```jsonc
"spm": [
  {
    "url": "https://github.com/OneSignal/OneSignal-XCFramework",
    "from": "5.5.1",                 // requirement: from | exact | upToNextMajor |
                                     // upToNextMinor | branch | revision | tag
    "products": ["OneSignalFramework", "OneSignalInAppMessages"]
  }
]
```
If a package URL is already declared manually in the project, the manual one
wins and the manifest request is skipped (logged as a warning).

### `weights` — large pinned blobs bundled as resources

ML models and similar big binaries a module bundles WITHOUT committing them:
`{ path, url, sha256 }` per entry, downloaded + hash-verified at build time by
`scripts/fetch_weights.rb` (env-override `url_env`/`sha256_env` for signed URLs and
not-yet-hosted placeholders). Full guide: **[module-weights.md](module-weights.md)**.

### `build` — binary dependencies produced in CI (no CDN, no committed blobs)

A module *declares how to produce* a binary artifact and the generic driver
(`scripts/build_frameworks.rb`, the *Build Module Frameworks* lane step) resolves it:

```jsonc
"build": [
  // fetch a pinned prebuilt (an .xcframework subtree, a .so, a pack):
  { "output": "Some.xcframework", "tool": "fetch",
    "from": "npm:some-sdk@2.1.0", "root": "package/ios/Some.xcframework" },
  // or link an NDK native lib from pinned upstream static libs + the module's shim:
  { "output": "kotlin/jniLibs/arm64-v8a/libengine.so", "tool": "cmake-android",
    "project": "ClosedSource/DSX/Modules/Core/X/kotlin/jni",
    "sources": [ { "from": "npm:vendor-sdk@1.13.1", "extract": { "…": "…" } } ] },
  // or export from an in-repo project (the Godot content pack):
  { "output": "GodotDemo.pck", "tool": "godot", "project": "…", "preset": "iOS" }
]
```

`from` locators (`npm:` / `github:` / `jsdelivr:` / `https://`) get their pin
auto-written into the module's sibling **`dsx.lock.json`** by
`build_frameworks.rb --lock` — add the link, lock once, commit both. Entries may also
declare `platform` (which lane runs them) and `url_env`/`sha256_env` (an operator's
prebuilt fast-path that skips the build, loud on failure). Tools, flow, the loud/soft
failure law, and the mechanism-choice table:
**[module-frameworks.md](module-frameworks.md)**.

## Host integration

### `infoPlist` - the app Info.plist is built from these

> **The manifest-value law applies** (see above): app/account-shaped values MUST be
> `{{ config.<key> }}` tokens; only true constants stay inline.

```jsonc
"infoPlist": {
  "NSCameraUsageDescription": "{{ config.usage_description }}",  // this module's config.json
  "UIBackgroundModes": ["remote-notification"],
  "GADApplicationIdentifier": "{{ config.gad_app_id }}",
  "MyServerURL": "https://{{ env.API_HOST }}/v1",                // build env (settings.env)
  "MyGroup": "group.$(PRODUCT_BUNDLE_IDENTIFIER).shared"         // Xcode build setting
}
```

The app `Info.plist` (`DSX/Modules/Mandatory/App/Info.plist`) is **generated
whole** by `prepare_modules`: an identity skeleton (bundle id / names /
versions as `$(BUILD_SETTING)` refs — the reserved keys no module may set)
plus every enabled module's `infoPlist`. There is no hand-maintained or
client-shipped app plist; a key ships and drops with its owning module.
The host-structural keys (orientations, storyboards, copyright, privacy
manifest, …) are themselves a module: `Mandatory/App`.

**Any plist key and value shape is supported** — including keys Apple never
heard of (`MyCompanyFeatureFlags`, an SDK's custom lookup key, …). The JSON
you write is the plist you get: strings, booleans, numbers
(integer/real), arrays, and dicts nested to any depth, all merged with the
rules below. (JSON has no plist `Date`/`Data` types — everything else maps
1:1.)

Merge rules across modules:

- **Arrays** union (e.g. `UIBackgroundModes`, `CFBundleURLTypes`); **dicts**
  deep-merge.
- **Scalars**: first declarer wins, ordered **Custom → Mandatory → Core** — so
  a per-app Custom module overrides a built-in's value (a usage string, an
  SDK key) just by declaring the same key. Differing losers log a warning.
- **Placeholders** (the `{{ … }}` rule above) make every value per-app dynamic — nothing is hardcoded:
  - `{{ config.key }}` — the module's own `config.json` (the surface
    `core_packages.json` writes per app). Bare `{{ key }}` is accepted
    shorthand. This is how per-app plist values travel:
    `{ "App": { "url_schemes": ["myapp", "myapp-link"] } }`,
    `{ "AdMob": { "gad_app_id": "ca-app-pub-…" } }`, and **every permission
    usage string** (`{ "Camera": { "usage_description": "…" } }` — all
    permission modules expose their prompt text this way). A string that is
    **wholly** one token adopts the config value's *type*: an Array **splices
    into the surrounding plist array** (that's how `url_schemes` registers a
    whole list of deep-link schemes), a bool/number lands typed; embedded
    tokens interpolate as text.
  - `{{ env.NAME }}` — the build environment (`settings.env` / Codemagic
    vars), resolved when `prepare_modules` runs.
  - `$(BUILD_SETTING)` — left verbatim; **Xcode** substitutes at build time.
    Use for bundle-id-derived values: the deep-link `CFBundleURLName` is
    `$(PRODUCT_BUNDLE_IDENTIFIER)`, OneSignal's group key is
    `group.$(PRODUCT_BUNDLE_IDENTIFIER).container`. (Why not
    `{{ env.BUNDLE_ID }}`? An `env` token is baked **once, at generation
    time, on the build machine** — and `PRODUCT_BUNDLE_IDENTIFIER` isn't an
    environment variable at all, it's a build setting that only exists inside
    Xcode. `$(…)` resolves on **every** build of the produced project — CI,
    local Xcode, the customer workspace zip — and stays correct even when the
    pipeline changes the bundle id after generation.)

  Unresolved `{{ }}` tokens warn and ship as-is (visible in the build log).
  Note: when two enabled modules declare the same plist key (the two Location
  modules, PhotoLibrary + CameraRoll), they use the same config key name —
  override the value on **both** modules.

### `entitlements` - merged into `Runtime.entitlements`

```jsonc
"entitlements": {
  "com.apple.developer.healthkit": true,
  "com.apple.security.application-groups": ["group.com.acme.app.onesignal"],
  // universal links, per app from this module's config (array SPLICE) -
  // the Mandatory/App module ships exactly this lever as `associated_domains`:
  "com.apple.developer.associated-domains": ["{{ config.associated_domains }}"]
}
```

The same merge rules and **placeholders** as `infoPlist` apply: arrays union
across modules (two modules adding associated domains both land), manual
content in the file always wins, and values resolve `{{ config.key }}` /
`{{ env.NAME }}` with whole-token typed adoption — a config **list** splices
into the surrounding array, which is how per-app universal-link domains
travel via `core_packages.json` without a pipeline step.

> For the full patterns — the capability ↔ entitlement ↔ config triangle, the
> safety rules, and worked "powerful module" examples — see
> **[dynamic-modules.md](dynamic-modules.md)**.

When a package shares a container across several targets but an entitlement
belongs to only one of them, use the target-local form. A push provider, for
example, keeps APNs on the app and out of its notification-service extension:

```jsonc
"entitlementsByTarget": {
  "Runtime": { "aps-environment": "production" }
}
```

Target names are validated against built-in and manifest-declared targets; an
unknown name fails generation instead of silently dropping the capability.

### `androidManifest` - the Android host manifest is built from these

> **The manifest-value law applies** (see above): app/account-shaped values MUST be
> `{{ config.<key> }}` tokens (AdMob's `APPLICATION_ID`, Maps' `API_KEY`); only true
> constants stay inline (SDK toggles, class names, resource refs).

The `infoPlist` twin for the other platform, read by
`prepare_modules_android.rb`: every enabled module's `androidManifest` block is
merged into the three DSX MANAGED sentinel blocks of
`ClosedSource/HostAndroid/src/main/AndroidManifest.xml` (manifest level,
`<application>` children, MainActivity contributions). An entry ships and drops
with its owning module; identical entries across modules dedupe (first declarer
wins, every source named in the generated comment); order is deterministic
(module path sort); a second run is a no-diff. The old per-module
`kotlin/AndroidManifest.xml` XML fragments are **retired** — a stray one is a
hard build error (one source of truth).

```jsonc
"androidManifest": {
  "_note": "…",                                   // _note / _note_* ignored at every level
  "permissions": ["CAMERA",                       // no dot → android.permission.CAMERA
                  "android.permission.health.READ_STEPS"],  // dotted → literal
  "features": { "android.hardware.camera": true },// OPTIONAL required-overrides (see below)
  "metaData": { "com.google.android.gms.ads.APPLICATION_ID": "{{ config.gad_app_id }}" },
  "activities":      ["QRScannerActivity"],       // string short form OR object (below)
  "activityAliases": [ … ],                       // <activity-alias> entries
  "services":  [ … ], "receivers": [ … ], "providers": [ … ],
  "raw": { "manifest": ["<queries>…</queries>"],  // literal-XML escape hatch
           "application": ["<service … tools:node=\"merge\" />"] }
}
```

**Values are per-app dynamic like `infoPlist`:** every string resolves
`{{ config.key }}` / `{{ env.NAME }}` with the exact same semantics — a string
that is *wholly* one token adopts the config value's type (a list splices into
the surrounding array), embedded tokens interpolate as text, and a missing
key/var **warns and ships the token as-is**. (`${applicationId}` is different —
that's AGP's own manifest placeholder, left verbatim for Gradle, the
`$(BUILD_SETTING)` analogue.)

- **`permissions`** — array of strings → `<uses-permission>`. A name without a
  dot gets the `android.permission.` prefix; a dotted name is literal
  (`android.permission.health.READ_STEPS`). Permissions are attribute-less by
  design — a grant that needs `maxSdkVersion` etc. rides `raw` (the
  Screenshot/CameraRoll `WRITE_EXTERNAL_STORAGE maxSdk=28` pair).
- **Auto-implied feature guards** — for every declared permission in Google's
  documented permission→implied-hardware-feature table
  (<https://developer.android.com/guide/topics/manifest/uses-feature-element#permissions-features>),
  the generator **always** emits an explicit
  `<uses-feature android:required="false"/>` guard. Google Play otherwise
  treats the implied feature as *required* and filters the app off devices
  without that hardware (release-lint
  `PermissionImpliesUnsupportedChromeOsHardware` — the QRScanner camera case).
  The table (kept in `prepare_modules_android.rb` `AM_IMPLIED_FEATURES`):

  | declared permission | implied feature(s), guarded `required="false"` |
  |---|---|
  | `CAMERA` | `android.hardware.camera` |
  | `RECORD_AUDIO` | `android.hardware.microphone` |
  | `ACCESS_FINE_LOCATION` | `android.hardware.location.gps` + `android.hardware.location` |
  | `ACCESS_COARSE_LOCATION`, `ACCESS_MOCK_LOCATION`, `ACCESS_LOCATION_EXTRA_COMMANDS`, `INSTALL_LOCATION_PROVIDER` | `android.hardware.location` |
  | `BLUETOOTH`, `BLUETOOTH_ADMIN`, `BLUETOOTH_CONNECT` | `android.hardware.bluetooth` |
  | `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE` | `android.hardware.bluetooth` + `android.hardware.bluetooth_le` |
  | `NFC` | `android.hardware.nfc` |
  | `USE_FINGERPRINT`, `USE_BIOMETRIC` | `android.hardware.fingerprint` |
  | `CALL_PHONE`, `CALL_PRIVILEGED`, `MODIFY_PHONE_STATE`, `PROCESS_OUTGOING_CALLS`, `READ_SMS`, `RECEIVE_SMS`, `RECEIVE_MMS`, `RECEIVE_WAP_PUSH`, `SEND_SMS`, `WRITE_APN_SETTINGS`, `WRITE_SMS` | `android.hardware.telephony` |

- **`features`** — OPTIONAL `{ "<feature name>": <required bool> }`, only for
  overrides: a module whose feature genuinely IS required declares
  `{ "android.hardware.camera": true }` and the guard flips to
  `required="true"`. Two modules explicitly overriding the same feature to
  different values is a build error.
- **`metaData`** — flat name→value map → application-level `<meta-data>`. A
  value starting with `@` lands as `android:resource`
  (`"@xml/despia_file_paths"`); anything else as `android:value`
  (booleans/numbers stringify).
- **`activities` / `activityAliases` / `services` / `receivers` /
  `providers`** — component arrays. A **string** is the class name: no dot →
  prefixed with the module's Kotlin package (the same package the
  `GeneratedModules` register map uses — `despia.modules.<module>`); dotted →
  literal. An **object** needs `name` (same expansion) and takes any other
  camelCase key as an `android:` attribute verbatim (`grantUriPermissions`,
  `configChanges`, `theme`, `authorities`, `launchMode`, …; booleans/numbers
  stringify), plus optional `toolsIgnore` (a comma-separated set of exact
  Android lint issue IDs emitted as `tools:ignore`), nested `metaData` (map),
  and `intentFilters` (array of
  `{ actions: [], categories?: [], data?: [{ scheme, host, mimeType, … }] }`;
  extra scalar keys become intent-filter attributes, e.g. `autoVerify`).
  **Defaults the generator always emits explicitly**:
  `android:exported="false"` unless the entry sets `exported`; an activity
  also gets
  `configChanges="orientation|screenSize|screenLayout|keyboardHidden|uiMode"`
  and `theme="@android:style/Theme.DeviceDefault.NoActionBar"`. Set a key to
  JSON `null` to omit an Android attribute entirely (how the tap-trampoline
  activities suppress the `configChanges` default).
  Use `toolsIgnore` only on the narrow owning component, with the rationale in
  its dsx.json `_note`; it is not a substitute for fixing actionable lint.
  An activities entry whose expanded name is `despia.host.MainActivity`
  **contributes its children INTO the host activity** instead of declaring a
  new one (SharedData's `ACTION_SEND` filter, HealthKit's permissions
  rationale) — only `intentFilters`/`metaData` there; the activity's
  attributes are bootloader-owned.
- **`raw`** — `{ "manifest": [xml…], "application": [xml…] }`: literal XML
  strings for the shapes the structured keys don't model — `<queries>` blocks
  (HealthKit, SpeechRecognition), an attribute-qualified grant
  (`maxSdkVersion`), a `tools:node="merge"` overlay on a library's component
  (LocalAI's WorkManager service type). Each entry must parse as exactly ONE
  XML element or the build aborts; `android:`/`tools:` prefixes are
  pre-declared. Raw entries ride the same dedupe + collision machinery.

**Collision law across modules:** same permission/feature → deduped silently
(union); a component (or `<meta-data>`) with the same expanded `name` →
byte-identical entries dedupe to one (the FileSharing/FileViewer FileProvider
lockstep), **any** attribute/child difference is a hard error naming both
modules — never a silent pick.

**Certification (hard, build-blocking, in normal and `--check` runs):** an
unknown top-level key (valid set: `permissions`, `features`, `metaData`,
`activities`, `activityAliases`, `services`, `receivers`, `providers`, `raw`);
a permission/feature/class name off `[A-Za-z][A-Za-z0-9_.]*` post-expansion; a
component object without `name`; a non-scalar attribute value (only
`metaData`/`intentFilters` nest); the collision law above; a stray
`kotlin/AndroidManifest.xml` fragment file; a `raw` entry that doesn't
XML-parse.

Worked examples — the short form (QRScanner: one permission, its auto-guarded
feature, one activity that is exactly the generator defaults):

```jsonc
"androidManifest": {
  "permissions": ["CAMERA"],        // → uses-permission + the required=false camera guard
  "activities": ["QRScannerActivity"]  // → despia.modules.qrscanner.QRScannerActivity,
}                                      //   exported=false + default configChanges/theme
```

and the full form (FileSharing: the shared FileProvider — FileViewer declares
the byte-identical block, the merger dedupes to one):

```jsonc
"androidManifest": {
  "providers": [
    {
      "name": "androidx.core.content.FileProvider",       // dotted → literal
      "authorities": "${applicationId}.despia.files",     // AGP placeholder, verbatim
      "exported": false,
      "grantUriPermissions": true,
      "metaData": { "android.support.FILE_PROVIDER_PATHS": "@xml/despia_file_paths" }
    }
  ]
}
```

What it does **not** cover (bootloader-owned, documented in the host
manifest): `uses-sdk` *attribute* merges (`tools:overrideLibrary` is one
comma-joined attribute) and the ship-in-every-build OS entry points of
default-excluded modules (ShareTargetAlias, ImageWidgetReceiver,
DespiaKeyboardService — `enabled=false`, flipped on at launch).

### `container` - opt into the shared App Group

`"container": true` adds the one reserved shared App Group
(`group.<bundleid>.container`) to this module's `targets`, instead of naming a
group under `entitlements`. One group is provisioned per app and shared by every
module + extension; module code reads/writes it via `dsx.container`
(namespaced to the module scheme). See [containers.md](containers.md).

```jsonc
"container": true,
"targets": ["Runtime", "OneSignalNotificationServiceExtension"]  // app + any extension that shares data
```

### `capabilities` - Apple capabilities for the App ID

Declare the Apple capabilities (App Store Connect names) a target's bundle id
needs. They're recorded to `DSX/Modules/.plugin_capabilities.json` for the signing
step to enable on the App ID / provisioning profile (the list the App Store
Connect API needs). The matching **entitlement is declared by the same manifest's
`entitlements`** - nothing is derived or hardcoded in the build script, so any
capability + entitlement a module needs is fully JSON-driven and the script never
changes.

```jsonc
"capabilities": ["HEALTHKIT"],                              // App ID capability
"entitlements": { "com.apple.developer.healthkit": true }  // the entitlement it needs
```

Per target (an extension has its own App ID):

```jsonc
"capabilities": {
  "Runtime": ["PUSH_NOTIFICATIONS"],
  "OneSignalNotificationServiceExtension": ["APP_GROUPS"]
}
```

Common names: `HEALTHKIT`, `PUSH_NOTIFICATIONS`, `APP_GROUPS`, `SIGN_IN_WITH_APPLE`,
`ASSOCIATED_DOMAINS` - any App Store Connect capability type is accepted. Building
in Xcode directly? Enable the same capability under the target's Signing &
Capabilities.

### `targets` - who receives the above

By default a module's `entitlements`/`infoPlist` apply to the `Runtime` app
target. List `targets` to fan them out to extensions too (e.g. an app group
shared between app and a notification-service extension):

```jsonc
"targets": ["Runtime", "OneSignalNotificationServiceExtension"]
```

### `buildSettings` - host build settings a module owns

```jsonc
"buildSettings": { "Runtime": { "TARGETED_DEVICE_FAMILY": "1,2" } }
```

A module can own a **host target's build setting** — the capability behind
"iPad support is a module" (`Core/Basics/TabletSupport` is exactly the example
above). Applied by `prepare_modules` with **lockfile provenance**: the first
application records the previous value, and excluding/removing the module
**restores it** — nothing is hardcoded in CI or the project. Values resolve
`{{ config.* }}` / `{{ env.* }}` (an empty/unresolved token skips the setting);
cross-module conflicts keep the first declarer and warn. (An
`extensionTargets` spec has its own per-target `buildSettings` for the target
it synthesizes — this key is for targets the module does *not* own.)

### `projectAttributes` - project-root values a module owns

```jsonc
"projectAttributes": {
  "developmentRegion": "{{ config.language }}",  // scalar: provenance-restored
  "knownRegions": ["{{ config.language }}"]      // array: union; removal strips
}                                                //   only what THIS added
```

The store `buildSettings` can't reach — these live on the **project root**,
not a target. `developmentRegion` records its previous value and restores it
when the module drops; `knownRegions` removal never strips a region the
project already carried. Whitelisted keys only (project-root state is global,
each attribute is admitted deliberately). This is the Language-module
enabler; values resolve `{{ config/env }}` with empty-skip like everything
else.

### `deploymentTarget` - minimum iOS for this module

The min OS version is **package-declared**: the highest `deploymentTarget`
across all enabled modules wins, and `prepare_modules` **applies** it — to
every `IPHONEOS_DEPLOYMENT_TARGET` in `Runtime.xcodeproj` and to the Podfile
(`platform :ios` + the post_install pod pin) — on every run, in **both
directions**: import a demanding module and the whole project builds at its
floor; exclude it and the floor falls back. `Mandatory/App` declares the
framework baseline (16.6) so the set is never empty; Godot (ships by default)
raises it to 17.0, Clerk to 17.6. The codemagic.yaml "Minimum Deployment
Target" step only **verifies** the applied floor matches the generated
`.plugin_deployment_target.json`. The Android twin is `gradle.minSdk` — same
highest-enabled-wins law, applied to the app `minSdk` by
`prepare_modules_android` (see
[android/manifest-and-build.md](android/manifest-and-build.md)).

```jsonc
"deploymentTarget": "17.6"
```

### `languages` - source languages a module is authored in

The polyglot-module primitive: declare any language a module ships **beyond** the
platform language (Swift / Kotlin) - almost always **C++** for a shared engine you
write once and drive from both platforms. A map of language → its build config:

```jsonc
"languages": { "cxx": "c++17", "rust": "2021" }
```

An **object** (each language has different config - C++ a *standard*, Rust an
*edition*), not a list. `prepare_modules` aggregates every **enabled** module's block
into `.plugin_languages.json` and weaves a C-ABI bridging-header umbrella
(`.plugin_bridging.h`); the build raises `CLANG_CXX_LANGUAGE_STANDARD` above the
project floor (never below) and points `SWIFT_OBJC_BRIDGING_HEADER` at the umbrella -
both no-ops when no such module is enabled. Android reads the same block for its CMake
standard. The foreign source lives in the module folder, so it's **file-presence
gated like Swift** (exclude the module, its native code goes too). Unknown languages
warn rather than abort (forward-compatible). Full recipe + the C-ABI seam convention:
**[native-languages.md](native-languages.md)**.

## App extension targets

`extensionTargets` lets a module own a full app-extension target — fully
dynamic, like everything else a manifest declares: module enabled → the
target is synthesized into Runtime.xcodeproj (sources, plist, entitlements,
host dependency + embed); module excluded → the whole target is torn back
out, zero trace. No hand-wired Xcode target, no root-level folder. For the
extraction workflow see [extracting-a-module.md](extracting-a-module.md);
`Core/Extensions/ShareExtension` (in-module sources) and `Core/OneSignal`
(adopted root-level target) are shipped worked examples.

```jsonc
"extensionTargets": [
  {
    "name": "ShareExtensionTarget",
    "kind": "share",
    "sources": "ShareExtensionTarget",     // dir of the target's files, module-relative
    "spmProducts": [                        // optional: products linked into THIS target
      { "url": "https://github.com/OneSignal/OneSignal-XCFramework",
        "product": "OneSignalExtension" }
    ]
  }
]
```

**Keep the target's files IN the module** (`<Package>/<TargetName>/`):
`sources` resolves module-relative first, repo-relative second. The
generator compiles every `*.swift` under it into the extension target (and
excepts those files from the app target file-by-file, so extension code
never leaks into the app binary). Resources are OPT-IN: by default none are
wired (a plain extension presents under the host app's identity), but a
`"resources": ["BundledScreens/*.dsx", "*.xcassets"]` array (globs relative
to `sources`) bundles matches into THIS target — the Watch app ships its
offline screens and the widget its asset catalog exactly this way.

**The extension's own Info.plist** — an app extension is its own binary with
its own plist (activation rules, extension point, principal class), separate
from the app's. Resolution ladder:

1. Ship `Info.plist` beside `sources` → it wins, verbatim, and is never
   overwritten. Do this whenever you need more than the minimal scaffold
   (e.g. a share target's `NSExtensionActivationRule`).
2. No plist + a known `kind` (`share`, `notification-service`,
   `notification-content`, `widget`, `intents`, `keyboard`) → a standard
   plist is generated once with that kind's `NSExtension` block
   (`$(PRODUCT_MODULE_NAME)` principal class — keep your own plist
   module-agnostic the same way). `kind: "watch"` is the one non-extension
   kind: no `NSExtension` block — it selects the watchOS platform instead
   (watch SDK, its own deployment floor, the **Embed Watch Content** phase).
3. Unknown extension point → supply the `NSExtension` block yourself via an
   `nsExtension` object; no script change needed.

**The extension's own entitlements** work the same way: ship
`<TargetName>.entitlements` beside `sources` (an empty one is seeded if
missing — a dangling `CODE_SIGN_ENTITLEMENTS` fails the archive). The
manifest's top-level `entitlements` + `targets: [...]` (and `container: true`)
fan INTO that file, so the shared App Group reaches the .appex from the same
single declaration that covers the app.

**Bundle identity is DERIVED, never hand-set per app.** Every target's id is

```
PRODUCT_BUNDLE_IDENTIFIER = <app bundle id> + "." + bundleSuffix
```

where the app id comes from the client's App.json (`identifiers.ios` → the
build's `BUNDLE_ID`) and **`bundleSuffix`** is the module's declared,
app-independent tail — `"watchkitapp"`, `"Clip"`; omitted, the target
**name** is the suffix (OneSignal's NSE →
`<app>.OneSignalNotificationServiceExtension`). This is what makes an
extension a fleet primitive: the module fixes the suffix once, every app
gets its own id for free, and the signing pipeline validates
`${BUNDLE_ID}.${suffix}` per app with zero per-feature CI. Apple's
companion rules (a watch app / clip id must be prefixed by the host id)
hold by construction. `bundleId` (a full literal id) exists only as the
override for a genuinely nonstandard id — prefer the suffix; the CI
validation joins `${BUNDLE_ID}.${bundleSuffix}` and a literal id opts that
target out of the derivation story.

**`productType`** defaults to `app_extension`; a manifest may declare any
product xcodeproj knows — `application_on_demand_install_capable` (the App
Clip) and `application` + `kind: "watch"` (the watchOS companion app) are
the shipped non-extension examples.

**`runtime`** compiles engine tiers into the target instead of hand-listing
kernel files: `live` (StackNode/Scope/Live — widgets), `activity` (+
StackActivity — Live Activities / Dynamic Island), `watch` (+ StackWatch),
`keys` (+ StackKeys — keyboards).

**`host`** nests one declared target inside ANOTHER — the value is the other
target's `name` (e.g. a WidgetKit extension whose `host` is the watch app
embeds inside DespiaWatch, not Runtime). Hostless targets synthesize first so
a named host always exists by the time its children wire, and the child's
bundle id derives from the HOST's id (`<host-bid>.<suffix>` — exactly Apple's
nesting rule). Typo-gated hard: an unknown `host` **aborts** prepare loudly (a
silent Runtime fallback would embed the product in the wrong app and surface
one build later as a validation mystery). Omit it for a normal app-hosted
target.

**Packaged identity is INJECTED — a minimal committed plist stays minimal.**
Every synthesized target's settings template carries `GENERATE_INFOPLIST_FILE
= YES`, `CURRENT_PROJECT_VERSION = 1` and `INFOPLIST_KEY_CFBundleDisplayName`,
so the PACKAGED plist always has the CFBundle identity keys App Store
validation demands — without them, Xcode 26's App Intents pass kills the
archive ("Unable to parse Info.plist") and upload validation rejects the
appex (90360, missing `CFBundleDisplayName`). Committed plist keys win over
injected ones; adopted (hand-tuned) targets only have blanks filled.
**`displayName`** sets the user-visible name (default: the target name) —
`"displayName": "Image Widget"`. Two watch-application extras: ship a
PNG-less **`AppIcon.appiconset` recipe** in the target's `Assets.xcassets`
(`generate_icons.rb` fills it from `marketing.png` at build; validation
90391/90713 reject an iconless watch app), and keep
**`WKCompanionAppBundleIdentifier`** on the TEMPLATE host id literal — never
empty (90538); the CI bundle-id rewrite makes it per-app, the same law as
the App Group string.

Remaining recognized keys: `sharedSources` (files compiled into host AND
target — e.g. an ActivityAttributes both must see), `extraSources`
(repo-relative additions), `deploymentTarget`, `swiftVersion`,
`buildSettings` (per-target), `displayName`, `facet` (binds this target's
FACET WORD — the name `provides`/`reach` lists speak; facet-contracts.md),
`infoPlist`, `entitlements`,
`nsExtension`,
and the signing pair `signingFlag` / `requiredProfileEntitlements` (next
section). The full set is the typo gate `EXTENSION_TARGET_KEYS` in
`prepare_modules.rb` — an unknown field warns at prepare time with the
known-field list, so a misspelled `bundelSuffix` can't silently derive the
wrong bundle id and surface a build later as a signing mystery.

## Facet contracts — `provides` / `reach` / nested modules

The full law is `Documentation/architecture/facet-contracts.md`; the manifest
surface is three additions. Per action: **`provides`** (the registered facets
whose runtime implements it locally) and **`reach`** (the facets that may call
it over their link — the ONLY spelling; the `relay` key is RETIRED and aborts
at prepare). Top-level **`facet`** is how a TARGET OWNER binds a facet
word (Mandatory/App binds `app`; a target spec binds via its own `facet`
field). Words are validated at prepare against the registered set — nothing
is kernel-known. And a module may contain modules under its **`Modules/`**
container: children are full modules (own manifest/scheme/deps/permissions),
excluded alone by name/path or by CASCADE when the parent drops; a parent's
file walks never cross the container. Childhood is earned by an independent
removal story (own permission/dependency/compliance boundary) — otherwise
it's just files.

## Cross-node reach — `reach` (provider) + `node` (consumer)

Satellite nodes (the watch; a keyboard/clip next — `watch-runtime.md`) call
host modules through a **generated capability table**. Both halves are
manifest primitives; nothing node-specific lives in the scripts.

**`reach`** — a PROVIDER opts its actions into a node role. Package-level
role list with a per-action override; default is **nothing** (the satellite
is the less-trusted node); explicit `false` = deny. The list is always
EXPLICIT — the retired `true` shorthand aborts (a facet word is never
implicit):

```jsonc
"reach": ["watch"],                       // every action of this module
"actions": { "show": { "reach": ["watch"] } }   // or per action
```

**`node`** — a CONSUMER (the package that OWNS a satellite surface)
declares its role, its bundled screens, and where the baked table lands:

```jsonc
"node": {
  "role": "watch",                       // the role `reach:[…]` targets
  "screens": "WatchApp/BundledScreens",  // bundled .dsx, statically linted
  "capabilities": [                      // package-relative table copies:
    "WatchApp/BundledScreens/capabilities.json",   // node bundle (runtime resolve)
    "watch-relay.generated.json"                   // host gate (bridge allowlist)
  ]
}
```

`generate_node_capabilities` (prepare_modules) writes the SAME bytes to
every listed path — the two devices can never disagree — and **fails the
build** when a bundled screen calls an action the role can't relay
(`route.*` is exempt: a satellite routes itself). Typo gate: `NODE_KEYS`.
A new node kind is a declaration, zero script edits.

## Icons

There is exactly ONE icon in the system: `Assets/Icons/marketing.png`
(1024×1024; the per-app pipeline swaps this single file). Every required
size and format is generated from it at build time by
`ClosedSource/scripts/generate_icons.rb` — no pre-sized icon PNG is ever committed or
named anywhere.

- **You usually declare nothing.** Every `*.appiconset` in the repo is
  auto-discovered and filled, sized by its own `Contents.json` (which IS the
  manifest — ship a PNG-less catalog with just a `Contents.json` and the
  build produces the images; entries without a `filename` get one
  synthesized). A catalog inside a disabled module is skipped.
- **Other image sets are opt-in** (never auto-clobbered): list them in
  dsx.json — `"icons": [{ "set": "Sub/Path.imageset" }]` (module-relative).
  Add `"sizes": ["20x20@2x", "1024x1024"]` and the `Contents.json` is
  generated too, so a module can declare its icon needs in pure JSON.
- Fail-open: no source icon or no resize tool → committed icons stand.

`Core/Widgets` is the worked example: its widget target ships PNG-less
`AppIcon`/`AppLogo` recipes plus an `icons` entry for the logo imageset.

## `files` — the dynamic asset placement system

`files` is a declarative **source → destination** map: a module says *dump
this file/folder, put it here*. `ClosedSource/scripts/apply_package_files.rb` (a CI step,
before `prepare_modules`) materializes it. No per-asset pipeline step ever —
`codemagic.yaml` names no file.

```jsonc
"files": [
  { "path": "GoogleService-Info.plist" },                        // file → bundle root
  { "path": "Seed.json", "asset": "MySeed.json" },               // renamed source
  { "folder": "Sounds", "asset": "ios_sounds", "pattern": "*.wav" }, // a set → bundle root
  { "folder": "certs", "to": "Runtime/Certs", "into": "project" },   // a set → a project path
  { "path": "boot.json", "to": "WebView", "into": "project" }    // file → a project folder
]
```

### Source — what to place

- **`path`** — one file. The committed default lives at `<pkg>/<path>`; a
  per-app build overrides it from `iOS/Packages/<Pkg>/<asset|basename>` (`asset`
  renames the source: `{ "path": "Seed.json", "asset": "MySeed.json" }`). The
  content may carry **`{{ config.key }}`** / **`{{ env.NAME }}`** placeholders
  (filled after `apply_core_config`, so `core_packages.json` values win;
  binary files are copied verbatim, never scanned).
- **`folder`** — a set of files. Per-app from `iOS/Packages/<Pkg>/<asset|basename>`
  filtered by `pattern` (default `*`); for an `into:project` copy with no
  per-app set, the committed `<pkg>/<folder>` tree is placed instead. Copied
  verbatim.

### Destination — where it lands

- **`into: "package"`** (default) — base is the module folder. The
  synchronized group bundles it **flattened to the bundle root** (where iOS /
  an SDK reads it by name) and it drops out when the module is excluded. The
  by-name bundle contract — a Firebase plist, sounds, fonts, a seed JSON.
- **`into: "project"`** — base is the repo root. Lands verbatim at an arbitrary
  project path (folders keep their structure on disk); `to` is **required**.
  Use for an on-disk build input or a path a specific target/reader expects.
  On disk only by default — add **`bundle: "folder"`** (folder + project) to
  ship it: `prepare_modules` adds a structure-preserving **folder reference**
  for `to` to the app target's Resources, so the whole tree copies into the
  app bundle at that position (the one thing the synced group's flatten can't
  do). It's provenance-tracked — excluding the module tears the reference
  back out. An excluded module places nothing.
- **`to`** — the destination subpath under the base. For a **file**, `to` is a
  directory (basename kept) when it ends `/`, exists as a dir, or has no
  extension (`"Runtime/Generated"`); it's a full path (rename) when it names a
  file (`"WebView/boot.json"`). For a **folder**, `to` is the destination
  directory. Omitted ⇒ `into:package` keeps the committed location; `into:project`
  is an error.

Existing `path`/`folder` entries (no `to`/`into`) are exactly `into:package`
with the historical destination — unchanged. Two enabled modules placing the
same basename at the bundle root collide — the script warns.

### `android: true` — the same row, in the APK

`files` grew up Apple-side, and on iOS a row lands in the bundle for free: the
`DSX/Modules` **synchronized group** flattens the module folder to the bundle
root, so the manifest only has to say which file a per-app build may override.
The APK has no synchronized group — nothing walks the module folder — so the
same row has to be **copied**. Mark it `"android": true` and
`prepare_modules_android` emits that copy into the APK **asset root**, which is
what `file:///android_asset/<path>` addresses:

```jsonc
"files": [
  { "path": "local-www/index.html", "asset": "index.html", "android": true }
]
```

One declaration, two lanes, one runtime spelling —
`dsx.module.dom.load({ path: "index.html" })` resolves on a phone of either
kind. `path` + `into: "package"` only (a folder set or a project placement has
no asset-root meaning), file-presence-gated like everything else: excluding the
owner takes its asset out of the APK, on a non-clean rebuild too.

It is **opt-in**, not the default, because most rows are Apple-shaped —
an Info.plist `set`, `GoogleService-Info.plist` (Android configures Firebase
from config.json instead) — or deliberately deferred on Android
(`Mandatory/Splash`'s `splash.gif`: the render layer has no GIF decode yet, so
no gif ships in the APK). Adding the flag is how a module says the file means
something on both.

### `set` — declared plist edits (per-app extension identity)

A `files` entry may carry `set`: plist key → value, applied by
`prepare_modules` to the entry's `path` (an extension target's Info.plist, an
entitlements file). Values resolve `{{ config.* }}` / `{{ env.* }}` with typed
adoption; a value with **any unresolved token is skipped**, so a build without
the per-app value keeps the committed file byte-stable. This is how an App
Clip's display name / URL and the widget's gallery identity are declared —
there are no per-feature `plutil` CI steps:

```jsonc
"files": [
  { "path": "AppClip/Info.plist",
    "set": { "CFBundleDisplayName": "{{ env.APP_NAME }}",
             "DespiaClipWebURL": "https://{{ env.APPCLIP_URL }}" } }
]
```

A `set` entry is an *edit declaration*, not a delivery: it takes no
per-app override and its basename never joins the override lookup.

### Signing & the `signingFlag`

The code-signing phase derives its target list from the manifests
(`ClosedSource/scripts/signing_targets.rb`): every enabled module's `extensionTargets`
yields its bundle suffix, container membership, clip-ness, and an `INCLUDE_*`
flag the profile validation exports. The bundle suffix is **host-chained** (the
one recipe, `DSXGraph.extension_bundle_suffixes`): a `host`-nested target's
suffix rides its host's, so the watch-face widget inside the watch app is
`watchkitapp.face` — CI provisions the id the target actually signs with.
Container membership and the emitted `portalCapabilities` (App Store Connect
capability types from each manifest's `capabilities` map — Health's
`{"Watch": ["HEALTHKIT"]}`) aggregate across **all** enabled manifests, so a
nested child fanning into its parent's target counts;
`provision_extension_app_ids.rb` enables them on the target's App ID before
profiles mint. The flag defaults to
`INCLUDE_<TARGETNAME>`; an `extensionTargets` entry may declare
`"signingFlag": "..."` to preserve a legacy wire name the cloud already sends
(OneSignal's `INCLUDE_ONESIGNALNOTIFICATION`). No feature name lives in CI.

Worked examples: `Core/Firebase` (the plist), `Mandatory/Splash`
(`splash.gif`), `Core/Dom` (`local-www/index.html` + `custom.js` — the
web layer's app content), `Core/Sounds` (the `ios_sounds/*.wav` folder set).

## Minimal examples

Permission-only module (no code, no pod):
```json
{ "name": "Camera", "icon": "camera",
  "infoPlist": { "NSCameraUsageDescription": "{{ config.usage_description }}" } }
```

Host SDK pod holder (no code):
```json
{ "name": "Stripe", "icon": "credit-card", "pods": ["StripePaymentSheet"] }
```

Off-by-default pod holder (listed in `DSX/Modules/Config/excluded.json`; remove it
there to ship):
```json
{ "name": "Terra", "pods": ["TerraiOS_v2"] }
```

## Notes

- `DSX/Modules/Config/excluded.json` is **not** a module manifest - it's the
  build-wide exclude list (`{ "exclude": [...] }` or a bare array).
- After any manifest change, run `ruby ClosedSource/scripts/prepare_modules.rb` and review the
  `Podfile` + project diff.
