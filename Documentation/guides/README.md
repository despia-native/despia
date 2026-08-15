# Building an app on DSX

Two doors, one product. Pick by what you have in your hands right now.

- **You have nothing yet, and want a DSX app** → **[Quickstart](quickstart.md)**.
  `npm create dsx`, one `.dsx` document, running in ten minutes. The document you write
  is the one the Swift, Kotlin, and TypeScript kernels all render.
- **You have a web app, and want it native** → **[Getting started](getting-started.md)**.
  Point Despia at the app you already have and call native features from the page with
  `window.dsx`. No rewrite, and no need to read the quickstart first.

Neither door is the beginning of the other. The web view and the native view are equal
consumers of the same bus, so you can start at either end, move screen by screen, and
never hit an eject moment.

## Guides
0. **[Quickstart](quickstart.md)** — a DSX app from nothing: scaffold, run, edit, build.
1. **[Getting started](getting-started.md)** — your first native call, the call shapes, error handling.
2. **[The `window.dsx` page API](despia-api.md)** — the complete reference (calls, events, state, introspection); `window.despia` is its legacy alias.
3. **[Module catalog](packages/README.md)** — every module and scheme you can call, by category.
4. **[State & events](state-and-events.md)** — app-wide `window.dsx.global` store, `window.dsx.on` broadcasts, and subscription cleanup.
5. **[Files & storage](files-and-storage.md)** — upload File/Blob, key/value storage, the local CDN (`window.dsx.module.cdn.*`).
6. **[Common patterns](patterns.md)** — recipes that compose modules (scan→navigate, purchase→entitlements, upload→display).
7. **[Shipping an iOS build](codemagic-build.md)** — the Codemagic flow and the zip's `iOS/` folder: every file you send to get a signed IPA.
8. **[Staging, testing & the dev center](staging-and-testing.md)** — switch prod ⇄ staging inside the same TestFlight build (shake → dev center), environment channels, sandbox best practices, the release checklist.
9. **[Transport & OTA integrity](transport-and-ota-integrity.md)** — HTTPS-by-default transport, scoped per-app exceptions, and `bundle_signing` (signed OTA updates — when you need it, when you don't).
10. **[Adaptive large-screen shells](adaptive-native-shells.md)** — one `<scaffold>` contract for iPad/iOS, Android, Web, macOS, Windows, and Linux, with native/semantic panes and explicit compact behavior.

## At a glance

```js
// Call a feature (returns a real Promise)
await window.dsx.module.haptic.medium();            // fire a haptic
const { result } = await window.dsx.module.scanner(); // scan a QR code

// Subscribe to a feature's events
const sub = window.dsx.module.gyroscope.start({}, (e) => updateCompass(e.data));
sub.stop();

// App-wide reactive state (shared with native + your DSX screens)
await window.dsx.global.set("session.credits", 200);
const credits = await window.dsx.global.get("session.credits");

// Is a capability in this build?
if (window.dsx.has("scanner")) { /* … */ }
```

> **Legacy note:** the pre-dot `window.virtual` / scheme-string forms still route, but
> `window.dsx.module.<scheme>.<method>(…)` is the current, recommended form — see
> [legacy.md](../legacy.md).

## UI

Building native screens (not just calling features)? DSX also has a declarative UI
layer: see [StackUI](../reference/StackUI.md) (concepts) and
[StackReference](../reference/StackReference.md) (every tag).
