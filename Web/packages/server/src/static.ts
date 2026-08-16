//
//  static.ts - static route export (@despia/server v0, node-side): every non-param route
//  in the table renders to <out>/<path>/index.html — full documents with the cascade
//  inlined, title/meta from the route entry, and the client boot scripts. Pages carry
//  data-dsx-hydrate + per-node `data-dsx-n` stamps, so when JS arrives the boot
//  ADOPTS this DOM in place (@despia/dom adopt.ts — the W6 adopt-hydration slice).
//  Redirect routes emit meta-refresh pages (static-host redirects).
//

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep, win32 } from "node:path";

import { type Dict, type ApiSeed } from "@despia/kernel";
import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
import type { Registry } from "@despia/compiler/resolve";
import {
  TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
  FORM_ELEMENTS_CSS, RICH_ELEMENTS_CSS, GLOBAL_ELEMENTS_CSS, NATIVE_CONTROLS_CSS,
  STRUCTURAL_CONTROLS_CSS, OVERLAY_CONTROLS_CSS, DATA_CONTROLS_CSS, APPLICATION_CONTROLS_CSS,
  MEDIA_PLAYBACK_CSS, MEDIA_SVG_CSS, MEDIA_LIGHTBOX_CSS,
} from "@despia/dom";
import { executeSsrApis, renderToString } from "./render.ts";

export type ShellOptions = {
  /** app display name (falls back per-route to meta.title) */
  appName?: string;
  /** forced theme attribute on <html> (the demo is dark-designed) */
  theme?: string;
  /** import map JSON + module src — omit for pure-static pages (no client upgrade) */
  importMapJson?: string;
  mainSrc?: string;
  /** language attribute */
  lang?: string;
};

export type RouteOutputOptions = {
  /** Replace exact `:name` / `{name}` segments when emitting one dynamic skeleton. */
  parameterPlaceholder?: string;
};

export type RouteOutput = {
  /** POSIX-style path recorded in manifests and returned by exportStatic(). */
  relativePath: string;
  /** Absolute filesystem target, proven to remain under the resolved output root. */
  outputPath: string;
};

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ENCODED_OCTET = /%[0-9a-f]{2}/i;
const MALFORMED_PERCENT = /%(?![0-9a-f]{2})/i;
const PARAMETER_SEGMENT = /^(?::[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const MAX_ENCODING_LAYERS = 8;
const MAX_ROUTE_BYTES = 4_096;
const MAX_ROUTE_SEGMENTS = 128;
const MAX_SEGMENT_BYTES = 255;

function routePathError(routePath: unknown, reason: string): Error {
  return new Error(`[dsx static] unsafe route path ${JSON.stringify(routePath)}: ${reason}`);
}

function pathEscapes(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || posix.isAbsolute(fromRoot) || win32.isAbsolute(fromRoot);
}

function assertSafeSegment(segment: string, routePath: string): string {
  let candidate = segment;
  if (Buffer.byteLength(candidate, "utf8") > MAX_SEGMENT_BYTES) {
    throw routePathError(routePath, `path segment exceeds ${MAX_SEGMENT_BYTES} UTF-8 bytes`);
  }
  if (MALFORMED_PERCENT.test(candidate)) {
    throw routePathError(routePath, "malformed percent encoding");
  }

  for (let depth = 0; depth <= MAX_ENCODING_LAYERS; depth += 1) {
    if (candidate === "." || candidate === "..") {
      throw routePathError(routePath, "dot segments are not allowed");
    }
    if (candidate.includes("/") || candidate.includes("\\")) {
      throw routePathError(routePath, "encoded or alternate separators are not allowed");
    }
    if (CONTROL_CHARACTER.test(candidate)) {
      throw routePathError(routePath, "control characters are not allowed");
    }
    if (/^[A-Za-z]:/.test(candidate)) {
      throw routePathError(routePath, "filesystem drive segments are not allowed");
    }
    if (/[. ]$/.test(candidate) || WINDOWS_RESERVED_SEGMENT.test(candidate)) {
      throw routePathError(routePath, "path segments must be portable across filesystems");
    }
    if (depth > 0 && /[:{}*]/.test(candidate)) {
      throw routePathError(routePath, "encoded route-syntax markers are not allowed");
    }
    if (!ENCODED_OCTET.test(candidate)) return candidate;
    if (depth === MAX_ENCODING_LAYERS) {
      throw routePathError(routePath, "too many encoding layers");
    }

    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return candidate;
      candidate = decoded;
      if (Buffer.byteLength(candidate, "utf8") > MAX_SEGMENT_BYTES) {
        throw routePathError(routePath, `decoded path segment exceeds ${MAX_SEGMENT_BYTES} UTF-8 bytes`);
      }
    } catch {
      throw routePathError(routePath, "invalid percent encoding");
    }
  }
  throw routePathError(routePath, "too many encoding layers");
}

function routeSegments(routePath: string): string[] {
  if (typeof routePath !== "string" || routePath.length === 0) {
    throw routePathError(routePath, "expected a non-empty string");
  }
  if (Buffer.byteLength(routePath, "utf8") > MAX_ROUTE_BYTES) {
    throw routePathError(routePath, `route exceeds ${MAX_ROUTE_BYTES} UTF-8 bytes`);
  }
  if (!routePath.startsWith("/") || routePath.startsWith("//")) {
    throw routePathError(routePath, "expected one leading URL-path slash, not a filesystem path");
  }
  if (routePath.includes("?") || routePath.includes("#")) {
    throw routePathError(routePath, "query and fragment text do not belong in a route path");
  }
  if (CONTROL_CHARACTER.test(routePath)) {
    throw routePathError(routePath, "control characters are not allowed");
  }
  if (routePath === "/") return [];

  // A single trailing slash is a canonical route spelling; internal empty
  // segments stay invalid so `//` can never be normalized into another path.
  const body = (routePath.endsWith("/") ? routePath.slice(0, -1) : routePath).slice(1);
  const segments = body.split("/");
  if (segments.length > MAX_ROUTE_SEGMENTS) {
    throw routePathError(routePath, `route exceeds ${MAX_ROUTE_SEGMENTS} path segments`);
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw routePathError(routePath, "empty path segments are not allowed");
  }
  segments.forEach((segment, index) => {
    assertSafeSegment(segment, routePath);
    if (PARAMETER_SEGMENT.test(segment)) return;
    if (segment === "*" && index === segments.length - 1) return;
    if (/[:{}*]/.test(segment)) {
      throw routePathError(routePath, "invalid dynamic route segment");
    }
  });
  return segments;
}

/** Validate a route even when it is dynamic and therefore will not be emitted. */
export function assertSafeRoutePath(routePath: string): void {
  routeSegments(routePath);
}

/**
 * Validate a complete route table before writing. Canonical URL spellings,
 * case-insensitive filesystems, Unicode normalization, and renamed dynamic
 * parameters must not collapse two declarations onto one route.
 */
export function assertSafeRouteTable(routePaths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const routePath of routePaths) {
    const canonical = routeSegments(routePath).map((segment) => {
      if (PARAMETER_SEGMENT.test(segment)) return ":parameter";
      if (segment === "*") return "*";
      return assertSafeSegment(segment, routePath).normalize("NFC").toLowerCase();
    }).join("/");
    const previous = seen.get(canonical);
    if (previous !== undefined) {
      throw routePathError(routePath, `collides with route ${JSON.stringify(previous)}`);
    }
    seen.set(canonical, routePath);
  }
}

/** Fail closed on active-content and ambiguous redirect targets. */
export function assertSafeRedirectTarget(target: string): void {
  if (typeof target !== "string" ||
      target.length === 0 ||
      Buffer.byteLength(target, "utf8") > MAX_ROUTE_BYTES ||
      CONTROL_CHARACTER.test(target)) {
    throw new Error(`[dsx static] unsafe redirect target ${JSON.stringify(target)}`);
  }
  if (target.startsWith("/") && !target.startsWith("//")) {
    // Validate the raw path before URL() can normalize encoded dot segments.
    const suffixAt = target.search(/[?#]/);
    const rawPath = suffixAt < 0 ? target : target.slice(0, suffixAt);
    assertSafeRoutePath(rawPath);
    new URL(target, "https://dsx.invalid");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`[dsx static] unsafe redirect target ${JSON.stringify(target)}`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`[dsx static] unsafe redirect target ${JSON.stringify(target)}`);
  }
}

/**
 * Convert a URL route to one filesystem target under outDir. This is the one
 * route/output boundary used by both the package exporter and the demo compiler.
 */
export function resolveRouteOutput(
  outDir: string,
  routePath: string,
  options: RouteOutputOptions = {},
): RouteOutput {
  const segments = routeSegments(routePath).map((segment) => {
    if (PARAMETER_SEGMENT.test(segment)) {
      if (options.parameterPlaceholder === undefined) {
        throw routePathError(routePath, "dynamic parameters require an explicit output placeholder");
      }
      if (options.parameterPlaceholder.length === 0) {
        throw routePathError(routePath, "dynamic output placeholder must not be empty");
      }
      assertSafeSegment(options.parameterPlaceholder, routePath);
      if (/[:{}*]/.test(options.parameterPlaceholder)) {
        throw routePathError(routePath, "dynamic output placeholder contains route syntax");
      }
      return options.parameterPlaceholder;
    }
    if (segment.includes(":") || segment.includes("{") || segment.includes("}") || segment.includes("*")) {
      throw routePathError(routePath, "invalid dynamic route segment");
    }
    return segment;
  });
  const relativePath = segments.length === 0 ? "index.html" : `${segments.join("/")}/index.html`;

  // Check both path dialects so a route generated on POSIX cannot become an
  // absolute/traversing path when the same project builds on Windows.
  if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw routePathError(routePath, "derived output path is absolute");
  }
  const outputRoot = resolve(outDir);
  const outputPath = resolve(outputRoot, relativePath);
  if (pathEscapes(outputRoot, outputPath)) {
    throw routePathError(routePath, "resolved output escapes the output root");
  }

  // A lexical prefix check alone can still follow a pre-existing directory or
  // file symlink outside the root. Canonicalize every existing component; absent
  // components will be created below their last verified ancestor.
  const canonicalRoot = existsSync(outputRoot) ? realpathSync(outputRoot) : outputRoot;
  let existingCandidate = outputRoot;
  for (const segment of relativePath.split("/")) {
    existingCandidate = resolve(existingCandidate, segment);
    if (!existsSync(existingCandidate)) continue;
    if (pathEscapes(canonicalRoot, realpathSync(existingCandidate))) {
      throw routePathError(routePath, "resolved output follows a symlink outside the output root");
    }
  }
  return { relativePath, outputPath };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `<style>` is an HTML raw-text element; CSS backslashes do not stop its end tag. */
function escapeStyleText(s: string): string {
  return s.replace(/<\/style/gi, "<\\/style");
}

/** Serialize the hydration payload for an inline `<script>` (doc 02 `window.__DSX__`).
 *  `<script>` is a raw-text element, so JSON's `<` must be neutralized; the line/para
 *  separators are also escaped so the script parses in every engine. Exported for the
 *  streaming adapter's per-chunk scripts (stream.ts), which carry the same payload class. */
export function serializeHydrationPayload(payload: Dict): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** One full SSR'd document for a routed component. */
export function renderPage(
  registry: Registry,
  qualified: string,
  vars: Dict,
  meta: { title?: string; description?: string },
  opts: ShellOptions = {},
): string {
  // pushed-vars contract: they land under `vars`. hydrate stamps `data-dsx-n` node
  // identities so the client boot ADOPTS this DOM instead of replace-mounting (W6);
  // the host's data-dsx-hydrate below is the client's opt-in marker — an older
  // unstamped export keeps the v0 replace path.
  const body = renderToString(registry, qualified, vars, { hydrate: true });
  return assembleDocument(registry, body, qualified, meta, opts, {});
}

/** The SSR-aware page render (doc 05/02): execute the route component's ssr-eligible
 *  `<api>` GET blocks FIRST, embed their ok results in both the rendered body (data
 *  visible on first paint) and the `window.__DSX__` hydration payload, then the client
 *  boot seeds those blocks and skips the initial fetch (adopt.ts + api.ts). Any block
 *  that is ineligible or whose fetch fails is simply absent from the payload, so the
 *  client fetches it on mount exactly as before — SSR is a pure, fail-open optimization.
 *  Async because it performs bounded network I/O; `renderPage` stays the sync no-fetch
 *  entry. The PER-REQUEST live adapter is live.ts (createPageHandler — dynamic routes,
 *  real 30x/404s, per-request api seeding); out-of-order STREAMING of `defer` blocks
 *  remains the open half of the seam (doc 02, W6). */
export async function renderPageAsync(
  registry: Registry,
  qualified: string,
  vars: Dict,
  meta: { title?: string; description?: string },
  opts: ShellOptions & { ssrTimeoutMs?: number } = {},
): Promise<string> {
  const apiSeeds = await executeSsrApis(registry, qualified, vars, {
    ...(opts.ssrTimeoutMs !== undefined ? { timeoutMs: opts.ssrTimeoutMs } : {}),
  });
  return renderPageWithSeeds(registry, qualified, vars, meta, opts, apiSeeds);
}

/** The document half of renderPageAsync with the seeds already in hand — the streaming
 *  adapter (stream.ts) runs the seed pass itself so it can flush this document FIRST and
 *  stream the deferred blocks after it. */
export function renderPageWithSeeds(
  registry: Registry,
  qualified: string,
  vars: Dict,
  meta: { title?: string; description?: string },
  opts: ShellOptions,
  apiSeeds: { [as: string]: ApiSeed },
): string {
  const body = renderToString(registry, qualified, vars, { hydrate: true, apiSeeds });
  return assembleDocument(registry, body, qualified, meta, opts, apiSeeds);
}

/** Assemble the full document around a rendered body: head (title/meta/og), the inlined
 *  cascade, an optional `window.__DSX__` payload (emitted only when there are SSR seeds),
 *  the boot script, and the adopt-marked host. */
function assembleDocument(
  registry: Registry,
  body: string,
  qualified: string,
  meta: { title?: string; description?: string },
  opts: ShellOptions,
  apiSeeds: { [as: string]: ApiSeed },
): string {
  const title = meta.title ?? opts.appName ?? qualified;
  const head: string[] = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
    `<meta name="color-scheme" content="light dark">`,
    `<title>${escapeHtml(title)}</title>`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
  ];
  if (meta.description !== undefined) {
    head.push(`<meta name="description" content="${escapeHtml(meta.description)}">`);
    head.push(`<meta property="og:description" content="${escapeHtml(meta.description)}">`);
  }
  head.push(`<link rel="icon" href="data:,">`);
  head.push(`<style>${escapeStyleText(LAYER_STATEMENT)}</style>`);
  head.push(`<style>${escapeStyleText(TOKENS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(APPLICATION_ELEMENTS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(ELEMENTS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(CONTROL_ELEMENTS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(FORM_ELEMENTS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(RICH_ELEMENTS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(NATIVE_CONTROLS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(STRUCTURAL_CONTROLS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(OVERLAY_CONTROLS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(DATA_CONTROLS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(APPLICATION_CONTROLS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(MEDIA_PLAYBACK_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(MEDIA_SVG_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(MEDIA_LIGHTBOX_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(GLOBAL_ELEMENTS_CSS)}</style>`);
  head.push(`<style>${escapeStyleText(registry.css)}</style>`);
  head.push(`<style>html, body { margin: 0; height: 100%; }</style>`);
  if (opts.importMapJson !== undefined) {
    // `<script>` is a raw-text element — HTML-escaping won't neutralize a `</script>` in
    // the value, so strip any `</script`/`<script`/`<!--` breakout before inlining.
    const safeImportMap = opts.importMapJson.replace(/<\/?script/gi, "").replace(/<!--/g, "");
    head.push(`<script type="importmap">${safeImportMap}</script>`);
  }
  // the hydration payload (doc 02): emitted only when SSR resolved at least one api, so
  // an api-free page stays byte-identical to v0. Placed BEFORE the boot module so
  // `window.__DSX__` exists when boot reads it (adopt.ts seedApiEnvelopes).
  const payloadScript = Object.keys(apiSeeds).length > 0
    ? `<script>window.__DSX__=${serializeHydrationPayload({ api: apiSeeds })};</script>\n`
    : "";
  const bootScript = opts.mainSrc !== undefined ? `<script type="module" src="${escapeHtml(opts.mainSrc)}"></script>` : "";
  const themeAttr = opts.theme !== undefined ? ` data-dsx-theme="${escapeHtml(opts.theme)}"` : "";
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang ?? "en")}"${themeAttr}>
<head>
${head.join("\n")}
</head>
<body>
<div id="app" data-dsx-root data-dsx-ssr data-dsx-hydrate>${body}</div>
${payloadScript}${bootScript}
</body>
</html>
`;
}

/** meta-refresh page for a redirect route (works on any static host) */
export function renderRedirect(target: string): string {
  assertSafeRedirectTarget(target);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">
<link rel="canonical" href="${escapeHtml(target)}">
</head>
<body><a href="${escapeHtml(target)}">Moved: ${escapeHtml(target)}</a></body>
</html>
`;
}

/** Export every static (non-param) route. Returns the written paths. */
export function exportStatic(registry: Registry, outDir: string, opts: ShellOptions = {}): string[] {
  const written: string[] = [];
  const routes = registry.routes ?? [];
  // Preflight the complete table before the first mkdir/write. A bad late route
  // must not leave a plausible-looking partial export behind.
  assertSafeRouteTable(routes.map((route) => route.path));
  for (const route of routes) {
    if (route.redirect !== undefined) assertSafeRedirectTarget(route.redirect);
  }
  for (const route of routes) {
    if (route.path.includes(":") || route.path.includes("{") || route.path.includes("*")) continue; // dynamic — needs live SSR (W6)
    const { relativePath, outputPath } = resolveRouteOutput(outDir, route.path);
    mkdirSync(dirname(outputPath), { recursive: true });
    if (route.redirect !== undefined) {
      writeFileSync(outputPath, renderRedirect(route.redirect));
    } else if (route.component !== undefined) {
      const meta = route.meta ?? {};
      writeFileSync(outputPath, renderPage(registry, route.component, { path: route.path }, meta, opts));
    } else {
      continue;
    }
    written.push(relativePath);
  }
  return written;
}
