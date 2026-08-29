//
//  static.ts - static route export (@despia-native/server v0, node-side): every non-param route
//  in the table renders to <out>/<path>/index.html — full documents with the cascade
//  inlined, title/meta from the route entry, and the client boot scripts. Pages carry
//  data-dsx-hydrate + per-node `data-dsx-n` stamps, so when JS arrives the boot
//  ADOPTS this DOM in place (@despia-native/dom adopt.ts — the W6 adopt-hydration slice).
//  Redirect routes emit meta-refresh pages (static-host redirects).
//
//  This file is the FILESYSTEM half only. Document assembly, the SSR renders and the
//  route-safety checks are platform-free and live in page-render.ts (the live page handler
//  runs them inside Cloudflare Workers — W1); they are re-exported below so every existing
//  consumer of this module reads on unchanged.
//

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep, win32 } from "node:path";

import type { Registry } from "@despia-native/compiler/resolve";
import {
  PARAMETER_SEGMENT,
  assertSafeRedirectTarget,
  assertSafeRouteTable,
  assertSafeSegment,
  rebaseShellForDepth,
  renderPage,
  renderRedirect,
  routePathError,
  routeSegments,
  type ShellOptions,
} from "./page-render.ts";

export {
  assertSafeRoutePath,
  rebaseShellForDepth,
  shellDepthForRequestPath,
  assertSafeRouteTable,
  assertSafeRedirectTarget,
  renderPage,
  renderPageAsync,
  renderPageWithSeeds,
  renderRedirect,
  serializeHydrationPayload,
  type ShellOptions,
} from "./page-render.ts";

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

function pathEscapes(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || posix.isAbsolute(fromRoot) || win32.isAbsolute(fromRoot);
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
      // each output lives at <route>/index.html, so ./-relative shell references need
      // the route's directory depth folded in (rebaseShellForDepth)
      const depth = relativePath.split("/").length - 1;
      writeFileSync(outputPath, renderPage(registry, route.component, { path: route.path }, meta, rebaseShellForDepth(opts, depth)));
    } else {
      continue;
    }
    written.push(relativePath);
  }
  return written;
}
