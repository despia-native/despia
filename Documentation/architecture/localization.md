# Localization — write it in English, ship it in any locale

**Status:** the kernel seam is implemented on ALL THREE renderers - Swift
(`OpenSource/Engine/iOS/DSXStrings.swift`), Kotlin (`Engine/Android core Strings.kt`) and the
web (`OpenSource/Web/packages/kernel/src/strings.ts`, wired at the dom display points via
`bindDisplay` so a locale write re-resolves LIVE, static markup included) - and corpus-gated
(`OpenSource/Conformance/strings/cases.json`: TS + Kotlin per-PR, Swift on the record lane).
The **build-pipeline table generator** is implemented (`ClosedSource/scripts/generate_strings_table.rb`,
drift-gated by `prepare_modules --check`); the on-device dynamic-translation module is the one
remaining scheduled tier. Web SSR emits the source language and the client re-resolves at
mount - the server twin's seam is a recorded later increment. **Decision:** localization of core UI is a
**kernel primitive** (a string-table *lookup*, first-party, always present); *translation* — how
tables get filled — is never the kernel's job (build machinery + an optional module).

## The authoring model

Apps are written in English, with **the English source string as the key** (gettext-style — no
manual key management, nothing to annotate):

```xml
<text value="Save"/>  <button label="Continue"/>  <textfield placeholder="Email address"/>
```

renders localized wherever a table provides a mapping, and renders the English **byte-for-byte
unchanged** wherever one doesn't (Article 7 — an app that ships no tables pays one dictionary miss).

## The three tiers

| Tier | What | Who fills it |
|---|---|---|
| **Kernel seam** (`OpenSource/Engine/iOS/DSXStrings.swift`) | `localize(_:)` at the text render points (text/label, button label, placeholders, alert/dialog chrome); locale ladder `global.locale` → device language → `en` | ships in the floor — data-driven, names nobody |
| **Build tier** | `Strings.<lang>.json` in the app bundle — flat `{ "Save": "Sichern" }`, full BCP-47 tag tried first (`pt-br`), then bare (`pt`) | the **build pipeline** — LANDED: `scripts/generate_strings_table.rb` extracts every static string from the app's markup (mechanical: fully-static inner text plus the display attributes the element catalog declares, per element, so `value` is copy on `<text>` and data on `<qrcode>`) **plus the kernel's own chrome literals**, into `ClosedSource/Strings/catalog.generated.json`. Machine translation and human review happen OUTSIDE it, in committed `ClosedSource/Strings/<tag>.json` maps; the generator then emits the shipped table to `Registry/Strings.<lang>.json` (iOS bundle) and `HostAndroid/src/main/assets/Strings.<lang>.json` (Android) — same bytes, keys pruned to what the app still renders, blank translations dropped. An untranslated key is simply ABSENT and falls back to English (Article 7) — the generator never invents a translation |
| **Runtime tier** | `global.strings.<lang>` merges **over** the bundle table; bump `global.strings.version` to re-resolve live surfaces | OTA table delivery today; the future **Translate module** (Apple's on-device Translation framework, ~20 languages, offline) fills *missing* entries and translates *dynamic/user* content on demand — an excludable Core module, never in the kernel |

An in-app language switcher is one state write: `global.locale = 'de'`.

## Deliberate boundaries (why not "just MT everything on device")

- **UI chrome is brand voice.** Short strings mistranslate without context ("Save" the verb vs the
  noun); raw MT ships typos onto buttons. MT belongs at BUILD time where a human can review, with
  the runtime tier as the fallback for what the build missed.
- **Length is a layout problem, not a translation constraint.** Constraining MT to source length
  produces garbage; German runs ~+35% and DSX layout already tolerates it (auto-layout, `minScale`,
  truncation attributes). Test with a pseudo-locale table (`"Save": "[~Šàvé~~~]"`), don't clamp.
- **Interpolated templates** ("Hello {{name}}") resolve before the seam, so only their exact
  rendered form can match a table — static chrome (the overwhelming bulk of UI text) is covered;
  per-user composites stay source-language until the Translate module lands (it owns dynamic
  content: template-aware lookup + on-device MT).
- **Plurals/dates/numbers** are locale FORMATTING, not translation — ICU rules, a later seam
  (`plural()` in JSE); the native date/number components already localize via the system.

## Constitution fit

Article 1: the kernel consumes tables from the bundle + state — vocabulary (`global.locale`,
`global.strings`), no module names. Article 4/5: tables are data, per-app, OTA-able. Article 7:
every miss is identity — nothing can brick, nothing changes for apps that don't opt in.
Article 8: the table format is a flat JSON map — the identical contract for the Kotlin renderer.
