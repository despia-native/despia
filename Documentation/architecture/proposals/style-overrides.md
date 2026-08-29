# Style overrides — the component styling contract (LANDED)

> Status: LANDED on all four renderers (web + SSR, iOS, Android, Compose Desktop), corpus-gated
> (`OpenSource/Conformance/overrides/style-overrides.json`, three runners) and lint-enforced on
> all three linters. Authoring guide: `OpenSource/Skills/style-overrides.md`. This document is
> the law.

## The problem

A component's ATTRIBUTES are its data contract. Styling had no such plane: a composed component
(`<Card>`, `<Callout>`, a library surface ten elements deep) ships a designed look, and the one
customization door was either (a) a global stylesheet — the wrong altitude for "THIS card, 6px,
because it sits near an edge" — or (b) smuggling style knobs through the attribute contract,
which conflates two mental models the web learned to keep apart: a React component's PROPS are
not its CSS custom properties. Styling an element nested deep inside a component was near
impossible without forking the component.

## The law

**Overrides are the component STYLE contract, beside the attribute DATA contract.** Same
delivery machinery, separate plane, separate panel in the editor.

1. **Declare** — in the component head, one `<override>` per knob:

   ```xml
   <override as="radius"  type="number" default="10" min="0" max="32"/>
   <override as="surface" type="color"  default="fill"/>
   <override as="accent"  type="enum"   options="raised cut flat" default="raised"/>
   ```

   `as=` is an identifier (`dsx.override.<name>` must be a legal member read; the platform
   suffix words are refused — the fold would consume them). `type=` is the style catalog's
   control vocabulary — `number length enum multiEnum color gradient ratio boolean text` —
   plus **`css`** (a raw declaration list). `default=` is a LITERAL style value, never a JSE
   expression (the style-plane convention; `{{ }}` belongs at the usage site). `options=` is
   the space-separated member list (required for enum/multiEnum); `min=`/`max=` clamp numbers.
   Native-code components declare the same table in their manifest row:
   `web.components[].overrides.<name> = { type, default, options, min, max }`.

2. **Set** — on the usage tag, as `override:<name>=`, with the full value grammar:

   ```xml
   <Callout override:radius="6"/>                          <!-- literal -->
   <Callout override:surface="{{ dsx.global.theme.card }}"/>  <!-- bound, live -->
   <Callout override:radius:ios="8"/>                      <!-- platform-suffixed (the ordinary fold) -->
   ```

   And through the verb doors: `dsx.component.push/present(name, { overrides: {…} })`,
   `dsx.component.update(target, { overrides: {…} })` (a live re-seed), and the native mount
   surface (`ui.override("radius", 6)` beside `ui.attribute`). Delivery: on web the door
   seeds the instance store's `dsx.override` var (the read chain's second rung); on the
   native renderers the frame/modal surface store carries the seeded dict and the component
   boundary FOLDS it under the tag spellings into the same item `__overrides` vehicle a
   hard-coded consumer's tag rides — tag beats door (the item-beats-store law), only
   verb-seeded surface stores carry the var, and a live re-seed re-runs the split through
   the ordinary store publish. Two spellings on the double-tap guard differ too: a second
   push/present identical but for its `overrides` is intent, not an echo (the echo key
   digests the style plane beside vars and attrs on all three routers).

3. **Read** — inside the component, `dsx.override.<name>`: reactive, typed, coerced,
   default-backed. The whole-plane read `dsx.override` returns the declared contract resolved.
   Consumption is EXPLICIT: the component's markup spends a knob wherever it chooses —
   `radius="{{ dsx.override.radius }}"` on any element at any depth,
   `style="{{ dsx.override.extra }}"` for a css-typed knob (a sole-`{{ }}` style attribute is
   a whole declaration-list hole on every renderer), `visible-if="dsx.override.barWidth > 0"`
   to make a knob a removal switch, or a `computed` variable deriving from several. Nothing
   auto-applies; a declared knob the markup never spends is a lint warning. Forwarding into a
   nested component is explicit too: `<Inner override:radius="{{ dsx.override.radius }}"/>`.

## Resolution — the three pure laws (the corpus)

`OpenSource/Conformance/overrides/style-overrides.json`, executed by all three runners
(TS per-PR, Kotlin `:core` per-PR, Swift per-PR on the Linux lane via
`swift_conformance_run_test.rb` + the record lane for the JSE-coupled read cases):

- **split** — `override:<identifier>` leaves the props plane at the component mount; `on:` is
  the event plane; a malformed spelling stays a visible ordinary attribute (lint owns it). The
  platform fold runs FIRST, so the suffix words can never be knob names.
- **resolve** — coerced raw → coerced declaration default → null. Fail-open, never throwing:
  unset, empty and invalid all degrade to the declared look. Numbers clamp to min/max; enum
  membership is exact; color accepts hex (`#RGB/#RGBA/#RRGGBB/#AARRGGBB`), balanced
  `rgb()/rgba()/hsl()/hsla()`, or a bare token name; `css` refuses braces (declarations only).
- **read** — the raw chain is the item scope's `__overrides` dict (the tag door) → the store's
  `dsx.override` var (the mount/update door) → the default. An undeclared name reads null;
  the whole-plane read never carries undeclared keys.

Implementations: `OpenSource/Web/packages/kernel/src/style-overrides.ts` ·
`Engine/Android/core StyleOverrides.kt` · `Engine/iOS/StyleOverrides.swift` (Apple-free), with
the JSE lookup branch in each evaluator (`jse.ts` · `Jse.kt` · `JSE.swift`) and the usage-site
split at each renderer's component mount (`dom/src/mount.ts` + the SSR twin ·
`StackNodeView.kt` + `DesktopRenderer.kt` · `Stack.swift`).

## The editor surface

`stack-elements.json` carries every component's `overrides` table — extracted from `.dsx` heads
and from native `web.components[].overrides` rows by `generate_editor_catalog.rb` — typed by
the style catalog's `controlTypes`, with defaults, options, min/max and the doc comment. The
styling panel renders these as typed controls (number input, enum dropdown, color picker,
boolean toggle) with the per-field `{{ }}` bind escape hatch, exactly the way `attributes`
feed the props panel. The `conventions.componentOverrides` row documents the usage grammar.

## Enforcement (both linters + the shipped CLI)

Declaration discipline (all three runners, corpus
`Conformance/lint/cases/shared/style-overrides.dsx`): type vocabulary, enum options required,
reserved names refused, literal defaults type-checked, `{{ }}` defaults refused, min/max
numeric. Usage-site contract (the authoritative Ruby gate): an unknown `override:` name on a
resolvable component is an ERROR with a did-you-mean (the runtime fails open to null, so the
authoring loop is where a wrong knob dies), a literal value is type-checked against the
declaration, and `override:` on a plain ELEMENT warns (an element's attributes ARE its style
surface). Read discipline: `dsx.override.x` without a declaration is an error; a declared knob
never read is a warning.

## What this deliberately is not

- **Not auto-application.** A knob turns only what the component author wired it to. That is
  what keeps the contract enumerable and the pixels owned.
- **Not a cascade rung.** The precedence ladder (system-defaults.md) is untouched: an override
  is resolved VALUE-side and lands wherever the author spends it — usually in style attributes
  at ladder level 4.
- **Not a replacement for tokens or theme sheets.** App-wide restyling stays the token/theme
  door; overrides are the per-instance door. A consumer binds the two together when that is
  the intent (`override:surface="{{ dsx.global.theme.card }}"`).
- **Not implicit inheritance.** CSS custom properties pierce every boundary silently; an
  override crosses a component boundary only by explicit forwarding, so every contract stays
  readable at its declaration.
- **Not embed common-path weight.** In self-contained web embeds the whole plane is a
  slice-driven fold (`__DSX_OPTIONAL_STYLE_OVERRIDES__`, detector
  `registryUsesStyleOverrides` — a declared `<override>`, an `override:` spelling, a
  `dsx.override` read, or a foreign payload keeps it): a knob-free widget ships neither the
  resolver nor the doors. Web infrastructure, not authoring surface — the other renderers
  gate by file presence as usual.

## The reference adoption

`Foundation/Components/Core/Callout.dsx`: three knobs (`radius` · `surface` · `barWidth`)
spent at depth — the panel radius on the root, the accent bar's width AND its derived
`barWidth / 2` corner on a nested element, and `barWidth > 0` as the bar's removal switch.
SSR-asserted in `packages/server/test/style-overrides-render.test.ts`; the renderer wiring in
`packages/dom/test/style-overrides.test.ts`.
