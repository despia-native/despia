//
//  kernel.test.ts - store / runner / bus fixtures: batching, per-binding invalidation,
//  rowWrite-style dotted paths, action statements (the /web/10 G1 store/action set),
//  module dispatch envelopes, declared state, watch semantics.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, DSXState, flushEffects } from "../src/store.ts";
import { ActionRunner, makeRunEnv, RunnerFetchSeam } from "../src/runner.ts";
import { ModuleRegistry, defineModule, ModuleCallError, ERROR_NOT_LOADED, makeDsx } from "../src/bus.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, type Dict } from "../src/jse/values.ts";

function freshStore(): ReactiveStore {
  return new ReactiveStore();
}

test("store: effect fires once initially and on tracked change only", () => {
  const store = freshStore();
  store.set("count", 1);
  store.set("other", "x");
  const seen: unknown[] = [];
  store.effect(() => store.eval("count + 1"), (v) => seen.push(v));
  assert.deepEqual(seen, [2]); // the first run is synchronous — mount sees real content
  store.set("other", "y"); // untracked key — no re-run
  flushEffects();
  assert.deepEqual(seen, [2]);
  store.set("count", 5);
  flushEffects();
  assert.deepEqual(seen, [2, 6]);
  store.set("count", 5); // deep-equal write elided
  flushEffects();
  assert.deepEqual(seen, [2, 6]);
});

test("store: the scheduler coalesces N writes into one re-run per binding", () => {
  const store = freshStore();
  store.set("a", 1);
  store.set("b", 1);
  let runs = 0;
  store.effect(() => store.eval("a + b"), () => { runs += 1; });
  assert.equal(runs, 1);
  // un-batched writes in one action tick — ONE re-run at the flush (/web/07)
  store.set("a", 2);
  store.set("b", 3);
  flushEffects();
  assert.equal(runs, 2);
  // batch() groups the same way for the snapshot sinks
  store.batch(() => {
    store.set("a", 9);
    store.set("b", 9);
  });
  flushEffects();
  assert.equal(runs, 3);
});

test("store: setPath grows arrays and rebuilds COW", () => {
  const store = freshStore();
  store.set("feed", { data: [{ name: "a" }, { name: "b" }] });
  store.setPath("feed.data.1.name", "B");
  assert.equal(store.eval("feed.data.1.name"), "B");
  assert.equal(store.eval("feed.data.0.name"), "a");
  store.setPath("list.2", "third"); // grows with dict padding
  assert.equal(store.eval("list.2"), "third");
});

test("store: hostile paths fail closed before unbounded allocation", () => {
  const store = freshStore();
  store.setPath("negative.-1.value", "blocked");
  store.setPath("signed.+10000.value", "blocked");
  store.setPath("huge.10000.value", "blocked");
  store.setPath("overflow.999999999999999999999.value", "blocked");
  store.setPath("growth.1024.value", "blocked"); // from empty: 1,025 fillers exceeds the per-write budget
  store.setPath(["deep", ...Array.from({ length: 64 }, (_, i) => `d${i}`)].join("."), "blocked");
  store.setPath(`long.${"x".repeat(257)}`, "blocked");
  store.setPath(`unicode.${"é".repeat(129)}`, "blocked"); // 258 UTF-8 bytes, despite 129 JS code units
  store.setPath("leading..empty", "blocked");
  store.setPath("trailing.", "blocked");
  store.setPath(".prefixed", "blocked");

  for (const key of ["negative", "signed", "huge", "overflow", "growth", "deep", "long", "unicode", "leading", "trailing", "prefixed"]) {
    assert.equal(store.vars.has(key), false, `${key} must not leave a partial top-level container`);
  }

  // The exact growth boundary remains useful for large virtualized collections.
  store.setPath("boundary.1023.value", "ok");
  assert.equal(store.getPath("boundary.1023.value"), "ok");
  assert.equal((store.getPath("boundary") as unknown[]).length, 1024);
});

test("store: watch never fires on subscribe", () => {
  const store = freshStore();
  store.set("x", 1);
  const seen: unknown[] = [];
  store.watch(() => store.eval("x"), (v) => seen.push(v));
  assert.deepEqual(seen, []);
  store.set("x", 2);
  flushEffects();
  assert.deepEqual(seen, [2]);
});

test("global store: reads track and writes invalidate surface bindings", () => {
  const store = freshStore();
  DSXState.set("session.credits", 10);
  const seen: unknown[] = [];
  store.effect(() => store.eval("global.session.credits"), (v) => seen.push(v));
  assert.deepEqual(seen, [10]);
  DSXState.set("session.credits", 11);
  flushEffects();
  assert.deepEqual(seen, [10, 11]);
});

test("runner: assignment, sugar, if/else, dsx.variable writes", async () => {
  const store = freshStore();
  const runner = new ActionRunner(makeRunEnv(store));
  await runner.run("dsx.variable.taps = (dsx.variable.taps || 0) + 1");
  assert.equal(store.eval("taps"), 1);
  await runner.run("taps += 4");
  assert.equal(store.eval("taps"), 5);
  await runner.run("if (taps > 3) { dsx.variable.big = true } else { dsx.variable.big = false }");
  assert.equal(store.eval("big"), true);
});

test("runner: loops with budget, const locals, array mutations", async () => {
  const store = freshStore();
  const runner = new ActionRunner(makeRunEnv(store));
  store.set("items", []);
  await runner.run("for (let i = 0; i < 3; i++) { items.push(i) }");
  assert.deepEqual(store.eval("items"), [0, 1, 2]);
  await runner.run("const doubled = items.map(x => x * 2); dsx.variable.out = doubled");
  assert.deepEqual(store.eval("out"), [0, 2, 4]);
  await runner.run("items.splice(0, 2)");
  assert.deepEqual(store.eval("items"), [2]);
});

test("runner: for…of, switch, try/catch/throw", async () => {
  const store = freshStore();
  const runner = new ActionRunner(makeRunEnv(store));
  store.set("sum", 0);
  await runner.run("for (const n of [1, 2, 3]) { sum += n }");
  assert.equal(store.eval("sum"), 6);
  await runner.run("switch (sum) { case 5: dsx.variable.tag = 'five'; break; case 6: dsx.variable.tag = 'six'; break; default: dsx.variable.tag = 'other' }");
  assert.equal(store.eval("tag"), "six");
  await runner.run("try { throw 'boom' } catch (e) { dsx.variable.caught = e }");
  assert.equal(store.eval("caught"), "boom");
});

test("runner: declared <action> with inputs and dsx.this payload", async () => {
  const store = freshStore();
  const env = makeRunEnv(store);
  env.actions.set("toggle", {
    body: "dsx.variable.last = id; dsx.variable.by = dsx.this.by",
    inputs: { id: "item.id" },
  });
  const runner = new ActionRunner(env);
  await runner.run("dsx.action.toggle()", { id: 42 }, { by: "tap" });
  assert.equal(store.eval("last"), 42);
  assert.equal(store.eval("by"), "tap");
});

test("runner: dsx.event reaches the consumer wiring", async () => {
  const store = freshStore();
  const events: Array<[string, Dict]> = [];
  const env = makeRunEnv(store, { emitEvent: (name, payload) => events.push([name, payload]) });
  const runner = new ActionRunner(env);
  await runner.run("dsx.event('demoPing', { at: 123 })");
  assert.equal(events.length, 1);
  assert.equal(events[0]![0], "demoPing");
  assert.deepEqual(events[0]![1], { at: 123 });
});

test("runner: module calls carry the owning frame stamp and hide it from public args", async () => {
  let stamped: unknown = null;
  let publicArgs: unknown = null;
  ModuleRegistry.register(defineModule({
    scheme: "frameprobe",
    actions: {
      read: (ctx) => {
        stamped = ctx.args("__frame");
        publicArgs = ctx.args();
        return null;
      },
    },
  }));
  const runner = new ActionRunner(makeRunEnv(freshStore(), { frameId: 42 }));
  await runner.run("const r = await dsx.module.frameprobe.read({ value: 'ok', __frame: 999 })");
  assert.equal(stamped, 42, "the internal owning frame wins over an authored lookalike");
  assert.deepEqual(publicArgs, { value: "ok" }, "whole-object reads do not expose internal framing keys");
});

test("bus: dispatch resolves, missing module throws not_loaded, has() honest", async () => {
  ModuleRegistry.register(defineModule({
    scheme: "echo",
    actions: {
      say: (ctx) => ({ heard: ctx.args("text") }),
    },
  }));
  assert.equal(ModuleRegistry.isAvailable("echo"), true);
  assert.equal(ModuleRegistry.isAvailable("ghost"), false);
  const out = await ModuleRegistry.dispatch("echo", "say", { text: "hi" });
  assert.deepEqual(out, { heard: "hi" });
  await assert.rejects(
    () => ModuleRegistry.dispatch("ghost", "say", {}),
    (e: unknown) => e instanceof ModuleCallError && e.code === ERROR_NOT_LOADED,
  );
});

test("bus: every call failure reports to the module.callFailed funnel", async () => {
  const seen: Dict[] = [];
  const off = ModuleRegistry.registerDelegate("module.callFailed", 0, (input) => {
    const p = input as Dict;
    if (String(p["scheme"]).startsWith("funnel")) seen.push(p);
    return null;
  });
  try {
    ModuleRegistry.register(defineModule({
      scheme: "funnelmod",
      actions: {
        ok: () => ({}),
        boom: (ctx) => { ctx.error("boom_code", { why: "t" }); },
      },
    }));
    // A typo'd action on a LOADED module answers unknown_action — never not_loaded
    // (that means "module absent"): the `injct` typo class stays diagnosable.
    await assert.rejects(
      () => ModuleRegistry.dispatch("funnelmod", "oky", {}),
      (e: unknown) => e instanceof ModuleCallError && e.code === "unknown_action",
    );
    // A handler's own error settle funnels with the handler's code.
    await assert.rejects(() => ModuleRegistry.dispatch("funnelmod", "boom", {}));
    // not_loaded funnels too — the silently-skipped optional call, made visible.
    await assert.rejects(() => ModuleRegistry.dispatch("funnelghost", "x", {}));
    assert.deepEqual(seen.map((p) => [p["code"], p["delivered"]]),
      [["unknown_action", true], ["boom_code", true], ["not_loaded", true]]);
    assert.equal(seen[0]!["action"], "oky");
    assert.deepEqual(seen[1]!["data"], { why: "t" });
  } finally { off(); }
});

test("bus: .post discards the rejection but the funnel fires with delivered=false; hooks can't recurse it", async () => {
  const seen: Dict[] = [];
  let nested = 0;
  const off = ModuleRegistry.registerDelegate("module.callFailed", 0, (input) => {
    const p = input as Dict;
    if (p["scheme"] === "postfunnel") {
      seen.push(p);
      // The hook's own body makes a FAILING call — the loop the funnel's guard exists to
      // break (fire → hook → failing call → fire → …). Its report lands mid-fire and
      // stays log-only.
      ModuleRegistry.dispatch("postfunnel-absent", "x", {}).catch(() => {});
    }
    if (p["scheme"] === "postfunnel-absent") nested += 1;
    return null;
  });
  try {
    ModuleRegistry.register(defineModule({
      scheme: "postfunnel",
      actions: { boom: (ctx) => { ctx.error("post_boom"); } },
    }));
    const dsx = makeDsx("kerneltest");
    (dsx.module["postfunnel"]!["boom"] as unknown as { post: (a?: Dict) => void }).post({});
    await new Promise((r) => setTimeout(r, 0));   // the handler settles async
    assert.deepEqual(seen.map((p) => [p["code"], p["delivered"]]), [["post_boom", false]]);
    assert.equal(nested, 0);                      // the nested failure stayed log-only
  } finally { off(); }
});

test("bus: declared state publishes under global.<scheme>.<var>", () => {
  ModuleRegistry.register(defineModule({
    scheme: "darkmode",
    state: { enabled: false },
    actions: {},
  }));
  assert.equal(DSXState.get("darkmode.enabled"), false);
});

test("bus: dsx.json aliases route to the same module; identity stays primary", async () => {
  ModuleRegistry.register(defineModule({
    scheme: "clip",
    state: { last: "" },
    actions: {
      read: (ctx) => { ctx.dsx.state.set("last", "read"); return { text: "t" }; },
    },
  }), { aliases: ["getclip"] });
  assert.equal(ModuleRegistry.isAvailable("getclip"), true);
  const out = await ModuleRegistry.dispatch("getclip", "read", {});
  assert.deepEqual(out, { text: "t" });
  // the module's identity (declared state, its bound dsx) is the PRIMARY scheme
  // even when the call arrives through an alias — aliases are route entries only
  assert.equal(DSXState.get("clip.last"), "read");
  assert.equal(DSXState.get("getclip.last"), null);
});

test("runner: awaited module call binds the { ok, data } envelope; un-awaited is fire-and-forget", async () => {
  let posts = 0;
  ModuleRegistry.register(defineModule({
    scheme: "counter",
    actions: {
      bump: () => { posts += 1; return { n: posts }; },
      fail: (ctx) => { ctx.error("nope", { why: "test" }); },
    },
  }));
  const store = freshStore();
  const runner = new ActionRunner(makeRunEnv(store));
  // native parity: the bind is the envelope, the payload lives under `.data` (NOT raw)
  await runner.run("const r = await dsx.module.counter.bump({}); dsx.variable.n = r.data.n; dsx.variable.ok = r.ok");
  assert.equal(store.eval("n"), 1);
  assert.equal(store.eval("ok"), true);
  // a module error settles the envelope { ok:false, error } and does NOT abort the action
  await runner.run("const r = await dsx.module.counter.fail({}); dsx.variable.code = r.ok ? 'unreached' : r.error; dsx.variable.after = 'ran'");
  assert.equal(store.eval("code"), "nope");
  assert.equal(store.eval("after"), "ran");
  await runner.run("dsx.module.counter.bump({})");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts, 2);
});

test("runner: await fetch envelope (seamed)", async () => {
  RunnerFetchSeam.impl = async (url) => ({ ok: true, status: 200, data: { url, shows: [1, 2] } });
  try {
    const store = freshStore();
    const runner = new ActionRunner(makeRunEnv(store));
    await runner.run("const r = await fetch('https://x.test/api'); if (r.ok) { dsx.variable.count = r.data.shows.length }");
    assert.equal(store.eval("count"), 2);
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("store: dotted writes cannot pollute a prototype (no phantom inherited keys)", () => {
  const store = freshStore();
  // writing through __proto__/constructor/prototype must NOT forge an inherited read
  store.setPath("a.__proto__.isAdmin", true);
  store.setPath("b.constructor.hacked", true);
  assert.equal(store.eval("a.isAdmin"), null);
  assert.equal(store.eval("b.hacked"), null);
  // and global Object.prototype stays pristine
  assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
  // ordinary nested writes still work
  store.setPath("c.d.e", 7);
  assert.equal(store.eval("c.d.e"), 7);
});

test("jse: evalBlock + registerFunctions + interpolate", () => {
  const store = freshStore();
  JSE.registerFunctions("function double(x) { return x * 2 }", store.jse);
  assert.equal(store.eval("double(21)"), 42);
  assert.equal(store.evalBlock("const a = 2; const b = 3; return a * b"), 6);
  store.set("name", "world");
  assert.equal(store.interpolate("hello {{ name }} ({{ 1 + 1 }})"), "hello world (2)");
});

test("jse: computed variables re-evaluate against the live store", () => {
  const store = freshStore();
  store.jse.computed.set("title", "return 'taps: ' + (dsx.variable.taps || 0)");
  assert.equal(store.eval("title"), "taps: 0");
  store.set("taps", 3);
  assert.equal(store.eval("title"), "taps: 3");
});

test("jse: NSNull scope sentinel shadows and stringifies", () => {
  const store = freshStore();
  const v = store.evalBlock("const x = null; return typeof x");
  assert.equal(v, "undefined"); // NSNull reports undefined via typeof
  assert.equal(store.eval("'' + missing"), ""); // absent → ""
  void NSNull;
});

test("jse: catastrophic regex patterns are rejected, not run (ReDoS guard)", async () => {
  const store = freshStore();
  // the classic exponential pattern would freeze a synchronous engine; it returns fast + false
  const t0 = Date.now();
  const hit = store.eval("regex('" + "a".repeat(40) + "!', '(a+)+$')");
  assert.equal(Date.now() - t0 < 100, true, "must not backtrack-freeze");
  assert.equal(hit, false);
  // a prone pattern that WOULD match is refused (returns false), proving rejection not semantics
  assert.equal(store.eval("regex('aaaa', '(a+)+')"), false);
  // safe patterns are untouched
  assert.equal(store.eval("regex('aaaa', 'a+')"), true);
  assert.equal(store.eval("regex('abcabc', '(abc)+')"), true);
  // a regex literal with a nested quantifier degrades to no-match, never a hang
  assert.equal(store.eval("'" + "a".repeat(40) + "!'.match(/(a+)+$/)"), null);
});

test("runner: a second entry cannot drain a suspended entry's loop budget (async isolation)", async () => {
  const store = freshStore();
  let openGate!: () => void;
  const gate = new Promise<void>((r) => { openGate = r; });
  ModuleRegistry.register(defineModule({
    scheme: "gated",
    actions: { wait: async () => { await gate; return { ok: true }; } },
  }));
  const runner = new ActionRunner(makeRunEnv(store));
  // A parks on the gated call, THEN runs a 60k loop; B starts while A is suspended and also
  // wants a 60k loop. With a SHARED budget, B draining it would cut A's loop short (~40k).
  const A = runner.run("const r = await dsx.module.gated.wait(); let c = 0; for (let i = 0; i < 60000; i++) { c = c + 1 } dsx.variable.a = c");
  const B = runner.run("let c = 0; for (let i = 0; i < 60000; i++) { c = c + 1 } dsx.variable.b = c");
  openGate();
  await Promise.all([A, B]);
  assert.equal(store.eval("a"), 60000); // A's loop ran fully — B could not drain its budget
  assert.equal(store.eval("b"), 60000);
});

test("bus: declared state read through an alias scheme resolves to the primary", () => {
  ModuleRegistry.register(defineModule({
    scheme: "themery",
    state: { on: true },
    actions: {},
  }), { aliases: ["themeralias"] });
  const dsx = makeDsx("caller");
  const stateOf = (s: string) => (dsx.module[s] as unknown as { state: Record<string, unknown> }).state;
  assert.equal(stateOf("themery").on, true);      // primary scheme
  assert.equal(stateOf("themeralias").on, true);  // alias resolves to the primary's state
});

test("bus: a catch-all action answers an unmatched host with the called scheme (native parity)", async () => {
  let seen = "";
  ModuleRegistry.register(defineModule({
    scheme: "catchy",
    actions: { "*": (ctx) => { seen = `${ctx.scheme}:${ctx.action}`; return { ok: true }; } },
  }), { aliases: ["catchyalias"] });
  assert.deepEqual(await ModuleRegistry.dispatch("catchy", "anything", {}), { ok: true });
  assert.equal(seen, "catchy:anything");
  // a legacy bare-alias call (empty host) routes through the catch-all carrying the alias
  assert.deepEqual(await ModuleRegistry.dispatch("catchyalias", "", {}), { ok: true });
  assert.equal(seen, "catchyalias:");
});

test("runner: a bare action name mid-body invokes it (native runVerb parity)", async () => {
  const store = freshStore();
  const env = makeRunEnv(store);
  env.actions.set("bump", { body: "dsx.variable.n = (dsx.variable.n || 0) + 1", inputs: {} });
  const runner = new ActionRunner(env);
  await runner.run("dsx.variable.a = 1; bump; dsx.variable.b = 2");
  assert.equal(store.eval("a"), 1);
  assert.equal(store.eval("n"), 1);   // bump ran mid-body...
  assert.equal(store.eval("b"), 2);   // ...and execution continued
});

test("runner: an action-call 2nd-arg callback receives the callee's event (additively)", async () => {
  const store = freshStore();
  const events: string[] = [];
  const env = makeRunEnv(store, { emitEvent: (name) => events.push(name) });
  env.actions.set("notify", { body: "dsx.event('done', { n: 7 })", inputs: {} });
  const runner = new ActionRunner(env);
  await runner.run("dsx.action.notify({}, { done: () => { dsx.variable.got = dsx.this.n } })");
  assert.equal(store.eval("got"), 7);       // the callback ran with the payload on dsx.this
  assert.deepEqual(events, ["done"]);        // and the wildcard/recorder still saw the event
});
