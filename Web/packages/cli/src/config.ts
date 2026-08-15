//
//  config.ts — the project contract `dsx build` / `dsx dev` / `dsx lint` read.
//
//  A DSX project IS a DSX package: a folder holding `dsx.json` (identity + scheme) and
//  `Components/**/*.dsx` — the same shape `buildRegistry` consumes for a module in the
//  monorepo. `dsx.config.json` adds only what a standalone app needs on top: the entry
//  component, the output directory, the route table, and any additional package roots.
//

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Registry } from "@despia/compiler/resolve";

export const CONFIG_FILENAME = "dsx.config.json";

export type ProjectConfig = {
  /** absolute project root (the folder holding dsx.config.json) */
  root: string;
  /** package scheme — from dsx.json, or the config's own `scheme` */
  scheme: string;
  /** app display name (document title fallback) */
  name: string;
  /** the root-plan entry component, qualified ("app.App") or bare ("App") */
  entry: string;
  /** build output directory, absolute */
  outDir: string;
  /** additional package roots folded into the registry (each: dsx.json + Components/) */
  packages: string[];
  /** the unified route table (/web/04). Absent = a pathless, component-push app. */
  routes: Registry["routes"];
  notFound: string | undefined;
  router: Registry["router"];
  /** `<html lang>` for the emitted document */
  lang: string;
  /** forced `data-dsx-theme` attribute, when the app is designed for one */
  theme: string | undefined;
  /** app identity seeded under `global.app` */
  app: { [key: string]: unknown };
};

type RawConfig = {
  name?: unknown; scheme?: unknown; entry?: unknown; outDir?: unknown; packages?: unknown;
  routes?: unknown; notFound?: unknown; router?: unknown; lang?: unknown; theme?: unknown;
  app?: unknown;
};

export class ConfigError extends Error {}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Walk up from `from` for the nearest dsx.config.json. Returns null when there is none —
 *  the caller then knows it is not standing in a project (and `dsx build` says so). */
export function findProjectRoot(from: string): string | null {
  let cursor = resolve(from);
  for (;;) {
    if (existsSync(join(cursor, CONFIG_FILENAME))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Read + normalize a project's configuration. Every relative path resolves against the
 *  project root, and every defaulted field is defaulted HERE, so no command re-derives it. */
export function loadConfig(root: string): ProjectConfig {
  const configPath = join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) throw new ConfigError(`no ${CONFIG_FILENAME} in ${root}`);
  const raw = readJson(configPath) as RawConfig;
  if (raw === null || typeof raw !== "object") throw new ConfigError(`${configPath}: expected a JSON object`);

  const manifestPath = join(root, "dsx.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) as { scheme?: unknown; name?: unknown } : {};

  const scheme = str(raw.scheme) ?? str(manifest.scheme);
  if (scheme === undefined) {
    throw new ConfigError(`${configPath}: no scheme — declare "scheme" here or in dsx.json (it namespaces every component)`);
  }
  const name = str(raw.name) ?? str(manifest.name) ?? scheme;

  const entryRaw = str(raw.entry);
  if (entryRaw === undefined) {
    throw new ConfigError(`${configPath}: no "entry" — name the component the app boots into (e.g. "App")`);
  }
  const entry = entryRaw.includes(".") ? entryRaw : `${scheme}.${entryRaw}`;

  const packages: string[] = [];
  if (raw.packages !== undefined) {
    if (!Array.isArray(raw.packages)) throw new ConfigError(`${configPath}: "packages" must be an array of folder paths`);
    for (const entryPath of raw.packages) {
      if (typeof entryPath !== "string") throw new ConfigError(`${configPath}: "packages" entries must be strings`);
      packages.push(isAbsolute(entryPath) ? entryPath : resolve(root, entryPath));
    }
  }

  const outDirRaw = str(raw.outDir) ?? "dist";
  return {
    root,
    scheme,
    name,
    entry,
    outDir: isAbsolute(outDirRaw) ? outDirRaw : resolve(root, outDirRaw),
    packages,
    routes: Array.isArray(raw.routes) ? raw.routes as Registry["routes"] : undefined,
    notFound: str(raw.notFound),
    router: raw.router !== undefined && typeof raw.router === "object" && raw.router !== null
      ? raw.router as Registry["router"]
      : undefined,
    lang: str(raw.lang) ?? "en",
    theme: str(raw.theme),
    app: raw.app !== undefined && typeof raw.app === "object" && raw.app !== null
      ? raw.app as { [key: string]: unknown }
      : { name, version: "0.0.0", build: "web", env: "debug" },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Every `.dsx` under a package root's `Components/`, sorted (deterministic output is the
 *  contract — the same reason buildRegistry sorts its own walk). */
export function componentFiles(packageRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".dsx")) out.push(full);
    }
  };
  walk(join(packageRoot, "Components"));
  return out;
}

/** The package roots a build/lint sees: the project itself, then its configured packages. */
export function packageRoots(config: ProjectConfig): string[] {
  return [config.root, ...config.packages];
}
