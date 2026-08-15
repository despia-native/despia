//
//  offline.ts — the WEB renderer's bundled floor + provenance publisher
//  (bundled-floor.md + source-plane.md, the browser twin — 1:1 with the native shapes).
//
//  On native, the floor is a content-store SEED (generation zero baked into the binary) and
//  provenance is `dsx.source.*` in the one reactive store. In a browser the binary is the
//  ORIGIN itself, so the floor is the SERVICE WORKER's precache: the SAME manifest dialect
//  the native seeds use ({ entry, assets:[{path, sha256}] } — emitted by the build exactly
//  like prepare_modules' auto-compiled seed manifests) precached as an atomic, hash-named
//  GENERATION. Install once online → every later launch renders offline; a new deploy is a
//  new generation, precached in the background and served on the next visit
//  (stale-while-revalidate — the content plane's law, verbatim).
//
//  This module is the PAGE half: it registers `dsx-sw.js`, seeds the kernel facts
//  (`source.online`, `source.boot`), publishes the `source.web` slice from the worker's
//  provenance messages, and rings the `content.updated` bell on the kernel bus when a fresh
//  generation is waiting. Markup reads are ALREADY live — the JSE alias (`dsx.source.*` →
//  `global.source.*`) ships on all three renderers — so `{{ dsx.source.online }}` and
//  friends work here the moment these paths are published. First-load stamps persist in
//  localStorage per plane+key (the UserDefaults twin): `never` stays truthful forever.
//
//  Fail-open by law (Article 7): no serviceWorker support / an insecure context / a
//  registration error → everything no-ops, the app runs exactly as before.
//

import { DSXState, ModuleRegistry } from "@despia/kernel";

// ── pure helpers (exported for the node test suite — no window/DOM touched) ─────────────

export type OfflineAsset = { path: string; sha256?: string };
export type OfflineRoute = { pattern: string; page: string };
export type OfflineManifest = { entry?: string; assets: OfflineAsset[]; nav?: string; routes?: OfflineRoute[] };

/** The tolerant manifest reader — the TS twin of the kernel ContentManifest parser:
 *  a JSON object with a file list under `assets` / `files` / `bundles`, items either
 *  plain strings (hash-less) or `{ path, sha256 }`. Unsafe paths (`..`, absolute URLs)
 *  are rejected per entry; an unusable document returns null (the SW keeps the old
 *  generation — nothing can poison the floor with an SPA catch-all 200). */
export function normalizeOfflineManifest(raw: unknown): OfflineManifest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const list = obj["assets"] ?? obj["files"] ?? obj["bundles"];
  if (!Array.isArray(list)) return null;
  const assets: OfflineAsset[] = [];
  for (const item of list) {
    let path = "";
    let sha: string | undefined;
    if (typeof item === "string") path = item;
    else if (item !== null && typeof item === "object") {
      const it = item as Record<string, unknown>;
      if (typeof it["path"] === "string") path = it["path"];
      if (typeof it["sha256"] === "string" && it["sha256"].length > 0) sha = it["sha256"];
    }
    path = path.trim();
    if (path.startsWith("./")) path = path.substring(2);
    while (path.startsWith("/")) path = path.substring(1);
    if (path.length === 0 || path.includes("://")) continue;
    if (path.split("/").some((p) => p === "..")) continue;
    assets.push(sha !== undefined ? { path, sha256: sha } : { path });
  }
  if (assets.length === 0) return null;
  const entry = typeof obj["entry"] === "string" && obj["entry"].length > 0 ? obj["entry"] : undefined;
  // `nav` — the DECLARED navigation strategy (bundled-floor.md §2c SSR composition):
  // "network-first" (default: the origin is the truth when reachable) or "swr" (serve the
  // precached SSR page instantly, revalidate behind it — repeat visits paint at cache
  // speed online AND offline). A manifest key, not code: native parsers ignore it.
  const nav = obj["nav"] === "swr" ? "swr" : undefined;
  // `routes` — DECLARED dynamic-route patterns and their offline SKELETON pages
  // (bundled-floor.md §Dynamic routes): the build exports one SSR page per pattern
  // (params empty → the screen's skeleton state) and declares the mapping here, so the
  // worker can serve /user/321 offline from the /user/:id page without knowing the route
  // table. Native parsers ignore the key; unsafe pages are dropped per entry.
  const routes: OfflineRoute[] = [];
  if (Array.isArray(obj["routes"])) {
    for (const item of obj["routes"]) {
      if (item === null || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const pattern = typeof it["pattern"] === "string" ? it["pattern"].trim() : "";
      let page = typeof it["page"] === "string" ? it["page"].trim() : "";
      while (page.startsWith("/")) page = page.substring(1);
      if (pattern.length === 0 || page.length === 0 || page.includes("://")) continue;
      if (page.split("/").some((p) => p === "..")) continue;
      routes.push({ pattern, page });
    }
  }
  const out: OfflineManifest = { assets };
  if (entry !== undefined) out.entry = entry;
  if (nav !== undefined) out.nav = nav;
  if (routes.length > 0) out.routes = routes;
  return out;
}

/** Match a concrete pathname against a route pattern — the DSXPathMatch twin (literal
 *  segments · `:name`/`{name}` one-segment params · a trailing `*` soaks the rest).
 *  Returns the extracted params on a match, null otherwise. */
export function matchRoutePattern(pathname: string, pattern: string): Record<string, string> | null {
  const seg = (s: string): string[] => s.split("/").filter((x) => x.length > 0);
  const pat = pattern.trim();
  if (pat === "*" || pat === "/*" || pat.length === 0) return {};
  const ps = seg(pathname);
  const pats = seg(pat);
  const params: Record<string, string> = {};
  for (let i = 0; i < pats.length; i += 1) {
    const s = pats[i]!;
    if (s === "*") {
      if (i === pats.length - 1) return params;   // trailing * soaks the rest
      if (i >= ps.length) return null;            // mid-path * matches one segment
      continue;
    }
    if (i >= ps.length) return null;
    if (s.length >= 2 && s.startsWith("{") && s.endsWith("}")) params[s.substring(1, s.length - 1)] = ps[i]!;
    else if (s.startsWith(":")) params[s.substring(1)] = ps[i]!;
    else if (s !== ps[i]) return null;
  }
  return ps.length === pats.length ? params : null;
}

/** The cached-page candidates for a navigation to `pathname` — the static-export
 *  convention (`exportStatic`: "/" → index.html, "/gallery" → gallery/index.html), plus
 *  the flat `<path>.html` spelling, then the SPA entry as the last resort. Order matters:
 *  a per-route SSR page beats the shell (per-route offline first paint + correct meta). */
export function navigationFallbackCandidates(pathname: string, entry: string = "index.html"): string[] {
  let p = pathname.trim();
  while (p.startsWith("/")) p = p.substring(1);
  while (p.endsWith("/")) p = p.substring(0, p.length - 1);
  const out: string[] = [];
  if (p.length === 0) out.push("index.html");
  else {
    out.push(`${p}/index.html`);
    out.push(`${p}.html`);
  }
  if (!out.includes(entry)) out.push(entry);
  return out;
}

/** never|stale|live from (did the origin answer this session, was it EVER answered) —
 *  the DSXSource.publish state rule, verbatim. */
export function deriveState(fresh: boolean, hasStamp: boolean): string {
  return fresh ? "live" : hasStamp ? "stale" : "never";
}

/** The generation cache name for a manifest's bytes (hex from crypto digest) — same idea
 *  as the store's generation id: same manifest IS same generation. */
export function generationName(hex: string): string {
  return `dsx-gen-${hex.substring(0, 16)}`;
}

// ── the source publisher (DSXSource twins over localStorage + the reactive store) ───────

const STAMP_PREFIX = "dsx.source.";

function stampKey(plane: string, key: string): string { return `${STAMP_PREFIX}${plane}.${key}`; }

function hasStamp(plane: string, key: string): boolean {
  try { return window.localStorage.getItem(stampKey(plane, key)) !== null; } catch { return false; }
}

/** Seed a plane before its first load of the session — `never` | `stale` (DSXSource.track). */
export function trackSource(plane: string, key: string): void {
  DSXState.set(`source.${plane}`, { state: hasStamp(plane, key) ? "stale" : "never" });
}

/** A serve/load happened (DSXSource.publish): fresh = the origin answered → `live` + the
 *  persisted first-load stamp; else `stale`/`never` derived from the stamp. `serving` and
 *  `at` always update; extra meta merges into the slice. */
export function publishSource(
  plane: string, serving: string, fresh: boolean, key: string,
  meta: Record<string, unknown> = {},
): void {
  if (fresh && !hasStamp(plane, key)) {
    try { window.localStorage.setItem(stampKey(plane, key), new Date().toISOString()); } catch { /* private mode */ }
  }
  const slice: Record<string, unknown> = {
    state: deriveState(fresh, hasStamp(plane, key)),
    serving,
    at: new Date().toISOString(),
    ...meta,
  };
  DSXState.set(`source.${plane}`, slice);
  ModuleRegistry.foldDelegate("source.changed", { plane, state: slice["state"] }, "void");
}

/** The kernel facts — `source.online` (reactive) + `source.boot` (first|warm). The
 *  DSXSource.seed twin; idempotent. */
export function seedSource(): void {
  let booted = false;
  try {
    booted = window.localStorage.getItem("dsx.source.booted") !== null;
    if (!booted) window.localStorage.setItem("dsx.source.booted", "1");
  } catch { /* private mode: every launch reads "first" — honest enough */ }
  DSXState.set("source.boot", booted ? "warm" : "first");
  DSXState.set("source.online", window.navigator.onLine);
  const publish = (online: boolean) => (): void => {
    DSXState.set("source.online", online);
    ModuleRegistry.foldDelegate("source.changed", { plane: "online", state: online }, "void");
  };
  window.addEventListener("online", publish(true));
  window.addEventListener("offline", publish(false));
}

// ── the floor registration (the page half of dsx-sw.js) ─────────────────────────────────

export type OfflineFloorOptions = {
  /** the worker script URL (root scope) — default "./dsx-sw.js", resolved against the
   *  DOCUMENT. An app that SSR-exports nested route pages (gallery/index.html) must
   *  anchor this to its bundle instead — `new URL("./dsx-sw.js", import.meta.url).href`
   *  from the root-level bootloader — or a deep-link first visit resolves it into the
   *  subdirectory, 404s into the fail-open catch, and the session never gets a floor
   *  (build-demo's main.js is the reference). */
  swUrl?: string;
  /** the offline manifest the worker precaches — default "./despia/local.json",
   *  the SAME dialect (and, for apps, the same FILE) the native seeds read. Resolved
   *  by the WORKER against its own root-level location — page depth never applies. */
  manifestUrl?: string;
};

/** Register the offline floor. Safe to call unconditionally: without serviceWorker
 *  support (or on an insecure origin) it seeds the source facts and returns — the app
 *  behaves exactly as before (fail-open). */
export async function registerOfflineFloor(opts: OfflineFloorOptions = {}): Promise<void> {
  seedSource();
  const key = window.location.host.toLowerCase();
  trackSource("web", key);

  if (!("serviceWorker" in window.navigator)) return;
  const sw = window.navigator.serviceWorker;

  // The current document: no controller = this load came from the network (a first visit,
  // or a hard reload) — the origin answered. A controlled load is classified by the
  // worker's own provenance message (below), which knows cache-vs-network per response.
  let lastServing = "origin";
  if (sw.controller === null) publishSource("web", "origin", true, key);

  sw.addEventListener("message", (event: MessageEvent) => {
    const d = event.data as Record<string, unknown> | null;
    if (d === null || typeof d !== "object") return;
    if (d["dsx"] === "source" && typeof d["serving"] === "string") {
      lastServing = d["serving"];
      publishSource("web", lastServing, d["fresh"] === true, key);
    } else if (d["dsx"] === "content.updated") {
      // A fresh generation is precached and WAITING (served on the next visit — the
      // store's promote-at-the-boundary law). Ring the kernel bell + mark the slice —
      // KEEPING the slice's serving truthful (the bell must not rewrite what served
      // this document; the manifest fetch succeeding proves the origin answered).
      ModuleRegistry.foldDelegate("content.updated", { generation: d["generation"] ?? "" }, "void");
      publishSource("web", lastServing, true, key, { update: d["generation"] ?? "" });
    }
  });

  const manifest = opts.manifestUrl ?? "./despia/local.json";
  const swUrl = `${opts.swUrl ?? "./dsx-sw.js"}?manifest=${encodeURIComponent(manifest)}`;
  try {
    // updateViaCache:"none" — the WORKER SCRIPT never rides the HTTP cache (the classic
    // stuck-service-worker failure). Then RENEWAL-WHILE-ONLINE, three triggers: the
    // browser's own update check on registration, an explicit update() + revalidate ping
    // right after registration, and the same pair on every `online` event — so a
    // long-lived SPA session (no full navigations) still picks up new deploys; the bell
    // (`content.updated`) tells the page when one is waiting.
    const reg = await sw.register(swUrl, { updateViaCache: "none" });
    const renew = (): void => {
      void reg.update().catch(() => { /* offline / transient — the next trigger retries */ });
      reg.active?.postMessage({ dsx: "revalidate" });
    };
    renew();
    window.addEventListener("online", renew);
  } catch { /* insecure context / dev server without the file — fail open */ }
}
