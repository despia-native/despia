//
//  expose.ts - the web-component EXPOSURE manifest (/web/13 W10). A package opts a
//  component into embed emission in its dsx.json:
//
//    "web": { "expose": { "Paywall": { "tag": "acme-paywall" }, "PriceCard": {} },
//             "embed": { "origins": ["https://partner.example"] } }
//
//  Default tag = `<scheme>-<component>` lowercased (the custom-element dash arrives
//  with the package prefix). Tag collisions across packages are a build ERROR. Only
//  exposed components get artifacts; origins defaults to [] — embeds stay OFF for
//  third-party pages unless the package declares who may load them.
//

import type { Registry } from "./resolve.ts";
import type { ComponentIR } from "./component.ts";
import type { XmlNode } from "./xml.ts";
import { cssForComponentSlice } from "./registry.ts";

export type ExposedComponent = {
  scheme: string;
  /** component name as authored ("EmbedCard") */
  name: string;
  /** qualified registry key ("demo.EmbedCard") */
  qualified: string;
  /** the custom-element tag */
  tag: string;
  /** CORS allowlist for the package's embed assets ([] = same-origin only) */
  origins: string[];
  /** gz size budget for the self-contained embed file, KB. 40 is the widget law
   *  (/web/13, FINAL); a tool-grade embed (an editor, a whole surface) must DECLARE
   *  a bigger number in its manifest — never silent, always printed by the build. */
  budgetKB: number;
};

type DsxJsonWeb = {
  expose?: { [component: string]: { tag?: string; budgetKB?: number } | Record<string, never> };
  embed?: { origins?: string[] };
};

/** Collect the exposed components of one package manifest (parsed dsx.json). */
export function readExpose(scheme: string, web: DsxJsonWeb | undefined): ExposedComponent[] {
  if (web?.expose === undefined) return [];
  const origins = web.embed?.origins ?? [];
  return Object.entries(web.expose).map(([name, spec]) => {
    const custom = (spec as { tag?: string }).tag;
    const tag = custom !== undefined && custom.length > 0 ? custom : `${scheme}-${name}`.toLowerCase();
    if (!tag.includes("-")) throw new Error(`[dsx expose] tag "${tag}" for ${scheme}.${name} needs a dash (custom-element grammar)`);
    if (tag !== tag.toLowerCase()) throw new Error(`[dsx expose] tag "${tag}" for ${scheme}.${name} must be lowercase`);
    const declared = (spec as { budgetKB?: number }).budgetKB;
    const budgetKB = declared === undefined ? 40 : declared;
    if (typeof budgetKB !== "number" || !Number.isFinite(budgetKB) || budgetKB < 1 || budgetKB > 512) {
      throw new Error(`[dsx expose] budgetKB ${String(declared)} for ${scheme}.${name} — a declared budget is 1..512 (KB, gz)`);
    }
    return { scheme, name, qualified: `${scheme}.${name}`, tag, origins, budgetKB };
  });
}

/** Merge per-package exposures; a tag claimed twice across packages is a build ERROR. */
export function mergeExposed(all: ExposedComponent[][]): ExposedComponent[] {
  const byTag = new Map<string, ExposedComponent>();
  for (const list of all) {
    for (const e of list) {
      const prior = byTag.get(e.tag);
      if (prior !== undefined) {
        throw new Error(`[dsx expose] tag collision: <${e.tag}> claimed by both ${prior.qualified} and ${e.qualified}`);
      }
      byTag.set(e.tag, e);
    }
  }
  return [...byTag.values()];
}

export type ExposeLintResult = { errors: string[]; warnings: string[] };

/** The build-time lints on the EXPOSE path (/web/13 "Lint (build-time, on `expose`)", S-07).
 *  readExpose/mergeExposed already enforce tag grammar, tag collisions and the budget bound;
 *  these are the three the doc declared but never ran. Each reads an exposed component's
 *  COMPILED IR — its head contract and its transitive markup slice:
 *
 *   1. (E) a `<expects variable=…>` on an exposed component — an embed is ATTRIBUTE-driven by
 *      definition (SSR/upgrade hand it attributes + JS properties, never pushed `vars`), so an
 *      `expects` is a contract it can never satisfy.
 *   2. (E) the component's own package ships no web twin, yet its markup calls that package's
 *      OWN module actions (`dsx.module.<scheme>.…` / `<scheme>://…`) — dead buttons on every
 *      embed. (Calls to OTHER modules degrade honestly via `dsx.has`/`avail:` — not an error.)
 *   3. (W) a rich-typed attribute (an object/array default — the one compile-time signal of
 *      rich typing, since there is no attribute type grammar) has no documented JSON shape; a
 *      third party must pass it as JSON text or a JS property and nothing tells them the shape.
 *
 *  `webTwinSchemes` = schemes that ship a web facet (a web twin) — a package in it CAN implement
 *  its own module actions inside the embed, so lint 2 does not fire for it. Errors block the
 *  build (thrown by the caller); the warning is advisory, printed and fail-open. */
export function lintExposed(
  exposed: ExposedComponent[],
  registry: Registry,
  webTwinSchemes: ReadonlySet<string>,
): ExposeLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const e of exposed) {
    const ir = registry.components[e.qualified];
    if (ir === undefined) continue; // an expose of an unknown component surfaces elsewhere
    // 1 (E): attribute-driven only — a pushed-vars contract is unsatisfiable in an embed.
    if (ir.head.expects.length > 0) {
      errors.push(
        `[dsx expose] <${e.tag}> (${e.qualified}) declares <expects variable="${ir.head.expects.join(", ")}"> — ` +
        `an embed is attribute-driven and is never handed pushed vars. Consume the value as an <attribute> instead.`,
      );
    }
    // 2 (E): own-module calls with no web twin to run them = dead buttons on every embed.
    if (!webTwinSchemes.has(e.scheme)) {
      const calls = ownModuleCalls(registry, e.qualified, e.scheme);
      if (calls.length > 0) {
        const shown = calls.slice(0, 3).map((c) => `${e.scheme}.${c}`).join(", ");
        errors.push(
          `[dsx expose] <${e.tag}> (${e.qualified}) calls its own module (${shown}${calls.length > 3 ? ", …" : ""}) ` +
          `but package "${e.scheme}" declares no web entry — those are dead buttons on every embed. ` +
          `Add a web.entry (web/index.ts) that implements them, or remove the calls.`,
        );
      }
    }
    // 3 (W): a rich-typed attribute crosses the boundary as JSON text with no documented shape.
    for (const attr of ir.head.attributes) {
      if (attr.default !== undefined && isRichJsonDefault(attr.default)) {
        warnings.push(
          `[dsx expose] <${e.tag}> (${e.qualified}) attribute "${attr.as}" is rich-typed (an object/array default) ` +
          `with no documented JSON shape — third-party integrators pass it as JSON text or a JS property. Document its shape.`,
        );
      }
    }
  }
  return { errors, warnings };
}

/** A default value that is a rich JSON object/array literal — the only compile-time signal of a
 *  rich-typed attribute (there is no `type=` on `<attribute>`; scalar types are inferred from the
 *  default). Requiring a VALID JSON object/array parse deliberately excludes `{{ interpolation }}`
 *  (invalid JSON) and every scalar default, so the warning never fires on ordinary attributes. */
function isRichJsonDefault(raw: string): boolean {
  const t = raw.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return false;
  try {
    const v = JSON.parse(t) as unknown;
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

/** Every action-bearing string in a component IR: head bodies (actions/variables/formulas/watch
 *  handlers/scripts) + every markup attribute value + every text node. The corpus lint 2 scans
 *  these for own-module calls. */
function irCodeStrings(ir: ComponentIR): string[] {
  const out: string[] = [];
  for (const a of ir.head.actions) out.push(a.body);
  for (const v of ir.head.variables) out.push(v.body);
  for (const f of ir.head.formulas) out.push(f.body);
  for (const w of ir.head.watches) { out.push(w.value); out.push(w.handler); }
  for (const s of ir.head.scripts) out.push(s);
  for (const s of ir.head.globalScripts) out.push(s);
  const walk = (n: XmlNode): void => {
    for (const value of Object.values(n.attrs)) out.push(value);
    if (n.text.length > 0) out.push(n.text);
    for (const c of n.children) walk(c);
  };
  walk(ir.root);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The DISTINCT own-module actions the exposed component's whole embed slice calls — both the
 *  modern `dsx.module.<scheme>.<action>` form and the legacy `<scheme>://<action>` URL. Scans the
 *  transitive slice, so a same-scheme nested component's call counts too (it ships in the embed). */
function ownModuleCalls(registry: Registry, qualified: string, scheme: string): string[] {
  const slice = sliceRegistry(registry, qualified);
  const found = new Set<string>();
  const dotRe = new RegExp(`\\bdsx\\.module\\.${escapeRegExp(scheme)}\\.([A-Za-z_$][\\w$]*)`, "g");
  const urlRe = new RegExp(`\\b${escapeRegExp(scheme)}://([A-Za-z_$][\\w$-]*)`, "g");
  for (const ir of Object.values(slice.components)) {
    for (const s of irCodeStrings(ir)) {
      for (const m of s.matchAll(dotRe)) found.add(m[1]!);
      for (const m of s.matchAll(urlRe)) found.add(m[1]!);
    }
  }
  return [...found];
}

/** The registry slice an embed ships: the exposed component + its transitive
 *  component dependencies (BFS over body tags), their compiled css, no module
 *  schemes (bundled chunks register themselves — the honest subset). */
export function sliceRegistry(registry: Registry, qualified: string): Registry {
  const components: { [q: string]: ComponentIR } = {};
  const globalPool: { [name: string]: string } = {};
  const queue: string[] = [qualified];
  while (queue.length > 0) {
    const q = queue.shift()!;
    if (components[q] !== undefined) continue;
    const ir = registry.components[q];
    if (ir === undefined) continue;
    components[q] = ir;
    for (const dep of componentTags(ir.root)) {
      const resolved = resolveQualified(registry, ir.scheme, dep);
      if (resolved === null) continue;
      if (registry.globalPool[dep] === resolved) globalPool[dep] = resolved;
      const bare = dep.includes(".") ? dep.substring(dep.indexOf(".") + 1) : dep;
      if (registry.globalPool[bare] === resolved) globalPool[bare] = resolved;
      queue.push(resolved);
    }
  }
  return {
    components,
    globalPool,
    css: cssForComponentSlice(registry, Object.keys(components)),
    schemes: [],
  };
}

/** Feature slicing inspects the COMPLETE transitive component slice, not only the
 * exposed root. Build-time adapters pass their canonical tag sets here so an
 * optional renderer/CSS module is bundled exactly when a nested dependency uses
 * it. Keeping this generic avoids a compiler -> DOM package cycle. */
export function registryUsesAnyTag(registry: Registry, tags: ReadonlySet<string>): boolean {
  const visit = (node: XmlNode): boolean => tags.has(node.tag) || node.children.some(visit);
  return Object.values(registry.components).some((component) => visit(component.root));
}

function componentTags(node: XmlNode, out: Set<string> = new Set()): Set<string> {
  if (/^[A-Z]/.test(node.tag) || node.tag.includes(".")) out.add(node.tag);
  for (const c of node.children) componentTags(c, out);
  return out;
}

/** resolveComponent, but returning the QUALIFIED key the slice must carry */
function resolveQualified(registry: Registry, callerScheme: string, tag: string): string | null {
  if (tag.includes(".")) {
    const ns = tag.substring(0, tag.indexOf("."));
    const name = tag.substring(tag.indexOf(".") + 1);
    if (ns === "shared" || ns === "global") return registry.globalPool[name] ?? null;
    return registry.components[tag] !== undefined ? tag : null;
  }
  const local = `${callerScheme}.${tag}`;
  if (registry.components[local] !== undefined) return local;
  return registry.globalPool[tag] ?? null;
}
