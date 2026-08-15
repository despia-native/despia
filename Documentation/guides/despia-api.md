# The `window.dsx` API

The single entry point for everything native, from the page. Source:
`OpenSource/Engine/runtime.js` — whose own header is the law: **`window.dsx` is THE
surface (dot notation IS the API); `window.despia` is the LEGACY surface riding the
same engine** — kept forever for already-shipped pages, never extended. On `window.dsx`
every module call is rooted at `dsx.module` — the same call root DSX markup and native
module code use; new code writes `window.dsx`.

## Calling a module

### The modern form

```js
window.dsx.module.<scheme>.<method>(params?, onEvent?)         // calls the scheme's <method> action
window.dsx.module.<scheme>.<group>.<method>(params?, onEvent?) // a grouped/nested action
window.dsx.module.<scheme>(params?, onEvent?)                  // scheme-only (the default action)
window.dsx.module.<scheme>["non-identifier-name"](params?)     // for names dots can't express
```

(The legacy bare form — `window.despia.<scheme>.<method>(…)`, no `module` root — exists
only on the `window.despia` alias surface.)

A module can nest related actions under a group, so the dot path reads naturally — e.g.
`window.dsx.module.intelligence.index.add({…})` / `window.dsx.module.intelligence.index.query({…})`
(a group). It's fully dynamic: any depth works with no client setup. Extra schemes a module
still answers (e.g. `rag` for `intelligence`) are legacy **aliases**: they route on the
`window.despia` plane and the wire, never as the modern dot face.

- **`params`** — a plain object (omit if none). May contain `File`/`Blob` values.
- **`onEvent`** — pass a function to receive a **stream** of events (see below).
- **Returns** — a `Promise` for the result (resolve-once), or a `{ id, stop() }`
  subscription when `onEvent` is given.

```js
const { result } = await window.dsx.module.scanner();        // resolve-once
window.dsx.module.haptic.medium();                           // fire-and-forget (ignore the promise)
const sub = window.dsx.module.gyroscope.start({}, onTick);   // stream; sub.stop() ends it
```

> The legacy tier, in order of age: `window.despia` (the bare-scheme alias surface —
> `window.despia.<scheme>.<method>(…)`, same engine, no `module` root), then the pre-dot
> `window.virtual` / scheme-string forms (sugar over the same routing). All survive only
> for already-shipped pages; new code uses `window.dsx.module.<scheme>.<method>(…)`.
> See [legacy.md](../legacy.md).

## Results & errors

```js
try {
  const data = await window.dsx.module.store.checkout({ id });   // resolved payload
} catch (e) {
  e.code;   // stable machine code, e.g. "payment_failed"
  e.data;   // optional details
}
```

Streams deliver `{ event, data, final }` to your `onEvent` handler; the subscription's
`.stop()` ends it.

## Events (out-of-band broadcasts)

For events not tied to a specific call (a shortcut tap, a push, a state change):

```js
const off = window.dsx.on(scheme, handler);   // handler(e) → { event, data }
window.dsx.on("*", handler);                  // firehose (all schemes)
off();                                           // unsubscribe
```

`window.despia.broadcast` is the legacy map-form alias (the sugared
`{ eventName: fn }` shape); on `window.dsx` only `dsx.on(scheme, handler)` exists.

## App-wide state — `window.dsx.global`

A reactive store shared with native and your DSX screens (bridged over the mandatory
`state` module). Dot-paths address nested values.

```js
await window.dsx.global.get("session.credits");          // → value
await window.dsx.global.set("session.credits", 200);     // write
const s = window.dsx.global.watch("session", (v) => …);  // stream: now + on change; s.stop()
```

See [state-and-events](state-and-events.md) and the deep-dive
[global-state.md](../../Skills/global-state.md).

## Introspection

```js
window.dsx.has("scanner");          // bool — by module name or scheme (case-insensitive)
window.dsx.version("scanner");      // "2.0.0" | null
window.dsx.packages;                // [{ name, version, scheme? }, …] in this build
```

(The full-record lookup `window.despia.package("scanner")` — `{ name, version, scheme? } |
null` — lives only on the legacy `window.despia` surface, alongside its
`window.despia.hasPackage` spelling of `has`.)

## Capabilities (transport feature-detection)

Transport feature-detection lives on the legacy `window.despia` surface:

```js
window.despia.supports.events;      // streams + promise results available
window.despia.supports.structured;  // true arrays/objects over the bridge (not query strings)
window.despia.supports.version;     // bridge generation (0 = legacy binary)
window.despia.runtime;              // version contract from the native bridge
```

Branch on these to degrade gracefully on older app binaries. On `window.dsx` the
introspection surface is `has` / `packages` / `version` (above).

## Files

Pass a `File`/`Blob` in `params` and DSX uploads it natively (multipart, streamed off
disk — never base64) and hands the module a local URL. See
[files-and-storage](files-and-storage.md).
