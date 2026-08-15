# DespiaScript

**DespiaScript is not a new language.** It is the cross-platform module pattern
for writing Despia native extensions in Swift and Kotlin using the **same runtime
API**. A module has the same shape on iOS and Android - only language keywords
differ - so the native surface ports 1:1.

Inside a module you reach everything through one handle, **`dsx`**, handed into
every handler:

- **Register** (in `setup()`): `dsx.action`, `dsx.hydrate`, `dsx.ready` (to touch the web
  surface, call the Dom module: `dsx.module.dom.inject` / `serveScheme` / `eval`).
- **Read** (in a handler): `dsx.args`, `dsx.command()`, `dsx.action.name`, `dsx.id()`,
  `dsx.stopped()`.
- **Emit**: `dsx.resolve`, `dsx.error`, `dsx.event`, `dsx.broadcast`,
  `dsx.variable`, `dsx.function`.
- **Capabilities**: `dsx.flags()`, `dsx.module.cdn.object("store")`, `dsx.container` (iOS), `dsx.shared.use("web")`. Config is `self.config`
  (own, typed) and `CoreConfig.shared` (host).

The scheme is declared once in `dsx.json` (`prepare_modules` binds it to the
class).

## The baseline - identical on both platforms

```swift
// iOS - Swift
final class Scanner: Module {
    override func setup() {
        dsx.action("scan") { dsx in
            dsx.resolve(JSON(["code": "abc123"]))
        }
    }
}
```
```kotlin
// Android - Kotlin
class Scanner : Module() {
    override fun setup() {
        dsx.action("scan") { dsx ->
            dsx.resolve(JSON(mapOf("code" to "abc123")))
        }
    }
}
```

Same structure, line for line. The only differences are forced language keywords
(`final class ... :` vs `class ... : ()`, `func`/`fun`) and the JSON literal
(`["k": v]` vs `mapOf("k" to v)`) - never the API.

> The examples in this doc are the canonical patterns - copy one into a
> `DSX/Modules/Core/<Name>/` folder to start a module.

## Anatomy

- **Folder**: `DSX/Modules/Core/<Name>/` (shipped) or `DSX/Modules/Custom/<Name>/`.
- **`dsx.json`**: `scheme`, `aliases`, pods/SPM, Info.plist, entitlements. The
  scheme is bound to the class automatically - don't repeat it in code.
- **The class**: `final class X: Module` (Swift) / `class X : Module()` (Kotlin).
  Auto-discovered at launch.
- **`setup()`**: the one entry point; register handlers here.

## The API - `dsx`

| Call | Purpose |
|------|---------|
| `dsx.action("name") { dsx in … }` | handler for `scheme://name` |
| `dsx.action { dsx in … }` | pre-filter - runs first; `dsx.skip()` to defer to named actions |
| `dsx.hydrate { dsx in … }` | run once per page load (didCommit - early, body may not exist) |
| `dsx.ready { dsx in … }` | run once per page load, AFTER it has finished loading (didFinish - body exists, page is interactive) |
| `try? dsx.module.dom.inject(["script": …])` | contribute a document script to the web surface (the Dom module owns the web view; no kernel `dsx.configure`) |
| `dsx.args("k")` | input value, already typed (auto-parsed); use it directly |
| `dsx.args()` | the whole payload as `[String: Any]` |
| `dsx.file("k")` | a file param's local URL (`File`/`Blob` stream-uploaded, no base64) |
| `dsx.list("k")` | a list param as `[String]` (array, comma-list, or single value) |
| `dsx.command()` | the raw URL that triggered this call |
| `dsx.action.name` | which action fired (inside a handler) |
| `dsx.id()` / `dsx.stopped()` | request id (rarely needed - auto-correlated) / stream-stop signal |
| `dsx.resolve(json)` | formula result - one answer (terminal, first-call-wins) |
| `dsx.error(code, data?)` | formula error (terminal); `code` string + free-form `data` |
| `dsx.event("name", json)` | non-terminal event - stream this call |
| `dsx.broadcast("name", json)` | out-of-band event → the page's `dsx.on(scheme)` subscribers |
| `dsx.variable("name", value)` | `window.<name> = value` |
| `dsx.function("name", json)` | `window.<name>(json)` |
| `dsx.module.dom.css(["property": "--name", "value": "value"])` | sets a CSS custom property on `:root` AND `<body>` |
| `self.config.<key>` | this module's own config (typed) |
| `CoreConfig.shared.<group>.<key>` | the host's shared config |
| `dsx.shared.use("web") as? WKWebView` | the host's main web view (escape hatch) |

Every name is identical on the Kotlin/Java bridge. Finality is the **verb**
(`event` vs `resolve`), never a boolean. See `runtime-api.md` for the full surface
and the web contract.

### Dispatch

- `dsx.action("name") { … }` - one host on the module's scheme (`battery://level`).
- `dsx.action { … }` - the **pre-filter**: runs first on every call to the
  module's schemes. Don't `skip()` and you own the call; `dsx.skip()` to fall
  through to the named actions. This is where you handle legacy/aliased schemes
  whose host slot carries data (`readhealthkit://STEP,SLEEP`) - read `dsx.command()`.

### Async & out-of-band

`dsx` is a per-call value handed to the handler, so async tails just **capture it**
- there is no `scope()` to remember:

```swift
dsx.action("scan") { dsx in
    present { code, error in                 // fires later
        if let error { dsx.error("scan_failed", error.localizedDescription); return }
        dsx.resolve(JSON(["code": code]))    // dsx is still valid
    }
}
```

For events with **no active call** (delegate callbacks, lifecycle, observers), use
the module's own `self.dsx`:

```swift
dsx.hook("remoteNotification") { _ in              // registered in setup()
    dsx.broadcast("push", JSON(["received": true]))   // → the page's dsx.on("scheme", …)
    return nil
}
```

## Actions vs hydration

Not every emit is a promise - use the verb that matches the moment:

- **Action** - settle the awaited call with `resolve` (`__rid`-correlated).
- **Hydration** - runs on every page load; there's no promise, so inject a window
  variable with `dsx.variable(name, value)`.

```swift
final class Store: Module {
    override func setup() {
        // ACTION -> resolves a promise (await dsx.module.store.ready({}))
        dsx.action("ready") { dsx in
            dsx.resolve(JSON(["ok": true]))
        }

        // HYDRATION -> inject window variables on every page load
        dsx.hydrate { dsx in
            dsx.variable("storeReady", true)               // window.storeReady = true
            dsx.variable("user", JSON(["id": 1]))          // window.user = { id: 1 }
        }
    }
}
```

`dsx.variable` is the standalone `window[name] = value` injection and takes any
JSON, not just scalars. `dsx.function("name", data)` calls `window.name(data)` -
use it to keep a legacy callback contract alive.

## Payloads - JSON

Build payloads two ways - both produce the same `JSON`.

**Fluent builder** - the unified form, byte-identical on Swift / Kotlin / Java
(method chaining is the same everywhere; map/array literals are not):

```swift
dsx.resolve(JSON.obj()
    .put("count", 2)
    .put("users", JSON.arr()
        .add(JSON.obj().put("id", 1).put("name", "Ada"))))
```

**Native literal** - per-language map/array sugar:

```swift
dsx.resolve(JSON(["count": 2, "users": [JSON(["id": 1, "name": "Ada"])]]))
```

- `JSON.obj()` / `JSON.arr()` start a builder; `.put(key, value)` / `.add(value)` chain.
- Values go in dynamically - a native scalar, a nested `JSON`, a `dsx.args(...)`
  result, or `nil` (→ `JSON.null`). Single values work too: `dsx.resolve(true)`.
- `JSON.from(anyNativeValue)` forwards a dynamic Foundation value.

## Config

Config lives next to what it configures and is generated into typed Swift - no
runtime parsing, same shape on Kotlin.

- **A module's own config** - a `config.json` in the module folder, one entry per
  key (`{ "friendly_name": "<short label>", "friendly_description": "<one sentence>", "value": <default>, "editable": <bool?>, "_note": "<docs?>" }`;
  the friendly fields are required UI labels, the rest tooling metadata), read
  scoped:

  ```swift
  let greeting = config.greeting   // this module's own (self.config)
  ```

- **Host / core config** - `DSX/Modules/Config/config.json` (grouped), shared:

  ```swift
  let url = CoreConfig.shared.server.webview_url
  ```

Edit the JSON and re-run `prepare_modules` (it runs `prepare_config`).

## What is 1:1 - and what isn't

| Aspect | Identical on Swift + Kotlin? |
|--------|------------------------------|
| API (`dsx.*`, `self.config`, `CoreConfig.shared`) | ✅ |
| `Module` + `setup()` structure | ✅ |
| JSON builder (`JSON.obj()/.arr()/.put()/.add()`) | ✅ identical |
| JSON literal (`JSON([…])`) | ❌ map/array syntax differs |
| Scheme in `dsx.json` (not in code) | ✅ |
| Class/inherit keyword (`final class ... :` vs `class ... : ()`) | ❌ language |
| `func` vs `fun`, closure capture (`[self]`) | ❌ language |

If you need **byte-identical source** (one file for both), that's Kotlin
Multiplatform - a separate, larger architecture. DespiaScript gives structural 1:1
in each platform's native language, which is the maximum two native toolchains
allow.

## See also

- **[writing-a-module.md](writing-a-module.md)** - step-by-step recipe.
- **[runtime-api.md](runtime-api.md)** - full native API + web contract.
- **[manifest-dsl.md](manifest-dsl.md)** - every `dsx.json` key.
- **[module-system.md](module-system.md)** - discovery, build, exclusion.
