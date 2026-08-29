# Delegates — the native, cross-package event surface

> **Status: LANDED.** `listen`/`send` is the ONLY pair of verbs on this plane — **phase 4, the
> collapse, is done**: `hook`/`fire`/`fireAny`/`claim`/`collect` are DELETED from the kernel and
> from every call site on both natives (572 code sites + 62 prose mentions), and
> `ModuleRegistry.dispatch` is the one fold.
> **Phase 5's declaration half is done** too: every host-event plane now has a declaring owner, so
> `dsx.delegate.send` of a namespaced event is lint-checked everywhere (`check_module_rules` rule 8)
> — and its mirror landed with it: a `listen` of a name nothing can emit now WARNS
> (`check_module_rules` rule 21, §7).
> The *expose/intercept* typed sugar shipped earlier (Phase 03, `dsx.module.<scheme>.delegate`).
> The TS twin is now collapsed too, and **phase 5 is complete**: surface readiness is namespaced
> `surface.*`, and all 27 bootloader events are namespaced `lifecycle.*` across all three renderers.
> `Mandatory/Lifecycle` declares both coordination planes; bootloaders only translate host callbacks
> into those contracts and still own no behavior. The 263 former bare native call sites, direct host
> emitters, and future regressions are now guarded on both the listen and emit sides. Scheme-less
> dotted declarations now reach both native runtime fold registries as well. The remaining
> non-blocking observability debt is named in §7.

A **delegate** is a named, native, cross-package event with a folded answer: one place **emits** it, any
number of packages **listen** for it, and their answers are combined by a declared policy (consume / veto /
claim / collect). It's the app's internal coordination channel — distinct from a point-to-point **action**
and from a fire-and-forget **broadcast**.

---

## 1. The three shapes (pick the right one)

```
ACTION                          DELEGATE                       BROADCAST
dsx.module.airbridge.track()    dsx.delegate.send("lifecycle.openURL")   dsx.broadcast("deeplink")
        │                          │   │   │                      │   │   │
        ▼                          ▼   ▼   ▼                      ▼   ▼   ▼
   one named package         every package that listened    every subscriber + web
   resolves a value          folds their answers             fire-and-forget
   (to the CALLER)           (for the EMITTER)               (no answer)
```

| | **Action** | **Delegate** | **Broadcast** |
|---|---|---|---|
| addressed by | **scheme** (`airbridge`) — *who* | **event name** (`lifecycle.openURL`) — a *topic* | **scheme** — a *topic* |
| handlers run | **one** (the owner) | **N** (everyone listening) | **N** (everyone subscribed) |
| comes back | a resolved value | a **folded** answer | nothing |
| reaches **web**? | yes (the promise bridges to `window.dsx`) | **no** — native, app-internal | yes (mirrored to `window.dsx.on`) |
| call ⇄ handle | `dsx.module.x.y(args)` ⇄ `dsx.action("y")` | `dsx.delegate.send(n,…)` ⇄ `dsx.delegate.listen(n){}` | `dsx.broadcast(n,…)` ⇄ `dsx.on(scheme){}` |

**One-liner:** *action* = call one package, get a value (web-capable). *delegate* = announce to whoever's
listening, natively, and collapse their answers. *broadcast* = "FYI, this happened" to everyone incl. web.

> **Why `listen`, not `watch`?** `watch` is already the web/value verb — `despia.global.watch("session")`,
> `location.watch(...)` *stream a value*. A delegate is a native **event** you `listen` for, and `on` is the
> broadcast verb — so each shape keeps a distinct word.

---

## 2. The primitive: `listen` / `send`

Two verbs, lowering straight to the core registry. No `hook`/`fire`/`fireAny`/`claim`/`collect` underneath —
the **combine policy** *is* the difference between those four old fire-verbs. `allows` is the plain-`Bool`
veto-gate form of `send`.

```swift
dsx.delegate.listen("lifecycle.openURL") { url in … }           // attach a handler (raw: return a value or nil)
dsx.delegate.send("airbridge.willTrackEvent", payload)          // emit; returns the raw folded answer
dsx.delegate.allows("airbridge.willTrackEvent", payload)        // veto gate, read as a plain Bool (no cast)
```

### Combine policies (how the answers collapse)

| policy | `send` returns | replaces the old verb | use |
|---|---|---|---|
| `void` | nothing, all run | `fire` | analytics fan-out, `lifecycle.launch` |
| `any` | `true` if any answered (non-nil) | `fireAny` | `lifecycle.openURL` (consume) |
| `claim` | first non-nil | `claim` | `web.startURL` (one owner) |
| `veto` | `false` if any returned false (read via `allows`) | — | `willTrackEvent` (block) |
| `collect` | array of every answer | `collect` | gather contributions |

> **`any` is non-nil, not Bool-`true`.** A listener consumes a `lifecycle.openURL` /
> `lifecycle.continueActivity` event by
> returning the URL *or* `true` — anything non-nil counts as handled (this is what live `fireAny` does, so
> the shim is behaviour-preserving). Every listener still runs; `send` just reports whether any consumed.

### The core (one place, no middle layer)

```swift
public enum Combine { case void, any, claim, collect, veto }

final class ModuleRegistry {
    private var hooks: [String: [(priority: Int, handler: (Any?) -> Any?)]] = [:]

    func register(_ e: String, priority: Int = 0, _ h: @escaping (Any?) -> Any?) {   // ← listen
        hooks[e, default: []].append((priority, h))
    }
    @discardableResult
    func dispatch(_ e: String, _ input: Any?, _ combine: Combine) -> Any? {           // ← send
        let hs = (hooks[e] ?? []).sorted { $0.priority > $1.priority }.map(\.handler)
        switch combine {
        case .void:    hs.forEach { _ = $0(input) }
                       // + the ALIAS fan-out: a "<chain>.<kind>" name also folds under each legacy
                       // alias spelling of that chain, so boot order never decides who hears.
                       return nil
        case .any:     return hs.map { $0(input) }.contains { $0 != nil }   // non-nil = consumed; every listener runs
        case .claim:   for h in hs { if let r = h(input) { return r } }; return nil
        case .collect: return hs.compactMap { $0(input) }
        case .veto:    return !hs.contains { ($0(input) as? Bool) == false }
        }
    }
}
```
`dsx.delegate` is a zero-cost namespace facade — `listen`/`send` forward to `register`/`dispatch` in one hop
(`allows` is `send(…, combine: .veto) as? Bool ?? true`). In the live kernel the handler table is held **per
module** (each `Module`'s registration), and `register` is the kernel-internal append that
`dsx.delegate.listen` performs — so deleting a module's folder drops its listeners from the fold
automatically; `dispatch` reads the same priority-ordered table across all modules.

> **Always pass `combine:` at an emit site the collapse rewrote.** `send` resolves the policy as
> *explicit argument → the emitter's declared `dsx.json` policy → `.claim`*. An EXCLUDED owner
> contributes no `delegate` block to this build, and the silent fallback `.claim` **short-circuits** —
> so a `fire` that became a bare `send` would change its fan-out. Every collapsed site therefore names
> its fold; the declaration documents the contract and powers the `dsx.delegate.<event>()` sugar, but
> never silently decides one.

---

## 3. The declaration rule — **declare what you EXPOSE, never what you CONSUME**

| | declared in `dsx.json`? | why |
|---|---|---|
| **expose** a delegate (`send` / `allows`) | **yes** — `delegate` block | it's a public contract: payload + combine + discoverable |
| **consume** a delegate (`listen`) | **no** | reading the global event namespace — not an import, no contract to publish |

This mirrors the rest of the bus: you declare your surface (`methods`, `context`, `delegate`); you consume
freely (`dsx.module.x.y()`, `dsx.module.x.context.v`, `dsx.delegate.listen`). Emitting is exporting; listening
is just reading.

**A `delegate` key may be a PLANE.** A bare key is scheme-relative and namespaces to `<scheme>.<event>`
(Airbridge's `willTrackEvent` → `airbridge.willTrackEvent`). A key that **contains a dot** is already fully
namespaced (§4 — the name *is* the source) and is declared verbatim. That is what lets a module own an
event plane whose name is not its scheme, which every host plane needs:

| plane | declaring owner | why the plane ≠ the scheme |
|---|---|---|
| `web.*` | `Core/Dom` | Dom's scheme `dom` is its CALL face; `web.*` is the surface's EVENT face |
| `lifecycle.*` | `Mandatory/Lifecycle` | OS/app lifecycle coordination; bootloaders emit it but own no behavior |
| `screen.*` | `Mandatory/Lifecycle` | scheme-less on purpose (pure coordination) |
| `surface.*` | `Mandatory/Lifecycle` | the surfaces' PRIVATE readiness reports, which Lifecycle folds into `screen.*`. It spans BOTH surfaces — `surface.dom*` is the web surface's, `surface.view*` a native DSXView frame's — so it cannot live under Dom's `web.*` call plane. Declared by the coordinator, EMITTED by Dom (`dom*`) and the kernel (`view*`): the one plane whose declarer is not its emitter |
| `route.*` | `Mandatory/Routing` | scheme-less on purpose |
| `asset.*` + `content.*` | `Mandatory/ContentServer` | TWO planes, ONE owner (scheme `cdn`) |
| `boot.*` | `Mandatory/Splash` | scheme `splash` |
| `mac.*` | `Core/Extensions/Mac` | scheme-less |
| `dev.*` · `keyboard.*` · `legacy.*` · `liveactivity.*` · `statusbar.*` · `watch.*` | those modules | plane == scheme, so BARE keys |

A **module-events** name (`dsx.module.<chain>.on(kind)`, whose event name is COMPUTED from the owner's
chain at runtime) is *not* a declared point — there is no fixed contract to declare, and the lint only
validates fully-namespaced string LITERALS.

The KERNEL planes are reserved tenants that no module may declare or squat: `module.*` (error/callFailed),
`source.*`, `cookie.*`, `root.*`, `background.*`.

**The typo-safety payoff:** because every emit is declared, codegen knows the *set of all valid event names*.
The lint checks the emit side against it — a `send`/`allows` to an undeclared event is a **build error** (your
own contract). And since phase 5 gave every host plane a declaring owner, the consuming side is measurable
too: a dotted `listen` of a name nothing can emit is a **warning** (rule 21 — never an error, because
listening is declaration-free by law). So consuming stays declaration-free *and* typo-safe.

---

## 4. Namespacing — the name **is** the source

Events are `<owner>.<event>` (`lifecycle.openURL`, `airbridge.willTrackEvent`). The prefix identifies the
emitter, so you never sniff who fired it:

```swift
// ❌ subscribe broad, then branch on the emitter — un-scalable, and pointless for single-emitter events
dsx.delegate.listen("openURL") { if source == "lifecycle" { … } }

// ✅ the name carries the source — listen for exactly the one you mean
dsx.delegate.listen("lifecycle.openURL") { url in … }
```
The only broad subscription is a **firehose** (a logger/debugger), and there the matched *name* — which
already contains the namespace — is the parameter:
```swift
dsx.delegate.listen("lifecycle.*") { name, payload in log(name) }
```

---

## 5. Recipes

### Expose a delegate, and gate an action on it (zero Swift)
```jsonc
// airbridge/dsx.json — declare what you emit, then gate the action right in the manifest
"scheme": "airbridge",
"delegate": {
  "willTrackEvent": { "combine": "veto", "payload": { "category": "string" },
                      "_note": "Veto gate before an event is sent — any listener returning false blocks it." }
},
"methods": {
  "track_event": { "args": { "category": "string" }, "gate": "willTrackEvent" }   // ← declarative gate
}
```
The `gate` makes the kernel fold `airbridge.willTrackEvent` (veto) **before** `track_event` dispatches: a
denied call resolves `{ ok: false, blocked: "willTrackEvent" }` and the handler never runs — so the Swift
stays pure, no gate code at all. (Codegen verifies the `gate` names a declared `veto` delegate, so a typo
fails the build.)

To gate **mid-logic** instead — not at the action boundary — read the veto fold inline with `allows`:
```swift
guard dsx.delegate.allows("airbridge.willTrackEvent", ["category": cat]) else { return }   // veto → Bool
Airbridge.trackEvent(category: cat)
```

### Consume a delegate (zero JSON)
```swift
override func setup() {
    dsx.delegate.listen("lifecycle.openURL") { input in self.onOpenURL(input); return nil }   // no declaration, ever
}
```

### Intercept another package (also zero JSON — it's consuming)
```swift
// consent/ConsentBridge.swift — block Airbridge's tracking until the user opts in
dsx.delegate.listen("airbridge.willTrackEvent") { [self] _ in hasConsent }   // false ⇒ vetoes the send
```
Airbridge declared the point; Consent just listens. Neither imports the other.

---

## 6. Why it's fully scalable

- **No central file to edit.** A new emitter declares its own namespace; the generated registry aggregates.
  A new consumer is one `listen` line — no declaration, no import.
- **Delete a folder → it's gone.** Its emits leave the registry, its listeners leave the hook table.
- **Namespacing** prevents collisions and makes the source self-evident — no `this.package` sniffing.

```
 Core/Airbridge/   dsx.json: delegate{ willTrackEvent } + methods.track_event.gate   *.swift: (pure handler)
 Core/Consent/     (no json)                                                       *.swift: listen("airbridge.willTrackEvent")
 Mandatory/Lifecycle/ dsx.json: delegate{ lifecycle.openURL, lifecycle.launch }     hosts: emit on OS callbacks
        └────────────── all meet at DECLARED, namespaced points; nobody imports anybody ──────────────┘
```

---

## 7. What ships today vs. the plan

**Shipped (this PR) — the primitive is live:**

1. **`listen` / `send` / `allows`** — `dsx.delegate.listen(name, priority:) { }`, `dsx.delegate.send(name,
   payload, combine:)`, and the plain-`Bool` veto gate `dsx.delegate.allows(name, payload)` lower to one
   kernel fold, `ModuleRegistry.dispatch(_:_:_:)`, selected by `ModuleRegistry.Combine`
   (`void`/`any`/`claim`/`collect`/`veto`). The four legacy verbs (`fire`/`fireAny`/`claim`/`collect`) are
   now one-line **shims over `dispatch`** — a single fold, no duplicated pipeline, nothing else changed.
2. **Declarative gate** — `dsx.json` `methods.<action>.gate: "<event>"` makes the kernel fold the named
   `veto` delegate *before* the action dispatches; a denial resolves `{ ok:false, blocked:<event> }` and the
   handler never runs (`GeneratedActionGates` + `Registration.dispatch`). Codegen verifies the gate names a
   declared `veto` delegate, so a typo fails the build. Zero Swift in the gated handler.
3. **Worked example** — Core/Airbridge **declares** `willTrackEvent` (`veto`) and gates `track_event` on it
   in the manifest (pure handler); Core/Consent (off by default) **listens** on it and vetoes until consent
   is granted — an interceptor in one `listen` line, zero imports.
4. **Lint** — `dsx.delegate.send`/`allows` to an *undeclared* event is a build error
   (`check_module_rules.rb`): emitting is the contract, so it's typo-checked; listening stays declaration-free.

**Also live (Phase 03):** the typed *expose/intercept* sugar `dsx.module.<scheme>.delegate.<event>`
(attach `{ }` / invoke `(payload)`), declared in the `delegate` block — Terra's `shouldUpload` is the
reference; Airbridge's `willTrackEvent` is now a second.

**Phase 4 — the collapse: LANDED.** The scripted swap ran across `OpenSource/Engine/{iOS,Android}`,
`ClosedSource/DSX/Modules` and the two bootloaders — **572 code sites** (381 `hook→listen`, 191 emits:
115 `fire→send(.void)` · 12 `fireAny→send(.any)` · 57 `claim→send(.claim)` · 7 `collect→send(.collect)`)
plus 62 prose mentions in comments, and the
four shims are DELETED from `ModuleRegistry` and from `Context`. `Context.hook` is gone too: the append
is the kernel-internal `Context.register`, and `dsx.delegate.listen` is the ONE authoring spelling — one
idiom for attaching, one for emitting. Two semantics were preserved deliberately, not by pattern:

* the **alias fan-out** moved INSIDE `dispatch`'s `.void` arm (the deleted `fire` shim carried it, and
  deleting a shim must never drop behavior) — pinned by `ChainsConformanceTest.aliasHookSubscribedBeforeRegistrationStillHears`;
* the `dsx.delegate.<event>()` sugar's **veto** arm still folds over `.collect`, i.e. WITHOUT
  short-circuiting, exactly as it always did (`dsx.delegate.allows` remains the short-circuiting form).

**Phase 5 — host namespacing: LANDED.** Every host-event plane now has a declaring owner (the table
in §3), so `dsx.delegate.send`/`allows` of a namespaced event is typo-checked everywhere — which,
after the collapse, is *every* emit on the plane. The final bootloader slice renamed the 27 former
bare points to `lifecycle.*` across 263 native listen/send sites plus direct host emitters. The
mechanical migration changed 123 files and is idempotently checked by
`namespace_lifecycle_events.rb --check`.

`Mandatory/Lifecycle` owns the lifecycle contract because it is the behavior coordinator already
responsible for `screen.*` and `surface.*`; the iOS and Android bootloaders remain translation-only.
This preserves constitution rule 5: emitting an OS fact does not make the host the behavior owner.
Every point declares an explicit combine policy.

**`listen`-of-unknown: LANDED** as `check_module_rules` **rule 21** — the mirror of rule 8, and what
phase 5's declaration half unblocked. Rule 8 gates the emit side because *emitting is exporting*; the
watch side stays declaration-free by law (§3), but a `listen` nobody can emit is not a contract
violation — it is a handler that **silently never runs**, because the hook table is an exact dictionary
lookup (`ModuleRegistry.orderedHooks`). The real behavior, exactly:

* **Measured:** dotted string literals, `.delegate.listen("<plane>.<event>")`, in module Swift **and**
  Kotlin (comments stripped), plus the shipping Swift/Kotlin engine listeners. A non-literal name and
  a `*` firehose (§4) are skipped rather than guessed at. A **bare global literal is now an error**
  before rule 21: there is no legitimate module-relative meaning on `dsx.delegate`, so it must name a
  declared plane.
* **Known = three sources.** (a) the DECLARED set, built with rule 8's own key law — a *dotted* manifest key
  registers verbatim, a *bare* key namespaces to `<scheme>.<event>` (both spellings are live, and reading
  only one would warn on every host plane at once); (b) the **reserved kernel planes** `module.*` `source.*`
  `cookie.*` `root.*` `background.*`, which no module may declare yet everyone may watch; (c) the
  **module-events plane** — a name whose longest dot-boundary prefix is a known chain/scheme/alias is
  COMPUTED at runtime (`dsx.module.<chain>.on(kind)`) and §3 says outright it "is *not* a declared point",
  so `listen("watch.health")` must never be asked to declare itself.
* **Tier: WARN, never error** — printed and counted, never in the exit status, exactly like rule 20. An
  error tier would put a wall in front of a surface the constitution left open on purpose.
* **What it actually guards:** every CLOSED plane — `web.*` (18 declared points), `lifecycle.*`
  (27 points), `screen.*`, `mac.*`, `asset.*`, `boot.*` — because a plane word that is an event face
  rather than a scheme is not a chain and
  cannot be folded away. (c) is a deliberate over-approximation in the other direction: a typo inside a
  module's *own* chain-prefixed namespace is suppressed, which is rule 10's stated stance — over-approximating
  only ever suppresses a warning, never raises a false one. **The live tree is clean: 0 warnings**, and it
  stays honest because the ladder is unit-gated case by case in `delegate_listen_usage_test.rb` (26 cases)
  rather than by the tree's silence. Policy: `ClosedSource/scripts/delegate_listen_usage.rb`.

**Phase-5 details:**

1. **The bootloader host-event rename — LANDED.** The 27-point `lifecycle.*` contract is declared by
   `Mandatory/Lifecycle`; bootloaders only emit. The code migration is protected in four places:
   undeclared module emitters are rule-8 errors, unknown lifecycle listeners are rule-21 warnings,
   direct bootloader dispatches are checked against the same declaration set, and any bare global
   delegate literal is an error. Listener typo, emitter typo, direct-host typo, and bare-name
   regression mutations were each injected, observed failing, and reverted.

2. **The surface half — LANDED.** The six readiness signals are namespaced:
   `domStart`/`domCommit`/`domFinish`/`domFail`/`viewStart`/`viewFinish` → `surface.*`, 210 literals
   across 25 files, corpus-first (109 references in `phase.json` + `readiness.json`) and then all three
   renderers.

   **The plane is `surface.*`, not `web.*`,** because §7's old shorthand lumped two different faces
   together: `dom*` is the WEB surface's report, but `view*` is a NATIVE DSXView frame's
   (`{path, surface:'native', frame}`), and filing that under Dom's `web.*` call plane would have been
   factually wrong. Leaf names are kept verbatim, so which surface reported is never lost and the two
   faces stay distinct — a DOM commit is not a view settle. Lifecycle declares the plane, since it is
   the coordinator that folds both into `screen.*` and is already scheme-less for exactly that reason.

   **Namespaced, not promoted.** These remain the surfaces' PRIVATE signals; only the coordinator and
   genuine web-DOM packages listen, and everything else still takes `screen.*` and stays
   surface-agnostic. What the namespace buys is the guard, on BOTH sides and BOTH lanes: a listen typo
   raises rule 21 naming all six declared siblings, and an emit typo is now a rule 8 ERROR in Kotlin as
   well as Swift — rule 8 read `.swift` only until this landed, which left Dom's eight Kotlin
   `surface.dom*` sends unguarded. Both were verified by injecting the typo and watching them fire.

3. **Scheme-less delegate codegen — LANDED.** Both native generators now read dotted delegate
   declarations from enabled scheme-less coordination modules. `screen.*`, `route.*`, `mac.*`,
   `surface.*`, and `lifecycle.*` therefore carry their declared combine policies into the Swift and
   Kotlin runtime registries instead of falling back to `claim`. A manifest mutation from
   `lifecycle.launch: void` to `collect` made both generator `--check` modes fail and was reverted.

**Still open (named, not hidden):**

1. **No converse of rule 21.** Nothing warns about a point that is DECLARED but never emitted or
   listened to. `surface.domCommit` is close to that today: Lifecycle declares it and Dom is its only
   consumer, so if Dom's listener went away the point would sit in the manifest with no emitter and no
   listener and no gate would say so.

---

## 8. Relationship to the rest of the bus

- **Action** (`dsx.module.x.y`) — when you can *name* the one package and want a value back (web-capable).
- **Delegate** (`dsx.delegate.send`/`listen`) — native announce-with-an-answer to N listeners (this doc).
- **Broadcast** (`dsx.broadcast`/`dsx.on`) — fire-and-forget to N subscribers incl. web; **kept separate**
  (folding it in would conflate "ask for a verdict" with "notify"). See `dsx-native-bus.md`.
