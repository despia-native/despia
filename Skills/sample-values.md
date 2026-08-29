# Sample values - unit tests as editor fuel

`sample=` gives a head declaration a UNIT-TEST SAMPLE VALUE: what the editor shows and
seeds when the real logic cannot run - an isolated screen without its cross-screen
context, a thumbnail render, an event you want to inspect before anything fires it.

```xml
<attribute as="title" sample='"Spring sale"'/>
<event as="purchase" sample='{"sku":"pro","price":249}'/>
<api as="orders" url="https://api.example.com/orders" sample='[{"id":1}]'/>
<variable as="count" sample="3">return 0</variable>
```

## The three laws

1. **A sample is JSON.** Not an expression, not a JSE literal - `JSON.parse` on every
   runner, in lint, and in every future native editor. Quote strings
   (`sample='"Spring sale"'`), use `[]` and `{}` for structure. Malformed JSON is a lint
   error naming the fix.
2. **A sample has NO production semantics.** The runtime never evaluates it. A failed
   `<api>` never silently reads its sample - data stays null and the error envelope is
   the truth (corpus: `Conformance/api/api-blocks.json`, the two `sample-*` cases, run on
   all three renderers). Seeding is EDITOR-INJECTED: through the state door for live
   previews, at SSR time for isolated renders. Never a kernel or renderer fallback branch.
3. **v1 kinds only: `variable` · `event` · `api` · `attribute`.** On `<formula>` and
   `<action>` the attribute is deferred - today every head parser folds unknown
   attributes into input bindings evaluated at call time, so a sample there would be
   active runtime state. Lint refuses it (`sample-deferred`) until all four parsers learn
   the skip.

## What the Studio does with them

Precedence per name, resolved in one place: **live snapshot beats sample beats declared
initial.** A sample-fed pill wears the struck-dot `sample` badge, so a planted value can
never impersonate a running one. When the running preview has the real value, the badge
disappears and the pill goes live.

## Where they land

- Compiler: carried VERBATIM in the component IR (`ComponentHead`, the four v1 kinds);
  on an `<api>` the attr is hoisted out of the verbatim runtime attrs.
- `despia edit`: `/edit/api/head` serves `sample` per declaration; the State view
  resolves precedence and badges.
- Lint: `sample-json` (malformed) and `sample-deferred` (formula/action) - shared corpus
  `Conformance/lint/cases/shared/sample-values.dsx`, both runners.
