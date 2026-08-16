//
//  root-plan.test.ts — normalizePlan against the SHARED router corpus
//  (OpenSource/Conformance/router/root-plan.json): every case's raw `surfaces`
//  must normalize to `expect.normalized` byte-for-byte. The fold half of the corpus
//  (attempts/failures/fired) is driven by router-conformance.test.ts once the boot
//  fold lands; this file pins the grammar half so all four normalizers
//  (TS · Ruby · Kotlin · Swift) agree.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { normalizePlan } from "../src/root-plan.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/router/root-plan.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("root-plan corpus not found");
    dir = parent;
  }
}

type Case = {
  name: string;
  surfaces: unknown;
  expect: { normalized: unknown };
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "root-plan corpus is empty");

for (const c of doc.cases) {
  test(`root-plan-normalize/${c.name}`, () => {
    assert.deepEqual(normalizePlan(c.surfaces), c.expect.normalized);
  });
}
