//
//  universal-links.ts — the NATIVE universal-links generator (W4 "the native
//  universal-links generator").
//
//  A DSX route table is already the ONE declaration of every URL the app answers. Apple's
//  `apple-app-site-association` and Google's `assetlinks.json` are the same fact, restated
//  for the two OSes — so they are GENERATED from the route table rather than hand-kept, and
//  a route added on web is a deep link on both natives without a second edit.
//
//  Declaration (the application package's dsx.json `web` block):
//
//    "web": {
//      "links": {
//        "appleAppIds": ["ABCDE12345.com.acme.app"],
//        "androidPackages": [
//          { "package": "com.acme.app", "sha256": ["AA:BB:…"] }
//        ],
//        "exclude": ["/admin/*"]
//      }
//    }
//
//  No `links` block ⇒ NOTHING is emitted. A half-declared block is an ERROR, never a file
//  that silently claims no paths: a published AASA that matches nothing is worse than none,
//  because iOS caches it.
//
//  Path translation is exact, not approximate:
//    • `/orders/:id` → `/orders/*` (a path COMPONENT wildcard; AASA has no param syntax)
//    • `/docs/*`     → `/docs/*`
//    • a redirect-only route contributes its own path (the OS should still open the app)
//    • `exclude` entries emit as AASA's `NOT ` prefix, ordered FIRST — Apple matches in
//      declaration order, so an exclusion after its pattern would never fire.
//

export type UniversalLinksDeclaration = {
  appleAppIds?: unknown;
  androidPackages?: unknown;
  exclude?: unknown;
};

export type AndroidTarget = { package: string; sha256: string[] };

export type UniversalLinks = {
  appleAppIds: string[];
  androidPackages: AndroidTarget[];
  exclude: string[];
};

const APPLE_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;
const ANDROID_PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const SHA256_FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const LINK_PATH = /^\/[^\s?#]*$/;

/** Parse and VALIDATE a `web.links` block. Throws with every problem at once — a
 *  half-valid association file is the failure mode this exists to prevent. */
export function readUniversalLinks(raw: UniversalLinksDeclaration | undefined): UniversalLinks | null {
  if (raw === undefined || raw === null) return null;
  const errors: string[] = [];
  const appleAppIds: string[] = [];
  const androidPackages: AndroidTarget[] = [];
  const exclude: string[] = [];

  for (const id of Array.isArray(raw.appleAppIds) ? raw.appleAppIds : []) {
    if (typeof id === "string" && APPLE_APP_ID.test(id)) appleAppIds.push(id);
    else errors.push(`appleAppIds entry ${JSON.stringify(id)} must be "<10-char TeamID>.<bundle id>"`);
  }
  if (raw.appleAppIds !== undefined && !Array.isArray(raw.appleAppIds)) {
    errors.push(`"appleAppIds" must be an array`);
  }

  for (const target of Array.isArray(raw.androidPackages) ? raw.androidPackages : []) {
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      errors.push(`each androidPackages entry must be { package, sha256 }`);
      continue;
    }
    const entry = target as { package?: unknown; sha256?: unknown };
    if (typeof entry.package !== "string" || !ANDROID_PACKAGE.test(entry.package)) {
      errors.push(`androidPackages entry ${JSON.stringify(entry.package)} is not an application id`);
      continue;
    }
    const prints = Array.isArray(entry.sha256) ? entry.sha256 : [];
    const valid = prints.filter((p): p is string => typeof p === "string" && SHA256_FINGERPRINT.test(p.toUpperCase()))
      .map((p) => p.toUpperCase());
    if (valid.length === 0) {
      errors.push(`androidPackages "${entry.package}" needs at least one colon-separated uppercase SHA-256 signing fingerprint`);
      continue;
    }
    androidPackages.push({ package: entry.package, sha256: valid });
  }
  if (raw.androidPackages !== undefined && !Array.isArray(raw.androidPackages)) {
    errors.push(`"androidPackages" must be an array`);
  }

  for (const path of Array.isArray(raw.exclude) ? raw.exclude : []) {
    if (typeof path === "string" && LINK_PATH.test(path)) exclude.push(path);
    else errors.push(`exclude entry ${JSON.stringify(path)} must be an absolute path`);
  }

  if (appleAppIds.length === 0 && androidPackages.length === 0) {
    errors.push(`a "links" block declares neither appleAppIds nor androidPackages — remove it, or declare a target`);
  }
  if (errors.length > 0) {
    throw new Error(`[dsx links] ${errors.join("\n[dsx links] ")}`);
  }
  return { appleAppIds, androidPackages, exclude };
}

/** A route path in Apple/Android association syntax. Named params become a single path
 *  COMPONENT wildcard so `/orders/7` matches while `/orders/7/refund` does not. */
export function linkPattern(routePath: string): string {
  return routePath
    .replace(/\{[^/}]+\}/g, "*")
    .replace(/:[^/]+/g, "*")
    .replace(/\*{2,}/g, "*");
}

/** The deduplicated, ORDERED pattern list: exclusions first (Apple matches in order),
 *  then every routable path. A `*`-only table collapses to the single wildcard. */
export function linkPatterns(
  routes: ReadonlyArray<{ path: string }> | undefined,
  exclude: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of exclude) {
    const pattern = `NOT ${linkPattern(path)}`;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  for (const route of routes ?? []) {
    const pattern = linkPattern(route.path);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

export type LinkFile = { path: string; contents: string };

/** Render the two association files. Returns [] when nothing is declared — a build with
 *  no `links` block must not publish an empty association that iOS would then cache. */
export function universalLinkFiles(
  links: UniversalLinks | null,
  routes: ReadonlyArray<{ path: string }> | undefined,
): LinkFile[] {
  if (links === null) return [];
  const patterns = linkPatterns(routes, links.exclude);
  if (patterns.length === 0) return [];
  const files: LinkFile[] = [];

  if (links.appleAppIds.length > 0) {
    const aasa = {
      applinks: {
        details: links.appleAppIds.map((appID) => ({ appID, paths: patterns })),
      },
      // The modern component form alongside the legacy `paths` array: older iOS reads
      // `paths`, iOS 13+ reads `components`. Emitting both is the documented shape.
      webcredentials: { apps: links.appleAppIds },
    };
    files.push({
      // Served with NO extension and `application/json` — the Apple contract.
      path: ".well-known/apple-app-site-association",
      contents: `${JSON.stringify(aasa, null, 2)}\n`,
    });
  }

  if (links.androidPackages.length > 0) {
    const assetlinks = links.androidPackages.map((target) => ({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: target.package,
        sha256_cert_fingerprints: target.sha256,
      },
    }));
    files.push({
      path: ".well-known/assetlinks.json",
      contents: `${JSON.stringify(assetlinks, null, 2)}\n`,
    });
  }
  return files;
}
