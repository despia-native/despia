# Editor catalog: the web-canvas element schema

> Audience: anyone touching DSX **elements** (a new tag, a new attribute, a renamed alias) or
> building the web preview editor ("the canvas" — the dashboard's visual builder + its web
> simulator) on top of DSX. How the editor catalog (`stack-elements.json`) works, what consumes
> it, and — the point of this doc — **how it is kept from drifting** from the native runtimes.

The style panel already has its machine-readable schema
([`stack-style-properties.json`](../Documentation/reference/stack-style-properties.json) — the
universal style attributes, guarded by `check_style_catalog.rb`; see
[`style-catalog.md`](./style-catalog.md)). The editor catalog is its **element-level sibling**:
ONE generated blob that tells the canvas **every tag** the native runtimes render — its typed
attributes with defaults and constraints, its events, aliases, platform support, children model,
and one canonical example — a real 1:1 contract, so the canvas can render/edit exactly what the
iOS (SwiftUI) and Android (Compose) runtimes render.

- **Catalog:** [`OpenSource/Documentation/reference/stack-elements.json`](../Documentation/reference/stack-elements.json) — **GENERATED, never hand-edited.**
- **Generator:** `ruby ClosedSource/scripts/generate_editor_catalog.rb` (deterministic + idempotent: sorted keys, no timestamps — run twice, no diff).
- **Drift guards:** `ruby ClosedSource/scripts/generate_editor_catalog.rb --check` (byte-compare, in the same
  `codemagic.yaml` gate block as `check_style_catalog.rb`) **+**
  `EditorCatalogTest.kt` (`OpenSource/Engine/Android/render/src/test` — runs with the engine suite and in the
  CI `android-kernel` lane's `gradle test`).

---

## What's in the catalog

| Section | What it holds |
|---|---|
| `elements` | The renderable-tag census: the **76 fixture-backed tags** (native + module-provided) **plus the 13 kernel structural/declaration tags** (`head`, `variable`, `formula`, `action`, `script`, `watch`, `attribute`, `expects`, `event`, `style`, `component`, `slot`, `node`). Per tag: `kind` (`native`/`module`/`structural`), `category` (layout/display/input/structure/overlay/media/forms/data/studio/scene/web/structural), `aliases`, `module` (owning scheme, module tags only), `platforms`, `webClass` (see below), `children` (`none`/`text`/`children`/`rowTemplate`), typed `attributes`, `events`, one canonical `example`, and the Swift `source` file. |
| `elements.<tag>.webClass` | The stable `.dsx-*` class the **Web** renderer stamps on that tag's ROOT — the selector contract application CSS and third-party themes target (`/web/17`). Read VERBATIM from the web element ledger ([`OpenSource/Web/support/element-support.json`](../Web/support/element-support.json)), whose own suite renders every tag through the DOM-free string renderer and fails when a declared class is not the emitted one, so this column inherits a machine-checked fact rather than a documented one. Two values are special and are **not** per-element styling hooks: `"dsx-unsupported"` is the ONE shared labelled placeholder the DOM runtime mounts for a tag with no Web renderer (the 13 unsupported rows), and `null` means the tag renders no DOM root at all — the 13 structural/declaration tags, which are logic, not markup. An **alias** has no `webClass` of its own: resolve it through `aliases` and read the canonical entry (the generator aborts if the ledger's alias row ever disagrees). A **component** has none either — it expands to a root element that carries the class. |
| `elements.<tag>.attributes` | `{ type, default, enum?, enumOpen?, of?, min?, max?, unit?, perChild?, doc?, source? }`. `default: null` = no default. Types: `string`/`number`/`bool`/`color`/`enum`/`csv`/`expr`/`action`/`state-key`/`url`/`sf-symbol`/`iso-date`/`regex`/`path-data`. `perChild: true` = the attribute is written on the element's *children* (`tabTitle` on a `<tabs>` pane). |
| `components` | The shared `.dsx` XML components (`Components/**/*.dsx`, the tags the registry codegen inlines): the head contract — `attributes` (from `<attribute as=… default=…>`; defaults are **JSE expressions**), `expects` (seed contract), `events` (+payload keys), `slots` — plus owning `module` scheme, `platforms` (presence in the iOS/Android generated registries), and an auto-derived invocation `example`. Module-scoped components key as `scheme.Name` (the qualified-tag form), global ones as `Name`. |
| `universalAttributes` | Attributes legal on ANY element (`id`, `visible-if`, `keep`, `transition`/`enter`/`exit`/`anim`, gestures `on:tap`/`on:drag`/…, `measure`/`container`, `class`/`style`, the `a11y*` contract). |
| `childMarkers` | Attributes legal on a child *because of its parent* (`slot=`, scaffold `pin=`/`pane=`, tabs `tabTitle`/`tabIcon`/`tabBadge`). |
| `aliases` | Flat alias → canonical index (`input`→`textfield`, `row`→`pressable`, `var`→`variable`, …). |
| `conventions` | Value conventions: logical units, `"true"`/`"false"` booleans, `{{ expr }}` binding everywhere, `arg:*` payload args, exact/group platform key suffixes, `on:<event>` wiring on component tags. |
| `styleProperties` | `{ "$ref": "stack-style-properties.json" }` — the universal style attributes are **referenced, never duplicated**. |

### Confidence tiers (`source`)

- **No `source` field** — the fact comes from the **Conformance parity fixtures**
  (`OpenSource/Conformance/elements/*.json`), extracted line-by-line from the Swift reference
  renderer and **enforced equal** to the Android `ElementSpec` registry by `ElementParityTest`.
  Pixel-contract confidence.
- **`"source": "reference-doc"`** — mined from
  [`StackReference.md`](../Documentation/reference/StackReference.md) (the Elements-section
  markdown tables + a small curated supplement for prose-only facts like the `<video>` events
  and the WebView navigation events). Documented contract, not fixture-pinned — consumers should
  treat these as one tier softer.

## How the canvas consumes it (shape)

```js
const cat = await load('stack-elements.json');
const styles = await load(cat.styleProperties.$ref);        // the style panel it already has

for (const [tag, el] of Object.entries(cat.elements)) {
  palette.add(tag, { category: el.category, badge: el.platforms });  // exact target badges
  inspector[tag] = controlsFor(el.attributes);   // typed property panel: enum → dropdown,
                                                 // bool → toggle, color → picker, number → input
                                                 // (+ per-field {{ }} bind escape hatch)
  wiring[tag] = el.events;                       // on:<event> handler slots
  templates[tag] = el.example;                   // the drag-in starting markup
  nesting[tag] = el.children;                    // none | text | children | rowTemplate
}
for (const [key, c] of Object.entries(cat.components)) {
  palette.add(key, { module: c.module, badge: c.platforms });
  inspector[key] = controlsFor(c.attributes);    // head-declared props (defaults are JSE)
  wiring[key] = Object.keys(c.events);           // on:<event> — the component's raised events
  seeds[key] = c.expects;                        // state the simulator must seed before mount
}
```

The web simulator renders `example` markup as its default preview per tag and uses `platforms`
to badge/exclude tags per target; `aliases` lets pasted markup resolve to the canonical entry.

---

## Keeping it in sync (READ THIS before adding/changing an element)

The catalog is **generated** — never edit `stack-elements.json` by hand. The generator's inputs,
in priority order:

1. **`OpenSource/Conformance/elements/*.json`** — the parity fixtures (attributes, defaults,
   aliases, owning Swift source). These are already the law: `ElementParityTest` fails CI when a
   fixture and an Android `ElementSpec` disagree, so the catalog inherits enforced constants.
2. **The `ElementSpec` registry** (`OpenSource/Engine/Android/render/.../ElementSpec*.kt`) —
   re-verified directly at test time: `EditorCatalogTest.catalogCoversEnforcedSpecs` asserts
   catalog ⊇ every registered spec with equal defaults.
3. **`StackReference.md`** — element-table rows and curated prose facts the fixtures don't carry
   (marked `"source": "reference-doc"`).
4. **The generated registries** — `StackComponents.generated.{swift,kt}` (which platform
   registers each XML component) and `ModulePlatformSupport.generated.kt` (scheme → platforms),
   plus the `.dsx` component heads themselves.
5. **`OpenSource/Web/support/element-support.json`** — the web element ledger, and the ONE source
   of `webClass`. The two censuses are locked BOTH ways: a fixture tag with no ledger row, a
   ledger row naming no fixture tag, a blank class, or an alias row disagreeing with its canonical
   all **abort the run**. Never hand-copy a class into the generator — add the row to the ledger.

### When you add / change an element

1. Land the **fixture first** (`OpenSource/Conformance/elements/<tag>.json`) — the corpus rule.
2. Add the tag's editorial facts to the generator's hand tables (`CATEGORIES`, `EXAMPLES`,
   `CHILDREN`/`CHILDREN_CONTAINERS` in `generate_editor_catalog.rb`) — a fixture tag without an
   entry **aborts the run** (the census law: nothing skipped, nothing silently guessed).
3. Land its **web ledger row** (`OpenSource/Web/support/element-support.json`) declaring the
   tag's `webClass` — a fixture tag with no row aborts the run for the same reason. If the tag has
   no Web renderer, the row declares `"dsx-unsupported"`; it is never omitted.
4. Regenerate and expect green:

```bash
ruby ClosedSource/scripts/generate_editor_catalog.rb            # regenerate (idempotent)
ruby ClosedSource/scripts/generate_editor_catalog.rb --check    # byte-compare — the CI gate
cd OpenSource/Engine/Android && gradle :render:testDebugUnitTest  # EditorCatalogTest (the simulation)
```

### What the guards check

- **`--check` (CI, next to `check_style_catalog`):** the committed blob is a byte-exact
  regeneration of the current fixtures + docs + registries. A new/renamed element attribute, a
  moved component, a platform flip — any of them without a regenerated blob fails the build.
- **`EditorCatalogTest.kt` (the simulation — runs with the engine suite):**
  1. every `ElementSpec`-registered tag appears with EXACTLY the spec's attribute defaults and
     aliases (catalog ⊇ enforced specs, values equal through the shared `canon` rule);
  2. every catalog `example` **parses via `StackXML`** and uses only attributes the catalog
     itself declares for that tag (or universal attributes / child markers / style-catalog keys /
     the `arg:*` and `:ios`/`:android` conventions) — examples can never rot;
  3. `platforms` agrees with the `elements-gaps.json` buckets (`dclass`/`missing` ⇒ iOS-only; a
     registered Android spec ⇒ both platforms);
  4. the census is exact both ways: every fixture tag is in the catalog, and no catalog tag is
     unknown to the census (fixtures + the 13 structural tags); `events` always equals the
     entry's own `on:*` attributes.
- **`editor_catalog_web_class_test.rb` (CI, next to `editor_catalog_adaptive_shell_test.rb`):** the
  `webClass` column still comes from the LEDGER (every row compared verbatim), the two censuses
  still match, every structural tag still carries its explicit `null`, every `unsupported` row
  still resolves to `dsx-unsupported`, every alias still agrees with its canonical, and the column
  is still documented in `conventions` + `generated_from`. `--check` alone cannot see any of
  these: a hand-copied table regenerates byte-identically.

If `StackReference.md` is restructured so the `## Elements … ## Style attributes` slice moves,
the generator fails **loudly** ("anchor not found") rather than silently mining nothing — that's
the cue to re-point it.

## Division of labor (don't duplicate)

| Fact | Owner |
|---|---|
| Universal style attributes (padding/radius/…) | `stack-style-properties.json` + `check_style_catalog.rb` |
| Per-element attributes, defaults, events, aliases, platforms, examples | `stack-elements.json` (this catalog) |
| Pixel constants (geometry/colors an element hardcodes) | the Conformance fixtures + `ElementParityTest` (the catalog carries only the attribute-facing surface) |
| XML component contracts (props/expects/events/slots) | the `.dsx` heads (`dsx-anatomy.md`) — the catalog extracts, never restates |
