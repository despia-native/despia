//
//  nav-view.test.ts — the `nav.*` reserved view (the router's published back-affordance
//  plane: canPop · depth · stack). The Kotlin router has published this contract since the
//  beginning (Router.apply(), pinned by RouterTest) and StackReference documents the reads;
//  the web resolver simply had no branch for it, so `dsx.variable.nav.canPop` read absent
//  on exactly one renderer and the documented guarded-back pattern silently fell to its
//  else. These pins keep the view resolving, reserved, and spelled every way the docs
//  spell it. The end-to-end half (a real pop under a real pointer) is
//  packages/dom/oracle/skills-examples-browser.ts.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { JSE, JSESeams, StackStore } from "../src/jse/jse.ts";

function withNav<T>(body: () => T): T {
  const prior = JSESeams.stateVars;
  JSESeams.stateVars = () => ({
    nav: { canPop: true, depth: 2, stack: [{ path: "/" }, { path: "/detail" }] },
    route: { path: "/detail" },
  });
  try {
    return body();
  } finally {
    JSESeams.stateVars = prior;
  }
}

test("nav resolves from the app plane under every documented spelling", () => {
  withNav(() => {
    const store = new StackStore();
    // the StackReference spelling: `dsx.variable.nav.canPop` (normalizes to the reserved view)
    assert.equal(JSE.lookup("dsx.variable.nav.canPop", store, null), true);
    assert.equal(JSE.lookup("dsx.variable.nav.depth", store, null), 2);
    // the bare-expression spelling a visible-if uses
    assert.equal(JSE.lookup("nav.canPop", store, null), true);
    // the stack itself is readable (walkable like any value)
    assert.equal(JSE.lookup("nav.stack.1.path", store, null), "/detail");
    // the global plane keeps working too — one publish, every spelling
    assert.equal(JSE.lookup("dsx.global.nav.depth", store, null), 2);
  });
});

test("nav is reserved: a surface variable cannot shadow the router's plane", () => {
  withNav(() => {
    const store = new StackStore();
    store.vars.set("nav", { canPop: false, depth: 99 });
    // same behavior as `route`: the reserved view answers before the surface store
    assert.equal(JSE.lookup("dsx.variable.nav.canPop", store, null), true);
    assert.equal(JSE.lookup("nav.depth", store, null), 2);
  });
});

test("an empty app plane reads as absent, never a throw", () => {
  const store = new StackStore();
  assert.equal(JSE.lookup("nav.canPop", store, null), null);
  assert.equal(JSE.lookup("dsx.variable.nav.depth", store, null), null);
});
