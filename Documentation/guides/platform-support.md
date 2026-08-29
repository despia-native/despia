# Platform support: what the cross-platform claim is measured to mean

> **A note on paths.** This guide is written in the Despia monorepo, where the open tree
> you are reading lives under `OpenSource/` and the commercial layer lives in a sibling
> PRIVATE tree that is not part of this drop. An `OpenSource/X` path is `X/` in the
> public repository; a bare `scripts/…` path below belongs to the private tree and is
> named for the record, never as something to run from what you have.

One `.dsx` document renders on three kernels: Swift on iOS, Kotlin on Android, TypeScript
on the web. This page says exactly how much of that is **measured** today, element by
element, so you can plan against evidence instead of a slogan. Every number below either
names the generated file it is read from or the command that produced it, so you can
re-derive all of it yourself.

## The short version

- **Behavior** (what a document computes, routes, throws, logs) is pinned by shared fixture corpora and is the strongest claim here.
- **Web rendering** is verified against a committed reference plane that every skin change re-records, so the reference diff is the review.
- **Native rendering** is held to a **budgeted near-pixel contract with a published gap ledger**, not to pixel identity. Two of the three capture lanes have not run on a device yet. Where that is the case, this page says so.
- **Nothing degrades silently.** An element the web renderer does not implement mounts a labelled placeholder, and it has a row in a ledger a test enforces.

## What is proven, and by what

| Claim | How it is proven, and where |
|---|---|
| The kernels agree on runtime semantics | The shared corpora under `Conformance/`: JSE, api, actions, errors, logs, chains, router, motion, split and more. TypeScript and Kotlin run them per pull request; Swift replays the same files on the record lane. |
| The Kotlin kernel is correct | `gradle test` in `Engine/Android`, per pull request and locally with no device attached. |
| The web renderer matches its own render | The committed reference plane in `Conformance/parity/`, re-verified by `npm run parity-oracle`. This one is run on demand, not in CI: a skin change re-records the plane in the same commit and the reference diff is the review surface. |
| The web renderer is accessible | An axe sweep over the rendered pages, per pull request. |
| Native rendering matches the web plane | `parity_native_diff.rb` against the capture lanes. Report-first today; see the next section. |
| The three sources hardcode the same design constants | `ruby scripts/check_renderer_constants.rb` (private tree) diffs a curated set (the split pane's resting widths, sheet detents, the coarse-pointer floor, per-element geometry, the token plane) straight out of the Swift, Kotlin and TypeScript sources. No toolchain, no device, and it is the only check the Swift column has that runs anywhere but a Mac. |

Measured on 2026-08-19 by running those commands on one Linux machine with no simulator,
emulator or device:

- **857 of 857** conformance assertions pass on both TypeScript executors (`npm run conformance`).
- **2,775 of 2,775** Kotlin kernel tests pass, zero failures and zero skips (`gradle test` across `:core`, `:render`, `:platform`, `:desktop`).
- **20 of 20** web parity planes verify against the committed reference (`npm run parity-oracle`: ten fixtures at both the phone and the desktop width).

## The native picture, stated plainly

The parity contract (`OpenSource/Conformance/parity/README.md`) is a **budget**, not an
equality. Layout boxes are allowed `max(8 px, 2% of the plane dimension)` per axis because
text measurement genuinely differs per platform font. Radii are held to 1 px. Type size and
weight are exact where the native capture resolved a value. Colors are **reported, not
enforced**, because native semantic colors are system-owned by design: the `ios` and
`android` columns of `OpenSource/Conformance/defaults/tokens.json` are role names, not
values, and the OS resolves them.

That is the design goal, and it is deliberate. A Despia app is supposed to look like the
platform it is running on, so "pixel identical to the web build" was never the target for
native. **Near-pixel within a published budget, with every knowing divergence written down
as a numbered gap row**, is the target, and the gap ledger in that README is where the rows
live.

Three capture lanes replay the same ten fixture screens through the real renderers:

| Lane | Runs on | Status today |
|---|---|---|
| Compose Desktop (`DesktopParityCaptureTest`) | JVM, offscreen, no device | **executes today**, per pull request. It proves the Compose element layer and the shared resolver. It is not an Android device capture and never stands in for one. |
| Android (`ParityCaptureInstrumentedTest`) | phone emulator | wired, awaiting a lane run |
| iOS (`ParitySpecimenRecord`) | the record lane | wired, awaiting a lane run |

Until the two device lanes have run, native fidelity is **verified by source review**, and
the component matrix says so per cell: `OpenSource/Conformance/library/matrix.json` records
234 web cells verified by executed probe, and every iOS and Android cell as review. That is
the honest state, and closing it is the next proof step, not a footnote.

## Web element support

The web renderer implements **60 of 79 canonical elements**, with 7 partial and 12
unsupported (71 of 94 counting aliases). The source of truth is
`OpenSource/Web/support/element-support.json`, and a test fails the build if a row is
added, removed, miscounted, or ships without a declared fallback.

### Partial: a real control, with a named limit

| Element | What you get, and what is missing |
|---|---|
| `chart` | Accessible SVG line, area, bar and point charts from bound data. Unimplemented series and axis options are omitted, never a blank canvas. |
| `lightbox` | Top-layer gallery: modal presentation, keyboard and RTL paging, pointer swipe, drag dismissal. Native pinch and double-tap zoom are absent; browser pinch-zoom still works. |
| `map` | An offline coordinate plane with accessible pins and pointer/keyboard pan and zoom. Tiles, routes and regions are absent. |
| `wheelpicker` | An always-visible select list with static and bound options, label, disabled state and write-back. Inertial wheel physics and haptics are absent. |
| `WebView` | A policy-constrained iframe with lifecycle events, named controls, safe URL schemes and ephemeral isolation. Cross-origin script controls are inert rather than throwing. |
| `DSXWebView` | The same iframe at origin plus path, defaulting to this page's own origin. Bridge-dependent behavior is absent rather than imitated. |
| `DSXView` | Mounts the screen component from this build's compiled registry. A `src` this build does not ship renders a labelled unavailable card. |

### Unsupported: an honest placeholder, never a lookalike

These mount a labelled `dsx-unsupported` marker carrying the element's own name. They are
native surfaces with no web equivalent worth faking.

| Group | Elements |
|---|---|
| 3D, panorama and game surfaces | `Scene3D`, `Scene360`, `Godot` (aliases `Model3D`, `Scene3DView`, `Panorama`, `GodotView`) |
| Studio audio and timeline tools | `StudioTimeline`, `StudioTrim`, `StudioPitchEditor`, `StudioShow`, `StudioTimecode`, `Waveform`, `LevelMeter` |
| Vector animation | `lottie`, which is a module element: register the `Core/Lottie` web facet and the tag fills in |

### Three universal attributes are inert on web

`exit` (root-only dismiss animation, deferred to the router's motion lane; `enter` covers
appear), `dynamicType` and `dynamicTypeMax` (the OS text-size ramp has no per-element web
equivalent, and rem-based sizing already follows browser text scaling). Each is a divergence
by decision, recorded in the same ledger.

## What this means when you plan a build

- Author against the grammar, and expect the web build to be the one you can verify fastest and most completely today.
- If your screen depends on a Studio, 3D or panorama surface, plan it as native-only and give the web build a different screen; the placeholder tells your users the truth but it is not a design.
- Expect native to look like its platform, because that is what it is built to do. If you need a control to look identical everywhere, style it explicitly rather than relying on the unstyled baseline, which is deliberately the system component on each OS.
- Treat the gap ledgers as the contract. A divergence that is not a row in one of them is a bug, and reporting it is welcome.
