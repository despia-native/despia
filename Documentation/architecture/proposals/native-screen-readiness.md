# Native screen readiness + web-optional boot (ACCEPTED — LANDED on all three renderers)

> **Status: LANDED (2026-07-24), except §5 which is SUPERSEDED (see below).** The reporter,
> the coordinator and the authoring surface ship on every renderer:
>
> | Renderer | Reporter + coordinator | Corpus runner |
> |---|---|---|
> | Swift | `DSXScreenReadiness` (`Engine/iOS/DSXScreen.swift:136`), consumed at `Router.swift` | `ConformanceHosts.swift` (record lane) |
> | Kotlin | `ScreenReadiness.kt` (`:core`) + `Lifecycle.kt` translation | `:core ScreenReadinessTest` (gradle) |
> | TS | `packages/kernel/src/screen.ts` (`ScreenReadinessImpl` + `installScreenPhase`) | `packages/dom` suites (per-PR) |
>
> Authoring surface: the root-only `settle="manual"` attribute (ERROR-gated by `lint_dsx.rb`,
> `SETTLE_ATTR_RE` / `SETTLED_CALL_RE`) and the JSE verb `dsx.screen.settled()` (`JSEActions.swift` ·
> `JseRunner.kt` · `runner.ts`). Corpus: `OpenSource/Conformance/lifecycle/{readiness,phase}.json`.
>
> **§5 (the boot fix) is RETIRED, not implemented.** `bootsToEntryFallback`, `entry.fallback` and
> the `EngineConfig` `defaults.view` floor it reads were superseded by the **ROOT PLAN**
> (`proposals/root-plan.md`): `App.json entry.surfaces` is the ordered first-ready fold that owns
> the root on every lane, `router/boot.json` was replaced by `router/root-plan.json`, and
> `entry.fallback` now aborts at prepare (`root_plan_schema.rb`). §5 is kept below as the design
> record of the problem the root plan solved — **do not implement it**.
>
> The vocabulary spec this completes: [`reference/screen-lifecycle.md`](../../reference/screen-lifecycle.md).
> Issue: #22, *web-optional boot + unified surface readiness*.

## The problem, verified against the code (as of the 2026-07 design pass)

The constitution calls Despia a **web-optional native runtime** in which `<DSXWebView/>` (web) and
`<DSXView/>` (native) are equal consumers and neither is privileged. Two runtime facts make that
false today.

### (A) There is no native readiness reporter

The unified vocabulary already exists and every consumer already speaks it — Spinner, Splash,
Engagement, ScreenShield and PostHog all hook `screen.loading` / `screen.ready`. But
`Mandatory/Lifecycle` translates **only** the web surface's private signal
(`Lifecycle.swift` / `Lifecycle.kt`, verbatim):

```swift
dsx.delegate.listen("surface.domStart")  { … publish("loading", ready: false); dsx.delegate.send("screen.loading", …, combine: .void) }
dsx.delegate.listen("surface.domFinish") { … publish("ready",   ready: true);  dsx.delegate.send("screen.ready", …, combine: .void) }
dsx.delegate.listen("surface.domFail")   { … publish("ready",   ready: true);  dsx.delegate.send("screen.ready", …, combine: .void) }
```

Those three hooks are the module's entire `setup()`. `screen-lifecycle.md` closes with a section
titled *"Adding a native (`DSXView`) reporter — the additive follow-up"*, which is an explicit,
unimplemented TODO.

Consequence: on a host-less native app **no page ever loads, so `screen.ready` never fires** —
the splash never reveals, `ScreenShield` never arms, `Engagement` never runs, `PostHog` records
no route. It also silently broke the Demo package's `open_on_launch`, which still uses the
legacy web-coupled `dsx.ready { … }` (`Demo.swift:40`, `Demo.kt:63`) — the exact anti-pattern
the lifecycle spec exists to remove.

### (B) A host-less native app cannot boot to its own native entry

`AppManifest.usesBundledNativeStarter` returns true for the literal view `"DSXStartup"` only, and
`Router.boot()` uses that one bit to decide the root frame:

```swift
let root = AppManifest.usesBundledNativeStarter ? fallbackEntry(path)
                                                : entry(path, depth: 0, mount: false)
```

Every other native entry therefore goes through route resolution — and boot passes `mount: false`,
which by design **skips the `component` branch of `materialize()`** ("boot's root seed passes false
so the app's boot surface stays the App.json entry"). So the seeded root frame keeps
`view = AppManifest.defaultView` = `"DSXWebView"`, and with no configured host that renders the web
*"No web app origin is configured"* screen. A pure-native app cannot boot to its own native entry.
(Verified empirically by the prior investigation; the working tree carries a `// WIP (#22 …)` patch
in `AppManifest.swift` with no Kotlin twin, no name change, and no fixture — this proposal
generalizes and pins it.)

---

## The contract

### 1. The native sibling events

`dom*` stays the **web** surface's PRIVATE signal. The native surface gets a **sibling** of the
same shape, translated by the same coordinator:

| Surface | Private signals | Payload |
|---|---|---|
| web (`DSXWebView`) | `surface.domStart` · `surface.domFinish` · `surface.domFail` | `{ url, surface }` |
| native (`DSXView`) | `surface.viewStart` · `surface.viewFinish` | `{ path, surface: "native", frame }` |

There is deliberately **no `viewFail`**: a native frame always settles — on its first render, or on
its own report. A native screen's failure is a value on the error plane (`dsx.error`, the ambient
hat), never a lifecycle phase. `surface.domFail` exists only because a `WKWebView`/`WebViewClient`
navigation can terminate without ever finishing.

`view*` is subject to the same access rule as `dom*`: only the `Lifecycle` coordinator hooks it.
Behavior modules keep hooking `screen.*` and **change nothing** — zero consumer edits is the proof
the model was right.

### 2. The reporter: default settle, opt-in defer

A native frame is `loading` from mount and settles **once**. Two modes:

| Spelling | Plane | Semantics |
|---|---|---|
| *(nothing — the default)* | — | the frame settles on its **first completed render pass** ("auto") |
| `settle="manual"` | root-element attribute, **root only** (exactly like `exit`) | this screen reports readiness itself |
| `dsx.screen.settled()` | JSE verb, any handler / action / script | "this screen has settled" — settles the frame, once |

```xml
<!-- Orders.dsx — a screen that must not claim readiness until its data has landed -->
<stack settle="manual">
  <head>
    <api as="orders" url="/api/orders" on:success="dsx.screen.settled()"
                                       on:error="dsx.screen.settled()"/>
  </head>
  …
</stack>
```

**Naming rationale.** `settle` is the word `screen-lifecycle.md` already uses for the concept ("a
surface **settled**"; "a failed load is still settled"), so nothing foreign is introduced.
`dsx.screen.settled()` is a **call**; `dsx.screen.ready` (Bool) and `dsx.screen.phase` (String)
remain read-only reactive **properties** — a call and a property never share a spelling. `dsx.screen`
is already a declared JSE root (`lint_dsx.rb` `JSE_ROOTS`), and `settle` collides with no existing
universal or element attribute (`on:ready` is a `<video>`/`<audio>` element event, not a root word).

Calling `dsx.screen.settled()` on an auto screen is harmless: it settles a beat early and the later
first-render tick is a no-op.

### 3. The state machine (corpus: `lifecycle/readiness.json`)

One record per **live frame id**, from the Router's `nav.stack`. Nine inputs:

| Input | When |
|---|---|
| `mount(frame, path, surface)` | a frame entered the stack (and its bounded deadline is armed) |
| `manual(frame)` | the frame's root declared `settle="manual"` (registered while hoisting the head) |
| `hostsWeb(frame)` | the frame mounted a `<DSXWebView/>` app web surface (registered by the component) |
| `rendered(frame)` | the frame completed its FIRST render pass |
| `settled(frame)` | `dsx.screen.settled()` |
| `deadline(frame)` | the frame's bounded settle deadline elapsed |
| `release(frame)` | the frame left the stack |
| `webStart()` | the app web surface began loading (`surface.domStart`) — frameless |
| `webSettled()` | the app web surface settled (`surface.domFinish`/`surface.domFail`) — frameless |

The laws (all fixture rows):

1. **Native only.** A `mount` whose `surface` is not `"native"` is ignored outright — the web
   surface reports through `dom*`, so a hybrid app never double-reports.
2. **`surface.viewStart` once per frame INSTANCE.** `mount` is idempotent while the record lives; a
   `release` + re-`mount` of the same id is a new instance and starts a fresh cycle.
3. **Auto settles on `rendered`.** Manual does not.
4. **At most one `surface.viewFinish` per instance.** Later `rendered` / `settled` / `manual` / `hostsWeb` /
   `deadline` inputs are no-ops — a re-render or a chatty screen can never re-fire.
5. **An explicit `settled` always wins** — it settles an auto frame early and clears a pending
   `manual` and a pending `hostsWeb` gate.
6. **Released-before-settled never settles late.** No `surface.viewFinish` after the screen is gone;
   `settled` / `rendered` / `manual` / `deadline` for an unknown frame is a silent no-op (Article 7,
   fail-open).
7. **A hosted web surface gates its frame.** `hostsWeb` defers the settle exactly like `manual`;
   `webSettled` releases every gated frame ascending, skipping any that also declared `manual`.
   `webSettled` latches (a frame mounted while the page is already up does not gate) and `webStart`
   re-arms it.
8. **The bounded deadline settles anything still waiting.** `settleDeadlineMs` = 10 000, armed by the
   MACHINE at `mount` and cancelled on settle/release, blind to `manual`/`hostsWeb` when it fires.

Renderer obligation (not expressible as a fixture step): `manual` and `hostsWeb` must be registered
during the frame's first render pass — trivially satisfiable, since `settle` is a root attribute
known the moment the root node is read and `<DSXWebView/>` registers its own gate as it builds the
surface — and `rendered` must be reported on a turn **strictly after** that pass completes. The
deadline has NO renderer obligation by construction: it is armed inside `mount`.

### 4. The translation (corpus: `lifecycle/phase.json`)

The coordinator is stateless and level-triggered; de-duplication is the reporter's job.

```
surface.domStart  | surface.viewStart   → phase "loading", ready false → fire screen.loading(route)
surface.domFinish | surface.domFail | surface.viewFinish → phase "ready", ready true → fire screen.ready(route)
```

- **App-surface guard.** Translate only when `surface` is the app surface — `"web"` or `"native"`.
  Any other tag is a bare embedded `<WebView/>` named by its node (`DSXWebDelegate.surface(of:)`
  answers the node name) and is dropped, so an embedded player can never flip the app's
  spinner/splash/analytics. An untagged payload counts as the app surface (fail-open).
- **Route string.** The re-fired `screen.*` input is the plain string: `url` when present, else
  `path`, else the input itself when already a string, else `null`. The existing `screen.*`
  contract is byte-identical for web.
- **Merge, never replace.** `screen.phase` / `screen.ready` are written INTO the same `screen`
  object that carries the window metrics; a rotation must not wipe the phase and a phase publish
  must not wipe the metrics. iOS already merges (`DSXScreen.swift`); the **web** renderer currently
  does `DSXState.set("screen", screenMetrics(…))`, a whole-object replace, and must be changed to
  overlay when it starts publishing the phase.

### 5. The boot fix — ~~corpus: `router/boot.json`~~ **SUPERSEDED AND RETIRED**

> **Do not implement this section.** It shipped once as `bootsToEntryFallback` and was then
> RETIRED by the **ROOT PLAN** (`proposals/root-plan.md`), which replaced the whole two-arm
> predicate with an ordered, first-ready fold over `App.json entry.surfaces`. Today: there is no
> `AppManifest.defaultView` and no `EngineConfig` `defaults.view` on any lane
> (`check_module_rules` rule 18b errors if the key regrows), `entry.fallback` aborts in
> `root_plan_schema.rb`, `router/boot.json` was deleted in favour of `router/root-plan.json`, and
> `Router.boot()` on both natives carries a comment marking the old rule dead. What follows is the
> design record of the problem — the fold is the answer to it.

Rename and generalize the one bit `Router.boot()` reads:

```
bootsToEntryFallback  ==  view == "DSXStartup"                       // the bundled native starter
                      ||  (view != "DSXWebView" && resolvedHost() == nil)  // a host-less NATIVE app
```

where `view` is the RESOLVED `AppManifest.entry.fallback.view` (explicit `entry.fallback.view`,
else EngineConfig `defaults.view`, else `"DSXWebView"`) and an empty host string counts as no host.

- Web apps (`DSXWebView` fallback): route-table-first, unchanged — including the misconfigured
  origin-less case, whose degrade stays exactly what it is today.
- Hybrid apps (native fallback **and** a configured origin): route-table-first, unchanged. This
  is what keeps the change safe: the new arm is conditioned on the ABSENCE of a host.
- Host-less native apps: boot the declared native entry. This is the fix.

Declaring a pure-native app therefore stays pure data — `App.json`
`{"entry": {"fallback": {"view": "DSXView", "src": "/dsx/home/"}}}` or simply EngineConfig
`defaults.view: "DSXView"` — with no host configured.

### 6. The follow-on this unblocks — **DONE**

`Demo.swift` / `Demo.kt` `open_on_launch` moved off the legacy web-coupled `dsx.ready { … }` onto
`dsx.delegate.listen("screen.ready")`, which fires on web **and** native (`Demo.swift:48`, `Demo.kt:71`).
That was the smallest end-to-end proof the reporter works, and it landed with the wave. The
`autoOpened` once-guard is load-bearing: `screen.ready` fires on every settle, where `dsx.ready`
ran a single time.

---

## What does NOT change

- `dsx.ready` / `dsx.hydrate` keep working for web, byte-for-byte (`runReady` still runs from the
  Dom relay's `didFinish`, app surface only).
- `dom*` remains web-private; the documented exceptions (Dom's page re-broadcast, PushRouting,
  SharedData) are untouched.
- **Zero consumer modules change.** Spinner, Splash, Engagement, ScreenShield and PostHog keep
  their existing `screen.*` hooks and gain native coverage for free.
- Route resolution, `popTo`, and the presentation machine are untouched.

## Risks

- **Double-reporting on a hybrid app.** A frame that hosts `DSXWebView` must never also report `view*`.
  Guarded by law 1 (native-only `mount`) and pinned by the *"a web frame is never reported here"*
  row.
- **Ordering of `manual` vs `rendered`.** A renderer that reports `rendered` synchronously inside
  the first render pass would settle a deferred screen before its root head hoists. Each renderer
  must use the post-pass hop; the corpus cannot catch a mis-wiring here, so it is called out in
  `lifecycle/README.md` and in the per-file change list.
- ~~**A `settle="manual"` screen that never calls `dsx.screen.settled()`** leaves the shell in
  `loading` forever (a permanent spinner).~~ **CLOSED — this was wrong to file as "authored
  behavior".** A hung phase is not local to the screen: on a HYBRID app there is ONE shared
  `global.screen.phase`, so a stuck native frame also freezes the *web* surface's consumers. Both
  halves now ship:
  1. a **bounded settle deadline** in the reporter (`settleDeadlineMs` = 10 000, armed by the
     machine at `mount`, cancelled on settle/release) after which the frame settles anyway — the
     Article 7 fail-open, identical on all three renderers and pinned by `readiness.json`;
  2. the lint rule, as an **ERROR** rather than a warning (`lint_dsx.rb`): a root carrying
     `settle="manual"` in a file with no literal `dsx.screen.settled()` fails the build, as does a
     `settle=` value that is neither `auto` nor `manual`; a nested `settle=` warns (root-only).

- **A native frame that HOSTS `<DSXWebView/>` settled on first render** — the hybrid splash-over-blank-
  webview regression. The root frame of a hybrid app is native (its root is DSX markup), so it
  reported settled the moment it painted, revealing Splash over an empty web view; `surface.domStart` then
  re-fired `screen.loading`. Before this proposal the splash correctly waited for the page.
  **CLOSED:** the reporter gained a `hostsWeb` gate that `<DSXWebView/>` registers itself (no author
  opt-in — a regression fix must work on unchanged markup) and that the surface's own
  `webSettled()` (the relay's `surface.domFinish`/`surface.domFail`) releases. The gate latches on the web
  surface's state, so a frame mounted while the page is already up never waits for a load that will
  not come, and an authored `settle="manual"` root keeps ownership over the gate.
- **`<DSXView/>` is itself an async loader.** It renders a `ProgressView` on its first pass, so it
  must register `manual` for its frame at construction and report `settled` on both its `ready` and
  `failed` outcomes — otherwise a remote native screen settles while still blank.
- **The web renderer's `screen` replace.** `seedScreen()` in `packages/dom/src/boot.ts` replaces the
  whole `screen` object on every resize; publishing the phase without changing that to a merge would
  clobber `phase`/`ready` on the first rotation.
