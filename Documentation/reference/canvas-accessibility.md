# The node canvases, without a mouse and without the drawing

A node graph is the hardest thing in a product to make usable without a pointer or without
sight, and for one reason: almost everything it says, it says with geometry. Which card feeds
which is a line. Which socket is live is a filled disc. Which cards belong to a loop is a
region drawn around them. None of those has a text equivalent unless someone writes one.

The Studio has two node canvases. The workflow canvas (`EditorLogic.dsx`) draws what runs next,
downward. The expression canvas (`EditorExpression.dsx`) draws where a value comes from,
rightward, into one fixed **Result**. Reference for the drawing itself:
[expression-canvas.md](expression-canvas.md).

This document is the other half: what a keyboard can reach, what an accessibility tree
receives, and the model both surfaces are being built toward. It is measured, not asserted.
The gate that measures it is
`OpenSource/Web/packages/dom/oracle/canvas-access-browser.ts` (drives the real Studio in a real
browser) and `ClosedSource/scripts/check_canvas_contrast.rb` (resolves the palettes off the
sheet and simulates colour-vision deficiency). Every number below is one of their lines.

```bash
cd OpenSource/Web && DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-access-browser.ts
ruby ClosedSource/scripts/check_canvas_contrast.rb
```

---

## 1. What holds today

These are asserted by the gate and fail the build if they stop holding. They are not small:
most node editors do not get this far.

| Invariant | Measured |
|---|---|
| A node head is a real `<button>` with an accessible name | 5/5 on `fold`, 11/11 on `wide`, 11/11 on `matrix` |
| An operand row is a real `<button>` with an accessible name | 9/9, 24/24, 19/19 |
| No node card and no operand row is hidden from assistive tech | 0 hidden on all three |
| Sockets, family tiles and wire canvases ARE hidden as decoration | ports 16/16, tiles 5/5, wires 8/8 on `fold` |
| A keyboard-focused node paints a focus indicator | `outline: solid 2px rgb(109, 140, 255)`, the kernel's `.dsx-pressable:focus-visible` |
| Focus escapes the canvas by tabbing forward | no trap on any fixture |
| `Enter` on a node head selects it | one `.expr-node-on` |
| `Enter` on an operand row opens its value editor | the panel reaches opacity 1 |
| Every family tile ink clears 3:1 on its own 18% tint | floor 3.76:1 on a panel card, 4.42:1 on the stage |
| Every family ink clears 3:1 directly on both grounds | floor 4.78:1 |
| Every value ink clears 4.5:1 in the recessed well | floor 6.20:1 |
| No two socket states collapse under a colour-vision deficiency | worst pair dE00 17.47 |
| The selection ring clears 3:1 on both grounds | 5.69:1 on a card, 6.43:1 on the stage |
| The card ground stands off the stage | 6.19 L\* |

Nothing in the drawing is invisible to a screen reader, and nothing decorative is audible to
one. That is the half that was done right, and it is the half that is easiest to lose.

## 2. What does not hold

Twenty-five defects, in four groups. Each is a `PEND` line in the gate carrying the handoff
item that fixes it; promoting one to a hard failure is moving its call from `pend(...)` to
`must(...)`.

### 2.1 Focus goes where the eye cannot

`keep="true"` mounts a subtree once and hides it with `opacity: 0`, `pointer-events: none` and
`aria-hidden="true"` (`packages/dom/src/element-motion.ts`, `mountKeep`). It never sets
`inert`. Every focusable inside a hidden `keep` subtree therefore stays in the tab order while
the page is telling assistive technology to ignore it, which is the one combination that is
worse than either alone. Chromium says so in the console: *"Blocked aria-hidden on an element
because its descendant retained focus."*

On the expression canvas that is **43 tab stops** the reader cannot see: the value editor
(close, field, nine scope rows, Save, Cancel) and the whole wrap catalog (close, search, clear,
twenty-four templates, Wrap in, Clear selection). On a five-node formula, 43 of the 61 stops
inside the canvas lead nowhere. And because the expression overlay is itself mounted with
`keep="true"`, **nine of them are in the tab order of the workflow canvas** before a formula
has ever been opened.

This is a kernel decision, not an Editor one, and it reaches every `keep="true"` in every app
built on the framework. The kernel already knows the pattern: the pager writes
`row.wrapper.inert = !active` three hundred lines away in `mount.ts`.

### 2.2 A graph you can enter but not traverse

- All four arrow keys are inert on a focused node. There is no spatial navigation and no way
  to follow a wire.
- `Escape` does nothing: it does not clear the selection and it does not close the value
  editor.
- Opening a row's value editor leaves focus on the row. The field is **13 to 15 tab stops
  away**, because the panel is chrome and chrome is last in the DOM. On a forty-term formula
  it is past every remaining card.
- `Enter` in the value field does not commit. `Save` is another button, further on.
- Closing the panel while focus is inside it strands the caret in an `aria-hidden` subtree.
- The focus ring lives inside the transformed `.flow-world`, so it scales with the canvas. On
  `matrix` the fit lands at zoom 0.56 and the only focus indicator on the surface renders
  **1.13 CSS px**.

### 2.3 The tree cannot answer the three questions a graph exists to answer

Read the accessibility tree for `rows.reduce((sum, r) => sum + r.total * r.qty, 0).toFixed(2)`
aloud and this is what arrives:

```
button "Fold Into .reduce"
  StaticText "Fold Into" / ".reduce"
  list  listitem  button "Edit Items"       StaticText "Items" / "rows"
        listitem  button "Edit Start With"  StaticText "Start With" / "0"
  list  listitem  StaticText "sum"
        listitem  StaticText "r"
button "Multiply "
  list  listitem  button "Edit 0"  StaticText "0" / "r" / ".total"
        listitem  button "Edit 1"  StaticText "1" / "r" / ".qty"
button "Add "
  list  listitem  button "Edit 0"  StaticText "0" / "sum"
        listitem  button "Edit 1"  StaticText "1" / "Multiply"
button "Round To .toFixed"
  list  listitem  button "Edit Of"        StaticText "Of" / "Fold Into"
        listitem  button "Edit Decimals"  StaticText "Decimals" / "2"
button "Result "
```

Three failures are visible in it.

**What is this node.** The name is the operation and its token, which is right. `Multiply ` and
`Add ` carry a trailing space where the subtitle is empty, and `Result ` too. Cosmetic, but it
is in the string a screen reader speaks.

**What feeds it.** Tabbing announces `"Edit 1, button"`. That is the accessible NAME, computed
from `a11yLabel`, and it overrides the content: the `StaticText "Multiply"` beneath it is only
reachable in a screen reader's browse mode, not while tabbing. So in the mode a person actually
edits in, a wired row and a typed row are the same announcement. The three channels that
separate them on screen are a recessed well, the ink weight, and a filled socket, and the
fourth, the `←` arrow, is the one the sheet describes as *"the channel that survives a
greyscale print and a colour-blind reader"*. It carries `a11yHidden="true"`.
`0/10` wired rows say where their value comes from, on every fixture.

**Where the value goes.** Nowhere. No node names its consumer. `Round To`'s `Of` row says
`Fold Into`, so a consumer can be inferred by walking every other card's rows, which is not
reading, it is searching.

**And the loop is not there at all.** `.expr-frame` is `a11yHidden="true"`. The band that reads
`FOR EACH r CARRYING sum` is the single most explanatory object on the canvas and it is the one
thing the tree does not contain. The parameter pills survive only as `StaticText "sum"` and
`StaticText "r"` in an unlabelled list: two bare names with no role, no relationship, and no
statement that they are what the body is handed. `0/6` pills are named controls on `matrix`.

### 2.4 Reading order is emission order

Cards are absolutely positioned from a computed layout, so DOM order is whatever the projection
emitted: containers sorted by depth, then every plain card. On one chain that happens to agree
with the drawing. On anything else it does not.

```
wide   Multiply@518 > Add@736 > Divide@736 > Subtract@914 > F@914 > List@717 >
       Join@914 > Is Greater Than@696 > Choose@914 > Add 4 values@1184 > Result@1416
matrix Map Over@468 > Map Over@649 > Fold Into@1188 > Fold Into@690 > Keep Where@509 > ...
```

Ten inversions on `wide`, seven on `matrix`. On `matrix` the tab order runs 720px right, then
jumps 500px back left, twice. A sighted keyboard user is chasing a ring around the screen; a
screen reader user is being read a graph in an order that has no relation to the graph.

## 3. The keyboard and semantic model

The model below is what a node graph needs, stated so it can be built. It is deliberately not
a new interaction language: every piece of it is a pattern that already has a name and that
screen reader users already know.

### 3.1 The canvas is a tree grid, not a list of buttons

The graph is a DAG, and the one WAI-ARIA structure that fits a browsable set of rows with
expandable children and a two-dimensional caret is `treegrid`. Adopt it literally:

```
.expr-shell   role="application"  aria-roledescription="expression canvas"
              aria-label="Formula: <the source text>"
  .expr-world role="tree"         aria-label="<n> nodes, ending in Result"
    card      role="treeitem"     aria-level  aria-setsize  aria-posinset
                                  aria-expanded (containers only)
      rows    role="group"
        row   role="treeitem"     aria-level+1
```

`role="application"` is the honest declaration: the arrow keys mean something here, and a
screen reader must hand them through rather than using them to browse. It is only ever correct
when the keys really are all handled, which is what section 3.2 commits to.

### 3.2 Movement: one caret, two axes, and the wire is an axis

Exactly one node in the canvas is in the tab order at a time (roving `tabindex`). `Tab` enters
the canvas at the caret and the next `Tab` leaves it. Inside, the arrows move the caret and
never scroll the page.

| Key | Meaning on the expression canvas | On the workflow canvas |
|---|---|---|
| `Tab` / `Shift+Tab` | in and out of the whole canvas, one stop each way | same |
| `Down` / `Up` | the next / previous row of this card; from the last row, the next card in DRAWN order | the next / previous step |
| `Right` | **follow the wire out**: move to the node this value flows INTO | into a container's body |
| `Left` | **follow the wire back**: move to the node feeding the focused row | out to the container |
| `Alt+Right` | when a row has several possible destinations, cycle them | n/a |
| `Home` / `End` | the leftmost source card / the Result | the first / last step |
| `Enter` | select the node, or open the focused row's value editor | same |
| `Escape` | close the editor, then clear the selection, then leave the canvas | same |
| `F6` | cycle the canvas, the panel and the chrome as landmark groups | same |
| `+` / `-` / `0` | zoom in, out, fit | same |

`Right` and `Left` are the whole model. A wire has no text equivalent, so it becomes a
MOVEMENT: the reader learns the topology by travelling it, the way they learn a tree by
opening it. Every traversal announces where it landed and why, through a live region:
`"followed Multiply into Add, operand 1 of 2"`.

Drawn order, not emission order, decides `Down` from the last row. The projection already knows
every card's `x` and `y`; the reading order is `sortBy(x, y)` and nothing more.

### 3.3 Names: a node says what it is, what it takes, and where it goes

A node's accessible name answers all three questions in one string, in that order, because a
screen reader user hears the beginning of a name far more often than the end.

```
<Operation> <token>, <n> inputs, feeds <consumer> as <slot>
Fold Into .reduce, 2 inputs, feeds Round To as Of
Multiply, 2 inputs, feeds Add as operand 2
Result, the formula's value
```

An operand row says its slot, its provenance, and its value:

```
<Slot>, from <source node>            Items, from rows
<Slot>, <value>                       Decimals, 2
<Slot>, the loop item <name>          0, from the loop item r, property total
<Slot>, empty                         Note, empty text
```

The word **from** is the load-bearing token: it is what makes a wired row and a typed row two
different sentences, and it replaces three visual channels with one lexical one. It is not an
extra channel bolted on; the drawing already says exactly this with an arrow, and the arrow is
currently hidden.

A container announces its band, because the band is the explanation:

```
Fold Into .reduce, for each r carrying sum, 2 inputs, feeds Round To as Of
```

and each parameter pill becomes a real control:

```
button "r, the loop item, read by 2 rows"
button "sum, the accumulator, carried out of the loop"
```

### 3.4 Editing: the panel belongs to the row

Opening a value editor is a mode change, and mode changes have a settled shape.

1. `Enter` on a row opens the panel and MOVES FOCUS to the field. The panel is
   `role="dialog"` with `aria-modal="true"` and `aria-labelledby` on the row's own name.
2. While it is open, focus is contained inside it. This is the one place a trap is correct.
3. `Enter` in the field commits and closes. `Escape` cancels and closes.
4. Either way, **focus returns to the row that opened it** and the live region says
   `"Decimals set to 2"` or `"cancelled"`.
5. Everything behind the panel goes `inert` for the duration, which is the same one-line
   mechanism section 2.1 asks for.

The catalog is the same shape, opened from a selected node, returning focus to that node.

### 3.5 Two things the drawing must stop carrying alone

**A skip link.** A canvas is a large repetitive region, so the first stop inside it is a
visually hidden `"Skip the formula, 11 nodes"` button. WCAG 2.4.1, and on a forty-term formula
it is the difference between usable and not.

**A text alternative for the whole graph.** The Studio already has one and does not use it: the
source text. `aria-label` on the shell carries the formula as written, so a reader who wants
the answer rather than the tour gets it in one stop.

## 4. Colour, and what a second channel has to be

The eleven family hues on `.expr-shell` were tuned by eye. The badge palette beside them was
given a deliberate three-rung lightness ladder for exactly this reason and the family palette
was not, so two palettes on one screen were held to two standards and only one was written
down. `check_canvas_contrast.rb` is the other one.

**Metric.** CIEDE2000 between the two members of a pair, computed after simulating the
deficiency with Machado, Oliveira and Fernandes (2009) at severity 1.0 in linear sRGB. CIEDE2000
rather than dE76 because these hues differ mostly in hue angle and dE76 systematically
over-reports separation in blue, which is where this palette is most crowded. A published
single-matrix dichromacy model rather than a per-observer one because a guard needs a number
that reproduces. The bands are set for what the objects ARE, a 20px tile and an 8px disc, never
adjacent, often at 0.55 zoom: **collapsed below dE00 8, weak below 16**. A 2.3 unit
just-noticeable-difference describes two large adjacent patches under study and is useless
here.

**Contrast passes everywhere.** Every family ink clears 3:1 on its own 18% tint over both
grounds (floor 3.76:1 on a card, 4.42:1 on the stage) and 4.78:1 directly on both grounds. The
value palette in the well clears 4.5:1 with a 6.20:1 floor. Nothing on the canvas is too dim.

**Ten of the fifty-four family pairs collapse.**

| pair | dE00 | under | dL\* |
|---|---|---|---|
| source / decision | 3.23 | protanopia | 1.05 |
| source / collection | 3.32 | deuteranopia | 5.62 |
| decision / collection | 3.59 | protanopia | 6.67 |
| math / call | 4.02 | tritanopia | 0.29 |
| value / higher | 5.07 | deuteranopia | 4.08 |
| call / text | 5.35 | tritanopia | 3.99 |
| value / call | 5.61 | deuteranopia | 7.50 |
| higher / unknown | 5.66 | protanopia | 7.64 |
| call / output | 7.83 | protanopia | 13.72 |
| math / decision | 8.00 | protanopia | 0.36 |

Twenty-two more are weak. **Nineteen pairs are separated by hue alone** (dL\* under 8 and no
deficiency clearing 16), including `math`/`call` at 0.29 L\* apart and `math`/`decision` at 0.36.

**The finding is that hue cannot be fixed by choosing better hues.** A search over the
lightness of all eleven, hue and saturation frozen, subject to the 3:1 tile floor, tops out at
a worst pair of **dE00 9.37** and only reaches it by driving `call` to `#def6f7` and `compare`
to `#dfc9f8`, at which point the palette has no families left, only near-whites. Bounded to
+/- 12% lightness it reaches **7.73** while keeping every hue recognisable, taking the
collapsed pairs from ten to four and the hue-only pairs from nineteen to seven, with neither
contrast floor moving. Under deuteranopia the residual axis is blue-yellow, and
eleven families do not fit on one axis. The concrete replacement values are handoff item C1.

**The second channel already exists and it is the glyph.** Every tile carries an operation
mark, and every card carries its operation in text. A reader who cannot tell amber from gold
still reads a division sign and the word `Divide`. So a collapsed hue pair is a loss of the
at-a-glance grouping the palette was minted for, not a loss of meaning, and it is not a
1.4.1 failure.

**With one exception.** `.expr-cat-dot` in the wrap catalog is a 6px disc whose only content is
the family hue. It sits beside a title that names the OPERATION, never the family, and it is
`a11yHidden="true"`. There, hue is genuinely the only channel, and the fix is a second one:
either the family's own glyph in place of the dot, or the family word.

**The wired-versus-typed distinction survives colour-vision deficiency and does not survive a
screen reader.** On screen it has a recessed well (a 4.5 L\* ground change, not a colour), an ink
weight, a filled socket, and an arrow. None of those depends on hue. In the accessibility tree
it has nothing, because the arrow that carries it is `a11yHidden` and the name is the same
sentence for both. That is the inversion worth remembering: the palette work protected the
reader who cannot see colour, and left out the reader who cannot see.

## 5. Verdict

The expression canvas is **operable but not usable** without a mouse. Every node can be
reached, selected and opened from the keyboard, and every one of them has a focus ring and a
name. What is missing is everything that makes a graph a graph: the reader cannot follow a
wire, cannot escape a mode, cannot find the field belonging to the row they just opened, walks
43 stops that are not on screen, and is read the cards in an order the drawing does not have.

The smallest change that turns it usable is three lines and one attribute:

1. `el.inert = !on` in `mountKeep`, which deletes 43 phantom stops here and the same class of
   defect everywhere else in the framework.
2. `Escape` on the shell closing the panel and then the selection.
3. Focus moving into the value editor on open and back to its row on close.
4. Removing `a11yHidden="true"` from `.expr-frame` so the loop exists.

Handoff items K1, K3, K4 and S2. Everything after those is the model in section 3, and the
model is what makes the canvas good rather than merely legal.
