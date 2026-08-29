// The cost model's own tests. A measurement nobody has tested is a number people argue with,
// and this one exists to settle an argument, so it is held to the same standard as the thing
// it measures: ORDERING LAWS that must survive any retuning of the weights, the crossing
// counter checked against hand-built geometry rather than against itself, totality over the
// whole grammar corpus, and a RECORDED BASELINE that fails when a drawing gets worse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  legibility, textCost, drawCost, census, countCrossings, report, distribution,
  baselineBlock, WEIGHTS, BASELINE, BASELINE_TOLERANCE,
  REALISTIC_TWENTY, ORACLE_FIXTURES,
} from "../src/legibility.ts";
import {
  projectExpr, type ExprFlow, type ExprNode, type ExprEdge, type ExprRow,
} from "../src/exprflow.ts";
import { FORMS } from "./expr-corpus.ts";

// ── 1. the ordering laws ─────────────────────────────────────────────────────────────
//  These are the claims the instrument makes about the WORLD. A weight may move; an ordering
//  that flips means either the projection changed or the model became wrong, and both of
//  those are things a person has to look at.

test("a bare reference costs the reader less as text than as a drawing", () => {
  // THE SENTENCE THE WHOLE INSTRUMENT EXISTS TO MOVE. `total` is one fixation of text and a
  // 410x116 drawing of two cards and a wire. When this assertion starts failing, the
  // projection has genuinely got better at the smallest case and the expectation should be
  // flipped IN THE COMMIT THAT DID IT, with the change named - never loosened to make a red
  // suite green.
  for (const src of ["total", "!done", "price * qty", "user.name"]) {
    const m = legibility(src);
    assert.ok(m.ratio > 1,
      `${src}: the drawing is no longer the dearer read (ratio ${m.ratio}). If that is a `
      + "landed improvement, name it and move this expectation.");
  }
});

test("renaming and reformatting do not move the score", () => {
  // Two expressions with the same structure are the same read. `a + b` and `b + a` draw the
  // same three cards in the same places, and whitespace is not a drawing at all.
  for (const [x, y] of [["a + b", "b + a"], ["a+b", "a   +   b"], ["price * qty", "qty * price"]]) {
    const a = legibility(x!), b = legibility(y!);
    assert.deepEqual(a.census, b.census, `${x} and ${y} must draw the same census`);
    assert.deepEqual(a.draw, b.draw, `${x} and ${y} must cost the same to look at`);
  }
});

test("a crossing strictly increases the drawing cost, by at least its own weight", () => {
  const flat = fakeFlow([[[0, 0], [200, 0]], [[0, 100], [200, 100]]]);
  const crossed = fakeFlow([[[0, 0], [200, 100]], [[0, 100], [200, 0]]]);
  assert.equal(census(flat).crossings, 0);
  assert.equal(census(crossed).crossings, 1);
  const gain = drawCost(crossed).total - drawCost(flat).total;
  // At least the crossing's own weight: the geometry that produces a crossing is also longer
  // than the geometry that avoids it, by the triangle inequality, so the wire term adds a
  // little on top. It can never add less.
  assert.ok(gain >= WEIGHTS.cross, `a crossing gained only ${gain}`);
});

test("folding a run into a chip strictly decreases the drawing cost", () => {
  const list = (n: number): string => "[" + Array.from({ length: n }, (_, i) => i + 1).join(", ") + "]";
  // ROW_CAP moved from 24 to 8 when the projection was rebuilt to cost less: a card that
  // shows more rows than a reader can hold at once is being scrolled, not read.
  const unfolded = legibility(list(8));    // the last size the projection draws row by row
  const folded = legibility(list(9));      // one past ROW_CAP: the same drawing, folded
  assert.equal(unfolded.census.chips, 0);
  assert.equal(folded.census.chips, 1);
  assert.ok(folded.draw.total < unfolded.draw.total,
    `a fold must pay: ${folded.draw.total} against ${unfolded.draw.total}`);
  // And it must not pay INFINITELY. A fold hides values, so a longer fold costs more than a
  // shorter one - otherwise the cheapest drawing in the model is the one that shows nothing.
  assert.ok(legibility(list(60)).draw.total > folded.draw.total,
    "hiding sixty values must cost more than hiding twenty-five");
});

test("more of everything costs more", () => {
  // Monotonicity along a family that only grows. Every step adds a term, a card and a wire,
  // and no step removes anything, so no step may get cheaper on either side.
  let text = 0, draw = 0;
  for (let n = 2; n <= 8; n++) {
    const src = Array.from({ length: n }, (_, i) => `v${i}`).join(" + ");
    const m = legibility(src);
    assert.ok(m.text.total > text, `${src}: text cost went backwards`);
    assert.ok(m.draw.total > draw, `${src}: drawing cost went backwards`);
    text = m.text.total; draw = m.draw.total;
  }
});

// ── 2. the crossing counter, on hand-built geometry ──────────────────────────────────
//  Counted from the routed polylines, which is the whole point: the throwaway measurement
//  this model replaces reported thirteen crossings on a drawing that has none, because it
//  compared bounding boxes. Every decision the counter makes is pinned here.

test("two segments that cross count once", () => {
  assert.equal(countCrossings([[[0, 0], [10, 10]], [[0, 10], [10, 0]]]), 1);
  assert.equal(countCrossings([[[0, 5], [10, 5]], [[5, 0], [5, 10]]]), 1);
});

test("a shared endpoint is not a crossing", () => {
  // Two wires leaving one output socket. The drawing is TELLING the reader one value goes two
  // ways, which is information, not an obstacle.
  assert.equal(countCrossings([[[0, 0], [10, 10]], [[0, 0], [10, -10]]]), 0);
  assert.equal(countCrossings([[[0, 0], [10, 0]], [[10, 0], [20, 10]]]), 0);
});

test("a T-junction is not a crossing", () => {
  // One wire's endpoint landing on another's interior: what happens where a wire meets a
  // socket that another wire runs past.
  assert.equal(countCrossings([[[0, 0], [20, 0]], [[10, 0], [10, 10]]]), 0);
});

test("collinear overlap is not counted, and that is a decision", () => {
  // Two wires running along the same rule for a stretch - the fan-out from one socket does
  // exactly this for its first ten pixels. It reads as one bundle that splits. It DOES hide a
  // wire, which is a real defect, but it is a different defect from a crossing and belongs to
  // a different measurement; counting it here would charge the projection for the manoeuvre
  // it uses to AVOID crossings.
  assert.equal(countCrossings([[[0, 0], [20, 0]], [[5, 0], [15, 0]]]), 0);
  assert.equal(countCrossings([[[0, 0], [20, 0]], [[0, 0], [10, 0]]]), 0);
});

test("a polyline that crosses itself counts", () => {
  // Non-adjacent segments of one wire. Adjacent ones share an endpoint by construction and
  // are skipped, so a plain elbow counts zero.
  assert.equal(countCrossings([[[0, 0], [20, 0], [20, 10], [10, 10], [10, -10]]]), 1);
  assert.equal(countCrossings([[[0, 0], [10, 0], [10, 10], [20, 10]]]), 0);
});

test("crossing twice counts twice, and parallel never counts", () => {
  assert.equal(countCrossings([
    [[0, 0], [30, 0]],
    [[5, -5], [5, 5], [25, 5], [25, -5]],
  ]), 2);
  assert.equal(countCrossings([[[0, 0], [10, 0]], [[0, 5], [10, 5]]]), 0);
});

test("a zero-length joint is not a segment", () => {
  // A routed polyline can repeat a point where two legs meet at the same coordinate. It has
  // no direction, so it cannot cross anything, and treating it as a segment would make the
  // orientation test divide the reader's attention over nothing.
  assert.equal(countCrossings([[[0, 0], [5, 0], [5, 0], [10, 0]], [[3, -5], [3, 5]]]), 1);
});

test("the counter agrees with the projection's own geometry", () => {
  // The crossings the eighteen oracle fixtures contain. This was one, in `map`. Dropping
  // ROW_CAP from 24 to 8 folds long runs into chips, which shortens every card and pulls
  // wires that used to run in clear vertical lanes into the same horizontal band: `map`'s
  // one crossing became none, and `reduce` and `matrix` gained two and four.
  //
  // That is a real cost and it is worth naming rather than absorbing: seven crossings where
  // there was one. It is also a trade the whole corpus wins, which is why it stands. The
  // fold took the median DRAW/TEXT ratio from 1.86 to 0.68 and put sixteen of eighteen
  // fixtures below 1.0, against none before. Crossings cost 1.5 each; the fold saves
  // hundreds. If this number moves again, the projection's routing moved.
  const found = ORACLE_FIXTURES
    .map((f) => ({ name: f.name, n: legibility(f.expr).census.crossings }))
    .filter((r) => r.n > 0);
  assert.deepEqual(found, [{ name: "reduce", n: 2 }, { name: "matrix", n: 4 }]);
});

test("a label that contains the separator is still its own label", () => {
  // The entropy term compares whole labels, so how an object's parts are joined into one is
  // load-bearing: with any delimiter, a row reading `x y | z` and a row reading `x | y z`
  // collide and the model reports a repetition that is not there. There is no delimiter.
  const flow = fakeFlow([]);
  flow.nodes[0]!.rows = [fakeRow("x y", "z"), fakeRow("x", "y z")];
  const c = census(flow);
  assert.equal(c.labels, 4);            // the two rows and the two cards' heads
  assert.equal(c.distinctLabels, 4);
  assert.equal(c.redundancy, 0);
});

// ── 3. the text side ─────────────────────────────────────────────────────────────────

test("depth is bracket nesting, not tree nesting", () => {
  // `a + b * c` and `a + (b * c)` are one tree and two reads.
  assert.equal(textCost("a + b * c").depth, 0);
  assert.equal(textCost("a + (b * c)").depth, 1);
  assert.equal(textCost("f(g(h(x)))").depth, 3);
  assert.equal(textCost("`n ${f(x)}`").depth, 2);   // the hole is a bracket with a long spelling
});

test("the language's own vocabulary is not a name the reader must learn", () => {
  assert.equal(textCost("rows.filter(r => r.on)").names, 3);       // rows, r, on
  assert.equal(textCost("n.toFixed(2)").names, 1);                 // n
  assert.equal(textCost("Math.round(x)").names, 1);                // x
  assert.equal(textCost("true").names, 0);
});

test("operators are absorbed, operands are read", () => {
  const m = textCost("f(a, b)");
  assert.equal(m.operands, 3);                                      // f, a, b
  assert.equal(m.tokens - m.operands, 3);                           // the two parens and the comma
  assert.equal(m.total, 3 * WEIGHTS.token + 3 * WEIGHTS.operator + 1 * WEIGHTS.depth);
});

test("a template's holes are read", () => {
  // The lexer stops at the backtick because the evaluator wants the template whole. A reader
  // does not stop there, and a model that did would price a formula inside a template at zero.
  assert.ok(textCost("`total ${a + b} done`").tokens > textCost("`total done`").tokens);
});

// ── 4. totality ──────────────────────────────────────────────────────────────────────

test("the model is total over the grammar corpus", () => {
  const bad: string[] = [];
  for (const src of FORMS) {
    let m;
    try {
      m = legibility(src);
    } catch (e) {
      bad.push(`${src}: threw ${(e as Error).message}`);
      continue;
    }
    const numbers: [string, number][] = [
      ...Object.entries(m.text), ...Object.entries(m.draw), ...Object.entries(m.census),
      ["ratio", m.ratio],
    ].filter((e): e is [string, number] => typeof e[1] === "number");
    for (const [k, v] of numbers) {
      if (!Number.isFinite(v)) bad.push(`${src}: ${k} is ${v}`);
    }
    if (m.text.total <= 0) bad.push(`${src}: text cost is ${m.text.total}`);
    if (m.draw.total <= 0) bad.push(`${src}: drawing cost is ${m.draw.total}`);
    if (m.census.crossings < 0) bad.push(`${src}: negative crossings`);
    // 1, not 2: a small expression folds into ONE card that is both the work and the
    // answer, so a chain of 1 is a complete reading path. 0 means no route at all.
    if (m.census.chain < 1) bad.push(`${src}: no reading path to the Result`);
  }
  assert.deepEqual(bad, []);
});

test("the model is total over the twenty and the eighteen", () => {
  for (const src of [...REALISTIC_TWENTY, ...ORACLE_FIXTURES.map((f) => f.expr)]) {
    const m = legibility(src);
    assert.ok(Number.isFinite(m.ratio) && m.ratio > 0, src);
  }
});

test("measuring twice gives the same answer", () => {
  // No clock, no randomness, no filesystem. A baseline is only a fact if this holds.
  for (const src of [...REALISTIC_TWENTY, "rows.reduce((t, r) => t + r.n, 0)"]) {
    assert.deepEqual(legibility(src), legibility(src), src);
  }
});

test("the drawing's census counts what the projection actually built", () => {
  // The census is the layer everything else is derived from, so it is checked against the
  // flow rather than against itself.
  for (const src of FORMS) {
    const flow = projectExpr(src);
    const c = census(flow);
    assert.equal(c.nodes, flow.nodes.length, src);
    assert.equal(c.edges, flow.edges.length, src);
    assert.equal(c.rows, flow.nodes.reduce((n, x) => n + x.rows.length, 0), src);
    assert.equal(c.width, flow.width, src);
    assert.ok(c.fitZoom > 0 && c.fitZoom <= 1, src);
    assert.ok(c.redundancy >= 0 && c.redundancy <= 1, src);
    assert.ok(c.distinctLabels <= c.labels, src);
  }
});

// ── 5. the gate ──────────────────────────────────────────────────────────────────────

test("the oracle fixture list has not drifted from the oracle", () => {
  // ORACLE_FIXTURES is a restatement: the oracle launches a browser at module load, and a
  // cost model must not need Chromium. Restated data rots, so the file is read as TEXT and
  // compared. Adding a fixture to the oracle without adding it here fails HERE, which is the
  // right place - a new fixture with no recorded baseline is a fixture nothing gates.
  const src = readFileSync(
    new URL("../../dom/oracle/expression-canvas-browser.ts", import.meta.url), "utf-8");
  const open = src.indexOf("export const CASES");
  const body = src.slice(open, src.indexOf("\n];", open));
  const names = [...body.matchAll(/\{ name: "([^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(names, ORACLE_FIXTURES.map((f) => f.name));
  // The literal expressions too, where they are literals. The five built by generator code
  // are covered by the baseline itself: a change to `sum40`'s construction moves its cost.
  const exprs = new Map([...body.matchAll(/\{ name: "([^"]+)", expr: "((?:[^"\\]|\\.)*)"/g)]
    .map((m) => [m[1]!, JSON.parse(`"${m[2]!}"`) as string] as const));
  assert.ok(exprs.size >= 13, `only ${exprs.size} literal fixtures found - did the shape change?`);
  for (const f of ORACLE_FIXTURES) {
    const there = exprs.get(f.name);
    if (there !== undefined) assert.equal(f.expr, there, `${f.name} has drifted`);
  }
});

test("the baseline covers every fixture and nothing else", () => {
  assert.deepEqual(Object.keys(BASELINE).sort(), ORACLE_FIXTURES.map((f) => f.name).sort());
});

test("THE GATE: no fixture's drawing has got more expensive", () => {
  // A RECORDED BASELINE, not an invented threshold. It says what the projection cost on the
  // day it was recorded; this fails when a change makes any fixture dearer to look at.
  //
  // A number that FALLS is the point of the instrument and never fails here - re-record it
  // when it does, so the next change cannot spend the improvement. A number that RISES is the
  // regression this exists to catch: fix the drawing, or, if the rise is deliberate and paid
  // for, re-record with the landed change named in the same commit. The re-record is one
  // command: `node packages/cli/src/legibility.ts --baseline`.
  const worse: string[] = [];
  for (const f of ORACLE_FIXTURES) {
    const now = legibility(f.expr).draw.total;
    const then = BASELINE[f.name]!;
    if (now > then + BASELINE_TOLERANCE) worse.push(`${f.name}: ${then} -> ${now}`);
  }
  assert.deepEqual(worse, [],
    "the drawing got more expensive. Fix it, or re-record with the change named: "
    + "node packages/cli/src/legibility.ts --baseline");
});

test("the baseline block regenerates to something that parses as itself", () => {
  // The re-record command must emit exactly the shape it replaces, or re-recording becomes an
  // editing job and stops happening.
  const block = baselineBlock();
  assert.match(block, /^export const BASELINE: Readonly<Record<string, number>> = \{\n/);
  for (const f of ORACLE_FIXTURES) {
    assert.match(block, new RegExp(`\\n  ${f.name}: -?\\d`), `${f.name} missing from the block`);
  }
});

// ── 6. the report the document publishes ─────────────────────────────────────────────

test("the report has a row per expression and a number in every column", () => {
  const lines = report(REALISTIC_TWENTY.map((e) => ({ name: e, expr: e }))).split("\n");
  assert.equal(lines.length, REALISTIC_TWENTY.length + 2);   // head, rule, rows
  for (const line of lines.slice(2)) {
    const cells = line.trim().split(/\s+/).slice(0, 14);
    for (const c of cells) assert.match(c, /^-?\d+(\.\d+)?$/, `not a number: ${c} in ${line}`);
  }
});

test("the distribution reports percentiles, a worst list, and an honest crossover", () => {
  const d = distribution(FORMS);
  assert.equal(d.n, FORMS.length);
  assert.ok(d.p50 <= d.p90 && d.p90 <= d.p99);
  assert.equal(d.worst.length, 10);
  assert.equal(d.worstByExcess.length, 10);
  for (let i = 1; i < d.worst.length; i++) assert.ok(d.worst[i - 1]!.ratio >= d.worst[i]!.ratio);
  for (let i = 1; i < d.worstByExcess.length; i++) {
    assert.ok(d.worstByExcess[i - 1]!.excess >= d.worstByExcess[i]!.excess);
  }
  // NO CROSSOVER. There is no token count above which the drawing is reliably the cheaper
  // read: a 27-token fold still costs more than its text while a 23-token record costs less.
  // This is the document's most important sentence and it is asserted rather than written,
  // because the day it becomes false is the day the projection has actually been fixed.
  assert.equal(d.crossover, null,
    "a crossover has appeared - the drawing now wins above a size. Say so in "
    + "expression-legibility.md and record the token count.");
});

// ── the fake flow: geometry with no expression behind it ─────────────────────────────
//  The crossing law needs two drawings that differ in ONE routed edge and nothing else, which
//  no pair of real expressions provides. Everything here is the minimum the types demand.

function fakeNode(id: string, x: number): ExprNode {
  return {
    id, kind: "ref", species: "source", title: id, subtitle: "", glyph: "dsx.ref",
    rows: [], span: { start: 0, end: 1 }, text: id, rowW: 100,
    x, y: 0, w: 100, h: 28, outX: x + 100, outY: 14, depth: 0,
  };
}

function fakeRow(name: string, value: string): ExprRow {
  return {
    name, value, text: value, span: { start: 0, end: 1 }, mode: "expression",
    wired: false, portX: 0, portY: 0,
  };
}

function fakeFlow(routes: [number, number][][]): ExprFlow {
  const nodes: ExprNode[] = [fakeNode("a", 0), fakeNode("out", 300)];
  nodes[1]!.kind = "output";
  const edges: ExprEdge[] = routes.map((points) => ({ from: "a", to: "out", row: 0, points }));
  return {
    nodes, edges, width: 400, height: 200, source: "a", raw: "a", context: "text",
    span: { start: 0, end: 1 }, exact: true, nodeCount: nodes.length,
  };
}
