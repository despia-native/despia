// THE TWO NODE CANVASES, DRIVEN BY A KEYBOARD AND READ BY THE ACCESSIBILITY TREE.
//
// A node graph is the worst case in software for a reader who is not using a mouse or not
// using their eyes. Everything that makes it comprehensible - where a card sits, which wire
// leaves it, which disc is filled - is geometry, and geometry has no text equivalent. The
// two existing oracles measure the drawing (expression-canvas-browser) and the design
// census (studio-surfaces-browser); neither asks whether a keyboard can get in, whether a
// focus ring is ever painted, or what a card actually announces.
//
// This is that third question, asked against the REAL Studio.
//
// TWO KINDS OF LINE, and the difference is deliberate:
//
//   ok / FAIL   an invariant that HOLDS TODAY. It fails the run, because the point of
//               writing it down is that it cannot quietly stop holding.
//   PEND        a defect that is real today. It prints with the handoff item that fixes
//               it and does NOT fail the run. A gate that is red the day it lands is a
//               gate the next person disables, and then none of the ok lines protect
//               anything either. Promoting one is a one-line change: move its call from
//               `pend(...)` to `must(...)`.
//
//   SHOTS=/tmp/access DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-access-browser.ts
//
// Chromium only: the accessibility tree comes from CDP (`Accessibility.getFullAXTree`),
// which is the only way to read the COMPUTED name a screen reader would speak rather than
// the markup a author wrote. Under another engine the tree checks report as skipped and
// the keyboard checks still run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const OUT = process.env["SHOTS"] ?? "";
if (OUT !== "") mkdirSync(OUT, { recursive: true });

// THREE SHAPES, because the defects are shape-dependent. `fold` is one chain and its DOM
// order happens to match its drawing; `wide` is a fan and `matrix` is four levels of
// nesting, and those two are where a projection that emits containers first and cards
// second stops agreeing with the eye.
const CASES = [
  { name: "fold", expr: "rows.reduce((sum, r) =&gt; sum + r.total * r.qty, 0).toFixed(2)" },
  { name: "wide", expr: "a1 + a2 * a3 - a4 / a5 + f(a6, a7) + [a8, a9].join('') + (a10 &gt; a11 ? a12 : a13)" },
  { name: "matrix", expr: "regions.map(r =&gt; ({ region: r.name, revenue: r.stores.filter(s =&gt; s.open)"
    + ".map(s =&gt; s.orders.reduce((t, o) =&gt; t + o.total * (1 - o.discount), 0)).reduce((t, n) =&gt; t + n, 0) }))" },
] as const;

const APP = `<stack class="page" grow="true" style="gap: 1rem; padding: 1.25rem">
  <head>
    <variable as="rows">return []</variable>
${CASES.map((c) => `    <action as="${c.name}">\n      return ${c.expr}\n    </action>`).join("\n")}
  </head>
  <text value="Orders" class="title"/>
</stack>
`;

const root = mkdtempSync(join(tmpdir(), "dsx-access-"));
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "shop", scheme: "shop" }),
  "dsx.config.json": JSON.stringify({
    name: "Shop", entry: "Orders", routes: [{ path: "/", component: "shop.Orders" }],
  }),
  "Components/Orders.dsx": APP,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

// ── the ledger ────────────────────────────────────────────────────────────────────────

let failures = 0;
let pendingCount = 0;
const pendingItems: string[] = [];

function must(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures += 1;
}
/** A defect that is real today: reported with the handoff item, never fails the run. */
function pend(name: string, ok: boolean, detail: string, item: string): void {
  console.log(`${ok ? "ok  " : "PEND"}  ${name.padEnd(58)} ${detail}${ok ? "" : `  -> ${item}`}`);
  if (!ok) { pendingCount += 1; pendingItems.push(`${name} -> ${item}`); }
}
function note(line: string): void { console.log(`      ${line}`); }

// ── probes that run inside the page ───────────────────────────────────────────────────

/** Every focusable inside a subtree, with whether an aria-hidden ancestor covers it and
 *  whether it is painted at all. Those two disagreeing is the defect this gate exists for. */
const FOCUSABLES = (sel: string): string => `(() => {
  const shellNode = document.querySelector(${JSON.stringify(sel)});
  if (shellNode === null) return JSON.stringify(null);
  const list = Array.prototype.slice.call(
    shellNode.querySelectorAll('button,input,textarea,select,a[href],[tabindex]'))
    .filter((e) => !e.disabled && e.getAttribute('tabindex') !== '-1' && !e.inert);
  return JSON.stringify(list.map((e) => {
    const r = e.getBoundingClientRect();
    let hiddenFrom = null, painted = true;
    for (let n = e; n !== null; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true' && hiddenFrom === null) {
        hiddenFrom = String(n.className).split(' ').slice(0, 2).join('.');
      }
      const cs = getComputedStyle(n);
      if (Number(cs.opacity) === 0 || cs.visibility === 'hidden' || cs.display === 'none') painted = false;
    }
    return {
      cls: String(e.className).split(' ').filter((c) => !c.startsWith('dsx-'))[0]
        || String(e.className).split(' ')[0],
      name: e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 40),
      x: Math.round(r.x), y: Math.round(r.y), hiddenFrom, painted,
    };
  }));
})()`;

/** What the expression canvas exposes as structure: heads in DOM order with their drawn x,
 *  the container bands, the parameter pills, and which decorative marks are hidden. */
const STRUCTURE = `(() => {
  const shell = document.querySelector('.expr-shell');
  if (shell === null) return JSON.stringify(null);
  const hiddenAncestor = (e) => {
    for (let n = e; n !== null; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
      if (n === shell) return false;
    }
    return false;
  };
  const heads = Array.prototype.slice.call(shell.querySelectorAll('.expr-head')).map((h) => {
    const r = h.getBoundingClientRect();
    return { name: (h.getAttribute('aria-label') || '').trim(), x: Math.round(r.x),
      y: Math.round(r.y), tag: h.tagName.toLowerCase(), hidden: hiddenAncestor(h) };
  });
  const rows = Array.prototype.slice.call(shell.querySelectorAll('.expr-row')).map((h) => ({
    name: (h.getAttribute('aria-label') || '').trim(),
    text: (h.innerText || '').replace(/\\n/g, ' | ').slice(0, 60),
    linked: h.querySelector('.expr-linked') !== null
      && getComputedStyle(h.querySelector('.expr-linked')).display !== 'none',
    tag: h.tagName.toLowerCase(), hidden: hiddenAncestor(h),
  }));
  const frames = Array.prototype.slice.call(shell.querySelectorAll('.expr-frame')).map((f) => ({
    text: (f.innerText || '').replace(/\\n/g, ' ').trim().slice(0, 48), hidden: hiddenAncestor(f),
  }));
  const pills = Array.prototype.slice.call(shell.querySelectorAll('.expr-pill')).map((p) => ({
    name: (p.getAttribute('aria-label') || '').trim(),
    text: (p.innerText || '').trim().slice(0, 24),
    focusable: p.tagName === 'BUTTON' || p.hasAttribute('tabindex'),
    role: p.getAttribute('role'), hidden: hiddenAncestor(p),
  }));
  const decorative = { port: 0, portHidden: 0, tile: 0, tileHidden: 0, wire: 0, wireHidden: 0 };
  for (const p of shell.querySelectorAll('.expr-port')) { decorative.port++; if (hiddenAncestor(p)) decorative.portHidden++; }
  for (const t of shell.querySelectorAll('.expr-tile')) { decorative.tile++; if (hiddenAncestor(t)) decorative.tileHidden++; }
  for (const w of shell.querySelectorAll('.flow-connector')) { decorative.wire++; if (hiddenAncestor(w)) decorative.wireHidden++; }
  const world = shell.querySelector('.flow-world');
  const zoom = world === null ? 1 : new DOMMatrixReadOnly(getComputedStyle(world).transform).a;
  return JSON.stringify({ heads, rows, frames, pills, decorative, zoom });
})()`;

/** The focus indicator actually painted on whatever currently has focus. */
const INDICATOR = `(() => {
  const a = document.activeElement;
  if (a === null) return JSON.stringify(null);
  const cs = getComputedStyle(a);
  const world = document.querySelector('.expr-shell .flow-world');
  const zoom = world === null ? 1 : new DOMMatrixReadOnly(getComputedStyle(world).transform).a;
  const inWorld = world !== null && world.contains(a);
  const w = parseFloat(cs.outlineWidth) || 0;
  return JSON.stringify({
    cls: String(a.className).split(' ').filter((c) => !c.startsWith('dsx-'))[0] || '',
    name: a.getAttribute('aria-label') || '',
    outlineStyle: cs.outlineStyle, outlineWidth: w, outlineColor: cs.outlineColor,
    shadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 40),
    // A ring inside the transformed world is drawn in WORLD units, so it shrinks with the
    // canvas. That is the number an author cares about: what reaches the screen.
    paintedWidth: inWorld ? w * zoom : w, zoom, inWorld,
  });
})()`;

// ── the walk ──────────────────────────────────────────────────────────────────────────

const engine = browserEngine();
const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const browser = await launchBrowser(engine);
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
const page = await ctx.newPage();

type Probe = { cls: string; name: string; x: number; y: number; hiddenFrom: string | null; painted: boolean };

const read = async <T,>(js: string): Promise<T | null> => JSON.parse(String(await page.evaluate(js))) as T | null;
const focusName = (): Promise<string> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (a === null) return "null";
  const cls = String(a.className).split(" ").filter((c) => !c.startsWith("dsx-"))[0] ?? a.tagName.toLowerCase();
  return `${a.getAttribute("aria-label") ?? (a.textContent ?? "").trim().slice(0, 24)} <${cls}>`;
});
const opacityOf = (sel: string, n = 0): Promise<string> =>
  page.locator(sel).nth(n).evaluate((e) => getComputedStyle(e).opacity);

try {
  await page.goto(`http://127.0.0.1:${server.port}/edit/`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  await page.locator(".map-name").filter({ hasText: "Orders" }).first().click();
  await page.waitForTimeout(700);
  await page.getByText("Open in editor", { exact: true }).first().click();
  await page.waitForTimeout(2200);
  await page.getByRole("button", { name: "Logic view" }).click();
  await page.waitForTimeout(1700);

  // ── the workflow canvas, before a formula is ever opened ────────────────────────────
  // A body has to be chosen first: the Logic view opens on the body LIST, and a canvas
  // with nothing on it would report a clean keyboard walk over an empty surface.
  console.log("\n== the workflow canvas ==");
  await page.getByText(CASES[0].name, { exact: true }).first().click();
  await page.waitForTimeout(1100);
  const heads = await page.locator(".logic-node-head").count();
  const namedHeads = await page.locator(".logic-node-head[aria-label]").count();
  must("a workflow step head is a focusable control with a name",
    heads > 0 && namedHeads === heads, `${namedHeads}/${heads} named`);

  // The expression canvas is mounted with keep="true" from the moment the Logic view
  // loads, so its chrome is in the tab order of a surface it is not on.
  const keptShell = await read<Probe[]>(FOCUSABLES(".expr-shell"));
  const keptGhosts = (keptShell ?? []).filter((f) => !f.painted);
  pend("the unopened formula overlay adds no tab stops to the workflow canvas",
    keptGhosts.length === 0, `${keptGhosts.length} invisible stops`, "ACCESS-HANDOFF.md K1");
  if (keptGhosts.length > 0) {
    note(`they are: ${keptGhosts.map((g) => g.name || g.cls).join(", ")}`);
  }

  // ── the expression canvas, one fixture at a time ────────────────────────────────────
  for (const c of CASES) {
    console.log(`\n== the expression canvas: ${c.name} ==`);
    await page.getByText(c.name, { exact: true }).first().click();
    await page.waitForTimeout(1000);
    const rowCount = await page.locator(".logic-row").count();
    if (rowCount === 0) { must(`${c.name}: the fixture reaches an argument row`, false, "no .logic-row"); continue; }
    await page.locator(".logic-row").first().click();
    await page.waitForTimeout(700);
    const diagram = page.getByRole("button", { name: "Diagram" }).first();
    if (await diagram.count() === 0) { must(`${c.name}: the fixture reaches Diagram`, false, "no button"); continue; }
    await diagram.click();
    await page.waitForTimeout(2000);

    const s = await read<{
      heads: { name: string; x: number; y: number; tag: string; hidden: boolean }[];
      rows: { name: string; text: string; linked: boolean; tag: string; hidden: boolean }[];
      frames: { text: string; hidden: boolean }[];
      pills: { name: string; text: string; focusable: boolean; role: string | null; hidden: boolean }[];
      decorative: Record<string, number>;
      zoom: number;
    }>(STRUCTURE);
    if (s === null || s.heads.length === 0) {
      must(`${c.name}: the expression canvas draws its graph`, false, "0 nodes on the surface");
      continue;
    }
    must(`${c.name}: the expression canvas draws its graph`, true, `${s.heads.length} nodes`);
    if (OUT !== "") await page.screenshot({ path: join(OUT, `${c.name}.png`) });

    // ── what is a control, and does it have a name ────────────────────────────────────
    must(`${c.name}: every node head is a button with an accessible name`,
      s.heads.every((h) => h.tag === "button" && h.name.length > 0),
      `${s.heads.filter((h) => h.tag === "button" && h.name.length > 0).length}/${s.heads.length}`);
    must(`${c.name}: every operand row is a button with an accessible name`,
      s.rows.every((r) => r.tag === "button" && r.name.length > 0),
      `${s.rows.filter((r) => r.tag === "button" && r.name.length > 0).length}/${s.rows.length}`);
    must(`${c.name}: no node card or operand row is hidden from assistive tech`,
      s.heads.every((h) => !h.hidden) && s.rows.every((r) => !r.hidden),
      `${s.heads.filter((h) => h.hidden).length + s.rows.filter((r) => r.hidden).length} hidden`);
    // The other half of the same law: what IS decoration must be hidden, or a screen
    // reader walks 60 unlabelled discs before reaching a card.
    must(`${c.name}: sockets, tiles and wires are hidden as decoration`,
      s.decorative["port"] === s.decorative["portHidden"]
      && s.decorative["tile"] === s.decorative["tileHidden"]
      && s.decorative["wire"] === s.decorative["wireHidden"],
      `ports ${s.decorative["portHidden"]}/${s.decorative["port"]} tiles ${s.decorative["tileHidden"]}/${s.decorative["tile"]} wires ${s.decorative["wireHidden"]}/${s.decorative["wire"]}`);

    // ── a row must say where its value comes from ─────────────────────────────────────
    // A wired row and a typed row are told apart on three channels today - a recessed
    // well, the ink, and a filled socket - and all three are visual. The accessible name
    // is the same shape for both ("Edit <slot>"), so the one question a dataflow graph
    // exists to answer is unanswerable without the drawing.
    const wired = s.rows.filter((r) => r.linked);
    const wiredNamed = wired.filter((r) => /from |wired|comes from/i.test(r.name));
    pend(`${c.name}: a wired row's name says where the value comes from`,
      wired.length === 0 || wiredNamed.length === wired.length,
      `${wiredNamed.length}/${wired.length} wired rows`, "ACCESS-HANDOFF.md S1");
    const typed = s.rows.filter((r) => !r.linked);
    const typedNamed = typed.filter((r) => r.name.length > `Edit ${r.text.split(" | ")[0]}`.length);
    pend(`${c.name}: a typed row's name carries its value`,
      typed.length === 0 || typedNamed.length === typed.length,
      `${typedNamed.length}/${typed.length} typed rows`, "ACCESS-HANDOFF.md S1");

    // ── the container band ────────────────────────────────────────────────────────────
    // `FOR EACH r CARRYING sum` is the whole of what makes a fold comprehensible, and it
    // is the one piece of prose the canvas already draws in words.
    pend(`${c.name}: a container's band reaches the accessibility tree`,
      s.frames.length === 0 || s.frames.every((f) => !f.hidden),
      `${s.frames.filter((f) => f.hidden).length}/${s.frames.length} bands hidden`,
      "ACCESS-HANDOFF.md S2");
    pend(`${c.name}: a parameter pill is a named control`,
      s.pills.length === 0 || s.pills.every((p) => p.focusable && p.name.length > 0),
      `${s.pills.filter((p) => p.focusable && p.name.length > 0).length}/${s.pills.length} pills`,
      "ACCESS-HANDOFF.md S4");

    // ── reading order ─────────────────────────────────────────────────────────────────
    // The cards are absolutely positioned from a computed layout, so DOM order is whatever
    // the projection emitted: containers by depth, then everything else. A reader who
    // tabs is walking that list, not the drawing.
    const drawn = s.heads.map((h) => h.x);
    let inversions = 0;
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) if (drawn[j]! < drawn[i]! - 8) inversions += 1;
    }
    pend(`${c.name}: DOM order walks the drawing left to right`, inversions === 0,
      `${inversions} inversions`, "ACCESS-HANDOFF.md S3");
    if (inversions > 0) note(`tab order: ${s.heads.map((h) => `${h.name.trim()}@${h.x}`).join(" > ")}`);

    // ── the tab walk ──────────────────────────────────────────────────────────────────
    const all = await read<Probe[]>(FOCUSABLES(".expr-shell")) ?? [];
    const ghosts = all.filter((f) => f.hiddenFrom !== null);
    must(`${c.name}: focus reaches the canvas and every node is a stop`,
      all.filter((f) => f.painted).length >= s.heads.length + s.rows.length,
      `${all.filter((f) => f.painted).length} visible stops for ${s.heads.length + s.rows.length} nodes and rows`);
    pend(`${c.name}: no tab stop sits inside an aria-hidden subtree`, ghosts.length === 0,
      `${ghosts.length} of ${all.length}`, "ACCESS-HANDOFF.md K1");

    // Tab out: a canvas you cannot leave is worse than one you cannot enter.
    await page.locator(".expr-shell .expr-head").first().focus();
    let escaped = false;
    for (let i = 0; i < all.length + 8 && !escaped; i++) {
      await page.keyboard.press("Tab");
      escaped = await page.evaluate(() => {
        const shell = document.querySelector(".expr-shell");
        return shell === null || !shell.contains(document.activeElement);
      });
    }
    must(`${c.name}: focus escapes the canvas by tabbing forward`, escaped,
      escaped ? "no trap" : "TRAPPED");

    // ── the focus indicator ───────────────────────────────────────────────────────────
    // Programmatic focus does not match :focus-visible, so the ring has to be provoked the
    // way a person provokes it: with the Tab key.
    await page.locator(".expr-shell .expr-head").first().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const ind = await read<{
      cls: string; name: string; outlineStyle: string; outlineWidth: number;
      outlineColor: string; shadow: string; paintedWidth: number; zoom: number; inWorld: boolean;
    }>(INDICATOR);
    const hasRing = ind !== null && ((ind.outlineStyle !== "none" && ind.outlineWidth > 0) || ind.shadow !== "");
    must(`${c.name}: a keyboard-focused node paints a focus indicator`, hasRing,
      ind === null ? "no focus" : `${ind.cls} outline ${ind.outlineStyle} ${ind.outlineWidth}px ${ind.outlineColor}`);
    // The ring lives inside the transformed world, so it is the one mark on the surface
    // that scales with the zoom - and the zoom floor is 0.55.
    pend(`${c.name}: the focus ring keeps its 2px at the fitted zoom`,
      ind !== null && ind.paintedWidth >= 1.995,
      ind === null ? "no focus" : `${ind.paintedWidth.toFixed(2)}px at zoom ${ind.zoom.toFixed(2)}`,
      "ACCESS-HANDOFF.md K5");

    // ── operating a node without a pointer ────────────────────────────────────────────
    if (c.name === "fold") {
      await page.locator(".expr-shell .expr-head").first().focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      must("Enter on a node head selects it", await page.locator(".expr-node-on").count() > 0,
        `${await page.locator(".expr-node-on").count()} selected`);

      const before = await focusName();
      const moved: string[] = [];
      for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
        await page.keyboard.press(k);
        await page.waitForTimeout(120);
        const after = await focusName();
        if (after !== before) moved.push(k);
      }
      pend("an arrow key moves between nodes", moved.length > 0,
        moved.length === 0 ? "all four arrows are inert" : moved.join("/"), "ACCESS-HANDOFF.md K2");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
      pend("Escape clears the selection", await page.locator(".expr-node-on").count() === 0,
        `${await page.locator(".expr-node-on").count()} still selected`, "ACCESS-HANDOFF.md K3");

      // open a row's editor from the keyboard and try to use it
      await page.locator(".expr-shell .expr-row").first().focus();
      const rowName = await focusName();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(650);
      const open = await opacityOf(".expr-detail", 0) === "1";
      must("Enter on an operand row opens its value editor", open, open ? "open" : "did not open");
      pend("opening the value editor moves focus into it",
        (await focusName()).includes("expr-field") || (await focusName()).includes("Value"),
        `focus stayed on ${await focusName()}`, "ACCESS-HANDOFF.md K4");
      // How far is the field from the row it belongs to, in tab stops?
      let hops = 0;
      let reached = false;
      for (; hops < all.length + 4 && !reached; hops++) {
        await page.keyboard.press("Tab");
        reached = (await focusName()).includes("expr-field");
      }
      pend("the value editor is the next tab stop after its row", reached && hops <= 1,
        reached ? `${hops} tab stops away from ${rowName}` : "never reached", "ACCESS-HANDOFF.md K4");

      await page.locator(".expr-shell .expr-field").first().focus();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
      pend("Escape closes the value editor", await opacityOf(".expr-detail", 0) !== "1",
        `opacity ${await opacityOf(".expr-detail", 0)}`, "ACCESS-HANDOFF.md K3");
      await page.locator(".expr-shell .expr-field").first().focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      pend("Enter in the value field commits and closes the editor",
        await opacityOf(".expr-detail", 0) !== "1",
        `opacity ${await opacityOf(".expr-detail", 0)}`, "ACCESS-HANDOFF.md K6");

      // Closing a panel while focus is inside it strands the caret in a subtree the page
      // has just told assistive tech to ignore. Chromium says so out loud in the console.
      await page.locator(".expr-shell .expr-field").first().focus();
      const closeBtn = page.locator(".expr-detail .expr-close").first();
      if (await closeBtn.count() > 0) {
        await closeBtn.click({ force: true });
        await page.waitForTimeout(450);
        const stranded = await page.evaluate(() => {
          const a = document.activeElement;
          if (a === null) return false;
          for (let n: Element | null = a; n !== null; n = n.parentElement) {
            if (n.getAttribute("aria-hidden") === "true") return true;
          }
          return false;
        });
        pend("closing the value editor does not strand focus inside it", !stranded,
          stranded ? "focus is inside an aria-hidden subtree" : "focus moved out",
          "ACCESS-HANDOFF.md K4");
      }
    }

    // ── the accessibility tree, read as prose ─────────────────────────────────────────
    if (engine === "chromium" && c.name === "fold") {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Accessibility.enable");
      const tree = await cdp.send("Accessibility.getFullAXTree") as unknown as {
        nodes: { nodeId: string; childIds?: string[]; ignored?: boolean;
          role?: { value: string }; name?: { value: string } }[];
      };
      const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
      const lines: string[] = [];
      const walk = (n: typeof tree.nodes[number], d: number): void => {
        const role = n.role?.value ?? "";
        const name = n.name?.value ?? "";
        const skip = n.ignored === true || role === "none" || role === "generic"
          || role === "InlineTextBox" || role === "LineBreak";
        if (!skip) lines.push(`${"  ".repeat(Math.min(d, 10))}${role}${name ? ` "${name}"` : ""}`);
        for (const id of n.childIds ?? []) { const k = byId.get(id); if (k) walk(k, skip ? d : d + 1); }
      };
      if (tree.nodes[0] !== undefined) walk(tree.nodes[0], 0);
      const first = lines.findIndex((l) => /"(Fold Into|Map Over|Multiply)/.test(l));
      console.log("      the accessibility tree, from the first node card:");
      for (const l of lines.slice(Math.max(0, first), Math.max(0, first) + 22)) console.log(`        ${l}`);
      // The word a fold IS. If the tree cannot say it, the loop is not in the tree.
      const saysLoop = lines.some((l) => /for each/i.test(l));
      pend("the accessibility tree says \"for each\" where the drawing does", saysLoop,
        saysLoop ? "present" : "the band is aria-hidden", "ACCESS-HANDOFF.md S2");
      await cdp.detach();
    }

    const close = page.getByLabel("Close the formula").first();
    if (await close.count() > 0) { await close.click({ force: true }); await page.waitForTimeout(700); }
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("");
if (pendingItems.length > 0) {
  console.log(`${pendingCount} PENDING - each is a real defect with a written fix:`);
  for (const p of pendingItems) console.log(`  ${p}`);
  console.log("");
}
console.log(failures === 0
  ? `canvas-access: 0 failures, ${pendingCount} pending`
  : `canvas-access: ${failures} FAILURE(S), ${pendingCount} pending`);
if (OUT !== "") console.log(`shots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
