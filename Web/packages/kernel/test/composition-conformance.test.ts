//
//  composition-conformance.test.ts - the attribute-binding corpus runner (TS lane).
//  Executes OpenSource/Conformance/composition/attribute-binding.json: the pure fold
//  table, the typed end-to-end table against a real store, and the recursion floor.
//  The Kotlin twin is :core CompositionConformanceTest; the Swift reference is
//  CompositionConformance on the record lane.
//
//  Missing corpus = loud failure - a silently-skipped conformance suite is how drift
//  starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { JSE, attributeBinding } from "../src/jse/jse.ts";
import { watchKey } from "../src/jse/values.ts";
import { ReactiveStore, flushEffects } from "../src/store.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/composition/attribute-binding.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`composition/attribute-binding.json not found walking up from ${import.meta.dirname}`);
    }
    dir = parent;
  }
}

type FoldCase = { name: string; template: string; kind: "static" | "value" | "text"; expr?: string };
type TypedCase = {
  name: string;
  template: string;
  vars: { [k: string]: unknown };
  type: string;
  json?: unknown;
};
type RecursionCase = { name: string; depth: number; expands: boolean };

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as {
  fold: FoldCase[];
  typed: TypedCase[];
  recursion: { cap: number; cases: RecursionCase[] };
};

test("composition corpus is present and populated", () => {
  assert.ok(corpus.fold.length > 0, "fold table is empty");
  assert.ok(corpus.typed.length > 0, "typed table is empty");
  assert.ok(corpus.recursion.cases.length > 0, "recursion table is empty");
});

for (const c of corpus.fold) {
  test(`fold: ${c.name}`, () => {
    const got = attributeBinding(c.template);
    assert.equal(got.kind, c.kind, `template ${JSON.stringify(c.template)}`);
    if (c.expr !== undefined) {
      assert.equal(got.kind === "value" ? got.expr : null, c.expr);
    }
  });
}

/** The cross-language type name for a resolved attribute value. Kotlin and Swift name
 *  the same six categories; anything outside them is a divergence, not a detail. */
function typeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v;
}

for (const c of corpus.typed) {
  test(`typed: ${c.name}`, () => {
    const store = new ReactiveStore();
    for (const [k, v] of Object.entries(c.vars)) store.jse.vars.set(k, v);
    const got = JSE.bindAttribute(c.template, store.jse, null);
    assert.equal(typeName(got), c.type, `template ${JSON.stringify(c.template)} -> ${String(got)}`);
    if (Object.prototype.hasOwnProperty.call(c, "json")) {
      assert.deepEqual(JSON.parse(JSON.stringify(got ?? null)), c.json);
    }
  });
}

// The floor itself is a RENDERER fact, so each renderer asserts its own constant
// against `recursion.cap` (TS: packages/dom composition.test.ts). What belongs here is
// that the table describes one cap and not two.
test("recursion: the table is a single consistent floor", () => {
  const cap = corpus.recursion.cap;
  assert.equal(typeof cap, "number");
  for (const c of corpus.recursion.cases) {
    assert.equal(c.depth < cap, c.expands, `recursion case ${c.name}`);
  }
  assert.ok(corpus.recursion.cases.some((c) => c.expands), "no expanding case");
  assert.ok(corpus.recursion.cases.some((c) => !c.expands), "no capped case");
});

// ── the JS-plane guard the recursion floor sits on top of ────────────────────────────
//
//  `watchKey` is the structural identity of every store write, and `jseEquals` delegates
//  to it. Cyclic data therefore killed the surface on the WRITE, before any renderer got
//  a chance to bound the render. It is not a corpus law (native data cannot express the
//  shape - Swift dictionaries and arrays are value types), so it is gated here.

test("watchKey is byte-identical for acyclic values", () => {
  const shared = { id: 1 };
  // A value under two siblings must still expand in both - the cycle guard unwinds.
  assert.equal(watchKey({ a: shared, b: shared }), watchKey({ a: { id: 1 }, b: { id: 1 } }));
  assert.notEqual(watchKey({ a: 1 }), watchKey({ a: 2 }));
  assert.notEqual(watchKey([1, 2]), watchKey([2, 1]));
});

test("watchKey terminates on a self-referencing value", () => {
  const cycle: { label: string; children: unknown[] } = { label: "loop", children: [] };
  cycle.children.push(cycle);
  const key = watchKey(cycle);
  assert.ok(key.length < 200, `cycle key ran away: ${key.length} chars`);
  assert.ok(key.includes("↺"), `no cycle marker in ${key}`);
});

test("watchKey terminates on a mutual reference", () => {
  const a: { peer?: unknown } = {};
  const b: { peer?: unknown } = { peer: a };
  a.peer = b;
  assert.ok(watchKey(a).length < 200);
  assert.ok(watchKey([a, b]).length < 400);
});

test("a cyclic value can be written to a store and read back", () => {
  const store = new ReactiveStore();
  const cycle: { n: number; self?: unknown } = { n: 1 };
  cycle.self = cycle;
  store.set("tree", cycle);
  assert.equal(store.jse.vars.get("tree"), cycle);
  // and the second write still notifies, because the key moved
  let notified = 0;
  const dispose = store.effect(() => store.eval("tree.n", null), () => { notified += 1; });
  const other: { n: number; self?: unknown } = { n: 2 };
  other.self = other;
  store.set("tree", other);
  flushEffects();
  assert.ok(notified >= 1, "a cyclic re-write did not notify");
  dispose();
});
