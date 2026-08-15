# DSX as a native bus — architecture
> The mental model: **DSX is a native message bus. Modules provide. Surfaces consume.
> The web view is one surface, not the runtime.** Adopted as the target architecture for the
> kernel WebKit-confinement + `module` rename + delegate work. Companion: `constitution.md`.
```
                  +------------------------------+
                  |          dsx (core)          |
                  |  scheme / action  (register) |
                  |  module           (call)     |
                  |  delegate         (answer)   |
                  |  broadcast / on   (signal)   |
                  |  context          (state)    |
                  +--------------+---------------+
                                 |
        +------------------------+------------------------+
   modules                   surfaces                 surfaces
   (providers)            (dom module)               (DSXView)
   appsflyer · terra      hosts WKWebView            native UI
   apple-auth · ...       page bridge -> bus         calls bus directly
                          dom.inject (webkit only)   binds context, reactive render
```
## The one public symbol
There is exactly one public symbol: `dsx`. Everything is a member of it; the runtime type
behind it is internal and never named in app/module/host code (no `DSX.shared`). The closure
parameter reuses the same name on purpose: inside an action `dsx` is the call, outside it is the
ambient handle.
### Canonical surface (the only public verbs)
| verb | purpose |
|---|---|
| `dsx.scheme(name) { }` | register a module namespace |
| `dsx.action(name) { dsx in }` | a leaf action (takes the call `dsx`) |
| `dsx.group(name) { }` | a folder of nested actions (a plain build block — `dsx.action` inside it registers under the group's dotted prefix); nests freely. leaf-vs-folder is a verb distinction, not a naming habit |
| `dsx.module(envelope)` · `dsx.module.<name>.<method…>(args)` | call a capability — `<name>` is the module's derived dotted CHAIN (`watch.health`, see *Module identity* below). JSON envelope is canonical; dot/named-arg/subscript are sugar |
| `dsx.args(key)` | read inbound args inside an action |
| `dsx.resolve(value)` · `dsx.reject(code, message:, recoverable:, data:)` | settle the call once (reject keeps the structured `{code,message,recoverable,data}` contract). On the AMBIENT hat (the module handle — no call to settle) the same error verbs are the out-of-band EMISSION: ledger + `module.error` + page channel + `global.dsx.*` keys — repeatable by design (error-system.md) |
| `dsx.errors` | the error LEDGER read API: `recent()` (ring, cap 128) · `count()` (monotonic) · `clear()` (dev). Fed by ambient emissions, call failures AND uncaught markup throws (`origin: "uncaught"`); reactive twins `global.dsx.lastError` / `global.dsx.errorCount` |
| `dsx.log(…)` | the unified console primitive (logs corpus): console.log-shaped variadic formatting (JSE coercions + canonical JSON + credential masking), recorded in the LOG RING attributed to the module's scheme (markup: the surface's owner, `"app"` unscoped) + one `[dsx.log]` kernelLog line (Xcode / logcat / the armed diagnostics drawer). Records, never unwinds, never throws |
| `dsx.logs` | the log ring read API: `recent()` (ring, cap 500) · `count()` (monotonic) · `clear()` (dev). `dsx.log`, the `console.*` builtin (scheme `"console"`), and the page's `dsx.log` (→ scheme `"page"`) all land here |
| `dsx.event(value)` | stream values back to this caller (correlated) |
| `dsx.config.<key>` | this module's own static per-app config (from `config.json`) — read-only |
| `dsx.delegate.<event>` | host callback: attach with a closure, invoke with a payload |
| `dsx.module.<name>.delegate.<event>` | a module's own callback: attach or invoke |
| `dsx.context.set(var, v)` · `dsx.module.<name>.context.<var>` | a module publishes runtime state; others read it |
| `dsx.broadcast(name, payload)` · `dsx.on(name) { }` | undeclared loose signal, no contract |
| `dsx.global` | app-global cross-screen native state store (surfaces project it as `{{ global.* }}`) |
| `dsx.context` · `dsx.delegate` | a package's OWN context: the state it publishes + the decisions it exposes (self twin of `dsx.module.<name>`) |
| `dsx.shared.use(key)` / `export(key, obj)` | vend/consume a live native object handle (e.g. the dom module vends its web view) — internal-ish, kept, allowlisted to declared exports |
Three state-shaped things, do not conflate: `dsx.config` is static per-module config, read-only.
`dsx.context` (the module's own self-handle) is runtime state a module publishes
for others to read. `dsx.global` is the app-global cross-screen runtime store the surfaces project.
Banned, never to reappear: `dsx.call`/`dsx.invoke` as public, `dsx.emit`, **`dsx.inject` (it is `dsx.module.dom.inject`)**, and any singleton spelling. `dsx.global` is the canonical app-global store; `dsx.context` is now a package's own published state (not the store). `dsx.values` (private scratchpad) stays internal-only.

**The reserved scheme `dsx`** — refused to modules at registration (`dsx.has("dsx")` is
always false), it is the KERNEL's own channel: outbound, every ambient error mirrors onto it
(`dsx.on("dsx", …)` on the page — one global error listener per app, error-system.md §3.3b); inbound,
the kernel answers its verbs on the bus — dispatch scheme `dsx`, action `log` (`{ message, scheme? }`,
records into the log ring, default source `"page"`) or action `error` (`{ code, message?,
recoverable?, data?, scheme? }`, runs the ambient fan-out); the page spells them `dsx.log(...)` /
`dsx.error(...)` — dot notation IS the API, on every surface. The page inside DSXWebView rides
exactly this through `window.dsx` (the 1:1 surface runtime.js installs: `dsx.module.*`,
`dsx.log`, `dsx.error`, `dsx.global`, `dsx.on`, `dsx.has` — `window.despia` stays only as
the LEGACY alias of the same engine) plus automatic `window.onerror`/`unhandledrejection`
forwarding; an unknown verb answers `unknown_action` honestly. Corpus-pinned
(`Conformance/errors`, `Conformance/logs`).
## Module identity — the dotted chain at the funnel
A module's identity is its derived dotted **chain** (`watch.health` — a manifest declares only
its LOCAL segment; `Modules/` nesting derives the rest: `facet-contracts.md`, *Derived
identity*). The chain is both the call face (`dsx.module.watch.health.heartRate(…)`, and the
envelope's `scheme` field) and the wire scheme token (`watch.health://heartRate`) — registry
route keys are `<chain>://a/b/c`. RESOLUTION happens once, at each runtime's ONE dispatch
funnel (Swift `ChainResolver` + `Context._call/_dispatch` + the `handle(url:)` wire · Kotlin
twin · TS `bus.ts`): alias-normalize the arriving head (legacy spellings — `watchhealth`,
`get-uuid`, `state` — route here, head position only), then FOLD segments into the chain while
a deeper identity is known (registered ∪ build-excluded — the honest universe, so an excluded
child attributes correctly instead of becoming a phantom action on its parent); the remainder
is the action path. Never dot-counting, never a first-dot split. The module proxy's reserved
members `on · available · excluded · state · context · object · delegate · dsx · then`
(CLOSED, frozen) route to the member plane, never to a call — one that reaches a MODERN
call face anyway (the typed proxies, the dotted-callee face, native `_call`/`_dispatch`)
is refused with the cross-runtime code `reserved_member`. The LEGACY WIRE face is exempt
and routes direct — the fold still applies for ROUTING (a nested chain reaches its owner),
but the member word dispatches as a plain action on the folded chain, which is what keeps
the code-only legacy shims (`biometric://available`, `bluetooth://state`) answering
shipped pages: reserved words are banned from MANIFESTS, never from the wire. Corpus:
`OpenSource/Conformance/chains/`.
## The call contract: one JSON envelope
Every call is a unified JSON envelope. The `JSON` builder is the one runtime primitive that is
byte-identical on Swift/Kotlin/Java, so the **envelope is the contract** and native sugar lowers to it.
```swift
try await dsx.module(JSON.obj()
    .put("scheme", "airbridge")
    .put("method", JSON.arr("track", "event"))     // ARRAY path — never a dotted string; no separator can collide
    .put("args",   JSON.obj().put("name", "purchase")))
```
State/delegate access ride the same envelope (`.put("state","attribution")`, `.put("delegate","shouldUpload")`).
### The 1:1 forms — split by static vs dynamic, not by syntax
The only thing byte-identical across three languages is JSON text, because it is a string they all carry verbatim, not their grammar. So the 1:1 form depends on whether the payload has a runtime value in it.
Static or literal payload → `json("""...""")`. Real JSON, copy-pastes to a `.json` file or curl, identical on all three. Swift's `json(_:)` validates at runtime (a plain `JSONSerialization` parse — invalid input → `.null`); Kotlin and Java validate at runtime plus lint.
```swift
dsx.module.airbridge.set_user_id(json("""{ "name": "purchase", "revenue": 9.99 }"""))   // Swift
```
```kotlin
dsx.module.airbridge.set_user_id(json("""{ "name": "purchase", "revenue": 9.99 }"""))   // Kotlin, identical bytes
```
```java
dsx.module.airbridge.set_user_id(json("""{ "name": "purchase", "revenue": 9.99 }"""));  // Java 15+, identical bytes
```
Dynamic payload (a variable goes in) → the builder `JSON.obj().put("id", id)`. Also 1:1, and it inserts the value as data, not text. Never string-interpolate into the JSON text: interpolation is per-language (Swift `\(id)`, Kotlin `$id`, Java none) so it breaks 1:1, and concatenating a runtime value into JSON is an injection footgun.
```swift
dsx.module.airbridge.set_user_id(JSON.obj().put("id", id))   // 1:1, value inserted as data, safe
```
Note: the three languages strip triple-quote indentation differently (Swift by the closing delimiter, Kotlin needs `.trimIndent()`, Java by the least-indented line). Harmless here, JSON whitespace is insignificant and `json(...)` reparses, so the value is identical even when the raw stripped bytes are not.
### Typed sugar (not 1:1) — where a language gives it free
```swift
dsx.module.airbridge.track.event(name: "purchase", revenue: 9.99)   // Swift: @dynamicMemberLookup + @dynamicCallable (FREE)
dsx.module.airbridge.track.event(["name": "purchase"])              // Swift: dict-literal args (FREE)
```
```kotlin
dsx.module.airbridge.track.event(name = "purchase", revenue = 9.99) // Kotlin: needs `methods` codegen (typed)
dsx.module["airbridge"]["track"]["event"](mapOf("name" to "purchase")) // Kotlin: subscript + map (FREE, the floor)
```
```js
await window.dsx.airbridge.track.event({ name: "purchase" });    // JS Proxy (via the dom adapter)
```
**Named-field ergonomics matrix** (the JS `{name: …}` feel = parens, not braces — `{}` is a closure in Swift/Kotlin):
| | named-field call | machinery |
|---|---|---|
| Swift | `event(name: …, revenue: …)` | **free** (`@dynamicCallable`) |
| Kotlin | `event(name = …, revenue = …)` | `methods` codegen (Proposal A) |
| Java | `event(…, …)` (positional) | `methods` codegen |
| floor (all) | `event(["name": …])` / `event(mapOf("name" to …))` | none |
Named fields trade 1:1 for ergonomics and per-arg checks. Pick per call site: `json("""...""")` for static 1:1, builder for dynamic 1:1, named fields for typed ergonomics.
`dsx.json` holds only **runtime** metadata (state defaults, delegate `combine`/`async`/`default`).
An optional `methods` block is **opt-in** and only drives typed-accessor codegen (autocomplete +
compile-checks for Kotlin/Java parity); a method needs no declaration to be callable via the envelope/floor.
This is a reversible door — codegen can be added later as pure sugar. Detail: `typed-module-api.md`.
### Unsupported platform — the graceful catalog answer (shared law)
A scheme that exists in the FULL module catalog but has **no implementation on the running OS**
answers a structured `unsupported_platform` error — deliberately **distinct** from "implemented here
but excluded by this app" and "unknown scheme", which keep answering `not_loaded` / `unavailable`
unchanged. `dsx.has(scheme)` stays **false** for all three: feature detection remains the primary
pattern; this error is the honest answer when someone calls anyway. The knowledge source is the
**generator**, never a platform claim: each native pipeline (`prepare_config.rb` on Swift,
`prepare_modules_android.rb` §5 on Kotlin) computes the SAME exclusion-blind scheme→platforms map
from concrete lane source. Common Swift/Kotlin map to `ios`/`android`; a desktop offer plus
Catalyst-compiled Swift maps to `macos`; Windows/Linux require explicit compiled
`kotlin/desktop|windows|linux` source, so generic Android Kotlin can never be over-advertised. A
generated registry fills the kernel seam `ModuleRegistry.platformSupport` (default empty =
plain `not_loaded` for everything unhandled, the bare-kernel behavior). The kernel consults the map
only **after** a dispatch comes back unhandled — a registered module always wins — and every surface
answers the PINNED envelope byte-identically on every native target (`<Name>` = the scheme, first letter
uppercased; `platform` = the OS answering): the web promise gets the envelope below, the native chain
throws `ActionFailed("unsupported_platform", data)` (an existing case, no new type), and markup's
awaited form sees `{ ok:false, error:"unsupported_platform", data }` (the fire-and-forget form
settles the structured error into its void terminal — results are ignored by construction there).
Swift selects `ios` versus `macos` from the deploy target; Android answers `android`; the desktop
Kotlin host boot-stamps `windows`, `linux`, or `macos` before parsing or dispatch.
```json
{ "event": "error", "final": true, "code": "unsupported_platform", "recoverable": false,
  "message": "Scene3d is not supported on Android",
  "data": { "scheme": "scene3d", "platform": "android", "supportedPlatforms": ["ios"] } }
```
Full spec + per-surface table: `OpenSource/Skills/android/api-mapping.md` "Unsupported platform".
## Invariants
1. `dsx` is the only public API. No singleton, no runtime type in examples.
2. DSX core is **surface-agnostic**. No core member names a web view; WebKit-only APIs live in the dom module.
3. The web view **is a module** (`dom`) — same lifecycle/rules as any module, not a privileged host.
4. Injection is module-scoped: `dsx.module.dom.inject(...)`. Never `dsx.inject(...)`.
5. Native modules expose native primitives; they never reach into the web view. The sole exception is the dom module's legacy JS-injection path, and `dsx.shared` exports are allowlisted, not a general object bus.
6. Delegates fan out through `dsx.delegate`. Surfaces and modules attach to the named event, not to the web view.
7. The call contract is one JSON envelope; native sugar lowers to it. `dsx.json` holds only runtime metadata.
8. Global state is one native store of primitives. Surfaces are projections; native is source of truth.
9. Action handlers are written once and never branch on caller. The resolver is supplied by whoever invoked.
## Actions nest (folders & leaves)
A leaf `dsx.action` takes the call `dsx`; a folder `dsx.group` takes a plain build block that runs with
the group's dotted prefix active, so the `dsx.action` calls inside it register as children
(`Context.swift` `group(_:_:)`, Kotlin `Context.kt` `group`). Registry keys are flat paths
(`appsflyer/track` and `appsflyer/track/event` are independent), so a node can be both callable and a
parent. The two verbs make leaf-vs-folder explicit on both Swift and Kotlin, no signature-sniffing.
```swift
dsx.scheme("appsflyer") {
    dsx.action("set_user_id") { dsx in                         // leaf
        AppsFlyerLib.shared().customerUserID = dsx.args("id") as? String
        dsx.resolve(["ok": true])
    }
    dsx.group("track") {                                       // folder (prefix "track.")
        dsx.action("event") { dsx in dsx.resolve(["ok": true]) }
    }
}
```
## `dsx.delegate` — callbacks others answer
State is a value others read; a delegate is a callback others answer. Every handler normalizes to
`(JSON) -> JSON?` (`nil` = abstain). Attach with a closure, invoke with a payload. How answers fold is the
declared `combine` — five and only five:
- `claim` — first non-nil in load order wins (routing: openURL, decidePolicy)
- `veto` (`all`) — true unless someone returns false (gates: shouldUpload)
- `any` — false unless someone returns true (permissioning)
- `collect` — gather every non-nil into an array (enrichment)
- `void` — fan out to all, return ignored (didSync, push, lifecycle)
```swift
dsx.delegate.openURL { input in                                       // claim
    guard let url = input["url"].string, isMine(url) else { return nil }
    route(url); return true
}
dsx.module.terra.delegate.shouldUpload { input in (input["bytes"].int ?? 0) < 10_000 }   // veto
let extras = dsx.module.analytics.delegate.enrich(["event": "purchase"])                 // collect -> [JSON]
```
The kernel folds in one function over a generated registry (no per-delegate code); **sync and async**
variants exist (`async: true` delegates like `web.decidePolicy`/`authChallenge` are awaited, and the host's
`decisionHandler` is called inside the continuation). Fail-open: excluded module → attach no-ops; nobody
attached → declared default. No delegate signature names a platform type, so only the host adapter is
per-platform (iOS `UIApplication`, Android `Intent`) and it's the only file that imports them.
## The dom module — the only WebKit-aware thing
Everything that knows `WKWebView` lives here: the page bridge, injection, navigation interception, context
projection. Reached as `dsx.module.dom`. Its generic dispatcher names no module — a page call arrives as a
detail dict and folds through the same proxy native modules use, then injects the result back keyed by rid:
```swift
let proxy = path.reduce(dsx.module[scheme]) { node, seg in node[seg] }   // array path → subscript reduction
let result = try await proxy(args)
injectResult(rid: rid, data: result)
```
`dsx.module.dom.inject(...)` is the lone legacy JS-injection path. Redirect interception is a
`WKNavigationDelegate` concern that stays here and re-fires as the named host delegate `dsx.delegate.web.decidePolicy`.
## Unified global state
Global state is native primitives in one store; native is source of truth. DSXView binds reactively; the dom
module projects snapshots into the page. No "patch into the page" API — only projection of native primitives
the page consumes. `dsx.global.set("user.name", "Ada")` ⇄ `{{ global.user.name }}` (DSXView) ⇄
`window.dsx.global.subscribe(...)` (web).
## Migration (behaviour-identical per phase)
- **00** — rename `package → module`; establish the JSON envelope as the call contract (dynamic/subscript/named-arg sugar lowers to it). Additive.
- **1** — stand up `dsx` core + host adapter; route the page bridge through the bus; host delegates fire through `dsx.delegate`. The web view attaches rather than owns.
- **2** — register the web view as the `dom` module; move injection + navigation interception into it; delete any top-level inject.
- **3** — introduce DSXView as a second surface (calls modules, attaches delegates) — same modules, no new provider code.
- **4** — unify context into the native store; DSXView binds, dom projects; audit every native module for web-view reach-ins and remove them.
**Exit test per phase:** call any action from both a page and a DSXView. If the handler is unchanged and
neither caller needed a special case, the layer is correct.
