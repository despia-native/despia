// The expression projection: a drawing is only as good as the text it can write back, so
// every assertion here is either a WRITE law (spans contain, splices round-trip) or a DRAWING
// law (nothing overlaps, nothing leaves the frame, every wire lands on a socket).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseExpression, exprInvariants, walkExpr, childrenOf, decodeRange } from "../src/expr.ts";
import {
  projectExpr, applyExprEdit, reconstructExpr, exprCatalog,
  type ExprFlow, type ExprNode,
} from "../src/exprflow.ts";
import { FORMS, WORKLOAD } from "./expr-corpus.ts";

const flows = FORMS.map((src) => ({ src, flow: projectExpr(src) }));

function boxes(flow: ExprFlow): { id: string; x0: number; y0: number; x1: number; y1: number }[] {
  return flow.nodes.map((n) => ({ id: n.id, x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h }));
}
function overlaps(a: { x0: number; y0: number; x1: number; y1: number },
                  b: { x0: number; y0: number; x1: number; y1: number }): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
function byId(flow: ExprFlow): Map<string, ExprNode> {
  return new Map(flow.nodes.map((n) => [n.id, n] as const));
}
/** A node drawn INSIDE another's frame is contained, not colliding. */
function insideSomeFrame(flow: ExprFlow, n: ExprNode): boolean {
  return flow.nodes.some((h) => h.frame && h.id !== n.id
    && n.x >= h.frame.x - 1 && n.y >= h.frame.y - 1
    && n.x + n.w <= h.frame.x + h.frame.w + 1 && n.y + n.h <= h.frame.y + h.frame.h + 1);
}

// ── 1. the parser ────────────────────────────────────────────────────────────────────

test("the parser is total and exact over the corpus", () => {
  const notExact: string[] = [];
  const violations: string[] = [];
  for (const src of FORMS) {
    const r = parseExpression(src, { start: 0, end: src.length });
    if (!r.exact) notExact.push(src);
    for (const v of exprInvariants(r.root)) violations.push(`${src}: ${v.node} ${v.detail}`);
  }
  assert.deepEqual(violations, [], "the write contract must hold on every form");
  assert.deepEqual(notExact, [], "every corpus form must parse to a named tree");
});

test("every child span is contained in its parent and siblings are disjoint in order", () => {
  for (const src of FORMS) {
    const { root } = parseExpression(src, { start: 0, end: src.length });
    walkExpr(root, (n) => {
      let last = -1;
      for (const c of childrenOf(n)) {
        assert.ok(c.span.start >= n.span.start && c.span.end <= n.span.end,
          `${src}: ${c.kind} escapes ${n.kind}`);
        assert.ok(c.span.start >= last, `${src}: ${c.kind} is out of source order`);
        last = c.span.end;
      }
    });
  }
});

// ── 2. the drawing ───────────────────────────────────────────────────────────────────

test("no two boxes overlap, on any form", () => {
  for (const { src, flow } of flows) {
    const bs = boxes(flow);
    const idx = byId(flow);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        if (!overlaps(bs[i]!, bs[j]!)) continue;
        // The only lawful containment: a body card inside its container's frame.
        const a = idx.get(bs[i]!.id)!, b = idx.get(bs[j]!.id)!;
        if (a.frame && insideSomeFrame(flow, b)) continue;
        if (b.frame && insideSomeFrame(flow, a)) continue;
        assert.fail(`${src}: ${bs[i]!.id} (${a.title}) overlaps ${bs[j]!.id} (${b.title})`);
      }
    }
  }
});

test("every box is inside the reported extent", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0, `${src}: ${n.title} is off the top or left`);
      assert.ok(n.x + n.w <= flow.width, `${src}: ${n.title} runs past width ${flow.width}`);
      assert.ok(n.y + n.h <= flow.height, `${src}: ${n.title} runs past height ${flow.height}`);
      if (!n.frame) continue;
      assert.ok(n.frame.x + n.frame.w <= flow.width && n.frame.y + n.frame.h <= flow.height,
        `${src}: the frame of ${n.title} runs past the extent`);
    }
  }
});

test("a frame contains its own body, its rail and its result socket", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (!n.frame) continue;
      assert.ok(n.frame.x >= n.x && n.frame.y >= n.y
        && n.frame.x + n.frame.w <= n.x + n.w + 1
        && n.frame.y + n.frame.h <= n.y + n.h + 1,
        `${src}: ${n.title}'s frame is not inside its card`);
      for (const p of n.params ?? []) {
        assert.ok(p.x >= n.frame.x && p.y >= n.frame.y
          && p.x + p.w <= n.frame.x + n.frame.w && p.y + p.h <= n.frame.y + n.frame.h,
          `${src}: the ${p.name} pill is outside ${n.title}'s frame`);
      }
      if (n.resultFrom) {
        const body = byId(flow).get(n.resultFrom)!;
        assert.ok(body.x >= n.frame.x && body.x + body.w <= n.frame.x + n.frame.w,
          `${src}: the body of ${n.title} is not inside its frame horizontally`);
        assert.ok(body.y >= n.frame.y && body.y + body.h <= n.frame.y + n.frame.h,
          `${src}: the body of ${n.title} is not inside its frame vertically`);
      }
    }
  }
});

test("every edge lands exactly on the sockets it names", () => {
  for (const { src, flow } of flows) {
    const idx = byId(flow);
    for (const e of flow.edges) {
      assert.ok(e.points.length >= 2, `${src}: an edge with no path`);
      const from = idx.get(e.from), to = idx.get(e.to);
      assert.ok(from && to, `${src}: an edge names a node that is not drawn`);
      if (e.carry) continue;
      const head = e.points[0]!, tail = e.points[e.points.length - 1]!;
      if (e.row >= 0) {
        const row = to!.rows[e.row]!;
        if (e.param) {
          const pill = (from!.params ?? []).find((p) => p.id === e.param)!;
          assert.ok(pill, `${src}: a parameter edge names a pill that is not drawn`);
          assert.equal(head[0], pill.outX, `${src}: edge leaves off the ${pill.name} pill`);
          assert.equal(head[1], pill.outY, `${src}: edge leaves off the ${pill.name} pill`);
          assert.equal(tail[0], row.portX);
          assert.equal(tail[1], row.portY);
          continue;
        }
        assert.equal(head[0], from!.outX, `${src}: edge leaves off the source socket`);
        assert.equal(head[1], from!.outY, `${src}: edge leaves off the source socket`);
        assert.equal(tail[0], row.portX, `${src}: edge misses row ${e.row} of ${to!.title}`);
        assert.equal(tail[1], row.portY, `${src}: edge misses row ${e.row} of ${to!.title}`);
      } else {
        assert.equal(tail[0], to!.resultX, `${src}: a frame result misses the wall`);
      }
    }
  }
});

test("the spine is straight: a node's output sits on its first row's line", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (!n.rows.length) continue;
      assert.equal(n.outY, n.rows[0]!.portY,
        `${src}: ${n.title}'s output is off its first row's line`);
    }
  }
});

test("a chain of single-operand steps draws as one straight rule", () => {
  const flow = projectExpr("text.trim().toLowerCase()");
  const ys = new Set(flow.nodes.filter((n) => n.rows.length).map((n) => n.outY));
  assert.equal(ys.size, 1, "every link in a chain should share one out-line");
});

// ── 3. the write contract ────────────────────────────────────────────────────────────

test("the projection is lossless", () => {
  for (const { src, flow } of flows) {
    assert.equal(reconstructExpr(flow), src);
    assert.equal(flow.exact, true, `${src} should project exactly`);
  }
});

test("every row's span is inside its node's span, and rows are disjoint", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (n.kind === "output") continue;
      let last = -1;
      for (const r of n.rows) {
        assert.ok(r.span.start >= n.span.start && r.span.end <= n.span.end,
          `${src}: row ${r.name} of ${n.title} escapes its node`);
        assert.ok(r.span.start >= last, `${src}: row ${r.name} of ${n.title} is out of order`);
        last = r.span.end;
      }
    }
  }
});

test("a row's text is exactly the bytes its span names", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (n.kind === "output") continue;
      for (const r of n.rows) {
        assert.equal(r.text, src.slice(r.span.start, r.span.end),
          `${src}: row ${r.name} of ${n.title} does not hold its own bytes`);
      }
    }
  }
});

test("edits are splices: a literal round-trips through the row that drew it", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      for (const r of n.rows) {
        if (r.wired || r.mode === "expression" || r.mode === "empty") continue;
        const next = applyExprEdit(src, { op: "literal", span: r.span, value: r.value, mode: r.mode });
        assert.equal(next, src, `${src}: rewriting ${r.name} with its own value changed the text`);
      }
    }
  }
});

test("retyping a literal changes exactly that row's bytes", () => {
  const src = "price * qty + 'x'";
  const flow = projectExpr(src);
  const row = flow.nodes.flatMap((n) => n.rows).find((r) => r.mode === "text")!;
  const next = applyExprEdit(src, { op: "literal", span: row.span, value: "y", mode: "text" });
  assert.equal(next, "price * qty + 'y'");
  assert.equal(projectExpr(next).exact, true);
});

test("replacing an operand is a splice, and the result re-projects", () => {
  // `b * c` is three atoms and rides in its row as text now, so the handle is the ROW's span
  // rather than a card's. It addresses the same bytes: that is the whole point of a fold.
  const src = "a + b * c";
  const flow = projectExpr(src);
  const add = flow.nodes.find((n) => n.title === "Add")!;
  const folded = add.rows.find((r) => r.inline === "b * c")!;
  assert.equal(folded.expandable, true, "and one gesture puts the card back");
  const next = applyExprEdit(src, { op: "replace", span: folded.span, text: "42" });
  assert.equal(next, "a + 42");
  assert.equal(projectExpr(next).nodes.length, 1);   // one Add, carrying the terminus

  // and a card that IS a card still splices through its own span
  const big = "a + f(b, c, d, e)";
  const call = projectExpr(big).nodes.find((n) => n.title === "F")!;
  assert.equal(applyExprEdit(big, { op: "replace", span: call.span, text: "42" }), "a + 42");
});

test("wrap and unwrap are inverses", () => {
  const src = "user.name";
  const wrapped = applyExprEdit(src, { op: "wrap", span: { start: 0, end: src.length }, template: "$.trim()" });
  assert.equal(wrapped, "user.name.trim()");
  const flow = projectExpr(wrapped);
  const call = flow.nodes.find((n) => n.title === "Trim")!;
  const inner = call.rows[0]!;
  assert.equal(applyExprEdit(wrapped, { op: "unwrap", span: call.span, inner: inner.span }), src);
});

test("every catalog template splices into a projectable expression", () => {
  for (const item of exprCatalog()) {
    const next = applyExprEdit("value", { op: "wrap", span: { start: 0, end: 5 }, template: item.template });
    const flow = projectExpr(next);
    assert.equal(flow.exact, true, `${item.title}: ${next} did not project exactly`);
    assert.ok(flow.nodes.length >= 1, `${item.title}: ${next} drew nothing`);
    assert.equal(flow.nodes.filter((n) => n.terminus).length, 1,
      `${item.title}: exactly one card carries the terminus`);
  }
});

// ── 4. the families ──────────────────────────────────────────────────────────────────

test("higher-order calls open as containers with a rail and a body", () => {
  const flow = projectExpr("rows.reduce((total, item) => total + item.price * item.qty, 0)");
  const fold = flow.nodes.find((n) => n.species === "higher")!;
  assert.equal(fold.title, "Fold Into");
  assert.ok(fold.frame, "a reduce must open a frame");
  assert.deepEqual(fold.params?.map((p) => p.name), ["total", "item"],
    "a pill shows the name the author wrote, never a rename");
  assert.deepEqual(fold.params?.map((p) => p.role), ["the running total", "each item"]);
  assert.equal(fold.params?.[0]!.carry, true, "the accumulator carries");
  assert.equal(fold.params?.[1]!.carry, false);
  assert.deepEqual(fold.params?.map((p) => p.used), [true, true],
    "both pills are read by the body, and the drawing says so");
  assert.ok(fold.rows.some((r) => r.name === "Items" && r.wired === false && r.value === "rows"));
  assert.ok(fold.rows.some((r) => r.name === "Start With" && r.value === "0"));
  assert.ok(fold.resultFrom, "the frame must name the node whose value it returns");
  const carry = flow.edges.find((e) => e.carry);
  assert.ok(carry, "the accumulator's carry edge must be drawn");
  assert.ok(carry!.points.length >= 4, "the carry routes around, not across");
});

test("all nineteen higher-order names are recognised in both spellings", () => {
  const names = ["filter", "reject", "map", "find", "some", "every", "sortBy", "sumBy",
    "reduce", "forEach", "sort", "flatMap", "findIndex", "groupBy", "keyBy", "findLast",
    "findLastIndex", "reduceRight", "toSorted"];
  for (const fn of names) {
    for (const src of [`rows.${fn}(r => r.a.b)`, `${fn}(rows, r => r.a.b)`]) {
      const flow = projectExpr(src);
      assert.ok(flow.nodes.some((n) => n.species === "higher"),
        `${src} should draw as a container`);
    }
  }
});

test("a trivial lambda folds into a row instead of opening a frame", () => {
  const flow = projectExpr("rows.map(r => r.price)");
  const map = flow.nodes.find((n) => n.species === "higher")!;
  assert.equal(map.folded, true);
  assert.equal(map.frame, undefined);
  assert.ok(map.rows.some((r) => r.name === "Each" && r.value === "r.price"));
});

test("a block-bodied lambda is one opaque card, not a pretend drawing", () => {
  const flow = projectExpr("rows.forEach(r => { save(r); log(r) })");
  const each = flow.nodes.find((n) => n.species === "higher")!;
  assert.ok(each.frame, "a block still opens the frame");
  const body = flow.nodes.find((n) => n.id === each.resultFrom)!;
  assert.equal(body.title, "Steps");
  assert.equal(body.species, "unknown");
});

test("collections draw one port per value", () => {
  const obj = projectExpr("{ id: 1, name: user.name, on: true }");
  const record = obj.nodes.find((n) => n.kind === "object")!;
  assert.deepEqual(record.rows.map((r) => r.name), ["id", "name", "on"]);
  assert.deepEqual(record.rows.map((r) => r.wired), [false, false, false]);
  assert.equal(record.subtitle, "", "the rows already say how many there are");

  const arr = projectExpr("[1, a + b, 'x']");
  const list = arr.nodes.find((n) => n.kind === "array")!;
  assert.deepEqual(list.rows.map((r) => r.name), ["0", "1", "2"]);
  assert.deepEqual(list.rows.map((r) => r.wired), [false, false, false],
    "`a + b` is three atoms: it rides in the row as text, not as a card");
  assert.equal(list.rows[1]!.inline, "a + b");

  // An entry too big to fold is still a wire.
  const wide = projectExpr("[1, f(a, b, c, d), 'x']");
  const held = wide.nodes.find((n) => n.kind === "array")!;
  assert.deepEqual(held.rows.map((r) => r.wired), [false, true, false]);
});

test("a collection past the row cap chips its quiet rows and keeps its wires", () => {
  const items = Array.from({ length: 40 }, (_, i) => (i === 7 ? "f(a, b, c, d)" : String(i)));
  const flow = projectExpr("[" + items.join(", ") + "]");
  const list = flow.nodes.find((n) => n.kind === "array")!;
  assert.equal(list.rows.length, 1, "only the wired row survives");
  assert.equal(list.rows[0]!.wired, true);
  assert.equal(list.chip, "39 more, all typed in");
  assert.equal(list.subtitle, "40 items", "the count comes back where a chip hides rows");
});

test("a collection at or under the row cap keeps every row", () => {
  const flow = projectExpr("[" + Array.from({ length: 8 }, (_, i) => i).join(", ") + "]");
  const list = flow.nodes.find((n) => n.kind === "array")!;
  assert.equal(list.rows.length, 8);
  assert.equal(list.chip, undefined);
  const over = projectExpr("[" + Array.from({ length: 9 }, (_, i) => i).join(", ") + "]");
  assert.equal(over.nodes.find((n) => n.kind === "array")!.chip, "9 more, all typed in");
});

test("a card never shows more rows than a person scans, computed rows or not", () => {
  // EIGHT, not twenty-four. Reliable simultaneous-object capacity for a picture is about four
  // chunks and comfortable scanning tops out near nine, and at 24 the heaviest drawing in the
  // repo's own corpus was 633 objects across 233 rows. The quiet rows go first, because
  // "which of these is COMPUTED" is the question the card exists to answer; only when the
  // computed rows ALONE overflow does the run's head-and-last rule apply to them too.
  const mixed = "{ " + Array.from({ length: 30 }, (_, i) =>
    i % 5 === 0 ? `k${i}: f(a, b, c, d)` : `k${i}: ${i}`).join(", ") + " }";
  const record = projectExpr(mixed).nodes.find((n) => n.kind === "object")!;
  assert.equal(record.rows.length, 6, "the six computed fields, and the typed ones chipped");
  assert.ok(record.rows.every((r) => r.wired));
  assert.equal(record.chip, "24 more, all typed in");

  const allComputed = "{ " + Array.from({ length: 30 }, (_, i) =>
    `k${i}: f(a, b, c, ${i})`).join(", ") + " }";
  const heavy = projectExpr(allComputed).nodes.find((n) => n.kind === "object")!;
  assert.ok(heavy.rows.length <= 8, `a card showed ${heavy.rows.length} rows`);
  assert.equal(heavy.chip, "23 more, 23 computed");
  assert.equal(heavy.rows.at(-1)!.name, "k29", "the last field is where the record ends");

  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      assert.ok(n.rows.length <= 8, `${src}: ${n.title} shows ${n.rows.length} rows`);
    }
  }
});

test("literal and linked are reported on every row", () => {
  const flow = projectExpr("total * 2 + tax(order)");
  for (const n of flow.nodes) {
    for (const r of n.rows) {
      assert.equal(typeof r.wired, "boolean");
      if (r.wired) {
        assert.ok(r.from, "a wired row must name its source");
        assert.equal(r.value, "", "a wired row holds no literal");
      } else {
        assert.equal(r.from, undefined);
        // An unwired row is a value the author typed OR a subtree folded to its own text,
        // and the folded one names itself rather than pretending to be a literal.
        if (r.mode === "expression") {
          assert.ok(r.inline, "an unwired row that is not a literal must say it is a fold");
          assert.equal(r.expandable, true);
          assert.equal(r.value, "", "a fold holds no literal");
        }
      }
    }
  }
  const mul = projectExpr("total * 2").nodes.find((n) => n.title === "Multiply")!;
  assert.deepEqual(mul.rows.map((r) => [r.name, r.wired, r.value, r.mode]),
    [["0", false, "total", "reference"], ["1", false, "2", "number"]]);
});

test("a name and a typed value are different kinds of unwired", () => {
  const flow = projectExpr("a + 1 + 'x' + true");
  const modes = flow.nodes.flatMap((n) => n.rows).filter((r) => !r.wired).map((r) => r.mode);
  assert.ok(modes.includes("reference"));
  assert.ok(modes.includes("number"));
  assert.ok(modes.includes("text"));
  assert.ok(modes.includes("boolean"));
});

test("the terminus is one card, always, and the Result is only drawn where it converges", () => {
  // THE SENTENCE THIS REPLACES: "the output node is always present". It was, and on the 60%
  // of real expressions that are a single atom it was two thirds of the ink - a second card,
  // a row, three sockets and a wire to say `dsx.attribute.icon`. A Result says "and that is
  // the answer", which one producing card already says by being the only card.
  for (const { src, flow } of flows) {
    const term = flow.nodes.filter((n) => n.terminus);
    assert.equal(term.length, 1, `${src}: exactly one card carries the terminus`);
    const out = flow.nodes.find((n) => n.kind === "output");
    const producers = flow.nodes.filter((n) => n.kind !== "output").length;
    assert.equal(out !== undefined, producers >= 2,
      `${src}: ${producers} producing cards but ${out ? "a" : "no"} Result`);
    assert.equal(term[0]!.id, out ? out.id : flow.nodes[flow.nodes.length - 1]!.id);
    const right = Math.max(...flow.nodes.map((n) => n.x + n.w));
    assert.equal(term[0]!.x + term[0]!.w, right, `${src}: the terminus must be rightmost`);
    // The WHOLE expression's range travels with the terminus: that is the handle a wrap
    // writes through, and the root's own span is not it.
    assert.equal(term[0]!.span.start, flow.span.start, src);
    assert.equal(term[0]!.span.end, flow.span.end, src);
    if (out) assert.equal(out.rows.length, 0, `${src}: the Result's operand is its abutment`);
  }
  assert.equal(projectExpr("total").nodes.length, 1, "a bare name is ONE chip");
  assert.equal(projectExpr("total").edges.length, 0, "no graph, no wire");
});

test("a wrap through the terminus keeps the bytes the author parenthesised", () => {
  const src = "(a + b)";
  const term = projectExpr(src).nodes.find((n) => n.terminus)!;
  assert.equal(term.text, "(a + b)", "the terminus holds the whole expression, not the root");
  assert.equal(applyExprEdit(src, { op: "wrap", span: term.span, template: "$ * 2" }),
    "(a + b) * 2");
});

test("operators are named as verbs, not as symbols", () => {
  const titles = new Set<string>();
  // One card per operator, so the naming law is measured on the naming and not on whichever
  // operands happened to be small enough to fold.
  for (const src of ["f(a, b, c) + g(d, e, f)", "f(a, b, c) * g(d, e, f)",
    "f(a, b, c) > g(d, e, f)", "f(a, b, c) && g(d, e, f)", "!f(a, b, c, d)"]) {
    for (const n of projectExpr(src).nodes) titles.add(n.title);
  }
  for (const want of ["Add", "Multiply", "Is Greater Than", "And", "Not", "Result"]) {
    assert.ok(titles.has(want), `missing ${want} in ${[...titles].join(", ")}`);
  }
  for (const { flow } of flows) for (const n of flow.nodes) titles.add(n.title);
  assert.ok(![...titles].some((t) => /^[!&|<>=+*/%^~-]+$/.test(t)), "no title is a bare symbol");
});

test("no leaf becomes a card of its own", () => {
  const flow = projectExpr("a + 1");
  assert.equal(flow.nodes.length, 1, "one Add carrying the terminus, and nothing else");
  assert.equal(flow.edges.length, 0);
  assert.deepEqual(flow.nodes[0]!.rows.map((r) => r.value), ["a", "1"]);
});

test("the ternary draws three named arms and none of them is cold", () => {
  const flow = projectExpr("ready ? total * 2 : 0");
  const choose = flow.nodes.find((n) => n.kind === "ternary")!;
  assert.deepEqual(choose.rows.map((r) => r.name), ["If", "Then", "Else"]);
  // JSE evaluates both arms; nothing in the model says otherwise.
  assert.ok(!("cold" in choose), "an arm is never drawn cold - JSE has no short-circuit");
});

// ── 5. scale ─────────────────────────────────────────────────────────────────────────

test("stress: a thousand-node expression projects fast and cleanly", () => {
  // NOT one flat list any more: a card caps at eight rows, so a thousand entries in one
  // array is eight rows and a chip - which is the point of the cap and the opposite of a
  // stress. A six-way tree four deep holds the shape this test was built for: fifteen hundred
  // boxes, real fan-in at every level, and every arm too big to ride in a row as text.
  let leaf = 0;
  const group = (xs: string[]): string => "[" + xs.join(", ") + "]";
  const level = (depth: number): string => depth === 0
    ? (leaf++, `f${leaf}(a${leaf}, b${leaf}, c${leaf}, d${leaf}, e${leaf})`)
    : group(Array.from({ length: 6 }, () => level(depth - 1)));
  const src = level(4);
  const t0 = performance.now();
  const flow = projectExpr(src);
  const ms = performance.now() - t0;
  assert.ok(flow.nodes.length >= 1000, `only ${flow.nodes.length} nodes`);
  assert.equal(flow.exact, true);
  assert.ok(ms < 2500, `projection took ${ms.toFixed(0)}ms`);
  const list = flow.nodes.find((n) => n.kind === "array")!;
  assert.ok(list.rows.length <= 8, "and the card that holds them still fits a reader");

  const bs = boxes(flow).sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
  // Column-bucketed sweep: an O(n^2) pass over a thousand boxes is the test's own bottleneck.
  const cols = new Map<number, typeof bs>();
  for (const b of bs) {
    const key = Math.round(b.x0);
    if (!cols.has(key)) cols.set(key, []);
    cols.get(key)!.push(b);
  }
  for (const col of cols.values()) {
    col.sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < col.length; i++) {
      assert.ok(col[i]!.y0 >= col[i - 1]!.y1, `two boxes overlap in a column at y=${col[i]!.y0}`);
    }
  }
});

test("stress: a deeply nested expression stays inside its extent", () => {
  let src = "x";
  for (let i = 0; i < 150; i++) src = `f${i}(${src})`;
  const flow = projectExpr(src);
  assert.equal(flow.exact, true);
  for (const n of flow.nodes) {
    assert.ok(n.x >= 0 && n.x + n.w <= flow.width);
    assert.ok(n.y >= 0 && n.y + n.h <= flow.height);
  }
});

test("stress: nested higher-order frames nest their bodies", () => {
  const src = "a.map(x => b.map(y => c.map(z => x + y + z)))";
  const flow = projectExpr(src);
  assert.equal(flow.exact, true);
  const frames = flow.nodes.filter((n) => n.frame);
  assert.equal(frames.length, 3);
  for (const f of frames) {
    const body = flow.nodes.find((n) => n.id === f.resultFrom)!;
    assert.ok(body.x >= f.frame!.x && body.x + body.w <= f.frame!.x + f.frame!.w,
      `${f.title}'s body escapes its frame`);
  }
});

test("past the recursion cap the drawing is still total and says so", () => {
  // The parser guards its own stack at 200 frames. Beyond that the form is not refused, it
  // is drawn as one opaque card holding its own bytes - and `exact` goes false, which is
  // what refuses a structural write.
  let src = "x";
  for (let i = 0; i < 400; i++) src = `f${i}(${src})`;
  const flow = projectExpr(src);
  assert.equal(flow.exact, false);
  assert.ok(flow.nodes.length > 1);
  assert.equal(reconstructExpr(flow), src);
});

test("the projection is deterministic", () => {
  for (const src of FORMS) {
    assert.equal(JSON.stringify(projectExpr(src)), JSON.stringify(projectExpr(src)), src);
  }
});

// ── 6. the item, made visible ────────────────────────────────────────────────────────

test("a row that reads the item is wired to the pill, not typed as a value", () => {
  const flow = projectExpr("rows.filter(r => r.price > 10)");
  const keep = flow.nodes.find((n) => n.species === "higher")!;
  const cmp = flow.nodes.find((n) => n.title === "Is Greater Than")!;
  const left = cmp.rows[0]!;
  assert.equal(left.param, keep.params![0]!.id, "the left operand reads the pill");
  assert.equal(left.reach, "price", "and it reaches `price` off it");
  assert.equal(left.wired, false, "it is not fed by a card");
  assert.equal(left.value, "r.price", "the path is still the text the author wrote");
  const edge = flow.edges.find((e) => e.param)!;
  assert.ok(edge, "a parameter read draws an edge");
  assert.equal(edge.from, keep.id);
  assert.equal(edge.to, cmp.id);
  assert.equal(cmp.rows[1]!.param, undefined, "a real literal is still a literal");
});

test("an unread pill says so", () => {
  const flow = projectExpr("rows.map(r => other.value + 1)");
  const map = flow.nodes.find((n) => n.species === "higher")!;
  assert.equal(map.params![0]!.used, false, "nothing in the body reads `r`");
});

test("a nested container can read the outer item, and the wire crosses the frame", () => {
  const flow = projectExpr("outer.map(a => inner.filter(b => b.n > a.n))");
  const map = flow.nodes.find((n) => n.title === "Map Over")!;
  const cmp = flow.nodes.find((n) => n.title === "Is Greater Than")!;
  const outerPill = map.params![0]!;
  assert.equal(cmp.rows[1]!.param, outerPill.id, "`a.n` reads the outer item");
  assert.equal(cmp.rows[1]!.reach, "n");
  const inner = flow.nodes.find((n) => n.title === "Keep Where")!;
  assert.equal(cmp.rows[0]!.param, inner.params![0]!.id, "`b.n` reads the inner one");
});

test("an inner parameter shadows an outer one of the same name", () => {
  const flow = projectExpr("outer.map(x => inner.map(x => x.n))");
  const maps = flow.nodes.filter((n) => n.species === "higher");
  const innerMap = maps.find((n) => n.folded)!;
  assert.equal(innerMap.rows.find((r) => r.name === "Each")!.item, "x",
    "the fold reads its OWN x, not the one two frames out");
});

test("a folded container carries its item in the row, since it draws no rail", () => {
  const flow = projectExpr("rows.map(r => r.price)");
  const map = flow.nodes.find((n) => n.species === "higher")!;
  assert.equal(map.params, undefined, "no rail when there is no frame");
  const each = map.rows.find((r) => r.name === "Each")!;
  assert.equal(each.item, "r");
  assert.equal(each.reach, "price");
  assert.equal(each.param, undefined, "and no dangling wire to a pill that is not drawn");
  assert.equal(flow.edges.some((e) => e.param), false);
});

test("every parameter edge names a pill that exists and is placed", () => {
  for (const { src, flow } of flows) {
    for (const e of flow.edges) {
      if (!e.param) continue;
      const owner = flow.nodes.find((n) => n.id === e.from)!;
      const pill = (owner.params ?? []).find((p) => p.id === e.param);
      assert.ok(pill, `${src}: an edge leaves a pill that is not drawn`);
      assert.ok(pill!.outX > 0 && pill!.outY > 0, `${src}: the ${pill!.name} pill is at the origin`);
    }
  }
});

// ── 7. the file's bytes, not the language's ──────────────────────────────────────────

test("an expression inside markup reads as the language, and writes as the file", () => {
  // What a `.dsx` body actually holds. `=&gt;` is an arrow, `&amp;&amp;` is an and, and a
  // parser that read these as text would draw a Custom Code card for every lambda.
  const raw = "rows.filter(r =&gt; r.n &gt; 2 &amp;&amp; r.ok).map(r =&gt; r.n)";
  const flow = projectExpr(raw);
  assert.equal(flow.exact, true, "the entities must not defeat the reader");
  assert.equal(flow.source, "rows.filter(r => r.n > 2 && r.ok).map(r => r.n)");
  assert.equal(reconstructExpr(flow), raw, "and the file's own bytes come back unchanged");
  assert.ok(flow.nodes.some((n) => n.title === "Keep Where"));
  assert.ok(flow.nodes.some((n) => n.title === "Map Over"));
  assert.ok(flow.nodes.some((n) => n.title === "And"));
  assert.ok(flow.nodes.some((n) => n.title === "Is Greater Than"));
});

test("a span still addresses the FILE when the text it names carries entities", () => {
  const raw = "a &amp;&amp; b";
  const flow = projectExpr(raw);
  const and = flow.nodes.find((n) => n.title === "And")!;
  assert.equal(and.span.start, 0);
  assert.equal(and.span.end, raw.length);
  assert.equal(and.text, "a && b", "the node reads as the language");
  const right = and.rows[1]!;
  assert.equal(raw.slice(right.span.start, right.span.end), "b", "the row addresses the file");
  assert.equal(applyExprEdit(raw, { op: "replace", span: right.span, text: "c" }), "a &amp;&amp; c");
});

test("in a CODE body the entity rule is the evaluator's: three, and never inside a literal", () => {
  // `decodeOperatorEntities` decodes `&amp;`, `&lt;` and `&gt;` and skips quoted, template
  // and regex spans - so `'a &amp; b'` really IS a nine-character string at runtime, and a
  // drawing that showed `a & b` would be describing a program nobody is running.
  const raw = "x &lt;= 10 ? 'a &amp; b' : 'plain'";
  const flow = projectExpr(raw);
  assert.equal(flow.exact, true);
  assert.equal(flow.source, "x <= 10 ? 'a &amp; b' : 'plain'");
  const choose = flow.nodes.find((n) => n.kind === "ternary")!;
  assert.equal(choose.rows[1]!.value, "a &amp; b", "the entity inside the literal is data");
  assert.equal(reconstructExpr(flow), raw);
});

test("in an ATTRIBUTE body every entity is already a character, numeric forms included", () => {
  // An `on:tap=` handler is decoded by the XML reader before the evaluator sees it, so the
  // reader has to match THAT rule instead - all five, plus `&#NN;`, inside literals too.
  const raw = "label == &quot;a &amp; b&quot; &amp;&amp; n &gt; 1";
  const flow = projectExpr(raw, undefined, "attr");
  assert.equal(flow.exact, true);
  assert.equal(flow.source, 'label == "a & b" && n > 1');
  assert.equal(reconstructExpr(flow), raw);
  // `label == "a & b"` is three atoms, so it rides in the `And` card's row as its own text -
  // decoded as the language, exactly as a card's row would hold it.
  const and = flow.nodes.find((n) => n.title === "And")!;
  assert.equal(and.rows[0]!.inline, 'label == "a & b"');
  const eq = projectExpr("label == &quot;a &amp; b&quot;", undefined, "attr").nodes
    .find((n) => n.title === "Is Equal To")!;
  assert.equal(eq.rows[1]!.value, "a & b");

  const numeric = projectExpr("s == 'a&#10;b'", undefined, "attr");
  assert.equal(numeric.exact, true);
  assert.equal(numeric.source, "s == 'a\nb'");
});

test("every row's span names bytes that decode to its own text", () => {
  for (const [raw, context] of [
    ["x &lt;= 10 ? 'plain' : `${x} &gt; 10`", "text"],
    ["a &amp;&amp; b &lt; c", "text"],
    ["f(&quot;x&quot;, &apos;y&apos;) &amp;&amp; z", "attr"],
  ] as const) {
    const flow = projectExpr(raw, undefined, context);
    assert.equal(flow.exact, true, raw);
    for (const n of flow.nodes) {
      if (n.kind === "output") continue;
      for (const r of n.rows) {
        const held = decodeRange(raw, r.span, context).plain;
        assert.equal(r.text, held, `${raw} :: ${n.title}/${r.name}`);
      }
    }
  }
});

// ── 8. a run of one operator is one node ─────────────────────────────────────────────

test("a left-nested run of the same operator draws as one node with ordered rows", () => {
  const flow = projectExpr("a + b + c + d");
  assert.equal(flow.nodes.length, 1, "one Add carrying the terminus, not three Adds");
  const add = flow.nodes.find((n) => n.title === "Add")!;
  assert.deepEqual(add.rows.map((r) => r.name), ["0", "1", "2", "3"]);
  assert.deepEqual(add.rows.map((r) => r.value), ["a", "b", "c", "d"]);
  assert.equal(add.subtitle, "4 values");
  assert.equal(add.span.start, 0);
  assert.equal(add.span.end, "a + b + c + d".length);
});

test("the run stops at a precedence break, and each row still owns its own bytes", () => {
  // The break is still a break - `b * c` is not an arm of the sum - and what sits in the
  // sum's second row is that product's own source text, spliceable exactly as a card was.
  const src = "a + b * c + d";
  const flow = projectExpr(src);
  const add = flow.nodes.find((n) => n.title === "Add")!;
  assert.deepEqual(add.rows.map((r) => [r.name, r.wired]),
    [["0", false], ["1", false], ["2", false]]);
  assert.equal(add.rows[1]!.inline, "b * c");
  for (const r of add.rows) assert.equal(r.text, src.slice(r.span.start, r.span.end));
  assert.equal(src.slice(add.rows[1]!.span.start, add.rows[1]!.span.end), "b * c");

  // And where the product is too big to be text, it is a card, and the break still holds.
  const wide = projectExpr("a + f(b, c, d, e) * g(h) + d");
  const sum = wide.nodes.find((n) => n.title === "Add")!;
  assert.deepEqual(sum.rows.map((r) => r.wired), [false, true, false]);
  assert.ok(wide.nodes.some((n) => n.title === "Multiply"));
});

test("a run the author parenthesised keeps its grouping, verbatim", () => {
  // It used to keep it as a SECOND CARD. It keeps it as the author's own characters now,
  // which is a stronger guarantee for a third of the ink: the well reads `(a + b)`,
  // parentheses and all, and the ladder never reaches across them.
  const flow = projectExpr("(a + b) + c");
  const add = flow.nodes.find((n) => n.title === "Add")!;
  assert.deepEqual(add.rows.map((r) => r.name), ["0", "1"], "two arms, not three");
  assert.equal(add.rows[0]!.inline, "(a + b)");
  assert.equal(add.rows[0]!.expandable, true, "and one gesture puts the card back");

  // Too big to be text, and the group is a card of its own again.
  const big = projectExpr("(a + b + c + d + e) + f");
  assert.equal(big.nodes.filter((n) => n.title === "Add").length, 2);
});

test("a ladder of one precedence rung is one card, and it says which ladder it is", () => {
  // THE SENTENCE THIS REPLACES: only `+ * && || ??` merged, because "a - b - c means a, less
  // b, less c and a list of three unlabelled arms would read as a bag". The arms are not
  // unlabelled any more - a run of ONE operator carries the source on its head where the
  // order is the answer, and a run of SEVERAL carries the operation on every arm - so the
  // reason for the exception is gone and the compaction is not.
  for (const src of ["a - b - c", "a / b / c", "a % b % c", "a * b * c",
    "a && b && c", "a || b || c", "a ?? b ?? c"]) {
    const flow = projectExpr(src);
    assert.equal(flow.nodes.filter((n) => n.kind === "binary").length, 1, src);
    assert.deepEqual(flow.nodes[0]!.rows.map((r) => r.name), ["0", "1", "2"], src);
  }
  // A bag in order is named by its count; anything where the ORDER is the answer puts its own
  // source on the head, which is the one caption that cannot mislead.
  assert.equal(projectExpr("a + b + c").nodes[0]!.subtitle, "3 values");
  assert.equal(projectExpr("a - b - c").nodes[0]!.subtitle, "a - b - c");

  // Mixed rung: one card, and every arm named by the operation that consumes it.
  const mixed = projectExpr("a - b + c - d").nodes[0]!;
  assert.deepEqual(mixed.rows.map((r) => r.name), ["0", "Subtract", "Add", "Subtract"]);
  assert.equal(mixed.subtitle, "a - b + c - d");

  // NEVER ACROSS A RUNG. A flat row list is read as a left fold, and read that way
  // `a - b * c` says the wrong number - so the product stays its own thing.
  const broken = projectExpr("a - f(b, c, d) * g(e)");
  assert.equal(broken.nodes.filter((n) => n.title === "Multiply").length, 1);
  assert.deepEqual(broken.nodes.find((n) => n.title === "Subtract")!.rows.map((r) => r.name),
    ["From", "By"]);

  // And never through the one right-associative operator: `2 ** 3 ** 2` is 2 ** (3 ** 2),
  // and three arms read left to right would be 64 instead of 512.
  const power = projectExpr("2 ** 3 ** 2").nodes.find((n) => n.title === "To The Power Of")!;
  assert.deepEqual(power.rows.map((r) => r.name), ["Base", "Power"]);
  assert.equal(power.rows[1]!.inline, "3 ** 2");
});

test("a two-term run is numbered like a longer one, and says nothing more", () => {
  const add = projectExpr("a + b").nodes.find((n) => n.title === "Add")!;
  assert.deepEqual(add.rows.map((r) => r.name), ["0", "1"]);
  assert.equal(add.subtitle, "");
});

test("flattening leaves the text and the write contract alone", () => {
  const src = "p0 * q0 + p1 * q1 + p2 * q2 + p3 * q3";
  const flow = projectExpr(src);
  assert.equal(reconstructExpr(flow), src);
  assert.equal(flow.exact, true);
  const add = flow.nodes.find((n) => n.title === "Add")!;
  assert.equal(add.rows.length, 4);
  let last = -1;
  for (const r of add.rows) {
    assert.ok(r.span.start >= last, "rows stay in source order");
    last = r.span.end;
    assert.equal(r.text, src.slice(r.span.start, r.span.end));
  }
  // and one row's edit still touches only that row
  const next = applyExprEdit(src, { op: "replace", span: add.rows[2]!.span, text: "9" });
  assert.equal(next, "p0 * q0 + p1 * q1 + 9 + p3 * q3");
});

test("a forty-term sum folds its middle: seven rows, and a chip that says what went", () => {
  // The defect this replaces: forty rows every one of which read `<- Multiply`, 490px of
  // zero entropy, on a card that already said `40 values` in its own corner. It was seven
  // rows and seven Multiply cards and eight wires; it is seven rows of TEXT and no cards and
  // no wires at all, because `p0.price * p0.qty` is three atoms.
  const src = Array.from({ length: 40 }, (_, i) => `p${i}.price * p${i}.qty`).join(" + ");
  const flow = projectExpr(src);
  const add = flow.nodes.find((n) => n.title === "Add")!;
  assert.deepEqual(add.rows.map((r) => r.name), ["0", "1", "2", "3", "4", "5", "39"],
    "the head a reader starts at, and the arm the sum ends on");
  assert.equal(add.subtitle, "40 values", "the count is still on the card");
  assert.equal(add.chip, "33 more, all Multiply");
  assert.equal(7 + 33, 40, "what is drawn plus what the chip claims is the whole run");
  assert.deepEqual(add.rows.map((r) => r.inline),
    ["p0.price * p0.qty", "p1.price * p1.qty", "p2.price * p2.qty", "p3.price * p3.qty",
     "p4.price * p4.qty", "p5.price * p5.qty", "p39.price * p39.qty"],
    "and every kept arm shows its own source, whole");
  assert.equal(flow.nodes.length, 1, "one card - it was nine");
  assert.equal(flow.edges.length, 0, "and nothing dangling, because there is nothing to dangle");
  assert.equal(add.span.start, 0, "the node still owns every byte of the run");
  assert.equal(add.span.end, src.length);
  assert.equal(reconstructExpr(flow), src);
  assert.equal(flow.exact, true);
});

test("a run folds only past the chip threshold, and names only one kind if that is true", () => {
  const arms = (n: number, f: (i: number) => string) =>
    projectExpr(Array.from({ length: n }, (_, i) => f(i)).join(" + "))
      .nodes.find((x) => x.title === "Add")!;

  const kept = arms(8, (i) => String(i));
  assert.equal(kept.rows.length, 8, "at the threshold every arm is still its own row");
  assert.equal(kept.chip, undefined);

  const folded = arms(9, (i) => String(i));
  assert.equal(folded.rows.length, 7);
  assert.equal(folded.chip, "2 more, all typed in");

  const mixed = arms(30, (i) => (i % 3 === 0 ? String(i) : i % 3 === 1 ? `q${i}.n * 2` : `g${i}(x)`));
  assert.equal(mixed.chip, "23 more",
    "a band of three kinds is named by its count alone - `all Multiply` would be a lie");

  const ands = projectExpr(Array.from({ length: 26 }, (_, i) => `ok${i}`).join(" && "));
  assert.equal(ands.nodes.find((n) => n.title === "And")!.chip, "19 more, all typed in",
    "the fold is the run's, not the plus sign's");
});

test("a folded run still splices, and the rows it kept still own their own bytes", () => {
  const src = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" * ");
  const flow = projectExpr(src);
  const mul = flow.nodes.find((n) => n.title === "Multiply")!;
  for (const r of mul.rows) assert.equal(r.text, src.slice(r.span.start, r.span.end));
  assert.equal(mul.rows[6]!.text, "w29", "the last arm is the last arm, not the seventh");
  const next = applyExprEdit(src, { op: "replace", span: mul.rows[6]!.span, text: "9" });
  assert.equal(next, src.slice(0, src.length - 3) + "9");
  assert.equal(projectExpr(next).exact, true);
});

// ── 6. the glyph plane ───────────────────────────────────────────────────────────────
//  Nothing used to check these names. A typo drew the renderer's placeholder circle, the
//  browser logged a warn nobody collected, and every lane stayed green - so the two editors
//  could rot one icon at a time. These three tests are that hole closed: the corpus is the
//  only vocabulary either editor may draw from, and a name that stops resolving fails here.

const SF_MAP = JSON.parse(readFileSync(
  new URL("../../../../Conformance/icons/sf-map.json", import.meta.url), "utf-8",
)) as { icons: Record<string, unknown>; web_extra: Record<string, string> };
const DRAWABLE = new Set([...Object.keys(SF_MAP.icons), ...Object.keys(SF_MAP.web_extra)]);

test("every glyph the expression projection emits resolves in the icon corpus", () => {
  const seen = new Map<string, string>();
  for (const src of FORMS) {
    for (const n of projectExpr(src).nodes) {
      assert.ok(n.glyph !== "", `${n.title} (${src}) drew no glyph at all`);
      seen.set(n.glyph, n.title);
    }
  }
  const missing = [...seen].filter(([g]) => !DRAWABLE.has(g));
  assert.deepEqual(missing, [], "glyph names absent from sf-map.json");
  assert.ok(seen.size >= 40, `the corpus should exercise many marks, saw ${seen.size}`);
});

test("the operation, not the family, picks the mark", () => {
  // The regression this guards: one `plus` under Add, Subtract, Divide and Remainder alike.
  const marks = (src: string) => new Map(projectExpr(src).nodes.map((n) => [n.title, n.glyph]));
  // One expression per operator: five operators in one expression are ONE card now, and a
  // census of marks taken off a merged card would be measuring the merge, not the marks.
  const arith = new Map<string, string>();
  for (const op of ["+", "-", "*", "/", "%"]) {
    for (const [t, g] of marks(`f(a, b, c) ${op} g(d, e, h)`)) arith.set(t, g);
  }
  const distinct = new Set([...arith].filter(([t]) => t !== "Result" && t !== "F" && t !== "G")
    .map(([, g]) => g));
  assert.equal(distinct.size, 5, "five arithmetic operators, five marks");
  const chain = marks("rows.filter(r => r.ok).map(r => r.n).join(', ')");
  assert.equal(chain.get("Keep Where"), "dsx.filter");
  assert.equal(chain.get("Map Over"), "dsx.map");
  assert.equal(chain.get("Join"), "dsx.join");
});

test("both editors draw only names the corpus knows", () => {
  // EditorLogic.dsx keeps its statement marks in markup, so read them out of the source
  // rather than trusting them: the file is as much a glyph consumer as this module is.
  const dsx = readFileSync(new URL(
    "../../../../../ClosedSource/DSX/Modules/Custom/Editor/Components/EditorLogic.dsx",
    import.meta.url), "utf-8");
  const body = dsx.slice(dsx.indexOf("function logicIcon"));
  // Every VALUE in the function - the `'Title': 'mark'` rows and the `kind == 'x' ? 'mark'`
  // floor alike. Matching values only is what keeps the kind names out of the sample.
  const names = [...body.slice(0, body.indexOf("\n      }")).matchAll(/[:?]\s*'([a-z][\w.]*)'/g)]
    .map((m) => m[1]!);
  assert.ok(names.length >= 60, `logicIcon should name many marks, found ${names.length}`);
  assert.deepEqual([...new Set(names.filter((n) => !DRAWABLE.has(n)))], [],
    "EditorLogic glyph names absent from sf-map.json");
  assert.ok(new Set(names).size >= 45,
    `the statement steps should not collapse onto one mark, saw ${new Set(names).size}`);
});

// ── 9. one base, and a name for every socket ─────────────────────────────────────────
//  Measured across the canvases: `Or Else` numbered its arms 1, 2, 3 while `List` numbered
//  its entries 0, 1, 2, in the same editor in the same session; and `Left`/`Right` sat on a
//  commutative `+` as if the sides were roles while `Is At Least` hid the one role that
//  matters behind `This`/`That`. Both are one rule now: a name is a ROLE where the operator
//  has one, and a 0-BASED INDEX where it does not.

test("every position the drawing names counts from zero", () => {
  const names = (src: string, title: string) =>
    projectExpr(src).nodes.find((n) => n.title === title)!.rows.map((r) => r.name);

  assert.deepEqual(names("[a, b, c]", "List"), ["0", "1", "2"]);
  assert.deepEqual(names("a ?? b ?? c", "Or Else"), ["0", "1", "2"],
    "the run and the list are the same editor, so they are the same base");
  assert.deepEqual(names("a + b + c", "Add"), ["0", "1", "2"]);
  assert.deepEqual(names("unknownFn(a, b)", "Unknown Fn"), ["0", "1"]);
  assert.deepEqual(names("`${a}${b}`", "Build Text"), ["Part 0", "Part 1"]);

  for (const { src, flow } of flows) {
    const abutted = new Set(flow.nodes.map((n) => n.abuts?.to).filter((x) => x !== undefined));
    for (const n of flow.nodes) {
      const numeric = n.rows.filter((r) => /^\d+$/.test(r.name));
      if (numeric.length !== n.rows.length || n.rows.length === 0) continue;
      // A NUMBER IS THE TRUE SOURCE POSITION, which is a stronger promise than "the list
      // starts at zero". Where position zero is the card ABUTTING the left wall, the rows
      // that remain keep the positions they actually hold - renumbering them would be the
      // drawing lying about which arm is which, to save a reader one inference they can make
      // by looking left.
      const from = abutted.has(n.id) ? "1" : "0";
      assert.equal(numeric[0]!.name, from,
        `${src}: ${n.title} numbers its rows from ${numeric[0]!.name}`);
    }
    for (const n of flow.nodes) {
      for (const r of n.rows) {
        assert.ok(!/^Argument /.test(r.name), `${src}: ${n.title} gave up and said ${r.name}`);
      }
    }
  }
});

test("an operator names its operands only where position is a role", () => {
  const names = (src: string) => {
    const flow = projectExpr(src);
    return flow.nodes.find((n) => n.kind === "binary")!.rows.map((r) => r.name);
  };
  // Commutative, or near enough that neither side is a role: the position is the whole
  // truth, and a position is a number here.
  for (const src of ["a + b", "a * b", "a && b", "a || b", "a == b", "a != b",
    "a === b", "a !== b", "a & b", "a | b", "a ^ b"]) {
    assert.deepEqual(names(src), ["0", "1"], src);
  }
  // A real role pair, named for the role. `This`/`That` on `>=` could not say which side
  // was the minimum, which is the only thing anybody asks of a `>=`.
  assert.deepEqual(names("a < b"), ["Value", "Below"]);
  assert.deepEqual(names("a <= b"), ["Value", "Maximum"]);
  assert.deepEqual(names("a > b"), ["Value", "Above"]);
  assert.deepEqual(names("a >= b"), ["Value", "Minimum"]);
  assert.deepEqual(names("a - b"), ["From", "By"]);
  assert.deepEqual(names("a / b"), ["From", "By"]);
  assert.deepEqual(names("2 ** 3"), ["Base", "Power"]);
  assert.deepEqual(names("a ?? b"), ["Value", "Fallback"]);
  assert.deepEqual(names("'k' in obj"), ["Key", "In"]);
  assert.deepEqual(names("a << 2"), ["Value", "By"]);

  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      for (const r of n.rows) {
        assert.ok(!["Left", "Right", "This", "That", "First", "Second"].includes(r.name),
          `${src}: ${n.title} still names a socket for where it sits`);
      }
    }
  }
});

// The two tables the projection names methods with, read out of the source: a method that
// gains a TITLE without gaining argument names is the defect this census exists to catch,
// and a census that cannot see the table cannot catch it. The eleven are the methods that
// take nothing at all - `.trim()` has no argument to name.
const EXPRFLOW_SRC = readFileSync(new URL("../src/exprflow.ts", import.meta.url), "utf-8");
function tableKeys(name: string): string[] {
  const at = EXPRFLOW_SRC.indexOf("const " + name + ": Record<string, ");
  assert.ok(at > 0, `${name} is not a table in exprflow.ts any more`);
  const open = EXPRFLOW_SRC.indexOf("table({", at);
  const close = EXPRFLOW_SRC.indexOf("});", open);
  assert.ok(open > 0 && close > open, `${name} does not close`);
  return [...EXPRFLOW_SRC.slice(open + 7, close).matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g)]
    .map((m) => m[1]!);
}
const TAKES_NOTHING = ["toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd",
  "reverse", "toReversed", "toISOString", "getTime", "json", "text"];

test("every titled method names its arguments, the way toFixed names Decimals", () => {
  const titled = tableKeys("METHOD_TITLE");
  const named = new Set(tableKeys("ARG_NAMES"));
  assert.equal(titled.length, 44, "the titled-method census moved - name the method that landed");
  assert.equal(TAKES_NOTHING.length, 11);
  for (const fn of TAKES_NOTHING) {
    assert.ok(titled.includes(fn), `${fn} is not a titled method`);
    assert.ok(!named.has(fn), `${fn} takes nothing, so it has nothing to name`);
  }
  const unnamed = titled.filter((fn) => !named.has(fn) && !TAKES_NOTHING.includes(fn));
  assert.deepEqual(unnamed, [], "a titled method with a positional argument row");

  // And it is really the drawing that says so, not just the table.
  for (const fn of titled) {
    if (TAKES_NOTHING.includes(fn)) continue;
    const flow = projectExpr(`v.${fn}(a)`);
    const call = flow.nodes.find((n) => n.kind === "method")!;
    const arg = call.rows[1]!;
    assert.ok(!/^\d+$/.test(arg.name), `v.${fn}(a) named its argument ${arg.name}`);
  }
  assert.equal(projectExpr("n.toFixed(2)").nodes[0]!.rows[1]!.name, "Decimals");
  assert.equal(projectExpr("list.join(', ')").nodes[0]!.rows[1]!.name, "Between");
  assert.equal(projectExpr("s.charAt(3)").nodes[0]!.rows[1]!.name, "Position");
  assert.deepEqual(projectExpr("rows.with(0, v)").nodes[0]!.rows.map((r) => r.name),
    ["Of", "Position", "Value"]);
  assert.deepEqual(projectExpr("d.toLocaleDateString('en', o)").nodes[0]!.rows.map((r) => r.name),
    ["Of", "Locale", "Options"]);
  // And a function nobody has named is a set of POSITIONS, spelled the way every other
  // position on this surface is spelled.
  assert.deepEqual(projectExpr("mystery(a, b)").nodes[0]!.rows.map((r) => r.name), ["0", "1"]);
});

test("a template hole is named for the text that introduces it", () => {
  // The OUTER template of a nest is the one pushed last: children are built first.
  const outer = (src: string) => projectExpr(src).nodes.filter((n) => n.kind === "template").at(-1)!;
  const names = (src: string) => outer(src).rows.map((r) => r.name);
  assert.deepEqual(names("`total ${a + b} done`"), ["Total"]);
  assert.deepEqual(names("`Ordered: ${n}`"), ["Ordered"]);
  assert.deepEqual(names("`${cart.items.length} items`"), ["Items"],
    "nothing leads in, so the hole takes the word it feeds");
  assert.deepEqual(names("`${first} ${last}`"), ["Part 0", "Part 1"],
    "one space says nothing about either hole, and a position is then all there is");
  assert.deepEqual(names("`line\\n${x}`"), ["Part 0"],
    "`line\\n` is not a word, and half of it is not a label");
  assert.deepEqual(names("`a ${`b ${c}`} d`"), ["Part 0"], "a nest names its own holes");
});

// ── 10. a wired row names WHICH value arrives ────────────────────────────────────────

test("two rows fed by two nodes of one kind are told apart", () => {
  // The operands are five atoms each here, because a smaller pair would ride in the rows as
  // text and there would be no label to collide. What the law is about is unchanged.
  const add = projectExpr("merge(a + b + c + d + e, f + g + h + i + j)").nodes
    .find((n) => n.rows.every((r) => r.wired))!;
  assert.deepEqual(add.rows.map((r) => r.fromTitle),
    ["Add a + b + c + d + e", "Add f + g + h + i + j"],
    "`Add` twice is a drawing that cannot say which value lands where");
  const trims = projectExpr("merge(a.replace(b, c).trim(), d.replace(e, f).trim())").nodes
    .find((n) => n.title === "Merge")!;
  assert.deepEqual(trims.rows.map((r) => r.fromTitle),
    ["Trim a.replace(b, c).trim()", "Trim d.replace(e, f).trim()"]);
});

test("a title that does not collide is left alone", () => {
  const flow = projectExpr("merge(a.replace(b, c).trim(), d.replace(e, f).toUpperCase())");
  const add = flow.nodes.find((n) => n.title === "Merge")!;
  assert.deepEqual(add.rows.map((r) => r.fromTitle), ["Trim", "Upper Case"],
    "a tail on every reference would be noise on the rows that were never ambiguous");
});

test("the tail is a subtitle when a subtitle separates them", () => {
  const items = (n: number) => "[" + Array.from({ length: n }, (_, i) => String(i)).join(", ") + "]";
  const call = projectExpr(`merge(${items(30)}, ${items(40)})`).nodes
    .find((n) => n.title === "Merge")!;
  assert.deepEqual(call.rows.map((r) => r.fromTitle), ["List 30 items", "List 40 items"],
    "the subtitle already separates them, and it is shorter than either list");
  const parses = projectExpr("merge(lib.parse(a, b, c, d), other.parse(e, f, g, h))").nodes
    .find((n) => n.title === "Merge")!;
  assert.deepEqual(parses.rows.map((r) => r.fromTitle), ["Parse lib.parse", "Parse other.parse"]);
});

test("no node has two incoming rows it cannot tell apart", () => {
  for (const { src, flow } of flows.concat(
    ["(a + b) + (c + d)", "f(x) + f(y)", "a.trim() + b.trim()",
     "g(h(1), h(2))", "[q(1), q(2), q(3)]"].map((s) => ({ src: s, flow: projectExpr(s) })))) {
    const idx = byId(flow);
    for (const n of flow.nodes) {
      const seen = new Map<string, string>();
      for (const r of n.rows) {
        if (!r.wired || !r.from || !r.fromTitle) continue;
        const spelling = idx.get(r.from)!.text;
        const held = seen.get(r.fromTitle);
        // One label may serve two rows ONLY when the same spelling feeds both: either card
        // hands over the same value, so the label is not lying about which one arrived.
        if (held !== undefined) {
          assert.equal(held, spelling,
            `${src}: two rows of ${n.title} both read "${r.fromTitle}" for different values`);
        }
        seen.set(r.fromTitle, spelling);
      }
    }
  }
});

// ── 11. the value with no ink of its own ─────────────────────────────────────────────

test("an empty text literal is a value, and the row says which value", () => {
  const record = projectExpr("{ note: '', tag: ' ', pad: '   ', name: 'x' }").nodes
    .find((n) => n.kind === "object")!;
  assert.deepEqual(record.rows.map((r) => r.blank),
    ["empty text", "1 space", "3 spaces", undefined]);
  assert.deepEqual(record.rows.map((r) => [r.mode, r.value]),
    [["text", ""], ["text", " "], ["text", "   "], ["text", "x"]],
    "the model still holds exactly what the author typed");
  const join = projectExpr("list.join('')").nodes.find((n) => n.title === "Join")!;
  assert.equal(join.rows[1]!.name, "Between");
  assert.equal(join.rows[1]!.blank, "empty text",
    "`join('')` joins with nothing between, which is not the same as a slot nobody filled");
});

test("a row that draws ink names no blank word", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      for (const r of n.rows) {
        if (r.blank === undefined) continue;
        assert.equal(r.wired, false, `${src}: a wired row cannot be blank`);
        assert.equal(r.value.trim(), "", `${src}: ${r.name} draws ink and still claims to be blank`);
      }
    }
  }
  const flow = projectExpr("a + 1 + 'x' + true + ''");
  const blanks = flow.nodes.flatMap((n) => n.rows).filter((r) => r.blank !== undefined);
  assert.equal(blanks.length, 1, "exactly the one row that has nothing to draw");
});

test("naming the blank changes nothing a splice can see", () => {
  const src = "{ note: '' }";
  const row = projectExpr(src).nodes.find((n) => n.kind === "object")!.rows[0]!;
  assert.equal(applyExprEdit(src, { op: "literal", span: row.span, value: row.value, mode: row.mode }),
    src, "handing a row its own value back must not touch the file");
  assert.equal(applyExprEdit(src, { op: "literal", span: row.span, value: "hi", mode: "text" }),
    "{ note: 'hi' }");
});

test("the well is measured for the word it draws, not for the value it hides", () => {
  const wide = projectExpr("{ note: '' }").nodes.find((n) => n.kind === "object")!;
  const narrow = projectExpr("{ note: 'a' }").nodes.find((n) => n.kind === "object")!;
  assert.ok(wide.w >= narrow.w,
    "a card sized for two apostrophes cannot hold the words `empty text`");
});

// ── 12. the characters the fonts carry ───────────────────────────────────────────────
//  A `Build Text` subtitle drew U+25AB WHITE SMALL SQUARE for each hole, and InterVariable
//  - the sheet's first font, and the face this text is set in - has no such glyph, so the
//  browser drew its own .notdef box: a card measured as `[tofu] items` at 13px. The cmap of
//  ClosedSource/Website/public/fonts/InterVariable.woff2 carries 2852 codepoints; U+25AB is
//  not one of them, U+2026 (the truncation ellipsis) is. So the vocabulary the projection
//  SPELLS ITSELF IN is ASCII plus that one ellipsis, and this is the gate.

test("the projection spells itself in characters the sheet's fonts carry", () => {
  const SAFE = /^[\x20-\x7E…]*$/;
  const extra = ["`${n} items`", "`a ${b} c`", "`${x}`",
    Array.from({ length: 40 }, (_, i) => `p${i}.n * 2`).join(" + "),
    "[" + Array.from({ length: 30 }, (_, i) => String(i)).join(", ") + "]"];
  for (const src of [...FORMS, ...extra]) {
    assert.ok(/^[\x20-\x7E]*$/.test(src),
      `${src}: a corpus form outside ASCII cannot gate the projection's own marks`);
    for (const n of projectExpr(src).nodes) {
      const words = [n.title, n.subtitle, n.chip ?? "", n.frame?.lead ?? "", n.frame?.item ?? "",
        n.frame?.carry ?? "", ...(n.params ?? []).map((p) => p.role),
        ...n.rows.flatMap((r) => [r.name, r.blank ?? "", r.fromTitle ?? ""])];
      for (const w of words) {
        assert.ok(SAFE.test(w),
          `${src}: ${JSON.stringify(w)} holds a character the font stack may not carry`);
      }
    }
  }
});

test("a template hole is drawn with the mark the author wrote", () => {
  const shape = (src: string) =>
    projectExpr(src).nodes.filter((n) => n.kind === "template").at(-1)!.subtitle;
  assert.equal(shape("`total ${a + b} done`"), "total {} done");
  assert.equal(shape("`${x}${y}`"), "{}{}");
  assert.equal(shape("`plain`"), "plain");
  assert.equal(shape("`a ${`b ${c}`} d`"), "a {} d");
});

// ── 13. the container's geometry: one box per level, a plate its own size ────────────
//  Three findings a pixel audit measured on the rendered canvas, each now a law here.
//  A HIGHER-ORDER CALL WAS TWO BOXES: a card holding a dashed region holding the body, so
//  `matrix` reached one `Subtract` through seven nested outlines and each level's wash
//  composited over the last (ground 16,16,18 -> 41,17,31 four levels down, so the deepest
//  and most local region was the loudest thing on the drawing). THE NAMEPLATE tracked the
//  CARD, and a container's card is as wide as its BODY, so `Keep Where` painted a 597px
//  band whose content ended 160px in. THE PILL had a 56px floor and a proportional measure
//  for a name set in mono, so a one-character parameter drew 55px of capsule.

/** The card box a reader crosses to reach `inner`, counted the way an eye counts them: one
 *  per enclosing card, plus one more for any region drawn as a box of its own. */
function outlinesAround(flow: ExprFlow, inner: ExprNode): number {
  let boxes = 1;
  for (const h of flow.nodes) {
    if (h.id === inner.id) continue;
    const holds = inner.x >= h.x && inner.y >= h.y
      && inner.x + inner.w <= h.x + h.w && inner.y + inner.h <= h.y + h.h;
    if (!holds) continue;
    boxes += 1;
    const merged = h.frame !== undefined
      && h.frame.x === h.x && h.frame.w === h.w && h.frame.y + h.frame.h === h.y + h.h;
    if (h.frame !== undefined && !merged) boxes += 1;
  }
  return boxes;
}

const MATRIX = "regions.map(r => ({ region: r.name, revenue: r.stores"
  + ".filter(s => s.open).map(s => s.orders.reduce((t, o) => t + o.total * (1 - o.discount), 0))"
  + ".reduce((t, n) => t + n, 0) }))";

test("a container is ONE box: its region is the card's own lower half", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (!n.frame) continue;
      assert.equal(n.frame.x, n.x,
        `${src}: ${n.title}'s region is inset from its own left wall - that is a second box`);
      assert.equal(n.frame.w, n.w,
        `${src}: ${n.title}'s region is narrower than its card - that is a second box`);
      assert.equal(n.frame.y + n.frame.h, n.y + n.h,
        `${src}: ${n.title}'s region stops short of its card's floor - that is a second box`);
      assert.ok(n.frame.y > n.y,
        `${src}: ${n.title}'s region must start below its head and rows`);
    }
  }
});

test("four levels of nesting are four boxes, not seven", () => {
  const flow = projectExpr(MATRIX);
  const leaf = flow.nodes.find((n) => n.title === "Subtract")!;
  assert.ok(leaf, "the fixture's innermost operation must be drawn");
  const frames = flow.nodes.filter((n) => n.frame).length;
  assert.equal(frames, 4, "the fixture opens four containers");
  assert.equal(outlinesAround(flow, leaf), 4,
    "one outline per enclosing container plus the leaf's own card - it was 7");
});

test("the nameplate is measured from the head and the rows, never from the body", () => {
  // `rowW` is the width the markup gives the head, the row list AND the opaque plate behind
  // them. The card is the BODY's width; if the plate followed that, it paints a band.
  const flow = projectExpr("products.filter(p => p.price >= min && p.inStock).sortBy(p => p.price)");
  const keep = flow.nodes.find((n) => n.title === "Keep Where")!;
  assert.ok(keep.frame, "the fixture's filter opens a container");
  assert.ok(keep.w > 400, `the container is body-wide (${keep.w}px)`);
  assert.ok(keep.rowW * 2 < keep.w,
    `the plate tracks its own content (${keep.rowW}px) and not the card (${keep.w}px)`);
  for (const { src, flow: f } of flows) {
    for (const n of f.nodes) {
      assert.ok(n.rowW <= n.w, `${src}: ${n.title}'s plate is wider than its card`);
    }
  }
});

test("a parameter pill is sized to its name, with a tap target as the floor", () => {
  const pillsOf = (src: string) =>
    projectExpr(src).nodes.filter((n) => n.params).flatMap((n) => n.params!);

  const [p] = pillsOf("rows.map(p => ({ a: p.a, b: p.b, c: p.c }))");
  assert.equal(p!.name, "p");
  assert.equal(p!.w, 24, "a one-character name gets a 24x24 target, not a 56px word slot");
  assert.equal(p!.h, 24);

  const [total, line] = pillsOf("lines.reduce((total, line) => ({ n: total.n + line.n }), 0)");
  assert.ok(total!.w > line!.w, "`total` is five characters and `line` is four");
  assert.ok(total!.w < 56, `a five-character pill is under the old floor, measured ${total!.w}`);
  assert.equal(total!.outX, line!.outX,
    "two pills of different widths still hand their wires off from one column");

  // THE PILL IS A WIRE SOURCE, so the socket has to walk in with the wall it sits on.
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      for (const pill of n.params ?? []) {
        assert.equal(pill.outX, pill.x + pill.w, `${src}: ${pill.name}'s socket left the wall`);
        assert.equal(pill.outX, n.params![0]!.outX,
          `${src}: ${pill.name}'s socket is off the rail's leading edge`);
        assert.equal(pill.outY, pill.y + pill.h / 2, `${src}: ${pill.name}'s socket is off-centre`);
        assert.ok(pill.w >= 24, `${src}: ${pill.name} is under the tap target at ${pill.w}px`);
        // The measure is the MONO face the sheet sets the name in. 7px per character is a
        // ceiling over 11px mono (6.622), so a name that fits cannot fail this and a floor
        // sized for a word nobody wrote cannot pass it.
        assert.ok(pill.w <= Math.max(24, pill.name.length * 7 + 16),
          `${src}: ${pill.name} is ${pill.w}px, wider than its own text needs`);
      }
    }
  }
});

test("the binding edge is drawn louder than the value edges around it", () => {
  // The pill's outgoing wire is what makes a loop comprehensible, and it was the quietest
  // line on the canvas: the same neutral at the same hairline weight as every value edge.
  const dsx = readFileSync(new URL(
    "../../../../../ClosedSource/DSX/Modules/Custom/Editor/Components/EditorExpression.dsx",
    import.meta.url), "utf-8");
  const at = dsx.indexOf('as="exprWires"');
  assert.ok(at > 0, "the wire projection must still be named exprWires");
  const wires = dsx.slice(at, dsx.indexOf("</variable>", at));
  // The fork may be read off `edge.kind` (the model says which of value, binding and carry an
  // edge is) or off `edge.param` (the older spelling, which could only ask "is it a pill?").
  // What is held here is the OUTCOME either way: the binding is the louder line.
  const slice = (key: string): string => {
    const from = wires.indexOf(key + ":");
    assert.ok(from > 0, `the wire projection must still set ${key}`);
    const to = wires.indexOf("\n", wires.indexOf(",", from));
    return wires.slice(from, to < 0 ? wires.length : to);
  };
  const inks = [...slice("ink").matchAll(/\?\s*'(\w+)'\s*:\s*'(\w+)'/g)];
  assert.ok(inks.length > 0, "the wire's ink must fork on what the edge carries");
  for (const [, value, param] of inks) {
    assert.notEqual(param, value, "the binding edge cannot share the value edges' ink");
    assert.notEqual(param, "accent", "the accent means selection and focus, product-wide");
    assert.equal(param, "label", "the brightest neutral the canvas ink vocabulary carries");
  }
  const weights = [...slice("weight").matchAll(/\?\s*([\d.]+)\s*:\s*([\d.]+)/g)];
  assert.ok(weights.length > 0, "the wire's weight must fork the same way");
  for (const [, value, param] of weights) {
    assert.ok(Number(param) > Number(value),
      "the binding edge carries more weight than a value edge, not less");
  }
});

// ── 14. the drawing has to cost less than the text ───────────────────────────────────
//  Measured over the 6294 expressions this repo's own `.dsx` files contain, the drawing spent
//  4.11 visual objects per atom - an object being a card, a row, a socket, a wire or a frame,
//  an atom being an identifier path, a literal or an operator. Sixty-one per cent of that
//  workload is a SINGLE ATOM and the median drawing spent seven objects saying it; 2.3% hold
//  a higher-order call and the frame machinery was paid unconditionally; 92% have a maximum
//  fan-in of one, so what was drawn as a graph is a path. Five rules answer that, and this
//  section is those rules as laws.

/** The brief's own unit: card + row + socket + wire + frame. Sockets are one per row, one per
 *  card output, one per pill and one per frame result, which is what the surface inks. */
function objects(flow: ExprFlow): number {
  let rows = 0, pills = 0, frames = 0, results = 0;
  for (const n of flow.nodes) {
    rows += n.rows.length;
    pills += n.params?.length ?? 0;
    if (n.frame) frames++;
    if (n.resultX !== undefined) results++;
  }
  const ports = rows + flow.nodes.length + pills + results;
  return flow.nodes.length + rows + ports + flow.edges.length + frames;
}

/** An atom: an identifier PATH (one thing to resolve, however many dots), a literal, or a
 *  real operator. The same judgement the fold threshold is calibrated against. */
function atomsIn(src: string): number {
  const walk = (e: ReturnType<typeof parseExpression>["root"]): number => {
    switch (e.kind) {
      case "group": return walk(e.inner);
      case "number": case "string": case "boolean": case "null": case "regex": case "ref":
        return 1;
      case "member": return dotted(e) ? 1 : 1 + walk(e.receiver);
      default: {
        let n = 1;
        for (const c of childrenOf(e)) n += walk(c);
        return n;
      }
    }
  };
  const dotted = (e: ReturnType<typeof parseExpression>["root"]): boolean =>
    e.kind === "ref" ? true : e.kind === "member" ? dotted(e.receiver) : false;
  return walk(parseExpression(src, { start: 0, end: src.length }).root);
}

test("THE CENSUS: what the workload costs to look at", () => {
  // A HARDCODED CENSUS, in the sense the repo uses the term: not a target anybody chose, what
  // the projection currently does over the shapes people actually write, written down so the
  // next change has to say what it did to the number. It was 4.11 before this pass and it is
  // 2.09 on this list. A number that falls is the point; a number that RISES with no named
  // cause is the regression this exists to catch, and re-recording it without naming the
  // landed change that moved it is the one move this comment exists to make embarrassing.
  let obj = 0, at = 0;
  for (const src of WORKLOAD) { obj += objects(projectExpr(src)); at += atomsIn(src); }
  const ratio = obj / at;
  assert.ok(ratio <= 2.15, `the workload costs ${ratio.toFixed(3)} objects per atom`);
  assert.ok(ratio >= 1.2, `${ratio.toFixed(3)} is below the floor - has an object stopped `
    + "being counted, or has the drawing started hiding things?");

  // And no single drawing may be extravagant about a small expression.
  for (const src of WORKLOAD) {
    const n = atomsIn(src);
    if (n > 3) continue;
    assert.ok(objects(projectExpr(src)) <= 3 * n + 2,
      `${src}: ${objects(projectExpr(src))} objects for ${n} atoms`);
  }
});

test("rule 1: a leaf is one chip, one producer carries its own terminus", () => {
  for (const src of ["total", "42", "'text'", "dsx.attribute.icon", "null"]) {
    const flow = projectExpr(src);
    assert.equal(flow.nodes.length, 1, `${src}: a leaf is ONE chip`);
    assert.equal(flow.edges.length, 0, `${src}: no graph, no wire`);
    assert.equal(flow.nodes[0]!.terminus, true);
    assert.equal(flow.nodes[0]!.rows.length, 0);
  }
  // One producer: the card is the terminus. Two: the Result comes back.
  assert.equal(projectExpr("a + 1").nodes.filter((n) => n.kind === "output").length, 0);
  assert.equal(projectExpr("f(a, b, c, d) + g(e, h, i, j)").nodes
    .filter((n) => n.kind === "output").length, 1);
});

test("rule 3: a small subtree is TEXT in its consumer's row, and never a truncated one", () => {
  const row = (src: string, name: string) =>
    projectExpr(src).nodes.flatMap((n) => n.rows).find((r) => r.name === name)!;
  assert.equal(row("a + b * c", "1").inline, "b * c");
  assert.equal(row("total + tax(order)", "1").inline, "tax(order)");
  assert.equal(row("(a + b) * c", "0").inline, "(a + b)");

  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      for (const r of n.rows) {
        if (r.inline === undefined) continue;
        // WHOLE, OR NOT AT ALL. A fold that ellipsed its own text would be a fold a reader
        // has to open before they can trust it, and then it has cost a gesture, not saved one.
        assert.equal(r.inline, r.text, `${src}: ${n.title}/${r.name} folded a shortened text`);
        assert.ok(r.inline.length <= 32, `${src}: a ${r.inline.length}-character fold`);
        assert.equal(r.expandable, true, `${src}: every fold opens in one gesture`);
        assert.equal(r.wired, false);
        assert.equal(r.value, "");
        assert.equal(r.text, src.slice(r.span.start, r.span.end), "and it owns its own bytes");
      }
    }
  }
});

test("rule 3: a fold never swallows a lambda, and never swallows a bound item", () => {
  // A lambda's parameter is a BINDING, and the pill, the wire out of it and the unread-pill
  // signal are the whole of what makes a loop comprehensible. `total + item.price * item.qty`
  // would fold its product into eleven characters and the `item` pill would go dark.
  const fold = projectExpr("rows.reduce((total, item) => total + item.price * item.qty, 0)");
  const reduce = fold.nodes.find((n) => n.species === "higher")!;
  assert.deepEqual(reduce.params?.map((p) => p.used), [true, true],
    "both pills are still read by the drawing, not by a string");
  assert.ok(fold.nodes.some((n) => n.title === "Multiply"), "the product keeps its box");

  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      for (const r of n.rows) {
        if (r.inline === undefined) continue;
        assert.ok(!/=>/.test(r.inline), `${src}: a lambda was folded into a well`);
      }
    }
  }
});

test("rule 4: the first carrying operand is an abutment - no row, no socket, no wire", () => {
  // Five atoms on the left, because `text.trim()` is two and would ride in the row as text -
  // which is rule 3 doing the same job one step earlier.
  const flow = projectExpr("text.replace(a, b).trim().toLowerCase()");
  const upper = flow.nodes.find((n) => n.title === "Lower Case")!;
  const trim = flow.nodes.find((n) => n.title === "Trim")!;
  assert.equal(upper.rows.length, 0, "the receiver costs no row");
  assert.deepEqual(trim.abuts, { to: upper.id, slot: "Of" });
  assert.equal(trim.x + trim.w, upper.x, "the seam IS the edge");
  assert.equal(flow.edges.length, 0, "and there is no wire to draw");

  for (const { src, flow: f } of flows) {
    const byId = new Map(f.nodes.map((n) => [n.id, n] as const));
    for (const n of f.nodes) {
      if (!n.abuts) continue;
      const to = byId.get(n.abuts.to)!;
      assert.ok(to, `${src}: an abutment names a card that is not drawn`);
      assert.equal(n.x + n.w, to.x, `${src}: ${n.title} does not touch ${to.title}`);
      assert.equal(f.edges.some((e) => e.from === n.id && e.to === to.id), false,
        `${src}: ${n.title} abuts AND wires - one of the two is a lie`);
      // The out-lines coincide, which is what makes a seam read as a spine and not a step.
      const line = (x: typeof to) => x.y + (x.rows.length ? 28 + 12 : x.h / 2);
      if (!to.frame && !n.frame) {
        assert.equal(line(n), line(to), `${src}: ${n.title}'s seam is a step`);
      }
    }
  }
});

test("rule 4: a named role is never traded for a seam", () => {
  // `Minimum`, `By`, `Then` and an object's key are the information. Only a slot that CARRIES
  // - a receiver, a sole argument, the head of a ladder - may become an adjacency.
  const roles = (src: string, title: string) =>
    projectExpr(src).nodes.find((n) => n.title === title)!.rows.map((r) => r.name);
  assert.deepEqual(roles("f(a, b, c, d) >= min", "Is At Least"), ["Value", "Minimum"]);
  assert.deepEqual(roles("f(a, b, c, d) - by", "Subtract"), ["From", "By"]);
  assert.deepEqual(roles("f(a, b, c, d) ? x : y", "Choose"), ["If", "Then", "Else"]);
  assert.deepEqual(roles("{ k: f(a, b, c, d) }", "Record"), ["k"]);
  assert.deepEqual(roles("merge(f(a, b, c, d), g(e))", "Merge"), ["0", "1"],
    "two arguments, and dropping the first would number the second from one for no reason");

  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (!n.abuts) continue;
      assert.ok(["", "Of", "In", "Items", "Value", "0"].includes(n.abuts.slot),
        `${src}: ${n.title} traded away the slot named ${n.abuts.slot}`);
    }
  }
});

test("rule 4: a card with a parameter row keeps its wire", () => {
  // A binding approaches through the channel an abutting producer would be sitting in, so the
  // two are mutually exclusive by construction rather than by a repair afterwards.
  for (const { src, flow } of flows) {
    const byId = new Map(flow.nodes.map((n) => [n.id, n] as const));
    for (const n of flow.nodes) {
      if (!n.abuts) continue;
      const to = byId.get(n.abuts.to)!;
      assert.ok(!to.rows.some((r) => r.param !== undefined),
        `${src}: ${to.title} takes a binding and an abutment at the same wall`);
    }
  }
});

test("rule 5: a binding never runs at a row's height through another card", () => {
  // THE DEFECT: on `products.filter(p => p.price >= min && p.inStock)` the wire from the `p`
  // pill to the `And` card's second port ran BEHIND the opaque `Is At Least` card, and its
  // visible left fragment terminated exactly on that card's HOLLOW `Minimum` port. Both
  // readings a viewer can form there are false, and the second breaks the canvas's own rule
  // that an unfilled socket means nothing arrives.
  const fixtures = [
    "products.filter(p => p.price >= min && p.inStock).sortBy(p => p.price)",
    "rows.map(r => ({ id: r.id, total: r.price * r.qty }))",
    "order.lines.reduce((total, line) => total + line.price * line.qty, 0).toFixed(2)",
    "teams.map(t => ({ name: t.name, open: t.tickets.filter(i => i.state == 'open').length }))",
  ];
  let routed = 0;
  for (const { src, flow } of flows.concat(fixtures.map((s) => ({ src: s, flow: projectExpr(s) })))) {
    for (const e of flow.edges) {
      if (e.kind !== "binding") continue;
      if (e.points.length > 4) routed++;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!, b = e.points[i]!;
        if (Math.abs(a[1] - b[1]) > 0.5) continue;          // only the horizontal runs
        const [x0, x1] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
        for (const c of flow.nodes) {
          if (c.frame || c.id === e.to) continue;
          const inside = a[1] > c.y + 0.5 && a[1] < c.y + c.h - 0.5
            && x0 < c.x + c.w - 0.5 && x1 > c.x + 0.5;
          assert.ok(!inside,
            `${src}: a binding crosses ${c.title} at y=${a[1]} and re-emerges on its far side`);
        }
      }
    }
  }
  assert.ok(routed > 0, "the floor lane must actually be used by these fixtures");
});

test("rule 5: a binding that takes the floor stays inside its own frame", () => {
  for (const { src, flow } of flows) {
    const byId = new Map(flow.nodes.map((n) => [n.id, n] as const));
    for (const e of flow.edges) {
      if (e.kind !== "binding") continue;
      const owner = byId.get(e.from)!;
      const f = owner.frame!;
      for (const [x, y] of e.points) {
        assert.ok(x >= f.x - 1 && x <= f.x + f.w + 1 && y >= f.y - 1 && y <= f.y + f.h + 1,
          `${src}: a binding leaves ${owner.title}'s region at ${x},${y}`);
      }
    }
  }
});

test("rule 5: a template says its own order, not just its holes", () => {
  // `${n} items` and `items ${n}` both drew a `Build Text` head over one row called `Items`.
  // Two different strings, one drawing - because the row NAME was the only thing carrying the
  // surrounding text, and a name has no position.
  const segs = (src: string) =>
    projectExpr(src).nodes.filter((n) => n.kind === "template").at(-1)!.segments!;
  assert.deepEqual(segs("`${n} items`"), [{ hole: 0 }, { text: " items" }]);
  assert.deepEqual(segs("`items ${n}`"), [{ text: "items " }, { hole: 0 }]);
  assert.notDeepEqual(segs("`${n} items`"), segs("`items ${n}`"),
    "the two must not draw identically - that was the bug");
  assert.deepEqual(segs("`${x}${y}`"), [{ hole: 0 }, { hole: 1 }]);
  assert.deepEqual(segs("`plain`"), [{ text: "plain" }]);
  assert.deepEqual(segs("`total ${a + b} done`"), [{ text: "total " }, { hole: 0 }, { text: " done" }]);

  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (n.kind !== "template") continue;
      assert.ok(n.segments, `${src}: a template with no ordering`);
      const holes = n.segments!.filter((s) => s.hole !== undefined);
      assert.equal(holes.length, n.rows.length, `${src}: a hole with no row, or the reverse`);
      holes.forEach((s, i) => assert.equal(s.hole, i, `${src}: holes out of order`));
    }
  }
});

test("rule 6: edges that share a corridor get one lane each", () => {
  const src = "merge(f(a, b, c, d), g(e, h, i, j), k(l, m, n, o), p(q, r, s, t), u(v, w, x, y))";
  const flow = projectExpr(src);
  const into = flow.edges.filter((e) => e.to === flow.nodes.find((n) => n.title === "Merge")!.id);
  assert.ok(into.length >= 4, `only ${into.length} edges in the fan`);
  const legs = into.map((e) => e.points.length === 6 ? e.points[2]![0] : null)
    .filter((x): x is number => x !== null);
  assert.equal(new Set(legs).size, legs.length,
    "six edges on one x is one 2px stroke, and a fan of six then looks like a wire of one");
  // The ribbon's WIDTH is the arity, which is the thing the text hides behind precedence.
  assert.ok(Math.max(...legs) - Math.min(...legs) >= 8 * (legs.length - 1) - 1);
  assert.deepEqual([...into].sort((a, b) => a.row - b.row).map((e) => e.lane),
    into.sort((a, b) => a.row - b.row).map((e) => e.lane), "lanes follow the rows");

  for (const { src: s, flow: f } of flows) {
    for (const e of f.edges) assert.equal(typeof e.lane, "number", `${s}: an edge with no lane`);
  }
});

test("rule 7: a subexpression read twice is ONE card with two out-edges", () => {
  // It fires on five of 6294 real expressions. It is implemented anyway, because it is the
  // only thing a diagram expresses that text structurally cannot: the text must spell the
  // subexpression twice and hope the reader notices they are the same value.
  const flow = projectExpr("merge(f(a, b, c, d), f(a, b, c, d))");
  const cards = flow.nodes.filter((n) => n.title === "F");
  assert.equal(cards.length, 1, "one card, not two");
  const out = flow.edges.filter((e) => e.from === cards[0]!.id);
  assert.equal(out.length, 2, "and two edges leaving it");
  assert.deepEqual(out.map((e) => e.row).sort(), [0, 1]);
  // Every consuming row still owns ITS OWN bytes, so no edit is lost to the sharing.
  const merge = flow.nodes.find((n) => n.title === "Merge")!;
  const src = "merge(f(a, b, c, d), f(a, b, c, d))";
  for (const r of merge.rows) assert.equal(r.text, src.slice(r.span.start, r.span.end));
  assert.notEqual(merge.rows[0]!.span.start, merge.rows[1]!.span.start);
  assert.equal(applyExprEdit(src, { op: "replace", span: merge.rows[1]!.span, text: "9" }),
    "merge(f(a, b, c, d), 9)");

  // NOT across a shadowing boundary: an inner `x` and an outer `x` make `f(x, 1, 2, 3)` two
  // different reads, and one card between them would draw one value where there are two.
  const shadow = projectExpr("outer.map(x => inner.map(x => merge(f(x, 1, 2, 3), g(x))))");
  assert.equal(shadow.exact, true);
});

test("a frame's result socket sits on the body's own line", () => {
  // It used to be set to the body card's NODE-LOCAL out offset - a number in the body's
  // coordinates, not the frame's - so on any container with rows of its own the socket landed
  // above the region entirely (a `Map Over` with one `Items` row put its result at y=68
  // against a region starting at y=88) and the wire ran up to a point on no wall.
  for (const { src, flow } of flows) {
    const byId = byId2(flow);
    for (const n of flow.nodes) {
      if (!n.resultFrom || n.resultY === undefined) continue;
      const body = byId.get(n.resultFrom)!;
      assert.equal(n.resultY, body.outY, `${src}: ${n.title}'s result socket is off its body`);
      assert.ok(n.resultY > n.frame!.y && n.resultY < n.frame!.y + n.frame!.h,
        `${src}: ${n.title}'s result socket is outside its own region`);
    }
  }
});
function byId2(flow: ExprFlow): Map<string, ExprNode> {
  return new Map(flow.nodes.map((n) => [n.id, n] as const));
}

test("the contract the surface reads is present and consistent", () => {
  for (const { src, flow } of flows) {
    for (const n of flow.nodes) {
      if (n.echo !== undefined) assert.ok(n.echo.length > 0, `${src}: an empty echo`);
      if (n.ordinal !== undefined) {
        assert.ok(Number.isInteger(n.ordinal) && n.ordinal >= 0, src);
        assert.equal(flow.edges.some((e) => e.to === n.id && e.row >= 0), false,
          `${src}: ${n.title} is numbered as an entry and something feeds it`);
      }
      if (n.crumbs !== undefined) {
        assert.ok(n.depth > 0, `${src}: a breadcrumb at depth 0`);
        assert.equal(n.crumbs.length, n.depth, `${src}: ${n.title} has ${n.crumbs.length} `
          + `crumbs at depth ${n.depth}`);
      }
    }
    const ordinals = flow.nodes.filter((n) => n.ordinal !== undefined)
      .sort((a, b) => a.ordinal! - b.ordinal!);
    ordinals.forEach((n, i) => assert.equal(n.ordinal, i, `${src}: ordinals skip`));
    for (let i = 1; i < ordinals.length; i++) {
      assert.ok(ordinals[i]!.span.start >= ordinals[i - 1]!.span.start,
        `${src}: entry cards are not in source order`);
    }
    for (const e of flow.edges) {
      assert.ok(e.kind === "value" || e.kind === "binding" || e.kind === "carry", src);
      assert.equal(e.kind === "binding", e.param !== undefined, src);
      assert.equal(e.kind === "carry", e.carry === true, src);
    }
  }
});

test("the new plane spells itself in characters the sheet's fonts carry", () => {
  const SAFE = /^[\x20-\x7E…]*$/;
  for (const src of FORMS) {
    for (const n of projectExpr(src).nodes) {
      const words = [n.echo ?? "", ...(n.crumbs ?? []), ...(n.abuts ? [n.abuts.slot] : []),
        ...(n.segments ?? []).map((s) => s.text ?? ""),
        ...n.rows.map((r) => r.inline ?? "")];
      for (const w of words) {
        assert.ok(SAFE.test(w), `${src}: ${JSON.stringify(w)} holds a character the font `
          + "stack may not carry");
      }
    }
  }
});
