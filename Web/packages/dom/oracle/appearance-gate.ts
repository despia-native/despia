//
//  appearance-gate.ts - pin what the renderer LOOKS like, the way run.ts pins where it puts
//  things.
//
//  Layout is gated to half a pixel, cross-renderer. Colour contrast is gated in both schemes.
//  Tags, actions, JSE, chains and routing are all gated. Appearance was gated by nobody:
//  screenshot-demo.ts wrote deterministic PNGs and diffed exactly none of them, so nothing
//  could regress because nothing was pinned, and no re-skin was reviewable except by eye.
//
//  TWO THINGS MAKE A PIXEL GATE HONEST RATHER THAN FLAKY, and both are measured, not assumed.
//
//  1. DETERMINISM, PER SHOT. Two back-to-back walks on this container agreed BIT FOR BIT on
//     19 of the 25 shots. The six that moved are all `12-scene-*`, which photograph a running
//     simulation: physics, particles and frame timing, worst case 1.25% of the frame. Those
//     are EXCLUDED by name below rather than absorbed into a loose global threshold, because
//     a threshold wide enough to hold a moving simulation is wide enough to hide a re-skin.
//     The 19 that are deterministic are held to a tight one.
//
//  2. THE TOOLCHAIN IS PART OF THE BASELINE. A golden pinned to one toolchain is not
//     portable: a different Chromium rasterises text differently and every shot moves at
//     once. package.json used to declare `playwright-core: ^1.53.0` while resolving 1.61.1 -
//     eight minors of drift inside one caret - so a baseline recorded here had no reason to
//     reproduce in a lane. playwright-core is now pinned exactly, and the browser build is
//     recorded beside the images. A mismatch is reported AS a mismatch, with the instruction
//     to re-record deliberately, instead of surfacing as 25 confusing pixel diffs.
//
//  RECORD is a deliberate act that shows up in a diff, the same discipline legibility.ts
//  keeps for its cost baseline: `--record` rewrites the images, and they are committed.
//
//  ALWAYS GO THROUGH `npm run appearance:check`, never the bare script. serve.ts is a STATIC
//  server over a pre-built demo/site, so a change in packages/dom/src reaches the browser
//  only after build:demo. The first bite test of this gate perturbed a radius token, rebuilt
//  only the dom package, and the check passed - correctly, because the bytes on the wire had
//  not moved. A gate that cannot see the source it exists to watch is the failure mode here,
//  so the build is part of the command rather than part of the instructions.
//

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { decodePng, diffRaster } from "./png.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "../../..");

/** Shots that photograph a RUNNING SIMULATION, excluded by prefix rather than by name.
 *
 *  The first cut of this was an enumerated list built from two back-to-back walks: six
 *  `12-scene-*` shots moved, the other two did not, so the other two were baselined. The very
 *  next check caught `12-scene-spun.png` drifting 0.96%. It was never deterministic; two runs
 *  simply happened to agree, and a list derived from one sample is a statement about the
 *  sample, not about the shots.
 *
 *  So the exclusion is the RULE the shots actually share: every `12-scene-` frame photographs
 *  the scene demo mid-simulation, where physics, particles and frame timing decide the pixels.
 *  Measured drift between two identical walks, for the record and as a floor rather than a
 *  bound: p5 1.25%, spun 0.96%, p4 0.95%, g2-flight 0.25%, g2-rest 0.17%, g2-settled 0.10%,
 *  p5-after 0.01%. A threshold wide enough to hold those is wide enough to hide a re-skin,
 *  which is the whole reason they are excluded instead of budgeted.
 *
 *  What covers this ground instead: the scene demo has its own oracles (engine-stress,
 *  engine-soak, playthrough, sprites) that assert behaviour rather than pixels.
 */
export const SCENE_PREFIX = "12-scene";
export function isRunningScene(file: string): boolean { return file.startsWith(SCENE_PREFIX); }

/** The remaining shots were bit-identical across two walks, so the budget here is a
 *  SAFETY MARGIN for a patch-level rasteriser change, not room for a design change. At
 *  780x1688 it is about 260 pixels: far above zero, far below any visible edit. */
export const MAX_CHANGED_FRACTION = 0.0002;

export type Manifest = { engine: string; browserVersion: string; shots: string[] };

export function browserVersion(exe: string): string {
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function baselineDir(engine: string): string {
  return join(WEB, "demo/baselines", engine);
}

export function record(shotDir: string, engine: string, exe: string): Manifest {
  const dir = baselineDir(engine);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const shots = readdirSync(shotDir).filter((f) => f.endsWith(".png")).sort()
    .filter((f) => !isRunningScene(f));
  for (const f of shots) writeFileSync(join(dir, f), readFileSync(join(shotDir, f)));
  const manifest: Manifest = { engine, browserVersion: browserVersion(exe), shots };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export type CheckResult = { ok: boolean; lines: string[] };

export function check(shotDir: string, engine: string, exe: string, diffDir?: string): CheckResult {
  const dir = baselineDir(engine);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, lines: [`no baselines for ${engine}: record them with --record`] };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const lines: string[] = [];
  const now = browserVersion(exe);
  if (now !== manifest.browserVersion) {
    return {
      ok: false,
      lines: [
        `TOOLCHAIN MISMATCH, not a design change.`,
        `  baselines recorded on: ${manifest.browserVersion}`,
        `  this run is using:     ${now}`,
        `  Every shot will differ. Re-record deliberately (--record) in the same commit that`,
        `  moves the playwright-core pin, so the new images are reviewable as a diff.`,
      ],
    };
  }
  let bad = 0;
  const took = new Set<string>();
  for (const f of manifest.shots) {
    took.add(f);
    const shot = join(shotDir, f);
    if (!existsSync(shot)) { lines.push(`${f}: the walk did not produce this shot`); bad++; continue; }
    let a, b;
    try {
      a = decodePng(readFileSync(join(dir, f)), `baseline ${f}`);
      b = decodePng(readFileSync(shot), `current ${f}`);
    } catch (e) { lines.push(`${f}: ${(e as Error).message}`); bad++; continue; }
    if (a.width !== b.width || a.height !== b.height) {
      lines.push(`${f}: SIZE changed ${a.width}x${a.height} -> ${b.width}x${b.height}`);
      bad++; continue;
    }
    const d = diffRaster(a, b);
    if (d.fraction <= MAX_CHANGED_FRACTION) continue;
    bad++;
    const box = d.box ? ` in a ${d.box.w}x${d.box.h} region at (${d.box.x}, ${d.box.y})` : "";
    let wrote = "";
    if (diffDir) {
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(join(diffDir, f), readFileSync(shot));
      wrote = `\n      current frame written to ${join(diffDir, f)}`;
    }
    lines.push(
      `${f}: ${d.changed} of ${d.total} pixels moved `
      + `(${(d.fraction * 100).toFixed(3)}%, budget ${(MAX_CHANGED_FRACTION * 100).toFixed(3)}%)${box}${wrote}`,
    );
  }
  const produced = readdirSync(shotDir).filter((f) => f.endsWith(".png"));
  for (const f of produced) {
    if (took.has(f) || isRunningScene(f)) continue;
    lines.push(`${f}: a NEW shot with no baseline - record it, or name it non-deterministic`);
    bad++;
  }
  if (bad === 0) {
    lines.push(`appearance [${engine}]: ${manifest.shots.length} shots match, `
      + `${produced.filter(isRunningScene).length} excluded as running scenes`);
  }
  return { ok: bad === 0, lines };
}
