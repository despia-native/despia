//
//  function-conformance.test.ts - the SHARED global-function-library corpus
//  (OpenSource/Conformance/functions/functions.json) through the TS runner. The Kotlin
//  (:core FunctionConformanceTest.kt) twin runs the SAME file; the Swift reference is
//  Stack.swift's head mount + JSE.registerGlobalFunctions (record-lane execution
//  pending, like the actions corpus). Each case mounts its `blocks` in document order —
//  global: true → JSE.registerGlobalFunctions (the `<functions global="true">` head
//  block), else → JSE.registerFunctions into the case's surface store — then runs the
//  actions-corpus contract: run / expectStore / expectEvents. The global table clears
//  between cases (the app-reload contract; it is process-static by design).
//

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ReactiveStore } from "../src/store.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, string, type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/functions/functions.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("functions corpus not found");
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
  blocks: Array<{ global?: boolean; body: string }>;
  actions: { [name: string]: { inputs?: Dict; body: string } };
  scope: Dict;
  run: string;
  runItem?: Dict;
  expectStore: { [path: string]: unknown };
  expectEvents: string[];
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "functions corpus is empty");

afterEach(() => JSE.clearGlobalFunctions());

for (const c of doc.cases) {
  test(`function-corpus/${c.name}`, async () => {
    const store = new ReactiveStore();
    for (const [k, v] of Object.entries(c.scope)) store.jse.vars.set(k, toJse(v));
    // the head blocks, in document order — the `<functions>`/`<functions global="true">` mount
    for (const b of c.blocks) {
      if (b.global === true) JSE.registerGlobalFunctions(b.body);
      else JSE.registerFunctions(b.body, store.jse);
    }
    const events: string[] = [];
    const env = makeRunEnv(store, { emitEvent: (name) => events.push(name) });
    for (const [name, decl] of Object.entries(c.actions)) {
      env.actions.set(name, { body: decl.body, inputs: (decl.inputs ?? {}) as Dict });
    }
    const runner = new ActionRunner(env);
    await runner.run(c.run, c.runItem ? (toJse(c.runItem) as Dict) : null);

    const nil = (v: unknown): unknown => (v === null || v === undefined || v === NSNull ? null : v);
    for (const [path, expected] of Object.entries(c.expectStore)) {
      const actual = JSE.eval(path, store.jse, null);
      const expectVal = expected === null ? null : toJse(expected);
      assert.ok(
        JSE.equals(nil(actual), expectVal),
        `${path} -> ${string(actual)} (expected ${string(expected)})`,
      );
    }
    assert.deepEqual(events, c.expectEvents, "event order");
  });
}
