//
//  site-node.ts — A1, the production SITE face of the server (v4-launch execution-plan A1).
//
//  WHAT WAS MISSING. `createPageHandler` (live.ts) and `renderPageStream` (stream.ts) were
//  written, tested, and CALLED BY NOTHING: both bootloaders dispatch API routes only, and the
//  only static serving in the repo lived in dev tooling (compiler/bin/serve.ts, cli/src/dev.ts).
//  So a built DSX site had no production host at all — `dsx build` output was a directory you
//  hosted elsewhere, and every dynamic route (`/x/:id`), which `exportStatic` deliberately skips,
//  had no server-rendered path anywhere. This file is that host.
//
//  THE CHAIN, and why this order. For GET/HEAD:  static file → page handler → (caller's host).
//    · A static hit is the cheapest and the most specific — a real file always wins.
//    · The page handler answers the route table, INCLUDING dynamic patterns, and returns null
//      when nothing matches and no `notFound` is declared, which is what lets it be chained.
//    · The API host must stay LAST because `host.handle` always returns a Response (a 404 for an
//      unmatched route) — it can never signal "not mine", so anything after it is unreachable.
//  API paths (`/health`, `/notes`, …) exist as neither a file nor a page route, so they fall
//  through this whole chain untouched. Non-GET/HEAD skips it entirely.
//
//  [S-BOUNDARY] STATIC SERVING IS THE SECURITY-SENSITIVE HALF. A path from the wire that reaches
//  the filesystem is a traversal vector, so `resolveWithin` below is written to be read: decode
//  once (a second decode is how `%252e%252e` gets through), reject NUL and any `..`/absolute/UNC
//  segment BEFORE touching disk, then require that the resolved path is still inside the root —
//  the containment check is the one that holds even if the parsing above is wrong. `static.ts`
//  hardens ROUTE paths through the same reasoning (assertSafeRouteTable); this is its filesystem
//  twin, deliberately not a second, different policy.
//

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import type { Registry } from "@despia/compiler/resolve";
import { createPageHandler, type PageHandlerOptions } from "./live.ts";

/** Content types for what a DSX build actually emits. Unknown ⇒ octet-stream (never guessed). */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/** A build-hashed asset name — `main.a1b2c3d4.js`, the shape build-demo/dsx build emit. Only
 *  these may be cached immutably: an unhashed name can change under the same URL. */
const HASHED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

export function cacheControlFor(path: string): string {
  return HASHED.test(path) ? "public, max-age=31536000, immutable" : "no-store";
}

/**
 * [S-BOUNDARY] Resolve a URL pathname to a file inside `root`, or null if it escapes.
 *
 * Returns null rather than throwing: a traversal attempt is not an error condition to report to
 * the caller, it is simply "no such asset" — the same answer a missing file gets, so probing
 * cannot distinguish "blocked" from "absent".
 */
export function resolveWithin(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    // ONCE. Decoding twice is precisely how `%252e%252e/` becomes `../` after the checks below.
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding is not a path
  }
  if (decoded.includes("\0")) return null;
  // Normalise separators before segment inspection so a Windows-style `..\` cannot slip past a
  // check that only understands `/`.
  const parts = decoded.replace(/\\/g, "/").split("/");
  for (const part of parts) {
    if (part === "..") return null; // no traversal segment, at any depth
    if (/^[A-Za-z]:$/.test(part)) return null; // drive letter (absolute on Windows)
  }
  const rootAbs = resolve(root);
  const candidate = resolve(join(rootAbs, ...parts.filter((p) => p !== "" && p !== ".")));
  // THE CONTAINMENT CHECK. This is the one that must hold even if everything above is wrong:
  // the resolved path is inside the root, or it does not exist as far as this server is concerned.
  // DO NOT DELETE IT AS UNREACHABLE. It is deliberately redundant with the `..` reject above, and
  // mutation testing measured what that costs: removing either one alone keeps the whole test
  // file green (the survivor catches everything tested), so CI will not object when someone
  // decides one is dead. This is the backstop for what the parser has not anticipated — a symlink
  // pointing out of the root, a later edit to the segment logic, a platform separator quirk.
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) return null;
  return candidate;
}

async function fileResponse(abs: string, head: boolean): Promise<Response | null> {
  let info;
  try {
    info = await stat(abs);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const headers = new Headers({
    "content-type": contentTypeFor(abs),
    "content-length": String(info.size),
    "cache-control": cacheControlFor(abs),
  });
  if (head) return new Response(null, { status: 200, headers });
  // Streamed, not buffered: a site serves media, and reading a 200 MB file into memory to answer
  // one request is the same class of mistake the body cap in bootloader-node exists to prevent.
  const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

export type SiteOptions = PageHandlerOptions & {
  /** serve `<dir>/index.html` for a directory request (the static-export shape). Default true. */
  directoryIndex?: boolean;
};

/**
 * A fetch-shaped handler over a built site directory. Returns null for anything it does not
 * own — a non-GET/HEAD method, a path with no file, and no matching page route — so the caller
 * chains it in FRONT of the API host (see the ordering note in this file's header).
 */
export function createSiteHandler(
  siteDir: string,
  registry: Registry,
  opts: SiteOptions = {},
): (req: Request) => Promise<Response | null> {
  // The page handler validates the route table at CREATION (assertSafeRouteTable), so a bad table
  // fails the boot rather than the Nth request. Keep that property by building it here, once.
  const page = createPageHandler(registry, opts);
  const wantIndex = opts.directoryIndex !== false;
  const root = resolve(siteDir);

  return async function handle(req: Request): Promise<Response | null> {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    const head = method === "HEAD";
    const { pathname } = new URL(req.url);

    const abs = resolveWithin(root, pathname);
    if (abs !== null) {
      const direct = await fileResponse(abs, head);
      if (direct !== null) return direct;
      if (wantIndex) {
        const index = await fileResponse(join(abs, "index.html"), head);
        if (index !== null) return index;
      }
    }
    // No file: the route table decides — dynamic patterns, redirects (real 302s) and the
    // declared notFound all live in the page handler, which returns null when it owns nothing.
    return page(req);
  };
}
