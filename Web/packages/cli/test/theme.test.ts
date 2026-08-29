//
//  theme.test.ts — the /edit/api/theme door (master plan P15): the corpus-fed token
//  vocabulary, the project theme.css round trip, and the absent-file law. The writer
//  and reader are also pinned directly, because the Studio's own file must survive its
//  own parser byte-for-value.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { emitProjectTheme, parseProjectTheme, startEditServer as bootEditServer } from "../src/edit.ts";

//  THE ADMISSION CREDENTIAL (edit.ts). Every request under /edit carries this run's secret, so
//  these tests drive the door a browser drives: `startEditServer` is wrapped to remember what
//  the run minted, and `fetch` is shadowed to present it. A test that means to prove the
//  REFUSAL calls `bareFetch` on purpose — there is exactly one place that should, and it says
//  so where it does it.
const bareFetch = globalThis.fetch;
let admission = "";
async function startEditServer(...args: Parameters<typeof bootEditServer>): ReturnType<typeof bootEditServer> {
  const server = await bootEditServer(...args);
  admission = server.admission;
  return server;
}
function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (admission !== "" && !headers.has("x-despia-edit")) headers.set("x-despia-edit", admission);
  return bareFetch(input as string, { ...init, headers });
}


const APP = `<stack><button label="Go"/></stack>\n`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-theme-api-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("theme file writer and reader are inverses on the canonical shape", () => {
  const light = { "--dsx-accent": "#ff2d55", "--dsx-radius": "2px" };
  const dark = { "--dsx-accent": "#b0254a" };
  const emitted = emitProjectTheme(light, dark);
  assert.match(emitted, /@media \(prefers-color-scheme: dark\)/, "the OS-dark guard rides along");
  assert.match(emitted, /\[data-dsx-theme="dark"\]/, "the explicit pin rides along");
  const parsed = parseProjectTheme(emitted);
  assert.deepEqual(parsed.light, light);
  assert.deepEqual(parsed.dark, dark);
});

test("parse ignores the media-guarded :root twin so dark values never leak into the light plane", () => {
  const parsed = parseProjectTheme(emitProjectTheme({ "--dsx-accent": "#111111" }, { "--dsx-accent": "#eeeeee" }));
  assert.equal(parsed.light["--dsx-accent"], "#111111");
  assert.equal(parsed.dark["--dsx-accent"], "#eeeeee");
});

test("the theme door: vocabulary from the corpus, write, overlay, clear", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // the fresh project: no file, and every corpus token rides with empty overrides
    const fresh = (await (await fetch(`${base}/edit/api/theme`)).json()) as
      { file: boolean; tokens: Array<{ name: string; css: string; kind: string; defaultLight: string; light: string; dark: string }> };
    assert.equal(fresh.file, false);
    const accent = fresh.tokens.find((t) => t.css === "--dsx-accent");
    assert.ok(accent !== undefined, "the corpus accent token is in the vocabulary");
    assert.equal(accent!.defaultLight, "#315cea", "the default is the corpus value, not a copy");
    assert.equal(accent!.light, "");
    assert.ok(fresh.tokens.some((t) => t.css === "--dsx-radius" && t.kind === "length"), "geometry rides the same plane");

    // a write lands the file in the canonical shape
    const put = await fetch(`${base}/edit/api/theme`, {
      method: "PUT",
      body: JSON.stringify({ tokens: { "--dsx-accent": { light: "#ff2d55", dark: "#b0254a" }, "--dsx-radius": { light: "2px" } } }),
    });
    assert.equal((await put.json() as { file: boolean }).file, true);
    const themePath = join(fx.root, "theme.css");
    assert.ok(existsSync(themePath));
    const written = readFileSync(themePath, "utf8");
    assert.match(written, /--dsx-accent: #ff2d55/);
    assert.match(written, /--dsx-radius: 2px/);

    // GET now overlays the project values on the same vocabulary
    const themed = (await (await fetch(`${base}/edit/api/theme`)).json()) as typeof fresh;
    assert.equal(themed.file, true);
    const themedAccent = themed.tokens.find((t) => t.css === "--dsx-accent")!;
    assert.equal(themedAccent.light, "#ff2d55");
    assert.equal(themedAccent.dark, "#b0254a");

    // a value can never escape its declaration: structure characters are stripped
    await fetch(`${base}/edit/api/theme`, {
      method: "PUT",
      body: JSON.stringify({ tokens: { "--dsx-accent": { light: "red} :root{--evil:1" } } }),
    });
    const survived = parseProjectTheme(readFileSync(themePath, "utf8"));
    assert.equal(survived.light["--dsx-accent"], "red :root--evil:1".replace(/[{};]/g, ""));
    assert.equal(survived.light["--evil"], undefined, "the injection stayed a value, never a declaration");

    // clearing every override removes the file - absence is the fresh state
    const clear = await fetch(`${base}/edit/api/theme`, { method: "PUT", body: JSON.stringify({ tokens: {} }) });
    assert.equal((await clear.json() as { file: boolean }).file, false);
    assert.ok(!existsSync(themePath));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("consumed tokens: the sheet knows what each token drives, skin and project alike", async () => {
  const fx = project();
  writeFileSync(join(fx.root, "Components/App.css"), ".hero { color: var(--dsx-accent); }\n");
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const themed = (await (await fetch(`${base}/edit/api/theme`)).json()) as
      { tokens: Array<{ css: string; consumers: string[] }> };
    const accent = themed.tokens.find((t) => t.css === "--dsx-accent")!;
    assert.ok(accent.consumers.includes("button"), `the kernel skin's button consumes accent: ${accent.consumers.join(",")}`);
    assert.ok(accent.consumers.includes("hero"), "the project's own sidecar selector shows too");
    const radius = themed.tokens.find((t) => t.css === "--dsx-radius")!;
    assert.ok(radius.consumers.includes("textfield"), `radius drives the field wells: ${radius.consumers.join(",")}`);
    // every row carries the field, even when empty - the shape is uniform
    assert.ok(themed.tokens.every((t) => Array.isArray(t.consumers)));
  } finally {
    await server.close();
    fx.cleanup();
  }
});
