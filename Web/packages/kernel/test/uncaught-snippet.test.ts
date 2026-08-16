//
//  uncaught-snippet.test.ts - RUNTIME ERROR CONTEXT: an uncaught markup throw's ambient
//  report carries `snippet` (the first 120 chars of the BODY THAT THREW) in its data, so
//  a ledger entry says WHAT threw, not just that something did. The runner threads the
//  entry/action body into its state when run()/callAction start (a throw skips the
//  restore, like the flow signal, so a nested action's throw attributes ITS body).
//  Spied at the ModuleRegistry.reportAmbientError seam.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore } from "../src/store.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { ModuleRegistry } from "../src/bus.ts";
import { isDict, type Dict } from "../src/jse/values.ts";

type AmbientOpts = {
  message?: string | null; recoverable?: boolean; data?: unknown; origin?: "raised" | "uncaught";
};
type AmbientSeam = {
  reportAmbientError(scheme: string, code: string, opts?: AmbientOpts): void;
};

test("an uncaught throw reports a snippet of the entry body that threw", async () => {
  const seen: Array<{ scheme: string; code: string; opts: AmbientOpts }> = [];
  const registry = ModuleRegistry as unknown as AmbientSeam;
  const original = registry.reportAmbientError;
  registry.reportAmbientError = (scheme, code, opts = {}) => { seen.push({ scheme, code, opts }); };
  try {
    const runner = new ActionRunner(makeRunEnv(new ReactiveStore()));
    await runner.run("x = 1; throw 'kapow'");
  } finally {
    registry.reportAmbientError = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.code, "uncaught");
  assert.equal(seen[0]!.opts.origin, "uncaught");
  assert.equal(seen[0]!.opts.message, "kapow");
  const data = seen[0]!.opts.data;
  assert.ok(isDict(data), "data is a dict carrying the snippet");
  assert.equal((data as Dict)["snippet"], "x = 1; throw 'kapow'");
});

test("a nested action's throw snippets the ACTION body, and author data keeps its keys", async () => {
  const seen: Array<{ code: string; opts: AmbientOpts }> = [];
  const registry = ModuleRegistry as unknown as AmbientSeam;
  const original = registry.reportAmbientError;
  registry.reportAmbientError = (_scheme, code, opts = {}) => { seen.push({ code, opts }); };
  const actionBody = "throw { code: 'blew_up', data: { step: 3 } }";
  try {
    const env = makeRunEnv(new ReactiveStore());
    env.actions.set("boom", { body: actionBody, inputs: {} });
    await new ActionRunner(env).run("a = 1; dsx.action.boom()");
  } finally {
    registry.reportAmbientError = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.code, "blew_up");
  const data = seen[0]!.opts.data as Dict;
  assert.equal(data["step"], 3);              // the author's data survives untouched
  assert.equal(data["snippet"], actionBody);  // the THROWING body, not the entry's
});
