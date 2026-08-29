# Expression legibility

The Studio draws one JSE expression as a left-to-right node graph. The claim that surface rests
on is that the diagram is easier to read than the text it replaces. This document is the
instrument that turns that claim into a number, the number it currently returns, and the gate
that stops the number getting worse.

The model is `packages/cli/src/legibility.ts`. It is pure and total: no clock, no randomness, no
filesystem, so the same source always produces the same record and a recorded baseline is a fact
rather than a mood. Every table below is generated, not typed:

```bash
cd OpenSource/Web
node packages/cli/src/legibility.ts             # the twenty and the eighteen
node packages/cli/src/legibility.ts --baseline  # the gate's baseline block
node --test packages/cli/test/legibility.test.ts
```

---

## 1. The unit

Both sides are priced in **eye fixations** - roughly a quarter second of looking at one thing.
That is the only currency the two representations share. Characters and cards are not
comparable; the number of times a reader must stop and resolve something is.

A weight with no argument behind it is a weight somebody will tune until the answer is the one
they wanted, so every weight in the model carries its reason on its declaration. What follows is
the index.

## 2. The text side

A reader of code does not pay by the character. `aVeryDescriptiveName + 1` is longer and easier
than `a?.b??c[d]`.

| term | weight | why it costs that |
|---|---|---|
| operand token | 1.0 | code is read denser than prose: roughly one fixation per token, where prose skips a third of its words. The count comes from the repo's own lexer, so the tokenisation is not arguable. |
| operator or punctuation | 0.3 | `(`, `,`, `.` and `+` are resolved in the parafovea on the way past far more often than they are fixated. Charging them a third says they shape the read without usually stopping it. |
| bracket nesting level | 2.0 | every bracket the reader is inside is an item held open, and closing it costs a backward saccade to find the opener plus the fixation that returns. Measured on the punctuation, not the parsed tree: `a + b * c` and `a + (b * c)` are one tree and two reads. A template's `${` opens a level too. |
| distinct name past the fourth | 2.0 | working-memory capacity for unrelated chunks sits near four. The first four names are free - the fixation that read the token already paid for them - and every name past that is one the reader will have to go back and find. Names from the language's own vocabulary are never counted: nobody has to learn `filter` from this expression. |
| 80-column run past the first | 2.0 | past about eighty columns the return saccade stops landing where the reader expects, and an expression on one physical line has no left margin to recover against. Charged per RUN, not per character: a character in the tail is already paid for by its token, and charging it twice turns the model back into a length count. |

## 3. The drawing side

Not a node count. A node count says a drawing of two cards and forty wires is small.

| term | weight | why it costs that |
|---|---|---|
| card head | 1.2 | the most expensive object on the canvas: a mark to classify, a title, usually a subtitle. Three glyph runs in one boundary, tightly enough grouped that the parafovea gets some of it free. |
| operand row | 0.8 | a name and a value in one 24px band: fewer stops than two separate objects, more than one. |
| socket | 0.15 | an 8px disc carrying one bit, filled or hollow. Nothing to decode, which is the floor cost of any distinct object on a canvas. |
| parameter pill | 0.6 | a short name with a role under it, in a rail the eye finds once. |
| frame | 0.9 | a wall plus an eyebrow of real words. Cheaper than a head because the wall needs no decoding once classified. |
| chip | 0.5 + 0.25 per entry hidden | a fold is the one move that lowers every other term at once, so hidden values are not free. The reader who needs the eleventh entry expands the chip, re-reads a canvas that just changed shape, and finds their place again. |
| wire | 0.15 + 0.25 per corner + 0.1 per 200px | a straight run between adjacent cards is almost free - the eye leaves the output socket already pointed at the input. Every corner is a decision point where the reader can leave on the wrong line, and past a couple of hundred pixels the far end is outside the perceptual span. |
| crossing | 1.5 | the strongest single predictor in the graph-drawing readability literature and the only one whose effect size is not in dispute. At a crossing the reader has lost the guarantee that the line leaving is the line arriving, and recovering it means a regression to the last unambiguous point. |
| extent | min(pan, zoom) | a drawing that does not fit leaves two escapes and the reader takes the cheaper one, so the model charges the cheaper one. Pan: 2.0 per extra 1680x1050 tile. Zoom: 8.0 scaled by how far the fit zoom falls under 0.75, the point where an 11px label stops being a word and becomes a grey bar. |
| reading path | 0.4 per hop + 1.0 per 1000px | the reader cannot understand the Result without walking the critical chain in order, holding each intermediate. The travel is the eye actually following it, cards included. |
| containment layer | 1.0 | a box on a stack, the exact analogue of the text's nesting depth - charged HALF what a text bracket level is charged, because the box has a drawn wall and an eyebrow that names it. The reader is reminded what they are inside of instead of remembering it. This is the one place the diagram plainly wins, and the model says so. |
| repetition | -0.5 x redundancy x labelled objects | forty rows all reading `Multiply` are not forty reads: after the third the reader is confirming rather than decoding. What they save is the decoding half, never the confirming half. Redundancy is Shannon entropy over the visible labels against the entropy of an all-distinct plane of the same size: 0 when every label says something new, 1 when they all say the same thing. |

### Crossings are counted from the routed polylines

This matters more than any weight. The throwaway measurement that motivated this file reported
**13 and 15 crossings** on the two most realistic formulas in its sample. Both numbers are
artefacts of comparing bounding boxes.

Counted properly, from `flow.edges[].points`, with a strict segment-intersection test:

- **the entire 194-form grammar corpus contains zero crossings**
- **the eighteen oracle fixtures contain one**, inside `map`'s record, where the wire feeding the
  second field from the parameter pill and the wire bringing the computed third field in cross at
  (313, 184)

The band layout in `exprflow.ts` gives every subtree a contiguous vertical band, and that
construction does not just avoid overlap - it very nearly avoids crossings altogether. The
counter's three judgement calls are pinned by tests and stated here rather than discovered: a
**shared endpoint** is not a crossing (it is a fan-out, which is information), a **T-junction** is
not a crossing (it is a wire landing on a socket), and **collinear overlap** is not counted, on
purpose, because it is the manoeuvre the projection uses to avoid crossings. Overlap does hide a
wire, which is a real defect - it is a different defect and belongs to a different measurement.

---

## 4. BEFORE: the twenty realistic formulas

Twenty formulas somebody would actually write, ordered by size. `TEXT` and `DRAW` are fixations;
`ratio` above 1 means the drawing is the more expensive read.

```
chars  tok dep name   TEXT   obj  wire xing  ext  path nest    rep    DRAW  ratio  source
----- ---- --- ---- ------ ----- ----- ---- ---- ----- ---- ------ ------- ------  ------
    5    1   0    1    1.0   3.6   0.7    0  0.0   0.8  0.0    0.0     5.1   5.12  total
    5    2   0    1    1.3   4.6   0.2    0  0.0   0.8  0.0    0.0     5.5   4.26  !done
   11    3   0    2    2.3   5.5   0.2    0  0.0   0.8  0.0    0.0     6.5   2.83  price * qty
   12    4   1    1    4.6   5.5   0.2    0  0.0   0.8  0.0    0.0     6.5   1.42  n.toFixed(2)
   14    3   0    2    2.3   5.5   0.2    0  0.0   0.8  0.0    0.0     6.5   2.83  subtotal + tax
   16    3   0    2    2.3   5.5   0.2    0  0.0   0.9  0.0    0.0     6.6   2.87  items.length > 0
   19    3   0    2    2.3   5.5   0.2    0  0.0   0.8  0.0    0.0     6.5   2.84  user.name ?? 'Anon'
   31    7   1    2    5.5   6.9   0.4    0  0.0   1.5  0.0    0.0     8.8   1.59  user.email.trim().toLowerCase()
   27    9   1    3    7.5   9.8   0.9    0  0.0   1.5  0.0    0.0    12.1   1.61  qty * price * (1 + taxRate)
   33    7   0    1    4.9   9.8   0.4    0  0.0   1.4  0.0    0.0    11.5   2.36  status == 'paid' ? 'Paid' : 'Due'
   35    8   1    2    7.2  11.1   0.6    0  0.0   2.1  0.0    0.0    13.7   1.90  Math.round(order.total * 100) / 100
   39    5   0    4    3.6   7.8   0.4    0  0.0   1.5  0.0    0.0     9.7   2.70  user.profile?.displayName ?? user.email
   43    7   1    3    6.9   7.8   0.4    0  0.0   1.5  0.0    0.0     9.7   1.40  `${user.firstName} ${user.lastName}`.trim()
   33   11   1    3    8.8   8.8   0.4    0  0.0   1.4  0.0    0.0    10.6   1.20  rows.map(r => r.total).join(', ')
   63    8   1    3    7.9  12.1   1.1    0  0.0   1.6  0.0    0.0    14.7   1.86  cart.items.length == 0 ? 'Empty' : `${cart.items.length} items`
   48   12   1    4    9.8  15.2   1.9    0  0.0   3.0  1.0    0.0    21.2   2.16  items.filter(i => i.status == 'open').length > 0
   75   19   1    5   16.0  19.4   3.4    0  0.0   3.4  1.0   -0.3    26.9   1.68  products.filter(p => p.price >= min && p.price <= max).sortBy(p => p.price)
   79   23   4    7   27.2  15.2   3.4    0  0.0   3.5  1.0    0.0    23.1   0.85  regions.map(r => ({ name: r.name, open: r.stores.filter(s => s.open).length }))
   60   21   2    5   18.6  17.9   5.5    0  0.0   3.2  1.0    0.0    27.6   1.48  rows.reduce((sum, r) => sum + r.total * r.qty, 0).toFixed(2)
   83   37   2    6   32.3  29.3   7.7    0  0.0   3.7  1.0   -0.4    41.3   1.28  rows.filter(r => r.q > 0).map(r => r.q * r.p).reduce((a, b) => a + b, 0).toFixed(2)
```

Median ratio **1.86**, worst **5.12**, best **0.85**. Nineteen of the twenty cost more to look at
than to read.

Read the columns rather than the total. Almost the entire drawing cost is `obj` - the objects the
eye must resolve. `xing` is zero on all twenty. `ext` is zero on all twenty: nothing here needs
panning. The diagram is not losing to routing or to size. **It is losing to the fixed price of
drawing anything at all**: a bare reference is one fixation of text and 5.1 fixations of drawing,
because the smallest possible canvas is still two cards, two sockets, a wire and a Result.

## 5. The whole grammar corpus

The 194 forms in `packages/cli/test/expr-corpus.ts`, which cover every shape of the language.

| | ratio |
|---|---|
| min | 0.67 |
| p50 | 1.76 |
| p90 | 5.13 |
| p99 | 5.16 |
| max | 5.17 |

180 of 194 forms cost more as a drawing than as text. Broken down by size, which is the
interesting cut:

| tokens | n | median ratio | min | max | over 1 |
|---|---|---|---|---|---|
| 1 - 2 | 38 | 5.12 | 1.40 | 5.16 | 38 |
| 3 - 5 | 82 | 2.40 | 0.82 | 5.17 | 80 |
| 6 - 10 | 55 | 1.18 | 0.74 | 3.23 | 48 |
| 11 - 20 | 17 | 1.30 | 0.67 | 2.16 | 12 |
| 21 - 40 | 2 | 1.34 | 1.21 | 1.34 | 2 |

## 6. The crossover: there is none

**There is no token count above which the drawing stops being the more expensive
representation.** `distribution()` looks for the smallest size at or above which every measured
expression scores at or below 1, and over the 194-form corpus it returns `null`. The test asserts
that null, so the day a crossover appears is a day this document has to be rewritten.

The band table says why, and it is not the answer anyone expects. The ratio falls steeply from
5.12 to about 1.2 between one token and six - and then it **stops falling**. From six tokens
upward the drawing tracks the text at a roughly constant 1.2 to 1.3 times its cost, all the way
out to the largest structured formula in the corpus. The diagram is not asymptotically winning
and needing bigger inputs to prove it. It is holding a constant multiple.

The only places the drawing does win are the degenerate bulk cases in the oracle set, and it wins
them by **hiding things**:

| fixture | text | draw | ratio | how |
|---|---|---|---|---|
| `sum40` | 199.7 | 47.1 | 0.24 | 40 products folded to a chip: 33 arms not drawn |
| `record30` | 160.1 | 38.3 | 0.24 | 30 fields folded to a chip: 24 not drawn |
| `list` | 42.0 | 16.9 | 0.40 | 28 entries folded to a chip |
| `record` | 26.6 | 14.1 | 0.53 | 5 fields, no fold - a genuine win |

Three of the four biggest wins are folds. Take the folds away and the diagram's advantage is one
five-field record. That is the honest summary of where the projection stands today.

## 7. The worst ten

By ratio, which is what the ranking asks for:

| ratio | source |
|---|---|
| 5.17 | `- -x` |
| 5.16 | `` `plain` `` |
| 5.16 | `undefined` |
| 5.15 | `!!value` |
| 5.15 | `/^a\/b$/gi` |
| 5.15 | `0b1011` |
| 5.15 | `list.length` |
| 5.14 | `_private` |
| 5.14 | `1_000` |
| 5.14 | `1.5e-3` |

That list is degenerate and it is degenerate for one reason: **the floor**. Every one of them is a
single token whose drawing is the minimum canvas. The whole top of the ratio ranking is one
defect, and it is the highest-value defect in the surface, because a one-token formula is the
commonest thing an author binds.

Ranked instead by absolute excess - how many fixations the drawing wastes over the text - the
list becomes a work queue:

| excess | ratio | source |
|---|---|---|
| 13.24 | 2.56 | `a < b && c !== d || !e` |
| 11.36 | 2.16 | `items.filter(i => i.status == 'open').length > 0` |
| 10.92 | 1.68 | `products.filter(p => p.price >= min && p.price <= max).sortBy(p => p.price)` |
| 10.91 | 3.23 | `a \| b ^ c & d` |
| 7.49 | 3.08 | `a + b * c` |
| 7.28 | 3.02 | `2 ** 3 ** 2` |
| 7.07 | 3.72 | `-2 ** 2` |
| 6.97 | 1.34 | `order.lines.reduce((sum, l) => sum + l.price * l.qty, 0).toFixed(2)` |
| 6.93 | 2.93 | `a && b \|\| c` |
| 6.88 | 2.25 | `a.trim() + b.trim()` |

Both lists point the same way: **a leaf operand that is one name or one literal should not be a
card.** Seven of the ten worst-by-excess are two or three operators over bare names, where the
text is four to eight fixations and the drawing spends fifteen to twenty on cards that each carry
one word.

## 8. The gate

`legibility.test.ts` records the drawing cost of the eighteen oracle fixtures and fails when any
of them gets worse.

```
chars  tok dep name   TEXT   obj  wire xing  ext  path nest    rep    DRAW  ratio  fixture
----- ---- --- ---- ------ ----- ----- ---- ---- ----- ---- ------ ------- ------  -------
   31    7   1    2    5.5   6.9   0.4    0  0.0   1.5  0.0    0.0     8.8   1.59  chain
   48   13   1    4    9.4  15.3   1.3    0  0.0   2.2  0.0   -0.3    18.5   1.97  arithmetic
   45    7   0    4    4.9  12.1   1.1    0  0.0   1.6  0.0    0.0    14.7   3.00  compare
   76    8   1    3    7.9  12.1   1.1    0  0.0   1.6  0.0    0.0    14.8   1.87  choose
   70   22   3    6   22.9  13.8   3.9    1  0.0   2.6  1.0    0.0    22.9   1.00  map
   70   17   1    5   14.7  16.1   2.8    0  0.0   3.3  1.0    0.0    23.2   1.58  filtersort
   80   21   2    6   20.6  17.9   5.5    0  0.0   3.3  1.0    0.0    27.6   1.34  reduce
   89   25   4    8   32.5  19.3   4.8    0  0.0   4.4  2.0    0.0    30.6   0.94  nested
   99   23   1    8   26.6  11.7   0.9    0  0.0   1.6  0.0    0.0    14.1   0.53  record
  110   59   1    1   42.0  15.1   0.4    0  0.0   1.4  0.0    0.0    16.9   0.40  list
   52    7   0    4    4.9   8.8   0.4    0  0.0   1.5  0.0    0.0    10.7   2.18  coalesce
   91   40   1   15   50.6  40.9   5.6    0  0.0   2.7  0.0    0.0    49.2   0.97  wide
  151   63   1    1   39.7  41.3   2.2    0  2.0   7.9  0.0   -0.8    52.6   1.33  chain12
  857  159   0   42  199.7  41.8   5.3    0  0.0   2.0  0.0   -1.9    47.1   0.24  sum40
  306  133   1   37  160.1  35.4   4.3    0  0.0   1.9  0.0   -3.2    38.3   0.24  record30
  505  151  30    1  160.0 168.8  10.9    0  6.7  37.6  0.0  -40.3   183.8   1.15  deep30
  175   62   6   14   71.4  41.6  15.2    0  0.0   8.7  3.0   -1.2    67.2   0.94  matrix
   43   18   2    2   15.0  17.2   1.3    0  0.0   2.1  0.0    0.0    20.5   1.37  quotes
```

**Where the baseline lives.** `BASELINE` in `packages/cli/src/legibility.ts`, one line per
fixture, next to a comment that says what it is. It is a hardcoded census in the sense
`check_editor_scale.rb` and `check_renderer_constants.rb` use the term: not a target anybody
chose, but what the projection does today, written down so the next change has to say what it did
to these numbers. The tolerance is 0.1 fixations, which is not noise room - the layout moves by
whole pixels and the arithmetic does not drift - it is the width of a change no reader would
notice.

**How to re-record it, deliberately.**

1. `node packages/cli/src/legibility.ts --baseline`
2. paste the block it prints over the one in `legibility.ts`
3. in the same commit, name the projection change that moved each number
4. re-run `node packages/dom/oracle/expression-canvas-browser.ts` - a cost that fell while the
   oracle's own findings rose is a cost that fell for the wrong reason

A number that falls is the point of the instrument, and re-recording it is how the next change is
stopped from spending the improvement. A number that rises with no named cause is the regression
the gate exists to catch.

**The ordering laws** are tested separately from the numbers, because they have to survive any
retuning of the weights: a bare reference costs less as text than as a drawing; renaming or
reformatting moves nothing; a crossing strictly increases the drawing cost by at least its own
weight; folding a run into a chip strictly decreases it, and hiding sixty values costs more than
hiding twenty-five.

---

## 9. What this does not measure

The ratio undersells the diagram, on purpose, and on exactly the axis where the diagram wins.

- **A shared subexpression.** A graph draws `order.total` once with two wires leaving it; the
  text must spell it twice, and a reader must notice the two spellings are the same thing. The
  model charges the text for two tokens and the drawing for one card and one extra wire, which is
  close to fair, but it cannot charge the text for the RECOGNITION - the work of establishing
  that the two occurrences are one value. That work is real and it is not in the number.
- **Where a value goes.** A wire is an answer to "what uses this", drawn. Text answers it by
  making the reader scan. The model charges for following a wire and gives nothing back for the
  question the wire answers before it is followed.
- **Editing, not reading.** Both sides are priced for a first read. Nothing here measures how
  long it takes to CHANGE the expression, and that is the operation the Studio exists for. A
  drawing with a labelled well and a typed control may be slower to read and much faster to edit
  correctly.
- **Being wrong.** The model prices attention, not error rate. A representation that is slower
  and produces fewer mistakes is better, and nothing here can see that.
- **What a fold hides.** The chip charges 0.25 per hidden entry, which is a guess at the fraction
  of readers who need one of them. If a projection wanted to game this model it would fold more,
  and three of the four cases where the drawing currently wins are folds. The `chips` and
  `hidden` census columns are published for exactly this reason: a total that falls while `hidden`
  rises is not an improvement.
- **Colour, contrast and typography.** All eleven families are one weight here. A drawing whose
  hues do not separate for a reader without colour vision scores identically to one that does.
  That is `check_editor_scale.rb` and the WCAG work's territory, not this file's.

## 10. The term with the least evidence behind it

**The repetition relief**, `-0.5 x redundancy x labelled objects`.

Everything else in the model prices one object or one event and can be argued about a fixation at
a time. This one is a proportional discount on a whole plane, derived from an entropy that
compares an object's full label string against every other object's. Two things about it are
shaky: the 0.5 cap, which says a reader saves exactly half a labelled object by finding it
predictable and is a straight guess; and the choice of `log2(n)` as the reference entropy, which
makes redundancy depend on how many objects there are, so the same visual repetition scores
differently on a big canvas and a small one.

It is load-bearing in exactly one place, and a big one: `deep30` gets a 40.3 fixation discount on
a 224 fixation drawing, an 18% cut, because thirty identical `Round To` cards are genuinely
thirty of the same thing. If the relief is wrong, `deep30`'s ratio of 1.15 is wrong by a lot.

**What would settle it:** a reading test. Two canvases with the same object count, one where
every label is distinct and one where they are all the same word, timed to the same
comprehension question. The ratio of those two times is the relief, measured instead of assumed.
Failing that, the cheaper experiment is internal: the projection already folds a repeated run
into a chip past 24 arms, so the same drawing exists in both forms at the boundary. Timing a
reader on `[1..24]` against `[1..25]` would put a number on how much a fold and a repeat are
each worth, and both terms could then be set from one measurement.
