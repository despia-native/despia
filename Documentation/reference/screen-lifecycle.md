# The screen lifecycle — the shell's unified, surface-agnostic loading/ready model

> **One vocabulary for "a screen is loading / a screen has settled," shared by every rendering
> surface.** A module hooks `screen.loading` / `screen.ready` (or reads `global.screen.*`) and
> works **identically on web (`DSXWebView`) and native (`DSXView`)** — it never hooks a web-specific
> event. This is the mental model that replaced "every module hooks `surface.domFinish`": the DSX app
> shell owns lifecycle as **state + events**; surfaces only *report* their phase; modules own
> behavior.

Source of truth:
- coordinator — `DSX/Modules/Mandatory/Lifecycle/{swift/Lifecycle.swift, kotlin/Lifecycle.kt}` (web renderer: `OpenSource/Web/packages/kernel/src/screen.ts`, `installScreenPhase()`)
- web surface reporter — `DSX/Modules/Mandatory/Dom/swift/WebDelegate.swift` (`DSXWebDelegate`)
- **native surface reporter** — `OpenSource/Engine/iOS/DSXScreen.swift` (`DSXScreenReadiness`) · `OpenSource/Engine/Android/core/.../ScreenReadiness.kt` · `OpenSource/Web/packages/kernel/src/screen.ts` (`ScreenReadiness`)
- the law (all three renderers) — `OpenSource/Conformance/lifecycle/readiness.json` (the reporter) + `phase.json` (the coordinator)
- render of the load indicator — `OpenSource/Engine/iOS/RouterHost.swift` (the kernel surface applies it as chrome) + `OpenSource/Engine/iOS/LoadingIndicator.swift`
- the load DECISION (state) — `DSX/Modules/Core/Basics/Spinner/SpinnerModule.swift`

---

## Why it exists (the inversion)

The legacy model was templatized and stiff: behavior modules hooked the **web view's** lifecycle
(`surface.domFinish`) directly, so each one silently assumed "the app is a web view." That couples every
feature to one surface. The shell model inverts it:

- **The shell owns lifecycle** — as a small, fixed vocabulary (below), published as both events and
  state.
- **A surface only reports its phase** — the web surface (DSXWebView) reports through `dom*`, the
  native surface (DSXView / any DSX-rendered frame) through `view*`. Reporting is the surface's
  *private* business. **Both report today** (see [the native reporter](#native-reporter)).
- **Modules own behavior** — they subscribe to the **unified** vocabulary, so the same module
  drives the spinner / arms screen-capture / fires engagement prompts no matter which surface is on
  screen. **Zero module changes** when a new surface starts reporting — that is the entire point.

---

## The vocabulary (the whole surface area)

### Events — `dsx.hook` / `dsx.fire`

| Event | Fires when | `input` payload |
|---|---|---|
| `screen.loading` | a surface began loading/presenting a screen or route | the URL/route `String` (when known) |
| `screen.ready`   | a surface **settled** — finished loading **OR failed** (a failed load is still "settled") | the URL `String` on a normal settle; a `[String: Any]` `{ url, error[, provisional] }` on a failed settle |

There are exactly **two** phases. There is no `screen.commit` — commit/hydration is a web-DOM concept
(see "What stays web-private"). Consumers that read `input` as a string get `nil` on the failure case,
which is safe; read it as `String?`.

### State — `dsx.global` (read in markup as `dsx.screen.*`)

| Key | Type | Value |
|---|---|---|
| `global.screen.phase` | `String` | `"loading"` \| `"ready"` |
| `global.screen.ready` | `Bool`   | `false` while loading, `true` once settled |
| `global.screen.frame` | `Int?`   | the **reporting frame's id**, or `null` for a frameless report |

`screen.frame` is the report's **identity**: a native report (`surface.viewStart`/`surface.viewFinish`) carries the
frame it describes; the web relay's `dom*` describes the one app web surface and names no frame, so
it publishes `null`. It exists because `phase`/`ready` are *level* state — without an identity, a
late report from a screen that is already gone is indistinguishable from the current screen's. The
ROOT PLAN binds it to the boot attempt that mounted the frame, so a retired candidate can never
crown its successor (root-plan.md §5). **Identity is published before the level** (`frame`, then
`phase`, then `ready`), so a level-triggered reader never sees a fresh `true` paired with a stale
frame.

These live under the **same `screen.*` namespace as the responsive window metrics** (`width`,
`height`, `sizeClass`, `orientation`, `breakpoint` — published by `DSXScreenMetrics`). The two
concerns are **merged, never clobbered**: `DSXScreenMetrics` overlays its keys onto the existing
`screen` object rather than replacing it, so a rotation/resize does not wipe `phase`/`ready`, and
`dsx.screen.ready` coexists with `dsx.screen.width` in the same markup:

```xml
<spinner visible-if="!dsx.screen.ready"/>
<grid columns="{{ dsx.screen.width > 900 ? 3 : 1 }}"/>
```

> **Events vs state.** The events are the primary, robust API (they fire exactly at the transition).
> The state keys are for *reactive markup* and *late joiners* that want the current phase without
> having been present for the fire. Today every native consumer uses the **events**.

---

## The translation layer — the `Lifecycle` module

`Lifecycle` (Mandatory, scheme-less, pure plumbing) is the **coordinator**. Its only job is to
translate each surface's private readiness report into the unified vocabulary:

```swift
dsx.delegate.listen("surface.domStart")   { input in publish("loading", ready: false, frame: reportFrame(input)); dsx.delegate.send("screen.loading", route(input), combine: .void); return nil }
dsx.delegate.listen("surface.domFinish")  { input in publish("ready",   ready: true,  frame: reportFrame(input)); dsx.delegate.send("screen.ready", route(input), combine: .void); return nil }
dsx.delegate.listen("surface.domFail")    { input in publish("ready",   ready: true,  frame: reportFrame(input)); dsx.delegate.send("screen.ready", route(input), combine: .void); return nil }
dsx.delegate.listen("surface.viewStart")  { input in publish("loading", ready: false, frame: reportFrame(input)); dsx.delegate.send("screen.loading", route(input), combine: .void); return nil }
dsx.delegate.listen("surface.viewFinish") { input in publish("ready",   ready: true,  frame: reportFrame(input)); dsx.delegate.send("screen.ready", route(input), combine: .void); return nil }
// publish() = dsx.global.set("screen.frame", …) THEN ("screen.phase", …) THEN ("screen.ready", …)
// reportFrame() = the payload's `frame` (native), nil for the frameless web relay
```

- `surface.domStart` / `surface.viewStart` → phase `loading`, fire `screen.loading`.
- `surface.domFinish` / `surface.viewFinish` → phase `ready`, fire `screen.ready`.
- `surface.domFail` → **same as `surface.domFinish`** — a failed load is settled, so indicators that hide on ready
  hide here too (no stuck spinner on a failed page). There is deliberately **no `viewFail`**: a
  native frame *always* settles, so it has no "terminated without finishing" case (a native
  screen's failure is a value on the error plane, `dsx.error` — never a lifecycle phase).

Three properties make this safe, and all three are pinned by
[`Conformance/lifecycle/phase.json`](../../Conformance/lifecycle/phase.json):

- **The app-surface guard.** A report is translated only when its `surface` is the **app** surface
  — `"web"` (the composed app web view) or `"native"` (a DSX-rendered frame). Any other tag is a
  bare embedded `<WebView/>` named by its own node, and is **dropped**, so a video page loading
  inside an embedded player can never flip the app's spinner/splash/analytics. An **untagged**
  payload counts as the app surface (fail-open, Article 7).
- **The route string.** The re-fired `screen.*` input is a plain string: `url` when present, else
  `path` (a native frame carries a route path, not a URL), else the input itself when it is already
  a string, else `null`. The web contract is byte-identical to before the native reporter landed.
- **Stateless and level-triggered.** The coordinator never dedupes, never orders, never remembers.
  De-duplication is the **reporter's** job.

The native surface fires the **same** `screen.*` through the same coordinator — and
**no consumer module changed** when it landed.

---

## Where the web surface's `dom*` comes from (the relay)

`DSXWebDelegate` (owned by the Dom module) is the `WKNavigationDelegate`. It fires the kernel
lifecycle events from the `WKWebView` callbacks, reaching the bus **only through its bound `dsx`**
(Dom binds it) — it names no module:

| `WKNavigationDelegate` callback | Fires |
|---|---|
| `didStartProvisionalNavigation` | `dsx.delegate.send("surface.domStart", url, combine: .void)` |
| `didCommit` | `dsx.runHydrations(on:)` then `dsx.delegate.send("surface.domCommit", url, combine: .void)` |
| `didFinish` | `dsx.runReady(on:)` then `dsx.delegate.send("surface.domFinish", url, combine: .void)` + `dsx.delegate.send("web.didLoad", url, combine: .void)` |
| `didFail` / `didFailProvisionalNavigation` | `dsx.delegate.send("surface.domFail", { url, error[, provisional] }, combine: .void)` |
| `webViewWebContentProcessDidTerminate` | `dsx.delegate.send("web.processTerminated", url, combine: .void)` |

`web.didLoad` and `web.processTerminated` are **web-private siblings** of the lifecycle (settled-page
SWR sync, crash-reload) — not part of the unified `screen.*`.

---

## The rule: `dom*` is the web surface's PRIVATE signal (and `view*` the native one)

**Only three kinds of code may hook `dom*` directly. Everything else hooks `screen.*`.**

1. the **`Lifecycle`** coordinator (translates `dom*` → `screen.*`);
2. the **Dom** module itself — it re-broadcasts `dom*` to the page so web code observes navigation
   via `despia.on("dom", …)` (`dsx.broadcast("start"/"commit"/"finish"/"fail", payload)` — a
   **structured** broadcast, never raw JS);
3. genuinely **web-DOM** modules whose behavior IS the web DOM:
   - **PushRouting** — gates push delivery on page-ready and uses `history.pushState`;
   - **SharedData** — gates its page injection on page-ready.

`view*` (`surface.viewStart` / `surface.viewFinish`) is the **native** surface's private signal and obeys the same
rule with a shorter list: **only the `Lifecycle` coordinator hooks it.** Nothing re-broadcasts it
(there is no page to re-broadcast to) and no behavior module has any business hooking it.

If you find yourself reaching for `surface.domFinish` in a behavior module, that is the smell the shell
model removes: hook `screen.ready` instead, and your module immediately works on `DSXView` too.

---

## Consumers today (all on `screen.*`)

| Module | Hooks | What it does |
|---|---|---|
| **Spinner** (`Core/Basics/Spinner`) | `screen.loading` / `screen.ready` | Owns the load-indicator **decision** and publishes it as `global.ui.loading` (pure state — no UIKit, no web view). |
| **Splash** (`Mandatory/Splash`) | `screen.ready` | Reveals (fades out) the in-load splash once the screen settles. |
| **Engagement** (`Core/Engagement`) | `screen.ready` | ~0.5s after the first settle (once/session): rate-app / FB-follow / first-run prompts, presented from `topViewController()`. |
| **ScreenShield** (`Core/ScreenShield`) | `screen.ready` | Arms screenshot/recording protection once (`protect(view:)` needs the view on screen) + OS capture observers. |
| **PostHog** (`Core/PostHog`) | `screen.loading` | Refreshes the tracked page path from the route `input` on each navigation. |

---

## The load indicator: decision (module) vs pixels (render layer)

This is the canonical example of how a module shows UI **without ever touching the web view** — the
pattern every native overlay should follow.

1. **Decision → state.** `Spinner` is pure state. On `screen.loading` it applies the host's old
   gating (a load indicator is configured **and** (a subsequent load under a persistent splash, **or**
   no splash, **or** an auth round-trip is in progress — the *first* load belongs to the splash)) and
   on `screen.ready` it hides. The only output is:

   ```swift
   dsx.global.set("ui.loading", on)   // no UIKit, no WKWebView
   ```

2. **Pixels → DSX render layer.** The kernel surface `RouterHost` draws the **native** indicator as
   chrome — an overlay above whatever frame is showing (DSXWebView **or** DSXView):

   ```swift
   .overlay { LoadingIndicator(showing: (global.getPath("ui.loading") as? Bool) ?? false) }
   ```

   `LoadingIndicator` (`OpenSource/Engine/iOS/LoadingIndicator.swift`) is a SwiftUI view: a top linear bar when
   `useLoadingProgressBar`, else a centered circular spinner; tint = `loadingIndicatorColor` (app
   config). Because it renders on `RouterHost` above the frame stack, it is correct on web and native
   with one implementation.

**The principle:** a module owns the *decision* as global state; the DSX render layer owns the
*pixels*. No spinner, banner, or overlay needs direct web-view access.

---

## The native (`DSXView`) reporter <a id="native-reporter"></a>

The lifecycle is surface-agnostic **at runtime**, not just structurally: a native screen reports its
own readiness, so the whole `screen.*` flow runs with **no web view involved**. On a host-less
native app these are the only reports there are — before this existed, `screen.ready` never fired
there at all, so the splash never revealed, `ScreenShield` never armed, `Engagement` never ran and
`PostHog` recorded no route.

**Zero consumer modules changed when it landed.** That is the proof the model was right.

### The events

| Surface | Private signals | Payload |
|---|---|---|
| web (`DSXWebView`) | `surface.domStart` · `surface.domFinish` · `surface.domFail` | `{ url, surface }` |
| native (`DSXView`, any DSX-rendered frame) | `surface.viewStart` · `surface.viewFinish` | `{ path, surface: "native", frame }` |

`frame` is the Router's `nav.stack` frame id — one live record per frame, so a pushed screen, the
screen underneath it and a re-entered screen are all distinct instances.

### The authoring surface: default settle, opt-in defer

| Spelling | Plane | Semantics |
|---|---|---|
| *(nothing — the default)* | — | **auto**: the frame settles on its **first completed render pass** |
| `settle="manual"` | root-element attribute, **root only** (the slot `exit` occupies) | this screen reports readiness itself |
| `dsx.screen.settled()` | JSE verb — any handler, `<action>`, `<script>` | "this screen has settled" — settles the frame, once |

```xml
<!-- Orders.dsx — must not claim readiness until its data has landed -->
<stack settle="manual">
  <head>
    <api as="orders" url="/api/orders" on:success="dsx.screen.settled()"
                                       on:error="dsx.screen.settled()"/>
  </head>
  …
</stack>
```

`settle` is the word this document already uses for the concept, so nothing foreign is introduced.
`dsx.screen.settled()` is a **call**; `dsx.screen.ready` (Bool) and `dsx.screen.phase` (String) stay
read-only reactive **properties** — a call and a property never share a spelling. Authoring detail
lives in [`StackReference.md`](./StackReference.md#screen-readiness).

### The state machine

One record per **live frame id**. Nine inputs, and the machine — never the call site — decides when
the events fire. That single funnel *is* the once-per-frame guarantee:

| Input | When |
|---|---|
| `mount(frame, path, surface)` | a frame entered the stack → `surface.viewStart` (and arms its deadline) |
| `manual(frame)` | its root declared `settle="manual"` (registered while hoisting the head) |
| `hostsWeb(frame)` | it mounted a `<DSXWebView/>` app web surface (registered by the component) |
| `rendered(frame)` | it completed its FIRST render pass → `surface.viewFinish` when auto |
| `settled(frame)` | `dsx.screen.settled()` → `surface.viewFinish` |
| `deadline(frame)` | its bounded settle deadline elapsed → `surface.viewFinish` (fail-open) |
| `release(frame)` | the frame left the stack (drops the record) |
| `webStart()` | the app web surface began loading (the relay's `surface.domStart`) |
| `webSettled()` | the app web surface settled (`surface.domFinish` / `surface.domFail`) → `surface.viewFinish` for gated frames |

The laws (every one a row in
[`Conformance/lifecycle/readiness.json`](../../Conformance/lifecycle/readiness.json)):

1. **Native only.** A `mount` whose `surface` is not `"native"` is ignored outright — a `DSXWebView`
   frame reports through `dom*`, so a hybrid app never double-reports.
2. **One `surface.viewStart` per frame INSTANCE.** `mount` is idempotent while the record lives (SwiftUI
   re-fires `onAppear` when a covered screen resurfaces); a `release` + re-`mount` of the same id is
   a new instance and starts a fresh cycle.
3. **Auto settles on `rendered`.** Manual does not, and neither does a frame hosting a web surface.
4. **At most one `surface.viewFinish` per instance.** Later `rendered` / `settled` / `manual` / `hostsWeb` /
   `deadline` inputs are no-ops, so a re-render or a chatty screen can never re-fire.
5. **An explicit `settled` always wins** — it settles an auto frame early and clears a pending
   `manual` *and* a pending `hostsWeb` gate.
6. **Released-before-settled never settles.** No `surface.viewFinish` after the screen is gone; an input for
   an unknown frame is a silent no-op (Article 7, fail-open).
7. **A frame hosting a web surface waits for it.** See *Hybrid ordering* below.
8. **Nothing waits forever.** See *The bounded deadline* below.

### Hybrid ordering — a native frame that hosts `<DSXWebView/>`

A frame whose root is DSX markup is **native**, so it reports `view*` — even when its body mounts
the app's web view. Left alone it would settle on its **first render**, which is the moment the web
view is still *blank*: the splash would reveal over nothing and the page's own `surface.domStart` would
re-open `screen.loading` a beat later.

So `<DSXWebView/>` registers `hostsWeb` for its frame the instant it renders, exactly the way an
authored root registers `settle="manual"`, and the surface's own settle (`surface.domFinish` **or**
`surface.domFail` — a failed load is settled) releases it. **This is not an opt-in**: unchanged markup gets
the right order, because a wrong order here is a regression, not a missing feature.

Two details keep it honest:

- `webSettled` **latches**. A frame that mounts while the page is *already* up does not wait for a
  load that will never come; `webStart` re-arms the latch for the next navigation.
- A root that declared `settle="manual"` **keeps ownership**. The page settling never settles it —
  the author asked for the frame, so the author's `dsx.screen.settled()` ends it.

### The bounded deadline — nothing hangs the shell

Every tracked frame carries a settle **deadline** (`settleDeadlineMs`, corpus-pinned at 10 s and
identical on all three renderers). It is armed by the machine at `mount` and cancelled the moment
the frame settles or is released; if it elapses, the frame settles **anyway**.

This is the framework's fail-open instinct (Article 7) applied to the phase itself. Without it a
`settle="manual"` screen that never calls `dsx.screen.settled()` — or a hosted page that never
loads — would pin `global.screen.phase` at `"loading"` **forever**: the splash never reveals, the
spinner never clears, `Engagement` never runs. On a hybrid app it would freeze the **web** surface's
consumers too, since there is ONE shared phase. A late reveal is a degraded screen; a permanent
spinner is a dead app.

The deadline is a backstop, not a schedule. The authoring mistake it covers is caught at build time:
`lint_dsx.rb` **errors** on a root that declares `settle="manual"` in a file containing no literal
`dsx.screen.settled()`.

### The renderer's obligation

Not expressible as a fixture row, so each renderer carries it in code and in comments:

- `manual` must be registered during the frame's **first render pass** — trivially satisfiable,
  since `settle` is a root attribute known the moment the root node is read;
- `rendered` must be reported on a turn **strictly after** that pass completes. iOS hops it to the
  next main-queue turn from `onAppear`; the web renderer hops it to a microtask after
  `instantiate()`. Reporting `rendered` synchronously inside the first pass would settle every
  deferred screen while it is still blank.
- `release` must fire only when the frame is **permanently** gone, never when it is merely covered.
  iOS uses the frame surface's `deinit` (a `@StateObject` outlives a push/sheet), *not*
  `onDisappear` — releasing on cover would replay the whole cycle on the way back, i.e. a phantom
  `screen.loading` on every pop.

`<DSXView/>` itself is an async loader: it paints a `ProgressView` on its first pass, so it
registers `manual` for its frame **at construction** and reports `settled` on **both** its ready and
failed outcomes — a failed screen is still settled, so there is no stuck spinner, and a remote
native screen never settles while blank.

Off a navigation frame — a mounted overlay, a bare `dsx.render` surface, a satellite (watch) screen
— there is no frame id, and `dsx.screen.settled()` is a documented silent no-op.

### Known sharp edge

A `settle="manual"` screen that **never** calls `dsx.screen.settled()` leaves the shell `loading`
forever (a permanent spinner). This is authored behavior, not a kernel bug — exactly how a web page
that never finishes loading behaves — so always settle on the failure path too.

---

## End-to-end flow (a web navigation)

```
WKWebView didStartProvisionalNavigation
        │
        ▼
DSXWebDelegate ──dsx.delegate.send("surface.domStart", url, combine: .void)──►  ┌─────────────┐
                                               │  Lifecycle  │ set screen.phase="loading", screen.ready=false
                                               │ coordinator │ dsx.delegate.send("screen.loading", url, combine: .void)
                                               └─────────────┘
                                                      │
                       ┌──────────────────────────────┼───────────────────────────────┐
                       ▼                               ▼                                ▼
                 Spinner.show?               PostHog.refreshPath(url)         (Dom) broadcast "start" → despia.on("dom")
                 → ui.loading=true
                       │
                       ▼
                 RouterHost overlay → native LoadingIndicator over the frame

WKWebView didFinish (or didFail)
        │
        ▼
DSXWebDelegate ──dsx.delegate.send("surface.domFinish"/"surface.domFail")──► Lifecycle: screen.phase="ready", screen.ready=true
                                                     dsx.delegate.send("screen.ready", …, combine: .void)
                                                      │
                       ┌──────────────┬───────────────┼───────────────┬──────────────┐
                       ▼              ▼               ▼               ▼              ▼
                 Spinner.hide   Splash.reveal   ScreenShield.arm  Engagement     (Dom) broadcast
                 → ui.loading=false             (protect top.view) (0.5s prompts)  "finish"/"fail"
```

## End-to-end flow (a native navigation)

Same right-hand side — the consumers cannot tell the difference. Only the reporter changes.

```
a native frame enters nav.stack
        │
        ▼
DSXScreenReadiness.mount(frame, path, "native")
        │
        ├── root declared settle="manual"?  →  manual(frame)   (defer)
        │
        └──dsx.delegate.send("surface.viewStart", {path, surface:"native", frame}, combine: .void)──►  ┌─────────────┐
                                                                      │  Lifecycle  │ screen.phase="loading"
                                                                      │ coordinator │ fire screen.loading(path)
                                                                      └─────────────┘
                                                                             │
                                                        Spinner.show? · PostHog.refreshPath(path)

auto:    first render pass completes  →  rendered(frame)
manual:  dsx.screen.settled()         →  settled(frame)      (a <DSXView/> reports both outcomes)
        │
        ▼
DSXScreenReadiness ──dsx.delegate.send("surface.viewFinish", {…}, combine: .void)──► Lifecycle: screen.phase="ready", screen.ready=true
   (once per frame instance)                         dsx.delegate.send("screen.ready", path, combine: .void)
                                                             │
                          ┌──────────────┬───────────────────┼───────────────┐
                          ▼              ▼                   ▼               ▼
                    Spinner.hide   Splash.reveal      ScreenShield.arm   Engagement

frame permanently leaves the stack  →  release(frame)   (no late surface.viewFinish; a re-mount is a new instance)
```

---

## Cheat-sheet

```
behavior module, "after the screen loads"    → dsx.delegate.listen("screen.ready")     (works on web AND native)
behavior module, "while/at the start of a load" → dsx.delegate.listen("screen.loading")
reactive markup needs the current phase      → dsx.screen.ready / dsx.screen.phase   (global.screen.*)
a load/progress indicator                    → set global.ui.loading; RouterHost renders it natively

── authoring a NATIVE screen ─────────────────────────────────────────────────────────────
ordinary screen, settles when it renders     → nothing to write (settle="auto" is the default)
screen that must wait for its data           → <stack settle="manual"> on the ROOT
…and then, on every path incl. failure       → dsx.screen.settled()        (once; extra calls no-op)
NEVER                                        → dsx.screen.ready = …        (read-only property)

── the private planes (don't hook these from a behavior module) ──────────────────────────
genuinely web-DOM behavior (pushState, injection) → hook dom* directly  (the documented exception)
the native reporter's view* signals           → Lifecycle ONLY — no exceptions
observe navigation from web code             → despia.on("dom", …)        (Dom's re-broadcast)
```
