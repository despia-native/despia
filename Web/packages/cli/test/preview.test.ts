//
//  preview.test.ts — the dev server's framed preview and its typeface. Three contracts:
//  the shell serves (device sizes, scheme pins, the app iframe), the vendored Inter
//  subsets serve as real woff2 bytes, and the intended-face injection is DEV-ONLY —
//  the HTML the dev server sends carries the @font-face, the HTML the build writes to
//  disk does not, so production ships exactly what the app author declared.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildProject, loadConfig } from "../src/index.ts";
import { startDevServer, DEV_FONTS_PREFIX, PREVIEW_PATH, resolveDevFontsDir, previewPage } from "../src/dev.ts";
const TYPE_FONTS = join(dirname(new URL(import.meta.url).pathname), "../../../../Type/vendor/inter");

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-preview-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "previewed", scheme: "pv" }),
    "dsx.config.json": JSON.stringify({ name: "Previewed", entry: "App", outDir: "dist" }),
    "Components/App.dsx": `<stack>\n  <text value="Hello preview"/>\n</stack>\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("the framed preview serves: iframe of the app, size presets, scheme pins, the raw-app door", async () => {
  const fx = project();
  const config = loadConfig(fx.root);
  buildProject(config);
  const server = await startDevServer(config, { port: 0, watch: false, log: () => {} });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${PREVIEW_PATH}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<iframe id="app" src="\/"/);
    for (const control of ["Phone", "Tablet", "Desktop", "Auto", "Light", "Dark", "Open raw app"]) {
      assert.ok(html.includes(control), `preview shell is missing "${control}"`);
    }
    // the scheme toggle pins the DOCUMENTED attribute, the same one a host page uses
    assert.match(html, /data-dsx-theme/);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("the Type satellite's Inter subsets serve as real woff2, and nothing else does", async () => {
  const fx = project();
  const config = loadConfig(fx.root);
  buildProject(config);
  // the CORE carries no vendored bytes (purity's zero-vendored-core law): the server
  // RESOLVES the satellite's dir - here passed explicitly, as the repo's oracles do
  const server = await startDevServer(config, { port: 0, watch: false, log: () => {}, fontsDir: TYPE_FONTS });
  try {
    for (const file of ["InterVariable-latin.woff2", "InterVariable-latin-ext.woff2"]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${DEV_FONTS_PREFIX}${file}`);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get("content-type"), "font/woff2");
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", `${file} is not woff2`);
      assert.ok(bytes.length > 10_000, `${file} is suspiciously small`);
    }
    const miss = await fetch(`http://127.0.0.1:${server.port}${DEV_FONTS_PREFIX}anything-else.woff2`);
    assert.equal(miss.status, 404, "the font route is an allowlist, not a directory");
    assert.equal(resolveDevFontsDir(fx.root), null, "a bare project outside the repo resolves no fonts");
    assert.ok(resolveDevFontsDir(fx.root, TYPE_FONTS) !== null, "an explicit satellite dir resolves");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("the intended-face injection is DEV-ONLY: served HTML carries it, the build on disk does not", async () => {
  const fx = project();
  const config = loadConfig(fx.root);
  const built = buildProject(config);
  const onDisk = readFileSync(join(built.outDir, "index.html"), "utf8");
  assert.ok(!onDisk.includes("data-dsx-dev-font"), "the build output must ship exactly what the app declares");

  const withFonts = await startDevServer(config, { port: 0, watch: false, log: () => {}, fontsDir: TYPE_FONTS });
  try {
    const served = await (await fetch(`http://127.0.0.1:${withFonts.port}/`)).text();
    assert.ok(served.includes("data-dsx-dev-font"), "the dev server previews the intended face");
    assert.ok(served.includes(`${DEV_FONTS_PREFIX}InterVariable-latin.woff2`));
  } finally {
    await withFonts.close();
  }
  // and a project that resolves NO fonts degrades honestly: no @font-face, no lie
  const bare = await startDevServer(config, { port: 0, watch: false, log: () => {} });
  try {
    const served = await (await fetch(`http://127.0.0.1:${bare.port}/`)).text();
    assert.ok(!served.includes("data-dsx-dev-font"), "no resolvable face means no injection");
    const shell = await (await fetch(`http://127.0.0.1:${bare.port}${PREVIEW_PATH}`)).text();
    assert.ok(!shell.includes("data-dsx-dev-font"), "the shell degrades with it");
  } finally {
    await bare.close();
    fx.cleanup();
  }
});

test("the shell escapes the app name", () => {
  const html = previewPage(`<script>"pwn"</script>`, true);
  assert.ok(!html.includes(`<script>"pwn"`));
  assert.ok(html.includes("&lt;script&gt;"));
});
