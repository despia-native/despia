# State & events

Two ways native and web stay in sync: a shared **state store** and **broadcast events**.

## `window.dsx.global` — app-wide reactive state

One store, shared across the web, the native side, and your DSX screens. Dot-paths
address nested values.

```js
await window.dsx.global.set("session.credits", 200);
const credits = await window.dsx.global.get("session.credits");

const sub = window.dsx.global.watch("session.credits", (value) => render(value));
// fires immediately with the current value, then on every change
sub.stop();
```

- Backed by the mandatory `state` module (bridged from native `DSXState`).
- Native modules read/write the same store via `dsx.global`;
  DSX markup reads it as `{{ dsx.global.session.credits }}`.
- Use it for session, feature flags, credits, anything multiple surfaces should agree on.

Deep-dive: [global-state.md](../../Skills/global-state.md).

## `window.dsx.on` — broadcast events

For events not tied to a specific call (a Quick Action tap, a push received, a player
state change). Subscribe by the emitting module's scheme:

```js
const off = window.dsx.on("quickactions", (e) => {
  if (e.event === "tap") openShortcut(e.data.value);
});
off();                       // unsubscribe

window.dsx.on("*", logEverything);   // firehose — all schemes
```

Each event is `{ event, data }`. (The legacy surface's `window.despia.broadcast` is an
alias that also accepts a `{ eventName: fn }` map; on `window.dsx` only `dsx.on` exists.)

## Streams vs broadcasts

- **Stream** = events for *one call you made*:
  `window.dsx.module.gyroscope.start({}, onTick)` → `onTick({ event, data })`, ended
  with `.stop()`.
- **Broadcast** = events *anyone* can hear, via `window.dsx.on(scheme, …)`,
  independent of a call.

Many modules offer both — see each module's README.

## Cleanup & lifecycle

Subscriptions stay alive until you end them — a leaked stream or watcher keeps firing (and holding
references) after the screen that made it is gone. End each one:

- **Streams** (`gyroscope.start`, `location`, `global.watch`, …) → the returned `sub.stop()`.
- **Broadcasts** (`window.dsx.on`) → the returned `off()`.

Store the handle when you subscribe and release it when the surface goes away:

```js
// React: stop on unmount
useEffect(() => {
  const sub = window.dsx.global.watch("session", setSession);
  return () => sub.stop();
}, []);
```

The rule of thumb: one `stop()` / `off()` for every `watch` / `start` / `on`. A plain page can
stop on `beforeunload`; a component framework stops in its teardown hook.
