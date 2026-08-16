# The `dsx` author API

What a module uses inside `setup()` and its handlers. Full detail + wire format:
[Skills/runtime-api.md](../../Skills/runtime-api.md). Source:
`OpenSource/Engine/iOS/Context.swift` + `Module.swift`.

## Register (in `setup()`)

| Call | Does |
|---|---|
| `dsx.action { dsx in … }` | Pre-filter — runs first on every call; `dsx.skip()` to defer to a named action |
| `dsx.action("name") { dsx in … }` | Named action — `dsx.module.<scheme>.name()` from DSX markup, native, AND the DSXWebView page (`window.dsx`; `window.despia` is the legacy alias) |
| `dsx.group("g") { dsx.action("a"){…} }` | Nest actions under a dotted host — `dsx.module.<scheme>.g.a()` on every surface. Nestable |
| `dsx.scheme("s") { dsx.action("a"){…} }` | Scope actions to another scheme the module owns (declare it in `dsx.json` `aliases`) — `dsx.module.s.a()`, isolated from the primary scheme |
| `dsx.hook(event) { input in … }` | Handle a host event (lifecycle/push/nav); return non-nil to claim |
| `dsx.hydrate { dsx in … }` | Run once per page load (didCommit) |
| `dsx.ready { dsx in … }` | Run once per page load (didFinish — page interactive) |
| `try? dsx.module.dom.inject(["script": …, "atStart": true])` | Contribute a document script to the web surface. The Dom module owns the web view — there is no kernel web-config hook; reach the surface via `dsx.module.dom.{inject,serveScheme,eval,…}` |

> **Screen lifecycle hooks.** For "when a screen loads / settles," hook the shell's **unified,
> surface-agnostic** events — `dsx.hook("screen.loading")` / `dsx.hook("screen.ready")` (input = the
> URL/route) — **not** the web-private `domFinish`. Your module then works on `DSXWebView` *and*
> `DSXView`. Current phase as state: `dsx.global.get("screen.phase")` (`"loading"`|`"ready"`) /
> `dsx.global.get("screen.ready")` (`Bool`), also readable in markup as `dsx.screen.*`. Full model:
> [screen-lifecycle.md](screen-lifecycle.md).

## Read the call

| Call | Returns |
|---|---|
| `dsx.args("key")` | One param, smart-typed (String/number/Bool/array/object); `nil` if absent |
| `dsx.args()` | The whole payload `[String: Any]` (framing keys stripped) |
| `dsx.file("key")` | Local `URL` of an uploaded File/Blob |
| `dsx.list("key")` | Param as `[String]` |
| `dsx.command()` | The raw triggering `URL` (use for legacy data-in-host schemes) |
| `dsx.id()` / `dsx.stopped()` | Request id / whether a stream was `.stop()`ed |
| `dsx.flags()` | Capability flags (`onlyLocalServer()`, `bridgeVersion()`) |

## Answer the web

| Call | Effect |
|---|---|
| `dsx.resolve(data?)` | Terminal success → resolves the JS promise (first terminal wins) |
| `dsx.ok(data?)` | Canonical success — alias of `resolve`; paired with `fail` (the uniform result contract) |
| `dsx.fail(code, message?, recoverable?, data?)` | Canonical failure → rejects with the uniform shape `{ code, message, recoverable, data }` (see below). **Prefer over `error`** for anything the caller branches on |
| `dsx.error(code, data?)` | Terminal failure → rejects with `{ code, data }` (the bare form; `fail` is the richer one) |
| `dsx.event(name, data?)` | Non-terminal event on this call (streams) |
| `dsx.broadcast(name, data?)` | Out-of-band event → the page's `dsx.on(scheme, …)` + in-process bus |
| `dsx.module.dom.set(["name": name, "value": value])` | LEGACY `window.<name> = value` projection — owned by the DSXWebView package (the kernel's `dsx.variable` was DELETED); prefer `resolve` (one answer) |
| `dsx.module.dom.call(["fn": name, "args": [...]])` | LEGACY `window.<name>(args…)` projection — owned by the DSXWebView package (the kernel's `dsx.function` was DELETED); prefer `broadcast`/`event` |
| `dsx.module.dom.css(["property": prop, "value": value])` | Set a CSS custom property on `:root` and `<body>` |

## Reach other modules / the host

| Call | Effect |
|---|---|
| `dsx.has("scheme")` | Is that module loaded in this build? |
| `try? dsx.module.<scheme>.<action>(args)` | Fire-and-forget call into another module |
| `try await dsx.module.<scheme>.<action>(args)` | Awaitable call → its `dsx.resolve` payload as `JSON` |
| `dsx.component.mount(.Name)` | Put DSX on screen (pages / overlays / sheets) — see [Skills/mounting-components.md](../../Skills/mounting-components.md) |
| `dsx.shared.use("web") as? WKWebView` | The live web view (escape hatch for self-injecting subsystems) |

One call root, three surfaces: native `dsx.module.<scheme>.<action>(args)` mirrors
DSX `dsx.module.<scheme>.<action>({…})` and the DSXWebView page's
`dsx.module.<scheme>.<action>({…})` (`window.dsx`; `window.despia` is the legacy alias) —
`await` returns the result, bare is fire-and-forget. The awaited SHAPE differs by surface
and is corpus-pinned: native throws `ModuleCallError` on failure and returns the payload;
the web promise resolves the payload / rejects `{code, message, recoverable, data}`; **DSX
markup never throws** — `const r = await dsx.module.x.y({…})` binds the envelope
`{ ok: true, data }` or `{ ok: false, error: <code>[, data] }` on every renderer, so a
portable action branches on `r.ok`. See
[Skills/cross-module-calls.md](../../Skills/cross-module-calls.md).

## Shared state & services

| Call | For |
|---|---|
| `dsx.global.x.y` · `.get/set(path)` | App-wide cross-screen reactive store (`global.*`): dot-notation reads (`.string`/`.int`/`.bool`/…), `set` writes; syncs to web + Stack. Markup: `{{ global.x.y }}` |
| `dsx.app.host / .name` | Read-only app identity from `App.json` (per-locale host) + bundle; markup reads `dsx.app.*` |
| `dsx.config.x` | This module's config by key: `.value` (device-resolved), `.default`, `.isLocalized`, `.locales`, `.forLocale(_:)`, typed `.bool`/`.int`/…; works for any key. See [Skills/localization.md](../../Skills/localization.md) |
| `dsx.shared.provide/use/on(key)` | Live in-process object handles (weak); e.g. `"web"` |
| `dsx.events.on(scheme) { event, data in … }` | In-process mirror of the page's `dsx.on` |
| `dsx.container...` | Shared App Group storage + cross-process signals (widgets/extensions) |
| `dsx.module.cdn.object("store")` | LocalCDN: persist bytes, get a URL |
| `try await dsx.fetch(url, method:…, headers:…, body:…)` | Native HTTP (works backgrounded) |

## The uniform result contract (`ok` / `fail`)

Every module answers in one predictable shape, so a web caller writes the same
`try/catch` against any scheme:

```js
try {
  const data = await dsx.module.fileviewer.open({ src: url });   // success → the resolved data
} catch (e) {
  e.code;         // stable machine id to branch on  — "download_failed"
  e.message;      // human-readable, safe to show    — "Couldn't download the file…"
  e.recoverable;  // is a retry / alternate path worth offering?  — true
  e.data;         // optional extra metadata
}
```

- **Success** = the promise resolving with `data` — `dsx.ok(data)` (≡ `resolve`); there's no `ok`
  wrapper key, resolving *is* the ok signal.
- **Failure** = `dsx.fail(code, message:, recoverable:, data:)` → rejects with
  `{ code, message, recoverable, data }`. Use a **stable `code`** (branch on it), a human
  `message` (show it), and `recoverable` (offer a retry only when true). `dsx.error(code, data)`
  is the bare legacy form — `fail` is the contract the catalog is converging on (exemplar:
  `Core/FileViewer`). Native cross-module callers still get `ModuleCallError.actionFailed(code, data)`.

## Diagnostics: `dsx.log` + `dsx.error` (the unified spine)

One primitive per concern, identical on iOS / Android / web renderer / the web page —
everything lands in the kernel rings the dev center streams live (shake → Console on test
installs — tap-to-copy rows, Copy-all, .txt export) and mirrors to the platform console
(Xcode / logcat / devtools) on debug builds:

| Surface | Log a line | Report an error |
|---|---|---|
| native module code | `dsx.log("sync done", count)` | ambient `dsx.fail("sync_failed", message:…)` |
| DSX markup `<action>` | `dsx.log('payload:', obj)` | `dsx.error('sync_failed', { message, recoverable, data })` |
| web page in DSXWebView (`window.dsx`) | `dsx.log('checkout ready', cart)` | `dsx.error('cart_stuck', { message })` |

- `dsx.log` is console.log-shaped (variadic, canonical JSON for objects, credential keys
  masked) and records `{ scheme, level, message }` into the log ring (`dsx.logs.recent()`,
  cap 500). The `console.*` builtin feeds the same ring as scheme `"console"`.
- Errors record into the error ledger (`dsx.errors.recent()`, cap 128) and fan out:
  `dsx.hook("module.error")`, the page channel + the page's `dsx.on("dsx", …)` global mirror,
  and the reactive `global.dsx.lastError` / `global.dsx.errorCount` keys.
- **Automatic capture, zero setup**: every failed `dsx.module` call (`origin: "call"`), every
  uncaught markup `throw` (`origin: "uncaught"`), and — in the WebView — every uncaught page
  exception / unhandled rejection (`runtime.js` forwards them, burst-guarded) is already in
  the ledger. Corpus-pinned: `OpenSource/Conformance/{errors,logs}/`.

## Settle rules

- Exactly one terminal per call: the first `resolve`/`error`/`ok`/`fail` wins; later ones no-op.
- Streams use `dsx.event` (non-terminal); end when the JS caller `.stop()`s
  (`dsx.stopped()` becomes true on the re-dispatch).
- Handlers run on the main thread — and anything you call back INTO must land there
  too: a completion inside a bare `Task { }` runs on the cooperative pool, so hop it
  (`await MainActor.run { completion(…) }`) before touching `dsx`, a surface
  (`ui.set`/`ui.action`), or the web bridge. The DSX store re-dispatches stray
  background writes as a safety net, but your own module state has no such net.
- `JSON` builder: `JSON.obj().put("k", v)…`, `JSON(["k": v])`, `JSON.from(anyDict)`;
  `String`/`Int`/`Bool`/`Double`/`JSON` are `JSONConvertible`.
