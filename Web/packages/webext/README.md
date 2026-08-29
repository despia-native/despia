# @despia-native/webext

Page-side client for the **Despia browser-extension envelope** - one import
that is **total across every context** a web page can wake up in. No
dependencies, ~1.5 KB, never throws (every settle is `{ ok, error }`), and it
deliberately does **not** create any global: `window.dsx` stays the kernel's
own "you are inside the native app" signal.

```bash
npm install @despia-native/webext
```

```js
import { webext } from "@despia-native/webext";

const ext = await webext();            // one detect, four possible worlds

if (!ext) {
  // 4. Extension not installed (or this page isn't in its match list).
  //    Plain web behavior - nothing else to do.
} else if (ext.inApp) {
  // 1. This page runs INSIDE the Despia native app.
  await ext.update({ plan: "pro" });   // real dsx.module.webextension.update
  const { used } = await ext.status(); // heartbeat-honest setup state
} else if (ext.native) {
  // 2. Safari, next to the installed app - the APP owns shared state.
  const { vars } = await ext.status(); // read what the app pushed
  await ext.send("saveForLater", { url: location.href }); // queue for the app
} else {
  // 3. Chrome / Edge / Firefox standalone - THIS SITE is the app end.
  await ext.update({ plan: "pro" });   // feeds the popup
  const { messages } = await ext.drain(); // collect popup/content sends
}
```

## API

`webext(opts?) → Promise<Webext | null>` - `null` only when there is genuinely
nothing to talk to (no `window`, or no content script answered within
`opts.timeout`, default 300 ms). The handle exposes the complete six-verb
grammar; every reply is stamped `native: true|false` and `inApp: true|false`.

| Verb | Everywhere it means | Notes |
|---|---|---|
| `status()` | who's here + `vars`, `lastSeen`, `queued` | in-app: the module's `{ used, lastSeen, queued }` |
| `get()` | read the pushed `vars` | in-app: `in_app` (the app pushes, it doesn't read back) |
| `send(event, payload?)` | queue a message for the app end | in-app: `in_app` (you ARE the destination - subscribe `dsx.module.webextension.on("message", …)`) |
| `update(vars)` | app-end write: merge vars | Safari page: `native_owns_state` (the app owns them) |
| `clear()` | app-end write: drop vars | same ownership rule |
| `drain()` | app-end read-and-clear of the queue | Safari page: `native_owns_state`; in-app: `in_app` |

## The wire underneath

This package is sugar over the postMessage envelope (the browser's own wall
between pages and extensions - unavoidable):
`window.postMessage({ source: "dsx-webext", id, type, … })` in,
`{ source: "dsx-webext-reply", id, …result }` back. The envelope spec and the
whole architecture live in the Despia repo:
`OpenSource/Documentation/architecture/proposals/browser-extension.md`.
