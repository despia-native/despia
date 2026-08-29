//
//  legibility.ts - WHAT ONE FORMULA COSTS A READER, as text and as a drawing.
//
//  The Studio draws a JSE expression as a left-to-right node graph (exprflow.ts) and the same
//  expression exists as source text. The claim the whole surface rests on is that the diagram
//  is easier to read than the text. That is an opinion until something measures it, and an
//  unmeasured opinion is how a node editor ends up shipping a drawing that is complete,
//  correct, and worse than the characters it replaced.
//
//  THE UNIT IS A FIXATION. Both sides are priced in eye fixations, roughly a quarter second
//  of looking at one thing, because that is the only currency the two representations share -
//  characters and cards are not comparable, but the number of times a reader must stop and
//  resolve something is. Every weight below is "how many stops does this object cost", and
//  every one of them carries the reason it is the number it is. A weight with no argument
//  behind it is a weight somebody will tune until the answer is the one they wanted.
//
//  THE MODEL IS DELIBERATELY UNKIND TO THE DRAWING and it is stated here rather than buried:
//  it prices what the eye must resolve, and a diagram's win - that a shared subexpression is
//  ONE card with two wires where the text must spell it twice, that a wire says where a value
//  goes without the reader holding a name - is only partly visible to a fixation count. See
//  `expression-legibility.md`, "What this does not measure". The ratio therefore undersells
//  the diagram on exactly the axis where the diagram wins, which is the safe direction for a
//  number whose job is to fail a regression.
//
//  PURE AND TOTAL. No clock, no randomness, no filesystem. The same source always produces the
//  same record, so a recorded baseline is a fact and not a mood. The one printing thing in the
//  file is the script entry at the bottom, whose guard is false for every import.
//

import {
  lexExpression, METHOD_NAMES, HIGHER_ORDER,
  type Span, type BodyContext, type Tok,
} from "./expr.ts";
import { projectExpr, type ExprFlow } from "./exprflow.ts";

// ── the text side ────────────────────────────────────────────────────────────────────
//  A reader of code does not pay by the character. Four things cost them, and length is the
//  weakest of the four: `aVeryDescriptiveName + 1` is longer and easier than `a?.b??c[d]`.

/** ONE FIXATION PER TOKEN. Code is read denser than prose: eye-tracking of programmers puts
 *  roughly one fixation on each lexical token, where prose skips a third of its words. A
 *  token is therefore the honest atom of the text side, and the count comes from the repo's
 *  OWN lexer - the one the language uses - so nobody can argue the tokenisation. */
const W_TOKEN = 1.0;

/** AN OPERATOR IS NOT READ, IT IS ABSORBED. `(`, `,`, `.` and `+` are resolved in the
 *  parafovea on the way past far more often than they are fixated - which is exactly why the
 *  throwaway measurement this file replaces counted only operands and got a defensible answer
 *  by accident. Charging punctuation a third of a fixation says it shapes the read without
 *  usually stopping it, and it stops an 83-character chain from scoring as 37 stops when a
 *  fluent reader makes about twenty. */
const W_OPERATOR = 0.3;

/** A LEVEL OF BRACKET NESTING IS A REGRESSION PAIR. Every bracket the reader is inside is an
 *  item held open in working memory, and closing it costs a backward saccade to find the
 *  opener plus the fixation that returns. Measured on the PUNCTUATION, not on the parsed
 *  tree: `a + b * c` and `a + (b * c)` are the same tree and are not the same read, and a
 *  chain of same-precedence operators nests deeply in the tree while costing the eye nothing.
 *  A template's `${` opens a level too - it is a bracket with a longer spelling. */
const W_DEPTH = 2.0;

/** ABOUT FOUR THINGS ARE HELD AT ONCE, AND THE FIFTH COSTS A RE-READ. Working-memory capacity
 *  for unrelated chunks sits near four, so the first four distinct names in an expression are
 *  free - the fixation that read the token already paid for them - and every name past that
 *  is one the reader will have to go back and find. Names from the language's own vocabulary
 *  are never counted: nobody has to learn `filter` from this expression, they arrived knowing
 *  it. */
const FREE_NAMES = 4;
const W_NAME_OVER = 2.0;

/** WHERE A LINE STOPS BEING ONE OBJECT. A run of about eighty columns is what a reader
 *  crosses with the return saccade still landing where they expect; past that they lose their
 *  place, and an expression on one physical line has no left margin to recover it against.
 *  Each further run costs that lost landing plus the fixation that confirms the recovery. The
 *  charge is per RUN and not per character on purpose: a character in the tail is already
 *  paid for by its token, and charging it twice turns a long formula into a number driven
 *  entirely by its length, which is the crude measure this file exists to replace. */
const SACCADE_RUN = 80;
const W_OVERFLOW = 2.0;

/** The names the language brings with it. A reader pays for `lineTotal`, not for `toFixed`.
 *  The four literal keywords lex as identifiers here, so they are on the list too. */
const VOCABULARY: ReadonlySet<string> = new Set([
  "true", "false", "null", "undefined", "typeof", "in", "new",
]);

/** THE GLOBALS, AND THEIR MEMBERS WITH THEM. `Math.round` is two segments of vocabulary, not
 *  one of vocabulary and one name to learn - nobody reads `round` off a page and wonders what
 *  it is. So a path rooted at one of these has its first TWO segments waived and everything
 *  after them counted, which is right for `JSON.parse(text).items` too. */
const GLOBALS: ReadonlySet<string> = new Set([
  "Math", "JSON", "Date", "Object", "Number", "String", "Boolean", "Array", "Error",
]);

export type TextCost = {
  chars: number;
  /** Every lexical token, template holes included - the lexer stops at the backtick, a
   *  reader does not. */
  tokens: number;
  /** Operand tokens only (names and literals). The rest are operators and punctuation. */
  operands: number;
  /** Deepest bracket nesting. A flat expression is 0. */
  depth: number;
  /** Distinct authored names, vocabulary removed, dotted paths split into their segments -
   *  `r.total` introduces `r` and `total`, and the second `r.qty` introduces only `qty`. */
  names: number;
  /** Characters past the point where the line stops being one sweep. */
  overflow: number;
  total: number;
};

const OPENERS: ReadonlySet<string> = new Set(["(", "[", "{"]);
const CLOSERS: ReadonlySet<string> = new Set([")", "]", "}"]);

/** Every token a reader meets, and how deep in brackets the deepest of them sits. A template
 *  lexes as ONE token because the evaluator wants it whole; the reader reads every hole, so
 *  the walk recurses into them and each hole counts as a level of its own. */
function lexAll(src: string): { toks: Tok[]; depth: number } {
  const toks: Tok[] = [];
  let deepest = 0;
  const walk = (from: number, to: number, base: number): void => {
    let depth = base;
    for (const t of lexExpression(src, from, to)) {
      toks.push(t);
      if (t.kind === "op" && OPENERS.has(t.v)) { depth++; if (depth > deepest) deepest = depth; }
      else if (t.kind === "op" && CLOSERS.has(t.v)) depth = Math.max(base, depth - 1);
      for (const h of t.holes ?? []) {
        if (depth + 1 > deepest) deepest = depth + 1;
        walk(h.start, h.end, depth + 1);
      }
    }
  };
  walk(0, src.length, 0);
  return { toks, depth: deepest };
}

export function textCost(source: string): TextCost {
  const { toks, depth } = lexAll(source);
  const names = new Set<string>();
  let operands = 0;
  for (const t of toks) {
    if (t.kind === "op") continue;
    operands++;
    if (t.kind !== "ident") continue;
    // A dotted path introduces each of its segments: `r.total` brings `r` and `total`, and
    // the `r.qty` after it brings only `qty`.
    const parts = t.v.split(".");
    const from = parts[0] !== undefined && GLOBALS.has(parts[0]) ? 2 : 0;
    for (const part of parts.slice(from)) {
      if (part !== "" && !VOCABULARY.has(part)
        && !METHOD_NAMES.has(part) && !HIGHER_ORDER.has(part)) names.add(part);
    }
  }
  const longest = source.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  const overflow = Math.max(0, Math.ceil(longest / SACCADE_RUN) - 1);
  const total = operands * W_TOKEN
    + (toks.length - operands) * W_OPERATOR
    + depth * W_DEPTH
    + Math.max(0, names.size - FREE_NAMES) * W_NAME_OVER
    + overflow * W_OVERFLOW;
  return {
    chars: source.length, tokens: toks.length, operands, depth, names: names.size,
    overflow, total: round(total),
  };
}

// ── the drawing side ─────────────────────────────────────────────────────────────────
//  Not a node count. A node count says a drawing of two cards and forty wires is small.

/** A CARD'S HEAD IS THE MOST EXPENSIVE OBJECT ON THE CANVAS: a mark to classify, a title to
 *  read, and usually a subtitle under it. Three glyph runs inside one boundary, but tightly
 *  grouped enough that the parafovea gets some of it for free - so more than one fixation and
 *  well under three. */
const W_HEAD = 1.2;

/** AN OPERAND ROW is a name and a value side by side: two short reads in one 24px band, which
 *  the eye takes in fewer stops than two separate objects and more than one. */
const W_ROW = 0.8;

/** A SOCKET IS AN 8px DISC CARRYING ONE BIT - filled or hollow, wired or not. It must be
 *  resolved and classified and there is nothing to decode, which is the floor cost of any
 *  distinct object on a canvas. Fourteen of them on one drawing is two fixations, which is
 *  the right order: nobody reads sockets one at a time, and nobody sees none of them. */
const W_PORT = 0.15;

/** A PARAMETER PILL is a short name with a role under it, in a rail the eye finds once. */
const W_PILL = 0.6;

/** A FRAME is a wall plus an eyebrow of real words ("for each line"). Cheaper than a card
 *  head because the wall itself needs no decoding once classified. */
const W_FRAME = 0.9;

/** A CHIP stands in for a run the projection folded ("33 more, all Multiply"). One short read
 *  for the chip itself - AND A QUARTER OF A FIXATION FOR EACH ENTRY IT HID. A fold is the one
 *  move a projection can make that lowers every other term at once, so if hidden values were
 *  free this model would reward a canvas that draws nothing and says "40 more". They are not
 *  free: the reader who needs the eleventh entry expands the chip, re-reads a canvas that has
 *  just changed shape, and finds their place again. Charging a quarter says most readers
 *  accept the summary and some do not, which is the honest description of a fold. */
const W_CHIP = 0.5;
const W_HIDDEN = 0.25;

/** A WIRE THAT RUNS STRAIGHT BETWEEN ADJACENT CARDS IS ALMOST FREE. The eye leaves an output
 *  socket already pointed at the input, and the smooth-pursuit sweep along a straight rule
 *  needs no stop at all - this is the whole reason exprflow.ts puts the output socket on row
 *  0's line and draws a chain as one horizontal rule. What it costs is the acquisition. */
const W_WIRE = 0.15;

/** EVERY CORNER IS A DECISION POINT. At a turn the reader must re-acquire which line they
 *  were on, and an elbow with three turns has three chances to leave on the wrong one. This
 *  is the term that makes a routed spaghetti edge cost what it actually costs. */
const W_TURN = 0.25;

/** DISTANCE COSTS TOO, even in a straight line: past a couple of hundred pixels the far end
 *  is outside the perceptual span and following the wire becomes a sequence of hops rather
 *  than one sweep. One extra stop per 200px of wire. */
const W_WIRE_RUN = 0.1;
const WIRE_HOP_PX = 200;

/** A CROSSING IS THE STRONGEST SINGLE PREDICTOR IN THE GRAPH-DRAWING READABILITY LITERATURE,
 *  and the only one where the effect size is not in dispute: at the point where two lines
 *  meet, the reader has lost the guarantee that the line leaving is the line arriving, and
 *  recovering it means a regression back to the last unambiguous point. That is worth about
 *  what reading a card's title is worth, which is why one crossing here costs more than the
 *  wire it crosses. Crossings are counted from the ROUTED POLYLINES, exactly - see
 *  `countCrossings` - because a bounding-box guess reports crossings that are not there and
 *  a drawing then gets "fixed" for a defect it does not have. */
const W_CROSS = 1.5;

/** THE VIEWPORT the Studio's canvas actually gets: a 1680x1050 laptop with the rail, the
 *  navigator and the inspector taken off it is close enough to this that rounding it further
 *  would be false precision. */
const VIEW_W = 1680;
const VIEW_H = 1050;

/** A DRAWING THAT DOES NOT FIT LEAVES THE READER TWO ESCAPES and they take the cheaper one,
 *  so the model charges the cheaper one. PAN: every extra viewport-tile of content is a
 *  screenful acquired, held, and then lost when the next screenful arrives. ZOOM: shrink
 *  until it fits, and pay when the labels stop being words. An 11px label at 0.75 zoom is
 *  8.25px, which is under the size at which a word resolves as a word rather than a grey
 *  bar; below that the drawing is a shape and the reader must zoom back in to read anything,
 *  which is panning again with extra steps. */
const W_PAN = 2.0;
const W_ZOOM = 8.0;
const LEGIBLE_ZOOM = 0.75;

/** A HOP ALONG THE CRITICAL CHAIN is a value carried forward: the reader cannot understand
 *  the Result without walking the whole chain in order, holding each intermediate. That is a
 *  working-memory carry on top of the wire's own following cost, which is already charged. */
const W_HOP = 0.4;

/** FOLLOWING A LONG CHAIN COSTS ITS LENGTH. One stop per thousand pixels travelled along the
 *  critical path, cards included - the eye crosses the card as well as the wire. */
const W_TRAVEL = 1.0;
const TRAVEL_PX = 1000;

/** A LAYER OF CONTAINMENT IS A BOX ON A STACK, the drawing's exact analogue of the text's
 *  nesting depth. It is charged HALF what the text's depth level is charged, and that is not
 *  a thumb on the scale in the diagram's favour - it is the one place the diagram plainly
 *  wins: the box has a drawn wall and an eyebrow that names it, so the reader is reminded
 *  what they are inside of instead of remembering it. */
const W_LAYER = 1.0;

/** REPETITION IS A DISCOUNT, NOT A COST. Forty rows that all read `Multiply` are not forty
 *  reads: after the third the reader is confirming rather than decoding. What they save is
 *  the decoding half of a labelled object, never the confirming half, so the relief is capped
 *  at half the labelled object's weight and scaled by how predictable the label plane
 *  actually is. Predictability is measured with Shannon entropy over the visible labels,
 *  which is the honest measure and also the only one that treats "forty of one label" and
 *  "twenty of one and twenty of another" differently - and they are different drawings. */
const W_REPEAT_RELIEF = 0.5;

/** EVERY WEIGHT IN ONE PLACE, so the doc can print them and a test can reason about them
 *  without re-deriving the arithmetic. The reasons are on the declarations above; this is the
 *  index, not the argument. */
export const WEIGHTS = Object.freeze({
  token: W_TOKEN, operator: W_OPERATOR, depth: W_DEPTH, nameOver: W_NAME_OVER,
  freeNames: FREE_NAMES, overflow: W_OVERFLOW, saccadeRun: SACCADE_RUN,
  head: W_HEAD, row: W_ROW, port: W_PORT, pill: W_PILL, frame: W_FRAME,
  chip: W_CHIP, hidden: W_HIDDEN,
  wire: W_WIRE, turn: W_TURN, wireRun: W_WIRE_RUN, wireHopPx: WIRE_HOP_PX,
  cross: W_CROSS,
  pan: W_PAN, zoom: W_ZOOM, legibleZoom: LEGIBLE_ZOOM, viewW: VIEW_W, viewH: VIEW_H,
  hop: W_HOP, travel: W_TRAVEL, travelPx: TRAVEL_PX,
  layer: W_LAYER, repeatRelief: W_REPEAT_RELIEF,
});

export type DrawCost = {
  /** Weighted count of everything the eye must resolve and classify. */
  objects: number;
  /** Weighted wires: acquisition, corners, and distance. */
  wires: number;
  /** Weighted crossings. */
  crossings: number;
  /** Pan or shrink, whichever is cheaper. */
  extent: number;
  /** The critical chain: its hops and how far the eye travels along it. */
  path: number;
  /** Frames the reader is inside at the deepest point. */
  containment: number;
  /** Negative. What the label plane's redundancy gives back. */
  repetition: number;
  total: number;
};

/** The raw drawing, before any weight is applied. Published because a weighted total nobody
 *  can decompose is a total nobody will trust, and because a regression is usually visible
 *  in one of these before it is visible in the total. */
export type Census = {
  nodes: number;
  rows: number;
  ports: number;
  edges: number;
  /** Corners across every routed polyline. */
  turns: number;
  /** Total wire length in pixels. */
  wirePx: number;
  crossings: number;
  frames: number;
  pills: number;
  chips: number;
  /** Entries the chips stand in for - values the drawing has and does not show. */
  hidden: number;
  width: number;
  height: number;
  /** Viewport tiles the drawing occupies at 1:1. */
  viewports: number;
  /** The zoom at which the whole drawing fits one viewport, capped at 1. */
  fitZoom: number;
  /** Nodes on the longest leaf-to-Result chain. */
  chain: number;
  /** Pixels the eye travels along that chain, cards included. */
  travelPx: number;
  /** Deepest frame nesting. 0 means nothing is inside anything. */
  layers: number;
  /** Visible label strings, and how many of them are distinct. */
  labels: number;
  distinctLabels: number;
  /** Shannon entropy over the label multiset, in bits. */
  entropyBits: number;
  /** 0 when every label is distinct, 1 when they are all the same word. */
  redundancy: number;
};

export type Legibility = {
  source: string;
  text: TextCost;
  draw: DrawCost;
  census: Census;
  /** Drawing cost over text cost. Above 1 the drawing is the more expensive read. */
  ratio: number;
};

// ── crossings, counted properly ──────────────────────────────────────────────────────

/** Two segments cross when each strictly separates the other's endpoints. That single test
 *  settles the three cases a crossing counter is usually wrong about, and each of them is a
 *  decision worth stating rather than a consequence worth discovering:
 *
 *  - SHARED ENDPOINT: two wires leaving one output socket. Not a crossing. The reader is at
 *    a fan-out, which is a place where the drawing is TELLING them one value goes two ways.
 *  - T-JUNCTION: one wire's endpoint sitting on another's interior. Not a crossing either,
 *    for the same reason - it happens where a wire lands on a socket.
 *  - COLLINEAR OVERLAP: two wires running along the same rule for a stretch, which is what
 *    the fan-out from a socket does for its first ten pixels. NOT counted, on purpose: the
 *    pair reads as one bundle that splits, and charging it as a crossing would charge the
 *    projection for the one thing it does to AVOID crossings. The cost of an overlap is that
 *    it hides a wire, which is a different defect and belongs to a different measurement.
 *
 *  Adjacent segments of one polyline share an endpoint by construction and are skipped;
 *  non-adjacent ones are compared, so a polyline that crosses itself is counted. */
export function countCrossings(polylines: readonly (readonly (readonly [number, number])[])[]): number {
  type Seg = { line: number; index: number; ax: number; ay: number; bx: number; by: number };
  const segs: Seg[] = [];
  polylines.forEach((pts, line) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      if (a[0] === b[0] && a[1] === b[1]) continue;   // a zero-length joint is not a segment
      segs.push({ line, index: segs.length, ax: a[0], ay: a[1], bx: b[0], by: b[1] });
    }
  });
  let hits = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i]!, q = segs[j]!;
      if (p.line === q.line && Math.abs(p.index - q.index) === 1) continue;
      if (strictlyCross(p, q)) hits++;
    }
  }
  return hits;
}

type Seg = { ax: number; ay: number; bx: number; by: number };

function side(a: Seg, x: number, y: number): number {
  const v = (a.bx - a.ax) * (y - a.ay) - (a.by - a.ay) * (x - a.ax);
  // A wire is routed on whole pixels; anything under a hundredth of a pixel-squared is the
  // float noise of the multiply, not a side.
  return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
}

function strictlyCross(p: Seg, q: Seg): boolean {
  const d1 = side(p, q.ax, q.ay);
  const d2 = side(p, q.bx, q.by);
  const d3 = side(q, p.ax, p.ay);
  const d4 = side(q, p.bx, p.by);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
}

// ── the drawing's census and its price ───────────────────────────────────────────────

function polylineLength(pts: readonly (readonly [number, number])[]): number {
  let d = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    d += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  }
  return d;
}

/** A corner, not a vertex: three collinear points are one straight run and cost nothing. */
function turns(pts: readonly (readonly [number, number])[]): number {
  let n = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-9) n++;
  }
  return n;
}

/** ONE OBJECT'S VISIBLE TEXT, JOINED WITHOUT A SEPARATOR TO JOIN IT WITH. A row reading
 *  `x y | z` and a row reading `x | y z` are two different rows, and any delimiter picked to
 *  glue the parts together is a delimiter some label can contain - the entropy term would
 *  then quietly count two distinct objects as one repeat. JSON does the quoting, so the
 *  question does not arise and the choice is not an invisible assumption. */
function label(...parts: string[]): string { return JSON.stringify(parts); }

/** Every string the drawing puts in front of the reader. A label the eye never decodes is not
 *  on this list, which is why a socket contributes none and a folded chip contributes one. */
function labelsOf(flow: ExprFlow): string[] {
  const out: string[] = [];
  for (const n of flow.nodes) {
    out.push(label(n.title, n.subtitle));
    for (const r of n.rows) {
      out.push(label(r.name, r.wired ? (r.fromTitle ?? "") : (r.blank ?? r.value)));
    }
    for (const p of n.params ?? []) out.push(label(p.name, p.role));
    if (n.frame) out.push(label(n.frame.lead, n.frame.item, n.frame.carry));
    if (n.chip !== undefined) out.push(label(n.chip));
  }
  return out;
}

function entropyBits(labels: readonly string[]): number {
  if (labels.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / labels.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** The longest chain a reader must walk from a leaf to the Result, and the distance along it.
 *  Carry edges are excluded: a reduce's accumulator runs backwards and is not part of any
 *  forward reading order - counting it would make the chain a cycle. */
function criticalPath(flow: ExprFlow): { chain: number; travelPx: number } {
  const width = new Map(flow.nodes.map((n) => [n.id, n.w] as const));
  const incoming = new Map<string, { from: string; px: number }[]>();
  for (const e of flow.edges) {
    if (e.carry || e.from === e.to) continue;
    const list = incoming.get(e.to) ?? [];
    list.push({ from: e.from, px: polylineLength(e.points) });
    incoming.set(e.to, list);
  }
  // AN ABUTMENT IS AN EDGE OF ZERO LENGTH. When the projection sets a producer against its
  // consumer's leading wall, the seam carries the value and no wire is drawn - which is the
  // point, since a seam costs no tracing. It is still a step in the reading order, so the
  // path has to walk it or a fully abutted drawing reports no route to its own Result.
  for (const n of flow.nodes) {
    if (!n.abuts || n.abuts.to === n.id) continue;
    const list = incoming.get(n.abuts.to) ?? [];
    list.push({ from: n.id, px: 0 });
    incoming.set(n.abuts.to, list);
  }
  const seen = new Set<string>();
  const memo = new Map<string, { chain: number; travelPx: number }>();
  const walk = (id: string): { chain: number; travelPx: number } => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (seen.has(id)) return { chain: 0, travelPx: 0 };   // a projection defect, not a crash
    seen.add(id);
    let best = { chain: 1, travelPx: width.get(id) ?? 0 };
    for (const back of incoming.get(id) ?? []) {
      const up = walk(back.from);
      const chain = up.chain + 1;
      const travelPx = up.travelPx + back.px + (width.get(id) ?? 0);
      if (chain > best.chain || (chain === best.chain && travelPx > best.travelPx)) {
        best = { chain, travelPx };
      }
    }
    seen.delete(id);
    memo.set(id, best);
    return best;
  };
  // The Result is usually its own card, but a small enough expression FOLDS into a single
  // card that is both the work and the answer, and then there is no `output` node to walk
  // back from. The terminal card is whatever nothing else consumes; for a folded drawing
  // that is the one card, and its chain is 1 - you read it once. Reporting 0 there would
  // say the drawing has no reading path, which is the opposite of what a fold achieves.
  const out = flow.nodes.find((n) => n.kind === "output");
  if (out) return walk(out.id);
  const consumed = new Set<string>();
  for (const e of flow.edges) if (!e.carry && e.from !== e.to) consumed.add(e.from);
  for (const n of flow.nodes) if (n.abuts) consumed.add(n.id);
  const terminal = flow.nodes.filter((n) => !consumed.has(n.id));
  if (terminal.length === 0) return { chain: 0, travelPx: 0 };
  return terminal.map((n) => walk(n.id))
    .reduce((a2, b2) => (b2.chain > a2.chain ? b2 : a2));
}

export function census(flow: ExprFlow): Census {
  let rows = 0, pills = 0, frames = 0, chips = 0, hidden = 0, layers = 0, resultPorts = 0;
  for (const n of flow.nodes) {
    rows += n.rows.length;
    pills += n.params?.length ?? 0;
    if (n.frame) frames++;
    if (n.resultX !== undefined) resultPorts++;
    if (n.chip !== undefined) {
      chips++;
      // The projection spells a fold "33 more, all Multiply". The count is the drawing's own
      // statement of what it is not showing, so it is read from there rather than guessed.
      hidden += Number(/^(\d+)/.exec(n.chip)?.[1] ?? 0);
    }
    if (n.depth > layers) layers = n.depth;
  }
  let turnCount = 0, wirePx = 0;
  for (const e of flow.edges) {
    turnCount += turns(e.points);
    wirePx += polylineLength(e.points);
  }
  const labels = labelsOf(flow);
  const h = entropyBits(labels);
  const distinct = new Set(labels).size;
  // Redundancy against the entropy of an all-distinct plane of the same size: 0 when every
  // label says something new, 1 when they all say the same thing.
  const hMax = labels.length > 1 ? Math.log2(labels.length) : 0;
  const redundancy = hMax > 0 ? clamp01(1 - h / hMax) : 0;
  const path = criticalPath(flow);
  const w = Math.max(1, flow.width), hgt = Math.max(1, flow.height);
  return {
    nodes: flow.nodes.length,
    rows,
    // Every row has a socket whether it is wired or not, every card has its output, every
    // pill has one, and a frame has the one its body's result lands on.
    ports: rows + flow.nodes.length + pills + resultPorts,
    edges: flow.edges.length,
    turns: turnCount,
    wirePx: round(wirePx),
    crossings: countCrossings(flow.edges.map((e) => e.points)),
    frames, pills, chips, hidden,
    width: flow.width, height: flow.height,
    viewports: Math.ceil(w / VIEW_W) * Math.ceil(hgt / VIEW_H),
    fitZoom: round(Math.min(1, VIEW_W / w, VIEW_H / hgt)),
    chain: path.chain,
    travelPx: round(path.travelPx),
    layers,
    labels: labels.length,
    distinctLabels: distinct,
    entropyBits: round(h),
    redundancy: round(redundancy),
  };
}

export function drawCost(flow: ExprFlow): DrawCost {
  const c = census(flow);
  const labelled = c.nodes + c.rows + c.pills + c.frames + c.chips;
  const objects = c.nodes * W_HEAD + c.rows * W_ROW + c.ports * W_PORT
    + c.pills * W_PILL + c.frames * W_FRAME + c.chips * W_CHIP + c.hidden * W_HIDDEN;
  const wires = c.edges * W_WIRE + c.turns * W_TURN + (c.wirePx / WIRE_HOP_PX) * W_WIRE_RUN;
  const crossings = c.crossings * W_CROSS;
  const pan = Math.max(0, c.viewports - 1) * W_PAN;
  const zoom = Math.max(0, (LEGIBLE_ZOOM - c.fitZoom) / LEGIBLE_ZOOM) * W_ZOOM;
  const extent = Math.min(pan, zoom);
  const path = Math.max(0, c.chain - 1) * W_HOP + (c.travelPx / TRAVEL_PX) * W_TRAVEL;
  const containment = c.layers * W_LAYER;
  const repetition = -(c.redundancy * labelled * W_REPEAT_RELIEF);
  const total = objects + wires + crossings + extent + path + containment + repetition;
  return {
    objects: round(objects), wires: round(wires), crossings: round(crossings),
    extent: round(extent), path: round(path), containment: round(containment),
    repetition: round(repetition), total: round(total),
  };
}

// ── the measurement ──────────────────────────────────────────────────────────────────

/** One expression, both costs, and the ratio between them. Total over anything the
 *  projection is total over, which is every form in the grammar. */
export function legibility(source: string, span?: Span, context: BodyContext = "text"): Legibility {
  const flow = projectExpr(source, span, context);
  const text = textCost(flow.source);
  const draw = drawCost(flow);
  const c = census(flow);
  // A drawing always has at least the Result card, so the text cost is the only side that can
  // reach zero (an empty span). Guard it rather than publish an Infinity nobody can compare.
  const ratio = text.total > 0 ? draw.total / text.total : 0;
  return { source: flow.source, text, draw, census: c, ratio: round(ratio) };
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── the corpora this instrument is pointed at ────────────────────────────────────────

/** TWENTY FORMULAS SOMEBODY WOULD ACTUALLY WRITE, ordered by size. Not the grammar corpus -
 *  `expr-corpus.ts` exists to cover every FORM, which means it is full of `a?.b?.c` and other
 *  shapes chosen for the parser rather than by an author. This list is what the ratio is
 *  quoted on, so it is the one that has to be honest about the distribution of real work: a
 *  bare reference and a negation at one end, a filter-map-reduce chain at the other, and the
 *  middle full of the arithmetic, comparison and fallback a screen actually binds. */
export const REALISTIC_TWENTY: readonly string[] = [
  "total",
  "!done",
  "price * qty",
  "n.toFixed(2)",
  "subtotal + tax",
  "items.length > 0",
  "user.name ?? 'Anon'",
  "user.email.trim().toLowerCase()",
  "qty * price * (1 + taxRate)",
  "status == 'paid' ? 'Paid' : 'Due'",
  "Math.round(order.total * 100) / 100",
  "user.profile?.displayName ?? user.email",
  "`${user.firstName} ${user.lastName}`.trim()",
  "rows.map(r => r.total).join(', ')",
  "cart.items.length == 0 ? 'Empty' : `${cart.items.length} items`",
  "items.filter(i => i.status == 'open').length > 0",
  "products.filter(p => p.price >= min && p.price <= max).sortBy(p => p.price)",
  "regions.map(r => ({ name: r.name, open: r.stores.filter(s => s.open).length }))",
  "rows.reduce((sum, r) => sum + r.total * r.qty, 0).toFixed(2)",
  "rows.filter(r => r.q > 0).map(r => r.q * r.p).reduce((a, b) => a + b, 0).toFixed(2)",
];

/** THE EIGHTEEN THE BROWSER ORACLE DRAWS. Restated here rather than imported, because
 *  `packages/dom/oracle/expression-canvas-browser.ts` launches a browser at module load and a
 *  cost model must not need Chromium to run. `legibility.test.ts` reads that file as TEXT and
 *  fails if the two lists have drifted apart, so the duplication cannot rot quietly. */
const chain12 = "raw.trim().toLowerCase().replaceAll(' ', '-').slice(0, 40).padEnd(40, '.')"
  + ".split('-').join('_').toUpperCase().trim().concat('!').repeat(2).slice(0, 60)";
const sum40 = Array.from({ length: 40 }, (_, i) => `p${i}.price * p${i}.qty`).join(" + ");
const record30 = "{ " + Array.from({ length: 30 }, (_, i) =>
  (i % 5 === 0 ? `f${i}: row.a${i} * 2` : `f${i}: ${i}`)).join(", ") + " }";
function deep30Of(): string {
  let d = "seed";
  for (let i = 0; i < 30; i++) d = `Math.round(${d} * ${i + 1})`;
  return d;
}
const matrix = "regions.map(r => ({ region: r.name, revenue: r.stores"
  + ".filter(s => s.open).map(s => s.orders.reduce((t, o) => t + o.total * (1 - o.discount), 0))"
  + ".reduce((t, n) => t + n, 0) }))";

export const ORACLE_FIXTURES: readonly { name: string; expr: string }[] = [
  { name: "chain", expr: "user.email.trim().toLowerCase()" },
  { name: "arithmetic", expr: "(subtotal + shipping) * (1 + taxRate) - discount" },
  { name: "compare", expr: "order.total >= 100 && customer.tier != 'free'" },
  { name: "choose", expr: "cart.items.length == 0 ? 'Your cart is empty' : `${cart.items.length} items`" },
  { name: "map", expr: "products.map(p => ({ id: p.id, label: p.name, price: p.price * 1.2 }))" },
  { name: "filtersort", expr: "products.filter(p => p.price >= min && p.inStock).sortBy(p => p.price)" },
  { name: "reduce", expr: "order.lines.reduce((total, line) => total + line.price * line.qty, 0).toFixed(2)" },
  { name: "nested", expr: "teams.map(t => ({ name: t.name, open: t.tickets.filter(i => i.state == 'open').length }))" },
  { name: "record", expr: "{ id: order.id, when: order.createdAt, total: order.total, paid: order.status == 'paid', note: '' }" },
  { name: "list", expr: "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, count * 2, 27, 28]" },
  { name: "coalesce", expr: "user.profile?.displayName ?? user.email ?? 'Someone'" },
  { name: "wide", expr: "a1 + a2 * a3 - a4 / a5 + f(a6, a7) + [a8, a9].join('') + (a10 > a11 ? a12 : a13) + `${a14}`" },
  { name: "chain12", expr: chain12 },
  { name: "sum40", expr: sum40 },
  { name: "record30", expr: record30 },
  { name: "deep30", expr: deep30Of() },
  { name: "matrix", expr: matrix },
  { name: "quotes", expr: "join(sep == '' ? ' ' : sep, [a, 'b c', ''])" },
];

// ── the gate's recorded baseline ─────────────────────────────────────────────────────

/** THE DRAWING'S COST ON THE EIGHTEEN ORACLE FIXTURES, AS MEASURED, RECORDED 2026-08-25.
 *
 *  This is a HARDCODED CENSUS in the sense `check_editor_scale.rb` and
 *  `check_renderer_constants.rb` use the term: it is not a target anybody chose, it is what
 *  the projection currently does, written down so the NEXT change to the projection has to
 *  say what it did to these numbers. `legibility.test.ts` fails when any fixture's drawing
 *  cost rises past BASELINE_TOLERANCE.
 *
 *  RE-RECORDING IT IS A DELIBERATE ACT, and the rule is the repo's: a number moves only with
 *  the landed change named in the commit that moves it.
 *    1. `cd OpenSource/Web && node packages/cli/src/legibility.ts --baseline`
 *    2. paste the block it prints over the one below
 *    3. in the same commit, name the projection change that moved each number, and re-run
 *       `node packages/dom/oracle/expression-canvas-browser.ts` - a cost that fell while the
 *       oracle's own findings rose is a cost that fell for the wrong reason
 *  A number that falls is the point of the instrument. A number that rises with no named
 *  cause is the regression it exists to catch, and re-recording it is the one move this
 *  comment exists to make embarrassing. */
// RE-RECORDED when the projection was rebuilt to cost less: ROW_CAP fell from 24 to 8 and a
// chained producer now ABUTS its consumer instead of running a wire to it. Sixteen of the
// eighteen fixtures got cheaper, several by an order of magnitude, and the median DRAW/TEXT
// ratio went from 1.86 to 0.68 - the crossover the canvas did not have before.
// Two got dearer and both are named: reduce 27.65 -> 28.05 and matrix 67.24 -> 68.91, which
// is the two and four crossings the fold introduced by pulling wires into a shorter band.
// That is 1.5 a crossing against hundreds saved, so it stands, but it is recorded rather
// than absorbed: if a later change makes those two worse again, this is the number to beat.
export const BASELINE: Readonly<Record<string, number>> = {
  arithmetic: 9.46,
  chain: 2.53,
  chain12: 32.6,
  choose: 4.5,
  coalesce: 4.48,
  compare: 3.52,
  deep30: 124.99,
  filtersort: 20.62,
  list: 8.98,
  map: 20.63,
  matrix: 68.91,
  nested: 27.29,
  quotes: 10.37,
  record: 6.36,
  record30: 9.5,
  reduce: 28.05,
  sum40: 16.99,
  wide: 19.26,
};

/** Float arithmetic over a layout that moves by whole pixels does not drift, so the tolerance
 *  is not for noise - it is the width of the change a reader would not notice. A tenth of a
 *  fixation on a fifty-fixation drawing is well under that. */
export const BASELINE_TOLERANCE = 0.1;

// ── the report ───────────────────────────────────────────────────────────────────────

function pad(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function padr(s: string, w: number): string { return s.length >= w ? s : s + " ".repeat(w - s.length); }
function fixed(n: number, d: number): string { return n.toFixed(d); }

const COLUMNS: { head: string; w: number; of: (m: Legibility) => string }[] = [
  { head: "chars", w: 5, of: (m) => String(m.text.chars) },
  { head: "tok", w: 4, of: (m) => String(m.text.tokens) },
  { head: "dep", w: 3, of: (m) => String(m.text.depth) },
  { head: "name", w: 4, of: (m) => String(m.text.names) },
  { head: "TEXT", w: 6, of: (m) => fixed(m.text.total, 1) },
  { head: "obj", w: 5, of: (m) => fixed(m.draw.objects, 1) },
  { head: "wire", w: 5, of: (m) => fixed(m.draw.wires, 1) },
  { head: "xing", w: 4, of: (m) => String(m.census.crossings) },
  { head: "ext", w: 4, of: (m) => fixed(m.draw.extent, 1) },
  { head: "path", w: 5, of: (m) => fixed(m.draw.path, 1) },
  { head: "nest", w: 4, of: (m) => fixed(m.draw.containment, 1) },
  { head: "rep", w: 6, of: (m) => fixed(m.draw.repetition, 1) },
  { head: "DRAW", w: 7, of: (m) => fixed(m.draw.total, 1) },
  { head: "ratio", w: 6, of: (m) => fixed(m.ratio, 2) },
];

/** The table the doc publishes, so its numbers are generated rather than typed. Pure: it
 *  takes the rows it is asked for and returns a string. */
export function report(rows: readonly { name: string; expr: string }[]): string {
  const measured = rows.map((r) => ({ name: r.name, m: legibility(r.expr) }));
  const nameW = Math.max(4, ...measured.map((r) => Math.min(r.name.length, 76)));
  const head = COLUMNS.map((c) => pad(c.head, c.w)).join(" ") + "  " + padr("source", nameW);
  const rule = COLUMNS.map((c) => "-".repeat(c.w)).join(" ") + "  " + "-".repeat(nameW);
  const body = measured.map((r) =>
    COLUMNS.map((c) => pad(c.of(r.m), c.w)).join(" ") + "  " + r.name);
  return [head, rule, ...body].join("\n");
}

/** p50/p90/p99 of the ratio over a corpus, and where the drawing stops being the dearer read.
 *  Percentiles are nearest-rank on the sorted sample - no interpolation, because an
 *  interpolated percentile of 194 discrete drawings is a number that does not correspond to
 *  any drawing. */
export function distribution(sources: readonly string[]): {
  n: number; p50: number; p90: number; p99: number; min: number; max: number;
  /** The smallest token count at or above which EVERY measured expression has ratio <= 1, or
   *  null when no such point exists in the sample. */
  crossover: number | null;
  worst: { source: string; ratio: number }[];
  /** The same sample ranked by how many fixations the drawing costs OVER the text. The ratio's
   *  worst end is always the degenerate forms - a drawing of one literal has a floor of two
   *  cards and a wire, so its ratio is enormous and its excess is four fixations. A target
   *  list wants the drawings that waste the most looking, which is this one. */
  worstByExcess: { source: string; excess: number; ratio: number }[];
} {
  const all = sources.map((s) => {
    const m = legibility(s);
    return { source: s, ratio: m.ratio, tokens: m.text.tokens, excess: round(m.draw.total - m.text.total) };
  });
  const sorted = [...all].map((r) => r.ratio).sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const byTokens = [...all].sort((a, b) => a.tokens - b.tokens);
  let crossover: number | null = null;
  for (let i = 0; i < byTokens.length; i++) {
    if (byTokens.slice(i).every((r) => r.ratio <= 1)) { crossover = byTokens[i]!.tokens; break; }
  }
  const worst = [...all].sort((a, b) => b.ratio - a.ratio || a.source.localeCompare(b.source))
    .slice(0, 10).map((r) => ({ source: r.source, ratio: r.ratio }));
  const worstByExcess = [...all].sort((a, b) => b.excess - a.excess || a.source.localeCompare(b.source))
    .slice(0, 10).map((r) => ({ source: r.source, excess: r.excess, ratio: r.ratio }));
  return {
    n: all.length, p50: at(0.5), p90: at(0.9), p99: at(0.99),
    min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0,
    crossover, worst, worstByExcess,
  };
}

/** The BASELINE block above, regenerated. Printing source is the whole point: re-recording is
 *  a paste and a justification, not an edit in eighteen places. */
export function baselineBlock(): string {
  const rows = [...ORACLE_FIXTURES]
    .map((f) => ({ name: f.name, cost: legibility(f.expr).draw.total }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return "export const BASELINE: Readonly<Record<string, number>> = {\n"
    + rows.map((r) => `  ${r.name}: ${r.cost},`).join("\n")
    + "\n};";
}

// A SCRIPT ENTRY, not a side effect: the guard is false for every import, so the model stays
// pure for its callers and the re-record instruction above stays one line a person can type.
//   node packages/cli/src/legibility.ts            the twenty, the oracle eighteen, the corpus
//   node packages/cli/src/legibility.ts --baseline the BASELINE block, ready to paste
if (typeof process !== "undefined" && (process.argv[1] ?? "").endsWith("legibility.ts")) {
  if (process.argv.includes("--baseline")) {
    console.log(baselineBlock());
  } else {
    console.log(report(REALISTIC_TWENTY.map((e) => ({ name: e, expr: e }))));
    console.log("");
    console.log(report([...ORACLE_FIXTURES]));
  }
}
