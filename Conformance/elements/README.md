# elements/ — the ELEMENT PARITY corpus (the per-element constants, testable)

One fixture per **canonical element tag** (`<tag>.json`), extracted **from the Swift source**
(the reference renderer): the per-element defaults, hardcoded geometry, and semantic color
tokens that make cross-renderer agreement a diffable contract instead of an aspiration.
Every constant cites its Swift line in a `_src` field — if a fixture and the Swift source
disagree, the source is right and the fixture is a bug (fix it in the same commit).

**Scope, so nobody reads more into this than it says.** These are the numbers a builder
hardcodes, not a rendered result. A fixture agreeing with an implementation proves the two
SAY the same thing; it does not prove they DRAW the same thing. Rendered fidelity is the
`parity/` corpus's job, and native is held there to a budgeted near-pixel contract with a
published gap ledger, never to pixel identity (`../parity/README.md`). The static
cross-renderer twin of this file is
`ClosedSource/scripts/check_renderer_constants.rb`, which diffs a curated set of these
constants across all three sources with no toolchain at all.

## Schema (`despia-element-parity-v1`)

```json
{
  "tag": "progress",
  "aliases": ["capsuleProgress"],
  "source": "ClosedSource/DSX/Modules/.../Progress.swift",
  "attributes": { "height": { "type": "number", "default": 6, "_src": "...Progress.swift:23" } },
  "geometry":   { "height": { "value": 6, "_src": "...Progress.swift:23" } },
  "colors":     { "tint": { "token": "accent", "_src": "...Progress.swift:15" } },
  "notes": "free-form parity notes (divergences, native-control provenance)"
}
```

- `attributes` — the element's attribute contract: `default` is the value used when the
  author omits the attribute (`null` = no default / required / pass-through).
- `geometry` — the numbers the Swift builder hardcodes (paddings, spacings, corner radii,
  font sizes, icon sizes, thresholds, opacities). Where iOS renders a **native control**
  (toggle → UISwitch, spinner → UIActivityIndicator), the fixture pins the control's
  documented metric and says so in `_src` — that metric IS the cross-platform contract.
- `colors` — **semantic token names** (the `StackStyle.color` vocabulary: `accent`,
  `white`, `separator`, `label`, hexes), never resolved ARGB.

## The runner (Kotlin side)

`OpenSource/Engine/Android/render/src/test/.../ElementParityTest.kt` loads every fixture and
diffs it against the `ElementSpec` each Compose element registers in
`ElementSpecs` (`render/src/main/.../ElementSpec.kt` — the registry pattern + authoring
instructions live in that file's header). Enforcement:

- fixture + spec both declare a key → values must match (**FAIL on drift**),
- spec declares a key the fixture doesn't know → **FAIL** (extract it into the fixture —
  the fixture is the truth, specs never free-lance constants),
- fixture key the spec doesn't declare yet → **reported** as a coverage gap (the wave list),
- element with a fixture but no spec → **FAIL**, unless the tag is allowlisted in
  `elements-gaps.json` (`missing` / `module` / `dclass`) → reported instead,
- element **registered in ComposeStackComponents** but unspecced → loud
  IMPLEMENTED-UNSPECCED report while its tag still sits in `missing` (the landing wave's
  grace window); **FAIL** the moment it leaves the allowlist,
- spec with no fixture → **FAIL** (new elements land fixture-first, like every corpus here),
- a named, header-pinned divergence → `elements-gaps.json` `partial` (reported, not failed).

`elements-gaps.json` is the drift budget: it shrinks as implementation waves land, and an
**empty allowlist = full enforcement**. The Swift side needs no runner — the fixtures are
generated *from* Swift; the planned Codemagic record-mode run (Conformance README) will
regenerate them mechanically.

## What is deliberately NOT here

- **The 12 Foundation XML components** (`Foundation/Components/Core/*.dsx`: AuthLogin,
  AuthSignup, Avatar, Banner, Callout, Card, Chip, EmptyState, FAB, NavBar, SettingsRow,
  VipCard) get **no fixtures**: they are platform-neutral DSX templates registered through
  the same codegen on both platforms (`StackComponents.generated.swift` /
  `StackComponents.generated.kt`, both emitted by `prepare_modules*` from the same `.dsx`
  bytes) — identical **by construction**, so there is nothing to diff. (Note: they enter the
  Android registry when the owning module's Components ride `prepare_modules_android.rb`;
  Foundation's entry there is pending, tracked in android-status.md §Component parity.)
- **Kernel structural/declaration tags** (`head`, `event`, `expects`, `action`,
  `variable`/`var`/`let`, `component`, `formula`, `script`/`functions`, `watch`,
  `attribute`, `style`, `slot`, `node`/`dynamic`, `tool`): they register logic and render nothing —
  their behavior is covered by the `jse/` corpus and the kernel unit suites, not by
  rendered-shape fixtures.
- **Universal style attributes** (padding/width/radius/… on any element): owned by
  `stack-style-properties.json` + `check_style_catalog.rb` and the StackStyle twins' own
  test suites — fixtures here only pin what an element's *builder* hardcodes.
