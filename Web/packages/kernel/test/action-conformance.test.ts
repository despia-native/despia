//
//  action-conformance.test.ts - the SHARED action/workflow corpus
//  (OpenSource/Conformance/actions/actions.json) through the TS runner. The Kotlin
//  (ActionConformanceTest.kt) and Swift (JSERunner.swift) twins run the SAME file —
//  the fixtures-first law applied to actions: DSX actions ARE workflows (they chain,
//  call each other, sequence, branch, loop, emit events; recursion bounded at 32).
//

import { test } from "node:test";
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
    const candidate = join(dir, "OpenSource/Conformance/actions/actions.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("action corpus not found");
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
  /** a SURFACE entry: an `on:*` handler string. Mutually exclusive with runAction. */
  run?: string;
  runItem?: Dict;
  /** a HOST entry: the action a host invokes directly, with `runPayload` as its payload. */
  runAction?: string;
  runPayload?: Dict;
  expectStore: { [path: string]: unknown };
  expectEvents: string[];
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "action corpus is empty");

for (const c of doc.cases) {
  test(`action-corpus/${c.name}`, async () => {
    const store = new ReactiveStore();
    for (const [k, v] of Object.entries(c.scope)) store.jse.vars.set(k, toJse(v));
    const events: string[] = [];
    const env = makeRunEnv(store, { emitEvent: (name) => events.push(name) });
    for (const [name, decl] of Object.entries(c.actions)) {
      env.actions.set(name, { body: decl.body, inputs: (decl.inputs ?? {}) as Dict });
    }
    const runner = new ActionRunner(env);
    const item = c.runItem ? (toJse(c.runItem) as Dict) : null;
    if (c.runAction !== undefined) {
      // The HOST entry path — what an HTTP request, a CLI command and a queue message all do.
      await runner.callAction(c.runAction, {}, item, toJse(c.runPayload ?? {}) as Dict, { entry: true });
    } else {
      await runner.run(c.run ?? "", item);
    }

    const nil = (v: unknown): unknown => (v === null || v === undefined || v === NSNull ? null : v);
    for (const [path, expected] of Object.entries(c.expectStore)) {
      const actual = JSE.eval(path, store.jse, null);
      // a JSON null in expectStore means "absent/nil" — matches null OR the NSNull sentinel
      const expectVal = expected === null ? null : toJse(expected);
      assert.ok(
        JSE.equals(nil(actual), expectVal),
        `${path} -> ${string(actual)} (expected ${string(expected)})`,
      );
    }
    assert.deepEqual(events, c.expectEvents, "event order");
  });
}
