#!/usr/bin/env node

// Build and consume the exact npm tarballs, not workspace source aliases. This
// catches stale/missing dist files, raw-source leakage, bad export maps, undeclared
// internal dependencies, and declaration failures before a release tag can publish.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_SPECS, RELEASE_DIRS } from "./release-packages.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// The runtime five build to dist; the tooling three ship TypeScript source that Node
// >=22.18 strips natively. Both faces are packed and consumed from the tarball here,
// because "npm create dsx" failing on a stranger's machine is the same class of defect
// as a missing dist file and deserves the same gate. RELEASE_DIRS and PACKAGE_SPECS are
// imported rather than restated: the published shape has one source of truth.
const packageDirs = [...RELEASE_DIRS];

// What each package is allowed to carry, beyond package.json / README.md / LICENSE.
function allowedRoots(dir: string): string[] {
  return PACKAGE_SPECS[dir]!.files
    .filter((entry) => entry !== "LICENSE" && entry !== "README.md")
    .map((entry) => `package/${entry}/`);
}
const conflictCopyPath = /(?:^|\/)[^/]+ 2(?:\.[^/]*)?$/;

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

console.log("[pack:check] building dependency-ordered package output …");
run(npm, ["run", "build"]);

const work = mkdtempSync(join(tmpdir(), "dsx-pack-check-"));
const packDir = join(work, "tarballs");
mkdirSync(packDir);
const tarballs: string[] = [];
let packedFiles = 0;

for (const dir of packageDirs) {
  const packageDir = join(root, "packages", dir);
  const stdout = run(npm, ["pack", packageDir, "--silent", "--pack-destination", packDir]);
  const filename = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (filename === undefined) throw new Error(`[pack:check] npm pack produced no filename for ${dir}`);
  const tarball = join(packDir, filename);
  if (!existsSync(tarball)) throw new Error(`[pack:check] missing tarball ${tarball}`);
  tarballs.push(tarball);

  const entries = run("tar", ["-tzf", tarball]).split(/\r?\n/).filter(Boolean);
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const conflictCopies = files.filter((entry) => conflictCopyPath.test(entry));
  if (conflictCopies.length > 0) {
    throw new Error(`[pack:check] ${dir} tarball contains conflict-copy output: ${conflictCopies.join(", ")}`);
  }
  packedFiles += files.length;
  const roots = allowedRoots(dir);
  const permitted = (entry: string): boolean =>
    entry === "package/package.json" ||
    entry === "package/README.md" ||
    entry === "package/LICENSE" ||
    roots.some((root) => entry.startsWith(root));
  const leaked = files.filter((entry) => !permitted(entry));
  if (leaked.length > 0) {
    throw new Error(`[pack:check] ${dir} tarball leaked files outside its declared set: ${leaked.join(", ")}`);
  }

  const manifest = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"])) as Record<string, unknown>;
  if (manifest["private"] === true) throw new Error(`[pack:check] ${dir} is still private`);
  if (manifest["license"] !== "Apache-2.0") throw new Error(`[pack:check] ${dir} has no Apache-2.0 package license`);
  const available = new Set(files.map((entry) => `./${entry.replace(/^package\//, "")}`));
  for (const target of exportTargets(manifest["exports"])) {
    if (!available.has(target)) throw new Error(`[pack:check] ${dir} export target ${target} is absent from its tarball`);
  }
  console.log(`[pack:check] ${String(manifest["name"])}: ${files.length} files, ${statSync(tarball).size} bytes`);
}

// Install all five exact tarballs together so npm must honor only their declared
// dependency graph. No registry or workspace-source fallback is available.
const consumer = join(work, "consumer");
mkdirSync(consumer);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "dsx-pack-consumer", private: true, type: "module" }, null, 2) + "\n");
run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], consumer);

// Consumers and registry mirrors may re-pack an installed artifact. Published
// tarballs intentionally omit TypeScript sources, so each package's prepack hook
// must become a no-op when `src/` is absent instead of trying to rebuild files it
// does not ship.
const repackDir = join(work, "repacked");
mkdirSync(repackDir);
for (const dir of packageDirs) {
  const name = PACKAGE_SPECS[dir]!.name;
  const installed = join(consumer, "node_modules", ...name.split("/"));
  const stdout = run(npm, ["pack", installed, "--silent", "--pack-destination", repackDir], consumer);
  const filename = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (filename === undefined || !existsSync(join(repackDir, filename))) {
    throw new Error(`[pack:check] installed ${name} could not be repacked`);
  }
}

const smoke = `
import * as kernel from "@despia-native/kernel";
import * as compiler from "@despia-native/compiler";
import * as server from "@despia-native/server";
import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
if (typeof kernel.DSXState?.set !== "function") throw new Error("kernel export missing");
if (typeof compiler.parseDsx !== "function") throw new Error("compiler export missing");
if (typeof server.renderPage !== "function") throw new Error("server export missing");
if (!String(LAYER_STATEMENT).includes("@layer")) throw new Error("compiler subpath export missing");
console.log("consumer imports ok");
`;
writeFileSync(join(consumer, "smoke.mjs"), smoke);
run(process.execPath, ["smoke.mjs"], consumer);

const typeSmoke = `
import { DSXState, type Dict } from "@despia-native/kernel";
import { parseDsx, type XmlNode } from "@despia-native/compiler";
import { renderPage } from "@despia-native/server";
const data: Dict = { ok: true };
DSXState.set("pack.check", data);
const node: XmlNode = parseDsx("<stack/>");
void node;
void renderPage;
`;
writeFileSync(join(consumer, "smoke.ts"), typeSmoke);
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
run(tsc, ["--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "smoke.ts"], consumer);

// A production browser bundler must resolve every public package from the installed
// tarballs. Execution is covered by the browser gate; this catches export/dependency
// resolution without relying on workspace links.
const browserEntry = `
import * as kernel from "@despia-native/kernel";
import * as xml from "@despia-native/compiler/xml";
import * as dom from "@despia-native/dom";
import * as element from "@despia-native/element";
globalThis.__DSX_PACKAGES__ = { kernel, xml, dom, element };
`;
writeFileSync(join(consumer, "browser.ts"), browserEntry);
const esbuild = join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
run(esbuild, ["browser.ts", "--bundle", "--format=esm", "--platform=browser", "--target=es2022", "--outfile=browser.js"], consumer);

const chromiumPath = process.env["DSX_CHROMIUM"];
if (chromiumPath && existsSync(chromiumPath)) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
    const bundle = readFileSync(join(consumer, "browser.js"), "utf8").replace(/<\/script/gi, "<\\/script");
    await page.setContent(`<!doctype html><meta charset="utf-8"><script type="module">${bundle}<\/script>`);
    await page.waitForFunction(() => typeof (globalThis as Record<string, unknown>)["__DSX_PACKAGES__"] === "object");
    const ok = await page.evaluate(() => {
      const packages = (globalThis as Record<string, unknown>)["__DSX_PACKAGES__"] as Record<string, Record<string, unknown>>;
      return typeof packages["kernel"]?.["DSXState"] === "object" &&
        typeof packages["xml"]?.["parseDsx"] === "function" &&
        typeof packages["dom"]?.["bootDsx"] === "function" &&
        typeof packages["element"]?.["defineDsxElement"] === "function";
    });
    if (!ok || pageErrors.length > 0) {
      throw new Error(`[pack:check] installed browser packages failed: ${pageErrors.join(" | ") || "missing exports"}`);
    }
    console.log("[pack:check] installed browser tarballs executed in Chromium");
  } finally {
    await browser.close();
  }
} else {
  console.log("[pack:check] Chromium execution skipped (DSX_CHROMIUM not set); browser bundle resolution passed");
}

console.log(`[pack:check] PASS: ${tarballs.length} installable + repackable tarballs, ${packedFiles} packaged files, runtime imports + declarations + browser bundle resolved`);
