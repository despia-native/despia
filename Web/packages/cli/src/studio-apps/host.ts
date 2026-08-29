//
//  studio-apps/host.ts — the edit host's app plane (studio-apps.md §8): discovery, the
//  install/grant state, the PURE mount-table fold, and the per-app sub-registry.
//
//  Three discovery sources, three trust kinds:
//    builtin   — first-party app modules in the framework tree (facets.apps rows found by
//                the same walk-up resolution the editor itself uses). Preinstalled: an
//                absent state row auto-creates enabled, with the manifest grants RECORDED
//                (visible in the panel), because the framework shipping itself an app is
//                the person already having chosen Despia.
//    dev       — a package of the OPEN PROJECT carrying facets.apps rows: the app being
//                built in this very Studio. Enabled with a dev badge; the working tree IS
//                the mount, which is the recursion law's second half (the pinned tree is
//                the first).
//    installed — a registry package pinned in dsx.lock.json. Mounts only with a recorded
//                consent row (the install dialog writes it) AND, for the shelf tier, a
//                verified approval — fail-closed, per-contribution, reasons named.
//
//  The fold (resolveStudioApps) is PURE and corpus-driven (Conformance/studio-apps/
//  slots.json): rows + state + approvals + denylist + studioApi → the mount table and the
//  refusals, deterministically ordered. The endpoints in edit.ts are thin doors over it.
//

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "@despia-native/compiler";
import type { Registry } from "@despia-native/compiler/resolve";

import { globSync } from "./glob.ts";
import { readAppManifest, manifestGrants, STUDIO_API, APP_BUDGETS, type AppManifestInfo, type AppContribution } from "./manifest.ts";

export type AppKind = "builtin" | "dev" | "installed";

export type DiscoveredApp = {
  kind: AppKind;
  dir: string;
  info: AppManifestInfo;
  /** the lockfile id for an installed app ("github:owner/repo@1.2.0"); "" otherwise */
  lockId: string;
};

export type AppStateRow = {
  enabled: boolean;
  version: string;
  grants: string[];
  grantedAt: string;
};
export type AppState = { [scheme: string]: AppStateRow };

export type AppRefusal = { app: string; contribution: string | null; reason: string };

export type MountRow = {
  app: string;
  kind: AppKind;
  contribution: AppContribution;
  title: string;
};

export type StudioAppsTable = {
  /** docked side panels — the default placement (studio-apps.md §4.1) */
  panels: MountRow[];
  rail: MountRow[];
  styleSections: MountRow[];
  inspectorSections: MountRow[];
  cards: MountRow[];
  tools: MountRow[];
  automations: MountRow[];
};

const EMPTY_TABLE = (): StudioAppsTable => ({ panels: [], rail: [], styleSections: [], inspectorSections: [], cards: [], tools: [], automations: [] });

// ── discovery ───────────────────────────────────────────────────────────────────────────

/** the framework module tree, resolved the way resolveDsxEditor resolves the editor */
export function resolveModuleTree(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "ClosedSource", "DSX", "Modules");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The preinstalled first-party Despia apps (studio-apps.md §12): every package under
 *  ClosedSource/StudioApps (or a published @despia-native/app-* twin in the project) is a builtin
 *  app — its manifest rides the same fold an installed app's does, and EditorApps shows it
 *  with the built-in badge. Absence is fine: a toolchain without them has fewer apps. */
export function resolveFirstPartyApps(projectRoot: string): string[] {
  const out: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "ClosedSource", "StudioApps");
    if (existsSync(candidate)) {
      for (const name of readdirSync(candidate).sort()) {
        const full = join(candidate, name);
        if (existsSync(join(full, "dsx.json"))) out.push(full);
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const published = join(projectRoot, "node_modules", "@despia");
  if (existsSync(published)) {
    for (const name of readdirSync(published).sort()) {
      if (!name.startsWith("app-")) continue;
      const full = join(published, name);
      if (existsSync(join(full, "dsx.json"))) out.push(full);
    }
  }
  return out;
}

function readManifestAt(dir: string): AppManifestInfo | null {
  const path = join(dir, "dsx.json");
  if (!existsSync(path)) return null;
  try {
    const { info, issues } = readAppManifest(JSON.parse(readFileSync(path, "utf8")));
    if (issues.length > 0) {
      console.warn(`[despia apps] ${path}: invalid app manifest — ${issues.map((i) => i.code).join(", ")}`);
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function discoverApps(opts: {
  projectRoot: string;
  packageDirs: readonly string[];
  lockedDirs: ReadonlyArray<{ id: string; dir: string }>;
  moduleTree?: string | null;
  /** Extra dirs whose manifests are builtin apps regardless of the module tree — the
   *  resolved Editor package rides here so its census rows survive an npm install,
   *  where the repo walk-up finds no ClosedSource tree. */
  builtinDirs?: readonly string[];
}): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  const seen = new Set<string>();
  const push = (kind: AppKind, dir: string, lockId: string): void => {
    const info = readManifestAt(dir);
    if (info === null || info.scheme === "" || seen.has(info.scheme)) return;
    seen.add(info.scheme);
    out.push({ kind, dir, info, lockId });
  };
  // dev apps first: the working tree wins its own scheme over a pinned or builtin copy —
  // that is what "edit the app that extends the editor you are standing in" means
  for (const dir of opts.packageDirs) {
    if (dir !== opts.projectRoot) push("dev", dir, "");
  }
  for (const row of opts.lockedDirs) push("installed", row.dir, row.id);
  for (const dir of opts.builtinDirs ?? []) push("builtin", dir, "");
  const tree = opts.moduleTree === undefined ? resolveModuleTree() : opts.moduleTree;
  if (tree !== null && tree !== undefined) {
    for (const manifest of globSync(tree, "dsx.json")) push("builtin", dirname(manifest), "");
  }
  return out.sort((a, b) => a.info.scheme.localeCompare(b.info.scheme));
}

// ── install/grant state (.despia/apps/grants.json) ─────────────────────────────────────

export function stateFile(projectRoot: string): string {
  return join(projectRoot, ".despia", "apps", "grants.json");
}

export function readAppState(projectRoot: string): AppState {
  const path = stateFile(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AppState) : {};
  } catch {
    return {};
  }
}

export function writeAppState(projectRoot: string, state: AppState): void {
  const path = stateFile(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // stable key order for a reviewable diff — rebuilt, never via a JSON.stringify replacer
  // array, which would filter NESTED keys too and strip every row to nothing
  const sorted: AppState = {};
  for (const key of Object.keys(state).sort()) sorted[key] = state[key]!;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(tmp, path);
}

/** builtin/dev apps auto-seed an enabled, RECORDED row on first sight; installed apps do
 *  not — their row is the consent the install dialog wrote, and absence means disabled. */
export function seedState(apps: readonly DiscoveredApp[], state: AppState): { state: AppState; changed: boolean } {
  let changed = false;
  const next: AppState = { ...state };
  for (const app of apps) {
    if (app.kind === "installed") continue;
    const existing = next[app.info.scheme];
    const grants = manifestGrants(app.info);
    if (existing === undefined) {
      next[app.info.scheme] = { enabled: true, version: app.info.version, grants, grantedAt: new Date().toISOString() };
      changed = true;
    } else if (existing.version !== app.info.version || JSON.stringify(existing.grants) !== JSON.stringify(grants)) {
      // first-party/dev grants track the working manifest — the panel shows the live truth
      next[app.info.scheme] = { ...existing, version: app.info.version, grants };
      changed = true;
    }
  }
  return { state: next, changed };
}

// ── the pure fold ───────────────────────────────────────────────────────────────────────

export type ResolveOpts = {
  studioApi?: number;
  denylist?: ReadonlyArray<string>;
  /** verified approvals for the shelf tier: scheme → the approved version */
  approvals?: Readonly<Record<string, string>>;
};

export function resolveStudioApps(
  apps: readonly DiscoveredApp[],
  state: AppState,
  opts: ResolveOpts = {},
): { table: StudioAppsTable; refusals: AppRefusal[] } {
  const hostApi = opts.studioApi ?? STUDIO_API;
  const denied = new Set(opts.denylist ?? []);
  const table = EMPTY_TABLE();
  const refusals: AppRefusal[] = [];

  for (const app of apps) {
    const scheme = app.info.scheme;
    const row = state[scheme];
    if (denied.has(scheme) || app.lockId !== "" && denied.has(app.lockId.split("@")[0] ?? "")) {
      refusals.push({ app: scheme, contribution: null, reason: "denylisted — removed for cause; see the registry's denylist entry" });
      continue;
    }
    if (app.info.studioApi !== hostApi) {
      refusals.push({ app: scheme, contribution: null, reason: `built for Studio API ${app.info.studioApi}; this Studio speaks ${hostApi}` });
      continue;
    }
    if (row === undefined || !row.enabled) {
      if (app.kind === "installed" && row === undefined) {
        refusals.push({ app: scheme, contribution: null, reason: "installed but not enabled — grants have not been reviewed" });
      }
      continue;
    }
    if (app.kind === "installed") {
      const approved = opts.approvals?.[scheme];
      if (approved === undefined) {
        refusals.push({ app: scheme, contribution: null, reason: "no verified approval for this app — the apps shelf signs (coordinate, version, treeHash, grants); dev mode mounts a working tree instead" });
        continue;
      }
      if (approved !== app.info.version) {
        refusals.push({ app: scheme, contribution: null, reason: `approval covers ${approved}, the pin is ${app.info.version} — update or re-submit` });
        continue;
      }
    }
    // an update that widened grants holds the app until re-consent (the panel renders the diff)
    const granted = new Set(row.grants);
    const asked = manifestGrants(app.info);
    const widened = asked.filter((g) => !granted.has(g));
    if (widened.length > 0) {
      refusals.push({ app: scheme, contribution: null, reason: `asks for ${widened.length} new permission(s): ${widened.join(", ")} — re-consent in the Apps panel` });
      continue;
    }
    for (const contribution of app.info.contributions) {
      const mountRow: MountRow = { app: scheme, kind: app.kind, contribution, title: contribution.title ?? app.info.name };
      switch (contribution.slot) {
        case "studio.panel": table.panels.push(mountRow); break;
        case "studio.rail": table.rail.push(mountRow); break;
        case "studio.style.section": table.styleSections.push(mountRow); break;
        case "studio.inspector.section": table.inspectorSections.push(mountRow); break;
        case "dashboard.card": table.cards.push(mountRow); break;
        case "tool": table.tools.push(mountRow); break;
        case "automation": table.automations.push(mountRow); break;
      }
    }
  }
  const byOrder = (a: MountRow, b: MountRow): number =>
    (a.contribution.order - b.contribution.order) || a.app.localeCompare(b.app) || a.contribution.id.localeCompare(b.contribution.id);
  for (const rows of Object.values(table)) rows.sort(byOrder);
  return { table, refusals };
}

// ── the sub-registry ────────────────────────────────────────────────────────────────────

/** OpenSource/StudioKit, resolved like every editor package (node_modules first, walk-up) */
export function resolveStudioKit(projectRoot: string): string | null {
  const candidates = [join(projectRoot, "node_modules", "@despia", "studiokit")];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, "OpenSource", "StudioKit"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "dsx.json")) && existsSync(join(candidate, "Components"))) return candidate;
  }
  return null;
}

const subRegistryCache = new Map<string, { stamp: string; payload: SurfacePayload }>();

export type SurfacePayload = {
  scheme: string;
  entry: string;
  registry: Registry;
  grants: string[];
  events: string[];
  budgets: typeof APP_BUDGETS;
  kind: AppKind;
  title: string;
};

function treeStamp(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    for (const file of globSync(dir, ".dsx").concat(globSync(dir, ".css"), globSync(dir, "dsx.json"))) {
      try {
        const { mtimeMs, size } = statSync(file);
        parts.push(`${file}:${mtimeMs}:${size}`);
      } catch { /* raced a delete — the stamp differs, which is the point */ }
    }
  }
  return parts.sort().join("|");
}

/**
 * Compile one app's PER-APP SUB-REGISTRY: its own components + StudioKit, nothing else.
 * The app resolves only its own scheme plus the kit — it cannot name, shadow, or reach a
 * first-party component; a shipped tag of the same name is simply unresolvable here.
 */
export function appSurfacePayload(app: DiscoveredApp, contribution: AppContribution, projectRoot: string): SurfacePayload {
  const kit = resolveStudioKit(projectRoot);
  const dirs = kit !== null ? [app.dir, kit] : [app.dir];
  const key = `${app.info.scheme}#${contribution.id}`;
  const stamp = treeStamp(dirs);
  const cached = subRegistryCache.get(key);
  if (cached !== undefined && cached.stamp === stamp) return cached.payload;

  const registry = buildRegistry(
    dirs.map((dir, i) => (i === 0 ? { dir, scheme: app.info.scheme, app: true } : { dir })),
    [],
    {},
  );
  const component = contribution.component ?? "";
  const base = component.slice(component.lastIndexOf("/") + 1).replace(/\.dsx$/, "");
  const entry = `${app.info.scheme}.${base}`;
  if (registry.components[entry] === undefined) {
    throw new Error(`[despia apps] ${app.info.scheme}: contribution "${contribution.id}" names ${component}, which did not compile`);
  }
  const payload: SurfacePayload = {
    scheme: app.info.scheme,
    entry,
    registry,
    grants: manifestGrants(app.info),
    events: contribution.events,
    budgets: APP_BUDGETS,
    kind: app.kind,
    title: contribution.title ?? app.info.name,
  };
  subRegistryCache.set(key, { stamp, payload });
  return payload;
}

// ── per-app namespaced storage (.despia/apps/<scheme>/storage.json) ─────────────────────

export function appStorageFile(projectRoot: string, scheme: string): string {
  return join(projectRoot, ".despia", "apps", scheme, "storage.json");
}

export function readAppStorage(projectRoot: string, scheme: string): Record<string, unknown> {
  const path = appStorageFile(projectRoot, scheme);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeAppStorage(projectRoot: string, scheme: string, value: Record<string, unknown>): void {
  const path = appStorageFile(projectRoot, scheme);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── the marketplace projection ──────────────────────────────────────────────────────────

export type MarketRow = {
  scheme: string;
  name: string;
  summary: string;
  version: string;
  kind: AppKind | "shelf";
  installed: boolean;
  enabled: boolean;
  grants: string[];
  contributions: Array<{ id: string; slot: string; title: string }>;
  /** the install coordinate for a shelf row ("github:owner/repo@1.2.0"); "" otherwise */
  coordinate: string;
};

/** the apps-shelf index (RegistryRepo/apps.json), resolved by walk-up like everything else */
export function resolveAppsShelf(): Array<Record<string, unknown>> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "ClosedSource", "RegistryRepo", "apps.json");
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
        return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
      } catch {
        return [];
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** Discovery + shelf → the searchable market. `q` filters name/summary/scheme, ranked
 *  name-hit first — the search bar is the store's front door, so it is server-derived
 *  from the same rows the installed panel shows (one source, two views). */
export function marketRows(apps: readonly DiscoveredApp[], state: AppState, q = ""): MarketRow[] {
  const rows: MarketRow[] = [];
  const seen = new Set<string>();
  for (const app of apps) {
    seen.add(app.info.scheme);
    const row = state[app.info.scheme];
    rows.push({
      scheme: app.info.scheme,
      name: app.info.name,
      summary: app.info.summary,
      version: app.info.version,
      kind: app.kind,
      installed: true,
      enabled: row?.enabled === true,
      grants: manifestGrants(app.info),
      contributions: app.info.contributions.map((c) => ({ id: c.id, slot: c.slot, title: c.title ?? app.info.name })),
      coordinate: app.lockId,
    });
  }
  for (const entry of resolveAppsShelf()) {
    const scheme = typeof entry["scheme"] === "string" ? entry["scheme"] : "";
    if (scheme === "" || seen.has(scheme)) continue;
    rows.push({
      scheme,
      name: typeof entry["name"] === "string" ? entry["name"] : scheme,
      summary: typeof entry["summary"] === "string" ? entry["summary"] : "",
      version: typeof entry["version"] === "string" ? entry["version"] : "",
      kind: "shelf",
      installed: false,
      enabled: false,
      grants: Array.isArray(entry["grants"]) ? (entry["grants"] as string[]) : [],
      contributions: Array.isArray(entry["contributions"]) ? (entry["contributions"] as MarketRow["contributions"]) : [],
      coordinate: typeof entry["coordinate"] === "string" ? entry["coordinate"] : "",
    });
  }
  const needle = q.trim().toLowerCase();
  const filtered = needle === "" ? rows : rows.filter((r) =>
    r.name.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle) || r.scheme.includes(needle));
  return filtered.sort((a, b) => {
    if (needle !== "") {
      const an = a.name.toLowerCase().includes(needle) ? 0 : 1;
      const bn = b.name.toLowerCase().includes(needle) ? 0 : 1;
      if (an !== bn) return an - bn;
    }
    return a.name.localeCompare(b.name);
  });
}
