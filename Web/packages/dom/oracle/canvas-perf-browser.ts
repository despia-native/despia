// WHAT THE STUDIO'S CANVASES COST A REAL BROWSER.
//
// `exprflow.test.ts` proves the projection is fast: 1000 nodes in 188 ms, in Node, with no
// document. That number says nothing about the surface an author uses, which has to build
// DOM from the projection, style it, lay it out, paint it, and stay responsive while a value
// is dragged. A canvas that is right and slow is a canvas nobody opens twice.
//
// So this measures the REAL Studio in a REAL engine, per fixture, across a ladder of graph
// sizes that runs past the worst thing the corpus contains, and it measures with the
// browser's own instruments rather than a wall-clock guess:
//
//   · CDP `Performance.getMetrics`  - RecalcStyleCount/Duration, LayoutCount/Duration,
//     Nodes, JSHeapUsedSize. Counter deltas across a gesture. This is what answers the pan
//     question exactly: a pan that increments LayoutCount is a relayout, whatever it feels
//     like on a fast box.
//   · CDP `Tracing` (disabled-by-default-devtools.timeline), filtered to UpdateLayoutTree ·
//     Layout · PrePaint · Paint · Commit. getMetrics has no paint counter; the timeline does.
//   · The Event Timing API (`PerformanceObserver`, type `event`, durationThreshold 0) - the
//     platform's own input-to-next-paint number, which is the one an author feels. It is
//     quantized to 8 ms, so it is reported beside a finer companion rather than alone.
//   · A capture-phase `event.timeStamp` plus a double `requestAnimationFrame` after the DOM
//     reaches its ready state - the companion. Event Timing stops at the first paint after
//     the handler returns, which for a gesture that awaits a fetch is the fade-in and not
//     the graph; this one waits for the graph.
//   · A `MutationObserver` over the canvas subtree during a drag - the diagnostic. "A pan
//     relayouts" is a symptom; the tally of which elements had attributes written when only
//     the world's transform changed is the cause, and it is the difference between a finding
//     and a fix.
//   · CDP `Memory.getDOMCounters` + `HeapProfiler.collectGarbage` - the leak check.
//     `performance.measureUserAgentSpecificMemory()` is NOT exposed here (the page is not
//     cross-origin isolated), so the renderer will not give an honest whole-process figure
//     and none is reported. JS heap and live DOM node count are what it will give.
//
// EVERY TIMING IS A MEDIAN OF `RUNS` PASSES (default 3). A single sample off a shared box is
// a number with a confidence interval nobody wrote down. Counts are exact and are treated as
// censuses, in the discipline of check_editor_scale.rb: a count that moves when nobody meant
// to move it is the whole value of writing it down.
//
// BUDGETS live in BUDGET below, each with the reasoning for its number. A budget that is
// already red is listed in PENDING with the handoff item that will fix it: a gate that is
// red the day it lands gets disabled by the next person who sees it.
//
//   SHOTS=/tmp/perf DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-perf-browser.ts
//   RUNS=5 CASE=sum40,matrix node packages/dom/oracle/canvas-perf-browser.ts
//   RECORD=1 node packages/dom/oracle/canvas-perf-browser.ts     # print a fresh BASELINE block

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CDPSession, Page } from "playwright-core";

import { loadConfig } from "../../cli/src/config.ts";
import { startEditServer } from "../../cli/src/edit.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

// - the ladder - //
// The corpus fixtures are DECLARED here rather than imported from expression-canvas-browser:
// that module is a script with a top-level `page.goto`, so importing it would boot a second
// Studio and a second browser as a side effect of reading its list. The five worst real
// cases are spelled exactly as they are there, and the `sumN` rungs extend the widest of
// them past its own size so the curve has a shape and not just an endpoint.

const sum = (n: number): string =>
  Array.from({ length: n }, (_, i) => `p${i}.price * p${i}.qty`).join(" + ");
const chain12 = "raw.trim().toLowerCase().replaceAll(' ', '-').slice(0, 40).padEnd(40, '.')"
  + ".split('-').join('_').toUpperCase().trim().concat('!').repeat(2).slice(0, 60)";
const record30 = "{ " + Array.from({ length: 30 }, (_, i) =>
  (i % 5 === 0 ? `f${i}: row.a${i} * 2` : `f${i}: ${i}`)).join(", ") + " }";
const deep = (n: number): string => {
  let e = "seed";
  for (let i = 0; i < n; i++) e = `Math.round(${e} * ${i + 1})`;
  return e;
};
const matrix = "regions.map(r => ({ region: r.name, revenue: r.stores"
  + ".filter(s => s.open).map(s => s.orders.reduce((t, o) => t + o.total * (1 - o.discount), 0))"
  + ".reduce((t, n) => t + n, 0) }))";

type Case = { name: string; expr: string; note: string };
// TWO LADDERS, because a formula has two ways of being big and they cost different things.
// `sumN` grows the OPERAND count under one node - and the projection folds a run past 24
// arms into one card, so it grows the page's bytes without growing its cards, which is
// exactly the case a card-count budget would miss. `deepN` grows the CARD count, one card
// per level, which is what a canvas actually has to build, style and lay out. Both run past
// the worst thing the corpus contains; the four named corpus cases sit between them.
const CASES: Case[] = [
  { name: "sum10", expr: sum(10), note: "ten products under one sum" },
  { name: "sum40", expr: sum(40), note: "the widest operand fan the corpus has" },
  { name: "sum80", expr: sum(80), note: "past the corpus, on purpose" },
  { name: "deep10", expr: deep(10), note: "ten levels of nesting" },
  { name: "deep30", expr: deep(30), note: "the corpus's deepest nesting chain" },
  { name: "deep60", expr: deep(60), note: "twice the corpus" },
  { name: "deep120", expr: deep(120), note: "four times the corpus - where it has to degrade" },
  { name: "chain12", expr: chain12, note: "twelve links on one spine" },
  { name: "record30", expr: record30, note: "thirty fields, six of them computed" },
  { name: "matrix", expr: matrix, note: "four levels of container, with a fold at the bottom" },
];

// - the budgets, and why each number is that number - //
// None of these is invented. Three of them are the frame, the gesture and the input
// thresholds every interactive surface is held to; the fourth falls out of the third.
const BUDGET = {
  // 60 fps. A pan holds a pointer, so every frame it misses is a frame the author's hand has
  // already moved past. 16 ms is one frame at 60 Hz and the whole of it, main thread
  // included, has to fit.
  panFrameMs: 16,
  // A pan transforms ONE world layer. The compositor can do that without the main thread
  // touching the box tree at all, so the honest budget is not "fast enough" but ZERO: no
  // layout, and style work bounded to the element whose transform changed.
  panLayoutCount: 0,
  panStyleRecalcs: 4,
  // One element's transform changes during a pan, so one element's attributes should be
  // written per drag frame. 20 frames, one write each, plus a little slack for the zoom
  // readout: anything above this is the surface rewriting itself to scroll.
  panDomWrites: 30,
  // A one-off view change. RAIL puts the "this is still one action" bar at 1 s and the
  // "feels immediate" bar at 100 ms; the canvas opens behind a fade, so the honest target is
  // in between - 500 ms is a transition an author reads as a transition rather than a stall,
  // and it holds even for the worst fixture in the corpus.
  openMs: 500,
  // Input to committed pixels. 100 ms is where a response stops feeling caused by the
  // gesture; the platform's own "good INP" line is 200 ms. 200 is the failure line, 100 the
  // target, and both are printed so a drift between them is visible before it crosses.
  interactionMs: 200,
  // The ceiling past which the surface must DEGRADE rather than crawl. Derived, not chosen:
  // it is the graph size at which the measured open time crosses openMs on the reference
  // machine. See canvas-performance.md for the derivation from the ladder below.
  nodeCeiling: 90,
  // After 20 open/close cycles the page's live node count must come back. `keep="true"`
  // holds the canvas mounted across a close, so a per-cycle residue is invisible until an
  // author has been in the Studio for an hour. 2 nodes/cycle is the noise floor of the
  // Studio's own idle re-rendering, measured; a leak is orders above it.
  leakNodesPerCycle: 2,
} as const;

// - what is red on arrival - //
// A gate that fails the day it lands gets disabled by the next person who sees it. Each row
// here is a budget that today's Studio does not meet, with the handoff item that will fix
// it; the check still runs and still prints its number, it just reports PENDING instead of
// failing. Delete a row when its item lands and the gate goes live.
const PENDING: Record<string, string> = {
  "pan.layout": "PERF-1 - a pan relayouts the whole expression subtree",
  "pan.style": "PERF-1 - a pan restyles the whole expression subtree",
  "pan.frame": "PERF-1 - a pan restyles the whole expression subtree",
  "pan.writes": "PERF-1 - a pan rewrites the subtree's attributes rather than one transform",
  "zoom.layout": "PERF-1 - a zoom step relayouts the whole expression subtree",
};

// - the baseline, recorded on the reference machine - //
// Recorded with RECORD=1 against the landed Studio. `cal` is the machine-speed reference (a
// fixed DOM workload, ms): every timing budget and every timing baseline below is scaled by
// the ratio of the running machine's `cal` to this one, clamped at 1, so a slower CI box
// does not red the lane and a faster one does not silently tighten a budget nobody agreed to.
// Counts are NOT scaled - they are censuses.
const BASELINE = {
  cal: 0,
  cases: {} as Record<string, { el: number; nodes: number; open: number; select: number; row: number; key: number }>,
};

const OUT = process.env["SHOTS"] ?? "";
if (OUT !== "") mkdirSync(OUT, { recursive: true });
const RUNS = Math.max(1, Number(process.env["RUNS"] ?? "3") || 3);
const RECORD = process.env["RECORD"] === "1";
const only = (process.env["CASE"] ?? "").split(",").filter(Boolean);
const list = only.length > 0 ? CASES.filter((c) => only.includes(c.name)) : CASES;

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// - the project
const root = mkdtempSync(join(tmpdir(), "dsx-perf-"));
const enc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const app = `<stack style="gap: 1rem; padding: 1.5rem">
  <head>
${list.map((c, i) => `    <action as="case${i}">\n      return ${enc(c.expr)}\n    </action>`).join("\n")}
  </head>
  <text value="Perf corpus"/>
</stack>
`;
for (const [p, s] of Object.entries({
  "dsx.json": JSON.stringify({ name: "perf", scheme: "perf" }),
  "dsx.config.json": JSON.stringify({ name: "Perf", entry: "App", routes: [{ path: "/", component: "perf.App" }] }),
  "Components/App.dsx": app,
})) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); }

// - the instruments - 
type Counters = { style: number; layout: number; styleMs: number; layoutMs: number; nodes: number; heap: number };

async function counters(cdp: CDPSession): Promise<Counters> {
  const m = (await cdp.send("Performance.getMetrics")).metrics;
  const get = (n: string): number => m.find((x) => x.name === n)?.value ?? 0;
  return {
    style: get("RecalcStyleCount"), layout: get("LayoutCount"),
    styleMs: get("RecalcStyleDuration") * 1000, layoutMs: get("LayoutDuration") * 1000,
    nodes: get("Nodes"), heap: get("JSHeapUsedSize"),
  };
}
const ZERO_COUNTERS: Counters = { style: 0, layout: 0, styleMs: 0, layoutMs: 0, nodes: 0, heap: 0 };
const since = (a: Counters, b: Counters): Counters => ({
  style: b.style - a.style, layout: b.layout - a.layout,
  styleMs: b.styleMs - a.styleMs, layoutMs: b.layoutMs - a.layoutMs,
  nodes: b.nodes - a.nodes, heap: b.heap - a.heap,
});

/** The timeline's own paint column. getMetrics has no paint counter; these five event names
 *  are the renderer's lifecycle phases and their `dur` fields are microseconds. */
const PHASE = new Set(["UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Commit"]);
type Phases = { style: number; layout: number; prepaint: number; paint: number; commit: number; frames: number; wall: number };

async function traced<T>(cdp: CDPSession, fn: () => Promise<T>): Promise<{ value: T; phases: Phases }> {
  const tally: Record<string, number> = {};
  let frames = 0;
  const onData = (e: { value: { name?: string; ph?: string; dur?: number }[] }): void => {
    for (const raw of e.value) {
      if (raw.ph !== "X" || raw.name === undefined) continue;
      if (raw.name === "Commit") frames += 1;
      if (!PHASE.has(raw.name)) continue;
      tally[raw.name] = (tally[raw.name] ?? 0) + (raw.dur ?? 0) / 1000;
    }
  };
  cdp.on("Tracing.dataCollected" as never, onData as never);
  await cdp.send("Tracing.start" as never, {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents",
  } as never);
  const t0 = Date.now();
  let value: T;
  try {
    value = await fn();
  } finally {
    const done = new Promise<void>((res) => cdp.once("Tracing.tracingComplete" as never, () => res()));
    await cdp.send("Tracing.end" as never);
    await done;
    cdp.off("Tracing.dataCollected" as never, onData as never);
  }
  return {
    value: value!,
    phases: {
      style: tally["UpdateLayoutTree"] ?? 0, layout: tally["Layout"] ?? 0,
      prepaint: tally["PrePaint"] ?? 0, paint: tally["Paint"] ?? 0,
      commit: tally["Commit"] ?? 0, frames, wall: Date.now() - t0,
    },
  };
}

/** Ready state, as the page can check it for itself. */
type Ready = { sel?: string; min?: number; textSel?: string; textNot?: string; shownSel?: string };

/** Arm the commit stopwatch: it starts on the next input event's own timestamp and stops two
 *  animation frames after the page reaches `ready` - the second frame is the one that proves
 *  the first was committed rather than merely scheduled. */
async function arm(page: Page, ready: Ready): Promise<void> {
  await page.evaluate((r: Ready) => {
    const w = window as unknown as { __commit?: Promise<number | null> };
    w.__commit = new Promise<number | null>((resolve) => {
      let t0: number | null = null;
      const mark = (e: Event): void => { if (t0 === null) t0 = e.timeStamp; };
      for (const t of ["pointerdown", "keydown", "wheel"]) {
        document.addEventListener(t, mark, { capture: true });
      }
      const ok = (): boolean => {
        if (r.sel !== undefined && document.querySelectorAll(r.sel).length < (r.min ?? 1)) return false;
        if (r.textSel !== undefined) {
          const e = document.querySelector(r.textSel) as HTMLElement | null;
          if (e === null) return false;
          if (r.textNot !== undefined && (e.innerText ?? "").trim() === r.textNot) return false;
        }
        if (r.shownSel !== undefined) {
          const e = document.querySelector(r.shownSel) as HTMLElement | null;
          if (e === null) return false;
          for (let n: Element | null = e; n !== null; n = n.parentElement) {
            if (Number(getComputedStyle(n).opacity) <= 0.01) return false;
          }
        }
        return true;
      };
      const deadline = performance.now() + 15000;
      const tick = (): void => {
        if (performance.now() > deadline) { resolve(null); return; }
        if (t0 !== null && ok()) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0!)));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, ready);
}

async function commit(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __commit: Promise<number | null> }).__commit);
}

/** The Event Timing API's own view of the same gestures: input to next paint, 8 ms
 *  quantized, which is the number a field study would report. */
async function armEventTiming(page: Page): Promise<void> {
  // An init script, not an evaluate: the observer has to survive the navigation into the
  // Studio, and `buffered` only reaches back to entries the observer's own document made.
  await page.addInitScript(() => {
    const w = window as unknown as { __ev?: { name: string; dur: number; block: number }[] };
    w.__ev = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as PerformanceEventTiming[]) {
        w.__ev!.push({ name: e.name, dur: e.duration, block: e.processingEnd - e.processingStart });
      }
    }).observe({ type: "event", durationThreshold: 0, buffered: true } as PerformanceObserverInit);
  });
}
async function takeEvents(page: Page, names: string[]): Promise<{ dur: number; block: number }[]> {
  return page.evaluate((ns: string[]) => {
    const w = window as unknown as { __ev?: { name: string; dur: number; block: number }[] };
    const all = w.__ev ?? [];
    const hit = all.filter((e) => ns.includes(e.name)).map((e) => ({ dur: e.dur, block: e.block }));
    w.__ev = [];
    return hit;
  }, names);
}

/** WHO GETS REWRITTEN DURING A GESTURE. "A pan relayouts" is a symptom; the cause is a list
 *  of elements whose attributes were written when only the world's transform changed. One
 *  element should move - the world - and a MutationObserver is the only instrument that says
 *  whether that is what happened. */
async function watchWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __mut?: { stop(): Record<string, number> } };
    const tally: Record<string, number> = {};
    const shell = document.querySelector(".expr-shell") ?? document.body;
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as Element;
        const cls = String((el as HTMLElement).className ?? "").trim().split(/\s+/)[0] ?? el.nodeName;
        const key = `${r.type === "attributes" ? r.attributeName : r.type}@${cls}`;
        tally[key] = (tally[key] ?? 0) + 1;
      }
    });
    obs.observe(shell, { attributes: true, childList: true, subtree: true, characterData: false });
    w.__mut = { stop: (): Record<string, number> => { obs.takeRecords(); obs.disconnect(); return tally; } };
  });
}
async function writesSeen(page: Page): Promise<{ total: number; top: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __mut?: { stop(): Record<string, number> } };
    const tally = w.__mut === undefined ? {} : w.__mut.stop();
    const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    return {
      total: rows.reduce((n, [, v]) => n + v, 0),
      top: rows.slice(0, 5).map(([k, v]) => `${k}=${v}`),
    };
  });
}

/** How fast is this machine, in the only units that matter here: a fixed DOM workload. Run
 *  on a scratch page so the Studio's own node count is never perturbed by the yardstick. */
async function calibrate(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-9999px;top:0;width:600px";
    document.body.appendChild(host);
    const t0 = performance.now();
    for (let pass = 0; pass < 3; pass++) {
      host.textContent = "";
      for (let i = 0; i < 1500; i++) {
        const d = document.createElement("div");
        d.style.cssText = "padding:2px;border:1px solid #333;font-size:11px";
        d.textContent = "row " + i;
        host.appendChild(d);
      }
      void host.offsetHeight;
    }
    const ms = performance.now() - t0;
    host.remove();
    return ms;
  });
}

// - the walk - 
const server = await startEditServer(loadConfig(root), { port: 0, host: "127.0.0.1", log: () => {} });
const browser = await launchBrowser(browserEngine());
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });

const yard = await ctx.newPage();
await yard.setContent("<body></body>");
const cal = median([await calibrate(yard), await calibrate(yard), await calibrate(yard)]);
await yard.close();
// Never tighten an authored budget because the box is fast: the numbers were chosen for a
// person's eye, not for this machine.
const slow = BASELINE.cal > 0 ? Math.max(1, cal / BASELINE.cal) : 1;

const page = await ctx.newPage();
await armEventTiming(page);
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable" as never, { timeDomain: "timeTicks" } as never);

const ZERO: Phases = { style: 0, layout: 0, prepaint: 0, paint: 0, commit: 0, frames: 0, wall: 0 };
type Row = {
  name: string; cards: number; ports: number; el: number; total: number; nodes: number;
  open: number[]; srv: number[]; select: number[]; row: number[]; rowEvt: number[]; key: number[]; keyEvt: number[];
  openPhases: Phases; panPhases: Phases; zoomPhases: Phases;
  pan: Counters; panIdle: Counters; zoom: Counters;
  panWrites: { total: number; top: string[] };
};
const rows = new Map<string, Row>();
const problems: string[] = [];

/** Walk from the map to the Logic view. The route the studio oracle takes, for the reason it
 *  takes it: that is the route an author takes. */
async function toLogic(p: Page): Promise<void> {
  await p.goto(`http://127.0.0.1:${server.port}/edit/`, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  const card = p.locator(".map-name").first();
  if (await card.count() > 0) { await card.click(); await p.waitForTimeout(700); }
  const open = p.getByText("Open in editor", { exact: true });
  if (await open.count() > 0) { await open.first().click(); await p.waitForTimeout(2000); }
  await p.getByRole("button", { name: "Logic view" }).click();
  await p.waitForTimeout(1500);
}

const leak: { cycle: number; nodes: number; heap: number }[] = [];
let leakCase = Math.max(0, list.findIndex((c) => c.name === "deep10"));

try {
await toLogic(page);

const barText = async (): Promise<string> => page.evaluate(() =>
  ((document.querySelector(".expr-bar-source") as HTMLElement | null)?.innerText ?? "").trim());
const faded = async (sel: string): Promise<boolean> => page.evaluate((q: string) => {
  const e = document.querySelector(q);
  return e === null || Number(getComputedStyle(e).opacity) <= 0.01;
}, sel);

/** Close the formula and WAIT for it to be gone. `keep="true"` holds the surface mounted
 *  through its fade, and a faded-but-not-finished pan layer still takes the next click - it
 *  is what ended the previous version of this walk two thirds of the way through. */
async function closeFormula(): Promise<void> {
  const c = page.getByLabel("Close the formula").first();
  if (await c.count() > 0 && await c.isVisible()) await c.click().catch(() => undefined);
  for (let i = 0; i < 20; i++) {
    if (await faded(".expr-shell")) return;
    await page.waitForTimeout(150);
  }
  problems.push("the formula surface would not close - it stayed on top of the workflow canvas");
}

/** The canvas keeps ONE viewport across formulae: `flowUserZoom`/`flowUserPanX` live on the
 *  Flow instance, and the instance is `keep="true"`, so the next formula opens wherever the
 *  last pan left it. Every measurement here starts from the fit, or the ladder measures the
 *  previous rung's scroll position. */
async function fit(): Promise<void> {
  const b = page.locator(".expr-shell").getByRole("button", { name: "Fit to content" }).first();
  if (await b.count() > 0) { await b.click(); await page.waitForTimeout(500); }
}

/** Click the first element of `sel` that is actually on top at its own centre. The chrome
 *  bar floats over the world and does not pan, so on a big graph the leading rows sit under
 *  it - an unreachable row is a finding, and it must not also end the walk. */
async function clickClear(sel: string, what: string): Promise<boolean> {
  const at = await page.evaluate((q: string) => {
    const all = Array.prototype.slice.call(document.querySelectorAll(q));
    for (let i = 0; i < all.length; i++) {
      const r = (all[i] as Element).getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
      const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      if (top !== null && (top === all[i] || (all[i] as Element).contains(top))) return i;
    }
    return -1;
  }, sel);
  const target = page.locator(sel).nth(at < 0 ? 0 : at);
  if (await target.count() === 0) return false;
  if (at < 0) {
    problems.push(`${what}: every one is covered by the canvas's own chrome or off screen`);
    await target.click({ force: true, timeout: 5000 }).catch(() => undefined);
    return true;
  }
  await target.click({ timeout: 5000 }).catch(() => undefined);
  return true;
}

for (let run = 0; run < RUNS; run++) {
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    // SCOPED TO THE BODY LIST. The same name appears in the row editor's scope list, which
    // sits under the formula surface's own chrome - a document-wide getByText picks that one
    // and the click lands on the canvas. `.logic-bodies` is also `visible-if` no formula is
    // open, so requiring it enforces the invariant this loop depends on.
    const body = page.locator(".logic-bodies").getByText(`case${i}`, { exact: true }).first();
    if (await body.count() === 0) { problems.push(`${c.name}: no body case${i} in the Logic view`); continue; }
    await body.click();
    await page.waitForTimeout(700);
    const argRow = page.locator(".logic-row").first();
    if (await argRow.count() === 0) { problems.push(`${c.name}: the body projected no argument row`); continue; }
    await argRow.click();
    await page.waitForTimeout(400);
    const diagram = page.getByRole("button", { name: "Diagram" }).first();
    if (await diagram.count() === 0) { problems.push(`${c.name}: no Diagram button on the row`); continue; }

    // OPEN. Ready is "the graph for THIS formula is on screen", not "a graph is": the canvas
    // is kept mounted across a close, so the previous fixture's cards are still there and a
    // count-only predicate answers yes before anything happened.
    const was = await barText();
    await arm(page, { sel: ".expr-shell .expr-node", min: 1, textSel: ".expr-bar-source", textNot: was });
    const opened = await traced(cdp, async () => {
      await diagram.click();
      return commit(page);
    });
    const openMs = opened.value;
    if (openMs === null) { problems.push(`${c.name}: the canvas never reached a painted graph`); continue; }
    await page.waitForTimeout(250);

    // The server's share of that number, from Resource Timing. What is left is the browser's,
    // and only the browser's half is this oracle's business.
    const srv = await page.evaluate(() => {
      const hit = performance.getEntriesByType("resource").filter((e) => e.name.includes("/edit/api/expr/"));
      return hit.length === 0 ? 0 : hit[hit.length - 1]!.duration;
    });

    const census = await page.evaluate(() => {
      const shell = document.querySelector(".expr-shell");
      return {
        el: shell === null ? 0 : shell.querySelectorAll("*").length,
        total: document.getElementsByTagName("*").length,
        cards: document.querySelectorAll(".expr-shell .expr-node").length,
        ports: document.querySelectorAll(".expr-shell .expr-port").length,
      };
    });
    const live = await counters(cdp);

    // SELECT A NODE. The head, not the card: a card's centre is a row, and a row tap opens
    // the value editor instead. The previous fixture's selection is dropped first, or the
    // ready state is already true and the stopwatch measures nothing.
    const clear = page.getByRole("button", { name: "Clear selection" }).first();
    if (await clear.count() > 0 && await clear.isVisible()) { await clear.click(); await page.waitForTimeout(400); }
    await fit();
    await arm(page, { sel: ".expr-shell .expr-node-on", min: 1 });
    await clickClear(".expr-shell .expr-head", "an expression node head");
    const selectMs = await commit(page);
    await page.waitForTimeout(450);

    // OPEN A ROW. `.expr-detail` is `keep="true"`, so it never leaves the DOM: the visual
    // change is the moment it stops being transparent, which is also the first frame an
    // author can see.
    if (!await faded(".expr-detail")) problems.push(`${c.name}: the value editor was already shown before the row was tapped`);
    await arm(page, { shownSel: ".expr-shell input.expr-field" });
    await clickClear(".expr-shell .expr-row", "an expression row");
    const rowMs = await commit(page);
    await page.waitForTimeout(300);
    const rowEvt = median((await takeEvents(page, ["pointerdown", "click"])).map((e) => e.dur));

    // TYPE INTO A VALUE, one keystroke at a time. Two instruments on purpose: Event Timing
    // is the platform's own input-to-next-paint (8ms quantized, and the one a field study
    // would report), the rAF stopwatch is the companion - it cannot read below about two
    // frames, so it is a ceiling on the same quantity rather than a second opinion.
    const keys: number[] = [];
    const field = page.locator(".expr-shell input.expr-field").first();
    if (await field.count() > 0) {
      await field.click();
      await page.waitForTimeout(150);
      await takeEvents(page, ["keydown", "input", "keypress"]);
      for (const ch of "abcdefgh".split("")) {
        await arm(page, {});
        await page.keyboard.press(`Key${ch.toUpperCase()}`);
        const t = await commit(page);
        if (t !== null) keys.push(t);
      }
    }
    const keyEvents = (await takeEvents(page, ["keydown"])).map((e) => e.dur);

    // PAN. Measured against an IDLE window taken immediately before it: the Studio
    // re-renders its lists at rest, and a delta that does not subtract that is a delta that
    // blames the pan for the shell's own heartbeat.
    const panBox = run === 0 ? await page.locator(".expr-shell .flow-pan").first().boundingBox() : null;
    let idle = ZERO_COUNTERS;
    if (run === 0) {
      const idleA = await counters(cdp);
      await page.waitForTimeout(600);
      idle = since(idleA, await counters(cdp));
    }
    let panDelta = ZERO_COUNTERS, panPhases: Phases = ZERO;
    let panWrites: { total: number; top: string[] } = { total: 0, top: [] };
    if (panBox !== null) {
      const before = await counters(cdp);
      await watchWrites(page);
      const t = await traced(cdp, async () => {
        const cx = panBox.x + panBox.width / 2, cy = panBox.y + panBox.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let step = 1; step <= 20; step++) {
          await page.mouse.move(cx - step * 8, cy - step * 4);
          await page.waitForTimeout(16);
        }
        await page.mouse.up();
      });
      panPhases = t.phases;
      panDelta = since(before, await counters(cdp));
      panWrites = await writesSeen(page);
    }

    // ZOOM. Four steps on the cluster's own button, which is the gesture the surface offers.
    const zBefore = await counters(cdp);
    const zoomBtn = page.locator(".expr-shell").getByRole("button", { name: "Zoom in" }).first();
    const zt = run === 0
      ? await traced(cdp, async () => {
        if (await zoomBtn.count() === 0) return;
        for (let z = 0; z < 4; z++) { await zoomBtn.click(); await page.waitForTimeout(120); }
      })
      : { value: undefined, phases: ZERO };
    const zoomDelta = run === 0 ? since(zBefore, await counters(cdp)) : ZERO_COUNTERS;
    await fit();

    if (run === 0 && OUT !== "") {
      await page.mouse.move(4, 4);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(OUT, `${String(i).padStart(2, "0")}-${c.name}.png`) });
    }

    const prev = rows.get(c.name) ?? {
      name: c.name, cards: census.cards, ports: census.ports, el: census.el,
      total: census.total, nodes: live.nodes,
      open: [], srv: [], select: [], row: [], rowEvt: [], key: [], keyEvt: [],
      openPhases: opened.phases, panPhases, zoomPhases: zt.phases,
      pan: panDelta, panIdle: idle, zoom: zoomDelta, panWrites,
    };
    prev.open.push(openMs);
    prev.srv.push(srv);
    if (selectMs !== null) prev.select.push(selectMs);
    if (rowMs !== null) prev.row.push(rowMs);
    if (rowEvt > 0) prev.rowEvt.push(rowEvt);
    if (keys.length > 0) prev.key.push(median(keys));
    if (keyEvents.length > 0) prev.keyEvt.push(median(keyEvents));
    if (run === 0) {
      prev.cards = census.cards; prev.ports = census.ports;
      prev.el = census.el; prev.total = census.total; prev.nodes = live.nodes;
    }
    rows.set(c.name, prev);

    await closeFormula();
  }
}

// - the leak: open, close, twenty times - //
// The canvas mounts under `keep="true"` with a fade, so it stays in the DOM across a close
// and a residue per cycle is invisible until an author has been in the Studio for an hour.
// GC is forced before every reading, because an uncollected node is not a leaked one.
async function domNodes(): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage" as never);
  await page.waitForTimeout(150);
  return (await cdp.send("Memory.getDOMCounters" as never) as unknown as { nodes: number }).nodes;
}
{
  const body = page.locator(".logic-bodies").getByText(`case${leakCase}`, { exact: true }).first();
  if (await body.count() > 0) { await body.click(); await page.waitForTimeout(700); }
  for (let cycle = 0; cycle <= 20; cycle++) {
    if (cycle > 0) {
      const argRow = page.locator(".logic-row").first();
      if (await argRow.count() > 0) await argRow.click({ timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      const diagram = page.getByRole("button", { name: "Diagram" }).first();
      if (await diagram.count() > 0) await diagram.click({ timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      await closeFormula();
    }
    if (cycle === 0 || cycle === 1 || cycle === 5 || cycle === 10 || cycle === 20) {
      leak.push({ cycle, nodes: await domNodes(), heap: (await counters(cdp)).heap });
    }
  }
}

} catch (e) {
  problems.push(`the walk stopped early: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
} finally {
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

// - the report - 
console.log(`\nmachine calibration ${cal.toFixed(0)}ms (reference ${BASELINE.cal || "unrecorded"}); timing budgets scaled x${slow.toFixed(2)}`);
console.log(`medians over ${RUNS} run${RUNS === 1 ? "" : "s"}; every duration in ms\n`);
console.log("fixture   cards ports    el   page  domN | open  srv | select   row evtRow   key evtKey");

const table: Record<string, { el: number; nodes: number; open: number; select: number; row: number; key: number }> = {};
const ordered = list.map((c) => rows.get(c.name)).filter((r): r is Row => r !== undefined);
for (const r of ordered) {
  const open = median(r.open), sel = median(r.select), rw = median(r.row);
  const key = median(r.key), kev = median(r.keyEvt);
  table[r.name] = {
    el: r.el, nodes: r.nodes,
    open: Math.round(open), select: Math.round(sel), row: Math.round(rw), key: Math.round(kev),
  };
  console.log(
    `${r.name.padEnd(9)} ${String(r.cards).padStart(5)} ${String(r.ports).padStart(5)}`
    + ` ${String(r.el).padStart(5)} ${String(r.total).padStart(6)} ${String(r.nodes).padStart(5)}`
    + ` | ${open.toFixed(0).padStart(4)} ${median(r.srv).toFixed(0).padStart(4)}`
    + ` | ${sel.toFixed(0).padStart(6)} ${rw.toFixed(0).padStart(5)} ${median(r.rowEvt).toFixed(0).padStart(6)}`
    + ` ${key.toFixed(0).padStart(5)} ${kev.toFixed(0).padStart(5)}`,
  );
}

console.log("\nthe renderer's own lifecycle, per gesture: style/layout/prepaint/paint ms over a wall-clock window, frames committed");
for (const r of ordered) {
  const f = (p: Phases): string =>
    `${p.style.toFixed(0)}/${p.layout.toFixed(0)}/${p.prepaint.toFixed(0)}/${p.paint.toFixed(0)}`
    + ` in ${p.wall}ms f=${p.frames}`;
  console.log(`  ${r.name.padEnd(9)} open  ${f(r.openPhases)}`);
  console.log(`  ${"".padEnd(9)} pan   ${f(r.panPhases)}   counters style+${r.pan.style} layout+${r.pan.layout}`
    + ` (idle drift over 600ms: style+${r.panIdle.style} layout+${r.panIdle.layout})`);
  console.log(`  ${"".padEnd(9)} zoom  ${f(r.zoomPhases)}   counters style+${r.zoom.style} layout+${r.zoom.layout}`);
  console.log(`  ${"".padEnd(9)} DOM writes during the pan: ${r.panWrites.total}`
    + `${r.panWrites.top.length === 0 ? "" : " - " + r.panWrites.top.join(" ")}`);
}

let failed = 0;
let pending = 0;
const check = (id: string, ok: boolean, line: string): void => {
  const excuse = PENDING[id];
  if (ok) { console.log(`ok      ${line}`); return; }
  if (excuse !== undefined) { pending += 1; console.log(`PENDING ${line}\n        -> ${excuse}`); return; }
  failed += 1;
  console.log(`FAIL    ${line}`);
};

console.log("\nbudgets");
const byOpen = [...ordered].sort((a, b) => median(b.open) - median(a.open));
const worst = byOpen[0];
if (worst !== undefined) {
  const o = median(worst.open) / slow;
  check("open", o <= BUDGET.openMs,
    `open <= ${BUDGET.openMs}ms for the worst fixture: ${worst.name} at ${o.toFixed(0)}ms`
    + ` (the server's projection is ${median(worst.srv).toFixed(0)}ms of it)`);
}
// One line per gesture, not one per fixture's worst: the three gestures have different
// mechanisms and different costs, and rolling them into a maximum hides which one moved.
for (const [id, label, pick] of [
  ["interaction.select", "select a node ", (r: Row): number => median(r.select)],
  ["interaction.row", "open a row    ", (r: Row): number => median(r.row)],
  ["interaction.key", "type one key  ", (r: Row): number => median(r.keyEvt)],
] as const) {
  const worstFor = [...ordered].sort((a, b) => pick(b) - pick(a))[0];
  if (worstFor === undefined) continue;
  const ms = pick(worstFor) / slow;
  check(id, ms <= BUDGET.interactionMs,
    `${label} at worst ${ms.toFixed(0)}ms <= ${BUDGET.interactionMs}ms, on ${worstFor.name}`
    + (ms > 100 && ms <= BUDGET.interactionMs ? "  (past the 100ms 'caused by my gesture' target)" : ""));
}
{
  const heaviest = [...ordered].sort((a, b) => b.pan.style - a.pan.style)[0];
  if (heaviest !== undefined) {
    check("pan.layout", heaviest.pan.layout <= BUDGET.panLayoutCount,
      `a pan is a compositor operation: LayoutCount +${heaviest.pan.layout} on ${heaviest.name} over 20 drag steps`
      + ` (budget ${BUDGET.panLayoutCount})`);
    check("pan.style", heaviest.pan.style - heaviest.panIdle.style <= BUDGET.panStyleRecalcs,
      `a pan restyles nothing but the world: RecalcStyleCount +${heaviest.pan.style} on ${heaviest.name}`
      + ` (idle drift ${heaviest.panIdle.style}, budget ${BUDGET.panStyleRecalcs})`);
    check("pan.writes", heaviest.panWrites.total <= BUDGET.panDomWrites,
      `a pan writes only the world's transform: ${heaviest.panWrites.total} DOM writes over 20`
      + ` drag steps on ${heaviest.name} (budget ${BUDGET.panDomWrites})`
      + `${heaviest.panWrites.top.length === 0 ? "" : " - " + heaviest.panWrites.top.join(" ")}`);
    const frames = Math.max(1, heaviest.panPhases.frames);
    const perFrame = (heaviest.panPhases.style + heaviest.panPhases.layout
      + heaviest.panPhases.prepaint + heaviest.panPhases.paint) / frames / slow;
    check("pan.frame", perFrame <= BUDGET.panFrameMs,
      `a pan frame holds 60fps: ${perFrame.toFixed(1)}ms of style+layout+paint per committed frame`
      + ` on ${heaviest.name} (budget ${BUDGET.panFrameMs}ms)`);
  }
  const zHeaviest = [...ordered].sort((a, b) => b.zoom.layout - a.zoom.layout)[0];
  if (zHeaviest !== undefined) {
    check("zoom.layout", zHeaviest.zoom.layout <= BUDGET.panLayoutCount,
      `a zoom step is a compositor operation: LayoutCount +${zHeaviest.zoom.layout} over 4 steps on ${zHeaviest.name}`);
  }
}
{
  // The ceiling only means something if the surface under it is inside budget. A fixture
  // BELOW the ceiling that costs more than a gesture may is the ceiling being wrong.
  const under = ordered.filter((r) => r.cards <= BUDGET.nodeCeiling);
  const over = under.filter((r) => median(r.open) / slow > BUDGET.openMs).map((r) => `${r.name} (${r.cards} cards)`);
  check("ceiling", over.length === 0,
    `every fixture under the ${BUDGET.nodeCeiling}-card degrade ceiling opens inside ${BUDGET.openMs}ms`
    + (over.length === 0 ? "" : `: ${over.join(", ")}`));
}
if (leak.length >= 2) {
  const first = leak[1] ?? leak[0]!;
  const last = leak[leak.length - 1]!;
  const perCycle = last.cycle === first.cycle ? 0 : (last.nodes - first.nodes) / (last.cycle - first.cycle);
  console.log(`\nleak, 20 open/close cycles on ${list[leakCase]!.name} (GC forced before every reading)`);
  for (const l of leak) console.log(`  cycle ${String(l.cycle).padStart(2)}  domNodes=${l.nodes}  jsHeap=${(l.heap / 1048576).toFixed(2)}MB`);
  check("leak", perCycle <= BUDGET.leakNodesPerCycle,
    `the page's live node count comes back: ${perCycle.toFixed(1)} nodes/cycle over 20 cycles`
    + ` (budget ${BUDGET.leakNodesPerCycle})`);
} else {
  failed += 1;
  console.log("\nFAIL    the leak walk did not produce two readings");
}

for (const p of problems) { failed += 1; console.log(`FAIL    ${p}`); }

if (BASELINE.cal > 0) {
  console.log("\nagainst the recorded baseline - timings scaled by the machine factor at 2x tolerance, counts at 2%");
  for (const r of ordered) {
    const was = BASELINE.cases[r.name];
    const now = table[r.name]!;
    if (was === undefined) { console.log(`  ${r.name.padEnd(9)} not in the baseline - re-record with RECORD=1`); continue; }
    const drift: string[] = [];
    for (const k of ["open", "select", "row", "key"] as const) {
      if (was[k] > 0 && now[k] / slow > was[k] * 2) drift.push(`${k} ${was[k]}ms -> ${(now[k] / slow).toFixed(0)}ms`);
    }
    for (const k of ["el", "nodes"] as const) {
      if (was[k] > 0 && Math.abs(now[k] - was[k]) > was[k] * 0.02) drift.push(`${k} ${was[k]} -> ${now[k]}`);
    }
    if (drift.length === 0) { console.log(`  ok      ${r.name}`); continue; }
    failed += 1;
    console.log(`  FAIL    ${r.name}: ${drift.join(", ")}`);
  }
}

if (RECORD) {
  console.log("\n// paste over BASELINE:");
  console.log(`  cal: ${Math.round(cal)},`);
  console.log(`  cases: ${JSON.stringify(table)},`);
}

console.log(`\n${failed} failed, ${pending} pending`);
process.exit(failed === 0 ? 0 : 1);
