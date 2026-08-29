//
//  dsx-sw.js — the Despia Web BUNDLED FLOOR: the browser twin of the native content
//  store's seed generations (bundled-floor.md), as a dependency-free classic service
//  worker. The page half (registration + provenance publishing into `dsx.source.*`) is
//  @despia-native/dom/offline — this file speaks only the wire: caches + postMessage.
//
//  THE MODEL, 1:1 with the kernel store:
//  • The offline manifest (?manifest=…, default /despia/local.json — the SAME dialect the
//    native seeds use: { entry, assets:[{path, sha256}] }) defines ONE GENERATION; the
//    cache name is the hash of the manifest bytes — same manifest IS same generation.
//  • Install is ALL-OR-NOTHING: every asset fetched and (when a sha256 is declared)
//    VERIFIED before the generation exists; any failure abandons the partial cache and
//    the old generation keeps serving. A torn generation cannot exist.
//  • Serving is stale-while-revalidate at generation granularity: assets are cache-first
//    (sha-pinned = immutable, the CAS rule); navigations go network-first (the origin is
//    the truth when reachable) and fall back to the cached entry offline. After a served
//    navigation the manifest revalidates in the BACKGROUND; a changed manifest precaches
//    the NEW generation and rings the page (`content.updated`) — it serves on the NEXT
//    visit, never swapped under the running page (the visit-pins-a-generation law).
//  • Every navigation response tells the page what served ({dsx:"source", serving:
//    "origin"|"cache", fresh}) — the provenance plane's web feed.
//
/* eslint-disable no-restricted-globals */

"use strict";

const MANIFEST_URL = new URL(self.location.href).searchParams.get("manifest") || "/despia/local.json";
const META_CACHE = "dsx-meta";
const CURRENT_KEY = "/__dsx_current__";
const PENDING_KEY = "/__dsx_pending__";
const MANIFEST_KEY = "/__dsx_manifest__";
const GEN_PREFIX = "dsx-gen-";

// ── tiny twins of the page-side pure helpers (a classic worker cannot import) ───────────

function normalizeManifest(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = raw.assets || raw.files || raw.bundles;
  if (!Array.isArray(list)) return null;
  const assets = [];
  for (const item of list) {
    let path = "";
    let sha;
    if (typeof item === "string") path = item;
    else if (item && typeof item === "object") {
      if (typeof item.path === "string") path = item.path;
      if (typeof item.sha256 === "string" && item.sha256) sha = item.sha256;
    }
    path = path.trim();
    if (path.indexOf("./") === 0) path = path.substring(2);
    while (path.indexOf("/") === 0) path = path.substring(1);
    if (!path || path.indexOf("://") >= 0) continue;
    if (path.split("/").indexOf("..") >= 0) continue;
    assets.push({ path, sha256: sha });
  }
  if (assets.length === 0) return null;
  // declared dynamic-route skeleton pages ({ pattern, page } — the offline.ts twin)
  const routes = [];
  if (Array.isArray(raw.routes)) {
    for (const item of raw.routes) {
      if (!item || typeof item !== "object") continue;
      const pattern = typeof item.pattern === "string" ? item.pattern.trim() : "";
      let page = typeof item.page === "string" ? item.page.trim() : "";
      while (page.indexOf("/") === 0) page = page.substring(1);
      if (!pattern || !page || page.indexOf("://") >= 0) continue;
      if (page.split("/").indexOf("..") >= 0) continue;
      routes.push({ pattern, page });
    }
  }
  return {
    entry: typeof raw.entry === "string" && raw.entry ? raw.entry : "index.html",
    nav: raw.nav === "swr" ? "swr" : "network-first",
    assets,
    routes,
  };
}

// Pattern matcher — the DSXPathMatch/offline.ts twin (literal · :name/{name} · trailing *).
function matchRoute(pathname, pattern) {
  const seg = (s) => s.split("/").filter((x) => x.length > 0);
  const pat = (pattern || "").trim();
  if (pat === "*" || pat === "/*" || !pat) return {};
  const ps = seg(pathname);
  const pats = seg(pat);
  const params = {};
  for (let i = 0; i < pats.length; i += 1) {
    const s = pats[i];
    if (s === "*") {
      if (i === pats.length - 1) return params;
      if (i >= ps.length) return null;
      continue;
    }
    if (i >= ps.length) return null;
    if (s.length >= 2 && s.charAt(0) === "{" && s.charAt(s.length - 1) === "}") params[s.substring(1, s.length - 1)] = ps[i];
    else if (s.charAt(0) === ":") params[s.substring(1)] = ps[i];
    else if (s !== ps[i]) return null;
  }
  return ps.length === pats.length ? params : null;
}

// The cached-page candidates for a navigation (the static-export convention — the
// offline.ts twin): "/" → index.html, "/gallery" → gallery/index.html, gallery.html,
// then the SPA entry. A per-route SSR page beats the shell: per-route offline first
// paint with the route's own markup + meta.
function navCandidates(pathname, entry) {
  let p = (pathname || "").trim();
  while (p.indexOf("/") === 0) p = p.substring(1);
  while (p.length > 0 && p.lastIndexOf("/") === p.length - 1) p = p.substring(0, p.length - 1);
  const out = [];
  if (p.length === 0) out.push("index.html");
  else { out.push(p + "/index.html"); out.push(p + ".html"); }
  if (out.indexOf(entry) < 0) out.push(entry);
  return out;
}

function hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256(buffer) { return hex(await crypto.subtle.digest("SHA-256", buffer)); }

function generationName(digestHex) { return GEN_PREFIX + digestHex.substring(0, 16); }

// SITE-ROOT-relative: manifest asset paths are authored against the export ROOT (the
// emitter walks it) and this worker is served from that root — resolving against the
// MANIFEST's directory (/despia/) would point every install fetch and cache key at
// files that don't exist there, and the floor could never install.
function assetURL(path) { return new URL(path, self.location.href).href; }

// ── generation bookkeeping (the `current` pointer lives in a meta cache) ────────────────

// Per-worker-instance memos (a restart just re-derives): the meta cache handle, the
// current generation's cache handle, and its parsed manifest. The manifest memo is keyed
// by GENERATION NAME — the name IS the manifest hash, so same name = same bytes and a
// pointer flip invalidates by key mismatch; dropMemos() covers the mutation sites.
let metaCachePromise = null;
function metaCache() {
  if (!metaCachePromise) metaCachePromise = caches.open(META_CACHE);
  return metaCachePromise;
}
let genCache = null;       // { name, promise }
function openGeneration(name) {
  if (!genCache || genCache.name !== name) genCache = { name, promise: caches.open(name) };
  return genCache.promise;
}
let manifestMemo = null;   // { name, manifest }
function dropMemos() { genCache = null; manifestMemo = null; }

async function metaGet(key) {
  const meta = await metaCache();
  const hit = await meta.match(key);
  return hit ? (await hit.text()) : null;
}

async function metaSet(key, value) {
  const meta = await metaCache();
  if (value === null) { await meta.delete(key); return; }
  await meta.put(key, new Response(value));
}

function currentGeneration() { return metaGet(CURRENT_KEY); }

/** Promote a PENDING generation to current — called ONLY at a document boundary (the
 *  start of a navigation): a running page never has the generation swapped under it
 *  (the store's visit-pins-a-generation law); the NEXT visit gets the new one. */
async function promotePending() {
  const pending = await metaGet(PENDING_KEY);
  if (!pending) return;
  const current = await currentGeneration();
  if (pending !== current && (await caches.has(pending))) {
    await metaSet(CURRENT_KEY, pending);
    // The superseded generation dies HERE — activate's sweep runs only when the WORKER
    // SCRIPT changes, which a routine content deploy never does; without this delete,
    // every deploy would orphan one full-site cache until origin-quota eviction (which
    // can take the live floor with it).
    if (current) await caches.delete(current);
    dropMemos();
  }
  await metaSet(PENDING_KEY, null);
}

/** Fetch the manifest and, when it names a NEW generation, precache it whole —
 *  all-or-nothing. The new generation NEVER flips `current` mid-session: with no
 *  current it becomes current (first install); otherwise it lands as PENDING and
 *  promotes at the next document boundary. Returns { name, updated } or null
 *  (manifest unreachable/unusable: keep whatever serves — never regress the floor). */
async function precacheGeneration() {
  let bytes;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) return null;
    bytes = await res.arrayBuffer();
  } catch (e) { return null; }
  let manifest;
  try { manifest = normalizeManifest(JSON.parse(new TextDecoder().decode(bytes))); } catch (e) { return null; }
  if (!manifest) return null;

  const name = generationName(await sha256(bytes));
  const current = await currentGeneration();
  if (name === current) {
    // The origin re-named the CURRENT generation: any parked PENDING is a WITHDRAWN
    // deploy (rollback) — clear it, or the next boundary would promote a generation
    // the origin no longer serves and then flap back with a spurious update bell.
    const pending = await metaGet(PENDING_KEY);
    if (pending && pending !== name) { await metaSet(PENDING_KEY, null); await caches.delete(pending); dropMemos(); }
    return { name, updated: false };
  }

  if (!(await caches.has(name))) {   // not yet precached — download all-or-nothing
    const cache = await caches.open(name);
    try {
      for (const asset of manifest.assets) {
        const res = await fetch(assetURL(asset.path), { cache: "no-cache" });
        if (!res.ok) throw new Error("fetch " + asset.path + " -> " + res.status);
        if (asset.sha256) {
          const body = await res.clone().arrayBuffer();
          const digest = await sha256(body);
          if (digest !== asset.sha256.toLowerCase()) throw new Error("sha mismatch " + asset.path);
        }
        await cache.put(assetURL(asset.path), res);
      }
      await cache.put(MANIFEST_KEY, new Response(bytes, { headers: { "content-type": "application/json" } }));
    } catch (e) {
      await caches.delete(name);   // all-or-nothing: a partial generation never exists
      dropMemos();
      return null;
    }
  }
  // ONE adoption for both arms (already-precached and freshly-downloaded): the first
  // install becomes current; otherwise the generation PARKS as pending for the next
  // document boundary (the visit-pins-a-generation law).
  if (current) { await metaSet(PENDING_KEY, name); } else { await metaSet(CURRENT_KEY, name); dropMemos(); }
  return { name, updated: current !== null };
}

/** The CURRENT generation's parsed manifest (entry + nav mode), or null. Memoized by
 *  generation name — a navigation reads this several times (strategy, exact page,
 *  floor), and the bytes behind a name are immutable (the name IS the manifest hash). */
async function currentManifest() {
  const name = await currentGeneration();
  if (!name) return null;
  if (manifestMemo && manifestMemo.name === name) return manifestMemo.manifest;
  const cache = await openGeneration(name);
  const stored = await cache.match(MANIFEST_KEY);
  if (!stored) return null;
  try {
    const m = normalizeManifest(JSON.parse(await stored.text()));
    manifestMemo = { name, manifest: m };
    return m;
  } catch (e) { return null; }
}

/** The route's own FULL cached page (path/index.html · path.html) — the only pages the
 *  ONLINE swr fast path may serve. Skeletons and the shell are NOT full pages. */
async function exactCachedPage(pathname) {
  const name = await currentGeneration();
  if (!name) return null;
  const cache = await openGeneration(name);
  const m = await currentManifest();
  const entry = (m && m.entry) || "index.html";
  for (const candidate of navCandidates(pathname, entry)) {
    if (candidate === entry) break;
    const hit = await cache.match(assetURL(candidate));
    if (hit) return hit;
  }
  return null;
}

/** The best cached page for an OFFLINE navigation: the route's own SSR export, then a
 *  DECLARED dynamic pattern's skeleton (/user/321 → the /user/:id export; most-specific
 *  wins), then the SPA entry. SKELETONS ARE OFFLINE-ONLY BY LAW (bundled-floor.md §2d):
 *  online, a dynamic page must reach the origin — the server (live SSR, W6) is the only
 *  thing that can render its DATA; serving a skeleton online would degrade correctness
 *  and SEO. This function is called ONLY from the network-failure path. */
async function cachedNavigationResponse(pathname) {
  const exact = await exactCachedPage(pathname);
  if (exact) return exact;
  const name = await currentGeneration();
  if (!name) return null;
  const cache = await openGeneration(name);
  const m = await currentManifest();
  const entry = (m && m.entry) || "index.html";
  if (m && m.routes && m.routes.length > 0) {
    let best = null;
    for (const r of m.routes) {
      const params = matchRoute(pathname, r.pattern);
      if (params === null) continue;
      const score = 1000 - Object.keys(params).length;
      if (best === null || score > best.score) best = { page: r.page, score };
    }
    if (best) {
      const hit = await cache.match(assetURL(best.page));
      if (hit) return hit;
    }
  }
  return cache.match(assetURL(entry));
}

async function tellClient(id, message) {
  const client = id ? await self.clients.get(id) : null;
  if (client) { client.postMessage(message); return; }
  for (const c of await self.clients.matchAll()) c.postMessage(message);
}

/** Background SWR pass: precache a changed manifest's generation (as PENDING — promoted
 *  at the next document boundary), ring the bell once. Throttled to one manifest
 *  round-trip per minute — serving only changes at the next boundary anyway, and every
 *  served navigation calls this (a per-page-view fetch is pure origin load); a worker
 *  restart resets the clock toward MORE revalidation, never less. */
let lastRevalidateAt = 0;
async function revalidate(clientId) {
  const now = Date.now();
  if (now - lastRevalidateAt < 60000) return;
  lastRevalidateAt = now;
  const result = await precacheGeneration();
  if (result && result.updated) {
    await tellClient(clientId, { dsx: "content.updated", generation: result.name });
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(precacheGeneration().then(() => self.skipWaiting()));
});

// The page can force a renewal pass — sent by @despia-native/dom/offline on `online` events and
// after registration, so a LONG-LIVED SPA SESSION (no full navigations, the only other
// revalidation trigger) still renews while online. Aggressive-SW antidote #2; #1 is
// updateViaCache:"none" + registration.update() on the page half (the WORKER SCRIPT
// itself never rides the HTTP cache), #3 is that this worker never runtime-caches API
// responses at all — only manifest-listed assets exist in a generation, so "stale API
// data stuck in the SW" cannot happen by construction.
self.addEventListener("message", (event) => {
  const d = event.data;
  if (d && typeof d === "object" && d.dsx === "revalidate") {
    event.waitUntil(revalidate(null));
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Navigation preload: the browser starts the network fetch WHILE this worker boots —
    // network-first navigations stop paying the SW-startup tax. Under a DECLARED `swr`
    // strategy the preload would race a fetch we discard (the cache serves) — keep it off
    // there; the mode is re-evaluated on every activation (a deploy can change it).
    if (self.registration.navigationPreload) {
      try {
        const m = await currentManifest();
        if (m && m.nav === "swr") await self.registration.navigationPreload.disable();
        else await self.registration.navigationPreload.enable();
      } catch (e) { /* unsupported */ }
    }
    const keepCurrent = await currentGeneration();
    const keepPending = await metaGet(PENDING_KEY);
    for (const name of await caches.keys()) {
      if (name.indexOf(GEN_PREFIX) === 0 && name !== keepCurrent && name !== keepPending) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      // A navigation IS the document boundary: a pending (background-precached)
      // generation promotes NOW — this visit gets the new one; the previous page was
      // never swapped mid-session (the store's visit-pins-a-generation law).
      await promotePending();
      // The DECLARED navigation strategy (manifest `nav`, bundled-floor.md §2c):
      //   swr           — the precached SSR page serves INSTANTLY (repeat visits paint at
      //                   cache speed, online and offline alike); the manifest revalidates
      //                   behind it and a new generation rings `content.updated`.
      //   network-first — the origin is the truth when reachable (default); the cached
      //                   route page (else the entry) is the offline floor. Navigation
      //                   preload keeps the network path from paying SW startup.
      const m = await currentManifest();
      if (m && m.nav === "swr") {
        // swr serves FULL cached pages only (a static route's own SSR export). A dynamic
        // route's skeleton is never an online answer — it has no data; fall through to
        // the network so the origin (live SSR) renders it. Offline still gets the
        // skeleton via the catch path below.
        const cached = await exactCachedPage(url.pathname);
        if (cached) {
          event.waitUntil(revalidate(event.resultingClientId));
          event.waitUntil(tellClient(event.resultingClientId, { dsx: "source", serving: "cache", fresh: false }));
          return cached;
        }
      }
      try {
        const net = (await event.preloadResponse) || (await fetch(req));
        event.waitUntil(revalidate(event.resultingClientId));
        event.waitUntil(tellClient(event.resultingClientId, { dsx: "source", serving: "origin", fresh: true }));
        return net;
      } catch (e) {
        const floor = await cachedNavigationResponse(url.pathname);
        if (floor) {
          event.waitUntil(tellClient(event.resultingClientId, { dsx: "source", serving: "cache", fresh: false }));
          return floor;
        }
        throw e;   // nothing cached, nothing bundled-by-visit: the browser's own error is the honest state
      }
    })());
    return;
  }

  // Assets: cache-first against the CURRENT generation (sha-pinned = immutable, the CAS
  // rule); a miss passes through to the network untouched (no unbounded runtime caching —
  // the manifest is the budget).
  event.respondWith((async () => {
    const name = await currentGeneration();
    if (name) {
      const hit = await (await openGeneration(name)).match(req.url);
      if (hit) return hit;
    }
    return fetch(req);
  })());
});
