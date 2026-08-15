//
//  build.ts — `dsx build`.
//
//  TWO modes, and neither reimplements the compiler:
//
//   1. PROJECT (the default): the compile path of @despia/compiler + @despia/server, exactly as
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

import { buildRegistry } from "@despia/compiler";
// ONE scanner, shared with build-demo: two copies drifted the moment a package started
// generating code, and the drift refused a correct app (see specifiers.ts).
import { scanDsxSpecifiers } from "@despia/compiler/specifiers";
import { exportStatic, renderPage } from "@despia/server";

import { componentFiles, packageRoots, type ProjectConfig } from "./config.ts";

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
};

/** Compile a project into a deployable static site. */
export function buildProject(config: ProjectConfig, opts: { clean?: boolean } = {}): BuildResult {
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
    roots.map((dir) => (dir === config.root ? { dir, scheme: config.scheme } : { dir })),
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
  const queue = [...BASE_RUNTIME_PACKAGES] as string[];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (vendored.has(name)) continue;
    const dist = runtimeDistDir(`@despia/${name}`);
    if (dist === null) {
      throw new BuildError(
        `@despia/${name} is required by this build but is not installed — add it to the project's dependencies`,
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
      if (!vendored.has(pkg)) queue.push(pkg);
    }
  }

  // ── the import map, derived mechanically from what the vendored graph imports ──
  // Every bare @despia/* specifier that survives into the browser must be represented, or the
  // page is a clean-session blank screen that passes every other gate (build-demo.ts learned
  // this the hard way). Fail closed here instead.
  const bootSpecifiers = ["@despia/dom/boot"];
  const specifiers = new Set<string>([...bootSpecifiers]);
  for (const name of vendored) for (const s of scanDsxSpecifiers(join(vendorRoot, name))) specifiers.add(s);
  const imports: { [specifier: string]: string } = {};
  for (const specifier of [...specifiers].sort()) {
    const pkg = packageOf(specifier);
    const sub = specifier.substring(`@despia/${pkg}`.length);
    const target = `./vendor/${pkg}${sub.length > 0 ? sub : "/index"}.js`;
    if (!existsSync(join(config.outDir, target))) {
      throw new BuildError(`import map target missing: ${specifier} → ${target} (vendored: ${[...vendored].sort().join(", ")})`);
    }
    imports[specifier] = target;
  }
  const importMap = { imports };

  // ── package browser entries: one lazy chunk each (A3) ──
  // A package that declares `web.entry` ships real browser code, and `web.dependencies` are
  // the npm coordinates that code may import. They are BUNDLED IN rather than externalised:
  // a browser has no node_modules, so an external bare specifier would be a runtime blank
  // screen — the exact failure the import map above exists to prevent for @despia/*.
  //
  // One chunk PER PACKAGE, never a shared megabundle: exclusion is the on/off switch, so a
  // build without the package must not carry its bytes. The chunk is not loaded by the
  // bootloader; it is fetched when something asks for it, which is what makes a heavy
  // dependency (an editor, a chart engine) affordable to declare.
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
    const outfile = join(vendorRoot, "packages", `${pkg.scheme}.js`);
    bundleBrowserEntry(source, outfile, config.root);
    imports[`dsx:package/${pkg.scheme}`] = `./vendor/packages/${pkg.scheme}.js`;
  }
  const importMapJson = JSON.stringify(importMap, null, 2);

  // ── the app payload ──
  writeFileSync(join(config.outDir, "registry.json"), JSON.stringify(registry));
  writeFileSync(join(config.outDir, "main.js"), bootloader(config));

  const shell = {
    appName: config.name,
    lang: config.lang,
    importMapJson,
    mainSrc: "./main.js",
    ...(config.theme !== undefined ? { theme: config.theme } : {}),
  };
  const exported = (config.routes ?? []).length > 0 ? exportStatic(registry, config.outDir, shell) : [];
  if (!exported.includes("index.html")) {
    writeFileSync(
      join(config.outDir, "index.html"),
      renderPage(registry, config.entry, {}, { title: config.name }, shell),
    );
  }

  // ── optional static assets ──
  const publicDir = join(config.root, "public");
  if (existsSync(publicDir)) cpSync(publicDir, config.outDir, { recursive: true });

  return {
    outDir: config.outDir,
    components: Object.keys(registry.components).length,
    written: listFiles(config.outDir).map((f) => relative(config.outDir, f).split("\\").join("/")).sort(),
    importMap,
  };
}

/** The generated bootloader. A bootloader owns ZERO behavior (constitution, Article 5):
 *  it mounts the kernel with the compiled registry and hands off. */
export function bootloader(config: ProjectConfig): string {
  return `// Generated by @despia/cli — a bootloader owns zero behavior (constitution: hosts are bootloaders).
import { bootDsx } from "@despia/dom/boot";

// Anchored to THIS script, not the document: an exported nested route page loads the same
// bootloader, and a document-relative "./registry.json" would resolve into its subdirectory.
const registry = await (await fetch(new URL("./registry.json", import.meta.url))).json();

bootDsx({
  registry,
  host: document.getElementById("app"),
  entry: ${JSON.stringify(config.entry)},
  base: new URL("./", import.meta.url).pathname,
  app: ${JSON.stringify(config.app)},
});
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
      // @despia/* stay external: the import map already points them at the vendored copies,
      // so bundling them here would ship a second kernel inside every package chunk.
      external: ["@despia/*"],
      outfile,
      absWorkingDir: projectRoot,
      logLevel: "silent",
    });
  } catch (e) {
    const detail = String((e as Error).message ?? e).trim();
    throw new BuildError(`bundling ${relative(projectRoot, entry)} failed:\n${detail}`);
  }
}

/** `@despia/dom/boot` → "dom" */
function packageOf(specifier: string): string {
  const rest = specifier.substring("@despia/".length);
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

/** `dsx build --demo`: run the repository's own demo builder, unchanged. */
export function buildDemo(from: string, log: (line: string) => void = console.log): void {
  const repo = findRepoRoot(from);
  if (repo === null) {
    throw new BuildError("--demo builds the repository demo, but no despia-framework checkout was found above " + from);
  }
  const web = join(repo, "OpenSource/Web");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(join(web, "dist"))) {
    log("[dsx build] workspace dist/ is missing — running `npm run build` first");
    execFileSync(npm, ["run", "build"], { cwd: web, stdio: "inherit" });
  }
  log("[dsx build] delegating to packages/compiler/bin/build-demo.ts");
  execFileSync(process.execPath, [join(web, "packages/compiler/bin/build-demo.ts")], { cwd: web, stdio: "inherit" });
}
