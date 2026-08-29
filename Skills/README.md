# Despia Skills

Reference docs for **AI agents** (and humans) working with Despia. Two audiences,
two shelves: **app authors** write `.dsx` markup; **framework contributors** write
modules.

## Building an app (start here if you write .dsx)

The three app-authoring skills install into any project, for any agent host
(Claude Code, Cursor, Codex and peers): `npx skills add despia-native/skills`.
The pack is generated from the sources below
(`ClosedSource/scripts/generate_agent_skills.rb`), staged at
[`../AgentSkills/`](../AgentSkills/), and can never drift from them.

1. **[writing-an-app.md](writing-an-app.md)** - the working knowledge: the mental
   model, the element vocabulary map, state in order of preference, lists,
   navigation, and the mistakes generated code actually makes. **Start here.**
2. **[designing-an-app.md](designing-an-app.md)** - the design bar: structure
   before pixels, the token and type laws, the four states every screen has, the
   flows that decide whether an app sells, and verify-by-looking.
3. **[thinking-in-dsx.md](thinking-in-dsx.md)** - fluent in React / React Native?
   The translation table, the imperative-handle rule, habits to drop and keep.
4. **[examples/](examples/)** - a complete worked app (feed, detail, settings,
   onboarding, paywall) as a real project: lint it, build it, run it.
5. **[dsx-best-practices.md](dsx-best-practices.md)** - markup hygiene, rule by
   rule, each enforced by the linter.
6. **[custom-ux.md](custom-ux.md)** - bespoke gesture-driven controls from
   primitives. **[offline-best-practices.md](offline-best-practices.md)** -
   caching and offline UI state. **[writing-a-backend.md](writing-a-backend.md)** -
   the `<server>` document. **[writing-a-film.md](writing-a-film.md)** - the
   `<film>` document: a commercial rendered from the app itself.

## The module system (framework contributors)

Read these before adding, editing, or removing a module.

The authoring pattern is **DespiaScript** - the same `Module` + `dsx` + `JSON`
shape written in Swift and Kotlin on one runtime API. Not a new language. **Start
with [despiascript.md](despiascript.md).**

## What a module is

A module is a folder under `DSX/Modules/Core/` (shipped by default) or
`DSX/Modules/Custom/` (client-specific). It declares its native dependencies and
host integration in a **`dsx.json`** (the *property DSL*), and - if it has
behavior - ships Swift files that subclass `Module`.

Everything is driven by `ClosedSource/scripts/prepare_modules.rb`, which runs at build time
(the Despia CI/CD pipeline runs it, or you run it yourself - see
[building.md](building.md)). It reads every `dsx.json` and regenerates the
`Podfile` managed block, Swift Package dependencies, the generated app
`Info.plist` (`DSX/Modules/Mandatory/App/Info.plist` — identity skeleton +
every enabled module's `infoPlist`), `Runtime.entitlements`, extension
targets, and the Xcode source-membership - so
a module is added/removed by editing its folder, never by hand-editing the
project.

Two kinds of module:

| Kind | Contains | Example |
|------|----------|---------|
| **Manifest-only** | just `dsx.json` (permissions / host SDK pods) | `Camera`, `Microphone`, `Firebase`, `Stripe` |
| **Code-bearing** | `dsx.json` + Swift `Module` subclass | `HealthKit` |

## The skills

1. **[despiascript.md](despiascript.md)** - what DespiaScript is: the
   cross-platform module pattern (Swift + Kotlin), the runtime API, and the
   JSON payload builder. **Start here.**
2. **[module-system.md](module-system.md)** - architecture: discovery, build
   flags, exclusion, the sync group, what `prepare_modules` does.
3. **[manifest-dsl.md](manifest-dsl.md)** - the full `dsx.json` property
   DSL: every key, with examples. For a module authored partly in **C++** (a
   shared engine written once, driven from both platforms), the `languages`
   primitive + the C-ABI seam convention live in
   **[native-languages.md](native-languages.md)**.
4. **[dynamic-modules.md](dynamic-modules.md)** - **best practices for
   per-app native config**: the `{{ config.* }}` / `{{ env.* }}` /
   `$(BUILD_SETTING)` placeholder namespaces, typed adoption + array splice,
   `config.json` design, and **dynamic entitlements** (universal links, app
   groups, keychain, custom SDK keys — the capability ↔ entitlement ↔ config
   triangle). Read after the DSL reference to build powerful, fully-dynamic
   modules.
5. **[runtime-api.md](runtime-api.md)** - the native `Module`/`dsx` API
   (`resolve`/`error`/`event`/`broadcast`), the `JSON([...])` payload literal, and
   the web contract (`window.dsx`; legacy alias `window.despia`).
6. **[cross-module-calls.md](cross-module-calls.md)** - one module calling
   another at runtime via `dsx.module.<scheme>.<action>(args)` (await = result,
   bare = fire-and-forget — the native twin of `dsx.module`), without `import`-ing
   the target. Its data complement is **[module-state.md](module-state.md)** -
   reading typed variables another module *declares* (`dsx.module.<scheme>.context.<var>`),
   the structured replacement for `dsx.values("a.b")` magic strings.
7. **[writing-a-module.md](writing-a-module.md)** - step-by-step recipe for a
   new module.
8. **[extracting-a-module.md](extracting-a-module.md)** - move a host-woven
   feature (a `WebView/<Feature>Bridge.swift` + a `dispatchPackageURI` branch)
   into a module, keeping full backwards compatibility. Worked example: Stripe.
9. **[documenting-a-module.md](documenting-a-module.md)** - the house style for
   a module's in-folder `README.md`: lean, human, caller-facing - and what to
   leave out so docs don't bloat.
10. **[storage.md](storage.md)** - the `storage://` web API + `dsx.module.cdn.object("store")`
    over the native LocalCDN.
11. **[containers.md](containers.md)** - the shared App Group
    (`group.<bundleid>.container`) and `dsx.container`: one reserved group every
    module + extension shares, opted into with `"container": true`.
12. **[building.md](building.md)** - build in Xcode directly (no Despia CI/CD):
    run the scripts, `pod install`, open the workspace.
13. **[deploying.md](deploying.md)** - archive + ship to TestFlight / App Store
    from Xcode (no Despia CI/CD).
14. **[mounting-components.md](mounting-components.md)** - how native puts DSX on
    screen: `dsx.component.mount(.Player)` (generated refs — autocompleted,
    compile-checked), the dynamic string form (`"dsx.module.self.…"`), mount modes
    (page / overlay / sheets), and wiring the surface (`ui.variable` /
    `ui.action` / `ui.attribute` / `ui.on` / `ui.onAny`). Includes the **canonical
    full-screen recipe** (push + force the scheme + a filling `<zstack>` root), the
    **five rules for a screen that always renders**, and a **black/blank-screen
    troubleshooting** table — read it before debugging "I opened it but see nothing".
15. **[custom-ux.md](custom-ux.md)** - build bespoke controls in markup (custom
    seek bars, swipe-to-dismiss, press-and-hold, knobs): the pointer lifecycle
    (`on:dragStart`/`on:drag`/`on:dragEnd` + the `dsx.this` payload), `measure`
    (size → state), and the bindable transforms — gestures write state,
    transforms read it.
16. **[cookies.md](cookies.md)** - `dsx.cookie`: one jar across the web layer,
    native HTTP, and DSX — read `dsx.cookie.name`, write `dsx.cookie.name = "…"`.
17. **[web-crypto.md](web-crypto.md)** - the **Web Crypto API in JSE, 1:1**:
    `await crypto.subtle.digest/encrypt/sign/deriveBits/…` mapped to
    CryptoKit/CommonCrypto/SecKey (no JS engine), byte arrays, CryptoKey dicts,
    and the companion globals (`Uint8Array`, `TextEncoder`, `btoa`, …).
18. **[js-core.md](js-core.md)** - the **JS core globals**: `URL`/`URLSearchParams`,
    the fetch companions (`Headers`/`Request`/Response shape/`FormData`/`Blob`/
    `AbortController`), `Date`, `Intl.*`, `JSON` + URI encoding, `Math`,
    `structuredClone`, and `await Promise.all/race/allSettled` — computational
    completeness for app logic; capabilities stay modules.
19. **[security.md](security.md)** - the security model: **source-anchored,
    transitive trust** (trust attaches to where code was loaded from — bundled,
    allowed web host, configured remote source; per-call allowlists were
    considered and rejected), what's ENFORCED today (total evaluation, budgets,
    surface-scoped resources, log redaction, build-time exclusion), the load
    gate, and secrets guidance.
20. **[lifecycle.md](lifecycle.md)** - the lifecycle CONTRACT: every resource
    (state, timers, sockets, in-flight awaits, video, audio session) × every
    transition (dismissal, overlay removal, background, return, process death) —
    the three laws (surface-scoped by default · orphan completions are safe
    no-ops · background = suspended, modules own true background work).
21. **[android/](android/)** - **DespiaScript on Android**: the Swift ↔ Kotlin
    mapping for porting (or co-authoring) a module - the `dsx` API, `dsx.json`
    → Gradle / `AndroidManifest.xml`, and `dsx.container` → DataStore. Includes
    **[android/js-core-parity.md](android/js-core-parity.md)** — the JS-core
    parity CONTRACT (API → required Kotlin mapping + divergence traps) and the
    conformance fixture table both runtimes must pass.
22. **[global-state.md](global-state.md)** — the app-wide reactive store `global.*`:
    `{{ dsx.global.x.y }}` (DSX) / `dsx.global.x.y` (native dot notation), the four state
    layers (global / surface / component / web), and `window.dsx.global`.
23. **[white-label.md](white-label.md)** — `dsx.global.strings` / `dsx.global.theme`: the app's cross-module
    text + token overrides (defaults ⊕ app-global ⊕ per-call) and the module-author recipe.
24. **[localization.md](localization.md)** — the four localization planes; localized
    `config` values (`{ default, <locale> }` → auto device-locale + `.lproj` /
    `CFBundleLocalizations`) vs **`dsx.global.strings`** (app-driven); the `dsx.config` introspection API.
25. **[surface-bridges.md](surface-bridges.md)** — mounting a RENDER SURFACE on the
    bus (`dsx.messenger`): the five pieces (host component, load gate, bridge module,
    transport, content-side SDK), the egress/envelope contract, SDK promise semantics
    (ids, timeouts, listener filtering), and the trust + lifecycle laws. `<DSXWebView/>`
    (web) and `<Godot/>` (game) are the shipped twins; the checklist covers surface
    number three.
26. **[style-catalog.md](style-catalog.md)** — the machine-readable **style-panel schema**
    (`stack-style-properties.json`): every DSX style attribute as a typed, constrained control
    (number / enum / color / toggle) for building a Webflow/Craft.js-style editor. Covers what
    consumes it and — the point — **how to keep it in sync** with the engine's style parser via
    `ClosedSource/scripts/check_style_catalog.rb`.
27. **[module-frameworks.md](module-frameworks.md)** — **binary dependencies without
    committing binaries**: the `build` manifest primitive + its tools (`fetch` a pinned
    prebuilt, `cmake-android` an NDK-linked native lib, `godot` an in-repo export) and
    the **locator + `dsx.lock.json`** flow — write `"from": "npm:pkg@1.2.3"` (or
    `github:` / `jsdelivr:` / a URL), run `build_frameworks.rb --lock` once, done. The
    mechanism-choice table (pods / spm / gradle / weights / fetch / cmake-android /
    godot / languages) lives here. Siblings:
    **[module-weights.md](module-weights.md)** (large ML blobs bundled as resources)
    and **[module-secrets.md](module-secrets.md)** (build-time credentials).
28. **[live-activities-and-widgets.md](live-activities-and-widgets.md)** — authoring
    the OS surfaces (Lock Screen · Dynamic Island · widgets · watch Smart Stack):
    the `<activity>` slot anatomy and per-slot fail-open, **always author
    `<small>`** (the watch card is not the phone card), the island's clipped
    `.bottom` region and the renderer's default insets, gauge stroke-inset
    guarantees, the `WidgetBundle`/`Widget.body` **Swift shape laws** (no
    builder branches; OS-conditional sets branch in `static main()`), and how
    snapshot data reaches the card.
29. **[porting-a-react-native-library.md](porting-a-react-native-library.md)** — **"ship this
    npm package for Despia"**: the triage (component · capability · non-port), the API
    translation table (props → attributes, `ref.current.clear()` → a bound value, hooks →
    modules, `Animated` → the motion kernel), the contract-first order across four renderers,
    the complete ledger/census list a catalogued element touches, and the refusal list — the
    packages that exist only because React Native lacks what the kernel already has. Worked
    example: `<Signature>`, ported from the RN signature pads that wrap a `<WebView>`.

## Golden rules

- **Lint before you ship DSX**: `ruby ClosedSource/scripts/lint_dsx.rb` (add `--strict` in CI). It
  resolves component/`dsx.module` refs against the same scan the build bakes, so a typo
  is a located error here instead of a silent null at runtime.

- **Touching a style attribute in `Stack.swift`?** Update the style catalog and run
  `ruby ClosedSource/scripts/check_style_catalog.rb --strict` — it fails if the engine's style keys
  and `stack-style-properties.json` disagree (see [style-catalog.md](style-catalog.md)).

- **Never hand-edit `Runtime.xcodeproj`, the `Podfile` managed block, or
  `Info.plist`/entitlements for a module.** Edit the `dsx.json` and let
  `prepare_modules` regenerate.
- **Never call `webView.evaluateJavaScript(...)` from a module.** Use the `dsx`
  emit API (`dsx.resolve`/`dsx.error`/`dsx.event`); project legacy window globals
  through the Dom module (`try? dsx.module.dom.set(...)` / `.call(...)` — the
  old native `dsx.variable`/`dsx.function` verbs are removed).
- The engine lives in `OpenSource/Engine/` (the Swift kernel in `iOS/`: `Module.swift` — `Module` +
  `ModuleRegistry`, `Context.swift` — the dsx DSL incl. `dsx.module`,
  `Bridge.swift` — `Bridge`/`VirtualBridge`, `Stack.swift` — the DSX/JSE engine;
  the page runtime is `OpenSource/Engine/runtime.js`; the per-app injected
  `custom.js` is the **Dom module's**
  declared file, not engine). `Registry/` holds only **generated** output
  (`*.generated.swift`). Modules live in `DSX/Modules/`. Don't mix them.
- Every module is **on by default**; drop one by listing it in
  `DSX/Modules/Config/excluded.json`.
