# Cross-module calls

How one module depends on another at runtime without `import`-ing its class
or knowing whether the other module was built into this binary at all. The
shape is a typed-feeling dot chain:

```swift
try? dsx.module.appsflyer.set_user_id(["customer_user_id": userId])   // fire-and-forget
let result = try await dsx.module.appsflyer.get_uid()                  // awaitable
if dsx.has("appsflyer") { … }
```

This is the surface for **calling a named module** (point-to-point). Two sibling shapes
cover the rest of cross-module interaction — events and decisions — see *Three shapes*
next. Skim the [runtime API](runtime-api.md) first; this doc deep-dives `dsx.module`.

> **Module identity is a derived dotted CHAIN.** `<scheme>` in this doc means the module's
> **chain**: a manifest declares only its LOCAL segment (`"scheme": "health"`), and nesting
> under a parent's `Modules/` derives the rest (`watch.health`), so a nested module is
> called as `try await dsx.module.watch.health.heartRate(["on": true])`. Resolution is a
> longest-known-prefix **fold** at each runtime's one dispatch funnel — never dot-counting.
> Law + grammar: `Documentation/architecture/facet-contracts.md`, *Derived identity*;
> corpus: `OpenSource/Conformance/chains/`.

> **⚠️ Build gotcha — these calls THROW; `_ =` is not enough.** Every
> `dsx.module.<scheme>.<action>(…)` invocation can throw `ModuleCallError`, so it **must** be
> `try?` / `try` / `try await` — **even fire-and-forget**. Discarding the result with
> `_ = dsx.module.x.y()` does **not** satisfy the compiler — it's a hard error,
> `call can throw, but it is not marked with 'try'`. Write **`try? dsx.module.x.y()`**. Swift doesn't
> compile in the authoring env, so a missing `try` surfaces only at the **Codemagic** build — which is
> why `check_module_rules.rb` flags it as a local + CI gate (Rule 9). The non-throwing exceptions are
> the **reserved members** (Rule 9 allowlists them): the handle accessor
> `dsx.module.<scheme>.object("view"|"scrollView"|…)`, the build facts `.available`/`.excluded`, the
> event subscription `.on("kind") { … }`, and `.context.<var>` reads / `.context.on(…)` subscriptions
> (which aren't calls). This bit us once: `_ = dsx.module.route.pop()` red-built the whole app (PR #828).

## Three shapes — pick the right primitive

Cross-module interaction has **three** shapes. Reaching for the wrong one — almost always
`fire` when you meant a point-to-point call — is the classic mistake this section prevents:

| You want to… | Primitive | Shape |
|---|---|---|
| call a **specific** module you can name | **`dsx.module.<scheme>.<action>(args)`** (this doc) | point-to-point → a result |
| announce an **event**; 0..N unknown modules may care | `dsx.fire("name", payload)` ⇄ `dsx.hook("name")` | broadcast / 1-to-N → nothing |
| ask "**who owns** this role?"; first answer wins | `dsx.claim("name", payload)` ⇄ `dsx.hook("name")` | decision / 1-to-first |

**Litmus test — can you name the callee?**
- **Yes →** `dsx.module.<scheme>.<action>()`. You want *that* module to do *that* thing
  (show the spinner, set a user id, charge a card). A fan-out to several known providers is
  **N explicit `dsx.module` lines, not one `fire`**.
- **No — "something happened, anyone may care" →** `dsx.fire`. Lifecycle (`domStart` /
  `enterBackground` / `launch`) and genuine broadcasts (`appearanceChanged`,
  `liveactivity.started`). The firer neither knows nor cares who listens; 0..N may.
- **No — I need the one module that owns a role →** `dsx.claim` (`web.startURL`,
  `web.decidePolicy`): the relay asks; the first non-nil answer wins.

> **`fire` is never a disguised point-to-point call.** `fire("spinnerShow")` to show the
> Spinner is the anti-pattern — you can name it: `try? dsx.module.spinner.show()`. `fire` is
> for events with an open-ended audience, never "make module X do Y". And a module always
> uses `dsx.fire`, never `ModuleRegistry.shared.fire` — that's the kernel/relay layer (see
> the constitution's Article 3 rule).

> **Reading a value ≠ calling.** The three shapes above are how you make a module *act*. To **read a
> value another module declares** (a flag, an id, a list) — without calling it — that's **module
> state**: `dsx.module.<scheme>.context.<var>`, declared in the owner's `dsx.json`, typed and exclusion-safe.
> It's the structured replacement for the old `dsx.values("a.b")` magic strings. See
> [module-state.md](module-state.md).

> **Reaching the web view is just a cross-module call.** `dsx.*` carries no web-view verb — the web
> surface is owned by the **Dom module**, so a module that must touch the page names it like any other
> callee: `try? dsx.module.dom.inject(["script": …])`, `dsx.module.dom.eval(["js": …])`,
> `dom.call`/`dom.set`/`dom.css`/`dom.load`/`dom.reload`, or `dom.object("view"|"scrollView"|"userAgent")`
> for a `UIView`/`UIScrollView`/`String` handle. A module never holds a `WKWebView` (constitution
> Article 9). The web view (`<DSXWebView/>`) and native UI (`<DSXView/>`) are equal **consumers** of the bus.

## One call, three roots

The same `scheme.method(args)` call exists on every surface — only the chain
root changes with where you're standing:

| You're in | Awaitable | Fire-and-forget | `self`? |
|---|---|---|---|
| **Web JS (DSXWebView page)** | `await dsx.module.verticalplayer.start({…}, onEvent?)` | `dsx.module.verticalplayer.close()` | — (the page isn't a module). `window.despia` is the LEGACY alias of the same engine |
| **DSX markup (JSE)** | `await dsx.module.verticalplayer.start({…})` → `{ ok, data \| error }` | `dsx.module.self.refresh({})` | ✓ `self` = the **owning** module (portable components never hard-code their own scheme) |
| **Native Swift** | `try await dsx.module.verticalplayer.start([…])` | `try? dsx.module.verticalplayer.skip(["by": 5])` | — you **are** the module: call your own funcs directly (and Swift's postfix `.self` keyword makes it unspellable anyway) |

`await` vs no-`await` picks the form on **every** surface — including native, where
`dsx.module`'s leaf has a sync/async `callAsFunction` pair, so `try await` returns the
result and a bare `try?` is fire-and-forget. There's no bare `verticalplayer.start()`:
the root (`dsx.module.` — on every surface; the page's legacy alias `window.despia.` still routes) is what finds the registry.

> **Never reach another module by a `scheme://` string in native Swift.** A literal
> `"spinneron://"` (or `ModuleRegistry.shared.fire(...)`) from inside a module is the
> JS/web/legacy transport, not the native call — use `dsx.module.<scheme>.<action>(…)`.
> This is also why a module must expose real `scheme.action`s and not a "scheme-only"
> scheme: a scheme with no action can't be named in the dot chain. E.g. the Spinner
> exposes `spinner.show` / `spinner.hide`, so a module shows it with
> `try? dsx.module.spinner.show()` — not `fire("spinnerShow")`, not `spinneron://`.

## Why this exists

A module is meant to be a folder you can drop or add without editing host
code. The minute one module needs to talk to another, three traps appear:

1. **Direct import** ties the two modules' lifecycles together. If
   `ClerkBridge` says `import AppsFlyerLib` and calls
   `AppsFlyerLib.shared().customerUserID = id`, then removing AppsFlyer
   breaks Clerk. Now the dependency is a hard link instead of a soft one.
2. **NotificationCenter** decouples the lifecycles but moves the contract
   off the type system: every channel needs a `Notification.Name`, a
   userInfo dict shape, a sender, an observer, a teardown. Six rows of
   boilerplate for a one-line call.
3. **Host glue** (a `WebViewController` switch that forwards Clerk's
   sign-in to the right tracker module) mentions every module by name,
   defeats the point of a registry, and grows linearly with the number of
   trackers.

`dsx.module` collapses all three into the same registry the JS bridge already
uses. A module calls another module by its scheme name; the registry routes;
the absence of the target is a typed error the caller can pattern-match on (or
silently swallow with `try?`).

## The primitives

| Primitive | Returns | Throws | Use for |
|---|---|---|---|
| `dsx.has("scheme")` | `Bool` | never | Branch before dispatching - "is the module loaded?" |
| `try? dsx.module.<scheme>.<action>(args)` | nothing | `ModuleCallError` | Fire and forget (no `await`). Result discarded. |
| `try await dsx.module.<scheme>.<action>(args)` | `JSON` | `ModuleCallError` | Awaitable (`await`). Returns the handler's `dsx.resolve(...)` payload. |

`dsx.module` is the native twin of DSX's `dsx.module` — `await` selects the result form,
a bare call is fire-and-forget (the leaf has a sync/async `callAsFunction` pair). They're
all properties / methods on `dsx`: there is no static / global entry point - if you need
to reach a module, you're already inside another module's handler, so you have a `dsx`.

## The chain

The chain reads top-down as **kind . scheme . action ( args )**. Each
identifier maps to the URI shape the target registered with:

```swift
// In AppsFlyerBridge.swift:
dsx.action("set_user_id") { dsx in … }      // registers appsflyer://set_user_id

// In ClerkBridge.swift:
try? dsx.module.appsflyer.set_user_id(["customer_user_id": id])
//            ^^^^^^^^^^   ^^^^^^^^^^^
//             scheme       action  -> same as dsx.action("set_user_id") above
```

With a **nested module** the scheme slot is the derived chain — `dsx.module.watch.health.heartRate(["on": true])`
— and with action **groups** the action slot is a path (`dsx.module.store.products.subscriptions.buy(args)`).
The dispatch funnel tells the two apart with the **fold**: it extends the chain while a deeper known identity
exists (registered ∪ build-excluded), and the remainder is the action path — `intelligence.rag.add` can only
ever mean the `rag` action GROUP, because the build-time ban forbids a child segment that equals a parent
action (facet-contracts.md, *Derived identity*). The generated typed accessors nest the same way:
`dsx.module.watch.health.heartRate` is a real compile-checked member chain on Swift and Kotlin.

> **Action names are case-INSENSITIVE** (like schemes — RFC 3986 URL semantics). Every dispatch
> path lowercases the action segment before lookup, and registration stores the key lowercased to
> match. So `dsx.action("pushComponent")`, `dsx.module.route.pushComponent(…)` and
> `route://pushcomponent` all meet at the same handler — camelCase is fine to *write*, but never
> register two actions differing only in case (last registration wins).

Each chain step is a tiny stateless wrapper - `ModuleProxy`,
`ModuleScheme`, `ModuleAction` (`DispatchProxy`/`CallProxy` for the legacy
roots). The leaf struct is callable via Swift's `callAsFunction` — a sync
`throws` overload and an `async throws` one — so `(args)` runs the dispatch
and `await (args)` runs the awaitable call.

`args` is an optional `[String: Any]?` - omit for an empty payload:

```swift
try? dsx.module.onesignal.logout()                // no args
try? dsx.module.onesignal.login(["user_id": id])  // one key
```

The native dictionary you pass arrives at the receiver verbatim via
`dsx.args("key")` - same as a JS-driven call.

### Subscript fallback

Identifier syntax breaks on dynamic strings and on legacy alias spellings
(hyphenated wire tokens like `get-uuid` — a modern segment never contains
one). For those, every chain step accepts a plain string subscript - and you
can mix freely with dot access:

```swift
try? dsx.module["appsflyer"]["set_user_id"](args)   // both steps dynamic
try? dsx.module.appsflyer["get-attribution"]()      // mix: dot, then subscript
try? dsx.module[someSchemeName].set_user_id(args)   // scheme from a variable
```

The subscript form is also what Kotlin / Java port to (no
`@dynamicMemberLookup` there), so a call written with subscripts reads
identically across all three platforms - see
[Cross-platform](#cross-platform) below.

> **Aliases are legacy-plane routing — never new code.** An `aliases` entry
> (`watchhealth`, `get-uuid`, `state`) keeps a SHIPPED spelling routing to the
> primary chain — consulted at head position only, legacy grammar (hyphens)
> allowed. New native / markup / page code always names the primary chain
> (`dsx.module.watch.health.…`, `dsx.module.uuid…`, `dsx.module.global…`);
> never mint an alias for a new capability.

## Calling another module (consumer side)

Three idioms cover almost every consumer use case.

### Optional dependency: silent no-op when absent

The most common shape. The dependency is a nice-to-have decoration; if the
target module was excluded from this build, the call should just not
happen. `try?` swallows the `ModuleCallError.notLoaded`.

```swift
private func syncAttribution(_ userId: String?) {
    if let userId {
        try? dsx.module.onesignal.login(["user_id": userId])
        try? dsx.module.appsflyer.set_user_id(["customer_user_id": userId])
    } else {
        try? dsx.module.onesignal.logout()
        try? dsx.module.appsflyer.logout()
    }
}
```

Excluding OneSignal in `DSX/Modules/Config/excluded.json` turns the first call
into a silent skip - no `#if`, no `Constants` check, no recompile dance.

### Required dependency: let it throw

If the call has to succeed, drop `try?` and let the throw propagate. Either
the host wraps the failure into an error path, or a missing module becomes
a loud crash at boot (which is correct - the consumer was misconfigured).

```swift
do {
    try dsx.module.analytics.track(["event": "checkout_started", "amount": amount])
} catch {
    // logger / Crashlytics / etc.
}
```

### Awaitable result with typed recovery

With `await`, the SAME `dsx.module` chain suspends and returns the handler's
`dsx.resolve(...)` payload as a `JSON`, converting `dsx.error` into a typed Swift
throw the caller can switch on.

```swift
do {
    let result = try await dsx.module.appsflyer.get_uid()
    let uid = (result.foundationValue as? [String: Any])?["uid"] as? String
    save(uid)
} catch ModuleCallError.notLoaded {
    // AppsFlyer not in this build; carry on without an AppsFlyer UID.
} catch ModuleCallError.actionFailed(let code, let data) {
    logger.warning("AppsFlyer get_uid failed: \(code) \(String(describing: data))")
}
```

A handler that calls `dsx.resolve(JSON(["uid": "abc123"]))` lands as
`.object(["uid": .string("abc123")])`; reach the value through
`.foundationValue` or a switch on the JSON case.

### Branching on presence

`dsx.has("scheme")` is the cheap synchronous check. Use it when the next
action depends on whether the module is available, not on what it returns:

```swift
if dsx.has("appsflyer") {
    // We have an attribution provider; defer the segment write until after
    // the install attribution callback runs.
    return
}
// No attribution provider; proceed immediately.
proceed()
```

Don't reach for `has` before every `dsx.module` call; the throw is
already what you need - `has` exists for control flow, not for guarding
calls. The dot-face sibling is `dsx.module.<chain>.available` (see next
section) — same pre-flight, spelled on the chain.

## The reserved members — the frozen nine

`dsx.module.<chain>` is a proxy whose REAL members shadow dynamic lookup, so nine
names are reserved — CLOSED and FROZEN: `on · available · excluded · state ·
context · object · delegate · dsx · then`. A reserved word can be **neither a
chain segment nor an action name** (build-enforced, `DSXGraph.chain_errors` —
the ban is what keeps the dot chain unambiguous; facet-contracts.md, *Derived
identity*). What they do:

- **`.on("kind") { payload in … }`** — subscribe to the module's OWN events: the
  owner's scoped emission rides the bus as `<chain>.<kind>`, so this is exact
  sugar over `dsx.hook("<chain>.<kind>")`. Non-throwing. An ALIAS handle hears
  the same events no matter when it subscribed: the subscription alias-normalizes
  when the table already knows the spelling, and the EMISSION side fans out to
  every alias spelling regardless (`fire`/`broadcast` — so boot order never
  decides whether a hook hears, and a shipped page's `despia.on("<alias>")`
  keeps hearing the module it always heard).
- **`.available`** — `Bool`: registered in THIS build and not under the excluded
  overlay. The generic pre-flight for optional modules; a never-existed name
  answers `false` here AND `false` at `.excluded` (the honest split).
- **`.excluded`** — the honest build fact: `false` when shipped (or when the
  name never existed), else the `DespiaExcluded` entry
  (`{ reason: "excluded" | "cascade", from? }`) — the 1:1 twin of the page's
  `despia.excluded`.
- **`.context.<var>`** — the module's declared variables, typed and
  exclusion-safe ([module-state.md](module-state.md)); `.state` routes to the
  same plane.
- **`.object("…")` / `.delegate.<event>` / `.dsx`** — the exported-handle
  accessor, the module's delegate points, and the bus escape hatch; **`then`**
  is held inert so `await` / JSON can never half-call a proxy.

A reserved word that nevertheless reaches a MODERN call face (unspellable
through the typed proxies — so a bracket-subscript or dotted-callee caller bug)
is refused with the cross-runtime error code `reserved_member`. The LEGACY WIRE
face (v3 URL navigations, `window.despia`) is exempt and routes direct — that
exemption is exactly what keeps the code-only legacy shims under reserved
spellings (`biometric://available`, `bluetooth://state`) answering shipped
pages: reserved words are banned from MANIFESTS, never from the wire.

## Being called by another module (receiver side)

There's nothing to do.

A module is "callable from other modules" the moment it registers a named
action with `dsx.action("name") { dsx in … }`. The same handler that the JS
bridge invokes when web code writes `await dsx.module.scheme.name({…})` (or its
legacy `window.despia.scheme.name({…})` spelling)
is what the internal call invokes too. Same `dsx`, same `dsx.args(...)`,
same `dsx.resolve` / `dsx.error`.

> **Package-private actions — `dsx.action("name", exposed: false) { … }`.** Makes an action
> **internal**: off the web/URL bus (page calls — `dsx.module.<scheme>.<name>` or the legacy `window.despia` spelling — and deep links never reach it),
> callable only by **in-process `dsx.module` calls** — the package's own DSX components
> (`dsx.module.self.<name>`) and native callers. Use it for privileged helpers and plumbing that must
> not be web-callable. The hard boundary it enforces is *"not from the web"*; in-process modules are
> full-trust, so cross-package reach is by convention (like the per-scheme container folders), not a
> kernel wall. Implemented as a separate `internalNamed` table that only the in-process dispatch path
> consults (`includeInternal: true`); the web relay leaves it `false`.

If you author a module and want to make sure it's a good citizen for
cross-module use:

- **Keep action names stable.** They're the public API. Rename = breaking change.
- **Never name an action a reserved member** (`on`, `available`, `excluded`,
  `state`, `context`, `object`, `delegate`, `dsx`, `then`) — it's a build error.
  The shipped collisions were renamed with legacy wire shims kept
  (`watch.state`→`update`, `biometric.available`→`supported`,
  `bluetooth.state`→`status`, …).
- **Validate args at the boundary.** The same `dsx.error("missing_param", …)`
  guard you'd run for JS callers protects internal callers.
- **Document the actions in your `README.md`'s "Cross-module use" section** -
  a one-block example showing the `dsx.module.<scheme>.<action>(args)` call
  is enough. See `DSX/Modules/Core/AppsFlyer/README.md` for the house style.
- **Add a symmetric `logout` / `clear` / `reset` action** if the module has
  a state-setting action. Consumers expect symmetric pairs (AppsFlyer's
  `set_user_id` ↔ `logout`, OneSignal's `login` ↔ `logout`).

If you don't do any of this, your module still works as a receiver -
callers will just have nothing to discover.

## Error model

`ModuleCallError` has three variants:

| Variant | When | Recovery |
|---|---|---|
| `.notLoaded(scheme: String)` | No module owns the resolved chain in this build (excluded, or a typo'd **head** — the fold reports against the arriving head token, never a silent no-op). | `try?` to skip silently, or surface as a missing-config error. |
| `.invalidURI(String)` | The scheme or action couldn't form a valid URL (empty scheme, illegal characters). | Bug in caller - log and fail loudly. |
| `.actionFailed(code: String, data: Any?)` | Target handled the call and rejected via `dsx.error(code, data)` — **or** the module is loaded but doesn't register the named action (`code == "unknown_action"`, `data == { action }` — the typo'd-**action** class, same shape on all three renderers). | Pattern-match `code` to recover; surface `data` if you propagate. |

> `.notLoaded` is honest: it means **"the module is absent"**, never "the module ignored you."
> A wrong action name on a *loaded* module always answers `actionFailed("unknown_action")` —
> whether the module routes by named actions or a prefilter.

The three are pattern-matched the same way:

```swift
do {
    let r = try await dsx.module.stripe.charge(payload)
} catch ModuleCallError.notLoaded {
    // ...
} catch ModuleCallError.invalidURI {
    // ...
} catch ModuleCallError.actionFailed(let code, let data) where code == "card_declined" {
    // ...
} catch ModuleCallError.actionFailed(let code, _) {
    // ...
}
```

`actionFailed.code` mirrors what the target's `dsx.error("code", …)` set, so
the same machine-readable identifiers work for JS callers (`e.code`) and
Swift callers. Pick stable, language-neutral strings; treat them as your
public contract.

## Observability — nothing fails silently

`try?` swallows the **throw**, not the **trace**. Every `dsx.module` call failure — on all
three renderers (Swift `Context`, Kotlin `Context.kt`, web `bus.ts`) — lands in ONE
diagnostics funnel before the caller can swallow it:

- **`kernelLog`** — one line per failure, e.g.
  `[dsx.module] dom.injct → unknown_action — module is loaded — known actions: call, css, eval, inject, …`.
  DEBUG console in dev; captured into the on-device diagnostics drawer's ring buffer on test
  installs (shake → Console), so a tester exports the exact line instead of reporting
  "the button does nothing". `not_loaded` logs quietly too (the expected excluded-module skip,
  made visible); production installs print and capture nothing.
- **`dsx.hook("module.callFailed")`** — the global observer seam for dev tooling / crash
  reporting. Payload: `{ scheme, action, code, data?, delivered }`. `delivered: false` marks a
  fire-and-forget terminal error: the call already returned, so the handler's `dsx.error` /
  `dsx.fail` structurally can't reach the call site — the funnel is the only place it can
  surface (before this, it vanished into a `{ _ in }` no-op). `delivered: true` means the
  caller received the typed throw (it may still have `try?`-swallowed it). A failure that a
  `module.callFailed` hook's own body causes stays log-only — the funnel never feeds a hook
  its own output.

**The error SYSTEM on top of the funnel** (error-system.md, ACCEPTED v1 — P1 landed on all
three renderers): the SAME verbs gain the **ambient hat** — `dsx.error`/`dsx.fail` on the
module handle (no call to settle, e.g. `self.dsx.fail(…)` from a background job) *emits* the
error instead of settling anything: it records a `DSXError` into the kernel **error ledger**
(ring 128, `dsx.errors.recent()`), fires **`dsx.hook("module.error")`** (the semantic sibling
of `module.callFailed`), reaches the page as `{scheme, event: "error"}` on the module's own
scheme **plus the reserved `dsx` mirror** (the page's `dsx.on("dsx", …)` — one global error listener),
and publishes the reactive keys **`global.dsx.lastError` / `global.dsx.errorCount`** for
declarative error UI. Markup actions emit with the same builtin: `dsx.error('code',
{ message, recoverable, data })` — records, never unwinds. Call failures feed the same
ledger (`origin: "call"`, with the `delivered` flag), and an **uncaught markup `throw`**
that unwinds an action to the top reports through the same fan-out as `origin: "uncaught"`
(a thrown dict with a string `code` keeps its fields; anything else records code
`"uncaught"`) — the window.onerror analogue for actions, zero setup. The web PAGE is wired
in too: `runtime.js` forwards `window.onerror` / `unhandledrejection` (burst-guarded) and
gives the page the SAME spelling markup has — `dsx.error(code, {…})` on the injected
`window.dsx` surface (`despia.error` stays as the legacy alias), riding the kernel's
reserved-scheme `error` verb — so a page exception lands in the same ledger, drawer, and
Xcode/logcat line as a native one. All of it corpus-pinned: `OpenSource/Conformance/errors/`.

**Logging rides the same spine** — `dsx.log(…)` (markup builtin + the module handle +
`despia.log` on the page) is `console.log` with a home: house formatting (JSE coercions,
canonical JSON, credential masking), one structured entry in the **log ring**
(`dsx.logs.recent()`, cap 500, `console.*` feeds it too as scheme `"console"`), and one
`[dsx.log] <scheme>: <message>` kernelLog line — the Xcode console / logcat in dev, the
diagnostics drawer's export on test installs. Corpus-pinned: `OpenSource/Conformance/logs/`.

The funnel **observes, never handles** — recovery stays at the call site (`do/catch` on the
typed `ModuleCallError`, exactly as above). Two companions close the loop end-to-end:

- **Dom write verbs log page-side JS errors** (iOS): `call`/`set`/`css`/`proxy`/`inject`
  resolve immediately by design (write semantics), so a JavaScript exception can't reach the
  caller — it kernelLogs as `[dom] call navigator.geolocation.helper.success JS failed: …`
  instead of disappearing (`completionHandler: nil`, the old behavior). Android's
  `evaluateJavascript` cannot observe page exceptions — pinned divergence in `Dom.kt`.
- **The lint gate catches the typo before the device does** — `check_module_rules.rb`
  rule 10 validates every *literal* `dsx.module.<scheme>.<action>(…)` chain (Swift + Kotlin)
  against what the target actually registers (`dsx.action("…")` literals + the manifest
  `actions` map — the same source the typed accessors generate from). `dsx.module.dom.injct(…)`
  fails the build with the registered names listed; a package with a prefilter (catch-all) or
  dynamic registration is exempt from the action check (scheme still validated).

## Patterns

### Fan out a host event to multiple modules

The motivating use case: a Clerk sign-in needs to propagate to every
analytics / attribution / push provider. Without coupling Clerk to any of
them by name? Drop a fan-out into the sync method, one line per provider,
all optional:

```swift
private func syncAttribution(_ userId: String?) {
    if let userId {
        try? dsx.module.onesignal.login(["user_id": userId])
        try? dsx.module.appsflyer.set_user_id(["customer_user_id": userId])
        try? dsx.module.mixpanel.identify(["user_id": userId])
    } else {
        try? dsx.module.onesignal.logout()
        try? dsx.module.appsflyer.logout()
        try? dsx.module.mixpanel.reset()
    }
}
```

Adding a new tracker is one more line in the fan-out plus the tracker's own
module. Removing the module, conversely, requires no edits here - the line
just no-ops.

### Chain async calls into a pipeline

Await `dsx.module`; you get the result; you call again. Standard async composition.

```swift
dsx.action("checkout") { [weak self] dsx in
    Task {
        do {
            let auth = try await self?.dsx.module.auth.token()
            let charge = try await self?.dsx.module.stripe.charge([
                "amount": dsx.args("amount") as? Int ?? 0,
                "token":  auth?.foundationValue
            ])
            dsx.resolve(charge)
        } catch {
            dsx.error("checkout_failed", "\(error)")
        }
    }
}
```

The outer `dsx.resolve` settles the JS-side `await dsx.module.<scheme>.<action>(...)`; the
two `dsx.module` awaits in the middle are pure Swift-side composition.

### Bridge a non-async context with a Task

Delegate callbacks, observers, lifecycle hooks - none of them are
`async`. Wrap the call:

```swift
dsx.hook("becomeActive") { _ in
    Task { try? await dsx.module.analytics.flush() }
    return nil
}
```

Or call without `await` (fire-and-forget) and skip the Task entirely if you don't need the result:

```swift
dsx.hook("becomeActive") { _ in
    try? dsx.module.analytics.flush()
    return nil
}
```

## Cross-platform

The three primitives are designed to port byte-for-byte from Swift to
Kotlin to Java, with one expected per-language difference (the dynamic chain
step).

| Step | Swift | Kotlin | Java |
|---|---|---|---|
| Presence check | `dsx.has("appsflyer")` | `dsx.has("appsflyer")` | `dsx.has("appsflyer")` |
| Fire-and-forget | `try? dsx.module.appsflyer.set_user_id(args)` | `dsx.module["appsflyer"]["set_user_id"](args)` | `dsx.module.get("appsflyer").get("set_user_id").invoke(args)` |
| Awaitable | `try await dsx.module.appsflyer.get_uid()` | `dsx.module["appsflyer"]["get_uid"]()` (suspending) | `dsx.moduleAsync("appsflyer", "get_uid", callback)` |
| Error model | `catch ModuleCallError.notLoaded` | `catch (e: ModuleCallError.NotLoaded)` | `catch (NotLoadedException e)` |

The dot syntax is Swift-only because only Swift has `@dynamicMemberLookup`.
Kotlin and Java reach the same proxy types via `operator fun get` /
`operator fun invoke` (Kotlin) or plain `.get(...).invoke(...)` calls
(Java). Swift also accepts the subscript form, so a Swift call with a
dynamic string reads identically to the Kotlin version:

```swift
dsx.module["appsflyer"]["set_user_id"](args)   // valid Swift; identical to Kotlin
```

When porting a Swift consumer to Kotlin, the only mechanical change is
`.foo.bar` → `["foo"]["bar"]`. Receivers don't change at all -
`dsx.action("set_user_id") { … }` is the same registration on both
platforms.

`ModuleCallError` ports as a Kotlin sealed class with the three variants
(`NotLoaded(scheme)`, `InvalidURI(uri)`, `ActionFailed(code, data)`) and a
Java exception hierarchy with one subclass each.

## Anti-patterns

A list of "this works, but don't" - the call goes through, but a different
tool fits the shape better.

- **Replacing JS chains with Swift chains.** If the goal is "after Stripe
  charges, log to Analytics and update the UI", let the web do it:
  `await dsx.module.stripe.charge(…)` then
  `await dsx.module.analytics.log(…)`. The JS side already has
  promise composition; bridging two `dsx.module` awaits in native is extra
  latency and a worse stack trace.
- **Self-calls.** `dsx.module.<self_scheme>.<action>(…)` works but is
  almost always a sign you should have factored a helper. Internal calls
  pay the registry-routing cost; an internal function does not.
- **Streaming through an awaited call.** `await dsx.module…` settles once, on
  the first `dsx.resolve` or `dsx.error`. A streaming action (which uses
  `dsx.event(...)` repeatedly) can be invoked fire-and-forget for the
  side-effect, but the events go to the web view's `dsx.on(...)` subscribers
  (legacy `window.despia.on` rides the same fan-out) - not back to the calling module. If a module needs to
  observe events from another module, the producer fires `dsx.fire("name", payload)`
  and the consumer registers `dsx.hook("name")` — the kernel event bus, the same one
  lifecycle events use. **Never** a cross-module `NotificationCenter` channel
  (constitution Article 3); or - simplest - lift the consumer logic into JS.
- **Host code calling modules by name.** If
  `WebViewController.swift` or `AppDelegate.swift` wants to call a
  module, the answer is usually "move that host code into a module".
  The host has no `dsx`; the proxies live on `dsx`. Reaching for the
  registry directly defeats the goal of "host code mentions no modules
  by name".
- **`if dsx.has { try dsx.module… }` guard.** Drop the guard - the throw
  already does what you want. `try? dsx.module.x.y(...)` is one line and
  the same behavior; `has` is for branching on what comes next, not for
  guarding calls.

## Compared to NotificationCenter

We migrated four NotificationCenter channels to the chain syntax. The
shape comparison:

```swift
// Before: NotificationCenter (sender + receiver)
//
// In ClerkBridge.swift:
NotificationCenter.default.post(
    name: .appsFlyerLogin,
    object: nil,
    userInfo: ["user_id": userId])
//
// In AppsFlyerBridge.swift:
NotificationCenter.default.addObserver(
    self,
    selector: #selector(handleLogin(_:)),
    name: .appsFlyerLogin,
    object: nil)
@objc private func handleLogin(_ note: Notification) {
    guard let userId = note.userInfo?["user_id"] as? String else { return }
    AppsFlyerLib.shared().customerUserID = userId
}
//
// In WebViewController.swift:
extension Notification.Name {
    static let appsFlyerLogin = Notification.Name("AppsFlyerLogin")
}

// After: dsx.module (sender only; receiver was already there)
//
// In ClerkBridge.swift:
try? dsx.module.appsflyer.set_user_id(["customer_user_id": userId])
//
// (No changes in AppsFlyerBridge.swift or WebViewController.swift -
//  the existing appsflyer://set_user_id action already handles JS callers
//  the same way.)
```

The chain pulls the contract back onto the type system:

- The name (`appsflyer.set_user_id`) is one identifier, not two
  (`Notification.Name` + userInfo key).
- The payload is the same `[String: Any]` the JS bridge sends, not a
  bespoke userInfo dict.
- The receiver isn't a `@selector` with a `Notification` arg; it's the
  existing action handler that JS already calls.
- A missing receiver is a typed throw at the call site, not a silent
  no-observer drop.

For cross-module **events** (not point-to-point calls), use the kernel bus —
`dsx.fire("name")` ⇄ `dsx.hook("name")` — **never** a `NotificationCenter` channel between
two modules (constitution Article 3). NotificationCenter is only for non-module transports:
an OS / UIKit notification, or a module talking to its **own** SDK / app shell (e.g.
OneSignal's internal `.oneSignalReloadWeb`).

## Quick reference

```swift
// Presence
dsx.has("appsflyer")                                  -> Bool

// Fire-and-forget (no await; handler may still complete async)
try  dsx.module.<scheme>.<action>(args)              -> Void   (throws ModuleCallError)
try? dsx.module.<scheme>.<action>(args)              -> Void   // silent no-op on .notLoaded
try  dsx.module[scheme][action](args)                -> Void   // subscript form

// Awaitable (returns the handler's resolve payload)
try await dsx.module.<scheme>.<action>(args)         -> JSON   (throws ModuleCallError)
try await dsx.module[scheme][action](args)           -> JSON   // subscript form

// Reserved members (non-throwing; never chain segments, never actions)
dsx.module.<chain>.available                         -> Bool   // in this build, not excluded
dsx.module.<chain>.excluded                          -> JSON   // false | { reason, from? }
dsx.module.<chain>.on("kind") { payload in … }                 // the module's own events (<chain>.<kind>)

// Error variants
ModuleCallError.notLoaded(scheme: String)
ModuleCallError.invalidURI(String)
ModuleCallError.actionFailed(code: String, data: Any?)
```

See [runtime-api.md](runtime-api.md) for the full `dsx` surface this lives
on, and [writing-a-module.md](writing-a-module.md) for the module-author
recipe. Concrete consumer / receiver examples live in
[`ClosedSource/DSX/Modules/Core/Clerk/ClerkBridge.swift`](../../ClosedSource/DSX/Modules/Core/Clerk/ClerkBridge.swift),
[`ClosedSource/DSX/Modules/Core/AppsFlyer/README.md`](../../ClosedSource/DSX/Modules/Core/AppsFlyer/README.md), and
[`ClosedSource/DSX/Modules/Core/OneSignal/README.md`](../../ClosedSource/DSX/Modules/Core/OneSignal/README.md).
