# API mapping - Swift ↔ Kotlin

Every `dsx` call, the `Module` shell, JSON, and the lifecycle hooks, side by
side. The rule: same name, same arguments, same order; only Kotlin keywords and
the two syntax rules from the [README](README.md) change.

## The module shell

```swift
// iOS - Swift
import WebKit

final class Battery: Module {            // scheme "battery" in dsx.json
    override func setup() {
        dsx.action("level") { dsx in
            dsx.resolve(JSON(["percent": 80]))
        }
    }
}
```
```kotlin
// Android - Kotlin
class Battery : Module() {                // scheme "battery" in dsx.json
    override fun setup() {
        dsx.action("level") { dsx ->
            dsx.resolve(JSON(mapOf("percent" to 80)))
        }
    }
}
```

The scheme comes from `dsx.json` on both platforms; the build binds it to
the class. Auto-discovery at launch is the same idea (the registry scans for
`Module` subclasses).

## Registration (inside `setup()`)

| Purpose | Swift | Kotlin |
|---|---|---|
| Named action | `dsx.action("name") { dsx in … }` | `dsx.action("name") { dsx -> … }` |
| Pre-filter (runs first) | `dsx.action { dsx in … }` | `dsx.action { dsx -> … }` |
| Per page load (early) | `dsx.hydrate { dsx in … }` | `dsx.hydrate { dsx -> … }` |
| Per page load (after load) | `dsx.ready { dsx in … }` | `dsx.ready { dsx -> … }` |
| Contribute a web-surface script | `try? dsx.module.dom.inject(["script": …])` | `dsx.module["dom"]["inject"](mapOf("script" to …))` |

The Dom module owns the web view on both platforms; a module contributes scripts /
serves schemes / evals through `dsx.module.dom.*` rather than a kernel web-config hook
(the retired `dsx.configure`). On Android, the Dom module wraps `WebView` / `WebSettings`
behind the same `dom` actions.

## Per-call reads

The reads are **zero-arg methods** on both platforms, so they're byte-identical
(Java has no properties, so this keeps all three languages aligned):

| Read | Swift & Kotlin |
|---|---|
| One input, typed | `dsx.args("key")` |
| Whole payload | `dsx.args()` |
| File param's local URL/path | `dsx.file("key")` |
| List param | `dsx.list("key")` |
| Raw trigger URL | `dsx.command()` |
| Request id | `dsx.id()` |
| Stream stopped? | `dsx.stopped()` |
| Which action fired | `dsx.action.name` |

Casting differs only by language: `dsx.args("name") as? String` (Swift / Kotlin),
`(String) dsx.args("name")` (Java).

## Emit

| Shape | Swift | Kotlin |
|---|---|---|
| Resolve (terminal) | `dsx.resolve(json)` | `dsx.resolve(json)` |
| Error (terminal) | `dsx.error("code", data)` | `dsx.error("code", data)` |
| Event (stream) | `dsx.event("name", json)` | `dsx.event("name", json)` |
| Broadcast (out-of-band) | `dsx.broadcast("name", json)` | `dsx.broadcast("name", json)` |
| `window.x = v` | `dsx.variable("x", v)` | `dsx.variable("x", v)` |
| `window.x(v)` | `dsx.function("x", v)` | `dsx.function("x", v)` |
| CSS custom property | `dsx.module.dom.css(["property": "--x", "value": "v"])` | `dsx.module.dom.css(["property": "--x", "value": "v"])` |

Finality is the verb (`event` vs `resolve`), never a flag - identical on both.

## Async tails

Capture `dsx`; it stays valid after the handler returns. No scope object on
either platform.

```swift
dsx.action("scan") { dsx in
    scanner.present { code, error in
        if let error { dsx.error("scan_failed", error.localizedDescription); return }
        dsx.resolve(JSON(["code": code]))
    }
}
```
```kotlin
dsx.action("scan") { dsx ->
    scanner.present { code, error ->
        if (error != null) { dsx.error("scan_failed", error.message); return@present }
        dsx.resolve(JSON(mapOf("code" to code)))
    }
}
```

For out-of-band emits (lifecycle, callbacks) use the module's own `dsx` /
`this.dsx` on both.

## JSON

The **fluent builder is byte-identical**:

```swift
dsx.resolve(JSON.obj().put("count", 2).put("ok", true))
```
```kotlin
dsx.resolve(JSON.obj().put("count", 2).put("ok", true))
```

Only the **literal** differs (map/array syntax):

```swift
JSON(["count": 2, "users": [JSON(["id": 1])]])
```
```kotlin
JSON(mapOf("count" to 2, "users" to listOf(JSON(mapOf("id" to 1)))))
```

`JSON.from(nativeValue)` forwards a dynamic value on both. Reads come back typed:
`dsx.args("count")` is the number on both platforms.

## Config

| Swift | Kotlin |
|---|---|
| `self.config.api_key` | `config.api_key` |
| `CoreConfig.shared.server.webview_url` | `CoreConfig.shared.server.webview_url` |

Generated from the same `config.json` / `DSX/Modules/Config/config.json` into typed
accessors on each platform.

## Capabilities

| Swift | Kotlin |
|---|---|
| `dsx.module.cdn.object("store")` | `dsx.module.cdn.object("store")` |
| `dsx.container` | `dsx.container` (see [containers.md](containers.md)) |
| `dsx.shared.use("web") as? WKWebView` | `dsx.shared.use("web") as? WebView` (the Android `WebView`) |

## Cross-module calls

The root is `dsx.module` — one proxy, awaited for a result or called bare for
fire-and-forget (the native twin of `dsx.module` / `window.despia`). The chain
*step* is the only difference: Swift uses `@dynamicMemberLookup` dots; Kotlin
uses `operator fun get`, so the root is the same `dsx.module` on both. The leaf
invoke `(args)` and the identifiers are the same. (Swift also accepts the `[…]`
form, so a dynamic-string call reads the same on both.)

```swift
dsx.has("appsflyer")
try dsx.module.appsflyer.set_user_id(["customer_user_id": id])    // fire-and-forget
let uid = try await dsx.module.appsflyer.get_uid()                // awaitable
```
```kotlin
dsx.has("appsflyer")
dsx.module["appsflyer"]["set_user_id"](mapOf("customer_user_id" to id))   // fire-and-forget
val uid = dsx.module["appsflyer"]["get_uid"]()                            // in a suspend fun
```

`ModuleCallError` is the same three cases on both: `NotLoaded(scheme)`,
`InvalidURI(uri)`, `ActionFailed(code, data)` (a Swift enum, a Kotlin sealed
class). See [cross-module-calls.md](../cross-module-calls.md).

### Unsupported platform — the graceful catalog answer

Calling a scheme that exists in the FULL module catalog but has **no implementation
on the running OS** (a D-class module — `scene3d`, `liveactivity`, `watch`, …) answers
a structured `unsupported_platform` error — deliberately **distinct** from "excluded by
this app" and "unknown scheme". `dsx.has(scheme)` stays **false** for all three:
feature detection remains the primary pattern; this error is the honest answer when
someone calls anyway.

| Situation | `dsx.has` | Web promise / surface mount | Native chain | Markup (awaited) |
|---|---|---|---|---|
| In the catalog, **no implementation on this OS** | `false` | `code:"unsupported_platform"` envelope (below) | `ActionFailed("unsupported_platform", data)` | `{ ok:false, error:"unsupported_platform", data }` |
| Implemented here but **excluded by THIS app** | `false` | `code:"not_loaded"` | `NotLoaded(scheme)` | `unavailable` (unchanged) |
| **Unknown** scheme (not in the catalog) | `false` | `code:"not_loaded"` | `NotLoaded(scheme)` | `unavailable` (unchanged) |

The PINNED envelope — both platforms must answer **byte-identically** (`<Name>` = the
scheme, first letter uppercased; `platform` = the OS answering):

```json
{ "event": "error", "final": true,
  "code": "unsupported_platform", "recoverable": false,
  "message": "Scene3d is not supported on Android",
  "data": { "scheme": "scene3d", "platform": "android", "supportedPlatforms": ["ios"] } }
```

The knowledge source is the **generator**, never a platform claim:
`prepare_modules_android.rb` §5b computes scheme/alias → platforms from concrete
lane source over the FULL catalog — exclusion-BLIND, D-class included. Common
Swift source implies `ios`; common Kotlin implies `android`; a declared desktop
offer plus Swift compiled by the Catalyst target implies `macos`. Windows/Linux
are deliberately fail-closed: they appear only when the package has source in a
desktop-build-owned `kotlin/desktop`, `kotlin/windows`, or `kotlin/linux` facet.
Generic Android Kotlin is never presumed portable. The result is emitted into
`despia/registry/ModulePlatformSupport.generated.kt`; `GeneratedModules.register()`
installs it into the kernel seam `ModuleRegistry.platformSupport` (default empty =
plain `not_loaded` for everything, the bare-kernel behavior). The kernel consults the
map only **after** a dispatch comes back unhandled — a registered module always wins.
Markup fire-and-forget to an unsupported scheme settles the structured error into its
(void) terminal instead of throwing `unavailable` — results are ignored by
construction on that form; the awaited form sees the full error object.

> **DONE (iOS mirror — upstreamed; do not diverge from the envelope above):**
> `prepare_config.rb` emits the SAME map (cross-verified scheme-for-scheme against the
> Kotlin literal) into `Registry/ModulePlatformSupport.generated.swift`
> (`GeneratedPlatformSupport.byScheme`); `ModuleRegistry.boot()` installs it into the
> same `platformSupport` seam — which lives in `OpenSource/Engine/iOS/Module.swift` (the
> registry's file on iOS), default empty = bare-kernel `not_loaded` — and every
> `not_loaded` synthesis point gained the same pre-check: the native chain
> (`Context.swift` → `ModuleCallError.actionFailed("unsupported_platform", data)`), the
> web promise (`Bridge.swift`) and surface mounts (`Messenger.swift`), and markup
> (`Stack.swift`: the awaited form sees `{ ok:false, error:"unsupported_platform",
> data }`; fire-and-forget settles into its void terminal). iOS implements ~every
> module, so this fires rarely there — Android-only modules (the `barcodescanner`
> carve-out) trigger it with `"… is not supported on iOS"` /
> `supportedPlatforms:["android"]`. Shared law: `dsx-native-bus.md` "Unsupported
> platform — the graceful catalog answer".

The answering platform is the deploy target established at boot, not the UI
toolkit: Swift answers `macos` under Mac Catalyst/native macOS and `ios`
otherwise; the Kotlin desktop host stamps `Platform.os` to `windows`, `linux`,
or `macos` before parsing or module dispatch, while Android remains `android`.
This keeps the envelope's `platform` field and `supportedPlatforms` decision
honest on every native target.

## App-wide state — `dsx.global`

`dsx.global` (the reactive `global.*` store) is a dynamic proxy, **same kind as
`dsx.module` / `dsx.container`** — so the only thing that differs is the chain
*step*: Swift dot vs Kotlin `operator get`. The string-path methods
(`set` / `get` / `state`) are byte-identical (the value literal is the one Kotlin
difference), and any write re-renders every Stack view reading `global.*` on both
platforms.

```swift
let credits = dsx.global.session.credits.int ?? 0    // dot-path read (twin of {{ dsx.global.session.credits }})
dsx.global.set("session.credits", 200)               // string dot-path write (creates nesting)
dsx.global.state("session", ["credits": 120])        // seed/replace a whole top-level key
let raw = dsx.global.get("session.credits")          // get(path) → value
```
```kotlin
val credits = dsx.global.value("session")["credits"] // chain entry is value(path); ["…"] descends from there
dsx.global.set("session.credits", 200)               // identical
dsx.global.state("session", mapOf("credits" to 120)) // only the literal differs
val raw = dsx.global.get("session.credits")          // identical
```

> Kotlin note: `dsx.global["…"]` cannot exist beside `get(path): Any?` — an `operator get`
> returning the chainable value type would conflict with the raw `get` overload modules
> rely on (`dsx.global.get("chrome.manual") as? Bool`). The chain entry is `value(path)`;
> everything after it is `operator get` descent, as shown. (Found while porting
> DSXState.swift to Kotlin — the Kotlin kernel implements exactly this shape.)

The web contract is identical too — `window.dsx.global.get(…)` /
`.set(…)`. Full model (the four state layers, `dsx.global.strings` / `.theme`):
[global-state.md](../global-state.md).

## App-lifecycle / delegate hooks

The iOS host forwards `UIApplicationDelegate` events to every module; the
Android host forwards the matching Android callbacks the same way (from
`Application.ActivityLifecycleCallbacks` / `ProcessLifecycleOwner`, the
`FirebaseMessagingService`, the launching `Activity`, and the `WebViewClient`).
Override the same-named hook:

| Hook | Fires on iOS | Fires on Android |
|---|---|---|
| `dsx.hook("launch")` | `didFinishLaunchingWithOptions` | `Application.onCreate` / first Activity `onCreate` |
| `dsx.hook("becomeActive")` | `applicationDidBecomeActive` | Activity `onResume` |
| `dsx.hook("resignActive")` | `applicationWillResignActive` | Activity `onPause` |
| `dsx.hook("enterBackground")` | `applicationDidEnterBackground` | `ProcessLifecycleOwner` `ON_STOP` |
| `dsx.hook("enterForeground")` | `applicationWillEnterForeground` | `ProcessLifecycleOwner` `ON_START` |
| `dsx.hook("willTerminate")` | `applicationWillTerminate` | `onDestroy` (best-effort; not guaranteed) |
| `dsx.hook("remoteNotificationToken")` | APNs `didRegister…DeviceToken` | FCM `onNewToken` |
| `dsx.hook("remoteNotification")` | `didReceiveRemoteNotification` | FCM `onMessageReceived` |
| `dsx.hook("openURL")` | `application(open:options:)` | `Intent` `ACTION_VIEW` (custom scheme) |
| `dsx.hook("continueActivity")` | universal link `continue:` | App Link `Intent` (`ACTION_VIEW` http/s) |
| `dsx.hook("shortcut")` | Home-screen Quick Action | App Shortcut (`ShortcutManager`) |
| `dsx.hook("navReissue")` &rarr; `HookProducer` | `WKNavigationDelegate.decidePolicyFor` | `WebViewClient.shouldOverrideUrlLoading` / `shouldInterceptRequest` |
| `dsx.hook("downloadResponse")` | `decidePolicyFor navigationResponse` (attachment) | `WebView.setDownloadListener` |

Same fan-out semantics: `fire` broadcasts to every module (void);
`fireAny` (e.g. `openURL`, `continueActivity`) gives modules first look and treats
the event as consumed if any returns non-nil. All run on the main thread.

> A hook with no Android analog (e.g. a token format) still exists for parity;
> it just never fires on the platform that doesn't have the event. Don't branch
> on platform in module code - override the hook and let the host decide when it
> fires.
