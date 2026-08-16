//
//  sprites-browser.ts — run the REAL 2D page (packages/scene-demo Sprites.dsx) in a REAL
//  browser and check that the DSX 2D engine actually works end to end (dsx-game.md G6):
//  sprite PIXELS on the canvas, a sheet auto-advancing at a fixed fps, a store-driven
//  frame index, the UV flip, z as the draw order, and a dynamic 2D body falling through
//  the EXISTING solver with its z pinned by the z-lock.
//
//  This is not a unit test — it boots the shipped site, walks to /sprites, samples the
//  live WebGL framebuffer, and interrogates the scene through the same
//  `dsx.module.scene` bus a module or an AI agent uses.
//  Usage: node packages/dom/oracle/sprites-browser.ts [outDir]
//

import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const engine = browserEngine();
const outDir = process.argv[2] ?? join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "demo/shots", engine, "sprites",
);
mkdirSync(outDir, { recursive: true });

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  const line = `${label}${detail === "" ? "" : ` — ${detail}`}`;
  if (ok) console.log(`  ✓ ${line}`);
  else { failures.push(line); console.log(`  ✗ ${line}`); }
};

type BusNode = { kind: string; id: string; props: Record<string, string>; world: number[] | null; children: BusNode[] };

/** the eight sheet cell colours, in frame order (the generated hero-sheet.png) */
const SHEET = [
  [0xff, 0x00, 0x00], [0xff, 0x8c, 0x00], [0xff, 0xe0, 0x00], [0x00, 0xd0, 0x40],
  [0x00, 0xc8, 0xff], [0x30, 0x50, 0xff], [0x9b, 0x30, 0xff], [0xff, 0x30, 0xb0],
];

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`); });

  console.log("\n▸ booting the 2D page");
  await page.goto(`http://localhost:${port}/demo/site/sprites/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene canvas", { timeout: 10000 });
  await page.waitForTimeout(800);   // let the sprite textures load and the first draws land
  check(true, "the page mounted and the scene box rendered");

  const gl = await page.evaluate(() => {
    const canvas = document.querySelector(".dsx-scene canvas") as HTMLCanvasElement | null;
    if (canvas === null) return { ok: false, renderer: "no canvas", width: 0, height: 0 };
    const ctx = canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (ctx === null) return { ok: false, renderer: "no webgl", width: canvas.width, height: canvas.height };
    const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg === null ? String(ctx.getParameter(ctx.RENDERER))
      : String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    return { ok: true, renderer, width: canvas.width, height: canvas.height };
  });
  check(gl.ok, "a live WebGL context is driving the 2D scene", `${gl.renderer} @ ${gl.width}×${gl.height}`);

  // ── the scene bus — the same handle Core/Scene (and any MCP agent) drives ──────────
  const KERNEL_URL = `http://localhost:${port}/demo/site/dist/kernel/src/index.js`;
  const busNodes = async (): Promise<BusNode[]> => page.evaluate(async (url) => {
    const k = await import(/* @vite-ignore */ url);
    return k.sceneBusResolve("sprites")!.nodes() as BusNode[];
  }, KERNEL_URL);
  const findNode = (nodes: BusNode[], id: string): BusNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const inner = findNode(n.children, id);
      if (inner !== null) return inner;
    }
    return null;
  };

  /** the dominant sheet-cell colour inside the scene-space box around (wx, wy).
   *  The ortho camera law is the sampler: ndcX = wx/(size·aspect), ndcY = wy/size. */
  const sampleFrame = async (wx: number, wy: number, halfW = 0.6, halfH = 0.6): Promise<number> =>
    page.evaluate(({ wx, wy, halfW, halfH, sheet }) => {
      const canvas = document.querySelector(".dsx-scene canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("webgl") as WebGLRenderingContext;
      const w = canvas.width, h = canvas.height;
      const size = 5;                       // the authored camera half-extent
      const aspect = w / h;
      const toPx = (x: number, y: number): [number, number] => [
        Math.round((x / (size * aspect) + 1) / 2 * w),
        Math.round((y / size + 1) / 2 * h),   // readPixels is BOTTOM-UP, +Y is up: no flip
      ];
      const [x0, y0] = toPx(wx - halfW, wy - halfH);
      const [x1, y1] = toPx(wx + halfW, wy + halfH);
      const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
      const buf = new Uint8Array(bw * bh * 4);
      ctx.readPixels(x0, y0, bw, bh, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      const votes = new Array(sheet.length).fill(0);
      for (let i = 0; i < buf.length; i += 4) {
        let best = -1, bestD = 40;          // a tight match: the cells are far apart
        for (let c = 0; c < sheet.length; c += 1) {
          const d = Math.abs(buf[i]! - sheet[c]![0]!) + Math.abs(buf[i + 1]! - sheet[c]![1]!)
            + Math.abs(buf[i + 2]! - sheet[c]![2]!);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (best >= 0) votes[best] += 1;
      }
      let winner = -1, most = 8;            // demand real coverage, not a stray texel
      votes.forEach((n, c) => { if (n > most) { most = n; winner = c; } });
      return winner;
    }, { wx, wy, halfW, halfH, sheet: SHEET });

  // ── 1 · PIXELS: are sprites actually drawn? ───────────────────────────────────────
  console.log("\n▸ sprite pixels on the canvas");
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector(".dsx-scene canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("webgl") as WebGLRenderingContext;
    const w = canvas.width, h = canvas.height;
    const buf = new Uint8Array(w * h * 4);
    ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
    const background = { r: 0x10, g: 0x18, b: 0x26 };
    let lit = 0;
    const colors = new Set<string>();
    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i]!, g = buf[i + 1]!, b = buf[i + 2]!;
      if (Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b) > 24) {
        lit += 1;
        colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
      }
    }
    return { total: w * h, lit, colors: colors.size };
  });
  const litPct = (pixels.lit / pixels.total) * 100;
  check(litPct > 5, "the 2D scene is genuinely drawn (non-background pixels)", `${litPct.toFixed(1)}% of the canvas`);
  check(pixels.colors >= 5, "multiple distinct sprite materials are visible", `${pixels.colors} colour buckets`);
  await page.screenshot({ path: join(outDir, "01-field.png") });

  // ── 2 · the store-driven frame index (a write animates the sheet) ─────────────────
  console.log("\n▸ the reactive `frame` index");
  const picker0 = await sampleFrame(0, 2);
  check(picker0 === 0, "the store-bound sprite shows frame 0 (the sheet's first cell)", `frame ${picker0}`);
  await page.getByRole("button", { name: "Next frame" }).click();
  await page.waitForTimeout(200);
  const picker1 = await sampleFrame(0, 2);
  check(picker1 === 1, "a store write advanced it to frame 1 (the UV rect moved one cell)", `frame ${picker1}`);
  await page.getByRole("button", { name: "Next frame" }).click();
  await page.getByRole("button", { name: "Next frame" }).click();
  await page.getByRole("button", { name: "Next frame" }).click();
  await page.getByRole("button", { name: "Next frame" }).click();
  await page.waitForTimeout(200);
  const picker5 = await sampleFrame(0, 2);
  check(picker5 === 5, "…and to frame 5, which lives on the sheet's SECOND ROW (2-D packing)", `frame ${picker5}`);

  // ── 3 · the flip law: frame 3 mirrored still reads frame 3's cell ─────────────────
  const flipped = await sampleFrame(5, 2);
  check(flipped === 3, "flip=\"x\" mirrors WITHIN the frame's rect (still cell 3)", `frame ${flipped}`);

  // ── 4 · the fps sheet advances on the shared clock, with NO store write ───────────
  console.log("\n▸ the fps sheet (6 fps, no store write)");
  const seen = new Set<number>();
  for (let i = 0; i < 10; i += 1) {
    const f = await sampleFrame(-5, 2);
    if (f >= 0) seen.add(f);
    await page.waitForTimeout(180);
  }
  check(seen.size >= 3, "the fps-driven sheet cycled through several frames on its own",
    `frames seen: ${[...seen].sort((a, b) => a - b).join(", ")}`);
  await page.screenshot({ path: join(outDir, "02-animating.png") });

  // ── 5 · 2D physics: the crate falls and its z NEVER moves (the z-lock) ────────────
  console.log("\n▸ 2D physics — the z-lock");
  const crateOf = async (): Promise<{ y: number; z: number }> => {
    const node = findNode(await busNodes(), "crate");
    return { y: node?.world?.[1] ?? Number.NaN, z: node?.world?.[2] ?? Number.NaN };
  };
  await page.getByRole("button", { name: "Drop the crate" }).click();
  await page.waitForTimeout(80);
  const fall0 = await crateOf();
  await page.waitForTimeout(400);
  const fall1 = await crateOf();
  check(fall1.y < fall0.y - 0.2, "gravity is integrating — the 2D crate fell",
    `y ${fall0.y.toFixed(3)} → ${fall1.y.toFixed(3)}`);
  check(fall0.z === 0.5 && fall1.z === 0.5, "…and its z stayed EXACTLY at its spawn layer (the z-lock)",
    `z ${fall0.z} → ${fall1.z}`);

  await page.waitForTimeout(4000);
  const rest = await crateOf();
  // the ground sprite spans y ∈ [−4.5, −3.5]; a 1×1 crate rests half a unit above its top
  check(Math.abs(rest.y - (-3.0)) < 0.06, "the crate came to REST on the ground sprite",
    `y ${rest.y.toFixed(4)} (expected ≈ −3.0)`);
  check(rest.z === 0.5, "…still on its own z layer after the whole simulation", `z ${rest.z}`);
  const restingCrate = findNode(await busNodes(), "crate");
  check(restingCrate?.props["sleeping"] === "true", "the resting 2D body went to SLEEP (the battery law)",
    String(restingCrate?.props["sleeping"]));
  await page.screenshot({ path: join(outDir, "03-settled.png") });

  // ── 6 · z is the DRAW ORDER: the backdrop at z −1 never covers the actors ─────────
  const backdropCovered = await sampleFrame(-5, 2);
  check(backdropCovered >= 0, "the z −1 backdrop paints BEHIND the sprites (z is the draw order)",
    `hero cell still visible: frame ${backdropCovered}`);

  const ticks = await page.evaluate(() => document.body.innerText.match(/ticks (\d+)/)?.[1] ?? "0");
  console.log(`  · fixed-tick count: ${ticks}`);
  check(Number(ticks) > 0, "the fixed 60 Hz solver ran on:tick in the 2D scene", `${ticks} ticks`);

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
console.log("\n✓ the DSX 2D engine drew, animated and simulated correctly in the browser");
