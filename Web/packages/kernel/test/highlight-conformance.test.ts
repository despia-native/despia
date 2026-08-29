// The `<code>` highlighter against the shared corpus. The expectation is a MASK - one letter
// per code unit - so a failure prints the source and the two masks aligned under each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { highlight, highlightMask, HI_LETTER } from "../src/jse/highlight.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(
  join(here, "../../../../Conformance/code/tokens.json"), "utf8",
)) as { cases: { name: string; source: string; mask: string }[]; _letters: Record<string, string> };

test("the highlighter matches the shared corpus", () => {
  assert.ok(corpus.cases.length >= 30, "the corpus should not shrink silently");
  for (const c of corpus.cases) {
    const got = highlightMask(c.source);
    if (got !== c.mask) {
      assert.fail(`${c.name}\n  src  ${JSON.stringify(c.source)}\n  want ${c.mask}\n  got  ${got}`);
    }
  }
});

test("every letter in the corpus is one the scanner can emit", () => {
  assert.deepEqual(corpus._letters, HI_LETTER);
  const known = new Set(Object.values(HI_LETTER));
  for (const c of corpus.cases) for (const ch of c.mask) assert.ok(known.has(ch), `${c.name}: ${ch}`);
});

test("the spans tile the source - no gap, no overlap, nothing dropped", () => {
  const inputs = [
    ...corpus.cases.map((c) => c.source),
    " ", "a".repeat(5000), "`${`${`${x}`}`}`", "/*".repeat(400), "'".repeat(300),
  ];
  for (const src of inputs) {
    const toks = highlight(src);
    let at = 0;
    for (const t of toks) {
      assert.equal(t.start, at, `gap or overlap in ${JSON.stringify(src.slice(0, 40))}`);
      assert.ok(t.end > t.start, "an empty span is not a token");
      at = t.end;
    }
    assert.equal(at, src.length, `did not reach the end of ${JSON.stringify(src.slice(0, 40))}`);
  }
});

test("adjacent spans never share a kind - the scanner coalesces", () => {
  for (const c of corpus.cases) {
    const toks = highlight(c.source);
    for (let i = 1; i < toks.length; i++) {
      assert.notEqual(toks[i]!.kind, toks[i - 1]!.kind, `${c.name}: split run at ${toks[i]!.start}`);
    }
  }
});

test("fuzz: any input scans, tiles and terminates", () => {
  const alphabet = "abz09 \n\t'\"`/*\\${}()[].,;:?!+-=<>&|~^_#@";
  let seed = 20260824;
  const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 4000; n++) {
    let src = "";
    const len = Math.floor(rand() * 60);
    for (let i = 0; i < len; i++) src += alphabet[Math.floor(rand() * alphabet.length)];
    const toks = highlight(src);
    let at = 0;
    for (const t of toks) { assert.equal(t.start, at); at = t.end; }
    assert.equal(at, src.length, JSON.stringify(src));
  }
});
