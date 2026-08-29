//
//  cfg.test.ts — the round-trip corpus for the basic-block projection (platform/00-vision.md §3).
//
//  The visual logic editor is only allowed to exist if `reconstruct(projectCfg(src))` is the
//  SAME BYTES as `src`. Anything less and the editor is a second source of truth that reformats
//  an author's file behind their back, which is the failure every visual tool ships with and the
//  one this design refuses. So the corpus here is not a handful of pretty samples: it is every
//  JSE expression and every action body in OpenSource/Conformance, the CLI's own shipped
//  `<action>` bodies, and a set of cases chosen to be hostile to a formatter — comments in odd
//  places, CRLF, tabs, blank runs, no trailing newline, a brace inside a string.
//
//  It also pins the DEGRADATION rule: constructs the projection does not model (`switch`,
//  `do`/`while`) must come back byte-identical anyway. Exactness is a property of the tiling,
//  not of the parse being right, and that is what makes the editor safe to ship.
//

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { projectCfg, reconstruct, compaction, liveness } from "../src/cfg.ts";

const conformance = join(import.meta.dirname, "..", "..", "..", "..", "Conformance");

function roundTrips(source: string, label: string): void {
  const cfg = projectCfg(source);
  assert.equal(reconstruct(cfg), source, `round trip lost bytes: ${label}`);
  // The tiling itself, stated directly: the regions partition the input in order, with no
  // gap and no overlap. reconstruct() is only exact because this holds.
  let at = 0;
  for (const region of cfg.regions) {
    assert.equal(region.span.start, at, `region gap/overlap at ${at}: ${label}`);
    assert.ok(region.span.end > region.span.start, `empty region: ${label}`);
    at = region.span.end;
  }
  assert.equal(at, source.length, `regions stop short of the end: ${label}`);
}

test("every JSE conformance expression round-trips byte for byte", () => {
  const dir = join(conformance, "jse");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, "the JSE corpus is empty");
  let count = 0;
  for (const file of files) {
    const corpus = JSON.parse(readFileSync(join(dir, file), "utf8")) as { cases: { name: string; expression: string }[] };
    for (const kase of corpus.cases) {
      roundTrips(kase.expression, `${file}:${kase.name}`);
      count++;
    }
  }
  assert.ok(count >= 250, `expected the whole JSE corpus, walked ${count}`);
});

test("every action body in the actions corpus round-trips byte for byte", () => {
  const dir = join(conformance, "actions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let count = 0;
  for (const file of files) {
    const corpus = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      cases: { name: string; actions?: Record<string, { body?: string }> }[];
    };
    for (const kase of corpus.cases) {
      for (const [name, action] of Object.entries(kase.actions ?? {})) {
        if (typeof action.body !== "string") continue;
        roundTrips(action.body, `${file}:${kase.name}:${name}`);
        count++;
      }
    }
  }
  assert.ok(count >= 20, `expected the actions corpus, walked ${count}`);
});

test("the CLI's own shipped action bodies round-trip byte for byte", () => {
  // Dogfood: `despia doctor` is real DSX with real control flow, and it is the body the
  // editor would be asked to draw first.
  const document = readFileSync(join(import.meta.dirname, "..", "src", "dsx.cli.dsx"), "utf8");
  const bodies = [...document.matchAll(/<action\b[^>]*>([\s\S]*?)<\/action>/g)].map((m) => m[1]!);
  assert.ok(bodies.length >= 2, "the CLI document lost its action bodies");
  for (const [i, body] of bodies.entries()) roundTrips(body, `dsx.cli.dsx action ${i}`);
});

test("formatting a formatter would destroy survives untouched", () => {
  const hostile: Record<string, string> = {
    "no trailing newline": "const a = 1",
    "blank runs": "const a = 1\n\n\n\nconst b = 2\n",
    "CRLF": "const a = 1\r\nif (a) {\r\n  const b = 2\r\n}\r\n",
    "tabs and ragged indent": "if (a) {\n\t\tconst b = 1\n  const c = 2\n}\n",
    "trailing whitespace": "const a = 1   \nconst b = 2\t\n",
    "comment before a branch": "// why\nif (a) { b() }\n",
    "comment inside a head": "if (/* inline */ a) { b() }\n",
    "comment after the closing brace": "if (a) { b() } // tail\n",
    "brace inside a string": "const a = '}'\nif (a) { b() }\n",
    "keyword inside a string": "const a = 'if (x) {'\nconst b = 2\n",
    "unicode": "const emoji = '🎈'\nif (emoji) { done() }\n",
    "empty": "",
    "whitespace only": "\n   \n\t\n",
    "braceless if/else": "if (a) x = 1\nelse x = 2\n",
    "else if chain": "if (a) { p() } else if (b) { q() } else { r() }\n",
    "nested three deep": "if (a) {\n  for (const x of xs) {\n    if (x) { try { go(x) } catch (e) { stop(e) } }\n  }\n}\n",
    "identifier that starts with a keyword": "iffy = 1\nforward()\nwhilst = 3\ntrying()\n",
    "else-like identifier after a branch": "if (a) { b() }\nelsewhere()\n",
  };
  for (const [label, source] of Object.entries(hostile)) roundTrips(source, label);
});

test("an unmodelled construct degrades to verbatim text, never to lost bytes", () => {
  // The projection has no `switch` or `do`/`while` node. The rule is that it must therefore
  // treat them as straight-line text — coarser picture, identical bytes.
  const cases = [
    "switch (a) {\n  case 1: return 'one'\n  default: return 'other'\n}\n",
    "do {\n  step()\n} while (more())\n",
    "const re = String(a).replace(/[\"']/g, '')\nif (re) { done() }\n",
    "label: for (const x of xs) { if (x) break label }\n",
  ];
  for (const source of cases) roundTrips(source, source.split("\n")[0]!);
});

test("the graph is basic blocks, not statements: nine statements are one node", () => {
  const source = "a()\nb()\nc()\nd()\ne()\nf()\ng()\nh()\ni()\n";
  const cfg = projectCfg(source);
  const blocks = cfg.nodes.filter((n) => n.kind === "block");
  assert.equal(blocks.length, 1, "straight-line code must not split");
  assert.equal(blocks[0]!.lines.length, 9);
  assert.deepEqual(cfg.nodes.map((n) => n.kind), ["entry", "block", "exit"]);
});

test("a branch produces the branch/then/else/join topology", () => {
  const cfg = projectCfg("setup()\nif (ready) {\n  go()\n} else {\n  wait()\n}\nfinish()\n");
  const kinds = cfg.nodes.map((n) => n.kind);
  assert.deepEqual(kinds, ["entry", "block", "branch", "block", "block", "join", "block", "exit"]);
  const branch = cfg.nodes.find((n) => n.kind === "branch")!;
  assert.equal(branch.text, "if (ready) {");
  const labels = cfg.edges.filter((e) => e.label !== undefined).map((e) => e.label).sort();
  assert.deepEqual(labels, ["else", "then"]);
});

test("a loop has exactly one back edge, to its own head", () => {
  const cfg = projectCfg("for (const x of xs) {\n  total = total + x\n}\n");
  const loop = cfg.nodes.find((n) => n.kind === "loop")!;
  const back = cfg.edges.filter((e) => e.label === "back");
  assert.equal(back.length, 1);
  assert.equal(back[0]!.to, loop.id);
});

test("try/catch draws the edge that is not in the text", () => {
  const cfg = projectCfg("try {\n  risky()\n} catch (e) {\n  recover(e)\n}\n");
  assert.ok(cfg.nodes.some((n) => n.kind === "guard"));
  assert.equal(cfg.edges.filter((e) => e.label === "catch").length, 1);
});

test("area grows with branch points, not statements — the whole claim, in numbers", () => {
  // Twelve branch points. The statement count is the variable under test.
  const build = (perBlock: number): string => {
    const lines: string[] = [];
    for (let branch = 0; branch < 12; branch++) {
      for (let s = 0; s < perBlock; s++) lines.push(`step${branch}_${s}()`);
      lines.push(`if (flag${branch}) {`);
      for (let s = 0; s < perBlock; s++) lines.push(`  hot${branch}_${s}()`);
      lines.push("} else {");
      for (let s = 0; s < perBlock; s++) lines.push(`  cold${branch}_${s}()`);
      lines.push("}");
    }
    return `${lines.join("\n")}\n`;
  };

  const small = compaction(projectCfg(build(4)));
  const large = compaction(projectCfg(build(40)));

  // THE CLAIM: the drawn node count is a function of the branch points alone. Four nodes per
  // branch point here — the run leading in, the condition, the then block, the else block —
  // and it does not move when the statements inside them go up tenfold.
  assert.equal(small.nodes, 48);
  assert.equal(large.nodes, 48, "node count moved with statement count, which is the failure this design exists to avoid");
  assert.equal(small.statements, 144);
  assert.equal(large.statements, 1440);

  // Node-per-statement would draw one box per statement. That is the comparison.
  assert.equal(Math.round(large.ratio), 30, "1440 statements in 48 boxes");
  assert.ok(large.ratio > small.ratio * 9, "density improves as the body grows, rather than degrading");
});

test("a block's funnel is computed: inputs are read-before-written, outputs are read later", () => {
  const cfg = projectCfg("const total = price * quantity\nif (total > limit) {\n  applied = total - discount\n}\nsubmit(applied)\n");
  const flows = liveness(cfg);
  const first = cfg.nodes.find((n) => n.kind === "block")!;
  const flow = flows.get(first.id)!;
  assert.deepEqual(flow.inputs, ["price", "quantity"], "inputs are the variables defined elsewhere");
  assert.deepEqual(flow.outputs, ["total"], "total is read by the branch head and the body");

  const body = cfg.nodes.filter((n) => n.kind === "block")[1]!;
  const bodyFlow = flows.get(body.id)!;
  assert.deepEqual(bodyFlow.inputs, ["discount", "total"]);
  assert.deepEqual(bodyFlow.outputs, ["applied"], "applied is read by the tail block");
});

test("a value written and never read is not an output", () => {
  const cfg = projectCfg("const used = 1\nconst dead = 2\nsend(used)\n");
  const flow = liveness(cfg).get(cfg.nodes.find((n) => n.kind === "block")!.id)!;
  assert.ok(flow.writes.includes("dead"));
  assert.ok(!flow.outputs.includes("dead"), "an unread definition is not a funnel output");
});

test("liveness goes around the back edge, not just through the body once", () => {
  // `total` is written in the body and read by the body on the NEXT iteration. Only a
  // fixpoint over the back edge sees that; a single forward pass would call it dead.
  const cfg = projectCfg("total = 0\nfor (const x of xs) {\n  total = total + x\n}\nreport(total)\n");
  const flows = liveness(cfg);
  const body = cfg.nodes.filter((n) => n.kind === "block")[1]!;
  const flow = flows.get(body.id)!;
  assert.deepEqual(flow.inputs, ["total", "x"]);
  assert.deepEqual(flow.outputs, ["total"]);
});

test("the bus handle is not a funnel port", () => {
  // Every body can reach `dsx`, so drawing a port for it on every node is noise, not information.
  const cfg = projectCfg("const r = await dsx.module.fs.read({ root: 'project', path: name })\nuse(r)\n");
  const flow = liveness(cfg).get(cfg.nodes.find((n) => n.kind === "block")!.id)!;
  assert.ok(!flow.inputs.includes("dsx"));
  assert.ok(!flow.inputs.includes("module"), "a property is not a variable");
  assert.ok(!flow.inputs.includes("root"), "an object-literal key is not a variable");
  assert.deepEqual(flow.inputs, ["name"]);
});
