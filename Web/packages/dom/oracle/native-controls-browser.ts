// Real-engine interaction gate for DSX's semantic browser-native controls. The
// harness is bundled from the published package entries, then driven through DOM,
// keyboard and pointer APIs in every locked browser engine.

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="native-harness">
  <head>
    <variable as="plan">return "free"</variable>
    <variable as="when">return "2026-07-23T09:45:00Z"</variable>
    <variable as="city">return ""</variable>
    <variable as="code">return ""</variable>
    <variable as="low">return 20</variable>
    <variable as="high">return 80</variable>
    <variable as="changes">return 0</variable>
    <variable as="selects">return 0</variable>
    <variable as="completes">return 0</variable>
  </head>
  <picker class="override-picker" bind="plan" options="free,pro,enterprise" label="Plan" on:change="dsx.variable.changes = dsx.variable.changes + 1"/>
  <wheelpicker bind="plan" options="free,pro,enterprise" label="Plan wheel" on:change="dsx.variable.changes = dsx.variable.changes + 1"/>
  <datepicker bind="when" mode="datetime" label="Departure" on:change="dsx.variable.changes = dsx.variable.changes + 1"/>
  <combobox bind="city" options="Berlin,Paris,Madrid" placeholder="City" on:change="dsx.variable.changes = dsx.variable.changes + 1" on:select="dsx.variable.selects = dsx.variable.selects + 1"/>
  <otp bind="code" length="4" on:change="dsx.variable.changes = dsx.variable.changes + 1" on:complete="dsx.variable.completes = dsx.variable.completes + 1"/>
  <rangeslider bindLow="low" bindHigh="high" min="0" max="100" step="5" on:change="dsx.variable.changes = dsx.variable.changes + 1"/>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia/compiler/component";
  import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
  import { instantiate } from "@despia/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS } from "@despia/dom/theme";
  import { NATIVE_CONTROLS_CSS, registerNativeControls } from "@despia/dom/native-controls";

  registerNativeControls();
  const ir = compileComponent("NativeBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.NativeBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, NATIVE_CONTROLS_CSS,
    "@layer dsx-components { .native-harness { box-sizing:border-box; width:min(100%,720px); gap:16px; padding:16px; margin:auto; } .override-picker .dsx-picker-select { border-radius:3px; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__dsxNativeRead = (expression) => instance.ctx.store.eval(expression, null);
  window.__DSX_NATIVE_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "native-controls-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("native controls browser harness did not bundle");

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
  await page.waitForFunction(() => (window as unknown as { __DSX_NATIVE_READY__?: boolean }).__DSX_NATIVE_READY__ === true);

  const read = async (expression: string): Promise<unknown> => await page.evaluate((value) => {
    const fn = (window as unknown as { __dsxNativeRead: (expr: string) => unknown }).__dsxNativeRead;
    return fn(value);
  }, expression);

  const picker = page.locator("select.dsx-picker-select");
  const wheel = page.locator("select.dsx-wheelpicker-select");
  const date = page.locator("input.dsx-datepicker-input");
  const combo = page.locator("input.dsx-combobox-input");
  const otp = page.locator("input.dsx-otp-input");
  const low = page.locator("input.dsx-rangeslider-low");
  const high = page.locator("input.dsx-rangeslider-high");

  if (await picker.getAttribute("aria-label") !== "Plan") errors.push("picker accessible label missing");
  if (await wheel.getAttribute("aria-label") !== "Plan wheel") errors.push("wheelpicker accessible label missing");
  if (await combo.getAttribute("role") !== "combobox") errors.push("combobox role missing");
  if (await otp.getAttribute("autocomplete") !== "one-time-code") errors.push("OTP autofill semantic missing");
  if (await low.getAttribute("aria-label") !== "Lower value" || await high.getAttribute("aria-label") !== "Upper value") {
    errors.push("range thumb labels missing");
  }

  await picker.selectOption("pro");
  await page.waitForTimeout(30);
  if (await read("dsx.variable.plan") !== "pro") errors.push("picker did not write its bound String ID");

  await wheel.selectOption("enterprise");
  await page.waitForTimeout(30);
  if (await read("dsx.variable.plan") !== "enterprise") errors.push("wheelpicker did not write its bound String ID");

  await date.fill("2026-08-04T16:30");
  await date.dispatchEvent("change");
  await page.waitForTimeout(30);
  if (await read("dsx.variable.when") !== "2026-08-04T16:30:00Z") errors.push("datepicker wire value diverged from ISO UTC seconds");

  await combo.focus();
  await combo.fill("Ber");
  await combo.press("ArrowDown");
  await combo.press("Enter");
  await page.waitForTimeout(40);
  if (await read("dsx.variable.city") !== "Berlin") errors.push("combobox keyboard selection did not write the option value");
  if (await read("dsx.variable.selects") !== 1) errors.push("combobox on:select did not fire exactly once");

  await otp.fill("1a٢3٤5");
  await page.waitForTimeout(40);
  if (await read("dsx.variable.code") !== "1٢3٤") errors.push("OTP paste was not Unicode-digit filtered and length-clamped");
  if (await read("dsx.variable.completes") !== 1) errors.push("OTP on:complete did not fire exactly once");

  await low.focus();
  await low.press("End");
  await page.waitForTimeout(120);
  if (await read("dsx.variable.low") !== 80) errors.push("range low thumb crossed its high thumb or failed keyboard commit");

  const authoredRadius = await picker.evaluate((element) => getComputedStyle(element).borderRadius);
  if (authoredRadius !== "3px") errors.push(`authored DSX layer did not override picker default (${authoredRadius})`);
  const desktopHeights = await page.evaluate(() => ({
    picker: document.querySelector(".dsx-picker-select")?.getBoundingClientRect().height ?? 0,
    date: document.querySelector(".dsx-datepicker-input")?.getBoundingClientRect().height ?? 0,
    combo: document.querySelector(".dsx-combobox-input")?.getBoundingClientRect().height ?? 0,
  }));
  for (const [name, height] of Object.entries(desktopHeights)) {
    if (height < 36 || height > 40) errors.push(`${name} desktop control height is ${height}px (expected compact 36–40px)`);
  }

  await page.setViewportSize({ width: 320, height: 780 });
  await page.waitForTimeout(30);
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    pickerHeight: document.querySelector(".dsx-picker-select")?.getBoundingClientRect().height ?? 0,
    dateHeight: document.querySelector(".dsx-datepicker-input")?.getBoundingClientRect().height ?? 0,
    rangeHeight: document.querySelector(".dsx-rangeslider")?.getBoundingClientRect().height ?? 0,
  }));
  if (mobile.overflow > 1) errors.push(`320px viewport overflowed by ${mobile.overflow}px`);
  for (const [name, height] of Object.entries({ picker: mobile.pickerHeight, date: mobile.dateHeight, range: mobile.rangeHeight })) {
    if (height < 44) errors.push(`${name} touch target is ${height}px (<44px)`);
  }

  if (errors.length === 0) {
    console.log(`✓ [${engine}] native controls: semantic HTML, keyboard, bindings, events, hostile paste, override, 320px layout`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
