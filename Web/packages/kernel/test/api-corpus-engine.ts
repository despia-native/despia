//
//  api-corpus-engine.ts — the <api> corpus case executor, PLATFORM-FREE. Extracted from
//  api-conformance.test.ts so the same engine runs the same file on node (that suite) and
//  under real workerd (packages/server/test/workers/ — the W1 server-workers lane): a case
//  returns its failures as strings instead of asserting, and the shell around it decides
//  what a failure means. Nothing here names node:, a test framework, or a filesystem — the
//  corpus JSON arrives parsed, the way the Kotlin and Swift twins receive it.
//

import { ReactiveStore, flushEffects, DSXState } from "../src/store.ts";
import { ApiBlock, ApiGraph, clearApiCache, type ApiSpec, type ApiEvent } from "../src/api.ts";
import { RunnerFetchSeam } from "../src/runner.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, isDict, string, type Dict } from "../src/jse/values.ts";

export function toJse(v: unknown): unknown {
  if (v === null) return NSNull;
  if (Array.isArray(v)) return v.map(toJse);
  if (typeof v === "object") {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v as Dict)) out[k] = toJse(val);
    return out;
  }
  return v;
}

export type ApiCorpusStep = {
  set?: { path: string; value: unknown };
  setConst?: { name: string; value: unknown };
  settle?: boolean;
  call?: string;
  send?: Dict;
  advance?: number;
  target?: string;
};

export type ApiCorpusCase = {
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
  steps: ApiCorpusStep[];
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

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Run one corpus case. The returned list is EMPTY on a pass; each entry is one failed
 * expectation, in the same words the node suite used to assert with — the shell (node:test,
 * or the workerd results route) surfaces them without re-deriving what went wrong.
 */
export async function runApiCorpusCase(c: ApiCorpusCase): Promise<string[]> {
  const failures: string[] = [];
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
      if (!JSE.equals(actual, expected)) {
        failures.push(`${path} -> ${string(actual)} (expected ${string(expected)})`);
      }
    }
    if (!deepEqual(calls, c.expectCalls)) {
      failures.push(`seam call urls -> ${JSON.stringify(calls)} (expected ${JSON.stringify(c.expectCalls)})`);
    }
    if (c.expectBodies !== undefined) {
      c.expectBodies.forEach((b, i) => {
        if (!JSE.equals(bodies[i], toJse(b))) failures.push(`body[${i}] -> ${string(bodies[i])}`);
      });
    }
    if (c.expectRequests !== undefined) {
      c.expectRequests.forEach((expectations, i) => {
        for (const [path, expected] of Object.entries(expectations)) {
          if (!JSE.equals(requestPath(requests[i], path), toJse(expected))) {
            failures.push(`request[${i}].${path} -> ${string(requestPath(requests[i], path))}`);
          }
        }
      });
    }
    if (!deepEqual(events, c.expectEvents)) {
      failures.push(`event order -> ${JSON.stringify(events)} (expected ${JSON.stringify(c.expectEvents)})`);
    }
    for (const b of blocks.values()) b.dispose();
    void block;
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
    DSXState.set("const", {}); // isolate the app-wide const plane between cases
  }
  return failures;
}
