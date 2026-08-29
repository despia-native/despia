#!/usr/bin/env node

// The stranger's machine. Everything else in this repo proves the packages are correct;
// this proves a person who has never seen the monorepo can get a running application out
// of them. It packs the real tarballs, installs `create-despia` from one, scaffolds through
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

import { execFileSync, spawn } from "node:child_process";
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
run(npm, ["install", "--no-audit", "--no-fund", tarball.get("create-despia")!], host);
run(npm, ["exec", "--no", "--", "create-despia", "my-app"], host);

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

//  ── the deploy artifacts (plan E1) ──────────────────────────────────────────────────────
//  A scaffold has no `server/` documents, so the published build must emit no deploy/ — and
//  the moment one exists, the same build must produce a worker and a manifest without any
//  script from outside the tarballs. Both halves, from the stranger's machine.
if (existsSync(join(app, "deploy"))) fail("a backend-less project emitted deploy/");
mkdirSync(join(app, "server"), { recursive: true });
writeFileSync(join(app, "server", "api.dsx"),
  `<server>\n  <head>\n    <action as="health">\n      return { up: true }\n    </action>\n  </head>\n  <route method="GET" path="/health" action="health"/>\n</server>\n`);
run(npm, ["run", "build"], app);
for (const artifact of [join(app, "deploy", "cloudflare", "wrangler.jsonc"), join(app, "deploy", "cloudflare", "worker", "index.ts")]) {
  if (!existsSync(artifact) || statSync(artifact).size <= 0) fail(`the published build emitted no ${artifact}`);
}
const wrangler = readFileSync(join(app, "deploy", "cloudflare", "wrangler.jsonc"), "utf8");
if (!wrangler.includes(`"binding": "ASSETS"`)) fail("the emitted manifest carries no assets binding — the site half is missing");
const planned = run(npm, ["exec", "--no", "--", "despia", "deploy", "cloudflare", "--plan"], app);
if (!planned.includes("wrangler deploy --config deploy/cloudflare/wrangler.jsonc")) {
  fail(`\`despia deploy --plan\` printed no publish step:\n${planned}`);
}
console.log("[cold-start] deploy: the published build emits deploy/, and `despia deploy --plan` names the real command.");
run(npm, ["exec", "--no", "--", "dsx", "lint", "--strict"], app);

// ── W8: the editor, from its published form ────────────────────────────────────────────
// Pack @despia/canvas-editor like everything else, install it into the scaffold, then:
//   1. the corpus runs against the TARBALL'S SDK bytes (conformance from the published form);
//   2. `dsx edit` boots against the scaffold, an edit round-trips through the API to the
//      local file, and the preview reload event fires — the whole local loop, no monorepo.
console.log("[cold-start] editor: packing @despia/canvas-editor and walking the edit loop …");
const editorPackOut = run(npm, ["pack", join(root, "..", "CanvasEditor"), "--silent", "--pack-destination", registry], root);
const editorTarball = join(registry, editorPackOut.split(/\r?\n/).filter(Boolean).at(-1)!);
if (!existsSync(editorTarball)) fail("npm pack produced no editor tarball");
run(npm, ["install", "--no-audit", "--no-fund", "--save-dev", editorTarball], app);

const publishedSdk = join(app, "node_modules", "@despia", "canvas-editor", "src", "canvas-editor.js");
if (!existsSync(publishedSdk)) fail("the packed editor ships no src/canvas-editor.js");
execFileSync(process.execPath, [join(root, "..", "CanvasEditor", "test", "run-jse-conformance.mjs")], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, DSX_EDITOR_SDK: publishedSdk },
});
console.log("[cold-start] editor: the corpus passes against the published SDK bytes.");

{
  // detached: `npm exec` runs the real server as a GRANDCHILD, so a plain kill() reaches only
  // npm and orphans the dev server — which then holds the SSE socket open and hangs this
  // script forever (observed, not theorized). A process group makes the cleanup reach it.
  const edit = spawn(
    npm,
    ["exec", "--no", "--", "despia", "edit", "--port", "0"],
    { cwd: app, stdio: ["ignore", "pipe", "inherit"], detached: true },
  );
  try {
    //  The command prints ONE url carrying this run's admission credential (plan E1): a local
    //  developer tool's door key, not an account. A consumer reads it exactly like this.
    const started = await new Promise<{ port: number; token: string }>((done, failed) => {
      const timer = setTimeout(() => failed(new Error("dsx edit never reported its port")), 30_000);
      let text = "";
      edit.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const match = /editor at http:\/\/localhost:(\d+)\/edit\/\?token=([A-Za-z0-9_-]+)/.exec(text);
        if (match !== null) { clearTimeout(timer); done({ port: Number(match[1]), token: match[2]! }); }
      });
      edit.on("exit", (code) => { clearTimeout(timer); failed(new Error(`dsx edit exited ${code}`)); });
    });
    const editPort = started.port;
    const admitted = { "x-despia-edit": started.token };
    const editorBase = `http://127.0.0.1:${editPort}`;
    //  The door is real: no credential, no editor. This is the defect the credential closed,
    //  proved from the published form rather than from the workspace.
    if ((await fetch(`${editorBase}/edit/api/documents`)).status !== 401) fail("the editor served an uncredentialed request");
    if ((await fetch(`${editorBase}/edit/`, { headers: admitted })).status !== 200) fail("the editor page did not serve");
    //  TWO LANES, and this walk used to assert the wrong one. The dev server answers a save on
    //  the same SSE channel with `event: reload` OR `event: swap`, and the choice is not a
    //  detail: it compares a fingerprint of the registry the page will fetch (routes, schemes,
    //  shell, packageWeb, notFound, router — dev.ts `registryStructure`) and sends `swap` when
    //  none of them moved, so a component edit hot-swaps instead of throwing the page away.
    //  Editing TEXT inside App.dsx moves none of them, and dev.ts seeds the fingerprint from
    //  the boot build precisely so the FIRST edit already rides that lane. So `swap` is the
    //  correct answer here and `reload` would be the regression — the walk waited ten seconds
    //  for an event the server was right not to send. Read the lane, name it, and pin it.
    const reloadAbort = new AbortController();
    const reload = await fetch(`${editorBase}/__dsx_dev_reload`, { signal: reloadAbort.signal });
    const reloadReader = reload.body!.getReader();
    const sawUpdate = (async (): Promise<string | null> => {
      const decoder = new TextDecoder();
      let seen = "";
      try {
        for (;;) {
          const { done, value } = await reloadReader.read();
          if (done) return null;
          seen += decoder.decode(value, { stream: true });
          const lane = /event: (reload|swap)/.exec(seen);
          if (lane !== null) return lane[1]!;
        }
      } catch { return null; }   // aborted below — never an unhandled rejection
    })();
    const appDsx = "Components/App.dsx";
    const original = readFileSync(join(app, appDsx), "utf8");
    const edited = original.replace("Hello", "Edited hello");
    if (edited === original) fail("the scaffold's App.dsx no longer contains the expected text");
    const saved = await fetch(`${editorBase}/edit/api/documents/${encodeURIComponent(appDsx)}`, { method: "PUT", headers: admitted, body: edited });
    if (saved.status !== 200) fail(`the editor save answered ${saved.status}`);
    if (readFileSync(join(app, appDsx), "utf8") !== edited) fail("the save never reached the local file");
    const lane = await Promise.race([sawUpdate, new Promise<null>((done) => setTimeout(() => done(null), 10_000))]);
    if (lane === null) fail("the preview never updated after the save");
    if (lane !== "swap") {
      fail(`a text-only edit took the "${lane}" lane; the registry structure did not move, so the ` +
           "dev server owes a hot swap. A full reload here means registryStructure started " +
           "seeing a component edit as a page fact.");
    }
    // abort, never await cancel(): cancelling a live SSE reader can wait on the peer
    reloadAbort.abort();
    console.log("[cold-start] editor: despia edit booted, the edit reached the file, the preview hot-swapped.");
  } finally {
    try { process.kill(-edit.pid!, "SIGTERM"); } catch { edit.kill(); }
  }
}

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

console.log(`[cold-start] PASS: ${RELEASE_DIRS.length} tarballs → create-despia → despia build → running app, with no monorepo on the path`);
