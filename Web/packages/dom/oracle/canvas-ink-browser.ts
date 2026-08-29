// `<ink>` DRIVEN BY A REAL POINTER, in a real browser.
//
// The ink LAW is corpus-pinned and runs on the TS and Kotlin cores (canvas/ink.json). What no
// unit test can reach is the WIRING, which is the whole reason the primitive exists:
//
//   1. a pointer stream paints ink on the surface at all,
//   2. it paints WITHOUT writing the store - a moved finger must not rebuild a display list,
//   3. the store is written EXACTLY ONCE, on pointer-up, in the wire shape,
//   4. a second stroke APPENDS rather than replacing,
//   5. the sampling floor drops samples a slow drag piles up,
//   6. clearing is a STATE WRITE - `drawing = []` empties the surface, with no control channel,
//   7. and the committed strokes come back as ordinary tier-1 geometry (they survive a repaint
//      that has nothing to do with the pointer).
//
// Any of those failing is a real failure, so this oracle has no PENDING tier: it is green or it
// is red.
//
//   DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/canvas-ink-browser.ts

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="ink-harness">
  <head>
    <variable as="drawing">return []</variable>
  </head>
  <canvas class="ink-surface" height="200" a11yLabel="Sketch"
          on:strokeStart="dsx.variable.started = (dsx.variable.started || 0) + 1"
          on:strokeEnd="dsx.variable.ended = (dsx.variable.ended || 0) + 1">
    <ink bind="dsx.variable.drawing" stroke="label" strokeWidth="4"/>
  </canvas>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "./packages/compiler/src/component.ts";
  import { CssCollector, extractComponentCss } from "./packages/compiler/src/css.ts";
  import { LAYER_STATEMENT } from "./packages/compiler/src/cssmap.ts";
  import { instantiate } from "./packages/dom/src/mount.ts";
  import { registerGlobalElements, registerRichElements } from "./packages/dom/src/elements.ts";
  import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "./packages/dom/src/globals.ts";
  import { registerCanvasSurface } from "./packages/dom/src/canvas.ts";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "./packages/dom/src/theme.ts";

  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  registerCanvasSurface();
  const ir = compileComponent("InkHarness", "test", ${JSON.stringify(markup)});
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const generatedCss = collector.emit();
  const registry = { components: { "test.InkHarness": ir }, globalPool: {}, css: generatedCss, schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
    RICH_ELEMENTS_CSS, GLOBAL_ELEMENTS_CSS, generatedCss,
    "@layer dsx-components { * { box-sizing:border-box } body { margin:0 } .ink-harness { width:300px; padding:0; } .ink-surface { width:300px; height:200px; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  const store = instance.ctx.store;
  window.__DSX_INK__ = {
    read: (key) => store.eval(key),
    write: (key, value) => { store.set(key, value); },
    painted: () => {
      const surface = document.querySelector(".dsx-canvas-surface");
      const context = surface.getContext("2d");
      const data = context.getImageData(0, 0, surface.width, surface.height).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit += 1;
      return lit;
    },
  };
  window.__DSX_INK_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "canvas-ink-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("canvas-ink browser harness did not bundle");

type InkBridge = {
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => void;
  painted: () => number;
};
declare global {
  // eslint-disable-next-line no-var
  var __DSX_INK__: InkBridge;
}

const failures: string[] = [];
const check = (ok: boolean, what: string, detail: string): void => {
  if (ok) console.log(`  ok    ${what}`);
  else {
    console.log(`  FAIL  ${what} - ${detail}`);
    failures.push(`${what}: ${detail}`);
  }
};

const engine = browserEngine();
const browser = await launchBrowser(engine);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_INK_READY__?: boolean }).__DSX_INK_READY__ === true);

  const box = await page.locator(".dsx-canvas-surface").boundingBox();
  if (box === null) throw new Error("the ink surface never laid out");

  const blank = await page.evaluate(() => globalThis.__DSX_INK__.painted());
  check(blank === 0, "an empty drawing paints nothing", `${blank} lit pixels before any stroke`);

  // ── one stroke, sampled in flight ──────────────────────────────────────────────────
  await page.mouse.move(box.x + 40, box.y + 150);
  await page.mouse.down();
  const inFlight: Array<{ strokes: number; lit: number }> = [];
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(box.x + 40 + step * 18, box.y + 150 - step * 9);
    inFlight.push(await page.evaluate(() => ({
      strokes: (globalThis.__DSX_INK__.read("drawing") as unknown[]).length,
      lit: globalThis.__DSX_INK__.painted(),
    })));
  }
  const drewInFlight = inFlight.some((sample) => sample.lit > 0);
  const wroteInFlight = inFlight.some((sample) => sample.strokes !== 0);
  check(drewInFlight, "the stroke paints under the pointer, before it is committed",
        "no pixels were lit while the pointer was down");
  check(!wroteInFlight, "a moved pointer never writes the store",
        `the bound value grew mid-stroke: ${JSON.stringify(inFlight.map((s) => s.strokes))}`);

  await page.mouse.up();
  const first = await page.evaluate(() => ({
    value: globalThis.__DSX_INK__.read("drawing"),
    lit: globalThis.__DSX_INK__.painted(),
    started: globalThis.__DSX_INK__.read("started"),
    ended: globalThis.__DSX_INK__.read("ended"),
  }));
  const strokes = first.value as Array<{ points: [number, number][]; width: number }>;
  check(strokes.length === 1, "pointer-up writes the store exactly once",
        `${strokes.length} strokes after one gesture`);
  check(first.lit > 0, "the committed stroke stays painted", "the surface went blank on commit");
  check(first.started === 1 && first.ended === 1,
        "the surface raises strokeStart and strokeEnd once each",
        `started=${String(first.started)} ended=${String(first.ended)}`);

  const points = strokes[0]?.points ?? [];
  const shaped = points.length > 1 && points.every((p) =>
    Array.isArray(p) && p.length === 2
    && p.every((n) => typeof n === "number" && n >= 0 && n <= 1
                      && Math.abs(n * 10000 - Math.round(n * 10000)) < 1e-9));
  check(shaped, "the value is the wire shape: normalized pairs, rounded at capture",
        `points: ${JSON.stringify(points.slice(0, 3))}`);
  check(strokes[0]?.width === 4, "the authored strokeWidth rides the stroke",
        `width: ${String(strokes[0]?.width)}`);

  // ── the sampling floor ─────────────────────────────────────────────────────────────
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  for (let step = 1; step <= 20; step += 1) await page.mouse.move(box.x + 40 + step, box.y + 40);
  await page.mouse.up();
  const second = await page.evaluate(() => globalThis.__DSX_INK__.read("drawing")) as Array<{
    points: [number, number][];
  }>;
  check(second.length === 2, "a second stroke appends rather than replacing",
        `${second.length} strokes after two gestures`);
  const crawl = second[1]?.points.length ?? 0;
  check(crawl > 1 && crawl < 20, "the coalescing floor drops the samples a slow drag piles up",
        `a 20-sample 1px-per-move drag kept ${crawl} points`);

  // ── clearing is a state write ──────────────────────────────────────────────────────
  await page.evaluate(() => { globalThis.__DSX_INK__.write("drawing", []); });
  await page.waitForTimeout(50);
  const cleared = await page.evaluate(() => ({
    lit: globalThis.__DSX_INK__.painted(),
    value: (globalThis.__DSX_INK__.read("drawing") as unknown[]).length,
  }));
  check(cleared.lit === 0 && cleared.value === 0,
        "clearing is `drawing = []` - no control channel, and the surface follows",
        `${cleared.lit} lit pixels and ${cleared.value} strokes after the write`);

  if (pageErrors.length > 0) {
    failures.push(`the page reported errors: ${pageErrors.join(" | ")}`);
    for (const error of pageErrors) console.log(`  FAIL  ${error}`);
  }
} finally {
  await browser.close();
}

console.log(`\ncanvas-ink: ${failures.length} failure(s)`);
if (failures.length > 0) process.exitCode = 1;
