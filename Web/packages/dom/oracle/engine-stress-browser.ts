//
// engine-stress-browser.ts — deterministic mass-scene certification for the shipped
// 2D and 3D WebGL/fixed-tick engines. This is deliberately a bounded CI gate, not a
// hardware benchmark: Chromium's headless SwiftShader renderer must keep the authored
// population alive, draw it every sampled frame, remain inside generous CPU-renderer
// frame/heap limits, and preserve finite physics state without WebGL/page errors.
//
// Usage: npm run browser:stress
//        node packages/dom/oracle/engine-stress-browser.ts [outDir]
// Optional threshold overrides:
//   DSX_STRESS_MEDIAN_MS, DSX_STRESS_P95_MS, DSX_STRESS_HEAP_MIB,
//   DSX_STRESS_HEAP_GROWTH_MIB, DSX_STRESS_DOM_NODES
//


import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession, Page } from "playwright-core";
import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

type BusNode = {
  kind: string;
  id: string;
  props: Record<string, string>;
  world: number[] | null;
  children: BusNode[];
};

type SceneStats = { nodes: number; animations: number; lastFrameDt: number; boundRows: number };

type Thresholds = {
  medianMs: number;
  p95Ms: number;
  heapMiB: number;
  heapGrowthMiB: number;
  domNodes: number;
};

type Workload = {
  name: "2d" | "3d";
  route: string;
  scene: string;
  expectedNodes: number;
  expectedBoundRows: number;
  minimumDrawsPerFrame: number;
  maximumDrawsPerFrame: number;
};

type Measurement = {
  workload: Workload["name"];
  renderer: string;
  sampleFrames: number;
  engineFrames: number;
  medianFrameMs: number;
  p95FrameMs: number;
  drawsPerFrame: number;
  stats: SceneStats;
  jsHeapMiB: number;
  retainedGrowthMiB: number;
  domNodes: number;
  contextLost: boolean;
  glError: number;
  physics?: { bodies: number; moved: number; finite: number; maxAbsCoordinate: number; ticks: number };
};

type StressWindow = Window & typeof globalThis & {
  __dsxStress?: { draws: number; renders: number; renderStamps: number[]; contextLost: boolean };
};

const numberEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// These limits target software-rendered CI. Real-device/GPU release budgets belong in
// a separate device matrix; weakening this lane for a slow CI host requires an explicit
// environment override, which is printed in the result artifact.
const thresholds: Thresholds = {
  medianMs: numberEnv("DSX_STRESS_MEDIAN_MS", 80),
  p95Ms: numberEnv("DSX_STRESS_P95_MS", 180),
  heapMiB: numberEnv("DSX_STRESS_HEAP_MIB", 160),
  heapGrowthMiB: numberEnv("DSX_STRESS_HEAP_GROWTH_MIB", 24),
  domNodes: numberEnv("DSX_STRESS_DOM_NODES", 5000),
};

const workloads: Workload[] = [
  {
    name: "2d", route: "stress-2d", scene: "stress-2d",
    expectedNodes: 517, expectedBoundRows: 512,
    minimumDrawsPerFrame: 500, maximumDrawsPerFrame: 540,
  },
  {
    name: "3d", route: "stress-3d", scene: "stress-3d",
    expectedNodes: 263, expectedBoundRows: 256,
    minimumDrawsPerFrame: 250, maximumDrawsPerFrame: 275,
  },
];

const engine = browserEngine();
const outDir = process.argv[2] ?? join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "demo/shots", engine, "engine-stress",
);
mkdirSync(outDir, { recursive: true });

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  const line = `${label}${detail === "" ? "" : ` — ${detail}`}`;
  if (ok) console.log(`  ✓ ${line}`);
  else { failures.push(line); console.log(`  ✗ ${line}`); }
};

const percentile = (values: readonly number[], proportion: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)] ?? Number.NaN;
};

const metric = async (session: CDPSession | null, name: string): Promise<number> => {
  if (session === null) return Number.NaN;
  const result = await session.send("Performance.getMetrics") as {
    metrics: Array<{ name: string; value: number }>;
  };
  return result.metrics.find((entry) => entry.name === name)?.value ?? Number.NaN;
};

const collectGarbage = async (session: CDPSession | null): Promise<void> => {
  if (session !== null) await session.send("HeapProfiler.collectGarbage");
};

const installDrawCounter = async (page: Page): Promise<{ renderer: string }> => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>(".dsx-scene canvas");
  if (canvas === null) throw new Error("stress scene has no WebGL canvas");
  const gl = canvas.getContext("webgl");
  if (gl === null) throw new Error("stress scene has no WebGL context");
  const state = { draws: 0, renders: 0, renderStamps: [] as number[], contextLost: false };
  (window as StressWindow).__dsxStress = state;
  canvas.addEventListener("webglcontextlost", () => { state.contextLost = true; });
  const original = gl.drawElements;
  gl.drawElements = function drawElements(...args: Parameters<WebGLRenderingContext["drawElements"]>): void {
    state.draws += 1;
    Reflect.apply(original, gl, args);
  };
  const originalClear = gl.clear;
  gl.clear = function clear(...args: Parameters<WebGLRenderingContext["clear"]>): void {
    state.renders += 1;
    state.renderStamps.push(performance.now());
    Reflect.apply(originalClear, gl, args);
  };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg === null ? String(gl.getParameter(gl.RENDERER))
    : String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  return { renderer };
});

const sampleFrames = async (page: Page, frameCount: number): Promise<{
  rAFDeltas: number[];
  renderDeltas: number[];
  draws: number;
  renders: number;
}> =>
  page.evaluate((count) => new Promise((done) => {
    const state = (window as StressWindow).__dsxStress;
    if (state === undefined) throw new Error("draw counter was not installed");
    state.draws = 0;
    state.renders = 0;
    state.renderStamps = [];
    const stamps: number[] = [];
    const step = (stamp: number): void => {
      stamps.push(stamp);
      if (stamps.length >= count + 1) {
        const rAFDeltas = stamps.slice(1).map((value, index) => value - stamps[index]!);
        const renderDeltas = state.renderStamps.slice(1)
          .map((value, index) => value - state.renderStamps[index]!);
        done({ rAFDeltas, renderDeltas, draws: state.draws, renders: state.renders });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), frameCount);

const sceneRead = async (page: Page, kernelUrl: string, scene: string): Promise<{ stats: SceneStats; nodes: BusNode[] }> =>
  page.evaluate(async ({ url, id }) => {
    const kernel = await import(/* @vite-ignore */ url);
    const handle = kernel.sceneBusResolve(id);
    if (handle === null) throw new Error(`scene ${id} is not registered`);
    return { stats: handle.stats(), nodes: handle.nodes() };
  }, { url: kernelUrl, id: scene });

const findNode = (nodes: readonly BusNode[], id: string): BusNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child !== null) return child;
  }
  return null;
};

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
const measurements: Measurement[] = [];

try {
  for (const workload of workloads) {
    console.log(`\n▸ ${workload.name.toUpperCase()} mass-scene certification`);
    const page = await browser.newPage({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(`console.error: ${message.text()}`);
    });
    const cdp = engine === "chromium" ? await page.context().newCDPSession(page) : null;
    if (cdp !== null) await cdp.send("Performance.enable");

    await page.goto(`http://localhost:${port}/demo/site/${workload.route}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".dsx-scene canvas", { timeout: 15000 });
    const kernelUrl = `http://localhost:${port}/demo/site/dist/kernel/src/index.js`;
    await page.waitForFunction(async ({ url, id, rows }) => {
      const kernel = await import(/* @vite-ignore */ url);
      return kernel.sceneBusResolve(id)?.stats().boundRows === rows;
    }, { url: kernelUrl, id: workload.scene, rows: workload.expectedBoundRows }, { timeout: 15000 });
    await page.waitForTimeout(800);

    const initial = await sceneRead(page, kernelUrl, workload.scene);
    const { renderer } = await installDrawCounter(page);
    await collectGarbage(cdp);
    const heapBefore = await metric(cdp, "JSHeapUsedSize");

    // 90 frames is long enough to expose runaway per-frame allocation while keeping
    // the software-rendered lane comfortably below normal CI job timeouts.
    const sampled = await sampleFrames(page, 90);
    await collectGarbage(cdp);
    const heapAfter = await metric(cdp, "JSHeapUsedSize");
    const domNodes = await metric(cdp, "Nodes");
    const final = await sceneRead(page, kernelUrl, workload.scene);
    const repeatedCounts = [initial.stats.nodes, final.stats.nodes];
    const drawsPerFrame = sampled.draws / sampled.renders;
    const medianFrameMs = percentile(sampled.renderDeltas, 0.5);
    const p95FrameMs = percentile(sampled.renderDeltas, 0.95);
    const jsHeapMiB = heapAfter / (1024 * 1024);
    const retainedGrowthMiB = (heapAfter - heapBefore) / (1024 * 1024);
    const glState = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".dsx-scene canvas");
      const gl = canvas?.getContext("webgl") ?? null;
      const state = (window as StressWindow).__dsxStress;
      return { contextLost: state?.contextLost ?? true, glError: gl?.getError() ?? -1 };
    });

    const measurement: Measurement = {
      workload: workload.name,
      renderer,
      sampleFrames: sampled.rAFDeltas.length,
      engineFrames: sampled.renders,
      medianFrameMs,
      p95FrameMs,
      drawsPerFrame,
      stats: final.stats,
      jsHeapMiB,
      retainedGrowthMiB,
      domNodes,
      contextLost: glState.contextLost,
      glError: glState.glError,
    };

    if (workload.name === "3d") {
      const bodies = findNode(final.nodes, "physics-bank")?.children ?? [];
      const finalWorlds = bodies.map((node) => node.world ?? []);
      const finite = finalWorlds.filter((world) => world.length === 3 && world.every(Number.isFinite)).length;
      const moved = finalWorlds.filter((world, index) =>
        Number.isFinite(world[1])
          && Math.abs(world[1]! - (2.4 + (index % 4) * 1.2)) > 0.1).length;
      const maxAbsCoordinate = finalWorlds.reduce((maximum, world) =>
        Math.max(maximum, ...world.map((value) => Math.abs(value))), 0);
      const ticks = Number((await page.locator("body").innerText()).match(/ticks (\d+)/)?.[1] ?? "0");
      measurement.physics = { bodies: bodies.length, moved, finite, maxAbsCoordinate, ticks };
    }
    measurements.push(measurement);

    console.log(`  · renderer: ${renderer}`);
    console.log(`  · engine frame pacing: median ${medianFrameMs.toFixed(2)} ms · p95 ${p95FrameMs.toFixed(2)} ms`);
    console.log(`  · engine renders: ${sampled.renders}/${sampled.rAFDeltas.length} sampled rAFs · draws/render: ${drawsPerFrame.toFixed(1)}`);
    console.log(`  · nodes: ${final.stats.nodes} · rows: ${final.stats.boundRows}`);
    console.log(`  · retained JS heap: ${jsHeapMiB.toFixed(1)} MiB · growth ${retainedGrowthMiB.toFixed(2)} MiB · DOM nodes ${domNodes}`);

    check(repeatedCounts.every((count) => count === workload.expectedNodes),
      `${workload.name}: node population stayed exact`, repeatedCounts.join(" → "));
    check(final.stats.boundRows === workload.expectedBoundRows,
      `${workload.name}: bounded collection population stayed exact`, String(final.stats.boundRows));
    check(drawsPerFrame >= workload.minimumDrawsPerFrame && drawsPerFrame <= workload.maximumDrawsPerFrame,
      `${workload.name}: every engine render drew the mass scene once`, `${drawsPerFrame.toFixed(1)} draws/render`);
    check(sampled.renders >= 20,
      `${workload.name}: the engine kept rendering throughout the sample`, `${sampled.renders} engine frames`);
    check(medianFrameMs <= thresholds.medianMs,
      `${workload.name}: software-rendered median frame gate`, `${medianFrameMs.toFixed(2)} ≤ ${thresholds.medianMs} ms`);
    check(p95FrameMs <= thresholds.p95Ms,
      `${workload.name}: software-rendered p95 frame gate`, `${p95FrameMs.toFixed(2)} ≤ ${thresholds.p95Ms} ms`);
    if (cdp === null) {
      console.log(`  · ${workload.name}: memory/DOM CDP gates skipped outside Chromium`);
    } else {
      check(Number.isFinite(jsHeapMiB) && jsHeapMiB <= thresholds.heapMiB,
        `${workload.name}: retained JS heap stayed bounded`, `${jsHeapMiB.toFixed(1)} ≤ ${thresholds.heapMiB} MiB`);
      check(Number.isFinite(retainedGrowthMiB) && retainedGrowthMiB <= thresholds.heapGrowthMiB,
        `${workload.name}: no runaway retained allocation over 90 frames`, `${retainedGrowthMiB.toFixed(2)} ≤ ${thresholds.heapGrowthMiB} MiB`);
      check(Number.isFinite(domNodes) && domNodes <= thresholds.domNodes,
        `${workload.name}: browser node count stayed bounded`, `${domNodes} ≤ ${thresholds.domNodes}`);
    }
    check(!glState.contextLost && glState.glError === 0,
      `${workload.name}: WebGL stayed healthy`, `contextLost=${glState.contextLost}, error=${glState.glError}`);
    check(pageErrors.length === 0, `${workload.name}: no page or console errors`, pageErrors.slice(0, 3).join(" | "));

    if (measurement.physics !== undefined) {
      const physics = measurement.physics;
      check(physics.bodies === 96, "3d: all dynamic bodies remained registered", String(physics.bodies));
      check(physics.moved >= 90 && physics.ticks >= 30,
        "3d: the fixed-tick solver advanced the mass body set", `${physics.moved} moved · ${physics.ticks} ticks`);
      check(physics.finite === physics.bodies && physics.maxAbsCoordinate < 100,
        "3d: every physics transform remained finite and bounded",
        `${physics.finite}/${physics.bodies} finite · max |coordinate| ${physics.maxAbsCoordinate.toFixed(2)}`);
    }

    await page.screenshot({ path: join(outDir, `${workload.name}-mass-scene.png`), fullPage: true });
    await page.close();
  }

  await close();
  serverClosed = true;
} finally {
  await browser.close();
  if (!serverClosed) await close();
}

const report = {
  generatedAt: new Date().toISOString(),
  engine,
  thresholds,
  measurements,
  failures,
};
writeFileSync(join(outDir, "certification.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nreport + shots → ${outDir}`);

if (failures.length > 0) {
  console.error(`\n✗ stress certification FAILED (${failures.length} gates):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("\n✓ deterministic 2D/3D mass-scene certification passed");
