//
//  platform-conformance.test.ts - the platform-fold corpus runner (TS lane, full
//  target matrix). Executes OpenSource/Conformance/platform/platform.json `fold`
//  through the generic resolver for EVERY target each case pins, and asserts the
//  web compiler's own fold (foldPlatformAttrs) IS resolve(attrs, "web") — the
//  compile-time folding law (/web/14; desktop-platforms.md).
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift
//  starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  resolvePlatformAttrs, foldPlatformAttrs, PLATFORM_TARGETS, PLATFORM_GROUPS,
} from "../src/component.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/platform/platform.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/platform/platform.json not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

type FoldCase = {
  name: string;
  attrs: { [k: string]: string };
  expect: { [target: string]: { [k: string]: string } };
};
type Corpus = {
  targets: { exact: string[]; groups: { [g: string]: string[] }; precedence: string[] };
  fold: FoldCase[];
};

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as Corpus;

test("platform corpus: the vocabulary tables match the corpus", () => {
  assert.deepEqual([...PLATFORM_TARGETS], corpus.targets.exact);
  assert.deepEqual(
    Object.fromEntries(Object.entries(PLATFORM_GROUPS).map(([k, v]) => [k, [...v]])),
    corpus.targets.groups,
  );
});

test("platform corpus: fold matrix resolves per target", () => {
  assert.ok(corpus.fold.length > 0, "fold section must not be empty");
  for (const c of corpus.fold) {
    for (const [target, expected] of Object.entries(c.expect)) {
      assert.deepEqual(
        resolvePlatformAttrs(c.attrs, target), expected,
        `${c.name} — target ${target}`,
      );
    }
  }
});

test("platform corpus: the web compiler fold IS resolve(attrs, 'web')", () => {
  for (const c of corpus.fold) {
    if (c.expect["web"] === undefined) continue;
    assert.deepEqual(foldPlatformAttrs(c.attrs), c.expect["web"], `${c.name} — compiler fold`);
  }
});
