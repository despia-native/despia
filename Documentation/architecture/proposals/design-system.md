# The Despia design system — a premium default on every surface

Status: IN EXECUTION (the owner's ruling, 2026-08-17). Waves 1–2 LANDED (the token
contract + the full web skin; the AA contrast gate, the axe sweeps, the gallery, both
customization proofs). Wave 3 LANDED (the web gaps, Badge + Breadcrumb, the tooltip
attribute on all three kernels, the lottie web facet, the ladder recipes + amendment,
the CI axe pass). Wave 4 — the fidelity ruling, the owner's second ruling of 2026-08-17 —
is next and is RELEASE BAR. This document is the plan of record.

## The ruling

**A DSX app must look excellent by default.** Not acceptable, not neutral — excellent: the
quality bar a designed flagship app sets, met by an app whose author never wrote one style.
iOS already has this (SwiftUI), Android already has this (Material 3). The web renderer's
current "honest neutral skin" does not meet the bar and is hereby retired as a goal: web
gets its own crafted design language, as deliberate as the two native ones. Ugly-by-default
is a framework bug.

Two corollaries, both decided:

- **Native defaults stay platform-true.** iOS renders SwiftUI, Android renders Material 3 —
  those are the premium defaults on their platforms. The new design language is the WEB
  default. What becomes uniform across all three is the CUSTOMIZATION LADDER: the same
  tokens, the same override moves, the same replacement story on every renderer, including
  replacing a native platform default entirely when an app wants one brand look everywhere.
- **Quality is enforced by the defaults, not the linter.** Off-system styling stays a lint
  NOTICE (informational, never failing a build). The system wins by being the easiest and
  best-looking path, and by every scaffold, doc, and example being on it.

## Where the gap actually is

The theming architecture already exists and is sound — this program does not redesign it:

- Semantic adaptive colors on all renderers (`label · secondary · tertiary · background ·
  secondaryBackground · grouped pair · fill · fillFaint · separator · destructive`),
  resolving light/dark from the device, the app-wide appearance override, and subtree
  `theme=` pins (system-defaults.md).
- The white-label token plane `global.theme.*` (accent, dark swaps, strings) with the
  resolution law defaults ⊕ theme ⊕ per-call, token corpus in `Conformance/defaults/`.
- One precedence ladder: defaults < tokens < sheets < shared < `:native` < exact target,
  with explicit per-element ejection.

The gap is one layer: **the quality of the web default skin** (the CSS the dom package
ships for every element) and **the coverage of the component set**. Both are below the bar.

## Part 1 — Foundations (the token contract, all renderers)

One machine-readable token set (`Conformance/defaults/tokens.json` grows; every renderer
consumes the same file) emitted on web as CSS custom properties in `TOKENS_CSS`:

- **Color**: the semantic roles above, plus `accent` / `onAccent` / `accentMuted`, status
  roles (`success · warning · danger · info` + their muted surfaces), and derived
  interaction states (hover/pressed/focus tints computed from the base, so ONE accent write
  restyles every state correctly in both schemes).
- **Type ramp**: display / title-1..3 / headline / body / callout / footnote / caption,
  each with size, weight, tracking, and leading that the layout engine also measures
  (fixing, once, the measure-vs-paint drift found building the starter). Three roles were
  added 2026-08-25 when the design-system gate's burn-down proved the element layer could
  not say what it meant without them: **label** (the control label, weight 500 - Material
  labelLarge, Apple's control band), **caption2** (11px, the micro label under caption -
  Apple caption2, Material labelSmall), and **reading** (long-form body, 1rem at 1.7 -
  prose is not UI text). Two web-only families ship beside the ramp rather than inside the
  cross-runtime corpus, because neither has a native twin: the fluid size clamps
  (`--dsx-type-*-size-fluid`, since Dynamic Type and the Material scale already resize from
  the OS rather than the window) and the **glyph scale** (`--dsx-glyph-*`, which sizes a text
  glyph used as an icon - box geometry, not a position on the reading ramp).
- **Spacing**: a 4pt-grid scale (`space-1..12`); **radius** scale (control / card / sheet /
  full); **elevation**: shadow levels 0-4 tuned per scheme (soft, never murky in dark);
  **motion**: duration and easing tokens (fast/base/slow, standard/decelerate/spring),
  honoring `prefers-reduced-motion` globally, plus two PERIOD rungs for indeterminate loops
  (`--dsx-dur-loop`, `--dsx-dur-loop-slow`) that deliberately do not collapse, since a frozen
  spinner is not reduced motion; **focus**: one ring token (2px, offset, accent-derived,
  visible on any background) with an optional halo spelling derived from the same knobs.
- **Density and touch**: minimum 44px hit targets on coarse pointers, comfortable/compact
  density knob.

## Part 2 — The web skin (every element, states included)

A full pass over every element's default CSS in the dom package. A component is DONE only
with all of: rest, hover, pressed, focus-visible, disabled, and (where meaningful) loading
and error states; both schemes; coarse and fine pointers; RTL-safe logical properties.

- **Actions**: button roles (primary = accent, secondary, quiet, destructive) with real
  state layers and motion; icon buttons; link styles.
- **Inputs**: fields (border, focus ring, error + message, prefix/suffix icon slots,
  clearable), secure with reveal, multiline autogrow, picker/select, search field; form
  labels/help/error typography; validation styling tied to the existing `validate=` meta.
- **Selection**: toggle, checkbox, radio, slider, stepper, segmented control.
- **Containers**: card surface, grouped list language (the Settings idiom), separators,
  disclosure/accordion.
- **Navigation**: tab bar (bottom, mobile) and top tabs / sidebar (wide) from the same
  `<tabs>` document, nav/app bars with large-title behavior, breadcrumb.
- **Overlays**: sheet (scrim, spring, detents, focus trap, scroll lock), dialog/alert,
  popover, menu, tooltip, toast.
- **Feedback and data**: spinner, progress (bar + ring), skeleton, badge, chip/tag, avatar
  (+initials fallback, the starter already hand-rolls one), banner/callout, empty state,
  list/grid rows with hover and selection, basic table skin.
- **Typography defaults**: a real reading rhythm for bare `<text>` levels and `<markdown>`.

New components land grammar-first (a new tag is authoring surface, so fixtures precede;
web-only visuals of EXISTING tags are infrastructure and ship freely).

## Part 3 — Accessibility (non-negotiable, part of "done")

WCAG 2.2 AA as the floor, verified not claimed: correct roles/names/values on every
interactive element; full keyboard operation (tab order, arrow-key patterns in menus,
tabs, radios; Escape closes overlays); focus trap + restore in modals; visible focus
everywhere; AA contrast enforced IN THE TOKEN CORPUS (a contrast check runs over
tokens.json in CI, so a theme cannot ship illegible); `prefers-reduced-motion` and
`prefers-contrast` honored; touch targets ≥ 44px; screen-reader smoke of the starter's
flows. An automated axe-core sweep of the BUILT demo — the launcher, capability pages,
and every gallery section in both schemes (`scripts/a11y-demo.ts`) — runs in the
`web-kernel` CI lane on every PR; the full starter sweep (`scripts/a11y-sweep.ts`)
drives the live example's signed-in flows and therefore needs the running worker +
Supabase, so it stays a local/manual gate.

## Part 4 — Customization: two doors, both easy

**Small (minutes):** one `theme` block in `dsx.config.json` / `global.theme.*` — accent,
radius, density, font stack, per-scheme surface tint. Everything derives; both schemes stay
correct; native surfaces consume the same accent tokens today's white-label plane already
carries. `despia.appearance.set` keeps runtime light/dark/system.

**Large (a real redesign, still structured):** the skin ships as named, layered stylesheets
over public tokens and stable class hooks — replace a layer (just buttons), extend via the
sheets level of the ladder, or swap the whole skin for your own while keeping tokens,
a11y behavior, and layout. On native, the same move is component-set replacement (the
module system already allows shipping alternative component implementations); the ladder
document gains the explicit "replace a platform default" recipe for all three renderers.
Ejection (`appearance="custom"`) stays the per-element escape hatch — noticed, never blocked.

## Part 5 — Proof and enforcement

- **A gallery route** (`/system`, shipped in the docs site and the dev server): every
  component in every state, both schemes, three widths — the living spec and the visual
  regression surface (screenshot-diffed in CI like the existing layout oracle).
- The starter and the docs re-shot on the new skin; one accent-swapped and one
  full-replacement demo prove both customization doors.
- The a11y sweep + token contrast check join `web-kernel` CI.
- Scaffolds (`npm create dsx`) and every doc example use system components only.

## Sequencing

1. Foundations: tokens v2 + the text measure/paint fix + focus/motion plumbing.
2. Core six at full quality (button, field, form, list row, card, tab bar) + the gallery.
3. Overlays + selection + feedback set; a11y sweep green.
4. Missing components (toast, skeleton, menu, popover, avatar, badge, segmented, progress).
5. Customization doors documented + demos; ladder doc gains the replacement recipes.
6. Starter/docs re-skin shots; constitution amendment replacing "honest neutral skin" with
   this design language.

## Wave 3 — the component program (inventory-verified)

Measured 2026-08-17 against the element census (`reference/stack-elements.json`: 89 rows,
78 visual after the 11 head/contract tags), the dom package's registration tables
(`elements` · `forms` · `native-controls` · `overlay-controls` · `data-controls` ·
`structural-controls` · `application-controls` · `globals` + `mount.ts`), and the
Foundation component set. Three classes; this supersedes the guessed list in
sequencing item 4.

**(a) In the grammar and skinned on web now — 66 elements + the shared component set.**
64 of the 78 visual census elements are registered and skinned in the dom package, plus
the web-first `markdown` and `scene` (census rows deliberately pending native parity).
The shared Foundation markup components (Avatar · Banner · Callout · Card · Chip ·
EmptyState · FAB · NavBar · SettingsRow · VipCard · AuthLogin · AuthSignup + the System
screens) are pure markup, so they render on all three renderers by construction. Nearly
every "missing component" candidate is in fact present — verified: skeleton (`Skeleton`),
menu (`menu`/`contextmenu`), popover (`popover`), segmented control (`segmented` +
`segmentedButton`), progress bar + ring (`progress` + `ProgressRing`), search field
(`searchbar` — real composite anatomy, `elements.ts`), dialog vs sheet (`alert` +
`confirmDialog` vs `sheet`), avatar/chip/banner/callout (Foundation Core), and toast:
`Core/Toast` is a module action — `dsx.module.toast.show({ text, style, position,
duration })` — with swift, kotlin AND web facets; transient feedback is deliberately
imperative, never markup.

**(b) In the grammar, missing on web — 14 tags, three of them work items:**

1. `<node>`/`dynamic` — no web factory; falls to the `<node>?` unsupported box instead of
   the grammar's "unknown tag renders nothing". Fix `packages/dom/src/mount.ts`: resolve
   the `tag=` indirection before factory lookup; a bare `<node>` renders its children.
2. `<DSXView/>` / `<DSXWebView/>` — the surface tags resolve natively but hit the
   unresolved-component warning on web, where the router-painted frame is already the
   DSXView analogue and embedded pages ride the registered `<WebView>`. Fix: register both
   as honest mappings in `packages/dom/src/elements.ts` (router wiring in `router.ts`).
3. `<lottie>` — module element with no web facet (`Core/Lottie` ships swift/kotlin only).
   Fix in the module, not the kernel: a web element facet under
   `ClosedSource/DSX/Modules/Core/Lottie/web/` (the same facet path Toast's actions use).

The remaining ten — `Godot`, `LevelMeter`, `Waveform`, the five `Studio*` tags, `Scene3D`,
`Scene360` — are module-owned and native-first by decision (the parity ledger
`Conformance/elements/elements-gaps.json` classes them `module`/`dclass`); on web they
render the honest `dsx-unsupported` placeholder and follow their module roadmaps, not
this program.

**(c) Absent from the grammar — three, each grammar-first (fixtures precede code):**

1. **Tooltip** — a universal ATTRIBUTE, not a tag: `tooltip="text"` (+ `tooltipSide`,
   default `top`) on any element, joining the input grammar beside `on:hoverStart` /
   `shortcut`. Shows on hover-intent and keyboard focus under a real pointer; on touch it
   never fires (Article 7 degradation — content is never gated behind it); no events;
   a11y = `aria-describedby` on web, the platform hint slots native. Corpus:
   `OpenSource/Conformance/input/tooltip.json` → TS (`packages/dom/src/mount.ts`
   wireCommon + the existing `dsx-floating-layer`) → Kotlin → Swift, per the
   unified-codebase law.
2. **`<Badge>`** — count/dot status: `value` (number/string; `max` folds to `99+`),
   `dot`, `color` (default `destructive`), no events; anchoring composes via the parent
   stack's `align` (the Avatar status-dot idiom). A pure-markup Foundation component
   (`Foundation/Components/Core/Badge.dsx`), so ONE implementation serves all three — the
   gate is its components row in `stack-elements.json` + the one-utterance a11y contract,
   not the three-renderer ladder. (`tabBadge` on `<tabs>` children already exists
   everywhere and stays as-is.)
3. **`<Breadcrumb>`** — Part 2 names it; verified absent. `bind` (rows of
   `{ label, path }`), `separator` icon; prior rows navigate via `href`, the last row
   reads as the current page. Also a pure-markup Foundation component
   (`Foundation/Components/Core/Breadcrumb.dsx`) + census row.

Order of work: (b) 1–3, then (c) 1 — the only new cross-renderer grammar — then (c) 2–3.

## Wave 4 — the fidelity ruling (the owner's second ruling, 2026-08-17; RELEASE BAR)

### The ruling, sharpened

The wave-1/2 skin passes its gates and still reads as a generic framework default. That is
not the bar. The bar is the one the native defaults set: unstyled SwiftUI is beautiful,
animated, and finished; unstyled Material is the same; unstyled web is trash that DESPIA
must fill. The web default is therefore judged like a flagship component library, not like
a stylesheet: opinionated form factors, motion built into every interactive component, and
an app that LOOKS like an app on a phone. "Bootstrap look" is a defect. This is release
bar, not roadmap.

Three corollaries:

1. **Motion is part of the default.** Every interactive component ships its animation the
   way SwiftUI components do — subtle, spring-based, instantly interruptible, collapsed
   under prefers-reduced-motion. No opt-in.
2. **Mobile-first app chrome.** Inside the app shell (`<tabs>`, routed screens) the web
   render is an APP: nav-bar idiom, full-bleed grouped lists, full-width primary actions,
   safe-area insets, touch density. Landing-page composition belongs to landing pages.
3. **The parity contract.** A DSX screen authored for native renders near-pixel-perfect
   (within web platform limits) on web; the same screen authored on web renders perfectly
   on native; web-default styling arrives on native as custom styling over native
   components. One renderer's output is a prediction of the others'.

### Motion system (tokens first — theme.ts)

- **Spring easing, real.** Two new easing tokens beside the existing duration/curve set:
  `--dsx-ease-spring` (standard settle, subtle overshoot) and `--dsx-ease-spring-soft`
  (barely-there bounce for large surfaces). Implementation: CSS `linear()` spring curves
  (generated, ~24 stops, damping-ratio ≈ 0.8 / 0.9) with `cubic-bezier(0.34, 1.56, 0.64, 1)`
  and `cubic-bezier(0.22, 1.2, 0.36, 1)` fallbacks behind `@supports`. This is the "very
  very subtle bounce" — overshoot on transform only, never on color/opacity.
- **Press standard.** Buttons/rows: `scale(0.97)` on press, `transform-gpu`,
  `--dsx-duration-fast` down, spring back up. Selection controls (checkbox/radio): wrapper
  `scale(0.95)`. Press scale NEVER on text inputs.
- **State-change standard.** Color/background transitions `--dsx-duration-base` ease;
  transform transitions spring; opacity linear. One utility block defines the property
  lists (background · transform+colors+opacity · transform+opacity) so components share
  identical timing.
- Reduced-motion: the existing global collapse stays; check that spring `linear()` curves
  are inside it.

### Component form factors (forms.ts, elements.ts, native-controls.ts)

- **Switch — the web polyfill.** Web cannot host UISwitch or the M3 Switch, so the
  unstyled web default is an iOS-26-ish capsule, not a hosted system control: 63×28
  track (compact 51×24 via density), 36×24 pill thumb (not a circle) with 2px inset,
  full-round, glass-free. Thumb is white with shadow-1 in both schemes; track
  crossfades fill → `--dsx-control-tint` / `--dsx-switch-on` (`--dsx-duration-base`).
  Authors restyle through the tokens (`--dsx-toggle-*`, `--dsx-field-toggle-*`,
  `--dsx-control-tint`) or `color=`. No Apple green, no glass. iOS still hosts
  UISwitch; Android still hosts the M3 Switch when unstyled and the legacy 51×31
  capsule when styled. THE DETAIL: on press the thumb STRETCHES +6px horizontally
  (width grows, height keeps), anchored to the near edge — when checked+pressed the extra
  width grows toward the center (margin compensation) — and on release travels with
  `--dsx-ease-spring`. Keyboard: same animation on Space. 44px touch target via padded
  hit area.
- **Checkbox.** 20px rounded-square (radius ~6px), 2px border in rest; on check: fill
  scales in 0.5→1 + fades in (200ms), then the check DRAWS — SVG polyline
  (points "1 9 7 14 15 4" scaled to our 14px icon box), stroke-dasharray 22,
  dashoffset 66→44 over 250ms linear with 200ms delay. Uncheck reverses instantly (no
  ceremony on exit). Wrapper press scale 0.95. Indeterminate: horizontal bar, same fill pop.
- **Radio.** Outer ring color transition; inner dot springs 0→1 with `--dsx-ease-spring`
  (the one visible bounce); press scale 0.95.
- **Slider.** Thumb grows ~1.15× while dragged (spring back), track fill animates,
  optional value bubble later. **Stepper.** Press scale on each button, value change
  micro-slide. **Segmented.** The selected thumb SLIDES between segments with
  `--dsx-ease-spring` (no teleporting), labels crossfade weight.
- **Buttons.** Height ramp 32/40/48 (compact/regular/large; regular = default 40px,
  full-round-capable), press scale 0.97, hover = subtle brightness lift not opacity-fade,
  focus ring unchanged. **WIDTH LAW (the reported defect):** a button that is a form's
  submit control, or a direct child of a vertical `<stack>` on a compact viewport, defaults
  to `width: 100%` (`align-self: stretch`); buttons inside `<hstack>`/toolbars/inline flow
  keep hugging. The starter's sign-in and settings buttons must go full-width from the
  DEFAULT, with their hand styles removed.
- **Fields.** Focus = ring + border color lift + label color shift, all `--dsx-duration-base`;
  error state shake is NOT wanted (too loud) — error = color + message slide-in 4px.
- **Overlays.** Sheet/dialog/menu/popover enter with spring translate/scale (sheet:
  translate-up spring-soft; dialog: scale 0.96→1 + fade; menu/popover: scale from anchor
  origin 0.95→1); scrim fade linear. Toast slides+springs from its edge.

### App chrome (the "looks like a landing page" defect)

- `<tabs>` on compact web = a real app frame: the tab bar gets the refined treatment
  (blur-backed bar acceptable, no glass), safe-area-inset-bottom padding, active-tab
  transition (icon micro-pop + label weight), panes slide/fade on switch (subtle, spring).
- Nav-bar idiom for routed screens: sticky top bar with title (large-title style at rest
  collapsing to inline on scroll where the page opts in), back control on pushed routes.
  Ship it as the default look of the existing screen/scroll+title composition in the app
  shell, not a new tag (grammar-first law applies if a new tag is wanted later).
- Grouped list language: full-bleed cells, inset separators (leading-aligned), chevron
  affordance, press state on rows (background flash, not scale), swipe actions later.
- Density: compact pointer = app density paddings; fine pointer/desktop = the existing
  roomier scale. `env(safe-area-inset-*)` respected on the shell edges.
- The starter re-skinned to SHOWCASE the defaults: remove hand styling the defaults now
  own (button widths/radii/paddings, card backgrounds where the grouped language covers
  them). The landing page stays a landing page; the app area becomes an app.

### The parity contract (release bar, measured not vibed)

Definition: for every fixture in a cross-renderer corpus, the three renders of the same
.dsx agree on (1) layout boxes within tolerance, (2) resolved semantic colors exactly,
(3) type ramp metrics within platform font tolerance; and web-authored custom styling
re-renders on native as the same custom styling over native components (the existing
tokens/sheets ladder is the carrier — same inputs, same resolution law).

Measured form, staged honestly:
1. NOW (this wave, local): the layout oracle generalizes to a parity corpus
   (`Conformance/parity/` fixtures: representative screens incl. the starter's) with
   web-side reference metrics + screenshots committed as the reference plane.
2. CI: the Android `:render` lane replays the same fixtures and diffs layout metrics +
   screenshots against the reference plane (budgeted diff, not pixel-zero — fonts and
   AA differ); the iOS record/mac lane joins with the same harness. A failing diff is a
   failing build once both lanes are live.
3. The gap ledger: every knowingly-unfillable web limitation (platform fonts, exact blur,
   native materials) is a named row with its degradation, not a silent divergence.

### Verification for this wave

Everything existing stays green (375+ dom tests, conformance, contrast gate incl. any new
tokens, a11y sweep zero serious/critical, both walks). New: motion is testable — unit
tests assert the computed transition/animation properties per component state; the gallery
gains a motion section; re-shot starter + gallery, light and dark, plus a slow-mo
switch/checkbox capture set for review. Token contrast gate re-run over any new/changed
color tokens.


## Amendment, 2026-08-25 - the ruling governs author styling; the element layer is gated

Wave 4's foundations landed and then did not hold. This amendment says why, and narrows one
sentence of the original ruling so the same thing cannot happen again. The full diagnosis is
`architecture/runtime-pressure.md` R22; this is the operative part.

### What the original ruling said, and what it meant

> **Quality is enforced by the defaults, not the linter.** Off-system styling stays a lint
> NOTICE (informational, never failing a build). The system wins by being the easiest and
> best-looking path, and by every scaffold, doc, and example being on it.

That is correct and it stands **for author styling**. An app author who reaches past the
system is exercising a freedom this framework deliberately protects, and a build that fails
over it would be a framework telling its user what their app may look like.

It was read one word wider than it was written. The framework's own element sheet - the CSS
the dom package ships inside `@layer dsx-elements` - is not styling that sits off the system.
**It is the defaults the ruling relies on.** A literal there is not freedom being exercised;
it is the default plane disagreeing with itself, and the ruling's whole argument (the system
wins because it is the best path) presupposes that the default plane is one thing.

### The narrowing

- **Author styling**: unchanged. A lint NOTICE, informational, never failing a build.
- **The framework's element layer**: held to the corpus by a gate. A literal `font-size`,
  `font-weight`, `line-height`, `letter-spacing`, `box-shadow`, `border-radius`,
  `cubic-bezier()` or transition duration inside `@layer dsx-elements` fails the build, the
  same way a raw hex or `rgb()` already does.

The evidence that the gate is the deciding variable and not the diligence: color is the one
foundation axis with a gate, and color is the one axis that did not drift. Every ungated axis
drifted, two of them into rival token families for a single concept.

### What the gate needs, and therefore what grows

A gate can only reject a literal if a token exists to replace it, so the corpus grows from one
axis to five - `type`, `elevation`, `state`, `shape` and `motion` join `tokens.json` in
`Conformance/defaults/`, in the same shape and under the same law: native columns are role
names because the OS owns the value, only web carries literals because the web has no system
to inherit from, and every renderer consumes the same file.

Three of those axes are new because they never landed at all: the type ramp's **leading**
(without it a component must hand-type `line-height`), the **density** knob, and the **state
layer**, whose absence is the largest single hole in the skin - 144 hand-written interaction
recipes where one law belongs.

### The exemption discipline

A gate with a generous exemption list is a gate that has been talked out of its job. Every
exemption is a named entry with one line of justification, and the list is read on review. A
circular avatar's `border-radius: 50%` is a real one-off. A frozen computed number is not.

### What does not change

Native defaults stay platform-true. The customization ladder stays uniform across all three
renderers. Off-system styling in an app stays a notice. Neutral was always a palette decision;
it was never a licence for the absence of a system, and Part 1 never read that way.
