//
//  exprflow.ts - ONE JSE EXPRESSION, drawn left to right.
//
//  The statement projection (cfg.ts / nodeflow.ts) answers "what runs next" and draws it top
//  to bottom. This answers "where does this value come from" and draws it the other way, and
//  the two are orthogonal on purpose: a workflow is a sequence, a formula is a tree, and one
//  of those has a fixed end. So the OUTPUT is a node, always present, always rightmost, and
//  everything else flows into it.
//
//  THE SPINE. An operand row's socket and a node's own output socket sit on the SAME line -
//  row 0's line, not the card's centre. A composition chain (`rows.filter(f).map(m).join(s)`)
//  therefore draws as one straight horizontal rule with cards threaded on it, which is what
//  the shape actually is. Centring the output would bend every link in the commonest form an
//  author writes.
//
//  BANDS, NOT A GRID. Layout is a post-order pass that gives every subtree a contiguous
//  vertical BAND and stacks sibling bands. A parent sits in the band of its own subtree,
//  pulled to its first child's out-line and clamped to the band. Two nodes can only collide
//  if they share a column, and two nodes in one column are either the same node or in
//  disjoint bands - so zero overlap is a property of the construction, not of a repair pass.
//
//  A HIGHER-ORDER CALL IS A CONTAINER, like a loop in the statement view. `map` does not take
//  a function argument that happens to be drawn small: it OPENS, its parameter becomes a pill
//  you can wire from, and the body is a real sub-canvas inside the frame. `reduce` opens with
//  two pills and draws the accumulator's carry as a dashed edge back into its own frame,
//  because that is the one edge in a formula that runs against the flow.
//
//  AND THE CONTAINER IS ONE BOX. The region used to be a second box inset inside the card -
//  card wall, 10px, dashed region wall, 12px, body - so `matrix` spent SEVEN nested outlines
//  reaching one subtraction, and each level's translucent wash composited over the last
//  (measured at one x: ground 16,16,18 -> 25,17,23 -> 33,17,27 -> 41,17,31, so the deepest
//  and most local region was 2.8x the outermost's magenta and attention tracked nesting
//  depth, the inverse of importance). The region IS the card's lower half now: `frame.x` is
//  the card's own left wall, `frame.w` its own width, and the card's outline is the region's
//  outline. Depth reads from the nesting of single outlines, at one intensity, because there
//  is nothing left to accumulate. What the region still says for itself is a hairline along
//  its top edge and the eyebrow that names the binding.
//
//  EAGER, AND DRAWN THAT WAY. JSE has no short-circuit: `&&`, `||`, `??` and `?:` evaluate
//  both arms on all three runtimes. So no operand edge is drawn cold and no gate notch is
//  drawn on a logical node - the honest picture is that every wire into a node is live. The
//  one real skip in the language is `?.()`, which is a call, and the call node says so.
//
//  ── AND THE DRAWING HAS TO COST LESS THAN THE TEXT ──────────────────────────────────
//
//  Measured over the 6294 expressions this repo's own `.dsx` files actually contain (every
//  `{{ }}` interpolation, every condition attribute, every argument row of every statement
//  body): the drawing spent 4.11 visual objects per atom, where an object is a card, a row, a
//  socket, a wire or a frame, and an atom is an identifier path, a literal or an operator.
//  Sixty per cent of that workload is a SINGLE ATOM - `dsx.attribute.icon`, eighteen
//  characters - and the median drawing spent seven objects saying it. Two per cent contain a
//  higher-order call, and the frame machinery was paid unconditionally. Ninety-two per cent
//  have a maximum fan-in of one: what was drawn as a graph is a path.
//
//  Five decisions follow, and each of them is a decision about WHAT DESERVES A BOX:
//
//  1. THE RESULT IS NOT FREE. A card exists to say where a value comes from; a Result node
//     with one wire into it says only "and that is the answer", which the rightmost card
//     already says by being rightmost. So the Result is drawn only where the drawing has TWO
//     OR MORE producing cards and the eye needs a place to converge. Otherwise the terminus
//     is a flag on the last card (`terminus`), and a bare name is ONE chip.
//  2. A FOLD IS TEXT, NOT NOTHING. A subtree of at most FOLD_ATOMS atoms with no lambda in it
//     is drawn as its own SOURCE TEXT in the consumer's row (`inline`), with a chevron that
//     promotes it back to a card (`expandable`). Sweeping the threshold on the real corpus:
//     <=1 gives 2.68 objects per atom, <=2 2.58, <=3 2.25, <=4 2.09, <=5 1.99. The curve knees
//     at four, which is also the number of unrelated chunks a reader holds at once - so a
//     folded well is one chunk, and the reader who wants the box gets it in one gesture.
//  3. A LADDER OF EQUAL-PRECEDENCE OPERATORS IS ONE CARD. `a - b + c - d` was three cards and
//     is one, with a row per arm named by the operation that consumes it. Equal precedence and
//     a left spine, never across a precedence break: a flat row list under a mixed-precedence
//     head SAYS something, and what it says about `a - b * c` is false. The caption that would
//     have corrected it is a second read, which costs more than the card it saved.
//  4. ADJACENCY IS AN EDGE. The first wired operand of a card whose leading slot CARRIES the
//     value - a receiver, a sole argument, the head of a run - costs no row, no socket and no
//     wire: the producer abuts the consumer's left wall and the seam is the edge. That is the
//     74.8% of wires that were a straight line between adjacent columns with fan-out one into
//     fan-in one, which is zero bits. A named role (`Minimum`, `By`, `Then`) is never an
//     abutment, because the name is the information.
//  5. WHERE WIRES SHARE A CORRIDOR THEY GET LANES. Six edges into one card used to be one 2px
//     stroke 550px long. Each edge now owns a lane, so a fan's WIDTH is its arity - the one
//     thing the text hides behind precedence, turned from a label into a shape.
//

import {
  parseExpression, decodeRange, plainIndex, childrenOf,
  type BodyContext, type Expr, type Span, type Arg, HIGHER_ORDER,
} from "./expr.ts";
import { glyphWidth, titleCase, valueMode, modeSource, type ValueMode } from "./nodeflow.ts";

// ── metrics ──────────────────────────────────────────────────────────────────────────
//  The sheet's numbers, restated once. A card is measured before it is drawn, so the frame
//  that contains it can be sized before the browser lays anything out - the same contract the
//  statement projection's note strips keep.

const HEAD_H = 28;          // the title line - a rung of the control ladder
const ROW_H = 24;           // one operand row - the control ladder's lowest rung
const PAD_X = 10;
const PAD_B = 8;            // below the last row
const COL_GAP = 64;         // the channel between two columns
const ROW_GAP = 16;         // between two sibling bands
const NODE_MIN = 132;
const NODE_MAX = 320;
const PORT_R = 4;           // an 8px disc: a mark on the wall, not a target
const OUT_STUB = 10;        // the visible tail every output grows, wired or not
const FRAME_PAD = 12;       // a higher-order frame's inner margin
const FRAME_HEAD = 20;      // the "for each" strip above a frame's body
const RAIL_W = 84;          // the parameter rail inside a frame
const PILL_H = 24;
const PILL_GAP = 8;
const PILL_PAD = 8;         // the capsule's own padding, the sheet's number restated
const PILL_MIN = 24;        // a one-character pill is a 24x24 target, not a 56px word slot
const CARRY_LANE = 20;      // the channel a reduce's accumulator comes back along
const PARAM_LANE = 14;      // the floor channel a parameter wire comes back along
const RUN_HEAD = 6;         // arms a folded run keeps at its head, before the last one
const LABEL_W = 62;         // the row's name column
const VALUE_MIN = 52;
const LANE_GAP = 8;         // between two edges sharing one corridor

/** HOW MANY ROWS A CARD MAY SHOW BEFORE IT FOLDS. Reliable simultaneous-object capacity for
 *  a picture is about four chunks and comfortable scanning tops out around seven to nine, so
 *  a card that shows more rows than this is not being read, it is being scrolled. It was 24,
 *  and the heaviest drawing in the real corpus was 633 objects across 233 rows. A fold keeps
 *  RUN_HEAD arms and the last one - seven rows and a chip, which is eight lines. */
const ROW_CAP = 8;

/** THE FOLD THRESHOLD, in atoms. See the header: the objects-per-atom curve over the real
 *  corpus knees between three and four (2.25 -> 2.09 -> 1.99), and four is also the number of
 *  unrelated chunks a reader holds at once - so a folded well is exactly one chunk. Four, and
 *  not five, because five is where the curve has flattened and the well starts holding a
 *  sentence rather than a term. */
const FOLD_ATOMS = 4;

/** AND A FOLD NEVER ELLIPSES. The well's widest value at NODE_MAX is about 32 mono
 *  characters; a fold longer than that would draw a truncated source text, which is the one
 *  thing a fold may not do - the reader could not tell whether what is hidden matters. Past
 *  the cap the operand gets its card, however few atoms it has. */
const INLINE_MAX = 32;

/** 12px semibold Inter: the 11px table, scaled, with the weight's own small widening. */
function titleWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += glyphWidth(ch) * (12 / 11) * 1.03;
  return w;
}
/** 11px Inter, the table's own size. */
function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += glyphWidth(ch);
  return w;
}
/** 11px mono. The ghost skin measures 6.02 at 10px, so 11px is that times 1.1. */
const MONO_11 = 6.622;
function monoWidth(text: string): number { return [...text].length * MONO_11; }

// ── the model ────────────────────────────────────────────────────────────────────────

/** The visual FAMILY a node belongs to. Colour is spent here and nowhere else: one crown per
 *  family, the same nine hues the statement canvas already uses, so a reader who has learned
 *  one surface has learned both. `higher` is the loop hue on purpose - a map IS a loop. */
export type Species =
  | "source"      // a name read out of scope
  | "value"       // a literal the author typed
  | "math"        // arithmetic
  | "compare"     // a test that yields a boolean
  | "logic"       // and / or / not / coalesce
  | "decision"    // the ternary
  | "call"        // a function or a method
  | "collection"  // an object or an array literal
  | "higher"      // map / filter / reduce and the rest of the nineteen
  | "text"        // template literals and string joining
  | "output"      // the one fixed node
  | "unknown";    // a form the parser could not name - opaque, editable as text

export type ExprKind =
  | "ref" | "literal" | "unary" | "binary" | "ternary" | "call" | "method"
  | "member" | "index" | "array" | "object" | "template" | "lambda" | "output" | "unknown";

/** One operand of a node: either a literal the author typed HERE, or a socket another node
 *  feeds. Both states are reported, always, on three redundant channels - the well's
 *  recess, the ink's weight, and the port's fill - because one channel is a colour and a
 *  colour is the one thing a reader may not have. */
export type ExprRow = {
  /** The slot's human name: "Left", "Right", "Items", "Seed", "If", "0", "id". */
  name: string;
  /** The literal's text, unwrapped for editing. Empty when the row holds no literal of its
   *  own - wired, or folded (see `inline`). */
  value: string;
  /** The row's source text exactly as written - what the editor opens with. */
  text: string;
  /** Byte range this row edits. A splice here disturbs no other row. */
  span: Span;
  mode: ValueMode;
  /** True when another node feeds this row. */
  wired: boolean;
  /** The node id on the other end, when wired. */
  from?: string;
  /** WHICH VALUE ARRIVES, not what kind it is. The label a reader follows the wire with:
   *  the source's title on its own where that title is unique among this node's incoming
   *  rows, and the title plus what separates it - a subtitle, else the expression it spells
   *  - where it is not. `(a + b) + (c + d)` used to feed one node two rows both reading
   *  `Add`, which is a drawing that cannot say which value lands where. Two rows keep one
   *  label only when the same spelling feeds both, and then the label is not lying. */
  fromTitle?: string;
  /** A VALUE WITH NO INK OF ITS OWN, NAMED. `{note: ''}` and `join('')` drew two grey
   *  apostrophes into an otherwise empty well, which is the same picture a slot nobody
   *  filled draws - and in a language tool the empty string and the unset field are two
   *  different programs. So the row names the case and THE RENDERER DRAWS THIS WORD in the
   *  well, in its own muted tone, in place of the value's characters: `empty text` for
   *  `''`, `1 space` / `n spaces` for a literal that is nothing but spaces, `nothing` for a
   *  row carrying no value at all. Absent on every row whose value draws ink, which is
   *  nearly all of them - the word is a repair for the cases where showing the value shows
   *  the reader nothing. */
  blank?: string;
  /** A row can be fed a THIRD way: by the item a container hands it. `p.price` inside a
   *  `filter` is neither a literal the author typed nor the output of a card - it is a read
   *  of the parameter pill, and drawing it as a typed value would hide the one edge the
   *  frame exists to show. This names the pill; `value` still holds the path. */
  param?: string;
  /** The path read off that parameter, when it is not the whole pill: `price` in `p.price`. */
  reach?: string;
  /** The parameter's NAME, whenever this row reads one - whether the pill is drawn (a frame)
   *  or not (a folded container). The chip shows this and the well shows `reach`, so the row
   *  reads "line ▸ price" rather than making a person hold the arrow's other end in mind. */
  item?: string;
  /** A SUBTREE DRAWN AS ITS OWN SOURCE TEXT, in the well, instead of as a card. `p.price *
   *  1.2` is three atoms and one card and one wire and two rows to say what eleven characters
   *  say; the fold spends the eleven characters. The text is the operand's FULL source, never
   *  an abbreviation - a fold that hid anything would be a fold a reader has to open to
   *  trust, and then the fold has cost them a gesture instead of saving one. Absent on a row
   *  holding a plain literal: that value is already in `value`, and there is nothing folded. */
  inline?: string;
  /** A chevron promotes this operand to a real card. Set exactly where `inline` is: the fold
   *  is computationally complete only if one gesture undoes it. */
  expandable?: boolean;
  /** The socket, in flow coordinates. Present whether wired or not: an author must be able
   *  to see where a wire WOULD land before there is one. */
  portX: number;
  portY: number;
};

export type ExprParam = {
  /** The name the AUTHOR wrote. Renaming it here to "Item" would make the body, which still
   *  says `p`, read as if it referred to something else. */
  name: string;
  /** What the container hands it: "each item", "the running total", "the position". */
  role: string;
  /** Wired to at least one row inside the frame. A pill nothing reads is a real signal. */
  used: boolean;
  id: string;
  span: Span;
  /** The accumulator of a `reduce`: its carry edge runs backwards. */
  carry: boolean;
  x: number; y: number; w: number; h: number;
  /** The pill's own output socket - the body wires FROM here. */
  outX: number; outY: number;
};

export type ExprNode = {
  id: string;
  kind: ExprKind;
  species: Species;
  /** Human language: "Multiply", "Is Equal To", "Map Over", "Read Value". */
  title: string;
  /** The specific thing: the path, the operator, the method name. */
  subtitle: string;
  /** An SF Symbol name from OpenSource/Conformance/icons/sf-map.json. */
  glyph: string;
  rows: ExprRow[];
  span: Span;
  /** The node's own source, entities resolved. What a wrap template's `$` is replaced with,
   *  and what the write door re-encodes on the way back into the file. */
  text: string;
  x: number; y: number; w: number; h: number;
  /** The output socket. On row 0's line when the node has rows, else on the card's centre. */
  outX: number; outY: number;
  /** Nesting depth inside higher-order frames. 0 is the outer canvas. */
  depth: number;
  /** How wide the head and the argument rows want to be. On a plain card this is the card's
   *  own width; on a CONTAINER the card is as wide as its frame, and stretching a two-word
   *  value across a 1000px well is how a drawing stops being readable. */
  rowW: number;
  /** Higher-order only: the sub-canvas the body draws in. */
  /** The frame's eyebrow, in three parts so the renderer can uppercase the WORDS and leave
   *  the author's parameter names in their own case. `p` and `P` are two different names in
   *  a case-sensitive language, and a text-transform makes them one. */
  frame?: { x: number; y: number; w: number; h: number; lead: string; item: string; carry: string };
  /** Higher-order only: the parameter pills in the frame's rail. */
  params?: ExprParam[];
  /** Higher-order only: where the body's result lands on the frame's right wall. */
  resultX?: number;
  resultY?: number;
  /** The node whose value the frame returns. */
  resultFrom?: string;
  /** A collection past ROW_CAP draws its literal entries as one chip and keeps every wired
   *  row visible: hiding a wired row would hide an edge. */
  chip?: string;
  /** True where a lambda was trivial enough to fold into its caller's row instead of a frame. */
  folded?: boolean;
  /** THIS CARD CARRIES THE RESULT CAP. Exactly one node in a drawing has it. Where the drawing
   *  has two or more producing cards it is the Result node; where it has one it is that card,
   *  and where the whole expression is a leaf it is the one chip the canvas draws. The
   *  terminus node's `span` and `text` are the WHOLE expression's - that is the handle a wrap
   *  writes through, and the root's own span is not it (`(a + b)` has a root spanning `a + b`
   *  and a range spanning the parentheses). */
  terminus?: boolean;
  /** SOURCE-ORDER INDEX OF AN ENTRY CARD - a card nothing feeds, which is where a reader
   *  starts. Absent on every card that has an incoming value, because those have a wire or an
   *  abutment telling them where they came from. */
  ordinal?: number;
  /** THE RAW TOKEN THE TITLE IS A TRANSLATION OF: `.toFixed`, `?.`, `[ ]`, `Math.round`. The
   *  surface shows it on hover, not in the head - it is the one fact a reader who already
   *  knows the language does not need, and it was competing with the head for the same line. */
  echo?: string;
  /** CONTAINER ANCESTRY, outermost first, for a breadcrumb rail: `["Map Over r", "Keep Where
   *  s"]`. A card three frames deep otherwise has to be located by tracing outlines. Absent at
   *  depth 0, which is most of the drawing. */
  crumbs?: string[];
  /** A TEMPLATE'S RUNS AND HOLES, IN SOURCE ORDER. `${n} items` and `items ${n}` drew
   *  identically - both a `Build Text` head over one row called `Items` - because the row NAME
   *  was the only thing carrying the surrounding text, and a name has no position. The
   *  segments are the ordering, so the card can draw the template as the template. `hole` is
   *  an index into `rows` restricted to this node's hole rows, in the same order. */
  segments?: { text?: string; hole?: number }[];
  /** THE CARD THIS ONE ABUTS, and the row index on it the abutment stands for. Set on the
   *  PRODUCER: its right wall touches the consumer's left wall and the seam is the edge, so
   *  there is no row on the consumer, no socket and no wire. The renderer needs the pair
   *  named rather than inferred from two floats being equal. */
  abuts?: { to: string; slot: string };
};

export type ExprEdge = {
  from: string;
  to: string;
  /** The row index on `to` this edge lands in; -1 for a frame result. */
  row: number;
  /** A reduce accumulator's carry: drawn dashed, and it runs right to left. */
  carry?: boolean;
  /** The pill this edge leaves, when it is a parameter read rather than a card's output. */
  param?: string;
  /** WHICH LANE OF ITS CORRIDOR. Six edges into one card used to share one x for 550px, so a
   *  six-way fan-in and a one-way wire drew the same stroke. Lanes are assigned per corridor
   *  in source order, so a fan reads as a ribbon whose WIDTH is its arity, and the band
   *  layout's ordering means the lanes nest instead of crossing. 0 when the edge is alone. */
  lane?: number;
  /** WHAT THE EDGE CARRIES, so the socket glyph is model-driven rather than guessed from
   *  whether `param` happens to be set: a value out of a card, a binding out of a parameter
   *  pill, or a reduce accumulator's carry running against the flow. */
  kind?: "value" | "binding" | "carry";
  points: [number, number][];
};

export type ExprFlow = {
  nodes: ExprNode[];
  edges: ExprEdge[];
  width: number;
  height: number;
  /** The expression as a person reads it: the file's bytes with the five XML entities
   *  resolved, since `a &lt; b` in the file is `a < b` in the language. */
  source: string;
  /** The same bytes, exactly as the file holds them. `reconstruct` returns this. */
  raw: string;
  /** Which entity rule those bytes follow. The write door needs the same one going back. */
  context: BodyContext;
  /** The span within the containing document this expression occupies. */
  span: Span;
  /** False when the parser met a form it could not name; the graph still draws, and the
   *  unknown node holds its own bytes, but a structural rewrite is refused. */
  exact: boolean;
  /** How many nodes the drawing has, against how many the tree has - the honest compaction
   *  number, the same one the statement view reports. */
  nodeCount: number;
};

// ── naming: an operator is a verb ────────────────────────────────────────────────────

/** PROTOTYPE-FREE, all of them. A bare object literal answers `toString`, `constructor`,
 *  `valueOf` and `hasOwnProperty` with inherited FUNCTIONS, and `??` does not reject a
 *  function - so `x.toString()`, a method JSE genuinely dispatches, crashed the projection
 *  the moment it tried to measure a function as a title. `Object.create(null)` is the whole
 *  fix, and it belongs on every table a NAME OUT OF THE SOURCE indexes. */
function table<T>(rows: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, rows);
}

const BINARY_TITLE: Record<string, string> = table({
  "+": "Add", "-": "Subtract", "*": "Multiply", "/": "Divide", "%": "Remainder",
  "**": "To The Power Of",
  "==": "Is Equal To", "!=": "Is Not Equal To", "===": "Is Equal To", "!==": "Is Not Equal To",
  "<": "Is Less Than", ">": "Is Greater Than", "<=": "Is At Most", ">=": "Is At Least",
  "&&": "And", "||": "Or", "??": "Or Else",
  "in": "Is A Key Of",
  "&": "Bitwise And", "|": "Bitwise Or", "^": "Bitwise Exclusive Or",
  "<<": "Shift Left", ">>": "Shift Right", ">>>": "Shift Right Unsigned",
});
const UNARY_TITLE: Record<string, string> = table({
  "!": "Not", "-": "Negate", "+": "To Number", "~": "Bitwise Not", "typeof": "Type Of",
});
const BINARY_SPECIES: Record<string, Species> = table({
  "+": "math", "-": "math", "*": "math", "/": "math", "%": "math", "**": "math",
  "==": "compare", "!=": "compare", "===": "compare", "!==": "compare",
  "<": "compare", ">": "compare", "<=": "compare", ">=": "compare", "in": "compare",
  "&&": "logic", "||": "logic", "??": "logic",
  "&": "math", "|": "math", "^": "math", "<<": "math", ">>": "math", ">>>": "math",
});
/** EVERY NODE CARRIES ITS OWN MARK. A shared family glyph made the drawing say the same
 *  thing twelve times: `Divide` and `Add` wore one `plus`, `Take A Slice` and `Round To`
 *  one puzzle piece, and the only thing separating them was a word. So the mark is the
 *  OPERATION, keyed here by the exact operator or method name, and the family survives in
 *  the tint behind it (`.expr-tile-<species>`) - two channels, two facts, neither of them
 *  ornament. `SPECIES_GLYPH` stays as the floor: a method nobody has named yet still gets
 *  its family's mark rather than a placeholder.
 *
 *  Every name resolves in OpenSource/Conformance/icons/sf-map.json; the `dsx.` prefixed ones
 *  are that file's Studio tier (see its `_studio_glyph_note`), and `exprflow.test.ts` fails
 *  the suite if any name here stops resolving. */
const SPECIES_GLYPH: Record<Species, string> = {
  source: "dsx.ref", value: "dsx.text", math: "plus",
  compare: "dsx.equal", logic: "dsx.and",
  decision: "dsx.choose",
  call: "puzzlepiece.extension", collection: "dsx.list", higher: "dsx.map",
  text: "dsx.buildtext", output: "dsx.result", unknown: "scribble.variable",
};

const BINARY_GLYPH: Record<string, string> = table({
  "+": "plus", "-": "minus", "*": "dsx.multiply", "/": "dsx.divide", "%": "dsx.percent",
  "**": "dsx.power",
  "==": "dsx.equal", "===": "dsx.equal", "!=": "dsx.notequal", "!==": "dsx.notequal",
  "<": "dsx.lessthan", ">": "dsx.greaterthan", "<=": "dsx.atmost", ">=": "dsx.atleast",
  "in": "dsx.iskeyof",
  "&&": "dsx.and", "||": "dsx.or", "??": "dsx.orelse",
  "&": "dsx.bitand", "|": "dsx.pipe", "^": "dsx.caret",
  "<<": "dsx.shiftleft", ">>": "dsx.shiftright", ">>>": "dsx.shiftrightu",
});
const UNARY_GLYPH: Record<string, string> = table({
  "!": "dsx.not", "-": "dsx.negate", "+": "dsx.tonumber", "~": "dsx.bitnot",
  "typeof": "dsx.typeof",
});
/** Keyed by what `valueMode` calls the text, plus the one kind it cannot see. */
const LITERAL_GLYPH: Record<string, string> = table({
  text: "dsx.text", number: "dsx.number", boolean: "dsx.switch",
  regex: "dsx.pattern", empty: "dsx.nothing", expression: "dsx.nothing",
  reference: "dsx.ref",
});
const HIGHER_GLYPH: Record<string, string> = table({
  map: "dsx.map", filter: "dsx.filter", reject: "dsx.reject", find: "dsx.find",
  findLast: "dsx.findlast", findIndex: "dsx.findindex", findLastIndex: "dsx.findlastindex",
  some: "dsx.some", every: "dsx.every", sortBy: "dsx.sortby", sort: "dsx.sort",
  toSorted: "dsx.sortcopy", sumBy: "dsx.sumby", reduce: "dsx.reduce",
  reduceRight: "dsx.reduceright", forEach: "dsx.foreach", flatMap: "dsx.flatmap",
  groupBy: "dsx.groupby", keyBy: "dsx.keyby",
});
const METHOD_GLYPH: Record<string, string> = table({
  toFixed: "dsx.roundto", toUpperCase: "dsx.uppercase", toLowerCase: "dsx.lowercase",
  trim: "dsx.trim", trimStart: "dsx.trimstart", trimEnd: "dsx.trimend",
  join: "dsx.join", split: "dsx.split", slice: "dsx.slice", concat: "dsx.joinon",
  includes: "dsx.contains", indexOf: "dsx.positionof", lastIndexOf: "dsx.lastpositionof",
  startsWith: "dsx.startswith", endsWith: "dsx.endswith", replace: "dsx.replacefirst",
  replaceAll: "dsx.replaceall", padStart: "dsx.padstart", padEnd: "dsx.padend",
  repeat: "dsx.repeat", substring: "dsx.takerange", charAt: "dsx.characterat",
  at: "dsx.itemat", flat: "dsx.flatten", reverse: "dsx.reverse",
  toReversed: "dsx.reversecopy", keys: "dsx.keysof", values: "dsx.valuesof",
  entries: "dsx.entriesof", toISOString: "dsx.isodate", toLocaleDateString: "dsx.localdate",
  toLocaleTimeString: "dsx.localtime", toLocaleString: "dsx.localtext",
  getTime: "dsx.timestamp", json: "dsx.readjson", text: "dsx.readtext",
  test: "dsx.matches", match: "dsx.match", matchAll: "dsx.matchall", format: "dsx.format",
  toString: "dsx.astext", fill: "dsx.fillwith", with: "dsx.replaceat",
  toSpliced: "dsx.splicecopy",
});
/** The shapes the language spells with punctuation rather than a name. */
const SHAPE_GLYPH: Record<string, string> = table({
  ref: "dsx.ref", member: "dsx.field", index: "dsx.itemat", ternary: "dsx.choose",
  array: "dsx.list", object: "dsx.record", template: "dsx.buildtext",
  lambda: "dsx.function", call: "puzzlepiece.extension", output: "dsx.result",
  unknown: "scribble.variable",
});

/** What a container hands each parameter, in the order the language passes them. The pill
 *  shows the AUTHOR's name and this underneath it, so the drawing explains the name rather
 *  than replacing it. */
const ROLES: Record<string, string[]> = table({
  reduce: ["the running total", "each item", "the position", "the whole list"],
  reduceRight: ["the running total", "each item", "the position", "the whole list"],
  sort: ["one item", "the next item"],
  toSorted: ["one item", "the next item"],
});
const ROLE_DEFAULT = ["each item", "the position", "the whole list"];

/** The methods a formula actually contains, spelled the way a person says them. Everything
 *  else falls through to Title Case, which is right far more often than it is wrong. */
const METHOD_TITLE: Record<string, string> = table({
  toFixed: "Round To", toUpperCase: "Upper Case", toLowerCase: "Lower Case",
  trim: "Trim", trimStart: "Trim Start", trimEnd: "Trim End",
  join: "Join", split: "Split", slice: "Take A Slice", concat: "Join On",
  includes: "Contains", indexOf: "Position Of", lastIndexOf: "Last Position Of",
  startsWith: "Starts With", endsWith: "Ends With", replace: "Replace First",
  replaceAll: "Replace All", padStart: "Pad At The Start", padEnd: "Pad At The End",
  repeat: "Repeat", substring: "Take A Range", charAt: "Character At",
  at: "Item At", flat: "Flatten", reverse: "Reverse", toReversed: "Reverse A Copy",
  keys: "Keys Of", values: "Values Of", entries: "Entries Of",
  toISOString: "As An ISO Date", toLocaleDateString: "As A Local Date",
  toLocaleTimeString: "As A Local Time", toLocaleString: "As Local Text",
  getTime: "Timestamp Of", json: "Read As JSON", text: "Read As Text",
  test: "Matches", match: "Match", matchAll: "Match All", format: "Format",
  toString: "As Text", fill: "Fill With", with: "Replace At", toSpliced: "Splice A Copy",
});

/** The nineteen, spelled the way a person says them. */
const HIGHER_TITLE: Record<string, string> = table({
  map: "Map Over", filter: "Keep Where", reject: "Drop Where", find: "Find First",
  findLast: "Find Last", findIndex: "Find Position", findLastIndex: "Find Last Position",
  some: "Any Match", every: "All Match", sortBy: "Sort By", sort: "Sort",
  toSorted: "Sort A Copy", sumBy: "Sum Of", reduce: "Fold Into", reduceRight: "Fold From The End",
  forEach: "For Each", flatMap: "Map And Flatten", groupBy: "Group By", keyBy: "Index By",
});

// ── the projection ───────────────────────────────────────────────────────────────────

type Built = {
  node: ExprNode;
  /** The children this node's rows are wired to, row index in order. */
  wired: { row: number; child: Built }[];
  /** Everything in this subtree, the node included. */
  all: Built[];
  /** Higher-order only: the body's own subtree root. */
  body?: Built;
  bandTop: number;
  bandBottom: number;
  /** RULE 4: the producer that abuts this card's leading edge. It owns no row here, no
   *  socket and no wire - it is laid out touching this card's left wall on this card's own
   *  out-line, and the seam is the edge. */
  abut?: Built;
  /** WHETHER THIS CARD'S LEADING SLOT MAY BE TRADED FOR AN ABUTMENT. True where the slot
   *  CARRIES the value and its name says nothing the adjacency does not - a receiver, a sole
   *  argument, the head of a ladder. False wherever the name is the information: `Minimum`,
   *  `By`, `Then`, an object's key, a template's hole. */
  carrier: boolean;
};

/** Everything one projection accumulates. Passed rather than threaded as four parameters,
 *  because the shared-subexpression memo and the breadcrumb stack both have to survive the
 *  whole walk and neither belongs to any one node. */
type Ctx = {
  nodes: ExprNode[];
  /** RULE 7: one card per distinct subexpression, keyed by depth, scope and source text. A
   *  subexpression read twice is the one thing a diagram expresses that text structurally
   *  cannot - the text must spell it twice and hope the reader notices. It fires on five of
   *  6294 real expressions, which is why it costs no layout machinery: the SECOND reader gets
   *  a wire and nothing else, and the card stays where its first reader put it. */
  shared: Map<string, Built>;
  /** Container ancestry at the point the walk has reached, outermost first. */
  crumbs: string[];
};

let seq = 0;
function nextId(): string { return "n" + (++seq); }

export function projectExpr(source: string, span?: Span, context: BodyContext = "text"): ExprFlow {
  const range = span ?? { start: 0, end: source.length };
  const parsed = parseExpression(source, range, context);
  // EVERYTHING BELOW WORKS IN DECODED COORDINATES. The tree, the row text, the node text and
  // every measurement read the language rather than the transport; `rawSpans` translates the
  // whole drawing onto the file's own bytes once, at the end, so a splice still addresses
  // the file and nothing in between has to remember which coordinate it is holding.
  const plain = parsed.plain;
  const text = (at: Span): string =>
    plain.slice(plainIndex(parsed.map, at.start), plainIndex(parsed.map, at.end));
  seq = 0;

  const nodes: ExprNode[] = [];
  const edges: ExprEdge[] = [];
  const ctx: Ctx = { nodes, shared: new Map(), crumbs: [] };
  const root = build(text, parsed.root, 0, ctx, NO_SCOPE);

  // A RESULT NODE IS ONLY WORTH DRAWING WHERE THE EYE HAS SOMEWHERE TO CONVERGE. It says "and
  // that is the answer", which on a drawing with ONE producing card is already said by that
  // card being the only card. Sixty per cent of the real corpus is a single atom, and on
  // those the Result was two thirds of the ink: two cards, a row, three sockets and a wire to
  // spell `dsx.attribute.icon`. So it is drawn from TWO producers up, and below that the
  // terminus is a flag the last card wears.
  //
  // The whole expression's range travels with the flag, because that range is the handle a
  // WRAP writes through and the root's own span is not it: `(a + b)` has a root spanning
  // `a + b` and a range spanning the parentheses, and a wrap that dropped them would rewrite
  // a program nobody asked to change.
  let layout: Built;
  if (nodes.length >= 2) {
    const out: ExprNode = {
      id: "out", kind: "output", species: "output", title: "Result",
      subtitle: "", glyph: SHAPE_GLYPH["output"]!,
      rows: [],
      span: { ...range }, text: plain, rowW: 0,
      x: 0, y: 0, w: 0, h: 0, outX: 0, outY: 0, depth: 0, terminus: true,
    };
    sizeNode(out);
    nodes.push(out);
    // The Result's one operand is its abutment: the root touches its left wall, and there is
    // no row, no socket and no wire between them (rule 4).
    root.node.abuts = { to: out.id, slot: "" };
    const outBuilt: Built = {
      node: out, wired: [], all: [], bandTop: 0, bandBottom: 0,
      abut: root, carrier: true,
    };
    outBuilt.all = [outBuilt, ...root.all];
    layout = outBuilt;
  } else {
    root.node.terminus = true;
    root.node.span = { ...range };
    root.node.text = plain;
    layout = root;
  }

  place(layout, 0, 0);
  // ONE WIDTH PER COLUMN. Cards are placed by their RIGHT edge so the output channel is
  // uniform; the cost was that a column of six cards of six widths had six different left
  // walls, and the input sockets - which hang on the left wall - staggered with them. A
  // column of open rings that does not line up reads as six mistakes.
  const columns = new Map<number, ExprNode[]>();
  for (const n of nodes) {
    const key = Math.round(n.x + n.w);
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key)!.push(n);
  }
  for (const [right, group] of columns) {
    if (group.length < 2) continue;
    const w = Math.max(...group.map((n) => n.w));
    for (const n of group) {
      if (n.frame) continue;      // a container's width is its frame's, not the column's
      n.w = w;
      n.x = right - w;
    }
  }
  // AND THE SEAMS ARE RE-STRUCK. The column pass moves a card's LEFT wall (it preserves the
  // right edge and widens leftward), so a producer that was touching that wall is no longer
  // touching it. The whole producing subtree slides with it - it can only slide LEFT, since a
  // widened card's left wall only ever moves left, and a subtree that moves away from its
  // consumer cannot collide with anything it did not already clear.
  snapAbutments(layout);
  markEntries(nodes);
  const bounds = normalise(nodes);
  const pills = new Map<string, PillRef>();
  for (const n of nodes) for (const p of n.params ?? []) pills.set(p.id, { owner: n.id, param: p });
  const byId = new Map(nodes.map((x) => [x.id, x] as const));
  for (const n of nodes) wireOne(n, byId, nodes, edges, pills);
  wireFrames(nodes, edges);
  laneEdges(edges);

  return {
    nodes, edges,
    width: bounds.w, height: bounds.h,
    source: plain,
    raw: source.slice(range.start, range.end),
    context,
    span: range,
    exact: parsed.exact,
    nodeCount: nodes.length,
  };
}

// ── building: one Expr node becomes one card, plus the rows it owns ──────────────────

/** Names a container has bound, mapped to the pill that hands them over. Layered, because a
 *  map inside a map can read either item and the inner one wins - the shadowing rule the
 *  runner applies. */
type Scope = ReadonlyMap<string, string>;
const NO_SCOPE: Scope = new Map();

/** `src` reads the DECODED text a span covers - never the file's raw bytes, so an
 *  expression inside markup reads as the language rather than as the transport. */
type Read = (at: Span) => string;

function build(src: Read, e: Expr, depth: number, ctx: Ctx, scope: Scope): Built {
  const node: ExprNode = {
    id: nextId(), kind: "unknown", species: "unknown", title: "", subtitle: "",
    glyph: "", rows: [], span: e.span, text: src(e.span), rowW: 0,
    x: 0, y: 0, w: 0, h: 0, outX: 0, outY: 0, depth,
  };
  if (ctx.crumbs.length) node.crumbs = [...ctx.crumbs];
  const wired: { row: number; child: Built }[] = [];
  const kids: Built[] = [];
  /** Cards this node reads that are OWNED BY SOMEONE ELSE (rule 7): wired, never placed from
   *  here, and named to `nameSources` only so a colliding label can still grow its tail. */
  const shares: ExprNode[] = [];
  /** Set by the cases below: whether row 0 may be traded for an abutment. See `Built.carrier`. */
  let carrier = false;

  /** ONE OPERAND, ONE OF THREE FATES.
   *
   *  A LEAF stays in the row as a value the author edits in place. Drawing a card for the
   *  number 2 is the failure mode every node editor has, and it is what makes a four-term
   *  formula fill a screen.
   *
   *  A SMALL SUBTREE stays in the row as its own SOURCE TEXT (rule 3). `p.price * 1.2` is a
   *  card, a wire, two rows and three sockets to say eleven characters; the eleven characters
   *  say it. This is a fold, never a hide - the well holds the operand's whole text, and one
   *  chevron promotes it back to a card.
   *
   *  ANYTHING LARGER gets its card - or, where the identical subexpression already has one at
   *  this depth and in this scope, a wire to THAT card (rule 7). */
  const operand = (name: string, child: Expr): void => {
    const row = node.rows.length;
    const text = src(child.span);
    if (inlineable(child)) {
      node.rows.push(leafRow(name, text, child.span, scope));
      return;
    }
    if (foldable(child, text, scope)) {
      node.rows.push(foldRow(name, text, child.span));
      return;
    }
    const key = depth + "\u0000" + scopeKey(scope) + "\u0000" + text;
    const held = ctx.shared.get(key);
    const built = held ?? build(src, child, depth, ctx, scope);
    node.rows.push({
      name, value: "", text, span: { ...child.span },
      mode: "expression", wired: true, from: built.node.id, fromTitle: built.node.title,
      portX: 0, portY: 0,
    });
    if (held) { shares.push(built.node); return; }
    ctx.shared.set(key, built);
    wired.push({ row, child: built });
    kids.push(built);
  };
  /** Whether an operand will draw an edge, asked before the row is built. */
  const wires = (child: Expr): boolean =>
    !inlineable(child) && !foldable(child, src(child.span), scope);

  switch (e.kind) {
    case "number": case "string": case "boolean": case "null": case "regex": {
      node.kind = "literal"; node.species = "value";
      const text = src(e.span);
      const mode = valueMode(text);
      node.title = mode === "text" ? "Text" : mode === "number" ? "Number"
        : mode === "boolean" ? "Switch" : e.kind === "regex" ? "Pattern" : "Nothing";
      node.subtitle = mode === "text" ? text.slice(1, -1) : text;
      node.glyph = (e.kind === "regex" ? LITERAL_GLYPH["regex"] : LITERAL_GLYPH[mode])
        ?? SPECIES_GLYPH.value;
      break;
    }
    case "ref": {
      node.kind = "ref"; node.species = "source";
      const parts = e.path.split(".");
      node.title = titleCase(parts[parts.length - 1]!);
      node.subtitle = e.path;
      node.glyph = SHAPE_GLYPH["ref"]!;
      break;
    }
    case "unary": {
      node.kind = "unary";
      node.species = e.op === "!" ? "logic" : e.op === "typeof" ? "call" : "math";
      node.title = UNARY_TITLE[e.op] ?? "Apply " + e.op;
      node.subtitle = UNARY_TITLE[e.op] === undefined ? e.op : "";
      node.glyph = UNARY_GLYPH[e.op] ?? SPECIES_GLYPH[node.species];
      node.echo = e.op;
      // A unary has one operand and the mark already says what happens to it, so the slot's
      // name carries nothing the adjacency does not.
      carrier = true;
      operand("Value", e.arg);
      break;
    }
    case "binary": {
      node.kind = "binary";
      node.species = BINARY_SPECIES[e.op] ?? "math";
      node.title = BINARY_TITLE[e.op] ?? e.op;
      // NO SUBTITLE. The operator used to be repeated in the corner of every arithmetic
      // card, and the reason was that the whole maths family shared one `plus` glyph, so
      // "Multiply" needed the `*` to say which arithmetic. The mark is the operator now, so
      // the corner said `*` beside a tile drawing an x beside the word Multiply: one fact,
      // three times. A method keeps its `.name` because that IS new information.
      node.subtitle = "";
      node.glyph = BINARY_GLYPH[e.op] ?? SPECIES_GLYPH[node.species];
      node.echo = e.op;
      // A LADDER OF ONE PRECEDENCE RUNG IS ONE CARD. `a + b + c + d` parses left-nested, and
      // drawing the nesting draws a staircase: four terms become three cards, forty become
      // thirty-nine, and the shape a person sees stops resembling the sum they wrote. It used
      // to be five operators; it is now any run of one RUNG, so `a - b + c - d` is one card
      // too, with each arm named by the operation that consumes it. Never across a rung: a
      // flat row list is read as a left fold, and read that way `a - b * c` says the wrong
      // number. The text is untouched either way - the ladder is a grouping in the DRAWING,
      // the rows stay in source order, and each row still splices its own operand's bytes.
      const arms = ladder(e);
      if (arms.length > 2) {
        const ops = new Set(arms.slice(1).map((x) => x.op!));
        const mixed = ops.size > 1;
        // A run of one associative operator is a BAG IN ORDER and a count is the whole truth.
        // Anything else - a mixed rung, or a run of `-` or `/` where the order is the answer -
        // puts its own source on the head, which is the only caption that cannot mislead.
        node.subtitle = !mixed && FLATTEN.has(e.op) ? arms.length + " values" : oneLine(node.text);
        carrier = true;
        armRows(arms, mixed);
        break;
      }
      const [a, b] = operandNames(e.op);
      // Positional operands have no role to lose, so the head of the pair may be an
      // abutment. `Minimum`, `By`, `Fallback` and the rest are the information, and a card
      // never trades one of those away for a saved socket.
      carrier = OPERAND_NAMES[e.op] === undefined;
      operand(a, arms[0]!.expr);
      operand(b, arms[1]!.expr);
      break;
    }
    case "ternary": {
      node.kind = "ternary"; node.species = "decision";
      node.title = "Choose"; node.subtitle = "";
      node.glyph = SHAPE_GLYPH["ternary"]!;
      operand("If", e.test);
      operand("Then", e.then);
      operand("Else", e.other);
      break;
    }
    case "member": {
      node.kind = "member"; node.species = "source";
      node.title = titleCase(e.name);
      node.subtitle = (e.optional ? "?." : ".") + e.name;
      node.echo = node.subtitle;
      node.glyph = SHAPE_GLYPH["member"]!;
      carrier = true;
      operand("Of", e.receiver);
      break;
    }
    case "index": {
      node.kind = "index"; node.species = "source";
      node.title = "Item At"; node.subtitle = e.optional ? "?.[ ]" : "[ ]";
      node.echo = node.subtitle;
      node.glyph = SHAPE_GLYPH["index"]!;
      carrier = true;
      operand("In", e.receiver);
      operand("At", e.index);
      break;
    }
    case "array": {
      node.kind = "array"; node.species = "collection";
      node.title = "List"; node.subtitle = "";
      node.glyph = SHAPE_GLYPH["array"]!;
      collection(e.items.map((a, i) => ({ name: String(i), arg: a })));
      break;
    }
    case "object": {
      node.kind = "object"; node.species = "collection";
      node.title = "Record"; node.subtitle = "";
      node.glyph = SHAPE_GLYPH["object"]!;
      collection(e.entries.map((en) => ({
        name: en.computed ? "[ " + src(en.keySpan) + " ]" : en.key,
        arg: { value: en.value, spread: en.spread, span: en.value.span },
      })));
      break;
    }
    case "template": {
      node.kind = "template"; node.species = "text";
      node.title = "Build Text";
      node.subtitle = templateShape(src, e);
      node.glyph = SHAPE_GLYPH["template"]!;
      // ORDER IS THE TEMPLATE'S WHOLE CONTENT, AND A NAME HAS NO ORDER. `${n} items` and
      // `items ${n}` both drew a `Build Text` head over one row called `Items`, because the
      // row's NAME was the only thing carrying the surrounding text - two different strings,
      // one drawing. The segments are the runs and the holes in source order, so the card can
      // draw the template as the template rather than as a bag of holes with captions.
      node.segments = templateSegments(src, e);
      const holes = templateNames(src, e);
      e.holes.forEach((h, i) => operand(holes[i]!, h));
      break;
    }
    case "group":
      return build(src, e.inner, depth, ctx, scope);
    case "call": case "method": {
      const name = e.kind === "call" ? lastSegment(e.callee) : e.name;
      if (e.higher && HIGHER_ORDER.has(name)) return higherOrder(src, e, name, depth, ctx, scope);
      node.kind = e.kind;
      node.species = "call";
      node.title = HIGHER_TITLE[name] ?? METHOD_TITLE[name] ?? titleCase(name);
      node.subtitle = e.kind === "call"
        ? (e.callee === name ? "" : e.callee)
        : (e.optional ? "?." : ".") + e.name;
      if (e.kind === "method" && e.name === "") {
        node.title = "Call";
        node.subtitle = e.optional ? "the value on the left, if there is one" : "the value on the left";
      }
      node.echo = e.kind === "call" ? e.callee : (e.optional ? "?." : ".") + e.name;
      node.glyph = HIGHER_GLYPH[name] ?? METHOD_GLYPH[name] ?? SHAPE_GLYPH["call"]!;
      // A receiver is the value the call is ABOUT, and `Of` says nothing an abutment does
      // not. A sole argument is the same case; a call with two arguments is not, because
      // then the surviving rows would be numbered from one with nothing saying why.
      carrier = e.kind === "method" || e.args.length === 1;
      if (e.kind === "method") operand("Of", e.receiver);
      e.args.forEach((a, i) => operand(argName(name, i, e.args.length, a), a.value));
      break;
    }
    case "lambda": {
      node.kind = "lambda"; node.species = "call";
      node.title = "Function";
      node.subtitle = "(" + e.params.map((p) => p.name).join(", ") + ")";
      node.glyph = SHAPE_GLYPH["lambda"]!;
      if (e.body) operand("Returns", e.body);
      break;
    }
    default: {
      node.kind = "unknown"; node.species = "unknown";
      node.title = "Custom Code";
      node.subtitle = oneLine(src(e.span));
      node.glyph = SHAPE_GLYPH["unknown"]!;
      break;
    }
  }

  /** A RUN PAST ROW_CAP FOLDS, the same discipline a long collection keeps and for the
   *  same reason: forty products summed drew forty rows, every one of them reading
   *  `Multiply`, down 490 pixels of card. A collection folds by LITERAL-ness because there
   *  the wired row is the one carrying information; a run of forty arms of one kind has no
   *  such row to keep, so it folds by REPEATED KIND instead - the head, where a reader
   *  starts, and the last arm, where the sum ends, stay, and the chip says how many went
   *  and what they all were.
   *
   *  Folding a WIRED arm means its subtree is never built. That is the whole of the
   *  collection's rule kept rather than broken: a hidden row is only a hidden edge if the
   *  edge still exists, and eliding the card too leaves nothing arriving at nothing. The
   *  text is untouched either way - the node's span still covers every arm, and
   *  `reconstructExpr` still returns the file. */
  function armRows(arms: Arm[], mixed: boolean): void {
    // ON A MIXED LADDER EACH ARM IS NAMED BY THE OPERATION THAT CONSUMES IT, so `a - b + c`
    // reads top to bottom as a, subtract b, add c - the ladder a person already reads. On a
    // ladder of one operator the operation is on the head and a repeated verb down the rows
    // would be the same word three times, so the arms are positions instead.
    const nameAt = (i: number): string =>
      mixed && i > 0 ? (BINARY_TITLE[arms[i]!.op!] ?? arms[i]!.op!) : String(i);
    if (arms.length <= ROW_CAP) {
      arms.forEach((arm, i) => operand(nameAt(i), arm.expr));
      return;
    }
    const last = arms.length - 1;
    const kinds = new Set<string>();
    arms.forEach((arm, i) => {
      if (i >= RUN_HEAD && i < last) { kinds.add(kindWord(arm.expr)); return; }
      operand(nameAt(i), arm.expr);
    });
    const hidden = arms.length - RUN_HEAD - 1;
    // ONLY WHAT IS TRUE. One kind among the folded arms is worth naming; a mixed band is
    // named by its count alone rather than by whichever kind happened to be first.
    node.chip = hidden + " more" + (kinds.size === 1 ? ", all " + [...kinds][0]! : "");
  }

  /** AN OBJECT OR AN ARRAY: one row per entry, and past ROW_CAP a chip, in that order of
   *  preference:
   *
   *  THE QUIET ROWS GO FIRST. A row that draws no edge - a literal, or a subtree folded to
   *  text - hides only its own characters, and "which of these thirty fields is COMPUTED" is
   *  the question the card exists to answer. A record of thirty fields where six are computed
   *  therefore shows those six and chips twenty-four, which is the drawing a person wanted.
   *
   *  THEN, ONLY IF THE COMPUTED ROWS ALONE STILL OVERFLOW, the run's rule applies to them
   *  too: the head a reader starts at and the last entry stay, and the rest fold WITH THEIR
   *  SUBTREES - a hidden row is only a hidden edge if the edge is still there, and eliding
   *  the card as well leaves nothing arriving at nothing. A card of forty computed rows is
   *  not a card anybody reads; the cap is eight because that is where scanning stops. */
  function collection(entries: { name: string; arg: Arg }[]): void {
    const quiet = (en: { arg: Arg }): boolean => !en.arg.spread && !wires(en.arg.value);
    const loud = entries.filter((en) => !quiet(en));
    const overflow = entries.length > ROW_CAP;
    const stillOver = loud.length > ROW_CAP;
    const keepLoud = new Set<{ name: string; arg: Arg }>();
    if (stillOver) {
      loud.forEach((en, i) => { if (i < RUN_HEAD || i === loud.length - 1) keepLoud.add(en); });
    }
    let hidden = 0, computed = 0;
    let allTyped = true;
    for (const en of entries) {
      const isQuiet = quiet(en);
      const drop = overflow && (isQuiet || (stillOver && !keepLoud.has(en)));
      if (drop) {
        hidden++;
        if (!isQuiet) computed++;
        if (!inlineable(en.arg.value)) allTyped = false;
        continue;
      }
      operand(en.arg.spread ? "..." + en.name : en.name, en.arg.value);
    }
    if (hidden > 0) {
      node.chip = hidden + " more"
        + (allTyped ? ", all typed in" : computed > 0 ? ", " + computed + " computed" : "");
      // The count belongs where something is HIDDEN. On a card that shows every row it
      // repeated what the rows already say.
      node.subtitle = entries.length + (node.kind === "object"
        ? entries.length === 1 ? " field" : " fields"
        : entries.length === 1 ? " item" : " items");
    }
  }

  const built: Built = { node, wired, all: [], bandTop: 0, bandBottom: 0, carrier };
  // AFTER the abutment, so a label is only grown where two DRAWN rows collide: the abutted
  // producer has no row and no label, and giving the one row that survived a tail against a
  // card that is not competing with it is noise.
  abutFirst(built);
  nameSources(node, [...kids.map((k) => k.node), ...shares]);
  sizeNode(node);
  ctx.nodes.push(node);
  built.all.push(built);
  // From `wired` and not from `kids`: `abutFirst` has just moved one of them out of `wired`,
  // and a subtree listed twice is a subtree SHIFTED twice.
  if (built.abut) built.all.push(...built.abut.all);
  for (const w of built.wired) built.all.push(...w.child.all);
  return built;
}

/** RULE 4, APPLIED. The leading operand of a carrier card gives up its row, its socket and
 *  its wire, and the producer is laid out touching the card's left wall instead - which is
 *  what 74.8% of this repo's wires were already drawing, at three objects each, between two
 *  cards that were already adjacent and already the only pair in their corridor.
 *
 *  Three refusals, and each is a place where the row is carrying something:
 *  - a SHARED card (rule 7) keeps its wire, because it is not adjacent to both its readers
 *  - a card with a PARAMETER row keeps its wire, because a parameter wire approaches through
 *    the channel the abutting producer would be sitting in
 *  - a card with a named ROLE in that slot keeps its wire, which `carrier` has already
 *    settled by the time this runs. */
function abutFirst(b: Built): void {
  if (!b.carrier) return;
  const n = b.node;
  const head = n.rows[0];
  if (!head || !head.wired) return;
  if (n.rows.some((r) => r.param !== undefined)) return;
  const link = b.wired.find((w) => w.row === 0);
  if (!link) return;
  b.abut = link.child;
  link.child.node.abuts = { to: n.id, slot: head.name };
  n.rows.shift();
  b.wired = b.wired.filter((w) => w !== link).map((w) => ({ row: w.row - 1, child: w.child }));
}

/** THE LABEL ON A WIRED ROW IDENTIFIES THE SOURCE, NOT ITS CATEGORY. A title is a kind, and
 *  a kind is shared: `(a + b) + (c + d)` feeds one node two rows that both read `Add`, so
 *  the drawing stops being able to say which value arrives where - which is the one question
 *  a wire exists to answer. Where a title collides among a NODE'S OWN incoming rows it grows
 *  a tail: the sources' subtitles when those separate them (`40 items` against `12 items`),
 *  otherwise the expression each one spells. Only where it collides - a tail on every
 *  reference would be noise on the rows that were never ambiguous - and never an id, which
 *  is a name for the machine rather than for the reader. */
function nameSources(node: ExprNode, kids: ExprNode[]): void {
  const seen = new Map<string, number>();
  for (const r of node.rows) {
    if (r.wired && r.fromTitle) seen.set(r.fromTitle, (seen.get(r.fromTitle) ?? 0) + 1);
  }
  const clashing = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
  if (clashing.length === 0) return;
  const byId = new Map(kids.map((k) => [k.id, k] as const));
  for (const title of clashing) {
    const group = node.rows.filter((r) => r.fromTitle === title && r.from !== undefined);
    const sources = group.map((r) => byId.get(r.from!));
    const subs = sources.map((n) => n?.subtitle ?? "");
    const bySub = subs.every((t) => t !== "") && new Set(subs).size === subs.length;
    group.forEach((r, i) => {
      const tail = bySub ? subs[i]! : clip(oneLine(sources[i]?.text ?? ""), 22);
      if (tail !== "") r.fromTitle = title + " " + tail;
    });
  }
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap - 1) + "\u2026" : text;
}

/** map / filter / reduce and the rest: a CONTAINER, not a card with a function in a slot. */
function higherOrder(
  src: Read, e: Expr & { kind: "call" | "method" }, name: string, depth: number,
  ctx: Ctx, scope: Scope,
): Built {
  const node: ExprNode = {
    id: nextId(), kind: e.kind, species: "higher",
    title: HIGHER_TITLE[name] ?? titleCase(name),
    subtitle: e.kind === "method" ? "." + name : e.callee,
    glyph: HIGHER_GLYPH[name] ?? SPECIES_GLYPH.higher, rows: [], span: e.span,
    text: src(e.span), rowW: 0,
    x: 0, y: 0, w: 0, h: 0, outX: 0, outY: 0, depth,
  };
  node.echo = e.kind === "method" ? "." + name : e.callee;
  if (ctx.crumbs.length) node.crumbs = [...ctx.crumbs];
  const wired: { row: number; child: Built }[] = [];
  const kids: Built[] = [];
  /** Cards this node reads that are OWNED BY SOMEONE ELSE (rule 7): wired, never placed from
   *  here, and named to `nameSources` only so a colliding label can still grow its tail. */
  const shares: ExprNode[] = [];

  // THE SLOTS ARE FIXED BY POSITION, not by which argument happens to be a lambda. The
  // runner reads `rows.reduce(fn, init)` and `reduce(rows, fn, init)` positionally, so
  // `rows.reduce(adder, 0)` - a NAMED reducer - has `adder` in the fn slot and `0` in the
  // seed slot. Guessing from "which one is an arrow" swapped those two, and drew
  // `map(x => x, rows)` (the arguments the wrong way round) as if it worked.
  const args = e.args.map((a) => a.value);
  const fnAt = e.kind === "method" ? 0 : 1;
  const initAt = fnAt + 1;
  const fnArg = args[fnAt];
  const lambdaAt = fnArg !== undefined && fnArg.kind === "lambda" ? fnAt : -1;
  const lambda = lambdaAt >= 0 ? args[lambdaAt]! as Extract<Expr, { kind: "lambda" }> : null;

  const operand = (label: string, child: Expr): void => {
    const row = node.rows.length;
    const text = src(child.span);
    if (inlineable(child)) {
      node.rows.push(leafRow(label, text, child.span, scope));
      return;
    }
    if (foldable(child, text, scope)) {
      node.rows.push(foldRow(label, text, child.span));
      return;
    }
    const key = depth + "\u0000" + scopeKey(scope) + "\u0000" + text;
    const held = ctx.shared.get(key);
    const built = held ?? build(src, child, depth, ctx, scope);
    node.rows.push({
      name: label, value: "", text, span: { ...child.span },
      mode: "expression", wired: true, from: built.node.id, fromTitle: built.node.title,
      portX: 0, portY: 0,
    });
    if (held) { shares.push(built.node); return; }
    ctx.shared.set(key, built);
    wired.push({ row, child: built });
    kids.push(built);
  };

  // The collection comes first, whichever spelling the author used: `rows.map(f)` puts it on
  // the receiver, `map(rows, f)` puts it in argument zero.
  if (e.kind === "method") operand("Items", e.receiver);
  args.forEach((a, i) => {
    if (i === lambdaAt) return;
    if (e.kind === "call" && i === 0) { operand("Items", a); return; }
    // The fn slot holding something that is not a lambda is worth SAYING, not relabelling:
    // the runner will pass it where a function goes and get nothing back.
    if (i === fnAt) { operand("For Each", a); return; }
    operand(isReduce(name) && i === initAt ? "Start With" : "Also", a);
  });

  const params = lambda?.params ?? [];
  const carryAt = isReduce(name) ? 0 : -1;
  const roles = ROLES[name] ?? ROLE_DEFAULT;
  node.params = params.map((p, i) => ({
    name: p.name, role: roles[i] ?? "", used: false, id: node.id + ":p" + i,
    span: { ...p.span }, carry: i === carryAt,
    x: 0, y: 0, w: 0, h: PILL_H, outX: 0, outY: 0,
  }));
  node.frame = { x: 0, y: 0, w: 0, h: 0, ...frameLabel(name, params.map((p) => p.name)) };

  let body: Built | undefined;
  if (lambda?.body) {
    if (inlineable(lambda.body)) {
      // A trivial lambda (`r => r.price`) folds into a row: opening a frame around one leaf
      // is ceremony, and the author can still open it by editing the row.
      const text = src(lambda.body.span);
      const inner = new Map(scope);
      node.params.forEach((pill) => inner.set(pill.name, pill.id));
      const row = leafRow("Each", text, lambda.body.span, inner);
      if (node.params.some((pill) => pill.id === row.param)) row.param = undefined;
      node.rows.push(row);
      node.folded = true;
      node.frame = undefined;
      node.params = undefined;
    } else {
      const inner = new Map(scope);
      node.params.forEach((pill) => inner.set(pill.name, pill.id));
      ctx.crumbs.push(node.title + (node.frame.item ? " " + node.frame.item : ""));
      body = build(src, lambda.body, depth + 1, ctx, inner);
      ctx.crumbs.pop();
      node.resultFrom = body.node.id;
    }
  } else if (lambda?.block) {
    // A block-bodied lambda is a WORKFLOW, not a formula: the statement view owns that shape,
    // so the frame shows the block as one opaque card rather than pretending to draw it.
    const text = src(lambda.block);
    const opaque: ExprNode = {
      id: nextId(), kind: "unknown", species: "unknown", title: "Steps",
      subtitle: oneLine(text), glyph: SHAPE_GLYPH["unknown"]!, rows: [],
      span: { ...lambda.block }, text, rowW: 0,
      x: 0, y: 0, w: 0, h: 0, outX: 0, outY: 0, depth: depth + 1,
    };
    sizeNode(opaque);
    if (ctx.crumbs.length) opaque.crumbs = [...ctx.crumbs, node.title];
    ctx.nodes.push(opaque);
    body = { node: opaque, wired: [], all: [], bandTop: 0, bandBottom: 0, carrier: false };
    body.all = [body];
    node.resultFrom = opaque.id;
  } else if (lambdaAt < 0) {
    node.folded = true;
    node.frame = undefined;
    node.params = undefined;
  }

  // ROWS ARE IN SOURCE ORDER, always. The folded `Each` row is pushed after the argument
  // loop, but the lambda's bytes come BEFORE a trailing seed - and a projection that
  // declares its rows ordered while handing out an unordered list is a write hazard, not a
  // cosmetic one. One sort, once, at the end.
  const order = new Map(node.rows.map((r, i) => [r, i] as const));
  node.rows.sort((a, b) => a.span.start - b.span.start || order.get(a)! - order.get(b)!);
  for (const link of wired) link.row = node.rows.indexOf(node.rows.find((r) => r.from === link.child.node.id)!);
  layRows(node);

  // A container's leading slot is `Items`, and `Items` says nothing that the collection
  // sitting against the card's left wall does not - which is exactly the composition chain
  // (`rows.filter(f).map(g)`) the spine was built for.
  const built: Built = {
    node, wired, all: [], body, bandTop: 0, bandBottom: 0, carrier: true,
  };
  abutFirst(built);
  nameSources(node, [...kids.map((k) => k.node), ...shares]);
  layRows(node);
  sizeNode(node);
  ctx.nodes.push(node);
  built.all.push(built);
  if (built.abut) built.all.push(...built.abut.all);
  for (const w of built.wired) built.all.push(...w.child.all);
  if (body) built.all.push(...body.all);
  return built;
}

/** The scope a subexpression was built under, as a key. Two spellings of one subexpression
 *  are ONE card only when the same names mean the same things at both sites: an inner `x`
 *  shadowing an outer `x` makes `x.n` two different reads, and sharing a card between them
 *  would draw one value where the program has two. */
function scopeKey(scope: Scope): string {
  const out: string[] = [];
  for (const [name, pill] of scope) out.push(name + "=" + pill);
  return out.sort().join(",");
}

/** A FOLDED OPERAND: its own source text, in the well, with a chevron. Not a literal - the
 *  well is showing an expression - so `value` stays empty and `inline` carries the text, and
 *  the row measures itself against what it draws. */
function foldRow(name: string, text: string, span: Span): ExprRow {
  return {
    name, value: "", text, span: { ...span }, mode: "expression", wired: false,
    inline: text, expandable: true, portX: 0, portY: 0,
  };
}

/** One unwired row. A reference whose head is a bound parameter is not a value the author
 *  typed: it is a read of the pill, and the row says so. */
function leafRow(name: string, text: string, span: Span, scope: Scope): ExprRow {
  const mode = valueMode(text);
  const row: ExprRow = {
    name, value: mode === "text" ? text.slice(1, -1) : text, text,
    span: { ...span }, mode, wired: false, portX: 0, portY: 0,
  };
  const blank = blankWord(mode, row.value);
  if (blank) row.blank = blank;
  if (mode !== "reference") return row;
  const dot = text.indexOf(".");
  const head = dot < 0 ? text : text.slice(0, dot);
  const pill = scope.get(head);
  if (pill === undefined) return row;
  row.param = pill;
  row.item = head;
  row.reach = dot < 0 ? "" : text.slice(dot + 1);
  return row;
}

/** The word a well with no ink of its own draws instead. See `ExprRow.blank`: the point is
 *  that `''` is a VALUE - `join('')` joins with nothing between the parts, and it is not the
 *  same program as a slot the author never filled - and two apostrophes at 11px, right
 *  aligned in an empty well, are the same picture as neither. A space is the same case: a
 *  `join(' ')` that reads as blank hides the one character it turns on. */
function blankWord(mode: ValueMode, value: string): string | undefined {
  if (mode === "empty") return "nothing";
  if (mode !== "text") return undefined;
  if (value === "") return "empty text";
  if (value.trim() !== "") return undefined;
  if (/^ +$/.test(value)) return value.length === 1 ? "1 space" : value.length + " spaces";
  return "blank text";
}

function isReduce(name: string): boolean { return name === "reduce" || name === "reduceRight"; }

function frameLabel(name: string, params: string[]): { lead: string; item: string; carry: string } {
  return {
    lead: "for each",
    item: isReduce(name) ? params[1] ?? "item" : params[0] ?? "item",
    carry: isReduce(name) ? params[0] ?? "total" : "",
  };
}

/** A leaf the row itself can hold. Groups are transparent, so `(2)` inlines as `2` would. */
function inlineable(e: Expr): boolean {
  if (e.kind === "group") return inlineable(e.inner);
  return e.kind === "number" || e.kind === "string" || e.kind === "boolean"
    || e.kind === "null" || e.kind === "regex" || e.kind === "ref";
}

/** Operators whose run reads as a BAG IN ORDER: numbered arms and a count are the whole
 *  truth, because the operation is the same at every step and nothing about the order needs
 *  spelling out. Everything else that merges keeps its source text on the head instead. */
const FLATTEN = new Set(["+", "*", "&&", "||", "??"]);

/** THE PRECEDENCE LADDER, mirrored from `expr.ts`'s parser - `nullish` down to
 *  `multiplicative`, one number per rung. It is here because MERGING IS A PRECEDENCE
 *  QUESTION: a run of operators of one rung folds left and a flat row list is a faithful
 *  reading of it, and a run that crosses a rung does not, so the flat list would be a lie.
 *  `**` has no rung on purpose - it is the one right-associative operator, so `2 ** 3 ** 2`
 *  is `2 ** (3 ** 2)` and a left-reading list of three arms says the wrong number. */
const LEVEL: Record<string, number> = table({
  "??": 1, "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7,
  "<": 8, "<=": 8, ">": 8, ">=": 8, "in": 8,
  "<<": 9, ">>": 9, ">>>": 9,
  "+": 10, "-": 10,
  "*": 11, "/": 11, "%": 11,
});

/** One arm of a merged ladder: the operand, and the operator that CONSUMES it. Arm 0 has no
 *  operator - it is the value the ladder starts from. */
type Arm = { expr: Expr; op: string | null };

/** THE LEFT SPINE OF ONE PRECEDENCE RUNG. `((a - b) + c) - d` becomes four arms carrying
 *  `-`, `+`, `-`, which is the ladder a person reads top to bottom: a, less b, plus c, less
 *  d. It stops at a rung change, so `a - b * c` is never flattened across the break, and it
 *  stops at a group, because parentheses are the author's own statement about where the
 *  reading breaks - and rule 3 will draw a small group as its own text anyway, parentheses
 *  and all, which keeps the statement visible without spending a card on it. */
function ladder(e: Expr & { kind: "binary" }): Arm[] {
  const rung = LEVEL[e.op];
  if (rung === undefined) return [{ expr: e.left, op: null }, { expr: e.right, op: e.op }];
  const out: Arm[] = [{ expr: e.right, op: e.op }];
  let left: Expr = e.left;
  for (;;) {
    if (left.kind !== "binary" || LEVEL[left.op] !== rung) break;
    out.push({ expr: left.right, op: left.op });
    left = left.left;
  }
  out.push({ expr: left, op: null });
  return out.reverse();
}

/** How many ATOMS a subtree costs a reader: an identifier path, a literal, or a real
 *  operator. A dotted read is ONE - `user.profile.displayName` is one thing to resolve, not
 *  three - which is the same judgement the fold threshold is calibrated against. */
function atomsOf(e: Expr): number {
  switch (e.kind) {
    case "group": return atomsOf(e.inner);
    case "number": case "string": case "boolean": case "null": case "regex": case "ref": return 1;
    case "member": return pathOnly(e) ? 1 : 1 + atomsOf(e.receiver);
    case "lambda": return 1 + (e.body ? atomsOf(e.body) : 0);
    default: {
      let n = 1;
      for (const c of childrenOf(e)) n += atomsOf(c);
      return n;
    }
  }
}
function pathOnly(e: Expr): boolean {
  if (e.kind === "ref") return true;
  return e.kind === "member" ? pathOnly(e.receiver) : false;
}

function holdsLambda(e: Expr): boolean {
  if (e.kind === "lambda") return true;
  for (const c of childrenOf(e)) if (holdsLambda(c)) return true;
  return false;
}

/** A SUBTREE SMALL ENOUGH TO BE TEXT. Never a lambda or anything holding one: a lambda's
 *  parameter is a BINDING, and the frame, the pill and the wire out of it are the only thing
 *  on this canvas that says where the item comes from. Folding that into a well would delete
 *  the abstraction the loop exists to show. */
function foldable(e: Expr, text: string, scope: Scope): boolean {
  if (inlineable(e)) return false;                 // already a value in its row
  if (text.length > INLINE_MAX) return false;
  if (holdsLambda(e)) return false;
  // AND NEVER A READ OF A BOUND ITEM. `total + item.price * item.qty` would fold its product
  // into eleven characters and the `item` pill would go dark, because nothing on the drawing
  // would be reading it any more - the pill, the wire out of it and the unread-pill signal
  // are the whole of what makes a loop comprehensible, and a fold that swallows them has
  // bought a card by deleting the abstraction. Inside a frame, structure keeps its box.
  if (readsBinding(e, scope)) return false;
  return atomsOf(e) <= FOLD_ATOMS;
}

/** Does this subtree read a name a container has bound? */
function readsBinding(e: Expr, scope: Scope): boolean {
  if (scope.size === 0) return false;
  if (e.kind === "ref") {
    const dot = e.path.indexOf(".");
    return scope.has(dot < 0 ? e.path : e.path.slice(0, dot));
  }
  for (const c of childrenOf(e)) if (readsBinding(c, scope)) return true;
  return false;
}

/** ONE BASE, EVERYWHERE: a row named with a bare number is a 0-BASED INDEX. The only index
 *  the language itself spells is the array's - `rows[0]` is what an author types - so the
 *  list's base is the language's base, and an editor that numbered a `??` run from one while
 *  numbering its list from zero made a reader hold two bases at once in the same session.
 *  The arms of a run, the entries of a list, the holes of a template and the arguments of a
 *  call nobody has named all count from 0.
 *
 *  AND A NUMBER IS USED ONLY WHERE POSITION IS THE WHOLE TRUTH. `Left`/`Right` on a `+`
 *  invents a role neither operand has; `This`/`That` on `>=` hides the one role that
 *  matters, which is which side is the minimum. So an operator that HAS roles names them,
 *  and an operator that does not numbers its operands like every other ordered list on this
 *  surface. `+` and `*` and the logical pair are the second case: `'a' + 'b'` proves order
 *  is not nothing, but neither side is a role, and a position is what a number is for. */
const OPERAND_NAMES: Record<string, [string, string]> = table({
  "-": ["From", "By"], "/": ["From", "By"], "%": ["From", "By"],
  "**": ["Base", "Power"],
  "<<": ["Value", "By"], ">>": ["Value", "By"], ">>>": ["Value", "By"],
  "<": ["Value", "Below"], "<=": ["Value", "Maximum"],
  ">": ["Value", "Above"], ">=": ["Value", "Minimum"],
  "??": ["Value", "Fallback"],
  "in": ["Key", "In"],
});
function operandNames(op: string): [string, string] {
  return OPERAND_NAMES[op] ?? ["0", "1"];
}

/** What the drawing WOULD have called an arm it decided not to build. A folded run names
 *  the kind it hid, and it cannot read that off a card that was never made, so the tables
 *  above answer for the shape directly. Nothing else may use this: a built node's title is
 *  the node's own. */
function kindWord(e: Expr): string {
  switch (e.kind) {
    case "group": return kindWord(e.inner);
    case "number": case "string": case "boolean": case "null": case "regex": case "ref":
      return "typed in";
    case "binary": return BINARY_TITLE[e.op] ?? e.op;
    case "unary": return UNARY_TITLE[e.op] ?? "Apply " + e.op;
    case "ternary": return "Choose";
    case "member": return titleCase(e.name);
    case "index": return "Item At";
    case "array": return "List";
    case "object": return "Record";
    case "template": return "Build Text";
    case "lambda": return "Function";
    case "call": case "method": {
      const name = e.kind === "call" ? lastSegment(e.callee) : e.name;
      return HIGHER_TITLE[name] ?? METHOD_TITLE[name] ?? titleCase(name);
    }
    default: return "Custom Code";
  }
}

/** Positional arguments read as `arg0`, `arg1` on every editor that gives up here, and
 *  `Argument 1` is the same surrender in a longer word. `toFixed` proved the alternative:
 *  its one argument is `Decimals`, and nobody has to know that a decimal count is what the
 *  first slot of `toFixed` means. So EVERY METHOD THIS SURFACE TITLES names its arguments -
 *  the census is `METHOD_TITLE` minus the eleven that take none, and `exprflow.test.ts`
 *  holds that count. What is left over is a function nobody here has named, and its
 *  arguments are then genuinely positions: they are spelled the way every other position on
 *  this surface is spelled, as a 0-based index. */
const ARG_NAMES: Record<string, string[]> = table({
  join: ["Between"], slice: ["From", "To"], substring: ["From", "To"], substr: ["From", "Length"],
  split: ["On", "Limit"], replace: ["Find", "Replace With"], replaceAll: ["Find", "Replace With"],
  padStart: ["Length", "Pad With"], padEnd: ["Length", "Pad With"], repeat: ["Times"],
  includes: ["Looking For", "From"], indexOf: ["Looking For", "From"], lastIndexOf: ["Looking For", "From"],
  startsWith: ["Prefix", "From"], endsWith: ["Suffix", "Before"],
  toFixed: ["Decimals"], concat: ["And"], at: ["Position"], charAt: ["Position"],
  push: ["Value"], flat: ["Depth"], fill: ["Value", "From", "To"],
  with: ["Position", "Value"], toSpliced: ["From", "How Many", "Insert"],
  test: ["Text"], match: ["Pattern"], matchAll: ["Pattern"], toString: ["Base"],
  toLocaleDateString: ["Locale", "Options"], toLocaleTimeString: ["Locale", "Options"],
  toLocaleString: ["Locale", "Options"],
  round: ["Value"], floor: ["Value"], ceil: ["Value"], abs: ["Value"], sqrt: ["Value"],
  min: ["Value"], max: ["Value"], pow: ["Base", "Power"],
  format: ["Value", "Options"], parse: ["Text"], keys: ["Of"], values: ["Of"], entries: ["Of"],
});
function argName(fn: string, i: number, total: number, arg: Arg): string {
  if (arg.spread) return "...";
  const named = ARG_NAMES[fn];
  if (named && named[i]) return named[i]!;
  if (total === 1) return "Value";
  return String(i);
}

function lastSegment(path: string): string {
  const at = path.lastIndexOf(".");
  return at < 0 ? path : path.slice(at + 1);
}

/** The literal text a template holds, split at its holes: one more chunk than there are
 *  holes, in source order. Read span by span rather than by index arithmetic: the caller
 *  hands out decoded text, and the two backticks are the only characters to step over. */
function templateChunks(src: Read, e: Expr & { kind: "template" }): string[] {
  const whole = src(e.span);
  let rest = whole.slice(1, Math.max(1, whole.length - 1));
  const out: string[] = [];
  for (let i = 0; i < e.holes.length; i++) {
    const open = rest.indexOf("${");
    if (open < 0) break;
    out.push(rest.slice(0, open));
    let depth = 1;
    let k = open + 2;
    while (k < rest.length && depth > 0) {
      if (rest[k] === "{") depth += 1;
      else if (rest[k] === "}") depth -= 1;
      k += 1;
    }
    rest = rest.slice(k);
  }
  out.push(rest);
  return out;
}

/** A template's shape, with each `${ }` shown as the hole it is.
 *
 *  THE MARK IS ASCII, and that is a measurement rather than a taste. The hole was drawn with
 *  U+25AB WHITE SMALL SQUARE, which InterVariable does not carry - the sheet's first font
 *  and the one this text is set in - so the browser drew its own .notdef box and a card read
 *  `[tofu] items`. `{}` costs two characters every font in either stack has, and it is also
 *  what the author wrote: the hole reads as the `${}` it stands for. */
function templateShape(src: Read, e: Expr & { kind: "template" }): string {
  if (e.holes.length === 0) {
    const whole = src(e.span);
    return oneLine(whole.slice(1, Math.max(1, whole.length - 1)));
  }
  return oneLine(templateChunks(src, e).join("{}"));
}

/** THE TEMPLATE, AS AN ORDERED LIST OF RUNS AND HOLES. `${n} items` is [hole 0, " items"]
 *  and `items ${n}` is ["items ", hole 0], which is the difference a row NAME cannot carry -
 *  both drew one row called `Items`. Empty runs are dropped: a `{text: ""}` between two
 *  adjacent holes is a segment with nothing in it. `hole` indexes this node's rows, which
 *  are the holes in the same order. */
function templateSegments(src: Read, e: Expr & { kind: "template" }): { text?: string; hole?: number }[] {
  const chunks = templateChunks(src, e);
  const out: { text?: string; hole?: number }[] = [];
  chunks.forEach((chunk, i) => {
    if (chunk !== "") out.push({ text: chunk });
    if (i < e.holes.length) out.push({ hole: i });
  });
  return out;
}

/** A HOLE IS NAMED FOR WHAT INTRODUCES IT. `Total: ${n}` has a hole called Total, and
 *  `${n} items` has one called Items, because a position is the least a template part can
 *  be called and the text around it usually says what it is. The label is the word or two
 *  that lead into the hole, else the word or two that follow it, else - `${first} ${last}`,
 *  where the surrounding text is one space and says nothing - the position, in the editor's
 *  one base. A word is letters and digits and nothing else, which is also what keeps `\n`
 *  from naming a hole `Line\n`. */
function templateNames(src: Read, e: Expr & { kind: "template" }): string[] {
  const chunks = templateChunks(src, e);
  return e.holes.map((_, i) =>
    edgeWord(chunks[i] ?? "", "end") || edgeWord(chunks[i + 1] ?? "", "start") || "Part " + i);
}

/** The last (or first) word or two of a chunk, title-cased, or "" when it has none. */
function edgeWord(chunk: string, at: "end" | "start"): string {
  const trimmed = at === "end"
    ? chunk.replace(/[^A-Za-z0-9_ ]+\s*$/, "").trimEnd()
    : chunk.replace(/^\s*[^A-Za-z0-9_ ]+/, "").trimStart();
  if (trimmed === "") return "";
  const words = trimmed.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z0-9]*$/.test(w));
  const pick = at === "end" ? words.slice(-2) : words.slice(0, 2);
  const label = pick.join(" ");
  if (label.length < 2 || label.length > 18) return "";
  return titleCase(label);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 44 ? flat.slice(0, 43) + "…" : flat;
}

// ── sizing: measured before it is drawn ──────────────────────────────────────────────

const TILE_W = 20;          // the mark's tinted tile - a rung of the control ladder
const HEAD_GAP = 6;

function sizeNode(n: ExprNode): void {
  // The head is ONE line: glyph, title, a gap, subtitle. Measuring the title and the
  // subtitle against the box separately is how a subtitle ends up painting 61px past the
  // card's own right edge - the two share the line, so they are measured sharing it.
  const head = TILE_W + HEAD_GAP + titleWidth(n.title)
    + (n.subtitle === "" ? 0 : HEAD_GAP * 2 + labelWidth(n.subtitle));
  let w = head + 2 * PAD_X;
  for (const r of n.rows) {
    // A text literal is drawn WITH its quotes, and a reach with its dot: the two extra
    // characters are the difference between a row that fits and a row that ellipses.
    const shown = r.mode === "text" ? r.value.length + 2 : r.value.length;
    const value = r.wired
      ? labelWidth("\u2190 " + (r.fromTitle ?? "")) + 8
      // A FOLD IS MEASURED FOR WHAT IT DRAWS. The well holds the operand's whole source, and
      // a card sized for an empty `value` would ellipse the one thing the fold promised to
      // show. Mono, like every other well.
      : r.inline
        ? Math.max(VALUE_MIN, monoWidth(r.inline) + 16)
        : r.item
        ? labelWidth(r.item) + 20 + (r.reach ? monoWidth("." + r.reach) + 12 : 4)
        : r.blank
          // The word, not the two apostrophes it replaces - a well measured for `''` and
          // drawn holding `empty text` is a card two thirds too narrow. Measured in the
          // MONO face, which is the wider of the two the sheet has, so the word fits
          // whichever one the well ends up set in.
          ? Math.max(VALUE_MIN, monoWidth(r.blank) + 16)
          : Math.max(VALUE_MIN, shown * MONO_11 + 16);
    w = Math.max(w, LABEL_W + 8 + value + 2 * PAD_X + 12);
  }
  if (n.chip) w = Math.max(w, labelWidth(n.chip) + 2 * PAD_X + 16);
  w = Math.min(NODE_MAX, Math.max(NODE_MIN, Math.ceil(w)));
  n.rowW = w;

  let h = HEAD_H + n.rows.length * ROW_H + (n.rows.length ? PAD_B : 0) + (n.chip ? ROW_H : 0);

  if (n.frame) {
    // The frame's box is filled in by `place`, once the body has been laid out. Its width and
    // height are known only then, so sizeNode reserves the head and the rail and no more.
    // x is ZERO: the region starts at the card's own left wall, because it IS the card.
    n.frame.x = 0;
    n.frame.y = h;
    n.params?.forEach((p, i) => {
      p.w = pillWidth(p.name);
      p.x = FRAME_PAD;
      p.y = FRAME_HEAD + FRAME_PAD + i * (PILL_H + PILL_GAP);
    });
  }
  n.w = w;
  n.h = h;
  n.outX = w;
  n.outY = n.rows.length ? HEAD_H + ROW_H / 2 : h / 2;
  layRows(n);
}

/** A PILL IS SIZED TO ITS NAME, with a floor for the finger rather than for the word. The
 *  floor used to be 56px and the measure a PROPORTIONAL one, so `p` - a one-character name -
 *  drew a 55px capsule with its character against the left edge and 40px of nothing after
 *  it, and `r`, `s` and `o` did the same three times over inside one `matrix`. Two things
 *  were wrong: 56 is a width for a word nobody wrote, and the name is set in the MONO face
 *  (`.expr-pill-name`), so measuring it with the proportional table under-measured every
 *  long name while the floor hid the error. The floor is now the tap target itself - 24px
 *  square at PILL_H, a rung of the control ladder - and above it the pill is its own text.
 *  The socket rides `x + w`, so it walks in with the wall. */
function pillWidth(name: string): number {
  return Math.max(PILL_MIN, Math.ceil(monoWidth(name)) + 2 * PILL_PAD);
}

/** Row sockets, in node-local coordinates. `place` shifts them once, at the end. */
function layRows(n: ExprNode): void {
  n.rows.forEach((r, i) => {
    r.portX = 0;
    r.portY = HEAD_H + i * ROW_H + ROW_H / 2;
  });
}

// ── placing: bands ───────────────────────────────────────────────────────────────────

/** Lay a subtree out with its root's RIGHT edge at `right` and its band starting at `top`.
 *  Returns the band's bottom. Every coordinate here is provisional and negative-going on x;
 *  `normalise` shifts the whole drawing into the positive quadrant at the end. */
function place(b: Built, right: number, top: number): number {
  const n = b.node;

  if (n.frame) return placeContainer(b, right, top);

  n.x = right - n.w;
  if (b.wired.length === 0 && !b.abut) {
    n.y = top;
    b.bandTop = top;
    b.bandBottom = top + n.h;
    return b.bandBottom;
  }

  const childRight = n.x - COL_GAP;
  let cursor = top;
  let fixed = false;

  // THE ABUTMENT IS PLACED FIRST AND EXACTLY. Its out-line and this card's out-line are the
  // same line - that is what makes the seam read as a wire - so whichever of the two needs
  // the lead gets it, and neither is clamped afterwards. It sits at `n.x`, touching.
  if (b.abut) {
    // The child is placed first and this card is hung off WHERE ITS OUT-LINE ACTUALLY LANDED,
    // not off where the child's own box would put it: a child that is itself an abutment has
    // already been pushed down inside its own subtree, and reading the offset instead of the
    // line makes every seam past the first one a step.
    const bottom = place(b.abut, n.x, top);
    const lift = Math.max(0, top - (outLine(b.abut.node) - outOffset(n)));
    if (lift > 0) shift(b.abut.all, 0, lift);
    n.y = outLine(b.abut.node) - outOffset(n);
    cursor = bottom + lift + ROW_GAP;
    fixed = true;
  }

  for (const { child } of b.wired) {
    cursor = place(child, childRight, cursor) + ROW_GAP;
  }
  const bandBottom = Math.max(cursor - ROW_GAP, top);

  if (!fixed) {
    // The spine: row 0's socket sits on the first child's out-line. ABSOLUTE, because a
    // child's own `outY` is still node-local here and a band that does not start at zero
    // would otherwise pull every parent in it back to the top of the drawing. Clamped into
    // the band, so a parent can never climb out of its own subtree and into a sibling's.
    const first = b.wired[0]!;
    const want = outLine(first.child.node) - (HEAD_H + first.row * ROW_H + ROW_H / 2);
    n.y = clamp(want, top, Math.max(top, bandBottom - n.h));
  }

  b.bandTop = Math.min(top, n.y);
  b.bandBottom = Math.max(bandBottom, n.y + n.h);
  return b.bandBottom;
}

/** A card's out-line, in its own coordinates. `outY` holds this until `normalise` turns it
 *  into a flow coordinate, and everything in this section reads it through here so nobody
 *  has to remember which of the two it is holding. */
function outOffset(n: ExprNode): number {
  if (n.rows.length) return HEAD_H + ROW_H / 2;
  if (n.frame) return (n.frame.y - n.y) / 2;
  return n.h / 2;
}
function outLine(n: ExprNode): number { return n.y + n.outY; }

/** RE-STRIKE EVERY SEAM after the column pass has moved left walls. A producer's subtree
 *  slides as one piece, and only ever leftward (a widened card's left wall only moves left),
 *  so it moves away from its consumer and can collide with nothing: within its own subtree
 *  the geometry is unchanged, and every other subtree is in a disjoint band. */
function snapAbutments(b: Built): void {
  if (b.abut) {
    const gap = b.node.x - (b.abut.node.x + b.abut.node.w);
    if (gap !== 0) shift(b.abut.all, gap, 0);
    snapAbutments(b.abut);
  }
  for (const { child } of b.wired) snapAbutments(child);
  if (b.body) snapAbutments(b.body);
}

/** WHERE A READER STARTS. A card nothing feeds is an entry, and its source-order index is the
 *  order the author wrote them in - so a drawing with four independent inputs says which one
 *  is the first word of the expression rather than making the reader find it. Absent on every
 *  card that has something arriving, which already says where it came from. */
function markEntries(nodes: ExprNode[]): void {
  const fed = new Set<string>();
  for (const n of nodes) {
    if (n.resultFrom) fed.add(n.id);
    // A binding feeds a card as surely as a wire does: the pill is on the other end of it.
    for (const r of n.rows) if ((r.wired && r.from) || r.param !== undefined) fed.add(n.id);
    if (n.abuts) fed.add(n.abuts.to);
  }
  const entries = nodes.filter((n) => !fed.has(n.id))
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  entries.forEach((n, i) => { n.ordinal = i; });
}

/** A higher-order node: rows above, then a frame whose inside is a whole sub-canvas. The
 *  frame's geometry is only knowable after the body is laid out, so the node's own height is
 *  finalised here rather than in sizeNode. */
function placeContainer(b: Built, right: number, top: number): number {
  const n = b.node;
  const frame = n.frame!;
  const params = n.params ?? [];

  const railTop = FRAME_HEAD + FRAME_PAD;
  const railH = params.length ? params.length * PILL_H + (params.length - 1) * PILL_GAP : 0;
  const railW = params.length ? Math.max(...params.map((p) => p.w)) : 0;

  // Lay the body in a local frame whose origin is the frame's inner content corner.
  let bodyW = 0, bodyH = 0;
  if (b.body) {
    const bottom = place(b.body, 0, 0);
    const box = extent(b.body.all);
    shift(b.body.all, -box.x0, -box.y0);
    bodyW = box.x1 - box.x0;
    bodyH = Math.max(bottom - box.y0, box.y1 - box.y0);
  }

  const innerW = (railW ? railW + FRAME_PAD + 24 : 0) + bodyW + (bodyW ? 24 : 0);
  const innerH = Math.max(railH, bodyH);
  // A reduce's carry runs UNDER the body, so the frame reserves a lane for it rather than
  // letting the wire share a line with its own bottom border.
  const carry = params.some((p) => p.carry) ? CARRY_LANE : 0;
  // AND A LANE FOR THE BINDINGS. A parameter wire that cannot run straight to its row without
  // passing behind a card comes back along the frame's floor and enters its target from
  // below, so it never runs at another card's row height. That lane is reserved here rather
  // than borrowed from the frame's bottom border.
  const bindings = params.length ? PARAM_LANE : 0;

  // ONE BOX. The region is not inset inside the card - it is the card's lower half, so the
  // card's own three walls are the region's three walls and a level of nesting costs one
  // outline instead of two. The whole per-level chrome budget is FRAME_PAD on each side and
  // FRAME_HEAD above; it used to be that plus PAD_X and a second border, which is the 20px a
  // loop level charged before a reader saw any of its content.
  const rowsH = HEAD_H + n.rows.length * ROW_H + (n.rows.length ? PAD_B : 0);
  n.w = Math.max(n.w, Math.max(RAIL_W + 80, innerW + 2 * FRAME_PAD));
  frame.x = 0;
  frame.y = rowsH;
  frame.w = n.w;
  frame.h = FRAME_HEAD + innerH + 2 * FRAME_PAD + carry + bindings;
  n.h = rowsH + frame.h;
  n.outX = n.w;
  n.outY = n.rows.length ? HEAD_H + ROW_H / 2 : rowsH / 2;
  layRows(n);

  // Now the node's own box, and its children to the left of it.
  n.x = right - n.w;
  const childRight = n.x - COL_GAP;
  let cursor = top;
  let fixed = false;
  if (b.abut) {
    const mine = n.rows.length ? HEAD_H + ROW_H / 2 : rowsH / 2;
    const bottom = place(b.abut, n.x, top);
    const lift = Math.max(0, top - (outLine(b.abut.node) - mine));
    if (lift > 0) shift(b.abut.all, 0, lift);
    n.y = outLine(b.abut.node) - mine;
    cursor = bottom + lift + ROW_GAP;
    fixed = true;
  }
  for (const { child } of b.wired) cursor = place(child, childRight, cursor) + ROW_GAP;
  const kidsBottom = Math.max(cursor - ROW_GAP, top);

  if (fixed) {
    // placed against its abutment already
  } else if (b.wired.length) {
    const first = b.wired[0]!;
    const want = outLine(first.child.node) - (HEAD_H + first.row * ROW_H + ROW_H / 2);
    n.y = clamp(want, top, Math.max(top, kidsBottom - n.h));
  } else {
    n.y = top;
  }

  // Pin the frame's contents into flow coordinates.
  const fx = n.x + frame.x, fy = n.y + frame.y;
  frame.x = fx; frame.y = fy;
  // RIGHT-ALIGNED IN THE RAIL. Pills were all one width when the width was a floor, so the
  // question never came up; sized to their names, `total` and `line` are 7px apart and one
  // of the two edges has to be ragged. It is the left one: the right edge is where every
  // pill's socket sits and where every body wire leaves, so that edge is a column and the
  // rail is a leading edge rather than two capsules that happen to be stacked.
  params.forEach((p, i) => {
    p.x = fx + FRAME_PAD + (railW - p.w);
    p.y = fy + railTop + i * (PILL_H + PILL_GAP);
    p.h = PILL_H;
    p.outX = p.x + p.w;
    p.outY = p.y + PILL_H / 2;
  });
  if (b.body) {
    const bodyX = fx + FRAME_PAD + (railW ? railW + FRAME_PAD + 24 : 0);
    shift(b.body.all, bodyX, fy + railTop);
    n.resultX = fx + frame.w;
    // THE SOCKET SITS ON THE BODY'S OWN LINE. It used to be set to the body card's NODE-LOCAL
    // out offset, which is a number in the body's coordinates and not in the frame's - so on
    // any container with rows of its own the result socket landed ABOVE the region entirely
    // (measured: a `Map Over` with one `Items` row put its result at y=68 against a region
    // starting at y=88) and the wire out of the body ran up to a point on no wall.
    n.resultY = outLine(b.body.node);
  }

  b.bandTop = Math.min(top, n.y);
  b.bandBottom = Math.max(Math.max(kidsBottom, n.y + n.h), b.bandTop);
  return b.bandBottom;
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

function extent(all: Built[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of all) {
    const n = b.node;
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
    if (n.frame) { x1 = Math.max(x1, n.frame.x + n.frame.w); y1 = Math.max(y1, n.frame.y + n.frame.h); }
  }
  if (!all.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

function shift(all: Built[], dx: number, dy: number): void {
  for (const b of all) {
    const n = b.node;
    n.x += dx; n.y += dy;
    if (n.frame) { n.frame.x += dx; n.frame.y += dy; }
    if (n.params) for (const p of n.params) { p.x += dx; p.y += dy; p.outX += dx; p.outY += dy; }
    if (n.resultX !== undefined) { n.resultX += dx; n.resultY = (n.resultY ?? 0) + dy; }
  }
}

/** Move the whole drawing into the positive quadrant with a margin, and turn every node-local
 *  socket into a flow coordinate. Runs exactly once, after every box has its final place. */
function normalise(nodes: ExprNode[]): { w: number; h: number } {
  const M = 28;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w + OUT_STUB); y1 = Math.max(y1, n.y + n.h);
    if (n.frame) { x1 = Math.max(x1, n.frame.x + n.frame.w); y1 = Math.max(y1, n.frame.y + n.frame.h); }
  }
  if (!nodes.length) return { w: 0, h: 0 };
  const dx = M - x0, dy = M - y0;
  for (const n of nodes) {
    n.x += dx; n.y += dy;
    n.outX = n.x + n.w;
    n.outY = n.y + (n.rows.length ? HEAD_H + ROW_H / 2 : n.h / 2);
    if (n.frame) {
      n.frame.x += dx; n.frame.y += dy;
      n.outY = n.y + (n.rows.length ? HEAD_H + ROW_H / 2 : (n.frame.y - n.y) / 2);
    }
    for (const r of n.rows) { r.portX = n.x; r.portY = n.y + r.portY; }
    if (n.params) for (const p of n.params) { p.x += dx; p.y += dy; p.outX += dx; p.outY += dy; }
    if (n.resultX !== undefined) { n.resultX += dx; n.resultY = (n.resultY ?? 0) + dy; }
  }
  return { w: Math.ceil(x1 - x0 + 2 * M), h: Math.ceil(y1 - y0 + 2 * M) };
}

// ── wires ────────────────────────────────────────────────────────────────────────────

/** Every wire leaves its source perpendicular for OUT_STUB, crosses the channel on a shared
 *  x, and arrives perpendicular. Three segments, two elbows, drawn with the same rounded
 *  Connector the statement canvas uses - so one visual language, two surfaces. */
function wireOne(
  n: ExprNode, byId: Map<string, ExprNode>, nodes: ExprNode[], edges: ExprEdge[],
  pills: Map<string, PillRef>,
): void {
  n.rows.forEach((r, i) => {
    if (r.param) {
      const pill = pills.get(r.param);
      if (pill) {
        pill.param.used = true;
        const owner = byId.get(pill.owner)!;
        // Left to right like every other wire, even though the pill sits inside the frame
        // this row is drawn in: the item flows OUT of the rail and INTO the body.
        edges.push({
          from: pill.owner, to: n.id, row: i, param: r.param, kind: "binding",
          points: bindingRoute(pill.param, owner, r, nodes),
        });
      }
      return;
    }
    if (!r.wired || !r.from) return;
    const src = byId.get(r.from);
    if (!src) return;
    edges.push({
      from: src.id, to: n.id, row: i, kind: "value",
      // A SHARED CARD (rule 7) may sit to the RIGHT of its second reader, because it was
      // placed by its first. That is the one edge in a value graph that can run backwards,
      // and it routes under both cards rather than through them.
      points: src.outX <= r.portX
        ? elbow(src.outX, src.outY, r.portX, r.portY)
        : backRoute(src, r),
    });
  });
}

/** A BINDING RUNS STRAIGHT WHERE STRAIGHT IS HONEST, AND ALONG THE FLOOR WHERE IT IS NOT.
 *
 *  The straight run - out of the pill, turn in the rail's own gutter, one horizontal line at
 *  the row's height - is the shortest reading when nothing is in the way. When something IS,
 *  the wire passed BEHIND an opaque card and came out the other side attached to whatever
 *  socket the fragment happened to end on: measured on `products.filter(p => p.price >= min
 *  && p.inStock)`, the wire from the `p` pill to the `And` card's second port ran behind `Is
 *  At Least` and its visible left fragment terminated exactly on that card's HOLLOW `Minimum`
 *  port. Both readings a viewer can form there are false, and the second one breaks the
 *  canvas's own rule that an unfilled socket means nothing arrives.
 *
 *  So a blocked binding drops into the frame's floor lane and comes up into its target from
 *  below - the same lane discipline the reduce carry already proves reads well - and never
 *  runs at another card's row height. */
function bindingRoute(
  pill: ExprParam, owner: ExprNode, row: ExprRow, nodes: ExprNode[],
): [number, number][] {
  const turn = pill.outX + OUT_STUB;
  if (!crossesCard(turn, row.portX, row.portY, nodes, owner)) {
    return railElbow(pill.outX, pill.outY, row.portX, row.portY);
  }
  const frame = owner.frame!;
  const floor = frame.y + frame.h - FRAME_PAD - PARAM_LANE / 2;
  const up = row.portX - OUT_STUB;
  return [
    [pill.outX, pill.outY], [turn, pill.outY], [turn, floor],
    [up, floor], [up, row.portY], [row.portX, row.portY],
  ];
}

/** Does a horizontal run at `y` from `x0` to `x1` pass through a card? The container that
 *  owns the rail is excluded - the wire is inside it by construction - and so is the card the
 *  wire lands on, since arriving at its wall is not passing through it. */
function crossesCard(x0: number, x1: number, y: number, nodes: ExprNode[], owner: ExprNode): boolean {
  for (const c of nodes) {
    if (c.id === owner.id || c.frame) continue;
    if (Math.abs(c.x - x1) < 0.5) continue;              // the target's own wall
    if (y <= c.y || y >= c.y + c.h) continue;
    if (c.x + c.w <= x0 + 0.5 || c.x >= x1 - 0.5) continue;
    return true;
  }
  return false;
}

/** The one value edge that runs right to left: a shared card read by a card to its left. It
 *  leaves the source, drops below it, runs back, and comes up into the socket from beneath -
 *  never across either card's face. */
function backRoute(src: ExprNode, row: ExprRow): [number, number][] {
  const under = Math.max(src.y + src.h, row.portY) + CARRY_LANE / 2;
  const up = row.portX - OUT_STUB;
  return [
    [src.outX, src.outY], [src.outX + OUT_STUB, src.outY], [src.outX + OUT_STUB, under],
    [up, under], [up, row.portY], [row.portX, row.portY],
  ];
}

/** EVERY EDGE IN A CORRIDOR GETS ITS OWN LANE. Six edges into one card shared a single x for
 *  550 pixels and drew as one 2px stroke, so a six-way fan-in and a one-way wire were the
 *  same picture - and fan-in arity is precisely what the text hides behind precedence, which
 *  makes it the strongest thing this canvas has to say. Lanes are ordered by where the edge
 *  LEAVES, and the band layout already stacks sources in the order their rows are stacked, so
 *  the lanes nest instead of crossing. A fan's WIDTH is now its arity. */
function laneEdges(edges: ExprEdge[]): void {
  const corridors = new Map<number, ExprEdge[]>();
  for (const e of edges) {
    e.lane = 0;
    const leg = verticalLeg(e);
    if (leg === null) continue;
    const key = Math.round(leg);
    if (!corridors.has(key)) corridors.set(key, []);
    corridors.get(key)!.push(e);
  }
  for (const group of corridors.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.points[0]![1] - b.points[0]![1] || a.row - b.row);
    const mid = (group.length - 1) / 2;
    group.forEach((e, i) => {
      e.lane = i;
      const dx = (i - mid) * LANE_GAP;
      const leg = verticalLeg(e)!;
      // Inside the corridor's own walls: a lane that slid past the socket it serves would be
      // a wire leaving its own channel, which is the defect the lanes exist to stop.
      const lo = Math.min(e.points[0]![0], e.points[e.points.length - 1]![0]) + OUT_STUB;
      const hi = Math.max(e.points[0]![0], e.points[e.points.length - 1]![0]) - OUT_STUB;
      const at = clamp(leg + dx, Math.min(lo, hi), Math.max(lo, hi));
      for (const pt of e.points) if (Math.abs(pt[0] - leg) < 0.5) pt[0] = at;
    });
  }
}

/** The x of an edge's single vertical leg, or null where it has none (a straight run, or a
 *  route with more than one turn - a carry and a floor lane already own their channel). */
function verticalLeg(e: ExprEdge): number | null {
  if (e.carry) return null;
  const pts = e.points;
  if (pts.length !== 6) return null;
  if (Math.abs(pts[2]![0] - pts[3]![0]) > 0.5) return null;
  if (Math.abs(pts[2]![1] - pts[3]![1]) < 0.5) return null;
  return pts[2]![0];
}

type PillRef = { owner: string; param: ExprParam };

function wireFrames(nodes: ExprNode[], edges: ExprEdge[]): void {
  const byId = new Map(nodes.map((x) => [x.id, x] as const));
  for (const n of nodes) {
    if (n.resultFrom && n.resultX !== undefined) {
      const body = byId.get(n.resultFrom);
      if (body) {
        edges.push({
          from: body.id, to: n.id, row: -1, kind: "value",
          points: elbow(body.outX, body.outY, n.resultX, n.resultY ?? body.outY),
        });
      }
    }
    if (!n.params) continue;
    for (const p of n.params) {
      if (!p.carry || n.resultX === undefined) continue;
      // The accumulator's carry: out of the frame's result, back to the pill. It is the one
      // edge in a formula that runs right to left, so it is dashed and it routes UNDER the
      // frame rather than across the body it would otherwise cross.
      const under = (n.frame!.y + n.frame!.h) - PARAM_LANE - CARRY_LANE / 2 - FRAME_PAD / 2;
      edges.push({
        from: n.id, to: n.id, row: -1, carry: true, kind: "carry",
        points: [
          [n.resultX, n.resultY ?? p.outY],
          [n.resultX + 10, n.resultY ?? p.outY],
          [n.resultX + 10, under],
          [p.x - 10, under],
          [p.x - 10, p.outY],
          [p.x, p.outY],
        ],
      });
    }
  }
}

/** A wire that leaves a rail: out, turn at once, then one straight run to the socket. */
function railElbow(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const a: [number, number] = [x0, y0];
  const e: [number, number] = [x1, y1];
  if (Math.abs(y1 - y0) < 0.5) return [a, e];
  const turn = x0 + OUT_STUB;
  return [a, [turn, y0], [turn, y1], e];
}

function elbow(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const a: [number, number] = [x0, y0];
  const b: [number, number] = [x0 + OUT_STUB, y0];
  const d: [number, number] = [x1 - OUT_STUB, y1];
  const e: [number, number] = [x1, y1];
  if (Math.abs(y1 - y0) < 0.5) return [a, e];
  const mid = (b[0] + d[0]) / 2;
  return [a, b, [mid, y0], [mid, y1], d, e];
}

// ── edits: every one of them a splice ────────────────────────────────────────────────

export type ExprEditOp =
  /** Retype a literal in place: the row's mode decides how the value is spelled back. */
  | { op: "literal"; span: Span; value: string; mode: ValueMode }
  /** Replace a whole operand with arbitrary source - what unwiring, wiring and pasting all are. */
  | { op: "replace"; span: Span; text: string }
  /** Put the operand inside a template: `$` is where the old text lands. */
  | { op: "wrap"; span: Span; template: string }
  /** Lift a node's own operand up over it: the inverse of wrap. */
  | { op: "unwrap"; span: Span; inner: Span };

/** THE DOOR RE-ENCODES, and it refuses to touch the file for a no-op.
 *
 *  Every value the drawing hands out is DECODED - that is the whole point of reading the
 *  language rather than the transport - and the file holds the encoded form. Splicing a
 *  decoded value straight back turned `'&amp;lt;'` into `'&lt;'` on a rewrite that changed
 *  nothing, which is a corrupted file produced by pressing Save on an untouched row. The
 *  statement editor's own door (`applyFlowEdit`) has had both halves of this from the start;
 *  this one now matches it. */
export function applyExprEdit(source: string, edit: ExprEditOp, context: BodyContext = "text"): string {
  switch (edit.op) {
    case "literal": {
      // A ROW HANDED BACK ITS OWN VALUE MUST NOT TOUCH THE FILE, whatever escapes it holds.
      // `value` is the literal's inner text exactly as written, so comparing it against the
      // inner text still in the file settles it - `'\u0041'` re-emitted through the escaper
      // would come back `'\\u0041'` and read as a two-character diff on a row nobody edited.
      const held = decodeRange(source, edit.span, context).plain;
      if (edit.mode === "text" && held.length >= 2
        && (held[0] === "'" || held[0] === '"') && held[held.length - 1] === held[0]
        && held.slice(1, -1) === edit.value) return source;
      if (edit.mode !== "text" && held === edit.value) return source;
      return write(source, edit.span, modeSource(edit.value, edit.mode, quoteAt(source, edit.span, context)), context);
    }
    case "replace":
      return write(source, edit.span, edit.text, context);
    case "wrap": {
      const held = decodeRange(source, edit.span, context).plain;
      return write(source, edit.span, edit.template.replace(/\$/g, held), context);
    }
    case "unwrap":
      return write(source, edit.span, decodeRange(source, edit.inner, context).plain, context);
  }
}

/** The quote the author already used. Rewriting `"q"` as `'q'` dirties a file on a no-op. */
function quoteAt(source: string, span: Span, context: BodyContext): string | undefined {
  const held = decodeRange(source, span, context).plain.trim();
  return held.startsWith('"') ? '"' : held.startsWith("'") ? "'" : undefined;
}

function write(source: string, span: Span, text: string, context: BodyContext): string {
  const encoded = encodeFor(text, context);
  if (source.slice(span.start, span.end) === encoded) return source;
  return source.slice(0, span.start) + encoded + source.slice(span.end);
}

/** The inverse of `decodeRange`, per regime. A code-tag body must escape what the DOCUMENT
 *  grammar reserves (`&` and `<`); an attribute body must escape its delimiter and its
 *  newlines too, exactly as `encodeForBody` does for the statement editor. */
function encodeFor(text: string, context: BodyContext): string {
  if (context === "none") return text;
  const out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return context === "attr" ? out.replace(/"/g, "&quot;").replace(/\n/g, "&#10;") : out;
}

/** The write gate: the drawing is a projection of the file's bytes, so it reproduces them. */
export function reconstructExpr(flow: ExprFlow): string { return flow.raw; }

// ── what the picker offers ───────────────────────────────────────────────────────────

export type InsertableExpr = { species: Species; title: string; subtitle: string; template: string };

export function exprCatalog(): InsertableExpr[] {
  return [
    { species: "math", title: "Add", subtitle: "Two numbers together", template: "$ + 0" },
    { species: "math", title: "Subtract", subtitle: "One number from another", template: "$ - 0" },
    { species: "math", title: "Multiply", subtitle: "Two numbers", template: "$ * 1" },
    { species: "math", title: "Divide", subtitle: "One number by another", template: "$ / 1" },
    { species: "math", title: "Round", subtitle: "To the nearest whole number", template: "Math.round($)" },
    { species: "compare", title: "Is Equal To", subtitle: "Compare two values", template: "$ == ''" },
    { species: "compare", title: "Is Greater Than", subtitle: "Compare two numbers", template: "$ > 0" },
    { species: "logic", title: "And", subtitle: "Both must hold", template: "$ && true" },
    { species: "logic", title: "Or", subtitle: "Either may hold", template: "$ || false" },
    { species: "logic", title: "Not", subtitle: "Invert a switch", template: "!$" },
    { species: "logic", title: "Or Else", subtitle: "A fallback when there is nothing", template: "$ ?? ''" },
    { species: "decision", title: "Choose", subtitle: "One value or another", template: "$ ? '' : ''" },
    { species: "higher", title: "Map Over", subtitle: "One value out of every item", template: "$.map(item => item)" },
    { species: "higher", title: "Keep Where", subtitle: "Only the items that match", template: "$.filter(item => true)" },
    { species: "higher", title: "Fold Into", subtitle: "Reduce many values to one", template: "$.reduce((total, item) => total, 0)" },
    { species: "higher", title: "Sum Of", subtitle: "Add one field across every item", template: "$.sumBy(item => item)" },
    { species: "higher", title: "Sort By", subtitle: "Order by one field", template: "$.sortBy(item => item)" },
    { species: "higher", title: "Find First", subtitle: "The first item that matches", template: "$.find(item => true)" },
    { species: "collection", title: "List", subtitle: "Values in order", template: "[$]" },
    { species: "collection", title: "Record", subtitle: "Named fields", template: "{ value: $ }" },
    { species: "text", title: "Build Text", subtitle: "Text with values in it", template: "`${$}`" },
    { species: "call", title: "Join", subtitle: "One string out of a list", template: "$.join(', ')" },
    { species: "call", title: "Length", subtitle: "How many, or how long", template: "$.length" },
    { species: "unknown", title: "Custom Code", subtitle: "Anything JSE evaluates", template: "$" },
  ];
}
