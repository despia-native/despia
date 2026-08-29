//
//  registry.ts - module scan → the compiled component registry (build time, node-only).
//  The web twin of prepare_config.rb's component registry: every module's
//  Components/**/*.dsx compiles to IR; sidecar .css sheets are owner-scoped; component
//  resolution is package-local → scheme-qualified → global pool (the kernel rule).
//

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

import { compileComponent, type ComponentIR } from "./component.ts";
import { CssCollector, extractComponentCss, scopeSheet, LAYER_STATEMENT } from "./css.ts";
import type { Registry } from "./resolve.ts";
import { resolveWebManifests, type DsxJsonWeb } from "./web-manifest.ts";

export type { Registry } from "./resolve.ts";

export type ModuleInput = {
  /** module folder (contains dsx.json + Components/) */
  dir: string;
  /** overrides dsx.json scheme (Foundation has none — pool-only modules) */
  scheme?: string;
  /** the APPLICATION root (master plan P15): a `theme.css` beside this module's dsx.json
   *  is the PROJECT TOKEN TIER — auto-folded into `@layer dsx-theme` AFTER every
   *  package-declared sheet, so the app's design tokens win over a package's within the
   *  theme layer while component sheets (`dsx-sheets`) still win over both. Zero config:
   *  the file existing IS the declaration (the same file-presence law as everywhere). */
  app?: boolean;
};

type RegistryCssMetadata = {
  extraCss: string[];
  /** the already-wrapped `@layer dsx-theme` block from every package's `web.styles` */
  theme: string;
  sidecars: Map<string, string>;
  handles: Map<string, Set<string>>;
  collector: CssCollector;
};

// Build-only metadata deliberately lives outside the serializable Registry shape.
// Full applications receive registry.css unchanged; exposed components can request
// the CSS belonging to their closed dependency slice without shipping every demo or
// package sidecar into a third-party custom-element bundle.
const REGISTRY_CSS_METADATA = new WeakMap<Registry, RegistryCssMetadata>();

function cssHandles(ir: ComponentIR): Set<string> {
  const handles = new Set<string>();
  const visit = (node: ComponentIR["root"]): void => {
    for (const handle of (node.attrs["__css"] ?? "").split(/\s+/)) {
      if (handle.length > 0) handles.add(handle);
    }
    node.children.forEach(visit);
  };
  visit(ir.root);
  return handles;
}

/** Return the author CSS needed by exactly these components. Registries not made by
 * buildRegistry (for example hand-authored test fixtures) retain the safe legacy
 * fallback of their existing css string. */
export function cssForComponentSlice(registry: Registry, qualified: Iterable<string>): string {
  const metadata = REGISTRY_CSS_METADATA.get(registry);
  if (metadata === undefined) return registry.css;

  const selectedSidecars: string[] = [];
  const selectedHandles = new Set<string>();
  for (const name of qualified) {
    const sidecar = metadata.sidecars.get(name);
    if (sidecar !== undefined) selectedSidecars.push(sidecar);
    for (const handle of metadata.handles.get(name) ?? []) selectedHandles.add(handle);
  }
  // The app theme rides into every slice: a sidecar that reads `var(--brand-accent)` with
  // no definition resolves to nothing and the property goes unset, so dropping the tokens
  // would not save an embed bytes — it would break its colors.
  return [
    LAYER_STATEMENT,
    ...metadata.extraCss,
    metadata.theme,
    selectedSidecars.length > 0 ? `@layer dsx-sheets {\n${selectedSidecars.join("\n\n")}\n}` : "",
    metadata.collector.emit(selectedHandles),
  ].filter((part) => part.length > 0).join("\n\n");
}

/** Component files follow the same portable identifier law as the native
 * generators: a capitalized ASCII identifier with no whitespace or punctuation.
 * Besides keeping qualified tags interoperable, this prevents Finder/conflict
 * copies such as `Paywall 2.dsx` from silently entering a release registry. */
export function isValidComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(name);
}

function walkDsxFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  // sorted: readdir order is filesystem-dependent, and the CssCollector hands out class
  // labels in visit order — an unsorted walk makes the emitted classes (and thus the HTML)
  // non-reproducible across machines. Deterministic build output is the contract.
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkDsxFiles(full));
    else if (entry.endsWith(".dsx")) out.push(full);
  }
  return out;
}

export function buildRegistry(
  modules: ModuleInput[],
  extraCss: string[] = [],
  opts: {
    routes?: Registry["routes"];
    notFound?: string;
    router?: Registry["router"];
    /** The compile target every component folds for. Default `web`; the shot renderer passes
     *  `ios`/`android` so a depiction of the native build keeps that build's `:ios` branches
     *  (platform/10-screenshot-execution.md W3). */
    target?: string;
  } = {},
): Registry {
  const components: { [qualified: string]: ComponentIR } = {};
  const globalPool: { [name: string]: string } = {};
  const schemes: string[] = [];
  const collector = new CssCollector();
  const sheets: string[] = [];
  const sidecars = new Map<string, string>();
  const handles = new Map<string, Set<string>>();
  // Each package's dsx.json `web` block (W3/W4). Collected during the same walk that
  // already parses every manifest, so package route contributions cost no extra IO.
  const manifests: Array<{ scheme: string; web: DsxJsonWeb; dir: string }> = [];

  for (const mod of modules) {
    const manifestPath = join(mod.dir, "dsx.json");
    let scheme = mod.scheme ?? "";
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as
          { scheme?: string; name?: string; web?: DsxJsonWeb };
        if (scheme.length === 0) scheme = manifest.scheme ?? (manifest.name ?? basename(mod.dir)).toLowerCase();
        if (manifest.web !== undefined) manifests.push({ scheme, web: manifest.web, dir: mod.dir });
      } catch (e) {
        console.warn(`[dsx registry] bad dsx.json in ${mod.dir}: ${String(e)}`);
      }
    }
    if (scheme.length === 0) scheme = basename(mod.dir).toLowerCase();
    schemes.push(scheme);

    for (const file of walkDsxFiles(join(mod.dir, "Components"))) {
      const name = basename(file, ".dsx");
      if (!isValidComponentName(name)) {
        console.warn(`[dsx registry] ${file}: component file must be a Capitalized identifier; skipped`);
        continue;
      }
      const source = readFileSync(file, "utf-8");
      let ir: ComponentIR;
      try {
        ir = compileComponent(name, scheme, source, { target: opts.target });
      } catch (e) {
        console.warn(`[dsx registry] ${file}: ${String(e)} — component skipped (renders blank, the runtime contract)`);
        continue;
      }
      extractComponentCss(ir, collector);
      const qualified = `${scheme}.${name}`;
      if (components[qualified] !== undefined) {
        console.warn(`[dsx registry] duplicate component ${qualified} (${file}) overwrites an earlier file of the same basename — rename one`);
      }
      components[qualified] = ir;
      handles.set(qualified, cssHandles(ir));
      if (globalPool[name] === undefined) globalPool[name] = qualified;
      // sidecar sheet: Foo.css next to Foo.dsx, owner-scoped
      const sidecar = file.replace(/\.dsx$/, ".css");
      if (existsSync(sidecar)) {
        const scoped = scopeSheet(readFileSync(sidecar, "utf-8"), name);
        sheets.push(scoped);
        sidecars.set(qualified, scoped);
      }
    }
  }

  // PACKAGE-CONTRIBUTED ROUTES (W4): the application table stays authoritative; a
  // package↔package collision throws, because a build whose URLs depend on directory
  // order is worse than a build that refuses. Warnings are printed, never swallowed.
  const web = resolveWebManifests(opts.routes, manifests);
  for (const warning of web.warnings) console.warn(warning);

  // PACKAGE-DECLARED STYLESHEETS (`web.styles`), folded HERE rather than in one bundler,
  // so `dsx build`, the Vite plugin and the repo demo all get the same sheet from the same
  // code. They land in `dsx-theme` — the layer between the kernel's element defaults and
  // component sheets — which is exactly an application's design layer: it may restate what
  // an unstyled element looks like, and a component's own sheet still wins over it.
  //
  // A declared sheet that does not exist THROWS, unlike a component that fails to compile
  // (which renders blank and is therefore visible). A stylesheet that silently vanishes has
  // no failure surface at all: the app boots, every gate passes, and it just looks wrong.
  const packageStyles: string[] = [];
  for (const [index, { dir, scheme }] of manifests.entries()) {
    for (const relative of web.packages[index]?.styles ?? []) {
      const sheetPath = join(dir, relative);
      if (!existsSync(sheetPath)) {
        throw new Error(
          `[dsx registry] ${scheme}: web.styles declares ${JSON.stringify(relative)} but ${sheetPath} does not exist`,
        );
      }
      packageStyles.push(readFileSync(sheetPath, "utf-8").trim());
    }
  }

  // THE PROJECT TOKEN TIER (master plan P15, dsx-css §4.2): the app root's `theme.css`,
  // discovered by file presence, folded LAST inside dsx-theme so the application's tokens
  // out-cascade package sheets at equal specificity. The Studio's theme sheet writes this
  // file; the dev watcher already reacts to .css, so an edit rides the P2 hot-swap lane.
  for (const mod of modules) {
    if (mod.app !== true) continue;
    const themePath = join(mod.dir, "theme.css");
    if (existsSync(themePath)) packageStyles.push(readFileSync(themePath, "utf-8").trim());
  }

  // THE STRINGS BUILD TIER (master plan P12, localization.md): the app root's
  // `Strings.<tag>.json` files - flat { "Save": "Sichern" } maps, the tag a lowercase
  // BCP-47 - ride the registry so the client boot can hand DSXStrings a synchronous
  // loader. File presence IS the declaration, an invalid file is skipped (fail-open,
  // Article 7), and the Studio's strings table writes these same files.
  let strings: { [tag: string]: { [key: string]: string } } | undefined;
  for (const mod of modules) {
    if (mod.app !== true) continue;
    for (const entry of readdirSync(mod.dir)) {
      const match = /^Strings\.([a-z][a-z0-9-]*)\.json$/.exec(entry);
      if (match === null) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(mod.dir, entry), "utf-8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const table: { [key: string]: string } = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") table[k] = v;
        if (Object.keys(table).length > 0) (strings ??= {})[match[1]!] = table;
      } catch { /* an unparsable table is no table - the app renders its source language */ }
    }
  }

  const theme = packageStyles.length > 0 ? `@layer dsx-theme {\n${packageStyles.join("\n\n")}\n}` : "";

  const css = [
    LAYER_STATEMENT,
    ...extraCss,
    theme,
    sheets.length > 0 ? `@layer dsx-sheets {\n${sheets.join("\n\n")}\n}` : "",
    collector.emit(),
  ].filter((s) => s.length > 0).join("\n\n");

  const registry: Registry = { components, globalPool, css, schemes, ...(strings !== undefined ? { strings } : {}) };
  REGISTRY_CSS_METADATA.set(registry, {
    extraCss: [...extraCss],
    theme,
    sidecars,
    handles,
    collector,
  });
  registry.packageWeb = manifests.map(({ scheme, dir }, index) => ({
    ...web.packages[index]!, scheme, dir,
  }));
  if (opts.routes !== undefined || web.routes.length > 0) {
    registry.routes = web.routes;
    // Compilation remains fail-open for an unrouted optional component, but a route is
    // a public promise. Never emit a table whose destination was skipped after a parse
    // failure: every renderer would otherwise navigate successfully into a blank page.
    const missing = web.routes.filter((route) =>
      route.component !== undefined && components[route.component] === undefined,
    );
    if (missing.length > 0) {
      const detail = missing.map((route) => `${JSON.stringify(route.path)} → ${JSON.stringify(route.component)}`).join(", ");
      throw new Error(`[dsx registry] routed component did not compile: ${detail}`);
    }
  }
  if (opts.notFound !== undefined) registry.notFound = opts.notFound;
  if (opts.router !== undefined) registry.router = opts.router;
  return registry;
}
