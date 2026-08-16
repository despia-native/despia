//
//  web-manifest.ts — the dsx.json `web` BLOCK (W3 "remaining product breadth", W4
//  "package-contributed route merging + collision lint").
//
//  A package declares its web surface in ONE place, its own manifest:
//
//    "web": {
//      "expose": { "Paywall": { "tag": "acme-paywall" } },   // → expose.ts (W10 embeds)
//      "embed":  { "origins": ["https://partner.example"] }, // → expose.ts
//      "routes": [ { "path": "/pricing", "component": "Pricing" } ],
//      "styles": [ "web/theme.css" ],
//      "assets": [ "web/public" ],
//      "base":   "/app/"
//    }
//
//  `routes` is the interesting one. Native packages already contribute screens; on web a
//  package could not contribute URLs, so an installed package's screens were reachable only
//  by a component push the APP had to know about. Package routes fix that, and because two
//  packages can now claim the same URL, merging is LINTED rather than last-one-wins:
//
//    • a package route's `component` may be bare ("Pricing") — it resolves inside the
//      declaring package's scheme, so a package can never accidentally route to another
//      package's component of the same name. A dotted name is taken verbatim.
//    • APP routes always win: `Config/routes.json` is the application's own table, so a
//      package path that collides with it is a WARNING and the package route is dropped.
//    • two PACKAGES claiming the same path is an ERROR: neither is authoritative, and
//      silently picking one produces a build whose URLs depend on directory order.
//    • the same path twice inside ONE package is an ERROR (an authoring typo).
//
//  Everything here is pure data over the parsed manifest: no filesystem, no node imports,
//  so the compiler, the CLI and the Vite plugin all consume one implementation.
//

import type { Registry } from "./resolve.ts";
import { readUniversalLinks, type UniversalLinks, type UniversalLinksDeclaration } from "./universal-links.ts";

export type RouteEntry = NonNullable<Registry["routes"]>[number];

export type DsxJsonWeb = {
  expose?: { [component: string]: { tag?: string; budgetKB?: number } | Record<string, never> };
  embed?: { origins?: string[] };
  routes?: unknown;
  styles?: unknown;
  assets?: unknown;
  base?: unknown;
  links?: UniversalLinksDeclaration;
  /** npm coordinates this package's BROWSER code may import (A3). The server twin is
   *  `server_dependencies`, validated identically in prepare_server.rb. */
  dependencies?: unknown;
  /** package-relative browser module bundled into its own lazy chunk (A3) */
  entry?: unknown;
};

export type PackageWeb = {
  scheme: string;
  /** routes this package contributes to the unified table, components already qualified */
  routes: RouteEntry[];
  /** package-relative sidecar stylesheets to fold into the build */
  styles: string[];
  /** package-relative static asset directories to copy into the site */
  assets: string[];
  /** the app base path, when this package is the application root */
  base?: string;
  /** the validated native universal-links declaration (apple-app-site-association +
   *  assetlinks.json are GENERATED from the route table — universal-links.ts) */
  links?: UniversalLinks;
  /** npm name → pinned version, the coordinates this package's browser entry may import */
  dependencies: Record<string, string>;
  /** package-relative browser module, bundled into its own chunk */
  entry?: string;
};

export type WebManifestDiagnostics = { errors: string[]; warnings: string[] };

const PATH_SHAPE = /^\/[^\s?#]*$/;
const RELATIVE_SHAPE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const MAX_ROUTES = 256;
const MAX_PATHS = 1_024;
/** The SAME shapes prepare_server.rb applies to `web.server_dependencies`. Two dependency
 *  blocks that disagreed about what a coordinate looks like would eventually let one side
 *  install something the other refuses to resolve. */
const NPM_NAME_SHAPE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION_SHAPE = /^[\^~]?[0-9][0-9a-zA-Z.\-+]*$/;
const MAX_DEPENDENCIES = 64;

function stringList(value: unknown, label: string, scheme: string, out: WebManifestDiagnostics): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    out.errors.push(`[dsx web] ${scheme}: "${label}" must be an array of package-relative paths`);
    return [];
  }
  const list: string[] = [];
  for (const raw of value.slice(0, MAX_PATHS)) {
    if (typeof raw !== "string" || !RELATIVE_SHAPE.test(raw) || raw.includes("..")) {
      out.errors.push(`[dsx web] ${scheme}: "${label}" entry ${JSON.stringify(raw)} must be a package-relative path with no "..""`);
      continue;
    }
    list.push(raw);
  }
  return list;
}

/** Read ONE package's `web` block into its normalized contribution. Unknown keys are
 *  ignored (forward compatible); malformed KNOWN keys are reported, never guessed at. */
export function readPackageWeb(scheme: string, web: DsxJsonWeb | undefined): {
  web: PackageWeb;
  diagnostics: WebManifestDiagnostics;
} {
  const diagnostics: WebManifestDiagnostics = { errors: [], warnings: [] };
  const out: PackageWeb = { scheme, routes: [], styles: [], assets: [], dependencies: {} };
  if (web === undefined) return { web: out, diagnostics };

  out.styles = stringList(web.styles, "styles", scheme, diagnostics);
  out.assets = stringList(web.assets, "assets", scheme, diagnostics);

  if (web.entry !== undefined) {
    if (typeof web.entry !== "string" || !RELATIVE_SHAPE.test(web.entry) || web.entry.includes("..")) {
      diagnostics.errors.push(`[dsx web] ${scheme}: "entry" must be a package-relative module path with no ".."`);
    } else out.entry = web.entry;
  }

  if (web.dependencies !== undefined) {
    if (typeof web.dependencies !== "object" || web.dependencies === null || Array.isArray(web.dependencies)) {
      diagnostics.errors.push(`[dsx web] ${scheme}: "dependencies" must be a map of npm name → pinned version`);
    } else {
      const entries = Object.entries(web.dependencies as Record<string, unknown>);
      if (entries.length > MAX_DEPENDENCIES) {
        diagnostics.errors.push(`[dsx web] ${scheme}: "dependencies" declares ${entries.length} packages (max ${MAX_DEPENDENCIES})`);
      }
      for (const [name, version] of entries.slice(0, MAX_DEPENDENCIES)) {
        if (!NPM_NAME_SHAPE.test(name)) {
          diagnostics.errors.push(`[dsx web] ${scheme}: dependency name ${JSON.stringify(name)} is not a plain npm package name`);
          continue;
        }
        if (typeof version !== "string" || !NPM_VERSION_SHAPE.test(version)) {
          diagnostics.errors.push(`[dsx web] ${scheme}: dependency ${name} version ${JSON.stringify(version)} is not a plain npm version range`);
          continue;
        }
        out.dependencies[name] = version;
      }
    }
  }

  // Dependencies with nothing to import them is the silent-no-op class this repo refuses:
  // the install succeeds, the bundle is unchanged, and the author believes a library shipped.
  if (Object.keys(out.dependencies).length > 0 && out.entry === undefined) {
    diagnostics.errors.push(
      `[dsx web] ${scheme}: "dependencies" without an "entry" — nothing would import them. ` +
      `Declare the browser module that uses them, or drop the dependencies.`,
    );
  }

  if (web.base !== undefined) {
    if (typeof web.base !== "string" || !web.base.startsWith("/")) {
      diagnostics.errors.push(`[dsx web] ${scheme}: "base" must be an absolute path such as "/app/"`);
    } else out.base = web.base.endsWith("/") ? web.base : `${web.base}/`;
  }

  if (web.links !== undefined) {
    try {
      const links = readUniversalLinks(web.links);
      if (links !== null) out.links = links;
    } catch (e) {
      diagnostics.errors.push(`[dsx web] ${scheme}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  if (web.routes !== undefined) {
    if (!Array.isArray(web.routes)) {
      diagnostics.errors.push(`[dsx web] ${scheme}: "routes" must be an array of route entries`);
    } else {
      if (web.routes.length > MAX_ROUTES) {
        diagnostics.errors.push(`[dsx web] ${scheme}: "routes" declares ${web.routes.length} entries; the ceiling is ${MAX_ROUTES}`);
      }
      const seen = new Set<string>();
      for (const raw of web.routes.slice(0, MAX_ROUTES)) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          diagnostics.errors.push(`[dsx web] ${scheme}: each "routes" entry must be an object`);
          continue;
        }
        const entry = raw as Record<string, unknown>;
        const path = entry["path"];
        if (typeof path !== "string" || !PATH_SHAPE.test(path)) {
          diagnostics.errors.push(`[dsx web] ${scheme}: route path ${JSON.stringify(path)} must be an absolute path with no query or fragment`);
          continue;
        }
        if (seen.has(path)) {
          diagnostics.errors.push(`[dsx web] ${scheme}: route "${path}" is declared twice in the same package`);
          continue;
        }
        seen.add(path);
        const component = entry["component"];
        if (component !== undefined && (typeof component !== "string" || component.length === 0)) {
          diagnostics.errors.push(`[dsx web] ${scheme}: route "${path}" has a non-string component`);
          continue;
        }
        if (component === undefined && typeof entry["redirect"] !== "string") {
          diagnostics.errors.push(`[dsx web] ${scheme}: route "${path}" declares neither a component nor a redirect`);
          continue;
        }
        const merged: RouteEntry = { ...(entry as unknown as RouteEntry), path };
        // A BARE component name resolves inside the declaring package — a package can
        // never route to another package's same-named component by accident.
        if (typeof component === "string" && !component.includes(".")) {
          merged.component = `${scheme}.${component}`;
        }
        out.routes.push(merged);
      }
    }
  }
  return { web: out, diagnostics };
}

/** Merge package contributions UNDER the application's own table.
 *  Application routes are authoritative; package↔package collisions are errors. */
export function mergePackageRoutes(
  appRoutes: readonly RouteEntry[] | undefined,
  packages: readonly PackageWeb[],
): { routes: RouteEntry[]; diagnostics: WebManifestDiagnostics } {
  const diagnostics: WebManifestDiagnostics = { errors: [], warnings: [] };
  const routes: RouteEntry[] = [...(appRoutes ?? [])];
  const appPaths = new Set(routes.map((r) => r.path));
  const claimed = new Map<string, string>();

  for (const pkg of packages) {
    for (const route of pkg.routes) {
      if (appPaths.has(route.path)) {
        diagnostics.warnings.push(
          `[dsx web] ${pkg.scheme} contributes route "${route.path}", but the application declares it too — `
          + `the application table wins and the package route is dropped`,
        );
        continue;
      }
      const prior = claimed.get(route.path);
      if (prior !== undefined) {
        diagnostics.errors.push(
          `[dsx web] route collision on "${route.path}": claimed by both ${prior} and ${pkg.scheme}. `
          + `Neither is authoritative — rename one, or declare the path in the application's Config/routes.json.`,
        );
        continue;
      }
      claimed.set(route.path, pkg.scheme);
      routes.push(route);
    }
  }
  return { routes, diagnostics };
}

/** The one-call path used by builders: read every manifest, merge, and hand back the
 *  unified table plus every diagnostic. Throws on an ERROR (a build must not ship a
 *  route table whose URLs depend on directory order); warnings are the caller's to print. */
export function resolveWebManifests(
  appRoutes: readonly RouteEntry[] | undefined,
  manifests: ReadonlyArray<{ scheme: string; web?: DsxJsonWeb }>,
): { routes: RouteEntry[]; packages: PackageWeb[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const packages: PackageWeb[] = [];
  for (const { scheme, web } of manifests) {
    const read = readPackageWeb(scheme, web);
    errors.push(...read.diagnostics.errors);
    warnings.push(...read.diagnostics.warnings);
    packages.push(read.web);
  }
  const merged = mergePackageRoutes(appRoutes, packages);
  errors.push(...merged.diagnostics.errors);
  warnings.push(...merged.diagnostics.warnings);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { routes: merged.routes, packages, warnings };
}
