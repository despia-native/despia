// The expression canvas in the REAL Studio, measured rather than admired.
//
// A drawing can be right in the model and wrong on the screen, and the two failures look
// nothing alike. `exprflow.test.ts` proves the model: no overlap, every socket landed, every
// span contained. This proves the RENDERING of it, in a real engine, against a real project:
// a socket hung off a row inherits the row list's padding and lands nine pixels clear of the
// wall; a card whose head is painted over by an opaque sibling measures perfectly and shows
// nothing; a wire routed through a midpoint crosses a title. None of those are visible from
// either side alone.
//
// What it asserts, per fixture:
//   · no two node boxes overlap (a body inside its own container's frame is containment)
//   · no label is clipped, and no ink paints outside its own card
//   · no ink is COVERED by an opaque sibling
//   · every input socket sits ON its card's wall, measured in world units, and every
//     parameter pill's socket sits on the pill's own wall - a pill is a wire source, and it
//     is sized to its name, so the socket has to walk in with the capsule
//   · a container's NAMEPLATE is its own content's width, never the card's: a container's
//     card is as wide as its BODY, and a plate that tracked the card painted a 1090x17 band
//     with a title in the corner, which reads as a page background rather than a header
//   · every wire's ink reaches a socket
//   · the workflow canvas underneath has no panel left standing
//   · every canvas carries the samples its composited rect needs (R21)
//
//   node packages/dom/oracle/expression-canvas-browser.ts
//   SHOTS=/tmp/expr CASE=reduce,matrix node packages/dom/oracle/expression-canvas-browser.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

type Case = { name: string; expr: string; note: string };

const chain12 = "raw.trim().toLowerCase().replaceAll(' ', '-').slice(0, 40).padEnd(40, '.')"
  + ".split('-').join('_').toUpperCase().trim().concat('!').repeat(2).slice(0, 60)";
const sum40 = Array.from({ length: 40 }, (_, i) => `p${i}.price * p${i}.qty`).join(" + ");
const record30 = "{ " + Array.from({ length: 30 }, (_, i) =>
  (i % 5 === 0 ? `f${i}: row.a${i} * 2` : `f${i}: ${i}`)).join(", ") + " }";
let deep30 = "seed";
for (let i = 0; i < 30; i++) deep30 = `Math.round(${deep30} * ${i + 1})`;
const matrix = "regions.map(r => ({ region: r.name, revenue: r.stores"
  + ".filter(s => s.open).map(s => s.orders.reduce((t, o) => t + o.total * (1 - o.discount), 0))"
  + ".reduce((t, n) => t + n, 0) }))";

export const CASES: Case[] = [
  { name: "chain", expr: "user.email.trim().toLowerCase()", note: "the spine: one straight rule" },
  { name: "arithmetic", expr: "(subtotal + shipping) * (1 + taxRate) - discount", note: "a fan of maths" },
  { name: "compare", expr: "order.total >= 100 && customer.tier != 'free'", note: "tests and a combinator" },
  { name: "choose", expr: "cart.items.length == 0 ? 'Your cart is empty' : `${cart.items.length} items`", note: "the ternary and a template" },
  { name: "map", expr: "products.map(p => ({ id: p.id, label: p.name, price: p.price * 1.2 }))", note: "a container over a record" },
  { name: "filtersort", expr: "products.filter(p => p.price >= min && p.inStock).sortBy(p => p.price)", note: "two containers in a chain" },
  { name: "reduce", expr: "order.lines.reduce((total, line) => total + line.price * line.qty, 0).toFixed(2)", note: "the carry edge" },
  { name: "nested", expr: "teams.map(t => ({ name: t.name, open: t.tickets.filter(i => i.state == 'open').length }))", note: "a container inside a container" },
  { name: "record", expr: "{ id: order.id, when: order.createdAt, total: order.total, paid: order.status == 'paid', note: '' }", note: "a record with a port per value" },
  { name: "list", expr: "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, count * 2, 27, 28]", note: "a collection past the chip threshold" },
  { name: "coalesce", expr: "user.profile?.displayName ?? user.email ?? 'Someone'", note: "eager fallbacks, drawn eager" },
  { name: "wide", expr: "a1 + a2 * a3 - a4 / a5 + f(a6, a7) + [a8, a9].join('') + (a10 > a11 ? a12 : a13) + `${a14}`", note: "the widest fan the corpus has" },
  { name: "chain12", expr: chain12, note: "twelve links on one spine" },
  { name: "sum40", expr: sum40, note: "forty products under one sum" },
  { name: "record30", expr: record30, note: "thirty fields, six of them computed" },
  { name: "deep30", expr: deep30, note: "thirty levels of nesting" },
  { name: "matrix", expr: matrix, note: "three containers deep, with a fold at the bottom" },
  { name: "quotes", expr: "join(sep == '' ? ' ' : sep, [a, 'b c', ''])", note: "the empty string, a space, and a word" },
];

const OUT = process.env["SHOTS"] ?? "";
if (OUT !== "") mkdirSync(OUT, { recursive: true });
const only = (process.env["CASE"] ?? "").split(",").filter(Boolean);
const list = only.length > 0 ? CASES.filter((c) => only.includes(c.name)) : CASES;

const root = mkdtempSync(join(tmpdir(), "dsx-expr-"));
const enc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const app = `<stack style="gap: 1rem; padding: 1.5rem">
  <head>
${list.map((c, i) => `    <action as="case${i}">\n      return ${enc(c.expr)}\n    </action>`).join("\n")}
  </head>
  <text value="Expression corpus"/>
</stack>
`;
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "expr", scheme: "expr" }),
  "dsx.config.json": JSON.stringify({ name: "Expr", entry: "App", routes: [{ path: "/", component: "expr.App" }] }),
  "Components/App.dsx": app,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

const PROBE = `(() => {
  // SCOPED TO THE OVERLAY. The workflow canvas is still mounted underneath with a world, a
  // set of connectors and a zoom of its own; a document-wide query mixes the two and reports
  // the wrong canvas as blurry.
  const shell = document.querySelector('.expr-shell');
  if (shell === null) {
    return JSON.stringify({ nodes: 0, frames: 0, ports: 0, wires: 0, overlaps: [], clipped: [],
      spills: [], covered: [], offWall: [], wideCap: [], shortWire: [],
      leftOver: ['no expression surface'], tinyPorts: 0, degenerate: 0, dprOff: 0 });
  }
  const q = (sel) => Array.prototype.slice.call(shell.querySelectorAll(sel));
  const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  // The world's own scale: every world measurement below is in WORLD units, because an 8px
  // socket at 30% zoom measures 2.4 device pixels and is still an 8px socket.
  const wnode = shell.querySelector('.flow-world');
  const wm = wnode ? new DOMMatrixReadOnly(getComputedStyle(wnode).transform) : null;
  const zoom = wm && wm.a > 0 ? wm.a : 1;
  const nodes = q('.expr-node');
  const frames = q('.expr-frame').map(rect);
  const boxes = nodes.map(rect);
  const inAFrame = (b) => frames.some((f) =>
    b.x >= f.x - 2 && b.y >= f.y - 2 && b.x + b.w <= f.x + f.w + 2 && b.y + b.h <= f.y + f.h + 2);
  const hits = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (!(a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1)) continue;
      if (inAFrame(a) || inAFrame(b)) continue;
      hits.push([nodes[i].innerText.split('\\n')[0], nodes[j].innerText.split('\\n')[0]]);
    }
  }
  // A clipped label wants more room than its own box gives it. One pixel of rounding is not
  // a defect; three is.
  const clipped = [];
  for (const sel of ['.expr-title', '.expr-sub', '.expr-well-text', '.expr-pill-name', '.expr-frame-name', '.expr-row-name']) {
    for (const e of q(sel)) {
      if (e.scrollWidth > e.clientWidth + 3 && e.clientWidth > 0) clipped.push(sel + ':' + e.innerText.slice(0, 24));
    }
  }
  // INK OUTSIDE ITS OWN CARD. overflow:visible is on the node so a socket can sit on the
  // wall; the cost is that a mis-measured label paints past the border instead of ellipsing.
  const spills = [];
  for (const n of nodes) {
    const nb = n.getBoundingClientRect();
    for (const t of Array.prototype.slice.call(n.querySelectorAll('.expr-title,.expr-sub,.expr-well,.expr-row-name,.expr-chip,.expr-linked'))) {
      const r = t.getBoundingClientRect();
      if (r.right > nb.right + 1 || r.left < nb.left - 1 || r.bottom > nb.bottom + 1) {
        spills.push(t.className.split(' ').pop() + ' "' + t.innerText.slice(0, 20) + '" +' + Math.round(r.right - nb.right));
      }
    }
  }
  // COVERED INK. A card whose title is painted over by an opaque sibling measures perfectly:
  // right box, right size, nothing clipped, nothing spilling, and it shows nothing. The only
  // test that catches it asks the document what is actually on top at that pixel.
  const covered = [];
  for (const t of q('.expr-title,.expr-well-text,.expr-row-name,.expr-pill-name,.expr-frame-name')) {
    const r = t.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    if (top === null || top === t || t.contains(top) || top.contains(t)) continue;
    covered.push(t.className.split(' ')[1] + ' "' + t.innerText.slice(0, 18) + '" under ' + String(top.className).slice(0, 28));
  }
  // A SOCKET IS ON THE WALL, and a wire ENDS ON A SOCKET. Both are asserted in model
  // coordinates by the unit suite, which is exactly why they need asserting again here.
  const ports = q('.expr-port').map(rect);
  const offWall = [];
  for (const n of nodes) {
    const nb = n.getBoundingClientRect();
    for (const p of Array.prototype.slice.call(n.querySelectorAll('.expr-port-list .expr-port'))) {
      const r = p.getBoundingClientRect();
      const drift = Math.abs((r.x + r.width / 2) - nb.x) / zoom;
      if (drift > 2) offWall.push(n.innerText.split('\\n')[0] + ' port drifts ' + drift.toFixed(1) + 'px off its wall');
    }
  }
  // A PILL IS A WIRE SOURCE TOO, and its wall is the rail's leading edge. The pill is sized
  // to its own name now - 24px for a one-character parameter, where it used to be a 56px
  // capsule holding one character against its left edge - so the socket has to move with it.
  for (const pill of q('.expr-pill')) {
    const pb = pill.getBoundingClientRect();
    for (const p of Array.prototype.slice.call(pill.querySelectorAll('.expr-port'))) {
      const r = p.getBoundingClientRect();
      const drift = Math.abs((r.x + r.width / 2) - (pb.x + pb.width)) / zoom;
      if (drift > 2) offWall.push(pill.innerText.trim() + ' pill socket drifts ' + drift.toFixed(1) + 'px off its wall');
    }
  }
  // THE NAMEPLATE IS ITS OWN CONTENT'S WIDTH. A container's card is as wide as its BODY, so a
  // plate bound to the card is a band: Keep Where painted 597px with its content ending 160px
  // in, and the matrix fixture's outer Map Over painted 1090 with a title in the leftmost 90.
  const wideCap = [];
  for (const n of nodes) {
    const cap = n.querySelector('.expr-cap');
    const head = n.querySelector('.expr-head');
    if (cap === null || head === null) continue;
    const cb = cap.getBoundingClientRect(), hb = head.getBoundingClientRect();
    const nb = n.getBoundingClientRect();
    if (cb.width <= hb.width + 2) continue;
    wideCap.push(n.innerText.split('\\n')[0] + ' plate is ' + Math.round(cb.width / zoom)
      + 'px over a ' + Math.round(hb.width / zoom) + 'px head in a '
      + Math.round(nb.width / zoom) + 'px card');
  }
  const cons = q('.flow-connector');
  const shortWire = [];
  for (const c of cons) {
    const cb = c.getBoundingClientRect();
    let near = false;
    for (const p of ports) {
      const px = p.x + p.w / 2, py = p.y + p.h / 2;
      if (px > cb.x - 12 && px < cb.x + cb.width + 12 && py > cb.y - 12 && py < cb.y + cb.height + 12) near = true;
    }
    if (!near) shortWire.push(Math.round(cb.x) + ',' + Math.round(cb.y));
  }
  // The formula surface is a MODE over the workflow, and a mode that leaves the previous
  // mode's panels behind is two surfaces at once.
  const leftOver = [];
  for (const e of Array.prototype.slice.call(document.querySelectorAll('.logic-detail, .logic-picker, .logic-bodies'))) {
    if (shell.contains(e)) continue;
    const st = getComputedStyle(e);
    if (st.opacity === '0' || st.display === 'none' || st.visibility === 'hidden') continue;
    leftOver.push(e.className.split(' ')[1]);
  }
  const tiny = ports.filter((p) => p.w / zoom < 4 || p.h / zoom < 4).length;
  const degenerate = cons.filter((e) => { const r = e.getBoundingClientRect(); return r.width / zoom < 2 || r.height / zoom < 2; }).length;
  // The backing store must carry the samples the COMPOSITED rect needs, floor of one device
  // pixel per layout pixel: over-sampled is allowed, under-sampled is a stale raster (R21).
  const dprOff = q('.flow-connector canvas').filter((c) => {
    const laid = c.offsetWidth || c.getBoundingClientRect().width / zoom;
    if (laid < 1) return false;
    return c.width + 2 < Math.round(laid * Math.max(1, Math.min(8, devicePixelRatio * zoom)));
  }).length;
  return JSON.stringify({
    nodes: nodes.length, frames: frames.length, ports: ports.length, wires: cons.length,
    overlaps: hits, clipped, spills, covered, offWall, wideCap, shortWire, leftOver,
    tinyPorts: tiny, degenerate, dprOff,
  });
})()`;

const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const browser = await launchBrowser(browserEngine());
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// An icon name the corpus does not carry draws a filled placeholder disc and logs a warn. The
// oracle collected errors only, so a node wearing a placeholder counted as a clean fixture -
// which is how a solid dot shipped as "Add To List". A placeholder is a failed fixture.
const unmapped = new Set<string>();
page.on("console", (m) => {
  const hit = /unmapped icon '([^']+)'/.exec(m.text());
  if (hit !== null) unmapped.add(hit[1]!);
});
let bad = 0;
try {
  await page.goto(`http://127.0.0.1:${server.port}/edit/`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const card = page.locator(".map-name").first();
  if (await card.count() > 0) { await card.click(); await page.waitForTimeout(700); }
  const open = page.getByText("Open in editor", { exact: true });
  if (await open.count() > 0) { await open.first().click(); await page.waitForTimeout(2000); }
  await page.getByRole("button", { name: "Logic view" }).click();
  await page.waitForTimeout(1500);

  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    const row = page.getByText(`case${i}`, { exact: true }).first();
    if (await row.count() === 0) { console.log(`MISS  ${c.name}`); bad++; continue; }
    await row.click();
    await page.waitForTimeout(900);
    const arg = page.locator(".logic-row").first();
    if (await arg.count() === 0) { console.log(`NOROW ${c.name}`); bad++; continue; }
    await arg.click();
    await page.waitForTimeout(500);
    const btn = page.getByRole("button", { name: "Diagram" }).first();
    if (await btn.count() === 0) { console.log(`NOBTN ${c.name}`); bad++; continue; }
    await btn.click();
    await page.waitForTimeout(1400);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(250);
    if (OUT !== "") await page.screenshot({ path: join(OUT, `${String(i).padStart(2, "0")}-${c.name}.png`) });
    const g = JSON.parse(String(await page.evaluate(PROBE))) as {
      nodes: number; frames: number; ports: number; wires: number;
      overlaps: string[][]; clipped: string[]; spills: string[]; covered: string[];
      offWall: string[]; wideCap: string[]; shortWire: string[]; leftOver: string[];
      tinyPorts: number; degenerate: number; dprOff: number;
    };
    const fail = g.overlaps.length + g.clipped.length + g.spills.length + g.covered.length
      + g.offWall.length + g.wideCap.length + g.shortWire.length + g.leftOver.length
      + g.tinyPorts + g.degenerate + g.dprOff + (g.nodes === 0 ? 1 : 0);
    if (fail > 0) bad++;
    console.log(
      `${fail === 0 ? "ok   " : "FAIL "}${c.name.padEnd(12)} nodes=${String(g.nodes).padStart(3)}` +
      ` frames=${g.frames} ports=${String(g.ports).padStart(3)} wires=${String(g.wires).padStart(3)}` +
      ` overlap=${g.overlaps.length} clipped=${g.clipped.length} spill=${g.spills.length}` +
      ` covered=${g.covered.length} offWall=${g.offWall.length} plate=${g.wideCap.length}` +
      ` loose=${g.shortWire.length}` +
      ` stale=${g.leftOver.length} tinyPort=${g.tinyPorts} degenerate=${g.degenerate} dpr=${g.dprOff}`,
    );
    for (const [a, b] of g.overlaps) console.log(`      overlap: ${a} x ${b}`);
    for (const t of g.clipped.slice(0, 8)) console.log(`      clipped: ${t}`);
    for (const t of g.spills.slice(0, 8)) console.log(`      spill:   ${t}`);
    for (const t of g.covered.slice(0, 8)) console.log(`      covered: ${t}`);
    for (const t of g.offWall.slice(0, 6)) console.log(`      offwall: ${t}`);
    for (const t of g.wideCap.slice(0, 6)) console.log(`      plate:   ${t}`);
    for (const t of g.leftOver) console.log(`      stale:   ${t} from the workflow canvas`);
    const close = page.getByLabel("Close the formula").first();
    if (await close.count() > 0) { await close.click(); await page.waitForTimeout(600); }
  }
} finally {
  await browser.close(); await server.close(); rmSync(root, { recursive: true, force: true });
}
if (unmapped.size > 0) {
  bad += 1;
  console.log(`\nUNMAPPED ICONS (${unmapped.size}): ${[...unmapped].sort().join(", ")}`);
  console.log("each drew a placeholder disc - add its row to OpenSource/Conformance/icons/sf-map.json");
}
console.log(bad === 0 ? `\nall ${list.length} fixtures clean` : `\n${bad} of ${list.length} fixtures failed`);
process.exit(bad === 0 ? 0 : 1);
