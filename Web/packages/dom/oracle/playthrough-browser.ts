//
//  playthrough-browser.ts — PLAY Crate Blaster to a WIN in a real browser: real
//  keypresses fire the shots, the 2D HUD pips despawn as data, the score climbs through
//  the trigger goal, the game-over overlay springs in on the motion kernel, and R
//  restarts the whole game. The full production loop, end to end, no shortcuts.
//  Usage: node packages/dom/oracle/playthrough-browser.ts [outDir]
//

import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const engine = browserEngine();
const outDir = process.argv[2] ?? join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "demo/shots", engine, "playthrough",
);
mkdirSync(outDir, { recursive: true });

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  const line = `${label}${detail === "" ? "" : ` — ${detail}`}`;
  if (ok) console.log(`  ✓ ${line}`); else { failures.push(line); console.log(`  ✗ ${line}`); }
};

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`); });

  const KERNEL_URL = `http://localhost:${port}/demo/site/dist/kernel/src/index.js`;
  const hudPips = async (): Promise<number> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    const hud = k.sceneBusResolve("hud");
    if (hud === null) return -1;
    const stackNode = hud.nodes().find((n: { kind: string }) => n.kind === "group");
    return stackNode === undefined ? -1 : stackNode.children.length;
  }, KERNEL_URL);
  const stat = async (re: RegExp): Promise<string> =>
    page.evaluate((source) => document.body.innerText.match(new RegExp(source))?.[1] ?? "?", re.source);

  console.log("\n▸ act 1 — boot");
  await page.goto(`http://localhost:${port}/demo/site/game/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene canvas", { timeout: 10000 });
  await page.waitForTimeout(2500);   // the opening crates settle
  check(await stat(/shots left (\d+)/) === "6", "the game opens with 6 shots");
  check(await hudPips() === 6, "the 2D HUD shows 6 sprite pips", String(await hudPips()));
  check(!(await page.getByText("YOU WIN").isVisible()), "no visible overlay while playing");
  await page.screenshot({ path: join(outDir, "01-open.png") });

  console.log("\n▸ act 2 — play to the win (3 real Space presses, 1 score each)");
  await page.locator(".dsx-scene canvas").last().click({ position: { x: 40, y: 40 } });
  check(await stat(/shots left (\d+)/) === "6", "the mouse focus click did not fire touch=\"tap\"");
  for (let shot = 1; shot <= 3; shot += 1) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(2600);   // the ball's full flight into the goal
    console.log(`  · after shot ${shot}: score ${await stat(/Score (\d+)/)} · shots ${await stat(/shots left (\d+)/)}`);
  }
  const score = await stat(/Score (\d+)/);
  check(Number(score) >= 3, "three shots scored three goals", `score ${score}`);
  const shotsLeft = Number(await stat(/shots left (\d+)/));
  check(shotsLeft === 3, "each Space press spent exactly one shot", `${shotsLeft} left`);
  check(await hudPips() === shotsLeft, "the HUD pips track the spent shots exactly", `${await hudPips()} pips = ${shotsLeft} shots`);
  await page.waitForTimeout(400);      // the overlay's spring
  check(await page.getByText("YOU WIN").isVisible(), "the WIN overlay sprang in");
  await page.screenshot({ path: join(outDir, "02-won.png") });

  console.log("\n▸ act 3 — R restarts the whole game");
  await page.keyboard.press("KeyR");
  await page.waitForTimeout(600);
  check(await stat(/Score (\d+)/) === "0", "score reset to 0");
  check(await stat(/shots left (\d+)/) === "6", "shots reset to 6");
  check(await hudPips() === 6, "the HUD pips respawned", String(await hudPips()));
  await page.getByText("YOU WIN").waitFor({ state: "hidden", timeout: 3000 });
  check(!(await page.getByText("YOU WIN").isVisible()), "the overlay left");
  await page.screenshot({ path: join(outDir, "03-restarted.png") });

  check(pageErrors.length === 0, "no page errors across the whole playthrough",
    pageErrors.slice(0, 3).join(" | "));
  await close(); serverClosed = true;
} finally {
  await browser.close();
  if (!serverClosed) await close();
}

console.log(`\nshots → ${outDir}`);
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\n✓ Crate Blaster played to a win and restarted — the whole loop works");
