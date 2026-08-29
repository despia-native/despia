# Module context: `dsx.module.<scheme>.context.*`

> Audience: module authors. How a module **publishes typed, declared variables** that other
> modules read — the structured replacement for stringly-typed `dsx.values("a.b")` coordination.

A module often has a value another module needs: Meta knows whether Facebook ads are on; AppTracking
knows whether ATT was denied; OneSignal knows whether a tapped push should open in the browser. **Module
context** is how a module *declares* such a value once, in its `dsx.json`, so any other module can read it
**by name, typed, and safely** — even when the owning module was compiled out of the build.

It is the **data** complement to the three cross-module **call** shapes
([cross-module-calls.md](cross-module-calls.md)): those are how you make a module *do* something; this
is how you read a value it *exposes*.

---

## At a glance

```jsonc
// OWNER — declare in dsx.json (the module's public "context" interface)
"context": {
  "facebookAds":   "{{ config.use_facebook_ads }}",           // STATIC: mirrors one of my config values
  "adsSuppressed": { "type": "boolean", "default": false }    // LIVE:   a runtime value I publish
}
```

```swift
// READ — any module, typed dot-access (like dsx.config), exclusion-safe
dsx.module.metaads.context.facebookAds.bool
dsx.module.x.context.session.credits.int            // nested: drill with dots

// PUBLISH — the OWNER updates a live var (string-keyed verb, like dsx.global.set)
dsx.context.set("adsSuppressed", true)

// SUBSCRIBE — fire now + on every change (string-keyed verb, like dsx.shared.on)
let sub = dsx.module.x.context.on("adsSuppressed") { v in render(v.bool) }
// keep `sub` to stay subscribed; drop it to stop
```

Mnemonic: **reads like `dsx.config`** (typed dot), **writes/subscribes like `dsx.global`** (string verbs).

---

## When to use it (and when not)

| You want to… | Use |
|---|---|
| read a value **another module declares/owns** (a flag, a list, an id) | **module context** (`dsx.module.x.context.*`) |
| make a **named** module *do* something | `dsx.module.x.<action>()` — [cross-module-calls.md](cross-module-calls.md) |
| announce an **event**, 0..N may care | `dsx.fire` ⇄ `dsx.hook` |
| app-wide shared store (auth, theme, route), untyped, web-visible | `dsx.global` — [global-state.md](global-state.md) |
| **private** runtime coordination inside your own module | `dsx.values` (non-reactive scratchpad) |
| your module's **own static config** | `dsx.config` / `self.config.<key>` |

Rule of thumb: **a value one module owns and another reads → module context.** If only your own module
reads it, it's `self.config` (static) or `dsx.values` (private runtime) — don't expose it.

---

## Declare — the `context` block in `dsx.json`

Each entry is a variable the module **provides**. Two kinds:

```jsonc
"context": {
  // STATIC — mirrors one of THIS module's own config.json values. No code: the kernel reads your
  // config when someone reads the var. The {{ config.<key> }} form is the SAME reference syntax used
  // for infoPlist/entitlements placeholders and {{ dsx.* }} config templates — one unified rule.
  "facebookAds": "{{ config.use_facebook_ads }}",

  // LIVE — a runtime value you publish with dsx.context.set(...). `default` is what readers get until
  // you set it (and whenever your module is excluded). `type` is documentation; the runtime is Any.
  "adsSuppressed": { "type": "boolean", "default": false }
}
```

- The reference rule: **a string value is `{{ config.<key> }}`** (a typed mirror of that config key);
  **an object value is a live var** (`{ type, default }`). This is the one `{{ }}`-reference convention
  the rest of `dsx.json` already uses (placeholders, config templates) — not a second bespoke syntax. It's
  the canonical schema rule: see *`{{ … }}` value references* in [manifest-dsl.md](manifest-dsl.md).
- Var names must be valid identifiers (so `dsx.module.x.context.<var>` dot-access works).
- `{{ config.<key> }}` must name a real key in this module's `config.json`.
- `_note` is allowed (ignored by codegen) for human context, like elsewhere in `dsx.json`.

`prepare_modules.rb` reads the block and emits it into `GeneratedStateRegistry` (see *How it works*).

---

## Read — typed dot-access

```swift
dsx.module.metaads.context.facebookAds.bool          // Bool
dsx.module.appsflyer.context.onelinkDomains.strings  // [String]
dsx.module.x.context.title.string                    // String (device-locale resolved, like config)
```

Leaf accessors mirror `dsx.config`: `.bool` `.int` `.double` `.string` `.list` `.strings` `.exists`,
plus `.raw` (the untyped escape hatch). **Reads are defaulted, not optional** — an absent value reads as
the declared default (`false` / `""` / `[]`), because state vars are *declared with defaults* (this is the
deliberate difference from `dsx.global`, whose "absent is normal" bag returns optionals).

Reads use the owner's **primary identity — its derived dotted chain** (`<scheme>`
throughout this doc means the chain; segments are `[a-z][a-z0-9_]*`, the identity gate, and
a nested module's chain derives from `Modules/` nesting — facet-contracts.md, *Derived
identity*), so the dot form always works, nested chains included:

```swift
dsx.module.apptracking.context.adsSuppressed.bool   // depth-1 chain
dsx.module.watch.health.context.<var>.bool          // a nested owner — the chain nests too
```

The owner reads its own state as `dsx.context.<var>` (bound to its primary chain, like `dsx.config` —
never hand-write your own chain; the binding comes from `resolvedScheme`).

---

## Publish — `dsx.context.set(...)` (owner only)

A **live** var is updated by its owner. String-keyed, exactly like `dsx.global.set` / `dsx.values.set`:

```swift
dsx.context.set("adsSuppressed", true)        // the setState of the cross-module store
dsx.context.set("session.credits", 200)       // nested via a dot-path key
```

The write lands in the reactive `DSX.state` at `"<scheme>.<var>"`, so every reader (and the web layer's
`window.dsx.global.<scheme>.<var>` — legacy pages read `window.despia.global.<scheme>.<var>`) sees it. Off-main writes (ad/purchase/ATT completions) are
re-dispatched to the main thread for you. Writing a **static** (config-mirror) var is inert and warns in
DEBUG — statics resolve from config, not the live store.

---

## Subscribe — `dsx.module.x.context.on(...)`

```swift
let sub = dsx.module.apptracking.context.on("adsSuppressed") { v in
    if v.bool { hideAds() }
}
```

`on` fires **now** with the current value (like `useEffect`'s first run), then on every change, deduped
(an unrelated key changing won't re-fire). It returns an `AnyCancellable` — keep it alive to stay
subscribed, drop it to stop. A static var fires once (it never changes).

---

## Static vs live — the two backings

| | STATIC | LIVE |
|---|---|---|
| declared as | `"{{ config.<key> }}"` | `{ "type":…, "default":… }` |
| value comes from | the owner's `config.json` (`GeneratedConfigRaw`) | the reactive `DSX.state` at `"<scheme>.<var>"` |
| who sets it | nobody — it *is* the config value | the owner, via `dsx.context.set(...)` |
| changes at runtime | no (config is fixed) | yes |
| `on` behaviour | fires once | re-fires on every publish |
| web-visible | no (config is native) | yes, as `window.dsx.global.<scheme>.<var>` |

Pick static to **re-expose a config value** across the module boundary; pick live for a value your code
**computes/flips at runtime**.

---

## Nested values

Both backings nest by dot. Declare the **top-level** var; address sub-paths freely:

```jsonc
"context": { "session": { "type": "object", "default": {} } }   // live, structured
```
```swift
dsx.context.set("session.credits", 200)             // write a nested path
dsx.module.x.context.session.credits.int           // read it back by drilling
dsx.module.x.context.on("session") { v in … }      // subscribe to the subtree
```

Live vars nest naturally (they live nested in `DSX.state`); static vars are leaves (config mirrors are
scalars), so drilling past a static var reads empty.

---

## The mental model — `config` · `context` · `global`

Module context slots between the two stores you already know:

| | `dsx.config` | **`dsx.module.x.context`** | `dsx.global` |
|---|---|---|---|
| scope | one module, **private** | one module, **published** | the whole app |
| typed? | yes (declared) | yes (declared) | loosely (untyped bag) |
| mutable? | no (read-only) | live vars yes | yes |
| absent reads as | the default | the **declared default** | `nil` (optional) |
| read shape | `dsx.config.x.bool` | `dsx.module.x.context.y.bool` | `dsx.global.x.y.bool` |
| write shape | — | `dsx.context.set("y", v)` | `dsx.global.set("x.y", v)` |

So: **context is `config`'s cross-module, can-be-live sibling.** Its live values physically live *in*
`dsx.global` under the module's namespace — `context` is just the typed, declared, exclusion-safe face on
that slice.

---

## Exclusion-safety — the headline win

A reader **never names the owning module's Swift symbols** — `dsx.module.metaads.context.facebookAds` is a
pure string-keyed lookup. So:

- The reader **compiles** whether or not the owner is in the build.
- If the owner is **excluded** (or absent), it has no `GeneratedStateRegistry` entry, so the read returns
  the **declared default** — fail-open, never a crash.

This is exactly why the old code copied config into `dsx.values` by hand: an excludable module's
`SomeConfig()` type may not exist, so a foreign reader couldn't touch it. Module context formalises that
decoupling — declared, typed, and safe.

```text
Meta excluded   ⇒ dsx.module.metaads.context.facebookAds.bool      == false  (AdMob takes its own branch)
ATT excluded    ⇒ dsx.module.apptracking.context.adsSuppressed.bool == false  (ads per config)
```

---

## Reserved names

The leaf members (`bool`, `string`, `int`, `double`, `list`, `strings`, `exists`, `raw`, `set`, `on`)
shadow same-named drill keys. To read a var literally named one of these, use the string subscript:

```swift
dsx.module.x.context["set"].bool        // a var named "set"
```

(Same rule as a `dsx.global` key named `get`/`set` — reach it via `dsx.global["get"]`.)

---

## Worked examples (the real retrofits)

**Static, single reader** — OneSignal → PushRouting:
```jsonc
// OneSignal/dsx.json
"context": { "openDeeplinkInBrowser": "{{ config.open_deeplink_in_browser }}" }
```
```swift
// PushRouting (Mandatory) decides a tapped-notification deeplink without reading OneSignal's config:
if dsx.module.onesignal.context.openDeeplinkInBrowser.bool { openInBrowser(url) } else { loadInApp(url) }
```

**Static, fan-in** — Meta → AdMob:
```jsonc
// MetaAudienceNetwork/dsx.json
"context": { "facebookAds": "{{ config.use_facebook_ads }}" }
```
```swift
// AdMob picks the FB path for its after-X-taps ad — false (its own branch) when Meta is excluded:
private var facebookAdsOn: Bool { dsx.module.metaads.context.facebookAds.bool && !attSuppressed }
```

**Live, published on an event** — AppTracking → AdMob + Meta:
```jsonc
// AppTracking/dsx.json   (scheme "apptracking")
"context": { "adsSuppressed": { "type": "boolean", "default": false } }
```
```swift
// AppTracking publishes on ATT denial (off-main completion — re-dispatched for us):
let context = dsx.context
ATTrackingManager.requestTrackingAuthorization { status in
    guard status != .authorized, denyHidesAds else { return }
    context.set("adsSuppressed", true)
}
// AdMob / Meta AND-NOT it:
private var attSuppressed: Bool { dsx.module.apptracking.context.adsSuppressed.bool }
```

---

## How it works (under the hood)

1. **Manifest** — `prepare_modules.rb` whitelists `context` as a `dsx.json` key.
2. **Codegen** — `prepare_config.rb` walks each module's `context` block (skipping excluded modules) and
   emits `GeneratedStateRegistry.byScheme[scheme][var]` (keyed by the module's chain) into
   `ModuleSchemes.generated.swift`, next to `GeneratedConfigRaw`. Each var is `{ "source": "<configKey>" }` (static) or `{ "default": <v> }` (live).
   The registry is always emitted (empty if no module declares context), so the kernel always compiles.
3. **Kernel** — `DSXStateProxy` (a `@dynamicMemberLookup` value, `OpenSource/Engine/iOS/DSXState.swift`)
   accumulates the dot-path, then resolves: a static var reads `GeneratedConfigRaw`; a live var reads the
   reactive `DSX.state`, falling back to the declared default. Leaf reads delegate to `DSXConfigValue`, so
   typing and locale resolution can never drift from `dsx.config`. `dsx.context` (owner) and
   `dsx.module.<scheme>.context` (consumer) both vend it.

No new central layer, no new bridge: static reuses the config seam, live reuses the global store.

---

## Gotchas

- **Read by the owner's PRIMARY chain**, not an alias. Chain segments are always valid
  identifiers (the identity gate bans hyphens), so the dot form always works — nested chains
  included; aliases are the legacy plane's head-position routing and never front context reads.
- **Statics are read-only.** `dsx.context.set` on a config-mirror var is inert (warns in DEBUG). Declare it
  live if you need to publish at runtime.
- **Don't expose private state.** Only declare values another module actually reads; keep the rest in
  `self.config` / `dsx.values`.
- **Live values are app-global underneath.** They share the `DSX.state` namespace (`<scheme>.<var>`), so
  the web sees them via `window.dsx.global` (and the legacy `window.despia.global` alias) — pick var names you're happy to expose there too.
- **Absent = default, not nil.** Unlike `dsx.global`, reads never return optional — design defaults that
  fail open (the value a reader should assume when your module isn't there).

See also: [cross-module-calls.md](cross-module-calls.md) (the call shapes), [global-state.md](global-state.md)
(the app-wide store), [runtime-api.md](runtime-api.md) (the full `dsx.*` surface), [writing-a-module.md](writing-a-module.md).
