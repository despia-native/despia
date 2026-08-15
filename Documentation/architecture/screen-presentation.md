# ADR — Screen presentation & package navigation

**Status:** Accepted — **implemented** (the presentation verbs, the state-backed modal tier, frame
name+vars, and the route guard all landed in the kernel; Android parity landed 2026-07-28 — the
full Compose RouterHost renders the same state with push/pop transitions + predictive back, see
*Consequences* §7). Compile-pending: the Swift rides the Codemagic build (no local toolchain).
**Deciders:** DSX architecture. **Validated:** web research across SwiftUI / Jetpack Compose /
React Navigation / Flutter, plus componentization + API-design best practices, adversarially checked
against this codebase (2026-07).

## Context

A package (VerticalPlayer, StudioEditor, a test harness) owns **components**, and sometimes wants to
open one as a **native screen** (interactive swipe-back) or a **drawer/sheet**. Two wrong turns are
tempting:

1. **Expose package screens as global routes** (put `/@pkg/screen` in the route table). Tried in a
   now-reverted commit. It leaks a package's *internal* screens into a globally-addressable namespace
   and drags the OTA/signing/merge machinery into something that should never leave the package.
   Rejected — it violates information hiding (Parnas 1972); go_router confirms imperatively-pushed
   screens are *deliberately* not URL-addressable (Bizzotto, *Go vs Push*).
2. **Present imperatively as a fire-and-forget UIKit side-effect.** `StackSurface.present()`/`dismiss()`
   call `presenter.present`/`controller.dismiss` directly with no state (`Stack.swift`
   `StackSurface.present(from:)`/`dismiss`). Our
   own `mounting-components.md` (81–97) already documents the failure: *"present silently does nothing…
   `dsx.resolve` still fires — web logs 'opened' but no screen appears."* That is the exact
   two-sources-of-truth desync Jetpack **Navigation 3** was built to kill.

The industry consensus is one rule: **an imperative navigation verb is acceptable if, and only if, it
mutates developer-inspectable state that the render tree is a pure function of** — SwiftUI
`NavigationStack(path:)`, Compose Nav3 "you own the back stack", Point-Free's state-driven navigation
("fire-and-forget is the original sin"), fatbobman ("argument-less `dismiss()` is a testability/stability
risk"). Our **push** path already does this; our **present** path does not yet.

## Decision

### Two tiers, kept separate

| | **App routes** | **Package screens** |
|---|---|---|
| Owner | the app author (user) | the package |
| Where | `App.json` / OTA `routes.json` | the package's own components |
| Addressed by | a path (`/shop/{id}`), deep-linkable | **never a path** — opened via the package's **action** |
| Public API | the route table | `dsx.module.<pkg>.<action>()` |
| Restorable | yes (serializable route + params) | no — **ephemeral by contract** |

A package's **public contract is its actions** (Article 2/3 — `dsx.module.<scheme>.<action>()`, same
name on every surface). An action *internally* opens the package's own component as a frame. Outsiders
never name a package's screens.

### Presentation verbs — both are state mutations

The kernel `route` namespace owns the observable nav state. Presentation is sugar over it:

```
dsx.component.push(name, { attrs })                        // → appends {ref, attrs, as:"screen"} to global.nav.stack
                                                           //   interactive swipe-back; enters OS back history
dsx.component.present(name, { as:"sheet"|"overlay"|"cover", attrs })
                                                           // → flips an entry in observable global.nav.modal
dsx.component.update([ target ], { attrs })                // → merges into the open entry's attrs (deepest-last
                                                           //   match; top when untargeted; unmatched = no-op) AND
                                                           //   re-seeds the live surface — bindings recalc,
                                                           //   <attribute on:change> fires
dsx.component.dismiss([ target ])                          // default: pop the TOP of the presentation stack;
                                                           //   dismiss(ref) / dismiss(as:"overlay") targets one
```

- `name` resolves in the **caller's scope** (package-local component first) — so a package pushes *its
  own* `Canvas` with no qualifier; a qualified `"other.Screen"` targets another package.
- **`attrs` is the component INPUT CONTRACT** — the exact attributes a hard-coded `<Tag …/>`
  invocation would carry, seeding the component's declared `<attribute>`s (reactive
  `dsx.attribute.*`; passed beats `default=`). The mounting side sets declared inputs and never
  reaches internal state; `update` is the live half of the same contract. `vars` remains as the
  legacy store-seed channel (`vars.*`) for un-migrated callers.
- **No platform presenter crosses the API** (no `UIViewController`/`Activity`) — the kernel finds the
  host. This is Google's explicit rule (*Navigation with Compose*: "don't pass the navController; pass
  callbacks") and is what makes navigation unit-testable.
- **Push is already state-backed** (`Router.swift` `Router.push`/`pushNative`; `RouterHost.swift` 131–156): `route.push`
  mutates `global.nav.stack` (+ `nav.canPop` / `nav.depth`), and the host re-derives the SwiftUI
  `NavigationStack` from it. `dsx.component.push` is the markup-callable wrapper over that path.
- **Present MUST become state-backed** the same way: mirror modals into an observable `global.nav.modal`
  key a host renders (reuse the mechanism `<sheet present="key">` already ships — `Sheet.swift` 35–68),
  so `resolve()` can never report "opened" while nothing is on screen.

### Typed-native, string-wire

The 1:1 wire form is `("Name", { as, vars })` — required because the kernel **names nobody** (dynamic
resolution) and the JSON must cross to web/Kotlin unchanged. But the **promoted native idiom is typed**:

```swift
dsx.component.push(.store.PaywallHero, as: .screen, vars: TypedPayload(…))   // compile-checked ComponentRef + StackMount enum
```
```xml
<row on:tap="dsx.component.push('Canvas')"/>                                  <!-- markup: the portable string form -->
```
Nav-Compose 2.8 / go_router made the typed destination canonical and the string the legacy escape hatch;
we mirror that. The string+map form is the explicitly-labeled portable lowest-common-denominator, not
the recommended idiom on a typed surface.

### Invariants (do not weaken — the strongest, most on-consensus decisions)

- **Kernel names nobody** (Article 1) — presentation resolves a component from a registry in the
  caller's scope; the engine hardcodes no package.
- **Bounded, total expression engine** — guards/predicates are JSE (terminating, not Turing-complete);
  remote content can't hang the UI.
- **Fail-open** (Article 7) — an unmatched route resolves to `entry.fallback`; a missing module degrades.
- **`attrs`/`vars` are serializable** — closures / live objects are stripped or warned; only
  serializable state seeds a frame, so a frame can (if the app wants) be restored via an App.json route.
- **`attrs` = the markup attribute contract, exactly** — mounting a component passes the same inputs
  a hard-coded tag would; `update` merges by target (deepest-last; top untargeted; unmatched no-op)
  and MUST both rewrite the entry (restore truth) and re-seed the live surface (reactivity +
  `on:change`). The mounting side never writes a component's internal variables.
- **Package screens are ephemeral by contract** — not restored across process death; re-entered via
  their package action (the accepted go_router-pageless / RN-modal / `showDialog` lane). App-level
  restoration stays the route table's job.

## Consequences

**Landed in this change (the kernel — `OpenSource/Engine/`):**
1. ✅ **`global.nav.modal` observable key + a host that renders it.** The Router owns a `modal` stack
   published by `apply()`; `RouterHost` renders three containers off it — `sheet`/`cover` as a NESTED
   presentation chain (each `ModalFrame` re-presents the next-deeper entry from within itself, never a
   live item-identity swap), and `overlay` as a pure-state passthrough layer (`ModalOverlayLayer`, no
   UIKit presentation — it cannot silently fail). An interactive swipe-away reports back to the Router
   by entry IDENTITY (`hostDismissedModal(id:)`, idempotent against SwiftUI's nil write-backs);
   dismissal is topology-aware (a chain entry takes its presentation descendants; an overlay takes only
   itself). The public verb story has **no fire-and-forget present** — the legacy UIKit
   `StackSurface.present(from:)` stays only for the payment/ad/AR modules that still use it directly.
2. ✅ **Component name + serializable `vars` on the observable stack entry.** `pushNative` stamps
   `component` + `vars`; a test can assert "action X pushed frame `component` with `vars`" without a host.
3. ✅ **The markup/bus verb `dsx.component.push/present/dismiss`** — native (`ComponentAPI`), markup
   (`runJSStatement` → `Router.shared`), and web (`route.pushComponent`/`presentComponent`/`dismiss`
   actions, reachable as `window.dsx.route.*`). `push` reuses the proven state-backed push path.
4. ✅ **`dismiss([target])`** — default pops the top of the presentation stack; a component-tag / `as:`
   target removes one; dismiss-when-empty is a documented no-op.
5. ✅ **`push` (navigate) vs `present` (modal) read as distinct verbs** — done by *splitting* the public
   verb (not renaming the internal methods that shipping modules depend on): `push` → a `nav.stack`
   frame, `present` → a `nav.modal` modal.
6. ✅ **Declarative `guard`/`redirect` on a route entry** — `Router.resolved` evaluates a bounded, pure
   JSE predicate over `global.*` / `route.*`; a falsy guard redirects (depth-capped, fail-open), so
   resolution is total over (URL × app-state). Matches go_router `redirect` / React Router loaders.

**Cross-platform parity (LANDED):**
7. ✅ **Android inherits push/pop motion + predictive back (2026-07-28).** The Nav3 *principle* —
   "you own the back stack" — is satisfied by our own state, not the Nav3 library: `global.nav.stack`
   IS the developer-owned back stack, and the full Compose `RouterHost`
   (`OpenSource/Engine/Android/render/.../RouterHost.kt`) renders it with the screen-presentation
   motion (slide-in-from-trailing on push, the reverse on pop; curves derived from the DECLARED
   StackMotion default — easeInOut 0.35s — plus the repo-pinned iOS-family under-screen figures,
   −20% parallax / 0.1 dim) and the Android 14+ predictive-back contract (`PredictiveBackHandler`:
   the previous screen renders beneath the outgoing one during the gesture, cancellable; commit
   finishes the exit then pops the Router with the visual already played; pre-predictive API levels
   get a plain pop with the pop transition). Covered screens now keep per-frame retained stores
   (the iOS `FrameSurface` contract). *Earlier progress (2026-07-15):* `RouterActions` put the route
   action table on the Android bus, `RouterChromeHost` (:render) rendered `global.nav.chrome` as the
   platform bar (`<NavBar system="true">` from the same markup on all three renderers); system BACK
   has since moved from the chrome host into `RouterHost`'s predictive handler (the peek needs the
   frames). Honest divergences (iOS edge behaviors Compose can't twin) are pinned in the
   RouterHost.kt header — system-owned gesture arming (both edges, no leading-edge-only pan, no
   `suppressInteractivePop` twin), instant swap for replace/reset, the single-app-WebView
   transition guard, and the chrome bar swapping at transition start.

**Docs updated:** `mounting-components.md` gained the modern-verb section + a "what survives a cold
start" table.

## Planes & overlay touch modes (landed 2026-07-15 — the completeness pass)

The presentation machine is CLOSED over two primitives — **screen** (`dsx.component.push`, a
native nav frame) and **presented modal** (`dsx.component.present`) — with the modal's `as`
picking the container and, for overlays, `touch` picking the hit-test contract:

| | renders | takes touches | plane |
|---|---|---|---|
| `push` (screen) | a native nav frame | everywhere (it IS the screen) | content stack |
| `present as:"sheet"` | the detented drawer | inside the sheet; scrim/edge dismisses | chain |
| `present as:"cover"` | full-screen modal | everywhere | chain |
| `present as:"overlay", touch:"passthrough"` | a layer over the screen | ONLY its drawn/interactive content — everything else reaches the screen beneath (the glass menu-bar-over-web shape) | overlay |
| `present as:"overlay", touch:"block"` | a layer over the screen | everywhere — nothing reaches beneath (the lock-screen shape, visuals can stay transparent) | overlay |

**THE PLANES (the z mental model, all three renderers):** content stack < overlay plane
(presentation order within it) < chain plane (sheets/covers, presentation order, nested) <
system (OS alerts). A drawer therefore ALWAYS opens above a menu-bar overlay — plane beats
presentation order; there is no numeric z-index in the API, on purpose. Normalization +
dismissal topology are corpus-pinned fixtures-first (`OpenSource/Conformance/router/present.json`
— Kotlin executes it end-to-end, the web `PresentLedger` runs the same file, Swift is the
reference). Unknown `as` fails open to sheet; unknown `touch` to passthrough; overlays dismiss
alone; a chain dismissal takes its chain descendants and spares overlays. Web tiers: page
frames z 10+ < overlay plane 500 < chain frames 1000+ (pointer-events express the touch modes).

## The attribute contract (landed 2026-07-15 — `attrs` are THE component input)

Mounting a component takes the **same inputs as writing its tag**: `push`/`present` accept
`attrs`, an object whose keys are the component's declared `<attribute>`s — `<Paywall
plan="pro"/>` and `push('Paywall', { attrs: { plan: 'pro' } })` are one contract, static vs
dynamic. Attrs seed the reactive `dsx.attribute.*` dict (passed beats `default=`; reads
re-derive on change), ride the nav entry verbatim (restore truth), and the new
**`dsx.component.update([target], { attrs })`** verb is the live half: it merges into the
deepest-last matching entry (top when untargeted; unmatched target = documented no-op) AND
re-seeds the live surface, so bindings recalc and the declaration's `on:change` fires (the
`attributeChangedCallback` analogue). The component reacts to input changes with its own head
logic; the mounting side never writes internal variables — that boundary is the point.
`vars` stays as the legacy store-seed channel (`vars.*`) for un-migrated callers; new code
passes `attrs`. Pinned in `present.json` (attrs-ride-verbatim, update-merge, update-top,
update-no-op cases); migrated exemplars: LicenseCheck (both platforms — `License.dsx` reads
`dsx.attribute.title/message/button`) and the Demo launcher (five `<attribute
as="avail_*"/>` declarations replacing the `expects vars` seed).

**Migration state (audit 2026-07-15, MenuBar landed 2026-07-17):** LicenseCheck now presents its
blocked screen as a state-backed cover on BOTH platforms (iOS migrated to match its Android twin).
Already state-backed: Godot / Scene3D / StudioEditor / VerticalPlayerStack pushes — the §1 "AR"
part of the fire-and-forget carve-out is stale; only payment (Store/Stripe/RevenueCat) and ad
(AdMob) presents remain deliberately legacy. **MenuBar is MIGRATED on both platforms** (the exact
staged shape): bar → `present(as:"overlay", touch:"passthrough")` via the module's `Bar` layer
(bottom-pinned `<MenuBar/>`), sidebar → `present(as:"overlay", touch:"block")` — an overlay, not
the staged cover, because a cover paints the opaque theme background while the sidebar's scrim
must dim the LIVE screen. Its two open contracts resolved without new machinery: (1) presented
events — iOS keeps the module-built surface (`mount` + `surface.presentModal`, so `ui.on` stays
wired); Android's registered `<MenuBar/>` builder captures its module, and Sidebar markup rides
the existing `dsx.on("dsx")` publishNative bridge; (2) seeding — BOTH platforms ride the
presented entry's `vars` seed (iOS `presentModal(vars:)`, Android `presentComponent(vars:)` —
the old iOS-only top-level pre-seed is gone), read through the component's seed chain
(attrs prop → top-level store write → `vars.*` → head initials) and bridged in markup by head
`<variable>` initials over `vars.*` (Bar.dsx / MenuBarComponent.swift pin the chain). Supporting fix: the Kotlin registry's resolve now handles
QUALIFIED tags (`menubar.Bar`, `demo.Launcher` — the Stack.swift dot branch), which the
scope-less Router-presented/pushed envs require (`ComponentResolveTest`). DevSettings'
drawer/badge window and the decorative strips (StatusBar/BottomBar/Toast) stay deliberate
exceptions. The bar overlaying EVERY surface (web + pushed native screens) is the demo's
Chrome page proof.

## References

- Code: `OpenSource/Engine/iOS/Router.swift`, `RouterHost.swift`, `Stack.swift`
  (`StackSurface.present(from:)`/`dismiss`/`push(from:)`), `Foundation/Components/Structure/Sheet/Sheet.swift`, `OpenSource/Skills/mounting-components.md`
  (81–97, 181–184), `OpenSource/Skills/lifecycle.md:50`.
- Practice: SwiftUI `NavigationStack(path:)` + state restoration (Apple); Jetpack **Navigation 3**
  "you own the back stack" (Android Developers Blog, 2025); type-safe Navigation-Compose 2.8 (Google);
  Point-Free *state-driven navigation*; fatbobman *Say Goodbye to dismiss*; go_router *redirect* / *Go vs
  Push* (Bizzotto); React Navigation serializable-state persistence; Parnas 1972 (information hiding).
- Framework laws: `OpenSource/Documentation/architecture/constitution.md` (Articles 1, 2, 3, 7, 8).
```
