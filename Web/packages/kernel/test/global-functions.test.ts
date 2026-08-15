//
//  global-functions.test.ts - the GLOBAL FUNCTION LIBRARY (js-core.md "Shared logic — the
//  global function library"): ONE app-wide `function name(){…}` table shared by every
//  surface, registered once at boot via JSE.registerGlobalFunctions. Lookup order at a
//  named call — scope lambda → the surface's own function table (a local name SHADOWS the
//  global) → the global table → builtins — on BOTH executors (the interpreter Parser and
//  the compiled `$.call`), under the same fnDepth 32 guard. The dual-executor lookup is
//  pinned HERE; the BLOCK-level fixtures (mount routing, ordering, the runner path) are
//  Conformance/functions — function-conformance.test.ts; Kotlin twin:
//  Engine/Android core GlobalFunctionsTest.kt.
//

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { JSE, StackStore } from "../src/jse/jse.ts";
import { evalCompiled } from "../src/compile/codegen.ts";

afterEach(() => { JSE.clearGlobalFunctions(); });

test("a registered global function resolves from every surface, on BOTH executors", () => {
  JSE.registerGlobalFunctions("function tax(n) { return n * 0.2 }");
  const a = new StackStore();
  const b = new StackStore();
  assert.equal(JSE.eval("tax(50)", a, null), 10);
  assert.equal(JSE.eval("tax(50)", b, null), 10);       // a SECOND surface shares the table
  assert.equal(evalCompiled("tax(50)", a, null), 10);   // the compiled executor resolves it too
});

test("a surface-local function of the same name shadows the global", () => {
  JSE.registerGlobalFunctions("function price(n) { return n * 2 }");
  const store = new StackStore();
  JSE.registerFunctions("function price(n) { return n * 3 }", store);
  assert.equal(JSE.eval("price(5)", store, null), 15);      // the local wins
  assert.equal(evalCompiled("price(5)", store, null), 15);
  const bare = new StackStore();                            // a surface WITHOUT the local
  assert.equal(JSE.eval("price(5)", bare, null), 10);       // still sees the global
});

test("clearGlobalFunctions restores the builtin fallthrough", () => {
  const store = new StackStore();
  assert.equal(JSE.eval("round(1.4)", store, null), 1);     // the builtin
  JSE.registerGlobalFunctions("function round(n) { return 999 }");
  assert.equal(JSE.eval("round(1.4)", store, null), 999);   // the global sits BEFORE builtins
  assert.equal(evalCompiled("round(1.4)", store, null), 999);
  JSE.clearGlobalFunctions();
  assert.equal(JSE.eval("round(1.4)", store, null), 1);     // builtin again
  assert.equal(evalCompiled("round(1.4)", store, null), 1);
});

test("a global function calls another global function", () => {
  JSE.registerGlobalFunctions(
    "function tax(n) { return n * 0.2 }\nfunction total(n) { return n + tax(n) }");
  const store = new StackStore();
  assert.equal(JSE.eval("total(50)", store, null), 60);
  assert.equal(evalCompiled("total(50)", store, null), 60);
});

test("global recursion is contained by the shared fnDepth guard", () => {
  JSE.registerGlobalFunctions("function spin(n) { return spin(n + 1) }");
  const store = new StackStore();
  assert.equal(JSE.eval("spin(0) ?? 'contained'", store, null), "contained");
  assert.equal(evalCompiled("spin(0) ?? 'contained'", store, null), "contained");
  assert.equal(store.fnDepth, 0);   // the guard unwound cleanly — no leaked frames
});
