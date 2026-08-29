//
//  preview-publish.ts — the publish client for the multi-tenant preview worker
//  (preview-hosting.md): take a `dsx build` outDir VERBATIM, ship it to the control
//  plane as an integrity-pinned bundle, and activate the hostname. The same client
//  speaks to the local runner (preview-local.ts) and the deployed worker — verifying
//  locally proves the wire, not a simulation of it.
//
//  The deployment id is DERIVED, not invented: the sha256 of `despia/local.json`
//  (which already pins every file of the build) truncated to 16 hex — the same input
//  always publishes to the same immutable prefix, so re-publishing an unchanged build
//  is a 409 that costs nothing and a changed build can never collide with a live one.
//
//  Run: npm run preview:publish -- --dir <outDir> --app <name> [--host <label>]
//         [--origin http://127.0.0.1:8788] [--deployment <id>] [--no-activate]
//  Key: DSX_PREVIEW_ADMIN_KEY (env), the same secret the worker holds.
//

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

function fail(message: string): never {
  console.error(`[preview-publish] ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
  return value;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const info = statSync(abs);
    if (info.isDirectory()) out.push(...walk(abs));
    else if (info.isFile()) out.push(abs);
  }
  return out;
}

const dir = arg("dir") ?? fail("--dir <outDir> is required (a dsx build output)");
const app = arg("app") ?? fail("--app <name> is required");
const host = arg("host") ?? app;
const origin = (arg("origin") ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const key = process.env["DSX_PREVIEW_ADMIN_KEY"] ?? "";
if (key === "") fail("DSX_PREVIEW_ADMIN_KEY is not set");

const paths = walk(dir).sort();
if (paths.length === 0) fail(`${dir} holds no files`);

let total = 0;
const files = paths.map((abs) => {
  const bytes = readFileSync(abs);
  total += bytes.byteLength;
  return {
    path: relative(dir, abs).split(sep).join("/"),
    b64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});
if (total > MAX_BUNDLE_BYTES) fail(`bundle is ${total} bytes; the preview ceiling is ${MAX_BUNDLE_BYTES}`);

// the deterministic deployment id: the build's own manifest hash when present
const manifest = files.find((f) => f.path === "despia/local.json");
const deployment =
  arg("deployment") ??
  (manifest !== undefined
    ? manifest.sha256.slice(0, 16)
    : createHash("sha256").update(files.map((f) => `${f.path}:${f.sha256}`).join("\n")).digest("hex").slice(0, 16));

const headers = { "x-dsx-preview-key": key, "content-type": "application/json" };

const put = await fetch(`${origin}/-/apps/${app}/deployments/${deployment}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ files }),
});
if (put.status === 409) {
  console.log(`[preview-publish] deployment ${deployment} already exists (unchanged build) — activating it.`);
} else if (put.status !== 201) {
  fail(`publish answered ${put.status}: ${await put.text()}`);
} else {
  const receipt = (await put.json()) as { files: number; bytes: number };
  console.log(`[preview-publish] published ${receipt.files} file(s), ${receipt.bytes} bytes as ${app}/${deployment}.`);
}

if (has("no-activate")) {
  console.log(`[preview-publish] --no-activate: pointer untouched.`);
  process.exit(0);
}

const act = await fetch(`${origin}/-/activate`, {
  method: "POST",
  headers,
  body: JSON.stringify({ host, app, deployment }),
});
if (act.status !== 200) fail(`activate answered ${act.status}: ${await act.text()}`);
const result = (await act.json()) as { permalink: string };
console.log(`[preview-publish] ${host} now serves ${app}/${deployment} (permalink ${result.permalink}).`);
