//
//  input-browser.ts — drive the G4 UNIFIED INPUT surface in a REAL browser, on the REAL
//  app page (packages/scene-demo GameDemo.dsx, served at /game).
//
//  Not a unit test: it boots the shipped site, presses REAL keys through the CDP keyboard
//  (page.keyboard.press / .down / .up), and asserts that (a) the declared `on:input.jump`
//  handler fired through the standard handler path, (b) `dsx.input.move` moved as an axis
//  read, (c) the diagonal normalizes to the corpus-pinned 0.707107, (d) the press edge fires
//  ONCE while a key is held, and (e) a synthesized gamepad snapshot beats the digital keys.
//
//  Usage:
//    npm run build:demo
//    DSX_BROWSER_EXECUTABLE=… node packages/dom/oracle/input-browser.ts
//

import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const engine = browserEngine();
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  const line = `${label}${detail === "" ? "" : ` — ${detail}`}`;
  if (ok) console.log(`  ✓ ${line}`);
  else { failures.push(line); console.log(`  ✗ ${line}`); }
};
const near = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) <= eps;

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`); });

  console.log("\n▸ booting the app");
  await page.goto(`http://localhost:${port}/demo/site/game/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene canvas", { timeout: 10000 });
  check(true, "the page mounted and the scene rendered");

  // The kernel + dom modules the page itself loaded (ES modules cache per URL, so these
  // are the very instances the mounted surface registered into).
  const KERNEL_URL = `http://localhost:${port}/demo/site/dist/kernel/src/index.js`;
  const DOM_URL = `http://localhost:${port}/demo/site/dist/dom/src/index.js`;

  const readInput = async (name: string): Promise<unknown> => page.evaluate(async ([url, key]) => {
    const k = await import(/* @vite-ignore */ url as string);
    return k.DSXState.get(`input.${key as string}`) ?? null;
  }, [KERNEL_URL, name]);

  const bindings = await page.evaluate(async (url) => {
    const d = await import(/* @vite-ignore */ url);
    return d.inputBindings().map((b: { name: string; axis: boolean; deadzone: number; keys: string[]; buttons: string[]; sticks: string[]; touch: string[] }) => b);
  }, DOM_URL);

  // ── 1 · the head declarations resolved into the live binding table ─────────────────
  const jump = bindings.find((b: { name: string }) => b.name === "jump");
  const move = bindings.find((b: { name: string }) => b.name === "move");
  check(jump !== undefined && move !== undefined, "both head <input> declarations registered",
    bindings.map((b: { name: string }) => b.name).join(", "));
  check(jump?.axis === false && jump?.keys.join(",") === "Space,ArrowUp" && jump?.buttons.join(",") === "A"
    && jump?.touch.join(",") === "tap", "jump resolved to keys+gamepad+touch",
    JSON.stringify(jump));
  check(move?.axis === true && move?.keys.join(",") === "W,A,S,D" && move?.sticks.join(",") === "leftStick"
    && near(move?.deadzone ?? 0, 0.15), "move resolved to the WASD axis + leftStick @ deadzone 0.15",
    JSON.stringify(move));

  const diagnostics = await page.evaluate(async (url) => {
    const d = await import(/* @vite-ignore */ url);
    return d.inputDiagnostics;
  }, DOM_URL);
  check(Array.isArray(diagnostics) && diagnostics.length === 0,
    "the page's declarations resolve with zero diagnostics", JSON.stringify(diagnostics));

  // ── 2 · the resting reads are the typed values, never null ─────────────────────────
  check((await readInput("jump")) === false, "dsx.input.jump rests at false");
  const rest = await readInput("move") as { x: number; y: number } | null;
  check(rest !== null && near(rest.x, 0) && near(rest.y, 0), "dsx.input.move rests at {0,0}",
    JSON.stringify(rest));

  // ── 3 · a REAL key press fires the declared handler ────────────────────────────────
  // on:input.jump="fire()" — fire() writes the ball's position AND velocity through the
  // scene bus, so a moved velocity IS the proof the handler ran through the standard path.
  const velocityOf = async (): Promise<string> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    const find = (nodes: Array<{ id: string; props: Record<string, string>; children: unknown[] }>): Record<string, string> | null => {
      for (const n of nodes) {
        if (n.id === "ball") return n.props;
        const inner = find(n.children as typeof nodes);
        if (inner !== null) return inner;
      }
      return null;
    };
    return JSON.stringify(find(k.sceneBusResolve("game")!.nodes()) ?? {});
  }, KERNEL_URL);

  const before = await velocityOf();
  const shots = async (): Promise<string> =>
    page.evaluate(() => document.body.innerText.match(/shots left (\d+)/)?.[1] ?? "?");
  await page.click(".dsx-scene");                 // focus the document, not an editable
  check(await shots() === "6", "a mouse focus click is not touch=\"tap\"", `${await shots()} shots left`);
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  const after = await velocityOf();
  check(await shots() === "5", "the first Space press spends exactly one shot", `${await shots()} shots left`);
  check(before !== after, "pressing Space fired on:input.jump (the ball state changed)",
    `${before.slice(0, 60)} → ${after.slice(0, 60)}`);

  // ── 4 · the axis READ moves under a real held key ──────────────────────────────────
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(80);
  const right = await readInput("move") as { x: number; y: number };
  check(near(right.x, 1) && near(right.y, 0), "holding D reads dsx.input.move = {1, 0}",
    JSON.stringify(right));

  await page.keyboard.down("KeyW");
  await page.waitForTimeout(80);
  const diagonal = await readInput("move") as { x: number; y: number };
  check(near(diagonal.x, 0.7071067811865475, 1e-6) && near(diagonal.y, 0.7071067811865475, 1e-6),
    "W+D normalizes the diagonal to the corpus-pinned 0.707107", JSON.stringify(diagonal));

  await page.keyboard.up("KeyD");
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(80);
  const released = await readInput("move") as { x: number; y: number };
  check(near(released.x, 0) && near(released.y, 0), "releasing both keys returns to {0,0}",
    JSON.stringify(released));

  // ── 5 · the EDGE law under a real held key ─────────────────────────────────────────
  // The demo's steer() action adds dsx.input.move.x to the cannon on each `move` edge.
  // Holding a direction must move the cannon exactly ONCE, never once per frame.
  const cannonX = async (): Promise<number> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    const find = (nodes: Array<{ id: string; props: Record<string, string>; children: unknown[] }>): string => {
      for (const n of nodes) {
        if (n.id === "cannon") return n.props["position"] ?? "";
        const inner = find(n.children as typeof nodes);
        if (inner !== "") return inner;
      }
      return "";
    };
    return Number(find(k.sceneBusResolve("game")!.nodes()).split(" ")[0] ?? "0");
  }, KERNEL_URL);

  const cannonBefore = await cannonX();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(600);                 // ~36 frames of holding
  const cannonHeld = await cannonX();
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(120);
  // one edge = one steer() = +0.35 (the transition glides toward it, so compare the
  // AUTHORED base through the bus, which reports the resolved position)
  check(Math.abs(cannonHeld - cannonBefore) < 0.5,
    "holding D fired the move edge ONCE, not once per frame",
    `${cannonBefore.toFixed(3)} → ${cannonHeld.toFixed(3)} over ~36 frames`);

  // ── 6 · a synthesized gamepad snapshot beats the digital keys ──────────────────────
  const analog = await page.evaluate(async ([domUrl, kernelUrl]) => {
    const d = await import(/* @vite-ignore */ domUrl as string);
    const k = await import(/* @vite-ignore */ kernelUrl as string);
    d.synthesizeInput({ op: "keyDown", key: "A" });          // digital left
    d.synthesizeInput({ op: "gamepad", buttons: [], axes: [0.5, -0.5, 0, 0] });
    const live = k.DSXState.get("input.move");
    d.synthesizeInput({ op: "keyUp", key: "A" });
    d.synthesizeInput({ op: "gamepad", buttons: [], axes: [0, 0, 0, 0] });
    return live;
  }, [DOM_URL, KERNEL_URL]);
  check(near((analog as { x: number }).x, 0.4634524, 1e-5)
    && near((analog as { y: number }).y, 0.4634524, 1e-5),
    "a live stick beats the held key, at the corpus-pinned deadzone rescale",
    JSON.stringify(analog));

  // ── 7 · no page errors along the way ───────────────────────────────────────────────
  check(pageErrors.length === 0, "no page errors while driving real input",
    pageErrors.slice(0, 3).join(" | "));

  await page.close();
} finally {
  await browser.close();
  if (!serverClosed) { serverClosed = true; await close(); }
}

console.log("");
if (failures.length > 0) {
  console.error(`[input-browser] ✗ ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[input-browser] ✓ every G4 unified-input check passed in a REAL browser");
