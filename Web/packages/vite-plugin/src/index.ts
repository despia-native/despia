//
//  @despia-native/vite-plugin v0.1 — compile `.dsx` on import, plus a virtual registry module.
//
//  Vite is a PEER dependency and is never imported here: the plugin is a plain object with
//  the hook shape Vite calls, so it type-checks and unit-tests without Vite installed
//  (bundle discipline — this package adds zero runtime dependencies beyond @despia-native/compiler).
//
//  v0.1 SCOPE, stated plainly (the README repeats it):
//    • `import App from "./Components/App.dsx"` → the compiled component IR, with the
//      component's own static CSS injected once under the DSX cascade layers.
//    • `import registry from "virtual:dsx-registry"` → the same registry `dsx build`
//      compiles, so a Vite app can boot with @despia-native/dom.
//    • HMR is a FULL PAGE RELOAD on any `.dsx` change. There is no component-level hot
//      swap and no state preservation in v0.1.
//

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  buildRegistry, compileComponent, CssCollector, extractComponentCss, LAYER_STATEMENT,
  readPackageWeb, universalLinkFiles,
  type ComponentIR, type DsxJsonWeb, type LinkFile, type PackageWeb, type Registry,
} from "@despia-native/compiler";

/** The virtual module id an app imports to get the compiled registry. */
export const REGISTRY_ID = "virtual:dsx-registry";
const RESOLVED_REGISTRY_ID = `\0${REGISTRY_ID}`;
/** The merged unified route table (application table + package contributions). */
export const ROUTES_ID = "virtual:dsx-routes";
const RESOLVED_ROUTES_ID = `\0${ROUTES_ID}`;
const VIRTUAL_IDS: Readonly<Record<string, string>> = {
  [REGISTRY_ID]: RESOLVED_REGISTRY_ID,
  [ROUTES_ID]: RESOLVED_ROUTES_ID,
};

export type DsxPluginOptions = {
  /** package roots folded into `virtual:dsx-registry` (each: dsx.json + Components/).
   *  Default: the Vite root itself. */
  packages?: string[];
  /** fallback scheme when a `.dsx` file has no dsx.json above it */
  scheme?: string;
  /** false suppresses the per-component `<style>` injection (you own the cascade) */
  injectCss?: boolean;
  /** the APPLICATION route table (`Config/routes.json`, relative to the Vite root).
   *  Its routes are authoritative; package `web.routes` merge underneath them.
   *  Default: `Config/routes.json` when it exists. */
  routes?: string;
};

/** The subset of Vite's plugin contract this plugin implements. Structural on purpose —
 *  a real `vite.Plugin` is assignable to it, and no vite import is needed to build one. */
export type DsxPlugin = {
  name: string;
  enforce: "pre";
  configResolved: (config: { root?: string }) => void;
  resolveId: (id: string) => string | null;
  load: (id: string) => string | null;
  transform: (code: string, id: string) => { code: string; map: null } | null;
  handleHotUpdate: (ctx: HotContext) => unknown[] | undefined;
};

export type HotContext = {
  file: string;
  server?: {
    ws?: { send: (payload: { type: string; path?: string }) => void };
    moduleGraph?: {
      getModuleById?: (id: string) => unknown;
      invalidateModule?: (mod: unknown) => void;
    };
  };
  modules?: unknown[];
};

export function isDsxFile(id: string): boolean {
  return id.split("?")[0]!.endsWith(".dsx");
}

/** Nearest dsx.json `scheme` above `dir`, or null. */
export function schemeFor(dir: string): string | null {
  let cursor = resolve(dir);
  for (;;) {
    const manifest = join(cursor, "dsx.json");
    if (existsSync(manifest)) {
      try {
        const scheme = (JSON.parse(readFileSync(manifest, "utf8")) as { scheme?: string }).scheme;
        if (typeof scheme === "string" && scheme.length > 0) return scheme;
      } catch { /* a broken manifest is the compiler's finding */ }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Read one package root's dsx.json `web` block (W3/W4/M-10). A package that declares no
 *  `web` block contributes nothing — file presence stays the gate, exactly as on native. */
export function readPackageWebBlock(dir: string): { scheme: string; web?: DsxJsonWeb } | null {
  const manifest = join(dir, "dsx.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as
      { scheme?: string; name?: string; web?: DsxJsonWeb };
    const scheme = parsed.scheme ?? (parsed.name ?? basename(dir)).toLowerCase();
    return parsed.web === undefined ? { scheme } : { scheme, web: parsed.web };
  } catch {
    return null; // a broken manifest is the compiler's finding, reported there
  }
}

/** Every package `web` block behind a set of roots, plus the stylesheet CONTENTS those
 *  blocks contribute and the association files their `links` declarations generate.
 *  Pure over the filesystem so a bundler and `dsx build` produce identical output. */
export function collectPackageWeb(roots: readonly string[], routes: Registry["routes"]): {
  packages: PackageWeb[];
  styles: string[];
  links: LinkFile[];
} {
  const packages: PackageWeb[] = [];
  const styles: string[] = [];
  for (const dir of roots) {
    const manifest = readPackageWebBlock(dir);
    if (manifest === null) continue;
    const { web } = readPackageWeb(manifest.scheme, manifest.web);
    packages.push(web);
    for (const relative of web.styles) {
      const file = join(dir, relative);
      if (existsSync(file)) styles.push(readFileSync(file, "utf8"));
      else console.warn(`[dsx vite] ${manifest.scheme}: web.styles names a missing file (${relative})`);
    }
  }
  const links = packages.flatMap((pkg) => universalLinkFiles(pkg.links ?? null, routes));
  return { packages, styles, links };
}

/** The ES module emitted for one `.dsx` import. Pure over its inputs so the exact bytes
 *  a bundler receives are asserted in the tests. */
export function emitModule(ir: ComponentIR, css: string, injectCss: boolean): string {
  const qualified = `${ir.scheme}.${ir.name}`;
  const lines = [
    `// generated by @despia-native/vite-plugin from ${qualified}`,
    `export const name = ${JSON.stringify(ir.name)};`,
    `export const scheme = ${JSON.stringify(ir.scheme)};`,
    `export const qualified = ${JSON.stringify(qualified)};`,
    `export const css = ${JSON.stringify(css)};`,
    `const ir = ${JSON.stringify(ir)};`,
    `export default ir;`,
  ];
  if (injectCss) {
    lines.push(
      `if (typeof document !== "undefined") {`,
      `  const put = (id, text) => {`,
      `    if (text.length === 0) return;`,
      `    let el = document.getElementById(id);`,
      `    if (el === null) { el = document.createElement("style"); el.id = id; document.head.appendChild(el); }`,
      `    el.textContent = text;`,
      `  };`,
      `  put("dsx-layers", ${JSON.stringify(LAYER_STATEMENT)});`,
      `  put(${JSON.stringify(`dsx-css:${qualified}`)}, css);`,
      `}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Compile one `.dsx` source into its emitted module, using a SHARED collector so class
 *  handles (`c0`, `a1`, …) stay unique across every file in the build — a per-file
 *  collector would hand two different declarations the same handle. */
export function compileDsx(
  id: string, source: string, collector: CssCollector,
  opts: { scheme?: string; injectCss?: boolean } = {},
): { code: string; ir: ComponentIR; css: string } {
  const file = id.split("?")[0]!;
  const name = basename(file, ".dsx");
  const scheme = schemeFor(dirname(file)) ?? opts.scheme ?? "app";
  const ir = compileComponent(name, scheme, source);
  extractComponentCss(ir, collector);
  const handles = new Set<string>();
  const visit = (node: ComponentIR["root"]): void => {
    for (const handle of (node.attrs["__css"] ?? "").split(/\s+/)) if (handle.length > 0) handles.add(handle);
    node.children.forEach(visit);
  };
  visit(ir.root);
  const css = collector.emit(handles);
  return { code: emitModule(ir, css, opts.injectCss !== false), ir, css };
}

/** Compile the registry a Vite app boots with: every package root, the application route
 *  table if one exists, each package's `web` block folded in (routes merged + collision
 *  linted by buildRegistry, styles appended to the compiled sheet). */
export function compileRegistry(root: string, options: DsxPluginOptions): Registry {
  const roots = (options.packages ?? [root]).map((dir) => resolve(root, dir));
  const routesFile = resolve(root, options.routes ?? "Config/routes.json");
  let appRoutes: Registry["routes"];
  let notFound: string | undefined;
  if (existsSync(routesFile)) {
    try {
      const doc = JSON.parse(readFileSync(routesFile, "utf8")) as
        { routes?: Registry["routes"]; notFound?: string };
      appRoutes = doc.routes;
      notFound = doc.notFound;
    } catch (e) {
      console.warn(`[dsx vite] unreadable route table ${routesFile}: ${String(e)}`);
    }
  }
  const { styles } = collectPackageWeb(roots, appRoutes);
  return buildRegistry(
    roots.map((dir) => ({ dir })),
    styles,
    {
      ...(appRoutes !== undefined ? { routes: appRoutes } : {}),
      ...(notFound !== undefined ? { notFound } : {}),
    },
  );
}

/** The plugin. `dsx()` in a vite.config — see README.md for the two import shapes. */
export function dsx(options: DsxPluginOptions = {}): DsxPlugin {
  const collector = new CssCollector();
  let root = process.cwd();

  return {
    name: "dsx",
    // `pre` so the .dsx module exists before any other plugin's transform sees the id.
    enforce: "pre",

    configResolved(config) {
      if (typeof config.root === "string" && config.root.length > 0) root = config.root;
    },

    resolveId(id) {
      return VIRTUAL_IDS[id] ?? null;
    },

    load(id) {
      if (id !== RESOLVED_REGISTRY_ID && id !== RESOLVED_ROUTES_ID) return null;
      const registry = compileRegistry(root, options);
      if (id === RESOLVED_ROUTES_ID) {
        return `export const routes = ${JSON.stringify(registry.routes ?? [])};\n`
          + `export const notFound = ${JSON.stringify(registry.notFound ?? null)};\n`
          + `export default routes;\n`;
      }
      return `export default ${JSON.stringify(registry)};\n`;
    },

    transform(code, id) {
      if (!isDsxFile(id)) return null;
      const compiled = compileDsx(id, code, collector, {
        ...(options.scheme !== undefined ? { scheme: options.scheme } : {}),
        ...(options.injectCss !== undefined ? { injectCss: options.injectCss } : {}),
      });
      return { code: compiled.code, map: null };
    },

    /** v0.1: any `.dsx` edit is a FULL PAGE RELOAD. The registry virtual module is
     *  invalidated first so the reloaded page compiles the new source. */
    handleHotUpdate(ctx) {
      if (!isDsxFile(ctx.file)) return undefined;
      const graph = ctx.server?.moduleGraph;
      const registryModule = graph?.getModuleById?.(RESOLVED_REGISTRY_ID);
      if (registryModule !== undefined && registryModule !== null) graph?.invalidateModule?.(registryModule);
      ctx.server?.ws?.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}

export default dsx;
