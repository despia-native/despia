#!/usr/bin/env node

// The stranger's machine. Everything else in this repo proves the packages are correct;
// this proves a person who has never seen the monorepo can get a running application out
// of them. It packs the real tarballs, installs `create-dsx` from one, scaffolds through
// the published bin, installs the runtime tarballs into the generated project, and builds
// it with the published `dsx` executable. No workspace alias, no file: link back to this
// tree, no source directory on the path.
//
// This gate exists because it FOUND something nothing else could: shipping raw TypeScript
// worked in every in-repo path and failed instantly for a consumer, because Node refuses
// native type stripping inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
// The in-repo flows all run from `packages/`, where stripping is allowed, so the whole
// tooling face was unrunnable for its only real audience and every existing gate was green.
//
// With DSX_CHROMIUM set it also boots the built page and drives one interaction, which is
// the difference between "the build emitted files" and "the app runs".

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_SPECS, RELEASE_DIRS } from "./release-packages.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function fail(message: string): never {
  throw new Error(`[cold-start] ${message}`);
}

console.log("[cold-start] building and packing the release set …");
run(npm, ["run", "build"], root);

const work = mkdtempSync(join(tmpdir(), "dsx-cold-start-"));
const registry = join(work, "registry");
mkdirSync(registry);
const tarball = new Map<string, string>();
for (const dir of RELEASE_DIRS) {
  const stdout = run(npm, ["pack", join(root, "packages", dir), "--silent", "--pack-destination", registry], root);
  const filename = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (filename === undefined || !existsSync(join(registry, filename))) fail(`npm pack produced no tarball for ${dir}`);
  tarball.set(PACKAGE_SPECS[dir]!.name, join(registry, filename));
}

// A scaffolder installed the way a stranger installs it: from the registry artifact, into
// an empty project, invoked through the bin entry rather than a source path.
const host = join(work, "host");
mkdirSync(host);
writeFileSync(join(host, "package.json"), `${JSON.stringify({ name: "cold-start-host", private: true, type: "module" }, null, 2)}\n`);
run(npm, ["install", "--no-audit", "--no-fund", tarball.get("create-dsx")!], host);
run(npm, ["exec", "--no", "--", "create-dsx", "my-app"], host);

const app = join(host, "my-app");
for (const file of ["package.json", "dsx.json", "dsx.config.json", join("Components", "App.dsx")]) {
  if (!existsSync(join(app, file))) fail(`scaffold is missing ${file}`);
}

// The generated project must ask for REGISTRY versions, not a path back into this tree —
// that is the difference between a template a stranger can use and one only we can.
const generated = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as Record<string, unknown>;
for (const section of ["dependencies", "devDependencies"]) {
  for (const [name, selector] of Object.entries((generated[section] ?? {}) as Record<string, string>)) {
    if (!name.startsWith("@despia/")) continue;
    if (/^(?:file:|link:|\.|\/)/.test(selector)) fail(`scaffold pins ${name} to a local path (${selector})`);
  }
}

// Then satisfy those declarations from the tarballs, because the registry does not have
// them yet. Installing the artifacts is the same resolution npm will do after publish.
const runtimeNames = Object.keys({ ...(generated["dependencies"] as object), ...(generated["devDependencies"] as object) })
  .filter((name) => tarball.has(name));
if (runtimeNames.length === 0) fail("scaffold declared no @despia dependencies to install");
run(npm, ["install", "--no-audit", "--no-fund", ...runtimeNames.map((name) => tarball.get(name)!)], app);

run(npm, ["run", "build"], app);
const indexHtml = join(app, "dist", "index.html");
const mainJs = join(app, "dist", "main.js");
for (const artifact of [indexHtml, mainJs]) {
  if (!existsSync(artifact) || statSync(artifact).size <= 0) fail(`build produced no ${artifact}`);
}
const html = readFileSync(indexHtml, "utf8");
if (!html.includes("main.js")) fail("built index.html does not load the compiled bundle");
run(npm, ["exec", "--no", "--", "dsx", "lint", "--strict"], app);

// `dsx doctor` is authored in DSX (cli-authoring.md), so this also proves the `<cli>` document
// SHIPS and executes from an installed package — not just from the workspace, where the .dsx
// sits next to its source anyway. A markup-authored command that works in the repo and is
// absent from the tarball would be the type-stripping defect again in a new costume.
const doctor = run(npm, ["exec", "--no", "--", "dsx", "doctor"], app);
if (!doctor.includes("all checks passed")) fail(`the markup-authored doctor did not pass a freshly scaffolded project:\n${doctor}`);
const help = run(npm, ["exec", "--no", "--", "dsx", "--help"], app);
if (!help.includes("doctor")) fail("--help is not derived from the shipped document");

const chromium = process.env["DSX_CHROMIUM"];
if (chromium === undefined || chromium === "") {
  console.log("[cold-start] browser boot skipped (DSX_CHROMIUM not set)");
} else {
  const { chromium: engine } = await import("playwright-core");
  const { createServer } = await import("node:http");
  const dist = join(app, "dist");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = join(dist, path === "/" ? "index.html" : path);
    if (!file.startsWith(dist) || !existsSync(file)) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const extension = file.slice(file.lastIndexOf("."));
    response.writeHead(200, { "content-type": types[extension] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const browser = await engine.launch({ executablePath: chromium });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.getByText("Tap me").click();
    await page.waitForFunction(() => document.body.textContent?.includes("Tapped 1 times") === true, undefined, { timeout: 5_000 });
  } finally {
    await browser.close();
    server.close();
  }
  if (errors.length > 0) fail(`the scaffolded app threw on boot: ${errors.join(" | ")}`);
  console.log("[cold-start] booted in Chromium and one interaction advanced state");
}

console.log(`[cold-start] PASS: ${RELEASE_DIRS.length} tarballs → create-dsx → dsx build → running app, with no monorepo on the path`);
