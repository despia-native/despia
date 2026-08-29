//
//  site-workers.ts — A1's SITE face, Workers-shaped (v0-live-plan W1). The chain is the same
//  one site-node.ts documents — static file → page handler → (caller's API host) — with the
//  filesystem half swapped for the platform's own: Workers Static Assets serves the built
//  `dsx build` output through the `ASSETS` binding, so this file never touches a path from
//  the wire (the [S-BOUNDARY] traversal work in site-node.ts is the platform's job here —
//  the binding can only ever answer from the uploaded asset directory).
//
//  The page handler stays the shared, platform-free `createPageHandler` (live.ts): dynamic
//  patterns, redirects and the declared notFound behave identically under node and workerd,
//  which is the W1 parity claim this file exists to keep small enough to believe.
//

import type { Registry } from "@despia-native/compiler/resolve";
import { createPageHandler, type PageHandlerOptions } from "./live.ts";

/** The Workers Static Assets binding, structurally — this workspace carries no platform types. */
export interface WorkersAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export type WorkersSiteOptions = PageHandlerOptions;

/**
 * A fetch-shaped handler over a deployed site. Returns null for anything it does not own —
 * a non-GET/HEAD method, no uploaded asset, and no matching page route — so the caller chains
 * it in FRONT of the API host (host.handle always returns a Response and can never signal
 * "not mine"; see the ordering note in site-node.ts).
 */
export function createWorkersSiteHandler(
  assets: WorkersAssetsBinding | null,
  registry: Registry,
  opts: WorkersSiteOptions = {},
): (req: Request) => Promise<Response | null> {
  // Built at creation, once — a bad route table fails the boot, not the Nth request
  // (assertSafeRouteTable runs inside createPageHandler).
  const page = createPageHandler(registry, opts);

  return async function handle(req: Request): Promise<Response | null> {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    if (assets !== null) {
      // The binding answers 404 for a path with no uploaded file (wrangler config
      // `not_found_handling` stays at its default for API coexistence — the worker, not the
      // platform, decides what a miss means). Anything else — 200, a 304 revalidation, the
      // platform's own redirect for html_handling — is the asset answer, verbatim.
      const served = await assets.fetch(req);
      if (served.status !== 404) return served;
      // A miss body still holds a stream; cancel it so the platform is not left buffering.
      if (served.body !== null) await served.body.cancel();
    }
    // No file: the route table decides — dynamic patterns, redirects (real 302s) and the
    // declared notFound all live in the page handler, which returns null when it owns nothing.
    return page(req);
  };
}
