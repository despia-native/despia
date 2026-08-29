//
//  flowcost.ts - WHAT ONE ACTION BODY COSTS A READER, as text and as a drawing.
//
//  Named `flowcost` and not `statement-legibility` for a reason worth knowing before you
//  rename it: `legibility.ts` ends in a script entry guarded by `argv[1].endsWith(
//  "legibility.ts")`, and every path ending in those characters matches it - so a sibling
//  called `*-legibility.ts` runs the expression report the moment anything imports it.
//
//  THE SECOND CANVAS. `legibility.ts` prices the EXPRESSION projection (exprflow.ts): one
//  formula drawn left to right, one card per sub-expression. This file prices the STATEMENT
//  projection (nodeflow.ts): one action body drawn top to bottom, one card per statement,
//  branches as lanes, loops as containers. They are different propositions and the same
//  question - is the drawing cheaper to read than the characters it replaced - so they share
//  a unit, share every weight that means the same thing on both canvases, and are argued
//  apart only where the canvases really differ. Every divergence is named on its weight and
//  tabulated in `statement-legibility.md`.
//
//  THE UNIT IS A FIXATION, imported wholesale from the sibling: roughly a quarter second of
//  looking at one thing, the only currency characters and cards share. The text side of one
//  statement is `textCost` from `legibility.ts`, called UNCHANGED - a statement is one
//  expression's worth of reading, so re-deriving its price here would be a second opinion
//  about the same characters.
//
//  THE MODEL IS UNKIND TO THE DRAWING, deliberately and in the same direction as the sibling.
//  Two rules keep it honest rather than merely harsh:
//    1. A COST BOTH SIDES PAY IDENTICALLY IS NOT CHARGED. The variables a reader carries from
//       statement to statement, the words inside a comment - both representations show the
//       same names and the same prose. Charging a wash to both sides drags the ratio toward
//       1.0, which flatters whichever side is losing. The model prices only what the two
//       representations do DIFFERENTLY.
//    2. WHERE THE DRAWING PRINTS THE SOURCE, IT PAYS THE SOURCE'S PRICE. An argument row
//       holding `total * 100 + tip` puts those characters in front of the reader exactly as
//       the file does, so the row is charged the label plus what that expression costs as
//       text. This is the term that catches a drawing whose nodes are a second copy of the
//       code, which is the disease the expression audit found on the other canvas.
//
//  PURE AND TOTAL. No clock, no randomness, no filesystem, so the same body always produces
//  the same record and a recorded baseline is a fact rather than a mood. The one printing
//  thing in the file is the script entry at the bottom, whose guard is false for every
//  import. The walk over the real workload needs the filesystem, so it lives beside the
//  corpus it harvests, in `packages/cli/test/statement-corpus.ts`.
//

import { projectCfg, type Region } from "./cfg.ts";
import {
  projectFlow, statementSpans, scanComments, decode,
  type Flow, type FlowNode, type StatementSpan,
} from "./nodeflow.ts";
import { lexExpression, METHOD_NAMES, HIGHER_ORDER } from "./expr.ts";
import { textCost, countCrossings, WEIGHTS } from "./legibility.ts";

// - what transfers from the expression instrument, unchanged - //  Same object, same price. A card head is a card head on either canvas; a wire is a wire.
//  Re-declaring these with new numbers would mean the repo held two opinions about one
//  object, so they are READ OFF the sibling rather than copied.

const W_HEAD = WEIGHTS.head;          // 1.2  mark + title + subtitle in one boundary
const W_ROW = WEIGHTS.row;            // 0.8  a label and a value in one 24px band
const W_PILL = WEIGHTS.pill;          // 0.6  a short word in its own shape
const W_BEAD = WEIGHTS.port;          // 0.15 an 8-9px disc carrying one bit
const W_WIRE = WEIGHTS.wire;          // 0.15 acquiring a connector
const W_TURN = WEIGHTS.turn;          // 0.25 every corner is a decision point
const W_WIRE_RUN = WEIGHTS.wireRun;   // 0.1  per 200px of following
const WIRE_HOP_PX = WEIGHTS.wireHopPx;
const W_CROSS = WEIGHTS.cross;        // 1.5  the one effect size nobody disputes
const W_HIDDEN = WEIGHTS.hidden;      // 0.25 per entry a fold does not show
const W_PAN = WEIGHTS.pan;            // 2.0  per extra viewport tile
const W_ZOOM = WEIGHTS.zoom;          // 8.0  scaled by how far the fit falls under legible
const LEGIBLE_ZOOM = WEIGHTS.legibleZoom;
const VIEW_W = WEIGHTS.viewW;
const VIEW_H = WEIGHTS.viewH;
const W_REPEAT_RELIEF = WEIGHTS.repeatRelief;

// - what a vertical control-flow drawing needs that a formula graph did not - 
/** A LOOP'S WALL IS CHEAPER THAN A FRAME WITH AN EYEBROW. On the expression canvas a frame
 *  costs 0.9 because it is a wall PLUS words ("for each line"). Here the container carries no
 *  words at all: the For Each Loop card sits directly above it and is already charged its
 *  full head. What is left is the wall - one contour to classify as "the steps inside this
 *  are the loop's" - so the frame is charged the wall alone and its words are charged once,
 *  where they are actually drawn. */
const W_WALL = 0.5;

/** A LANE YOU ARE INSIDE OF, WITH NO WALL AROUND IT. A branch is drawn as two columns that
 *  rejoin at a bead, and nothing encloses either one: the reader tracks which column they are
 *  in by its horizontal offset, and the Then/Else word that said so is at the top, often off
 *  screen by the time it matters. That is exactly the text's indentation - a column cue with
 *  no name on it - so it is charged exactly what the text's indentation is charged. */
const W_LANE_LAYER = 1.0;

/** A WALL YOU ARE INSIDE OF IS HALF AN INDENT. Same argument the sibling makes for its
 *  containment term, and this is the one place the drawing plainly wins: a loop's body sits
 *  inside a tinted contour that is continuously visible, where the text's reader has an
 *  indentation column and a brace they must go and match. The model says so, in the diagram's
 *  favour, and says it only for the construct that actually draws a wall. */
const W_WALL_LAYER = 0.5;

/** A LANE WORD - Then, Else, Catch, Always - is one short word on a wire, read once and then
 *  used as a landmark. Same object as the sibling's parameter pill, same price. */
const W_LANE_LABEL = W_PILL;

/** A COMMENT STRIP IS A BOX, AND ONLY THE BOX IS CHARGED. The words inside it are the words
 *  the file already contained, so both representations show them and neither is charged (see
 *  rule 1 in the header). What the drawing adds is a tinted container to classify and a line
 *  budget that can cut the comment short - the box, and the truncation, are the difference. */
const W_NOTE_BOX = 0.4;

/** A ROW WHOSE VALUE IS ELIDED IS A FOLD. `fieldValue` cuts at 60 characters and appends an
 *  ellipsis; the reader who needs the tail opens the editor, reads a panel that has just
 *  appeared, and comes back. Charged what the sibling charges a chip, for the same reason. */
const W_ELIDED = 0.5;

/** AN AFFORDANCE ON THE CANVAS IS STILL AN OBJECT ON THE CANVAS. Every connector carries a
 *  24px + disc at its midpoint, painted in panel ink with a hairline border - not a hover
 *  reveal, always drawn. It carries one bit ("you may insert here"), which is the bead's
 *  price, and there is one per connector, so on a straight-line body the drawing has as many
 *  discs as it has wires. That is a real thing the eye resolves and skips, and a model that
 *  ignored it would be measuring a canvas nobody ships. */
const W_PLUS = W_BEAD;

/** BLOCK NESTING IN TEXT IS AN INDENTATION COLUMN. Cheaper than the sibling's bracket-nesting
 *  weight of 2.0, and for a stated reason: a bracket opened and closed inside one line costs
 *  a backward saccade to find the opener, while a brace closed twenty lines down at a matching
 *  column costs nothing to STAY oriented inside - the indent is a continuous cue. What it does
 *  not do is name what you are inside of, which is why it is not free either. */
const W_INDENT = 1.0;

/** ESTABLISHING A BLOCK'S EXTENT. Every braced block in text is a question the reader has to
 *  answer at least once - where does this end, is there an else, is there a catch - and the
 *  answer is a scan to a matching brace. One regression per block. The drawing answers all
 *  three questions with its shape, which is the structural win this term exists to price;
 *  the charge is flat rather than proportional to the block's length, which UNDERSELLS the
 *  text's cost on a long block and so leans, as everything here does, against the drawing. */
const W_MATCH = 1.0;

/** A LINE BOX IN THE CODE VIEW, pinned to the layout engine's LINE_H and to the height
 *  `check_editor_scale.rb` allowlists for `.logic-code-line`. Text has one escape from a body
 *  that does not fit - scrolling - and no zoom escape worth the name, because code at 8px is
 *  not read, it is skimmed for shape. So the text side pays pan and only pan. */
const TEXT_LINE_H = 17;

/** EVERY WEIGHT IN ONE PLACE. The reasons are on the declarations; this is the index. */
export const FLOW_WEIGHTS = Object.freeze({
  head: W_HEAD, row: W_ROW, pill: W_PILL, bead: W_BEAD, plus: W_PLUS,
  wall: W_WALL, laneLabel: W_LANE_LABEL, noteBox: W_NOTE_BOX, elided: W_ELIDED,
  hidden: W_HIDDEN, wire: W_WIRE, turn: W_TURN, wireRun: W_WIRE_RUN, cross: W_CROSS,
  pan: W_PAN, zoom: W_ZOOM, legibleZoom: LEGIBLE_ZOOM, viewW: VIEW_W, viewH: VIEW_H,
  laneLayer: W_LANE_LAYER, wallLayer: W_WALL_LAYER, repeatRelief: W_REPEAT_RELIEF,
  indent: W_INDENT, match: W_MATCH, textLineH: TEXT_LINE_H,
});

// - the bus prefix is vocabulary - //
//  `textCost` charges two fixations for every distinct name past the fourth, and it waives
//  the first TWO segments of a path rooted at a global: nobody reads `round` off
//  `Math.round` and wonders what it is. That list was drawn up for expressions bound to a
//  screen, and it does not contain the word this workload is made of. `dsx` is THE bus
//  handle - `cfg.ts`'s liveness scanner already refuses to give it a port, on the grounds
//  that it is ambient in every body ever written - and `dsx.module`, `dsx.variable`,
//  `dsx.route` are the runtime's own second words, not names an author invented.
//
//  Left alone, `dsx.module.haptics.impact({ style: 'light' })` introduces FIVE names, two of
//  which are furniture, and the two spurious ones eat half the free working set. Measured
//  over the corpus that inflates the text side and so FLATTERS THE DRAWING, which is the one
//  direction this model is not allowed to be wrong in. So the waiver is extended by exactly
//  one root, and the correction is applied to the published `names` count rather than to the
//  weights, so nothing else about the sibling's pricing changes.
//
//  THE WALK BELOW IS A SECOND COPY OF THE SIBLING'S NAME RULE, and a second copy is a drift
//  waiting to happen - so `flowcost.test.ts` asserts that with the waiver EMPTY it returns
//  exactly `textCost(...).names` on every fixture and every real body. The day the sibling
//  changes its vocabulary, that test fails here.

const BUS_ROOTS: ReadonlySet<string> = new Set(["dsx"]);
const SIBLING_VOCABULARY: ReadonlySet<string> = new Set([
  "true", "false", "null", "undefined", "typeof", "in", "new",
]);
const SIBLING_GLOBALS: ReadonlySet<string> = new Set([
  "Math", "JSON", "Date", "Object", "Number", "String", "Boolean", "Array", "Error",
]);

/** Distinct authored names in one expression, dotted paths split into segments, with the
 *  first two segments of a path rooted in `roots` waived. `roots` empty reproduces the
 *  sibling exactly, which is what the drift test pins. */
export function distinctNames(source: string, roots: ReadonlySet<string> = new Set()): number {
  const out = new Set<string>();
  const walk = (from: number, to: number): void => {
    for (const t of lexExpression(source, from, to)) {
      for (const h of t.holes ?? []) walk(h.start, h.end);
      if (t.kind !== "ident") continue;
      const parts = t.v.split(".");
      const head = parts[0];
      const waived = head !== undefined && (SIBLING_GLOBALS.has(head) || roots.has(head));
      for (const part of parts.slice(waived ? 2 : 0)) {
        if (part !== "" && !SIBLING_VOCABULARY.has(part)
          && !METHOD_NAMES.has(part) && !HIGHER_ORDER.has(part)) out.add(part);
      }
    }
  };
  walk(0, source.length);
  return out.size;
}

/** `textCost`, with the bus prefix waived. Every text price in this file goes through here,
 *  on both sides of the ratio, so the two sides can never be priced by different rules. */
export function statementText(code: string): number {
  const measured = textCost(code);
  const over = (n: number): number => Math.max(0, n - WEIGHTS.freeNames) * WEIGHTS.nameOver;
  return measured.total - over(measured.names) + over(distinctNames(code, BUS_ROOTS));
}

// - the text side: a body as its author wrote it - 
export type BodyTextCost = {
  /** Statements and control heads priced by `legibility.ts`'s `textCost`, unchanged. */
  statements: number;
  /** Deepest block nesting, times the indent weight. */
  indent: number;
  /** One regression per braced block, to establish its extent. */
  matching: number;
  /** Screenfuls past the first. */
  extent: number;
  total: number;
  /** The raw counts, published so a total nobody can decompose is not the only output. */
  units: number;
  lines: number;
  depth: number;
  blocks: number;
  tokens: number;
};

/** The code of one statement, with its own comment run and trailing comment removed - the
 *  same bytes `nodeFor` classifies, so both sides are pricing the same characters. */
function statementCode(src: string, span: StatementSpan): string {
  const { pieces, codeEnd } = scanComments(src, span.code, span.end);
  const trailing = pieces[pieces.length - 1];
  const end = trailing !== undefined && trailing.start >= codeEnd ? trailing.start : span.end;
  return decode(src.substring(span.code, Math.max(span.code, end)));
}

type TextWalk = { units: number; tokens: number; depth: number; blocks: number };

function walkText(src: string, list: Region[], depth: number, acc: TextWalk): void {
  if (depth > acc.depth) acc.depth = depth;
  for (const region of list) {
    if (region.kind === "straight") {
      for (const span of statementSpans(src, region.span)) {
        if (span.code >= span.end) continue;             // a comment that owns no statement
        const code = statementCode(src, span);
        if (code.trim() === "") continue;
        acc.units += statementText(code);
        acc.tokens += textCost(code).tokens;
      }
      continue;
    }
    const head = decode(src.substring(region.headSpan.start, region.headSpan.end));
    acc.units += statementText(head);
    acc.tokens += textCost(head).tokens;
    if (region.kind === "branch") {
      acc.blocks++;
      walkText(src, region.consequent, depth + 1, acc);
      if (region.alternate !== null) { acc.blocks++; walkText(src, region.alternate, depth + 1, acc); }
      continue;
    }
    if (region.kind === "guard") {
      acc.blocks++;
      walkText(src, region.body, depth + 1, acc);
      if (region.handler !== null) { acc.blocks++; walkText(src, region.handler, depth + 1, acc); }
      if (region.finalizer !== null) { acc.blocks++; walkText(src, region.finalizer, depth + 1, acc); }
      continue;
    }
    acc.blocks++;
    walkText(src, region.body, depth + 1, acc);
  }
}

/** What the body costs as the characters the author typed. Total over anything the region
 *  parser tiles, which is anything at all - an unparsed construct degrades to straight text
 *  and is priced as straight text. */
export function bodyTextCost(source: string): BodyTextCost {
  const acc: TextWalk = { units: 0, tokens: 0, depth: 0, blocks: 0 };
  walkText(source, projectCfg(source).regions, 0, acc);
  const lines = decode(source).replace(/^\s*\n/, "").trimEnd().split("\n").length;
  const screens = Math.max(0, Math.ceil((lines * TEXT_LINE_H) / VIEW_H) - 1);
  const indent = acc.depth * W_INDENT;
  const matching = acc.blocks * W_MATCH;
  const extent = screens * W_PAN;
  return {
    statements: round(acc.units), indent, matching, extent,
    total: round(acc.units + indent + matching + extent),
    units: round(acc.units), lines, depth: acc.depth, blocks: acc.blocks, tokens: acc.tokens,
  };
}

// - the drawing side: the same body as nodeflow draws it - 
export type FlowDrawCost = {
  /** Cards, pills, rows, beads, walls, strips, discs - everything the eye resolves. */
  objects: number;
  /** The text the drawing itself prints: row values and Custom Code lines. */
  printed: number;
  /** Wires: acquisition, corners, distance. */
  wires: number;
  crossings: number;
  /** Pan or shrink, whichever is cheaper. */
  extent: number;
  /** Lanes and walls the reader is inside at the deepest point. */
  containment: number;
  /** Negative. What the label plane's redundancy gives back. */
  repetition: number;
  total: number;
};

export type FlowCensus = {
  cards: number;
  pills: number;
  rows: number;
  /** Rows whose value the projection cut at 60 characters. */
  elided: number;
  beads: number;
  walls: number;
  notes: number;
  laneLabels: number;
  plusDiscs: number;
  edges: number;
  turns: number;
  wirePx: number;
  crossings: number;
  /** Custom Code cards, and the source lines they print. */
  codeCards: number;
  codeLines: number;
  width: number;
  height: number;
  viewports: number;
  fitZoom: number;
  /** Deepest lane nesting and deepest wall nesting, counted apart because they cost apart. */
  laneDepth: number;
  wallDepth: number;
  labels: number;
  distinctLabels: number;
  entropyBits: number;
  redundancy: number;
};

/** One object's visible text, quoted so no delimiter can glue two different objects into one
 *  repeat. Same device as the sibling, same reason. */
function label(...parts: string[]): string { return JSON.stringify(parts); }

function labelsOf(flow: Flow): string[] {
  const out: string[] = [];
  for (const n of flow.nodes) {
    if (n.kind === "merge" || n.kind === "port" || n.kind === "frame") continue;
    if (n.kind !== "note") out.push(label(n.title, n.showSubtitle ? n.subtitle : ""));
    for (const f of n.fields) out.push(label(f.name, f.value));
    if (n.note !== undefined) out.push(label("note", n.note.lines.join(" ")));
    if (n.trailing !== undefined) out.push(label("trail", n.trailing));
  }
  for (const e of flow.edges) if (e.label !== undefined) out.push(label(e.label));
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

/** Lane nesting and wall nesting, from the region tree rather than from the geometry: a lane
 *  is a lane because a branch made it one, not because two cards happen to share a column. */
function nesting(list: Region[], lane: number, wall: number): { lane: number; wall: number } {
  let deepestLane = lane, deepestWall = wall;
  for (const region of list) {
    if (region.kind === "straight") continue;
    const kids: { list: Region[]; lane: number; wall: number }[] =
      region.kind === "branch"
        ? [{ list: region.consequent, lane: lane + 1, wall },
           { list: region.alternate ?? [], lane: lane + 1, wall }]
      : region.kind === "guard"
        ? [{ list: region.body, lane: lane + 1, wall },
           { list: region.handler ?? [], lane: lane + 1, wall },
           { list: region.finalizer ?? [], lane: lane + 1, wall }]
        : [{ list: region.body, lane, wall: wall + 1 }];
    for (const kid of kids) {
      const deep = nesting(kid.list, kid.lane, kid.wall);
      if (deep.lane > deepestLane) deepestLane = deep.lane;
      if (deep.wall > deepestWall) deepestWall = deep.wall;
      if (kid.lane > deepestLane) deepestLane = kid.lane;
      if (kid.wall > deepestWall) deepestWall = kid.wall;
    }
  }
  return { lane: deepestLane, wall: deepestWall };
}

/** What the drawing prints of the author's own source: the expression on every argument row,
 *  and every line inside a Custom Code card. Charged the FIRST token free, because the
 *  sibling's row weight already covers a label and a short value; everything past that first
 *  token is text the reader reads off the canvas exactly as they would read it off the file.
 *
 *  AN ELIDED ROW IS NOT A CHEAPER ROW, and this is the one place this model parts company
 *  with the sibling's weights on purpose. A chip standing in for thirty-three identical
 *  Multiply arms is charged a quarter of a fixation per hidden arm, because most readers
 *  accept that summary. `logicWrite.send({ body: logic…` is not a summary of anything: a
 *  reader who wants to know what the step DOES has to open the row, read the expression in a
 *  panel that has just appeared over the canvas, and find their place again. So the row is
 *  charged what the WHOLE expression costs whether the card shows all of it or not, plus the
 *  detour. Cutting the value shorter can therefore never make this number fall, which is the
 *  property that stops the next change from buying an improvement by hiding more. */
function printedCost(node: FlowNode): number {
  let total = 0;
  for (const f of node.fields) {
    total += Math.max(0, statementText(f.text) - WEIGHTS.token);
    if (f.value.endsWith("…")) total += W_ELIDED;
  }
  if (node.kind === "code") for (const line of node.lines) total += statementText(line);
  return total;
}

export function flowCensus(source: string, flow: Flow): FlowCensus {
  let cards = 0, pills = 0, rows = 0, elided = 0, beads = 0, walls = 0, notes = 0;
  let codeCards = 0, codeLines = 0;
  for (const n of flow.nodes) {
    if (n.kind === "merge" || n.kind === "port") { beads++; continue; }
    if (n.kind === "frame") { walls++; continue; }
    if (n.kind === "start" || n.kind === "end") { pills++; continue; }
    if (n.kind !== "note") cards++;
    if (n.kind === "code") { codeCards++; codeLines += n.lines.length; }
    if (n.note !== undefined) notes++;
    if (n.trailing !== undefined) notes++;
    rows += n.fields.length;
    for (const f of n.fields) if (f.value.endsWith("…")) elided++;
  }
  let turnCount = 0, wirePx = 0, laneLabels = 0, plusDiscs = 0;
  for (const e of flow.edges) {
    turnCount += turns(e.points);
    wirePx += polylineLength(e.points);
    if (e.label !== undefined) laneLabels++;
    if (e.insertAt !== undefined && e.plusX !== undefined) plusDiscs++;
  }
  const labels = labelsOf(flow);
  const h = entropyBits(labels);
  const hMax = labels.length > 1 ? Math.log2(labels.length) : 0;
  const deep = nesting(projectCfg(source).regions, 0, 0);
  const w = Math.max(1, flow.width), hgt = Math.max(1, flow.height);
  return {
    cards, pills, rows, elided, beads, walls, notes, laneLabels, plusDiscs,
    edges: flow.edges.length, turns: turnCount, wirePx: round(wirePx),
    crossings: countCrossings(flow.edges.map((e) => e.points)),
    codeCards, codeLines,
    width: flow.width, height: flow.height,
    viewports: Math.ceil(w / VIEW_W) * Math.ceil(hgt / VIEW_H),
    fitZoom: round(Math.min(1, VIEW_W / w, VIEW_H / hgt)),
    laneDepth: deep.lane, wallDepth: deep.wall,
    labels: labels.length, distinctLabels: new Set(labels).size,
    entropyBits: round(h), redundancy: round(hMax > 0 ? clamp01(1 - h / hMax) : 0),
  };
}

export function flowDrawCost(source: string, flow: Flow): FlowDrawCost {
  const c = flowCensus(source, flow);
  const labelled = c.cards + c.pills + c.rows + c.notes + c.laneLabels;
  const objects = c.cards * W_HEAD + c.pills * W_PILL + c.rows * W_ROW
    + c.beads * W_BEAD + c.walls * W_WALL
    + c.notes * W_NOTE_BOX + c.laneLabels * W_LANE_LABEL + c.plusDiscs * W_PLUS;
  let printed = 0;
  let hidden = 0;
  for (const n of flow.nodes) {
    printed += printedCost(n);
    if (n.note?.more === true) hidden += 1;
  }
  const wires = c.edges * W_WIRE + c.turns * W_TURN + (c.wirePx / WIRE_HOP_PX) * W_WIRE_RUN;
  const crossings = c.crossings * W_CROSS;
  const pan = Math.max(0, c.viewports - 1) * W_PAN;
  const zoom = Math.max(0, (LEGIBLE_ZOOM - c.fitZoom) / LEGIBLE_ZOOM) * W_ZOOM;
  const extent = Math.min(pan, zoom);
  const containment = c.laneDepth * W_LANE_LAYER + c.wallDepth * W_WALL_LAYER;
  const repetition = -(c.redundancy * labelled * W_REPEAT_RELIEF);
  const total = objects + printed + hidden * W_HIDDEN + wires + crossings + extent
    + containment + repetition;
  return {
    objects: round(objects), printed: round(printed + hidden * W_HIDDEN), wires: round(wires),
    crossings: round(crossings), extent: round(extent), containment: round(containment),
    repetition: round(repetition), total: round(total),
  };
}

// - the measurement - 
export type BodyLegibility = {
  source: string;
  text: BodyTextCost;
  draw: FlowDrawCost;
  census: FlowCensus;
  /** Statements the projection drew, its own count. */
  statements: number;
  /** reconstruct(project(src)) === src. A drawing that is not exact is not a drawing of
   *  this body, and its cost is not a fact about this body. */
  exact: boolean;
  /** Drawing cost over text cost. Above 1 the drawing is the more expensive read. */
  ratio: number;
};

export function bodyLegibility(source: string, trigger = "Action"): BodyLegibility {
  const flow = projectFlow(source, trigger);
  const text = bodyTextCost(source);
  const draw = flowDrawCost(source, flow);
  const census = flowCensus(source, flow);
  return {
    source, text, draw, census, statements: flow.statements, exact: flow.exact,
    ratio: round(text.total > 0 ? draw.total / text.total : 0),
  };
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
function clamp01(n: number): number { return n < 0 ? 0 : n > 1 ? 1 : n; }

// - the corpora this instrument is pointed at - 
/** TWENTY BODIES SOMEBODY ACTUALLY WROTE, quoted verbatim out of this repo and ordered by
 *  size. Not invented, and not the test fixtures: `nodeflow.test.ts`'s PLACE body has a loop,
 *  a branch, a continue and a throw in thirteen statements, where 65% of the real workload is
 *  ONE statement and 84% of it has no control flow at all. A ratio quoted on the fixtures is a
 *  ratio for a body nobody writes.
 *
 *  The twenty are drawn in the measured proportion: thirteen at or under two statements, and
 *  the tail carried by the shapes that really do appear - a computed variable that filters, an
 *  action that awaits a module and branches on the result. Entities are left exactly as the
 *  files carry them (`&gt;`, `=&gt;`), because that is what the projection reads. */
export const REAL_BODIES: readonly { name: string; body: string }[] = [
  { name: "handler/lone-name", body: "toggleWorkout" },
  { name: "handler/action-call", body: "treeDuplicate()" },
  { name: "handler/event", body: "dsx.event('unlock')" },
  { name: "handler/set-flag", body: "dsx.variable.showSpeed = false" },
  { name: "handler/module-call", body: "dsx.module.haptics.impact({ style: 'light' })" },
  { name: "handler/set-and-close", body: "dsx.variable.speed = 0.75; dsx.variable.showSpeed = false" },
  { name: "variable/one-return", body: "return dsx.attribute.value == null ? '' : dsx.attribute.value" },
  { name: "variable/guarded-label", body: "\n      if (dsx.variable.curDownloaded) { return dsx.attribute.saved }\n      return dsx.attribute.save\n    " },
  { name: "action/two-steps", body: "\n      dsx.variable.revertingTurn = turn\n      revertPost.send({ turn: turn })\n    " },
  { name: "action/await-and-set", body: "\n      const r = await dsx.module.cdn.stats({});\n      dsx.variable.cdnState = r.ok ? JSON.stringify(r.data) : ('error: ' + r.error)\n    " },
  { name: "action/copy-and-flash", body: "\n      dsx.module.self.copytext({ text: line });\n      dsx.variable.consoleCopied = line;\n      setTimeout(() =&gt; { dsx.variable.consoleCopied = '' }, 1400, 'consoleCopyFlash')\n    " },
  { name: "action/branch-both-ways", body: "\n      if (dsx.this.direction == 'increment') { pos = Math.min(pos + 0.05, 1) }\n      else { pos = Math.max(pos - 0.05, 0) }\n    " },
  { name: "variable/filter-chain", body: "\n      const needle = query.trim().toLowerCase()\n      const rows = documents.data == null ? [] : documents.data.components\n      return rows\n        .map(row =&gt; ({ id: row.id, name: row.name, selected: row.id == openDocument }))\n        .filter(row =&gt; needle == '' || row.name.toLowerCase().includes(needle))\n    " },
  { name: "action/guarded-await", body: "\n      callMsg = '… relaying';\n      const r = await dsx.module.toast.show({ text: 'From the watch', style: 'success' });\n      if (r.ok) { callMsg = r.data.deferred ? 'sent — shows when the phone opens' : 'sent — look at the phone'; }\n      else { callMsg = '✗ ' + r.error; }\n    " },
  { name: "variable/search-filter", body: "\n      const q = query == null ? '' : query.toLowerCase()\n      const wanted = statusFilter == null ? 'all' : statusFilter\n      const byStatus = wanted == 'all' ? orders : orders.filter(o =&gt; o.status == wanted)\n      if (q == '') { return byStatus }\n      return byStatus.filter(o =&gt; (o.customer + ' ' + o.product + ' ' + o.id).toLowerCase().includes(q))\n    " },
  { name: "action/early-returns", body: "\n      const r = await dsx.module.self.tail({});\n      if (!r.ok) { return; }\n      if (r.data.stamp == dsx.variable.consoleStamp) { return; }\n      dsx.variable.consoleStamp = r.data.stamp;\n      dsx.variable.consoleRows = r.data.rows;\n      dsx.variable.consoleKernel = r.data.kernel;\n      dsx.variable.consoleCounts = r.data.counts;\n      dsx.variable.consoleIssues = r.data.issues\n    " },
  { name: "variable/ladder", body: "\n      const people = dsx.variable.avatarGroupPeople\n      const names = people.map(p =&gt; p.name || p.initials || 'Unknown')\n      if (names.length == 0) { return 'No people' }\n      if (names.length == 1) { return names[0] }\n      const shown = names.slice(0, dsx.variable.avatarGroupMax)\n      const extra = names.length - shown.length\n      if (extra &gt; 0) { return names.length + ' people: ' + shown.join(', ') + ' and ' + extra + ' others' }\n      return names.length + ' people: ' + shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1)\n    " },
  { name: "variable/nested-loops", body: "\n      if (showAll) { return styleSections }\n      const props = []\n      for (let i = 0; i &lt; styleSections.length; i++) {\n        const rows = styleSections[i].props\n        for (let p = 0; p &lt; rows.length; p++) { if (rows[p].set) { props.push(rows[p]) } }\n      }\n      return props.length == 0 ? [] : [{ id: 'set', label: '', setCount: props.length, props: props }]\n    " },
  { name: "action/preset-fanout", body: "\n      dsx.variable.fxChainPreset = item.name\n      dsx.variable.fxCompPreset = item.comp\n      dsx.variable.fxComp = item.comp != ''\n      dsx.variable.fxEqPreset = item.eq\n      dsx.variable.fxEchoPreset = item.echo\n      dsx.variable.fxEcho = item.echo != ''\n      dsx.variable.fxReverb = item.reverb\n      const r = await dsx.module.studio.setChain({ id: dsx.variable.fxTrack, name: item.name });\n      if (!r.ok) { dsx.variable.fxChainPreset = ''; dsx.variable.aiMsg = 'AI error: ' + r.error; return; }\n      dsx.variable.aiMsg = '';\n    " },
  { name: "action/comment-and-steps", body: "\n      // the picker chose a template; the connector chose the offset\n      logicWrite.send({ body: logicBody, rev: logicFlow.rev, op: { op: 'insert', at: dsx.variable.logicPlusAt, text: template } })\n      dsx.variable.logicPlusAt = null\n    " },
];

/* THE THREE THE BROWSER ORACLE DRAWS. `packages/dom/oracle/studio-surfaces-browser.ts` walks
   the Studio against a fixture whose refresh/submit/sync actions between them name every
   statement family the projection classifies, and captures 07-logic / 07b-logic-body /
   07c-logic-field off exactly these bytes. They are restated here rather than imported
   because that file launches a browser at module load and a cost model must not need
   Chromium to run; `flowcost.test.ts` reads it as TEXT and fails when the two
   copies drift apart. */
const ORACLE_REFRESH = `
      const seen = []
      let attempts = 0
      for (const r of rows) {
        attempts = attempts + 1
        if (r.status == 'open') { seen.push(r.id) } else { continue }
        if (attempts &gt; 50) { break }
      }
      rows.forEach(r =&gt; { dsx.log('row ' + r.id) })
      dsx.log('open ' + seen.length)
      dsx.variable.query = ''
      return seen
    `;
const ORACLE_SUBMIT = `
      try {
        dsx.module.share.text({ text: 'Order ' + id })
        dsx.action.refresh()
        dsx.fire('order.sent')
        dsx.broadcast('order.sent')
      } catch (e) {
        dsx.error('share failed')
        throw 'could not share'
      } finally {
        dsx.log('done')
      }
    `;
const ORACLE_SYNC = `
      const token = secret.apiKey
      const fresh = dsx.api.orders.list({ since: 0 })
      dsx.data.order.create({ id: 99 })
      dsx.data.order.update({ id: 99 })
      dsx.variable.rows.sort()
      dsx.variable.rows.reverse()
      dsx.variable.rows.unshift({ id: 0 })
      dsx.variable.rows.pop()
      dsx.queue('reindex')
      setTimeout(() =&gt; { dsx.log('later') }, 500)
      dsx.route.push('/detail')
      dsx.route.back()
      return fresh
    `;

export const ORACLE_BODIES: readonly { name: string; body: string }[] = [
  { name: "oracle/refresh", body: ORACLE_REFRESH },
  { name: "oracle/submit", body: ORACLE_SUBMIT },
  { name: "oracle/sync", body: ORACLE_SYNC },
];

export const ALL_FIXTURES: readonly { name: string; body: string }[] =
  [...REAL_BODIES, ...ORACLE_BODIES];

// - the gate's recorded baseline - 
/** THE DRAWING'S COST ON EVERY FIXTURE ABOVE, AS MEASURED, RECORDED 2026-08-25.
 *
 *  A HARDCODED CENSUS in the sense `check_editor_scale.rb` uses the term: not a target
 *  anybody chose, but what `nodeflow.ts` does today, written down so the next change to the
 *  projection has to say what it did to these numbers. `flowcost.test.ts` fails
 *  when any fixture's drawing cost rises past BASELINE_TOLERANCE.
 *
 *  RE-RECORDING IT IS A DELIBERATE ACT and the rule is the repo's - a number moves only with
 *  the landed change named in the commit that moves it:
 *    1. `cd OpenSource/Web && node packages/cli/src/flowcost.ts --baseline`
 *    2. paste the block it prints over the one below
 *    3. in the same commit, name the projection change that moved each number
 *    4. re-run the corpus walk (`--corpus`) - a fixture cost that fell while the corpus p50
 *       rose is a cost that fell for the wrong reason *
 *  RE-RECORDED 2026-08-27. One landed projection change, in `nodeflow.ts`:
 *    - THE SEAM IS REVERSED (owner-directed): a straight run's statements LINK again -
 *      every boundary draws its connector with the insert + riding it, because the
 *      affordance is the point and a chart whose steps carry their own wires reads as a
 *      chart everywhere someone has used one. The wire and extent terms the seam saved
 *      come back, so every multi-statement fixture rose (`handler/lone-name` 2.4 -> 3.04,
 *      `variable/ladder` 81.79 -> 91.37); the cost is accepted, not accidental.
 *    - THE WALL stands as recorded 2026-08-25: a one-armed `if` still draws a tinted frame
 *      rather than a two-lane fork. */
export const BASELINE: Readonly<Record<string, number>> = {
  "action/await-and-set": 15.57,
  "action/branch-both-ways": 29.08,
  "action/comment-and-steps": 18.57,
  "action/copy-and-flash": 16.49,
  "action/early-returns": 34.65,
  "action/guarded-await": 28.62,
  "action/preset-fanout": 47.9,
  "action/two-steps": 6.97,
  "handler/action-call": 3.04,
  "handler/event": 3.84,
  "handler/lone-name": 3.04,
  "handler/module-call": 3.84,
  "handler/set-and-close": 7.75,
  "handler/set-flag": 4.64,
  "oracle/refresh": 60.27,
  "oracle/submit": 26.9,
  "oracle/sync": 68.57,
  "variable/filter-chain": 57.35,
  "variable/guarded-label": 9.27,
  "variable/ladder": 83.18,
  "variable/nested-loops": 80.2,
  "variable/one-return": 7.32,
  "variable/search-filter": 65.41,
};

/** The layout moves by whole pixels and the arithmetic does not drift, so this is not noise
 *  room: it is the width of a change no reader would notice. */
export const BASELINE_TOLERANCE = 0.1;

// - the report - 
function pad(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function padr(s: string, w: number): string { return s.length >= w ? s : s + " ".repeat(w - s.length); }
function fixed(n: number, d: number): string { return n.toFixed(d); }

const COLUMNS: { head: string; w: number; of: (m: BodyLegibility) => string }[] = [
  { head: "stmt", w: 4, of: (m) => String(m.statements) },
  { head: "line", w: 4, of: (m) => String(m.text.lines) },
  { head: "dep", w: 3, of: (m) => String(m.text.depth) },
  { head: "TEXT", w: 6, of: (m) => fixed(m.text.total, 1) },
  { head: "obj", w: 6, of: (m) => fixed(m.draw.objects, 1) },
  { head: "print", w: 6, of: (m) => fixed(m.draw.printed, 1) },
  { head: "wire", w: 5, of: (m) => fixed(m.draw.wires, 1) },
  { head: "xing", w: 4, of: (m) => String(m.census.crossings) },
  { head: "ext", w: 4, of: (m) => fixed(m.draw.extent, 1) },
  { head: "nest", w: 4, of: (m) => fixed(m.draw.containment, 1) },
  { head: "rep", w: 6, of: (m) => fixed(m.draw.repetition, 1) },
  { head: "DRAW", w: 7, of: (m) => fixed(m.draw.total, 1) },
  { head: "ratio", w: 6, of: (m) => fixed(m.ratio, 2) },
  { head: "cut", w: 4, of: (m) => String(m.census.elided) },
  { head: "tall", w: 5, of: (m) => fixed(heightMultiple(m), 1) },
];

/** How many times taller the drawing is than the same body as text. NOT part of the ratio -
 *  the fixation model prices area only through the extent term, and the extent term only
 *  bites once a drawing passes a screenful. It is printed beside the ratio because it is the
 *  one number a reader of this table would otherwise have to take on trust, and because it is
 *  the whole of the case `cfg.ts` made against a node per statement in the first place. */
export function heightMultiple(m: BodyLegibility): number {
  return round(m.census.height / Math.max(TEXT_LINE_H, m.text.lines * TEXT_LINE_H));
}

/** The table the doc publishes, so its numbers are generated rather than typed. */
export function report(rows: readonly { name: string; body: string }[]): string {
  const measured = rows.map((r) => ({ name: r.name, m: bodyLegibility(r.body) }));
  const nameW = Math.max(4, ...measured.map((r) => Math.min(r.name.length, 40)));
  const head = COLUMNS.map((c) => pad(c.head, c.w)).join(" ") + "  " + padr("body", nameW);
  const rule = COLUMNS.map((c) => "-".repeat(c.w)).join(" ") + "  " + "-".repeat(nameW);
  const body = measured.map((r) =>
    COLUMNS.map((c) => pad(c.of(r.m), c.w)).join(" ") + "  " + r.name);
  return [head, rule, ...body].join("\n");
}

/** p50/p90/p99 of the ratio over a corpus, and where the drawing stops being the dearer
 *  read. Nearest-rank percentiles: an interpolated percentile of N discrete drawings is a
 *  number that corresponds to no drawing. */
export function distribution(sources: readonly string[]): {
  n: number; p50: number; p90: number; p99: number; min: number; max: number;
  /** The smallest statement count at or above which EVERY measured body has ratio <= 1, or
   *  null when no such point exists in the sample. */
  crossover: number | null;
  bands: { band: string; n: number; p50: number; min: number; max: number; over: number }[];
  worstByExcess: { source: string; excess: number; ratio: number }[];
} {
  const all = sources.map((s) => {
    const m = bodyLegibility(s);
    return { source: s, ratio: m.ratio, statements: m.statements, excess: round(m.draw.total - m.text.total) };
  });
  const sorted = [...all].map((r) => r.ratio).sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const byStatements = [...all].sort((a, b) => a.statements - b.statements);
  let crossover: number | null = null;
  for (let i = 0; i < byStatements.length; i++) {
    if (byStatements.slice(i).every((r) => r.ratio <= 1)) { crossover = byStatements[i]!.statements; break; }
  }
  const BANDS: [string, number, number][] = [
    ["1", 1, 1], ["2", 2, 2], ["3 - 4", 3, 4], ["5 - 8", 5, 8],
    ["9 - 16", 9, 16], ["17 - 32", 17, 32], ["33+", 33, 1e9],
  ];
  const bands = BANDS.map(([band, lo, hi]) => {
    const g = all.filter((r) => r.statements >= lo && r.statements <= hi).map((r) => r.ratio).sort((a, b) => a - b);
    return {
      band, n: g.length,
      p50: g.length === 0 ? 0 : g[Math.ceil(0.5 * g.length) - 1]!,
      min: g[0] ?? 0, max: g[g.length - 1] ?? 0,
      over: g.filter((r) => r > 1).length,
    };
  }).filter((b) => b.n > 0);
  const worstByExcess = [...all].sort((a, b) => b.excess - a.excess || a.source.localeCompare(b.source))
    .slice(0, 10).map((r) => ({ source: r.source, excess: r.excess, ratio: r.ratio }));
  return {
    n: all.length, p50: at(0.5), p90: at(0.9), p99: at(0.99),
    min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0,
    crossover, bands, worstByExcess,
  };
}

/** The BASELINE block above, regenerated. Printing source is the point: re-recording is a
 *  paste and a justification, not an edit in twenty-three places. */
export function baselineBlock(): string {
  const rows = [...ALL_FIXTURES]
    .map((f) => ({ name: f.name, cost: bodyLegibility(f.body).draw.total }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return "export const BASELINE: Readonly<Record<string, number>> = {\n"
    + rows.map((r) => `  ${JSON.stringify(r.name)}: ${r.cost},`).join("\n")
    + "\n};";
}

// A SCRIPT ENTRY, not a side effect: the guard is false for every import, so the model stays
// pure for its callers.
//   node packages/cli/src/flowcost.ts             the twenty and the three
//   node packages/cli/src/flowcost.ts --baseline  the BASELINE block, to paste
// The walk over every real body in the repo lives beside the corpus it harvests, in
// `packages/cli/test/statement-corpus.ts` - a model that reaches the filesystem is a model
// that cannot run anywhere but here.
if (typeof process !== "undefined" && (process.argv[1] ?? "").endsWith("flowcost.ts")) {
  if (process.argv.includes("--baseline")) {
    console.log(baselineBlock());
  } else {
    console.log(report(REAL_BODIES));
    console.log("");
    console.log(report(ORACLE_BODIES));
  }
}
