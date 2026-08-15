# Runtime API (native) & web contract

Modules talk to the bridge through one handle, **`dsx`**, handed to every action
handler. It has two emission shapes, mapped onto one transport:

| Shape | Native (MODERN) | Web (v2) | Window-global (LEGACY) |
|-------|-----------------|----------|------------------------|
| **Formula** (one answer) | `dsx.resolve(data)` / `dsx.error(code, data?)` | `await dsx.module.scheme.host({…})` | `try? dsx.module.dom.set(["name": …, "value": …])` |
| **Action** (0…n events) | `dsx.event("name", data)` / `dsx.broadcast` | stream handler / `dsx.on(scheme,…)` | `try? dsx.module.dom.call(["fn": …, "args": […]])` |

**Modern vs legacy delivery:** return data with `dsx.resolve`/`dsx.error` (the awaited promise) and
push updates with `dsx.broadcast`/`dsx.event` (events the page subscribes to via `despia.on`). The
window-global forms (`window.<name> = …` / `window.<name>(…)`) are **legacy**, kept only for
old web clients — projected through the Dom module (`try? dsx.module.dom.set(…)` /
`.call(…)`; the old native `dsx.variable`/`dsx.function` verbs are REMOVED); **never**
reach for a window var in new code.

> **Same names, two surfaces.** `dsx.action` here is the *native* runtime API.
> In DSX *markup* the same roots mean different things: `dsx.variable.x` is the reactive surface
> store (a markup path — unrelated to legacy window globals), and `dsx.action.name()` *invokes* a declared
> `<action>` (not the `dsx.action("name") { … }` handler registration below). The markup model is
> [state-and-computation.md](../Documentation/reference/state-and-computation.md).

`resolve`/`error` are correlated by the request id (`__rid`); `event` carries the
`scheme`+`event` discriminator; `broadcast` fans out with no rid. **Never call
`webView.evaluateJavaScript` from a module** - emit through `dsx`.

## Native: the `Module` subclass

```swift
import UIKit

// scheme ("battery") is declared in dsx.json and bound by prepare_modules.
// (No WebKit: modules are WebKit-free by rule - check_module_rules.rb Rule 7.)
final class Battery: Module {
    override func setup() {
        // battery://level  -> one value (formula)
        dsx.action("level") { dsx in
            let pct = Int(UIDevice.current.batteryLevel * 100)
            dsx.resolve(JSON(["percent": pct]))
        }

        // battery://watch  -> stream of updates (action); JS .stop() ends it
        dsx.action("watch") { [self] dsx in
            if dsx.stopped() { stopWatch(dsx.id()); return }
            startWatch(dsx.id()) { pct in dsx.event("change", JSON(["percent": pct])) }
        }

        // re-install legacy window globals on every page load (via the Dom module)
        dsx.hydrate { dsx in try? dsx.module.dom.set(["name": "batteryReady", "value": true]) }
    }
}
```

`dsx` is a per-call value. Async tails just capture it - **no scope mechanism, no
ambient state**. For out-of-band emits (delegate callbacks, lifecycle hooks) use
the module's own `self.dsx`.

### Surface

Registration (in `setup()`):
- `dsx.action { dsx in … }` - the **pre-filter**: runs first on every call to any
  scheme the module claims. Handle the call, or `dsx.skip()` to fall through to
  the named actions. Use it for whole-scheme handling and legacy data-in-host
  schemes (read the raw `dsx.command()`).
- `dsx.action("name") { dsx in … }` - a **named action** for `scheme://name`. Runs
  when the pre-filter skipped (or there is no pre-filter).
- `dsx.ready { dsx in … }` - runs once **per page load**, AFTER the page has
  finished loading (`didFinish` equivalent: `<body>` is parsed, the page is
  interactive). Use when a native push needs a fully-formed document - e.g.
  inline-style writes that the page might otherwise race past during initial
  parse. Sibling to `hydrate`, fired later.
- `dsx.hydrate { dsx in … }` - runs once **per page load** (after the runtime
  installs; window globals reset on navigation, so re-set them here).
- `try? dsx.module.dom.inject(["script": …, "atStart": true])` - contribute a document
  script to the web surface. The Dom module owns the web view, so script/scheme/config
  is a cross-module call (`dsx.module.dom.{inject,serveScheme,eval,call,…}`) — the kernel
  has no `dsx.configure` and a module never builds a `WKWebViewConfiguration` itself.

Routing outcome:
- A pre-filter that does **not** `skip()` is the effective handler (it owns the
  call, even if it answers asynchronously).
- A pre-filter that calls `dsx.skip()` falls through to the named action for the
  host. If none matches, the call auto-errors with code `unknown_action`.

Per-call reads (inside a handler):
- `dsx.args("k")` - one input, already smart-parsed to its native type (String /
  number / Bool / array / object); `nil` if absent. Use it directly; in Swift cast
  only when an SDK needs a concrete static type (`dsx.args("name") as? String`).
- `dsx.args()` - the whole payload as a native `[String: Any]` (forwarding hatch;
  keeps `[Any?]` etc. intact for subsystems that route their own way).
- `dsx.file("k")` - a file param's local URL. A `File`/`Blob` from web is
  stream-uploaded to the local CDN (multipart, never base64) and arrives as a URL
  the handler reads/streams off disk.
- `dsx.list("k")` - a list param as `[String]`: a real array / smart-parsed
  comma-list maps element-wise, a single value wraps to one element, missing → `[]`.
- `dsx.command()` - the raw deeplink URL. **Read params via `dsx.args()`** (works for
  both transports); reach for `command()` only for legacy data-in-host schemes
  (`readhealthkit://STEP,SLEEP`) - a structured call's params are NOT in the URL,
  only in `dsx.args()`.
- `dsx.action.name` - which action fired (the URL host).
- `dsx.id()` - the `__rid`. **Rarely needed** - `resolve`/`error`/`event`
  correlate it to the request for you. Reach for it only to key a stream for
  stop-correlation, or for logging.
- `dsx.stopped()` - `true` when the JS caller stopped a stream (`.stop()`).

Emit (inside a handler - rid-correlated):
- `dsx.resolve(data)` - formula result (terminal; **first call wins**).
- `dsx.error(code, data?)` - formula error (terminal). `code` is a stable,
  machine-readable string; `data` is optional free-form metadata (see Errors below).
- `dsx.event("name", data)` - a non-terminal event; call it repeatedly to stream.

Out-of-band (no active call - delegate callbacks, lifecycle, observers; emit from
`self.dsx`):
- `dsx.broadcast("name", data)` - fan out to the page's `dsx.on(scheme, handler)`
  subscribers (no rid), scoped to the module scheme.
- `try? dsx.module.dom.set(["name": "x", "value": v])` - `window.x = v` (legacy global).
- `try? dsx.module.dom.call(["fn": "x", "args": [d]])` - `window.x(d)` (keep a legacy callback alive).
- `dsx.module.dom.css(["property": "--name", "value": "value"])` - sets a CSS custom property on `:root` (`document.documentElement`) AND `<body>`, in independent try/catch blocks so a missing body at documentStart doesn't abort the root write. Cascade and inline readers both see it: `var(--name, fallback)`, `getComputedStyle(...)`, and `body.style.getPropertyValue(...)`.

Config / capabilities:
- `self.config.<key>` - this module's own typed config (generated from `config.json`).
- `dsx.env` - the runtime environment channel: `.channel` (`"simulator" | "debug" |
  "testflight" | "adhoc" | "appstore"`) and the gate `.isProduction` / `.isTest`.
  Detection FAILS CLOSED to production (ambiguous ⇒ `"appstore"`), so a dev-only
  module's `setup()` starts with `guard !dsx.env.isProduction else { return }`.
  Markup reads the same value as the reserved word `env` / `dsx.app.env`; the web
  reads `global.app.env`. App version/build: `dsx.app.version` (display string) /
  `dsx.app.build` (numeric `CFBundleVersion` — the blessed comparison key).
- `CoreConfig.shared.<group>.<key>` - the host's shared config.
- `dsx.flags().onlyLocalServer()` / `.bridgeVersion()`; `dsx.module.cdn.object("store") as? LocalCDN` for storage.
- `dsx.container` - your subcontainer in the one shared App Group
  (`group.<bundleid>.container`): `.set`/`.remove` (write + signal), `.batch { }`
  (write several, signal once), `.string`/`.value`/`.url()` (reads), namespaced to
  your scheme. Reach another module's by name: `dsx.container.<scheme>` (or
  `dsx.container["<scheme>"]`, read-only). Change signal: `.observe { }` ← `.post()`
  (Darwin; KVO / NSUserDefaultsDidChange don't cross processes). Consumer-specific
  refresh (widget reload, Live Activity update) lives in the consumer's own
  module, reacting to that signal - never in the container core. iOS-only. See containers.md.
- `dsx.module.dom.object("view"|"scrollView"|"userAgent")` - the Dom module's exported web-surface handles (cast to `UIView`/`UIScrollView`/`String`; a `WKWebView` cast is Dom-module-internal only - Rule 7).

Cross-module calls - one module calling another at runtime without
`import`-ing its class. The native twin of DSX's `dsx.module.<scheme>.<method>(…)`:
- `dsx.has("scheme")` - is the module loaded in this build? (sync, no throw)
- `dsx.module.<scheme>.<action>(args)` - one root, both forms: `await` returns the
  handler's resolve payload (`JSON`), a bare call is fire-and-forget. Throws `ModuleCallError`.

```swift
try? dsx.module.appsflyer.set_user_id(["customer_user_id": userId])   // fire-and-forget
let result = try await dsx.module.appsflyer.get_uid()                  // awaitable
```

The chain reads "module . scheme . action ( args )" - same shape the target
registered with `dsx.action("set_user_id") { … }`. Subscript form
(`dsx.module["appsflyer"]["set_user_id"](…)`) is the fallback for dynamic
strings or non-identifier names, and is what Kotlin / Java port to.

> **Native code never uses a `scheme://` string to call a module.** `"spinneron://"`
> and `ModuleRegistry.shared.fire(...)` are the JS/web/legacy transport; in Swift use
> `dsx.module.<scheme>.<action>(…)`. So every module must expose real `scheme.action`s
> (a "scheme-only" scheme can't be named in the dot chain): e.g. the Spinner offers
> `spinner.show` / `spinner.hide`, driven natively by `try? dsx.module.spinner.show()`.

**Deep dive: [cross-module-calls.md](cross-module-calls.md)** - patterns
(optional dep, required dep, fan-out, chained awaits), error model,
receiver-side design, anti-patterns, NotificationCenter comparison.

### Payloads - JSON

Every `data`/`value` is a `JSON`. Build it two ways - both produce the same value.

The **fluent builder** is the unified form, byte-identical on Swift / Kotlin /
Java (`JSON.obj()` / `JSON.arr()` start it; `.put(key, value)` / `.add(value)`
chain):

```swift
dsx.resolve(JSON.obj()
    .put("count", 2)
    .put("users", JSON.arr()
        .add(JSON.obj().put("id", 1).put("name", "Ada"))
        .add(JSON.obj().put("id", 2).put("name", "Linus"))))
```

The **native literal** is per-language map/array sugar:

```swift
dsx.resolve(JSON(["count": 2, "users": [JSON(["id": 1, "name": "Ada"])]]))
```

Values go in dynamically - a native scalar, a nested `JSON`, a `dsx.args(...)`
result, or `nil` (→ `JSON.null`). Scalars pass bare too: `dsx.resolve(true)`,
`dsx.event("tick", 5)`. Reads come back already typed: `dsx.args("count")` is the
number, `dsx.args("name")` the String - drop either straight into a builder.

**Nested `{}` objects** work both ways. Reading - a nested object arrives as a
native dictionary, whether it came structured or smart-parsed from a URL string:

```swift
let cfg   = dsx.args("config") as? [String: Any]   // { token, url, ... }
let token = cfg?["token"] as? String
```

Writing - nest `JSON.obj()`/`JSON.arr()` builders (or wrap a literal in `JSON(...)`),
build one from an existing `[String: Any]` with `JSON.from(dict)`, and use
`JSON.obj()` (or `JSON([:])`) for an empty object:

```swift
dsx.resolve(JSON([
    "user":  JSON(["id": 1, "name": "Ada"]),   // nested object literal
    "meta":  JSON.from(existingDict),           // existing [String: Any]
    "extra": JSON([:])                          // {}
]))
```

### Config

- **Own config** (scoped, no group): `self.config.api_key` - generated from the
  module folder's `config.json`, one entry per key:
  `{ "friendly_name": "<short label>", "friendly_description": "<one sentence>", "value": <default>, "editable": <bool?>, "_note": "<docs?>" }`.
  Codegen reads `value`; `friendly_name` (a required short label) and
  `friendly_description` (a required plain-English sentence), plus `_note` and
  `editable`, are tooling metadata.
- **Host/core config** (shared, grouped): `CoreConfig.shared.server.host` - from
  `DSX/Modules/Config/config.json`.

### Module state — values one module publishes for others

A module can declare typed variables that **other** modules read by name, exclusion-safe — the
structured replacement for `dsx.values("a.b")` cross-module coordination. Declare a `state` block in
`dsx.json`; read with typed dot-access; the owner publishes live vars with a string-keyed verb:

```jsonc
"context": { "facebookAds": "{{ config.use_facebook_ads }}",          // STATIC: mirrors a config value (the unified {{ }} reference syntax)
             "adsSuppressed": { "type": "boolean", "default": false } } // LIVE: owner publishes it
```
```swift
dsx.module.metaads.context.facebookAds.bool        // READ (any module) — default when owner excluded
dsx.context.set("adsSuppressed", true)              // PUBLISH a live var (owner only)
dsx.module.x.context.on("adsSuppressed") { v in … } // SUBSCRIBE — fire now + on change
```

Reads like `dsx.config` (typed dot, defaulted), writes/subscribes like `dsx.global` (string verbs). Full
guide: [module-state.md](module-state.md).

## Native: app-lifecycle / delegate hooks

The host `AppDelegate` runs each `UIApplicationDelegate` method as usual, then
forwards the event to modules as a **named `dsx.hook`** — there are no per-event
`Module` methods. A module opts in by registering the hook in `setup()`; the host
fires it by name via `fire` (broadcast), `fireAny` (consumed-if-any), or `claim`
(first-non-nil). The event name is data, so the kernel never grows per host event.
All hooks run on the main thread:

```swift
override func setup() {
    dsx.hook("becomeActive") { _ in refreshState(); return nil }

    dsx.hook("remoteNotificationToken") { input in
        guard let token = input as? Data else { return nil }
        MyPush.register(token: token.map { String(format: "%02x", $0) }.joined())
        return nil
    }
}
```

**All hooks run on the main thread**, like the delegate calls themselves.

### Fan-out: who sees the event

- **Broadcast** (`fire`): every module's hook runs; results ignored — for Void
  events like lifecycle (`"launch"`, `"becomeActive"`, …) and push.
- **Any-consumed fan-out** (`fireAny` — named `dsx.hook`s like `"openURL"` /
  `"continueActivity"`): modules get **first look, before the host's own routing**.
  Every module is still called (no short-circuit, so all observers see it); the host
  treats the event as **consumed** when *any* returns non-nil. Return `nil` (the
  default) to fall through. Modules run in registration (bootstrap) order.
- **Async claim** (e.g. `dsx.hook("navReissue")`): **first non-nil wins**, not
  fan-out. The sync hook body decides synchronously whether it owns the event; to
  answer asynchronously it returns a `HookProducer` (`@MainActor () async -> Any?`)
  the host `await`s. `ModuleRegistry.claim` walks modules in registration order and
  stops at the first non-nil return.

### The hooks

**Lifecycle** (fired via `fire`; `input` unused except `"launch"`; return `nil`):

- `dsx.hook("launch")` — `input` is the launch options (`[UIApplication.LaunchOptionsKey: Any]?`)
  - *Fires:* once, from `didFinishLaunchingWithOptions`, after the registry
    bootstraps and **before the first page loads**.
  - *Set up:* an SDK that must init at launch, restore persisted state, register
    native observers (HealthKit restores its observers here). `input` tells you *why*
    the app launched: `.remoteNotification`, `.url`, `.shortcutItem`.
  - *Emitting:* the web view does **not** exist yet, so emits are dropped - do
    native work, stash anything web-bound, emit it from `hydrate`.

- `dsx.hook("becomeActive")`
  - *Fires:* `applicationDidBecomeActive` - app is foreground and interactive (after
    launch, after returning from background, after an interruption ends).
  - *Set up:* refresh data, resume timers, re-read permission/auth state, clear the
    badge. The web view is bound once a page has loaded, so emits land.

- `dsx.hook("resignActive")`
  - *Fires:* `applicationWillResignActive` - about to leave the active state.
  - *Set up:* pause in-flight work, save transient UI state.

- `dsx.hook("enterBackground")`
  - *Fires:* `applicationDidEnterBackground` - now backgrounded.
  - *Set up:* persist state, free resources, flush queues.

- `dsx.hook("enterForeground")`
  - *Fires:* `applicationWillEnterForeground` - returning from background (just before
    `"becomeActive"`).
  - *Set up:* undo what backgrounding changed, refresh stale data/UI.

- `dsx.hook("willTerminate")`
  - *Fires:* `applicationWillTerminate` - app is killed while running. **Not
    guaranteed** (iOS usually kills a suspended app with no callback).
  - *Set up:* best-effort last flush; do real persistence on `"enterBackground"`.

- `dsx.hook("motionShake")`
  - *Fires:* the user SHOOK the device (simulator: ⌃⌘Z) — relayed by the kernel's
    `DSXWindow` (`motionEnded(.motionShake)` → one bus fire; the bootloader creates
    that window, so the relay exists on every boot path).
  - *Set up:* dev/QA affordances — the DevSettings panel hooks it to open the
    environment switcher on test installs; bug reporters / QA overlays can too. No
    subscribers ⇒ silent no-op. Void — return `nil`.

**Push / remote notifications:**

- `dsx.hook("remoteNotificationToken")` — `input` is the APNs token `Data`
  - *Fires:* `didRegisterForRemoteNotificationsWithDeviceToken` (APNs registration
    succeeded). Hex-encode for most push backends (see snippet above).
  - *Set up:* hand the token to your push SDK / server. Void — return `nil`.

- `dsx.hook("remoteNotificationError")` — `input` is the `Error`
  - *Fires:* `didFailToRegisterForRemoteNotificationsWithError`.
  - *Set up:* log / disable push-dependent UI. Void — return `nil`.

- `dsx.hook("remoteNotification")` — `input` is the `[AnyHashable: Any]` APNs payload
  - *Fires:* `didReceiveRemoteNotification:fetchCompletionHandler:` - a remote push
    arrived (silent / `content-available`, or delivered while running). The payload is
    `aps` + your custom keys.
  - *Set up:* handle silent pushes, sync data, broadcast to web. The host owns the
    background `completionHandler`, so the hook can't extend background time. On a cold
    launch via push the web view isn't bound yet - persist the payload and re-emit on
    `hydrate`. Void — return `nil`.

**URLs / activities** (return `true` to consume):

- `dsx.hook("openURL")` — the host fires this via `fireAny` (every module sees it;
  consumed if any returns non-nil)
  - *Fires:* `application(_:open:options:)` - a custom-scheme or file URL opened the
    app; modules get first look before host deep-link routing.
  - *Input:* `["url": URL, "options": [UIApplication.OpenURLOptionsKey: Any]]` — the
    opened URL (parse its scheme/host/query) and the open options (e.g.
    `.sourceApplication`, `.openInPlace`).
  - *Returns:* non-nil if your module owns this URL (host stops), else `nil`.
  - *Set up:* `dsx.hook("openURL") { input in … }` — OAuth / redirect callbacks, an
    SDK's custom scheme.

- `dsx.hook("continueActivity")` — the host fires this via `fireAny` (every module
  sees it; consumed if any returns non-nil)
  - *Fires:* `application(_:continue:restorationHandler:)` - a universal link,
    Handoff, or Siri activity; first look before the host.
  - *Input:* the `NSUserActivity` - inspect `.activityType` (`NSUserActivityTypeBrowsingWeb`
    = universal link), `.webpageURL` (`URL?`), `.userInfo`.
  - *Returns:* non-nil to consume; `nil` to fall through — also the observe-only
    pattern: do the work, return `nil` so the host still routes it (AppsFlyer
    attribution does this).
  - *Set up:* `dsx.hook("continueActivity") { input in … }` — universal-link handling,
    Handoff restoration, Siri intents.

- `dsx.hook("shortcut")` — the host fires this as a **claim**
  - *Fires:* `application(_:performActionFor:completionHandler:)` - a Home-screen
    Quick Action was tapped while the app was already running. A cold-launching
    one arrives via the `"launch"` hook's launch options (`[.shortcutItem]`) instead.
  - *Input:* the `UIApplicationShortcutItem` - inspect `.type` and `.userInfo`.
  - *Returns:* non-nil to consume, `nil` to fall through.
  - *Set up:* `dsx.hook("shortcut") { input in … }` in `setup()`. Home-screen Quick
    Actions (Core/QuickActions owns this).

**WebView navigation** — `dsx.hook("navReissue")` (sync gate + async producer;
first non-nil wins). The host fires this as a **claim** from
`WKNavigationDelegate.decidePolicyFor` with input
`["navigationAction": …, "webView": …]`, so a module can cancel a main-frame
navigation and re-issue it with fresh state attached. Runs on the main thread:

- *Fires:* on every main-frame navigation, before the host would otherwise
  `.allow` it. The hook body is the **sync gate** — keep it cheap (navigation hot
  path), don't await here.
- *Returns:* `nil` to let the navigation through unchanged; or a **`HookProducer`**
  (`@MainActor () async -> Any?`) to take it over. The host cancels the original
  request, `await`s the producer, and loads the `URLRequest` it returns.
- *Termination:* the produced request must satisfy the next pass's sync gate (i.e.
  make it return `nil`), so the gate is self-terminating and can't loop. Match by URL
  host plus a stale flag the producer flips fresh, or by the header the gate checks for.
- *Set up:* attach fresh auth (cookies, a bearer header) to the page's own server
  request before it leaves. Core/Clerk uses this for its SSR cookie / header bridge:

  ```swift
  dsx.hook("navReissue") { input in
      guard let info = input as? [String: Any],
            let nav = info["navigationAction"] as? WKNavigationAction,
            shouldReissue(nav) else { return nil }           // cheap sync gate
      let request = nav.request
      return { await freshRequest(for: request) } as HookProducer   // host awaits
  }
  ```

- `dsx.hook("downloadResponse")` — fired by the host as a **claim** (migrated off
  the old `onDownloadResponse` Package method; the first host hook to move onto the
  dynamic `dsx.hook` surface)
  - *Fires:* `decidePolicyFor navigationResponse` when an HTTP response carries
    `Content-Disposition: attachment`; the host has already cancelled the
    navigation, so modules get first look before its `.vcf`/`.pkpass` viewers.
  - *Input:* `["url": URL, "contentDisposition": String]` — the response URL and the
    raw header value (parse `filename=` yourself).
  - *Returns:* non-nil to own the download (host stops), `nil` to fall through.
  - *Set up:* `dsx.hook("downloadResponse") { input in … }` in `setup()` — present a
    share sheet, hand the file to QuickLook, custom save.

### Emitting from a hook

Hooks run with **no active call**, so use the module's own `self.dsx` (not a
per-call `dsx`): `dsx.broadcast("name", …)` -> the page's `dsx.on(scheme, …)`,
`try? dsx.module.dom.set(…)` / `.call(…)` for legacy globals. Emits target the bound web view; if none is
bound yet (before the first `hydrate`, e.g. in the `"launch"` hook) they are **silently
dropped**. Pattern: do the native work in the hook, persist any web-bound result,
then (re-)emit it from `hydrate` on the next page load.

### Need a hook that isn't listed?

The set is curated, not the whole `UIApplicationDelegate` /
`WKNavigationDelegate`. To add one (e.g. a `UNUserNotificationCenter` callback,
or another navigation-policy intercept): pick an event name and `fire` / `fireAny` /
`claim` it from the matching delegate method (`AppDelegate` for
`UIApplicationDelegate`, the Dom module's `WebDelegate.swift` for `WKNavigationDelegate`) — `fire`
broadcasts (Void), `fireAny` is consumed-if-any, `claim` is first-non-nil (an async
answer rides back as a `HookProducer`). Modules opt in with `dsx.hook(name)`. No new
`Module` method, no kernel change — the name is data. A module
*can* reach the delegate directly via `UIApplication.shared.delegate as?
AppDelegate`, but that couples it to the iOS host and breaks cross-runtime
parity, so prefer a hook.

## Web: `window.dsx` (legacy alias `window.despia`)

> App-wide reactive state — read / write / watch the DSX store from web:
> `window.dsx.global.get/set/watch` — see [global-state.md](global-state.md).

Outbound (web -> native). **The modern default is the dot API on `window.dsx`** —
call any module method as **`dsx.module.<scheme>.<method>(params, onEvent?)`** (e.g.
`dsx.module.calendar.add({ title, start, end })`). It IS the same `dsx.module` call
root markup and native use, so all three surfaces read the same; document and
write new code in this form:
```js
const { percent } = await dsx.module.battery.level();                  // formula → resolve
const sub = dsx.module.battery.watch({}, (e) => {                      // stream → event
  if (e.event === "change") updateUI(e.data.percent);
});
sub.stop();                                                            // → dsx.stopped() == true
```
Params travel as a **real object**, not a query string, so arrays / nested objects /
numbers / bools arrive typed. File/Blob values stream to the local CDN (no base64)
and arrive at the handler as a URL. A scheme-only call is `dsx.module.haptic()`; a
non-identifier (legacy-hyphenated) name uses brackets: `dsx.module.ad["get-attribution"]()`.

For a dynamically-named scheme/method, the same dot API takes a bracket step —
`dsx.module[scheme][method](params, onEvent?)`. Legacy pages keep their spelling —
the `window.despia` alias surface (`window.despia.<scheme>.<method>(…)`, same engine,
no `module` root) and the bare string-callable / window-assignment forms
(`despia("scheme://method", …)`, `window.despia = "scheme://…"`) are
**legacy — see [legacy.md](../Documentation/legacy.md)**; new web code stays on
the `dsx.module` dot form above.

Inbound (native -> web): every emit lands in the runtime's emit sink where
`payload = { id, scheme, host, event, final, data, code? }` (`code` only on errors):
- matching `rid` -> resolves/streams that call (formula/stream).
- no `rid` (broadcast) -> fans out to `dsx.on(scheme, handler)` subscribers (the
  legacy `window.despia.on` alias rides the same fan-out).
- the Dom module's `dom.set` / `dom.call` set `window.<name>` directly (no rid).

```js
// formula
const { percent } = await dsx.module.battery.level();

// out-of-band broadcast (observer)
const off = dsx.on("battery", (p) => { if (p.event === "change") updateUI(p.data.percent); });

// legacy window globals (projected via dom.set / dom.call)
//   window.batteryReady          (try? dsx.module.dom.set(["name": "batteryReady", …]))
//   window.onBatteryChange(d)    (try? dsx.module.dom.call(["fn": "onBatteryChange", …]))
```

### Errors

`dsx.error(code, data?)` rejects the call with one uniform envelope - think of it
like an API error response: a stable `code` plus optional free-form `data` (a
string, a JSON object, anything a front-end integration needs). Every `catch`
reads the same two fields:

```js
try {
  await dsx.module.stripe.payment({ … });
} catch (e) {
  e.code;   // stable string, e.g. "card_declined"
  e.data;   // free-form metadata, e.g. { decline_code: "insufficient_funds" } or a string
}
```

Native: `dsx.error("card_declined", JSON.obj().put("decline_code", "insufficient_funds"))`.
Framework built-ins follow the same shape: `unknown_action` (`data: { action }`),
`timeout`, `unsupported`, `upload_failed`. So a customer's bridge can branch on
`e.code` and surface `e.data` without per-module special-casing.

Version / feature detection:
```js
dsx.has("camera");  dsx.version("camera");   // synchronous, no round-trip
dsx.packages                                 // [{ name, version, scheme? }]
```
Transport feature-detection (`supports.*`, `runtime.*`) and the `hasPackage` /
`package` spellings live only on the legacy `window.despia` alias surface — see
`../Documentation/guides/despia-api.md`:
```js
window.despia.runtime.version          // bridge protocol generation
window.despia.runtime.capabilities     // { structured, events, subscribe }
window.despia.hasPackage("camera");    // the legacy spelling of dsx.has
```

## Cross-platform note

Every native name (`action`, `args`, `command`, `resolve`, `error`, `event`,
`broadcast`, `hydrate`, `ready`, `skip`,
`stopped`, `has`, `dispatch`, `call`) ports 1:1 to the Kotlin/Java Android
bridge: no
reserved words, finality in the verb (`event` vs `resolve`), and `dsx` handed
into each handler (no ambient state, no scope object). The per-call **reads
are zero-arg methods** - `dsx.command()` / `dsx.id()` / `dsx.stopped()` - so
the call is byte-identical in Swift, Kotlin, and Java (Java has no
properties). `dsx.action.name` is the one nested read.

`ModuleCallError` ports as a Kotlin sealed class with the same three
variants - `NotLoaded(scheme)` / `InvalidURI(uri)` / `ActionFailed(code, data)` -
and an exception hierarchy on Java with one subclass each. Switching on the
case name is the same shape across all three.

A handful of things can't be byte-identical, by language rule, not by design:
- Java passes a lambda inside the parens (no trailing closure).
- The JSON literal differs (`JSON([…])` / `JSON(mapOf(…))` / `JSON(Map.of(…))`).
- Casting an arg to a concrete type differs (`as? String` / `as? String?` / `(String)`).
- The awaitable leaf of `dsx.module` swaps Swift's `async throws -> JSON`
  for Kotlin's `suspend fun … : JSON` (and a callback-style `callAsync` on Java).
- The `dsx.module` chain step uses `.` on Swift
  (`@dynamicMemberLookup`) and `[…]` on Kotlin / Java (`operator fun get`):
  `dsx.module.appsflyer.set_user_id(args)` ↔
  `dsx.module["appsflyer"]["set_user_id"](args)`. Same proxy chain, same
  identifiers, same `(args)` invoke at the leaf - just a different way to
  spell the dynamic step. Swift also accepts the `[…]` form (so a Swift call
  with a dynamic string reads identically to the Kotlin version).

The wire payload (`{id, scheme, host, event, final, data}`) and the JS contract
are identical.
