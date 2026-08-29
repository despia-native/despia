#!/usr/bin/env node
/* run-jse-conformance.mjs — the StackLogic JSE against the SHARED corpus.
 *
 * OpenSource/Conformance/jse/*.json is the ONE semantics contract every JSE
 * runtime must satisfy identically: Swift is the reference, Kotlin runs it on
 * every PR, the canvas editor runs it, and THIS runner is the logic editor
 * joining the same table. Live formula preview is only trustworthy if a
 * formula evaluates HERE exactly as it will on device — this is that proof.
 *
 * Usage: node run-jse-conformance.mjs [--verbose]
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const StackLogic = require(join(here, "../src/logic-editor.js"));

// Two layouts, one runner: the MONOREPO (corpus lives with the engines) and
// the PUBLIC MIRROR (mirror_public.rb vendors it as ./conformance/jse).
const CORPUS_DIR = [
  join(here, "../conformance/jse"),
  join(here, "../../Conformance/jse"),
].find(existsSync);
if (!CORPUS_DIR) { console.error("[jse-conformance] no corpus dir found (conformance/jse or OpenSource/Conformance/jse)."); process.exit(1); }
const VERBOSE = process.argv.includes("--verbose");

/* structural equality per the corpus number model */
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

const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json")).sort();
if (!files.length) { console.error("[jse-conformance] no corpus files found."); process.exit(1); }

let passed = 0;
const failures = [];
for (const file of files) {
  const { cases } = JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8"));
  for (const c of cases) {
    const scope = JSON.parse(JSON.stringify(c.scope || {}));
    let actual;
    try { actual = StackLogic.jse.evaluate(c.expression, scope); }
    catch (e) { actual = `<<threw: ${e && e.message}>>`; }
    if (eq(actual, c.expected)) {
      passed++;
      if (VERBOSE) console.log(`  ok   ${file} · ${c.name}`);
    } else {
      failures.push({ file, name: c.name, expression: c.expression, expected: c.expected, actual });
    }
  }
}

for (const f of failures) {
  console.error(`  FAIL ${f.file} · ${f.name}`);
  console.error(`       expr:     ${f.expression}`);
  console.error(`       expected: ${JSON.stringify(f.expected)}`);
  console.error(`       actual:   ${JSON.stringify(f.actual)}`);
}
console.log(`[jse-conformance] ${passed}/${passed + failures.length} cases green (${files.length} file(s)).`);
process.exit(failures.length ? 1 : 0);
