# defaults — the system-defaults corpus

The fixture home of `architecture/proposals/system-defaults.md` (ACCEPTED): **the
unstyled baseline IS the platform**. Renderer defaults, semantic tokens, and the
variant words are cross-runtime surface, so their contract lives here — fixtures
first, every runtime consumes the same JSON (the `api/api-blocks.json` shape).

## `tokens.json` — the semantic-token mapping corpus

One entry per ratified vocabulary word — `label · secondary · tertiary · background ·
groupedBackground · secondaryGroupedBackground · fill · separator · accent ·
destructive` — each carrying per-target values:

| Column | Type | Meaning |
|---|---|---|
| `ios` | UIColor slot name | the semantic slot the SwiftUI renderer resolves (`label`, `systemGroupedBackground`, `tintColor`, `systemRed`, …) |
| `watchos` | UIColor slot name | same slot family; the wrist runtime resolves it under watchOS's always-dark system appearance (so `systemBackground` IS the black canvas) |
| `android` | M3 role name | the Material 3 color role under `dynamicColorScheme()` (static M3 fallback < API 31): `label→onSurface`, `accent→primary`, … |
| `wear` | Wear role name | the Compose Material for Wear OS color role (`background` = the black canvas, `surface` = the Chip/Card container) |
| `web` | `{ css, light, dark }` | the `--dsx-*` custom property of the web skin's `dsx-tokens` layer plus its light/dark scheme pair |

The law (spelled out in the file's `_note`): **native columns are role names, never
values** — the OS owns the values so inherited looks self-update; **only web carries
literals**, because the web has no system palette to inherit, and those literals are
honest NEUTRAL grays + a blue accent (`color-scheme: light dark`, light/dark scheme
pairs) — never fake-Cupertino. Words may legitimately coalesce per target (iOS dark
resolves `background` and `groupedBackground` to the same color; so does the corpus).

## Runners (per the spec's migration order)

- **TS (live)**: `OpenSource/Web/packages/dom/test/theme.test.ts` — the drift gate:
  every corpus word must ship in `theme.ts` as floor-safe scheme TWINS — its `light`
  value in the base `:root` block, its `dark` value in the
  `@media (prefers-color-scheme: dark)` block AND the `[data-dsx-theme="dark"]` pin
  table, its `light` value again in the `[data-dsx-theme="light"]` pin table (pins
  after the media block at equal specificity, so an explicit pin beats the OS scheme
  in both directions). Bare `light-dark()` is BANNED in the emitted sheet: the stamped
  browser floor is last-2 evergreen + Safari 16.4 (`/web/10` W0) and `light-dark()`
  needs Safari 17.5 — below that, every `var(--dsx-*)` use would be invalid at
  computed-value time. The vocabulary word list is pinned. The web precedence-ladder
  test (`packages/compiler/test/defaults.test.ts`) exercises the suffix fold + layer
  order.
- **Kotlin (live)**: `OpenSource/Engine/Android/render/src/test/kotlin/despia/engine/render/DefaultsTokensTest.kt`
  — the M3-role drift gate, run by the gradle suites per PR (`android-kernel` lane).
- **Swift (live, script-gated)**: the corpus cross-check inside
  `ClosedSource/scripts/check_style_catalog.rb` (part of the existing `--strict` CI
  invocation) — every corpus word must have a `case` in `StackStyle.color`
  (`OpenSource/Engine/iOS/Stack.swift`) resolving EXACTLY the UIColor slot the `ios`
  column names (`accent` → `Color.accentColor`, the tintColor role). The check runs
  per PR; the renderer itself stays compile-pending (Swift builds only on Codemagic).
- **The wrists (pending)**: land with their renderer-defaults phases, consuming the
  same file.

Follow-on fixtures that join this folder as those phases land: per-element
system-default descriptors (unstyled markup → component identity + token slots per
target — never pixels) and the full-ladder precedence corpus run on every runtime.

A change to the vocabulary or a mapping is illegal without a spec change and green
gates on every runtime that ships it — same discipline as `../jse`.

## The five axes beside `tokens.json` (landed 2026-08-25)

`tokens.json` ratified COLOUR and nothing else, and colour is the one foundation axis that
never drifted. That is not a coincidence, and it is the whole argument for these files.

`design-system.md` Part 1 specified a complete foundation layer on 2026-08-17: a type ramp
with size, weight, tracking AND leading, a spacing scale, a radius scale, elevation 0-4,
motion, one focus ring, a density knob, and derived interaction states. Most of it shipped on
web. None of it was ever written down cross-runtime, and nothing forced a component to use
it. By 2026-08-25 the measured result was 108 box-shadow declarations against a five-level
scale that already existed with only 31 tokenised, 74 font-size declarations against an
eleven-role ramp with 33 literal, and 144 hand-written `color-mix()` calls where the state
layer belonged. The diagnosis is `architecture/runtime-pressure.md` R22.

| file | roles | the thing it carries that nothing else did |
| --- | --- | --- |
| `type.json` | 9 | the ramp's **leading**, absent until now, which is why nine hand-typed line-heights were in the sheet |
| `elevation.json` | 5 | the five rungs as **scheme twins**, because a shadow that reads on white is a smudge on near-black |
| `state.json` | 8 | the whole interaction plane, which had **zero** tokens and 144 improvisations |
| `shape.json` | 5 | a radius **bound to a control size band**, so a 40px button and a 56px card stop matching |
| `motion.json` | 7 | one duration ramp plus its published alias, replacing two rival families |

All five keep this folder's existing law without amendment: native columns are ROLE NAMES
because the OS owns the value, only `web` carries literals because the web has no system to
inherit from, and every value here is RATIFIED - read out of the shipping sheet, not chosen.

Two honest asymmetries are recorded rather than smoothed over. The Compose targets have a
ratified elevation scale and the Apple targets do not: they express depth with materials,
which is not a shadow and has no numeric rung, so their column names the mechanism. The same
is true of motion, where the Apple platforms own their curves and honour reduced motion
themselves. Writing a number into those columns would be re-specifying a system look, which
is the mistake the constitution refuses by name, so the gate below fails on it.

Pinned by `OpenSource/Web/packages/dom/test/defaults-corpus.test.ts`, which asserts that every
web value is what `TOKENS_CSS` actually emits, that every role carries every platform column,
and that no native column contains a value. The element layer is separately held to this
vocabulary by `packages/dom/test/design-system-gate.test.ts`.
