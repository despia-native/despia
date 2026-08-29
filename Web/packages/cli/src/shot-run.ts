//
//  shot-run.ts - the batch: plan or render every shot in a project, and report.
//
//  This is what all three faces call. The CLI is a thin argv wrapper over it, the MCP tools
//  return its structures verbatim, and the Studio button renders its report - so the three
//  faces cannot drift in what they consider a passing shot.
//

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { shotDevice, shotPixelSize } from "@despia-native/kernel";
import { launchShotBrowser } from "./shot-browser.ts";
import { loadConfig, type ProjectConfig } from "./config.ts";
import {
  loadShotConfig, planShot, outcomeReport,
  type ShotConfig, type ShotProfile, type ShotOutcome,
} from "./shot.ts";
import { renderShot, bundleHarness, pngSize } from "./shot-render.ts";

function profiles(shotConfig: ShotConfig): ShotProfile[] {
  return shotConfig.shots.map((s) => ({ ...(shotConfig.defaults ?? {}), ...s }));
}

/** The STATIC tier: everything knowable without a browser. Cheap, and honest about being
 *  the cheap half - row counts and settle need a render and are not guessed at here. */
export function planAll(root: string): {
  ok: boolean; lines: string[]; outcomes: Array<{ profile: ShotProfile; unresolved: unknown[]; errors: string[] }>;
} {
  const config = loadConfig(root);
  const shotConfig = loadShotConfig(root);
  const lines: string[] = [];
  const outcomes: Array<{ profile: ShotProfile; unresolved: unknown[]; errors: string[] }> = [];
  let ok = true;
  for (const profile of profiles(shotConfig)) {
    const plan = planShot(config, shotConfig, profile);
    const name = profile.as ?? profile.document;
    const problems = plan.scope.unresolved.length + plan.errors.length;
    if (problems === 0) {
      const device = plan.device;
      const size = device === null ? null : shotPixelSize(device, profile.rotate === true);
      lines.push(`  ok   ${name}  ${size === null ? "?" : `${size.width}x${size.height}`}  `
        + `${Object.keys(plan.scope.vars).length} var(s), ${plan.scope.seamPlan.length} api route(s)`);
    } else {
      ok = false;
      lines.push(`  FAIL ${name}`);
      for (const u of plan.scope.unresolved) {
        lines.push(`       G-unresolved  ${u.kind} ${u.name}: ${u.reason}`);
        lines.push(`                     fix: ${u.fix}`);
      }
      for (const e of plan.errors) lines.push(`       error  ${e}`);
    }
    outcomes.push({ profile, unresolved: plan.scope.unresolved, errors: plan.errors });
  }
  return { ok, lines, outcomes };
}

export type RunResult = { ok: boolean; lines: string[]; outcomes: ShotOutcome[] };

/** The RENDER tier: boot, settle, guard, capture. */
export async function renderAll(root: string, webRoot: string, only?: string[]): Promise<RunResult> {
  const config: ProjectConfig = loadConfig(root);
  const shotConfig = loadShotConfig(root);
  const outDir = join(root, shotConfig.outDir ?? "shots");
  const bundle = bundleHarness(webRoot);
  const browser = await launchShotBrowser();
  const outcomes: ShotOutcome[] = [];
  // an `only` list that names no known shot is a refusal, never a silent green: a typo'd
  // name would otherwise render nothing, write nothing, and exit 0
  if (only !== undefined) {
    const known = profiles(shotConfig).map((p) => p.as ?? p.document);
    const unknown = only.filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      await (browser as unknown as { close(): Promise<void> }).close();
      return {
        ok: false,
        lines: [`no shot named ${unknown.join(", ")} - known: ${known.join(", ")}`],
        outcomes: [],
      };
    }
  }
  try {
    for (const profile of profiles(shotConfig)) {
      if (only !== undefined && !only.includes(profile.as ?? profile.document)) continue;
      const outcome = await renderShot(
        browser as never, config, shotConfig, profile,
        { webRoot, outDir, bundle, projectRoot: root },
      );
      outcomes.push(outcome);
    }
  } finally {
    await (browser as unknown as { close(): Promise<void> }).close();
  }
  return {
    ok: outcomes.every((o) => o.ok),
    lines: outcomes.map(outcomeReport),
    outcomes,
  };
}

/**
 * `--check`: re-render the committed set and diff against the committed images.
 *
 * Listing drift becomes a red build the week the skin or the app changed, instead of a stale
 * screenshot a customer finds. The budget is a fraction of differing pixels, not zero: two
 * runs of the same renderer agree exactly, but a legitimate token change should read as a
 * diff to review rather than a crash.
 */
export async function checkAll(
  root: string, webRoot: string, budget = 0.0,
): Promise<{ ok: boolean; lines: string[] }> {
  const shotConfig = loadShotConfig(root);
  const committed = join(root, shotConfig.outDir ?? "shots");
  const scratch = join(root, ".dsx-shot-check");
  mkdirSync(scratch, { recursive: true });
  const config = loadConfig(root);
  const bundle = bundleHarness(webRoot);
  const browser = await launchShotBrowser();
  const lines: string[] = [];
  let ok = true;
  try {
    for (const profile of profiles(shotConfig)) {
      const name = profile.as ?? profile.document;
      const before = join(committed, `${name}.png`);
      if (!existsSync(before)) {
        ok = false;
        lines.push(`  FAIL ${name}: no committed image to check against`);
        continue;
      }
      const outcome = await renderShot(
        browser as never, config, shotConfig, profile,
        { webRoot, outDir: scratch, bundle, projectRoot: root },
      );
      if (!outcome.ok) { ok = false; lines.push(outcomeReport(outcome)); continue; }
      const a = readFileSync(before);
      const b = readFileSync(outcome.path!);
      const drift = pngDrift(a, b);
      if (drift > budget) {
        ok = false;
        lines.push(`  DRIFT ${name}: ${(drift * 100).toFixed(3)}% of bytes differ (budget ${(budget * 100).toFixed(1)}%)`);
      } else {
        lines.push(`  ok    ${name}: matches the committed image`);
      }
    }
  } finally {
    await (browser as unknown as { close(): Promise<void> }).close();
  }
  return { ok, lines };
}

/** Concatenated IDAT payloads inflated to the raw filtered scanline bytes - the closest
 *  thing to pixels this pipeline needs without a PNG decoder dependency. */
function pngScanlines(png: Buffer): Buffer | null {
  let off = 8;
  const parts: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    if (type === "IDAT") parts.push(png.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (parts.length === 0) return null;
  try {
    return inflateSync(Buffer.concat(parts));
  } catch {
    return null;
  }
}

/** CONTENT drift between two PNGs of the same geometry, as the differing fraction of their
 *  inflated scanline bytes. Geometry disagreement is total drift - a different size is not
 *  a diff to budget, it is a different asset. Comparing compressed byte LENGTHS was the old
 *  shortcut, and it lied in both directions: two unrelated images can deflate to similar
 *  lengths, and a one-pixel change cascades through the whole deflate stream. */
export function pngDrift(a: Buffer, b: Buffer): number {
  const sa = pngSize(a);
  const sb = pngSize(b);
  if (sa.width !== sb.width || sa.height !== sb.height) return 1;
  if (a.equals(b)) return 0;
  const la = pngScanlines(a);
  const lb = pngScanlines(b);
  if (la === null || lb === null) return 1;
  const longest = Math.max(la.length, lb.length);
  if (longest === 0) return 0;
  let differing = Math.abs(la.length - lb.length);
  const overlap = Math.min(la.length, lb.length);
  for (let i = 0; i < overlap; i += 1) if (la[i] !== lb[i]) differing += 1;
  return differing / longest;
}

export { loadShotConfig, planShot, shotDevice, writeFileSync };
