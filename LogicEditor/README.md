# Despia Logic Editor

A zero-dependency JavaScript SDK for building Despia **formulas** visually: a
node-based dataflow canvas (left → right, one output) - the visual way to
compose logic, with one decisive difference from how visual builders usually
work:

> **DSX/JSE text is the source of truth. The graph JSON is only a VIEW.**
>
> The editor never persists node-soup. Every edit compiles to clean,
> deterministic **JSE** - the expression language all three Despia runtimes
> (Swift · Kotlin · TS) already execute - and that text is what lands in a
> `.dsx` document. Humans and AI keep editing readable markup; the visual
> editor projects it into nodes on demand (`lift`) and writes text back
> (`compile`). Storing logic as JSON is the failure mode this design avoids.

The public class is `StackLogic`. Formulas **calculate** (pure, live-previewable
on every keystroke); actions **do** (top → bottom step flows) - the action
plane is phase 2 of this SDK and `kind: "action"` is reserved in the format.

```js
const logic = new StackLogic(document.getElementById("mount"), {
  jse: "title.includes('despia') ? 'Pro member' : upper(title)",  // lift text into nodes…
  scope: { title: "hello despia" },                                // …and preview live
});
logic.on("change", ({ jse, graph }) => save(jse));            // persist the TEXT
```

## Quick start

**Preview with zero setup.** Open `LogicEditor.html` in a browser from a
checkout. Double-click the canvas to add a node, drag a port (+) to wire,
double-click a value to edit, wheel to zoom, drag empty space to pan. The
Output card shows the live result and the compiled JSE.

**Embed the SDK.** Load `src/logic-editor.js` with a script tag (it registers
`window.StackLogic`) or require it from Node - the core (compile · lift ·
evaluate) is DOM-free, which is how the conformance suite runs. Type
definitions ship in `index.d.ts`.

**Custom element.** `src/logic-editor-element.js` registers
`<despia-logic-editor>` (load it after the SDK): every attribute observed
(`graph`, `jse`, `scope`, `src`, `readonly`), rich values ride same-named JS
properties, every event re-dispatches as a composed `CustomEvent`, and the
imperative handle rides `el.logic`.

**Run the tests.** `npm test` runs the shared JSE conformance corpus against
the SDK's interpreter AND the formula-graph fixture laws (`conformance/`).

## Runtime parity, verified

Live preview is only trustworthy if a formula evaluates in the editor exactly
as it will on device. That property is tested, not promised - the same
discipline as the canvas editor:

- `StackLogic.jse` is the corpus-gated JSE interpreter (ported from the
  canvas editor SDK, same Apache-2.0 lineage). The shared corpus
  (`conformance/jse/`, vendored from the monorepo where Swift is the
  reference) runs on every `npm test`.
- Per-node live values are computed by compiling the node's subtree to JSE
  text and evaluating THAT - the preview exercises the compiler continuously.
- The graph ⇄ JSE projection has its own fixture contract
  (`conformance/graph/`) pinning three laws: **byte-stable compile**,
  **corpus-semantics evaluation**, and **total round-trip** (`lift` structures
  what it recognizes and falls back to a `code` node for the rest, so ANY
  existing deck's formula opens in the editor - nothing is ever rejected).
- `test/run-roundtrip.mjs` walks 64 forms of the JSE expression grammar and
  asserts the property the SDK actually promises: not that the text comes back
  byte for byte (it recompiles, so `(x) => x` returns as `x => x`) but that the
  recompiled text EVALUATES to the same value. 0 of 64 change value.

### How much of the grammar has a node of its own

Measured, and pinned, by that same round trip: **34 of 64 forms lift to real
nodes; the other 30 lift to one `code` node holding their own text.** That is
lossless and total - a `code` node compiles and evaluates exactly as written -
and it is coarser than a node, so the number is written down rather than
implied. The 30 are the forms the vocabulary has no shape for: numeric formats
and radix literals, regex literals, `typeof`, the bitwise and shift operators,
`??`, `in`, `**`, indexing, optional chaining, spread, object shorthand and
computed keys, template literals, default/rest/destructured lambda parameters,
a call on a value, `new`, the bare `map(rows, fn)` spelling, and a plain call
nested inside another.

The census is a GATE. A form that starts degrading fails the suite; a form that
stops degrading also fails it, until the node that landed is named in the diff.

The Studio's own expression canvas is a separate, higher-fidelity reader of the
same language (`OpenSource/Documentation/reference/expression-canvas.md`): it
carries byte spans, covers 168 forms exactly, and edits by splicing the file
rather than recompiling from a graph. This SDK is the standalone drop, and the
two are deliberately different tools - one recompiles, one splices.

## The format (a view, not a store)

```js
{ v: 1, kind: "formula", name: "membership",
  inputs: [{ name: "title", sample: "hello despia" }],   // <formula> inputs + preview samples
  functions: [{ name: "slugify", params: ["text"], body: "…JSE…" }],
  nodes: {
    val:  { kind: "path", path: "title" },
    inc:  { kind: "fn", fn: "includes", args: [{ node: "val" }, { value: "despia" }] },
    root: { kind: "if", cases: [{ when: { node: "inc" }, then: { value: "Pro member" } }],
            else: { value: "Member" } }
  },
  out: { node: "root" } }
```

- **Ports** are `{ node }` (a wire), `{ value }` (an inline literal), or
  `{ code }` (an inline JSE chip - the escape hatch).
- **Node kinds:** `path` · `value` · `fn` (catalog function) · `op` · `if`
  (multi-case switch → ternary chain) · `method` · `get` · `object` · `array`
  · `arrow` · `code`. Labels and parameter names live in the **catalog**
  (`StackLogic.catalog`, extensible via `registerCatalog`), never in the
  stored document - the graph stays lean and diffable.
- **`functions`** are user-declared formulas (the `<script>`-function twin):
  freeform code with declared inputs, surfaced in the palette as lego nodes,
  compiled to plain calls (`demo(a, b)`), previewed by running the body
  through the same interpreter. A body beyond the JSE subset fails open in
  preview - mirroring the tiers law: render-path formulas never escalate, so
  beyond-subset is a lint error on device, and the editor shouldn't pretend
  otherwise.
- The standalone conversion library (no editor, plus DSX markup support and
  line/column diagnostics) is **`@despia-native/dsx-lens`** - same fixture contract,
  so the two can never drift.

## Depth of inspection

Every step shows a clamped preview (at most three lines; structures
pretty-print). The full value lives in the **inspector** - double-click any
value well, or click its "⋯ N lines" chip: a right-docked panel with the
complete value, formatted and highlighted, a copy button, and the step's
compiled JSE behind a quiet toggle. It recalculates live as you edit and
follows selection, so walking the graph walks the data.
`logic.inspect(nodeId | "@out" | null)` drives it from a host.

## Themes

`theme: "auto" | "light" | "dark"` - an SDK option and an attribute on the
element, the facet, and the `<LogicEditor/>` component. `auto` follows the
system scheme live. Dark is the reference; light is the same geometry
re-materialized (paper canvas, white cards, ink text, the same accent).

## Groups & notes (designed - landing next)

Big formulas are where every visual builder breaks down: the usual answer is
extracting formula-from-formula until five project-level formulas exist just
to shorten one. Ours keeps everything in ONE formula and in REAL text:

- **A group is a named `const`.** Grouping nodes names their result; the
  compiler emits a statement-form body -

  ```
  const qualifies = title.includes('despia')
  const tier = isPro ? 'Pro member' : 'Member'
  return qualifies ? tier : upper(title.slice(0, 1)) + title.slice(1)
  ```

  - so the `.dsx` stays readable code, the canvas collapses the group to one
  card with a clear output name, and no new formula pollutes the project.
  (`const`/`return` bodies already run on all three engines today.)
- **Notes are real comments.** Node and group notes will compile to `//`
  lines in the body. JSE has no comment grammar yet, so this lands
  corpus-first across the three engines (tokenizer comment-skip; TS + Kotlin
  gated locally, Swift compile-pending) BEFORE the editor writes a single
  note - text stays the source of truth; nothing lives only in JSON.

`graph.groups` and node notes are reserved in the format today so documents
stay forward-compatible.

## The DSX component

This package is ALSO a Despia DSX package (`dsx.json`, scheme `logic`): the
editor ships as a real DSX component, `<LogicEditor/>`, built from two pieces -
`web/index.js` (the module's web facet: `<LogicCanvas>` mounts this SDK, plus
headless bus actions `dsx.module.logic.compile({graph})` → `{jse}`,
`.lift({jse})` → `{graph}`, `.evaluate({expr, scope})`) and
`Components/LogicEditor.dsx` (the portable component; its head is the
attribute/event contract). Through the framework's embed pipeline
(`web.expose`, /web/13) the same component compiles to a self-contained custom
element, `<despia-logic>`, any plain page can load with one script tag.
Canvas editor for UI, logic editor for behavior - one deck between them.

## API surface

- Instance: `load(graphOrJse)` · `setScope(scope)` · `setCode(on)` · `getGraph()`
  · `getJSE()` · `evaluate()` · `getLayout()/setLayout()` · `fit()` · `destroy()`
  · `on/off`
- Events: `ready` · `change` (`{ graph, jse }` - persist the `jse`) · `select`
  · `deselect` · `preview` (`{ values, result, jse }`) · `view`
- The visual editor stays visual: the compiled-JSE readout on the Output card
  is hidden by default and appears via the card's ghost code toggle (or the
  `code` option/attribute). A full code editor / split view is a separate
  component, not this SDK.
- Statics: `StackLogic.compile(graph)` · `StackLogic.lift(jse, functions?)` ·
  `StackLogic.evaluateGraph(graph, scope)` · `StackLogic.jse.{evaluate,run}` ·
  `StackLogic.catalog` · `StackLogic.registerCatalog(entry)` ·
  `StackLogic.registerIcons(map, mode?)`

## Icons (a swappable layer)

Icons are [Hugeicons](https://hugeicons.com). The open SDK ships the **free
(stroke) set** inlined; it's redistributable, so this Apache-2.0 package stays clean.
The Hugeicons **Pro solid** set is not redistributable, so it is **never
vendored here**; a licensed build injects it at boot instead:

```js
import SOLID from "./your-private/hugeicons-solid.js"; // Pro paths - closed build only
StackLogic.registerIcons(SOLID, "solid");              // glyphs now render filled
```

`registerIcons(map, mode)` merges `{ name: "<svg inner markup>" }` and sets the
render mode (`"solid"` → `fill: currentColor`, `"stroke"` → outline). Same split
as the premium module catalog: paid assets live in the commercial edition, the
open drop ships the free set.

## Repository layout

| Path | Role |
|---|---|
| `src/logic-editor.js` | the SDK, a single dependency-free UMD |
| `src/logic-editor-element.js` | `<despia-logic-editor>`, the custom-element wrapper |
| `index.d.ts` | type definitions for the host contract |
| `dsx.json`, `Components/`, `web/` | the Despia DSX package: `<LogicEditor/>` and its module facet |
| `LogicEditor.html` | self-contained demo (double-click, no server) |
| `samples/` | sample formula graphs |
| `test/run-jse-conformance.mjs` | the shared JSE corpus runner (`npm test`) |
| `test/run-graph-fixtures.mjs` | the graph ⇄ JSE law runner (`npm test`) |
| `conformance/` | vendored shared corpora (jse + graph) |

Development happens in the Despia monorepo (`OpenSource/LogicEditor`), which
rides the public front door at
[`despia-native/despia`](https://github.com/despia-native/despia); issues and
pull requests live there, the single tracker.

## License and scope

Open source under the **Apache License 2.0** (see [LICENSE](./LICENSE)), on the
same terms as the Despia open-source framework and the canvas editor SDK: the
open edition contains the runtime, kernel, and standard tooling; premium
modules are not included; the license grants no rights to the Despia name or
logo.
