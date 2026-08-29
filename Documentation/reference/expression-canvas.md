# The expression canvas

A formula is a tree. A workflow is a sequence. They are two different questions about the same
file, and this surface answers the second one.

The workflow canvas (`EditorLogic.dsx`, projected by `cfg.ts` + `nodeflow.ts`) draws WHAT RUNS
NEXT, top to bottom, with a start and an end. The expression canvas (`EditorExpression.dsx`,
projected by `expr.ts` + `exprflow.ts`) draws WHERE A VALUE COMES FROM, left to right, ending in
one **terminus**. A formula has exactly one thing it returns, so the drawing has exactly one
place it ends, and that is the difference the two shapes are built around.

They are one product: an argument row on a workflow card IS a formula, so tapping **Diagram** in
the row editor opens this surface on that row's byte span, and closing it lands back on the step.
There is no second identity to keep in step - the coordinate is the span, both ways.

---

## 1. The reader

`packages/cli/src/expr.ts` is the third reader of JSE in this repo, and it exists because the
other two cannot answer the question a drawing asks.

| reader | produces | can it say which bytes an operand occupies? |
|---|---|---|
| `jse/jse.ts`, the evaluator | values | no - it throws positions away as it runs |
| `jse/highlight.ts`, the scanner | spans | no - it flattens structure |
| `cli/src/expr.ts`, this one | a tree WITH spans | yes |

It mirrors the evaluator's grammar exactly: the same precedence ladder, the same dotted-ident
rule, the same higher-order arms, the same regex-vs-division rule (imported from the highlighter
rather than re-implemented), and the same dispatch sets (`higherOrderFns` and `methodFns`,
exported from `jse/dispatch.ts` so there is one list rather than three copies of it).

Two properties hold on any input:

- **Total.** A form it cannot name becomes an `unknown` node holding its own bytes, the same
  discipline Custom Code keeps in the statement projection. A drawing is always possible.
- **The write contract.** Every child's span is contained in its parent's, siblings are disjoint
  and in source order, and the root covers the whole range. `exprInvariants(root)` checks all
  three. A splice inside one node therefore cannot disturb another.

`exact` says whether the tree is authoritative enough to write structurally through. It is false
when the parser met a form it could not name, or when the tokens did not all get consumed.

### Entities, and the two rules

An expression in a `.dsx` body lives inside markup, so the FILE holds `x =&gt; y` where the
LANGUAGE has `x => y`. The parser decodes first, parses the language, and translates every span
back onto the file's own bytes before handing the tree out: `node.text` and `row.text` read as
the language, `node.span` and `row.span` address the file, and `reconstructExpr(flow)` returns
the file's bytes unchanged.

WHICH decode depends on where the body lives, and the two answers are not the same one.

| body | who decodes it | the rule |
|---|---|---|
| a code tag (`<action>`, `<formula>`, a computed `<variable>`) | the EVALUATOR, at run time | three entities (`&amp;` `&lt;` `&gt;`), and only OUTSIDE quoted, template and regex spans |
| an attribute (`on:tap="…"`) | the XML READER, before the evaluator sees it | all five, plus the numeric forms, everywhere - inside literals too |

So `'a &amp;amp; b'` in a code tag is a nine-character string at runtime, and a drawing that
showed `a & b` would be describing a program nobody is running. `projectExpr(source, span,
context)` takes the context; `logicBodies` has always known which a body is.

The write door runs the same rule backwards: it encodes per context, keeps the author's own
quote character, and refuses to touch the file when a row hands back the value it was given -
compared on the LITERAL's inner text, so an escape sequence survives a no-op too.

---

## 2. The drawing

`packages/cli/src/exprflow.ts` turns the tree into placed boxes.

### The spine

A node's OUTPUT socket sits on its first row's line, not on the card's centre. A composition
chain (`text.trim().toLowerCase()`) therefore draws as one straight horizontal rule with cards
threaded on it, which is what the shape actually is. Centring the output would bend every link in
the commonest thing an author writes.

### Bands, not a grid

Layout is a post-order pass. Every subtree gets a contiguous vertical BAND; sibling bands stack;
a parent sits inside the band of its own subtree, pulled to its first child's out-line and
clamped to the band. Two nodes can only collide if they share a column, and two nodes in one
column are either the same node or in disjoint bands - so zero overlap is a property of the
construction, not of a repair pass afterwards.

### What deserves a box

This is the section the rest of the drawing hangs off, and it is a measurement rather than a
taste. Over the 6294 expressions this repo's own `.dsx` files contain - every `{{ }}`
interpolation, every condition attribute, every argument row of every statement body - the
drawing used to spend **4.11 visual objects per atom**, where an object is a card, a row, a
socket, a wire or a frame and an atom is an identifier path, a literal or an operator. And the
workload is not the grammar:

| | share of the real workload |
|---|---|
| a SINGLE atom (`dsx.attribute.icon`, 18 characters) | 61% |
| three atoms or fewer | 77% |
| no operator and no call at all | 65% |
| a higher-order call | 2.3% |
| maximum fan-in of one | 92% |

So the drawing was paying graph machinery for a path, and paying two cards, a row, three
sockets and a wire to say one word. Five rules answer that, and the number is **1.87 objects
per atom** with the median expression's drawing-over-text cost down from 5.11 to 1.35.

**1. THE RESULT IS NOT FREE.** A Result node says "and that is the answer", which on a drawing
with ONE producing card is already said by that card being the only card. It is drawn only from
TWO producers up, where the eye has somewhere to converge. Below that the terminus is a flag on
the last card (`node.terminus`), and a bare name is one editable chip: no graph, no wire. The
whole expression's RANGE travels with the flag, because that range is the handle a wrap writes
through and the root's own span is not it - `(a + b)` has a root spanning `a + b` and a range
spanning the parentheses, and a wrap that dropped them would rewrite a program nobody asked to
change.

**2. A LADDER OF ONE PRECEDENCE RUNG IS ONE CARD.** `a + b + c + d` parses left-nested, and
drawing the nesting draws a staircase: four terms become three cards, forty become thirty-nine.
It used to be a left spine of one operator drawn from five (`+ * && || ??`), because "`a - b -
c` means a, less b, less c and a bag of three unlabelled arms would read wrong". The arms are
not unlabelled: a run of ONE operator carries its own source text on the head wherever the
order is the answer (`a - b - c`) and a count where it is not (`3 values`), and a run of
SEVERAL operators of one rung names each arm by the operation that consumes it - `a - b + c -
d` is one card reading `0: a`, `Subtract: b`, `Add: c`, `Subtract: d`, which is the ladder a
person already reads. NEVER ACROSS A RUNG, and never through `**`: a flat row list is read as a
left fold, and read that way `a - b * c` and `2 ** 3 ** 2` both say the wrong number.

**3. A SMALL SUBTREE IS TEXT, NOT A CARD AND NOT NOTHING.** A subtree of at most four atoms
holding no lambda draws as its own SOURCE TEXT in the consumer's row (`row.inline`), with a
chevron that promotes it back to a card (`row.expandable`). Sweeping the threshold on the real
corpus gives 2.68 objects per atom at one atom, 2.58 at two, 2.25 at three, 2.09 at four and
1.99 at five; the curve knees at four, which is also the number of unrelated chunks a reader
holds at once, so a folded well is exactly one chunk. The text is WHOLE - a fold longer than 32
characters would ellipse, and a fold a reader has to open before they can trust it has cost a
gesture rather than saved one - and a fold never swallows a lambda or a read of a bound item,
because the pill, the wire out of it and the unread-pill signal are the whole of what makes a
loop comprehensible.

**4. ADJACENCY IS AN EDGE.** 74.8% of the wires in the real corpus were a straight line between
adjacent columns with fan-out one into fan-in one, which is zero bits at three objects each. So
the first wired operand of a card whose leading slot CARRIES the value - a receiver, a sole
argument, the head of a ladder - costs no row, no socket and no wire: the producer abuts the
consumer's left wall on the consumer's own out-line, and the seam is the edge (`node.abuts`). A
named role is never traded away: `Minimum`, `By`, `Then`, an object's key and a template's hole
are the information, and a card with a parameter row keeps its wire too, because a binding
approaches through the channel the abutting producer would be sitting in. The rows that survive
keep their TRUE source positions, so a ladder whose head abuts numbers its remaining arms 1, 2,
3 rather than lying about which arm is which to save one inference.

**5. EIGHT ROWS, NOT TWENTY-FOUR.** Reliable simultaneous-object capacity for a picture is
about four chunks and comfortable scanning tops out near nine; at 24 the heaviest drawing in
this repo was 633 objects across 233 rows. Past eight entries a card chips, and the QUIET rows
go first - a literal or a folded subtree hides only its own characters, while "which of these
thirty fields is COMPUTED" is the question the card exists to answer. Only when the computed
rows alone still overflow does the run's rule apply to them too: the first six and the last
stay, and the rest fold WITH THEIR SUBTREES, because a hidden row is only a hidden edge if the
edge is still there. A run folds by REPEATED KIND and says so (`33 more, all Multiply`, or
`23 more` on a mixed band, because naming one kind for three would be a lie); a collection says
`24 more, all typed in` or `23 more, 23 computed`. The span is untouched either way, the node
still owns every byte, and every kept row still splices exactly its own operand.

### Every position counts from zero, and only where position is the truth

Two n-ary nodes used to index from two bases: `a ?? b ?? c` numbered its arms 1, 2, 3 while
`[a, b, c]` numbered its entries 0, 1, 2, in the same editor in the same session. The list's
base is the language's - `rows[0]` is what an author types - so it is the base everywhere a
bare number names a row: the arms of a run, the entries of a list, the holes of a template and
the arguments of a call nobody has named.

A number is used only where POSITION IS THE WHOLE TRUTH. `Left`/`Right` on a `+` invents a role
neither operand has, and `This`/`That` on `>=` hid the one role anybody asks about, which is
which side is the minimum. So an operator that has roles names them and an operator that does
not numbers its operands:

| operator | sockets |
|---|---|
| `+` `*` `&&` `\|\|` `==` `!=` `===` `!==` `&` `\|` `^` | `0`, `1`, … - the position, in the one base |
| `-` `/` `%` | `From`, `By` |
| `**` | `Base`, `Power` |
| `<` `<=` `>` `>=` | `Value` and `Below` / `Maximum` / `Above` / `Minimum` |
| `??` | `Value`, `Fallback` |
| `in` | `Key`, `In` |
| `<<` `>>` `>>>` | `Value`, `By` |

Methods name their arguments the way `toFixed` names `Decimals`: every one of the 44 titled
methods does, minus the eleven that take no arguments at all, and the census is a test rather
than a habit. `Argument 1` is gone - a function nobody here has named has arguments that are
genuinely positions, and they are spelled the way every other position is. A template's holes
are named for the text that introduces them (`Total: ${n}` has a hole called Total, `${n}
items` one called Items) and fall back to `Part 0` only where the surrounding text is a space
and says nothing.

### Leaves stay in their row

A literal or a bare name is drawn IN the row that uses it, not as a card of its own. Drawing a
card for the number `2` is the failure mode every node editor has, and it is what makes a
four-term formula fill a screen. `a + 1` is ONE box: an Add carrying the terminus.

### A subexpression read twice is one card

Where the identical subexpression appears more than once at one depth in one scope, and it is
above the fold threshold, it is ONE card with N edges leaving it. It fires on five of the 6294
real expressions. It is implemented anyway, because it is the only thing a diagram expresses
that text structurally cannot: the text must spell the subexpression twice and hope the reader
notices they are the same value. The card carries the FIRST occurrence's span; every consuming
row still owns its own bytes, so no edit is lost to the sharing. It never crosses a shadowing
boundary - an inner `x` and an outer `x` make `f(x)` two different reads.

### The families

Colour is spent here and nowhere else, one crown per family, drawn from the nine `--badge-*`
hues the workflow canvas already measured against white ink. A reader who has learned one
surface has learned both.

| family | what it is | crown | glyph |
|---|---|---|---|
| `source` | a name read out of scope, a member, an index | amber | `arrow.right` |
| `value` | a literal the author typed | slate | `pencil.line` |
| `math` | arithmetic and the bitwise operators | green | `plus` |
| `compare` | a test that yields a boolean | violet | `chevron.up.chevron.down` |
| `logic` | and / or / not / or-else | violet | `checkmark.circle.fill` |
| `decision` | the ternary | violet | `arrowshape.turn.up.right.fill` |
| `call` | a function or a method | teal | `puzzlepiece.extension` |
| `text` | a template literal | teal | `note.text` |
| `collection` | an object or an array literal | blue | `rectangle.stack.fill` |
| `higher` | map / filter / reduce and the rest of the nineteen | pink | `arrow.clockwise` |
| `output` | the one fixed node | accent | `arrow.uturn.backward` |
| `unknown` | a form the reader could not name | dark slate | `scribble.variable` |

Higher-order is the LOOP hue on purpose: a map is a loop, and the workflow canvas draws loops in
that colour. Every glyph has a row in `OpenSource/Conformance/icons/sf-map.json` - no symbol was
invented for this surface.

### A template says its own order

`${n} items` and `items ${n}` used to draw identically: a `Build Text` head over one row called
`Items`, because the row's NAME was the only thing carrying the surrounding text and a name has
no position. Two different strings, one drawing. A template node therefore carries
`segments` - the literal runs and the holes IN SOURCE ORDER, each hole indexing the node's rows
- so the card can draw the template as the template rather than as a bag of holes with
captions.

### A higher-order call is a container

`map`, `filter`, `reduce` and the sixteen others do not take a function argument that happens to
be drawn small. They OPEN:

- the card's own lower half becomes the region: a real sub-canvas holding the body
- the lambda's parameters as pills on a rail at the region's leading edge, each showing the name
  the AUTHOR wrote plus what the container hands it ("each item", "the running total")
- every row of the body that reads a parameter is WIRED to its pill and shows an item chip, so
  `p.price` reads as `p` then `price` rather than as a value somebody typed
- the body's result lands on a socket at the region's right wall
- a `reduce` carries two pills and draws the accumulator's return as a wire running back along a
  reserved lane under the body: the one edge in a formula that runs right to left
- a pill nothing reads is drawn dashed, because a `map` whose body ignores its item is almost
  always a formula that has drifted

A TRIVIAL lambda folds instead: `rows.map(r => r.price)` draws one card with an `Each` row, since
opening a frame around a single leaf is ceremony. A BLOCK-bodied lambda (`r => { save(r) }`) is a
workflow, not a formula, so the frame holds one opaque card rather than pretending to draw it.

### One box per level, one nameplate its own size, one pill per name

Three things the container spent that it did not need, all measured on the rendered canvas:

**ONE BOX.** The region used to be a second box inset ten pixels inside the card, dashed and
washed in five per cent of the loop hue. Seven nested outlines stood between a reader and the
`Subtract` at the bottom of `regions.map(...).filter(...).map(...).reduce(...)` - card, region,
card, region, card, region, leaf - and each wash composited over the last, so down one x the
ground went (16,16,18) to (25,17,23) to (33,17,27) to (41,17,31): the deepest and most local
region was 2.8x the outermost's magenta, and attention intensity tracked nesting depth, which is
the inverse of importance. The region IS the card's lower half now. `frame.x` is the card's own
left wall, `frame.w` its own width, `frame.y + frame.h` its own floor, and the card's outline is
the region's outline on three sides. What the region draws for itself is one hairline along the
fourth - the top edge, between the container's operand rows and its body - at one strength at
every depth. Four levels read as four outlines, not as four brightnesses.

**THE NAMEPLATE IS ITS OWN CONTENT'S WIDTH.** A container's card is as wide as its BODY, so the
opaque ground behind its head and rows used to paint a band that wide: `Keep Where` at 597px with
its content ending 160px in, and `matrix`'s outer `Map Over` at 1996px (1090 on screen at that
fixture's fit zoom) with a title in the leftmost 90. A filled panel-coloured band that size with
one word in the corner is read as a page background rather than as a card's header. The plate
is `rowW` - the width the head and the row list are already measured to - so it ends where its
content ends, and the rest of the card's top is the region's own air.

**A PILL IS SIZED TO ITS NAME.** The floor was 56px and the measure was the proportional table,
though the pill's name is set in the mono face - so `p` drew a 55px capsule with one character
against its left edge, and `r`, `s` and `o` did it three times over in one drawing. The floor is
the tap target itself (24px square, `PILL_H`) and above it the pill is its own text in its own
face, centred. Pills are RIGHT-aligned in the rail, because the right edge is where every socket
sits and where every body wire leaves: that edge is a column, and a ragged left edge costs
nothing. A pill's outgoing wire - the binding, which is the thing that makes a loop
comprehensible - is drawn in the brightest neutral at 2px against the value edges' 1.5px
secondary. It used to be the same hairline in the same neutral as everything around it, which
made the most structural line on the canvas tied for the least visible.


### Collections

An object or an array is a card with one port per value: `{ id: 1, name: user.name }` has rows
`id` and `name`, each independently a literal or a wire. Past 24 entries the LITERAL rows fold
into one chip ("27 more, all typed in") and every wired row stays visible, because a hidden row
is a hidden edge and an edge arriving at nothing is worse than a long card.

### Layers, lanes, and the wire that came out the wrong side

Bottom to top: WIRES, then containers (deepest last), then plain cards. A wire that has to
cross a card passes behind it; the alternative is a line through a title, which is the first
thing a reader sees. A container's own box is transparent - the one opaque thing it paints is
the nameplate behind its head and rows - so a wire inside its region stays visible.

**A BINDING NEVER RUNS AT A ROW'S HEIGHT THROUGH ANOTHER CARD.** Turning in the rail's own
gutter and then running straight at the target row's height is the shortest reading when
nothing is in the way, and a catastrophe when something is: on `products.filter(p => p.price >=
min && p.inStock)` the wire from the `p` pill to the `And` card's second port ran behind the
opaque `Is At Least` card, and its visible left fragment terminated exactly on that card's
HOLLOW `Minimum` port. Both readings a viewer can form there are false, and the second one
breaks the canvas's own rule that an unfilled socket means nothing arrives. So a binding whose
straight run would cross a card drops into a reserved lane along the frame's FLOOR and comes up
into its target from below - the same lane discipline the reduce carry already proves reads
well - and the model tests that no binding's horizontal segment passes through a card.

**EDGES THAT SHARE A CORRIDOR GET A LANE EACH.** Six edges into one card used to share one x
for 550 pixels and draw as a single 2px stroke, so a six-way fan-in and a one-way wire were the
same picture. Each edge now owns a lane (`edge.lane`), assigned per corridor in the order the
edges leave, and the band layout already stacks sources in the order their rows are stacked, so
the lanes nest instead of crossing. A fan's WIDTH is its arity - which is precisely what the
text hides behind precedence, turned from a label into a shape.

Sockets belong to the CARD, not to the rows. And an edge says what it CARRIES (`edge.kind`:
`value`, `binding`, `carry`) so the socket glyph and the wire's weight are model-driven rather
than guessed from whether a `param` field happens to be set.

### Three channels for one fact

Whether a value is typed HERE or comes from somewhere else is carried three times over: the
well's recess, the ink's weight, and the socket's fill. Three, because one of them is a colour,
and a colour is the one thing a reader may not have. A linked row names its source
- `0 ← Multiply p0.price * p0.qty` - rather than saying "from the left", which is the one thing
the reader can already see.

And it names WHICH value arrives, not what kind it is. A title is a kind and a kind is shared:
`(a + b) + (c + d)` fed one node two rows that both read `Add`, so the drawing could not say
which value landed where - the one question a wire exists to answer. A title that collides
among a node's OWN incoming rows grows a tail: the sources' subtitles where those separate them
(`List 30 items` against `List 40 items`), otherwise the expression each one spells (`Add a +
b`). Only where it collides, because a tail on every reference is noise on the rows that were
never ambiguous, and never an id - `Add n7` is a name for the machine. Two rows keep one label
only when the same spelling feeds both, and then the label is not lying: either card hands over
the same value.

### Type is carried by the palette

A literal is drawn as ITSELF - a string keeps both its quotes. Its type is carried by the syntax
palette the diff plane and the code surface already use, not by a sigil in front of the value:
`#` read as a hash, `# 40` read as `0 40` at low zoom, and the sigil was the same ink weight as
the value it was labelling.

A value with NO INK OF ITS OWN is named in words instead. `{note: ''}` drew two grey apostrophes
right-aligned in an otherwise empty well, which is the picture an unfilled slot draws - and this
is a language tool, where the empty string is a value and an unset field is not the same
program. So the row carries `blank`, a word the well draws in the text face and the unset tone
in place of the value's characters: `empty text`, `1 space`, `3 spaces`, `nothing`. Every other
row leaves it absent. The card is measured for the word, not for the two characters it
replaces.

### The contract the surface reads

Everything above is carried on the model rather than inferred from geometry, because a surface
that infers "these two floats are equal, so those cards must be abutting" is a surface that
breaks the day a width changes.

| field | what it says |
|---|---|
| `node.terminus` | this card carries the Result cap. Exactly one per drawing, and its `span` and `text` are the WHOLE expression's |
| `node.ordinal` | source-order index of an ENTRY card, one nothing feeds, so the reader knows where to start. Absent wherever something arrives |
| `node.echo` | the raw token the title translates (`.toFixed`, `?.`, `[ ]`). Shown on hover, never in the head: it is the one fact a reader who knows the language does not need |
| `node.crumbs` | container ancestry, outermost first, for a breadcrumb rail. Absent at depth 0 |
| `node.segments` | a template's runs and holes IN SOURCE ORDER; `hole` indexes this node's rows |
| `node.abuts` | `{ to, slot }` - this card touches that one's left wall, and the seam is the edge |
| `row.inline` | a folded operand's own source text, whole, drawn in the well |
| `row.expandable` | a chevron promotes that operand to a real card |
| `edge.lane` | which lane of its corridor, so a fan reads as a ribbon whose width is its arity |
| `edge.kind` | `value`, `binding` or `carry`, so the socket glyph is model-driven |

### Eager, and drawn that way

JSE has no short-circuit. `&&`, `||`, `??` and `? :` evaluate both arms on all three runtimes
(`jse.ts` `$.or2`/`$.and2`/`$.nsh`/`$.tern` and their Kotlin and Swift twins). So no operand edge
is drawn cold and no gate notch appears on a logical node: every wire into a node is live. The
one genuine skip in the language is `f?.()`, which skips its arguments unevaluated, and that is a
call - the card says so rather than dimming anything.

---

## 3. Writing

Every visual edit is a splice, and it goes through the workflow editor's own door.

```
POST /edit/api/flowedit/<document>
{ body: "<body id>", rev: "<the revision the drawing was made from>",
  op: { kind: "replace", span: { start, end }, text: "<decoded text>" } }
```

That endpoint refuses a stale revision, refuses a body whose statement projection is not
byte-exact, splices, re-parses the WHOLE document, and only then writes. There is deliberately no
second write path here: an expression edit is a replace over a body-relative span, which is a
flow op, so it inherits every refusal the workflow editor already has.

Reading is `GET /edit/api/expr/<document>?body=<id>&at=<byte>&to=<byte>`, which answers the
graph plus `writable`, `rev`, the names in scope at that byte, and the wrap catalog.

`applyExprEdit` in `exprflow.ts` is the same four operations expressed locally, for tests and for
any consumer that owns its own text: `literal` (retype in place, spelled back through the row's
mode), `replace`, `wrap` (a template whose `$` is where the old text lands), and `unwrap`.

The catalog is a list of WRAPS rather than a list of nodes, because a formula has no free-floating
nodes: `Add` on `total` writes `total + 0` and nothing else.

---

## 4. What is checked, and where

| gate | what it holds |
|---|---|
| `packages/cli/test/exprflow.test.ts` | 93 laws over a 305-form corpus: totality, the write contract, no overlap, extents, socket landing, the spine, splices round-tripping, the families, entity round-trip, the folds, one index base, a socket name per role, a label that identifies its source, the named blank, the font-safe vocabulary, a 1555-node stress, and the five cost rules - the terminus, the ladder, the text fold, the abutment and the lanes - plus a HARDCODED CENSUS of what the workload costs to look at |
| `packages/cli/test/expr-corpus.ts` | two lists. `GRAMMAR` is every FORM, ordered by the precedence ladder, which is what a parser has to be total over. `WORKLOAD` is what people in this repo actually write, weighted to the measured distribution - and the two are not the same shape at all: the grammar list is one-in-seven higher-order against a real 2.3%, so a cost tuned against it is a cost tuned against a workload nobody has. Cost laws are measured on `WORKLOAD` |
| `packages/cli/src/legibility.ts` | the cost model proper: text cost in fixations against drawing cost in fixations, with a recorded per-fixture baseline |
| `dist/expr/canvas.ts` | the browser oracle: 18 fixtures through the REAL Studio, measuring overlap, clipped labels, ink outside its card, ink COVERED by an opaque sibling, a socket off its wall, a wire whose ink reaches no socket, stale workflow panels, socket size in world units, degenerate wires and canvas backing stores |
| `dist/expr/fuzz.ts` + `gram.ts` + `cases.ts` | 200000 byte-soup inputs, 200000 well-formed nested expressions, 201 targeted cases, and a differential lex against the runner's own tokenizer |
| `ClosedSource/scripts/check_editor_scale.rb` | the four scales, over the sheet and the markup |
| `ClosedSource/scripts/lint_dsx.rb` / `lint_dsx_css.rb` | the markup and the sheet |

The oracle measures in WORLD units, not device pixels: an 8px socket at 30% zoom is 2.4 device
pixels and is still an 8px socket. Scoping matters too - the workflow canvas stays mounted
underneath the overlay with a world and a zoom of its own, and a document-wide query reports the
wrong canvas as blurry.

---

## 5. Known limits

- A lambda with a BLOCK body is one opaque card. The statement projection owns that shape; a
  future pass can open the workflow canvas inside the frame rather than beside it.
- The parser guards its own stack at 200 frames. Past that the expression is still drawn - as one
  card holding its own bytes - and `exact` goes false, which refuses a structural write.
- There is no semantic zoom. The surface fits BOTH axes with a floor at 55%, below which the
  drawing scrolls rather than shrinking past legibility - but a graph wider than the pane at the
  floor opens on its left edge, so the Result is off screen until the reader pans. `<Flow>` does
  not expose its zoom to a slotted consumer, so the surface cannot yet drop detail as it shrinks.
- Nothing shows an EVALUATED value. The Result names what feeds it and nothing more; a formula
  editor of this class should show the data flowing through, and the sample-value plane it would
  read from is not wired to this surface yet.
- A folded run's hidden arms cannot be reached from the drawing: the chip says how many went
  and what they were, and editing one of them means opening the text. The collection chip has
  the same property, and the same answer - the alternative is 490 pixels of a row that reads
  the same thing forty times. Everything else that folds IS reachable: a subtree drawn as text
  shows its own whole source and one chevron promotes it back to a card.
- The floor of the cost measure is about two objects per card and per row, because every row
  carries a socket whether anything arrives there or not - the port's fill is one of the three
  redundant channels that say linked-versus-typed, and a colour is the one channel a reader may
  not have. The measured 1.87 is close to that floor; going below it means the SURFACE deciding
  not to ink a socket that nothing can land on, which is a rendering decision and not a model
  one. The terminus's own output socket is the clearest case: it attaches to nothing, and not
  drawing it is 17% of the remaining ink.
- The projection spells itself in ASCII plus one ellipsis, and a test holds it there. That is
  narrower than the sheet's fonts really are; it is where the line sits until something wants a
  mark badly enough to measure the cmap for it, which is how U+25AB got in and drew a tofu box
  in `Build Text`'s subtitle on every template with a hole in it.

---

## 6. Safety: what the door will not write

This is the one surface in the Studio that writes an author's program from a picture, so the
question it has to answer is not whether the drawing is right but whether any sequence of
gestures on it can leave the file saying something the author did not write. The harness is
`packages/cli/test/expr-edit-safety.test.ts`; it is seeded (`DSX_SAFETY_SEED`), it prints the
seed and a pasteable repro for every failure, and one run generates over 200,000 edits across
the 194-form corpus, both entity regimes, and 24-step edit chains.

### The four gates

A splice reaches a file only through `refuseUnsafeSplice` in `edit.ts`. Each gate is a way a
visual editor has actually corrupted a file, not a hypothetical.

| gate | what it refuses |
|---|---|
| faithful encoding | text the regime's encoder cannot carry in and back out again - an entity inside a string literal that would be escaped a second time on the way in |
| the operand rule | a `replace` over a span that is neither a whole statement nor a comment must hold a complete expression before AND after: a lone `)`, an unclosed quote, an empty replacement, a `//` comment, two idents in a row |
| the seam law | any splice whose new text changes the TOKENS on either side of it - writing `0` over the receiver of `rows[0].items` gives `0.items`, which touches no byte outside the span and still destroys two tokens |
| the enclosing formula | a splice that is locally perfect and breaks the expression around it - `{ id }` is one span that is both a key and a value, so writing any other expression over it produces an object with no key |

The last gate needs a range nothing local can derive, so **the canvas names the range it drew**:

```
POST /edit/api/flowedit/<document>
{ body, rev, op, within: { start, end } }
```

`within` is the `at`/`to` the drawing was fetched for. It is optional - the statement canvas has
no such range - and when it is missing the server derives what it can from the enclosing
statement, which is strictly less. A surface that omits it is not refused; it is less protected.

### The laws the harness proves

1. **A splice touches only the bytes it names.** Everything before `span.start` and everything
   after the edit's end is byte-identical, for all four operations, on every form and in every
   regime, and along 24-step chains where the spans move under each other.
2. **Meaning is preserved where the edit means to preserve it.** A wrap and its own unwrap
   return the author's exact bytes; a row handed back its own value does not touch the file; a
   replace with the text already there is a no-op.
3. **Both regimes carry the author's characters.** Literals holding `&`, `<`, `>`, a quote, a
   numeric entity, a backslash escape, an astral character, and the exact text `&lt;` written
   by the author survive a round trip through the door and back through the XML reader, under
   the code-tag rule and the attribute rule alike.
4. **Nothing a client can send produces an unreadable document.** Hostile text is refused, or
   what it leaves still parses exactly and still tiles.
5. **`writable: false` is enforced, not advertised.** A drawing that is not byte-exact reports
   `writable: false`, and a client that ignores the flag is still refused by the server.
6. **A stale revision is refused, never applied to shifted bytes.**
7. **Every degraded read is a described refusal.** An inverted range, an out-of-range offset, an
   unreadable offset, an unknown body, an unknown document and a half-written file each answer a
   reason and a message - never a 500, never a graph of the wrong bytes.

`writable` on `GET /edit/api/expr` is `body.span !== undefined && statements.exact && flow.exact`:
a drawing that cannot reproduce its own bytes is a second source of truth, and the door will not
write through one. The endpoint also projects under the BODY's own entity regime - an `on:tap`
handler is an attribute body and is decoded by the XML reader before the evaluator sees it, so
drawing one under the code-tag rule shows the transport instead of the language and every value
that drawing hands out is wrong.

### What is known-broken

`applyExprEdit` is a splice primitive, not a boundary: it writes what it is told, and it is the
gate above that decides whether a splice may happen. Four defects in the projection's own halves
are recorded with failing cases in the safety handoff - a code-tag encoder that is not the
inverse of its decoder, a row value that leaves as source and returns as characters, a wrap that
does not parenthesise, and a row that can advertise a value its file does not hold. Each one is
quarantined in the harness by a computed predicate rather than a list, so the guard goes dead on
its own when the defect is fixed.
