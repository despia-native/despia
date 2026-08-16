# The boot tier — modules before the first frame (`ModuleRegistry.boot()` + `boot.splash`)

> Status: **implemented and ON by default**. The boot tier is live and the splash is **two-phase**
> (see *The two-phase splash* below): **phase-1** is the engine-free UIKit `BootSplashView`, painted
> on the very first frame (the guaranteed instant frame — #802); **phase-2** is the fully-dynamic DSX
> `<Splash/>`, mounted by the Splash module's boot GATE and crossfaded over phase-1 once the engine
> is up (`splash.dsx_ui = true`). The storyboard `SplashscreenVC` remains the fail-open fallback (flag
> off / offline → byte-for-byte). The splash is also **optional** (`splash.present_splash = false` →
> straight to the entry surface — see *The entry-legos model*). The device gate below is the
> verification, not a flag flip.

## The problem

The splash screen is the first code-controlled frame, and the host **deliberately defers**
`bootstrap()` because module `setup()` side effects (PostHog init, HealthKit observer
restore, …) once ran ahead of the splash and delayed it (kernelization doc §4 — "the cost
being protected is module setup() side-effects, not the class walk"). Making the splash
**itself** a module inverts the dependency: module code must run *before* the first frame.
Early **full** bootstrap would reintroduce exactly the regression the deferral fixed.

## The resolution: a TIER, not an earlier bootstrap

`bootstrap()` splits into two phases with one shared class walk:

| Phase | When | What runs | Cost |
|---|---|---|---|
| `ModuleRegistry.boot()` | top of `didFinishLaunching`, synchronous | the class walk (sub-ms, bundle-filtered) · **all Stack component registration** (table inserts — no instances, so a boot-claimed DSX surface can render any shipped tag) · instantiation of **only** `bootEligible` modules | sub-ms + the boot modules' (contractually instant) setups |
| `bootstrap()` | the existing deferred point (and background wakeups, keystones — every existing call site unchanged) | `boot()` if it hasn't run, then the stashed non-boot modules — all the `setup()` side effects the splash is protected from | unchanged |

**The boot-tier contract** (`Package.bootEligible`): a boot-eligible module's `setup()` must
be *instant* — hook/action registration only; no SDK init, no I/O, no network. Real work
happens inside its hooks, only if it wins a claim.

**The boot-tier FIRST-FRAME contract** (the content a boot hook returns): a `boot.splash` (and
any boot-tier first frame) content MUST be **engine-free / instant UIKit**. It renders BEFORE
the Stack engine and `bootstrap()` come up, so its construction may NOT build a `StackSurface`,
parse `StackXML`, or otherwise touch the engine — doing so spins the Stack engine up on the main
thread for the *first time* and **blocks for seconds** while the host's solid-color placeholder
is frozen on screen (the "black-then-splash" launch regression: a dark placeholder, then a late
spinner, then the app). A boot first frame is a plain `UIViewController` drawing a color + a
loader (+ an optional `UIImage(named:)` logo) in pure UIKit, so `claim("boot.splash")` returns
instantly and paints on the very first frame. **Rich DSX splashes belong to the in-app
(post-boot) tier, not the boot tier** — once the engine and bootstrap are up, a screen may be a
full `<Splash/>`-style DSX surface; the boot frame may not.

We considered a separate `dsx.boot { }` registration surface; a *tier* keeps ONE hook/claim
system (the same `dsx.hook` / `claim()` everything else uses) — no parallel machinery,
and `claim("boot.splash")` is just another claim.

## The first consumer: the Splash module

`Packages/Mandatory/Splash/` — `bootEligible = true`, hooks **`boot.splash`**:

```
didFinishLaunching:
  ModuleRegistry.shared.boot()                                  // the tier
  if let splash = claim("boot.splash") as? BootSplash:           // module returns CONTENT only
      DSXBoot.installBootSplash(splash, in: window) { switchToMainAppFlow() }
        → kernel wraps splash.content in the appear-gated BootSplashController,
          holds it min_ms, and from viewDidAppear runs the host's continuation
    → Splash answers with BootSplash(content: BootSplashView, minMs)     // ENGINE-FREE UIKit
      (BootSplashView.swift — UIKit transcription of Components/Splash.dsx:
       background + the SplashBrand chain's brand image (logo / custom gif / the rounded app icon)
       + the #5719E0 spinner as the no-brand last resort, all from CoreConfig.splash)
    → flag off / offline app → storyboard SplashscreenVC, byte-for-byte
```

- **Flow control stays in the KERNEL, not the module**: a boot module supplies only its
  splash *content* + a minimum hold (`BootSplash`); it is NEVER handed the app-mount trigger.
  `DSXBoot.BootSplashController` owns the dangerous timing — it runs the host's continuation
  (`switchToMainAppFlow`, the root swap, including the DSX-first gate) ONLY from `viewDidAppear`,
  once the splash is actually in the window hierarchy. So a boot module **cannot** mount the
  app before the splash is on screen — the crash class (mounting the web view's
  `UIViewControllerRepresentable` mid-handoff → `EXC_BREAKPOINT`) is structurally impossible,
  for every boot module, not just Splash. (`SplashscreenVC` learned the same lesson the hard
  way and moved its own handoff into `viewDidAppear`; the kernel now enforces it for everyone.)
- **The boot frame is engine-free UIKit** (`BootSplashView`), NOT a DSX surface — see the
  first-frame contract above. It draws the splash background, then the **brand image**, resolved by
  the module's ONE brand chain (`SplashBrand.resolve`, shared by every splash surface): the static
  `splash.logo` imageset (synchronous `UIImage(named:)`), else a **custom per-app `splash.gif`**
  (detected by bytes — its SHA-256 differs from the committed placeholder's), else the
  **`splash.fallback_brand`** config: `"icon"` (the default) shows the **app's own icon** masked with
  the home-screen superellipse (22.37% continuous corners, always centered); `"gif"` shows the stock
  bundled splash.gif; `"none"` shows no brand. So an unbranded app's first frame is **its own icon**,
  never Despia's placeholder. `scale_image >= 100` lays a logo/gif **full-bleed** edge-to-edge
  (`.scaleAspectFill`, a per-app full-screen splash art), otherwise the brand is **centered** at
  `scale_image`% of the shorter screen edge (`.scaleAspectFit`). Resolution is synchronous (an
  `UIImage(named:)`, a ~100 KB hash, an ImageIO gif decode), so the brand costs nothing on the first
  frame. The `#5719E0` spinner (a centered `UIActivityIndicatorView` scaled ~2×, mirroring
  `<spinner color="#5719E0" scale="2"/>`) is a **last resort**: rendered ONLY when
  `splash.show_spinner == true` OR the brand chain resolved to nothing — so the default splash is a
  clean **instant brand splash with NO loader**. Spinner suppression is purely additive/config-gated —
  the instant first-frame guarantee (#802/#805) is unchanged. (The `<image asset="…">` DSX component —
  bundled image sets, synchronous, scaledToFit — is what phase-2 uses for the same logo; it is just
  not on the boot/phase-1 path.)
- **Background default**: `splash.background` empty → white (`SplashConfig.bootBackgroundHex`), the
  ONE default shared by the boot splash, the AppDelegate placeholder, and `LaunchScreen.storyboard`,
  so the OS pre-code frame, the placeholder, and the boot splash all paint the same colour — no flash.
- **scope guards**: `splash.present_splash` (false → NO splash; the claim returns nil and the host
  mounts the entry surface directly — see *The entry-legos model*); `splash.dsx_ui` (the **phase-2**
  switch — ON by default; false → instant-only phase-1, today's pre-phase-2 behavior, an instant
  rollback — see *The two-phase splash*); `onlyUseLocalServer` (the offline sync flow owns its boot
  sequence, so phase-2 is skipped). Biometric is no longer a splash concern — it's the AppLock
  module's launch GATE (`dsx.boot.gate`), which runs after the splash hands back via `DSXBoot.boot`.

## Why this is the §4 resolution

The kernelization doc's §4 listed "lazy split-bootstrap — needs a registration-priority
concept the registry doesn't have yet" as option 2. `bootEligible` **is** that concept,
shaped as a per-module contract instead of priorities — no ordering knobs, just a binary
tier with a hard behavioral contract.

## Device gate (before `splash.dsx_ui` defaults on)

- Cold boot: the (engine-free UIKit) splash paints on the FIRST frame with **no perceivable gap**
  after LaunchScreen.storyboard — and crucially NO solid-color hold before the spinner appears (the
  "black-then-splash" regression: an engine-built boot frame blocked the main thread for seconds)
- `min_ms` honored; transition into the main flow (DSX-first root) is seamless
- Logo asset renders (and color-only when unset) · opt-out app boots legacy splash
- Biometric + offline apps untouched (guards verified)
- Background wakeup (`background.urlSession`) still bootstraps fully — phase split invisible

## The two-phase splash — instant AND fully dynamic

The first-frame contract above forbids a `StackSurface` on the boot path: the engine's first-ever
init blocks the main thread for *seconds*, so a DSX splash there reintroduces the "black-then-splash"
regression. But a fully-dynamic, author-customizable splash is exactly what white-label apps want. The
resolution is to **split the splash into two phases** — instant first, dynamic second — so we get both:

| | Phase 1 (instant) | Phase 2 (dynamic) |
|---|---|---|
| **What** | `BootSplashView` — engine-free UIKit (bg + the resolved brand: logo / custom gif / the rounded app icon, or the `#5719E0` spinner only when `show_spinner`/no brand) | the DSX `<Splash/>` surface (`Components/Splash.dsx`) — author-customizable markup, **mirrors phase-1** (same logo, same gated spinner) |
| **Mechanism** | the `boot.splash` claim (the boot tier) | a `dsx.boot.gate` (`BootGate.swift`) registered in `Splash.setup()` |
| **When** | the very first frame, before the engine/bootstrap | AFTER phase-1 hands off, BEFORE the entry mounts (engine + bootstrap up) |
| **Cost it pays** | nothing — pure UIKit, instant | the first-time `StackSurface`/engine init — **hidden behind phase-1** |
| **Owns** | the guaranteed first frame (no black/blank gap — #802) | the visible hold + the dynamic look |

**This is purely additive.** Phase-1 (`BootSplashView` + the kernel's appear-gated
`BootSplashController` handoff) is **unchanged** — it is still the guaranteed instant first frame.
Phase-2 sits *behind* it: by the time the engine pays its first-init cost, the user has been looking at
the instant phase-1 splash the whole time, so there is no black screen and the splash is still fully
dynamic. Disabled/excluded → no gate → phase-1 → entry directly (today's behavior).

### The flow (who hands to whom)

```
didFinishLaunching
  ModuleRegistry.boot()                                  // boot tier (sub-ms)
  claim("boot.splash") → BootSplash(BootSplashView, minMs) // PHASE 1 — instant UIKit first frame
  DSXBoot.installBootSplash(...) { switchToMainAppFlow }
    └─ BootSplashController holds phase-1 minMs, then from viewDidAppear →
       switchToMainAppFlow → DSXBoot.boot(present: <window crossfade>, then:)
         └─ BootGates.run(present:then:)                   // the gate chain
              ├─ Splash phase-2 gate (priority 1000)       // PHASE 2 — dynamic DSX <Splash/>
              │    dsx.component.mount("Splash")            //   built here (engine is up)
              │    present(surface.controller)              //   ← the SAME crossfade present →
              │                                             //     dissolves OVER phase-1 (no gap)
              │    on:appear → dsx.event('phase2.ready')    //   start the visible hold from APPEAR
              │    after dsx_min_ms → dsx.resolve()         //   advance the chain
              ├─ AppLock gate (priority 100), if enabled
              ├─ ContentServer sync gate (priority 40), if offline
              └─ mount(rootController())                    // the entry (RouterHost) — crossfaded in
```

**The crossfade is free.** `BootGates.run` presents a gate's mounted surface through the **same**
`present` closure `switchToMainAppFlow` passes to `DSXBoot.boot` — and that closure is the host's
`UIView.transition(.transitionCrossDissolve)` window-root swap. So phase-2 *dissolves over* phase-1
(which stays painted through the 0.5s transition), and then the entry dissolves over phase-2 — one
mechanism, no new code, no gap at either seam. The module never touches the transition; it only
`dsx.component.mount`s the surface (which sets `dsx.lastMount`, the gate runner's cue to present it).

### Timing — no double-hold

The two phases must not *each* hold for the full `min_ms` (that would double the splash). The Splash
module collapses phase-1 to a short **bridge** whenever phase-2 is active:

- **Phase-2 ON** (`dsx_ui` + `present_splash` + not offline): phase-1's hold = `boot_bridge_ms` (~0 —
  it only needs to stay up until the engine is ready and phase-2 crossfades in); **phase-2 owns the
  visible hold** = `dsx_min_ms`, timed **from when phase-2 appears** (its `on:appear` →
  `dsx.event('phase2.ready')` starts the timer, so the perceived duration is measured against what the
  user actually sees, not the gate's start which precedes the crossfade).
- **Phase-2 OFF**: phase-1 keeps its own full `min_ms` (today's single-hold behavior) — there is no
  second phase to hold.

The single predicate `Splash.phase2Active(cfg)` gates BOTH the gate registration and the phase-1
collapse, so they can never disagree (phase-1 only shrinks when the phase-2 gate actually runs). A
**safety net** in the gate (a fallback timer = `dsx_min_ms` + a small crossfade allowance) guarantees
phase-2 always resolves even if `on:appear` never fires — the launch can never wedge on the gate.

### Customizing phase-2

`Components/Splash.dsx` is the author-facing markup — edit it freely (text, logo, animation, layout);
it is a normal in-app DSX surface (the engine is up by phase-2). Two contracts to keep:

- **Keep the root's `on:appear="dsx.event('phase2.ready')"`** — it starts the visible hold from the
  moment the splash appears. (If removed, the gate's safety-net timer still resolves, just timed from
  the gate start instead of from appear.)
- **Optional early advance**: raise `dsx.event('ready')` when your splash is done (e.g. after a
  one-shot intro or once prepared content is in hand) to advance to the app without waiting out the
  floor. The default markup does not, so the `dsx_min_ms` hold is the normal path.

The brand inputs ride in as mount attributes from the gate (`runPhase2`) so phase-2 shows the
**identical** splash to phase-1 (no spinner-then-logo flip across the crossfade): `background` (→
`dsx.attribute.background`, from `splash.background`), `logo` (the bundled imageset name — phase-2
only runs when one is set), `has_brand` (a brand is on the frame — the markup's spinner is gated on
`show_spinner || !has_brand`, so a natively-drawn brand *under* the surface also suppresses it; iOS
feeds `true`, Android feeds it per its logo/fallback-icon state), `show_spinner`, `scale_image`
(≥100 → full-bleed `<image grow="true">`, else a centered `<image width=… height=…>` sized to
`logo_side`), and `logo_side` (the centered size in points, the same shorter-edge math phase-1
uses). The crossfade is then between two frames painting the same field with the same brand.

### Config knobs (`splash.*`, in the Splash module's `config.json`)

| Key | Default | Meaning |
|---|---|---|
| `present_splash` | `true` | Show a splash at all. **false → no splash**: the claim returns nil → the host mounts the entry surface directly (see *The entry-legos model*). |
| `dsx_ui` | `true` | The **phase-2** switch. true → render the dynamic DSX `<Splash/>` behind phase-1; false → instant-only phase-1 (an instant rollback to today's behavior). |
| `logo` | `""` | Bundled **imageset name** for the brand image (both phases). Set it (+ `background`) for a clean **instant brand splash with no loader** — the spinner is auto-suppressed when a brand resolves. Empty → the brand falls down the `SplashBrand` chain (custom splash.gif → `fallback_brand`). |
| `fallback_brand` | `"icon"` | The **unbranded-app** brand (no logo, no custom splash.gif): `icon` = the app's own icon, masked with the home-screen superellipse (22.37% continuous corners); `gif` = the stock bundled splash.gif (the pre-`fallback_brand` behavior — the rollback); `none` = background only. A custom splash.gif always wins over this (detected by bytes, no config needed). |
| `show_spinner` | `false` | Force the loading spinner even with a brand. The spinner renders when `show_spinner == true` **OR** no brand resolved at all; so the default splash has **no spinner**. |
| `scale_image` | `30` | Logo size as a % of the shorter screen edge (centered). **`100` → full-bleed** edge-to-edge splash image (`.scaleAspectFill`). |
| `dsx_min_ms` | `1500` | Phase-2's visible hold (ms), timed from when phase-2 appears. Defaults to the legacy `min_ms` so the perceived duration is unchanged. |
| `boot_bridge_ms` | `0` | Phase-1's bridge hold (ms) when phase-2 is ON (~0). Ignored when phase-2 is OFF (phase-1 then uses `min_ms`). |
| `min_ms` | `1500` | Phase-1's hold when phase-2 is OFF (the single-phase duration). Also the storyboard-fallback hold. |

### Get a clean instant brand splash (no loader)

Set these via `core_packages.json` (the per-app config overrides for the Splash module). The spinner
turns **off automatically** the moment `logo` is set:

```json
{
  "Splash": {
    "logo": "LaunchSplash",      // your asset-catalog imageset name (the brand image)
    "background": "#0B0B0F",     // your brand background; empty → white
    "scale_image": 100            // OPTIONAL — full-bleed edge-to-edge; omit/keep <100 for a centered logo
  }
}
```

Both phases then show that brand (phase-1 instantly, phase-2 identically). The OS pre-code frame
(before any app code runs) is branded from the same config: **`scripts/generate_launch_screen.rb`**
stamps `LaunchScreen.storyboard` and `Host/Assets.xcassets/LaunchSplash.imageset` at prepare time —
the background from `background`, the geometry from `scale_image` (`>= 100` → full-bleed
scaleAspectFill; otherwise centered at that % of the shorter edge, matching `BootSplashView`), and
the image from the first hit of: `$LAUNCH_SOURCE` → `ClosedSource/Assets/Launch/launch.png` → the
imageset `logo` names → an app-shipped `LaunchSplash.imageset` (adopted untouched) → none. With no
brand image the frame is the splash background only (no crash, no white gap). It is `--check`
drift-gated inside `prepare_modules`. To force the spinner back on alongside a logo, add
`"show_spinner": true`.

## The entry-legos model

The app's start surface is **declarative**, not hardcoded: it is built from a few composable
"legos" — an optional splash in front, then a kernel-owned **entry surface** (`AppManifest.entry`).
The kernel always mounts the universal host (`RouterHost`), and the Router seeds frame 0 from the
`entry` block; `entry.fallback.view` picks the renderer of that first screen:

- **`DSXWebView`** (the default, the irreducible web floor) — the app's one shared **web view**. A plain
  web app needs nothing: omit `entry` and it boots straight here.
- **`DSXView`** — a **native** DSX screen (its `src` is the template path, e.g. `/dsx/home/`).
- *any shipped component tag* — that component as the first screen.

(Full reference, with copy-paste setups and the `view`/`src`/`origin` contract, lives in
**`app-manifest.md` → "App.json `entry`"**. This section is the boot-tier view: how the splash and
the entry compose.)

### The legos

| Lego | What it is | How |
|---|---|---|
| **splash → `DSXWebView`** | splash in front, then the web view (the classic app) | `present_splash: true` (default) + `entry.fallback.view: "DSXWebView"` (default) |
| **splash → `DSXView`** | splash in front, then a native start screen | `present_splash: true` + `entry.fallback: { view: "DSXView", src: "/dsx/home/" }` |
| **start → `DSXWebView`** (no splash) | NO splash, straight to the web view | `present_splash: false` + `entry.fallback.view: "DSXWebView"` |
| **start → `DSXView`** (no splash) | NO splash, straight to a native screen | `present_splash: false` + `entry.fallback: { view: "DSXView", src: … }` |
| **two-phase splash** | instant UIKit frame, then dynamic DSX splash, then any of the above | `present_splash: true` + `dsx_ui: true` (see *The two-phase splash*) |

### The splash is OPTIONAL ("not mandatory")

The splash is a *lego in front of* the entry, not a required step. Two independent off-switches, by
intent:

- **`splash.present_splash = false`** — the clean "**no splash → straight to the entry surface**"
  path. The `boot.splash` claim returns **nil**, so `didFinishLaunching` takes its
  `else { switchToMainAppFlow() }` branch and the host mounts the entry surface directly (no splash
  controller, no hold). The phase-2 gate is not registered either (same `present_splash` guard), so
  the whole splash subsystem is one flag away from off — yet the Splash module stays in `Mandatory/`
  (a flag, not an extraction; the module still owns the in-webview loading splash and the fallback).
- **excluding the Splash module** — also leaves nothing to claim `boot.splash`; the host's `else`
  branch boots straight to the entry. (Distinct from `present_splash`, which is the in-place flag.)

Either way the resolution is the same kernel path: **nothing claims `boot.splash` → the entry mounts
immediately.** It already worked when `claim("boot.splash")` returned nil; `present_splash` makes it a
documented, one-flag config choice. `splash.enabled` is a *different*, narrower knob — it governs only
the legacy in-webview loading splash and the storyboard fallback, not whether the boot splash shows;
keep the two separate.
