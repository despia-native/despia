# DSX-CSS — a CSS-native styling engine for DSX (status: LARGELY BUILT; this doc is the design record)

> **⚠️ STATUS BANNER CORRECTED (2026-08-10).** This header read *"Phase-0 design proposal. No
> engine code has changed"* long after the engine shipped, which is the most misleading class of
> stale label in the tree: a reader treats a built subsystem as unbuilt. The engine exists —
> `ClosedSource/Registry/DSXCSS/` carries `CSSEngine`, `CSSResolver`, `CSSIR`, `CSSInline`,
> `CSSValue`, `CSSBridge` and `DSXTaffyBridge`; the Kotlin twin ships the four-layer cascade in
> `:render`; `lint_dsx_css.rb --strict` and `dsxcss/parser_test.rb` gate it per-PR; and
> `ClosedSource/Documentation/archive/dsx-css-execution-plan.md` is filed as **executed**.
> Treat everything below as the DESIGN RECORD behind what shipped, not as an open proposal.
> Where a section and the engine disagree, the engine wins — and the section is the stale one.
> (One genuinely open item is tracked elsewhere: the `CssBridge.kt` catalog entries marked
> "accepted by the catalog but not yet mapped — inert until the Taffy phase".)
>
> **The one-sentence pitch:** adopt **CSS as DSX's styling language** — real grammar, real
> semantics, powered by a real layout engine — extend it where native is richer than the web
> (`-dsx-*`), fix it where the web got it wrong (scoping, silent failures, conditionality),
> and keep everything else about DSX (elements, head/body anatomy, `{{ }}` bindings, the
> module bus) exactly as it is.

---

## 1 · Why (the problem, precisely)

DSX today styles through a bespoke attribute dialect (`grow="width"`, `spacing`, `paddingH`,
`fit`). The engine is sound — but the dialect has **semantic distance** from CSS, the most
deeply documented layout language in existence. Every author, human or AI, arrives with CSS
priors; every place DSX deviates is a place those priors actively fight the engine. The
empirical evidence from one demo-audit session:

| Real bug that shipped | Under CSS semantics |
|---|---|
| Cards silently collapse to content width | Impossible — flex column children `stretch` by default |
| Rows render flush (no gap) | `gap: 10px` — the first property anyone reaches for |
| Titles float off-center beside a button | `justify-content: center` / grid `1fr auto 1fr` — universally known |
| `width="100%"` silently ignored | `width: 100%` works |
| Unknown attribute silently ignored (catalog: *"unknownAttributes: Ignored"*) | DSX-CSS makes this a **build error** |

The result is the "99% right, 1% agonizing" pattern. It is a **priors problem, not a docs
problem** — you cannot document your way out of it; you close the semantic distance.

There is also a strategic symmetry: the web half of every Despia app already speaks CSS, and
the runtime already injects `--safe-area-top` custom properties and parses body CSS
transitions (the smart status bar). DSX-CSS gives the whole product **one styling language**.

At 500k+ apps — video calling, games/Tamagotchi, calorie counters, social feeds, 3D — the
styling system must be a *platform*, not a feature. That means: specified semantics, a
conformance test suite, strict tooling, and no dialect drift. CSS is the only styling
language with 25 years of that groundwork already done.

## 2 · What DSX-CSS is NOT

- **Not a WebView.** The engine parses CSS and renders 100% native views (UIKit/CALayer-
  or SwiftUI-hosted on iOS, Compose on Android). No DOM, no JS engine in the styling path.
- **Not a full browser.** "Everything CSS has" is scoped by a **conformance table** (§5).
  Inside the table: real CSS, bit-for-bit semantics. Outside: either a `-dsx-*` extension or
  a **lint error** — never a silent ignore.
- **Not a replacement for DSX markup.** Elements, `<head>` anatomy, `as=`, `{{ }}`, `on:*`,
  `visible-if`, lists/grids/pagers, the module bus — all unchanged. Only the *styling
  dialect* is replaced.

## 3 · Architecture at a glance

```
 .dsx file
   <style> blocks + style="" attrs + class directives
        │  build time (prepare_modules)
        ▼
  CSS parser → typed Stylesheet IR (codegen into Registry, like StackComponents today)
        │  lint_dsx --strict validates every property/value against the catalog
        ▼
  runtime style resolver:  element defaults ∪ matched rules ∪ inline   (per node)
        │        ▲ reactive: store writes, media/container changes re-resolve only affected nodes
        ▼
  layout engine (Taffy: flexbox + grid + block, web defaults)  ← text measure callbacks (TextKit / StaticLayout)
        │  computed rects
        ▼
  native renderers: iOS (view/layer tree)  ·  Android (Compose)   ← paint, materials, filters
        │
  native animators: Core Animation / ValueAnimator  ← transitions · @keyframes · @starting-style
```

**Layout engine decision.** Run a *real CSS layout algorithm* and place native views from its
computed rects — never re-map CSS names onto SwiftUI's proposal/response layout (that
preserves today's impedance mismatch, just with new spelling).

| | **Taffy** (Rust) — recommended | **Yoga** (C++, Meta) — fallback |
|---|---|---|
| Coverage | Flexbox + **CSS Grid** + block | Flexbox only (grid would be ours to build) |
| Web fidelity | Web defaults native, high WPT conformance | Deviates unless `UseWebDefaults` is set |
| Cross-platform | **One core → bit-identical layout on iOS & Android** | Same, via platform bindings |
| Maturity | Newer (Dioxus, Bevy) | A decade at Meta scale (React Native) |
| Build | Rust → prebuilt static xcframework (same pattern as the GLTFKit2 binary product) | C++, trivial |

**DECIDED: Taffy.** Grid, masonry-as-plugin, and container queries are hard requirements of
this spec, and building CSS Grid ourselves on Yoga is exactly the "accidentally a browser"
trap. Taffy ships as a Rust core compiled to prebuilt static libraries for both platforms —
in this build system, the same shape as the GLTFKit2 binary product. Yoga (+
`UseWebDefaults`, Grid deferred) remains the documented fallback position only if Rust-in-CI
proves untenable during the Phase-1 spike.

**Where custom layout lives:** masonry, marquee, and any future non-standard layout are
implemented as **measure/placement plugins on the same node tree** (Taffy supports custom
layout functions), so they compose with flex/grid parents rather than being special
containers.

## 4 · The authoring surface

### 4.1 Component-scoped `<style>` (fixing CSS problem #1: the global namespace)

A `<style>` tag in the head carries **real CSS**, scoped to this component's subtree by
default (compile-time class-hashing, the Svelte/Vue SFC technique — no runtime cost):

```xml
<!-- CalorieCard.dsx -->
<vstack class="card">
  <head>
    <attribute as="kcal"/>
    <style>
      .card {
        display: flex; flex-direction: column; gap: 8px;
        padding: 16px; border-radius: var(--radius-card);
        background: var(--surface);
      }
      .kcal   { font-size: 2rem; font-weight: 800; color: var(--text); }
      .label  { font-size: 0.8rem; color: var(--text-secondary); }
      .card:pressed { transform: scale(0.98); transition: transform 120ms ease-out; }

      @media (max-width: 360px) { .kcal { font-size: 1.5rem; } }
    </style>
  </head>
  <text class="kcal" value="{{ dsx.attribute.kcal }}"/>
  <text class="label" value="calories today"/>
</vstack>
```

- **Full selector grammar inside a scoped sheet** — descendant/child/sibling combinators,
  `:nth-child`, attribute selectors, pseudo-classes. Affordable because a component subtree
  is small; scoping is what makes "everything CSS has" performant.
- `:global(.toast)` escapes scoping deliberately and greppably.
- Specificity = real CSS specificity **within the sheet**; inline `style=` wins over sheets
  (standard). `!important` parses but is a **lint error** — its legitimate uses are covered
  by the conditional directives (§4.3) and scoping; its illegitimate uses are why people
  hate CSS. This is one of the "fix CSS" line items.

### 4.2 The app theme: tokens, dark mode, motion (one file)

```css
/* App/theme.css — the global sheet. Lint caps it to: tokens on :root, element defaults,
   and single-class utilities. No descendant selectors globally (whole-app invalidation
   is the browser-scale trap; components own their own trees). */
:root {
  --surface: #ffffff;          --text: #1e293b;
  --text-secondary: #64748b;   --accent: #0a84ff;
  --radius-card: 14px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #111113;  --text: #f8fafc;
    --text-secondary: #94a3b8;
    color-scheme: dark;          /* drives the native status bar, exactly like the web side */
  }
}
@media (prefers-reduced-motion: reduce) {
  :root { --anim: 0ms; }         /* opt-in token… */
}
```

`color-scheme` here does on the native surface what it already does in the WebView — the
StatusBar module consumes it. **One dark-mode mental model across the whole product.**

**Custom properties exist at three scopes — and they are the reactive channel.**

```
:root (theme.css)          → global tokens, weakest             (--accent, --surface)
component <style>          → component tokens, on any selector  (.card { --ring: 2px })
element style: binding     → reactive, state-driven             (style:--progress="…")
```

- **Global** tokens live in `theme.css` `:root` — the published vocabulary.
- **Component** tokens are set in the scoped sheet on any selector; standard CSS
  inheritance carries them down the subtree, so a child element just writes
  `var(--ring)` — no imports, no plumbing. A component can *re-map* a global token for
  its subtree (`.card { --accent: var(--warn) }`) without touching the world outside.
- **Reactive** custom properties bind to state on an element:
  `style:--progress="dsx.variable.progress"` — one store write flows down through
  CSS inheritance and every `var(--progress)` consumer updates. When the affected
  declarations are paint-only (colors, opacity, shadows), the update **skips layout
  entirely** — this is the cheapest reactive path in the engine and the blessed way to
  drive continuous values (progress, scrubbing, theming) through many descendants at once.

**`@property` is the component's public styling contract.** A component declares its
externally-styleable surface as registered custom properties — typed, defaulted,
machine-readable (real CSS):

```css
@property --size  { syntax: "<length>"; initial-value: 96px;    inherits: false; }
@property --fill  { syntax: "<color>";  initial-value: #0a84ff; inherits: false; }
```

Consumers customize **only** through that surface — `<ProgressRing style="--size: 64px">`
or reactively `style:--fill="item.risky ? 'var(--warn)' : 'var(--ok)'"`. Lint validates
overrides against the declared `syntax` (`--size: red` is a build error), the visual style
panel renders real per-component controls from it (the same catalog machinery as today's
`stack-style-properties.json`), and `initial-value` means a component never renders
unstyled. Scoping already makes reaching into a child's classes impossible, so registered
custom properties are structurally the *only* cross-component styling channel — now typed.

**Named themes are a convention, not a feature.** A theme is a token-only class applied to
any subtree root; inheritance does the rest, and it composes with the variant directive for
config-driven switching:

```css
/* theme.css — .theme-* classes are token-only and exempt from the global-class lint */
.theme-ocean { --accent: #0affd0; --surface: #04222b;
               @media (prefers-color-scheme: dark) { --surface: #021317; } }
```

```xml
<vstack variant:theme="dsx.global.app.brandTheme">  <!-- white-label, live-switchable -->
```

**The static-sheet rule (a deliberate design decision):** `<style>` sheets are compiled
once and contain **no `{{ }}` interpolation** (lint error). Reactivity enters styling
through exactly two doors — **class membership** (`class:` directives, formula-driven
sets) and **custom-property bindings** (`style:--x`). Rules stay static, *values* flow
through variables, *membership* flows through classes. This keeps sheets shareable and
memoizable per component (not per instance) and makes every reactive dependency visible
in the markup, not hidden mid-sheet.

### 4.3 Inline styles — with the "beyond CSS" powers (the element-level ask)

Three mechanisms, layered, all lint-checked:

**(a) `style=""` accepts full CSS *Nesting* grammar** — media queries, container queries and
state selectors *inline on the element*. This "fixes CSS" (the web's style attribute can't
do this) while remaining 100% real CSS syntax — priors intact, parsers unmodified:

```xml
<vstack style="
    padding: 16px; gap: 10px; background: var(--surface); border-radius: 14px;
    @media (min-width: 600px) { padding: 24px; max-width: 560px; align-self: center; }
    @media (prefers-color-scheme: dark) { border: 0.5px solid rgba(255,255,255,0.08); }
    &:pressed { opacity: 0.85; }
">
```

**(b) Conditional class directives** (Svelte prior art) — classes toggled by JSE, attached
to the element, no `{{ }}` string-splicing:

```xml
<hstack class="row" class:selected="dsx.variable.sel === item.id"
                    class:offline="!dsx.global.app.online">
```

**(c) Single-property reactive styles** — one property bound to one expression:

```xml
<vstack class="bar" style:width="(dsx.variable.progress * 100) + '%'"
                    style:background="item.risky ? 'var(--warn)' : 'var(--ok)'"/>
```

> **The brace rule (normative):** a `name:arg=` directive's whole value IS a JSE
> expression — written bare, like `on:tap` always has been. `{{ }}` braces mark expression
> islands *inside literal text* only (`value="Total: {{ n }}"`, `class="card {{ mood }}"`).
> One rule, no exceptions, both for humans and for lint.

**(c2) Variant groups** — the "one state → one of N classes" pattern as a single directive.
`variant:<group>="expr"`: the expression's string value is applied as a class and the
group's previous value is **atomically removed** (mutual exclusion per group; several
groups may coexist on one element). Never overloads `class:` (which stays boolean-only):

```xml
<image class="pet" variant:mood="petMood" variant:size="dsx.global.screen.compact ? 'sm' : 'lg'"/>
<!-- .pet.happy / .pet.hungry / .pet.critical react in the sheet; the previous
     mood class is removed in the same update — no stale-class bug possible. -->
```

Lint verifies that at least one reachable rule reacts to each statically-knowable value.

**(d) Element-owned classes** — an element can carry rules that react to its own classes,
right on itself, and toggle those classes by state.

First, a disambiguation that trips even experienced web developers, so the spec states it
outright. There are **two kinds of classes**, and they behave exactly as on the web:

1. **Defined classes** — a name with a rule in a stylesheet (`.bubble { … }` in the
   component's `<style>`, or a global utility). `class="bubble"` *references* it.
2. **State-flag classes** — a name with **no definition anywhere**, used purely as a boolean
   flag that selectors match (`is-open`, `expanded`, `mine`). On the web you create these
   with `classList.toggle('is-open')` and react with `.card.is-open { … }`; nobody
   "declares" `is-open`. Same here: `class:expanded="expr"` sets the flag, and either a
   sheet rule (`.bubble.expanded`) or an inline nested rule (`&.expanded`) reacts to it.

The familiar, fully-traced form — classes defined in the component sheet, flags toggled by
directives:

```xml
<vstack class="bubble" class:mine="item.author === dsx.global.app.userId"
                       class:expanded="dsx.variable.open === item.id"
        on:tap="dsx.variable.open = (dsx.variable.open === item.id ? null : item.id)">
  <head>
    <style>
      /* .bubble is DEFINED here — the component's scoped stylesheet */
      .bubble {
        padding: 12px; border-radius: 16px; background: var(--surface);
        max-height: 64px; overflow: hidden;
        transition: max-height 280ms -dsx-spring(0.4, 0.85), background 150ms ease;
      }
      /* expanded / mine are state FLAGS — no definition, only rules that react */
      .bubble.expanded      { max-height: 400px; }
      .bubble.mine          { background: var(--accent); align-self: flex-end;
                              border-end-end-radius: 4px; }
      .bubble.mine.expanded { box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
    </style>
  </head>
  <text value="{{ item.text }}"/>
</vstack>
```

The element-owned form — when a variant belongs to *one element* and a stylesheet is
ceremony, the reacting rules ride the element itself via CSS Nesting in `style=""`
(`&` = **this element**, the same `&` as nested CSS):

```xml
<vstack class:expanded="dsx.variable.open === item.id"
        style="max-height: 64px; overflow: hidden;
               transition: max-height 280ms -dsx-spring(0.4, 0.85);
               &.expanded { max-height: 400px; }
               &.expanded:pressed { opacity: 0.9; }">
```

Web translation: `el.classList.toggle('expanded', …)` plus a rule scoped to exactly this
node — written where the node is instead of in a faraway sheet. (The web's style attribute
cannot nest; this is a deliberate "beyond CSS" extension using unmodified CSS Nesting
grammar.) `&.expanded` rules are **this element's private vocabulary** — the same names can
exist at component or global scope with different meanings and nothing collides (next
block). Combinations (`&.mine.expanded`), state chains (`&.expanded:pressed`), and
media-gated variants (`@media (min-width: 600px) { &.expanded { max-height: 560px } }`)
all compose, because it is all just CSS Nesting grammar.

**The scope chain (how the same class name lives at three levels without Webflow-style
global-class soup).** DSX-CSS grounds this in real CSS **cascade layers** (`@layer`) — the
engine assigns every rule to an implicit layer by where it was declared:

```
@layer global, component, element;      ← weakest → strongest, always, automatically
   global:    theme.css utilities & element defaults   (lint-capped, discouraged)
   component: the file's scoped <style>
   element:   &.name rules in the element's own style=""
   (plain inline declarations still beat all layers — standard CSS)
```

So `.selected` can exist globally, per-component, and per-element simultaneously: **all of
them apply; on conflicting properties the nearest scope wins — deterministically, by layer,
never by specificity arithmetic.** This is lexical scoping for styles, using CSS's own
modern cascade mechanism, and it's the structural answer to global-class magnets: the
global layer is the *weakest*, so nothing global can ever override a component's or
element's own styling. Lint reinforces the gradient — global classes warn unless they're
single-class utilities or tokens.

**Fully state-driven class sets.** The `class` attribute is a reactive expression surface
like every DSX attribute — and it composes with the head's existing state machinery
(`variable` / `computed` / `formula`), so class membership can be derived logic, not
string-splicing in markup:

```xml
<head>
  <variable as="hp">return 82</variable>
  <formula as="petMood">
    return dsx.variable.hp > 66 ? 'happy' : (dsx.variable.hp > 33 ? 'hungry' : 'critical')
  </formula>
  <style>
    .pet.happy    { --tint: var(--ok);   animation: idle 2.4s ease-in-out infinite; }
    .pet.hungry   { --tint: var(--warn); animation: fidget 1.2s ease-in-out infinite; }
    .pet.critical { --tint: var(--bad);  animation: shiver 400ms linear infinite; }
  </style>
</head>

<image class="pet {{ petMood }}" src="{{ pet.sprite }}"/>
```

One formula, three mutually-exclusive class states, styling + motion reacting to game
state — the "everything stateful" model. Invalidation stays O(element): a class-set change
re-resolves that node only (class-set hashing, ledger #15), and the animations it swaps
run on native animators, never on the script thread.

**(e) Style formulas — JSE logic that returns reactive CSS, multiple per element.** A
`<formula>` may return a **style object**: keys are CSS property names (kebab-case
canonical; camelCase accepted and normalized), values are CSS value strings. Any element
applies one or more with `style:apply` — an ordered, space-separated list of named sources:

```xml
<head>
  <formula as="barStyle">
    /* full JSE: branches, math, whatever — returns declarations */
    const pct = dsx.variable.done / dsx.variable.total;
    return {
      'width': (pct * 100) + '%',
      'background': pct < 0.3 ? 'var(--warn)' : 'var(--ok)',
      'border-radius': pct === 1 ? '0px' : '4px'
    }
  </formula>
  <formula as="dangerGlow">
    return dsx.variable.hp < 20 ? { 'box-shadow': '0 0 12px var(--bad)' } : {}
  </formula>
</head>

<vstack class="bar" style="height: 8px" style:apply="barStyle dangerGlow"/>
```

- **Objects, never CSS strings** (returning a string is a lint error). Property names
  validate against the catalog — at build time whenever the return object literals are
  statically visible to lint, at runtime with loud diagnostics otherwise. Values go through
  the memoized value parser (shapes repeat; steady-state parse cost ~zero). This keeps the
  "runtime never parses stylesheets" invariant and keeps failures structured — a generated
  typo can never silently vanish.
- **Merge order, deterministic (weakest → strongest):** sheet rules → static `style=""` →
  `style:apply` sources in listed order → `style:prop` directives. Same-property conflicts:
  later wins, period.
- Re-evaluation is **diffed**: only properties whose value actually changed re-resolve;
  paint-only diffs skip layout (the §7 ladder applies unchanged).

**Full reactivity is a guarantee, not a behavior note (normative):** every styling binding —
`class="… {{ formula }}"`, `class:x`, `variant:g`, `style:prop`, `style:--x`,
`style:apply` — is dependency-tracked through the store exactly like `{{ }}` attributes
today, and re-evaluates whenever any state it read changes. There is no manual invalidation
API and no stale-style state: styling is a pure function of state, always.

Interpolation (`{{ }}`) stays legal inside `style=` values exactly as today; (b)/(c)/(d)/(e)
are the structured forms lint will steer heavy usage toward. The old `<style as="card" …/>`
attribute-classes become CSS classes mechanically (`<style as="card" padding="16"/>` →
`.card { padding: 16px }`) — the migration codemod writes them.

### 4.4 Units — and the `rem` correction you asked for

Your `rem` instinct is not just sensible — **native can make it better than the web**:

| Unit | Meaning in DSX-CSS |
|---|---|
| `px` | **1 pt (iOS) / 1 dp (Android)** — device-independent, never a physical pixel. (Correction: on native, "px" as hardware pixels would be unusable; we define it as the dp/pt everyone actually means. `0.5px` is legal for hairlines; `-dsx-hairline` does it semantically.) |
| `rem` | Root size = **16 × the user's Dynamic Type / Android font-scale factor**. A layout written in rem is *automatically accessibility-responsive* — the thing the web wishes rem did. |
| `em` | Relative to the element's own font-size (standard). |
| `%` | Of the containing block, per CSS spec (§8 pins down the definition). |
| `vw`/`vh`/`vmin`/`vmax` | Of the **window/scene**, not the device — correct under iPad split-view and Android multi-window, reactive on resize. |
| `env(safe-area-inset-*)` | Standard CSS, mapped natively — symmetric with what Despia injects into WebViews today. |
| `env(-dsx-keyboard-inset)` | Extension: live keyboard height (the web is still standardizing this; we need it now). |

### 4.5 Media & container queries

- `@media`: `width/height` (window-relative), `orientation`, `prefers-color-scheme`,
  `prefers-reduced-motion`, `prefers-contrast`, `hover`, `pointer`, plus
  `-dsx-dynamic-type` (query the accessibility text-size bucket — beyond the web).
- `@container` (size containment): **the component-first answer**. A `CalorieCard` should
  respond to *its slot*, not the device — in lists, sheets, split view, and the visual
  editor canvas, container queries are what make one component correct everywhere:

```css
.card { container-type: inline-size; }
@container (min-width: 420px) { .macros { flex-direction: row; } }
```

- `:hover` exists (iPad pointer, Mac Catalyst) but is gated behind `@media (hover: hover)`
  exactly like the responsible web pattern; the primary interactive state is `:pressed`
  (alias `:active`), plus `:focus`, `:disabled`.

### 4.6 Motion: transitions, `@keyframes`, `@starting-style`, springs

All animation compiles to **native animators** (Core Animation / ValueAnimator & Compose
animation) — never per-frame script. `transform`/`opacity`/`filter`/color animate on the
compositor fast path; animating layout properties (`width`, `gap`, …) is legal but lint
flags it with a performance note.

```css
/* Tamagotchi: idle bounce + feed reaction + entry */
.pet { animation: idle 2.4s ease-in-out infinite; transform-origin: 50% 100%; }
@keyframes idle {
  0%, 100% { transform: scaleY(1); }
  50%      { transform: scaleY(0.94) translateY(2px); }
}
.pet.fed { animation: chomp 500ms -dsx-spring(0.5, 0.8) 2; }

.snack-sheet {
  transition: transform 320ms -dsx-spring(0.35, 0.8), opacity 200ms ease-out;
  @starting-style { transform: translateY(24px); opacity: 0; }   /* entry, real CSS */
}
@media (prefers-reduced-motion: reduce) {
  .pet, .snack-sheet { animation: none; transition: none; }       /* and the engine
     auto-degrades any animation not explicitly opted back in — stronger than the web */
}
```

- `-dsx-spring(response, damping)` is an **easing extension** (CSS has `linear()`; native
  has real springs — expose them where the platform is richer).
- `@starting-style` is stable modern CSS (Chrome/Safari/Firefox) — adopted 1:1 for
  entry transitions; paired with element `enter=`/`exit=` verbs that already exist.
- Reduced motion is enforced **by the engine**, not by author discipline: under
  `prefers-reduced-motion`, transitions jump to end state and `animation` plays its final
  frame unless a rule inside the reduce-motion media query explicitly re-enables it.

### 4.7 Marquee & masonry (corrections + commitments)

- **Correction — marquee:** `<marquee>` is dead HTML and the CSS marquee module was
  abandoned; no modern browser ships it. The *need* (auto-scrolling overflow text — Now
  Playing tickers) is real and native apps do it constantly. We ship it as an extension
  property with a defined a11y story:

```css
.title { white-space: nowrap; overflow: hidden;
         -dsx-marquee: 30s linear infinite alternate;   /* only engages when overflowing */
}
/* reduce-motion: engine renders static text with a trailing fade instead */
```

- **Correction — masonry:** not yet interoperable on the web (Firefox flag vs the
  `display: masonry` debate). Native doesn't have to wait — we ship the shortest-column
  algorithm now under a prefixed value and **auto-alias to the standard syntax when it
  stabilizes**:

```css
.feed { display: -dsx-masonry; -dsx-masonry-columns: 2; gap: 8px; }
@container (min-width: 700px) { .feed { -dsx-masonry-columns: 3; } }
```

Masonry participates in the lazy `<list>` machinery (placement is computed per-item on
measure; virtualization keeps only visible cells alive).

### 4.8 Accessibility: ARIA-shaped, natively mapped

Correct instinct with one adjustment: ARIA is a DOM contract, but its *vocabulary* is what
authors and LLMs know — so we adopt the vocabulary and map it to the native trees
(UIAccessibility / AccessibilityNodeInfo). Existing `a11y*` attributes remain as aliases.

```xml
<pressable role="button" aria-label="Feed the cat" on:tap="feed">…</pressable>
<image src="{{ pet.avatar }}" aria-hidden="true"/>
<text aria-live="polite" value="{{ dsx.variable.statusMessage }}"/>
```

| Authoring | iOS | Android |
|---|---|---|
| `aria-label` | `accessibilityLabel` | `contentDescription` |
| `role` (button/header/image/…) | traits | `className`/roles |
| `aria-hidden` | `isAccessibilityElement=false` | `importantForAccessibility=no` |
| `aria-live` | `UIAccessibility.post(.announcement)` | live regions |
| `rem` + `-dsx-dynamic-type` MQ | Dynamic Type | fontScale |

### 4.9 The `-dsx-*` namespace (native beyond CSS) — properties, never magic classes

Vendor-prefix precedent, parser-safe, typed in the catalog, lintable. Reserved *classes*
are rejected: they collide with user code and can't carry typed values.

| Property | Values | iOS | Android | Degradation |
|---|---|---|---|---|
| `-dsx-material` | `thin·regular·thick·chrome` | UIVisualEffectView materials | RenderEffect blur+tint (12+) | <12: translucent scrim; Reduce-Transparency: solid |
| `backdrop-filter: blur(N)` | standard CSS | visual effect view | RenderEffect | same ladder |
| `-dsx-haptic` | `light·medium·success·…` (fires on `:pressed`) | UIFeedbackGenerator | HapticFeedback | no-op |
| `-dsx-hairline` | color token | 1 physical px line | 1 physical px | — |
| `-dsx-marquee` / `display:-dsx-masonry` | §4.7 | custom layout plugin | same core | reduce-motion / plain column |
| `-dsx-spring()` | easing fn | CASpring | spring spec | falls back to `ease-out` |

### 4.10 · Authoring resilience — formatting, comments, and error recovery

People prettify; people forget semicolons; AIs generate CSS with idiosyncratic whitespace.
The engine's posture: **render forgivingly everywhere, demand cleanliness only at the CI
gate, never fail silently.**

**Formatting is guaranteed-insignificant.** CSS is whitespace-insensitive by grammar and the
DSX-CSS parser honors that fully: multiline values, arbitrary indentation, tabs, blank
lines, and `/* comments */` are legal in **both** `<style>` blocks and `style=""` attributes
(CSS permits comments in inline styles; so do we). The final declaration before a `}` or the
end of an attribute needs no semicolon (standard CSS). Pretty-printed and minified sheets
parse to the identical IR — byte-for-byte.

**The XML wrinkle, decided.** Pretty CSS contains bare `&` (the nesting selector, often at
line starts) and newlines inside attribute values — both of which strict XML mangles
(entity errors; attribute newline→space normalization). Decision: the DSX tokenizer treats
`<style>` bodies **and `style=""` attribute values as raw-text islands** — no entity
parsing, newlines preserved — exactly as HTML treats `<style>` as a raw-text element. For
tool-generated markup that escapes anyway, `&amp;` is accepted and normalized to `&`.
Nothing to remember: paste CSS, formatted however you like, it parses. `{{ }}` interpolation
islands are lifted out before CSS tokenization, so they are format-proof too.

**Missing semicolons: recovered, deterministically, with a warning — not silently dropped.**
The web's behavior here is the worst of CSS: forget one semicolon and the browser silently
discards a declaration. Our parser follows CSS's standard error-recovery containment (an
invalid declaration can never break the rest of the sheet), *plus* one safe heuristic on
top: while reading a declaration's value — outside strings, outside `url()`/functions, and
never inside a custom-property value (whose grammar legally allows anything) — encountering
`IDENT ':'` where the ident is a **known property from the catalog** is treated as a
forgotten semicolon: the parser splits there, keeps *both* declarations, and emits a
warning with the exact fix:

```
style.css:41  missing ';' after `color: red` — recovered
              color: red font-size: 12px
                        ^ inserted ';'
```

Dev builds and live preview render the recovered result immediately; `lint_dsx --strict`
(the CI gate) counts recoveries as findings so the committed codebase stays clean; the
formatter (below) auto-fixes them. Anything the heuristic cannot disambiguate falls back to
standard CSS recovery — the single declaration is dropped **loudly** (build-time finding
naming file, line, and the dropped text), never silently.

**One canonical formatter.** `dsx fmt` (Phase 2 tooling) formats DSX-CSS in sheets and
attributes — so "prettify" has one authoritative answer, diffs stay minimal, and the
auto-fixable findings (semicolons, spacing) never need a human keystroke.

### 4.11 · Feature detection & fallback — `@supports`, done truthfully

Two standard CSS mechanisms cover "use the native thing, fall back declaratively when it
isn't there" — both adopted, one upgraded.

**(a) Cascade-order fallback** — the classic web pattern, works identically here. Write the
fallback first, the enhanced declaration second; where the second can't apply, the first
stands:

```css
.sheet {
  transition: transform 320ms ease-out;                    /* fallback */
  transition: transform 320ms -dsx-spring(0.35, 0.8);      /* wins where available */
}
.bar {
  background: rgba(20, 20, 22, 0.72);                      /* fallback scrim */
  -dsx-material: thin;                                     /* wins on capable devices */
}
```

**(b) `@supports` — resolved against REAL device capability, not just parser grammar.**
On the web, `@supports` only answers "does the parser understand this?" — famously useless
for knowing whether the effect actually renders. Ours answers **"will this take effect on
this device, right now?"**, resolved at runtime against the same capability table that
drives the `-dsx-` degradation ladders (§4.9) — one source of truth:

```css
@supports (-dsx-material: thin) {
  .bar { -dsx-material: thin; color: var(--text); }
}
@supports not (-dsx-material: thin) {
  /* Android < 12, Reduce-Transparency, etc. — the author-designed alternative */
  .bar { background: rgba(20, 20, 22, 0.85); border-top: 0.5px solid rgba(255,255,255,0.08); }
}
```

`and` / `or` / `not` compose per spec. Capability buckets behave like media-query buckets —
mostly static per device, but re-resolvable when they can change mid-session (the
Reduce-Transparency accessibility toggle flips `-dsx-material` support live).

**Relationship to the automatic ladders:** if the author writes nothing, the catalog's
degradation ladder applies (material → scrim, spring → ease-out) — zero-effort safety.
`@supports` is the author *override*: "don't give me the automatic fallback, give me this
designed one." Both read the same table, so they can never disagree.

**Reconciling fallbacks with strict lint (typo vs capability):**

| Case | Verdict |
|---|---|
| Unknown property name (`colr:`) | **Build error** — it's a typo, not a fallback |
| Known property, malformed value (`-dsx-spring(fast)`) | **Build error** |
| Known property, well-formed value that's device/version-gated | **Legal** — resolved at runtime (this is what fallbacks are for) |
| Repeated declaration (fallback-then-enhanced) | Legal, standard cascade |

**OTA version skew** — the native twin of "old browsers": Despia serves hosted `.dsx`
over the air, so newer markup can reach apps running an older engine. Build-time lint is
strict against the engine version you ship; the **runtime is web-forgiving for OTA-served
styles** — a declaration the older engine can't parse is dropped with a diagnostic
(telemetered, never silent) and the cascade fallback above it applies. Failing hard on OTA
content would brick live screens; forgiving-with-telemetry keeps them rendering exactly the
way the web has survived version skew for thirty years.

### 4.12 · Named reusable style units — `@mixin` / `@apply` / `@function`

The script side of a DSX head has `<function>`/`<action>`/`<formula>` — named reusable
units. Styling's analogs mostly already exist (a class is the named invocable unit, a
custom property is the variable, `@keyframes` is the named animation, `@property` the typed
contract). The one genuine gap is composition **inside a rule** — filled with the
CSSWG-tracked mixins/functions syntax rather than an invention:

```css
/* A global MIXIN library is safe where global classes aren't: mixins match
   nothing on their own — they're vocabulary, inert until applied. */
@mixin --pressable-card {
  padding: var(--pad); border-radius: var(--radius-card); background: var(--surface);
  transition: transform 120ms ease-out;
  &:pressed { transform: scale(0.98); }
}
@function --hairline-pad(--base) { result: calc(var(--base) + 0.5px); }
```

```css
.bubble { @apply --pressable-card; padding: --hairline-pad(12px); max-height: 64px; }
.cta    { @apply --pressable-card; background: var(--accent); }
```

Rules: resolved **at build time** (inlined into the IR — zero cascade/runtime cost; in-rule
conflicts resolve as "later declaration wins"); parameters per the draft; recursion is a
build error; unknown mixin/function = build error; unused = warning. Deliberately excluded
(the overkill line): no `<mixin>` markup tags (sheet grammar, not XML surface), no
imperative "style actions" (styling stays a pure function of state), and no Sass-style
compile-time programming in sheets (loops/conditionals — JSE style formulas already cover
the dynamic side; two Turing-complete layers in one styling system is how sheets become
unreviewable).

## 5 · Conformance tiers (the contract that prevents "accidentally a browser")

- **Tier A — identical by math** (one layout core, bit-identical cross-platform, verified by
  shared JSON fixtures): box model, flexbox complete, grid complete, block flow for text
  stacking, `position: relative/absolute` (+`fixed` within a surface), `aspect-ratio`,
  `overflow` (→ native scroll views), `display: none/flex/grid/-dsx-masonry`, `gap`,
  min/max, `%`, logical properties (RTL flips free), `z-index` (§8).
- **Tier B — same intent, platform rendering** (per-platform screenshot goldens):
  backgrounds/gradients (linear·radial·conic), `border`, `border-radius` (per-corner),
  `box-shadow`, `opacity`, `transform` (2D + `perspective`/3D subset), `filter` subset,
  typography (`font-*`, `line-height` §8, `letter-spacing`, `text-overflow`,
  `-webkit-line-clamp`→`line-clamp`), `transition`/`animation`/`@starting-style`.
- **Tier C — native extensions** (`-dsx-*`): defined degradation ladder per property, in the
  catalog.
- **Out, rejected by lint (v1):** floats; mixed inline flow (text runs are element-level);
  pseudo-elements (`::before/::after` — revisit); `@import`; `!important`; global descendant
  selectors. Each rejection message names the sanctioned alternative.

CSS-wide keywords: `inherit` supported for inheritable properties (fonts, color,
text-align…, per catalog flag), `initial`/`unset` resolved from the catalog. Shorthands
(`margin`, `padding`, `border`, `inset`, `flex`, `font`, `transition`, `animation`) expand
at build time in the parser — runtime sees only longhands.

## 6 · Use-case gallery (the 500k-apps sweep)

**Video-calling app — grid areas + overlays + insets:**

```xml
<vstack class="call">
  <head><style>
    .call  { display: grid; height: 100%;
             grid-template-rows: 1fr auto;
             grid-template-areas: "stage" "controls";
             padding-bottom: max(env(safe-area-inset-bottom), env(-dsx-keyboard-inset)); }
    .stage { grid-area: stage; display: grid; gap: 2px;
             grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .pip   { position: absolute; inset: auto 12px 12px auto; width: 96px;
             aspect-ratio: 3/4; border-radius: 12px; overflow: hidden;
             transition: transform 250ms -dsx-spring(0.3, 0.85); }
    .controls { grid-area: controls; display: flex; justify-content: center; gap: 16px;
                padding: 12px; -dsx-material: thin; }
  </style></head>
  …
</vstack>
```

**Social feed — masonry + container queries + conditional states:** §4.7 feed + per-card
`@container`, `class:liked="item.liked"` toggling a sheet rule with a spring transition.

**Calorie counter — tokens + rem + dynamic type:** whole layout in `rem`; the
`-dsx-dynamic-type` media query drops a 3-column macro grid to 1 column at accessibility
sizes — a class of correctness the web can't even express.

**Chat / i18n — logical properties:** `padding-inline-start`, `margin-inline`,
`border-start-start-radius` — RTL correct with zero author effort; the demo's chat bubbles
stop caring about direction.

**Ticker / Now-Playing:** `-dsx-marquee` (§4.7).

**Onboarding / games:** `@keyframes` + `@starting-style` + springs (§4.6) — with the engine-
enforced reduced-motion floor.

## 7 · Runtime semantics & performance

- **Build time:** every `<style>`/`style=`/theme sheet parses once in `prepare_modules` →
  typed IR in the Registry (exactly like `StackComponents.generated.swift` today). Parse
  errors and catalog violations fail `lint_dsx --strict` locally and in CI. Runtime never
  parses CSS text.
- **Resolution:** per node = element defaults ∪ matched scoped rules ∪ inline; memoized by
  (rule-set hash, state bits, MQ bucket, container bucket, token snapshot).
- **Reactivity:** media/container/state changes are store slices (`dsx.screen` exists
  today); a flip re-resolves only nodes whose match-set can change (rules are indexed by
  their query buckets). `class:`/`style:` directives invalidate exactly one node.
- **Layout:** one Taffy tree per surface; dirty-marking from resolved-style diffs; text leaf
  nodes use measure callbacks (TextKit / StaticLayout) cached by
  `(text, font, width-bucket, dynamic-type)`. **Text measurement caching is the #1
  performance seam — it gets its own benchmark suite.**
- **Animation:** compiled to native animators; JSE is never on the frame path.
- **Budgets (CI-enforced):** cold style-build ≤ 1ms/100 nodes; full re-layout ≤ 4ms/1k nodes
  mid-range; dark-mode flip ≤ 1 frame @120Hz for token-only changes (token swap without
  re-layout when only paint properties change).

## 8 · Edge-case ledger (decisions, not open questions)

| # | Edge case | Decision |
|---|---|---|
| 1 | `%` resolves against what? | CSS containing block: nearest non-`static` positioned ancestor for `position:absolute`, else parent content box. Percent heights require a determinate parent height (as CSS) — lint warns on the classic indeterminate-height trap. |
| 2 | Window resize / iPad split / foldables | `vw/vh` + `@media` are **window-relative and reactive**; rotation and split-view are resizes, not reloads. |
| 3 | Dark-mode flip mid-animation | Running animations retarget colors (native animators support re-target); token-only flips skip layout. |
| 4 | Reduce-motion arrives mid-animation | Engine finishes to end-state instantly; `-dsx-marquee` degrades to static+fade. |
| 5 | RTL | Logical properties auto-flip; physical ones don't (spec behavior); `-dsx-flip-rtl: true` for directional glyphs. |
| 6 | `z-index` across native views | Stacking contexts per spec, implemented by sibling reorder within a surface; a stacking context is a real native container (transforms/opacity<1 create one, as CSS). Shadows vs `overflow:hidden` follow CSS (clipped) — `-dsx-shadow-outside` escape if ever needed. |
| 7 | Nested scrolling (CSS `overflow:scroll` inside `<list>`) | Delegated to platform gesture arbitration (UIScrollView / NestedScrollingChild) — never reimplemented. |
| 8 | Animating layout properties | Legal; lint perf-notes it; compositor props are the documented fast path. Springs on layout run as native property animators driving re-layout per frame with a node-count guard. |
| 9 | `line-height` semantics | CSS half-leading model (not UIKit's) — TextKit/StaticLayout configured to match, golden-tested; this is a known cross-platform text trap and gets pinned early. |
| 10 | Fonts | `font-family` = bundled/system stacks; `@font-face` maps to bundle-registered fonts (module `content` capability); SF↔Roboto fallback contract documented per weight. |
| 11 | Keyboard | `env(-dsx-keyboard-inset)` live-updates; interacts with `max()` (see video-call sample). |
| 12 | Hit-testing under `transform` | Transformed hit-testing per platform (`CALayer` handles it); `pointer-events: none` supported. |
| 13 | Dynamic Type change at runtime | `rem` recompute → batched re-layout; text measure cache keyed by type size (no stale sizes). |
| 14 | Cell reuse in `<list>` | Style resolution memoized per (template, state-bits); enter animations (`@starting-style`) fire on *item* appearance, not cell reuse — the list machinery already distinguishes these. |
| 15 | `class` list churn | Class-set hashing; identical sets re-use resolved style objects. |
| 16 | Unknown property / typo | **Build error** with nearest-name suggestion (fixing CSS's worst DX trait while keeping its grammar). |
| 17 | Inline `@media` + specificity | Media queries *gate* declarations, they don't add specificity (per CSS); inline still beats sheets. |
| 18 | `@starting-style` + `display:none→flex` | Supported per spec — this is precisely what the feature exists for. |
| 19 | Masonry + virtualization | Placement solver runs on measured heights; estimated-height placeholder until measured (same contract the lazy list already has). |
| 20 | Container query loops (child resize → container resize → …) | Size containment required on queried containers (per spec) — the loop is structurally impossible; lint enforces `container-type`. |
| 21 | Gradients/conic on old Android | Conic → sweep gradient (native); all gradients Tier B goldens. |
| 22 | `!important` | Parse, lint-error, message points to `class:` directives / scoping. |
| 23 | Two dialects during migration | None at runtime: legacy attributes compile INTO DSX-CSS declarations from day one — one engine, two syntaxes temporarily, codemod finishes it. |
| 24 | Visual style panel | Reads the same catalog + IR (today's `stack-style-properties.json` becomes the DSX-CSS property catalog — same maintenance loop, `check_style_catalog.rb` keeps enforcing it). |
| 25 | Same class name at global + component + element scope | All apply; conflicts resolve by implicit `@layer global < component < element` (nearest wins, never specificity arithmetic). An element-local `&.x` never leaks to siblings — it compiles keyed to that node. |
| 26 | A class referenced (`class="bubble"`) or toggled (`class:x`) that no reachable rule defines **or matches** | Lint warning ("class `bubble` is used but no rule in any reachable scope defines or reacts to it") — catches both the typo'd variant and the dangling reference at build time. A pure state flag is fine as long as *some* selector (sheet `.a.x` or inline `&.x`) reacts to it. |
| 27 | Class-set thrash from a fast-changing formula (e.g. per-frame game state) | Class-set hash short-circuits identical sets; transitions retarget rather than restart when the same property changes mid-flight; lint perf-notes formulas bound to `class` that depend on high-frequency store slices. |
| 28 | Pretty-printed / multiline / commented CSS in `style=""` and `<style>` | Fully insignificant (CSS grammar) — including comments in inline styles and no final semicolon. Pretty and minified parse to identical IR (§4.10). |
| 29 | Bare `&` and newlines inside XML attribute values | `<style>` bodies and `style=""` values are raw-text islands in the DSX tokenizer (no entity parsing, newlines preserved); `&amp;` accepted and normalized for escaping tools (§4.10). |
| 30 | Forgotten semicolon between declarations | Deterministic recovery when the next token pair is `known-property ':'` outside strings/functions/custom-property values — both declarations kept, warning with exact fix emitted; dev renders, CI strict counts it, `dsx fmt` auto-fixes. Undecidable cases: single declaration dropped **loudly** (file/line/text named), never silently (§4.10). |
| 31 | Reactive custom-property fan-out cost | A `style:--x` write re-resolves only `var(--x)`-dependent declarations in the subtree (dependency index built at compile). Paint-only consumers skip layout; a var consumed by a layout property (e.g. `padding: var(--pad)`) triggers a scoped re-layout of the affected subtree only. Lint perf-notes vars consumed by layout properties when bound to high-frequency state. |
| 32 | `@supports` truthfulness | Resolved at runtime against the device capability table (the same table driving the `-dsx-` degradation ladders — one source of truth). Capability buckets re-resolve like media buckets when they can change live (e.g. Reduce Transparency flips `-dsx-material`). |
| 33 | OTA version skew (newer hosted `.dsx` on an older engine) | Build-time lint strict against the shipping engine's catalog; runtime web-forgiving for OTA-served styles — unparseable declarations drop with a telemetered diagnostic and the cascade fallback applies. Hard-failing OTA content would brick live screens. |
| 34 | Style formulas: validation & cost | Objects only (CSS strings = lint error). Keys validated at build when return literals are statically visible, else at runtime with loud diagnostics. Values through the memoized value parser. Re-evaluation diffed per property; paint-only diffs skip layout. Lint perf-notes a style formula that writes layout properties while depending on high-frequency state. |
| 35 | `variant:` group races | The group's class swap is atomic within one update pass — old and new value classes can never coexist on a frame; transitions between variant states retarget per ledger 27. |

## 9 · What changes at the XML level (summary of markup additions)

1. `<style>` in the head: real CSS, scoped by default, `:global()` escape.
2. `style=""`: full CSS Nesting grammar (media/container/state inline), including
   **element-owned classes** via `&.name { … }`.
3. `class:name="expr"` (boolean flag) · `variant:group="expr"` (value-as-class, mutually
   exclusive per group) · `class="card {{ formula }}"` (island mixing) — resolution across
   global/component/element scopes via implicit `@layer` (nearest scope wins,
   deterministically). Directives take **bare** JSE (the brace rule, §4.3c).
4. `style:property="expr"` — single-property reactive styles; `style:--token="expr"` —
   reactive custom properties; `style:apply="fnA fnB"` — ordered reactive style-formula
   sources (§4.3e). All styling bindings are dependency-tracked and fully reactive
   (normative guarantee, §4.3e).
5. `aria-*` + `role` — accessibility vocabulary (existing `a11y*` = aliases).
6. App-level `theme.css` (tokens/defaults/utilities/`.theme-*` token classes/mixin library;
   lint-capped selectors).
7. **`<stack>` — the generic CSS-driven container** (ratified follow-up to this spec).
   One element; flexbox picks the concrete layout: `flex-direction: column` is the
   default when unset, `row` goes horizontal, `display: grid` (v1: trackless — the
   single-cell overlap idiom) stacks in depth. Web-true defaults on this element only
   (gap `0` when unset; `align-items` for cross alignment, legacy `align` accepted).
   `vstack`/`hstack`/`zstack` remain forever as its fixed-axis presets (still
   supported for third-party/OTA markup + StackLive surfaces); first-party markup
   was swept to `<stack>` by `scripts/migrate_stacks_to_generic.rb`, with the
   implicit platform spacing materialized as explicit `gap`. `gap`/`row-gap`/`column-gap` are axis-correct engine-wide (the cascade
   collapses the right axis onto the stack spacing primitive; two-value shorthand is
   `gap: <row> <column>`), and `display: none` removes any element via the `visible-if`
   gate. v1 limits, honestly: `*-reverse` renders as the base axis and `justify-content`
   activates with the Taffy phase.
8. Everything else in the file format: **unchanged** (anatomy rules 1–7, `as=`, head order —
   `<style>` already has a sanctioned slot in the canonical head order).

## 10 · Rollout

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | This spec ratified; engine choice (Taffy vs Yoga) decided; conformance test corpus adopted (Yoga's Chrome-generated fixtures / WPT flexbox+grid subset) | sign-off |
| 1 | Engine spike behind `style=""` on existing elements; legacy attributes compile to declarations (one engine) | the five demo-audit bug classes are inexpressible; Demo launcher rewritten in CSS passes on device |
| 2 | Scoped `<style>`, classes + directives, tokens, media queries, `rem`/`env()` | dark mode + Dynamic Type demos green; lint validates all CSS in CI |
| 3 | Grid, container queries, transitions, `@keyframes`, `@starting-style`, reduced-motion enforcement | motion gallery on device; perf budgets green |
| 4 | `-dsx-*` set (material, haptic, hairline, marquee, masonry, springs), `aria-*` mapping | extension catalog + degradation goldens |
| 5 | Android renderer on the same core; cross-platform fixture + golden suites | Tier A bit-identical; Tier B goldens signed off |
| 6 | Codemod legacy attrs → CSS; dialect deprecated; docs collapse to "it's CSS + one page of `-dsx-`" | zero legacy attributes in first-party markup |

**AI-authoring benchmark (the actual KPI):** a prompt suite of real screens (including the
five bugs that motivated this) generated cold by an LLM against the engine, scored on
first-pass visual correctness. The whole thesis is measurable — run it per phase.

## 11 · Open decisions (need a call)

1. ~~Taffy vs Yoga~~ — **DECIDED: Taffy** (§3); Yoga+`UseWebDefaults` documented as the
   fallback position only if Rust-in-CI fails the Phase-1 spike.
2. `::before/::after` — punt or Phase 4?
3. Color spaces: adopt `oklch()`/`color-mix()` now (design-tool friendly) or hex/rgb/hsl v1?
4. View Transitions API analogue for route/page transitions — Phase 4+ candidate; the
   `enter=`/`exit=` verbs already cover the basics.
5. Whether the web-side runtime should eventually consume the *same* theme.css tokens
   verbatim (one token file for WebView + native) — strongly suggested, separate proposal.

## 12 · The developer-experience contract (what expert developers judge us by)

A styling engine at 500k-app scale is adopted or abandoned on DX, not on feature lists.
These are **commitments with exit criteria**, not aspirations — each is slotted into the
rollout (§10).

**12.1 · The feedback loop: style hot-reload, sub-second.** Edit a sheet or a `style=""`
and see it on device without rebuilding. Mechanism: **dev builds carry the CSS parser**
and accept style patches over the existing dev channel (Dev Center / hosted-content path);
**release builds carry only the compiled IR** — the "runtime never parses stylesheets"
invariant is a *release* invariant, hot reload is a *dev* capability, and the two never
meet in one binary. State survives the patch (styling is a pure function of state, so
re-styling never resets `dsx.variable.*`). Exit criterion: median edit→pixel under 1s on
device, Phase 2.

**12.2 · Error messages: the Rust/Elm bar, with codes.** Every lint/engine diagnostic has:
a stable code (`DSX-CSS(E042)`), the source span with a caret (build compiles spans into
the IR — errors and the inspector always point at the original `.dsx` line, never at
generated output), a one-line explanation, a concrete fix-it, and a docs URL per code.
`lint_dsx --format=json` emits the same diagnostics machine-readably — **agents self-fix
from structured output**, which is the AI-authoring thesis applied to tooling. No
diagnostic without all five fields; that is itself a CI check on the lint suite.

**12.3 · A language server, not a proprietary editor.** `dsx-lsp` (consumed by VS Code /
JetBrains / anything): completion for properties, values, tokens, classes, variants, and
`@property` contracts (all driven by the same catalog + compiled IR — one source of
truth); go-to-definition (class → rule, token → definition, mixin → declaration,
`style:apply` name → formula); hover = resolved value + which layer wins; inline
diagnostics identical to lint. The visual editor consumes the LSP too — panel and text
never disagree.

**12.4 · The inspector: "why does this look wrong" in one tap.** The Dev Center (shake to
open) gains a style inspector: tap any element → computed styles with the full **cascade
trace** (every candidate declaration, which layer/rule won and why, `@supports`/media
buckets as evaluated *on this device*), layout-bounds overlay (content/padding/border +
flex/grid lines from the Taffy tree), live style edits (dev parser, 12.1), an animation
inspector (running animators, effective easing, reduced-motion state), and the reactive
graph per element — which formulas/vars/classes this node depends on and **which state
write caused the last restyle**. Nothing here ships in App Store builds (test-install
gating already exists).

**12.5 · Testing without a device.** The Rust core is platform-independent: **layout tests
run headless in plain Linux CI** — feed markup + viewport + type-scale, assert rects —
no simulator, milliseconds per case. Ships as `dsx test layout` with fixture files (the
same fixtures that prove Tier-A cross-platform identity). Tier-B visuals: per-platform
screenshot goldens with a blessed update flow (`dsx test golden --update`). Component
style contracts: assert computed styles for a state (`expect(node('.bar')).toHaveStyle(…)`
shape) without rendering pixels. Exit criterion: the conformance corpus runs on every PR
in under a minute, Phase 1.

**12.6 · Profiling: budgets you can see.** Dev builds expose a style profiler (Dev Center
panel + `despia.dev.styleProfile()`): per-frame style/layout/paint cost, which
formulas re-ran and why (the triggering state write), invalidation counts per node,
text-measure cache hit rate, and the layout-property-animation warnings from lint shown
*live* when they actually cost frames. The §7 budgets run in CI on the fixture corpus —
regressions fail the build like any lint error.

**12.7 · Design-token pipeline.** `theme.css` tokens import/export the **W3C Design Tokens
format** (`tokens.json`) — `dsx tokens import` generates the `:root`/`.theme-*` blocks
from a Figma-exported token file, round-trippable. Teams with a design org expect
Figma → tokens → app without hand-transcription; solo devs never see it.

**12.8 · The escape-hatch ladder, documented.** In order, each step sanctioned: tokens →
classes/variants → style formulas → `-dsx-*` extensions → `@supports`-gated platform
styling → a custom layout plugin (masonry's mechanism, public) → a native module with its
own component. No dead ends: the framework never says "you can't"; it says "at this rung."

**12.9 · Zero-config, deterministic, versioned.** No styling config file exists; defaults
are web defaults (delete the decision, not document it). Same input = same IR = same
pixels — byte-stable across machines (build determinism is a CI check). The engine
version is queryable (`@supports` capability buckets already encode it for OTA skew,
ledger 33); the conformance table (§5) is published per release, and property additions
follow the catalog's existing `check_style_catalog` discipline.

Rollout mapping: 12.2/12.5/12.9 land with Phase 1 (they gate everything after); 12.1/12.3
with Phase 2; 12.4/12.6 with Phase 3; 12.7/12.8 with Phase 4.
