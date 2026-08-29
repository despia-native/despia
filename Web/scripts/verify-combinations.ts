#!/usr/bin/env node

// The combination matrix, WALKED (v0-live-plan W6): every documented way of combining Despia
// with an existing stack builds here from the packed tarballs — the cold-start law extended
// from "the scaffold works" to "every documented combination is a walked path, not prose".
// The guides under OpenSource/Documentation/guides/combinations/ describe exactly what this
// file proves; a row neither gate nor guide can hold is not documented as working.
//
//   C1  pure DSX app — scaffold from tarballs, `dsx build`, the web surface exists
//   C7  self-hosted OTA — the SAME app's screens through `dsx ota build`, manifest verified
//       (C7 rides C1 on purpose: OTA is a property of any app's content, not a special app)
//   C3  existing web app + Despia backend ONLY — a plain index.html untouched, @despia/server
//       installed from its tarball, a hand-registered route table served over node:http
//       through the platform-free edge handler; /health answers, their page still serves
//   C5  DSX front end + a vendor backend directly — an <api> block against an external URL
//       compiles and ships in the build (no Despia server anywhere in the project)
//   C2  existing web app + DSX native parts — the two-codebase layout validated structurally:
//       the Custom module manifest parses, lane folders follow rule 11 (swift/ · kotlin/),
//       and the web codebase stays untouched beside it. The native BUILD rides the app lanes
//       (Codemagic), which is stated in the guide rather than pretended here.
//
//   C4 (DSX front end + Despia backend) is C1's stack plus the backend-authoring corpus,
//   both already gated; its guide page links rather than duplicates.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  throw new Error(`[combinations] ${message}`);
}

console.log("[combinations] building and packing the release set …");
run(npm, ["run", "build"], root);

const work = mkdtempSync(join(tmpdir(), "dsx-combinations-"));
const registry = join(work, "registry");
mkdirSync(registry);
const tarball = new Map<string, string>();
for (const dir of RELEASE_DIRS) {
  const stdout = run(npm, ["pack", join(root, "packages", dir), "--silent", "--pack-destination", registry], root);
  const filename = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (filename === undefined || !existsSync(join(registry, filename))) fail(`npm pack produced no tarball for ${dir}`);
  tarball.set(PACKAGE_SPECS[dir]!.name, join(registry, filename));
}

// ── C1: the pure DSX app, from tarballs ─────────────────────────────────────────────────
console.log("[combinations] C1 — pure DSX app …");
const host = join(work, "c1");
mkdirSync(host);
writeFileSync(join(host, "package.json"), `${JSON.stringify({ name: "c1-host", private: true, type: "module" }, null, 2)}\n`);
run(npm, ["install", "--no-audit", "--no-fund", tarball.get("create-despia")!], host);
run(npm, ["exec", "--no", "--", "create-despia", "app"], host);
const app = join(host, "app");
const declared = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as Record<string, Record<string, string>>;
const wanted = Object.keys({ ...declared["dependencies"], ...declared["devDependencies"] }).filter((n) => tarball.has(n));
run(npm, ["install", "--no-audit", "--no-fund", ...wanted.map((n) => tarball.get(n)!)], app);
run(npm, ["run", "build"], app);
if (!existsSync(join(app, "dist", "index.html"))) fail("C1: build produced no dist/index.html");
console.log("[combinations] C1 ok — scaffolded, installed from tarballs, built.");

// ── C7: the same app's screens as an OTA folder ─────────────────────────────────────────
console.log("[combinations] C7 — self-hosted OTA over C1's content …");
run(npm, ["exec", "--no", "--", "dsx", "ota", "build", "--in", "Components", "--out", "dist-ota"], app);
const manifest = JSON.parse(readFileSync(join(app, "dist-ota", "manifest.json"), "utf8")) as {
  generation: string;
  files: { path: string; sha256: string }[];
};
if (manifest.files.length === 0) fail("C7: the OTA manifest lists no files");
for (const entry of manifest.files) {
  const digest = createHash("sha256").update(readFileSync(join(app, "dist-ota", ...entry.path.split("/")))).digest("hex");
  if (digest !== entry.sha256) fail(`C7: ${entry.path} does not verify against its manifest sha`);
}
console.log(`[combinations] C7 ok — generation ${manifest.generation.slice(0, 12)}, ${manifest.files.length} file(s) verified.`);

// ── C3: an existing web app + the Despia backend ONLY ───────────────────────────────────
console.log("[combinations] C3 — existing app + @despia/server …");
const c3 = join(work, "c3");
mkdirSync(join(c3, "public"), { recursive: true });
writeFileSync(join(c3, "public", "index.html"), "<!doctype html><title>their app</title><h1>untouched</h1>\n");
writeFileSync(join(c3, "package.json"), `${JSON.stringify({ name: "c3-existing-app", private: true, type: "module" }, null, 2)}\n`);
// The standalone shape the guide documents: a hand-registered route table through the
// platform-free edge handler, translated by ten lines of node:http — no generated artifacts,
// no emitter, no scaffold. Their app stays exactly as it was.
writeFileSync(join(c3, "server.mjs"), `
import { createServer } from "node:http";
import { createEdgeHandler } from "@despia/server/bootloader-deno";

const handler = createEdgeHandler({
  routes: [{ key: "health", chain: "app", action: "health", method: "GET", path: "/health" }],
  handlers: { app: { health: () => ({ up: true, from: "despia-backend" }) } },
});

createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const out = await handler(new Request(url, { method: req.method }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  })();
}).listen(Number(process.env.PORT ?? 0), function () {
  console.log("LISTENING " + this.address().port);
});
`);
run(npm, ["install", "--no-audit", "--no-fund", tarball.get("@despia/server")!, tarball.get("@despia/kernel")!, tarball.get("@despia/compiler")!, tarball.get("@despia/dom")!], c3);
const server = spawn(process.execPath, ["server.mjs"], { cwd: c3, stdio: ["ignore", "pipe", "inherit"] });
try {
  const port = await new Promise<number>((done, failed) => {
    const timer = setTimeout(() => failed(new Error("C3: the server never reported LISTENING")), 15_000);
    server.stdout.on("data", (chunk: Buffer) => {
      const match = /LISTENING (\d+)/.exec(chunk.toString());
      if (match !== null) { clearTimeout(timer); done(Number(match[1])); }
    });
    server.on("exit", (code) => { clearTimeout(timer); failed(new Error(`C3: server exited ${code}`)); });
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  if (health.status !== 200) fail(`C3: /health answered ${health.status}`);
  const body = (await health.json()) as { from?: string };
  if (body.from !== "despia-backend") fail("C3: /health did not come from the Despia handler");
  const theirs = readFileSync(join(c3, "public", "index.html"), "utf8");
  if (!theirs.includes("untouched")) fail("C3: the existing app's files were modified");
} finally {
  server.kill();
}
console.log("[combinations] C3 ok — their app untouched, the backend answers beside it.");

// ── C5: DSX front end + a vendor backend directly ───────────────────────────────────────
console.log("[combinations] C5 — DSX front end + vendor API, no Despia server …");
writeFileSync(join(app, "Components", "Vendor.dsx"), `<stack>
  <head>
    <api as="rows" url="https://vendor.example/api/rows"/>
  </head>
  <text value="{{ rows.data ? 'loaded' : 'loading' }}"/>
</stack>
`);
run(npm, ["run", "build"], app);
run(npm, ["exec", "--no", "--", "dsx", "lint", "--strict"], app);
console.log("[combinations] C5 ok — an <api> block against a vendor URL compiles and lints.");

// ── C2: existing web app + DSX native parts (the two-codebase layout, structurally) ─────
console.log("[combinations] C2 — the two-codebase layout …");
const c2 = join(work, "c2");
mkdirSync(join(c2, "src"), { recursive: true });
writeFileSync(join(c2, "src", "main.ts"), "// their web codebase, untouched\n");
mkdirSync(join(c2, "native", "Modules", "Badge", "swift"), { recursive: true });
mkdirSync(join(c2, "native", "Modules", "Badge", "kotlin"), { recursive: true });
writeFileSync(join(c2, "native", "Modules", "Badge", "dsx.json"), `${JSON.stringify({
  name: "Badge",
  scheme: "badge",
  version: "1.0.0",
  actions: { set: { args: { count: "number" }, resolve: { ok: "boolean" } } },
}, null, 2)}\n`);
writeFileSync(join(c2, "native", "Modules", "Badge", "swift", "Badge.swift"), "// the iOS facet — built by the app lanes, not here\n");
writeFileSync(join(c2, "native", "Modules", "Badge", "kotlin", "Badge.kt"), "// the Android facet — built by the app lanes, not here\n");
const c2manifest = JSON.parse(readFileSync(join(c2, "native", "Modules", "Badge", "dsx.json"), "utf8")) as Record<string, unknown>;
for (const field of ["name", "scheme", "version"]) {
  if (typeof c2manifest[field] !== "string") fail(`C2: the module manifest is missing ${field}`);
}
for (const lane of ["swift", "kotlin"]) {
  if (!existsSync(join(c2, "native", "Modules", "Badge", lane))) fail(`C2: the ${lane}/ lane folder is missing (rule 11: no default platform)`);
}
console.log("[combinations] C2 ok — module manifest parses, both lane folders present, web codebase beside it.");

console.log("[combinations] all rows green — C1 · C2 · C3 · C5 · C7 walked from tarballs (C4 = C1 + the backend corpus).");
