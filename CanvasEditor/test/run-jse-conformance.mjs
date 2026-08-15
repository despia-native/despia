#!/usr/bin/env node
/* run-jse-conformance.mjs - the StackCanvas JSE against the SHARED corpus.
 *
 * OpenSource/Conformance/jse/*.json is the ONE semantics contract every JSE
 * runtime must satisfy identically: Swift is the reference (the Codemagic
 * `conformance-record` lane authoritates `expected`), Kotlin runs it on every
 * PR (Engine/Android ConformanceTest), and THIS runner is the JS runtime
 * joining the same table (the corpus _note's "TS joins per /web/10 W0").
 * The canvas editor is only trustworthy if a formula evaluates HERE exactly
 * as it will on device - this is that proof, wired into
 * `build_canvas_editor.rb --check` (the CI gate).
 *
 * Comparison follows the corpus's stated number model: all numbers Double,
 * integral doubles compare as ints; plain dicts/arrays compare structurally
 * (deep, key-order-insensitive); null/undefined both satisfy an expected null.
 *
 * Usage: node run-jse-conformance.mjs [--verbose]
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const StackCanvas = require(join(here, "../src/canvas-editor.js"));

// Two layouts, one runner: the MONOREPO (the corpus lives with the engines)
// and the PUBLIC MIRROR (mirror_public.rb vendors the corpus as ./conformance/jse
// so `npm test` runs standalone there).
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
    // deep-copy the scope: cases may mutate (assignment expressions), and the
    // corpus object must stay pristine across cases.
    const scope = JSON.parse(JSON.stringify(c.scope || {}));
    let actual;
    try { actual = StackCanvas.jse.evaluate(c.expression, scope); }
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

// The public editor accepts DSX directly, outside the native/Web compiler
// intake paths. Pin the same hostile-input boundaries here so the mirror's
// ordinary `npm test` and build_canvas_editor.rb --check both exercise them.
const limits = StackCanvas.DSX_PARSE_LIMITS;
const parserCases = [
  ["CommonJS/default/named export contract stays aligned with declarations", () => {
    assert.equal(typeof StackCanvas, "function");
    assert.equal(StackCanvas.default, StackCanvas);
    assert.equal(StackCanvas.StackCanvas, StackCanvas);
    assert.equal(StackCanvas.DespiaStackEditor, null);
  }],
  ["raw functions preserve code and the following UI", () => {
    const body = `function choose(x) { return x < 2 && "<tag>" !== ""; }`;
    const parsed = StackCanvas.parseDSX(
      `<stack><head><functions>${body}</functions></head><text value="still here"/></stack>`,
    );
    assert.equal(parsed.tree.tag, "stack");
    assert.equal(parsed.tree.children.length, 1);
    assert.equal(parsed.tree.children[0].attrs.value, "still here");
    assert.deepEqual(parsed.logic.functions, [body]);
  }],
  ["document-byte boundary is inclusive and overflow is stable", () => {
    const wrapperBytes = "<stack></stack>".length;
    const atLimit = `<stack>${"x".repeat(limits.maxDocumentBytes - wrapperBytes)}</stack>`;
    assert.equal(new TextEncoder().encode(atLimit).byteLength, limits.maxDocumentBytes);
    assert.equal(StackCanvas.parseDSX(atLimit).tree.tag, "stack");
    const overflow = `<stack>${"x".repeat(limits.maxDocumentBytes - wrapperBytes + 1)}</stack>`;
    assert.throws(
      () => StackCanvas.parseDSX(overflow),
      (error) => error instanceof StackCanvas.DsxParseError &&
        /document exceeds 4194304-byte limit/.test(error.message),
    );
  }],
  ["node boundary is inclusive and overflow is stable", () => {
    const atLimit = `<stack>${"<text/>".repeat(limits.maxNodes - 1)}</stack>`;
    assert.equal(StackCanvas.parseDSX(atLimit).tree.children.length, limits.maxNodes - 1);
    const overflow = `<stack>${"<text/>".repeat(limits.maxNodes)}</stack>`;
    assert.throws(
      () => StackCanvas.parseDSX(overflow),
      (error) => error instanceof StackCanvas.DsxParseError &&
        /node count exceeds 50000-node limit/.test(error.message),
    );
  }],
  ["depth boundary is inclusive and hostile nesting never leaks RangeError", () => {
    const nested = (depth) => "<stack>".repeat(depth) + "ok" + "</stack>".repeat(depth);
    assert.equal(StackCanvas.parseDSX(nested(limits.maxDepth)).tree.tag, "stack");
    for (const depth of [limits.maxDepth + 1, 8_192]) {
      assert.throws(
        () => StackCanvas.parseDSX(nested(depth)),
        (error) => error instanceof StackCanvas.DsxParseError &&
          error.name === "DsxParseError" &&
          /nesting depth exceeds 256-level limit/.test(error.message),
      );
    }
    assert.throws(
      () => StackCanvas.parseDSX("<stack><text></stack></text>"),
      (error) => error instanceof StackCanvas.DsxParseError && /mismatched close/.test(error.message),
    );
  }],
];

let parserPassed = 0;
const parserFailures = [];
for (const [name, run] of parserCases) {
  try { run(); parserPassed += 1; }
  catch (error) { parserFailures.push({ name, error }); }
}
for (const failure of parserFailures) {
  console.error(`  FAIL canvas parser · ${failure.name}`);
  console.error(`       ${failure.error?.stack ?? failure.error}`);
}
console.log(`[canvas-parser] ${parserPassed}/${parserCases.length} cases green.`);
process.exit(failures.length || parserFailures.length ? 1 : 0);
