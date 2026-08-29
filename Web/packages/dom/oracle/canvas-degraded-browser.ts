// WHAT THE STUDIO DOES WHEN THINGS GO WRONG.
//
// Every check here is a state a real author reaches on an ordinary afternoon: a half-typed
// expression, a body the reader cannot address, a laptop screen, a dev server that died in
// another terminal, a write that lost a race. None of them had ever been looked at. The
// happy path has three oracles; the unhappy path had none, and an editor is judged by the
// unhappy path - a canvas that draws a perfect graph and silently drops an edit is worse
// than one that draws nothing, because the author does not find out until later.
//
// Each case records WHAT HAPPENS TODAY and judges it. A case whose behaviour is already
// wrong is listed in KNOWN with the handoff item that fixes it and reports PENDING: a gate
// that is red the day it lands gets disabled by the next person who sees it. The judgement
// is still run, so the gate bites in both directions:
//
//   · a case KNOWN good that goes bad          -> FAIL (a regression)
//   · a case KNOWN bad that stays bad          -> PENDING (with its handoff item)
//   · a case KNOWN bad that comes good         -> FAIL, asking for its KNOWN row to be
//                                                 deleted. These states are discrete, not
//                                                 timings, so "it got fixed" is a fact worth
//                                                 forcing somebody to write down.
//
//   SHOTS=/tmp/degraded DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-degraded-browser.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright-core";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

// - what today's Studio gets wrong, and what fixes it - //
// Delete a row when its handoff item lands. The check goes live the moment the row is gone.
const KNOWN: Record<string, string> = {
  "body.empty": "DEG-1 - an action with an empty body is not listed in the Logic view at all",
  "read.stale": "DEG-2 - a failed read leaves the previous formula's graph on screen, unlabelled",
  "read.silent": "DEG-2 - a failed read is never mentioned: `<api>.error` is declared and unread",
  "server.dead": "DEG-2 - a dead dev server leaves the last graph on screen and says nothing",
  "write.lands": "DEG-3 - EVERY write from the expression canvas is refused: it spells the op"
    + " key `kind`, the endpoint reads `op`",
  "write.stale": "DEG-4 - a refused write is silent: the panel stays open and the edit is gone",
};

const OUT = process.env["SHOTS"] ?? "";
if (OUT !== "") mkdirSync(OUT, { recursive: true });

// - the project: one document, one body per failure
const root = mkdtempSync(join(tmpdir(), "dsx-degraded-"));
const DOC = "Components/App.dsx";
const docPath = join(root, DOC);
const APP = `<stack style="gap: 1rem; padding: 1.5rem">
  <head>
    <action as="whole">
      return (subtotal + shipping) * 2
    </action>
    <action as="broken">
      return (subtotal + shipping
    </action>
    <action as="halfmap">
      return items.map(i =&gt; i.price *
    </action>
    <action as="opaque">
      return function () { return 1 }
    </action>
    <action as="blank">
    </action>
  </head>
  <text value="Degraded corpus"/>
</stack>
`;
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "deg", scheme: "deg" }),
  "dsx.config.json": JSON.stringify({ name: "Deg", entry: "App", routes: [{ path: "/", component: "deg.App" }] }),
  [DOC]: APP,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

// - the ledger
let failed = 0;
let pending = 0;
const lines: string[] = [];

/** One case: what was observed, and whether that is the right thing. */
function judge(id: string, good: boolean, observed: string, verdict: string): void {
  const known = KNOWN[id];
  if (good && known === undefined) { lines.push(`ok      ${id.padEnd(14)} ${observed}`); return; }
  if (good) {
    failed += 1;
    lines.push(`FIXED   ${id.padEnd(14)} ${observed}`);
    lines.push(`        ${"".padEnd(14)} this case is now correct - delete its KNOWN row so the gate goes live`);
    return;
  }
  if (known !== undefined) {
    pending += 1;
    lines.push(`PENDING ${id.padEnd(14)} ${observed}`);
    lines.push(`        ${"".padEnd(14)} ${verdict}`);
    lines.push(`        ${"".padEnd(14)} -> ${known}`);
    return;
  }
  failed += 1;
  lines.push(`FAIL    ${id.padEnd(14)} ${observed}`);
  lines.push(`        ${"".padEnd(14)} ${verdict}`);
}

// - what the canvas is showing, in one read
type Canvas = {
  mounted: boolean; shown: boolean; cards: number; bar: string; empty: boolean;
  says: string; fieldDisabled: boolean | null; saveShown: boolean; warn: string;
  wrapDisabled: boolean | null;
};
const CANVAS = `(() => {
  const shell = document.querySelector('.expr-shell');
  const vis = (e) => {
    if (e === null) return false;
    for (let n = e; n !== null; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (Number(s.opacity) <= 0.01 || s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  };
  const note = Array.prototype.slice.call(document.querySelectorAll('.editor-note'))
    .filter(vis).map((e) => e.innerText.trim());
  // ANY sentence in the shell that admits something went wrong. Deliberately generous: the
  // question is whether the surface says ANYTHING, not whether it says a particular thing.
  const said = shell === null ? [] : Array.prototype.slice.call(shell.querySelectorAll('*'))
    .filter((e) => e.childElementCount === 0 && vis(e))
    .map((e) => e.innerText || '')
    .filter((t) => /error|failed|could not|cannot|unable|refus|offline|not saved|unreachable|disconnect/i.test(t));
  const field = document.querySelector('.expr-shell input.expr-field');
  const save = Array.prototype.slice.call(document.querySelectorAll('.expr-detail button'))
    .find((b) => b.innerText.trim() === 'Save') || null;
  const wrap = Array.prototype.slice.call(document.querySelectorAll('.expr-shell button'))
    .find((b) => b.innerText.trim() === 'Wrap in') || null;
  const warn = Array.prototype.slice.call(document.querySelectorAll('.expr-warn')).filter(vis)
    .map((e) => e.innerText.trim());
  return JSON.stringify({
    mounted: shell !== null,
    shown: vis(shell),
    cards: document.querySelectorAll('.expr-shell .expr-node').length,
    bar: ((document.querySelector('.expr-bar-source') || {}).innerText || '').trim().slice(0, 70),
    empty: note.some((t) => /Nothing to draw/i.test(t)),
    says: said.join(' | ').slice(0, 120),
    fieldDisabled: field === null ? null : field.disabled,
    saveShown: vis(save),
    warn: warn.join(' ').slice(0, 90),
    wrapDisabled: wrap === null ? null : wrap.disabled,
  });
})()`;

const canvasOf = async (page: Page): Promise<Canvas> => JSON.parse(String(await page.evaluate(CANVAS))) as Canvas;

// - the route an author takes
async function toLogic(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/edit/`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const card = page.locator(".map-name").first();
  if (await card.count() > 0) { await card.click(); await page.waitForTimeout(700); }
  const open = page.getByText("Open in editor", { exact: true });
  if (await open.count() > 0) { await open.first().click(); await page.waitForTimeout(2000); }
  await page.getByRole("button", { name: "Logic view" }).click();
  await page.waitForTimeout(1500);
}

type Opened = { body: boolean; row: boolean; diagram: boolean };
async function openFormula(page: Page, body: string): Promise<Opened> {
  // Scoped to the body list: the same name appears in the row editor's scope list, under
  // the formula surface's own chrome, and a document-wide match clicks the canvas instead.
  const b = page.locator(".logic-bodies").getByText(body, { exact: true }).first();
  if (await b.count() === 0) return { body: false, row: false, diagram: false };
  await b.click();
  await page.waitForTimeout(900);
  const row = page.locator(".logic-row").first();
  if (await row.count() === 0) return { body: true, row: false, diagram: false };
  await row.click();
  await page.waitForTimeout(500);
  const d = page.getByRole("button", { name: "Diagram" }).first();
  if (await d.count() === 0) return { body: true, row: true, diagram: false };
  await d.click();
  await page.waitForTimeout(1600);
  return { body: true, row: true, diagram: true };
}

async function closeFormula(page: Page): Promise<void> {
  const c = page.getByLabel("Close the formula").first();
  if (await c.count() > 0 && await c.isVisible()) { await c.click(); await page.waitForTimeout(600); }
}

const shot = async (page: Page, name: string): Promise<void> => {
  if (OUT === "") return;
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};

// - the run
const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const port = server.port;
const browser: Browser = await launchBrowser(browserEngine());

/** Fresh eyes per scenario: a viewport, a motion preference, an offline switch. */
async function context(opts: Parameters<Browser["newContext"]>[0]): Promise<[BrowserContext, Page]> {
  const c = await browser.newContext(opts);
  const p = await c.newPage();
  return [c, p];
}

try {
  // - 1. the everyday context
  const [ctx, page] = await context({ viewport: { width: 1680, height: 1050 } });
  const seen: { url: string; status: number; reason: string }[] = [];
  page.on("response", (r) => {
    if (!r.url().includes("/edit/api/")) return;
    const row = { url: r.url(), status: r.status(), reason: "" };
    seen.push(row);
    if (r.status() >= 400) {
      void r.text().then((t) => { row.reason = (/"reason"\s*:\s*"([^"]+)"/.exec(t) ?? ["", ""])[1]!; })
        .catch(() => undefined);
    }
  });

  await toLogic(page, port);

  // AN EMPTY BODY. `<action as="blank">` with nothing in it is the state every action is in
  // for the first thirty seconds of its life, which is exactly when a visual editor is worth
  // the most.
  const bodyNames = await page.evaluate(() =>
    Array.prototype.slice.call(document.querySelectorAll(".logic-bodies *"))
      .filter((e) => e.childElementCount === 0)
      .map((e) => (e as HTMLElement).innerText.trim()).filter((t) => t.length > 0));
  judge("body.empty", bodyNames.includes("blank"),
    `Logic view lists ${JSON.stringify(bodyNames)}`,
    "an action the author declared is missing from the list of bodies, so there is no way to"
    + " open the surface that would write its first statement");

  // A GOOD FORMULA FIRST, so the next case has something stale to leave behind.
  const good = await openFormula(page, "whole");
  const goodCanvas = await canvasOf(page);
  await shot(page, "01-good");
  judge("parse.good", good.diagram && goodCanvas.cards > 0 && !goodCanvas.empty,
    `whole: cards=${goodCanvas.cards} bar=${JSON.stringify(goodCanvas.bar)}`,
    "the control case did not draw, so nothing below can be trusted");
  await closeFormula(page);

  // THE EXPRESSION DOES NOT PARSE. Mid-typing is the ordinary state of an expression, and
  // `(subtotal + shipping` is what every one of them looks like a keystroke before it is
  // finished.
  const broke = await openFormula(page, "broken");
  const brokeCanvas = await canvasOf(page);
  await shot(page, "02-unparseable");
  const stale = brokeCanvas.cards > 0 && brokeCanvas.bar === goodCanvas.bar;
  judge("parse.stale", !stale,
    `broken: reachable=${broke.diagram} cards=${brokeCanvas.cards} bar=${JSON.stringify(brokeCanvas.bar)}`
    + ` empty=${brokeCanvas.empty}`,
    "the canvas is showing the PREVIOUS formula's graph under the new formula's name: the"
    + " author reads a drawing of code they are not looking at");
  // WRITABLE IMPLIES BYTE-EXACT. The reader is total: text it cannot name becomes one node
  // holding its own bytes, so the drawing of a half-typed expression is a picture of the
  // text rather than a guess at its structure, and a splice through it replaces exactly
  // those bytes. That is what makes offering the editor here safe - and it is only safe
  // while the round trip is exact, which is the thing to hold.
  const brokeRow = page.locator(".expr-shell .expr-row").first();
  if (await brokeRow.count() > 0) { await brokeRow.click(); await page.waitForTimeout(700); }
  const brokeEdit = await canvasOf(page);
  const brokeExact = await page.evaluate(async (doc: string) => {
    const r = await fetch(`/edit/api/expr/${encodeURIComponent(doc)}?body=action%3Abroken`);
    const j = await r.json() as { exact?: boolean; writable?: boolean };
    return `exact=${j.exact} writable=${j.writable}`;
  }, DOC);
  judge("parse.safewrite", brokeEdit.fieldDisabled !== false || brokeExact.includes("exact=true"),
    `broken: the server says ${brokeExact}; the editor's field is`
    + ` ${brokeEdit.fieldDisabled === false ? "live" : "disabled"}`,
    "the canvas offers to splice bytes through a drawing that does not round-trip");
  await closeFormula(page);

  // A HALF-WRITTEN CALL. Same class, different reader path: this one parses far enough to
  // project something.
  const half = await openFormula(page, "halfmap");
  const halfCanvas = await canvasOf(page);
  await shot(page, "03-half-written");
  judge("parse.partial", half.diagram && (halfCanvas.cards > 0 || halfCanvas.says !== ""),
    `halfmap: cards=${halfCanvas.cards} bar=${JSON.stringify(halfCanvas.bar)} empty=${halfCanvas.empty}`,
    "a partially written call reached the canvas as nothing at all");
  await closeFormula(page);

  // THE DOCUMENT IS READ-ONLY. A body whose projection is not byte-exact cannot be written
  // through the drawing, and the question is whether the affordances are DISABLED or merely
  // refused later.
  await openFormula(page, "opaque");
  const rowTap = page.locator(".expr-shell .expr-row").first();
  if (await rowTap.count() > 0) { await rowTap.click(); await page.waitForTimeout(700); }
  const ro = await canvasOf(page);
  await shot(page, "04-read-only");
  judge("readonly.ui",
    ro.fieldDisabled === true && !ro.saveShown && ro.warn !== "" && ro.wrapDisabled !== false,
    `opaque: field disabled=${ro.fieldDisabled} save shown=${ro.saveShown}`
    + ` wrap disabled=${ro.wrapDisabled} warn=${JSON.stringify(ro.warn)}`,
    "a mutation affordance is live on a surface that will refuse the mutation");
  await closeFormula(page);

  // A BAD ADDRESS. `at`/`to` are body-relative bytes the projection handed out; a drawing
  // that outlived its file hands back bytes that are no longer there. Asked of the endpoint
  // directly, from the page's own origin, because the surface has no way to type one.
  const spans = await page.evaluate(async (doc: string) => {
    const ask = async (q: string): Promise<string> => {
      const r = await fetch(`/edit/api/expr/${encodeURIComponent(doc)}?body=action%3Awhole&${q}`);
      const t = await r.text();
      let j: { reason?: string; nodes?: unknown[] } = {};
      try { j = JSON.parse(t) as typeof j; } catch { /* not JSON */ }
      return `${q} -> ${r.status}${j.reason === undefined ? "" : " " + j.reason}`
        + (Array.isArray(j.nodes) ? ` nodes=${j.nodes.length}` : "");
    };
    return [await ask("at=99999&to=100000"), await ask("at=0&to=999999"), await ask("at=8&to=4")];
  }, DOC);
  const refuses = spans[0]!.includes("400") || spans[0]!.includes("404") || spans[0]!.includes("409");
  judge("span.bad", refuses, `out-of-range span: ${spans.join(" ; ")}`,
    "an address the file cannot contain is answered as a formula with nothing in it, so a"
    + " drawing addressed at bytes that moved looks like an empty expression");

  // A WRITE THAT SHOULD SIMPLY WORK. Everything below assumes the door opens at all; this
  // is the case that asks.
  await openFormula(page, "whole");
  const plainRow = page.locator(".expr-shell .expr-row").first();
  if (await plainRow.count() > 0) { await plainRow.click(); await page.waitForTimeout(700); }
  const plainField = page.locator(".expr-shell input.expr-field").first();
  if (await plainField.count() > 0) {
    await plainField.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("netTotal");
  }
  seen.length = 0;
  const saveOne = page.getByRole("button", { name: "Save" }).first();
  if (await saveOne.count() > 0 && await saveOne.isVisible()) { await saveOne.click(); await page.waitForTimeout(1500); }
  const wrote = seen.filter((r) => r.url.includes("/flowedit/"));
  const landed = readFileSync(docPath, "utf8").includes("netTotal");
  await shot(page, "05-write");
  judge("write.lands", landed,
    `Save sent ${wrote.length} write${wrote.length === 1 ? "" : "s"}, answered`
    + ` ${wrote.map((r) => `${r.status}${r.reason === "" ? "" : " " + r.reason}`).join(",") || "nothing"};`
    + ` the file ${landed ? "carries the edit" : "is unchanged"}`,
    "the Save button on the expression canvas cannot write: the payload names the operation"
    + " `kind` and the endpoint reads `op`, so every edit is refused as malformed");
  writeFileSync(docPath, APP);
  await page.waitForTimeout(500);
  await closeFormula(page);

  // A WRITE REFUSED AS STALE. Two edits against one revision is what two tabs, or one tab
  // and one text editor, produce in the ordinary course of a day.
  await openFormula(page, "whole");
  const editRow = page.locator(".expr-shell .expr-row").first();
  if (await editRow.count() > 0) { await editRow.click(); await page.waitForTimeout(700); }
  const before = readFileSync(docPath, "utf8");
  // the other tab's edit: the file moves under the drawing
  writeFileSync(docPath, before.replace("(subtotal + shipping) * 2", "(subtotal + shipping) * 3"));
  await page.waitForTimeout(400);
  const field = page.locator(".expr-shell input.expr-field").first();
  if (await field.count() > 0) {
    await field.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("999");
  }
  seen.length = 0;
  const save = page.getByRole("button", { name: "Save" }).first();
  if (await save.count() > 0 && await save.isVisible()) { await save.click(); await page.waitForTimeout(1400); }
  const afterSave = await canvasOf(page);
  await shot(page, "06-stale-write");
  const flowedit = seen.filter((r) => r.url.includes("/flowedit/"));
  const refused = flowedit.map((r) => `${r.status}${r.reason === "" ? "" : " " + r.reason}`);
  const onDisk = readFileSync(docPath, "utf8");
  const kept = onDisk.includes("* 3");
  const saidSomething = afterSave.says !== "";
  judge("write.stale", saidSomething,
    `flowedit answered ${refused.join(",") || "nothing"}; the file still reads ${kept ? "the other tab's edit" : "SOMETHING ELSE"};`
    + ` the surface says ${saidSomething ? JSON.stringify(afterSave.says) : "nothing"}`,
    "the write was refused and the author was not told: the panel stays open with the typed"
    + " value in it and nothing on screen distinguishes that from a save that worked");
  judge("write.nolose", kept, `the refused write left the file at ${kept ? "the other edit" : "a clobbered state"}`,
    "a refused write must never reach the file");
  writeFileSync(docPath, APP);
  await page.waitForTimeout(500);
  await closeFormula(page);
  await ctx.close();

  // - 2. small screens -   //
  // The Studio's own breakpoint is 1493px and its panels are declared in absolute pixels; a
  // 1280 and a 1024 laptop are the two commonest screens an author will open it on.
  for (const [w, h] of [[1280, 800], [1024, 768]] as const) {
    const [c2, p2] = await context({ viewport: { width: w, height: h } });
    await toLogic(p2, port);
    await openFormula(p2, "whole");
    const small = await p2.evaluate(() => {
      const shell = document.querySelector(".expr-shell");
      const box = shell === null ? null : shell.getBoundingClientRect();
      // INK UNDER CHROME. The bar, the value editor and the zoom cluster float over the
      // world and do not pan, so on a short viewport they sit on top of the drawing rather
      // than beside it. elementFromPoint is the only test that catches it.
      const covered: string[] = [];
      for (const t of Array.prototype.slice.call(document.querySelectorAll(".expr-title, .expr-well-text, .expr-row-name"))) {
        const r = t.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
        if (top === null || top === t || t.contains(top) || top.contains(t)) continue;
        const chrome = top.closest(".expr-bar, .expr-detail, .flow-cluster, .editor-rail, .inspect, .tree");
        covered.push((chrome === null ? "" : "chrome:") + String(top.className).slice(0, 30));
      }
      return {
        w: box === null ? 0 : Math.round(box.width), h: box === null ? 0 : Math.round(box.height),
        cards: document.querySelectorAll(".expr-shell .expr-node").length,
        overflow: document.documentElement.scrollWidth - innerWidth,
        covered: covered.slice(0, 6), coveredN: covered.length,
        chromeCovered: covered.filter((s) => s.startsWith("chrome:")).length,
      };
    });
    await shot(p2, `07-viewport-${w}x${h}`);
    judge(`viewport.${w}`,
      small.w > 320 && small.h > 240 && small.overflow <= 1 && small.chromeCovered === 0,
      `${w}x${h}: canvas ${small.w}x${small.h} cards=${small.cards} pageOverflow=${small.overflow}px`
      + ` inkUnderChrome=${small.chromeCovered}${small.covered.length === 0 ? "" : " " + JSON.stringify(small.covered)}`,
      "the work is underneath the chrome, or the page scrolls sideways, at a size an author"
      + " will actually open the Studio on");
    await c2.close();
  }

  // - 3. reduced motion -   //
  // The sheet carries a transition on 140 elements of this one surface. Under a stated
  // preference for stillness they have to stop, and the kernel zeroing its own duration
  // tokens only reaches the rules that spell their duration with one.
  {
    const [c3, p3] = await context({ viewport: { width: 1680, height: 1050 }, reducedMotion: "reduce" });
    await toLogic(p3, port);
    await openFormula(p3, "whole");
    const motion = await p3.evaluate(() => {
      const shell = document.querySelector(".expr-shell");
      const moving: string[] = [];
      let animated = 0;
      for (const e of Array.prototype.slice.call(shell === null ? [] : shell.querySelectorAll("*"))) {
        const s = getComputedStyle(e);
        const dur = s.transitionDuration.split(",").map((t) => parseFloat(t) || 0);
        if (Math.max(0, ...dur) > 0) moving.push(String(e.className).split(" ")[1] ?? e.tagName.toLowerCase());
        if (s.animationName !== "none" && parseFloat(s.animationDuration) > 0) animated += 1;
      }
      return { moving: [...new Set(moving)].slice(0, 8), n: moving.length, animated };
    });
    await shot(p3, "08-reduced-motion");
    judge("motion.reduce", motion.n === 0 && motion.animated === 0,
      `reduce: ${motion.n} elements still carry a transition, ${motion.animated} an animation`
      + `${motion.moving.length === 0 ? "" : " e.g. " + JSON.stringify(motion.moving)}`,
      "a stated preference for stillness is not honoured on this surface");
    await c3.close();
  }

  // - 4. offline -   //
  // The Studio is a hosted web surface. A drop between a read and a write is the ordinary
  // failure of a hosted surface, and it has to be distinguishable from an empty answer.
  {
    const [c4, p4] = await context({ viewport: { width: 1680, height: 1050 } });
    await toLogic(p4, port);
    await openFormula(p4, "whole");
    await closeFormula(p4);
    await c4.setOffline(true);
    const off = await openFormula(p4, "halfmap");
    const offCanvas = await canvasOf(p4);
    await shot(p4, "09-offline");
    judge("read.stale", offCanvas.cards === 0 || offCanvas.bar.includes("i.price"),
      `offline: reachable=${off.diagram} cards=${offCanvas.cards} bar=${JSON.stringify(offCanvas.bar)}`
      + ` empty=${offCanvas.empty}`,
      "the read never landed and the canvas is still drawing the LAST formula, titled with"
      + " the new one: the author is reading a picture of different code");
    judge("read.silent", offCanvas.says !== "",
      `offline: the surface says ${offCanvas.says === "" ? "nothing about the failure" : JSON.stringify(offCanvas.says)}`,
      "`<api>` publishes `.error{status,message}` and fires `on:error`; EditorExpression reads"
      + " neither, so a network failure is indistinguishable from a formula that did not change");
    await c4.setOffline(false);
    await c4.close();
  }

  // - 5. the dev server dies -   //
  // Last, because it is the end of the session by construction. Ctrl-C in the other terminal
  // is how most Studio sessions end, and some of them end that way by accident.
  {
    const [c5, p5] = await context({ viewport: { width: 1680, height: 1050 } });
    await toLogic(p5, port);
    await openFormula(p5, "whole");
    await closeFormula(p5);
    await server.close();
    await p5.waitForTimeout(600);
    const dead = await openFormula(p5, "halfmap");
    const deadCanvas = await canvasOf(p5);
    await shot(p5, "10-server-dead");
    judge("server.dead", deadCanvas.says !== "" || deadCanvas.cards === 0,
      `server closed: reachable=${dead.diagram} cards=${deadCanvas.cards}`
      + ` bar=${JSON.stringify(deadCanvas.bar)} says=${JSON.stringify(deadCanvas.says)}`,
      "nothing on screen says the editor lost its backend: the last graph stays up and the"
      + " surface keeps offering Save for writes that cannot land");
    await c5.close();
  }
} finally {
  await browser.close();
  try { await server.close(); } catch { /* already closed by the last case */ }
  rmSync(root, { recursive: true, force: true });
}

console.log("degraded states of the expression canvas\n");
for (const l of lines) console.log(l);
console.log(`\n${failed} failed, ${pending} pending`);
if (OUT !== "") console.log(`shots in ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
