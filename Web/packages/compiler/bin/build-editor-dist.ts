//
//  build-editor-dist.ts - emit the canvas editor's DEPLOYABLE web component:
//  OpenSource/CanvasEditor/dist/despia-editor.js — ONE self-contained ESM file
//  (kernel + @despia-native/element + the editor registry slice + the EditorCanvas facet +
//  the StackCanvas SDK + scoped CSS + customElements.define). The file is COMMITTED
//  and mirrored/published with the package, so any page — CDN, npm, file:// — gets
//  <despia-editor> with one script tag and zero framework install. Budget rides the
//  package's own expose declaration (dsx.json budgetKB — the /web/13 tool-grade law).
//
//  Usage: node packages/compiler/bin/build-editor-dist.ts
//  Regenerate on release (the version-bump flow); gate: build_canvas_editor.rb --check
//  parses the committed file so a stale-broken dist can never ship.
//

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { build, buildSync } from "esbuild";

import { buildRegistry } from "../src/registry.ts";
import { readExpose, sliceRegistry } from "../src/expose.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const root = repoRoot();
const web = join(root, "OpenSource/Web");
const pkg = join(root, "OpenSource/CanvasEditor");

const manifest = JSON.parse(readFileSync(join(pkg, "dsx.json"), "utf8")) as { scheme?: string; web?: Parameters<typeof readExpose>[1] };
const exposed = readExpose(manifest.scheme ?? "editor", manifest.web).find((e) => e.name === "StackEditor");
if (exposed === undefined) throw new Error("[editor-dist] dsx.json no longer exposes StackEditor");

const registry = buildRegistry([{ dir: pkg }]);
const slice = sliceRegistry(registry, exposed.qualified);

const outDir = join(pkg, "dist");
mkdirSync(outDir, { recursive: true });

// The standalone Canvas SDK is plain CommonJS, so it consumes a committed IIFE
// bridge to the canonical kernel interpreter. Regenerate that bridge as part of
// the editor release build; this prevents a kernel change from silently leaving
// Canvas' file:// distribution on an older expression implementation.
const canvasJseEntry = join(pkg, "src", "canonical-jse.ts");
const canvasJseOut = join(pkg, "src", "canonical-jse.js");
// nodePaths, because the bridge lives OUTSIDE the web workspace and so cannot resolve a
// bare `@despia-native/kernel` by walking up. It imports the package rather than a deep path into
// packages/kernel/src for a reason that only shows up in the element bundle below: a deep
// source path is a DIFFERENT module than the package entry, so the two would not dedupe.
const KERNEL_RESOLVE = [join(web, "node_modules")];
buildSync({ entryPoints: [canvasJseEntry], bundle: true, format: "iife", target: "es2022", outfile: canvasJseOut, absWorkingDir: web, logLevel: "silent", nodePaths: KERNEL_RESOLVE });
execSync(`node --check ${JSON.stringify(canvasJseOut)}`);

// the entry lives INSIDE the web workspace — esbuild resolves bare @despia-native/* specifiers
// by walking up from the importing file, and the package folder has no node_modules
const entryPath = join(web, ".editor-dist.entry.ts");
writeFileSync(entryPath, [
  `import { defineDsxElement } from "@despia-native/element";`,
  `import facet from ${JSON.stringify(join(pkg, "web/index.js"))};`,
  `const registry = JSON.parse(${JSON.stringify(JSON.stringify(slice))});`,
  `defineDsxElement({ tag: ${JSON.stringify(exposed.tag)}, component: ${JSON.stringify(exposed.qualified)}, registry, modules: [facet] });`,
  "",
].join("\n"));
const outfile = join(outDir, "despia-editor.js");
// ONE INTERPRETER IN THE ARTIFACT.
//
// canvas-editor.js is UMD, and its CommonJS arm does `require("./canonical-jse.js")` to pick
// up the pre-bundled kernel bridge - which is right for the standalone file:// SDK, where
// that IIFE is the only kernel present. esbuild follows the require statically, so the
// ELEMENT bundle was carrying the bridge's whole bundled copy of the interpreter ON TOP of
// the live kernel modules it already links: ~82 KB of duplicate, and two evaluators that
// could in principle disagree about the same expression while both claiming to be canonical.
//
// Resolving that require to the bridge's SOURCE lets it collapse into the kernel this bundle
// already has. It is a plugin rather than `alias` because esbuild rejects a relative alias
// name, and async rather than buildSync because buildSync takes no plugins.
const canonicalSource = { name: "canvas-jse-source", setup(b: { onResolve: Function }) {
  b.onResolve({ filter: /canonical-jse\.js$/ }, () => ({ path: canvasJseEntry }));
} };
await build({ entryPoints: [entryPath], bundle: true, minify: true, format: "esm", target: "es2022", outfile, absWorkingDir: web, logLevel: "silent", nodePaths: KERNEL_RESOLVE, plugins: [canonicalSource] });
rmSync(entryPath);

const bundle = readFileSync(outfile);
const gz = gzipSync(bundle).length;
if (gz > exposed.budgetKB * 1024) {
  throw new Error(`[editor-dist] despia-editor.js is ${(gz / 1024).toFixed(1)}KB gz — over the declared ${exposed.budgetKB}KB budget (dsx.json expose)`);
}
execSync(`node --check ${JSON.stringify(outfile)}`);
console.log(`[editor-dist] dist/despia-editor.js — ${(bundle.length / 1024).toFixed(1)}KB, ${(gz / 1024).toFixed(1)}KB gz (budget ${exposed.budgetKB}KB) — <${exposed.tag}> self-contained`);

// ── DespiaEditor.html — the zero-setup demo of the WEB COMPONENT (double-click,
// no server): the bundle is INLINED (a src= module script is CORS-blocked from
// file://), the sample deck rides a property write. The CanvasEditor.html trick,
// applied to the component. Regenerated together with dist; not byte-gated (it
// embeds the kernel — the release flow regenerates both).
const inlineJs = (s: string): string => s.replace(/<\/script/g, "<\\/script");
const inlineTpl = (s: string): string => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
const sampleDeck = readFileSync(join(pkg, "samples/meals.dsx"), "utf8");
writeFileSync(join(pkg, "DespiaEditor.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSX Editor — the web component, zero setup</title>
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0b; color: #eee; font-family: system-ui, sans-serif; }
  header { padding: 12px 16px; font-size: 13px; color: #9a9aa2; border-bottom: 1px solid #1c1c1e; }
  header b { color: #fff; }
  ${exposed.tag} { display: block; height: calc(100% - 110px); }
  #events { margin: 0; padding: 8px 16px; height: 44px; overflow: auto; font: 11px/1.5 ui-monospace, monospace; color: #8f8; border-top: 1px solid #1c1c1e; }
</style>
</head>
<body>
<header><b>DSX Editor</b> — the canvas editor as a self-contained web component (this page inlines its runtime; nothing to install, no server)</header>
<${exposed.tag} id="ed"></${exposed.tag}>
<pre id="events"></pre>
<script>
  const ed = document.getElementById("ed");
  const events = document.getElementById("events");
  for (const name of ["ready", "select", "change", "drop", "preview", "edit"]) {
    ed.addEventListener(name, (e) => {
      const brief = name === "change" ? "{tree: …}" : JSON.stringify(e.detail)?.slice(0, 140);
      events.textContent = name + " " + brief + "\\n" + events.textContent;
    });
  }
</script>
<script type="module">
${inlineJs(bundle.toString("utf8"))}
</script>
<script type="module">
  // rich data through the JS property — the same deck CanvasEditor.html opens
  ed.deck = \`${inlineTpl(sampleDeck)}\`;
</script>
</body>
</html>
`);
console.log(`[editor-dist] DespiaEditor.html — the zero-setup web-component demo (bundle inlined)`);
