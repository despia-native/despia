//
//  build.ts — `despia build`.
//
//  TWO modes, and neither reimplements the compiler:
//
//   1. PROJECT (the default): the compile path of @despia-native/compiler + @despia-native/server, exactly as
//      packages/compiler/bin/build-demo.ts drives it — buildRegistry over the package roots,
//      renderPage/exportStatic for the documents, an import map over the vendored runtime
//      ESM, and a bootloader that owns zero behavior (constitution: hosts are bootloaders).
//   2. REPO DEMO (`--demo`): spawns packages/compiler/bin/build-demo.ts itself. That file is
//      a top-level script bound to this repository's layout, so a child process is the only
//      correct way to invoke it — the CLI adds the workspace-build precondition and nothing
//      else.
//

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "@despia-native/compiler";
// ONE scanner, shared with build-demo: two copies drifted the moment a package started
// generating code, and the drift refused a correct app (see specifiers.ts).
import { scanDsxSpecifiers } from "@despia-native/compiler/specifiers";
import {
  exportStatic, offlineManifestText, rebaseShellForDepth, renderPage, resolveRouteOutput,
} from "@despia-native/server";

import { componentFiles, packageRoots, type ProjectConfig } from "./config.ts";
import { emitServerArtifacts, type ServerEmitResult } from "./server-document.ts";
import { collectAppAutomations } from "./studio-apps/automations.ts";
import { emitDeployArtifacts } from "./deploy.ts";

export { scanDsxSpecifiers };

export class BuildError extends Error {}

/** The runtime packages a browser build always needs; more are vendored transitively. */
const BASE_RUNTIME_PACKAGES = ["kernel", "compiler", "dom"] as const;

export type BuildResult = {
  outDir: string;
  /** component count in the compiled registry */
  components: number;
  /** files written under outDir, project-relative, sorted */
  written: string[];
  /** the emitted import map (also inlined into every document) */
  importMap: { imports: { [specifier: string]: string } };
  /** the `<server>` compile step's output — null when the project has no server/ documents */
  server: ServerEmitResult | null;
  /** the deploy emitter's output under `deploy/`, project-relative — empty without a backend */
  deploy: string[];
};

/** Compile a project into a deployable static site. */
export function buildProject(config: ProjectConfig, opts: { clean?: boolean } = {}): BuildResult {
  // ── the `<server>` documents (backend-authoring.md) — compiled FIRST, so a bad backend
  //    document aborts before a single site byte is written. Granted app automations
  //    (studio-apps.md §7.2) fold into the same artifact; each refusal is named, never
  //    silently dropped, and never fatal to the build. ──
  const appFold = collectAppAutomations(config.root);
  for (const refusal of appFold.refusals) {
    console.warn(`[despia build] automation held — ${refusal.app}#${refusal.contribution}: ${refusal.reason}`);
  }
  const server = emitServerArtifacts(
    config.root,
    appFold.automations.length > 0 ? { apps: { docs: appFold.docs, automations: appFold.automations } } : {},
  );

  const roots = packageRoots(config);
  for (const root of roots) {
    if (!existsSync(root)) throw new BuildError(`package root does not exist: ${root}`);
  }
  const sources = roots.flatMap((root) => componentFiles(root));
  if (sources.length === 0) {
    throw new BuildError(
      `no components found — a DSX package keeps its .dsx files in Components/ (looked in ${roots.map((r) => join(r, "Components")).join(", ")})`,
    );
  }

  const registry = buildRegistry(
    roots.map((dir) => (dir === config.root ? { dir, scheme: config.scheme, app: true } : { dir })),
    [],
    {
      ...(config.routes !== undefined ? { routes: config.routes } : {}),
      ...(config.notFound !== undefined ? { notFound: config.notFound } : {}),
      ...(config.router !== undefined ? { router: config.router } : {}),
    },
  );
  if (registry.components[config.entry] === undefined) {
    throw new BuildError(
      `entry component "${config.entry}" is not in the registry — compiled: ${Object.keys(registry.components).sort().join(", ")}`,
    );
  }

  if (opts.clean !== false) rmSync(config.outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  mkdirSync(config.outDir, { recursive: true });

  // ── the runtime ESM, vendored next to the app (no CDN, no bare-specifier gamble) ──
  const vendorRoot = join(config.outDir, "vendor");
  const vendored = new Set<string>();
  const vendorQueue = [...BASE_RUNTIME_PACKAGES] as string[];
  const vendorPackage = (name: string): void => {
    if (vendored.has(name)) return;
    const dist = runtimeDistDir(`@despia-native/${name}`);
    if (dist === null) {
      throw new BuildError(
        `@despia-native/${name} is required by this build but is not installed — add it to the project's dependencies`,
      );
    }
    cpSync(dist, join(vendorRoot, name), {
      recursive: true,
      // declarations and source maps are build-time artefacts; a browser never reads them,
      // and the maps would point at .ts sources this output deliberately does not ship.
      filter: (source) => statSync(source).isDirectory() || source.endsWith(".js"),
    });
    vendored.add(name);
    for (const specifier of scanDsxSpecifiers(join(vendorRoot, name))) {
      const pkg = packageOf(specifier);
      if (!vendored.has(pkg)) vendorQueue.push(pkg);
    }
  };
  while (vendorQueue.length > 0) vendorPackage(vendorQueue.shift()!);

  // ── package browser entries: one lazy chunk each (A3) ──
  // A package that declares `web.entry` ships real browser code, and `web.dependencies` are
  // the npm coordinates that code may import. They are BUNDLED IN rather than externalised:
  // a browser has no node_modules, so an external bare specifier would be a runtime blank
  // screen — the exact failure the import map below exists to prevent for @despia-native/*.
  //
  // One chunk PER PACKAGE, never a shared megabundle: exclusion is the on/off switch, so a
  // build without the package must not carry its bytes. The chunk is not loaded by the
  // bootloader; it is fetched when something asks for it, which is what makes a heavy
  // dependency (an editor, a chart engine) affordable to declare. The ONE exception is a
  // declared `web.boot` module (studio-apps.md §8): a bus module — a facet-component host,
  // a scheme provider — must exist before the first tag resolves, so its chunk is imported
  // and registered by the bootloader. Opt-in, so the lazy default and its reason both stand.
  const bootModules: string[] = [];
  const chunksDir = join(vendorRoot, "packages");
  for (const pkg of registry.packageWeb ?? []) {
    if (pkg.entry === undefined) continue;
    const source = join(pkg.dir, pkg.entry);
    if (!existsSync(source)) {
      throw new BuildError(`${pkg.scheme}: web.entry "${pkg.entry}" does not exist (looked in ${pkg.dir})`);
    }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (resolveDependency(name, config.root, pkg.dir) === null) {
        throw new BuildError(
          `${pkg.scheme}: web.dependencies declares "${name}" but it is not installed — ` +
          `add it to the project's dependencies and run npm install`,
        );
      }
    }
    const outfile = join(chunksDir, `${pkg.scheme}.js`);
    bundleBrowserEntry(source, outfile, config.root);
    if (pkg.boot === true) bootModules.push(pkg.scheme);
  }
  // a chunk's own surviving @despia-native/* externals ride the same vendoring law — without this,
  // a boot module importing the renderer is a clean-session blank screen the gates pass.
  if (existsSync(chunksDir)) {
    for (const specifier of scanDsxSpecifiers(chunksDir)) vendorQueue.push(packageOf(specifier));
    while (vendorQueue.length > 0) vendorPackage(vendorQueue.shift()!);
  }

  // ── the import map, derived mechanically from what the vendored graph imports ──
  // Every bare @despia-native/* specifier that survives into the browser must be represented, or the
  // page is a clean-session blank screen that passes every other gate (build-demo.ts learned
  // this the hard way). Fail closed here instead.
  const bootSpecifiers = ["@despia-native/dom/boot", "@despia-native/dom/offline"];
  const specifiers = new Set<string>([...bootSpecifiers]);
  for (const name of vendored) for (const s of scanDsxSpecifiers(join(vendorRoot, name))) specifiers.add(s);
  if (existsSync(chunksDir)) for (const s of scanDsxSpecifiers(chunksDir)) specifiers.add(s);
  const imports: { [specifier: string]: string } = {};
  for (const specifier of [...specifiers].sort()) {
    const pkg = packageOf(specifier);
    const sub = specifier.substring(`@despia-native/${pkg}`.length);
    const target = `./vendor/${pkg}${sub.length > 0 ? sub : "/index"}.js`;
    if (!existsSync(join(config.outDir, target))) {
      throw new BuildError(`import map target missing: ${specifier} → ${target} (vendored: ${[...vendored].sort().join(", ")})`);
    }
    imports[specifier] = target;
  }
  const importMap = { imports };
  for (const pkg of registry.packageWeb ?? []) {
    if (pkg.entry !== undefined) imports[`dsx:package/${pkg.scheme}`] = `./vendor/packages/${pkg.scheme}.js`;
  }
  const importMapJson = JSON.stringify(importMap, null, 2);

  // ── the document shell, composed once and BAKED into the registry (wave-7 F1):
  //    a server host built from registry.json alone (createSiteHandler with no options)
  //    must serve live-SSR'd dynamic routes whose documents still load the client boot.
  //    The exporter below and every handler read the same block; explicit handler
  //    options win per key (live.ts).
  const shell = {
    appName: config.name,
    lang: config.lang,
    importMapJson,
    mainSrc: "./main.js",
    manifestHref: "/manifest.webmanifest",
    ...(config.theme !== undefined ? { theme: config.theme } : {}),
  };
  registry.shell = shell;

  // ── the app payload ──
  writeFileSync(join(config.outDir, "registry.json"), JSON.stringify(registry));
  writeFileSync(join(config.outDir, "main.js"), bootloader(config, bootModules));

  // ── the PWA face: a web app manifest + an SVG identity icon, every page links it.
  //    A project icon in public/ (copied below) wins by name; this emitted one is the
  //    floor so a bare project is installable on day one.
  writeFileSync(join(config.outDir, "icon.svg"), appIconSvg(config.name));
  writeFileSync(join(config.outDir, "manifest.webmanifest"), JSON.stringify({
    name: config.name,
    short_name: config.name.length > 12 ? config.name.slice(0, 12).trimEnd() : config.name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111111",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  }, null, 2) + "\n");

  const exported = (config.routes ?? []).length > 0 ? exportStatic(registry, config.outDir, shell) : [];
  if (!exported.includes("index.html")) {
    writeFileSync(
      join(config.outDir, "index.html"),
      renderPage(registry, config.entry, {}, { title: config.name }, shell),
    );
  }

  // ── dynamic-route SKELETON pages (bundled-floor.md §Dynamic routes) ──
  // exportStatic skips param routes (they need live SSR); the FLOOR still wants one page per
  // pattern — params empty, so the screen renders its own empty/loading state — declared in
  // the offline manifest's `routes`, so the worker serves /user/321 offline from the
  // /user/:id page and hydration deep-link-boots the real URL.
  const dynamicRoutePages: { pattern: string; page: string }[] = [];
  for (const route of registry.routes ?? []) {
    const dynamic = route.path.includes(":") || route.path.includes("{");
    if (!dynamic || route.path.includes("*") || route.component === undefined) continue;
    const output = resolveRouteOutput(config.outDir, route.path, { parameterPlaceholder: "__param__" });
    mkdirSync(dirname(output.outputPath), { recursive: true });
    const depth = output.relativePath.split("/").length - 1;
    writeFileSync(
      output.outputPath,
      renderPage(registry, route.component, { path: route.path }, route.meta ?? {}, rebaseShellForDepth(shell, depth)),
    );
    dynamicRoutePages.push({ pattern: route.path, page: output.relativePath });
  }

  // ── optional static assets ──
  const publicDir = join(config.root, "public");
  if (existsSync(publicDir)) cpSync(publicDir, config.outDir, { recursive: true });

  // ── the bundled floor (bundled-floor.md, web renderer): the service worker beside the
  //    entry, then the offline manifest over the COMPLETE tree — the SAME dialect every
  //    native seed reads ({ entry, assets:[{path, sha256}] }); dsx-sw.js precaches it as one
  //    atomic, hash-named generation, so every built app installs its floor on first visit.
  //    LAST on purpose: every earlier step's output must be inside the generation. ──
  cpSync(serviceWorkerSource(), join(config.outDir, "dsx-sw.js"));
  mkdirSync(join(config.outDir, "despia"), { recursive: true });
  writeFileSync(
    join(config.outDir, "despia", "local.json"),
    offlineManifestText(config.outDir, { include: (rel) => rel !== "despia/local.json", routes: dynamicRoutePages }),
  );

  //  ── the deploy artifacts (plan E1) — LAST, because the site half binds the build output
  //     and the worker imports the registry this build just wrote. A backend with no supported
  //     way to run it is the defect this step closes. ──
  const deploy = emitDeployArtifacts(config, server);

  return {
    outDir: config.outDir,
    components: Object.keys(registry.components).length,
    written: listFiles(config.outDir).map((f) => relative(config.outDir, f).split("\\").join("/")).sort(),
    importMap,
    server,
    deploy,
  };
}

/** The web renderer's service worker, shipped as a static file by @despia-native/dom (sw/dsx-sw.js). */
function serviceWorkerSource(): string {
  try {
    return fileURLToPath(import.meta.resolve("@despia-native/dom/sw/dsx-sw.js"));
  } catch {
    throw new BuildError(
      "@despia-native/dom does not ship sw/dsx-sw.js — the offline floor needs the worker; update @despia-native/dom",
    );
  }
}

/** The generated bootloader. A bootloader owns ZERO behavior (constitution, Article 5):
 *  it mounts the kernel with the compiled registry and hands off. A package that declared
 *  `web.boot` gets its chunk imported and its default-export WebModule registered here —
 *  one translation line per declaration, the AppDelegate rule applied to the web. */
export function bootloader(config: ProjectConfig, bootModules: readonly string[] = []): string {
  const bootImports = bootModules
    .map((scheme, i) => `import bootModule${i} from ${JSON.stringify(`dsx:package/${scheme}`)};`)
    .join("\n");
  const modulesLine = bootModules.length > 0
    ? `\n  modules: [${bootModules.map((_, i) => `bootModule${i}`).join(", ")}],`
    : "";
  return `// Generated by @despia-native/cli — a bootloader owns zero behavior (constitution: hosts are bootloaders).
import { bootDsx } from "@despia-native/dom/boot";
import { registerOfflineFloor } from "@despia-native/dom/offline";
${bootImports.length > 0 ? `${bootImports}\n` : ""}
// Anchored to THIS script, not the document: an exported nested route page loads the same
// bootloader, and a document-relative "./registry.json" would resolve into its subdirectory.
const registry = await (await fetch(new URL("./registry.json", import.meta.url))).json();

bootDsx({
  registry,
  host: document.getElementById("app"),
  entry: ${JSON.stringify(config.entry)},
  base: new URL("./", import.meta.url).pathname,${modulesLine}
  app: ${JSON.stringify(config.app)},
  consts: ${JSON.stringify(config.consts)},
});

// The BUNDLED FLOOR (bundled-floor.md, web renderer): register the service worker — install
// once online, every later launch renders offline; publishes dsx.source.* into the store the
// markup alias already reads. Fail-open: no SW support / insecure context = a no-op. swUrl is
// anchored to THIS script (the site root), never the document — a deep-link first visit on an
// exported nested page would otherwise resolve it into the subdirectory and 404 the floor away.
void registerOfflineFloor({ swUrl: new URL("./dsx-sw.js", import.meta.url).href });
`;
}

/** Is a declared npm coordinate actually installed? Resolved from the PROJECT first (the
 *  node_modules an author controls), then from the package's own directory, so a monorepo
 *  package with its own install still resolves. Returns the resolved path or null. */
function resolveDependency(name: string, projectRoot: string, packageDir: string): string | null {
  for (const from of [projectRoot, packageDir]) {
    const req = createRequire(join(from, "noop.js"));
    try {
      return req.resolve(`${name}/package.json`);
    } catch {
      // `exports` can hide package.json; fall back to resolving the module itself.
      try {
        return req.resolve(name);
      } catch { /* try the next root */ }
    }
  }
  return null;
}

/** Bundle one package's browser entry into a self-contained ESM chunk.
 *
 *  esbuild's SYNC api, resolved through createRequire: `buildProject` is synchronous by
 *  contract (every caller, including the dev server's rebuild, depends on that), and
 *  esbuild's own bin is a native binary rather than a JS entry — running it through
 *  process.execPath fails with a syntax error, which is how this was found. */
function bundleBrowserEntry(entry: string, outfile: string, projectRoot: string): void {
  mkdirSync(dirname(outfile), { recursive: true });
  let esbuild: { buildSync: (options: Record<string, unknown>) => unknown };
  try {
    esbuild = createRequire(import.meta.url)("esbuild") as typeof esbuild;
  } catch {
    throw new BuildError("esbuild is required to bundle a package's web.entry but is not installed");
  }
  try {
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      // @despia-native/* stay external: the import map already points them at the vendored copies,
      // so bundling them here would ship a second kernel inside every package chunk.
      external: ["@despia-native/*"],
      outfile,
      absWorkingDir: projectRoot,
      logLevel: "silent",
    });
  } catch (e) {
    const detail = String((e as Error).message ?? e).trim();
    throw new BuildError(`bundling ${relative(projectRoot, entry)} failed:\n${detail}`);
  }
}

/** `@despia-native/dom/boot` → "dom" */
function packageOf(specifier: string): string {
  const rest = specifier.substring("@despia-native/".length);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.substring(0, slash);
}

/** Resolve an installed runtime package's dist directory, or null when absent. */
export function runtimeDistDir(specifier: string): string | null {
  try {
    return dirname(fileURLToPath(import.meta.resolve(specifier)));
  } catch {
    return null;
  }
}

/** The identity-icon floor: the app's initial on a neutral rounded square. SVG is a real
 *  manifest icon format (`sizes: "any"`), so installability needs no raster pipeline. */
function appIconSvg(name: string): string {
  const initial = (name.trim()[0] ?? "A").toUpperCase().replace(/[<>&"']/g, "A");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#111111"/>
<text x="256" y="256" dy="0.36em" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="280" font-weight="700" fill="#ffffff">${initial}</text>
</svg>
`;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── repo demo mode ─────────────────────────────────────────────────────────────────────

/** Walk up for the despia-framework checkout (OpenSource/Conformance is its fingerprint). */
export function findRepoRoot(from: string): string | null {
  let cursor = resolve(from);
  for (;;) {
    if (existsSync(join(cursor, "OpenSource/Conformance"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** `despia build --demo`: run the repository's own demo builder, unchanged. */
export function buildDemo(from: string, log: (line: string) => void = console.log): void {
  const repo = findRepoRoot(from);
  if (repo === null) {
    throw new BuildError("--demo builds the repository demo, but no despia-framework checkout was found above " + from);
  }
  const web = join(repo, "OpenSource/Web");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(join(web, "dist"))) {
    log("[despia build] workspace dist/ is missing — running `npm run build` first");
    execFileSync(npm, ["run", "build"], { cwd: web, stdio: "inherit" });
  }
  log("[despia build] delegating to packages/compiler/bin/build-demo.ts");
  execFileSync(process.execPath, [join(web, "packages/compiler/bin/build-demo.ts")], { cwd: web, stdio: "inherit" });
}
