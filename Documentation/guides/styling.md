# Styling DSX with CSS

> **A note on paths.** This guide is written in the Despia monorepo, where the open tree
> you are reading lives under `OpenSource/` and the commercial layer (the production
> module catalog, host shells, and build machinery) lives under `ClosedSource/`. Paths
> with those prefixes refer to the monorepo; only the open tree ships in the public
> repository, and an `OpenSource/X` path is `X/` there.

> The practical authoring guide for DSX-CSS — what works **today** in this
> engine, the conventions, and what lands with the Taffy layout phase.
> Spec: `architecture/proposals/dsx-css.md` · property catalog:
> `reference/dsx-css-properties.json` (the linter's source of truth — an
> unknown property or malformed value is a **build error**, never silent).

## The mental model

Every DSX element is a **flexbox node**. `vstack` is a flex column, `hstack` a
flex row, `zstack` a stacking context — and **`<stack>` is the generic one:
CSS decides which it is**. `flex-direction: column` is the default when unset,
`row` makes it horizontal, and `display: grid` (v1: no tracks yet) is the
single-cell overlap idiom — a depth stack. The named stacks are presets over
the same idea; reach for `<stack>` when the axis is a styling decision
(responsive, reactive, themed), the named ones when it's structural.

```xml
<stack style="flex-direction: row; column-gap: 1rem; align-items: baseline">
  <text value="32" style="font-size: 2rem"/>
  <text value="pt tall"/>
</stack>
```

`<stack>` carries **web-true defaults** (only this element): unset gap is `0`
(the legacy stacks keep the platform default spacing), and cross-axis
alignment reads CSS `align-items` (`flex-start`/`center`/`flex-end`/
`baseline`), with the legacy `align` tokens as a fallback. v1 honesty:
`*-reverse` renders as its base axis and `justify-content` (main-axis
distribution) waits on the Taffy phase — both lint clean and light up there.

**All first-party markup IS `<stack>`** — the second-wave codemod
(`scripts/migrate_stacks_to_generic.rb`) converted every named stack:
`vstack` → plain `<stack>`, `hstack` → `flex-direction: row`, `zstack` →
`display: grid`, static `spacing=` folded into `gap`, and a stack that had
relied on SwiftUI's implicit default spacing got it **materialized** as
`gap: 0.5rem` — nothing is implicit anymore. The named elements remain fully
supported (third-party/OTA markup, and StackLive snapshot surfaces — Live
Activities/widgets — which have no CSS engine and keep them).

The three sizing modes per axis:

| Mode | Today (v1 bridge) | With Taffy (Phase 2) |
|---|---|---|
| **Fixed** | `width: 120px` / `height: 2.5rem` | same |
| **Fill** | `width: 100%` (bridges to the engine's fill primitive) | `flex-grow`, `%`, `minmax()` |
| **Hug** (default) | `width: fit-content` | same, per CSS |

**Today, CSS renders through the proven attribute pipeline** — the bridge
(`Registry/DSXCSS/CSSBridge.swift`) maps declarations onto it 1:1, so
everything below renders identically to its legacy-attribute equivalent.
When the Taffy core is linked (one CI step; file-presence gated), layout
moves to real CSS flexbox + Grid with web defaults — markup unchanged.

## The three places styles live (weakest → strongest)

```
1. theme.css                    global tokens (DSX/Modules/Config/theme.css)
2. Component.css                the component's sidecar sheet (classes)
3. style="…" on the element     inline CSS
4. explicit legacy attributes   always win (migration escape hatch)
```

Same class name at several layers? **Nearest scope wins, deterministically** —
never specificity arithmetic.

### 1 · Tokens (`theme.css`)

```css
:root {
  --surface: #111113;  --accent: #0a84ff;
  --pad: 1rem;  --radius-card: 14px;
}
@media (prefers-color-scheme: dark) { :root { --surface: #0b0b0d; } }
```

Use them anywhere: `background: var(--surface)`. Unknown token → the
`var(--x, fallback)` fallback, else the declaration drops (loudly, in lint).

### 2 · Component sheets — a SIDECAR `.css` next to the `.dsx`

`Components/Card.css` pairs with `Components/Card.dsx` and is scoped to that
component's subtree automatically (the `css-owner` stamp):

```css
/* Card.css */
.card       { padding: var(--pad); gap: 0.5rem;
              background: var(--surface); border-radius: var(--radius-card); }
.card-title { font-size: 1.0625rem; font-weight: 600; color: var(--text); }
```

```xml
<!-- Card.dsx -->
<vstack class="card" grow="width">
  <text class="card-title" value="{{ dsx.attribute.title }}"/>
</vstack>
```

Sheets are compiled at build time (`prepare_modules` → the Registry); the
runtime never parses them. **Why sidecar and not `<style>` in the head:** raw
CSS (`&` nesting) is XML-hostile; the inline form arrives when the XML parser
gets raw-text islands. v1 selector subset: `.class` chains and `:root`;
`@media (prefers-color-scheme | min-width | max-width | prefers-reduced-motion)`.

### 3 · Inline styles

```xml
<vstack style="padding: 1rem; gap: 0.625rem; background: var(--surface);
               border-radius: 14px"/>
```

Flat declaration lists today (nested `&.x { }` blocks are compiled and land
with Taffy). `{{ }}` interpolation works at value level:
`style="background: {{ item.ok ? 'var(--ok)' : 'var(--warn)' }}"`.
A bare token (`style="card"`) is still a **legacy named style** — the `:`
is what marks CSS.

## Units — px, rem, em: first-class and freely mixable

**Every length property takes any of the three, mixed per property, per
element, or per app** — an all-px app, an all-rem app, an all-em component,
or `border-radius: 14px; gap: 0.5rem; padding: 0.75em` on one element are
all equally supported. What each one means:

- **`px` = point/dp**, never a hardware pixel. Fixed geometry: radii,
  hairlines, media boxes that must not inflate.
- **`1rem` = 16pt × the user's Dynamic Type scale** (Android: fontScale). At
  the default setting `1rem = 16pt` — identical rendering — and at
  accessibility sizes the whole layout scales, not just the glyphs.
- **`1em` = the element's OWN font-size** for every non-font property —
  `padding: 0.75em` tracks the element's type size, whichever unit that
  font-size uses. (`font-size: 1.2em` itself resolves against the rem base
  in v1 — parent font inheritance is a computed-style concern that arrives
  with the Taffy phase.) `vw`/`vh` = the window.

The convention our own components ship (a default, **not** a rule): type &
spacing in `rem` (`font-size: 1.0625rem`, `gap: 0.625rem` → rhythm scales
with the user's vision needs), radii and fixed boxes in `px`.

Cheat sheet: `12→0.75rem · 13→0.8125rem · 14→0.875rem · 15→0.9375rem ·
16→1rem · 17→1.0625rem · 22→1.375rem · 26→1.625rem`.

## What the v1 bridge maps (renders today)

`padding` (+ all longhands & shorthand box values) · `background`/
`background-color` · `color` · `opacity` · `border-radius` · `width`/`height`
(px · `100%` → fill · `fit-content`) · `min/max-width/height` ·
`gap`/`row-gap`/`column-gap` — **axis-correct**: an `hstack` (or a row
`<stack>`) consumes the column gap, a `vstack`/`list` the row gap, and the
two-value shorthand is `gap: <row> <column>` like the web ·
`display: none` — removes the element (ANY element; it rides the `visible-if`
gate, so it composes with `@media` and `{{ }}` interpolation) ·
`flex-direction` / `align-items` / `display: grid` (the `<stack>` element) ·
`font-size` · `font-weight` (words or 100–900) · `letter-spacing` ·
`aspect-ratio` · `z-index` · `-dsx-surface` / `-dsx-glass-tint` /
`-dsx-glass-interactive` (the Liquid Glass family — see below).

**Stays on legacy attributes until Taffy** (converting now would change
rendering): `grow`, `align`, `justify-content`, per-corner radii, shadows,
transforms, transitions/animations. The DEBUG console names any accepted-but-
unmapped property the moment you use it.

## Web-true anchors (grow)

Content inside a grown frame (`grow`, min/max sizes) pins to the
**top-leading edge** when unsteered — CSS block flow / flex-start — never
SwiftUI's centering default. This is what makes a `grow="width"` card put its
children at the left edge instead of centering them as a hugged group (the
"randomly centered panel" symptom). Steering still wins: `alignY`, legacy
`align` (an explicit `align="center"` keeps BOTH axes centered — stated
intent), and CSS `align-items` on the element's cross axis.

## Liquid Glass — full-color, and the REAL bouncy press

- `surface="glass"` (CSS `-dsx-surface: glass`) — the Apple Liquid Glass
  material on iOS 26+, `.ultraThinMaterial` below.
- `glassTint` (CSS `-dsx-glass-tint`) — colors the GLASS itself: a
  full-color glass button with a white label, never just tinted text. Below
  iOS 26 it falls back to a solid fill of the tint, so the full-color read
  survives on every device.
- `glassInteractive` (CSS `-dsx-glass-interactive`) — the system's bouncy
  press-stretch response (`glassEffect(.interactive())`). Defaults **on** for
  tappable elements; removable per element (`glassInteractive="false"`) or by
  a class, which makes the whole treatment an add/removable style:

```css
.btn-primary { -dsx-surface: glass; -dsx-glass-tint: var(--accent); color: white; }
.btn-quiet   { -dsx-surface: glass; color: var(--label); }
```

## Migration state

All first-party components were codemodded to this system
(`scripts/migrate_dsx_to_css.rb` — safe to re-run). Mixing is fully
supported: explicit legacy attributes always beat CSS, so incremental
adoption can never regress an element you've pinned.

## Tooling

- `ruby ClosedSource/scripts/lint_dsx_css.rb [--strict|--format=json]` —
  validates every sheet + inline style against the catalog; error codes with
  fix-its (`E001 unknown property — did you mean 'color'?`).
- `ruby ClosedSource/scripts/compile_dsx_css.rb` — sheet compilation
  (run automatically by `prepare_modules`).
- Layout conformance: `ClosedSource/scripts/dsxcss/` (headless Taffy runner +
  fixtures — the same core the app links).

## Phase 2 (wired, waiting on the Taffy xcframework — built by CI, linked by
file presence): real flexbox (`justify-content`, `align-items`, `flex-grow`),
CSS **Grid**, `&.class` element-owned states, `@container` queries,
transitions/`@keyframes`/`@starting-style`, `-dsx-material` and friends.
