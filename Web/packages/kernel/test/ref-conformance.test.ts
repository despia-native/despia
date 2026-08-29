//
//  ref-conformance.test.ts — the SHARED `ref=` corpus through the TS kernel
//  (OpenSource/Conformance/input/ref.json). The Kotlin twin (:core RefConformanceTest) and the
//  Swift twin (StackRef) run the SAME file.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { refKey, RefRegistry } from "../src/index.ts";

function corpus(): { [k: string]: unknown } {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const c = join(dir, "OpenSource/Conformance/input/ref.json");
    if (existsSync(c)) {
      const doc = JSON.parse(readFileSync(c, "utf-8")) as { [k: string]: unknown };
      assert.equal(doc["version"], 1, "ref.json: version");
      return doc;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/input/ref.json not found");
    dir = parent;
  }
}

type Step = { appear?: string; disappear?: string; resolve?: string; resolveView?: string; collect?: string; view?: number };

function runSteps(steps: Step[]): (string | number | null)[] {
  const reg = new RefRegistry<object>();
  const views = new Map<number, object>();
  const viewFor = (n: number): object => {
    if (!views.has(n)) views.set(n, { id: n });
    return views.get(n)!;
  };
  const idOf = (v: object): number => (v as { id: number }).id;
  return steps.map((s) => {
    if (s.appear !== undefined) { reg.provide(s.appear, viewFor(s.view ?? 1)); return null; }
    if (s.disappear !== undefined) { reg.clear(s.disappear, viewFor(s.view ?? 1)); return null; }
    if (s.collect !== undefined) { reg.collect(s.collect); return null; }
    if (s.resolve !== undefined) { const r = reg.resolve(s.resolve); return r.ok ? "live" : r.error; }
    if (s.resolveView !== undefined) { const r = reg.resolve(s.resolveView); return r.ok ? idOf(r.view) : null; }
    throw new Error("step names no operation");
  });
}

test("ref: key derivation agrees with the corpus", () => {
  const cases = corpus()["keys"] as { name: string; ref?: string; expect: string | null }[];
  assert.ok(cases.length > 0);
  for (const c of cases) assert.equal(refKey(c.ref), c.expect, c.name);
});

test("ref: the provider lifecycle agrees with the corpus", () => {
  const cases = corpus()["lifecycle"] as { name: string; steps: Step[]; expect: (string | null)[] }[];
  assert.ok(cases.length > 0);
  for (const c of cases) assert.deepEqual(runSteps(c.steps), c.expect, c.name);
});

test("ref: the recycling rule agrees with the corpus", () => {
  const cases = corpus()["reuse"] as { name: string; steps: Step[]; expect: (string | number | null)[] }[];
  assert.ok(cases.length > 0);
  for (const c of cases) assert.deepEqual(runSteps(c.steps), c.expect, c.name);
});
