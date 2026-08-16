// Real-engine gate for data-bound list/grid/pager. The harness bundles the source
// entries directly so this oracle can run during focused development without a
// workspace clean/build racing another qualification lane.

import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="bound-harness">
  <head>
    <variable as="rows">return [
      { id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' },
      { id: 'd', label: 'Delta' }, { id: 'e', label: 'Epsilon' }, { id: 'f', label: 'Zeta' },
      { id: 'g', label: 'Eta' }, { id: 'h', label: 'Theta' }, { id: 'i', label: 'Iota' },
      { id: 'j', label: 'Kappa' }, { id: 'k', label: 'Lambda' }, { id: 'l', label: 'Mu' }
    ]</variable>
    <variable as="pages">return [
      { id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }
    ]</variable>
    <variable as="page">return 1</variable>
    <variable as="changes">return 0</variable>
    <variable as="reaches">return 0</variable>
  </head>
  <list class="bound-list author-list" bind="rows" key="id" on:reachEnd="reaches = reaches + 1">
    <textfield class="bound-row-input" bind="item.label"/>
  </list>
  <grid class="bound-grid" bind="rows" key="id" columns="3">
    <text value="{{ item.label }}"/>
  </grid>
  <pager class="bound-pager" bind="pages" key="id" value="page" on:change="changes = changes + 1">
    <text value="{{ item.title }}"/>
  </pager>
</vstack>`;

const webRoot = resolve(import.meta.dirname, "../../..");
const source = String.raw`
  import { compileComponent } from ${JSON.stringify(resolve(webRoot, "packages/compiler/src/component.ts"))};
  import { LAYER_STATEMENT } from ${JSON.stringify(resolve(webRoot, "packages/compiler/src/cssmap.ts"))};
  import { instantiate } from ${JSON.stringify(resolve(webRoot, "packages/dom/src/mount.ts"))};
  import { TOKENS_CSS, ELEMENTS_CSS } from ${JSON.stringify(resolve(webRoot, "packages/dom/src/theme.ts"))};
  import { STRUCTURAL_CONTROLS_CSS, registerStructuralControls } from ${JSON.stringify(resolve(webRoot, "packages/dom/src/structural-controls.ts"))};

  registerStructuralControls();
  const ir = compileComponent("BoundStructural", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.BoundStructural": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, STRUCTURAL_CONTROLS_CSS,
    "@layer dsx-components { * { box-sizing:border-box } body { margin:0 } .bound-harness { width:min(100%,760px); gap:18px; padding:16px; margin:auto } .bound-list { height:180px; border:1px solid var(--dsx-separator); border-radius:3px } .bound-row-input { width:100%; min-height:44px } .bound-grid { width:100% } .bound-pager { width:100%; height:220px; border:1px solid var(--dsx-separator) } .dsx-paged-page { display:grid; place-items:center } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__dsxBound = {
    read: (expression) => instance.ctx.store.eval(expression, null),
    set: (name, value) => instance.ctx.store.set(name, value),
  };
  window.__DSX_BOUND_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: webRoot, sourcefile: "structural-bound-browser-entry.ts" },
  alias: {
    "@despia/kernel": resolve(webRoot, "packages/kernel/src/index.ts"),
    "@despia/compiler/component": resolve(webRoot, "packages/compiler/src/component.ts"),
    "@despia/compiler/cssmap": resolve(webRoot, "packages/compiler/src/cssmap.ts"),
    "@despia/compiler/options": resolve(webRoot, "packages/compiler/src/options.ts"),
    "@despia/compiler/resolve": resolve(webRoot, "packages/compiler/src/resolve.ts"),
    "@despia/compiler/xml": resolve(webRoot, "packages/compiler/src/xml.ts"),
  },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("bound structural browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_BOUND_READY__?: boolean }).__DSX_BOUND_READY__ === true);

  const read = async (expression: string): Promise<unknown> => await page.evaluate((value) => {
    const harness = (window as unknown as { __dsxBound: { read(expr: string): unknown } }).__dsxBound;
    return harness.read(value);
  }, expression);
  const set = async (name: string, value: unknown): Promise<void> => await page.evaluate(([key, next]) => {
    const harness = (window as unknown as { __dsxBound: { set(name: string, value: unknown): void } }).__dsxBound;
    harness.set(key as string, next);
  }, [name, value] as const);

  const list = page.locator(".bound-list");
  const grid = page.locator(".bound-grid");
  const pager = page.locator(".bound-pager");
  if (await list.getAttribute("role") !== "list") errors.push("bound list role missing");
  if (await grid.getAttribute("role") !== "grid") errors.push("bound grid role missing");
  if (await grid.locator(":scope > [role=row]").count() !== 4) errors.push("grid did not group 12 cells into four semantic rows");
  if (await grid.locator(":scope > [role=row] > [role=gridcell]").count() !== 12) errors.push("gridcell ownership is not grid > row > gridcell");
  if (await pager.getAttribute("aria-roledescription") !== "carousel") errors.push("bound pager carousel semantic missing");
  if (await pager.locator(".dsx-paged-page").count() !== 3 || await pager.locator(".dsx-paged-dot").count() !== 3) {
    errors.push("bound pager did not materialize one slide/dot per bound row");
  }
  if (await pager.getAttribute("data-dsx-page") !== "1") errors.push("bound pager ignored initial value index");

  const alpha = list.locator("input").first();
  await alpha.focus();
  await page.evaluate(() => { (window as unknown as { __dsxFocused?: Element | null }).__dsxFocused = document.activeElement; });
  await set("rows", [
    { id: "b", label: "Beta 2" }, { id: "c", label: "Gamma" }, { id: "d", label: "Delta" },
    { id: "e", label: "Epsilon" }, { id: "f", label: "Zeta" }, { id: "g", label: "Eta" },
    { id: "h", label: "Theta" }, { id: "i", label: "Iota" }, { id: "j", label: "Kappa" },
    { id: "k", label: "Lambda" }, { id: "l", label: "Mu" }, { id: "a", label: "Alpha 2" },
  ]);
  await page.waitForTimeout(30);
  const focusState = await page.evaluate(() => ({
    same: document.activeElement === (window as unknown as { __dsxFocused?: Element }).__dsxFocused,
    value: (document.activeElement as HTMLInputElement | null)?.value ?? "",
  }));
  if (!focusState.same || focusState.value !== "Alpha 2") errors.push(`keyed focus/item refresh failed: ${JSON.stringify(focusState)}`);

  await pager.locator(".dsx-paged-dot").nth(2).click();
  await page.waitForTimeout(30);
  if (await read("page") !== 2 || await read("changes") !== 1) errors.push("pager dot did not write value/fire one change");
  await pager.locator(".dsx-paged-viewport").press("Home");
  await page.waitForTimeout(30);
  if (await read("page") !== 0 || await read("changes") !== 2) errors.push("pager Home key did not select/write exactly once");
  await pager.locator(".dsx-paged-viewport").press("End");
  await page.waitForTimeout(30);
  if (await read("page") !== 2 || await read("changes") !== 3) errors.push("pager End key did not select/write exactly once");
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  await pager.locator(".dsx-paged-viewport").press("ArrowRight");
  await page.waitForTimeout(30);
  const rtlBack = await page.evaluate(() => ({
    page: (window as unknown as { __dsxBound: { read(expr: string): unknown } }).__dsxBound.read("page"),
    viewport: getComputedStyle(document.querySelector(".dsx-paged-viewport")!).direction,
    content: getComputedStyle(document.querySelector(".dsx-paged-page")!).direction,
  }));
  if (rtlBack.page !== 1 || rtlBack.viewport !== "ltr" || rtlBack.content !== "rtl") {
    errors.push(`RTL pager geometry/content/ArrowRight mismatch: ${JSON.stringify(rtlBack)}`);
  }
  await pager.locator(".dsx-paged-viewport").press("ArrowLeft");
  await page.waitForTimeout(30);
  if (await read("page") !== 2) errors.push("RTL ArrowLeft did not advance in visual reading order");
  await page.evaluate(() => { document.documentElement.dir = "ltr"; });

  await list.locator("[role=listitem]").last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const harness = (window as unknown as { __dsxBound: { read(expr: string): unknown } }).__dsxBound;
    return harness.read("reaches") === 1;
  });
  await list.locator("[role=listitem]").first().scrollIntoViewIfNeeded();
  await list.locator("[role=listitem]").last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  if (await read("reaches") !== 1) errors.push("reachEnd fired more than once for the same terminal row");

  await set("rows", [{ id: "only", label: "Only" }]);
  await page.waitForTimeout(30);
  if (await list.locator("[role=listitem]").count() !== 1 || await grid.locator("[role=gridcell]").count() !== 1) {
    errors.push("single-row collection reconciliation failed");
  }
  await set("rows", []);
  await page.waitForTimeout(30);
  if (await list.locator("[role=listitem]").count() !== 0 || await grid.locator("[role=gridcell]").count() !== 0) {
    errors.push("empty collection reconciliation failed");
  }

  const started = Date.now();
  await page.evaluate(() => {
    const harness = (window as unknown as { __dsxBound: { set(name: string, value: unknown): void } }).__dsxBound;
    harness.set("rows", Array.from({ length: 100_000 }, (_, id) => ({ id, label: `Row ${id}` })));
  });
  await page.waitForFunction(() => document.querySelectorAll(".bound-list > [role=listitem]").length === 1_000);
  const elapsed = Date.now() - started;
  if (await list.locator(":scope > [role=listitem]").count() !== 1_000) errors.push("bound list exceeded/fell short of 1,000 live-row cap");
  if (await grid.locator("[role=gridcell]").count() !== 1_000) errors.push("bound grid exceeded/fell short of 1,000 live-cell cap");
  if (await list.getAttribute("data-dsx-truncated") !== "true"
      || await list.getAttribute("data-dsx-total-count") !== "100000"
      || await list.getAttribute("data-dsx-rendered-count") !== "1000") {
    errors.push("truncated collection state/count metadata is missing or inaccurate");
  }
  if (elapsed > 5_000) errors.push(`100k bounded reconcile took ${elapsed}ms (>5000ms)`);

  const authoredRadius = await list.evaluate((element) => getComputedStyle(element).borderRadius);
  if (authoredRadius !== "3px") errors.push(`author layer lost to structural defaults (${authoredRadius})`);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    await page.waitForTimeout(40);
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pagerWidth: document.querySelector(".bound-pager")?.getBoundingClientRect().width ?? 0,
      viewportWidth: document.querySelector(".bound-pager .dsx-paged-viewport")?.getBoundingClientRect().width ?? 0,
      page: document.querySelector(".bound-pager")?.getAttribute("data-dsx-page"),
    }));
    if (geometry.overflow > 1 || geometry.pagerWidth <= 0 || geometry.viewportWidth <= 0) {
      errors.push(`${width}px structural overflow/geometry failed: ${JSON.stringify(geometry)}`);
    }
    if (geometry.page !== "2") errors.push(`${width}px resize lost pager selection (${geometry.page})`);
  }

  if (errors.length === 0) {
    console.log(`✓ [${engine}] bound structures: cap, keyed focus, grid ARIA, pager pointer/keyboard/resize, reachEnd, weak overrides`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
