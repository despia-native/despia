# Native components: the custom-coded component primitive

> Audience: component authors whose component's **essence is platform machinery** — a
> video player, a web surface, a camera preview, a map — rather than markup. How ONE
> component tag is implemented as Swift + Kotlin + TypeScript twins without becoming
> three components. Companions: [component-props-and-state.md](component-props-and-state.md)
> (props/state semantics), [mounting-components.md](mounting-components.md) (native code
> mounting components), [native-languages.md](native-languages.md) (the C++ *below*-the-bus
> primitive — a different thing). Law: `Documentation/architecture/facet-contracts.md`
> (the unification law) + the unified-codebase law (monorepo working rules).

## The decision — markup or machinery

- **Markup component** — a `.dsx` file in `Components/`. Write once; it compiles into all
  three renderers' registries by construction. This is the default, and for ~95% of
  components the whole story. Markup **never** platform-forks: `lint_dsx` rejects a
  platform folder holding `.dsx` under `Components/` — platform adaptation happens *in*
  markup (conditional words), never as forked files.
- **Native component** — the component must own a real platform view or engine
  (AVPlayer/ExoPlayer, WKWebView, MapKit). Then: **one tag, one contract, three twins.**

Ask the essence question: *could this be markup?* If yes, it is markup.

## The shape — `<video>` is the exemplar

```
Mandatory/Foundation/
  Components/Media/Video/
    swift/Video.swift     ← iOS twin (AVPlayer) — the component's swift/ facet folder
    dsx.json              ← THE CONTRACT: tags, attributes, state keys, events —
                            pinned as "iOS AVPlayer / Android ExoPlayer"
  kotlin/
    MediaElements.kt      ← Android twin (ExoPlayer), registered by Foundation.kt
                            (the module's registration carrier)
  web/…                   ← web twin (the TS kernel implements the same element contract)

OpenSource/Conformance/elements/video.json    ← the fixture ALL implementations pass
```

The unity is not in the code — **the contract is data**. The component's `dsx.json` (plus
its conformance fixture) declares the attribute/state/event table once; each twin
implements *the contract*, never "the other platform's code."

## Contract first (the unified-codebase law applied at component scale)

A new native component lands as: the **contract** (its `dsx.json` + a fixture under
`OpenSource/Conformance/elements/`) → the TS implementation → the Kotlin twin
(gradle-gated) → the Swift twin (compile-pending, rides the build). Fixtures first, or it
doesn't ship — the same gate that keeps the three kernels identical everywhere else.

## iOS — `GlobalStackComponent`

```swift
final class Drawer: GlobalStackComponent {
    override class var tag: String { "Drawer" }        // defaults to the class name —
                                                       // keep file = class = tag
    override class func body(_ dsx: StackComponentContext) -> AnyView {
        AnyView(DrawerView(dsx: dsx))                  // real SwiftUI: @State, gestures, players
    }
}
```

- **Auto-registers at launch** — the same class sweep that finds `Module` subclasses; no
  wiring, no registration call. `aliases` adds extra tags (`text`/`label`).
- Consumer children render via the context's `slot()`.
- **Typed config**: a native component gets the same per-app `config` accessor a module
  gets — read as `Self.config.<key>` (the body is a class func, so the accessor is
  static), generated from its manifest/config.json.
- **One tag, one owner per build**: prepare_config *reserves* native tags, so a
  same-named `.dsx` global **fails the build** (and at runtime XML resolves first as the
  defense layer — the collision can't ship either way).
- `PrivilegedStackComponent` is the engine-granted tier for structural orchestrators
  (`list`/`pager`/`tabs`…) — not for feature components; you want the safe base class.

## Android — the module-facet twin

The Kotlin twin lives in the module's `kotlin/` facet and is registered by the module's
carrier (`Foundation.kt` → `MediaElements.register(dsx)`). Parity constants are
single-sourced with the element spec registry, so the spec and the implementation cannot
drift. **Divergences are pinned, never silent**: where the platform genuinely can't match
(no frame-extractor for scrub thumbnails; PiP is Activity-owned), the `.kt` header
documents each deviation + revisit condition, rolled up in
`ClosedSource/Documentation/android-status.md` — and the consumer's markup still runs,
degraded fail-open.

**Java?** The Android sourceSet compiles `.java` (`Core/WebSocket/kotlin/OkWsTransport.java`
is the live precedent) — keep the *registered seam class* in Kotlin (the scanners and the
carrier read the Kotlin class shape) and let Java back it.

## Web — the third twin

The TS kernel implements the same element contract; the conformance fixture runs per-PR
on TS. A facet a platform can't realize keeps the grammar and answers by **Article 7
fail-open**: an unknown tag renders nothing, gracefully — shared markup never forks.

## The laws

1. **One tag across platforms** — consumers cannot tell native from markup, and markup
   using the tag is byte-identical everywhere.
2. **The contract is data** — `dsx.json` + fixture; twins implement the contract.
3. **One owner per tag per build** — native reserves the tag; a same-named `.dsx` fails.
4. **Markup never platform-forks** (lint-enforced); native twins are per-platform *by
   nature* — Swift/Kotlin/TS is the only permitted difference.
5. **Absence is load-bearing** — a missing twin fail-opens; a divergence is pinned in the
   header + roll-up, never silent.
6. **One removal switch** — all twins live in the one module, so exclusion (and the
   cascade, for a nested module) drops the component on every platform at once.
7. **Standard component surface** — inputs are attributes, internal data is variables,
   two-way state rides bound keys, events dispatch render-safe `on:` handlers
   ([component-props-and-state.md](component-props-and-state.md)).

## Where the files live

**The platform facet folders — no platform is the default, no exceptions:** the Swift
twin lives in its owning folder's `swift/` (a module's `swift/`, or a component's
`Components/<Name>/swift/` beside its contract, as the exemplar above shows), the Kotlin
twin under `kotlin/`, the web twin under `web/` / the web kernel — one grammar, three
languages. The whole tree migrated to this shape; Swift outside a `swift/` facet folder is
the **dead legacy spelling** and a `check_module_rules` ERROR in every tier
(per-app trees are created from this repo post-migration — born canonical). The markup lint guards the other
direction: `.dsx` never sits under a platform folder — code twins do, forked markup never.

## Checklist

- [ ] Contract in the component's `dsx.json` (attributes · state keys · events)
- [ ] Fixture in `OpenSource/Conformance/elements/`
- [ ] Swift twin: `GlobalStackComponent`, file = class = tag
- [ ] Kotlin twin registered by the module's carrier; deviations pinned in the header
- [ ] Web twin passing the same fixture
- [ ] `android-status.md` roll-up entry for any pinned deviation
- [ ] No same-named `.dsx` (one owner per tag)
- [ ] Verified from identical markup on every renderer
