# The editor design language

Rules for every Despia editor surface (this SDK, the canvas editor chrome, the
coming action editor). The goal is stated once: **it must look handmade by a
minimalist with decades of practice — never generated.** These are the details
that get us there; violating one needs a reason.

## 1 · Depth is BORDER-first, not shadow
- **Every surface is FLAT.** One fill per material — card, band, well, panel —
  no vertical gradients anywhere; a gradient on a surface is the generated
  look. Depth comes from a crisp visible border (dark `#34343A`) plus a hair
  of shadow, never from the fill and never from a big soft blur. Professional
  desktop software separates surfaces with EDGES, not clouds — the shadow is
  a single ≤2px contact line at ~0.28 alpha, the ambient one barely there.
- **Recessed = readout.** Live values, results, code strips sit in wells:
  `inset 0 1px 2px rgba(0,0,0,.45)` on a surface darker than the card. You
  read what's sunk; you press what's raised. The Output's result well is the
  DEEPEST surface on the canvas — the terminal.
- Pressing a raised control flips it: highlight off, shallow inner shadow,
  `translateY(0.5px)`. That half-pixel is the whole tactile story. The bevel
  (`inset 0 1px 0`) stays subtle — a hint of a top edge, not a gloss.

## 2 · Color is a family, worn as a crown — and it is MUTED
- A node's color family answers "what kind of step is this?" at a squint:
  **amber** `#d9a250` = data enters (sources) · **violet** `#7A6FC9` =
  decides (If/Switch, comparison and boolean operators) · **green**
  `#4F9370` = math (arithmetic operators, number functions) · **indigo**
  `#5B63C4` = the destination (Output alone) · **neutral** = text/list/data
  work, literals, code.
- All family hues are DESATURATED on purpose — they mark type, they don't
  decorate. The ONE saturated color in the whole editor is the interaction
  accent (purple `#6758F5`): selection border, port hover, the live drag.
  If a family crown reads as bright as the selection accent, it's wrong.
- Family color is worn in exactly TWO places: the **2px crown** (the card's
  top border) and the **glyph tint**. Never a filled header, never a colored
  chip, never a tinted body — sources alone also keep their warm band, the
  one washed surface on the canvas. Color as a crown is identity; color as
  a fill is how tools start looking generated.
- Wires are near-invisible neutral at rest (rule 8); a colored line at rest
  is decoration. No further hue unless a state genuinely demands it (a future
  error state may).

## 3 · The signature silhouette — families, not one card repeated
- Uniformity is the enemy: if every node has the same visual energy, the
  graph says nothing at a squint. Nodes belong to **families**, and family
  identity rides the CROWN (rule 2), SIZE, HEADER MATERIAL, and TITLE VOICE
  — same anatomy, different silhouettes:
  - **Sources** (inputs, variable reads): compact pills — amber crown, warm
    band, amber glyph chip, mono title (it IS an identifier), no rows.
  - **Logic** (If/Switch, boolean + comparison operators): purple crown +
    glyph — the decision points.
  - **Math** (arithmetic, number functions): green crown + glyph.
  - **Work** (text/list functions, methods): the neutral reference card —
    flat band, serif-italic ƒ, no crown, most of any canvas.
  - **Literals** (Value / Object / Array): bandless header, the lightest
    silhouette. **Custom code**: a recessed well-dark band + mono title —
    raw text embedded in the graph, dressed as exactly that.
  - **The Output**: a terminal, not another card — indigo crown, a heavier
    1.5px frame, more air under its band, the deepest result well.
- The title row is a **header band** bleeding to the card edges with a
  hairline beneath; a collapsed card is just the band, a clean pill.
- Ports are **circles** straddling the card edge like sockets — hollow when
  open, filled when plugged.
- **Selection is a whisper**, never a spotlight: a 1px accent border, a hair
  brighter fill, a touch more elevation — no ring, no glow, no colored
  shadow. You must still read the graph BEFORE the selected node. A bright
  selection ring is the single loudest "AI-generated UI" tell; we don't ship
  one.
- These moves ARE the visual identity; keep them on every editor surface
  (canvas, logic, the coming action editor) — and never borrow a
  competitor's composition, demo content, or naming into shipped files.

## 4 · Rows are sockets in a native grouped list
- A node's argument rows form ONE group — shared background one step darker
  than the card, hairline separators (`rgba(255,255,255,.05)`), radius on the
  group, not per row. iOS inset-grouped is the reference; floating pill rows
  with gaps are the anti-pattern.
- A row is a SOCKET, not a form field: the pin straddles the card edge, the
  label names the slot in a quiet voice (11/500), and the value answers in
  mono, right-aligned. Wired values are muted (they preview the upstream
  card); unwired values are strong (they're editable HERE). Row min-height
  29, text baseline-aligned.

## 5 · A real typographic scale — only DATA draws the eye
- 15/650 titles (mono 13–13.5/600 on identifier cards: sources, custom
  code) · 13.5/550 mono values (wired previews drop to 450 + muted —
  editable beats echoed) · 12/500 labels in `#8b8b95` · 10/500 ghost chips ·
  9/700 uppercase tags (+1.2px tracking) · 8/700 micro-tags (JSE · fx).
  Numbers use tabular figures. Mono carries VALUES and identifiers; Inter
  carries chrome — the split IS the hierarchy, three tiers that must never
  sit closer than a full step. The VALUE is the biggest thing in its row:
  only actual data earns emphasis; labels and chrome stay quiet.

## 6 · Tight geometry with RHYTHM, kept honestly
- Radii step down with nesting, never up: **8 cards · 6 wells, groups, and
  furniture keys · 5 inner rows and chips**; ports are circles. Floating
  panels (palette, inspector) may sit one step above cards at 10.
  Soft-friendly 14px+ corners are the generated look; crisp 8s are the tool
  look.
- Paddings on the 4px grid minus the hairline they contain: card 7 (+1
  border = 8), head 5×8/9, row inset 12. Section gaps are NOT uniform —
  spacing is rhythm, not a constant: the band sits 8 over the rows, wells
  breathe at 9, the Output's band takes 10. Equal spacing everywhere reads
  generated; deliberate asymmetry reads designed. If a value isn't
  derivable from the grid ± its hairline, it's a bug.

## 7 · A canvas is a tool, not a void
- The ground is a **drafting table**: a cross grid (24px minor at ~3% alpha,
  one major every fourth at ~8%) that fades toward the edges under a static
  vignette — engineering paper, not a dashboard dot field. The grid exists
  only to help alignment; it must never compete with a node. If you notice
  the grid before the graph, it's too loud.
- Furniture grounds it: the zoom cluster bottom-right as SEPARATE square
  keys (− · % · + · fit, each its own raised 28px surface — desktop-tool
  keys, not a joined pill), the formula identity chip bottom-left. Quiet
  raised surfaces that never overlap content. A bare canvas with floating
  cards reads as a demo.
- Rows follow the native settings pattern: label LEFT (secondary), value
  RIGHT-ALIGNED (primary), controls after — one vertical sweep to scan.
- Chrome earns its pixels: type chips are ghosts until the row is hovered,
  chevrons appear on card hover, ports are small and low-contrast until
  approached. What is always visible is only what is always needed.

## 8 · Micro-states are the craft — subtle, never flashy
- Everything interactive has hover (+2–3% lightness, 150ms ease-out), active
  (press flip), and focus states. Transitions are 150–200ms ease-out — never
  bounce, never overshoot, never a flashy transition. Cursor is correct per
  element: `grab` on headers, `text` on values, `crosshair` on ports,
  `pointer` on controls.
- Ports are quiet 10px circles with a DARK fill and a thin border until
  approached: then the circle grows to 13px and a soft accent halo blooms
  (canvas-color ring + a small glow) with the `+`. Plugged ports fill solid.
  Copy buttons exist only on hover.
- Wires almost DISAPPEAR: 1.75px, round caps, low-contrast neutral
  (`#363640`) — ALL of them, at rest, so the graph's structure reads instead
  of colorful spaghetti. Only the selected node's own wires take the accent
  (a muted `#6a5fc8`, 2px), so you can trace what a step connects to. An
  in-progress drag brightens (still neutral); a freshly plugged wire draws
  itself in once (200ms). No wire ever glows or carries motion at rest.

## 9 · Icons: one family, one weight
- **Hugeicons free set only** (`@hugeicons/core-free-icons`), 24px viewBox,
  stroke 1.5, round caps/joins, rendered via `currentColor` — the same family
  and convention the canvas editor ships (`StackCanvas.icons`). Paths are
  INLINED (zero dependencies); take them verbatim from the package, never
  redraw by hand — a hand-approximated glyph next to a real one is exactly the
  generated look.
- Chrome sizes 11–14px, always monochrome (the current text color). No second
  icon family, no emoji.
- **The set is a swappable layer.** The open SDK ships the Hugeicons FREE
  (stroke) set — redistributable, so the public MIT mirror stays clean. The
  Hugeicons Pro SOLID set is injected by the licensed/commercial build via
  `StackLogic.registerIcons(map, "solid")` (or `new StackLogic(el, { icons,
  iconMode: "solid" })`). Pro paths live in the CLOSED build only, never in
  this open source — same rule as the premium module catalog. When a solid set
  is registered, glyphs render `fill: currentColor`; otherwise `fill: none`.
- Node identity is a LETTERFORM wherever a letter says it best — a beginner
  reads a letter instantly, nobody reads an abstract icon: serif-italic **v**
  for variables/sources, **ƒ** for functions/operators, literal `{ }` `[ ]`
  `#` for shapes. Icons remain only where a letter can't carry it (branch,
  code, flag). The glyph sits in a fixed 18px slot at the card's left padding. The collapse chevron shares that slot —
  glyph at rest, chevron on hover — so there is no phantom gutter and nothing
  shifts. Never a stray glyph floating before the title; never a text badge
  standing in for an icon.

## 10 · Code readouts (the one sanctioned color carve-out)
- Code and typed values in wells are highlighted with a FIXED muted palette —
  content semantics, not chrome, so rule 2 stands: strings `#a9c4a0` (sage) ·
  numbers `#d4b48c` (sand) · keywords/booleans/null `#8fa8c8` (steel) · call
  names `#cdd2d9` · operators `#98a0ab` · punctuation `#656b75` · plain paths
  ride the well's base text. All desaturated: if a syntax tone reads brighter
  than the accent, it's wrong.
- Formatting is a VIEW of the canonical text, never a change to it: one line
  up to ~34 chars, then break at depth-0 ternary arms and logical joins with a
  2-space hang. Highlighting and formatting appear ONLY inside recessed wells
  and code chips — never in chrome rows.

## 11 · Depth of inspection (the third dimension)
- A card is a HEADLINE: its value well scales with content up to THREE lines,
  then clamps behind a line-count chip. Cards never grow to fit data — depth
  is a panel, not a bigger box.
- The full value lives in the right-docked INSPECTOR: pretty-printed,
  highlighted, copyable, recalculating live on every edit, with the step's
  compiled code one quiet toggle away. It follows selection, so walking the
  graph walks the data.
- The inspector is a FACT SHEET, not a value dump: under the value sit the
  step's live TYPE (`Array · 3 items`), its SOURCE (the callable or path
  that produces it, in mono), and one sentence of documentation — catalog
  signatures for built-ins, the author's own description for user formulas.
  A step is a thing with provenance, not a floating number.

## 12 · Two themes, one geometry
- Dark is the reference; light is the same room with the lights on. Every
  rule reads ONLY theme variables — zero literal colors outside the two
  variable blocks — so the themes are one design at two illuminations.
  `auto` follows the system live.
- Light re-picks MATERIALS, never layout — and it is layered, not white-on-
  white: canvas `#F4F5F8` · cards `#FFFFFF` · bands `#FAFAFB` · the
  inspector panel `#F7F7F8` — four distinct papers, so surfaces read as
  stacked sheets. Ink text, the same purple, amber and indigo deepened for
  contrast, syntax tones re-chosen for light wells.

## 13 · Restraint checklist (the "does it look generated?" test)
The north star: an experienced developer should think *"software that's been
evolving for ten years,"* never *"an AI generated a modern dashboard."* We
optimize for PROFESSIONAL, not beautiful — information density, readability,
fast graph scanning, low visual fatigue. When the two goals conflict, calm
and legible wins over pretty.
- A glowing/ringed/colored selection state? Fix it — selection is a whisper
  (rule 3). It's the loudest AI tell there is.
- A gradient on any surface fill, or glass/blur (`backdrop-filter`)? Fix it —
  flat materials only (rule 1). No glassmorphism, no neumorphism.
- Family color anywhere beyond the crown + glyph (a filled header, a tinted
  body, a colored chip row), or a family hue as bright as the interaction
  accent? Fix it. A hue outside the five muted families? Fix it.
- Wires you notice before the nodes? Fix it — wires almost disappear (rule 8).
- Every node wearing the same silhouette — same width, same band, same
  energy? Fix it: family identity is load-bearing (rule 3).
- Two adjacent font sizes closer than one scale step, or anything but DATA
  drawing the eye? Fix it (rule 5).
- A shadow doing the work a border should (a soft blur instead of a crisp
  edge)? Fix it — depth is border-first (rule 1). A corner radius past 12 on
  a card? Fix it.
- Perfectly uniform section spacing everywhere? Fix it — spacing is rhythm
  (rule 6).
- Decoration that encodes nothing? Delete it.
