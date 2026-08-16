//
//  jstier.test.ts - the JS-TIER executor (/web/15): a beyond-subset action body runs as
//  ORDINARY JavaScript in the /web/12 sandbox fence — real JS semantics, store writes as
//  batched operations with read-after-write overlay, the identical dsx.* call surface,
//  no ambient authority (window/document/globalThis fenced), the watchdog bounds it.
//  Wiring: the ActionRunner classifies every entry and declared <action> body and routes
//  js-tier ones here (the pinned lossy-compile misbehavior is dead).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { runJsTier, type JsTierEnv } from "../src/compile/jstier.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { installJsTier } from "../src/compile/jstier.ts";
import { ReactiveStore } from "../src/store.ts";
import type { Dict } from "../src/jse/values.ts";

function envWith(overrides: Partial<JsTierEnv> & { state?: Map<string, unknown> }): { env: JsTierEnv; writes: Array<[string, unknown]>; errors: string[] } {
  const state = overrides.state ?? new Map<string, unknown>();
  const writes: Array<[string, unknown]> = [];
  const errors: string[] = [];
  const env: JsTierEnv = {
    read: (p) => state.get(p),
    write: (p, v) => { writes.push([p, v]); state.set(p, v); },
    callAction: async () => null,
    callModule: async () => ({ ok: true, data: null }),
    emitEvent: () => {},
    log: () => {},
    error: (code) => { errors.push(code); },
    ...overrides,
  };
  return { env, writes, errors };
}

test("jstier: real JS semantics — class, labeled loop, generator all run", async () => {
  const { env, writes } = envWith({ state: new Map([["count", 2]]) });
  await runJsTier(`
    class Adder { constructor(n) { this.n = n } add(x) { return x + this.n } }
    const a = new Adder(10);
    let total = 0;
    outer: for (let i = 0; i < 5; i++) { if (i === 3) break outer; total += i; }
    function* seq() { yield 1; yield 2; }
    for (const v of seq()) total += v;
    count = a.add(total) + count;
  `, env);
  // total = (0+1+2) + (1+2) = 6 → a.add(6) = 16 → + count(2) = 18
  assert.deepEqual(writes, [["count", 18]]);
});

test("jstier: read-after-write overlay + batched application order", async () => {
  const applied: string[] = [];
  const { env } = envWith({
    state: new Map([["x", 1]]),
    write: (p, v) => { applied.push(`${p}=${String(v)}`); },
  });
  await runJsTier(`x = x + 1; y = x * 10;`, env);   // overlay: y reads the pending x=2
  assert.deepEqual(applied, ["x=2", "y=20"]);
});

test("jstier: the fence — window/document/globalThis are unreachable, stdlib passes", async () => {
  const { env, writes } = envWith({});
  await runJsTier(`
    probe = typeof window + ':' + typeof document + ':' + typeof globalThis;
    computed = Math.max(1, 2) + JSON.parse('[3]')[0];
  `, env);
  const dict = new Map(writes);
  assert.equal(dict.get("probe"), "undefined:undefined:undefined");
  assert.equal(dict.get("computed"), 5);
});

test("jstier: the dsx surface — variable read/write, module envelope, action, event", async () => {
  const calls: string[] = [];
  const { env, writes } = envWith({
    state: new Map([["dsx.variable.count", 4]]),
    callModule: async (chain, args) => { calls.push(`m:${chain}:${JSON.stringify(args)}`); return { ok: true, data: "pong" }; },
    callAction: async (name) => { calls.push(`a:${name}`); return 7; },
    emitEvent: (name) => { calls.push(`e:${name}`); },
  });
  await runJsTier(`
    class Dummy {}   // force the JS tier shape
    dsx.variable.count = dsx.variable.count + 1;
    const r = await dsx.module.device.ping({ n: 1 });
    reply = r.ok ? r.data : 'fail';
    acted = await dsx.action.save({});
    dsx.event('done', { ok: true });
  `, env);
  const dict = new Map(writes);
  assert.equal(dict.get("dsx.variable.count"), 5);
  assert.equal(dict.get("reply"), "pong");
  assert.equal(dict.get("acted"), 7);
  assert.deepEqual(calls, ['m:device.ping:{"n":1}', "a:save", "e:done"]);
});

test("jstier: a throw still applies the pre-throw writes, then propagates", async () => {
  const { env, writes } = envWith({});
  await assert.rejects(
    () => runJsTier(`before = 'landed'; throw new Error('boom'); after = 'never';`, env),
    /boom/,
  );
  assert.deepEqual(writes, [["before", "landed"]]);
});

test("jstier: the watchdog bounds a hung body and reports js_tier_timeout", async () => {
  const { env, errors, writes } = envWith({ timeoutMs: 50 });
  await runJsTier(`progress = 'made'; await new Promise(() => {});`, env);
  assert.deepEqual(errors, ["js_tier_timeout"]);
  assert.deepEqual(writes, [["progress", "made"]]);   // the prefix still applies
});

test("runner wiring: an escalated <action> body writes the real store; jse bodies keep the interpreter", async () => {
  installJsTier();   // the dom boot does this on a full surface; embeds never do
  const store = new ReactiveStore();
  store.jse.vars.set("count", 1);
  const runEnv = makeRunEnv(store);
  runEnv.actions.set("fancy", { body: "class C { v() { return 40 } }\ncount = new C().v() + count;", inputs: {} });
  runEnv.actions.set("plain", { body: "count = count + 1", inputs: {} });
  const runner = new ActionRunner(runEnv);
  await runner.run("fancy");
  assert.equal(store.jse.vars.get("count"), 41);
  await runner.run("plain");
  assert.equal(store.jse.vars.get("count"), 42);
});
