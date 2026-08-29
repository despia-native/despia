# Statement legibility

The Studio has two node canvases. The other one draws a single JSE expression left to right and
was measured first: `expression-legibility.md`, median ratio 1.86, no crossover at any size.
This document is the same question asked of the other canvas - the one that draws an action body
top to bottom, one card per statement - and the answer is different.

**The statement canvas is cheaper to read than the code it replaces, on the median real body and
in aggregate, and it has a crossover the expression canvas does not have.** It is also fifteen
times taller than the code, which the ratio prices at almost nothing and which section 9 states
in full rather than burying.

The model is `packages/cli/src/flowcost.ts`. It is pure and total: no clock, no randomness, no
filesystem, so the same body always produces the same record and a recorded baseline is a fact
rather than a mood. The corpus walk lives beside the corpus it harvests, in
`packages/cli/test/statement-corpus.ts`, because a model that reaches the filesystem is a model
that runs in one checkout. Every table below is generated:

```bash
cd OpenSource/Web
node packages/cli/src/flowcost.ts              # the twenty real bodies and the three oracle ones
node packages/cli/src/flowcost.ts --baseline   # the gate's baseline block
node packages/cli/test/statement-corpus.ts     # the whole repo: ratio, bands, crossover
node packages/cli/test/statement-corpus.ts --shape   # statements, depth, screenfuls
node packages/cli/test/statement-corpus.ts --worst   # the ten that waste the most looking
node --test packages/cli/test/flowcost.test.ts
```

Why the file is called `flowcost.ts` and not `statement-legibility.ts`: `legibility.ts` ends in a
script entry guarded by `argv[1].endsWith("legibility.ts")`, and any path ending in those
characters matches it, so a sibling named that way runs the expression report the moment anything
imports it.

---

## 1. The unit, and what it inherits

Both sides are priced in **eye fixations**, the sibling's unit, because two instruments in one
repo that disagree about what a card costs are two opinions nobody can compare. Every weight that
means the same thing on both canvases is READ OFF `legibility.ts` rather than copied - a card
head is 1.2 here because it is 1.2 there.

The text side of one statement is `textCost` from `legibility.ts`, called **unchanged**. A
statement is one expression's worth of reading, so re-deriving its price here would be a second
opinion about the same characters.

Two rules keep the model honest rather than merely harsh, and both are stated on the file:

1. **A cost both sides pay identically is not charged.** The variables a reader carries from
   statement to statement; the words inside a comment. Both representations show the same names
   and the same prose. Charging a wash to both sides drags the ratio toward 1.0, which flatters
   whichever side is losing. The model prices only what the two representations do *differently*.
2. **Where the drawing prints the source, it pays the source's price.** A row holding
   `total * 100 + tip` puts those characters in front of the reader exactly as the file does, so
   the row is charged the label plus what that expression costs as text. This is the term that
   catches a drawing whose nodes are a second copy of the code, which is the disease the
   expression audit found on the other canvas.

## 2. What transfers, what is re-weighted, what is new, what does not apply

| term | here | why |
|---|---|---|
| card head | **1.2, unchanged** | a mark, a title, usually a subtitle, in one boundary. The same object on both canvases. |
| argument row | **0.8, unchanged** | a label and a value in one 24px band. |
| wire | **0.15 + 0.25/corner + 0.1 per 200px, unchanged** | a straight run between stacked cards is almost free; every corner is a decision point. |
| crossing | **1.5, unchanged** | the one effect size in the graph-drawing literature nobody disputes. Counted from the routed polylines with the sibling's own `countCrossings`. |
| extent | **min(pan, zoom), unchanged** | 2.0 per extra 1680x1050 tile, or 8.0 scaled by how far the fit zoom falls under 0.75. |
| repetition relief | **-0.5 x redundancy x labelled, unchanged** | a column of near-identical Set Variable cards is not read card by card after the third. |
| socket | **re-pointed at the bead, 0.15** | this canvas has no sockets. It has merge dots and loop ports: 9px discs on the wire, one bit each, which is exactly what the socket weight prices. |
| pill | **0.6, re-pointed** | the sibling's parameter pill is one short word in its own shape. So are the Start and End pills, and so are the Then / Else / Catch / Always lane words. |
| frame | **0.9 becomes 0.5** | the sibling's frame is a wall *plus* an eyebrow of real words. A loop container here carries no words at all - the For Each Loop card sits above it and is charged its own full head - so only the wall is left. |
| containment | **split in two: 1.0 a lane, 0.5 a wall** | the sibling charges one layer weight because it has one kind of container. Here a loop draws a tinted wall the reader is continuously inside of (half an indent, the diagram's genuine win) while a branch lane has no wall at all - just a column offset and a word at the top, often off screen by the time it matters. That is exactly the text's indentation, so it is charged exactly what the text's indentation is charged. |
| chip / hidden entry | **becomes the elided row, and costs more** | the sibling charges 0.25 per hidden arm because most readers accept a summary of thirty-three identical Multiplies. `logicWrite.send({ body: logic…` summarises nothing: the row is charged what the **whole** expression costs whether or not the card shows all of it, plus 0.5 for the detour into the editor. Cutting a value shorter can never make this number fall. |
| the + disc | **new, 0.15** | every connector carries an always-drawn 24px + at its midpoint. It carries one bit, which is the bead's price, and there is one per wire. A model that ignored it would be measuring a canvas nobody ships. |
| the note strip | **new, 0.4** | the box only. The words inside it are the file's own words, which both representations show (rule 1). |
| block nesting (text) | **new, 1.0 per level** | half the sibling's bracket weight, and for a stated reason: a bracket opened and closed inside one line costs a backward saccade to find the opener, while a brace closed twenty lines down at a matching column costs nothing to stay oriented inside. What indentation does not do is name what you are inside of. |
| block extent (text) | **new, 1.0 per braced block** | where does this end, is there an else, is there a catch - one regression to a matching brace, per block. The drawing answers all three with its shape. Flat rather than proportional to the block's length, which undersells the text on a long block and so leans, as everything here does, against the drawing. |
| text extent | **new, 2.0 per screenful** | the text side can also fail to fit. Pan only: there is no zoom escape for code, because code at 8px is skimmed for shape, not read. |
| reading path (hops, travel) | **does not apply** | the sibling charges 0.4 per hop along the critical chain plus 1.0 per 1000px of following it. On a vertical statement flow, **adjacency already asserts sequence**: the card below is next, exactly as the line below is next, and the connector between two stacked cards carries no ordering information the layout has not already given. The corner term prices the only places the path forks, and the extent term prices the height. Charging hops as well would charge the same downward read three times. Section 10 measures what reinstating it would do. |
| sockets, parameter pills | **do not apply** | this canvas has neither. |

### One extension to the sibling's vocabulary

`textCost` waives the first two segments of a path rooted at a global: nobody reads `round` off
`Math.round` and wonders what it is. That list was drawn for expressions bound to a screen and it
does not contain the word this workload is made of. **`dsx` is the bus handle**, and `cfg.ts`'s
liveness scanner already refuses to give it a port on exactly that ground.

Left alone, `dsx.module.haptics.impact({ style: 'light' })` introduces five names, two of which
are furniture, and the two spurious ones eat half the four-name free working set. Measured over
the corpus that inflates the text side by 7.4% and so **flatters the drawing**, which is the one
direction this model is not allowed to be wrong in. So the waiver is extended by exactly one root
and applied to the published `names` count, leaving every weight alone. The walk that does it is
a second copy of the sibling's name rule, so `flowcost.test.ts` asserts that with the waiver
empty it reproduces `textCost(...).names` exactly - the day the sibling changes its vocabulary,
the copy fails here instead of quietly pricing a different language.

---

## 3. The real workload, measured

Every `<action>`, `<formula>`, computed `<variable>` and `on:*` handler in every `.dsx` under
`ClosedSource/DSX/Modules`, `ClosedSource/Dashboard`, `ClosedSource/Website` and `OpenSource`.
The rule is `edit.ts`'s own `logicBodies` rule, so the corpus is exactly the workload the surface
is pointed at.

The counts below were measured on 2026-08-25 and they move whenever somebody writes logic - the
corpus IS the repo, which is the point of it. That is why the gate asserts bands (1,800 to 2,300
bodies, 55% to 75% of them one statement, median ratio under 1) rather than exact totals, and why
the fixture baseline in section 8 is quoted on twenty bodies copied out of it.

```
files 236   bodies 1985   not exact 0
statements  p50 1  p75 2  p90 6  p99 18  max 196  mean 2.58
  at most  1 statements: 64.9%
  at most  2 statements: 75.5%
  at most  3 statements: 82.3%
  at most  5 statements: 89.6%
  at most 10 statements: 97.6%
  at most 20 statements: 99.4%
nesting depth  0:1338  1:225  2:26  3:5  4:1  5:2
drawing height p50 304  p90 924  max 9242
over one screen: drawing 7.7%  text 0.3%
```

| kind | n | p50 statements | p90 | one-statement | ratio p50 |
|---|---|---|---|---|---|
| handler (`on:*`) | 869 | 1 | 1 | 93% | 0.84 |
| computed `<variable>` | 295 | 2 | 7 | 49% | 1.04 |
| `<formula>` | 28 | 3 | 7 | 39% | 1.06 |
| `<action>` | 405 | 3 | 8 | 14% | 0.73 |

**Two thirds of the workload is one statement, and 84% of it has no control flow at all.** Every
body in the repo projects byte-exactly, so every cost quoted here is a fact about a drawing the
editor is allowed to write through.

### The fixtures are six times richer in control flow than reality

The same skew the expression audit found. **All four of the projection's own fixtures carry
control flow; 18.4% of real bodies do** - 1,620 of 1,985 are flat. `nodeflow.test.ts`'s PLACE
fixture is thirteen statements with a loop, a branch, a `continue` and a `throw`; the oracle's
three actions average twelve. Reality is `dsx.event('unlock')`. That is why the twenty bodies in section 6 are quoted
verbatim out of the repo and drawn in the measured proportion, and why `flowcost.test.ts` fails
if that sample stops looking like the corpus.

### One thing the harvest found that is not a projection defect

`on:change.throttle="60"` is a **modifier carrying a number** - `compiler/src/component.ts` reads
it with `parseInt` and `screengraph.ts` strips the suffix to find the handler it belongs to. But
`edit.ts`'s `logicBodies` takes any attribute starting with `on:`, so the Studio's Logic panel
lists **31 bodies** named `<slider> on:change.throttle` whose whole program is `60`, drawn as a
card between a Start and an End pill. That is a defect in the body index, not in the projection,
and it belongs to `edit.ts`; the corpus walk declines to measure a canvas nobody meant to draw
(`MODIFIERS` in `statement-corpus.ts`) and the defect is reported here rather than fixed.

---

## 4. The ratio, by band

```
bodies 1985   ratio p50 0.78  p90 1.74  p99 2.4  min 0.2  max 2.4
crossover: 23 statements

band          n     p50     min     max  over 1
-----------------------------------------------
1          1289    0.70    0.20    2.40     525
2           210    0.89    0.21    1.41      65
3 - 4       195    0.86    0.30    1.30      23
5 - 8       199    0.81    0.40    1.16       7
9 - 16       70    0.85    0.44    1.11       2
17 - 32      15    0.80    0.42    1.11       1
33+           7    0.84    0.75    0.91       0
```

**The median real body costs 0.78 of what its source costs, and the aggregate over all 1,985 is
0.78.** 68% of bodies are at or under 1. The expression canvas has no crossover at any size; this
one has one at **23 statements** - at or above that size, every body in the repo is cheaper as a
drawing than as text.

Read the bands rather than the headline. The ratio is flat across size: there is no point at
which the drawing starts winning by more, and no point at which it collapses. What the bands do
show is that **the risk is concentrated at one statement**, where the spread runs from 0.23 to
3.04 and 38% of bodies lose. That is not a size effect, it is a floor: a one-statement body draws
a Start pill, a card, an End pill, two wires and two + discs - 3.0 fixations of ceremony before
any content - and `toggleWorkout` is one fixation of text.

Where the drawing's cost goes, over the whole corpus:

| term | share of the drawing |
|---|---|
| printed source (row values, code lines, elision detours) | 54.1% |
| objects (cards, pills, rows, beads, walls, lane words, + discs) | 40.3% |
| wires | 5.9% |
| containment | 0.9% |
| extent | 0.6% |
| crossings | 0.1% |
| repetition relief | -1.8% |

**More than half of this drawing is the author's own text, reprinted inside its nodes.** That is
the expression canvas's disease, present here too - and here it still comes out ahead, because
what the cards replace (the bus path, the braces, the commas, the colons, the `dsx.variable.`
prefixes) costs more than the labels and heads that replace it.

**Crossings are 11 in the entire corpus** - the vertical band layout does not cross wires, the
same result the expression canvas got, and for the same construction reason.

**80.9% of the wires carry no information** (4,610 of 5,699 are a straight vertical drop between
two stacked cards; 837 carry a Then / Else / Catch / Always word). The expression audit measured
74.8% on the other canvas and called it a defect. Here it is not one, and the difference is worth
being precise about: on a left-to-right dataflow graph a wire is the ONLY thing asserting that
this value feeds that operand, so a wire that says nothing is a wire that could be deleted. On a
top-to-bottom control flow, **adjacency already asserts sequence** - the card below is next
because it is below - and the straight connector is a rendering of an ordering the reader already
has. That is exactly why this model does not charge the reading path (section 2), and it is also
why deleting those wires would not help: each one carries the + disc that is the whole insert
grammar, and an unwired column of cards would have nowhere to put it.

**Repetition is real and small.** 199 bodies (12.5%) draw three or more cards with the same
title - the `dsx.variable.x = null` reset run is the archetype, four cards differing in one word
- and they are the whole top of the worst-by-excess list:

```
   15.8  x1.26  "dsx.variable.segment = 'Overview'; dsx.variable.slider = 0.4; dsx.variable.toggleOn = true; dsx."
    8.7  x1.31  "dsx.variable.flagged = true; dsx.variable.priority = 'Normal'; dsx.variable.rating = 3; dsx.vari"
    6.5  x1.08  "if (phase == 'start') { dsx.variable.baseW = dsx.variable.landscape ? dsx.variable.frameH : dsx."
    5.6  x1.20  "dsx.variable.logicSelected = null dsx.variable.logicPlusAt = null dsx.variable.logicNoteSpan = n"
    5.1  x1.32  "dsx.variable.exprSelected = null dsx.variable.exprCatOpen = false dsx.variable.exprRowKey = key "
```

Their median ratio is 0.89, and **the worst body in the repo wastes 15.8 fixations**. On the
expression canvas the same ranking opened at 13.2 fixations on a single formula. A column of
near-identical cards is the ugliest thing on this canvas and it is not, by this measure, an
expensive one - the repetition relief already gives back what a reader saves by confirming rather
than decoding, and no fold was added to chase it.

---

## 5. What the screenshots show

`SHOTS=/tmp/mine node packages/dom/oracle/studio-surfaces-browser.ts`, then `07-logic`,
`07b-logic-body`, `07c-logic-field`. Coordinates below are CSS px.

- **The canvas opens on nothing.** Arriving at the Logic view with no focus drew an empty
  1275x1150 pane with one grey line of instruction in the middle of it, on a document whose seven
  bodies were listed in the panel two inches to the left. Fixed (section 7).
- **A card read as two columns.** `Name` sat in an 82px cell with its value 90px away, inside a
  27px row pitch. The nearest thing to a label was the label below it, not the value beside it;
  at 3.3:1 the eye groups the wrong way. This is the same defect the expression audit measured at
  112px in a 24px row - same author, same habit. Fixed (section 7).
- **The row was cut where nobody could see it.** The projection handed out 60 characters and the
  row can show nineteen. Forty-one went under a CSS ellipsis, so the drawing was hiding two
  thirds of an expression while its own census reported that it showed it. Fixed (section 7).
- **The loop head said `rows` twice**: subtitle `r in rows` over an `Items rows` row, with the
  binder `r` - the name every step in the body reaches for - drawn in the one place on the card
  that cannot be edited. Fixed (section 7).
- **Ceremony is proportionate, mostly.** A Start pill that names the trigger (`ACTION · REFRESH`)
  is information. An End pill that says `End` is not, but it is also the drop target that appends
  at the end of the body, and the + discs are the whole insert grammar. Deleting affordances to
  win a ratio would be trading editing for reading in a model that explicitly does not measure
  editing, so none of them were touched.
- **The canvas uses a third of its width.** Everything hangs on one centre axis; ~1000px of the
  pane is empty in every screenshot. That is what a vertical flow looks like, and it is also why
  the drawing is fifteen times taller than the code (section 9).

---

## 6. The twenty real bodies, and the three the oracle draws

`TEXT` and `DRAW` are fixations; `cut` is rows elided at the card's edge; `tall` is how many times
taller the drawing is than the same body as text.

```
stmt line dep   TEXT    obj  print  wire xing  ext nest    rep    DRAW  ratio  cut  tall  body                    
---- ---- --- ------ ------ ------ ----- ---- ---- ---- ------ ------- ------ ---- -----  ------------------------
   1    1   0    1.0    2.7    0.0   0.3    0  0.0  0.0    0.0     3.0   3.04    0  15.2  handler/lone-name
   1    1   0    3.6    2.7    0.0   0.3    0  0.0  0.0    0.0     3.0   0.84    0  15.2  handler/action-call
   1    1   0    4.6    3.5    0.0   0.3    0  0.0  0.0    0.0     3.8   0.83    0  16.3  handler/event
   1    1   0    2.3    4.3    0.0   0.3    0  0.0  0.0    0.0     4.6   2.02    0  17.9  handler/set-flag
   1    1   0    8.5    3.5    0.0   0.3    0  0.0  0.0    0.0     3.8   0.45    0  17.2  handler/module-call
   2    1   0    4.9    7.3    0.3   0.5    0  0.0  0.0   -0.3     7.8   1.58    0  26.8  handler/set-and-close
   1    1   0    5.9    3.4    4.4   0.2    0  0.0  0.0    0.0     7.9   1.34    1  16.3  variable/one-return
   3    2   1   10.9    9.2    0.5   2.4    0  0.0  1.0   -0.3    12.8   1.17    1  18.2  variable/guarded-label
   2    2   0   10.8    6.5    0.0   0.5    0  0.0  0.0    0.0     7.0   0.65    0  13.1  action/two-steps
   2    2   0   24.2    6.5    8.6   0.5    0  0.0  0.0    0.0    15.6   0.64    1  13.1  action/await-and-set
   3    3   0   23.4   10.2    5.6   0.7    0  0.0  0.0    0.0    16.5   0.70    1  12.6  action/copy-and-flash
   3    2   1   26.2   11.1   14.2   3.3    0  0.0  1.0   -0.5    29.1   1.11    1  15.3  action/branch-both-ways
   3    5   0   60.1    9.3   49.0   0.5    0  0.0  0.0   -0.3    58.5   0.97    3   6.8  variable/filter-chain
   5    4   1   42.3   17.8    7.3   3.7    0  0.0  1.0   -1.1    28.6   0.68    1  12.8  action/guarded-await
   6    5   1   74.1   18.0   47.3   2.9    0  0.0  1.0   -0.8    68.5   0.92    4  12.7  variable/search-filter
  10    8   1   43.5   29.9    3.3   5.7    0  1.6  1.0   -2.2    39.2   0.90    1  12.8  action/early-returns
  11    8   1   98.4   32.5   51.5   7.5    0  2.0  1.0   -3.2    91.4   0.93    6  14.1  variable/ladder
   9    7   3   99.6   26.9   51.3   6.4    0  1.3  2.0   -1.3    86.6   0.87    3  14.1  variable/nested-loops
  13   10   1   63.0   40.4    5.1   4.5    0  2.9  1.0   -3.6    50.3   0.80    0  13.0  action/preset-fanout
   2    3   0   37.1    8.4    9.6   0.5    0  0.0  0.0    0.0    18.6   0.50    1  10.8  action/comment-and-steps
```

```
stmt line dep   TEXT    obj  print  wire xing  ext nest    rep    DRAW  ratio  cut  tall  body          
---- ---- --- ------ ------ ------ ----- ---- ---- ---- ------ ------- ------ ---- -----  --------------
  13   11   2   70.3   34.5   20.2   6.2    0  2.0  1.5   -1.5    62.9   0.89    0  10.9  oracle/refresh
  10   11   1   41.1   21.0    1.3   3.8    0  0.0  1.0   -0.2    26.9   0.65    0   5.6  oracle/submit
  13   13   0   80.2   25.9   40.8   2.2    0  1.9  0.0   -0.8    70.1   0.87    2   8.3  oracle/sync
```

---

## 7. What changed

Four changes, all of them in service of one rule: **the drawing must not lie about what it
shows.** Before and after are measured over the whole corpus.

**1. The label column is measured per card.** It was a flat 82px on every row, wide enough for
the longest word in the vocabulary ("Destination"), which left a `Name` row with fifty pixels of
nothing in the middle of it. It is now the widest label *that card* carries, clamped to 40..96,
measured with the same advance table the note wrapper uses.

- mean label column **82px -> 43.4px**; label-to-value distance **90px -> 51px** against a 27px
  row pitch (3.3:1 -> 1.9:1)
- visible value **19 -> 24 characters** on a typical card
- rows cut at the card's edge **1,680 -> 1,341** (339 rows, 20%, stop being cut). Counted from
  each row's whole expression; the census, which counts the ellipses the projection actually
  emitted, records **1,316** today.

**2. The value is elided by the projection, to the pixels the row actually has.** `fieldValue`
cut at 60 characters and let CSS clip the rest; the note strip already refuses to work that way
("WRAPPING HAPPENS HERE, not in CSS") and a value is the same problem. The census's `elided` went
from 420 to 1,341 with no change to what is on screen: the drawing was already hiding those rows,
and now it says so. Because an elided row is charged the whole expression plus the detour, this
made the measured cost go **up** (aggregate 0.826 -> 0.838), which is the correct direction for a
fix whose whole content is admitting something. The fold stays a one-gesture expansion: the row
carries the whole expression in `text` and `literal`, so tapping it opens the editor on the
complete value and the splice still addresses the whole span, ellipsis or not.

**3. A for-each head draws its binder as a row.** `for (const row of rows)` drew `row in rows` as
a subtitle and `Items rows` as its only row - `rows` twice, and `row` in the one place on the
card that is not editable. It now draws `Item row` (a binding, spliceable like a Set Variable's
Name) and `Items rows`, and the subtitle that duplicated both halves is suppressed. Nine loops in
the corpus; +9 rows, +99px of drawing across 1,985 bodies (1,597 when that row was measured).

**4. A Custom Code card reserves the height of every line it draws.** The card's height was
`56 + min(lines, 10) * 17` while the markup binds `lines` whole, so a twelve-line fallback drew
twelve lines into a box reserved for ten and sat on the next card. No body in the repo hits it
today, which is why it had never been seen. Shortening `lines` was not an option: it is also what
the code editor opens with, so a fold there would offer a Save that deletes the tail.

Net effect on the number: **p50 0.84 -> 0.84, aggregate 0.826 -> 0.838.** Three of the four
changes are invisible to the ratio and one of them makes it worse. That is what it looks like
when the instrument is not the target.

---

## 8. The gate

`BASELINE` in `packages/cli/src/flowcost.ts` records the drawing cost of all 23 fixtures, and
`flowcost.test.ts` fails when any of them rises past `BASELINE_TOLERANCE` (0.1 fixations - not
noise room, the layout moves by whole pixels; it is the width of a change no reader would
notice). It is a hardcoded census in the sense `check_editor_scale.rb` uses the term: not a
target anybody chose, but what `nodeflow.ts` does today, written down so the next change has to
say what it did to these numbers.

**How to re-record it, deliberately:**

1. `cd OpenSource/Web && node packages/cli/src/flowcost.ts --baseline`
2. paste the block it prints over the one in `flowcost.ts`
3. in the same commit, name the projection change that moved each number
4. re-run `node packages/cli/test/statement-corpus.ts` - a fixture cost that fell while the
   corpus p50 rose is a cost that fell for the wrong reason

**It runs in CI without a lane of its own.** `scripts/run-node-tests.ts` collects every
`*.test.ts` under every package's `test/` directory, so `npm test` - the `web-kernel` lane -
picks this file up the moment it exists. `statement-corpus.ts` is deliberately not named
`*.test.ts`: it is a library and a script, and its census assertions live in the test file.

The tests around it are of three kinds, and they fail for different reasons on purpose: the
**laws** (a one-statement drawing always costs more than the statement; hiding is never a saving;
more statements is monotonically more drawing; a loop's wall is charged less than a branch's
lane) survive any retuning of the weights; the **drift pin** fails when `legibility.ts` changes
its vocabulary; the **baseline** fails when the projection gets more expensive. Two further
census tests assert that the corpus still looks like the corpus (1,400-1,900 bodies, 55-75% of
them one statement, every one byte-exact, median ratio under 1) and that the oracle fixtures
still match the walk that screenshots them.

---

## 9. What this does not measure

- **Fifteen times the height.** The drawing is **15.2x taller than the code at p50, 18.8x at p90
  and 40.8x at worst**, and the fixation model prices that at 0.6% of the total - because the
  extent term only bites once a drawing passes a screenful, and 92% of these bodies are small
  enough that it never does. The `tall` column is printed beside the ratio for exactly this
  reason. `cfg.ts` opened by arguing that a node costs 20 to 50 times the screen area of the code
  it stands for, and that argument is not refuted by this document - it is measured and found to
  be about fifteen on the vertical axis, on a canvas that then wins on fixations anyway.
- **Editing.** Both sides are priced for a first read, and the Studio exists to change bodies, not
  to read them. Every + disc, every lane pill and the End pill are charged as reading cost and
  credited with nothing, because a fixation count cannot see that they are the entire insert
  grammar. A drawing with a typed control on every argument may be slower to read and much faster
  to change correctly.
- **Being wrong.** The model prices attention, not error rate.
- **Colour, contrast and typography.** Eleven card families are one weight here. That is
  `check_editor_scale.rb`'s territory.
- **What a fold hides, beyond its own tokens.** An elided row is charged the whole expression plus
  a detour, which is the strictest treatment in either instrument, but the reader who takes that
  detour also loses the canvas for a moment and has to find their place again. Only 0.5 of that
  is priced.
- **The residual elision.** 1,316 of 5,560 rows (24%) are still cut at the card's edge after the
  label fix. The card is 280px wide on a canvas that leaves ~1000px unused; widening it to 320
  would take the cut rows to roughly 19% at no cost in height. That is a design decision about
  card width, not a defect, and it is left named rather than taken.

---

## 10. Why the verdict survives the model's weakest choices

Three of this model's decisions are arguable, and all three were made in the drawing's favour:
dropping the reading-path terms, giving the row's first token away free, and letting a fold be
charged 0.5 for the detour. If the verdict depended on any of them it would not be worth much.
Each row below re-runs the whole corpus with one decision hardened:

```
as measured                                    p50 0.84  p90 2.02  over1 40%  aggregate 0.84
+ travel 1.0/1000px of drawing height          p50 0.92  p90 2.15  over1 41%  aggregate 0.86
+ travel 4.0/1000px (four times as harsh)      p50 1.11  p90 2.55  over1 64%  aggregate 0.93
+ hop 0.4 per card                             p50 0.96  p90 2.19  over1 42%  aggregate 0.88
rows charged full value text                   p50 1.02  p90 2.89  over1 53%  aggregate 0.99
hops + full row text                           p50 1.05  p90 3.06  over1 56%  aggregate 1.04
extent: pan only, no zoom escape               p50 0.84  p90 2.02  over1 40%  aggregate 0.85
no repetition relief at all                    p50 0.84  p90 2.02  over1 41%  aggregate 0.86
everything harsh at once                       p50 1.24  p90 3.59  over1 75%  aggregate 1.15
```

**No single hardening moves the aggregate past 1.0.** The verdict is "at worst at parity, cheaper
on the median body", and it takes four simultaneous hardenings - reinstating hops, reinstating
travel at four times the sibling's rate, charging every row's first token, and removing the
repetition relief - to push the aggregate to 1.15. Reproduce these by editing the closures in the
sensitivity probe; they are one-line adjustments over `bodyLegibility`.

---

## 11. The wins this canvas has, which the ratio only half sees

Named before anything was changed, so that nothing was traded away for a number:

- **A branch is two lanes that rejoin.** Text hides that in indentation and a matching brace; the
  drawing draws both paths and the point where they meet. The model gives the drawing a merge
  bead, two lane words and four elbows against the text's one block-match charge, so on the
  fixation count the branch is roughly a wash - and the drawing is still the only one of the two
  that answers "is there an else" without a search.
- **A loop is a container.** The one place the model says the diagram plainly wins: a wall is
  charged half what indentation is charged, because the reader is reminded what they are inside
  of instead of remembering it.
- **`try`/`catch`/`finally` is three shapes.** The error path is a lane of its own, the finalizer
  is a join on the axis, and neither is a keyword the reader has to find.
- **A terminator ends its run.** `return`, `throw`, `break` and `continue` draw no onward
  connector, so the chart cannot claim execution continues past them. Text says the same thing
  only if you know the keyword.
- **A statement's arguments are named.** `Amount`, `Currency`, `Destination` are the verb's own
  vocabulary, and the drawing spends a row label to say what position in an argument list means.
  The model charges 0.8 for each of those labels and credits them with nothing.
