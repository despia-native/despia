//
//  logs-conformance.test.ts - the SHARED log corpus (OpenSource/Conformance/logs/logs.json)
//  through the TS kernel. The Kotlin (LogsConformanceTest.kt) and Swift
//  (ConformanceHosts.LogsConformance) twins run the SAME file — fixtures-first for the
//  unified console primitive: `dsx.log` house formatting + redaction, source-scheme
//  attribution (markup / module handle / console.* / the kernel `dsx.log` bus verb),
//  and the log ring (cap 500).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ReactiveStore } from "../src/store.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { ModuleRegistry, ModuleCallError, makeDsx } from "../src/bus.ts";
import { DSXLogs } from "../src/logs.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, isDict, string, type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/logs/logs.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("logs corpus not found");
    dir = parent;
  }
}

type Case = {
  name: string;
  steps: Array<Dict>;
  expect: {
    logs?: Dict[];
    logCount?: number;
    logsTail?: Dict[];
    callErrors?: string[];
    jseStore?: { [path: string]: unknown };
  };
};

/** SUBSET match — the errors-corpus discipline: listed keys deep-match, unlisted ignored. */
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
assert.ok(doc.cases.length > 0, "logs corpus is empty");

for (const c of doc.cases) {
  test(`logs-corpus/${c.name}`, async () => {
    const countBefore = DSXLogs.count();
    const callErrors: string[] = [];
    let jseStore: ReactiveStore | null = null;

    for (const step of c.steps) {
      if (isDict(step["jse"])) {
        const j = step["jse"] as Dict;
        jseStore = new ReactiveStore();
        const env = makeRunEnv(jseStore, { ownerScheme: j["scheme"] === undefined ? undefined : string(j["scheme"]) });
        await new ActionRunner(env).run(string(j["body"]));
      } else if (isDict(step["log"])) {
        const l = step["log"] as Dict;
        const args = Array.isArray(l["args"]) ? (l["args"] as unknown[]) : [];
        makeDsx(string(l["scheme"])).log(...args);
      } else if (isDict(step["logRepeat"])) {
        const r = step["logRepeat"] as Dict;
        const dsx = makeDsx(string(r["scheme"]));
        const count = Number(r["count"]);
        for (let i = 0; i < count; i++) dsx.log(`${string(r["prefix"])}${i}`);
      } else if (isDict(step["call"])) {
        const k = step["call"] as Dict;
        const args = isDict(k["args"]) ? (k["args"] as Dict) : {};
        try {
          await ModuleRegistry.dispatch(string(k["scheme"]), string(k["action"]), args);
        } catch (e) {
          callErrors.push(e instanceof ModuleCallError ? e.code : "error");
        }
      }
    }

    if (c.expect.logs) {
      const appended = DSXLogs.count() - countBefore;
      assert.equal(appended, c.expect.logs.length, `${c.name}: appended log entries`);
      const tail = DSXLogs.recent().slice(-appended);
      c.expect.logs.forEach((exp, i) => assertSubset(tail[i], exp, `${c.name}: logs[${i}]`));
    }
    if (c.expect.logCount !== undefined) {
      assert.equal(DSXLogs.recent().length, c.expect.logCount, `${c.name}: retained log total`);
    }
    for (const [i, exp] of (c.expect.logsTail ?? []).entries()) {
      const tail = DSXLogs.recent().slice(-(c.expect.logsTail!.length));
      assertSubset(tail[i], exp, `${c.name}: logsTail[${i}]`);
    }
    if (c.expect.callErrors) assert.deepEqual(callErrors, c.expect.callErrors, `${c.name}: callErrors`);
    for (const [path, exp] of Object.entries(c.expect.jseStore ?? {})) {
      assert.ok(jseStore, `${c.name}: no jse step ran`);
      const actual = JSE.eval(path, jseStore!.jse, null);
      assertSubset(actual === NSNull ? null : actual, exp, `${c.name}: jseStore ${path}`);
    }
  });
}
