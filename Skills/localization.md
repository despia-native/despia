# Localization

> How text and OS-presented strings localize across the runtime. Audience: module
> authors **and** app authors. See also [white-label.md](white-label.md) (the `dsx.global.strings`
> resolution recipe) and [global-state.md](global-state.md) (`dsx.global`).

There are **four localization planes**, each with its own owner and its own *selector*
(who picks the language). Choose by **what** you're localizing — don't reach for one
plane's tool on another's problem.

| Plane | What | Mechanism | Language picked by |
|---|---|---|---|
| **Origin** | which web host/origin loads | `App.json` `hosts` (per-locale) | **device locale** → host (automatic) |
| **Web UI text** | a web app's own copy | the web app's own i18n (HTML/JS) | the web app |
| **Native / DSX text** | text in native screens & modules | localized **config** + **`dsx.global.strings`** | config: **automatic** · `dsx.global.strings`: **the app** |
| **System strings** | iOS-presented: permission prompts, the home-screen app name, the App Store language list | generated `.lproj` / `InfoPlist.strings` + `CFBundleLocalizations` | **device locale** (iOS) |

The two that need the most explaining are **localized config** (the module author's
text, auto-localized) and **`dsx.global.strings`** (the app's cross-module overrides). They're
different on purpose — different owner, different selector.

---

## 1. Localized config values — the module author's text

Any value in a module's `config.json` may be a **scalar** (as always) **or** a
**locale map**:

```jsonc
"usage_description": { "default": "Scan QR codes.", "de-DE": "QR-Codes scannen.", "fr": "Scannez." }
```

- `default` is the development-language value; every other key is a **BCP-47 locale**.
- It **auto-resolves to the device language** — no app code, nothing to "set":
  - `self.config.usage_description` (the typed accessor) → the resolved `String`.
  - `dsx.config.usage_description` → a `DSXConfigValue` for introspection (below).
- A scalar value (`"usage_description": "Scan."`) keeps working unchanged.

Resolution order (`DSXLocale.pick`): exact tag (`de-DE`) → bare language (`de`) → `default`.

### `dsx.config` — introspect a config value at runtime

`self.config.<key>` gives the **resolved** value (the 95 % path). `dsx.config.<key>`
gives the locale-aware **view** — and works for ANY key, localized or a plain string:

```swift
dsx.config.usage_description.value              // resolved for THIS device
dsx.config.usage_description.default            // dev-language / fallback (scalar's own value, or "default")
dsx.config.usage_description.isLocalized        // Bool — does it have per-locale variants?
dsx.config.usage_description.locales            // ["de-DE", "fr"]
dsx.config.usage_description.byLocale           // full map incl. "default"
dsx.config.usage_description.forLocale("de-DE") // exact tag → language → default
dsx.config.enabled.bool / .int / .double / .list / .string   // typed scalar reads
dsx.config.some_typo.exists                     // false — unknown key, never crashes
```

So *"how do I know if a config value is localized?"* is `dsx.config.<key>.isLocalized`.

### If a localized value flows into the Info.plist → full native localization, free

When a localized config value is bound into a module's `infoPlist` —

```jsonc
// MyScanner/dsx.json
"infoPlist": { "NSCameraUsageDescription": "{{ config.usage_description }}" }
```

— the build (`prepare_modules`) automatically:

1. puts the **`default`** in the app `Info.plist` (a valid string, never a dict),
2. emits **`<lang>.lproj/InfoPlist.strings`** overriding that key per locale,
3. declares **`CFBundleLocalizations`** (the supported-languages list),
4. unions the locales into the project's **`knownRegions`**.

Result: a German device shows the **German permission prompt** (and localized app
name) — no hand-written `.lproj`, no Xcode wiring. Shipping a `de-DE` string is also
how you **declare German** to iOS and the App Store.

> Build-time + Codemagic-gated: the `.lproj` are generated into the App module and
> ride the synchronized group into the bundle — verified on the Codemagic build.

---

## 2. `dsx.global.strings` — the app's cross-module text

`dsx.global.strings` (≡ `global.strings`) is a slot in the one global store the **app** fills to
override or translate user-facing text across every module at once (white-labeling).
It is **app-driven**: the platform does *not* auto-switch `dsx.global.strings` by device language
— the app reads the device locale (`navigator.language` / `Locale.preferredLanguages`)
and writes the matching table at boot.

Set it (the **app**, not a module):

```js
window.dsx.global   // global.strings = { coins: "gems", save: "Guardar" }
```
```swift
dsx.global.set("strings.save", "Guardar")          // or DSX:  set: dsx.global.strings.save = 'Guardar'
```

Read it (a module, as an override layer over its own defaults):

```swift
let label = dsx.global.strings.save.string ?? dsx.config.save_label.value
//          app override (most specific)        module's localized default
```

The full **module-author resolution recipe** (defaults ⊕ `dsx.global.strings` ⊕ per-call payload,
set as root attributes for markup to read `{{ dsx.attribute.save }}`) lives in
[white-label.md](white-label.md).

---

## 3. The two selectors — the distinction to remember

| | **Localized config** | **`dsx.global.strings`** |
|---|---|---|
| Owner | the module author | the app |
| Form | declared **data** (`config.json`) | runtime **global state** |
| Language picked by | the **platform** (device locale, automatic) | the **app** (it sets the table) |
| Use for | a module's own text + its system strings | rebrand / translate across modules |
| Read | `dsx.config.x` / `self.config.x` | `dsx.global.strings.x` / `{{ dsx.global.strings.x }}` |

They **compose** — most specific wins:

```
module localized-config default   ⊕   app dsx.global.strings   ⊕   per-call payload
(automatic, per device locale)         (app-driven)        (one call)
```

A module ships auto-localizing config defaults; the app can still override any key per
locale via `dsx.global.strings`; a single call can override one key.

---

## 4. Scope note — web vs native

- **Pure web app** (`DSXWebView`): its own text is the web app's i18n; the host already loads
  the right **origin** per locale via `App.json` `hosts`.
- **Native / DSX**: `dsx.global.strings` (app-set) ⊕ localized **config** (platform-set) ⊕ per-call.

So localized config + `.lproj` is the layer the web plane can't reach (permission
prompts, app name), and `dsx.global.strings` is the app's lever over native/DSX copy.
