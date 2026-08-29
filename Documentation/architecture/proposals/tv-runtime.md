# TV runtime — the living room is a surface, not a package

**Status: v1 — P1 FOUNDATION LANDED** (the TV module + both render backends +
the declared-target synthesis). Builds on `declared-targets.md` (the grammar
this surface is the first all-new consumer of), `../facet-contracts.md` (the
`tv` facet word), `watch-capabilities.md` (the surface-not-package law, quoted
below), and `system-defaults.md` (the unstyled baseline IS the platform).

## The law: TV is a surface of the one app

The wrist law transfers verbatim: *there is no "TV maps" package and there
never will be.* A capability's OWNER owns it on every surface — Media owns
playback on the TV, Maps owns maps on the TV. TV support is a **facet of the
owning module** (`provides: ["tv"]`, `ios/tv/` + `android/tv/` folders once
the facet folder fan-in lands), never a sibling package. Exactly ONE new
module exists — **`Core/Extensions/TV`** — and it is thin by law: it owns the
targets, the boot, the bundled screens, and the `tv` facet word. Nothing else.

```jsonc
"extensionTargets": [{
  "name": "TV", "platform": "tvos", "productType": "application",
  "facet": "tv", "embed": false,
  "sources": "TvApp", "runtime": ["tv", "logic"], "deploymentTarget": "17.0"
}],
"node": { "role": "tv", "screens": "TvApp/BundledScreens", "capabilities": [ … ] }
```

## Standalone by nature — the ladder without the relay rung

The watch is a *paired satellite*: bundled screens + a live phone link
(WCSession / the Data Layer), so its capability ladder has a relay rung
(`reach: ["watch"]`). **A TV has no companion process** — tvOS apps are
standalone and there is no paired-phone transport. The consequences are
load-bearing, not workarounds:

- **No relay rung.** No module declares `reach: ["tv"]`; the generated
  `tv-relay.generated.json` capability table is EMPTY and the screen
  static-lint therefore proves at build time that bundled TV screens call no
  phone-side module (`route.*` navigation excepted). A `dsx.module` call that
  someday should work on TV is a NATIVE FACET (rung 4), never a relay.
- **The runtime is local.** The TV target compiles the `tv` render tier plus
  the `logic` tier, so `{{ … }}` spans, `<action>` bodies, statement handlers,
  keyed timers and `await fetch(…)` all run ON the TV against the app's own
  backend (Kotlin: the full `:core` `JSERunner`, the Wear precedent). v0 is
  rung 1 of the watch ladder — pure markup + local logic + network data, zero
  per-module native code — and it is a complete data-driven app.
- **Offline-first is the same floor.** Bundled `BundledScreens/` boot with no
  network; `config.json`'s `host` / `start_route` / `ota_manifest` refresh
  routes + screens OTA over the bundled table (the watch OTA shape, verbatim —
  same manifest format, same cache-then-bundled resolution, same signature
  hook deferral).

## No WebKit on the big screen — web-optional, forced

tvOS ships NO WebKit: the web surface is *impossible* on Apple TV, and the
constitution already made that a non-event — the kernel names no WebKit
(Article 9), surfaces are swappable consumers, and Dom without a `tv`
realization answers absence through the ordinary typed envelope. Android TV
technically has a WebView, but the `:tv` APK deliberately ships web-free so
the two TVs stay honestly symmetric: ONE native DSX surface, the same `.dsx`
bytes. (A customer who wants their full phone app — WebView included — on
Android TV can leanback-enable the phone APK; that is an Android-only product
choice and never the unified story, because tvOS cannot follow.)

## Renderers — one backend per lane, no new grammar

Per the kernel's pattern (a render backend per form factor), TV adds exactly
two files, each consuming the shared AST + element table and painting the
10-foot system look:

- **`OpenSource/Engine/iOS/StackTV.swift`** — SwiftUI over serialized state
  (the StackWatch architecture: StackLive's registry + recursion, interactive
  tags on top). UIKit-free by rule 8 (it rides `DSXGraph::RUNTIME_TIERS['tv']`),
  which is also what makes it tvOS-clean. Focus is the SYSTEM's: SwiftUI's
  tvOS focus engine drives Button/Toggle natively — no focus grammar words.
- **`ClosedSource/RuntimeAndroid/tv/…/StackTv.kt`** — the Compose painter over
  `:core`'s snapshot tier (the StackWear architecture), leanback entry, D-pad
  focus via Compose's own focus system (focused state paints the TV highlight).

**No new authoring surface ships in P1 — deliberately.** The unified-codebase
law prices a new markup word at a corpus + three implementations; P1 adds
NONE (no `autofocus`, no focus groups). The existing corpus-pinned grammar
renders with each platform's native focus defaults. Focus words, TV defaults
tokens (`tvos` / `androidtv` columns beside `watchos` / `wear`), and any
`:tvos`-style exact-target suffix land LATER, fixtures-first, as one wave.

System defaults (the `system-defaults.md` slice): unstyled `text` inherits
each TV's type ramp; unstyled `button`/`toggle` render the platform's focusable
system controls; the authored-look eject gate is StackWatch's word set,
pinned in both backends' headers (the wrist-drift gate's TV row is staged with
the defaults wave).

## What lands when

- **P1 — the surface exists (THIS WAVE):** `Core/Extensions/TV` (manifest,
  config, TvApp boot/store/router/runtime, bundled screens), `StackTV.swift` +
  the `tv` tier row, the `:tv` gradle module (StackTv.kt + Tv* twins,
  leanback manifest), the empty relay table + screen lint, both preparers
  green. Compile status: Swift rides Codemagic (compile-pending, the repo
  law); `:tv` assembles with an Android SDK (the `:wear` class — no SDK in
  the local gate environment).
- **P2 — CI + store artifacts:** the tvOS archive lane (a standalone product
  archives its own scheme — it does NOT ride the phone archive the way the
  embedded watch does), the `:tv` assemble lane (lands together with the
  still-unwired `:wear` lane), brand-asset icon fill via generate_icons, per-
  app provisioning riding the existing fail-open reconcile.
- **P3 — the defaults + focus wave (corpus-first):** `tvos`/`androidtv`
  theme-token columns, the TV rows in the style-gate parity checks, any focus
  grammar — fixtures before implementations, three renderers.
- **P4 — native facets:** modules grow `ios/tv/` + `android/tv/` (the facet
  folder fan-in, `watch-capabilities.md` P1) — the `<video>` element on TV is
  the expected first consumer, following the `<map>` playbook.

## Per-app posture

The template ships the TV target ON (the Watch posture): the provisioning
reconcile fail-opens it per app — no tvOS profile, no TV product, no build
held hostage — and `excluded.json` removes `TV` outright. Universal purchase
(`bundleId` = the app's own identifier) is a per-app choice via the spec's
existing `bundleId` override; the default suffix keeps template builds inert.
