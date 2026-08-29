# System defaults — the unstyled baseline IS the platform (PROPOSAL, research-ratified)

> Status: ACCEPTED direction (user-ratified rule + two research reports, 2026-07-19).
> This document is the implementation spec. The research: an external-precedent study
> (Flutter/RN/Ionic/SwiftUI/M3/web platform) and a full repo styling-pipeline map.
> **Amended 2026-08-17** (the design-system ruling, `proposals/design-system.md`): the WEB
> unstyled baseline is the crafted **Despia design language** — premium by default,
> token-derived, AA-contrast-enforced in CI — superseding the "honest neutral skin" goal
> this document first ratified for that row. Native baselines stay platform-true; the
> precedence ladder and explicit ejection are unchanged. The Web row and the token
> vocabulary below carry the amendment inline.
> **Amended 2026-08-20** (the library-grade ruling, owner-ratified from real device
> builds): "the platform's own component" means the platform's **library-grade** default,
> never its bare minimum — see "Library-grade, not bare minimum" below for the three
> rules (the field well / filled field, the animated system control, all renderers rise
> together).

## The law

**Defaults live in the RENDERER.** An element with no author styles renders the
platform's own system component on every target:

| Target | Unstyled baseline |
|---|---|
| iOS | real SwiftUI defaults — `List` `.automatic` (insetGrouped), borderless accent buttons, `.body` Dynamic Type, semantic `UIColor` slots, system sheets/chrome. Liquid Glass arrives by inheritance, never re-specification. |
| Android | Material 3 under `dynamicColorScheme()` (static M3 fallback < API 31) — M3 `ListItem`/`Switch`/`TextButton`…, theme roles. |
| watchOS | real watch SwiftUI defaults — a real `List` at `.listStyle(.automatic)` (the watchOS platter rows), the system body type ramp / semantic label colors, the watch's own bordered `Button`, the native `Toggle` switch, and real system chrome: `NavigationStack` + `.navigationTitle` (the OS draws the clock and the back chevron). **Not implemented:** `.carousel` (or any other explicit list style) — `.automatic` is the only style `StackWatch` selects; there is no markup word for the others. |
| Wear OS | the REAL Material-for-Wear components (`androidx.wear.compose:compose-material` + `compose-foundation`, pinned + checksum-verified like every other coordinate): unstyled `button` → `Chip`/`OutlinedChip`, `toggle`/`switch` → `ToggleChip` + the system switch glyph, the screen's spine `list` → `ScalingLazyColumn` (real scaling/fisheye, the platform's content padding and rotary scroll), the screen `title` → `ListHeader`, and the chrome → `Scaffold` + curved `TimeText` + `PositionIndicator` + `Vignette` + `BasicSwipeToDismissBox`. The two-path ladder is the phone's: any authored chrome (`bg`/`radius`) keeps the legacy hand-drawn painter byte-identically. **Ratified divergences** (Wear Compose has no equivalent — declared in the `StackWear.kt`/`WearSystem.kt` headers, the wheelpicker/calendar precedent): no PASSIVE row container (every Wear row container requires `onClick` and reports the button a11y role), so a plain-data list row keeps the hand-drawn platter; no LINEAR progress, so `<progress>`/`<gauge>` stay hand-drawn; and a NESTED `<list>` keeps the platter column, because a lazy list may not nest inside a vertical scroll (the phone's `LocalInScrollContainer` physics). |
| Web | the crafted **Despia design language** *(amended 2026-08-17, `proposals/design-system.md` — supersedes the "honest neutral skin" this row first ratified)*: premium by default, token-derived, AA-contrast-enforced in CI (the token contrast gate + the axe sweep). The mechanics stand: `color-scheme: light dark`, `system-ui`, `light-dark()` token pairs (EMITTED as `@media (prefers-color-scheme: dark)` + `[data-dsx-theme]` pin-table twins — the stamped Safari 16.4 browser floor predates `light-dark()`, which needs 17.5), real form controls + `accent-color`, the full token-derived component skin (`@layer dsx-tokens, dsx-elements`) — and still **never fake-Cupertino** (Ionic's disavowed mistake): the web default is its OWN deliberate design language, never an imitation of a platform it cannot host. |
| macOS | the full-inherit column, like iOS (desktop-platforms.md): the Mac build hosts REAL system components (Catalyst/AppKit-backed SwiftUI), so the same semantic `UIColor` slots resolve natively and looks self-update with the OS. Mac chrome (menu bar, window scenes, toolbars) is real system chrome owned by modules. |
| Windows | HONEST NEUTRAL (the desktop Compose lanes keep the neutral goal; the web row's 2026-08-17 amendment does not reach them) — Compose cannot HOST WinUI controls, and a re-specified system look rots, so **never fake-Fluent**. The neutral desktop scheme carries the android-shaped M3 roles; REAL system signals feed it (OS dark mode; the Windows accent color seeds `primary`) and window frames / file dialogs / IME stay real system chrome. |
| Linux | HONEST NEUTRAL, same scheme as Windows — **never fake-Adwaita** (no single system toolkit to imitate anyway). OS dark mode feeds the scheme; window chrome and portals stay the desktop's own. |

Corollary (the iOS-26 lesson): the framework never re-implements a system control it
can host, and never encodes a system look as authored style values — inherited looks
self-update with the OS; re-specified ones rot.

## Library-grade, not bare minimum (AMENDED 2026-08-20 — owner-ratified from device builds)

The law said "the platform's own system component"; testing real builds exposed the
loophole: a rendering can be technically the platform's and still be nothing anyone
would ship. A bare SwiftUI `TextField` with no padding and no fill IS SwiftUI — and it
is wrong. The unstyled baseline is the platform's **library-grade** default: what the
platform's own design library shows on its cover, not the least the API returns.
Three rules give that teeth:

1. **The field-well / filled-field rule.** An unstyled text input never renders bare.
   Each renderer ships its platform's dressed field: on Android the Material 3 FILLED
   `TextField` — the container-fill, floating-label field every design library leads
   with (the outline-only variant is not the default; no `variant` word exists on the
   text inputs, so minting one is corpus-first new grammar, and until then filled IS
   the path); on iOS the secondary-fill WELL — the grouped-form idiom: continuous
   rounded rect on `secondarySystemFill`, comfortable padding, the 44pt floor, an
   accent ring while focused (`DSXInputWell`, shared by textfield · textarea ·
   `<field>`, standing down inside the system `Form`, whose inset-grouped rows already
   are the field chrome); on web the recessed token well this document's 2026-08-17
   amendment already ratified. The searchbar capsule and the boxed OTP digits are the
   same rule already obeyed.
2. **The animated-system-control rule.** A system control's STATE MOTION is part of its
   identity: a switch that does not glide is not the platform's switch, whatever
   component name it carries. The unstyled path must preserve the platform component's
   own motion end-to-end through the framework's store round-trip (the reproduced
   killer: material3's pressed-tap SnapSpec race — `SystemSwitch`'s one-frame checked
   mirror, oracle-pinned in `DesktopSwitchAnimationUiTest`), and an ejected/legacy
   control may not snap where iOS's always-native control animates (the Android legacy
   toggle capsule now travels its thumb; iOS renders `UISwitch` on every path).
3. **The all-rise rule.** The renderers hold one quality bar, currently set by iOS:
   every renderer reaches the best renderer's fidelity, and when one rises, all rise.
   A polish landed on one target is a parity obligation on the other two, not a
   divergence to pin — pinned divergences remain only for genuine platform-idiom
   differences (a filled M3 field vs an iOS fill well is the same rule expressed in
   two dialects), never for effort not yet spent.

## Native identity is a release invariant

“Looks native” is not sufficient. On a platform where the framework can host the system
component, the unstyled path **MUST call that component directly**: SwiftUI controls and
containers on Apple platforms, and Material 3 components on Android. Foundation primitives
(`Stack`/`VStack`/`HStack`, Compose `Box`/`Column`/`Row`) are layout tools only; they must not
recreate a system control’s surface, shape, typography, separator, touch target, or bar chrome.
Use a layout primitive only where composition actually requires layout and the platform exposes
no higher-level container for that job.

Every native-identity guard is mutation-tested: temporarily replace the platform component with
a drawable/layout imitation, observe the guard fail, then restore it. Simulator screenshots are
useful visual evidence, but component identity plus compilation is the release contract.

`SettingsRow` is the reference composite for this rule. One shared DSX wrapper delegates its
native body to SwiftUI `LabeledContent`/`Button` on Apple platforms and Material 3 `ListItem` on
Android; only the web branch keeps the DSX/CSS composition. Within an Android system list, DSX
text also resolves the existing `a11yTrait="header"` semantic to Material headline typography
and ordinary copy to Material supporting typography. Renderers must not infer those roles from
child order or page-specific tags.

## Staying in system space: variants before styles

Semantic words select AMONG system renderings without ejecting:
`variant="bordered" | "prominent"`, `role="destructive" | "cancel"` — mapping to
`.bordered`/`.borderedProminent`/destructive on iOS, `FilledTonal`/`Filled`/error on
Android, and tonal/filled/danger skin on web.

> **Wrist status: LANDED on Wear and watchOS.**
> **Wear (`StackWear.kt` + `WearSystem.kt`) consumes both words**, on the wrist's own three chip
> weights: no word → `ChipDefaults.secondaryChipColors()` (the surface chip — Wear Material's own
> baseline row), `variant="bordered"` → `OutlinedChip` + `outlinedChipColors()`,
> `variant="prominent"` → `primaryChipColors()` (the filled chip), `role="destructive"` → the error
> tones on whichever weight is selected, `role="cancel"` → the dismissive SemiBold label (the
> phone's `FontWeight.SemiBold`, the web's 600). `BUTTON_ROLES` is exactly `{destructive, cancel}`,
> the phone/web set verbatim; every other `role=` stays an accessibility role, and an unknown
> `variant=` keeps the base rendering (the web's unmatched-variant rule). Pinned divergence from the
> phone ladder: the phone's baseline is the BORDERLESS `TextButton`, so `bordered` maps to its tonal
> tier — a wrist has no borderless tier (the baseline row IS a filled surface chip), so mapping
> `bordered` to tonal would make the word INERT; the wrist ladder is therefore surface → outlined →
> filled, and every word still selects a real, visibly distinct system rendering. Corpus-free by
> construction (no new authoring surface: these are the words this doc already ratified), and the
> pure grammar is plain-JVM asserted — `wear/src/test/.../WearSystemTest.kt`.
> **watchOS (`StackWatch.swift`) consumes both words** using native SwiftUI:
> no variant inherits the watch's system button style, `bordered` selects `.bordered`,
> `prominent` selects `.borderedProminent`, and the two role words map to `ButtonRole`.
> `cancel` supplies the same dismissive semibold label weight as the other surfaces unless the
> author supplied `weight`. Unknown words keep the inherited default. A button with authored
> `bg`/`radius` still ejects to the plain custom path, and a direct native List row stays a
> single plain row control rather than nesting a styled button platter.

## The precedence ladder (one ladder, all targets)

```
1. renderer system defaults        (web: @layer dsx-tokens, dsx-elements)
2. app theme tokens                (theme.css / dsx-theme — recolors system components)
3. component sidecar sheets        (owner-scoped, dsx-sheets)
4. shared author styles            (inline style / attrs)
5. :native-suffixed author styles
6. exact-target suffixes           (:ios / :android / :web / :watch / :wear) — always win
```

5–6 fold at parse/compile (exact > `:native` > bare — web/14's ratified rule; RN's
select precedence). Target resolution is compile-time and NEVER nests with runtime
media/state (the Tamagui bug class).

## Replacing a platform default — the recipes (the "Large" door, all three renderers)

The ladder makes replacement a LEVEL, not a fork (design-system.md Part 4 names the two
doors: the token door recolors the system components in minutes; this section is the
full-replacement door — change what an unstyled element IS while keeping tokens, a11y
behavior, and layout). One recipe per renderer, each riding a mechanism that already
exists — nothing here is new machinery.

**Web — the layered-sheet door.** On web the skin is CSS in named layers and the layer
order IS the ladder: `@layer dsx-tokens, dsx-elements, dsx-theme, dsx-sheets, dsx-inline,
dsx-attrs`. A package's declared stylesheets fold into `dsx-theme` — ladder level 2, the
application's design layer (`packages/compiler/src/registry.ts`) — which beats the
kernel's `dsx-elements` skin by construction: no `!important`, no selector wars, and a
component's own sidecar sheet (level 3) still wins over it. Declare the sheet in the
package's `dsx.json`:

```json
{ "web": { "styles": ["web/theme.css"] } }
```

then restyle over the public tokens and the stable class hooks (`.dsx-button`,
`.dsx-toggle`, `.dsx-segmented`, …). Replace ONE layer — a buttons-only sheet:

```css
/* web/theme.css — folded into @layer dsx-theme at build */
.dsx-button {
  border-radius: var(--dsx-radius-lg);
  background: var(--dsx-fill);
  font-weight: 600;
}
```

or re-derive everything the accent feeds with a tokens-only sheet (redeclare the family
under your dark pin twin when the brand needs a different dark accent — the same
emission shape the Web row above describes):

```css
:root, :host, [data-dsx-theme] {
  --dsx-accent: #6d28d9;
  --dsx-accent-hover: #5b21b6;
  --dsx-accent-pressed: #4c1d95;
  --dsx-accent-muted: rgba(109, 40, 217, 0.12);
}
```

Both shapes are browser-verified (the design-system wave-2 customization proofs: an
accent-only sheet, and a buttons-only `.dsx-button` restyle that left every other
element on the stock skin). A declared sheet that does not exist FAILS the build
(registry.ts throws) — a stylesheet that silently vanishes has no failure surface at
all. The full-skin swap is the same door at full width: restate every element class
over the tokens; scheme correctness rides the `--dsx-*` pairs, and the token contrast
gate + axe sweep in CI hold the AA floor over whatever you ship.

**iOS + Android — component-set replacement through the module system.** On native the
unstyled element IS the hosted platform component, so a replacement is not a stylesheet
— it is an alternative COMPONENT implementation, and shipping those is an existing
module capability (constitution Article 2: components are one of the things a module
defines). The recipe:

1. Ship a components-only module (`Skills/writing-a-module.md`, "Decide the kind"): a
   folder whose `Components/` holds your `.dsx` implementations — scheme-less, so the
   components are global tags. A pure-markup component renders on ALL THREE renderers
   from one file (the Foundation set — `Modules/Mandatory/Foundation/Components/` — is
   the shipped precedent); a component whose essence is platform machinery takes the
   native-component shape instead (`Skills/native-components.md`: one tag, Swift/Kotlin/TS
   twins, contract-first).
2. Compose the app out of those tags (`<BrandButton/>`, `<BrandCard/>`). Inside the
   component, authored styles sit at ladder levels 3–4 and take the wrapped element off
   the system path — that is the point of a replacement: declare it with
   `appearance="custom"` (the ejection contract below) so the intent is stated and the
   lint notice stays quiet.
3. Swapping sets is the file-presence law, never an edit: an excluded module's
   component files are dropped by `prepare_modules`, so a per-app Custom module
   replaces the stock set build-by-build — the same on/off switch every other module
   capability rides.

What neither door changes: the token vocabulary (a replacement consumes the same
semantic tokens, so runtime light/dark and subtree `theme=` pins keep working), the
a11y contract (roles, names, focus, hit targets — the CI floor applies to the
replacement too), and the ladder itself — levels 5–6 still beat your replacement,
because exact-target suffixes always win.

## Ejection is explicit, never silent

`stack-style-properties.json` gains per-property `systemPath: compatible | ejects`.
Compatible tweaks (tint, weight, padding) apply ONTO the system component; an
`ejects` property (e.g. `background` on a system list row) switches that element to
the custom path with a LINT NOTICE naming the trade; `appearance="custom"` states
intent and silences it.

> **LANDED (2026-07-20).** The mechanism's shape:
> - **The catalog field** — every property in `stack-style-properties.json` carries
>   `systemPath` (73 classified: geometry-that-composes/lifecycle/a11y/`variant` =
>   `compatible`; everything that paints or reshapes — `background`, `radius`, `font*`,
>   `spacing`, `align`, `opacity`, `shadow*`, `offset*`, … = `ejects`). Aliases inherit.
>   `color` is classified `ejects` universally; the reconciled button gate's word-opt-in
>   (compatible tint ONLY under `variant`/`role`) is modeled in the checker, not the field.
> - **The gate cross-check** — `check_style_catalog.rb` parses the five renderer gate
>   word-sets out of source and fails on drift: the iOS List allowlist (⊆ structural ∪
>   compatible), the watch spine set + button authored-box pair and the wear list set +
>   chip pair (eject direction: every word maps to an `ejects` property, short spellings
>   via an alias map, the padding family as the documented wrist-conservative exception;
>   watch and wear identity-locked), and Android `SystemButton` (SAFE_BASE ⊆ structural ∪
>   compatible, LAYOUT ⊆ compatible, word-gated extras exactly {color, iconSize}).
>   Missing/unknown `systemPath` is an error — a new property cannot ship unclassified.
> - **The notice** — `lint_dsx.rb` emits a `notice` (printed, never counted by `--strict`)
>   when a `<list>` on the system path, or a `<button>` carrying a system word
>   (`variant=` / `role="destructive|cancel"`), also carries an `ejects` attribute —
>   naming the attr and the trade; `appearance="custom"` on the element silences it.
>   Toggle is not in the notice set until a renderer gates it on styling.

## Per-target divergence — three sizes

1. property → attribute suffix (`style:web="max-width:640px"`; ratify `:android`,
   `:watch`, `:wear` alongside the existing `:ios` — LANDED with the desktop set:
   the full ladder `exact > :desktop > :native > bare` and the vocabulary
   `ios android web watch wear macos windows linux desktop native` are implemented
   on all three kernels, pinned by `OpenSource/Conformance/platform/platform.json`).
2. rule set → `<style target="web">…</style>` head blocks (compiled into the owning
   layer, same fold).
3. different design → file qualifiers (`Card.web.css`) + the facet folders
   (file-presence law: divergent bytes absent from other targets' builds).

## Conformance (fixtures first — the unified-codebase law)

- `OpenSource/Conformance/defaults/tokens.json` — the semantic-token mapping corpus:
  word → UIColor slot / M3 role / Wear role / CSS `--dsx-*` `light-dark()` pair.
  All renderers consume it (the api-blocks.json shape).
- Per-element system-default fixtures: unstyled markup → resolved-defaults descriptor
  per target (component identity + token slots — never pixels).
- A precedence fixture exercising the full ladder on every runtime.

## Token vocabulary (shared; values per target from the corpus)

`label · secondary · tertiary · background · groupedBackground ·
secondaryGroupedBackground · fill · separator · accent · destructive` —
iOS/watchOS: UIColor semantics; Android/Wear: M3/Wear roles (`label→onSurface`,
`accent→primary` from dynamic color); web: `light-dark()` pairs from the Despia
design-language palette (amended 2026-08-17 — AA-held by the token contrast gate in
CI; root surfaces may ride `Canvas`/`CanvasText` so forced-colors works free).

## Migration order (per the research)

1. Renderer defaults land INERT (author styles sit above defaults — existing apps
   unchanged by construction). Corpus → web (fast loop) → Kotlin (gradle-gated) →
   Swift/watchOS (compile-pending).
2. Variant words land.
3. The demos flip to unstyled-first — the living proof on every target.
4. Hex → tokens; intentional pins stay (`theme="dark"` on designed-dark screens).
5. Lints: raw-hex-in-markup warning; "equals the default — delete it" nudge; the
   ejection notice.

The Android route-frame backdrop rides the `background` role per the law (the pre-law
`Color.Black` canvas was an Android-only divergence — iOS paints clear over its system
background); pages that composited on the legacy black canvas author their background
or pin theme.

## The watch demo (user directive: "the real deal")

The wrist demo (WatchApp/BundledScreens, rendered by StackWatch on watchOS and the
:wear Compose runtime) is redesigned as a REAL watch app: unstyled-first on the new
wrist defaults, real icons (SF Symbols / Material Symbols via the bundled icon font),
real watch patterns (scaling list feel, wrist-legible type ramp, circular-crop-safe
layout, one action per screen, glanceable status), unified across watchOS + Wear —
the same .dsx bytes, each wrist's own system look.

## Gates this law extends

`check_style_catalog.rb` (new attrs/variant words + `systemPath` flags) ·
`lint_dsx_css.rb` + dsxcss parser (target-scoped blocks) · `compile_dsx_css.rb`
(layer emission) · Android `ElementSpec.kt` parity corpus + render suite · web
tokens-only discipline + conformance + screenshot oracle (light/dark/forced-colors)
· the new defaults corpus on all runtimes.
