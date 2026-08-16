//
//  generated-loader.ts - node-side loader for the prepare_server.rb artifacts
//  (packages/server/generated/): routes.json + build-info.json + the handlers barrel.
//  Node-only by design (fs, dynamic file-URL import) — imported by bootloader-node,
//  NEVER by src/index.ts (the browser-safe surface) or host.ts (platform-free).
//

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { HostConfig, ServerRoute } from "./host.ts";
import { installEntities, type EntitySpec } from "./repo.ts";
import { NO_CONFIG, readServerConfig, type ServerConfig } from "./config.ts";
import { installPackages, type PackageModule } from "./packages.ts";

export interface DataProvider {
  backend: string;
  install(env: (key: string) => string | undefined): Promise<{ installed: boolean; backend: string }>;
}

export interface GeneratedArtifacts {
  routes: ServerRoute[];
  buildInfo: Record<string, unknown>;
  handlers: HostConfig["handlers"];
  /** the declared settings table — NO_CONFIG when the tree declares none (config.ts) */
  config: ServerConfig;
  /** the config key whose value picks the data backend — null when the tree declares no data */
  backendSetting: string | null;
  /** enabled provider residences, keyed by backend scheme (generated/providers.ts) */
  dataProviders: DataProvider[];
}

const EMIT = "run `ruby ClosedSource/scripts/prepare_server.rb` to emit the server artifacts";

const ROUTE_FIELDS = ["key", "chain", "action", "method", "path"] as const;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`@despia/server: cannot parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The emitter writes either a bare row array or { "routes": [...] } — accept both, then
// pin the five required string fields per row (extra columns like `schedule` pass through).
function readRoutes(path: string): ServerRoute[] {
  const parsed = readJson(path);
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { routes?: unknown }).routes)
      ? (parsed as { routes: unknown[] }).routes
      : null;
  if (rows === null) throw new Error(`@despia/server: ${path} must be a route array (or { "routes": [...] }) — ${EMIT}.`);
  rows.forEach((row, i) => {
    if (typeof row !== "object" || row === null) throw new Error(`@despia/server: ${path} row ${i} is not an object — ${EMIT}.`);
    for (const field of ROUTE_FIELDS) {
      const value = (row as Record<string, unknown>)[field];
      if (typeof value !== "string" || value === "") {
        throw new Error(`@despia/server: ${path} row ${i} is missing string "${field}" — ${EMIT}.`);
      }
    }
  });
  return rows as ServerRoute[];
}

/** Load the generated server artifacts. `dir` overrides the default ../generated (tests, tooling). */
export async function loadGenerated(dir?: string): Promise<GeneratedArtifacts> {
  const here = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  const base = dir !== undefined ? resolve(dir) : join(here, "..", "generated");
  if (!existsSync(base)) {
    throw new Error(`@despia/server: no generated/ folder at ${base} — ${EMIT}.`);
  }
  const paths = {
    routes: join(base, "routes.json"),
    buildInfo: join(base, "build-info.json"),
    handlers: join(base, "handlers.ts"),
  };
  for (const p of Object.values(paths)) {
    if (!existsSync(p)) throw new Error(`@despia/server: generated artifact missing at ${p} — ${EMIT}.`);
  }
  const routes = readRoutes(paths.routes);
  // The SCHEMA table, installed into the repository so declared-CRUD handlers can enforce the
  // field allowlist. Optional by design: a tree with no `schema` facet emits no entities.json,
  // and a repository call for an unknown entity then fails closed with a message naming it —
  // never a silent write to an undeclared table.
  const entitiesPath = join(base, "entities.json");
  if (existsSync(entitiesPath)) {
    const doc = readJson(entitiesPath) as { entities?: unknown };
    const list = Array.isArray(doc) ? doc : doc?.entities;
    if (!Array.isArray(list)) {
      throw new Error(`@despia/server: ${entitiesPath} must be an entity array (or { "entities": [...] }) — ${EMIT}.`);
    }
    installEntities(list as EntitySpec[]);
  }
  // The DECLARED SETTINGS (plan B4). Optional in the same sense entities.json is: a tree whose
  // server module declares no config emits none, and NO_CONFIG then requires nothing — absence
  // must never invent a requirement, or a correctly-configured server would refuse to boot.
  const configPath = join(base, "config.json");
  const config = existsSync(configPath) ? readServerConfig(readJson(configPath)) : NO_CONFIG;
  const buildInfo = readJson(paths.buildInfo);
  if (typeof buildInfo !== "object" || buildInfo === null || Array.isArray(buildInfo)) {
    throw new Error(`@despia/server: ${paths.buildInfo} must be a JSON object — ${EMIT}.`);
  }
  const barrel = (await import(pathToFileURL(paths.handlers).href)) as { handlers?: unknown };
  if (typeof barrel.handlers !== "object" || barrel.handlers === null) {
    throw new Error(`@despia/server: ${paths.handlers} must export \`handlers\` (chain → action → function) — ${EMIT}.`);
  }
  // The DATA-PROVIDER barrel (plan B5). Optional like entities/config: a tree with no provider
  // modules emits none, and the bootloader then installs nothing — the repository's own
  // fail-closed 500 (`no data provider is installed`) remains the honest floor for a tree that
  // declares data routes but somehow lost its barrel.
  const providersPath = join(base, "providers.ts");
  let backendSetting: string | null = null;
  let dataProviders: DataProvider[] = [];
  if (existsSync(providersPath)) {
    const doc = (await import(pathToFileURL(providersPath).href)) as { backendSetting?: unknown; dataProviders?: unknown };
    if (!Array.isArray(doc.dataProviders)) {
      throw new Error(`@despia/server: ${providersPath} must export \`dataProviders\` — ${EMIT}.`);
    }
    backendSetting = typeof doc.backendSetting === "string" ? doc.backendSetting : null;
    dataProviders = doc.dataProviders as DataProvider[];
  }
  // DECLARED PACKAGES (Core/Server/Modules/Import). Optional in the same sense as everything
  // above, and bound HERE rather than per-request so a package whose export moved refuses the
  // boot — a running server that cannot serve one route is harder to diagnose than one that
  // never came up.
  const packagesPath = join(base, "packages.ts");
  if (existsSync(packagesPath)) {
    const doc = (await import(pathToFileURL(packagesPath).href)) as { packageModules?: unknown };
    if (!Array.isArray(doc.packageModules)) {
      throw new Error(`@despia/server: ${packagesPath} must export \`packageModules\` — ${EMIT}.`);
    }
    installPackages(doc.packageModules as PackageModule[]);
  }
  return {
    routes,
    buildInfo: buildInfo as Record<string, unknown>,
    handlers: barrel.handlers as HostConfig["handlers"],
    config,
    backendSetting,
    dataProviders,
  };
}

/**
 * Boot the data backend: install the provider the configuration chose. Called by the
 * bootloaders BEFORE the port opens, so a data-declaring server never comes up half-alive.
 *
 * No choice configured, or no matching residence ⇒ installs nothing and says so in the return —
 * the caller logs it; the repository stays fail-closed for any data route that then runs.
 */
export async function installConfiguredDataProvider(
  artifacts: Pick<GeneratedArtifacts, "backendSetting" | "dataProviders" | "config">,
  env: (key: string) => string | undefined,
): Promise<{ installed: boolean; backend: string } | null> {
  if (artifacts.backendSetting === null) return null;
  const chosen = artifacts.config.settings[artifacts.backendSetting];
  const provider = artifacts.dataProviders.find((p) => p.backend === chosen);
  if (provider === undefined) return null;
  return provider.install(env);
}
