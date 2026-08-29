// `<Plot>` — the ten chart shapes, actually drawn.
//
// The geometry is JSE inside a markup component, which means nothing type-checks it and no
// corpus pins it: the only honest proof is to mount every type in a real browser and look at
// the pixels. For each shape this asserts that it PAINTS (a floor of lit pixels, so an empty
// canvas or a silent JSE throw is a failure), that it stays INSIDE its box, and that it
// declares one accessible row per datum — the part that makes a plot readable rather than a
// picture. A page error anywhere fails the run.
//
//   DSX_BROWSER_EXECUTABLE=<chromium> node packages/dom/oracle/plot-browser.ts

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const TYPES = [
  "pie", "donut", "ring", "polar", "radar",
  "heatmap", "funnel", "treemap", "waterfall", "candlestick",
] as const;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PLOT = join(
  ROOT, "ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Core/Plot.dsx",
);

const harness = String.raw`<vstack class="plot-harness">
  <head>
    <variable as="rows">return [
      { label: "Rent", value: 1200, open: 10, high: 18, low: 8, close: 16 },
      { label: "Food", value: 640, open: 16, high: 20, low: 12, close: 13 },
      { label: "Travel", value: 380, open: 13, high: 15, low: 6, close: 14 },
      { label: "Fun", value: 210, open: 14, high: 22, low: 11, close: 21 },
      { label: "Other", value: 95, open: 21, high: 24, low: 17, close: 18 }
    ]</variable>
  </head>
${TYPES.map((type) => `  <Plot class="plot-${type}" type="${type}" data="{{ dsx.variable.rows }}" height="160"/>`).join("\n")}
</vstack>`;

const source = String.raw`
  import { compileComponent } from "./packages/compiler/src/component.ts";
  import { CssCollector, extractComponentCss } from "./packages/compiler/src/css.ts";
  import { LAYER_STATEMENT } from "./packages/compiler/src/cssmap.ts";
  import { instantiate } from "./packages/dom/src/mount.ts";
  import { registerGlobalElements, registerRichElements } from "./packages/dom/src/elements.ts";
  import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "./packages/dom/src/globals.ts";
  import { registerCanvasSurface } from "./packages/dom/src/canvas.ts";
  import { registerDataControls } from "./packages/dom/src/data-controls.ts";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "./packages/dom/src/theme.ts";

  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  registerDataControls();
  registerCanvasSurface();
  const plot = compileComponent("Plot", "shared", ${JSON.stringify(readFileSync(PLOT, "utf8"))});
  const ir = compileComponent("PlotHarness", "test", ${JSON.stringify(harness)});
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  extractComponentCss(plot, collector);
  const registry = {
    components: { "test.PlotHarness": ir, "shared.Plot": plot },
    globalPool: { Plot: "shared.Plot" },
    css: collector.emit(), schemes: [],
  };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
    RICH_ELEMENTS_CSS, GLOBAL_ELEMENTS_CSS, registry.css,
    "@layer dsx-components { * { box-sizing:border-box } body { margin:0 } .plot-harness { width:320px; } .dsx-plot-surface { width:320px; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__DSX_PLOT__ = {
    audit: (cls) => {
      const host = document.querySelector("." + cls);
      if (host === null) return null;
      const surface = host.querySelector("canvas");
      if (surface === null) return null;
      const rect = surface.getBoundingClientRect();
      const context = surface.getContext("2d");
      const data = context.getImageData(0, 0, surface.width, surface.height).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit += 1;
      const total = surface.width * surface.height;
      return {
        lit, total,
        width: Math.round(rect.width), height: Math.round(rect.height),
        a11y: host.querySelectorAll(".dsx-canvas-a11y").length,
        label: host.querySelector(".dsx-canvas")?.getAttribute("aria-label") ?? null,
      };
    },
  };
  window.__DSX_PLOT_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "plot-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("plot browser harness did not bundle");

type PlotAudit = {
  lit: number; total: number; width: number; height: number; a11y: number; label: string | null;
};
declare global {
  // eslint-disable-next-line no-var
  var __DSX_PLOT__: { audit: (cls: string) => PlotAudit | null };
}

const failures: string[] = [];
const engine = browserEngine();
const browser = await launchBrowser(engine);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_PLOT_READY__?: boolean }).__DSX_PLOT_READY__ === true);
  await page.waitForTimeout(120);

  for (const type of TYPES) {
    const audit = await page.evaluate((cls) => globalThis.__DSX_PLOT__.audit(cls), `plot-${type}`);
    if (audit === null) {
      failures.push(`${type}: never mounted`);
      console.log(`  FAIL  ${type} — never mounted`);
      continue;
    }
    const coverage = audit.total > 0 ? audit.lit / audit.total : 0;
    const painted = coverage > 0.01;
    const sized = audit.width > 300 && audit.height > 140;
    const readable = audit.a11y === 5 && (audit.label ?? "").includes(type);
    if (painted && sized && readable) {
      console.log(`  ok    ${type.padEnd(12)} ${(coverage * 100).toFixed(1)}% of the box inked, ${audit.a11y} readable rows`);
      continue;
    }
    const why = [
      painted ? "" : `painted only ${(coverage * 100).toFixed(2)}% of the box`,
      sized ? "" : `laid out ${audit.width}x${audit.height}`,
      readable ? "" : `a11y rows=${audit.a11y} label=${String(audit.label)}`,
    ].filter((s) => s.length > 0).join("; ");
    failures.push(`${type}: ${why}`);
    console.log(`  FAIL  ${type} — ${why}`);
  }

  if (pageErrors.length > 0) {
    for (const error of pageErrors) console.log(`  FAIL  ${error}`);
    failures.push(`the page reported errors: ${pageErrors.join(" | ")}`);
  }
} finally {
  await browser.close();
}

console.log(`\nplot: ${TYPES.length} shapes, ${failures.length} failure(s)`);
if (failures.length > 0) process.exitCode = 1;
