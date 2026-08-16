//
//  offline-manifest.ts — emit the OFFLINE MANIFEST for a built site: the TS twin of
//  prepare_modules' auto-compiled seed manifests (bundled-floor.md). ONE dialect across
//  the whole framework — { entry, assets:[{ path, sha256 }] } — read by the native seed
//  registries (iOS DSXContentSeeds.json / Android ContentSeeds.generated.kt), by the
//  native offline web-bundle sync (asset_json_path), and by the web renderer's service
//  worker (dsx-sw.js), which precaches it as an atomic hash-named generation.
//
//  Deterministic on purpose: sorted rels, no timestamps — the per-file sha256 IS the
//  change detector (content-plane law), so the same tree emits the same bytes and the
//  same generation id.
//

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type EmitOptions = {
  /** entry file override; default: "index.html" when present, else a single .html */
  entry?: string;
  /** rel-path predicate — return false to leave a file out (e.g. the manifest itself) */
  include?: (rel: string) => boolean;
  /** the declared navigation strategy ("swr" | "network-first") — omitted = default */
  nav?: string;
  /** declared dynamic-route skeleton pages ({ pattern, page }) — the worker serves the
   *  pattern's exported page for a matching offline navigation (bundled-floor.md §Dynamic) */
  routes?: { pattern: string; page: string }[];
};

export type EmittedManifest = {
  entry?: string; nav?: string;
  routes?: { pattern: string; page: string }[];
  assets: { path: string; sha256: string }[];
};

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).split(sep).join("/"));
  }
}

/** Build the manifest object for a site directory (pure over the filesystem). */
export function offlineManifest(dir: string, opts: EmitOptions = {}): EmittedManifest {
  const rels: string[] = [];
  walk(dir, dir, rels);
  rels.sort();
  const include = opts.include ?? ((): boolean => true);
  const assets = rels
    .filter((rel) => include(rel))
    .map((rel) => ({
      path: rel,
      sha256: createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex"),
    }));
  const htmls = assets.map((a) => a.path).filter((p) => p.endsWith(".html"));
  const entry = opts.entry
    ?? (assets.some((a) => a.path === "index.html") ? "index.html" : htmls.length === 1 ? htmls[0] : undefined);
  const out: EmittedManifest = {} as EmittedManifest;
  if (entry !== undefined) out.entry = entry;
  if (opts.nav !== undefined) out.nav = opts.nav;
  if (opts.routes !== undefined && opts.routes.length > 0) out.routes = opts.routes;
  out.assets = assets;
  return out;
}

/** Serialize exactly like the ruby twin (pretty JSON + trailing newline). */
export function offlineManifestText(dir: string, opts: EmitOptions = {}): string {
  return `${JSON.stringify(offlineManifest(dir, opts), null, 2)}\n`;
}
