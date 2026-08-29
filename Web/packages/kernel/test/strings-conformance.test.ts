//
//  strings-conformance.test.ts — the localization kernel seam against the SHARED corpus
//  OpenSource/Conformance/strings/cases.json (architecture/localization.md). The Kotlin
//  twin runs the same file in :core (StringsConformanceTest); the Swift twin runs it on
//  the record lane. The seams are driven directly: state is the case's dot-keyed map,
//  the loader serves the case's bundle-table text, the device language is the case's.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DSXStrings } from "../src/strings.ts";

type Step = { state?: { [path: string]: unknown }; input: string; expect: string };
type Case = {
  name: string;
  device?: string;
  state?: { [path: string]: unknown };
  tables?: { [tag: string]: string };
  input?: string;
  expect?: string;
  steps?: Step[];
};

const corpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/strings/cases.json", import.meta.url),
  "utf8",
)) as { cases: Case[] };

test("the strings corpus is present and non-trivial", () => {
  assert.ok(corpus.cases.length >= 15, `expected the full case set, found ${corpus.cases.length}`);
});

for (const c of corpus.cases) {
  test(`strings corpus: ${c.name}`, () => {
    const state: { [path: string]: unknown } = { ...(c.state ?? {}) };
    const previous = { statePath: DSXStrings.statePath, loader: DSXStrings.loader, deviceLang: DSXStrings.deviceLang };
    DSXStrings.reset();
    DSXStrings.statePath = (path) => (path in state ? state[path] : null);
    DSXStrings.loader = (lang) => c.tables?.[lang] ?? null;
    DSXStrings.deviceLang = c.device ?? "en";
    try {
      const steps: Step[] = c.steps ?? [{ input: c.input!, expect: c.expect! }];
      for (const [index, step] of steps.entries()) {
        Object.assign(state, step.state ?? {});
        assert.equal(DSXStrings.localize(step.input), step.expect, `step ${index + 1}`);
      }
    } finally {
      DSXStrings.statePath = previous.statePath;
      DSXStrings.loader = previous.loader;
      DSXStrings.deviceLang = previous.deviceLang;
      DSXStrings.reset();
    }
  });
}
