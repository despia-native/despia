# Engine capabilities — the 99% surface

> **The durable capability MODEL — not a status board.** Live shipped / in-progress /
> queued state and dates are in [ROADMAP.md](../../../ClosedSource/Documentation/ROADMAP.md).

The goal: do **anything HTML/CSS/JS can do** on native, **plus anything Swift/Kotlin can
do**, OTA — *except* shipping new native executable code (the App-Store / security line).
The bar we set ourselves — a real, complex screen (the **VerticalPlayer**) authored as
**pure DSX**, with Swift only as thin trust/seed wrappers — is met: see
`DSX/Modules/Custom/VerticalPlayerStack/Components/player/Player.dsx` (the whole feed,
transport, scrubber, sheets, paywall and analytics are markup + JSE; the Swift wrapper
only seeds facts and owns IAP/ads trust).

## The reframe (how you get "anything Swift can do" OTA)

You don't make the **engine** do Swift things. You expose Swift capabilities as
**modules** (compiled, in the binary) and make the **declarative layer** powerful enough
to *compose* them. So:

> **99% out of the box = a complete declarative layer + a broad standard module library.**
> The kernel stays tiny; completeness lives in **nodes + modules**, never in the runtime.

Two axes: **depth** (the markup is HTML/CSS/JS-complete) and **breadth** (the module
std-lib covers the device).

## Depth — the completeness contract

> The expression & logic engine — **Express** (#3) + **Act** (#4) below — is **JSE**;
> see [`jse.md`](./jse.md). Author syntax is JSE (`x = e`, `dsx.event('x')`, `dsx.action.x()`,
> `arr.push(x)`, `await fetch(...)`); the only `verb:` forms left are the effect primitives
> with no JSE form (`fetch:`, `remove: … where`, `animate:`, `resolve:`, `error:`).

The engine is "done" when these 7 generic mechanisms are complete — the bar each must
clear. (Live status of any "remaining" item is tracked in [ROADMAP.md](../../../ClosedSource/Documentation/ROADMAP.md), not here.)

| # | Mechanism | Bar | Notes |
|---|---|---|---|
| 1 | **Render** — dynamic component tree + view/style vocab | ✅ complete vocabulary: stacks, `list`/`grid`/`pager`/`tabs`/`scaffold`, all inputs, `sheet` (measured `content` detent), `video` (full transport/PiP/lock-screen contract), `form`/`field`, style classes (`<style>` + `class=`), `dsx.global.theme` tokens, dynamic `<node>`, inline `<component as=>` | map/chart media nodes; a11y attributes (`component-roadmap.md`) |
| 2 | **Bind** — reactive state at any path, read **+ write** | ✅ read+write incl. array index (`dsx.variable.feed.data.5.name`), per-row write-back (`item.x = …`, two-way inputs in rows), computed (`computed="true"`) and parameterized derivations (`<formula>`), positional keys (`key="index"`) | — |
| 3 | **Express** — the expression language | ✅ JSE is computationally complete: operators (incl. `%`) / methods / arrows (**real closures** — creation-scope snapshot), `typeof` + `Array.isArray`, string×string lexicographic relationals, structural `==` on plain dicts/arrays, RegExp literals, `Math`/`JSON`/`Date`/`Intl`/`URL`/`Headers`/`Blob`/`FormData`, Web Crypto (`crypto.subtle` 1:1), `Map`/`Set`, `structuredClone`, `Object.groupBy` (ES2024) + `Array.from({length}, fn)` repeat-N + full JS `slice`/`indexOf`/`startsWith`/`endsWith` | — |
| 4 | **Act** — statements, calls, effects, sequencing | ✅ statement bodies with `if`/`switch`/loops (budgeted), `await fetch` / `await dsx.module.…` / `await crypto.subtle.…`, `Promise.all/race/any/allSettled`, `setTimeout`/`setInterval` (floored), `try`, AbortController | debounce/throttle sugar |
| 5 | **Observe** — events, broadcasts, lifecycle, streams | ✅ `on:*` events, `window.dsx.on` / `dsx.events`, `on:appear`/`on:disappear`, `<watch>` observers, `on:change` on every input + pager, **WebSocket** (statement form, surface-scoped), polling via `setInterval` | SSE stays module-side |
| 6 | **Compose** — components, remote components, slots | ✅ folder + Swift-backed + **inline `<component as=>`** definitions, slots (default + named), OTA DSX, dynamic `<node tag=…>`, forms as composable units | — |
| 7 | **Gate** — capability detection → graceful degrade | ✅ `visible-if="has:scheme"` / route `requires` | `has()` as a callable expression fn; uniform permission/result contract across modules (`package-scorecard.md`) |

## Case study — the bar, met

The VerticalPlayer screen that used to be ~1,200 lines of Swift is now one `.dsx`
file on first-party primitives — the proof that the seven mechanisms compose:

- **Render**: `<pager axis="vertical" ignoreSafeArea>` of `<video>` pages; chrome,
  scrim, `<sheet detents="content">` for Speed, `<sheet detents="half,full">` for
  Episodes.
- **Bind**: `<video active="{{ item.index == dsx.variable.index }}" bind="dsx.variable.pos"
  paused="dsx.variable.paused" time="dsx.variable.time" duration="dsx.variable.dur">` — the
  player is pure state; the custom scrubber shares the same keys.
- **Express/Act**: skip ±5 s is position math; engagement, recommendations
  (`await fetch`), paywall rows (`map`) and the analytics webhook are JSE actions.
- **Observe**: `<watch value="dsx.variable.prices">` rebuilds paywall rows when StoreKit
  prices land; lock-screen next/prev raise `on:remoteNext`/`on:remotePrev`.
- **Compose**: `PlayerTopBar` / `PlayerRail` / `PlayerControls` / `Episodes` / `Paywall`
  are module-scoped components.
- **Gate**: trust (auto-spend, IAP, ads) stays in the Swift wrapper — capability,
  not UI.

What remains native is exactly what the model says should be: AVPlayer itself
(the `<video>` component), StoreKit/AdMob (modules), and the trust gate.

## Breadth — the standard library

"Anything Swift/Kotlin can do" = the module catalog (the capability floor), ~78
modules (haptics, camera, location, push, IAP/Store, auth, share, files/CDN,
sensors, …). "99% OOTB" means a comprehensive, uniformly-bound std-lib so markup
rarely needs a custom module, + one consistent `call → {result,error}` /
permission / event contract so every capability is driven from markup the same
way. Per-module doc quality: [`audits/package-scorecard.md`](../../../ClosedSource/Documentation/audits/package-scorecard.md);
the component build queue: [`audits/component-roadmap.md`](../../../ClosedSource/Documentation/audits/component-roadmap.md); live
status across both: [ROADMAP.md](../../../ClosedSource/Documentation/ROADMAP.md).

## The deliberate 1% — and the escape valve

OTA can never ship **new native executable code** (App-Store-safe SDUI + security). So the
1% is a capability not yet compiled in. Fix: ship it in the **next binary** as a module;
the OTA layer composes it the instant it's present and `requires`-gates gracefully when
it isn't. A hot OTA DSX component can even be **promoted into the binary** unchanged.

## What's left

The model's open tails — the uniform module result/permission contract, heavy opt-in
libraries (Charts/Maps), and the a11y adjustable-action + Dynamic Type tail — are tracked,
in priority order alongside everything else, in **[ROADMAP.md](../../../ClosedSource/Documentation/ROADMAP.md)**. This section
deliberately doesn't duplicate that queue.

## North star — the minimal kernel + capability tiers

The end state: **the kernel produces no views.** Everything that renders is a component;
the kernel is only the irreducible loop that *runs* components:

```
KERNEL = parse    (XML → node tree)
       · resolve  (tag → builder, via the registry)
       · evaluate (the {{ }} expression engine)
       · state    (one reactive store + bindings)
       · drive    (walk the tree, apply the universal style/visible-if/animation
                   pipeline, mount to SwiftUI)
```

This state is **realized**: the `raw()` switch keeps only the document-level
declarations (`variable`/`formula`/`action`/`script`/`watch`/`style`/`attribute`/
inline `component`) plus the two irreducible primitives — `slot` (the children
bridge) and `node` (the dynamic resolver) — and the `default:` resolver itself.
Every leaf, control and container is a component resolved via the registry
(`text`/`button`/inputs/`progress`/stacks → Basics; `list`/`grid`/`pager`/`tabs`/
`scaffold`/`scroll`/`sheet` → Structure; `video` → Media; `form`/`field` → Forms).
Even `native` folded in: a module's runtime-registered surface
(`dsx.stack.register`) is consulted by the resolver like any tag, so `<feed/>`
works directly — the old `native` back-compat alias was removed. The trust
root was never `native`, it's the resolver/registry gate ("a remote screen
references only *shipped* tags").
(Engineering note: the hottest tags resolve every render, so `resolve`/`drive` cache the
builder per tag — a lookup cache, not an architecture limit.)

### Two capability tiers — the safety boundary (replaces "kernel vs component")
- **Safe** — the small `dsx` (`StackComponentContext`: attributes · slot · bind · events).
  Sandboxed, composable. The leaves (`Basics`) + the stacks live here.
- **Privileged** — a wider dsx (`PrivilegedStackComponentContext`): scoped per-row rendering
  (`render` / `bound`), child-node introspection (`children`), collection write-back, and the
  `measuring` flag. The orchestrators `list`/`grid`/`pager`/`tabs`/`scaffold` are
  **privileged components** in `Foundation/Components/Structure/` — real library
  components (`PrivilegedStackComponent` subclasses, auto-registered by the same launch
  class-walk, resolved by the renderer just before its built-in switch). Only `slot` (the
  children bridge) and `node` (the resolver) stay compiled into the engine — they ARE the
  substrate a component stands on, so componentizing them is circular.

The boundary moves from *where code lives* to *what capability a component is granted*.

### OTA: *usable* vs *loadable* (different things)
- **OTA-usable** — can a remote screen *reference* a tag? **Any tag shipped in the binary,
  including the default privileged orchestrators.** `list`/`vstack`/`pager`/… are
  **default components — always shipped — so they all work OTA**, exactly like the leaves.
  A remote screen composes the **shipped registry** (safe + privileged + native).
- **OTA-loadable** — can a component's *code* be downloaded? **Only safe-tier XML** (no
  native code). Privileged + native components ship in the binary; you can't download *new*
  privileged code.

So the tier governs only what new code may be **downloaded**, never what a remote screen may
**use**. Because the default libraries always ship, every default tag is OTA-usable; a
genuinely new capability is a binary release that adds it to the registry, which OTA then
picks up (and `requires`-gates gracefully until present). This is the same capability
boundary the router enforces — *compose shipped nodes* — and the same source-anchored
trust model [`Skills/security.md`](../../Skills/security.md) documents.

## Component libraries (the breadth, made modular)

Component libraries live under the Foundation module; the **engine stays in
`OpenSource/Engine/`** (it's not a library — it's what renders/binds/states libraries):

```
OpenSource/Engine/                        ← kernel: resolver + JSE + state + the
                                            irreducible primitives (slot/node)
                                            (e.g. OpenSource/Engine/iOS/Stack.swift)
ClosedSource/DSX/Modules/
  Mandatory/Foundation/Components/
    Basics/      ← text, image, button, pressable, inputs (textfield/toggle/slider/
                   stepper/picker/segmented/datepicker), spacer, divider, spinner,
                   progress, stacks
    Structure/   ← list, grid, pager, tabs, scaffold, scroll, sheet, refreshable
                   (PRIVILEGED tier where engine powers are needed)
    Media/       ← video
    Forms/       ← form, field
    Views/       ← DSXWebView, DSXView (the two frame-content renderers; the navigable
                   surface itself is the kernel's RouterHost in OpenSource/Engine/)
    Core/        ← Drawer + shared native globals
  Custom/<App>/Components/                ← per-app components (e.g. VerticalPlayerStack's
                                            player/ component set)
```

A component with **native deps** (pods/SPM) becomes a folder with a `dsx.json` — a
module-grade unit that merges/dedupes its dependencies across the build and is
excludable via `excluded.json`, so you pay only for what ships. Heavy opt-in
libraries (Charts, Maps, AR) follow the same shape under `Core/` when they land.

## The rule (non-negotiable)

Every item above is a **node, an action verb, an expression feature, or a module** — the
renderer/resolver/registries learn *primitives*, never capabilities. The kernel never
grows; the markup gains HTML+JS+CSS's reach; native modules stay the floor; OTA composes.
