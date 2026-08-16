# DSX Canvas Editor

A zero-dependency JavaScript SDK for rendering, editing, and simulating DSX
documents in the browser. This is the canvas at the core of the DSX visual editor:
it draws a `.dsx` deck with the same layout rules, element behavior, and expression
semantics as the native DSX runtime, and adds a full editing surface on top.

The SDK is a single UMD file with no dependencies, no build step, and no server
requirement. Its public class is `StackCanvas`. It is not the DSX web framework;
it is the design and simulation surface used by editors and tooling.

```js
const canvas = new StackCanvas(document.getElementById("mount"), {
  controls: true,
  data: { title: "Hello", episodes: [] },
});
canvas.loadDSX(deckXml);
canvas.on("select", ({ id, path }) => renderInspector(id, path));
```

## Quick start

**Preview a deck with zero setup.** Open `CanvasEditor.html` in a browser. It is a
self-contained page with the SDK and a sample deck inlined; there is no server, no
bundler, and no `node_modules`. Replace the contents of the `dsx-src` script block
with your own markup to preview it.

**Embed the SDK.** Load `src/canvas-editor.js` with a script tag (it registers
`window.StackCanvas`) or require it from Node. Type definitions ship in
`index.d.ts`.

**Run the tests.** `npm test` runs the JSE conformance suite against the vendored
corpus in `conformance/jse/`.

## The web component

The editor also ships as a real custom element - `src/stack-editor-element.js`
registers `<despia-stack-editor>` (load it after the SDK):

```html
<script src="src/canvas-editor.js"></script>
<script src="src/stack-editor-element.js"></script>

<despia-stack-editor src="deck.dsx"></despia-stack-editor>
<!-- or an inline deck: -->
<despia-stack-editor>
  <script type="text/dsx"><stack>…</stack></script>
</despia-stack-editor>
```

Every SDK event re-dispatches as a composed `CustomEvent` of the same name
(`select`, `drop`, `change`, `preview`, …) with the payload in `detail`; the
full imperative API rides the `canvas` property (`el.canvas.undo()`), and
`tree` survives DOM moves. Attributes: `controls`, `frame`, `data` (JSON),
`src`, `preview` (live), `zoom="fit"`. `StackEditorElement.html` is the
zero-setup demo. Light DOM by design: the SDK owns a document-level
stylesheet, a body-appended drag ghost, and window listeners during drags -
a shadow root would sever all three, and the editor is a design *surface*,
not a leaf widget.

## The DSX component

This package is ALSO a DSX package (`dsx.json`, scheme `editor`): the
editor ships as a real DSX component, `<StackEditor/>`, built from two pieces:

- `web/index.js` - the module's web facet. It provides `<EditorCanvas>` (a
  module-provided web-facet component that mounts this SDK) and two headless
  bus actions: `dsx.module.editor.parse({ dsx })` → `{ tree, logic }` and
  `dsx.module.editor.evaluate({ expr, scope })` with device-exact JSE
  semantics.
- `Components/StackEditor.dsx` - the portable component wrapping the facet:
  attributes `deck` (XML text or a tree object), `src`, `data`, `controls`,
  `frame`, `preview` (live), `zoom`; events `ready`, `select`, `deselect`,
  `hover`, `change` (detail carries the edited `tree`), `history`, `drop`,
  `preview`, `edit`, `view` - each forwarding an explicit, documented payload.

Inside a DSX web app it is an ordinary component
(`<StackEditor deck="{{ dsx.variable.deck }}" on:change="…"/>`). Through the
framework's embed pipeline (`web.expose`, /web/13) the same component compiles
to a self-contained custom element, `<despia-editor>`, that any plain page can
load with one script tag - attributes drive it reactively (rich data as JSON
text or JS properties) and every event arrives as a composed `CustomEvent`.
The monorepo's demo build emits it at `/embed/editor/StackEditor.js` and a
Playwright gate (G10-editor) drives it on a plain host page per PR. When the
editor mounts inside a shadow root, the SDK injects its stylesheet into that
root as well as the document (the ghost still needs the document copy).

## Deploying the web component

`dist/despia-editor.js` is the deployable: ONE self-contained ES module
(~80 KB gz - web kernel + the compiled component + this SDK + scoped CSS +
`customElements.define`). The consuming page installs **nothing** - no npm, no
framework, no build step:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@despia/canvas-editor/dist/despia-editor.js"></script>
<!-- before the npm publish, the GitHub mirror works the same way:
     https://cdn.jsdelivr.net/gh/despia-native/canvas-editor@main/dist/despia-editor.js -->

<despia-editor deck='{"tag":"vstack","children":[…]}' style="display:block;height:600px"></despia-editor>
<script>
  const ed = document.querySelector("despia-editor");
  ed.addEventListener("change", (e) => save(e.detail.tree)); // the edited tree rides detail
  ed.addEventListener("select", (e) => inspect(e.detail));
</script>
```

Rich data flows as JSON attribute text or JS property writes (`ed.deck = tree`);
`preview="true"` flips the live simulator. The file is regenerated at release
time by the monorepo (`cd OpenSource/Web && npm run build:editor-dist`),
committed here, and parse-gated by the build check so a broken artifact can
never ship. The DSX web framework itself (`@despia/*`) is only needed when you
want `<StackEditor/>` as a component *inside* a DSX web app - embedding
needs none of it.

**Zero-setup demo:** open `DespiaEditor.html` in a browser - the same
double-click experience as `CanvasEditor.html`, but running the web component
(the dist bundle is inlined, the sample deck arrives through the `deck`
property, and the footer streams the CustomEvents as you edit).

## What it does

- **Runtime-faithful rendering.** Containers (`vstack`, `hstack`, `zstack`, `list`,
  `grid`, `scaffold`, `scroll`), leaves (`text`, `button`, `image`, `toggle`,
  `textfield`, `slider`, `progress`, and more), native default gaps, semantic
  colors, and full-bleed versus centered layout, matched to what the iOS and
  Android runtimes draw.
- **A complete editing surface.** Pointer-down selection at true z-order,
  multi-select, drag reordering with geometric hit testing, FLIP animation,
  inline text editing, copy, cut, paste, duplicate, group and ungroup, undo-safe
  tree restore, and screen-space selection chrome that stays crisp at any zoom.
- **A live simulator.** Preview mode forks sample data into running state and
  executes the deck: bindings evaluate, `on:tap` handlers run, toggles write
  their bindings, lists render live rows, and module calls play declared
  fixtures. Exiting restores the design canvas untouched.
- **Headless operation.** The SDK never decides for the host. It emits events
  (`select`, `edit`, `change`, `drop`, and others); the host owns panels,
  persistence, and navigation. Expression evaluation works without a DOM, which
  is how the conformance suite runs in Node.

## Runtime parity, verified

A canvas is only useful if a formula evaluates in the editor exactly as it will on
device. That property is tested, not promised. The SDK's expression interpreter
(JSE) runs the same conformance corpus as the native engines:

- The corpus lives with the engines; `conformance/jse/` here is a vendored copy.
- The Swift implementation is the reference; the corpus is regenerated from it.
- The Kotlin kernel runs the corpus in CI on every change, and so does this SDK.

The corpus pins the JSE number model: division and modulo by zero yield `0`, one
coercion table serves both `==` and `===`, plain objects and arrays compare
structurally, and `typeof` reports `"undefined"` for both `null` and `undefined`.

`StackCanvas.jse` exposes the interpreter directly. Hosts use it for formula
validation and autocomplete previews with device semantics:

```js
StackCanvas.jse.evaluate("prices.reduce((s, p) => s + p * qty, 0)", { prices: [1, 2], qty: 2 });
// 6
```

## The expression language

Expressions resolve the `dsx.*` namespaces exactly like the native engine. Bare
identifiers and legacy `$` names resolve to nothing.

| In markup | Meaning |
|---|---|
| `dsx.variable.x` | the surface's own view state |
| `dsx.global.x` | the app-wide store |
| `dsx.item.x` | the current row inside a repeater |
| `dsx.this` | the element's own value |
| `dsx.attribute.x` | instance props inside component templates |
| `dsx.module.<scheme>.<action>(args)` | a call into a module; resolves a promise |
| `dsx.module.<scheme>.context.<var>` | a read of a module's published data |

Module context reads resolve from the preview's `moduleContext` store. Seed it like
any other state:

```js
state.moduleContext.firebase = { pushId: "fcm-abc-123" };
```

An unseeded module reads as `undefined`, which mirrors the exclusion-safe behavior
on device when that module is compiled out. Calls are never diverted by the read
path.

## Simulating module behavior

A Despia module declares its command surface and unit tests together in its
manifest's `actions` block. Each action carries `args`, `resolves` or a `stream`
with timed `events`, `broadcasts`, and `tests`. The SDK consumes the same
declaration two ways:

```js
canvas.loadTests(manifest);          // actions and their tests become fixtures
const summary = canvas.runTests();   // { passed, failed, total, results }
```

- **Mock mode.** While previewing, a call that matches a fixture plays its
  scenario: broadcasts fire, the event stream ticks on a clock, and the call
  resolves with the declared value. A progress bar actually animates. Calls with
  no fixture fall back to an inert event.
- **Test runner.** `runTests()` validates every case against the action's own
  contract and emits a `testresult` event per case.

`sample-player.json` is a ready fixture with a spend action, an error case, and a
timed stream scenario.

## API surface

The host contract is typed in `index.d.ts`. The main groups:

- Content: `loadDSX`, `load`, `setTree`, `getTree`, `getNode`, `setData`,
  `registerComponent`, `setLogic`
- Structure: `add`, `insertNode`, `move`, `updateNode`, `wrap`, `unwrap`, `setTag`
- Selection and editing: `select`, `hover`, `startEdit`, `getBindables`, `describe`
- View: `fit`, `view100`, `setPreview`, `getState`, `destroy`
- Fixtures: `loadTests`, `runTests`
- Statics: `StackCanvas.parseDSX`, `StackCanvas.jse`, `StackCanvas.icon`

`getBindables` returns device-resolvable `dsx.*` paths with live samples, grouped
by scope, which is what a linking popover renders.

## Repository layout and provenance

This repository is a generated, read-only mirror of the `OpenSource/CanvasEditor`
folder of the Despia monorepo; see `MIRROR.md`. Changes land in the monorepo,
where the engine conformance gates run, and every sync replaces this tree.

| Path | Role |
|---|---|
| `src/canvas-editor.js` | the SDK, a single dependency-free UMD |
| `index.d.ts` | type definitions for the host contract |
| `CanvasEditor.html` | generated self-contained preview page |
| `page/`, `samples/` | the page template and the sample deck it inlines |
| `test/run-jse-conformance.mjs` | the conformance runner (`npm test`) |
| `conformance/jse/` | vendored copy of the shared JSE corpus |
| `patch-canvas.js` | one-time migrator for legacy `$`-namespace decks |

The preview page is assembled by the monorepo build (`build_canvas_editor.rb`),
whose check gate verifies byte-identical assembly, a clean `node --check`, a green
conformance run, and a successful headless-browser boot before anything ships.

## Migrating legacy decks

Older decks used `$`-prefixed namespaces (`$variable`, `$item`). The runtime is
`dsx.*` only. `patch-canvas.js` migrates old canvas HTML builds with anchored
find-and-replace and reports anything it cannot match:

```
node patch-canvas.js <old-canvas.html> [out.html]
```

Decks need the same one-time rename: `$variable` to `dsx.variable`, `$package` to
`dsx.module`, and so on.

## License and scope

This SDK is open source under the **Apache License 2.0**; see [LICENSE](./LICENSE).

How it fits into the Despia ecosystem:

- **Despia 4 and later** is published as an open source framework under the
  Apache License 2.0. Versions of Despia prior to version 4 are proprietary and
  are not covered by any open source license.
- The open source edition of the framework contains the runtime, the kernel, and
  the standard tooling. It does not include the premium module catalog that ships
  with the commercial edition.
- Because the framework is open source, this editor SDK is too. You may use it,
  at your own discretion and under the Apache-2.0 terms, in your own products,
  including editors and tools for applications built on the open source Despia
  runtime, whether those products are commercial or not.
- **Plugins and modules are not included.** You are free to build and distribute
  your own module libraries for the open source runtime under terms of your
  choice. Where your distribution includes Apache-2.0-licensed Despia code, the
  license requires that the copyright and license notices remain intact.
  For independent works built on top of the runtime, a visible credit to Despia
  is appreciated.
- The license grants no rights to the Despia name or logo. Do not present
  derived products as official Despia software without written permission.
