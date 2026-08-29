//
//  live.ts - the per-request LIVE SSR adapter (doc 02 "The server runtime"; the "open
//  adapters seam" named in static.ts). exportStatic covers concrete routes at build time
//  and skips anything dynamic; this closes the other half: a fetch-shaped handler that
//  matches a GET/HEAD against the registry route table PER REQUEST — dynamic
//  (`:id`/`{id}`/`*`) patterns included — and serves `renderPageAsync`'s document, so
//  ssr-eligible `<api>` blocks execute during render and the client boot adopts the DOM
//  and skips the initial fetch (adopt.ts + api.ts, unchanged).
//
//  Semantics, mirroring the client FrameRouter (doc 04) wherever the server can:
//    · FIRST MATCH WINS in table order (the client's resolution order).
//    · vars = { ...params, ...query } — byte-for-byte the routed-push seed
//      (router.ts fromUrl: `{ ...m.params, ...query }`), so hydration adopts cleanly.
//    · `redirect` entries answer a REAL 302 (the static export's meta-refresh page is
//      the no-server fallback; a live server owes the honest status code).
//    · `requires` (the capability gate): a route naming an unshipped scheme resolves to
//      notFound, exactly like the client's resolution.
//    · `guard` is NOT evaluated here — it is a bounded JSE predicate over the CLIENT's
//      `global.*` state, which has no server twin; the page serves and the hydrated
//      client applies the guard's redirect (SSR stays a pure, fail-open optimization).
//    · unmatched: the `notFound` component renders as a REAL 404; with none declared the
//      handler returns null so the caller falls through (static assets, other handlers).
//    · an SSR render failure answers 500 — full diagnostics only when `dev` is set,
//      opaque otherwise (doc 02's failure semantics).
//
//  Edge-compatible on purpose: web Request/Response only, no Node built-ins — the same
//  handler serves node:http (bootloader-node), Deno/edge (bootloader-deno), Bun, or a
//  Worker directly.
//

import { DSXPathMatch, type Dict } from "@despia/kernel";
import type { Registry } from "@despia/compiler/resolve";
import {
  assertSafeRedirectTarget,
  assertSafeRouteTable,
  rebaseShellForDepth,
  renderPageAsync,
  shellDepthForRequestPath,
  type ShellOptions,
} from "./page-render.ts";
import { renderPageStream } from "./stream.ts";

export type PageHandlerOptions = ShellOptions & {
  /** per-render budget for ssr-eligible `<api>` fetches (renderPageAsync's ssrTimeoutMs) */
  ssrTimeoutMs?: number;
  /** Cache-Control for successful page responses (default "no-store" — a live page is
   *  dynamic until a route-level cache vocabulary lands; doc 02's `<render cache=>` seam) */
  cacheControl?: string;
  /** dev diagnostics on a render failure (prod stays opaque) */
  dev?: boolean;
  /** doc 02 out-of-order streaming: serve 200 GET pages as a STREAMED response —
   *  `defer` blocks flush their seeds as late chunks (stream.ts). Redirects, 404s, HEAD,
   *  and error pages keep the buffered path (they have nothing to stream). */
  stream?: boolean;
};

/** A fetch-shaped page server over the registry's route table. Returns null for anything
 *  that is not a page request (non-GET/HEAD, or unmatched with no notFound), so hosts can
 *  chain it in front of static assets / API handlers. */
export function createPageHandler(
  registry: Registry,
  callerOpts: PageHandlerOptions = {},
): (req: Request) => Promise<Response | null> {
  // The build BAKES the document shell into registry.json (compiler Registry.shell,
  // wave-7 F1), so a host built from the registry alone serves live-SSR'd documents
  // that still load the client boot. Explicit caller options win PER KEY; a caller
  // key explicitly set to undefined does not erase the baked value.
  const opts: PageHandlerOptions = { ...(registry.shell ?? {}) };
  for (const [key, value] of Object.entries(callerOpts)) {
    if (value !== undefined) (opts as Record<string, unknown>)[key] = value;
  }
  const routes = registry.routes ?? [];
  // The static exporter's preflight, once at creation: a bad table must fail the boot,
  // not the Nth request.
  assertSafeRouteTable(routes.map((route) => route.path));
  for (const route of routes) {
    if (route.redirect !== undefined) assertSafeRedirectTarget(route.redirect);
  }
  const cacheControl = opts.cacheControl ?? "no-store";
  const schemes = new Set(registry.schemes);

  async function page(component: string, vars: Dict, meta: { title?: string; description?: string },
                      status: number, head: boolean, pathname: string): Promise<Response> {
    // the served URL decides how the browser resolves ./-relative shell references,
    // so the shell is rebased per request (rebaseShellForDepth)
    const shell = rebaseShellForDepth(opts, shellDepthForRequestPath(pathname));
    if (opts.stream === true && status === 200 && !head) {
      return new Response(renderPageStream(registry, component, vars, meta, shell), {
        status,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": cacheControl },
      });
    }
    const html = await renderPageAsync(registry, component, vars, meta, shell);
    return new Response(head ? null : html, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": cacheControl },
    });
  }

  return async function handle(req: Request): Promise<Response | null> {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    const head = method === "HEAD";
    const url = new URL(req.url);
    const query: Dict = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    const notFound = async (): Promise<Response | null> =>
      registry.notFound === undefined ? null : page(registry.notFound, {}, {}, 404, head, url.pathname);

    try {
      for (const route of routes) {
        const params = DSXPathMatch.match(url.pathname, route.path);
        if (params === null) continue;
        if (route.redirect !== undefined) {
          return new Response(null, { status: 302, headers: { location: route.redirect } });
        }
        if (route.component === undefined) continue;
        if (route.requires !== undefined && !route.requires.every((s) => schemes.has(s))) {
          return await notFound();
        }
        return await page(route.component, { ...params, ...query }, route.meta ?? {}, 200, head, url.pathname);
      }
      return await notFound();
    } catch (e) {
      const body = opts.dev === true
        ? `SSR render failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
        : "Internal Server Error";
      return new Response(head ? null : body, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
  };
}
