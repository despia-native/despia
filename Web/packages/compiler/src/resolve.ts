//
//  resolve.ts - the compiled registry SHAPE + component resolution. Browser-safe
//  (no node imports): @despia/dom consumes this at runtime; registry.ts (build-time,
//  node) produces the same shape.
//

import type { ComponentIR } from "./component.ts";

export type Registry = {
  /** "scheme.Name" → component IR */
  components: { [qualified: string]: ComponentIR };
  /** bare Name → qualified name (the shared pool) */
  globalPool: { [name: string]: string };
  /** the ONE compiled stylesheet (layers + scoped sheets + node css) */
  css: string;
  /** module schemes present in this build (dsx.has) */
  schemes: string[];
  /** the strings BUILD tier (P12, localization.md): the app root's `Strings.<tag>.json`
   *  tables, keyed by lowercase BCP-47 tag - the client boot hands DSXStrings a
   *  synchronous loader over these. Optional: absent means the app ships no tables. */
  strings?: { [tag: string]: { [key: string]: string } };
  /** the unified route table (/web/04): URLs ↔ component pushes. Optional — a
   *  pathless app (component pushes only) simply omits it. `redirect` entries send
   *  the path elsewhere; `meta` feeds the document title/description (client +
   *  static export). */
  routes?: Array<{
    path: string;
    component?: string;
    redirect?: string;
    render?: string;
    /** wide-lane master-detail: this route pins as the persistent left pane (motion opt-in) */
    master?: boolean;
    /** per-route motion override: "none" kills it, a family forces it when the lane animates
     *  (the F7 options.animate / transition pair, one key) */
    motion?: "dsx" | "ios" | "md" | "none";
    meta?: { title?: string; description?: string };
    /** capability gate — every named scheme must be shipped in THIS build */
    requires?: string[];
    /** declarative guard — a bounded JSE predicate over `global.*`; falsy → `redirect` */
    guard?: string;
  }>;
  /** component shown for unmatched URLs (the 404 page) */
  notFound?: string;
  /** The DOCUMENT SHELL the build baked (wave-7 F1): app name, lang, the inlined import
   *  map, the `./`-relative module src, and the manifest href — everything a live SSR
   *  host needs to serve a document whose client boot actually loads. `dsx build` writes
   *  it into registry.json so `createPageHandler`/`createSiteHandler` pick it up when the
   *  caller passes no shell of their own (explicit caller options win per key). Without
   *  it, a handler built from the bare registry served dynamic routes with NO `<script>`
   *  — a dead page on every deep-linked param URL. */
  shell?: {
    appName?: string;
    lang?: string;
    importMapJson?: string;
    mainSrc?: string;
    manifestHref?: string;
    theme?: string;
  };
  /** Per-package `web` blocks consumed from each dsx.json (W3/W4): the routes each
   *  package contributed (already merged into `routes` above), plus the styles/assets
   *  a bundler — `dsx build`, the Vite plugin — folds into the application build. */
  packageWeb?: Array<{
    scheme: string;
    dir: string;
    routes: Array<{ path: string }>;
    styles: string[];
    assets: string[];
    base?: string;
    /** validated `web.links` — the input to the universal-links generator */
    links?: {
      appleAppIds: string[];
      androidPackages: Array<{ package: string; sha256: string[] }>;
      exclude: string[];
    };
    /** npm coordinates this package's browser entry may import (A3) */
    dependencies?: { [name: string]: string };
    /** package-relative browser module, bundled into its own chunk (A3) */
    entry?: string;
    /** the entry's default-export WebModule registers at page boot (opt-in; the lazy
     *  default stays — studio-apps.md §8, the Apps mount host is the first consumer) */
    boot?: boolean;
  }>;
  /** OPT-IN router motion (/web/04 + @despia/dom motion.ts): neutral DSX Web transitions,
   *  explicit legacy families, edge swipe-back, and the master-detail split. Config-plane only — markup and the dsx API
   *  are byte-identical with or without it; omitted = instant swaps (today's behavior). */
  router?: {
    transition?: "dsx" | "ios" | "md" | "auto" | "none";
    swipeBack?: boolean;
    masterDetailBreakpoint?: number;
    wide?: "none" | "same";
  };
};

/** Resolution: package-local (caller's scheme) → scheme-qualified → global pool. */
export function resolveComponent(registry: Registry, callerScheme: string, tag: string): ComponentIR | null {
  if (tag.includes(".")) {
    const ns = tag.substring(0, tag.indexOf("."));
    const name = tag.substring(tag.indexOf(".") + 1);
    if (ns === "shared" || ns === "global") {
      const pooled = registry.globalPool[name];
      return pooled !== undefined ? registry.components[pooled] ?? null : null;
    }
    return registry.components[tag] ?? null;
  }
  const local = registry.components[`${callerScheme}.${tag}`];
  if (local) return local;
  const pooled = registry.globalPool[tag];
  return pooled !== undefined ? registry.components[pooled] ?? null : null;
}
