# Architecture

How DSX turns a `window.dsx.module.haptic.medium()` in the web into native code, and back. The
authoritative contract is [`KERNEL.md`](../reference/KERNEL.md); this is the working map.

## Layers

```
Web app  ──window.dsx──►  runtime.js  ──bridge──►  ModuleRegistry  ──►  a Module
   ▲                                                                          │
   └──────────── resolve / event / broadcast / window.* / global ◄───────────┘
```

- **`runtime.js`** (`OpenSource/Engine/runtime.js`) — the web-side `window.dsx`. Turns
  `window.dsx.module.<scheme>.<method>(params, onEvent)` into a `scheme://method` call over
  the bridge, manages request IDs, promises, and event subscriptions.
- **Bridge** (`Bridge.swift`) — wire format both directions: structured
  (`window.virtual.send`) with a string/URL fallback; emits results/events/`window.*`.
- **`ModuleRegistry`** (`Module.swift`) — the route table. Maps every scheme (primary +
  aliases) to a `Module` instance; dispatches each call; fans host events to hooks.
- **`Module` + `Context`** (`Module.swift`, `Context.swift`) — what a module author
  writes (`setup()`) and the `dsx` surface it uses. See [dsx-api.md](../reference/dsx-api.md).

## A call's path

1. Web: `await window.dsx.module.store.checkout({ id })` → `runtime.js` sends `store://checkout`
   with params + a request id (`rid`).
2. `ModuleRegistry.handle(url:params:)` looks up the scheme `store` → the `Store`
   module's `Registration`.
3. `Registration.dispatch` builds a per-call `Context` and runs: **pre-filter**
   (`dsx.action { }`) first; if it doesn't settle and calls `dsx.skip()`, routing falls
   to the **named handler** (`dsx.action("checkout") { }`).
4. The handler does its work and settles: `dsx.resolve(payload)` (→ the JS promise),
   `dsx.error(code, data)` (→ reject), `dsx.event(name, data)` (→ stream), or
   `dsx.broadcast` / `dsx.variable` (out-of-band). First terminal wins.

The **same** `handle()` path serves cross-module calls (`dsx.module`), so
a module's handlers are reused without import — see
[cross-module-calls.md](../../Skills/cross-module-calls.md).

## Modules, schemes, manifests

A module is a folder with a `dsx.json` and (usually) a `Module` subclass:

```
DSX/Modules/Core/Basics/Haptics/
  Haptics.swift     final class Haptics: Module { override func setup() { … } }
  dsx.json          { "name": "Haptics", "scheme": "haptic", "aliases": [ … ] }
  README.md
```

- `.swift` files **auto-compile** via the `DSX/Modules` synchronized group. Only
  non-source files (`dsx.json`, `README.md`, `config.json`) get a `membershipExceptions`
  entry in the pbxproj.
- **Scheme binding lives in `dsx.json`**, not the Swift. Prefer omitting the
  `override class var scheme` — codegen binds `name → scheme` (and aliases). An override,
  if present, wins.
- Every manifest key (pods, SPM, entitlements, Info.plist, extension targets, config) is
  documented in [manifest-dsl.md](../../Skills/manifest-dsl.md).

## Tiers

| Tier | Folder | Lifecycle |
|---|---|---|
| **Mandatory** | `ClosedSource/DSX/Modules/Mandatory/` | Always ships; `excluded.json` can't remove it (`DSXGraph.mandatory?`). E.g. `state`, `dom`, `browser`, `splash`, `routing`. |
| **Core** | `ClosedSource/DSX/Modules/Core/` | Excludable per build via `excluded.json`. |
| **Custom** | `ClosedSource/DSX/Modules/Custom/` | Per-app, copied in by CI. |

Components (declarative UI tags) live inside modules — each module's `Components/`
folder. A scheme-less module's components are global (the Mandatory `Foundation`
module is the global building-blocks library); a module with a scheme scopes them.

## Codegen

`ruby ClosedSource/scripts/prepare_config.rb` scans `DSX/Modules/**/dsx.json` and regenerates, under
`Registry/`:

- `ModuleSchemes.generated.swift` — `class → scheme` + `class → aliases` maps
  (`GeneratedModuleSchemes`), how `Module.resolvedScheme`/`resolvedAliases` find the scheme.
- `ModuleConfig.generated.swift` — `CoreConfig` (host config) + a typed `config`
  accessor per module (from each `config.json`).
- `StackComponents.generated.swift` — the component registry.

Run it after adding/changing any manifest. (`dsx_graph.rb` provides tier/exclusion logic.)
Details: [module-system.md](../../Skills/module-system.md).

## Host events (lifecycle, push, navigation)

The host emits declared, namespaced events; modules subscribe with
`dsx.delegate.listen(event) { input in … }`:

- `dsx.delegate.send(event, input?, combine: .void)` — fan out to every listener.
- `dsx.delegate.send(event, input?, combine: .claim)` — first non-nil result wins.
- `dsx.delegate.send(event, input?, combine: .any)` — every listener runs; consumed if any
  returns non-nil.

Current events: `lifecycle.launch`, `lifecycle.becomeActive`, `lifecycle.resignActive`,
`lifecycle.enterForeground`, `lifecycle.enterBackground`, `lifecycle.willTerminate`,
`lifecycle.remoteNotificationToken`, `lifecycle.remoteNotificationError`,
`lifecycle.remoteNotification`, `lifecycle.openURL`, `lifecycle.continueActivity`,
`lifecycle.shortcut`, `lifecycle.downloadResponse`, `lifecycle.navReissue`, and the web-view
lifecycle `surface.domStart` / `surface.domCommit` / `surface.domFinish` / `surface.domFail`.

**Screen lifecycle (the unified layer).** `dom*` are the **web surface's private** signals. The
shell's `Lifecycle` coordinator translates them into one surface-agnostic vocabulary —
`screen.loading` / `screen.ready` events + `global.screen.phase` / `global.screen.ready` state — so
behavior modules (spinner, screen-capture, engagement, …) work on `DSXWebView` **and** `DSXView` without
hooking a web event. Full model: [screen-lifecycle.md](../reference/screen-lifecycle.md).

## The four sharing primitives (don't mix them up)

| Primitive | For | API |
|---|---|---|
| `dsx.global` (DSXState) | reactive, serializable **data** (syncs to web + Stack) | `get/set/watch` |
| `dsx.container` | **persistent** storage in the shared App Group (cross-process: widgets/extensions) | `set/get/observe` |
| `dsx.shared` (DSXShared) | live in-process **object handles** (held weakly) — e.g. `"web"` = the WKWebView | `provide/use/on` |
| `dsx.module` | cross-module **actions** (RPC) | dot/subscript chains |

Plus `dsx.events` / `dsx.broadcast` — the in-process event bus that mirrors `window.dsx.on`.

## The web host as a node

The web view itself is a global component, `DSXWebView`
(`ClosedSource/DSX/Modules/Core/Dom/Components/Views/DSXWebView`).
It hosts the Dom module's web surface, publishes its `WKWebView` as the `"web"` shared handle,
and re-broadcasts its lifecycle. WebKit lives ONLY here (the Dom module + its DSXWebView component) —
every other module reaches the surface via `dsx.module.dom.*`. The ongoing work to keep the web
host a thin shell (features → modules) is tracked in
[EXTRACTION.md](../../../DSX/Modules/Core/Dom/Components/Views/DSXWebView/EXTRACTION.md).

## Cross-platform

The module contract is identical on Android (Kotlin): same schemes, same `dsx` verbs,
same untyped payloads. See [android/](../../Skills/android/).
