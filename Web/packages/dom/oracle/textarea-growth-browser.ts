// Real-engine acceptance for the AUTO-GROWING text area.
//
// `<textarea minLines maxLines>` is the multi-line input, and its contract is the one iOS
// states with `lineLimit(min...max)`: the box starts at minLines, GROWS WITH ITS RENDERED
// CONTENT, and stops at maxLines, after which it scrolls. Every word of that has to be true
// of wrapped text, not just of typed newlines - a tagline is one long sentence with no "\n"
// in it, and the web twin used to count "\n" and therefore never grew for it at all. That is
// exactly the bug this file exists to keep fixed, so the growth case here types NO newlines.

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="grow-harness">
  <head>
    <variable as="tagline">return ''</variable>
    <variable as="edits">return 0</variable>
  </head>
  <textarea class="subject" bind="dsx.variable.tagline" minLines="1" maxLines="4"
            placeholder="Tagline" on:change="dsx.variable.edits += 1"/>
  <textarea class="floor" bind="dsx.variable.tagline" minLines="3" maxLines="9"/>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia-native/compiler/component";
  import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
  import { instantiate } from "@despia-native/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS } from "@despia-native/dom/theme";

  const ir = compileComponent("GrowBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.GrowBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS,
    "@layer dsx-components { .grow-harness { box-sizing:border-box; width:320px; gap:16px; padding:16px; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__dsxGrowRead = (expression) => instance.ctx.store.eval(expression, null);
  window.__DSX_GROW_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "textarea-growth-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("textarea growth harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 900 }, locale: "en-US" });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  await page.setContent("<!doctype html><html lang='en-US'><head></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_GROW_READY__?: boolean }).__DSX_GROW_READY__ === true);

  const subject = page.locator("textarea.subject");
  const height = async (selector: string): Promise<number> =>
    await page.locator(selector).evaluate((el) => el.getBoundingClientRect().height);
  const rows = async (selector: string): Promise<number> =>
    await page.locator(selector).evaluate((el) => (el as HTMLTextAreaElement).rows);

  // THE FLOOR IS minLines, not a fixed rem. An empty one-line field must be one line tall,
  // and it has to be visibly shorter than a three-line one beside it.
  const emptyOne = await height("textarea.subject");
  const emptyThree = await height("textarea.floor");
  if (await rows("textarea.subject") !== 1) errors.push(`minLines=1 did not floor at one row (rows=${await rows("textarea.subject")})`);
  if (emptyThree <= emptyOne + 8) {
    errors.push(`minLines is not honoured: 1-line ${emptyOne}px vs 3-line ${emptyThree}px`);
  }

  // GROWTH ON SOFT WRAP. No newline is typed - this is one sentence that wraps in a 320px
  // column, which is precisely what the "\n"-counting implementation could never grow for.
  await subject.click();
  await subject.fill("Every set, every session, tracked in seconds and kept for later");
  await page.waitForTimeout(60);
  const grown = await height("textarea.subject");
  const grownRows = await rows("textarea.subject");
  if (grownRows < 2) errors.push(`soft-wrapped text did not grow the box (rows=${grownRows})`);
  if (grown <= emptyOne + 8) errors.push(`soft-wrapped growth is not visible: ${emptyOne}px -> ${grown}px`);

  // THE CAP HOLDS, and past it the box scrolls rather than growing without end.
  await subject.fill(Array.from({ length: 40 }, (_, i) => `line ${i} of a long tagline that wraps`).join(" "));
  await page.waitForTimeout(60);
  const capped = await height("textarea.subject");
  const cappedRows = await rows("textarea.subject");
  if (cappedRows !== 4) errors.push(`maxLines=4 did not cap the grown box (rows=${cappedRows})`);
  const scrolls = await subject.evaluate((el) => (el as HTMLTextAreaElement).scrollHeight > el.clientHeight + 1);
  if (!scrolls) errors.push("a capped text area must scroll its overflow rather than clip it");

  // IT SHRINKS BACK. A box that only ever ratchets upward is the classic autosize bug.
  await subject.fill("Short");
  await page.waitForTimeout(60);
  const shrunk = await height("textarea.subject");
  if (await rows("textarea.subject") !== 1) errors.push(`the box did not shrink back to its floor (rows=${await rows("textarea.subject")})`);
  if (shrunk >= capped - 8) errors.push(`shrink-back is not visible: ${capped}px -> ${shrunk}px`);

  // on:change is the event a text area is edited through, and all three renderers fire it.
  const edits = await page.evaluate(() =>
    (window as unknown as { __dsxGrowRead: (e: string) => unknown }).__dsxGrowRead("dsx.variable.edits"));
  if (Number(edits) < 1) errors.push(`on:change never fired on a textarea (edits=${String(edits)})`);

  if (errors.length === 0) {
    console.log(`✓ [${engine}] textarea growth: minLines floor, soft-wrap growth, maxLines cap with scroll, shrink-back, on:change`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
