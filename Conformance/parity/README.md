# parity/ - the cross-renderer FIDELITY corpus

The parity contract executed as fixtures (`architecture/proposals/design-system.md`,
Wave 4 "The parity contract"; release bar, measured not vibed). The claim under test:
**one .dsx document is one screen** - a screen authored for native renders near-pixel
on web, the same screen authored on web renders perfectly on native, and one
renderer's output is a prediction of the others'. The `layout/` corpus already pins
bare CSS boxes; THIS corpus pins whole representative screens through each
renderer's REAL pipeline: the compiled component, the full element set, the full
default skin, the semantic token plane.

## The contract

For every fixture in `fixtures/`, a renderer's settled render must agree with the
reference plane on three measured axes:

| Axis | Budget (web verify, stage 1) | Budget (native lanes, stage 2) |
|---|---|---|
| Layout boxes (per-node x, y, w, h) | within `DSX_PARITY_BOX_TOLERANCE`, default **1 CSS px** | budgeted, proposed start **2% of the viewport dimension or 8px, whichever is larger** - text measurement differs per platform font |
| Resolved semantic colors (per-node color/background, radii, and the full `--dsx-*` token tables, light AND dark) | **EXACT** | **EXACT** after mapping through `defaults/tokens.json` (the web column is the literal plane; native columns resolve their system slots - a slot that is system-owned is a GAP LEDGER row, not a diff) |
| Type metrics (font-size, weight, line-height on text nodes) | size and weight **EXACT**, line-height within **0.5px** | size and weight exact in CSS-px terms; line-height within the platform font tolerance, proposed start **15%** |

Two laws are enforced in-harness on every run, both modes:

- **The scheme law**: dark may move COLORS only. The dark render's node set and
  boxes must match light's within 0.5px, or the run fails before anything is
  recorded or compared.
- **Rest state**: references are captured under `prefers-reduced-motion` (the
  skin's own collapse) with animations disabled at the screenshot. The plane pins
  settled geometry and color; motion parity is the `motion/` corpus's dimension.

## The three stages (design-system.md, "Measured form, staged honestly")

1. **NOW (live, this folder): the web reference plane.**
   `OpenSource/Web/scripts/parity-oracle.ts` boots every fixture through the real
   app path (`compileComponent` + `extractComponentCss` -> `bootDsx`, the same
   dist a shipped application resolves) in the locked Playwright engine at BOTH
   locked widths - the phone plane (390x844@2x, touch emulation) and the desktop
   plane (1366x1024@2x, fine pointer + hover, so the wide-chrome and
   desktop-density media steps engage; wave 5 "the desktop face") - and records
   into `reference/web/`: per-fixture-per-width metrics JSON (boxes, colors
   light+dark, radii, type metrics, both resolved token tables) plus a light and
   a dark screenshot per width. VERIFY mode re-renders and compares
   against the committed plane within the budgets above - the web renderer is
   held to its own reference on every run.
2. **CI: the native lanes join.** The Android `:render` instrumentation replays
   the same fixtures and diffs layout metrics against `reference/web/` (budgeted
   diff, never pixel-zero - fonts and AA differ); the iOS record/mac lane joins
   with the same harness and the same diff. Landed - see "The native capture
   planes" below for the lanes, the capture shape, and the tolerance contract
   (metrics in v1; the screenshot diff joins when the captures grow shots). The
   diff runs report-first until the budgets are ratified from real lane captures
   (`DSX_PARITY_NATIVE_ENFORCE=1` flips breaches to failures).
3. **The gap ledger below**: every knowingly-unfillable web limitation is a named
   row with its degradation, not a silent divergence.

## Running the web plane

```
cd OpenSource/Web
npm run parity-oracle              # build + VERIFY against reference/web/
npm run parity-oracle -- record    # build + re-record the reference plane
```

Direct invocations (after `npm run build`): `node scripts/parity-oracle.ts` /
`node scripts/parity-oracle.ts record`. The engine is the locked Playwright
Chromium (`DSX_BROWSER` selects an engine, `DSX_BROWSER_EXECUTABLE` pins a
binary - the same `browser-engine.ts` contract every oracle uses). Knobs:
`DSX_PARITY_BOX_TOLERANCE` (px, default 1), `DSX_PARITY_PIXEL_BUDGET` (fraction
of pixels allowed past a 6/255 channel delta on verify screenshots, default
0.02).

**Re-recording is the sanctioned refresh**: a deliberate skin change (a wave
landing new form factors or chrome) re-records the plane in the same commit, and
the reference diff IS the review surface. A verify failure with no intended skin
change is a regression, full stop - subject to the typeface clause below.

### The intended face (the plane is face-pinned and portable)

`--dsx-font` names **InterVariable** first, and the repo vendors exactly those
subsets in the Type satellite (`OpenSource/Type/vendor/inter`, OFL-1.1, pinned) -
but a page that never declares the `@font-face` falls through to the host's
`system-ui`, which is what used to make this plane host-bound: macOS resolved
`.SF NS`, a Linux box whatever fontconfig answered, every glyph advance differed,
and a plane recorded on one host reported **575 problems** on the other, **571 of
them that single fact** (measured 2026-08-22). The harness page now loads the
satellite's woff2 as `data:` URIs - the same declarations `despia dev` injects -
so every host shapes text with the same glyph advances and the plane records and
verifies identically wherever the checkout runs.

Two recorded guards keep that honest rather than assumed:

- **The face guard**: each fixture's JSON records `typeface`, the face the host
  ACTUALLY resolved (Chromium only - the platform-font query is a CDP call; other
  engines record `null` and skip the check). A mismatch - the satellite missing,
  the font failing to decode - is reported **once**, the geometry axes (boxes,
  line-height, the screenshot diff) are held back rather than emitting hundreds of
  downstream diffs, and a strict verify exits non-zero rather than measuring a
  lie. `DSX_PARITY_FACE=any` downgrades that to a note for a host that knowingly
  cannot load the face; it is fail-OPEN and therefore never the default.
- **The raster clause**: with the face pinned, boxes and line-heights travel
  across platforms (same woff2, same advances), but antialiasing does not -
  FreeType and CoreText paint different edge pixels - so each fixture's JSON
  records `platform` and the SCREENSHOT diff runs only on the platform that
  recorded the plane, held back with a note anywhere else. Everything that is not
  pixels stays enforced everywhere.

The committed plane is recorded on **linux / Inter Variable** - the same platform
and face as the per-PR `web-kernel` lane, so the full contract including the pixel
diff runs on every PR. iOS comparability rides the declared metrics and the token
mapping; the stage-2 native budgets are font-tolerant by design.

**Per-PR enforcement:**

| Lane | Host face | What it enforces |
|---|---|---|
| `web-kernel` (linux_x2) | Inter Variable, loaded from the satellite | the FULL contract: boxes, line-heights, the screenshot diff, colours, radii, the whole token table, declared type, node identity |
| `desktop-macos-pr` (mac_mini_m2) | Inter Variable, loaded from the satellite | everything except the screenshot diff (raster-bound to the recording platform, held back with a note); a face mismatch here still fails |

## The fixtures (representative screens, the starter's real patterns)

Every fixture is a self-contained `.dsx` document - one root, `<head>` state
only, static data, no network, no routes, no motion attributes - authored in the
ratified semantic vocabulary (`defaults/tokens.json` words plus the system-space
variant words), so all three renderers resolve it from their own defaults.

| Fixture | The screen it pins |
|---|---|
| `form-screen.dsx` | The starter's sign-in: brand bar, welcome block, declared `<form>` (email / secure / toggle fields, full-width submit), problem line, secondary text action |
| `settings-groups.dsx` | The grouped-list settings screen: large title, uppercased section headers, inset grouped cards on `secondaryGroupedBackground` over `groupedBackground`, toggle row, chevron rows, hairline separators, footnote |
| `tab-shell.dsx` | The app frame: bottom `<tabs>` bar (icon + label + active treatment), three panes composing the grouped and search languages |
| `list-feed.dsx` | The starter's notes pane: baseline header with count, compose `<form>`, keyed `<list>` of pressable rows (title, tertiary date, chevron, separators) |
| `overlay-sheet.dsx` | The presented `<sheet>` at rest over a dimmed base screen: scrim, half detent, grabber/title/action bar, form content inside the panel |
| `type-ramp.dsx` | The type specimen: the full ramp at working weights and tracking, the five ink roles, the surface family (`groupedBackground` / `secondaryGroupedBackground` / `fill`) |
| `control-strip.dsx` | The interactive floor at rest: switches on/off (the wave-4 form factor), slider, stepper, segmented with selection, progress, spinner, filled field, the button set (`variant="prominent"` / `"bordered"` / `role="destructive"`) |
| `landing-hero.dsx` | The landing side of the app-vs-landing line: brand bar, eyebrow + display headline, CTA row, numbered feature list, footer strip |
| `dashboard.dsx` | The desktop proof (wave 5): a stat-tile `<grid>` whose columns follow `dsx.screen.width` (4 desktop / 2 tablet / 1 phone; the 390pt plane pins the single-column form), a report-card grid on the same breakpoints, section header rows with trailing action buttons, and a bound `<Table>` that scrolls inside its own frame - one document at every width, adaptive by expression, no per-platform fork |
| `split-screen.dsx` | The three-column adaptive shell: `<split>` with sidebar, content and detail panes at their declared resting widths, the divider, and the collapse/expand breakpoints the plan resolves at each width |

Fixtures lint with the repo gate (they live outside the default sweep, so name
them): `ruby ClosedSource/scripts/lint_dsx.rb --strict
OpenSource/Conformance/parity/fixtures/*.dsx`.

## `reference/web/` - the committed reference plane

Reference files are KEYED BY WIDTH. Per fixture and per width key (`w390` =
390x844@2x touch, `w1366` = 1366x1024@2x fine pointer + hover):
`<name>.<key>.json` (the measured plane - viewport, both token tables, per-node
`path` / `id` / `box` / `radius` / light+dark colors / type metrics) and
`<name>.<key>.light.png` / `<name>.<key>.dark.png`. GENERATED by record mode;
never hand-edited. Boxes are CSS px in viewport coordinates; node `path` is the
element's child-index path under `<body>`, so overlay portals (sheet layers) are
measured the same as in-flow content. A fixture's node COUNT may differ between
widths (adaptive `<grid>` columns re-wrap rows); the scheme law binds light to
dark WITHIN a width, and verify checks every fixture at every width.

## The native capture planes (stage 2 - the lanes, the shape, the tolerance contract)

The CI halves of the verification trinity (component-library.md). Two capture lanes
replay the SAME fixture set (globbed from `fixtures/` - never a hand list) through the
real native renderers and emit per-fixture-per-width metrics JSON in the web plane's
node shape; one host-side diff (`ClosedSource/scripts/parity_native_diff.rb`) compares
any native capture against `reference/web/` under the contract below.

- **Android**: `ParityCaptureInstrumentedTest` (Engine/Android `:render` androidTest;
  the `ParityCapture.kt` seam in the real `Modifier.decorate` chain) rides the app
  lane's existing phone-emulator suite (`codemagic.yaml`, "Phone + optional Wear
  emulator UI tests" - the step already zeroes animator scales); the driver
  `ClosedSource/scripts/android_parity_capture.sh` runs the connected suite, pulls the
  capture off the emulator, and the step then runs the diff.
- **iOS**: the record lane (`conformance-record` in `codemagic.yaml` -
  `record_jse_conformance.sh` - `RecordMain.swift`) runs `ParitySpecimenRecord`
  (`ClosedSource/scripts/conformance/ParityRecord.swift`; the
  `OpenSource/Engine/iOS/ParityCapture.swift` seam in `StackNodeView`), writing
  captures beside the regenerated corpus, then the same diff.
- **Compose Desktop**: `DesktopParityCaptureTest` (Engine/Android `:desktop`, the
  `DesktopParityCapture.kt` seam) renders the same fixtures offscreen on the JVM and rides
  the per-PR `linux-desktop-validation` lane. It needs no device, so it is the FIRST of the
  three that has actually executed - and it proves the Compose element layer only, never
  Android and never iOS. See "The desktop capture plane" below.

**The capture shape.** Same file naming (`<fixture>.<key>.json`), same viewport keys,
same node fields (`path` / `id` / `box` / `radius` / `light` / `dark` / `text`), plus
`renderer`, `engine` and a `schemeLaw` breach list (the scheme law is recorded by the
capture and surfaced by the diff, never asserted on-device, so an unproven budget
cannot flake a build). Differences from the web plane, by construction:

- `path` is the node's child-index path in the FIXTURE'S AUTHORED tree (the web plane's
  paths index the host DOM). A template node rendered more than once (bound list/grid
  rows) records one entry per instance, ordered by settled position, with a `~k`
  appearance suffix (`0.3.0~1`).
- `id` is the authored DSX tag (`stack`, `text`, `button`); the web plane stores the
  host element + class (`div.dsx-stack`). The diff owns the tag-to-host table.
- `box` is CSS px (Android dp at the forced density 2, iOS pt) in plane coordinates.
- A `text` field may carry `null` members: the capture reports only style facts the
  resolver produced; an absent fact means the PLATFORM DEFAULT is in effect (gap N2).

**The alignment rule.** The comparable set is the fixture's AUTHORED elements and
nothing else. Component internals, host wrappers, chrome and synthetic nodes (knobs,
tracks, aria rows, portals' scaffolding) are platform anatomy - out of the set on both
sides. The diff pairs each authored node with its PRINCIPAL WEB HOST: the web node
carrying that element's `dsx-*` host class (the table lives in
`parity_native_diff.rb`; a NEW authored tag in a fixture must join that table or the
diff names it unmapped). Within a host family, instances pair in settled position
order (y, then x, then size) on each side independently, so bound-row repeats align
without the two planes sharing path grammar. Family COUNT disagreement is a structural
breach; pairing coverage is printed on every run so a mapping regression is visible.

**The tolerance contract** (the stage-2 budgets, firmed from the axis table above):

| Axis | Budget | Notes |
|---|---|---|
| Boxes | per axis, within **max(8 px, 2% of the plane dimension)** (x/w against width, y/h against height) | text measurement differs per platform font (G1); window chrome differences ride N1 |
| Radii | within **1 px** when both sides are px-valued; non-px radii compare literally | the resolver's own numbers on both sides |
| Colors | **reported, never enforced in v1** | G3 law: native semantic slots are SYSTEM-OWNED (`defaults/tokens.json` native columns are role names, the web column is the literal plane), so literal-to-slot equality is not the contract; enforcement needs the role-mapping pass over each renderer's OWN resolved token capture - a later wave |
| Type | size and weight **EXACT** in CSS-px terms where the native capture resolved a value; line-height within **15%** | a `null` native fact = platform default in effect, reported under N2, not failed |
| Line box | a text node measured under the platform's own leading **reports** its `box h` instead of failing it | the ratified N5 split; scoped to that node's own height |

**The staging law.** The diff is REPORT-FIRST: it always prints the full per-fixture
report (breaches, color rows, unmapped tags, coverage) and exits 0. Setting
`DSX_PARITY_NATIVE_ENFORCE=1` flips box/radius/type/structural breaches (and unmapped
tags) into a failing exit - the flag flips on in the wave that ratifies measured
budgets from real lane captures. Harness sanity is ALWAYS enforced regardless of the
flag: fixtures found, every fixture parses and renders, every capture non-empty, and
the diff refuses a capture set with missing files.

**The native gap ledger** (the G-table's stage-2 siblings; same law - a divergence
that is not a row is a bug):

| # | Gap | Degradation | Diff treatment |
|---|---|---|---|
| N1 | Window chrome and safe areas: native planes render inside a real window whose insets are OS-owned | Captures record settled geometry as rendered | Rides the box budget; a systematic inset shift shows up in the report as a uniform y delta |
| N2 | Platform default type: an unstyled text resolves the platform's own body font outside the resolver's style facts | `text` members are `null` where no authored fact resolved | Reported as platform-default rows, never failed |
| N3 | System dynamic color (G3 restated for captures): UIColor slots / Material dynamic color resolve per OS, device and wallpaper | Colors are captured as resolved | Color axis is report-only in v1 |
| N4 | No native screenshots in v1: the capture is metrics-only | The web plane's PNGs stay web-verify-only | Screenshot diff joins when the capture grows shots |
| N5 | The platform LINE BOX (ratified 2026-08-20): web and Compose Desktop pin `line-height: 1.5`; iOS and phone Android take the platform's own leading and honour only an authored `lineSpacing` | A text node's own height differs by the leading its platform ships | The text node's own `box h` is REPORTED, never failed, when the native capture resolved no line fact and the web host carries one. Its own height only: the `y` a later sibling inherits from it still rides the box budget, because widening that would blind the differ to real layout drift |

**Open, NOT ratified.** `width: 100%` maps to `grow` in the CSS bridge, and both native
flex frames then drop `max-width`, so a capped centred column runs full-bleed on iOS and
phone Android where web and desktop clamp and centre it (measured at the 1366 plane:
native `x=0 w=1366` against web `x=475 w=416`). This is the same browser-pinned-hug against
native-spread shape as the open `18-row-grow-hug` ruling and is to be decided WITH it, in
one ruling. Until then it is neither a gap row nor a budget adjustment: it breaches, and it
is the largest single family in the Android device diff. Nothing here may be widened to
absorb it.

## The desktop capture plane (stage 2, the first EXECUTED native capture)

**Scope, stated plainly: this plane is Compose Desktop on the JVM. It executes the Compose
element layer, the shared DSX-CSS resolver and every `:core` law, offscreen on Skia. It is
NOT an Android device capture and NOT an iOS capture, and it may never stand in for
either** - no `ios` or `android` cell of `Conformance/library/matrix.json` may be flipped
from it. What it does give the project is the first cross-renderer fidelity measurement
that actually ran, on any machine with a JDK and no device, emulator or simulator.

- Seam: `OpenSource/Engine/Android/desktop/.../DesktopParityCapture.kt` (the `:render`
  `ParityCapture.kt` twin, consulted once per composed element in `DesktopNode`; disarmed
  it is one `@Volatile` null read and nothing composes).
- Harness: `DesktopParityCaptureTest`, globbed from `fixtures/`, rendered through the real
  `DesktopSurface` inside the shipped `desktopPalette` MaterialTheme, at both locked planes
  in both schemes, under the rest-state law (`dsx.reduceMotion`, settled on three identical
  consecutive snapshots). Emits the same node shape as the Android and iOS captures, so
  `ClosedSource/scripts/parity_native_diff.rb` reads it unchanged.
- Plane: `reference/desktop/` (`<fixture>.<key>.json`), `renderer: "desktop"`,
  `engine: "compose-desktop"`. GENERATED, never hand-edited.

```
cd OpenSource/Engine/Android
xvfb-run -a gradle :desktop:parityCapture                        # records build/parity-desktop
xvfb-run -a gradle :desktop:parityCapture -PdsxParityRecord=true # re-records reference/desktop
ruby ClosedSource/scripts/parity_native_diff.rb --captures OpenSource/Conformance/parity/reference/desktop
```

A display server is required (`xvfb-run` is enough): `<sheet>` presents as a real OS dialog
window on this renderer, which AWT refuses to create headless. The capture is deliberately
kept out of `:desktop:test` - it writes a plane rather than asserting one - and rides the
per-PR `linux-desktop-validation` lane, which already runs Xvfb with
`DSX_DESKTOP_UI_TESTS=1`. Text measurement is font-dependent, so that lane records ITS OWN
plane into `desktop/build/parity-desktop` and diffs that; the committed `reference/desktop/`
is the recorded evidence from the recording host, not a byte-golden other machines must
reproduce.

**The first measurement (2026-08-19, 10 fixtures x 2 planes x 2 schemes).** 20 captures,
532 captured nodes, 528 paired with a principal web host (99.2% pairing coverage), 0
unmapped authored tags, and the scheme law clean on all 20 captures (dark moved colors
only). The diff reports 825 breaches and 2458 report rows, report-first, exit 0. Boxes
within `max(8px, 2% of the plane dimension)`: x 59.3%, y 60.6%, w 56.4%, h 77.3% of 528
pairs; 95 nodes (18.0%) clean on all four axes - 22.0% at `w390`, 14.0% at `w1366`. Beyond
boxes: 40 radius breaches, 8 structural, 4 type (3 font-size, 1 font-weight). Of the report
rows, 2086 are the color axis (report-only under G3/N3), 362 are platform-default type
facts (N2), 10 are text-presence rows.

**The named divergence classes behind those numbers** (same law as the ledgers above - a
divergence that is not a row is a bug):

| # | Divergence | Evidence |
|---|---|---|
| D1 | `<sheet>` presents as a separate OS dialog window (`DesktopModal` to `DialogWindow`) with its own composition root and the system density, so its subtree is captured in DIALOG-ROOT coordinates, not plane coordinates | `overlay-sheet` `0.2.*`: native y 14 vs web 505.61 on the `<form>` |
| D2 | Compose containers wrap their content; a web `<div>` is block-level and the frame fills the viewport, so a fixture root with no authored `grow=` reports a content box on desktop and a viewport box on web | `tab-shell` root h: native 48 vs web 844 |
| D3 | The centered content column does not survive: `align-self` has no mapping in the shared Kotlin CSS bridge (`:core CssBridge.kt`), and `desktopStyleModifier` wraps `fillMaxWidth` (from `width: 100%`) OUTSIDE `widthIn(max=)`, so `max-width` never clamps. The wide plane goes full-bleed and left-aligned | `form-screen.w1366` `<form>` w: native 1302 vs web 198; x within budget falls from 86.7% at `w390` to 31.8% at `w1366` |
| D4 | `<row>` anatomy: the web host `div.dsx-row` measures `[0,0,0,0]` in `list-feed` and is absent entirely in `settings-groups`, while the desktop composes a real box | `settings-groups`: 2 native `<row>` instances vs 0 web hosts (structural) |
| D5 | A `<form submit="...">` renders its submit control as a web host carrying `button.dsx-button`, while the desktop renders it as component anatomy with no authored node, so the button family counts differ by one | `form-screen` and `overlay-sheet`: the 8 structural breaches |
| D6 | `<tabs>` treats a `<head>` child as a PANE on this renderer, so the selected pane is the empty declaration block and the screen never renders. `:render`'s `Tabs` reads `node.children` the same way (`StackNodeView.kt`), so the Android lane must be checked the first time it runs | `tab-shell` captures 1 node (the tab bar, h 48) instead of the Home pane |

D3 and D6 are renderer defects this measurement found, not capture artifacts; they are named
here rather than patched in the capture wave, because the fix belongs in the shared bridge
and in every renderer at once (the unified-codebase law), not in the lane that measured them.

### What the capture was allowed to move (integration, 2026-08-19)

`desktop-capture-stamps.json` is the capture's proposed-stamp sidecar, kept beside this
README rather than inside `reference/desktop/` (the differ globs that directory for
captures). It carries one row per composed component: 22 components, every proposed value
`review`, every proposed column `desktop`. Nothing in it targets the `web`, `ios` or
`android` column, and `Conformance/library/matrix.json` has NO `desktop` column, so
integrating this evidence moved zero matrix cells. Verified at integration:
`ruby ClosedSource/scripts/generate_library_matrix.rb --check` reports CHECK OK against the
unchanged committed file, and `ruby ClosedSource/scripts/check_library_matrix.rb --report`
prints the same 151 red cells across 56 components it printed before the capture landed.

That is the matrix-honesty law working as designed, not a shortfall of the lane. A Compose
Desktop capture is executed evidence about the Compose element layer on the JVM; the
`ios` and `android` columns mean a device, and only a device capture may fill them. The
sidecar is committed so the measurement is durable and reviewable the day a `desktop`
column is worth adding.

## The GAP LEDGER

Every knowingly-unfillable web limitation is a named row here with its
degradation. A divergence that is not a row is a BUG; adding a row is a ruling,
not a workaround - each addition needs the owner's sign-off in review.

| # | Gap | Why the web cannot fill it | Shipped degradation | Diff treatment |
|---|---|---|---|---|
| G1 | Platform fonts | The web has no San Francisco / Roboto license; `--dsx-font` resolves `system-ui`, so glyph widths, x-height and default line boxes differ per OS | The honest system stack (`system-ui, "Segoe UI", Roboto, sans-serif`) | Type metrics carry the platform tolerance; text-driven box drift rides the stage-2 box budget, never the color budget |
| G2 | Native materials (blur/vibrancy) | `backdrop-filter` approximates but never matches UIKit/Material material recipes, and the skin deliberately ships no glass (system-defaults.md: honest neutral, never fake-Cupertino) | Flat token surfaces; bar blur where the skin opts in is approximate | Screenshot diff only (budgeted); material regions are never color-exact between renderers |
| G3 | System-owned dynamic color | Native columns of `defaults/tokens.json` are SYSTEM SLOTS (dynamic Material You, vibrancy-resolved UIColor); the web column is a literal neutral palette | The web's committed literal values ARE its contract - exact on web, mapped by role on native | Token tables compare exact per renderer against its OWN column, never cross-column literal-to-slot |
| G4 | Scroll furniture | Scrollbars, overscroll glow/rubber-band and edge effects are UA-owned on web | Default UA behavior; fixtures keep content static so no scrollbar affects captured geometry | Excluded from the plane by construction |
| G5 | Focus ring idiom | The web focus ring (`:focus-visible`, `--dsx-focus-ring`) is a legal a11y requirement with no native twin in the same shape; a presented modal takes focus at rest (visible on `overlay-sheet` references) | The token ring stays | Native lanes mask focus-ring pixels in the screenshot diff; boxes are unaffected |
| G6 | Sub-pixel AA and compositing | Different rasterizers will never agree byte-for-byte | - | Screenshots are budgeted (`DSX_PARITY_PIXEL_BUDGET`), boxes carry tolerances; nothing in the contract is pixel-zero across renderers |

## Working rules

- A cross-renderer fidelity bug becomes a fixture here (or a sharper assertion in
  an existing one) in the same commit as its fix - the `Conformance/` law.
- New app-chrome or form-factor grammar lands with its representative screen
  added or extended here, fixtures first.
- The corpus is platform-count-agnostic: the reference plane is `reference/web/`
  today; the native lanes CONSUME it (stage 2) and never fork the fixture set.
