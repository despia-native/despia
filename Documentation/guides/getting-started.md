# Getting started: the web app you already have

Your web app runs inside DSX with a global `window.dsx` object. Every native feature
is one call away.

> This is the **web door**: React, Vue, Svelte, Webflow, or hand-written, the app you
> already ship becomes a real store app without a rewrite. If you are starting from
> nothing and want to author screens in DSX itself, take the [Quickstart](quickstart.md)
> instead. Both end up in the same application, because the web view and the native view
> are equal consumers of one bus — you can start here and replace screens with DSX later,
> at your own pace.

## Your first call

```js
// Fire a haptic — you'll feel it.
await window.dsx.module.haptic.success();
```

`window.dsx.module.haptic.success` routes to the **Haptics** module (scheme `haptic`)
and calls its `success` action. `window.dsx.module.<scheme>.<method>()` calls a specific
action; `window.dsx.module.<scheme>()` is the scheme-only form (the module's default
action).

> **This dot API is the modern default** — use `window.dsx.module.<scheme>.<method>({ … })`
> for everything. (The bare-scheme `window.despia` alias and the pre-dot `window.virtual` /
> scheme-string forms are legacy — see [legacy.md](../legacy.md).)

## Call shapes

Three shapes, by what you need back:

```js
// 1) Fire-and-forget — no result needed
window.dsx.module.haptic.medium();

// 2) Resolve-once — await a single result (a real Promise)
const { result } = await window.dsx.module.scanner();          // QR scanner

// 3) Stream — pass a handler; stop() to end
const sub = window.dsx.module.gyroscope.start({ threshold: 2 }, (e) => {
  if (e.event === "change") setRotation(e.data);
});
sub.stop();
```

### Passing parameters

Parameters are orthogonal to the shape: a call takes an optional params **object** first, and
(for a stream) an `onEvent` handler second — `window.dsx.module.scheme.method({ … }, onEvent?)`.

```js
await window.dsx.module.store.paywall({ id: "pro_monthly" });
```

Files work too: pass a `File`/`Blob` in the params and DSX streams it to the device and hands
the module a local URL (never base64). See [files-and-storage](files-and-storage.md).

## Handling errors

Only **resolve-once** and **stream** calls can fail; fire-and-forget can't (there's nothing to
await). Wrap an awaited call in `try/catch` and branch on the stable `e.code`:

```js
try {
  const { result } = await window.dsx.module.scanner();
} catch (e) {
  if (e.code === "permission_denied") askForCameraInSettings();
  else showError(e.data ?? e.code);     // e.data carries optional details
}
```

`e.code` is a stable machine string (`permission_denied`, `payment_failed`, `download_failed`, …);
`e.data` is optional detail. Codes are **per module** — each module's README lists its own. A
stream reports failures to its handler and ends. Full contract:
[despia-api.md → Results & errors](despia-api.md#results--errors).

## Reacting to native events

Some features broadcast out-of-band (not tied to one call). Subscribe by scheme:

```js
const off = window.dsx.on("quickactions", (e) => {
  if (e.event === "tap") openShortcut(e.data.value);
});
// later: off();
```

## App-wide state

`window.dsx.global` is a reactive store shared with the native side and your DSX
screens:

```js
await window.dsx.global.set("session.credits", 200);
const credits = await window.dsx.global.get("session.credits");
window.dsx.global.watch("session.credits", (v) => render(v));
```

More in [state-and-events](state-and-events.md).

## Is a capability present?

Builds can include different modules. Check before you call optional ones:

```js
if (window.dsx.has("scanner")) {
  const { result } = await window.dsx.module.scanner();
}
```

## Next

- The complete API: [despia-api.md](despia-api.md)
- Everything you can call: [module catalog](packages/README.md)
- Recipes that compose modules: [common patterns](patterns.md)
- Building **native screens** (not just calling features): the DSX markup layer —
  [StackUI](../reference/StackUI.md) (concepts) and
  [StackReference](../reference/StackReference.md) (every tag).

> (The pre-dot `window.virtual` / scheme-string forms are legacy — see
> [legacy.md](../legacy.md); new code uses the `window.dsx.module.scheme.method()` form
> shown above.)
