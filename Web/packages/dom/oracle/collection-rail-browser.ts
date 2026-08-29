// Real-engine acceptance for the HORIZONTAL RAIL, measured rather than argued.
//
// A horizontal collection's rows KEEP THE SIZE THEY ASK FOR and let the content overflow
// into scroll. That is what `ScrollView(.horizontal) { LazyHStack }` and `LazyRow` do, so it
// is what the web owes. Web flex disagrees by default (`flex-shrink: 1`), and the failure is
// silent in the worst way: `width: 150px` stays in the markup, nothing warns, and only
// `getComputedStyle().width` reports the squeezed number - after `object-fit: cover` has
// already cropped art nobody authored. Measured on a 375pt phone with the rule removed and
// the package rebuilt: a rail of 150px posters rendered them at 23.9px each (flex: 0 1 auto)
// with scrollWidth equal to clientWidth, so the overflow was absorbed rather than scrolled.
//
// The rule cannot be checked by reading the sheet. `.dsx-row` is `display: contents`, so a
// `flex` declaration ON the row is inert and the ROW'S CHILD is the list's real flex item;
// a sheet can carry a correct-looking rule that reaches nothing. Only a real engine reports
// which box actually got the width, which is why this file exists.
import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="rail-harness">
  <head>
    <variable as="posters">return [{id:1},{id:2},{id:3},{id:4},{id:5},{id:6},{id:7},{id:8},{id:9},{id:10},{id:11},{id:12}]</variable>
  </head>
  <list class="rail" axis="horizontal" bind="posters" key="id" spacing="8">
    <stack class="poster"/>
  </list>
  <list class="columns" axis="horizontal" bind="posters" key="id" spacing="8">
    <stack class="column" grow="width"/>
  </list>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia-native/compiler/component";
  import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
  import { instantiate } from "@despia-native/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS, STRUCTURAL_CONTROLS_CSS } from "@despia-native/dom/theme";
  import { registerStructuralControls } from "@despia-native/dom/structural-controls";

  registerStructuralControls();
  const ir = compileComponent("RailBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.RailBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, STRUCTURAL_CONTROLS_CSS,
    "@layer dsx-components { .rail-harness { box-sizing:border-box; width:375px; }" +
    " .rail, .columns { width:375px; }" +
    " .poster, .column { width:150px; height:90px; background:#333; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__DSX_RAIL_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "collection-rail-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("collection rail harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  // A 375pt phone is the width the squeeze was first measured at.
  const page = await browser.newPage({ viewport: { width: 375, height: 800 }, locale: "en-US" });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  await page.setContent("<!doctype html><html lang='en-US'><head></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_RAIL_READY__?: boolean }).__DSX_RAIL_READY__ === true);

  const widthOf = (selector: string) => page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    return el === null ? -1 : Number.parseFloat(getComputedStyle(el).width);
  }, selector);

  // 1. A DECLARED WIDTH SURVIVES. Twelve 150px posters cannot fit a 375px rail, so flex's
  //    default would shrink every one of them; the author said 150 and gets 150.
  const poster = await widthOf(".poster");
  if (Math.abs(poster - 150) > 1) {
    errors.push(`a rail poster declared width="150" measured ${poster}px - the rail squeezed it instead of scrolling`);
  }

  // 2. THE OVERFLOW BECAME SCROLL rather than compression: the content is wider than the box.
  const scrolls = await page.evaluate(() => {
    const list = document.querySelector(".rail");
    return list !== null && list.scrollWidth > list.clientWidth + 1;
  });
  if (!scrolls) errors.push("a rail wider than its box must scroll its overflow, never absorb it");

  // 3. grow="width" STILL WINS. Keeping declared sizes must not take away the author's way of
  //    saying "these are columns, divide the width" (runtime-pressure R17). Both rules live in
  //    @layer dsx-elements, so this is decided by specificity, and specificity is exactly the
  //    kind of claim that deserves a measurement rather than a hand-computed count.
  const column = await widthOf(".column");
  if (column >= 150) {
    errors.push(`grow="width" no longer divides the rail: a column measured ${column}px, still at its declared size`);
  }
  if (column <= 0) errors.push(`grow="width" column measured ${column}px`);

  if (errors.length === 0) {
    console.log(`✓ [${engine}] collection rail: declared widths survive, overflow scrolls, grow="width" still divides`);
  }
} finally {
  await browser.close();
}
if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
