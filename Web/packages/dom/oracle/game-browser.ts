//
//  game-browser.ts — run the REAL Crate Drop app (packages/scene-demo GameDemo.dsx) in a
//  REAL browser and check that the 3D engine actually works end to end: WebGL context,
//  prefab expansion (G1), the fixed-tick solver settling a pile (G2), the trigger goal,
//  the bus impulse verb, keyed spawn/despawn, and PIXELS on the canvas.
//
//  This is not a unit test — it boots the shipped site, walks to /game, and interrogates
//  the live scene through the same `dsx.module.scene` bus a module or an AI agent uses.
//  Usage: node packages/dom/oracle/game-browser.ts [outDir]
//

import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const engine = browserEngine();
const outDir = process.argv[2] ?? join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "demo/shots", engine, "game",
);
mkdirSync(outDir, { recursive: true });

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  ✓ ${label}${detail === "" ? "" : ` — ${detail}`}`);
  else { failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`); console.log(`  ✗ ${label}${detail === "" ? "" : ` — ${detail}`}`); }
};

type BusNode = { kind: string; id: string; props: Record<string, string>; world: number[] | null; children: BusNode[] };

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`); });

  console.log("\n▸ booting the app");
  await page.goto(`http://localhost:${port}/demo/site/game/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene canvas", { timeout: 10000 });
  check(true, "the page mounted and the scene box rendered");

  // ── 1 · is this REALLY 3D? (a live WebGL context, not a 2D fallback) ───────────────
  const gl = await page.evaluate(() => {
    const canvases = document.querySelectorAll<HTMLCanvasElement>(".dsx-scene canvas");
    const canvas = canvases.item(canvases.length - 1);
    if (canvas === null) return { ok: false, renderer: "no canvas", width: 0, height: 0 };
    // the element keeps its context; asking for the same type returns the SAME one
    const ctx = canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (ctx === null) return { ok: false, renderer: "no webgl", width: canvas.width, height: canvas.height };
    const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg === null ? String(ctx.getParameter(ctx.RENDERER))
      : String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    return { ok: true, renderer, width: canvas.width, height: canvas.height, u32: ctx.getExtension("OES_element_index_uint") !== null };
  });
  check(gl.ok, "a live WebGL context is driving the scene", `${gl.renderer} @ ${gl.width}×${gl.height}`);
  check(gl.u32 === true, "the u32 index extension is enabled (>64k-vertex models)", String(gl.u32));

  // The scene bus — the SAME handle Core/Scene (and through it any module or MCP agent)
  // drives. The site serves the kernel as an ES module through its import map, and ES
  // modules are cached per URL, so importing that URL here hands back the very module
  // instance the mounted <scene> registered itself into.
  const KERNEL_URL = `http://localhost:${port}/demo/site/dist/kernel/src/index.js`;
  const busNodes = async (): Promise<BusNode[]> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    return k.sceneBusResolve("game")!.nodes() as BusNode[];
  }, KERNEL_URL);
  const busStats = async (): Promise<Record<string, number>> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    return k.sceneBusResolve("game")!.stats();
  }, KERNEL_URL);
  const busCamera = async (): Promise<string> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    return k.sceneBusResolve("game")!.camera().position as string;
  }, KERNEL_URL);
  const busContacts = async (): Promise<Array<{ a: string; b: string; depth: number }>> =>
    page.evaluate(async (url) => {
      const k = await import(/* @vite-ignore */ url);
      return k.sceneBusResolve("game")!.contacts();
    }, KERNEL_URL);
  const findNode = (nodes: BusNode[], id: string): BusNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const inner = findNode(n.children, id);
      if (inner !== null) return inner;
    }
    return null;
  };
  const countKind = (nodes: BusNode[], kind: string): number =>
    nodes.reduce((acc, n) => acc + (n.kind === kind ? 1 : 0) + countKind(n.children, kind), 0);

  // ── 2 · G1: did the <Crate> PREFAB expand into real scene nodes? ───────────────────
  console.log("\n▸ G1 — prefabs instantiated from data");
  let nodes = await busNodes();
  const stack = findNode(nodes, "stack");
  check(stack !== null, "the bound group exists on the bus");
  const instanceRoots = stack?.children ?? [];
  check(instanceRoots.length === 2, "two data rows produced two prefab instances", `${instanceRoots.length}`);
  const firstBody = instanceRoots[0]?.children[0];
  check(firstBody?.kind === "box", "each instance expanded to its component body (a box)", String(firstBody?.kind));
  check(firstBody?.props["color"] === "#c2703a" && instanceRoots[1]?.children[0]?.props["color"] === "#8b5cf6",
    "per-instance params resolved independently (tint from each row)",
    `${firstBody?.props["color"]} / ${instanceRoots[1]?.children[0]?.props["color"]}`);
  check(firstBody?.props["physics"] === "dynamic" && firstBody?.props["mass"] === "1",
    "the prefab body carried its physics + the declared default mass",
    `${firstBody?.props["physics"]} mass=${firstBody?.props["mass"]}`);

  // ── 3 · G2: does the fixed-tick solver actually simulate and settle? ───────────────
  console.log("\n▸ G2 — the fixed 60 Hz solver");
  const yOf = (n: BusNode | null | undefined): number => n?.world?.[1] ?? Number.NaN;
  const xOf = (n: BusNode | null | undefined): number => n?.world?.[0] ?? Number.NaN;
  const bodyOf = (instance: BusNode | undefined): BusNode | undefined => instance?.children[0];
  // deterministic: spawn a crate at y 4.5 and watch THAT one fall (the two authored
  // rows have already landed by the time the page reaches networkidle)
  await page.getByRole("button", { name: "Drop a crate" }).click();
  await page.waitForTimeout(60);
  const fresh = (list: BusNode[]): BusNode | undefined =>
    (findNode(list, "stack")?.children ?? []).at(-1);
  const crateY0 = yOf(bodyOf(fresh(await busNodes())));
  await page.waitForTimeout(350);
  const crateY1 = yOf(bodyOf(fresh(await busNodes())));
  check(crateY1 < crateY0 - 0.2, "gravity is integrating — a freshly spawned crate fell",
    `${crateY0.toFixed(3)} → ${crateY1.toFixed(3)}`);

  // let the pile settle; the solver must come to REST — on the floor or STACKED on
  // another crate — and then sleep
  // The rotational solver may legitimately settle a crate on an edge/corner. Give the
  // contact cache its bounded sleep window plus headroom, then require the entire pile
  // to be asleep; a discrete centre-height ladder would reject physically valid tilted
  // rest poses now that OBB rotation is real.
  await page.waitForTimeout(12000);
  nodes = await busNodes();
  const settled = (findNode(nodes, "stack")?.children ?? []).map((c) => yOf(bodyOf(c)));
  check(settled.every((y) => Number.isFinite(y) && y >= 0.28 && y < 5),
    "every crate has a finite supported pose above the floor",
    settled.map((y) => y.toFixed(3)).join(", "));
  const settledBodies = (findNode(nodes, "stack")?.children ?? []).map((c) => c.children[0]);
  const sleepStates = settledBodies.map((body) => body?.props["sleeping"] ?? "?");
  const sleepDetail = settledBodies.map((body) =>
    `${body?.props["sleeping"] ?? "?"}:v=${body?.props["velocity"] ?? "?"}:w=${body?.props["angular-velocity"] ?? "?"}`);
  check(sleepStates.length > 0 && sleepStates.every((value) => value === "true"),
    "the complete rotated crate pile went to SLEEP",
    sleepDetail.join(" · "));
  const ballSleeping = findNode(nodes, "ball")?.props["sleeping"];
  check(ballSleeping === "true", "the resting ball sleeps too (a lone body on the floor)",
    String(ballSleeping));

  // The loop-existence law: this scene authors a LOOPING tween on the goal marker, so
  // the render loop legitimately stays alive here — the honest claim is that the SOLVER
  // slept (asserted above). The loop-STOP half is checked on the animation-free physics
  // scene at the end of this run.
  const bodyWorlds = (findNode(nodes, "stack")?.children ?? []).map((c) => c.children[0]?.world ?? []);
  const groundLevel = bodyWorlds.filter((w) => Math.abs((w[1] ?? -99) - 0.294319) < 0.02).length;
  check(groundLevel >= 1, "a crate BODY renders at the corpus-pinned floor height (the parent-frame law)",
    bodyWorlds.map((w) => (w[1] ?? Number.NaN).toFixed(4)).join(", "));
  await page.screenshot({ path: join(outDir, "01-settled.png") });

  // ── 4 · the bus impulse verb — fire the ball and watch it fly ──────────────────────
  console.log("\n▸ the impulse verb + collisions");
  const ballBefore = yOf(findNode(await busNodes(), "ball"));
  await page.getByRole("button", { name: "Fire the ball" }).click();
  await page.waitForTimeout(220);
  nodes = await busNodes();
  const ballAfter = findNode(nodes, "ball");
  const ballY = yOf(ballAfter);
  const ballX = xOf(ballAfter);
  check(ballY > ballBefore + 0.2, "a bus velocity write launched the ball upward",
    `${ballBefore.toFixed(3)} → ${ballY.toFixed(3)}`);
  check(ballX > -2.0, "…and it is travelling downrange (+X)", `x=${ballX.toFixed(3)}`);
  await page.screenshot({ path: join(outDir, "02-ball-in-flight.png") });

  await page.waitForTimeout(2500);
  const hits = await page.evaluate(() => document.body.innerText.match(/ball hits (\d+)/)?.[1] ?? "0");
  check(Number(hits) > 0, "on:collision fired for the ball's impacts", `${hits} hits`);
  const score = await page.evaluate(() => document.body.innerText.match(/Score (\d+)/)?.[1] ?? "0");
  console.log(`  · goal trigger score: ${score}`);

  // ── 5 · keyed spawn / despawn through data ────────────────────────────────────────
  console.log("\n▸ P5 bind — spawning and despawning by data");
  const before = countKind(await busNodes(), "box");
  await page.getByRole("button", { name: "Drop a crate" }).click();
  await page.waitForTimeout(150);
  const afterSpawn = countKind(await busNodes(), "box");
  check(afterSpawn === before + 1, "pushing a row instantiated one more prefab", `${before} → ${afterSpawn}`);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(outDir, "03-after-spawn.png") });
  await page.getByRole("button", { name: "Clear the crates" }).click();
  await page.waitForTimeout(200);
  const afterClear = findNode(await busNodes(), "stack")?.children.length ?? -1;
  check(afterClear === 0, "clearing the array despawned every instance", `${afterClear} left`);

  // ── 6 · PIXELS — is anything actually drawn? ──────────────────────────────────────
  console.log("\n▸ pixels on the canvas");
  await page.getByRole("button", { name: "Drop a crate" }).click();
  await page.waitForTimeout(1500);
  const pixels = await page.evaluate(() => {
    const canvases = document.querySelectorAll<HTMLCanvasElement>(".dsx-scene canvas");
    const canvas = canvases.item(canvases.length - 1)!;
    const gl2 = canvas.getContext("webgl") as WebGLRenderingContext;
    const w = canvas.width, h = canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl2.readPixels(0, 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, buf);
    const background = { r: 0x0a, g: 0x10, b: 0x20 };
    let lit = 0;
    const colors = new Map<string, number>();
    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i]!, g = buf[i + 1]!, b = buf[i + 2]!;
      if (Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b) > 24) {
        lit += 1;
        const key = `${r >> 5},${g >> 5},${b >> 5}`;
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
    }
    const top = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { total: w * h, lit, top };
  });
  const litPct = (pixels.lit / pixels.total) * 100;
  check(litPct > 5, "the scene is genuinely drawn (non-background pixels)", `${litPct.toFixed(1)}% of the canvas`);
  check(pixels.top.length >= 3, "multiple distinct materials are visible (lit geometry, not a flat fill)",
    `${pixels.top.length} colour buckets`);
  console.log(`  · top colour buckets (r,g,b ≫5): ${pixels.top.map(([k, n]) => `${k}×${n}`).join("  ")}`);
  await page.screenshot({ path: join(outDir, "04-final.png") });

  // ── 7 · the orbit camera (a real drag on the canvas moves the eye) ─────────────────
  console.log("\n▸ orbit camera");
  const camBefore = await busCamera();
  const box = await page.locator(".dsx-scene canvas").last().boundingBox();
  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 20, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
  const camAfter = await busCamera();
  check(String(camBefore) !== String(camAfter), "dragging orbited the camera", `${camBefore} → ${camAfter}`);
  await page.screenshot({ path: join(outDir, "05-orbited.png") });

  // ── 8 · the battery law on an animation-free scene: the loop STOPS when it sleeps ──
  console.log("\n▸ the loop-existence law (animation-free scene)");
  await page.goto(`http://localhost:${port}/demo/site/scene-element/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene canvas", { timeout: 10000 });
  await page.waitForTimeout(9000);   // let the P4/G2 ball drop, bounce out and fully sleep
  const ticksA = await page.evaluate(() => document.body.innerText.match(/Ticks: (\d+)/)?.[1] ?? "?");
  await page.waitForTimeout(1200);
  const ticksB = await page.evaluate(() => document.body.innerText.match(/Ticks: (\d+)/)?.[1] ?? "?");
  check(ticksA === ticksB && ticksA !== "?" && ticksA !== "0",
    "the fixed-tick loop STOPPED once that world fell asleep (the battery law)", `${ticksA} → ${ticksB}`);
  await page.getByRole("button", { name: "Launch the ball" }).click();
  await page.waitForTimeout(500);
  const ticksC = await page.evaluate(() => document.body.innerText.match(/Ticks: (\d+)/)?.[1] ?? "?");
  check(Number(ticksC) > Number(ticksB), "…and the impulse verb WOKE it again", `${ticksB} → ${ticksC}`);
  await page.goto(`http://localhost:${port}/demo/site/game/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene canvas", { timeout: 10000 });
  await page.waitForTimeout(600);

  const stats = await busStats();
  console.log(`\n  · bus stats: ${JSON.stringify(stats)}`);
  check(pageErrors.length === 0, "no page errors or console errors during the whole run",
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
console.log("\n✓ the DSX 3D engine ran the whole game correctly in the browser");
