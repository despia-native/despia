//
//  flowcost.test.ts - the statement canvas's cost model, and the gate under it.
//
//  Three kinds of assertion, and they fail for different reasons on purpose:
//    1. THE LAWS - orderings that must survive any retuning of the weights. A drawing of one
//       statement costs more than the statement; hiding is never a saving; a crossing always
//       costs at least its own weight.
//    2. THE DRIFT PIN - this file's copy of the sibling's name rule must agree with the
//       sibling, so the day `legibility.ts` changes its vocabulary, the copy fails here
//       instead of quietly pricing a different language.
//    3. THE BASELINE - what `nodeflow.ts` costs today, recorded. A number that rises with no
//       named cause is the regression the gate exists to catch.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bodyLegibility, bodyTextCost, flowCensus, flowDrawCost, distinctNames, statementText,
  report, distribution, baselineBlock, heightMultiple,
  BASELINE, BASELINE_TOLERANCE, ALL_FIXTURES, REAL_BODIES, ORACLE_BODIES, FLOW_WEIGHTS,
} from "../src/flowcost.ts";
import { textCost, WEIGHTS } from "../src/legibility.ts";
import { projectFlow } from "../src/nodeflow.ts";
import { REPO, harvestBodies } from "./statement-corpus.ts";

// - purity and totality - 
test("the model is pure: the same body always measures the same", () => {
  for (const f of ALL_FIXTURES) {
    assert.deepEqual(bodyLegibility(f.body), bodyLegibility(f.body), f.name);
  }
});

test("every fixture projects exactly, so its cost is a fact about that body", () => {
  for (const f of ALL_FIXTURES) assert.equal(bodyLegibility(f.body).exact, true, f.name);
});

test("total over anything, including what the region parser cannot model", () => {
  for (const hostile of [
    "", "   ", "// just a comment\n", "}", "switch (x) { case 1: break }",
    "const s = 'a // not comment; }'\ndo { x = x - 1 } while (x)",
    "a = /\\//g.test(b)\ny = 2\n",
  ]) {
    const m = bodyLegibility(hostile);
    assert.ok(m.draw.total >= 0 && m.text.total >= 0, JSON.stringify(hostile));
    assert.ok(Number.isFinite(m.ratio));
  }
});

// - the drift pin - 
test("with no waiver the name walk reproduces the sibling's own count", () => {
  const sources = [
    ...ALL_FIXTURES.map((f) => f.body),
    "user.profile?.displayName ?? user.email", "rows.map(r => r.total).join(', ')",
    "Math.round(order.total * 100) / 100", "`${a.b} ${c}`", "JSON.parse(text).items",
  ];
  for (const src of sources) {
    assert.equal(distinctNames(src), textCost(src).names, JSON.stringify(src.slice(0, 40)));
  }
});

test("the bus prefix is waived, and only the bus prefix", () => {
  // `dsx` and its second segment are furniture; the module, the action and the key are not
  const call = "dsx.module.haptics.impact({ style: 'light' })";
  assert.equal(distinctNames(call), 5, "dsx module haptics impact style");
  assert.equal(distinctNames(call, new Set(["dsx"])), 3, "haptics impact style");
  const over = (n: number): number => Math.max(0, n - WEIGHTS.freeNames) * WEIGHTS.nameOver;
  assert.equal(statementText(call), textCost(call).total - over(5) + over(3));
  assert.ok(statementText(call) < textCost(call).total, "the waiver only ever lowers the text");
  // an ordinary path keeps every segment
  assert.equal(statementText("order.total * qty"), textCost("order.total * qty").total);
});

// - the laws - 
test("the floor: one statement always costs more drawn than written", () => {
  for (const one of ["toggleWorkout", "save()", "dsx.log('x')", "a = 1"]) {
    const m = bodyLegibility(one);
    assert.ok(m.draw.total > 0, one);
    // the smallest possible canvas is a Start pill, a card, an End pill and two wires
    assert.ok(m.draw.objects >= FLOW_WEIGHTS.head + 2 * FLOW_WEIGHTS.pill, one);
  }
});

test("renaming and reformatting do not move the drawing's cost", () => {
  const a = bodyLegibility("const total = base + tax\nreturn total\n");
  const b = bodyLegibility("const sum = base + tax\nreturn sum\n");
  assert.equal(a.draw.total, b.draw.total);
  const spaced = bodyLegibility("const total   =   base + tax\nreturn total\n");
  assert.equal(a.census.cards, spaced.census.cards);
});

test("hiding is never a saving: an elided row costs MORE, never less", () => {
  const short = bodyLegibility("x = a + b\n");
  const long = bodyLegibility("x = aVeryLongName + anotherVeryLongName + oneMoreLongName + andAFinalOne\n");
  const cut = long.census.elided;
  assert.ok(cut > 0, "the long value is elided at the card's edge");
  assert.ok(long.draw.total > short.draw.total + cut * FLOW_WEIGHTS.elided,
    "the whole expression is charged whether or not the card shows it");
});

test("more statements is more drawing, monotonically", () => {
  let previous = 0;
  let body = "";
  for (let i = 0; i < 6; i++) {
    body += `v${i} = ${i}\n`;
    const now = bodyLegibility(body).draw.total;
    assert.ok(now > previous, `${i}: ${now} <= ${previous}`);
    previous = now;
  }
});

test("a loop's wall is charged less than a branch's lane, and both are charged", () => {
  const loop = bodyLegibility("for (const r of rows) {\n  use(r)\n}\n");
  const branch = bodyLegibility("if (ok) {\n  use(a)\n} else {\n  use(b)\n}\n");
  assert.equal(loop.draw.containment, FLOW_WEIGHTS.wallLayer);
  assert.equal(branch.draw.containment, FLOW_WEIGHTS.laneLayer);
  assert.ok(loop.draw.containment < branch.draw.containment);
});

test("the text side pays for every block it must match, and for its indentation", () => {
  const flat = bodyTextCost("a = 1\nb = 2\n");
  assert.equal(flat.blocks, 0);
  assert.equal(flat.indent, 0);
  const nested = bodyTextCost("if (x) {\n  for (const r of rows) {\n    use(r)\n  }\n}\n");
  assert.equal(nested.blocks, 2);
  assert.equal(nested.depth, 2);
  assert.equal(nested.matching, 2 * FLOW_WEIGHTS.match);
});

test("a body that does not fit one screen pays extent on whichever side does not fit", () => {
  const tall = Array.from({ length: 60 }, (_, i) => `v${i} = ${i}`).join("\n") + "\n";
  const m = bodyLegibility(tall);
  assert.ok(m.census.height > FLOW_WEIGHTS.viewH, "60 cards do not fit a screen");
  assert.ok(m.draw.extent > 0, "the drawing pays to be panned or shrunk");
  assert.equal(m.text.extent, 0, "60 lines of text still fit one screen");
  assert.ok(heightMultiple(m) > 5, "and it is many times taller than the code");
});

// - the drawing's own shape - 
test("the census counts what the canvas draws, one object at a time", () => {
  const flow = projectFlow("if (ok) {\n  a = 1\n} else {\n  b = 2\n}\n", "T");
  const c = flowCensus("if (ok) {\n  a = 1\n} else {\n  b = 2\n}\n", flow);
  assert.equal(c.pills, 2, "start and end");
  assert.equal(c.cards, 3, "the If head and one card per lane");
  assert.equal(c.beads, 1, "the merge");
  assert.equal(c.laneLabels, 2, "Then and Else");
  assert.equal(c.plusDiscs, flow.edges.filter((e) => e.insertAt !== undefined).length);
  assert.equal(c.crossings, 0);
});

test("the drawing's cost decomposes into terms that add up", () => {
  for (const f of ALL_FIXTURES) {
    const m = bodyLegibility(f.body);
    const sum = m.draw.objects + m.draw.printed + m.draw.wires + m.draw.crossings
      + m.draw.extent + m.draw.containment + m.draw.repetition;
    assert.ok(Math.abs(sum - m.draw.total) < 0.02, `${f.name}: ${sum} vs ${m.draw.total}`);
  }
});

// - the fixtures stay the fixtures - 
test("the three oracle bodies still match the walk that screenshots them", () => {
  const walk = readFileSync(
    join(REPO, "OpenSource/Web/packages/dom/oracle/studio-surfaces-browser.ts"), "utf8");
  for (const body of ORACLE_BODIES) {
    // whitespace-normalised: the copy here is indented for this file, not for that one
    const needle = body.body.replace(/\s+/g, " ").trim();
    const hay = walk.replace(/\s+/g, " ");
    assert.ok(hay.includes(needle),
      `${body.name} has drifted from studio-surfaces-browser.ts:\n${needle.slice(0, 120)}`);
  }
});

test("the twenty real bodies are the shape of the real workload, not of the fixtures", () => {
  const one = REAL_BODIES.filter((b) => bodyLegibility(b.body).statements === 1).length;
  // the corpus measures 64% one-statement bodies; the sample must not be a corpus of loops
  assert.ok(one >= 5 && one <= 9, `one-statement fixtures: ${one}/20`);
  assert.ok(REAL_BODIES.some((b) => bodyLegibility(b.body).census.walls > 0), "a loop is in there");
  assert.ok(REAL_BODIES.some((b) => bodyLegibility(b.body).census.laneLabels > 0), "a branch is in there");
});

// - the report and the corpus walk run - 
test("the report and the distribution produce the tables the document publishes", () => {
  const table = report(REAL_BODIES);
  assert.ok(table.split("\n").length === REAL_BODIES.length + 2);
  assert.ok(table.includes("ratio") && table.includes("tall"));
  const d = distribution(ALL_FIXTURES.map((f) => f.body));
  assert.equal(d.n, ALL_FIXTURES.length);
  assert.ok(d.p50 > 0 && d.p90 >= d.p50 && d.max >= d.p90);
  assert.ok(d.bands.reduce((s, b) => s + b.n, 0) === d.n);
});

// - the gate - 
test("the recorded baseline: no fixture's drawing costs more than it did", () => {
  const now = new Map(ALL_FIXTURES.map((f) => [f.name, bodyLegibility(f.body).draw.total]));
  assert.deepEqual([...now.keys()].sort(), Object.keys(BASELINE).sort(),
    "a fixture was added or removed without re-recording the baseline");
  for (const [name, cost] of now) {
    const was = BASELINE[name]!;
    assert.ok(cost <= was + BASELINE_TOLERANCE,
      `${name}: ${cost} is worse than the recorded ${was}. Re-record only with the landed `
      + `change named: node packages/cli/src/flowcost.ts --baseline`);
  }
});

test("the baseline block regenerates itself exactly, so re-recording is a paste", () => {
  const printed = baselineBlock();
  for (const [name, cost] of Object.entries(BASELINE)) {
    assert.ok(printed.includes(`${JSON.stringify(name)}: ${cost},`), `${name} ${cost}`);
  }
});

// - the corpus this is quoted on - //
//  A CENSUS, in the sense `check_editor_scale.rb` uses the term. These numbers are what the
//  repo contains today; they move when someone writes logic, and the document quotes them.
//  A large move with no named cause means the harvest changed, not the workload.

test("the real workload is one statement, most of the time", (t) => {
  // The corpus spans both drops. In a standalone OpenSource checkout the closed trees are
  // simply not there, and a census of a workload that is absent is not a failure.
  if (!existsSync(join(REPO, "ClosedSource/DSX/Modules"))) {
    t.skip("the closed trees are not in this checkout");
    return;
  }
  const bodies = harvestBodies();
  // 1,800 to 2,800, not 1,800 to 2,300. The band moved again on 2026-08-27 with a named
  // cause: the dev merge landed both branches' component waves in one tree - the stream/clerk
  // markup faces, EditorShots AND EditorTools, and the film-engine components - 1,985 ->
  // 2,304. (The prior move, 2026-08-26: the PanelUI parity sweep and the AI kit,
  // 1,597 -> 1,985.) A band exists so a harvest change (a glob that started matching the
  // wrong tree) is distinguishable from work landing; both moves are work landing. The
  // statement-legibility document's headline counts are dated recordings of the walk at
  // 1,985; the invariants asserted below are re-checked live on every run.
  assert.ok(bodies.length > 1800 && bodies.length < 2800,
    `the harvest found ${bodies.length} bodies; the recorded walk quotes 1,985 (2026-08-26)`);
  const measured = bodies.map((b) => bodyLegibility(b.source));
  assert.equal(measured.filter((m) => !m.exact).length, 0,
    "a body whose projection is not byte-exact is a body the canvas may not write");
  const one = measured.filter((m) => m.statements === 1).length / measured.length;
  assert.ok(one > 0.55 && one < 0.75, `one-statement share ${(one * 100).toFixed(1)}%`);
  const ratios = measured.map((m) => m.ratio).sort((a, b) => a - b);
  const p50 = ratios[Math.ceil(0.5 * ratios.length) - 1]!;
  assert.ok(p50 < 1, `the median real body must stay cheaper drawn than written; p50 ${p50}`);
});
