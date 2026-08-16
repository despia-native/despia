# Writing a DespiaScript module

DespiaScript is not a new language. It is a small pattern for writing native
features that web code can call: you subclass `Module`, register a few actions
in `setup()`, and answer each call through the `dsx` handle. The same shape
compiles on Swift, Kotlin, and Java, so a feature you design once moves between
platforms with only keyword changes.

This guide covers the open-source runtime in this folder: `Module`, `dsx`
(`Context.swift`), the bridge (`Bridge.swift`), and `JSON`.

## The shortest module

```swift
import WebKit

final class Greeter: Module {
    override class var scheme: String { "greeter" }   // greeter://...

    override func setup() {
        // greeter://hello?name=Ada  ->  resolves with a greeting
        dsx.action("hello") { dsx in
            let name = dsx.args("name") as? String ?? "world"
            dsx.resolve(JSON(["text": "hello, \(name)"]))
        }
    }
}
```

From the web:

```js
const { text } = await window.despia.greeter.hello({ name: "Ada" });
```

That is the whole loop: a scheme, a named action, and one `resolve`.

## Registering actions

You register inside `setup()` through `dsx`. There are two kinds of handler:

- `dsx.action { dsx in ... }` is the pre-filter. It runs first on every call to
  this module. Handle the call, or call `dsx.skip()` to pass it on to the named
  handlers below. Use it for cross-cutting work, or for legacy schemes that pack
  data into the host (read it with `dsx.command()`).
- `dsx.action("name") { dsx in ... }` is a named handler. It runs for
  `scheme://name` when the pre-filter skipped (or there is no pre-filter).

If a pre-filter skips and no named handler matches, the caller gets a clean
`unknown_action` error for free.

Two ways to namespace named actions for the web's `despia.<scheme>.<a>.<b>(…)` dot API:

- `dsx.group("rag") { dsx.action("add") { … } }` registers the host `rag.add` under the
  module's scheme → `despia.<scheme>.rag.add(…)`. Nestable.
- `dsx.scheme("rag") { dsx.action("add") { … } }` scopes actions to ANOTHER scheme the module
  owns (declare it in `dsx.json` `aliases`) → `despia.rag.add(…)`. A module can front several
  schemes, each with its own isolated action set (so `despia.rag.add` ≠ `despia.<primary>.add`).

Two more registration hooks, both run once rather than per call:

- `dsx.hydrate { dsx in ... }` runs once on every page load, after the runtime
  is in place. Good for pushing initial state to the web.
- `try? dsx.module.dom.inject(["script": ...])` contributes a document script to the
  web surface. The Dom module owns the web view, so the kernel has no `dsx.configure`;
  a module adds scripts / serves schemes / evals through `dsx.module.dom.*`.

## Reading the call

Every read is a method (not a property) so the surface is identical on Java,
which has no properties:

| Call | Returns |
|------|---------|
| `dsx.args("key")` | One value, already parsed to its native type (String, number, Bool, array, object). `nil` if missing. |
| `dsx.args()` | The whole payload as a dictionary, framing keys stripped. |
| `dsx.list("key")` | A `[String]`. Real arrays and comma-lists (`?types=a,b,c`) both map element-wise; a single value wraps to one. |
| `dsx.file("key")` | The local URL of an uploaded File or Blob. |
| `dsx.command()` | The raw URL that triggered the call, for legacy data-in-host schemes. |
| `dsx.id()` | The request id. You rarely need it, `resolve`/`error`/`event` correlate it for you. |
| `dsx.stopped()` | `true` when the web caller stopped a stream. |
| `dsx.flags()` | Capability flags, to degrade gracefully on stripped builds. |
| `dsx.module.cdn.object("store")` | The local CDN handle, to persist bytes and hand back a URL. |
| `dsx.shared.use("web") as? WKWebView` | The host web view, an escape hatch for self-injecting code. |

`dsx.args("key")` is dynamic on purpose. You drop the value straight back into a
payload with no coercion. In Swift you cast only when an SDK needs a concrete
type: `dsx.args("name") as? String`.

The one read that stays a nested property, because it is so common, is
`dsx.action.name`, the action that fired.

## Answering the call

There are two shapes of answer.

A feature that returns one result settles once. The first call wins, later ones
are ignored:

```swift
dsx.resolve(JSON(["ok": true]))                 // success
dsx.error("payment_failed", "card declined")    // failure
```

`error` takes a stable, machine-readable `code` and optional free-form `data`.
The web always sees the same shape: `catch (e) { e.code; e.data }`.

A feature that streams emits as many events as it likes and never settles:

```swift
dsx.event("point", JSON(["lat": lat, "lng": lng]))
```

When the web caller calls `.stop()`, you get a re-dispatch with
`dsx.stopped() == true`, your cue to tear down.

Past an async boundary there is no ceremony: just capture `dsx`. It stays valid.

```swift
dsx.action("scan") { dsx in
    scanner.present { code, error in            // async tail
        if let error { dsx.error("scan_failed", error.localizedDescription); return }
        dsx.resolve(JSON(["code": code]))
    }
}
```

## Talking to the web out of band

Sometimes native has news that no single call asked for (a token refreshed, a
sync finished). Fan it out to every subscriber of the scheme with `broadcast`,
which carries no request id:

```swift
dsx.broadcast("sync", JSON(["state": "complete"]))
```

```js
window.despia.on("powersync", e => { if (e.event === "sync") {/* ... */} });
```

You can also write to the web window directly, which is how you keep an older
`window.*` contract alive while new code moves to `broadcast`:

- `dsx.variable("name", value)` sets `window.name` (write-only).
- `dsx.function("name", payload)` calls `window.name(payload)`.

The module's own `dsx` (the `self.dsx` you used in `setup()`) is also valid for
these out-of-band emits from anywhere: a delegate callback, a lifecycle hook.

## Building payloads with JSON

Two ways to build, both producing the same value. The fluent builder reads the
same on Swift, Kotlin, and Java:

```swift
JSON.obj()
    .put("count", 2)
    .put("users", JSON.arr()
        .add(JSON.obj().put("id", 1).put("name", "Ada"))
        .add(JSON.obj().put("id", 2)))
```

The literal is a per-language convenience:

```swift
JSON(["count": 2, "users": [JSON(["id": 1, "name": "Ada"])]])
```

Pass `nil` for null, nest a `JSON`, or hand over a `dsx.args(...)` value as-is.
`JSON.from(value)` wraps a dynamic native value when you have one in hand.

## The web side

`window.despia` (in `runtime.js`) is what web code calls. The modern form is
`window.despia.<scheme>.<method>(params, onEvent?)`; the legacy string /
assignment forms still work:

```js
const r = await window.despia.greeter.hello({ name: "Ada" });   // resolve once
const s = window.despia.gyroscope.start({}, e => {/* ... */});  // subscribe (stream)
s.stop();                                                 // end the stream
window.despia = "lighthaptic://";                        // legacy: fire and forget
await despia("readvault://?key=token", ["token"]);       // legacy: watch a window var
```

Files and Blobs in the payload upload themselves and arrive native-side as a
local URL (`dsx.file(...)`). Arrays travel as real arrays where the build
supports it, and fall back to comma-separated strings otherwise, which the
native side re-splits.

## The wire format

Under both `window.despia` and the lower-level `window.virtual` transport, every
message native sends back is the same object:

```
{ id, scheme, host, event, final, data, code }
```

`id` is the request id (absent for a broadcast), `event` names the message
(`result`, `error`, or your own), `final` marks the last one, `data` is your
payload, and `code` appears only on errors. You never assemble this by hand,
`resolve` / `error` / `event` / `broadcast` do it for you.

## Lifecycle and navigation hooks

Hear app events by registering a named `dsx.hook` in `setup()` - the host fires each
by name (no per-event `Module` methods). Lifecycle: `dsx.hook("launch")`,
`"becomeActive"`, `"resignActive"`, `"enterBackground"`, `"enterForeground"`,
`"willTerminate"`. Push / claim:
`dsx.hook("remoteNotificationToken")` / `dsx.hook("remoteNotification")` (APNs),
`dsx.hook("openURL")` (custom schemes / file URLs), `dsx.hook("continueActivity")`
(universal links / Handoff / Siri), and `dsx.hook("navReissue")` (returning a
`HookProducer`) to cancel and re-issue a main-frame navigation.

## Checklist

- [ ] Subclass `Module`, set the `scheme`, register in `setup()`.
- [ ] Read inputs with `dsx.args(...)` / `dsx.list(...)` / `dsx.file(...)`.
- [ ] Answer with `dsx.resolve` / `dsx.error`, or stream with `dsx.event`.
- [ ] Never touch `webView.evaluateJavaScript` directly, let `dsx` emit.
- [ ] Capture `dsx` across async boundaries, don't store it on the module.
- [ ] Build payloads with `JSON.obj()/.arr()` or the `JSON([...])` literal.
