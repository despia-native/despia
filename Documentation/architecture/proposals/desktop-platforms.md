# Desktop runtimes — macOS · Windows · Linux on one DSX markup

> Status: **ACCEPTED — EXECUTION STARTED** (direction accepted by the product owner in
> review, 2026-07-21; drafted the same day). The live roll-up is
> `ClosedSource/Documentation/desktop-status.md`. Landed so far: the platform corpus
> (`OpenSource/Conformance/platform/`) + the full suffix ladder and `dsx.platform.desktop`
> on all three kernels, the lint typo gate, the three tokens.json columns + defaults law
> rows, the hover input grammar on all three renderers, `platforms` declarations on all 91
> desktop-capable modules (127 audited), and the `:desktop` gradle seed (boots, tested).
> Remaining milestones (M1 Mac target · D1 CMP renderer · D2 packaging · P2 · P3) each land
> as their own Codemagic-verified PR — the watch-phases law.
> Current distribution automation is deliberately narrower than the architectural target:
> Windows and Linux package only x64 from the isolated `settings-desktop.gradle.kts` graph
> (`:core` + `:desktop`). Windows ARM64 and Linux ARM64 are not qualified release targets and
> remain promotion blockers in `compose-desktop-qualification.json`.
> Builds on: platform identity (`/web/14-platform-detection.md`, RATIFIED), the node model
> (`watch-runtime.md`, ADOPTED v2), facet contracts (`facet-contracts.md`, ACCEPTED), system
> defaults (`proposals/system-defaults.md`, ACCEPTED), and the unified-codebase law
> (the monorepo working rules / STRUCTURE.md). Written desktop-first the way `watch-runtime.md` is
> watch-first; every mechanism named here already exists — this proposal extends columns,
> it invents no machinery.

## The requirement

"1 DSX markup → any platform OS." The same `.dsx` files, the same `dsx.json` manifests, the
same `dsx` verbs, running as **real desktop apps** on macOS, Windows, and Linux — not a
browser tab in a frame, and not three markup dialects. A desktop OS joins the way watchOS and
Wear joined: as a **target** the existing machinery gates, styles, and conformance-tests —
never as a fork.

## Why this is an extension, not a port

The promise is already enforced by six standing laws. Adding three OSes means extending each
one's *columns*; nothing gets a seventh mechanism:

| Law | Where it stands | What desktop adds |
|---|---|---|
| The wire is the spec — no OS type in a contract | Constitution Article 8 | nothing — the wire is already OS-free |
| One corpus decides parity; "platform-count-agnostic" | `OpenSource/Conformance/README.md` | runner columns, zero fixture rewrites |
| Capability routing over platform checks | `/web/14` (capability-masquerading lint) | new `os` values for the residue |
| File presence is the gate; facet words are registered, never script-known | rule 11 · `facet_registry` (`prepare_modules.rb:3443`) | new registered words: `macos` `windows` `linux` `desktop` |
| Degradation is legal, divergence is not | Article 7 / STRUCTURE.md rule 5 | phone-only modules stay phone-only, honestly |
| The unstyled baseline IS the platform | `system-defaults.md` | three new baseline rows + token columns |

## Lanes vs targets — the load-bearing distinction

The framework has **three lanes** (language kernels; `PLATFORM_FACETS = %w[ios android web]`,
`dsx_graph.rb:40`) and today **five targets** (baselines: iOS · watchOS · Android · Wear ·
Web). watchOS added a target *riding the Swift lane* — a declared application target, a
registered facet word, `#if os(watchOS)` seams in kernel tiers, and **zero** new folder
vocabulary. Wear rides the Kotlin lane the same way.

Desktop adds **three targets and zero lanes**:

| Target | Lane | Renderer | Why this lane |
|---|---|---|---|
| **macOS** | Swift (`ios/`) | SwiftUI (the Stack renderer is already SwiftUI — `Stack.swift:3951 StackRootView: View`); Catalyst hosts the UIKit shell in phase M1 | SwiftUI is native on macOS; WKWebView exists → the Dom module works day one; the watch already proved the lane stretches across OSes |
| **Windows** | Kotlin (`android/`) | Compose Multiplatform (the `:render` module is already Jetpack Compose — `render/build.gradle.kts:7-11`, 134 `@Composable`s) | `:core` is **enforced pure-JVM** (`checkPureJvm`, `core/build.gradle.kts:24-32`) — the desktop kernel already runs and passes 767 tests on these OSes today |
| **Linux** | Kotlin (`android/`) | same Compose Multiplatform build | same |
| (desktop **browsers**) | TS (`web/`) | `@despia-native/dom` | already covered — Despia Web IS the desktop-browser story; it owes nothing new |

`PLATFORM_FACETS` stays frozen at three. Swift-on-Windows/Linux is **not pursued** (no
SwiftUI there); the Kotlin lane owns the open desktops, exactly as it owns Wear.

## Identity — extending `/web/14` (P0, lands on the EXISTING renderers first)

- `dsx.platform.os` gains `'macos' | 'windows' | 'linux'`. `dsx.platform.native` is
  unchanged (`os != 'web'` — desktop apps are native). New sugar:
  `dsx.platform.desktop` ⇔ `os ∈ { macos, windows, linux }`.
- The markup reserved word `os` (alias `platform`, `StackReference.md:830`) gains the same
  three values.
- Attribute suffixes gain `:macos` `:windows` `:linux` (exact) and `:desktop` (group).
  Precedence: **exact > `:desktop` > `:native` > bare** — `:desktop` folds to the three
  exacts at parse/compile like `:native` folds to ios+android; zero runtime cost. Unknown
  suffixes stay a lint ERROR.
- **The Catalyst identity rule:** identity is the *deploy target*, never the UI substrate. A
  Mac build reports `os == 'macos'` and resolves `:macos` — even while UIKit-compat runs
  underneath in M1. `:ios` never matches on a Mac. (Mirror: the wrist is a *node* of the
  phone deployment, not an os value — that distinction is why watch never touched this table.)
- Form factor stays **environment, not identity** (`/web/14` — the device-metadata module).
  A resizable window is the layout system's job; markup already renders at arbitrary
  viewports (the web renderer + `layout-oracle` prove it). No "desktop layout dialect."
- Capability-masquerading lint is unchanged and now matters more: `avail:`/`has()` answers
  "can I", `dsx.platform` answers "which words".

P0 ships this on the **three existing renderers** — fold/never-match fixtures in
`Conformance/` so today's apps stay green and tomorrow's `:macos` markup is legal everywhere
**before any desktop renderer exists**.

## Placement — extending facet contracts

- **Roles, never OS names** (`watch-runtime.md`): the manifest `platforms` role vocabulary
  gains **`desktop`** beside `phone` and `watch`. Each lane binds the role to its concrete
  target: Swift lane → the Mac app; Kotlin lane → the Compose Desktop app. One manifest, all
  platforms:

  ```jsonc
  { "scheme": "orders", "platforms": ["phone", "desktop"] }
  ```

- **Facet words** `macos` / `windows` / `linux` / `desktop` are registered the existing three
  ways (top-level `facet`, `extensionTargets[].facet`, `node.role`) by the surface owners —
  `facet_registry` learns them with **zero script changes**.
- **Residence** follows the staged two-segment shape `<lane>/<facet-word>/`
  (`facet-contracts.md:220-223`) on **all three lanes** — the outer segment names the
  toolchain that compiles the code, the inner word names the surface family it ships to:

  ```
  swift/macos/        Swift — compiled ONLY into the Mac target
  kotlin/desktop/     Kotlin — compiled ONLY into the desktop JVM build (Windows + Linux)
  kotlin/windows/     Kotlin — a genuinely Windows-only file (legal from day one)
  kotlin/linux/       Kotlin — a genuinely Linux-only file (legal from day one)
  web/desktop/        TS — the module's desktop-posture web chunk
  web/phone/          TS — the module's mobile-posture web chunk
  ```

  (Lane folders as renamed by Q5 — EXECUTED: `swift/` ← `ios/`, `kotlin/` ←
  `android/`, legacy spellings accepted via `DSXGraph.lane_dir`.)

  Windows and Linux ship from ONE JVM build, so `kotlin/desktop/` is the common home; the
  per-OS folders exist for exceptional whole-file divergence (tray formats, installers) —
  line-level divergence stays `Os.current` / `expect`-`actual`. Desktop is the second
  consumer of the staged facet-folder fan-in (`facet-contracts.md:268`) and lands it for
  real.
- **The web lane nests too — posture chunks, never a fork.** A web app is mobile-first,
  desktop-first, or mixed, and the web's file-presence gate is export-presence
  (STRUCTURE.md rule 6) — so on web the inner facet gates a **chunk**, not a compile:
  `web/desktop/` code splits into a chunk a mobile-first app lazy-loads and a desktop-first
  app inlines (and vice versa for `web/phone/`); an app-level **posture** declaration sets
  the default bundle composition. The law holds: which chunk *activates* on a mixed build
  is decided at runtime by capability/environment (pointer, viewport — the device-metadata
  plane), never a fake `os == 'desktop-web'` — `dsx.platform.os` stays `'web'`. Posture is
  a **build fact** (what ships and folds — the `.embed` separate-artifact precedent,
  `/web/14`); form factor remains **environment** (`/web/14`). Role words are reused, not
  minted: `phone` and `desktop` are the same roles the manifests already speak.
- **Role-driven source placement, safety-gated** — the watch model transposed: a module
  declaring `desktop` compiles its lane sources into the desktop target, validated by a
  Rule-8-family scan (Swift: extension-safe set; Kotlin: the `checkPureJvm` family — no
  `import android.` in desktop-placed sources). Sources that can't pass split into the facet
  folder instead. Line-level divergence uses `#if os(macOS)` (blessed in kernel/engine code —
  `check_module_rules.rb:16`) / Kotlin `expect`-`actual`; **never** a markup fork, never
  `#if <FEATURE>_ENABLED` in module files (rule 2/3 unchanged).
- Rule 11 is untouched: the language→home map (`*.swift`→`ios`, `*.kt`→`android`) already
  covers all six OSes.

## Track M — macOS on the Swift lane

**M1 — Catalyst bring-up (the whole catalog rides).** Enable Mac Catalyst on the Runtime
target. The SwiftUI renderer, the UIKit hosting shell (`Router.swift`, `BootGate.swift`,
`UIHostingController` bridges), and **WKWebView all exist under Catalyst** — DSXWebView apps run
on the Mac on day one, Article 9 intact. A `Core/Extensions/Mac` module binds the `macos`
facet word and owns Mac chrome from the start: the real menu bar (`UIMenuBuilder`), window
scenes, toolbar — modules, not host code (Articles 2/6). Modules opt in via
`platforms:["…","desktop"]`; a pod with no Mac slice keeps its module phone-only —
fail-open, `has()` honest, the watch's pods law verbatim.

**M2 — the de-Catalyst exit (optional, measured).** The renderer is already SwiftUI; the
UIKit couplings are an enumerable hosting shell (`Router` / `BootGate` / `Module` /
`Network` / `UIApplication` + hosting controllers). If/when Catalyst leaks, they move behind
seams by the blessed watch-extraction pattern (audited per-file moves, Codemagic-verified) —
the promise does not depend on M2.

## Track D — Windows + Linux on the Kotlin lane

**D0 is already true:** `:core` — JSE + JseRunner, StackNode/AST, Router, State,
ContentStore, RemoteBundleGate, the bus — is pure JVM by enforced gate and runs its 767
JUnit tests **on desktop OSes today** (it is the local dev loop). The desktop kernel is
conformance-green *by construction* before the first pixel renders.

**D1 — the renderer.** A new `desktop/` gradle module beside `core/platform/render/glance`
(the folder `Engine/Android/` is the Kotlin-lane home; a cosmetic rename is out of scope).
`:render` is Jetpack Compose with material3/foundation — Compose **Multiplatform** ships the
same APIs on JVM desktop, so the element table ports by source reuse, not rewrite. The
enumerated exceptions (`AndroidView` GIF interop, `ImageElements.kt:149`) get desktop
`actual`s. `:platform` is currently **one file** — the desktop platform module (windowing,
files, notifications via JVM/OS APIs) starts nearly empty by design.

**D2 — host + packaging.** `HostDesktop` (`main()` + window = translation lines only,
Article 6). Compose distributions package `msi`/`exe`, `deb`/`rpm`/`AppImage` in a
`desktop-app` CI lane.

**Dom on desktop — Article 9 generalized:** "WebKit lives only in the Dom module" becomes
"**the embedded browser engine** lives only in the Dom module" — on the Kotlin desktops
that's JCEF/KCEF (or a platform webview via JNI) inside Dom's desktop facet, behind the same
`dom.*` verbs. Every other module still holds no browser handle. And web-optionality
**pays** here: exclude Dom and a DSXView-first app ships as a slim pure-native binary with
no browser runtime at all.

## System defaults — three new baseline rows, one honesty line

`tokens.json` rows gain `macos` / `windows` / `linux` columns; `system-defaults.md`'s law
table gains three rows; each renderer gets a drift gate (the existing pattern).

- **macOS** — the full-inherit column, like iOS: real SwiftUI/AppKit semantic slots
  (`label`, `systemBackground`, `tintColor` resolve natively on the Mac). System components
  are hostable, so they are hosted — looks self-update with the OS.
- **Windows / Linux** — the **honest-neutral** column, like web — *because the law demands
  it*: Compose cannot *host* WinUI/GTK controls, and "the framework … never encodes a system
  look as authored style values — re-specified ones rot" (`system-defaults.md:20-22`). So:
  never fake-Fluent, never fake-Adwaita. Honest neutral **plus real system signals** (both
  OSes' dark mode; the Windows accent color feeds `accent`) **plus real system chrome**
  (window frames, file dialogs, IME, context-menu conventions) — the strongest honest
  baseline those OSes permit.

## Input grammar — hover, shortcuts, and focus order

The first platform-neutral pointer primitive is now ratified corpus-first and implemented
across TypeScript, Kotlin, and Swift: hover rides the existing event grammar and the existing
platform-suffix fold.

  ```xml
  <row on:hoverStart="hovered = true" on:hoverEnd="hovered = false"
       style="opacity: {{ hovered ? 1 : 0.8 }}">
  ```

Web accepts a non-touch pointer only when `(any-hover: hover)` is available and balances the
lifecycle across cancellation, multiple pointers, and unmount. Compose consumes pointer
Enter/Exit; SwiftUI consumes `.onHover`. On touch targets the pair never fires — degradation,
not divergence (Article 7). Same markup, everywhere.

The `shortcut` accelerator and numeric `focusOrder` attributes are now implemented by the
web renderer and the Compose desktop runtime. Both are lifecycle-scoped to mounted,
interactive nodes; global shortcuts reject unmodified typing keys, and focus ordering uses
authored document order as its stable tie-break. Touch-only surfaces degrade without firing.
Native Apple menu integration and mobile-native focus traversal remain separate platform
work and must not be advertised as parity until their renderer implementations and shared
conformance coverage land.

## Windows (the surface kind) — the presentation model generalized

- **v1 is one window**: the app in a resizable frame. Layout is already fluid — no new
  markup. Presentation verbs are state mutations (`screen-presentation.md`), so the mapping
  is host-side and markup-invisible: `push` → the window's nav stack, `sheet`/`cover` →
  window-modal dialog, `overlay` → overlay.
- **Desktop capabilities are modules** (Article 2): menu bar, tray/status item, dock/taskbar
  badge, global shortcuts, file dialogs, drag-and-drop, print, multi-window
  (`dsx.module.window.open(component, attrs)` — package screens stay ephemeral by contract).
  Each declares `platforms`/`reach`, registers its facet word, fails open elsewhere, and is
  `avail:`-gated in markup. No new kernel surface.
- The desktop app is a **root live node** (its own registry, its own JSE). Phone↔desktop
  `dsx.link` (handoff, relay) is a natural later chapter of the node model — out of scope
  here.
- macOS WidgetKit rides the existing snapshot dialect via the Swift lane — additive, later.

## Conformance & CI

- **Runner columns:** the Mac executor compiles the same `JSE.swift`/`JSEActions.swift` —
  inherited-by-construction like the watch (`watch-runtime.md` W1); the JVM-desktop executor
  *is* `:core`'s existing JUnit run, ratified as a named column; TS unchanged. Corpora are
  "platform-count-agnostic" by design (`Conformance/README.md`).
- **New fixtures:** platform-identity fold/never-match per target (P0); defaults token
  columns + drift gates; the input-grammar corpus when that proposal lands.
- **Lanes:** macOS rides the existing Codemagic mac instances (`ios-app-check` grows a Mac
  destination); `desktop-kernel` = the `:core` run (already green, now named) + CMP render
  tests; `desktop-app` = Compose packaging. The demo walk gets a desktop screenshot oracle
  (the web pattern, `screenshot-demo.ts`).
- **Ledgers:** `desktop-status.md` roll-up (the `android-status.md` pattern) + per-file
  deferral headers.

## What this is NOT

- **Not an Electron/Tauri shell.** Wrapping Despia Web in a frame is a legitimate
  *distribution channel* an app author may choose — but it makes the web view non-optional,
  and the runtime is web-optional by identity. The desktop promise is the native lanes.
- **Not a markup dialect.** No `.desktop.dsx`, no `#if` in markup, no per-OS component
  forks. The same files render everywhere; divergence lives in suffixes, availability, and
  facets — all existing grammar.
- **Not fake system skins.** See the honesty line above.

## Honest boundaries

- A phone-only SDK keeps its module phone-only; `has()` reports it; markup degrades — never
  bricks (Article 7). Play-services/UIKit-bound facets don't stretch; their modules simply
  don't declare `desktop`.
- OS-owned surface families that don't exist on a target are **not owed** there (the
  `watch-runtime.md` web-position clause): no Live Activities on Linux, no menu bar on a
  phone.
- Windows/Linux cannot *inherit* system controls — honest neutral is the law's answer, not
  a gap to apologize for.
- Catalyst is an M1 substrate, not an identity: `os == 'macos'` from the first build.

## Execution plan (each independently shippable)

| Phase | What | Gate |
|---|---|---|
| **P0 — the law** | identity values + `:macos/:windows/:linux/:desktop` suffixes + lint + fold fixtures on the THREE EXISTING renderers; roles + facet words registered | corpus green on TS/Kotlin/Swift; existing apps byte-stable |
| **M1 — Mac rides** | Catalyst on Runtime; `Core/Extensions/Mac` module (menu bar, scenes); module opt-ins | same corpus green on the Mac executor; DSXWebView + DSXView demo apps boot on macOS |
| **D1 — Kotlin desktop kernel + renderer** | `:core` column named; `desktop/` gradle module (CMP element table); `HostDesktop` | `:core` corpus green on JVM desktop (already true); element/layout oracle on desktop |
| **D2 — desktop app** | platform module, Dom-desktop (browser engine confined), packaging lane | `assembleDesktop` + installers in CI; demo walk screenshots |
| **P2 — the desktop surface** | defaults columns + tokens; window/menu/tray/shortcut/file modules; input grammar corpus-first | drift gates green on 5 renderer targets; touch targets prove defined no-op resolution |
| **P3 — the promise audit** | `desktop-status.md`; docs; the SAME demo app from `Conformance/examples` booting on **iOS · Android · Web · macOS · Windows · Linux** | one markup, six OSes, zero forks — recorded in the ledger |

## Open questions

1. `:desktop` group suffix — ratify with P0, or ship exacts only and add the group when a
   real app demands it? (Recommendation: ratify with P0 — the fold is free and the wrist
   pair's lesson is that authors repeat themselves without a group word.)
2. M2 de-Catalyst — measured by what trigger? (Recommendation: a named leak list — menu-bar
   fidelity, window-restoration, pointer accessories — reviewed once M1 soaks.)
3. Dom-desktop backing — JCEF/KCEF vs per-OS webview via JNI (WebView2 on Windows,
   WebKitGTK on Linux)? Article 9 confines the blast radius either way; decide inside the
   Dom module when D2 opens.
4. `windows`/`linux` token columns — role names resolved by the honest-neutral theme
   (recommended, matches the Kotlin lane's M3-role shape) vs web-style literals?
5. The lane rename — **EXECUTED (2026-07-21).** All 434 facet files moved (`swift/` ←
   `ios/` ×164 folders, `kotlin/` ← `android/` ×103), the one vocabulary point became
   canonical-plus-alias (`DSXGraph.lane_dir` / `PLATFORM_FACETS` / `FACET_CANONICAL`),
   every discovery walker and generator emitter went spelling-aware (rule 11 hints
   canonical), generated registries byte-stable, all gates + the 61-case resolver
   harness green. Legacy `ios/`/`android/` stay accepted for per-app Custom zips.
   The original decision record: `ios/` → `swift/`,
   `android/` → `kotlin/`; `web/` keeps its name — a lane name must simply be TRUE, and
   the web lane spans postures, not OSes (`typescript/` would be full-consistency churn
   with no misnomer to cure). Measured blast radius: 164 `ios/` + 103 `android/` + 15
   `web/` module folders (~267 `git mv`s), 5 consumers of `PLATFORM_FACETS`, 11 script
   files with literal facet spellings, 35 doc files, 14 `/ios/` path refs in the pbxproj
   (regenerated — the idempotence gate proves it). Mechanism: the ONE vocabulary point
   stays one point — `PLATFORM_FACETS` becomes canonical-plus-alias (`swift ← ios`,
   `kotlin ← android`); rule 11 accepts both segments and *hints* canonical; `CONFIG_GLOBS`
   gains the `kotlin` globs; the Android preparer's `package_dir?` accepts both.
   Sequencing: one dedicated mechanical PR (folders + scripts + the working-rules / STRUCTURE.md
   path literals + docs) **before** D1 multiplies the desktop file count. The legacy alias
   stays for a deprecation window because per-app **Custom** modules arrive as CI-copied
   zips speaking `ios/`/`android/` — the dashboard keeps working and apps migrate on their
   own clock. Named cost, accepted knowingly: this retires the "iOS paths byte-identical
   to `d-ios@v4`" porting invariant (STRUCTURE.md header) — d-ios@v4 is a parts-bin, never
   a target, and that invariant ends the day desktop lands regardless.
6. Web posture — where the `mobile-first | desktop-first | mixed` declaration lives
   (App.json `web` block vs the web app config); whether a single-posture artifact
   constant-folds its dead chunks the way `.embed` artifacts fold (`/web/14`); and whether
   the mobile inner word is `phone` (one role vocabulary — recommended) or a `mobile`
   alias.
