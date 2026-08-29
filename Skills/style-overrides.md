# Style overrides: the component styling contract

> Audience: component authors and component consumers. How to declare, set, and spend the
> typed style knobs of a component — the STYLE contract beside the attribute DATA contract.
> The law: `Documentation/architecture/proposals/style-overrides.md`; the corpus:
> `OpenSource/Conformance/overrides/style-overrides.json`; companions:
> [component-props-and-state.md](component-props-and-state.md) (the data plane),
> [dsx-best-practices.md](dsx-best-practices.md).

## The one-paragraph model

An attribute answers "what does this component SHOW"; an override answers "how does this
instance LOOK". A component declares its knobs in the head, a consumer turns them on the tag,
and the component's own markup spends them wherever it chooses — at any depth. Nothing
auto-applies, so the contract stays enumerable: the visual editor lists exactly the declared
knobs as typed controls in the styling panel.

## Declaring (the component author)

```xml
<stack style="border-radius: {{ dsx.override.radius }}px; background: {{ dsx.override.surface }}">
  <head>
    <attribute as="title"/>                                            <!-- data plane -->

    <override as="radius"  type="number" default="10" min="0" max="32"/>  <!-- corner radius -->
    <override as="surface" type="color"  default="fill"/>                 <!-- panel fill -->
    <override as="glass"   type="boolean" default="true"/>                <!-- frosted material on/off -->
    <override as="extra"   type="css"/>                                   <!-- free-form declarations -->
  </head>
  …
</stack>
```

- Canonical head order: `attribute → override → expects → event → …` (lint-enforced).
- `type=` is the style catalog's control vocabulary (`number length enum multiEnum color
  gradient ratio boolean text`) plus `css`. It drives the editor control AND the runtime
  coercion: `dsx.override.radius` is a real number, `dsx.override.glass` a real boolean.
- `default=` is a LITERAL style value (a number, a token like `fill` or `accent`, a hex, a
  declaration list for `css`) — never a quoted JSE expression. Semantic tokens are literals
  here, so a token default adapts per platform for free.
- `options=` (space-separated) is required for `enum`/`multiEnum`; `min=`/`max=` clamp
  numeric values, defaults included.
- Never name a knob a platform word (`ios`, `web`, `native`, …) — the platform-suffix fold
  consumes those spellings before the split runs; lint refuses the declaration.
- A NATIVE-code component declares the same table in its manifest row:
  `web.components[].overrides.<name> = { "type": …, "default": …, "options": [...] }`; its
  web facet receives the raw values on `ctx.overrides` (refreshed in place, `update()` poked
  with `override:<name>`).

## Spending (still the component author)

A declared knob does nothing until the markup reads it. Spend it exactly where the design
needs it — that is the point:

```xml
<stack radius="{{ dsx.override.radius }}">                                <!-- a style attribute -->
<stack style="width: {{ dsx.override.barWidth }}px; border-radius: {{ dsx.override.barWidth / 2 }}px"/>
<stack visible-if="dsx.override.barWidth > 0">                            <!-- a removal switch -->
<stack style="{{ dsx.override.extra }}">                                  <!-- the css-typed door: a sole {{ }} style
                                                                               attribute is a whole declaration list -->
<Inner override:radius="{{ dsx.override.radius }}"/>                      <!-- explicit forwarding -->
<variable as="ringInset" computed="true">dsx.override.radius / 2</variable>  <!-- derive freely -->
```

`dsx.override.<name>` is reactive (a bound usage-site value updates live), typed, and
default-backed — an invalid live value degrades to the declared default, never to garbage
pixels. `<watch value="dsx.override.x" on:change="…"/>` reacts to a knob like any state.
Lint warns on a declared knob nothing spends, and errors on a `dsx.override.x` read with no
declaration.

## Setting (the consumer)

```xml
<Callout override:radius="6"/>                             <!-- the edge case: THIS one, 6px -->
<Callout override:surface="{{ dsx.global.theme.card }}"/>  <!-- bound to the app theme, live -->
<Callout override:barWidth="0"/>                           <!-- hide the accent bar -->
<Callout override:radius:ios="8" override:radius="6"/>     <!-- per-platform, the ordinary fold -->
```

- Values are literals or `{{ }}` bindings; a bound value re-resolves live.
- An unknown knob on a resolvable component is a lint ERROR (the runtime reads it as null,
  so the line would do nothing); a mistyped literal is an ERROR naming the expected shape.
- The verb doors carry the same plane: `dsx.component.push('Paywall', { overrides: { radius: 6 } })`,
  `dsx.component.present(…, { overrides })`, `dsx.component.update('Paywall', { overrides: { radius: 12 } })`
  (a live re-seed), and native mounting `ui.override("radius", 6)` beside `ui.attribute`.

## Choosing the plane

| The value is… | Declare it as |
|---|---|
| what the component shows (a title, a src, a row list) | `<attribute>` |
| how this instance looks (a radius, a tint, a material, spacing, "hide that part") | `<override>` |
| the app-wide look (brand accent, type ramp) | tokens / theme sheets — and let a consumer BIND an override to them when one instance should follow |

Two smells: an attribute whose only consumer is a style attribute wants to be an override
(`<Card radius=…>` predates this plane and stays for compatibility — new components declare
style knobs as overrides); an override that changes BEHAVIOR wants to be an attribute.

## The runtime law in one table

| Question | Answer |
|---|---|
| unset, empty, or invalid value | the coerced declared default; no default → null |
| out-of-range number | clamped to min/max |
| undeclared knob read | null (and a lint error at authoring time) |
| raw-value doors, in precedence | tag `override:` attrs → mount/update verbs → declaration default |
| whole plane | `dsx.override` = the declared contract, resolved |

The corpus (`Conformance/overrides/style-overrides.json`) pins all of it on the TS, Kotlin,
and Swift runtimes; the reference adoption is `Foundation/Components/Core/Callout.dsx`.
