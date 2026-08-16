# Extracting a host feature into a module

Most older features live **woven into the host**: a `WebView/<Feature>Bridge.swift`
singleton, plus a branch in `WebViewController.dispatchPackageURI` that matches the
scheme and calls it. This guide moves one of those into a self-contained
`DSX/Modules/Core/<Feature>/` module - **with full backwards compatibility**, so
existing web code keeps working byte for byte.

Worked example: **Stripe** — the COMPLETED reference extraction. Its bridge started
life host-woven (the old `WebView/StripeBridge.swift`); today it lives at
`ClosedSource/DSX/Modules/Core/Payments/Stripe/swift/StripeBridge.swift` with a full
manifest (scheme `stripe`, a declared `actions` block, its pod):

```json
{ "name": "Stripe", "scheme": "stripe", "pods": ["StripePaymentSheet"] }
```

The steps below are the recipe that produced it (written as you'd run them on the
next host-woven feature).

## What "woven in" looks like (the before)

```swift
// WebView/StripeBridge.swift - a host singleton
final class StripeBridge {
    static let shared = StripeBridge()
    func handle(url: URL, webView: WKWebView, presenter: UIViewController) {
        switch url.host { case "payment": ...; case "manage": ... }
    }
    // result goes back via raw JS:
    //   webView.evaluateJavaScript("window.stripeEvent(\(json))")
}
```

```swift
// WebView/WebViewController.swift - the dispatchPackageURI legacy chain
if requestURL.absoluteString.hasPrefix("stripe://") {
    StripeBridge.shared.handle(url: requestURL, webView: webView, presenter: self)
    decisionHandler(.cancel); return
}
```

Two things get replaced: the **dispatch** (the `hasPrefix` branch) and the **emit**
(`evaluateJavaScript`). The registry already gets first dibs in `dispatchPackageURI`
- `ModuleRegistry.shared.handle(...)` runs before the legacy chain - so once the
module claims `stripe://`, that branch is dead code.

## File-presence is the gate - never a `#if`

The module's source files live under `DSX/Modules/Core/<Feature>/`. When the module
is dropped from a build (`DSX/Modules/Config/excluded.json`), `prepare_modules.rb`
removes those files from the Runtime synced folder - so the class doesn't exist,
its frameworks don't link, its user scripts aren't installed, and any URL it
claimed falls through to the host's normal handlers. **Nothing in the host
references the module by symbol.**

That makes `#if FEATURE_ENABLED` blocks unnecessary by construction. If you're
tempted to add one - or to declare `swiftFlags` on the manifest to define one -
the host is still naming the module. Move the gated code into the module
instead: a `Module` subclass that registers what it needs in `setup()`. The
file's presence under `DSX/Modules/` is the gate; its absence is the off-switch.

Worked example - Web Speech polyfill. The old shape kept a global `speechBridge`
in `WebViewController`, with four `#if SPEECH_RECOGNITION_ENABLED` blocks (property,
addUserScript, attach, URL handler). The new shape moves `SpeechBridge.swift`
under `DSX/Modules/Core/WebPlatform/SpeechRecognition/` and lets `setup()` do its
jobs - dispatch via `dsx.action`, polyfill script via `dsx.module.dom.inject`, and
native→web replies via `dsx.module.dom.call` (see next section). The host no longer
mentions SpeechBridge; excluding the module compiles to a no-op surface.

## 1. Declare the scheme in the manifest

The folder and pod already exist; just add the `scheme` (and any legacy `aliases`).
Pods / Info.plist / entitlements stay where they are.

```json
{ "name": "Stripe", "scheme": "stripe", "version": "1.0.0", "pods": ["StripePaymentSheet"] }
```

> **`scheme` is the LOCAL identity segment** (`[a-z][a-z0-9_]*` — hyphens are banned, so a
> hyphenated shipped scheme becomes an alias: `get-uuid` ships as scheme `uuid` +
> `"aliases": ["get-uuid"]`). Nested under a parent's `Modules/`, the dotted **chain**
> derives from the tree (`watch.health`) — never hand-write it; in code use
> `Self.resolvedScheme` where the identity string is needed. Law:
> `Documentation/architecture/facet-contracts.md`, *Derived identity*.

## 2. Move the file in and subclass `Module`

Move `StripeBridge.swift` into `DSX/Modules/Core/Stripe/swift/` and make it a module. The
folder and scheme stay `stripe`; give the **class** a non-colliding name if it would
shadow the SDK module (see the naming note in
[writing-a-module.md](writing-a-module.md)).

```swift
import UIKit
import StripePaymentSheet

final class Stripe: Module {            // folder Stripe, scheme "stripe"
    private var retained: Any?           // keep the presented sheet alive

    override func setup() {
        // One handler per sub-command. The registry maps the URL host
        // (stripe://payment, stripe://manage) to the matching action.
        dsx.action("payment") { [self] dsx in presentPaymentSheet(dsx) }
        dsx.action("manage")  { [self] dsx in presentCustomerSheet(dsx) }
    }
}
```

> Use a named `dsx.action` per fixed sub-command - this is the common case, and never name
> one a reserved proxy member (`on · available · excluded · state · context · object ·
> delegate · dsx · then` — a build error; the shipped collisions were renamed with legacy
> wire shims, e.g. `bluetooth.state`→`status`). A legacy
> alt-scheme is declared in `dsx.json` `aliases` and handled in the pre-filter — aliases
> route at head position only; the arriving legacy spelling stays visible to the pre-filter
> (`dsx.command()`), while identity (state, events, config) is always the primary chain.
> Reach for the pre-filter `dsx.action { dsx in switch dsx.command()?.host }` **only**
> when the host slot is not a clean enum - e.g. HealthKit packs comma-separated type
> identifiers there, which a named action / `URLComponents.host` cannot split.

### Web-surface polyfills - `dsx.module.dom.inject` + a bridge action

When the feature is a JS-side polyfill (e.g. SpeechRecognition exposing
`window.SpeechRecognition` over `SFSpeechRecognizer`), the module contributes its
polyfill script to the page and exposes a despia **action** the script calls. It
**never** holds a `WKWebView`, attaches a `WKScriptMessageHandler`, or touches
`userContentController` - the Dom module owns the web surface (constitution Article 9),
so script-injection and native→web replies are cross-module calls to it. There is no
`dsx.configure`:

```swift
final class SpeechBridge: Module {
    override func setup() {
        // 1. Inject the polyfill at document-start. The Dom module installs it on every
        //    load and evals it on the current page — no held WKWebView, no WKUserScript here.
        try? dsx.module.dom.inject(["script": Self.injectedScript, "atStart": true])

        // 2. The action the polyfill calls — `window.dsx.module.speechrecognition.start({…})` —
        //    replaces the old `window.webkit.messageHandlers.nativeSpeechRecognition`.
        //    Streaming results flow back via dsx.event; one-shot replies via dom.call.
        dsx.action("start") { [weak self] dsx in self?.start(dsx) }
        dsx.action("stop")  { [weak self] dsx in self?.stop(dsx) }
    }

    private func emit(_ payload: [String: Any]) {
        // native → web: call a page callback THROUGH the Dom module (never a held WKWebView).
        try? dsx.module.dom.call(["fn": "window.native.speech.dispatch", "args": [payload]])
    }
}
```

The polyfill's JS transport changes from `window.webkit.messageHandlers.nativeSpeechRecognition`
to the page bridge (`window.dsx.module.speechrecognition.start(...)`), so the module needs no
`WKScriptMessageHandler`, no `userContentController`, and no `import WebKit`. Excluding the
module drops the file - the script never injects, and `window.SpeechRecognition` falls back to
whatever the web view ships natively (nil today). This is exactly how the shipped
SpeechRecognition / OAuth / FileUpload modules work (Phase 05 of the native-bus migration).

## 3. Read params through `dsx` (inside `presentPaymentSheet(_:)`)

Drop the hand-rolled query parser - `dsx.args` reads both the modern structured
call (`window.despia.stripe.payment({ … })`) and the legacy URL/string form
(`despia("stripe://payment", { … })`, legacy — see [legacy.md](../Documentation/legacy.md)),
already decoded and smart-parsed.

```swift
let key    = dsx.args("publishable_key") as? String ?? ""
let secret = dsx.args("payment_intent_client_secret") as? String ?? ""
guard !key.isEmpty, !secret.isEmpty else {
    // synchronous failure - emit and bail. code + free-form data, plus the
    // legacy callback for shipped web code.
    dsx.error("missing_param", JSON.obj().put("method", "paymentSheet"))
    dsx.function("stripeEvent", JSON(["method": "paymentSheet", "status": "failed", "error": "missing param"]))
    return
}
STPAPIClient.shared.publishableKey = key
```

## 4. Present from the web view, emit through `dsx`

A module never holds a `WKWebView` (a WK cast fails `check_module_rules.rb` Rule 7) and
has no `presenter`. Derive the presenter the way the shipped Stripe module does
(`StripeBridge.swift`) — from the top view controller (or cast the Dom module's
exported handle, `dsx.module.dom.object("view")`, to a plain `UIView` when you need
the surface itself):

```swift
guard let presenter = UIApplication.topViewController() else { return }

// The result arrives async, after setup()'s body has returned - just capture
// `dsx`; it stays valid (no scope() to remember).
let sheet = PaymentSheet(paymentIntentClientSecret: secret, configuration: config)
retained = sheet
sheet.present(from: presenter) { [weak self] result in
    self?.retained = nil
    let payload: JSON
    switch result {
    case .completed:     payload = JSON(["method": "paymentSheet", "status": "completed"])
    case .canceled:      payload = JSON(["method": "paymentSheet", "status": "canceled"])
    case .failed(let e): payload = JSON(["method": "paymentSheet", "status": "failed", "error": e.localizedDescription])
    }
    dsx.resolve(payload)                      // settles the page's await dsx.module.stripe.payment(…)
                                              // (legacy pages keep window.despia.stripe.payment)
    // legacy: keep the shipped window.stripeEvent(d) callback firing — through the Dom
    // module's page-callback channel (never a held web view, never a bespoke plane):
    try? dsx.module.dom.call(["fn": "stripeEvent", "args": [payload.foundationValue]])
}
```

```swift
private func topPresenter(_ webView: WKWebView) -> UIViewController? {
    var vc = webView.window?.rootViewController
    while let presented = vc?.presentedViewController { vc = presented }
    return vc
}
```

### Keeping the legacy `window.stripeEvent` callback

The existing contract is a **callback**: `window.stripeEvent(d)`.
`dsx.module.dom.call(["fn": "stripeEvent", "args": [d]])` reproduces it exactly (it calls
`window.stripeEvent(data)` on the page). Fire it **alongside** `dsx.resolve` so both
audiences are served: new web code awaits the promise (or subscribes via the page's
`dsx.on("stripe", …)`), shipped web code keeps getting its legacy callback. Use
`dsx.module.dom.set(["name": "name", "value": d])` instead when the old contract was an
**assignment** (`window.name = data`), not a call — the Dom module owns ALL such legacy
window-global deliveries; there is no kernel `dsx.variable`/`dsx.function` delivery verb
any more.

## 5. Move SDK keys into module config (when the key is host-side)

Stripe's `publishable_key` arrives per call, so nothing moves. For an SDK whose key
lives in **central** config (e.g. a RevenueCat / OneSignal app key in the generated
`CoreConfig`), put it in the module's own `config.json` and read it
scoped, instead of leaving it in `CoreConfig`:

```json
// DSX/Modules/Core/<Feature>/config.json
{
  "api_key": {
    "value": "",
    "editable": true,
    "_note": "Where to get the key (link), what scope it needs, etc. Short markdown; codegen ignores it, tooling can render it."
  }
}
```
```swift
let key = config.api_key   // generated, typed, scoped to this module (reads `value`)
```

`value` is the default (use `""`/null when there's none). `_note` is per-key
markdown docs; `editable: false` marks a fixed default to hide from a config UI
(still overridable for custom builds). Both are tooling metadata - codegen reads
only `value`.

## 6. Move lifecycle / navigation hooks onto the module

If the feature listened to app-delegate / lifecycle events from the host, register
the matching named `dsx.hook` in `setup()` instead - the host fires them by name.
HealthKit, for example, restores its observers on launch:

```swift
dsx.hook("launch") { _ in HealthKitObserverManager.shared.restoreObservers(); return nil }
```

Same pattern for a `WKNavigationDelegate.decidePolicyFor` intercept that
cancels and re-issues a main-frame request (Core/Clerk's SSR cookie / header
bridge): register `dsx.hook("navReissue")` instead of keeping a host branch —
the sync hook body is the gate, and it returns a `HookProducer` the host
`await`s for the request to load.

Full hook list - each hook's args, when it fires, and the void / `Bool` /
nav-pair fan-out semantics - is in *App-lifecycle / delegate hooks*
(`runtime-api.md`).

## 7. Delete the host wiring

- Remove the `if requestURL.absoluteString.hasPrefix("stripe://") { StripeBridge... }`
  branch from `WebViewController.dispatchPackageURI`.
- Delete `WebView/StripeBridge.swift` - its code now lives in the module.
- Move any central config keys you relocated in step 5 out of the generated `CoreConfig` into the module's `config.json` (there is no `Host/Config.swift` shim — it was deleted in #790).
- Delete every `#if FEATURE_ENABLED` block that referenced the module - the
  feature is now gated by file presence, no compile flag needed. Pull the
  property declarations, the addUserScript / attach / `Bridge()` instantiation,
  and the URL handler out of the host (`WebViewController.swift`,
  `AppDelegate.swift`, …). The host should not reference the module by symbol
  after this step.

The registry claims `stripe://` at launch, so dispatch flows through the module with
no host branch.

## 8. Regenerate, install, test

```bash
ruby ClosedSource/scripts/prepare_modules.rb     # picks up the new scheme + source membership
pod install                         # only if pods changed (they did not here)
```

Test the **golden path** (present a sheet, complete a payment) **and the legacy
global** (`window.stripeEvent` still fires) from web. The feature is now drop-in:
disable it via `DSX/Modules/Config/excluded.json`, and it ports
1:1 to a Kotlin module of the same shape.

## Checklist

- [ ] local-segment `scheme` (+ legacy `aliases`) added to `dsx.json`; pods kept
- [ ] File moved into `DSX/Modules/Core/<Feature>/swift/`; class subclasses `Module`
- [ ] a named `dsx.action("host")` per sub-command replaces the host `switch` (use the pre-filter only for dynamic/messy hosts); `dsx.args` replaces the query parser
- [ ] for JS-polyfill bridges, `dsx.module.dom.inject` adds the polyfill script + a `dsx.action` receives the bridge call (no `WKScriptMessageHandler` / `userContentController` / `import WebKit`)
- [ ] `dsx.resolve`/`dsx.event` + `dsx.module.dom.call` replace `evaluateJavaScript`; `dsx.function`/`dsx.variable` keeps any legacy window global
- [ ] async results just capture `dsx` (no scope object)
- [ ] host-side keys moved to the module `config.json`; lifecycle hooks overridden
- [ ] host wiring deleted (`dispatchPackageURI` branch + `WebView/<Feature>Bridge.swift` + every `#if FEATURE_ENABLED` block); no host file mentions the module
- [ ] `ruby ClosedSource/scripts/prepare_modules.rb` run; golden path + legacy global verified
