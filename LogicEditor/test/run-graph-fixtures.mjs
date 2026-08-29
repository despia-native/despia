#!/usr/bin/env node
/* run-graph-fixtures.mjs — the formula-graph ⇄ JSE contract
 * (OpenSource/Conformance/graph/, see its README for the three laws).
 *
 * Per case:
 *   1. compile(graph) === jse                       byte-stable emit
 *   2. evaluateGraph(graph, scope).result == expected     corpus semantics
 *   3. lift(jse) → compile → evaluate == expected         round-trip is total
 *      + compile(lift(jse)) === jse when canonical (the default)
 *
 * Usage: node run-graph-fixtures.mjs [--verbose]
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const StackLogic = require(join(here, "../src/logic-editor.js"));

const DIR = [
  join(here, "../conformance/graph"),
  join(here, "../../Conformance/graph"),
].find(existsSync);
if (!DIR) { console.error("[graph-fixtures] no fixture dir found (conformance/graph or OpenSource/Conformance/graph)."); process.exit(1); }
const VERBOSE = process.argv.includes("--verbose");

function eq(a, b) {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => eq(v, b[i]));
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && eq(a[k], b[k]));
  }
  return a === b;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
let passed = 0;
const failures = [];
const fail = (name, law, detail) => failures.push({ name, law, detail });

for (const file of files) {
  const { cases } = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  for (const c of cases) {
    const scope = () => JSON.parse(JSON.stringify(c.scope || {}));
    let ok = true;

    if (!c.liftOnly) {
      let compiled;
      try { compiled = StackLogic.compile(c.graph); }
      catch (e) { compiled = `<<threw: ${e && e.message}>>`; }
      if (compiled !== c.jse) { ok = false; fail(c.name, "compile==jse", `got ${JSON.stringify(compiled)}`); }
      const r = StackLogic.evaluateGraph(c.graph, scope()).result;
      if (!eq(r, c.expected)) { ok = false; fail(c.name, "evaluate(graph)", `got ${JSON.stringify(r)}`); }
    }

    let lifted, reText;
    try {
      lifted = StackLogic.lift(c.jse, (c.graph || {}).functions);
      reText = StackLogic.compile(lifted);
    } catch (e) {
      ok = false; fail(c.name, "lift-total", `threw: ${e && e.message}`);
    }
    if (lifted) {
      const r2 = StackLogic.evaluateGraph(lifted, scope()).result;
      if (!eq(r2, c.expected)) { ok = false; fail(c.name, "evaluate(lift(jse))", `got ${JSON.stringify(r2)} via ${JSON.stringify(reText)}`); }
      if (c.canonical !== false && reText !== c.jse) { ok = false; fail(c.name, "compile(lift(jse))==jse", `got ${JSON.stringify(reText)}`); }
    }

    if (ok) { passed++; if (VERBOSE) console.log(`  ok   ${file} · ${c.name}`); }
  }
}

for (const f of failures) console.error(`  FAIL ${f.name} · ${f.law}\n       ${f.detail}`);
console.log(`[graph-fixtures] ${passed} case(s) green, ${failures.length} law violation(s) (${files.length} file(s)).`);
process.exit(failures.length ? 1 : 0);
