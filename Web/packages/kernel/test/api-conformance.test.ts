//
//  api-conformance.test.ts - the SHARED <api> corpus (OpenSource/Conformance/api/
//  api-blocks.json) through the TS block. The Kotlin (ApiConformanceTest.kt) and
//  Swift (ApiBlock.swift record host) twins run the SAME file — the /web/05 W5 gate:
//  fixtures first, every runtime codes toward them.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { ReactiveStore, flushEffects, DSXState } from "../src/store.ts";
import { ApiBlock, ApiGraph, clearApiCache, type ApiSpec, type ApiEvent } from "../src/api.ts";
import { RunnerFetchSeam } from "../src/runner.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, isDict, string, type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/api/api-blocks.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("api corpus not found");
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

type Step = { set?: { path: string; value: unknown }; setConst?: { name: string; value: unknown }; settle?: boolean; call?: string; send?: Dict; advance?: number; target?: string };
type Case = {
  name: string;
  spec?: ApiSpec;
  /** /web/11 — an ORDERED list of specs sharing one scope: the dependency-graph cases */
  specs?: ApiSpec[];
  scope: Dict;
  /** networking.md N0 — seed the app-wide `dsx.const.*` plane for this case */
  consts?: Dict;
  /** networking.md N1 — the component scope an `<api>` mounted in a component reads */
  item?: Dict;
  responses?: Dict[];
  /** a per-URL response queue — order-insensitive across the sync + async runtimes */
  responsesByUrl?: { [url: string]: Dict[] };
  steps: Step[];
  expect: { [path: string]: unknown };
  expectCalls: string[];
  expectBodies?: unknown[];
  /** per-call dotted-path subset assertions over the MATERIALIZED request */
  expectRequests?: Array<{ [path: string]: unknown }>;
  expectEvents: ApiEvent[];
};

/** dotted-path read over a plain materialized-request value (no store involved) */
function requestPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      if (part === "length") { cur = cur.length; continue; }
      const index = Number(part);
      cur = Number.isInteger(index) && index >= 0 && index < cur.length ? cur[index] : null;
      continue;
    }
    if (typeof cur === "string" && part === "length") { cur = cur.length; continue; }
    cur = isDict(cur) ? ((cur as Dict)[part] ?? null) : null;
  }
  return cur ?? null;
}

function tick(n = 3): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "api corpus is empty");

for (const c of doc.cases) {
  test(`api-corpus/${c.name}`, async () => {
    clearApiCache();
    const queue = [...(c.responses ?? [])];
    const byUrl = new Map<string, Dict[]>(
      Object.entries(c.responsesByUrl ?? {}).map(([k, v]) => [k, [...v]]),
    );
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const requests: Dict[] = [];
    RunnerFetchSeam.impl = async (url, init) => {
      calls.push(url);
      bodies.push(init["body"] ?? null);
      requests.push(init as Dict);
      const perUrl = byUrl.get(url);
      const next = perUrl !== undefined ? perUrl.shift() : queue.shift();
      return (next ?? { ok: false, status: 0, data: null }) as Dict;
    };
    let fakeNow = 1_000_000;
    const events: ApiEvent[] = [];
    try {
      const store = new ReactiveStore();
      for (const [k, v] of Object.entries(c.scope)) store.jse.vars.set(k, toJse(v));
      // networking.md N0: the app-wide `dsx.const.*` plane rides the same app store as
      // `global.*`, so seeding/updating it here drives the block's reactive refetch.
      let consts: Dict = c.consts !== undefined ? (toJse(c.consts) as Dict) : {};
      if (c.consts !== undefined) DSXState.set("const", consts);
      // networking.md N1: the component scope an <api>-in-a-component materializes against.
      const item: Dict | null = c.item !== undefined ? (toJse(c.item) as Dict) : null;
      const specs: ApiSpec[] = c.specs ?? [c.spec!];
      // /web/11: ONE graph per scope — every block mounts, THEN the runnable ones start.
      let graph = new ApiGraph(specs);
      const blocks = new Map<string, ApiBlock>();
      const make = (): ApiBlock => {
        graph = new ApiGraph(specs);
        blocks.clear();
        for (const spec of specs) {
          blocks.set(spec.as, new ApiBlock(spec, store, item, {
            onEvent: (name) => events.push(name),
            now: () => fakeNow,
            graph,
          }));
        }
        graph.start();
        return blocks.get(specs[0]!.as)!;
      };
      const pick = (target: string | undefined): ApiBlock =>
        blocks.get(target ?? specs[0]!.as) ?? blocks.get(specs[0]!.as)!;
      let block = make();
      await tick();
      for (const step of c.steps) {
        if (step.set !== undefined) {
          store.setPath(step.set.path, toJse(step.set.value));
          flushEffects();
          await tick();
        } else if (step.setConst !== undefined) {
          consts = { ...consts, [step.setConst.name]: toJse(step.setConst.value) };
          DSXState.set("const", consts); // reactive: pokes the block's global read-set
          flushEffects();
          await tick();
        } else if (step.settle === true) {
          flushEffects();
          await tick();
        } else if (step.call === "refresh") {
          await pick(step.target).refresh();
          flushEffects();
          await tick();
        } else if (step.call === "cancel") {
          pick(step.target).cancel();
        } else if (step.call === "remount") {
          for (const b of blocks.values()) b.dispose();
          block = make();
          await tick();
        } else if (step.send !== undefined) {
          // /web/11: the last send envelope is observable at `sendResult`
          const result = await pick(step.target).send(toJse(step.send) as Dict);
          store.set("sendResult", result === undefined ? null : result);
          flushEffects();
          await tick();
        } else if (step.advance !== undefined) {
          fakeNow += step.advance * 1000;
        }
      }
      flushEffects();
      await tick();
      for (const [path, expected] of Object.entries(c.expect)) {
        const actual = JSE.eval(path, store.jse, null);
        assert.ok(
          JSE.equals(actual, expected),
          `${path} -> ${string(actual)} (expected ${string(expected)})`,
        );
      }
      assert.deepEqual(calls, c.expectCalls, "seam call urls");
      if (c.expectBodies !== undefined) {
        c.expectBodies.forEach((b, i) => {
          assert.ok(JSE.equals(bodies[i], toJse(b)), `body[${i}] -> ${string(bodies[i])}`);
        });
      }
      if (c.expectRequests !== undefined) {
        c.expectRequests.forEach((expectations, i) => {
          for (const [path, expected] of Object.entries(expectations)) {
            assert.ok(
              JSE.equals(requestPath(requests[i], path), toJse(expected)),
              `request[${i}].${path} -> ${string(requestPath(requests[i], path))}`,
            );
          }
        });
      }
      assert.deepEqual(events, c.expectEvents, "event order");
      for (const b of blocks.values()) b.dispose();
      void block;
    } finally {
      RunnerFetchSeam.impl = null;
      clearApiCache();
      DSXState.set("const", {}); // isolate the app-wide const plane between cases
    }
  });
}
