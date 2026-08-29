# split/ — the `<split>` planning corpus (W9, component-library.md)

`split.json` is the shared, renderer-neutral planning corpus for `<split>` — the
two/three-pane adaptive container (the program's list-detail / NavigationSplitView
primitive). It pins everything the fixture format can express: pane-role resolution
(per-child `paneRole`, positional defaults, duplicate/invalid fallback), the collapse
decision per width class (`collapseAt` / `expandAt`), the pinned-column set + sidebar
overlay availability, per-pane width normalization (`sidebarMin/Ideal/Max`,
`contentMin/Ideal/Max`, `detailMin`), effective resizability, and the detail-selection
routing rule (`value` → is a detail active). Render-only behavior (divider drag, the
stack push animation, focus movement) lives in per-renderer tests.

## The model

- Roles are CANONICAL — `sidebar · content · detail`. An explicit, valid `paneRole`
  wins (first declaration of a role keeps it); anything else fills positionally from
  the remaining roles of `[sidebar, detail]` (2 panes) / `[sidebar, content, detail]`
  (3 panes) / `[content]` (1 pane), in canonical order. Children beyond three are
  ignored (renderers warn). The `panes` attribute is a declared HINT — the children
  are the truth; a mismatch never reshapes the split.
- WIDTH CLASSES: `width < collapseAt` (default 760) → `presentation: "stack"` — the
  HOST pane (content if present, else sidebar) is the screen and an active detail
  pushes over it. Otherwise `presentation: "columns"` — every pane pins as a column,
  EXCEPT a three-pane split's sidebar below `expandAt` (default 1104), which becomes
  an overlay (`overlay: true`). Native renderers delegate the visual collapse to the
  platform host (NavigationSplitView / the list-detail scaffold); this plan is their
  semantic twin and the web renderer's literal geometry.
- `columns` is the pinned-column set for the CURRENT presentation, in canonical order
  (`[]` under stack). `resizable` is EFFECTIVE resizability: the authored flag
  (default true) AND a columns presentation with at least two pinned panes.
- SELECTION (`selection` cases): `value` is the selected detail identity. `null`,
  `false`, and a blank/whitespace string are NO selection; any other value is active
  (stringified — numeric ids like `0` stay selectable).

## Runners (three, live)

- TS: `OpenSource/Web/packages/dom/test/split.test.ts` (`resolveSplit` /
  `splitSelectionActive` in `packages/dom/src/split.ts`) — also in the `conformance`
  keystone script.
- Kotlin: `OpenSource/Engine/Android/core .../SplitConformanceTest.kt`
  (`despia.engine.SplitPlan`) — gradle `:core`, per-PR CI.
- Swift: `SplitConformance` (ConformanceHosts.swift) over `SplitPlan.swift`, wired in
  `RecordMain.swift` — the Codemagic `conformance-record` lane.

Every cross-runtime divergence becomes a case here in the same commit as its fix.
