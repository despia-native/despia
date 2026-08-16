# StackWatch — DSX on watchOS (1:1 with iOS & Wear OS)

`StackWatch.swift` renders a Stack **XML layout + state** into **watchOS SwiftUI**. It is the
watch sibling of `StackLive` (widgets / Live-Activities): **one grammar, a backend per
surface** (`StackNode.swift`). It consumes the same shared AST (`StackNode` / `StackXML` /
`StackScope`) and reuses `StackLive`'s element registry + recursion verbatim, adding the
tags a watch screen needs that a widget can't have — the interactive `button`, the native
`toggle` (alias `switch`) — plus a watch `text` override for the wrist type ramp
(`list`/`scroll`/`divider` live in the shared base table, rendered by every tier).

**System defaults (system-defaults.md, the wrist slice):** an UNSTYLED element renders the
watch's own system component — a screen whose spine is a bare `<list>` renders ONE real
SwiftUI `List` (`.automatic` platter rows; header/footer siblings ride as clear rows), bare
`<text>` inherits the system body ramp / semantic label color / wrapping, a bare `<button>`
is the watch's own bordered button, `<toggle bind="x"/>` is the native switch. Every
authored attribute still applies ABOVE the defaults (the ladder: defaults &lt; author
styles), and an authored box (`bg`/`radius`/`padding`/`spacing` on the spine) ejects that
element back to the hand-drawn path — pre-defaults markup renders byte-identically.

```
 PHONE (the bus)                 WatchConnectivity            WATCH (this renderer)
 ───────────────                 ─────────────────            ─────────────────────
 dsx.module.watch.render({…})    sendMessage / context   →    WatchStore.apply → layout+vars
 dsx.module.watch.route("/x")    (latest snapshot)            StackWatchView(layout:vars:emit:)
   ▲ dsx.fire("watch.tap")  ◄──   sendMessage(event)     ◄──    button tap → emit(name)
```

The watch is a **different device**, so the App Group / `dsx.container` does **not** reach it
(unlike a widget on the same device). WatchConnectivity is the transport — see
[Skills/containers.md](../../Skills/containers.md) ("A Watch companion would use WatchConnectivity").

## Why a render profile, not the full engine — and what the watch DOES run

> **Corrected 2026-07-25.** This section used to describe the watch as a pure "snapshot /
> no-JS renderer": *"the watch renders a pure function of that state. Interactivity is a name
> out, not code in … (no JS evaluated)"*, with the JSE runner filed under a hypothetical future
> "interactive tier". **That describes v1 and is no longer true.** The interactive tier landed
> (watch-runtime.md W1/W2/W3): the watch is a **live node** with a real JSE runtime. It is not a
> snapshot surface. Widgets and Live Activities still are.

`StackWatch` is a **render backend**, not a reduced dialect. The reason it exists is narrow and
purely structural: the kernel's full UI runtime (`Stack.swift`, `Router`) is UIKit-coupled and
doesn't compile on watchOS, so the watch gets its own SwiftUI painter over the SAME shared AST.
The LOGIC tier is not reduced — the JSE engine is Foundation, so it compiles and runs on the
wrist:

- **`{{ … }}` expressions** evaluate through the real JSE evaluator on-watch (W1), and
  `visible-if` gates on real value truthiness.
- **The head runs on the watch** (W3). `WatchRuntime.swift` mounts `<variable>` (initials and
  `computed="true"`), `<formula>`, `<action>`, and `<api>` blocks into ONE `WatchJSEState`
  shared by expressions and the `JSEActionRunner` (W2 — the grammar's fourth executor, the
  "satellite runner"). Per-screen `setTimeout`/`setInterval` are keyed and cancelled on
  navigation; `await fetch` runs watch-direct with the WCSession phone gateway as fallback;
  `route.*` writes drive the watch's own router.
- **`await dsx.module.<scheme>.<action>(…)`** resolves in-process where it can, and otherwise
  relays to the phone through the generated capability table (W4/W5), settling
  `unsupported_on_surface` / `unreachable` immediately rather than hanging.

So an `on:tap` is **not** limited to emitting a name. `tapEvent`'s name-relay path still exists
and is still the right shape for "the phone owns this action", but a handler body runs the
portable statement grammar locally. The package's own bundled screens rely on it —
`WatchApp/BundledScreens/demo-state.dsx` (variable initials + a computed variable + three
action bodies) and `demo-timer.dsx` (a `setInterval` started from an action) both run entirely
on-watch, in airplane mode, with no phone.

The phone-composed snapshot path (`dsx.module.watch.render({layout, vars})`) is still
supported and is still how the phone pushes a screen; it is one input, not the only tier.
What genuinely does NOT run on the wrist is listed under *Watch-safe component vocabulary*
below (`video`, web views, arbitrary animation) — a platform/vocabulary boundary, not a
"no logic" boundary.

## The element table is injected, not forked

`StackLive` exposes its element table through the SwiftUI environment (`stackTable`).
`StackWatchView` installs a **superset** table at the root (`StackBackend.elements` + the watch
tags), so child recursion renders the extra tags **without touching `StackLive`** — widgets,
which never set the environment, get the unchanged WidgetKit-safe set. Same "register an
element, never grow a switch" rule as the in-app engine, made injectable.

## Watch-safe component vocabulary

Renders on watchOS (and authored identically for iOS / Android):

- **Layout:** `vstack hstack zstack scroll spacer divider`
- **Content:** `text` (system body ramp when unstyled; `size`/`weight`/`color`/`lines` each
  apply when authored), `image` (`symbol`=SF Symbol name from the shared sf-map set —
  Material Symbols render the same name on Wear; `color`/`size`), `progress`, `gauge`
- **Interaction:** `button` (`label` or children — an `<hstack><image/><text/></hstack>`
  child is the icon-row anatomy; `tint` when authored; tap via `on:tap` / `event=` /
  `route=`), `toggle`/`switch` (`bind="key"` two-way store binding + `on:change`, the
  native watch switch / the Wear ToggleChip look), `list` (an UNSTYLED spine list renders
  the real watch `List`; a styled or data-bound one stays the hand-drawn stack)
- **Navigation chrome (the shell, not this renderer):** the screen ROOT's `title`
  attribute renders as the SYSTEM navigation title (the watch shell's NavigationStack /
  the WearRoot header). A `route=` tap PUSHES; back is the OS's — the watch back
  chevron / edge swipe, Wear's swipe-right back gesture. Screens hand-draw **no** title
  rows and **no** back buttons (the Workouts-app anatomy; empty/absent `title` ⇒ no
  header, fail-open — phone-rendered and OTA screens included).
- **Binding:** `{{ … }}` spans evaluate through the real JSE evaluator on the wrist
  (watch-runtime.md W1 — expressions, ternaries, `has()`), and `visible-if` gates elements
  with real value truthiness on BOTH wrists. Text goes in the element **body**
  (`<text>Hi</text>`), not a `value=` attribute.
- **Layout box** (every element): `padding`/`paddingh`/`paddingv`, `bg`, `radius`, `grow`,
  `opacity`, `align`, `spacing` — colors `primary/secondary/accent/white/#hex` (the named
  words are the semantic tokens; on Wear `primary`/`secondary` paint the Wear roles).

**Not** on the watch: `video`, web views (there is no WebKit on watchOS), and arbitrary
animation. Those stay on the phone. **Actions and expressions ARE on the watch** — see the
section above; the earlier "scripts/actions with JS" entry in this list was v1's snapshot-tier
restriction and no longer describes the runtime.

## Cross-platform — the 1:1 contract

The point of "names, not platforms": the **same `.dsx`** renders on three surfaces.

| Layer | iOS (this repo) | watchOS (this repo) | Android / Wear OS (runtime repo) |
|---|---|---|---|
| Grammar / AST | `StackNode` / `StackXML` | same (compiled into the watch target) | same parser ported |
| Render backend | `Stack.swift` (UIKit-coupled) | `StackWatch` (watch SwiftUI painter) | Compose (`:render`) / `StackWear.kt` (plain Compose) |
| Logic tier | `JSE` + `JSEActionRunner` | **same `JSE` + `JSEActionRunner`** (`WatchRuntime`, the satellite runner) | same `JseRunner` from `:core` (`WearRuntime.kt`) |
| Tap | `dsx.event('x')` / action body | action body on the satellite runner, or `tapEvent` name-relay → WatchConnectivity | same, `on:tap` → MessageClient for the relay half |
| Transport | in-process bus | **WatchConnectivity** | **Wearable Data Layer** (`MessageClient`/`DataClient`) |
| State | `dsx.variable` / `global` | `WatchJSEState` (rich values) + a stringified render-var mirror in `WatchStore` | `WearStore.jse` + the same stringified mirror |

(The truly snapshot-only tier in this repo is `StackLive`/`StackGlance` — widgets and Live
Activities. The watch shares their element table; it does not share their execution model.)

**Wear OS (landed):** `ClosedSource/RuntimeAndroid/wear` — `StackWear.kt` paints the same
:core-resolved element table in plain Compose over the Wearable Data Layer (`MessageClient`
for taps, persisted `DataClient` snapshot), with the Material-for-Wear defaults: chip
buttons, the ToggleChip-look toggle, platter list rows (the ScalingLazyColumn *feel* — the
structural wear-compose swap is pinned in its header), the 15sp type ramp + Wear color
roles, sf-map icons from the bundled Material Symbols subset, and a top-center TimeText.
The route table (bundled `routes.json` + OTA) and the tap-name contract carried over
unchanged.

## Honest status

- ✅ `StackWatch.swift` (render profile + the wrist SYSTEM DEFAULTS: real `List` spine,
  system text ramp, system bordered button, native toggle, `visible-if` via the cond seam),
  `StackLive` injectable table, the watch app (`WatchApp/`: store, router, WatchConnectivity,
  root view, the W1/W2 runtime — WatchRuntime), bundled start UI + route table, and the
  `prepare_modules` watch-target synthesis (watch SDK / deployment / **Embed Watch
  Content**) — all gate-green and idempotent.
- ✅ **Wear OS** Compose painter (`:wear` — StackWear.kt) with the Material-for-Wear visual
  defaults, **plus the W2 statement runner** (`WearRuntime.kt` drives the `:core` `JseRunner`
  over `WearStore.jse`). Still pinned follow-ups: structural wear-compose material (a real
  `ScalingLazyColumn`, swipe-dismiss, curved `TimeText`), the `variant=`/`role=` system words,
  and an OS-ticked `<countdown>` (StackWear.kt header + android-status.md).

### ⚠️ CI status — the watch is NOT exercised by the framework's own CI

Stated plainly, because an earlier revision of this list implied the opposite ("Device build on
Codemagic compile-verifies the watchOS target per release"):

| Signal | Runs on every framework build? | What it actually proves |
|---|---|---|
| `xcodebuild build -scheme Watch -sdk watchsimulator` (codemagic.yaml) | **NO** | Would be a real watchOS compile — but the step is gated on `Runtime.xcodeproj/xcshareddata/xcschemes/Watch.xcscheme` existing, and `prepare_modules` only synthesizes that scheme when the Watch package is enabled. |
| `xcodebuild test -scheme Watch -only-testing:WatchUITests` on an Apple Watch simulator | **NO** | Same gate. Real XCUITests exist; they simply do not run in the default lane. |
| `ruby scripts/ios_watch_release_guards_test.rb`, `ruby scripts/watch_native_unavailable_surface_test.rb` | **yes** | STATIC source/manifest/project assertions (scheme graph isolation, entitlements, the unavailable-screen markup). **They never compile Swift and never launch a watch.** |

The reason is the committed release profile: `codemagic.yaml` pins
`select_release_profile.rb --profile production-minimal --check`, and that profile lists
`Core/Extensions/Watch` (plus its `Modules/Face` and `Modules/Health` children) in `exclude`.
The Watch target is torn out before the build graph is generated, so the watch step prints
`production-minimal/no-Watch profile — skipping watchOS-only build and UI tests` and passes
vacuously. **A green framework build carries zero watchOS compile or runtime evidence.**

What watch evidence DOES exist is out-of-band and manual: the isolated `qa-expanded` simulator
qualification recorded in [`release-profiles.md`](../../../ClosedSource/Documentation/release-profiles.md)
(Apple Watch Series 11 46mm / watchOS 26.5, 2/2 signed XCUITests, 20/20 cold launches). That is
simulator evidence for a materialized optional surface at one point in time — not a per-PR gate,
and not paired-device, entitlement, signing, or store evidence. Swift in this repo is
**compile-pending** for watch code: treat every watch change as unverified until someone runs a
Watch-enabled profile.

- ⏭️ **Open work (tracked, not done):** run the watch lane on a Watch-enabled profile in CI —
  either a second Codemagic workflow that selects a Watch-enabled profile, or a scheduled
  `qa-expanded` job — so the existing build + WatchUITests steps stop being conditionally dead.
- ⏭️ Per-app signing (companion bundle id, profile, embed spec) — see the Watch package
  [README](../../../ClosedSource/DSX/Modules/Core/Extensions/Watch/README.md).
