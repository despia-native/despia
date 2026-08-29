//
//  api-conformance.test.ts - the SHARED <api> corpus (OpenSource/Conformance/api/
//  api-blocks.json) through the TS block. The Kotlin (ApiConformanceTest.kt) and
//  Swift (ApiBlock.swift record host) twins run the SAME file — the /web/05 W5 gate:
//  fixtures first, every runtime codes toward them. The case executor lives in
//  api-corpus-engine.ts (platform-free) so the workerd leg (packages/server/test/workers/,
//  the W1 server-workers lane) runs the SAME engine on the SAME file — this shell only
//  reads the corpus from disk and turns a case's failure list into a node:test failure.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { runApiCorpusCase, type ApiCorpusCase } from "./api-corpus-engine.ts";

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

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: ApiCorpusCase[] };
assert.ok(doc.cases.length > 0, "api corpus is empty");

for (const c of doc.cases) {
  test(`api-corpus/${c.name}`, async () => {
    const failures = await runApiCorpusCase(c);
    assert.equal(failures.length, 0, failures.join("\n"));
  });
}
