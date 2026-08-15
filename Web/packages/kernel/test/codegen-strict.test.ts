//
//  codegen-strict.test.ts - the W9 strict-rejection hardening (the pinned permissive-
//  emission finding, rendering-1.0-finalization.md): a beyond-subset body REJECTS at
//  compile time — `JSESubsetError` carrying the classifier's reason — instead of
//  lossy-compiling into a valid-but-wrong emission. Runtime stays fail-open (Article
//  7): the eval conveniences catch, warn one line, run null — never a crash. A thrown
//  outcome is never cached. In-grammar behavior is untouched — the conformance corpus
//  on the COMPILED executor is the proof; the portable pins here are smoke.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { StackStore } from "../src/jse/jse.ts";
import {
  JSESubsetError, compileExpression, compileBlock, evalCompiled, evalBlockCompiled,
} from "../src/compile/codegen.ts";

function isSubsetError(e: unknown): boolean {
  return e instanceof JSESubsetError && e.reason.length > 0;
}

test("strict: compileBlock rejects a beyond-subset body with a non-empty reason", () => {
  assert.throws(() => compileBlock("class Foo {}"), isSubsetError);
});

test("strict: compileExpression rejects a beyond-subset expression", () => {
  assert.throws(() => compileExpression("yield 1"), isSubsetError);
});

test("strict: a rejection is never cached — the same body throws again", () => {
  assert.throws(() => compileBlock("class Foo {}"), isSubsetError);
  assert.throws(() => compileBlock("class Foo {}"), isSubsetError);
});

test("strict: evalBlockCompiled on a beyond-subset body warns and runs null", () => {
  const warns: string[] = [];
  const saved = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  let block: unknown = "sentinel";
  let expr: unknown = "sentinel";
  try {
    block = evalBlockCompiled("class Foo {}", new StackStore(), null);
    expr = evalCompiled("yield 1", new StackStore(), null);
  } finally {
    console.warn = saved;
  }
  assert.equal(block, null);
  assert.equal(expr, null);
  assert.ok(warns.some((w) => w.includes("beyond-subset body rejected")),
    `expected the rejection warn, got: ${warns.join(" | ")}`);
});

test("strict: portable bodies compile and evaluate exactly as before", () => {
  const s = new StackStore();
  s.vars.set("count", 4);
  assert.equal(evalCompiled("count * 2 + 1", s, null), 9);        // arithmetic over a store read
  assert.equal(evalBlockCompiled("let x = count + 1; return x * 2", s, null), 10); // block with a local write
});
