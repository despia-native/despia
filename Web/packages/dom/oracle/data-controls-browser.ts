// Real-engine acceptance for DSX structured data and selection controls.
// This is intentionally source-bundled so every locked engine exercises the same
// factories, binding runner and weak-layer stylesheet shipped to applications.

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="data-harness">
  <head>
    <variable as="rows">return [{ id: 1, item: "Espresso", qty: 2, total: "$7.00" }, { id: 2, item: "Tea", qty: 1, total: "$3.50" }]</variable>
    <variable as="day">return "2026-07-23"</variable>
    <variable as="marks">return [{ date: "2026-07-23", color: "destructive" }]</variable>
    <variable as="plans">return [{ id: "free", label: "Free" }, { id: "pro", label: "Pro" }]</variable>
    <variable as="plan">return "free"</variable>
    <variable as="filters">return "Day"</variable>
    <variable as="view">return "Grid"</variable>
    <variable as="busy">return false</variable>
    <variable as="changes">return 0</variable>
    <variable as="months">return 0</variable>
    <variable as="refreshes">return 0</variable>
  </head>
  <Table class="override-table" bind="rows" columns="Item,Qty,Total" fields="item,qty,total" color="destructive"/>
  <calendar class="override-calendar" bind="day" min="2026-07-10" max="2026-09-20" marks="marks"
    on:change="dsx.variable.changes += 1" on:month="dsx.variable.months += 1"/>
  <RadioGroup bind="plan" optionsKey="plans" on:change="dsx.variable.changes += 1"/>
  <segmentedButton class="multi" bind="filters" options="Day,Week,Month" multiple="true" on:change="dsx.variable.changes += 1"/>
  <segmentedButton class="single" bind="view" options="List,Grid,Detail" multiple="false" on:change="dsx.variable.changes += 1"/>
  <refreshable busy="busy" on:refresh="dsx.variable.busy = true; dsx.variable.refreshes += 1">
    <vstack><text value="Refresh content"/></vstack>
  </refreshable>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia/compiler/component";
  import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
  import { instantiate } from "@despia/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS } from "@despia/dom/theme";
  import { DATA_CONTROLS_CSS, registerDataControls } from "@despia/dom/data-controls";

  registerDataControls();
  const ir = compileComponent("DataBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.DataBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, DATA_CONTROLS_CSS,
    "@layer dsx-components { .data-harness { box-sizing:border-box; width:min(100%,52rem); gap:20px; padding:16px; margin:auto; } .override-table { border-radius:3px; } .override-calendar { --dsx-data-tint: rgb(0, 96, 208); } .dsx-refreshable { min-height:140px; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__dsxDataRead = (expression) => instance.ctx.store.eval(expression, null);
  window.__dsxDataSet = (name, value) => instance.ctx.store.set(name, value);
  window.__DSX_DATA_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "data-controls-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("data controls browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, locale: "en-US" });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  await page.setContent("<!doctype html><html lang='en-US'><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_DATA_READY__?: boolean }).__DSX_DATA_READY__ === true);

  const read = async (expression: string): Promise<unknown> => await page.evaluate((value) =>
    (window as unknown as { __dsxDataRead: (expr: string) => unknown }).__dsxDataRead(value), expression);
  const set = async (name: string, value: unknown): Promise<void> => { await page.evaluate(([key, next]) =>
    (window as unknown as { __dsxDataSet: (name: string, value: unknown) => void }).__dsxDataSet(key as string, next), [name, value]); };

  const table = page.locator("table.dsx-table");
  if (await table.locator('th[scope="col"]').allTextContents().then((values) => values.join("|")) !== "Item|Qty|Total") {
    errors.push("table did not expose semantic scoped headers");
  }
  if (await table.locator("tbody tr").count() !== 2 || await table.getAttribute("aria-rowcount") !== "3") {
    errors.push("table row semantics/count diverged");
  }
  if (await page.locator(".dsx-table-frame").evaluate((element) => getComputedStyle(element).borderRadius) !== "3px") {
    errors.push("ordinary author CSS did not override weak table radius");
  }
  if (await page.locator(".dsx-table-frame").evaluate((element) => element.style.getPropertyValue("--dsx-table-color")) !== "var(--dsx-destructive)") {
    errors.push("Table color did not own row text through its dedicated semantic variable");
  }

  const calendar = page.locator(".dsx-calendar");
  if (await calendar.getAttribute("data-dsx-month") !== "2026-07") errors.push("calendar did not open on its bound month");
  if (!await calendar.locator('[data-dsx-date="2026-07-09"]').isDisabled()) errors.push("calendar min bound did not disable earlier days");
  if (await calendar.locator('[data-dsx-date="2026-07-23"] .dsx-calendar-mark').count() !== 1) errors.push("calendar mark index missing");
  await calendar.locator('[data-dsx-date="2026-07-24"]').click();
  if (await read("dsx.variable.day") !== "2026-07-24") errors.push("calendar click did not write yyyy-MM-dd");
  await calendar.locator('[data-dsx-date="2026-07-24"]').focus();
  await calendar.locator('[data-dsx-date="2026-07-24"]').press("ArrowRight");
  if (await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["dsxDate"]) !== "2026-07-25") {
    errors.push("calendar arrow navigation did not preserve a roving focus target");
  }
  await page.keyboard.press("Enter");
  if (await read("dsx.variable.day") !== "2026-07-25") errors.push("calendar keyboard activation did not write its date");
  await calendar.locator(".dsx-calendar-next").click();
  if (await calendar.getAttribute("data-dsx-month") !== "2026-08" || await read("dsx.variable.months") !== 1) {
    errors.push("calendar paging/month event diverged");
  }

  const radios = page.locator('.dsx-radio-group input[type="radio"]');
  if (await radios.count() !== 2 || await page.locator(".dsx-radio-group").getAttribute("role") !== "radiogroup") {
    errors.push("RadioGroup lacks native radio/radiogroup semantics");
  }
  await page.locator(".dsx-radio-option", { hasText: "Pro" }).click();
  if (await read("dsx.variable.plan") !== "pro") errors.push("RadioGroup did not write the option ID");

  const multi = page.locator(".multi");
  await multi.getByRole("button", { name: "Month" }).click();
  await multi.getByRole("button", { name: "Week" }).click();
  if (await read("dsx.variable.filters") !== "Day,Week,Month") errors.push("multi segments did not preserve authored option order");
  await multi.getByRole("button", { name: "Day" }).click();
  if (await read("dsx.variable.filters") !== "Week,Month") errors.push("multi segment toggle did not remove an active ID");

  const single = page.locator(".single");
  if (await single.getAttribute("role") !== "radiogroup" || await single.locator('[role="radio"]').count() !== 3) {
    errors.push("single segmentedButton lacks radio semantics");
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  await single.getByRole("radio", { name: "Grid" }).focus();
  await single.getByRole("radio", { name: "Grid" }).press("ArrowLeft");
  if (await read("dsx.variable.view") !== "Detail") errors.push("RTL segmented arrow navigation did not mirror inline direction");
  await page.evaluate(() => { document.documentElement.dir = "ltr"; });

  const refresh = page.locator(".dsx-refreshable");
  await refresh.getByRole("button", { name: "Refresh" }).click();
  if (await read("dsx.variable.refreshes") !== 1 || await refresh.getAttribute("aria-busy") !== "true") {
    errors.push("refresh action/busy handshake did not start");
  }
  await set("busy", false);
  await page.waitForTimeout(80);
  if (await refresh.getAttribute("aria-busy") !== "false" || await refresh.getAttribute("data-dsx-refreshing") !== "false") {
    errors.push("refresh indicator did not follow the real busy flag to completion");
  }

  const desktop = await page.evaluate(() => ({
    segment: document.querySelector(".dsx-segmented-button-item")?.getBoundingClientRect().height ?? 0,
    row: document.querySelector(".dsx-table tbody td")?.getBoundingClientRect().height ?? 0,
  }));
  if (desktop.segment < 36 || desktop.segment > 40 || desktop.row < 36 || desktop.row > 40) {
    errors.push(`desktop precision density diverged: ${JSON.stringify(desktop)}`);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await set("busy", true);
  await refresh.getByRole("button", { name: "Refresh" }).click();
  const animation = await refresh.locator(".dsx-refresh-symbol").evaluate((element) => getComputedStyle(element).animationName);
  if (animation !== "none") errors.push(`reduced-motion refresh still animates (${animation})`);
  await set("busy", false);
  await page.waitForTimeout(80);

  await page.setViewportSize({ width: 320, height: 800 });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    segment: document.querySelector(".dsx-segmented-button-item")?.getBoundingClientRect().height ?? 0,
    calendarDay: document.querySelector(".dsx-calendar-day")?.getBoundingClientRect().height ?? 0,
    refresh: document.querySelector(".dsx-refresh-button")?.getBoundingClientRect().height ?? 0,
  }));
  if (mobile.overflow > 1) errors.push(`320px viewport overflowed by ${mobile.overflow}px`);
  for (const [name, height] of Object.entries({ segment: mobile.segment, calendar: mobile.calendarDay, refresh: mobile.refresh })) {
    if (height < 44) errors.push(`${name} mobile target is ${height}px (<44px)`);
  }

  if (errors.length === 0) {
    console.log(`✓ [${engine}] data controls: table/calendar/radio/segments/refresh, bindings, keyboard, RTL, reduced motion, responsive density`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
