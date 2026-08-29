//
//  generate-icons.ts — the web half of the ONE cross-runtime icon table.
//
//  `icon=`/`systemImage=`/`tabIcon=`/`actionIcon=` name SF Symbols. iOS draws the SF name
//  directly; every other runtime resolves it through OpenSource/Conformance/icons/sf-map.json —
//  ONE file, never forked (Android packages the same bytes as a :render asset; see that file's
//  `_note`). Web used to carry a PRIVATE 27-name fork inside elements.ts, so 85 corpus names
//  that drew on iOS/Android drew a placeholder circle in the browser. This script removes the
//  fork: it DERIVES the web tables from the corpus.
//
//    corpus row `web`      → ICON_VECTORS   (rung 1: the 24x24 stroke path)
//    corpus row `fallback` → ICON_FALLBACKS (rung 2: the unicode/text stand-in), emitted only
//                            for rows with no `web` path, since rung 1 wins when both exist
//    corpus `web_extra`    → ICON_VECTORS   (web-only names, the documented divergence)
//
//  Run: npm run icons:generate   (from OpenSource/Web)
//  Gate: packages/dom/test/icons.test.ts re-runs `renderIconsModule` and fails on any drift,
//  and separately fails when a corpus row cannot be drawn on web at all.
//

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SfIconRow = {
  material?: string;
  codepoint?: string;
  fallback?: string;
  /** the web render tier: a 24x24 SVG path `d` (see the corpus `_web_axis` note) */
  web?: string;
};

export type SfMap = {
  icons: { [name: string]: SfIconRow };
  /** names web draws that are not yet `icons` rows — the recorded divergence */
  web_extra?: { [name: string]: string };
};

const here = dirname(fileURLToPath(import.meta.url));

/** the ONE table — OpenSource/Conformance/icons/sf-map.json */
export const SF_MAP_PATH = join(here, "../../../../Conformance/icons/sf-map.json");

/** the generated module this script owns */
export const GENERATED_PATH = join(here, "../src/icons.generated.ts");

export function readSfMap(path: string = SF_MAP_PATH): SfMap {
  return JSON.parse(readFileSync(path, "utf8")) as SfMap;
}

/** A conservative SVG path grammar: commands + numbers only. Nothing here reaches innerHTML,
 *  but a generated attribute value should still be provably inert and provably a path. */
const PATH_SHAPE = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9 .,\-]*$/;

export function assertDrawablePath(name: string, d: string): void {
  if (!PATH_SHAPE.test(d)) {
    throw new Error(`[dsx icons] ${name}: 'web' must be an SVG path starting at M/m — got ${JSON.stringify(d)}`);
  }
}

/** name → 24x24 path, and name → text fallback, derived from the corpus in corpus order. */
export function iconTables(map: SfMap): { vectors: [string, string][]; fallbacks: [string, string][] } {
  const vectors: [string, string][] = [];
  const fallbacks: [string, string][] = [];
  for (const [name, row] of Object.entries(map.icons)) {
    const web = row.web;
    if (typeof web === "string" && web.length > 0) {
      assertDrawablePath(name, web);
      vectors.push([name, web]);
      continue;
    }
    const fallback = row.fallback;
    if (typeof fallback === "string" && fallback.length > 0) {
      fallbacks.push([name, fallback]);
      continue;
    }
    throw new Error(`[dsx icons] ${name}: the corpus row has neither a 'web' path nor a 'fallback' glyph — web cannot draw it`);
  }
  for (const [name, web] of Object.entries(map.web_extra ?? {})) {
    assertDrawablePath(name, web);
    vectors.push([name, web]);
  }
  return { vectors, fallbacks };
}

function entries(rows: [string, string][]): string {
  return rows.map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)},`).join("\n");
}

export function renderIconsModule(map: SfMap): string {
  const { vectors, fallbacks } = iconTables(map);
  return `//
//  icons.generated.ts — GENERATED, do not edit.
//
//  Source of truth: OpenSource/Conformance/icons/sf-map.json (the ONE cross-runtime SF Symbol
//  table — iOS draws SF names directly, Android resolves through the same file's Material
//  Symbols codepoints, web resolves through the tables below).
//  Regenerate:  cd OpenSource/Web && npm run icons:generate
//  Generator:   packages/dom/bin/generate-icons.ts
//  Gate:        packages/dom/test/icons.test.ts — drift from the corpus FAILS the suite.
//
//  Two tiers, mirroring the corpus \`_web_axis\` note and the Android render ladder:
//    ICON_VECTORS   rung 1 — a 24x24 FILL path (viewBox 0 0 24 24, fill currentColor,
//                   stroke none) — Boxicons per the corpus _web_axis v2 note.
//    ICON_FALLBACKS rung 2 — the corpus's plain unicode stand-in, drawn as SVG <text>, for the
//                   pictographic rows a 2px stroke cannot honestly carry. Emitted ONLY for rows
//                   with no rung-1 path; a name in ICON_VECTORS never appears here.
//  A name in NEITHER table is not in the corpus: iconSvg fails open to its placeholder, exactly
//  as the corpus's fail-open rule requires.
//
//  Rows: ${vectors.length} vector, ${fallbacks.length} fallback.
//

export const ICON_VECTORS: { readonly [name: string]: string } = {
${entries(vectors)}
};

export const ICON_FALLBACKS: { readonly [name: string]: string } = {
${entries(fallbacks)}
};
`;
}

function main(): void {
  const text = renderIconsModule(readSfMap());
  writeFileSync(GENERATED_PATH, text);
  process.stdout.write(`• icons: ${GENERATED_PATH} regenerated from ${SF_MAP_PATH}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
