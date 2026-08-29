//
//  watch-conformance.test.ts - the SHARED watch-dispatch corpus
//  (OpenSource/Conformance/actions/watch-dispatch.json) through the TS primitives a
//  surface wires: `store.watch` (fires on meaningful change, never on subscribe) feeding
//  the ActionRunner. The Kotlin (WatchConformanceTest.kt, the WatchView evaluate/fire
//  loop) and Swift (WatchConformance, ConformanceHosts.swift, record lane) twins run the
//  SAME file. Pinned here after the W12 stale-snapshot investigation: the handler
//  observes the POST-WRITE store (the filed 2026-08-17 starter toggle revert was the
//  wave-7 F4 entity lexing writing 0 through this dispatch path, never a snapshot).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ReactiveStore, DSXState, flushEffects } from "../src/store.ts";
import { ActionRunner, makeRunEnv, writeBound } from "../src/runner.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, isDict, string, type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/actions/watch-dispatch.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("watch-dispatch corpus not found");
    dir = parent;
  }
}

function toJse(v: unknown): unknown {
  if (v === null) return NSNull;
  if (Array.isArray(v)) return v.map(toJse);
  if (typeof v === "object") {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v as Dict)) out[k] = toJse(val);
    return out;
  }
  return v;
}

type Case = {
  name: string;
  actions: { [name: string]: { inputs?: Dict; body: string } };
  scope: Dict;
  global?: Dict;
  watches: Array<{ value: string; handler: string }>;
  pre?: Array<{ path: string; value: unknown }>;
  run: string;
  runItem?: Dict;
  expectStore: { [path: string]: unknown };
  expectGlobal?: { [path: string]: unknown };
  expectEvents: string[];
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "watch-dispatch corpus is empty");

/** The reference payload rule (Stack.swift WatchView.fire / JseRunner.fireWatch):
 *  an object value rides dsx.this as-is, anything else as { value: … }. */
function payloadFor(v: unknown): Dict {
  return isDict(v) ? (v as Dict) : { value: v ?? NSNull };
}

for (const c of doc.cases) {
  test(`watch-corpus/${c.name}`, async () => {
    // a fresh app-wide store per case (DSXState is a module singleton)
    for (const k of Object.keys(DSXState.vars)) DSXState.set(k, null);
    for (const [k, v] of Object.entries(c.global ?? {})) DSXState.set(k, toJse(v));

    const store = new ReactiveStore();
    for (const [k, v] of Object.entries(c.scope)) store.jse.vars.set(k, toJse(v));

    const events: string[] = [];
    const env = makeRunEnv(store, { emitEvent: (name) => events.push(name) });
    for (const [name, decl] of Object.entries(c.actions ?? {})) {
      env.actions.set(name, { body: decl.body, inputs: (decl.inputs ?? {}) as Dict });
    }
    const runner = new ActionRunner(env);

    // watches attach exactly as a mounted surface attaches them: never fire on subscribe;
    // each fire dispatches one runner entry whose settling the drain below awaits.
    const inFlight: Array<Promise<void>> = [];
    const disposers = (c.watches ?? []).map((w) =>
      store.watch(
        () => store.eval(w.value, null),
        (v) => { inFlight.push(runner.run(w.handler, null, payloadFor(v))); },
      ));

    try {
      for (const p of c.pre ?? []) writeBound(env, p.path, toJse(p.value));
      inFlight.push(runner.run(c.run, c.runItem ? (toJse(c.runItem) as Dict) : null));

      // Drain the cascade: deliver scheduled watch evaluations, await every handler entry
      // they dispatched, repeat until a quiet round. Bounded - corpus rows are synchronous.
      for (let round = 0; round < 32; round++) {
        flushEffects();
        if (inFlight.length === 0) break;
        const batch = inFlight.splice(0, inFlight.length);
        await Promise.all(batch);
        await new Promise((r) => setTimeout(r, 0)); // entry-lock continuations land
      }
      flushEffects();

      const nil = (v: unknown): unknown => (v === null || v === undefined || v === NSNull ? null : v);
      for (const [path, expected] of Object.entries(c.expectStore)) {
        const actual = JSE.eval(path, store.jse, null);
        const expectVal = expected === null ? null : toJse(expected);
        assert.ok(
          JSE.equals(nil(actual), expectVal),
          `${path} -> ${string(actual)} (expected ${string(expected)})`,
        );
      }
      for (const [path, expected] of Object.entries(c.expectGlobal ?? {})) {
        const actual = DSXState.get(path);
        const expectVal = expected === null ? null : toJse(expected);
        assert.ok(
          JSE.equals(nil(actual), expectVal),
          `global.${path} -> ${string(actual)} (expected ${string(expected)})`,
        );
      }
      assert.deepEqual(events, c.expectEvents, "event order");
    } finally {
      for (const d of disposers) d();
      store.dispose();
    }
  });
}
