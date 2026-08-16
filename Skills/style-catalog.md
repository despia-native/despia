# Style catalog — the machine-readable style-panel schema

> Audience: anyone touching DSX **style attributes** or building a visual editor on top of DSX.
> How the style catalog (`stack-style-properties.json`) works, what consumes it, and — the point of
> this doc — **how to keep it from drifting** when the engine's style parser changes.

DSX styling is a **flat, universal attribute set**: the same ~60 attributes (`padding`, `radius`,
`background`, `fontSize`, `grow`, `opacity`, …) apply to *any* element; an element just ignores the
ones that don't affect it (see [`StackReference.md`](../Documentation/reference/StackReference.md)
§ Style attributes). There is no per-component style list — so "an element's style properties" **is**
the universal set.

The catalog turns that set into a **typed, constrained schema** a UI can render as controls
(number / enum-with-options / color / toggle) — a Webflow/Craft.js-style style panel, StudioCanvas,
or any inspector — instead of free-text boxes.

- **Catalog:** [`OpenSource/Documentation/reference/stack-style-properties.json`](../Documentation/reference/stack-style-properties.json)
- **Ground truth (the parser it mirrors):** [`OpenSource/Engine/iOS/Stack.swift`](../Engine/iOS/Stack.swift) —
  `StackStyle.apply` (universal attrs), `StackStyle.styleText` (text-only attrs), `StackStyle.color` (color tokens).
- **Drift guard:** `ruby ClosedSource/scripts/check_style_catalog.rb --strict` (also in CI).

---

## What's in the catalog

| Section | What it holds |
|---|---|
| `groups[]` | Properties bucketed into panel sections (Layout, Size, Spacing, Typography, Background & Fill, Border & Corners, Effects & Shadow, Position, Safe Area, Animation, Accessibility). |
| `groups[].properties[]` | One style attribute: `key`, `label`, `control`, `systemPath`, `default`, `unit`/`min`/`max`/`step`, `options` (for enums), `aliases`, `appliesTo` (`any`/`stack`/`text`), `help`. |
| `controlTypes` | The control vocabulary a panel switches on: `number`, `length` (number **or** a keyword like `fit`), `enum`, `multiEnum`, `color`, `gradient`, `ratio`, `boolean`, `text`. |
| `colorTokens` | Named color swatches (`accent` = `#FF2D55`, adaptive `label`/`fill`/`separator`, …) + aliases. |
| `colorFormats` | Accepted color spellings: named, `#RRGGBB`, `#AARRGGBB` (leading alpha), `rgb()`, `rgba()`. |
| `namedStyles` | The `style="card"` presets and exactly what each expands to. |
| `applicationOrder` | The order the engine applies modifiers (why `offset` is last, etc.). |

**Every value also accepts `{{ expr }}`** (JSE interpolation / data binding). A faithful panel exposes a
per-field "bind" toggle — this is noted in the catalog's `conventions`.

### How a panel consumes it (shape)

```js
for (const group of catalog.groups) {
  for (const p of group.properties) {
    switch (p.control) {
      case 'number': case 'length': numberInput(p);      break;  // unit / min / max / step
      case 'enum':   dropdown(p.options ?? p.optionsByElement[elementTag]); break;
      case 'color':  colorPicker(catalog.colorTokens, catalog.colorFormats); break;
      case 'boolean': toggle(p);                          break;
      // gradient / ratio / multiEnum / text …
    }
  }
}
```

`optionsByElement` exists because a few enums are context-sensitive — e.g. `align`'s legal values
differ for `vstack` vs `hstack` vs `zstack`.

---

## Keeping it in sync (READ THIS before editing the style parser)

The catalog is **hand-maintained** — it carries labels, groupings, help text, and control choices that
can't be inferred from Swift. So it doesn't auto-generate; instead a check **fails the build if the
engine and the catalog disagree**.

### When you add / rename / remove a style attribute in `Stack.swift`

A style attribute enters the engine as one of:
- `val("X")` in `StackStyle.apply` — a universal style attr,
- `a["X"]` in `StackStyle.styleText` — a text-only attr,
- `case "T":` in `StackStyle.color` — a named color token.

For each change, update the catalog to match:

1. **Added `val("newProp")`** → add a property `{ "key": "newProp", "label": …, "control": …, "default": … }`
   to the most fitting `groups[]` bucket. If it's an enum, list every allowed value the parser accepts
   as `options[]` (value + human label). If it's a color, use `"control": "color"`.
2. **Renamed** → rename the property `key` (keep the old spelling in `aliases[]` only if the engine still
   accepts it).
3. **Removed** → delete the property (or move it to `aliases` if it became an alias).
4. **New color token** (`case "gold":`) → add `{ "value": "gold", "label": "Gold", "hex": "#…" }` to
   `colorTokens[]`; put alternate spellings in that token's `aliases[]`.

Then run the guard and expect green:

```bash
ruby ClosedSource/scripts/check_style_catalog.rb --strict
```

### What the guard checks

- **Forward (errors):** every engine style key (`val`/`styleText`/`attrs`) and color token has a catalog
  entry (or alias). A miss = a style prop shipped without a panel control — the exact drift we prevent.
- **Structure (errors):** the JSON parses; every property has `key` + `control`; every `enum` carries
  `options`/`optionsByElement` with `value`s.
- **systemPath + gate cross-check (errors):** every property carries a valid `systemPath`, and the five
  renderer ejection gate word-sets stay consistent with it (see § `systemPath` above).
- **Reverse (warnings):** a catalog key the engine never reads (typo, or a dropped attr), excluding the
  handful legitimately parsed elsewhere (`spacing`, `align`, `color`, `transition`, `enter`, `anim`,
  `animDuration`, `keep`) — listed in the script's `CATALOG_ONLY`, and `style` (the named-style selector)
  in `ENGINE_EXEMPT`.

If you refactor `StackStyle` so an anchor string moves, the guard fails **loudly** ("engine anchor not
found") rather than silently checking nothing — that's your cue to re-point the three `slice(...)` anchors
in `check_style_catalog.rb`.

### `systemPath` — the ejection classification (system-defaults.md)

Every property carries **`systemPath: "compatible" | "ejects"`** — the single source of truth
for system-component ejection (`system-defaults.md` § "Ejection is explicit, never silent"):

- **`compatible`** — applies ONTO the platform's system component: geometry that composes
  (width/height/min-max/grow/alignY, the padding family — threaded inside the tap target by
  Android `LAYOUT` / iOS `controlBox`), lifecycle/motion (`transition`/`enter`/`anim`/
  `animDuration`/`keep`), accessibility (`a11y*`/`aria-*`/`role`), and `variant` (the
  system-space selector).
- **`ejects`** — paints or reshapes: authoring it moves a system-path element off the platform
  rendering onto the custom path (`background`, `radius`, `border*`, `shadow*`, `font*`/text
  attrs, `gradient*`, `surface`/`glass*`, `opacity`, `theme`, `blur`/`rotation`/`scale`/
  `zIndex`/`offset*`, `spacing`, `align`/`alignItems`, `aspectRatio`, `ignoreSafeArea`).
  `color` is `ejects` **universally** — the reconciled Android button gate admits it as the
  compatible tint ONLY under a `variant`/`role` word; that exception lives in the gate and is
  modeled by the checker, never in this field.

Aliases inherit their property's verdict. **New property ⇒ classify it** — the guard errors on a
missing or unknown `systemPath`, and its GATE CROSS-CHECK parses the five renderer ejection
gates out of source and fails on any disagreement with the field:

| Gate | Direction | Law |
|---|---|---|
| iOS `List.swift` `systemSafeAttrs` | allowlist | ⊆ structural ∪ `compatible` (may be narrower — ejecting a compatible attr is the safe direction; an `ejects` word here is the failure) |
| watch `StackWatch.swift` spine `look` + button `authoredBox` | eject list | every word maps (short spellings via the checker's `WRIST_ALIASES`: `bg`→`background`, `paddingh`/`paddingv`) to an `ejects` property — except the documented `WRIST_CONSERVATIVE` padding family; the box pair strictly `ejects` |
| wear `StackWear.kt` list gate + chip `authoredBox` | eject list | same law, and IDENTICAL to the watch sets (one wrist law, two runtimes) |
| Android `StackButtons.kt` `SAFE_BASE` / `LAYOUT` / word extras | allowlist | `SAFE_BASE` ⊆ structural ∪ `compatible`; `LAYOUT` ⊆ `compatible`; extras exactly `{color, iconSize}` with `color` classified `ejects` |

`lint_dsx.rb` consumes the same field for its ejection **notice** (`<list>` / word-carrying
`<button>` with an `ejects` attr; `appearance="custom"` silences). So: adding a paint-ish
property without classifying it fails the build; classifying it `ejects` makes the notice and
every gate check inherit it for free — no gate edits needed unless a gate should *admit* it.

### Attributes parsed OUTSIDE the three functions

A few real style attributes are handled by the element renderers or the animation helpers, not by
`apply`/`styleText`/`color` — `spacing` and `align` (stack layout), and `transition` / `enter` / `anim` /
`animDuration` / `keep` (`StackStyle.transition` / `StackStyle.animation`, keyed by name). These are in the
catalog but can't be forward-verified; the script's `CATALOG_ONLY` set records them so a genuine typo still
surfaces. If you add a new one, add its key there too.

---

## Not a hosted schema

The catalog is plain data consumed by app code; it needs **nothing hosted**. (An earlier draft carried a
`$schema` URL pointing at a non-existent file — removed. If you ever want editor validation of the catalog
*file itself*, author a JSON Schema and reference it by a relative path; that's optional and separate from
using the data.)
