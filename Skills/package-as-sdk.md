# Authoring a package as an SDK — DSX best practices

> Companion to [`writing-a-module.md`](writing-a-module.md): that's *how to make a module*; this is *how to
> make a good one* — an SDK others build on. **Only existing primitives** — `dsx.action` + `dsx.resolve`
> (commands), `dsx.broadcast`/`dsx.event` (events), `dsx.variable.*` (a surface's state),
> `dsx.context` / `dsx.delegate` (a package's own context) / `dsx.module.<scheme>.{context,delegate}` (read a named package), `dsx.claim` / `dsx.hook` (policy), components (UI). No new
> framework: the bus already does this.

## Mental model — a package is a store, not a component

A **component** is a reactive *view*: its state IS the truth, so it's assignable (`dsx.variable.x = y`).

A **package** is a **store** (Flux / Redux / actor). It owns its data in native code, takes **commands**,
emits **events** — and if it renders UI, it drives that UI's own surface. Nothing reaches inside it.

```
  owns its data    →  native vars (private)
  drives its UI    →  dsx.variable.x on the surface it mounts   (its components bind / assign)
  command (in)     →  dsx.action(…) → dsx.resolve(…)            the only way to change anything
  event   (out)    →  dsx.broadcast(…)                          consumers subscribe (despia.on / dsx.hook)
```

That's the whole contract — a modern unidirectional store. You change it only by calling a command; you
observe via the command's resolved promise or a broadcast event.

**Two state layers, named for their owner:** `dsx.variable.x` is a **surface's** state (a view's own data);
`dsx.module.x.context.y` is a **package's** data — its own state, *exposed read-only* for other packages to
read. A UI package keeps its working state in its surface's `dsx.variable` and lets outsiders observe via
**events**; it promotes a value to its context only when another package must *read* it directly (sync,
exclusion-safe — Firebase's `pushId`, Meta's ad flag). So: `dsx.variable` = surface layer, `dsx.context`
= package layer, `dsx.global` = the app store, events = how consumers normally observe.

**A package exposes two separate faces:** its **`dsx.context`** (the data it publishes) and its
**`dsx.delegate`** (the decision points it exposes; see
[`../Documentation/architecture/delegates.md`](../Documentation/architecture/delegates.md)). A *consumer* reads
a **named** package the mirror way — `dsx.module.<scheme>.context` / `dsx.module.<scheme>.delegate`.
(`dsx.context` = a package's own realtime data; `dsx.delegate` = its decisions; `dsx.global` = the app-global
cross-screen store — all different things.)

## How the real VerticalPlayer does it (copy this shape)

```swift
let ui = dsx.component.mount(.verticalplayer.Player)   // mount its own UI surface
ui.variable("credits", creditsBalance)                 // seed that surface's state → components bind {{ dsx.variable.credits }}
  .variable("speed", 1.0).variable("premium", premium) // (Speed.dsx even assigns it: on:tap="dsx.variable.speed = 0.5")

dsx.action("spend") { dsx in                           // a COMMAND — the only way in. Same call on every surface.
    let n = dsx.args("amount").int
    guard creditsBalance >= n else { return dsx.error("insufficient") }
    creditsBalance -= n
    surface?.set("credits", creditsBalance)            // update its own UI surface (dsx.variable the components bind)
    dsx.broadcast("creditsChanged", ["balance": creditsBalance])   // EVENT out → despia.on / dsx.hook
    dsx.resolve(["balance": creditsBalance])           // answer the caller's promise
}
```
Owns data, drives its surface with `dsx.variable`, takes commands, emits events. **No `dsx.context.set`**
— the real player never publishes package state; its UI lives in `dsx.variable`. That is the template.

## Calling a package — the same call on every surface

Calling from a **native DSX screen** is the web view's call verbatim — the page's `window.dsx` exposes the
same `dsx.module` root markup uses; same registry, same action, same `resolve` (the JSE runner dispatches
`dsx.module.…` through the very path the web bridge uses; legacy pages spell it
`window.despia.player.spend(…)`, no `module` root):

```js
// WEB VIEW (JS)
const { balance } = await dsx.module.player.spend({ amount: 30 })   // call → resolved promise
dsx.on("player", e => e.event === "creditsChanged" && render(e.balance))   // event
```
```xml
<!-- NATIVE DSX SCREEN (JSE markup) — identical call, dsx. root -->
<button label="Spend 30" on:tap="dsx.module.player.spend({ amount: 30 })"/>
```
```swift
// NATIVE MODULE (Swift)
let r = try? dsx.module.player.spend(["amount": 30])        // call (try? = exclusion-safe)
dsx.hook("player.creditsChanged") { v in render(v) }        // event
```

> `dsx.module.player.spend(…)` **is** `window.dsx.module.player.spend(…)` — the page speaks the universal
> `dsx` root (`window.despia.player.spend(…)` is its legacy alias spelling). One bus; surfaces differ only in
> how they *observe* (a JS event, a Swift hook,
> a re-render). To observe a package you **listen to its events**, you don't reach into its state.

## Best practices

**1 · Commands are domain verbs, not setters.** `spend`, `unlock`, `postComment` — intent + invariants live
in the handler. Never a generic `set("coins", x)` (no intent, no guard).

**2 · Drive your own UI with `dsx.variable`.** A package that renders components mounts a surface and seeds it
(`ui.variable("credits", …)` / `surface?.set("credits", v)`); the components bind `{{ dsx.variable.credits }}`
and may assign it (`dsx.variable.speed = 0.5`). This is surface-local — the player's, your settings screen's,
the gradient's `speed`. It is the default home for state.

**3 · Talk to the outside with events + resolve, never exposed state.** `dsx.resolve(…)` answers the caller;
`dsx.broadcast("creditsChanged", …)` tells everyone (web `despia.on` / native `dsx.hook`). Consumers *observe
events*; they never read your internals.

**4 · "Change it from outside" = call a command.** There is no `dsx.module.player.credits = 3`. A consumer
calls `dsx.module.player.spend(…)`; the package owns the mutation and emits the result.

**5 · `dsx.context` is ONLY for a cross-package synchronous read.** Publish with
`dsx.context.set("flag", v)` + `dsx.json "context"` in exactly one case: another **package** must read a
value you own *synchronously* (no event round-trip) and *exclusion-safely*. `dsx.module.metaads.context.facebookAds.bool`
returns a typed `false` when Meta is compiled out — which is why Dom reads `firebase.context.pushId`, AdMob reads
Meta's flag, PushRouting reads OneSignal's. It is the sanctioned replacement for the old cross-package
`dsx.values("a.b")` magic strings (`dsx.values` itself stays — the private native scratchpad, e.g. the launch
URL). A UI package (VerticalPlayer) needs none of this — it uses `dsx.variable` + events.

**6 · Customize UI with slots / composition, not flags.**
```xml
<slot name="paywall" default="DefaultPaywall"/>        <!-- app supplies <Paywall/> → theirs wins -->
```

**7 · Expose decisions as a `delegate` — the package's behavior surface.** Declare decision points in
`dsx.json` `delegate`; the package *asks*, the app or a preset *answers*. It's the typed, declared form of
`dsx.claim`/`dsx.hook` — the package's **decision** face, sibling to its **`dsx.context`** data face.
```swift
guard dsx.delegate.allows("willTrackEvent", ["category": cat]) else { return }   // owner (Airbridge) ASKS
dsx.module.airbridge.delegate.willTrackEvent { _ in granted }                             // consumer ANSWERS
```

**8 · Cross-platform: logic in DSX, native only for capabilities.** State + flow go in `<action>` blocks
(identical iOS & Android). Drop to native ONLY for what DSX can't do — IAP, downloads, AVPlayer — and resolve
the result back to a DSX action.

## Which channel? (the one table to remember)

| you need… | use | scope |
|---|---|---|
| a surface's own view-state (incl. a package feeding its own components) | `dsx.variable.x` | per-surface, isolated |
| answer a call · announce a change | `dsx.resolve` · `dsx.broadcast` | bus-wide, event |
| **another package** to read your value, sync + exclusion-safe | publish `dsx.context.set` → read `dsx.module.x.context.y` | a package's **context** (data) |
| let **another package** *shape a decision* you own | expose `dsx.delegate` → attach `dsx.module.x.delegate.<event>` | a package's **delegate** |
| app-global / cross-screen state (e.g. `user.name` set in A, read in B) | `dsx.global.x` (`.set`/`.get`/`.watch`) | the **app** store (not a package) |

## Anti-patterns (do not)

- ❌ **Exposing UI state via `dsx.context`** — coins/speed/comments belong in `dsx.variable` on the
  package's surface, with events for outsiders. `dsx.context` is the cross-package *config read*, not your view-state.
- ❌ **Writable package state** — `dsx.module.player.credits = 3`. Mutate only through a command.
- ❌ **A per-package "state system"** — wrappers, mirrors-by-hand, owners. The bus already gives you
  variable + commands + events. Don't rebuild it.
- ❌ **Confusing the layers** — `dsx.variable.x` is a *surface's* own state; `dsx.module.x.context.y` is a
  *package's* cross-package read. Never use one for the other.
- ❌ **`despia.on` as "the API"** — that's one web alias for the event. The API is `dsx.module.*` (call) + the event.

## Worked example — VerticalPlayer (coins · the gate)

```swift
// COMMANDS = the public API (registered on dsx). Domain verbs; each updates the surface + emits an event.
dsx.action("spend") { [weak self] dsx in
    guard let self, self.creditsBalance >= dsx.args("amount").int else { return dsx.error("insufficient") }
    self.creditsBalance -= dsx.args("amount").int
    self.surface?.set("credits", self.creditsBalance)            // its OWN UI (dsx.variable the components bind)
    self.emit("creditsChanged", ["balance": self.creditsBalance]) // emit = dsx.broadcast (+ web stream + webhook)
    dsx.resolve(JSON(["balance": self.creditsBalance]))
}
dsx.action("close") { [weak self] dsx in self?.close(); dsx.resolve(JSON(["closed": true])) }

// POLICY — the player asks; a preset answers by default, the app can hook first. Custom ads live here.
// (Illustrative shapes: `player`/`spend`/`PaywallPreset` are schematic, not shipped symbols. The
// real shipped example is Custom/VerticalPlayerStack — scheme `verticalplayer`, actions
// start/refresh/update/skip/buy/restore/getcoins/download*/downloads/close.)
dsx.hook("player.unlock") { p in PaywallPreset.shared.gate(p) }
```
```xml
<!-- Its own components bind dsx.variable on the player's surface — never dsx.module.player.context -->
<text value="{{ dsx.variable.credits }} 💎"/>
<pill on:tap="dsx.variable.speed = 0.5"/>
<button label="Unlock" on:tap="dsx.module.player.spend({ amount: 30 })"/>   <!-- calls a command -->
```
A consumer elsewhere (another screen, the web view) listens: `dsx.on("player", e => …)` / `dsx.hook`.
No `dsx.context`, no mirrors, no `@PackageState` — `dsx.variable` for its UI, commands in, events out.
