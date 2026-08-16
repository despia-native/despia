# DSX best practices

Terse rules for writing `.dsx` markup. The document shape is normative in
[`Documentation/reference/dsx-anatomy.md`](../Documentation/reference/dsx-anatomy.md); every
rule here is enforced (or nudged) by `ClosedSource/scripts/lint_dsx.rb --strict` — the CI
gate and your authoring loop. Provenance: each rule is the DSX form of a settled practice
from HTML/XML and the reactive-UI world (Vue's style guide, React's data flow, SwiftUI,
Elm).

## 1 · One component per file, one root, head first

File basename = component name (Capitalized). One root element (extra roots are silently
dropped by the runtime parser — lint error now). Declarations live in a `<head>` as the
root's first child, canonical order: `attribute → expects → event → variable (plain →
computed) → formula → action → script → watch → style → component`, same-kind contiguous.
Markup-only files need no head. *(HTML head/body; Vue one-component-per-file.)*

## 2 · Declare the contract before the implementation

The head opens with the interface — DSX's `defineProps`/`defineEmits`:

```xml
<attribute as="size" default="44"/>   <!-- prop in -->
<expects variable="downloads"/>       <!-- state the mounting side must seed -->
<event as="remove" payload="episodeId"/>   <!-- event out -->
```

No prose-only contracts: the `• prop` bullet lists and `Raises:`/`Seeded facts:` comments
ARE these declarations now. With a head present, lint requires every `dsx.variable.x` and
every literal `dsx.event('x')` to be declared — the file's state surface is enumerable.
*(Vue `defineProps`/`defineEmits`; interface-first design.)*

## 3 · Props down, events up

An attribute is read-only inside the component; never mutate one, never smuggle an input in
as a variable. The component talks back with `dsx.event`, the consumer wires `on:name`.
*(React/Vue one-way data flow.)*

## 4 · expects when in doubt

`<expects>` is a pure declaration — zero runtime impact (plus a debug missing-seed log). A
plain `<variable>` injects an initial value. Declare `variable` only for state this file
owns and initializes; everything seeded by Swift or shared with a parent surface is
`expects`.

## 5 · Derive, don't watch

A value that follows from other state is `computed="true"` (or a parameterized `formula`) —
pure, re-evaluated per read, per-row over `item.*`. Reserve `watch` for side effects, and
never let a watcher rewrite its own dependency (lint flags the cycle). *(Vue: computed over
watchers.)*

```xml
<!-- BAD: a watch that maintains a value -->
<watch value="dsx.variable.cart" on:change="dsx.variable.badge = count(dsx.variable.cart)"/>
<!-- GOOD -->
<variable as="badge" computed="true">count(dsx.variable.cart)</variable>
```

## 6 · The body is pure markup

An inline `on:*` holds one call or one assignment (lint budget: ≤ 2 statements, ≤ 120
chars, nothing needing `&lt;`/`&amp;&amp;` escapes — code elements are read 1:1, attributes
are not). Bigger logic is a named action in the head. *(Unobtrusive JS; view = f(state).)*

```xml
<!-- BAD: logic trapped in an attribute (and it needs XML escapes) -->
<pressable on:tap="if (dsx.variable.stock &gt; 0 &amp;&amp; !dsx.variable.busy) { … } else { … }"/>
<!-- GOOD -->
<action as="addToCart">
  if (dsx.variable.stock > 0 && !dsx.variable.busy) { … } else { … }
</action>
<pressable on:tap="dsx.action.addToCart()"/>
```

Nested ternaries in `{{ }}` / `visible-if` are the same smell — name them:

```xml
<!-- BAD (was pasted 4× in Banner.dsx) -->
color="{{ type == 'error' ? '#FF453A' : (type == 'warning' ? '#FF9F0A' : '#0A84FF') }}"
<!-- GOOD -->
<variable as="bannerTint" computed="true">
  if (dsx.attribute.type == 'error') { return '#FF453A' }
  if (dsx.attribute.type == 'warning') { return '#FF9F0A' }
  return '#0A84FF'
</variable>
```

## 7 · Say things once

The same statement in two handlers is one action called twice (the auto-hide timer was
pasted 6× across the player before extraction). The same style run on N elements is one
`<style as="…">` class. N stamped-out near-identical rows are one row template over a bound
list with `key=`. *(DRY; SwiftUI ForEach.)*

## 8 · Keys on collections

Every data-bound `list`/`grid`/`pager` declares `key="id"` (or the row's stable field;
`key="index"` only for static data). *(React/Vue key rule.)*

## 9 · Names

`as=` is the identifier everywhere (legacy `name=` is removed — on `formula`/`action`,
`name` is an ordinary input). Actions are verbs (`toggleLike`, `confirmRemove`); variables,
computed values and formulas are nouns (`usedBytes`, `sizeLabel`). Component-generic
computed names get a component prefix (`bannerTint`, not `tint` — component templates share
the consumer surface's store). New code writes the explicit `dsx.variable.` /
`dsx.attribute.` namespaces, and multi-line bodies use explicit `return`.

## 10 · Strings come from outside

User-facing text enters through attributes (localized config ⊕ `dsx.global.strings` ⊕
payload — see [`localization.md`](./localization.md)); the attribute block doubles as the
translatable-string inventory. Don't hardcode copy in the body.

## 11 · Comments carry rationale, not contracts

The header comment says what the component is and shows one usage example. Contracts
(props, seeds, events) are declarations now. Comments in the tree explain *why* something is
the way it is. Never write a code-tag name in angle brackets inside a comment — it broke the
parser once and lint still flags it.

## 12 · Know your dialect

**Widget / Live-Activity** documents take a **declaration-only** head — `expects` for the
snapshot dict, `event` for relayed tap names — and no logic tags: snapshot renderers execute
no JSE and skip the head entirely (it is contract documentation there).

**Watch documents are NOT in that group** (corrected 2026-07-25 — they used to be listed here).
watchOS and Wear are live nodes with a real JSE runtime, so a watch screen takes the **full**
head: `<variable>` (including `computed`), `<formula>`, `<action>`, `<api>`, and `{{ … }}`
expressions all run on the wrist. Write them the same way you would for phone. See
`reference/StackWatch.md`.

Full-engine surfaces
take the full anatomy — and old shipped binaries render it fail-open (unknown tags render
their children), so remote-served anatomy files degrade correctly.

## 13 · Theme & semantic color

- **Pair background families, never mix them.** Grouped pages pair
  `background: groupedBackground` (the page) with `secondaryGroupedBackground`
  (the cards); plain pages pair `background` with `secondaryBackground`. The
  grouped card token is WHITE in light mode by design — put it on a plain
  white page and every card container vanishes (it only *looked* fine in dark,
  where the two families happen to differ).
- **`accent` IS the app's tint** — the AccentColor asset, adaptive, identical
  on every surface (app markup, widgets, Live Activities). Never assume it is
  any particular hex, and never hardcode a brand color where `accent` belongs:
  a white-label app's `color="accent"` must be *its* tint.
- **A pinned design pins its whole screen.** `theme="dark|light"` on a screen
  root fixes the color scheme for the subtree — semantic tokens, materials,
  system controls — AND the screen's bar chrome (the claimed system bar
  follows the pin, not the user's global preference, so a dark-designed page
  never wears a light blur strip). Pin at the SCREEN ROOT; a fixed-appearance
  design stays itself on any device.
- **Everything else follows the switch.** A screen meant to adapt uses
  semantic tokens end-to-end (`label` / `secondary` / the background pairs)
  and no mode-specific hex — then the one Appearance switch
  (`dsx.module.appearance.set`) recolors it for free.

## 14 · Layout that renders the same on native and web

The native renderers are v1 (SwiftUI/Compose stacks), not a full flexbox/grid
engine, so two CSS features render DIFFERENTLY than on web — `lint_dsx_css`
flags them as notices:

- **`display: grid` is a depth-stack natively** (every child in one cell,
  overlapping) — it is NOT a tracked CSS grid. A grid of cards piles up on
  iOS/Android (N001).
- **`flex-wrap` has no native equivalent** — native rows never wrap, so a row
  too wide for its column is squeezed (N002).

Author the native-safe base, then add the richer web layout in an **`@container`
tier — native evaluates no `@container` query**, so those rules are web-only and
can never diverge (a min-width `@media` tier, by contrast, IS evaluated
natively, so `display: grid` there still depth-stacks). The pattern:

```css
.cards { display: flex; flex-direction: column; }        /* native + web base */
@container panel (min-width: 40rem) {                     /* web-only precision */
  .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
```

For adaptive phone/tablet SHELLS use `<scaffold shell="automatic">` (a real
`NavigationSplitView` that the OS collapses by size class), never a hand-rolled
CSS-grid master-detail — the container queries it relies on don't run natively.
