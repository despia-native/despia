//
//  serve.ts - a dependency-free static server over OpenSource/Web (dev/demo/CI).
//  Usage: node packages/compiler/bin/serve.ts [port]     → http://localhost:8787/demo/site/
//

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, resolve, normalize } from "node:path";
import { existsSync } from "node:fs";

function webRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return join(dir, "OpenSource/Web");
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const MIME: { [ext: string]: string } = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

/** This executable is the local demo/CI server, so every successful response must
 * be revalidated from disk. Without an explicit policy browsers may reuse stale
 * registry/package modules after a rebuild, producing a DOM from an older atomic
 * build even though the files on disk are current. Keep all 200 paths (ordinary
 * files, generated fragments, and the SPA fallback) behind this one helper. */
export function devResponseHeaders(
  contentType: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...extra, "content-type": contentType, "cache-control": "no-store" };
}

export function startServer(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const root = webRoot();
  const server = createServer((req, res) => {
    void (async () => {
      let path = "/";
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        path = normalize(decodeURIComponent(url.pathname));
        if (path.endsWith("/")) path += "index.html";
        const full = join(root, path);
        if (!full.startsWith(root)) { res.writeHead(403).end(); return; }
        // /embed assets carry the package's CORS allowlist (/web/13: origins declared
        // in dsx.json web.embed.origins — [] means same-origin only, no header)
        const cors = path.includes("/embed/") ? await corsHeaders(root, path, req.headers.origin) : {};
        // the DSD fragment ENDPOINT: /embed/<scheme>/<Name>.html?attr=… re-renders
        // with the query as attributes (kebab-case, JSON text for rich values)
        if (path.includes("/embed/") && path.endsWith(".html") && url.search.length > 1) {
          const fragment = await dynamicFragment(root, path, url.searchParams);
          if (fragment !== null) {
            res.writeHead(200, devResponseHeaders(MIME[".html"]!, cors));
            res.end(fragment);
            return;
          }
        }
        const body = await readFile(full);
        res.writeHead(200, devResponseHeaders(MIME[extname(full)] ?? "application/octet-stream", cors));
        res.end(body);
      } catch {
        // Directory redirect first — production static-host parity: the per-route
        // SSR export writes <path>/index.html, and a deep link like /demo/site/flex
        // must land on THAT page at its canonical trailing-slash URL so the page's
        // RELATIVE importmap/main.js references resolve (the adopt-hydration boot
        // rides it, W6). Only a route with no export falls back to the SPA shell.
        if (extname(path) === "" && path.startsWith("/demo/site/")) {
          if (existsSync(join(root, path, "index.html"))) {
            res.writeHead(301, { location: `${path}/` }).end();
            return;
          }
          // SPA fallback: extensionless misses under the demo serve the demo page
          // (deep links like /demo/site/user/321 cold-load — /web/04)
          try {
            const body = await readFile(join(root, "demo/site/index.html"));
            res.writeHead(200, devResponseHeaders(MIME[".html"]!));
            res.end(body);
            return;
          } catch { /* fall through */ }
        }
        res.writeHead(404).end("not found");
      }
    })();
  });
  return new Promise((resolvePromise) => {
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolvePromise({
        port: boundPort,
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
          // Browser service workers can retain an accepted keep-alive connection
          // for a minute after the last request. This server is test/dev-only;
          // close those connections after stopping accepts so shutdown is bounded.
          server.closeAllConnections();
        }),
      });
    });
  });
}

type EmbedManifest = { [key: string]: { tag: string; origins: string[]; hash: string } };

/** The embed CORS decision (/web/13: `web.embed.origins` is a package's per-embed allowlist).
 *  THREE branches, fail-CLOSED by omission:
 *   - `["*"]` echoes `access-control-allow-origin: *` — the public embed (default `[]` = OFF).
 *   - an EXACT origin match echoes THAT origin + `vary: origin` (so a shared cache keys on it).
 *   - anything else — a foreign origin, OR no `Origin` header at all against a non-`*` list —
 *     gets NO header, and the browser then blocks the cross-origin read.
 *  Pure over (declared origins, request Origin), so all three branches are gated directly by
 *  the corpus fixtures/cors-embed-cases.json without a built manifest on disk. This is web-only
 *  embed-server infrastructure (no native twin — the tri-renderer law's SSR/bundling exemption),
 *  so the corpus is web-local rather than under OpenSource/Conformance. */
export function corsDecision(origins: readonly string[], requestOrigin: string | undefined): Record<string, string> {
  if (origins.includes("*")) return { "access-control-allow-origin": "*" };
  if (requestOrigin !== undefined && origins.includes(requestOrigin)) {
    return { "access-control-allow-origin": requestOrigin, vary: "origin" };
  }
  return {};
}

/** the CORS allowlist for one /embed asset — read from the build's manifest.json */
async function corsHeaders(root: string, path: string, requestOrigin: string | undefined): Promise<{ [h: string]: string }> {
  const m = /\/embed\/([^/]+)\/([^/.]+)\./.exec(path);
  if (m === null) return {};
  try {
    const manifest = JSON.parse(await readFile(join(root, "demo/site/embed/manifest.json"), "utf8")) as EmbedManifest;
    const entry = manifest[`${m[1]}/${m[2]}`];
    if (entry === undefined) return {};
    return corsDecision(entry.origins, requestOrigin);
  } catch { return {}; }
}

/** GET /embed/<scheme>/<Name>.html?attr=… → a fresh DSD fragment with the query as
 *  attributes (scenario 2 of /web/13: a third-party server inlines the response). */
async function dynamicFragment(root: string, path: string, params: URLSearchParams): Promise<string | null> {
  const m = /\/embed\/([^/]+)\/([^/.]+)\.html$/.exec(path);
  if (m === null) return null;
  try {
    const [{ renderEmbedFragmentAsync }, { sliceRegistry }, theme, cssmap] = await Promise.all([
      import("@despia-native/server"), import("../src/expose.ts"), import("@despia-native/dom/theme"), import("../src/cssmap.ts"),
    ]);
    const site = join(root, "demo/site");
    const registry = JSON.parse(await readFile(join(site, "registry.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(site, "embed/manifest.json"), "utf8")) as EmbedManifest;
    const entry = manifest[`${m[1]}/${m[2]}`];
    if (entry === undefined) return null;
    const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => String(c).toUpperCase());
    const attrs: { [k: string]: unknown } = {};
    for (const [k, v] of params.entries()) {
      const t = v.trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        try { attrs[camel(k)] = JSON.parse(t); continue; } catch { /* string */ }
      }
      attrs[camel(k)] = v;
    }
    const qualified = `${m[1]}.${m[2]}`;
    const slice = sliceRegistry(registry, qualified);
    const [globals, nativeControls, overlayControls, dataControls] = await Promise.all([
      import("@despia-native/dom/globals"), import("@despia-native/dom/native-controls"),
      import("@despia-native/dom/overlay-controls"), import("@despia-native/dom/data-controls"),
    ]);
    const css = [
      cssmap.LAYER_STATEMENT, theme.TOKENS_CSS, theme.APPLICATION_ELEMENTS_CSS, theme.ELEMENTS_CSS,
      theme.CONTROL_ELEMENTS_CSS, theme.RICH_ELEMENTS_CSS,
      theme.STRUCTURAL_CONTROLS_CSS,
      nativeControls.NATIVE_CONTROLS_CSS,
      overlayControls.OVERLAY_CONTROLS_CSS,
      dataControls.DATA_CONTROLS_CSS,
      globals.GLOBAL_ELEMENTS_CSS, slice.css,
    ].join("\n");
    // the LIVE per-request fragment endpoint executes ssr-eligible <api> blocks (W6):
    // the inlined fragment shows real data on first paint and the embed adopts it.
    return await renderEmbedFragmentAsync(slice, qualified, entry.tag, css, attrs);
  } catch { return null; }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const port = parseInt(process.argv[2] ?? "8787", 10);
  void startServer(port).then(({ port: p }) => {
    console.log(`serving OpenSource/Web at http://localhost:${p}/  (demo: /demo/site/)`);
  });
}
