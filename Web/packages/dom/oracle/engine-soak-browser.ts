//
// engine-soak-browser.ts — bounded sustained mount/run/unmount certification for the
// dedicated 2D/3D stress scenes. The short default is suitable for CI; production can
// run the exact same gates for minutes or hours with DSX_SOAK_DURATION_SECONDS.
//
// Usage:
//   npm run browser:soak                                      # ~45 second CI lane
//   DSX_SOAK_DURATION_SECONDS=900 npm run browser:soak         # 15 minute release soak
//   DSX_SOAK_DURATION_SECONDS=3600 npm run browser:soak        # one hour endurance soak
//

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession, Page } from "playwright-core";
import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

type BusNode = { id: string; world: number[] | null; children: BusNode[] };
type Stats = { nodes: number; animations: number; lastFrameDt: number; boundRows: number };
type Workload = {
  name: "2d" | "3d";
  route: string;
  scene: string;
  nodes: number;
  rows: number;
  minimumDraws: number;
  maximumDraws: number;
};
type ProbeState = Window & typeof globalThis & {
  __dsxSoak?: { draws: number; renders: number; stamps: number[]; lost: boolean };
};
type Cycle = {
  cycle: number;
  workload: Workload["name"];
  engineFrames: number;
  drawsPerRender: number;
  medianFrameMs: number;
  p95FrameMs: number;
  stats: Stats;
  loadedHeapMiB: number;
  postUnmountHeapMiB: number;
  postUnmountNodes: number;
  postUnmountDocuments: number;
  postUnmountListeners: number;
  contextLost: boolean;
  glError: number;
  contextReallocated: boolean;
  physics?: { bodies: number; moved: number; finite: number; maxAbsCoordinate: number; ticks: number };
};

const positive = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const configuration = {
  durationSeconds: positive("DSX_SOAK_DURATION_SECONDS", 45),
  sampleSeconds: positive("DSX_SOAK_SAMPLE_SECONDS", 4),
  minimumCycles: Math.ceil(positive("DSX_SOAK_MINIMUM_CYCLES", 6)),
};
const thresholds = {
  medianFrameMs: positive("DSX_SOAK_MEDIAN_MS", 80),
  p95FrameMs: positive("DSX_SOAK_P95_MS", 180),
  p95SlopeMsPerWorkloadCycle: positive("DSX_SOAK_FRAME_SLOPE_MS", 4),
  p95LastMinusFirstMs: positive("DSX_SOAK_FRAME_DRIFT_MS", 50),
  loadedHeapMiB: positive("DSX_SOAK_LOADED_HEAP_MIB", 160),
  postUnmountHeapMiB: positive("DSX_SOAK_UNMOUNT_HEAP_MIB", 32),
  heapSlopeMiBPerCycle: positive("DSX_SOAK_HEAP_SLOPE_MIB", 0.75),
  heapLastMinusFirstMiB: positive("DSX_SOAK_HEAP_DRIFT_MIB", 8),
  postUnmountNodes: positive("DSX_SOAK_UNMOUNT_NODES", 100),
  nodeSlopePerCycle: positive("DSX_SOAK_NODE_SLOPE", 5),
  postUnmountDocuments: positive("DSX_SOAK_UNMOUNT_DOCUMENTS", 3),
  postUnmountListeners: positive("DSX_SOAK_UNMOUNT_LISTENERS", 100),
};
const workloads: Workload[] = [
  { name: "2d", route: "stress-2d", scene: "stress-2d", nodes: 517, rows: 512, minimumDraws: 500, maximumDraws: 540 },
  { name: "3d", route: "stress-3d", scene: "stress-3d", nodes: 263, rows: 256, minimumDraws: 250, maximumDraws: 275 },
];

const engine = browserEngine();
if (engine !== "chromium") throw new Error("the retained-resource soak requires Chromium CDP metrics");
const outDir = process.argv[2] ?? join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "demo/shots", engine, "engine-soak",
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
const slope = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mx = (values.length - 1) / 2;
  const my = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - mx) * (value - my);
    denominator += (index - mx) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
};
const metric = async (cdp: CDPSession, name: string): Promise<number> => {
  const result = await cdp.send("Performance.getMetrics") as { metrics: Array<{ name: string; value: number }> };
  return result.metrics.find((entry) => entry.name === name)?.value ?? Number.NaN;
};
const gc = async (cdp: CDPSession): Promise<void> => {
  await cdp.send("HeapProfiler.collectGarbage");
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
};
const findNode = (nodes: readonly BusNode[], id: string): BusNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested !== null) return nested;
  }
  return null;
};
const sceneRead = async (page: Page, kernelUrl: string, scene: string): Promise<{ stats: Stats; nodes: BusNode[] }> =>
  page.evaluate(async ({ url, id }) => {
    const kernel = await import(/* @vite-ignore */ url);
    const handle = kernel.sceneBusResolve(id);
    if (handle === null) throw new Error(`scene ${id} is not registered`);
    return { stats: handle.stats(), nodes: handle.nodes() };
  }, { url: kernelUrl, id: scene });

const installProbe = async (page: Page): Promise<void> => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>(".dsx-scene canvas");
  const gl = canvas?.getContext("webgl") ?? null;
  if (canvas === null || gl === null) throw new Error("soak scene has no WebGL context");
  const state = { draws: 0, renders: 0, stamps: [] as number[], lost: false };
  (window as ProbeState).__dsxSoak = state;
  canvas.addEventListener("webglcontextlost", () => { state.lost = true; });
  const draw = gl.drawElements;
  gl.drawElements = function drawElements(...args: Parameters<WebGLRenderingContext["drawElements"]>): void {
    state.draws += 1;
    Reflect.apply(draw, gl, args);
  };
  const clear = gl.clear;
  gl.clear = function clearFrame(...args: Parameters<WebGLRenderingContext["clear"]>): void {
    state.renders += 1;
    state.stamps.push(performance.now());
    Reflect.apply(clear, gl, args);
  };
});

const sample = async (page: Page, milliseconds: number): Promise<{
  draws: number; renders: number; deltas: number[]; lost: boolean; glError: number;
}> => page.evaluate((duration) => new Promise((done) => {
  const state = (window as ProbeState).__dsxSoak;
  const canvas = document.querySelector<HTMLCanvasElement>(".dsx-scene canvas");
  const gl = canvas?.getContext("webgl") ?? null;
  if (state === undefined || gl === null) throw new Error("soak probe was not installed");
  state.draws = 0;
  state.renders = 0;
  state.stamps = [];
  const start = performance.now();
  const step = (now: number): void => {
    if (now - start >= duration) {
      const deltas = state.stamps.slice(1).map((value, index) => value - state.stamps[index]!);
      done({ draws: state.draws, renders: state.renders, deltas, lost: state.lost, glError: gl.getError() });
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}), milliseconds);

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
const page = await browser.newPage({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 1 });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const cycles: Cycle[] = [];
const errors: string[] = [];
const warnings: string[] = [];
let cycleWarnings: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
  if (message.type() === "warning") {
    warnings.push(message.text());
    // SwiftShader emits ordinary software-fallback/performance warnings on its first
    // context. Only resource exhaustion/loss signatures indicate a sustained leak.
    if (/too many active webgl contexts|webgl context.{0,20}lost|failed to create.{0,20}(webgl|context)|out of (gpu )?memory/i.test(message.text())) {
      cycleWarnings.push(message.text());
    }
  }
});

const started = Date.now();
let cycleIndex = 0;
let fatalError: string | null = null;
try {
  while (cycleIndex < configuration.minimumCycles
    || Date.now() - started < configuration.durationSeconds * 1000) {
    const workload = workloads[cycleIndex % workloads.length]!;
    cycleWarnings = [];
    console.log(`\n▸ soak cycle ${cycleIndex + 1} · ${workload.name.toUpperCase()}`);
    await page.goto(`http://localhost:${port}/demo/site/${workload.route}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".dsx-scene canvas", { timeout: 15000 });
    const kernelUrl = `http://localhost:${port}/demo/site/dist/kernel/src/index.js`;
    await page.waitForFunction(async ({ url, id, rows }) => {
      const kernel = await import(/* @vite-ignore */ url);
      return kernel.sceneBusResolve(id)?.stats().boundRows === rows;
    }, { url: kernelUrl, id: workload.scene, rows: workload.rows }, { timeout: 15000 });
    await page.waitForTimeout(300);
    await installProbe(page);
    const sampled = await sample(page, configuration.sampleSeconds * 1000);
    await gc(cdp);
    const loadedHeapMiB = await metric(cdp, "JSHeapUsedSize") / (1024 * 1024);
    const scene = await sceneRead(page, kernelUrl, workload.scene);
    const drawsPerRender = sampled.draws / sampled.renders;
    const result: Cycle = {
      cycle: cycleIndex + 1,
      workload: workload.name,
      engineFrames: sampled.renders,
      drawsPerRender,
      medianFrameMs: percentile(sampled.deltas, 0.5),
      p95FrameMs: percentile(sampled.deltas, 0.95),
      stats: scene.stats,
      loadedHeapMiB,
      postUnmountHeapMiB: Number.NaN,
      postUnmountNodes: Number.NaN,
      postUnmountDocuments: Number.NaN,
      postUnmountListeners: Number.NaN,
      contextLost: sampled.lost,
      glError: sampled.glError,
      contextReallocated: false,
    };
    if (workload.name === "3d") {
      const bodies = findNode(scene.nodes, "physics-bank")?.children ?? [];
      const worlds = bodies.map((node) => node.world ?? []);
      const finite = worlds.filter((world) => world.length === 3 && world.every(Number.isFinite)).length;
      const moved = worlds.filter((world, index) => Number.isFinite(world[1])
        && Math.abs(world[1]! - (2.4 + (index % 4) * 1.2)) > 0.1).length;
      const maxAbsCoordinate = worlds.reduce((maximum, world) =>
        Math.max(maximum, ...world.map((value) => Math.abs(value))), 0);
      const ticks = Number((await page.locator("body").innerText()).match(/ticks (\d+)/)?.[1] ?? "0");
      result.physics = { bodies: bodies.length, moved, finite, maxAbsCoordinate, ticks };
    }

    check(scene.stats.nodes === workload.nodes && scene.stats.boundRows === workload.rows,
      `cycle ${cycleIndex + 1}: population stayed exact`, `${scene.stats.nodes} nodes · ${scene.stats.boundRows} rows`);
    check(sampled.renders >= 30 && drawsPerRender >= workload.minimumDraws && drawsPerRender <= workload.maximumDraws,
      `cycle ${cycleIndex + 1}: sustained draw path stayed exact`, `${sampled.renders} frames · ${drawsPerRender.toFixed(1)} draws/render`);
    check(result.medianFrameMs <= thresholds.medianFrameMs && result.p95FrameMs <= thresholds.p95FrameMs,
      `cycle ${cycleIndex + 1}: frame budgets stayed green`, `${result.medianFrameMs.toFixed(1)} median · ${result.p95FrameMs.toFixed(1)} p95 ms`);
    check(loadedHeapMiB <= thresholds.loadedHeapMiB,
      `cycle ${cycleIndex + 1}: loaded heap stayed bounded`, `${loadedHeapMiB.toFixed(2)} MiB`);
    check(!sampled.lost && sampled.glError === 0 && cycleWarnings.length === 0,
      `cycle ${cycleIndex + 1}: WebGL resource plane stayed healthy`,
      `lost=${sampled.lost} error=${sampled.glError} warnings=${cycleWarnings.length}`);
    if (result.physics !== undefined) {
      check(result.physics.bodies === 96 && result.physics.moved >= 90 && result.physics.finite === 96
        && result.physics.maxAbsCoordinate < 100 && result.physics.ticks >= 30,
      `cycle ${cycleIndex + 1}: physics stayed finite and advancing`,
      `${result.physics.moved} moved · ${result.physics.finite} finite · ${result.physics.ticks} ticks`);
    }
    if (cycleIndex < 2) {
      await page.screenshot({ path: join(outDir, `${workload.name}-cycle-1.png`), fullPage: true });
    }

    // Navigation to an empty document is the unmount. GC plus CDP DOM counters forms
    // the retained-resource baseline; a fresh throwaway context proves Chromium can
    // still allocate WebGL after every teardown.
    await page.goto("about:blank", { waitUntil: "load" });
    await gc(cdp);
    result.postUnmountHeapMiB = await metric(cdp, "JSHeapUsedSize") / (1024 * 1024);
    const dom = await cdp.send("Memory.getDOMCounters") as { documents: number; nodes: number; jsEventListeners: number };
    result.postUnmountNodes = dom.nodes;
    result.postUnmountDocuments = dom.documents;
    result.postUnmountListeners = dom.jsEventListeners;
    result.contextReallocated = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return gl !== null;
    });
    check(result.postUnmountHeapMiB <= thresholds.postUnmountHeapMiB
      && result.postUnmountNodes <= thresholds.postUnmountNodes
      && result.postUnmountDocuments <= thresholds.postUnmountDocuments
      && result.postUnmountListeners <= thresholds.postUnmountListeners,
    `cycle ${cycleIndex + 1}: unmount released page resources`,
    `${result.postUnmountHeapMiB.toFixed(2)} MiB · ${dom.nodes} nodes · ${dom.documents} docs · ${dom.jsEventListeners} listeners`);
    check(result.contextReallocated, `cycle ${cycleIndex + 1}: a new WebGL context remained allocatable`);
    cycles.push(result);
    cycleIndex += 1;
  }

  await close();
  serverClosed = true;
} catch (error) {
  fatalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  failures.push(`fatal soak infrastructure error — ${fatalError}`);
} finally {
  await page.close();
  await browser.close();
  if (!serverClosed) await close();
}

const postUnmountHeaps = cycles.map((cycle) => cycle.postUnmountHeapMiB);
const postUnmountNodes = cycles.map((cycle) => cycle.postUnmountNodes);
const heapSlope = slope(postUnmountHeaps);
const nodeSlope = slope(postUnmountNodes);
const heapDrift = (postUnmountHeaps.at(-1) ?? 0) - (postUnmountHeaps[0] ?? 0);
const soakElapsedSeconds = (Date.now() - started) / 1000;
const soakWindowComplete = cycles.length >= configuration.minimumCycles
  && soakElapsedSeconds >= configuration.durationSeconds;
const frameTrends = Object.fromEntries(workloads.map((workload) => {
  const values = cycles.filter((cycle) => cycle.workload === workload.name).map((cycle) => cycle.p95FrameMs);
  return [workload.name, { values, slope: slope(values), lastMinusFirst: (values.at(-1) ?? 0) - (values[0] ?? 0) }];
})) as Record<Workload["name"], { values: number[]; slope: number; lastMinusFirst: number }>;

console.log("\n▸ sustained regression slopes");
check(soakWindowComplete,
  "the configured soak window completed before trend certification",
  `${cycles.length}/${configuration.minimumCycles} cycles · ${soakElapsedSeconds.toFixed(1)}/${configuration.durationSeconds}s`);
check(soakWindowComplete && heapSlope <= thresholds.heapSlopeMiBPerCycle
  && heapDrift <= thresholds.heapLastMinusFirstMiB,
  "post-unmount retained-heap slope stayed flat",
  `${heapSlope.toFixed(3)} MiB/cycle · last-first ${heapDrift.toFixed(3)} MiB`);
check(soakWindowComplete && nodeSlope <= thresholds.nodeSlopePerCycle,
  "post-unmount browser-node slope stayed flat", `${nodeSlope.toFixed(3)} nodes/cycle`);
for (const workload of workloads) {
  const trend = frameTrends[workload.name];
  check(soakWindowComplete && trend.values.length >= 3
    && trend.slope <= thresholds.p95SlopeMsPerWorkloadCycle
    && trend.lastMinusFirst <= thresholds.p95LastMinusFirstMs,
  `${workload.name}: p95 frame-time did not degrade across remounts`,
  `${trend.values.length} samples · ${trend.slope.toFixed(2)} ms/workload-cycle · last-first ${trend.lastMinusFirst.toFixed(2)} ms`);
}
check(errors.length === 0, "no page or console errors across the sustained run", errors.slice(0, 3).join(" | "));

const report = {
  generatedAt: new Date().toISOString(),
  engine,
  elapsedSeconds: soakElapsedSeconds,
  soakWindowComplete,
  configuration,
  thresholds,
  slopes: { heapMiBPerCycle: heapSlope, heapLastMinusFirstMiB: heapDrift, nodesPerCycle: nodeSlope, frame: frameTrends },
  cycles,
  errors,
  warnings,
  fatalError,
  failures,
};
writeFileSync(join(outDir, "certification.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nreport + shots → ${outDir}`);
if (failures.length > 0) {
  console.error(`\n✗ sustained engine soak FAILED (${failures.length} gates):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n✓ sustained 2D/3D soak passed (${cycles.length} mount/run/unmount cycles)`);
