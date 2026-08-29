//
//  statement-corpus.ts - EVERY CODE BODY IN THIS REPO, harvested from the files themselves.
//
//  A cost model quoted on its own fixtures is a cost model quoting itself. The statement
//  canvas draws what authors wrote, so the honest sample is what authors wrote: every
//  `<action>`, every `<formula>`, every computed `<variable>` and every `on:*` handler in
//  every `.dsx` under the four trees named below. The harvest is the same rule `edit.ts`'s
//  `logicBodies` applies when the Studio lists a document's bodies - a plain `<variable>` is
//  a seed, not logic - so the corpus is exactly the workload the surface is pointed at.
//
//  It lives in test/ rather than beside the model, next to `expr-corpus.ts` which is here for
//  the same reason: `flowcost.ts` is pure and must run anywhere, and a module that
//  walks an absolute path is a module that runs in one checkout.
//
//    node packages/cli/test/statement-corpus.ts            the distribution and the bands
//    node packages/cli/test/statement-corpus.ts --shape    statements, depth, screenfuls
//    node packages/cli/test/statement-corpus.ts --worst    the ten that waste the most
//

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDsx, type XmlNode } from "@despia-native/compiler/xml";
import { bodyLegibility, distribution } from "../src/flowcost.ts";

/** The repo root, from this file's own location - no environment variable, no cwd. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The four trees the measurement is quoted over: the shipped modules, the two web
 *  properties, and the whole open drop. */
const TREES = [
  "ClosedSource/DSX/Modules", "ClosedSource/Dashboard", "ClosedSource/Website", "OpenSource",
];

const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor", "coverage"]);

export type HarvestedBody = {
  file: string;
  id: string;
  kind: "action" | "formula" | "variable" | "handler";
  name: string;
  /** RAW bytes as they sit in the file: entities intact, because that is what the
   *  projection reads and what a span addresses. */
  source: string;
};

/* NOT EVERY `on:` ATTRIBUTE IS A BODY. `on:change.throttle="60"` is a MODIFIER carrying a
   number - `compiler/src/component.ts` reads it with `parseInt`, and `screengraph.ts` strips
   the suffix to find the handler it belongs to - while `on:input.jump="fire()"` is a real
   handler with a dotted event name. The two are told apart by the modifier word, which is the
   same list the compiler knows.

   The Studio does NOT make this distinction: `edit.ts`'s `logicBodies` takes any attribute
   starting with `on:`, so the logic panel lists 31 bodies named `<slider> on:change.throttle`
   whose whole program is `60`, drawn as a Custom Code card between a Start and an End pill.
   That is a defect in the body index, not in the projection, and it is reported rather than
   fixed here - this file only declines to measure a canvas nobody meant to draw. */
const MODIFIERS: ReadonlySet<string> = new Set(["throttle", "debounce"]);

function isModifier(attr: string): boolean {
  const parts = attr.slice(3).split(".");
  return parts.length > 1 && MODIFIERS.has(parts[parts.length - 1]!);
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) walk(path, out);
    else if (entry.endsWith(".dsx")) out.push(path);
  }
}

/** Every `.dsx` in the four trees, in a stable order. */
export function corpusFiles(): string[] {
  const out: string[] = [];
  for (const tree of TREES) walk(join(REPO, tree), out);
  return out.sort();
}

/** Every code body in the corpus. Total: a document the parser refuses contributes nothing
 *  and does not stop the walk. */
export function harvestBodies(): HarvestedBody[] {
  const out: HarvestedBody[] = [];
  for (const file of corpusFiles()) {
    const source = readFileSync(file, "utf8");
    let root: XmlNode;
    try { root = parseDsx(source); } catch { continue; }
    const rel = relative(REPO, file);
    const head = root.children.find((c) => c.tag === "head");
    for (const decl of head?.children ?? []) {
      const name = decl.attrs["as"];
      if (name === undefined) continue;
      if ((decl.text ?? "").trim() === "") continue;
      if (decl.tag !== "action" && decl.tag !== "formula"
        && !(decl.tag === "variable" && decl.attrs["computed"] === "true")) continue;
      const span = decl.textSpan;
      out.push({
        file: rel, id: `${decl.tag}:${name}`, kind: decl.tag as HarvestedBody["kind"], name,
        source: span !== undefined ? source.substring(span.start, span.end) : decl.text ?? "",
      });
    }
    const inline = (node: XmlNode, path: number[]): void => {
      for (const [attr, value] of Object.entries(node.attrs)) {
        if (!attr.startsWith("on:") || value.trim() === "") continue;
        if (isModifier(attr)) continue;
        const span = node.attrSpans?.[attr]?.value;
        out.push({
          file: rel, id: `${attr}@${path.join(".")}`, kind: "handler",
          name: `<${node.tag}> ${attr}`,
          source: span !== undefined ? source.substring(span.start, span.end) : value,
        });
      }
      node.children.forEach((child, index) => inline(child, [...path, index]));
    };
    root.children.forEach((child, index) => { if (child.tag !== "head") inline(child, [index]); });
  }
  return out;
}

// - the walk, as a script - 
function pad(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function padr(s: string, w: number): string { return s.length >= w ? s : s + " ".repeat(w - s.length); }
function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
}

if (typeof process !== "undefined" && (process.argv[1] ?? "").endsWith("statement-corpus.ts")) {
  const bodies = harvestBodies();
  const measured = bodies.map((b) => ({ b, m: bodyLegibility(b.source) }));
  if (process.argv.includes("--shape")) {
    const st = measured.map((r) => r.m.statements);
    console.log(`files ${corpusFiles().length}   bodies ${bodies.length}   `
      + `not exact ${measured.filter((r) => !r.m.exact).length}`);
    console.log(`statements  p50 ${pct(st, 0.5)}  p75 ${pct(st, 0.75)}  p90 ${pct(st, 0.9)}  `
      + `p99 ${pct(st, 0.99)}  max ${Math.max(...st)}  mean ${(st.reduce((a, b) => a + b, 0) / st.length).toFixed(2)}`);
    for (const n of [1, 2, 3, 5, 10, 20]) {
      console.log(`  at most ${pad(String(n), 2)} statements: `
        + `${(measured.filter((r) => r.m.statements <= n).length / measured.length * 100).toFixed(1)}%`);
    }
    const depths = measured.map((r) => r.m.text.depth);
    console.log("nesting depth  " + [0, 1, 2, 3, 4, 5].map((d) =>
      `${d}:${depths.filter((x) => x === d).length}`).join("  "));
    const over = (f: (r: typeof measured[number]) => boolean): string =>
      `${(measured.filter(f).length / measured.length * 100).toFixed(1)}%`;
    console.log(`drawing height p50 ${pct(measured.map((r) => r.m.census.height), 0.5)}  `
      + `p90 ${pct(measured.map((r) => r.m.census.height), 0.9)}  `
      + `max ${Math.max(...measured.map((r) => r.m.census.height))}`);
    console.log(`over one screen: drawing ${over((r) => r.m.census.height > 1050)}  `
      + `text ${over((r) => r.m.text.lines * 17 > 1050)}`);
    for (const kind of ["handler", "variable", "formula", "action"]) {
      const g = measured.filter((r) => r.b.kind === kind);
      if (g.length === 0) continue;
      console.log(`  ${padr(kind, 9)} n=${pad(String(g.length), 5)}  `
        + `p50 stmt ${pad(String(pct(g.map((r) => r.m.statements), 0.5)), 3)}  `
        + `p90 ${pad(String(pct(g.map((r) => r.m.statements), 0.9)), 3)}  `
        + `one-statement ${(g.filter((r) => r.m.statements === 1).length / g.length * 100).toFixed(0)}%  `
        + `ratio p50 ${pct(g.map((r) => r.m.ratio), 0.5).toFixed(2)}`);
    }
    process.exit(0);
  }
  const d = distribution(bodies.map((b) => b.source));
  if (process.argv.includes("--worst")) {
    for (const row of d.worstByExcess) {
      console.log(`${pad(row.excess.toFixed(1), 7)}  x${row.ratio.toFixed(2)}  `
        + JSON.stringify(row.source.replace(/\s+/g, " ").trim().slice(0, 96)));
    }
    process.exit(0);
  }
  console.log(`bodies ${d.n}   ratio p50 ${d.p50}  p90 ${d.p90}  p99 ${d.p99}  `
    + `min ${d.min}  max ${d.max}`);
  console.log(`crossover: ${d.crossover === null ? "none" : `${d.crossover} statements`}`);
  console.log("");
  console.log(padr("band", 9) + pad("n", 6) + pad("p50", 8) + pad("min", 8) + pad("max", 8) + pad("over 1", 8));
  console.log("-".repeat(47));
  for (const b of d.bands) {
    console.log(padr(b.band, 9) + pad(String(b.n), 6) + pad(b.p50.toFixed(2), 8)
      + pad(b.min.toFixed(2), 8) + pad(b.max.toFixed(2), 8) + pad(String(b.over), 8));
  }
}
