//
//  hardening.test.ts - crash/hang pins that can't ride the conformance corpus
//  (adversarial inputs, runner-level seams). Everything here must be TOTAL: contained
//  null / warn, never a throw, never a stall. The corpus twins live in
//  OpenSource/Conformance/jse/hardening-001.json + actions/actions.json.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { JSE, StackStore } from "../src/jse/jse.ts";
import { compileExpression, evalCompiled } from "../src/compile/codegen.ts";
import { ReactiveStore } from "../src/store.ts";
import { ActionRunner, makeRunEnv, RunnerFetchSeam } from "../src/runner.ts";
import { string, type Dict } from "../src/jse/values.ts";

function store(): StackStore { return new StackStore(); }

function runner(): { r: ActionRunner; s: ReactiveStore } {
  const s = new ReactiveStore();
  const r = new ActionRunner(makeRunEnv(s));
  return { r, s };
}

// ── F1: parser recursion is depth-capped (500-deep parens must not blow the stack) ──

test("hardening/deep-parens-eval-returns-null", () => {
  const expr = "(".repeat(500) + "1" + ")".repeat(500);
  const v = JSE.eval(expr, store(), null);
  assert.equal(v, null);
});

test("hardening/deep-parens-compile-does-not-throw", () => {
  const expr = "(".repeat(500) + "1" + ")".repeat(500);
  const program = compileExpression(expr);
  assert.equal(typeof program.code, "string");
  const v = evalCompiled(expr, store(), null);
  assert.equal(v, null);
});

test("hardening/deep-template-nesting-does-not-crash", () => {
  // 64 levels of `${`…`}` nesting — past the hole-depth cap the hole rides as text
  let s = "1";
  for (let i = 0; i < 64; i++) s = "`${" + s + "}`";
  const v = JSE.eval(s, store(), null);
  assert.equal(typeof v, "string"); // a string either way — never a stack overflow
});

test("hardening/actionrunner-deep-input-resolves", async () => {
  const { r } = runner();
  const expr = "x = " + "(".repeat(500) + "1" + ")".repeat(500);
  await r.run(expr); // must resolve, not reject / crash
});

test("hardening/JSE JSON bounds deep, cyclic, and oversized authored values", () => {
  const s = store();
  let deep: Dict = { leaf: true };
  for (let depth = 0; depth < 130; depth += 1) deep = { next: deep };
  s.vars.set("deep", deep);
  assert.equal(JSE.eval("JSON.stringify(deep)", s, null), null);

  const cyclic: Dict = {};
  cyclic["self"] = cyclic;
  s.vars.set("cyclic", cyclic);
  assert.equal(JSE.eval("JSON.stringify(cyclic)", s, null), null);

  s.vars.set("raw", "\"" + "x".repeat(4 * 1024 * 1024 + 1) + "\"");
  assert.equal(JSE.eval("JSON.parse(raw)", s, null), null);

  s.vars.set("raw", "[".repeat(130) + "0" + "]".repeat(130));
  assert.equal(JSE.eval("JSON.parse(raw)", s, null), null);
});

test("hardening/JSE JSON.parse preserves __proto__ as inert own data", () => {
  const s = store();
  s.vars.set("raw", '{"__proto__":{"polluted":true},"safe":1}');
  const parsed = JSE.eval("JSON.parse(raw)", s, null) as Dict;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), true);
  assert.equal(parsed["polluted"], undefined);
  assert.equal(({} as Dict)["polluted"], undefined);
  assert.equal(parsed["safe"], 1);
});

// ── F14: interior await — Promises coerce to null (+ authoring warn), never concat ──

test("hardening/interior-await-coerces-promise-to-null", async () => {
  const { r, s } = runner();
  const warns: string[] = [];
  const saved = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try {
    await r.run("r = 1 + await Promise.resolve(1)");
  } finally {
    console.warn = saved;
  }
  const v = s.jse.vars.get("r");
  assert.notEqual(string(v), "1[object Promise]");
  assert.equal(string(v), "1"); // 1 + null → the JSE concat of "1" and ""
  assert.ok(warns.some((w) => w.includes("interior await")), `expected the interior-await warn, got: ${warns.join(" | ")}`);
});

// ── F16: fetch: effect with a bare unquoted URL reaches the seam whole ──

test("hardening/fetch-effect-bare-url-reconstructed", async () => {
  const seen: string[] = [];
  const saved = RunnerFetchSeam.impl;
  RunnerFetchSeam.impl = (url) => { seen.push(url); return Promise.resolve({ ok: true, status: 200, data: null }); };
  try {
    const { r } = runner();
    await r.run("fetch: r = GET https://api.example.com/users");
  } finally {
    RunnerFetchSeam.impl = saved;
  }
  assert.deepEqual(seen, ["https://api.example.com/users"]);
});

test("hardening/fetch-effect-quoted-url-still-works", async () => {
  const seen: string[] = [];
  const saved = RunnerFetchSeam.impl;
  RunnerFetchSeam.impl = (url) => { seen.push(url); return Promise.resolve({ ok: true, status: 200, data: null }); };
  try {
    const { r } = runner();
    await r.run("fetch: r = GET 'https://api.example.com/q'");
  } finally {
    RunnerFetchSeam.impl = saved;
  }
  assert.deepEqual(seen, ["https://api.example.com/q"]);
});

test("hardening/action fetch rejects oversized and cyclic bodies before transport", async () => {
  const savedSeam = RunnerFetchSeam.impl;
  const savedFetch = globalThis.fetch;
  let calls = 0;
  RunnerFetchSeam.impl = null;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  try {
    const { r, s } = runner();
    s.set("payload", { value: "x".repeat(4 * 1024 * 1024 + 1) });
    await r.run("const res = await fetch('https://api.example.test/upload', { method: 'POST', body: payload }); code = res.error");
    assert.equal(s.eval("code"), "request_too_large");

    const cyclic: Dict = {};
    cyclic["self"] = cyclic;
    const cycleStore = new ReactiveStore();
    const cycleRunner = new ActionRunner(makeRunEnv(cycleStore, { item: { payload: cyclic } }));
    await cycleRunner.run("const res = await fetch('https://api.example.test/upload', { method: 'POST', body: payload }); cycleCode = res.error");
    assert.equal(cycleStore.eval("cycleCode"), "invalid_request");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = savedFetch;
    RunnerFetchSeam.impl = savedSeam;
  }
});

test("hardening/action fetch bounds responses and blocks HTTPS downgrade", async () => {
  const savedSeam = RunnerFetchSeam.impl;
  const savedFetch = globalThis.fetch;
  RunnerFetchSeam.impl = null;
  let mode: "large" | "downgrade" = "large";
  globalThis.fetch = async () => {
    if (mode === "large") {
      return new Response("small", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(16 * 1024 * 1024 + 1),
        },
      });
    }
    const response = new Response("unsafe", { status: 200 });
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "http://api.example.test/private",
    });
    return response;
  };
  try {
    const { r, s } = runner();
    await r.run("const res = await fetch('https://api.example.test/data'); sizeCode = res.error");
    assert.equal(s.eval("sizeCode"), "response_too_large");

    mode = "downgrade";
    await r.run("const res = await fetch('https://api.example.test/private'); redirectCode = res.error");
    assert.equal(s.eval("redirectCode"), "insecure_redirect");
  } finally {
    globalThis.fetch = savedFetch;
    RunnerFetchSeam.impl = savedSeam;
  }
});

// ── F17: a quoted `{` inside a template hole must not corrupt ASI downstream ──

test("hardening/template-hole-quoted-brace", async () => {
  const { r, s } = runner();
  await r.run("x = `${ '{' }`\ny = 2");
  assert.equal(s.jse.vars.get("x"), "{");
  assert.equal(s.jse.vars.get("y"), 2);
});

// ── F18: lone-CR line endings split statements like \n ──

test("hardening/lone-cr-line-endings", async () => {
  const { r, s } = runner();
  await r.run("x = 1\ry = 2");
  assert.equal(s.jse.vars.get("x"), 1);
  assert.equal(s.jse.vars.get("y"), 2);
});

test("an attribute declared `default=\"\"` reads as the empty string, not as absent", () => {
  //  27 attributes in this tree are declared that way, the Studio's own surfaces included.
  //  An empty expression evaluated to null, so `dsx.attribute.x != ''` was TRUE for an
  //  attribute nobody set - which is how an EmptyState rendered a button with no label.
  const store = new ReactiveStore();
  store.jse.attrDefaults.set("action", "");
  store.jse.attrDefaults.set("title", "'Untitled'");
  store.jse.vars.set("dsx.attribute", {});
  assert.equal(JSE.eval("dsx.attribute.action", store.jse, null), "");
  assert.equal(JSE.eval("dsx.attribute.title", store.jse, null), "Untitled");
  assert.equal(JSE.eval("dsx.attribute.action != ''", store.jse, null), false);
  // a SUPPLIED value still wins over the default
  store.jse.vars.set("dsx.attribute", { action: "Browse" });
  assert.equal(JSE.eval("dsx.attribute.action", store.jse, null), "Browse");
});
