//
//  build-demo.ts - assemble the Demo site: compile Demo + Foundation .dsx into the
//  registry, emit the browser kernel (tsc → dist/), copy the module web facets
//  (export-presence IS the gate — only facets that exist get registered), and write
//  the bootloader page. The .dsx sources are read from the module tree UNCHANGED —
//  zero source changes is the law (/web README).
//
//  Usage: node packages/compiler/bin/build-demo.ts
//

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, cpSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { buildSync } from "esbuild";
import {
  assertSafeRoutePath,
  assertSafeRouteTable,
  assertSafeRedirectTarget,
  resolveRouteOutput,
  renderEmbedFragment,
  offlineManifestText,
  renderPage,
  renderRedirect,
} from "@despia-native/server";
import type { RouteOutput } from "@despia-native/server";
import { universalLinkFiles } from "../src/universal-links.ts";
import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, FORM_ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "@despia-native/dom/theme";
import { UNIVERSAL_GLOBAL_TAGS, GLOBAL_ELEMENTS_CSS } from "@despia-native/dom/globals";
import { RICH_ELEMENT_TAGS } from "@despia-native/dom/elements";
import { FORM_ELEMENT_TAGS } from "@despia-native/dom/forms";
import { NATIVE_CONTROL_TAGS, NATIVE_CONTROLS_CSS } from "@despia-native/dom/native-controls";
import {
  STRUCTURAL_CONTROL_TAGS, STRUCTURAL_CONTROLS_CSS,
} from "@despia-native/dom/structural-controls";
import { OVERLAY_CONTROL_TAGS, OVERLAY_CONTROLS_CSS } from "@despia-native/dom/overlay-controls";
import { DATA_CONTROL_TAGS, DATA_CONTROLS_CSS } from "@despia-native/dom/data-controls";
import { MEDIA_PLAYBACK_CSS } from "@despia-native/dom/media-surfaces";

import { buildRegistry } from "../src/registry.ts";
import { scanDsxSpecifiers } from "../src/specifiers.ts";
import { LAYER_STATEMENT } from "../src/cssmap.ts";
import { readExpose, mergeExposed, lintExposed, registryUsesAnyTag, sliceRegistry } from "../src/expose.ts";
import { facetBindingIdent, facetBootImport, facetBootRegister } from "../src/facet-binding.ts";
import type { Registry } from "../src/resolve.ts";
import type { XmlNode } from "../src/xml.ts";
import {
  assertEmbedCompatible, embedEntrySource, registryUsesAttribute, registryUsesDeclaredInput,
  registryUsesBoundCollections,
  registryUsesInterpolatedAttribute, registryUsesJsGlobals, registryUsesFetch,
  registryUsesRegex,
  registryUsesHighlight, registryUsesCanvasZoom, registryUsesBlockIteration, registryUsesStyleFormulas, registryUsesStyleOverrides, registryUsesButtonVariants, registryMentions,
  embedDefines, registryUsesControlMetrics,
} from "./embed-entry.ts";

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
const modulesRoot = join(root, "ClosedSource/DSX/Modules");
const site = join(web, "demo/site");

function sliceUsesUniversalGlobals(slice: Registry): boolean {
  const visit = (node: XmlNode): boolean => {
    if (UNIVERSAL_GLOBAL_TAGS.has(node.tag)) return true;
    return node.children.some(visit);
  };
  return Object.values(slice.components).some((component) => visit(component.root));
}

function sliceUsesRichElements(slice: Registry): boolean {
  const visit = (node: XmlNode): boolean => {
    if (RICH_ELEMENT_TAGS.has(node.tag)) return true;
    return node.children.some(visit);
  };
  return Object.values(slice.components).some((component) => visit(component.root));
}

function sliceUsesNativeControls(slice: Registry): boolean {
  const visit = (node: XmlNode): boolean => {
    if (NATIVE_CONTROL_TAGS.has(node.tag)) return true;
    return node.children.some(visit);
  };
  return Object.values(slice.components).some((component) => visit(component.root));
}

function sliceUsesStructuralControls(slice: Registry): boolean {
  return registryUsesAnyTag(slice, STRUCTURAL_CONTROL_TAGS);
}

function sliceUsesOverlayControls(slice: Registry): boolean {
  return registryUsesAnyTag(slice, OVERLAY_CONTROL_TAGS);
}

function sliceUsesDataControls(slice: Registry): boolean {
  return registryUsesAnyTag(slice, DATA_CONTROL_TAGS);
}

const AUDIO_SURFACE_TAGS: ReadonlySet<string> = new Set(["audio"]);
const VIDEO_SURFACE_TAGS: ReadonlySet<string> = new Set(["video"]);
// <scaffold> is the APPLICATION shell (sidebar/inspector/pane layout + the adaptive
// breakpoint resolver + its share of the element sheet); image/scroll/spacer/divider
// are the static presentation primitives. Both are ordinary base-table elements — a
// widget embed that authors neither strips both factories and both CSS blocks.
const SCAFFOLD_TAGS: ReadonlySet<string> = new Set(["scaffold"]);
const STATIC_ELEMENT_TAGS: ReadonlySet<string> = new Set(["image", "scroll", "spacer", "divider"]);

function sliceUsesAudioSurface(slice: Registry): boolean {
  return registryUsesAnyTag(slice, AUDIO_SURFACE_TAGS);
}

function sliceUsesVideoSurface(slice: Registry): boolean {
  return registryUsesAnyTag(slice, VIDEO_SURFACE_TAGS);
}

const CONTROL_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "toggle", "switch", "slider", "textfield", "input", "searchbar", "textarea",
  "progress", "spinner", "activity", "stepper",
]);

function sliceUsesControlElements(slice: Registry): boolean {
  const visit = (node: XmlNode): boolean => {
    if (CONTROL_ELEMENT_TAGS.has(node.tag)) return true;
    return node.children.some(visit);
  };
  return Object.values(slice.components).some((component) => visit(component.root));
}

function sliceUsesFormElements(slice: Registry): boolean {
  const visit = (node: XmlNode): boolean => {
    if (FORM_ELEMENT_TAGS.has(node.tag)) return true;
    return node.children.some(visit);
  };
  return Object.values(slice.components).some((component) => visit(component.root));
}

function sliceUsesIcons(slice: Registry): boolean {
  const visit = (node: XmlNode): boolean => {
    if (node.attrs["icon"] !== undefined || node.attrs["icon-web"] !== undefined) return true;
    return node.children.some(visit);
  };
  return Object.values(slice.components).some((component) => visit(component.root));
}

/** A self-contained embed only needs the API transport when one of the components
 * in its complete registry slice declares an <api>. This is derived from the same
 * closed slice that is serialized into the bundle, so dependencies cannot be
 * accidentally stripped. Full applications leave the feature enabled. */
function sliceUsesApiBlocks(slice: Registry): boolean {
  return Object.values(slice.components).some((component) => component.head.apis.length > 0);
}

/** WebMCP (proposals/webmcp.md §3): the spec adapter is reachable only from a `<tool>` head
 *  row, so a slice that declares none cannot reach it and should not carry the binding. */
function sliceUsesAgentTools(slice: Registry): boolean {
  return Object.values(slice.components).some((component) => component.head.tools.length > 0);
}

function embedCssFor(slice: Registry): string {
  return [
    LAYER_STATEMENT,
    TOKENS_CSS,
    ELEMENTS_CSS,
    ...(sliceUsesControlElements(slice) ? [CONTROL_ELEMENTS_CSS] : []),
    ...(sliceUsesFormElements(slice) ? [FORM_ELEMENTS_CSS] : []),
    ...(sliceUsesRichElements(slice) ? [RICH_ELEMENTS_CSS] : []),
    ...(sliceUsesNativeControls(slice) ? [NATIVE_CONTROLS_CSS] : []),
    ...(sliceUsesStructuralControls(slice) ? [STRUCTURAL_CONTROLS_CSS] : []),
    ...(sliceUsesOverlayControls(slice) ? [OVERLAY_CONTROLS_CSS] : []),
    ...(sliceUsesDataControls(slice) ? [DATA_CONTROLS_CSS] : []),
    ...(sliceUsesAudioSurface(slice) || sliceUsesVideoSurface(slice) ? [MEDIA_PLAYBACK_CSS] : []),
    ...(sliceUsesUniversalGlobals(slice) ? [GLOBAL_ELEMENTS_CSS] : []),
    slice.css,
  ].join("\n");
}

// ── 1. the browser kernel (tsc emit with .ts → .js specifier rewriting) ─────────────
console.log("• tsc → dist/ (browser ES modules)");
// The deployable root is generated output, not an incremental cache. Starting from
// an empty directory prevents deleted modules and filesystem conflict copies from a
// previous build leaking into the offline manifest.
rmSync(join(web, "dist"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
// Invoke TypeScript with the current Node executable instead of going through
// `npx`. Besides avoiding package-manager network/prompt behavior in release
// builds, this keeps the demo builder deterministic on macOS, Windows, and Linux.
execFileSync(
  process.execPath,
  [join(web, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: web, stdio: "inherit" },
);

// ── 2. the compiled registry (Demo + Foundation, unchanged sources) ──────────────────
console.log("• compiling .dsx → registry.json");
// The unified route table (/web/04): URLs ↔ the same component pushes the Launcher does —
// deep links cold-load, Back pops, route.* reads publish, `href=` links resolve. The
// app-level source of truth is DSX/Modules/Config/routes.json (ONE declaration for every
// renderer — guards/redirects/requires included); the inline table below is only the
// fallback for a checkout without one.
const routesFile = join(modulesRoot, "Config/routes.json");
const routesDoc: { routes?: unknown[]; notFound?: string } = existsSync(routesFile)
  ? JSON.parse(readFileSync(routesFile, "utf8"))
  : {};
if (Array.isArray(routesDoc.routes)) console.log(`• route table: ${routesDoc.routes.length} entries from Config/routes.json`);
const MODULE_DIRS: Array<{ dir: string; scheme?: string }> = [
  { dir: join(modulesRoot, "Custom/Demo") },
  { dir: join(modulesRoot, "Mandatory/Foundation"), scheme: "shared" },
  // the editor package lives WITH the SDK it wraps (OpenSource/CanvasEditor is already
  // a published npm package + public mirror — its DSX component ships inside it)
  { dir: join(root, "OpenSource/CanvasEditor") },
  // the DSX Scene demo (dsx-scene.md P1) lives with the web kernel it demonstrates;
  // its /scene route rides the package-contributed route plane (web-manifest.ts W4)
  { dir: join(web, "packages/scene-demo") },
];
const registry = buildRegistry(
  MODULE_DIRS,
  [],
  {
    routes: (Array.isArray(routesDoc.routes) ? routesDoc.routes : [
      { path: "/", component: "demo.Launcher" },
    ]) as Registry["routes"],
    notFound: routesDoc.notFound,
    // OPT-IN neutral DSX Web motion (motion.ts): one browser-independent family on phones,
    // instant swaps at desktop widths (the wide lane), and the boot/deep-link silence rule.
    // The legacy ios/md families and ios edge swipe remain available only when an app asks.
    router: { transition: "dsx", masterDetailBreakpoint: 1024 },
  },
);
// Validate the complete untrusted route table before deleting or writing the
// existing site. Later output code uses the same resolver for every target.
assertSafeRouteTable((registry.routes ?? []).map((route) => route.path));
for (const route of registry.routes ?? []) {
  if (route.redirect !== undefined) assertSafeRedirectTarget(route.redirect);
}
const plannedRouteOutputs = new Map<string, string>();
for (const route of registry.routes ?? []) {
  if (route.path === "/" || route.path.includes("*")) continue;
  const dynamic = route.path.includes(":") || route.path.includes("{");
  const output = resolveRouteOutput(
    site,
    route.path,
    dynamic ? { parameterPlaceholder: "__param__" } : {},
  );
  const portableKey = output.relativePath.normalize("NFC").toLowerCase();
  const previous = plannedRouteOutputs.get(portableKey);
  if (previous !== undefined) {
    throw new Error(
      `[dsx static] route ${JSON.stringify(route.path)} shares output ` +
      `${JSON.stringify(output.relativePath)} with ${JSON.stringify(previous)}`,
    );
  }
  plannedRouteOutputs.set(portableKey, route.path);
}
rmSync(site, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
mkdirSync(site, { recursive: true });
// Keep the deployable demo inside one service-worker scope. The repository dev
// server can resolve ../../dist, but an offline worker scoped to /demo/site/
// cannot intercept those external URLs and the cached shell would boot blank.
const conflictCopyPath = /(?:^|[/\\])[^/\\]+ 2(?:\.[^/\\]*)?$/;
cpSync(join(web, "dist"), join(site, "dist"), {
  recursive: true,
  // Defence in depth for sync-backed workspaces: even if the filesystem creates a
  // Finder-style duplicate between clean and copy, it cannot become a deploy asset.
  filter: (source) => !conflictCopyPath.test(source),
});
writeFileSync(join(site, "registry.json"), JSON.stringify(registry));
// The font module reads the app's font registry from the site root — the same contract file
// prepare_modules emits into a native bundle. The demo bundles no fonts, and an app with no
// bundled fonts ships an explicit empty registry rather than letting every boot 404 the fetch
// (the browser logs that as a console error, which the walk's error gate rightly refuses).
writeFileSync(join(site, "DSXFontRegistry.json"), JSON.stringify({ families: {} }));

// Every SSR page links /icon.svg (page-render.ts: "the build ALWAYS writes /icon.svg").
// `despia build` does (cli build.ts appIconSvg — this is its demo twin); this builder did
// not, so every demo page 404'd its favicon and the appearance walk's zero-page-error
// gate went red the moment the favicon stopped being a data: URL.
writeFileSync(join(site, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#111111"/>
<text x="256" y="256" dy="0.36em" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="280" font-weight="700" fill="#ffffff">D</text>
</svg>
`);

// ── 3. module web facets (file presence = the gate; missing facet = dsx.has false) ──
// DISCOVERED, not listed. The comment above has always said file presence is the gate, and
// until now a hand-maintained array was the real gate: 31 of the 57 facets on disk reached
// the demo and 26 never did — including every web twin shipped by the inline-surface family
// (stripe, clerk, stream, revenuecat, admob, scanner, pay), so their one-to-one web
// fallbacks were never exercised by build:demo or the browser oracle that walks it.
//
// A facet's registration name is the `scheme:` it declares in its own source, which is also
// what the kernel registers it under — the manifest is not authoritative here because a
// module may carry no `scheme` key at all (Mandatory/Routing registers as `route`). Missing
// or unreadable is a LOUD failure: a facet that cannot name itself would register as
// undefined and shadow whatever sorted next to it.
//
// Each facet is esbuild-BUNDLED (not copied) so a facet may import within its own package —
// the editor facet pulls in the StackCanvas SDK; an import-free facet emits the same file it
// always did.
const FACET_ROOTS: string[] = [
  "ClosedSource/DSX/Modules",   // every app module's own web/ facet
  "OpenSource/CanvasEditor",    // the editor ships one from its own package
];

/** Every `<pkg>/web/index.js` under a root, repo-root-relative, in a stable order. */
function discoverFacets(rootRel: string): string[] {
  const found: string[] = [];
  const absRoot = join(root, rootRel);
  if (!existsSync(absRoot)) return found;
  const walk = (relDir: string): void => {
    const abs = join(root, relDir);
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const childRel = `${relDir}/${entry.name}`;
      if (entry.name === "web") {
        const facet = `${childRel}/index.js`;
        if (existsSync(join(root, facet))) found.push(facet);
        continue;                       // a web/ folder never contains another package
      }
      walk(childRel);
    }
  };
  walk(rootRel);   // a root's OWN web/ folder is reached by the walk like any other
  return found;
}

/** The scheme a facet registers itself under, read from its own source. */
function facetScheme(absPath: string): string {
  const source = readFileSync(absPath, "utf8");
  // A facet may spell `scheme: "x"` on its own line (the dominant idiom) or inline
  // inside `export default { scheme: "x", … }`. Line-anchor-only matching refused
  // three real facets (base, takescreenshot, reset) and made `build:demo` abort
  // before the oracle could run.
  const match = source.match(/\bscheme:\s*"([a-z0-9_.-]+)"/i);
  if (!match) throw new Error(`web facet declares no scheme: ${absPath}`);
  return match[1];
}

const FACETS: Array<[name: string, path: string]> = [];
const facetOwner = new Map<string, string>();
for (const rootRel of FACET_ROOTS) {
  for (const rel of discoverFacets(rootRel)) {
    const name = facetScheme(join(root, rel));
    const previous = facetOwner.get(name);
    if (previous !== undefined) {
      throw new Error(`two web facets claim scheme "${name}": ${previous} and ${rel}`);
    }
    facetOwner.set(name, rel);
    FACETS.push([name, rel]);
  }
}
FACETS.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** What a facet chunk never inlines.
 *  · `@despia-native/kernel` — the page's import map resolves it, so every facet shares the ONE kernel
 *    instance. Bundling it per-facet would both fail resolution (a ClosedSource facet path has no
 *    node_modules above it) and split kernel state per chunk.
 *  · `./vendor/*` — a module's binary/vendored player is FETCHED at build time from the coordinate
 *    pinned in its own dsx.lock.json (module-frameworks.md), so it is legitimately absent from a
 *    plain checkout. Keeping it external lets the facet's chunk build anyway and lets its own
 *    runtime guard produce its declared "this build carries no player" message, which is what the
 *    facet already does. Inlining it would make a missing optional artifact a build failure. */
const FACET_EXTERNALS = [
  "@despia-native/kernel", "@despia-native/kernel/keyboard",
  //  The MOUNT-HOST specifiers, for the same reason and by the same mechanism: a facet that
  //  instantiates components (Core/Apps mounts a Despia app into a shadow root) reaches the
  //  renderer and the compiler's resolver, and both are entries in the page's import map
  //  below. Bundling them into the facet's chunk would fail resolution from a ClosedSource
  //  path AND give that chunk its own renderer instance, which is the split-state failure
  //  the kernel entry already exists to prevent.
  "@despia-native/dom", "@despia-native/dom/theme", "@despia-native/compiler/cssmap", "@despia-native/compiler/resolve",
  "./vendor/*",
];

mkdirSync(join(site, "modules"), { recursive: true });
const present: Array<{ name: string; aliases: string[] }> = [];
/** scheme → the facet's SOURCE path (embeds bundle the exposing package's chunk) */
const facetSrcByScheme = new Map<string, string>();
for (const [name, rel] of FACETS) {
  const src = join(root, rel);
  if (!existsSync(src)) continue; // excluded module: not bundled at all
  // @despia-native/kernel stays EXTERNAL: the page's import map resolves it, so every facet shares
  // the ONE kernel instance. Bundling it per-facet would both fail resolution (a ClosedSource
  // facet path has no node_modules above it) and split kernel state per chunk.
  buildSync({ entryPoints: [src], bundle: true, minify: true, format: "esm", target: "es2022", outfile: join(site, "modules", `${name}.js`), absWorkingDir: web, logLevel: "silent", external: FACET_EXTERNALS });
  facetSrcByScheme.set(name, src);
  // dsx.json is the single source of truth for aliases (legacy schemes routed to
  // the owning module) — read at build, passed at registration, exactly like the
  // native generated registry. A facet never hand-declares its aliases.
  const manifestPath = join(dirname(dirname(src)), "dsx.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const aliases: string[] = Array.isArray(manifest.aliases) ? manifest.aliases : [];
  present.push({ name, aliases });
}
console.log(`• module facets: ${present.map((p) => (p.aliases.length ? `${p.name}(+${p.aliases.length} aliases)` : p.name)).join(", ")}`);

// Demo media assets — the /system gallery's bundled specimen clip (original synthetic
// media generated in-repo; no external assets, no licence question). The Demo module's
// web/media folder is copied verbatim when present; folder presence is the gate, like
// the facets above. The target is media-assets/ — NOT media/, which is the /media
// route's own output directory.
const demoMedia = join(modulesRoot, "Custom/Demo/web/media");
if (existsSync(demoMedia)) {
  cpSync(demoMedia, join(site, "media-assets"), { recursive: true, filter: (source) => !conflictCopyPath.test(source) });
  console.log("• demo media: web/media → site/media-assets");
}

// ── 4. the bootloader (a bootloader owns ZERO behavior — constitution) ──────────────
const importMap = {
  imports: {
    "@despia-native/kernel": "./dist/kernel/src/index.js",
    // dom/mcp-app.js is copied into the demo's dist and imports this; without the entry the
    // demo boots blank in a clean session. The check below is what found it — the same check
    // was passing over a false positive before scanDsxSpecifiers learned to ignore emitted
    // import statements, so this gap existed unnoticed on main.
    "@despia-native/kernel/mcp": "./dist/kernel/src/mcp.js",
    "@despia-native/kernel/keyboard": "./dist/kernel/src/keyboard.js",
    "@despia-native/compiler/cssmap": "./dist/compiler/src/cssmap.js",
    "@despia-native/compiler/options": "./dist/compiler/src/options.js",
    "@despia-native/compiler/resolve": "./dist/compiler/src/resolve.js",
    "@despia-native/compiler/component": "./dist/compiler/src/component.js",
    "@despia-native/dom": "./dist/dom/src/index.js",
    "@despia-native/dom/theme": "./dist/dom/src/theme.js",
    "@despia-native/dom/boot": "./dist/dom/src/boot.js",
    "@despia-native/dom/offline": "./dist/dom/src/offline.js",
  },
};

// Keep the exported site honest: TypeScript preserves package aliases in the browser
// ESM emit, so every bare @despia-native/* dependency must be represented in the import map. A
// missing entry otherwise survives all type/unit gates and becomes a clean-session
// blank page. Validate the complete copied browser graph before writing any shell.
{
  // The facet chunks keep @despia-native/kernel as a bare (external) specifier, so they are part of
  // the browser graph the import map must cover — scan them with the same check.
  const imported = new Set([
    ...scanDsxSpecifiers(join(site, "dist")),
    ...scanDsxSpecifiers(join(site, "modules")),
  ]);
  const missing = [...imported].filter((specifier) => !(specifier in importMap.imports)).sort();
  if (missing.length > 0) {
    throw new Error(`demo import map is missing browser dependencies: ${missing.join(", ")}`);
  }
}

writeFileSync(join(site, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>DSX demo</title>
<link rel="icon" href="data:,">
<script type="importmap">${JSON.stringify(importMap, null, 2)}</script>
<style>html, body { margin: 0; height: 100%; }</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="./main.js"></script>
</body>
</html>
`);

writeFileSync(join(site, "main.js"), `// Demo bootloader — mounts the kernel, registers the module chunks, hands off.
import { bootDsx } from "@despia-native/dom/boot";
import { registerOfflineFloor } from "@despia-native/dom/offline";
import { ModuleRegistry } from "@despia-native/kernel";
${present.map((p) => facetBootImport(p.name)).join("\n")}

// Anchored to THIS script's location, not the document: SSR-exported nested pages
// (gallery/index.html, user/__param__/index.html) load the same bootloader, and a
// document-relative "./registry.json" would resolve into their subdirectory and 404
// the deep-link boot.
const registry = await (await fetch(new URL("./registry.json", import.meta.url))).json();
const appBase = new URL("./", import.meta.url).pathname;

// register the module chunks FIRST — availability flags read the live registry.
// dsx.json aliases ride each registration (legacy schemes → the owning module).
${present.map((p) => facetBootRegister(p.name, p.aliases)).join("\n")}

const router = bootDsx({
  registry,
  host: document.getElementById("app"),
  entry: "demo.Launcher",
  base: appBase,
  app: { name: "DSX demo", version: "1.0.0", build: "web", env: "debug" },
  ${present.some((p) => p.name === "route") ? `configureRouter: ${facetBindingIdent("route")}NS.bindRouter,` : ""}
  attrs: {
    // the SAME availability keys Demo.swift / Demo.kt seed (dsx.has per scheme) — the
    // launcher rows badge off these; a scheme with no bundled web facet reads false.
    avail_haptic: ModuleRegistry.isAvailable("haptic"),
    avail_clipboard: ModuleRegistry.isAvailable("clipboard"),
    avail_share: ModuleRegistry.isAvailable("share"),
    avail_biometric: ModuleRegistry.isAvailable("biometric"),
    avail_location: ModuleRegistry.isAvailable("location"),
    avail_shot: ModuleRegistry.isAvailable("takescreenshot"),
    avail_push: ModuleRegistry.isAvailable("localpush"),
    avail_store: ModuleRegistry.isAvailable("store"),
    avail_media: ModuleRegistry.isAvailable("fileviewer"),
    avail_sensors: ModuleRegistry.isAvailable("scanner"),
    avail_chrome: ModuleRegistry.isAvailable("quickactions"),
    avail_data: ModuleRegistry.isAvailable("writevalue"),
    avail_scene3d: ModuleRegistry.isAvailable("scene3d"),
    avail_ar: ModuleRegistry.isAvailable("ar"),
  },
});

// the BUNDLED FLOOR (bundled-floor.md, web renderer): register the service worker —
// install once online, every later launch renders offline; publishes dsx.source.*
// (online/boot/web) into the store the markup alias already reads. Fail-open: no SW
// support / insecure context = a no-op. swUrl is anchored to THIS script (site root):
// register() resolves a bare string against the DOCUMENT, and a deep-link first visit
// on an exported nested page would 404 it into the fail-open catch — no floor, and a
// nested scope even when present.
void registerOfflineFloor({ swUrl: new URL("./dsx-sw.js", import.meta.url).href });
`);

// ── 5. web-component embeds (/web/13 W10): web.expose → /embed artifacts ─────────────
// Each exposed component becomes a self-contained ESM (kernel + @despia-native/element + its
// registry slice + css + customElements.define), a hash-pinned copy, and a DSD
// fragment — plus the plain-HTML host pages gate G10 drives (CSR + DSD variants).
const exposed = mergeExposed(MODULE_DIRS.map(({ dir, scheme }) => {
  const manifestPath = join(dir, "dsx.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scheme?: string; web?: Parameters<typeof readExpose>[1] };
  return readExpose(scheme ?? manifest.scheme ?? "", manifest.web);
}));
// The build-time EXPOSE lints (/web/13 §"Lint (build-time, on `expose`)", S-07): the three the
// doc declared but never ran — pushed-`vars` rejection (E), the missing-web-entry check for
// own-module calls (E), and the rich-typed-attribute-without-a-shape warning (W). A package
// that ships a web facet has a web twin (it can implement its own module actions in the embed),
// so lint 2 skips it. Errors abort the build alongside the tag/collision/budget checks.
const exposeLint = lintExposed(exposed, registry, new Set(facetSrcByScheme.keys()));
for (const warning of exposeLint.warnings) console.warn(warning);
if (exposeLint.errors.length > 0) throw new Error(exposeLint.errors.join("\n"));
if (exposed.length > 0) {
  const embedManifest: { [key: string]: { tag: string; origins: string[]; hash: string } } = {};
  for (const e of exposed) {
    const slice = sliceRegistry(registry, e.qualified);
    const usesUniversalGlobals = sliceUsesUniversalGlobals(slice);
    const usesControlElements = sliceUsesControlElements(slice);
    const usesFormElements = sliceUsesFormElements(slice);
    const usesRichElements = sliceUsesRichElements(slice);
    const usesNativeControls = sliceUsesNativeControls(slice);
    const usesStructuralControls = sliceUsesStructuralControls(slice);
    const usesOverlayControls = sliceUsesOverlayControls(slice);
    const usesDataControls = sliceUsesDataControls(slice);
    const usesAudioSurface = sliceUsesAudioSurface(slice);
    const usesVideoSurface = sliceUsesVideoSurface(slice);
    assertEmbedCompatible(slice, e.qualified);
    const usesBoundCollections = registryUsesBoundCollections(slice);
    // surface=/theme= gate their mount branches AND their theme.ts css blocks
    // (SURFACE_ELEMENTS_CSS / THEME_PIN_TABLES_CSS), so the detection also keeps the
    // rules for an author who hand-writes the class or the pin attribute/selector.
    const usesSurface = registryUsesAttribute(slice, "surface")
      || registryMentions(slice, "dsx-surface-");
    const usesPressedState = registryUsesAttribute(slice, "a11yPressed")
      || registryUsesAttribute(slice, "aria-pressed");
    const usesRole = registryUsesAttribute(slice, "role");
    const usesClassFormulas = registryUsesInterpolatedAttribute(slice, "class");
    const usesTheme = registryUsesAttribute(slice, "theme")
      || registryUsesAttribute(slice, "data-dsx-theme")
      || registryMentions(slice, "data-dsx-theme");
    const usesDensity = registryUsesAttribute(slice, "density")
      || registryUsesAttribute(slice, "data-dsx-density")
      || registryMentions(slice, "data-dsx-density");
    const usesDisabled = registryUsesAttribute(slice, "disabled")
      || registryUsesAttribute(slice, "disabled-if");
    // The desktop input grammar (hover · shortcut · focusOrder) is a sliceable feature —
    // an embed that authors none of it strips the whole mount block (and HoverLifecycle).
    // G4 unified input — a sliceable feature (see registryUsesDeclaredInput): no head
    // `<input>` and no `on:input.<name>` handler ⇒ the whole input runtime folds away.
    const usesDeclaredInput = registryUsesDeclaredInput(slice);
    const usesDesktopInput = registryUsesAttribute(slice, "shortcut")
      || registryUsesAttribute(slice, "focusOrder")
      || registryUsesAttribute(slice, "on:hoverStart")
      || registryUsesAttribute(slice, "on:hoverEnd");
    // The interactive pointer/keyboard gestures (longpress · drag · adjust) — a passive
    // display embed authors none of them and strips all three from the mount.
    const usesGestures = registryUsesAttribute(slice, "on:longpress")
      || registryUsesAttribute(slice, "on:drag")
      || registryUsesAttribute(slice, "on:dragStart")
      || registryUsesAttribute(slice, "on:dragEnd")
      || registryUsesAttribute(slice, "on:adjust");
    const usesIcons = sliceUsesIcons(slice);
    const usesApiBlocks = sliceUsesApiBlocks(slice);
    const usesAgentTools = sliceUsesAgentTools(slice);
    const usesScaffold = registryUsesAnyTag(slice, SCAFFOLD_TAGS);
    const usesStaticElements = registryUsesAnyTag(slice, STATIC_ELEMENT_TAGS);
    // the inline markdown parser (markdown.ts) is reachable ONLY from a `<text markdown=>`;
    // a slice that authors none of it tree-shakes the whole module away.
    const usesMarkdown = registryUsesAttribute(slice, "markdown");
    // the JS-globals layer (Date/URL/Intl/JSON/Math/Map/Set/crypto/base64 — core.ts
    // "the JS-GLOBALS FOLD"): reachable only by NAME, so a slice that names none of
    // it cannot reach it. The single largest optional block in a minimal embed.
    const usesJsGlobals = registryUsesJsGlobals(slice);
    const usesFetch = registryUsesFetch(slice);
    // the JSE regex engine (regex.ts FULL/ABSENT): reachable only through a `/…/`
    // literal, the RegExp/regex names, or a foreign payload — same superset rule.
    const usesRegex = registryUsesRegex(slice);
    const usesHighlight = registryUsesHighlight(slice);
    // R21: the transform announcement, reachable only by a canvas under a scaled world.
    const usesCanvasZoom = registryUsesCanvasZoom(slice);
    // block iteration (loops + block-scope mutation, jse.ts/codegen.ts BLOCK ITERATION):
    // reachable only through loop keywords, brace-bodied lambdas/functions, or ++/--.
    const usesBlockIteration = registryUsesBlockIteration(slice);
    // the runtime style-formula bridge (cssmap.ts vocabulary + legacy-attr runtime
    // half). Universal globals keep it: their factories tint through semantic
    // fallbacks even without an authored color=.
    const usesStyleFormulas = registryUsesStyleFormulas(slice) || usesUniversalGlobals;
    // the style-override plane (kernel style-overrides.ts + the mount/JSE doors):
    // reachable only through a declared <override>, an override: spelling, or a
    // dsx.override read — a knob-free slice folds the resolver and both doors away.
    const usesStyleOverrides = registryUsesStyleOverrides(slice);
    // the non-default button skin (bordered / destructive / cancel words, theme.ts)
    const usesButtonVariants = registryUsesButtonVariants(slice);
    // the sampled linear() spring upgrade (theme.ts SPRING_LINEAR_CSS) is reachable
    // only through a sheet that names `--dsx-ease-spring*`. A widget that imports
    // none of those sheets and never authors the token folds the float table.
    const usesSpring = usesControlElements || usesFormElements || usesRichElements
      || usesNativeControls || usesStructuralControls || usesOverlayControls
      || usesDataControls || usesUniversalGlobals
      || registryMentions(slice, "ease-spring");
    // the density plane's control metrics (theme.ts CONTROL_METRICS_CSS): 28 token rows
    // that only the control sheets read, so a control-free widget folds them away.
    const usesControlMetrics = registryUsesControlMetrics(slice, {
      universalGlobals: usesUniversalGlobals,
      controlElements: usesControlElements,
      formElements: usesFormElements,
      richElements: usesRichElements,
      nativeControls: usesNativeControls,
      structuralControls: usesStructuralControls,
      overlayControls: usesOverlayControls,
      dataControls: usesDataControls,
      audioSurface: usesAudioSurface,
      videoSurface: usesVideoSurface,
      boundCollections: usesBoundCollections,
    });
    const embedCss = embedCssFor(slice);
    const outDir = join(site, "embed", e.scheme);
    mkdirSync(outDir, { recursive: true });
    // the exposing package's chunk ships WITH its embeds (13: "the component's package
    // chunk + its requires are bundled — the honest subset"); a facet-provided
    // component (18) only exists inside an embed through this import.
    const facetSrc = facetSrcByScheme.get(e.scheme);
    const entryPath = join(site, "embed", `.${e.scheme}.${e.name}.entry.ts`);
    writeFileSync(entryPath, embedEntrySource({
      registry: slice,
      tag: e.tag,
      component: e.qualified,
      facetSrc,
      features: {
        universalGlobals: usesUniversalGlobals,
        controlElements: usesControlElements,
        formElements: usesFormElements,
        richElements: usesRichElements,
        nativeControls: usesNativeControls,
        structuralControls: usesStructuralControls,
        overlayControls: usesOverlayControls,
        dataControls: usesDataControls,
        audioSurface: usesAudioSurface,
        videoSurface: usesVideoSurface,
        boundCollections: usesBoundCollections,
      },
    }));
    const outfile = join(outDir, `${e.name}.js`);
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2022",
      outfile,
      absWorkingDir: web,
      logLevel: "silent",
      define: embedDefines({
        apis: usesApiBlocks,
        webmcp: usesAgentTools,
        globals: usesUniversalGlobals || usesDataControls,
        rich: usesRichElements,
        icons: usesIcons,
        boundCollections: usesBoundCollections,
        surfaces: usesSurface,
        pressed: usesPressedState,
        role: usesRole,
        classFormulas: usesClassFormulas,
        theme: usesTheme,
        density: usesDensity,
        controlMetrics: usesControlMetrics,
        disabled: usesDisabled,
        desktopInput: usesDesktopInput,
        declaredInput: usesDeclaredInput,
        gestures: usesGestures,
        scaffold: usesScaffold,
        staticElements: usesStaticElements,
        controls: usesControlElements,
        markdown: usesMarkdown,
        jsGlobals: usesJsGlobals,
        fetch: usesFetch,
        regex: usesRegex,
        highlight: usesHighlight,
        canvasZoom: usesCanvasZoom,
        blockIteration: usesBlockIteration,
        styleFormulas: usesStyleFormulas,
        styleOverrides: usesStyleOverrides,
        buttonVariants: usesButtonVariants,
        spring: usesSpring,
      }),
    });
    rmSync(entryPath);
    const bundle = readFileSync(outfile);
    const hash = createHash("sha256").update(bundle).digest("hex").slice(0, 8);
    copyFileSync(outfile, join(outDir, `${e.name}.${hash}.js`)); // the immutable pin
    writeFileSync(join(outDir, `${e.name}.html`), renderEmbedFragment(slice, e.qualified, e.tag, embedCss)); // the DSD fragment (default attrs)
    embedManifest[`${e.scheme}/${e.name}`] = { tag: e.tag, origins: e.origins, hash };
    const gz = gzipSync(bundle).length;
    // the v1 size law (13/G10): 40KB gz per self-contained WIDGET embed, a BUILD ERROR
    // when exceeded. A tool-grade embed must DECLARE its bigger budget in the manifest
    // (expose.budgetKB) — the override is printed, never silent.
    if (gz > e.budgetKB * 1024) {
      throw new Error(`[dsx embed] <${e.tag}> is ${gz}B (${(gz / 1024).toFixed(1)}KB) gz — over its ${e.budgetKB * 1024}B (${e.budgetKB}KB) budget (G10${e.budgetKB === 40 ? ", the final widget law; declare expose.budgetKB only for a tool-grade embed" : " override"}).`);
    }
    console.log(`• embed: <${e.tag}> → embed/${e.scheme}/${e.name}.js (${(bundle.length / 1024).toFixed(1)}KB, ${(gz / 1024).toFixed(1)}KB gz — budget ${e.budgetKB}KB${e.budgetKB !== 40 ? " (DECLARED tool-grade override, /web/13)" : ""})`);
  }
  writeFileSync(join(site, "embed", "manifest.json"), JSON.stringify(embedManifest, null, 2));

  // gate G10's third-party page: NOT a DSX app — plain HTML + one script tag.
  const hostPage = (card: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>embed host (a plain page, not a DSX app)</title></head>
<body style="background:#000; color:#fff; margin:clamp(0.75rem, 4vw, 2rem); font-family:system-ui">
${card}
<script type="module" src="./embed/demo/EmbedCard.js"></script>
<p id="log" style="color:#8f8"></p>
<button id="drive">drive attribute</button>
<script type="module">
  const card = document.querySelector("demo-embedcard");
  card.addEventListener("cheer", (e) => { document.getElementById("log").textContent = "cheer:" + JSON.stringify(e.detail); });
  document.getElementById("drive").addEventListener("click", () => card.setAttribute("count", "7"));
</script>
</body></html>
`;
  const cardTag = `<demo-embedcard title="Third-party page" count="3"><span slot="footer" style="color:#9f9">light-dom footer</span></demo-embedcard>`;
  writeFileSync(join(site, "embed-host.html"), hostPage(cardTag));
  // the DSD variant: the PRE-RENDERED fragment paints before any script runs
  const cardSlice = sliceRegistry(registry, "demo.EmbedCard");
  const dsd = renderEmbedFragment(cardSlice, "demo.EmbedCard", "demo-embedcard", embedCssFor(cardSlice), { title: "Third-party page", count: 3 })
    .replace("</demo-embedcard>", `<span slot="footer" style="color:#9f9">light-dom footer</span></demo-embedcard>`);
  writeFileSync(join(site, "embed-host-dsd.html"), hostPage(dsd));

  // gate G10-editor: the TOOL-GRADE embed on a plain page — the canvas editor as a
  // real custom element (one script tag + <despia-editor>), attribute-driven, its SDK
  // events re-dispatching as CustomEvents. Not a DSX app; the deck rides the attribute
  // as JSON (rich data through the coercion path, /web/13).
  if (exposed.some((e) => e.qualified === "editor.StackEditor")) {
    writeFileSync(join(site, "editor-host.html"), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>editor embed host (a plain page, not a DSX app)</title></head>
<body style="background:#151517; color:#fff; margin:clamp(0.75rem, 4vw, 2rem); font-family:system-ui">
<despia-editor id="ed" controls="false"
  deck='{"tag":"vstack","attrs":{"style":"gap: 8px; padding: 16px"},"children":[{"tag":"text","attrs":{"value":"Hello embed"},"children":[]},{"tag":"button","attrs":{"label":"Tap me"},"children":[]}]}'
  style="display:block; width:min(420px, 100%); height:min(560px, 75dvh)"></despia-editor>
<p id="log" style="color:#8f8"></p>
<button id="preview">toggle preview</button>
<script type="module">
  const ed = document.getElementById("ed");
  const log = (line) => { document.getElementById("log").textContent += line + " | "; };
  ed.addEventListener("ready", () => log("ready"));
  ed.addEventListener("select", (e) => log("select:" + ((e.detail && e.detail.id) ? "id" : JSON.stringify(e.detail))));
  ed.addEventListener("preview", (e) => log("preview:" + JSON.stringify(e.detail)));
  document.getElementById("preview").addEventListener("click", () => ed.setAttribute("preview", ed.getAttribute("preview") === "true" ? "false" : "true"));
  // Install every host listener before the module defines/upgrades the element.
  // The editor can finish its first layout on the next animation frame, so a
  // preceding module script may otherwise dispatch the ready event before this block
  // executes on fast/local loads.
  await import("./embed/editor/StackEditor.js");
</script>
</body></html>
`);
  }
}

// ── 5b. per-route SSR export (the SSR × floor composition, bundled-floor.md §2c) ─────
// Every STATIC route gets a full SSR'd page at <path>/index.html — server paint with the
// route's own markup + meta, hydrated by the SAME bootloader (deep-link boot mounts the
// right screen). Because these land BEFORE the manifest emit they ride the offline
// generation: the worker serves the MATCHING route's SSR page offline (per-route first
// paint, not just the shell). The demo site is served NESTED (…/demo/site/), so the
// importmap + main.js references are re-based per route depth; an app hosted at its
// origin root can use exportStatic() with one root-absolute shell instead. "/" keeps the
// hand-written client shell (the walk's baseline).
const dynamicRoutePages: { pattern: string; page: string }[] = [];
{
  const routes = (registry as { routes?: Array<{ path: string; component?: string; redirect?: string; meta?: { title?: string; description?: string } }> }).routes ?? [];
  let ssrCount = 0;
  const writeSSR = (output: RouteOutput, component: string, vars: Record<string, unknown>, meta: { title?: string; description?: string }): void => {
    const depth = output.relativePath.split("/").length - 1;
    const up = "../".repeat(depth);
    mkdirSync(dirname(output.outputPath), { recursive: true });
    const rebasedMap = { imports: Object.fromEntries(Object.entries(importMap.imports).map(([k, v]) => [k, up + v.replace(/^\.\//, "")])) };
    writeFileSync(output.outputPath, renderPage(registry, component, vars, meta, {
      appName: "DSX demo",
      importMapJson: JSON.stringify(rebasedMap),
      mainSrc: `${up}main.js`,
      // the demo mounts under /demo/site/, so the icon href carries that prefix,
      // ABSOLUTE: Chromium re-resolves the favicon link against the URL after every
      // pushState, so a depth-relative href breaks the moment the router navigates
      // (absolute /icon.svg 404'd on every exported page before that)
      iconHref: "/demo/site/icon.svg",
    }));
  };
  for (const route of routes) {
    assertSafeRoutePath(route.path);
    const dynamic = route.path.includes(":") || route.path.includes("{") || route.path.includes("*");
    if (route.path === "/" ) continue;
    if (route.redirect !== undefined && !dynamic) {
      const output = resolveRouteOutput(site, route.path);
      mkdirSync(dirname(output.outputPath), { recursive: true });
      writeFileSync(output.outputPath, renderRedirect(route.redirect));
      ssrCount += 1;
      continue;
    }
    if (route.component === undefined) continue;
    if (!dynamic) {
      writeSSR(resolveRouteOutput(site, route.path), route.component, { path: route.path }, route.meta ?? {});
      ssrCount += 1;
      continue;
    }
    // DYNAMIC route (bundled-floor.md §Dynamic routes): export ONE skeleton page per
    // pattern — params EMPTY, so the screen renders its own loading/empty state — at a
    // deterministic path (each param segment → __param__), and DECLARE the mapping in the
    // manifest (`routes`): the worker serves /user/321 offline from the /user/:id page;
    // hydration deep-link-boots the real URL, extracts params, and the screen's logic
    // fills from cached data.
    if (route.path.includes("*")) continue;   // catch-alls have no meaningful skeleton
    const output = resolveRouteOutput(site, route.path, { parameterPlaceholder: "__param__" });
    writeSSR(output, route.component, { path: route.path }, route.meta ?? {});
    dynamicRoutePages.push({ pattern: route.path, page: output.relativePath });
    ssrCount += 1;
  }
  console.log(`• SSR export: ${ssrCount} route page(s) (${dynamicRoutePages.length} dynamic skeleton(s)) — per-route offline first paint`);
}

// ── 6. the bundled floor (bundled-floor.md, web renderer) ────────────────────────────
// Copy the service worker beside the entry, then emit the OFFLINE MANIFEST over the
// COMPLETE site tree — the SAME auto-compiled dialect the native seeds use
// ({ entry, assets:[{path, sha256}] }); the worker precaches it as one atomic,
// hash-named generation, so the demo installs its own offline floor on first visit.
// LAST on purpose: every earlier step's output must be inside the generation.
copyFileSync(join(web, "packages/dom/sw/dsx-sw.js"), join(site, "dsx-sw.js"));
mkdirSync(join(site, "despia"), { recursive: true });
writeFileSync(join(site, "despia", "local.json"),
  offlineManifestText(site, { include: (rel) => rel !== "despia/local.json", routes: dynamicRoutePages }));
console.log("• offline floor: dsx-sw.js + despia/local.json (manifest over the whole site)");

// ── the NATIVE universal-links association files (/web/04 W4) ───────────────────────
// GENERATED from the route table, never hand-kept: a route added here is a deep link on
// both natives with no second edit. Emitted only when a package DECLARES its app ids in
// its dsx.json `web.links` block — a published association that matches nothing is worse
// than none, because iOS caches it.
const linkFiles = (registry.packageWeb ?? [])
  .flatMap((pkg) => universalLinkFiles(pkg.links ?? null, registry.routes));
for (const file of linkFiles) {
  const target = join(site, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.contents);
}
console.log(linkFiles.length === 0
  ? "• universal links: none (no package declares web.links — nothing published)"
  : `• universal links: ${linkFiles.map((f) => f.path).join(" + ")} from ${(registry.routes ?? []).length} route(s)`);

console.log(`• site → ${site}`);
console.log(`  serve: node packages/compiler/bin/serve.ts (or any static server over OpenSource/Web)`);
