# ADR — DSX router motion (web, landed) & chrome toolbar items (designed)

**Status:** Part A **landed** (`@despia/dom` motion.ts + router.ts, opt-in via `registry.router`).
Part B **accepted design, implementation staged** (fixtures first — see the landing sequence).
**Deciders:** DSX architecture. **Grounding:** a deep-research pass over Framework7 v8 source/docs
(page-transitions CSS, the swipe-back module, master-detail, browser-history), Apple platform
conventions (iOS 26 toolbars / large-title condensing), Material 3 top-app-bar conventions
(2026-07-15; the F7 claims below were adversarially verified against the framework7-io/framework7
sources).

## Part A — router motion on web (LANDED)

PWAs deserve clear spatial routing through an opt-in, neutral DSX Web family that leaves DSX
markup and the dsx API byte-identical, renders server-delivered direct routes
with zero DOM noise, and behaves like a *web app* (not a phone) at desktop widths. Framework7 is
useful research for the compatibility lane; DSX's default takes mechanics, not its visual identity.

**What the research verified in F7 (and what remains in the explicit `ios` compatibility
family; the neutral `dsx` family does not use this decoration):**

| F7 (verified) | Ours |
|---|---|
| Pages are absolutely-positioned full-size siblings in an overflow-hidden container; previous page rests at `translate3d(-20%,0,0)`, next enters from `100%` | Same geometry (`.dsx-frame` was already absolute/inset-0); covered page rests at −20% via inline style |
| Outgoing page dims under a black overlay peaking at 0.1; incoming page carries a 16px edge shadow strip | Same figures — a real overlay div (WAAPI can't reach pseudo-elements) + a `::before` 16px gradient strip |
| Class-swap CSS animations, duration via `--f7-page-transition-duration` | WAAPI (`element.animate`) — cancellable mid-flight for the gesture, no `animationend` bookkeeping; iOS 400ms `cubic-bezier(.25,.1,.25,1)`, MD 300ms decelerate (F7 v8's MD is Material-You-generation; v9 reworked it — we pin our own MD figures) |
| Swipe-back: 30px edge active area (`iosSwipeBackActiveArea`), completes on a flick (<300ms **and** >10px) OR past half the width; previous page tracks at one-fifth of the drag from −20%; shadow/opacity independently disableable | 30px edge, 6px engage slop; completes past **half the width** OR a flick (<300ms **and >24px** — F7's 10px pops on accidental grazes; one pinned divergence); same one-fifth parallax; completed swipes ride the SAME history path as Back with the visual already played |
| A completed F7 swipe reclassifies the DOM directly instead of an animated `router.back()` | Same idea, different mechanism: the pop is instant (skip flag), the gesture owned the animation |
| `masterDetailBreakpoint` (default 0 = off) + per-route `master: true`; the master pins in CSS (fixed width, transform pinned) while details animate; the gesture never fires in an active split | `masterDetailBreakpoint` default 960 when config present; route `master: true`; CSS-pinned master (`transform: none !important`); swipe disabled in the whole wide lane |
| `browserHistoryInitialMatch` exists for SSR deployments — the deep-linked page IS the initial page; initial-load animation off by default | THE SILENCE RULE, stronger and non-optional: motion is interactive-only — every boot-path mount (entry, SSR direct route, 404) renders before the router flips `interactive`, so a server-rendered URL replace-mounts instantly, always |
| Per-route `options.animate: false` and a per-route `transition` name | One per-route key: `motion: "none" \| "dsx" \| "ios" \| "md"` ("none" always wins; a family override applies only when the lane animates) |
| Router syncs `aria-hidden` with page positions | Same: covered frames leave the a11y tree; the top (and a pinned master) stay in it |
| F7 also ships `reloadCurrent`/`reloadAll`, `detailRoutes` master preloading for detail deep links | NOT taken this wave: `replace`/`reset` already cover the first two; master preloading on detail deep links is the one noted follow-up |

Config (`registry.router`, compiled from the app config — see `/web/04-routing.md` "DSX Web
motion"): `transition: "dsx"|"ios"|"md"|"auto"|"none"`, `swipeBack`, `masterDetailBreakpoint`,
`wide: "none"|"same"`. `prefers-reduced-motion: reduce` kills all motion. Policy/math are pure
and unit-tested (`packages/dom/test/motion.test.ts`). `auto` is UA-independent and resolves to
the neutral 160ms opacity-only crossfade. It never transforms layout, so controls and their
labels remain one visual unit through responsive reflow; `ios` and `md` are explicit
compatibility choices only.
The demo ships with `{ transition: "dsx" }`, so browser walks exercise the neutral engine
(including boot silence at deep links) on every PR.

**Constitution fit:** web-only renderer INFRASTRUCTURE (the unified-codebase law's exemption —
it renders the same files); nothing new is authorable from markup, the kernel names nobody, and
native motion stays each platform's own (NavigationStack / the K4 Compose RouterHost).

## Part B — chrome toolbar ITEMS + condensing (ACCEPTED, staged)

Screens that claim the system bar (`<NavBar system>`) need bar ACTIONS: a few visible buttons
that CONDENSE into the platform's overflow ("more") affordance — iOS 26's grouped Liquid Glass
toolbar items, Material 3's action icons + overflow menu, and the web bar's trailing icons + a
"⋯" menu. (Large-title condensing-on-scroll is already landed for free: the claim renders the
REAL system bar on iOS, and the system condenses large titles natively.)

Decisions (the parts that are settled):

1. **Items are claim DATA, not markup children.** `<NavBar title="Cart"
   items="[{ id, icon, label, prominent? }]" on:item="…"/>` → the claim carries
   `nav.chrome[frameId].items` (serializable, state-backed, pruned with the frame — the #1002
   shape). Icons are SF tokens resolved per platform via sf-map (adding one = the StackIcons
   recipe; FontSubsetTest gates the subset).
2. **One return path.** A host reports a tap as `route.chromeItem(frameId, id)` → the Router
   broadcasts ONE `chrome_item { frameId, id }` envelope on the `route` scheme → NavBar re-emits
   its `item` event with the id to the claiming screen. The exact markup subscription surface
   (the events plane vs a claim-held callback registry) is the ONE open design point — settled
   at implementation, fixtures first.
3. **The condense rule is a platform-neutral pure function, corpus-pinned** (the popto.json
   precedent): `OpenSource/Conformance/chrome-items/` cases map an item list → `{ visible,
   overflow }`. Android/web policy: at most 2 visible when items > 3, the rest behind overflow
   (the Material top-app-bar convention); iOS passes ALL items to the system toolbar and lets
   iOS 26's own grouping/overflow condense them (the system owns its bar — we never re-implement
   its policy).
4. **Renderers:** iOS — `FrameChrome` grows `ToolbarItem`s from the claim (system Liquid Glass
   grouping on 26, plain items below); Android — `RouterChromeBar` trailing action icons + an
   overflow menu hosted by the real Material 3 app bar (the RouterChrome precedent); web — the
   route module's bar gains trailing buttons + a "⋯" popover.

**Landing sequence (the unified-codebase law):** the `chrome-items` corpus → the web facet →
the Kotlin bar (gradle-gated) → the Swift `FrameChrome` (compile-pending, rides Codemagic) —
each consuming the SAME fixtures. Not started in this change; this ADR is the design of record.

## References

- Code (Part A): `OpenSource/Web/packages/dom/src/motion.ts` (policy/constants/CSS),
  `router.ts` (animations, gesture, split, silence rule), `packages/compiler/src/resolve.ts`
  (`Registry.router`, route `master`/`motion`), `/web/04-routing.md` (the doc of record),
  `packages/dom/test/motion.test.ts`.
- Chrome (landed prior): `OpenSource/Engine/iOS/RouterHost.swift` FrameChrome ·
  `Engine/Android/render/.../RouterChrome.kt` · `ClosedSource/DSX/Modules/Mandatory/Routing/web/index.js`.
- Research: deep-research run 2026-07-15 over framework7-io/framework7 (v8 sources: page
  transitions LESS/CSS, the swipe-back module, master-detail, browser-history params), F7 docs
  (view/router params, routes), Apple docs/WWDC25 (toolbars, Liquid Glass), m3.material.io
  (top app bar). Key verified figures are inlined in the Part A table.
- Framework laws: `constitution.md` Articles 1, 6, 7, 8; the unified-codebase law (monorepo working rules);
  `screen-presentation.md` (the presentation tiers this motion renders).

## Part C — shared element transitions (LANDED core, U03)

Tap a thumbnail, watch it grow into the photo. One attribute on both ends and nothing else:

```xml
<image src="{{ item.cover }}" shared="cover-{{ item.id }}"/>
```

`shared` is the match id (unique within a frame; a duplicate is a lint error, and at runtime the
FIRST occurrence in document order wins so the ambiguity cannot resolve differently per platform).
`sharedMode` is `move` (default) · `crossfade` · `clip`; `sharedAnim` inherits the frame's `anim`;
`sharedOrder` is the z-order among several pairs. One rule resolves all three: **the destination
declares, the source is the fallback, the frame is the floor.**

**The decision is one platform-neutral core, run by three renderers** — `OpenSource/Conformance/router/shared.json`
against `@despia/kernel` shared-transition.ts (per-PR), `:core` StackSharedTransition.kt (gradle)
and `Engine/iOS/StackSharedTransition.swift` (record lane). It owns three things and nothing else:

| | |
|---|---|
| **Matching** | which ids pair across the two frames, ordered by `sharedOrder` then destination document order; everything outside the intersection takes the ordinary frame transition, silently |
| **Schedule** | given a progress 0..1, the frame, corner radius, opacity, content mode and the two snapshots' cross-fade weights at that instant. `move` keeps the source for the whole flight and hands off over the final third; `clip` moves the frame without scaling the content |
| **Interruption** | the reversal state machine: an interruption ADOPTS the transition at its current progress, and the settle travels only what is left |

**Two failure modes are designed, not accidental.** An unmatched id is never an error. An
unrealised destination (a virtualised row, an image still loading) animates from the source
geometry TO the source geometry and cross-fades, because animating to the zero rect a
not-yet-laid-out node reports is what makes the naive implementation look like the image
collapsing into nothing.

**Reduced motion downgrades `move` to `crossfade`, with no author opt-out**, and accessibility
focus moves to the destination frame at transition START, so a screen-reader user is never
narrating a moving snapshot.

**Per renderer, and why each picked what it did:**

| | mechanism | why not the obvious one |
|---|---|---|
| web | a WAAPI FLIP over a `dsx-shared-plane` layer, driven by rAF or by the finger | `document.startViewTransition` hands the browser the whole animation and returns only `skipTransition()`; an interruptible lane driven by it SNAPS on a back-swipe |
| iOS | snapshot layers in a container over the router host, driven by a `CADisplayLink` and by the hosting controller's `UIViewControllerTransitionCoordinator` | `matchedGeometryEffect` gives SwiftUI the animation and no addressable progress; `UIView.animate` cannot be reversed mid-flight |
| Android | the REAL nodes posed with a `graphicsLayer` against their own measured rect, driven by the router's existing `coverage` Animatable and the predictive-back progress callbacks | Compose's shared-element API is not in this dependency set, and the manual lookahead placement keeps the behaviour pinned by the corpus rather than by whatever Compose does |

The acceptance test on all three is the same sentence: **an interactive back-swipe that starts at
40% of an in-flight push must reverse from 40%.** The corpus states it as a number — `maxStep`, the
largest single-step progress delta allowed inside the gesture window — because a snapping
implementation jumps the whole remaining distance the instant the finger lands.
