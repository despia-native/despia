# Building dynamic, powerful modules

> How a module declares **per-app native configuration** — Info.plist keys,
> entitlements (universal links, app groups, custom SDK keys), and typed Swift
> config — entirely in JSON, with nothing hardcoded and no pipeline step per
> feature. Read [manifest-dsl.md](manifest-dsl.md) first for the key reference;
> this guide is the *patterns* for using it well.

The whole point: **a capability is data, not a code change.** Adding the most
powerful native feature — a new entitlement, a background mode, an SDK that
reads a key from the bundle — is a `dsx.json` + `config.json` edit. The build
scripts never change, and the value a *client* needs (their domain, their API
key, their scheme) travels as config, not as a committed constant.

---

## 1. The one mechanism: placeholders resolve at build time

Every value inside a manifest's **`infoPlist`** and **`entitlements`** objects
is a template. Four namespaces resolve, in `prepare_modules`:

| Token | Resolves from | When | Use for |
|---|---|---|---|
| `{{ config.key }}` | this module's `config.json` `value` | generation (CI) | per-app data: domains, SDK keys, usage strings, schemes |
| `{{ env.NAME }}` | the build environment (`settings.env` / Codemagic vars) | generation (CI) | values already in the signing/identity env |
| `{{ app.path }}` | the per-app manifest `App.json` (dotted paths dig: `{{ app.identifiers.ios }}`), falling back to the key's legacy trigger env var (`name`→`APP_NAME`, `version`→`APP_VERSION`, `identifiers.ios`→`BUNDLE_ID`) | generation (CI) | app identity by its source of truth: the app's name, version, bundle id |
| `$(BUILD_SETTING)` | left verbatim → **Xcode** substitutes | every build | bundle-id-derived values |

`{{ config.key }}`, `{{ env.NAME }}` and `{{ app.path }}` are filled by the
generator and baked into the produced `Info.plist` / `Runtime.entitlements`.
`$( )` is *not* touched
— it stays in the file and Xcode expands it on every build (CI, local, the
customer's workspace zip). Bare `{{ key }}` is shorthand for `{{ config.key }}`.

**Decision rule:**

- The value is the **app's identity derived from the bundle id** (a group name,
  a URL-type name) → `$(PRODUCT_BUNDLE_IDENTIFIER)`. It must stay correct even
  after the pipeline rewrites the bundle id, so it can't be baked early.
- The value is the **app's own identity by name** (its display name, version,
  bundle id) → `{{ app.path }}` — App.json is the source of truth, the legacy
  trigger vars keep old builds working (the watch app's `CFBundleDisplayName`
  = `{{ app.name }}` is the live example).
- The value lives in **`settings.env`** already (team id, an associated URL) →
  `{{ env.NAME }}`.
- Everything else — anything a client sets per app → **`{{ config.key }}`.**
  This is the default and the most powerful: it's the surface
  `core_packages.json` writes.

> Unresolved `{{ }}` tokens **warn and ship as-is** (visible in the build log) —
> a missing config value never silently blanks a key.

### Typed adoption + array splice — the powerful part

A placeholder normally interpolates as text (`"https://{{ env.API_HOST }}/v1"`).
But a string that is **wholly one token** adopts the resolved value's **type**:

```jsonc
// config.json:  "tiers": { "value": ["gold", "silver"] }, "max": { "value": 5 }
"infoPlist": {
  "XFeature": {
    "tiers": ["{{ config.tiers }}"],   // a config Array SPLICES into this array
    "max":   "{{ config.max }}"        // lands as a typed Integer 5, not "5"
  }
}
```

→ `XFeature.tiers = ["gold", "silver"]` (the one-element wrapper array is
replaced by the list's contents — *splice*, not nest), `XFeature.max = 5`
(Integer). A config Bool lands as a Bool. **This is how a list-valued plist key
or entitlement becomes per-app data** — `CFBundleURLSchemes`,
`com.apple.developer.associated-domains`, `LSApplicationQueriesSchemes`,
`UIBackgroundModes`.

---

## 2. `config.json` — the per-app surface

One entry per key. The codegen reads only `value`; the rest is metadata for the
config UI and humans:

```jsonc
{
  "associated_domains": {
    "friendly_name": "Associated domains",   // SHORT label for the config UI (REQUIRED)
    "friendly_description": "Web domains whose links open directly in the app (universal links and saved passwords).", // one plain sentence (REQUIRED)
    "type": "list",                  // string | number | boolean | list | json,
                                     // or a string REFINEMENT: color | url | multiline | secret (REQUIRED)
    "value": [],                     // the DEFAULT (here: contribute nothing)
    "editable": true,                // false = fixed; hide from a config UI
    "placeholder": "applinks:myapp.com", // OPTIONAL ghost text while the field is unset ("")
    "_note": "Universal links / web credentials, e.g. [\"applinks:myapp.com\"]."
  }
}
```

- **`friendly_name`** is a SHORT human label (2–3 words: "Permission prompt",
  "API token") a config UI shows instead of the raw key. Required —
  `prepare_config` warns on a key without one. Metadata only: codegen reads
  just `value`.
- **`friendly_description`** is one plain-English sentence for a
  non-technical user — what the setting does, where it shows up. Also
  required. The technical contract (plist keys, merge rules, shapes) stays in
  `_note`.
- **`type`** declares the value's shape *and* the dashboard control — the five
  base shapes `string` | `number` | `boolean` | `list` (of strings) | `json`
  (object / array of objects), plus the **string refinements** that pick a
  richer editor control while validating as plain `string`:
  - `color` — hex color (`#RRGGBB` / `#RRGGBBAA`) → color picker.
  - `url` — a full `http(s)://` URL → URL field. (Bare domains/paths stay `string`.)
  - `multiline` — user-facing prose that wraps (permission usage strings,
    alert bodies) → textarea.
  - `secret` — a value the editor must mask and never echo (API secrets,
    tokens, license codes) → masked input. Publishable client identifiers
    (ad-unit ids, app ids, public API keys) stay `string`.

  Required; the committed default must match the (base) shape —
  `prepare_config` warns on a mismatch, plus format tripwires on `color`/`url`
  defaults — and `apply_core_config` **validates every `core_packages.json`
  override against it** — a wrong-shaped override is warned and skipped, never
  written. The one exception: `""` is the universal *unset* placeholder and
  passes for any type (e.g. a `json` seed whose default is "no seed").
- **`placeholder`** (optional) — SHORT ghost text the editor shows while an
  editable field is unset (`""`): a concrete format example
  (`"1:1234567890:android:abc123"`, `"staging.example.com"`), never a
  sentence. Meaningless on booleans and `editable: false` keys
  (`prepare_config` warns).
- **`options`** (optional) — the closed value set; its presence turns the
  control into a **select** (multi-select when `type` is `list`). Every entry
  must be a non-empty value of the declared (base) shape the code actually
  accepts, and the committed default (plus any `ios`/`android` override) must
  be `""` or in the set. `apply_core_config` skips any per-app override
  outside the set — declare `options` only for a set the module genuinely
  closes (an enum in the consuming code), never as a style preference.
- **`value`** is the committed default. It must produce a *working template
  build* on its own (the literal `"URLSCHEME"`, Google's test ad id, an empty
  list). A client overrides it; they don't have to.
- **`_note`** is the contract for whoever sets it — say exactly what shape and
  what it maps to. This is documentation that ships.
- **`editable: false`** marks a value the app can't change (a fixed framework
  constant) so a config UI greys it out.
- Keys become Swift property names verbatim where the module has code, so they
  must be valid identifiers (`snake_case` or `camelCase`, no dashes).

### Per-platform values — `"ios"` / `"android"` entry keys (RARE)

An entry may **rarely** carry platform overrides at the entry level, mirroring
`App.json` `identifiers.{ios,android}` and the markup `:ios`/`:android`
attribute suffixes:

```jsonc
{
  "ua_suffix": {
    "friendly_name": "User-agent suffix",
    "friendly_description": "Marker appended to the web view's user agent.",
    "type": "string",
    "value": "DespiaApp",     // the cross-platform DEFAULT
    "ios": "DespiaApp-iOS"    // iOS builds resolve this; Android keeps "DespiaApp"
    // "android": "…"         // either platform key may be omitted
  }
}
```

**Resolution order** (build time, per platform): the running platform's key
(`ios` on the iOS build, `android` on the Android build) **?? `value`**. No
`value` *and* no key for the running platform ⇒ the key resolves to nothing on
that platform — exactly like an absent entry (no typed property, no
`dsx.config` face; a `{{ config.key }}` placeholder warns unresolved). Every
platform-resolved value must match the declared `type` (`prepare_config`
warns per key: `value`, `ios`, `android`).

Use this **only when one shared knob genuinely needs a different value per
platform**. It is NOT for platform-specific *capabilities* — a key that only
exists on one platform stays a separate per-platform **key** (the established
convention: Firebase's `android_app_id`/`android_api_key`/… and RevenueCat's
`androidApiKey` are Android-only keys beside the iOS ones, and stay that way).

`core_packages.json` can set the platform values too: a value that is an
object with **only** `value`/`ios`/`android` keys **merges per-key into the
entry** (setting `{ "ios": … }` preserves an existing `android` override and
the default), instead of replacing `value`. Any other object — e.g. a
`json`-typed seed, whose keys are its own — is a plain value and replaces
`value` as always. Each merged key is type-checked individually.

### Value types — JSON is JSON

A `value` may be **any JSON type**; never escape JSON into a string. The
declared `type` names the shape; the codegen maps each onto Swift:

| `type` | JSON `value` | Swift property | Notes |
|---|---|---|---|
| `string` | `"text"` | `String` | |
| `number` | `42` / `1.5` | `Int` / `Double` | |
| `boolean` | `true` | `Bool` | |
| `list` | `["a", "b"]` | `[String]` | scalar lists stay typed lists |
| `json` | `{ ... }` or `[ { ... } ]` | `String` (canonical JSON) | structured values arrive serialized — parse with `JSONDecoder` |
| *localized* | `{ "default": "…", "de-DE": "…" }` | `String` (computed) | a string that varies by device locale: `self.config.key` auto-resolves (`dsx.config.key` introspects); a plist-bound one also generates `.lproj` + `CFBundleLocalizations`. See [localization.md](localization.md) |

So a structured seed is written — in the module default *and* in
`core_packages.json` — as **real JSON**:

```jsonc
// core_packages.json — real JSON, no \" escaping
{ "QuickActions": { "legacy_shortcuts": { "shortcuts": [
  { "title": "Open Apple", "redirection_link": "https://apple.com" }
] } } }
```

and the module reads it back with one decode:

```swift
struct Seed: Decodable { let shortcuts: [Item] }
let seed = try? JSONDecoder().decode(Seed.self,
    from: Data(config.legacy_shortcuts.utf8))
```

### Two delivery paths — know which tier you're in

| Module tier | How a client sets config | Mechanism |
|---|---|---|
| **Mandatory / Core** (built-in) | `core_packages.json`, keyed by module name | `apply_core_config.rb` fans it into each module's `config.json` before the build |
| **Custom** (per-app) | ship the module's **own** `config.json` values | the whole `Custom/<Name>/` folder is copied in from the zip's `iOS/Custom/` |

```jsonc
// iOS/core_packages.json — configures BUILT-IN modules by name
{
  "App":       { "associated_domains": ["applinks:myapp.com"], "url_schemes": ["myapp"] },
  "AdMob":     { "gad_app_id": "ca-app-pub-1234~5678" },
  "Camera":    { "usage_description": "Scan show QR codes to pair your TV" }
}
```

Unknown module/key names in `core_packages.json` are **warned and skipped**, so
a stale entry can't corrupt a build. A **Custom** module is *not* configured
via `core_packages.json` — it carries its own `config.json` in its folder.

---

## 3. Dynamic entitlements — the triangle

Entitlements are where "powerful" lives: universal links, app groups, keychain
sharing, HealthKit, Sign in with Apple, a vendor SDK's entitlement. Three
declarations move together, **all in the one manifest**, nothing hardcoded in
the build:

```jsonc
{
  "name": "MyFeature",
  "capabilities": ["ASSOCIATED_DOMAINS"],                 // 1. App Store Connect: register on the App ID
  "entitlements": {                                       // 2. Runtime.entitlements: the actual key
    "com.apple.developer.associated-domains": ["{{ config.domains }}"]
  }
}
// 3. config.json:  "domains": { "value": [], "_note": "applinks:/webcredentials: entries" }
```

1. **`capabilities`** — the App Store Connect capability name(s). Recorded to
   `.plugin_capabilities.json` for the signing step to enable on the App ID /
   provisioning profile. (Per-target form for extensions:
   `{ "Runtime": ["PUSH_NOTIFICATIONS"], "MyExt": ["APP_GROUPS"] }`.)
2. **`entitlements`** — the literal entitlement key + value merged into
   `Runtime.entitlements`. Its value is a placeholder template like any other.
3. **`config.json`** — the per-app data the entitlement value splices in.

Nothing about a specific capability is special-cased in `prepare_modules`: the
capability name, the entitlement key, and the value are all JSON you wrote, so
**any** capability Apple offers works the day it ships, with no script change.

> **The capability must be on the provisioning profile.** `prepare_modules`
> compares your declared entitlements against `profile_info.json` (produced by CI
> before it runs) and **warns early** when the profile doesn't carry the
> capability — turning a late codesign failure into a clear message. Enable it on
> the App ID and regenerate the profile.

### The shipped lever: universal links

`Mandatory/App` already ships this exact pattern as a turnkey lever:

```jsonc
// DSX/Modules/Mandatory/App/dsx.json
"entitlements": {
  "com.apple.developer.associated-domains": ["{{ config.associated_domains }}"]
}
// core_packages.json:
{ "App": { "associated_domains": ["applinks:myapp.com", "webcredentials:myapp.com"] } }
```

The list splices into the entitlement, **union-merged** with the `settings.env`
`APPLINKS_URL`/`WEBCREDENTIALS_URL` pipeline route and any other module's
domains. Both delivery paths coexist.

---

## 4. Composition — modules add, never overwrite

Multiple modules contributing to the same key is the normal case, and it's
safe:

- **Arrays union + de-dupe.** Two modules each adding a deep-link URL type, an
  associated domain, a background mode, an app group → all of them land. A
  module can never clobber another's entry.
- **Dicts deep-merge.** Two modules can each contribute different keys inside a
  nested dict (e.g. `NSAppTransportSecurity` sub-keys).
- **Scalars: first declarer wins, ordered Custom → Mandatory → Core.** So a
  per-app **Custom** module overrides a built-in's scalar (a usage string, an
  SDK id) just by declaring the same key — differing losers log a warning.
- **Manual content in the target file always wins** over a module and is never
  stripped (mirrors the unmanaged-pods rule).

Because each contribution is provenance-tracked in the lockfile, **excluding a
module removes exactly its additions** — its keys, its array elements — and
nothing else. A capability ships and drops with its module.

### Two modules declaring the same key

When two enabled modules legitimately need the *same* plist key (the two
`Location` modules share location usage strings, `PhotoLibrary` + `CameraRoll`
share `NSPhotoLibraryAddUsageDescription`), give them the **same config key
name** and override the value on **both**. Identical scalars merge silently; the
shared config key keeps them in lockstep.

---

## 5. Files & folders — the placement system

A module places any **file or folder** into the build via `files` — a
declarative *source → destination* map, fully JSON-driven (no per-asset CI
step). Full reference: [manifest-dsl.md → files](manifest-dsl.md). The patterns:

- **A file iOS/an SDK reads by name** (a plist, a font, a JSON seed) →
  `{ "path": "X" }`. Commit the default in the module; the synced group bundles
  it at the **bundle root**; a per-app build overrides it from `iOS/Modules/<Pkg>/X`,
  and `{{ config.* }}`/`{{ env.* }}` placeholders fill text templates.

- **An arbitrary per-app set** (sounds, fonts, certs) →
  `{ "folder": "Snd", "asset": "ios_sounds", "pattern": "*.wav" }`. Every match
  in `iOS/Modules/<Pkg>/<asset>/` lands in the module and bundles at the root. No
  committed default ⇒ nothing ships until the client provides files.

- **Place at an arbitrary project path** (an on-disk build input, or a file a
  specific target/reader expects) → `{ …, "to": "Runtime/Cfg", "into": "project" }`.
  Verbatim copy; folders keep their structure.

- **Ship a folder *with structure* in the app bundle** (a web bundle with
  relative links, a resource pack) →
  `{ "folder": "site", "to": "WebRoot", "into": "project", "bundle": "folder" }`.
  This is the only way past the synced group's flatten — `prepare_modules` adds
  a folder reference, provenance-tracked so it drops when the module is excluded.

Best practices:

- **Default to `into: module`.** Bundle-by-name at the root covers almost
  everything iOS reads (sounds, fonts, plists). Reach for `into: project` only
  when a path is fixed by a target/SDK, and `bundle: "folder"` only when bundle
  *structure* genuinely matters.
- **A committed default is a working template.** Ship one (the empty
  `custom.js`, Google's test ad plist) so a zero-config build succeeds; the
  client overrides per app.
- **Don't commit a `project` placement's output.** It's materialized at build
  time from the module's committed source or the assets bundle — keep the
  source of truth in the module, not the placed copy.
- **Mind bundle-root collisions.** Two enabled modules placing the same
  basename at the root collide; the script warns. Give files module-specific
  names, or scope them with `bundle: "folder"`.

---

## 6. Safety rules (don't fight these)

- **An empty spliced list contributes nothing.** A `{{ config.list }}` that
  resolves to `[]` is pruned before the entitlements merge — the default-`[]`
  lever never creates an empty entitlement key, whose mere presence could demand
  a capability the profile lacks and fail codesign. Default optional levers to
  `[]`.
- **Reserved identity keys are generator-owned.** `CFBundleIdentifier`,
  `CFBundleName`/`DisplayName`, `CFBundleVersion`/`ShortVersionString`,
  `CFBundleExecutable`, `CFBundlePackageType` — a module declaring one is warned
  and skipped. Identity comes from `settings.env` + build settings.
- **A config-only module is fine.** A manifest-only permission/entitlement
  module needs no Swift; its `config.json` is consumed by the build (the `{{ }}`
  tokens), and `prepare_config` won't warn about a "missing Module class".
- **Validate locally:** `ruby ClosedSource/scripts/prepare_modules.rb` then read the
  `Info.plist` / `Runtime.entitlements` / `Podfile` diff. `--check` exits non-zero
  if anything is out of sync (use in CI); `--dry-run` previews without writing.

---

## 7. Worked example — a fully dynamic "powerful" module

A vendor SDK that needs a pod, a background mode, a keychain-sharing
entitlement, an SDK key it reads from `Info.plist`, and a URL type — every
client value per-app, the module excludable:

```jsonc
// DSX/Modules/Core/Acme/dsx.json
{
  "name": "Acme",
  "icon": "spark",
  "scheme": "acme",
  "version": "1.0.0",
  "pods": ["AcmeSDK"],
  "capabilities": ["KEYCHAIN_SHARING"],
  "entitlements": {
    "keychain-access-groups": ["$(AppIdentifierPrefix){{ config.keychain_group }}"]
  },
  "infoPlist": {
    "AcmeAPIKey": "{{ config.api_key }}",
    "UIBackgroundModes": ["fetch"],
    "CFBundleURLTypes": [
      { "CFBundleTypeRole": "Editor", "CFBundleURLSchemes": ["{{ config.callback_schemes }}"] }
    ]
  }
}
```

```jsonc
// DSX/Modules/Core/Acme/config.json
{
  "api_key":          { "value": "ACME_TEST_KEY", "_note": "Acme dashboard > API keys. Ships in the binary; not a secret." },
  "keychain_group":   { "value": "com.acme.shared", "_note": "Keychain access group suffix (after the team prefix)." },
  "callback_schemes": { "value": ["acme-cb"], "_note": "OAuth callback scheme(s); a LIST, all register." }
}
```

A client ships only what differs:

```jsonc
// iOS/core_packages.json
{ "Acme": { "api_key": "ACME_LIVE_xxx", "callback_schemes": ["acme-cb", "acme-cb-staging"] } }
```

Result, per app, no script touched: the live key lands in `Info.plist`, both
callback schemes register, the keychain group resolves with the team prefix at
build time, the `fetch` background mode unions into the app's, and
`KEYCHAIN_SHARING` is queued for App-ID registration. Drop `Acme` from
`excluded.json` and **all of it** leaves the build — pod, entitlement, key,
schemes, background mode.

> Note `$(AppIdentifierPrefix)` *combined with* `{{ config.keychain_group }}` in
> one value — Xcode-time and config-time substitution compose in a single string.

---

## 8. Checklist for a dynamic module

- [ ] Every client-settable native value is a `{{ config.key }}` placeholder,
      not a literal — including usage strings, SDK keys, domains, schemes.
- [ ] `config.json` `value`s are **working defaults** (a template build succeeds
      with zero `core_packages.json`).
- [ ] Each config key has a `_note` saying its shape and what it maps to.
- [ ] Optional list levers default to `[]` (so they contribute nothing until set).
- [ ] Bundle-id-derived values use `$(PRODUCT_BUNDLE_IDENTIFIER)`, not a literal
      or an `env` token.
- [ ] Every entitlement has its matching `capabilities` entry.
- [ ] Every placed `files` entry has a committed default (or is per-app only by
      design); destinations default to `into: module` unless a fixed path
      demands otherwise.
- [ ] Ran `prepare_modules` and read the `Info.plist` + `Runtime.entitlements`
      diff; re-ran for idempotency.
- [ ] The module is listed by name correctly so `core_packages.json` (built-in)
      or its own `config.json` (Custom) reaches it.

## Anti-patterns

- **A literal client value in a manifest** (a hardcoded domain, a real API key,
  a specific scheme). Make it `{{ config.* }}` with a sensible default.
- **A CI step that copies/patches a file for one feature.** That's the old
  model; the manifest + `apply_package_files`/`apply_core_config` cover it
  generically. If you're editing `codemagic.yaml` per-feature, it's wrong.
- **An entitlement without a `capabilities` entry** — it'll fail codesign with no
  early warning.
- **A non-empty default on an optional entitlement list** — it demands a
  capability every app's profile must then carry.
