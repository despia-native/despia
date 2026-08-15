//
//  specifiers.ts — which `@despia/*` packages a built browser graph actually imports.
//
//  ONE implementation, because there are two consumers and they must agree: `dsx build`
//  drives its vendoring queue and its import map from this, and `build-demo` validates the
//  demo's hand-written import map against it. When the two had separate copies they drifted
//  the moment a package started GENERATING code, and the failure mode is the expensive kind
//  — a missing import-map entry survives every type and unit gate and becomes a blank page
//  in a clean session.
//
//  ANCHORED AT STATEMENT POSITION, not anywhere the characters `from "@despia/x"` appear. A
//  module that generates code carries import statements as string data: the MCP view builder
//  emits `import { defineDsxElement } from "@despia/element";` into a temp entry it hands to
//  esbuild. An unanchored scan reads that as the compiler importing @despia/element, and the
//  consequence is not cosmetic — the vendoring queue then demands a package the project never
//  imports and `dsx build` refuses a scaffolded app that is entirely correct.
//
//  tsc and esbuild both emit static import/export at column 0; the indented case is exactly
//  the template literal being excluded. So requiring the keyword at line start separates real
//  edges from emitted text without parsing JavaScript. Dynamic `import("…")` is an expression
//  and legitimately appears mid-line, so it keeps an unanchored form: a generated-code
//  template writes the statement form, not that one.
//

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STATIC_EDGE = /^[ \t]*(?:import|export)\b[^;'"`]*?from[ \t]*["'](@despia\/[^"']+)["']/gm;
const SIDE_EFFECT_EDGE = /^[ \t]*import[ \t]*["'](@despia\/[^"']+)["']/gm;
const DYNAMIC_EDGE = /\bimport\s*\(\s*["'](@despia\/[^"']+)["']/g;

/** Every bare `@despia/*` specifier the .js files under `dir` import, recursively. */
export function scanDsxSpecifiers(dir: string): Set<string> {
  const found = new Set<string>();
  for (const file of jsFiles(dir)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [STATIC_EDGE, SIDE_EFFECT_EDGE, DYNAMIC_EDGE]) {
      for (const match of source.matchAll(pattern)) found.add(match[1]!);
    }
  }
  return found;
}

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && statSync(full).isFile()) out.push(full);
  }
  return out;
}
