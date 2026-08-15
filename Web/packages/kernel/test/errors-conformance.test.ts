//
//  errors-conformance.test.ts - the SHARED error-system corpus
//  (OpenSource/Conformance/errors/errors.json) through the TS kernel. The Kotlin
//  (ErrorsConformanceTest.kt) and Swift (ConformanceHosts.ErrorsConformance) twins run
//  the SAME file — fixtures-first for the error system (error-system.md, ACCEPTED v1):
//  the ambient dsx.error hat, the ledger ring, module.error / module.callFailed, the
//  page channel + reserved `dsx` mirror, and the reactive global.dsx.* keys.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ReactiveStore, DSXState } from "../src/store.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { ModuleRegistry, DSXErrors, DSXEvents, defineModule, makeDsx, ModuleCallError } from "../src/bus.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, isDict, string, type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/errors/errors.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("errors corpus not found");
    dir = parent;
  }
}

type FixtureAction = { resolve?: unknown; error?: [string, unknown]; errorTwice?: [string, string] };
type Case = {
  name: string;
  /** the case's build-excluded overlay (durability.md P4, typed absence): chain → its
   *  DespiaExcluded-shaped entry ({ reason: "excluded" } | { reason: "cascade", from }) */
  excludedOverlay?: { [chain: string]: { reason: string; from?: string } };
  register?: Array<{ scheme: string; actions: { [name: string]: FixtureAction } }>;
  steps: Array<Dict>;
  expect: {
    ledger?: Dict[];
    ledgerCount?: number;
    ledgerTail?: Dict[];
    hooks?: { [hook: string]: Dict[] };
    events?: Array<{ scheme: string; event: string; data: Dict }>;
    state?: { [path: string]: unknown };
    stateDelta?: { [path: string]: number };
    callErrors?: string[];
    jseStore?: { [path: string]: unknown };
    schemeAvailable?: { [scheme: string]: boolean };
  };
};

/** SUBSET match: every key listed in `expected` must deep-subset-match in `actual`;
 *  unlisted keys are ignored. `null` expects null/undefined/NSNull. */
function subset(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined || actual === NSNull;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => subset(actual[i], e));
  }
  if (typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(expected as Dict).every(([k, v]) => subset((actual as Dict)[k], v));
  }
  return actual === expected;
}

function assertSubset(actual: unknown, expected: unknown, label: string): void {
  assert.ok(subset(actual, expected),
    `${label}: expected subset ${JSON.stringify(expected)} — got ${JSON.stringify(actual)}`);
}

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "errors corpus is empty");

for (const c of doc.cases) {
  test(`errors-corpus/${c.name}`, async () => {
    // the build-excluded overlay (durability.md P4), seeded BEFORE any step through the
    // SAME build seam the runtime uses to load DespiaExcluded (setExcludedIdentities,
    // which derives each entry's shape from the chain set). A cascade entry's `from`
    // ancestor is excluded by definition of the shape, so it rides the seed; the case's
    // verbatim `data` expectations pin the derived entries against the declared ones.
    if (c.excludedOverlay) {
      const chains = new Set<string>();
      for (const [chain, entry] of Object.entries(c.excludedOverlay)) {
        chains.add(chain);
        if (typeof entry.from === "string") chains.add(entry.from);
      }
      ModuleRegistry.setExcludedIdentities([...chains]);
    }
    // fixture modules (the reserved-scheme case relies on register REFUSING "dsx")
    for (const reg of c.register ?? []) {
      const actions: { [n: string]: (ctx: { error(code?: string, data?: unknown): void }) => unknown } = {};
      for (const [name, kind] of Object.entries(reg.actions)) {
        if (kind.errorTwice) {
          const [c1, c2] = kind.errorTwice;
          actions[name] = (ctx) => { ctx.error(c1); ctx.error(c2); };
        } else if (kind.error) {
          const [code, data] = kind.error;
          actions[name] = (ctx) => { ctx.error(code, data ?? null); };
        } else {
          const value = kind.resolve ?? null;
          actions[name] = () => value;
        }
      }
      ModuleRegistry.register(defineModule({ scheme: reg.scheme, actions }));
    }

    // observers: ledger snapshot, hooks, page channel, state
    const countBefore = DSXErrors.count();
    const stateBefore: { [p: string]: number } = {};
    for (const p of Object.keys(c.expect.stateDelta ?? {})) {
      const v = DSXState.get(p);
      stateBefore[p] = typeof v === "number" ? v : 0;
    }
    const hookNames = Object.keys(c.expect.hooks ?? {});
    const hookSeen: { [h: string]: Dict[] } = {};
    const unhooks: Array<() => void> = [];
    for (const h of hookNames) {
      hookSeen[h] = [];
      unhooks.push(ModuleRegistry.registerDelegate(h, 0, (input) => {
        if (isDict(input)) hookSeen[h]!.push(input as Dict);
        return null;
      }));
    }
    const eventSchemes = [...new Set((c.expect.events ?? []).map((e) => e.scheme))];
    const eventSeen: Array<{ scheme: string; event: string; data: unknown }> = [];
    for (const s of eventSchemes) {
      unhooks.push(DSXEvents.on(`${s}:error`, (value) => eventSeen.push({ scheme: s, event: "error", data: value })));
    }
    // the reentrancy probe: a hook that emits the moment it observes the outer code
    let nestedProbe: { onCode: string; scheme: string; code: string } | null = null;
    unhooks.push(ModuleRegistry.registerDelegate("module.error", 0, (input) => {
      if (nestedProbe && isDict(input) && (input as Dict)["code"] === nestedProbe.onCode) {
        const probe = nestedProbe;
        nestedProbe = null;   // once
        makeDsx(probe.scheme).error(probe.code);
      }
      return null;
    }));

    const callErrors: string[] = [];
    let jseStore: ReactiveStore | null = null;

    try {
      for (const step of c.steps) {
        if (isDict(step["emit"])) {
          const e = step["emit"] as Dict;
          const nested = e["nestedEmitFromHook"] as Dict | undefined;
          if (isDict(nested)) {
            nestedProbe = { onCode: string(e["code"]), scheme: string(nested["scheme"]), code: string(nested["code"]) };
          }
          makeDsx(string(e["scheme"])).fail(
            string(e["code"]),
            e["message"] === undefined || e["message"] === null ? undefined : string(e["message"]),
            e["recoverable"] === true,
            e["data"] ?? null,
          );
        } else if (isDict(step["emitRepeat"])) {
          const r = step["emitRepeat"] as Dict;
          const dsx = makeDsx(string(r["scheme"]));
          const count = Number(r["count"]);
          for (let i = 0; i < count; i++) dsx.error(`${string(r["codePrefix"])}${i}`);
        } else if (isDict(step["jse"])) {
          const j = step["jse"] as Dict;
          jseStore = new ReactiveStore();
          const env = makeRunEnv(jseStore, { ownerScheme: j["scheme"] === undefined ? undefined : string(j["scheme"]) });
          await new ActionRunner(env).run(string(j["body"]));
        } else if (isDict(step["call"])) {
          const k = step["call"] as Dict;
          const scheme = string(k["scheme"]);
          const action = string(k["action"]);
          const args = isDict(k["args"]) ? (k["args"] as Dict) : {};
          if (k["mode"] === "post") {
            ModuleRegistry.dispatch(scheme, action, args, { fireAndForget: true }).catch(() => {});
            await new Promise((r) => setTimeout(r, 0));   // the handler settles async
          } else {
            try {
              await ModuleRegistry.dispatch(scheme, action, args);
            } catch (e) {
              callErrors.push(e instanceof ModuleCallError ? e.code : "error");
            }
          }
        }
      }
      await new Promise((r) => setTimeout(r, 0));   // drain any async settles

      // ── assertions ──
      if (c.expect.ledger) {
        const appended = DSXErrors.count() - countBefore;
        assert.equal(appended, c.expect.ledger.length, `${c.name}: appended ledger entries`);
        const tail = DSXErrors.recent().slice(-appended);
        c.expect.ledger.forEach((exp, i) => assertSubset(tail[i], exp, `${c.name}: ledger[${i}]`));
      }
      if (c.expect.ledgerCount !== undefined) {
        assert.equal(DSXErrors.recent().length, c.expect.ledgerCount, `${c.name}: retained ledger total`);
      }
      for (const [i, exp] of (c.expect.ledgerTail ?? []).entries()) {
        const tail = DSXErrors.recent().slice(-(c.expect.ledgerTail!.length));
        assertSubset(tail[i], exp, `${c.name}: ledgerTail[${i}]`);
      }
      for (const [hook, expected] of Object.entries(c.expect.hooks ?? {})) {
        assert.equal(hookSeen[hook]!.length, expected.length, `${c.name}: ${hook} fire count`);
        expected.forEach((exp, i) => assertSubset(hookSeen[hook]![i], exp, `${c.name}: ${hook}[${i}]`));
      }
      if (c.expect.events) {
        assert.equal(eventSeen.length, c.expect.events.length, `${c.name}: page-channel deliveries`);
        c.expect.events.forEach((exp, i) => {
          assert.equal(eventSeen[i]!.scheme, exp.scheme, `${c.name}: events[${i}].scheme`);
          assertSubset(eventSeen[i]!.data, exp.data, `${c.name}: events[${i}].data`);
        });
      }
      for (const [path, exp] of Object.entries(c.expect.state ?? {})) {
        assertSubset(DSXState.get(path), exp, `${c.name}: state ${path}`);
      }
      for (const [path, delta] of Object.entries(c.expect.stateDelta ?? {})) {
        const now = DSXState.get(path);
        assert.equal((typeof now === "number" ? now : 0) - stateBefore[path]!, delta, `${c.name}: stateDelta ${path}`);
      }
      if (c.expect.callErrors) assert.deepEqual(callErrors, c.expect.callErrors, `${c.name}: callErrors`);
      for (const [path, exp] of Object.entries(c.expect.jseStore ?? {})) {
        assert.ok(jseStore, `${c.name}: no jse step ran`);
        const actual = JSE.eval(path, jseStore!.jse, null);
        assertSubset(actual === NSNull ? null : actual, exp, `${c.name}: jseStore ${path}`);
      }
      for (const [scheme, avail] of Object.entries(c.expect.schemeAvailable ?? {})) {
        assert.equal(ModuleRegistry.isAvailable(scheme), avail, `${c.name}: schemeAvailable ${scheme}`);
      }
    } finally {
      for (const off of unhooks) off();
      // per-case isolation: a seeded overlay never outlives its case (empty is this
      // file's baseline — the next case's `not_loaded`/`schemeAvailable` answers stay honest)
      if (c.excludedOverlay) ModuleRegistry.setExcludedIdentities([]);
    }
  });
}
