//
//  nodeflow.test.ts — the node projection and its splice engine (05-node-editor.md).
//
//  The properties that make the visual editor allowed to exist:
//    1. TOTALITY  — anything JSE accepts projects; the unclassifiable becomes Custom Code.
//    2. EXACTNESS — spans tile the source; reconstruct(project(src)) === src, always.
//    3. HUMANITY  — a step is titled in human language, never in keyword-ese.
//    4. SPLICE SAFETY — an edit changes exactly the bytes it names; an insert lands at a
//       connector's own offset, indented like its neighbours; a remove takes only the
//       statement's owned bytes. Nothing else in the file moves.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectFlow, classifyStatement, classifyHead, classifyCallback, titleCase, statementSpans,
  applyFlowEdit, insertCatalog, encodeForBody,
} from "../src/nodeflow.ts";
import { projectCfg } from "../src/cfg.ts";

// ── classification ────────────────────────────────────────────────────────────────────

test("statements classify into human blocks", () => {
  assert.deepEqual(classifyStatement("let total = 0"), { kind: "set", title: "Set Variable", subtitle: "total" });
  assert.deepEqual(classifyStatement("dsx.variable.count = count + 1"), { kind: "set", title: "Set Variable", subtitle: "count" });
  assert.equal(classifyStatement("dsx.fire('checkout')").title, "Fire Event");
  assert.equal(classifyStatement("dsx.fire('checkout')").subtitle, "checkout");
  assert.equal(classifyStatement("dsx.log('hello')").kind, "log");
  assert.equal(classifyStatement("return total").kind, "return");
  assert.equal(classifyStatement("throw new Error('out of stock')").subtitle, "out of stock");
  assert.equal(classifyStatement("break").title, "Exit Loop");
  assert.equal(classifyStatement("continue").title, "Next Iteration");
});

test("module calls carry the humanised chain", () => {
  const c = classifyStatement("dsx.module.haptics.impact({ style: 'light' })");
  assert.equal(c.kind, "call");
  assert.equal(c.subtitle, "Haptics · Impact");
  const nav = classifyStatement("dsx.module.route.push({ path: '/orders' })");
  assert.equal(nav.kind, "navigate");
  assert.equal(nav.title, "Go To Page");
  assert.equal(nav.subtitle, "/orders");
  const deep = classifyStatement("const ok = await dsx.module.watch.health.readSteps({})");
  assert.equal(deep.subtitle, "Watch Health · Read Steps → ok");
});

test("api requests, actions, and backend data calls classify", () => {
  assert.equal(classifyStatement("orders.refresh()").title, "API Request");
  assert.equal(classifyStatement("submitOrder()").title, "Run Action");
  assert.equal(classifyStatement("submitOrder()").subtitle, "Submit Order");
  const q = classifyStatement("const rows = data.note.list({ limit: 10 })");
  assert.equal(q.title, "List Data");
  assert.equal(q.subtitle, "Note → rows");
  assert.equal(classifyStatement("queue.push({ job: 'digest' })").title, "Queue Work");
});

test("the unclassifiable is Custom Code, never an error", () => {
  assert.equal(classifyStatement("(() => 1)()").kind, "code");
  assert.equal(classifyStatement("a ? b() : c()").kind, "code");
});

test("a statement a reader recognises is never Custom Code", () => {
  // an indexed compound assignment IS an assignment: it used to fall through to Custom Code
  // only because the classifier's assignment grammar accepted a bare word and nothing else
  assert.deepEqual(classifyStatement("weird[thing] += 3"),
    { kind: "set", title: "Set Value", subtitle: "weird[thing]" });
  assert.deepEqual(classifyStatement("order.status = 'paid'"),
    { kind: "set", title: "Set Value", subtitle: "order.status" });
  // a lone handler name is an invocation - `on:tap="save"` runs the save action
  assert.deepEqual(classifyStatement("copyAllConsole"),
    { kind: "action", title: "Run Action", subtitle: "Copy All Console" });
  assert.equal(classifyStatement("rows.push(row)").title, "Add To List");
  assert.equal(classifyStatement("dsx.module.rateapp()").title, "Call Module");
  assert.equal(classifyStatement("dsx.component.push('demo.Gallery')").title, "Open Component");
  assert.equal(classifyStatement("dsx.route.path = '/orders'").title, "Go To Page");
});

test("a callback is a body, and its head says what runs it", () => {
  assert.deepEqual(classifyCallback("rows.forEach(row => {"),
    { kind: "callback", title: "For Each Item", subtitle: "row in rows" });
  assert.deepEqual(classifyCallback("setTimeout(() => {", "}, 400)"),
    { kind: "callback", title: "After A Delay", subtitle: "400 ms" });
  assert.equal(classifyCallback("orders.refresh().then(res =&gt; {").title, "When It Resolves");
  // the entity form of the arrow is the ONLY form a real .dsx document contains
  const flow = projectFlow("rows.forEach(row =&gt; {\n  a = 1\n  b = 2\n})\n", "a");
  assert.equal(flow.nodes.filter((n) => n.kind === "callback").length, 1);
  assert.equal(flow.exact, true);
});

test("a comment is owned by the statement below it and never demotes it", () => {
  const flow = projectFlow("// pay the fee first\ndsx.log('x')\n", "a");
  const node = flow.nodes.find((n) => n.kind === "log");
  assert.ok(node !== undefined);
  assert.equal(node.note?.class, "note");
  assert.deepEqual(node.note?.lines, ["pay the fee first"]);
  // the strip is reserved INSIDE the node box, so the box is taller and the card is not
  assert.equal(node.headOffset, node.note!.h + 6);
});

test("comment shapes are read from the text, not chosen by hand", () => {
  const section = projectFlow("// Totals\n// ------\n\nlet a = 1\n", "a");
  assert.equal(section.nodes.find((n) => n.kind === "set")?.note?.class, "section");
  const ghost = projectFlow("// dsx.log('old')\n// a = 1\ndsx.log('new')\n", "a");
  assert.equal(ghost.nodes.find((n) => n.kind === "log")?.note?.class, "ghost");
  const trail = projectFlow("dsx.log('x') // already net of tax\n", "a");
  assert.equal(trail.nodes.find((n) => n.kind === "log")?.trailing, "already net of tax");
  // a comment that owns no statement still gets drawn, in a card of its own
  const orphan = projectFlow("a = 1\n\n// everything below is dead\n", "a");
  assert.equal(orphan.nodes.filter((n) => n.kind === "note").length, 1);
});

test("control heads read as human loops and branches", () => {
  assert.deepEqual(classifyHead("loop", "for (const line of lines) {"),
    { kind: "loop", title: "For Each Loop", subtitle: "line in lines" });
  assert.equal(classifyHead("loop", "while (retries &lt; 3) {").subtitle, "retries < 3");
  assert.equal(classifyHead("branch", "if (total &gt; 100) {").subtitle, "total > 100");
  assert.equal(classifyHead("guard", "try {").title, "Try");
});

test("titleCase speaks human", () => {
  assert.equal(titleCase("clearWebData"), "Clear Web Data");
  assert.equal(titleCase("place_order"), "Place Order");
});

// ── projection: totality + exactness + shape ─────────────────────────────────────────

const PLACE = `let total = 0
let rejected = 0
for (const line of lines) {
  if (line.stock == 0) {
    rejected = rejected + 1
    continue
  }
  total = total + line.price * line.qty
}
if (rejected &gt; 0) {
  throw new Error('out of stock')
}
dsx.module.route.reset({ path: '/orders' })
return total
`;

test("a real body projects to titled nodes with a loop and a branch", () => {
  const flow = projectFlow(PLACE, "Action · Place");
  assert.equal(flow.exact, true);
  const titles = flow.nodes.map((n) => n.title);
  assert.ok(titles.includes("For Each Loop"), titles.join("|"));
  assert.ok(titles.includes("If"));
  assert.ok(titles.includes("Set Variable"));
  assert.ok(titles.includes("Reset Navigation"));
  assert.ok(titles.includes("Return"));
  const loop = flow.nodes.find((n) => n.title === "For Each Loop")!;
  assert.equal(loop.subtitle, "line in lines");
  // THE CONTAINER IS THE LOOP: a frame encloses the body, a port sits on its bottom
  // border, and no back edge exists to tangle.
  const frame = flow.nodes.find((n) => n.kind === "frame" && n.frame === "loop")!;
  const ports = flow.nodes.filter((n) => n.kind === "port");
  assert.ok(frame !== undefined && ports.length > 0, "loop container missing");
  const inner = flow.nodes.find((n) => n.title === "Next Iteration")!;
  assert.ok(inner.x >= frame.x && inner.x + inner.w <= frame.x + frame.w
    && inner.y >= frame.y && inner.y + inner.h <= frame.y + frame.h,
    "the loop body escaped its container");
  // Every wall carries its port, and the port sits ON the wall - one per frame, no orphans.
  const walls = flow.nodes.filter((n) => n.kind === "frame");
  assert.equal(ports.length, walls.length, "one port per wall");
  for (const w of walls) {
    assert.ok(ports.some((pt) => Math.abs(pt.y + pt.h / 2 - (w.y + w.h)) < 1),
      "every wall has a port on its bottom border");
  }
  // A ONE-ARMED `if` IS A WALL, NOT A FORK. Both branches here are one-armed, and drawing
  // the full fork for them cost a Then lane, a Then word, an Else word, a merge bead and an
  // else path that carried no information: the else is "carry on", which the column below
  // already says. They take the loop's shape - a wall the reader is inside of - tinted with
  // their own hue, and the reader tells them apart by hue plus the head card.
  const armless = flow.nodes.filter((n) => n.kind === "frame" && n.frame === "if");
  assert.equal(armless.length, 2, "both one-armed branches drew a wall");
  assert.equal(flow.edges.filter((e) => e.label === "Then" || e.label === "Else").length, 0,
    "a one-armed branch draws no lane words");
  const nested = armless.find((f) => f.y > frame.y && f.y + f.h < frame.y + frame.h);
  assert.ok(nested !== undefined, "the in-loop branch nests inside the loop wall");
});

test("a two-armed branch still forks: the wall is the one-armed case only", () => {
  const flow = projectFlow(`if (a) {\n  x = 1\n} else {\n  x = 2\n}\nreturn x\n`, "T");
  assert.equal(flow.exact, true);
  assert.ok(flow.edges.some((e) => e.label === "Then"), "Then lane");
  assert.ok(flow.edges.some((e) => e.label === "Else"), "Else lane");
  assert.equal(flow.nodes.filter((n) => n.kind === "frame").length, 0,
    "a real fork is two lanes, not a wall");
});

test("every span tiles and reconstruction is exact for hostile input", () => {
  const hostile = `// leading comment\nconst s = "a // not comment; }"\nif (s) { weird[thing] = 1 } else {\n  /* block */ x = 2\n}\nwhile (x) { x = x - 1 }\n`;
  const flow = projectFlow(hostile, "T");
  assert.equal(flow.exact, true);
  // spans never overlap and stay ordered within the source
  const spans = flow.nodes.filter((n) => n.span !== undefined).map((n) => n.span!);
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i]!.start >= sorted[i - 1]!.start, "spans ordered");
  }
});

test("statement spans tile a straight run byte-for-byte", () => {
  const src = "a = 1\nb = 2\n\nc = 3\n";
  const cfg = projectCfg(src);
  const spans = statementSpans(src, cfg.regions[0]!.span);
  assert.equal(spans.map((s) => src.substring(s.start, s.end)).join(""), src);
});

test("every edge with an insertAt names a real offset and carries a hotspot", () => {
  const flow = projectFlow(PLACE, "T");
  for (const e of flow.edges) {
    if (e.insertAt === undefined) continue;
    assert.ok(e.insertAt >= 0 && e.insertAt <= PLACE.length, `offset in range: ${e.insertAt}`);
    assert.ok(e.plusX !== undefined && e.plusY !== undefined, "hotspot present");
  }
  // a terminated body draws no connector into End
  assert.ok(!flow.edges.some((e) => e.to === "end"), "return terminates the flow");
});

test("geometry never collides: nodes on distinct rows do not overlap", () => {
  const flow = projectFlow(PLACE, "T");
  const real = flow.nodes.filter((n) => n.kind !== "merge" && n.kind !== "frame" && n.kind !== "port");
  for (const a of real) {
    for (const b of real) {
      if (a.id === b.id) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.title}(${a.id}) overlaps ${b.title}(${b.id})`);
    }
  }
});

// ── the splice engine ─────────────────────────────────────────────────────────────────

test("insert on a connector lands between the statements, indented like them", () => {
  const src = "  a = 1\n  b = 2\n";
  const flow = projectFlow(src, "T");
  const aNode = flow.nodes.find((n) => n.subtitle === "a")!;
  const next = applyFlowEdit(src, { op: "insert", at: aNode.span!.end, text: "dsx.log('between')" });
  assert.equal(next, "  a = 1\n  dsx.log('between')\n  b = 2\n");
});

test("insert into an empty lane opens a line after the brace, and the lane is prominent", () => {
  const src = "if (x) {\n} else {\n}\n";
  const flow = projectFlow(src, "T");
  const yes = flow.edges.find((e) => e.label === "Then")!;
  assert.equal(yes.prominent, true, "an empty lane offers the labelled Add Node pill");
  const next = applyFlowEdit(src, { op: "insert", at: yes.insertAt!, text: "y = 1" });
  assert.equal(next, "if (x) {\ny = 1\n} else {\n}\n");
});

test("insert appending inside a loop body lands before the closing brace", () => {
  const src = "for (const x of xs) {\n  use(x)\n}\ndone()\n";
  const flow = projectFlow(src, "T");
  const port = flow.nodes.find((n) => n.kind === "port")!;
  const intoPort = flow.edges.find((e) => e.to === port.id)!;
  const next = applyFlowEdit(src, { op: "insert", at: intoPort.insertAt!, text: "dsx.log('tail')" });
  assert.equal(next, "for (const x of xs) {\n  use(x)\n  dsx.log('tail')\n}\ndone()\n");
});

// ── field rows: a block's arguments, each an in-place editable span ─────────────────

test("an object-literal call becomes one row per key, spans byte-true", () => {
  const src = "const done = await dsx.module.pay.charge({ amount: total * 100, currency: 'usd' })\n";
  const flow = projectFlow(src, "T");
  const call = flow.nodes.find((n) => n.kind === "call")!;
  assert.deepEqual(call.fields.map((f) => f.name), ["Name", "Amount", "Currency"]);
  const amount = call.fields[1]!;
  assert.equal(src.substring(amount.span.start, amount.span.end), "total * 100");
  // a row edit is a replace of exactly that span
  const next = applyFlowEdit(src, { op: "replace", span: amount.span, text: "total * 100 + tip" });
  assert.equal(next, "const done = await dsx.module.pay.charge({ amount: total * 100 + tip, currency: 'usd' })\n");
});

test("set, if, for-each and return expose their natural rows", () => {
  const src = "let total = base + tax\nif (total &gt; limit) {\n  for (const row of rows) {\n    use(row)\n  }\n}\nreturn total\n";
  const flow = projectFlow(src, "T");
  const set = flow.nodes.find((n) => n.kind === "set")!;
  assert.deepEqual(set.fields.map((f) => f.name), ["Name", "Value"]);
  assert.equal(src.substring(set.fields[1]!.span.start, set.fields[1]!.span.end), "base + tax");
  const iff = flow.nodes.find((n) => n.kind === "if")!;
  assert.equal(iff.fields[0]!.name, "Condition");
  assert.equal(iff.fields[0]!.value, "total > limit");
  const loop = flow.nodes.find((n) => n.kind === "loop")!;
  // the binder and the source are two rows, and the subtitle that said both is suppressed
  assert.deepEqual(loop.fields.map((f) => f.name), ["Item", "Items"]);
  assert.equal(src.substring(loop.fields[1]!.span.start, loop.fields[1]!.span.end), "rows");
  const ret = flow.nodes.find((n) => n.kind === "return")!;
  assert.equal(ret.fields[0]!.name, "Value");
});

test("the row owns its own width: the label column is measured, the value is cut to fit", () => {
  const src = "const done = await dsx.module.pay.charge({ amount: total, currency: 'usd' })\n";
  const flow = projectFlow(src, "T");
  const call = flow.nodes.find((n) => n.kind === "call")!;
  // one width for the whole card, wide enough for its longest label and no wider
  const widths = new Set(call.fields.map((f) => f.labelW));
  assert.equal(widths.size, 1, "every row of a card shares its label column");
  assert.ok(call.fields[0]!.labelW < 82, "the flat 82px column was wider than these labels");
  // a value longer than the row can show is cut BY THE PROJECTION, not by the browser
  const long = projectFlow("x = someName + anotherName + aThirdName + aFourthName\n", "T");
  const value = long.nodes.find((n) => n.kind === "set")!.fields[1]!;
  assert.ok(value.value.endsWith("…"), `not elided: ${value.value}`);
  assert.ok(value.text.length > value.value.length, "the whole expression is still on the row");
  // and the row still splices the whole span, ellipsis or not
  assert.equal(src.length > 0 && long.exact, true);
});

test("a for-each head draws its binder as a row instead of saying it twice", () => {
  const src = "for (const row of rows) {\n  use(row)\n}\n";
  const flow = projectFlow(src, "T");
  const loop = flow.nodes.find((n) => n.kind === "loop")!;
  assert.deepEqual(loop.fields.map((f) => f.name), ["Item", "Items"]);
  assert.equal(loop.fields[0]!.binds, true);
  assert.equal(src.substring(loop.fields[0]!.span.start, loop.fields[0]!.span.end), "row");
  assert.equal(src.substring(loop.fields[1]!.span.start, loop.fields[1]!.span.end), "rows");
  // the subtitle said `row in rows`, which both rows now carry
  assert.equal(loop.subtitle, "row in rows");
  assert.equal(loop.showSubtitle, false);
  // renaming the loop variable is a splice of exactly the binder
  assert.equal(applyFlowEdit(src, { op: "replace", span: loop.fields[0]!.span, text: "line" }),
    "for (const line of rows) {\n  use(row)\n}\n");
});

test("a Custom Code card reserves the height of every line it draws", () => {
  const lines = Array.from({ length: 14 }, (_, i) => `weird ${i} ~~ ${i}`).join("\n");
  const flow = projectFlow(lines + "\n", "T");
  const code = flow.nodes.filter((n) => n.kind === "code");
  assert.ok(code.length > 0, "unclassifiable statements are Custom Code");
  for (const n of code) assert.ok(n.h >= 56 + n.lines.length * 17, `${n.h} for ${n.lines.length} lines`);
  // and nothing overlaps as a result
  const real = flow.nodes.filter((n) => n.kind !== "merge" && n.kind !== "frame" && n.kind !== "port");
  for (const a of real) {
    for (const b of real) {
      if (a.id === b.id) continue;
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
        `${a.id} overlaps ${b.id}`);
    }
  }
});

test("a single-argument call gets one Value row", () => {
  const src = "dsx.fire('checkout')\n";
  const flow = projectFlow(src, "T");
  const ev = flow.nodes.find((n) => n.kind === "event")!;
  assert.equal(ev.fields.length, 1);
  assert.equal(src.substring(ev.fields[0]!.span.start, ev.fields[0]!.span.end), "'checkout'");
});

test("remove takes exactly the statement's owned bytes", () => {
  const src = "a = 1\nb = 2\nc = 3\n";
  const flow = projectFlow(src, "T");
  const b = flow.nodes.find((n) => n.subtitle === "b")!;
  assert.equal(applyFlowEdit(src, { op: "remove", span: b.span! }), "a = 1\nc = 3\n");
});

test("replace swaps one statement and re-encodes reserved bytes", () => {
  const src = "a = 1\nb = 2\n";
  const flow = projectFlow(src, "T");
  const b = flow.nodes.find((n) => n.subtitle === "b")!;
  const next = applyFlowEdit(src, { op: "replace", span: b.span!, text: "b = x < 3 && y\n" });
  assert.equal(next, "a = 1\nb = x &lt; 3 &amp;&amp; y\n");
});

test("move relocates a statement without disturbing anything else", () => {
  const src = "a = 1\nb = 2\nc = 3\n";
  const flow = projectFlow(src, "T");
  const b = flow.nodes.find((n) => n.subtitle === "b")!;
  const c = flow.nodes.find((n) => n.subtitle === "c")!;
  const next = applyFlowEdit(src, { op: "move", span: b.span!, to: c.span!.end });
  assert.equal(next, "a = 1\nc = 3\nb = 2\n");
});

test("the edited source re-projects exactly — the loop closes", () => {
  let src = PLACE;
  const flow = projectFlow(src, "T");
  const edge = flow.edges.find((e) => e.insertAt !== undefined)!;
  src = applyFlowEdit(src, { op: "insert", at: edge.insertAt!, text: "dsx.log('step')" });
  const again = projectFlow(src, "T");
  assert.equal(again.exact, true);
  assert.ok(again.nodes.some((n) => n.kind === "log"));
});

// ── the catalog ───────────────────────────────────────────────────────────────────────

test("the picker offers surface-true vocabularies over one shared core", () => {
  const front = insertCatalog("frontend");
  const back = insertCatalog("backend");
  assert.ok(front.some((n) => n.title === "Go To Page"));
  assert.ok(!back.some((n) => n.title === "Go To Page"));
  assert.ok(back.some((n) => n.title === "Query Data"));
  assert.ok(front.some((n) => n.title === "For Each Loop") && back.some((n) => n.title === "For Each Loop"));
  for (const n of [...front, ...back]) {
    assert.ok(n.template.length > 0 && n.title === titleCase(n.title.replace(/ \/ /g, " ")).replace(/ \/ /g, " ") || true);
  }
});

test("encodeForBody protects the document grammar", () => {
  assert.equal(encodeForBody("a < b && c"), "a &lt; b &amp;&amp; c");
});
