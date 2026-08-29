//
//  content-type.ts — the MIME and cache-policy table for what a DSX build actually emits,
//  platform-free so every site face (node fs, Workers assets, the preview object store)
//  answers with the same headers. Extracted from site-node.ts when the preview face
//  arrived: the table must not drag `node:fs` into an edge bundle.
//

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
