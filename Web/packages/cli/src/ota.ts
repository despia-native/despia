//
//  ota.ts — the PUBLISHING half of the content plane (v0-live-plan W5): `despia ota
//  build | publish | rollback`.
//
//  The runtime half already exists and is the strong half (content-plane.md): app-authored
//  content is static files under the content root — a manifest plus files — so ANY static
//  host serves OTA today. What was missing is the half a developer had to hand-assemble:
//  producing that folder deterministically, pushing it to a host, and putting yesterday back.
//
//  THE SHAPES, precisely:
//    · `build` walks a content directory (sorted, so the walk order can never leak into the
//      output), sha256-pins every file, and writes <out>/manifest.json + the files. Every
//      file pinned means the device's stale-while-revalidate pass can short-circuit on
//      identical manifest bytes, and it means THIS COMMAND IS DETERMINISTIC: same input
//      bytes, same manifest bytes, same generation id — no timestamp anywhere. The
//      generation id is the sha256 of the canonical files table; it is the publisher's
//      version handle (the device store derives its own internal id, which also folds in
//      the source host).
//    · Alongside the servable tree, build maintains <out>/.history/ — a local
//      content-addressed store (blobs by sha + one manifest per generation + current/
//      previous pointers). History is the publisher's memory, never uploaded.
//    · `rollback` repoints: it restores the PREVIOUS generation's manifest and files into
//      <out> from history blobs, and swaps the pointers. Devices that ever held the old
//      generation flip without re-downloading (their store is content-addressed); a device
//      that never saw it re-fetches by path, which is why rollback restores the files and
//      not only the manifest.
//    · `publish` pushes the servable tree to a static host target — table-driven and thin,
//      like the deploy targets: `dir:` is implemented here (the universal target — any
//      mounted volume, any rsync root), the vendor rows emit their CLI's exact command.
//      Plan by default, `--apply` runs it (dsx_deploy.rb's discipline).
//
//  The manifest emits the EXACT shape the kernel's acceptance rule admits (Content.swift
//  ContentManifest.parse): a JSON object whose `files` array carries {path, sha256, bytes}.
//

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { parseRuntimeVersion } from "@despia/kernel";

export class OtaError extends Error {}

export interface OtaFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface OtaRolloutDeclaration {
  fraction: number;
  salt: string;
}

export interface OtaManifest {
  format: string;
  generation: string;
  /** The MINIMUM installed runtime this generation may be applied to, written plainly:
   *  `"1.4.0"` means 1.4.0 and above. It is a floor, not a range expression — the device's
   *  gate compares versions and there is no range grammar to get wrong. Omitted means every
   *  runtime; absence is no constraint. */
  runtimeVersion?: string;
  /** The staged rollout. Omitted means 100 percent. */
  rollout?: OtaRolloutDeclaration;
  files: OtaFileEntry[];
}

/**
 * The gate a build declares. Both halves are OPTIONAL and their absence means the permissive
 * answer, because the common publish is "everyone, now" and a gate you have to remember to
 * turn off is a gate that silently strands a release.
 */
export interface OtaGate {
  runtimeVersion?: string;
  /** 0..1. Anything at or above 1 is emitted as no rollout at all rather than a 100% one:
   *  a manifest that says nothing is smaller, and the device's verdict is identical. */
  rolloutFraction?: number;
  /** Defaults to the generation id, which is what makes each release re-bucket its devices.
   *  A fixed salt across generations would send every canary to the same installs forever,
   *  so the ones that break are always the same unlucky users. */
  rolloutSalt?: string;
}

export const OTA_FORMAT = "despia:ota@1";
const HISTORY = ".history";

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Sorted recursive walk. Deterministic by construction — the platform's readdir order never
 *  reaches the output. Dotfiles stay out (an OTA folder is app content; a `.DS_Store` shipped
 *  to every device is nobody's intention), and `exclude` lets the build skip its own output
 *  when it lives inside the content directory — the natural `--out ./dist-ota` layout must
 *  not ingest yesterday's build as content. */
export function walkContent(root: string, exclude: string | null = null, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (abs === exclude) continue;
    const info = statSync(abs);
    if (info.isDirectory()) out.push(...walkContent(root, exclude, abs));
    else if (info.isFile()) out.push(abs);
  }
  return out;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** The canonical bytes the generation id is the hash of: the sorted files table, nothing else. */
function generationId(files: OtaFileEntry[]): string {
  const canonical = files.map((f) => `${f.path}\n${f.sha256}\n`).join("");
  return sha256Hex(Buffer.from(canonical, "utf8"));
}

export function readManifest(dir: string): OtaManifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new OtaError(`no manifest.json in ${dir} — run \`despia ota build\` first`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as OtaManifest;
  if (!Array.isArray(parsed.files)) throw new OtaError(`${path} carries no files array`);
  return parsed;
}

export interface OtaBuildResult {
  generation: string;
  files: number;
  bytes: number;
  outDir: string;
  /** false when the input produced the generation already current — nothing changed */
  changed: boolean;
  /** What the manifest actually declares, so the caller reports the gate rather than the flags:
   *  a fraction at or above 1 is emitted as no rollout, and saying "100%" would be a lie. */
  gate: { runtimeVersion?: string; rollout?: OtaRolloutDeclaration };
}

/**
 * Build the servable OTA folder from a content directory, and record the generation in the
 * local history store. Re-building unchanged input is a no-op with the same id — which is
 * the determinism gate, run as a test rather than promised.
 */
export function otaBuild(inDir: string, outDir: string, gate: OtaGate = {}): OtaBuildResult {
  const input = resolve(inDir);
  if (!existsSync(input) || !statSync(input).isDirectory()) {
    throw new OtaError(`content directory ${input} does not exist`);
  }
  const out = resolve(outDir);
  if (out === input || input.startsWith(out + sep)) {
    throw new OtaError("the output folder must not contain the input folder");
  }
  const absFiles = walkContent(input, out.startsWith(input + sep) ? out : null);
  if (absFiles.length === 0) throw new OtaError(`content directory ${input} holds no files`);

  const entries: OtaFileEntry[] = absFiles.map((abs) => {
    const data = readFileSync(abs);
    return { path: toPosix(relative(input, abs)), sha256: sha256Hex(data), bytes: data.length };
  });
  const generation = generationId(entries);

  // The gate is validated HERE, with the kernel's own parser, so the publisher refuses exactly
  // what the device would refuse. A range the device cannot read is a release that silently
  // reaches nobody, and finding that out from a support ticket is the failure this prevents.
  if (gate.runtimeVersion !== undefined && parseRuntimeVersion(gate.runtimeVersion) === null) {
    throw new OtaError(
      `--runtime-version ${JSON.stringify(gate.runtimeVersion)} is not a version the device gate can read. ` +
      "It is a MINIMUM, written plainly: 1.4.0 means 1.4.0 and above. Semver only — no v prefix, " +
      "no range operators, no leading zeros.",
    );
  }
  const fraction = gate.rolloutFraction;
  if (fraction !== undefined && (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)) {
    throw new OtaError(`--rollout ${fraction} is out of range: a rollout fraction is 0 to 1.`);
  }

  // The gate is NOT part of the generation id. The id is content identity, so widening a
  // rollout or relaxing a runtime floor must republish the SAME generation: a device that
  // already has these bytes must not re-download them because the publisher changed its mind
  // about who gets them.
  const manifest: OtaManifest = {
    format: OTA_FORMAT,
    generation,
    ...(gate.runtimeVersion !== undefined ? { runtimeVersion: gate.runtimeVersion } : {}),
    ...(fraction !== undefined && fraction < 1
      ? { rollout: { fraction, salt: gate.rolloutSalt ?? generation } }
      : {}),
    files: entries,
  };
  const manifestBytes = JSON.stringify(manifest, null, 1) + "\n";

  const history = join(out, HISTORY);
  const blobs = join(history, "blobs", "sha256");
  const gens = join(history, "gens");
  mkdirSync(blobs, { recursive: true });
  mkdirSync(gens, { recursive: true });

  // The servable tree: manifest + files at their paths. Stale files from a previous build
  // are removed (a path deleted from the input must not keep serving), history is kept.
  for (const name of readdirSync(out)) {
    if (name === HISTORY) continue;
    rmSync(join(out, name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const target = join(out, ...entry.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(input, ...entry.path.split("/")), target);
    // The history blob: once per unique content, however many paths or generations carry it.
    const blob = join(blobs, entry.sha256);
    if (!existsSync(blob)) cpSync(join(input, ...entry.path.split("/")), blob);
  }
  writeFileSync(join(out, "manifest.json"), manifestBytes);
  writeFileSync(join(gens, `${generation}.json`), manifestBytes);

  const currentPath = join(history, "current");
  const previous = existsSync(currentPath) ? readFileSync(currentPath, "utf8").trim() : "";
  const changed = previous !== generation;
  if (changed) {
    if (previous !== "") writeFileSync(join(history, "previous"), previous);
    writeFileSync(currentPath, generation + "\n");
  }
  return {
    generation,
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
    outDir: out,
    changed,
    gate: {
      ...(manifest.runtimeVersion !== undefined ? { runtimeVersion: manifest.runtimeVersion } : {}),
      ...(manifest.rollout !== undefined ? { rollout: manifest.rollout } : {}),
    },
  };
}

export interface OtaRollbackResult {
  from: string;
  to: string;
}

/**
 * Repoint <out> at the previous generation: restore its manifest and files from history
 * blobs, then swap the pointers (a second rollback rolls forward again — the pointer pair
 * is a toggle, exactly like the device store's current/previous).
 */
export function otaRollback(outDir: string): OtaRollbackResult {
  const out = resolve(outDir);
  const history = join(out, HISTORY);
  const currentPath = join(history, "current");
  const previousPath = join(history, "previous");
  if (!existsSync(currentPath)) throw new OtaError(`${out} has no OTA history — nothing to roll back`);
  if (!existsSync(previousPath)) throw new OtaError(`${out} has no previous generation — only one has ever been built`);
  const from = readFileSync(currentPath, "utf8").trim();
  const to = readFileSync(previousPath, "utf8").trim();

  const manifestBytes = readFileSync(join(history, "gens", `${to}.json`), "utf8");
  const manifest = JSON.parse(manifestBytes) as OtaManifest;
  for (const name of readdirSync(out)) {
    if (name === HISTORY) continue;
    rmSync(join(out, name), { recursive: true, force: true });
  }
  for (const entry of manifest.files) {
    const blob = join(history, "blobs", "sha256", entry.sha256);
    if (!existsSync(blob)) throw new OtaError(`history blob ${entry.sha256} for ${entry.path} is missing — the history store is incomplete`);
    const target = join(out, ...entry.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(blob, target);
  }
  writeFileSync(join(out, "manifest.json"), manifestBytes);
  writeFileSync(currentPath, to + "\n");
  writeFileSync(previousPath, from + "\n");
  return { from, to };
}

export interface OtaPublishStep {
  title: string;
  /** argv, never a shell string (dsx_deploy.rb's rule) — null when `dir:` handled natively */
  cmd: string[] | null;
}

export interface OtaPublishPlan {
  target: string;
  steps: OtaPublishStep[];
  /** the native copy destination when the target is dir: */
  copyTo?: string;
}

/**
 * The publish target table — thin and table-driven like the deploy targets. `dir:` is the
 * universal row and is executed natively; every vendor row is its CLI's exact command over
 * the servable tree (history excluded by upload direction: vendors take a directory, and
 * `.history` is dot-prefixed, which every listed uploader skips by default — the dir row
 * excludes it explicitly).
 */
export function otaPublishPlan(outDir: string, target: string): OtaPublishPlan {
  const out = resolve(outDir);
  if (target.startsWith("dir:")) {
    const dest = target.slice("dir:".length);
    if (dest === "") throw new OtaError("dir: target needs a path — dir:/srv/www/dsx");
    return { target, copyTo: resolve(dest), steps: [{ title: `copy the OTA folder to ${dest}`, cmd: null }] };
  }
  if (target.startsWith("s3://")) {
    return {
      target,
      steps: [{ title: `sync to ${target}`, cmd: ["aws", "s3", "sync", out, target, "--exclude", ".history/*"] }],
    };
  }
  if (target === "netlify") {
    return { target, steps: [{ title: "deploy the folder with the Netlify CLI", cmd: ["npx", "netlify", "deploy", "--prod", "--dir", out] }] };
  }
  if (target === "cloudflare") {
    return { target, steps: [{ title: "upload to Workers Static Assets (pages project `dsx-ota`)", cmd: ["npx", "wrangler", "pages", "deploy", out, "--project-name", "dsx-ota"] }] };
  }
  throw new OtaError(`unknown publish target ${JSON.stringify(target)} — dir:<path> · s3://bucket/prefix · netlify · cloudflare`);
}

/** Execute the dir: row natively: the servable tree, history excluded, copied whole. */
export function otaCopyTo(outDir: string, dest: string): number {
  const out = resolve(outDir);
  readManifest(out); // refuse to publish a folder that is not a built OTA tree
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(out)) {
    if (name === HISTORY) continue;
    cpSync(join(out, name), join(dest, name), { recursive: true });
    copied += 1;
  }
  return copied;
}
