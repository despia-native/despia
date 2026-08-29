# The Trinity Program: one component library on three renderers

Status: PROPOSED (the owner's ruling, 2026-08-18). This document is the executable plan.
Parent: `design-system.md` (waves 1-7 landed: tokens, the web skin at fidelity, motion,
adaptive chrome, the elevation system, the parity plane). This program is what turns that
foundation into A REAL COMPONENT LIBRARY at the level of the three references every
developer already knows: the iOS system library, the Material 3 library, and the best of
the web component libraries - one set of components, library-grade on web/PWA, SwiftUI,
and Compose alike, phone through desktop.

## The measured starting point (audited 2026-08-18, the repo's own ledgers)

- Census: 89 elements + the shared markup component set; web ledger 52 supported /
  13 partial / 11 unsupported (the 11 are native-first module tags, out of scope by
  decision).
- The desktop-class set exists in the GRAMMAR on both native renderers (`Drawer`,
  `MenuBar`, `menu`, `contextmenu`, `popover`, `sheet`, `alert`, `confirmDialog`,
  `toolbar`) - but `Drawer` and `MenuBar` are PARTIAL on web, and none of the set has
  been held to a per-state, per-size, per-scheme library bar on all three renderers.
- There is NO first-class split-view primitive. The iOS library has NavigationSplitView;
  Material has the list-detail canonical layout; our starter hand-builds its split from
  stacks. This is the largest single grammar gap for desktop-class apps.
- Adaptive chrome is landed (tabs: dock / sidebar rail / sidebarAdaptable /
  NavigationSuiteScaffold; live `dsx.screen` on all three; reactive grid columns).
- The verification planes exist but are not per-component: the parity corpus holds 9
  SCREEN fixtures x 2 widths on web; the native halves ride CI lanes without a
  per-component capture yet.
- The library has no LIBRARY FACE: no per-component reference pages (anatomy, attributes,
  examples, platform notes); `StackReference.md` is a flat reference and `/system` is one
  gallery page.

## The definition of LIBRARY-GRADE (the per-component contract)

A component is DONE only when ALL of these hold, and the matrix (below) records each:

1. GRAMMAR: one census row; identical attributes/events on all three renderers; corpus
   fixtures for every behavior the corpus format can express (grammar-first law).
2. STATES: rest, hover (fine pointers), pressed, focus-visible, disabled, and where
   meaningful loading/error/empty - on all three renderers, both schemes.
3. SIZES + DENSITY: the control-size ramp where applicable; the density knob (comfortable
   / compact) honored; 44px touch floor on coarse pointers.
4. ADAPTIVITY: a defined phone / tablet / desktop presentation (which may be "identical",
   but is DECLARED, not accidental); RTL-safe; safe-area aware where it touches edges.
5. MOTION: the system springs/durations; reduced-motion collapse; interruptible.
6. A11Y: roles/names/values, full keyboard operation, axe-clean on web; the platform
   equivalents native (traits/semantics).
7. PROOF: a gallery specimen (every state), a parity fixture where layout-bearing, and
   the web reference plane recorded at both widths; native captures once the CI lanes
   carry them.
8. DOCS: a generated per-component reference page (anatomy, attributes table from the
   census, one live example, platform presentation notes).

## The driving artifact: the TRINITY MATRIX

One machine-readable ledger - `OpenSource/Conformance/library/matrix.json` - unifying
what today is scattered across `element-support.json` (web), `elements-gaps.json`
(Android parity), and the census. One row per component x renderer with the eight
contract dimensions above as checkable fields; a checker
(`ClosedSource/scripts/check_library_matrix.rb` + a TS twin test) that fails CI when a
row regresses or a new component lands without its rows. The matrix is generated-plus-
asserted like the census: generators fill what is machine-derivable (census attributes,
web ledger status, corpus presence, gallery presence); humans/agents assert the judged
dimensions (states verified, adaptivity declared) with a dated stamp the checker keeps
honest. THE MATRIX IS THE PROGRAM'S SCOREBOARD: "is the trinity done" must be answerable
by one command.

## The desktop set (the named gap, first build wave)

1. **`Drawer` to FULL on web**: the modal navigation drawer (compact) and the STANDING
   drawer (desktop: pinned, resizable within min/max, collapsible to rail) from the same
   document; scrim + focus trap modal, none standing; spring motion; full keyboard.
   Native halves already render - they get the library-grade audit, not a rebuild.
2. **`MenuBar` to FULL on web**: the desktop menu bar idiom (horizontal roots, keyboard
   menu navigation per WAI-ARIA menubar, submenu flyouts at shadow-3, shortcut hints
   right-aligned from the existing `shortcut` attribute); collapses to the sheet/menu
   idiom on compact.
3. **`<split>` - THE NEW PRIMITIVE** (grammar-first: corpus -> TS -> Kotlin -> Swift):
   the two/three-pane adaptive container. Attributes: `panes` (2/3), per-child `paneRole`
   (sidebar | content | detail), `collapse` breakpoints, `resizable`, per-pane
   min/ideal/max widths, `value`/`on:change` for the selected detail. Presentation:
   phone = navigation stack push; tablet = overlay/side-by-side; desktop = all panes
   with draggable dividers. Maps to NavigationSplitView on iOS, the list-detail pane
   scaffold on Android, CSS grid + divider drag on web. THE STARTER'S NOTES SCREEN
   REWRITES ONTO IT (deleting its hand-built split) as the acceptance proof.
4. **Context menu web polish**: right-click + long-press parity, submenu keyboard walk,
   at shadow-3 with the motion standard.
5. **The DENSITY KNOB**: `density="comfortable|compact"` as a subtree attribute + token
   plane (paddings/heights derive), honored by every control; desktop defaults compact
   where the platform does.

## The library face (docs as part of the library)

Per-component pages GENERATED from the census + matrix into despia-docs (the docs
compiler already has the hand-authored + generated route machinery): one page per
component - anatomy diagram, attribute/event table (from the census, single source),
a live specimen (the gallery machinery reused per page), platform presentation notes
(from the matrix's adaptivity declarations), and the customization hooks (tokens +
class names). The `/system` gallery becomes the index over these pages. `llms.txt`
carries them (markdown siblings), so the library is agent-readable.

## The verification trinity (closing the loop)

1. WEB (now): every library component gains a parity fixture or gallery-derived capture
   at 390 + 1366, recorded into the reference plane; axe sweeps stay zero.
2. ANDROID (CI lane): the `:render` instrumentation captures the same specimen set;
   the lane diffs layout metrics against the web plane within the documented tolerances;
   start with the desktop set + controls, grow per wave.
3. iOS (CI mac lane): the record lane renders the same specimens; same diff harness.
   Until the native capture lanes land, the matrix marks those cells VERIFIED-BY-REVIEW
   (dated), never silently.

## The waves (executable, gated)

- **W8 - THE MATRIX** (audit): build matrix.json + the checker + generators; backfill
  every existing component's rows honestly (this IS the full audit); wire into CI; the
  scoreboard command (`ruby check_library_matrix.rb --report`) prints the trinity state.
  DONE WHEN: checker in CI green; every census row has matrix rows; the report names
  every red cell. [agent]
- **W9 - THE DESKTOP SET**: Drawer full + MenuBar full + `<split>` grammar-first +
  context menu polish + density knob; starter Notes rewrites onto `<split>`; gallery
  sections; matrix rows flip with proofs. DONE WHEN: all five landed with the
  per-component contract; walks + sweeps + parity green; starter split is the primitive.
  [agent]
- **W10 - THE LIBRARY FACE**: the docs generator + per-component pages for the full
  supported set; /system becomes the index; llms.txt carries the pages. DONE WHEN: one
  page per supported component, generated, linted, served; spot screenshots reviewed.
  [agent]
- **W11 - CLOSING THE CELLS**: sweep the remaining red matrix cells (the 13 web
  partials that are in scope, state-by-state native audits) smallest-first; the native
  capture lanes land in CI (Android first). DONE WHEN: the report shows zero in-scope
  red cells or each remaining red carries a dated decision row. [agent, CI halves ride
  the lanes]

Sequencing law: W8 before W9 (the matrix is how W9 proves itself); W10 can overlap W9
after the generator exists; W11 is the long tail the matrix keeps honest.

## Out of scope, named

The 11 native-first module tags (Godot, Studio*, Waveform, LevelMeter, Scene3D/360,
lottie-native) follow their module roadmaps; the matrix carries their rows as
module-owned so the scoreboard stays truthful without blocking the trinity on them.
