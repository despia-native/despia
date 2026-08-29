//
//  skills-examples-browser.ts - the Skills example app (OpenSource/Skills/examples, the
//  worked app behind writing-an-app.md and designing-an-app.md) DRIVEN, not admired: every
//  screen reached under a real pointer, all four feed states rendered, and the navigation
//  SEMANTICS the skills teach asserted structurally - Back and Close POP (the page-frame
//  count comes back down; the guarded-back pattern rides the `nav.*` reserved view whose
//  unit pins are packages/kernel/test/nav-view.test.ts), a dismissed paywall lands on the
//  detail that opened it, the destructive settings action presents its confirmDialog, and
//  the dark scheme actually flips the token ground. lint/review/build prove the sources;
//  only this proves the app. Found on its first run: back-as-href stacking a second feed,
//  and `nav.canPop` absent on this renderer.
//

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../cli/src/config.ts";
import { buildProject } from "../../cli/src/build.ts";
import { startDevServer } from "../../cli/src/dev.ts";
import { launchBrowser } from "./browser-engine.ts";
import type { Page } from "playwright-core";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Skills/examples");
const SHOTS = process.env["SHOTS"];
if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });

const work = mkdtempSync(join(tmpdir(), "skills-examples-browser-"));
const root = join(work, "examples");
cpSync(EXAMPLES, root, { recursive: true });
rmSync(join(root, "dist"), { recursive: true, force: true });

const config = loadConfig(root);
buildProject(config);
// the intended face for the shots: the app is copied out of the repo, so the resolver
// cannot find the Type satellite on its own - hand it the dir the way a test does
const TYPE_FONTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Type/vendor/inter");
const server = await startDevServer(config, { port: 0, watch: false, log: () => {}, fontsDir: TYPE_FONTS });
const base = `http://127.0.0.1:${server.port}`;

const errors: string[] = [];
const browser = await launchBrowser("chromium");
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  const shot = async (name: string): Promise<void> => {
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name) });
  };
  const see = async (text: string, where: string): Promise<void> => {
    const found = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
    if (!found) errors.push(`${where}: expected to see "${text}"`);
  };
  // navigation frames only: a page-tier frame's class is exactly "dsx-frame" (chain
  // sheets/covers carry a tier suffix), the same scoping nav.stack itself applies
  const pageFrames = (p: Page): Promise<number> =>
    p.evaluate(() => [...document.querySelectorAll(".dsx-frame")].filter((e) => e.className === "dsx-frame").length);
  const expectPath = (want: string, where: string): void => {
    const got = new URL(page.url()).pathname;
    if (got !== want) errors.push(`${where}: expected ${want}, got ${got}`);
  };

  // 1 - the feed: the grouped list renders with its section and all four rows
  await page.goto(`${base}/`, { waitUntil: "load" });
  await see("NEARBY", "feed");
  await see("Ridgeline Loop", "feed");
  await see("Cedar Canyon", "feed");
  await shot("01-feed.png");

  // ROW INTEGRITY - the owner's zoomed-screenshot class of defect, asserted structurally:
  // no row text overflows its box (an overflow is an ellipsis or a wrap: in a list row the
  // default data renders WHOLE), the declared 36pt tile measures 36 (the fixed-frame
  // contract cssmap now pins), and a two-line row stays a row, not a card (height ceiling).
  const rowIntegrity = await page.evaluate(() => {
    const problems: string[] = [];
    const rows = [...document.querySelectorAll('[data-dsx-owner="TrailRow"].dsx-hstack')]
      .filter((r) => r.querySelector(":scope > .dsx-vstack") !== null);
    if (rows.length !== 4) problems.push(`expected 4 trail rows, found ${rows.length}`);
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.height > 76) problems.push(`row is ${Math.round(r.height)}px tall - a list row, not a card`);
      const tile = row.querySelector(":scope > .dsx-vstack")?.getBoundingClientRect();
      if (tile === undefined || Math.round(tile.width) !== 36) problems.push(`declared 36pt tile measured ${tile === undefined ? "missing" : Math.round(tile.width)}px`);
      for (const t of row.querySelectorAll(".dsx-text")) {
        const el = t as HTMLElement;
        if (el.scrollWidth > el.clientWidth + 1) problems.push(`text overflows its box: "${(el.textContent ?? "").slice(0, 24)}"`);
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set([...range.getClientRects()].map((b) => Math.round(b.top)));
        if (lines.size > 1) problems.push(`text wrapped in a list row: "${(el.textContent ?? "").slice(0, 24)}"`);
      }
    }
    return problems;
  });
  for (const p of rowIntegrity) errors.push(`feed row integrity: ${p}`);

  // THE CONTROL MUST NOT ASSEMBLE ITSELF. The segmented indicator's geometry rides four
  // custom properties measured from the selected option, and the FIRST measurement is
  // taken pre-layout, while option one still spans the whole track. With a transition on
  // the base rule that correction animated: the pill entered 310px wide, covering three
  // of its four options, and shrank into place over ~900ms on every single load. It is
  // invisible to a settled screenshot and to every assertion that waits, so it is checked
  // HERE, on the first frame after load, against the option it sits on.
  const indicatorAtRest = await page.evaluate(() => {
    const problems: string[] = [];
    for (const seg of document.querySelectorAll(".dsx-segmented")) {
      const indicator = seg.querySelector(".dsx-segmented-indicator");
      const option = seg.querySelector(".dsx-segmented-option");
      if (indicator === null || option === null) continue;
      const i = indicator.getBoundingClientRect();
      const o = option.getBoundingClientRect();
      if (Math.abs(i.width - o.width) > 1.5) {
        problems.push(`the indicator is ${Math.round(i.width)}px over a ${Math.round(o.width)}px option - it is animating into place`);
      }
      if (i.right > seg.getBoundingClientRect().right + 1) problems.push("the indicator overhangs its own track");
    }
    return problems;
  });
  for (const p of indicatorAtRest) errors.push(`segmented on load: ${p}`);

  // 2 - all four states, one tap each (designing-an-app.md section 5)
  await page.getByText("Loading", { exact: true }).click();
  await page.waitForTimeout(200);
  await shot("02-loading.png");
  await page.getByText("Empty", { exact: true }).click();
  await page.waitForTimeout(200);
  await see("No trails yet", "empty state");
  await page.getByText("Error", { exact: true }).click();
  await page.waitForTimeout(200);
  await see("Trails did not load", "error state");
  await page.getByText("Content", { exact: true }).click();
  await page.waitForTimeout(200);

  // 3 - a row tap pushes detail; Back POPS (frame count comes back down - the
  //     back-as-href regression stacked a second feed here and can never again)
  await page.getByText("Ridgeline Loop").first().click();
  await page.waitForTimeout(400);
  expectPath("/detail", "row tap");
  await see("Start hike", "detail");
  if ((await pageFrames(page)) !== 2) errors.push("push: expected 2 page frames");
  await shot("03-detail.png");
  await page.getByLabel("Back").click();
  await page.waitForTimeout(400);
  expectPath("/", "back from detail");
  if ((await pageFrames(page)) !== 1) errors.push("back must POP: expected 1 page frame");

  // 4 - the pro trail carries the paywall prompt; Close pops back to THE DETAIL IT
  //     CAME FROM (dismiss returns where you came from), then Back pops home
  await page.getByText("Summit Traverse").first().click();
  await page.waitForTimeout(400);
  await see("part of Pro", "pro prompt");
  await page.getByText("See Trails Pro", { exact: true }).click();
  await page.waitForTimeout(400);
  expectPath("/paywall", "paywall link");
  await see("$29.99 / year", "paywall");
  await page.getByText("Monthly", { exact: true }).click();
  await page.waitForTimeout(200);
  await shot("04-paywall.png");
  await page.getByLabel("Close").click();
  await page.waitForTimeout(400);
  expectPath("/detail", "paywall close pops to its opener");
  await page.getByLabel("Back").click();
  await page.waitForTimeout(400);
  expectPath("/", "back home");
  if ((await pageFrames(page)) !== 1) errors.push("after the round trip: expected 1 page frame");

  // 5 - onboarding: three steps, and leaving POPS back to the feed
  await page.getByText("Take the tour").click();
  await page.waitForTimeout(400);
  await see("Trails picked for you", "onboarding");
  await shot("05-onboarding.png");
  await page.getByText("Continue", { exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByText("Continue", { exact: true }).click();
  await page.waitForTimeout(200);
  await see("Hike it, log it", "onboarding step 3");
  await page.getByText("Start exploring", { exact: true }).click();
  await page.waitForTimeout(400);
  expectPath("/", "leaving onboarding");

  // 6 - settings: the destructive action is confirmed before it acts
  await page.getByLabel("Settings").click();
  await page.waitForTimeout(400);
  await see("New trail alerts", "settings");
  await shot("06-settings.png");
  await page.getByText("Clear saved trails", { exact: true }).click();
  await page.waitForTimeout(300);
  const confirmed = await page.getByText("Saved trails are removed", { exact: false }).first().isVisible().catch(() => false);
  if (!confirmed) errors.push("settings: confirmDialog never presented");

  // NAMED STYLES, asserted where they are actually consumed. Settings styles itself the
  // idiomatic way - `<style as="card" background="secondaryGroupedBackground" radius="16"/>`
  // plus class="card" - which the web compiler used to drop on a `default: break`, so every
  // card painted transparent at radius 0 while both native renderers honoured it. A unit
  // test over the emitted CSS did not exist and would not have been enough: this asserts the
  // PAINTED result, and that a row holding a switch stays a row rather than inflating to the
  // switch's old 48px hit box.
  const named = await page.evaluate(() => {
    const problems: string[] = [];
    const cards = [...document.querySelectorAll(".dsx-vstack")]
      .filter((e) => (e.getAttribute("class") ?? "").split(/\s+/).includes("card"));
    if (cards.length < 2) problems.push(`expected the settings groups to carry class="card", found ${cards.length}`);
    for (const card of cards) {
      const cs = getComputedStyle(card);
      const alpha = /rgba\([^)]*,\s*0\s*\)/.test(cs.backgroundColor);
      if (alpha || cs.backgroundColor === "transparent") problems.push("a named style's background never painted");
      if (Math.round(Number.parseFloat(cs.borderTopLeftRadius)) !== 16) problems.push(`named radius resolved to ${cs.borderTopLeftRadius}, declared 16`);
    }
    const header = [...document.querySelectorAll(".dsx-text")].find((e) => (e.textContent ?? "").trim() === "PREFERENCES");
    if (header !== undefined) {
      const cs = getComputedStyle(header);
      if (Math.round(Number.parseFloat(cs.fontSize)) !== 13) problems.push(`named fontSize resolved to ${cs.fontSize}, declared 13`);
      if (Number(cs.fontWeight) < 500) problems.push(`named fontWeight resolved to ${cs.fontWeight}, declared semibold`);
    }
    for (const toggle of document.querySelectorAll(".dsx-toggle")) {
      const b = toggle.getBoundingClientRect();
      if (b.height > 36) problems.push(`the switch's layout box is ${Math.round(b.height)}px tall - it is a pill, not a square`);
      const input = toggle.querySelector("input");
      if (input !== null) {
        const hit = input.getBoundingClientRect();
        if (hit.height < 44 || hit.width < 44) problems.push(`the switch's hit rect is ${Math.round(hit.width)}x${Math.round(hit.height)}, below the 44pt floor`);
      }
    }
    return problems;
  });
  for (const p of named) errors.push(`settings named styles: ${p}`);

  // 7 - dark: the token ground actually flips (the feed's groupedBackground goes dark)
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const ground = await page.evaluate(() => {
    const frame = [...document.querySelectorAll(".dsx-frame")].find((e) => e.className === "dsx-frame");
    const el = frame?.firstElementChild;
    return el === null || el === undefined ? "" : getComputedStyle(el).backgroundColor;
  });
  const channels = /rgba?\((\d+), (\d+), (\d+)/.exec(ground);
  const luma = channels === null ? 255 : (Number(channels[1]) + Number(channels[2]) + Number(channels[3])) / 3;
  if (luma > 100) errors.push(`dark scheme: the feed ground stayed light (${ground})`);
  await shot("07-feed-dark.png");
} finally {
  await browser.close();
  await server.close();
  rmSync(work, { recursive: true, force: true });
}

if (errors.length === 0) {
  console.log("[skills-examples-browser] OK - 7 screens/states walked, pops pop, the dialog confirms, dark is dark.");
  process.exit(0);
}
console.error(`[skills-examples-browser] ${errors.length} failure(s):`);
for (const e of errors) console.error("  ✗ " + e);
process.exit(1);
